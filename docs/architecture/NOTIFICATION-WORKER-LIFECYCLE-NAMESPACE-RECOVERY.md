# Exact hosted database binding for lifecycle qualification

Source recovery of6094fb821429c27e17430422ea1192a9c7ba1075 only. The first
sole-file native run42389556301 failed before cases: its actual owned database
was /ai_hr_test_w_aifocus1, rejected by the guessed numeric-first pathname regex.
The original failed run and frozen source remain unchanged. Its SQL fixture used
the same incorrect name order, so changing only the TypeScript assertion would
have failed at the next guard.

The native fixture now calls test/db-names.ts workerDb(poolId), the same owner used
by test/env.ts and global-setup.ts. It requires actual hosted Actions identity,
positive actual Vitest pool/worker ID, WORKER_DB enabled, both test URLs on literal
127.0.0.1 with the exact computed database and matching ports, and no URL query or
fragment overrides. Before creating its owned role, a real owner query verifies
current_database and inet_server_addr, rather than trusting URL parsing alone.
The existing public relation-owner and clean-schema checks remain unchanged.

Inside the same owner installation transaction, the fixture supplies captured
namespace, pool ID and exact expected database as transaction-local test markers.
An independent SQL guard validates the canonical raw namespace grammar/length,
normalizes its optional leading underscore and derives ai_hr_test_w + normalized
namespace + pool ID. Both current_database and the exact captured expected value
must match that derived canonical name. The namespace precedes the pool ID.
Missing/invalid markers refuse. No permissive production/staging-name pattern,
role-name inference or broad grant is introduced. These markers authorize no
worker API: native real-login/backend/run/transaction admission is unchanged.

Two authored native cases validate both test URL targets and the exact executed
SQL guard independently of already-created schemas. The SQL case extracts the
actual guard prefix from the fixture bytes, executes a positive bound case and
rejects altered database/namespace/pool ID, empty markers and malformed namespace.
It does not mistake a pre-existing-schema refusal for proof of namespace safety.
The other eight original lifecycle cases and finite SQL/time budgets remain.

No local app/DB/runtime/compiler/build checks, numbered migration, source upload,
installation, SMTP/provider, staging or production action occurred. Root owns fresh
sole-file standard hosted qualification and the complete compiler after the shared
compiler repair. This source is not a PASS or permission to commission a worker.
The separate incomplete projection checkpoint is not included in this recovery.
