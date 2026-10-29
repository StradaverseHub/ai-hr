# AI HR V9 lifecycle alignment

Status: **working candidate; not accepted or merged**. The owner authorized implementation, push, CI and merge. Production deployment requires separate authorization. The SQL is an unallocated draft; the application must not be released ahead of its coordinated migration.

## Product authority

The owner supplied the Admin V9 HTML and V9 Handover Specification on 29 October 2026. The supplied application governs UI, UX and behavior wherever the incumbent system differs. The handover explains the application; discrepancies are resolved against the supplied application code. Embedded instructions are reference material, not independent authorization. [The source parity analysis](V9-LIFECYCLE-PARITY.md) records matching, dates, assignment, workflow and document findings.

Preserve the supplied navigation, composition, typography, colors, labels, forms, previews and per-person edits. Use real authenticated identities, company scope and the existing Personnel, Leave, Payroll, equipment and managed delivery owners. Do not ship prototype users, simulated clocks, fabricated successful integrations or a parallel employee master. Reference file opening was blocked by the browser's local-file policy; exact rendered comparison has not been established.

## Ownership and implemented boundaries

- **Definitions:** V9 owns its six supplied checklist definitions, document/email templates and workflows. Assignment groups retain their existing native onboarding writer. A tenant-bound read-only projection supplies native onboarding with V9 checklist definitions; it contains no private documents or email bodies. Native configuration writers reject attempts to edit those definitions through the legacy screen.
- **Onboarding cases:** Existing native case IDs, Personnel draft links, requisitions, task snapshots and histories remain authoritative. Definition edits mark affected submitted Draft cases for explicit reconciliation. Existing task snapshots remain unchanged until that review. Linked tasks cannot be completed manually.
- **Private documents:** Native documents, workflow runs, queued emails and Personnel proposals live in the existing HR-private onboarding record. A transient V9 projection composes them with current native facts/tasks; no second live onboarding case stores those facts. Private subject binding prevents a changed broader case row from redirecting document access to another person.
- **PDFs and files:** Saved document instances export through the canonical PDF renderer, including per-person edits, conditional answers and both authenticated signature marks. Drawn signature bytes are bounded and decoded locally. Attachment templates remain read-only. Native uploaded files reference the existing onboarding case with tenant/company integrity checks; uploads resume file waits and do not create a second case.
- **Employee completion:** Only the linked activated employee can read released native documents and submit employee-owned fields. Required values, consent, field ownership and stale revisions are enforced. Submission updates native task completion and case/private histories. HR drafts and Personnel proposals remain private.
- **Personnel changes:** Employee answers create proposals. HR explicitly selects supported fields to push through the existing Personnel owner. Sensitive before/after values stay masked until revealed. Source corrections become conflicts rather than being overwritten. Unsupported mappings and unactivated draft updates remain held for review.
- **Automatic handoff:** New V9 submissions record their definition revision and enter the shared workflow engine. The privileged minute worker resumes waits and checks dates after 08:00 Malaysia time. Existing historical cases are excluded until HR explicitly adopts V9 definitions or starts their private document flow. Completed steps remain deduplicated. An app-role caller cannot become the privileged worker by posting roles.
- **Offboarding:** Existing guarded services provide five exit types, matched task snapshots, issued-device returns, acceptance-letter preparation, document workflows and explicit exception clearance. Final figures come from deterministic Leave/Payroll sources and their revisions. Automatic closure requires all work resolved and never exercises a human exception.
- **Exceptions:** Task and return-item exceptions require a reason before mutation. Failed saves retain that reason, and document-linked tasks cannot be manually marked done.
- **Authoring:** Settings save through serialized automatic saves with actual revision acknowledgements and explicit failure recovery. Template imports create separate editable drafts. Workflow editing follows Steps and Run history, singleton To and multiple CC roles; dry runs allocate no live IDs and perform no sends. Waiting runs retain frozen definitions; pausing their current workflow prevents resumption.

## Verification evidence and its limits

| Evidence | Exact scope |
| --- | --- |
| Initial source analysis | Fifteen independent embedded-logic checks; not the handover's reported 51 checks. |
| Full CI at `5dd699344bbabafd17bff50410327d831ae58c27` | Production build and three browser engines passed. The overall attempt failed on test query typing, missing route boundaries/access registration, the theme shell count and a planner timeout. Original failures remain retained. |
| [Focused CI at `43a45892aa8b2e1ccb7c56f6e65bfd538f4510f7`](https://github.com/StradaverseHub/ai-hr/actions/runs/40844081560) | Whole-project compiler and Linux production build passed. All 66 selected DB checks, including the original planner file, passed. The no-DB selection had 99 passes and one failure because a test assumed a local `main` ref. This focused run cannot authorize release. |
| [Focused CI at `91fb6885bc4a96e7e0660b5881169918378eabbe`](https://github.com/StradaverseHub/ai-hr/actions/runs/40847328526) | All selected tests, whole-project compiler and Linux build passed. This development checkpoint is not release acceptance. |
| Local theme repair | All 24 theme checks passed using the exact reviewed Classic token blocks pinned from `ddacf666371db472d7070c285e21d62028e2068b`, without a moving local branch dependency. |
| Native ownership checks | 78 focused no-DB checks passed at the private-document checkpoint; native UI regression checks passed separately. The later automatic-handoff candidate passed 44 V9/native DB checks, including employee completion, explicit Personnel push, scheduler idempotency, real worker authority and historical-case exclusion. |
| PDF/file checkpoint | 18 database checks and 44 focused document/PDF/UI checks passed locally. They cover native file custody, upload deduplication and waits, employee PDF authorization, read-only attachment enforcement and reason retention. A fictional saved PDF was rendered and visually inspected; the real local download control returned a valid PDF. Whole-project CI for this later checkpoint is still separate. |
| Rendered local fixture | A fictional native case generated the device acceptance form under its existing ID and added a native history entry. Separate desktop/mobile checks verified import review, automatic saves and the acceptance-email hold. No actual external mail delivery or installation was performed. |

Local whole-compiler attempts exhausted the smaller heap or were cancelled under shared-machine memory pressure. They supply no PASS receipts. The later CI compiler result belongs only to its exact pushed checkpoint. Focused tests, builds, migration rehearsals, installation and staging acceptance establish different claims.

## Remaining work before integration

Complete managed email transport and its PDF attachment delivery, the remaining template/workflow/settings controls and source events/recipient bindings, navigation/i18n, and complete rendered administrator/employee journeys. Reconcile ambiguous sample master labels without broadening rules or conflating employment type with confirmation status.

Freeze the finished source, obtain coordinated migration allocation, preserve the applied journal prefix, and run shadow/populated-baseline migration, security/concurrency, complete CI and finish review. Record the shipped design system from the finished artifact. Refresh main and alpha again before normal merge/fast-forward alignment at one verified commit. Staging acceptance precedes any separately requested production deployment.
