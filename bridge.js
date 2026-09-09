#!/usr/bin/env node
// OSC -> WebSocket bridge for soundGlitch.
// Listens for OSC over UDP (default port 8413) and forwards every message as
// JSON to connected browsers (WebSocket, default port 8414). The app connects
// when OSC BRIDGE is switched on. Addresses are documented in README.md.
//
//   node bridge.js                # 8413 udp -> 8414 ws
//   node bridge.js 9000 9001      # custom ports

import dgram from 'node:dgram';
import { WebSocketServer } from 'ws';

const UDP_PORT = +(process.argv[2] || 8413);
const WS_PORT = +(process.argv[3] || 8414);

function pad4(n) { return (n + 3) & ~3; }
function readStr(buf, off) {
  let end = buf.indexOf(0, off);
  if (end < 0) end = buf.length;
  return [buf.toString('utf8', off, end), off + pad4(end - off + 1)];
}
// Minimal OSC 1.0 decoder: int32, float32, string, blob, T/F/N/I, bundles.
function decode(buf) {
  if (buf.length >= 8 && buf.toString('ascii', 0, 7) === '#bundle') {
    const msgs = [];
    let off = 16;
    while (off + 4 <= buf.length) {
      const len = buf.readInt32BE(off); off += 4;
      msgs.push(...decode(buf.subarray(off, off + len)));
      off += len;
    }
    return msgs;
  }
  let [address, off] = readStr(buf, 0);
  const args = [];
  if (off < buf.length && buf[off] === 0x2c) {
    let tags; [tags, off] = readStr(buf, off);
    for (const t of tags.slice(1)) {
      try {
        if (t === 'i') { args.push({ type: 'i', value: buf.readInt32BE(off) }); off += 4; }
        else if (t === 'f') { args.push({ type: 'f', value: buf.readFloatBE(off) }); off += 4; }
        else if (t === 'd') { args.push({ type: 'd', value: buf.readDoubleBE(off) }); off += 8; }
        else if (t === 's') { let s; [s, off] = readStr(buf, off); args.push({ type: 's', value: s }); }
        else if (t === 'b') { const l = buf.readInt32BE(off); off += 4; args.push({ type: 'b', value: buf.subarray(off, off + l).toString('base64') }); off += pad4(l); }
        else if (t === 'T') args.push({ type: 'T', value: 1 });
        else if (t === 'F') args.push({ type: 'F', value: 0 });
        else if (t === 'N') args.push({ type: 'N', value: null });
        else if (t === 'I') args.push({ type: 'I', value: Infinity });
        else break;
      } catch { break; }
    }
  }
  return [{ address, args }];
}

const wss = new WebSocketServer({ port: WS_PORT });
wss.on('connection', ws => {
  console.log(`browser connected (${wss.clients.size})`);
  ws.on('close', () => console.log(`browser left (${wss.clients.size})`));
});

const udp = dgram.createSocket('udp4');
udp.on('message', (buf, rinfo) => {
  let msgs;
  try { msgs = decode(buf); } catch (e) { console.log('bad packet from', rinfo.address); return; }
  for (const m of msgs) {
    const line = JSON.stringify(m);
    for (const c of wss.clients) if (c.readyState === 1) c.send(line);
    console.log(`${m.address} ${m.args.map(a => a.value).join(' ')}`);
  }
});
udp.bind(UDP_PORT, () => {
  console.log(`soundGlitch bridge: OSC udp :${UDP_PORT} -> ws :${WS_PORT}`);
});
