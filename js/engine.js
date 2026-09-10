// WebGL2 feedback engine.
//
// Two layers, each with its own ping-pong framebuffers running one feedback
// mode, and a second pair per layer for crossfading (the outgoing mode keeps
// running while the post pass mixes it out). Modes may carry a simulation
// shader that steps a separate state buffer each frame (reaction-diffusion).
// A source texture (image or camera) can be burned into the main layer's
// feedback and/or overlaid clean in the post pass.

import { VERT, COMMON, MODES, POST, MIX, SIM_PRELUDE, SOURCE } from './shaders.js';

const smooth = t => t * t * (3 - 2 * t);
const SIM_STEPS = 8;

class Layer {
  constructor() {
    this.mode = 0;
    this.fromMode = 0;
    this.fadeT = 1;   // 0..1 progress of the crossfade (1 = not fading)
    this.fadeDur = 0;
    this.fbos = null;
    this.fbosB = null;
    this.read = 0;
    this.readB = 0;
    this.sim = null;
    this.simRead = 0;
    this.simMode = -1;
    this.palette = 0;
    this.palFrom = 0;
    this.palT = 1;
    this.palDur = 0;
    this.seed = [0.5, 0.5, 0.5, 0.5];
    this.fromSeed = this.seed;
    // opacity, so a layer can fade in when switched on and out when switched off
    this.alpha = 1;
    this.alphaTarget = 1;
    this.alphaDur = 0;
    this.pendingOff = false;
    // how this layer composites over the ones below (unused for layer 0)
    this.blend = 1;
    this.blendFrom = 1;
    this.blendT = 1;
    this.blendDur = 0;
  }
  get fading() { return this.fadeT < 1; }
}
const sameSeed = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    this.halfFloat = !!gl.getExtension('EXT_color_buffer_float');
    this.scale = 0.7;

    this.layers = [new Layer(), new Layer(), new Layer()];
    for (const L of this.layers.slice(1)) { L.mode = -1; L.alpha = 0; L.alphaTarget = 0; }
    this.fx = { mirror: 0, pixel: 0, hue: 0, poster: 0 };
    this.mirrorFrom = 0;
    this.mirrorT = 1;
    this.mirrorDur = 0;

    this.programs = MODES.map(m => this._link(COMMON + m.src, m.name));
    this.sims = MODES.map(m => (m.sim ? this._link(SIM_PRELUDE + m.sim, m.name + ' sim') : null));
    this.post = this._link(POST, 'POST');
    this.mix = this._link(MIX, 'MIX');
    this.sourceProg = this._link(SOURCE, 'SOURCE');
    this.uniforms = new Map();

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.audioTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.audioTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 512, 2, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    this._texParams();

    // source (image / camera)
    this.srcTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    this._texParams();
    this.srcKind = 'none'; // none | image | video
    this.srcAspect = 1;
    this.srcVideo = null;
    this.src = { burn: 0, opacity: 0, size: 0.5, x: 0.5, y: 0.5 };

    this.frame = 0;
    this.resize();
  }

  _texParams() {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  // ---- programs ----------------------------------------------------------

  _compile(type, src, label) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(`[${label}] shader compile failed:\n${gl.getShaderInfoLog(sh)}`);
    }
    return sh;
  }

  _link(fs, label) {
    const gl = this.gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, this._compile(gl.VERTEX_SHADER, VERT, label + ' vert'));
    gl.attachShader(prog, this._compile(gl.FRAGMENT_SHADER, fs, label));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`[${label}] link failed: ${gl.getProgramInfoLog(prog)}`);
    }
    return prog;
  }

  _u(prog, name) {
    let m = this.uniforms.get(prog);
    if (!m) { m = new Map(); this.uniforms.set(prog, m); }
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(prog, name));
    return m.get(name);
  }

  // ---- framebuffers ------------------------------------------------------

  _fbo(w, h, float = false, clear = [0, 0, 0, 1]) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this._texParams();
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(...clear);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, tex, w, h };
  }

  _freePair(pair) {
    const gl = this.gl;
    if (!pair) return;
    for (const f of pair) { gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); }
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr * this.scale));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr * this.scale));
    if (this.canvas.width === w && this.canvas.height === h && this.layers[0].fbos) return;
    this.canvas.width = w;
    this.canvas.height = h;
    for (const L of this.layers) {
      this._freePair(L.fbos);
      this._freePair(L.fbosB);
      this._freePair(L.sim);
      L.fbos = [this._fbo(w, h), this._fbo(w, h)];
      L.fbosB = [this._fbo(w, h), this._fbo(w, h)];
      L.sim = null;
      L.simMode = -1;
      L.read = 0;
      L.readB = 0;
    }
  }

  setScale(s) {
    this.scale = Math.min(1, Math.max(0.2, s));
    this.resize();
  }

  clear() {
    const gl = this.gl;
    for (const L of this.layers) {
      for (const f of [...L.fbos, ...L.fbosB]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      L.simMode = -1; // re-seed on next use
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _ensureSim(L, modeIndex) {
    const gl = this.gl;
    const w = Math.max(2, Math.floor(this.canvas.width * 0.6));
    const h = Math.max(2, Math.floor(this.canvas.height * 0.6));
    if (!L.sim || L.sim[0].w !== w || L.sim[0].h !== h) {
      this._freePair(L.sim);
      L.sim = [this._fbo(w, h, this.halfFloat, [1, 0, 0, 1]), this._fbo(w, h, this.halfFloat, [1, 0, 0, 1])];
      L.simRead = 0;
      L.simMode = modeIndex;
    } else if (L.simMode !== modeIndex) {
      for (const f of L.sim) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
        gl.clearColor(1, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      L.simMode = modeIndex;
    }
  }

  // ---- source (image / camera) ------------------------------------------

  setSourceImage(img) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.srcAspect = img.naturalWidth ? img.naturalWidth / img.naturalHeight : img.width / img.height;
    this.srcKind = 'image';
    this.srcVideo = null;
  }

  setSourceVideo(video) {
    this.srcVideo = video;
    this.srcKind = 'video';
  }

  clearSource() {
    this.srcKind = 'none';
    this.srcVideo = null;
  }

  _srcRect() {
    const size = this.src.size;
    const h = size;
    const w = size * this.srcAspect * (this.canvas.height / this.canvas.width);
    return [this.src.x - w / 2, this.src.y - h / 2, w, h];
  }

  _uploadVideo() {
    const v = this.srcVideo;
    if (!v || v.readyState < 2 || !v.videoWidth) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.srcAspect = v.videoWidth / v.videoHeight;
  }

  // ---- transitions -------------------------------------------------------

  // Write the layer's visible composite (main mixed with outgoing) into the
  // outgoing pair, so a new fade starts from exactly what is on screen.
  _snapshotToB(L) {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    const dst = L.fbosB[1 - L.readB];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.mix);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, L.fbos[L.read].tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, L.fbosB[L.readB].tex);
    gl.uniform1i(this._u(this.mix, 'uTex'), 0);
    gl.uniform1i(this._u(this.mix, 'uTex2'), 1);
    gl.uniform2f(this._u(this.mix, 'uRes'), w, h);
    gl.uniform1f(this._u(this.mix, 'uMix'), L.fadeT < 1 ? smooth(L.fadeT) : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    L.readB = 1 - L.readB;
  }

  // Change a layer's mode and/or variation seed; either change crossfades.
  // Switching a layer off (i < 0) fades its opacity out and only then stops
  // it; switching on fades it in.
  setMode(i, dur = 0, layer = 0, seed = null) {
    const L = this.layers[layer];
    const seedChanged = !!seed && !sameSeed(seed, L.seed);
    if (i < 0) {
      if (L.mode < 0 && !L.pendingOff) return;
      if (dur > 0) { L.alphaTarget = 0; L.alphaDur = dur; L.pendingOff = true; }
      else { L.mode = -1; L.alpha = 0; L.alphaTarget = 0; L.pendingOff = false; }
      return;
    }
    const wasOff = L.mode < 0;
    if (!wasOff && i === L.mode && !seedChanged) {
      // same look, but maybe cancel a pending fade-out
      if (L.pendingOff) { L.pendingOff = false; L.alphaTarget = 1; L.alphaDur = dur || 0.01; }
      return;
    }
    if (dur > 0 && L.fbos && !wasOff) {
      this._snapshotToB(L);
      L.fromMode = L.mode;
      L.fromSeed = L.seed;
      L.fadeT = 0;
      L.fadeDur = dur;
    } else {
      L.fadeT = 1;
    }
    if (wasOff) {
      L.alpha = dur > 0 ? 0 : 1;
      if (this.layers.indexOf(L) > 0 && L.fbos) this._clearPair(L.fbos); // start clean, not from stale frames
    }
    L.pendingOff = false;
    L.alphaTarget = 1;
    L.alphaDur = dur;
    L.mode = i;
    if (seed) L.seed = seed.slice();
  }

  _clearPair(pair) {
    const gl = this.gl;
    for (const f of pair) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Blend modes are discrete, so a change crossfades the two results.
  setBlend(i, dur = 0, layer = 1) {
    const L = this.layers[layer];
    if (i === L.blend) return;
    if (dur > 0) {
      L.blendFrom = L.blendT < 0.5 ? L.blendFrom : L.blend;
      L.blendT = 0;
      L.blendDur = dur;
    } else {
      L.blendT = 1;
    }
    L.blend = i;
  }

  get mode() { return this.layers[0].mode; }
  set mode(i) { this.layers[0].mode = i; }
  get fading() { return this.layers[0].fading; }

  setPalette(i, dur = 0, layer = 0) {
    const L = this.layers[layer];
    if (i === L.palette) return;
    if (dur > 0) {
      // mid-fade: keep whichever palette is currently more visible as the start
      L.palFrom = L.palT < 0.5 ? L.palFrom : L.palette;
      L.palT = 0;
      L.palDur = dur;
    } else {
      L.palT = 1;
    }
    L.palette = i;
  }
  // Mirror segments are discrete, so a change crossfades the two folds in the post pass.
  setMirror(m, dur = 0) {
    if (m === this.fx.mirror) return;
    if (dur > 0) {
      this.mirrorFrom = this.mirrorT < 0.5 ? this.mirrorFrom : this.fx.mirror;
      this.mirrorT = 0;
      this.mirrorDur = dur;
    } else {
      this.mirrorT = 1;
    }
    this.fx.mirror = m;
  }

  get palette() { return this.layers[0].palette; }
  set palette(i) { this.layers[0].palette = i; }

  // ---- rendering ---------------------------------------------------------

  _setAudioUniforms(prog, audio, params, time, dt, seed) {
    const gl = this.gl;
    gl.uniform2f(this._u(prog, 'uRes'), this.canvas.width, this.canvas.height);
    // the seed also offsets time so every look starts at a different phase
    gl.uniform1f(this._u(prog, 'uTime'), time + seed[0] * 977);
    gl.uniform4f(this._u(prog, 'uSeed'), seed[0], seed[1], seed[2], seed[3]);
    gl.uniform1f(this._u(prog, 'uDt'), dt);
    gl.uniform1f(this._u(prog, 'uLevel'), audio.level);
    gl.uniform1f(this._u(prog, 'uBass'), audio.bass);
    gl.uniform1f(this._u(prog, 'uMid'), audio.mid);
    gl.uniform1f(this._u(prog, 'uTreble'), audio.treble);
    gl.uniform1f(this._u(prog, 'uBeat'), audio.beat);
    gl.uniform1f(this._u(prog, 'uBeatCount'), audio.beatCount);
    gl.uniform1f(this._u(prog, 'uCorrupt'), params.corrupt);
    gl.uniform1f(this._u(prog, 'uDecay'), this.decayEff(params));
    gl.uniform1f(this._u(prog, 'uSens'), params.sens);
  }

  // slider 0..1 maps to a usable per-frame persistence of 0.82..0.995
  decayEff(params) { return 0.82 + 0.175 * Math.min(1, Math.max(0, params.decay)); }

  _stepSim(L, modeIndex, audio, params, time, dt) {
    const gl = this.gl;
    this._ensureSim(L, modeIndex);
    const prog = this.sims[modeIndex];
    const w = L.sim[0].w, h = L.sim[0].h;
    gl.useProgram(prog);
    gl.viewport(0, 0, w, h);
    gl.uniform1i(this._u(prog, 'uSim'), 0);
    gl.uniform1i(this._u(prog, 'uAudio'), 1);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.audioTex);
    this._setAudioUniforms(prog, audio, params, time, dt, L.seed);
    gl.uniform2f(this._u(prog, 'uRes'), w, h);
    for (let s = 0; s < SIM_STEPS; s++) {
      const src = L.sim[L.simRead], dst = L.sim[1 - L.simRead];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1f(this._u(prog, 'uStep'), s);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      L.simRead = 1 - L.simRead;
    }
  }

  _drawMode(L, modeIndex, seed, srcTex, dst, audio, params, time, dt) {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    const prog = this.programs[modeIndex];
    const palMix = L.palT < 1 ? smooth(L.palT) : 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.audioTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, L.sim ? L.sim[L.simRead].tex : this.audioTex);
    gl.uniform1i(this._u(prog, 'uPrev'), 0);
    gl.uniform1i(this._u(prog, 'uAudio'), 1);
    gl.uniform1i(this._u(prog, 'uSim'), 2);
    this._setAudioUniforms(prog, audio, params, time, dt, seed);
    gl.uniform1i(this._u(prog, 'uPalette'), palMix > 0 ? L.palFrom : L.palette);
    gl.uniform1i(this._u(prog, 'uPaletteTo'), L.palette);
    gl.uniform1f(this._u(prog, 'uPalMix'), palMix);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _inject(dst, amount) {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.sourceProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.uniform1i(this._u(this.sourceProg, 'uSrc'), 0);
    gl.uniform2f(this._u(this.sourceProg, 'uRes'), w, h);
    gl.uniform4f(this._u(this.sourceProg, 'uRect'), ...this._srcRect());
    gl.uniform1f(this._u(this.sourceProg, 'uAmount'), amount);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
  }

  _renderLayer(L, audio, params, time, dt, inject) {
    if (L.mode < 0) return null;
    if (L.alpha !== L.alphaTarget) {
      const step = dt / Math.max(0.01, L.alphaDur);
      L.alpha = L.alpha < L.alphaTarget ? Math.min(L.alphaTarget, L.alpha + step) : Math.max(L.alphaTarget, L.alpha - step);
      if (L.alpha === 0 && L.pendingOff) { L.pendingOff = false; L.mode = -1; return null; }
    }
    if (L.fadeT < 1) L.fadeT = Math.min(1, L.fadeT + dt / Math.max(0.01, L.fadeDur));
    if (L.palT < 1) L.palT = Math.min(1, L.palT + dt / Math.max(0.01, L.palDur));
    const fading = L.fadeT < 1;

    const simIdx = MODES[L.mode].sim ? L.mode : (fading && MODES[L.fromMode].sim ? L.fromMode : -1);
    if (simIdx >= 0) this._stepSim(L, simIdx, audio, params, time, dt);

    let outTex = null;
    if (fading) {
      const src = L.fbosB[L.readB], dst = L.fbosB[1 - L.readB];
      this._drawMode(L, L.fromMode, L.fromSeed, src.tex, dst, audio, params, time, dt);
      if (inject) this._inject(dst, inject);
      L.readB = 1 - L.readB;
      outTex = dst.tex;
    }
    const src = L.fbos[L.read], dst = L.fbos[1 - L.read];
    this._drawMode(L, L.mode, L.seed, src.tex, dst, audio, params, time, dt);
    if (inject) this._inject(dst, inject);
    L.read = 1 - L.read;
    return { tex: dst.tex, outTex: outTex || dst.tex, mix: fading ? smooth(L.fadeT) : 1, alpha: smooth(L.alpha) };
  }

  render(audio, params, time, dt) {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.audioTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 512, 2, gl.RED, gl.UNSIGNED_BYTE, audio.tex);
    if (this.srcKind === 'video') this._uploadVideo();

    const hasSrc = this.srcKind !== 'none';
    // burn amount scaled so the steady state stays around the source's own brightness
    const burn = hasSrc && this.src.burn > 0 ? this.src.burn * (1 - this.decayEff(params)) * 1.5 : 0;

    const A = this._renderLayer(this.layers[0], audio, params, time, dt, burn);
    const B = this._renderLayer(this.layers[1], audio, params, time, dt, 0);
    const C = this._renderLayer(this.layers[2], audio, params, time, dt, 0);

    // post pass to screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    const P = this.post;
    gl.useProgram(P);
    const bind = (unit, tex) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); };
    bind(0, A.tex);
    bind(1, A.outTex);
    bind(2, B ? B.tex : A.tex);
    bind(3, B ? B.outTex : A.tex);
    bind(4, this.srcTex);
    bind(5, C ? C.tex : A.tex);
    bind(6, C ? C.outTex : A.tex);
    gl.uniform1i(this._u(P, 'uTex'), 0);
    gl.uniform1i(this._u(P, 'uTex2'), 1);
    gl.uniform1i(this._u(P, 'uTexB'), 2);
    gl.uniform1i(this._u(P, 'uTexB2'), 3);
    gl.uniform1i(this._u(P, 'uSrc'), 4);
    gl.uniform1i(this._u(P, 'uTexC'), 5);
    gl.uniform1i(this._u(P, 'uTexC2'), 6);
    gl.uniform1f(this._u(P, 'uMix'), A.mix);
    gl.uniform1f(this._u(P, 'uMixB'), B ? B.mix : 1);
    gl.uniform1f(this._u(P, 'uAlphaB'), B ? B.alpha : 0);
    gl.uniform1f(this._u(P, 'uMixC'), C ? C.mix : 1);
    gl.uniform1f(this._u(P, 'uAlphaC'), C ? C.alpha : 0);
    for (const [L, name] of [[this.layers[1], ''], [this.layers[2], 'C']]) {
      if (L.blendT < 1) L.blendT = Math.min(1, L.blendT + dt / Math.max(0.01, L.blendDur));
      gl.uniform1i(this._u(P, 'uBlend' + name), L.blend);
      gl.uniform1i(this._u(P, 'uBlend' + name + 'From'), L.blendFrom);
      gl.uniform1f(this._u(P, 'uBlend' + name + 'Mix'), L.blendT < 1 ? smooth(L.blendT) : 1);
    }
    gl.uniform4f(this._u(P, 'uSrcRect'), ...this._srcRect());
    gl.uniform1f(this._u(P, 'uSrcOpacity'), hasSrc ? this.src.opacity : 0);
    if (this.mirrorT < 1) this.mirrorT = Math.min(1, this.mirrorT + dt / Math.max(0.01, this.mirrorDur));
    gl.uniform1f(this._u(P, 'uMirror'), this.fx.mirror);
    gl.uniform1f(this._u(P, 'uMirrorFrom'), this.mirrorFrom);
    gl.uniform1f(this._u(P, 'uMirrorMix'), this.mirrorT < 1 ? smooth(this.mirrorT) : 1);
    gl.uniform1f(this._u(P, 'uPixel'), this.fx.pixel);
    gl.uniform1f(this._u(P, 'uHue'), this.fx.hue);
    gl.uniform1f(this._u(P, 'uPoster'), this.fx.poster);
    gl.uniform2f(this._u(P, 'uRes'), w, h);
    gl.uniform1f(this._u(P, 'uTime'), time);
    gl.uniform1f(this._u(P, 'uBeat'), audio.beat);
    gl.uniform1f(this._u(P, 'uLevel'), audio.level);
    gl.uniform1f(this._u(P, 'uTreble'), audio.treble);
    gl.uniform1f(this._u(P, 'uCorrupt'), params.corrupt);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.frame++;
  }

  // Debug helper: mean brightness of the current screen buffer (0..255).
  probe() {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let s = 0, lit = 0;
    for (let i = 0; i < px.length; i += 4) {
      const v = (px[i] + px[i + 1] + px[i + 2]) / 3;
      s += v;
      if (v > 24) lit++;
    }
    return { mean: s / (w * h), litFrac: lit / (w * h), w, h };
  }
}
