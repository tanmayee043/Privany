/// <reference types="chrome" />

// User choices for automatic checking. The on/off switch syncs with the user's
// Chrome profile; the list of sites they've silenced stays on this device.

const AUTO_KEY = "privany.auto.v1";
const MUTED_KEY = "privany.muted.v1";

export async function autoCheckEnabled(): Promise<boolean> {
  const r = await chrome.storage.sync.get(AUTO_KEY).catch(() => ({}) as Record<string, unknown>);
  const v = (r as Record<string, { enabled?: boolean } | undefined>)[AUTO_KEY];
  return v?.enabled ?? true;
}

export async function setAutoCheck(enabled: boolean): Promise<void> {
  await chrome.storage.sync.set({ [AUTO_KEY]: { enabled } });
}

export async function mutedSites(): Promise<string[]> {
  const r = await chrome.storage.local.get(MUTED_KEY).catch(() => ({}) as Record<string, unknown>);
  return ((r as Record<string, string[] | undefined>)[MUTED_KEY] ?? []).slice();
}

export async function muteSite(site: string): Promise<void> {
  const list = await mutedSites();
  if (!list.includes(site)) await chrome.storage.local.set({ [MUTED_KEY]: [...list, site].slice(-500) });
}

export async function unmuteSite(site: string): Promise<void> {
  await chrome.storage.local.set({ [MUTED_KEY]: (await mutedSites()).filter((s) => s !== site) });
}
