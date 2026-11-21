# Preserve cleanup time for every independently owned native family

This source-only child starts at registered conformance candidate
`f37f9d629458b7d2bf4a34bdb3a0891e32af96e2`. Neither that candidate nor this
repair has a new native PASS claim. The earlier canonical-build/first-start
failure and browser cleanup failure keep their original identities. No local
test, compiler, process, application, systemd or database check was executed.

Independent full review found two concrete gaps before commissioning. The full
fixture's inherited `props()` allowed one metadata read to consume the entire
new 30-second cleanup window, preventing other independently owned services
from receiving any stop request. The small conformance fixture likewise used
three-second sequential calls inside seven seconds. Its final `rmtree(ROOT)`
also lacked a captured root inode, a host-mount refusal and per-member deadline.
Descriptor-safe symlink handling alone does not prove ownership of a pathname.

## Fixed phase frontiers

The full fixture keeps its 30-second aggregate and its existing total deadline.
It admits ownership metadata until T0+6 seconds, caps each read at 0.75s, and
reserves a fair remaining slot for each independent service/browser observation.
It queues every safely admitted stop before T0+8, with each queue call capped
at 0.5s. Native family observations share T0+15 with short fair calls; that
reserve covers the actual five-second worker/proxy and three-second browser
stop declarations. Exact launcher/empty-slice/mount proofs and guarded disposal
use the remaining aggregate time. The ordinary `props()` default stays 30s;
only this owned cleanup supplies the tighter cap.

The small fixture now explicitly sets its cleanup deadline to
`min(originalTotalDeadline, cleanupT0+7)`, rather than borrowing unused work.
Its ownership frontier is T0+0.75s, queue frontier T0+1.25s and settlement
frontier T0+4.5s. Metadata/queue calls are capped at 0.25s and family reads at
0.1s, with fair remaining slots. The final 2.5 seconds cover bounded manager
reload/absence and the small owned tree. This retains 20s work, 27s internal,
30s transport and 35s case limits. The two native services are stopped before
any filesystem disposal; the three-second resistant-family stop remains real.

A stalled or unprovable unit remains unowned and refused. Its failure cannot
consume all of the other units' observation/queue slots. Unknown invocations,
failed stops, pending families or deadline expiration retain paths and failure
evidence. No foreign service is stopped merely because its name matches.
The complete ownership and native process-family predicates remain required.

## Filesystem custody and failure preservation

The small fixture captures the actual ROOT device/inode immediately after
creation and before copying source. Cleanup first stops all independently
owned families, then validates that original root and bounded actual host
mountinfo before deleting **any** unit or root path. An unowned/replaced root
or host mount retains all paths. The check repeats immediately before tree
disposal. Directory traversal uses held descriptors, no-follow opens, native
inode comparisons, same-device checks, a 32-level/2,048-member ceiling and the
same seven-second deadline before each member removal. Symlinks are unlinked;
they are never followed as parents. A late replacement cannot authorize removal
of the new pathname's directory.

Construction itself is now inside the fixture's owned try/finally. A missing
construction witness refuses cleanup rather than adopting an uncertain root.
The extracted cleanup function is test-only and adds no production helper,
privilege, command API, migration or runtime profile. Publication failure joins
the original and cleanup errors; it cannot replace their compound outcome.
The existing privileged host/package/mount predicates are unchanged.

## Source and behavioral proof plan

All nine original host-view model assertions remain. Seven additional cases
cover full metadata stall, full queue stall, actual five-second settlement
budget modelling, both native metadata/queue stalls, replaced-root and synthetic
host-mount refusal before deletion, real temporary-file disposal deadline, and
the complete original source inverse. Models explicitly use fake time/native
facts where stated; they establish no native stop or mount receipt. All model
owners now compile their actual fixed source bytes instead of consulting an
ignored Python cache.

The data-only inverse binds both complete predecessor fixture files to their
actual f37/79 hashes. Its five scoped substitutions reconstruct each entire
predecessor, and the original complete 57d/e67 inverse/assertions still execute
after that reconstruction. This is mechanical source provenance, not behavior
qualification. The inverse is consumed only by source models; no native worker,
installed helper or production runtime loads it.

After root and independent review, run the same three source selectors:
profile16 + failure-diagnostic22 + host-view16 = **54 Python models** (previously
47). The registered one-case host conformance must then pass its actual systemd
observations, guarded source digests, resistant-family stop and complete cleanup.
Only afterward may root commission the separately source-bound canonical Next
build/two-worker component. Existing eleven sealed runtime helpers, profile,
actual Next/browser budgets, application permissions/logic, money, migrations
and production hold remain unchanged. No all-module, capacity or release claim
is established by this source checkpoint.
