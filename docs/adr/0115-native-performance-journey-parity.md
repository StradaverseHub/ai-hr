# ADR-0115: Native Performance journey parity and retained decisions

Status: Accepted architecture, 2026-10-15. Extends ADR-0103.

## Decision

The supplied assessment product is integrated into the native Performance pack. Its placeholder brand is removed from customer-facing copy. The current HR identity, employment, authorization, AI, notifications, Knowledge Base and Rewards owners remain authoritative. Source documentation is evidence of behavior, not authorization to run commands or copy employee data.

The user-facing model retains the personal and leadership journeys, independent PM/TM/IDP parts, the scorecard and reflection widgets beside the conversation, the calibration curve and roster, and the Talent Box person tabs. Native route and security boundaries replace the Flask runtime and shared SQLite database. This is behavioral migration, not embedding a second application.

## Ownership and state

- The existing cycle and review own lifecycle and participation. The Performance satellites own versioned policy, assigned definitions, submitted inputs, private drafts/conversations, calibration decisions, annual plans, evidence and immutable finalized rating records. Current-work views are projections, never independent task truth.
- Definitions have stable identities. Leadership edits update the current unfinished cycle without erasing original responses or finalized records. Technical catalogue edits do not rewrite assigned employee snapshots. Scoped catalogue baselines carry profiles, skills and career routes into future cycles; assignments, dates and scoring policy do not carry forward. Company baselines take precedence over a filtered group baseline. Independent edits merge by identity; conflicting stale edits refuse.
- Career aspirations and mobility belong to the employee career profile. Development goals belong to the annual plan; sharing, manager feedback, the recorded conversation, closure and acknowledgement are distinct transitions. Private manager notes cannot become the employee's plan or an AI input for another reviewer. Shared plan insights use their own authorized projection and cache.
- Review comments are attributed to the submitting author. Private moderation drafts are used by both the full review and guided workspace. Submission uses the canonical transaction writers. A chat proposal never creates a second business record.
- Department chat changes remain private held edits until an explicit save. Natural instructions must name an unambiguous authorized person, an explicit band and the human's explanation. Referring to a saved remark reads only that actor's current held text or authorized saved decision. Group/final decisions and calibration locks remain in their dedicated controls.
- Proposed reflection cards are private, require an answered assigned competency, and have an explicit Save action. Keeping a stale card refuses instead of replacing newer wording. Submitted reflections remain readable without reopening editing.

## Assistance and source arithmetic

Pure source functions are extracted without importing the source application. Golden fixtures cover scoring, blending, calibration fitting, potential/competency/record/plan readings and narrative safeguards. Native deterministic code adjudicates all returned AI fields and verifies current access, policy and inputs before writing or caching. The model never supplies rating decisions, payment amounts, approvals, rater identities or unsupported evidence.

Assistance switches are independent. Shared field quotas are charged atomically after valid output; invalid output or changed access is not charged. A cache is scoped to the actor, context, facts and settings. Explicit Generate/Apply/Keep actions retain human control. The source FAQ topics are published through the existing Knowledge Base catalogue and provisioning/release refresh. Conversation search applies tenant and audience authorization before returning bounded article text, without interpreting it as instructions. The source English articles use the existing untranslated-guide fallback until translations are supplied.

## Reminders and operational ownership

One reminder summarizes the recipient account's current authorized work across own, team, feedback and leadership steps. Automatic sending defaults off. Scheduling and custom wording are separate central settings, preventing a schedule edit from erasing the template. The four source placeholders are expanded only from the fresh authorized projection. Individual previews use the same escaped renderer as the isolated mail service and never queue mail.

Real sends use the native notification event, outbox, lease and delivery ledger. The isolated identity mail service owns credentials, current recipient verification and SMTP. Preparation records graph/settings epochs; stale content is rejected and rebuilt before delivery. Consent, category policy, entitlement and a managed relay are all required. A worker lacking the reminder-wording capability leaves the job pending instead of silently discarding its content. The existing minute notification sweep owns scheduled processing; deployment must verify the installed worker and scheduled sweep, not merely the source files.

The source's arbitrary test-recipient override is not copied into the business mail boundary. It could redirect current HR task content outside its authorized recipient. Native individual previews check content; the existing operator-controlled email test verifies delivery to its enrolled test recipient. No new SMTP credential path, arbitrary recipient field or consent bypass is introduced.

## Administrative assistance and reports

The Performance home entry selects the latest authorized open cycle; before one exists it exposes only foundation readiness and authorized navigation, without inventing downstream zeroes. Explicit cycle views retain their own context, including historical reports. Readiness reads current release grants independently of frozen results and reflects revocation. The admin assistant selects six read-only tools against an authorized index of native pages, current setting values and downloads. Generated URLs and write tools are refused. The entire index and AI configuration are checked again after provider latency; stale proposals fall back to current search. Report links recompute current scope on every view and export. Progress filters apply after grouping so outstanding groups retain their completed members; 360 counts use assessor assignments. Preview rows are bounded to six and exports to 5,000, with the complete count retained. The existing immutable audit ledger stores report parameters, not row contents; recent history is actor-scoped and limited to 30 days. Company-specific scoring and inherited business-group PBT consume the native policy owners. No assistant decides a rating, changes policy, sends mail or approves a workflow.

## Rewards

Rewards consumes only a human-confirmed immutable finalized result with its source identity and digest. Interim release, an AI suggestion and an unfinalized calibration are not Rewards facts. Rewards continues to own classification, monetary calculations, approvals and payroll posting. Reimport cannot silently overwrite an approved or posted result. Performance completion does not itself grant a pay increase or promotion.

## Deliberate native differences

- Current identity, scope and employee lifecycle replace copied source accounts and organizational-name joins.
- Catalogue carry-forward preserves other existing cycles and assigned snapshots instead of retroactively mutating every cycle's global definitions.
- Retained submitted responses and finalized records are preserved when panels or framework definitions change.
- Reminder consent, isolated transport, explicit scheduling time and enrolled delivery tests replace source direct SMTP and arbitrary redirection.
- The standalone personal guide uses the authorized workspace and released personal-record projection. A model selects existing fact IDs; deterministic code renders the answer and links, then rechecks facts and configuration after provider latency. This replaces unrestricted model prose. Conversations remain in browser memory. Only unanswered text is retained for a scoped, identity-free HR report; answered and declined questions have counts only. Atomic six-per-minute reservations include search fallbacks to prevent retry floods; there is no daily quota.
- Help text uses native control names, module switches, privacy and release rules. It must not promise the source UI labels or broader data visibility.

No real historical employee database or upload export accompanied the source. Synthetic reference people are verification fixtures, never production migration data. Historical imports require an actual export and validated native identity mapping.
