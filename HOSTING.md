# Hosting AI HR from your laptop (for testing)

A quick way to let HR consultants try the app over the internet, served from your Mac. This is for
**testing on demo data only** — see the safety notes at the bottom.

> **Why a password gate?** The app doesn't have real login yet (the top-bar "act as" switcher is the
> only identity). So anyone who can open the URL is effectively an admin. A shared password
> (`SHARE_PASSWORD`) sits in front of the whole app so only people you give it to can get in.

---

## One-time setup

1. **Pick a password.** Add two lines to **`.env.local`** (this file is git-ignored):

   ```
   SHARE_PASSWORD=choose-a-strong-password
   ALLOW_DEMO_SESSION=true
   ```

   - `SHARE_PASSWORD` turns on the access gate (`middleware.ts`).
   - `ALLOW_DEMO_SESSION=true` lets the production build run the demo identity (it's blocked otherwise).

2. **Install a tunnel** (one of these — `cloudflared` is the easiest, no account):

   ```bash
   brew install cloudflared      # recommended: instant HTTPS URL, no signup
   # or
   brew install ngrok            # alternative: needs a free ngrok.com account + `ngrok config add-authtoken …`
   ```

---

## Each time you want to host

**Terminal 1 — start the app (gated):**

```bash
pnpm host
```

This makes sure Postgres is up, builds the production server, and serves it on
`http://localhost:3000` (and `http://<your-LAN-ip>:3000` for anyone on the same Wi-Fi). The password
gate is on. Leave this running.

**Terminal 2 — expose it to the internet:**

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints a public `https://something.trycloudflare.com` URL. (With ngrok instead:
`ngrok http 3000`.)

**Share with your consultants:** the `https://…` URL **+** the password. When they open it the browser
asks for a login — they can type **any username** and the password.

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

- **Demo data only.** There is no real authentication or production hardening yet — do **not** load real
  client or employee PII into a hosted instance.
- **The password is the only thing protecting it.** Use a strong one, share it privately, and rotate it
  (change `SHARE_PASSWORD` and restart) after the test. Don't post the URL publicly.
- **Your laptop is the server.** It must stay awake and online while they test (disable sleep, keep the
  terminals running). Closing the lid or losing Wi-Fi ends the session.
- The tunnel URL changes each run (with the free `cloudflared`/`ngrok` tiers). Re-share the new URL when
  you restart.
- This is a stop-gap for testing. The real fix for a durable, multi-user deployment is wiring proper auth
  (WorkOS, already designed for) and deploying to a host with managed Postgres.
