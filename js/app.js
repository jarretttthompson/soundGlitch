import { AudioIn } from './audio.js';
import { Engine } from './engine.js';
import { MODES } from './shaders.js';
import { Midi } from './midi.js';
import { Scenes } from './scenes.js';
import { Link } from './link.js';

const PALETTES = ['SPECTRUM', 'ACID', 'PHOSPHOR', 'HEAT', 'BRUISE', 'STROBE',
                  'VAPOR', 'ICE', 'AMBER', 'TOXIC', 'BLOOD', 'CGA'];
const BLENDS = ['MIX', 'ADD', 'MULTIPLY', 'SCREEN', 'DIFFERENCE', 'LIGHTEN'];
const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const STORE = 'soundglitch.params';
const ROLE = new URLSearchParams(location.search).has('output') ? 'output' : 'controller';

const $ = s => document.querySelector(s);
const canvas = $('#c');
const audio = new AudioIn();
let engine;
try {
  engine = new Engine(canvas);
} catch (e) {
  $('#status').textContent = 'ERROR: ' + e.message.split('\n')[0];
  $('#status').dataset.state = 'err';
  console.error(e);
  throw e;
}

const DEFAULTS = {
  mode: 0, palette: 0, corrupt: 0.5, decay: 0.65, sens: 1.0, focus: 0.5, dynamics: 0.6,
  music: 0.7, keyColor: 0.5, lock: 0.6,
  auto: false, cycleScenes: false, randomCycle: false, cycle: 16, fade: 4, res: 0.7,
  layerB: -1, blend: 1, paletteB: -1,
  layerC: -1, blendC: 3, paletteC: -1,
  seed: [0.5, 0.5, 0.5, 0.5], seedB: [0.5, 0.5, 0.5, 0.5], seedC: [0.5, 0.5, 0.5, 0.5],
  mirror: 0, pixel: 0, hue: 0, poster: 0,
  srcBurn: 0, srcOpacity: 0, srcSize: 0.5, srcX: 0.5, srcY: 0.5,
  osc: false, midi: false,
  locks: {},   // { key: true } settings excluded from RANDOM / RANDOM CYCLE / VARY
};
// what each lock covers when randomizing
const LOCK_GROUPS = {
  mode: ['mode'], palette: ['palette'], seed: ['seed', 'seedB', 'seedC'],
  layerB: ['layerB'], blend: ['blend'], paletteB: ['paletteB'],
  layerC: ['layerC'], blendC: ['blendC'], paletteC: ['paletteC'],
  corrupt: ['corrupt'], decay: ['decay'], sens: ['sens'], focus: ['focus'], dynamics: ['dynamics'],
  music: ['music'], keyColor: ['keyColor'], lock: ['lock'],
  cycle: ['cycle'], fade: ['fade'],
  mirror: ['mirror'], pixel: ['pixel'], hue: ['hue'], poster: ['poster'],
  srcBurn: ['srcBurn'], srcOpacity: ['srcOpacity'], srcSize: ['srcSize'], srcX: ['srcX'], srcY: ['srcY'],
};
// locked out of the box: transport and input settings, and the source placement
const DEFAULT_LOCKS = { fade: true, focus: true, dynamics: true, music: true, keyColor: true, lock: true,
                        srcBurn: true, srcOpacity: true, srcSize: true, srcX: true, srcY: true };
function locked(key) {
  for (const [lock, keys] of Object.entries(LOCK_GROUPS)) if (params.locks[lock] && keys.includes(key)) return true;
  return false;
}
function stripLocked(target) {
  for (const k of Object.keys(target)) if (locked(k)) delete target[k];
  return target;
}
// what a scene captures (not input, cycling or transport settings)
const SCENE_KEYS = ['mode', 'palette', 'corrupt', 'decay', 'sens', 'focus', 'cycle', 'fade',
                    'layerB', 'blend', 'paletteB', 'layerC', 'blendC', 'paletteC',
                    'seed', 'seedB', 'seedC', 'mirror', 'pixel', 'hue', 'poster',
                    'srcBurn', 'srcOpacity', 'srcSize', 'srcX', 'srcY'];
// continuous values that glide to a new target over the fade time instead of jumping
const TWEEN_KEYS = ['corrupt', 'decay', 'sens', 'focus', 'music', 'keyColor', 'lock', 'pixel', 'hue', 'poster', 'srcBurn', 'srcOpacity', 'srcSize', 'srcX', 'srcY'];
const rand4 = () => [Math.random(), Math.random(), Math.random(), Math.random()];
// recently used modes / palettes are avoided by RANDOM so runs don't repeat
const recentModes = [], recentPals = [];
function pickFresh(n, recent, keep) {
  const pool = [];
  for (let i = 0; i < n; i++) if (!recent.includes(i)) pool.push(i);
  const i = pool.length ? pool[Math.floor(Math.random() * pool.length)] : Math.floor(Math.random() * n);
  recent.push(i);
  while (recent.length > keep) recent.shift();
  return i;
}
let tween = null; // { from, to, t, dur }
const smoothstep = t => t * t * (3 - 2 * t);

const params = Object.assign({}, DEFAULTS, load());
if (!params.locks || typeof params.locks !== 'object') params.locks = {};
for (const [k, v] of Object.entries(DEFAULT_LOCKS)) if (!(k in params.locks)) params.locks[k] = v;
function load() {
  try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (_) { return {}; }
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(params)); } catch (_) {}
  if (ROLE === 'controller') link.sendParams(params);
}

const wrap = (i, n) => ((i % n) + n) % n;
const scenes = new Scenes();
let sceneIdx = -1;

// ---- apply params to engine / audio -------------------------------------

