// One-time: copy just the approved-teachers list from Bookbug's old table into
// Luddite's own, merging with anyone already added there. Run in AWS CloudShell
// (us-east-1) after `npm i @aws-sdk/client-dynamodb`:   node restore-teachers.mjs
// Unlike migrate.mjs this touches one item only, so it can't overwrite the
// classes and sessions made since the move. Nothing is deleted anywhere.
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';

const FROM = process.env.FROM_TABLE || 'ChapbookBuilderUsers';
const TO = process.env.TO_TABLE || 'LudditeData';
const ddb = new DynamoDBClient({ region: 'us-east-1' });

const old = await ddb.send(new GetItemCommand({ TableName: FROM, Key: { userId: { S: 'luddite:teachers' } } }));
if (!old.Item) { console.log('No luddite:teachers item in ' + FROM + '. Nothing to copy.'); process.exit(0); }
const oldEmails = JSON.parse(old.Item.state.S).emails || {};

const cur = await ddb.send(new GetItemCommand({ TableName: TO, Key: { pk: { S: 'luddite:teachers' } } }));
const curEmails = cur.Item ? JSON.parse(cur.Item.state.S).emails || {} : {};
const emails = { ...oldEmails, ...curEmails };
const ver = Number(cur.Item?.ver?.N || 0);

await ddb.send(new PutItemCommand({
  TableName: TO,
  Item: { pk: { S: 'luddite:teachers' }, state: { S: JSON.stringify({ emails }) }, ver: { N: String(ver + 1) }, updatedAt: { N: String(Date.now()) } }
}));
console.log('Teachers now in ' + TO + ' (' + Object.keys(emails).length + '):');
Object.keys(emails).sort().forEach((e) => console.log('  ' + e));
