import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type * as Esbuild from "esbuild";
import { checkPanelInvariants, HARD_MAX_BYTES, WARN_BYTES } from "./kit/guard.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const MAX_BUNDLE_BYTES = HARD_MAX_BYTES;
const WARN_BUNDLE_BYTES = WARN_BYTES;
const CSP = "default-src 'none';style-src 'unsafe-inline';script-src 'unsafe-inline'";

function tryLoadEsbuild(): typeof Esbuild | null {
  const candidates = [process.env.ESBUILD_PATH, "esbuild"].filter(
    (x): x is string => Boolean(x)
  );
  for (const mod of candidates) {
    try {
      return require(mod) as typeof Esbuild;
    } catch {}
  }
  return null;
}

function tryCliBundle(
  entryTs: string,
  bridgeTs: string
): { code: string; bundler: string } | null {
  let tmpDir = "";
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-pack-"));
    fs.mkdirSync(path.join(tmpDir, "kit"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "kit", "bridge.ts"), fs.readFileSync(bridgeTs, "utf8"), "utf8");
    const tmpEntry = path.join(tmpDir, "view.ts");
    fs.writeFileSync(tmpEntry, fs.readFileSync(entryTs, "utf8"), "utf8");

    for (const esbBin of ["esbuild", "/opt/homebrew/bin/esbuild", "/usr/local/bin/esbuild"]) {
      try {
        const out = execFileSync(
          esbBin,
          [
            tmpEntry,
            "--bundle",
            "--minify",
            "--tree-shaking=true",
            "--charset=utf8",
            "--legal-comments=none",
            "--format=iife",
            "--platform=browser",
            "--target=es2022",
          ],
          { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }
        );
        if (out.trim()) return { code: out.trim(), bundler: "esbuild-cli" };
      } catch {}
    }

    const bunBins = [
      "bun",
      "/opt/homebrew/bin/bun",
      path.join(os.homedir(), ".bun", "bin", "bun"),
    ];
    for (const bunBin of bunBins) {
      try {
        const out = execFileSync(
          bunBin,
          ["build", tmpEntry, "--bundle", "--minify", "--format=iife", "--target=browser"],
          { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }
        );
        if (out.trim()) return { code: out.trim(), bundler: "bun" };
      } catch {}
    }
    return null;
  } catch {
    return null;
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

function minifyCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--buncss-[^;:}]*:[^;}]*;?/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,>+~])\s*/g, "$1")
    .replace(/([:, ])0\.(\d)/g, "$1.$2")
    .replace(/;}/g, "}")
    .trim();
}

async function main(): Promise<void> {
  const entryTs = path.join(__dirname, "view.ts");
  const bridgeTs = path.join(__dirname, "kit", "bridge.ts");
  const tokensCssPath = path.join(__dirname, "kit", "tokens.css");
  const cssPath = path.join(__dirname, "theme.css");
  const distDir = path.join(__dirname, "dist");
  const outHtml = path.join(distDir, "panel.html");

  const rawCss = `${fs.readFileSync(tokensCssPath, "utf8")}\n${fs.readFileSync(cssPath, "utf8")}`;
  const esbuild = tryLoadEsbuild();

  let jsCode: string;
  let bundler: string;

  if (esbuild) {
    bundler = "esbuild";
    const res = await esbuild.build({
      entryPoints: [entryTs],
      bundle: true,
      minify: true,
      treeShaking: true,
      charset: "utf8",
      legalComments: "none",
      format: "iife",
      platform: "browser",
      target: ["es2022"],
      write: false,
    });
    jsCode = res.outputFiles[0].text.trim().replace(/<\/script/gi, "<\\/script");
  } else {
    const cliOut = tryCliBundle(entryTs, bridgeTs);
    if (!cliOut) {
      throw new Error("esbuild not found; run `npm --prefix panel install --ignore-scripts`");
    }
    bundler = cliOut.bundler;
    jsCode = cliOut.code.replace(/<\/script/gi, "<\\/script");
  }

  const cssCode = minifyCss(rawCss).replace(/<\/style/gi, "<\\/style");
  const html = `<!doctype html><html lang="en" style="background:#0B0D12;color-scheme:dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="color-scheme" content="dark"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Context Radar</title><style>${cssCode}</style></head><body style="background:#0B0D12"><div id="app"><div class="boot-frame"><div class="boot-bar"><span class="boot-dot"></span>Context Radar</div></div></div><script type="module">/*__CONTEXT_RADAR_BOOT__*/${jsCode}</script></body></html>`;

  // Validate syntax, Lucid Indigo SSOT invariants, and hard size cap BEFORE touching dist/panel.html
  new vm.Script(jsCode);
  const report = checkPanelInvariants(html, {
    maxBytes: MAX_BUNDLE_BYTES,
    warnBytes: WARN_BUNDLE_BYTES,
    bootPlaceholder: "/*__CONTEXT_RADAR_BOOT__*/",
  });
  if (!report.ok) {
    throw new Error(`Panel guard failed (dist unchanged):\n- ${report.errors.join("\n- ")}`);
  }
  const jsBytes = Buffer.byteLength(jsCode, "utf8");
  const cssBytes = Buffer.byteLength(cssCode, "utf8");
  const totalBytes = Buffer.byteLength(html, "utf8");
  const totalKb = (totalBytes / 1024).toFixed(1);
  if (totalBytes > MAX_BUNDLE_BYTES) {
    throw new Error(
      `Panel bundle ${totalBytes} B exceeds ${MAX_BUNDLE_BYTES} B limit (JS ${jsBytes} B + CSS ${cssBytes} B, bundler=${bundler}); dist unchanged`
    );
  }
  fs.mkdirSync(distDir, { recursive: true });
  const tmpHtml = path.join(distDir, `.panel-${process.pid}.tmp`);
  fs.writeFileSync(tmpHtml, html, "utf8");
  fs.renameSync(tmpHtml, outHtml);
  console.log(
    `Packed ${outHtml} (${totalKb} KiB / ${totalBytes} B total: JS ${jsBytes} B + CSS ${cssBytes} B, bundler=${bundler})`
  );
  if (totalBytes > WARN_BUNDLE_BYTES) {
    console.warn(
      `WARNING: Panel bundle ${totalBytes} B exceeds ${WARN_BUNDLE_BYTES} B warning threshold`
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
