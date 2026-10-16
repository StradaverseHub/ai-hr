# Board integration browser lifecycle

Prepared source only. No fixture, migration, server or browser result is established here.

After the shared coordinator explicitly hands off resources, use the committed self-locking runner:

```sh
node --env-file=/absolute/owned/worktree/.env.local --import tsx /absolute/owned/worktree/scripts/dev-browser-board-integration.mjs
```

It holds both test slots and the dev DB lock, derives its own root, requires real dependencies and a
clean candidate, targets only `ai_hr_board15_browser` on localhost5433 with a separate `ai_hr_app`
connection, and binds127.0.0.1:3191. The old ignored scratchpad runner refuses execution.

Before migration/seed it rejects foreign tenants and a changed Demo identity. Existing fictional data
is preserved. The fixture runs twice and exits under watchdogs; declared facts must match apart from
its intentional first-run/reused marker. Both runs and the candidate are recorded in
`scratchpad/board15-integration/browser-manifest.json`. The fixture creates canonical fictional
Attendance/Allowance/Payroll inputs, but never transfers or processes payroll automatically.

Stop by creating `scratchpad/board15-integration/browser.stop`. The coordinator retains all locks
until its own child groups end, with TERM/KILL escalation for those groups only. No occupied-port
process is killed. Inspect `browser-stopped.json` and coordinator exit before a new resource window.

Use the fixture manifest's named company HR, manager, employees and separate group administrator
through actual app controls. Walk the approved Schedule, Allowance and Payroll journeys; verify
population, permissions, pending/error states, persistence, retries, exact financial results and
runtime logs. The runner establishes resource ownership and fixture readiness only; a response or
source guard supplies no rendered acceptance evidence. Other board features use their separate
committed scenario fixtures and namespaces. Parent owns final gate and release.
