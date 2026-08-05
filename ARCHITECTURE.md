# Architecture

The brief every subsystem author works from. Read `src/core/` first — it is the
contract, and it is already written. Nothing in `src/core/` may be changed
without changing every consumer, so treat it as frozen.

## Ground rules

1. **Zero external assets.** No downloaded meshes, textures, HDRIs, fonts, audio
   or engine libraries. Geometry is parametric, textures are drawn on a canvas
   or evaluated in a shader, animation is keyframe data emitted by code, sound
   is synthesised in Web Audio, and the chess engine is written from scratch.
   `three` is the only runtime dependency, and it ships no content.
2. **Determinism.** Every procedural generator draws from `seedFor(...)` in
   `core/rng.ts`. No `Math.random()` outside a seeded stream, ever. Update paths
   read the clock the harness owns, never `performance.now()` directly. This is
   what makes a captured frame a reproducible measurement.
3. **No per-frame allocation** in `update()` paths. Scratch vectors are module
   level. The GC is the enemy of a locked 60.
4. **Colour comes from `core/palette.ts`.** No literal hex anywhere else.
5. **The HUD is painted into the scene**, never into the DOM. `index.html` has
   exactly one stylesheet and it only blacks out the page.

## Directory ownership

Each directory has one author. Do not write outside your own.

| Path | Owner | Contents |
|---|---|---|
| `src/core/` | *frozen* | Types, coords, palette, rng, noise, bus, contracts, test API |
| `src/engine/` | engine | Position, move generation, rules, Zobrist, eval, search, book, worker, client, tests |
| `src/characters/` | characters | Rig generator, proportions, skinning, parts library, per-unit builders |
| `src/render/` | render | Ramp materials, outlines, composer, Sobel, silk wash, procedural textures |
| `src/anim/` | anim | Clip generation, IK, per-unit animator, capture choreography, pigment dispersal |
| `src/scene/` | scene | Board object, river, palace, lighting, markers, camera director |
| `src/ui/` | ui | In-scene HUD, seal-script glyph outlines, review mode, audio |
| `src/perf/` | perf | Frame governor, adaptive pixel ratio, instrumentation |
| `src/game/` | integration | Match state machine, input, persistence, orchestration |
| `tools/capture/` | harness | Playwright driver, canonical shot list, clip and silhouette capture |
| `tests/` | engine + adversary | Rule suite, perft, evaluation sanity |

## Module graph

```
core  ─────────────────────────────────────────────┐
  │                                                │
  ├── engine (isomorphic: runs on main thread AND in the worker)
  │     └── worker.ts ── client.ts ────────────┐   │
  │                                            │   │
  ├── characters ──┬── render (materials)      │   │
  │                └── anim (rig + clips)      │   │
  ├── scene ───────┴── render                  │   │
  ├── ui ──────────── render                   │   │
  └── perf ────────── render                   │   │
                                               ▼   ▼
                                        game/controller ── main.ts
```

Arrows are the only permitted import directions. `render` never imports
`characters`; `characters` asks `render` for materials through the
`GongbiMaterials` interface it is handed at construction.

## Coordinate and unit conventions

- One board square = **1.0 world unit**. The board surface is **y = 0**.
- Square index `= rank * 9 + file`; rank 0 is Black's back rank at **−Z**,
  rank 9 is Red's back rank at **+Z**. The default camera sits over +Z.
- Units are authored **feet at the origin, facing −Z**, and are scaled at the
  root by `UnitMeta.scale`. The scales in `proportions.ts` are calibrated so the
  cast spans a height ladder of **0.66 (soldier) → 1.32 (general)** world units,
  which is what lets the eye feel piece value without reading a character.
- What governs whether a piece hides its neighbour is **not** its bounding box
  but how far its silhouette reaches from its own intersection — a shape centred
  off its origin crowds one side twice as hard as the box size implies.
  `verify.ts` therefore asserts `reachX < 1.0` and `reachZ < 1.0`. Measured:
  worst `reachX` is 0.57 (cannon) and worst `reachZ` is 0.93 (Chu elephant), so
  every unit is inside its own square across the files, and along the ranks the
  beast and vehicle units lean forward without covering the next intersection —
  presence rather than crowding.
- The ladder above is a contract and `proportions.ts` records how far it can be
  honoured. Both ENDS are exactly on spec; the middle sits 5–13% below a
  proportional restoration, because the Chu elephant is the deepest silhouette
  relative to its own origin in the cast and a proportional increase would take
  its `reachZ` past 1.0. Buying the rest means making that unit shallower, which
  is a change in its builder, not in the table.
- Time is seconds; angles are radians.

## Rendering pipeline order

```
1. depth + normal prepass  → MRT targets (RGBA16F normal, R32F depth)
2. main pass
     a. inverted-hull outlines (BackSide, pushed along smoothed normals)
     b. surface pass (quantised mineral-pigment ramp, silk wash in shadow)
3. post
     a. Sobel over the prepass normals/depth → interior lines only
        (masked against the hull's silhouette so the two never double up)
     b. impact flash / bloomless highlight lift
     c. mood grade toward the current LightMood
     d. paper grain, applied last, at native resolution
```

The hull owns the outer silhouette; Sobel owns interior normal breaks. The Sobel
pass reads a silhouette mask written by the hull pass and suppresses itself
within `hullWidth + 1px` of it. Getting this wrong turns lamellar seams into a
black smear, and it is the first thing the stills critic will name.

## Performance budget (MacBook M-series, Chrome, retina)

| | Budget |
|---|---|
| Frame | 16.6 ms, no spike above 20 ms |
| Draw calls | ≤ 260 with 32 units on screen |
| Triangles | ≤ 900 k |
| Shadow | 3 cascades, 2048², tight splits at 6 / 14 / 34 world units |
| Per-unit triangles | soldier ≤ 9 k, chariot ≤ 32 k |
| Worker | search never touches the main thread; results arrive as messages |

Shared sub-meshes (lamellar plates, rivets, spear shafts, wheel spokes) are
`InstancedMesh`. All units share one `Skeleton` *layout* — the bone hierarchy is
identical, so clips are authored once and retargeted by proportion.

## The test API

`window.__XQ` (see `core/testapi.ts`) is the harness's only entry point. Every
visual subsystem must support:

- `pause()` / `step(dt)` — a frame captured after `step` is deterministic.
- `setNamedPose(name)` — the canonical framings the critics refer to by name.
- `setSilhouette(true)` — flat black units on white, no outlines, no HUD.
- `seekCapture(from, to, t)` — hold the three-beat capture at normalised `t`.
- `showcase(side, unit)` — one unit alone, centred, for character review.

If your subsystem cannot be driven to an exact deterministic frame, the critics
cannot judge it, and it is not done.

## Definition of done, per subsystem

- **engine** — rule suite green, perft matches from every fixture, never emits an
  illegal move, scores stalemate as a **loss**, perpetual check as a loss for the
  checker.
- **characters** — all 32 units nameable from a silhouette-only render.
- **render** — no surface reads as physically based; bands are hard; hull and
  Sobel do not double.
- **anim** — no foot slide, no detached hand, no interpenetration, wheel rotation
  matches ground travel exactly.
- **scene** — the board is a physical object with depth, not a textured plane.
- **ui** — nothing is default HTML; the record reads as a 棋譜.
- **perf** — locked 60 with 32 units and no spike on a capture or a deep search.
