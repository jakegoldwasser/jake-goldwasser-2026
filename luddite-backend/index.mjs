import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { createHmac, timingSafeEqual, randomUUID, randomBytes } from 'node:crypto';

// The AWS Lambda behind Luddite (/luddite/ on the site): assignments,
// classes, waiting rooms, hand-ins, mark-up and Google Drive. It is Luddite's alone: its own
// function, its own DynamoDB table and its own secrets, sharing nothing
// with Bookbug (cloud-sync-backend/). See README.md for setting it up.
// One file, no build step.

const TABLE_NAME = process.env.TABLE_NAME || 'LudditeData';
// Luddite signs people in through its own Google app (Google Cloud project
// "Luddite"); only tokens minted for it are accepted.
const LUDDITE_CLIENT_ID = process.env.LUDDITE_GOOGLE_CLIENT_ID || '522963753495-m1qigb1q8ct9rmmrh56fkv7r3hs2psap.apps.googleusercontent.com';
// Signs this backend's own session tokens (see issueSession). Luddite's
// alone. If SESSION_SECRET isn't set, one is generated on first use and kept
// in the table (see loadSessionSecret), so there's nothing to paste.
let SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const ddb = new DynamoDBClient({});

// CORS is handled entirely by the Function URL's own config (see README.md),
// which applies it to every response. Setting it here too would duplicate
// the header, and browsers reject a response with two Allow-Origin values.
function respond(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj)
  };
}

// Offloads signature checking to Google itself instead of implementing
// JWT/JWKS by hand: simple, and fine at this scale.
async function verifyGoogleToken(idToken) {
  const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (!res.ok) return null;
  const info = await res.json();
  if (!info.sub || info.aud !== LUDDITE_CLIENT_ID) return null;
  return info;
}

// Google ID tokens only live ~1hr, so once one checks out this backend
// hands back its own session token -- "s1.<base64url JSON payload>.<HMAC>"
// -- good for 30 days and re-issued on each status check, so regular use
// keeps sliding the window forward.
async function loadSessionSecret() {
  if (SESSION_SECRET) return;
  const { state } = await readItem('luddite:config');
  if (state && state.sessionSecret) { SESSION_SECRET = state.sessionSecret; return; }
  const made = await mutate('luddite:config', (c) => (c && c.sessionSecret ? undefined : { ...(c || {}), sessionSecret: randomBytes(48).toString('base64url') }));
  SESSION_SECRET = made.sessionSecret;
}
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

// ---------------------------------------------------------------------
// Luddite (/luddite/ on the site): a locked-down writing page.
//
// OWNER_EMAILS run the site and choose who counts as a teacher. A teacher
// makes classes (a list of email addresses) and assignments. An assignment
// has a two-word Entry Phrase anyone can use (through the waiting room), a
// start time and a length; students on its class's list are let in on their
// own once it has started. A teacher can give one student their own time
// (a different start, extra time, or both). Students sign in with Google,
// write, and hand in -- the paper becomes a Google Doc in that assignment's
// teacher's Google Drive (see the Drive section below).
//
// (Assignments are still stored under the older key name `luddite:room:`;
// the stored data wasn't renamed.)
//
// Items in Luddite's own table (partition key `pk`):
//   luddite:teachers        { emails: { [email]: { addedAt } } }
//   luddite:teacher:<sub>   { rooms: [code, ...], classes: [id, ...] }  newest first
//   luddite:class:<id>      { id, name, teacher: { sub, email, name }, emails: [...],
//                             assignments: [code, ...] newest first, createdAt }
//   luddite:mine:<email>    { classes: [id, ...], own: [code, ...] }: how a
//                           student's login finds their assignments (their
//                           classes' assignments, and ones with their own time)
//   luddite:room:<code>     { code, title, teacher: { sub, email, name },
//                             classId, startAt, minutes, endedAt, open,
//                             own: { [email]: { startAt, multiplier } },
//                             createdAt, students: { [sub]: {...} },
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
const MAX_CLASS_EMAILS = 400;
const MAX_CLASS_ASSIGNMENTS = 30; // a class keeps this many of its newest assignments
const MINE_ASSIGNMENTS_PER_CLASS = 8; // a login looks at each class's newest few
const MAX_MINUTES = 300;
const UPCOMING_HORIZON_MS = 48 * 60 * 60 * 1000;
// A paper handed in this long after a student's time ran out is marked late.
const LATE_GRACE_MS = 2 * 60 * 1000;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
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
  const result = await ddb.send(new GetItemCommand({ TableName: TABLE_NAME, Key: { pk: { S: key } } }));
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
        pk: { S: key },
        state: { S: JSON.stringify(next) },
        ver: { N: String(ver + 1) },
        updatedAt: { N: String(Date.now()) }
      },
      ConditionExpression: 'attribute_not_exists(pk)'
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

