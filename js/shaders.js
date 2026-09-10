// Shader library. Every mode is a feedback shader: it reads the previous
// frame (uPrev) and the audio texture (uAudio) and writes the next frame.
// A post pass then corrupts the result on the way to the screen.

export const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Everything the analyser knows, available to every mode, sim and the post pass.
export const AUDIO_UNIFORMS = `
uniform sampler2D uAudio;   // 512x2: row 0 spectrum, row 1 waveform
uniform sampler2D uHist;    // 512x64 spectrum history, newest row at uHistRow
uniform float uHistRow;
uniform vec2  uRes;
uniform float uTime;
uniform float uDt;
uniform float uLevel, uBass, uMid, uTreble;
uniform float uBeat, uBeatCount;                       // generic bass onset
uniform float uKick, uSnare, uHat;                     // per-band onset envelopes
uniform float uKickCount, uSnareCount, uHatCount;
uniform float uBar, uBarPhase, uBeatTime;              // bar count, 0..1 within the bar, continuous beats
uniform float uPhrase, uPhrasePhase, uDownbeat;        // 8-bar phrases
uniform float uDrop, uBuild;                           // drop envelope, build-up 0..1
uniform float uPitch, uKeyHue, uChromaClarity;         // dominant pitch 0..1 (log), key as hue 0..1
uniform float uChroma[12];                             // pitch-class energy, C = 0
uniform float uCentroid, uFlat, uHarm, uPerc;          // brightness, noisiness, harmonic, percussive
uniform float uWidth, uPan;                            // stereo width 0..1, pan -1..1
uniform float uSilence, uPunch, uSharp;                // silence 0..1, envelope punch, transient sharpness
uniform float uMusic;                                  // how much the musical mappings apply
uniform float uCorrupt, uDecay, uSens;
uniform vec4  uSeed;      // per-look variation, 0..1 each; rerolled by VARY / RANDOM / auto-cycle
float spec(float x) { return texture(uAudio, vec2(clamp(x, 0.0, 1.0), 0.25)).r; }
float wav(float x)  { return texture(uAudio, vec2(fract(x), 0.75)).r * 2.0 - 1.0; }
// spectrum age 0 = now .. 1 = about two seconds ago
float hist(float x, float age) {
  float row = uHistRow - clamp(age, 0.0, 1.0) * 63.0;
  return texture(uHist, vec2(clamp(x, 0.0, 1.0), fract((row + 0.5) / 64.0))).r;
}
float chroma(int pc) { return uChroma[pc]; }
`;

