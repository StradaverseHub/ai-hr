# ADR-0127: One private sign-in conversation with explicit confirmed proposals

Status: Accepted direction; source implementation pending integrated verification.

Home047b14af and AI Responsiveafb6071c need continuity between their conversation surfaces. Existing
`assistant_exchange` owns the private question/answer audit, `assistant_usage` owns recorded provider
usage, and canonical domain services own changes. A browser transcript, user-ID-only session key or a
second AI service would split these authorities.

Use one metadata conversation bound to the actual tenant/login, verified provider sign-in and current
selected companies/authority stamp. Internal authentication uses its verified session family; WorkOS
uses the verified SDK session ID; Keycloak uses verified identity plus the decoded opaque browser
handle hash. The separate demo nonce partitions history and confers no authentication authority.

`assistant_conversation_turn` references the existing exchange; it never copies the transcript. Private
feedback lives on that reference. Composite identity FKs and self-only FORCE RLS do not give an HR
administrator access to another user's conversation. Invalidating a conversation preserves its private
audit but prevents application history retrieval and refuses awaiting proposals. Canonical archive /
restore event references prevent restoration of an old binding merely because current archive flags
again have their original values. Permission hashes are observations, not authorization or locks.
Every operation resolves actual assistant entitlement and grant independently of report availability.

Claim an exact request UUID/revision before any provider work. A completed request replays its existing
reply. An in-flight retry refuses; expired in-flight work invalidates rather than automatically repeating
an unknown provider call. Provider work runs outside database transactions. Re-resolve sign-in,
principal, grants and scope before model/tool turns and after a long completion, then attach only to the
same current claim. Historical conversation is context, never fresh evidence.

Keep model facts in read-only, allowlisted tools. Company selection narrows canonical readers without
changing grants; past Attendance company membership uses the dated company owner. Payroll history
uses its recorded batch company. Audience-filtered published handbook articles and closed reviewed
workflow keys supply instructions/links. Render model text as text, without executable HTML or model
URLs. Missing historical facts, source refusals, capped results and interrupted answers remain explicit.
The country statutory owner exposes only current own registration presence through this channel;
registration numbers, identity, relief grids and bank data are not part of its result.

The only consequential adapter is `close_fixed_upstream`, at most50 reviewed subjects. Store exact
canonical IDs and an opaque source/precondition digest. A separate explicit confirmation rechecks
current actor/company/version, locks the supported source rows and resolves through the existing
anomaly owner. Every recorded finding must be supported and corrected. Domain changes, canonical
events and the frozen confirmation result commit together; retries return that result. A changed
reviewed source refuses the conversational batch, while the pre-existing default action API retains its
per-subject partial-success behavior. Enter in the question composer cannot confirm a proposal.
Other requests open reviewed existing workflows and cannot claim completion.

Actual model questions always reserve and finalize the same `assistant_exchange` question row.
The canonical per-user/day budget lock serializes the daily count and reservation, then releases before
provider work. A server-generated zero-model proposal/confirmation is classified `capability`, never a
provider/caller flag. A SQL shape check and immutable classification prevent relabelling a model audit.
No new balance, purchase, reservation table or usage counter is introduced.

Budget treatment is explicit: invalid questions, denied access and missing provider configuration
before reservation create no question audit. After reservation, failed/cancelled/lost calls retain one
question attempt; recorded actual token usage remains governed by the existing gateway and usage
owner. A pending row is truthful pending evidence, not a successful answer. No audit is deleted to free
a question slot. Existing monthly usage/turn checks and canonical gateway controls remain; this ADR
makes no stronger atomic monthly-ceiling guarantee than those owners provide.

Verification must include real app-role identity/RLS/composite FK refusals, fresh sign-in/scope/grant
changes, actual source-change/concurrent confirmations, concurrent in-flight question limits,
zero-model confirmation metering, no cross-person salary leakage, handbook audience denial, verified
local routes, IME/Enter separation, unsaved editing, six locales and actual provider/authenticated UI.
Source tests and parse checks alone do not establish these runtime outcomes.
