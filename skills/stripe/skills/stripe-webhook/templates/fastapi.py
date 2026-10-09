"""Stripe webhook handler for FastAPI. Standard library only (plus fastapi).

Use:   from stripe_webhook import router as stripe_router; app.include_router(stripe_router)
Env:   STRIPE_WEBHOOK_SECRET (whsec_...)
Read the raw body with `await request.body()`; never declare a Pydantic body model for this route
(that parses and re-serialises the JSON, which breaks the signature).
SDK alternative: stripe.Webhook.construct_event(payload, sig_header, secret).
"""
import hashlib
import hmac
import json
import os
import time

from fastapi import APIRouter, BackgroundTasks, Request
from fastapi.responses import JSONResponse

TOLERANCE_SECONDS = 300  # Stripe SDK default

router = APIRouter()


def verify_stripe_signature(raw_body: bytes, header: str | None, secret: str, now: float | None = None) -> tuple[bool, str]:
    if not header:
        return False, "missing Stripe-Signature header"
    t, v1 = None, []
    for part in header.split(","):
        k, sep, v = part.partition("=")
        if not sep:
            continue
        k, v = k.strip(), v.strip()
        if k == "t":
            t = v
        elif k == "v1":
            v1.append(v)
    if not t or not t.isdigit() or not v1:
        return False, "malformed Stripe-Signature header"
    expected = hmac.new(secret.encode(), t.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    if not any(hmac.compare_digest(sig.encode(), expected.encode()) for sig in v1):
        return False, "no signature matches (wrong secret or modified body)"
    now = time.time() if now is None else now
    if abs(now - int(t)) > TOLERANCE_SECONDS:
        return False, "timestamp outside tolerance"
    return True, "ok"


# Idempotency: per-process only. In production use a UNIQUE event id column
# (INSERT ... ON CONFLICT DO NOTHING) or Redis SET NX with a TTL longer than Stripe's 3-day retry window.
# `_seen` records deliveries as RECEIVED. Mark an event PROCESSED (in your DB) only after the job succeeds, so a failed job can be retried.
_seen: set[str] = set()


def process_event(event: dict) -> None:
    kind = event.get("type")
    if kind == "checkout.session.completed":
        pass  # fulfil the order
    elif kind == "invoice.paid":
        pass


@router.post("/webhooks/stripe")
async def stripe_webhook(request: Request, background: BackgroundTasks):
    secret = os.environ.get("STRIPE_WEBHOOK_SECRET")
    if not secret:
        return JSONResponse({"error": "STRIPE_WEBHOOK_SECRET not set"}, status_code=500)
    raw = await request.body()
    ok, reason = verify_stripe_signature(raw, request.headers.get("stripe-signature"), secret)
    if not ok:
        return JSONResponse({"error": reason}, status_code=401)
    try:
        event = json.loads(raw)
    except ValueError:
        return JSONResponse({"error": "invalid JSON"}, status_code=400)
    event_id = event.get("id") if isinstance(event, dict) else None
    if not isinstance(event_id, str):
        return JSONResponse({"error": "missing event id"}, status_code=400)
    if event_id in _seen:
        return JSONResponse({"received": True, "duplicate": True}, status_code=200)
    _seen.add(event_id)
    # Runs after the response is sent. For work that must survive a crash, write to a durable queue here.
    background.add_task(process_event, event)
    return JSONResponse({"received": True}, status_code=200)
