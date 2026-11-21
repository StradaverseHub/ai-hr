# Combined Attendance source-manifest admission recovery

Frozen source `260cc1bd8934ac4c919f34431d00dbbb4d1179ee` produced the complete
3584-suite / 103-unit controller plan in hosted run `42432898425`. Its subsequent
native commissioning run `42433227929` failed during planning, before database
execution: both generated AI source manifests were stale. This remains a failed
run; none of the combined-source 23 native cases executed there.

The unchanged generators perform static source hashing only. Regeneration used
the provider generator first and the module-agent generator last, without
application, compiler, database, provider or test execution. The resulting
provider closure contains 1484 files and digest
`05715d6d5e69ef68a89ac3cea1048db59251c09dac59787766ced50a2b7fa212`.
The module-agent closure contains 472 files and digest
`83603f7ead16571e6f530bf9aeae1c14719325bf7f958d82c344027fbef3d074`.
Only those two generated digest literals change.

The provider approval file remains byte-for-byte identical to the incoming
feature-history parent of `699fe717ee240165d33715b1c1d0b00daf734673`, SHA-256
`2ff41dba3f519e1c42ab305e281a27baef2b67a1734cdba511a6d8f3d80ae6ac`.
Its 28 historical approvals retain their original source digest, reviewer,
evidence and timestamps; both pending contracts remain pending. Generated source
identity is not a new approval or a claim that provider egress is admitted.
Final source-specific AI disclosure binding remains open.

After independent source review, rerun the affected complete controller plan and
sole native Attendance unit on standard hosted Actions. Retain the isolated
5771919 pure 13-case and native 23-case evidence at its original source; neither
is silently adopted as the combined-source result. No migration SQL, product
logic, ownership helper, case, resource bound or admission predicate changes.
Full chain, compiler, browser, worker and release qualification remain open;
staging remains gated and production held.
