import { fileURLToPath } from "node:url";
import express from "express";
import { closeBrowser } from "./audit/browser.js";
import { getJob, listReports, loadReport, policyReader, startJob, type AnalyzeInput } from "./pipeline.js";
import type { RawBlock } from "./policy/extract.js";
import { UnsafeUrlError } from "./safety/url.js";

// Settings live in the repo-root .env (see .env.example); it's optional.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // No .env: rely on the real environment.
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "4mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, policyReader: policyReader() });
});

app.post("/api/analyze", (req, res) => {
  const { url, policyUrl, policyText, page } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof url !== "string") {
    res.status(400).json({ error: "Enter a website address." });
    return;
  }
  const parsedPage = page === undefined ? undefined : parsePage(page);
  if (parsedPage === null) {
    res.status(400).json({ error: "The page text sent by the extension wasn't in the expected format." });
    return;
  }
  try {
    const job = startJob({
      url,
      policyUrl: typeof policyUrl === "string" && policyUrl.trim() ? policyUrl : undefined,
      policyText: typeof policyText === "string" && policyText.trim() ? policyText : undefined,
      page: parsedPage,
    });
    res.status(202).json(job);
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

app.get("/api/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "That check isn't running any more. Start a new one." });
    return;
  }
  res.json(job);
});

app.get("/api/reports", async (_req, res) => {
  res.json(await listReports());
});

app.get("/api/reports/:id", async (req, res) => {
  const report = await loadReport(req.params.id);
  if (!report) {
    res.status(404).json({ error: "Report not found." });
    return;
  }
  res.json(report);
});

/** Checks the shape and size of page text from the extension; null when it's malformed. */
function parsePage(value: unknown): AnalyzeInput["page"] | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  if (typeof p.url !== "string" || !Array.isArray(p.blocks) || p.blocks.length > 8000) return null;
  let chars = 0;
  const blocks: RawBlock[] = [];
  for (const b of p.blocks) {
    const kind = (b as Record<string, unknown>)?.kind;
    const text = (b as Record<string, unknown>)?.text;
    if ((kind !== "heading" && kind !== "text") || typeof text !== "string") return null;
    chars += text.length;
    if (chars > 600_000) return null;
    blocks.push({ kind, text: text.slice(0, 20_000) });
  }
  const links = Array.isArray(p.policyLinks) ? p.policyLinks.filter((l): l is string => typeof l === "string").slice(0, 10) : [];
  return { url: p.url, title: typeof p.title === "string" ? p.title.slice(0, 300) : undefined, blocks, policyLinks: links };
}

const port = Number(process.env.PORT ?? 8787);
// Express 5 calls this with an error when listening fails (for example, the port is taken).
const server = app.listen(port, "127.0.0.1", (err?: Error) => {
  if (err) {
    const busy = (err as NodeJS.ErrnoException).code === "EADDRINUSE";
    console.error(busy ? `Port ${port} is already in use; another Privany server may be running. Stop it, then start this one again.` : `Couldn't start the API: ${err.message}`);
    process.exit(1);
  }
  console.log(`Privany API on http://127.0.0.1:${port} (policy reader: ${policyReader() === "claude" ? "Claude" : "free rule-based"})`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    void closeBrowser().finally(() => process.exit(0));
  });
}
