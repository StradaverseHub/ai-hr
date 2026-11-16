"""Everyone's reminder copies the person's line manager (Chris, 2026-11-06), the same single email, only while one of the
person's OWN tasks still waits.

What this suite holds:
  * the rule (reminder_lm_cc): the setting reminder_cc_lm (off by default); an item in group "own" (their own parts) or
    "f360" (360 ratings they owe) is what triggers it; team / lead / Grade H leader items never do, and a Grade H staff
    item folded into the email does not either; no manager, a manager who has left, no / invalid email, opted out of
    Everyone's reminder, or the same address as the person's (case and spaces ignored): no cc
  * reminder_send queues the address in email_outbox.cc_email (the managers of the run read in ONE query); the dry run says
    "cc line manager"; a redirected test (test_to) is sent with no cc; Grade H staff's own email is never copied
  * the send-time recheck works the cc out again from what waits NOW and today's setting: own part done but team items
    remain, the setting switched off, the manager gone or opted out since: the cc is cleared and the row carries it
  * _outbox_send_row passes cc=[address] only when the row has one; every other email goes with exactly the call it did
  * Email > Sent shows the copied address; the schedule form sets / clears the setting through the real admin route, and
    another set_reminder_rules caller leaves it alone
  * never the Executive Chairman or a BG CEO as the line manager (Chris, 2026-11-07): the person's email still goes, with no
    cc, in the run and in the send-time recheck; the chairman is the STORED seat, excluded with ONEHR_CHAIR off and on; an
    ordinary manager and a BU CEO are still copied (only those two are left out)
Synthetic (ZZLC-*) on the scratch database; the suite puts back what it changes.
"""
import html
import inspect
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Everyone's reminder copies the line manager while their own task waits")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
sup = H.client_as(a, SU["id"])
PFX, DOM = "ZZLC-", "@zzlc.invalid"


def item(group, text):
    return {"group": group, "role": group, "text": text, "detail": "", "closes": "", "url": "/review",
            "closes_on": None, "people": []}


OWN, F360 = item("own", "Enter your KPI results and submit"), item("f360", "Rate your colleagues in the 360")
TEAM, LEAD, GHL = item("team", "Moderate your team's KPI results"), item("lead", "Calibrate your unit"), item("gradeh", "Appraise Grade H")


def ctx(fn):
    with a.app.test_request_context("/"):
        d = a.get_db()
        r = fn(d)
        d.commit()
        return r


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE ?", (PFX + "%",))]
    if ids:
        ph = ",".join("?" * len(ids))
        for tbl in ("notifications", "email_outbox", "email_optouts", "gradeh_people"):
            db.execute("DELETE FROM %s WHERE user_id IN (%s)" % (tbl, ph), ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM email_outbox WHERE to_email LIKE ?", ("%" + DOM,))
    db.execute("DELETE FROM notifications WHERE to_email LIKE ?", ("%" + DOM,))
    db.execute("DELETE FROM activity_log WHERE id > ? AND action IN ('reminder_run','reminder_schedule')", (LOG0,))
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    CYC = dict(a.active_cycle(db))
    CID = CYC["id"]
    LOG0 = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
    _cleanup(db)
    SAVED = {r[0]: r[1] for r in db.execute("SELECT key, value FROM app_settings WHERE key LIKE 'reminder_%'")}
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0 "
                           "LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(key, email="auto", mgr=None, left=False):
        eid = PFX + key
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ LC " + key,
                 email=(eid.lower() + DOM) if email == "auto" else email, hod_id=None, manager_id=mgr, buceo_bg=None,
                 buceo_company=None, bgceo_bg=None, left_at="2026-01-01 00:00:00" if left else None, is_demo=0,
                 role="user", admin_bg=None)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
    # the line managers: one who qualifies and one for each reason a manager is not copied
    M_OK, M_LEFT = mk("M-OK"), mk("M-LEFT", left=True)
    M_BLANK, M_NOAT, M_OPT = mk("M-BLANK", email="  "), mk("M-NOAT", email="not-an-address"), mk("M-OPT")
    M_SAME = mk("M-SAME", email="  Shared@ZZLC.invalid ")
    db.execute("INSERT INTO email_optouts(user_id, kind, until, reason) VALUES (?, 'reminder', NULL, 'zzlc test')", (M_OPT,))
    P = {"OWN": mk("OWN", mgr=M_OK), "F360": mk("F360", mgr=M_OK), "BOTH": mk("BOTH", mgr=M_OK),
         "TEAM": mk("TEAM", mgr=M_OK), "LEAD": mk("LEAD", mgr=M_OK), "GHL": mk("GHL", mgr=M_OK),
         "NOMGR": mk("NOMGR"), "LEFTM": mk("LEFTM", mgr=M_LEFT), "BLANKM": mk("BLANKM", mgr=M_BLANK),
         "NOATM": mk("NOATM", mgr=M_NOAT), "OPTM": mk("OPTM", mgr=M_OPT),
         "SAME": mk("SAME", email="shared@zzlc.invalid", mgr=M_SAME),
         "GHSTAFF": mk("GHSTAFF", mgr=M_OK), "GHFTEAM": mk("GHFTEAM", mgr=M_OK), "GHFOWN": mk("GHFOWN", mgr=M_OK)}
    # a BG CEO, the Executive Chairman (the stored seat) and a BU CEO as line managers, and one person under each (2026-11-07)
    M_BG, M_EC, M_BU = mk("M-BG"), mk("M-EC"), mk("M-BU")
    db.execute("UPDATE users SET bgceo_bg='ZZLC-BG' WHERE id=?", (M_BG,))
    db.execute("UPDATE users SET buceo_bg='ZZLC-BG', buceo_company='ZZLC-CO' WHERE id=?", (M_BU,))
    P.update({"UNDERBG": mk("UNDERBG", mgr=M_BG), "UNDEREC": mk("UNDEREC", mgr=M_EC), "UNDERBU": mk("UNDERBU", mgr=M_BU)})
    SAVED_CHAIR = {r[0]: r[1] for r in db.execute("SELECT key, value FROM app_settings WHERE key=?", (a.CHAIR_SETTING_ID,))}
    SAVED_FLAG = os.environ.get("ONEHR_CHAIR")
    GH_USERS = (P["GHSTAFF"], P["GHFTEAM"], P["GHFOWN"])
    for uid in GH_USERS:   # on the Grade H list; the case is stubbed below
        db.execute("INSERT INTO gradeh_people(cycle_id, employee_id, user_id, route, language) SELECT ?, employee_id, id, 'A', "
                   "'en' FROM users WHERE id=?", (CID, uid))
    db.commit()
