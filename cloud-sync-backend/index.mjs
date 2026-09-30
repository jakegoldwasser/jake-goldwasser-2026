import { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// This is the AWS Lambda behind Bookbug's "sign in with Google to save to
// the cloud" feature. It lives at a Function URL (see CLOUD_API_URL in
// bookbug/index.html) -- see README.md for deploying; there's no build
// step, just this one file. It also runs Luddite's rooms, waiting rooms
// and Drive submissions (see handleLuddite).
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
// Luddite signs people in through its own Google app (Google Cloud project
// "Luddite"), so its consent screen says Luddite and school IT can approve
// it on its own. Sign-ins from either app are accepted; Google gives a
// person the same "sub" in both, so accounts carry over.
const LUDDITE_CLIENT_ID = process.env.LUDDITE_GOOGLE_CLIENT_ID || '522963753495-m1qigb1q8ct9rmmrh56fkv7r3hs2psap.apps.googleusercontent.com';
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
  if (GOOGLE_CLIENT_ID && info.aud !== GOOGLE_CLIENT_ID && info.aud !== LUDDITE_CLIENT_ID) return null;
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

// ---------------------------------------------------------------------
// Luddite (/luddite/ on the site): a locked-down writing room.
//
// OWNER_EMAILS run the site and choose who counts as a teacher. A teacher
// opens rooms; each room has its own join code, waiting room and
// submission box. Students sign in with Google, enter a code, wait to be
// admitted, write, and submit -- the submission becomes a Google Doc in
// that room's teacher's Google Drive (see the Drive section below).
//
// Items in the shared table (real users are keyed by a numeric Google
// "sub", so these string keys can't collide with them):
//   luddite:teachers        { emails: { [email]: { addedAt } } }
//   luddite:teacher:<sub>   { rooms: [code, ...] }  newest first
//   luddite:room:<code>     { code, title, teacher: { sub, email, name },
//                             open, createdAt, students: { [sub]: {...} },
//                             submissions: [...] }
//   luddite:drive:<sub>     { refreshToken, email, rootId, roomFolders }
//   luddite:sub:<id>        one handed-in piece, kept so its teacher can mark
//                           it up: { id, code, roomTitle, teacherSub, sub,
//                           email, name, label, text, words, leaves, at, link,
//                           marks: [...], endComment }
//   luddite:tstudent:<teacherSub>:<email>
//                           { email, name, subs: [{ id, at, roomTitle, label,
//                           words }] } newest first: a student's year with
//                           one teacher. The teacher's own item lists these
//                           students in `students: { [email]: { name, last,
//                           count } }`.
// A room is written by all of its students at once (joins, "left the
// page" reports, word counts), so every write is read-modify-write under
// an optimistic lock -- a `ver` number checked by a conditional PutItem --
// which needs no permission beyond the GetItem/PutItem the role has.
// ---------------------------------------------------------------------
const OWNER_EMAILS = ['jake_goldwasser@horacemann.org', 'jake.goldwasser@gmail.com'];
// The Luddite Google app's client secret, for turning a teacher's one-time
// Drive consent into a lasting refresh token (Configuration -> Environment
// variables in the Lambda console). Without it, Drive can't be connected.
const LUDDITE_CLIENT_SECRET = process.env.LUDDITE_GOOGLE_CLIENT_SECRET || '';
const MAX_SUBMISSION_CHARS = 400000;
// A DynamoDB item tops out at 400 KB, so a piece is kept for marking up only
// if its text fits with room to spare for the teacher's marks.
const MAX_STORED_CHARS = 250000;
const MAX_MARKS = 600;
const MAX_MARK_CHARS = 60000; // all of one piece's comments together
const MAX_ITEM_BYTES = 390000;
// What students see the owners as until they pick something else.
const OWNER_DISPLAY_NAME = 'Mr. Goldwasser';

// A room's join code is two words, like "Starry whale". The lists are
// short, easy-to-spell words picked so no pairing can come out rude:
// colors, weather and gentle qualities; animals, plants and small
// everyday things. About 100 x 100, so ~10,000 codes.
const CODE_ADJECTIVES = ['Blue', 'Green', 'Red', 'Golden', 'Silver', 'Copper', 'Coral', 'Olive', 'Violet', 'Scarlet',
  'Amber', 'Ruby', 'Orange', 'Purple', 'Pink', 'Calm', 'Quiet', 'Bright', 'Brave', 'Swift', 'Gentle', 'Merry',
  'Sunny', 'Misty', 'Snowy', 'Breezy', 'Sandy', 'Mossy', 'Frosty', 'Tiny', 'Giant', 'Lucky', 'Jolly', 'Clever',
  'Noble', 'Wise', 'Bold', 'Early', 'Sleepy', 'Humble', 'Patient', 'Hidden', 'Wooden', 'Paper', 'Velvet', 'Cotton',
  'Maple', 'Cedar', 'Autumn', 'Spring', 'Winter', 'Summer', 'Polar', 'Starry', 'Rainy', 'Cloudy', 'Stormy', 'Windy',
  'Foggy', 'Icy', 'Kind', 'Friendly', 'Honest', 'Loyal', 'Happy', 'Cheerful', 'Playful', 'Nimble', 'Steady', 'Silent',
  'Shiny', 'Round', 'Tall', 'Little', 'Mighty', 'Speedy', 'Fluffy', 'Crisp', 'Fresh', 'Northern', 'Southern',
  'Eastern', 'Western', 'Mountain', 'Ocean', 'Desert', 'Evening', 'Morning', 'Midnight', 'Lunar', 'Solar', 'Cosmic',
  'Magic', 'Royal', 'Brass', 'Marble', 'Crystal', 'Glass', 'Stone', 'Iron'];
const CODE_NOUNS = ['trout', 'otter', 'heron', 'robin', 'finch', 'badger', 'rabbit', 'owl', 'fox', 'wren', 'moose',
  'seal', 'whale', 'crane', 'swan', 'lark', 'newt', 'frog', 'goose', 'llama', 'panda', 'koala', 'tiger', 'zebra',
  'camel', 'bison', 'falcon', 'hawk', 'raven', 'dove', 'puffin', 'walrus', 'beetle', 'cricket', 'acorn', 'pebble',
  'meadow', 'river', 'canyon', 'lantern', 'kettle', 'pencil', 'compass', 'anchor', 'button', 'ribbon', 'candle',
  'comet', 'planet', 'island', 'garden', 'willow', 'clover', 'tulip', 'daisy', 'fern', 'cactus', 'pine', 'teapot',
  'penguin', 'dolphin', 'turtle', 'salmon', 'parrot', 'pelican', 'sparrow', 'deer', 'elk', 'lion', 'bear', 'wolf',
  'lamb', 'kitten', 'puppy', 'pony', 'goat', 'mouse', 'hedgehog', 'gecko', 'octopus', 'starfish', 'oyster',
  'lobster', 'valley', 'volcano', 'cloud', 'rainbow', 'oak', 'birch', 'mitten', 'scarf', 'umbrella', 'bicycle',
  'violin', 'piano', 'trumpet', 'drum', 'kite', 'rocket', 'crayon', 'notebook', 'basket', 'teacup', 'ladder',
  'lighthouse', 'windmill', 'castle', 'bridge', 'tower'];

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}

