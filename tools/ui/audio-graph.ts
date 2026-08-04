/**
 * Audio graph check.
 *
 *   npx tsx tools/ui/audio-graph.ts
 *
 * Runs the real `ui/audio.ts` against the strict stub context in
 * `stub-audio.ts` and asserts, for every cue in the contract:
 *
 *   1. it builds its graph without throwing,
 *   2. it schedules nothing illegal (no exponential ramp to zero, no stop
 *      before start, no filter past nyquist, no NaN anywhere),
 *   3. it reaches the master bus — a cue that builds a graph into thin air is
 *      worse than one that crashes, because it fails silently,
 *   4. it disconnects completely once its tail has decayed.
 *
 * It also runs the underscore for a simulated two minutes across the whole
 * intensity and cadence range, and asserts the voice count stays bounded and
 * the score keeps issuing beats.
 */

import type { AudioCue } from '../../src/core/contracts.ts';
import { PieceType } from '../../src/core/types.ts';
import { createAudioEngine, pieceDetune } from '../../src/ui/audio.ts';
import { StubAudioContext, StubNode, StubRegistry } from './stub-audio.ts';

const CUES: AudioCue[] = [
  'pieceLand',
  'pieceLift',
  'armourShift',
  'hoofbeat',
  'chariotRumble',
  'trebuchetRelease',
  'trebuchetImpact',
  'bladeStrike',
  'spearThrust',
  'trunkSweep',
  'bodyFall',
  'drumCheck',
  'drumBeat',
  'gong',
  'uiTap',
  'uiSweep',
  'illegal',
];

const failures: string[] = [];
const pad = (s: string, n: number) => (s + ' '.repeat(n)).slice(0, n);

function fail(msg: string): void {
  failures.push(msg);
}

