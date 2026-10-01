import { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// This is the AWS Lambda behind Bookbug's "sign in with Google to save to
// the cloud" feature. It lives at a Function URL (see CLOUD_API_URL in
// bookbug/index.html) -- see README.md for deploying; there's no build
// step, just this one file. (Luddite has its own backend now:
// luddite-backend/. Nothing here is shared with it.)
//
// Storage is one DynamoDB item per Google user (keyed by their stable
// Google "sub" id), holding a single JSON blob namespaced per app:
//   { chapbookbuilder: { chapbooks, trash, lastOpened, pictureBooks, pictureBookTrash } }
// (Bookbug's key predates its rename.) A `dummybuilder: { dummies }` key
// may also be there from the retired Dummy Builder; Bookbug reads it once
// to bring those dummies in as picture books and leaves it in place.
// A tool only ever reads/writes its own top-level key, so a future tool sharing this backend can't clobber
// Bookbug's data for the same signed-in user.
//
// Older records (saved before this namespacing existed) have the
// Chapbook Builder shape directly at the top level -- {chapbooks, trash}
// with no "chapbookbuilder" wrapper. migrateLegacyState() recognizes and
// nests those in place the first time they're read or written, so
// existing users don't lose anything.

const TABLE_NAME = process.env.TABLE_NAME || 'ChapbookBuilderUsers';
// Picture-book art lives apart from the JSON blob above, one item per
// image (userId + imageId), so a book's pictures never push that one
// item past DynamoDB's 400 KB limit. The page keeps each image under
// IMAGE_MAX_BYTES before sending it.
const IMAGE_TABLE_NAME = process.env.IMAGE_TABLE_NAME || 'BookbugImages';
const IMAGE_MAX_BYTES = 390 * 1024;
const IMAGE_ID = /^[A-Za-z0-9_-]{6,64}$/;
const IMAGE_TYPES = /^image\/(jpeg|png|webp)$/;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
// Signs this backend's own session tokens (see issueSession). Any long
// random string; changing it signs everyone out. If unset, no sessions
// are issued and the tools fall back to Google's ~1hr ID tokens alone.
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const ddb = new DynamoDBClient({});

// CORS (including Access-Control-Allow-Origin) is handled entirely by the
// Function URL's own --cors config, which applies it to every response,
// not just OPTIONS preflight. Setting it here too would duplicate the
// header and browsers reject a response with two Allow-Origin values.
function respond(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj)
  };
}

// Offloads signature verification to Google itself instead of implementing
// JWT/JWKS checking by hand -- simpler, and fine at this scale.
async function verifyGoogleToken(idToken) {
  const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (!res.ok) return null;
  const info = await res.json();
  if (!info.sub) return null;
  if (GOOGLE_CLIENT_ID && info.aud !== GOOGLE_CLIENT_ID) return null;
  return info;
}

// Google ID tokens only live ~1hr, and Google rate-limits silently
// minting new ones, so on their own they can't keep anyone signed in for
// long. Instead, once a Google token checks out, this backend hands back
// its own session token -- "s1.<base64url JSON payload>.<HMAC>" -- good
// for 30 days and re-issued on every GET, so regular use keeps sliding
// the window forward (the "stay signed in for days" behavior sites like
// Google Docs have). The payload's sub/email/name/exp are readable by
// the page; only the signature needs the secret.
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function sign(data) { return createHmac('sha256', SESSION_SECRET).update(data).digest('base64url'); }

function issueSession(info) {
  if (!SESSION_SECRET) return null;
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    sub: info.sub, email: info.email || '', name: info.name || '', iat: now, exp: now + SESSION_TTL_SECONDS
  }));
  return 's1.' + payload + '.' + sign('s1.' + payload);
}

