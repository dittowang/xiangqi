# `src/characters/units/` — the unit-author contract

Seven files live here, one per piece type, one author each:

```
soldier.ts   advisor.ts   general.ts   cannon.ts   horse.ts   elephant.ts   chariot.ts
```

Nothing else. No shared helpers, no `common.ts` — if two units need the same
thing it belongs in `../parts/`, and the parts author adds it.

Until a file lands, its type is built by the **generic fallback** in
`../fallback.ts`. That fallback is a real figure with real armour, a real mount
and real weapons, not a placeholder — read it before you start. It is the
shortest complete example of everything below.

---

## 1. What you write

```ts
// src/characters/units/soldier.ts
import { PieceType } from '@core/types.ts';
import { registerUnit, type UnitBuildContext } from '@characters/factory.ts';
import type { PartGroup } from '@characters/parts/types.ts';

function buildSoldier(ctx: UnitBuildContext): PartGroup { … }

registerUnit(PieceType.Soldier, buildSoldier);
```

Then add **one line** to `src/characters/index.ts`, in the block marked
`Unit registration`:

```ts
import './units/soldier.ts';
```

That is the whole registration contract. `factory.ts` never imports your file.

### `UnitBuilder`

```ts
type UnitBuilder = (ctx: UnitBuildContext) => PartGroup;
```

### `UnitBuildContext`

| field | type | what it is |
|---|---|---|
| `side` | `Side` | `Side.Red` = Han, `Side.Black` = Chu |
| `type` | `PieceType` | your piece type |
| `key` | `UnitKey` | `'soldier'`, `'horse'`, … |
| `variant` | `number` | 0-based; five soldiers per side means variants 0…4 |
| `spec` | `UnitSpec` | proportions, mount kind, gait, design record, silhouette targets, triangle budget |
| `rig` | `Rig` | the skeleton, already built from `spec.proportions` |
| `rng` | `Rng` | seeded from `(unit, side, variant)` — **never** `Math.random()` |
| `parts` | the parts library | `ctx.parts.body`, `ctx.parts.lamellar`, … |
| `materials` | `GongbiMaterials` | you almost certainly do not need this |
| `useRig(options)` | `(RigOptions) => Rig` | rebuild the rig lifted / re-posed; call it **before** building geometry |

`spec.design` is the costume brief, fixed centrally so the cast stays coherent:

```ts
{ crown: { tag, helmet, crest, crestScale },
  primary, offhand,            // WeaponKind in each hand
  back,                        // 'none' | 'standard' | 'quiver'
  hip,                         // 'none' | 'sword' | 'dao'
  armour,                      // 0..1 lamellar coverage
  robe,                        // 0..1 hem length
  cloak }                      // boolean
```

You may reinterpret the *look* of these freely. Do not change **which** crown
tag your unit wears — that is a silhouette contract, not a costume choice.

### `PartGroup` — what you return

```ts
interface PartGroup {
  parts: Part[];              // one geometry each
  instanced: InstancedPart[]; // one geometry + N transforms
  points: Record<string, THREE.Vector3>;  // published landmarks, rig space
  bones: BoneSpec[];          // extra bones for a mount or vehicle
  attach: AttachSpec[];       // sockets other subsystems hang things from
}
```

Build it with `ctx.parts.emptyGroup()` and `ctx.parts.mergeGroups(a, b, …)`.

### `Part`

```ts
interface Part {
  geometry: THREE.BufferGeometry; // rig space, see §2
  cls: MaterialClass;             // how it quantises light
  pigment: PartPigment;           // palette slot or an explicit pigment
  boneHint: BoneName;             // its anchor in the skeleton
  name?: string;
  rigid?: boolean;                // 100% weight to boneHint
  mountBone?: string;             // rigid on a mount bone instead, or
                                  // STATIC_BONE for furniture (see §3)
  allow?: BoneName[];             // extra bones allowed to influence it
  noSilk?: boolean;               // opt out of the silk-weave shadow wash
}
```

`pigment` is normally a **slot** — `'lacquer' | 'cloth' | 'leather' | 'metal' |
'accent'` — resolved against the army palette by the factory, so one part
function serves both armies. Use an explicit `PigmentName` only for substances
that are the same in both armies: flesh (`'ochre'`), hair (`'ink'`), bone and
tusk (`'shellWhite'`), stone, timber.

