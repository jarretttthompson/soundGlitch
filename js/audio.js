// Audio input and analysis.
// Sources: microphone (any input device), system audio (tab/screen share),
// a silent synthetic test signal, or features mirrored from a controller
// window. Produces normalised features (level, bass, mid, treble, beat), a
// tempo estimate with beat phase, a music-vs-speech confidence, and a 512x2
// byte texture: row 0 = spectrum, row 1 = waveform (both auto-gained).

export class AudioIn {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.source = null;
    this.stream = null;
    this.test = null;
    this.mode = 'off'; // off | mic | system | test | remote
    this.error = null;
    this.deviceId = null;
    this.devices = [];

    this.freq = new Uint8Array(1024);
    this.time = new Float32Array(2048);
    this.tex = new Uint8Array(512 * 2);

    this.level = 0; this.bass = 0; this.mid = 0; this.treble = 0;
    this.beat = 0; this.beatCount = 0; this.rms = 0; this.clip = false;
    this.sens = 1.0;

    // tempo tracker
    this.bpm = 0;
    this.tempoConf = 0;
    this.beatPhase = 0;
    this.nextBeatAt = 0;
    this.tempoBeat = 0;
    this.tempoBeatCount = 0;
    this._flux = new Float32Array(300); // 6 s of onset strength at 50 Hz
    this._fi = 0;
    this._slot = 0;
    this._fluxAcc = 0;
    this._fluxN = 0;
    this._prevFreq = new Uint8Array(1024);
    this._lastTempoCalc = 0;
    this._period = 0;
    this._phaseRef = 0;
    this._lastTick = -1;

    // music focus (speech / announcement ducking)
    this.focus = 0.5;
    this.music = 1;
    this.gain = 1;

