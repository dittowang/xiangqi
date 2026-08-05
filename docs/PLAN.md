# Continuation plan

Written against the original brief, not against what is convenient. The bar
stated there is: *someone watching a screen recording cannot tell it was made in
a browser, and someone playing it never thinks to ask.* Everything below is
ordered by distance from that bar, not by effort.

## Resolved since this plan was written

**P0.1 light rig** — done, and the diagnosis was wrong twice before it was right.
The mid bands were not lost to faceted normals; they were lost to CAST SHADOW.
`uShadowDepth` MULTIPLIES N·L, so every shadowed fragment lands in one lump
regardless of facing. Lacquer now passes 3 of 4 frames, gold 2 of 2, iron 3 of 3.
The board's own classes remain structurally unsplittable — a flat plane under one
directional key is a delta function in N·L — and that is why whole-frame
screenshot histograms mislead on this scene. Per-class is the only instrument.

**P3.1 retina re-baseline** — done, and it invalidated a great deal of earlier
judgement. Ink contours, the 千里江山 backdrop, band steps and silk tooth were
all present and sub-pixel at DPR 1.

**Capture determinism** — done. `__XQ.ready()` used to resolve while the 9.7s
opening march was still running, so the harness inherited it and figures
teleported off-board mid-capture. Two runs of one script went from 0 of 15
byte-identical frames to 11 of 15. Both critics' first batches were contaminated
by this; both re-shot.

**P1 milestone 7** — HUD, review mode, takeback and hint are written and wired.

**Both critic rounds** — run. Round two found, among much else, that the capture
never connected (the spear tip stopped 416mm short of the chest, 42% of a square)
and that the board's lattice did not render at all (the deck was a continuous
sheet lying over every groove). Both fixed and measured.

### A result worth keeping: cadence, not stride

The march read as a scurry, and the obvious fix — lengthen the stride — is
measurably impossible on this cast. The pelvis bob is
`L − √(L² − (ahead·stride)²)`: quadratic in stride, inverse in leg length. These
legs are 43% of stature, so every 20% of extra stride roughly doubles the bob.
At 1.8 leg-lengths the bob is 7.5%, worse than the duck-walk being fixed; at 2.2
the foot lock breaks.

The number that was actually wrong was the cadence, and it was wrong because it
was borrowed from the wrong body. 116 steps/min is the rhythm of a 1.8m
infantryman. **Cadence scales as √(leg length)**, and this figure's leg is a
quarter of a unit, so 176 steps/min is what a short-legged body actually keeps —
and the gait phase comes from ground covered, so retiming the cycle changes speed
and nothing else. Same stride, same plants, same bob. A square went 3.90s → 2.57s
with the bob unchanged at 2.3% and foot slide still exactly 0.

**The residual is the figure-to-square scale, and the number is exact.** One
square is 1.85× a 兵's height, so it needs 6.5 steps to cross where a person
crossing 1.85 statures takes about 4.2. Duration is linear in scale: a 兵 at
1.0u instead of 0.54 crosses in 1.39s with every ratio unchanged. But a uniform
1.85× takes the beast and vehicle units' along-rank reach from 0.85 to 1.57,
which crosses into the next intersection and breaks the crowding rule outright.
So it is a real design trade, not a switch. Note the cast is already ~20% under
its own documented ladder — ARCHITECTURE says 0.66 soldier → 1.32 general,
measured 0.54 → 0.99 — and restoring that alone gives 2.10s.

## Where the project actually stands

Audited, not remembered:

| Milestone | State |
|---|---|
| 1 · 32 characters, idle + walk, silhouette mode | **done** |
| 2 · Engine, legal moves, playable match | **done** — 176 tests, perft matches |
| 3 · Full gongbi pipeline applied | **~60%** — compiles and runs; does not yet read as 工筆重彩 |
| 4 · Combat choreography, three-beat capture | **built, never reviewed in motion** |
| 5 · Board, camera language, opening formation | **board + camera done; formation never called** |
| 6 · Difficulty tiers, opening book, annotation | **engine side done; no UI, `annotate()` never called** |
| 7 · HUD, review mode, audio | **audio done; `src/ui/hud.ts` does not exist; no review mode** |
| 8 · Performance and final polish | **not started; never measured on target hardware** |