function readJsonBody(event) {
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    return JSON.parse(raw || '{}');
  } catch (e) {
    return null;
  }
}

async function readItem(key) {
  const result = await ddb.send(new GetItemCommand({ TableName: TABLE_NAME, Key: { userId: { S: key } } }));
  if (!result.Item) return { state: null, ver: 0 };
  return { state: JSON.parse(result.Item.state.S), ver: Number(result.Item.ver?.N || 0) };
}

// Runs fn(state) on the item's current contents (null if it doesn't exist
// yet) and saves what fn returns, retrying from a fresh read if anyone
// else saved in between. fn must be free of side effects, since it may
// run more than once; it can throw an HttpError to give up, or return
// undefined to leave the item as it is.
async function mutate(key, fn) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const { state, ver } = await readItem(key);
    const next = fn(state);
    if (next === undefined) return state;
    const put = {
      TableName: TABLE_NAME,
      Item: {
        userId: { S: key },
        state: { S: JSON.stringify(next) },
        ver: { N: String(ver + 1) },
        updatedAt: { N: String(Date.now()) }
      },
      ConditionExpression: 'attribute_not_exists(userId)'
    };
    if (ver) {
      put.ConditionExpression = 'ver = :ver';
      put.ExpressionAttributeValues = { ':ver': { N: String(ver) } };
    }
    try {
      await ddb.send(new PutItemCommand(put));
      return next;
    } catch (e) {
      if (e.name !== 'ConditionalCheckFailedException') throw e;
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 80 * (attempt + 1)));
    }
  }
  throw new HttpError(503, 'busy');
}

