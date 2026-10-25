// Builds the extension for Chrome and/or Firefox.
//   node scripts/build.mjs            -> dist/chrome and dist/firefox
//   node scripts/build.mjs chrome     -> just one
import { build as esbuild } from "esbuild";
import { build as vite } from "vite";
import react from "@vitejs/plugin-react";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
const targets = process.argv[2] ? [process.argv[2]] : ["chrome", "firefox"];

function manifest(target) {
  const icons = { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png", 128: "icons/icon128.png" };
  const m = {
    manifest_version: 3,
    name: "Privany",
    version: pkg.version,
    description: "Reads a site's privacy policy and terms, then checks whether the site actually does what they say.",
    icons,
    action: { default_popup: "popup.html", default_icon: icons, default_title: "Privany" },
    options_ui: { page: "options.html", open_in_tab: true },
    permissions: ["storage", "cookies", "webRequest", "declarativeNetRequest", "scripting"],
    host_permissions: ["<all_urls>"],
    content_scripts: [{ matches: ["http://*/*", "https://*/*"], js: ["content.js"], run_at: "document_idle" }],
  };
  if (target === "firefox") {
    m.background = { scripts: ["background.js"] };
    m.browser_specific_settings = {
      gecko: {
        id: "privany@hackathon.local",
        strict_min_version: "128.0",
        // what leaves the browser: site addresses + policy links (browsing activity),
        // names of cookies/trackers seen on that site (website activity). Never content you type.
        data_collection_permissions: { required: ["browsingActivity", "websiteActivity"] },
      },
    };
  } else {
    m.background = { service_worker: "background.js" };
    m.minimum_chrome_version = "111";
  }
  return m;
}

async function contentCss() {
  const config = { ...require(path.join(ROOT, "tailwind.config.cjs")), corePlugins: { preflight: false } };
  const src = await readFile(path.join(ROOT, "src/content/content.css"), "utf8");
  const out = await postcss([tailwindcss(config), autoprefixer]).process(src, { from: path.join(ROOT, "src/content/content.css") });
  // shadow roots have no <html>; Tailwind's variable defaults also need to apply at :host
  return out.css.replace(/(\*, ::before, ::after|::backdrop)\s*{/g, ":host, $1 {");
}

const inlineCss = (css) => ({
  name: "content-css",
  setup(b) {
    b.onResolve({ filter: /^virtual:content-css$/ }, () => ({ path: "content-css", namespace: "privany" }));
    b.onLoad({ filter: /.*/, namespace: "privany" }, () => ({ contents: `export default ${JSON.stringify(css)};`, loader: "js" }));
  },
});

for (const target of targets) {
  const out = path.join(ROOT, "dist", target);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  // extension pages (popup, settings): ES modules are fine here
  await vite({
    configFile: false,
    root: path.join(ROOT, "src/pages"),
    base: "./",
    logLevel: "warn",
    plugins: [react()],
    css: { postcss: path.join(ROOT) },
    build: {
      outDir: out,
      emptyOutDir: false,
      target: target === "firefox" ? "firefox128" : "chrome111",
      rollupOptions: { input: { popup: path.join(ROOT, "src/pages/popup.html"), options: path.join(ROOT, "src/pages/options.html") } },
    },
  });

  // scripts: one self-contained file each (content scripts can't import chunks)
  const css = await contentCss();
  const common = {
    bundle: true, format: "iife", minify: true, legalComments: "none", logLevel: "warning",
    target: target === "firefox" ? "firefox128" : "chrome111",
    define: { "process.env.NODE_ENV": '"production"', "globalThis.__PRIVANY_DEBUG__": process.env.PRIVANY_DEBUG ? "true" : "false" }, jsx: "automatic",
  };
  await esbuild({ ...common, entryPoints: [path.join(ROOT, "src/background/index.ts")], outfile: path.join(out, "background.js") });
  await esbuild({ ...common, entryPoints: [path.join(ROOT, "src/content/index.tsx")], outfile: path.join(out, "content.js"), plugins: [inlineCss(css)] });
  await esbuild({ ...common, entryPoints: [path.join(ROOT, "src/gpc/main-world.ts")], outfile: path.join(out, "gpc-main.js") });

  await cp(path.join(ROOT, "public"), out, { recursive: true });
  await writeFile(path.join(out, "manifest.json"), JSON.stringify(manifest(target), null, 2));
  console.log(`built ${target} -> dist/${target}`);
}
