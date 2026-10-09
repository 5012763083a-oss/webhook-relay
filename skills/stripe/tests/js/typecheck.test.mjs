// `tsc --noEmit` on every Next.js template, with strict: false (what Next writes into a fresh tsconfig) and strict: true.
// Uses the pack's own typescript + @types/node; no Next.js install needed. A full `next build` on Next 15 and 16 is
// in scripts/next-build-check.mjs (npm run test:next).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ts = (await import("typescript")).default;
const files = ["stripe", "shopify", "github", "paddle", "lemonsqueezy"]
  .map((p) => join(ROOT, "templates/nextjs", p, "route.ts")).filter((f) => existsSync(f));

for (const strict of [false, true]) {
  test(`tsc --noEmit (strict: ${strict}) passes for ${files.length} Next.js template(s)`, () => {
    const program = ts.createProgram(files, {
      noEmit: true, strict, target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ["lib.dom.d.ts", "lib.dom.iterable.d.ts", "lib.esnext.d.ts"],
      esModuleInterop: true, isolatedModules: true, skipLibCheck: true, types: ["node"], typeRoots: [join(ROOT, "node_modules/@types")],
    });
    const diags = ts.getPreEmitDiagnostics(program).map((d) =>
      `${d.file ? d.file.fileName.replace(ROOT, "") : ""}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
    assert.deepEqual(diags, []);
  });
}
