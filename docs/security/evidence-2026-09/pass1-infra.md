# Pass1 — Infra/Deploy/DoS agent findings (dimension: infra)
F1 HIGH  No rate limiting anywhere; SHARE_PASSWORD gate brute-forceable. middleware.ts:105-147; safeEqual constant-time :61-66. WorkOS routes rate-limited by WorkOS.
F2 MED   Owner DB URL (MIGRATION_DATABASE_URL=ai_hr_owner) loaded into web process env. deploy/aihr.service:17 EnvironmentFile; app only uses DATABASE_URL (db/client.ts:261-265). RCE/env-leak => schema control, disable RLS, re-GRANT encrypted cols.
F3 LOW-MED systemd unit lightly hardened: only NoNewPrivileges+PrivateTmp. Missing ProtectSystem/Home/Kernel*, RestrictAddressFamilies, SystemCallFilter, CapabilityBoundingSet.
F4 MED   DoS fetch-then-slice: lib/pagination.ts:124 paginateRows slices already-loaded array; 24+ pages; ALL_ROW_CEILING=2000 bounds browser only, not SQL. pool max 10, MemoryMax 1536M => OOM self-DoS by heavy tenant.
F5 LOW   Attendance dayTypesForPairs N+1 (bounded limit=60), core/attendance.ts:3855-3877; grid path ~2245 already batched.
F6 LOW-MED Missing app-layer security headers; next.config.ts no headers(). [MATCHES lead independent evidence]
F7 LOW   Owner DB URL in psql argv during deploy (ps exposure). deploy/deploy.sh:364.
SOLID: 3-role DB separation; fail-closed share gate; /health model endpoint (single-flight,1s cache,2s timeout); minimal sudoers; /login/as validates userId vs listPrincipals, httpOnly/lax, 404 outside demo; cron not user-triggerable; RLS+suspension in DB (SET TRANSACTION READ ONLY).
NOT-VERIFIED: tunnel header/rate-limit injection; prod row counts; WorkOS rate limits.
