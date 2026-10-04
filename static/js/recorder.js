/* recorder.js — Sample-accurate microphone recorder.
 *
 * Capture path
 * ------------
 *   getUserMedia  →  AudioContext (at the hardware sample rate)
 *                 →  AudioWorklet ("recorder-worklet.js")
 *
 * The worklet posts every render quantum (128 frames) to the main thread.
 * Each block is converted from Float32 to interleaved Int16 PCM and appended
 * to a growable buffer.  Nothing is dropped, resampled, trimmed or
 * silence-stripped: gaps and pauses stay in the recording as zero-amplitude
 * samples, so the saved WAV is a faithful, gapless capture.
 *
 * On stop() the accumulated PCM is wrapped in a standard 16-bit PCM WAV Blob;
 * its duration is exactly frames / sampleRate.  A ScriptProcessorNode path is
 * kept as a fallback for browsers without AudioWorklet — it captures the same
 * way (every audioprocess block), so the guarantee is identical.
 *
 * Usage:
 *   const rec = new MicRecorder();
 *   await rec.start({ deviceId, voiceMode });
 *   rec.frames; rec.sampleRate; rec.channels; rec.rms(); rec.peak();
 *   rec.readTrace(arr, channel);
 *   const blob = await rec.stop();   // WAV Blob, null if < 1 frame captured
 */

const WORKLET_URL = "/static/js/recorder-worklet.js";

class MicRecorder {
  constructor() {
    this.state = "idle"; // idle | recording | stopped
    this.stream = null;
    this.audioCtx = null;
    this.source = null;
    this.node = null;
    this.workletReady = false;
    this.fallback = false;
    this._mutedGain = null;

    this.sampleRate = 0;
    this.channels = 0; // known once the first block arrives
    this.frames = 0;
    this._capacity = 0;
    this._pcm = null; // interleaved Int16 PCM, grows geometrically

    // Instantaneous per-channel meters (updated per captured block).
    this._rms = [0, 0];
    this._peak = [0, 0];
    this.clip = [false, false];

    // Short rolling trace for the live waveform (Float32, mono/stereo).
    this._traceLen = 4096;
    this._trace = [new Float32Array(this._traceLen), new Float32Array(this._traceLen)];
    this._tracePos = 0;
    this._traceFilled = 0;
  }

  static supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  async start({ deviceId = null, voiceMode = false } = {}) {
    if (this.state === "recording") throw new Error("already recording");
    this._reset();

    // All voice-processing constraints default OFF so that long silences and
    // quiet material are recorded faithfully.  "人声优化" opts into them.
    const audio = {
      echoCancellation: voiceMode,
      noiseSuppression: voiceMode,
      autoGainControl: voiceMode,
    };
    if (deviceId) audio.deviceId = { exact: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio });

    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new Ctx();
    if (this.audioCtx.state === "suspended") {
      try { await this.audioCtx.resume(); } catch (_) { /* noop */ }
    }
    this.sampleRate = this.audioCtx.sampleRate;
    this.source = this.audioCtx.createMediaStreamSource(this.stream);

    // Actual channel count of the device track (may be undefined).
    const track = this.stream.getAudioTracks()[0] || null;
    const settings = track && track.getSettings ? track.getSettings() : {};
    const trackCh = settings.channelCount || 0;

    try {
      await this.audioCtx.audioWorklet.addModule(WORKLET_URL);
      this.workletReady = true;
    } catch (e) {
      this.workletReady = false;
    }

