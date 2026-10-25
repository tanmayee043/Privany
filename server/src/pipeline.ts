import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { BrowserAudit, JobStatus, PolicyAnalysis, Report, StepKey, StepState } from "./report/types.js";
import { runBrowserAudit } from "./audit/run.js";
import { compare } from "./compare/rules.js";
import { analyzePolicy, hasApiKey, PolicyAnalysisError } from "./policy/analyze.js";
import { fetchPolicy, looksLikePolicy, PolicyFetchError, policyFromText, tryPolicyFromBlocks, type ExtractedPolicy, type RawBlock } from "./policy/extract.js";
import { readPolicyWithRules } from "./policy/rules.js";
import { assertPublicUrl, normalizeUrl, UnsafeUrlError } from "./safety/url.js";

export const REPORTS_DIR = fileURLToPath(new URL("../data/reports/", import.meta.url));

export interface AnalyzeInput {
  url: string;
  policyUrl?: string;
  policyText?: string;
  /** The open page's text, read by the browser extension from the user's tab. */
  page?: { url: string; title?: string; blocks: RawBlock[]; policyLinks: string[] };
}

const STEP_LABELS: Record<StepKey, string> = {
  validate: "Checking the address",
  audit: "Visiting the site with and without GPC",
  policy_fetch: "Finding and reading the privacy policy",
  policy_analyze: "Pulling out the policy's promises, with quotes",
  compare: "Comparing promises with what we saw",
};

// The free rule-based reader is the default. Claude is used only when asked
// for explicitly, so nobody runs up API charges by accident.
export function policyReader(): "claude" | "rules" {
  return process.env.PRIVANY_POLICY_READER === "claude" && hasApiKey() ? "claude" : "rules";
}

const LIMITATIONS = [
  "Privany compares what a policy says with what a browser can observe. It doesn't prove what a company does with data on its servers, and it isn't legal advice.",
  "The browser test loads only the homepage, without logging in, scrolling or clicking, from the server's location.",
  "Cookie purposes come from the Open Cookie Database; cookies it doesn't list are shown as unidentified rather than guessed.",
];

const jobs = new Map<string, JobStatus>();
let queue: Promise<unknown> = Promise.resolve();

export function getJob(id: string): JobStatus | undefined {
  return jobs.get(id);
}

/** Validates input synchronously enough to reject bad URLs before queueing. */
export function startJob(input: AnalyzeInput): JobStatus {
  const site = normalizeUrl(input.url);
  if (input.policyUrl) normalizeUrl(input.policyUrl);
  if (input.policyText && input.policyText.length > 400_000) throw new UnsafeUrlError("The pasted policy is too long (400,000 characters max).");
  if (input.page) normalizeUrl(input.page.url);
  const id = randomUUID();
  const job: JobStatus = {
    id,
    state: "queued",
    steps: (Object.keys(STEP_LABELS) as StepKey[]).map((key) => ({ key, label: STEP_LABELS[key], state: "pending" })),
  };
  jobs.set(id, job);
  // One analysis at a time: parallel audits would compete for bandwidth and
  // make cookie counts less comparable.
  queue = queue.then(() => runJob(job, site, input)).catch(() => {});
  return job;
}

function setStep(job: JobStatus, key: StepKey, state: StepState, detail?: string) {
  const step = job.steps.find((s) => s.key === key)!;
  step.state = state;
  step.detail = detail;
}

