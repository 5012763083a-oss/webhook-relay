// Next.js App Router contract for the route.ts templates:
//  - a route file may only export route fields, or `next build` fails on Next 15
//    ('"verifyX" is not a valid Route export field'), so the verifier must NOT be exported;
//  - the verifier still works: the harness re-exports it from a test-only transpiled copy.
// The real `next build` on Next 15 and 16 is: npm run test:next  (scripts/next-build-check.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, nextRouteModule, withClock } from "./harness.mjs";

// Route segment config + HTTP handlers allowed in an App Router route.ts (Next 15/16 docs).
const ALLOWED = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE", "PATCH", "runtime", "dynamic", "dynamicParams",
  "revalidate", "fetchCache", "preferredRegion", "maxDuration", "generateStaticParams", "experimental_ppr"]);
const SIG_HEADER = { stripe: "stripe-signature", shopify: "x-shopify-hmac-sha256", github: "x-hub-signature-256",
  paddle: "paddle-signature", lemonsqueezy: "x-signature" };
const providers = Object.keys(SIG_HEADER).filter((p) => existsSync(join(ROOT, "templates/nextjs", p, "route.ts")));

for (const p of providers) {
  test(`nextjs/${p}/route.ts exports only Next.js route fields (no exported helpers)`, async () => {
    const { src, exports } = await nextRouteModule(p);
    assert.deepEqual(exports.filter((k) => !ALLOWED.has(k)), [], "non-route export breaks `next build`");
    assert.ok(exports.includes("POST") && exports.includes("runtime"));
    assert.doesNotMatch(src, /^export\s+(async\s+)?function\s+(?!(GET|HEAD|OPTIONS|POST|PUT|DELETE|PATCH)\b)/m);
  });
  test(`nextjs/${p}/route.ts narrows the verdict with \`ok === false\` (compiles with strict: false)`, () => {
    const src = readFileSync(join(ROOT, "templates/nextjs", p, "route.ts"), "utf8");
    assert.match(src, /if \(verdict\.ok === false\)/);
    assert.doesNotMatch(src, /!verdict\.ok/);
  });
  test(`nextjs/${p}: unexported verifier agrees with every fixture case`, async () => {
    const fx = JSON.parse(readFileSync(join(ROOT, "fixtures", `${p}.json`), "utf8"));
    const { verify } = await nextRouteModule(p);
    assert.equal(typeof verify, "function");
    await withClock(fx.generated_at, async () => {
      for (const c of fx.cases) {
        const v = verify(Buffer.from(c.body, "utf8"), c.headers[SIG_HEADER[p]] ?? null, fx.secret);
        assert.equal(v.ok, c.expect === 200, `${p} case ${c.name}`);
        if (!v.ok) assert.ok(typeof v.reason === "string" && v.reason.length > 0);
      }
    });
  });
}