MGR_ADDR = (PFX + "M-OK").lower() + DOM

WAITING = {P["OWN"]: [OWN], P["F360"]: [F360], P["BOTH"]: [OWN, TEAM], P["TEAM"]: [TEAM], P["LEAD"]: [LEAD],
           P["GHL"]: [GHL], P["NOMGR"]: [OWN], P["LEFTM"]: [OWN], P["BLANKM"]: [OWN], P["NOATM"]: [OWN],
           P["OPTM"]: [OWN], P["SAME"]: [OWN], P["GHSTAFF"]: [], P["UNDERBG"]: [OWN], P["UNDEREC"]: [OWN], P["UNDERBU"]: [OWN], P["GHFTEAM"]: [TEAM], P["GHFOWN"]: [OWN]}
FAKE_CASE = {"case": "kpi", "cell": a.GRADEH_CELL_KPI, "closes": a._now_myt() + timedelta(days=3), "deemed": None}
_real = (a.mailer.send_mail, a.mailer.is_configured, a.mailer.get_token, a.OUTBOX_ASYNC, a.reminder_items, a._outbox_kick,
         a.gradeh_rm_cid, a.gradeh_staff_case)
_sent = []


def _items(db_, u_):
    return [dict(i) for i in WAITING.get(u_["id"], [])] if u_["id"] in WAITING else _real[4](db_, u_)


a.reminder_items = _items
a.gradeh_rm_cid = lambda db_, cyc=None: CID                       # Grade H runs on the cycle...
a.gradeh_staff_case = lambda db_, person, cid, now=None: dict(FAKE_CASE) if person["user_id"] in GH_USERS else None
a.mailer.send_mail = lambda to, subject, body, **kw: _sent.append((to, subject, body, kw))
a.mailer.is_configured = lambda: True
a.mailer.get_token = lambda: "tok"
a.OUTBOX_ASYNC = False
a._outbox_kick = lambda flask_app=None: False                      # queued rows stay queued


def cc_on(on):
    ctx(lambda d: a.set_reminder_rules(True, True, [3], 0, "09:00", cc_lm=on))


def people(keys):
    ids = [P[k] for k in keys]
    return ctx(lambda d: d.execute("SELECT * FROM users WHERE id IN (%s) ORDER BY id" % ",".join("?" * len(ids)), ids).fetchall())


def reset_queue():
    ids = list(P.values())
    ph = ",".join("?" * len(ids))
    ctx(lambda d: (d.execute("DELETE FROM email_outbox WHERE user_id IN (%s)" % ph, ids),
                   d.execute("DELETE FROM notifications WHERE user_id IN (%s)" % ph, ids)))


def queue(keys, **kw):
    reset_queue()
    return ctx(lambda d: a.reminder_send(d, CYC, people(keys), "ZZLC test run", live=True, **kw))


