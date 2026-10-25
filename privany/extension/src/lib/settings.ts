import { ext } from "./api";
import type { Preferences, Receipt, Settings } from "./types";

export const DEFAULT_PREFS: Preferences = {
  ad_tracking: 2,
  selling_sharing: 3,
  ai_training: 2,
  sensitive_fields: 2,
  legal_traps: 2,
  retention_deletion: 1,
};

export const DEFAULT_SETTINGS: Settings = {
  backendUrl: "http://localhost:8787",
  mode: "auto",
  sendGpc: false,
  autoGpcTest: true,
  gate: true,
  preferences: DEFAULT_PREFS,
  paused: [],
  onboarded: false,
};

export async function getSettings(): Promise<Settings> {
  const { settings } = (await ext.storage.local.get("settings")) as { settings?: Partial<Settings> };
  return { ...DEFAULT_SETTINGS, ...(settings || {}), preferences: { ...DEFAULT_PREFS, ...(settings?.preferences || {}) } };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await ext.storage.local.set({ settings: next });
  return next;
}

// ---- consent receipts (stay on this device) ----
export async function getReceipts(): Promise<Receipt[]> {
  const { receipts } = (await ext.storage.local.get("receipts")) as { receipts?: Receipt[] };
  return receipts || [];
}

export async function addReceipt(r: Receipt): Promise<void> {
  const all = await getReceipts();
  all.unshift(r);
  await ext.storage.local.set({ receipts: all.slice(0, 200) });
}

export async function latestReceipt(siteKey: string): Promise<Receipt | null> {
  return (await getReceipts()).find((r) => r.siteKey === siteKey) ?? null;
}

export async function deleteReceipt(id: string): Promise<void> {
  await ext.storage.local.set({ receipts: (await getReceipts()).filter((r) => r.id !== id) });
}

export async function clearEverything(): Promise<void> {
  const keep = await getSettings();
  await ext.storage.local.clear();
  await ext.storage.local.set({ settings: { ...keep } });
  try { await ext.storage.session.clear(); } catch { /* not everywhere */ }
}
