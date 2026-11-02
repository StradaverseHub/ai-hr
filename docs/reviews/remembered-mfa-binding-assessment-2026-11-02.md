# Remembered-device MFA — source binding assessment

Status: review/preparation only. This document records no human AI approval, release acceptance or installation authority.

The LOGIN owner requested configurable repeated MFA and confirmed30days by default on both web and mobile. Auth implementation was frozen at11ebf7fcc50ff0285df0505b17d45dd2a6378d4a on `codex/remembered-mfa-20261102`, based on accepted main/alpha6ea88936539c361a17a6f802c5b1e7bcc4ce1e39. Subsequent invitation-fixture/document corrections do not change these auth-source bytes. The frozen Editorial member32c690dfe remains separate and unchanged.

The unchanged canonical provider source generator computes:

- Existing generated/literal approval digest: `2ee27ebb5026e363ca31a2c7523cf42b15a57b13c2c6e55e1ca0720bb7f50da2`,1158files.
- This MFA implementation source digest: `dc0d68e85c6e8ac3810db6fb2dc0c3c11c735e8668a4eaa5bb237c1499262e6b`,1160files.
- Changed existing reviewed inputs: `lib/internal-auth/config.ts` and `lib/internal-auth/service.ts`.
- Added reviewed dependencies: `lib/internal-auth/remembered-mfa.ts` and `lib/remembered-mfa-policy.ts`.
- Module-agent canonical check remains `ad8874a425084aac18256dfad336bd30d54739346397c6258cbb2417ff4abf12`,456files, before any separately authorized literal approval change.

The feature adds server-side remembered-factor validation after the current password, exact active credential/principal and password-policy checks. A proof cannot authorize HR access, substitute for the password, alter tenant/user identity, register a new authenticator without TOTP, or satisfy password recovery. It is bound to tenant, subject, credential version, browser/native mode, absolute factor time and tenant policy revision. Existing session/idle lifetimes remain unchanged. The new tenant-admin control is audited and uses the existing encrypted auth record store; it is not registered as a new AI tool or provider data contract. No shared message catalog, provider/data policy, scope, registry, literal review record, allowlist, generator exclusion or applied migration is changed.

All24previously approved provider contracts and both pending contracts remain byte-for-byte in their existing review state. The feature request is not an implicit approval to renew those records at a different source digest. Neither a generated manifest refresh nor focused tests can perform that renewal. The two pending contracts must remain pending.

For the coordinated release, integrate/review the actual accepted Noveri baseline plus the agreed compatible members first. Recompute BOTH canonical manifests and review the exact final source/file delta and existing authorization records. Do not ask the owner to approve this provisional member digest merely to discard it in a later aggregate. If the actual final binding refresh needs approval, present that exact reviewable candidate/digest and unchanged/changed scope once. Apply approved literal records before generating the dependent module-agent manifest; independently check both afterward. Preserve previous approvals and original failure identities without relabelling.

Verification is tracked by the original hosted runs and focused reports. The first run41449891209 retained51passing Node/DOM/transport checks, passing native typecheck and45passing DB checks; two preexisting invitation cases and the root compiler failed because a test edit referenced an undefined optional variable. That fixture-only correction is separate from implementation. The targeted retry and production build retain their own identities. Focused evidence is development qualification only; final exact-source full release, source/build arrival, ledger/health and changed rendered acceptance remain required under the existing coordinated queue policy. No production/package/store deployment or human staging acceptance is authorized here.
