// Code.js: Luddite's backend for Google Apps Script. Made by
// luddite-google/build.mjs from luddite-backend/index.mjs; don't edit it
// here, edit those and run `npm run build`. Built 2026-11-08.

// Luddite's backend on Google Apps Script: the web app's doPost, and the
// `__gas` object the bundled backend (luddite-backend/index.mjs) runs on.
// Everything Luddite stores goes in one Google Sheet in the account that
// deployed this script ("Luddite data"), made on the first request.
//
// The page talks to it as it talks to the Lambda, wrapped in one POST
// (text/plain, so the browser sends it without a CORS preflight, which
// Apps Script can't answer):
//   { m: 'GET' | 'PUT', p: '/luddite/...?query', a: token, o: origin, b: body }
// and gets back { s: status, b: body }, since Apps Script can't set an
// HTTP status. Apps Script also can't read request headers, which is why
// the token and the origin travel in the body.

var SHEET_PROP = 'LUDDITE_SHEET_ID';
// One cell holds up to 50,000 characters; a stored item is cut into parts
// of this many, laid along its row. 12 parts covers index.mjs's
// MAX_ITEM_BYTES (390,000) with room to spare.
var PART_CHARS = 45000;
var FIRST_PART_COL = 5; // A pk, B ver, C updatedAt, D parts, then the parts
// Every cell is written with this in front, so the Sheet always keeps it
// as text (a part could otherwise start with "=" or look like a number).
var TEXT_MARK = '~';
// Big items (writing, its log and versions, papers, PDFs) go on their own
// tab and are read one row at a time; everything else is small, and its
// whole tab is read once per request.
var BIG_KINDS = { draft: 1, olddraft: 1, snap: 1, wlog: 1, sub: 1, early: 1, rubricfile: 1, chat: 1, hmadminlog: 1 };

function doGet() {
  return ContentService.createTextOutput('Luddite (Google) is running.');
}

function doPost(e) {
  var reply;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    reply = ludditeRequest_(req);
  } catch (err) {
    console.error('luddite request failed', err && err.stack || err);
    reply = { statusCode: 500, body: JSON.stringify({ error: 'server_error' }) };
  }
  return ContentService.createTextOutput(JSON.stringify({ s: reply.statusCode, b: reply.body }))
    .setMimeType(ContentService.MimeType.JSON);
}

function ludditeRequest_(req) {
  var full = String(req.p || '/'), qi = full.indexOf('?');
  var query = {};
  if (qi >= 0) {
    full.slice(qi + 1).split('&').forEach(function (pair) {
      if (!pair) return;
      var eq = pair.indexOf('=');
      var k = decodeURIComponent((eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '));
      query[k] = eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    });
  }
  // Shaped like the Lambda Function URL event index.mjs reads.
  var event = {
    requestContext: { http: { method: String(req.m || 'GET').toUpperCase() } },
    rawPath: qi < 0 ? full : full.slice(0, qi),
    queryStringParameters: qi < 0 ? undefined : query,
    headers: { authorization: req.a ? 'Bearer ' + req.a : '', origin: String(req.o || '') },
    body: typeof req.b === 'string' ? req.b : (req.b ? JSON.stringify(req.b) : ''),
    isBase64Encoded: false
  };
  return luddite_().run(event);
}

// ---- the host the bundle runs on ---------------------------------------
var __gas = {
  env: function () { return PropertiesService.getScriptProperties().getProperties(); },
  sleep: function (ms) { if (ms > 0) Utilities.sleep(ms); },
  uuid: function () { return Utilities.getUuid(); },
  // UUIDs come from Java's SecureRandom; 30 of their 32 hex digits are random.
  randomBytes: function (n) {
    var hex = '';
    while (hex.length < n * 2) { var u = Utilities.getUuid().replace(/-/g, ''); hex += u.slice(0, 12) + u.slice(13, 16) + u.slice(17); }
    var out = [];
    for (var i = 0; i < n; i++) out.push(parseInt(hex.substr(i * 2, 2), 16));
    return out;
  },
  hmacSha256: function (key, data) {
    return Utilities.computeHmacSha256Signature(data, key, Utilities.Charset.UTF_8).map(function (b) { return b & 255; });
  },
  fetch: function (url, opts) {
    var params = { method: opts.method.toLowerCase(), muteHttpExceptions: true, followRedirects: true, headers: {} };
    Object.keys(opts.headers || {}).forEach(function (k) {
      if (k.toLowerCase() === 'content-type') params.contentType = opts.headers[k];
      else params.headers[k] = opts.headers[k];
    });
    if (opts.body !== undefined) params.payload = opts.body;
    var res = UrlFetchApp.fetch(url, params);
    return { status: res.getResponseCode(), text: res.getContentText() };
  },
  getItem: function (pk) { return store_().get(pk); },
  putItem: function (pk, state, ver, updatedAt, expectVer) { return store_().put(pk, state, ver, updatedAt, expectVer); },
  scan: function (prefixes) { return store_().scan(prefixes); }
};

// ---- the Sheet ---------------------------------------------------------
var store__ = null;
function store_() { return store__ || (store__ = makeStore_()); }

function makeStore_() {
  var book = openBook_();
  var tabs = { small: tab_(book, 'small'), big: tab_(book, 'big') };
  // This request's view of each tab: pk -> { row, ver, parts, state? }.
  var known = { small: null, big: null };

  function tabOf(pk) { var m = /^luddite:([a-z]+)/.exec(pk); return m && BIG_KINDS[m[1]] ? 'big' : 'small'; }
  function unmark(v) { v = String(v == null ? '' : v); return v.charAt(0) === TEXT_MARK ? v.slice(1) : v; }
  function width(sheet) { return Math.max(FIRST_PART_COL, sheet.getLastColumn()); }

  function index(name, withState) {
    var sheet = tabs[name], last = sheet.getLastRow(), map = {};
    if (last >= 2) {
      var cols = withState ? width(sheet) : 4;
      var rows = sheet.getRange(2, 1, last - 1, cols).getValues();
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i], pk = unmark(r[0]);
        if (!pk) continue;
        var entry = { row: i + 2, ver: Number(unmark(r[1])) || 0, parts: Number(unmark(r[3])) || 0 };
        if (withState) entry.state = joinParts(r, entry.parts);
        map[pk] = entry;
      }
    }
    return map;
  }
  function joinParts(row, parts) {
    var s = '';
    for (var p = 0; p < parts; p++) s += unmark(row[FIRST_PART_COL - 1 + p]);
    return s;
  }
  function view(name) { return known[name] || (known[name] = index(name, name === 'small')); }
  function readRow(name, row) {
    var sheet = tabs[name];
    var r = sheet.getRange(row, 1, 1, width(sheet)).getValues()[0];
    var parts = Number(unmark(r[3])) || 0;
    return { pk: unmark(r[0]), ver: Number(unmark(r[1])) || 0, parts: parts, state: joinParts(r, parts) };
  }

  function get(pk) {
    var name = tabOf(pk), entry = view(name)[pk];
    if (!entry) return null;
    if (entry.state === undefined) {
      var fresh = readRow(name, entry.row);
      entry.ver = fresh.ver; entry.parts = fresh.parts; entry.state = fresh.state;
    }
    return { pk: pk, state: entry.state, ver: entry.ver };
  }

  // Saves only if the item is still at expectVer (0: doesn't exist yet),
  // like DynamoDB's conditional put. One lock for the whole script keeps
  // two requests from saving in between each other's check and write.
  function put(pk, state, ver, updatedAt, expectVer) {
    var name = tabOf(pk), sheet = tabs[name];
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) throw new Error('busy');
    try {
      // Fresh, not this request's view: another request may have saved.
      var col = sheet.getLastRow() >= 2 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues() : [];
      var row = 0, curVer = 0;
      for (var i = 0; i < col.length; i++) if (unmark(col[i][0]) === pk) { row = i + 2; curVer = Number(unmark(col[i][1])) || 0; break; }
      if (curVer !== expectVer) {
        // Someone else saved first: forget what this request knew, so
        // index.mjs's retry reads the item afresh.
        var v = view(name);
        if (row) v[pk] = { row: row, ver: curVer, parts: 0, state: undefined }; else delete v[pk];
        return false;
      }
      var parts = [];
      for (var at = 0; at < state.length; at += PART_CHARS) parts.push(state.slice(at, at + PART_CHARS));
      if (!parts.length) parts.push('');
      var oldWidth = width(sheet);
      var need = FIRST_PART_COL - 1 + parts.length;
      if (sheet.getMaxColumns() < need) sheet.insertColumnsAfter(sheet.getMaxColumns(), need - sheet.getMaxColumns());
      var cells = [pk, String(ver), String(updatedAt), String(parts.length)].concat(parts);
      while (cells.length < Math.max(need, oldWidth)) cells.push(''); // clear parts left from a longer save
      cells = cells.map(function (c, j) { return j < need ? TEXT_MARK + c : ''; });
      if (!row) row = sheet.getLastRow() + 1;
      if (sheet.getMaxRows() < row) sheet.insertRowsAfter(sheet.getMaxRows(), Math.max(50, row - sheet.getMaxRows()));
      sheet.getRange(row, 1, 1, cells.length).setValues([cells]);
      SpreadsheetApp.flush();
      view(name)[pk] = { row: row, ver: ver, parts: parts.length, state: state };
      return true;
    } finally {
      lock.releaseLock();
    }
  }

  // Every item whose key starts with one of the prefixes (only Luddite HM's
  // administrator overview asks for this).
  function scan(prefixes) {
    var out = [];
    ['small', 'big'].forEach(function (name) {
      var all = index(name, true);
      Object.keys(all).forEach(function (pk) {
        if (prefixes.some(function (p) { return pk.indexOf(p) === 0; })) out.push({ pk: pk, state: all[pk].state });
      });
    });
    return out;
  }

  return { get: get, put: put, scan: scan };
}

function openBook_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(SHEET_PROP);
  if (id) return SpreadsheetApp.openById(id);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    id = props.getProperty(SHEET_PROP);
    if (id) return SpreadsheetApp.openById(id);
    var book = SpreadsheetApp.create('Luddite data');
    props.setProperty(SHEET_PROP, book.getId());
    return book;
  } finally {
    lock.releaseLock();
  }
}

function tab_(book, name) {
  var sheet = book.getSheetByName(name);
  if (sheet) return sheet;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    sheet = book.getSheetByName(name);
    if (sheet) return sheet;
    var first = book.getSheets()[0];
    // A new spreadsheet's empty "Sheet1" becomes the first tab.
    if (first && first.getName() !== 'small' && first.getName() !== 'big' && first.getLastRow() === 0) sheet = first.setName(name);
    else sheet = book.insertSheet(name);
    sheet.getRange(1, 1, 1, 4).setValues([['pk', 'ver', 'updatedAt', 'parts']]);
    sheet.setFrozenRows(1);
    return sheet;
  } finally {
    lock.releaseLock();
  }
}

// A Promise that settles without an event loop.
//
// Apps Script answers a web request with whatever doPost() returns, at
// once; it never waits for a real Promise. Every Apps Script service is
// synchronous anyway, so luddite-backend/index.mjs's async code never has
// anything to wait for. build.mjs compiles its async/await into generators
// (esbuild's target es2016) and wraps the bundle with `var Promise =
// SyncPromise`, so every `await`, `.then` and `Promise.all` in it lands
// here. Callbacks go on a queue that `drain()` empties in a loop (like the
// microtask queue), rather than running nested, so a loop of a thousand
// awaits doesn't grow the stack.
var SyncPromise = (function () {
  var queue = [], head = 0;
  function later(fn) { queue.push(fn); }
  function drain() {
    while (head < queue.length) { var fn = queue[head]; queue[head++] = null; fn(); }
    queue = []; head = 0;
  }

  function P(executor) {
    this._s = 0; // 0 pending, 1 fulfilled, 2 rejected
    this._v = undefined;
    this._cbs = [];
    var self = this, done = false;
    try {
      executor(function (v) { if (!done) { done = true; adopt(self, v); } },
               function (e) { if (!done) { done = true; settle(self, 2, e); } });
    } catch (e) { if (!done) { done = true; settle(self, 2, e); } }
  }

  function settle(p, s, v) {
    if (p._s) return;
    p._s = s; p._v = v;
    var cbs = p._cbs; p._cbs = null;
    for (var i = 0; i < cbs.length; i++) later(cbs[i]);
  }

  function adopt(p, v) {
    if (v === p) return settle(p, 2, new TypeError('A promise cannot resolve to itself'));
    if (v && (typeof v === 'object' || typeof v === 'function')) {
      var then;
      try { then = v.then; } catch (e) { return settle(p, 2, e); }
      if (typeof then === 'function') {
        var called = false;
        later(function () {
          try {
            then.call(v, function (x) { if (!called) { called = true; adopt(p, x); } },
                         function (e) { if (!called) { called = true; settle(p, 2, e); } });
          } catch (e) { if (!called) { called = true; settle(p, 2, e); } }
        });
        return;
      }
    }
    settle(p, 1, v);
  }

  P.prototype.then = function (onOk, onErr) {
    var self = this;
    return new P(function (resolve, reject) {
      function run() {
        var cb = self._s === 1 ? onOk : onErr;
        if (typeof cb !== 'function') { (self._s === 1 ? resolve : reject)(self._v); return; }
        var out;
        try { out = cb(self._v); } catch (e) { reject(e); return; }
        resolve(out);
      }
      if (self._s) later(run); else self._cbs.push(run);
    });
  };
  P.prototype['catch'] = function (onErr) { return this.then(undefined, onErr); };
  P.prototype['finally'] = function (fn) {
    return this.then(function (v) { return P.resolve(fn()).then(function () { return v; }); },
                     function (e) { return P.resolve(fn()).then(function () { throw e; }); });
  };

  P.resolve = function (v) { return v instanceof P ? v : new P(function (r) { r(v); }); };
  P.reject = function (e) { return new P(function (_, r) { r(e); }); };
  P.all = function (list) {
    return new P(function (resolve, reject) {
      var items = Array.from(list), out = new Array(items.length), left = items.length;
      if (!left) { resolve(out); return; }
      items.forEach(function (x, i) {
        P.resolve(x).then(function (v) { out[i] = v; if (--left === 0) resolve(out); }, reject);
      });
    });
  };
  P.allSettled = function (list) {
    return P.all(Array.from(list).map(function (x) {
      return P.resolve(x).then(function (value) { return { status: 'fulfilled', value: value }; },
                               function (reason) { return { status: 'rejected', reason: reason }; });
    }));
  };
  P.race = function (list) {
    return new P(function (resolve, reject) { Array.from(list).forEach(function (x) { P.resolve(x).then(resolve, reject); }); });
  };

  // Runs drain() and hands back what the promise came to, or throws.
  P.settle = function (p) {
    drain();
    if (!(p instanceof P)) return p;
    if (p._s === 1) return p._v;
    if (p._s === 2) throw p._v;
    throw new Error('A request was still waiting on something when it finished');
  };
  return P;
})();

