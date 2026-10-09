# Deploy guide (about 10 minutes)

You need a free Cloudflare account and Node.js 18 or newer.

1. Unzip the kit, open a terminal in the folder, and run `npm install`.
2. Run `npm test`. Every test should pass.
3. Run `npx wrangler login` and approve the browser prompt.
4. Pick a name for your first source, for example `shop`. Then set its secrets:
   - `npx wrangler secret put ADMIN_TOKEN`: any long random string. You'll use it to view and replay events.
   - `npx wrangler secret put SECRET_SHOP`: the signing secret your webhook sender uses.
   - `npx wrangler secret put TARGET_SHOP`: the https URL of your own server that should receive the events.
5. Run `npx wrangler deploy`. Wrangler prints your Worker URL, such as `https://webhook-relay.<you>.workers.dev`.
6. Point your webhook sender at `https://<your-worker>/in/shop`. It must send the header `x-signature` with the hex HMAC-SHA256 of the raw body.

## Stripe

Set `npx wrangler secret put STRIPE_WEBHOOK_SECRET` to your `whsec_...` value. Then add `https://<your-worker>/in/stripe` as an endpoint in the Stripe dashboard. If you want alerts, also set `DISCORD_WEBHOOK_URL` and/or `SHEETS_WEBAPP_URL`.

## Check that it works

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<your-worker>/events/shop
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<your-worker>/replay/<event_id>
```

Without the token, both commands return 401. That's expected.

## Tuning

Edit `[vars]` in `wrangler.toml`. `RATE_RPM` is the request limit per minute, `MAX_RETRIES` is how many times delivery is retried, `CB_THRESHOLD` and `CB_COOLDOWN_S` control the circuit breaker, and `RETENTION_S` is how long events are kept. Redeploy after you change them.
