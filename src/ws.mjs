// Minimal RFC 6455 server side: enough for one text-message JSON protocol with a browser client.
// Handles masked client frames, 16/64-bit lengths, fragmentation, ping/pong and close.
import crypto from 'node:crypto';

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 64 * 1024 * 1024;

export function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len <= 0xffff) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

// Returns null until a whole frame is buffered, else { fin, opcode, payload, consumed }.
export function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  if (len > MAX_MESSAGE) throw new Error('websocket frame too large');
  let mask = null;
  if (masked) { if (buf.length < off + 4) return null; mask = buf.subarray(off, off + 4); off += 4; }
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
  return { fin, opcode, payload, consumed: off + len };
}

export function acceptWebSocket(req, socket, { onMessage, onClose }) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return null; }
  const accept = crypto.createHash('sha1').update(key + MAGIC).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0);
  let parts = [];
  let closed = false;
  const conn = {
    send(text) { if (!closed && !socket.destroyed) socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8'))); },
    close() { if (!closed) { closed = true; try { socket.end(encodeFrame(0x8, Buffer.alloc(0))); } catch { /* already gone */ } } },
  };
  const finish = () => { if (!closed) closed = true; onClose?.(); };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    try {
      for (;;) {
        const f = decodeFrame(buf);
        if (!f) break;
        buf = buf.subarray(f.consumed);
        if (f.opcode === 0x8) { conn.close(); return; }
        if (f.opcode === 0x9) { socket.write(encodeFrame(0xa, f.payload)); continue; }
        if (f.opcode === 0xa) continue;
        parts.push(f.payload);
        if (f.fin) { const text = Buffer.concat(parts).toString('utf8'); parts = []; onMessage(text); }
      }
    } catch { socket.destroy(); }
  });
  socket.on('close', finish);
  socket.on('error', () => {});
  return conn;
}
