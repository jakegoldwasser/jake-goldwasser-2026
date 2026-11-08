// What luddite-backend/index.mjs expects from Node and Lambda (Buffer,
// fetch, URLSearchParams, setTimeout, process.env), made from the host's
// `__gas` object instead. esbuild injects these wherever index.mjs uses
// them as globals (build.mjs). `__gas` is defined in gas/host.js on Apps
// Script and in dev/fake-gas.mjs on this computer, so the same bundle runs
// in both.
//
// `Promise` here is the bundle's synchronous one (gas/sync-promise.js):
// Apps Script can't wait for a real Promise before answering a request.

/* global __gas */

// ---- bytes, base64, utf-8 ---------------------------------------------
// Pure JavaScript, so it behaves identically on Apps Script and in Node.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = (() => { const m = {}; for (let i = 0; i < 64; i++) m[B64[i]] = i; m['-'] = 62; m['_'] = 63; return m; })();

function utf8Encode(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function utf8Decode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i++];
    let c;
    if (b < 0x80) c = b;
    else if (b < 0xe0) c = ((b & 31) << 6) | (bytes[i++] & 63);
    else if (b < 0xf0) c = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else c = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    if (c > 0xffff) { c -= 0x10000; s += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 1023)); }
    else s += String.fromCharCode(c);
  }
  return s;
}

function b64Encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
  }
  return s;
}

function b64Decode(str) {
  const clean = String(str).replace(/[^A-Za-z0-9+/\-_]/g, '');
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64_INDEX[clean[i]], b = B64_INDEX[clean[i + 1]];
    const c = B64_INDEX[clean[i + 2]], d = B64_INDEX[clean[i + 3]];
    out.push(((a << 2) | (b >> 4)) & 255);
    if (c !== undefined) out.push((((b & 15) << 4) | (c >> 2)) & 255);
    if (d !== undefined) out.push((((c & 3) << 6) | d) & 255);
  }
  return out;
}

// Just enough of Node's Buffer for index.mjs: from(), byteLength(),
// .length and toString('utf8' | 'base64' | 'base64url' | 'hex').
export class Buffer extends Uint8Array {
  static from(value, encoding) {
    let bytes;
    if (typeof value === 'string') {
      if (encoding === 'base64' || encoding === 'base64url') bytes = b64Decode(value);
      else if (encoding === 'hex') bytes = (value.match(/../g) || []).map((h) => parseInt(h, 16));
      else bytes = utf8Encode(value);
    } else {
      bytes = Array.from(value || [], (n) => n & 255); // Apps Script hands out signed bytes
    }
    const buf = new Buffer(bytes.length);
    buf.set(bytes);
    return buf;
  }
  static byteLength(str) { return utf8Encode(String(str)).length; }
  static isBuffer(x) { return x instanceof Buffer; }
  toString(encoding) {
    if (encoding === 'base64') return b64Encode(this);
    if (encoding === 'base64url') return b64Encode(this).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (encoding === 'hex') return Array.from(this, (b) => (b < 16 ? '0' : '') + b.toString(16)).join('');
    return utf8Decode(this);
  }
}

// ---- URLSearchParams (only what index.mjs builds) -----------------------
export class URLSearchParams {
  constructor(init) { this.pairs = Object.entries(init || {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]); }
  toString() { return this.pairs.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&'); }
}

// ---- fetch -------------------------------------------------------------
// UrlFetchApp underneath (synchronous), wrapped to look like fetch.
export function fetch(url, init) {
  return new Promise((resolve) => {
    init = init || {};
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k] = v;
    let body = init.body;
    if (body instanceof URLSearchParams) {
      body = body.toString();
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const res = __gas.fetch(String(url), { method: (init.method || 'GET').toUpperCase(), headers, body: body === undefined ? undefined : String(body) });
    const text = res.text || '';
    resolve({
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      text: () => Promise.resolve(text),
      json: () => new Promise((ok) => ok(JSON.parse(text)))
    });
  });
}

// ---- timers and environment --------------------------------------------
// index.mjs only uses setTimeout to wait a moment before retrying a save.
export function setTimeout(fn, ms) { __gas.sleep(Math.max(0, Math.min(Number(ms) || 0, 2000))); Promise.resolve().then(fn); return 0; }

export const process = { env: __gas.env() };
