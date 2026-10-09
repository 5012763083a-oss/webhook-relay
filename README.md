# webhook-relay

**Self-hosted webhook relay for Cloudflare Workers.** It receives your webhooks, verifies their signatures, stores them, and retries delivery to your server until it answers, with a dead-letter list and replay when it doesn't. It runs on the Workers free tier, and your data never passes through a third-party service.

> Debugging a webhook signature error right now? See the free fix pages for Stripe, Shopify, GitHub, Paddle, Lemon Squeezy, Square, Twilio and more: **[webhook error fixes](https://webhook-relay.gmitchell-relay.workers.dev/errors/?ref=github)**, plus a **[Stripe signature checker](https://webhook-relay.gmitchell-relay.workers.dev/tools/stripe-signature?ref=github)** that runs in your browser. (Both are ours.)

## Features

- HMAC-SHA256 signature check per source, plus a native Stripe source (`POST /in/stripe`)
- Retries with exponential backoff, then a dead-letter list
- Per-target circuit breaker and per-source rate limit
- Duplicate protection with idempotency keys
- Admin-only event list and replay (`GET /events/:id`, `POST /replay/:id`)

## How it works

```
provider ──► /in/<source> ──► verify signature ──► store ──► deliver to TARGET_<SOURCE>
                                   │ fail                          │ non-2xx / timeout
                                   ▼                               ▼
                                 401                    retry with backoff ──► dead-letter list ──► replay
```

## Deploy

```bash
npm install
npx wrangler login
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put SECRET_MYSOURCE      # signing secret for source "mysource"
npx wrangler secret put TARGET_MYSOURCE      # your endpoint URL
npx wrangler deploy
```

Send webhooks to `https://<your-worker>.workers.dev/in/mysource` with an `x-signature` header (hex HMAC-SHA256 of the body). See [DEPLOY.md](DEPLOY.md) for details.

## Test

```bash
npm test
```

## Common signature errors

| Error | Fix page |
|---|---|
| Stripe: `No signatures found matching the expected signature for payload` | [no-signatures-found](https://webhook-relay.gmitchell-relay.workers.dev/errors/no-signatures-found?ref=github) |
| Stripe: `Unable to extract timestamp and signatures from header` | [unable-to-extract-timestamp](https://webhook-relay.gmitchell-relay.workers.dev/errors/stripe-unable-to-extract-timestamp-and-signatures?ref=github) |
| Stripe: `Timestamp outside the tolerance zone` | [timestamp-outside-tolerance](https://webhook-relay.gmitchell-relay.workers.dev/errors/timestamp-outside-tolerance?ref=github) |
| Shopify: `X-Shopify-Hmac-Sha256` mismatch | [shopify-hmac-verification-failed](https://webhook-relay.gmitchell-relay.workers.dev/errors/shopify-hmac-verification-failed?ref=github) |
| GitHub: `X-Hub-Signature-256` mismatch | [github-webhook-signature-mismatch](https://webhook-relay.gmitchell-relay.workers.dev/errors/github-webhook-signature-mismatch?ref=github) |
| Paddle: `Paddle-Signature` (ts/h1) | [paddle-webhook-signature](https://webhook-relay.gmitchell-relay.workers.dev/errors/paddle-webhook-signature?ref=github) |

All pages: [/errors/](https://webhook-relay.gmitchell-relay.workers.dev/errors/?ref=github)

## Support

If this saves you a lost webhook, you can sponsor the project on GitHub.

MIT licensed.