function apply(fade = params.fade) {
  params.mode = wrap(params.mode, MODES.length);
  params.palette = wrap(params.palette, PALETTES.length);
  if (params.layerB >= MODES.length) params.layerB = -1;
  for (const k of ['seed', 'seedB', 'seedC']) if (!Array.isArray(params[k]) || params[k].length !== 4) params[k] = DEFAULTS[k].slice();
  if (params.layerC >= MODES.length) params.layerC = -1;
  if (params.paletteC >= PALETTES.length) params.paletteC = -1;
  engine.setMode(params.mode, fade, 0, params.seed);
  engine.setMode(params.layerB, fade, 1, params.seedB);
  engine.setMode(params.layerC, fade, 2, params.seedC);
  engine.setPalette(params.paletteC < 0 ? params.palette : params.paletteC, fade, 2);
  engine.setBlend(params.blendC, fade, 2);
  engine.setMirror(params.mirror, fade);
  engine.fx.pixel = params.pixel;
  engine.fx.hue = params.hue;
  engine.fx.poster = params.poster;
  engine.setPalette(params.palette, fade, 0);
  if (params.paletteB >= PALETTES.length) params.paletteB = -1;
  engine.setPalette(params.paletteB < 0 ? params.palette : params.paletteB, fade, 1);
  engine.setBlend(params.blend, fade, 1);
  engine.src.burn = params.srcBurn;
  engine.src.opacity = params.srcOpacity;
  engine.src.size = params.srcSize;
  engine.src.x = params.srcX;
  engine.src.y = params.srcY;
  if (Math.abs(engine.scale - params.res) > 0.001) engine.setScale(params.res);
  audio.sens = params.sens;
  audio.focus = params.focus;
  audio.dynamics = params.dynamics;
}
function commit(fade = params.fade) {
  apply(fade);
  refreshUI();
  save();
}

// ---- setters -------------------------------------------------------------

function setMode(i, fade = params.fade) { params.mode = wrap(i, MODES.length); commit(fade); }
function setPalette(i, fade = params.fade) { params.palette = wrap(i, PALETTES.length); commit(fade); }
function setLayerB(i, fade = params.fade) { params.layerB = Math.max(-1, Math.min(MODES.length - 1, i)); commit(fade); }
function setBlend(i, fade = params.fade) { params.blend = wrap(i, BLENDS.length); commit(fade); }
function setPaletteB(i, fade = params.fade) { params.paletteB = Math.max(-1, Math.min(PALETTES.length - 1, i)); commit(fade); }
function setLayerC(i, fade = params.fade) { params.layerC = Math.max(-1, Math.min(MODES.length - 1, i)); commit(fade); }
function setBlendC(i, fade = params.fade) { params.blendC = wrap(i, BLENDS.length); commit(fade); }
function setPaletteC(i, fade = params.fade) { params.paletteC = Math.max(-1, Math.min(PALETTES.length - 1, i)); commit(fade); }
function setAuto(v) { params.auto = v; commit(0); }
// the two cycle flavours switch auto-cycle on when enabled; AUTO CYCLE is the master switch
function setCycleScenes(v) { params.cycleScenes = v; if (v) { params.randomCycle = false; params.auto = true; } commit(0); }
function setRandomCycle(v) { params.randomCycle = v; if (v) { params.cycleScenes = false; params.auto = true; } commit(0); }

// Move to a new set of values: discrete keys (mode, palette, layer, blend)
// change at once and crossfade in the engine; continuous keys glide over the
// fade time. FADE itself is never part of a transition.
function transitionTo(target, fade = params.fade) {
  const from = {}, to = {};
  let nextFade = null;
  for (const [k, v] of Object.entries(target)) {
    if (k === 'fade') { nextFade = v; continue; } // a new FADE applies after this transition
    if (fade > 0 && TWEEN_KEYS.includes(k) && typeof v === 'number' && Math.abs(v - params[k]) > 1e-6) {
      from[k] = params[k];
      // hue is a circle: take the short way round
      to[k] = k === 'hue' && Math.abs(v - params[k]) > 0.5 ? v + (v < params[k] ? 1 : -1) : v;
    } else {
      params[k] = v;
    }
  }
  tween = Object.keys(to).length ? { from, to, t: 0, dur: fade } : null;
  commit(fade);
  if (nextFade !== null) { params.fade = nextFade; refreshSliders(); save(); }
}
function stepTween(dt) {
  if (!tween) return;
  tween.t = Math.min(1, tween.t + dt / Math.max(0.01, tween.dur));
  const s = smoothstep(tween.t);
  for (const k of Object.keys(tween.to)) {
    let v = tween.from[k] + (tween.to[k] - tween.from[k]) * s;
    if (k === 'hue') v = ((v % 1) + 1) % 1;
    params[k] = v;
  }
  apply(0);
  const done = tween.t >= 1;
  if (done || (engine.frame & 3) === 0) {
    refreshSliders();
    if (ROLE === 'controller') link.sendParams(params);
  }
  if (done) { tween = null; save(); }
}
function setCycle(v) { params.cycle = Math.min(64, Math.max(1, Math.round(v))); commit(0); }
function setSlider(k, v) {
  const el = sliders[k];
  const min = +el.min, max = +el.max, step = +el.step || 0.01;
  v = Math.min(max, Math.max(min, v));
  v = Math.round(v / step) * step;
  params[k] = +v.toFixed(3);
  commit(0);
}

// Reroll everything that shapes the look. Auto-cycle and FADE stay as they
// are; the current FADE is used so mode and palette crossfade and the
// sliders glide to their new values.
function randomize() {
  const r = (a, b) => a + Math.random() * (b - a);
  const pick = n => Math.floor(Math.random() * n);
  const chance = p => Math.random() < p;
  if (!recentModes.includes(params.mode)) recentModes.push(params.mode);
  if (!recentPals.includes(params.palette)) recentPals.push(params.palette);
  const mode = locked('mode') ? params.mode : pickFresh(MODES.length, recentModes, 6);
  const pal = locked('palette') ? params.palette : pickFresh(PALETTES.length, recentPals, 5);
  const target = {
    mode, palette: pal,
    seed: rand4(), seedB: rand4(), seedC: rand4(),
    corrupt: +r(0, 1).toFixed(2),
    decay: +r(0.2, 1).toFixed(2),
    sens: +r(0.7, 2.2).toFixed(2),
    cycle: [2, 4, 8, 8, 16, 16, 32][pick(7)],
    layerB: -1,
    // post treatments: mostly off, so the plain modes still show up
    mirror: chance(0.4) ? [2, 3, 4, 5, 6, 8][pick(6)] : 0,
    pixel: chance(0.25) ? +r(0.15, 0.7).toFixed(2) : 0,
    hue: chance(0.5) ? +r(0, 1).toFixed(2) : 0,
    poster: chance(0.25) ? +r(0.3, 0.9).toFixed(2) : 0,
  };
  if (chance(0.5)) {
    let b = pick(MODES.length);
    if (b === mode) b = (b + 1) % MODES.length;
    target.layerB = b;
    target.blend = pick(BLENDS.length);
    target.paletteB = chance(0.5) ? -1 : pick(PALETTES.length);
  }
  target.layerC = -1;
  if (chance(0.3)) {
    let c = pick(MODES.length);
    if (c === mode || c === target.layerB) c = (c + 2) % MODES.length;
    target.layerC = c;
    target.blendC = pick(BLENDS.length);
    target.paletteC = chance(0.5) ? -1 : pick(PALETTES.length);
  }
  // normally locked; only rolled when the user unlocks them
  target.fade = [0.5, 1, 2, 3, 4, 6][pick(6)];
  target.focus = +r(0, 1).toFixed(2);
  target.dynamics = +r(0.2, 1).toFixed(2);
  target.music = +r(0.3, 1).toFixed(2);
  target.keyColor = +r(0, 1).toFixed(2);
  target.lock = +r(0, 1).toFixed(2);
  if (engine.srcKind !== 'none') {
    target.srcBurn = chance(0.5) ? 0 : +r(0.2, 1).toFixed(2);
    target.srcOpacity = chance(0.4) ? 0 : +r(0.2, 0.8).toFixed(2);
    target.srcSize = +r(0.2, 1).toFixed(2);
    target.srcX = +r(0.2, 0.8).toFixed(2);
    target.srcY = +r(0.2, 0.8).toFixed(2);
  }
  sceneIdx = -1;
  transitionTo(stripLocked(target));
}