export const COMMON = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uPrev;
uniform sampler2D uSim;
uniform int   uPalette;
uniform int   uPaletteTo;
uniform float uPalMix;
uniform float uKeyAmt;    // how far the song's key shifts every palette
out vec4 fragColor;
` + AUDIO_UNIFORMS + `

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / (dot(ba, ba) + 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}
vec3 pal(float t, vec3 a, vec3 b, vec3 c, vec3 d) { return a + b * cos(6.28318 * (c * t + d)); }
vec3 palN(int n, float t) {
  if (n == 0) return pal(t, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, 0.33, 0.67));
  if (n == 1) return pal(t, vec3(0.5), vec3(0.5), vec3(1.0, 1.0, 0.5), vec3(0.8, 0.9, 0.3));
  if (n == 2) return vec3(0.35, 1.0, 0.45) * (0.55 + 0.45 * cos(6.28318 * t));
  if (n == 3) return pal(t, vec3(0.5), vec3(0.5), vec3(2.0, 1.0, 0.0), vec3(0.5, 0.2, 0.25));
  if (n == 4) return pal(t, vec3(0.8, 0.5, 0.4), vec3(0.2, 0.4, 0.2), vec3(2.0, 1.0, 1.0), vec3(0.0, 0.25, 0.25));
  if (n == 5) return vec3(0.92) * step(0.5, fract(t));
  if (n == 6) return pal(t, vec3(0.6, 0.4, 0.7), vec3(0.4, 0.3, 0.3), vec3(1.0), vec3(0.0, 0.1, 0.2));           // VAPOR
  if (n == 7) return pal(t, vec3(0.3, 0.5, 0.7), vec3(0.3, 0.3, 0.3), vec3(1.0), vec3(0.5, 0.6, 0.7));           // ICE
  if (n == 8) return vec3(1.0, 0.55, 0.1) * (0.5 + 0.5 * cos(6.28318 * t));                                      // AMBER
  if (n == 9) return pal(t, vec3(0.4, 0.5, 0.3), vec3(0.5, 0.4, 0.6), vec3(1.0), vec3(0.3, 0.7, 0.1));           // TOXIC
  if (n == 10) return vec3(0.9, 0.05, 0.1) * (0.5 + 0.5 * cos(6.28318 * t)) + vec3(0.08, 0.0, 0.0);              // BLOOD
  // CGA: four hard colours
  float k = floor(fract(t) * 4.0);
  if (k < 1.0) return vec3(0.05, 0.05, 0.08);
  if (k < 2.0) return vec3(0.33, 1.0, 1.0);
  if (k < 3.0) return vec3(1.0, 0.33, 1.0);
  return vec3(1.0);
}
// palette changes crossfade: uPalette is the outgoing one, uPaletteTo the incoming;
// the song's key shifts every palette by uKeyAmt of a full cycle
vec3 palette(float t) {
  t += uKeyHue * uKeyAmt;
  vec3 a = palN(uPalette, t);
  if (uPalMix <= 0.0) return a;
  return mix(a, palN(uPaletteTo, t), uPalMix);
}
vec2 aspect() { return vec2(uRes.x / uRes.y, 1.0); }
`;

export const MODES = [
  {
    name: 'MOSH',
    blurb: 'block-displaced feedback, waveform ring',
    src: `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (uv - 0.5) * aspect();

  // macroblock displacement, more blocks tear on beats
  vec2 grid = vec2(10.0 + 30.0 * uSeed.x, 6.0 + 18.0 * uSeed.y);
  vec2 cell = floor(uv * grid);
  float h = hash21(cell + floor(uTime * 4.0) * (0.3 + uBeat));
  float s = spec(fract(h * 7.0) * 0.4);
  vec2 shift = vec2(0.0);
  if (h < uCorrupt * 0.3 + max(uBeat, uSnare * uMusic) * 0.35) {
    shift = (vec2(hash21(cell.yx + 1.7), hash21(cell + 3.1)) - 0.5) * s * 0.25;
  }

  // slow curl flow + bass push
  float ang = noise(p * (1.5 + 4.0 * uSeed.w) + uTime * 0.15) * 6.28318;
  vec2 flow = vec2(cos(ang), sin(ang)) * (0.0015 + 0.02 * uBass);
  vec2 src = uv + shift + flow - (uv - 0.5) * (0.004 + 0.02 * uMid + 0.03 * uKick * uMusic);

  vec3 prev = texture(uPrev, src).rgb;
  prev.r = mix(prev.r, texture(uPrev, src + vec2(0.004 * uTreble, 0.0)).r, 0.6);
  prev.b = mix(prev.b, texture(uPrev, src - vec2(0.004 * uTreble, 0.0)).b, 0.6);

  // waveform ring as new ink
  float r = length(p);
  float a = atan(p.y, p.x) / 6.28318 + 0.5;
  float w = wav(a + uTime * 0.02);
  float ring = smoothstep(0.025, 0.0, abs(r - (0.12 + 0.25 * uSeed.z) - w * 0.16 * (0.4 + uLevel)));
  vec3 ink = palette(a + uTime * 0.07 + uBeatCount * 0.05) * ring * (0.6 + uLevel);

  fragColor = vec4(prev * uDecay + ink, 1.0);
}`,
  },
  {
    name: 'SLIT',
    blurb: 'spectral slit-scan, melting',
    src: `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float dir = uSeed.w > 0.5 ? 1.0 : -1.0;
  float speed = (0.5 + 3.0 * uSeed.x + 5.0 * uLevel) / uRes.x;
  vec2 src = uv + vec2(speed * dir, 0.0);

  // shear rows by bass, tear rows on beats
  src.y += sin(uv.x * 18.0 + uTime * 1.7) * 0.0015 * uBass * uCorrupt;
  float row = floor(uv.y * (24.0 + 72.0 * uSeed.z));
  float tear = step(1.0 - uCorrupt * 0.4 * max(uBeat, uSnare * uMusic), hash21(vec2(row, floor(uTime * 24.0))));
  src.x += tear * (hash21(vec2(row + 9.0, floor(uTime * 24.0))) - 0.5) * 0.12;
  // slow melt toward the bottom, only when corruption is up
  src.y -= 0.0004 * (1.0 + 3.0 * uMid) * uv.y * uCorrupt;

  // the slit-scan should survive its trip across the screen: decay is applied
  // very gently here so DECAY mostly controls the other modes
  vec3 prev = texture(uPrev, src).rgb * pow(uDecay, 0.02);

  // new column at the right edge; y = frequency (log-ish)
  float ex = dir > 0.0 ? uv.x : 1.0 - uv.x;
  float edge = smoothstep(1.0 - 2.5 / uRes.x, 1.0, ex);
  float f = pow(uv.y, 1.2 + 2.0 * uSeed.y);
  float s = spec(f * 0.6);
  s = smoothstep(0.08, 0.95, s) * (0.7 + uSens * 0.6);
  vec3 ink = min(vec3(1.0), palette(s * 0.5 + uv.y * 0.3 + uTime * 0.04) * s * 1.8);

  vec3 col = mix(prev, ink, edge);
  fragColor = vec4(col, 1.0);
}`,
  },
  {
    name: 'ORACLE',
    blurb: 'kaleidoscoped lissajous of the waveform',
    src: `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (uv - 0.5) * aspect();

  float seg = 2.0 + floor(uSeed.x * 6.0) + mod(uMusic > 0.5 ? uBar : uBeatCount, 3.0);
  float ang = atan(p.y, p.x);
  float r = length(p);
  float k = 6.28318 / seg;
  ang = abs(mod(ang, k) - k * 0.5);
  vec2 q = vec2(cos(ang), sin(ang)) * r;

  // feedback: rotate + zoom, driven by treble and bass
  float rot = (0.015 + 0.08 * uTreble) * sign(uSeed.w - 0.5);
  mat2 R = mat2(cos(rot), -sin(rot), sin(rot), cos(rot));
  vec2 fp = R * p * (0.985 - 0.03 * uBass);
  float fa = 6.28318 * (2.0 + floor(uSeed.y * 5.0));
  float fb = 6.28318 * (1.0 + floor(uSeed.z * 4.0));
  vec2 fuv = fp / aspect() + 0.5;
  vec3 prev = texture(uPrev, fuv).rgb * uDecay;

  // waveform-deformed lissajous curve
  float amp = 0.18 * (0.6 + uLevel * uSens);
  float d = 1e3;
  vec2 last = vec2(wav(0.0), wav(0.25)) * amp + 0.16 * vec2(cos(uTime * 0.7), sin(uTime * 0.9));
  for (int i = 1; i <= 64; i++) {
    float t = float(i) / 64.0;
    vec2 base = 0.16 * vec2(cos(t * fa + uTime * 0.7), sin(t * fb + uTime * 0.9));
    vec2 c = vec2(wav(t), wav(t + 0.25)) * amp + base;
    d = min(d, sdSeg(q, last, c));
    last = c;
  }
  float line = smoothstep(0.014, 0.0, d);
  vec3 ink = palette(r * 1.5 + uTime * 0.15) * line * (1.2 + uBeat);

  fragColor = vec4(prev + ink, 1.0);
}`,
  },
  {
    name: 'BITRUPT',
    blurb: 'xor cell logic, spectrum-driven',
    src: `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float g = 24.0 + floor(uSeed.x * 72.0) + floor(uTreble * 24.0);
  vec2 c = floor(uv * vec2(g * uRes.x / uRes.y, g));
  int ix = int(c.x);
  int iy = int(c.y);
  int t = int(uTime * (1.0 + uLevel * 16.0));

  // each row listens to one frequency band (log spaced)
  float s = spec(pow(fract(c.y / g), 1.8) * 0.5);
  int mul = 1 + int(s * 7.0);
  int sh = int(uBass * 5.0);
  int v = ((ix * mul) ^ (iy >> sh)) + t;
  float bit = float(v & 1) * float(((ix + t) ^ (iy * 3)) & 3) / 3.0;
  float pat = float(((ix ^ iy) + t) & 15) / 15.0 + uSeed.y;

  // previous frame scrolls up, rows byte-shift on beats
  float row = floor(uv.y * 40.0);
  float shift = step(1.0 - uCorrupt * 0.5 * max(uBeat, uSnare * uMusic), hash21(vec2(row, floor(uTime * 12.0)))) * (1.0 / 16.0);
  float dir = uSeed.w > 0.5 ? 1.0 : -1.0;
  vec3 prev = texture(uPrev, uv + vec2(shift, dir * (1.0 + uMid * 5.0) / uRes.y)).rgb;

  float gate = smoothstep(0.25, 0.8, s);
  vec3 ink = palette(pat + uTime * 0.05) * bit * gate * 1.6;
  vec3 col = max(prev * uDecay * 0.93, ink);
  fragColor = vec4(col, 1.0);
}`,
  },
  {
    name: 'VOID',
    blurb: 'spectrum tunnel',
    src: `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (uv - 0.5) * aspect();
  p += vec2(sin(uTime * 0.3), cos(uTime * 0.23)) * 0.12 * uMid;
  float r = length(p);
  float a = atan(p.y, p.x);

  float depth = 0.25 / (r + 0.03) + uTime * (0.4 + 2.0 * uLevel * uSens) * sign(uSeed.w - 0.5);
  float band = fract(depth * (0.3 + 0.6 * uSeed.x));
  float s = spec(band * 0.5);
  float spokes = spec(fract((a / 6.28318 + 0.5) * (1.0 + floor(uSeed.y * 4.0)) + uTime * 0.02) * 0.3 + 0.05);
  float wall = smoothstep(0.25, 1.0, s) * (0.4 + spokes);
  vec3 col = palette(band + a / 6.28318 + uTime * 0.08) * wall * (0.5 + uBass);
  col *= smoothstep(0.0, 0.18, r);

  vec2 fuv = (p * (0.96 - 0.03 * uBeat - 0.04 * uKick * uMusic)) / aspect() + 0.5;
  vec3 prev = texture(uPrev, fuv).rgb * uDecay * 0.92;
  fragColor = vec4(max(col, prev), 1.0);
}`,
  },
  {
    name: 'VHS',
    blurb: 'stacked scope traces, tracking errors, chroma bleed',
    src: `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float ft = floor(uTime * 30.0);

  // horizontal hold wobble from the waveform, tears on beats
  float roll = wav(fract(uv.y * 0.5 + uTime * 0.1)) * 0.04 * uLevel * uSens;
  float line = floor(uv.y * uRes.y / 3.0);
  float tear = step(0.97 - max(uBeat, uSnare * uMusic) * 0.4 * uCorrupt, hash21(vec2(line, ft))) *
               (hash21(vec2(ft, floor(uv.y * 40.0))) - 0.5) * 0.3 * uCorrupt;
  vec2 src = uv + vec2(roll + tear, 0.0);
  src.y = fract(src.y + 0.002 * uBass + sin(uTime) * 0.001);

  vec3 prev;
  prev.r = texture(uPrev, src + vec2(0.005 * uTreble, 0.0)).r;
  prev.g = texture(uPrev, src).g;
  prev.b = texture(uPrev, src - vec2(0.005 * uTreble, 0.0)).b;

  // base picture, drawn fresh every frame: stacked oscilloscope rows, each
  // showing a different slice of the waveform, brightness from the spectrum
  float rows = 4.0 + floor(uSeed.x * 16.0);
  float row = floor(uv.y * rows);
  float fy = fract(uv.y * rows);
  float w = wav(uv.x * 0.5 + row * 0.1 + uTime * 0.03);
  float trace = smoothstep(0.09, 0.0, abs(fy - 0.5 - w * 0.42 * (0.5 + uLevel)));
  float sp = spec(uv.x * 0.5);
  vec3 base = palette(row / rows + uTime * 0.04 + uBeatCount * 0.02) * trace * (0.45 + 0.7 * sp + 0.3 * uLevel);

  // zero-mean static (signed so it can't pile up in the feedback)
  float n = hash21(floor(uv * uRes * 0.5) + ft) - 0.5;
  vec3 ink = vec3(n) * (0.08 + 0.5 * uTreble) * (0.3 + sp) * uCorrupt;

  // occasional dropout lines
  float drop = step(0.995 - 0.03 * uBeat, hash21(vec2(line * 0.37, floor(uTime * 15.0))));
  vec3 col = mix(prev * uDecay * 0.9 + base + ink, vec3(0.0), drop);
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`,
  },
  {
    name: 'MELT',
    blurb: 'pixel drip: bright pixels sink, spectrum poured in from the top',
    src: `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 px = 1.0 / uRes;

  // pixel-sort style drip: take the pixel above if it is brighter than us
  vec3 here = texture(uPrev, uv).rgb;
  float dir = uSeed.w > 0.5 ? 1.0 : -1.0;
  vec3 up = texture(uPrev, uv + vec2(0.0, dir * px.y * (1.0 + 3.0 * uLevel))).rgb;
  float lh = dot(here, vec3(0.333));
  float lu = dot(up, vec3(0.333));
  float thr = 0.4 - 0.3 * uBass;
  vec3 prev = (lu > lh && lu > thr) ? up : here;

  // rows jitter sideways on beats
  float row = floor(uv.y * 90.0);
  float jit = (hash21(vec2(row, floor(uTime * 20.0))) - 0.5) * 0.06 * uBeat * uCorrupt;
  prev = mix(prev, texture(uPrev, uv + vec2(jit, 0.0)).rgb, step(0.01, abs(jit)));

  // spectrum poured in along the top edge
  float s = spec(pow(uv.x, 0.8 + 1.5 * uSeed.x) * 0.6);
  float top = smoothstep(0.985, 1.0, dir > 0.0 ? uv.y : 1.0 - uv.y);
  vec3 ink = palette(uv.x + uTime * 0.05) * s * 1.4 * top;

  // sparse drops anywhere on beats
  vec2 cell = floor(uv * vec2(40.0, 24.0));
  float drop = step(0.995 - 0.02 * uBeat - 0.03 * uHat * uMusic, hash21(cell + floor(uTime * 8.0))) * spec(fract(hash21(cell) * 3.0) * 0.5);
  ink += palette(hash21(cell)) * drop * 1.5;

  fragColor = vec4(prev * mix(uDecay, 1.0, 0.7) + ink, 1.0);
}`,
  },
  {
    name: 'RIPPLE',
    blurb: 'rings that refract the last frame, beats throw a shockwave',
    src: `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (uv - 0.5 + (uSeed.yz - 0.5) * 0.5) * aspect();
  float r = length(p);
  float a = atan(p.y, p.x) / 6.28318 + 0.5;

  float ph = r * (8.0 + 24.0 * uSeed.x) - uTime * (2.0 + 4.0 * uLevel) * sign(uSeed.w - 0.5);
  float ring = 0.5 + 0.5 * sin(ph);
  float kb = max(uBeat * (1.0 - uMusic), uKick * uMusic);
  float burst = smoothstep(0.03, 0.0, abs(r - (1.0 - kb) * 0.8)) * kb;
  float w = wav(a * 2.0 + uTime * 0.05) * 0.1 * uLevel;

  // refract the previous frame through the ring height field
  vec2 dir = p / max(r, 1e-4);
  vec2 src = uv - dir * cos(ph) * 0.005 * (1.0 + 3.0 * uMid) / aspect();
  vec3 prev = texture(uPrev, src).rgb;

  vec3 ink = palette(r * 2.0 - uTime * 0.1 + a * 0.5) * (pow(ring, 6.0) * spec(r * 0.4) * 1.2 + burst * 2.0);
  ink += palette(a + uTime * 0.2) * smoothstep(0.02, 0.0, abs(r - 0.1 - w * 2.0)) * 0.8;

  fragColor = vec4(prev * uDecay + ink, 1.0);
}`,
  },
  {
    name: 'STRINGS',
    blurb: 'fourteen strings, each tuned to a band, plucked by the waveform',
    src: `
