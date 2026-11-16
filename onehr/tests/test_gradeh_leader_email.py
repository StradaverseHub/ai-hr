"""Grade H leader progress and the Grade H ready notes (Chris, 2026-11-09: "also add leader progress for grade H, however we just need
to cover the day it opens, 3 days before deadline and last days for HOD to calibrate and BUCEO to signoff for grade H. Also if HOD
calibrated ahead, BUCEO will receive notification that HOD had finished calibration and he can proceed to sign off. Similarly, if
employee finished acknowledgement earlier, HOD will receive notification on it"; canvas board A5; OneHR/Email calendar build brief,
piece A, sections A3 and A4).

What this suite holds (a synthetic world, ZZGM-*, in tests/gh_mail_world.py; production's Grade H calendar, 9 Nov 2026):
  * WHO: an HOD with the Grade H role and Grade H people who has not signed off both stages (H1, H2; not H3, who has), a unit's BU CEO whose
    unit is not signed off or released (B1, B2); a BU CEO seat holds no HOD role in Grade H; one entry a place
  * THE THREE DAYS, the existing lead-days machinery: the day the part first opened for them (an early opening counts: all acknowledged
    14 Nov 08:30 -> 14; after the 09:00 send -> 15; the fallback 19 Nov when not), 3 days before it closes and its last day: HOD 12, 18, 21 Nov,
    BU CEO 19, 20, 23 Nov; a leader who signed off is out, a unit signed off or released is out
  * THE OPT-OUTS (Everyone's reminder OR Leader progress), the Executive Chairman, the leader ability; no email address = logged, counted
  * ONE EMAIL, NOT TWO: a leader who gets Grade H progress (or whose ready note went) that day loses their Grade H lead lines from
    Everyone's reminder that day; the appraiser's lines stay; nothing left = no reminder; a skipped kind leaves the lines where they were
  * COUNTS ONLY: no Grade H person's name, no HOD's, no BU CEO's, in any body (the line managers' labels are the leader progress email's own)
  * THE SEND: the Grade H switch only (not Everyone's reminder's), at Everyone's reminder's time, once a day, in waves under batch
    gradeh-lp-<date>, a gradeh_lp_run row; the server's reminder job gives it its turn; the recheck drops an opted-out leader
  * THE READY NOTES: an HOD once all their people acknowledged, a BU CEO once every HOD in the unit finished both stages, once per place per
    cycle, open or later (and "ahead of" the early date), at 08:30, gated ONLY by the Grade H switch; the note served that day
  * THE GRADE H SWITCH off: none of it, and Everyone's reminder loses its Grade H lines
  * THE WORDS: four template kinds, last in the list, English, light only, placeholders checked
Every guard is FALSIFIED: patched away, the matching check fails; and put back."""
import html
import json
import os
import re
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Grade H leader progress and ready notes")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
import gh_mail_world as GW  # noqa: E402

SU, BGA, EMP = H.actors(a)
W = GW.world(a, a.DB_PATH)
db, U, P, run, utc = W.db, W.U, W.P, W.run, W.utc
_real = (a.mailer.is_configured, a._outbox_kick, a.chair_user_id, a.OUTBOX_ASYNC)
a.mailer.is_configured = lambda: True
a._outbox_kick = lambda *x, **k: False
FIRST = {"H1": "Zz Gp H1", "H2": "Zz Gp H2", "B1": "Zz Gp B1", "B2": "Zz Gp B2"}


def plan(day, n=None, **kw):
    """The day's decision (gradeh_prog_plan) with the clock at 09:30 of that Nov day: ({HODs}, {BU CEOs}) by key."""
    W.clock(day)
    d_ = a._today_myt()
    p = run(lambda d: a.gradeh_prog_plan(d, a.active_cycle(d), d_, **kw))
    inv = {v: k for k, v in U.items()}
    return {inv[e["user"]["id"]] for e in p["hod"]}, {inv[e["user"]["id"]] for e in p["buceo"]}, p


def days_of(k, kind):
    """The send days (a set of Nov dates' day numbers) of one leader, from gradeh_prog_leaders."""
    got = run(lambda d: a.gradeh_prog_leaders(d, a.active_cycle(d), kinds=(kind,)))
    inv = {v: k_ for k_, v in U.items()}
    return {inv[e["user"]["id"]]: {x.day for x in e["days"]} for e in got}.get(k)


def text(body):
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", re.sub(r"<style[\s\S]*?</style>", " ", body))).split())


def mails(day, kind):
    """[(user key, entry, subject, body)] of the day's emails of `kind`, built as the send builds them."""
    W.clock(day)
    d_ = a._today_myt()
    inv = {v: k for k, v in U.items()}

    def go(d):
        cyc = a.active_cycle(d)
        pop = a.gradeh_prog_pop(d, cyc["id"])
        pl = a.gradeh_prog_plan(d, cyc, d_, pop=pop)
        prog = a.gradeh_hod_progress(d, cyc["id"])
        out = []
        for e in pl[kind]:
            a.gradeh_prog_view(d, cyc, e, d_, pop, prog)
            sub, body = a.gradeh_prog_mail(d, e, cyc)
            out.append((inv[e["user"]["id"]], e, sub, body))
        return out
    return run(go)


def ready(day, **kw):
    W.clock(day)
    inv = {v: k for k, v in U.items()}
    out = run(lambda d: a.gradeh_ready_build(d, a.active_cycle(d), **kw))
    return {(inv[e["user"]["id"]], e["kind"]): e for e in out}


class Patch:
    """Falsify a guard: patch it away inside `with`, and put it back whatever happens."""
    def __init__(self, name, fn):
        self.name, self.fn = name, fn

    def __enter__(self):
        self.old = getattr(a, self.name)
        setattr(a, self.name, self.fn)

    def __exit__(self, *x):
        setattr(a, self.name, self.old)


