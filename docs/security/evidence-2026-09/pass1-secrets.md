# Pass1 — Secrets/Crypto/Config agent findings (dimension: secrets)
S1 HIGH  Audit hash chain UNKEYED SHA-256 => forgeable by any DB-write actor (owner/superuser/platform/backup). db/migrations/0074_audit_hash_chain.sql:14-45; core/audit-chain.ts:112. Verifier uses same fn. Fix: HMAC key outside PG / external WORM anchor.
S2 HIGH  PII vault sealForSubject/unsealForSubject UNUSED in prod => NRIC/bank/passport PLAINTEXT at rest. core/pii-vault.ts:46,75; lib/pii/vault.ts; core/pdpa.ts erase = column NULLing (not crypto-shred, recoverable from backups). Fix: wire vault + KMS before real PII.
S3 MED   DB role passwords in psql argv (-v) at bootstrap => ps + /var/log/auth.log leak. deploy/bootstrap-db.sql:3-8,37-52; provision-platform-role.sh already fixes platform via stdin. [matches infra F7 family]
S4 MED   No app-layer security headers (HSTS/CSP/X-Frame/Referrer); only per-file-route nosniff. next.config.ts. [CONFIRMS lead evidence + infra F6 — 3x corroboration]
S5 LOW-MED PII vault master key = same AI_CONFIG_SECRET scrypt key; fixed APP_SALT; 16-char floor. lib/pii/vault.ts:14-45; lib/ai/crypto.ts:32-37. Latent while S2 keeps vault unused.
INFO: .env.local SHARE_PASSWORD not committed (.gitignore .env*, not in history). Rotate after demo.
SOLID: AES-256-GCM for AI secrets (random 12B IV, 16B tag, scrypt N=2^15, tenant AAD, fail-closed); pii-vault primitives sound; no Math.random; randomUUID; no secrets in URLs/logs; ai_config ciphertext never selected by UI; domain_event append-only for app role; share gate fail-closed.