void main() {
  vec2 ouv = gl_FragCoord.xy / uRes;
  vec2 uv = uSeed.w > 0.5 ? ouv.yx : ouv;   // strings run across or up
  float n = 5.0 + floor(uSeed.x * 20.0);
  float idx = floor(uv.y * n);
  float fy = fract(uv.y * n) - 0.5;

  float band = spec(pow((idx + 0.5) / n, 1.6) * 0.5);
  float env = sin(uv.x * 3.14159);
  float w = wav(uv.x * 0.5 + idx * 0.07 + uTime * 0.02) * band * env * 0.6 * (0.5 + uSens * 0.5) * (1.0 + uSnare * uMusic);
  float d = abs(fy - w);
  float line = smoothstep(0.02 + 0.03 * band, 0.0, d);
  float glow = smoothstep(0.3, 0.0, d) * band * 0.15;
  vec3 col = palette(idx / n + uTime * 0.03 + uBeatCount * 0.01) * (line + glow) * (0.5 + band);

  // feedback drifts upward with bass, smears sideways with treble
  vec2 src = ouv + vec2(0.006 * uTreble * sin(uTime * 3.0 + idx), 0.002 * uBass);
  vec3 prev = texture(uPrev, src).rgb * uDecay;
  fragColor = vec4(max(prev, col), 1.0);
}`,
  },
  {
    name: 'RADAR',
    blurb: 'sweeping beam reveals a polar spectrum, phosphor afterglow',
    src: `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (uv - 0.5) * aspect();
  float r = length(p);
  float ang = atan(p.y, p.x);
  float a01 = ang / 6.28318 + 0.5;

  float sweep = mod(uTime * (1.6 + 2.0 * uLevel) * sign(uSeed.w - 0.5), 6.28318) - 3.14159;
  float da = mod(ang - sweep + 6.28318, 6.28318);
  float beam = smoothstep(0.3, 0.0, da);

  float s = spec(pow(a01, 2.0) * 0.5);
  float blip = smoothstep(0.03, 0.0, abs(r - 0.08 - s * 0.4)) * beam * (2.5 + 3.0 * uHat * uMusic);
  float fillArea = step(r, 0.08 + s * 0.4) * beam * 0.25;
  float gd = 4.0 + floor(uSeed.x * 12.0);
  float grid = (step(0.97, fract(r * gd)) + step(0.985, fract(a01 * gd))) * 0.2 * step(r, 0.5);
  float w = wav(a01 + uTime * 0.03) * 0.05 * uLevel;
  float rim = smoothstep(0.01, 0.0, abs(r - 0.48 - w)) * 0.8;

  vec3 col = palette(0.3 + s * 0.3) * (blip + fillArea) + palette(0.5) * beam * 0.25 * step(r, 0.5)
           + palette(0.6) * grid + palette(a01) * rim;

  // long phosphor afterglow, rotating slowly with treble
  float rot = 0.003 * uTreble;
  mat2 R = mat2(cos(rot), -sin(rot), sin(rot), cos(rot));
  vec2 fuv = (R * p) / aspect() + 0.5;
  // must survive most of a revolution (about 4 s) so the trail reads as radar
  vec3 prev = texture(uPrev, fuv).rgb * max(uDecay, 0.994);
  fragColor = vec4(max(prev, col), 1.0);
}`,
  },
  {
    name: 'SHATTER',
    blurb: 'voronoi shards, each listening to its own band, cracking on beats',
    src: `
