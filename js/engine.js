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
  }
  get fading() { return this.fadeT < 1; }
}

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    this.halfFloat = !!gl.getExtension('EXT_color_buffer_float');
    this.scale = 0.7;

    this.layers = [new Layer(), new Layer()];
    this.layers[1].mode = -1;
    this.blend = 1;

    this.palette = 0;
    this.palFrom = 0;
    this.palT = 1;
    this.palDur = 0;

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

  setMode(i, dur = 0, layer = 0) {
    const L = this.layers[layer];
    if (i === L.mode) return;
    if (dur > 0 && L.fbos && L.mode >= 0 && i >= 0) {
      this._snapshotToB(L);
      L.fromMode = L.mode;
      L.fadeT = 0;
      L.fadeDur = dur;
    } else {
      L.fadeT = 1;
    }
    L.mode = i;
  }

  get mode() { return this.layers[0].mode; }
  set mode(i) { this.layers[0].mode = i; }
  get fading() { return this.layers[0].fading; }

  setPalette(i, dur = 0) {
    if (i === this.palette) return;
    if (dur > 0) {
      // mid-fade: keep whichever palette is currently more visible as the start
      this.palFrom = this.palT < 0.5 ? this.palFrom : this.palette;
      this.palT = 0;
      this.palDur = dur;
    } else {
      this.palT = 1;
    }
    this.palette = i;
  }

  // ---- rendering ---------------------------------------------------------

  _setAudioUniforms(prog, audio, params, time, dt) {
    const gl = this.gl;
    gl.uniform2f(this._u(prog, 'uRes'), this.canvas.width, this.canvas.height);
    gl.uniform1f(this._u(prog, 'uTime'), time);
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
    this._setAudioUniforms(prog, audio, params, time, dt);
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

  _drawMode(L, modeIndex, srcTex, dst, audio, params, time, dt) {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    const prog = this.programs[modeIndex];
    const palMix = this.palT < 1 ? smooth(this.palT) : 0;
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
    this._setAudioUniforms(prog, audio, params, time, dt);
    gl.uniform1i(this._u(prog, 'uPalette'), palMix > 0 ? this.palFrom : this.palette);
    gl.uniform1i(this._u(prog, 'uPaletteTo'), this.palette);
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
    if (L.fadeT < 1) L.fadeT = Math.min(1, L.fadeT + dt / Math.max(0.01, L.fadeDur));
    const fading = L.fadeT < 1;

    const simIdx = MODES[L.mode].sim ? L.mode : (fading && MODES[L.fromMode].sim ? L.fromMode : -1);
    if (simIdx >= 0) this._stepSim(L, simIdx, audio, params, time, dt);

    let outTex = null;
    if (fading) {
      const src = L.fbosB[L.readB], dst = L.fbosB[1 - L.readB];
      this._drawMode(L, L.fromMode, src.tex, dst, audio, params, time, dt);
      if (inject) this._inject(dst, inject);
      L.readB = 1 - L.readB;
      outTex = dst.tex;
    }
    const src = L.fbos[L.read], dst = L.fbos[1 - L.read];
    this._drawMode(L, L.mode, src.tex, dst, audio, params, time, dt);
    if (inject) this._inject(dst, inject);
    L.read = 1 - L.read;
    return { tex: dst.tex, outTex: outTex || dst.tex, mix: fading ? smooth(L.fadeT) : 1 };
  }

  render(audio, params, time, dt) {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;

    if (this.palT < 1) this.palT = Math.min(1, this.palT + dt / Math.max(0.01, this.palDur));

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.audioTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 512, 2, gl.RED, gl.UNSIGNED_BYTE, audio.tex);
    if (this.srcKind === 'video') this._uploadVideo();

    const hasSrc = this.srcKind !== 'none';
    // burn amount scaled so the steady state stays around the source's own brightness
    const burn = hasSrc && this.src.burn > 0 ? this.src.burn * (1 - this.decayEff(params)) * 1.5 : 0;

    const A = this._renderLayer(this.layers[0], audio, params, time, dt, burn);
    const B = this._renderLayer(this.layers[1], audio, params, time, dt, 0);

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
    gl.uniform1i(this._u(P, 'uTex'), 0);
    gl.uniform1i(this._u(P, 'uTex2'), 1);
    gl.uniform1i(this._u(P, 'uTexB'), 2);
    gl.uniform1i(this._u(P, 'uTexB2'), 3);
    gl.uniform1i(this._u(P, 'uSrc'), 4);
    gl.uniform1f(this._u(P, 'uMix'), A.mix);
    gl.uniform1f(this._u(P, 'uMixB'), B ? B.mix : 1);
    gl.uniform1f(this._u(P, 'uHasB'), B ? 1 : 0);
    gl.uniform1i(this._u(P, 'uBlend'), this.blend);
    gl.uniform4f(this._u(P, 'uSrcRect'), ...this._srcRect());
    gl.uniform1f(this._u(P, 'uSrcOpacity'), hasSrc ? this.src.opacity : 0);
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
