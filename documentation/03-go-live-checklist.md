# 03 — What Is Still Required to Make It Functional

**Bottom line:** the code and infrastructure are in place, but the system has **never sent a real message**. The local `.env` has empty Meta credentials, no Gmail provider has been connected, and the production work tables are empty. The steps below are ordered so each one unlocks the next. Steps marked 🧑 need you, either in a third-party console or because they involve secrets. Steps marked 💻 are code changes.

Since this hub serves **one project only**, skip anything your project doesn't use. Decide that first.

---

## Step 0 — Decide which channels your project actually needs 🧑

| If your project needs… | You must complete | You can skip |
|---|---|---|
| WhatsApp notifications only | Steps 1, 2, 4, 6, 7 | Gmail (3), campaign fixes |
| OTP login over WhatsApp | Steps 1, 2 (including the `auth_otp_code` template), 4, 6, 7 | Gmail (3) |
| Transactional email (receipts, alerts) | Steps 1, 3, 4, 5 (fixes 1–6, 11), 6, 7 | Meta (2) |
| Marketing campaigns | Everything, including all code fixes and DNS | — |

For a single project, transactional WhatsApp + OTP + transactional email is the realistic scope. The campaigns/automations/segments engine is large and has the most bugs. Leave it unused unless you need it.

---

## Step 1 — Fix production configuration in Vercel 🧑

Vercel → project `whatsapp-hub` → Settings → Environment Variables (Production). I couldn't list these remotely because the read was blocked, so check them by eye against [04-environment-variables.md](04-environment-variables.md). At minimum:

| Variable | Why |
|---|---|
| `DATABASE_URL`, `DIRECT_URL` | Supabase pooled (6543) and direct (5432) URLs |
| `APP_URL` = `https://promotions-lime.vercel.app` | OAuth redirect and links |
| *(no longer needed)* `NEXT_PUBLIC_APP_URL`, `NEXTAUTH_URL` | Fixed in code: links now use `APP_URL` (review #13) |
| `API_KEY_PEPPER`, `AUTH_SESSION_SECRET`, `WEBHOOK_SECRET_ENCRYPTION_KEY` | ≥ 32 random chars each. **The app refuses to start in production without them** |
| `INTERNAL_PROCESSOR_SECRET` | Must equal the Vault secret `internal_processor_secret` (it already works: cron gets 200) |
| `EMAIL_CREDENTIALS_ENCRYPTION_KEY` | ≥ 32 random chars. **Set it once and never change it**, or stored Gmail tokens become undecryptable |
| `EMAIL_TRACKING_SECRET` | ≥ 32 random chars |
| `WORKERLESS_MODE` | Optional: workerless is now the default (review #12). Never set it to `false` in Vercel |
| `REDIS_URL` | Optional. Without it, rate limiting uses PostgreSQL. If you do set it, that Redis must stay up: login/OTP fail closed when a configured Redis is down |
| `DEV_ALLOW_UNCONFIGURED_META` | Ignored in production (forced `false`), so no need to set it |

Generate secrets with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

Redeploy after changing variables.

---

## Step 2 — Connect WhatsApp (Meta Cloud API) 🧑

1. In [Meta for Developers](https://developers.facebook.com), create a **Business** app and add the **WhatsApp** product.
2. Add and verify a real phone number. The free test number can only message up to 5 pre-registered recipients.
3. In Business Settings → System Users, create a system user. Give it the app and WABA, then generate a **permanent token** with `whatsapp_business_messaging` and `whatsapp_business_management`.
4. Collect these values and set them in Vercel:
   - `META_ACCESS_TOKEN`: the permanent token
   - `META_PHONE_NUMBER_ID`: from API Setup
   - `META_WABA_ID`: WhatsApp Business Account ID
   - `META_APP_SECRET`: App Settings → Basic
   - `META_WEBHOOK_VERIFY_TOKEN`: any random string you choose
   - `META_GRAPH_API_VERSION`: `v22.0` (or current)
5. Under WhatsApp → Configuration → Webhook, set:
   - Callback URL: `https://promotions-lime.vercel.app/api/webhooks/whatsapp`
   - Verify token: the same `META_WEBHOOK_VERIFY_TOKEN`
   - Subscribe to the **messages** field.
6. **Templates:** create and get approval for the templates your project uses.
   - **OTP:** an `AUTHENTICATION` category template named `auth_otp_code` (or set `OTP_TEMPLATE_NAME`), language `en_US`. OTP sending fails without it.
   - **Notifications sent outside the 24-hour window:** need approved `UTILITY` templates. Free-form text only works within 24 h of the user messaging you.
7. Add a payment method in WhatsApp Manager. Business-initiated conversations are billed. Complete Business Verification if you need more than the starter messaging limit.
8. Check that `GET https://promotions-lime.vercel.app/api/health` reports Meta as configured.

---

## Step 3 — Connect email (Gmail / Google Workspace) 🧑

Gmail is the **only** working email provider in the code.

1. In Google Cloud Console, create a project and **enable the Gmail API**.
2. Set up the OAuth consent screen:
   - **Workspace account:** choose **Internal**. No verification needed, and refresh tokens don't expire.
   - **Personal @gmail.com:** choose **External**. ⚠️ While the app is in *Testing* status, **refresh tokens expire after 7 days** and email will stop. Either publish the app (the `gmail.send` scope is sensitive, so Google review may be required) or accept reconnecting weekly.
3. Create Credentials → OAuth client ID → **Web application**:
   - Authorized redirect URI: `https://promotions-lime.vercel.app/api/admin/email/providers/google/callback`
4. In Vercel, set `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`. Note the names: **not** `GOOGLE_*` as `.env.example` says. Redeploy.
5. In the dashboard, go to **Email → Providers → Connect Google** and complete consent with the sending account.
6. Under **Email → Sender identities**, add the sending address and mark it verified.
7. If you send from your own domain (Workspace), publish SPF, DKIM (Google Admin → Apps → Gmail → Authenticate email) and DMARC records, then run the domain check under **Email → Deliverability**.
8. Know the limits: about **500 recipients/day** for personal Gmail and about **2,000/day** for Workspace. That's fine for transactional email from one project, but not for bulk marketing. For bulk you'd need an SES/Resend provider, which doesn't exist yet.

---

## Step 4 — Create the accounts and keys your project will use 🧑

Run these locally with `DATABASE_URL` / `DIRECT_URL` pointing at the **production** Supabase. Do it in a terminal session you close afterwards, and never commit the values.

```bash
# 1. First admin user (the email defaults to cosora.demo@gmail.com if not set)
DEMO_ADMIN_EMAIL="you@example.com" DEMO_ADMIN_PASSWORD="<strong password>" npm run auth:seed-admin

# 2. One tenant + API key for your project (copy the printed whub_… key immediately)
npx tsx scripts/create-api-key.ts --client "MyProject" --key "Production"
```

Or log in at `/login` and create the key under **Dashboard → API Keys**.

Optional: under **Dashboard → Webhooks**, register your project's URL to receive delivery/inbound events. Save the signing secret in your project and verify the HMAC on receipt.

Store the `whub_…` key in your project's secrets as e.g. `WHATSAPP_HUB_API_KEY`.

---

## Step 5 — Fix the code defects that block reliable delivery 💻 ✅ Done (12 Oct 2026)

All 15 findings from [02-code-review-2026-10-12.md](02-code-review-2026-10-12.md) are fixed, plus the rate-limiter-without-Redis gap and the Prisma transient-error classification. Remaining to do: **commit and push to `main`**. Vercel auto-deploys, and no database migration is required.

### Code still open (found 12 Oct, after the review fixes)

| Item | Why it matters | Needed for |
|---|---|---|
| **Gmail OAuth state is stored in Redis** (`RedisOAuthTransactionStore` in `src/lib/email/providers/gmail/oauth.ts`) | With no Redis, "Connect Google" fails. The in-memory fallback can't work on Vercel because the start and callback requests hit different instances. Move the store to PostgreSQL (small new table + migration) | **Blocker for email** |
| **Legacy BullMQ worker code** (~3,900 lines in `src/lib/email/queue/` and `workers/`, plus `bullmq`/`ioredis` deps and the `worker:email` script) | No external worker is used. Remove it, rewrite queue health/metrics on PostgreSQL, and move `checkAndCompleteCampaign` out of `campaign-worker.ts`. 11 test suites (including the certification suite) exercise logic through these workers and must be ported to the executors | Cleanup, not a blocker |
| Gmail bounces/complaints are not detected | Gmail has no delivery webhooks. A Pub/Sub verifier exists, but nothing reads mailbox history for bounce messages, so automatic suppression never fires | Campaigns only |
| WhatsApp sends have no automatic retry | `/api/v1/messages` calls Meta synchronously. A transient failure is stored as `FAILED`, and resending with the same idempotency key returns that `FAILED` record | Optional |
| SMS / push adapters | Honest stubs that return `PROVIDER_UNAVAILABLE`; not wired to any API route | Not needed |

After deploy:
- Delivery rows can now end as `FAILED / SEND_OUTCOME_UNKNOWN` (worker died mid-send). Check them by hand; see the runbook query.
- The cron endpoint now returns HTTP 500 when a processing category fails, so `net._http_response` status codes become a real health signal.

---

## Step 6 — Prove it end-to-end 🧑💻

Use your own phone number and email address only.

```bash
HUB=https://promotions-lime.vercel.app
KEY=whub_...   # from step 4

# WhatsApp template (works anytime)
curl -X POST $HUB/api/v1/messages -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"to":"91XXXXXXXXXX","type":"template","templateName":"hello_world","templateLanguage":"en_US"}'

# OTP round-trip
curl -X POST $HUB/api/v1/otp/request -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"to":"91XXXXXXXXXX","purpose":"login"}'
curl -X POST $HUB/api/v1/otp/verify  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"to":"91XXXXXXXXXX","purpose":"login","code":"<code you received>"}'

# Transactional email (async: wait up to ~1 min for the cron tick)
curl -X POST $HUB/api/v1/email/send -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"type":"TRANSACTIONAL","to":"you@example.com","subject":"Hub test","html":"<p>It works</p>"}'
```

The email body fields (`to`, `type`, `subject`, `html`, optional `from` / `templateId`) come from `publicEmailSendSchema` in `src/lib/validation/email.ts`.

Then confirm in Supabase (queries in [05-operations-runbook.md](05-operations-runbook.md)):
- the `Message` row has status `SENT` → `DELIVERED` (needs the Meta webhook from step 2.5)
- the `EmailDelivery` row is `SENT` with a `providerMessageId`, and the `BackgroundJob` is `COMPLETED`
- the message actually arrived

---

## Step 7 — Keep it running 🧑

- Monitor the queries in [05-operations-runbook.md](05-operations-runbook.md): stuck jobs, failed jobs, processor errors.
- Rotate the Meta token if it is ever exposed. Reconnect Gmail if the refresh token is revoked.
- Supabase advisor: enable RLS on `public._prisma_migrations` (noted in `flags.md`).
- Repo hygiene: remove the unused `@netlify/*` dev dependencies, and the `ADMIN_USERNAME` / `ADMIN_PASSWORD` entries in local `.env` (no code reads them).

---

## Local development notes

The local `.env` is missing `AUTH_SESSION_SECRET`, `INTERNAL_PROCESSOR_SECRET`, `WEBHOOK_SECRET_ENCRYPTION_KEY`, `EMAIL_CREDENTIALS_ENCRYPTION_KEY`, `EMAIL_TRACKING_SECRET` and `GMAIL_*`. Development mode uses built-in defaults for some of these, so the dashboard runs, but email and the processor endpoint won't. With empty Meta values and `DEV_ALLOW_UNCONFIGURED_META=true`, WhatsApp sends are **simulated**, not sent. `npm run setup` generates a fuller `.env.local`.