vec2 hash22(vec2 p) { return vec2(hash21(p), hash21(p + 17.1)); }
vec2 site(vec2 c) {
  vec2 o = hash22(c);
  return 0.5 + 0.4 * sin(uTime * 0.4 + 6.2831 * o);
}
// returns (edge distance, cell id)
vec3 voro(vec2 p) {
  vec2 n = floor(p), f = fract(p);
  vec2 mg = vec2(0.0), mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 r = g + site(n + g) - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  md = 8.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 g = mg + vec2(float(i), float(j));
    vec2 r = g + site(n + g) - f;
    if (dot(mr - r, mr - r) > 1e-5) md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  return vec3(md, n + mg);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (uv - 0.5) * aspect();
  float scale = 3.0 + 8.0 * uSeed.x + 3.0 * uMid;
  vec3 v = voro(p * scale + vec2(uTime * 0.1) * (uSeed.yz - 0.5) * 4.0);
  float id = hash21(v.yz);
  float s = spec(fract(id * 5.0) * 0.5);

  // each shard shoves the previous frame in its own direction, harder on beats
  vec2 disp = (hash22(v.yz + 3.3) - 0.5) * s * 0.06 * (0.3 + uBeat + uKick * uMusic);
  vec3 prev = texture(uPrev, uv + disp).rgb;

  float edge = smoothstep(0.0, 0.03 + 0.05 * uBass + 0.08 * uSnare * uMusic, v.x);
  vec3 fill = palette(id + uTime * 0.03) * s * 0.7;
  vec3 col = mix(palette(id + 0.5) * 1.2, fill, edge) * (0.4 + s);

  fragColor = vec4(mix(prev * uDecay * 0.9, col, 0.18), 1.0);
}`,
  },
  {
    name: 'INK',
    blurb: 'marbling: curl-noise fluid with a pen that follows the sound',
    src: `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (uv - 0.5) * aspect();

  // curl of value noise advects the previous frame
  float sc = 1.0 + 4.0 * uSeed.x + 3.0 * uMid;
  float e = 0.01;
  vec2 q = p * sc + uTime * 0.1;
  float n0 = noise(q);
  float nx = noise(q + vec2(e * sc, 0.0));
  float ny = noise(q + vec2(0.0, e * sc));
  vec2 curl = vec2(ny - n0, -(nx - n0)) / e;
  vec2 src = uv - curl * (0.002 + 0.01 * uBass) / aspect();
  vec3 prev = texture(uPrev, src).rgb;

  // two pens on lissajous paths, nudged by the waveform, fattened by level
  vec2 wob = 0.15 * vec2(wav(0.1), wav(0.6)) * uLevel;
  vec2 pen = 0.32 * vec2(sin(uTime * (0.8 + 2.0 * uSeed.y)), sin(uTime * (0.8 + 2.5 * uSeed.z))) + wob;
  vec2 pen2 = 0.32 * vec2(cos(uTime * 1.1), sin(uTime * 0.7 + 1.0)) - wob;
  float blob = smoothstep(0.06 + 0.1 * uLevel + 0.1 * uKick * uMusic, 0.0, length(p - pen));
  float blob2 = smoothstep(0.05 + 0.08 * uBass, 0.0, length(p - pen2));
  vec3 ink = palette(uTime * 0.05 + uBeatCount * 0.1) * blob + palette(0.5 + uTime * 0.03) * blob2;

  // beat splash
  ink += palette(uBeatCount * 0.13) * smoothstep(0.01, 0.0, abs(length(p) - (1.0 - uBeat) * 0.6)) * uBeat * 0.5;

  fragColor = vec4(prev * mix(uDecay, 1.0, 0.85) + ink, 1.0);
}`,
  },
  {
    name: 'REACT',
    blurb: 'reaction-diffusion: bass feeds the growth, the waveform seeds it',
    // Gray-Scott in a separate state buffer (A in .r, B in .g), 8 steps per frame.
    sim: `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 px = 1.0 / uRes;
  vec2 c = texture(uSim, uv).rg;
  vec2 lap = 0.2 * (texture(uSim, uv + vec2(px.x, 0.0)).rg + texture(uSim, uv - vec2(px.x, 0.0)).rg
                  + texture(uSim, uv + vec2(0.0, px.y)).rg + texture(uSim, uv - vec2(0.0, px.y)).rg)
           + 0.05 * (texture(uSim, uv + px).rg + texture(uSim, uv - px).rg
                   + texture(uSim, uv + vec2(px.x, -px.y)).rg + texture(uSim, uv + vec2(-px.x, px.y)).rg)
           - c;
  // the seed picks the Gray-Scott regime (spots, worms, mazes, coral); audio nudges it
  float f = 0.020 + 0.030 * uSeed.x + 0.02 * min(uBass, 1.0);
  float k = 0.052 + 0.012 * uSeed.y + 0.006 * mix(min(uMid, 1.0), uCentroid, uMusic);
  float abb = c.x * c.y * c.y;
  vec2 n = c + vec2(lap.x - abb + f * (1.0 - c.x), 0.5 * lap.y + abb - (k + f) * c.y);

  // seed B along the waveform ring and in beat splashes
  vec2 p = (uv - 0.5) * aspect();
  float r = length(p);
  float a = atan(p.y, p.x) / 6.28318 + 0.5;
  float w = wav(a) * 0.12 * uLevel;
  float ring = step(abs(r - 0.25 - w), 0.006) * step(0.05, uLevel);
  vec2 cell = floor(uv * vec2(12.0, 8.0));
  float splash = step(0.985, hash21(cell + floor(uTime * 6.0))) * max(uBeat, uKick * uMusic);
  n.y = max(n.y, 0.6 * max(ring, splash));
  fragColor = vec4(clamp(n, 0.0, 1.0), 0.0, 1.0);
}`,
    src: `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 s = texture(uSim, uv).rg;
  float body = smoothstep(0.12, 0.35, s.y);
  float edge = 1.0 - smoothstep(0.0, 0.06, abs(s.y - 0.2));
  vec3 col = palette(s.y * 1.5 + uTime * 0.03) * body + palette(0.5 + uTime * 0.03) * edge * 0.8;
  vec3 prev = texture(uPrev, uv + vec2(0.0, 0.001 * uTreble)).rgb * uDecay * 0.6;
  fragColor = vec4(max(col, prev), 1.0);
}`,
  },
  {
    name: 'WARP',
    blurb: 'domain-warped noise field, bass bends the warp',
    src: `
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return v;
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (uv - 0.5) * aspect();
  float sc = 1.5 + 3.0 * uSeed.x;
  vec2 q = vec2(fbm(p * sc + uTime * 0.1), fbm(p * sc + vec2(5.2, 1.3) - uTime * 0.07));
  float warp = 0.5 + 2.0 * uBass + 2.0 * uSeed.y + 2.0 * uPerc * uMusic;
  vec2 r = vec2(fbm(p * sc + warp * q + vec2(1.7, 9.2) + 0.15 * uTime), fbm(p * sc + warp * q + vec2(8.3, 2.8)));
  float f = fbm(p * sc + warp * r);
  float s = spec(fract(f * 2.0) * 0.5);
  vec3 col = palette(f * 1.5 + uSeed.z + uTime * 0.03) * (0.3 + 0.9 * f) * (0.5 + s);
  col += palette(0.5 + f) * smoothstep(0.55, 0.65, f) * uBeat;

  float rot = 0.004 * sign(uSeed.w - 0.5) * (1.0 + uTreble);
  mat2 R = mat2(cos(rot), -sin(rot), sin(rot), cos(rot));
  vec2 fuv = (R * p * 0.99) / aspect() + 0.5;
  vec3 prev = texture(uPrev, fuv).rgb * uDecay;
  fragColor = vec4(mix(prev, col, 0.2 + 0.5 * uLevel), 1.0);
}`,
  },
  {
    name: 'GRID',
    blurb: 'perspective floor rushing past, columns lit by bands, waveform horizon',
    src: `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (uv - 0.5) * aspect();
  float horizon = 0.05 + 0.1 * (uSeed.y - 0.5);
  float flip = uSeed.w > 0.5 ? 1.0 : -1.0;   // floor below or ceiling above
  float y = (p.y - horizon) * flip;
  vec3 col = vec3(0.0);
  if (y < 0.0) {
    float z = 0.08 / (-y);
    float x = p.x * z;
    float speed = uTime * (1.0 + 3.0 * uLevel);
    float xs = 1.0 + 2.0 * uSeed.z, zs = 0.5 + uSeed.x;
    float gz = fract(z * zs - speed);
    float gx = fract(x * xs);
    float lineZ = smoothstep(0.08, 0.0, min(gz, 1.0 - gz) * z * 0.3);
    float lineX = smoothstep(0.08, 0.0, min(gx, 1.0 - gx) * z * 0.3);
    float band = spec(fract(floor(x * xs) * 0.13) * 0.5);
    col = palette(0.6 + 0.3 * fract(z * 0.1) + uTime * 0.05) * max(lineZ, lineX) * (0.6 + 0.8 * band);
    col *= 1.0 - smoothstep(2.0, 20.0, z);
    vec2 tile = floor(vec2(x * xs, z * zs - speed));
    float glow = step(0.93 - 0.25 * uBeat - 0.3 * uHat * uMusic, hash21(tile + floor(uBeatCount)));
    col += palette(hash21(tile)) * glow * 0.5 * uBeat;
  } else {
    float w = wav(uv.x * 0.5 + uTime * 0.02) * 0.05 * uLevel;
    float line = smoothstep(0.006, 0.0, abs(y - 0.01 - w));
    vec2 sc = p - vec2(0.0, horizon + 0.18 * flip);
    float sun = smoothstep(0.25, 0.0, length(sc)) * step(0.5, fract(sc.y * 30.0 + uTime * 0.5));
    col = palette(0.1 + uTime * 0.02) * line * 1.2 + palette(0.85) * sun * 0.6 * (0.5 + uBass);
  }
  vec3 prev = texture(uPrev, uv + vec2(0.0, 0.002 * flip)).rgb * uDecay * 0.8;
  fragColor = vec4(max(col, prev), 1.0);
}`,
  },
  {
    name: 'HEX',
    blurb: 'hex cells pulsing to their own bands, flipping on beats',
    src: `
