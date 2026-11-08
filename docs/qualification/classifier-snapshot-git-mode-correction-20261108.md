# Source snapshot: canonical Git owner-execute mode

Exactd9b5575c21e94018150babb9f971b8a677971c9a child. Root and Next FULL
source reviews found one P2: d9 used any executable bit0111 to compare native
filesystem mode to canonical Git100644/100755. Git normalizes these modes using
OWNER execute0100, as its [primary source](https://raw.githubusercontent.com/git/git/v2.43.0/object.h)
ce_permissions/create_ce_mode/canon_mode definitions show. No Git command or
repository behavior was run to infer this. Frozen d9 remains unrun/unpublished.

Change ONLY the canonical mode predicate from0111 to0100. Full native/named/FD
mode equality, byte/EOF/blob/identity/path/permission controls remain unchanged.
This repairs evidence fidelity; it grants no filesystem permission or admission.

Retain ALL17 original actual control bodies byte-exact. Add TWO genuine temporary
filesystem controls,19 declarations total: index100644 with native0654/0645 must
capture full bytes and metadata as100644; index100755 with0654 must refuse;
index100755 with owner-only executable0744 must capture as100755. The original
644-index/native755 refusal remains exact. The previous predicate would refuse
the valid nonowner-only cases and accept the incorrect755-index/0654 mismatch;
these are source-supported discriminating controls, not executed RED/GREEN claims.

Whole original d9 keeper/test bodies and current hashes form a NEW inverse;
all original d9 declarations/absence inverse remain immutable. The documentary
index updates exactly two runtime/control hashes, retains all other8976 parent
pins, adds the original index/review/inverse and preserves3642 complete roots.
Native UTF8, logical null/NUL/alias spelling, strict unreadable/unknown custody,
full first-observed C/B/A records, sealed copies, signal/close poison and all
8MiB/16MiB/35/30/128row/6s bounds remain unchanged. No graph correction is merged
or evidence relabelled. No app/core/DB/kernel/policy/shared admission source changes.

Root+independent FULL review precedes hosted19 controls. Only source/Git/hash and
external Babel SOURCE parsing ran locally. No repository imports/tests/models/
compiler Programs/native/DB/API/provider behavior, upload, dispatch or deployment.
Actual native owner, OS credential authority/IPC, authenticated transport, complete
semantic/CLI/normal NoDB union and release remain OPEN; staging/production held.
