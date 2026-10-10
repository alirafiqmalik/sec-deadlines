# Venue submissions

The **Add Venue** button opens a form beside **Delete Expired Venues**.
The form creates a public pull request. A venue appears on the website only after the repository owner merges its PR.

The feature uses Cloudflare Workers, a SQLite Durable Object, Turnstile, and GitHub Actions.
These Cloudflare products support the Free plan. Usage remains subject to their account limits.
See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Request flow

1. The browser checks the form and completes Turnstile verification.
2. The Worker checks the data, Turnstile action, and exact production hostname.
3. One Durable Object reserves a slot for the repository and UTC date.
4. The Worker signs the submission and starts the trusted GitHub workflow.
5. The workflow checks the signature, expiry, schema, and existing venues.
6. The workflow reserves an immutable quota tag, appends one record, and opens a PR.
7. A signed callback gives the popup its PR link.

The daily limit is **five submissions across all visitors**, including failed or uncertain accepted requests.
Reservations prevent concurrent requests from exceeding the limit.
A failed dispatch retains its slot because GitHub can accept a request before the connection fails.
Invalid data and failed bot verification do not reserve a slot.
Do not delete daily quota tags to retry a failed request.

## Security and review

- The Worker accepts the configured website origin. Origin checking supplements bot verification and the daily quota.
- Turnstile verification requires `success: true`, action `add_venue`, and hostname `alihamzamalik.me`.
- Requests have size limits and a per-IP rate limit. The IP limit applies per Cloudflare location.
- Names, dates, tags, timezones, and URLs have strict checks in both JavaScript and Python.
- Both validators reject HTML, Liquid templates, control characters, credential URLs, IP URLs, and reserved local domains.
- The service never fetches URLs supplied by visitors.
- HMAC signatures protect workflow inputs and callbacks. Dispatch tokens alone cannot sign submissions.
- The GitHub dispatch token needs only **Actions: Read and write** on `alirafiqmalik/sec-deadlines`.
- The workflow uses its temporary `GITHUB_TOKEN` to create the branch and PR. The Worker cannot write repository contents.
- Automated PRs change only `_data/conferences.yml` and append exactly one venue.
- The **Venue data safety** check compares the record with its immutable quota proof.
- The `pull_request_target` check runs trusted base-branch code. It never checks out or executes submitted code.
- Commit statuses cover generated PRs immediately. Some generated PR workflows require GitHub approval before they can run.
- Application logs contain submission references and quota slots. They omit credentials, receipts, IPs, and venue details.
- Request invocation logs and traces are disabled to reduce unnecessary data collection.
- Receipts stay in session storage for status checks. The server stores their hashes and removes daily records after eight days.

Bot verification does not establish identity or prove that a conference is legitimate.
Before merging, inspect the official call for papers, deadline, timezone, and venue scope.
Review unusual URLs and any failed **Venue data safety** status.
Code-only PRs need a separate code review, even when the venue check passes.

## Activation

Production uses `https://sec-deadlines-submissions.alirafiqmalik.workers.dev`.
The public endpoint and widget key are in configuration. Secret values stay in Cloudflare and GitHub secret managers.
The steps below describe how to activate a fresh deployment or restore this setup.

1. Authenticate Cloudflare for the intended account.
2. Create a managed Turnstile widget for `alihamzamalik.me`, without pre-clearance.
3. Set `TURNSTILE_SITE_KEY` in `backend/wrangler.jsonc`. The site key is public.
4. Deploy `backend/` with Wrangler while `SUBMISSIONS_ENABLED` remains `false`.
5. Create a fine-grained GitHub token restricted to this repository and **Actions: Read and write**.
6. Give the token an expiry. Store it only as Worker secret `GITHUB_DISPATCH_TOKEN`.
7. Generate a random signing value with at least 32 bytes of entropy.
8. Store the same signing value as Worker secret and repository Actions secret `SUBMISSION_SIGNING_KEY`.
9. Store the Turnstile secret as Worker secret `TURNSTILE_SECRET`.
10. Set repository Actions variable `SUBMISSION_API_URL` to the Worker origin, without a trailing slash.
11. Set `venue_submission_api` in `_config.yml` to that same origin.
12. Set `SUBMISSIONS_ENABLED` to `true`, then deploy the Worker.
13. Test a real production Turnstile token, its replay rejection, and the PR callback before declaring activation complete.

The expected origin is `https://sec-deadlines-submissions.<account-subdomain>.workers.dev`.
Keep it consistent in both configurations.
GitHub repository settings must allow Actions to create pull requests.
Keep the default branch named `master`, or update both the workflow guard and processor before changing it.

Never place secret values in Git, browser code, issue bodies, or chat.
Use the authenticated secret manager or standard input for secret writes.
Ignored `.dev.vars` files are available for local development. Do not use them for production credentials.

## Deployment verification

The production endpoint is enabled as of 10 October 2026.
The [43 automated checks](https://github.com/alirafiqmalik/sec-deadlines/actions/runs/38024342943) and [website deployment](https://github.com/alirafiqmalik/sec-deadlines/actions/runs/38024342297) passed.

Live API checks rejected foreign origins, unsigned callbacks, unknown receipts, forged bot tokens, private-address URLs, and oversized requests.
The restricted GitHub token dispatched an intentionally invalid signed request.
That [security test](https://github.com/alirafiqmalik/sec-deadlines/actions/runs/38024824242) failed as expected with a signature mismatch, before any venue write.
It did not create a PR or consume a daily slot.

A complete production form submission and PR callback still require verification in a normal browser.
The automated browser could not complete the production Turnstile challenge.
Production bot checks remain enabled. No test venue has been submitted or merged.

## Tests

Run the Python checks from the repository root:

```sh
python3 -m pip install -r scripts/requirements-venue.txt
python3 -m unittest discover -s tests -v
```

Run the Worker checks from `backend/` with Node.js 24 or later:

```sh
npm ci
npm test
npm run check
```

Install Ruby and Jekyll 4.4.1 before running browser tests:

```sh
gem install jekyll -v 4.4.1 --no-document
npx --no-install playwright install chromium
npm run test:ui
```

Set `CHROMIUM_PATH` to use an existing Chromium executable.
Browser tests use explicit Turnstile and backend stubs. They do not prove that production credentials work.
Worker tests use the real Durable Object runtime, including concurrent reservations and storage persistence.
The **Venue submission tests** workflow runs these checks for relevant code changes.

## Maintenance

- Renew the GitHub dispatch token before its expiry. Replace only the Worker secret.
- To stop submissions, set `SUBMISSIONS_ENABLED` to `false` and deploy the Worker.
- If a visitor reports a submission reference, find it in **Create venue PR** workflow inputs or Worker logs.
- If GitHub accepted a dispatch, rerun that workflow within its 24-hour signature window.
- The same signed request reuses its quota proof and existing PR. It does not create another PR.
- If dispatch never reached GitHub, the reserved daily slot stays consumed. Do not clear the quota to recover it.
- Quota tags retain public submission evidence. They are not release tags.
