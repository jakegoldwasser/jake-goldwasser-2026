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

## Storage

One DynamoDB table (`ChapbookBuilderUsers`, despite the name — it now
holds every tool's data), one item per signed-in Google user, keyed by
their Google account id. Each item stores a single JSON blob, namespaced
per app (`{ chapbookbuilder: {...} }` -- Bookbug's key predates its
rename) so another tool could share the same sign-in without overwriting
Bookbug's data.

## Import from a link

`GET ?fetch=<url>` (signed-in users only) returns `{ url, contentType, googleDoc, text }`
for a public web page, a text/markdown file, or a Google Doc shared as "anyone with the
link" (fetched through its markdown export). Bookbug turns that into entries in the
browser. Guarded against reaching private networks: http(s) on standard ports only,
every redirect hop's host must resolve to public addresses, at most 4 redirects, text
types only, 3 MB, 8 seconds. It uses GET so the Function URL's CORS (GET, PUT) needs no change.