// New variation of the current modes only: reroll the seeds, keep everything else.
function vary() {
  if (locked('seed')) return;
  sceneIdx = -1;
  transitionTo({ seed: rand4(), seedB: rand4(), seedC: rand4() });
}

// ---- scenes --------------------------------------------------------------

function sceneParams() {
  const o = {};
  for (const k of SCENE_KEYS) o[k] = params[k];
  return o;
}
function loadScene(i, fade = params.fade) {
  const s = scenes.get(i);
  if (!s) return;
  sceneIdx = i;
  const target = {};
  for (const k of SCENE_KEYS) if (k in s.params) target[k] = s.params[k];
  transitionTo(target, fade);
  if ('fade' in s.params) { params.fade = s.params.fade; refreshSliders(); save(); }
}
function saveScene() {
  const name = window.prompt('Scene name', scenes.get(sceneIdx)?.name || `SCENE ${scenes.list.length + 1}`);
  if (name === null) return;
  sceneIdx = scenes.save(name, sceneParams());
  refreshScenes();
}
function download(name, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- UI build ------------------------------------------------------------

const modeRow = $('#modes');
MODES.forEach((m, i) => {
  const b = document.createElement('button');
  // keys 1-9 then 0 reach the first ten modes; the rest are click / arrows
  const key = i < 9 ? String(i + 1) : i === 9 ? '0' : '';
  b.textContent = key ? `${key} ${m.name}` : m.name;
  b.title = m.blurb;
  b.dataset.i = i;
  b.dataset.target = `mode:${i}`;
  b.addEventListener('click', () => guard(`mode:${i}`, () => setMode(i)));
  modeRow.appendChild(b);
});

const palRow = $('#palettes');
PALETTES.forEach((p, i) => {
  const b = document.createElement('button');
  b.textContent = p;
  b.dataset.i = i;
  b.dataset.target = `pal:${i}`;
  b.addEventListener('click', () => guard(`pal:${i}`, () => setPalette(i)));
  palRow.appendChild(b);
});

const layerSel = $('#layerB');
layerSel.appendChild(new Option('B OFF', -1));
MODES.forEach((m, i) => layerSel.appendChild(new Option('B ' + m.name, i)));
layerSel.addEventListener('change', () => setLayerB(+layerSel.value));
layerSel.addEventListener('mousedown', e => { if (midi.learning) { e.preventDefault(); midi.arm('layerSel'); } });
const blendSel = $('#blend');
BLENDS.forEach((b, i) => blendSel.appendChild(new Option(b, i)));
blendSel.addEventListener('change', () => setBlend(+blendSel.value));
blendSel.addEventListener('mousedown', e => { if (midi.learning) { e.preventDefault(); midi.arm('blendSel'); } });
const palBSel = $('#paletteB');
palBSel.appendChild(new Option('FOLLOW A', -1));
PALETTES.forEach((p, i) => palBSel.appendChild(new Option(p, i)));
palBSel.addEventListener('change', () => setPaletteB(+palBSel.value));
palBSel.addEventListener('mousedown', e => { if (midi.learning) { e.preventDefault(); midi.arm('palBSel'); } });

const layerCSel = $('#layerC');
layerCSel.appendChild(new Option('C OFF', -1));
MODES.forEach((m, i) => layerCSel.appendChild(new Option('C ' + m.name, i)));
layerCSel.addEventListener('change', () => setLayerC(+layerCSel.value));
layerCSel.addEventListener('mousedown', e => { if (midi.learning) { e.preventDefault(); midi.arm('layerCSel'); } });
const blendCSel = $('#blendC');
BLENDS.forEach((b, i) => blendCSel.appendChild(new Option(b, i)));
blendCSel.addEventListener('change', () => setBlendC(+blendCSel.value));
blendCSel.addEventListener('mousedown', e => { if (midi.learning) { e.preventDefault(); midi.arm('blendCSel'); } });
const palCSel = $('#paletteC');
palCSel.appendChild(new Option('FOLLOW A', -1));
PALETTES.forEach((p, i) => palCSel.appendChild(new Option(p, i)));
palCSel.addEventListener('change', () => setPaletteC(+palCSel.value));
palCSel.addEventListener('mousedown', e => { if (midi.learning) { e.preventDefault(); midi.arm('palCSel'); } });

const sliders = {};
for (const k of ['corrupt', 'decay', 'sens', 'focus', 'dynamics', 'music', 'keyColor', 'lock', 'cycle', 'fade', 'res', 'mirror', 'pixel', 'hue', 'poster', 'srcBurn', 'srcOpacity', 'srcSize', 'srcX', 'srcY']) {
  const el = $(`#${k}`);
  sliders[k] = el;
  el.dataset.target = k;
  el.addEventListener('input', () => {
    if (tween) delete tween.to[k]; // a hand on the slider wins over a glide
    params[k] = parseFloat(el.value);
    apply(0);
    $(`#${k}Val`).textContent = fmt(k);
    if (k === 'res') $(`#${k}Val`).textContent = fmt(k);
    save();
  });
  el.addEventListener('pointerdown', e => {
    if (midi.learning) { e.preventDefault(); midi.arm(k); }
  });
}
function fmt(k) {
  const v = params[k];
  if (k === 'sens') return v.toFixed(2) + 'x';
  if (k === 'cycle') return v + (v === 1 ? ' BEAT' : ' BEATS');
  if (k === 'fade') return v === 0 ? 'CUT' : v.toFixed(1) + ' S';
  if (k === 'res') return `${Math.round(v * 100)}% ${engine.canvas.width}x${engine.canvas.height}`;
  if (k === 'mirror') return v < 2 ? 'OFF' : `${v} WAY`;
  if (k === 'hue') return v === 0 ? 'OFF' : Math.round(v * 360) + ' DEG';
  if (k === 'srcSize') return Math.round(v * 100) + '%';
  return Math.round(v * 100) + '%';
}

function refreshSliders() {
  for (const [k, el] of Object.entries(sliders)) {
    el.value = params[k];
    $(`#${k}Val`).textContent = fmt(k);
  }
}

// lock toggles: exclude a setting from RANDOM / RANDOM CYCLE / VARY
const LOCK_SVG = '<svg class="open" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="7" width="10" height="7" rx="1"/><path d="M5 7V5a3 3 0 0 1 6 0"/></svg>'
  + '<svg class="closed" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="7" width="10" height="7" rx="1"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>';
document.querySelectorAll('.lock').forEach(b => {
  if (!b.firstChild) b.innerHTML = LOCK_SVG;
  if (!b.title || b.title === 'lock') b.title = 'exclude from randomization';
  b.addEventListener('click', e => {
    e.stopPropagation();
    const k = b.dataset.lock;
    params.locks[k] = !params.locks[k];
    refreshLocks();
    save();
  });
});
function refreshLocks() {
  document.querySelectorAll('.lock').forEach(b => b.classList.toggle('on', !!params.locks[b.dataset.lock]));
  const n = Object.values(params.locks).filter(Boolean).length;
  $('#random').title = n ? `${n} setting${n > 1 ? 's' : ''} locked` : 'reroll everything';
}
function setAllLocks(v) {
  for (const k of Object.keys(LOCK_GROUPS)) params.locks[k] = v;
  refreshLocks();
  save();
}
$('#lockAll').addEventListener('click', () => setAllLocks(true));
$('#unlockAll').addEventListener('click', () => setAllLocks(false));

function refreshUI() {
  $('#modeName').textContent = MODES[params.mode].name;
  $('#modeBlurb').textContent = MODES[params.mode].blurb;
  [...modeRow.children].forEach(b => b.classList.toggle('on', +b.dataset.i === params.mode));
  [...palRow.children].forEach(b => b.classList.toggle('on', +b.dataset.i === params.palette));
  layerSel.value = params.layerB;
  blendSel.value = params.blend;
  palBSel.value = params.paletteB;
  layerCSel.value = params.layerC;
  blendCSel.value = params.blendC;
  palCSel.value = params.paletteC;
  $('#auto').classList.toggle('on', params.auto);
  $('#cycleScenes').classList.toggle('on', params.cycleScenes);
  $('#randomCycle').classList.toggle('on', params.randomCycle);
  refreshSliders();
  refreshLocks();
  $('#osc').classList.toggle('on', params.osc);
  $('#midi').classList.toggle('on', params.midi);
  refreshScenes();
  refreshCtl();
}

function refreshScenes() {
  const row = $('#scenes');
  row.innerHTML = '';
  scenes.list.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.target = `scene:${i}`;
    b.classList.toggle('on', i === sceneIdx);
    const key = i < 9 ? `${i + 1} ` : '';
    b.innerHTML = `<span>${key}${escapeHtml(s.name)}</span><span class="x" title="delete">✕</span>`;
    b.addEventListener('click', e => {
      if (e.target.classList.contains('x')) {
        scenes.remove(i);
        if (sceneIdx === i) sceneIdx = -1; else if (sceneIdx > i) sceneIdx--;
        refreshScenes();
        return;
      }
      guard(`scene:${i}`, () => loadScene(i));
    });
    row.appendChild(b);
  });
  if (!scenes.list.length) {
    const t = document.createElement('span');
    t.className = 'lbl';
    t.style.margin = '0';
    t.textContent = 'no scenes saved. SAVE SCENE snapshots the current look.';
    row.appendChild(t);
  }
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// in MIDI learn mode, clicking a control arms it instead of acting
function guard(target, fn) {
  if (midi.learning) midi.arm(target);
  else fn();
}