    this._peak = { level: 0.05, bass: 0.05, mid: 0.05, treble: 0.05, wave: 0.05, spec: 60 };
    this._floor = { level: 0, bass: 0, mid: 0, treble: 0 };
    this._specFloor = new Float32Array(512);
    this._specTmp = new Float32Array(512);
    this._hist = new Float32Array(40);
    this._hi = 0;
    this._lastBeat = 0;
    this._lastT = performance.now();
  }

  // ---- sources -----------------------------------------------------------

  async ensureCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.55;
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  async listDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      this.devices = all.filter(d => d.kind === 'audioinput');
    } catch (_) { this.devices = []; }
    return this.devices;
  }

  async startMic(deviceId = this.deviceId) {
    await this.ensureCtx();
    this.stop(false);
    this.error = null;
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (deviceId) audio.deviceId = { exact: deviceId };
    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio });
      } catch (e) {
        if (!deviceId) throw e;
        // stored device gone: fall back to the default input
        delete audio.deviceId;
        stream = await navigator.mediaDevices.getUserMedia({ audio });
        deviceId = null;
      }
      this._useStream(stream, 'mic');
      this.deviceId = deviceId || null;
      await this.listDevices();
    } catch (e) {
      this.error = e.name === 'NotAllowedError' ? 'MIC DENIED' : 'MIC: ' + e.message;
      this.mode = 'off';
      throw e;
    }
  }

  // Tab / screen share audio. Chrome insists on a video track in the request;
  // it is stopped immediately and only the audio track is kept.
  async startSystem() {
    await this.ensureCtx();
    this.stop(false);
    this.error = null;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      stream.getVideoTracks().forEach(t => t.stop());
      if (!stream.getAudioTracks().length) {
        this.error = 'NO AUDIO SHARED (tick "share audio")';
        this.mode = 'off';
        throw new Error(this.error);
      }
      const audioOnly = new MediaStream(stream.getAudioTracks());
      this._useStream(audioOnly, 'system');
    } catch (e) {
      if (!this.error) this.error = e.name === 'NotAllowedError' ? 'SHARE CANCELLED' : 'SYSTEM: ' + e.message;
      this.mode = 'off';
      throw e;
    }
  }

  _useStream(stream, mode) {
    this.stream = stream;
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.analyser);
    this.mode = mode;
    const track = stream.getAudioTracks()[0];
    if (track) track.onended = () => { if (this.mode === mode) this.stop(); };
  }

  // Silent synthetic signal routed only into the analyser: kick pulses,
  // a sweeping saw lead and noise bursts. Lets the visuals run without a mic.
  async startTest() {
    await this.ensureCtx();
    this.stop(false);
    this.error = null;
    const c = this.ctx;
    const out = c.createGain();
    out.gain.value = 1;
    out.connect(this.analyser);

    const kick = c.createOscillator();
    kick.type = 'sine';
    kick.frequency.value = 52;
    const kg = c.createGain();
    kg.gain.value = 0;
    kick.connect(kg).connect(out);

    const lead = c.createOscillator();
    lead.type = 'sawtooth';
    lead.frequency.value = 220;
    const lg = c.createGain();
    lg.gain.value = 0.12;
    lead.connect(lg).connect(out);

    const lfo = c.createOscillator();
    lfo.frequency.value = 0.11;
    const lfoG = c.createGain();
    lfoG.gain.value = 500;
    lfo.connect(lfoG).connect(lead.frequency);

    const len = c.sampleRate * 2;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const noise = c.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const ng = c.createGain();
    ng.gain.value = 0;
    noise.connect(ng).connect(out);

    let step = 0;
    const timer = setInterval(() => {
      const t = c.currentTime;
      kg.gain.cancelScheduledValues(t);
      kg.gain.setValueAtTime(0.9, t);
      kg.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
      if (step % 4 === 2) {
        ng.gain.setValueAtTime(0.5, t);
        ng.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      }
      if (step % 8 === 7) lead.frequency.setValueAtTime(110 + Math.random() * 600, t);
      step++;
    }, 480);

    [kick, lead, lfo, noise].forEach(n => n.start());
    this.test = { nodes: [kick, lead, lfo, noise], timer, out };
    this.mode = 'test';
  }

  stop(setOff = true) {
    if (this.source) { try { this.source.disconnect(); } catch (_) {} this.source = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    if (this.test) {
      clearInterval(this.test.timer);
      this.test.nodes.forEach(n => { try { n.stop(); } catch (_) {} });
      try { this.test.out.disconnect(); } catch (_) {}
      this.test = null;
    }
    if (setOff) this.mode = 'off';
  }

  // Features mirrored from a controller window (output mode).
  applyRemote(m) {
    this.mode = 'remote';
    this.level = m.level; this.bass = m.bass; this.mid = m.mid; this.treble = m.treble;
    this.beat = m.beat; this.beatCount = m.beatCount; this.clip = m.clip;
    this.bpm = m.bpm; this.tempoConf = m.tempoConf; this.beatPhase = m.beatPhase;
    this.tempoBeat = m.tempoBeat; this.tempoBeatCount = m.tempoBeatCount; this.music = m.music;
    if (m.tex) this.tex.set(m.tex);
  }

  features() {
    return {
      level: this.level, bass: this.bass, mid: this.mid, treble: this.treble,
      beat: this.beat, beatCount: this.beatCount, clip: this.clip,
      bpm: this.bpm, tempoConf: this.tempoConf, beatPhase: this.beatPhase,
      tempoBeat: this.tempoBeat, tempoBeatCount: this.tempoBeatCount, music: this.music,
      tex: this.tex,
    };
  }

  // ---- analysis ----------------------------------------------------------

  _norm(key, v, q) {
    const f = this._floor, p = this._peak;
    // very slowly rising noise floor (about 30 s to absorb a steady hiss),
    // instant drop, never more than half the tracked peak so drones survive
    f[key] = Math.min(v, f[key] + 0.00004 * q, p[key] * 0.5);
    v = Math.max(0, v - f[key]);
    // slow-decaying peak with a hard minimum so silence isn't amplified
    // (rms sits lower than the byte-spectrum band averages, hence the smaller floor)
    p[key] = Math.max(v, p[key] * Math.pow(0.9985, q), key === 'level' ? 0.015 : 0.04);
    return Math.min(1.5, v / p[key]);
  }

  _smooth(cur, target, q) {
    const k = target > cur ? 0.55 : 0.14;
    return cur + (target - cur) * (1 - Math.pow(1 - k, q));
  }

  update() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this._lastT) / 1000);
    this._lastT = now;
    const q = dt / 0.0166;

    if (this.mode === 'remote') return;

    if (!this.analyser || this.mode === 'off') {
      // idle drive: a faint synthetic pulse so the screen isn't dead before input starts
      const t = now / 1000;
      const k = 1 - Math.pow(0.9, q);
      const pulse = 0.5 + 0.5 * Math.sin(t * 1.3);
      this.level += (0.12 + 0.1 * pulse - this.level) * k;
      this.bass += (0.1 + 0.15 * pulse - this.bass) * k;
      this.mid += (0.12 + 0.06 * Math.sin(t * 0.7) - this.mid) * k;
      this.treble += (0.08 - this.treble) * k;
      this.beat *= Math.pow(0.88, q);
      this.tempoBeat *= Math.pow(0.85, q);
      for (let i = 0; i < 512; i++) {
        const f = i / 512;
        this.tex[i] = (255 * 0.55 * Math.exp(-f * 9) * (0.6 + 0.4 * pulse) * (0.7 + 0.3 * Math.sin(i * 0.4 + t))) | 0;
        this.tex[512 + i] = ((Math.sin(f * 12.566 + t * 2) * 0.35 * (0.5 + pulse) * 0.5 + 0.5) * 255) | 0;
      }
      return;
    }

    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getFloatTimeDomainData(this.time);

    // rms / peak
    let s = 0, pk = 0;
    for (let i = 0; i < 2048; i++) { const v = this.time[i]; s += v * v; if (Math.abs(v) > pk) pk = Math.abs(v); }
    this.rms = Math.sqrt(s / 2048);
    this.clip = pk > 0.985;

    const avg = (a, b) => { let t = 0; for (let i = a; i < b; i++) t += this.freq[i]; return t / ((b - a) * 255); };
    // bins are ~21.5 Hz at 44.1 kHz / 2048
    const rb = avg(1, 13);      // < 280 Hz
    const rm = avg(13, 110);    // 280 Hz .. 2.4 kHz
    const rt = avg(110, 700);   // 2.4 kHz .. 15 kHz
    const sub = avg(1, 5);      // < 110 Hz, speech has almost none

    // onset strength: positive spectral flux across bass + mids
    let flux = 0;
    for (let i = 1; i < 110; i++) {
      const d = this.freq[i] - this._prevFreq[i];
      if (d > 0) flux += d;
      this._prevFreq[i] = this.freq[i];
    }
    this._tempo(now, flux / (109 * 255), q);

    // music focus: tempo confidence + sub-bass presence, fast attack / slow release
    const subRatio = sub / (rm + 1e-4);
    const musicRaw = Math.min(1, this.tempoConf * 2.0) * 0.6 + Math.min(1, subRatio * 1.5) * 0.4;
    const mk = musicRaw > this.music ? 1 - Math.pow(0.97, q) : 1 - Math.pow(0.992, q);
    this.music += (musicRaw - this.music) * mk;
    this.gain = 1 - this.focus * (1 - this.music);

    const sens = this.sens * this.gain;
    const nl = Math.min(1.5, this._norm('level', this.rms, q) * sens);
    const nb = Math.min(1.5, this._norm('bass', rb, q) * sens);
    const nm = Math.min(1.5, this._norm('mid', rm, q) * sens);
    const nt = Math.min(1.5, this._norm('treble', rt, q) * sens);

    this.level = this._smooth(this.level, nl, q);
    this.bass = this._smooth(this.bass, nb, q);
    this.mid = this._smooth(this.mid, nm, q);
    this.treble = this._smooth(this.treble, nt, q);

    // beat: bass onset vs ~0.65 s history
    const h = this._hist;
    let mean = 0;
    for (let i = 0; i < h.length; i++) mean += h[i];
    mean /= h.length;
    h[this._hi] = nb;
    this._hi = (this._hi + 1) % h.length;
    if (nb > mean * 1.35 + 0.08 && nb > 0.3 && now - this._lastBeat > 170) {
      this._lastBeat = now;
      this.beatCount++;
      this.beat = 1;
    } else {
      this.beat *= Math.pow(0.88, q);
    }

    // texture row 0: spectrum with a slow per-bin noise floor (80% subtracted so
    // held tones survive) and a slow-decaying peak gain, so a quiet mic still
    // fills the 0..1 range the shaders expect
    const p = this._peak;
    const sf = this._specFloor, st = this._specTmp;
    let mx = 0;
    for (let i = 0; i < 512; i++) {
      let v = this.freq[i];
      sf[i] = Math.min(v, sf[i] + 0.06 * q);
      v = Math.max(0, v - sf[i] * 0.8);
      st[i] = v;
      if (v > mx) mx = v;
    }
    p.spec = Math.max(mx, p.spec * Math.pow(0.999, q), 30);
    const sg = Math.min(5, 235 / p.spec) * Math.sqrt(sens);
    // row 1: auto-gained waveform
    p.wave = Math.max(pk, p.wave * Math.pow(0.999, q), 0.03);
    const g = 0.9 / p.wave;
    for (let i = 0; i < 512; i++) {
      this.tex[i] = Math.min(255, st[i] * sg) | 0;
      const v = Math.max(-1, Math.min(1, this.time[i * 4] * g));
      this.tex[512 + i] = ((v * 0.5 + 0.5) * 255) | 0;
    }
  }

  // ---- tempo -------------------------------------------------------------

  _tempo(now, flux, q) {
    // commit onset strength into 20 ms slots
    const slot = Math.floor(now / 20);
    if (slot !== this._slot) {
      if (this._slot) {
        const v = this._fluxN ? this._fluxAcc / this._fluxN : 0;
        const n = Math.min(slot - this._slot, 300);
        for (let i = 0; i < n; i++) { this._flux[this._fi] = v; this._fi = (this._fi + 1) % 300; }
      }
      this._slot = slot;
      this._fluxAcc = 0;
      this._fluxN = 0;
    }
    this._fluxAcc += flux;
    this._fluxN++;

    if (now - this._lastTempoCalc > 500) {
      this._lastTempoCalc = now;
      this._estimateTempo(now);
    }

    if (this._period > 0) {
      const raw = ((now - this._phaseRef) / this._period) % 1;
      this.beatPhase = raw < 0 ? raw + 1 : raw;
      this.nextBeatAt = now + (1 - this.beatPhase) * this._period;
      const tick = Math.floor((now - this._phaseRef) / this._period);
      if (tick !== this._lastTick) {
        this._lastTick = tick;
        if (this.tempoConf > 0.25) { this.tempoBeat = 1; this.tempoBeatCount++; }
      }
    }
    this.tempoBeat *= Math.pow(0.85, q);
  }

  // Autocorrelation of the last 6 s of onset strength over 60..188 BPM,
  // then a comb search for the beat phase.
  _estimateTempo(now) {
    const x = new Float32Array(300);
    let mean = 0;
    for (let i = 0; i < 300; i++) { x[i] = this._flux[(this._fi + i) % 300]; mean += x[i]; }
    mean /= 300;
    let energy = 0;
    for (let i = 0; i < 300; i++) { x[i] -= mean; energy += x[i] * x[i]; }
    if (energy < 1e-7) { this.tempoConf *= 0.7; return; }

    // normalised autocorrelation per lag (each lag has a different number of terms)
    // lags 16..60 = 188..50 BPM; ac runs to twice that for the octave check
    const ac = new Float32Array(121);
    for (let lag = 16; lag <= 120; lag++) {
      let r = 0;
      for (let i = lag; i < 300; i++) r += x[i] * x[i - lag];
      ac[lag] = r / (energy * (300 - lag) / 300);
    }
    let best = 0, bestLag = 0;
    for (let lag = 16; lag <= 60; lag++) {
      // a true beat period also correlates at twice the lag; a 3:2 alias does not
      let score = ac[lag] + 0.5 * ac[lag * 2];
      // mild preference for tempos near 120 so half/double picks settle
      const bpm = 3000 / lag;
      score *= 1 - 0.25 * Math.abs(Math.log(bpm / 120));
      if (score > best) { best = score; bestLag = lag; }
    }
    if (bestLag === 0) { this.tempoConf *= 0.7; return; }
    const conf = Math.max(0, Math.min(1, ac[bestLag]));
    this.tempoConf = this.tempoConf * 0.5 + conf * 0.5;
    if (conf < 0.15) return;

    let bestPh = 0, bestS = -1e9;
    for (let ph = 0; ph < bestLag; ph++) {
      let s = 0;
      for (let i = ph; i < 300; i += bestLag) s += x[i];
      if (s > bestS) { bestS = s; bestPh = ph; }
    }
    const period = bestLag * 20;
    const refT = now - (299 - bestPh) * 20;
    const close = this._period && Math.abs(period - this._period) / this._period < 0.08;
    this._period = close ? this._period * 0.7 + period * 0.3 : period;
    // keep the phase reference near "now" so float error never accumulates
    this._phaseRef = refT;
    this._lastTick = Math.floor((now - this._phaseRef) / this._period);
    this.bpm = 60000 / this._period;
  }
}
