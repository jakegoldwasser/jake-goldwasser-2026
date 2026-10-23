import { DynamoDBClient, GetItemCommand, PutItemCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
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
//   luddite:proctors        { emails: { [email]: { addedAt } } }  permanent proctors
//   luddite:proctoring      { codes: [code, ...] } newest first: sessions with own time, for permanent proctors
//   luddite:teacher:<sub>   { rooms: [code, ...], classes: [id, ...] }  newest first
//   luddite:class:<id>      { id, name, teacher: { sub, email, name }, emails: [...],
//                             assignments: [code, ...] newest first, createdAt }
//   luddite:mine:<email>    { classes: [id, ...], own: [code, ...], rooms: [code, ...],
//                           handed: [code, ...] }: how a student's login finds
//                           their assignments (their classes' assignments, ones
//                           with their own time, and ones they've handed in to,
//                           for reflections)
//   luddite:room:<code>     { code, title, teacher: { sub, email, name },
//                             classId, casual, startAt, prompt, endedAt, open,
//                             own: { [email]: { startAt, multiplier } },
//                             createdAt, students: { [sub]: {...} },
//                             submissions: [...] }
//   luddite:drive:<sub>     { refreshToken, email, rootId, roomFolders }
//   luddite:sub:<id>        one handed-in piece, kept so its teacher can mark
//                           it up: { id, code, roomTitle, teacherSub, sub,
//                           email, name, label, text, words, leaves, at, link,
//                           marks: [...], endComment, reflection: { text,
//                           words, at, handedInAt } }
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
// Jake's test accounts: leaving the page doesn't lock them out until a
// teacher lets them back in, so he can try things without getting stuck.
const TEST_EMAILS = [...OWNER_EMAILS, 'nymets892@gmail.com'];
// Proctors run a writing session for its teacher without reading anything
// written in it: they let students in, unlock anyone locked out, begin a
// student's own time and pause or resume it. A **permanent proctor** proctors
// every student with own time in every session (the Upper Division testing
// center always is one; owners add others in Settings, kept in
// luddite:proctors). A teacher can also add a proctor to one session
// (`room.proctors`), who proctors everyone in it.
const TESTING_CENTER_EMAILS = ['testingcenterud@horacemann.org'];
const MAX_PROCTORS = 20;
const PROCTORING_INDEX_MAX = 400;
// The Luddite Google app's client secret, for turning a teacher's one-time
// Drive consent into a lasting refresh token (Configuration -> Environment
// variables in the Lambda console). Without it, Drive can't be connected.
const LUDDITE_CLIENT_SECRET = process.env.LUDDITE_GOOGLE_CLIENT_SECRET || '';
const MAX_SUBMISSION_CHARS = 400000;
// A DynamoDB item tops out at 400 KB, so a piece is kept for marking up only
// if its text fits with room to spare for the teacher's marks.
const MAX_STORED_CHARS = 250000;
// Chat while writing: one message's length, and how many a pair keeps.
const MAX_CHAT_CHARS = 1000;
const MAX_CHAT_MSGS = 300;
// How much of that chat a paper keeps (the newest messages), beside its text.
const MAX_PAPER_CHAT_CHARS = 40000;
// A handed-back paper's grade shows only after the student has spent this
// long with the comments open in front of them (counted by the server).
const GRADE_AFTER_MS = 5 * 60 * 1000;
const VIEW_PING_MAX_MS = 45 * 1000;
const MAX_MARKS = 600;
const MAX_MARK_CHARS = 60000; // all of one piece's comments together
const MAX_ITEM_BYTES = 390000;
const MAX_CLASS_EMAILS = 400;
const MAX_CLASS_ASSIGNMENTS = 30; // a class keeps this many of its newest assignments
const MINE_ASSIGNMENTS_PER_CLASS = 8; // a login looks at each class's newest few
const MAX_MINUTES = 300;
// A session has no set length: its teacher ends it. Extra time is a multiple
// of one period, and a session nobody ended is treated as over after 12 hours.
const REF_MINUTES = 45;
// Most days a session can be spread over.
const MAX_SITTINGS = 10;
const MAX_OPEN_MS = 12 * 60 * 60 * 1000;
const MAX_PROMPT_CHARS = 4000;
const MAX_REFLECTION_CHARS = 20000;
// What a teacher can switch in Preferences; these are the defaults.
const DEFAULT_PREFS = { spellcheck: 'underline', lockOnLeave: true, blockPaste: true, showCount: true, autoHandIn: true };
function cleanPrefs(p) {
  const x = p && typeof p === 'object' ? p : {};
  const out = { ...DEFAULT_PREFS };
  if (x.spellcheck === 'off' || x.spellcheck === 'underline') out.spellcheck = x.spellcheck;
  ['lockOnLeave', 'blockPaste', 'showCount', 'autoHandIn'].forEach((k) => { if (typeof x[k] === 'boolean') out[k] = x[k]; });
  return out;
}
async function prefsOf(teacherSub) {
  const { state } = await readItem('luddite:teacher:' + teacherSub);
  return cleanPrefs(state && state.prefs);
}
const UPCOMING_HORIZON_MS = 48 * 60 * 60 * 1000;
// A paper handed in this long after a student's time ran out is marked late.
const LATE_GRACE_MS = 2 * 60 * 1000;
// A student on an alternative schedule (own time) has five minutes after
// their time ends to finish; then their page hands in by itself.
const OWN_GRACE_MS = 5 * 60 * 1000;
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

// An owner's reach into other teachers' work stops at Horace Mann teachers:
// Luddite HM's students' work is not open to the site's owner (Jake asked for
// this). Horace Mann's own administrators read it through routeHmAdmin.
function ownerMayOpen(role, teacherEmail) {
  return role === 'owner' && !isHm(teacherEmail);
}

function ownsRoom(room, info, role) {
  return room.teacher.sub === info.sub || ownerMayOpen(role, room.teacher.email);
}

// ---- When an assignment runs ----
// The regular window starts at startAt (or, for the first rooms, createdAt)
// and runs until the teacher ends it (or for `minutes`, on older sessions).
// Ending it early sets endedAt, which only stops new people getting in. A student with their own time has their own window: their own
// start (or the regular one), and the length times their multiplier.
const regularEnded = (r) => !!r.endedAt || r.open === false;
// A session students may work on at home (`atHome`) runs, with no time
// limit, until the teacher ends it. Writing is still full screen, but
// leaving it never locks anyone out (it still counts as leaving the page).
function regularWindow(r) {
  const start = r.startAt || r.createdAt;
  if (r.atHome) return { start, end: null, home: true };
  if (r.sittings) return { start: r.sittings[0].start, end: r.sittings[r.sittings.length - 1].end };
  return { start, end: r.minutes ? start + r.minutes * 60000 : null };
}
// Paused time (the whole session's, and this student's own) doesn't count:
// it moves the end of their time later.
function pausedFor(x, now) { return x ? (x.pausedMs || 0) + (x.pausedAt ? Math.max(0, now - x.pausedAt) : 0) : 0; }
// A session over several days (`sittings`: [{ start, end }], in order, at
// least two) runs only during its sittings: between them everyone is paused
// (no writing, may leave the page) and keeps their writing for the next one,
// and it ends with the last sitting. Extra time stretches every sitting; a
// pause doesn't move the sittings.
function sittingsWindow(room, email, entry, now) {
  const o = room.own && room.own[email];
  const multiplier = (o && o.multiplier) || 1;
  const list = room.sittings.map((x) => ({ start: x.start, end: x.start + Math.round((x.end - x.start) * multiplier) }));
  return { ...partsWindow(list, room, entry, now), own: !!o, multiplier, ended: o ? false : regularEnded(room) };
}
// Writing only during these blocks of time, paused between them.
function partsWindow(list, room, entry, now) {
  const at = list.findIndex((x) => now >= x.start && now < x.end);
  const next = list.findIndex((x) => x.start > now);
  const between = at === -1 && next > 0;
  return {
    start: list[0].start, end: list[list.length - 1].end,
    paused: !!(room.pausedAt || (entry && entry.pausedAt) || between),
    sitting: at !== -1 ? at + 1 : between ? next : 0, sittings: list.length,
    sittingEnd: at !== -1 ? list[at].end : null, nextAt: between ? list[next].start : null
  };
}
// An alternative schedule in parts (`blocks`: [{ start, end }]): a student
// takes the paper in pieces, say the first half of D period and then all of
// H, with the writing kept between them. 1 to MAX_BLOCKS, each up to 6 hours,
// put in order, not overlapping.
const MAX_BLOCKS = 8;
function cleanBlocks(x) {
  if (!Array.isArray(x) || !x.length) return null;
  if (x.length > MAX_BLOCKS) throw new HttpError(400, 'too_many_blocks');
  const list = x.map((b) => ({ start: Math.floor(Number(b && b.start)), end: Math.floor(Number(b && b.end)) })).sort((a, b) => a.start - b.start);
  list.forEach((b, i) => {
    if (!(b.start > 0 && b.end > b.start && b.end - b.start <= 6 * 3600000)) throw new HttpError(400, 'bad_time');
    if (i && b.start < list[i - 1].end) throw new HttpError(400, 'overlap');
  });
  return list;
}
// Unlocked (or let write again after handing in) once their time was over --
// the session ended, or their own time ran out: they can write again, with no
// time limit, until they hand in, someone hands in for them, or the teacher
// ends the session again.
function reopenedAt(room, entry, win) {
  const at = entry ? Math.max(entry.unlockedAt || 0, entry.releasedAt || 0) : 0;
  if (!at) return 0;
  return (room.endedAt && at > room.endedAt) || (win.end && at >= win.end) ? at : 0;
}
// Sittings a teacher sends: 2 to MAX_SITTINGS, each up to 6 hours, in order, not overlapping.
function cleanSittings(x) {
  if (!Array.isArray(x) || x.length < 2) return null;
  if (x.length > MAX_SITTINGS) throw new HttpError(400, 'too_many_sittings');
  const list = x.map((s) => ({ start: Math.floor(Number(s && s.start)), end: Math.floor(Number(s && s.end)) }));
  list.forEach((s, i) => {
    if (!(s.start > 0 && s.end > s.start && s.end - s.start <= 6 * 3600000)) throw new HttpError(400, 'bad_time');
    if (i && s.start < list[i - 1].end) throw new HttpError(400, 'bad_time');
  });
  return list;
}
// Starting a session over several days now: the first sitting starts now
// (if it hasn't ended yet); otherwise it becomes an ordinary session.
function startedNow(r, now) {
  const base = { ...r, open: true, endedAt: null, startAt: now, pausedAt: 0, pausedMs: 0 };
  if (!r.sittings) return base;
  if (now < r.sittings[0].start || now < r.sittings[0].end - 5 * 60000) {
    const sittings = [{ ...r.sittings[0], start: Math.min(now, r.sittings[0].start) }, ...r.sittings.slice(1)];
    return { ...base, sittings };
  }
  return { ...base, sittings: undefined };
}
function windowOf(room, email, entry) {
  const win = baseWindowOf(room, email, entry);
  if (!reopenedAt(room, entry, win)) return win;
  return { ...win, end: null, home: true, ended: false, paused: !!(room.pausedAt || (entry && entry.pausedAt)), sitting: 0, sittings: 0, sittingEnd: null, nextAt: null, reopened: true };
}
function baseWindowOf(room, email, entry) {
  const now = Date.now();
  const ob = room.own && room.own[email];
  if (ob && ob.blocks && !room.atHome) return { ...partsWindow(ob.blocks, room, entry, now), own: true, multiplier: 1, ended: false, parts: true };
  if (room.sittings && !room.atHome) return sittingsWindow(room, email, entry, now);
  const reg = regularWindow(room);
  const paused = !!(room.pausedAt || (entry && entry.pausedAt));
  const held = pausedFor(room, now) + pausedFor(entry, now);
  const o = room.own && room.own[email];
  if (room.atHome && o && o.startAt) return { ...reg, start: o.startAt, own: true, multiplier: 1, ended: regularEnded(room), paused };
  if (!o || room.atHome) return { ...reg, end: reg.end ? reg.end + held : null, own: false, multiplier: 1, ended: regularEnded(room), paused };
  const start = o.startAt || reg.start;
  const multiplier = o.multiplier || 1;
  return { start, end: start + Math.round((room.minutes || REF_MINUTES) * multiplier * 60000) + held, own: true, multiplier, ended: false, paused };
}
// Pause or resume a session (x = the room) or one student (x = their entry).
function paused(x, on, now) {
  if (on) return x.pausedAt ? x : { ...x, pausedAt: now };
  if (!x.pausedAt) return x;
  return { ...x, pausedAt: 0, pausedMs: (x.pausedMs || 0) + Math.max(0, now - x.pausedAt) };
}
function stateAt(win, now) {
  if (win.ended) return 'ended';
  if (now < win.start) return 'upcoming';
  if (!win.end && win.home) return 'running';
  if (now >= (win.end || win.start + MAX_OPEN_MS)) return 'ended';
  return 'running';
}

async function onRoster(room, email) {
  if ((room.emails || []).includes(email)) return true; // the session's own list
  if (!room.classId) return false;
  const { state } = await readItem('luddite:class:' + room.classId);
  return !!(state && state.emails.includes(email));
}

// A casual session is named by its prompt once it has one ("Write five
// favorite breakfast cereals"), and by its Entry Phrase until then -- unless
// the teacher has given it a name of their own. (The first ones were stored
// as "Casual session"; they follow the same rule.)
function shortPrompt(p) {
  const t = String(p || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';
  const one = t.replace(/\s+/g, ' ').replace(/^./, (c) => c.toUpperCase());
  if (one.length <= 60) return one;
  const cut = one.slice(0, 60);
  return (cut.slice(0, cut.lastIndexOf(' ')) || cut).replace(/[\s,;:.\-]+$/, '') + '\u2026';
}
function titleOf(r) {
  if (!r.casual) return r.title;
  const named = r.titled || (r.title && r.title !== 'Casual session' && r.title !== r.codeLabel);
  if (named) return r.title;
  return shortPrompt(r.prompt) || r.codeLabel || r.code;
}

// An assignment as its teacher sees it on Home.
function roomSummary(room) {
  const students = Object.values(room.students || {});
  const reg = regularWindow(room);
  const state = stateAt({ ...reg, ended: regularEnded(room) }, Date.now());
  return {
    code: room.code, codeLabel: room.codeLabel || room.code, title: titleOf(room), open: state === 'running', state, createdAt: room.createdAt,
    classId: room.classId || null, casual: !!room.casual, atHome: !!room.atHome, startAt: reg.start, endAt: reg.end, endedAt: room.endedAt || null, minutes: room.minutes || null,
    sittings: room.sittings || null,
    invited: (room.emails || []).length,
    ownCount: Object.keys(room.own || {}).length,
    waiting: students.filter((s) => s.status === 'waiting').length,
    admitted: students.filter((s) => s.status === 'admitted').length,
    submissions: (room.submissions || []).length,
    // Papers marked up, given a grade or handed back, so Home can say whether a past session is graded.
    graded: (room.submissions || []).filter((x) => x.grade || x.marked || x.returnedAt).length
  };
}

// The id of the grading shared with this student in this session: their
// paper's if it's shared, else their writing so far's ('early:<code>:<sub>').
function sharedGradingId(room, sub) {
  const paper = (room.submissions || []).find((x) => x.sub === sub && x.stored);
  if (paper) return paper.returnedAt ? paper.id : null;
  const st = room.students[sub];
  return st && st.earlyShared ? 'early:' + room.code + ':' + sub : null;
}

// An assignment as one student sees it: only their own place in it, and
// their own window (which may differ from everyone else's).
function studentView(room, sub, email, prefs) {
  const me = room.students[sub] || null;
  const win = windowOf(room, lower(email), me);
  const now = Date.now();
  const state = stateAt(win, now);
  return {
    code: room.code, codeLabel: room.codeLabel || room.code, title: titleOf(room), open: state === 'running',
    state, startAt: win.start, endAt: win.end, own: win.own, multiplier: win.multiplier, minutes: room.minutes || null, now,
    teacherName: room.teacher.name || room.teacher.email,
    prompt: room.prompt || '', prefs: prefs || DEFAULT_PREFS,
    atHome: !!room.atHome,
    // The teacher lets everyone in it read each other's writing so far (see /luddite/classwork).
    shareWork: !!room.shareWork,
    // Grading the teacher has shared with them in this session (their paper's,
    // else their writing so far's), which they can read while they write.
    sharedId: sharedGradingId(room, sub),
    // The rubric, while the teacher lets students see it as they write.
    rubric: room.rubricShown && room.rubric && me && me.status === 'admitted' ? room.rubric : null,
    status: me ? me.status : 'none',
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
    sitting: win.sitting || 0, sittings: win.sittings || 0, sittingEnd: win.sittingEnd || null, nextAt: win.nextAt || null,
    // An alternative schedule in parts (not days).
    parts: !!win.parts,
    // Their earlier drafts in this session (see /luddite/newdraft): [{ n, at, words, graded, shared }].
    drafts: (me && me.drafts) || []
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
  if (state.teacher.sub !== me.sub && !ownerMayOpen(role, state.teacher.email)) throw new HttpError(403, 'not_your_class');
  return state;
}

const classSummary = (c) => ({ id: c.id, name: c.name, count: c.emails.length, createdAt: c.createdAt, period: c.period || '', grade: c.grade || '', color: c.color == null ? null : c.color });
// A class's grade level: 9, 10, 11, 12, or what the teacher typed for Other.
const cleanGradeLevel = (g) => String(g == null ? '' : g).replace(/\s+/g, ' ').trim().slice(0, 24);
// A class's color: which of the page's class colors (0-7) marks it; null = picked for it by the page.
const cleanColor = (x) => (Number.isInteger(x) && x >= 0 && x < 8 ? x : null);
// The class's period letter (A-H), which its writing sessions start at by default.
const cleanPeriod = (p) => (/^[A-H]$/.test(String(p || '').toUpperCase()) ? String(p).toUpperCase() : '');

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
  const folderId = await createFolder(token, room.casual ? 'Casual session (' + (room.codeLabel || room.code) + ')' : room.title + ' (' + (room.codeLabel || room.code) + ')', rootId);
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
// The few words around one point in the text, to name an arrow's two ends.
function wordsAt(text, p) {
  const a = Math.max(0, p - 18), b = Math.min(text.length, p + 22);
  let t = text.slice(a, b).replace(/\s+/g, ' ');
  if (a > 0) t = t.replace(/^\S*\s/, '');
  if (b < text.length) t = t.replace(/\s\S*$/, '');
  return t.trim();
}
// "from <words> to <words>", following the arrowhead.
function arrowQuote(text, m) {
  const from = m.head === 'start' ? m.end : m.start, to = m.head === 'start' ? m.start : m.end;
  return 'from \u201c' + wordsAt(text, from) + '\u201d to \u201c' + wordsAt(text, to) + '\u201d';
}
const escHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PEN = '#2f6b3a';
function markedHtml(piece) {
  const text = piece.text, marks = piece.marks || [];
  // Comments and arrows share one numbering, in the order they come in the text.
  const notes = marks.filter((m) => m.type === 'margin' || m.type === 'arrow').sort((a, b) => a.start - b.start || a.end - b.end);
  const margins = notes.filter((m) => m.type === 'margin');
  const num = new Map(notes.map((m, i) => [m.id, i + 1]));
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
    const on = marks.filter((m) => (m.type === 'margin' || m.type === 'strike') && m.start <= p && m.end >= next);
    if (on.some((m) => m.type === 'strike')) h = '<s style="text-decoration-color:' + PEN + '">' + h + '</s>';
    if (on.some((m) => m.type === 'margin')) h = '<span style="background-color:#e3f0e3">' + h + '</span>';
    body += h;
  });
  let html = '<html><body><p style="font-size:11pt"><b>' + escHtml(piece.name || piece.email) + '</b> \u2014 ' + escHtml(piece.roomTitle || '') + '</p>';
  if (piece.grade) html += '<p style="color:' + PEN + ';font-size:14pt"><b>Grade: ' + escHtml(piece.grade) + '</b></p>';
  html += '<p>' + body + '</p>';
  if (notes.length) {
    html += '<hr><p style="color:' + PEN + '"><b>Comments</b></p>';
    notes.forEach((m) => {
      if (m.type === 'arrow') {
        html += '<p style="color:' + PEN + '">[' + num.get(m.id) + '] Arrow ' + escHtml(arrowQuote(text, m)) + (m.note ? ' \u2014 ' + escHtml(m.note) : '') + '</p>';
        return;
      }
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
// The piece's own teacher (or an owner, except for Horace Mann teachers' papers) may read and mark it.
async function ownSub(id, me, role) {
  const key = String(id || '');
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw new HttpError(404, 'no_sub');
  const { state } = await readItem('luddite:sub:' + key);
  if (!state) throw new HttpError(404, 'no_sub');
  if (state.teacherSub !== me.sub) {
    const { state: room } = await readItem('luddite:room:' + state.code);
    if (!room || !ownerMayOpen(role, room.teacher.email)) throw new HttpError(403, 'not_your_student');
  }
  return state;
}

// margin: a note beside words [start, end). strike: words crossed out.
// insert: the teacher's own words written into the text at `start`.
// arrow: a line drawn between two points in the text, start < end, with its
// head at `head` ('start' or 'end') and an optional note about the connection.
function cleanMarks(list, length) {
  if (!Array.isArray(list)) throw new HttpError(400, 'bad_marks');
  if (list.length > MAX_MARKS) throw new HttpError(413, 'too_many_marks');
  let chars = 0;
  const out = list.map((m) => {
    const type = m && m.type;
    if (!['margin', 'strike', 'insert', 'arrow'].includes(type)) throw new HttpError(400, 'bad_marks');
    const clamp = (v) => Math.max(0, Math.min(length, Math.floor(Number(v) || 0)));
    let start = clamp(m.start);
    let end = type === 'insert' ? start : Math.max(start, clamp(m.end));
    if (type === 'arrow') { const a = clamp(m.start), b = clamp(m.end); start = Math.min(a, b); end = Math.max(a, b); }
    // (an orphan, on words since deleted, has no place in the text)
    const orphan = type !== 'strike' && m.orphan ? String(m.orphan).slice(0, 300) : '';
    if (orphan) { start = 0; end = 0; }
    if (type !== 'insert' && end === start && !orphan) throw new HttpError(400, 'bad_marks');
    const note = String(m.note || '').slice(0, 2000);
    if (type === 'insert' && !note.trim()) throw new HttpError(400, 'bad_marks');
    chars += note.length;
    const mark = { id: String(m.id || '').slice(0, 40) || randomUUID().slice(0, 8), type, start, end, note, at: Number(m.at) || Date.now() };
    if (type === 'arrow') mark.head = m.head === 'start' ? 'start' : 'end';
    if (orphan) mark.orphan = orphan;
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

// One document per student per writing session (Jake, 2026-10-22): the
// teacher's comments are never deleted except by the teacher. When the
// student's text changes (writing again, handing in again), each mark moves
// to where its words now are, the nearest match to where it was (an
// insertion or an arrow's end follows the words just before it). A comment,
// insertion or arrow whose words are gone goes to the paper's Comments on
// Deleted Words (`orphan`: the words it was on; no place in the text,
// start = end = 0) until the teacher deletes it. Only a cross-out of words
// that are gone goes: there's nothing left for it to cross out.
// Marks made on a student's writing before their first hand-in are kept with
// that text (luddite:early:<code>:<sub> { base, marks, endComment, grade,
// rubric, rubricScores, at, usedAt }) and land on the paper when it's made.
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
    if (before.trim()) { const i = findNear(text, before, want - before.length); if (i !== -1) return i + before.length; }
    const after = base.slice(at, at + n);
    if (after.trim()) { const i = findNear(text, after, want); if (i !== -1) return i; }
  }
  return at === 0 ? 0 : -1;
}
const quoteOf = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 300);
function reanchorMarks(marks, base, text) {
  if (base === text) return marks || [];
  const scale = (at) => (base.length ? Math.round(at * text.length / base.length) : 0);
  const orphan = (m, words) => ({ ...m, start: 0, end: 0, orphan: quoteOf(words) || '(gone)' });
  const out = [];
  for (const m of marks || []) {
    if (m.orphan) { out.push(m); continue; }
    if (m.type === 'insert') {
      const p = pointIn(base, text, m.start);
      out.push(p === -1 ? orphan(m, base.slice(Math.max(0, m.start - 40), m.start + 40)) : { ...m, start: p, end: p });
      continue;
    }
    if (m.type === 'arrow') {
      const a = pointIn(base, text, m.start), b = pointIn(base, text, m.end);
      if (a === -1 || b === -1 || a === b) { out.push(orphan(m, base.slice(m.start, Math.min(m.end, m.start + 300)))); continue; }
      out.push({ ...m, start: Math.min(a, b), end: Math.max(a, b), head: a <= b ? m.head : (m.head === 'start' ? 'end' : 'start') });
      continue;
    }
    const q = base.slice(m.start, m.end);
    const i = q.trim() ? findNear(text, q, scale(m.start)) : -1;
    if (i !== -1) { out.push({ ...m, start: i, end: i + q.length }); continue; }
    if (m.type === 'strike') continue;
    out.push(orphan(m, q));
  }
  return out;
}
// Marks from two places on one text (a paper's and ones made on the writing
// before it), each once.
function mergeMarks(a, b) {
  const seen = new Set((a || []).map((m) => m.id));
  return [...(a || []), ...(b || []).filter((m) => !seen.has(m.id))];
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

  // Luddite HM's administrators: read-only, from the Luddite HM page only (see routeHmAdmin).
  if (path.startsWith('/luddite/admin/')) return routeHmAdmin(event, method, path, q, body, me);

  // GET /luddite/status -- who is this, and what can they do?
  if (path === '/luddite/status' && method === 'GET') {
    const session = issueSession(info);
    const proctor = await isPermanentProctor(me.email) || !!((await readItem('luddite:mine:' + lower(me.email))).state || {}).proctor?.length;
    return respond(200, { luddite: { role, email: me.email, name: me.name, proctor }, session });
  }

  // ---- Proctors (see TESTING_CENTER_EMAILS) ----
  if (path === '/luddite/proctor' || path.startsWith('/luddite/proctor/')) return routeProctor(method, path, q, body, me);

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
    // Sessions made with a typed-in list of addresses, rather than a class.
    ((mine && mine.rooms) || []).forEach((code) => { codes.add(code); viaClass.add(code); });
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
      if (!r.classId && r.emails && !r.emails.includes(em) && !(r.own && r.own[em])) return;
      const s = r.students[me.sub];
      if (s && s.status === 'removed') return;
      const win = windowOf(r, em, s);
      const state = stateAt(win, now);
      if (state === 'ended' || (state === 'upcoming' && win.start - now > UPCOMING_HORIZON_MS)) return;
      list.push({
        code: r.code, codeLabel: r.codeLabel || r.code, title: titleOf(r), teacherName: r.teacher.name || r.teacher.email,
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
      const expected = !!(rostered || r.casual || (r.own && r.own[em]));
      const s = r.students[me.sub];
      const win = windowOf(r, em, s);
      const state = stateAt(win, Date.now());
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
    return respond(200, { room: studentView(room, me.sub, me.email, await prefsOf(room.teacher.sub)) });
  }

  // GET /luddite/assignment?code= -- a student's place in the assignment
  // (polled while waiting), or the whole thing for its teacher.
  if (path === '/luddite/assignment' && method === 'GET') {
    const room = await getRoom(cleanCode(q.code));
    // ?as=student: a teacher (or owner) writing in a session asks for their own place in it, not the teacher's copy.
    if (q.as !== 'student' && isTeacher && ownsRoom(room, info, role)) return respond(200, { room: { ...room, title: titleOf(room) }, drive: await driveStatus(room.teacher.sub), roster: await rosterOf(room) });
    return respond(200, { room: studentView(room, me.sub, me.email, await prefsOf(room.teacher.sub)) });
  }

  // PUT /luddite/event { code, type: 'left' | 'writing' | 'idle' | 'ask', words }
  // -- live status for the teacher: leaving the page, and word counts.
  if (path === '/luddite/event' && method === 'PUT') {
    const code = cleanCode(body.code);
    let prevSeen = 0;
    const room = await mutate('luddite:room:' + code, (r) => {
      const s = r && r.students[me.sub];
      if (!s || s.status !== 'admitted') return undefined;
      prevSeen = s.lastSeen || 0;
      const next = { ...s, lastSeen: Date.now() };
      // `away` means off the page right now. `lockedOut` keeps them off it
      // until the teacher lets them back in (the room's 'unlock' action).
      // While paused they may step away (that's what a pause is for).
      const held = windowOf(r, lower(s.email), s).paused;
      if (body.type === 'left' && held) Object.assign(next, { away: true, writing: false });
      // At home, leaving the page still counts, but never locks them out.
      else if (body.type === 'left' && r.atHome) Object.assign(next, { leaves: (s.leaves || 0) + 1, away: true, writing: false });
      else if (body.type === 'left') Object.assign(next, { leaves: (s.leaves || 0) + 1, away: true, writing: false, lockedOut: !TEST_EMAILS.includes(lower(me.email)) });
      if ((body.type === 'writing' || body.type === 'idle') && !s.lockedOut) Object.assign(next, { away: false, writing: body.type === 'writing' && !s.handedIn });
      // 'ask': a flag for the teacher -- please unlock me.
      if (body.type === 'ask' && (s.handedIn || s.lockedOut)) next.askedAt = Date.now();
      if (Number.isFinite(body.words)) next.words = Math.max(0, Math.floor(body.words));
      return { ...r, students: { ...r.students, [me.sub]: next } };
    });
    if (!room) throw new HttpError(404, 'no_room');
    // A backup of the writing so far (sent when it has changed), so a lost
    // laptop or a cleared browser doesn't lose the work.
    if (typeof body.text === 'string' && room.students[me.sub] && room.students[me.sub].status === 'admitted') await saveDraft(code, me.sub, body.text, prevSeen);
    return respond(200, { room: studentView(room, me.sub, me.email, await prefsOf(room.teacher.sub)) });
  }

  // ---- Drafts: a student starts a new draft; the old one is kept ----
  // PUT /luddite/newdraft { code } -- the student's writing as it is now, with
  // every mark the teacher made on it (their paper's, else their writing so
  // far's, moved onto it), becomes Draft n (luddite:olddraft:<code>:<sub>:<n>,
  // listed in `drafts` on their entry). The writing goes on as a copy, and its
  // grading starts over: no marks, end comment, grade or rubric scores, not
  // shared. Old drafts are read-only, for the teacher and (their shared
  // grading only) the student.
  if (path === '/luddite/newdraft' && method === 'PUT') {
    const code = cleanCode(body.code);
    const room = await getRoom(code);
    const st = room.students[me.sub];
    if (!st || st.status !== 'admitted') throw new HttpError(404, 'not_in_room');
    if (st.handedIn || st.lockedOut) throw new HttpError(409, 'cant_write');
    if ((st.drafts || []).length >= 30) throw new HttpError(409, 'too_many_drafts');
    const { state: d } = await readItem('luddite:draft:' + code + ':' + me.sub);
    const text = d ? String(d.text || '') : '';
    if (!text.trim()) throw new HttpError(409, 'nothing_yet');
    const paperSub = (room.submissions || []).find((x) => x.sub === me.sub && x.stored);
    const paper = paperSub ? (await readItem('luddite:sub:' + paperSub.id)).state : null;
    const { state: early } = await readItem('luddite:early:' + code + ':' + me.sub);
    const e = early && !early.usedAt ? early : null;
    let marks = [], endComment = '', grade = '', rubric = null, rubricScores = [], returnedAt = null;
    if (paper) {
      marks = reanchorMarks(paper.marks || [], paper.text, text);
      ({ endComment, grade, rubric, rubricScores, returnedAt } = paper);
      endComment = endComment || ''; grade = grade || ''; rubricScores = rubricScores || [];
    }
    if (e) {
      marks = mergeMarks(marks, reanchorMarks(e.marks || [], e.base, text));
      const ec = (e.endComment || '').trim();
      if (ec && !endComment.includes(ec)) endComment = endComment ? endComment + '\n\n' + e.endComment : e.endComment;
      grade = grade || e.grade || '';
      if (!rubric && e.rubric) { rubric = e.rubric; rubricScores = e.rubricScores || []; }
      returnedAt = returnedAt || e.returnedAt || null;
    }
    const n = (st.drafts || []).length + 1, at = Date.now();
    const words = (text.trim().match(/\S+/g) || []).length;
    const old = { code, sub: me.sub, n, text, words, marks, endComment: endComment || '', grade: grade || '', rubric: rubric || null, rubricScores: rubricScores || [],
      returnedAt: returnedAt || null, startedAt: st.draftAt || 0, at, roomTitle: titleOf(room) };
    if (Buffer.byteLength(JSON.stringify(old)) > MAX_ITEM_BYTES) throw new HttpError(413, 'too_long');
    await mutate('luddite:olddraft:' + code + ':' + me.sub + ':' + n, () => old);
    // The writing goes on, ungraded and not shared.
    const ids = [];
    if (paper) {
      ids.push(paper.id);
      await mutate('luddite:sub:' + paper.id, (x) => (x ? { ...x, marks: [], endComment: '', grade: '', rubricScores: [], returnedAt: null, markedAt: null, view: null, gathered: true } : undefined));
    }
    if (early) {
      ids.push('early:' + code + ':' + me.sub);
      await mutate('luddite:early:' + code + ':' + me.sub, (x) => (x ? { ...x, base: text, marks: [], endComment: '', grade: '', rubricScores: [], returnedAt: null, view: null } : undefined));
    }
    if (ids.length) await mutate('luddite:mine:' + lower(me.email), (m) => (m && (m.returned || []).some((x) => ids.includes(x)) ? { ...m, returned: m.returned.filter((x) => !ids.includes(x)) } : undefined)).catch(() => {});
    const saved = await mutate('luddite:room:' + code, (r) => {
      const x = r && r.students[me.sub];
      if (!x) return undefined;
      const submissions = (r.submissions || []).map((y) => (paper && y.id === paper.id ? { ...y, marked: 0, grade: '', returnedAt: null } : y));
      const entry = { n, at, words, graded: !!(old.marks.length || old.endComment.trim() || old.grade), shared: !!old.returnedAt };
      return { ...r, submissions, students: { ...r.students, [me.sub]: { ...x, drafts: [...(x.drafts || []), entry], draftAt: at, earlyMarked: 0, earlyGrade: '', earlyShared: null } } };
    });
    return respond(200, { room: studentView(saved, me.sub, me.email, await prefsOf(saved.teacher.sub)) });
  }

  // GET /luddite/drafts?code=&sub= -- a student's earlier drafts in a session
  // (the teacher, with sub; a student, their own): the list, or with n= one of
  // them (a student sees the teacher's marks on it only if they were shared).
  if (path === '/luddite/drafts' && method === 'GET') {
    const room = await getRoom(cleanCode(q.code));
    const asTeacher = !!q.sub && ownsRoom(room, info, role);
    const sub = asTeacher ? String(q.sub) : me.sub;
    const st = room.students[sub];
    if (!st) throw new HttpError(404, 'no_student');
    if (!q.n) return respond(200, { drafts: st.drafts || [], now: (st.drafts || []).length + 1 });
    const { state: dr } = await readItem('luddite:olddraft:' + room.code + ':' + sub + ':' + Math.floor(Number(q.n) || 0));
    if (!dr) throw new HttpError(404, 'no_draft');
    const shown = asTeacher || dr.returnedAt;
    return respond(200, { draft: { ...dr, ...(shown ? {} : { marks: [], endComment: '', grade: '', rubricScores: [] }) }, name: st.name || '', email: st.email || '' });
  }

  // GET /luddite/classwork?code= -- while the teacher allows it (room.shareWork),
  // a student let in reads everyone else's writing so far: name and text only.
  if (path === '/luddite/classwork' && method === 'GET') {
    const room = await getRoom(cleanCode(q.code));
    const s = room.students[me.sub];
    if (!s || s.status !== 'admitted') throw new HttpError(403, 'not_admitted');
    if (!room.shareWork) throw new HttpError(403, 'not_shared');
    const subs = Object.keys(room.students).filter((sub) => sub !== me.sub && room.students[sub].status === 'admitted');
    const got = await Promise.all(subs.map((sub) => readItem('luddite:draft:' + room.code + ':' + sub)));
    const work = subs.map((sub, i) => {
      const st = room.students[sub], d = got[i].state;
      return { sub, name: st.name || String(st.email || '').split('@')[0], text: d ? String(d.text || '') : '', at: d ? d.at : 0, handedIn: !!st.handedIn };
    }).filter((x) => x.text.trim()).sort((a, b) => a.name.localeCompare(b.name));
    return respond(200, { work });
  }

  // GET /luddite/draft?code= -- this student's backed-up writing in a session.
  if (path === '/luddite/draft' && method === 'GET') {
    const { state } = await readItem('luddite:draft:' + cleanCode(q.code) + ':' + me.sub);
    return respond(200, { draft: state ? { text: state.text, at: state.at } : null });
  }

  // ---- Handed back: a student reading their teacher's comments ----

  // GET /luddite/returned -- this student's handed-back papers, newest first.
  if (path === '/luddite/returned' && method === 'GET') {
    const { state: mine } = await readItem('luddite:mine:' + lower(me.email));
    const items = await Promise.all(((mine && mine.returned) || []).map((id) => myShared(id, me).catch(() => null)));
    const seen = {};
    const papers = items.filter((x) => x && x.returnedAt && x.sub === me.sub && !seen[x.id] && (seen[x.id] = 1))
      .map((x) => ({ id: x.id, roomTitle: x.roomTitle, at: x.at, words: x.words, returnedAt: x.returnedAt, gradeReady: viewedMs(x) >= GRADE_AFTER_MS }))
      .sort((a, b) => b.returnedAt - a.returnedAt);
    return respond(200, { papers });
  }

  // GET /luddite/mypaper?id= -- one handed-back paper with its comments.
  // PUT /luddite/mypaper { id } -- "still reading": counts toward the grade.
  if (path === '/luddite/mypaper' && (method === 'GET' || method === 'PUT')) {
    let paper = await myShared(String((method === 'GET' ? q.id : body.id) || ''), me);
    if (!paper || !paper.returnedAt || paper.sub !== me.sub) throw new HttpError(404, 'no_sub');
    if (method === 'PUT') {
      const ep = paper.early ? 'luddite:early:' + paper.code + ':' + paper.sub : null;
      const counted = await mutate(ep || 'luddite:sub:' + paper.id, (x) => {
        const now = Date.now(), v = x.view || { ms: 0, last: 0 };
        const gap = now - (v.last || 0);
        return { ...x, view: { ms: (v.ms || 0) + (gap > 0 && gap <= VIEW_PING_MAX_MS ? gap : 0), last: now } };
      });
      paper = { ...paper, view: counted.view };
    }
    return respond(200, { paper: studentPaper(paper) });
  }

  // ---- Reflections: a student rereads a paper they handed in and writes about it ----
  // The teacher asks for one (room.reflect { prompt, showGrading, at }, Session
  // options). Only a student whose paper is handed in can reflect. Their entry
  // keeps reflect { status: 'reflecting' | 'done', at, lockedOut, leaves, words,
  // writing, lastSeen }; the text goes on the paper (reflection { text, words,
  // at, handedInAt }). Reflecting is locked down like writing: leaving the page
  // locks them out until the teacher lets them back in ('reflectUnlock').

  // GET /luddite/reflections -- the reflections asked of this student.
  if (path === '/luddite/reflections' && method === 'GET') {
    const em = lower(me.email);
    const { state: mine } = await readItem('luddite:mine:' + em);
    const codes = new Set([...((mine && mine.handed) || []), ...((mine && mine.rooms) || []), ...((mine && mine.own) || [])]);
    const classes = await Promise.all(((mine && mine.classes) || []).map((id) => readItem('luddite:class:' + id)));
    classes.forEach(({ state: c }) => { if (c && !c.deletedAt && c.emails.includes(em)) (c.assignments || []).forEach((code) => codes.add(code)); });
    const rooms = await Promise.all([...codes].map((c) => readItem('luddite:room:' + c)));
    const list = [];
    rooms.forEach(({ state: r }) => {
      if (!r || r.deletedAt || !r.reflect) return;
      const s = r.students[me.sub];
      if (!reflectable(r, me.sub)) return;
      list.push({ code: r.code, title: titleOf(r), teacherName: r.teacher.name || r.teacher.email, prompt: r.reflect.prompt || '',
        status: (s.reflect && s.reflect.status) || 'new', lockedOut: !!(s.reflect && s.reflect.lockedOut), at: r.reflect.at || 0 });
    });
    list.sort((a, b) => b.at - a.at);
    return respond(200, { reflections: list });
  }

  // GET /luddite/reflect?code= -- what a student reflects on: their paper
  // (with the teacher's comments and grade if the teacher chose), the prompt,
  // and the reflection so far.
  if (path === '/luddite/reflect' && method === 'GET') {
    const room = await getRoom(cleanCode(q.code));
    const sub = reflectable(room, me.sub);
    if (!sub) throw new HttpError(403, 'no_reflection');
    const { state: paper } = await readItem('luddite:sub:' + sub.id);
    if (!paper) throw new HttpError(404, 'no_sub');
    return respond(200, reflectView(room, me.sub, paper));
  }

  // PUT /luddite/reflect { code, type: 'open' | 'save' | 'left' | 'ask' | 'handin', text, words }
  if (path === '/luddite/reflect' && method === 'PUT') {
    const code = cleanCode(body.code);
    const before = await getRoom(code);
    const sub = reflectable(before, me.sub);
    if (!sub) throw new HttpError(403, 'no_reflection');
    const type = String(body.type || '');
    const room = await mutate('luddite:room:' + code, (r) => {
      const s = r.students[me.sub];
      const rf = { ...(s.reflect || {}) };
      if (rf.status === 'done' && type !== 'open') return undefined;
      rf.lastSeen = Date.now();
      if (!rf.status) { rf.status = 'reflecting'; rf.at = Date.now(); }
      if (type === 'left') Object.assign(rf, { leaves: (rf.leaves || 0) + 1, writing: false, lockedOut: !TEST_EMAILS.includes(lower(me.email)) });
      if (type === 'ask' && rf.lockedOut) rf.askedAt = Date.now();
      if (type === 'save' || type === 'handin') rf.writing = type === 'save' && !!body.writing;
      if (Number.isFinite(body.words)) rf.words = Math.max(0, Math.floor(body.words));
      if (type === 'handin' && !rf.lockedOut) Object.assign(rf, { status: 'done', handedInAt: Date.now(), writing: false });
      return { ...r, students: { ...r.students, [me.sub]: { ...s, reflect: rf } } };
    });
    const rf = room.students[me.sub].reflect || {};
    let paper = (await readItem('luddite:sub:' + sub.id)).state;
    if (typeof body.text === 'string' && (type === 'save' || type === 'handin') && !rf.lockedOut && (rf.status !== 'done' || type === 'handin')) {
      const text = body.text.slice(0, MAX_REFLECTION_CHARS);
      paper = await mutate('luddite:sub:' + sub.id, (x) => {
        // (a reflection the teacher reopened is written over; its old hand-in time goes)
        const prev = x.reflection || {};
        if (prev.handedInAt && rf.status === 'done' && type !== 'handin') return undefined;
        return { ...x, reflection: { text, words: (text.trim().match(/\S+/g) || []).length, at: Date.now(), ...(rf.status === 'done' ? { handedInAt: rf.handedInAt } : {}) } };
      });
    }
    return respond(200, reflectView(room, me.sub, paper));
  }

  // PUT /luddite/submit { code, text, words, label } -- hand the piece in.
  if (path === '/luddite/submit' && method === 'PUT') {
    const code = cleanCode(body.code);
    const room = await getRoom(code);
    const s = room.students[me.sub];
    if (!s || s.status !== 'admitted') throw new HttpError(403, 'not_admitted');
    // (A hand-in Luddite made for them when the session ended can still be
    // replaced once, by their own with everything they'd written.)
    if (s.handedIn && !s.autoHandedIn) throw new HttpError(409, 'already_handed_in');
    const text = String(body.text || '');
    if (!text.trim()) throw new HttpError(400, 'empty');
    if (text.length > MAX_SUBMISSION_CHARS) throw new HttpError(413, 'too_long');
    const label = String(body.label || '').replace(/[\r\n\/\\]/g, ' ').slice(0, 60) || new Date().toISOString().slice(0, 16);
    const saved = await handInFor(room, code, me, s, text, label, false);
    return respond(200, { room: studentView(saved, me.sub, me.email, await prefsOf(saved.teacher.sub)) });
  }

  // ---- Chat: a session's teacher and one student, while the student writes ----
  // (Before the teachers-only line below: students read and send here too.)
  // Each pair's messages are one item (luddite:chat:<code>:<sub>). The room's
  // student entry keeps when each side last wrote and last read (chatT/chatS,
  // seenT/seenS), so both pages learn of a new message from what they already
  // poll (the session page, the heartbeat) and fetch the messages only then.

  // GET /luddite/chat?code=&sub= -- the messages (sub: the teacher's pick;
  // a student gets their own). Reading marks them read.
  if (path === '/luddite/chat' && method === 'GET') {
    const code = cleanCode(q.code);
    const room = await getRoom(code);
    const asTeacher = !!q.sub && ownsRoom(room, info, role);
    const sub = asTeacher ? String(q.sub) : me.sub;
    const s = room.students[sub];
    if (!s || s.status !== 'admitted') throw new HttpError(404, 'not_in_room');
    const { state } = await readItem('luddite:chat:' + code + ':' + sub);
    const msgs = (state && state.msgs) || [];
    const last = msgs.length ? msgs[msgs.length - 1].at : 0;
    const seenKey = asTeacher ? 'seenT' : 'seenS';
    // Reading it: seen, and no longer marked unread (unreadT, the teacher's Mark as unread).
    if ((last && (s[seenKey] || 0) < last) || (asTeacher && s.unreadT)) {
      await mutate('luddite:room:' + code, (r) => {
        const x = r && r.students[sub];
        if (!x || ((x[seenKey] || 0) >= last && !(asTeacher && x.unreadT))) return undefined;
        const { unreadT, ...rest } = x;
        return { ...r, students: { ...r.students, [sub]: { ...(asTeacher ? rest : x), [seenKey]: Math.max(x[seenKey] || 0, last) } } };
      });
    }
    return respond(200, { msgs });
  }

  // PUT /luddite/chat/unread { code, sub } -- the teacher marks a student's
  // live comments unread (unreadT on their entry) until they're opened again.
  if (path === '/luddite/chat/unread' && method === 'PUT') {
    const code = cleanCode(body.code);
    const room = await getRoom(code);
    if (!ownsRoom(room, info, role)) throw new HttpError(403, 'not_your_room');
    const sub = String(body.sub || '');
    if (!room.students[sub]) throw new HttpError(404, 'not_in_room');
    await mutate('luddite:room:' + code, (r) => (r && r.students[sub] ? { ...r, students: { ...r.students, [sub]: { ...r.students[sub], unreadT: Date.now() } } } : undefined));
    return respond(200, { ok: true });
  }

  // PUT /luddite/chat { code, text, to?, hand? } -- send a message. The teacher sends
  // to one student (to: their sub) or everyone let in (to: 'all'); a student
  // sends to their teacher, as a raised hand with hand: true (handAt on their
  // entry, so the session page can say "Hand raised").
  if (path === '/luddite/chat' && method === 'PUT') {
    const code = cleanCode(body.code);
    const text = String(body.text || '').trim().slice(0, MAX_CHAT_CHARS);
    if (!text) throw new HttpError(400, 'empty');
    const room = await getRoom(code);
    const asTeacher = !!body.to && ownsRoom(room, info, role);
    const admitted = (sub) => !!(room.students[sub] && room.students[sub].status === 'admitted');
    const subs = !asTeacher ? [me.sub] : body.to === 'all' ? Object.keys(room.students).filter(admitted) : [String(body.to)];
    if (!subs.length || !subs.every(admitted)) throw new HttpError(404, 'not_in_room');
    const at = Date.now();
    const hand = !asTeacher && body.hand === true;
    const msg = { from: asTeacher ? 'teacher' : 'student', text, at, ...(asTeacher && body.to === 'all' ? { all: true } : {}), ...(hand ? { hand: true } : {}) };
    await inBatches(subs, (sub) => mutate('luddite:chat:' + code + ':' + sub, (c) => ({ code, sub, msgs: [...((c && c.msgs) || []), msg].slice(-MAX_CHAT_MSGS) })));
    const sideKey = asTeacher ? 'chatT' : 'chatS', seenKey = asTeacher ? 'seenT' : 'seenS';
    await mutate('luddite:room:' + code, (r) => {
      if (!r) return undefined;
      const students = { ...r.students };
      subs.forEach((sub) => { if (students[sub]) students[sub] = { ...students[sub], [sideKey]: at, [seenKey]: at, ...(hand ? { handAt: at } : {}) }; });
      return { ...r, students };
    });
    return respond(200, { msg, to: subs.length });
  }

  // GET /luddite/rubricfile?id=&code= -- a rubric's PDF (base64), for the
  // teacher who brought it in, for the session's teacher, and, while the
  // teacher shows the rubric (room.rubricShown), for students let in.
  if (path === '/luddite/rubricfile' && method === 'GET') {
    const id = String(q.id || '');
    if (!/^[a-f0-9]{24}$/.test(id)) throw new HttpError(400, 'bad_file');
    const { state: meta } = await readItem('luddite:rubricfile:' + id);
    if (!meta) throw new HttpError(404, 'no_file');
    if (meta.owner !== me.sub) {
      const room = q.code ? await getRoom(cleanCode(q.code)) : null;
      const st = room && room.students && room.students[me.sub];
      const ok = room && room.rubric && room.rubric.fileId === id
        && ((isTeacher && ownsRoom(room, info, role)) || (room.rubricShown && st && st.status === 'admitted'));
      if (!ok) throw new HttpError(403, 'not_yours');
    }
    const parts = await Promise.all(Array.from({ length: meta.n }, (_, i) => readItem('luddite:rubricfile:' + id + ':' + i)));
    return respond(200, { data: parts.map((x) => (x.state && x.state.data) || '').join('') });
  }

  if (!isTeacher) return respond(403, { error: 'teachers_only' });

  // ---- Teachers ----

  // PUT /luddite/rubrics { rubrics } -- this teacher's saved rubrics, all at once.
  if (path === '/luddite/rubrics' && method === 'PUT') {
    const rubrics = (Array.isArray(body.rubrics) ? body.rubrics : []).slice(0, 30).map(cleanRubric).filter(Boolean);
    await mutate('luddite:teacher:' + me.sub, (t) => ({ ...(t || { rooms: [] }), rubrics }));
    return respond(200, { rubrics });
  }

  // PUT /luddite/rubricfile { data } -- a rubric's PDF (base64), kept in
  // pieces under luddite:rubricfile:<id>:<n>; answers { fileId }. A rubric
  // that uses it names it as its fileId.
  if (path === '/luddite/rubricfile' && method === 'PUT') {
    const data = String(body.data || '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+=*$/.test(data)) throw new HttpError(400, 'bad_file');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > MAX_RUBRIC_PDF_BYTES) throw new HttpError(413, 'too_big');
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(400, 'not_pdf');
    const fileId = randomBytes(12).toString('hex');
    const n = Math.ceil(data.length / RUBRIC_CHUNK_CHARS);
    for (let i = 0; i < n; i++) await mutate('luddite:rubricfile:' + fileId + ':' + i, () => ({ data: data.slice(i * RUBRIC_CHUNK_CHARS, (i + 1) * RUBRIC_CHUNK_CHARS) }));
    await mutate('luddite:rubricfile:' + fileId, () => ({ owner: me.sub, ownerEmail: lower(me.email), n, size: bytes.length, at: Date.now() }));
    return respond(200, { fileId });
  }

  // PUT /luddite/classes/order { ids } -- the teacher's classes in the order they dragged them into.
  if (path === '/luddite/classes/order' && method === 'PUT') {
    const want = (Array.isArray(body.ids) ? body.ids : []).map(String);
    const saved = await mutate('luddite:teacher:' + me.sub, (t) => {
      const have = classIdsOf(t);
      const ids = [...want.filter((id) => have.includes(id)), ...have.filter((id) => !want.includes(id))];
      return { ...(t || { rooms: [] }), classes: ids, classesOrdered: true };
    });
    return respond(200, { classes: await classesOf(saved) });
  }

  // GET /luddite/assignments -- this teacher's assignments (newest first) and classes.
  if (path === '/luddite/assignments' && method === 'GET') {
    const { state } = await readItem('luddite:teacher:' + me.sub);
    const codes = (state && state.rooms) || [];
    const rooms = (await Promise.all(codes.map((c) => readItem('luddite:room:' + c)))).map((r) => r.state).filter((r) => r && !r.deletedAt);
    return respond(200, {
      assignments: rooms.map(roomSummary),
      classes: await classesOf(state),
      prefs: cleanPrefs(state && state.prefs),
      rubrics: (state && state.rubrics) || [],
      drive: await driveStatus(me.sub),
      displayName: (state && state.displayName) || (role === 'owner' ? OWNER_DISPLAY_NAME : me.name || me.email)
    });
  }

  // PUT /luddite/prefs { spellcheck, lockOnLeave, blockPaste, showCount, autoHandIn }
  // -- what students get while writing, for all of this teacher's sessions.
  if (path === '/luddite/prefs' && method === 'PUT') {
    const prefs = cleanPrefs(body);
    await mutate('luddite:teacher:' + me.sub, (t) => ({ ...(t || { rooms: [] }), prefs }));
    return respond(200, { prefs });
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
    // A class can start empty; addresses can be added to it later.
    if (emails.length > MAX_CLASS_EMAILS) throw new HttpError(413, 'too_many_emails');
    const id = randomBytes(6).toString('hex');
    const teacher = { ...me, name: await displayNameOf(info, role) };
    const made = await mutate('luddite:class:' + id, () => ({ id, name, teacher, emails, assignments: [], createdAt: Date.now(), period: cleanPeriod(body.period), grade: cleanGradeLevel(body.grade), color: cleanColor(body.color) }));
    // A new class goes at the end of the list (see classIdsOf).
    await mutate('luddite:teacher:' + me.sub, (t) => ({ ...(t || { rooms: [] }), classes: [...classIdsOf(t), id], classesOrdered: true }));
    await indexClass(id, emails, []);
    return respond(200, { class: made });
  }

  // GET /luddite/class?id= -- one class, with its addresses.
  if (path === '/luddite/class' && method === 'GET') {
    return respond(200, { class: await getClass(q.id, me, role) });
  }

  // PUT /luddite/class { id, action: rename | period | gradeLevel | color | add | remove | delete, name, period, grade, color, emails }
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
      if (body.action === 'period') return { ...c, period: cleanPeriod(body.period) };
      if (body.action === 'gradeLevel') return { ...c, grade: cleanGradeLevel(body.grade) };
      if (body.action === 'color') return { ...c, color: cleanColor(body.color) };
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

  // GET /luddite/watch?code= -- live writing: for the session's teacher,
  // what each student let in has written so far (the backup their page sends
  // while they write; see /luddite/event).
  if (path === '/luddite/watch' && method === 'GET') {
    const room = await getRoom(cleanCode(q.code));
    if (!ownsRoom(room, info, role)) throw new HttpError(403, 'not_your_room');
    const subs = Object.keys(room.students || {}).filter((sub) => room.students[sub].status === 'admitted');
    const got = await Promise.all(subs.map((sub) => readItem('luddite:draft:' + room.code + ':' + sub)));
    const drafts = {};
    subs.forEach((sub, i) => { const d = got[i].state; drafts[sub] = d ? { text: d.text, at: d.at } : null; });
    return respond(200, { drafts });
  }

  // GET /luddite/wlog?code=&sub= -- a student's writing log in a session (see logWriting).
  if (path === '/luddite/wlog' && method === 'GET') {
    const room = await getRoom(cleanCode(q.code));
    if (!ownsRoom(room, info, role)) throw new HttpError(403, 'not_your_room');
    const sub = String(q.sub || ''), st = room.students[sub];
    if (!st) throw new HttpError(404, 'no_student');
    const { state: log } = await readItem('luddite:wlog:' + room.code + ':' + sub);
    return respond(200, { log: log ? { mins: log.mins || [], bursts: log.bursts || [], first: log.first || 0 } : null, name: st.name || '', email: st.email || '' });
  }

  // ---- Grading a draft (see reanchorMarks) ----

  // GET /luddite/early?code=&sub= -- a student's writing so far, with the
  // teacher's marks on it, as a paper to grade (id 'early:<code>:<sub>').
  if (path === '/luddite/early' && method === 'GET') {
    const room = await getRoom(cleanCode(q.code));
    if (!ownsRoom(room, info, role)) throw new HttpError(403, 'not_your_room');
    const sub = String(q.sub || ''), st = room.students[sub];
    if (!st) throw new HttpError(404, 'no_student');
    const { state: d } = await readItem('luddite:draft:' + room.code + ':' + sub);
    const { state: e } = await readItem('luddite:early:' + room.code + ':' + sub);
    const text = d ? String(d.text || '') : '';
    const live = e && !e.usedAt ? e : null;
    return respond(200, {
      piece: { id: 'early:' + room.code + ':' + sub, early: true, code: room.code, sub, name: st.name, email: st.email, roomTitle: titleOf(room),
        text, words: (text.trim().match(/\S+/g) || []).length, at: d ? d.at : Date.now(),
        marks: live ? reanchorMarks(live.marks, live.base, text) : [], endComment: live ? live.endComment || '' : '', grade: live ? live.grade || '' : '',
        rubric: live ? live.rubric || null : null, rubricScores: live ? live.rubricScores || [] : [],
        returnedAt: live ? live.returnedAt || null : null, view: live ? live.view || null : null },
      roomRubric: room.rubric || null
    });
  }

  // PUT /luddite/early { code, sub, text, marks, endComment, grade, rubric, rubricScores }
  // -- the marks on `text`, the draft as the teacher saw it.
  if (path === '/luddite/early' && method === 'PUT') {
    const room = await getRoom(cleanCode(body.code));
    if (!ownsRoom(room, info, role)) throw new HttpError(403, 'not_your_room');
    const sub = String(body.sub || '');
    if (!room.students[sub]) throw new HttpError(404, 'no_student');
    const base = String(body.text || '').slice(0, MAX_STORED_CHARS);
    const marks = cleanMarks(body.marks, base.length);
    const rubric = body.rubric ? cleanRubric(body.rubric) : null;
    const saved = { base, marks, endComment: String(body.endComment || '').slice(0, 8000), grade: String(body.grade || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      rubric, rubricScores: cleanScores(body.rubricScores || [], rubric), at: Date.now() };
    if (Buffer.byteLength(JSON.stringify(saved)) > MAX_ITEM_BYTES) throw new HttpError(413, 'too_many_marks');
    await mutate('luddite:early:' + room.code + ':' + sub, (x) => ({ ...saved, ...(x && !x.usedAt ? { returnedAt: x.returnedAt || null, view: x.view } : {}) }));
    // The session's list shows it graded (or not), apart from whether they've handed in.
    const earlyMarked = marks.length + (saved.endComment.trim() ? 1 : 0);
    await mutate('luddite:room:' + room.code, (r) => (r && r.students[sub] && (r.students[sub].earlyMarked !== earlyMarked || (r.students[sub].earlyGrade || '') !== saved.grade)
      ? { ...r, students: { ...r.students, [sub]: { ...r.students[sub], earlyMarked, earlyGrade: saved.grade } } } : undefined)).catch(() => {});
    return respond(200, { ok: true });
  }

  // ---- Marking up handed-in work ----

  // GET /luddite/sub?id= -- one piece with its marks, for its teacher.
  if (path === '/luddite/sub' && method === 'GET') {
    let piece = await ownSub(q.id, me, role);
    const { state: room } = await readItem('luddite:room:' + piece.code);
    // One document: comments made before it was one -- on the student's
    // earlier papers in this session (`replaces`, from when each hand-in made
    // a new paper) or on their writing in progress (luddite:early) -- are
    // moved onto it and saved there, once (`gathered`); after that only the
    // teacher deletes them.
    const { state: early } = await readItem('luddite:early:' + piece.code + ':' + piece.sub);
    const olds = piece.gathered ? [] : await Promise.all((piece.replaces || []).slice(0, 10).map((id) => readItem('luddite:sub:' + id).then((x) => x.state).catch(() => null)));
    const sources = [...olds.filter((x) => x && Array.isArray(x.marks) && (x.marks.length || (x.endComment || '').trim() || x.grade)),
      ...(early && !early.usedAt ? [{ text: early.base, marks: early.marks, endComment: early.endComment, grade: early.grade, returnedAt: early.returnedAt }] : [])];
    if (sources.length || (!piece.gathered && (piece.replaces || []).length)) {
      piece = await mutate('luddite:sub:' + piece.id, (x) => {
        let next = { ...x, gathered: true };
        for (const src of sources) {
          next.marks = mergeMarks(next.marks, reanchorMarks(src.marks || [], String(src.text || ''), next.text));
          const ec = (src.endComment || '').trim();
          if (ec && !(next.endComment || '').includes(ec)) next.endComment = next.endComment ? next.endComment + '\n\n' + src.endComment : src.endComment;
          if (!next.grade && src.grade) next.grade = src.grade;
          if (!next.returnedAt && src.returnedAt) next.returnedAt = src.returnedAt;
        }
        return next;
      });
      if (early && !early.usedAt) await mutate('luddite:early:' + piece.code + ':' + piece.sub, (x) => (x ? { ...x, usedAt: Date.now(), paperId: piece.id } : undefined));
      const count = (piece.marks || []).length + ((piece.endComment || '').trim() ? 1 : 0);
      await mutate('luddite:room:' + piece.code, (r) => {
        if (!r) return undefined;
        const i = (r.submissions || []).findIndex((x) => x.id === piece.id);
        if (i === -1) return undefined;
        const submissions = r.submissions.slice();
        submissions[i] = { ...submissions[i], marked: count, grade: piece.grade || '', ...(piece.returnedAt ? { returnedAt: piece.returnedAt } : {}) };
        return { ...r, submissions };
      }).catch(() => {});
      if (piece.returnedAt && early && early.returnedAt) await sharedNowPaper(piece.email, 'early:' + piece.code + ':' + piece.sub, piece.id);
    }
    // Writing again over it: the document is their writing now, every comment moved onto it.
    const st = room && room.students && room.students[piece.sub];
    if (st && st.status === 'admitted' && !st.handedIn) {
      const { state: d } = await readItem('luddite:draft:' + piece.code + ':' + piece.sub);
      if (d && typeof d.text === 'string' && d.text !== piece.text && (d.at || 0) > (piece.at || 0)) {
        piece = { ...piece, text: d.text, words: (d.text.trim().match(/\S+/g) || []).length, marks: reanchorMarks(piece.marks, piece.text, d.text), live: true };
      }
    }
    return respond(200, { sub: piece, roomRubric: (room && room.rubric) || null });
  }


  // PUT /luddite/marks { id, marks, endComment, grade, rubric, rubricScores } -- the teacher's comments,
  // cross-outs and insertions, all anchored to character offsets in the
  // (never-changing) text.
  if (path === '/luddite/marks' && method === 'PUT') {
    const piece = await ownSub(body.id, me, role);
    // Marked on their writing since (see GET /luddite/sub): the document takes
    // that writing, as it is now, and the marks move onto it.
    let text = piece.text, marks;
    if (typeof body.text === 'string' && body.text !== piece.text) {
      const { state: d } = await readItem('luddite:draft:' + piece.code + ':' + piece.sub);
      if (!d || typeof d.text !== 'string') throw new HttpError(409, 'text_changed');
      text = d.text;
      marks = cleanMarks(reanchorMarks(cleanMarks(body.marks, body.text.length), body.text, text), text.length);
    } else marks = cleanMarks(body.marks, piece.text.length);
    const endComment = String(body.endComment || '').slice(0, 8000);
    const grade = String(body.grade || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const rubric = body.rubric === undefined ? piece.rubric || null : cleanRubric(body.rubric);
    const rubricScores = cleanScores(body.rubricScores === undefined ? piece.rubricScores : body.rubricScores, rubric);
    const saved = await mutate('luddite:sub:' + piece.id, (x) => {
      const next = { ...x, text, words: (text.trim().match(/\S+/g) || []).length, marks, endComment, grade, rubric, rubricScores, markedAt: Date.now() };
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_ITEM_BYTES) throw new HttpError(413, 'too_many_marks');
      return next;
    });
    await mutate('luddite:early:' + piece.code + ':' + piece.sub, (x) => (x && !x.usedAt ? { ...x, usedAt: Date.now(), paperId: piece.id } : undefined)).catch(() => {});
    // The room's list shows which pieces have been marked.
    // Drive's copy carries the mark-up too (green text, cross-outs, comments, grade).
    await updateDriveDoc(piece.teacherSub, saved).catch((e) => console.warn('drive markup failed', e.detail || e.message));
    const count = marks.length + (endComment.trim() ? 1 : 0);
    await mutate('luddite:room:' + piece.code, (r) => {
      if (!r) return undefined;
      const i = (r.submissions || []).findIndex((x) => x.id === piece.id);
      if (i === -1 || (r.submissions[i].marked === count && (r.submissions[i].grade || '') === grade)) return undefined;
      const submissions = r.submissions.slice();
      submissions[i] = { ...submissions[i], marked: count, grade };
      return { ...r, submissions };
    }).catch(() => {});
    return respond(200, { ok: true, markedAt: saved.markedAt });
  }

  // PUT /luddite/handback { ids, back } -- hand papers back to their students
  // (back: false takes them back). Marks can still be changed afterwards.
  if (path === '/luddite/handback' && method === 'PUT') {
    const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, 200);
    const back = body.back !== false;
    const done = [];
    await inBatches(ids, async (id) => {
      // A student's writing so far ('early:<code>:<sub>'): shared the same
      // way, so they can read it while they write; it goes with the marks
      // onto their paper when they hand in.
      const ep = /^early:([^:]+):(.+)$/.exec(String(id || ''));
      if (ep) {
        const room = await getRoom(cleanCode(ep[1]));
        if (!ownsRoom(room, info, role)) throw new HttpError(403, 'not_your_room');
        const sub = ep[2], st = room.students[sub];
        if (!st) throw new HttpError(404, 'no_student');
        const at = back ? Date.now() : null;
        const { state: d } = await readItem('luddite:draft:' + room.code + ':' + sub);
        await mutate('luddite:early:' + room.code + ':' + sub, (x) => (x && !x.usedAt ? { ...x, returnedAt: at }
          : { base: d ? String(d.text || '') : '', marks: [], endComment: '', grade: '', rubric: null, rubricScores: [], at: Date.now(), returnedAt: at }));
        await mutate('luddite:mine:' + lower(st.email), (m) => {
          const list = ((m && m.returned) || []).filter((x) => x !== id);
          return { ...(m || {}), returned: back ? [id, ...list].slice(0, 200) : list };
        });
        await mutate('luddite:room:' + room.code, (r) => (r && r.students[sub] ? { ...r, students: { ...r.students, [sub]: { ...r.students[sub], earlyShared: at } } } : undefined));
        done.push({ id, returnedAt: at });
        return;
      }
      const piece = await ownSub(id, me, role);
      const at = back ? Date.now() : null;
      await mutate('luddite:sub:' + piece.id, (x) => ({ ...x, returnedAt: at }));
      await mutate('luddite:mine:' + lower(piece.email), (m) => {
        const list = ((m && m.returned) || []).filter((x) => x !== piece.id);
        return { ...(m || {}), returned: back ? [piece.id, ...list].slice(0, 200) : list };
      });
      await mutate('luddite:room:' + piece.code, (r) => {
        if (!r) return undefined;
        const i = (r.submissions || []).findIndex((x) => x.id === piece.id);
        if (i === -1) return undefined;
        const submissions = r.submissions.slice();
        submissions[i] = { ...submissions[i], returnedAt: at };
        return { ...r, submissions };
      }).catch(() => {});
      done.push({ id: piece.id, returnedAt: at });
    });
    return respond(200, { done });
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
            type: m.type, note: m.note || '', quote: m.type === 'arrow' ? arrowQuote(p.text, m) : m.type === 'insert' ? quote(Math.max(0, m.start - 40), m.start) : quote(m.start, m.end)
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

  // PUT /luddite/assignments { title, prompt, classId | emails, startAt | sittings, atHome } -- make a
  // writing session with a fresh two-word Entry Phrase. It needs a name that
  // says what it is. startAt (ms; omitted = now) is when it starts and the
  // teacher ends it; prompt (optional) is shown to students at the top of
  // the writing page; classId (optional) is the class let in on its own.
  if (path === '/luddite/assignments' && method === 'PUT') {
    const teacher = { ...me, name: await displayNameOf(info, role) };
    // A casual session needs no name or class: anyone with its Entry Phrase is let straight in.
    const casual = !!body.casual;
    // A casual session's name is its Entry Phrase, filled in once the phrase is picked below.
    const title = String(body.title || '').trim().slice(0, 80);
    if (!title && !casual) throw new HttpError(400, 'need_title');
    const prompt = String(body.prompt || '').trim().slice(0, MAX_PROMPT_CHARS);
    // Over several days (not casual or at home): the sittings, in order; it starts with the first.
    const sittings = casual || body.atHome ? null : cleanSittings(body.sittings);
    const startAt = sittings ? sittings[0].start : Number(body.startAt) > 0 ? Math.floor(Number(body.startAt)) : Date.now();
    // Who's let in on their own: a class, or a list of addresses typed in for this session alone.
    const emails = casual ? [] : cleanEmails(body.emails);
    if (emails.length > MAX_CLASS_EMAILS) throw new HttpError(413, 'too_many_emails');
    const cls = body.classId && !casual && !emails.length ? await getClass(body.classId, me, role) : null;
    let room = null;
    for (let i = 0; i < 12 && !room; i++) {
      const { code, codeLabel } = newRoomCode();
      try {
        room = await mutate('luddite:room:' + code, (r) => {
          if (r) throw new HttpError(409, 'code_taken');
          return { code, codeLabel, title: title || codeLabel, titled: !!title, atHome: !casual && !!body.atHome, teacher, classId: cls ? cls.id : null, emails: emails.length ? emails : undefined, startAt, sittings: sittings || undefined, prompt, casual, open: true, createdAt: Date.now(), students: {}, submissions: [] };
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
    // Each address on the session's own list finds it under their writing sessions.
    await inBatches(emails, (email) => mutate('luddite:mine:' + email, (m) => {
      const rooms = (m && m.rooms) || [];
      return { ...(m || {}), rooms: [room.code, ...rooms.filter((c) => c !== room.code)].slice(0, 60) };
    }));
    return respond(200, { room });
  }

  // PUT /luddite/assignment { code, action, subs, ... } -- admit | admitAll |
  // remove | release (let a student who handed in keep writing) | unlock (let
  // one who left the page back in to write) | close (stop
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
      else if (body.action === 'unlock') subs.forEach((sub) => { if (students[sub]) students[sub] = { ...students[sub], lockedOut: false, askedAt: 0, unlockedAt: Date.now() }; });
      else if (body.action === 'release') subs.forEach((sub) => { if (students[sub]) students[sub] = { ...students[sub], handedIn: false, askedAt: 0, releasedAt: Date.now() }; });
      else if (body.action === 'close') return { ...r, open: false, endedAt: Date.now() };
      else if (body.action === 'handIn') return undefined; // handed in below
      else if (body.action === 'startNow') return startedNow(r, Date.now());
      else if (body.action === 'open') return { ...r, open: true, endedAt: null, startAt: Date.now(), pausedAt: 0, pausedMs: 0, sittings: undefined };
      else if (body.action === 'pause' || body.action === 'resume') subs.forEach((sub) => { if (students[sub]) students[sub] = paused(students[sub], body.action === 'pause', Date.now()); });
      else if (body.action === 'pauseAll' || body.action === 'resumeAll') return paused(r, body.action === 'pauseAll', Date.now());
      else if (body.action === 'addProctor') {
        if (!EMAIL_RE.test(ownEmail)) throw new HttpError(400, 'bad_email');
        const list = r.proctors || [];
        if (list.includes(ownEmail)) return undefined;
        if (list.length >= MAX_PROCTORS) throw new HttpError(413, 'too_many_proctors');
        return { ...r, proctors: [...list, ownEmail] };
      }
      else if (body.action === 'removeProctor') return { ...r, proctors: (r.proctors || []).filter((e) => e !== ownEmail) };
      else if (body.action === 'schedule') {
        const startAt = Math.floor(Number(body.startAt));
        if (!(startAt > 0)) throw new HttpError(400, 'bad_time');
        // Over several days: every day moves by the same amount.
        if (r.sittings) {
          const by = startAt - r.sittings[0].start;
          return { ...r, open: true, endedAt: null, startAt, sittings: r.sittings.map((x) => ({ start: x.start + by, end: x.end + by })) };
        }
        return { ...r, open: true, endedAt: null, startAt };
      }
      else if (body.action === 'rubric') return { ...r, rubric: body.rubric ? cleanRubric(body.rubric) : null };
      // Students let in can read the rubric while they write (studentView, /luddite/rubricfile).
      else if (body.action === 'rubricShown') return { ...r, rubricShown: !!body.on };
      // Switching it on lets back in anyone locked out.
      else if (body.action === 'shareWork') return { ...r, shareWork: !!body.on };
      else if (body.action === 'atHome') {
        const on = !!body.on;
        const students = { ...r.students };
        if (on) Object.keys(students).forEach((sub) => { if (students[sub].lockedOut) students[sub] = { ...students[sub], lockedOut: false, askedAt: 0, unlockedAt: Date.now() }; });
        return { ...r, atHome: on, students };
      }
      else if (body.action === 'prompt') return { ...r, prompt: String(body.prompt || '').trim().slice(0, MAX_PROMPT_CHARS) };
      // Reflections (see /luddite/reflect): ask for one, stop asking, let a
      // student locked out of theirs back in, or let them change a handed-in one.
      else if (body.action === 'reflect') return { ...r, reflect: { prompt: String(body.prompt || '').trim().slice(0, MAX_PROMPT_CHARS), showGrading: !!body.showGrading, at: (r.reflect && r.reflect.at) || Date.now() } };
      else if (body.action === 'reflectOff') return { ...r, reflect: null };
      else if (body.action === 'reflectUnlock' || body.action === 'reflectReopen') {
        const students = { ...r.students };
        subs.forEach((sub) => {
          const s = students[sub];
          if (!s || !s.reflect) return;
          students[sub] = { ...s, reflect: body.action === 'reflectUnlock' ? { ...s.reflect, lockedOut: false, askedAt: 0 } : { ...s.reflect, status: 'reflecting', handedInAt: 0, lockedOut: false } };
        });
        return { ...r, students };
      }
      else if (body.action === 'rename') {
        const title = String(body.title || '').trim().slice(0, 80);
        if (!title) throw new HttpError(400, 'need_title');
        return { ...r, title, titled: true };
      }
      else if (body.action === 'own') {
        if (!EMAIL_RE.test(ownEmail)) throw new HttpError(400, 'bad_email');
        const multiplier = Math.min(4, Math.max(1, Math.round((Number(body.multiplier) || 1) * 4) / 4));
        const blocks = cleanBlocks(body.blocks);
        if (blocks) return { ...r, own: { ...(r.own || {}), [ownEmail]: { startAt: blocks[0].start, multiplier: 1, blocks, setAt: Date.now() } } };
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
      await noteProctoring(code);
    }
    // A session's proctor finds it from their own login.
    if (body.action === 'addProctor' || body.action === 'removeProctor') {
      const add = body.action === 'addProctor';
      await mutate('luddite:mine:' + ownEmail, (m) => {
        const list = ((m && m.proctor) || []).filter((c) => c !== code);
        return { ...(m || {}), proctor: add ? [code, ...list].slice(0, 60) : list };
      });
    }
    if (body.action === 'delete') {
      await mutate('luddite:teacher:' + room.teacher.sub, (t) => ({ ...(t || {}), rooms: ((t && t.rooms) || []).filter((c) => c !== code) }));
    }
    // Ending a session hands in for everyone still writing in it (from the
    // backup of their writing), except students on a schedule of their own.
    // Their own page then hands in again with everything up to the last
    // keystroke, replacing this copy.
    if (body.action === 'close') {
      const open = Object.entries(room.students).filter(([, st]) => st.status === 'admitted' && !st.handedIn && !(room.own && room.own[lower(st.email)]));
      await handInFromBackups(code, open, 'Handed in at the end');
      if (open.length) return respond(200, { room: await getRoom(code) });
    }
    // Closing one student's paper (an alternative schedule's, say): hand in now.
    if (body.action === 'handIn') {
      const list = subs.map((sub) => [sub, room.students[sub]]).filter(([, st]) => st && st.status === 'admitted' && !st.handedIn);
      await handInFromBackups(code, list, 'Handed in by the teacher');
      return respond(200, { room: await getRoom(code) });
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

  // GET /luddite/proctors -- permanent proctors; PUT { add: email } or { remove: email }.
  // An owner can't make themselves one: proctors see Horace Mann teachers'
  // sessions, which the owners don't (see ownerMayOpen).
  if (path === '/luddite/proctors') {
    let state;
    if (method === 'PUT') {
      const add = lower(body.add);
      const remove = lower(body.remove);
      if (add && !EMAIL_RE.test(add)) throw new HttpError(400, 'bad_email');
      if (add && OWNER_EMAILS.includes(add)) throw new HttpError(400, 'owner_not_proctor');
      state = await mutate('luddite:proctors', (t) => {
        const emails = { ...((t && t.emails) || {}) };
        if (add) emails[add] = { addedAt: Date.now() };
        if (remove) delete emails[remove];
        return { emails };
      });
    } else {
      state = (await readItem('luddite:proctors')).state;
    }
    const emails = (state && state.emails) || {};
    return respond(200, { always: TESTING_CENTER_EMAILS, proctors: Object.keys(emails).sort().map((email) => ({ email, addedAt: emails[email].addedAt })) });
  }

  return respond(404, { error: 'Not found' });
}

// ---------------------------------------------------------------------
// Proctors
// ---------------------------------------------------------------------
async function isPermanentProctor(email) {
  const e = lower(email);
  if (!e || OWNER_EMAILS.includes(e)) return false;
  if (TESTING_CENTER_EMAILS.includes(e)) return true;
  const { state } = await readItem('luddite:proctors');
  return !!(state && state.emails && state.emails[e]);
}

async function noteProctoring(code) {
  await mutate('luddite:proctoring', (p) => {
    const codes = (p && p.codes) || [];
    return codes[0] === code ? undefined : { codes: [code, ...codes.filter((c) => c !== code)].slice(0, PROCTORING_INDEX_MAX) };
  });
}

// What this person may proctor in a session: 'session' (added to it: everyone
// in it), 'own' (a permanent proctor: the students with own time, and the
// waiting room) or null.
function proctorReach(room, email, permanent) {
  const e = lower(email);
  if (!room || room.deletedAt) return null;
  if ((room.proctors || []).includes(e)) return 'session';
  if (permanent && Object.keys(room.own || {}).length) return 'own';
  return null;
}

// Whether a session still needs proctoring: it hasn't ended for somebody.
function proctorLive(room, now) {
  const regular = stateAt({ ...regularWindow(room), ended: regularEnded(room) }, now);
  if (regular !== 'ended') return true;
  return Object.keys(room.own || {}).some((em) => stateAt(windowOf(room, em, null), now) !== 'ended');
}

// A session as a proctor sees it: who's in it and where they are, never
// what anyone has written.
function proctorView(room, reach) {
  const now = Date.now();
  const own = room.own || {};
  const people = [];
  const seen = new Set();
  Object.entries(room.students || {}).forEach(([sub, s]) => {
    const em = lower(s.email);
    const mine = reach === 'session' || !!own[em] || s.status === 'waiting';
    if (!mine || s.status === 'removed') return;
    seen.add(em);
    const win = windowOf(room, em, s);
    people.push({
      sub, email: s.email, name: s.name || '', status: s.status, requestedAt: s.requestedAt || 0,
      lockedOut: !!s.lockedOut, askedAt: s.askedAt || 0, handedIn: !!s.handedIn, away: !!s.away,
      live: !!(s.writing && s.lastSeen && now - s.lastSeen < 25000), paused: !!s.pausedAt,
      own: own[em] || null, state: stateAt(win, now), startAt: win.start, endAt: win.end, nextAt: win.nextAt || null
    });
  });
  // Students with own time who haven't come in yet.
  Object.keys(own).forEach((em) => {
    if (seen.has(em)) return;
    const win = windowOf(room, em, null);
    people.push({ sub: null, email: em, name: '', status: 'notHere', own: own[em], state: stateAt(win, now), startAt: win.start, endAt: win.end });
  });
  const reg = regularWindow(room);
  return {
    code: room.code, codeLabel: room.codeLabel || room.code, title: titleOf(room), teacherName: room.teacher.name || room.teacher.email,
    reach, prompt: room.prompt || '', state: stateAt({ ...reg, ended: regularEnded(room) }, now), startAt: reg.start, paused: !!room.pausedAt || !!(room.sittings && !room.atHome && sittingsWindow(room, '', null, now).paused),
    people, now
  };
}

async function routeProctor(method, path, q, body, me) {
  const permanent = await isPermanentProctor(me.email);
  const now = Date.now();

  // GET /luddite/proctor -- the sessions this person proctors that haven't ended.
  if (path === '/luddite/proctor' && method === 'GET') {
    const { state: mine } = await readItem('luddite:mine:' + lower(me.email));
    const codes = new Set((mine && mine.proctor) || []);
    if (permanent) ((await readItem('luddite:proctoring')).state?.codes || []).forEach((c) => codes.add(c));
    const rooms = [];
    const list = [...codes];
    for (let i = 0; i < list.length; i += 25) {
      const got = await Promise.all(list.slice(i, i + 25).map((c) => readItem('luddite:room:' + c)));
      got.forEach(({ state: r }) => { if (r) rooms.push(r); });
    }
    const sessions = rooms.map((r) => ({ r, reach: proctorReach(r, me.email, permanent) }))
      .filter(({ r, reach }) => reach && proctorLive(r, now))
      .map(({ r, reach }) => {
        const v = proctorView(r, reach);
        return {
          code: v.code, title: v.title, teacherName: v.teacherName, reach, state: v.state, startAt: v.startAt, paused: v.paused,
          count: v.people.filter((p) => p.status !== 'waiting').length,
          waiting: v.people.filter((p) => p.status === 'waiting').length,
          locked: v.people.filter((p) => p.lockedOut && !p.handedIn).length,
          writing: v.people.filter((p) => p.live).length,
          next: Math.min(...v.people.map((p) => (p.state === 'upcoming' ? p.startAt : Infinity)))
        };
      });
    return respond(200, { sessions, permanent, now });
  }

  // GET /luddite/proctor/session?code= -- one session, as its proctor sees it.
  if (path === '/luddite/proctor/session' && method === 'GET') {
    const room = await getRoom(cleanCode(q.code));
    const reach = proctorReach(room, me.email, permanent);
    if (!reach) throw new HttpError(403, 'not_proctor');
    return respond(200, { session: proctorView(room, reach) });
  }

  // PUT /luddite/proctor/session { code, action, subs, email } -- admit (from
  // the waiting room) | unlock (let back in after leaving the page) | begin
  // (start a student's own time now) | pause | resume (one student) |
  // startNow | pauseAll | resumeAll (the whole session; added proctors only).
  if (path === '/luddite/proctor/session' && method === 'PUT') {
    const code = cleanCode(body.code);
    const subs = Array.isArray(body.subs) ? body.subs.map(String) : [];
    const email = lower(body.email);
    let reach = null;
    const room = await mutate('luddite:room:' + code, (r) => {
      reach = proctorReach(r, me.email, permanent);
      if (!reach) throw new HttpError(403, 'not_proctor');
      const t = Date.now();
      const own = r.own || {};
      const students = { ...r.students };
      // A permanent proctor reaches students with own time, and the waiting room.
      const mayTouch = (sub) => {
        const s = students[sub];
        return !!s && s.status !== 'removed' && (reach === 'session' || !!own[lower(s.email)] || s.status === 'waiting');
      };
      if (subs.some((sub) => !mayTouch(sub))) throw new HttpError(403, 'not_proctor');
      const whole = ['startNow', 'pauseAll', 'resumeAll'].includes(body.action);
      if (whole && reach !== 'session') throw new HttpError(403, 'not_proctor');
      if (body.action === 'admit') subs.forEach((sub) => { if (students[sub].status === 'waiting') students[sub] = { ...students[sub], status: 'admitted', decidedAt: t, via: 'proctor' }; });
      // Unlocking lets them write again, whatever locked them: leaving the page, handing in, or the time being up.
      else if (body.action === 'unlock') subs.forEach((sub) => { students[sub] = { ...students[sub], lockedOut: false, askedAt: 0, unlockedAt: t, ...(students[sub].handedIn ? { handedIn: false, releasedAt: t } : {}) }; });
      else if (body.action === 'pause' || body.action === 'resume') subs.forEach((sub) => { students[sub] = paused(students[sub], body.action === 'pause', t); });
      else if (body.action === 'begin') {
        if (!EMAIL_RE.test(email)) throw new HttpError(400, 'bad_email');
        if (!own[email] && reach !== 'session') throw new HttpError(403, 'not_proctor');
        const cur = own[email];
        if (cur && cur.blocks) {
          // In parts: the next part not yet started begins now, as long as it was.
          if (cur.blocks.some((b) => t >= b.start && t < b.end)) return undefined;
          const i = cur.blocks.findIndex((b) => b.start > t);
          if (i === -1) throw new HttpError(409, 'no_part_left');
          const blocks = cur.blocks.slice();
          blocks[i] = { start: t, end: t + (blocks[i].end - blocks[i].start) };
          if (blocks[i + 1] && blocks[i].end > blocks[i + 1].start) blocks[i].end = blocks[i + 1].start;
          return { ...r, own: { ...own, [email]: { ...cur, blocks, startAt: blocks[0].start, setAt: t, begunBy: lower(me.email) } } };
        }
        return { ...r, own: { ...own, [email]: { ...(own[email] || { multiplier: 1 }), startAt: t, setAt: t, begunBy: lower(me.email) } } };
      }
      else if (body.action === 'startNow') return startedNow(r, t);
      else if (body.action === 'pauseAll' || body.action === 'resumeAll') return paused(r, body.action === 'pauseAll', t);
      else if (body.action === 'handIn') return undefined; // handed in below
      else throw new HttpError(400, 'bad_action');
      return { ...r, students };
    });
    // Closing a student's paper: hand in now, with what they've written.
    if (body.action === 'handIn') {
      const list = subs.map((sub) => [sub, room.students[sub]]).filter(([, st]) => st && st.status === 'admitted' && !st.handedIn);
      await handInFromBackups(code, list, 'Handed in by the proctor');
      return respond(200, { session: proctorView(await getRoom(code), reach) });
    }
    if (body.action === 'begin') {
      await mutate('luddite:mine:' + email, (m) => {
        const list = (m && m.own) || [];
        return list.includes(code) ? undefined : { ...(m || {}), own: [code, ...list].slice(0, 60) };
      });
      await noteProctoring(code);
    }
    return respond(200, { session: proctorView(room, reach) });
  }

  return respond(404, { error: 'Not found' });
}

// ---------------------------------------------------------------------
// Luddite HM administrators
// ---------------------------------------------------------------------
// Horace Mann's administration can read everything that Horace Mann
// teachers and their students have written in Luddite HM: writing
// sessions and their prompts, classes, rubrics, students' backed-up drafts,
// papers, and every teacher's mark-up, end comment and grade. It is
// read-only (an administrator can't change, mark up or hand back anything),
// and it is Luddite HM's alone:
//   - the request has to come from the Luddite HM page: its Origin header
//     (which the browser sets, and a page can't fake) must be HM_ORIGIN, so
//     the regular Luddite page at jake-goldwasser.com can't reach any of it;
//   - the person has to be signed in with an @horacemann.org account that
//     is on the administrator list;
//   - and they only ever see work whose teacher has an @horacemann.org
//     address (never a regular Luddite teacher's).
// The primary administrator (HM_PRIMARY_ADMINS, Cassandra Parets) can't be
// removed, and adds or removes other administrators (any @horacemann.org
// address). Jake (HM_ADMIN_MANAGERS) can also add and remove them, but sees
// nothing else: no work, no access log. Every look an administrator takes is written
// to a log that the administrators can read.
//   luddite:hmadmins     { emails: { [email]: { addedAt, addedBy } } }
//   luddite:hmadminlog   { entries: [{ at, email, what, id, label }] } newest first
// Listing everything needs dynamodb:Scan on the table (README.md, step 3).
const HM_ORIGIN = 'https://jakegoldwasser-hm.github.io';
const HM_PRIMARY_ADMINS = ['cassandra_parets@horacemann.org'];
// Can add and remove administrators, but can't read anyone's work or the
// access log: Jake runs the service and asked not to see Horace Mann's data.
const HM_ADMIN_MANAGERS = ['jake_goldwasser@horacemann.org'];
const HM_LOG_MAX = 1500;
const isHm = (email) => /@horacemann\.org$/.test(lower(email));

async function hmAdminOf(email) {
  const em = lower(email);
  if (!isHm(em)) return null;
  if (HM_PRIMARY_ADMINS.includes(em)) return 'primary';
  if (HM_ADMIN_MANAGERS.includes(em)) return 'manager';
  const { state } = await readItem('luddite:hmadmins');
  return state && state.emails && state.emails[em] ? 'admin' : null;
}

// Every item whose key starts with one of the prefixes.
async function scanPrefixes(prefixes) {
  const out = [];
  let start;
  do {
    let res;
    try {
      res = await ddb.send(new ScanCommand({
        TableName: TABLE_NAME, ExclusiveStartKey: start,
        FilterExpression: prefixes.map((_, i) => 'begins_with(pk, :p' + i + ')').join(' OR '),
        ExpressionAttributeValues: Object.fromEntries(prefixes.map((p, i) => [':p' + i, { S: p }]))
      }));
    } catch (e) {
      if (e.name === 'AccessDeniedException') throw new HttpError(503, 'needs_scan_permission');
      throw e;
    }
    for (const it of res.Items || []) {
      try { out.push({ pk: it.pk.S, state: JSON.parse(it.state.S) }); } catch (e) { /* not one of ours */ }
    }
    start = res.LastEvaluatedKey;
  } while (start);
  return out;
}

async function hmLog(email, what, id, label) {
  await mutate('luddite:hmadminlog', (l) => ({
    entries: [{ at: Date.now(), email: lower(email), what, id: String(id || ''), label: String(label || '').slice(0, 120) },
      ...((l && l.entries) || [])].slice(0, HM_LOG_MAX)
  }));
}

// A writing session an administrator may read, or a 404 (never a hint
// that a regular Luddite session exists).
async function hmRoom(code) {
  const { state } = await readItem('luddite:room:' + cleanCode(code));
  if (!state || !state.teacher || !isHm(state.teacher.email)) throw new HttpError(404, 'not_found');
  return state;
}

async function adminList() {
  const { state } = await readItem('luddite:hmadmins');
  const emails = (state && state.emails) || {};
  return {
    primary: HM_PRIMARY_ADMINS,
    managers: HM_ADMIN_MANAGERS,
    admins: Object.keys(emails).filter((e) => !HM_PRIMARY_ADMINS.includes(e) && !HM_ADMIN_MANAGERS.includes(e)).sort()
      .map((email) => ({ email, addedAt: emails[email].addedAt, addedBy: emails[email].addedBy || '' }))
  };
}

async function routeHmAdmin(event, method, path, q, body, me) {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  if (origin !== HM_ORIGIN) return respond(404, { error: 'Not found' });
  const level = await hmAdminOf(me.email);
  if (!level) return respond(403, { error: 'not_admin' });
  const canGrant = level === 'primary' || level === 'manager';

  // GET /luddite/admin/me -- am I an administrator? (The page's banner.)
  if (path === '/luddite/admin/me' && method === 'GET') {
    return respond(200, { admin: { email: lower(me.email), primary: level === 'primary', manager: level === 'manager', canGrant } });
  }

  // A manager only manages the list of administrators.
  if (level === 'manager' && path !== '/luddite/admin/admins') return respond(403, { error: 'manager_only_admins' });

  // GET /luddite/admin/overview -- every Horace Mann teacher, with their
  // writing sessions, classes and rubrics.
  if (path === '/luddite/admin/overview' && method === 'GET') {
    const items = await scanPrefixes(['luddite:room:', 'luddite:class:', 'luddite:teacher:']);
    const teachers = new Map();
    const teacherOf = (t) => {
      if (!t || !t.sub || !isHm(t.email)) return null;
      if (!teachers.has(t.sub)) teachers.set(t.sub, { sub: t.sub, email: lower(t.email), name: t.name || '', sessions: [], classes: [], rubrics: [], displayName: '' });
      return teachers.get(t.sub);
    };
    for (const { pk, state: s } of items) {
      if (pk.startsWith('luddite:room:')) {
        const t = teacherOf(s.teacher);
        if (!t) continue;
        const sum = roomSummary(s);
        t.sessions.push({ ...sum, prompt: shortPrompt(s.prompt), students: Object.keys(s.students || {}).length, deleted: !!s.deletedAt });
      } else if (pk.startsWith('luddite:class:')) {
        const t = teacherOf(s.teacher);
        if (t) t.classes.push({ id: s.id, name: s.name, count: (s.emails || []).length, createdAt: s.createdAt, deleted: !!s.deletedAt });
      }
    }
    for (const { pk, state: s } of items) {
      if (!pk.startsWith('luddite:teacher:')) continue;
      const t = teachers.get(pk.slice('luddite:teacher:'.length));
      if (!t) continue;
      t.displayName = s.displayName || '';
      t.rubrics = s.rubrics || [];
      t.studentCount = Object.keys(s.students || {}).length;
    }
    const list = [...teachers.values()].sort((a, b) => (a.displayName || a.name || a.email).localeCompare(b.displayName || b.name || b.email));
    for (const t of list) { t.sessions.sort((a, b) => (b.startAt || b.createdAt || 0) - (a.startAt || a.createdAt || 0)); t.classes.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); }
    await hmLog(me.email, 'overview', '', 'All teachers');
    return respond(200, { teachers: list });
  }

  // GET /luddite/admin/session?code= -- one writing session as its teacher
  // sees it: prompt, students, live status, papers.
  if (path === '/luddite/admin/session' && method === 'GET') {
    const room = await hmRoom(q.code);
    await hmLog(me.email, 'session', room.code, titleOf(room) + ' (' + room.teacher.email + ')');
    return respond(200, { room: { ...room, title: titleOf(room) }, roster: await rosterOf(room) });
  }

  // GET /luddite/admin/paper?id= -- one handed-in paper with its mark-up,
  // end comment, grade and rubric scores.
  if (path === '/luddite/admin/paper' && method === 'GET') {
    const id = String(q.id || '');
    const { state: paper } = await readItem('luddite:sub:' + id);
    if (!paper) throw new HttpError(404, 'not_found');
    const room = await hmRoom(paper.code);
    await hmLog(me.email, 'paper', id, (paper.name || paper.email) + ', ' + titleOf(room));
    // markedHtml: the paper with its mark-up, as it goes to Drive (everything in it escaped).
    return respond(200, { paper, markedHtml: markedHtml(paper), roomRubric: room.rubric || null, teacher: room.teacher });
  }

  // GET /luddite/admin/rubricfile?id= -- a rubric's PDF (base64), if a Horace Mann teacher brought it in.
  if (path === '/luddite/admin/rubricfile' && method === 'GET') {
    const id = String(q.id || '');
    const { state: meta } = /^[a-f0-9]{24}$/.test(id) ? await readItem('luddite:rubricfile:' + id) : { state: null };
    if (!meta || !isHm(meta.ownerEmail)) throw new HttpError(404, 'not_found');
    await hmLog(me.email, 'rubric', id, 'Rubric PDF from ' + meta.ownerEmail);
    const parts = await Promise.all(Array.from({ length: meta.n }, (_, i) => readItem('luddite:rubricfile:' + id + ':' + i)));
    return respond(200, { data: parts.map((x) => (x.state && x.state.data) || '').join('') });
  }

  // GET /luddite/admin/draft?code=&sub= -- a student's backed-up writing.
  if (path === '/luddite/admin/draft' && method === 'GET') {
    const room = await hmRoom(q.code);
    const sub = String(q.sub || '');
    const s = (room.students || {})[sub];
    if (!s) throw new HttpError(404, 'not_found');
    const { state: draft } = await readItem('luddite:draft:' + room.code + ':' + sub);
    await hmLog(me.email, 'draft', room.code + ':' + sub, (s.name || s.email) + ', ' + titleOf(room));
    return respond(200, { draft: draft || null, student: { name: s.name, email: s.email } });
  }

  // GET /luddite/admin/class?id= -- a class and its list of addresses.
  if (path === '/luddite/admin/class' && method === 'GET') {
    const { state: cls } = await readItem('luddite:class:' + String(q.id || ''));
    if (!cls || !cls.teacher || !isHm(cls.teacher.email)) throw new HttpError(404, 'not_found');
    await hmLog(me.email, 'class', cls.id, cls.name + ' (' + cls.teacher.email + ')');
    return respond(200, { class: cls });
  }

  // GET /luddite/admin/log -- who has looked at what.
  if (path === '/luddite/admin/log' && method === 'GET') {
    const { state } = await readItem('luddite:hmadminlog');
    return respond(200, { entries: ((state && state.entries) || []).slice(0, 500) });
  }

  // GET /luddite/admin/admins; PUT { add: email } or { remove: email }
  // (primary administrators only).
  if (path === '/luddite/admin/admins') {
    if (method === 'PUT') {
      if (!canGrant) throw new HttpError(403, 'primary_only');
      const add = lower(body.add), remove = lower(body.remove);
      if (add && (!EMAIL_RE.test(add) || !isHm(add))) throw new HttpError(400, 'horacemann_only');
      if (remove && (HM_PRIMARY_ADMINS.includes(remove) || HM_ADMIN_MANAGERS.includes(remove))) throw new HttpError(400, 'cannot_remove_primary');
      await mutate('luddite:hmadmins', (a) => {
        const emails = { ...((a && a.emails) || {}) };
        if (add && !HM_PRIMARY_ADMINS.includes(add) && !HM_ADMIN_MANAGERS.includes(add) && !emails[add]) emails[add] = { addedAt: Date.now(), addedBy: lower(me.email) };
        if (remove) delete emails[remove];
        return { emails };
      });
      await hmLog(me.email, add ? 'added admin' : 'removed admin', add || remove, add || remove);
    }
    return respond(200, await adminList());
  }

  return respond(404, { error: 'Not found' });
}

// A teacher's class ids in their order: oldest first, as dragged since. They
// used to be kept newest first; `classesOrdered` marks a list put the right way round.
function classIdsOf(t) {
  const ids = (t && t.classes) || [];
  return t && t.classesOrdered ? ids.slice() : ids.slice().reverse();
}
async function classesOf(teacherState) {
  const ids = classIdsOf(teacherState);
  const list = await Promise.all(ids.map((id) => readItem('luddite:class:' + id)));
  return list.map((x) => x.state).filter((c) => c && !c.deletedAt).map(classSummary);
}

// Hands in for these students now, from the backup of their writing (the
// session ending, or a teacher or proctor closing one student's paper). With
// nothing written they're just marked handed in, so they can't write on. Their
// own page then hands in again with everything up to the last keystroke.
async function handInFromBackups(code, list, label) {
  await inBatches(list, async ([sub, st]) => {
    const { state: draft } = await readItem('luddite:draft:' + code + ':' + sub);
    const fresh = await getRoom(code);
    if (!fresh.students[sub] || fresh.students[sub].handedIn) return;
    if (!draft || !String(draft.text || '').trim()) {
      if (label === 'Handed in at the end') return;
      await mutate('luddite:room:' + code, (r) => (r.students[sub] ? { ...r, students: { ...r.students, [sub]: { ...r.students[sub], handedIn: true, autoHandedIn: true, askedAt: 0, writing: false } } } : undefined));
      return;
    }
    await handInFor(fresh, code, { sub, email: st.email, name: st.name }, fresh.students[sub], String(draft.text).slice(0, MAX_SUBMISSION_CHARS), label, true)
      .catch((e) => console.warn('auto hand-in failed', sub, e.message));
  });
}

// The addresses on an assignment's class, so its teacher can see who hasn't come in.
// Hands one student's writing in: Drive (when connected), Luddite's own copy
// to mark up, the teacher's student list, and the room. `auto` when Luddite
// does it for them because the session ended while they were writing.
// Shared writing so far became a paper: the student's list of shared
// grading lists the paper in its place.
async function sharedNowPaper(email, earlyId, paperId) {
  await mutate('luddite:mine:' + lower(email), (m) => {
    const list = (m && m.returned) || [];
    if (!list.includes(earlyId)) return undefined;
    return { ...m, returned: [paperId, ...list.filter((x) => x !== earlyId && x !== paperId)].slice(0, 200) };
  }).catch(() => {});
}

async function handInFor(room, code, me, s, text, label, auto) {
  const words = (text.trim().match(/\S+/g) || []).length;
  const who = me.name || me.email;
  // One document: a student who handed in before (and was let back in)
  // hands in to the same paper, its comments, grade and sharing kept.
  const prevSub = (room.submissions || []).find((x) => x.sub === me.sub && x.stored);
  const prev = prevSub ? (await readItem('luddite:sub:' + prevSub.id)).state : null;
  // Drive is where the teacher keeps it; Luddite keeps its own copy to
  // mark up. A Drive hiccup (or no Drive yet) no longer loses the piece.
  let file = null, driveError = null;
  if (!prev) try {
    file = await saveToDrive(room, {
      name: who + ' — ' + label,
      description: (auto ? 'Handed in by Luddite when the session ended, for ' : 'Submitted through Luddite by ') + who + ' (' + me.email + '), writing session ' + titleOf(room) + ' (' + code + '). ' +
        words + ' words. Left the page ' + (s.leaves || 0) + (s.leaves === 1 ? ' time.' : ' times.'),
      text
    });
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    driveError = e.message;
  }
  // What they typed since the last backup goes in the writing log too.
  await saveDraft(code, me.sub, text, s.lastSeen || 0).catch(() => {});
  const stored = text.length <= MAX_STORED_CHARS;
  if (!file && !stored) throw new HttpError(409, driveError);
  const at = Date.now();
  const id = prev ? prev.id : file ? file.id : 'l' + randomUUID();
  const win = windowOf(room, lower(me.email), s);
  // (Before one document per student, a hand-in again made a new paper and
  // the earlier ones were listed in `replaces`; those old copies stay listed.)
  const earlier = (room.submissions || []).filter((x) => x.sub === me.sub);
  const replaces = earlier.flatMap((x) => [x.id, ...(x.replaces || [])]).filter((x) => x !== id);
  const submission = { id, sub: me.sub, ...(auto ? { auto: true } : {}), email: me.email, name: me.name, words, leaves: s.leaves || 0, at,
    link: prev ? prev.link || null : file ? file.webViewLink : null, stored, driveError, marked: 0, late: !!(win.end && at > win.end + (win.own ? OWN_GRACE_MS : 0) + LATE_GRACE_MS),
    ...(replaces.length ? { replaces } : {}) };
  if (stored) {
    // The chat with the teacher while they wrote goes with the paper (the most
    // recent messages, if there were very many), so administrators see it too.
    const { state: chatState } = await readItem('luddite:chat:' + code + ':' + me.sub);
    const chat = [];
    let left = MAX_PAPER_CHAT_CHARS;
    for (const m of ((chatState && chatState.msgs) || []).slice().reverse()) {
      if ((left -= m.text.length) < 0) break;
      chat.unshift(m);
    }
    // Marks the teacher made on the draft move onto the paper (see reanchorMarks).
    const { state: early } = await readItem('luddite:early:' + code + ':' + me.sub);
    const early1 = early && !early.usedAt ? early : null;
    const both = (x, y) => (x && y && x.trim() !== y.trim() ? x + '\n\n' + y : x || y || '');
    const carried = {
      marks: mergeMarks(prev ? reanchorMarks(prev.marks, prev.text, text) : [], early1 ? reanchorMarks(early1.marks, early1.base, text) : []),
      endComment: both(prev && prev.endComment, early1 && early1.endComment),
      grade: (early1 && early1.grade) || (prev && prev.grade) || ''
    };
    const rubricFrom = (early1 && early1.rubric) ? early1 : (prev && prev.rubric) ? prev : null;
    if (rubricFrom) Object.assign(carried, { rubric: rubricFrom.rubric, rubricScores: rubricFrom.rubricScores || [] });
    if (early1 || prev) Object.assign(carried, { markedAt: Math.max((early1 && early1.at) || 0, (prev && prev.markedAt) || 0) || undefined });
    submission.marked = carried.marks.length + (carried.endComment.trim() ? 1 : 0);
    if (carried.grade) submission.grade = carried.grade;
    if (prev && prev.returnedAt) submission.returnedAt = prev.returnedAt;
    else if (early1 && early1.returnedAt) Object.assign(carried, { returnedAt: early1.returnedAt, view: early1.view }), submission.returnedAt = early1.returnedAt;
    if (early1) await mutate('luddite:early:' + code + ':' + me.sub, (x) => (x ? { ...x, usedAt: Date.now(), paperId: id } : undefined));
    if (early1 && early1.returnedAt) await sharedNowPaper(me.email, 'early:' + code + ':' + me.sub, id);
    const paper = await mutate('luddite:sub:' + id, () => ({
      ...(prev || {}),
      ...(prev ? { gathered: prev.gathered || !(prev.replaces || []).length } : {}),
      id, code, roomTitle: titleOf(room), teacherSub: room.teacher.sub, sub: me.sub, email: me.email, name: me.name,
      label, text, words, leaves: s.leaves || 0, at, link: submission.link, ...carried,
      ...(chat.length ? { chat } : {})
    }));
    // The Drive copy is the same file, rewritten.
    if (prev && paper.link) await updateDriveDoc(room.teacher.sub, paper).catch((e) => console.warn('drive update failed', e.detail || e.message));
    const email = me.email.toLowerCase();
    await mutate('luddite:tstudent:' + room.teacher.sub + ':' + email, (t) => ({
      email, name: me.name || (t && t.name) || '',
      subs: [{ id, at, roomTitle: titleOf(room), label, words }, ...((t && t.subs) || []).filter((x) => x.id !== id && !replaces.includes(x.id))]
    }));
    await mutate('luddite:teacher:' + room.teacher.sub, (t) => {
      const students = { ...((t && t.students) || {}) };
      const prev = students[email] || { count: 0 };
      students[email] = { name: me.name || prev.name || '', last: at, count: prev.count + (earlier.length ? 0 : 1) };
      return { ...(t || { rooms: [] }), students };
    });
  }
  // So the student finds this session again for a reflection (/luddite/reflections).
  await mutate('luddite:mine:' + lower(me.email), (m) => {
    const handed = (m && m.handed) || [];
    return handed.includes(code) ? undefined : { ...(m || {}), handed: [code, ...handed].slice(0, 300) };
  });
  const saved = await mutate('luddite:room:' + code, (r) => ({
    ...r,
    submissions: [submission, ...(r.submissions || []).filter((x) => x.sub !== me.sub)],
    students: { ...r.students, [me.sub]: { ...r.students[me.sub], submittedAt: submission.at, submissions: (r.students[me.sub].submissions || 0) + 1, words, handedIn: true, autoHandedIn: !!auto, askedAt: 0, writing: false } }
  }));
  return saved;
}

// A rubric: skills down the side, the teacher's own levels across the top
// (each cell can describe that level), and optionally each skill's share of
// the grade in percent.
function cleanRubric(x) {
  if (!x || typeof x !== 'object') return null;
  const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  if (x.kind === 'doc') return cleanDocRubric(x, str);
  const levels = (Array.isArray(x.levels) ? x.levels : []).slice(0, 6).map((l) => str(l, 40) || 'Level');
  if (levels.length < 2) return null;
  const weighted = !!x.weighted;
  const rows = (Array.isArray(x.rows) ? x.rows : []).slice(0, 25).map((row) => ({
    skill: str(row && row.skill, 200),
    cells: levels.map((_, i) => str(row && Array.isArray(row.cells) ? row.cells[i] : '', 400)),
    ...(weighted ? { weight: Math.max(0, Math.min(100, Math.round(Number(row && row.weight) || 0))) } : {})
  })).filter((row) => row.skill);
  if (!rows.length) return null;
  const id = /^[a-z0-9]{6,16}$/.test(String(x.id || '')) ? String(x.id) : randomUUID().replace(/-/g, '').slice(0, 12);
  return { id, name: str(x.name, 80) || 'Rubric', levels, weighted, rows };
}
// A rubric the teacher brings in whole instead of building as a grid:
// pasted (`blocks`: paragraphs and tables, kept as plain text), or a PDF
// (`fileId`, stored apart in luddite:rubricfile:<id>; see /luddite/rubricfile),
// which is also what a Google Doc becomes (`docId`, so it can be fetched again).
const MAX_RUBRIC_CHARS = 40000;
function cleanDocRubric(x, str) {
  const cell = (v, n) => String(v == null ? '' : v).replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, n);
  let budget = MAX_RUBRIC_CHARS;
  const spend = (t) => { const out = t.slice(0, Math.max(0, budget)); budget -= out.length; return out; };
  const blocks = [];
  for (const b of (Array.isArray(x.blocks) ? x.blocks : []).slice(0, 400)) {
    if (budget <= 0 || !b || typeof b !== 'object') continue;
    if (Array.isArray(b.table)) {
      const table = b.table.slice(0, 40).map((row) => (Array.isArray(row) ? row : []).slice(0, 10).map((c) => spend(cell(c, 1500))));
      if (table.some((row) => row.some(Boolean))) blocks.push({ table });
    } else {
      const p = spend(cell(b.p, 3000));
      if (p) blocks.push(b.h ? { p, h: true } : { p });
    }
  }
  const fileId = /^[a-f0-9]{24}$/.test(String(x.fileId || '')) ? String(x.fileId) : '';
  if (!blocks.length && !fileId) return null;
  const id = /^[a-z0-9]{6,16}$/.test(String(x.id || '')) ? String(x.id) : randomUUID().replace(/-/g, '').slice(0, 12);
  const out = { id, kind: 'doc', name: str(x.name, 80) || 'Rubric', at: Math.floor(Number(x.at)) || Date.now() };
  if (fileId) {
    out.fileId = fileId;
    out.pages = Math.max(1, Math.min(40, Math.floor(Number(x.pages)) || 1));
    if (/^[A-Za-z0-9_-]{10,100}$/.test(String(x.docId || ''))) out.docId = String(x.docId);
  } else out.blocks = blocks;
  return out;
}
const MAX_RUBRIC_PDF_BYTES = 2.5 * 1024 * 1024;
const RUBRIC_CHUNK_CHARS = 300000; // base64 characters per item, well under DynamoDB's 400 KB

function cleanScores(scores, rubric) {
  if (!rubric || !rubric.rows) return [];
  return rubric.rows.map((_, i) => {
    const v = Math.floor(Number(Array.isArray(scores) ? scores[i] : -1));
    return v >= 0 && v < rubric.levels.length ? v : -1;
  });
}

function viewedMs(paper) { return (paper.view && paper.view.ms) || 0; }
// A handed-back paper as its student sees it: the grade only once they've
// spent GRADE_AFTER_MS with the comments.
// A student may reflect on a session that asks for it once their paper is
// handed in and kept: their latest paper's submission entry, else null.
function reflectable(room, sub) {
  if (!room || room.deletedAt || !room.reflect) return null;
  const s = room.students && room.students[sub];
  if (!s || s.status === 'removed' || !s.handedIn) return null;
  return (room.submissions || []).find((x) => x.sub === sub && x.stored) || null;
}
function reflectView(room, sub, paper) {
  const s = room.students[sub] || {}, rf = s.reflect || {}, show = !!room.reflect.showGrading;
  return {
    room: { code: room.code, title: titleOf(room), teacherName: room.teacher.name || room.teacher.email, prompt: room.reflect.prompt || '', showGrading: show },
    paper: { id: paper.id, at: paper.at, words: paper.words, text: paper.text,
      ...(show ? { marks: paper.marks || [], endComment: paper.endComment || '', grade: paper.grade || '', rubric: paper.rubric || null, rubricScores: paper.rubricScores || [] } : { marks: [] }) },
    reflection: { text: (paper.reflection && paper.reflection.text) || '', handedInAt: (paper.reflection && paper.reflection.handedInAt) || 0 },
    status: rf.status || 'new', lockedOut: !!rf.lockedOut, askedAt: rf.askedAt || 0, leaves: rf.leaves || 0
  };
}

// A shared paper as its student reads it: a paper ('luddite:sub:<id>'), or
// their writing so far ('early:<code>:<sub>', which reads as the paper once
// they've handed in), with the teacher's marks moved onto their writing now.
async function myShared(id, me) {
  const ep = /^early:([^:]+):(.+)$/.exec(id);
  if (ep) {
    const code = cleanCode(ep[1]), sub = ep[2];
    if (sub !== me.sub) return null;
    const { state: e } = await readItem('luddite:early:' + code + ':' + sub);
    if (!e) return null;
    if (e.usedAt) return e.paperId ? myShared(e.paperId, me) : null;
    const [{ state: d }, { state: room }] = await Promise.all([readItem('luddite:draft:' + code + ':' + sub), readItem('luddite:room:' + code)]);
    const text = d ? String(d.text || '') : e.base;
    return { id, early: true, code, sub, email: me.email, name: me.name, roomTitle: room ? titleOf(room) : '', at: d ? d.at : e.at,
      words: (text.trim().match(/\S+/g) || []).length, text, marks: reanchorMarks(e.marks || [], e.base, text),
      endComment: e.endComment || '', grade: e.grade || '', rubric: e.rubric || null, rubricScores: e.rubricScores || [], returnedAt: e.returnedAt, view: e.view };
  }
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return null;
  return (await readItem('luddite:sub:' + id)).state;
}

function studentPaper(x) {
  const seen = viewedMs(x), ready = seen >= GRADE_AFTER_MS;
  return {
    id: x.id, roomTitle: x.roomTitle, name: x.name, email: x.email, at: x.at, words: x.words, text: x.text,
    marks: x.marks || [], endComment: x.endComment || '', returnedAt: x.returnedAt,
    // The rubric counts as part of the grade, so it shows with it.
    rubric: ready ? x.rubric || null : null, rubricScores: ready ? x.rubricScores || [] : [],
    viewedMs: seen, gradeAfterMs: GRADE_AFTER_MS, gradeReady: ready, grade: ready ? x.grade || '' : ''
  };
}

// The latest backup of a student's writing in one session. If the writing
// suddenly shrinks by more than half (a glitch, or a wiped page), the copy
// before it is kept too, as `prev`.
async function saveDraft(code, sub, raw, prevSeen) {
  const text = String(raw).slice(0, MAX_STORED_CHARS);
  let before = null, glitch = '';
  await mutate('luddite:draft:' + code + ':' + sub, (d) => {
    before = d ? String(d.text || '') : '';
    glitch = d && d.prev ? String(d.prev.text || '') : '';
    if (d && d.text === text) { before = null; return undefined; }
    const at = Date.now();
    const shrank = d && d.text && text.length < d.text.length / 2;
    const prev = shrank ? { text: d.text, at: d.at } : d && d.prev;
    const keepPrev = prev && prev.text.length + text.length < 350000;
    return { code, sub, text, at, ...(keepPrev ? { prev } : {}) };
  });
  if (before !== null) await logWriting(code, sub, before, text, prevSeen, glitch).catch((e) => console.warn('writing log failed', e.message));
}

// ---- The writing log (GET /luddite/wlog) ----
// Each backup of a student's writing (every few seconds while it changes) is
// compared word by word with the one before, and the change is added to
// luddite:wlog:<code>:<sub> { mins: [{ t, add, del, mid, words, big }],
// bursts: [{ at, words, wpm, quote }], recent: [deleted runs], first }:
// per minute, the words added, the words deleted, the words changed earlier
// in the text (revision, not just writing on at the end), the total, and the
// biggest single run added. A burst is 25 or more words arriving at once
// faster than anyone types (150+ words a minute), that weren't the student's
// own words moved, copied or put back. The room's student entry counts them
// (`bursts`, `burstAt`) for the session page.
const WLOG_MAX_MINS = 3000;
const BURST_WORDS = 25;
const BURST_WPM = 150;
const tokensOf = (t) => String(t || '').match(/\s+|[^\s]+/g) || [];
const isWord = (t) => !/^\s/.test(t);
// The insert and delete runs turning token list a into b (Myers' diff, after
// the common start and end; past maxD edits, the middle is one delete and one insert).
function tokenEdits(a, b, maxD = 400) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let sa = a.length, sb = b.length;
  while (sa > p && sb > p && a[sa - 1] === b[sb - 1]) { sa--; sb--; }
  const A = a.slice(p, sa), B = b.slice(p, sb), n = A.length, m = B.length;
  const whole = () => [...(n ? [{ type: 'del', at: p, toks: A }] : []), ...(m ? [{ type: 'ins', at: p, toks: B }] : [])];
  if (!n || !m) return whole();
  const max = Math.min(n + m, maxD), off = max + 1, v = new Int32Array(2 * max + 3), trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[k - 1 + off] < v[k + 1 + off])) ? v[k + 1 + off] : v[k - 1 + off] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[k + off] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return whole();
  const ops = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const vv = trace[d], k = x - y;
    const pk = (k === -d || (k !== d && vv[k - 1 + off] < vv[k + 1 + off])) ? k + 1 : k - 1;
    const px = vv[pk + off], py = px - pk;
    while (x > px && y > py) { x--; y--; }
    if (x === px) ops.push({ type: 'ins', ai: x, bi: py, tok: B[py] });
    else ops.push({ type: 'del', ai: px, bi: y, tok: A[px] });
    x = px; y = py;
  }
  ops.reverse();
  const runs = [];
  for (const o of ops) {
    const last = runs[runs.length - 1];
    const idx = o.type === 'ins' ? o.bi : o.ai;
    if (last && last.type === o.type && last.next === idx) { last.toks.push(o.tok); last.next++; }
    else runs.push({ type: o.type, at: p + idx, toks: [o.tok], next: idx + 1 });
  }
  return runs;
}
const squash = (t) => String(t || '').replace(/\s+/g, ' ').trim();
async function logWriting(code, sub, before, text, prevSeen, glitch) {
  const now = Date.now();
  const a = tokensOf(before), b = tokensOf(text);
  const runs = tokenEdits(a, b);
  // The end of the text: past the last word (trailing spaces don't count).
  let endAt = b.length;
  while (endAt > 0 && !isWord(b[endAt - 1])) endAt--;
  let add = 0, del = 0, mid = 0, big = 0, bigRun = null;
  for (const r of runs) {
    const w = r.toks.filter(isWord).length;
    if (r.type === 'del') { del += w; mid += w; continue; }
    add += w;
    if (r.at + r.toks.length < endAt) mid += w;
    if (w > big) { big = w; bigRun = r; }
  }
  if (!add && !del) return;
  const words = b.filter(isWord).length;
  // How long since the page last checked in: the time these words could have taken.
  const secs = prevSeen ? Math.max(10, (now - prevSeen) / 1000) : 0;
  const wpm = secs ? Math.round(big / (secs / 60)) : 0;
  const delRuns = runs.filter((r) => r.type === 'del' && r.toks.filter(isWord).length >= 5).map((r) => squash(r.toks.join('')).slice(0, 3000));
  let burst = null;
  await mutate('luddite:wlog:' + code + ':' + sub, (L) => {
    const log = L || { mins: [], bursts: [], recent: [], first: now };
    const mins = log.mins.slice(), t = Math.floor(now / 60000) * 60000;
    const last = mins[mins.length - 1];
    if (last && last.t === t) mins[mins.length - 1] = { ...last, add: last.add + add, del: last.del + del, mid: last.mid + mid, words, big: Math.max(last.big || 0, big) };
    else mins.push({ t, add, del, mid, words, big });
    let bursts = log.bursts || [];
    if (bigRun && big >= BURST_WORDS && wpm >= BURST_WPM) {
      const runText = squash(bigRun.toks.join(''));
      // Their own words: moved or copied within the paper, put back after a
      // delete (or an undo), or restored after a glitch.
      const own = squash(before).includes(runText) || (log.recent || []).concat(delRuns).some((x) => x.includes(runText) || runText.includes(x) && x.length > runText.length * 0.8) || (glitch && squash(glitch).includes(runText));
      if (!own) { burst = { at: now, words: big, wpm, quote: runText.slice(0, 160) }; bursts = [...bursts, burst].slice(-50); }
    }
    const recent = [...delRuns, ...(log.recent || [])].slice(0, 8);
    return { ...log, mins: mins.slice(-WLOG_MAX_MINS), bursts, recent };
  });
  if (burst) await mutate('luddite:room:' + code, (r) => (r && r.students[sub]
    ? { ...r, students: { ...r.students, [sub]: { ...r.students[sub], bursts: (r.students[sub].bursts || 0) + 1, burstAt: burst.at } } } : undefined)).catch(() => {});
}

async function rosterOf(room) {
  if (!room.classId && room.emails && room.emails.length) return { id: null, name: '', emails: room.emails };
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