// ---- When an assignment runs ----
// The regular window is startAt (or, for the first rooms, createdAt) for
// `minutes`. Closing it early sets endedAt, which only stops new people
// getting in. A student with their own time has their own window: their own
// start (or the regular one), and the length times their multiplier.
const regularEnded = (r) => !!r.endedAt || r.open === false;
function regularWindow(r) {
  const start = r.startAt || r.createdAt;
  return { start, end: r.minutes ? start + r.minutes * 60000 : null };
}
function windowOf(room, email) {
  const reg = regularWindow(room);
  const o = room.own && room.own[email];
  if (!o) return { ...reg, own: false, multiplier: 1, ended: regularEnded(room) };
  const start = o.startAt || reg.start;
  const multiplier = o.multiplier || 1;
  return { start, end: room.minutes ? start + Math.round(room.minutes * multiplier * 60000) : null, own: true, multiplier, ended: false };
}
function stateAt(win, now) {
  if (win.ended) return 'ended';
  if (now < win.start) return 'upcoming';
  if (win.end && now >= win.end) return 'ended';
  return 'running';
}

async function onRoster(room, email) {
  if (!room.classId) return false;
  const { state } = await readItem('luddite:class:' + room.classId);
  return !!(state && state.emails.includes(email));
}

// An assignment as its teacher sees it on Home.
function roomSummary(room) {
  const students = Object.values(room.students || {});
  const reg = regularWindow(room);
  const state = stateAt({ ...reg, ended: regularEnded(room) }, Date.now());
  return {
    code: room.code, codeLabel: room.codeLabel || room.code, title: room.title, open: state === 'running', state, createdAt: room.createdAt,
    classId: room.classId || null, startAt: reg.start, endAt: reg.end, minutes: room.minutes || null,
    ownCount: Object.keys(room.own || {}).length,
    waiting: students.filter((s) => s.status === 'waiting').length,
    admitted: students.filter((s) => s.status === 'admitted').length,
    submissions: (room.submissions || []).length
  };
}

// An assignment as one student sees it: only their own place in it, and
// their own window (which may differ from everyone else's).
function studentView(room, sub, email) {
  const me = room.students[sub] || null;
  const win = windowOf(room, lower(email));
  const now = Date.now();
  const state = stateAt(win, now);
  return {
    code: room.code, codeLabel: room.codeLabel || room.code, title: room.title, open: state === 'running',
    state, startAt: win.start, endAt: win.end, own: win.own, multiplier: win.multiplier, minutes: room.minutes || null, now,
    teacherName: room.teacher.name || room.teacher.email,
    status: me ? me.status : 'none',
    leaves: me ? me.leaves || 0 : 0,
    submittedAt: me ? me.submittedAt || 0 : 0,
    // Handing in is final: no more writing until the teacher releases them.
    handedIn: !!(me && me.handedIn)
  };
}

