/* recorder-worklet.js — sample-accurate microphone capture node.
 *
 * Runs on the Web Audio render thread.  The audio graph calls process() once
 * per render quantum (128 frames) for as long as the microphone stream is
 * live — including quanta that contain only digital silence.  Every block is
 * encoded unconditionally, so pauses and quiet passages are preserved exactly
 * and nothing is truncated.
 *
 * Float32 samples are interleaved and quantised to signed 16-bit PCM here
 * (trivial load for 128 frames), then transferred to the main thread in
 * fixed-size batches via Transferable ArrayBuffers.
 *
 * Stop handshake: main thread posts {type:"stop"}; after the next quantum
 * boundary the processor flushes its tail, posts {type:"done"} with the exact
 * total frame count, and returns false.  The main thread only releases the
 * microphone after "done", guaranteeing the final block is never cut.
 */

const FLUSH_FRAMES = 4096; // ~85 ms at 48 kHz per transferred batch

class MicRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = 0; // locked from the first input block
    this.pending = null; // Int16Array accumulator (interleaved)
    this.pendingFrames = 0;
    this.totalFrames = 0;
    this.stopping = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === "stop") this.stopping = true;
    };
  }

  _ensureBuffer(ch) {
    this.channels = ch;
    this.pending = new Int16Array(FLUSH_FRAMES * ch);
    this.pendingFrames = 0;
  }

  _flush(final) {
    if (!this.pending || this.pendingFrames === 0) return;
    const n = this.pendingFrames;
    const ch = this.channels;
    // Copy out the filled region so its ArrayBuffer can be transferred.
    const out = this.pending.slice(0, n * ch);
    this.port.postMessage({
      type: "chunk",
      pcm16: out.buffer,
      frames: n,
      channels: ch,
      totalFrames: this.totalFrames,
      final: final,
    }, [out.buffer]);
    this.pendingFrames = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const inCh = input.length;
      if (this.channels === 0) this._ensureBuffer(inCh);
      const ch = this.channels;

      let srcOffset = 0;
      let remaining = input[0].length; // frames in this quantum (always 128)
      while (remaining > 0) {
        if (this.pendingFrames >= FLUSH_FRAMES) this._flush(false);
        const space = FLUSH_FRAMES - this.pendingFrames;
        const take = Math.min(space, remaining);
        const base = this.pendingFrames * ch;

        for (let i = 0; i < take; i++) {
          for (let c = 0; c < ch; c++) {
            // Defensive channel mapping if the layout ever changes mid-stream.
            const src = input[c < inCh ? c : inCh - 1];
            let s = src[srcOffset + i];
            if (s > 1) s = 1;
            else if (s < -1) s = -1;
            // Asymmetric scale preserves the full -32768..32767 PCM range.
            const v = s < 0 ? s * 32768 : s * 32767;
            this.pending[base + i * ch + c] = v | 0;
          }
        }

        this.pendingFrames += take;
        this.totalFrames += take;
        srcOffset += take;
        remaining -= take;
      }
    }
    // An empty input (length 0) only happens when no source is connected; an
    // active microphone always delivers 128 frames per quantum (zeros included).

    if (this.stopping) {
      this._flush(true);
      this.port.postMessage({
        type: "done",
        totalFrames: this.totalFrames,
        channels: this.channels || 1,
      });
      return false; // cease rendering
    }
    return true; // keep the node alive across silent quanta
  }
}

registerProcessor("mic-recorder", MicRecorderProcessor);
