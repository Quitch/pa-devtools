# pa-devtools

A Chrome-40-era DevTools frontend for debugging Planetary Annihilation: TITANS,
extracted from a Chromium snapshot's `resources.pak`.

Pure Node, no dependencies, no shelling out to platform tools — the same
commands work on Windows, Linux and macOS.

## Why this exists

PA's UI runs in Coherent UI 2.6.8, a Chromium fork. Its host process
(`bin_x64/host/CoherentUI_Host.exe`) contains the standard Chromium
`devtools_http_handler_impl` and exposes the DevTools protocol on
`127.0.0.1:9999` — but ships **no** DevTools frontend. `bin_x64/host/` has
`blink_resources.pak`, `content_resources_100_percent.pak`,
`theme_resources_standard.pak` and `ui_resources_100_percent.pak`, and no
devtools pak among them. So `/devtools/devtools.html` has nothing to serve.

A modern DevTools frontend can't drive a backend that old. This tool recovers
the era-matched one and serves it from your own machine.

### It really is the right era

PA's own `/json/version` reports:

```text
"User-Agent": "... Chrome/40.0.2214.28 Safari/537.36"
"WebKit-Version": "537.36 (@5994603edf160b2d21296cfe70499b12dae8301a)"
"Protocol-Version": "1.1"
```

Snapshot 303346 *is* Chrome 40.0.2214's branch base — an exact match to the
build PA embeds.

The frontend's declared protocol surface, diffed against the literals compiled
into `CoherentUI_Host.exe`:

| | frontend declares | found in Coherent host |
| --- | --- | --- |
| commands | 258 | **258** |
| events | 96 | 95 |

Every command matches. The single missing event is
`Console.messageRepeatCountUpdated`, which only collapses repeated console
lines. All 26 domains — `DOM`, `CSS`, `Debugger`, `Runtime`, `Network`,
`Timeline`, `Profiler`, `Page`, … — are fully covered.

### Validated against a live PA session

Confirmed 2026-07-27 against a running client. The `ws://` upgrade succeeds,
and every bootstrap call the frontend's panels make on attach returns a result:

```text
Inspector/Page/Runtime/Console/Network/Debugger/DOM/CSS/DOMStorage/Database/
IndexedDB/Profiler/HeapProfiler/Timeline/LayerTree/Worker/ApplicationCache .enable
                                                          -> 18 ok, 0 failed
DOM.getDocument            -> #document, 2 children, coui://ui/main/main.html
Page.getResourceTree       -> frame coui://ui/main/main.html, 9 resources
Runtime.evaluate           -> model/ko/api all reachable, wasThrown=false
CSS.getComputedStyleForNode-> 263 properties on <body>, 6 matched rules
DOM.getOuterHTML           -> 2425 chars
```

99 events streamed while attached — `Console.messageAdded` x70,
`Debugger.scriptParsed` x12, `Network.*`, `CSS.styleSheetAdded`,
`LayerTree.layerTreeDidChange`. PA stayed healthy throughout and all 5 targets
remained listed afterwards.

Rendering was then confirmed too, by driving an era-matched Chromium's own CDP
and reading back the loaded frontend: 1 target attached, all 8 panels built
(`elements,network,sources,timeline,profiles,resources,audits,console`), 546
elements in the page, Console panel 1249x1259 with **141 message rows** of live
PA output, and **zero errors** in the frontend's own console.

## Usage

```bash
node pa-devtools.mjs build     # download snapshot, extract, verify (~78 MB, once)
node pa-devtools.mjs serve     # serve it, list PA's debuggable pages
node pa-devtools.mjs browser   # launch an era-matched Chromium to view it in
node pa-devtools.mjs doctor    # is PA's debug port up? is the frontend present?
```

Launch PA **with `--coherent_port=9999`** — the debug port is opt-in per launch,
so a refused connection usually means a missing argument rather than a closed
game. Then run `serve` and `browser`, and click a page in the list.

`--coherent_port` is a PA argument, not a Windows mechanism, so it works
unchanged on Linux and macOS.

Useful flags: `--port`, `--pa-host`, `--pa-port`, `--out`, `--dir`,
`--debug-port` (gives the viewer its own CDP port, to debug the debugger).

### You cannot view this in a modern browser

Not a limitation of the extraction — the 2014 frontend depends on APIs every
current engine has removed:

| API | Uses | Status |
| --- | --- | --- |
| `::shadow` / `/deep/` CSS combinators | 98 | Removed Chrome 63; never in Firefox |
| `createShadowRoot` (Shadow DOM v0) | 2 | Removed Chrome 80; never in Firefox |
| `KeyboardEvent.keyIdentifier` | 74 | Removed Chrome 54; never in Firefox |
| `SharedWorker` temp storage cleaner | 9 | Fails → `Failed to clear temp storage` |

Panel content lives inside shadow roots styled through those combinators, so a
modern browser paints the tab bar and drops everything beneath it. That is the
exact symptom to expect, and there is no shim worth trusting across 4 MB of
minified code.

`browser` solves it by running the frontend in the browser it shipped with:

| Host | Snapshot | Build |
| --- | --- | --- |
| Windows | `Win/303348` | Chrome 40.0.2214.0 (verified on Windows 11) |
| Linux | `Linux_x64/303346` | Chrome 40.0.2214 |
| macOS | `Mac/303350` | Chrome 40.0.2214 |

