# Handoff: native Today page and AI Centre reminders (paused 15 November 2026)

Paused at the owner's request ("Pause and save it, i will start it in a new session"). The staging release
work is on hold: do not submit, claim or deploy a staging batch until the owner says to continue.

## Scope agreed with the owner (12 November 2026)

- Reminders mirror the web Employee Today loop cards: missed clock-out confirm, auto-fixed clock-out undo,
  record gaps, passport expiry. A reminder proposes; the clock-out owner, undo owner or HR decides.
- Today becomes the native Home. Published schema-2 tenant compositions keep their own renderer.
- Two branches: the server goes on alpha through the shared staging queue; the app stays on the Codex base.

## Branches and commits

| Side | Branch | Commits | Where it is |
|---|---|---|---|
| App (Expo) | `claude/mobile-today-ai-reminders-20261112`, based on `codex/onehr-android-firebase-staging-20261109` (unmerged) | `a1fb0a559` (Today Home and reminders), `67317b451` ("already waiting" refusal), plus this handoff commit | Pushed only, not merged. The Codex branch is unchanged. |
| Server | `claude/mobile-today-server-20261112` | `f84f4c567` (merge of alpha `69e30634e`, approvals re-bound to `0d98715d…`) | Deployed to staging in batch 106 on 12 November, then carried forward: main and alpha were at `1299e6724` on 15 November, which contains `f84f4c567`, and staging ran `1299e6724` (build `DclsIg7to3z2BkPmG6SnT`). |

The contract `lib/mobile-api/v2/today.ts` is byte-identical on both branches. If it changes, change it
on both.

- **Server:** `GET /api/mobile/v2/today`, `POST /api/mobile/v2/today/clock-out` and
  `POST /api/mobile/v2/today/undo`. Code is in `core/mobile-today.ts`, `core/employee-today-reads.ts`
  and `lib/mobile-api/today-routes.ts`.
- **App:** `mobile/lib/today.tsx`, `mobile/lib/today-copy.ts` (en/ms/zh/ta/th/vi),
  `mobile/app/(tabs)/index.tsx` and `test/mobile-today.dom.test.tsx` (16 tests passing).

## Verified

- **Server gate:** full gate `alpha-staging` 43166760138 passed for `f84f4c567`.
- **Staging arrival:** checksum, installer status and owned cleanup all verified; health 200.
- **Signed-out probes on staging:** all three Today routes answer 401 `auth_required`; `/today` redirects to login.
- **App tests:** the dom tests pass, including copy completeness in all six locales.
- **Rendering:** the app renders on the iPhone 16 simulator (`5BC9060E-440B-4AF2-935A-3160C31C98B4`) and the emulator
  `emulator-5556` (AVD `Pixel_3a_Today_API_34`), up to the sign-in screen.
  - The iPhone 16 Pro and the Pixel 3a on emulator-5554 belong to another session. Don't use them.

## Not verified yet

- **Signed-in device checks:** every Today section, the clock-out confirm and undo flows, and the
  empty, loading and error states have not been checked against real staging data on either device.
  - This needs a fictional staging login and an MFA method from the owner.
  - Never use a real person's account.
  - Ask for a fresh MFA code at sign-in time.
- **Translations:** the ms, zh, ta, th and vi copy, in the app and in the web `messages/ai-centre/*.json`,
  is machine-drafted and needs native-speaker review.
- **Known gaps:**
  - A foreign `employmentId` answers 400, not 403.
  - "Coming up" fails as a whole section rather than item by item.
  - Reminders span all of the person's employments, capped at 20.
  - Two Confirms sent at the same instant can still show "unavailable" instead of "already waiting".

## Next steps

1. Confirm the staging hold is lifted before any queue action.
2. Re-fetch main and alpha, and check that staging still contains `f84f4c567`.
3. Get the fictional staging login from the owner. Workplace "AI HR staging", organisation code `aihr-test`.
4. Start the app:
   - In `mobile/`, run `npm ci` and create `.env.local` with `EXPO_PUBLIC_RUNTIME_CONNECTIONS=1` and
     `EXPO_PUBLIC_AUTH_PROVIDER=internal`.
   - Start Metro with the `mobile-today-metro` launch config.
   - Use JDK 17 (zulu-17) for Android.
5. Sign in on both devices and check each Today section, confirm and undo, and the empty and error states.
   Take screenshots (`adb emu screenrecord screenshot <dir>` on Android).
6. Fix what fails. Server fixes go on a new alpha-based branch and through the shared staging queue.
7. Ask the owner whether to open PRs: the app into the Codex branch once it merges, and any server follow-ups into alpha.
8. Clean up:
   - this guarded worktree's leftover detached copy;
   - `node_modules` and Android builds in the worktrees;
   - the controller worktree `/Users/zenlam/Projects/ai-hr-builders/controller-2a2495919-mobile-today`.

## Lesson from the release

A subagent's lease watcher claimed batch 106 just after the owner approved requeueing it behind a production
fix. The detached deploy was left to finish, and arrival was resumed from the saved installation grant.
Before giving up a place in the queue, stop every watcher that could claim. See
`docs/STAGING-RELEASE-QUEUE.md`.
