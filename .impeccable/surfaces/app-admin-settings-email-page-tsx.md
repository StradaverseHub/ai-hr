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

FORM: User-pinned Odoo-style list/detail extension inside the existing product world. Reference provenance: owner message on 27 October 2026, “This view needs to be enhanced. Lets do it similar to Odoo,” with Screenshot 2026-10-27 at 3.13.12 PM (Outgoing Mail Servers list) and 3.13.20 PM (connection detail); subsequent confirmed choice “Multiple named connections; one active.” The original temporary attachment paths have expired; no pixel-perfect comp match is claimed. This follows new-work.md §3 “Extend an existing surface” and its explicit instruction “Never run the script for a local extension or a precisely specified narrow request; shape those directly.” Therefore no concept roll was attempted or required, and no unavailable-roll receipt is invented.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Constraints

One active relay; encrypted write-only credentials; no automatic sending. Delivery-log deletion is disabled by default and requires an explicit installation email administrator policy and acknowledgement; only a separately commissioned hourly maintenance timer may prune eligible complete resend chains. Keep existing active configuration during adoption. Malaysia clock comes from the installed country pack; ambiguous/no clock uses explicit UTC. Preserve authorization, protected historical attempts, accounts, invitation records and security audit events. Previews use the common template with nonfunctional placeholders, and do not claim to be historical originals. Resend requires explicit acknowledgement and creates a new single-use link. Verify desktop/mobile in the existing themes and six locales; hosted checks only.
