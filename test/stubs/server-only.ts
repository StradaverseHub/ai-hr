/**
 * `server-only` is a Next.js build-time POISON PILL, not a runtime dependency: the real package ships an
 * empty server entry and a browser entry that throws, so a client bundle that pulls in a server module
 * fails the BUILD. It is not in node_modules — Next resolves it itself — so importing any module that
 * declares it (lib/statutory-readiness.ts, reached from the payroll run screen) breaks a vitest run with
 * "Cannot find package 'server-only'".
 *
 * Aliased to this empty module in vitest.config.ts. That is exactly the semantics of the real package on
 * the server, and it is inert for every existing test: nothing in the suite could resolve the specifier
 * before, so nothing was importing it successfully.
 */
export {};
