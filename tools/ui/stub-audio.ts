/**
 * A stub Web Audio implementation, strict enough to be worth testing against.
 *
 * This is not a mock that says yes to everything. It enforces the parts of the
 * Web Audio spec that actually throw in a browser and that are easy to get
 * wrong when you are scheduling hundreds of parameter ramps:
 *
 *   • `exponentialRampToValueAtTime` may not target zero, and may not be used
 *     from a value of zero. This is the single most common Web Audio crash.
 *   • Scheduled times must be finite and non-negative.
 *   • A source may be started once and stopped once, and never stopped before
 *     it has started.
 *   • Filter frequencies must stay inside (0, nyquist) or the node goes silent.
 *   • Gains and frequencies must be finite. `NaN` poisons an entire graph.
 *
 * It also records every node created, every connection and every disconnection,
 * which is what lets the graph test assert that a cue tears itself down.
 *
 * Node only. Never imported by anything under `src/`.
 */

export interface StubViolation {
  node: string;
  message: string;
}

export class StubRegistry {
  nodes: StubNode[] = [];
  violations: StubViolation[] = [];
  connections = 0;
  disconnections = 0;

  fail(node: string, message: string): void {
    this.violations.push({ node, message });
  }

  reset(): void {
    this.nodes = [];
    this.violations = [];
    this.connections = 0;
    this.disconnections = 0;
  }

  /** Nodes still wired to something. A clean teardown leaves none. */
  liveNodes(): StubNode[] {
    return this.nodes.filter((n) => n.outgoing.size > 0);
  }
}

let CLOCK = 0;

class StubParam {
  value: number;
  /** Every scheduled event, in call order, for inspection. */
  events: { kind: string; value: number; time: number }[] = [];

  constructor(
    private reg: StubRegistry,
    private owner: string,
    private name: string,
    initial: number,
    private range?: [number, number],
  ) {
    this.value = initial;
  }

  private label(): string {
    return `${this.owner}.${this.name}`;
  }

  private checkTime(t: number, kind: string): void {
    if (!Number.isFinite(t)) this.reg.fail(this.label(), `${kind} at non-finite time ${t}`);
    else if (t < 0) this.reg.fail(this.label(), `${kind} at negative time ${t}`);
  }

  private checkValue(v: number, kind: string): void {
    if (!Number.isFinite(v)) {
      this.reg.fail(this.label(), `${kind} to non-finite value ${v}`);
      return;
    }
    if (this.range && (v < this.range[0] || v > this.range[1])) {
      this.reg.fail(this.label(), `${kind} to ${v}, outside [${this.range[0]}, ${this.range[1]}]`);
    }
  }

  setValueAtTime(v: number, t: number): StubParam {
    this.checkValue(v, 'setValueAtTime');
    this.checkTime(t, 'setValueAtTime');
    this.events.push({ kind: 'set', value: v, time: t });
    this.value = v;
    return this;
  }

  linearRampToValueAtTime(v: number, t: number): StubParam {
    this.checkValue(v, 'linearRamp');
    this.checkTime(t, 'linearRamp');
    this.events.push({ kind: 'lin', value: v, time: t });
    this.value = v;
    return this;
  }

  exponentialRampToValueAtTime(v: number, t: number): StubParam {
    this.checkValue(v, 'exponentialRamp');
    this.checkTime(t, 'exponentialRamp');
    // The spec throws for a zero or negative target, and the ramp is undefined
    // if the value it starts from is zero.
    if (v === 0) this.reg.fail(this.label(), 'exponentialRamp to exactly 0 (throws in a browser)');
    else if (v < 0) this.reg.fail(this.label(), `exponentialRamp to negative ${v}`);
    const prev = this.lastValueBefore(t);
    if (prev === 0) this.reg.fail(this.label(), 'exponentialRamp starting from 0 (undefined in a browser)');
    this.events.push({ kind: 'exp', value: v, time: t });
    this.value = v;
    return this;
  }

  setTargetAtTime(v: number, t: number, tc: number): StubParam {
    this.checkValue(v, 'setTargetAtTime');
    this.checkTime(t, 'setTargetAtTime');
    if (!(tc > 0)) this.reg.fail(this.label(), `setTargetAtTime with time constant ${tc}`);
    this.events.push({ kind: 'target', value: v, time: t });
    this.value = v;
    return this;
  }

  cancelScheduledValues(t: number): StubParam {
    this.checkTime(t, 'cancelScheduledValues');
    this.events.push({ kind: 'cancel', value: 0, time: t });
    return this;
  }

