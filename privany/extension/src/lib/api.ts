// One handle for both browsers. Firefox exposes `browser` (promise-based);
// Chrome MV3's `chrome` returns promises too, so the same calls work on both.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ext: typeof chrome = (globalThis as any).browser ?? (globalThis as any).chrome;

export const IS_FIREFOX = typeof (globalThis as any).browser !== "undefined" &&
  typeof navigator !== "undefined" && navigator.userAgent.includes("Firefox");

export type Msg =
  | { type: "page_info"; info: import("./types").PageInfo }
  | { type: "consent_click"; choice: "accepted" | "rejected" }
  | { type: "agreed"; how: "checkbox" | "submit" }
  | { type: "get_state"; tabId?: number }
  | { type: "run_gpc_test"; tabId: number }
  | { type: "reanalyze"; tabId: number }
  | { type: "settings_changed" }
  | { type: "open_report"; tabId?: number }
  | { type: "dismiss_site" };

export function send<T = unknown>(msg: Msg): Promise<T> {
  return ext.runtime.sendMessage(msg) as Promise<T>;
}
