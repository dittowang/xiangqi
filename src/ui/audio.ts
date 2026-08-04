/**
 * The whole soundtrack, synthesised.
 *
 * No samples, no files, no presets. Every noise buffer is filled by code, every
 * impulse response is generated, every string is a Karplus–Strong waveguide
 * rendered from a seeded stream, and every cue is a graph built at the moment it
 * fires and torn down when it has rung out.
 *
 * ── How the material world is built ─────────────────────────────────────────
 *
 * Three synthesis techniques carry almost everything:
 *
 *   • **Filtered noise bursts.** Wood, stone, cloth, air. A short burst through
 *     a bandpass is a contact; a long burst through a swept filter is a whoosh.
 *   • **Modal banks.** A struck solid rings at a fixed set of ratios that do not
 *     have to be harmonic. Wood bars ring at 1 : 2.756 : 5.404; a drum head at
 *     the Bessel ratios 1 : 1.593 : 2.135 : 2.295 : 2.917; a gong at nothing in
 *     particular, which is exactly why it shimmers. Getting these ratios right
 *     is the difference between a war drum and a kick drum.
 *   • **Karplus–Strong.** A genuine plucked-string model: excite a delay line
 *     with noise, feed it back through a one-pole lowpass, and the string tunes
 *     itself. Rendered offline into an AudioBuffer so the pitch is exact and a
 *     note costs one BufferSource instead of a feedback graph.
 *
 * ── Scheduling ──────────────────────────────────────────────────────────────
 *
 * Nothing uses `setTimeout`. `update(dt)` is a pump: it looks ahead on the
 * AudioContext clock and schedules every musical event that falls inside the
 * lookahead window at an absolute `ctx.currentTime + offset`. The audio clock is
 * the only clock that matters here — when the capture harness freezes the
 * simulation the score keeps running in real time, which is correct, because a
 * still frame has no sound in it.
 *
 * ── Level discipline ────────────────────────────────────────────────────────
 *
 * Everything lands on one bus, through a hard limiter and then a generated
 * tanh soft-clip. A capture with a drum, a gong, a chariot and four hoofbeats
 * inside 200 ms cannot clip the file.
 */

import type { AudioCue, AudioEngine } from '@core/contracts.ts';
import { PieceType, clamp, damp } from '@core/types.ts';
import { seedFor } from '@core/rng.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Web Audio's exponential ramps cannot touch zero, so this is the floor. */
const EPS = 1e-4;

/** How far ahead the score is scheduled, seconds. */
const LOOKAHEAD = 0.35;

/** Hard ceiling on simultaneous voices; the oldest is culled past this. */
const MAX_VOICES = 56;

/**
 * 三分損益 pentatonic. Generating the scale by repeatedly taking two thirds and
 * four thirds of a string gives Pythagorean ratios, which is what a 古琴 is
 * actually tuned to — and the slightly wide major third (81/64 rather than 5/4)
 * is a large part of why this mode sounds Chinese rather than merely major.
 */
const MODE = [1, 9 / 8, 81 / 64, 3 / 2, 27 / 16]; // 宫 商 角 徵 羽

/** 宫 at D3. Low enough to sit under the board, high enough to carry a melody. */
const GONG_HZ = 146.832;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Percussive envelope: near-instant rise, exponential fall. Returns end time. */
function percEnv(p: AudioParam, t0: number, peak: number, attack: number, decay: number): number {
  const top = Math.max(peak, EPS * 4);
  p.setValueAtTime(EPS, t0);
  p.linearRampToValueAtTime(top, t0 + attack);
  p.exponentialRampToValueAtTime(EPS, t0 + attack + decay);
  return t0 + attack + decay;
}

/** Swell envelope: rise, hold, fall. For whooshes and rumbles. */
function swellEnv(
  p: AudioParam,
  t0: number,
  peak: number,
  attack: number,
  hold: number,
  release: number,
): number {
  const top = Math.max(peak, EPS * 4);
  p.setValueAtTime(EPS, t0);
  p.linearRampToValueAtTime(top, t0 + attack);
  p.setValueAtTime(top, t0 + attack + hold);
  p.exponentialRampToValueAtTime(EPS, t0 + attack + hold + release);
  return t0 + attack + hold + release;
}

/** Sweep a frequency parameter exponentially, clamped away from zero. */
function sweep(p: AudioParam, t0: number, from: number, to: number, seconds: number): void {
  p.setValueAtTime(Math.max(from, 1), t0);
  p.exponentialRampToValueAtTime(Math.max(to, 1), t0 + Math.max(seconds, 0.001));
}

// ---------------------------------------------------------------------------
// Voices — node bookkeeping
// ---------------------------------------------------------------------------

/**
 * One firing of one cue. Owns every node it created so the engine can
 * disconnect the lot once the tail has decayed; without this a long session
 * accumulates thousands of dead nodes and the audio thread starves.
 */
class Voice {
  readonly nodes: AudioNode[] = [];
  readonly sources: AudioScheduledSourceNode[] = [];
  /** AudioContext time after which this voice is silent and can be dropped. */
  endAt = 0;
  private stopped = false;

  add<T extends AudioNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  addSource<T extends AudioScheduledSourceNode>(node: T): T {
    this.nodes.push(node);
    this.sources.push(node);
    return node;
  }

  /** Extend the voice's lifetime to cover a scheduled tail. */
  until(t: number): void {
    if (t > this.endAt) this.endAt = t;
  }

  /** Silence and release everything. Safe to call twice. */
  dispose(now: number): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const s of this.sources) {
      try {
        s.stop(now);
      } catch {
        // Already stopped, or never started. Either is fine.
      }
    }
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        // A node may already be detached; disconnecting twice is not an error
        // worth surfacing.
      }
    }
    this.nodes.length = 0;
    this.sources.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Generated buffers
// ---------------------------------------------------------------------------

type NoiseKind = 'white' | 'pink' | 'brown';

/** Fill a buffer with seeded noise of the requested spectrum. */
function makeNoise(ctx: BaseAudioContext, seconds: number, kind: NoiseKind, tag: string): AudioBuffer {
  const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const rng = seedFor('audio-noise', kind, tag);

  if (kind === 'white') {
    for (let i = 0; i < n; i++) d[i] = rng.next() * 2 - 1;
  } else if (kind === 'pink') {
    // Voss–McCartney's cheap cousin: a bank of one-poles summed, which lands
    // within a fraction of a dB of true 1/f across the audible band.
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    for (let i = 0; i < n; i++) {
      const w = rng.next() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + w * 0.5362) * 0.11;
    }
  } else {
    // Brown: integrated white, leaked so it cannot wander off centre.
    let last = 0;
    for (let i = 0; i < n; i++) {
      last = (last + (rng.next() * 2 - 1) * 0.02) * 0.998;
      d[i] = last * 3.2;
    }
  }
  return buf;
}

/**
 * A generated room. Exponentially decaying noise with a handful of early
 * reflections punched into the head — enough to put the board in a hall without
 * shipping an impulse response, and cheap because the tail is short.
 */
function makeImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const rng = seedFor('audio-ir', ch);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      // A slightly convex decay reads as stone rather than as a plate.
      d[i] = (rng.next() * 2 - 1) * Math.pow(1 - t, 2.6) * 0.55;
    }
    // Early reflections: a few discrete taps in the first 45 ms.
    const taps = [0.007, 0.013, 0.019, 0.028, 0.041];
    for (let k = 0; k < taps.length; k++) {
      const i = Math.floor(taps[k] * ctx.sampleRate) + (ch ? 37 : 0);
      if (i < n) d[i] += (k % 2 ? -1 : 1) * (0.4 - k * 0.06);
    }
  }
  return buf;
}

/** tanh soft-clip curve. The last line of defence against a clipped capture. */
function makeSoftClip(): Float32Array {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 1.6) / Math.tanh(1.6);
  }
  return curve;
}

/**
 * Karplus–Strong, rendered offline.
 *
 * A delay line of `sampleRate / freq` samples is filled with noise and then fed
 * back through a one-pole lowpass. The lowpass is what makes it a string rather
 * than a buzz: high partials lose energy faster than low ones, exactly as they
 * do on real gut or silk. The delay length is fractional and read with linear
 * interpolation, so the pitch is right instead of quantised to the sample grid.
 *
 * `position` combs the excitation the way plucking away from the bridge does —
 * it notches out the harmonics with a node at that point, and it is most of what
 * separates a 古琴 from a rubber band.
 */
