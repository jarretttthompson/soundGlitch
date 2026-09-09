// Links between windows and to the outside world.
//
// BroadcastChannel: a controller page mirrors its params, audio features and
// source image to any output pages (opened with ?output) in the same browser.
// WebSocket: optional connection to bridge.js, which forwards OSC messages.

export class Link {
  constructor(role, handlers) {
    this.role = role; // controller | output
    this.h = handlers;
    this.outputs = 0;
    this.wsStatus = 'OSC OFF';
    this.ws = null;
    this.wsWanted = false;
    this._wsTimer = null;
    this.bc = 'BroadcastChannel' in window ? new BroadcastChannel('soundglitch') : null;
    if (this.bc) this.bc.onmessage = e => this._onMessage(e.data);
    if (role === 'output') this.send({ t: 'hello' });
  }

  _onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (this.role === 'output') {
      if (m.t === 'params' && this.h.onParams) this.h.onParams(m.p);
      else if (m.t === 'cmd' && this.h.onCmd) this.h.onCmd(m.name, m.args || []);
      else if (m.t === 'audio' && this.h.onAudio) this.h.onAudio(m);
      else if (m.t === 'source' && this.h.onSource) this.h.onSource(m);
      else if (m.t === 'bye') { /* controller closed; keep last state */ }
    } else if (m.t === 'hello') {
      this.outputs++;
      if (this.h.onOutputJoined) this.h.onOutputJoined();
    } else if (m.t === 'outputBye') {
      this.outputs = Math.max(0, this.outputs - 1);
      if (this.h.onStatus) this.h.onStatus();
    }
  }

  send(m) {
    if (this.bc) { try { this.bc.postMessage(m); } catch (_) {} }
  }

  sendParams(p) { if (this.outputs > 0) this.send({ t: 'params', p }); }
  sendCmd(name, args) { if (this.outputs > 0) this.send({ t: 'cmd', name, args }); }
  sendAudio(f) {
    if (this.outputs <= 0) return;
    this.send({ t: 'audio', ...f, tex: f.tex.slice() });
  }
  sendSource(dataUrl) { if (this.outputs > 0) this.send({ t: 'source', dataUrl }); }

  close() {
    this.send({ t: this.role === 'output' ? 'outputBye' : 'bye' });
  }

  // ---- OSC over WebSocket ------------------------------------------------

  setWs(on, url = 'ws://localhost:8414') {
    this.wsWanted = on;
    if (on) this._connect(url);
    else {
      clearTimeout(this._wsTimer);
      if (this.ws) { try { this.ws.close(); } catch (_) {} this.ws = null; }
      this.wsStatus = 'OSC OFF';
      if (this.h.onStatus) this.h.onStatus();
    }
  }

  _connect(url) {
    if (!this.wsWanted) return;
    clearTimeout(this._wsTimer);
    let ws;
    try { ws = new WebSocket(url); } catch (_) { this._retry(url); return; }
    this.ws = ws;
    this.wsStatus = 'OSC CONNECTING';
    if (this.h.onStatus) this.h.onStatus();
    ws.onopen = () => { this.wsStatus = 'OSC LINKED'; if (this.h.onStatus) this.h.onStatus(); };
    ws.onmessage = e => {
      try {
        const m = JSON.parse(e.data);
        if (m && m.address && this.h.onOsc) this.h.onOsc(m.address, m.args || []);
      } catch (_) {}
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (!this.wsWanted) return;
      this.wsStatus = 'OSC RETRYING';
      if (this.h.onStatus) this.h.onStatus();
      this._retry(url);
    };
  }

  _retry(url) {
    clearTimeout(this._wsTimer);
    this._wsTimer = setTimeout(() => this._connect(url), 4000);
  }
}
