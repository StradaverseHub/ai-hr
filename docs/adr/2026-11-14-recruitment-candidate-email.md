# Recruitment candidate e-mail

Date: 2026-11-14
Status: Accepted (owner decision D-063 in docs/recruitment-reconstruction/discrepancies.md)

## Context

AI HR sends e-mail only to its own users today: workflow notifications (ADR-0034) to verified, consenting employees,
account mail, attendance CC to fixed business addresses, and lifecycle v9 mail to a new hire's personal address.
ADR-0034 §2.5 and §7 keep employee notifications to a brief alert and a link, because the reader is often not the
subject and the app is the source of truth behind a sign-in.

Recruitment candidates are not users. They cannot sign in, so an "open the app" alert is useless to them, and the
e-mail is the only channel through which the company tells them about their own application. The owner decided
(2026-11-14) that candidates receive application receipts, interview invitations and reminders, rejections and
offers by e-mail.

## Decision

1. Candidate e-mail is a separate delivery path owned by the Recruitment pack, modelled on lifecycle v9 delivery:
   frozen recipient and content at queue time, a leased sweep, a private start before SMTP and a recorded finish,
   retry only for temporary relay failures, uncertain sends never replayed automatically, administrator retry with a
   possible-duplicate acknowledgement. "Sent" means the relay accepted the message.
2. The transport is the installation's embedded relay (`AUTH_PROVIDER=internal`). The From address is the
   installation's (or the tenant's bound sender profile); each company sets only a display name and a reply-to. The
   Keycloak socket service gains no candidate route; on such installations candidate e-mail is unavailable.
3. The recipient is the data subject. An e-mail may therefore state the candidate's own application facts: the job
   title, their interview's time, type and place, and, in an offer e-mail that a person reviews and sends, the offer
   fields the company marks for e-mail as entered by people. It never contains other candidates, interviewer names,
   scorecards, internal notes, rejection reasons beyond the template text, or anything computed by a model.
4. People send rejections, cancellations and offers after seeing the exact rendered e-mail. Only application
   receipts and interview reminders send automatically. Imports never send.
5. Templates are code-owned defaults in the six app languages with per-company overrides of plain text and an
   allowlisted placeholder set; values are escaped; no images, attachments, links or tracking until a later
   decision adds signed accept links.
6. Frozen bodies are purged 90 days after a final state; metadata stays. Candidate removal deletes the candidate's
   e-mails. The AI Centre sees counts only.

## Consequences

- The provider of the installation relay processes candidate personal data; the data-processing agreement that
  ADR-0034 requires for external channels must cover candidates as well before a company switches candidate e-mail
  on.
- There is no bounce handling; a wrong address shows only as "sent".
- Per-company sender identity is new and limited to display name and reply-to; a company-specific From address needs
  its own decision.
