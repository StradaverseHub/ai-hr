# ADR-0173 — A protected case route for sensitive matters

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

- **Status:** Proposed on branch `claude/aiv2-s2-case-route` (AI v2 Phase 1, slice 2, workstream W11). The owner chose a minimal route in Phase 1 on 3 November 2026 ("Minimal route in Phase 1"). Production is held; staging uses fictional data only. Nothing here authorises a deployment.
- **Number:** provisional. A scan on 3 November 2026 found ADR-0172 claimed on other branches (`0172-subject-owned-content-bound-signing.md`); reconcile at integration.
- **Date:** 2026-11-03
- **Relates to:** [ADR-0169](0169-assistant-context-harness-and-disclosure-repivot.md) (the harness, §9 stored chats), [ADR-0170](0170-teras-ai-operating-architecture.md) §3.2 (sensitive-topic routing), [ADR-0030](0030-audit-log-pdpa.md) (PDPA erasure), [ADR-0084](0084-propose-adjudicate-learn.md) (models propose, services decide).
- **Migration:** `0959_private_cases` (provisional development allocation, `when` 1793330000359; see [migration allocation](../MIGRATION-ALLOCATION.md)).

## 1. Context

The pre-read gate (`lib/product-context/request-gate.ts`) answers sensitive turns with a fixed reply and no model call and no private read: a crisis, harassment, a threat of dismissal, a grievance, a medical matter, and refusals for workplace-harms and rule-override requests. A gated turn stores no words (ADR-0169 §9). But the route led nowhere: the spec's `contact.caseRoute` is `null`, so the reply could only say "your HR team". The AI v2 plan (W11) proposed a minimal case intake a person reaches from such a reply, routed to named HR handlers with strict access.

## 2. Decision

### 2.1 The model

| Fact | Owner | Notes |
| --- | --- | --- |
| A **private case**: one person's written report (grievance, harassment, safety, other) to HR | `private_case` | Text encrypted. Status `received → in_review → closed` (or `received → closed`); closed is final. |
| A **handler grant**: login *L* receives cases for company *C* | `private_case_handler` | Designated by an administrator; revoked, never deleted. |
| A **handler note** | `private_case_note` | Encrypted, append-only, handlers only. |
| The **case record** (audit) | `private_case_event` | `created`, `read`, `status_changed`, `note_added`; append-only. |

The author is a **USER** (login) with a current **EMPLOYMENT** in the case's company; the person at opening is kept for erasure. A user without an employee record cannot open a case. The case names its company, never a subject person: whom it is about lives only in the encrypted text, and in the author's optional exclusion of a named handler.

**The route is configured** for a company once it has at least one current handler. Only then does the intake accept a case, does My Profile offer it, and does the AI Centre's routed reply carry the link.

### 2.2 Who reads

Forced row-level security on all four tables binds the physical owner too. The application policies admit:

- **The author**: their own cases (text, category, status history). Never the handler notes, and never who read the case.
- **The case's handlers** (`app.private_case_may_handle`): a current, non-agent login with a current principal snapshot that is not the author and not excluded, and
  - while any eligible handler of the company remains (a current handler other than the author and the excluded): a current handler of that company;
  - otherwise, or when the author sent it to the group administrator: a current **group administrator**.

There is **no** policy for company HR administrators, managers, agents or any other login. Designating a handler grants the designator nothing. Revoking a grant ends that handler's access immediately. A case whose every handler was revoked falls to the group administrators, so it is never orphaned.

**Exclusions and conflicts** (coordinator review, 3 November 2026). The intake names everyone who could read a case of the company: its current handlers and the current group administrators. The author ticks anyone the case is about, or who must not see it. Nobody ticked ever reads it, on any route, including the group-administrator fallback. This is the top-level exclusion in `app.private_case_may_handle`, and the database refuses to exclude anyone who is not a possible reader.
- With every handler excluded, the case goes to the group administrators, again except the excluded and the author. The author may also send it to them directly.
- A handler or group administrator who writes a case never handles it.
- When nobody is left (the subject is the only group administrator, or every possible reader is excluded), the case is **still kept**: refusing it would lose what the person wrote. Nobody reads it. Its author sees "No eligible reader is configured for this company, so nobody can read this case yet. Please contact [the company's designated external channel, for example an ethics line]". The bracketed channel is a placeholder string until a tenant setting names a real one. `app.private_case_has_reader` answers this from the routing facts and names nobody.
- A reader designated later, who was not excluded, can read such a case. They are not notified of it.

**Designation** (`private_case_handler` policies): a current group administrator, or an HR administrator of that company (`app.is_admin_for`). **Nobody designates themself**, in any company and whatever their role. This follows the coordinator decision recorded on 3 November 2026: an HR administrator may not designate themself even in a single-administrator company; a group administrator designates them. A group administrator is an HR administrator too, so the same rule applies to them. Two HR administrators of one company may designate each other. Each designation and revocation is a `domain_event` (`private-case-handler.designated` / `.revoked`) and stays on the grant row (who, when).

**Notices.** In-app notifications, written into the existing `public.notification` table that the bell reads, where the tenant has the notifications module:
- **A new case:** each current reader gets "A private case is waiting", "Open Private cases to read it." and a link to the case. These are the eligible handlers, or failing them the eligible group administrators; never the author or anyone excluded.
- **A status change:** the author gets "Your private case has an update", "Open My private cases to see it." and a link to their case. There is none when erasure is waiting on the case.
- **No content:** a notice carries no category, status, name or word of the case.
- **Written by the database:** a definer trigger (0959 §4b) writes them, not the domain-event sweep, because HR administrators read domain events. An event would tell them a case exists and, with the default actor, who wrote it.
- **Who has no bell:** a reader without a current employment, because notifications are addressed by employment and login-addressed rows are reserved for letters.
- **Author updates:** there is no author edit path in this minimal route, so there is nothing to notify for it yet.