`cls` is a `MaterialClass` from `@core/palette.ts`:
`lacquer | cloth | leather | gold | ivory | timber | stone | silk | flesh |
hair | iron`.

---

## 2. Space, units and orientation

- **Rig space.** Feet at `y = 0`, facing **−Z**, character's **right is +X**.
- **Rig units**, not world units. One rig unit is one unit of
  `spec.proportions.height`. The factory applies `spec.proportions.scale` at the
  root; never apply it yourself.
- Everything you publish — geometry, `points`, `BoneSpec.position`,
  `AttachSpec.position` — is in rig space. The factory rebases into bone-local
  space for you.
- A mounted unit's rig is **lifted**: call `ctx.useRig({ origin: [x, seatY, z] })`
  and every metric in `rig.metrics` moves with it. `y = 0` still means the
  ground; it just is not where the rider's feet are.

### The rig

Twenty bones, exactly `BONE_ORDER` from `@core/contracts.ts`, in that order.
**Bind rotations are identity** — a bone's local axes are the rig's axes. The
bind pose is a relaxed A-pose with pre-broken elbows and knees.

Useful members:

| member | what |
|---|---|
| `rig.bindWorld[bone]` | bind-pose position of every bone, rig space |
| `rig.metrics` | `hipY`, `waistY`, `chestY`, `shoulderY`, `headY`, `headTopY`, `ankleY`, `kneeY`, `headLen`, `neckLen`, `torsoLen`, `legLen`, `thighLen`, `shinLen`, `footLen`, `upperArmLen`, `foreArmLen`, `handLen`, `armLen`, `shoulderWidth`, `hipWidth`, `waistWidth`, `chestWidth`, `stanceWidth`, `chestDepth`, `waistDepth`, `hipDepth`, `headWidth`, `headDepth`, `upperArmR`, `foreArmR`, `thighR`, `shinR`, `neckR`, `handR`, `bulk`, `topHeaviness`, `stance`, `height`, `scale` |
| `rig.bindLengths[bone]` | bone → primary child distance |
| `rig.segments[bone]` | `{ a, b, r }` — the capsule the skinner uses |

`RigOptions` for `useRig`:

```ts
{ origin?: [x, y, z],                       // lift/move the whole skeleton
  offsets?: Partial<Record<BoneName, [x,y,z]>> }  // move a bone AND its subtree
```

`offsets` is how you author a seated bind pose: offset `shinL/R` to place the
knees and `footL/R` to place the ankles. Do **not** offset `thighL/R` for a
seated pose — that moves the hip joint too. The fallback's `strideOffsets()`
does exactly this and is worth copying.

### Orientation is guaranteed, not your problem

Five inside-out-geometry bugs were found and fixed in the shared library. The
guarantees you can now rely on:

- **`prim.loft()` is ring-order independent.** It measures the orientation of
  the stack and reverses the rings if they were wound the other way, so a skirt
  lofted waist-to-hem, a hoof lofted downward and a canopy lofted apex-to-rim
  all come out solid-side-out. `sweep()` and `hardLathe()` go through it, so
  they inherit the fix.
- **`prim.shell({ flip: true })` is safe.** `flip` chooses which side of the
  authored surface the thickness is added to; it now reverses the winding of
  every face as well as the offset direction, so both settings produce a
  correctly-oriented solid.
- **`prim.bevelSlab()` faces outward.** Both rings run counter-clockwise seen
  from +Z. This is the lamellar plate, so it was every plate in the game.
- **`vehicle.spokedWheel()` fans its spokes** about X, in the wheel plane.
- **`prim.mirrorX()` re-winds.** Never mirror by negating X yourself.

If you build geometry by hand with `MeshBuilder`, `verify.ts` will tell you if
you got the winding wrong — see §8.

---

## 3. Skinning — what the factory does with `boneHint`

You never call the skinner. The factory does, and `boneHint` controls it:

- **`rigid: true`** → 100% of the weight on `boneHint`. Correct for anything
  physically rigid: helmets, boots, hands, blades, plates. Cheaper, and it can
  never bleed.
- otherwise → weights are solved from a bone distance field, restricted to
  bones within two graph steps of `boneHint`, masked by each bone's capsule
  radius. A part hinted at `clavicleR` **cannot** be influenced by `foreArmR`,
  whatever the A-pose puts next to it. Use `allow: [...]` to widen it (a long
  cloak wants `pelvis`).
