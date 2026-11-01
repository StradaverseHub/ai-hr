# Runner repairs and controls: technical privacy-source review

Status: technical comparison prepared; owner authorization to rebind existing approvals pending.
This is not a human privacy approval, specialist certification, release receipt or staging acceptance.

Baseline provider source closure: 1141 files, `c9c5944d9756718e34b08826b1773339ea7430687209992efd5ab84c2aea177d`.
Prepared closure: 1143 files, `5bd1ea76f2fd1ac7610d12422b492eb2d54d0a774581ee8c0f4225803b1215f8`.

Added dependencies are `core/agent-release-interval.ts` and `core/module-agent-maintenance.ts`.
They extract the existing promotion-maintenance locking and retirement logic out of the interactive
module-agent release owner. The scheduled CLI now imports that lightweight owner without loading
interactive provider/action/UI code. The interactive owner imports the same implementation. No new
provider input is introduced by the extraction.

The other changed covered sources are `core/module-agent-releases.ts`,
`lib/ai/agent-capability-inventory.ts` and the six `messages/*.json` dictionaries. The inventory adds
`configureRunnerAction` as `handoff:platform_operator`; it grants no agent access. Dictionaries add
only the `runnerControl` namespace. Existing AI prompt/serializer/transport/spend/admission and literal
approval-validation files are unchanged. No approval status or identity has been edited.

The requested technical rebind would change only sourceDigest on the same existing approved records,
retain the original human reviewer/evidence/timestamp, and leave pending records unchanged. It admits
no new purpose, payload shape, model calculation, autonomous sensitive effect or provider endpoint.
The generated module-agent digest is `0d2e7583c928d1f38af94fe594ca9bf034399b5c20638ffed5149d1f3e6d600c`.
Any later covered-byte edit requires a fresh comparison. Exact-candidate Actions and human staging
acceptance remain separate requirements. Production replacement holidays and backups remain held.
