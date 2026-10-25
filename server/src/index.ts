import { fileURLToPath } from "node:url";
import express from "express";
import { closeBrowser } from "./audit/browser.js";
import { hasApiKey } from "./policy/analyze.js";
import { getJob, listReports, loadReport, startJob } from "./pipeline.js";
import { UnsafeUrlError } from "./safety/url.js";

// Settings live in the repo-root .env (see .env.example); it's optional.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // No .env: rely on the real environment.
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, policyAnalysis: hasApiKey() });
});

app.post("/api/analyze", (req, res) => {
  const { url, policyUrl, policyText } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof url !== "string") {
    res.status(400).json({ error: "Enter a website address." });
    return;
  }
  try {
    const job = startJob({
      url,
      policyUrl: typeof policyUrl === "string" && policyUrl.trim() ? policyUrl : undefined,
      policyText: typeof policyText === "string" && policyText.trim() ? policyText : undefined,
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

const port = Number(process.env.PORT ?? 8787);
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`Privany API on http://127.0.0.1:${port} (policy analysis ${hasApiKey() ? "on" : "off: set ANTHROPIC_API_KEY"})`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    void closeBrowser().finally(() => process.exit(0));
  });
}
