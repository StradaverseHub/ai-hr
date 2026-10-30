# V9 lifecycle finish review

The supplied Admin V9 HTML governs this surface; the Handover Specification explains it. The scoped workflow-action review is complete. The case remains connected to canonical Personnel, Native onboarding, issuing/inventory records and managed delivery.

## Reviewed behavior

- Open workflow clears the selected case and selects its definition in the mounted workspace.
- Email Preview opens the complete recipient, attachment, document and per-person file review. Edit for this person opens editing directly and retains rejected input.
- Pending cases permit per-person email edits; closed cases reject them at the server boundary.
- Explicit tests may run before submission or after closure. New SQL intents bind to the initiating database actor, with one matching actor recipient, empty CC and no onboarding contact. Tests do not resume real workflows or release employee documents/tasks.
- Preview and Test prioritize the first email, otherwise the first notification; document-only Preview uses the first document’s current published version as a transient plan, preserving saved documents.
- Notification review includes recipient/CC context, first-name/count/task substitutions, source bullet/date formatting and the empty pending fallback. Notification tests select the module’s managed sender profile.
- Real Start/Continue and real email delivery retain their open-case and eligibility checks.
- Configured HR-only scalar writes are denied; non-HR module responses redact HR-only values. Group view-only and original issuing/IT recovery authority remain distinct.
- Leaver filters include Business Group, last-working-day bounds and computed readiness. Settings respect module visibility.

## Verification and limits

Independent source reviews cleared the workflow-action and authorization boundaries at `2c78adbe5abd7ffb0be2fd65b627a60e2012504e`; both reviewers separately cleared the exact minimal owner-token/fixture-binding correction applied at `8f27c7f39ef70571f6cca76360cdaac0cf89d935`.

Hosted UI interactions and whole-repository TypeScript passed in run41017792324. Compiler and Linux build passed at2c78 in run41019130241; its two empty-owner assertions and three new fixture-binding failures remain recorded. The failed/affected model and actual database receipt cases passed at8f27c7f39 in run41020228131, preserving both earlier failures and the replacement source identity. Final integrated release evidence remains a separate exact-source requirement.

The source design tokens, layout contract and retained fictional admin/group/employee captures were reviewed. A permitted rendered comparison with the original local HTML remains unavailable, so exact pixel parity is not certified. Final staging journeys and human acceptance remain separate claims.

No new shipping raster assets were introduced; existing assets retain their existing provenance.

**Verdict:** source and interaction review complete; release verification and reference-render comparison must retain their actual status. This document grants neither staging acceptance nor production authority.