function renderPluck(
  ctx: BaseAudioContext,
  freq: number,
  seconds: number,
  opts: { damping: number; position: number; tone: number; seed: string },
): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.max(16, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(1, n, sr);
  const out = buf.getChannelData(0);

  const delay = sr / Math.max(freq, 20);
  const size = Math.ceil(delay) + 2;
  const line = new Float32Array(size);
  const rng = seedFor('audio-ks', opts.seed, Math.round(freq));

  // Excitation, lowpassed by `tone` so a soft pluck is not a click.
  let lp = 0;
  for (let i = 0; i < size; i++) {
    const w = rng.next() * 2 - 1;
    lp += (w - lp) * opts.tone;
    line[i] = lp;
  }
  // Pluck position comb.
  const combLag = Math.max(1, Math.floor(delay * clamp(opts.position, 0.05, 0.5)));
  for (let i = size - 1; i >= combLag; i--) line[i] -= line[i - combLag] * 0.85;

  let write = 0;
  let read = size - delay;
  let filt = 0;
  const feedback = Math.pow(0.5, 1 / (freq * seconds * 0.9)); // per-sample loss for the target decay
  const damp0 = clamp(opts.damping, 0.05, 0.95);

  for (let i = 0; i < n; i++) {
    while (read < 0) read += size;
    while (read >= size) read -= size;
    const i0 = Math.floor(read);
    const frac = read - i0;
    const s = line[i0] * (1 - frac) + line[(i0 + 1) % size] * frac;

    // One-pole lowpass inside the loop = frequency-dependent damping.
    filt += (s - filt) * damp0;
    const v = filt * feedback;
    line[write] = v;
    out[i] = v;

    write = (write + 1) % size;
    read += 1;
  }

  // Tail fade so the buffer never ends on a step.
  const fade = Math.min(n, Math.floor(sr * 0.05));
  for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
  // Normalise: the comb and the feedback make the peak hard to predict.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 1e-6) {
    const g = 0.9 / peak;
    for (let i = 0; i < n; i++) out[i] *= g;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// The kit: generated material shared by every cue
// ---------------------------------------------------------------------------

interface Kit {
  ctx: BaseAudioContext;
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
  plucks: Map<string, AudioBuffer>;
}

function buildKit(ctx: BaseAudioContext): Kit {
  return {
    ctx,
    white: makeNoise(ctx, 2, 'white', 'a'),
    pink: makeNoise(ctx, 2, 'pink', 'a'),
    brown: makeNoise(ctx, 2.5, 'brown', 'a'),
    plucks: new Map(),
  };
}

function pluckBuffer(kit: Kit, freq: number, timbre: 'qin' | 'bright'): AudioBuffer {
  const key = `${timbre}:${freq.toFixed(2)}`;
  let b = kit.plucks.get(key);
  if (!b) {
    b = timbre === 'qin'
      ? renderPluck(kit.ctx, freq, 2.4, { damping: 0.34, position: 0.18, tone: 0.42, seed: 'qin' })
      : renderPluck(kit.ctx, freq, 1.5, { damping: 0.58, position: 0.28, tone: 0.72, seed: 'bright' });
    kit.plucks.set(key, b);
  }
  return b;
}

// ---------------------------------------------------------------------------
// Graph primitives
// ---------------------------------------------------------------------------

interface BurstSpec {
  kind?: NoiseKind;
  /** Filter type and shape. */
  type?: BiquadFilterType;
  freq: number;
  q?: number;
  /** Sweep the filter to this frequency over `sweepTime`. */
  sweepTo?: number;
  sweepTime?: number;
  peak: number;
  attack?: number;
  hold?: number;
  decay: number;
  /** Playback rate on the noise buffer, i.e. spectral tilt. */
  rate?: number;
  /** Seeded read offset so repeated bursts are not the same grain. */
  offset?: number;
}

/** Filtered noise burst. The workhorse: wood, stone, cloth, air, shatter. */
function burst(voice: Voice, kit: Kit, dest: AudioNode, t0: number, s: BurstSpec): number {
  const ctx = kit.ctx;
  const src = voice.addSource(ctx.createBufferSource());
  src.buffer = s.kind === 'pink' ? kit.pink : s.kind === 'brown' ? kit.brown : kit.white;
  src.loop = true;
  if (s.rate) src.playbackRate.value = s.rate;

  const filt = voice.add(ctx.createBiquadFilter());
  filt.type = s.type ?? 'bandpass';
  filt.frequency.value = Math.max(20, s.freq);
  filt.Q.value = s.q ?? 1;
  if (s.sweepTo) sweep(filt.frequency, t0, s.freq, s.sweepTo, s.sweepTime ?? s.decay);

  const gain = voice.add(ctx.createGain());
  const end = s.hold
    ? swellEnv(gain.gain, t0, s.peak, s.attack ?? 0.004, s.hold, s.decay)
    : percEnv(gain.gain, t0, s.peak, s.attack ?? 0.001, s.decay);

  src.connect(filt);
  filt.connect(gain);
  gain.connect(dest);
  src.start(t0, s.offset ?? 0);
  src.stop(end + 0.02);
  voice.until(end + 0.05);
  return end;
}

interface ModalSpec {
  base: number;
  ratios: readonly number[];
  /** Decay per mode, seconds. Shorter for higher modes or it sounds electronic. */
  decays: readonly number[];
  gains: readonly number[];
  peak: number;
  /** Hz of detune between each mode's pair, producing beating. 0 = one osc. */
  beat?: number;
  /** Delay the upper modes so energy blooms upward, as a struck plate does. */
  bloom?: number;
  /** Slide the whole bank down by this fraction over `glideTime`. */
  glide?: number;
  glideTime?: number;
}

/** A bank of decaying sines at fixed ratios — a struck solid. */
function modal(voice: Voice, kit: Kit, dest: AudioNode, t0: number, s: ModalSpec): number {
  const ctx = kit.ctx;
  let end = t0;
  for (let i = 0; i < s.ratios.length; i++) {
    const f = s.base * s.ratios[i];
    if (f < 15 || f > ctx.sampleRate * 0.45) continue;
    const bloom = (s.bloom ?? 0) * (i / Math.max(1, s.ratios.length - 1));
    const start = t0 + bloom;
    const dur = s.decays[Math.min(i, s.decays.length - 1)];
    const amp = s.peak * s.gains[Math.min(i, s.gains.length - 1)];
    const pair = s.beat ? 2 : 1;

    const g = voice.add(ctx.createGain());
    const e = percEnv(g.gain, start, amp / pair, bloom > 0 ? 0.02 + bloom * 0.4 : 0.002, dur);
    g.connect(dest);

    for (let k = 0; k < pair; k++) {
      const osc = voice.addSource(ctx.createOscillator());
      osc.type = 'sine';
      const df = k === 0 ? 0 : (s.beat ?? 0) * (i % 2 ? 1 : -1);
      osc.frequency.setValueAtTime(f + df, start);
      if (s.glide) {
        osc.frequency.exponentialRampToValueAtTime(
          Math.max(15, (f + df) * (1 - s.glide)),
          start + (s.glideTime ?? dur * 0.5),
        );
      }
      osc.connect(g);
      osc.start(start);
      osc.stop(e + 0.02);
    }
    if (e > end) end = e;
  }
  voice.until(end + 0.05);
  return end;
}

/** A short pitched thump: a sine dropped hard in frequency. The body of an impact. */
function thump(
  voice: Voice,
  kit: Kit,
  dest: AudioNode,
  t0: number,
  from: number,
  to: number,
  peak: number,
  decay: number,
  dropTime = 0.06,
): number {
  const ctx = kit.ctx;
  const osc = voice.addSource(ctx.createOscillator());
  osc.type = 'sine';
  sweep(osc.frequency, t0, from, to, dropTime);
  const g = voice.add(ctx.createGain());
  const end = percEnv(g.gain, t0, peak, 0.002, decay);
  osc.connect(g);
  g.connect(dest);
  osc.start(t0);
  osc.stop(end + 0.02);
  voice.until(end + 0.05);
  return end;
}

/**
 * A creak: a sawtooth wobbling in pitch through a tight resonant bandpass.
 * Rope, leather and timber under load are all stick-slip, and stick-slip is a
 * jittering oscillator, not noise.
 */
function creak(
  voice: Voice,
  kit: Kit,
  dest: AudioNode,
  t0: number,
  o: { freq: number; res: number; wobble: number; rate: number; peak: number; dur: number },
): number {
  const ctx = kit.ctx;
  const osc = voice.addSource(ctx.createOscillator());
  osc.type = 'sawtooth';
  osc.frequency.value = o.freq;

  const lfo = voice.addSource(ctx.createOscillator());
  lfo.type = 'triangle';
  lfo.frequency.value = o.rate;
  const lfoGain = voice.add(ctx.createGain());
  lfoGain.gain.value = o.freq * o.wobble;
  lfo.connect(lfoGain);
  lfoGain.connect(osc.frequency);

  const bp = voice.add(ctx.createBiquadFilter());
  bp.type = 'bandpass';
  bp.frequency.value = o.res;
  bp.Q.value = 11;

  const g = voice.add(ctx.createGain());
  const end = swellEnv(g.gain, t0, o.peak, o.dur * 0.35, o.dur * 0.2, o.dur * 0.45);

  osc.connect(bp);
  bp.connect(g);
  g.connect(dest);
  osc.start(t0);
  osc.stop(end + 0.02);
  lfo.start(t0);
  lfo.stop(end + 0.02);
  voice.until(end + 0.05);
  return end;
}

// ---------------------------------------------------------------------------
// Piece mass -> pitch
// ---------------------------------------------------------------------------

/**
 * Detune, in cents, for each piece type's contact sounds. A 車 is a heavy
 * lacquered block and a 兵 is a small one; the same knock voiced a fifth apart
 * is most of what tells a listener which piece just landed without looking.
 * `main.ts` passes this straight into `play('pieceLand', { detune })`.
 */
export function pieceDetune(type: PieceType): number {
  switch (type) {
    case PieceType.General:
      return -520;
    case PieceType.Chariot:
      return -380;
    case PieceType.Cannon:
      return -240;
    case PieceType.Horse:
      return -120;
    case PieceType.Elephant:
      return -300;
    case PieceType.Advisor:
      return 60;
    case PieceType.Soldier:
      return 260;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Options and the concrete engine type
// ---------------------------------------------------------------------------

export interface AudioOptions {
  /**
   * Inject a context instead of letting the engine make one. The offline test
   * harness passes a stub; the game passes nothing.
   */
  context?: BaseAudioContext | null;
  /** Master trim, 0..1. */
  masterGain?: number;
  /** Start muted (the player's stored preference). */
  muted?: boolean;
}

export type HoofPattern = 'walk' | 'march' | 'canter' | 'gallop';

/**
 * The concrete engine. Implements `AudioEngine` and adds the few extras the
 * game wants that the contract does not name.
 */
export interface XiangqiAudio extends AudioEngine {
  /** True once a context exists and has been resumed. */
  readonly ready: boolean;
  /** Schedule a hoof pattern rather than a single beat. */
  playHoofs(pattern: HoofPattern, opts?: { gain?: number; pan?: number; delay?: number; beats?: number }): void;
  /** Current underscore intensity, after smoothing. */
  readonly intensity: number;
  /** Current drum cadence in bpm, after smoothing. */
  readonly cadence: number;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

class Engine implements XiangqiAudio {
  private ctx: BaseAudioContext | null = null;
  private injected: BaseAudioContext | null;
  private kit: Kit | null = null;

  // Bus structure.
  private master!: GainNode;
  private limiter!: DynamicsCompressorNode;
  private clip!: WaveShaperNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private send!: GainNode;
  private verbReturn!: GainNode;

  // Persistent underscore voices.
  private drone: Voice | null = null;
  private droneGain: GainNode | null = null;
  private droneFilter: BiquadFilterNode | null = null;

  private voices: Voice[] = [];
  private counter = 0;

  private targetIntensity = 0.85;
  private smoothIntensity = 0.85;
  private targetBpm = 52;
  private smoothBpm = 52;
  private muted: boolean;
  private masterTrim: number;

  // Scheduler state, all in AudioContext time.
  private nextBeat = 0;
  private beatIndex = 0;
  private scoreRunning = false;

  constructor(opts?: AudioOptions) {
    this.injected = opts?.context ?? null;
    this.masterTrim = opts?.masterGain ?? 0.82;
    this.muted = opts?.muted ?? false;
  }

  get ready(): boolean {
    return this.ctx !== null;
  }

  get intensity(): number {
    return this.smoothIntensity;
  }

  get cadence(): number {
    return this.smoothBpm;
  }

  // -- lifecycle -----------------------------------------------------------

  async unlock(): Promise<void> {
    if (this.ctx) {
      await this.resumeIfSuspended();
      return;
    }
    const ctx =
      this.injected ??
      (typeof AudioContext !== 'undefined' ? new AudioContext({ latencyHint: 'interactive' }) : null);
    if (!ctx) return; // No Web Audio at all: the game runs silent rather than throwing.

    this.ctx = ctx;
    this.kit = buildKit(ctx);
    this.buildBuses();
    await this.resumeIfSuspended();
    this.startUnderscore();
  }

  private async resumeIfSuspended(): Promise<void> {
    const ctx = this.ctx as AudioContext | null;
    if (ctx && typeof ctx.resume === 'function' && ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        // A context that refuses to resume without a gesture will resume on the
        // next one; nothing here is worth failing the boot for.
      }
    }
  }

  private buildBuses(): void {
    const ctx = this.ctx!;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.masterTrim;
    this.master.connect(ctx.destination);

    // tanh clip last, so nothing downstream of the limiter can overshoot.
    this.clip = ctx.createWaveShaper();
    this.clip.curve = makeSoftClip();
    this.clip.oversample = '2x';
    this.clip.connect(this.master);

    // A fast, hard limiter rather than a musical compressor: this exists to
    // stop a busy capture clipping, not to glue a mix together.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -10;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.limiter.connect(this.clip);

    this.sfx = ctx.createGain();
    this.sfx.gain.value = 1;
    this.sfx.connect(this.limiter);

    this.music = ctx.createGain();
    this.music.gain.value = 0.62;
    this.music.connect(this.limiter);

    // Generated room, fed from a send so dry transients stay sharp.
    this.verbReturn = ctx.createGain();
    this.verbReturn.gain.value = 0.5;
    this.verbReturn.connect(this.limiter);

    this.send = ctx.createGain();
    this.send.gain.value = 0.3;
    if (typeof ctx.createConvolver === 'function') {
      const conv = ctx.createConvolver();
      conv.buffer = makeImpulse(ctx, 1.15);
      conv.normalize = true;
      this.send.connect(conv);
      conv.connect(this.verbReturn);
    } else {
      this.send.connect(this.verbReturn);
    }
  }

  dispose(): void {
    const now = this.ctx ? this.ctx.currentTime : 0;
    for (const v of this.voices) v.dispose(now);
    this.voices.length = 0;
    if (this.drone) {
      this.drone.dispose(now);
      this.drone = null;
    }
    this.scoreRunning = false;
    if (this.ctx) {
      try {
        this.master.disconnect();
        this.limiter.disconnect();
        this.clip.disconnect();
        this.sfx.disconnect();
        this.music.disconnect();
        this.send.disconnect();
        this.verbReturn.disconnect();
      } catch {
        // Already torn down.
      }
      // Only close a context we created ourselves.
      const ctx = this.ctx as AudioContext;
      if (!this.injected && typeof ctx.close === 'function') void ctx.close();
    }
    this.ctx = null;
    this.kit = null;
  }

  // -- controls ------------------------------------------------------------

  setIntensity(v: number): void {
    this.targetIntensity = clamp(v, 0, 1);
  }

  setCadence(bpm: number): void {
    this.targetBpm = clamp(bpm, 30, 132);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(Math.max(this.master.gain.value, EPS), t);
    this.master.gain.linearRampToValueAtTime(m ? 0 : this.masterTrim, t + 0.08);
  }

  // -- the frame pump ------------------------------------------------------

  update(dt: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    // Smooth the two continuous controls so neither jumps on a capture.
    this.smoothIntensity = damp(this.smoothIntensity, this.targetIntensity, 1.4, dt);
    this.smoothBpm = damp(this.smoothBpm, this.targetBpm, 0.45, dt);

    if (this.droneGain) {
      // The drone is the floor of the texture: it thins with the board but is
      // never the thing that disappears.
      const target = 0.05 + 0.11 * this.smoothIntensity;
      this.droneGain.gain.setTargetAtTime(target, now, 0.4);
    }
    if (this.droneFilter) {
      this.droneFilter.frequency.setTargetAtTime(280 + 520 * this.smoothIntensity, now, 0.6);
    }

    if (this.scoreRunning) this.schedule(now);

    // Retire finished voices. Compaction in place — no allocation per frame.
    let w = 0;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (v.endAt <= now) v.dispose(now);
      else this.voices[w++] = v;
    }
    this.voices.length = w;
  }

  // -- voice plumbing ------------------------------------------------------

  private begin(pan?: number, gain = 1): { voice: Voice; dest: AudioNode; kit: Kit } | null {
    if (!this.ctx || !this.kit) return null;
    if (this.voices.length >= MAX_VOICES) {
      // Cull the oldest rather than refusing to play: a dropped transient is
      // more noticeable than a shortened tail.
      this.voices.shift()?.dispose(this.ctx.currentTime);
    }
    const voice = new Voice();
    const out = voice.add(this.ctx.createGain());
    out.gain.value = gain;

    let dest: AudioNode = out;
    if (pan !== undefined && typeof this.ctx.createStereoPanner === 'function') {
      const p = voice.add(this.ctx.createStereoPanner());
      p.pan.value = clamp(pan, -1, 1);
      out.connect(p);
      p.connect(this.sfx);
      p.connect(this.send);
    } else {
      out.connect(this.sfx);
      out.connect(this.send);
    }
    this.voices.push(voice);
    return { voice, dest, kit: this.kit };
  }

  /** A seeded stream unique to this firing, so spreads vary but reproduce. */
  private streamFor(tag: string) {
    return seedFor('audio', tag, this.counter++);
  }

  // -- cues ----------------------------------------------------------------

  play(cue: AudioCue, opts?: { gain?: number; pan?: number; detune?: number; delay?: number }): void {
    if (!this.ctx || !this.kit) return;
    const ctx = this.ctx;
    const started = this.begin(opts?.pan, opts?.gain ?? 1);
    if (!started) return;
    const { voice, dest, kit } = started;
    const t0 = ctx.currentTime + Math.max(0, opts?.delay ?? 0) + 0.005;
    // Cents -> ratio: every cue that has a "size" reads it from here.
    const r = Math.pow(2, (opts?.detune ?? 0) / 1200);

    switch (cue) {
      case 'pieceLand':
        this.voicePieceLand(voice, kit, dest, t0, r);
        break;
      case 'pieceLift':
        this.voicePieceLift(voice, kit, dest, t0, r);
        break;
      case 'armourShift':
        this.voiceArmourShift(voice, kit, dest, t0, r);
        break;
      case 'hoofbeat':
        this.voiceHoof(voice, kit, dest, t0, r, 1);
        break;
      case 'chariotRumble':
        this.voiceChariot(voice, kit, dest, t0, r);
        break;
      case 'trebuchetRelease':
        this.voiceTrebuchetRelease(voice, kit, dest, t0, r);
        break;
      case 'trebuchetImpact':
        this.voiceTrebuchetImpact(voice, kit, dest, t0, r);
        break;
      case 'bladeStrike':
        this.voiceBlade(voice, kit, dest, t0, r);
        break;
      case 'spearThrust':
        this.voiceSpear(voice, kit, dest, t0, r);
        break;
      case 'trunkSweep':
        this.voiceTrunkSweep(voice, kit, dest, t0, r);
        break;
      case 'bodyFall':
        this.voiceBodyFall(voice, kit, dest, t0, r);
        break;
      case 'drumCheck':
        this.voiceDrum(voice, kit, dest, t0, r, 1);
        break;
      case 'drumBeat':
        this.voiceDrum(voice, kit, dest, t0, r, 0.44);
        break;
      case 'gong':
        this.voiceGong(voice, kit, dest, t0, r);
        break;
      case 'uiTap':
        this.voiceUiTap(voice, kit, dest, t0, r);
        break;
      case 'uiSweep':
        this.voiceUiSweep(voice, kit, dest, t0, r);
        break;
      case 'illegal':
        this.voiceIllegal(voice, kit, dest, t0, r);
        break;
      default:
        voice.until(t0);
        break;
    }
  }

  /**
   * Wood on stone. Three layers: a 2 ms click that gives the contact its edge,
   * a broadband knock body, and two modal resonators at the free-free bar
   * ratios 1 : 2.756 so the block has a size. Pitch scales with piece mass.
   */
  private voicePieceLand(v: Voice, kit: Kit, dest: AudioNode, t0: number, r: number): void {
    const rng = this.streamFor('land');
    const f0 = 268 * r;

    // Click: the stone, not the wood.
    burst(v, kit, dest, t0, { type: 'highpass', freq: 3400, q: 0.7, peak: 0.34, decay: 0.014, offset: rng.range(0, 1.5) });
    // Body: the impact itself.
    burst(v, kit, dest, t0, {
      type: 'bandpass',
      freq: f0 * 1.4,
      q: 2.4,
      peak: 0.5,
      decay: 0.05,
      offset: rng.range(0, 1.5),
    });
    // The block ringing.
    modal(v, kit, dest, t0, {
      base: f0,
      ratios: [1, 2.756, 5.404],
      decays: [0.14, 0.095, 0.05],
      gains: [1, 0.42, 0.16],
      peak: 0.42,
      glide: 0.02,
      glideTime: 0.05,
    });
    // The tabletop answering underneath.
    thump(v, kit, dest, t0, f0 * 0.62, f0 * 0.42, 0.2, 0.1, 0.04);
  }

  /** Lift: the same block, higher and softer, with the scrape of it sliding. */
  private voicePieceLift(v: Voice, kit: Kit, dest: AudioNode, t0: number, r: number): void {
    const rng = this.streamFor('lift');
    const f0 = 430 * r;
    burst(v, kit, dest, t0, { type: 'highpass', freq: 4200, q: 0.7, peak: 0.13, decay: 0.009, offset: rng.range(0, 1.5) });
    modal(v, kit, dest, t0, {
      base: f0,
      ratios: [1, 2.756],
      decays: [0.07, 0.045],
      gains: [1, 0.35],
      peak: 0.2,
    });
    // Scrape: a narrow noise band walking upward as the piece breaks free.
    burst(v, kit, dest, t0 + 0.008, {
      kind: 'pink',
      type: 'bandpass',
      freq: 900,
      sweepTo: 1850,
      sweepTime: 0.07,
      q: 5,
      peak: 0.14,
      attack: 0.012,
      hold: 0.02,
      decay: 0.05,
      offset: rng.range(0, 1.5),
    });
  }

  /**
   * Lamellar plates. Eight to twenty tiny clicks, each its own band between
   * 2 and 4 kHz, scattered over 120 ms with a decaying density — armour settles,
   * it does not rattle evenly.
   */
  private voiceArmourShift(v: Voice, kit: Kit, dest: AudioNode, t0: number, r: number): void {
    const rng = this.streamFor('armour');
    const n = rng.int(9, 19);
    for (let i = 0; i < n; i++) {
      // Front-loaded spread: most plates move at once, a few trail.
      const u = rng.next();
      const at = t0 + u * u * 0.13;
      burst(v, kit, dest, at, {
        type: 'bandpass',
        freq: rng.range(2050, 4100) * r,
        q: rng.range(5, 11),
        peak: rng.range(0.035, 0.1) * (1 - u * 0.55),
        decay: rng.range(0.008, 0.022),
        offset: rng.range(0, 1.8),
      });
    }
    // The mass of the plates as a whole.
    burst(v, kit, dest, t0, { kind: 'pink', type: 'bandpass', freq: 620 * r, q: 1.6, peak: 0.07, decay: 0.09, offset: rng.range(0, 1.5) });
  }

  /** One hoof: a bright leading transient over a low thump on soft ground. */
  private voiceHoof(v: Voice, kit: Kit, dest: AudioNode, t0: number, r: number, accent: number): void {
    const rng = this.streamFor('hoof');
    burst(v, kit, dest, t0, {
      type: 'highpass',
      freq: 2600,
      q: 0.8,
      peak: 0.2 * accent,
      decay: 0.017,
      offset: rng.range(0, 1.5),
    });
    burst(v, kit, dest, t0 + 0.004, {
      kind: 'pink',
      type: 'bandpass',
      freq: 700 * r,
      q: 1.5,
      peak: 0.26 * accent,
      decay: 0.055,
      offset: rng.range(0, 1.5),
    });
    thump(v, kit, dest, t0 + 0.002, 118 * r, 58 * r, 0.4 * accent, 0.1, 0.045);
  }

  /**
   * Wheels. Brown noise through a lowpass with a slow amplitude wobble from the
   * eccentricity of a wooden wheel that was never quite round, plus three axle
   * creaks phased against the wobble so they never land on the same beat.
   */
  private voiceChariot(v: Voice, kit: Kit, dest: AudioNode, t0: number, r: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const rng = this.streamFor('chariot');
    const dur = 1.35;

    const src = v.addSource(ctx.createBufferSource());
    src.buffer = kit.brown;
    src.loop = true;
    src.playbackRate.value = 0.85 * r;

    const lp = v.add(ctx.createBiquadFilter());
    lp.type = 'lowpass';
    lp.frequency.value = 230 * r;
    lp.Q.value = 1.4;

    const body = v.add(ctx.createGain());
    const end = swellEnv(body.gain, t0, 0.42, 0.12, dur * 0.55, dur * 0.4);

    // Eccentricity: one wobble per wheel revolution, about 4.5 Hz at a walk.
    const lfo = v.addSource(ctx.createOscillator());
    lfo.type = 'sine';
    lfo.frequency.value = 4.4 * r;
    const lfoDepth = v.add(ctx.createGain());
    lfoDepth.gain.value = 0.34;
    lfo.connect(lfoDepth);
    lfoDepth.connect(body.gain);

    src.connect(lp);
    lp.connect(body);
    body.connect(dest);
    src.start(t0, rng.range(0, 2));
    src.stop(end + 0.05);
    lfo.start(t0);
    lfo.stop(end + 0.05);
    v.until(end + 0.1);

    for (let i = 0; i < 3; i++) {
      creak(v, kit, dest, t0 + 0.18 + i * rng.range(0.3, 0.44), {
        freq: rng.range(120, 165),
        res: rng.range(1250, 1750),
        wobble: 0.16,
        rate: rng.range(11, 19),
        peak: rng.range(0.05, 0.1),
        dur: rng.range(0.16, 0.26),
      });
    }
  }

  /** Rope and timber taking the load, then the arm going through the air. */
  private voiceTrebuchetRelease(v: Voice, kit: Kit, dest: AudioNode, t0: number, r: number): void {
    const rng = this.streamFor('treb');
    // The groan: two detuned saws sliding down as the tension releases.
    for (let i = 0; i < 2; i++) {
      const g = creak(v, kit, dest, t0 + i * 0.02, {
        freq: (88 + i * 5) * r,
        res: 430 * r,
        wobble: 0.09,
        rate: 7 + i * 2,
        peak: 0.17,
        dur: 0.36,
      });
      void g;
    }
    burst(v, kit, dest, t0, { kind: 'pink', type: 'bandpass', freq: 210 * r, q: 3, peak: 0.12, attack: 0.06, hold: 0.12, decay: 0.2, offset: rng.range(0, 1.5) });
    // The whoosh: a band sweeping up and back down as the arm passes.
    burst(v, kit, dest, t0 + 0.24, {
      type: 'bandpass',
      freq: 320,
      sweepTo: 2500,
      sweepTime: 0.26,
      q: 1.2,
      peak: 0.3,
      attack: 0.1,
      hold: 0.04,
      decay: 0.22,
      offset: rng.range(0, 1.5),
    });
    burst(v, kit, dest, t0 + 0.42, {
      type: 'bandpass',
      freq: 2200,
      sweepTo: 640,
      sweepTime: 0.2,
      q: 1.1,
      peak: 0.16,
      attack: 0.02,
      decay: 0.2,
      offset: rng.range(0, 1.5),
    });
  }

  /** Stone arriving: a body blow, then the shatter. */
  private voiceTrebuchetImpact(v: Voice, kit: Kit, dest: AudioNode, t0: number, r: number): void {
    const rng = this.streamFor('treb-hit');
    thump(v, kit, dest, t0, 96 * r, 36 * r, 0.85, 0.5, 0.1);
    thump(v, kit, dest, t0 + 0.004, 190 * r, 84 * r, 0.3, 0.2, 0.06);
    burst(v, kit, dest, t0, { kind: 'brown', type: 'lowpass', freq: 260 * r, q: 1, peak: 0.5, decay: 0.28, offset: rng.range(0, 2) });

    // Shatter tail: three bands falling away at different rates.
    const bands = [1900, 3100, 4700];
    const decays = [0.26, 0.42, 0.66];
    for (let i = 0; i < 3; i++) {
      burst(v, kit, dest, t0 + 0.012 * i, {
        type: 'bandpass',
        freq: bands[i],
        q: 1.6,
        peak: 0.15 - i * 0.03,
        decay: decays[i],
        offset: rng.range(0, 1.5),
      });
    }
    // Fragments skittering.
    for (let i = 0; i < 11; i++) {
      const u = rng.next();
      burst(v, kit, dest, t0 + 0.05 + u * 0.42, {
        type: 'bandpass',
        freq: rng.range(1400, 3600),
        q: rng.range(6, 14),
        peak: rng.range(0.02, 0.07) * (1 - u * 0.7),
        decay: rng.range(0.01, 0.03),
        offset: rng.range(0, 1.8),
      });
    }
  }

  /** Iron. An inharmonic bank with a hard transient and one very high mode. */
  private voiceBlade(v: Voice, kit: Kit, dest: AudioNode, t0: number, r: number): void {
    const rng = this.streamFor('blade');
    burst(v, kit, dest, t0, { type: 'highpass', freq: 5200, q: 0.7, peak: 0.36, decay: 0.011, offset: rng.range(0, 1.5) });
    modal(v, kit, dest, t0, {
      base: 1180 * r,
      ratios: [1, 2.41, 3.87, 5.62, 7.13],
      decays: [0.85, 0.6, 0.44, 0.3, 0.2],
      gains: [1, 0.6, 0.45, 0.3, 0.2],
      peak: 0.3,
      beat: 1.4,
    });
    // The high ring that says "edge" rather than "bar".
    modal(v, kit, dest, t0 + 0.004, {
      base: 6250 * r,
      ratios: [1, 1.61],
      decays: [0.32, 0.22],
      gains: [1, 0.5],
      peak: 0.07,
      beat: 3,
    });
  }

  /** A shaft going past, and the harness it is braced against. */
  private voiceSpear(v: Voice, kit: Kit, dest: AudioNode, t0: number, r: number): void {
    const rng = this.streamFor('spear');
    burst(v, kit, dest, t0, {
      type: 'bandpass',
      freq: 700 * r,
      sweepTo: 3200 * r,
      sweepTime: 0.1,
      q: 1.3,
      peak: 0.3,
      attack: 0.045,
      decay: 0.1,
      offset: rng.range(0, 1.5),
    });
    creak(v, kit, dest, t0 + 0.02, {
      freq: 225 * r,
      res: 900,
      wobble: 0.13,
      rate: 15,
      peak: 0.1,
      dur: 0.11,
    });
  }

  /** A great deal of air being moved slowly. Attack is the whole cue. */
  private voiceTrunkSweep(v: Voice, kit: Kit, dest: AudioNode, t0: number, r: number): void {
    const rng = this.streamFor('trunk');
    burst(v, kit, dest, t0, {
      kind: 'brown',
      type: 'lowpass',
      freq: 900 * r,
      sweepTo: 250 * r,
      sweepTime: 0.55,
      q: 1.1,
      peak: 0.5,
      attack: 0.22,
      hold: 0.06,
      decay: 0.34,
      offset: rng.range(0, 2),
    });
    burst(v, kit, dest, t0 + 0.05, {
      kind: 'pink',
      type: 'bandpass',
      freq: 420 * r,
      sweepTo: 180 * r,
      sweepTime: 0.4,
      q: 2.2,
      peak: 0.16,
      attack: 0.16,
      decay: 0.3,
      offset: rng.range(0, 1.8),
    });
    // The resonance of the mass itself.
    modal(v, kit, dest, t0 + 0.1, {
      base: 175 * r,
      ratios: [1, 1.87],
      decays: [0.34, 0.22],
      gains: [1, 0.4],
      peak: 0.1,
    });
  }

  /** Weight hitting the ground, wrapped in cloth. */
  private voiceBodyFall(v: Voice, kit: Kit, dest: AudioNode, t0: number, r: number): void {
    const rng = this.streamFor('fall');
    thump(v, kit, dest, t0, 126 * r, 46 * r, 0.55, 0.24, 0.075);
    burst(v, kit, dest, t0, { kind: 'brown', type: 'lowpass', freq: 300 * r, q: 1, peak: 0.34, decay: 0.15, offset: rng.range(0, 2) });
    // Cloth: three overlapping rustles rather than one, so it breathes.
    for (let i = 0; i < 3; i++) {
      burst(v, kit, dest, t0 + 0.02 + i * rng.range(0.05, 0.11), {
        kind: 'pink',
        type: 'bandpass',
        freq: rng.range(2100, 3200),
        q: 1.9,
        peak: rng.range(0.05, 0.1),
        attack: 0.02,
        decay: rng.range(0.08, 0.17),
        offset: rng.range(0, 1.8),
      });
    }
  }

  /**
   * 戰鼓. A membrane, not a kick.
   *
   * A real war drum is a large head under moderate tension over a deep body.
   * The head's modes are the circular-membrane Bessel ratios — 1, 1.593, 2.135,
   * 2.295, 2.917 — none of them harmonic, which is why a drum has a pitch
   * centre without having a note. On top of that: the tension drop as the head
   * deflects (a fast downward glide), the slap of the beater on skin, and the
   * body cavity underneath. Take any one of those away and it collapses into a
   * kick drum.
   */
  private voiceDrum(v: Voice, kit: Kit, dest: AudioNode, t0: number, r: number, weight: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const rng = this.streamFor('drum');
    const f0 = 92 * r;

    // Head excitation: noise through a resonant lowpass whose corner collapses.
    const src = v.addSource(ctx.createBufferSource());
    src.buffer = kit.white;
    src.loop = true;
    const lp = v.add(ctx.createBiquadFilter());
    lp.type = 'lowpass';
    lp.Q.value = 7;
    sweep(lp.frequency, t0, 340 * r, 130 * r, 0.07);
    const hg = v.add(ctx.createGain());
    const he = percEnv(hg.gain, t0, 0.46 * weight, 0.001, 0.2 * weight + 0.06);
    src.connect(lp);
    lp.connect(hg);
    hg.connect(dest);
    src.start(t0, rng.range(0, 1.5));
    src.stop(he + 0.02);
    v.until(he + 0.05);

    // The membrane's own modes.
    modal(v, kit, dest, t0, {
      base: f0,
      ratios: [1, 1.593, 2.135, 2.295, 2.917],
      decays: [0.4 * weight + 0.12, 0.24, 0.17, 0.15, 0.1],
      gains: [1, 0.5, 0.34, 0.28, 0.18],
      peak: 0.44 * weight,
      glide: 0.16,
      glideTime: 0.05,
    });

    // Beater on skin.
    burst(v, kit, dest, t0, {
      type: 'bandpass',
      freq: 1450,
      q: 1.5,
      peak: 0.14 * weight,
      decay: 0.028,
      offset: rng.range(0, 1.5),
    });

    // Body cavity: the long part of a 戰鼓, and what makes it carry outdoors.
    modal(v, kit, dest, t0 + 0.006, {
      base: 61 * r,
      ratios: [1],
      decays: [0.62 * weight + 0.16],
      gains: [1],
      peak: 0.3 * weight,
    });
  }

  /**
   * A large gong. Fourteen modes at no useful ratio at all, each doubled and
   * detuned by a fraction of a hertz so the pair beats slowly against itself —
   * that beating is the shimmer. The upper modes are delayed and given a slow
   * attack, because a struck gong takes the better part of a second to bloom
   * upward, and the fundamental slides down slightly as the metal loads.
   */
  private voiceGong(v: Voice, kit: Kit, dest: AudioNode, t0: number, r: number): void {
    const rng = this.streamFor('gong');
    burst(v, kit, dest, t0, { type: 'bandpass', freq: 2600, q: 0.9, peak: 0.22, decay: 0.06, offset: rng.range(0, 1.5) });
    burst(v, kit, dest, t0, { kind: 'brown', type: 'lowpass', freq: 400, q: 1, peak: 0.2, decay: 0.14, offset: rng.range(0, 2) });

    modal(v, kit, dest, t0, {
      base: 78 * r,
      ratios: [1, 1.19, 1.52, 1.81, 2.13, 2.47, 2.96, 3.42, 3.83, 4.51, 5.12, 5.87, 6.61, 7.4],
      decays: [6.2, 5.6, 5.1, 4.6, 4.1, 3.7, 3.2, 2.9, 2.6, 2.2, 1.9, 1.6, 1.4, 1.2],
      gains: [1, 0.86, 0.78, 0.7, 0.62, 0.55, 0.48, 0.42, 0.37, 0.3, 0.26, 0.21, 0.17, 0.13],
      peak: 0.2,
      beat: 0.55,
      bloom: 0.42,
      glide: 0.012,
      glideTime: 1.4,
    });
  }

  /** Restrained UI. A finger on lacquer, not a notification. */
  private voiceUiTap(v: Voice, kit: Kit, dest: AudioNode, t0: number, r: number): void {
    const rng = this.streamFor('tap');
    burst(v, kit, dest, t0, { type: 'bandpass', freq: 1900 * r, q: 3, peak: 0.14, decay: 0.016, offset: rng.range(0, 1.5) });
    modal(v, kit, dest, t0, { base: 640 * r, ratios: [1, 2.756], decays: [0.05, 0.03], gains: [1, 0.3], peak: 0.13 });
  }

  /** A panel moving. Air across silk. */
  private voiceUiSweep(v: Voice, kit: Kit, dest: AudioNode, t0: number, r: number): void {
    const rng = this.streamFor('sweep');
    burst(v, kit, dest, t0, {
      kind: 'pink',
      type: 'bandpass',
      freq: 420 * r,
      sweepTo: 2600 * r,
      sweepTime: 0.17,
      q: 1.4,
      peak: 0.13,
      attack: 0.06,
      decay: 0.13,
      offset: rng.range(0, 1.8),
    });
  }

  /**
   * Refusal. A dead double-knock on a damped block plus a minor second held for
   * a moment underneath — no beep, no buzzer, and nothing that leaves the
   * material world of the board.
   */
  private voiceIllegal(v: Voice, kit: Kit, dest: AudioNode, t0: number, r: number): void {
    const rng = this.streamFor('illegal');
    for (let i = 0; i < 2; i++) {
      const at = t0 + i * 0.068;
      const amp = i === 0 ? 0.3 : 0.17;
      burst(v, kit, dest, at, { type: 'bandpass', freq: 340 * r, q: 2.2, peak: amp, decay: 0.035, offset: rng.range(0, 1.5) });
      modal(v, kit, dest, at, { base: 168 * r, ratios: [1, 2.756], decays: [0.06, 0.035], gains: [1, 0.25], peak: amp * 0.7 });
    }
    // The sour interval, quiet and short.
    modal(v, kit, dest, t0, {
      base: 233 * r,
      ratios: [1, 1.0595],
      decays: [0.2, 0.2],
      gains: [1, 0.9],
      peak: 0.07,
    });
  }

  // -- hoof sequences ------------------------------------------------------

  /**
   * Gait patterns, as beat offsets within one stride and a per-beat accent.
   * A canter is genuinely three-beat and unevenly spaced — that asymmetry is
   * how a listener knows it is a canter and not a fast trot.
   */
  private static readonly GAITS: Record<HoofPattern, { stride: number; beats: [number, number][] }> = {
    walk: { stride: 1.05, beats: [[0, 0.9], [0.26, 0.7], [0.52, 0.95], [0.78, 0.7]] },
    march: { stride: 0.86, beats: [[0, 1], [0.25, 0.62], [0.5, 0.86], [0.75, 0.62]] },
    canter: { stride: 0.62, beats: [[0, 0.72], [0.13, 0.88], [0.25, 1], [0.44, 0.0]] },
    gallop: { stride: 0.48, beats: [[0, 0.8], [0.09, 0.6], [0.2, 1], [0.29, 0.7]] },
  };

  playHoofs(pattern: HoofPattern, opts?: { gain?: number; pan?: number; delay?: number; beats?: number }): void {
    if (!this.ctx || !this.kit) return;
    const gait = Engine.GAITS[pattern];
    const strides = Math.max(1, Math.floor(opts?.beats ?? 2));
    const started = this.begin(opts?.pan, opts?.gain ?? 1);
    if (!started) return;
    const { voice, dest, kit } = started;
    const base = this.ctx.currentTime + Math.max(0, opts?.delay ?? 0) + 0.005;

    for (let s = 0; s < strides; s++) {
      for (const [off, accent] of gait.beats) {
        if (accent <= 0) continue;
        this.voiceHoof(voice, kit, dest, base + s * gait.stride + off * gait.stride, 1, accent);
      }
    }
  }

  // -- the underscore ------------------------------------------------------

  /**
   * Two detuned oscillators on 宫 and 徵 through a slowly breathing lowpass.
   * This is the only voice that never stops; everything else in the score is
   * scheduled a beat at a time.
   */
  private startUnderscore(): void {
    if (!this.ctx || !this.kit || this.scoreRunning) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const v = new Voice();
    v.endAt = Infinity;

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 460;
    filt.Q.value = 0.9;
    v.add(filt);

    const g = ctx.createGain();
    g.gain.value = EPS;
    g.gain.linearRampToValueAtTime(0.05 + 0.11 * this.smoothIntensity, t + 2.5);
    v.add(g);

    filt.connect(g);
    g.connect(this.music);
    g.connect(this.send);

    // 宫 an octave down, its fifth, and a hair of detune so the pair drifts.
    const partials: [number, OscillatorType, number, number][] = [
      [GONG_HZ * 0.5, 'triangle', 1, 0],
      [GONG_HZ * 0.5, 'sawtooth', 0.22, 0.7],
      [GONG_HZ * 0.75, 'triangle', 0.4, -0.5],
    ];
    for (const [f, type, amp, detune] of partials) {
      const osc = v.addSource(ctx.createOscillator());
      osc.type = type;
      osc.frequency.value = f;
      osc.detune.value = detune;
      const og = v.add(ctx.createGain());
      og.gain.value = amp;
      osc.connect(og);
      og.connect(filt);
      osc.start(t);
    }

    // A very slow filter breath so the drone is never static.
    const lfo = v.addSource(ctx.createOscillator());
    lfo.type = 'sine';
    lfo.frequency.value = 0.055;
    const lfoDepth = v.add(ctx.createGain());
    lfoDepth.gain.value = 110;
    lfo.connect(lfoDepth);
    lfoDepth.connect(filt.frequency);
    lfo.start(t);

    this.drone = v;
    this.droneGain = g;
    this.droneFilter = filt;
    this.nextBeat = t + 0.6;
    this.beatIndex = 0;
    this.scoreRunning = true;
  }

  /** Pump the score: schedule every beat that lands inside the lookahead. */
  private schedule(now: number): void {
    let guard = 0;
    while (this.nextBeat < now + LOOKAHEAD && guard++ < 64) {
      this.emitBeat(this.beatIndex, Math.max(this.nextBeat, now + 0.01));
      this.nextBeat += 60 / Math.max(20, this.smoothBpm);
      this.beatIndex++;
    }
    // If the tab was backgrounded the beat clock can fall far behind; snap it
    // forward rather than firing a hundred catch-up notes.
    if (this.nextBeat < now) this.nextBeat = now + 0.05;
  }

  /**
   * One beat of the score.
   *
   * `intensity` is how much material is still on the board, and it thins the
   * texture rather than turning it down: voices drop out, rests lengthen, and
   * the register falls. An endgame with four pieces left is a single low
   * plucked note every other bar over the drone — which, with `setCadence`
   * pushing the drum faster at the same time, is the shape of the tension.
   */
  private emitBeat(index: number, when: number): void {
    if (!this.ctx || !this.kit) return;
    const rng = seedFor('audio-score', index);
    const i = this.smoothIntensity;
    const inBar = index & 3;
    const bar = index >> 2;

    // --- drum -------------------------------------------------------------
    // The pulse is always on the downbeat; the backbeat and the ghost only
    // arrive as the board fills up.
    const drumGain = 0.2 + 0.32 * i;
    if (inBar === 0) {
      this.playAt('drumBeat', when, drumGain, 0);
    } else if (inBar === 2 && i > 0.3) {
      this.playAt('drumBeat', when, drumGain * 0.66, 0);
    }
    if (i > 0.72 && inBar === 3 && rng.chance(0.4)) {
      this.playAt('drumBeat', when + (60 / this.smoothBpm) * 0.5, drumGain * 0.3, 0);
    }

    // --- register ---------------------------------------------------------
    // Thin boards sit an octave lower. The drop happens once, at 0.45, so it
    // reads as a gear change rather than a slow slide.
    const octave = i < 0.45 ? 0.5 : 1;

    // --- plucked string ---------------------------------------------------
    // Rest probability is the inverse of intensity, so a bare board is mostly
    // silence with an occasional note in it.
    const pluckChance = 0.12 + 0.62 * i;
    if (rng.chance(pluckChance)) {
      const deg = rng.int(0, 4);
      const oct = rng.chance(0.28) ? 2 : 1;
      const freq = GONG_HZ * MODE[deg] * oct * octave * 0.5;
      this.pluck(freq, when, 'qin', 0.22 + 0.12 * i, rng.range(-0.35, 0.35));
    }

    // --- melodic line -----------------------------------------------------
    // Only above half a board, and only on the second half of a bar, so it
    // answers the pluck instead of doubling it.
    if (i > 0.5 && inBar >= 2 && rng.chance(0.3 + 0.35 * i)) {
      const deg = rng.int(0, 4);
      const freq = GONG_HZ * MODE[deg] * 2 * octave;
      const off = (60 / this.smoothBpm) * (rng.chance(0.5) ? 0.5 : 0);
      this.pluck(freq, when + off, 'bright', 0.13 + 0.1 * i, rng.range(-0.5, 0.5));
    }

    // --- a struck note at the top of a phrase ------------------------------
    if (i > 0.25 && bar % 8 === 0 && inBar === 0) {
      this.pluck(GONG_HZ * 0.5 * octave, when, 'qin', 0.2, 0);
    }
  }

  /** Schedule a cue at an absolute AudioContext time. */
  private playAt(cue: AudioCue, when: number, gain: number, pan: number): void {
    if (!this.ctx) return;
    this.play(cue, { gain, pan, delay: Math.max(0, when - this.ctx.currentTime) });
  }

  /** One string note from the Karplus–Strong bank, onto the music bus. */
  private pluck(freq: number, when: number, timbre: 'qin' | 'bright', gain: number, pan: number): void {
    if (!this.ctx || !this.kit) return;
    const ctx = this.ctx;
    if (this.voices.length >= MAX_VOICES) this.voices.shift()?.dispose(ctx.currentTime);

    const v = new Voice();
    const buf = pluckBuffer(this.kit, freq, timbre);
    const src = v.addSource(ctx.createBufferSource());
    src.buffer = buf;

    const g = v.add(ctx.createGain());
    g.gain.value = gain;

    let out: AudioNode = g;
    if (typeof ctx.createStereoPanner === 'function') {
      const p = v.add(ctx.createStereoPanner());
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p);
      out = p;
    }
    src.connect(g);
    out.connect(this.music);
    out.connect(this.send);

    const at = Math.max(when, ctx.currentTime + 0.005);
    src.start(at);
    src.stop(at + buf.duration + 0.02);
    v.until(at + buf.duration + 0.1);
    this.voices.push(v);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the audio engine. Pass nothing in the game; pass a stub context in the
 * offline graph test. Nothing is created until `unlock()` is called from a user
 * gesture — before that the engine is inert and every `play()` is a no-op, which
 * is what the browser's autoplay policy requires.
 */
export function createAudioEngine(opts?: AudioOptions): XiangqiAudio {
  return new Engine(opts);
}
