#!/usr/bin/env node
// pa-devtools - build and serve a Chrome-40-era DevTools frontend for
// debugging Planetary Annihilation's embedded Coherent UI renderer.
//
//   node pa-devtools.mjs build        download a snapshot, extract, verify
//   node pa-devtools.mjs extract      extract from a resources.pak you supply
//   node pa-devtools.mjs serve        serve the frontend, list PA's targets
//   node pa-devtools.mjs doctor       check whether PA's debug port is up
//
// Runs on Windows, Linux and macOS with no dependencies beyond Node itself.

import { createServer } from "node:http";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, dirname, resolve, extname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePak } from "./lib/pak.mjs";
import { readZipIndex, readZipEntry } from "./lib/zip.mjs";
import { learnManifest, applyManifest, findAnchorId, verify } from "./lib/extract.mjs";
import { downloadZip, resolvePosition, revisions } from "./lib/snapshot.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_POSITION = 303346; // Chrome 40.0.2214 branch base
const DEFAULT_PLATFORM = "Linux_x64";
const DEFAULT_PA_PORT = 9999;
const DEFAULT_SERVE_PORT = 8099;

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      out[k] = v ?? (argv[i + 1]?.startsWith("--") ? true : (argv[++i] ?? true));
    } else out._.push(a);
  }
  return out;
}

function writeTree(outDir, files) {
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  for (const f of files) {
    const p = join(outDir, f.name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.bytes);
  }
}

function report(files, outDir) {
  const { referenced, dangling } = verify(files);
  const bytes = files.reduce((n, f) => n + f.bytes.length, 0);
  console.log(`\nextracted ${files.length} files (${(bytes / 1e6).toFixed(2)} MB) -> ${outDir}`);
  console.log(`reference check: ${referenced} relative paths referenced`);
  if (dangling.length) {
    console.log(`  FAILED - ${dangling.length} dangling:`);
    for (const d of dangling.slice(0, 25)) console.log(`    ${d}`);
    return false;
  }
  console.log("  OK - every referenced path resolves inside the output");
  return true;
}

// --- build: snapshot -> verified frontend -------------------------------

async function cmdBuild(o) {
  const platform = o.platform || DEFAULT_PLATFORM;
  const wanted = Number(o.position || DEFAULT_POSITION);
  const outDir = resolve(o.out || join(HERE, "front_end"));
  const cacheDir = resolve(o.cache || join(HERE, ".cache"));

  console.log(`resolving ${platform} snapshot at/after position ${wanted}...`);
  const position = await resolvePosition(platform, wanted);
  const rev = await revisions(platform, position);
  console.log(
    `using position ${position} (chromium r${rev.chromium_revision}, blink r${rev.webkit_revision})`,
  );

  const zipBuf = await downloadZip(platform, position, cacheDir, (m) => console.log(m));
  const index = readZipIndex(zipBuf);

  const pakName = [...index.keys()].find((n) => n.endsWith("/resources.pak"));
  if (!pakName) throw new Error("snapshot contains no resources.pak");
  const pak = parsePak(readZipEntry(zipBuf, index.get(pakName)));
  console.log(`\n${pakName}: v${pak.version}, ${pak.entries.length} resources`);

  // Snapshot builds also ship the frontend loose and named. Use it as the
  // naming oracle, then pull the actual bytes back out of the pak.
  const loosePrefix = [...index.keys()].find((n) => /\/resources\/inspector\//.test(n));
  if (!loosePrefix) {
    throw new Error(
      "this snapshot has no loose resources/inspector/ tree to learn names from;\n" +
        "use `extract --manifest <file>` with a manifest learned from one that does",
    );
  }
  const root = loosePrefix.slice(0, loosePrefix.indexOf("/resources/inspector/") + 1);
  const looseFiles = [...index.keys()]
    .filter((n) => n.startsWith(`${root}resources/inspector/`))
    .map((n) => ({
      name: n.slice(`${root}resources/inspector/`.length),
      bytes: readZipEntry(zipBuf, index.get(n)),
    }));
  console.log(`naming oracle: ${looseFiles.length} loose files under resources/inspector/`);

  const learned = learnManifest(pak.entries, looseFiles);
  const ids = Object.keys(learned.map).map(Number).sort((a, b) => a - b);
  console.log(`learned id -> name for ${ids.length} resources (ids ${ids[0]}..${ids.at(-1)})`);
  if (learned.unpacked.length) {
    console.log(
      `not packed into the .pak (redundant in release builds, their contents are\n` +
        `already inlined into devtools.js): ${learned.unpacked.join(", ")}`,
    );
  }

  const manifestPath = join(HERE, "manifests", `${position}.json`);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        position,
        platform,
        chromium_revision: rev.chromium_revision,
        webkit_revision: rev.webkit_revision,
        anchorId: learned.anchorId,
        map: learned.map,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`wrote manifest ${relative(HERE, manifestPath)}`);

  // Extract from the pak itself, using only the learned manifest.
  const { files, missing } = applyManifest(pak.entries, {
    map: learned.map,
    anchorId: null,
  });
  if (missing.length) console.log(`WARNING: ${missing.length} manifest ids absent from pak`);

  writeTree(outDir, files);
  const ok = report(files, outDir);

  // Cross-check: the bytes we wrote must equal the loose originals.
  const looseByName = new Map(looseFiles.map((f) => [f.name, f.bytes]));
  let compared = 0;
  let differing = 0;
  for (const f of files) {
    const other = looseByName.get(f.name);
    if (!other) continue;
    compared++;
    if (!other.equals(f.bytes)) differing++;
  }
  console.log(
    `byte cross-check vs loose tree: ${compared} compared, ${differing} differing` +
      (differing === 0 ? " (identical)" : ""),
  );

  if (!ok || differing > 0) process.exitCode = 1;
  else console.log(`\nready. next:  node pa-devtools.mjs serve`);
}

