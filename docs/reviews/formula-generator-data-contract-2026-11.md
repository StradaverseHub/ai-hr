# Formula generator data contract

## Review status

Pending human owner review. Board approval authorizes implementation, not provider egress. The runtime registry deliberately leaves `authored_pay_formula_v1` pending. No automated test, generated source digest, or this document grants approval.

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