`grep -c` in `main.ts`: `formation` 0, `finale` 0, `takeback` 0, `hint` 0,
`annotate` 0. Those are not "wired badly", they are "not wired".

---

## P0 — The surface. This is the heart of the project and it is the biggest gap.

The brief says the art direction *is* the project. Right now the pipeline runs
and the picture does not land. One root cause sits underneath most of it.

### P0.1 Rebuild the light rig so N·L is not bimodal

**The finding.** Measured band occupancy across a real frame: band0 17.3%,
band1 **4.2%**, band2 78.4%, band3 **0.2%**. A four-band ramp is using two bands.
The render author added a tunable `uNdlWrap` and reported honestly that it barely
moved the histogram — because the cause is not in the shader. A single strong key
plus a weak fill drives N·L to the extremes on faceted geometry; there is nothing
in the mid-range for bands 1 and 2 to catch.

**Why it is P0.** Everything else in the art direction is downstream. The wet
lacquer glint lives in band 3 (0.2% occupancy). Gold's razor top band lives in
band 3. Per-class material differentiation cannot appear while two of four bands
are unreachable. Fixing the lighting unblocks three separate defects at once.

**What to do.** This is `src/scene/lighting.ts` working with `src/render/ramps.ts`,
and it must be done as one joint task, not two:
1. Instrument first — dump the actual N·L histogram per material class over a
   full board, not a guess.
2. Add a broad, low-intensity wrap/bounce term so surfaces facing away from the
   key still land in band 1 rather than collapsing to band 0. Gongbi is lit
   like a painted illustration, not like a photograph: it wants *even* light with
   hard steps, not dramatic falloff with soft steps.
3. Re-cut `RAMPS[*].thresholds` against the measured histogram rather than
   against intuition.

**Acceptance.** Every four-band class shows ≥12% occupancy in each of bands 1 and
2 over a full-board capture, and band 3 is ≥3% on `lacquer`, `gold` and `iron`.
Measured from a real frame, at `setQuality('ultra')`.

### P0.2 Make the material classes read as different substances

Currently everything reads as one material in different colours. `RampSpec`
already carries `accent`, `rim`, `silkWash` and per-class thresholds; the critic
verified they are not reaching the fragment. Unblocked by P0.1.

**Acceptance.** In a `portrait` capture of the cannon, a critic can name
lacquer, timber, rope, iron and stone without being told which is which.

### P0.3 Silk ground and pigment granulation

The wash fix landed (lit surfaces now keep a 34% floor, tooth modulation ±13
sRGB levels) but has only been seen under software rasterisation at DPR 1.

**Acceptance.** A 30-pixel scan across empty board varies by ≥12 sRGB levels;
the weave does not moiré at retina; it reads as ground, not as a filter.

### P0.4 The file lines still dot

Rank lines render solid, file lines dot, at identical width and depth. The scene
author proved it is invariant to width, to analytic wall normals and to shadow
receipt — so it is orientation-dependent shading or a post-process on
near-vertical thin features, downstream of the mesh. `board-diagnose-sobelOnly.png`
is 3.7 kB, i.e. almost empty, which is the thread to pull.

---

## P1 — The missing milestone: HUD, review, assistance

Milestone 7 is genuinely absent, and the brief specifies it in detail. This is
the largest volume of unwritten code left.

### P1.1 `src/ui/hud.ts` — painted into the scene, never DOM

- Vertical move record in seal script down one side, reading as a 棋譜.
  `src/ui/seal.ts` already provides `drawText(..., {vertical: true})` and the
  numerals and 進/退/平 needed for traditional notation. `moveToNotation()`
  already produces the strings.
- Captured pieces along the board edge **as fallen figures, not icons** — reuse
  `characters.create()` at reduced scale, laid on their side.
- Evaluation bar as ink bleeding across silk toward the losing side. Feed from
  the existing `bus.on('eval')`.
- Difficulty tier and turn indicator.

**Acceptance.** No DOM node is added outside the existing canvas; a critic
cannot identify a default UI widget anywhere in a capture.

### P1.2 Review mode

