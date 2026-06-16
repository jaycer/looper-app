/* Overdub capture, running on the dedicated audio render thread so it never
 * drops buffers the way a main-thread ScriptProcessor does.
 *
 * Protocol (via port):
 *   main -> worklet: { type: 'start', frameCount, loopEpoch, latencyComp }
 *   main -> worklet: { type: 'stop' }
 *   worklet -> main: { type: 'layer', buffer: Float32Array.buffer }  (transferred)
 *
 * It sums incoming mic samples into a loop-length buffer, aligned to the
 * current loop phase using the audio thread's own `currentTime` / `sampleRate`.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.buffer = null;
    this.frameCount = 0;
    this.loopEpoch = 0;
    this.latencyComp = 0;

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'start') {
        this.frameCount = d.frameCount | 0;
        this.loopEpoch = d.loopEpoch || 0;
        this.latencyComp = d.latencyComp || 0;
        this.buffer = new Float32Array(this.frameCount);
        this.recording = true;
      } else if (d.type === 'stop') {
        this.recording = false;
        const buf = this.buffer;
        this.buffer = null;
        if (buf) {
          this.port.postMessage({ type: 'layer', buffer: buf.buffer }, [buf.buffer]);
        } else {
          this.port.postMessage({ type: 'layer', buffer: null });
        }
      }
    };
  }

  process(inputs) {
    if (this.recording && this.buffer) {
      const input = inputs[0];
      const ch = input && input[0];
      if (ch && this.frameCount > 0) {
        const L = this.frameCount / sampleRate;
        let phase = (currentTime - this.loopEpoch - this.latencyComp) % L;
        if (phase < 0) phase += L;
        let idx = Math.floor(phase * sampleRate) % this.frameCount;
        const buf = this.buffer;
        const n = this.frameCount;
        for (let i = 0; i < ch.length; i++) {
          buf[idx] += ch[i];
          if (++idx >= n) idx = 0;
        }
      }
    }
    return true; // keep the processor alive
  }
}

registerProcessor('capture-processor', CaptureProcessor);