// ---- status line ---------------------------------------------------------

function setStatus() {
  const s = $('#status');
  if (audio.error) { s.textContent = audio.error; s.dataset.state = 'err'; }
  else {
    s.textContent = { off: 'NO INPUT', mic: 'MIC LIVE', system: 'SYSTEM AUDIO', test: 'TEST SIGNAL', remote: 'LINKED' }[audio.mode];
    s.dataset.state = audio.mode;
  }
  $('#mic').classList.toggle('on', audio.mode === 'mic');
  $('#system').classList.toggle('on', audio.mode === 'system');
  $('#test').classList.toggle('on', audio.mode === 'test');
  refreshDevices();
}

async function refreshDevices() {
  const sel = $('#device');
  const list = await audio.listDevices();
  const cur = audio.deviceId || localStorage.getItem('soundglitch.device') || '';
  sel.innerHTML = '';
  sel.appendChild(new Option('DEFAULT INPUT', ''));
  list.forEach((d, i) => sel.appendChild(new Option((d.label || `INPUT ${i + 1}`).toUpperCase().slice(0, 28), d.deviceId)));
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : '';
}

function refreshCtl() {
  const parts = [];
  parts.push(midi.status);
  if (midi.learning) parts.push(midi.armed ? `ARMED: ${midi.armed.toUpperCase()} — move a knob or hit a pad` : 'LEARN: click a slider, button, mode, palette or scene, then move a control');
  if (midi.count()) parts.push(`${midi.count()} MAPPED`);
  if (midi.lastKey) parts.push(`LAST: ${midi.lastKey}`);
  $('#ctlTxt').textContent = parts.join('  ·  ');
  $('#midiTxt').textContent = midi.access ? midi.status : '';
  $('#oscTxt').textContent = params.osc ? link.wsStatus : '';
  $('#oscTxt').classList.toggle('on', link.wsStatus === 'OSC LINKED');
  $('#linkTxt').textContent = link.outputs > 0 ? `${link.outputs} OUTPUT${link.outputs > 1 ? 'S' : ''}` : '';
  $('#linkTxt').classList.toggle('on', link.outputs > 0);
  $('#learn').classList.toggle('on', midi.learning);
  document.body.classList.toggle('learning', midi.learning);
  const mapped = midi.mappedTargets();
  document.querySelectorAll('[data-target]').forEach(el => {
    el.classList.toggle('mapped', mapped.has(el.dataset.target));
    el.classList.toggle('armed', midi.armed === el.dataset.target);
  });
}

