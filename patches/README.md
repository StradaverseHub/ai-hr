# Fontkit import entry point

FACT: Next.js 16.3.8 external tracing selected `fontkit@1.9.0`'s ESM entry point and a privately
hoisted `@swc/helpers@0.5.23` in the main worktree, refusing its legacy named helper export. The same
locked packages built in a worktree with helpers 0.3.17 hoisted. Fontkit's own declared dependency
resolved to 0.3.17 in both installs; changing only the lockfile did not eliminate the tracing difference.

The patch changes only `exports.import` to the existing `dist/main.cjs`, already selected by
`exports.require`. It preserves fontkit 1.9.0, the lazy import, its font/subset algorithms and all
runtime dependencies. `serverExternalPackages: ['fontkit']` remains required. Frozen pnpm installs
apply the patch through `pnpm-workspace.yaml` and its locked hash.

Do not replace this with `@pdf-lib/fontkit` or fontkit 2.x without revalidating multilingual glyph
rendering; `lib/payslip-pdf-fonts.ts` records the verified subsetter compatibility constraint.
Before removing the patch, test a production build with helpers 0.5.x privately hoisted and inspect
rendered Chinese, Tamil, Thai and Vietnamese output.

# postgres.js connect-time type fetch

FACT: postgres.js 3.4.9 fetches array types as the first query of every new connection, from a promise
that nothing awaits (`fetchArrayTypes()` in `ReadyForQuery`). When that query failed, the rejection was
unhandled. Behind PgBouncer it fails whenever the pooler refuses a new connection's first query with
`query_wait_timeout`; a plain Node process then exits, and Next.js only logs it. Without a pooler the
same path is reached only when that first query fails.

The patch adds a rejection handler that closes the connection. `errored()` has already failed the waiting
query with the same error, which the application classifies as a capacity failure (`db/pooling.ts`), and
closing means no connection is used without its array parsers; the next connection fetches them again.
The successful path is unchanged. `test/pgbouncer-transaction-pool.test.ts` reproduces the failure
against a real PgBouncer and fails without the patch.

Remove it once an upstream release handles the rejection; rerun that test before removing it.
