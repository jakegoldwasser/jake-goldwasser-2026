// Runs Code.js on this computer, exactly as Apps Script would, with small
// stand-ins for the Apps Script services it uses (a Sheet kept in memory,
// script properties, a lock, UrlFetchApp through curl). Used by test.mjs
// and server.mjs; nothing here goes to Google.
import vm from 'node:vm';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

class Sheet {
  constructor(name, rows) { this.name = name; this.rows = rows || []; this.maxRows = 1000; this.maxCols = 26; }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  getLastRow() { for (let r = this.rows.length; r > 0; r--) if ((this.rows[r - 1] || []).some((v) => v !== '' && v != null)) return r; return 0; }
  getLastColumn() { let c = 0; for (const row of this.rows) for (let i = (row || []).length; i > c; i--) if (row[i - 1] !== '' && row[i - 1] != null) { c = i; break; } return c; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertRowsAfter(_, n) { this.maxRows += n; }
  insertColumnsAfter(_, n) { this.maxCols += n; }
  setFrozenRows() {}
  getRange(row, col, nr, nc) {
    const sheet = this;
    if (row < 1 || col < 1 || row + nr - 1 > sheet.maxRows || col + nc - 1 > sheet.maxCols) throw new Error('Range out of bounds: ' + [row, col, nr, nc]);
    return {
      getValues() {
        const out = [];
        for (let r = 0; r < nr; r++) { const src = sheet.rows[row - 1 + r] || []; const line = []; for (let c = 0; c < nc; c++) { const v = src[col - 1 + c]; line.push(v == null ? '' : v); } out.push(line); }
        return out;
      },
      setValues(values) {
        if (values.length !== nr || values.some((l) => l.length !== nc)) throw new Error('setValues: wrong size');
        values.forEach((line, r) => {
          const target = sheet.rows[row - 1 + r] || (sheet.rows[row - 1 + r] = []);
          line.forEach((v, c) => {
            if (typeof v === 'string' && v.length > 50000) throw new Error('Cell over 50,000 characters');
            target[col - 1 + c] = v;
          });
        });
        return this;
      }
    };
  }
}

class Book {
  constructor(id, sheets) { this.id = id; this.sheets = sheets || [new Sheet('Sheet1')]; }
  getId() { return this.id; }
  getSheets() { return this.sheets; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
}

export function makeGas({ properties = {}, dataFile } = {}) {
  const props = { ...properties };
  const books = {};
  let fetches = 0, sheetCalls = 0;

  if (dataFile && existsSync(dataFile)) {
    const saved = JSON.parse(readFileSync(dataFile, 'utf8'));
    Object.assign(props, saved.props);
    for (const [id, tabs] of Object.entries(saved.books)) books[id] = new Book(id, tabs.map((t) => new Sheet(t.name, t.rows)));
  }
  function persist() {
    if (!dataFile) return;
    const books_ = {};
    for (const [id, b] of Object.entries(books)) books_[id] = b.sheets.map((s) => ({ name: s.name, rows: s.rows }));
    writeFileSync(dataFile, JSON.stringify({ props, books: books_ }));
  }

  const services = {
    PropertiesService: { getScriptProperties: () => ({
      getProperties: () => ({ ...props }),
      getProperty: (k) => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); }
    }) },
    SpreadsheetApp: {
      create: (name) => { const id = 'book-' + randomUUID(); books[id] = new Book(id); return books[id]; },
      openById: (id) => { sheetCalls++; if (!books[id]) throw new Error('no spreadsheet ' + id); return books[id]; },
      flush: () => { persist(); }
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    Utilities: {
      getUuid: () => randomUUID(),
      sleep: () => {},
      Charset: { UTF_8: 'utf8' },
      computeHmacSha256Signature: (data, key) => Array.from(createHmac('sha256', key).update(data, 'utf8').digest(), (b) => (b > 127 ? b - 256 : b))
    },
    UrlFetchApp: {
      fetch: (url, p) => {
        fetches++;
        const args = ['-s', '-X', p.method.toUpperCase(), '-w', '\n%{http_code}', url];
        if (p.contentType) args.push('-H', 'Content-Type: ' + p.contentType);
        for (const [k, v] of Object.entries(p.headers || {})) args.push('-H', k + ': ' + v);
        if (p.payload !== undefined) args.push('--data-binary', String(p.payload));
        const raw = execFileSync('curl', args, { encoding: 'utf8' });
        const cut = raw.lastIndexOf('\n');
        return { getResponseCode: () => Number(raw.slice(cut + 1)), getContentText: () => raw.slice(0, cut) };
      }
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; }, getContent() { return this.text; } })
    }
  };

  const code = readFileSync(new URL('../Code.js', import.meta.url), 'utf8');

  // Each request runs in a fresh copy of the script, like Apps Script.
  function post(req) {
    const ctx = vm.createContext({ ...services, console, Uint8Array, Array, Object, JSON, Math, Date, String, Number, Error, TypeError, RangeError, RegExp, Map, Set, Symbol, parseInt, encodeURIComponent, decodeURIComponent });
    vm.runInContext(code, ctx, { filename: 'Code.js' });
    const out = ctx.doPost({ postData: { contents: JSON.stringify(req) } });
    const { s, b } = JSON.parse(out.getContent());
    return { status: s, body: b ? JSON.parse(b) : null };
  }

  return { post, props, books, stats: () => ({ fetches, sheetCalls }) };
}

// A session token for any account, signed with the secret index.mjs keeps
// in luddite:config (or SESSION_SECRET), the way issueSession() makes them.
export function sessionFor(secret, { sub, email, name }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ sub, email, name: name || email, iat: now, exp: now + 3600 })).toString('base64url');
  return 's1.' + payload + '.' + createHmac('sha256', secret).update('s1.' + payload).digest('base64url');
}