- **`mountBone: 'horse.legFL02'`** → rigid on a mount bone. Geometry still in
  rig space; the factory handles the rest.
- **`mountBone: STATIC_BONE`** (or `pinStatic(group)`) → pinned to the **unit
  root** instead of to the skeleton, so no clip, IK pass or contact correction
  can move it. This is for *furniture the figure stands on*, not for anything it
  wears: the 帥's command dais is the case it exists for. Bound to `root` — the
  obvious choice, and the wrong one — it followed the bone every clip writes its
  root translation to, and the death collapse's 238 mm drop took the platform
  under the board with the body. It still travels and turns with the piece,
  because it hangs off the unit root; it just does not listen to the skeleton.
  Costs no extra draw call: the geometry merges into the unit's skinned mesh as
  usual, weighted to a bone that never moves.

Measured deformation at a 90° bend, from `verify.ts` (1.00 = no loss):
shoulder **0.879**, elbow **0.943**, hip **0.909**, knee **0.898**. If a part
you author measures worse than ~0.7 there, it is hinted wrong.

---

## 4. Attachment sockets

Populate `attach` with everything your unit can carry. The factory turns each
into an `Object3D` under the named bone and exposes it as
`UnitInstance.attach[name]`.

| socket | who needs it | required for |
|---|---|---|
| `gripR` | anim (weapon IK, capture beats) | **all** |
| `gripL` | anim (off hand, shield, reins) | **all** |
| `haftTip` | anim (polearm IK target), ui | all polearm carriers |
| `crest` | anim (helmet ornament sway) | all |
| `back` | scene / anim (standard, quiver) | general, chariot |
| `hip` | anim (scabbard) | advisor, general, horse, chariot, cannon |
| `mountSeat` | anim (rider pelvis) | horse, elephant, chariot |
| `reinL`, `reinR` | anim (hand IK to the reins) | horse, chariot |
| `muzzle` | anim + fx (projectile origin) | cannon |
| `trunkTip` | anim (trunk end effector) | elephant |

```ts
g.attach.push({ name: 'haftTip', bone: 'handR', position: [x, y, z] });
```

**Convenience:** if you publish `points.gripR`, `points.gripL`, `points.crest`
or `points.trunkTip` and do not declare the matching socket, the factory
creates it for you. `body.hand()` publishes the grips already, so most units
get `gripL`/`gripR` for free. Everything else you must declare.

### Mount bones

```ts
g.bones.push({
  name: 'chariot.wheelL',
  parent: 'chariot.body',       // another mount bone, a BoneName, or null (= root)
  position: [x, y, z],          // RIG SPACE — the factory rebases it
  rotation: [0, 0, 0],
  data: { radius: 0.558 },      // published to bone.userData
});
```

Order does not matter; parents are resolved iteratively. Mount bones join the
same `Skeleton` after the twenty humanoid bones, so parts on them are skinned
rather than parented — that is what keeps a horse at two draw calls instead of
twenty.

**Contract:** a wheel MUST publish `data.radius`, in rig units. The animator
computes `Δθ = Δs / (radius · scale)`; without it, wheels skid.

---

## 5. Triangle budgets

| unit | budget | shipped cast (worst army) | headroom |
|---|---|---|---|
| soldier | 9 000 | 4 258 | 53% |
| advisor | 11 000 | 2 428 | 78% |
| general | 16 000 | 8 682 | 46% |
| cannon | 24 000 | 10 104 | 58% |
| horse | 20 000 | 8 577 | 57% |
| elephant | 26 000 | 5 940 | 77% |
| chariot | 32 000 | 10 214 | 68% |

The factory warns through `onWarn` when you exceed your budget. It does not
stop you — but the perf author's 900 k board total is not negotiable, and a
full board of the current cast is **194 k**.

Costs to budget against, measured:

