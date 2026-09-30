// External anchoring: copy a seal's head hash to a place the ledger's key holder does not control.
// The ledger alone cannot show that its whole history was not rewritten and resealed with the same
// key; a record held elsewhere can. A sink is `async ({ session, head_hash, seal }) => void`; the
// file sink appends one canonical JSON line per anchor (append-only by convention, and only as
// trustworthy as whoever can write to that file).
import fs from 'node:fs';
import { canon } from './canon.mjs';

export const anchorRecord = (session, seal) => ({ session, head_idx: seal.head_idx, head_hash: seal.head_hash, ts: seal.ts });

export function fileSink(file) {
  return async ({ session, head_hash, seal }) => {
    const line = canon(anchorRecord(session, { ...seal, head_hash })) + '\n';
    const fd = fs.openSync(file, 'a', 0o600);
    try { fs.writeSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
}

// Fail closed: a missing file or a line that is not a valid record is an error, never "no anchors".
export function readAnchors(file) {
  const out = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let r;
    try { r = JSON.parse(line); } catch { throw new Error(`${file}:${i + 1}: anchor line is not valid JSON`); }
    if (!Number.isInteger(r?.session) || !Number.isInteger(r?.head_idx) || !/^[0-9a-f]{64}$/.test(r?.head_hash ?? '')) throw new Error(`${file}:${i + 1}: not an anchor record`);
    out.push(r);
  });
  return out;
}