// ---- input buttons -------------------------------------------------------

$('#mic').addEventListener('click', async () => {
  if (midi.learning) return;
  if (audio.mode === 'mic') { audio.stop(); setStatus(); return; }
  try { await audio.startMic(localStorage.getItem('soundglitch.device') || null); } catch (_) {}
  setStatus();
});
$('#system').addEventListener('click', async () => {
  if (audio.mode === 'system') { audio.stop(); setStatus(); return; }
  try { await audio.startSystem(); } catch (_) {}
  setStatus();
});
$('#test').addEventListener('click', async () => {
  if (audio.mode === 'test') { audio.stop(); setStatus(); return; }
  await audio.startTest();
  setStatus();
});
$('#device').addEventListener('change', async () => {
  const id = $('#device').value;
  try { localStorage.setItem('soundglitch.device', id); } catch (_) {}
  if (audio.mode === 'mic') {
    try { await audio.startMic(id || null); } catch (_) {}
    setStatus();
  }
});

$('#auto').addEventListener('click', () => guard('auto', () => setAuto(!params.auto)));
$('#cycleScenes').addEventListener('click', () => guard('cycleScenes', () => setCycleScenes(!params.cycleScenes)));
$('#randomCycle').addEventListener('click', () => guard('randomCycle', () => setRandomCycle(!params.randomCycle)));
$('#random').addEventListener('click', () => guard('random', randomize));
$('#vary').addEventListener('click', () => guard('vary', vary));
$('#clear').addEventListener('click', () => guard('clear', () => { engine.clear(); link.sendCmd('clear'); }));
$('#full').addEventListener('click', toggleFull);
$('#hide').addEventListener('click', () => document.body.classList.toggle('hidden'));
$('#stage').addEventListener('click', () => {
  window.open(`${location.pathname}?output`, 'sgOutput', 'popup=yes,width=1280,height=720');
});

function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

// ---- source: image / camera ----------------------------------------------

let srcDataUrl = null;
let srcImage = null;
let camStream = null;
const SRC_KEY = 'soundglitch.source';

// The clean overlay lives on its own full-resolution canvas above the shader
// canvas. Nothing in the effect chain or the analyser can reach it; only
// OVERLAY (opacity), SIZE, X and Y place it. BURN is the separate, deliberate
// path that feeds the source into the feedback loop.
const logoCanvas = $('#logo');
const logoCtx = logoCanvas.getContext('2d');
function drawLogo() {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.floor(logoCanvas.clientWidth * dpr), H = Math.floor(logoCanvas.clientHeight * dpr);
  if (logoCanvas.width !== W || logoCanvas.height !== H) { logoCanvas.width = W; logoCanvas.height = H; }
  const src = engine.srcKind === 'image' ? srcImage : engine.srcKind === 'video' ? engine.srcVideo : null;
  const op = params.srcOpacity;
  logoCtx.clearRect(0, 0, W, H);
  if (!src || op <= 0) return;
  if (engine.srcKind === 'video' && (src.readyState < 2 || !src.videoWidth)) return;
  const aspect = engine.srcKind === 'video' ? src.videoWidth / src.videoHeight : engine.srcAspect;
  const h = params.srcSize * H;
  const w = h * aspect;
  const x = params.srcX * W - w / 2;
  const y = (1 - params.srcY) * H - h / 2;
  logoCtx.globalAlpha = Math.min(1, op);
  logoCtx.imageSmoothingQuality = 'high';
  logoCtx.drawImage(src, x, y, w, h);
  logoCtx.globalAlpha = 1;
}

// A copy small enough to keep in localStorage and to mirror to output windows
// (a phone photo as a data URL blows the 5 MB quota and would silently vanish).
function shrinkForStore(img, max = 1536) {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const s = Math.min(1, max / Math.max(w, h));
  if (s === 1 && srcDataUrl && srcDataUrl.length < 2.5e6) return srcDataUrl;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

function useImageDataUrl(dataUrl, persist) {
  const img = new Image();
  img.onload = () => {
    stopCamera();
    engine.setSourceImage(img);
    srcImage = img;
    srcDataUrl = dataUrl;
    // a freshly dropped logo should be visible at once: clean overlay on, untouched
    if (params.srcBurn === 0 && params.srcOpacity === 0) { params.srcOpacity = 1; commit(0); }
    let stored = null;
    try { stored = shrinkForStore(img); } catch (_) {}
    if (persist && stored) { try { localStorage.setItem(SRC_KEY, stored); } catch (_) { srcNote('image loaded (too large to remember)'); } }
    if (ROLE === 'controller') link.sendSource(stored || dataUrl);
    refreshSrc();
  };
  img.onerror = () => srcNote('could not read that image');
  img.src = dataUrl;
}
function srcNote(text) {
  $('#srcTxt').textContent = text;
  $('#srcSection').open = true;
}
function loadImageFile(f) {
  if (!f) return;
  if (!f.type.startsWith('image/') && !/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(f.name || '')) { srcNote('not an image file'); return; }
  const rd = new FileReader();
  rd.onload = () => useImageDataUrl(rd.result, true);
  rd.onerror = () => srcNote('could not read that file');
  rd.readAsDataURL(f);
}
// an image dragged from another web page arrives as a URL; fetch it if the
// host allows, otherwise explain
async function loadImageUrl(url) {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(res.status);
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) throw new Error('not an image');
    loadImageFile(new File([blob], 'dropped', { type: blob.type }));
  } catch (_) {
    srcNote('that site blocks image drops. save the file first, then drop it');
  }
}
function takeDrop(dt) {
  const f = [...(dt.files || [])].find(x => x.type.startsWith('image/')) || (dt.files && dt.files[0]);
  if (f) { loadImageFile(f); return true; }
  const html = dt.getData('text/html');
  const m = html && html.match(/<img[^>]+src=["']([^"']+)["']/i);
  const uri = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').split('\n')[0].trim();
  const url = (m && m[1]) || uri;
  if (url && /^(https?:|data:image|blob:)/i.test(url)) { loadImageUrl(url); return true; }
  return false;
}

