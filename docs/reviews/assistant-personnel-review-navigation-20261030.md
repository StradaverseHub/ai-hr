# Personnel human review navigation

The owned navigation branch explicitly retains reviewed, runtime-unverified Wave5 base
4f683f5bf1c31d56e06c6844f4b6de06a151963f after freshly fetched main/alpha (279 ahead/36 behind).
Other worktrees, frozen packages and historical SQL are preserved. Installed Next documentation is
absent; the page and async RSC follow existing server-component patterns without dependency setup.

Exactly two actions are eligible: employees.workforce_profile.maintain and employees.code.maintain.
The server-only owner returns only these closed action IDs. The RSC obtains their fixed review routes
from the typed registry and uses existing six-locale titles plus the existing human-review heading/note.
There are no subject parameters, arbitrary action/route inputs, form fields, client command or effect.
Cost allocation is intentionally excluded until a separately reviewed native witness is available.

Each action uses ordinary withTenant with no transaction options, then SET TRANSACTION READ ONLY.
This changes access mode only and retains the principal guard's required default READ COMMITTED
isolation; readOnlySnapshot would select incompatible REPEATABLE READ and is deliberately not used.
No db/client or principal guard is changed. Each transaction runs withAgentActionGuard at approve tier:
current authentic principal, genuine nullable actor Person, fresh commercial/module state, Assistant
grant, existing Assistant feature pause and action pause. Faults/refusals hide that action; a failed
transaction cannot poison the second action. No cached role is converted to workforce_maintainer and
no authority is derived from a previously loaded workspace or jobModules list.

Two fixed SQL functions return boolean EXISTS results only. The profile witness delegates native
0717 choice_scope IS NOT NULL, including shared-person retained-company explicit denials and the
Assistant no-own-person restriction. The code witness delegates native0721 employment-company scope
and the same current-user/no-own policy. They enumerate no labels/values/subjects/counts outside their
owner, call no list/editor/fact readers, and create no table grants, policy, ledger or mutable state.
Existing selection, field visibility, version, prepare and effect owners remain the authority after
navigation. A link can become stale; the target must refuse under its current native rules.

AssistantPage inserts only the dedicated RSC import and one fragment in EACH existing branch. An
accessible human review remains discoverable when only workspace/history/fact loading is unavailable;
actual Assistant/commercial/authority refusal still hides it through the independent owner. Canonical
fact admission, ModuleJobChooser, action catalogue/coarse actors, inline hints, provider admission,
historical privacy/grounded answers and PR104-owned paths are untouched. Nothing is sent to a model.

Authored UNRUN evidence:
- assistant-personnel-review-navigation.test.ts uses real native positive view+maintain grants and a
  genuine unlinked USER plus a real linked maintainer/native rollback contrast; raw person/employment/audit invisibility; exact boolean DTO/minimal SQL;
  no provider/list/editor calls or mutations; self/HR/tenant/company and retained profile-vs-code
  denials; actor relink/current principal; revoked Assistant access/archive; fresh commercial module
  expiry; canonical Employees kill; shared/action pause; independent transaction failure; and fresh
  direct-page choices refusal after a link was offered. Native SQL fault injection is fixture-only.
- personnel-review-navigation.dom.test.tsx calls the actual landing-page function in both workspace
  branches and renders the actual navigation RSC, using all six locale copies. It checks fixed routes,
  action-only output, no subject/query/cost link, no form/mutation/fetch, and an empty fresh offer.

Only static inspection, diff checks and source-manifest generation are performed here. No local
runtime, test/collection, compiler, DB, build, server, provider, CI, push, PR or release occurs. Hosted
verification remains parent-owned; no PASS or deployment claim is made.

0727/idx708/when1793330000064 is a tentative UNAPPLIED SOURCE CLAIM ONLY, following the reported V9
56–63 lead. Performance0726/55 is a collision lead, not an allocation to overwrite. Reallocate the
complete unapplied tail above the actual accepted ordered installation ledger at integration freeze.