async function runJob(job: JobStatus, site: URL, input: AnalyzeInput): Promise<void> {
  job.state = "running";
  const timings: Record<string, number> = {};
  const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      timings[label] = Date.now() - t;
    }
  };
  const report: Report = {
    id: job.id,
    createdAt: new Date().toISOString(),
    input: { url: site.toString(), policyUrl: input.policyUrl ?? input.page?.url, pastedPolicy: Boolean(input.policyText) },
    site: site.hostname,
    comparisons: [],
    limitations: LIMITATIONS,
    timings,
  };
  try {
    setStep(job, "validate", "running");
    await assertPublicUrl(site);
    setStep(job, "validate", "done");

    // The policy can be found from the first homepage visit, so policy work
    // starts while the remaining visits run.
    let resolveLinks!: (links: BrowserAudit["homepageLinks"]) => void;
    const links = new Promise<BrowserAudit["homepageLinks"]>((r) => (resolveLinks = r));

    setStep(job, "audit", "running");
    const auditTask = time("audit", () =>
      runBrowserAudit(site, { onProgress: (d) => setStep(job, "audit", "running", d), onDiscovery: resolveLinks }),
    ).then(
      (audit) => {
        resolveLinks(audit.homepageLinks);
        const failed = audit.runs.filter((r) => !r.ok);
        setStep(job, "audit", failed.length === audit.runs.length ? "failed" : "done", failed.length ? `${failed.length} of ${audit.runs.length} visits failed: ${failed[0].error}` : `${audit.runs.length} visits`);
        if (failed.length === audit.runs.length) report.auditError = failed[0].error;
        return audit;
      },
      (err) => {
        resolveLinks({ privacyPolicy: [], optOut: [] });
        report.auditError = err instanceof Error ? err.message : String(err);
        setStep(job, "audit", "failed", report.auditError);
        return undefined;
      },
    );

    const policyTask = (async (): Promise<PolicyAnalysis | undefined> => {
      setStep(job, "policy_fetch", "running");
      let extracted: ExtractedPolicy;
      try {
        extracted = await time("policy_fetch", async () => {
          if (input.policyText) return policyFromText(input.policyText);
          if (input.page) {
            // The extension sent the page the user is reading. Use it when it is the
            // policy; otherwise follow the policy links found on that page.
            const fromPage = tryPolicyFromBlocks(input.page.blocks, { url: input.page.url, title: input.page.title });
            if (fromPage && looksLikePolicy(fromPage)) {
              setStep(job, "policy_fetch", "running", "Using the policy open in your tab");
              return fromPage;
            }
            setStep(job, "policy_fetch", "running", "This page isn't the policy; following its privacy link");
            const homeLinks = (await links).privacyPolicy;
            return findPolicy(site, [...input.page.policyLinks.filter(isHttpUrl), ...homeLinks], (d) => setStep(job, "policy_fetch", "running", d));
          }
          if (input.policyUrl) {
            const u = normalizeUrl(input.policyUrl);
            await assertPublicUrl(u);
            return fetchPolicy(u);
          }
          setStep(job, "policy_fetch", "running", "Looking for the policy link on the homepage");
          return findPolicy(site, (await links).privacyPolicy, (d) => setStep(job, "policy_fetch", "running", d));
        });
      } catch (err) {
        report.policyError = err instanceof PolicyFetchError || err instanceof UnsafeUrlError ? err.message : `The policy couldn't be read (${err instanceof Error ? err.message : err}).`;
        setStep(job, "policy_fetch", "failed", report.policyError);
        setStep(job, "policy_analyze", "skipped");
        return undefined;
      }
      setStep(job, "policy_fetch", "done", `${extracted.blocks.length} sections${extracted.url ? ` from ${new URL(extracted.url).pathname}` : ""}`);

      setStep(job, "policy_analyze", "running");
      try {
        const pasted = Boolean(input.policyText);
        const analysis = await time("policy_analyze", async () =>
          policyReader() === "claude" ? analyzePolicy(extracted, { site: site.hostname, pasted }) : readPolicyWithRules(extracted, { pasted }),
        );
        setStep(job, "policy_analyze", "done", `${analysis.evidence.verified} of ${analysis.evidence.proposed} quotes found word for word in the policy`);
        return analysis;
      } catch (err) {
        report.policyError = err instanceof PolicyAnalysisError ? err.message : `The analysis failed (${err instanceof Error ? err.message : err}).`;
        setStep(job, "policy_analyze", "failed", report.policyError);
        return undefined;
      }
    })();

    const [audit, policy] = await Promise.all([auditTask, policyTask]);
    report.audit = audit;
    report.policy = policy;
    if (policy && !policy.isPrivacyPolicy) report.policyError = "The document we read doesn't look like a privacy policy, so these findings may not mean much. Try giving the policy link directly.";

    setStep(job, "compare", "running");
    report.comparisons = compare(policy, audit);
    setStep(job, "compare", policy ? "done" : "skipped");

    await saveReport(report);
    job.reportId = report.id;
    job.state = "done";
  } catch (err) {
    job.state = "failed";
    job.error = err instanceof UnsafeUrlError ? err.message : `Something went wrong: ${err instanceof Error ? err.message : err}`;
    for (const s of job.steps) if (s.state === "running" || s.state === "pending") s.state = s.state === "running" ? "failed" : "skipped";
  }
}

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

async function findPolicy(site: URL, candidates: string[], onProgress: (d: string) => void): Promise<ExtractedPolicy> {
  const guesses = ["/privacy", "/privacy-policy", "/legal/privacy"].map((p) => new URL(p, site.origin).toString());
  const tried = new Set<string>();
  let lastError: unknown;
  for (const href of [...candidates.slice(0, 3), ...guesses]) {
    if (tried.has(href)) continue;
    tried.add(href);
    try {
      const u = new URL(href);
      await assertPublicUrl(u);
      onProgress(`Reading ${u.hostname}${u.pathname}`);
      return await fetchPolicy(u);
    } catch (err) {
      lastError = err;
    }
  }
  throw new PolicyFetchError(
    candidates.length
      ? `We found a privacy link but couldn't read it${lastError instanceof Error ? ` (${lastError.message})` : ""}. Paste the policy link or text instead.`
      : "We couldn't find a privacy policy link on the homepage. Paste the policy link or text instead.",
  );
}

async function saveReport(report: Report): Promise<void> {
  await mkdir(REPORTS_DIR, { recursive: true });
  await writeFile(path.join(REPORTS_DIR, `${report.id}.json`), JSON.stringify(report));
}

const ID_RE = /^[0-9a-f-]{36}$|^sample-[a-z0-9-]+$/;

export async function loadReport(id: string): Promise<Report | undefined> {
  if (!ID_RE.test(id)) return undefined;
  try {
    return JSON.parse(await readFile(path.join(REPORTS_DIR, `${id}.json`), "utf8")) as Report;
  } catch {
    return undefined;
  }
}

export async function listReports(): Promise<{ id: string; site: string; createdAt: string; gaps: number }[]> {
  const files = (await readdir(REPORTS_DIR).catch(() => [])).filter((f) => f.endsWith(".json"));
  const out = [];
  for (const f of files) {
    const r = await loadReport(f.slice(0, -5));
    if (r) out.push({ id: r.id, site: r.site, createdAt: r.createdAt, gaps: r.comparisons.filter((c) => c.verdict === "possible_gap").length });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
}
