# Mobile native approvals: proposed source binding

This is a technical source review packet. Human approval of the binding refresh is pending. The literal approval registry is unchanged, and no server installation is authorized by this document.

The mobile server update adds authorized in-app review/decision workspaces for the existing approval types. Three new POST entry points are classified as internal clients of the existing services; this does not register AI agent actions or grant an agent decision authority. Shared decision owners gain transaction reuse and locks so a mobile receipt commits with the existing canonical decision. Native mobile projections preserve current assignment, permissions, field policy and senior-pay redaction.

No provider serializer, protected contract descriptor, prompt, transport, model, spending rule or approval-validation implementation changes. No raw employee data variant, autonomous employment decision or model calculation of money is added.

The existing 24 approved protected-input contracts need their source fingerprint rebound to the reviewed bytes. Status, reviewer, evidence anchor and the original human review timestamp remain unchanged. Both currently pending contracts remain byte-identical and blocked.

| Binding | Value |
| --- | --- |
| Baseline source | `e1585acbaa440ff084f64d03d9dc8f83c201df7b` |
| Previous digest / files | `c9c5944d9756718e34b08826b1773339ea7430687209992efd5ab84c2aea177d` / 1141 |
| Proposed digest / files | `1988479aa817a581a016138b3fb09e989159856edb17955d4c67aeca35f5b586` / 1149 |

Changed covered files:

- `core/performance.ts`
- `lib/ai/agent-capability-inventory.ts`
- `packs/performance/onehr/service.ts`
- `packs/performance/service.ts`
- `packs/rewards/service.ts`

Added covered files:

- `lib/mobile-api/pack-form.ts`
- `lib/mobile-api/v2/claims.ts`
- `lib/mobile-api/v2/common.ts`
- `lib/mobile-api/v2/pack-workspaces.ts`
- `lib/mobile-api/v2/pay.ts`
- `lib/mobile-api/v2/tasks.ts`
- `packs/performance/mobile-review.ts`
- `packs/rewards/mobile-review-projection.ts`

Removed covered files: 0. Every other common covered file is byte-identical.

The first full server run 41334172252 is retained as failed. Its original failures include the capability inventory, generated source manifest, the mobile-route formatting guard and a lifecycle fixture under baseline investigation. Focused route/RLS/receipt and compiler/build evidence at f12a601d1 passed; that is separate from release acceptance. Do not update literal approvals or deploy while the required binding review is pending.
