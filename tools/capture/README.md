# tools/capture

Deterministic frames out of the running game, so that every visual claim in this
project is checked against a picture that actually rendered rather than against
an assumption about what the code does.

```
npx tsx tools/capture/cli.ts <suite> [options]
# or
npm run capture -- <suite> [options]
```

`<suite>` is one of `stills`, `silhouettes`, `units`, `motion`, `perf`, `all`.
Output lands in `captures/<suite>/` (git-ignored, regenerated on demand).

The exit code is the contract. **0** means every shot in the suite produced a
frame that passed the blank-frame check and the page reported no errors. **1**
means at least one shot failed. A *skipped* shot is not a failure — it is the
harness refusing to pretend a stubbed subsystem was judged — but it is loud, it
is counted, and it is listed in `index.md`.

---

## What each suite produces

| suite | what it captures | what to look at |
|---|---|---|
| `stills` | the eight named framings at the opening position, plus mid-game and endgame positions, plus a board turntable sheet | `review/default.png` first; then `review/overShoulder.png` for the framing a capture actually plays in |
| `silhouettes` | silhouette mode: whole board low and level, whole board from above, mid-game, every one of the fourteen units isolated, and a **line-up sheet per army** | `lineup-red.png` and `lineup-black.png`. If two units in one army share a shape, that is the frame that says so |
| `units` | each of the fourteen (side, type) pairs at front / three-quarter / profile, plus an eight-azimuth turntable sheet per unit | the three angle stills for anything that looks wrong on its turntable |
| `motion` | `seekCapture()` sampled at sixteen points across `t = 0…1` for five attacker/defender pairs, and one full cycle of each gait — all delivered as contact sheets, with the individual frames kept alongside | `capture-*.png` sheets; drop into `frames/capture-*/NN.png` to zoom a single beat |
| `perf` | thirty-two units on screen at two framings, `stats()` sampled over 120 stepped frames | `perf-32-units.json` and the table in `index.md` |
| `all` | every suite in that order, plus a top-level `captures/index.md` | `captures/index.md` |

Each suite writes `captures/<suite>/index.md`: a table of every image with its
label, its frame statistics, the list of skipped shots with the reason, and the
review copy inlined. That file is the single thing to hand a critic — it names
every picture and links to it.

---

## Options

```
--url=<url>        capture against an already-running server (skips vite entirely)
--out=<dir>        output root (default <repo>/captures)
--only=<a,b>       only shots whose name contains one of these substrings
--port=<n>         port for the server this tool starts (default 4173)
--width --height   viewport in CSS px (default 1280x800)
--dsf=<n>          device pixel ratio for the full-resolution capture (default 2)
--review-edge=<n>  long edge of the review copies (default 1600)
--server=<mode>    auto | preview | dev   (default auto)
--skip-build       reuse whatever is already in dist/
--headed           run a visible browser
--bail             stop at the first failure instead of reporting them all
--list             print the shot list and exit
--verbose          forward page console output
```

Useful combinations:

```bash
# iterate on one unit without rebuilding or capturing the other thirteen
npx tsx tools/capture/cli.ts units --only=red-chariot --skip-build

# capture against a dev server you already have open
npm run dev &
npx tsx tools/capture/cli.ts stills --url=http://127.0.0.1:5173/

# see what a suite would do
npx tsx tools/capture/cli.ts motion --list
```

---

## Two images per shot, and why

Every still is written twice:

* `captures/<suite>/<name>.png` — full retina, 2560x1600 at the default
  1280x800 @ 2x viewport. This is the pixel-level reference.
* `captures/<suite>/review/<name>.png` — the same frame downscaled to a
  1600 px long edge. **This is what critics open.**

The review copy is a *resample of the retina PNG*, done with `drawImage` in a
scratch page, not a second render at a lower device pixel ratio. That
distinction is the whole point: screen-space line work — the inverted-hull
outline and the Sobel pass — changes thickness with the pixel ratio, so
re-rendering at DPR 1.25 would show the critic a picture the game never drew.
Reductions greater than 2:1 are done by successive halving, because `drawImage`
samples roughly once per destination pixel and a single 4:1 draw turns a spear
shaft into a dotted line.

Contact sheets are already inside the 1600 px budget, so a sheet is its own
review copy.

---

## The blank-frame detector

The most common way a capture harness lies is to write a perfectly valid PNG of
a black screen and report success. So every capture is decoded — by
`png.ts`, ~120 lines against `node:zlib`, because `sharp` and `pngjs` are not
available and could not be added — and judged on the bytes that landed on disk:

| measure | meaning |
|---|---|
| `dominantFraction` | share of pixels holding the most common colour, quantised to 5 bits per channel. Over 99% fails |
| `uniqueBuckets` | distinct colour buckets. Under 3 fails. This only catches degenerate frames; a flat-shaded bootstrap board legitimately resolves to four or five |
| `meanLuma`, `stdLuma` | display-referred exposure and tonal spread |
| `darkFraction`, `lightFraction` | share below luma 0.06 and above 0.90 — ink and paper |

Silhouette shots would trip a naive "99% of one colour" rule constantly, since
flat black on white is the point. They are judged by a stronger, shape-specific
rule instead: the frame must contain **both** real ink and real paper. A black
frame fails on the missing paper, a white frame fails on the missing ink, and a
correct silhouette passes both.

For contact sheets the check runs per cell. A cell that fails gets its index
badge drawn in cinnabar instead of gold, so a sheet points at its own bad
frames. A sheet fails only if *every* cell fails.

---

## Degrading against an unfinished game

