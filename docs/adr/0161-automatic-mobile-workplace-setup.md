# ADR-0161 — Automatic mobile workplace setup per customer

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

- **Date:** 2026-10-29
- **Status:** Proposed. Accepted is not merged, tested, installed or released.
- **Related:** ADR-0117 (embedded HR sign-in), ADR-0140 (operator customer workspace), ADR-0077 (entitlements and
  `tenant_setting`), ADR-0006 (domain events). Owner request: "when we set up the customer in the operator, it
  automatically runs [the signing] and saves it in the system."
- **Migration:** the setting definition is catalogue data seeded by `scripts/seed-catalogs.ts` (no migration). The
  operator console's intents and status read are `db/migrations/0000_mobile_workplace_setup_issuance.sql` — a
  placeholder number, unjournaled until the migration allocator assigns one (§2.8).

## 1. Context

The mobile app connects to a workplace through a signed setup file (`company.aihr.json`) or the HTTPS link and QR
built from it (`/login/mobile-setup#setup=…`). The app verifies the Ed25519 signature against the anchors compiled
into its binary (`mobile/connections/trust.json`) and adopts the server address and organization code only after
the employee confirms. Until now an operator signed each setup by hand with `scripts/mobile-company-profile.ts`
and a private key kept outside the repository, and nothing in the product stored or showed the result.

A setup for embedded sign-in must carry an organization code (`workplaceSetupProfile`), so a setup is **per
customer**: one installation origin, one organization code, one display name, one validity window.

## 2. Decision

1. **One current setup per customer, stored as signed public data.** The owner is one `tenant_setting` row,
   key `mobile.workplace_setup`, scope `platform`, `customerVisible: false`, value
   `{version, setup: {keyId, payload, signature} | null, method: issued | imported | null, recordedAt, failure}`.
   No credential, key, path or tenant identifier is stored. Platform scope means 0313's `tenant_setting_write`
   refuses the application role, so no customer or web path can plant a setup that routes employees elsewhere.
   The row is a cache of a signed artifact derived from facts owned elsewhere — the sign-in origin
   (`AUTH_PUBLIC_ORIGIN`) and the organization code (the internal-auth namespace index, ADR-0140) — so it is
   re-verified against those owners on every read.
2. **Issuance is automatic and runs in the owner-role provisioning runner.** Right after a customer's provisioning
   request commits `done` (the tenant and organization code now exist), the runner signs and stores that
   customer's setup. It runs outside the provisioning transaction and outside the code path that marks a request
   failed: **issuance failure never fails provisioning.** The reason code is recorded beside any previous setup
   and retried no sooner than an hour later. Each tick also runs a bounded pass (20 customers) over active
   embedded-sign-in customers that issues a missing setup, renews one inside its 30-day window, and reissues after
   this installation's sign-in origin changed. A setup that is still valid and outside that window is left alone,
   whether it was issued or imported.
3. **Key custody.** The signing key may exist **only on installations Stradaverse operates** (cloud and staging).
   It is an absolute path to a regular file outside the application directory, readable only by its owner, named by
   `AIHR_MOBILE_SETUP_SIGNING_KEY`; its public key must already be an anchor in `mobile/connections/trust.json`, or
   signing is refused. Only the provisioning runner and the offline CLI load it; no web request path reads it.
   Errors carry codes, never the path, key or payload. Customer-run on-premise servers never hold the key: they
   **import** a setup Stradaverse signed (`scripts/mobile-setup-import.ts`, built offline with the CLI `customer`
   command). Hardware or cloud KMS custody is future work behind the same signer interface.
4. **The server re-verifies before showing anything.** A setup is shown or accepted only when its signature
   verifies against the app's anchors file, it is embedded sign-in with an organization code, its `apiOrigin` is
   this installation's `AUTH_PUBLIC_ORIGIN` (the issuer is bound to it as `origin + '/auth'`, the address
   `/login/mobile-connection` publishes), its organization is the customer's own code, and it has not expired.
   The installed app remains the final judge and verifies independently.
5. **Profile fields.** `connectionVersion 1`, `apiVersion v1`, `authProvider internal`, `apiOrigin` = the
   sign-in origin, `issuer` = `apiOrigin + '/auth'`, `clientId aihr-mobile`, `audience aihr-api`, `id` = the
   organization code (stable, so a renewal keeps the app's credential namespace), `name` = the customer account
   name, `organization` = the code, `hosting` = `AIHR_MOBILE_SETUP_HOSTING` (`cloud` by default). Validity starts
   five minutes before signing — the app checks `notBefore` against the phone's clock — and lasts 365 days,
   capped at a trust anchor's `expiresAt` when an anchor ever carries one (none does today).
6. **Who sees it.** The customer's administrators (`requireAdmin`) see System Configuration › Mobile app with the
   link, QR, organization code, expiry (warning inside 30 days) and short install steps — only for their own
   tenant, only when the stored setup re-verifies now; otherwise a plain "ask your provider" message. The operator
   role does not imply customer administration (ADR-0140).
7. **Audit.** `mobile.workplace-setup.issued`, `.reissued`, `.imported` and `.issue-failed` (once per distinct
   reason) are appended to the customer's domain events with the key id, expiry, method and trigger — never the
   signed payload. An operator intent adds `.requested` with the operator as actor, and the resulting event
   carries `requestId` and `requestedBy`.
8. **Operator console (owner approval, 29 October 2026).** The customer page shows the setup status — issued /
   imported / not set up / not usable with the reason, expiry, key id, server, organization code, last failed
   attempt — and the link and QR only for a setup that re-verifies for this server and customer (the operator
   already sees each of those facts; the setup holds nothing else). Status is read through the gated definer
   `app.operator_mobile_setup`, in the shape of `app.operator_customer_data`. **Issue / Reissue** and **Import
   signed setup** record an intent through the definer `app.operator_request_mobile_setup` into
   `mobile_setup_request` (`module_change_request` shape: SELECT-only to the application role under tenant RLS,
   one open intent per customer by a partial unique index, the operator re-checked in the database, a
   `.requested` event). The provisioning runner executes one intent per tick with the code in §2.2 and §2.3; an
   explicit reissue signs even when the current setup is still valid. The web tier never loads the key: it
   reads only whether the key PATH variable is set, to explain that Issue is unavailable, and the runner refuses
   an issue intent with `key_not_configured` when it holds no key. An upload is verified in the web tier for an
   immediate answer and again by the runner before anything is stored.

## 3. Not decided here / deferred

- The migration number, journal position and its rehearsal belong to the integrator (§2.8).
- Revocation remains bounded lifetimes plus anchor removal in a new app release (mobile/README.md).
- KMS/HSM custody; production signing anchors distinct from the current test anchor.

## 4. Consequences

- A signing installation needs the key file, the environment variable and `scripts/seed-catalogs.ts` (already part
  of `deploy.sh`) before the first issuance. Without the variable nothing is issued and nothing is recorded.
- The server's `mobile/connections/trust.json` must equal the anchors in the binary employees install; the server
  judges with the file it ships.
- A change of `AUTH_PUBLIC_ORIGIN` invalidates every stored setup; on a signing installation the pass reissues them
  (at most 20 per minute), and employees already connected must open the new link.