const lower = (s) => String(s || '').trim().toLowerCase();

async function roleOf(info) {
  const email = lower(info.email);
  if (OWNER_EMAILS.includes(email)) return 'owner';
  const { state } = await readItem('luddite:teachers');
  return state && state.emails && state.emails[email] ? 'teacher' : 'student';
}

const pickOne = (list) => list[Math.floor(Math.random() * list.length)];

// { code: 'starrywhale', codeLabel: 'Starry whale' }. The stored code is
// just the letters, so however a student types it -- "Starry whale",
// "starry-whale", "STARRYWHALE" -- it finds the same room.
function newRoomCode() {
  const codeLabel = pickOne(CODE_ADJECTIVES) + ' ' + pickOne(CODE_NOUNS);
  return { code: codeLabel.toLowerCase().replace(/[^a-z]/g, ''), codeLabel };
}

function cleanCode(code) {
  const raw = String(code || '');
  // The first rooms had 5-character codes like "P6XVW" (every word code
  // is at least 6 letters, so these can't be confused with one).
  const old = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (old.length === 5) return old;
  const c = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (c.length < 6 || c.length > 40) throw new HttpError(404, 'no_room');
  return c;
}

async function displayNameOf(info, role) {
  const { state } = await readItem('luddite:teacher:' + info.sub);
  if (state && state.displayName) return state.displayName;
  return role === 'owner' ? OWNER_DISPLAY_NAME : (info.name || info.email || '');
}

async function getRoom(code) {
  const { state } = await readItem('luddite:room:' + code);
  if (!state) throw new HttpError(404, 'no_room');
  return state;
}

function ownsRoom(room, info, role) {
  return room.teacher.sub === info.sub || role === 'owner';
}

// A room as its teacher sees it on the dashboard list.
function roomSummary(room) {
  const students = Object.values(room.students || {});
  return {
    code: room.code, codeLabel: room.codeLabel || room.code, title: room.title, open: room.open, createdAt: room.createdAt,
    waiting: students.filter((s) => s.status === 'waiting').length,
    admitted: students.filter((s) => s.status === 'admitted').length,
    submissions: (room.submissions || []).length
  };
}

// A room as one student sees it: only their own place in it.
function studentView(room, sub) {
  const me = room.students[sub] || null;
  return {
    code: room.code, codeLabel: room.codeLabel || room.code, title: room.title, open: room.open,
    teacherName: room.teacher.name || room.teacher.email,
    status: me ? me.status : 'none',
    leaves: me ? me.leaves || 0 : 0,
    submittedAt: me ? me.submittedAt || 0 : 0
  };
}

// ---- Drive ----
// A teacher connects Drive once from the dashboard: the page gets a
// one-time code from Google (scope drive.file, which only reaches files
// Luddite itself creates) and sends it here, where it's swapped for a
// refresh token kept in luddite:drive:<sub>. Each submission is then
// written into "Luddite submissions / <room title> (<code>)" in their Drive
// as a Google Doc, whether or not the teacher is online.
const driveTokens = new Map(); // teacher sub -> { token, exp }, per warm container

async function googleToken(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: LUDDITE_CLIENT_ID, client_secret: LUDDITE_CLIENT_SECRET, ...params })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new HttpError(res.status === 400 ? 409 : 502, data.error === 'invalid_grant' ? 'drive_revoked' : 'drive_failed');
    err.detail = data.error;
    throw err;
  }
  return data;
}

