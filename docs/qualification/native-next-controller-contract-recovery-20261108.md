# Retain actual hybrid controller contracts

Source-only child of5d600b11df2b12fb15028ba42bc5a137bb02bc29. Original hosted
42409241912 remains failed:913 of916 integrity cases passed, three failed,
zero skipped. Log retained privately at
/private/tmp/aihr-hybrid-ci-5d600-42409241912.log. Downstream transfer/plan chunks
did not execute. The separately running premigration behavior check is unaffected.

All three failures were outdated source/output assertions: the inert-import case
still required synchronous main() despite its preserved real inert-import positive;
the commissioning summary assertion omitted its new native-test dependency; and
the real matrix subprocess expected only the old single output. This repair updates
those exact contracts. It retains the actual inert subprocess and additionally
runs the real matrix command for ordinary-only, hybrid-only, mixed and complete
selections. Each must preserve original plan bytes, exact separated unit IDs,
booleans and separate incomplete commissioning selection records.

No application, controller behavior, workflow, resource limit, source approval or
release verifier changes. These are synthetic source/CLI controls and prove no
actual Next execution. Static syntax/diff checks only locally. Independent source
review precedes standard hosted recovery; complete source-plan reconstruction and
remaining original chunks must still execute. Production stays held.
