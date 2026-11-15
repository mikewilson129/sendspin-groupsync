/**
 * Mic capture
 * Records the microphone continuously through an AudioWorklet and keeps the
 * last few seconds in a ring buffer. Every sample is stamped with its audio
 * frame number, so the audio hardware clock is the only clock that matters
 * and main-thread stalls cannot shift the timing.
 */

const WORKLET_SOURCE = `
class GroupSyncCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
    this.start = 0;
  }
  flush() {
    if (this.n > 0) {
      this.port.postMessage({ start: this.start, samples: this.buf.slice(0, this.n) });
      this.n = 0;
    }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) { this.flush(); return true; }
    if (this.n === 0) this.start = currentFrame;
    this.buf.set(ch, this.n);
    this.n += ch.length;
    if (this.n + ch.length > this.buf.length) this.flush();
    return true;
  }
}
registerProcessor('groupsync-capture', GroupSyncCapture);
`;

const RING_SECONDS = 14;
const TARGET_RATE = 16000;

export class MicCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;

  private decimation = 1;
  private ring = new Float32Array(0);
  /** Decimated samples written so far (absolute index of the next sample) */
  private written = 0;
  private acc = 0;
  private level = 0;

  /** Sample rate of the samples handed out by read() */
  get sampleRate(): number {
    return this.context ? this.context.sampleRate / this.decimation : TARGET_RATE;
  }

  /** Seconds of audio captured so far, on the audio clock */
  get now(): number {
    return this.written / this.sampleRate;
  }

  /** Recent input level, 0..1 */
  get currentLevel(): number {
    return this.level;
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone is not available. The page must be opened over HTTPS.');
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch {
      throw new Error('Microphone access was denied');
    }

    const context = new AudioContext();
    this.context = context;
    this.decimation = Math.max(1, Math.round(context.sampleRate / TARGET_RATE));
    this.ring = new Float32Array(Math.ceil(RING_SECONDS * this.sampleRate));
    this.written = 0;
    this.acc = 0;

    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    const source = context.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(context, 'groupsync-capture');
    node.port.onmessage = (event: MessageEvent<{ start: number; samples: Float32Array }>) => {
      this.ingest(event.data.start, event.data.samples);
    };
    // Route through a silent gain so the graph is pulled without playing the mic back
    const silent = context.createGain();
    silent.gain.value = 0;
    source.connect(node);
    node.connect(silent);
    silent.connect(context.destination);
    this.node = node;

    if (context.state === 'suspended') await context.resume();
  }

  stop(): void {
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.context && this.context.state !== 'closed') void this.context.close();
    this.context = null;
  }

  /**
   * Copy out the samples between two times on the audio clock.
   * Returns null if that stretch is not (or no longer) in the buffer.
   */
  read(fromS: number, toS: number): { samples: Float32Array; t0: number } | null {
    const fs = this.sampleRate;
    const first = Math.ceil(fromS * fs);
    const last = Math.min(this.written, Math.floor(toS * fs));
    if (last <= first || first < this.written - this.ring.length || first < 0) return null;
    const out = new Float32Array(last - first);
    for (let i = 0; i < out.length; i++) out[i] = this.ring[(first + i) % this.ring.length];
    return { samples: out, t0: first / fs };
  }

  private ingest(startFrame: number, samples: Float32Array): void {
    const d = this.decimation;
    // A gap in frame numbers means audio was dropped: skip ahead, leaving silence
    const expectedFrame = this.written * d;
    if (startFrame >= expectedFrame + d) {
      const skipTo = Math.floor(startFrame / d);
      for (let m = this.written; m < skipTo && m < this.written + this.ring.length; m++) {
        this.ring[m % this.ring.length] = 0;
      }
      this.written = skipTo;
      this.acc = 0;
    }

    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      const frame = startFrame + i;
      const v = samples[i];
      sumSq += v * v;
      if (frame < this.written * d) continue;
      this.acc += v;
      if ((frame + 1) % d === 0) {
        this.ring[this.written % this.ring.length] = this.acc / d;
        this.written++;
        this.acc = 0;
      }
    }
    if (samples.length > 0) this.level = Math.sqrt(sumSq / samples.length);
  }
}