| thing | triangles |
|---|---|
| one lamellar plate | 12 |
| one lacing bar | 10 |
| one rivet | 16 |
| whole naked figure (`body.figure`) | 916 |
| head with beard and topknot | 204 |
| 兜鍪 helmet with lappets and rivets | 464 |
| crowned helm | 608 |
| 步搖 crest | 812 |
| 5-row cuirass (120 plates + lacing) | 1 320 |
| 3-row armoured skirt | 1 056 |
| cloak | 296 |
| 戈 dagger-axe | 316 |
| 劍 sword | 294 |
| horse with barding and tack | 1 327 |
| elephant with howdah and 9-segment trunk | 1 438 |
| chariot with canopy and two 26-spoke wheels | 2 842 |
| 砲 trebuchet | 482 |
| one 26-spoke wheel | 852 |
| Han or Chu standard with streamers | 480 |

### Draw calls — read this

`main.ts` runs the factory with `atlasMaterial` set, which collapses each unit
to **one merged mesh drawn with one material** — `aMaterial` carries the
material class and pigment per vertex and the renderer's ramp shader decodes it.
Measured on the shipped cast: a 32-unit board is **32 meshes, 64 draw calls,
1 material**. That is the configuration that runs.

Without an atlas material the factory falls back to one mesh per
`(MaterialClass, PigmentName)` pair — the current cast uses 7–12 pairs per unit,
giving **295 meshes / 590 draw calls** for a board against a 260 budget. So the
pair count still matters if the atlas path is ever turned off, and it always
costs vertex-attribute variety even when it does not cost a draw call.

Practical rules:

- Prefer an existing pair over a new one. `iron`+`metal` and `gold`+`metal` are
  two different materials; pick one and stay with it.
- `cuirass()` and `skirtArmour()` take `cordPigment` / `cordCls`. The default
  lacing pigment is `'accent'`, which is a whole extra pair for a few hundred
  triangles of cord — set it to `'lacquer'` and the lacing folds into the plate
  bucket.
- `main.ts` passes `bakeInstancesBelow: 64`, so instance sets under 64 are baked
  into the mesh they share a material with. Sets of 64 or more stay their own
  `InstancedMesh` — which the atlas cannot merge, so a very large plate array
  costs a draw call. Nothing in the current cast hits that.

---

## 6. Silhouette requirements

Your unit must be nameable from a flat black shape on white. Three axes, and
your unit's values are fixed in `../proportions.ts`:

| unit | height (world) | aspect | width class | crown tag |
|---|---|---|---|---|
| soldier | 0.63 | 0.48 | narrow | `plumed-doumou` |
| advisor | 0.69 | 0.60 | narrow | `soft-cap` |
| cannon | 0.81 | 1.68 | wide | `hooded` |
| chariot | 0.90 | 1.35 | wide | `fan-crest` |
| horse | 0.97 | 1.38 | wide | `horned` |
| elephant | 1.05 | 1.12 | wide | `turbaned` |
| general | 1.26 | 0.61 | medium | `crowned-buyao` |

- **Height** is the full bounding-box height *including* crest, mount and
  anything carried. Keep within 30% of the target or the factory warns.
- **Aspect** is `max(width, depth) / height`.
- **Width class** bands the absolute footprint: narrow < 0.6, medium 0.6–1.1,
  wide > 1.1 world units.
- **Crown** is the headgear tag. Yours is unique in your army and must stay
  that way. It is the axis that survives when the other two collide.

### Your unit has to fit the board

One square is **1.0** world unit. The numbers above are small because the first
full-board render was unreadable: elephants and chariots measured three squares
deep and Black's back rank was a wall of overlapping mass. What the whole cast
now holds to, and what `verify.ts` asserts:

- **`reachX` < 0.5** — no piece extends past its own square across the files.
  Neighbours on a rank are 1.0 apart in X, so this is the axis that hides
  pieces, and it is held absolutely.
- **`reachZ` < 0.85** — the beast and vehicle units lean up to 0.85 forward,
  which stops 0.15 short of the next rank's intersection. Leaning reads as
  presence; covering an intersection destroys the position.
- **lowest point ≥ 0** — `main.ts` stands each figure on a plinth top at
  y = 0.046. Anything below zero in your unit's own space sinks through it.

`reach` is measured from the unit's **origin**, not as a bounding-box size,
because a silhouette centred off its origin crowds one side twice as hard.

**Your aspect ratio sets your height.** Every builder sizes its mount as a
multiple of `proportions.height`, so `scale` and `height` are both uniform
multipliers and neither can change your aspect — that is fixed by your geometry.
A unit with aspect 1.68 that must fit inside `reachZ` 0.85 is 0.81 tall, and no
scale makes it both compact and towering. If your unit wants to be taller, it
has to get *proportionally shorter front-to-back* — that is a change in your
file, not in `proportions.ts`.

