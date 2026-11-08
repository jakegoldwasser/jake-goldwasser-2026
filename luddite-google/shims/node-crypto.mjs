// Stands in for 'node:crypto' (build.mjs points the import here): the four
// functions index.mjs uses, made from the host's `__gas` (gas/host.js).
/* global __gas */
import { Buffer } from './globals.mjs';

export function createHmac(alg, key) {
  if (alg !== 'sha256') throw new Error('only sha256');
  let data = '';
  return {
    update(d) { data += String(d); return this; },
    digest(encoding) { const buf = Buffer.from(__gas.hmacSha256(String(key), data)); return encoding ? buf.toString(encoding) : buf; }
  };
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) throw new RangeError('lengths differ');
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function randomBytes(n) { return Buffer.from(__gas.randomBytes(n)); }

export function randomUUID() { return __gas.uuid(); }
