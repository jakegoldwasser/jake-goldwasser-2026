// Stands in for '@aws-sdk/client-dynamodb' (build.mjs points the import
// here). index.mjs only ever does three things with its table, so only
// those exist, in the same shapes it already sends:
//   GetItem  { Key: { pk: { S } } }
//   PutItem  { Item: { pk, state, ver, updatedAt }, ConditionExpression:
//              'attribute_not_exists(pk)' | 'ver = :ver' }
//   Scan     { FilterExpression: 'begins_with(pk, :p0) OR ...' }
// The host's store (__gas.getItem / putItem / scan, gas/host.js) keeps the
// rows in a Google Sheet in the account that deployed the script.
/* global __gas */

class Command { constructor(input) { this.input = input; } }
export class GetItemCommand extends Command {}
export class PutItemCommand extends Command {}
export class ScanCommand extends Command {}

function conditionFailed() {
  const e = new Error('The conditional request failed');
  e.name = 'ConditionalCheckFailedException';
  return e;
}

export class DynamoDBClient {
  send(cmd) {
    return new Promise((resolve) => {
      const input = cmd.input;
      if (cmd instanceof GetItemCommand) {
        const row = __gas.getItem(input.Key.pk.S);
        resolve(row ? { Item: { pk: { S: row.pk }, state: { S: row.state }, ver: { N: String(row.ver) } } } : {});
      } else if (cmd instanceof PutItemCommand) {
        const it = input.Item;
        // 0 = "must not exist yet"; otherwise the version it must still be at.
        const expect = input.ConditionExpression === 'ver = :ver' ? Number(input.ExpressionAttributeValues[':ver'].N) : 0;
        const ok = __gas.putItem(it.pk.S, it.state.S, Number(it.ver.N), Number(it.updatedAt.N), expect);
        if (!ok) throw conditionFailed();
        resolve({});
      } else if (cmd instanceof ScanCommand) {
        const prefixes = Object.values(input.ExpressionAttributeValues || {}).map((v) => v.S);
        const rows = __gas.scan(prefixes);
        resolve({ Items: rows.map((r) => ({ pk: { S: r.pk }, state: { S: r.state } })) });
      } else {
        throw new Error('unsupported command');
      }
    });
  }
}
