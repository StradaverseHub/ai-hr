# Historical email transport proposal

This proposal records the earlier approval hold. The user subsequently explicitly authorized fixing all audited gaps, including the held attachment transport. The source adapter is now implemented in `lib/internal-auth/automation-mail.ts` and `lib/shared-automation-email-content.ts`, with native materialization/start verification. The adjacent historical patch must not be applied over that implementation. Installation, real mail and release remain separately controlled.

It extends `internalAutomationMail` to resolve the immutable file/image receipts admitted by the accepted shared workflow step, through `app.automation_email_assets(deliveryId, leaseToken, installationOrigin)`. Every recipient is still the workflow's configured To/CC user, verified against the frozen user/person binding and actual private authentication credential before delivery. Linked Contract documents additionally require that recipient's frozen canonical document route. Files are never fetched by URL or filesystem path; native immutable bytes are validated against the frozen receipt. The existing OneHR sender, managed relay, size/count caps, durable start marker and uncertain-delivery policy remain authoritative.

The implementation task and all verification use fictional fixtures and a fake transport. No real email is sent during the build. The original automatic review rejected the proposed code change as potentially sensitive HR document egress; that rejection is retained here as historical evidence, followed by the later explicit fix-all authorization.

Completion requires the candidate's hosted behavior/type checks and the separate integrated review/release process.
