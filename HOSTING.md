# Hosting AI HR from your laptop (for testing)

A quick way to let HR consultants try the app over the internet, served from your Mac. This is for
**testing on demo data only** — see the safety notes at the bottom.

> **Scope: demo hosting, not customer sign-in.** This guide deliberately uses the demo identity
> switcher behind a shared `SHARE_PASSWORD` gate. Anyone admitted can switch between seeded demo roles;
> the shared password does not authenticate individual employees.
>
> Embedded HR login, MFA and recovery are implemented. For customer installations, follow
> [customer deployment](deploy/CUSTOMER.md), [embedded authentication](deploy/internal-auth/README.md)
> and [ADR-0117](docs/adr/0117-embedded-hr-authentication.md). Implementation does not establish that
> authentication is activated or accepted on a particular installation.

---

## One-time setup

1. **Pick a password.** Add two lines to **`.env.local`** (this file is git-ignored):

   ```
   SHARE_PASSWORD=choose-a-strong-password
   ALLOW_DEMO_SESSION=true
   ```

   - Use a separate demo-only environment with `AUTH_PROVIDER` unset. Preserve customer authentication
     settings on their own installation; this guide is not an authentication cutover procedure.
   - `SHARE_PASSWORD` turns on the demo access gate (`middleware.ts`).
   - `ALLOW_DEMO_SESSION=true` lets the production build run the demo identity (it's blocked otherwise).

2. **Install a tunnel.** Two options — which one works depends on your network (see the note below):

   ```bash
   brew install cloudflared      # easiest, no account — BUT needs outbound port 7844
   brew install ngrok            # works on restrictive Wi-Fi (runs over 443); needs a free ngrok.com authtoken
   ```

   > **Network gotcha (important):** `cloudflared` quick tunnels connect over **port 7844**, which many
   > office/guest Wi-Fi networks block. If `cloudflared` just hangs and remote people can't connect
   > (while same-Wi-Fi people can), your network is blocking 7844 — switch to **ngrok**, which runs over
   > **443** (the normal HTTPS port, almost never blocked). One-time ngrok setup: sign up free at
   > ngrok.com → copy your authtoken → run `ngrok config add-authtoken <your-token>`.
   > Or: tether the laptop to a **phone hotspot** (mobile data doesn't block 7844) and `cloudflared` works as-is.

---

## Each time you want to host

**Terminal 1 — start the app (gated):**

```bash
pnpm host
```

This makes sure Postgres is up, builds the production server, and serves it on
`http://localhost:3000` (and `http://<your-LAN-ip>:3000` for anyone on the same Wi-Fi). The password
gate is on. Leave this running.

**Terminal 2 — expose it to the internet** (use the tunnel that works on your network):

```bash
ngrok http 3000                                   # recommended on office/guest Wi-Fi (runs over 443)
# or
cloudflared tunnel --url http://localhost:3000    # fine on home Wi-Fi / hotspot; needs port 7844 open
```

It prints a public `https://…` URL (`https://….ngrok-free.app` or `https://….trycloudflare.com`).
**Share that URL** — not the `localhost`/`192.168.x.x` address (those only work on the same Wi-Fi).

**Share with your consultants:** the `https://…` URL **+** the password. The browser's HTTP Basic
prompt accepts **any username** and the shared password. This demo gate does not create or sign in
an individual employee account.

When you're done, press **Ctrl-C** in both terminals.

---

## What testers can do

Inside the app, the top-bar **"act as"** switcher lets them experience every role — **HR Admin**,
**Manager**, and **Employee** — against the seeded demo company ("Demo Group"). They can also switch
language (the 文A button: English / 简体中文 / Bahasa Melayu / தமிழ் / ไทย / Tiếng Việt), take the
guided tour (the **?** button), and open the **Knowledge Base** for the built-in guides and walkthroughs.

If you want a clean slate first: `pnpm db:seed` resets the demo data.

---

## Safety notes (please read)

- **Demo data only.** This setup uses shared access and demo role switching, not individual employee
  authentication. Keep real client or employee PII out of this demo environment.
- **Protect demo access.** Use a strong shared password, share it privately, and rotate it
  (change `SHARE_PASSWORD` and restart) after the test. Don't post the URL publicly.
- **`/health` is the one path the password does NOT cover**, on purpose (readiness 1.6): an uptime monitor
  cannot hold the shared password, and most monitors read a 401 as "fine, just anonymous". Anyone who has
  the URL can poll it. It answers `{"status":"ok"}` or `{"status":"unhealthy"}` and discloses nothing else
  — no version, no host, no counts, no database error text — and `/health/anything` is still gated.
- **Your laptop is the server.** It must stay awake and online while they test (disable sleep, keep the
  terminals running). Closing the lid or losing Wi-Fi ends the session.
- The tunnel URL changes each run (with the free `cloudflared`/`ngrok` tiers). Re-share the new URL when
  you restart.
- This is a temporary demo-hosting procedure. A durable customer installation needs the reviewed
  customer deployment and embedded-authentication procedures, with TLS, owner enrollment, MFA,
  recovery and operational acceptance verified for that installation. WorkOS and Keycloak are legacy
  compatibility adapters, not the approved activation direction. See the
  [repository/environment policy](docs/REPOSITORY-AND-ENVIRONMENTS.md) for staging acceptance and
  the separate explicit production-deployment requirement.
