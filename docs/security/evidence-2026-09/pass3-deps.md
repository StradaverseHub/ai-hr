# Pass3 — dependency/supply-chain (npm/pnpm audit --prod): 2 critical, 12 high, 9 moderate
Deployed next=16.2.7 (package.json). CVEs:
- CRITICAL next <16.3.3: Unauthenticated RCE in Image Optimization; RCE on windows-hosted. (upgrade >=16.3.3)
- HIGH next <16.2.11: MIDDLEWARE/PROXY BYPASS in App Router  <-- the SHARE_PASSWORD gate IS middleware => bypass defeats the only pre-auth control. Also: DoS via Server Actions; SSRF in Server Actions; SSRF in rewrites.
- HIGH sharp <0.35.4 (libvips/libheif CVEs) — image processing.
- HIGH postcss <=8.5.17 path traversal / file read (build-time).
- HIGH nanoid <3.3.18 loop; browserslist DoS/prototype (build-time).
ACTION: upgrade Next to >=16.3.3 is the single highest-leverage fix (closes unauth RCE + middleware bypass + SSRF). Then sharp>=0.35.4. Rebuild + full gate after (Next major-minor bump touches App Router APIs per AGENTS.md).
REACHABILITY to verify (pass3 agent): is next/image optimization enabled/served? middleware matcher scope for the bypass; SSRF sinks in server actions.
