export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8787";

/** What the background worker records for a tab; the side panel renders from it. */
export type TabState =
  | { phase: "reading"; site: string; at: number }
  | { phase: "running"; site: string; jobId: string; pageUrl: string; at: number }
  | { phase: "error"; site?: string; error: string; offline?: boolean; at: number };
