# webhook-relay

A self-hosted webhook relay for Cloudflare Workers' free tier. It receives your webhooks, checks their signatures, stores them, and retries delivery to your server until it answers. Your data never passes through a third-party service.

- HMAC-SHA256 signature check per source, plus a native Stripe source (`POST /in/stripe`)
- Retries with exponential backoff, then a dead-letter list
- Per-target circuit breaker and per-source rate limit
- Duplicate protection with idempotency keys
- Admin-only event list and replay (`GET /events/:id`, `POST /replay/:id`)

## Deploy

```bash
npm install
npx wrangler login
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put SECRET_MYSOURCE      # signing secret for source "mysource"
npx wrangler secret put TARGET_MYSOURCE      # your endpoint URL
npx wrangler deploy
```

Send webhooks to `https://<your-worker>.workers.dev/in/mysource` with an `x-signature` header (hex HMAC-SHA256 of the body).

## Test

```bash
npm test
```

## Support

If this saves you a lost webhook, you can sponsor the project on GitHub.

MIT licensed.