function verifySession(token) {
  if (!SESSION_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 's1') return null;
  const expected = Buffer.from(sign(parts[0] + '.' + parts[1]));
  const actual = Buffer.from(parts[2]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!payload.sub || !payload.exp || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

function migrateLegacyState(state) {
  if (state && typeof state === 'object' && !state.chapbookbuilder &&
      (state.chapbooks !== undefined || state.trash !== undefined)) {
    return { chapbookbuilder: { chapbooks: state.chapbooks || [], trash: state.trash || [] } };
  }
  return state || {};
}

// ---- Merging a save into what's stored ----
// A save used to replace the app's whole namespace with the sender's copy.
// That lost work: a tab or device left open since yesterday still holds
// yesterday's books, and the next thing it saved (any book, or just which
// book was open) wrote all of them back over newer edits made elsewhere.
// Now each save is folded into what's stored, book by book: where both
// sides have a book, whichever copy changed last wins (a deletion
// tombstone counts from when it was deleted, an archive/unarchive from
// archiveChangedAt) -- the same rule Bookbug's own mergeLibraries uses
// when it pulls. Books only one side has are kept.
const BOOK_LISTS = [['chapbooks', 'trash'], ['pictureBooks', 'pictureBookTrash'], ['cartoonBooks', 'cartoonBookTrash']];

function bookStamp(e) {
  return Math.max(Number(e.deletedAt) || 0, Number(e.updatedAt) || 0, Number(e.archiveChangedAt) || 0);
}

export function mergeLibraryPair(storedLib, storedTrash, incomingLib, incomingTrash) {
  const winners = new Map();
  function consider(entry, inTrash) {
    if (!entry || !entry.id) return;
    const cur = winners.get(entry.id);
    // Ties go to the incoming copy (considered second), as a plain save would.
    if (!cur || bookStamp(entry) >= bookStamp(cur.entry)) winners.set(entry.id, { entry, inTrash });
  }
  (storedLib || []).forEach(e => consider(e, false));
  (storedTrash || []).forEach(e => consider(e, true));
  (incomingLib || []).forEach(e => consider(e, false));
  (incomingTrash || []).forEach(e => consider(e, true));
  const lib = [], trash = [];
  // Keep the sender's order, then anything only the stored copy had.
  const order = [];
  const seen = new Set();
  [incomingLib, incomingTrash, storedLib, storedTrash].forEach(list => (list || []).forEach(e => {
    if (e && e.id && !seen.has(e.id)) { seen.add(e.id); order.push(e.id); }
  }));
  order.forEach(id => { const w = winners.get(id); (w.inTrash ? trash : lib).push(w.entry); });
  return { lib, trash };
}

function newerStamped(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (Number(b.at) || 0) >= (Number(a.at) || 0) ? b : a;
}

export function mergeBookbugSave(stored, incoming) {
  if (!stored || typeof stored !== 'object') return incoming;
  if (!incoming || typeof incoming !== 'object') return stored;
  const out = Object.assign({}, stored, incoming);
  BOOK_LISTS.forEach(([libKey, trashKey]) => {
    if (!Array.isArray(stored[libKey]) && !Array.isArray(stored[trashKey])) return;
    if (!Array.isArray(incoming[libKey]) && !Array.isArray(incoming[trashKey])) { out[libKey] = stored[libKey]; out[trashKey] = stored[trashKey]; return; }
    const m = mergeLibraryPair(stored[libKey], stored[trashKey], incoming[libKey], incoming[trashKey]);
    out[libKey] = m.lib;
    out[trashKey] = m.trash;
  });
  // Recently deleted books (kept 7 days, restorable): union by id, the
  // newest deletion wins, anything older than 7 days goes, and a book
  // that's back in a library with a newer stamp (restored) drops out.
  if (Array.isArray(stored.recentlyDeleted) || Array.isArray(incoming.recentlyDeleted)) {
    const cut = Date.now() - 7 * 24 * 3600 * 1000, byId = new Map();
    [].concat(stored.recentlyDeleted || [], incoming.recentlyDeleted || []).forEach(d => {
      if (!d || !d.id || !(Number(d.deletedAt) > cut)) return;
      const cur = byId.get(d.id);
      if (!cur || Number(d.deletedAt) > Number(cur.deletedAt)) byId.set(d.id, d);
    });
    const live = new Map();
    ['chapbooks', 'pictureBooks', 'cartoonBooks'].forEach(k => (out[k] || []).forEach(e => { if (e && e.id) live.set(e.id, bookStamp(e)); }));
    out.recentlyDeleted = [...byId.values()].filter(d => !(live.get(d.id) > Number(d.deletedAt)));
  }
  out.lastOpened = newerStamped(stored.lastOpened, incoming.lastOpened);
  out.homeForms = newerStamped(stored.homeForms, incoming.homeForms);
  return out;
}

async function getStoredState(userId) {
  const result = await ddb.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { userId: { S: userId } }
  }));
  if (!result.Item) return { state: {}, updatedAt: 0, exists: false };
  return {
    state: migrateLegacyState(JSON.parse(result.Item.state.S)),
    updatedAt: Number(result.Item.updatedAt?.N || 0),
    exists: true
  };
}

