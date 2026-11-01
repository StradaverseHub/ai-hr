# Runner repairs and controls: technical privacy-source review

Status: owner explicitly approved this technical source rebind in the runner-controls chat on 1 November 2026: “Approve this technical source rebind”.
This technical rebind is not a new privacy scope approval, specialist certification, release receipt or staging acceptance.

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

The authorized technical rebind changes only sourceDigest on the same existing approved records,
retain the original human reviewer/evidence/timestamp, and leave pending records unchanged. It admits
no new purpose, payload shape, model calculation, autonomous sensitive effect or provider endpoint.
The generated module-agent digest is `39397d272dae9db8cfd15a9da2119bc4e5c9e3b25bd1acf8b7a1206047be066a`.
Any later covered-byte edit requires a fresh comparison. Exact-candidate Actions and human staging
acceptance remain separate requirements. Production replacement holidays and backups remain held.
