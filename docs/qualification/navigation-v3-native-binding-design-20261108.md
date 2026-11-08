# V3 nested native binding: design review request

Candidate base: `996cf85fdc0759bb01357b72927b24f897b95d79`, an explicitly
selected descendant of aligned fetched `origin/main` / `origin/alpha`
`b7c0393aa3c7606a33dd15103426e5c535324065`. The branch divergence is 969/0
against each integration ref; no shared branch or working tree is changed.

This checkpoint contains only the ADR, source gap inventory, this review request
and their source manifest. It implements no resolver, fixture, scenario, collector,
permission, application route, runtime acceptance, source approval or release gate.
The old approved source census is retained: 46 families, 258 renderer candidates,
120 parameterized pages. The companion inventory binds current family/page owners
and enumerated direct import leads; its 478 hashes are **not** a full transitive
runtime/source closure or completed permission audit.

Read [the design](../architecture/NESTED-NAVIGATION-V3-NATIVE-BINDING-20261108.md)
and [the gap inventory](navigation-v3-native-binding-gap-inventory-20261108.json).
Eleven families have partial fact composition, two have selected static facts and
33 still need source composition. All 46 lack v3 native bindings and actual
execution. The 120 page associations, native fixtures and expected native
outcomes remain explicit unresolved obligations. Unsupported ScheduleGroup states
stay published unsupported states; they are not silently removed or usable data.

## Proposed first implementation lease, only after design review

New independent owners, with final file names confirmed before edits:

- `scripts/performance/navigation-v3-protocol.ts`: closed intents, family-specific
  typed parameters and outcomes; strict parameter kind/encoding/unknown-key rules.
- `scripts/performance/navigation-v3-native-binding.ts`: fixed native principal /
  family reader resolution, private in-process binding, fresh revocation/foreign/
  unknown/stale refusal. No caller authority factory or serialized verification.
- `scripts/performance/navigation-v3-fixture.ts`: job-owned fictional construction
  through existing canonical helpers, returned IDs/input facts/record reservations;
  this cannot edit system-fixture or expand aggregate resource allocation itself.
- `scripts/performance/navigation-v3-entry.ts`,
  `navigation-v3-browser-capture.ts`, `navigation-v3-scenarios.json`: actual native
  choices and stateful interactions, visible active content, persisted independent
  values, actual account, failure observations and per-choice usable timings.
- Separate v3 source/receipt/ledger helpers and focused contracts/real-native /
  browser controls. The first lease does not permit changing any original v2
  acceptance, system-load/fixture orchestration, pool, CI/controller or shared
  process owner. Renderer/fact-owner modifications require an exact later lease.

The first coherent native family slice covers Personnel record/draft, ESS,
Company, ScheduleGroup, LeaveType and ProbationPreparation with the existing
canonical APIs enumerated in the ADR. A domain without safe native presentation
projection, role fixture, complete child data or stable record reservation stays
blocked; a selected prototype cannot clear the remaining 46-family census.
Do not invent a prospective passing test count before the actual resolved matrix.

## Decisions requiring root source review before those edits

1. One max1 app-LOGIN lease inside the existing aggregate connection family;
   canonical purpose owners and full isolation/audit effects retained. No default
   pool import or extra independent full pool. Where a narrow projection is
   missing, a separate domain owner must design it rather than dropping effects.
2. Canonical fixture allocations/reservations and current principal / session
   binding, including role branches the existing four profiles do not represent.
   Operator/invitation realms need their own real authenticated fixtures, or stay
   unresolved. No new permission is copied into a catalogue or silently granted.
3. The complete typed role/leaf/disposition matrix and schedule capacity under the
   fixed workload. Functional preflight precedes root-owned loaded integration.
   If cohorts are required, review their exact frozen assignments and identity /
   aggregation contract; every 2/4/8 comparison uses the same revised protocol.
4. V3 code and nonexecuted build-data source custody. Current raw locale files
   exceed v2's per-file code-harness cap in multiple languages. Design a separate
   exact candidate-Git/build data seal; do not raise the existing limit, omit
   locale input while claiming full closure, or trust candidate JSON hashes alone.
5. Native probe / actual browser record epoch compatibility during concurrent
   existing mutations. Unexpected changes fail the case instead of rereading
   until values agree or accepting stale expected values.

## Meaningful planned verification (not executed)

- Source contracts retain the exact 46-family / 120-page inventories, canonical
  IDs/order/builders, every unsupported/unbound role/state and original v2 limits.
- Native fictional constructors and real restricted LOGIN prove returned IDs,
  independent nonempty values, date/scope/current principal, same-tenant and
  foreign denial, missing/unknown parameter refusal, fresh revocation, stale
  record rejection, rollback and owned drain/cleanup without business drift.
- Actual rendered tests prove original dirty guard, mounted forms, tours, save
  scope, carry/query/fragment encoding, workspace filtering, visibility and
  ordering. These are separate from real browser/native acceptance.
- Functional real browser capture proves actual native menu traversal and
  state-only tab interaction, visible active usable controls/data, exact signed-in
  actor, correct refusal/unsupported states, saved persistence and unsaved cancel /
  discard. No heading/200/metadata-only success, provider calls or financial side
  effects simply to navigate.
- Adversarial verifier/source controls reject caller JSON authority, mismatched
  source/run/attempt/harness/role/record, changed fixture epoch, hidden panel text,
  another actor's body name, forged outcomes and incomplete cohort/source proofs.
- Root integrates only reviewed bounded fixture/pool/load/CI owners, then collects
  actual baseline plus steady-500 outcomes for all applicable leaves/roles, with
  unchanged 90s scenario / 8 steps / 16 checks / 1024 scenarios and strict latency /
  error/Busy limits. Whole-system release, worker and installation gates remain
  separate and open. Source/models never qualify execution.

No local behavior, test, compiler, build, provider, database or deployment command
was run for this checkpoint. Standard hosted Actions is the only planned execution
route after source review and the appropriate authenticated fixture/profile
commissioning. Production and staging remain untouched.