**Navigation.** The rail (`components/sidebar.tsx`, placed by `lib/navigation-workspaces.ts` with My workspace in the shared area) shows two rows:
- **"My private cases"** (`/me/cases`) to every person.
- **"Private cases"** (`/cases`) only to a login that handles private cases. `app/layout.tsx` decides this with `handlesPrivateCases`: a current handler grant, or a case it may handle (a group administrator holding a fallback case).

Both are product destinations. The handlers' queue is labelled for administrators only.

**Audit.** Triggers write `created` (as the author), `status_changed` and `note_added` (as the handler). `core/private-cases.ts` writes a `read` row in the same transaction before it decrypts any text, and the insert policy admits it only for a login with access. A refused read therefore records nothing. Lists show category, company, dates and status only; opening a case is the audited read. The application role cannot update or delete an audit row or a note.

### 2.3 Privacy

- **The AI never sees the words.** The person writes the case on its own form (`/me/cases/new`), never in chat. The routed turn still stores no words. The case is a separate record that no model, tool, transcript, stored chat or task memory reads. The AI side asks one question on a routed turn only, after the gate: "is the route configured for this person and company?" (`core/private-case-route.ts`). It reads no case and passes nothing of the turn to the form.
- **Encryption at rest:** AES-256-GCM through `lib/ai/crypto.ts`. The additional data binds tenant, case and author for the text, and tenant, case, case author, note and note writer for a note, so a moved ciphertext fails. There is no plaintext fallback: without `AI_CONFIG_SECRET` no case is stored and the form says so. The database refuses non-ciphertext values.
- **Grants** as well as RLS: the application role holds `SELECT, INSERT, DELETE` and `UPDATE (status)` on cases (delete is admitted only by the erasure-on-close policy), `SELECT, INSERT` on notes and audit rows, and `SELECT, INSERT` and `UPDATE (revoked_at, revoked_by_user_id)` on grants. Everything else is revoked.
- **Definer lookups** return names only: the intake's handler names, for a person who may open a case there; the names on one case, for a login that may handle it. The owner-side policy that serves them is the same `may_handle` predicate, evaluated for the calling session, so it widens nothing. `test/private-cases-owner.test.ts` proves the owner paths with a restricted, non-superuser owner.

### 2.4 Erasure and the retention exception

Person erasure (`core/pdpa.ts` → `app.private_cases_redact`) joins the existing admitted, audited review-erasure intent, as stored chats do:

- the person's **closed** cases are deleted, with their notes and audit;
- **open** cases are **kept under the retention exception**: an open grievance, harassment or safety matter may need its record to be resolved or to answer a claim. The PDPA Retention Principle allows keeping data while it is still needed for its purpose. They are marked `erasure_requested_at`; the handlers see "erasure requested", and the case is deleted in the same transaction in which a handler closes it;
- the function reads no text. The erasure report names **no** private case either way, so an erasure is never a way for an administrator to learn whether someone wrote one.

Free text that names other people is not linked structurally to them and is not redacted by *their* erasure. It goes when the case goes.

## 3. The AI Centre reply

`core/harness/runner.ts` accepts `caseRouteAvailable` and asks it only on a routed sensitive turn. `routeReply(caseRoute)` adds the spec's `caseClause` only when the route is configured **and** the spec names a route. The spec's `contact.caseRoute` is still `null`, so the fixed reply text is unchanged for every tenant. `core/teras-wiring/turn.ts` exposes `caseRoute` (the form's path), and the reply's route note (`components/ai-centre/conversation-reply.tsx`) shows **"Start a private case with HR"** in six languages after the HR-contact line. On a crisis turn, the emergency message comes first and the link follows it. Workplace-harms and rule-override refusals are not routes and get no link.

Proposed spec lines (one coordinator change per slice; not made here):

```ts
contact:{label:'your HR team',caseRoute:'/me/cases/new'},
routeReply:'For this, please contact {contact} directly{case}. A person there can take it forward under your company\'s procedures; the AI Centre does not read it or act on it.',
caseClause:', or [start a private case with HR]({route})',
```

The `routeReply` change also replaces "the Assistant" (a user-visible name) with "AI Centre", per the naming rule. The comment above `contact` should then read: "caseRoute is the private case form (ADR-0173); the runner adds the clause only where the route is configured for the caller."

## 4. Consequences and risks

- **Residual risks:**
  - The author's name is shown to handlers. The route is private, not anonymous.
  - A handler can be designated in a way the author does not expect. Designation is audited, but the author is not notified.
  - A case nobody could read becomes readable to a reader designated later.
  - The author names the subject only by excluding them, so a subject who is not a possible reader needs no exclusion. Their name may still appear in the encrypted text.
- **Not built (later):**
  - reassignment and self-recusal by a handler;
  - attachments and anonymous reports;
  - the author withdrawing or adding to a case;
  - retention for closed cases (they stay until erasure);
  - a tenant setting for the external channel;
  - email for these notices (in-app only).
- **Recorded owner decisions (coordinator, 3 November 2026):**
  - open cases are kept under the retention exception until closed;
  - no HR administrator designates themself, even in a single-administrator company; a group administrator designates them.