// The backend itself, made once per request the first time it's needed.
var luddite__ = null;
function luddite_() {
  if (luddite__) return luddite__;
  // Shadows the real Promise for everything in the bundle (see sync-promise.js).
  var Promise = SyncPromise;
var __luddite = (() => {
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
  var __objRest = (source, exclude) => {
    var target = {};
    for (var prop in source)
      if (__hasOwnProp.call(source, prop) && exclude.indexOf(prop) < 0)
        target[prop] = source[prop];
    if (source != null && __getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(source)) {
        if (exclude.indexOf(prop) < 0 && __propIsEnum.call(source, prop))
          target[prop] = source[prop];
      }
    return target;
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __async = (__this, __arguments, generator) => {
    return new Promise((resolve, reject) => {
      var fulfilled = (value) => {
        try {
          step(generator.next(value));
        } catch (e) {
          reject(e);
        }
      };
      var rejected = (value) => {
        try {
          step(generator.throw(value));
        } catch (e) {
          reject(e);
        }
      };
      var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
      step((generator = generator.apply(__this, __arguments)).next());
    });
  };

  // gas/entry.mjs
  var entry_exports = {};
  __export(entry_exports, {
    handler: () => handler
  });

  // shims/globals.mjs
  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var B64_INDEX = (() => {
    const m = {};
    for (let i = 0; i < 64; i++) m[B64[i]] = i;
    m["-"] = 62;
    m["_"] = 63;
    return m;
  })();
  function utf8Encode(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c >= 55296 && c <= 56319 && i + 1 < str.length) {
        const d = str.charCodeAt(i + 1);
        if (d >= 56320 && d <= 57343) {
          c = 65536 + (c - 55296 << 10) + (d - 56320);
          i++;
        }
      }
      if (c < 128) out.push(c);
      else if (c < 2048) out.push(192 | c >> 6, 128 | c & 63);
      else if (c < 65536) out.push(224 | c >> 12, 128 | c >> 6 & 63, 128 | c & 63);
      else out.push(240 | c >> 18, 128 | c >> 12 & 63, 128 | c >> 6 & 63, 128 | c & 63);
    }
    return out;
  }
  function utf8Decode(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; ) {
      const b = bytes[i++];
      let c;
      if (b < 128) c = b;
      else if (b < 224) c = (b & 31) << 6 | bytes[i++] & 63;
      else if (b < 240) c = (b & 15) << 12 | (bytes[i++] & 63) << 6 | bytes[i++] & 63;
      else c = (b & 7) << 18 | (bytes[i++] & 63) << 12 | (bytes[i++] & 63) << 6 | bytes[i++] & 63;
      if (c > 65535) {
        c -= 65536;
        s += String.fromCharCode(55296 + (c >> 10), 56320 + (c & 1023));
      } else s += String.fromCharCode(c);
    }
    return s;
  }
  function b64Encode(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const n = bytes[i] << 16 | (bytes[i + 1] || 0) << 8 | (bytes[i + 2] || 0);
      s += B64[n >> 18 & 63] + B64[n >> 12 & 63] + (i + 1 < bytes.length ? B64[n >> 6 & 63] : "=") + (i + 2 < bytes.length ? B64[n & 63] : "=");
    }
    return s;
  }
  function b64Decode(str) {
    const clean = String(str).replace(/[^A-Za-z0-9+/\-_]/g, "");
    const out = [];
    for (let i = 0; i < clean.length; i += 4) {
      const a = B64_INDEX[clean[i]], b = B64_INDEX[clean[i + 1]];
      const c = B64_INDEX[clean[i + 2]], d = B64_INDEX[clean[i + 3]];
      out.push((a << 2 | b >> 4) & 255);
      if (c !== void 0) out.push(((b & 15) << 4 | c >> 2) & 255);
      if (d !== void 0) out.push(((c & 3) << 6 | d) & 255);
    }
    return out;
  }
  var Buffer2 = class _Buffer extends Uint8Array {
    static from(value, encoding) {
      let bytes;
      if (typeof value === "string") {
        if (encoding === "base64" || encoding === "base64url") bytes = b64Decode(value);
        else if (encoding === "hex") bytes = (value.match(/../g) || []).map((h) => parseInt(h, 16));
        else bytes = utf8Encode(value);
      } else {
        bytes = Array.from(value || [], (n) => n & 255);
      }
      const buf = new _Buffer(bytes.length);
      buf.set(bytes);
      return buf;
    }
    static byteLength(str) {
      return utf8Encode(String(str)).length;
    }
    static isBuffer(x) {
      return x instanceof _Buffer;
    }
    toString(encoding) {
      if (encoding === "base64") return b64Encode(this);
      if (encoding === "base64url") return b64Encode(this).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      if (encoding === "hex") return Array.from(this, (b) => (b < 16 ? "0" : "") + b.toString(16)).join("");
      return utf8Decode(this);
    }
  };
  var URLSearchParams = class {
    constructor(init) {
      this.pairs = Object.entries(init || {}).filter(([, v]) => v !== void 0).map(([k, v]) => [k, String(v)]);
    }
    toString() {
      return this.pairs.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
    }
  };
  function fetch(url, init) {
    return new Promise((resolve) => {
      init = init || {};
      const headers = {};
      for (const [k, v] of Object.entries(init.headers || {})) headers[k] = v;
      let body = init.body;
      if (body instanceof URLSearchParams) {
        body = body.toString();
        if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = "application/x-www-form-urlencoded";
      }
      const res = __gas.fetch(String(url), { method: (init.method || "GET").toUpperCase(), headers, body: body === void 0 ? void 0 : String(body) });
      const text = res.text || "";
      resolve({
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        text: () => Promise.resolve(text),
        json: () => new Promise((ok) => ok(JSON.parse(text)))
      });
    });
  }
  function setTimeout(fn, ms) {
    __gas.sleep(Math.max(0, Math.min(Number(ms) || 0, 2e3)));
    Promise.resolve().then(fn);
    return 0;
  }
  var process = { env: __gas.env() };

  // shims/aws-dynamodb.mjs
  var Command = class {
    constructor(input) {
      this.input = input;
    }
  };
  var GetItemCommand = class extends Command {
  };
  var PutItemCommand = class extends Command {
  };
  var ScanCommand = class extends Command {
  };
  function conditionFailed() {
    const e = new Error("The conditional request failed");
    e.name = "ConditionalCheckFailedException";
    return e;
  }
  var DynamoDBClient = class {
    send(cmd) {
      return new Promise((resolve) => {
        const input = cmd.input;
        if (cmd instanceof GetItemCommand) {
          const row = __gas.getItem(input.Key.pk.S);
          resolve(row ? { Item: { pk: { S: row.pk }, state: { S: row.state }, ver: { N: String(row.ver) } } } : {});
        } else if (cmd instanceof PutItemCommand) {
          const it = input.Item;
          const expect = input.ConditionExpression === "ver = :ver" ? Number(input.ExpressionAttributeValues[":ver"].N) : 0;
          const ok = __gas.putItem(it.pk.S, it.state.S, Number(it.ver.N), Number(it.updatedAt.N), expect);
          if (!ok) throw conditionFailed();
          resolve({});
        } else if (cmd instanceof ScanCommand) {
          const prefixes = Object.values(input.ExpressionAttributeValues || {}).map((v) => v.S);
          const rows = __gas.scan(prefixes);
          resolve({ Items: rows.map((r) => ({ pk: { S: r.pk }, state: { S: r.state } })) });
        } else {
          throw new Error("unsupported command");
        }
      });
    }
  };

  // shims/node-crypto.mjs
  function createHmac(alg, key) {
    if (alg !== "sha256") throw new Error("only sha256");
    let data = "";
    return {
      update(d) {
        data += String(d);
        return this;
      },
      digest(encoding) {
        const buf = Buffer2.from(__gas.hmacSha256(String(key), data));
        return encoding ? buf.toString(encoding) : buf;
      }
    };
  }
  function timingSafeEqual(a, b) {
    if (a.length !== b.length) throw new RangeError("lengths differ");
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }
  function randomBytes(n) {
    return Buffer2.from(__gas.randomBytes(n));
  }
  function randomUUID() {
    return __gas.uuid();
  }

  // ../luddite-backend/index.mjs
  var TABLE_NAME = process.env.TABLE_NAME || "LudditeData";
  var LUDDITE_CLIENT_ID = process.env.LUDDITE_GOOGLE_CLIENT_ID || "522963753495-m1qigb1q8ct9rmmrh56fkv7r3hs2psap.apps.googleusercontent.com";
  var SESSION_SECRET = process.env.SESSION_SECRET || "";
  var SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
  var ddb = new DynamoDBClient({});
  function respond(statusCode, bodyObj) {
    return {
      statusCode,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyObj)
    };
  }
  function verifyGoogleToken(idToken) {
    return __async(this, null, function* () {
      const res = yield fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken));
      if (!res.ok) return null;
      const info = yield res.json();
      if (!info.sub || info.aud !== LUDDITE_CLIENT_ID) return null;
      return info;
    });
  }
  function loadSessionSecret() {
    return __async(this, null, function* () {
      if (SESSION_SECRET) return;
      const { state } = yield readItem("luddite:config");
      if (state && state.sessionSecret) {
        SESSION_SECRET = state.sessionSecret;
        return;
      }
      const made = yield mutate("luddite:config", (c) => c && c.sessionSecret ? void 0 : __spreadProps(__spreadValues({}, c || {}), { sessionSecret: randomBytes(48).toString("base64url") }));
      SESSION_SECRET = made.sessionSecret;
    });
  }
  function b64url(buf) {
    return Buffer2.from(buf).toString("base64url");
  }
  function sign(data) {
    return createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");
  }
  function issueSession(info) {
    if (!SESSION_SECRET) return null;
    const now = Math.floor(Date.now() / 1e3);
    const payload = b64url(JSON.stringify({
      sub: info.sub,
      email: info.email || "",
      name: info.name || "",
      iat: now,
      exp: now + SESSION_TTL_SECONDS
    }));
    return "s1." + payload + "." + sign("s1." + payload);
  }
  function verifySession(token) {
    if (!SESSION_SECRET) return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "s1") return null;
    const expected = Buffer2.from(sign(parts[0] + "." + parts[1]));
    const actual = Buffer2.from(parts[2]);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer2.from(parts[1], "base64url").toString("utf8"));
    } catch (e) {
      return null;
    }
    if (!payload.sub || !payload.exp || payload.exp * 1e3 < Date.now()) return null;
    return payload;
  }
  var OWNER_EMAILS = ["jake_goldwasser@horacemann.org", "jake.goldwasser@gmail.com"];
  var TEST_EMAILS = [...OWNER_EMAILS, "nymets892@gmail.com"];
  var TESTING_CENTER_EMAILS = ["testingcenterud@horacemann.org"];
  var MAX_PROCTORS = 20;
  var PROCTORING_INDEX_MAX = 400;
  var LUDDITE_CLIENT_SECRET = process.env.LUDDITE_GOOGLE_CLIENT_SECRET || "";
  var MAX_SUBMISSION_CHARS = 4e5;
  var MAX_STORED_CHARS = 25e4;
  var MAX_CHAT_CHARS = 1e3;
  var MAX_CHAT_MSGS = 300;
  var MAX_PAPER_CHAT_CHARS = 4e4;
  var GRADE_AFTER_MS = 5 * 60 * 1e3;
  var VIEW_PING_MAX_MS = 45 * 1e3;
  var MAX_MARKS = 600;
  var MAX_MARK_CHARS = 6e4;
  var MAX_ITEM_BYTES = 39e4;
  var MAX_CLASS_EMAILS = 400;
  var MAX_CLASS_ASSIGNMENTS = 30;
  var MINE_ASSIGNMENTS_PER_CLASS = 8;
  var REF_MINUTES = 45;
  var MAX_SITTINGS = 10;
  var MAX_OPEN_MS = 12 * 60 * 60 * 1e3;
  var MAX_PROMPT_CHARS = 4e3;
  var MAX_REFLECTION_CHARS = 2e4;
  var DEFAULT_PREFS = { spellcheck: "underline", lockOnLeave: true, blockPaste: true, showCount: true, autoHandIn: true, trog: false };
  function cleanPrefs(p) {
    const x = p && typeof p === "object" ? p : {};
    const out = __spreadValues({}, DEFAULT_PREFS);
    if (x.spellcheck === "off" || x.spellcheck === "underline") out.spellcheck = x.spellcheck;
    ["lockOnLeave", "blockPaste", "showCount", "autoHandIn", "trog"].forEach((k) => {
      if (typeof x[k] === "boolean") out[k] = x[k];
    });
    return out;
  }
  function cleanExtraTime(x) {
    const out = {};
    if (!x || typeof x !== "object") return out;
    Object.keys(x).slice(0, 2e3).forEach((em) => {
      const m = Math.round(Number(x[em]) * 4) / 4;
      if (EMAIL_RE.test(em) && m > 1 && m <= 4) out[lower(em)] = m;
    });
    return out;
  }
  var SCHED_PERIOD_MS = 45 * 6e4;
  var SCHED_MAX_DAYS = 60;
  function cleanSchedReq(body) {
    const kind = body.kind === "makeup" ? "makeup" : "extra";
    const pick = body.pick === "half" ? "half" : "whole";
    const from = Math.floor(Number(body.from)), to = Math.floor(Number(body.to));
    if (!(from > 0 && to > from && to - from <= SCHED_MAX_DAYS * 864e5)) throw new HttpError(400, "bad_dates");
    return { kind, pick, from, to, at: Date.now() };
  }
  function schedBlocks(room, req, start, end) {
    const slot = { start, end };
    if (req.kind !== "extra" || !room.startAt || room.sittings) return [slot];
    const cls = { start: room.startAt, end: room.startAt + (room.minutes || REF_MINUTES) * 6e4 };
    return cls.end <= start || end <= cls.start ? [cls, slot].sort((a, b) => a.start - b.start) : [slot];
  }
  function prefsOf(teacherSub) {
    return __async(this, null, function* () {
      const { state } = yield readItem("luddite:teacher:" + teacherSub);
      return cleanPrefs(state && state.prefs);
    });
  }
  var UPCOMING_HORIZON_MS = 48 * 60 * 60 * 1e3;
  var LATE_GRACE_MS = 2 * 60 * 1e3;
  var OWN_GRACE_MS = 5 * 60 * 1e3;
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var OWNER_DISPLAY_NAME = "Mr. Goldwasser";
  var CODE_ADJECTIVES = [
    "Blue",
    "Green",
    "Red",
    "Golden",
    "Silver",
    "Copper",
    "Coral",
    "Olive",
    "Violet",
    "Scarlet",
    "Amber",
    "Ruby",
    "Orange",
    "Purple",
    "Pink",
    "Calm",
    "Quiet",
    "Bright",
    "Brave",
    "Swift",
    "Gentle",
    "Merry",
    "Sunny",
    "Misty",
    "Snowy",
    "Breezy",
    "Sandy",
    "Mossy",
    "Frosty",
    "Tiny",
    "Giant",
    "Lucky",
    "Jolly",
    "Clever",
    "Noble",
    "Wise",
    "Bold",
    "Early",
    "Sleepy",
    "Humble",
    "Patient",
    "Hidden",
    "Wooden",
    "Paper",
    "Velvet",
    "Cotton",
    "Maple",
    "Cedar",
    "Autumn",
    "Spring",
    "Winter",
    "Summer",
    "Polar",
    "Starry",
    "Rainy",
    "Cloudy",
    "Stormy",
    "Windy",
    "Foggy",
    "Icy",
    "Kind",
    "Friendly",
    "Honest",
    "Loyal",
    "Happy",
    "Cheerful",
    "Playful",
    "Nimble",
    "Steady",
    "Silent",
    "Shiny",
    "Round",
    "Tall",
    "Little",
    "Mighty",
    "Speedy",
    "Fluffy",
    "Crisp",
    "Fresh",
    "Northern",
    "Southern",
    "Eastern",
    "Western",
    "Mountain",
    "Ocean",
    "Desert",
    "Evening",
    "Morning",
    "Midnight",
    "Lunar",
    "Solar",
    "Cosmic",
    "Magic",
    "Royal",
    "Brass",
    "Marble",
    "Crystal",
    "Glass",
    "Stone",
    "Iron"
  ];
  var CODE_NOUNS = [
    "trout",
    "otter",
    "heron",
    "robin",
    "finch",
    "badger",
    "rabbit",
    "owl",
    "fox",
    "wren",
    "moose",
    "seal",
    "whale",
    "crane",
    "swan",
    "lark",
    "newt",
    "frog",
    "goose",
    "llama",
    "panda",
    "koala",
    "tiger",
    "zebra",
    "camel",
    "bison",
    "falcon",
    "hawk",
    "raven",
    "dove",
    "puffin",
    "walrus",
    "beetle",
    "cricket",
    "acorn",
    "pebble",
    "meadow",
    "river",
    "canyon",
    "lantern",
    "kettle",
    "pencil",
    "compass",
    "anchor",
    "button",
    "ribbon",
    "candle",
    "comet",
    "planet",
    "island",
    "garden",
    "willow",
    "clover",
    "tulip",
    "daisy",
    "fern",
    "cactus",
    "pine",
    "teapot",
    "penguin",
    "dolphin",
    "turtle",
    "salmon",
    "parrot",
    "pelican",
    "sparrow",
    "deer",
    "elk",
    "lion",
    "bear",
    "wolf",
    "lamb",
    "kitten",
    "puppy",
    "pony",
    "goat",
    "mouse",
    "hedgehog",
    "gecko",
    "octopus",
    "starfish",
    "oyster",
    "lobster",
    "valley",
    "volcano",
    "cloud",
    "rainbow",
    "oak",
    "birch",
    "mitten",
    "scarf",
    "umbrella",
    "bicycle",
    "violin",
    "piano",
    "trumpet",
    "drum",
    "kite",
    "rocket",
    "crayon",
    "notebook",
    "basket",
    "teacup",
    "ladder",
    "lighthouse",
    "windmill",
    "castle",
    "bridge",
    "tower"
  ];
  var HttpError = class extends Error {
    constructor(status, code) {
      super(code);
      this.status = status;
    }
  };
  function readJsonBody(event) {
    try {
      const raw = event.isBase64Encoded ? Buffer2.from(event.body || "", "base64").toString("utf8") : event.body || "";
      return JSON.parse(raw || "{}");
    } catch (e) {
      return null;
    }
  }
  function readItem(key) {
    return __async(this, null, function* () {
      var _a;
      const result = yield ddb.send(new GetItemCommand({ TableName: TABLE_NAME, Key: { pk: { S: key } } }));
      if (!result.Item) return { state: null, ver: 0 };
      return { state: JSON.parse(result.Item.state.S), ver: Number(((_a = result.Item.ver) == null ? void 0 : _a.N) || 0) };
    });
  }
  function mutate(key, fn) {
    return __async(this, null, function* () {
      for (let attempt = 0; attempt < 10; attempt++) {
        const { state, ver } = yield readItem(key);
        const next = fn(state);
        if (next === void 0) return state;
        const put = {
          TableName: TABLE_NAME,
          Item: {
            pk: { S: key },
            state: { S: JSON.stringify(next) },
            ver: { N: String(ver + 1) },
            updatedAt: { N: String(Date.now()) }
          },
          ConditionExpression: "attribute_not_exists(pk)"
        };
        if (ver) {
          put.ConditionExpression = "ver = :ver";
          put.ExpressionAttributeValues = { ":ver": { N: String(ver) } };
        }
        try {
          yield ddb.send(new PutItemCommand(put));
          return next;
        } catch (e) {
          if (e.name !== "ConditionalCheckFailedException") throw e;
          yield new Promise((r) => setTimeout(r, 20 + Math.random() * 80 * (attempt + 1)));
        }
      }
      throw new HttpError(503, "busy");
    });
  }
  var lower = (s) => String(s || "").trim().toLowerCase();
  function roleOf(info) {
    return __async(this, null, function* () {
      const email = lower(info.email);
      if (OWNER_EMAILS.includes(email)) return "owner";
      const { state } = yield readItem("luddite:teachers");
      return state && state.emails && state.emails[email] ? "teacher" : "student";
    });
  }
  var pickOne = (list) => list[Math.floor(Math.random() * list.length)];
  function newRoomCode() {
    const codeLabel = pickOne(CODE_ADJECTIVES) + " " + pickOne(CODE_NOUNS);
    return { code: codeLabel.toLowerCase().replace(/[^a-z]/g, ""), codeLabel };
  }
  function cleanCode(code) {
    const raw = String(code || "");
    const old = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (old.length === 5) return old;
    const c = raw.toLowerCase().replace(/[^a-z]/g, "");
    if (c.length < 6 || c.length > 40) throw new HttpError(404, "no_room");
    return c;
  }
  function displayNameOf(info, role) {
    return __async(this, null, function* () {
      const { state } = yield readItem("luddite:teacher:" + info.sub);
      if (state && state.displayName) return state.displayName;
      return role === "owner" ? OWNER_DISPLAY_NAME : info.name || info.email || "";
    });
  }
  function getRoom(code) {
    return __async(this, null, function* () {
      const { state } = yield readItem("luddite:room:" + code);
      if (!state) throw new HttpError(404, "no_room");
      return state;
    });
  }
  function ownerMayOpen(role, teacherEmail) {
    return role === "owner" && !isHm(teacherEmail);
  }
  function ownsRoom(room, info, role) {
    return room.teacher.sub === info.sub || ownerMayOpen(role, room.teacher.email);
  }
  var regularEnded = (r) => !!r.endedAt || r.open === false;
  function regularWindow(r) {
    const start = r.startAt || r.createdAt;
    if (r.atHome) return { start, end: null, home: true };
    if (r.sittings) return { start: r.sittings[0].start, end: r.sittings[r.sittings.length - 1].end };
    return { start, end: r.minutes ? start + r.minutes * 6e4 : null };
  }
  function pausedFor(x, now) {
    return x ? (x.pausedMs || 0) + (x.pausedAt ? Math.max(0, now - x.pausedAt) : 0) : 0;
  }
  function sittingsWindow(room, email, entry, now) {
    const o = room.own && room.own[email];
    const multiplier = o && o.multiplier || 1;
    const list = room.sittings.map((x) => ({ start: x.start, end: x.start + Math.round((x.end - x.start) * multiplier) }));
    return __spreadProps(__spreadValues({}, partsWindow(list, room, entry, now)), { own: !!o, multiplier, ended: o ? false : regularEnded(room) });
  }
  function partsWindow(list, room, entry, now) {
    const at = list.findIndex((x) => now >= x.start && now < x.end);
    const next = list.findIndex((x) => x.start > now);
    const between = at === -1 && next > 0;
    return {
      start: list[0].start,
      end: list[list.length - 1].end,
      paused: !!(room.pausedAt || entry && entry.pausedAt || between),
      sitting: at !== -1 ? at + 1 : between ? next : 0,
      sittings: list.length,
      sittingEnd: at !== -1 ? list[at].end : null,
      nextAt: between ? list[next].start : null
    };
  }
  var MAX_BLOCKS = 8;
  function cleanBlocks(x) {
    if (!Array.isArray(x) || !x.length) return null;
    if (x.length > MAX_BLOCKS) throw new HttpError(400, "too_many_blocks");
    const list = x.map((b) => ({ start: Math.floor(Number(b && b.start)), end: Math.floor(Number(b && b.end)) })).sort((a, b) => a.start - b.start);
    list.forEach((b, i) => {
      if (!(b.start > 0 && b.end > b.start && b.end - b.start <= 6 * 36e5)) throw new HttpError(400, "bad_time");
      if (i && b.start < list[i - 1].end) throw new HttpError(400, "overlap");
    });
    return list;
  }
  function reopenedAt(room, entry, win) {
    const at = entry ? Math.max(entry.unlockedAt || 0, entry.releasedAt || 0) : 0;
    if (!at) return 0;
    return room.endedAt && at > room.endedAt || win.end && at >= win.end ? at : 0;
  }
  function cleanSittings(x) {
    if (!Array.isArray(x) || x.length < 2) return null;
    if (x.length > MAX_SITTINGS) throw new HttpError(400, "too_many_sittings");
    const list = x.map((s) => ({ start: Math.floor(Number(s && s.start)), end: Math.floor(Number(s && s.end)) }));
    list.forEach((s, i) => {
      if (!(s.start > 0 && s.end > s.start && s.end - s.start <= 6 * 36e5)) throw new HttpError(400, "bad_time");
      if (i && s.start < list[i - 1].end) throw new HttpError(400, "bad_time");
    });
    return list;
  }
  function startedNow(r, now) {
    const base = __spreadProps(__spreadValues({}, r), { open: true, endedAt: null, startAt: now, pausedAt: 0, pausedMs: 0 });
    if (!r.sittings) return base;
    if (now < r.sittings[0].start || now < r.sittings[0].end - 5 * 6e4) {
      const sittings = [__spreadProps(__spreadValues({}, r.sittings[0]), { start: Math.min(now, r.sittings[0].start) }), ...r.sittings.slice(1)];
      return __spreadProps(__spreadValues({}, base), { sittings });
    }
    return __spreadProps(__spreadValues({}, base), { sittings: void 0 });
  }
  function windowOf(room, email, entry) {
    const win = baseWindowOf(room, email, entry);
    if (!reopenedAt(room, entry, win)) return win;
    return __spreadProps(__spreadValues({}, win), { end: null, home: true, ended: false, paused: !!(room.pausedAt || entry && entry.pausedAt), sitting: 0, sittings: 0, sittingEnd: null, nextAt: null, reopened: true });
  }
  function baseWindowOf(room, email, entry) {
    const now = Date.now();
    const ob = room.own && room.own[email];
    if (ob && ob.blocks && !room.atHome) return __spreadProps(__spreadValues({}, partsWindow(ob.blocks, room, entry, now)), { own: true, multiplier: 1, ended: false, parts: true });
    if (room.sittings && !room.atHome) return sittingsWindow(room, email, entry, now);
    const reg = regularWindow(room);
    const paused2 = !!(room.pausedAt || entry && entry.pausedAt);
    const held = pausedFor(room, now) + pausedFor(entry, now);
    const o = room.own && room.own[email];
    if (room.atHome && o && o.startAt) return __spreadProps(__spreadValues({}, reg), { start: o.startAt, own: true, multiplier: 1, ended: regularEnded(room), paused: paused2 });
    if (!o || room.atHome) return __spreadProps(__spreadValues({}, reg), { end: reg.end ? reg.end + held : null, own: false, multiplier: 1, ended: regularEnded(room), paused: paused2 });
    const start = o.startAt || reg.start;
    const multiplier = o.multiplier || 1;
    return { start, end: start + Math.round((room.minutes || REF_MINUTES) * multiplier * 6e4) + held, own: true, multiplier, ended: false, paused: paused2 };
  }
  function paused(x, on, now) {
    if (on) return x.pausedAt ? x : __spreadProps(__spreadValues({}, x), { pausedAt: now });
    if (!x.pausedAt) return x;
    return __spreadProps(__spreadValues({}, x), { pausedAt: 0, pausedMs: (x.pausedMs || 0) + Math.max(0, now - x.pausedAt) });
  }
  function stateAt(win, now) {
    if (win.ended) return "ended";
    if (now < win.start) return "upcoming";
    if (!win.end && win.home) return "running";
    if (now >= (win.end || win.start + MAX_OPEN_MS)) return "ended";
    return "running";
  }
  function onRoster(room, email) {
    return __async(this, null, function* () {
      if ((room.emails || []).includes(email)) return true;
      if (!room.classId) return false;
      const { state } = yield readItem("luddite:class:" + room.classId);
      return !!(state && state.emails.includes(email));
    });
  }
  function shortPrompt(p) {
    const t = String(p || "").split("\n").map((x) => x.trim()).filter(Boolean)[0] || "";
    const one = t.replace(/\s+/g, " ").replace(/^./, (c) => c.toUpperCase());
    if (one.length <= 60) return one;
    const cut = one.slice(0, 60);
    return (cut.slice(0, cut.lastIndexOf(" ")) || cut).replace(/[\s,;:.\-]+$/, "") + "\u2026";
  }
  function titleOf(r) {
    if (!r.casual) return r.title;
    const named = r.titled || r.title && r.title !== "Casual session" && r.title !== r.codeLabel;
    if (named) return r.title;
    return shortPrompt(r.prompt) || r.codeLabel || r.code;
  }
  function roomSummary(room) {
    const students = Object.values(room.students || {});
    const reg = regularWindow(room);
    const state = stateAt(__spreadProps(__spreadValues({}, reg), { ended: regularEnded(room) }), Date.now());
    return {
      code: room.code,
      codeLabel: room.codeLabel || room.code,
      title: titleOf(room),
      open: state === "running",
      state,
      createdAt: room.createdAt,
      classId: room.classId || null,
      casual: !!room.casual,
      atHome: !!room.atHome,
      startAt: reg.start,
      endAt: reg.end,
      endedAt: room.endedAt || null,
      minutes: room.minutes || null,
      sittings: room.sittings || null,
      invited: (room.emails || []).length,
      ownCount: Object.keys(room.own || {}).length,
      waiting: students.filter((s) => s.status === "waiting").length,
      admitted: students.filter((s) => s.status === "admitted").length,
      submissions: (room.submissions || []).length,
      // Papers marked up, given a grade or handed back, so Home can say whether a past session is graded.
      graded: (room.submissions || []).filter((x) => x.grade || x.marked || x.returnedAt).length
    };
  }
  function sharedGradingId(room, sub) {
    const paper = (room.submissions || []).find((x) => x.sub === sub && x.stored);
    if (paper) return paper.returnedAt ? paper.id : null;
    const st = room.students[sub];
    return st && st.earlyShared ? "early:" + room.code + ":" + sub : null;
  }
  function studentView(room, sub, email, prefs) {
    const me = room.students[sub] || null;
    const win = windowOf(room, lower(email), me);
    const now = Date.now();
    const state = stateAt(win, now);
    return {
      code: room.code,
      codeLabel: room.codeLabel || room.code,
      title: titleOf(room),
      open: state === "running",
      state,
      startAt: win.start,
      endAt: win.end,
      own: win.own,
      multiplier: win.multiplier,
      minutes: room.minutes || null,
      now,
      teacherName: room.teacher.name || room.teacher.email,
      prompt: room.prompt || "",
      prefs: prefs || DEFAULT_PREFS,
      atHome: !!room.atHome,
      homePrint: !!room.atHome && room.homePrint !== false,
      // The teacher lets everyone in it read each other's writing so far (see /luddite/classwork).
      shareWork: !!room.shareWork,
      // Grading the teacher has shared with them in this session (their paper's,
      // else their writing so far's), which they can read while they write.
      sharedId: sharedGradingId(room, sub),
      // The rubric, while the teacher lets students see it as they write.
      rubric: room.rubricShown && room.rubric && me && me.status === "admitted" ? room.rubric : null,
      status: me ? me.status : "none",
      leaves: me ? me.leaves || 0 : 0,
      // Left the page while writing: locked out until the teacher lets them back in.
      lockedOut: !!(me && me.lockedOut),
      // Luddite handed in for them when the session ended; their page sends its own copy.
      autoHandedIn: !!(me && me.autoHandedIn),
      // Asked the teacher to unlock them (after handing in, or after a lock-out).
      askedAt: me ? me.askedAt || 0 : 0,
      submittedAt: me ? me.submittedAt || 0 : 0,
      // Chat: when the teacher last wrote to them, and when they last read it.
      chatT: me ? me.chatT || 0 : 0,
      seenS: me ? me.seenS || 0 : 0,
      // Handing in is final: no more writing until the teacher releases them.
      handedIn: !!(me && me.handedIn),
      // Paused by the teacher or a proctor: no writing, and the clock is stopped.
      paused: win.paused,
      // Over several days: which day (sitting) it is, of how many, when today's
      // ends, and when the next one starts (between days).
      sitting: win.sitting || 0,
      sittings: win.sittings || 0,
      sittingEnd: win.sittingEnd || null,
      nextAt: win.nextAt || null,
      // An alternative schedule in parts (not days).
      parts: !!win.parts,
      // Their earlier drafts in this session (see /luddite/newdraft): [{ n, at, words, graded, shared }].
      drafts: me && me.drafts || [],
      // The names they gave their drafts, by number (the one they're writing is drafts.length + 1).
      draftNames: me && me.draftNames || {},
      // The draft they marked as final (a number), or 0.
      finalDraft: me && me.finalDraft || 0
    };
  }
  function cleanEmails(list) {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    (Array.isArray(list) ? list : []).forEach((e) => {
      const found = String(e || "").match(/[^\s<>,;"']+@[^\s<>,;"']+\.[^\s<>,;"']+/);
      const x = found ? lower(found[0]) : "";
      if (EMAIL_RE.test(x) && !seen.has(x)) {
        seen.add(x);
        out.push(x);
      }
    });
    return out;
  }
  function inBatches(items, fn) {
    return __async(this, null, function* () {
      for (let i = 0; i < items.length; i += 10) yield Promise.all(items.slice(i, i + 10).map(fn));
    });
  }
  function indexClass(classId, add, remove) {
    return __async(this, null, function* () {
      yield inBatches(add, (email) => mutate("luddite:mine:" + email, (m) => {
        const classes = m && m.classes || [];
        return classes.includes(classId) ? void 0 : __spreadProps(__spreadValues({}, m || {}), { classes: [classId, ...classes] });
      }));
      yield inBatches(remove, (email) => mutate("luddite:mine:" + email, (m) => {
        const classes = m && m.classes || [];
        return classes.includes(classId) ? __spreadProps(__spreadValues({}, m), { classes: classes.filter((c) => c !== classId) }) : void 0;
      }));
    });
  }
  function getClass(id, me, role) {
    return __async(this, null, function* () {
      const key = String(id || "");
      if (!/^[a-f0-9]{12}$/.test(key)) throw new HttpError(404, "no_class");
      const { state } = yield readItem("luddite:class:" + key);
      if (!state || state.deletedAt) throw new HttpError(404, "no_class");
      if (state.teacher.sub !== me.sub && !ownerMayOpen(role, state.teacher.email)) throw new HttpError(403, "not_your_class");
      return state;
    });
  }
  var classSummary = (c) => ({ id: c.id, name: c.name, count: c.emails.length, createdAt: c.createdAt, period: c.period || "", grade: c.grade || "", color: c.color == null ? null : c.color });
  var cleanGradeLevel = (g) => String(g == null ? "" : g).replace(/\s+/g, " ").trim().slice(0, 24);
  var cleanColor = (x) => Number.isInteger(x) && x >= 0 && x < 8 ? x : null;
  var cleanPeriod = (p) => /^[A-H]$/.test(String(p || "").toUpperCase()) ? String(p).toUpperCase() : "";
  var driveTokens = /* @__PURE__ */ new Map();
  function googleToken(params) {
    return __async(this, null, function* () {
      const res = yield fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(__spreadValues({ client_id: LUDDITE_CLIENT_ID, client_secret: LUDDITE_CLIENT_SECRET }, params))
      });
      const data = yield res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new HttpError(res.status === 400 ? 409 : 502, data.error === "invalid_grant" ? "drive_revoked" : "drive_failed");
        err.detail = data.error;
        throw err;
      }
      return data;
    });
  }
  function connectDrive(info, code) {
    return __async(this, null, function* () {
      if (!LUDDITE_CLIENT_SECRET) throw new HttpError(503, "drive_not_configured");
      const data = yield googleToken({ code, grant_type: "authorization_code", redirect_uri: "postmessage" });
      if (!String(data.scope || "").includes("https://www.googleapis.com/auth/drive.file")) throw new HttpError(409, "drive_not_granted");
      let email = "";
      try {
        email = JSON.parse(Buffer2.from(data.id_token.split(".")[1], "base64url").toString("utf8")).email || "";
      } catch (e) {
      }
      yield mutate("luddite:drive:" + info.sub, (d) => {
        const refreshToken = data.refresh_token || (d && d.email === email ? d.refreshToken : "");
        if (!refreshToken) throw new HttpError(409, "drive_no_refresh");
        const keep = d && d.email === email;
        return { refreshToken, email, rootId: keep ? d.rootId : null, roomFolders: keep ? d.roomFolders : {}, connectedAt: Date.now() };
      });
      driveTokens.delete(info.sub);
      if (data.access_token) driveTokens.set(info.sub, { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1e3 });
      return { connected: true, email };
    });
  }
  function driveAccessToken(teacherSub, drive) {
    return __async(this, null, function* () {
      const cached = driveTokens.get(teacherSub);
      if (cached && cached.exp > Date.now()) return cached.token;
      const data = yield googleToken({ refresh_token: drive.refreshToken, grant_type: "refresh_token" });
      driveTokens.set(teacherSub, { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1e3 });
      return data.access_token;
    });
  }
  function driveCall(token, url, init) {
    return __async(this, null, function* () {
      const res = yield fetch(url, __spreadProps(__spreadValues({}, init), { headers: __spreadValues({ Authorization: "Bearer " + token }, init.headers || {}) }));
      const data = yield res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new HttpError(res.status === 404 ? 404 : 502, res.status === 404 ? "drive_folder_missing" : "drive_failed");
        err.detail = data.error && data.error.message;
        throw err;
      }
      return data;
    });
  }
  function createFolder(token, name, parentId) {
    return driveCall(token, "https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: parentId ? [parentId] : void 0 })
    }).then((f) => f.id);
  }
  function roomFolder(teacherSub, token, room, fresh) {
    return __async(this, null, function* () {
      let { state: drive } = yield readItem("luddite:drive:" + teacherSub);
      if (!fresh && drive.roomFolders && drive.roomFolders[room.code]) return drive.roomFolders[room.code];
      const rootId = !fresh && drive.rootId || (yield createFolder(token, "Luddite submissions"));
      const folderId = yield createFolder(token, room.casual ? "Casual session (" + (room.codeLabel || room.code) + ")" : room.title + " (" + (room.codeLabel || room.code) + ")", rootId);
      yield mutate("luddite:drive:" + teacherSub, (d) => __spreadProps(__spreadValues({}, d), { rootId, roomFolders: __spreadProps(__spreadValues({}, d.roomFolders || {}), { [room.code]: folderId }) }));
      return folderId;
    });
  }
  function saveToDrive(room, doc) {
    return __async(this, null, function* () {
      const { state: drive } = yield readItem("luddite:drive:" + room.teacher.sub);
      if (!drive || !drive.refreshToken) throw new HttpError(409, "teacher_no_drive");
      const token = yield driveAccessToken(room.teacher.sub, drive);
      const upload = (folderId) => __async(null, null, function* () {
        const boundary = "luddite" + Math.random().toString(36).slice(2);
        const meta = { name: doc.name, mimeType: "application/vnd.google-apps.document", parents: [folderId], description: doc.description };
        const body = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(meta) + "\r\n--" + boundary + "\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n" + doc.text + "\r\n--" + boundary + "--";
        return driveCall(token, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
          method: "POST",
          headers: { "Content-Type": "multipart/related; boundary=" + boundary },
          body
        });
      });
      try {
        return yield upload(yield roomFolder(room.teacher.sub, token, room, false));
      } catch (e) {
        if (e.message !== "drive_folder_missing") throw e;
        return upload(yield roomFolder(room.teacher.sub, token, room, true));
      }
    });
  }
  function wordsAt(text, p) {
    const a = Math.max(0, p - 18), b = Math.min(text.length, p + 22);
    let t = text.slice(a, b).replace(/\s+/g, " ");
    if (a > 0) t = t.replace(/^\S*\s/, "");
    if (b < text.length) t = t.replace(/\s\S*$/, "");
    return t.trim();
  }
  function arrowQuote(text, m) {
    const from = m.head === "start" ? m.end : m.start, to = m.head === "start" ? m.start : m.end;
    return "from \u201C" + wordsAt(text, from) + "\u201D to \u201C" + wordsAt(text, to) + "\u201D";
  }
  var escHtml = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  var PEN = "#2f6b3a";
  function markedHtml(piece) {
    const text = piece.text, marks = piece.marks || [];
    const notes = marks.filter((m) => m.type === "margin" || m.type === "arrow").sort((a, b) => a.start - b.start || a.end - b.end);
    const margins = notes.filter((m) => m.type === "margin");
    const num = new Map(notes.map((m, i) => [m.id, i + 1]));
    const cuts = /* @__PURE__ */ new Set([0, text.length]);
    marks.forEach((m) => {
      cuts.add(m.start);
      cuts.add(m.end);
      (m.parts || []).forEach((q) => {
        cuts.add(m.start + q[0]);
        cuts.add(m.start + q[1]);
      });
    });
    const pts = [...cuts].sort((a, b) => a - b);
    const pen = (inner) => '<span style="color:' + PEN + '">' + inner + "</span>";
    let body = "";
    pts.forEach((p, i) => {
      margins.forEach((m) => {
        if (m.end === p) body += pen("<sup>[" + num.get(m.id) + "]</sup>");
      });
      marks.forEach((m) => {
        if (m.type !== "insert" || m.start !== p) return;
        const f = String(m.fmt || "").padEnd(m.note.length, " ");
        let runs = "", cur = "", curF = null;
        const flush = () => {
          if (curF === null) return;
          let h2 = escHtml(cur);
          if (curF === "b" || curF === "x") h2 = "<b>" + h2 + "</b>";
          if (curF === "i" || curF === "x") h2 = "<i>" + h2 + "</i>";
          runs += h2;
          cur = "";
        };
        for (let k = 0; k < m.note.length; k++) {
          if (f[k] !== curF) {
            flush();
            curF = f[k];
          }
          cur += m.note[k];
        }
        flush();
        body += pen("\u2038" + runs) + " ";
      });
      const next = pts[i + 1];
      if (next === void 0 || next === p) return;
      let h = escHtml(text.slice(p, next)).replace(/\n/g, "<br>");
      const covers = (m) => m.parts ? m.parts.some((q) => m.start + q[0] <= p && m.start + q[1] >= next) : m.start <= p && m.end >= next;
      const on = marks.filter((m) => m.type !== "insert" && m.type !== "arrow" && covers(m));
      if (on.some((m) => m.type === "strike")) h = '<s style="text-decoration-color:' + PEN + '">' + h + "</s>";
      if (on.some((m) => m.type === "bold")) h = '<b style="color:' + PEN + '">' + h + "</b>";
      if (on.some((m) => m.type === "circle")) h = '<span style="border:1.5px solid ' + PEN + ';border-radius:9px">' + h + "</span>";
      if (on.some((m) => m.type === "margin")) h = '<span style="background-color:#e3f0e3">' + h + "</span>";
      body += h;
    });
    let html = '<html><body><p style="font-size:11pt"><b>' + escHtml(piece.name || piece.email) + "</b> \u2014 " + escHtml(piece.roomTitle || "") + "</p>";
    if (piece.grade) html += '<p style="color:' + PEN + ';font-size:14pt"><b>Grade: ' + escHtml(piece.grade) + "</b></p>";
    html += "<p>" + body + "</p>";
    if (notes.length) {
      html += '<hr><p style="color:' + PEN + '"><b>Comments</b></p>';
      notes.forEach((m) => {
        if (m.type === "arrow") {
          html += '<p style="color:' + PEN + '">[' + num.get(m.id) + "] Arrow " + escHtml(arrowQuote(text, m)) + (m.note ? " \u2014 " + escHtml(m.note) : "") + "</p>";
          return;
        }
        const q = text.slice(m.start, m.end).replace(/\s+/g, " ").trim();
        html += '<p style="color:' + PEN + '">[' + num.get(m.id) + "] \u201C" + escHtml(q.length > 80 ? q.slice(0, 77) + "\u2026" : q) + "\u201D \u2014 " + escHtml(m.note) + "</p>";
      });
    }
    if (piece.endComment && piece.endComment.trim()) {
      html += '<hr><p style="color:' + PEN + '"><b>End comment</b></p><p style="color:' + PEN + '">' + escHtml(piece.endComment).replace(/\n/g, "<br>") + "</p>";
    }
    return html + "</body></html>";
  }
  function updateDriveDoc(teacherSub, piece) {
    return __async(this, null, function* () {
      if (!piece.link || !/^[A-Za-z0-9_-]{10,}$/.test(piece.id)) return;
      const { state: drive } = yield readItem("luddite:drive:" + teacherSub);
      if (!drive || !drive.refreshToken) return;
      const token = yield driveAccessToken(teacherSub, drive);
      yield driveCall(token, "https://www.googleapis.com/upload/drive/v3/files/" + piece.id + "?uploadType=media&fields=id", {
        method: "PATCH",
        headers: { "Content-Type": "text/html; charset=UTF-8" },
        body: markedHtml(piece)
      });
    });
  }
  function ownSub(id, me, role) {
    return __async(this, null, function* () {
      const key = String(id || "");
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw new HttpError(404, "no_sub");
      const { state } = yield readItem("luddite:sub:" + key);
      if (!state) throw new HttpError(404, "no_sub");
      if (state.teacherSub !== me.sub) {
        const { state: room } = yield readItem("luddite:room:" + state.code);
        if (!room || !ownerMayOpen(role, room.teacher.email)) throw new HttpError(403, "not_your_student");
      }
      return state;
    });
  }
  function cleanMarks(list, length) {
    if (!Array.isArray(list)) throw new HttpError(400, "bad_marks");
    if (list.length > MAX_MARKS) throw new HttpError(413, "too_many_marks");
    let chars = 0;
    const out = list.map((m) => {
      const type = m && m.type;
      if (!["margin", "strike", "insert", "arrow", "bold", "circle"].includes(type)) throw new HttpError(400, "bad_marks");
      const clamp = (v) => Math.max(0, Math.min(length, Math.floor(Number(v) || 0)));
      let start = clamp(m.start);
      let end = type === "insert" ? start : Math.max(start, clamp(m.end));
      if (type === "arrow") {
        const a = clamp(m.start), b = clamp(m.end);
        start = Math.min(a, b);
        end = Math.max(a, b);
      }
      const orphan = type !== "strike" && m.orphan ? String(m.orphan).slice(0, 300) : "";
      if (orphan) {
        start = 0;
        end = 0;
      }
      if (type !== "insert" && end === start && !orphan) throw new HttpError(400, "bad_marks");
      const note = String(m.note || "").slice(0, 2e3);
      if (type === "insert" && !note.trim()) throw new HttpError(400, "bad_marks");
      chars += note.length;
      const mark = { id: String(m.id || "").slice(0, 40) || randomUUID().slice(0, 8), type, start, end, note, at: Number(m.at) || Date.now() };
      if (type === "arrow") mark.head = m.head === "start" ? "start" : "end";
      if (orphan) mark.orphan = orphan;
      if (type === "margin" && !orphan && Array.isArray(m.parts) && m.parts.length > 1) {
        const span = end - start, parts = [];
        for (const q of m.parts.slice(0, 200)) {
          const a = Math.max(0, Math.min(span, Math.floor(Number(q && q[0]) || 0))), b = Math.max(a, Math.min(span, Math.floor(Number(q && q[1]) || 0)));
          if (b > a && (!parts.length || a >= parts[parts.length - 1][1])) parts.push([a, b]);
        }
        if (parts.length > 1) mark.parts = parts;
      }
      if (type === "insert") {
        const f = String(m.fmt || "").replace(/[^bix ]/g, " ").slice(0, note.length);
        if (/[bix]/.test(f)) mark.fmt = f.padEnd(note.length, " ");
      }
      return mark;
    });
    if (chars > MAX_MARK_CHARS) throw new HttpError(413, "too_many_marks");
    return out;
  }
  function findNear(text, needle, want) {
    if (!needle) return -1;
    let best = -1, i = text.indexOf(needle);
    while (i !== -1) {
      if (best === -1 || Math.abs(i - want) < Math.abs(best - want)) best = i;
      i = text.indexOf(needle, i + 1);
    }
    return best;
  }
  function pointIn(base, text, at) {
    const want = base.length ? Math.round(at * text.length / base.length) : 0;
    for (const n of [40, 20, 10]) {
      const before = base.slice(Math.max(0, at - n), at);
      if (before.trim()) {
        const i = findNear(text, before, want - before.length);
        if (i !== -1) return i + before.length;
      }
      const after = base.slice(at, at + n);
      if (after.trim()) {
        const i = findNear(text, after, want);
        if (i !== -1) return i;
      }
    }
    return at === 0 ? 0 : -1;
  }
  var quoteOf = (t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 300);
  function reanchorMarks(marks, base, text) {
    if (base === text) return marks || [];
    const scale = (at) => base.length ? Math.round(at * text.length / base.length) : 0;
    const orphan = (m, words) => __spreadProps(__spreadValues({}, m), { start: 0, end: 0, orphan: quoteOf(words) || "(gone)" });
    const out = [];
    for (const m of marks || []) {
      if (m.orphan) {
        out.push(m);
        continue;
      }
      if (m.type === "insert") {
        const p = pointIn(base, text, m.start);
        out.push(p === -1 ? orphan(m, base.slice(Math.max(0, m.start - 40), m.start + 40)) : __spreadProps(__spreadValues({}, m), { start: p, end: p }));
        continue;
      }
      if (m.type === "arrow") {
        const a = pointIn(base, text, m.start), b = pointIn(base, text, m.end);
        if (a === -1 || b === -1 || a === b) {
          out.push(orphan(m, base.slice(m.start, Math.min(m.end, m.start + 300))));
          continue;
        }
        out.push(__spreadProps(__spreadValues({}, m), { start: Math.min(a, b), end: Math.max(a, b), head: a <= b ? m.head : m.head === "start" ? "end" : "start" }));
        continue;
      }
      if (m.type === "margin" && m.parts && m.parts.length > 1) {
        const found = [];
        let after = 0;
        for (const [a, b] of m.parts) {
          const w = base.slice(m.start + a, m.start + b);
          const i2 = w.trim() ? findNear(text, w, scale(m.start + a)) : -1;
          if (i2 !== -1 && i2 >= after) {
            found.push([i2, i2 + w.length]);
            after = i2 + w.length;
          }
        }
        const _a = m, { parts } = _a, rest = __objRest(_a, ["parts"]);
        if (!found.length) {
          out.push(orphan(rest, parts.map(([a, b]) => base.slice(m.start + a, m.start + b)).join(" \u2026 ")));
          continue;
        }
        const s0 = found[0][0], moved = __spreadProps(__spreadValues({}, rest), { start: s0, end: found[found.length - 1][1] });
        if (found.length > 1) moved.parts = found.map(([a, b]) => [a - s0, b - s0]);
        out.push(moved);
        continue;
      }
      const q = base.slice(m.start, m.end);
      const i = q.trim() ? findNear(text, q, scale(m.start)) : -1;
      if (i !== -1) {
        out.push(__spreadProps(__spreadValues({}, m), { start: i, end: i + q.length }));
        continue;
      }
      if (m.type === "strike" || m.type === "bold" || m.type === "circle") continue;
      out.push(orphan(m, q));
    }
    return out;
  }
  function mergeMarks(a, b) {
    const seen = new Set((a || []).map((m) => m.id));
    return [...a || [], ...(b || []).filter((m) => !seen.has(m.id))];
  }
  function handleLuddite(event, method, path, info) {
    return __async(this, null, function* () {
      try {
        return yield routeLuddite(event, method, path, info);
      } catch (e) {
        if (e instanceof HttpError) return respond(e.status, { error: e.message, detail: e.detail });
        throw e;
      }
    });
  }
  function routeLuddite(event, method, path, info) {
    return __async(this, null, function* () {
      var _a, _b, _c;
      path = path.replace(/^\/luddite\/rooms$/, "/luddite/assignments").replace(/^\/luddite\/room$/, "/luddite/assignment");
      const q = event.queryStringParameters || {};
      const body = method === "PUT" ? readJsonBody(event) : {};
      if (!body) return respond(400, { error: "Invalid JSON body" });
      const role = yield roleOf(info);
      const isTeacher = role === "owner" || role === "teacher";
      const me = { sub: info.sub, email: info.email || "", name: info.name || "" };
      if (path.startsWith("/luddite/admin/")) return routeHmAdmin(event, method, path, q, body, me);
      if (path === "/luddite/status" && method === "GET") {
        const session = issueSession(info);
        const proctor = (yield isPermanentProctor(me.email)) || !!((_a = ((yield readItem("luddite:mine:" + lower(me.email))).state || {}).proctor) == null ? void 0 : _a.length);
        return respond(200, { luddite: { role, email: me.email, name: me.name, proctor }, session });
      }
      if (path === "/luddite/proctor" || path.startsWith("/luddite/proctor/")) return routeProctor(method, path, q, body, me);
      if (path === "/luddite/mine" && method === "GET") {
        const em = lower(me.email);
        const now = Date.now();
        const { state: mine } = yield readItem("luddite:mine:" + em);
        const codes = new Set(mine && mine.own || []);
        const viaClass = /* @__PURE__ */ new Set();
        (mine && mine.rooms || []).forEach((code) => {
          codes.add(code);
          viaClass.add(code);
        });
        const classes = yield Promise.all((mine && mine.classes || []).map((id) => readItem("luddite:class:" + id)));
        classes.forEach(({ state: c }) => {
          if (!c || c.deletedAt || !c.emails.includes(em)) return;
          (c.assignments || []).slice(0, MINE_ASSIGNMENTS_PER_CLASS).forEach((code) => {
            codes.add(code);
            viaClass.add(code);
          });
        });
        const rooms = yield Promise.all([...codes].map((c) => readItem("luddite:room:" + c)));
        const list = [];
        rooms.forEach(({ state: r }) => {
          if (!r || r.deletedAt) return;
          if (!viaClass.has(r.code) && !(r.own && r.own[em])) return;
          if (!r.classId && r.emails && !r.emails.includes(em) && !(r.own && r.own[em])) return;
          const s = r.students[me.sub];
          if (s && s.status === "removed") return;
          const win = windowOf(r, em, s);
          const state = stateAt(win, now);
          if (state === "ended" || state === "upcoming" && win.start - now > UPCOMING_HORIZON_MS) return;
          list.push({
            code: r.code,
            codeLabel: r.codeLabel || r.code,
            title: titleOf(r),
            teacherName: r.teacher.name || r.teacher.email,
            state,
            startAt: win.start,
            endAt: win.end,
            own: win.own,
            multiplier: win.multiplier,
            status: s ? s.status : "none",
            handedIn: !!(s && s.handedIn)
          });
        });
        list.sort((a, b) => a.state === b.state ? a.startAt - b.startAt : a.state === "running" ? -1 : 1);
        return respond(200, { assignments: list, now });
      }
      if (path === "/luddite/join" && method === "PUT") {
        const code = cleanCode(body.code);
        const em = lower(me.email);
        const before = yield getRoom(code);
        const rostered = yield onRoster(before, em);
        const room = yield mutate("luddite:room:" + code, (r) => {
          if (!r || r.deletedAt) throw new HttpError(404, "no_room");
          const expected = !!(rostered || r.casual || r.own && r.own[em]);
          const s = r.students[me.sub];
          const win = windowOf(r, em, s);
          const state = stateAt(win, Date.now());
          if (s) {
            let next = s;
            if (s.email !== me.email || s.name !== me.name) next = __spreadProps(__spreadValues({}, next), { email: me.email, name: me.name });
            if (s.status === "waiting" && expected && state === "running") next = __spreadProps(__spreadValues({}, next), { status: "admitted", decidedAt: Date.now(), via: "class" });
            return next === s ? void 0 : __spreadProps(__spreadValues({}, r), { students: __spreadProps(__spreadValues({}, r.students), { [me.sub]: next }) });
          }
          if (state === "upcoming") {
            const e = new HttpError(403, "not_started");
            e.detail = win.start;
            throw e;
          }
          if (state === "ended") throw new HttpError(403, "room_closed");
          const entry = { email: me.email, name: me.name, status: expected ? "admitted" : "waiting", requestedAt: Date.now(), leaves: 0, words: 0 };
          if (expected) {
            entry.decidedAt = Date.now();
            entry.via = "class";
          }
          return __spreadProps(__spreadValues({}, r), { students: __spreadProps(__spreadValues({}, r.students), { [me.sub]: entry }) });
        });
        return respond(200, { room: studentView(room, me.sub, me.email, yield prefsOf(room.teacher.sub)) });
      }
      if (path === "/luddite/assignment" && method === "GET") {
        const room = yield getRoom(cleanCode(q.code));
        if (q.as !== "student" && isTeacher && ownsRoom(room, info, role)) return respond(200, { room: __spreadProps(__spreadValues({}, room), { title: titleOf(room) }), drive: yield driveStatus(room.teacher.sub), roster: yield rosterOf(room) });
        return respond(200, { room: studentView(room, me.sub, me.email, yield prefsOf(room.teacher.sub)) });
      }
      if (path === "/luddite/event" && method === "PUT") {
        const code = cleanCode(body.code);
        let prevSeen = 0;
        const room = yield mutate("luddite:room:" + code, (r) => {
          const s = r && r.students[me.sub];
          if (!s || s.status !== "admitted") return void 0;
          prevSeen = s.lastSeen || 0;
          const next = __spreadProps(__spreadValues({}, s), { lastSeen: Date.now() });
          const held = windowOf(r, lower(s.email), s).paused;
          if (body.type === "left" && held) Object.assign(next, { away: true, writing: false });
          else if (body.type === "left" && r.atHome) Object.assign(next, { leaves: (s.leaves || 0) + 1, away: true, writing: false });
          else if (body.type === "left") Object.assign(next, { leaves: (s.leaves || 0) + 1, away: true, writing: false, lockedOut: !TEST_EMAILS.includes(lower(me.email)) });
          if ((body.type === "writing" || body.type === "idle") && !s.lockedOut) Object.assign(next, { away: false, writing: body.type === "writing" && !s.handedIn });
          if (body.type === "ask" && (s.handedIn || s.lockedOut)) next.askedAt = Date.now();
          if (Number.isFinite(body.words)) next.words = Math.max(0, Math.floor(body.words));
          return __spreadProps(__spreadValues({}, r), { students: __spreadProps(__spreadValues({}, r.students), { [me.sub]: next }) });
        });
        if (!room) throw new HttpError(404, "no_room");
        let saved = null;
        if (typeof body.text === "string" && room.students[me.sub] && room.students[me.sub].status === "admitted") saved = yield saveDraft(code, me.sub, body.text, prevSeen, Number.isFinite(body.baseAt) ? body.baseAt : void 0);
        return respond(200, __spreadProps(__spreadValues({}, saved && saved.conflict ? { conflict: saved.conflict } : saved ? { draftAt: saved.at } : {}), { room: studentView(room, me.sub, me.email, yield prefsOf(room.teacher.sub)) }));
      }
      if (path === "/luddite/newdraft" && method === "PUT") {
        const code = cleanCode(body.code);
        const room = yield getRoom(code);
        const st = room.students[me.sub];
        if (!st || st.status !== "admitted") throw new HttpError(404, "not_in_room");
        if (st.handedIn || st.lockedOut) throw new HttpError(409, "cant_write");
        if ((st.drafts || []).length >= 30) throw new HttpError(409, "too_many_drafts");
        const { state: d } = yield readItem("luddite:draft:" + code + ":" + me.sub);
        const text = d ? String(d.text || "") : "";
        if (!text.trim()) throw new HttpError(409, "nothing_yet");
        const paperSub = (room.submissions || []).find((x) => x.sub === me.sub && x.stored);
        const paper = paperSub ? (yield readItem("luddite:sub:" + paperSub.id)).state : null;
        const { state: early } = yield readItem("luddite:early:" + code + ":" + me.sub);
        const e = early && !early.usedAt ? early : null;
        let marks = [], endComment = "", grade = "", rubric = null, rubricScores = [], returnedAt = null;
        if (paper) {
          marks = reanchorMarks(paper.marks || [], paper.text, text);
          ({ endComment, grade, rubric, rubricScores, returnedAt } = paper);
          endComment = endComment || "";
          grade = grade || "";
          rubricScores = rubricScores || [];
        }
        if (e) {
          marks = mergeMarks(marks, reanchorMarks(e.marks || [], e.base, text));
          const ec = (e.endComment || "").trim();
          if (ec && !endComment.includes(ec)) endComment = endComment ? endComment + "\n\n" + e.endComment : e.endComment;
          grade = grade || e.grade || "";
          if (!rubric && e.rubric) {
            rubric = e.rubric;
            rubricScores = e.rubricScores || [];
          }
          returnedAt = returnedAt || e.returnedAt || null;
        }
        const n = (st.drafts || []).length + 1, at = Date.now();
        const words = (text.trim().match(/\S+/g) || []).length;
        const old = {
          code,
          sub: me.sub,
          n,
          text,
          words,
          marks,
          endComment: endComment || "",
          grade: grade || "",
          rubric: rubric || null,
          rubricScores: rubricScores || [],
          returnedAt: returnedAt || null,
          startedAt: st.draftAt || 0,
          at,
          roomTitle: titleOf(room)
        };
        if (Buffer2.byteLength(JSON.stringify(old)) > MAX_ITEM_BYTES) throw new HttpError(413, "too_long");
        yield mutate("luddite:olddraft:" + code + ":" + me.sub + ":" + n, () => old);
        const ids = [];
        if (paper) {
          ids.push(paper.id);
          yield mutate("luddite:sub:" + paper.id, (x) => x ? __spreadProps(__spreadValues({}, x), { marks: [], endComment: "", grade: "", rubricScores: [], returnedAt: null, markedAt: null, view: null, gathered: true }) : void 0);
        }
        if (early) {
          ids.push("early:" + code + ":" + me.sub);
          yield mutate("luddite:early:" + code + ":" + me.sub, (x) => x ? __spreadProps(__spreadValues({}, x), { base: text, marks: [], endComment: "", grade: "", rubricScores: [], returnedAt: null, view: null }) : void 0);
        }
        if (ids.length) yield mutate("luddite:mine:" + lower(me.email), (m) => m && (m.returned || []).some((x) => ids.includes(x)) ? __spreadProps(__spreadValues({}, m), { returned: m.returned.filter((x) => !ids.includes(x)) }) : void 0).catch(() => {
        });
        const saved = yield mutate("luddite:room:" + code, (r) => {
          const x = r && r.students[me.sub];
          if (!x) return void 0;
          const submissions = (r.submissions || []).map((y) => paper && y.id === paper.id ? __spreadProps(__spreadValues({}, y), { marked: 0, grade: "", returnedAt: null }) : y);
          const entry = { n, at, words, graded: !!(old.marks.length || old.endComment.trim() || old.grade), shared: !!old.returnedAt };
          return __spreadProps(__spreadValues({}, r), { submissions, students: __spreadProps(__spreadValues({}, r.students), { [me.sub]: __spreadProps(__spreadValues({}, x), { drafts: [...x.drafts || [], entry], draftAt: at, earlyMarked: 0, earlyGrade: "", earlyShared: null }) }) });
        });
        return respond(200, { room: studentView(saved, me.sub, me.email, yield prefsOf(saved.teacher.sub)) });
      }
      if (path === "/luddite/draftfinal" && method === "PUT") {
        const code = cleanCode(body.code);
        const room = yield getRoom(code);
        const st = room.students[me.sub];
        if (!st || st.status !== "admitted") throw new HttpError(404, "not_in_room");
        const n = Math.floor(Number(body.n) || 0);
        if (n < 0 || n > (st.drafts || []).length + 1) throw new HttpError(400, "bad_draft");
        const saved = yield mutate("luddite:room:" + code, (r) => r && r.students[me.sub] ? __spreadProps(__spreadValues({}, r), { students: __spreadProps(__spreadValues({}, r.students), { [me.sub]: __spreadProps(__spreadValues({}, r.students[me.sub]), { finalDraft: n }) }) }) : void 0);
        return respond(200, { room: studentView(saved, me.sub, me.email, yield prefsOf(saved.teacher.sub)) });
      }
      if (path === "/luddite/draftname" && method === "PUT") {
        const code = cleanCode(body.code);
        const room = yield getRoom(code);
        const st = room.students[me.sub];
        if (!st || st.status !== "admitted") throw new HttpError(404, "not_in_room");
        const n = Math.floor(Number(body.n) || 0);
        if (n < 1 || n > (st.drafts || []).length + 1) throw new HttpError(400, "bad_draft");
        const name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
        const saved = yield mutate("luddite:room:" + code, (r) => {
          const x = r && r.students[me.sub];
          if (!x) return void 0;
          const names = __spreadValues({}, x.draftNames || {});
          if (name) names[n] = name;
          else delete names[n];
          return __spreadProps(__spreadValues({}, r), { students: __spreadProps(__spreadValues({}, r.students), { [me.sub]: __spreadProps(__spreadValues({}, x), { draftNames: names }) }) });
        });
        return respond(200, { room: studentView(saved, me.sub, me.email, yield prefsOf(saved.teacher.sub)) });
      }
      if (path === "/luddite/drafts" && method === "GET") {
        const room = yield getRoom(cleanCode(q.code));
        const asTeacher = !!q.sub && ownsRoom(room, info, role);
        const sub = asTeacher ? String(q.sub) : me.sub;
        const st = room.students[sub];
        if (!st) throw new HttpError(404, "no_student");
        if (!q.n) return respond(200, { drafts: st.drafts || [], now: (st.drafts || []).length + 1, names: st.draftNames || {}, final: st.finalDraft || 0 });
        const { state: dr } = yield readItem("luddite:olddraft:" + room.code + ":" + sub + ":" + Math.floor(Number(q.n) || 0));
        if (!dr) throw new HttpError(404, "no_draft");
        const shown = asTeacher || dr.returnedAt;
        return respond(200, { draft: __spreadValues(__spreadValues({}, dr), shown ? {} : { marks: [], endComment: "", grade: "", rubricScores: [] }), name: st.name || "", email: st.email || "" });
      }
      if (path === "/luddite/classwork" && method === "GET") {
        const room = yield getRoom(cleanCode(q.code));
        const s = room.students[me.sub];
        if (!s || s.status !== "admitted") throw new HttpError(403, "not_admitted");
        if (!room.shareWork) throw new HttpError(403, "not_shared");
        const subs = Object.keys(room.students).filter((sub) => sub !== me.sub && room.students[sub].status === "admitted");
        const got = yield Promise.all(subs.map((sub) => readItem("luddite:draft:" + room.code + ":" + sub)));
        const work = subs.map((sub, i) => {
          const st = room.students[sub], d = got[i].state;
          return { sub, name: st.name || String(st.email || "").split("@")[0], text: d ? String(d.text || "") : "", at: d ? d.at : 0, handedIn: !!st.handedIn };
        }).filter((x) => x.text.trim()).sort((a, b) => a.name.localeCompare(b.name));
        return respond(200, { work });
      }
      if (path === "/luddite/draft" && method === "GET") {
        const { state } = yield readItem("luddite:draft:" + cleanCode(q.code) + ":" + me.sub);
        return respond(200, { draft: state ? { text: state.text, at: state.at } : null });
      }
      if (path === "/luddite/mywork" && method === "GET") {
        const origin = ((_b = event.headers) == null ? void 0 : _b.origin) || ((_c = event.headers) == null ? void 0 : _c.Origin) || "";
        if (origin !== HM_ORIGIN) return respond(404, { error: "Not found" });
        const wordCount = (t) => (String(t || "").trim().match(/\S+/g) || []).length;
        if (q.code) {
          const room = yield getRoom(cleanCode(q.code));
          const st = room.students[me.sub];
          if (room.deletedAt || !st || st.status === "removed") throw new HttpError(404, "no_student");
          const older = yield Promise.all((st.drafts || []).map((d) => readItem("luddite:olddraft:" + room.code + ":" + me.sub + ":" + d.n)));
          const { state: cur } = yield readItem("luddite:draft:" + room.code + ":" + me.sub);
          let nowText = cur ? String(cur.text || "") : "";
          if (!nowText.trim()) {
            const paperSub = (room.submissions || []).find((x) => x.sub === me.sub && x.stored);
            const paper = paperSub ? (yield readItem("luddite:sub:" + paperSub.id)).state : null;
            if (paper) nowText = String(paper.text || "");
          }
          const names = st.draftNames || {};
          const drafts = (st.drafts || []).map((d, i) => {
            const text = older[i].state ? String(older[i].state.text || "") : "";
            return { n: d.n, name: names[d.n] || "", text, words: wordCount(text), at: d.at || 0 };
          });
          const n = drafts.length + 1;
          drafts.push({ n, name: names[n] || "", text: nowText, words: wordCount(nowText), at: cur && cur.at || st.submittedAt || 0 });
          return respond(200, { code: room.code, title: titleOf(room), teacherName: room.teacher.name || room.teacher.email, final: st.finalDraft || 0, drafts });
        }
        const em = lower(me.email);
        const { state: mine } = yield readItem("luddite:mine:" + em);
        const codes = /* @__PURE__ */ new Set([...mine && mine.handed || [], ...mine && mine.rooms || [], ...mine && mine.own || []]);
        const classes = yield Promise.all((mine && mine.classes || []).map((id) => readItem("luddite:class:" + id)));
        classes.forEach(({ state: c }) => {
          if (c && !c.deletedAt && c.emails.includes(em)) (c.assignments || []).forEach((code) => codes.add(code));
        });
        const rooms = yield Promise.all([...codes].slice(0, 400).map((c) => readItem("luddite:room:" + c)));
        const sessions = [];
        rooms.forEach(({ state: r }) => {
          const s = r && !r.deletedAt && r.students[me.sub];
          if (!s || s.status !== "admitted") return;
          if (!s.words && !s.handedIn && !(s.drafts || []).length) return;
          sessions.push({
            code: r.code,
            title: titleOf(r),
            teacherName: r.teacher.name || r.teacher.email,
            at: Math.max(s.submittedAt || 0, s.draftAt || 0, r.startAt || 0, r.createdAt || 0),
            words: s.words || 0,
            drafts: (s.drafts || []).length + 1,
            final: s.finalDraft || 0,
            handedIn: !!s.handedIn
          });
        });
        sessions.sort((a, b) => b.at - a.at);
        return respond(200, { sessions });
      }
      if (path === "/luddite/reread" && method === "GET") {
        const textOf = (r) => __async(null, null, function* () {
          const st = r.students[me.sub];
          if (!st || st.status !== "admitted") return null;
          const paperSub = (r.submissions || []).filter((x) => x.sub === me.sub && x.stored).pop();
          const paper = paperSub ? (yield readItem("luddite:sub:" + paperSub.id)).state : null;
          if (paper && String(paper.text || "").trim()) return { text: String(paper.text), at: paper.at || st.submittedAt || 0, handedIn: true };
          const { state: cur } = yield readItem("luddite:draft:" + r.code + ":" + me.sub);
          if (cur && String(cur.text || "").trim()) return { text: String(cur.text), at: cur.at || 0, handedIn: false };
          return null;
        });
        if (q.code) {
          const room = yield getRoom(cleanCode(q.code));
          if (room.deletedAt || !room.reread) throw new HttpError(403, "not_shared");
          const t = yield textOf(room);
          if (!t) throw new HttpError(404, "no_writing");
          return respond(200, __spreadProps(__spreadValues({
            code: room.code,
            title: titleOf(room),
            teacherName: room.teacher.name || room.teacher.email
          }, t), {
            words: (t.text.trim().match(/\S+/g) || []).length
          }));
        }
        const em = lower(me.email);
        const { state: mine } = yield readItem("luddite:mine:" + em);
        const codes = /* @__PURE__ */ new Set([...mine && mine.handed || [], ...mine && mine.rooms || [], ...mine && mine.own || []]);
        const classes = yield Promise.all((mine && mine.classes || []).map((id) => readItem("luddite:class:" + id)));
        classes.forEach(({ state: c }) => {
          if (c && !c.deletedAt && c.emails.includes(em)) (c.assignments || []).forEach((code) => codes.add(code));
        });
        const rooms = yield Promise.all([...codes].slice(0, 400).map((c) => readItem("luddite:room:" + c)));
        const list = [];
        rooms.forEach(({ state: r }) => {
          const s = r && !r.deletedAt && r.reread && r.students[me.sub];
          if (!s || s.status !== "admitted" || !(s.handedIn || s.words)) return;
          list.push({
            code: r.code,
            title: titleOf(r),
            teacherName: r.teacher.name || r.teacher.email,
            handedIn: !!s.handedIn,
            at: Math.max(s.submittedAt || 0, s.draftAt || 0, r.startAt || 0, r.createdAt || 0)
          });
        });
        list.sort((a, b) => b.at - a.at);
        return respond(200, { papers: list });
      }
      if (path === "/luddite/returned" && method === "GET") {
        const { state: mine } = yield readItem("luddite:mine:" + lower(me.email));
        const items = yield Promise.all((mine && mine.returned || []).map((id) => myShared(id, me).catch(() => null)));
        const seen = {};
        const papers = items.filter((x) => x && x.returnedAt && x.sub === me.sub && !seen[x.id] && (seen[x.id] = 1)).map((x) => ({ id: x.id, roomTitle: x.roomTitle, at: x.at, words: x.words, returnedAt: x.returnedAt, gradeReady: viewedMs(x) >= GRADE_AFTER_MS })).sort((a, b) => b.returnedAt - a.returnedAt);
        return respond(200, { papers });
      }
      if (path === "/luddite/mypaper" && (method === "GET" || method === "PUT")) {
        let paper = yield myShared(String((method === "GET" ? q.id : body.id) || ""), me);
        if (!paper || !paper.returnedAt || paper.sub !== me.sub) throw new HttpError(404, "no_sub");
        if (method === "PUT") {
          const ep = paper.early ? "luddite:early:" + paper.code + ":" + paper.sub : null;
          const counted = yield mutate(ep || "luddite:sub:" + paper.id, (x) => {
            const now = Date.now(), v = x.view || { ms: 0, last: 0 };
            const gap = now - (v.last || 0);
            return __spreadProps(__spreadValues({}, x), { view: { ms: (v.ms || 0) + (gap > 0 && gap <= VIEW_PING_MAX_MS ? gap : 0), last: now } });
          });
          paper = __spreadProps(__spreadValues({}, paper), { view: counted.view });
        }
        return respond(200, { paper: studentPaper(paper) });
      }
      if (path === "/luddite/schedule" && method === "GET") {
        const em = lower(me.email);
        const { state: mine } = yield readItem("luddite:mine:" + em);
        const rooms = yield Promise.all((mine && mine.sched || []).map((c) => readItem("luddite:room:" + c)));
        const list = [];
        rooms.forEach(({ state: r }) => {
          const req = r && !r.deletedAt && r.schedReq && r.schedReq[em];
          if (!req) return;
          const cls = req.kind === "extra" && r.startAt && !r.sittings ? { start: r.startAt, end: r.startAt + (r.minutes || REF_MINUTES) * 6e4 } : null;
          list.push({
            code: r.code,
            title: titleOf(r),
            teacherName: r.teacher.name || r.teacher.email,
            kind: req.kind,
            pick: req.pick,
            from: req.from,
            to: req.to,
            at: req.at,
            answer: req.answer || null,
            classTime: cls
          });
        });
        list.sort((a, b) => b.at - a.at);
        return respond(200, { requests: list, now: Date.now() });
      }
      if (path === "/luddite/schedule" && method === "PUT") {
        const em = lower(me.email), code = cleanCode(body.code);
        const start = Math.floor(Number(body.start)), end = Math.floor(Number(body.end));
        const room = yield mutate("luddite:room:" + code, (r) => {
          const req = r && !r.deletedAt && r.schedReq && r.schedReq[em];
          if (!req) throw new HttpError(404, "no_request");
          const now = Date.now(), len = end - start, want = req.pick === "half" ? SCHED_PERIOD_MS / 2 : SCHED_PERIOD_MS;
          if (req.answer && req.answer.start <= now) throw new HttpError(409, "already_started");
          if (!(start > now && Math.abs(len - want) <= 6e4)) throw new HttpError(400, "bad_time");
          if (start < req.from || end > req.to) throw new HttpError(400, "out_of_range");
          const blocks = cleanBlocks(schedBlocks(r, req, start, end));
          return __spreadProps(__spreadValues({}, r), {
            schedReq: __spreadProps(__spreadValues({}, r.schedReq), { [em]: __spreadProps(__spreadValues({}, req), { answer: { start, end, at: now } }) }),
            own: __spreadProps(__spreadValues({}, r.own || {}), { [em]: { startAt: blocks[0].start, multiplier: 1, blocks, setAt: now, picked: true } })
          });
        });
        yield mutate("luddite:mine:" + em, (m) => {
          const own = m && m.own || [];
          return own.includes(code) ? void 0 : __spreadProps(__spreadValues({}, m || {}), { own: [code, ...own].slice(0, 60) });
        });
        yield noteProctoring(code);
        return respond(200, { answer: room.schedReq[em].answer });
      }
      if (path === "/luddite/reflections" && method === "GET") {
        const em = lower(me.email);
        const { state: mine } = yield readItem("luddite:mine:" + em);
        const codes = /* @__PURE__ */ new Set([...mine && mine.handed || [], ...mine && mine.rooms || [], ...mine && mine.own || []]);
        const classes = yield Promise.all((mine && mine.classes || []).map((id) => readItem("luddite:class:" + id)));
        classes.forEach(({ state: c }) => {
          if (c && !c.deletedAt && c.emails.includes(em)) (c.assignments || []).forEach((code) => codes.add(code));
        });
        const rooms = yield Promise.all([...codes].map((c) => readItem("luddite:room:" + c)));
        const list = [];
        rooms.forEach(({ state: r }) => {
          if (!r || r.deletedAt || !r.reflect) return;
          const s = r.students[me.sub];
          if (!reflectable(r, me.sub)) return;
          list.push({
            code: r.code,
            title: titleOf(r),
            teacherName: r.teacher.name || r.teacher.email,
            prompt: r.reflect.prompt || "",
            status: s.reflect && s.reflect.status || "new",
            lockedOut: !!(s.reflect && s.reflect.lockedOut),
            at: r.reflect.at || 0
          });
        });
        list.sort((a, b) => b.at - a.at);
        return respond(200, { reflections: list });
      }
      if (path === "/luddite/reflect" && method === "GET") {
        const room = yield getRoom(cleanCode(q.code));
        const sub = reflectable(room, me.sub);
        if (!sub) throw new HttpError(403, "no_reflection");
        const { state: paper } = yield readItem("luddite:sub:" + sub.id);
        if (!paper) throw new HttpError(404, "no_sub");
        return respond(200, reflectView(room, me.sub, paper));
      }
      if (path === "/luddite/reflect" && method === "PUT") {
        const code = cleanCode(body.code);
        const before = yield getRoom(code);
        const sub = reflectable(before, me.sub);
        if (!sub) throw new HttpError(403, "no_reflection");
        const type = String(body.type || "");
        const room = yield mutate("luddite:room:" + code, (r) => {
          const s = r.students[me.sub];
          const rf2 = __spreadValues({}, s.reflect || {});
          if (rf2.status === "done" && type !== "open") return void 0;
          rf2.lastSeen = Date.now();
          if (!rf2.status) {
            rf2.status = "reflecting";
            rf2.at = Date.now();
          }
          if (type === "left") Object.assign(rf2, { leaves: (rf2.leaves || 0) + 1, writing: false, lockedOut: !TEST_EMAILS.includes(lower(me.email)) });
          if (type === "ask" && rf2.lockedOut) rf2.askedAt = Date.now();
          if (type === "save" || type === "handin") rf2.writing = type === "save" && !!body.writing;
          if (Number.isFinite(body.words)) rf2.words = Math.max(0, Math.floor(body.words));
          if (type === "handin" && !rf2.lockedOut) Object.assign(rf2, { status: "done", handedInAt: Date.now(), writing: false });
          return __spreadProps(__spreadValues({}, r), { students: __spreadProps(__spreadValues({}, r.students), { [me.sub]: __spreadProps(__spreadValues({}, s), { reflect: rf2 }) }) });
        });
        const rf = room.students[me.sub].reflect || {};
        let paper = (yield readItem("luddite:sub:" + sub.id)).state;
        if (typeof body.text === "string" && (type === "save" || type === "handin") && !rf.lockedOut && (rf.status !== "done" || type === "handin")) {
          const text = body.text.slice(0, MAX_REFLECTION_CHARS);
          paper = yield mutate("luddite:sub:" + sub.id, (x) => {
            const prev = x.reflection || {};
            if (prev.handedInAt && rf.status === "done" && type !== "handin") return void 0;
            return __spreadProps(__spreadValues({}, x), { reflection: __spreadValues({ text, words: (text.trim().match(/\S+/g) || []).length, at: Date.now() }, rf.status === "done" ? { handedInAt: rf.handedInAt } : {}) });
          });
        }
        return respond(200, reflectView(room, me.sub, paper));
      }
      if (path === "/luddite/submit" && method === "PUT") {
        const code = cleanCode(body.code);
        const room = yield getRoom(code);
        const s = room.students[me.sub];
        if (!s || s.status !== "admitted") throw new HttpError(403, "not_admitted");
        if (s.handedIn && !s.autoHandedIn) throw new HttpError(409, "already_handed_in");
        const text = String(body.text || "");
        if (!text.trim()) throw new HttpError(400, "empty");
        if (text.length > MAX_SUBMISSION_CHARS) throw new HttpError(413, "too_long");
        const label = String(body.label || "").replace(/[\r\n\/\\]/g, " ").slice(0, 60) || (/* @__PURE__ */ new Date()).toISOString().slice(0, 16);
        const saved = yield handInFor(room, code, me, s, text, label, false);
        return respond(200, { room: studentView(saved, me.sub, me.email, yield prefsOf(saved.teacher.sub)) });
      }
      if (path === "/luddite/chat" && method === "GET") {
        const code = cleanCode(q.code);
        const room = yield getRoom(code);
        const asTeacher = !!q.sub && ownsRoom(room, info, role);
        const sub = asTeacher ? String(q.sub) : me.sub;
        const s = room.students[sub];
        if (!s || s.status !== "admitted") throw new HttpError(404, "not_in_room");
        const { state } = yield readItem("luddite:chat:" + code + ":" + sub);
        const msgs = state && state.msgs || [];
        const last = msgs.length ? msgs[msgs.length - 1].at : 0;
        const seenKey = asTeacher ? "seenT" : "seenS";
        if (last && (s[seenKey] || 0) < last || asTeacher && s.unreadT) {
          yield mutate("luddite:room:" + code, (r) => {
            const x = r && r.students[sub];
            if (!x || (x[seenKey] || 0) >= last && !(asTeacher && x.unreadT)) return void 0;
            const _a2 = x, { unreadT } = _a2, rest = __objRest(_a2, ["unreadT"]);
            return __spreadProps(__spreadValues({}, r), { students: __spreadProps(__spreadValues({}, r.students), { [sub]: __spreadProps(__spreadValues({}, asTeacher ? rest : x), { [seenKey]: Math.max(x[seenKey] || 0, last) }) }) });
          });
        }
        return respond(200, { msgs });
      }
      if (path === "/luddite/chat/unread" && method === "PUT") {
        const code = cleanCode(body.code);
        const room = yield getRoom(code);
        if (!ownsRoom(room, info, role)) throw new HttpError(403, "not_your_room");
        const sub = String(body.sub || "");
        if (!room.students[sub]) throw new HttpError(404, "not_in_room");
        yield mutate("luddite:room:" + code, (r) => r && r.students[sub] ? __spreadProps(__spreadValues({}, r), { students: __spreadProps(__spreadValues({}, r.students), { [sub]: __spreadProps(__spreadValues({}, r.students[sub]), { unreadT: Date.now() }) }) }) : void 0);
        return respond(200, { ok: true });
      }
      if (path === "/luddite/chat" && method === "PUT") {
        const code = cleanCode(body.code);
        const text = String(body.text || "").trim().slice(0, MAX_CHAT_CHARS);
        if (!text) throw new HttpError(400, "empty");
        const room = yield getRoom(code);
        const asTeacher = !!body.to && ownsRoom(room, info, role);
        const admitted = (sub) => !!(room.students[sub] && room.students[sub].status === "admitted");
        const subs = !asTeacher ? [me.sub] : body.to === "all" ? Object.keys(room.students).filter(admitted) : [String(body.to)];
        if (!subs.length || !subs.every(admitted)) throw new HttpError(404, "not_in_room");
        const at = Date.now();
        const hand = !asTeacher && body.hand === true;
        const msg = __spreadValues(__spreadValues({ from: asTeacher ? "teacher" : "student", text, at }, asTeacher && body.to === "all" ? { all: true } : {}), hand ? { hand: true } : {});
        yield inBatches(subs, (sub) => mutate("luddite:chat:" + code + ":" + sub, (c) => ({ code, sub, msgs: [...c && c.msgs || [], msg].slice(-MAX_CHAT_MSGS) })));
        const sideKey = asTeacher ? "chatT" : "chatS", seenKey = asTeacher ? "seenT" : "seenS";
        yield mutate("luddite:room:" + code, (r) => {
          if (!r) return void 0;
          const students = __spreadValues({}, r.students);
          subs.forEach((sub) => {
            if (students[sub]) students[sub] = __spreadValues(__spreadProps(__spreadValues({}, students[sub]), { [sideKey]: at, [seenKey]: at }), hand ? { handAt: at } : {});
          });
          return __spreadProps(__spreadValues({}, r), { students });
        });
        return respond(200, { msg, to: subs.length });
      }
      if (path === "/luddite/rubricfile" && method === "GET") {
        const id = String(q.id || "");
        if (!/^[a-f0-9]{24}$/.test(id)) throw new HttpError(400, "bad_file");
        const { state: meta } = yield readItem("luddite:rubricfile:" + id);
        if (!meta) throw new HttpError(404, "no_file");
        if (meta.owner !== me.sub) {
          const room = q.code ? yield getRoom(cleanCode(q.code)) : null;
          const st = room && room.students && room.students[me.sub];
          const ok = room && room.rubric && room.rubric.fileId === id && (isTeacher && ownsRoom(room, info, role) || room.rubricShown && st && st.status === "admitted");
          if (!ok) throw new HttpError(403, "not_yours");
        }
        const parts = yield Promise.all(Array.from({ length: meta.n }, (_, i) => readItem("luddite:rubricfile:" + id + ":" + i)));
        return respond(200, { data: parts.map((x) => x.state && x.state.data || "").join("") });
      }
      if (!isTeacher) return respond(403, { error: "teachers_only" });
      if (path === "/luddite/rubrics" && method === "PUT") {
        const rubrics = (Array.isArray(body.rubrics) ? body.rubrics : []).slice(0, 30).map(cleanRubric).filter(Boolean);
        yield mutate("luddite:teacher:" + me.sub, (t) => __spreadProps(__spreadValues({}, t || { rooms: [] }), { rubrics }));
        return respond(200, { rubrics });
      }
      if (path === "/luddite/rubricfile" && method === "PUT") {
        const data = String(body.data || "").replace(/\s+/g, "");
        if (!/^[A-Za-z0-9+/]+=*$/.test(data)) throw new HttpError(400, "bad_file");
        const bytes = Buffer2.from(data, "base64");
        if (bytes.length > MAX_RUBRIC_PDF_BYTES) throw new HttpError(413, "too_big");
        if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new HttpError(400, "not_pdf");
        const fileId = randomBytes(12).toString("hex");
        const n = Math.ceil(data.length / RUBRIC_CHUNK_CHARS);
        for (let i = 0; i < n; i++) yield mutate("luddite:rubricfile:" + fileId + ":" + i, () => ({ data: data.slice(i * RUBRIC_CHUNK_CHARS, (i + 1) * RUBRIC_CHUNK_CHARS) }));
        yield mutate("luddite:rubricfile:" + fileId, () => ({ owner: me.sub, ownerEmail: lower(me.email), n, size: bytes.length, at: Date.now() }));
        return respond(200, { fileId });
      }
      if (path === "/luddite/classes/order" && method === "PUT") {
        const want = (Array.isArray(body.ids) ? body.ids : []).map(String);
        const saved = yield mutate("luddite:teacher:" + me.sub, (t) => {
          const have = classIdsOf(t);
          const ids = [...want.filter((id) => have.includes(id)), ...have.filter((id) => !want.includes(id))];
          return __spreadProps(__spreadValues({}, t || { rooms: [] }), { classes: ids, classesOrdered: true });
        });
        return respond(200, { classes: yield classesOf(saved) });
      }
      if (path === "/luddite/assignments" && method === "GET") {
        const { state } = yield readItem("luddite:teacher:" + me.sub);
        const codes = state && state.rooms || [];
        const rooms = (yield Promise.all(codes.map((c) => readItem("luddite:room:" + c)))).map((r) => r.state).filter((r) => r && !r.deletedAt);
        return respond(200, {
          assignments: rooms.map(roomSummary),
          classes: yield classesOf(state),
          prefs: cleanPrefs(state && state.prefs),
          extraTime: cleanExtraTime(state && state.extraTime),
          rubrics: state && state.rubrics || [],
          drive: yield driveStatus(me.sub),
          displayName: state && state.displayName || (role === "owner" ? OWNER_DISPLAY_NAME : me.name || me.email)
        });
      }
      if (path === "/luddite/extratime" && method === "PUT") {
        const em = lower(body.email);
        if (!EMAIL_RE.test(em)) throw new HttpError(400, "bad_email");
        const m = Math.round(Number(body.multiplier) * 4) / 4;
        const saved = yield mutate("luddite:teacher:" + me.sub, (t) => {
          const x = __spreadValues({}, cleanExtraTime(t && t.extraTime));
          if (m > 1 && m <= 4) x[em] = m;
          else delete x[em];
          return __spreadProps(__spreadValues({}, t || { rooms: [] }), { extraTime: x });
        });
        return respond(200, { extraTime: cleanExtraTime(saved.extraTime) });
      }
      if (path === "/luddite/prefs" && method === "PUT") {
        const prefs = cleanPrefs(body);
        yield mutate("luddite:teacher:" + me.sub, (t) => __spreadProps(__spreadValues({}, t || { rooms: [] }), { prefs }));
        return respond(200, { prefs });
      }
      if (path === "/luddite/classes" && method === "GET") {
        const { state } = yield readItem("luddite:teacher:" + me.sub);
        return respond(200, { classes: yield classesOf(state) });
      }
      if (path === "/luddite/classes" && method === "PUT") {
        const name = String(body.name || "").trim().slice(0, 80);
        if (!name) throw new HttpError(400, "need_name");
        let emails;
        if (body.fromTeachers) {
          if (role !== "owner") throw new HttpError(403, "owners_only");
          const { state } = yield readItem("luddite:teachers");
          emails = cleanEmails([...OWNER_EMAILS, ...Object.keys(state && state.emails || {})]);
        } else {
          emails = cleanEmails(body.emails);
        }
        if (emails.length > MAX_CLASS_EMAILS) throw new HttpError(413, "too_many_emails");
        const id = randomBytes(6).toString("hex");
        const teacher = __spreadProps(__spreadValues({}, me), { name: yield displayNameOf(info, role) });
        const made = yield mutate("luddite:class:" + id, () => ({ id, name, teacher, emails, assignments: [], createdAt: Date.now(), period: cleanPeriod(body.period), grade: cleanGradeLevel(body.grade), color: cleanColor(body.color) }));
        yield mutate("luddite:teacher:" + me.sub, (t) => __spreadProps(__spreadValues({}, t || { rooms: [] }), { classes: [...classIdsOf(t), id], classesOrdered: true }));
        yield indexClass(id, emails, []);
        return respond(200, { class: made });
      }
      if (path === "/luddite/class" && method === "GET") {
        return respond(200, { class: yield getClass(q.id, me, role) });
      }
      if (path === "/luddite/class" && method === "PUT") {
        const cls = yield getClass(body.id, me, role);
        const emails = cleanEmails(body.emails);
        let added = [], removed = [];
        const saved = yield mutate("luddite:class:" + cls.id, (c) => {
          if (!c || c.deletedAt) throw new HttpError(404, "no_class");
          if (body.action === "rename") {
            const name = String(body.name || "").trim().slice(0, 80);
            if (!name) throw new HttpError(400, "need_name");
            return __spreadProps(__spreadValues({}, c), { name });
          }
          if (body.action === "period") return __spreadProps(__spreadValues({}, c), { period: cleanPeriod(body.period) });
          if (body.action === "gradeLevel") return __spreadProps(__spreadValues({}, c), { grade: cleanGradeLevel(body.grade) });
          if (body.action === "color") return __spreadProps(__spreadValues({}, c), { color: cleanColor(body.color) });
          if (body.action === "add") {
            added = emails.filter((e) => !c.emails.includes(e));
            if (c.emails.length + added.length > MAX_CLASS_EMAILS) throw new HttpError(413, "too_many_emails");
            return added.length ? __spreadProps(__spreadValues({}, c), { emails: [...c.emails, ...added] }) : void 0;
          }
          if (body.action === "remove") {
            removed = emails.filter((e) => c.emails.includes(e));
            return removed.length ? __spreadProps(__spreadValues({}, c), { emails: c.emails.filter((e) => !removed.includes(e)) }) : void 0;
          }
          if (body.action === "delete") {
            removed = c.emails.slice();
            return __spreadProps(__spreadValues({}, c), { emails: [], deletedAt: Date.now() });
          }
          throw new HttpError(400, "bad_action");
        });
        yield indexClass(cls.id, added, removed);
        if (body.action === "delete") {
          yield mutate("luddite:teacher:" + cls.teacher.sub, (t) => __spreadProps(__spreadValues({}, t || {}), { classes: (t && t.classes || []).filter((c) => c !== cls.id) }));
        }
        return respond(200, { class: saved });
      }
      if (path === "/luddite/watch" && method === "GET") {
        const room = yield getRoom(cleanCode(q.code));
        if (!ownsRoom(room, info, role)) throw new HttpError(403, "not_your_room");
        const subs = Object.keys(room.students || {}).filter((sub) => room.students[sub].status === "admitted");
        const got = yield Promise.all(subs.map((sub) => readItem("luddite:draft:" + room.code + ":" + sub)));
        const drafts = {};
        subs.forEach((sub, i) => {
          const d = got[i].state;
          drafts[sub] = d ? { text: d.text, at: d.at } : null;
        });
        return respond(200, { drafts });
      }
      if (path === "/luddite/wlog" && method === "GET") {
        const room = yield getRoom(cleanCode(q.code));
        if (!ownsRoom(room, info, role)) throw new HttpError(403, "not_your_room");
        const sub = String(q.sub || ""), st = room.students[sub];
        if (!st) throw new HttpError(404, "no_student");
        const { state: log } = yield readItem("luddite:wlog:" + room.code + ":" + sub);
        const { state: dr } = yield readItem("luddite:draft:" + room.code + ":" + sub);
        const prevCopy = dr && dr.prev && dr.prev.text ? { at: dr.prev.at, words: (dr.prev.text.trim().match(/\S+/g) || []).length } : null;
        return respond(200, { prev: prevCopy, log: log ? { mins: log.mins || [], bursts: log.bursts || [], restores: log.restores || [], first: log.first || 0, snaps: log.snaps || [] } : null, name: st.name || "", email: st.email || "" });
      }
      if (path === "/luddite/restore" && method === "PUT") {
        const room = yield getRoom(cleanCode(body.code));
        if (!ownsRoom(room, info, role)) throw new HttpError(403, "not_your_room");
        const sub = String(body.sub || "");
        if (!room.students[sub]) throw new HttpError(404, "no_student");
        const key = "luddite:draft:" + room.code + ":" + sub;
        const { state: dr } = yield readItem(key);
        let text;
        if (body.k === "prev") text = dr && dr.prev && dr.prev.text;
        else {
          const { state: snap } = yield readItem("luddite:snap:" + room.code + ":" + sub + ":" + Math.floor(Number(body.k) || 0));
          text = snap && snap.text;
        }
        if (typeof text !== "string" || !text.trim()) throw new HttpError(404, "no_snap");
        if (dr && dr.text && dr.text !== text) yield keepVersion(room.code, sub, dr.text, { note: "before restoring" });
        const at = Date.now();
        yield mutate(key, (d) => __spreadProps(__spreadValues({}, d || {}), { code: room.code, sub, text, at, restored: true }));
        yield keepVersion(room.code, sub, text, { note: "restored" });
        const words = (text.trim().match(/\S+/g) || []).length;
        yield mutate("luddite:room:" + room.code, (r) => r && r.students[sub] ? __spreadProps(__spreadValues({}, r), { students: __spreadProps(__spreadValues({}, r.students), { [sub]: __spreadProps(__spreadValues({}, r.students[sub]), { words }) }) }) : void 0).catch(() => {
        });
        return respond(200, { ok: true, at, words });
      }
      if (path === "/luddite/snap" && method === "GET") {
        const room = yield getRoom(cleanCode(q.code));
        if (!ownsRoom(room, info, role)) throw new HttpError(403, "not_your_room");
        const sub = String(q.sub || "");
        if (!room.students[sub]) throw new HttpError(404, "no_student");
        if (q.k === "prev") {
          const { state: dr } = yield readItem("luddite:draft:" + room.code + ":" + sub);
          if (!dr || !dr.prev || !dr.prev.text) throw new HttpError(404, "no_snap");
          return respond(200, { snap: { k: "prev", at: dr.prev.at, words: (dr.prev.text.trim().match(/\S+/g) || []).length, text: dr.prev.text } });
        }
        const { state: snap } = yield readItem("luddite:snap:" + room.code + ":" + sub + ":" + Math.floor(Number(q.k) || 0));
        if (!snap) throw new HttpError(404, "no_snap");
        return respond(200, { snap: { k: snap.k, at: snap.at, words: snap.words, text: snap.text || "", burst: !!snap.burst } });
      }
      if (path === "/luddite/early" && method === "GET") {
        const room = yield getRoom(cleanCode(q.code));
        if (!ownsRoom(room, info, role)) throw new HttpError(403, "not_your_room");
        const sub = String(q.sub || ""), st = room.students[sub];
        if (!st) throw new HttpError(404, "no_student");
        const { state: d } = yield readItem("luddite:draft:" + room.code + ":" + sub);
        const { state: e } = yield readItem("luddite:early:" + room.code + ":" + sub);
        const text = d ? String(d.text || "") : "";
        const live = e && !e.usedAt ? e : null;
        return respond(200, {
          piece: {
            id: "early:" + room.code + ":" + sub,
            early: true,
            code: room.code,
            sub,
            name: st.name,
            email: st.email,
            roomTitle: titleOf(room),
            text,
            words: (text.trim().match(/\S+/g) || []).length,
            at: d ? d.at : Date.now(),
            marks: live ? reanchorMarks(live.marks, live.base, text) : [],
            endComment: live ? live.endComment || "" : "",
            grade: live ? live.grade || "" : "",
            rubric: live ? live.rubric || null : null,
            rubricScores: live ? live.rubricScores || [] : [],
            returnedAt: live ? live.returnedAt || null : null,
            view: live ? live.view || null : null
          },
          roomRubric: room.rubric || null
        });
      }
      if (path === "/luddite/early" && method === "PUT") {
        const room = yield getRoom(cleanCode(body.code));
        if (!ownsRoom(room, info, role)) throw new HttpError(403, "not_your_room");
        const sub = String(body.sub || "");
        if (!room.students[sub]) throw new HttpError(404, "no_student");
        const base = String(body.text || "").slice(0, MAX_STORED_CHARS);
        const marks = cleanMarks(body.marks, base.length);
        const rubric = body.rubric ? cleanRubric(body.rubric) : null;
        const saved = {
          base,
          marks,
          endComment: String(body.endComment || "").slice(0, 8e3),
          grade: String(body.grade || "").replace(/\s+/g, " ").trim().slice(0, 40),
          rubric,
          rubricScores: cleanScores(body.rubricScores || [], rubric),
          at: Date.now()
        };
        if (Buffer2.byteLength(JSON.stringify(saved)) > MAX_ITEM_BYTES) throw new HttpError(413, "too_many_marks");
        yield mutate("luddite:early:" + room.code + ":" + sub, (x) => __spreadValues(__spreadValues({}, saved), x && !x.usedAt ? { returnedAt: x.returnedAt || null, view: x.view } : {}));
        const earlyMarked = marks.length + (saved.endComment.trim() ? 1 : 0);
        yield mutate("luddite:room:" + room.code, (r) => r && r.students[sub] && (r.students[sub].earlyMarked !== earlyMarked || (r.students[sub].earlyGrade || "") !== saved.grade) ? __spreadProps(__spreadValues({}, r), { students: __spreadProps(__spreadValues({}, r.students), { [sub]: __spreadProps(__spreadValues({}, r.students[sub]), { earlyMarked, earlyGrade: saved.grade }) }) }) : void 0).catch(() => {
        });
        return respond(200, { ok: true });
      }
      if (path === "/luddite/sub" && method === "GET") {
        let piece = yield ownSub(q.id, me, role);
        const { state: room } = yield readItem("luddite:room:" + piece.code);
        const { state: early } = yield readItem("luddite:early:" + piece.code + ":" + piece.sub);
        const olds = piece.gathered ? [] : yield Promise.all((piece.replaces || []).slice(0, 10).map((id) => readItem("luddite:sub:" + id).then((x) => x.state).catch(() => null)));
        const sources = [
          ...olds.filter((x) => x && Array.isArray(x.marks) && (x.marks.length || (x.endComment || "").trim() || x.grade)),
          ...early && !early.usedAt ? [{ text: early.base, marks: early.marks, endComment: early.endComment, grade: early.grade, returnedAt: early.returnedAt }] : []
        ];
        if (sources.length || !piece.gathered && (piece.replaces || []).length) {
          piece = yield mutate("luddite:sub:" + piece.id, (x) => {
            let next = __spreadProps(__spreadValues({}, x), { gathered: true });
            for (const src of sources) {
              next.marks = mergeMarks(next.marks, reanchorMarks(src.marks || [], String(src.text || ""), next.text));
              const ec = (src.endComment || "").trim();
              if (ec && !(next.endComment || "").includes(ec)) next.endComment = next.endComment ? next.endComment + "\n\n" + src.endComment : src.endComment;
              if (!next.grade && src.grade) next.grade = src.grade;
              if (!next.returnedAt && src.returnedAt) next.returnedAt = src.returnedAt;
            }
            return next;
          });
          if (early && !early.usedAt) yield mutate("luddite:early:" + piece.code + ":" + piece.sub, (x) => x ? __spreadProps(__spreadValues({}, x), { usedAt: Date.now(), paperId: piece.id }) : void 0);
          const count = (piece.marks || []).length + ((piece.endComment || "").trim() ? 1 : 0);
          yield mutate("luddite:room:" + piece.code, (r) => {
            if (!r) return void 0;
            const i = (r.submissions || []).findIndex((x) => x.id === piece.id);
            if (i === -1) return void 0;
            const submissions = r.submissions.slice();
            submissions[i] = __spreadValues(__spreadProps(__spreadValues({}, submissions[i]), { marked: count, grade: piece.grade || "" }), piece.returnedAt ? { returnedAt: piece.returnedAt } : {});
            return __spreadProps(__spreadValues({}, r), { submissions });
          }).catch(() => {
          });
          if (piece.returnedAt && early && early.returnedAt) yield sharedNowPaper(piece.email, "early:" + piece.code + ":" + piece.sub, piece.id);
        }
        const st = room && room.students && room.students[piece.sub];
        if (st && st.status === "admitted" && !st.handedIn) {
          const { state: d } = yield readItem("luddite:draft:" + piece.code + ":" + piece.sub);
          if (d && typeof d.text === "string" && d.text !== piece.text && (d.at || 0) > (piece.at || 0)) {
            piece = __spreadProps(__spreadValues({}, piece), { text: d.text, words: (d.text.trim().match(/\S+/g) || []).length, marks: reanchorMarks(piece.marks, piece.text, d.text), live: true });
          }
        }
        return respond(200, { sub: piece, roomRubric: room && room.rubric || null });
      }
      if (path === "/luddite/marks" && method === "PUT") {
        const piece = yield ownSub(body.id, me, role);
        let text = piece.text, marks;
        if (typeof body.text === "string" && body.text !== piece.text) {
          const { state: d } = yield readItem("luddite:draft:" + piece.code + ":" + piece.sub);
          if (!d || typeof d.text !== "string") throw new HttpError(409, "text_changed");
          text = d.text;
          marks = cleanMarks(reanchorMarks(cleanMarks(body.marks, body.text.length), body.text, text), text.length);
        } else marks = cleanMarks(body.marks, piece.text.length);
        const endComment = String(body.endComment || "").slice(0, 8e3);
        const grade = String(body.grade || "").replace(/\s+/g, " ").trim().slice(0, 40);
        const rubric = body.rubric === void 0 ? piece.rubric || null : cleanRubric(body.rubric);
        const rubricScores = cleanScores(body.rubricScores === void 0 ? piece.rubricScores : body.rubricScores, rubric);
        const saved = yield mutate("luddite:sub:" + piece.id, (x) => {
          const next = __spreadProps(__spreadValues({}, x), { text, words: (text.trim().match(/\S+/g) || []).length, marks, endComment, grade, rubric, rubricScores, markedAt: Date.now() });
          if (Buffer2.byteLength(JSON.stringify(next)) > MAX_ITEM_BYTES) throw new HttpError(413, "too_many_marks");
          return next;
        });
        yield mutate("luddite:early:" + piece.code + ":" + piece.sub, (x) => x && !x.usedAt ? __spreadProps(__spreadValues({}, x), { usedAt: Date.now(), paperId: piece.id }) : void 0).catch(() => {
        });
        yield updateDriveDoc(piece.teacherSub, saved).catch((e) => console.warn("drive markup failed", e.detail || e.message));
        const count = marks.length + (endComment.trim() ? 1 : 0);
        yield mutate("luddite:room:" + piece.code, (r) => {
          if (!r) return void 0;
          const i = (r.submissions || []).findIndex((x) => x.id === piece.id);
          if (i === -1 || r.submissions[i].marked === count && (r.submissions[i].grade || "") === grade) return void 0;
          const submissions = r.submissions.slice();
          submissions[i] = __spreadProps(__spreadValues({}, submissions[i]), { marked: count, grade });
          return __spreadProps(__spreadValues({}, r), { submissions });
        }).catch(() => {
        });
        return respond(200, { ok: true, markedAt: saved.markedAt });
      }
      if (path === "/luddite/handback" && method === "PUT") {
        const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, 200);
        const back = body.back !== false;
        const done = [];
        yield inBatches(ids, (id) => __async(null, null, function* () {
          const ep = /^early:([^:]+):(.+)$/.exec(String(id || ""));
          if (ep) {
            const room = yield getRoom(cleanCode(ep[1]));
            if (!ownsRoom(room, info, role)) throw new HttpError(403, "not_your_room");
            const sub = ep[2], st = room.students[sub];
            if (!st) throw new HttpError(404, "no_student");
            const at2 = back ? Date.now() : null;
            const { state: d } = yield readItem("luddite:draft:" + room.code + ":" + sub);
            yield mutate("luddite:early:" + room.code + ":" + sub, (x) => x && !x.usedAt ? __spreadProps(__spreadValues({}, x), { returnedAt: at2 }) : { base: d ? String(d.text || "") : "", marks: [], endComment: "", grade: "", rubric: null, rubricScores: [], at: Date.now(), returnedAt: at2 });
            yield mutate("luddite:mine:" + lower(st.email), (m) => {
              const list = (m && m.returned || []).filter((x) => x !== id);
              return __spreadProps(__spreadValues({}, m || {}), { returned: back ? [id, ...list].slice(0, 200) : list });
            });
            yield mutate("luddite:room:" + room.code, (r) => r && r.students[sub] ? __spreadProps(__spreadValues({}, r), { students: __spreadProps(__spreadValues({}, r.students), { [sub]: __spreadProps(__spreadValues({}, r.students[sub]), { earlyShared: at2 }) }) }) : void 0);
            done.push({ id, returnedAt: at2 });
            return;
          }
          const piece = yield ownSub(id, me, role);
          const at = back ? Date.now() : null;
          yield mutate("luddite:sub:" + piece.id, (x) => __spreadProps(__spreadValues({}, x), { returnedAt: at }));
          yield mutate("luddite:mine:" + lower(piece.email), (m) => {
            const list = (m && m.returned || []).filter((x) => x !== piece.id);
            return __spreadProps(__spreadValues({}, m || {}), { returned: back ? [piece.id, ...list].slice(0, 200) : list });
          });
          yield mutate("luddite:room:" + piece.code, (r) => {
            if (!r) return void 0;
            const i = (r.submissions || []).findIndex((x) => x.id === piece.id);
            if (i === -1) return void 0;
            const submissions = r.submissions.slice();
            submissions[i] = __spreadProps(__spreadValues({}, submissions[i]), { returnedAt: at });
            return __spreadProps(__spreadValues({}, r), { submissions });
          }).catch(() => {
          });
          done.push({ id: piece.id, returnedAt: at });
        }));
        return respond(200, { done });
      }
      if (path === "/luddite/students" && method === "GET") {
        const { state } = yield readItem("luddite:teacher:" + me.sub);
        const students = Object.entries(state && state.students || {}).map(([email, x]) => ({ email, name: x.name, last: x.last, count: x.count })).sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
        return respond(200, { students });
      }
      if (path === "/luddite/student" && method === "GET") {
        const email = String(q.email || "").toLowerCase();
        const { state } = yield readItem("luddite:tstudent:" + me.sub + ":" + email);
        if (!state) throw new HttpError(404, "no_student");
        const pieces = [];
        for (let i = 0; i < state.subs.length; i += 10) {
          const batch = yield Promise.all(state.subs.slice(i, i + 10).map((x) => readItem("luddite:sub:" + x.id)));
          batch.forEach(({ state: p }, j) => {
            const x = state.subs[i + j];
            if (!p) return pieces.push(__spreadProps(__spreadValues({}, x), { missing: true, marks: [], endComment: "" }));
            const quote = (a, b) => {
              const t = p.text.slice(a, b).replace(/\s+/g, " ").trim();
              return t.length > 240 ? t.slice(0, 237) + "\u2026" : t;
            };
            pieces.push({
              id: p.id,
              at: p.at,
              roomTitle: p.roomTitle,
              label: p.label,
              words: p.words,
              link: p.link,
              endComment: p.endComment || "",
              grade: p.grade || "",
              marks: (p.marks || []).slice().sort((a, b) => a.start - b.start).map((m) => ({
                type: m.type,
                note: m.note || "",
                quote: m.type === "arrow" ? arrowQuote(p.text, m) : m.type === "insert" ? quote(Math.max(0, m.start - 40), m.start) : quote(m.start, m.end)
              }))
            });
          });
        }
        return respond(200, { student: { email: state.email, name: state.name }, pieces });
      }
      if (path === "/luddite/me" && method === "PUT") {
        const displayName = String(body.displayName || "").trim().slice(0, 60);
        if (!displayName) throw new HttpError(400, "empty");
        yield mutate("luddite:teacher:" + me.sub, (t) => __spreadProps(__spreadValues({}, t || { rooms: [] }), { displayName }));
        return respond(200, { displayName });
      }
      if (path === "/luddite/assignments" && method === "PUT") {
        const teacher = __spreadProps(__spreadValues({}, me), { name: yield displayNameOf(info, role) });
        const casual = !!body.casual;
        const title = String(body.title || "").trim().slice(0, 80);
        if (!title && !casual) throw new HttpError(400, "need_title");
        const prompt = String(body.prompt || "").trim().slice(0, MAX_PROMPT_CHARS);
        const sittings = casual || body.atHome ? null : cleanSittings(body.sittings);
        const startAt = sittings ? sittings[0].start : Number(body.startAt) > 0 ? Math.floor(Number(body.startAt)) : Date.now();
        const emails = casual ? [] : cleanEmails(body.emails);
        if (emails.length > MAX_CLASS_EMAILS) throw new HttpError(413, "too_many_emails");
        const cls = body.classId && !casual && !emails.length ? yield getClass(body.classId, me, role) : null;
        let room = null;
        for (let i = 0; i < 12 && !room; i++) {
          const { code, codeLabel } = newRoomCode();
          try {
            room = yield mutate("luddite:room:" + code, (r) => {
              if (r) throw new HttpError(409, "code_taken");
              return { code, codeLabel, title: title || codeLabel, titled: !!title, atHome: !casual && !!body.atHome, teacher, classId: cls ? cls.id : null, emails: emails.length ? emails : void 0, startAt, sittings: sittings || void 0, prompt, casual, open: true, createdAt: Date.now(), students: {}, submissions: [] };
            });
          } catch (e) {
            if (e.message !== "code_taken") throw e;
          }
        }
        if (!room) throw new HttpError(503, "busy");
        yield mutate("luddite:teacher:" + me.sub, (t) => __spreadProps(__spreadValues({}, t || {}), { rooms: [room.code, ...t && t.rooms || []] }));
        if (cls) {
          yield mutate("luddite:class:" + cls.id, (c) => __spreadProps(__spreadValues({}, c), { assignments: [room.code, ...c.assignments || []].slice(0, MAX_CLASS_ASSIGNMENTS) }));
        }
        yield inBatches(emails, (email) => mutate("luddite:mine:" + email, (m) => {
          const rooms = m && m.rooms || [];
          return __spreadProps(__spreadValues({}, m || {}), { rooms: [room.code, ...rooms.filter((c) => c !== room.code)].slice(0, 60) });
        }));
        return respond(200, { room });
      }
      if (path === "/luddite/assignment" && method === "PUT") {
        const code = cleanCode(body.code);
        const subs = Array.isArray(body.subs) ? body.subs : [];
        const ownEmail = lower(body.email);
        const room = yield mutate("luddite:room:" + code, (r) => {
          if (!r) throw new HttpError(404, "no_room");
          if (!ownsRoom(r, info, role)) throw new HttpError(403, "not_your_room");
          const students = __spreadValues({}, r.students);
          const set = (sub, status) => {
            if (students[sub]) students[sub] = __spreadProps(__spreadValues({}, students[sub]), { status, decidedAt: Date.now() });
          };
          if (body.action === "admit") subs.forEach((sub) => set(sub, "admitted"));
          else if (body.action === "admitAll") Object.keys(students).forEach((sub) => {
            if (students[sub].status === "waiting") set(sub, "admitted");
          });
          else if (body.action === "remove") subs.forEach((sub) => set(sub, "removed"));
          else if (body.action === "unlock") subs.forEach((sub) => {
            if (students[sub]) students[sub] = __spreadProps(__spreadValues({}, students[sub]), { lockedOut: false, askedAt: 0, unlockedAt: Date.now() });
          });
          else if (body.action === "release") subs.forEach((sub) => {
            if (students[sub]) students[sub] = __spreadProps(__spreadValues({}, students[sub]), { handedIn: false, askedAt: 0, releasedAt: Date.now() });
          });
          else if (body.action === "close") return __spreadProps(__spreadValues({}, r), { open: false, endedAt: Date.now() });
          else if (body.action === "handIn") return void 0;
          else if (body.action === "startNow") return startedNow(r, Date.now());
          else if (body.action === "open") return __spreadProps(__spreadValues({}, r), { open: true, endedAt: null, startAt: Date.now(), pausedAt: 0, pausedMs: 0, sittings: void 0 });
          else if (body.action === "pause" || body.action === "resume") subs.forEach((sub) => {
            if (students[sub]) students[sub] = paused(students[sub], body.action === "pause", Date.now());
          });
          else if (body.action === "pauseAll" || body.action === "resumeAll") return paused(r, body.action === "pauseAll", Date.now());
          else if (body.action === "addProctor") {
            if (!EMAIL_RE.test(ownEmail)) throw new HttpError(400, "bad_email");
            const list = r.proctors || [];
            if (list.includes(ownEmail)) return void 0;
            if (list.length >= MAX_PROCTORS) throw new HttpError(413, "too_many_proctors");
            return __spreadProps(__spreadValues({}, r), { proctors: [...list, ownEmail] });
          } else if (body.action === "removeProctor") return __spreadProps(__spreadValues({}, r), { proctors: (r.proctors || []).filter((e) => e !== ownEmail) });
          else if (body.action === "schedule") {
            const startAt = Math.floor(Number(body.startAt));
            if (!(startAt > 0)) throw new HttpError(400, "bad_time");
            if (r.sittings) {
              const by = startAt - r.sittings[0].start;
              return __spreadProps(__spreadValues({}, r), { open: true, endedAt: null, startAt, sittings: r.sittings.map((x) => ({ start: x.start + by, end: x.end + by })) });
            }
            return __spreadProps(__spreadValues({}, r), { open: true, endedAt: null, startAt });
          } else if (body.action === "rubric") return __spreadProps(__spreadValues({}, r), { rubric: body.rubric ? cleanRubric(body.rubric) : null });
          else if (body.action === "rubricShown") return __spreadProps(__spreadValues({}, r), { rubricShown: !!body.on });
          else if (body.action === "shareWork") return __spreadProps(__spreadValues({}, r), { shareWork: !!body.on });
          else if (body.action === "homePrint") return __spreadProps(__spreadValues({}, r), { homePrint: !!body.on });
          else if (body.action === "reread") return __spreadProps(__spreadValues({}, r), { reread: !!body.on });
          else if (body.action === "anonNames") return __spreadProps(__spreadValues({}, r), { anonNames: !!body.on });
          else if (body.action === "atHome") {
            const on = !!body.on;
            const students2 = __spreadValues({}, r.students);
            if (on) Object.keys(students2).forEach((sub) => {
              if (students2[sub].lockedOut) students2[sub] = __spreadProps(__spreadValues({}, students2[sub]), { lockedOut: false, askedAt: 0, unlockedAt: Date.now() });
            });
            return __spreadProps(__spreadValues({}, r), { atHome: on, students: students2 });
          } else if (body.action === "prompt") return __spreadProps(__spreadValues({}, r), { prompt: String(body.prompt || "").trim().slice(0, MAX_PROMPT_CHARS) });
          else if (body.action === "reflect") return __spreadProps(__spreadValues({}, r), { reflect: { prompt: String(body.prompt || "").trim().slice(0, MAX_PROMPT_CHARS), showGrading: !!body.showGrading, at: r.reflect && r.reflect.at || Date.now() } });
          else if (body.action === "reflectOff") return __spreadProps(__spreadValues({}, r), { reflect: null });
          else if (body.action === "reflectUnlock" || body.action === "reflectReopen") {
            const students2 = __spreadValues({}, r.students);
            subs.forEach((sub) => {
              const s = students2[sub];
              if (!s || !s.reflect) return;
              students2[sub] = __spreadProps(__spreadValues({}, s), { reflect: body.action === "reflectUnlock" ? __spreadProps(__spreadValues({}, s.reflect), { lockedOut: false, askedAt: 0 }) : __spreadProps(__spreadValues({}, s.reflect), { status: "reflecting", handedInAt: 0, lockedOut: false }) });
            });
            return __spreadProps(__spreadValues({}, r), { students: students2 });
          } else if (body.action === "rename") {
            const title = String(body.title || "").trim().slice(0, 80);
            if (!title) throw new HttpError(400, "need_title");
            return __spreadProps(__spreadValues({}, r), { title, titled: true });
          } else if (body.action === "own") {
            if (!EMAIL_RE.test(ownEmail)) throw new HttpError(400, "bad_email");
            const multiplier = Math.min(4, Math.max(1, Math.round((Number(body.multiplier) || 1) * 4) / 4));
            const blocks = cleanBlocks(body.blocks);
            const schedReq = __spreadValues({}, r.schedReq || {});
            if (schedReq[ownEmail] && !schedReq[ownEmail].answer) delete schedReq[ownEmail];
            if (blocks) return __spreadProps(__spreadValues({}, r), { schedReq, own: __spreadProps(__spreadValues({}, r.own || {}), { [ownEmail]: { startAt: blocks[0].start, multiplier: 1, blocks, setAt: Date.now() } }) });
            const startAt = Number(body.startAt) > 0 ? Math.floor(Number(body.startAt)) : null;
            return __spreadProps(__spreadValues({}, r), { schedReq, own: __spreadProps(__spreadValues({}, r.own || {}), { [ownEmail]: { startAt, multiplier, setAt: Date.now() } }) });
          } else if (body.action === "unown") {
            const own = __spreadValues({}, r.own || {});
            delete own[ownEmail];
            return __spreadProps(__spreadValues({}, r), { own });
          } else if (body.action === "schedReq") {
            if (!EMAIL_RE.test(ownEmail)) throw new HttpError(400, "bad_email");
            return __spreadProps(__spreadValues({}, r), { schedReq: __spreadProps(__spreadValues({}, r.schedReq || {}), { [ownEmail]: cleanSchedReq(body) }) });
          } else if (body.action === "unschedReq") {
            const sr = __spreadValues({}, r.schedReq || {});
            delete sr[ownEmail];
            return __spreadProps(__spreadValues({}, r), { schedReq: sr });
          } else if (body.action === "delete") return __spreadProps(__spreadValues({}, r), { open: false, endedAt: Date.now(), deletedAt: Date.now() });
          else throw new HttpError(400, "bad_action");
          return __spreadProps(__spreadValues({}, r), { students });
        });
        if (body.action === "schedReq") {
          yield mutate("luddite:mine:" + ownEmail, (m) => {
            const list = m && m.sched || [];
            return list[0] === code ? void 0 : __spreadProps(__spreadValues({}, m || {}), { sched: [code, ...list.filter((c) => c !== code)].slice(0, 60) });
          });
        }
        if (body.action === "own") {
          yield mutate("luddite:mine:" + ownEmail, (m) => {
            const own = m && m.own || [];
            return own.includes(code) ? void 0 : __spreadProps(__spreadValues({}, m || {}), { own: [code, ...own].slice(0, 60) });
          });
          yield noteProctoring(code);
        }
        if (body.action === "addProctor" || body.action === "removeProctor") {
          const add = body.action === "addProctor";
          yield mutate("luddite:mine:" + ownEmail, (m) => {
            const list = (m && m.proctor || []).filter((c) => c !== code);
            return __spreadProps(__spreadValues({}, m || {}), { proctor: add ? [code, ...list].slice(0, 60) : list });
          });
        }
        if (body.action === "delete") {
          yield mutate("luddite:teacher:" + room.teacher.sub, (t) => __spreadProps(__spreadValues({}, t || {}), { rooms: (t && t.rooms || []).filter((c) => c !== code) }));
        }
        if (body.action === "close") {
          const open = Object.entries(room.students).filter(([, st]) => st.status === "admitted" && !st.handedIn && !(room.own && room.own[lower(st.email)]));
          yield handInFromBackups(code, open, "Handed in at the end");
          if (open.length) return respond(200, { room: yield getRoom(code) });
        }
        if (body.action === "handIn") {
          const list = subs.map((sub) => [sub, room.students[sub]]).filter(([, st]) => st && st.status === "admitted" && !st.handedIn);
          yield handInFromBackups(code, list, "Handed in by the teacher");
          return respond(200, { room: yield getRoom(code) });
        }
        return respond(200, { room });
      }
      if (path === "/luddite/drive" && method === "PUT") {
        if (body.disconnect) {
          yield mutate("luddite:drive:" + me.sub, (d) => d ? __spreadProps(__spreadValues({}, d), { refreshToken: "" }) : void 0);
          driveTokens.delete(me.sub);
          return respond(200, { drive: { connected: false } });
        }
        if (!body.code) throw new HttpError(400, "missing_code");
        return respond(200, { drive: yield connectDrive(info, String(body.code)) });
      }
      if (role !== "owner") return respond(403, { error: "owners_only" });
      if (path === "/luddite/teachers") {
        let state;
        if (method === "PUT") {
          const add = lower(body.add);
          const remove = lower(body.remove);
          if (add && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(add)) throw new HttpError(400, "bad_email");
          state = yield mutate("luddite:teachers", (t) => {
            const emails2 = __spreadValues({}, t && t.emails || {});
            if (add) emails2[add] = { addedAt: Date.now() };
            if (remove) delete emails2[remove];
            return { emails: emails2 };
          });
        } else {
          state = (yield readItem("luddite:teachers")).state;
        }
        const emails = state && state.emails || {};
        return respond(200, { owners: OWNER_EMAILS, teachers: Object.keys(emails).sort().map((email) => ({ email, addedAt: emails[email].addedAt })) });
      }
      if (path === "/luddite/proctors") {
        let state;
        if (method === "PUT") {
          const add = lower(body.add);
          const remove = lower(body.remove);
          if (add && !EMAIL_RE.test(add)) throw new HttpError(400, "bad_email");
          if (add && OWNER_EMAILS.includes(add)) throw new HttpError(400, "owner_not_proctor");
          state = yield mutate("luddite:proctors", (t) => {
            const emails2 = __spreadValues({}, t && t.emails || {});
            if (add) emails2[add] = { addedAt: Date.now() };
            if (remove) delete emails2[remove];
            return { emails: emails2 };
          });
        } else {
          state = (yield readItem("luddite:proctors")).state;
        }
        const emails = state && state.emails || {};
        return respond(200, { always: TESTING_CENTER_EMAILS, proctors: Object.keys(emails).sort().map((email) => ({ email, addedAt: emails[email].addedAt })) });
      }
      return respond(404, { error: "Not found" });
    });
  }
  function isPermanentProctor(email) {
    return __async(this, null, function* () {
      const e = lower(email);
      if (!e || OWNER_EMAILS.includes(e)) return false;
      if (TESTING_CENTER_EMAILS.includes(e)) return true;
      const { state } = yield readItem("luddite:proctors");
      return !!(state && state.emails && state.emails[e]);
    });
  }
  function noteProctoring(code) {
    return __async(this, null, function* () {
      yield mutate("luddite:proctoring", (p) => {
        const codes = p && p.codes || [];
        return codes[0] === code ? void 0 : { codes: [code, ...codes.filter((c) => c !== code)].slice(0, PROCTORING_INDEX_MAX) };
      });
    });
  }
  function proctorReach(room, email, permanent) {
    const e = lower(email);
    if (!room || room.deletedAt) return null;
    if ((room.proctors || []).includes(e)) return "session";
    if (permanent && Object.keys(room.own || {}).length) return "own";
    return null;
  }
  function proctorLive(room, now) {
    const regular = stateAt(__spreadProps(__spreadValues({}, regularWindow(room)), { ended: regularEnded(room) }), now);
    if (regular !== "ended") return true;
    return Object.keys(room.own || {}).some((em) => stateAt(windowOf(room, em, null), now) !== "ended");
  }
  function proctorView(room, reach) {
    const now = Date.now();
    const own = room.own || {};
    const people = [];
    const seen = /* @__PURE__ */ new Set();
    Object.entries(room.students || {}).forEach(([sub, s]) => {
      const em = lower(s.email);
      const mine = reach === "session" || !!own[em] || s.status === "waiting";
      if (!mine || s.status === "removed") return;
      seen.add(em);
      const win = windowOf(room, em, s);
      people.push({
        sub,
        email: s.email,
        name: s.name || "",
        status: s.status,
        requestedAt: s.requestedAt || 0,
        lockedOut: !!s.lockedOut,
        askedAt: s.askedAt || 0,
        handedIn: !!s.handedIn,
        away: !!s.away,
        live: !!(s.writing && s.lastSeen && now - s.lastSeen < 25e3),
        paused: !!s.pausedAt,
        own: own[em] || null,
        state: stateAt(win, now),
        startAt: win.start,
        endAt: win.end,
        nextAt: win.nextAt || null
      });
    });
    Object.keys(own).forEach((em) => {
      if (seen.has(em)) return;
      const win = windowOf(room, em, null);
      people.push({ sub: null, email: em, name: "", status: "notHere", own: own[em], state: stateAt(win, now), startAt: win.start, endAt: win.end });
    });
    const reg = regularWindow(room);
    return {
      code: room.code,
      codeLabel: room.codeLabel || room.code,
      title: titleOf(room),
      teacherName: room.teacher.name || room.teacher.email,
      reach,
      prompt: room.prompt || "",
      state: stateAt(__spreadProps(__spreadValues({}, reg), { ended: regularEnded(room) }), now),
      startAt: reg.start,
      paused: !!room.pausedAt || !!(room.sittings && !room.atHome && sittingsWindow(room, "", null, now).paused),
      people,
      now
    };
  }
  function routeProctor(method, path, q, body, me) {
    return __async(this, null, function* () {
      var _a;
      const permanent = yield isPermanentProctor(me.email);
      const now = Date.now();
      if (path === "/luddite/proctor" && method === "GET") {
        const { state: mine } = yield readItem("luddite:mine:" + lower(me.email));
        const codes = new Set(mine && mine.proctor || []);
        if (permanent) (((_a = (yield readItem("luddite:proctoring")).state) == null ? void 0 : _a.codes) || []).forEach((c) => codes.add(c));
        const rooms = [];
        const list = [...codes];
        for (let i = 0; i < list.length; i += 25) {
          const got = yield Promise.all(list.slice(i, i + 25).map((c) => readItem("luddite:room:" + c)));
          got.forEach(({ state: r }) => {
            if (r) rooms.push(r);
          });
        }
        const sessions = rooms.map((r) => ({ r, reach: proctorReach(r, me.email, permanent) })).filter(({ r, reach }) => reach && proctorLive(r, now)).map(({ r, reach }) => {
          const v = proctorView(r, reach);
          return {
            code: v.code,
            title: v.title,
            teacherName: v.teacherName,
            reach,
            state: v.state,
            startAt: v.startAt,
            paused: v.paused,
            count: v.people.filter((p) => p.status !== "waiting").length,
            waiting: v.people.filter((p) => p.status === "waiting").length,
            locked: v.people.filter((p) => p.lockedOut && !p.handedIn).length,
            writing: v.people.filter((p) => p.live).length,
            next: Math.min(...v.people.map((p) => p.state === "upcoming" ? p.startAt : Infinity))
          };
        });
        return respond(200, { sessions, permanent, now });
      }
      if (path === "/luddite/proctor/session" && method === "GET") {
        const room = yield getRoom(cleanCode(q.code));
        const reach = proctorReach(room, me.email, permanent);
        if (!reach) throw new HttpError(403, "not_proctor");
        return respond(200, { session: proctorView(room, reach) });
      }
      if (path === "/luddite/proctor/session" && method === "PUT") {
        const code = cleanCode(body.code);
        const subs = Array.isArray(body.subs) ? body.subs.map(String) : [];
        const email = lower(body.email);
        let reach = null;
        const room = yield mutate("luddite:room:" + code, (r) => {
          reach = proctorReach(r, me.email, permanent);
          if (!reach) throw new HttpError(403, "not_proctor");
          const t = Date.now();
          const own = r.own || {};
          const students = __spreadValues({}, r.students);
          const mayTouch = (sub) => {
            const s = students[sub];
            return !!s && s.status !== "removed" && (reach === "session" || !!own[lower(s.email)] || s.status === "waiting");
          };
          if (subs.some((sub) => !mayTouch(sub))) throw new HttpError(403, "not_proctor");
          const whole = ["startNow", "pauseAll", "resumeAll"].includes(body.action);
          if (whole && reach !== "session") throw new HttpError(403, "not_proctor");
          if (body.action === "admit") subs.forEach((sub) => {
            if (students[sub].status === "waiting") students[sub] = __spreadProps(__spreadValues({}, students[sub]), { status: "admitted", decidedAt: t, via: "proctor" });
          });
          else if (body.action === "unlock") subs.forEach((sub) => {
            students[sub] = __spreadValues(__spreadProps(__spreadValues({}, students[sub]), { lockedOut: false, askedAt: 0, unlockedAt: t }), students[sub].handedIn ? { handedIn: false, releasedAt: t } : {});
          });
          else if (body.action === "pause" || body.action === "resume") subs.forEach((sub) => {
            students[sub] = paused(students[sub], body.action === "pause", t);
          });
          else if (body.action === "begin") {
            if (!EMAIL_RE.test(email)) throw new HttpError(400, "bad_email");
            if (!own[email] && reach !== "session") throw new HttpError(403, "not_proctor");
            const cur = own[email];
            if (cur && cur.blocks) {
              if (cur.blocks.some((b) => t >= b.start && t < b.end)) return void 0;
              const i = cur.blocks.findIndex((b) => b.start > t);
              if (i === -1) throw new HttpError(409, "no_part_left");
              const blocks = cur.blocks.slice();
              blocks[i] = { start: t, end: t + (blocks[i].end - blocks[i].start) };
              if (blocks[i + 1] && blocks[i].end > blocks[i + 1].start) blocks[i].end = blocks[i + 1].start;
              return __spreadProps(__spreadValues({}, r), { own: __spreadProps(__spreadValues({}, own), { [email]: __spreadProps(__spreadValues({}, cur), { blocks, startAt: blocks[0].start, setAt: t, begunBy: lower(me.email) }) }) });
            }
            return __spreadProps(__spreadValues({}, r), { own: __spreadProps(__spreadValues({}, own), { [email]: __spreadProps(__spreadValues({}, own[email] || { multiplier: 1 }), { startAt: t, setAt: t, begunBy: lower(me.email) }) }) });
          } else if (body.action === "startNow") return startedNow(r, t);
          else if (body.action === "pauseAll" || body.action === "resumeAll") return paused(r, body.action === "pauseAll", t);
          else if (body.action === "handIn") return void 0;
          else throw new HttpError(400, "bad_action");
          return __spreadProps(__spreadValues({}, r), { students });
        });
        if (body.action === "handIn") {
          const list = subs.map((sub) => [sub, room.students[sub]]).filter(([, st]) => st && st.status === "admitted" && !st.handedIn);
          yield handInFromBackups(code, list, "Handed in by the proctor");
          return respond(200, { session: proctorView(yield getRoom(code), reach) });
        }
        if (body.action === "begin") {
          yield mutate("luddite:mine:" + email, (m) => {
            const list = m && m.own || [];
            return list.includes(code) ? void 0 : __spreadProps(__spreadValues({}, m || {}), { own: [code, ...list].slice(0, 60) });
          });
          yield noteProctoring(code);
        }
        return respond(200, { session: proctorView(room, reach) });
      }
      return respond(404, { error: "Not found" });
    });
  }
  var HM_ORIGIN = "https://jakegoldwasser-hm.github.io";
  var HM_PRIMARY_ADMINS = ["cassandra_parets@horacemann.org"];
  var HM_ADMIN_MANAGERS = ["jake_goldwasser@horacemann.org"];
  var HM_LOG_MAX = 1500;
  var isHm = (email) => /@horacemann\.org$/.test(lower(email));
  function hmAdminOf(email) {
    return __async(this, null, function* () {
      const em = lower(email);
      if (!isHm(em)) return null;
      if (HM_PRIMARY_ADMINS.includes(em)) return "primary";
      if (HM_ADMIN_MANAGERS.includes(em)) return "manager";
      const { state } = yield readItem("luddite:hmadmins");
      return state && state.emails && state.emails[em] ? "admin" : null;
    });
  }
  function scanPrefixes(prefixes) {
    return __async(this, null, function* () {
      const out = [];
      let start;
      do {
        let res;
        try {
          res = yield ddb.send(new ScanCommand({
            TableName: TABLE_NAME,
            ExclusiveStartKey: start,
            FilterExpression: prefixes.map((_, i) => "begins_with(pk, :p" + i + ")").join(" OR "),
            ExpressionAttributeValues: Object.fromEntries(prefixes.map((p, i) => [":p" + i, { S: p }]))
          }));
        } catch (e) {
          if (e.name === "AccessDeniedException") throw new HttpError(503, "needs_scan_permission");
          throw e;
        }
        for (const it of res.Items || []) {
          try {
            out.push({ pk: it.pk.S, state: JSON.parse(it.state.S) });
          } catch (e) {
          }
        }
        start = res.LastEvaluatedKey;
      } while (start);
      return out;
    });
  }
  function hmLog(email, what, id, label) {
    return __async(this, null, function* () {
      yield mutate("luddite:hmadminlog", (l) => ({
        entries: [
          { at: Date.now(), email: lower(email), what, id: String(id || ""), label: String(label || "").slice(0, 120) },
          ...l && l.entries || []
        ].slice(0, HM_LOG_MAX)
      }));
    });
  }
  function hmRoom(code) {
    return __async(this, null, function* () {
      const { state } = yield readItem("luddite:room:" + cleanCode(code));
      if (!state || !state.teacher || !isHm(state.teacher.email)) throw new HttpError(404, "not_found");
      return state;
    });
  }
  function adminList() {
    return __async(this, null, function* () {
      const { state } = yield readItem("luddite:hmadmins");
      const emails = state && state.emails || {};
      return {
        primary: HM_PRIMARY_ADMINS,
        managers: HM_ADMIN_MANAGERS,
        admins: Object.keys(emails).filter((e) => !HM_PRIMARY_ADMINS.includes(e) && !HM_ADMIN_MANAGERS.includes(e)).sort().map((email) => ({ email, addedAt: emails[email].addedAt, addedBy: emails[email].addedBy || "" }))
      };
    });
  }
  function routeHmAdmin(event, method, path, q, body, me) {
    return __async(this, null, function* () {
      var _a, _b;
      const origin = ((_a = event.headers) == null ? void 0 : _a.origin) || ((_b = event.headers) == null ? void 0 : _b.Origin) || "";
      if (origin !== HM_ORIGIN) return respond(404, { error: "Not found" });
      const level = yield hmAdminOf(me.email);
      if (!level) return respond(403, { error: "not_admin" });
      const canGrant = level === "primary" || level === "manager";
      if (path === "/luddite/admin/me" && method === "GET") {
        return respond(200, { admin: { email: lower(me.email), primary: level === "primary", manager: level === "manager", canGrant } });
      }
      if (level === "manager" && path !== "/luddite/admin/admins") return respond(403, { error: "manager_only_admins" });
      if (path === "/luddite/admin/overview" && method === "GET") {
        const items = yield scanPrefixes(["luddite:room:", "luddite:class:", "luddite:teacher:"]);
        const teachers = /* @__PURE__ */ new Map();
        const teacherOf = (t) => {
          if (!t || !t.sub || !isHm(t.email)) return null;
          if (!teachers.has(t.sub)) teachers.set(t.sub, { sub: t.sub, email: lower(t.email), name: t.name || "", sessions: [], classes: [], rubrics: [], displayName: "" });
          return teachers.get(t.sub);
        };
        for (const { pk, state: s } of items) {
          if (pk.startsWith("luddite:room:")) {
            const t = teacherOf(s.teacher);
            if (!t) continue;
            const sum = roomSummary(s);
            t.sessions.push(__spreadProps(__spreadValues({}, sum), { prompt: shortPrompt(s.prompt), students: Object.keys(s.students || {}).length, deleted: !!s.deletedAt }));
          } else if (pk.startsWith("luddite:class:")) {
            const t = teacherOf(s.teacher);
            if (t) t.classes.push({ id: s.id, name: s.name, count: (s.emails || []).length, createdAt: s.createdAt, deleted: !!s.deletedAt });
          }
        }
        for (const { pk, state: s } of items) {
          if (!pk.startsWith("luddite:teacher:")) continue;
          const t = teachers.get(pk.slice("luddite:teacher:".length));
          if (!t) continue;
          t.displayName = s.displayName || "";
          t.rubrics = s.rubrics || [];
          t.studentCount = Object.keys(s.students || {}).length;
        }
        const list = [...teachers.values()].sort((a, b) => (a.displayName || a.name || a.email).localeCompare(b.displayName || b.name || b.email));
        for (const t of list) {
          t.sessions.sort((a, b) => (b.startAt || b.createdAt || 0) - (a.startAt || a.createdAt || 0));
          t.classes.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        }
        yield hmLog(me.email, "overview", "", "All teachers");
        return respond(200, { teachers: list });
      }
      if (path === "/luddite/admin/session" && method === "GET") {
        const room = yield hmRoom(q.code);
        yield hmLog(me.email, "session", room.code, titleOf(room) + " (" + room.teacher.email + ")");
        return respond(200, { room: __spreadProps(__spreadValues({}, room), { title: titleOf(room) }), roster: yield rosterOf(room) });
      }
      if (path === "/luddite/admin/paper" && method === "GET") {
        const id = String(q.id || "");
        const { state: paper } = yield readItem("luddite:sub:" + id);
        if (!paper) throw new HttpError(404, "not_found");
        const room = yield hmRoom(paper.code);
        yield hmLog(me.email, "paper", id, (paper.name || paper.email) + ", " + titleOf(room));
        return respond(200, { paper, markedHtml: markedHtml(paper), roomRubric: room.rubric || null, teacher: room.teacher });
      }
      if (path === "/luddite/admin/rubricfile" && method === "GET") {
        const id = String(q.id || "");
        const { state: meta } = /^[a-f0-9]{24}$/.test(id) ? yield readItem("luddite:rubricfile:" + id) : { state: null };
        if (!meta || !isHm(meta.ownerEmail)) throw new HttpError(404, "not_found");
        yield hmLog(me.email, "rubric", id, "Rubric PDF from " + meta.ownerEmail);
        const parts = yield Promise.all(Array.from({ length: meta.n }, (_, i) => readItem("luddite:rubricfile:" + id + ":" + i)));
        return respond(200, { data: parts.map((x) => x.state && x.state.data || "").join("") });
      }
      if (path === "/luddite/admin/draft" && method === "GET") {
        const room = yield hmRoom(q.code);
        const sub = String(q.sub || "");
        const s = (room.students || {})[sub];
        if (!s) throw new HttpError(404, "not_found");
        const { state: draft } = yield readItem("luddite:draft:" + room.code + ":" + sub);
        yield hmLog(me.email, "draft", room.code + ":" + sub, (s.name || s.email) + ", " + titleOf(room));
        return respond(200, { draft: draft || null, student: { name: s.name, email: s.email } });
      }
      if (path === "/luddite/admin/class" && method === "GET") {
        const { state: cls } = yield readItem("luddite:class:" + String(q.id || ""));
        if (!cls || !cls.teacher || !isHm(cls.teacher.email)) throw new HttpError(404, "not_found");
        yield hmLog(me.email, "class", cls.id, cls.name + " (" + cls.teacher.email + ")");
        return respond(200, { class: cls });
      }
      if (path === "/luddite/admin/log" && method === "GET") {
        const { state } = yield readItem("luddite:hmadminlog");
        return respond(200, { entries: (state && state.entries || []).slice(0, 500) });
      }
      if (path === "/luddite/admin/admins") {
        if (method === "PUT") {
          if (!canGrant) throw new HttpError(403, "primary_only");
          const add = lower(body.add), remove = lower(body.remove);
          if (add && (!EMAIL_RE.test(add) || !isHm(add))) throw new HttpError(400, "horacemann_only");
          if (remove && (HM_PRIMARY_ADMINS.includes(remove) || HM_ADMIN_MANAGERS.includes(remove))) throw new HttpError(400, "cannot_remove_primary");
          yield mutate("luddite:hmadmins", (a) => {
            const emails = __spreadValues({}, a && a.emails || {});
            if (add && !HM_PRIMARY_ADMINS.includes(add) && !HM_ADMIN_MANAGERS.includes(add) && !emails[add]) emails[add] = { addedAt: Date.now(), addedBy: lower(me.email) };
            if (remove) delete emails[remove];
            return { emails };
          });
          yield hmLog(me.email, add ? "added admin" : "removed admin", add || remove, add || remove);
        }
        return respond(200, yield adminList());
      }
      return respond(404, { error: "Not found" });
    });
  }
  function classIdsOf(t) {
    const ids = t && t.classes || [];
    return t && t.classesOrdered ? ids.slice() : ids.slice().reverse();
  }
  function classesOf(teacherState) {
    return __async(this, null, function* () {
      const ids = classIdsOf(teacherState);
      const list = yield Promise.all(ids.map((id) => readItem("luddite:class:" + id)));
      return list.map((x) => x.state).filter((c) => c && !c.deletedAt).map(classSummary);
    });
  }
  function handInFromBackups(code, list, label) {
    return __async(this, null, function* () {
      yield inBatches(list, (_0) => __async(null, [_0], function* ([sub, st]) {
        const { state: draft } = yield readItem("luddite:draft:" + code + ":" + sub);
        const fresh = yield getRoom(code);
        if (!fresh.students[sub] || fresh.students[sub].handedIn) return;
        if (!draft || !String(draft.text || "").trim()) {
          if (label === "Handed in at the end") return;
          yield mutate("luddite:room:" + code, (r) => r.students[sub] ? __spreadProps(__spreadValues({}, r), { students: __spreadProps(__spreadValues({}, r.students), { [sub]: __spreadProps(__spreadValues({}, r.students[sub]), { handedIn: true, autoHandedIn: true, askedAt: 0, writing: false }) }) }) : void 0);
          return;
        }
        yield handInFor(fresh, code, { sub, email: st.email, name: st.name }, fresh.students[sub], String(draft.text).slice(0, MAX_SUBMISSION_CHARS), label, true).catch((e) => console.warn("auto hand-in failed", sub, e.message));
      }));
    });
  }
  function sharedNowPaper(email, earlyId, paperId) {
    return __async(this, null, function* () {
      yield mutate("luddite:mine:" + lower(email), (m) => {
        const list = m && m.returned || [];
        if (!list.includes(earlyId)) return void 0;
        return __spreadProps(__spreadValues({}, m), { returned: [paperId, ...list.filter((x) => x !== earlyId && x !== paperId)].slice(0, 200) });
      }).catch(() => {
      });
    });
  }
  function handInFor(room, code, me, s, text, label, auto) {
    return __async(this, null, function* () {
      const words = (text.trim().match(/\S+/g) || []).length;
      const who = me.name || me.email;
      const prevSub = (room.submissions || []).find((x) => x.sub === me.sub && x.stored);
      const prev = prevSub ? (yield readItem("luddite:sub:" + prevSub.id)).state : null;
      let file = null, driveError = null;
      if (!prev) try {
        file = yield saveToDrive(room, {
          name: who + " \u2014 " + label,
          description: (auto ? "Handed in by Luddite when the session ended, for " : "Submitted through Luddite by ") + who + " (" + me.email + "), writing session " + titleOf(room) + " (" + code + "). " + words + " words. Left the page " + (s.leaves || 0) + (s.leaves === 1 ? " time." : " times."),
          text
        });
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        driveError = e.message;
      }
      yield saveDraft(code, me.sub, text, s.lastSeen || 0).catch(() => {
      });
      const stored = text.length <= MAX_STORED_CHARS;
      if (!file && !stored) throw new HttpError(409, driveError);
      const at = Date.now();
      const id = prev ? prev.id : file ? file.id : "l" + randomUUID();
      const win = windowOf(room, lower(me.email), s);
      const earlier = (room.submissions || []).filter((x) => x.sub === me.sub);
      const replaces = earlier.flatMap((x) => [x.id, ...x.replaces || []]).filter((x) => x !== id);
      const submission = __spreadValues(__spreadProps(__spreadValues({
        id,
        sub: me.sub
      }, auto ? { auto: true } : {}), {
        email: me.email,
        name: me.name,
        words,
        leaves: s.leaves || 0,
        at,
        link: prev ? prev.link || null : file ? file.webViewLink : null,
        stored,
        driveError,
        marked: 0,
        late: !!(win.end && at > win.end + (win.own ? OWN_GRACE_MS : 0) + LATE_GRACE_MS)
      }), replaces.length ? { replaces } : {});
      if (stored) {
        const { state: chatState } = yield readItem("luddite:chat:" + code + ":" + me.sub);
        const chat = [];
        let left = MAX_PAPER_CHAT_CHARS;
        for (const m of (chatState && chatState.msgs || []).slice().reverse()) {
          if ((left -= m.text.length) < 0) break;
          chat.unshift(m);
        }
        const { state: early } = yield readItem("luddite:early:" + code + ":" + me.sub);
        const early1 = early && !early.usedAt ? early : null;
        const both = (x, y) => x && y && x.trim() !== y.trim() ? x + "\n\n" + y : x || y || "";
        const carried = {
          marks: mergeMarks(prev ? reanchorMarks(prev.marks, prev.text, text) : [], early1 ? reanchorMarks(early1.marks, early1.base, text) : []),
          endComment: both(prev && prev.endComment, early1 && early1.endComment),
          grade: early1 && early1.grade || prev && prev.grade || ""
        };
        const rubricFrom = early1 && early1.rubric ? early1 : prev && prev.rubric ? prev : null;
        if (rubricFrom) Object.assign(carried, { rubric: rubricFrom.rubric, rubricScores: rubricFrom.rubricScores || [] });
        if (early1 || prev) Object.assign(carried, { markedAt: Math.max(early1 && early1.at || 0, prev && prev.markedAt || 0) || void 0 });
        submission.marked = carried.marks.length + (carried.endComment.trim() ? 1 : 0);
        if (carried.grade) submission.grade = carried.grade;
        if (prev && prev.returnedAt) submission.returnedAt = prev.returnedAt;
        else if (early1 && early1.returnedAt) Object.assign(carried, { returnedAt: early1.returnedAt, view: early1.view }), submission.returnedAt = early1.returnedAt;
        if (early1) yield mutate("luddite:early:" + code + ":" + me.sub, (x) => x ? __spreadProps(__spreadValues({}, x), { usedAt: Date.now(), paperId: id }) : void 0);
        if (early1 && early1.returnedAt) yield sharedNowPaper(me.email, "early:" + code + ":" + me.sub, id);
        const paper = yield mutate("luddite:sub:" + id, () => __spreadValues(__spreadValues(__spreadProps(__spreadValues(__spreadValues({}, prev || {}), prev ? { gathered: prev.gathered || !(prev.replaces || []).length } : {}), {
          id,
          code,
          roomTitle: titleOf(room),
          teacherSub: room.teacher.sub,
          sub: me.sub,
          email: me.email,
          name: me.name,
          label,
          text,
          words,
          leaves: s.leaves || 0,
          at,
          link: submission.link
        }), carried), chat.length ? { chat } : {}));
        if (prev && paper.link) yield updateDriveDoc(room.teacher.sub, paper).catch((e) => console.warn("drive update failed", e.detail || e.message));
        const email = me.email.toLowerCase();
        yield mutate("luddite:tstudent:" + room.teacher.sub + ":" + email, (t) => ({
          email,
          name: me.name || t && t.name || "",
          subs: [{ id, at, roomTitle: titleOf(room), label, words }, ...(t && t.subs || []).filter((x) => x.id !== id && !replaces.includes(x.id))]
        }));
        yield mutate("luddite:teacher:" + room.teacher.sub, (t) => {
          const students = __spreadValues({}, t && t.students || {});
          const prev2 = students[email] || { count: 0 };
          students[email] = { name: me.name || prev2.name || "", last: at, count: prev2.count + (earlier.length ? 0 : 1) };
          return __spreadProps(__spreadValues({}, t || { rooms: [] }), { students });
        });
      }
      yield mutate("luddite:mine:" + lower(me.email), (m) => {
        const handed = m && m.handed || [];
        return handed.includes(code) ? void 0 : __spreadProps(__spreadValues({}, m || {}), { handed: [code, ...handed].slice(0, 300) });
      });
      const saved = yield mutate("luddite:room:" + code, (r) => __spreadProps(__spreadValues({}, r), {
        submissions: [submission, ...(r.submissions || []).filter((x) => x.sub !== me.sub)],
        students: __spreadProps(__spreadValues({}, r.students), { [me.sub]: __spreadProps(__spreadValues({}, r.students[me.sub]), { submittedAt: submission.at, submissions: (r.students[me.sub].submissions || 0) + 1, words, handedIn: true, autoHandedIn: !!auto, askedAt: 0, writing: false }) })
      }));
      return saved;
    });
  }
  function cleanRubric(x) {
    if (!x || typeof x !== "object") return null;
    const str = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
    if (x.kind === "doc") return cleanDocRubric(x, str);
    const levels = (Array.isArray(x.levels) ? x.levels : []).slice(0, 6).map((l) => str(l, 40) || "Level");
    if (levels.length < 2) return null;
    const weighted = !!x.weighted;
    const rows = (Array.isArray(x.rows) ? x.rows : []).slice(0, 25).map((row) => __spreadValues({
      skill: str(row && row.skill, 200),
      cells: levels.map((_, i) => str(row && Array.isArray(row.cells) ? row.cells[i] : "", 400))
    }, weighted ? { weight: Math.max(0, Math.min(100, Math.round(Number(row && row.weight) || 0))) } : {})).filter((row) => row.skill);
    if (!rows.length) return null;
    const id = /^[a-z0-9]{6,16}$/.test(String(x.id || "")) ? String(x.id) : randomUUID().replace(/-/g, "").slice(0, 12);
    return { id, name: str(x.name, 80) || "Rubric", levels, weighted, rows };
  }
  var MAX_RUBRIC_CHARS = 4e4;
  function cleanDocRubric(x, str) {
    const cell = (v, n) => String(v == null ? "" : v).replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, n);
    let budget = MAX_RUBRIC_CHARS;
    const spend = (t) => {
      const out2 = t.slice(0, Math.max(0, budget));
      budget -= out2.length;
      return out2;
    };
    const blocks = [];
    for (const b of (Array.isArray(x.blocks) ? x.blocks : []).slice(0, 400)) {
      if (budget <= 0 || !b || typeof b !== "object") continue;
      if (Array.isArray(b.table)) {
        const table = b.table.slice(0, 40).map((row) => (Array.isArray(row) ? row : []).slice(0, 10).map((c) => spend(cell(c, 1500))));
        if (table.some((row) => row.some(Boolean))) blocks.push({ table });
      } else {
        const p = spend(cell(b.p, 3e3));
        if (p) blocks.push(b.h ? { p, h: true } : { p });
      }
    }
    const fileId = /^[a-f0-9]{24}$/.test(String(x.fileId || "")) ? String(x.fileId) : "";
    if (!blocks.length && !fileId) return null;
    const id = /^[a-z0-9]{6,16}$/.test(String(x.id || "")) ? String(x.id) : randomUUID().replace(/-/g, "").slice(0, 12);
    const out = { id, kind: "doc", name: str(x.name, 80) || "Rubric", at: Math.floor(Number(x.at)) || Date.now() };
    if (fileId) {
      out.fileId = fileId;
      out.pages = Math.max(1, Math.min(40, Math.floor(Number(x.pages)) || 1));
      if (/^[A-Za-z0-9_-]{10,100}$/.test(String(x.docId || ""))) out.docId = String(x.docId);
    } else out.blocks = blocks;
    return out;
  }
  var MAX_RUBRIC_PDF_BYTES = 2.5 * 1024 * 1024;
  var RUBRIC_CHUNK_CHARS = 3e5;
  function cleanScores(scores, rubric) {
    if (!rubric || !rubric.rows) return [];
    return rubric.rows.map((_, i) => {
      const v = Math.floor(Number(Array.isArray(scores) ? scores[i] : -1));
      return v >= 0 && v < rubric.levels.length ? v : -1;
    });
  }
  function viewedMs(paper) {
    return paper.view && paper.view.ms || 0;
  }
  function reflectable(room, sub) {
    if (!room || room.deletedAt || !room.reflect) return null;
    const s = room.students && room.students[sub];
    if (!s || s.status === "removed" || !s.handedIn) return null;
    return (room.submissions || []).find((x) => x.sub === sub && x.stored) || null;
  }
  function reflectView(room, sub, paper) {
    const s = room.students[sub] || {}, rf = s.reflect || {}, show = !!room.reflect.showGrading;
    return {
      room: { code: room.code, title: titleOf(room), teacherName: room.teacher.name || room.teacher.email, prompt: room.reflect.prompt || "", showGrading: show },
      paper: __spreadValues({
        id: paper.id,
        at: paper.at,
        words: paper.words,
        text: paper.text
      }, show ? { marks: paper.marks || [], endComment: paper.endComment || "", grade: paper.grade || "", rubric: paper.rubric || null, rubricScores: paper.rubricScores || [] } : { marks: [] }),
      reflection: { text: paper.reflection && paper.reflection.text || "", handedInAt: paper.reflection && paper.reflection.handedInAt || 0 },
      status: rf.status || "new",
      lockedOut: !!rf.lockedOut,
      askedAt: rf.askedAt || 0,
      leaves: rf.leaves || 0
    };
  }
  function myShared(id, me) {
    return __async(this, null, function* () {
      const ep = /^early:([^:]+):(.+)$/.exec(id);
      if (ep) {
        const code = cleanCode(ep[1]), sub = ep[2];
        if (sub !== me.sub) return null;
        const { state: e } = yield readItem("luddite:early:" + code + ":" + sub);
        if (!e) return null;
        if (e.usedAt) return e.paperId ? myShared(e.paperId, me) : null;
        const [{ state: d }, { state: room }] = yield Promise.all([readItem("luddite:draft:" + code + ":" + sub), readItem("luddite:room:" + code)]);
        const text = d ? String(d.text || "") : e.base;
        return {
          id,
          early: true,
          code,
          sub,
          email: me.email,
          name: me.name,
          roomTitle: room ? titleOf(room) : "",
          at: d ? d.at : e.at,
          words: (text.trim().match(/\S+/g) || []).length,
          text,
          marks: reanchorMarks(e.marks || [], e.base, text),
          endComment: e.endComment || "",
          grade: e.grade || "",
          rubric: e.rubric || null,
          rubricScores: e.rubricScores || [],
          returnedAt: e.returnedAt,
          view: e.view
        };
      }
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return null;
      return (yield readItem("luddite:sub:" + id)).state;
    });
  }
  function studentPaper(x) {
    const seen = viewedMs(x), ready = seen >= GRADE_AFTER_MS;
    return {
      id: x.id,
      roomTitle: x.roomTitle,
      name: x.name,
      email: x.email,
      at: x.at,
      words: x.words,
      text: x.text,
      marks: x.marks || [],
      endComment: x.endComment || "",
      returnedAt: x.returnedAt,
      // The rubric counts as part of the grade, so it shows with it.
      rubric: ready ? x.rubric || null : null,
      rubricScores: ready ? x.rubricScores || [] : [],
      viewedMs: seen,
      gradeAfterMs: GRADE_AFTER_MS,
      gradeReady: ready,
      grade: ready ? x.grade || "" : ""
    };
  }
  function saveDraft(code, sub, raw, prevSeen, baseAt) {
    return __async(this, null, function* () {
      const text = String(raw).slice(0, MAX_STORED_CHARS);
      let before = null, glitch = "", conflict = null, savedAt = 0;
      yield mutate("luddite:draft:" + code + ":" + sub, (d) => {
        before = d ? String(d.text || "") : "";
        glitch = d && d.prev ? String(d.prev.text || "") : "";
        conflict = null;
        if (d && d.text === text) {
          before = null;
          savedAt = d.at || 0;
          return void 0;
        }
        if (Number.isFinite(baseAt) && d && d.text && (d.at || 0) > baseAt + 1e3) {
          conflict = { text: d.text, at: d.at, words: (d.text.trim().match(/\S+/g) || []).length, restored: !!d.restored };
          before = null;
          return void 0;
        }
        const at = Date.now();
        savedAt = at;
        const shrank = d && d.text && text.length < d.text.length / 2;
        const prev = shrank ? { text: d.text, at: d.at } : d && d.prev;
        const keepPrev = prev && prev.text.length + text.length < 35e4;
        return __spreadValues({ code, sub, text, at }, keepPrev ? { prev } : {});
      });
      if (conflict) {
        if (text.trim()) yield keepVersion(code, sub, text, { note: "from another computer" }).catch(() => {
        });
        return { conflict };
      }
      if (before !== null) yield logWriting(code, sub, before, text, prevSeen, glitch).catch((e) => console.warn("writing log failed", e.message));
      return { at: savedAt };
    });
  }
  function keepVersion(code, sub, text, extra) {
    return __async(this, null, function* () {
      let entry = null;
      yield mutate("luddite:wlog:" + code + ":" + sub, (L) => {
        const log = L || { mins: [], bursts: [], recent: [], first: Date.now() };
        const k = log.nextSnap || 1;
        entry = __spreadValues({ k, at: Date.now(), words: tokensOf(text).filter(isWord).length }, extra || {});
        return __spreadProps(__spreadValues({}, log), { snaps: [...log.snaps || [], entry], nextSnap: k + 1 });
      });
      yield mutate("luddite:snap:" + code + ":" + sub + ":" + entry.k, () => __spreadProps(__spreadValues({}, entry), { text }));
      return entry;
    });
  }
  var WLOG_MAX_MINS = 3e3;
  var SNAP_EVERY_MS = 3 * 60 * 1e3;
  var SNAP_MAX = 400;
  var BURST_WORDS = 25;
  var BURST_WPM = 150;
  var tokensOf = (t) => String(t || "").match(/\s+|[^\s]+/g) || [];
  var isWord = (t) => !/^\s/.test(t);
  function tokenEdits(a, b, maxD = 400) {
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let sa = a.length, sb = b.length;
    while (sa > p && sb > p && a[sa - 1] === b[sb - 1]) {
      sa--;
      sb--;
    }
    const A = a.slice(p, sa), B = b.slice(p, sb), n = A.length, m = B.length;
    const whole = () => [...n ? [{ type: "del", at: p, toks: A }] : [], ...m ? [{ type: "ins", at: p, toks: B }] : []];
    if (!n || !m) return whole();
    const max = Math.min(n + m, maxD), off = max + 1, v = new Int32Array(2 * max + 3), trace = [];
    let found = -1;
    for (let d = 0; d <= max && found < 0; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x2 = k === -d || k !== d && v[k - 1 + off] < v[k + 1 + off] ? v[k + 1 + off] : v[k - 1 + off] + 1;
        let y2 = x2 - k;
        while (x2 < n && y2 < m && A[x2] === B[y2]) {
          x2++;
          y2++;
        }
        v[k + off] = x2;
        if (x2 >= n && y2 >= m) {
          found = d;
          break;
        }
      }
    }
    if (found < 0) return whole();
    const ops = [];
    let x = n, y = m;
    for (let d = found; d > 0; d--) {
      const vv = trace[d], k = x - y;
      const pk = k === -d || k !== d && vv[k - 1 + off] < vv[k + 1 + off] ? k + 1 : k - 1;
      const px = vv[pk + off], py = px - pk;
      while (x > px && y > py) {
        x--;
        y--;
      }
      if (x === px) ops.push({ type: "ins", ai: x, bi: py, tok: B[py] });
      else ops.push({ type: "del", ai: px, bi: y, tok: A[px] });
      x = px;
      y = py;
    }
    ops.reverse();
    const runs = [];
    for (const o of ops) {
      const last = runs[runs.length - 1];
      const idx = o.type === "ins" ? o.bi : o.ai;
      if (last && last.type === o.type && last.next === idx) {
        last.toks.push(o.tok);
        last.next++;
      } else runs.push({ type: o.type, at: p + idx, toks: [o.tok], next: idx + 1 });
    }
    return runs;
  }
  var squash = (t) => String(t || "").replace(/\s+/g, " ").trim();
  function logWriting(code, sub, before, text, prevSeen, glitch) {
    return __async(this, null, function* () {
      const now = Date.now();
      const a = tokensOf(before), b = tokensOf(text);
      const runs = tokenEdits(a, b);
      let endAt = b.length;
      while (endAt > 0 && !isWord(b[endAt - 1])) endAt--;
      const delRuns = runs.filter((r) => r.type === "del" && r.toks.filter(isWord).length >= 5).map((r) => squash(r.toks.join("")).slice(0, 3e3));
      const sBefore = squash(before), sGlitch = glitch ? squash(glitch) : "";
      const secs = prevSeen ? Math.max(10, (now - prevSeen) / 1e3) : 0;
      let burst = null, snapsToWrite = [];
      yield mutate("luddite:wlog:" + code + ":" + sub, (L) => {
        snapsToWrite = [];
        burst = null;
        const log = L || { mins: [], bursts: [], recent: [], first: now };
        const ownWhy = (r) => {
          const t2 = squash(r.toks.join(""));
          if (!t2 || r.toks.filter(isWord).length < 10) return "";
          if (delRuns.some((x) => x.includes(t2) || t2.includes(x) && x.length > t2.length * 0.8)) return "moved";
          if (sBefore.includes(t2)) return "copied";
          if ((log.recent || []).some((x) => x.includes(t2) || t2.includes(x) && x.length > t2.length * 0.8)) return "restored";
          if (sGlitch && sGlitch.includes(t2)) return "glitch";
          return "";
        };
        let add = 0, del = 0, mid = 0, own = 0, big = 0, bigRun = null;
        const restoresNow = [];
        for (const r of runs) {
          const w = r.toks.filter(isWord).length;
          if (r.type === "del") {
            del += w;
            mid += w;
            continue;
          }
          const why = ownWhy(r);
          if (why) {
            own += w;
            if (w >= BURST_WORDS) restoresNow.push({ at: now, words: w, why });
            continue;
          }
          add += w;
          if (r.at + r.toks.length < endAt) mid += w;
          if (w > big) {
            big = w;
            bigRun = r;
          }
        }
        if (!add && !del && !own) return void 0;
        const words = b.filter(isWord).length;
        const wpm = secs ? Math.round(big / (secs / 60)) : 0;
        const mins = log.mins.slice(), t = Math.floor(now / 6e4) * 6e4;
        const last = mins[mins.length - 1];
        if (last && last.t === t) mins[mins.length - 1] = __spreadProps(__spreadValues({}, last), { add: last.add + add, del: last.del + del, mid: last.mid + mid, own: (last.own || 0) + own, words, big: Math.max(last.big || 0, big) });
        else mins.push({ t, add, del, mid, own, words, big });
        let bursts = log.bursts || [];
        if (bigRun && big >= BURST_WORDS && wpm >= BURST_WPM) {
          burst = { at: now, words: big, wpm, quote: squash(bigRun.toks.join("")).slice(0, 160) };
          bursts = [...bursts, burst].slice(-50);
        }
        const restores = [...log.restores || [], ...restoresNow].slice(-50);
        const recent = [...delRuns, ...log.recent || []].slice(0, 8);
        const snaps = (log.snaps || []).slice();
        let k = log.nextSnap || 1;
        const lastSnap = snaps[snaps.length - 1];
        const take = (txt, at, extra) => {
          const entry = __spreadValues({ k: k++, at, words: tokensOf(txt).filter(isWord).length }, extra || {});
          snaps.push(entry);
          snapsToWrite.push(__spreadProps(__spreadValues({}, entry), { text: txt }));
        };
        if ((!lastSnap || burst) && before.trim() && (!lastSnap || lastSnap.at < (prevSeen || now) - 1e3)) take(before, Math.min(prevSeen || now - 1e4, now - 1e3));
        if (burst) take(text, now, { burst: true });
        else if ((!lastSnap || now - lastSnap.at >= SNAP_EVERY_MS) && snaps.length < SNAP_MAX) take(text, now);
        return __spreadProps(__spreadValues({}, log), { mins: mins.slice(-WLOG_MAX_MINS), bursts, restores, recent, snaps, nextSnap: k });
      });
      for (const x of snapsToWrite) {
        const _a = x, { k } = _a, rest = __objRest(_a, ["k"]);
        yield mutate("luddite:snap:" + code + ":" + sub + ":" + k, () => __spreadProps(__spreadValues({}, rest), { k })).catch((e) => console.warn("snapshot failed", e.message));
      }
      if (burst) yield mutate("luddite:room:" + code, (r) => r && r.students[sub] ? __spreadProps(__spreadValues({}, r), { students: __spreadProps(__spreadValues({}, r.students), { [sub]: __spreadProps(__spreadValues({}, r.students[sub]), { bursts: (r.students[sub].bursts || 0) + 1, burstAt: burst.at }) }) }) : void 0).catch(() => {
      });
    });
  }
  function rosterOf(room) {
    return __async(this, null, function* () {
      if (!room.classId && room.emails && room.emails.length) return { id: null, name: "", emails: room.emails };
      if (!room.classId) return null;
      const { state } = yield readItem("luddite:class:" + room.classId);
      return state && !state.deletedAt ? { id: state.id, name: state.name, emails: state.emails } : null;
    });
  }
  function driveStatus(teacherSub) {
    return __async(this, null, function* () {
      const { state } = yield readItem("luddite:drive:" + teacherSub);
      return { connected: !!(state && state.refreshToken), email: state && state.email || "", configured: !!LUDDITE_CLIENT_SECRET };
    });
  }
  var handler = (event) => __async(null, null, function* () {
    var _a, _b, _c, _d;
    const method = ((_b = (_a = event.requestContext) == null ? void 0 : _a.http) == null ? void 0 : _b.method) || "GET";
    const path = event.rawPath || "/";
    yield loadSessionSecret();
    const authHeader = ((_c = event.headers) == null ? void 0 : _c.authorization) || ((_d = event.headers) == null ? void 0 : _d.Authorization) || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return respond(401, { error: "Missing bearer token" });
    const info = token.startsWith("s1.") ? verifySession(token) : yield verifyGoogleToken(token);
    if (!info) return respond(401, { error: "Invalid or expired token" });
    if (!token.startsWith("s1.") && info.email_verified !== "true" && info.email_verified !== true) {
      return respond(403, { error: "Unverified email" });
    }
    if (!path.startsWith("/luddite/")) return respond(404, { error: "Not found" });
    return handleLuddite(event, method, path, info);
  });
  return __toCommonJS(entry_exports);
})();

  luddite__ = { run: function (event) { return SyncPromise.settle(__luddite.handler(event)); } };
  return luddite__;
}