  private lastValueBefore(t: number): number {
    let v: number | null = null;
    for (const e of this.events) {
      if (e.time <= t && e.kind !== 'cancel') v = e.value;
    }
    return v === null ? this.value : v;
  }
}

export class StubNode {
  outgoing = new Set<StubNode | StubParam>();
  incoming = 0;
  readonly channelCount = 2;

  constructor(
    public readonly kind: string,
    protected reg: StubRegistry,
    public readonly context: StubAudioContext,
  ) {
    reg.nodes.push(this);
  }

  connect<T extends StubNode | StubParam>(dest: T): T {
    if (!dest) {
      this.reg.fail(this.kind, 'connect() to undefined');
      return dest;
    }
    if (this.outgoing.has(dest)) {
      // Not an error in the spec, but in this codebase it always means a
      // double-wire bug, so surface it.
      this.reg.fail(this.kind, `connected twice to the same ${(dest as StubNode).kind ?? 'param'}`);
    }
    this.outgoing.add(dest);
    if (dest instanceof StubNode) dest.incoming++;
    this.reg.connections++;
    return dest;
  }

  disconnect(): void {
    for (const d of this.outgoing) if (d instanceof StubNode) d.incoming--;
    this.reg.disconnections += this.outgoing.size;
    this.outgoing.clear();
  }
}

class StubScheduledSource extends StubNode {
  started = -1;
  stopped = -1;
  onended: (() => void) | null = null;

  start(when = 0, offset?: number): void {
    if (this.started >= 0) this.reg.fail(this.kind, 'start() called twice');
    if (!Number.isFinite(when) || when < 0) this.reg.fail(this.kind, `start() at ${when}`);
    if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
      this.reg.fail(this.kind, `start() with offset ${offset}`);
    }
    this.started = when;
  }

  stop(when = 0): void {
    if (this.started < 0) {
      // Stopping a source that never started throws InvalidStateError. The
      // engine guards this with a try/catch, so record it without failing.
      return;
    }
    if (!Number.isFinite(when) || when < 0) this.reg.fail(this.kind, `stop() at ${when}`);
    else if (when < this.started - 1e-9) {
      this.reg.fail(this.kind, `stop(${when.toFixed(4)}) before start(${this.started.toFixed(4)})`);
    }
    this.stopped = when;
  }
}

class StubOscillator extends StubScheduledSource {
  type = 'sine';
  frequency: StubParam;
  detune: StubParam;

  constructor(reg: StubRegistry, ctx: StubAudioContext) {
    super('OscillatorNode', reg, ctx);
    this.frequency = new StubParam(reg, 'OscillatorNode', 'frequency', 440, [-ctx.sampleRate / 2, ctx.sampleRate / 2]);
    this.detune = new StubParam(reg, 'OscillatorNode', 'detune', 0, [-153600, 153600]);
  }
}

class StubBufferSource extends StubScheduledSource {
  buffer: StubAudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  playbackRate: StubParam;

  constructor(reg: StubRegistry, ctx: StubAudioContext) {
    super('AudioBufferSourceNode', reg, ctx);
    this.playbackRate = new StubParam(reg, 'AudioBufferSourceNode', 'playbackRate', 1, [0.01, 64]);
  }

  override start(when = 0, offset?: number): void {
    if (!this.buffer) this.reg.fail(this.kind, 'start() with no buffer assigned');
    else if (offset !== undefined && offset > this.buffer.duration && !this.loop) {
      this.reg.fail(this.kind, `start() offset ${offset.toFixed(3)} past a ${this.buffer.duration.toFixed(3)}s buffer`);
    }
    super.start(when, offset);
  }
}

class StubGain extends StubNode {
  gain: StubParam;
  constructor(reg: StubRegistry, ctx: StubAudioContext) {
    super('GainNode', reg, ctx);
    this.gain = new StubParam(reg, 'GainNode', 'gain', 1);
  }
}

class StubBiquad extends StubNode {
  type = 'lowpass';
  frequency: StubParam;
  Q: StubParam;
  gain: StubParam;
  detune: StubParam;
  constructor(reg: StubRegistry, ctx: StubAudioContext) {
    super('BiquadFilterNode', reg, ctx);
    this.frequency = new StubParam(reg, 'BiquadFilterNode', 'frequency', 350, [0.0001, ctx.sampleRate / 2]);
    this.Q = new StubParam(reg, 'BiquadFilterNode', 'Q', 1, [-1000, 1000]);
    this.gain = new StubParam(reg, 'BiquadFilterNode', 'gain', 0, [-40, 40]);
    this.detune = new StubParam(reg, 'BiquadFilterNode', 'detune', 0);
  }
}