vec4 hexCoords(vec2 p) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec4 hc = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h = vec4(p - hc.xy * s, p - (hc.zw + 0.5) * s);
  return dot(h.xy, h.xy) < dot(h.zw, h.zw) ? vec4(h.xy, hc.xy) : vec4(h.zw, hc.zw + 0.5);
}
float hexDist(vec2 p) { p = abs(p); return max(dot(p, normalize(vec2(1.0, 1.7320508))), p.x); }
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (uv - 0.5) * aspect();
  float sc = 6.0 + 14.0 * uSeed.x;
  vec4 h = hexCoords(p * sc + vec2(uTime * 0.4 * (uSeed.w - 0.5), 0.0));
  vec2 id = h.zw;
  float d = hexDist(h.xy);
  float band = spec(fract(hash21(id) * 3.0 + uSeed.y) * 0.5);
  float flipT = step(0.97 - 0.2 * max(uBeat, uSnare * uMusic), hash21(id + floor(uBeatCount)));
  float r = 0.5 * (0.3 + 0.7 * band);
  float fill = smoothstep(r, r - 0.06, d);
  float edge = smoothstep(0.5, 0.44, d) - smoothstep(0.46, 0.4, d);
  vec3 col = palette(hash21(id) * 0.3 + uSeed.z + band * 0.3 + uTime * 0.03) * (fill * (0.4 + band) + edge * 0.25);
  col = mix(col, 1.0 - col, flipT * uBeat * uCorrupt);
  vec3 prev = texture(uPrev, uv).rgb * uDecay;
  fragColor = vec4(max(col, prev * 0.95), 1.0);
}`,
  },
  {
    name: 'SPIRAL',
    blurb: 'log-spiral arms carrying the spectrum, feedback pulls you in',
    src: `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (uv - 0.5) * aspect();
  float r = length(p);
  float a = atan(p.y, p.x);
  float arms = 1.0 + floor(uSeed.x * 4.0) + floor(uChromaClarity * uMusic * 2.0);
  float tight = 3.0 + 6.0 * uSeed.y;
  float dir = sign(uSeed.w - 0.5);
  float sp = fract(log(r + 0.02) * tight + a * arms / 6.28318 + uTime * (0.2 + 0.6 * uLevel) * dir);
  float band = spec(fract(log(r + 0.02) * 0.3 + uSeed.z) * 0.5);
  float arm = smoothstep(0.35 - 0.2 * band, 0.0, abs(sp - 0.5));
  vec3 col = palette(a / 6.28318 + r + uTime * 0.05) * arm * (0.3 + band);
  col *= smoothstep(0.0, 0.1, r);
  vec2 fuv = (p * (1.0 - 0.02 * dir * (0.5 + uBass))) / aspect() + 0.5;
  vec3 prev = texture(uPrev, fuv).rgb * uDecay;
  fragColor = vec4(max(col, prev), 1.0);
}`,
  },
  {
    name: 'GLYPH',
    blurb: 'terminal of invented glyphs, rows typed by bands',
    src: `
