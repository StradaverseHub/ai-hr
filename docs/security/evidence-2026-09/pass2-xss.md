# Pass2 verify — stored XSS (U1/U2/U3). Live header repro (benign rows inserted+deleted).
Observed (dev_user=HR Admin, ?inline=1, mime=text/html body <b>xss-probe</b>):
- LEAVE /me/leave/attachment/<id>?inline=1 => 200 content-type text/html; disposition inline; NO nosniff; NO CSP; body verbatim.
- FEEDBACK /feedback/attachment/<id>?inline=1 => 200 text/html inline; NO nosniff; NO CSP.
- KB /knowledge-base/<id>/download?inline=1 (file kind) => 200 text/html inline; NO nosniff; NO CSP.
Refutation FAILED: NO CSP anywhere (next.config.ts no headers()); no WAF/proxy; cookie flags don't help (executes in-origin under victim session).
U1 LEAVE: CONFIRMED HIGH. Upload trusts file.type (app/me/actions.ts), no magic bytes; validateLeaveDocument core/leave.ts:1266 null/empty allowedMimeTypes => ANY type. Approver opens ?inline=1 (approvals/page.tsx:600) => XSS as approver/HR.
U2 FEEDBACK: CONFIRMED HIGH (worst — any employee -> owner/triager). core/feedback.ts addFeedbackAttachment size-only; app/feedback/[id]/page.tsx:299 target=_blank ?inline=1.
U3 KB: CONFIRMED but MED=>LOW (planter must be KB author/admin; tenant-scoped; admin->member or self-XSS).
FIX (load-bearing = inline allowlist, not nosniff alone, since content-type honestly text/html): copy app/admin/personnel/[employmentId]/document/[docId]/route.ts pattern: INLINE_SAFE={pdf,jpeg,png}; disposition = inline only if safe else attachment; + X-Content-Type-Options nosniff. Apply to all 3 routes. Defense-in-depth: global CSP frame-ancestors none + object-src none; magic-byte sniff on upload. 4 routes already do it right (personnel-doc, claims, photo, logo, payslip-pdf).
