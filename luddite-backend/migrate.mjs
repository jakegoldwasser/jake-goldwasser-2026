// One-time copy of Luddite's data out of Bookbug's table into Luddite's own.
// Run in AWS CloudShell (us-east-1) after `npm i @aws-sdk/client-dynamodb`:
//   node migrate.mjs
// Copies every item whose key starts with "luddite:" from ChapbookBuilderUsers
// (partition key userId) to LudditeData (partition key pk). Copy only: nothing
// is deleted or changed in the old table. Safe to run again; it overwrites the
// same keys with the same data.
import { DynamoDBClient, ScanCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';

const FROM = process.env.FROM_TABLE || 'ChapbookBuilderUsers';
const TO = process.env.TO_TABLE || 'LudditeData';
const ddb = new DynamoDBClient({ region: 'us-east-1' });

let start, copied = 0;
do {
  const page = await ddb.send(new ScanCommand({
    TableName: FROM,
    FilterExpression: 'begins_with(userId, :p)',
    ExpressionAttributeValues: { ':p': { S: 'luddite:' } },
    ExclusiveStartKey: start
  }));
  for (const item of page.Items || []) {
    const { userId, ...rest } = item;
    await ddb.send(new PutItemCommand({ TableName: TO, Item: { pk: userId, ...rest } }));
    copied++;
  }
  start = page.LastEvaluatedKey;
} while (start);
console.log('Copied ' + copied + ' items from ' + FROM + ' to ' + TO + '.');
