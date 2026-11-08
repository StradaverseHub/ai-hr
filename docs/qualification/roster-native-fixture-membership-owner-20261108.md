# Roster fixture preserves the canonical shift-membership fact

Source-only child of frozen `4359cbb28ca411407a26974614c96aaa281181d6`.

The failed-file-only run `42480759048` finished every planned job before this correction. All three original cases reached the fixture's final raw `attendance_rule_shift` insert, which failed with native `23505` because the canonical shift writer had already created that exact primary key. The preceding canonical Schedule Group creation, six shift/employee sources, dated arrangements, 104 rotation versions and archived reference completed. This is retained failure evidence, not a passing rotation-scope result.

The actual `createShift` owner (`core/roster.ts`) inserts its configured rule membership immediately after the shift row. This child replaces only the redundant fixture insert with an exact native read/assertion of that existing `(ruleId, shiftId)` under the fixture's real administrator session. It does not add conflict swallowing or drop a constraint/guard. A missing or duplicate canonical fact still fails. All three original test bodies and assertions, 104-version corpus, 100 unrelated versions, expected four relevant versions, frozen usual-shift oracle and production implementations remain whole.

The original `42479348046` result retains its 45 unaffected passing cases, three earlier fixture failures and separate unresolved whole-compiler OOM under their exact source. The `42480759048` correction result is 0 passed / 3 failed / 0 pending; PostgreSQL used the configured 2,113,929,216-byte cap with 811,130,880-byte observed peak, JIT on, zero OOM kills and successful owned cleanup. No whole compiler was rerun. Neither source's failure is replaced or relabeled by this child.

After root and independent source review, only the failed native fixture file should run on standard GitHub-hosted Actions. No local repository behavior, imports, tests, generators, compiler, database or build is executed. Component, browser/load, zero-blocking, staging and production acceptance remain open.