// ---- Import from a link ----
// GET ?fetch=<url> returns that page's text so Bookbug can import entries
// from it (browsers can't read other sites' pages themselves). Signed-in
// users only, and guarded so it can't be used to reach anything private:
// http(s) only, standard ports, every hop's host must resolve to public
// addresses, at most 4 redirects, text types only, 3 MB, 8 seconds.
const FETCH_MAX_BYTES = 3 * 1024 * 1024;
const FETCH_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain|text\/markdown|text\/x-markdown)\b/i;

function isPrivateAddress(addr) {
  if (isIP(addr) === 4) {
    const [a, b] = addr.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = addr.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') ||
    v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb');
}

async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { throw new Error('bad_url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad_url');
  if (u.username || u.password) throw new Error('bad_url');
  if (u.port && u.port !== '80' && u.port !== '443') throw new Error('bad_url');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('blocked_host');
  return u;
}

// A Google Docs editing link becomes its public markdown export, which
// works for any doc shared as "anyone with the link" (private docs
// redirect to a sign-in page, which reads as not-shared).
function googleDocExportUrl(u) {
  const m = u.hostname === 'docs.google.com' && /^\/document\/d\/([a-zA-Z0-9_-]{20,})/.exec(u.pathname);
  return m ? 'https://docs.google.com/document/d/' + m[1] + '/export?format=md' : null;
}

// PDFs come back as base64 for Bookbug to read in the browser (pdf.js).
// Kept under 4 MB so the base64 fits a Lambda response (6 MB).
const PDF_MAX_BYTES = 4 * 1024 * 1024;
const UA = 'Bookbug/1.0 (+https://jake-goldwasser.com/bookbug/)';

// Follows redirects by hand (each hop re-checked as public). Landing on
// Google's sign-in page means the thing isn't shared publicly -- say so,
// rather than handing back the sign-in page as if it were the content.
// Google's download host can take several seconds before it answers, so
// the wait is generous (the Lambda's own timeout is the real ceiling).
async function fetchFollowing(start, accept) {
  let url = start;
  for (let hop = 0; hop <= 5; hop++) {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { 'User-Agent': UA, Accept: accept } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), url);
      if (next.hostname === 'accounts.google.com') throw new Error('google_private');
      url = await assertPublicUrl(next.href);
      continue;
    }
    return { res, url };
  }
  throw new Error('too_many_redirects');
}

