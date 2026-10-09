// Cloudflare Worker entry. All relay state lives in one Durable Object so rate limits,
// breaker state and idempotency stay consistent. (KV binding is unused in this version.)
import { Relay } from "./relay-core.js";
import { Payments } from "./payments.js";
import { verifyStripe, fanOut } from "./stripe.js";
import { adminOk } from "./auth.js";
import LANDING from "../landing/index.html";
import STRIPE_TOOL from "../tools/stripe-signature.html";


const num = (v, d) => (v === undefined ? d : Number(v));
const json = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });

export class SourceState {
  constructor(state, env) { this.state = state; this.env = env; }
  async relay() {
    const env = this.env, secrets = {}, targets = {};
    for (const [k, v] of Object.entries(env)) {
      if (k.startsWith("SECRET_")) secrets[k.slice(7).toLowerCase()] = v;
      if (k.startsWith("TARGET_")) targets[k.slice(7).toLowerCase()] = v;
    }
    if (env.DISCORD_WEBHOOK_URL) targets["stripe:discord"] = env.DISCORD_WEBHOOK_URL;
    if (env.SHEETS_WEBAPP_URL) targets["stripe:sheets"] = env.SHEETS_WEBAPP_URL;
    return new Relay({ secrets, targets, state: await this.state.storage.get("relay"),
      rpm: num(env.RATE_RPM, 60), maxRetries: num(env.MAX_RETRIES, 5), cbThreshold: num(env.CB_THRESHOLD, 3),
      cbCooldown: num(env.CB_COOLDOWN_S, 30), retention: num(env.RETENTION_S, 604800),
      sender: async (url, body) => {
        const r = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10000) }); return r.ok;
      } });
  }
  async fetch(req) {
    this.r ||= await this.relay();   // kept in memory: no load/await/overwrite races
    const url = new URL(req.url), r = this.r, p = url.pathname.split("/").filter(Boolean);
    let out;
    if (req.method === "POST" && p[0] === "in" && p[1] === "stripe") {
      const raw = new Uint8Array(await req.arrayBuffer());
      if (!(await verifyStripe(raw, req.headers.get("stripe-signature"), this.env.STRIPE_WEBHOOK_SECRET))) return json(401, { error: "bad signature" });
      let ev; try { ev = JSON.parse(new TextDecoder().decode(raw)); } catch { return json(400, { error: "bad json" }); }
      const ids = []; for (const o of fanOut(ev, this.env)) ids.push((await r.enqueue(`stripe:${o.target}`, new TextEncoder().encode(o.body), o.idem))[1]);
      out = [202, { queued: ids }];
    }
    else if (req.method === "POST" && p[0] === "in" && p[1])
      out = await r.ingest(p[1], new Uint8Array(await req.arrayBuffer()), req.headers.get("x-signature"), req.headers.get("idempotency-key"));
    else if ((p[0] === "events" || p[0] === "replay") && !adminOk(req, this.env)) return json(401, { error: "unauthorized" });
    else if (req.method === "GET" && p[0] === "events" && p[1]) out = r.listEvents(p[1]);
    else if (req.method === "POST" && p[0] === "replay" && p[1]) out = r.replay(p[1]);
    else if (req.method === "POST" && p[0] === "pay" && (p[1] === "order" || p[1] === "verify")) {
      let body; try { body = await req.json(); } catch { return json(400, { error: "bad json" }); }
      const env = this.env;
      if (!env.PAY_RECEIVER_EVM || !env.BASE_USDC_CONTRACT || !env.BASE_RPC_URL) return json(503, { error: "payments not configured" });
      this.pay ||= new Payments({ store: (await this.state.storage.get("pay")) || { orders: {}, claims: {} },
        cfg: { rpcUrl: env.BASE_RPC_URL, token: env.BASE_USDC_CONTRACT, receiver: env.PAY_RECEIVER_EVM, minConfirmations: num(env.BASE_MIN_CONF, 10) } });
      out = p[1] === "order" ? await this.pay.createOrder(env.PRICE_UNITS || "5000000") : await this.pay.verify(body?.order_id, body?.tx_hash);
      await this.state.storage.put("pay", this.pay.store);
      return json(...out);
    } else if (req.method === "POST" && p[0] === "__tick") await r.tick(), out = [200, { ok: true }];
    else out = [404, { error: "not found" }];
    if (req.method !== "GET") await this.state.storage.put("relay", r.toJSON());
    return json(...out);
  }
}

const stub = env => env.SOURCE_STATE.get(env.SOURCE_STATE.idFromName("global"));
export default {
  fetch: (req, env) => (req.method === "GET" && ["/", "/tools/stripe-signature"].includes(new URL(req.url).pathname))
    ? new Response(new URL(req.url).pathname === "/" ? LANDING : STRIPE_TOOL, { headers: { "content-type": "text/html; charset=utf-8" } })
    : new URL(req.url).pathname.startsWith("/__") ? json(404, { error: "not found" }) : stub(env).fetch(req),
  scheduled: (_e, env) => stub(env).fetch(new Request("https://relay/__tick", { method: "POST" })),
};
