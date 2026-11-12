# Complete database hazard reachability

Successor of frozen test-only42aef592777b713a9d218f4ba94522e8249ccbb7.
Hosted run42460484371 completed32 assertions:30 passed, two failed, zero
pending. The original28 r417 rules passed. The two failing new cycle intentions
showed an actual order-dependent false NoDB result, confirming the source lead.
Authenticated artifact13608569514 SHA256:
364561d9fe7512c35814c392c8a7ac21dcb6fe307fd78616c443b846c9763601.
The original failure and all original tests remain unchanged.

One classification request now discovers the complete finite reachable test
helper graph before finalizing clean results. Ordered alternatives retain the
existing text/opaque precedence, driver and missing-module rules, resolver
stem/suffix order and test-only traversal boundary. Direct hazards seed reverse
reachability, closing cycles and diamonds. No in-progress edge becomes a clean
verdict. An iterative ordered DFS returns the first reachable source reason;
an internally inconsistent hazard without a reason throws instead of becoming
clean. Discovery, closure and reason traversal use explicit queues/stacks.

The optional single-file map parameter retains its type and receives that
file's fresh result. It is now explicitly a result sink: a value from a different
Reader/request cannot certify current source. All current production callers
use fresh single-file classification or the batch API; none supplies that third
argument. The batch API owns one complete graph and preserves requested output
order. No source state persists across requests. This repairs reachability; it
does not claim source mutation during one request is a supported input model.

Six additional intentions cover stale external results, self cycles, diamonds
and first reachable reasons, text/opaque precedence, resolver/product boundaries,
and a2500-node chain without recursion. The four original cycle intentions and
all28 original rules remain byte-identical. The parser regexes, CLI filesystem
reader, output loop and original15-second planner bound are unchanged. No IO or
lexical performance repair is claimed. The separate original full-suite timeout
still requires measurement and a causal fix.

After complete independent source review, run all38 intended-rule assertions on
standard hosted Actions. Before ordinary planning/adoption, compare the complete
actual test inventory against the original owner, inspect every partition/reason
delta and retain graph witnesses. Any DB-to-NoDB transition requires specific
review plus complete closed-port execution. Correcting an original false NoDB
may legitimately add DB work; the old partition is not a correctness oracle.
No selector omission, timeout increase, application change or deployment occurs.
This source is unrun at freeze; staging and production remain held.