async function readBody(res, max) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { reader.cancel(); throw new Error('too_large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
function decodeText(buf, type) {
  const charset = (/charset=([\w-]+)/i.exec(type || '') || [])[1] || 'utf-8';
  try { return new TextDecoder(charset).decode(buf); } catch (e) { return buf.toString('utf8'); }
}
const isPdf = (buf) => buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-';

// ---- Public Google Drive folders and files ----
// A folder shared as "anyone with the link" is listed through Drive's
// embeddable folder view (plain HTML, no sign-in); each file is fetched
// through its public download link. Subfolders are listed but not opened.
const DRIVE_ID = /^[A-Za-z0-9_-]{10,}$/;
function driveFolderId(u) {
  if (u.hostname !== 'drive.google.com') return null;
  const m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(u.pathname);
  if (m) return m[1];
  if (u.pathname === '/embeddedfolderview' && DRIVE_ID.test(u.searchParams.get('id') || '')) return u.searchParams.get('id');
  return null;
}
function driveFileId(u) {
  if (u.hostname !== 'drive.google.com' && u.hostname !== 'drive.usercontent.google.com') return null;
  const m = /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(u.pathname);
  if (m) return m[1];
  const id = u.searchParams.get('id');
  return (u.pathname === '/open' || u.pathname === '/uc' || u.pathname === '/download') && DRIVE_ID.test(id || '') ? id : null;
}
function htmlDecode(s) {
  return String(s).replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
export function parseDriveFolderView(html) {
  const files = [];
  const re = /<div class="flip-entry" id="entry-([A-Za-z0-9_-]+)"[\s\S]*?<a href="([^"]*)"[\s\S]*?<div class="flip-entry-list-icon"><img src="([^"]*)"[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, id, href, icon, rawName] = m;
    const name = htmlDecode(rawName).trim();
    let kind = 'other';
    if (/\/folders\//.test(href)) kind = 'folder';
    else if (/docs\.google\.com\/document\//.test(href)) kind = 'doc';
    else if (/\/type\/application\/pdf/.test(icon) || /\.pdf$/i.test(name)) kind = 'pdf';
    else if (/\/type\/text\//.test(icon) || /\.(txt|md|markdown)$/i.test(name)) kind = 'text';
    files.push({ id, name, kind });
  }
  const title = /<title>([^<]*)<\/title>/.exec(html);
  return { name: title ? htmlDecode(title[1]).replace(/\s*-\s*Google Drive\s*$/, '').trim() : '', files };
}
async function listDriveFolder(id) {
  const start = new URL('https://drive.google.com/embeddedfolderview?id=' + encodeURIComponent(id));
  const { res } = await fetchFollowing(start, 'text/html');
  if (res.status === 404 || res.status === 403 || res.status === 401) throw new Error('google_private');
  if (!res.ok) throw new Error('http_' + res.status);
  const html = decodeText(await readBody(res, FETCH_MAX_BYTES), res.headers.get('content-type'));
  const folder = parseDriveFolderView(html);
  return { url: 'https://drive.google.com/drive/folders/' + id, folder: true, name: folder.name, files: folder.files };
}
// Google puts big files behind a "can't scan this for viruses" page whose
// form carries the real download address; that page is followed once.
function virusScanFormUrl(html) {
  const form = /<form[^>]+id="download-form"[^>]+action="([^"]+)"[\s\S]*?<\/form>/.exec(html);
  if (!form) return null;
  const u = new URL(htmlDecode(form[1]));
  const inputs = /<input[^>]+type="hidden"[^>]*>/g;
  let m;
  while ((m = inputs.exec(form[0]))) {
    const name = /name="([^"]+)"/.exec(m[0]), value = /value="([^"]*)"/.exec(m[0]);
    if (name) u.searchParams.set(htmlDecode(name[1]), value ? htmlDecode(value[1]) : '');
  }
  return u;
}
export async function fetchDriveFile(id) {
  if (!DRIVE_ID.test(id)) throw new Error('bad_url');
  let target = new URL('https://drive.google.com/uc?export=download&id=' + encodeURIComponent(id));
  for (let pass = 0; pass < 2; pass++) {
    const { res, url } = await fetchFollowing(target, '*/*');
    if (res.status === 404 || res.status === 403 || res.status === 401) throw new Error('google_private');
    if (!res.ok) throw new Error('http_' + res.status);
    const type = res.headers.get('content-type') || '';
    const disp = res.headers.get('content-disposition') || '';
    const nameMatch = /filename\*=UTF-8''([^;]+)/i.exec(disp) || /filename="([^"]+)"/i.exec(disp);
    const name = nameMatch ? decodeURIComponent(nameMatch[1]) : '';
    const buf = await readBody(res, PDF_MAX_BYTES);
    if (isPdf(buf)) return { url: url.href, contentType: 'application/pdf', name, data: buf.toString('base64') };
    if (/text\/html/i.test(type)) {
      const html = decodeText(buf, type);
      const next = pass === 0 && virusScanFormUrl(html);
      if (next) { target = await assertPublicUrl(next.href); continue; }
      if (/accounts\.google\.com\/(v3\/signin|ServiceLogin)/.test(html)) throw new Error('google_private');
      throw new Error('unsupported_type');
    }
    if (/^text\//i.test(type)) return { url: url.href, contentType: type.split(';')[0].trim(), name, text: decodeText(buf, type) };
    throw new Error('unsupported_type');
  }
  throw new Error('unsupported_type');
}

export async function fetchPage(raw) {
  let url = await assertPublicUrl(raw);
  const folderId = driveFolderId(url);
  if (folderId) return listDriveFolder(folderId);
  const fileId = driveFileId(url);
  if (fileId) return fetchDriveFile(fileId);
  const exportUrl = googleDocExportUrl(url);
  if (exportUrl) url = new URL(exportUrl);
  const got = await fetchFollowing(url, 'text/html,text/markdown,text/plain;q=0.9,application/pdf;q=0.8');
  const res = got.res;
  url = got.url;
  if (!res.ok) throw new Error('http_' + res.status);
  const type = res.headers.get('content-type') || '';
  // A PDF link (or a download that turns out to be one).
  if (/application\/(pdf|octet-stream)/i.test(type)) {
    const buf = await readBody(res, PDF_MAX_BYTES);
    if (!isPdf(buf)) throw new Error('unsupported_type');
    return { url: url.href, contentType: 'application/pdf', name: decodeURIComponent(url.pathname.split('/').pop() || ''), data: buf.toString('base64') };
  }
  if (!FETCH_TYPES.test(type)) throw new Error('unsupported_type');
  const text = decodeText(await readBody(res, FETCH_MAX_BYTES), type);
  // A sign-in page served in place of the content (no redirect) is private too.
  if (/^accounts\.google\.com$/.test(url.hostname) || (/google\.com$/.test(url.hostname) && /<title>[^<]*Sign[- ]in/i.test(text))) throw new Error('google_private');
  return { url: url.href, contentType: type.split(';')[0].trim(), googleDoc: !!exportUrl, text };
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || 'GET';
  const path = event.rawPath || '/';

  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return respond(401, { error: 'Missing bearer token' });

  // Session tokens are checked locally; anything else is treated as a
  // Google ID token (sign-in, or a tool that hasn't adopted sessions yet).
  const info = token.startsWith('s1.') ? verifySession(token) : await verifyGoogleToken(token);
  if (!info) return respond(401, { error: 'Invalid or expired token' });

  const userId = info.sub;

  // GET ?drivefile=<id>: one file from a public Drive folder (see
  // listDriveFolder), as { contentType, name, data (base64 PDF) | text }.
  if (method === 'GET' && event.queryStringParameters?.drivefile) {
    try {
      return respond(200, await fetchDriveFile(event.queryStringParameters.drivefile));
    } catch (e) {
      const code = String(e.message || '');
      return respond(422, { error: /^(bad_url|blocked_host|google_private|unsupported_type|too_large|too_many_redirects|http_\d+)$/.test(code) ? code : 'fetch_failed' });
    }
  }

  if (method === 'GET' && event.queryStringParameters?.fetch) {
    try {
      return respond(200, await fetchPage(event.queryStringParameters.fetch));
    } catch (e) {
      const code = String(e.message || '');
      const known = /^(bad_url|blocked_host|google_private|unsupported_type|too_large|too_many_redirects|http_\d+)$/.test(code);
      return respond(422, { error: known ? code : 'fetch_failed' });
    }
  }

  // ---- Picture-book images ----
  // GET ?image=<id> -> { type, data (base64) }; PUT ?image=<id> with
  // { type, data } stores it, or { delete: true } removes it. PUT rather
  // than DELETE because the Function URL's CORS allows GET and PUT only.
  const imageId = event.queryStringParameters?.image;
  if (imageId !== undefined) {
    if (!IMAGE_ID.test(imageId)) return respond(400, { error: 'Bad image id' });
    const key = { userId: { S: userId }, imageId: { S: imageId } };
    if (method === 'GET') {
      const result = await ddb.send(new GetItemCommand({ TableName: IMAGE_TABLE_NAME, Key: key }));
      if (!result.Item) return respond(404, { error: 'No such image' });
      return respond(200, { type: result.Item.type.S, data: Buffer.from(result.Item.data.B).toString('base64') });
    }
    if (method === 'PUT') {
      let payload;
      try {
        const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
        payload = JSON.parse(raw);
      } catch (e) {
        return respond(400, { error: 'Invalid JSON body' });
      }
      if (payload && payload.delete) {
        await ddb.send(new DeleteItemCommand({ TableName: IMAGE_TABLE_NAME, Key: key }));
        return respond(200, { ok: true });
      }
      if (!payload || !IMAGE_TYPES.test(payload.type || '') || typeof payload.data !== 'string') {
        return respond(400, { error: 'Expected { type, data }' });
      }
      const bytes = Buffer.from(payload.data, 'base64');
      if (!bytes.length || bytes.length > IMAGE_MAX_BYTES) return respond(413, { error: 'Image too large' });
      await ddb.send(new PutItemCommand({
        TableName: IMAGE_TABLE_NAME,
        Item: { ...key, type: { S: payload.type }, data: { B: bytes }, updatedAt: { N: String(Date.now()) } }
      }));
      return respond(200, { ok: true });
    }
    return respond(405, { error: 'Method not allowed' });
  }

  if (method === 'GET') {
    const { state, updatedAt } = await getStoredState(userId);
    const session = issueSession(info);
    return respond(200, session ? { state, updatedAt, session } : { state, updatedAt });
  }

  if (method === 'PUT') {
    let payload;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
      payload = JSON.parse(raw);
    } catch (e) {
      return respond(400, { error: 'Invalid JSON body' });
    }

    const app = payload && payload.app;
    if (!app || typeof app !== 'string') {
      return respond(400, { error: 'Missing "app" field -- each tool must identify itself so its save only touches its own namespace' });
    }

    // Read, merge, write -- only if nobody else wrote in between (two
    // devices saving at once); on a clash, read again and redo the merge.
    for (let attempt = 0; attempt < 4; attempt++) {
      const { state, updatedAt, exists } = await getStoredState(userId);
      state[app] = app === 'chapbookbuilder' ? mergeBookbugSave(state[app], payload.data) : payload.data;
      const now = Math.max(Date.now(), updatedAt + 1);
      try {
        await ddb.send(new PutItemCommand({
          TableName: TABLE_NAME,
          Item: {
            userId: { S: userId },
            state: { S: JSON.stringify(state) },
            updatedAt: { N: String(now) }
          },
          ...(updatedAt
            ? { ConditionExpression: 'updatedAt = :prev', ExpressionAttributeValues: { ':prev': { N: String(updatedAt) } } }
            : { ConditionExpression: exists ? 'attribute_not_exists(updatedAt)' : 'attribute_not_exists(userId)' })
        }));
        return respond(200, { ok: true });
      } catch (e) {
        if (e.name !== 'ConditionalCheckFailedException') throw e;
      }
    }
    return respond(409, { error: 'Busy -- try again' });
  }

  return respond(405, { error: 'Method not allowed' });
};
