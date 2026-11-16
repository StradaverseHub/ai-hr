# Pending email transport approval

The adjacent patch is a review proposal only. It has not been applied to the private SMTP sender.

It extends `internalAutomationMail` to resolve the immutable file/image receipts admitted by the accepted shared workflow step, through `app.automation_email_assets(deliveryId, leaseToken, installationOrigin)`. Every recipient is still the workflow's configured To/CC user, verified against the frozen user/person binding and actual private authentication credential before delivery. Linked Contract documents additionally require that recipient's frozen canonical document route. Files are never fetched by URL or filesystem path; native immutable bytes are validated against the frozen receipt. The existing OneHR sender, managed relay, size/count caps, durable start marker and uncertain-delivery policy remain authoritative.

The implementation task and all verification use fictional fixtures and a fake transport. No real email is sent during the build. Enabling this path for configured live workflow recipients requires the user's explicit approval after automatic review rejected the code change as potentially sensitive HR document egress.

The proposal still requires focused sender tests and integrated type verification after approval. The exact unified diff uses zero context to avoid whitespace-only review lines; apply it with the corresponding zero-context option only after approval, reconciling any later consolidated type changes.
