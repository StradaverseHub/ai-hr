# Separate AI Centre presentation from provider and command authority

Status: unnumbered, uninstalled CI prototype from exact
`f1515376df082438ca025fb65d01a8a3330a8796`. Existing GET readers and command defaults
remain READ COMMITTED. No framework import, page adoption, numbered migration,
provider request, local application/compiler/runtime check or installation ran.
Freshly fetched main/alpha both remain `b7c0393aa3c7606a33dd15103426e5c535324065`;
this owned child preserves its explicitly reviewed f151 base. Production remains held.

## Existing path and preserved contracts

`aiManagementView` first reads group provider metadata through `getAiConfigView` in a
separate RC transaction, then takes the exclusive Access revocation barrier in its
main RC transaction. Resolving provider/model uses `resolveActiveAiConfig`, issuing a
WeakSet-backed provider snapshot and a governed configuration that the display does
not need. Candidate metadata and spend status correctly rely on the native RC-only
`_ai_provider_evaluation_actor_valid` predicate. Replacing the whole path with RR
without changing those dependencies would refuse; relaxing their shared predicate
would also affect evaluation, spending and commands.

The existing aiManagementView/getAiConfigView/providerCandidatesTx/aiSpendStatusTx,
all configuration commands, candidate evaluation, native admission and settlement
retain their existing RC entry points and fresh authority barriers. Their callers
are not redirected to presentation. No existing page is changed in this prototype.

New explicit aiManagementPresentationView and getAiConfigPresentationView use one
native REPEATABLE READ / READ ONLY transaction. Captured tenant/user/person/roles/
grants precede asynchronous work, and `assertAiPresentationPrincipalTx` checks their
actual carrier/login/current native snapshot. Group configuration is loaded inside
the main display snapshot with `getAiConfigPresentationTx`. The existing policy,
feature, switch attribution, company usage, user search, full attention population,
complete counts, strictest-tier priority, recent runs and legacy budget body remains
shared unchanged. Its potentially large attention population is not truncated or
claimed optimized here.

## Typed provider data without an issued capability

One private active-provider row decoder now owns the same provider/model/options,
key decryption, OpenRouter transport and gateway validation for both purposes.
The existing snapshot owner still issues its original frozen configuration,
fingerprint and WeakSet membership. The new `resolveAiProviderDisplayTx` instead
returns only a frozen {provider,model} or null; it never issues a snapshot,
fingerprint, governance object or provider capability. Plaintext configuration
exists only inside the private server decoder and does not cross this export.

A present invalid active row refuses and is displayed unavailable. Native resolver
failure does not become environment fallback. Only actual absence of an active row
can use the existing environment resolver. Candidate metadata validation and spend
count normalization are shared with the old readers; no new provider or financial
interpretation is introduced.

The current group display overlays a saved OpenRouter candidate's model while its
usable-key check resolves the actual active provider. This existing behavior is
preserved explicitly, not silently corrected. Company administrators retain only
the actual active provider/model and their authorized company aggregates; candidate
configuration, spend status, login identities and group controls remain withheld.

## Guarded native projection factoring

`test/prototypes/ai-centre-presentation.sql` checks the complete expected body and
native identity/owner/language/security/signature/argument/result/settings/volatility/
cost/support/transform/ACL metadata of the three original read wrappers and their
unchanged native RC actor. It refuses preexisting new names before creating any
helper. All installation runs in the owned fixture's transaction. The fixture first checks
the actual standard hosted context, all four loopback/role/port/exact worker URLs
and database/session identity. SQL independently requires the transaction-local
marker for that same disposable worker before any DDL; a standalone unmarked
execution refuses. This marker is not a runtime permission or production feature.

Owner-only helpers contain the exact existing candidate SELECT, complete spend
status expressions, and optional non-probe unknown-cost decorator. They introduce
no admission, advisory lock, write, provider call or new table access grant. Value
helpers retain VOLATILE statement freshness for the original RC owners; their
bodies contain only the extracted SELECT/RETURN work. New public projections require
actual RR/RO, a current human login, active/trial tenant and native group authority.
The transaction enforces read-only behavior independently of function annotations.

The old wrappers retain their native RC actor check, error behavior, owner, ACL and
other metadata. Existing currency, string nano-USD, known zero, unknown/null,
held/confirmed/breach, reviewed-record and unpriced-run populations/filters remain
identical; a reviewed record is not a live capability. No table or private helper
EXEC privilege is given to app or PUBLIC. Fixture cleanup compares the exact
created definitions before dropping only its own helpers and restores/compares all
original functions; a failed/foreign installation is not cleaned as if owned.

## Prepared proof, original owner and remaining gates

The independently frozen complete f151 management module is relocated only for
imports, SHA256 `fdd12d1bf9048ea433b45c3c6ad4abe588551340d534bae4adf36e135b786897`.
Reversing its one provenance line and import relocation reconstructs original source
SHA256 `2e2c25f9ad2685ed6072da4aaa4929604ddecb4d5a323b3acf9966ab63473a01` exactly.
The native fixture compares full DTOs and independent nonempty expectations: 55+
logins, heavy and quiet zero-capped attention beyond the visible page, blocked reason,
exact usage, company scope, search/run filters, candidate overlay, switch attribution,
held US$1.25, confirmed known zero and one independently unpriced run. Nonempty
foreign tenant budgets/reservations/runs and a separate hidden company ensure those
populations stay excluded. Synthetic global capability rows use unique owned IDs
and are cleaned only by the disposable fixture, never issued by the reader.

Thirteen prepared native cases also cover same-snapshot carrier count, minimal DTO
rejection as provider authority, zero network calls, corrupt secret and malformed
resolver projection, genuine held Access and History writers, actual read-only write
refusal, old RC command/admission barriers, fresh revoked/archived/relinked/blocked/
foreign/forged/suspended identities, captured context and atomic metadata-drift
refusal. Invalid stored options still hit their real 23514 constraint; the decoder
fault changes only the owner fixture resolver projection while retaining every
actual authority clause, then restores its full definition/metadata. No trigger or
constraint is disabled. Whole-row source/event/private-spend digests prove reads do
not issue effects. These are planned assertions, not executed evidence.

The companion 15-file focused manifest retains affected existing principal, provider,
candidate, spend, management, custody, concurrency and admission behavior suites.
Independent root/security review and standard hosted native/focused/compiler/build
qualification are required before root allocates a real additive migration and
explicit GET adoption. This prototype proves no installed speed, zero Busy,
all-module coverage, worker capacity, staging or production readiness.
