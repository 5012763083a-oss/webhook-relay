// Port of relay.py (Bot3's refactored version): pure logic, injectable clock + sender.
const enc = new TextEncoder();
async function hmacHex(secret, body) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, body))].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(body) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))].map(b => b.toString(16).padStart(2, "0")).join("");
}
function safeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
}

export class Relay {
  constructor({ secrets, targets, sender, rpm = 60, maxRetries = 5, baseDelay = 1, cbThreshold = 3,
                cbCooldown = 30, retention = 604800, clock = () => Date.now() / 1000, state }) {
    Object.assign(this, { secrets, targets, sender, rpm, maxRetries, baseDelay, cbThreshold, cbCooldown, retention, clock });
    const s = state || {};
    this.events = s.events || {}; this.idem = s.idem || {}; this.delivered = new Set(s.delivered || []);
    this.dead = s.dead || []; this.bucket = s.bucket || {}; this.cb = s.cb || {};
  }
  toJSON() { return { events: this.events, idem: this.idem, delivered: [...this.delivered], dead: this.dead, bucket: this.bucket, cb: this.cb }; }

  async ingest(src, body, signature, idemKey) {
    const secret = this.secrets[src];
    if (secret === undefined) return [404, { error: "unknown source" }];
    if (!safeEq(await hmacHex(secret, body), signature || "")) return [401, { error: "bad signature" }];
    return this.enqueue(src, body, idemKey);
  }
  async enqueue(src, body, idemKey) {
    const now = this.clock(), b = this.bucket[src] || (this.bucket[src] = { tokens: this.rpm, at: now });
    b.tokens = Math.min(this.rpm, b.tokens + (now - b.at) * this.rpm / 60); b.at = now;
    if (b.tokens < 1) return [429, { error: "rate limited" }];
    b.tokens -= 1;
    const key = idemKey || await sha256Hex(body), ik = `${src}|${key}`;
    if (this.idem[ik]) return [202, { event_id: this.idem[ik], duplicate: true }];
    const id = crypto.randomUUID().replace(/-/g, "");
    this.events[id] = { id, source: src, body: Buffer.from(body).toString("base64"), idem: key, status: "pending", attempts: 0, next_at: now, created: now };
    this.idem[ik] = id;
    return [202, { event_id: id }];
  }
  listEvents(src) {
    return [200, Object.values(this.events).filter(e => e.source === src).map(({ id, status, attempts }) => ({ id, status, attempts }))];
  }
  replay(id) {
    const e = this.events[id]; if (!e) return [404, { error: "not found" }];
    this.dead = this.dead.filter(x => x !== id);
    Object.assign(e, { status: "pending", attempts: 0, next_at: this.clock() });
    this.delivered.delete(`${e.source}|${e.idem}`);
    return [202, { event_id: id }];
  }
  breakerOpen(t) {
    const s = this.cb[t]; if (!s || s.opened == null) return false;
    if (this.clock() - s.opened >= this.cbCooldown) { this.cb[t] = { fails: this.cbThreshold - 1, opened: null }; return false; }
    return true;
  }
  async tick() {
    const now = this.clock();
    for (const e of Object.values(this.events)) {
      if (e.status !== "pending") {
        if (now - e.created >= this.retention) {
          delete this.events[e.id]; delete this.idem[`${e.source}|${e.idem}`];
          this.delivered.delete(`${e.source}|${e.idem}`); this.dead = this.dead.filter(x => x !== e.id);
        }
        continue;
      }
      if (e.next_at > now) continue;
      const dk = `${e.source}|${e.idem}`;
      if (this.delivered.has(dk)) { e.status = "delivered"; continue; }
      const t = this.targets[e.source];
      if (this.breakerOpen(t)) continue;
      let ok; try { ok = await this.sender(t, Buffer.from(e.body, "base64")); } catch { ok = false; }
      e.attempts++;
      if (ok) { e.status = "delivered"; this.delivered.add(dk); this.cb[t] = { fails: 0, opened: null }; continue; }
      const s = this.cb[t] || (this.cb[t] = { fails: 0, opened: null });
      if (++s.fails >= this.cbThreshold) s.opened = now;
      if (e.attempts >= this.maxRetries) { e.status = "dead"; this.dead.push(e.id); }
      else e.next_at = now + this.baseDelay * 2 ** (e.attempts - 1);
    }
  }
}