The viewer only has to predate the removals above, so anything from roughly
Chrome 28 to Chrome 53 works — pass `--position` if you want a different one.
A newer pick in that range may behave better on a modern OS.

**Security:** this is an unpatched 2014 Chromium with known, unfixed
vulnerabilities. It launches with an isolated `--user-data-dir` and background
networking, sync, extensions and component updates disabled, and is only meant
to be pointed at `127.0.0.1`. Don't browse the web with it.

macOS caveat: a 2014 unsigned x86-64 app will likely need Rosetta and a
Gatekeeper exception. Untested there.

Target ids change on every navigation, so re-fetch the root page (rather than
bookmarking a `?ws=` URL) after PA changes scene. GW scenes only appear in the
target list once you're actually in them.

## What gets extracted

From `resources.pak` at snapshot position **303346** (Chromium r303346, Blink
r184994 — Chrome 40.0.2214's branch point):

- **95 files, 4.09 MB**, resource ids `22000..22094`, fully contiguous
- 24 code/markup files (`devtools.html`, `devtools.js`, `devtools.css`,
  `toolbox.*`, 17 lazily-loaded `*_module.js` bundles, `devtools_extension_api.js`)
- 71 images under `Images/`

The frontend is platform-neutral, so the Linux snapshot is used regardless of
your OS. It's also the only platform with a build at exactly 303346, and the
smallest of the three.

## How filenames are recovered

This is the only genuinely hard part. A `.pak` is a flat `uint16 id -> blob`
store — **there are no filenames in it anywhere**. Unpacking gives you 95
anonymous blobs. Names have to come from an oracle:

- **`build`** uses the loose, correctly-named `chrome-linux/resources/inspector/`
  tree that *snapshot* builds happen to ship alongside the pak. Hashing those
  against the pak blobs (sha256) yields an exact, assumption-free `id -> name`
  map, which is written to `manifests/<position>.json`.
- **`extract`** uses that stored manifest against any `resources.pak`, which is
  what you need for builds that ship **only** a pak and no loose tree — official
  Chrome and Chromium *releases*, for instance. It locates `devtools.html` by
  content and shifts the manifest to match, so a build whose id block sits at a
  different offset still lands correctly.

Both routes were checked to produce byte-identical output.

### Worth knowing before you reach for this

Because snapshot builds ship that loose `resources/inspector/` directory, and
its contents are **byte-identical** to what's in the pak (verified: 95 files
compared, 0 differing), you don't strictly need pak extraction *for a snapshot*
— copying the directory gets you the same bytes. The pak path earns its keep
when your only source is a build that doesn't ship the loose tree.

## Verification

Extraction isn't trusted, it's checked. `collectReferences()` walks the
extracted HTML/CSS/JS and collects every relative path they mention —
`src=`/`href=` in HTML, `url()` in CSS, bare `Images/*.png` strings, and
`*_module.js` bundle names. Every one must resolve to a file in the output.
A misaligned id block shows up immediately as dangling references.

Current status: **75 referenced paths, 0 dangling.** All 75 also verified to
return HTTP 200 through the bundled server.

## Layout

```text
pa-devtools.mjs        CLI: build | extract | serve | doctor
lib/pak.mjs            Chromium DataPack v4/v5 reader
lib/zip.mjs            minimal zip reader (no deps; unzip/Expand-Archive aren't portable)
lib/snapshot.mjs       snapshot resolution + download, with caching
lib/extract.mjs        name recovery + reference-closure verification
manifests/303346.json  learned id -> name map for Chrome 40
front_end/             generated output (gitignored)
.cache/                downloaded snapshot zips (gitignored)
```

## Caveats

- Coherent UI is a *fork*. The live handshake above covers the calls the frontend
  makes on attach, but anything it changed behind an identical method name deeper
  into a panel's use won't show up in either that or a string diff.
- **Don't point a modern DevTools frontend at PA.** Current Edge/Chrome can't
  complete the WebSocket upgrade against this backend — PA logs
  `GetMimeType doesn't know mime type for: page/<id>` and the Coherent UI host
  process has been observed crashing shortly after, killing port 9999 while the
  game keeps running (symptom: PA alive, connection refused; fix: restart PA).
  `chrome://inspect` also rejects the target, since `/json/version` reports
  protocol 1.1 against a modern expectation of 1.3. Avoiding exactly this is the
  reason for era-matching the frontend.
- The `?ws=` parameter must **not** be percent-encoded. The M40 frontend reads it
  verbatim and prepends `ws://` without decoding, so an encoded `:` or `/` gives
  `Failed to construct 'WebSocket': The URL ... is invalid` and the UI loads but
  never connects. PA's own `devtoolsFrontendUrl` passes it raw for this reason.
- Only one client may attach to a target at a time. While one is attached the
  backend **omits** `webSocketDebuggerUrl` and `devtoolsFrontendUrl` from
  `/json` for that target; `serve` uses that absence to flag it as busy.
- `SupportedCSSProperties.js` and `InspectorBackendCommands.js` exist loose in
  the snapshot but are absent from the pak. That's expected: release builds
  inline both into `devtools.js` (which carries 259 `registerCommand` calls),
  so nothing references them and nothing is missing.
