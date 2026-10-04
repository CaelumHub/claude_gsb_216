/* recorder.js — long-form microphone recorder with live metering.
 *
 * Design notes
 * ------------
 * * Capture uses an AudioWorklet (see recorder-worklet.js) driven by the audio
 *   render thread, so the recording is immune to main-thread jank and even
 *   background throttling.  The device delivers one 128-frame quantum every
 *   ~2.7 ms regardless of input loudness — silence is real audio and is kept
 *   sample-for-sample.
 * * Encoding is uncompressed 16-bit PCM WAV assembled from Blob parts; there
 *   is no per-recording size cap beyond browser memory (a 15-min stereo @48k
 *   session is ~170 MB).  Nothing is trimmed, normalised, or filtered.
 * * Levels (RMS + peak, per channel with decaying peak-hold) come from an
 *   AnalyserNode tap and are only used for the meter — the encoded stream is
 *   untouched.
 * * Stop is a handshake: the worklet drains its tail and reports the exact
 *   frame count, so the WAV duration matches what was captured.
 */

const DEFAULT_RECORD_CONSTRAINTS = {
  // Voice-friendly defaults (browser defaults if left undefined).
  channel: "voice",
};

const MUSIC_RECORD_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

class MicRecorder {
  /**
   * @param {object} cb
   *   onLevels({rms, peak, hold}, channelCount) — animation-frame throttled
   *   onTime(seconds) — authoritative elapsed time (recorded frames / sr)
   *   onData(timeDomainSamples) — analyser buffer for the live waveform
   */
  constructor(cb = {}) {
    this.cb = cb;
    this.state = "idle"; // idle | recording | stopping | done
    this.audioCtx = null;
    this.stream = null;
    this.node = null;
    this.analysers = [];
    this.analyserBufs = [];
    this.splitter = null;
    this.parts = []; // Int16Array PCM chunks
    this.frames = 0;
    this.channels = 0;
    this.sampleRate = 0;
    this.raf = 0;
    this._doneResolve = null;
    this._doneTimer = 0;
  }

  get recording() { return this.state === "recording" || this.state === "stopping"; }

  async start(mode = "voice") {
    if (this.recording) throw new Error("already recording");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("当前浏览器不支持麦克风采集（需要 getUserMedia）");
    }
    if (!window.AudioWorklet || !AudioWorkletNode) {
      throw new Error("当前浏览器不支持 AudioWorklet，无法进行无损录音");
    }

