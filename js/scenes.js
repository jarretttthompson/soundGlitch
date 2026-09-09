// Named snapshots of the look, kept in localStorage, with JSON export/import.

const KEY = 'soundglitch.scenes';

export class Scenes {
  constructor() {
    this.list = this._load();
  }

  _load() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v.filter(s => s && s.name && s.params) : [];
    } catch (_) { return []; }
  }
  _save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.list)); } catch (_) {}
  }

  save(name, params) {
    name = String(name || '').trim().slice(0, 24) || `SCENE ${this.list.length + 1}`;
    const scene = { name, params: { ...params } };
    const i = this.list.findIndex(s => s.name.toLowerCase() === name.toLowerCase());
    if (i >= 0) this.list[i] = scene; else this.list.push(scene);
    this._save();
    return this.list.indexOf(scene);
  }

  get(i) { return this.list[i] || null; }
  byName(name) {
    const n = String(name).toLowerCase();
    return this.list.find(s => s.name.toLowerCase() === n) || null;
  }

  remove(i) {
    this.list.splice(i, 1);
    this._save();
  }

  move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= this.list.length) return;
    [this.list[i], this.list[j]] = [this.list[j], this.list[i]];
    this._save();
  }

  exportJSON() {
    return JSON.stringify({ soundGlitch: 1, scenes: this.list }, null, 2);
  }

  // Merges by name; returns how many scenes were added or replaced.
  importJSON(text) {
    const data = JSON.parse(text);
    const incoming = Array.isArray(data) ? data : data.scenes;
    if (!Array.isArray(incoming)) throw new Error('no scenes in file');
    let n = 0;
    for (const s of incoming) {
      if (!s || typeof s.name !== 'string' || typeof s.params !== 'object') continue;
      this.save(s.name, s.params);
      n++;
    }
    return n;
  }
}