async function connectDrive(info, code) {
  if (!LUDDITE_CLIENT_SECRET) throw new HttpError(503, 'drive_not_configured');
  const data = await googleToken({ code, grant_type: 'authorization_code', redirect_uri: 'postmessage' });
  if (!String(data.scope || '').includes('https://www.googleapis.com/auth/drive.file')) throw new HttpError(409, 'drive_not_granted');
  let email = '';
  try { email = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString('utf8')).email || ''; } catch (e) {}
  await mutate('luddite:drive:' + info.sub, (d) => {
    const refreshToken = data.refresh_token || (d && d.email === email ? d.refreshToken : '');
    if (!refreshToken) throw new HttpError(409, 'drive_no_refresh');
    // Another Google account means other folders; start fresh.
    const keep = d && d.email === email;
    return { refreshToken, email, rootId: keep ? d.rootId : null, roomFolders: keep ? d.roomFolders : {}, connectedAt: Date.now() };
  });
  driveTokens.delete(info.sub);
  if (data.access_token) driveTokens.set(info.sub, { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 });
  return { connected: true, email };
}

async function driveAccessToken(teacherSub, drive) {
  const cached = driveTokens.get(teacherSub);
  if (cached && cached.exp > Date.now()) return cached.token;
  const data = await googleToken({ refresh_token: drive.refreshToken, grant_type: 'refresh_token' });
  driveTokens.set(teacherSub, { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 });
  return data.access_token;
}

async function driveCall(token, url, init) {
  const res = await fetch(url, { ...init, headers: { Authorization: 'Bearer ' + token, ...(init.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new HttpError(res.status === 404 ? 404 : 502, res.status === 404 ? 'drive_folder_missing' : 'drive_failed');
    err.detail = data.error && data.error.message;
    throw err;
  }
  return data;
}

function createFolder(token, name, parentId) {
  return driveCall(token, 'https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : undefined })
  }).then((f) => f.id);
}

// The room's folder id, creating "Luddite submissions" and the room's
// folder the first time (or again, if the teacher deleted them).
async function roomFolder(teacherSub, token, room, fresh) {
  let { state: drive } = await readItem('luddite:drive:' + teacherSub);
  if (!fresh && drive.roomFolders && drive.roomFolders[room.code]) return drive.roomFolders[room.code];
  const rootId = (!fresh && drive.rootId) || await createFolder(token, 'Luddite submissions');
  const folderId = await createFolder(token, room.title + ' (' + (room.codeLabel || room.code) + ')', rootId);
  await mutate('luddite:drive:' + teacherSub, (d) => ({ ...d, rootId, roomFolders: { ...(d.roomFolders || {}), [room.code]: folderId } }));
  return folderId;
}

async function saveToDrive(room, doc) {
  const { state: drive } = await readItem('luddite:drive:' + room.teacher.sub);
  if (!drive || !drive.refreshToken) throw new HttpError(409, 'teacher_no_drive');
  const token = await driveAccessToken(room.teacher.sub, drive);
  const upload = async (folderId) => {
    const boundary = 'luddite' + Math.random().toString(36).slice(2);
    const meta = { name: doc.name, mimeType: 'application/vnd.google-apps.document', parents: [folderId], description: doc.description };
    const body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) +
      '\r\n--' + boundary + '\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' + doc.text + '\r\n--' + boundary + '--';
    return driveCall(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
      body
    });
  };
  try {
    return await upload(await roomFolder(room.teacher.sub, token, room, false));
  } catch (e) {
    if (e.message !== 'drive_folder_missing') throw e;
    return upload(await roomFolder(room.teacher.sub, token, room, true));
  }
}

// ---- Marks ----
// The piece's own teacher (or an owner) may read and mark it.
async function ownSub(id, me, role) {
  const key = String(id || '');
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw new HttpError(404, 'no_sub');
  const { state } = await readItem('luddite:sub:' + key);
  if (!state) throw new HttpError(404, 'no_sub');
  if (state.teacherSub !== me.sub && role !== 'owner') throw new HttpError(403, 'not_your_student');
  return state;
}

