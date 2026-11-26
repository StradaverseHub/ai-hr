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

# postgres.js reserve() across a closing connection

FACT: On 24 Nov 2026 the import worker's payroll lane waited in `reserve()` for 1,822 s with nothing running in
PostgreSQL. Its one owner connection (`db/worker-connection.ts`, `max: 1`) had reached the driver's default
`max_lifetime` between two bulk-job ticks. postgres.js 3.4.9 then ended that connection, which waits for its socket to
close. A `reserve()` arriving in that window waits in the pool's `queries`. When the socket closed, `onclose` shifted
the request out of `queries` and reconnected with it. The connection answers a reserve request only through `onopen`
reading `queries` (it drops one it was started with), so the request was lost and `reserve()` never settled.

The patch, in `src`, `cjs/src` and `cf/src`:
- `onclose` reconnects for a waiting reserve request without removing it from `queries` (`Queue.peek`), as
  `reserve()` itself does when it starts a closed connection;
- a reserve request that fails (its connection attempt errored) leaves `queries`, so it is never answered after
  failing, which would strand the connection outside every pool queue;
- `release()` returns the connection only if that reservation still holds it. When the connection closed while
  reserved, `onclose` has already returned it to the pool; unpatched, `release()` put the closed connection, with no
  socket, in the open queue, and the next query threw an uncaught `TypeError` from a timer;
- a reservation whose connection closed (or that was released) refuses further statements with `CONNECTION_CLOSED`
  instead of writing to a connection it no longer holds.

`test/postgres-reserve-recovery.test.ts` reproduces each case against a fake server
(`test/helpers/fake-postgres-server.ts`) and fails without the patch. Remove these hunks once an upstream release
fixes `reserve()`; rerun that test, with the type-fetch test above, before removing them.
