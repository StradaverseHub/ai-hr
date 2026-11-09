# Infer renderer translations from their actual namespace boundaries

Status: source candidate; ordinary hosted whole-compiler qualification pending.
This targets observed compiler work, not application loading or runtime crashes.

## Observed input and attribution

Run42387121951 compiled exacted188690f8258093391e1f6bc2c92b5bf5744816 with
Node22.23.3/TypeScript5.9.3, the unchanged12GiB heap and standard4CPU/~16GiB
runner. Its independent complete inventory passed with11245 files. The semantic
compiler exhausted V8 heap with SIGABRT after592.907s; sampled peak RSS was
12838776KiB. There was no source TypeScript diagnostic or excluded-file remedy.

Complete B/E checkSourceFile events in the retained raw trace show two avoidable
translator-inference hotspots:

| Consumer | Completed check | Expression owning the interval |
| --- | ---: | --- |
| `test/agent-build-list.test.ts` |89.294s| `createTranslator` receives the entire six-locale catalogue union and an any namespace |
| `test/home-claim-selection-page.test.ts` |18.576s| `createTranslator` receives the entire English catalogue for a Claims/Pagination namespace union |

Nearest one-second RSS samples for the Claims test increased from10487MiB to
10820MiB. These are attribution observations, not a controlled memory delta.
Many earlier queries/tests also retain checker state; neither hotspot is proven
to be the sole cause of exhaustion. TypeScript's installed createTranslator
declaration computes recursive NestedKeyOf/NamespaceKeys over its entire inferred
TranslatorMessages argument before resolving the namespace.
Static source inspection counts34669 nested object/message paths per original
locale catalogue, versus143 in the Build List namespace projection and84 in the
Claims/Pagination projection. The key structure and message values are retained;
the unrelated namespaces no longer enter these two generic factory arguments.

The sampled lastSource field was stale: raw trace events establish that the
Job Description print page completed in6.664s. The final unmatched source check
was Leave Ledger Import, after memory was already near the limit. Changing its
printed content, read DTO or business logic would not follow this evidence.

## Consumer contract

Give each affected test translator only the original message subtree its renderer
actually requests. Build List retains both processAssessment and its buildList
namespace, with an explicit literal namespace union and all six original locale
values. Claims retains its original Claims/Pagination union and those exact
English subtrees. Real createTranslator inference still checks their key shapes;
no string-record erasure, cast, ignored diagnostic or permissive translator type
is introduced. The complete English catalogue still reaches its client provider.

All six JSON imports, full catalogue integrity tests, application source, native
readers/permissions/calculations, renderer markup/styles and11245 compiler inputs
remain unchanged. The existing native Build List test still exercises native
measurements/authority and renders six locales; it additionally asserts both
namespace header/process labels. The Claims stream test retains its selected-own
employment/refusal assertions and additionally checks the actual no-types text.

## Required qualification

Run the ordinary unchanged whole compiler at12GiB against the complete project,
plus both affected test files, `test/i18n-catalogs.test.ts` and
`test/i18n-coverage.test.ts`. Root owns hosted execution and any required build.
A normal complete compiler pass must precede claiming this resolves the common
resource gap; a failure requires further attribution, not extra heap or omissions.
Retain original failures and their source/controller identities. This source has
no deployment authority; production remains held.