// margin: a note beside words [start, end). strike: words crossed out.
// insert: the teacher's own words written into the text at `start`.
function cleanMarks(list, length) {
  if (!Array.isArray(list)) throw new HttpError(400, 'bad_marks');
  if (list.length > MAX_MARKS) throw new HttpError(413, 'too_many_marks');
  let chars = 0;
  const out = list.map((m) => {
    const type = m && m.type;
    if (!['margin', 'strike', 'insert'].includes(type)) throw new HttpError(400, 'bad_marks');
    const start = Math.max(0, Math.min(length, Math.floor(Number(m.start) || 0)));
    const end = type === 'insert' ? start : Math.max(start, Math.min(length, Math.floor(Number(m.end) || 0)));
    if (type !== 'insert' && end === start) throw new HttpError(400, 'bad_marks');
    const note = String(m.note || '').slice(0, 2000);
    if (type === 'insert' && !note.trim()) throw new HttpError(400, 'bad_marks');
    chars += note.length;
    return { id: String(m.id || '').slice(0, 40) || randomUUID().slice(0, 8), type, start, end, note, at: Number(m.at) || Date.now() };
  });
  if (chars > MAX_MARK_CHARS) throw new HttpError(413, 'too_many_marks');
  return out;
}

// ---- Routes ----
async function handleLuddite(event, method, path, info) {
  try {
    return await routeLuddite(event, method, path, info);
  } catch (e) {
    if (e instanceof HttpError) return respond(e.status, { error: e.message, detail: e.detail });
    throw e;
  }
}

