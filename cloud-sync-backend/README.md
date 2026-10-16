# Cloud sync backend

Source for the AWS Lambda function (`chapbook-builder-api`, us-east-1)
behind Bookbug's "sign in with Google to save to the cloud". Its Function
URL is the `CLOUD_API_URL` constant in `bookbug/index.html`.

## Deploying a change

1. Log in to the AWS console: https://console.aws.amazon.com/lambda
2. Find the function with a Function URL ending in
   `lambda-url.us-east-1.on.aws` matching the `CLOUD_API_URL` in either
   tool (region: us-east-1).
3. Open the **Code** tab, replace its contents with `index.mjs` from this
   folder, and click **Deploy**.

No build step — it's one file, using the AWS SDK that's already available
in the Lambda Node.js runtime.

## Environment variables

Set under **Configuration → Environment variables**:

- `GOOGLE_CLIENT_ID` — the OAuth client id from the tools' `index.html`.
  Rejects Google tokens minted for any other app.
- `SESSION_SECRET` — a long random string (e.g. the output of
  `openssl rand -base64 48`). Signs the 30-day session tokens that keep
  people signed in across visits. Without it, sessions are off and
  sign-ins last only as long as Google's ~1hr ID token. Changing it signs
  everyone out.

- `ANTHROPIC_API_KEY` (optional) — a Claude API key from
  https://console.anthropic.com (API use is billed there, separately from a
  Claude subscription; a guess costs a fraction of a cent). With it,
  `PUT ?orient` asks Claude which way up a photographed cartoon goes, and
  Bookbug turns each imported photo upright. Without it the route answers
  501 and Bookbug skips the guess. `ORIENT_MODEL` picks the model
  (default `claude-haiku-5-5`).

## Storage

One DynamoDB table (`ChapbookBuilderUsers`, despite the name — it now
holds every tool's data), one item per signed-in Google user, keyed by
their Google account id. Each item stores a single JSON blob, namespaced
per app (`{ chapbookbuilder: {...} }` -- Bookbug's key predates its
rename) so another tool could share the same sign-in without overwriting
Bookbug's data.

## Picture-book images

Pictures in picture books don't go in the JSON blob (one item has a 400 KB
cap). Each is its own item in a second table, `BookbugImages` (partition
key `userId`, sort key `imageId`, on-demand billing), holding the image
bytes (binary, at most 390 KB; the page shrinks pictures to fit):

- `GET ?image=<id>` returns `{ type, data }` (base64).
- `PUT ?image=<id>` with `{ type, data }` stores one; `{ delete: true }` removes it.

The Lambda's role needs `dynamodb:GetItem`, `PutItem` and `DeleteItem` on
that table (the `bookbug-images-access` inline policy). Set
`IMAGE_TABLE_NAME` to use a different table.

## Import from a link

`GET ?fetch=<url>` (signed-in users only) returns `{ url, contentType, googleDoc, text }`
for a public web page, a text/markdown file, or a Google Doc shared as "anyone with the
link" (fetched through its markdown export). Bookbug turns that into entries in the
browser. Guarded against reaching private networks: http(s) on standard ports only,
every redirect hop's host must resolve to public addresses, at most 4 redirects, text
types only, 3 MB, 8 seconds. It uses GET so the Function URL's CORS (GET, PUT) needs no change.

Also through `?fetch=`: a public PDF link comes back as `{ contentType: 'application/pdf', name, data }`
(base64, at most 4 MB), and a Google Drive folder shared as "anyone with the link" comes back as
`{ folder: true, name, files: [{ id, name, kind }] }` (listed via Drive's embeddable folder view;
`kind` is pdf, doc, text, folder or other). `GET ?drivefile=<id>` then fetches one of those files
through Drive's public download link (following Google's "can't scan for viruses" page for large
files). Anything that lands on Google's sign-in page answers `google_private`. The function's
timeout is 30 s, since Drive's download host can take several seconds to answer.

## Read-only share links

`PUT ?share` (signed in) with `{ bookId }` makes a link to one of the
writer's own text books and returns `{ token }`; `{ token, revoke: true }`
ends one of theirs. `GET ?share=<token>` needs no sign-in and returns
`{ title, book }` -- that book's latest saved version, without its
comments, submissions, contact details or archive. Each link is an item
in the main table keyed `share#<token>` (`{ owner, bookId, createdAt }`,
plus `revoked` once ended), so no new table or permissions are needed.
The page opens a link at `bookbug/?read=<token>`.

## Snapshots

An entry's saved drafts sync with the account but stay out of the main
item (which has a 400 KB cap): `GET ?snaps=<bookId>.<entryId>` returns
`{ snaps: [...] }` and `PUT ?snaps=<bookId>.<entryId>` with `{ snaps }`
replaces the list (at most 380 KB; the page keeps lists under 360 KB by
dropping the oldest automatic snapshots). Each list is one item in the
images table, `imageId` = `snaps:<bookId>.<entryId>`, under the writer's
`userId` -- the role's existing GetItem/PutItem on that table covers it.

## Usage stats

`GET ?stats` (signed in) returns counts for `bookbug/stats.html` and the
weekly roundup email: accounts (total, new and saved in the last 1/7/30
days), books by type (total, new this week, worked on this week), share
links, new accounts and books per week for 12 weeks, and a daily history.
Counts only, never titles, text, names or emails, and the asker's own
account is left out.

- Only accounts whose email is in `STATS_EMAILS` (an environment variable,
  comma-separated) may ask; everyone else gets 403.
- It scans the main table, so the Lambda's role needs `dynamodb:Scan` on
  `ChapbookBuilderUsers`.
- Each account gets a `createdAt` on its first save from now on; older
  accounts are dated by their oldest book (a book's id holds the time it
  was made).
- The first stats call each day appends a snapshot to the item
  `stats#history` (how many accounts had saved in the past 7 days, etc.),
  since that can't be worked out afterwards.

## Bookbug HM

Bookbug HM (Horace Mann's copy, https://jakegoldwasser-hm.github.io/bookbug-hm/,
repository `jakegoldwasser-hm/bookbug-hm`) uses this same function. A request
whose `Origin` is `https://jakegoldwasser-hm.github.io` is Bookbug HM's:

- Only @horacemann.org accounts may use it (`403 horacemann_only` otherwise; a
  fresh Google sign-in must also carry `hd: horacemann.org`).
- Its books are stored apart, under `hm#<google sub>` in both tables (plus the
  account's `email` and `name`, so administrators know whose books they are).
  Someone's Bookbug books and Bookbug HM books never mix, and usage stats leave
  Bookbug HM out.
- Horace Mann's administrators read every Bookbug HM book through
  `/hm-admin/*` (`routeHmAdmin`): `me`, `overview`, `book?sub=&id=`,
  `image?sub=&id=`, `log`, `admins` (PUT `{ add }` / `{ remove }`). Read-only,
  fenced to that Origin, to administrators, and to `hm#` items only. Every look
  is logged in `hm#adminlog`; the list of administrators is `hm#admins`.
  `HM_PRIMARY_ADMINS` can't be removed; `HM_ADMIN_MANAGERS` (Jake) can add and
  remove administrators but sees no books. Listing uses `dynamodb:Scan`, which the
  usage stats already need.

Setup it needs (once): the Function URL's CORS must allow the origin
`https://jakegoldwasser-hm.github.io`; the Google OAuth client must list it under
Authorized JavaScript origins; and the Picker API key's HTTP referrers must
include `https://jakegoldwasser-hm.github.io/*` for Import from Google Drive.
