import type { JobStatus, Report } from "../../server/src/report/types";

export type * from "../../server/src/report/types";

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  health: () => fetch("/api/health").then((r) => json<{ ok: boolean; policyAnalysis: boolean }>(r)),
  analyze: (input: { url: string; policyUrl?: string; policyText?: string }) =>
    fetch("/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }).then((r) => json<JobStatus>(r)),
  job: (id: string) => fetch(`/api/jobs/${id}`).then((r) => json<JobStatus>(r)),
  report: (id: string) => fetch(`/api/reports/${id}`).then((r) => json<Report>(r)),
  reports: () => fetch("/api/reports").then((r) => json<{ id: string; site: string; createdAt: string; gaps: number }[]>(r)),
};