// ---- Classes ----
// A class is a list of email addresses. Each address gets a luddite:mine
// item naming its classes, which is how that student's login finds the
// class's assignments.
function cleanEmails(list) {
  const seen = new Set();
  const out = [];
  (Array.isArray(list) ? list : []).forEach((e) => {
    // "Jane Smith <jane@school.org>" counts as jane@school.org.
    const found = String(e || '').match(/[^\s<>,;"']+@[^\s<>,;"']+\.[^\s<>,;"']+/);
    const x = found ? lower(found[0]) : '';
    if (EMAIL_RE.test(x) && !seen.has(x)) { seen.add(x); out.push(x); }
  });
  return out;
}

async function inBatches(items, fn) {
  for (let i = 0; i < items.length; i += 10) await Promise.all(items.slice(i, i + 10).map(fn));
}

async function indexClass(classId, add, remove) {
  await inBatches(add, (email) => mutate('luddite:mine:' + email, (m) => {
    const classes = (m && m.classes) || [];
    return classes.includes(classId) ? undefined : { ...(m || {}), classes: [classId, ...classes] };
  }));
  await inBatches(remove, (email) => mutate('luddite:mine:' + email, (m) => {
    const classes = (m && m.classes) || [];
    return classes.includes(classId) ? { ...m, classes: classes.filter((c) => c !== classId) } : undefined;
  }));
}

async function getClass(id, me, role) {
  const key = String(id || '');
  if (!/^[a-f0-9]{12}$/.test(key)) throw new HttpError(404, 'no_class');
  const { state } = await readItem('luddite:class:' + key);
  if (!state || state.deletedAt) throw new HttpError(404, 'no_class');
  if (state.teacher.sub !== me.sub && role !== 'owner') throw new HttpError(403, 'not_your_class');
  return state;
}

const classSummary = (c) => ({ id: c.id, name: c.name, count: c.emails.length, createdAt: c.createdAt });

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

// The marked-up piece as HTML, which Drive turns into a Google Doc: the
// teacher's words in green (bold/italic as typed), crossed-out words struck
// through, commented words highlighted with a number, then the comments,
// the end comment and the grade.
const escHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PEN = '#2f6b3a';
function markedHtml(piece) {
  const text = piece.text, marks = piece.marks || [];
  const margins = marks.filter((m) => m.type === 'margin').sort((a, b) => a.start - b.start || a.end - b.end);
  const num = new Map(margins.map((m, i) => [m.id, i + 1]));
  const cuts = new Set([0, text.length]);
  marks.forEach((m) => { cuts.add(m.start); cuts.add(m.end); });
  const pts = [...cuts].sort((a, b) => a - b);
  const pen = (inner) => '<span style="color:' + PEN + '">' + inner + '</span>';
  let body = '';
  pts.forEach((p, i) => {
    margins.forEach((m) => { if (m.end === p) body += pen('<sup>[' + num.get(m.id) + ']</sup>'); });
    marks.forEach((m) => {
      if (m.type !== 'insert' || m.start !== p) return;
      const f = String(m.fmt || '').padEnd(m.note.length, ' ');
      let runs = '', cur = '', curF = null;
      const flush = () => {
        if (curF === null) return;
        let h = escHtml(cur);
        if (curF === 'b' || curF === 'x') h = '<b>' + h + '</b>';
        if (curF === 'i' || curF === 'x') h = '<i>' + h + '</i>';
        runs += h; cur = '';
      };
      for (let k = 0; k < m.note.length; k++) {
        if (f[k] !== curF) { flush(); curF = f[k]; }
        cur += m.note[k];
      }
      flush();
      body += pen('\u2038' + runs) + ' ';
    });
    const next = pts[i + 1];
    if (next === undefined || next === p) return;
    let h = escHtml(text.slice(p, next)).replace(/\n/g, '<br>');
    const on = marks.filter((m) => m.type !== 'insert' && m.start <= p && m.end >= next);
    if (on.some((m) => m.type === 'strike')) h = '<s style="text-decoration-color:' + PEN + '">' + h + '</s>';
    if (on.some((m) => m.type === 'margin')) h = '<span style="background-color:#e3f0e3">' + h + '</span>';
    body += h;
  });
  let html = '<html><body><p style="font-size:11pt"><b>' + escHtml(piece.name || piece.email) + '</b> \u2014 ' + escHtml(piece.roomTitle || '') + '</p>';
  if (piece.grade) html += '<p style="color:' + PEN + ';font-size:14pt"><b>Grade: ' + escHtml(piece.grade) + '</b></p>';
  html += '<p>' + body + '</p>';
  if (margins.length) {
    html += '<hr><p style="color:' + PEN + '"><b>Comments</b></p>';
    margins.forEach((m) => {
      const q = text.slice(m.start, m.end).replace(/\s+/g, ' ').trim();
      html += '<p style="color:' + PEN + '">[' + num.get(m.id) + '] \u201c' + escHtml(q.length > 80 ? q.slice(0, 77) + '\u2026' : q) + '\u201d \u2014 ' + escHtml(m.note) + '</p>';
    });
  }
  if (piece.endComment && piece.endComment.trim()) {
    html += '<hr><p style="color:' + PEN + '"><b>End comment</b></p><p style="color:' + PEN + '">' + escHtml(piece.endComment).replace(/\n/g, '<br>') + '</p>';
  }
  return html + '</body></html>';
}

