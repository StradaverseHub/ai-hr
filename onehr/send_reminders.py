"""Send the one reminder: everything waiting on each person, in the parts open now.

Runs on the server (the daily systemd timer). SAFE BY DEFAULT: with no flags it
does a DRY RUN -- it prints and logs what it *would* send, but sends nothing.

    python3 send_reminders.py                  # dry run (no emails)
    python3 send_reminders.py --auto           # the timer's job (every 15 min): sends on a day the super admin's
                                               # rules pick, once, at their "Send at" time
    python3 send_reminders.py --send           # really email everyone with something waiting, today
    python3 send_reminders.py --test-to me@co --limit 1   # one real email, redirected to one address

Each person gets ONE email listing what is still waiting on them in the parts
open now -- their own review, the 360 ratings they owe, their team, what they
lead -- built by app.reminder_items() from the dashboard's own "what needs you"
(Chris, 2026-10-10: "Reminder should work as all-in-one"). The days it goes out
are the super admin's rules on Cycle > Reminders: when a part opens, N days
before a part closes, every N days while a part is open (app.reminder_reasons).
Anyone emailed within the cooldown is skipped, so it is at most once a day.
A live run QUEUES the emails in the outbox in waves (2026-10-21: by default 200
people every 30 minutes, the super admin's setting on Cycle > Reminders), then
sends the first wave before it exits, at 30 a minute. Every --auto tick, send
day or not, sends whatever wave has come since (app._outbox_kick, inline), so
the waves keep moving with nobody on a page and after a deploy.
With --auto it also gives the leader progress email its turn (app.lp_auto): each
BU CEO's unit by department and each BG CEO's group by business unit, on the
super admin's own schedule on Cycle > Reminders > Leader progress. Right after it,
app.bga_auto gives each BG admin their group's daily status (own rules, same page). Then app.ready_auto
tells each HOD, BU CEO and Calibrator, once, that the tier below them has finished (own rules, same page).
Then app.email_own_auto gives each of the super admin's own emails (Email › Schedule, Add an email) its turn: the ones that go today, once,
at their time, in waves, unless a skip 'own:<id>' holds one back.
Every attempt is logged to the notifications table, and the run's totals to
the activity log ('reminder_run', the page's Sent list). Sending goes through
mailer.py (Microsoft Graph); with the GRAPH_* env vars unset, a live run fails
fast with a clear message while the dry run still works.
"""
import argparse
import sys
import traceback

import app as appmod
import mailer


