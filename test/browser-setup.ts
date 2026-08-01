/**
 * Setup for the `browser` project only (see vitest.browser.config.ts).
 *
 * Next's client modules read `process.env` at module scope — next/link → resolve-href → is-local-url →
 * has-base-path does it on import — and `process` does not exist in a browser. Anything importing
 * components/ui therefore fails to import at all, before a single assertion runs:
 *
 *     ReferenceError: process is not defined  (next/dist/client/has-base-path.js)
 *
 * A minimal shim is enough: these reads are for the router base path and NODE_ENV, both legitimately
 * empty here. Deliberately a setup file rather than a Vite `define` — `define` does a textual
 * substitution of `process.env` across every module, which silently rewrites application code, whereas
 * this only supplies the global that a browser is missing.
 */
// `as unknown as` on purpose: @types/node declares globalThis.process as the FULL Node Process, and a
// browser shim can never satisfy 60-odd stream and signal members it has no business providing. Widening
// through unknown says "this is a stand-in", rather than pretending the browser has a Node process.
const g = globalThis as unknown as { process?: { env: Record<string, string | undefined> } };
g.process ??= { env: { NODE_ENV: 'test' } };
