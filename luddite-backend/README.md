# Luddite backend

The AWS Lambda behind Luddite (`/luddite/` on the site): writing sessions, classes,
waiting rooms, hand-ins, mark-up and Google Drive. It is Luddite's alone. It has its own
function, its own DynamoDB table and its own secrets, and shares nothing with
Bookbug (`cloud-sync-backend/`). Source: `index.mjs`, one file, no build step.

## Setting it up (once)

1. **Table.** DynamoDB -> Create table: name `LudditeData`, partition key `pk`
   (String), on-demand capacity, region us-east-1.
2. **Function.** Lambda -> Create function: name `luddite-api`, runtime Node.js
   22.x (or the newest offered), us-east-1. Paste `index.mjs` into the Code tab
   (replacing the sample) and **Deploy**.
3. **Permissions.** Configuration -> Permissions -> click the role name -> Add
   permissions -> Create inline policy -> JSON, allowing `dynamodb:GetItem` and
   `dynamodb:PutItem` on the `LudditeData` table's ARN. Name it
   `luddite-table-access`.
4. **Environment variables** (Configuration -> Environment variables):
   - `SESSION_SECRET` isn't needed: the function makes its own on first use and keeps
     it in the table. (Set it only to force a value; changing it signs everyone out.)
   - `LUDDITE_GOOGLE_CLIENT_SECRET`: the Luddite Google app's client secret
     (Google Cloud project "Luddite" -> Credentials). Without it, Drive can't be
     connected. It is the same value the Bookbug function holds today.
   - Optional: `TABLE_NAME` if the table isn't called `LudditeData`;
     `LUDDITE_GOOGLE_CLIENT_ID` (defaults to the one in the page).
5. **Timeout.** Configuration -> General -> Timeout: 30 seconds (Drive calls).
6. **Function URL.** Configuration -> Function URL -> Create: auth type `NONE`,
   and turn on CORS with allow origin `https://jake-goldwasser.com`, allow
   methods `GET` and `PUT`, allow headers `authorization` and `content-type`.
   (CORS must be set here and nowhere else; the code doesn't add its own headers.)
7. Give the Function URL to whoever updates `API` in `luddite/index.html`.

## Bringing over existing data (once, optional)

Luddite's rooms, papers and Drive connections currently sit in Bookbug's table
under keys starting `luddite:`. To copy them, open **AWS CloudShell** (icon at
the top of the console, us-east-1) and run:

    npm i @aws-sdk/client-dynamodb
    # upload migrate.mjs via Actions -> Upload file, then:
    node migrate.mjs

It only copies (never deletes), and is safe to run twice. Sessions signed by the
old function won't be valid here, so everyone signs in once more.

## Deploying a change

This version renames the routes (`/luddite/assignment(s)`, `/luddite/class(es)`, `/luddite/mine`); the old `/room(s)` ones still work for pages loaded before the change. Deploy the Lambda first, then the page. No new table or permissions are needed.

Replace the function's `index.mjs` with this folder's and click **Deploy**.

## Data

One item per key in `LudditeData` (`pk`, `state` JSON, `ver`, `updatedAt`). Key
kinds are listed at the top of the Luddite section in `index.mjs`.
