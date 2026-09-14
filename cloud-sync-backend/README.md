# Cloud sync backend

Source for the AWS Lambda function behind "sign in with Google to save to
the cloud" in Chapbook Builder and Dummy Builder. Its Function URL is the
`CLOUD_API_URL` constant in each tool's `index.html`.

## Deploying a change

1. Log in to the AWS console: https://console.aws.amazon.com/lambda
2. Find the function with a Function URL ending in
   `lambda-url.us-east-1.on.aws` matching the `CLOUD_API_URL` in either
   tool (region: us-east-1).
3. Open the **Code** tab, replace its contents with `index.mjs` from this
   folder, and click **Deploy**.

No build step — it's one file, using the AWS SDK that's already available
in the Lambda Node.js runtime.

## Storage

One DynamoDB table (`ChapbookBuilderUsers`, despite the name — it now
holds every tool's data), one item per signed-in Google user, keyed by
their Google account id. Each item stores a single JSON blob, namespaced
per app (`{ chapbookbuilder: {...}, dummybuilder: {...} }`) so multiple
tools can share one user identity without overwriting each other's data.