`src/game/annotate.ts` is written and unused. It needs: step backward through
the match, call `engine.analyse()` on the position before each ply, feed the
pair into `annotate()`, and show the engine's preferred line. The mate constants
already agree between `annotate.ts` and the engine.

### P1.3 Takeback, hint, difficulty selection

All three have engine support and no UI. `hint` is `engine.analyse(fen, 800)`.
Takeback needs `Match` to unwind two plies and `choreographer.abort()`.

---

## P2 — Motion. Nobody has looked at it yet.

The brief demanded a motion critic and it has never run. `seekCapture` is live
and the harness composes contact sheets, so the tooling exists.

### P2.1 Run the motion critic

Capture the three-beat exchange at 16 samples for every attacker/defender pair,
plus one full walk cycle per gait, as contact sheets. Judge: impact timing,
weight, contact integrity, whether the flash resolves before or after the hit.

**Known defects the animator predicted and nobody has confirmed or denied:**
- Quadruped legs have no contact solve — hoof slide on the canter is expected.
- Mounted deaths slump the rider without felling the mount.
- The chariot's 戟 clears the 軾 by 0.06h at rest; an animator swinging that arm
  will close it.
- The Chu horse's 戟 butt clears the neck by 0.06–0.08h — same character of risk.

### P2.2 Wire the dramatic shape

`choreographer.formation()` and `.finale()` are written and never called. The
brief specifies opening march-in (8–12s, skippable), phase-driven camera and
light, and a terminal set piece. `rig.setPhase()` already moves camera framing
and light mood together.

---

## P3 — Verification the project has never had

### P3.1 Capture at retina, and at `ultra`

Every frame reviewed so far was DPR 1 and — until this week — `sobel: false`.
Screen-space line weight scales with pixel ratio *by design*, so no
stroke-weight judgement made so far is trustworthy.

**Do this first in any future session.** It is cheap and it invalidates or
confirms a lot of prior work.

### P3.2 Measure on the target hardware

No performance figure in this repository was taken on an M-series Mac. 60fps is
currently an architectural argument — 309 draw calls across five passes, one
material for the whole cast, allocation-free update paths — not a measurement.
Run `__XQ.stats()` on the real machine and report `worstMs` during a capture
animation and immediately after a hard-tier search returns.

### P3.3 Close the `@types/node` gap

`tools/` typechecking is currently vacuous — a syntax error anywhere makes `tsc`
skip semantic analysis program-wide, so `tools/` reports zero errors while being
unchecked. Add `@types/node` and re-verify.

---

## P4 — Engine strength, if wanted

Currently 77–95k n/s, depth 7–8 on hard. The author identified the remaining
2–3×: incremental mobility, or a cached evaluation keyed on a structure hash.
Neither was attempted. Aspiration windows, LMR and null-move R have no SPRT
behind them; `tests/qcheck-match.test.ts` is a working match harness that can
settle them properly.

Also unresolved and honestly documented: mutual perpetual check has no fixture,
because every legal construction either has both generals attacked at once or
breaks the cycle. That branch is exercised by argument only.

---

## Suggested order for the next session

1. **P3.1** — recapture at retina + ultra. One hour, and it re-baselines everything.
2. **P0.1** — the light rig. Highest leverage single fix in the project.
3. **P0.2 / P0.3** — material differentiation and silk, both unblocked by P0.1.
4. **P2.1** — motion critic, in parallel with the above (different subsystem).
5. **P1.1** — HUD, the largest remaining volume.
6. **P1.2 / P1.3 / P2.2** — review, assistance, dramatic shape.
7. **P3.2** — measure on target hardware before claiming anything about 60fps.

## A process note worth keeping

Four times this build, a defect diagnosed confidently from a frame had a
different cause, found only by measuring: the "missing" outlines were present at
1.31 device pixels; the "broken" backdrop was correctly authored and out of shot
behind an unlit terrace; the "missing" anatomy was occlusion; the
"over-saturated" silk had the correct hue and zero texture.

And the worst was procedural: a quality tier silently disabled the thing being
judged, so every critic reviewed a build that was not the build. **Before
believing any visual conclusion, confirm the capture was taken at the settings
the conclusion assumes.**
