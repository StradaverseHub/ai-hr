# Access native metadata OID assertion recovery

Unexecuted isolated successor of `054dce80906c08c137be730e908c8a0e3592e4d2`.
No application,3211SQL, journal, permissions, owner transfer, catalogue equality,
cleanup, resource or timeout change. Production remains held.

The sole authenticated native run42429017228 is terminal FAILURE:0 passed,
1 failed,0 pending,24504.307026ms. The exact failure is at original
`test/access-editor-native-owner-presentation.test.ts:69:177`: native
`to_jsonb(pg_proc).proowner` is the decimal JSON string `'73012'`; the fixture
compared it with numeric restricted-owner OID73012 using Object.is equality.
The predecessor body MD5 assertion on the same line ran first and succeeded.
This is a native metadata representation mismatch, not evidence of owner drift.

Artifact13596288609 ZIP SHA256
`8b29b1c02179dd5787e011c5502f3a60f3760d8798980dcd6a67ac00b2f71f0a`
was independently hashed against retained API metadata. The retained complete
catalogue diagnostic SHA256
`d5b558895cf668b99caaaa8b4d15b355f49e70b7c04e2718ef5f760fdaeb6947`
has differing={} across all18 sections after expected ownership transformation.
It records the actual rollback-only native owner control: relation101295,
rowtype101297,arraytype101296, database73014, postgres10 to restricted73012;
zero old owner edges became the one exact native table ownership edge, then
relation/types/local/shared dependencies were all absent after rollback. These
are retained observations, not constants embedded in the replacement oracle.
The complete RAW dependency comparison and independently derived expected owner
edges succeeded before the diagnostic was published. The fixture then returned,
real restricted-owner financial/Access commands ran, the native5000.00MYR
snapshot, old reader parity and retained three configuration changes passed.

The failure is BEFORE the seven migration-drift controls and before the actual
3211 invocation at original line89. Therefore this run does NOT prove3211
installation, native new projection, current grant revocation, held writers or
installed706/707 chain compatibility. It must not be relabeled as a native pass.
The actual job log records successful cleanup239.40469300000404ms, with database,
roles and owned backends absent. Original failure/cleanup evidence is retained.
PG160015 database peak1002590208bytes, OOM/OOM-kill counters0; no resource fault
is inferred.

The repair exposes the EXISTING strict typed OID decoder from the test-only
owner-dependency helper, and applies it only to the explicitly identified
predecessor proowner and added-function owner assertions. Accepted inputs are
positive safe uint32 numbers or their exact canonical decimal string forms.
Zero, signs, whitespace, leading zeros, decimal/exponent strings, fractions,
overflow, NaN/Infinity and nonnumeric objects refuse. The complete raw metadata
and exact later predecessor/after-body equality remain unmodified; no unknown
field is omitted or coerced. The subsequent added owner check now uses the same
strict codec instead of unrestricted Number().

Five original dependency models retain their assertions. One new sixth model
covers numeric/string boundaries, malformed values, mismatched owner and raw
metadata immutability. Native source/guard assertions, seven drift cases,
300s native case,20s SQL,300ms locks and bounded cleanup remain unchanged.
After root and independent review, run the affected pure decoder model (or all
six focused helper cases), source-closure controller controls as required, and
the sole affected native component. Existing valid five-model/controller
receipts remain tied to054. No repeated full gate or unaffected323 is required.