try:
    # =========================================================================================================== who
    s.section("who: a Grade H HOD not signed off both stages, a unit's BU CEO whose unit is not signed off")
    hod, bu, p = plan(12)
    s.check("on 12 Nov (the HOD cell's first day) the HODs are H1 and H2, nobody else (H3 signed off both stages)", hod == {"H1", "H2"}, hod)
    s.check("...and no BU CEO yet", bu == set(), bu)
    hod, bu, p = plan(19)
    s.check("on 19 Nov the BU CEOs are B1 and B2 (a seat each), no HOD", bu == {"B1", "B2"} and hod == set(), (hod, bu))
    pop = run(lambda d: a.gradeh_prog_pop(d, W.CID))
    s.check("a BU CEO seat holds no HOD role in Grade H, so a BU CEO is in no HOD entry", U["B1"] not in pop["by_hod"] and U["B2"] not in pop["by_hod"])
    s.check("an HOD's people are the Grade H list's (X1, who is not on it, is not counted): H1 has 6, H3 2, H2 3",
            [len(pop["by_hod"][U[k]]) for k in ("H1", "H3", "H2")] == [6, 2, 3])
    s.check("one entry a place: each unit is one BU CEO entry", sorted(pop["by_unit"]) == sorted([(W.BG, W.CO), (W.BG, W.CO2)]))
    hod, bu, p = plan(12)
    inv = {v: k for k, v in U.items()}
    s.check("the HOD entry carries their people (H1: 6) and the BU CEO entry its units",
            sorted(len(e["rows"]) for e in p["hod"]) == [3, 6])

    # ======================================================================================================== the days
    s.section("the three days: the day it opens for them, 3 days before it closes, its last day (HOD 12, 18, 21; BU CEO 19, 20, 23)")
    W.clock(12)
    s.check("H1 and H2: 12, 18 and 21 Nov (the cell 12-21)", days_of("H1", "hod") == {12, 18, 21} and days_of("H2", "hod") == {12, 18, 21},
            (days_of("H1", "hod"), days_of("H2", "hod")))
    s.check("B1 and B2: 19, 20 and 23 Nov (the cell 19-23)", days_of("B1", "buceo") == {19, 20, 23} and days_of("B2", "buceo") == {19, 20, 23})
    got = {n: plan(n)[:2] for n in range(6, 31)}
    s.check("every day 6-30 Nov, the plan reaches the HODs on exactly 12, 18, 21 and the BU CEOs on exactly 19, 20, 23",
            {n for n, (h, b) in got.items() if h} == {12, 18, 21} and {n for n, (h, b) in got.items() if b} == {19, 20, 23}
            and all(h == {"H1", "H2"} for n, (h, b) in got.items() if h) and all(b == {"B1", "B2"} for n, (h, b) in got.items() if b))
    s.section("an early opening counts, and so does the fallback (the existing first-opened rule)")
    W.gsetting("gradeh_hod_fallback_at", utc(19, 0))
    W.gsetting("gradeh_bu_fallback_at", utc(22, 0))
    W.submit(["S4", "S5", "S6"], utc(10, 10))
    W.ack(["S1", "S2", "S3", "S4", "S5", "S6"], utc(14, 8, 30))
    W.clock(14)
    s.check("all of H1's people acknowledged by 14 Nov 08:30 (before the 09:00 send): H1 gets 14, 18, 21", days_of("H1", "hod") == {14, 18, 21},
            days_of("H1", "hod"))
    s.check("...H2's never all do: the fallback, 19 Nov, so 19 and 21 (18 was before it opened for them)", days_of("H2", "hod") == {19, 21},
            days_of("H2", "hod"))
    W.ack(["S1", "S2", "S3", "S4", "S5", "S6"], utc(14, 10))
    W.clock(14)
    s.check("the last acknowledgement after the send time (14 Nov 10:00): the send could not see it open, so 15, 18, 21",
            days_of("H1", "hod") == {15, 18, 21}, days_of("H1", "hod"))
    W.reset_world()
    W.gsetting("gradeh_hod_fallback_at", utc(19, 0))
    W.gsetting("gradeh_bu_fallback_at", utc(22, 0))
    s.check("a unit whose HODs never all finish: the fallback, 22 Nov, so 22 and 23", days_of("B2", "buceo") == {22, 23}, days_of("B2", "buceo"))
    W.sign("H1", "pot", utc(19, 20))
    W.sign("H1", "perf", utc(20, 8, 30))
    W.clock(20)
    s.check("unit A's last HOD signed both stages 20 Nov 08:30 (H3 had on 8 Nov): the BU CEO's sign-off opened for B1 that day, so 20 and 23",
            days_of("B1", "buceo") == {20, 23}, days_of("B1", "buceo"))
    s.check("...and H1, who has signed off both stages, is no HOD entry any more", days_of("H1", "hod") is None)
    W.reset_world()
    W.unset("gradeh_hod_fallback_at", "gradeh_bu_fallback_at")
    run(lambda d: d.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%fallback%'"))
    s.check("no fallback set = no early opening: the cell's own days again (12, 18, 21)", days_of("H1", "hod") == {12, 18, 21})

    # ==================================================================================================== signed-off, released
    s.section("a leader who has signed off is skipped; a unit signed off or released is skipped")
    W.sign("H1", "pot", utc(12, 10))
    s.check("an HOD who signed off potential only still has performance to do: still in", "H1" in plan(18)[0])
    W.sign("H1", "perf", utc(13, 10))
    s.check("...and out once both stages are signed off", "H1" not in plan(18)[0] and "H2" in plan(18)[0])
    s.check("H2, who has signed nothing, is still in on 21 Nov (the last day)", "H2" in plan(21)[0])
    W.bu_sign(W.CO, "B1")
    s.check("a unit the BU CEO signed off: B1 is out on 19 Nov, B2 (unit B) is in", plan(19)[1] == {"B2"}, plan(19)[1])
    W.reset_world()
    db.execute("INSERT INTO gradeh_releases(cycle_id, unit, released_by) VALUES (?,?,?)", (W.CID, W.CO2, U["B2"]))
    db.commit()
    s.check("a unit Group People released: B2 is out, B1 is in", plan(19)[1] == {"B1"}, plan(19)[1])
    W.reset_world()

    # ================================================================================================ opt-outs and the rest
    s.section("opt-outs (Everyone's reminder OR Leader progress), the Executive Chairman, the leader ability")
    W.optout("H2", "reminder")
    s.check("opted out of Everyone's reminder: H2 gets none, H1 still does", plan(12)[0] == {"H1"}, plan(12)[0])
    db.execute("DELETE FROM email_optouts")
    W.optout("H2", "leader_progress")
    s.check("opted out of Leader progress: none either", plan(12)[0] == {"H1"})
    db.execute("DELETE FROM email_optouts")
    W.optout("H2", "leader_progress", until="2026-11-01")
    s.check("...an opt-out that ended (until 1 Nov) no longer holds", plan(12)[0] == {"H1", "H2"})
    db.execute("DELETE FROM email_optouts")
    W.optout("B1", "reminder")
    s.check("a BU CEO opted out: B1 is out of the 19 Nov plan", plan(19)[1] == {"B2"})
    db.execute("DELETE FROM email_optouts")
    db.commit()
    a.chair_user_id = lambda db=None: U["H1"]
    s.check("the Executive Chairman rule: the seat is no recipient (here H1), the delegate-like H2 still is", plan(12)[0] == {"H2"}, plan(12)[0])
    a.chair_user_id = lambda db=None: U["B1"]
    s.check("...nor a BU CEO who is the Chairman", plan(19)[1] == {"B2"})
    a.chair_user_id = _real[2]
    db.execute("INSERT OR REPLACE INTO leader_role_access(role, ability, allowed) VALUES ('hod','hod.gradeh',0)")
    db.commit()
    s.check("the leader ability hod.gradeh switched off: no HOD gets it", plan(12)[0] == set())
    db.execute("DELETE FROM leader_role_access WHERE ability LIKE '%.gradeh'")
    db.execute("INSERT OR REPLACE INTO leader_role_access(role, ability, allowed) VALUES ('bu','bu.gradeh',0)")
    db.commit()
    s.check("...and bu.gradeh off: no BU CEO", plan(19)[1] == set())
    db.execute("DELETE FROM leader_role_access WHERE ability LIKE '%.gradeh'")
    db.commit()
    s.check("the control: abilities back, both roles are in again", plan(12)[0] == {"H1", "H2"} and plan(19)[1] == {"B1", "B2"})
    # falsify: with the opt-out reader gone, an opted-out HOD comes back
    W.optout("H2", "reminder")
    with Patch("email_optout_ids", lambda db, kind: set()):
        s.check("FALSIFIED: without the opt-out reader an opted-out HOD is mailed", plan(12)[0] == {"H1", "H2"})
    s.check("...with it put back, H2 is out again", plan(12)[0] == {"H1"})
    db.execute("DELETE FROM email_optouts")
    db.commit()

    # ====================================================================================================== one email, not two
    s.section("one email, not two: a leader who gets progress that day loses their Grade H lead lines from Everyone's reminder")
    W.rem_settings(days=(2, 1))
    W.clock(12)

    def lines(k, **kw):
        return [i["role"] for i in run(lambda d: a.reminder_items_email(d, W.urow(k), **kw)) if i["group"] == "gradeh"]
    bar = [i["role"] for i in run(lambda d: a.reminder_items(d, W.urow("H1"))) if i["group"] == "gradeh"]
    s.check("the bar (reminder_items) shows H1 their Grade H item on 12 Nov, as always", bar == ["gradeh_hod"], bar)
    s.check("Everyone's reminder leaves it out for H1: they get the progress email that day", lines("H1") == [], lines("H1"))
    s.check("...the same decision, read the other way: with progress not asked, the old three-day rule still lists it",
            lines("H1", progress=False) == ["gradeh_hod"], lines("H1", progress=False))
    with Patch("gradeh_prog_served", lambda *x, **k: {"hod": False, "buceo": False}):
        s.check("FALSIFIED: without the one-email rule H1 gets the lines AND the progress email", lines("H1") == ["gradeh_hod"], lines("H1"))
    s.check("on a day that is not their day (13 Nov) there is nothing to drop and nothing listed", (W.clock(13) or True) and lines("H1") == [])
    W.clock(19)
    W.win("gradeh_buceo", 19, 23)
    s.check("a BU CEO: on 19 Nov the bar shows the unit's sign-off, Everyone's reminder does not (progress went)",
            [i["role"] for i in run(lambda d: a.reminder_items(d, W.urow("B1"))) if i["group"] == "gradeh"] == ["gradeh_buceo"]
            and lines("B1") == [] and lines("B1", progress=False) == ["gradeh_buceo"])
    # a skip of that kind leaves the lines where they were; the ready note served
    W.clock(12)
    run(lambda d: a.email_skip_set(d, SU, "gh_lp_hod", a._today_myt(), "ZZ test: hold the HOD progress", now=datetime(2026, 11, 12, 8, 0)))
    s.check("progress skipped that day (gh_lp_hod): the leader is not served, so their lines stay in Everyone's reminder",
            lines("H1") == ["gradeh_hod"] and plan(12)[0] == set())
    db.execute("DELETE FROM email_skips")
    db.commit()
    db.execute("INSERT INTO ready_notices(cycle_id, kind, scope_key, user_id, sent_at) VALUES (?,?,?,?,?)",
               (W.CID, a.GH_READY_KIND["hod"], str(U["H1"]), U["H1"], utc(12, 8, 30)))
    db.commit()
    hod, bu, p = plan(12)
    s.check("a leader whose ready note went today (08:30) is served: the plan marks them (note_served), the send leaves them out",
            [e["note_served"] for e in p["hod"] if e["user"]["id"] == U["H1"]] == [True]
            and [e["note_served"] for e in p["hod"] if e["user"]["id"] == U["H2"]] == [False])
    s.check("...and their lead lines stay out of Everyone's reminder too (the note served)", lines("H1") == [])
    db.execute("DELETE FROM ready_notices")
    db.commit()
    # if nothing else is left for them, no reminder; an appraiser's lines stay
    db.execute("UPDATE gradeh_people SET appraiser_id=? WHERE id=?", (U["H1"], P["S4"]))
    db.commit()
    W.clock(18)
    s.check("an HOD who also appraises: on 18 Nov their appraiser line stays, the HOD line goes", lines("H1") == ["gradeh_lm"], lines("H1"))

    def queue(keys, **kw):
        def go(d):
            cyc = a.active_cycle(d)
            return a.reminder_send(d, cyc, [W.urow(k) for k in keys], "ZZGM test", live=True, **kw)
        return run(go)
    t = queue(["H1"])
    s.check("...and the reminder is queued with the appraiser's line only", t["queued"] == 1)
    body = W.outbox(a.REMINDER_KIND, "H1")[0]["body"]
    s.check("...the email names the appraisal, not the calibration", "Appraise your Grade H team" in body and "Review your Grade H people" not in body)
    db.execute("UPDATE gradeh_people SET appraiser_id=? WHERE id=?", (U["M2"], P["S4"]))
    db.execute("DELETE FROM email_outbox")
    db.commit()
    W.clock(12)
    t = queue(["H1", "H2"])
    s.check("an HOD with nothing else waiting gets NO reminder that day (both H1 and H2 are served by progress)", t["queued"] == 0 and t["nothing"] == 2, t)
    W.clock(13)
    W.reset_world()

    # =============================================================================================================== counts only
    s.section("counts only, never a name")
    ml = mails(12, "hod")
    s.check("on 12 Nov two HOD emails are built, H1's and H2's", sorted(k for k, *_ in ml) == ["H1", "H2"])
    names = [("ZZ GP " + k, "Zz Gp " + k) for k in list(P) + ["X1", "B1", "B2", "H3", "M3", "M4"]]
    h1 = next(m for m in ml if m[0] == "H1")
    h1t = text(h1[3])
    s.check("no Grade H person's, HOD's or BU CEO's name is in the HOD email (H1's own is the greeting's)",
            not any(n in h1t for pair in names for n in pair if "H1" not in n), [n for pair in names for n in pair if n in h1t])
    s.check("...the greeting is the recipient's own name", "Hi Zz Gp H1," in h1t)
    s.check("...the table is one row a line manager's team, labelled as the leader progress email labels teams",
            "Zz Gp M1's team" in h1t and "Zz Gp M2's team" in h1t and "Line manager's team" in h1t)
    s.check("...with People, Appraisal submitted and Acknowledged", all(w in h1t for w in ("People", "Appraisal submitted", "Acknowledged")))
    s.check("...then a line a stage with its close date", "Potential : not signed off yet" in h1t and "Performance : not signed off yet" in h1t
            and "closes Sat 21 Nov, 23:59" in h1t)
    sec = h1[1]["sections"][0]
    s.check("the counts are right: 6 people, 3 submitted, 1 acknowledged (S1)", [c["n"] for c in sec["total"]] == [6, 6]
            and [c["done"] for c in sec["total"]] == [3, 1] and sec["people"] == 6, sec["total"])
    s.check("the subject carries the days left and the count: 'Now open · 1 of 6 acknowledged'", h1[2] == "Grade H calibration: Now open · 1 of 6 acknowledged", h1[2])
    s.check("the email is light only, with the brand line, a button to the HOD's page and a white box for the stages",
            'name="color-scheme" content="light only"' in h1[3] and "AI+" in h1[3] and "/calibration/gradeh/hod" in h1[3]
            and 'bgcolor="#ffffff"' in h1[3] and "OneHR by Chin Hin" in h1[3])
    orig_tbl = a._gh_prog_table_html
    with Patch("_gh_prog_table_html", lambda *x, **k: orig_tbl(*x, **k) + "<p>ZZ GP S1</p>"):
        s.check("FALSIFIED: a name put into the table is caught by the same check (it would fail)", "ZZ GP S1" in text(mails(12, "hod")[0][3]))
    s.check("3 days left (18 Nov) and Last day (21 Nov) read in the subject", mails(18, "hod")[0][2].startswith("Grade H calibration: 3 days left")
            and mails(21, "hod")[0][2].startswith("Grade H calibration: Last day"), (mails(18, "hod")[0][2], mails(21, "hod")[0][2]))
    mb = mails(19, "buceo")
    b1 = next(m for m in mb if m[0] == "B1")
    b1t = text(b1[3])
    s.check("the BU CEO email: a row a department, People and HOD finished (both stages), then when sign-off closes",
            all(w in b1t for w in ("ZZGM Dept One", "ZZGM Dept Two", "Department", "People", "HOD finished (both stages)", "Sign-off closes"))
            and "Mon 23 Nov, 23:59" in b1t, b1t[:600])
    s.check("...8 people, 2 through the HOD stage (H3's), 6 not; no name but the greeting's",
            [c["n"] for c in b1[1]["sections"][0]["total"]] == [8] and b1[1]["sections"][0]["total"][0]["done"] == 2
            and not any(n in b1t for pair in names for n in pair if "B1" not in n), b1[1]["sections"][0]["total"])
    s.check("...its subject: 'Grade H sign-off: Now open · 2 of 8 people through the HOD stage'", b1[2] == "Grade H sign-off: Now open · 2 of 8 people through the HOD stage", b1[2])

    # ================================================================================================================ the send
    s.section("the send: the Grade H switch only, Everyone's reminder's time, once a day, in waves under its own batch")
    W.reset_world()
    W.rem_settings(days=(2, 1), enabled=False)   # Everyone's reminder OFF: Grade H progress follows its own switch
    W.clock(12, 8, 30)
    cyc = lambda d: a.active_cycle(d)   # noqa: E731
    s.check("before the send time: 'Not yet', nothing queued", run(lambda d: a.gradeh_prog_auto(d, cyc(d), now=a._now_myt())).startswith("Not yet")
            and not W.outbox())
    W.clock(12, 14, 0)
    s.check("more than 3 hours after it: the next send day instead", run(lambda d: a.gradeh_prog_auto(d, cyc(d), now=a._now_myt())).startswith("More than 3"))
    W.clock(12, 9, 30)
    said = run(lambda d: a.gradeh_prog_auto(d, cyc(d), now=a._now_myt()))
    rows = W.outbox(a.GH_PROG_KIND["hod"])
    s.check("at 09:30 (Everyone's reminder's switch is OFF) the two HODs are emailed: 'Grade H progress: 2 HODs, 0 BU CEOs, 2 emailed'",
            said.startswith("Grade H progress: 2 HODs, 0 BU CEOs, 2 emailed"), said)
    s.check("...one outbox row each, to their own address, kind gradeh_lp_hod", sorted(r["to_email"] for r in rows) ==
            ["zzgm-h1@zzgm.example", "zzgm-h2@zzgm.example"] and all(r["kind"] == "gradeh_lp_hod" for r in rows))
    s.check("...in waves, under the batch key gradeh-lp-<date>", all(r["batch"] == "gradeh-lp-2026-11-12" for r in rows)
            and all(r["send_after"] is not None for r in rows), [(r["batch"], r["send_after"]) for r in rows])
    s.check("...and one activity row, gradeh_lp_run, with the counts", db.execute(
        "SELECT detail FROM activity_log WHERE action='gradeh_lp_run' ORDER BY id DESC LIMIT 1").fetchone()[0].count("2 HODs") == 1)
    s.check("a second tick the same day does nothing ('Already sent today.')", run(lambda d: a.gradeh_prog_auto(d, cyc(d), now=a._now_myt())) == "Already sent today."
            and len(W.outbox(a.GH_PROG_KIND["hod"])) == 2)
    s.check("the mass-send bar (outbox_sends) does not list the batch: it is not a mass send the bar follows",
            run(lambda d: all("gradeh-lp" not in (x["batch"] or "") for x in a.outbox_sends(d))))
    W.unset("gradeh_prog_last")
    W.clock(13, 9, 30)
    s.check("a day that is nobody's: nothing is queued, and it says so", "nobody's day" in run(lambda d: a.gradeh_prog_auto(d, cyc(d), now=a._now_myt())))
    # the BU CEOs, and the time that is Everyone's reminder's, not Ready for you's
    db.execute("DELETE FROM email_outbox")
    W.unset("gradeh_prog_last")
    W.rem_settings(days=(2, 1), enabled=False, send="10:00")
    W.clock(19, 9, 30)
    s.check("the time is Everyone's reminder's own (10:00 here): 09:30 is 'Not yet'", run(lambda d: a.gradeh_prog_auto(d, cyc(d), now=a._now_myt())).startswith("Not yet: Grade H progress goes at 10:00"))
    W.clock(19, 10, 5)
    said = run(lambda d: a.gradeh_prog_auto(d, cyc(d), now=a._now_myt()))
    s.check("...and at 10:05 the two BU CEOs are emailed", said.startswith("Grade H progress: 0 HODs, 2 BU CEOs, 2 emailed")
            and len(W.outbox(a.GH_PROG_KIND["buceo"])) == 2, said)
    W.rem_settings(days=(2, 1))
    db.execute("DELETE FROM email_outbox")
    # a leader with no email address
    W.clock(12)
    db.execute("UPDATE users SET email='' WHERE id=?", (U["H2"],))
    db.commit()
    t = run(lambda d: a.gradeh_prog_send(d, cyc(d), a._today_myt(), "ZZ test", now=a._now_myt()))
    s.check("a leader with no email address is logged 'skipped' and counted, the other is emailed", t["no_email"] == 1 and t["emailed"] == 1
            and db.execute("SELECT COUNT(*) FROM notifications WHERE kind=? AND status='skipped' AND user_id=?", (a.GH_PROG_KIND["hod"], U["H2"])).fetchone()[0] == 1, t)
    db.execute("UPDATE users SET email=? WHERE id=?", ("zzgm-h2@zzgm.example", U["H2"]))
    db.execute("DELETE FROM email_outbox")
    db.execute("DELETE FROM notifications")
    db.commit()
    src = open(os.path.join(H.REPO, "send_reminders.py"), encoding="utf-8").read()
    s.check("the server's 15-minute reminder job gives it its turn (the same job, no new timer), wrapped so a failure does not stop the run",
            "appmod.gradeh_prog_auto" in src and "appmod.gradeh_ready_auto" in src and "traceback.print_exc()" in src
            and src.index("appmod.gradeh_prog_auto") < src.index("appmod.reminder_auto_plan"))
    # the job itself, end to end, with the real script
    import importlib.util
    import io
    from contextlib import redirect_stdout
    spec = importlib.util.spec_from_file_location("send_reminders_gm", os.path.join(H.REPO, "send_reminders.py"))
    sr = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sr)
    real_people = a.reminder_people
    a.reminder_people = lambda db_, me=None: []
    W.unset("gradeh_prog_last")
    W.clock(12, 9, 30)
    out = io.StringIO()
    sys.argv = ["send_reminders.py", "--auto"]
    try:
        with redirect_stdout(out):
            sr.main()
    finally:
        a.reminder_people = real_people
    s.check("--auto runs it: the HODs are queued by the job's own turn", "Grade H progress: 2 HODs" in out.getvalue()
            and len(W.outbox(a.GH_PROG_KIND["hod"])) == 2, out.getvalue()[-400:])
    W.reset_world()

    # the recheck: an opt-out after queueing drops it
    s.section("the recheck: an opt-out made after it was queued drops a Grade H progress email")
    W.clock(12)
    run(lambda d: a.gradeh_prog_send(d, cyc(d), a._today_myt(), "ZZ test", now=a._now_myt()))
    row = W.outbox(a.GH_PROG_KIND["hod"], "H1")[0]
    W.optout("H1", "reminder")
    got = run(lambda d: a._outbox_reminder_recheck(d, d.execute("SELECT * FROM email_outbox WHERE id=?", (row["id"],)).fetchone()))
    s.check("opted out of Everyone's reminder since: not sent ('cancelled'), logged", got is None and db.execute(
        "SELECT status FROM email_outbox WHERE id=?", (row["id"],)).fetchone()[0] == "cancelled")
    row2 = W.outbox(a.GH_PROG_KIND["hod"], "H2")[0]
    got2 = run(lambda d: a._outbox_reminder_recheck(d, d.execute("SELECT * FROM email_outbox WHERE id=?", (row2["id"],)).fetchone()))
    s.check("...while the other, with no opt-out, goes as it is", got2 is not None and got2["id"] == row2["id"])
    W.reset_world()

    # ============================================================================================================ ready notes
    s.section("the ready notes: an HOD once all their people acknowledged; a BU CEO once every HOD in the unit finished both stages")
    s.check("nobody ready at the start (only S1 has acknowledged)", ready(10) == {}, list(ready(10)))
    W.submit(["S4", "S5", "S6"], utc(8, 10))
    W.ack(["S1", "S2", "S3", "S4", "S5", "S6"], utc(9, 15))
    r = ready(10)
    s.check("all six of H1's people acknowledged: H1 is ready, and H2 (nobody acknowledged) is not", list(r) == [("H1", "hod")], list(r))
    e = r[("H1", "hod")]
    s.check("on 10 Nov the HOD's cell has not opened: the window is 'later', the day it opens is 12 Nov", e["win"]["mode"] == "later"
            and e["win"]["opens"].day == 12 and e["people"] == 6, e["win"])
    sub, body = run(lambda d: a.gradeh_ready_mail(d, e, a.active_cycle(d)))
    t_ = text(body)
    s.check("its words: 'All 6 of your Grade H people have acknowledged their appraisal.' and 'opens on Thu 12 Nov'",
            "All 6 of your Grade H people have acknowledged their appraisal." in t_ and "opens on Thu 12 Nov" in t_
            and "Open AI+ OneHR" in t_ and "ahead of" not in t_, t_[:500])
    s.check("...once-a-cycle line, light only, and no name (their own greeting only)", "This note goes once this cycle." in t_
            and 'content="light only"' in body and not any(n in t_ for pair in names for n in pair if "H1" not in n))
    r = ready(14)
    s.check("inside the cell with no fallback: open now, nothing 'ahead of'", r[("H1", "hod")]["win"]["mode"] == "open"
            and r[("H1", "hod")]["win"]["ahead_of"] is None)
    W.gsetting("gradeh_hod_fallback_at", utc(19, 0))
    r = ready(14)
    e = r[("H1", "hod")]
    s.check("with the fallback 19 Nov and the cell open: open now, AHEAD OF Thu 19 Nov", e["win"]["mode"] == "open" and e["win"]["ahead_of"].day == 19, e["win"])
    t_ = text(run(lambda d: a.gradeh_ready_mail(d, e, a.active_cycle(d)))[1])
    s.check("...its words: 'so your Grade H calibration is open now. That is ahead of Thu 19 Nov. It closes on Sat 21 Nov, 23:59.'",
            "open now. That is ahead of Thu 19 Nov. It closes on Sat 21 Nov, 23:59." in t_, t_[:400])
    W.ack(["S9", "S10", "S11"], utc(11, 9))
    s.check("H2's people all acknowledged: H2 is ready too", {k for k, kind in ready(14) if kind == "hod"} == {"H1", "H2"})
    W.sign("H2", "pot", utc(13, 9))
    W.sign("H2", "perf", utc(13, 10))
    hods_ready = lambda n: {k for k, kind in ready(n) if kind == "hod"}   # noqa: E731
    s.check("an HOD who signed off both stages gets none", hods_ready(14) == {"H1"}, hods_ready(14))
    s.check("an HOD whose calibration has closed (22 Nov) gets none", hods_ready(22) == set(), hods_ready(22))
    W.reset_world()
    W.submit(["S4", "S5", "S6"], utc(8, 10))
    W.ack(["S1", "S2", "S3", "S4", "S5", "S6"], utc(9, 15))
    W.gsetting("gradeh_hod_fallback_at", utc(19, 0))
    # once per place
    W.clock(14, 8, 30)
    t = run(lambda d: a.gradeh_ready_send(d, a.active_cycle(d), "ZZ test", now=a._now_myt()))
    s.check("the ready send emails the one place, writes its ready_notices row (kind gradeh_ready_hod, scope_key the HOD's id) and queues one email",
            t["emailed"] == 1 and t["hods"] == 1 and db.execute(
                "SELECT COUNT(*) FROM ready_notices WHERE kind=? AND scope_key=? AND user_id=?", (a.GH_READY_KIND["hod"], str(U["H1"]), U["H1"])).fetchone()[0] == 1
            and len(W.outbox(a.GH_READY_KIND["hod"])) == 1 and W.outbox(a.GH_READY_KIND["hod"])[0]["to_email"] == "zzgm-h1@zzgm.example", t)
    t2 = run(lambda d: a.gradeh_ready_send(d, a.active_cycle(d), "ZZ test again", now=a._now_myt()))
    s.check("once per place per cycle: the same place is never told again (not even built: places 0), nothing more is queued",
            t2["emailed"] == 0 and t2["places"] == 0 and len(W.outbox(a.GH_READY_KIND["hod"])) == 1, t2)
    db.execute("DELETE FROM ready_notices")
    db.commit()
    # BU CEO
    W.reset_world()
    W.clock(17, 9, 30)
    s.check("a BU CEO: not ready while an HOD in the unit has not finished (H1 has signed nothing)", {k for k, _ in ready(17)} - {"H1"} == set())
    W.sign("H1", "pot", utc(15, 9))
    W.sign("H1", "perf", utc(16, 9))
    rb = ready(17)
    s.check("every HOD in unit A finished both stages (H3 on 8 Nov, H1 on 16 Nov): B1 is ready, B2 (unit B) is not", ("B1", "buceo") in rb and ("B2", "buceo") not in rb, list(rb))
    e = rb[("B1", "buceo")]
    s.check("on 17 Nov the sign-off has not opened: 'later', from 19 Nov, 2 HODs, 8 people", e["win"]["mode"] == "later" and e["win"]["opens"].day == 19
            and e["hods"] == 2 and e["people"] == 8, (e["win"], e["hods"], e["people"]))
    sub, body = run(lambda d: a.gradeh_ready_mail(d, e, a.active_cycle(d)))
    t_ = text(body)
    s.check("its words: 'Every HOD has finished: Grade H sign-off for ZZGM Unit A is ready', 'You can sign off from Thu 19 Nov. It closes on Mon 23 Nov, 23:59.'",
            sub == "Every HOD has finished: Grade H sign-off for ZZGM Unit A is ready" and "All 2 HODs in ZZGM Unit A have finished their Grade H calibration" in t_
            and "You can sign off from Thu 19 Nov. It closes on Mon 23 Nov, 23:59." in t_ and "This note goes once for ZZGM Unit A this cycle." in t_, t_[:500])
    W.gsetting("gradeh_bu_fallback_at", utc(22, 0))
    e = ready(20)[("B1", "buceo")]
    s.check("inside the cell with the fallback 22 Nov: open now, ahead of Sun 22 Nov", e["win"]["mode"] == "open" and e["win"]["ahead_of"].day == 22, e["win"])
    W.clock(20, 8, 30)
    t = run(lambda d: a.gradeh_ready_send(d, a.active_cycle(d), "ZZ test", now=a._now_myt()))
    again = run(lambda d: a.gradeh_ready_send(d, a.active_cycle(d), "again", now=a._now_myt()))
    s.check("sent once for the place (scope_key the unit), and not again", (t["emailed"], t["buceos"]) == (1, 1) and db.execute(
        "SELECT COUNT(*) FROM ready_notices WHERE kind=? AND scope_key=? AND user_id=?", (a.GH_READY_KIND["buceo"], W.CO, U["B1"])).fetchone()[0] == 1
        and again["emailed"] == 0, (t, again))
    W.bu_sign(W.CO, "B1")
    db.execute("DELETE FROM ready_notices")
    db.commit()
    s.check("a unit signed off gets none", ("B1", "buceo") not in ready(20))
    # a unit whose people have no HOD stage at all: "every HOD has finished" is nobody's news, so no note
    W.reset_world()
    CO3 = "ZZGM Unit C"
    db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (W.BG, CO3))
    W.mk("B3", "21", co=CO3, dept="ZZGM Division C")
    W.mk("N1", co=CO3, dept="ZZGM Dept Four")
    W.person("N1", appraiser=None, submitted=True)
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (W.BG, CO3, U["B3"]))
    db.commit()
    s.check("a unit whose only person has no HOD (the BU CEO covers them): everyone is 'through the HOD stage' from the start, yet no ready note (no HOD to wait for)",
            ("B3", "buceo") not in ready(20), list(ready(20)))
    s.check("...but that unit's BU CEO does get progress on 19 Nov (they are the sign-off)", "B3" in plan(19)[1], plan(19)[1])
    db.execute("DELETE FROM buceo_seats WHERE company=?", (CO3,))
    db.execute("DELETE FROM gradeh_appraisals WHERE person_id=?", (P["N1"],))
    db.execute("DELETE FROM gradeh_people WHERE id=?", (P["N1"],))
    db.execute("DELETE FROM users WHERE id IN (?,?)", (U["B3"], U["N1"]))
    db.execute("DELETE FROM org_units WHERE company=?", (CO3,))
    db.commit()
    for k_ in ("B3", "N1"):
        U.pop(k_, None)
        P.pop(k_, None)
    W.reset_world()
    W.sign("H1", "pot", utc(15, 9))
    W.sign("H1", "perf", utc(16, 9))
    db.execute("INSERT INTO gradeh_releases(cycle_id, unit, released_by) VALUES (?,?,?)", (W.CID, W.CO, U["B1"]))
    db.commit()
    s.check("...nor one Group People released", ("B1", "buceo") not in ready(20))
    W.reset_world()
    W.sign("H1", "pot", utc(15, 9))
    W.sign("H1", "perf", utc(16, 9))
    W.optout("B1", "leader_progress")
    s.check("opt-outs hold here too: B1 opted out of Leader progress gets no ready note", ("B1", "buceo") not in ready(20))
    db.execute("DELETE FROM email_optouts")
    db.commit()
    W.reset_world()

    s.section("the ready notes' job: Ready for you's time, once a day, the Grade H switch only (Ready for you itself stays OFF)")
    W.submit(["S4", "S5", "S6"], utc(8, 10))
    W.ack(["S1", "S2", "S3", "S4", "S5", "S6"], utc(9, 15))
    s.check("Ready for you's own switch is off here (the default), and the note does not care", not run(lambda d: a.ready_rules()["enabled"]))
    W.clock(14, 8, 0)
    s.check("before 08:30: 'Not yet'", run(lambda d: a.gradeh_ready_auto(d, a.active_cycle(d), now=a._now_myt())).startswith("Not yet"))
    W.clock(14, 8, 45)
    said = run(lambda d: a.gradeh_ready_auto(d, a.active_cycle(d), now=a._now_myt()))
    s.check("at 08:45 it checks, marks the day and tells the HOD", said.startswith("Grade H ready notes: 1 places ready, 1 emailed (1 HODs, 0 BU CEOs)")
            and len(W.outbox(a.GH_READY_KIND["hod"])) == 1, said)
    s.check("a second tick the same day: 'Already sent today.'", run(lambda d: a.gradeh_ready_auto(d, a.active_cycle(d), now=a._now_myt())) == "Already sent today.")
    s.check("the server's job calls it right after Ready for you's own turn", src.index("appmod.ready_auto(db, cyc)") < src.index("appmod.gradeh_ready_auto"))
    W.reset_world()
    W.submit(["S4", "S5", "S6"], utc(8, 10))
    W.ack(["S1", "S2", "S3", "S4", "S5", "S6"], utc(9, 15))

    # ============================================================================================================ the switch
    s.section("the Grade H switch off: nothing Grade H, and Everyone's reminder carries on without its Grade H lines")
    W.reset_world()
    W.clock(12)
    W.setting("gradeh_reminders_enabled", "0")
    run(lambda d: None)
    s.check("progress: nobody's plan, and the job says why", plan(12)[0] == set() and "switch is off" in run(
        lambda d: a.gradeh_prog_auto(d, a.active_cycle(d), now=a._now_myt())))
    s.check("ready notes: none built, and the job says why", ready(14) == {} and "switch is off" in run(
        lambda d: a.gradeh_ready_auto(d, a.active_cycle(d), now=a._now_myt())))
    s.check("Everyone's reminder: no Grade H line for H1 (their item is in the bar, not the email)", lines("H1", progress=False) == [] and
            [i["role"] for i in run(lambda d: a.reminder_items(d, W.urow("H1"))) if i["group"] == "gradeh"] == ["gradeh_hod"])
    W.clock(6)
    s.check("...nor the appraiser's (6 Nov)", lines("M2") == [])
    s.check("the reminder's day rule drops the Grade H cells too (6 Nov is no send day for Grade H's leader cell)",
            not any(c.startswith("gradeh") for _k, c, _w in run(lambda d: a.reminder_why(d, a.active_cycle(d), a._today_myt()))))
    s.check("the Grade H 'Next' is none", run(lambda d: a.gradeh_next_send(d, a.active_cycle(d))) is None)
    s.check("a Send now (the manual run) leaves the Grade H lines out as well", (lambda t_: t_["queued"] == 0)(queue(["M2"], gh_staff="all")))
    W.clock(11)
    s.check("...and a Grade H person's own email (S2 has an appraisal to acknowledge), by Send now or the automatic run", queue(["S2"], gh_staff="all")["queued"] == 0
            and queue(["S2"], gh_staff="day")["queued"] == 0 and not W.outbox(a.GRADEH_REMINDER_KIND))
    W.setting("gradeh_reminders_enabled", "1")
    s.check("...the control: switched on, S2's own email is queued", queue(["S2"], gh_staff="all")["queued"] == 1 and len(W.outbox(a.GRADEH_REMINDER_KIND, "S2")) == 1)
    db.execute("DELETE FROM email_outbox")
    db.execute("DELETE FROM notifications")
    db.commit()
    W.setting("gradeh_reminders_enabled", "0")
    W.clock(6)
    W.setting("gradeh_reminders_enabled", "1")
    W.clock(6)
    s.check("the control: switched back on, the appraiser's line is back on 6 Nov", lines("M2") == ["gradeh_lm"], (lines("M2"), a._today_myt()))
    with Patch("gradeh_reminders_on", lambda db=None: True):
        W.setting("gradeh_reminders_enabled", "0")
        s.check("FALSIFIED: with the switch reader forced on, switching off changes nothing", plan(12)[0] == {"H1", "H2"})
        W.setting("gradeh_reminders_enabled", "1")
    run(lambda d: None)
    db.execute("DELETE FROM app_settings WHERE key='gradeh_reminders_enabled'")
    db.commit()
    s.check("no switch row at all = on (as it was)", run(lambda d: a.gradeh_reminders_on(d)) is True)

    s.section("the Schedule's top card: the Grade H row (only where Grade H runs) and its one switch")
    db.commit()
    sup = H.client_as(a, SU["id"])
    W.rem_settings(days=(2, 1))
    W.clock(11)
    page_ = lambda: html.unescape(sup.get("/admin/email").get_data(as_text=True))   # noqa: E731
    b = page_()
    m = re.search(r'<div class="eml-own-row[^"]*" data-eml-row="gradeh">(.*?)\n    </div>\n', b, re.S)
    row_ = m.group(1) if m else ""
    names_ = re.findall(r'data-eml-row="(\w+)"', b)
    s.check("with Grade H running the card has a Grade H reminders row, second, after Everyone's reminder", names_[:2] == ["reminder", "gradeh"], names_)
    s.check("...its switch is On, its Next is the Grade H one, and its muted line names the staff email, the lines and progress",
            'aria-checked="true"' in row_ and "Next: " in row_ and "Staff (BM / EN), the Grade H lines for line managers, and Grade H progress for HODs and BU CEOs" in row_, row_[:500])
    r = sup.post("/admin/email/switch", data={"csrf_token": "tok", "email": "gradeh", "enabled": "off"}, follow_redirects=True)
    s.check("the switch off: one setting (gradeh_reminders_enabled = 0), one audit row, and the page says what it covers",
            db.execute("SELECT value FROM app_settings WHERE key='gradeh_reminders_enabled'").fetchone()[0] == "0"
            and "none of the Grade H emails goes" in html.unescape(r.get_data(as_text=True))
            and db.execute("SELECT COUNT(*) FROM activity_log WHERE action='gradeh_reminders_switch' AND detail LIKE 'on=False%'").fetchone()[0] == 1)
    b = page_()
    m = re.search(r'<div class="eml-own-row[^"]*" data-eml-row="gradeh">(.*?)\n    </div>\n', b, re.S)
    row_ = m.group(1) if m else ""
    s.check("...its row reads 'Off · nothing goes on its own' and says Everyone's reminder carries on without its Grade H lines",
            "Off · nothing goes on its own" in row_ and "Everyone's reminder carries on without its Grade H lines." in row_ and 'aria-checked="false"' in row_
            and "Next:" not in row_, row_[:500])
    s.check("...with OneHR's confirm box to start it again", 'data-confirm-title="Start Grade H reminders?"' in row_ and 'name="enabled" value="on"' in row_)
    r = sup.post("/admin/email/switch", data={"csrf_token": "tok", "email": "gradeh", "enabled": "on"}, follow_redirects=True)
    s.check("...and back on", run(lambda d: a.gradeh_reminders_on(d)) is True)
    db.execute("DELETE FROM app_settings WHERE key='gradeh_reminders_enabled'")
    db.commit()
    os.environ["ONEHR_GRADEH"] = "0"
    s.check("with Grade H not running (the server switch off) the row is gone, and its switch route is a 404", 'data-eml-row="gradeh"' not in page_()
            and sup.post("/admin/email/switch", data={"csrf_token": "tok", "email": "gradeh", "enabled": "off"}).status_code == 404)
    os.environ["ONEHR_GRADEH"] = "1"
    s.check("the Grade H 'Next' is the earlier of the staff email and the leaders' progress: from 11 Nov that is 12 Nov 09:00 (the HODs' opening day)",
            run(lambda d: a.gradeh_next_send(d, a.active_cycle(d), a._now_myt())) == datetime(2026, 11, 12, 9, 0))

    # ================================================================================================================ the words
    s.section("the words: four template kinds, last, English, light only, placeholders checked")
    ks = [x["key"] for x in a.EMAIL_TPL_KINDS]
    GH4 = ["gradeh_lp_hod", "gradeh_lp_buceo", "gradeh_ready_hod", "gradeh_ready_buceo"]
    s.check("gradeh_lp_hod, gradeh_lp_buceo, gradeh_ready_hod, gradeh_ready_buceo are four kinds in a row, after gradeh_result (every template already numbered keeps its number; position-free: another branch's kinds may follow them)",
            GH4[0] in ks and ks[ks.index(GH4[0]):ks.index(GH4[0]) + 4] == GH4 and ks.index(GH4[0]) > ks.index("gradeh_result"), ks[-6:])
    db.commit()
    s.check("none of them is in the older groups: Emails and templates lists them in Grade H Appraisal, beside Grade H · a reminder for staff",
            (lambda b: all(a.EMAIL_TPL_KIND[k]["title"] in b for k in GH4) and "Grade H Appraisal" in b)(
                html.unescape(H.client_as(a, SU["id"]).get("/admin/emails").get_data(as_text=True))))
    for key in GH4:
        d_ = a._email_tpl_default(key)
        s.check("%s: default words, every placeholder used is one it fills" % key, all(
            set(re.findall(r"\{(\w+)\}", v)) <= set(a.EMAIL_TPL_KIND[key]["placeholders"]) for v in d_.values()), d_)
        subj, body = run(lambda d: a.email_tpl_sample(d, key, a.email_tpl_saved(
            {"email": key, "words": json.dumps(d_)}), SU, case="later" if key.endswith("buceo") else None))
        s.check("%s: a made-up preview, addressed to the admin, light only, brand and no real name" % key, 'content="light only"' in body
                and "OneHR by Chin Hin" in body and "ZZ GP" not in body and "Zz Gp" not in body, subj)
    s.check("a template using a placeholder the email doesn't fill is refused, naming the ones it does", (lambda r_: any("{acknowledged}" in e_ and "{finished}" not in e_ for e_ in r_[1]) or any("finished" in e_ for e_ in r_[1]))(
        a._tpl_words_from({"subject": "Hi {finished}"}, a.GH_PROG_FIELDS, a.GH_PROG_PLACEHOLDERS["hod"], a._email_tpl_default("gradeh_lp_hod"), ("opening", "closing"))))
    s.check("when each goes is in words (Emails and templates)", all(run(lambda d, k=k: a.email_tpl_when(d, k)) for k in GH4)
            and "3 days before it closes" in run(lambda d: a.email_tpl_when(d, "gradeh_lp_hod")))
    W.restore()
finally:
    W.restore()
    a.mailer.is_configured, a._outbox_kick, a.chair_user_id, a.OUTBOX_ASYNC = _real
    os.environ["ONEHR_GRADEH"] = _ENV0 if _ENV0 is not None else ""
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)

sys.exit(s.done())
