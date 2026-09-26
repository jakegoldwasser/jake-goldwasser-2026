import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// This is the AWS Lambda behind Bookbug's "sign in with Google to save to
// the cloud" feature. It lives at a Function URL (see CLOUD_API_URL in
// bookbug/index.html) -- see README.md for deploying; there's no build
// step, just this one file.
//
// Storage is one DynamoDB item per Google user (keyed by their stable
// Google "sub" id), holding a single JSON blob namespaced per app:
//   { chapbookbuilder: { chapbooks, trash, lastOpened } }
// (Bookbug's key predates its rename.) A tool only ever reads/writes its
// own top-level key, so a future tool sharing this backend can't clobber
// Bookbug's data for the same signed-in user.
//
// Older records (saved before this namespacing existed) have the
// Chapbook Builder shape directly at the top level -- {chapbooks, trash}
// with no "chapbookbuilder" wrapper. migrateLegacyState() recognizes and
// nests those in place the first time they're read or written, so
// existing users don't lose anything.

const TABLE_NAME = process.env.TABLE_NAME || 'ChapbookBuilderUsers';
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

async function getStoredState(userId) {
  const result = await ddb.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { userId: { S: userId } }
  }));
  if (!result.Item) return { state: {}, updatedAt: 0 };
  return {
    state: migrateLegacyState(JSON.parse(result.Item.state.S)),
    updatedAt: Number(result.Item.updatedAt?.N || 0)
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

async function fetchPage(raw) {
  let url = await assertPublicUrl(raw);
  const exportUrl = googleDocExportUrl(url);
  if (exportUrl) url = new URL(exportUrl);
  for (let hop = 0; hop <= 4; hop++) {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Bookbug/1.0 (+https://jake-goldwasser.com/bookbug/)', Accept: 'text/html,text/markdown,text/plain;q=0.9' }
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), url);
      if (exportUrl && next.hostname === 'accounts.google.com') throw new Error('google_private');
      url = await assertPublicUrl(next.href);
      continue;
    }
    if (!res.ok) throw new Error('http_' + res.status);
    const type = res.headers.get('content-type') || '';
    if (!FETCH_TYPES.test(type)) throw new Error('unsupported_type');
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > FETCH_MAX_BYTES) { reader.cancel(); throw new Error('too_large'); }
      chunks.push(value);
    }
    const charset = (/charset=([\w-]+)/i.exec(type) || [])[1] || 'utf-8';
    let text;
    try { text = new TextDecoder(charset).decode(Buffer.concat(chunks)); } catch (e) { text = Buffer.concat(chunks).toString('utf8'); }
    return { url: url.href, contentType: type.split(';')[0].trim(), googleDoc: !!exportUrl, text };
  }
  throw new Error('too_many_redirects');
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || 'GET';

  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return respond(401, { error: 'Missing bearer token' });

  // Session tokens are checked locally; anything else is treated as a
  // Google ID token (sign-in, or a tool that hasn't adopted sessions yet).
  const info = token.startsWith('s1.') ? verifySession(token) : await verifyGoogleToken(token);
  if (!info) return respond(401, { error: 'Invalid or expired token' });

  const userId = info.sub;

  if (method === 'GET' && event.queryStringParameters?.fetch) {
    try {
      return respond(200, await fetchPage(event.queryStringParameters.fetch));
    } catch (e) {
      const code = String(e.message || '');
      const known = /^(bad_url|blocked_host|google_private|unsupported_type|too_large|too_many_redirects|http_\d+)$/.test(code);
      return respond(422, { error: known ? code : 'fetch_failed' });
    }
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

    const { state } = await getStoredState(userId);
    state[app] = payload.data;

    await ddb.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: { S: userId },
        state: { S: JSON.stringify(state) },
        updatedAt: { N: String(Date.now()) }
      }
    }));
    return respond(200, { ok: true });
  }

  return respond(405, { error: 'Method not allowed' });
};
