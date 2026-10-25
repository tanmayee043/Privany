import type { JobStatus, Report } from "../../server/src/report/types";

export type * from "../../server/src/report/types";

// The web app talks to the API through Vite's proxy; the extension sets an absolute base.
const BASE: string = import.meta.env.VITE_API_BASE ?? "";

export interface PageCapture {
  url: string;
  title?: string;
  blocks: { kind: "heading" | "text"; text: string }[];
  policyLinks: string[];
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  health: () => fetch(`${BASE}/api/health`).then((r) => json<{ ok: boolean; policyReader: "claude" | "rules" }>(r)),
  analyze: (input: { url: string; policyUrl?: string; policyText?: string; page?: PageCapture }) =>
    fetch(`${BASE}/api/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }).then((r) => json<JobStatus>(r)),
  job: (id: string) => fetch(`${BASE}/api/jobs/${id}`).then((r) => json<JobStatus>(r)),
  report: (id: string) => fetch(`${BASE}/api/reports/${id}`).then((r) => json<Report>(r)),
  reports: () => fetch(`${BASE}/api/reports`).then((r) => json<{ id: string; site: string; createdAt: string; gaps: number }[]>(r)),
};
