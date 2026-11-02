# Formula generator data contract

## Review status

The repository owner explicitly approved this disclosure on3November2026MYT against reviewed code
`90d737e288e5b59848c645a92e81ddba65a86514` and provider digest
`cf1ee5ad5e2e0a7073d310c6c5ca3797e46645aeb29dfc9fe40b771873407349`.
See [the actual decision record](ai-provider-owner-approval-2026-10.md#board-nine-source-binding)
and [exact review packet](board-nine-source-binding-2026-11.md). The source-owned registry records
that decision; a generated digest or automated test alone grants no approval. Deployment, authenticated
acceptance and agent promotion remain separate. Changed covered source invalidates this binding.

Current same-purpose technical source renewal after the causal repairs is recorded in
[the repair binding](board-nine-repair-source-binding-2026-11.md); it adds no outgoing fields or purpose.

## Exact outgoing content

The new contract serves the existing `pay_rule_draft` AI feature, through the current tenant configuration, gateway, budgets and provider authorization. Its only native input is a trimmed user-authored requirement of 1–4,000 characters and an explicit disclosure acceptance. Extra input keys are refused.

The provider receives that requirement together with code-owned function signatures, supported field names and the fixed grammar/safety instructions in `lib/pay-formula-ai.ts`. It does not receive the current editor contents, a tenant-private pay-item catalogue, an employee selection, fetched employee/payroll records, or credentials in the prompt. The configured provider connection still uses its normal authenticated transport.

This differs from the older closed pay-rule intent contract: user free text leaves the app. A user could enter personal or confidential information into that text. The interface discloses transmission, asks for consent and instructs users to use fictional information. The server cannot promise that manually entered text contains no personal information.

## Returned content and local authority

The reply is bounded JSON containing proposed source, advisory explanation, questions and unsupported requirements. Unknown properties, malformed responses and unsupported formula language are refused. Questions or unsupported requirements suppress applicable source. The existing deterministic parser, type checker and diagnostics validate source; the catalogue owner rejects fabricated references locally. Verified variable and condition listings come from the parsed source rather than model claims.

No formula, payroll, employment, activation or pay-item linking write occurs during generation. The author explicitly applies a draft, confirms replacement of existing text and separately saves through the existing owner. Activation still requires the saved revision's authorized employee test. Sample calculations use the existing deterministic evaluator with values entered by the user and are not activation evidence.

Current principal and catalogue authority are checked before configuration lookup, during provider preparation/admission and after a reply. The actual outgoing byte digest is bound to the admission. Requests have bounded output and a 30-second timeout. Changed requests and Clear fence late replies out of the UI.

## Review evidence to complete before enabling

Review the frozen aggregate diff, exact generated provider-data source digest, focused provider/admission and formula behavior results, and rendered desktop/mobile UI captures. The shared provider source closure also covers other changed files; existing literal approvals must not silently be renewed by regeneration. Record a real owner's decision and its exact reviewed source binding before enabling egress. Pending/stale records must continue to fail closed.