def main():
    ap = argparse.ArgumentParser(description="Send the one reminder email.")
    ap.add_argument("--send", action="store_true", help="actually send (default is a dry run)")
    ap.add_argument("--auto", action="store_true",
                    help="scheduled run: only send on a day the in-app rules pick")
    ap.add_argument("--test-to", metavar="EMAIL", help="redirect every email to this address")
    ap.add_argument("--limit", type=int, default=0, help="cap number of recipients (0 = no cap)")
    ap.add_argument("--rate", type=int, default=30, help="max emails per minute when sending")
    args = ap.parse_args()

    live = bool(args.send or args.test_to or args.auto)
    # The list links into the app and reads the dashboard's helpers, which build URLs: they need a request context,
    # on the public base URL so every link in the email is absolute and right.
    with appmod.app.test_request_context("/", base_url=appmod.app_base_url()):
        db = appmod.get_db()
        if live:
            # a one-shot job sends what is due before it exits: a background sender would die with it
            appmod.OUTBOX_ASYNC = False
        if args.auto:
            # AI+ Learning's check-ins follow training dates, not cycles (2026-10-22): their turn comes before the
            # no-cycle stop below, and it is a no-op where Learning is off (production keeps it dark). A failure in it
            # is logged and the run goes on, so the outbox tick and the cycle's reminders always get theirs
            # (2026-10-23, the LMS gap check).
            try:
                print(appmod.lms_auto_words(appmod.lms_auto(db)))
            except Exception:   # noqa: BLE001
                db.rollback()
                traceback.print_exc()
                print("AI+ Learning's turn failed (the error is above); the rest of the run goes on.")
            # every tick, whatever day it is, sends the emails whose wave has come (2026-10-21)
            print(outbox_tick(db))
        cyc = appmod.active_cycle(db)
        if not cyc:
            print("No active cycle — nothing to do.")
            return
        why = "Send now (from the server)" if not args.auto else ""
        parts = {"regular": True, "staff": True}   # a manual run: Everyone's reminder and Grade H staff's own, whoever has something waiting
        if args.auto:
            appmod.reminder_runner_seen(db)   # the page says how often the server checks
            # the leader progress email (BU / BG CEOs) has its own schedule (2026-10-19): its turn comes first,
            # whatever everyone's reminder's rules say. A one-shot job sends what it queues before it exits.
            print(appmod.lp_auto(db, cyc))
            # the BG admins' daily status email has its own rules (2026-10-30); a failure is logged and the rest goes on
            try:
                print(appmod.bga_auto(db, cyc))
            except Exception:   # noqa: BLE001
                db.rollback()
                traceback.print_exc()
                print("The BG admin status email's turn failed (the error is above); the rest of the run goes on.")
            # the Ready for you notices (2026-11-02): a leader told once when the tier below has finished; same rule, a failure
            # is logged and the run goes on
            try:
                print(appmod.ready_auto(db, cyc))
            except Exception:   # noqa: BLE001
                db.rollback()
                traceback.print_exc()
                print("The ready notices' turn failed (the error is above); the rest of the run goes on.")
            # Grade H's own emails (2026-11-09; the Grade H switch only, not Everyone's reminder's): the ready notes at Ready for you's
            # time, then progress for HODs and BU CEOs at Everyone's reminder's time. A failure is logged and the run goes on.
            for turn, said in ((appmod.gradeh_ready_auto, "The Grade H ready notes' turn"),
                               (appmod.gradeh_prog_auto, "The Grade H progress emails' turn")):
                try:
                    print(turn(db, cyc))
                except Exception:   # noqa: BLE001
                    db.rollback()
                    traceback.print_exc()
                    print("%s failed (the error is above); the rest of the run goes on." % said)
            # Your own emails (2026-11-09, the email calendar piece C): each series the super admin wrote that goes today, once, at its
            # time, in waves; a skip 'own:<id>' holds it back. Before Everyone's reminder's early return below (a day with no reminder still
            # has its own emails). A failure is logged and the run goes on.
            try:
                print(appmod.email_own_auto(db, cyc))
            except Exception:   # noqa: BLE001
                db.rollback()
                traceback.print_exc()
                print("Your own emails' turn failed (the error is above); the rest of the run goes on.")
            # Everyone's reminder and the Grade H staff email: two tracks, each with its own switch, skip and once-a-day mark
            plan = appmod.reminder_auto_plan(db, cyc)
            for line in plan["notes"]:
                print(line)
            if not plan["regular"] and not plan["staff"]:
                return
            why = plan["why"]
            parts = {"regular": plan["regular"], "staff": plan["staff"]}
            if plan["regular"]:
                appmod.reminder_mark_sent_today(db)   # before sending: a second run today can't start another
            if plan["staff"]:
                appmod.gradeh_staff_mark_today(db)
        if live and not mailer.is_configured():
            print("ERROR: email not configured (set GRAPH_TENANT_ID / GRAPH_CLIENT_ID / "
                  "GRAPH_CLIENT_SECRET). Run with no flags for a dry run.")
            sys.exit(1)
        people = appmod.reminder_people(db)
        mode = (f"TEST->{args.test_to}" if args.test_to else "LIVE" if live else "DRY RUN")
        print(f"Cycle {cyc['name']}: checking {len(people)} people  [{mode}]")
        t = appmod.reminder_send(db, cyc, people, why or "Dry run (from the server)", live=live,
                                 test_to=args.test_to, limit=args.limit, rate=args.rate if live else 0, log=print,
                                 regular=parts["regular"], gh_staff=("day" if args.auto else "all") if parts["staff"] else None,
                                 honour_skips=bool(args.auto))
        if live:
            print(outbox_tick(db))   # the first wave, and anything a deploy left queued
        if t["queued"] or (live and not args.test_to):
            print(f"Done: {t['queued']} queued in {t['waves']} wave(s), {t['skipped']} skipped, "
                  f"{t['nothing']} with nothing waiting.")
        else:
            print(f"Done: {t['sent']} sent, {t['failed']} failed, {t['skipped']} skipped, "
                  f"{t['nothing']} with nothing waiting" + (f", {t['dry']} would be emailed (dry run)" if t["dry"]
                                                            else "."))


def outbox_tick(db):
    """Send what is due in the outbox now (inline, at 30 a minute) and say what is left."""
    appmod._outbox_kick()
    st = appmod.outbox_status(db)
    return ("Outbox: %d due now, %d waiting for their wave%s." % (
        st["due"], st["later"], (", the next at %s MYT" % st["next"]) if st["next"] else ""))


if __name__ == "__main__":
    main()