$('#imageBtn').addEventListener('click', () => $('#imageFile').click());
$('#imageFile').addEventListener('change', () => {
  loadImageFile($('#imageFile').files[0]);
  $('#imageFile').value = '';
});
// drag and drop an image anywhere on the page
let dragDepth = 0;
window.addEventListener('dragenter', e => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dropping');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove('dropping');
});
window.addEventListener('dragover', e => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  if (!takeDrop(e.dataTransfer)) srcNote('drop an image file (png, jpg, svg)');
});
// paste an image from the clipboard
window.addEventListener('paste', e => {
  const items = [...(e.clipboardData?.items || [])];
  const it = items.find(i => i.type.startsWith('image/'));
  if (it) { e.preventDefault(); loadImageFile(it.getAsFile()); }
});

async function startCamera() {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
  } catch (e) {
    $('#srcTxt').textContent = 'CAMERA DENIED';
    return;
  }
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.srcObject = camStream;
  await v.play();
  engine.setSourceVideo(v);
  if (params.srcBurn === 0 && params.srcOpacity === 0) { params.srcBurn = 0.6; params.srcSize = 1; commit(0); }
  refreshSrc();
}
function stopCamera() {
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
}
$('#camera').addEventListener('click', () => {
  if (camStream) { stopCamera(); engine.clearSource(); refreshSrc(); return; }
  startCamera();
});
$('#srcClear').addEventListener('click', () => {
  stopCamera();
  engine.clearSource();
  srcDataUrl = null;
  srcImage = null;
  try { localStorage.removeItem(SRC_KEY); } catch (_) {}
  if (ROLE === 'controller') link.sendSource(null);
  refreshSrc();
});
function refreshSrc() {
  $('#camera').classList.toggle('on', !!camStream);
  $('#srcTxt').textContent = { none: 'no source', image: 'image loaded', video: 'camera live' }[engine.srcKind];
  if (engine.srcKind !== 'none') $('#srcSection').open = true;
}

// ---- scenes buttons ------------------------------------------------------

$('#sceneSave').addEventListener('click', saveScene);
$('#sceneExport').addEventListener('click', () => download('soundglitch-scenes.json', scenes.exportJSON()));
$('#sceneImportBtn').addEventListener('click', () => $('#sceneImport').click());
$('#sceneImport').addEventListener('change', () => {
  const f = $('#sceneImport').files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try { scenes.importJSON(rd.result); refreshScenes(); }
    catch (e) { window.alert('Import failed: ' + e.message); }
  };
  rd.readAsText(f);
  $('#sceneImport').value = '';
});

// ---- MIDI / OSC ----------------------------------------------------------

// A target names what a control does; value is 0..1 for CCs, edge is true on
// a note-on or when a CC crosses half.
function act(target, value = 1, isCC = false, edge = true) {
  if (sliders[target]) {
    const el = sliders[target];
    setSlider(target, +el.min + value * (+el.max - +el.min));
    return;
  }
  const [kind, arg] = target.split(':');
  const n = MODES.length;
  switch (kind) {
    case 'mode': if (edge) setMode(+arg); break;
    case 'modeSel': setMode(Math.min(n - 1, Math.floor(value * n))); break;
    case 'pal': if (edge) setPalette(+arg); break;
    case 'palSel': setPalette(Math.min(PALETTES.length - 1, Math.floor(value * PALETTES.length))); break;
    case 'scene': if (edge) loadScene(+arg); break;
    case 'sceneSel': if (scenes.list.length) loadScene(Math.min(scenes.list.length - 1, Math.floor(value * scenes.list.length))); break;
    case 'layerSel': setLayerB(Math.floor(value * (n + 1)) - 1); break;
    case 'blendSel': setBlend(Math.min(BLENDS.length - 1, Math.floor(value * BLENDS.length))); break;
    case 'palBSel': setPaletteB(Math.floor(value * (PALETTES.length + 1)) - 1); break;
    case 'layerCSel': setLayerC(Math.floor(value * (n + 1)) - 1); break;
    case 'blendCSel': setBlendC(Math.min(BLENDS.length - 1, Math.floor(value * BLENDS.length))); break;
    case 'palCSel': setPaletteC(Math.floor(value * (PALETTES.length + 1)) - 1); break;
    case 'next': if (edge) setMode(params.mode + 1); break;
    case 'prev': if (edge) setMode(params.mode - 1); break;
    case 'random': if (edge) randomize(); break;
    case 'vary': if (edge) vary(); break;
    case 'clear': if (edge) { engine.clear(); link.sendCmd('clear'); } break;
    case 'auto': if (edge) setAuto(!params.auto); break;
    case 'cycleScenes': if (edge) setCycleScenes(!params.cycleScenes); break;
    case 'randomCycle': if (edge) setRandomCycle(!params.randomCycle); break;
    case 'mic': if (edge) $('#mic').click(); break;
  }
}

const midi = new Midi(act);
midi.onChange = refreshCtl;
$('#midi').addEventListener('click', async () => {
  if (params.midi && midi.access) { params.midi = false; midi.setLearning(false); commit(0); return; }
  params.midi = await midi.init();
  commit(0);
});
$('#learn').addEventListener('click', async () => {
  if (!midi.access) { params.midi = await midi.init(); }
  midi.setLearning(!midi.learning);
  refreshUI();
});
$('#midiClear').addEventListener('click', () => { midi.clearAll(); refreshCtl(); });