float glyph(vec2 cell, vec2 f, float code) {
  ivec2 g = ivec2(floor(f * vec2(5.0, 7.0)));
  if (g.x < 0 || g.x > 4 || g.y < 0 || g.y > 6) return 0.0;
  int idx = g.y * 3 + min(g.x, 4 - g.x);            // mirrored 5x7 bitmap, 21 bits
  int bits = int(hash21(cell + code) * 2097152.0);
  return float((bits >> idx) & 1);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float cols = 24.0 + floor(uSeed.x * 40.0);
  float rows = floor(cols * uRes.y / uRes.x * 0.7);
  vec2 grid = vec2(cols, rows);
  float scroll = floor(uTime * (1.0 + 6.0 * uLevel) * (0.5 + uSeed.y));
  vec2 cell = floor(uv * grid) + vec2(0.0, scroll);
  vec2 gf = (fract(uv * grid) - 0.1) / 0.8;
  float band = spec(fract(cell.y / rows + uSeed.z) * 0.5);
  float code = floor(band * 8.0);
  float on = step(0.15, band) * step(hash21(cell * 0.37), 0.4 + band * 0.6);
  float gl = glyph(cell, gf, code) * on;
  vec3 col = palette(cell.y / rows * 0.3 + uSeed.w + band * 0.4) * gl * (0.6 + band);
  float hit = max(uBeat, uSnare * uMusic);
  float inv = step(0.95 - 0.3 * hit, hash21(vec2(cell.y, floor(uTime * 8.0)))) * hit * uCorrupt;
  col = mix(col, vec3(on) - col, inv);
  vec3 prev = texture(uPrev, uv + vec2(0.0, 2.0 / uRes.y)).rgb * uDecay * 0.85;
  fragColor = vec4(max(col, prev), 1.0);
}`,
  },
  {
    name: 'FLARE',
    blurb: 'beat-spawned bursts on a starfield, trails expand outward',
    src: `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (uv - 0.5) * aspect();
  // seconds since the last beat, recovered from the beat envelope
  float trig = mix(uBeat, uKick, uMusic);
  float age = clamp(-log(max(trig, 1e-4)) / 7.67, 0.0, 3.0);
  vec2 c = (vec2(hash21(vec2(uBeatCount, 1.0)), hash21(vec2(uBeatCount, 2.0))) - 0.5) * vec2(0.8, 0.6) * (0.5 + uSeed.y);
  float d = length(p - c);
  float rad = age * (0.3 + 0.5 * uSeed.x);
  float ring = smoothstep(0.03, 0.0, abs(d - rad)) * exp(-age * 1.5);
  float ang = atan(p.y - c.y, p.x - c.x);
  float spokes = pow(0.5 + 0.5 * cos(ang * (6.0 + floor(uSeed.z * 10.0)) + uBeatCount), 8.0)
               * (1.0 - smoothstep(0.0, rad + 0.01, d)) * exp(-age * 3.0);
  vec3 burst = palette(hash21(vec2(uBeatCount, 3.0)) + uSeed.w + uPitch * uMusic) * (ring * 2.0 + spokes);
  vec2 sg = vec2(60.0, 40.0);
  vec2 gc = floor(uv * sg), fc = fract(uv * sg);
  float star = step(0.97, hash21(gc + uSeed.xy)) * smoothstep(0.3, 0.0, length(fc - 0.5)) * (0.3 + uTreble);
  vec3 col = burst + vec3(star);
  vec2 fuv = (p * (0.985 - 0.02 * uBass)) / aspect() + 0.5;
  vec3 prev = texture(uPrev, fuv).rgb * uDecay;
  fragColor = vec4(col + prev, 1.0);
}`,
  },
  {
    name: 'RIDGE',
    blurb: 'stacked ridge lines, each a band, the waveform running through them',
    src: `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float n = 12.0 + floor(uSeed.x * 24.0);
  float scroll = uTime * (0.05 + 0.2 * uLevel) * (sign(uSeed.w - 0.5) + uPan * uMusic);
  float env = smoothstep(0.0, 0.25, uv.x) * smoothstep(1.0, 0.75, uv.x);
  vec3 col = vec3(0.0);
  for (int i = 0; i < 40; i++) {
    if (float(i) >= n) break;
    float t = 1.0 - (float(i) + 0.5) / n;     // back to front
    float base = t * 0.9 + 0.05;
    float s = spec(fract(t + uSeed.y) * 0.5);
    float w = wav(uv.x * 0.4 + t * 0.2 + scroll);
    float h = env * (0.02 + 0.12 * s * (0.5 + uSens * 0.5)) * (0.5 + 0.5 * w + noise(vec2(uv.x * 6.0 + t * 9.0, uTime * 0.3 + float(i))));
    float y = base + h;
    float line = smoothstep(0.004, 0.0, abs(uv.y - y));
    float below = step(uv.y, y) * step(base - 0.001, uv.y);
    col = mix(col, vec3(0.0), below * 0.9);
    col += palette(t * 0.5 + uSeed.z + uTime * 0.02) * line * (0.6 + s);
  }
  vec3 prev = texture(uPrev, uv).rgb * uDecay * 0.7;
  fragColor = vec4(max(col, prev), 1.0);
}`,
  },
  {
    name: 'WATERFALL',
    blurb: 'the last two seconds of spectrum as a waterfall, coloured by key',
    src: `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float flip = uSeed.w > 0.5 ? 1.0 : -1.0;
  float f = pow(uv.x, 1.5 + uSeed.x) * 0.6;
  float age = flip > 0.0 ? uv.y : 1.0 - uv.y;
  float s = hist(f, age);
  float rows = 16.0 + floor(uSeed.y * 32.0);
  float band = smoothstep(0.35, 0.5, abs(fract(age * rows) - 0.5)); // ruled rows
  vec3 col = palette(uv.x * 0.6 + uSeed.z) * pow(s, 1.3) * (0.6 + 0.8 * s) * (0.6 + 0.4 * band);
  float nowLine = smoothstep(0.012, 0.0, age) * (0.5 + uKick);
  col += palette(0.2 + uKeyHue) * nowLine;
  // bar lines march up the waterfall
  float barLine = smoothstep(0.01, 0.0, abs(fract(age * 2.0 + uBarPhase) - 0.5)) * 0.25 * uMusic;
  col += palette(0.7) * barLine;
  vec3 prev = texture(uPrev, uv + vec2(0.0, 0.003 * flip * uPerc)).rgb * uDecay * 0.5;
  fragColor = vec4(max(col, prev), 1.0);
}`,
  },
  {
    name: 'CHROMA',
    blurb: 'twelve pitch-class wedges turning once per bar, the key at the centre',
    src: `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (uv - 0.5) * aspect();
  float r = length(p);
  float a = atan(p.y, p.x) / 6.28318 + 0.5;
  float rot = uBarPhase * (uSeed.w > 0.5 ? 1.0 : -1.0) * uMusic + uSeed.x + uTime * 0.01;
  float w = fract(a + rot) * 12.0;
  int pc = int(w);
  float c = chroma(pc);
  float wedge = smoothstep(0.5, 0.42, abs(fract(w) - 0.5));
  float reach = 0.1 + 0.35 * c * (0.5 + 0.5 * uSeed.y);
  float ring = smoothstep(0.02, 0.0, abs(r - reach));
  float fill = step(r, reach) * wedge;
  vec3 col = palette(float(pc) / 12.0 + uSeed.z) * (fill * (0.25 + 0.6 * c) + ring * 1.5);
  col += palette(uKeyHue) * smoothstep(0.08 + 0.04 * uKick, 0.0, r) * (0.4 + uChromaClarity);
  col += uDrop * uDrop * 0.5;
  // beat-in-bar ticks around the rim
  float tick = smoothstep(0.02, 0.0, abs(r - 0.48)) * step(0.5, fract(a * 4.0 + 0.5 - floor(uBarPhase * 4.0) * 0.25) + 0.5 - 0.5);
  col += palette(0.5) * tick * 0.3 * uDownbeat;
  vec2 fuv = (p * (1.0 - 0.02 * uKick)) / aspect() + 0.5;
  vec3 prev = texture(uPrev, fuv).rgb * uDecay;
  fragColor = vec4(max(col, prev), 1.0);
}`,
  },
];

// Prelude for simulation shaders: same helpers, state comes in as uSim.
export const SIM_PRELUDE = `#version 300 es
precision highp float;
uniform sampler2D uSim;
uniform float uStep;
out vec4 fragColor;
` + AUDIO_UNIFORMS + `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec2 aspect() { return vec2(uRes.x / uRes.y, 1.0); }
`;

// Draws the source texture (image / camera) into a rect, additively scaled by uAmount.
export const SOURCE = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec4  uRect;
uniform float uAmount;
uniform vec2  uRes;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 s = (uv - uRect.xy) / uRect.zw;
  if (any(lessThan(s, vec2(0.0))) || any(greaterThan(s, vec2(1.0)))) discard;
  vec4 c = texture(uSrc, s);
  fragColor = vec4(c.rgb * c.a * uAmount, 1.0);
}`;