Rule the readability critic enforces: *no two units in the same army may share
both aspect class and crown tag.* `verify.ts` asserts it.

Other things that must hold:

- Han and Chu are two armies, not one tinted twice. `proportions.ts` already
  makes Han figures shorter, thicker and squarer and Chu figures taller,
  leaner and more forward-leaning. Reinforce it in your costume — Han rolled
  brims and square pennants, Chu peaks and swallow-tails.
- Nothing may be a smooth capsule. Facet counts of six and eight, rings placed
  where the silhouette turns, and a hard crease at every ring.
- A polearm's butt must not go below `y = 0`. See `groundedGrip()` in
  `../fallback.ts`.

---

## 7. The parts library

Everything reachable as `ctx.parts.<module>.<fn>`. Every function takes one
options object. Returns are `Part` (one geometry), `PartGroup` (several) or a
bare `BufferGeometry` (a building block).

### `parts.prim` — primitives

| function | signature |
|---|---|
| `ring` | `({ rx, rz?, y?, cx?, cz?, sides?, phase?, squareness?, backFlatten? }) → V3[]` |
| `rectRing` | `(hx, hz, y, cx?, cz?) → V3[]` |
| `loft` | `(rings: V3[][], { capStart?, capEnd?, closed?, name? }) → BufferGeometry` |
| `prism` | `({ rx0, rz0?, rx1?, rz1?, y0?, y1, dx?, dz?, sides?, phase?, squareness?, capStart?, capEnd?, name? }) → BufferGeometry` |
| `strut` | `(from: V3, to: V3, r0, r1?, sides?, squareness?) → BufferGeometry` |
| `bevelSlab` | `({ w, h, d, bevel?, bevelX?, backFace?, crown?, anchor?, name? }) → BufferGeometry` — `anchor` is `'centre'` (default) or `'back'` |
| `hardLathe` | `(profile: V2[], segments?, { capStart?, capEnd?, phase?, squareness?, name? }) → BufferGeometry` |
| `extrudePlanar` | `(poly: V2[], { depth, chamfer?, chamferIn?, capFront?, capBack?, name? }) → BufferGeometry` — concave-safe |
| `bladeGeometry` | `({ outline: V2[], thickness, fuller?, fullerWidth?, edgeBevel?, offset?, name? }) → BufferGeometry` |
| `sweep` | `(stations: { p, rx, rz?, phase?, squareness?, section? }[], { sides?, capStart?, capEnd?, up?, name? }) → BufferGeometry` |
| `shell` | `(grid: V3[][], thickness, { name?, flip? }) → BufferGeometry` — gives an open surface real thickness |
| `insetPolygon` | `(poly: V2[], d) → V2[]` |
| `mirrorX` | `(g) → BufferGeometry` (re-winds; never just negate X) |
| `place` | `(g, { pos?, rot?, scale? }) → g` |
| `matrix` | `(pos, rot?, scale?) → Matrix4` |
| `mergeGeometryList` | `(list) → BufferGeometry` |
| `addSmoothNormals` | `(g, weld?) → g` (the factory does this for you) |
| `triangleCount`, `bounds`, `assertFinite` | diagnostics |
| `MeshBuilder` | `.tri() .quad() .fan() .strip() .polygonXY() .build()` |

### `parts.body`

| function | returns | signature |
|---|---|---|
| `torso` | `Part` | `({ hipY, waistY, chestY, shoulderY, hipWidth, waistWidth, chestWidth, shoulderWidth, hipDepth, waistDepth, chestDepth, neckR, sides?, squareness?, pigment?, cls? })` |
| `neck` | `Part` | `({ fromY, toY, r, sides? })` |
| `head` | `PartGroup` | `({ baseY, length, width, depth, z?, beard?, ears?, topknot? })` → publishes `crown`, `face` |
| `limb` | `Part` | `({ from, to, r0, r1, bulge?, bulgeAt?, sides?, squareness?, boneHint, cls?, pigment?, name?, flatten? })` |
| `arm` | `PartGroup` | `({ side, shoulder, elbow, wrist, upperR, foreR, sides?, cls?, pigment?, deltoid? })` |
| `leg` | `PartGroup` | `({ side, hip, knee, ankle, thighR, shinR, sides?, cls?, pigment? })` |
| `hand` | `PartGroup` | `({ side, wrist, length, r, pose?, gripR?, cls?, pigment? })` → publishes `gripL`/`gripR` |
| `boot` | `PartGroup` | `({ side, ankle, length, width, shaft?, cls?, pigment? })` |
| `figure` | `PartGroup` | `({ metrics, bind, torsoPigment?, torsoCls?, bootShaft?, beard?, topknot?, handPose?, deltoid? })` — the whole naked figure |

