#!/usr/bin/env node
// pa-devtools - build and serve a Chrome-40-era DevTools frontend for
// debugging Planetary Annihilation's embedded Coherent UI renderer.
//
// Coherent only. Since build 124720 PA defaults to CEF (Chromium 150), which a
// stock Chrome or Edge debugs through its chrome://inspect page; serve and
// doctor detect a CEF backend and say so instead of offering links that fail.
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

// Coherent UI 2.6.8 reports Chrome/40 and protocol 1.1. Anything from Chrome 54
// on has dropped the APIs the M40 frontend needs, so it can't be driven by it.
const MODERN_CHROME = 54;

async function paBackend(host, port) {
  const res = await fetch(`http://${host}:${port}/json/version`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const v = await res.json();
  const ua = v.Browser || v["User-Agent"] || "";
  const major = Number(/Chrome\/(\d+)/.exec(ua)?.[1] || 0);
  return {
    modern: major >= MODERN_CHROME,
    browser: v.Browser || (major ? `Chrome/${major}` : "unknown"),
    protocol: v["Protocol-Version"] || "unknown",
  };
}

function cefHelp(host, port) {
  return {
    lead: "PA is running the CEF UI backend, which this tool does not serve. Use a current Chrome or Edge instead:",
    steps: [
      "open chrome://inspect (edge://inspect in Edge)",
      `click Configure... and add ${host}:${port}`,
      'click "inspect" under the page you want',
    ],
    note:
      "Opening a frontend URL directly does not work: the backend rejects any page's " +
      "WebSocket by Origin (403). To debug Coherent instead, relaunch PA with --ui-backend=coherent.",
  };
}

function cefHelpText(host, port) {
  const { lead, steps, note } = cefHelp(host, port);
  return [lead, ...steps.map((s, i) => `  ${i + 1}. ${s}`), note].join("\n");
}

function cefHelpHtml(host, port, browser) {
  const { lead, steps, note } = cefHelp(host, port);
  const items = steps.map((s) => "<li>" + escapeHtml(s) + "</li>").join("");
  return (
    `<li>${escapeHtml(lead)}<div class="u">${escapeHtml(browser)}</div>` +
    `<ol>${items}</ol><div class="u">${escapeHtml(note)}</div></li>`
  );
}

function targetListHtml(targets, host, port) {
  const pages = targets.filter((t) => !t.type || t.type === "page");
  if (!pages.length) {
    return `<li>PA is up on ${host}:${port} but reports no debuggable pages.</li>`;
  }
  return pages
    .map((t) => {
      const ws = wsParamFor(t, host, port);
      // Deliberately NOT percent-encoded: the M40 frontend reads this
      // parameter verbatim and prepends "ws://" without decoding it,
      // so an encoded ":" or "/" yields an invalid WebSocket URL.
      // PA's own devtoolsFrontendUrl passes it raw for the same reason.
      const href = `/devtools.html?ws=${ws}`;
      // The backend drops webSocketDebuggerUrl while a client is
      // attached, and only allows one at a time - so that absence is
      // how we know a target is already being inspected.
      const busy = !t.webSocketDebuggerUrl;
      const note = busy
        ? `<div class="b">already being inspected - close the other DevTools ` +
          `window first, or this link won't attach</div>`
        : "";
      return `<li><a class="${busy ? "busy" : ""}" href="${escapeHtml(href)}">` +
        `${escapeHtml(t.title || t.id)}</a>` +
        `<div class="u">${escapeHtml(t.url || "")}</div>${note}</li>`;
    })
    .join("");
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
        const backend = await paBackend(paHost, paPort);
        body = backend.modern
          ? cefHelpHtml(paHost, paPort, backend.browser)
          : targetListHtml(await paTargets(paHost, paPort), paHost, paPort);
      } catch (e) {
        body =
          `<li>Cannot reach PA's debug port at ${paHost}:${paPort} (${escapeHtml(e.message)}).` +
          `<div class="u">Launch PA with --ui-backend=coherent --webview-port=${paPort}, ` +
          `then reload this page.</div></li>`;
      }
      const html =
        `<!doctype html><meta charset="utf-8"><title>PA DevTools</title>` +
        `<style>body{font:14px/1.5 system-ui,sans-serif;margin:2rem;max-width:60rem}` +
        `li{margin:.6rem 0}.u{color:#777;font-size:12px;word-break:break-all}` +
        `.b{color:#b06000;font-size:12px}a.busy{opacity:.55}` +
        `@media(prefers-color-scheme:dark){body{background:#1b1b1b;color:#eee}a{color:#7ab7ff}` +
        `.u{color:#999}.b{color:#e0a24a}}</style>` +
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

// --- browser -------------------------------------------------------------
//
// The extracted frontend is from 2014 and depends on APIs every current
// browser has since removed: Shadow DOM v0 (`createShadowRoot`), the `::shadow`
// and `/deep/` CSS combinators (98 uses), and `KeyboardEvent.keyIdentifier`
// (74 uses). Panel content lives inside shadow roots styled through those
// combinators, so a modern engine paints the frame and drops the contents.
//
// There is no shim worth trusting for that. The frontend is instead run in the
// browser it shipped with - an era-matched Chromium snapshot for the host OS.

const VIEWER = {
  win32: { platform: "Win", position: 303348, exe: "chrome-win32/chrome.exe" },
  linux: { platform: "Linux_x64", position: 303346, exe: "chrome-linux/chrome" },
  darwin: {
    platform: "Mac",
    position: 303350,
    exe: "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  },
};

function unpackZip(zipBuf, destDir) {
  const index = readZipIndex(zipBuf);
  mkdirSync(destDir, { recursive: true });
  for (const [name, entry] of index) {
    const target = join(destDir, name);
    if (!resolve(target).startsWith(resolve(destDir))) continue; // zip-slip guard
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readZipEntry(zipBuf, entry));
  }
  return index.size;
}

async function cmdBrowser(o) {
  const spec = VIEWER[process.platform];
  if (!spec) throw new Error(`no era-matched Chromium mapping for ${process.platform}`);

  const platform = o.platform || spec.platform;
  const position = Number(o.position || spec.position);
  const cacheDir = resolve(o.cache || join(HERE, ".cache"));
  const browserDir = join(cacheDir, `browser-${platform}-${position}`);
  const exe = join(browserDir, o.exe || spec.exe);

  if (!existsSync(exe)) {
    console.log(`fetching era-matched Chromium (${platform} ${position})`);
    const zipBuf = await downloadZip(platform, position, cacheDir, (m) => console.log(m));
    console.log(`unpacking to ${browserDir} ...`);
    const n = unpackZip(zipBuf, browserDir);
    console.log(`unpacked ${n} files`);
    if (process.platform !== "win32") {
      const { chmodSync } = await import("node:fs");
      try {
        chmodSync(exe, 0o755);
      } catch {
        /* best effort */
      }
    }
  }
  if (!existsSync(exe)) throw new Error(`browser executable not found at ${exe}`);

  const url = o.url || `http://127.0.0.1:${Number(o.port || DEFAULT_SERVE_PORT)}/`;
  const profile = join(cacheDir, "browser-profile");

  const flags = [
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-translate",
    "--safebrowsing-disable-auto-update",
    "--metrics-recording-only",
    "--no-pings",
  ];
  // Lets you debug the debugger: attach to this Chromium's own CDP to inspect
  // the DevTools frontend it is displaying.
  if (o["debug-port"]) flags.push(`--remote-debugging-port=${Number(o["debug-port"])}`);
  if (o["no-sandbox"]) flags.push("--no-sandbox");
  if (o.app) flags.push(`--app=${url}`);
  else flags.push(url);

  console.log(`\n!  This is an unpatched 2014 Chromium with known, unfixed security`);
  console.log(`!  vulnerabilities. It is launched with an isolated profile and is only`);
  console.log(`!  meant to point at 127.0.0.1. Do not browse the web with it.\n`);
  console.log(`launching ${exe}`);
  console.log(`   -> ${url}`);

  const { spawn } = await import("node:child_process");
  const child = spawn(exe, flags, { detached: true, stdio: "ignore" });
  child.unref();
  console.log(`\nlaunched (pid ${child.pid}). Close the window when you're done.`);
}

// --- doctor --------------------------------------------------------------

async function reportBackend(host, port) {
  const backend = await paBackend(host, port).catch((e) => ({ error: e.message }));
  if (backend.error) {
    console.log(`\nbackend: unknown (${backend.error})`);
  } else {
    console.log(
      `\nbackend: ${backend.modern ? "CEF" : "Coherent UI"} ` +
        `(${backend.browser}, protocol ${backend.protocol})`,
    );
    if (backend.modern) console.log(cefHelpText(host, port));
  }
}

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
        `start PA with --webview-port=${port} (plus --ui-backend=coherent to use this\n` +
        `tool's frontend), navigate to the scene you want to inspect, then re-run.\n` +
        `A refused port usually means PA was launched without that argument rather\n` +
        `than that the game is closed.`,
    );
  } else {
    await reportBackend(host, port);
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

  For PA's Coherent UI backend (--ui-backend=coherent) only. On the default CEF
  backend, use chrome://inspect in a current Chrome or Edge; doctor explains.

  build     [--platform Linux_x64] [--position 303346] [--out DIR] [--cache DIR]
            Download a Chromium snapshot, extract the DevTools frontend from its
            resources.pak, learn a manifest, and verify the result.

  extract   --pak PATH [--manifest FILE] [--out DIR]
            Extract from a resources.pak you already have, using a stored
            manifest for filenames. For builds that ship no loose inspector tree.

  serve     [--port 8099] [--pa-host 127.0.0.1] [--pa-port 9999] [--dir DIR]
            Serve the frontend and list PA's debuggable pages as links.

  browser   [--position N] [--url URL] [--app] [--no-sandbox]
            Launch an era-matched Chromium to view the frontend in. Required:
            the 2014 frontend uses Shadow DOM v0, ::shadow and /deep/, which no
            current browser still supports, so panels render blank in one.

  doctor    [--pa-host 127.0.0.1] [--pa-port 9999] [--dir DIR]
            Report whether PA's debug port and the extracted frontend are usable.
`;

const o = args(process.argv.slice(2));
const cmd = o._[0];
const commands = {
  build: cmdBuild,
  extract: cmdExtract,
  serve: cmdServe,
  browser: cmdBrowser,
  doctor: cmdDoctor,
};

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