    if (this.workletReady) {
      this.node = new AudioWorkletNode(this.audioCtx, "recorder-worklet", {
        numberOfInputs: 1,
        numberOfOutputs: 1, // silent output, used to pull the graph
        outputChannelCount: [trackCh || 2],
        // Keep the channels the mic actually delivers (no up/down-mixing).
        channelCount: trackCh || 2,
        channelCountMode: trackCh ? "explicit" : "max",
        channelInterpretation: "discrete",
      });
      this.node.port.onmessage = (ev) => this._accept(ev.data);
      this.node.port.onmessageerror = () => { /* ignore */ };
      this.source.connect(this.node);
      // Route the silent output through a muted gain to the destination so
      // the graph keeps rendering with zero risk of feedback.
      this._mutedGain = this.audioCtx.createGain();
      this._mutedGain.gain.value = 0;
      this.node.connect(this._mutedGain);
      this._mutedGain.connect(this.audioCtx.destination);
    } else {
      // Fallback: ScriptProcessorNode (deprecated but widely available).
      this.fallback = true;
      const N = 4096;
      this.node = this.audioCtx.createScriptProcessor(N, trackCh || 2, trackCh || 2);
      this.node.onaudioprocess = (ev) => {
        const inp = ev.inputBuffer;
        const ch = inp.numberOfChannels;
        const n = inp.length;
        const inter = new Float32Array(n * ch);
        for (let c = 0; c < ch; c++) {
          const data = inp.getChannelData(c);
          for (let i = 0; i < n; i++) inter[i * ch + c] = data[i];
        }
        this._accept({ frames: n, channels: ch, data: inter });
      };
      this.source.connect(this.node);
      this.node.connect(this.audioCtx.destination); // required to fire events
    }

