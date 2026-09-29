# Independent dynamic evidence — collected by lead, pass 1 (localhost:3199, dev mode)
Target: frozen worktree redteam-sec @ main c8a3b77c, scratch DB ai_hr_redteam.

- VERIFIED (env-independent): No app-layer security headers. `curl -D-` on / returns only `Cache-Control`.
  Missing: Strict-Transport-Security, Content-Security-Policy, X-Frame-Options, X-Content-Type-Options,
  Referrer-Policy, Permissions-Policy. => clickjacking, MIME-sniff, no HSTS. Fix at proxy AND next.config headers().
- SOLID: /health returns {"status":"ok"} unauth, cache-control no-store, no version/host/counts leaked.
- INCONCLUSIVE in dev: SHARE_PASSWORD gate + rate limiting. `next dev` sets NODE_ENV=development, and
  middleware.ts gates only when NODE_ENV !== 'development'. So 200-on-wrong-password here is expected dev
  behaviour, NOT a prod finding. Gate prod behaviour judged from middleware.ts code + share-gate.test.ts.
- NOTE: dev server also has ALLOW_DEMO_SESSION=true (the "act as" switcher) — expected for a demo box,
  must be absent on a customer deployment (readiness 1.3).

## LEAD VERIFIED — A1 forged dev_user cookie = identity assumption (seeded DB, dev mode)
Method: curl /me with Cookie: dev_user=<uuid>, no /login/as, no gate (dev).
- dev_user=98b8e732 (Aisyah, Executive Finance) => /me renders "EMP-0001 · Aisyah Rahman · Executive, Finance"
- dev_user=18e25915 (Priya, Group CFO)          => /me renders "EMP-0008 · Priya Devan · Group CFO, Group Office"
- dev_user=22222222 (HR Admin)                   => HR Admin view
- dev_user=00000000 (non-user)                   => 200 (self-heal fallback)
CONCLUSION: cookie value ALONE selects identity; unsigned; read path does not re-validate vs allowlist;
/login/as validation is bypassable by setting the header directly. Confirms A1 mechanism. Privilege
escalation Executive->CFO->Admin demonstrated within tenant. Cross-tenant unproven here (seed has only
Demo Group real users) but app.principal(uuid) has NO tenant filter (0012) so cross-tenant follows.
SEVERITY GATE: exploitable in prod IFF ALLOW_DEMO_SESSION=true OR NODE_ENV unset (lib/demo-mode.ts:14).
