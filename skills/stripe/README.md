# Stripe Webhook Skill (free sample of the Webhook Skill Pack)

One agent skill plus three tested handler templates that make Claude Code, Codex or Cursor write Stripe webhook
endpoints the right way: raw body, `Stripe-Signature` HMAC check, constant-time compare, a 300 s replay window,
idempotency by `event.id`, and a fast 2xx with async processing.

```
skills/stripe-webhook/SKILL.md           the skill (templates bundled in skills/stripe-webhook/templates/)
templates/express/stripe.js              Express 4/5
templates/nextjs/stripe/route.ts         Next.js App Router -> app/api/webhooks/stripe/route.ts
templates/fastapi/stripe_webhook.py      FastAPI
fixtures/stripe.json, generate.mjs       signed test deliveries + generator
tests/                                   Node + pytest suites
```

## Install
- **Claude Code:** `mkdir -p .claude/skills && cp -r skills/stripe-webhook .claude/skills/` (or `~/.claude/skills/`)
- **Codex:** `mkdir -p .agents/skills && cp -r skills/stripe-webhook .agents/skills/` (or `~/.agents/skills/`)
- **Cursor:** paste `skills/stripe-webhook/SKILL.md` into a project rule, or copy the template you need.

Set `STRIPE_WEBHOOK_SECRET` (from the Dashboard endpoint or `stripe listen`) in your environment, never in code.

## Run the tests
Requires Node 18+ and Python 3.10+.
```bash
npm install && npm run test:js
npm run test:next     # optional: real `next build` of the route on Next.js 15 and 16 (temp app, downloads Next)
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.txt && python -m pytest -q tests/py
```

## Want the rest?
The full **Webhook Skill Pack** adds Shopify, GitHub, Paddle Billing and Lemon Squeezy skills and templates, a Cursor rule,
`AGENTS.md`, and Claude Code hooks that stop the agent from finishing while a webhook route is unverified and block
live secrets from being written to files:
https://6907000850732.gumroad.com/l/webhook-skill-pack

Free error-fix pages: https://webhook-relay.gmitchell-relay.workers.dev/errors/