// Copies mix(uTex2, uTex, uMix) into the bound framebuffer (used to seed a fade).
export const MIX = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform sampler2D uTex2;
uniform float uMix;
uniform vec2  uRes;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  fragColor = vec4(mix(texture(uTex2, uv).rgb, texture(uTex, uv).rgb, uMix), 1.0);
}`;

export const POST = `#version 300 es
precision highp float;
` + AUDIO_UNIFORMS + `
uniform sampler2D uTex;
uniform sampler2D uTex2;
uniform sampler2D uTexB;
uniform sampler2D uTexB2;
uniform sampler2D uTexC;
uniform sampler2D uTexC2;
uniform sampler2D uSrc;
uniform float uMix;
uniform float uMixB;
uniform float uMixC;
uniform float uAlphaB;    // layer opacity (fades in / out)
uniform float uAlphaC;
uniform int   uBlend;     // layer B blend, with crossfade state
uniform int   uBlendFrom;
uniform float uBlendMix;
uniform int   uBlendC;    // layer C blend
uniform int   uBlendCFrom;
uniform float uBlendCMix;
uniform vec4  uSrcRect;
uniform float uSrcOpacity;
uniform float uMirror;   // kaleidoscope segments, < 2 = off
uniform float uMirrorFrom;
uniform float uMirrorMix; // 1 = settled on uMirror, < 1 = still blending from uMirrorFrom
uniform float uPixel;    // 0..1 pixelation
uniform float uHue;      // 0..1 hue rotation
uniform float uPoster;   // 0..1 posterisation
out vec4 fragColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec3 fetch(sampler2D t, vec2 suv, float ab) {
  return vec3(texture(t, suv + vec2(ab, 0.0)).r, texture(t, suv).g, texture(t, suv - vec2(ab, 0.0)).b);
}
// rotate a colour about the grey axis
vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float cs = cos(a), sn = sin(a);
  return c * cs + cross(k, c) * sn + k * dot(k, c) * (1.0 - cs);
}

