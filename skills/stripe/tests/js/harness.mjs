// Shared test harness: runs every fixture case against the Express and Next.js templates of one provider.
// Each case gets a fresh module instance (so in-memory dedupe state never leaks between cases).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "../../fixtures/generate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let bust = 0;

// --- Express: start the template's app on an ephemeral port ---
async function expressInstance(provider) {
  const mod = await import(pathToFileURL(join(ROOT, "templates/express", `${provider}.js`)).href + `?i=${++bust}`);
  const app = mod.createApp();
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/webhooks/${provider}`;
  return { send: (headers, body) => fetch(base, { method: "POST", headers, body }), close: () => new Promise((r) => server.close(r)) };
}

// --- Next.js App Router: transpile route.ts with the TypeScript compiler, call POST(Request) directly ---
const ts = (await import("typescript")).default;
const transpiled = new Map();
function nextModulePath(provider) {
  if (!transpiled.has(provider)) {
    const src = readFileSync(join(ROOT, "templates/nextjs", provider, "route.ts"), "utf8");
    const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
    if (out.diagnostics?.length) throw new Error("TypeScript syntax error in nextjs/" + provider);
    // Test-only: re-export the (deliberately unexported) verifier from the transpiled copy so tests can call it directly.
    // The shipped route.ts keeps only Next.js route exports, which `next build` requires.
    const verifier = src.match(/^function (verify\w+)\(/m)?.[1];
    if (!verifier) throw new Error("no verify function in nextjs/" + provider);
    const dir = mkdtempSync(join(tmpdir(), "skillpack-next-"));
    const file = join(dir, "route.mjs"); writeFileSync(file, out.outputText + `\nexport { ${verifier} as __testVerify };\n`); transpiled.set(provider, file);
  }
  return transpiled.get(provider);
}
async function nextInstance(provider) {
  const mod = await import(pathToFileURL(nextModulePath(provider)).href + `?i=${++bust}`);
  assert.equal(mod.runtime, "nodejs", "route must pin the Node.js runtime");
  return { send: (headers, body) => mod.POST(new Request(`https://example.test/api/webhooks/${provider}`, { method: "POST", headers, body })), close: async () => {} };
}

export const FRAMEWORKS = { express: expressInstance, nextjs: nextInstance };

// Test-only access to a Next.js template's module: { exports (names the shipped route.ts exports), verify }.
export async function nextRouteModule(provider) {
  const src = readFileSync(join(ROOT, "templates/nextjs", provider, "route.ts"), "utf8");
  const mod = await import(pathToFileURL(nextModulePath(provider)).href + `?i=${++bust}`);
  const exports = Object.keys(mod).filter((k) => k !== "__testVerify");
  return { src, exports, verify: mod.__testVerify };
}
export { withClock };

// Run fixture cases with Date.now() frozen at the fixture's generated_at (static fixtures stay valid forever).
async function withClock(seconds, fn) {
  const real = Date.now; Date.now = () => seconds * 1000;
  try { return await fn(); } finally { Date.now = real; }
}

export function providerSuite(provider) {
  const staticFx = JSON.parse(readFileSync(join(ROOT, "fixtures", `${provider}.json`), "utf8"));
  const fresh = build()[provider];

  for (const [fw, make] of Object.entries(FRAMEWORKS)) {
    for (const [label, fx, frozen] of [["static fixtures", staticFx, true], ["fresh fixtures", fresh, false]]) {
      test(`${provider}/${fw} (${label}): every case returns the expected status`, async () => {
        process.env[fx.env] = fx.secret;
        for (const c of fx.cases) {
          const inst = await make(provider);
          try {
            const run = () => inst.send(c.headers, c.body);
            const res = frozen ? await withClock(fx.generated_at, run) : await run();
            assert.equal(res.status, c.expect, `${provider}/${fw} case "${c.name}" -> ${res.status} ${await res.text()}`);
          } finally { await inst.close(); }
        }
      });
    }
    test(`${provider}/${fw}: duplicate delivery is acknowledged (2xx) but not processed twice`, async () => {
      process.env[fresh.env] = fresh.secret;
      const valid = fresh.cases.find((c) => c.name === "valid");
      const inst = await make(provider);
      try {
        const a = await inst.send(valid.headers, valid.body); assert.equal(a.status, 200);
        assert.equal((await a.json()).duplicate, undefined);
        const b = await inst.send(valid.headers, valid.body); assert.equal(b.status, 200);
        assert.equal((await b.json()).duplicate, true);
      } finally { await inst.close(); }
    });
    test(`${provider}/${fw}: missing secret env var fails closed (500, not 2xx)`, async () => {
      const valid = fresh.cases.find((c) => c.name === "valid");
      const saved = process.env[fresh.env]; delete process.env[fresh.env];
      const inst = await make(provider);
      try { assert.equal((await inst.send(valid.headers, valid.body)).status, 500); }
      finally { await inst.close(); process.env[fresh.env] = saved; }
    });
  }
  test(`${provider}: shipped fixture file matches the generator (regenerate with: npm run fixtures)`, () => {
    const regenerated = build(staticFx.generated_at)[provider];
    assert.deepEqual(regenerated, staticFx);
  });
}
export { ROOT, existsSync };