async function routeLuddite(event, method, path, info) {
  const q = event.queryStringParameters || {};
  const body = method === 'PUT' ? readJsonBody(event) : {};
  if (!body) return respond(400, { error: 'Invalid JSON body' });
  const role = await roleOf(info);
  const isTeacher = role === 'owner' || role === 'teacher';
  const me = { sub: info.sub, email: info.email || '', name: info.name || '' };

  // GET /luddite/status -- who is this, and what can they do?
  if (path === '/luddite/status' && method === 'GET') {
    const session = issueSession(info);
    return respond(200, { luddite: { role, email: me.email, name: me.name }, session });
  }

  // ---- Students (anyone signed in) ----

  // PUT /luddite/join { code } -- ask into a room's waiting room.
  if (path === '/luddite/join' && method === 'PUT') {
    const code = cleanCode(body.code);
    const room = await mutate('luddite:room:' + code, (r) => {
      if (!r) throw new HttpError(404, 'no_room');
      const s = r.students[me.sub];
      if (s) {
        if (s.email === me.email && s.name === me.name) return undefined;
        return { ...r, students: { ...r.students, [me.sub]: { ...s, email: me.email, name: me.name } } };
      }
      if (!r.open) throw new HttpError(403, 'room_closed');
      return { ...r, students: { ...r.students, [me.sub]: { email: me.email, name: me.name, status: 'waiting', requestedAt: Date.now(), leaves: 0, words: 0 } } };
    });
    return respond(200, { room: studentView(room, me.sub) });
  }

  // GET /luddite/room?code= -- a student's place in the room (polled while
  // waiting), or the whole room for its teacher (polled on the dashboard).
  if (path === '/luddite/room' && method === 'GET') {
    const room = await getRoom(cleanCode(q.code));
    if (isTeacher && ownsRoom(room, info, role)) return respond(200, { room, drive: await driveStatus(room.teacher.sub) });
    return respond(200, { room: studentView(room, me.sub) });
  }

  // PUT /luddite/event { code, type: 'left' | 'writing' | 'idle', words }
  // -- live status for the teacher: leaving the page, and word counts.
  if (path === '/luddite/event' && method === 'PUT') {
    const code = cleanCode(body.code);
    const room = await mutate('luddite:room:' + code, (r) => {
      const s = r && r.students[me.sub];
      if (!s || s.status !== 'admitted') return undefined;
      const next = { ...s, lastSeen: Date.now() };
      // `away` means locked out right now, until they go back to writing.
      if (body.type === 'left') Object.assign(next, { leaves: (s.leaves || 0) + 1, away: true, writing: false });
      if (body.type === 'writing' || body.type === 'idle') Object.assign(next, { away: false, writing: body.type === 'writing' });
      if (Number.isFinite(body.words)) next.words = Math.max(0, Math.floor(body.words));
      return { ...r, students: { ...r.students, [me.sub]: next } };
    });
    if (!room) throw new HttpError(404, 'no_room');
    return respond(200, { room: studentView(room, me.sub) });
  }

  // PUT /luddite/submit { code, text, words, label } -- hand the piece in.
  if (path === '/luddite/submit' && method === 'PUT') {
    const code = cleanCode(body.code);
    const room = await getRoom(code);
    const s = room.students[me.sub];
    if (!s || s.status !== 'admitted') throw new HttpError(403, 'not_admitted');
    const text = String(body.text || '');
    if (!text.trim()) throw new HttpError(400, 'empty');
    if (text.length > MAX_SUBMISSION_CHARS) throw new HttpError(413, 'too_long');
    const words = (text.trim().match(/\S+/g) || []).length;
    const label = String(body.label || '').replace(/[\r\n\/\\]/g, ' ').slice(0, 60) || new Date().toISOString().slice(0, 16);
    const who = me.name || me.email;
    // Drive is where the teacher keeps it; Luddite keeps its own copy to
    // mark up. A Drive hiccup (or no Drive yet) no longer loses the piece.
    let file = null, driveError = null;
    try {
      file = await saveToDrive(room, {
        name: who + ' — ' + label,
        description: 'Submitted through Luddite by ' + who + ' (' + me.email + '), room ' + room.title + ' (' + code + '). ' +
          words + ' words. Left the page ' + (s.leaves || 0) + (s.leaves === 1 ? ' time.' : ' times.'),
        text
      });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      driveError = e.message;
    }
    const stored = text.length <= MAX_STORED_CHARS;
    if (!file && !stored) throw new HttpError(409, driveError);
    const at = Date.now();
    const id = file ? file.id : 'l' + randomUUID();
    const submission = { id, sub: me.sub, email: me.email, name: me.name, words, leaves: s.leaves || 0, at,
      link: file ? file.webViewLink : null, stored, driveError, marked: 0 };
    if (stored) {
      await mutate('luddite:sub:' + id, () => ({
        id, code, roomTitle: room.title, teacherSub: room.teacher.sub, sub: me.sub, email: me.email, name: me.name,
        label, text, words, leaves: s.leaves || 0, at, link: submission.link, marks: [], endComment: ''
      }));
      const email = me.email.toLowerCase();
      await mutate('luddite:tstudent:' + room.teacher.sub + ':' + email, (t) => ({
        email, name: me.name || (t && t.name) || '',
        subs: [{ id, at, roomTitle: room.title, label, words }, ...((t && t.subs) || [])]
      }));
      await mutate('luddite:teacher:' + room.teacher.sub, (t) => {
        const students = { ...((t && t.students) || {}) };
        const prev = students[email] || { count: 0 };
        students[email] = { name: me.name || prev.name || '', last: at, count: prev.count + 1 };
        return { ...(t || { rooms: [] }), students };
      });
    }
    const saved = await mutate('luddite:room:' + code, (r) => ({
      ...r,
      submissions: [submission, ...(r.submissions || [])],
      students: { ...r.students, [me.sub]: { ...r.students[me.sub], submittedAt: submission.at, submissions: (r.students[me.sub].submissions || 0) + 1, words } }
    }));
    return respond(200, { room: studentView(saved, me.sub) });
  }

  if (!isTeacher) return respond(403, { error: 'teachers_only' });

  // ---- Teachers ----

  // GET /luddite/rooms -- this teacher's rooms, newest first.
  if (path === '/luddite/rooms' && method === 'GET') {
    const { state } = await readItem('luddite:teacher:' + me.sub);
    const codes = (state && state.rooms) || [];
    const rooms = (await Promise.all(codes.map((c) => readItem('luddite:room:' + c)))).map((r) => r.state).filter(Boolean);
    return respond(200, {
      rooms: rooms.map(roomSummary),
      drive: await driveStatus(me.sub),
      displayName: (state && state.displayName) || (role === 'owner' ? OWNER_DISPLAY_NAME : me.name || me.email)
    });
  }

  // ---- Marking up handed-in work ----

  // GET /luddite/sub?id= -- one piece with its marks, for its teacher.
  if (path === '/luddite/sub' && method === 'GET') {
    return respond(200, { sub: await ownSub(q.id, me, role) });
  }

  // PUT /luddite/marks { id, marks, endComment } -- the teacher's comments,
  // cross-outs and insertions, all anchored to character offsets in the
  // (never-changing) text.
  if (path === '/luddite/marks' && method === 'PUT') {
    const piece = await ownSub(body.id, me, role);
    const marks = cleanMarks(body.marks, piece.text.length);
    const endComment = String(body.endComment || '').slice(0, 8000);
    const saved = await mutate('luddite:sub:' + piece.id, (x) => {
      const next = { ...x, marks, endComment, markedAt: Date.now() };
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_ITEM_BYTES) throw new HttpError(413, 'too_many_marks');
      return next;
    });
    // The room's list shows which pieces have been marked.
    const count = marks.length + (endComment.trim() ? 1 : 0);
    await mutate('luddite:room:' + piece.code, (r) => {
      if (!r) return undefined;
      const i = (r.submissions || []).findIndex((x) => x.id === piece.id);
      if (i === -1 || r.submissions[i].marked === count) return undefined;
      const submissions = r.submissions.slice();
      submissions[i] = { ...submissions[i], marked: count };
      return { ...r, submissions };
    }).catch(() => {});
    return respond(200, { ok: true, markedAt: saved.markedAt });
  }

  // GET /luddite/students -- everyone who has handed work in to this teacher.
  if (path === '/luddite/students' && method === 'GET') {
    const { state } = await readItem('luddite:teacher:' + me.sub);
    const students = Object.entries((state && state.students) || {})
      .map(([email, x]) => ({ email, name: x.name, last: x.last, count: x.count }))
      .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
    return respond(200, { students });
  }

  // GET /luddite/student?email= -- one student's year: every piece handed in
  // to this teacher, with each comment and the words it was about.
  if (path === '/luddite/student' && method === 'GET') {
    const email = String(q.email || '').toLowerCase();
    const { state } = await readItem('luddite:tstudent:' + me.sub + ':' + email);
    if (!state) throw new HttpError(404, 'no_student');
    const pieces = [];
    for (let i = 0; i < state.subs.length; i += 10) {
      const batch = await Promise.all(state.subs.slice(i, i + 10).map((x) => readItem('luddite:sub:' + x.id)));
      batch.forEach(({ state: p }, j) => {
        const x = state.subs[i + j];
        if (!p) return pieces.push({ ...x, missing: true, marks: [], endComment: '' });
        const quote = (a, b) => { const t = p.text.slice(a, b).replace(/\s+/g, ' ').trim(); return t.length > 240 ? t.slice(0, 237) + '…' : t; };
        pieces.push({
          id: p.id, at: p.at, roomTitle: p.roomTitle, label: p.label, words: p.words, link: p.link, endComment: p.endComment || '',
          marks: (p.marks || []).slice().sort((a, b) => a.start - b.start).map((m) => ({
            type: m.type, note: m.note || '', quote: m.type === 'insert' ? quote(Math.max(0, m.start - 40), m.start) : quote(m.start, m.end)
          }))
        });
      });
    }
    return respond(200, { student: { email: state.email, name: state.name }, pieces });
  }

  // PUT /luddite/me { displayName } -- what students see this teacher as.
  if (path === '/luddite/me' && method === 'PUT') {
    const displayName = String(body.displayName || '').trim().slice(0, 60);
    if (!displayName) throw new HttpError(400, 'empty');
    await mutate('luddite:teacher:' + me.sub, (t) => ({ ...(t || { rooms: [] }), displayName }));
    return respond(200, { displayName });
  }

  // PUT /luddite/rooms { title } -- open a new room with a fresh two-word code.
  if (path === '/luddite/rooms' && method === 'PUT') {
    const teacher = { ...me, name: await displayNameOf(info, role) };
    const title = String(body.title || '').trim().slice(0, 80) || teacher.name;
    let room = null;
    for (let i = 0; i < 12 && !room; i++) {
      const { code, codeLabel } = newRoomCode();
      try {
        room = await mutate('luddite:room:' + code, (r) => {
          if (r) throw new HttpError(409, 'code_taken');
          return { code, codeLabel, title, teacher, open: true, createdAt: Date.now(), students: {}, submissions: [] };
        });
      } catch (e) {
        if (e.message !== 'code_taken') throw e;
      }
    }
    if (!room) throw new HttpError(503, 'busy');
    await mutate('luddite:teacher:' + me.sub, (t) => ({ ...(t || {}), rooms: [room.code, ...((t && t.rooms) || [])] }));
    return respond(200, { room });
  }

  // PUT /luddite/room { code, action, subs } -- admit | admitAll | remove |
  // close | open | delete (delete only takes it off the teacher's list).
  if (path === '/luddite/room' && method === 'PUT') {
    const code = cleanCode(body.code);
    const subs = Array.isArray(body.subs) ? body.subs : [];
    const room = await mutate('luddite:room:' + code, (r) => {
      if (!r) throw new HttpError(404, 'no_room');
      if (!ownsRoom(r, info, role)) throw new HttpError(403, 'not_your_room');
      const students = { ...r.students };
      const set = (sub, status) => {
        if (students[sub]) students[sub] = { ...students[sub], status, decidedAt: Date.now() };
      };
      if (body.action === 'admit') subs.forEach((sub) => set(sub, 'admitted'));
      else if (body.action === 'admitAll') Object.keys(students).forEach((sub) => { if (students[sub].status === 'waiting') set(sub, 'admitted'); });
      else if (body.action === 'remove') subs.forEach((sub) => set(sub, 'removed'));
      else if (body.action === 'close') return { ...r, open: false };
      else if (body.action === 'open') return { ...r, open: true };
      else if (body.action === 'delete') return { ...r, open: false, deletedAt: Date.now() };
      else throw new HttpError(400, 'bad_action');
      return { ...r, students };
    });
    if (body.action === 'delete') {
      await mutate('luddite:teacher:' + room.teacher.sub, (t) => ({ ...(t || {}), rooms: ((t && t.rooms) || []).filter((c) => c !== code) }));
    }
    return respond(200, { room });
  }

  // PUT /luddite/drive { code } connects Drive; { disconnect: true } forgets it.
  if (path === '/luddite/drive' && method === 'PUT') {
    if (body.disconnect) {
      await mutate('luddite:drive:' + me.sub, (d) => (d ? { ...d, refreshToken: '' } : undefined));
      driveTokens.delete(me.sub);
      return respond(200, { drive: { connected: false } });
    }
    if (!body.code) throw new HttpError(400, 'missing_code');
    return respond(200, { drive: await connectDrive(info, String(body.code)) });
  }

  if (role !== 'owner') return respond(403, { error: 'owners_only' });

  // ---- Owners ----

  // GET /luddite/teachers; PUT { add: email } or { remove: email }.
  if (path === '/luddite/teachers') {
    let state;
    if (method === 'PUT') {
      const add = lower(body.add);
      const remove = lower(body.remove);
      if (add && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(add)) throw new HttpError(400, 'bad_email');
      state = await mutate('luddite:teachers', (t) => {
        const emails = { ...((t && t.emails) || {}) };
        if (add) emails[add] = { addedAt: Date.now() };
        if (remove) delete emails[remove];
        return { emails };
      });
    } else {
      state = (await readItem('luddite:teachers')).state;
    }
    const emails = (state && state.emails) || {};
    return respond(200, { owners: OWNER_EMAILS, teachers: Object.keys(emails).sort().map((email) => ({ email, addedAt: emails[email].addedAt })) });
  }

  return respond(404, { error: 'Not found' });
}

async function driveStatus(teacherSub) {
  const { state } = await readItem('luddite:drive:' + teacherSub);
  return { connected: !!(state && state.refreshToken), email: (state && state.email) || '', configured: !!LUDDITE_CLIENT_SECRET };
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

  // Session tokens only exist for verified Google accounts; a raw Google
  // token must say so itself before its email can count for anything.
  if (path.startsWith('/luddite/')) {
    if (!token.startsWith('s1.') && info.email_verified !== 'true' && info.email_verified !== true) {
      return respond(403, { error: 'Unverified email' });
    }
    return handleLuddite(event, method, path, info);
  }

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