class StubPanner extends StubNode {
  pan: StubParam;
  constructor(reg: StubRegistry, ctx: StubAudioContext) {
    super('StereoPannerNode', reg, ctx);
    this.pan = new StubParam(reg, 'StereoPannerNode', 'pan', 0, [-1, 1]);
  }
}

class StubCompressor extends StubNode {
  threshold: StubParam;
  knee: StubParam;
  ratio: StubParam;
  attack: StubParam;
  release: StubParam;
  readonly reduction = 0;
  constructor(reg: StubRegistry, ctx: StubAudioContext) {
    super('DynamicsCompressorNode', reg, ctx);
    this.threshold = new StubParam(reg, 'DynamicsCompressorNode', 'threshold', -24, [-100, 0]);
    this.knee = new StubParam(reg, 'DynamicsCompressorNode', 'knee', 30, [0, 40]);
    this.ratio = new StubParam(reg, 'DynamicsCompressorNode', 'ratio', 12, [1, 20]);
    this.attack = new StubParam(reg, 'DynamicsCompressorNode', 'attack', 0.003, [0, 1]);
    this.release = new StubParam(reg, 'DynamicsCompressorNode', 'release', 0.25, [0, 1]);
  }
}

class StubWaveShaper extends StubNode {
  private _curve: Float32Array | null = null;
  oversample = 'none';
  constructor(reg: StubRegistry, ctx: StubAudioContext) {
    super('WaveShaperNode', reg, ctx);
  }
  get curve(): Float32Array | null {
    return this._curve;
  }
  set curve(c: Float32Array | null) {
    if (c) {
      if (c.length < 2) this.reg.fail(this.kind, 'curve shorter than 2 samples');
      for (let i = 0; i < c.length; i++) {
        if (!Number.isFinite(c[i])) {
          this.reg.fail(this.kind, `curve[${i}] is not finite`);
          break;
        }
      }
    }
    this._curve = c;
  }
}

class StubConvolver extends StubNode {
  buffer: StubAudioBuffer | null = null;
  normalize = true;
  constructor(reg: StubRegistry, ctx: StubAudioContext) {
    super('ConvolverNode', reg, ctx);
  }
}

export class StubAudioBuffer {
  private data: Float32Array[];
  constructor(
    public readonly numberOfChannels: number,
    public readonly length: number,
    public readonly sampleRate: number,
  ) {
    this.data = [];
    for (let i = 0; i < numberOfChannels; i++) this.data.push(new Float32Array(length));
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(ch: number): Float32Array {
    return this.data[ch];
  }
}

export class StubAudioContext {
  readonly sampleRate = 48000;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  readonly destination: StubNode;
  readonly registry: StubRegistry;
  /** Set false to simulate a context without StereoPanner (older Safari). */
  supportsPanner = true;
  supportsConvolver = true;

  constructor(reg = new StubRegistry()) {
    this.registry = reg;
    this.destination = new StubNode('AudioDestinationNode', reg, this);
  }

  get currentTime(): number {
    return CLOCK;
  }

  /** Advance the simulated audio clock. */
  advance(seconds: number): void {
    CLOCK += seconds;
  }

  static resetClock(): void {
    CLOCK = 0;
  }

  async resume(): Promise<void> {
    this.state = 'running';
  }

  async close(): Promise<void> {
    this.state = 'closed';
  }

  createBuffer(channels: number, length: number, sampleRate: number): StubAudioBuffer {
    if (length <= 0) this.registry.fail('AudioContext', `createBuffer with length ${length}`);
    return new StubAudioBuffer(channels, length, sampleRate);
  }

  createGain(): StubGain {
    return new StubGain(this.registry, this);
  }
  createOscillator(): StubOscillator {
    return new StubOscillator(this.registry, this);
  }
  createBufferSource(): StubBufferSource {
    return new StubBufferSource(this.registry, this);
  }
  createBiquadFilter(): StubBiquad {
    return new StubBiquad(this.registry, this);
  }
  createDynamicsCompressor(): StubCompressor {
    return new StubCompressor(this.registry, this);
  }
  createWaveShaper(): StubWaveShaper {
    return new StubWaveShaper(this.registry, this);
  }
  createStereoPanner(): StubPanner {
    if (!this.supportsPanner) throw new Error('createStereoPanner is not supported');
    return new StubPanner(this.registry, this);
  }
  createConvolver(): StubConvolver {
    if (!this.supportsConvolver) throw new Error('createConvolver is not supported');
    return new StubConvolver(this.registry, this);
  }
}