// OSC addresses: /sg/<slider> f (0..1 of the slider's range), /sg/cycle i (beats),
// /sg/mode i, /sg/next, /sg/prev, /sg/palette i, /sg/layer i (-1 off), /sg/blend i,
// /sg/scene i|s, /sg/random, /sg/clear, /sg/auto i, /sg/cycleScenes i, /sg/fadeTo i f
function onOsc(address, args) {
  const v = args.length ? (args[0].value ?? args[0]) : null;
  const name = address.replace(/^\/sg\//, '');
  if (sliders[name]) { if (typeof v === 'number') act(name, name === 'cycle' ? (v - 1) / 63 : v); return; }
  switch (name) {
    case 'mode': if (typeof v === 'number') setMode(v); break;
    case 'next': setMode(params.mode + 1); break;
    case 'prev': setMode(params.mode - 1); break;
    case 'palette': if (typeof v === 'number') setPalette(v); break;
    case 'layer': if (typeof v === 'number') setLayerB(v); break;
    case 'blend': if (typeof v === 'number') setBlend(v); break;
    case 'paletteB': if (typeof v === 'number') setPaletteB(v); break;
    case 'layerC': if (typeof v === 'number') setLayerC(v); break;
    case 'blendC': if (typeof v === 'number') setBlendC(v); break;
    case 'paletteC': if (typeof v === 'number') setPaletteC(v); break;
    case 'scene': {
      if (typeof v === 'number') loadScene(v);
      else if (typeof v === 'string') { const i = scenes.list.indexOf(scenes.byName(v)); if (i >= 0) loadScene(i); }
      break;
    }
    case 'random': randomize(); break;
    case 'vary': vary(); break;
    case 'clear': engine.clear(); link.sendCmd('clear'); break;
    case 'auto': setAuto(typeof v === 'number' ? v > 0 : !params.auto); break;
    case 'cycleScenes': setCycleScenes(typeof v === 'number' ? v > 0 : !params.cycleScenes); break;
    case 'randomCycle': setRandomCycle(typeof v === 'number' ? v > 0 : !params.randomCycle); break;
    case 'fadeTo': { // /sg/fadeTo <mode> <seconds>
      const secs = args[1] ? (args[1].value ?? args[1]) : params.fade;
      if (typeof v === 'number') setMode(v, +secs);
      break;
    }
  }
}

$('#osc').addEventListener('click', () => { params.osc = !params.osc; link.setWs(params.osc); commit(0); });

// ---- link (controller <-> output windows) --------------------------------

const link = new Link(ROLE, {
  onParams: p => {
    const fade = typeof p.fade === 'number' ? p.fade : params.fade;
    Object.assign(params, p);
    apply(fade);
    $('#tagTxt').textContent = 'linked';
  },
  onCmd: name => { if (name === 'clear') engine.clear(); },
  onAudio: m => audio.applyRemote(m),
  onSource: m => { if (m.dataUrl) useImageDataUrl(m.dataUrl, false); else { engine.clearSource(); srcImage = null; } },
  onOutputJoined: () => { link.sendParams(params); if (srcDataUrl) link.sendSource(srcDataUrl); refreshCtl(); },
  onOsc,
  onStatus: refreshCtl,
});
window.addEventListener('beforeunload', () => link.close());

// ---- keys ----------------------------------------------------------------

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const k = e.key;
  if (ROLE === 'output') {
    if (k === 'f' || k === 'F') toggleFull();
    return;
  }
  if (e.shiftKey && /^[!@#$%^&*(]$/.test(k)) { // shift+1..9 on US layouts
    loadScene('!@#$%^&*('.indexOf(k));
  } else if (e.shiftKey && k >= '1' && k <= '9') loadScene(+k - 1);
  else if (k >= '0' && k <= '9') { const i = k === '0' ? 9 : +k - 1; if (i < MODES.length) setMode(i); }
  else if (k === ' ') { e.preventDefault(); setMode(params.mode + 1); }
  else if (k === 'ArrowRight') setMode(params.mode + 1);
  else if (k === 'ArrowLeft') setMode(params.mode - 1);
  else if (k === 'p' || k === 'P') setPalette(params.palette + 1);
  else if (k === 'a' || k === 'A') setAuto(!params.auto);
  else if (k === '[') setCycle(params.cycle > 8 ? params.cycle - 4 : params.cycle - 1);
  else if (k === ']') setCycle(params.cycle >= 8 ? params.cycle + 4 : params.cycle + 1);
  else if (k === 'f' || k === 'F') toggleFull();
  else if (k === 'h' || k === 'H') document.body.classList.toggle('hidden');
  else if (k === 'c' || k === 'C') { engine.clear(); link.sendCmd('clear'); }
  else if (k === 'r' || k === 'R') randomize();
  else if (k === 'v' || k === 'V') vary();
  else if (k === 'm' || k === 'M') $('#mic').click();
  else if (k === 't' || k === 'T') $('#test').click();
});

// ---- keep the display awake ----------------------------------------------
// Screen Wake Lock: while held, the OS won't start the screensaver or sleep
// the display. It drops when the tab is hidden, so it is re-requested on
// every visibility change; the first attempt happens at load, and again on
// the first click in case the browser wanted a gesture.
let wakeLock = null;
let wakeState = 'wakeLock' in navigator ? 'off' : 'unsupported';
async function keepAwake() {
  if (wakeState === 'unsupported' || document.visibilityState !== 'visible') { refreshWake(); return; }
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeState = 'held';
    wakeLock.addEventListener('release', () => { wakeState = 'off'; refreshWake(); });
  } catch (e) {
    wakeLock = null;
    wakeState = e && e.name === 'NotAllowedError' ? 'denied' : 'off';
  }
  refreshWake();
}
function refreshWake() {
  const el = $('#wakeTxt');
  if (!el) return;
  const held = wakeState === 'held';
  el.textContent = { held: 'AWAKE', off: 'WAKE OFF', denied: 'WAKE DENIED', unsupported: 'NO WAKE LOCK' }[wakeState];
  el.classList.toggle('on', held);
  el.title = {
    held: 'screen wake lock held: no screensaver or display sleep while this tab is visible',
    off: 'the display may sleep; click anywhere to request a wake lock',
    denied: 'this browser refused the wake lock (embedded or restricted browser); use a normal Chrome/Safari window, or caffeinate',
    unsupported: 'this browser has no Screen Wake Lock API; use the launcher (caffeinate) or turn off display sleep',
  }[wakeState];
  const tag = $('#tagWake');
  if (tag) tag.textContent = held ? 'awake' : '';
}
document.addEventListener('visibilitychange', keepAwake);
window.addEventListener('pointerdown', keepAwake, { once: false });
keepAwake();

// auto-hide UI when the mouse is still
let idleTimer;
function poke() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 3500);
}
window.addEventListener('mousemove', poke);
window.addEventListener('mousedown', poke);
window.addEventListener('keydown', poke);
window.addEventListener('touchstart', poke, { passive: true });
poke();

// ---- loop ----------------------------------------------------------------