`hand({ pose: 'fist' })` bores a real grip cylinder along **+Y**. Every weapon
is authored haft-along-+Y with its grip at the origin, so a weapon placed at the
published grip point genuinely passes through the fist.

### `parts.helmet`

| function | returns | signature |
|---|---|---|
| `helmet` | `PartGroup` | `({ style, baseY, headLen, headWidth, headDepth, z?, cheeks?, nape?, rivets?, pigment?, metalPigment?, clothPigment? })` → publishes `crest`, `top`, and `buyaoL`/`buyaoR` on the crowned helm |
| `crest` | `PartGroup` | `({ style, at, height, width, pigment?, metalPigment?, anchors? })` |

`style`: `hanDoumou | chuPeaked | softCap | crownedHelm | hood | turban | fanCrown`.
Crest `style`: `none | plume | hornPair | fanCrest | standardSocket | buyao`.

### `parts.lamellar`

| function | returns | signature |
|---|---|---|
| `lamellarPlate` | `BufferGeometry` | `({ w, h, d, bevel?, crown?, backFace? })` — one plate, 12 tris |
| `lamellarBand` | `PartGroup` | `({ rows: LamellarRow[], plate, boneHint, pigment?, cls?, cord?, cordPigment?, cordCls?, cordScale?, name? })` — the general primitive |
| `cuirass` | `PartGroup` | `({ fromY, toY, rx0, rx1, depthRatio?, rows?, perRow?, lowerBone?, upperBone?, cord?, cordPigment?, cordCls?, pigment?, thickness? })` |
| `skirtArmour` | `PartGroup` | `({ topY, bottomY, rxTop, rxBottom, depthRatio?, rows?, perRow?, frontGap?, pigment?, bone?, cord?, cordPigment?, cordCls? })` |
| `pauldron` | `PartGroup` | `({ side, shoulder, r, rows?, perRow?, pigment? })` |
| `tubeArmour` | `PartGroup` | `({ bone, from, to, r, rows?, perRow?, pigment?, arc?, facing? })` — bracers, greaves |
| `neckGuard` | `PartGroup` | `({ y, r, height, count?, pigment? })` |
| `bandCost` | `number` | `(group)` — triangles a band will cost |

`LamellarRow` = `{ y, rx, rz?, cx?, cz?, count, arc?, arcCentre?, tilt?, scale?, bone? }`.
Rows sharing a bone share one `InstancedMesh`. Split rows across spine bones so
the harness creases where the torso does.

### `parts.cloth`

| function | returns | signature |
|---|---|---|
| `pleatSection` | `V2[]` | `(folds, rOuter, rInner, { squash?, phase? })` |
| `pleatedRing` | `V3[]` | `(folds, rOuter, rInner, y, { squash?, phase?, cx?, cz? })` |
| `skirt` | `Part` | `({ topY, hemY, rTop, rHem, squash?, folds?, foldDepth?, vents?, pigment?, cls?, bone?, name? })` |
| `robe` | `PartGroup` | `({ shoulderY, waistY, hemY, shoulderR, waistR, hemR, squash?, folds?, pigment?, name? })` |
| `sleeve` | `Part` | `({ side, shoulder, elbow, wrist, r0, r1, folds?, length?, pigment? })` |
| `sleeves` | `PartGroup` | `(base, left, right)` |
| `sash` | `PartGroup` | `({ y, rx, rz, height, tail?, pigment?, bone?, knot? })` |
| `collar` | `PartGroup` | `({ shoulderY, chestY, rx, rz, pigment?, width? })` — 交領 |
| `cloak` | `Part` | `({ shoulderY, hemY, rTop, rHem, z, folds?, foldDepth?, flare?, pigment?, thickness? })` |
| `legWrap` | `Part` | `({ side, knee, ankle, r, turns?, pigment? })` — 行縢 |
| `shoulderCape` | `Part` | `({ shoulderY, r, drop, folds?, pigment? })` |

