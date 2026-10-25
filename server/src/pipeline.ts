import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { BrowserAudit, JobStatus, PolicyAnalysis, Report, StepKey, StepState } from "./report/types.js";
import { runBrowserAudit } from "./audit/run.js";
import { compare } from "./compare/rules.js";
import { JobTimeoutError, QueueFullError, withTimeout } from "./limits.js";
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

// Checks run CONCURRENCY at a time (default 1: parallel audits compete for
// bandwidth, which makes cookie counts less comparable). Raise it on a
// machine with the memory and bandwidth to spare, e.g. a shared deployment.
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.PRIVANY_CONCURRENCY ?? 1)));
let active = 0;
const waiting: (() => void)[] = [];
async function acquireSlot(): Promise<void> {
  if (active < CONCURRENCY) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}
function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next(); // hand the slot straight to the next job
  else active--;
}

// Limits are env-tunable so a shared deployment can be stricter than a laptop.
const MAX_PENDING_JOBS = Math.max(1, Number(process.env.PRIVANY_MAX_QUEUE ?? 5));
const JOB_TIMEOUT_MS = Math.max(30_000, Number(process.env.PRIVANY_JOB_TIMEOUT_MS ?? 5 * 60_000));
const JOB_KEEP_MS = 60 * 60_000;
const CACHE_TTL_MS = Math.max(0, Number(process.env.PRIVANY_CACHE_TTL_MS ?? 60 * 60_000));
const MAX_REPORTS = Math.max(10, Number(process.env.PRIVANY_MAX_REPORTS ?? 200));
const MAX_REPORT_AGE_MS = 30 * 24 * 60 * 60_000;

/** Recent reports by input fingerprint, so repeating a check doesn't repeat four browser visits. */
const recent = new Map<string, { reportId: string; at: number }>();

export function getJob(id: string): JobStatus | undefined {
  return jobs.get(id);
}

function pendingJobs(): number {
  let n = 0;
  for (const j of jobs.values()) if (j.state === "queued" || j.state === "running") n++;
  return n;
}

function fingerprint(site: URL, input: AnalyzeInput): string {
  const text = input.policyText ?? "";
  const page = input.page ? `${input.page.url}|${input.page.blocks.length}` : "";
  return createHash("sha256").update([site.origin, input.policyUrl ?? "", page, text].join("\n")).digest("hex");
}

function stepsFor(state: "pending" | "done" | "skipped"): JobStatus["steps"] {
  return (Object.keys(STEP_LABELS) as StepKey[]).map((key) => ({ key, label: STEP_LABELS[key], state }));
}

/**
 * Validates input synchronously enough to reject bad URLs before queueing.
 * Throws QueueFullError when too many checks are already waiting. `fresh`
 * skips the recent-report cache.
 */
export function startJob(input: AnalyzeInput, opts: { fresh?: boolean } = {}): JobStatus {
  const site = normalizeUrl(input.url);
  if (input.policyUrl) normalizeUrl(input.policyUrl);
  if (input.policyText && input.policyText.length > 400_000) throw new UnsafeUrlError("The pasted policy is too long (400,000 characters max).");
  if (input.page) normalizeUrl(input.page.url);

  const key = fingerprint(site, input);
  const hit = recent.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_TTL_MS && existsSync(path.join(REPORTS_DIR, `${hit.reportId}.json`))) {
    const cached: JobStatus = { id: randomUUID(), state: "done", steps: stepsFor("done"), reportId: hit.reportId, cached: true };
    jobs.set(cached.id, cached);
    expireJob(cached.id);
    return cached;
  }

  if (pendingJobs() >= MAX_PENDING_JOBS) throw new QueueFullError(60);
  const id = randomUUID();
  const job: JobStatus = { id, state: "queued", steps: stepsFor("pending") };
  jobs.set(id, job);
  // A job that outruns its time limit is
  // failed so it can't hold up everything queued behind it.
  void (async () => {
    await acquireSlot();
    try {
      await withTimeout(runJob(job, site, input), JOB_TIMEOUT_MS, "This check took too long and was stopped. The site may be slow or blocking automated visits.");
      if (job.state === "done" && job.reportId) recent.set(key, { reportId: job.reportId, at: Date.now() });
    } catch (err) {
      if (err instanceof JobTimeoutError) failJob(job, err.message);
    } finally {
      releaseSlot();
      expireJob(id);
    }
  })();
  return job;
}

function failJob(job: JobStatus, message: string) {
  job.state = "failed";
  job.error = message;
  for (const s of job.steps) if (s.state === "running" || s.state === "pending") s.state = s.state === "running" ? "failed" : "skipped";
}

/** Drops a finished job from memory after a while; reports stay on disk. */
function expireJob(id: string) {
  setTimeout(() => jobs.delete(id), JOB_KEEP_MS).unref();
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

    if ((job.state as JobStatus["state"]) === "failed") return; // timed out while we were working
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
  void pruneReports().catch(() => {});
}

/** Deletes reports past the age limit, then the oldest beyond MAX_REPORTS. Bundled sample reports are kept. */
export async function pruneReports(now = Date.now()): Promise<number> {
  const names = (await readdir(REPORTS_DIR).catch(() => [])).filter((f) => f.endsWith(".json") && !f.startsWith("sample-"));
  const files = (
    await Promise.all(names.map(async (name) => ({ name, mtime: (await stat(path.join(REPORTS_DIR, name)).catch(() => null))?.mtimeMs ?? 0 })))
  ).sort((a, b) => b.mtime - a.mtime);
  const doomed = files.filter((f, i) => i >= MAX_REPORTS || now - f.mtime > MAX_REPORT_AGE_MS);
  await Promise.all(doomed.map((f) => unlink(path.join(REPORTS_DIR, f.name)).catch(() => {})));
  return doomed.length;
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
  const names = (await readdir(REPORTS_DIR).catch(() => [])).filter((f) => f.endsWith(".json"));
  // Newest files first by mtime, so we parse 50 reports instead of all of them.
  const newest = (
    await Promise.all(names.map(async (name) => ({ name, mtime: (await stat(path.join(REPORTS_DIR, name)).catch(() => null))?.mtimeMs ?? 0 })))
  )
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 50);
  const out = [];
  for (const f of newest) {
    const r = await loadReport(f.name.slice(0, -5));
    if (r) out.push({ id: r.id, site: r.site, createdAt: r.createdAt, gaps: r.comparisons.filter((c) => c.verdict === "possible_gap").length });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