    const audio = mode === "music" ? MUSIC_RECORD_CONSTRAINTS : {};
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 2 },
          ...audio,
        },
      });
    } catch (e) {
      if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) {
        throw new Error("麦克风权限被拒绝，请在浏览器地址栏允许麦克风后重试");
      }
      if (e && (e.name === "NotFoundError" || e.name === "OverconstrainedError")) {
        throw new Error("未检测到可用的麦克风设备");
      }
      throw new Error("无法访问麦克风: " + (e && e.message ? e.message : e));
    }
    this.stream = stream;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new Ctx();
    // Some browsers create the context suspended until a user gesture; start()
    // is always invoked from a click, but resume explicitly to be safe.
    if (this.audioCtx.state === "suspended") {
      try { await this.audioCtx.resume(); } catch (_) { /* noop */ }
    }
    this.sampleRate = this.audioCtx.sampleRate;

    await this.audioCtx.audioWorklet.addModule("/static/js/recorder-worklet.js");

    const source = this.audioCtx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(this.audioCtx, "mic-recorder", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: (stream.getAudioTracks()[0] &&
        stream.getAudioTracks()[0].getSettings().channelCount) || 2,
      channelInterpretation: "discrete",
    });
    this.node = node;
    source.connect(node); // deliberately not connected to destination (no monitoring feedback)

    // A second tap into the analysers for the meter (never touches encoding).
    const monoAnalyser = this.audioCtx.createAnalyser();
    monoAnalyser.fftSize = 2048;
    monoAnalyser.smoothingTimeConstant = 0; // we apply our own decay
    source.connect(monoAnalyser);
    this.analysers = [monoAnalyser];
    this.analyserBufs = [new Float32Array(monoAnalyser.fftSize)];

    // Promote to per-channel meters once the worklet reveals the real count.
    this._perChannelReady = false;
    this._sourceNode = source;

    this.parts = [];
    this.frames = 0;
    this.channels = 0;
    this.state = "recording";
    this._holdDb = [];

    node.port.onmessage = (e) => this._onMessage(e.data);
    this._tick();
  }

  async _promoteAnalysers(ch) {
    if (this._perChannelReady || ch < 2) { this._perChannelReady = true; return; }
    // Add per-channel meters alongside the existing mono tap.  Disconnecting
    // the source would briefly unlink the recording node, so wire the splitter
    // up in parallel instead.
    try {
      const splitter = this.audioCtx.createChannelSplitter(ch);
      const analysers = [];
      const bufs = [];
      for (let c = 0; c < ch; c++) {
        const a = this.audioCtx.createAnalyser();
        a.fftSize = 2048;
        a.smoothingTimeConstant = 0;
        splitter.connect(a, c);
        analysers.push(a);
        bufs.push(new Float32Array(a.fftSize));
      }
      this._sourceNode.connect(splitter);
      this.splitter = splitter;
      this.analysers = analysers;
      this.analyserBufs = bufs;
    } catch (_) {
      // Keep the mono analyser if channel splitting is unavailable.
    }
    this._perChannelReady = true;
  }

  _onMessage(msg) {
    if (!msg) return;
    if (msg.type === "chunk") {
      if (this.channels === 0 && msg.channels > 0) {
        this.channels = msg.channels;
        this._promoteAnalysers(msg.channels);
      }
      // The buffer is transferred; wrap it and keep a reference.
      const pcm = new Int16Array(msg.pcm16);
      this.parts.push(pcm);
      this.frames = msg.totalFrames;
      if (this.cb.onTime) this.cb.onTime(this.frames / this.sampleRate);
    } else if (msg.type === "done") {
      // Worklet has drained everything.
      if (this.cb.onTime) this.cb.onTime(this.frames / this.sampleRate);
      this._finishStop(msg.totalFrames);
    }
  }

  _tick = () => {
    if (!this.recording) return;
    this.raf = requestAnimationFrame(this._tick);
    const levels = [];
    let wave = null;
    for (let c = 0; c < this.analysers.length; c++) {
      const buf = this.analyserBufs[c];
      this.analysers[c].getFloatTimeDomainData(buf);
      let sumSq = 0, peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i];
        sumSq += v * v;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      const instDb = peak > 1e-7 ? 20 * Math.log10(peak) : -60;
      // Peak-hold with ~12 dB/s exponential-ish decay per animation frame.
      const decay = 12 / (1000 / 16.7);
      let hold = this._holdDb[c];
      if (hold == null || instDb > hold) hold = instDb;
      else hold = Math.max(instDb, hold - decay);
      this._holdDb[c] = hold;
      levels.push({ rms, peak, peakDb: instDb, holdDb: hold });
      if (c === 0) wave = buf;
    }
    if (this.cb.onLevels) this.cb.onLevels(levels, this.analysers.length);
    if (this.cb.onData) this.cb.onData(wave);
  };

  /** Ask the worklet to drain and close. Resolves with the final WAV Blob. */
  stop() {
    if (this.state === "done") return this._stopPromise;
    if (!this.recording) return Promise.reject(new Error("not recording"));
    if (this.state === "stopping") return this._stopPromise;
    this.state = "stopping";
    this.node.port.postMessage({ type: "stop" });
    this._stopPromise = new Promise((resolve, reject) => {
      this._doneResolve = resolve;
      // Safety net: if the worklet message is ever lost, still finalise with
      // what we have after 3 s.
      this._doneTimer = setTimeout(() => {
        try { this._finishStop(this.frames); } catch (e) { reject(e); }
      }, 3000);
    });
    return this._stopPromise;
  }

  _finishStop(finalFrames) {
    if (this.state === "done") return;
    const resolve = this._doneResolve;
    clearTimeout(this._doneTimer);
    cancelAnimationFrame(this.raf);
    this.frames = finalFrames || this.frames;
    this.state = "done";

    // Release the hardware and audio graph.
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    const ctx = this.audioCtx;
    if (ctx) { try { ctx.close(); } catch (_) { /* noop */ } }
    this.audioCtx = null;
    this.node = null;
    this.analysers = [];
    this.analyserBufs = [];
    this.splitter = null;

    const ch = this.channels || 1;
    const frames = this.frames;
    const sampleRate = this.sampleRate;
    const blob = buildWavBlob(this.parts, sampleRate, ch, frames);
    this.parts = [];
    if (resolve) resolve({ blob, frames, sampleRate, channels: ch });
  }
}

/**
 * Assemble a canonical 44-byte PCM16 WAV from a list of interleaved Int16Array
 * parts.  The parts are placed directly into a Blob (no giant concatenation),
 * so peak memory stays close to the raw data size.
 */
function buildWavBlob(parts, sampleRate, channels, frames) {
  const bytesPerSample = 2;
  const dataSize = frames * channels * bytesPerSample;
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };

  writeStr(0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true); // PCM fmt chunk size
  v.setUint16(20, 1, true);  // WAVE_FORMAT_PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * bytesPerSample, true); // byte rate
  v.setUint16(32, channels * bytesPerSample, true);              // block align
  v.setUint16(34, 16, true);                                     // bits/sample
  writeStr(36, "data");
  v.setUint32(40, dataSize, true);

  return new Blob([buf, ...parts], { type: "audio/wav" });
}