def row_of(key, kind=None):
    return ctx(lambda d: dict(d.execute("SELECT * FROM email_outbox WHERE user_id=? AND kind=? ORDER BY id DESC LIMIT 1",
                                        (P[key], kind or a.REMINDER_KIND)).fetchone() or {}))


def cc_of(key, kind=None):
    return row_of(key, kind).get("cc_email")


try:
    ALL = list(P)
    s.section("the setting: off by default, a form-only switch")
    ctx(lambda d: d.execute("DELETE FROM app_settings WHERE key='reminder_cc_lm'"))
    s.check("no row = off: reminder_rules() has cc_lm False", ctx(lambda d: a.reminder_rules())["cc_lm"] is False)
    s.check("reminder_send's default for the new argument is None (leave it alone)",
            inspect.signature(a.set_reminder_rules).parameters["cc_lm"].default is None)

    s.section("setting off: nobody is copied")
    cc_on(False)
    t = queue(["OWN", "F360", "BOTH"])
    s.check("queued all three", t["queued"] == 3, t)
    s.check("...with no cc, though an own item waits", all(cc_of(k) is None for k in ("OWN", "F360", "BOTH")),
            [cc_of(k) for k in ("OWN", "F360", "BOTH")])

    s.section("setting on: the rule, one case at a time")
    cc_on(True)
    s.check("reminder_rules() reads it", ctx(lambda d: a.reminder_rules())["cc_lm"] is True)
    t = queue(ALL, gh_staff="all")
    s.check("everyone with something waiting is queued, one email each", t["queued"] == len(ALL), t)
    s.check("an own item: the manager is copied", cc_of("OWN") == MGR_ADDR, cc_of("OWN"))
    s.check("360 ratings only: copied", cc_of("F360") == MGR_ADDR, cc_of("F360"))
    s.check("own plus team items: copied (the own one triggers it)", cc_of("BOTH") == MGR_ADDR, cc_of("BOTH"))
    s.check("team items only: not copied", cc_of("TEAM") is None and row_of("TEAM")["id"], cc_of("TEAM"))
    s.check("a leader item only: not copied", cc_of("LEAD") is None and row_of("LEAD")["id"], cc_of("LEAD"))
    s.check("a Grade H leader item only: not copied", cc_of("GHL") is None and row_of("GHL")["id"], cc_of("GHL"))
    s.check("no manager: not copied", cc_of("NOMGR") is None and row_of("NOMGR")["id"], cc_of("NOMGR"))
    s.check("a manager who has left: not copied", cc_of("LEFTM") is None and row_of("LEFTM")["id"], cc_of("LEFTM"))
    s.check("a manager with a blank email: not copied", cc_of("BLANKM") is None and row_of("BLANKM")["id"], cc_of("BLANKM"))
    s.check("a manager whose email has no @: not copied", cc_of("NOATM") is None and row_of("NOATM")["id"], cc_of("NOATM"))
    s.check("a manager opted out of Everyone's reminder: not copied", cc_of("OPTM") is None and row_of("OPTM")["id"],
            cc_of("OPTM"))
    s.check("a manager with the person's own address (case and spaces ignored): not copied",
            cc_of("SAME") is None and row_of("SAME")["id"], cc_of("SAME"))
    s.check("the email to the person is unchanged by the copy: one row each, addressed to them",
            row_of("OWN")["to_email"] == (PFX + "OWN").lower() + DOM and ctx(lambda d: d.execute(
                "SELECT COUNT(*) FROM email_outbox WHERE user_id=?", (P["OWN"],)).fetchone()[0]) == 1)

    s.section("Grade H: staff's own email is never copied; a folded staff item does not trigger it")
    s.check("a Grade H person's own email (nothing else waiting): kind is Grade H's and there is no cc",
            row_of("GHSTAFF", a.GRADEH_REMINDER_KIND).get("id") and cc_of("GHSTAFF", a.GRADEH_REMINDER_KIND) is None
            and not row_of("GHSTAFF"))
    s.check("team items plus the folded Grade H staff item: no cc (the staff item's group is gradeh)",
            cc_of("GHFTEAM") is None and row_of("GHFTEAM")["id"] and "gradeh" == ctx(lambda d: a._gradeh_staff_item(dict(FAKE_CASE)))["group"], cc_of("GHFTEAM"))
    s.check("an own item plus the folded staff item: copied, still ONE email",
            cc_of("GHFOWN") == MGR_ADDR and ctx(lambda d: d.execute("SELECT COUNT(*) FROM email_outbox WHERE user_id=?",
                                                                    (P["GHFOWN"],)).fetchone()[0]) == 1, cc_of("GHFOWN"))
    # falsify: the guard is the item's group, not the email's kind
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        u_ = d_.execute("SELECT * FROM users WHERE id=?", (P["GHFTEAM"],)).fetchone()
        folded = [dict(TEAM), a._gradeh_staff_item(dict(FAKE_CASE))]
        s.check("falsified: the helper alone says None for team + folded staff item, and an address once an own item joins",
                a.reminder_lm_cc(d_, u_, folded, on=True) is None
                and a.reminder_lm_cc(d_, u_, folded + [dict(OWN)], on=True) == MGR_ADDR)

    s.section("the helper's other doors (read directly)")
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        u_ = d_.execute("SELECT * FROM users WHERE id=?", (P["OWN"],)).fetchone()
        s.check("setting off (on=False) beats an own item", a.reminder_lm_cc(d_, u_, [OWN], on=False) is None)
        s.check("no items at all: None", a.reminder_lm_cc(d_, u_, [], on=True) is None)
        mg = d_.execute("SELECT id, email, left_at FROM users WHERE id=?", (M_OK,)).fetchone()
        s.check("a manager row handed in is used (no lookup)", a.reminder_lm_cc(d_, u_, [OWN], lm=mg, on=True, off=set()) == MGR_ADDR)
        s.check("...and a run that read the managers and found none is None", a.reminder_lm_cc(d_, u_, [OWN], lm=None, on=True,
                                                                                               off=set()) is None)
        s.check("...an opted-out set handed in is used", a.reminder_lm_cc(d_, u_, [OWN], lm=mg, on=True, off={M_OK}) is None)
        mgrs = a.reminder_managers(d_)
        s.check("reminder_managers reads every manager in one go", M_OK in mgrs and M_LEFT in mgrs and P["OWN"] not in mgrs
                and d_.execute("SELECT COUNT(*) FROM users WHERE id IN (SELECT manager_id FROM users WHERE manager_id IS NOT NULL)"
                               ).fetchone()[0] == len(mgrs))
        src = inspect.getsource(a.reminder_send)
        s.check("reminder_send reads the managers once, before the loop, and asks the one helper",
                src.count("reminder_managers(") == 1 and src.index("reminder_managers(") < src.index("for u in people")
                and "reminder_lm_cc(" in src and "SELECT" not in src[src.index("for u in people"):].split("reminder_lm_cc")[0][-200:])

    s.section("dry run and a redirected test")
    lines = []
    reset_queue()
    ctx(lambda d: a.reminder_send(d, CYC, people(["OWN", "TEAM"]), "ZZLC dry", live=False, log=lines.append))
    own_l = next((l for l in lines if (PFX + "OWN") in l), "")
    team_l = next((l for l in lines if (PFX + "TEAM") in l), "")
    s.check("the dry run names the copy for the person who gets one", "cc line manager" in own_l, lines)
    s.check("...and not for the one who does not", team_l and "cc line manager" not in team_l, lines)
    s.check("...and queued nothing", not row_of("OWN"))
    _sent.clear()
    reset_queue()
    ctx(lambda d: a.reminder_send(d, CYC, people(["OWN"]), "ZZLC test", live=True, test_to="admin" + DOM))
    s.check("a redirected test is sent now, to the admin's address, with no cc argument at all",
            len(_sent) == 1 and _sent[0][0] == "admin" + DOM and "cc" not in _sent[0][3], [x[0::3] for x in _sent])
    s.check("...and nothing is queued", not row_of("OWN"))

    s.section("the recheck works the copy out again")
    queue(["OWN", "BOTH", "F360", "LEFTM", "OPTM"])
    s.check("queued with the copy", cc_of("OWN") == MGR_ADDR and cc_of("BOTH") == MGR_ADDR and cc_of("F360") == MGR_ADDR)
    WAITING[P["BOTH"]] = [TEAM]                      # their own part is done, a team item remains
    unchanged = ctx(lambda d: a._outbox_reminder_recheck(d, d.execute("SELECT * FROM email_outbox WHERE id=?", (row_of("OWN")["id"],)).fetchone()))
    s.check("own item still waits: the row keeps its cc", unchanged["cc_email"] == MGR_ADDR and cc_of("OWN") == MGR_ADDR)
    got = ctx(lambda d: a._outbox_reminder_recheck(d, d.execute("SELECT * FROM email_outbox WHERE id=?", (row_of("BOTH")["id"],)).fetchone()))
    s.check("own part done, team items remain: the cc is cleared, the row returned carries it, and the email still goes",
            got is not None and got["cc_email"] is None and cc_of("BOTH") is None and "Moderate your team" in got["body"],
            got and got["cc_email"])
    # the manager of LEFTM / OPTM changes since queueing: queue them with a good manager first
    ctx(lambda d: d.execute("UPDATE users SET manager_id=? WHERE id IN (?,?)", (M_OK, P["LEFTM"], P["OPTM"])))
    queue(["LEFTM", "OPTM"])
    s.check("queued with the copy once their manager was fine", cc_of("LEFTM") == MGR_ADDR and cc_of("OPTM") == MGR_ADDR)
    ctx(lambda d: (d.execute("UPDATE users SET manager_id=? WHERE id=?", (M_LEFT, P["LEFTM"])),
                   d.execute("UPDATE users SET manager_id=? WHERE id=?", (M_OPT, P["OPTM"]))))
    for k in ("LEFTM", "OPTM"):
        ctx(lambda d, k=k: a._outbox_reminder_recheck(d, d.execute("SELECT * FROM email_outbox WHERE id=?", (row_of(k)["id"],)).fetchone()))
    s.check("their manager has left since: the cc is cleared", cc_of("LEFTM") is None)
    s.check("their manager was opted out since: the cc is cleared", cc_of("OPTM") is None)
    queue(["OWN", "F360"])
    s.check("queued with the copy", cc_of("OWN") == MGR_ADDR and cc_of("F360") == MGR_ADDR)
    cc_on(False)
    for k in ("OWN", "F360"):
        got = ctx(lambda d, k=k: a._outbox_reminder_recheck(d, d.execute("SELECT * FROM email_outbox WHERE id=?", (row_of(k)["id"],)).fetchone()))
        s.check("the setting was switched off after queuing: %s's cc is cleared, stored and returned" % k,
                got is not None and got["cc_email"] is None and cc_of(k) is None)
    queue(["OWN"])                                   # queued with the setting off ...
    s.check("queued with the setting off: no cc", cc_of("OWN") is None)
    cc_on(True)                                      # ... and switched on before its wave
    got = ctx(lambda d: a._outbox_reminder_recheck(d, d.execute("SELECT * FROM email_outbox WHERE id=?", (row_of("OWN")["id"],)).fetchone()))
    s.check("switched on before its wave: the recheck adds the copy (it follows today's setting)",
            got["cc_email"] == MGR_ADDR and cc_of("OWN") == MGR_ADDR)
    # the Grade H staff email's recheck never adds one
    queue(["GHSTAFF"], gh_staff="all")
    gh_row = ctx(lambda d: d.execute("SELECT * FROM email_outbox WHERE id=?", (row_of("GHSTAFF", a.GRADEH_REMINDER_KIND)["id"],)).fetchone())
    ctx(lambda d: a._outbox_reminder_recheck(d, gh_row))
    s.check("a Grade H staff email stays without a cc through its own recheck",
            cc_of("GHSTAFF", a.GRADEH_REMINDER_KIND) is None)
    s.check("the recheck and the send read ONE rule: the recheck source names the helper, not its own test",
            "reminder_lm_cc(" in inspect.getsource(a._outbox_reminder_recheck))

    s.section("never the Executive Chairman or a BG CEO as the line manager (Chris, 2026-11-07)")
    cc_on(True)
    ctx(lambda d: d.execute("DELETE FROM app_settings WHERE key=?", (a.CHAIR_SETTING_ID,)))
    t = queue(["OWN", "UNDERBG", "UNDEREC", "UNDERBU"])
    s.check("queued all four, one email each", t["queued"] == 4, t)
    s.check("falsify: an ordinary manager is still copied", cc_of("OWN") == MGR_ADDR, cc_of("OWN"))
    s.check("falsify: a BU CEO as manager is still copied (only the EC and BG CEOs are left out)",
            cc_of("UNDERBU") == (PFX + "M-BU").lower() + DOM, cc_of("UNDERBU"))
    s.check("a BG CEO as manager: the person's email is queued, with no cc",
            cc_of("UNDERBG") is None and row_of("UNDERBG")["to_email"] == (PFX + "UNDERBG").lower() + DOM
            and row_of("UNDERBG")["status"] == "queued", row_of("UNDERBG").get("cc_email"))
    s.check("no stored chairman seat: his report (the manager is not the seat yet) is copied", cc_of("UNDEREC") == (PFX + "M-EC").lower() + DOM,
            cc_of("UNDEREC"))
    s.check("reminder_cc_chair_id: no seat stored = None", ctx(lambda d: a.reminder_cc_chair_id(d)) is None)
    # the BG CEO guard in the helper alone: the manager row handed in without the column still works, and with it excludes
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        u_ = d_.execute("SELECT * FROM users WHERE id=?", (P["UNDERBG"],)).fetchone()
        slim = d_.execute("SELECT id, email, left_at FROM users WHERE id=?", (M_BG,)).fetchone()
        full = d_.execute("SELECT id, email, left_at, bgceo_bg FROM users WHERE id=?", (M_BG,)).fetchone()
        s.check("a manager row without bgceo_bg (an older caller) still works: copied", a.reminder_lm_cc(d_, u_, [OWN], lm=slim, on=True, off=set(), chair=None)
                == (PFX + "M-BG").lower() + DOM)
        s.check("...and with bgceo_bg set the same row is not copied", a.reminder_lm_cc(d_, u_, [OWN], lm=full, on=True, off=set(), chair=None) is None)
        s.check("reminder_managers carries bgceo_bg", a.reminder_managers(d_)[M_BG]["bgceo_bg"] == "ZZLC-BG")
    # the recheck: a BG CEO seated after the row was queued clears the copy
    ctx(lambda d: d.execute("UPDATE users SET bgceo_bg=NULL WHERE id=?", (M_BG,)))
    queue(["UNDERBG"])
    s.check("queued while the manager is no BG CEO: copied", cc_of("UNDERBG") == (PFX + "M-BG").lower() + DOM)
    ctx(lambda d: d.execute("UPDATE users SET bgceo_bg='ZZLC-BG' WHERE id=?", (M_BG,)))
    got = ctx(lambda d: a._outbox_reminder_recheck(d, d.execute("SELECT * FROM email_outbox WHERE id=?", (row_of("UNDERBG")["id"],)).fetchone()))
    s.check("recheck: the manager is a BG CEO now: the cc is cleared, stored and returned, the email still goes",
            got is not None and got["cc_email"] is None and cc_of("UNDERBG") is None and row_of("UNDERBG")["status"] == "queued")
    queue(["UNDERBG"])
    s.check("a fresh run with the BG CEO as manager queues no cc", cc_of("UNDERBG") is None)
    # the Executive Chairman: the stored seat, with the flag off and on
    ctx(lambda d: d.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", (a.CHAIR_SETTING_ID, str(M_EC))))
    s.check("reminder_cc_chair_id reads the stored seat as an int", ctx(lambda d: a.reminder_cc_chair_id(d)) == M_EC)
    for flag in (None, "0", "1"):
        if flag is None:
            os.environ.pop("ONEHR_CHAIR", None)
        else:
            os.environ["ONEHR_CHAIR"] = flag
        label = "ONEHR_CHAIR %s" % ("unset" if flag is None else flag)
        ctx(lambda d: d.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", (a.CHAIR_SETTING_ID, str(M_EC))))
        queue(["UNDEREC", "OWN", "UNDERBU"])
        s.check("%s: the chairman as manager: queued, no cc, the person is the addressee" % label,
                cc_of("UNDEREC") is None and row_of("UNDEREC")["to_email"] == (PFX + "UNDEREC").lower() + DOM
                and row_of("UNDEREC")["status"] == "queued", cc_of("UNDEREC"))
        s.check("%s: falsify: an ordinary manager and a BU CEO are still copied" % label,
                cc_of("OWN") == MGR_ADDR and cc_of("UNDERBU") == (PFX + "M-BU").lower() + DOM, [cc_of("OWN"), cc_of("UNDERBU")])
        # the recheck, from a row queued while the manager did not hold the seat
        ctx(lambda d: d.execute("DELETE FROM app_settings WHERE key=?", (a.CHAIR_SETTING_ID,)))
        queue(["UNDEREC"])
        s.check("%s: queued before he held the seat: copied" % label, cc_of("UNDEREC") == (PFX + "M-EC").lower() + DOM)
        ctx(lambda d: d.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", (a.CHAIR_SETTING_ID, str(M_EC))))
        got = ctx(lambda d: a._outbox_reminder_recheck(d, d.execute("SELECT * FROM email_outbox WHERE id=?", (row_of("UNDEREC")["id"],)).fetchone()))
        s.check("%s: recheck with him in the seat: the cc is cleared, stored and returned" % label,
                got is not None and got["cc_email"] is None and cc_of("UNDEREC") is None)
    ctx(lambda d: d.execute("UPDATE app_settings SET value='not-a-number' WHERE key=?", (a.CHAIR_SETTING_ID,)))
    s.check("an unreadable stored seat reads as None (nobody excluded, nothing breaks)", ctx(lambda d: a.reminder_cc_chair_id(d)) is None)
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        u_ = d_.execute("SELECT * FROM users WHERE id=?", (P["UNDEREC"],)).fetchone()
        mg = d_.execute("SELECT id, email, left_at, bgceo_bg FROM users WHERE id=?", (M_EC,)).fetchone()
        s.check("the helper: chair handed in = his id is not copied; another id or None copies him",
                a.reminder_lm_cc(d_, u_, [OWN], lm=mg, on=True, off=set(), chair=M_EC) is None
                and a.reminder_lm_cc(d_, u_, [OWN], lm=mg, on=True, off=set(), chair=M_EC + 99999) == (PFX + "M-EC").lower() + DOM
                and a.reminder_lm_cc(d_, u_, [OWN], lm=mg, on=True, off=set(), chair=None) == (PFX + "M-EC").lower() + DOM)
    src = inspect.getsource(a.reminder_send)
    s.check("reminder_send reads the chairman's id ONCE, before the loop, and hands it to the one helper",
            src.count("reminder_cc_chair_id(") == 1 and src.index("reminder_cc_chair_id(") < src.index("for u in people")
            and "chair=cc_chair" in src)
    s.check("the exclusions live in reminder_lm_cc (one rule), not in reminder_send or the recheck",
            "bgceo_bg" not in src and "bgceo_bg" not in inspect.getsource(a._outbox_reminder_recheck)
            and "reminder_cc_chair_id(" in inspect.getsource(a.reminder_lm_cc))
    ctx(lambda d: d.execute("DELETE FROM app_settings WHERE key=?", (a.CHAIR_SETTING_ID,)))
    if SAVED_FLAG is None:
        os.environ.pop("ONEHR_CHAIR", None)
    else:
        os.environ["ONEHR_CHAIR"] = SAVED_FLAG
    ctx(lambda d: d.execute("UPDATE users SET bgceo_bg=NULL WHERE id=?", (M_BG,)))

    s.section("the sender: cc=[...] only where the row has one")
    calls = []
    a.mailer.send_mail = lambda *args, **kw: calls.append((args, kw))
    a._outbox_send_row({"to_email": "x" + DOM, "subject": "S", "body": "<p>B</p>", "cc_email": " lm" + DOM + " "}, "tok")
    s.check("a row with a cc: send_mail gets cc=[the address]", calls[-1] == (("x" + DOM, "S", "<p>B</p>"),
                                                                            {"token": "tok", "cc": ["lm" + DOM]}), calls[-1])
    for label, row in (("cc_email NULL", {"cc_email": None}), ("cc_email blank", {"cc_email": "  "}), ("no such column", {})):
        a._outbox_send_row(dict({"to_email": "x" + DOM, "subject": "S", "body": "<p>B</p>"}, **row), "tok")
        s.check("a row with %s: exactly the call it was before (no cc argument)" % label,
                calls[-1] == (("x" + DOM, "S", "<p>B</p>"), {"token": "tok"}), calls[-1])
    a._outbox_send_row({"to_email": "x" + DOM, "subject": "S", "body": "B", "attach_json": '[{"name":"a.txt","content_type":"text/plain","content":"hi"}]'}, "tok")
    s.check("a row with an attachment is still sent as before", calls[-1][1].get("attachments") and "cc" not in calls[-1][1], calls[-1])
    a.mailer.send_mail = lambda to, subject, body, **kw: _sent.append((to, subject, body, kw))

    s.section("end to end: queue -> recheck -> drain")
    queue(["OWN", "TEAM"])
    _sent.clear()
    a._outbox_kick = _real[5]
    ctx(lambda d: a._outbox_drain(a.app, inline=True))
    sent_own = [x for x in _sent if x[0] == (PFX + "OWN").lower() + DOM]
    sent_team = [x for x in _sent if x[0] == (PFX + "TEAM").lower() + DOM]
    s.check("the person's email goes once, with the manager on cc", len(sent_own) == 1 and sent_own[0][3].get("cc") == [MGR_ADDR],
            [x[3] for x in sent_own])
    s.check("...a team-only person's email goes once with no cc", len(sent_team) == 1 and "cc" not in sent_team[0][3],
            [x[3] for x in sent_team])
    s.check("...and the manager gets no email of their own", not [x for x in _sent if x[0] == MGR_ADDR])
    s.check("the outbox row keeps the address it was sent with", row_of("OWN")["status"] == "sent" and cc_of("OWN") == MGR_ADDR)
    a._outbox_kick = lambda flask_app=None: False

    s.section("Email > Sent shows who was copied")
    queue(["OWN", "TEAM"])
    batch = row_of("OWN")["batch"]
    body = html.unescape(sup.get("/admin/list/email-run?batch=%s&fragment=1" % batch).get_data(as_text=True))
    rows_html = re.findall(r'<tr class="data-row".*?</tr>', body, re.S)
    own_r = next((r for r in rows_html if (PFX + "OWN") in r), "")
    team_r = next((r for r in rows_html if (PFX + "TEAM") in r), "")
    s.check("the copied person's row shows 'cc' and the manager's address", own_r and "cc " + MGR_ADDR in own_r, own_r[:300])
    s.check("...and the other row shows no cc", team_r and "cc " not in re.sub(r"<[^>]+>", " ", team_r), team_r[:300])

    s.section("the schedule form, through the real admin route")
    cc_on(False)
    page = html.unescape(sup.get("/admin/reminders").get_data(as_text=True))
    s.check("the card has the row: 'Copy their line manager' and its note, unticked while off",
            "Copy their line manager" in page and "only while their own part or 360 ratings are still waiting" in page
            and "never the Executive Chairman or a BG CEO" in page
            and re.search(r'<input type="checkbox" name="cc_lm"\s*>', page), re.findall(r'name="cc_lm"[^>]*>', page))
    form = re.search(r'<form[^>]*id="rm-rules".*?</form>', page, re.S)
    s.check("...inside the schedule form's fieldset (so the read-only view disables it)",
            form and re.search(r"<fieldset.*name=\"cc_lm\".*</fieldset>", form.group(0), re.S) is not None)
    post = lambda **kw: sup.post("/admin/reminders", data=dict({"csrf_token": "tok", "action": "save_schedule", "enabled": "on",
                                                              "on_open": "on", "every_days": "0", "send_time": "09:00"}, **kw),
                                 follow_redirects=True)
    r = post(cc_lm="on")
    s.check("saving with the box ticked turns the setting on", r.status_code == 200 and ctx(lambda d: a.reminder_rules())["cc_lm"] is True)
    s.check("...and the page shows it ticked", re.search(r'name="cc_lm"\s+checked', html.unescape(sup.get("/admin/reminders").get_data(as_text=True))) is not None)
    s.check("...and the activity log says so", ctx(lambda d: "copy line manager=True" in (d.execute(
        "SELECT detail FROM activity_log WHERE action='reminder_schedule' ORDER BY id DESC LIMIT 1").fetchone() or [""])[0]))
    r = post()
    s.check("saving with the box unticked turns it off", r.status_code == 200 and ctx(lambda d: a.reminder_rules())["cc_lm"] is False)
    s.check("a POST without the CSRF token is refused and changes nothing", sup.post("/admin/reminders", data={
        "action": "save_schedule", "enabled": "on", "on_open": "on", "cc_lm": "on", "send_time": "09:00"}).status_code in (400, 403)
            and ctx(lambda d: a.reminder_rules())["cc_lm"] is False)
    emp = H.client_as(a, P["OWN"])
    s.check("an employee cannot save it", emp.post("/admin/reminders", data={"csrf_token": "tok", "action": "save_schedule",
                                                                         "enabled": "on", "on_open": "on", "cc_lm": "on",
                                                                         "send_time": "09:00"}).status_code in (302, 403, 404)
            and ctx(lambda d: a.reminder_rules())["cc_lm"] is False)

    s.section("another caller of set_reminder_rules leaves it alone")
    cc_on(True)
    ctx(lambda d: a.set_reminder_rules(False, False, [], 7, "10:00"))
    s.check("set_reminder_rules(...) without cc_lm keeps it on", ctx(lambda d: a.reminder_rules())["cc_lm"] is True)
    sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "auto", "enabled": "on"})
    s.check("...and so does Email > Schedule's own switch (action auto)", ctx(lambda d: a.reminder_rules())["cc_lm"] is True)
    ctx(lambda d: a.set_reminder_rules(True, True, [3], 0, "09:00", cc_lm=False))
    s.check("an explicit False turns it off", ctx(lambda d: a.reminder_rules())["cc_lm"] is False)

    s.section("the table")
    cols_ = ctx(lambda d: [r[1] for r in d.execute("PRAGMA table_info(email_outbox)")])
    s.check("email_outbox has cc_email, and _outbox_add stores it only when given", "cc_email" in cols_
            and ctx(lambda d: (lambda i: (d.execute("SELECT cc_email FROM email_outbox WHERE id=?", (i,)).fetchone()[0],))(
                a._outbox_add(d, "zz_lc_other", "x" + DOM, "S", "B", user_id=P["OWN"], cycle_id=CID, cc_email="  "))) == (None,))
    s.check("the guarded ALTER is in the runtime schema as well as the CREATE", "ADD COLUMN cc_email TEXT" in inspect.getsource(a._ensure_runtime_schema)
            and "cc_email TEXT)" in inspect.getsource(a._ensure_runtime_schema))
finally:
    (a.mailer.send_mail, a.mailer.is_configured, a.mailer.get_token, a.OUTBOX_ASYNC, a.reminder_items, a._outbox_kick,
     a.gradeh_rm_cid, a.gradeh_staff_case) = _real
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        db.execute("DELETE FROM app_settings WHERE key LIKE 'reminder_%'")
        db.execute("DELETE FROM app_settings WHERE key=?", (a.CHAIR_SETTING_ID,))
        for k_, v_ in SAVED_CHAIR.items():
            db.execute("INSERT INTO app_settings(key, value) VALUES (?,?)", (k_, v_))
        if SAVED_FLAG is None:
            os.environ.pop("ONEHR_CHAIR", None)
        else:
            os.environ["ONEHR_CHAIR"] = SAVED_FLAG
        for k_, v_ in SAVED.items():
            db.execute("INSERT INTO app_settings(key, value) VALUES (?,?)", (k_, v_))
        db.commit()

sys.exit(s.done())