// --- extract: bring your own pak ----------------------------------------

async function cmdExtract(o) {
  const pakPath = o.pak && resolve(o.pak);
  if (!pakPath || !existsSync(pakPath)) {
    throw new Error("--pak <path to resources.pak> is required");
  }
  const outDir = resolve(o.out || join(HERE, "front_end"));

  const manifestPath = resolve(
    o.manifest || join(HERE, "manifests", `${DEFAULT_POSITION}.json`),
  );
  if (!existsSync(manifestPath)) {
    throw new Error(`no manifest at ${manifestPath} - run \`build\` first to learn one`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const pak = parsePak(readFileSync(pakPath));
  console.log(`${pakPath}: v${pak.version}, ${pak.entries.length} resources`);

  const currentAnchorId = findAnchorId(pak.entries);
  if (currentAnchorId == null) {
    throw new Error("no devtools.html found in this pak - it has no DevTools frontend");
  }
  const { files, missing, shift } = applyManifest(pak.entries, {
    ...manifest,
    currentAnchorId,
  });
  console.log(
    `anchor devtools.html at id ${currentAnchorId} (manifest ${manifest.anchorId}, shift ${shift})`,
  );
  if (missing.length) {
    console.log(`WARNING: ${missing.length} manifest ids absent from this pak:`);
    for (const m of missing.slice(0, 15)) console.log(`    id=${m.id} ${m.name}`);
  }

  writeTree(outDir, files);
  if (!report(files, outDir)) process.exitCode = 1;
}

// --- serve ---------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
};

async function paTargets(host, port) {
  const res = await fetch(`http://${host}:${port}/json`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function wsParamFor(target, host, port) {
  // Prefer what the backend reports; fall back to the conventional path so a
  // fork that omits webSocketDebuggerUrl still works.
  const raw = target.webSocketDebuggerUrl;
  if (raw) return raw.replace(/^wss?:\/\//, "");
  return `${host}:${port}/devtools/page/${target.id}`;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

async function cmdServe(o) {
  const dir = resolve(o.dir || join(HERE, "front_end"));
  if (!existsSync(join(dir, "devtools.html"))) {
    throw new Error(`no devtools.html in ${dir} - run \`build\` first`);
  }
  const port = Number(o.port || DEFAULT_SERVE_PORT);
  const paHost = o["pa-host"] || "127.0.0.1";
  const paPort = Number(o["pa-port"] || DEFAULT_PA_PORT);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname === "/") {
      let body;
      try {
        const targets = await paTargets(paHost, paPort);
        const pages = targets.filter((t) => !t.type || t.type === "page");
        body = pages.length
          ? pages
              .map((t) => {
                const ws = wsParamFor(t, paHost, paPort);
                const href = `/devtools.html?ws=${encodeURIComponent(ws)}`;
                return `<li><a href="${escapeHtml(href)}">${escapeHtml(t.title || t.id)}</a>` +
                  `<div class="u">${escapeHtml(t.url || "")}</div></li>`;
              })
              .join("")
          : `<li>PA is up on ${paHost}:${paPort} but reports no debuggable pages.</li>`;
      } catch (e) {
        body =
          `<li>Cannot reach PA's debug port at ${paHost}:${paPort} (${escapeHtml(e.message)}).` +
          `<div class="u">Launch PA, then reload this page.</div></li>`;
      }
      const html =
        `<!doctype html><meta charset="utf-8"><title>PA DevTools</title>` +
        `<style>body{font:14px/1.5 system-ui,sans-serif;margin:2rem;max-width:60rem}` +
        `li{margin:.6rem 0}.u{color:#777;font-size:12px;word-break:break-all}` +
        `@media(prefers-color-scheme:dark){body{background:#1b1b1b;color:#eee}a{color:#7ab7ff}.u{color:#999}}</style>` +
        `<h1>PA DevTools</h1><p>Chrome-40-era frontend, serving from <code>${escapeHtml(dir)}</code>.</p>` +
        `<ul>${body}</ul><p><a href="/">refresh</a></p>`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // Static file serving, confined to `dir`.
    const wanted = resolve(join(dir, decodeURIComponent(url.pathname)));
    if (wanted !== dir && !wanted.startsWith(dir + sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (!existsSync(wanted) || statSync(wanted).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(wanted).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(readFileSync(wanted));
  });

  server.listen(port, () => {
    console.log(`serving ${dir}`);
    console.log(`  open  http://127.0.0.1:${port}/`);
    console.log(`  PA debug port expected at ${paHost}:${paPort}`);
  });
}

// --- doctor --------------------------------------------------------------

async function cmdDoctor(o) {
  const host = o["pa-host"] || "127.0.0.1";
  const port = Number(o["pa-port"] || DEFAULT_PA_PORT);
  console.log(`probing PA debug port at ${host}:${port}`);

  let reachable = false;
  for (const path of ["/json/version", "/json"]) {
    try {
      const res = await fetch(`http://${host}:${port}${path}`, {
        signal: AbortSignal.timeout(4000),
      });
      const text = await res.text();
      reachable = true;
      console.log(`\nGET ${path} -> HTTP ${res.status}`);
      console.log(text.slice(0, 1500));
    } catch (e) {
      console.log(`\nGET ${path} -> ${e.message}`);
    }
  }
  if (!reachable) {
    console.log(
      `\nNothing is listening on ${host}:${port}. The port is opt-in per launch:\n` +
        `start PA with --coherent_port=${port}, navigate to the scene you want to\n` +
        `inspect, then re-run. A refused port usually means PA was launched without\n` +
        `that argument rather than that the game is closed.`,
    );
  }

  const dir = resolve(o.dir || join(HERE, "front_end"));
  const present = existsSync(join(dir, "devtools.html"));
  let count = 0;
  if (present) {
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else count++;
      }
    };
    walk(dir);
  }
  const status = present ? `present (${count} files)` : "MISSING - run `build`";
  console.log(`\nfrontend at ${dir}: ${status}`);
}

// --- entry ---------------------------------------------------------------

const USAGE = `pa-devtools - Chrome-40-era DevTools frontend for debugging Planetary Annihilation

  build     [--platform Linux_x64] [--position 303346] [--out DIR] [--cache DIR]
            Download a Chromium snapshot, extract the DevTools frontend from its
            resources.pak, learn a manifest, and verify the result.

  extract   --pak PATH [--manifest FILE] [--out DIR]
            Extract from a resources.pak you already have, using a stored
            manifest for filenames. For builds that ship no loose inspector tree.

  serve     [--port 8099] [--pa-host 127.0.0.1] [--pa-port 9999] [--dir DIR]
            Serve the frontend and list PA's debuggable pages as links.

  doctor    [--pa-host 127.0.0.1] [--pa-port 9999] [--dir DIR]
            Report whether PA's debug port and the extracted frontend are usable.
`;

const o = args(process.argv.slice(2));
const cmd = o._[0];
const commands = { build: cmdBuild, extract: cmdExtract, serve: cmdServe, doctor: cmdDoctor };

if (!cmd || !commands[cmd]) {
  console.log(USAGE);
  process.exit(cmd ? 1 : 0);
}
try {
  await commands[cmd](o);
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