// Replace the piece's Google Doc with its marked-up version. The piece's id
// is the Doc's file id when it reached Drive. Best effort: marks are kept
// here either way.
async function updateDriveDoc(teacherSub, piece) {
  if (!piece.link || !/^[A-Za-z0-9_-]{10,}$/.test(piece.id)) return;
  const { state: drive } = await readItem('luddite:drive:' + teacherSub);
  if (!drive || !drive.refreshToken) return;
  const token = await driveAccessToken(teacherSub, drive);
  await driveCall(token, 'https://www.googleapis.com/upload/drive/v3/files/' + piece.id + '?uploadType=media&fields=id', {
    method: 'PATCH',
    headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    body: markedHtml(piece)
  });
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
    const mark = { id: String(m.id || '').slice(0, 40) || randomUUID().slice(0, 8), type, start, end, note, at: Number(m.at) || Date.now() };
    // An insert's look, letter by letter: ' ' plain, 'b' bold, 'i' italic, 'x' both.
    if (type === 'insert') {
      const f = String(m.fmt || '').replace(/[^bix ]/g, ' ').slice(0, note.length);
      if (/[bix]/.test(f)) mark.fmt = f.padEnd(note.length, ' ');
    }
    return mark;
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
  // Pages loaded before assignments existed still ask for /rooms.
  path = path.replace(/^\/luddite\/rooms$/, '/luddite/assignments').replace(/^\/luddite\/room$/, '/luddite/assignment');
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

  // GET /luddite/mine -- the assignments this student's login should find:
  // those of the classes they're on, and any they have their own time for,
  // that are running now or start within two days.
  if (path === '/luddite/mine' && method === 'GET') {
    const em = lower(me.email);
    const now = Date.now();
    const { state: mine } = await readItem('luddite:mine:' + em);
    const codes = new Set((mine && mine.own) || []);
    const viaClass = new Set();
    const classes = await Promise.all(((mine && mine.classes) || []).map((id) => readItem('luddite:class:' + id)));
    classes.forEach(({ state: c }) => {
      if (!c || c.deletedAt || !c.emails.includes(em)) return;
      (c.assignments || []).slice(0, MINE_ASSIGNMENTS_PER_CLASS).forEach((code) => { codes.add(code); viaClass.add(code); });
    });
    const rooms = await Promise.all([...codes].map((c) => readItem('luddite:room:' + c)));
    const list = [];
    rooms.forEach(({ state: r }) => {
      if (!r || r.deletedAt) return;
      if (!viaClass.has(r.code) && !(r.own && r.own[em])) return;
      const s = r.students[me.sub];
      if (s && s.status === 'removed') return;
      const win = windowOf(r, em);
      const state = stateAt(win, now);
      if (state === 'ended' || (state === 'upcoming' && win.start - now > UPCOMING_HORIZON_MS)) return;
      list.push({
        code: r.code, codeLabel: r.codeLabel || r.code, title: r.title, teacherName: r.teacher.name || r.teacher.email,
        state, startAt: win.start, endAt: win.end, own: win.own, multiplier: win.multiplier,
        status: s ? s.status : 'none', handedIn: !!(s && s.handedIn)
      });
    });
    list.sort((a, b) => (a.state === b.state ? a.startAt - b.startAt : a.state === 'running' ? -1 : 1));
    return respond(200, { assignments: list, now });
  }

  // PUT /luddite/join { code } -- go into an assignment. Someone on its
  // class's list (or with their own time for it) is let straight in once it
  // has started; anyone else with the Entry Phrase asks into the waiting room.
  if (path === '/luddite/join' && method === 'PUT') {
    const code = cleanCode(body.code);
    const em = lower(me.email);
    const before = await getRoom(code);
    const rostered = await onRoster(before, em);
    const room = await mutate('luddite:room:' + code, (r) => {
      if (!r || r.deletedAt) throw new HttpError(404, 'no_room');
      const expected = !!(rostered || (r.own && r.own[em]));
      const win = windowOf(r, em);
      const state = stateAt(win, Date.now());
      const s = r.students[me.sub];
      if (s) {
        let next = s;
        if (s.email !== me.email || s.name !== me.name) next = { ...next, email: me.email, name: me.name };
        // Added to the class (or given their own time) after asking in: now let in.
        if (s.status === 'waiting' && expected && state === 'running') next = { ...next, status: 'admitted', decidedAt: Date.now(), via: 'class' };
        return next === s ? undefined : { ...r, students: { ...r.students, [me.sub]: next } };
      }
      if (state === 'upcoming') { const e = new HttpError(403, 'not_started'); e.detail = win.start; throw e; }
      if (state === 'ended') throw new HttpError(403, 'room_closed');
      const entry = { email: me.email, name: me.name, status: expected ? 'admitted' : 'waiting', requestedAt: Date.now(), leaves: 0, words: 0 };
      if (expected) { entry.decidedAt = Date.now(); entry.via = 'class'; }
      return { ...r, students: { ...r.students, [me.sub]: entry } };
    });
    return respond(200, { room: studentView(room, me.sub, me.email) });
  }

  // GET /luddite/assignment?code= -- a student's place in the assignment
  // (polled while waiting), or the whole thing for its teacher.
  if (path === '/luddite/assignment' && method === 'GET') {
    const room = await getRoom(cleanCode(q.code));
    if (isTeacher && ownsRoom(room, info, role)) return respond(200, { room, drive: await driveStatus(room.teacher.sub), roster: await rosterOf(room) });
    return respond(200, { room: studentView(room, me.sub, me.email) });
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
      if (body.type === 'writing' || body.type === 'idle') Object.assign(next, { away: false, writing: body.type === 'writing' && !s.handedIn });
      if (Number.isFinite(body.words)) next.words = Math.max(0, Math.floor(body.words));
      return { ...r, students: { ...r.students, [me.sub]: next } };
    });
    if (!room) throw new HttpError(404, 'no_room');
    return respond(200, { room: studentView(room, me.sub, me.email) });
  }

  // PUT /luddite/submit { code, text, words, label } -- hand the piece in.
  if (path === '/luddite/submit' && method === 'PUT') {
    const code = cleanCode(body.code);
    const room = await getRoom(code);
    const s = room.students[me.sub];
    if (!s || s.status !== 'admitted') throw new HttpError(403, 'not_admitted');
    if (s.handedIn) throw new HttpError(409, 'already_handed_in');
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
        description: 'Submitted through Luddite by ' + who + ' (' + me.email + '), assignment ' + room.title + ' (' + code + '). ' +
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
    const win = windowOf(room, lower(me.email));
    const submission = { id, sub: me.sub, email: me.email, name: me.name, words, leaves: s.leaves || 0, at,
      link: file ? file.webViewLink : null, stored, driveError, marked: 0, late: !!(win.end && at > win.end + LATE_GRACE_MS) };
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
      students: { ...r.students, [me.sub]: { ...r.students[me.sub], submittedAt: submission.at, submissions: (r.students[me.sub].submissions || 0) + 1, words, handedIn: true, writing: false } }
    }));
    return respond(200, { room: studentView(saved, me.sub, me.email) });
  }

  if (!isTeacher) return respond(403, { error: 'teachers_only' });

  // ---- Teachers ----

  // GET /luddite/assignments -- this teacher's assignments (newest first) and classes.
  if (path === '/luddite/assignments' && method === 'GET') {
    const { state } = await readItem('luddite:teacher:' + me.sub);
    const codes = (state && state.rooms) || [];
    const rooms = (await Promise.all(codes.map((c) => readItem('luddite:room:' + c)))).map((r) => r.state).filter((r) => r && !r.deletedAt);
    return respond(200, {
      assignments: rooms.map(roomSummary),
      classes: await classesOf(state),
      drive: await driveStatus(me.sub),
      displayName: (state && state.displayName) || (role === 'owner' ? OWNER_DISPLAY_NAME : me.name || me.email)
    });
  }

  // ---- Classes ----

  // GET /luddite/classes -- this teacher's classes.
  if (path === '/luddite/classes' && method === 'GET') {
    const { state } = await readItem('luddite:teacher:' + me.sub);
    return respond(200, { classes: await classesOf(state) });
  }

  // PUT /luddite/classes { name, emails } -- make a class from a list of
  // addresses. { name, fromTeachers: true } (owners only) makes one of
  // everyone who can open assignments, the owners included.
  if (path === '/luddite/classes' && method === 'PUT') {
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) throw new HttpError(400, 'need_name');
    let emails;
    if (body.fromTeachers) {
      if (role !== 'owner') throw new HttpError(403, 'owners_only');
      const { state } = await readItem('luddite:teachers');
      emails = cleanEmails([...OWNER_EMAILS, ...Object.keys((state && state.emails) || {})]);
    } else {
      emails = cleanEmails(body.emails);
    }
    if (!emails.length) throw new HttpError(400, 'no_emails');
    if (emails.length > MAX_CLASS_EMAILS) throw new HttpError(413, 'too_many_emails');
    const id = randomBytes(6).toString('hex');
    const teacher = { ...me, name: await displayNameOf(info, role) };
    const made = await mutate('luddite:class:' + id, () => ({ id, name, teacher, emails, assignments: [], createdAt: Date.now() }));
    await mutate('luddite:teacher:' + me.sub, (t) => ({ ...(t || { rooms: [] }), classes: [id, ...((t && t.classes) || [])] }));
    await indexClass(id, emails, []);
    return respond(200, { class: made });
  }

  // GET /luddite/class?id= -- one class, with its addresses.
  if (path === '/luddite/class' && method === 'GET') {
    return respond(200, { class: await getClass(q.id, me, role) });
  }

  // PUT /luddite/class { id, action: rename | add | remove | delete, name, emails }
  if (path === '/luddite/class' && method === 'PUT') {
    const cls = await getClass(body.id, me, role);
    const emails = cleanEmails(body.emails);
    let added = [], removed = [];
    const saved = await mutate('luddite:class:' + cls.id, (c) => {
      if (!c || c.deletedAt) throw new HttpError(404, 'no_class');
      if (body.action === 'rename') {
        const name = String(body.name || '').trim().slice(0, 80);
        if (!name) throw new HttpError(400, 'need_name');
        return { ...c, name };
      }
      if (body.action === 'add') {
        added = emails.filter((e) => !c.emails.includes(e));
        if (c.emails.length + added.length > MAX_CLASS_EMAILS) throw new HttpError(413, 'too_many_emails');
        return added.length ? { ...c, emails: [...c.emails, ...added] } : undefined;
      }
      if (body.action === 'remove') {
        removed = emails.filter((e) => c.emails.includes(e));
        return removed.length ? { ...c, emails: c.emails.filter((e) => !removed.includes(e)) } : undefined;
      }
      if (body.action === 'delete') { removed = c.emails.slice(); return { ...c, emails: [], deletedAt: Date.now() }; }
      throw new HttpError(400, 'bad_action');
    });
    await indexClass(cls.id, added, removed);
    if (body.action === 'delete') {
      await mutate('luddite:teacher:' + cls.teacher.sub, (t) => ({ ...(t || {}), classes: ((t && t.classes) || []).filter((c) => c !== cls.id) }));
    }
    return respond(200, { class: saved });
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
    const grade = String(body.grade || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const saved = await mutate('luddite:sub:' + piece.id, (x) => {
      const next = { ...x, marks, endComment, grade, markedAt: Date.now() };
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_ITEM_BYTES) throw new HttpError(413, 'too_many_marks');
      return next;
    });
    // The room's list shows which pieces have been marked.
    // Drive's copy carries the mark-up too (green text, cross-outs, comments, grade).
    await updateDriveDoc(piece.teacherSub, saved).catch((e) => console.warn('drive markup failed', e.detail || e.message));
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
          id: p.id, at: p.at, roomTitle: p.roomTitle, label: p.label, words: p.words, link: p.link, endComment: p.endComment || '', grade: p.grade || '',
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

  // PUT /luddite/assignments { title, classId, startAt, minutes } -- make an
  // assignment with a fresh two-word Entry Phrase. It needs a name that says
  // what it is. startAt (ms; omitted = now) and minutes are its regular
  // window; classId (optional) is the class let in on its own.
  if (path === '/luddite/assignments' && method === 'PUT') {
    const teacher = { ...me, name: await displayNameOf(info, role) };
    const title = String(body.title || '').trim().slice(0, 80);
    if (!title) throw new HttpError(400, 'need_title');
    const minutes = Math.floor(Number(body.minutes) || 45);
    if (minutes < 5 || minutes > MAX_MINUTES) throw new HttpError(400, 'bad_minutes');
    const startAt = Number(body.startAt) > 0 ? Math.floor(Number(body.startAt)) : Date.now();
    const cls = body.classId ? await getClass(body.classId, me, role) : null;
    let room = null;
    for (let i = 0; i < 12 && !room; i++) {
      const { code, codeLabel } = newRoomCode();
      try {
        room = await mutate('luddite:room:' + code, (r) => {
          if (r) throw new HttpError(409, 'code_taken');
          return { code, codeLabel, title, teacher, classId: cls ? cls.id : null, startAt, minutes, open: true, createdAt: Date.now(), students: {}, submissions: [] };
        });
      } catch (e) {
        if (e.message !== 'code_taken') throw e;
      }
    }
    if (!room) throw new HttpError(503, 'busy');
    await mutate('luddite:teacher:' + me.sub, (t) => ({ ...(t || {}), rooms: [room.code, ...((t && t.rooms) || [])] }));
    if (cls) {
      await mutate('luddite:class:' + cls.id, (c) => ({ ...c, assignments: [room.code, ...(c.assignments || [])].slice(0, MAX_CLASS_ASSIGNMENTS) }));
    }
    return respond(200, { room });
  }

  // PUT /luddite/assignment { code, action, subs, ... } -- admit | admitAll |
  // remove | release (let a student who handed in keep writing) | close (stop
  // new people getting in) | startNow (also reopens one that has ended) |
  // schedule { startAt, minutes } | rename { title } | own { email, startAt,
  // multiplier } | unown { email } | delete (only takes it off the teacher's list).
  if (path === '/luddite/assignment' && method === 'PUT') {
    const code = cleanCode(body.code);
    const subs = Array.isArray(body.subs) ? body.subs : [];
    const ownEmail = lower(body.email);
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
      else if (body.action === 'release') subs.forEach((sub) => { if (students[sub]) students[sub] = { ...students[sub], handedIn: false, releasedAt: Date.now() }; });
      else if (body.action === 'close') return { ...r, open: false, endedAt: Date.now() };
      else if (body.action === 'startNow' || body.action === 'open') return { ...r, open: true, endedAt: null, startAt: Date.now() };
      else if (body.action === 'schedule') {
        const startAt = Math.floor(Number(body.startAt));
        const minutes = Math.floor(Number(body.minutes) || r.minutes || 45);
        if (!(startAt > 0) || minutes < 5 || minutes > MAX_MINUTES) throw new HttpError(400, 'bad_time');
        return { ...r, open: true, endedAt: null, startAt, minutes };
      }
      else if (body.action === 'rename') {
        const title = String(body.title || '').trim().slice(0, 80);
        if (!title) throw new HttpError(400, 'need_title');
        return { ...r, title };
      }
      else if (body.action === 'own') {
        if (!EMAIL_RE.test(ownEmail)) throw new HttpError(400, 'bad_email');
        if (!r.minutes) throw new HttpError(409, 'no_length');
        const multiplier = Math.min(4, Math.max(1, Math.round((Number(body.multiplier) || 1) * 4) / 4));
        const startAt = Number(body.startAt) > 0 ? Math.floor(Number(body.startAt)) : null;
        return { ...r, own: { ...(r.own || {}), [ownEmail]: { startAt, multiplier, setAt: Date.now() } } };
      }
      else if (body.action === 'unown') {
        const own = { ...(r.own || {}) };
        delete own[ownEmail];
        return { ...r, own };
      }
      else if (body.action === 'delete') return { ...r, open: false, endedAt: Date.now(), deletedAt: Date.now() };
      else throw new HttpError(400, 'bad_action');
      return { ...r, students };
    });
    if (body.action === 'own') {
      await mutate('luddite:mine:' + ownEmail, (m) => {
        const own = (m && m.own) || [];
        return own.includes(code) ? undefined : { ...(m || {}), own: [code, ...own].slice(0, 60) };
      });
    }
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