Subsystems land in parallel, and during bootstrap most of `window.__XQ` is a
no-op stub. The driver probes what is real before capturing anything:

1. **Source scan.** Every `__XQ` method's `Function.prototype.toString()` is
   checked for an empty body. A stub in this codebase is literally
   `async () => {}`, which survives minification as `async()=>{}`. This can only
   produce false negatives, which the next two probes catch.
2. **Board probe.** `describe()` is asked for pieces. If there are none, the
   whole position and choreography surface is marked not-live, because none of
   it can be meaningfully driven.
3. **Round-trip probe.** A FEN is loaded and read back. A `getPosition()` that
   always returns the opening position is a stub the source scan cannot see.
4. **Visual probes.** The clock is paused, so the frame is deterministic:
   `setSilhouette(true)` and `showcase()` are called and the frame is hashed
   before and after. An identical hash means the call changed nothing that
   renders, whatever its source says.

Each shot declares the methods it cannot be honest without. When one is missing,
the shot is skipped with the reason printed and recorded — never captured
anyway. Forty-two identical pictures of an empty board is not evidence.

The `board-turntable` sheet in `stills` is deliberately built on `setPose`
alone, which has been live since the first bootstrap. It is the canary for the
contact-sheet machinery: without it, every sheet in the shot list is gated
behind a subsystem that may not exist yet, and the sheet code could rot untested
until the day the motion critic asks for a clip.

---

## Running on this machine

Headless Linux, no GPU. Chromium is launched with ANGLE pointed at SwiftShader
so WebGL2 initialises against a software rasteriser:

```
--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader
--enable-webgl --ignore-gpu-blocklist --disable-gpu-sandbox --no-sandbox
--force-color-profile=srgb
```

`--enable-features=Vulkan` is deliberately **not** passed; ANGLE already reaches
SwiftShader through its own Vulkan backend and forcing the feature flag
destabilises it. The context is verified after navigation and the run aborts
loudly if WebGL did not come up, rather than producing a folder of black PNGs.

Observed here: `WebGL 2.0 (OpenGL ES 3.0 Chromium)` on
`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)`,
`MAX_DRAW_BUFFERS 6`, `EXT_color_buffer_float` present — enough for the MRT
depth/normal prepass the pipeline needs.

**Frame times measured here are not a performance verdict.** SwiftShader is a
software rasteriser; the 16.6 ms budget in `ARCHITECTURE.md` is written for a
GPU. The `perf` suite reports frame times as a regression signal against
previous runs on the same machine, and grades only draw calls and triangle
counts, which three.js counts on the CPU and which do not depend on the
rasteriser.

A stepped frame costs roughly **320 ms** of wall clock here at 2560x1600, so the
`perf` suite's two 120-frame samples take about 80 s. `--dsf=1` cuts that by
close to 4x when you only want the draw-call and triangle numbers.

Two environment quirks the harness works around, so nobody has to rediscover
them:

* **Chromium revision mismatch.** `@playwright/test` 1.62 expects revision 1234;
  the image ships 1194 under `PLAYWRIGHT_BROWSERS_PATH`. Never run
  `playwright install`. The driver tries the bundled resolution first and falls
  back to the binary that is actually on disk.
* **`__name is not defined`.** `tsx` compiles with esbuild's `keepNames`, which
  rewrites named function expressions as `__name(fn, "fn")`. Playwright ships
  the *compiled* text of an `evaluate()` callback into the page, where that
  helper does not exist. The driver installs a one-line identity shim as an init
  script on every context.

---

## Known gaps

* **`tsc` does not semantically check this directory.** `@types/node` is not
  installed in this checkout, so `process`, `Buffer` and every `node:*` import
  resolve to nothing. It is not specific to the harness — `vite.config.ts` fails
  the same way — and `skipLibCheck` hides it until you look. Two further things
  mask it: the syntax errors currently in `src/render/shaders/*.glsl.ts` make
  `tsc` skip semantic analysis for the whole program, and `tsc` reports no
  errors at all for `tools/` as a result. Installing `@types/node` fixes it; the
  harness itself typechecks clean once node types are on the path.
* **Cells in a contact sheet are captured at CSS scale**, not retina, so a kept
  frame is 1280x800 rather than 2560x1600. Motion is judged on timing and pose,
  and retina cells would quadruple the base64 traffic for detail the grid
  discards. For a pixel-level look at one beat, re-run the equivalent still.
* **Frame timings are software-rasterised** — see above. Draw calls, triangles,
  programs, geometries and textures are the numbers worth acting on here.

## What the game owes the harness

`tools/capture/` imports nothing from `src/` except `core/` types, and `src/`
imports nothing from here. The entire contract is `window.__XQ`
(`src/core/testapi.ts`), which `src/main.ts` installs:

* `ready()` resolves once the first frame has composited.
* `pause()` then `step(dt)` renders exactly one deterministic frame. `step(0)`
  must re-render without advancing simulation time — the harness calls it before
  every screenshot to guarantee the compositor holds the current frame.
* No update path reads `performance.now()`; every animated value is a pure
  function of the accumulated clock.
* The renderer's canvas lives under `#app` and owns a WebGL2 context.
* The `#veil` boot overlay may exist, but nothing may depend on its fade: the
  driver removes it outright after `ready()` rather than waiting out a 900 ms
  wall-clock transition.
* Methods that are not implemented yet should stay as **empty-bodied stubs**
  (`async () => {}`) rather than throwing or being deleted. That is exactly what
  the capability probe reads, and it is what turns "the harness crashed" into
  "eleven shots skipped, here is why".