### `parts.weapons`

All extend `WeaponBase` = `{ grip: V3, rot?: V3, bone?, mountBone?, pigment?, metalPigment?, scale? }`
and publish `tip` (and usually `butt`/`head`) in rig space.

| function | signature beyond `WeaponBase` |
|---|---|
| `haft` | `({ below, above, r, buttTaper?, headTaper?, sides?, rings?, pigment?, metalPigment?, boneHint? })` — grip space, not placed |
| `bindingRings` | `({ from, to, count, r, boneHint, pigment? })` |
| `blade` | `({ length, halfWidth, thickness, fuller?, y0?, singleEdged?, pigment?, boneHint?, name? })` |
| `spear` 矛 | `({ length, gripAt?, headLength?, shaftR? })` |
| `ge` 戈 | `({ length, gripAt?, shaftR?, bladeLength? })` |
| `ji` 戟 | `({ length, gripAt?, shaftR?, bladeLength?, headLength? })` |
| `sword` 劍 | `({ length, halfWidth?, reversed? })` |
| `dao` 刀 | `({ length, halfWidth? })` |
| `axe` 鉞 | `({ length, gripAt?, headWidth?, shaftR? })` |
| `baton` 節 | `({ length, gripAt?, shaftR?, tiers? })` |
| `bow` 弓 | `({ length, depth?, strung? })` — publishes `nock` |
| `shield` 盾 | `({ height, width, curve? })` |
| `quiver` | `({ length, r, arrows? })` |
| `scabbard` | `({ length, width })` |

### `parts.standard`

| function | returns | signature |
|---|---|---|
| `flagpole` | `PartGroup` | `({ base, length, r, lean?, leanAxis?, boneHint?, mountBone?, pigment?, metalPigment?, finial?, rings? })` |
| `banner` | `PartGroup` | `({ shape, at, height, width, fly?, wave?, phase?, boneHint?, mountBone?, pigment?, thickness? })` |
| `streamers` | `PartGroup` | `({ at, count, length, width, spread, wave?, boneHint?, mountBone?, pigment? })` — 旒 |
| `standard` | `PartGroup` | `({ shape, base, poleLength, poleR, bannerHeight, bannerWidth, lean?, fly?, boneHint?, mountBone?, clothPigment?, polePigment?, metalPigment?, streamerCount?, phase? })` |

`shape` is `'hanSquare'` for Red and `'chuSwallowtail'` for Black. Do not swap them.

### `parts.mount`

| function | returns | signature |
|---|---|---|
| `quadrupedLeg` | `PartGroup` | `({ prefix, parent, joints: [V3,V3,V3,V3], radii: [n,n,n,n], sides?, cls?, pigment?, hoofPigment?, hoofHeight?, flatten? })` — creates `<prefix>01..04` |
| `horse` | `PartGroup` | `({ withers, length, width?, at?, hidePigment?, manePigment?, barding?, harnessPigment?, metalPigment?, sides? })` |
| `elephant` | `PartGroup` | `({ shoulder, length, width?, at?, hidePigment?, tuskPigment?, trunkSegments?, howdah?, howdahPigment?, metalPigment?, clothPigment? })` |
| `howdah` | `PartGroup` | `({ y, z, hw, depth, height, pigment?, metal?, cloth? })` |
| `mirrorMount` | `PartGroup` | `(group)` |

`horse` bones: `horse.spine`, `horse.chest`, `horse.neck`, `horse.head`,
`horse.tail01..03`, and `horse.legFL01..04` / `legFR` / `legHL` / `legHR`.
Publishes `seat`, `withers`, `croup`, `muzzle`, `reinL`, `reinR`, and the
`mountSeat` / `reinL` / `reinR` sockets.

`elephant` bones: `elephant.spine`, `.chest`, `.neck`, `.head`, `.tail`,
`.earL`, `.earR`, `.trunk01..NN` (≥ 8, straight in bind pose so a sweep can go
either way), and four `legXX01..04` chains. Publishes `trunkTip`, `seat`,
`withers` and the `trunkTip` / `mountSeat` sockets.

