# WorkOS cutover runbook — turning on real logins

Switching a deployment from the demo identity switcher to real WorkOS auth. The application code is
complete (ADR-0072); this is a configuration + first-login procedure.

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
   trailing path. A mismatch fails at the callback with an opaque provider error.
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

Leave `ALLOW_DEMO_SESSION=true` for now. Restart so the vars load:
`sudo systemctl restart aihr`

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

Remove `ALLOW_DEMO_SESSION` (or set it to anything other than `true`) and restart:

```bash
sudo systemctl restart aihr
```

Confirm the switcher is gone and `/login` redirects to WorkOS. You should still be signed in from step 4.

## 6. Invite everyone else — normally

From **Admin → Users** in the app. Invite each remaining person **by their person record**, so their
existing `app_user` is rebound rather than a duplicate identity being created.

> Inviting an existing person was broken from migration 0151 until **0277** — `app.consume_invitation`
> had an ambiguous `tenant_id` reference that only surfaced on that branch, and no test covered it.
> Make sure the deployment includes 0277 or this step fails.

## Rollback

If anything goes wrong before or during step 5, set `ALLOW_DEMO_SESSION=true` and restart. The switcher
comes back immediately and no data is affected — the flag is read at request time, not baked into the build.

Once real users are bound, rolling back is still safe: their real subjects stay bound and keep working
when you flip forward again.

## Notes

- `tenant.workos_org_id` is `org_dev` on the demo — a placeholder. It is not currently used to resolve a
  session (the subject is), so it does not block cutover, but set it to the real WorkOS organization id
  before relying on org-scoped features.
- `SHARE_PASSWORD` (the demo gate) is independent of all this. Decide separately whether to keep it once
  real logins are on; keeping both means two prompts.
- Login, logout, failed login, invitation and password-reset events all land in the audit trail via the
  `app.append_auth_event` writer, and are visible under Admin → Audit.
