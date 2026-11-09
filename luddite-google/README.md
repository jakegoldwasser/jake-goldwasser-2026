# Luddite on Google (test)

Luddite's backend running as a Google Apps Script web app instead of the AWS
Lambda, so everything Luddite stores sits in a Google Sheet ("Luddite data")
in the Google account that deploys the script, which can be one the school
owns. The page and everything students and teachers see stay the same.

It isn't a second copy of the backend. `build.mjs` bundles
`luddite-backend/index.mjs` as it is into `Code.js`, swapping only what it
runs on:

| index.mjs uses | here it's | file |
| --- | --- | --- |
| DynamoDB (get, conditional put, scan) | rows of a Google Sheet, under a script lock | `gas/host.js`, `shims/aws-dynamodb.mjs` |
| Node's crypto, Buffer, fetch | Apps Script's Utilities and UrlFetchApp | `shims/` |
| async/await | a Promise that settles at once, since Apps Script can't wait | `gas/sync-promise.js` |
| a Lambda Function URL | `doPost` (Apps Script can't read headers or set a status, so the page wraps each request in one POST) | `gas/host.js`, `send()` in `luddite/index.html` |

So a backend change reaches the Google copy by running `npm run build` and
pasting `Code.js` in again.

## On Luddite

The page offers it only on regular Luddite, jake-goldwasser.com/luddite/
(and on localhost), never on Luddite HM (Jake, 2026-11-09), and only once
`GOOGLE_API` in `luddite/index.html` has the script's address. Then:

- **Settings › Account › Saved in**: **Try Google (test)** / **Switch back
  to AWS**. Each keeps its own sessions, classes, papers, sign-in and saved
  writing on the computer; nothing moves between them.
- **Students** join through a session's **Copy link**, which on the test
  carries `&backend=google`. A link ending `?backend=google` switches any
  computer, and `?backend=aws` switches it back.
- A dark **Google test** pill sits bottom left on every page while it's on.

## Deploying it (once)

1. Go to [script.google.com](https://script.google.com) signed in as the
   account that should own the data, and click **New project**. Name it
   "Luddite".
2. **Project Settings** (the gear): tick **Show "appsscript.json" manifest
   file in editor**. Back in the editor, replace `appsscript.json` with this
   folder's `appsscript.json`, and replace everything in `Code.gs` with this
   folder's `Code.js`. Save.
3. Optional, for Google Drive copies of papers: **Project Settings › Script
   properties › Add**, `LUDDITE_GOOGLE_CLIENT_SECRET` = the Luddite Google
   app's client secret (the one the Lambda has). Without it, Drive says it's
   not set up and everything else works.
4. **Deploy › New deployment**, type **Web app**: Execute as **Me**, Who has
   access **Anyone**. Authorize it (Google warns that the app is unverified:
   Advanced › Go to Luddite). Copy the **Web app URL** (ends `/exec`).
   - "Anyone" is needed because the page calls it from github.io; it still
     checks every request's Google sign-in itself, as the Lambda does. If
     Horace Mann's Google admin doesn't allow "Anyone", IT has to.
5. Put that URL in `GOOGLE_API` in `luddite/index.html`, merge, and sync
   Luddite HM.

The first request makes the "Luddite data" spreadsheet in that account's
Drive (two tabs: `small` for sessions, classes and settings; `big` for
writing, its log and versions, papers and chat). Don't edit it by hand.

**Updating** after a backend change: `npm run build`, paste `Code.js` over
`Code.gs`, then **Deploy › Manage deployments › ✏️ › Version: New version ›
Deploy**. The URL stays the same.

## Before relying on it

- **Who can read it.** Whoever owns the deploying account can open the
  spreadsheet and read everything. It's deployed from Jake's school account, so
  Jake can read everything written on the test.
- **Speed.** Each request takes about half a second to two seconds, against
  a fraction of a second on AWS. A class writing makes about three requests a
  second (heartbeats every 10 seconds, the teacher's page every 3), and Apps
  Script runs at most about 30 at once per account, so try one class before
  several.
- **Sign-in** still uses Luddite's Google sign-in app. Moving fully, the
  school would make its own and put its client ID in the page and the
  script's `LUDDITE_GOOGLE_CLIENT_ID` property.
- **Not on the test:** Luddite HM's administrators' page and Bookbug HM's
  "From Luddite HM" still read the AWS copy. Nothing from AWS is copied over.

## On this computer

    npm install
    npm test        # builds Code.js and runs a whole session against it
    npm run dev     # the page at localhost:8000/luddite/?backend=google

`npm test` and `npm run dev` run the real `Code.js` against stand-ins for
Apps Script's services (`dev/fake-gas.mjs`; a Sheet in memory, saved to
`dev/data.json` by the dev server). Google sign-in may not work on
localhost; the dev server prints sign-in tokens for a test teacher and
student to paste into the page's localStorage as `luddite.g.auth.v1`.

## Deployed (2026-11-09)

Apps Script project **Luddite** in jake_goldwasser@horacemann.org's account
(the "Luddite data" Sheet is made there on first use), web app Version 1,
Execute as Me, Anyone. No `LUDDITE_GOOGLE_CLIENT_SECRET` yet, so Drive
copies don't work on the test. `GOOGLE_API` in `luddite/index.html` has its
`/exec` address, and it's offered on regular Luddite only.
