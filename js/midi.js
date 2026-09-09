// Web MIDI input with learn-mode mapping.
// Mappings live in localStorage as { "cc:<ch>:<num>" | "note:<ch>:<num>": target }.
// The app decides what a target string means (see actions in app.js).

const KEY = 'soundglitch.midi';

export class Midi {
  constructor(onAction) {
    this.onAction = onAction;
    this.onChange = null;
    this.map = this._load();
    this.learning = false;
    this.armed = null;
    this.status = 'MIDI OFF';
    this.access = null;
    this.lastKey = '';
    this._last = new Map();
  }

  _load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (_) { return {}; }
  }
  _save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.map)); } catch (_) {}
  }

  async init() {
    if (!navigator.requestMIDIAccess) { this.status = 'MIDI UNSUPPORTED'; this._changed(); return false; }
    try {
      this.access = await navigator.requestMIDIAccess();
      this._bind();
      this.access.onstatechange = () => this._bind();
      return true;
    } catch (e) {
      this.status = 'MIDI DENIED';
      this._changed();
      return false;
    }
  }

  _bind() {
    let n = 0;
    for (const inp of this.access.inputs.values()) {
      inp.onmidimessage = e => this._msg(e);
      n++;
    }
    this.status = n ? `MIDI ${n} IN` : 'NO MIDI DEVICE';
    this._changed();
  }

  _changed() { if (this.onChange) this.onChange(); }

  _msg(e) {
    const [st, d1, d2] = e.data;
    const type = st & 0xf0, ch = st & 0x0f;
    let key, value, isCC;
    if (type === 0xb0) { key = `cc:${ch}:${d1}`; value = d2 / 127; isCC = true; }
    else if (type === 0x90 && d2 > 0) { key = `note:${ch}:${d1}`; value = 1; isCC = false; }
    else return;
    this.lastKey = key;
    if (this.armed) {
      this.map[key] = this.armed;
      this.armed = null;
      this._save();
      this._changed();
      return;
    }
    const target = this.map[key];
    if (!target) return;
    // buttons on a CC fire on the rising edge through half
    const prev = this._last.get(key) || 0;
    this._last.set(key, value);
    this.onAction(target, value, isCC, isCC ? (prev <= 0.5 && value > 0.5) : true);
  }

  setLearning(on) {
    this.learning = on;
    if (!on) this.armed = null;
    this._changed();
  }

  arm(target) {
    this.armed = target;
    this._changed();
  }

  forget(target) {
    for (const k of Object.keys(this.map)) if (this.map[k] === target) delete this.map[k];
    this._save();
    this._changed();
  }

  clearAll() {
    this.map = {};
    this._save();
    this._changed();
  }

  count() { return Object.keys(this.map).length; }
  mappedTargets() { return new Set(Object.values(this.map)); }
}