/** Walk the graph forward from `start` and report whether it reaches `target`. */
function reaches(start: StubNode, target: StubNode, seen = new Set<StubNode>()): boolean {
  if (start === target) return true;
  if (seen.has(start)) return false;
  seen.add(start);
  for (const d of start.outgoing) {
    if (d instanceof StubNode && reaches(d, target, seen)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. Every cue, in isolation
// ---------------------------------------------------------------------------

console.log('');
console.log('AUDIO GRAPH CHECK');
console.log('=================');
console.log('');
console.log(pad('cue', 20) + pad('nodes', 8) + pad('conn', 8) + pad('tail s', 9) + pad('reaches out', 13) + 'teardown');
console.log('-'.repeat(78));

for (const cue of CUES) {
  StubAudioContext.resetClock();
  const reg = new StubRegistry();
  const ctx = new StubAudioContext(reg);
  const engine = createAudioEngine({ context: ctx as unknown as BaseAudioContext });

  await engine.unlock();
  // Silence the underscore so its nodes do not pollute the cue's count.
  engine.setIntensity(0);
  const baseline = reg.nodes.length;
  const baseConn = reg.connections;

  let threw = '';
  try {
    engine.play(cue, { gain: 0.9, pan: -0.3, detune: -200 });
  } catch (err) {
    threw = (err as Error).message;
  }
  if (threw) {
    fail(`${cue}: threw while building — ${threw}`);
    console.log(pad(cue, 20) + 'THREW: ' + threw);
    continue;
  }

  const created = reg.nodes.slice(baseline);
  if (created.length === 0) fail(`${cue}: created no nodes at all`);

  // Does it actually get to the speakers?
  const dest = ctx.destination as unknown as StubNode;
  const wired = created.some((n) => reaches(n, dest));
  if (!wired) fail(`${cue}: built a graph that never reaches the destination`);

  // Find the longest scheduled tail so we know how far to run the clock.
  let tail = 0;
  for (const n of created) {
    const s = n as unknown as { stopped?: number };
    if (typeof s.stopped === 'number' && s.stopped > tail) tail = s.stopped;
  }
  if (tail <= 0) fail(`${cue}: nothing was scheduled to stop`);

  // Run past the tail and pump, then check the voice released its nodes.
  ctx.advance(tail + 1.0);
  engine.update(1 / 60);

  const stillWired = created.filter((n) => n.outgoing.size > 0);
  const clean = stillWired.length === 0;
  if (!clean) fail(`${cue}: ${stillWired.length} node(s) still connected after the tail (${stillWired.map((n) => n.kind).join(', ')})`);

  for (const v of reg.violations) fail(`${cue}: ${v.node} — ${v.message}`);

  console.log(
    pad(cue, 20) +
      pad(String(created.length), 8) +
      pad(String(reg.connections - baseConn), 8) +
      pad(tail.toFixed(3), 9) +
      pad(wired ? 'yes' : 'NO', 13) +
      (clean ? 'clean' : 'LEAKED'),
  );

  engine.dispose();
}

// ---------------------------------------------------------------------------
// 2. Every cue fired at once, repeatedly — the busy-capture case
// ---------------------------------------------------------------------------

{
  StubAudioContext.resetClock();
  const reg = new StubRegistry();
  const ctx = new StubAudioContext(reg);
  const engine = createAudioEngine({ context: ctx as unknown as BaseAudioContext });
  await engine.unlock();
  engine.setIntensity(1);
  engine.setCadence(120);

  // Three identical cycles. A leak shows up as the live-node count climbing
  // from cycle to cycle; a steady count means every voice is being released.
  const settled: number[] = [];
  let created = 0;
  for (let cycle = 0; cycle < 3; cycle++) {
    const before = reg.nodes.length;
    for (let round = 0; round < 12; round++) {
      for (const cue of CUES) engine.play(cue, { gain: 1, pan: (round % 3) - 1 });
      engine.playHoofs('canter', { beats: 3 });
      ctx.advance(0.05);
      engine.update(0.05);
    }
    // Ring out well past the longest tail (the gong, at 6.2 s).
    for (let i = 0; i < 60 * 12; i++) {
      ctx.advance(1 / 60);
      engine.update(1 / 60);
    }
    created += reg.nodes.length - before;
    settled.push(reg.liveNodes().length);
  }

  console.log('');
  console.log(`storm: ${created} nodes created over 3 cycles; live after each ringout: ${settled.join(', ')}`);
  const drift = settled[2] - settled[0];
  if (drift > 8) {
    fail(`storm: live node count drifted by ${drift} across identical cycles — voices are leaking`);
  }
  for (const v of reg.violations) fail(`storm: ${v.node} — ${v.message}`);
  engine.dispose();
  const afterDispose = reg.liveNodes();
  if (afterDispose.length > 0) {
    fail(`dispose() left ${afterDispose.length} node(s) wired: ${[...new Set(afterDispose.map((n) => n.kind))].join(', ')}`);
  }
  console.log(`dispose: ${afterDispose.length} nodes still wired`);
}

// ---------------------------------------------------------------------------
// 3. The underscore, across the whole intensity and cadence range
// ---------------------------------------------------------------------------

{
  StubAudioContext.resetClock();
  const reg = new StubRegistry();
  const ctx = new StubAudioContext(reg);
  const engine = createAudioEngine({ context: ctx as unknown as BaseAudioContext });
  await engine.unlock();

  const dt = 1 / 60;
  const SECONDS = 40;
  let maxLive = 0;
  const density: number[] = [];
  const levels = [1, 0.75, 0.5, 0.25, 0.02];

  // Cadence is held fixed here on purpose: a faster drum also makes more nodes,
  // and conflating the two would let a broken setIntensity pass.
  engine.setCadence(60);
  for (const intensity of levels) {
    engine.setIntensity(intensity);
    // Let the smoothing settle before measuring.
    for (let i = 0; i < 60 * 4; i++) {
      ctx.advance(dt);
      engine.update(dt);
    }
    const before = reg.nodes.length;
    for (let i = 0; i < 60 * SECONDS; i++) {
      ctx.advance(dt);
      engine.update(dt);
      const live = reg.liveNodes().length;
      if (live > maxLive) maxLive = live;
    }
    density.push(reg.nodes.length - before);
  }

  console.log('');
  console.log(`underscore: nodes scheduled per ${SECONDS} s at 60 bpm, intensity falling`);
  for (let i = 0; i < density.length; i++) {
    const bar = '#'.repeat(Math.round(density[i] / 30));
    console.log(`  intensity ${levels[i].toFixed(2)}   ${pad(String(density[i]), 6)} ${bar}`);
  }
  console.log(`  peak simultaneous wired nodes: ${maxLive}`);

  for (let i = 1; i < density.length; i++) {
    if (density[i] > density[i - 1]) {
      fail(
        `underscore: texture thickened going from intensity ${levels[i - 1]} to ${levels[i]} ` +
          `(${density[i - 1]} -> ${density[i]} nodes) — setIntensity is not thinning it`,
      );
    }
  }
  if (density[density.length - 1] === 0) {
    fail('underscore: went completely silent at low intensity (the drone should survive)');
  }
  if (maxLive > 400) fail(`underscore: ${maxLive} live nodes — the scheduler is leaking`);

  // Cadence must independently change how often the drum lands.
  const beatCounts: number[] = [];
  for (const bpm of [40, 120]) {
    engine.setIntensity(0.5);
    engine.setCadence(bpm);
    for (let i = 0; i < 60 * 12; i++) {
      ctx.advance(dt);
      engine.update(dt);
    }
    const before = reg.nodes.length;
    for (let i = 0; i < 60 * 30; i++) {
      ctx.advance(dt);
      engine.update(dt);
    }
    beatCounts.push(reg.nodes.length - before);
  }
  console.log(`  cadence 40 bpm -> ${beatCounts[0]} nodes / 30 s, 120 bpm -> ${beatCounts[1]}`);
  if (beatCounts[1] <= beatCounts[0] * 1.5) {
    fail(`underscore: setCadence did not tighten the pulse (${beatCounts[0]} vs ${beatCounts[1]})`);
  }

  for (const v of reg.violations) fail(`underscore: ${v.node} — ${v.message}`);
  engine.dispose();
}

// ---------------------------------------------------------------------------
// 4. Degraded contexts and edge cases
// ---------------------------------------------------------------------------

{
  // No StereoPanner (older Safari) and no Convolver: must still build.
  StubAudioContext.resetClock();
  const reg = new StubRegistry();
  const ctx = new StubAudioContext(reg);
  ctx.supportsPanner = false;
  ctx.supportsConvolver = false;
  const engine = createAudioEngine({ context: ctx as unknown as BaseAudioContext });
  await engine.unlock();
  for (const cue of CUES) engine.play(cue, { pan: 0.5 });
  ctx.advance(8);
  engine.update(1 / 60);
  for (const v of reg.violations) fail(`degraded: ${v.node} — ${v.message}`);
  console.log('');
  console.log(`degraded context (no panner, no convolver): ${reg.violations.length} violations`);
  engine.dispose();
}

{
  // play() before unlock() must be a silent no-op, not a crash.
  const engine = createAudioEngine();
  let threw = '';
  try {
    engine.play('gong');
    engine.setIntensity(0.5);
    engine.setCadence(70);
    engine.setMuted(true);
    engine.update(1 / 60);
    engine.dispose();
  } catch (err) {
    threw = (err as Error).message;
  }
  if (threw) fail(`pre-unlock calls threw: ${threw}`);
  console.log(`pre-unlock no-op: ${threw ? 'THREW' : 'ok'}`);
}

{
  // Mute must reach zero and unmute must come back.
  StubAudioContext.resetClock();
  const reg = new StubRegistry();
  const ctx = new StubAudioContext(reg);
  const engine = createAudioEngine({ context: ctx as unknown as BaseAudioContext });
  await engine.unlock();
  const master = reg.nodes.find((n) => n.kind === 'GainNode') as unknown as { gain: { value: number } };
  engine.setMuted(true);
  const muted = master.gain.value;
  engine.setMuted(false);
  const unmuted = master.gain.value;
  if (muted !== 0) fail(`setMuted(true) left master gain at ${muted}`);
  if (!(unmuted > 0)) fail(`setMuted(false) left master gain at ${unmuted}`);
  console.log(`mute: ${muted} -> ${unmuted}`);
  engine.dispose();
}

{
  // Piece mass really does move the pitch, and monotonically by weight.
  const order = [
    PieceType.General,
    PieceType.Chariot,
    PieceType.Elephant,
    PieceType.Cannon,
    PieceType.Horse,
    PieceType.Advisor,
    PieceType.Soldier,
  ];
  const cents = order.map(pieceDetune);
  for (let i = 1; i < cents.length; i++) {
    if (cents[i] <= cents[i - 1]) fail(`pieceDetune is not monotonic by mass at index ${i}`);
  }
  console.log(`pieceDetune 帥..兵: ${cents.join(', ')} cents`);
}

// ---------------------------------------------------------------------------

console.log('');
if (failures.length) {
  console.log('FAILURES');
  console.log('--------');
  for (const f of failures) console.log('  ' + f);
  console.log('');
  process.exit(1);
}
console.log('All cues build, sound into the master bus, and tear down cleanly.');
console.log('');
