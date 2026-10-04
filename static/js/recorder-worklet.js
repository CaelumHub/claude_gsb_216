/* recorder-worklet.js — AudioWorklet processor used by the recorder.
 *
 * Every render quantum the microphone delivers is forwarded to the main
 * thread exactly as captured: the Float32 interleaved block is transferred
 * (zero-copy) so the audio thread never blocks and long sessions keep every
 * frame — including silent ones, which arrive as ordinary zero-valued blocks
 * as long as the MediaStreamTrack is live.
 *
 * The node exposes one silent output which the main thread routes through a
 * muted gain node to the destination; that keeps the whole graph pulling while
 * guaranteeing no monitor audio is played back (no feedback).
 */
class RecorderWorklet extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const ch = input.length;
      const src0 = input[0];
      const n = src0.length;
      if (n > 0) {
        if (ch === 1) {
          // Copy (the input buffer is owned by the audio graph and must not
          // be transferred directly).
          const mono = new Float32Array(n);
          mono.set(src0);
          this.port.postMessage(
            { frames: n, channels: 1, data: mono },
            [mono.buffer]
          );
        } else {
          const inter = new Float32Array(n * ch);
          for (let c = 0; c < ch; c++) {
            const src = input[c];
            for (let i = 0; i < n; i++) inter[i * ch + c] = src[i];
          }
          this.port.postMessage(
            { frames: n, channels: ch, data: inter },
            [inter.buffer]
          );
        }
      }
    }
    return true; // keep the processor alive for the whole session
  }
}

registerProcessor("recorder-worklet", RecorderWorklet);