const meters = ['level', 'bass', 'mid', 'treble', 'energy'].map(k => [k, $(`#m-${k}`)]);
let t0 = performance.now(), last = t0, lastCycle = 0, lastBeatCount = 0, dueSince = -1;
let visTime = 0; // shader time; advances slower when the sound is soft and DYNAMICS is up
const lerp = (a, b, t) => a + (b - a) * t;

// seconds to wait for a mode change when no beats are being detected;
// stretches when the sound is soft so quiet passages also cycle less
function cycleFallback() {
  const calm = lerp(1, 0.4 + 0.6 * audio.energy, params.dynamics);
  return Math.max(3, params.cycle * 0.75 / calm);
}

function stepCycle() {
  if (params.randomCycle) randomize();
  else if (params.cycleScenes && scenes.list.length) loadScene(wrap(sceneIdx + 1, scenes.list.length));
  else transitionTo(stripLocked({ mode: wrap(params.mode + 1, MODES.length), seed: rand4() })); // next mode, fresh variation
}

function frame(now) {
  const time = (now - t0) / 1000;
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  audio.update();
  if (ROLE === 'controller') stepTween(dt);
  engine.resize();
  // dynamics: soft sound slows the drift and calms the corruption as well as the reaction;
  // LOCK makes the drift rate follow the tempo (120 BPM = 1x) when the tracker is confident
  const calm = lerp(1, 0.25 + 0.75 * audio.energy, params.dynamics);
  const tempoOk = audio.tempoConf > 0.3 && audio.bpm > 0 && audio.mode !== 'off';
  const rate = tempoOk ? lerp(1, Math.min(2, Math.max(0.4, audio.bpm / 120)), params.lock) : 1;
  visTime += dt * calm * rate;
  const renderParams = calm < 0.999 ? Object.assign({}, params, { corrupt: params.corrupt * calm }) : params;
  engine.render(audio, renderParams, visTime, dt);
  drawLogo();
  if (ROLE === 'controller') link.sendAudio(audio.features());

  if (ROLE === 'controller') {
    for (const [k, el] of meters) el.style.transform = `scaleX(${Math.min(1, k === 'energy' ? audio.energy : audio[k] / 1.2)})`;
    $('#beat').classList.toggle('hit', audio.beat > 0.5);
    $('#tick').classList.toggle('hit', audio.tempoBeat > 0.5);
    $('#clip').classList.toggle('hit', audio.clip);
    $('#music').classList.toggle('hit', audio.music > 0.5);
    $('#kick').classList.toggle('hit', audio.kick > 0.5);
    $('#snare').classList.toggle('hit', audio.snare > 0.5);
    $('#hat').classList.toggle('hit', audio.hat > 0.5);
    $('#drop').classList.toggle('hit', audio.drop > 0.3);
    $('#downbeatFlag').classList.toggle('hit', audio.downbeat > 0.5);
    if ((engine.frame & 15) === 0) {
      $('#tempoTxt').textContent = audio.bpm && audio.tempoConf > 0.2 ? `${Math.round(audio.bpm)} BPM` : '-- BPM';
      $('#music').textContent = `MUSIC ${Math.round(audio.music * 100)}%`;
      $('#tick').textContent = audio.tempoConf > 0.2 ? `TEMPO ${Math.round(audio.tempoConf * 100)}%` : 'TEMPO';
      const tempoOk = audio.tempoConf > 0.2;
      $('#keyTxt').textContent = `KEY ${audio.chromaClarity > 0.15 ? KEY_NAMES[audio.key] : '--'}`;
      $('#barTxt').textContent = tempoOk ? `BAR ${audio.bar}.${audio.beatInBar + 1}  PHRASE ${audio.phrase}` : 'BAR --';
      $('#toneTxt').textContent = `BRIGHT ${Math.round(audio.centroid * 100)}  NOISE ${Math.round(audio.flatness * 100)}  WIDTH ${Math.round(audio.width * 100)}  BUILD ${Math.round(audio.build * 100)}`;
    }

    // auto-cycle: every CYCLE beats, or a time fallback; when the tempo tracker
    // is confident, hold the switch until the next predicted beat
    if (params.auto) {
      const due = audio.beatCount - lastBeatCount >= params.cycle || time - lastCycle > cycleFallback();
      if (due && dueSince < 0) dueSince = time;
      if (due) {
        const quantize = audio.tempoConf > 0.3 && audio.mode !== 'off';
        const onBeat = audio.beatPhase > 0.94 || audio.beatPhase < 0.04;
        if (!quantize || onBeat || time - dueSince > 1.2) {
          lastBeatCount = audio.beatCount;
          lastCycle = time;
          dueSince = -1;
          stepCycle();
        }
      }
    } else {
      lastCycle = time;
      lastBeatCount = audio.beatCount;
      dueSince = -1;
    }
  }

  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => engine.resize());

// ---- boot ----------------------------------------------------------------

document.body.classList.toggle('output', ROLE === 'output');
// initial state without any fade
{
  const modes = [params.mode, params.layerB, params.layerC];
  const pals = [params.palette, params.paletteB, params.paletteC];
  const seeds = [params.seed, params.seedB, params.seedC];
  const blends = [1, params.blend, params.blendC];
  engine.layers.forEach((L, i) => {
    L.mode = i === 0 ? params.mode : (modes[i] >= 0 && modes[i] < MODES.length ? modes[i] : -1);
    L.palette = i > 0 && pals[i] >= 0 ? pals[i] : params.palette;
    if (Array.isArray(seeds[i]) && seeds[i].length === 4) L.seed = seeds[i].slice();
    L.blend = L.blendFrom = blends[i];
    L.alpha = L.alphaTarget = L.mode >= 0 ? 1 : 0;
  });
  engine.fx.mirror = params.mirror;
}
apply(0);
refreshUI();
setStatus();
refreshSrc();
try {
  const stored = localStorage.getItem(SRC_KEY);
  if (stored) useImageDataUrl(stored, false);
} catch (_) {}
if (ROLE === 'controller') {
  if (params.midi) midi.init().then(ok => { params.midi = ok; refreshUI(); });
  if (params.osc) link.setWs(true);
  audio.listDevices().then(refreshDevices);
}
requestAnimationFrame(frame);

// debug hooks
window.sg = { audio, engine, params, scenes, midi, link, frame: () => frame(performance.now()), setMode, setPalette, setLayerB, setPaletteB, setLayerC, setBlendC, setPaletteC, randomize, vary, transitionTo, loadScene, act, onOsc, apply, ROLE, tween: () => tween };
