# Communications and documents presentation inventory

Source baseline: 6487 parent integration, 2026-11-18. Scope: presentation, a read-only upload capability reflecting the existing writer and file INSERT policy, and exact read-only frozen run/step preview context. Commands, recipient resolution, schedules, delivery and document generation remain owned by their existing services.

| Existing source | Information and operations retained | Destination |
|---|---|---|
| NativeCaseDocuments / OffboardingCaseView documents | Exact saved name, version, status, Open, eligible Regenerate; available matching Generate templates; pending submission notice | Documents & files, generated documents |
| CaseDocument dialog | Download PDF, per-person editing/reset, preview/done, HR fields, Personnel refresh/missing values, signing and validation | Existing dialog reached from document rows/chips |
| CaseFiles | Filename/download, slot label, empty state, configured slot selector, format/size limit, upload, reserved queued delivery warning, refusals | Documents & files; same POST and selected slot for drop and picker |
| CaseWorkflows | Workflow identity, frozen running definition, timing, state and hold reasons; preview, per-person edit, workflow link, test, Start/Continue, late Send anyway/Skip | Schedule row plus More actions; blocker buttons open that row's existing recipient editor |
| CaseRecipients | Per-step To/CC; override badge, Save, reset to workflow recipients, Cancel, errors | Schedule row More actions |
| CaseEmails / EmailDialog | All module templates including unused ones, edited-copy badge, preview, frozen message/assets, edit/save/cancel, test/send, safety note | Schedule, explicit Unscheduled email templates area; existing dialog |
| CaseMailHistory / UpdatedEmailReview | Subject/recipients/status/failure, queued/relay-accepted dates, test/contact, saved body/assets, retry lineage/reason, uncertain caution, later attempt, receipt review, same-copy retry and reviewed updated-copy operations | Sent log, newest first, stable exact delivery anchors |
| PersonnelReview | Source document, field/before/after, status/conflict, selection/supported-key restriction, sensitive mask toggle, Personnel mapping link, Push selected, Keep only | Conditional Personnel changes tab; canonical audit attribution or Not recorded |

Schedule identity is workflow ID / retained run ID / step ID. New matching workflows have a `planned` run marker. The projector never creates a run or future occurrences. Repeating reminders retain a bounded range; mail attempts remain in Sent log rather than inflating schedule counts. Test mail receipts are explicitly optional test rows and retain mail identity; no workflow identity is inferred where the original receipt has none. Frozen run definitions own in-flight rows; current definitions supply only future work. Normal filters partition the same rows into attention/open/done. Optional or nonmatching future definitions and unscheduled previews are excluded.

All four tab panels remain mounted while hidden so recipient drafts, PM selections/masking and retry reviews survive navigation. Cross-tab links select their destination and focus its exact stable anchor. Exit/return/clearance panels remain outside this section.

Schedule counts include emails, notifications/reminders and document releases. Internal file/signature waits supply context on the next communication (or preceding document release); they never become extra scheduled messages. A current missing required file supplies the existing upload recovery surface. Workflows containing only waits remain in Other workflows outside these counts. Effective delivery retry outcomes own delivery attention; resolved historical failures do not reopen a blocker. Captured receipt recipient names own historical To/CC.

The compact Continue control is enabled only for the exact first unfinished run selected by the existing writer. Other displayed runs show why Continue is unavailable; preview still reads their own frozen run/step. No new run-targeted write command was added. Explicit late-decision actions retain their run and step IDs.

Read-only preview validates case, module, workflow/run/step and template identity under the existing fresh authorization scope. A missing frozen definition refuses preview rather than substituting current configuration. Scheduled email previews use the canonical step recipient renderer; manual template preview and its existing send/edit controls remain explicit More actions. These reads neither generate documents nor persist changes.
