const REMOTE_KEYS = [
  'level', 'bass', 'mid', 'treble', 'beat', 'beatCount', 'clip',
  'bpm', 'tempoConf', 'beatPhase', 'tempoBeat', 'tempoBeatCount', 'music', 'energy',
  'kick', 'snare', 'hat', 'kickCount', 'snareCount', 'hatCount',
  'bar', 'beatInBar', 'barPhase', 'phrase', 'phrasePhase', 'downbeat', 'beatTime',
  'build', 'drop', 'dropCount',
  'key', 'keyHue', 'chromaClarity', 'pitchHz', 'pitch', 'centroid', 'flatness', 'harm', 'perc',
  'width', 'pan', 'silence', 'punch', 'sharp',
];

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

    // dynamics: absolute loudness against the loudest thing heard recently,
    // so soft passages calm the visuals instead of being auto-gained up
    this.dynamics = 0.6;   // 0 = ignore loudness, 1 = fully proportional
    this.energy = 1;       // 0..1 smoothed loudness
    this.loudDb = -60;
    this._loudRef = -60;   // slowly decaying peak in dB
    this.loudRange = 30;   // dB below the reference that counts as silent

    // per-band onsets: kick (sub/bass), snare (low mids burst), hat (top end)
    this.kick = 0; this.snare = 0; this.hat = 0;
    this.kickCount = 0; this.snareCount = 0; this.hatCount = 0;
    this._bands = {
      kick:  { lo: 1, hi: 7, hist: new Float32Array(30), i: 0, last: 0, gap: 120, decay: 0.88 },
      snare: { lo: 9, hi: 90, hist: new Float32Array(30), i: 0, last: 0, gap: 110, decay: 0.85 },
      hat:   { lo: 230, hi: 700, hist: new Float32Array(30), i: 0, last: 0, gap: 60, decay: 0.72 },
    };
    this._prevFreqAll = new Uint8Array(1024);

    // bars and phrases (from the tempo tracker plus kick accents)
    this.bar = 0; this.beatInBar = 0; this.barPhase = 0;
    this.phrase = 0; this.phrasePhase = 0; this.downbeat = 0;
    this.beatTime = 0;         // continuous beats, for phase-locked motion
    this._beatAcc = new Float32Array(4);
    this._downbeatPos = 0;
    this._lastTickCount = 0;

    // build / drop
    this.build = 0; this.drop = 0; this.dropCount = 0;
    this._eShort = 0; this._eLong = 0; this._subSlow = 0; this._buildPeak = 0; this._lastDrop = 0;

    // tone
    this.chroma = new Float32Array(12);
    this.key = 0; this.keyHue = 0; this.chromaClarity = 0;
    this._keyCand = 0; this._keyRun = 0;
    this.pitchHz = 0; this.pitch = 0;
    this.centroid = 0; this.flatness = 0; this.harm = 0; this.perc = 0;
    this._mags = new Float32Array(512);
    this._binPc = null; this._binHz = null;
    this._fluxPeak = 0.01;

    // space, silence, envelope shape
    this.width = 0; this.pan = 0;
    this.analyserL = null; this.analyserR = null;
    this._timeL = new Float32Array(1024); this._timeR = new Float32Array(1024);
    this.silence = 0; this._silentSince = 0;
    this.punch = 0; this._fast = 0; this._slow = 0;
    this.sharp = 0; this._prevNl = 0;

    // spectrum history: 64 rows of the spectrum texture row, ~2 s at 30 rows/s
    this.hist = new Uint8Array(512 * 64);
    this.histRow = 0;
    this._histTick = 0;

    this._peak = { level: 0.05, bass: 0.05, mid: 0.05, treble: 0.05, wave: 0.05, spec: 60, sub: 0.05 };
    this._floor = { level: 0, bass: 0, mid: 0, treble: 0, sub: 0 };
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
      for (const side of ['L', 'R']) {
        const a = this.ctx.createAnalyser();
        a.fftSize = 1024;
        this['analyser' + side] = a;
      }
      // bin -> frequency and pitch class (C = 0) for chroma and pitch
      const sr = this.ctx.sampleRate;
      this._binHz = new Float32Array(512);
      this._binPc = new Int8Array(512);
      for (let i = 0; i < 512; i++) {
        const hz = i * sr / 2048;
        this._binHz[i] = hz;
        this._binPc[i] = i >= 2 && hz < 8000 ? ((Math.round(12 * Math.log2(hz / 440)) % 12) + 12 + 9) % 12 : -1;
      }
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
    // stereo taps (a mono source is upmixed, so L = R and width reads 0)
    this._split = this.ctx.createChannelSplitter(2);
    this.source.connect(this._split);
    this._split.connect(this.analyserL, 0);
    this._split.connect(this.analyserR, 1);
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
    if (this._split) { try { this._split.disconnect(); } catch (_) {} this._split = null; }
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
    for (const k of REMOTE_KEYS) if (typeof m[k] === 'number') this[k] = m[k];
    if (m.chroma) this.chroma.set(m.chroma);
    if (m.tex) { this.tex.set(m.tex); this._pushHist(); }
  }

  features() {
    const f = { tex: this.tex, chroma: this.chroma };
    for (const k of REMOTE_KEYS) f[k] = this[k];
    return f;
  }

  // one spectrum row into the history every other frame (~30 rows/s)
  _pushHist() {
    if ((this._histTick++ & 1) !== 0) return;
    this.histRow = (this.histRow + 1) % 64;
    this.hist.set(this.tex.subarray(0, 512), this.histRow * 512);
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
      this.energy += (0.5 - this.energy) * k;
      this.kick *= Math.pow(0.88, q); this.snare *= Math.pow(0.85, q); this.hat *= Math.pow(0.72, q);
      this.drop *= Math.pow(0.97, q); this.build *= Math.pow(0.99, q); this.silence *= Math.pow(0.98, q);
      this.beatTime += dt * 2;     // a 120 BPM idle clock
      this.barPhase = (this.beatTime / 4) % 1;
      for (let i = 0; i < 512; i++) {
        const f = i / 512;
        this.tex[i] = (255 * 0.55 * Math.exp(-f * 9) * (0.6 + 0.4 * pulse) * (0.7 + 0.3 * Math.sin(i * 0.4 + t))) | 0;
        this.tex[512 + i] = ((Math.sin(f * 12.566 + t * 2) * 0.35 * (0.5 + pulse) * 0.5 + 0.5) * 255) | 0;
      }
      this._pushHist();
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

    // loudness: rms in dB against a reference that follows the loudest recent
    // passage and forgets it at about 0.4 dB/s (a 30 dB drop takes ~75 s)
    // integrate over ~0.4 s first (like a loudness meter) so the gaps between
    // kicks don't read as a quiet passage
    const dbInst = 20 * Math.log10(this.rms + 1e-6);
    this.loudDb += (dbInst - this.loudDb) * (1 - Math.pow(0.96, q));
    this._loudRef = Math.max(this.loudDb, this._loudRef - 0.4 * dt, -50);
    const energyRaw = Math.min(1, Math.max(0, (this.loudDb - (this._loudRef - this.loudRange)) / this.loudRange));
    // ease in fast, ease out slow, so a drop hits at once and a breakdown settles gently
    const ek = energyRaw > this.energy ? 1 - Math.pow(0.9, q) : 1 - Math.pow(0.985, q);
    this.energy += (energyRaw - this.energy) * ek;

    const dyn = 1 - this.dynamics * (1 - this.energy);
    this.gain = (1 - this.focus * (1 - this.music)) * dyn;

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
    this._pushHist();

    this._analyseMore(now, dt, q, nl, sub, rm);
  }

  // ---- the rest of the feature set ---------------------------------------

  _analyseMore(now, dt, q, nl, sub, rm) {
    const F = this.freq;

    // per-band onsets on positive spectral flux, each against its own recent mean
    for (const [name, b] of Object.entries(this._bands)) {
      let flux = 0;
      for (let i = b.lo; i < b.hi; i++) { const d = F[i] - this._prevFreqAll[i]; if (d > 0) flux += d; }
      flux /= (b.hi - b.lo) * 255;
      let mean = 0;
      for (let i = 0; i < b.hist.length; i++) mean += b.hist[i];
      mean /= b.hist.length;
      b.hist[b.i] = flux;
      b.i = (b.i + 1) % b.hist.length;
      if (flux > mean * 1.6 + 0.01 && flux > 0.02 && now - b.last > b.gap) {
        b.last = now;
        this[name] = 1;
        this[name + 'Count']++;
      } else {
        this[name] *= Math.pow(b.decay, q);
      }
    }
    // total flux for the percussive measure, before the previous frame is overwritten
    let fluxAll = 0;
    for (let i = 1; i < 300; i++) { const d = F[i] - this._prevFreqAll[i]; if (d > 0) fluxAll += d; }
    fluxAll /= 299 * 255;
    for (let i = 1; i < 700; i++) this._prevFreqAll[i] = F[i];

    // bars: accumulate kick strength per beat position, the strongest is the downbeat
    if (this.tempoBeatCount !== this._lastTickCount) {
      const pos = this.tempoBeatCount % 4;
      this._beatAcc[pos] = this._beatAcc[pos] * 0.9 + this.kick + this.bass * 0.3;
      let best = 0;
      for (let i = 1; i < 4; i++) if (this._beatAcc[i] > this._beatAcc[best]) best = i;
      this._downbeatPos = best;
      this._lastTickCount = this.tempoBeatCount;
      if (((this.tempoBeatCount - this._downbeatPos) % 4 + 4) % 4 === 0) this.downbeat = 1;
    }
    if (this._period > 0 && this.tempoConf > 0.2) {
      const rel = this.tempoBeatCount - this._downbeatPos;
      this.beatInBar = ((rel % 4) + 4) % 4;
      this.bar = Math.floor(rel / 4);
      this.barPhase = (this.beatInBar + this.beatPhase) / 4;
      this.beatTime = this.tempoBeatCount + this.beatPhase;
    } else {
      this.beatTime += dt * 2;
      this.barPhase = (this.beatTime / 4) % 1;
    }
    this.phrase = Math.floor(this.bar / 8);
    this.phrasePhase = ((((this.bar % 8) + 8) % 8) + this.barPhase) / 8;
    this.downbeat *= Math.pow(0.9, q);

    // build: energy rising over bars; drop: sub-bass slams back in after a build
    const e = this.energy;
    this._eShort += (e - this._eShort) * (1 - Math.pow(0.97, q));
    this._eLong += (e - this._eLong) * (1 - Math.pow(0.997, q));
    const buildRaw = Math.max(0, Math.min(1, (this._eShort - this._eLong) * 4));
    this.build += (buildRaw - this.build) * (1 - Math.pow(0.95, q));
    this._buildPeak = Math.max(this.build, this._buildPeak * Math.pow(0.995, q));
    const subN = Math.min(1.5, this._norm('sub', sub, q));
    this._subSlow += (subN - this._subSlow) * (1 - Math.pow(0.98, q));
    if (subN > this._subSlow * 2 + 0.2 && this._buildPeak > 0.3 && now - this._lastDrop > 4000 && this.tempoConf > 0.15) {
      this._lastDrop = now;
      this.drop = 1;
      this.dropCount++;
      this._buildPeak = 0;
    } else {
      this.drop *= Math.pow(0.97, q);
    }

    // linear magnitudes from the byte spectrum (-100..-30 dB)
    const mags = this._mags;
    let sumMag = 0, sumHzMag = 0, sumLog = 0;
    for (let i = 1; i < 512; i++) {
      const m = Math.pow(10, (-100 + F[i] / 255 * 70) / 20);
      mags[i] = m;
      sumMag += m;
      sumHzMag += m * this._binHz[i];
      sumLog += Math.log(m + 1e-9);
    }
    // centroid on a log scale: 100 Hz -> 0, 6.4 kHz -> 1
    const cHz = sumHzMag / (sumMag + 1e-9);
    const cRaw = Math.max(0, Math.min(1, Math.log2(Math.max(cHz, 1) / 100) / 6));
    this.centroid += (cRaw - this.centroid) * (1 - Math.pow(0.9, q));
    // flatness: geometric over arithmetic mean, 1 = white noise
    const gm = Math.exp(sumLog / 511), am = sumMag / 511;
    const flatRaw = Math.max(0, Math.min(1, gm / (am + 1e-9)));
    this.flatness += (flatRaw - this.flatness) * (1 - Math.pow(0.9, q));

    // chroma: pitch-class energy, normalised; key = steadiest strongest class
    const ch = this.chroma;
    const acc = new Float32Array(12);
    for (let i = 2; i < 400; i++) { const pc = this._binPc[i]; if (pc >= 0) acc[pc] += mags[i]; }
    let mx = 1e-9, mean = 0;
    for (let i = 0; i < 12; i++) { if (acc[i] > mx) mx = acc[i]; mean += acc[i]; }
    mean /= 12;
    for (let i = 0; i < 12; i++) ch[i] += (acc[i] / mx - ch[i]) * (1 - Math.pow(0.85, q));
    const clar = Math.max(0, Math.min(1, (mx - mean) / mx));
    this.chromaClarity += (clar - this.chromaClarity) * (1 - Math.pow(0.9, q));
    let cand = 0;
    for (let i = 1; i < 12; i++) if (ch[i] > ch[cand]) cand = i;
    if (cand === this._keyCand) this._keyRun += q; else { this._keyCand = cand; this._keyRun = 0; }
    if (this._keyRun > 25 && cand !== this.key) this.key = cand;
    this.keyHue = this.key / 12;

    // dominant pitch with parabolic interpolation, 55 Hz -> 0, 3.5 kHz -> 1
    let pk = 2;
    for (let i = 3; i < 400; i++) if (F[i] > F[pk]) pk = i;
    if (F[pk] > 40) {
      const a = F[pk - 1], b = F[pk], c = F[pk + 1];
      const off = (a - c) / (2 * (a - 2 * b + c) || 1);
      const hz = (pk + Math.max(-1, Math.min(1, off))) * this._binHz[1];
      this.pitchHz = hz;
      const pRaw = Math.max(0, Math.min(1, Math.log2(hz / 55) / 6));
      this.pitch += (pRaw - this.pitch) * (1 - Math.pow(0.8, q));
    }

    // harmonic vs percussive: percussive = normalised total flux, harmonic = tonal steady energy
    this._fluxPeak = Math.max(fluxAll, this._fluxPeak * Math.pow(0.999, q), 0.01);
    const percRaw = Math.min(1, fluxAll / this._fluxPeak);
    this.perc += (percRaw - this.perc) * (percRaw > this.perc ? 0.5 : 1 - Math.pow(0.9, q));
    const harmRaw = Math.max(0, Math.min(1, nl)) * (1 - this.flatness) * (1 - 0.5 * this.perc);
    this.harm += (harmRaw - this.harm) * (1 - Math.pow(0.9, q));

    // stereo width and pan
    if (this.analyserL && this.analyserR) {
      this.analyserL.getFloatTimeDomainData(this._timeL);
      this.analyserR.getFloatTimeDomainData(this._timeR);
      let l2 = 0, r2 = 0, m2 = 0, s2 = 0;
      for (let i = 0; i < 1024; i++) {
        const l = this._timeL[i], r = this._timeR[i];
        l2 += l * l; r2 += r * r;
        const m = (l + r) * 0.5, s = (l - r) * 0.5;
        m2 += m * m; s2 += s * s;
      }
      const wRaw = Math.min(1, Math.sqrt(s2) / (Math.sqrt(m2) + 1e-6));
      const pRaw = (Math.sqrt(r2) - Math.sqrt(l2)) / (Math.sqrt(l2) + Math.sqrt(r2) + 1e-6);
      this.width += (wRaw - this.width) * (1 - Math.pow(0.9, q));
      this.pan += (pRaw - this.pan) * (1 - Math.pow(0.9, q));
    }

    // silence: well below the loudness reference for a while
    if (this.loudDb < this._loudRef - 40) this._silentSince += dt; else this._silentSince = 0;
    const silRaw = Math.max(0, Math.min(1, (this._silentSince - 1.5) / 2));
    this.silence += (silRaw - this.silence) * (1 - Math.pow(0.95, q));

    // punch: fast envelope over slow envelope
    this._fast = Math.max(nl, this._fast * Math.pow(0.85, q));
    this._slow += (nl - this._slow) * (1 - Math.pow(0.97, q));
    const punchRaw = Math.max(0, Math.min(1, (this._fast / (this._slow + 0.05) - 1) * 0.5));
    this.punch += (punchRaw - this.punch) * (1 - Math.pow(0.8, q));

    // transient sharpness: how steeply the level rises
    const dl = nl - this._prevNl;
    this._prevNl = nl;
    this.sharp = Math.max(dl > 0.05 ? Math.min(1, dl * 3) : 0, this.sharp * Math.pow(0.95, q));
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
