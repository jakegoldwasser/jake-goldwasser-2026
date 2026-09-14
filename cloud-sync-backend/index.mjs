import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';

// This is the AWS Lambda behind the "sign in with Google to save to the
// cloud" feature, shared by every book-building tool on the site
// (currently Chapbook Builder and Dummy Builder). It lives at a Function
// URL (see CLOUD_API_URL in each tool's own <script>) and is deployed by
// pasting this file into the Lambda console's Code editor and clicking
// Deploy -- there's no build step, just this one file.
//
// Storage is one DynamoDB item per Google user (keyed by their stable
// Google "sub" id), holding a single JSON blob. Because more than one
// tool now shares this same backend, that blob is namespaced per app:
//   { chapbookbuilder: { chapbooks, trash }, dummybuilder: { dummies } }
// Each tool only ever reads/writes its own top-level key, so one tool's
// save can never clobber another tool's data for the same signed-in user.
//
// Older records (saved before this namespacing existed) have the
// Chapbook Builder shape directly at the top level -- {chapbooks, trash}
// with no "chapbookbuilder" wrapper. migrateLegacyState() recognizes and
// nests those in place the first time they're read or written, so
// existing users don't lose anything.

const TABLE_NAME = process.env.TABLE_NAME || 'ChapbookBuilderUsers';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

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

function migrateLegacyState(state) {
  if (state && typeof state === 'object' && !state.chapbookbuilder && !state.dummybuilder &&
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

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || 'GET';

  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return respond(401, { error: 'Missing bearer token' });

  const info = await verifyGoogleToken(token);
  if (!info) return respond(401, { error: 'Invalid or expired token' });

  const userId = info.sub;

  if (method === 'GET') {
    const { state, updatedAt } = await getStoredState(userId);
    return respond(200, { state, updatedAt });
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
