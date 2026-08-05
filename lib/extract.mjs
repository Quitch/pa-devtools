// Recover the DevTools frontend from a Chromium resources.pak.
//
// The hard part is not unpacking the container - it is that a .pak has no
// filenames, only uint16 resource ids. Names come from one of two oracles:
//
//   "loose"    Chromium *snapshot* builds also ship the same frontend as loose
//              named files under chrome-linux/resources/inspector/. Hashing
//              those against the pak blobs gives an exact, assumption-free
//              id -> name map. Used to *learn* a manifest.
//
//   "manifest" Official Chrome/Chromium *releases* ship only resources.pak,
//              with no loose copy. For those, a manifest learned from a
//              matching snapshot supplies the names.
//
// Either way the result is checked by resolveReferences(): every relative path
// mentioned by the extracted HTML/CSS/JS must exist in the output. That is the
// gate that catches a misaligned block, not the naming step itself.

import { createHash } from "node:crypto";

export const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// devtools.html is the frontend entry point and carries a distinctive body id.
// Anchoring on content rather than on a hardcoded id means a build with a
// shifted id range still lands correctly.
const ANCHOR = '-blink-dev-tools';

export function findAnchorId(entries) {
  for (const e of entries) {
    if (e.bytes.length > 4096) continue;
    if (e.bytes.includes(ANCHOR)) return e.id;
  }
  return null;
}

// Build id -> name by hashing the loose named tree against the pak.
// Two passes: unique hash matches establish the id block, then ambiguous
// matches (blobs whose bytes appear more than once in the pak, e.g. an icon
// shared with Chrome's own theme resources) are resolved in favour of the id
// that falls inside that block.
export function learnManifest(entries, looseFiles) {
  const byHash = new Map();
  for (const e of entries) {
    const h = sha256(e.bytes);
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(e.id);
  }

  const resolved = [];
  const ambiguous = [];
  const unpacked = [];

  for (const { name, bytes } of looseFiles) {
    const ids = byHash.get(sha256(bytes));
    if (!ids) unpacked.push(name);
    else if (ids.length === 1) resolved.push({ id: ids[0], name });
    else ambiguous.push({ ids, name });
  }

  if (resolved.length === 0) {
    throw new Error("no loose file matched any pak blob - wrong pak/snapshot pairing?");
  }

  const lo = Math.min(...resolved.map((r) => r.id));
  const hi = Math.max(...resolved.map((r) => r.id));
  // Ambiguous entries widen the block, so allow a little slack on both sides.
  const inBlock = (id) => id >= lo - 8 && id <= hi + 128;

  for (const { ids, name } of ambiguous) {
    const pick = ids.filter(inBlock);
    resolved.push({ id: pick.length ? Math.min(...pick) : Math.min(...ids), name });
  }

  resolved.sort((a, b) => a.id - b.id);
  const map = {};
  for (const r of resolved) map[r.id] = r.name;
  return { map, unpacked, anchorId: findAnchorId(entries) };
}

// Turn a manifest plus a pak into named files. `anchorId` lets a manifest
// learned at one id offset apply to a build where the block sits elsewhere.
export function applyManifest(entries, manifest) {
  const shift =
    manifest.anchorId != null && manifest.currentAnchorId != null
      ? manifest.currentAnchorId - manifest.anchorId
      : 0;

  const byId = new Map(entries.map((e) => [e.id, e.bytes]));
  const files = [];
  const missing = [];
  for (const [idStr, name] of Object.entries(manifest.map)) {
    const id = Number(idStr) + shift;
    const bytes = byId.get(id);
    if (bytes) files.push({ name, bytes, id });
    else missing.push({ id, name });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { files, missing, shift };
}

// Collect every relative path the frontend refers to, so extraction can be
// verified rather than assumed correct.
export function collectReferences(files) {
  const refs = new Set();
  const add = (r) => {
    if (!r) return;
    const clean = r.split("?")[0].split("#")[0].trim();
    if (!clean) return;
    if (/^(https?:|data:|blob:|javascript:|\/\/|#)/i.test(clean)) return;
    if (clean.startsWith("/")) return;
    refs.add(clean);
  };

  for (const f of files) {
    if (!/\.(html|css|js)$/i.test(f.name)) continue;
    const text = f.bytes.toString("utf8");

    if (/\.html$/i.test(f.name)) {
      for (const m of text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
    }
    if (/\.css$/i.test(f.name)) {
      // Quoted and unquoted forms are separate, non-nullable branches. A
      // single class spanning both would let the path and the trailing \s*
      // compete for the same whitespace, which is what makes it super-linear.
      const url = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^"')\s]+))\s*\)/gi;
      for (const m of text.matchAll(url)) add(m[1] ?? m[2] ?? m[3]);
    }
    // Images are addressed as bare "Images/foo.png" strings from both the CSS
    // and the JS bundles, and module bundles are fetched by "<name>_module.js".
    for (const m of text.matchAll(/Images\/[A-Za-z0-9_.-]+\.(?:png|svg|gif)/g)) add(m[0]);
    for (const m of text.matchAll(/["'](\w+_module\.js)["']/g)) add(m[1]);
  }
  return refs;
}

export function verify(files) {
  const have = new Set(files.map((f) => f.name));
  const refs = collectReferences(files);
  const dangling = [...refs].filter((r) => !have.has(r));
  dangling.sort((a, b) => a.localeCompare(b));
  return { referenced: refs.size, dangling };
}
