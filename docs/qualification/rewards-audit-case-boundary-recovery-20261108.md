# Rewards native CASE boundary recovery

Status: **NOT RUN**, uninstalled development prototype. Exact parent `00779cb4c28b20820a972441b5ddc43cc43c5c59` and its original evidence remain unchanged. No application query/command, financial rule, expected guard value, role/ACL, numbered migration or deployment changes.

All three planned parent chunks reached terminal before this repair. API-digest-verified evidence shows:

| Parent run | Actual result |
| --- | --- |
| 42415490999 native | Before-all installer negative control expected SQLSTATE `55000` but received `42601`; all **16 cases skipped**, zero native acceptance. |
| 42415491165 ownership | Three actual assertions passed, zero skipped/pending/todo. |
| 42415491484 legacy | All 31 files passed: 35 NODB and 288 DB assertions, zero skipped/pending/todo. |

Native PostgreSQL 16.15 log reports `syntax error at end of input at character 5017`, mapping to the inner `THEN` in line 40's unparenthesized `IS DISTINCT FROM CASE WHEN ... THEN ... END` operand. The PL/pgSQL IF-expression reader encounters that delimiter before the outer condition ends. The same condition also contains `p.prorows<>CASE WHEN ... THEN ... END`; both operands now have explicit parentheses. Every predicate and constant is unchanged. The actual installer guard must still refuse the hostile native predecessor with `55000`; the assertion is retained, rather than accepting syntax failure.

The failed parent's global teardown dropped three owned databases and its always-stop step completed. This does not prove native profile/race/receipt/money assertions or installation cleanup that the blocked suite never reached. The parent native database showed JIT on and zero OOM events. Raw artifact ZIP/API digest, PostgreSQL log, job log, assertion inventory and cleanup observations are retained in the local evidence inspection; no failed run is relabeled.

After root and independent review, rerun only `test/rewards-audited-read-prototype.test.ts` (16 actual native cases) through the standard hosted sole-file route. Keep all 30-second case / 20-second statement / 300 ms lock limits, native guards, IDs/money/history expectations, predecessor MD5s and original assertions. Retain the valid three ownership and 323 legacy assertions at exact parent/run identities; this repair changes neither of their executed owners. No local app/compiler/DB/build/tests ran. The paired request binds the exact reviewed source hashes; static hash inspection is not native qualification.

Complete native prototype: **unverified**. Page adoption, installed pool-family reservation, unarmed-policy compatibility and installed capability/processor qualification remain pending. Release authorized: **false**; production: **held**.
