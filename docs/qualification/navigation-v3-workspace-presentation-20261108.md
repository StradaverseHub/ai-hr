# Canonical workspace presentation Tx adapter — source candidate

This is approved canonical-adapter design stage 3, an isolated child of frozen
ESS leaf source e2dfc879d571f2fae7d38f20c9e244d0ec78383f. It implements one
explicit workspace presentation adapter. It is not live page/facts/workspace
composition, a connection lease, a full ESS purpose, speed qualification or a
release witness. No staging/production operation or local behavior was run.

## Authority and ownership

The only production owner changed is core/profile-edit.ts. The complete existing
workspace subject/master/register reads and projection are factored once into
private readOwnProfileWorkspaceRowsTx. The legacy public workspace retains its
exact supplied-policy selection, existingTx selection of the exclusive policy,
standalone shared native barrier and SET TRANSACTION READ ONLY carrier. Its
Boolean(existingTx) still selects physical row locking. Every other original
function, including proposal validation, submission, approval/application and
review readers, is unchanged. No policy/principal/native SQL owner is modified.

The new readOwnProfileWorkspacePresentationTx(tx,ctx,{employmentId?}) accepts no
policy JSON, verification flag, lock option, command receipt or arbitrary work.
It first executes freshProfilePresentationPolicyTx. Native2135 proves an actual
tenant-scoped Read Committed / Read Only carrier before reading policy values;
it joins shared Access then profile-policy barriers. Only then does the adapter
execute assertAiPrincipalTx(tx,policy.ctx), which checks actual current
login/tenant/person/roles/grants and uses shared Access because the carrier is
actually read only. Finally it chooses false explicitly for the private reads.
It returns only the original EssWorkspace DTO, not a permission capability.
Native2135 refuses a writable or RR carrier before principal admission could
choose a writable/exclusive Access course. Storage errors propagate; callers
must settle/rollback the real transaction rather than continue after failure.

There is no new transaction, pool, singleton reader, History join, composition
root, live caller adoption, or change to cancellation/admission budgets. A future
composed payroll caller must join the canonical shared History barrier BEFORE
invoking this adapter because it joins Access. This seam grants no History,
provider, command, approval or payroll-calculation authority. Barrier-free RR/RO
ESS remains separate correctness work; this source does not qualify that purpose.

## Preserved behavior

Whole source reconstruction proves every original function outside the one
workspace function is byte-exact. Source AST controls compare every statement of
the complete original workspace query/projection with its one private owner,
allowing only parameter substitution for employmentId and forUpdate. Legacy
admission, the standalone carrier and command Boolean(existingTx) remain exact.
The subject/master query, Family-before-statutory order, qualification/emergency
ordering, 501-row reads and refusal above 500 are unchanged. Registry metadata,
visibility, masks, raw-value-free xmin/target CAS metadata, address review,
editable/primary-only policy, child-relief/date/money formulas and complete DTO
projection remain owned by those same original statements.

Country behavior still goes through packFor and the unchanged optional
getEditSnapshot/get contract, now with forUpdate:false only for the explicit
presentation course. Missing packs/rows and missing snapshot support preserve
original null/unavailable/baseline semantics. No country implementation,
application model, migration, writer or lock contract changes.

## Prepared checks — no behavior result yet

The new navigation-v3-workspace-presentation.test.ts selector has 11 cases:
eight fixed cases and three register-bound variants. Real nonowner ai_hr_app
transactions check exact native RC/RO identity, backend/start/virtual-root
continuity, complete populated old/new DTO equality and independent known
register IDs/order/primary values. Canonical writers create fictional person,
country statutory, Family, qualification and emergency fixtures. Actual country
xmin CAS tokens are independently reconstructed; a controlled revision change
with unchanged updatedAt must change the token while preserving the mask.

Additional cases check fresh visibility/editability, foreign employment and
forged person/tenant refusal, real grant removal and login archival, native RW
and RR refusal, real forbidden write/row-lock errors with savepoint settlement,
500 accepted/501 refused independently for all three registers, and complete
private business-row/xmin/event/request before/after comparisons. Direct owner
fixture population is used only for the hard bound and controlled revision,
identity/revocation or independently held lock arrangements. It is not a new
production writer. No private row/value/revision/identifier is exported.

Independent open row writers hold employment, person, statutory and all three
register rows while both policy keys are held shared; the actual new reader must
succeed with existing diagnostic lock/statement timeouts. The actual supplied-
policy legacy command carrier must still fail its FOR UPDATE attempt. Separate
exclusive Access and profile-policy holders must still block the new course.
These are bounded component checks, not a no-lock/full-load/page speed claim.

Four new source cases reconstruct all four complete changed parent files,
compare the whole original projection/admission and every other function,
preserve country/bound/CAS owners and require exact native-policy → principal →
explicit nonlocking delegation. The inherited four ESS source-case bodies keep
their original intentions: their source reader first reconstructs this
successor's e2df generated files, then applies the immutable d45 inverse. The
entire original inherited source control is itself reconstructed by the new
whole-parent inverse. Old inverse/source records remain immutable.

The sidecar binds actual affected selectors. After root plus independent full
review, run the new 11 DB cases, four source cases, inherited four ESS source
cases and original actual manifest admission, then all affected legacy checks on
standard GitHub-hosted Actions. No local test, Program, module import, build or
native operation was run. Source AST syntax and static hashes/inverses establish
only source claims. Require terminal complete coverage; preserve original
failures and valid source-specific passes without transferring them to this SHA.

## Source identity

Independent static byte/import-graph replay preserves exact algorithms and scope:
provider 1487 sources at 3fe9f9389d116e04dafb22006d26de5ff9a3072a33d464b622a809a224c2edd8,
agent 472 at d8f05ee673bfe860d69c1903ff4bc9ca5836984f920d1d326f60d15bbc4e2dd1.
Neither membership nor counts change from e2df; only both generated digest
literals change. Actual original --check scripts remain required after freezing.
The inherited manifest case retains its 1487/472 count binding, clean frozen
source/Git/controller admission, two actual original scripts, 180-second case
and existing 160-second child envelope. None is waived or replaced by replay.

All 28 human approval provenance, both pending contracts, capability inventory,
provider policy, generators and scope bytes are unchanged. Regeneration grants
no disclosure approval carry, provider/evaluation call or real HR-data authority.
The sidecar rebinds every predecessor map member plus new declared owners/checks
without rewriting historical maps. It is a complete map for the explicit review
scope, not a transitive installed/native runtime, process or lease closure.
Release, speed, full ESS purpose, zero Busy and staging acceptance remain OPEN.
Production remains on hold.
