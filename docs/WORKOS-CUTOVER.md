# WorkOS cutover runbook — turning on real logins

Switching a deployment from the demo identity switcher to real WorkOS auth. The application code is
complete as of **r390** (ADR-0072 plus the middleware wiring below); this is a configuration + first-login
procedure.

> **r390 corrections — read these first.**
> - **Before r390 the code was NOT complete.** authkit-nextjs 4.2.0's `withAuth()` throws unless AuthKit's
>   middleware ran on the request, and `getSignInUrl()` sets a cookie a Server Component may not set. Every
>   test mocked `lib/workos`, so neither showed. `middleware.ts` now runs AuthKit on every request when real
>   sign-in is configured (`lib/real-auth.ts`), redirects signed-out pages to AuthKit itself, and answers
>   signed-out API calls with 401. Do not cut over a build older than r390.
> - **`NEXT_PUBLIC_WORKOS_REDIRECT_URI` is inlined at BUILD time.** Setting it and restarting is not enough:
>   set it in `.env.production`, then let a deploy build (`improve:deploy` / `deploy.sh`).
> - **HTTPS is required.** WorkOS Production environments refuse `http://` redirect URIs. This deployment is
>   reached through Cloudflare (see step 1a), so no certificate is installed on the box.
> - **`SHARE_PASSWORD` can go.** `deploy.sh` and `middleware.ts` now accept EITHER the demo gate OR a complete
>   real-sign-in configuration (switcher off + all four WorkOS settings). Neither still refuses.

> **2026-10-07 — owner's decision: cut over on `sfm.stradaprop.com`.** AI HR has been public there since the
> 2026-10-06 ops round (Cloudflare proxy → nginx 443 on the box → 127.0.0.1:3000). Wherever this runbook says
> `aihr.stradaverse.ai`, read `sfm.stradaprop.com`: redirect URI `https://sfm.stradaprop.com/callback`,
> sign-out redirect `https://sfm.stradaprop.com/login`, homepage `https://sfm.stradaprop.com/`. Step 1a (the
> named tunnel) is NOT used. Instead, BEFORE real logins: install a Cloudflare Origin CA certificate on nginx
> (`~ubuntu/install-origin-cert.sh`, run with sudo; it validates the pair and restores on failure) and set the
> `stradaprop.com` zone's SSL/TLS mode to **Full (strict)** — the old origin certificate expired 2026-05-12, so
> until then the Cloudflare → box hop is encrypted but unauthenticated.
>
> State on 2026-10-07: WorkOS Production has NO redirect URIs (the WorkOS MCP still answers FORBIDDEN for
> Production redirect/logout URIs, so they are dashboard steps). `.env.production` has
> `WORKOS_COOKIE_PASSWORD` (generated on the box, never printed; original backed up beside it as
> `.env.production.bak-r394-*`); `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` and `NEXT_PUBLIC_WORKOS_REDIRECT_URI`
> are not yet set. Production has no person record for the owner: the bootstrap binds the owner's login to the
> seeded group-wide "HR Admin" person (`37c34b0e-93ee-4eef-a8df-b51c9364beb1`, app_user `22222222-…`), which is
> then renamed in Personnel.

## 1a. HTTPS for aihr.stradaverse.ai (this deployment)

The box (LAN `10.20.30.20`, NAT `203.142.6.241`) has no public port 80, and its public 443 belongs to the
`sfm.stradaprop.com` site on the same nginx — do not touch that file. AI HR is reached through a Cloudflare
tunnel instead; until r390 that was a *quick* tunnel (`cloudflared-aihr.service`, a random
`*.trycloudflare.com` address that changes on every restart).