// A teacher's classes, newest first.
async function classesOf(teacherState) {
  const ids = (teacherState && teacherState.classes) || [];
  const list = await Promise.all(ids.map((id) => readItem('luddite:class:' + id)));
  return list.map((x) => x.state).filter((c) => c && !c.deletedAt).map(classSummary);
}

// The addresses on an assignment's class, so its teacher can see who hasn't come in.
async function rosterOf(room) {
  if (!room.classId) return null;
  const { state } = await readItem('luddite:class:' + room.classId);
  return state && !state.deletedAt ? { id: state.id, name: state.name, emails: state.emails } : null;
}

async function driveStatus(teacherSub) {
  const { state } = await readItem('luddite:drive:' + teacherSub);
  return { connected: !!(state && state.refreshToken), email: (state && state.email) || '', configured: !!LUDDITE_CLIENT_SECRET };
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || 'GET';
  const path = event.rawPath || '/';

  await loadSessionSecret();
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return respond(401, { error: 'Missing bearer token' });

  // Session tokens are checked locally; anything else is a Google ID token.
  const info = token.startsWith('s1.') ? verifySession(token) : await verifyGoogleToken(token);
  if (!info) return respond(401, { error: 'Invalid or expired token' });

  // Session tokens only exist for verified Google accounts; a raw Google
  // token must say so itself before its email can count for anything.
  if (!token.startsWith('s1.') && info.email_verified !== 'true' && info.email_verified !== true) {
    return respond(403, { error: 'Unverified email' });
  }
  if (!path.startsWith('/luddite/')) return respond(404, { error: 'Not found' });
  return handleLuddite(event, method, path, info);
};