### `parts.vehicle`

| function | returns | signature |
|---|---|---|
| `spokedWheel` | `PartGroup` | `({ at, radius, width, spokes?, side?, timberPigment?, metalPigment?, mountBone })` |
| `chariot` | `PartGroup` | `({ wheelRadius, track, carWidth, carDepth, railHeight, poleLength, canopyRadius?, canopyHeight?, at?, timberPigment?, lacquerPigment?, metalPigment?, clothPigment?, spokes? })` |
| `trebuchet` | `PartGroup` | `({ pivotHeight, armLength, buttLength, spread, sledLength, at?, timberPigment?, metalPigment?, clothPigment?, lacquerPigment?, armAngle? })` |

`chariot` bones: `chariot.body`, `chariot.wheelL`/`wheelR` (**both carry
`data.radius`**), `chariot.pole`, `chariot.canopy`. Publishes `seat`,
`reinL`/`reinR`, `canopyTop`.

`trebuchet` bones: `treb.base`, `treb.pivot`, `treb.beam` (rotate this to
throw), `treb.weight`, `treb.sling`. Publishes `muzzle`, `pivot`, `armTip`.

### `parts.rivets`

| function | returns | signature |
|---|---|---|
| `rivetGeometry` | `BufferGeometry` | `({ r, h, sides?, dome? })` — 16 tris, base at origin, +Y |
| `studGeometry` | `BufferGeometry` | `({ w, h, bevel? })` |
| `rivetLine` | `PartGroup` | `({ from, to, count, normal?, boneHint, pigment?, cls?, rivet?, geometry?, name?, mountBone? })` |
| `rivetArc` | `PartGroup` | `({ centre, rx, rz?, count, arc?, arcCentre?, tilt?, … })` |
| `rivetGrid` | `PartGroup` | `({ corners: [V3,V3,V3,V3], rows, cols, inset?, … })` |
| `buckle` | `Part` | `({ at, w, h, thickness, boneHint, pigment?, rot? })` |
| `cordLoop` | `Part` | `({ at, r, thickness, boneHint, pigment?, rot?, segments? })` |

### `parts.trim`

| function | returns | signature |
|---|---|---|
| `piping` | `Part` | `({ path: V3[], r, boneHint, pigment?, cls?, sides?, name?, mountBone? })` |
| `tassel` | `PartGroup` | `({ at, length, r, strands?, boneHint, pigment?, mountBone?, cap? })` |
| `beadStrand` | `PartGroup` | `({ at, length, beads, r, boneHint, pigment?, drift?, mountBone? })` — 步搖 |
| `boss` | `Part` | `({ at, r, height, boneHint, pigment?, cls?, rot?, sides?, mountBone? })` |
| `ferrule` | `Part` | `({ at, r, height, proud?, boneHint, pigment?, rot?, sides?, mountBone? })` |
| `plaque` | `Part` | `({ at, w, h, d, boneHint, pigment?, cls?, rot?, mountBone? })` |

### `parts.types` — helpers

`emptyGroup()`, `mergeGroups(...)`, `mkPart(geometry, cls, pigment, boneHint, extra?)`,
`transformGroup(group, matrix)`, `groupTriangles(group)`, `groupMeshes(group)`,
`resolvePigment(pigment, side)`.

---

## 8. Before you say you are done

```
npx tsc --noEmit                            # zero errors in src/characters
npx tsx src/characters/verify.ts            # zero FAILs, and read the warnings
npx tsx src/characters/verify.ts --units    # your triangle count, mesh count,
                                            # measured size vs declared target
npx tsx src/characters/verify.ts --parts    # per-part winding and closure audit
```

`verify.ts` audits every triangle it can reach — yours included, both as
individual parts and as the merged unit mesh:

- **winding vs stored normal** must agree on every triangle (hard fail);
- **closed solids must have positive signed volume** — this is what catches a
  form built inside out, which no amount of staring at a wireframe will show
  (hard fail);
- open-edge counts and centroid agreement are reported, not asserted, because
  an open sheet legitimately has faces pointing both ways.

It found five inside-out bugs in the shared library that had passed every other
check. If it flags something in your unit, it is right.

Then, honestly: does a flat black render of your unit read as *that piece*, next
to the other six, at board distance? If it does not, no amount of detail on it
will help.