1. Cloudflare dashboard, zone `stradaverse.ai`: delete the DNS-only `aihr` A record (it conflicts with the
   tunnel's CNAME).
2. Zero Trust → Networks → Tunnels → Create a tunnel (cloudflared), name `aihr`. Public hostname
   `aihr.stradaverse.ai` → Service `HTTP` → `127.0.0.1:3000`. Copy the install token.
3. On the box: `sudo cloudflared service install <token>`. It runs beside the quick tunnel, so nothing
   changes for current users. Check `https://aihr.stradaverse.ai/health`.
4. After the cutover is verified: `sudo systemctl disable --now cloudflared-aihr` (the quick tunnel).

**Read step 0 before doing anything.** The order matters: get it wrong and nobody can log in, including you.

---

## 0. The lockout, and why the order matters

Once `ALLOW_DEMO_SESSION` is unset, the login path is:

```
/login → WorkOS AuthKit → /callback → app.principal_by_subject(<real WorkOS subject>)
       → no matching app_user?  →  AuthRequiredError  →  back to /login
```

Every seeded user carries a **placeholder** subject that no real WorkOS session will ever present:

```
user_dev_admin        seed:aisyah@demo.test     seed:arjun@demo.test
seed:daniel@demo.test seed:meiling@demo.test
```

And the normal way to bind a real subject — an invitation — requires an admin who is *already logged in*
(`core/auth.ts` `inviteUser` → `assertGroupAdmin`). So there is a window where nobody can get in and
nobody can be let in.

**`scripts/auth/bootstrap-invite.ts` exists to break that cycle. Run it in step 3, BEFORE step 5.**

---

## 1. Provision WorkOS (you, in the WorkOS dashboard)

Not automatable and deliberately not scripted — it involves account creation and API keys.

1. Create/choose the WorkOS environment for this deployment.
2. Add the redirect URI: `https://<your-host>/callback` — must match exactly, including scheme and any
   trailing path. A mismatch fails at the callback with an opaque provider error. For this deployment:
   Production environment (`client_01KVVRP1CG86KEDFEMQF71Q3QJ`), `https://aihr.stradaverse.ai/callback`,
   set as default. Add the **sign-out redirect** `https://aihr.stradaverse.ai/login`: the app passes
   exactly that as `returnTo` on Log out (r390, `app/auth-actions.ts`), and WorkOS only returns the browser
   to a listed address. Set the app homepage to `https://aihr.stradaverse.ai/`.
3. Collect: **API key**, **Client ID**.
4. Generate a cookie password (32+ chars): `openssl rand -base64 32`.

## 2. Set the environment (you, on the server)

In `/opt/ai-hr/.env.production` — do not commit these:

```
WORKOS_API_KEY=sk_...
WORKOS_CLIENT_ID=client_...
WORKOS_COOKIE_PASSWORD=<32+ chars>
NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://<your-host>/callback
```

Leave `ALLOW_DEMO_SESSION=true` for now. **Deploy** (not just restart) so the build inlines the redirect
URI: `IMPROVE_SSH_HOST=203.142.6.241 pnpm improve:deploy <mainwt path>`.

Nothing changes yet — the switcher is still on. That is intentional: it lets you verify the WorkOS side
in step 4 while still having a way in.

## 3. Mint the bootstrap invitation (before you flip anything)

Pick the person who will be the first real admin. Find their person id:

```sql
select p.id, p.full_name, u.workos_user_id
  from person p join app_user u on u.person_id = p.id;
```

Then, on the server:

```bash
cd /opt/ai-hr
node --import tsx scripts/auth/bootstrap-invite.ts \
  --email you@company.com \
  --person-id <uuid> \
  --role hr_admin \
  --base-url https://<your-host>
```

It prints a one-time `/invite/<token>` URL. **Copy it now — only its hash is stored.** Valid 7 days;
re-run to mint a fresh one.

The script only writes an invitation row. The actual binding is done by `app.consume_invitation`, the
same function normal invitations use.

## 4. Claim it

1. Sign up / log in at WorkOS with **the same email** you passed above.
2. Open the printed `/invite/<token>` URL.
3. Verify the rebind:

```sql
select workos_user_id from app_user where person_id = '<uuid>';
-- expect a real user_… subject, NOT the old placeholder
```

The `app_user` id is unchanged — its person link, roles and history all survive. Only the subject moved.

## 5. Flip to real auth

Remove `ALLOW_DEMO_SESSION` (or set it to anything other than `true`) and, if the demo gate is being
retired too, `SHARE_PASSWORD`. The switcher flag is read at request time, so a restart is enough for it:

```bash
sudo systemctl restart aihr
```

(Removing `SHARE_PASSWORD` is safe only with all four WorkOS settings present; the next `deploy.sh` and the
middleware both check, and refuse rather than serve open.)

Confirm the switcher is gone and `/login` redirects to WorkOS. You should still be signed in from step 4.

## 6. Invite everyone else — normally

From **Admin → Users** in the app. Invite each remaining person **by their person record**, so their
existing `app_user` is rebound rather than a duplicate identity being created.

> Inviting an existing person was broken from migration 0151 until **0281** — `app.consume_invitation`
> had an ambiguous `tenant_id` reference that only surfaced on that branch, and no test covered it.
> Make sure the deployment includes 0281 or this step fails.

## 6b. Consultants who test as employees (this deployment)

On the demo, consultants (Irwin, Ely, …) tested employee and manager screens by switching to Arjun or Daniel.
Real sign-in ends switching: each person is only themselves. The owner's decision (2026-10-06) is that each
consultant gets their OWN employment in a demo company (and reporting lines where they test manager screens),
so they see My Leave, My Team and Feedback as themselves and every ticket is attributed to them. Their
`app_user` / person rows already exist (with placeholder `@demo.test` emails); invite them by person record
with their real email, and attach the employment to that SAME person, never a new one.

## Rollback

If anything goes wrong before or during step 5, set `ALLOW_DEMO_SESSION=true` and restart. The switcher
comes back immediately and no data is affected — the flag is read at request time, not baked into the build.

Once real users are bound, rolling back is still safe: their real subjects stay bound and keep working
when you flip forward again.

## Notes

- `tenant.workos_org_id` is `org_dev` on the demo — a placeholder. It is not currently used to resolve a
  session (the subject is), so it does not block cutover, but set it to the real WorkOS organization id
  before relying on org-scoped features.
- `SHARE_PASSWORD` (the demo gate): the owner's decision (2026-10-06) is to REMOVE it once real logins work.
  While both are set, the browser password prompt comes first and WorkOS second (r390 middleware). Remove it
  only after step 5 is confirmed; middleware and `deploy.sh` both refuse to serve or deploy with neither.
- What a person sees when sign-in works at WorkOS but not in AI HR (r390): an email with no AI HR account
  linked (never invited, archived, a leaver) lands on /login, which names the email and offers **Sign out**
  so they can use another account. It does not loop. The attempt is audited as `app-user.login-blocked`.
- A callback that cannot complete (a reused or stale link, or the sign-in started in a different browser so
  its verifier cookie is missing) shows "Sign-in could not be completed" with a **Try again** link, not a
  500. The server log keeps the SDK's `[AuthKit callback error]` line with the cause.
- The edge middleware reads `ALLOW_DEMO_SESSION`, `SHARE_PASSWORD` and the three secret WorkOS settings from
  the server's environment at start-up (verified in the compiled middleware, r390), so a restart applies
  them. `NEXT_PUBLIC_WORKOS_REDIRECT_URI` is compiled IN: changing it needs a deploy, not a restart.
- Login, logout, failed login, invitation and password-reset events all land in the audit trail via the
  `app.append_auth_event` writer, and are visible under Admin → Audit.
