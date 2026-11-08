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
