// Fetching a Chromium snapshot from the public build archive.
//
// Snapshot positions are sparse - most numbers 404 - so `resolvePosition`
// walks forward from the requested one until it finds a build that exists.
//
// Platform note: the DevTools frontend is pure HTML/CSS/JS and is byte
// identical across Linux, macOS and Windows builds, so which platform's
// snapshot we download does not affect the output. Linux_x64 is the default
// because it is the only one with a build at exactly 303346 (Chrome 40's
// branch point) and it is the smallest of the three.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BASE = "https://commondatastorage.googleapis.com/chromium-browser-snapshots";

export const ZIP_NAME = {
  Linux_x64: "chrome-linux.zip",
  Linux: "chrome-linux.zip",
  Mac: "chrome-mac.zip",
  Win_x64: "chrome-win32.zip",
  Win: "chrome-win32.zip",
};

export async function resolvePosition(platform, position, span = 60) {
  for (let p = position; p < position + span; p++) {
    const res = await fetch(`${BASE}/${platform}/${p}/REVISIONS`, { method: "HEAD" });
    if (res.ok) return p;
  }
  throw new Error(
    `no ${platform} snapshot found in positions ${position}..${position + span - 1}`,
  );
}

export async function revisions(platform, position) {
  const res = await fetch(`${BASE}/${platform}/${position}/REVISIONS`);
  if (!res.ok) throw new Error(`REVISIONS fetch failed: HTTP ${res.status}`);
  return res.json();
}

export async function downloadZip(platform, position, cacheDir, onProgress) {
  const zipName = ZIP_NAME[platform];
  if (!zipName) throw new Error(`unknown platform "${platform}"`);

  mkdirSync(cacheDir, { recursive: true });
  const dest = join(cacheDir, `${platform}-${position}-${zipName}`);
  if (existsSync(dest)) {
    onProgress?.(`cached: ${dest}`);
    return readFileSync(dest);
  }

  const url = `${BASE}/${platform}/${position}/${zipName}`;
  onProgress?.(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);

  const total = Number(res.headers.get("content-length") || 0);
  const chunks = [];
  let seen = 0;
  let lastPct = -1;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    seen += chunk.length;
    if (total) {
      const pct = Math.floor((seen / total) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        onProgress?.(`  ${pct}% (${(seen / 1e6).toFixed(1)} MB)`);
      }
    }
  }
  const buf = Buffer.concat(chunks);
  writeFileSync(dest, buf);
  onProgress?.(`saved ${dest} (${(buf.length / 1e6).toFixed(1)} MB)`);
  return buf;
}