vec3 blendFn(vec3 a, vec3 b, int m) {
  if (m == 1) return a + b * 0.65;   // softened so two bright layers don't white out
  if (m == 2) return a * b * 2.0;
  if (m == 3) return 1.0 - (1.0 - a) * (1.0 - b);
  if (m == 4) return abs(a - b);
  if (m == 5) return max(a, b);
  return mix(a, b, 0.5);
}
// composite one extra layer over col with its opacity, crossfading blend modes
vec3 layerIn(vec3 col, sampler2D t, sampler2D t2, float m, float alpha, int bl, int blFrom, float blMix, vec2 suv, float ab) {
  if (alpha <= 0.0) return col;
  vec3 b = fetch(t, suv, ab);
  if (m < 1.0) b = mix(fetch(t2, suv, ab), b, m);
  vec3 blended = blendFn(col, b, bl);
  if (blMix < 1.0) blended = mix(blendFn(col, b, blFrom), blended, blMix);
  return mix(col, blended, alpha);
}

// kaleidoscope fold; stereo width and pan nudge the centre so wide mixes go asymmetric
vec2 fold(vec2 uv, float m) {
  if (m < 2.0) return uv;
  vec2 asp = vec2(uRes.x / uRes.y, 1.0);
  vec2 p = (uv - 0.5) * asp - vec2(uPan * uWidth * 0.15 * uMusic, 0.0);
  float k = 6.28318 / m;
  float a = abs(mod(atan(p.y, p.x) + 3.14159, k) - k * 0.5);
  p = vec2(cos(a), sin(a)) * length(p);
  return clamp(p / asp + 0.5, 0.0, 1.0);
}

// everything after the fold, up to the source overlay
vec3 shade(vec2 uv) {
  float ft = floor(uTime * 24.0);

  // kick pumps a zoom
  uv = (uv - 0.5) * (1.0 - 0.04 * uKick * uMusic) + 0.5;

  // pixelation, finer when the sound is bright
  if (uPixel > 0.0) {
    float cells = mix(400.0, 20.0, uPixel) * (0.7 + 0.6 * uCentroid * uMusic);
    vec2 g = vec2(cells * uRes.x / uRes.y, cells);
    uv = (floor(uv * g) + 0.5) / g;
  }

  // block shifts: snares tear, sharp transients tear harder
  float blockY = floor(uv.y * 20.0);
  float g = hash21(vec2(blockY, ft));
  float shift = 0.0;
  float tear = max(uBeat, uSnare * uMusic);
  if (g > 1.0 - uCorrupt * 0.25 * (0.25 + tear)) shift = (hash21(vec2(g, blockY)) - 0.5) * 0.2 * (0.6 + 0.8 * uSharp);
  vec2 suv = uv + vec2(shift, 0.0);

  // chromatic split: treble and punch widen it, pan tilts it, drops slam it
  float ab = (0.0015 + 0.012 * uTreble * uCorrupt) * (1.0 + (uPunch + 2.0 * uDrop * uDrop) * uMusic);
  vec3 col = fetch(uTex, suv, ab);
  if (uMix < 1.0) col = mix(fetch(uTex2, suv, ab), col, uMix);

  // layers B and C composited over A
  col = layerIn(col, uTexB, uTexB2, uMixB, uAlphaB, uBlend, uBlendFrom, uBlendMix, suv, ab);
  col = layerIn(col, uTexC, uTexC2, uMixC, uAlphaC, uBlendC, uBlendCFrom, uBlendCMix, suv, ab);

  // scanlines; vignette tightens during a build-up; grain follows noisiness; hats glint
  col *= 0.86 + 0.14 * sin(uv.y * uRes.y * 3.14159);
  col *= 1.0 - 0.6 * (1.0 + 0.8 * uBuild * uMusic) * pow(length(uv - 0.5) * 1.2, 3.0);
  col += (hash21(gl_FragCoord.xy + uTime) - 0.5) / 48.0 * (1.0 + 6.0 * uFlat * uMusic);
  col += step(0.996 - 0.004 * uHat * uMusic, hash21(gl_FragCoord.xy * 0.7 + uTime * 7.0)) * 0.5 * uHat * uMusic;
  // builds drain colour, drops flash
  col = mix(col, vec3(dot(col, vec3(0.333))), 0.4 * uBuild * uMusic);
  col += uDrop * uDrop * 0.6 * uMusic;
  col = clamp(col, 0.0, 1.0);

  // rare full inversion on hard beats
  float inv = step(0.96, hash21(vec2(floor(uTime * 8.0), 7.0))) * step(0.7, uBeat) * step(0.3, uCorrupt);
  col = mix(col, 1.0 - col, inv);
  // silence dims everything toward black
  col *= 1.0 - 0.85 * uSilence;

  // colour treatments
  if (uHue > 0.0) col = clamp(hueRotate(col, uHue * 6.28318), 0.0, 1.0);
  if (uPoster > 0.0) {
    float lv = mix(24.0, 3.0, uPoster);
    col = floor(col * lv + 0.5) / lv;
  }

  return col;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  // a mirror change blends the old fold into the new one over the fade
  vec3 col = shade(fold(uv, uMirror));
  if (uMirrorMix < 1.0) col = mix(shade(fold(uv, uMirrorFrom)), col, uMirrorMix);

  // clean source overlay (logo / camera) on top
  if (uSrcOpacity > 0.0) {
    vec2 s = (uv - uSrcRect.xy) / uSrcRect.zw;
    if (all(greaterThanEqual(s, vec2(0.0))) && all(lessThanEqual(s, vec2(1.0)))) {
      vec4 c = texture(uSrc, s);
      col = mix(col, c.rgb, c.a * uSrcOpacity);
    }
  }

  fragColor = vec4(col, 1.0);
}`;