    this.state = "recording";
  }

  _reset() {
    this.state = "idle";
    this.sampleRate = 0;
    this.channels = 0;
    this.frames = 0;
    this._capacity = 0;
    this._pcm = null;
    this._rms = [0, 0];
    this._peak = [0, 0];
    this.clip = [false, false];
    this._tracePos = 0;
    this._traceFilled = 0;
    this._trace = [new Float32Array(this._traceLen), new Float32Array(this._traceLen)];
  }

  /** Accept one interleaved/de-interleavable Float32 block from the capture. */
  _accept(msg) {
    if (this.state !== "recording" || !msg || !msg.frames) return;
    let { frames: n, channels: ch, data } = msg;

    if (this.channels === 0) this.channels = ch;

    // Defensive channel adaptation (settings hint may differ from reality).
    if (ch !== this.channels) {
      data = this._adaptChannels(data, n, ch, this.channels);
      ch = this.channels;
    }

    // Per-channel metering + rolling trace.
    const rms = [0, 0], peak = [0, 0];
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        const v = data[i * ch + c];
        const av = v < 0 ? -v : v;
        rms[c] += v * v;
        if (av > peak[c]) peak[c] = av;
        if (av >= 1.0) this.clip[c] = true;
      }
    }
    for (let c = 0; c < ch; c++) {
      this._rms[c] = Math.sqrt(rms[c] / n);
      this._peak[c] = peak[c];
      this._trace[c] && this._pushTrace(c, data, n, ch);
    }

    // Convert to interleaved Int16 and append.
    const need = (this.frames + n) * ch;
    if (need > this._capacity) {
      let cap = Math.max(this._capacity || (1 << 16), 1);
      while (cap < need) cap *= 2;
      const grown = new Int16Array(cap);
      if (this._pcm) grown.set(this._pcm);
      this._pcm = grown;
      this._capacity = cap;
    }
    let w = this.frames * ch;
    for (let i = 0, len = n * ch; i < len; i++) {
      const s = data[i];
      this._pcm[w++] = s < -1 ? -32768 : s >= 1 ? 32767 : (s * 32768) | 0;
    }
    this.frames += n;
  }

  _adaptChannels(data, n, fromCh, toCh) {
    const out = new Float32Array(n * toCh);
    if (fromCh === 1 && toCh === 2) {
      for (let i = 0; i < n; i++) { const v = data[i]; out[i * 2] = v; out[i * 2 + 1] = v; }
    } else if (fromCh >= 2 && toCh === 1) {
      for (let i = 0; i < n; i++) out[i] = 0.5 * (data[i * fromCh] + data[i * fromCh + 1]);
    } else {
      for (let i = 0; i < n; i++)
        for (let c = 0; c < toCh; c++) out[i * toCh + c] = data[i * fromCh] || 0;
    }
    return out;
  }

  _pushTrace(c, data, n, ch) {
    const ring = this._trace[c];
    let p = this._tracePos;
    for (let i = 0; i < n; i++) {
      ring[p] = data[i * ch + c];
      p = (p + 1) % this._traceLen;
    }
    if (c === 0) {
      this._tracePos = p;
      this._traceFilled = Math.min(this._traceFilled + n, this._traceLen);
    }
  }

  /** Copy the most recent trace samples (chronological) into `out`. */
  readTrace(out, channel = 0) {
    const ring = this._trace[channel] || this._trace[0];
    const filled = channel === 0 ? this._traceFilled : this._traceFilled;
    const n = Math.min(out.length, filled);
    const start = (this._tracePos - n + this._traceLen) % this._traceLen;
    for (let i = 0; i < n; i++) out[i] = ring[(start + i) % this._traceLen];
    for (let i = n; i < out.length; i++) out[i] = 0;
    return n;
  }

  rms(channel = 0) { return this._rms[Math.min(channel, this.channels - 1)] || 0; }
  peak(channel = 0) { return this._peak[Math.min(channel, this.channels - 1)] || 0; }

  get elapsed() { return this.sampleRate ? this.frames / this.sampleRate : 0; }

  /** Stop capture and return a WAV Blob (null if nothing was captured). */
  stop() {
    return new Promise((resolve) => {
      if (this.state !== "recording") { resolve(null); return; }
      // Disconnect the graph; blocks already queued on the main thread are
      // delivered by the event loop before the WAV is assembled below.
      try { this.node && this.node.disconnect(); } catch (_) { /* noop */ }
      try { this.source && this.source.disconnect(); } catch (_) { /* noop */ }
      try { this._mutedGain && this._mutedGain.disconnect(); } catch (_) { /* noop */ }
      if (this.fallback && this.node) this.node.onaudioprocess = null;
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());

      const finish = () => {
        this.state = "stopped";
        const ctx = this.audioCtx;
        if (ctx) { try { ctx.close(); } catch (_) { /* noop */ } }
        this.audioCtx = null;
        if (!this.frames) { resolve(null); return; }
        resolve(buildWavBlob(this._pcm.subarray(0, this.frames * this.channels),
                             this.frames, this.channels, this.sampleRate));
      };

      // One extra task: lets any final queued worklet messages flush.
      if (this.workletReady) setTimeout(finish, 30);
      else setTimeout(finish, 0);
    });
  }

  /** Abort without producing a file. */
  async cancel() {
    const blob = await this.stop();
    if (blob) { try { URL.revokeObjectURL(URL.createObjectURL(blob)); } catch (_) {} }
  }
}

/* ------------------------------------------------------------------ WAV I/O */

function buildWavBlob(pcmInt16, frames, channels, sampleRate) {
  const bytesPerSample = 2;
  const dataLen = frames * channels * bytesPerSample;
  const buf = new ArrayBuffer(44);
  const dv = new DataView(buf);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };

  writeStr(0, "RIFF");
  dv.setUint32(4, 36 + dataLen, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  dv.setUint32(16, 16, true);                 // PCM fmt chunk size
  dv.setUint16(20, 1, true);                  // WAVE_FORMAT_PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * bytesPerSample, true); // byte rate
  dv.setUint16(32, channels * bytesPerSample, true);               // block align
  dv.setUint16(34, 16, true);                 // bits per sample
  writeStr(36, "data");
  dv.setUint32(40, dataLen, true);

  // Copy only the used prefix of the growable buffer into one contiguous Blob.
  return new Blob([buf, pcmInt16], { type: "audio/wav" });
}
