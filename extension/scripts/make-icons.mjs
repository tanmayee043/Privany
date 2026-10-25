// Renders the toolbar icons from the Privany mark (a facts-label glyph).
// Usage: node extension/scripts/make-icons.mjs
import puppeteer from "puppeteer";
import { fileURLToPath } from "node:url";

const out = (size) => fileURLToPath(new URL(`../public/icons/icon${size}.png`, import.meta.url));
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#111"/><rect x="7" y="7" width="18" height="3" fill="#fff"/><rect x="7" y="13" width="18" height="1.5" fill="#fff"/><rect x="7" y="17.5" width="12" height="1.5" fill="#fff"/><rect x="7" y="22" width="18" height="3" fill="#fff"/></svg>`;

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: out(size), omitBackground: true });
}
await browser.close();
console.log("icons written");
