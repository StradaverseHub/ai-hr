---
version: 1
slug: "app-admin-settings-email-page-tsx"
primary_target: "app/admin/settings/email/page.tsx"
related_targets: ["components/account-email-deliveries.tsx","app/admin/settings/email/connection-fields.tsx"]
---

# Email delivery

Mode: Operate. Installation email administrators need to identify the saved SMTP connection, understand which version is live, test a change and inspect an account email without exposing authentication tokens. The supplied Odoo screenshots pin the list/detail interaction; AIHR's incumbent shell, controls, typography and theme remain authoritative.

## Direction contract

THESIS: Named saved connections are the primary object. A working sender is distinguishable from unactivated edits and from delivery attempts.

OWN-WORLD: Existing AIHR Atelier neutral surfaces, charcoal text, semantic status badges and the existing primary action color; standard form controls and restrained table dividers.

STORY: Scan saved connections, open one to edit, save and test it, confirm inbox receipt and activate. Inspect delivery status separately and explicitly resend an eligible message with a fresh link.

FIRST VIEWPORT: A compact active-sender summary above the connection table; New connection at the table's upper right. Name, server, username, sender, security, status and last test form the scan. Delivery history follows with date filters, a local timezone label and expandable preview/resend actions.

FORM: User-pinned Odoo-style list/detail extension inside the existing product world. seed: none (a precise reference; concept roll not applicable).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Constraints

One active relay; encrypted write-only credentials; no automatic sending or deletion. Keep existing active configuration during adoption. Malaysia clock comes from the installed country pack; ambiguous/no clock uses explicit UTC. Preserve authorization, historical attempts and accepted invitations. Previews use the common template with nonfunctional placeholders, and do not claim to be historical originals. Resend requires explicit acknowledgement and creates a new single-use link. Verify desktop/mobile in the existing themes and six locales; hosted checks only.
