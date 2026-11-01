# Staging chat repair — 31 October 2026

Package: Assistant, dashboard and floating chat; source-free general help. Production is outside scope.

## Confirmed failures

Live browser acceptance on staging source `7c57d5f64cf81f60573ede28183803ff069b475a`, build
`X2fb4uXUiuD9-Yz_aczaH` (installation identity independently verified by the release owner), found:

- Assistant preserved two turns and showed Thinking, but both a simple capabilities question and a
  follow-up asking for an explanation returned the same module clarification menu.
- Dashboard and floating chat showed Thinking, then failed the entire page with digest `3798364397`.
- The release owner's bounded, sanitized journal matched that digest twice to a missing
  `conversation-clarification.tsx#ConversationClarification` React Client Manifest reference.

Private original browser findings and sanitized exception evidence remain with the source/release owners.
No credentials, raw provider request bodies or personal source values were captured as acceptance evidence.

## Repair and source review

Source checkpoint `204471e9997179c09ba711bca3f98345ce9e9b8f` is isolated on the exact installed baseline.
The root server layout directly renders the shared `chat-reply-boundary.tsx` client entry. Both chat hosts
use its context provider; server-produced replies name its clarification and proposal wrappers. This gives
host routes an explicit reference to the same client entry used by returned controls, while retaining
existing authorization, human review, native commands and revalidation. The change is based on the
[Next.js server/client composition model](https://nextjs.org/docs/app/getting-started/server-and-client-components).

General help uses a complete local clause allowlist and predefined copy in six locales. It describes
how to interact, without claiming installed capabilities or reading records. Unknown or mixed requests
cannot acquire a source read or provider disclosure through this grammar. A complete standalone help
reply can leave an owned clarification before the original request's intent is considered. Existing
bare-module and unknown-subject protections remain. The fixed provider system strings are unchanged.

Independent source review identified and resolved two draft issues: a nested client import alone did not
establish a host manifest reference, and the clarification owner originally discarded source-free help.
The final review found no remaining material source-level issue. It is not an executed build or live PASS.

## Exact-source privacy review boundary

The static privacy closure retains the same 997 members as the installed baseline. Exactly eight covered
files change: `lib/ai/assistant-answer-plan.ts`, `lib/ai/provider-assistant-policy.ts` and the six message JSONs.
The other 989 covered source files are byte-identical to that baseline.

New transform digest: `dde5c319e2f3e32792eb2d95d5a6925442856cad3a8e3742383ef60b4facb3f2`.
The generated manifest alone does not renew approval. The 24 literal active approval records remain
unchanged and stale/fail-closed pending exact-source technical disposition and authorized binding.
Both legacy pending records, original human identity, evidence and review time must remain unchanged.
This review does not certify anonymity or authorize new raw disclosure or sensitive AI effects.

## Verification and remaining work

- Tests-only reproduction checkpoint: `fe33ff6f238ac52d1747853d6f5b0b0b8c1d0dc5`.
- Original focused run: [41165728129](https://github.com/StradaverseHub/ai-hr/actions/runs/41165728129).
  Preserve its exact candidate/controller and final results. It is not release evidence for the repair.
- New coverage includes actual owned clarification continuation, help without tool/provider calls,
  mixed-request refusal, six-locale rendering and exact shared-entry callback/pending behavior.
- Run affected checks, whole-repository typecheck, broad privacy/egress/analysis checks and a production
  build on GitHub after the source/review binding is settled. No local application checks were run.
- Inspect production manifests for `/`, `/assistant` and one floating-chat host. Then test unknown prose
  that still renders clarification; a help-only smoke bypasses the originally crashing control.
- Repeat all three live chat journeys, follow-ups, Thinking, scroll/focus and floating close/reopen after
  the release owner installs and verifies the exact repair source/build through the existing queue.
- Test masking across analysis domains using exact-source final-serializer/transport canaries. A UI notice,
  a useful reply or usage receipt does not prove the live outbound body was masked. Retain that observation
  gap if no separately reviewed credential-free witness exists. Do not log raw HR payloads or headers.

The current main/alpha histories are substantially ahead of the installed baseline. The existing aggregate
owner must reconcile this patch deliberately; this package does not authorize an unreviewed aggregate
installation, protected branch movement, package publication or production deployment.
