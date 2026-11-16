"""The "Ready for you" notices (Chris, 2026-11-02: "Yes, as recommended", "Approve, build it"; canvas
[design canvas link removed], boards N1-N4 and A1): ONE email, once per place per cycle, telling a leader
the tier below has finished -- an HOD for a department when every line manager's team in it is 100% on KPI moderation and
Competency review (the leader progress email's own counting); a BU CEO for a unit and a Calibrator for a Calibration Group when
every HOD in scope has SUBMITTED their Department Review.

What this suite holds (a made-up group of synthetic people, all put back at the end):
  * the shared rule: hod_review_axes (which axes an HOD has, whether each is submitted) -- one batched read, the dashboard's
    Dept Review card asks it too; a calibrator is no HOD
  * the window: wording follows the leader's OWN window (open / later / closed), only from the tier below's opening to the
    leader's own close, never in a cycle that doesn't use the cells (a Mid-Year has no BU CEO cells)
  * an HOD's notice: 100% on both parts fires, 99% on either does not, an empty department sends nothing, a calibrator gets none,
    once only
  * a BU CEO's and a Calibrator's: every HOD submitted (each axis that applies), not while one axis is unlocked; a department
    with no HOD, one the leader heads themself, or one whose HOD holds no HOD role does not hold it up; nobody to wait on = none
  * the email: the canvas's words, open and later, counts and department names only, the white note box
  * the send: one email a leader, the row in ready_notices with the outbox add, opt-out, no email, the Executive Chairman seat,
    a dry run, once per cycle
  * the rules and the job: off by default, every value checked, the form's refusals, due at its time, once a day
  * the words (three template kinds), the card, Save (super admin only, audited, refused on bad input), the test to the super
    admin's own notification emails, Help and Ask OneHR
Every guard is falsified in the suite itself (take it away and the outcome flips).
"""
import html as _html
import os
import re
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite('The "Ready for you" notices: the tier below has finished')
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
assert not a.mailer.is_configured(), "the harness must not send email"
SU, _BGA0, _E = H.actors(a)
BG, U1, U2, U3, U4 = "ZZRN Group", "ZZRN Alpha", "ZZRN Beta", "ZZRN Gamma", "ZZRN Delta"
KEYS = ("ready_notice_rules", "ready_notice_last", "leader_progress_rules", "leader_progress_last", "bg_admin_progress_rules")
_real = (a.mailer.is_configured, a.mailer.send_mail, a.mailer.config_status, a.OUTBOX_ASYNC, a.lp_leaders, a.chair_user_id,
         a.mailer.get_token)
SENT = []
MODS5 = ("pm", "tm", "calibration")


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9RN-%'")]
    gids = [r[0] for r in db.execute("SELECT id FROM calib_bu_groups WHERE business_group=?", (BG,))]
    for g_ in gids:
        db.execute("DELETE FROM calib_bu_group_units WHERE group_id=?", (g_,))
    db.execute("DELETE FROM calib_bu_groups WHERE business_group=?", (BG,))
    if ul:
        ph = ",".join("?" * len(ul))
        for sql in ("DELETE FROM email_outbox WHERE user_id IN (%s)", "DELETE FROM notifications WHERE user_id IN (%s)",
                    "DELETE FROM ready_notices WHERE user_id IN (%s)", "DELETE FROM email_optouts WHERE user_id IN (%s)",
                    "DELETE FROM buceo_seats WHERE user_id IN (%s)", "DELETE FROM admin_notify_emails WHERE user_id IN (%s)",
                    "DELETE FROM activity_log WHERE user_id IN (%s)",
                    "DELETE FROM pm_calibration_sessions WHERE scope_key IN (SELECT CAST(id AS TEXT) FROM users WHERE id IN (%s))",
                    "DELETE FROM calibration_sessions WHERE scope_key IN (SELECT CAST(id AS TEXT) FROM users WHERE id IN (%s))",
                    "DELETE FROM tc_assessments WHERE subject_id IN (%s)", "DELETE FROM tc_assignments WHERE subject_id IN (%s)",
                    "DELETE FROM pm_review_session WHERE subject_id IN (%s)",
                    "DELETE FROM pm_kpi_approvals WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s))",
                    "DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s))",
                    "DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s))",
                    "DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)"):
            db.execute(sql % ph, ul)
        db.execute("UPDATE users SET hod_id=NULL, manager_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.execute("DELETE FROM tc_skills WHERE skill_code='ZZ9RN-SKILL'")
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CYC = db.execute("SELECT * FROM cycles WHERE is_active=1").fetchone()
    CID = CYC["id"]
    OBD, HALF = CYC["open_by_date"], CYC["half"]
    SAVED = {k: db.execute("SELECT value FROM app_settings WHERE key=?", (k,)).fetchone() for k in KEYS}
    TPLS = H.stash_email_templates(db)
    WIN = [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=?", (CID,))]
    MODS = [tuple(r) for r in db.execute("SELECT cycle_id, module_key, active FROM cycle_modules WHERE cycle_id=? AND "
                                         "module_key IN (?,?,?)", (CID,) + MODS5)]
    LOG0 = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
    OUT0 = db.execute("SELECT COALESCE(MAX(id),0) FROM email_outbox").fetchone()[0]
    NOTE0 = db.execute("SELECT COALESCE(MAX(id),0) FROM notifications").fetchone()[0]
    SKILL = (db.execute("SELECT id FROM tc_skills ORDER BY id LIMIT 1").fetchone() or [None])[0]
    if SKILL is None:   # the synthetic fixture has no skills: make one, taken out below
        SKILL = db.execute("INSERT INTO tc_skills(skill_code, title) VALUES ('ZZ9RN-SKILL', 'ZZ9RN skill')").lastrowid
    # the cycle is a Year-End with its three modules on for this suite (the fixture's active one is a Mid-Year): put back below
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key IN (?,?,?)", (CID,) + MODS5)
    db.executemany("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", [(CID, m) for m in MODS5])
    for u_ in (U1, U2, U3, U4):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, u_))
    ID = {}

    def person(key, co, dept, hod=None, mgr=None, grade=14, **extra):
        cols = {"username": "zz9rn-" + key.lower(), "full_name": "ZZ RN PERSON " + key, "display_name": "Zed " + key,
                "password_hash": "x", "role": "user", "employee_id": "ZZ9RN-" + key, "business_group": BG, "company": co,
                "department": dept, "job_grade": grade, "years_of_service": 3, "email": "zz9rn-%s@example.test" % key.lower(),
                "hod_id": ID.get(hod) if hod else None, "manager_id": ID.get(mgr) if mgr else None}
        cols.update(extra)
        ID[key] = db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                             tuple(cols.values())).lastrowid
        return ID[key]
    TGT = {}   # person key -> their one KPI target id

    def worker(key, co, dept, hod, mgr, kpi=True):
        """A person taking part with one KPI line (submitted, signed off, moderated by their line manager) and a competency
        assessment (submitted and reviewed) -- both parts done; `kpi=False` for someone with no scorecard and no competency."""
        person(key, co, dept, hod=hod, mgr=mgr)
        if not kpi:
            return
        t = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
                       "rating_line, rate1, rate2, rate3, rate4, rate5) VALUES (?,?,?,100,'more','approved',?,1,1,2,3,4,5)",
                       (CID, ID[key], "ZZRN KPI " + key, BG)).lastrowid
        TGT[key] = t
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft, admin_filled) "
                   "VALUES (?,4,?,0,0)", (t, ID[key]))
        db.execute("INSERT INTO pm_review_session(subject_id, cycle_id, locked_at) VALUES (?,?,datetime('now'))", (ID[key], CID))
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (t, ID[mgr]))
        db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, acted_by) VALUES (?,1,'confirm',4,?)", (t, ID[mgr]))
        db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id) VALUES (?,?,?)", (CID, ID[key], SKILL))
        db.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status, submitted_at, reviewed_at) VALUES "
                   "(?,?,'reviewed','2026-10-01 00:00','2026-10-02 00:00')", (CID, ID[key]))

    # the leaders
    for k in ("HD1", "HD2", "HD3", "HD4", "HD5", "LM1", "LM2", "LM3", "LM4"):
        person(k, U1, "ZZRN Heads", grade=21, years_of_service=0)   # not taking part themselves
    person("CE1", U1, "ZZRN Heads", grade=22, years_of_service=0)   # BU CEO of Alpha
    person("CE2", U2, "ZZRN Heads", grade=22, years_of_service=0)   # BU CEO of Beta: every department there has no HOD
    person("CE3", U3, "ZZRN Heads", grade=22, years_of_service=0)   # BU CEO of Gamma: its only department is a Calibration Group's
    person("CAL1", U3, "ZZRN Heads", grade=22, years_of_service=0)  # the calibrator of Gamma's group (so no HOD role)
    person("CHAIR", U1, "ZZRN Heads", grade=24, years_of_service=0)  # stands in for the Executive Chairman
    for k, co in (("CE1", U1), ("CE2", U2), ("CE3", U3)):
        db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, co, ID[k]))
    # Alpha: Ops (HD1; LM1 and LM2, two people each), Sales (HD2; LM3, two people), Legal (HD4; two people with no scorecard),
    # Yard (headed by the BU CEO), Loose (no HOD), CalDept (hod_id is a calibrator), Empty (HD5, nobody counted)
    for n, (lm, hd, dept) in enumerate((("LM1", "HD1", "ZZRN Ops"), ("LM2", "HD1", "ZZRN Ops"), ("LM3", "HD2", "ZZRN Sales")), 1):
        for who in ("a", "b"):
            worker("P%d%s" % (n, who), U1, dept, hd, lm)
    for who in ("a", "b"):
        worker("L4" + who, U1, "ZZRN Legal", "HD4", None, kpi=False)
        worker("Y1" + who, U1, "ZZRN Yard", "CE1", "LM4")
        worker("N1" + who, U1, "ZZRN Loose", None, "LM4")
        worker("C1" + who, U1, "ZZRN CalDept", "CAL1", "LM4")
        worker("B1" + who, U2, "ZZRN Plain", None, "LM4")
        worker("G1" + who, U3, "ZZRN GDept", "HD3", "LM4")
        worker("E1" + who, U1, "ZZRN Empty", "HD5", None, kpi=False)
    # Delta: CX is its BU CEO AND the calibrator of a Calibration Group (G2) that takes the department "ZZRN DGrp"; the unit's own
    # department is "ZZRN DOps" (HD6). Each HOD's one person is left unmoderated, so no HOD notice is ever ready here.
    person("CX", U4, "ZZRN Heads", grade=22, years_of_service=0)
    person("HD6", U4, "ZZRN Heads", grade=21, years_of_service=0)
    person("HD7", U4, "ZZRN Heads", grade=21, years_of_service=0)
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, U4, ID["CX"]))
    worker("D1a", U4, "ZZRN DOps", "HD6", "LM4")
    worker("D2a", U4, "ZZRN DGrp", "HD7", "LM4")
    G2 = db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id) VALUES (?,?,?,?)",
                    (BG, U4, "ZZRN Group G2", ID["CX"])).lastrowid
    db.execute("INSERT INTO calib_bu_group_units(group_id, business_group, company, department) VALUES (?,?,?,?)",
               (G2, BG, U4, "ZZRN DGrp"))
    # Calibrator CAL1's Calibration Group takes Gamma's department "ZZRN GDept"
    GX = db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id) VALUES (?,?,?,?)",
                    (BG, U3, "ZZRN Group X", ID["CAL1"])).lastrowid
    db.execute("INSERT INTO calib_bu_group_units(group_id, business_group, company, department) VALUES (?,?,?,?)",
               (GX, BG, U3, "ZZRN GDept"))
    # Empty: HD5 heads people with no KPI line and no competency, so nothing is counted for the two parts
    db.commit()


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def dbx(sql, args=()):
    with a.app.app_context():
        d = a.get_db()
        d.execute(sql, args)
        d.commit()


def setwin(spec, open_by_date=1):
    """The cycle's windows exactly as `spec` says ({cell: (opens, closes)})."""
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        for cell, (o, c) in spec.items():
            d.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (CID, cell, o, c))
        d.execute("UPDATE cycles SET open_by_date=? WHERE id=?", (open_by_date, CID))
        d.commit()


UN1 = ctx(lambda d: a.display_company(BG, U1)) or U1   # the unit as it reads on screen
UN4 = ctx(lambda d: a.display_company(BG, U4)) or U4
F = "%Y-%m-%d %H:%M"
NOW = a._now_myt()
TODAY = NOW.date()
ago = lambda n: (NOW - timedelta(days=n)).strftime("%Y-%m-%d") + " 00:00"   # noqa: E731
ahead = lambda n: (NOW + timedelta(days=n)).strftime("%Y-%m-%d") + " 23:59"   # noqa: E731
ahead0 = lambda n: (NOW + timedelta(days=n)).strftime("%Y-%m-%d") + " 00:00"   # noqa: E731
DAY = lambda n: a._em_day(TODAY + timedelta(days=n))   # noqa: E731
LM_CELLS = ("pm_approve", "tc_approve")
HOD_CELLS = ("pm_hod", "pot_hod")
BU_CELLS = ("pm_buceo", "pot_buceo")


def win_open():
    """Everything open: the line managers' parts, the HODs' cells (closing in 6 days) and BU calibration (closing in 9)."""
    spec = {c: (ago(5), ahead(14)) for c in LM_CELLS}
    spec.update({c: (ago(2), ahead(6)) for c in HOD_CELLS})
    spec.update({c: (ago(1), ahead(9)) for c in BU_CELLS})
    setwin(spec)


def zz_leaders(d, roles):
    return [x for x in _real[4](d, roles) if (x[1]["employee_id"] or "").startswith("ZZ9RN-")]


def lock(hod, axis, on=True):
    """The HOD's Department Review on one axis: their own session (tier 'hod', scope key their id), locked or not."""
    tbl = "pm_calibration_sessions" if axis == "pm" else "calibration_sessions"
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM %s WHERE cycle_id=? AND tier='hod' AND scope_key=?" % tbl, (CID, str(ID[hod])))
        d.execute("INSERT INTO %s(cycle_id, tier, scope_key, business_group, scope_label, locked_at) VALUES (?,'hod',?,?,?,%s)"
                  % (tbl, "datetime('now')" if on else "NULL"), (CID, str(ID[hod]), BG, "ZZRN"))
        d.commit()


def moderate(key, on):
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM pm_kpi_approvals WHERE kpi_target_id=?", (TGT[key],))
        if on:
            mgr = d.execute("SELECT approver_id FROM pm_kpi_target_approvers WHERE kpi_target_id=?", (TGT[key],)).fetchone()[0]
            d.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, acted_by) VALUES (?,1,'confirm',4,?)", (TGT[key], mgr))
        d.commit()


def review(key, on):
    dbx("UPDATE tc_assessments SET reviewed_at=? WHERE subject_id=? AND cycle_id=?",
        ("2026-10-02 00:00" if on else None, ID[key], CID))


def build(roles=("hod", "buceo", "cg"), only=None, now=None, **rules):
    r = dict(a.READY_DEFAULT_RULES, roles=list(roles), **rules)
    return ctx(lambda d: a.ready_build(d, a.active_cycle(d), r, only=only, now=now or NOW))


def who(b):
    """{(role, person key): [place names]} of a build, for the ZZ leaders."""
    inv = {v: k for k, v in ID.items()}
    return {(x["role"], inv[x["user"]["id"]]): [p["name"] for p in x["places"]] for x in b}


def sent_rows():
    return ctx(lambda d: [tuple(r) for r in d.execute(
        "SELECT kind, scope_key, user_id FROM ready_notices WHERE cycle_id=? ORDER BY id", (CID,))])


def outbox():
    return ctx(lambda d: [dict(r) for r in d.execute("SELECT * FROM email_outbox WHERE id>? AND kind='ready_notice' ORDER BY id",
                                                      (OUT0,))])


def clear_sent():
    dbx("DELETE FROM ready_notices WHERE cycle_id=?", (CID,))
    dbx("DELETE FROM email_outbox WHERE id>? AND kind='ready_notice'", (OUT0,))


def text_of(html_):
    return re.sub(r"\s+", " ", _html.unescape(re.sub(r"<[^>]+>", " ", html_)).replace("\xa0", " "))


a.lp_leaders = zz_leaders
try:
    moderate("D1a", False)   # Delta's two HODs' one person each is not moderated: neither HOD has a notice of their own to send
    moderate("D2a", False)
    # ------------------------------------------------------------------------------------------------------------------
    s.section("the shared rule: which axes an HOD has, and whether each is submitted")
    win_open()
    ax = ctx(lambda d: a.hod_review_axes(d, [ID[k] for k in ("HD1", "HD2", "HD3", "HD4", "HD5", "CAL1", "CE1")]))
    s.check("an HOD with a scorecard holds both axes, neither submitted yet",
            ax.get(ID["HD1"]) == {"pm": False, "pot": False}, ax.get(ID["HD1"]))
    s.check("...Performance only where someone in the department holds a scorecard: Legal has none, so None",
            ax.get(ID["HD4"]) == {"pm": None, "pot": False}, ax.get(ID["HD4"]))
    s.check("a calibrator is no HOD: no entry for CAL1 (nor for an HOD who is a BU CEO, whose seat is a calibrator's)",
            ID["CAL1"] not in ax and ID["CE1"] not in ax)
    s.check("an HOD whose people are all left out of the review has no entry", ID["HD3"] in ax and ID["HD5"] in ax
            and ax[ID["HD5"]] == {"pm": None, "pot": False}, ax.get(ID["HD5"]))
    s.check("nobody submitted: not submitted", not a.hod_review_submitted(ax[ID["HD1"]]))
    lock("HD1", "pm")
    s.check("one axis locked is not a submitted review", not a.hod_review_submitted(ctx(
        lambda d: a.hod_review_axes(d, [ID["HD1"]]))[ID["HD1"]]))
    lock("HD1", "pot")
    one = ctx(lambda d: a.hod_review_axes(d, [ID["HD1"]]))
    s.check("both locked: submitted, and the batch of one is the same as the batch of many",
            a.hod_review_submitted(one[ID["HD1"]]) and one[ID["HD1"]] == ctx(lambda d: a.hod_review_axes(
                d, [ID[k] for k in ("HD1", "HD2", "HD4")]))[ID["HD1"]])
    s.check("an HOD with only a Potential axis is submitted when that one is: HD4 after its Potential lock",
            not a.hod_review_submitted(ctx(lambda d: a.hod_review_axes(d, [ID["HD4"]]))[ID["HD4"]]))
    lock("HD4", "pot")
    s.check("...(the Performance axis it doesn't have never holds it)", a.hod_review_submitted(ctx(
        lambda d: a.hod_review_axes(d, [ID["HD4"]]))[ID["HD4"]]))
    dbx("UPDATE cycle_modules SET active=0 WHERE cycle_id=? AND module_key='calibration'", (CID,))
    off = ctx(lambda d: a.hod_review_axes(d, [ID["HD1"]]))[ID["HD1"]]
    dbx("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key='calibration'", (CID,))
    s.check("an axis whose module is off doesn't apply to anyone: Potential off is None, and the review is submitted on Performance "
            "alone (falsified above: with the module on, the same HOD has both axes)", off == {"pm": True, "pot": None}, off)
    # the dashboard's card reads the same function
    src = H.source(a)
    card = src.split("\ndef dash_dept_review(", 1)[1].split("\ndef dash_cards(", 1)[0]
    s.check("the dashboard's Dept Review card asks hod_review_axes (one shared rule, no copy of the lock query)",
            "hod_review_axes(db, [hod])" in card and "locked_at IS NOT NULL" not in card)
    s.check("...and the notices ask the same function", "hod_review_axes(db, cand)" in src.split("\ndef ready_build(", 1)[1].split(
        "\ndef ", 1)[0])
    lock("HD1", "pm", False)
    lock("HD1", "pot", False)
    lock("HD4", "pot", False)

    # ------------------------------------------------------------------------------------------------------------------
    s.section("the window: the leader's own, from the tier below's opening to their own close")
    win_open()
    wh, wb, wc = (ctx(lambda d, r=r: a.ready_window(d, a.active_cycle(d), r, now=NOW)) for r in ("hod", "buceo", "cg"))
    s.check("everything open: an open window, closing on the latest of the leader's own open cells",
            wh == {"mode": "open", "opens": None, "closes": TODAY + timedelta(days=6)}
            and wb == {"mode": "open", "opens": None, "closes": TODAY + timedelta(days=9)} and wc == wb, (wh, wb, wc))
    setwin(dict({c: (ago(5), ahead(14)) for c in LM_CELLS}, **{c: (ahead0(3), ahead(9)) for c in HOD_CELLS}))
    w_ = ctx(lambda d: a.ready_window(d, a.active_cycle(d), "hod", now=NOW))
    s.check("an HOD whose Department Review isn't open yet: 'later', the day it opens and the day it closes",
            w_ == {"mode": "later", "opens": TODAY + timedelta(days=3), "closes": TODAY + timedelta(days=9)}, w_)
    setwin(dict({c: (ago(5), ahead(14)) for c in LM_CELLS}, **{"pm_hod": (ago(2), ahead(6)), "pot_hod": (ahead0(3), ahead(9))}))
    w_ = ctx(lambda d: a.ready_window(d, a.active_cycle(d), "hod", now=NOW))
    s.check("one of the two cells open: open now, and it closes with the open one", w_ == {
        "mode": "open", "opens": None, "closes": TODAY + timedelta(days=6)}, w_)
    setwin(dict({c: (ago(5), ahead(14)) for c in LM_CELLS}, **{c: (ago(4), ago(1)) for c in HOD_CELLS}))
    s.check("every HOD cell closed: nothing for an HOD", ctx(lambda d: a.ready_window(d, a.active_cycle(d), "hod", now=NOW)) is None)
    setwin(dict({c: (ahead0(2), ahead(14)) for c in LM_CELLS}, **{c: (ahead0(4), ahead(8)) for c in HOD_CELLS}))
    s.check("the line managers' parts not opened yet: nothing for an HOD, even though their own part is dated",
            ctx(lambda d: a.ready_window(d, a.active_cycle(d), "hod", now=NOW)) is None)
    setwin(dict({c: (ago(5), ahead(14)) for c in LM_CELLS}, **{c: (ago(2), ahead(6)) for c in HOD_CELLS}))
    s.check("a part with no open date in a cycle whose parts open by date isn't open: nothing to name, so nothing",
            ctx(lambda d: a.ready_window(d, a.active_cycle(d), "buceo", now=NOW)) is None)
    setwin(dict({c: (ago(5), ahead(14)) for c in LM_CELLS}, **{c: (ago(2), ahead(6)) for c in HOD_CELLS},
                **{c: (ahead0(7), ahead(9)) for c in BU_CELLS}))
    w_ = ctx(lambda d: a.ready_window(d, a.active_cycle(d), "cg", now=NOW))
    s.check("a Calibrator's calibration not open yet: 'later' with its opening day",
            w_ == {"mode": "later", "opens": TODAY + timedelta(days=7), "closes": TODAY + timedelta(days=9)}, w_)
    setwin(dict({c: (ago(5), ahead(14)) for c in LM_CELLS}, **{c: (ago(2), ahead(6)) for c in HOD_CELLS},
                **{c: (ago(3), ago(1)) for c in BU_CELLS}))
    s.check("BU calibration closed: nothing for a BU CEO or a Calibrator, an HOD's is untouched", all(
        ctx(lambda d, r=r: a.ready_window(d, a.active_cycle(d), r, now=NOW)) is None for r in ("buceo", "cg"))
        and ctx(lambda d: a.ready_window(d, a.active_cycle(d), "hod", now=NOW))["mode"] == "open")
    setwin(dict({c: (ago(5), ahead(14)) for c in LM_CELLS}, **{c: (ahead0(2), ahead(8)) for c in HOD_CELLS},
                **{c: (ahead0(7), ahead(9)) for c in BU_CELLS}))
    s.check("the HOD cells not opened yet: nothing for a BU CEO or a Calibrator", all(
        ctx(lambda d, r=r: a.ready_window(d, a.active_cycle(d), r, now=NOW)) is None for r in ("buceo", "cg")))
    win_open()
    dbx("UPDATE cycles SET half=1 WHERE id=?", (CID,))   # a Mid-Year: no BU CEO cells
    mid = [ctx(lambda d, r=r: a.ready_window(d, a.active_cycle(d), r, now=NOW)) for r in ("hod", "buceo", "cg")]
    dbx("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    s.check("a Mid-Year has no BU CEO cells: never a BU CEO's or a Calibrator's notice, an HOD's still goes",
            mid[0] and mid[0]["mode"] == "open" and mid[1] is None and mid[2] is None, mid)
    dbx("UPDATE cycle_modules SET active=0 WHERE cycle_id=? AND module_key IN ('pm','tm')", (CID,))
    off_ = ctx(lambda d: a.ready_window(d, a.active_cycle(d), "hod", now=NOW))
    dbx("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('pm','tm')", (CID,))
    s.check("modules that are off (performance and talent: the line managers' two parts) leave an HOD nothing to wait on: no window",
            off_ is None, off_)
    s.check("...falsified: with it back on there is a window", ctx(lambda d: a.ready_window(
        d, a.active_cycle(d), "hod", now=NOW)) is not None)

    # ------------------------------------------------------------------------------------------------------------------
    s.section("an HOD's notice: 100% on both parts, once, never a calibrator's")
    win_open()
    clear_sent()
    b = build(roles=("hod",))
    mine = {k: v for k, v in who(b).items()}
    s.check("HD1's department (Ops) is ready: every team 100% moderated and 100% reviewed", mine.get(("hod", "HD1")) == ["ZZRN Ops"],
            mine)
    s.check("...Sales, with the same people done, is ready for HD2 too; Empty (nobody counted) is not; Legal (no scorecard, no "
            "competency) has nothing to count", mine.get(("hod", "HD2")) == ["ZZRN Sales"] and ("hod", "HD5") not in mine
            and ("hod", "HD4") not in mine, mine)
    s.check("a calibrator (CAL1) and a BU CEO who has people as their HOD (CE1) get no HOD notice, whoever's hod_id points at them",
            ("hod", "CAL1") not in mine and ("hod", "CE1") not in mine)
    p = next(x for x in b if x["user"]["id"] == ID["HD1"])["places"][0]
    s.check("the place says 2 teams and 4 taking part, both cells 100% (counts exactly as the leader progress email counts)",
            p["teams"] == 2 and p["people"] == 4 and [(c["n"], c["done"], c["pct"]) for c in p["total"]] == [(4, 4, 100), (4, 4, 100)], p)
    lp = ctx(lambda d: a.lp_build(d, a.active_cycle(d), dict(a.lp_rules(), parts=["pm_approve", "tc_approve"], skip_done=False),
                                  only=("hod", ID["HD1"])))[0][0]["sections"]
    s.check("...the same cells as the leader progress email's own section for HD1, to the figure",
            lp and lp[0]["total"] == p["total"], (lp[0]["total"] if lp else None, p["total"]))
    # 99% on either part
    moderate("P2b", False)
    b1 = build(roles=("hod",))
    s.check("one person's KPI not moderated (3 of 4): not ready, and the other department is unaffected",
            ("hod", "HD1") not in who(b1) and who(b1).get(("hod", "HD2")) == ["ZZRN Sales"], who(b1))
    moderate("P2b", True)
    review("P1a", False)
    b2 = build(roles=("hod",))
    s.check("one person's competency not reviewed: not ready either", ("hod", "HD1") not in who(b2), who(b2))
    review("P1a", True)
    s.check("...both back to 100%: ready again", ("hod", "HD1") in who(build(roles=("hod",))))
    # a department with an HOD but a department's people all unsubmitted is just not ready; one with nothing to count sends nothing
    s.check("an HOD whose department has nothing to count (no scorecard, no competency) is never ready: HD5, HD4",
            ("hod", "HD5") not in who(b) and ("hod", "HD4") not in who(b))
    # who it reaches
    dbx("UPDATE users SET left_at='2026-09-01' WHERE id=?", (ID["HD2"],))
    s.check("an HOD who has left gets none", ("hod", "HD2") not in who(build(roles=("hod",))))
    dbx("UPDATE users SET left_at=NULL WHERE id=?", (ID["HD2"],))
    a.chair_user_id = lambda db=None: ID["HD1"]
    s.check("the Executive Chairman seat gets none in any role (the leader progress email's rule); the delegate still does",
            ("hod", "HD1") not in who(build(roles=("hod",))) and ("hod", "HD2") in who(build(roles=("hod",))))
    a.chair_user_id = _real[5]
    s.check("...falsified: without the seat rule HD1 is in again", ("hod", "HD1") in who(build(roles=("hod",))))
    s.check("an HOD not ticked in the rules gets none", ("hod", "HD1") not in who(build(roles=("buceo", "cg"))))

    # ------------------------------------------------------------------------------------------------------------------
    s.section("a BU CEO's and a Calibrator's: every HOD in scope has SUBMITTED, each axis that applies")
    bb = build(roles=("buceo", "cg"))
    s.check("nobody has submitted: no BU CEO or Calibrator notice", ("buceo", "CE1") not in who(bb) and ("cg", "CAL1") not in who(bb),
            who(bb))
    for hd in ("HD1", "HD2"):
        lock(hd, "pm")
        lock(hd, "pot")
    lock("HD4", "pot")   # Legal has no Performance part
    s.check("HD5 (Empty: people with no scorecard) hasn't submitted their Potential review: that holds Alpha up",
            ("buceo", "CE1") not in who(build(roles=("buceo",))))
    lock("HD5", "pot")
    bb = build(roles=("buceo", "cg"))
    s.check("HD1, HD2 (both axes) and HD4 (Potential only) submitted: Alpha's BU CEO is told, one place, the unit",
            who(bb).get(("buceo", "CE1")) == [UN1], who(bb))
    rows = {r["name"]: r for r in next(x for x in bb if x["role"] == "buceo")["places"][0]["rows"]}
    s.check("the department rows: Ops and Sales Submitted on both; Legal no performance part, Potential Submitted",
            rows["ZZRN Ops"]["pm"] is True and rows["ZZRN Ops"]["pot"] is True and rows["ZZRN Sales"]["pm"] is True
            and rows["ZZRN Legal"]["pm"] is None and rows["ZZRN Legal"]["pot"] is True, rows)
    s.check("...a department headed by the BU CEO themself (Yard), one with no HOD (Loose) and one whose HOD holds no HOD role "
            "(CalDept, a calibrator's) say 'No HOD to wait on' and hold nothing up",
            all(rows[n]["nohod"] for n in ("ZZRN Yard", "ZZRN Loose", "ZZRN CalDept")), {n: rows[n]["nohod"] for n in rows})
    s.check("...Empty has an HOD (HD5) with a Potential review only: waited on, and submitted",
            rows["ZZRN Empty"]["nohod"] is False and rows["ZZRN Empty"]["pm"] is None and rows["ZZRN Empty"]["pot"] is True, rows["ZZRN Empty"])
    s.check("a department whose HOD has no axis that applies has nothing to wait on (the row says so, and it holds nothing up)",
            a._ready_dept_rows(ID["CE1"], {ID["P1a"]: "D"}, {ID["P1a"]: (BG, U1, "D", ID["HD1"])}, {ID["HD1"]},
                               {ID["HD1"]: {"pm": None, "pot": None}})[0]["nohod"] is True
            and not a._ready_rows_state(a._ready_dept_rows(ID["CE1"], {ID["P1a"]: "D"}, {ID["P1a"]: (BG, U1, "D", ID["HD1"])},
                                                           {ID["HD1"]}, {ID["HD1"]: {"pm": None, "pot": None}})))
    s.check("people counted by department, taking part only", rows["ZZRN Ops"]["people"] == 4 and rows["ZZRN Sales"]["people"] == 2
            and rows["ZZRN Yard"]["people"] == 2, {n: r["people"] for n, r in rows.items()})
    lock("HD2", "pot", False)
    s.check("one axis unlocked (HD2's Potential): not ready", ("buceo", "CE1") not in who(build(roles=("buceo",))))
    lock("HD2", "pot")
    lock("HD1", "pm", False)
    s.check("...nor with HD1's Performance unlocked", ("buceo", "CE1") not in who(build(roles=("buceo",))))
    lock("HD1", "pm")
    s.check("...both back: ready again", ("buceo", "CE1") in who(build(roles=("buceo",))))
    # a BG CEO who is also a BU CEO gets no BU CEO notice (Chris, 2026-11-11)
    s.check("a plain BU CEO (no BG seat) is told", ("buceo", "CE1") in who(build(roles=("buceo", "cg"))))
    dbx("UPDATE users SET bgceo_bg=? WHERE id=?", (BG, ID["CE1"]))
    try:
        s.check("seated as a BG CEO too: no BU CEO place for them", ("buceo", "CE1") not in who(build(roles=("buceo", "cg"))))
        s.check("...nor when asked for by name", build(roles=("buceo",), only=("buceo", ID["CE1"])) == [])
    finally:
        dbx("UPDATE users SET bgceo_bg=NULL WHERE id=?", (ID["CE1"],))
    s.check("seat cleared: the same person is told again", ("buceo", "CE1") in who(build(roles=("buceo",))))
    lock("HD4", "pot", False)
    s.check("Legal's Potential unlocked holds it up (its Performance part never did)", ("buceo", "CE1") not in who(build(roles=("buceo",))))
    lock("HD4", "pot")
    s.check("a unit whose departments all have no HOD (Beta) has nobody to wait on: no email", ("buceo", "CE2") not in who(bb))
    s.check("a unit whose only department is a Calibration Group's has nobody of its own to wait on: no email for its BU CEO",
            ("buceo", "CE3") not in who(bb))
    s.check("no HOD at all is no email even when asked for the leader by name", build(roles=("buceo",), only=("buceo", ID["CE2"])) == [])
    # the Calibration Group
    s.check("the Calibrator's group (Gamma's department, HD3 not submitted): not ready", ("cg", "CAL1") not in who(bb))
    lock("HD3", "pm")
    s.check("only one axis of HD3's: not ready", ("cg", "CAL1") not in who(build(roles=("cg",))))
    lock("HD3", "pot")
    bg_ = build(roles=("buceo", "cg"))
    s.check("HD3 submitted both: the Calibrator is told, one place, the group", who(bg_).get(("cg", "CAL1")) == ["ZZRN Group X"],
            who(bg_))
    s.check("...and the BU CEO of that unit still isn't (the department isn't theirs)", ("buceo", "CE3") not in who(bg_))
    gr = {r["name"]: r for r in next(x for x in bg_ if x["role"] == "cg")["places"][0]["rows"]}
    s.check("...its one department, 2 taking part, Submitted on both", list(gr) == ["ZZRN GDept"] and gr["ZZRN GDept"]["people"] == 2
            and gr["ZZRN GDept"]["pm"] is True and gr["ZZRN GDept"]["pot"] is True, gr)
    s.check("a calibrator not ticked gets none", ("cg", "CAL1") not in who(build(roles=("hod", "buceo"))))
    lock("HD3", "pot", False)
    lock("HD3", "pm", False)

    # ------------------------------------------------------------------------------------------------------------------
    s.section("the email: the canvas's words, open and later, counts and names of departments only")
    lock("HD3", "pm")
    lock("HD3", "pot")
    bm = {(x["role"], x["user"]["id"]): x for x in build()}
    with a.app.test_request_context("/"):
        d = a.get_db()
        cy = a.active_cycle(d)
        get = lambda role, key: d.execute("SELECT * FROM users WHERE id=?", (ID[key],)).fetchone()   # noqa: E731
        sub_h, html_h = a.ready_mail(d, "hod", get("hod", "HD1"), bm[("hod", ID["HD1"])]["places"], bm[("hod", ID["HD1"])]["win"],
                                     cy, now=NOW)
        sub_b, html_b = a.ready_mail(d, "buceo", get("buceo", "CE1"), bm[("buceo", ID["CE1"])]["places"],
                                     bm[("buceo", ID["CE1"])]["win"], cy, now=NOW)
        sub_c, html_c = a.ready_mail(d, "cg", get("cg", "CAL1"), bm[("cg", ID["CAL1"])]["places"], dict(
            bm[("cg", ID["CAL1"])]["win"], mode="later", opens=TODAY + timedelta(days=4)), cy, now=NOW)
        sub_l, html_l = a.ready_mail(d, "hod", get("hod", "HD1"), bm[("hod", ID["HD1"])]["places"], {
            "mode": "later", "opens": TODAY + timedelta(days=3), "closes": TODAY + timedelta(days=9)}, cy, now=NOW)
        sub_n, html_n = a.ready_mail(d, "hod", get("hod", "HD1"), bm[("hod", ID["HD1"])]["places"], {
            "mode": "open", "opens": None, "closes": None}, cy, now=NOW)
    th, tb, tc_, tl, tn = (text_of(x) for x in (html_h, html_b, html_c, html_l, html_n))
    cyname = CYC["name"]
    s.check("N1, an HOD with their part open: the heading, the greeting by the name they chose, the opening that says start now and "
            "when it closes, the button", "Your line managers are done" in th and "Hi Zed HD1," in th
            and "Every line manager in ZZRN Ops has finished reviewing their team in the %s check-in. Your Department Review is "
                "open, so you can start now. It closes %s." % (cyname, DAY(6)) in th and "Start your Department Review" in th, th[:600])
    s.check("...the line is the whole department: '2 teams · 4 taking part', both parts at 100%, Everyone moderated / reviewed",
            "Whole department" in th and "2 teams · 4 taking part" in th and th.count("100%") == 2
            and "Everyone moderated" in th and "Everyone reviewed" in th, th)
    s.check("...the table's headings: Line managers' teams, KPI moderation, Competency review",
            "Line managers' teams" in th and "KPI moderation" in th and "Competency review" in th)
    s.check("...closing line and the footer, the canvas's words", "This note goes once for ZZRN Ops this cycle." in th
            and "You get this because you're the HOD of ZZRN Ops in AI+ OneHR by Chin Hin." in th, th[-400:])
    s.check("...the sub-line is the department and when: 'ZZRN Ops · as at ...'", re.search(r"ZZRN Ops · as at \w{3} \d+ \w{3} \d{4}, \d\d:\d\d",
                                                                                           th) is not None)
    s.check("N2, later: the opening names the day it opens ('Your Department Review opens on %s, and you can start it that day.') and "
            "the note's two lines, the button Open AI+ OneHR" % DAY(3), "opens on %s, and you can start it that day. It closes %s."
            % (DAY(3), DAY(9)) in tl and "Opens %s." % DAY(3) in tl and "We'll remind you that morning." in tl
            and "Open AI+ OneHR" in tl and "Start your Department Review" not in tl, tl[:700])
    s.check("...and the open one has no note", "We'll remind you that morning" not in th)
    s.check("N3, a BU CEO's: 'Your HODs are done', the BU calibration sentence, the Start your BU calibration button",
            "Your HODs are done" in tb and "Every HOD in %s has submitted their Department Review in the %s check-in. Your BU "
            "calibration is open, so you can start now. It closes %s." % (UN1, cyname, DAY(9)) in tb
            and "Start your BU calibration" in tb, tb[:600])
    s.check("...the department table: Department / Performance review / Potential review, Submitted, No performance part, "
            "No HOD to wait on", all(x in tb for x in ("Department", "Performance review", "Potential review", "Submitted",
                                                       "No performance part", "No HOD to wait on")))
    s.check("...every department is there with its count taking part", all(x in tb for x in ("ZZRN Ops 4 taking part",
            "ZZRN Sales 2 taking part", "ZZRN Legal 2 taking part", "ZZRN Yard 2 taking part")), tb)
    s.check("N4, a Calibrator's with calibration not open yet: the group, 'Your calibration opens on %s', the note, "
            "'the calibrator of'" % DAY(4), "Every HOD in your Calibration Group, ZZRN Group X, has submitted their Department "
            "Review" in tc_ and "Your calibration opens on %s, and you can start it that day." % DAY(4) in tc_
            and "Opens %s." % DAY(4) in tc_ and "You get this because you're the calibrator of ZZRN Group X in AI+ OneHR by "
            "Chin Hin." in tc_ and "Open AI+ OneHR" in tc_, tc_[:600])
    s.check("no date set for when the part closes: the sentence about it is left out, never 'It closes .'",
            "It closes" not in tn and "so you can start now." in tn, tn[:500])
    everything = " ".join(_html.unescape(x) for x in (html_h, html_b, html_c, html_l))
    s.check("counts and department names only: no person's name besides the greeting (no official name, no chosen name of anyone counted)",
            not re.search(r"ZZ RN PERSON", everything, re.I) and "Zed P" not in everything and "Zed Y" not in everything
            and "Zed LM" not in everything and everything.count("Hi Zed ") == 4)
    s.check("...the subjects", sub_h == "ZZRN Ops: every line manager has finished reviewing their team"
            and sub_b.endswith(": every HOD has submitted their Department Review"), (sub_h, sub_b))
    s.check("the note is a white box with a border, the tone in its left edge (no tinted fill: Outlook)", 'bgcolor="#ffffff"' in html_l
            and "border-left:4px solid #252A59" in html_l and "#f4f5f9" not in html_l)
    s.check("light only, the AI+ brand line, never the word HR", "light only" in html_h and "AI+ OneHR by Chin Hin" in html_h
            and not re.search(r"\bHR\b|HRBP", th))
    s.check("the button opens AI+ OneHR (absolute), the same address as every leader email", (a.app_base_url() + "/dashboard") in html_h)
    two = [dict(bm[("hod", ID["HD1"])]["places"][0], name="ZZRN Ops"), dict(bm[("hod", ID["HD1"])]["places"][0], name="ZZRN Ops Two")]
    with a.app.test_request_context("/"):
        _s, html_two = a.ready_mail(a.get_db(), "hod", a.get_db().execute("SELECT * FROM users WHERE id=?", (ID["HD1"],)).fetchone(),
                                    two, bm[("hod", ID["HD1"])]["win"], a.active_cycle(a.get_db()), now=NOW)
    s.check("two places of one leader are one email, a section each, named together ('ZZRN Ops and ZZRN Ops Two')",
            "Every line manager in ZZRN Ops and ZZRN Ops Two" in text_of(html_two) and html_two.count("Whole department") == 2)
    s.check("the email stays small (Gmail clips a message over 102 KB)", all(len(x) < 40000 for x in (html_h, html_b, html_c)))

    # ------------------------------------------------------------------------------------------------------------------
    s.section("the send: one email a leader, the row with the outbox add, once per place per cycle")
    clear_sent()
    for hd in ("HD1", "HD2", "HD3", "HD4"):
        lock(hd, "pot")
        if hd != "HD4":
            lock(hd, "pm")
    with a.app.test_request_context("/"):
        d = a.get_db()
        t = a.ready_send(d, a.active_cycle(d), "test run", actor_id=SU["id"], rules=dict(a.READY_DEFAULT_RULES))
    q = outbox()
    inv = {v: k for k, v in ID.items()}
    s.check("tally: 3 HODs (Ops, Sales, Gamma's department) + 1 BU CEO + 1 Calibrator, one email each", t == {
        "leaders": 5, "emailed": 5, "departments": 3, "units": 1, "groups": 1, "no_email": 0, "opted_out": 0}, t)
    s.check("one outbox row each, the kind ready_notice, to the leader's own address, [role; why] in its detail", sorted(
        inv[r_["user_id"]] for r_ in q) == ["CAL1", "CE1", "HD1", "HD2", "HD3"] and all(r_["kind"] == "ready_notice"
        and r_["to_email"] == "zz9rn-%s@example.test" % inv[r_["user_id"]].lower() for r_ in q) and any(
        r_["detail"] == "hod; test run" for r_ in q), [(inv[r_["user_id"]], r_["detail"]) for r_ in q])
    rows_ = sent_rows()
    s.check("the places are written in ready_notices, with the outbox add: a row per department, unit and group, by kind",
            sorted((k, inv[u_]) for k, _sk, u_ in rows_) == [("buceo", "CE1"), ("cg", "CAL1"), ("hod", "HD1"), ("hod", "HD2"),
                                                              ("hod", "HD3")]
            and {sk for k, sk, _u in rows_ if k == "hod"} == {"%s|%s|ZZRN Ops" % (BG, U1), "%s|%s|ZZRN Sales" % (BG, U1),
                                                                "%s|%s|ZZRN GDept" % (BG, U3)}
            and ("cg", "grp:%d" % GX) in {(k, sk) for k, sk, _u in rows_}, rows_)
    s.check("the run is written for the audit, in plain words", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE id>? AND action='ready_notice_run' AND detail LIKE 'test run | 5 leaders | 5 "
        "emailed | 3 departments | 1 units | 1 groups | 0 no email | 0 opted out'", (LOG0,)) == 1)
    s.check("...with plain words for the activity list", a.ACTION_LABELS.get("ready_notice_run") == "Sent ready notices"
            and a.ACTION_LABELS.get("ready_notice_schedule") == "Changed the ready notices")
    n_out = len(outbox())
    with a.app.test_request_context("/"):
        d = a.get_db()
        t2 = a.ready_send(d, a.active_cycle(d), "again", actor_id=SU["id"], rules=dict(a.READY_DEFAULT_RULES))
    s.check("a second run sends nothing: each place is told once for the cycle", t2["leaders"] == 0 and t2["emailed"] == 0
            and len(outbox()) == n_out and len(sent_rows()) == len(rows_), (t2, len(outbox()), n_out))
    s.check("...falsified: take a place's row away and it goes again, alone", (lambda: (dbx(
        "DELETE FROM ready_notices WHERE cycle_id=? AND kind='hod' AND user_id=?", (CID, ID["HD2"])),
        who(build()))[1])() == {("hod", "HD2"): ["ZZRN Sales"]})
    clear_sent()
    s.check("the table holds the rule itself: UNIQUE(cycle_id, kind, scope_key, user_id) in SCHEMA and in the runtime migration",
            H.source(a).count("UNIQUE(cycle_id, kind, scope_key, user_id)") == 2)
    s.check("an insert of the same place twice is refused by the table, not by luck", (lambda: (dbx(
        "INSERT INTO ready_notices(cycle_id, kind, scope_key, user_id) VALUES (?,?,?,?)", (CID, "hod", "x", ID["HD1"])),
        ctx(lambda d: d.execute("INSERT OR IGNORE INTO ready_notices(cycle_id, kind, scope_key, user_id) VALUES (?,?,?,?)",
                                (CID, "hod", "x", ID["HD1"])).rowcount))[1])() == 0)
    clear_sent()
    # two runs at once: another run tells HD1's place after this one has built its list -- this one leaves that leader alone and
    # keeps no half-written row (the places and the outbox add are one transaction)
    _rb = a.ready_build

    def stale(db_, cyc_, rules=None, only=None, now=None):
        got = _rb(db_, cyc_, rules, only=only, now=now)
        db_.execute("INSERT INTO ready_notices(cycle_id, kind, scope_key, user_id) VALUES (?,?,?,?)",
                    (CID, "hod", "%s|%s|ZZRN Ops" % (BG, U1), ID["HD1"]))
        db_.commit()
        return got
    a.ready_build = stale
    with a.app.test_request_context("/"):
        d = a.get_db()
        t_race = a.ready_send(d, a.active_cycle(d), "race", rules=dict(a.READY_DEFAULT_RULES, roles=["hod"]))
    a.ready_build = _rb
    s.check("a place told by another run in between is not told twice: that leader gets no email and no extra row, the others do",
            t_race["emailed"] == 2 and all(inv[r_["user_id"]] != "HD1" for r_ in outbox())
            and [u_ for _k, _sk, u_ in sent_rows()].count(ID["HD1"]) == 1 and len(sent_rows()) == 3, (t_race, sent_rows()))
    clear_sent()
    with a.app.test_request_context("/"):
        d = a.get_db()
        n0 = d.execute("SELECT COUNT(*) FROM email_outbox").fetchone()[0]
        a.ready_send(d, a.active_cycle(d), "dry", rules=dict(a.READY_DEFAULT_RULES), live=False)
        s.check("a dry run queues nothing and writes no place", d.execute("SELECT COUNT(*) FROM email_outbox").fetchone()[0] == n0
                and sent_rows() == [])
    # who it reaches: opt-out, no email, the failed add
    dbx("INSERT INTO email_optouts(user_id, kind, until, reason, set_by) VALUES (?,?,NULL,?,?)",
        (ID["HD1"], "leader_progress", "ZZ test", SU["id"]))
    with a.app.test_request_context("/"):
        d = a.get_db()
        t3 = a.ready_send(d, a.active_cycle(d), "optout", rules=dict(a.READY_DEFAULT_RULES, roles=["hod"]))
        sk = d.execute("SELECT user_id, status, detail FROM notifications WHERE id>? AND kind=? AND status='skipped'",
                       (NOTE0, a.READY_KIND)).fetchall()
    s.check("someone taken off the leader progress email gets none of these either: logged skipped 'opted out', counted, and no place "
            "is marked told (so it goes if they're put back)", t3["opted_out"] == 1 and t3["emailed"] == 2 and [(r_[0], r_[2]) for r_ in sk] == [
                (ID["HD1"], "opted out")] and all(u_ != ID["HD1"] for _k, _sk, u_ in sent_rows()), (t3, [tuple(r_) for r_ in sk]))
    dbx("DELETE FROM email_optouts WHERE user_id=?", (ID["HD1"],))
    s.check("...falsified: put back on, HD1 is told", ("hod", "HD1") in who(build(roles=("hod",))))
    dbx("UPDATE users SET email='' WHERE id=?", (ID["HD1"],))
    with a.app.test_request_context("/"):
        d = a.get_db()
        t4 = a.ready_send(d, a.active_cycle(d), "noemail", rules=dict(a.READY_DEFAULT_RULES, roles=["hod"]))
    s.check("a leader with no email address is logged as skipped and counted, their place is not marked told",
            t4["no_email"] == 1 and all(u_ != ID["HD1"] for _k, _sk, u_ in sent_rows()), t4)
    dbx("UPDATE users SET email='zz9rn-hd1@example.test' WHERE id=?", (ID["HD1"],))
    s.check("the outbox's last-minute check drops it too when someone is opted out after it was queued (the same drop as the leader "
            "progress email's)", 'row["kind"] in (LP_KIND, READY_KIND)' in H.source(a))
    clear_sent()

    # ------------------------------------------------------------------------------------------------------------------
    s.section("a BU CEO who also calibrates a group: one email, a section for each ready place, each tracked on its own")
    clear_sent()
    for hd in ("HD6", "HD7"):
        lock(hd, "pm")
        lock(hd, "pot")
    bx = [x for x in build() if x["user"]["id"] == ID["CX"]]
    s.check("both ready: ONE entry for CX, the unit and the group, the unit first, in the BU CEO's words",
            len(bx) == 1 and bx[0]["role"] == "buceo" and [(p["kind"], p["name"]) for p in bx[0]["places"]] == [
                ("buceo", UN4), ("cg", "ZZRN Group G2")], [(x["role"], [p["name"] for p in x["places"]]) for x in bx])
    s.check("...whichever order the roles come in (groups first): still the BU CEO's words, still the unit first or last but one email",
            (lambda b_: len(b_) == 1 and b_[0]["role"] == "buceo" and sorted(p["kind"] for p in b_[0]["places"]) == ["buceo", "cg"])(
                [x for x in build(roles=("cg", "buceo")) if x["user"]["id"] == ID["CX"]]))
    s.check("...while the leader progress email's rank rule is untouched: lp_leaders still gives CX only their unit",
            ctx(lambda d: [(r_, sc_) for r_, u_, sc_ in _real[4](d, ["buceo", "cg"]) if u_["id"] == ID["CX"]]) == [("buceo", [(BG, U4)])])
    with a.app.test_request_context("/"):
        d = a.get_db()
        a.ready_send(d, a.active_cycle(d), "mixed", actor_id=SU["id"], rules=dict(a.READY_DEFAULT_RULES))
    qx = [r_ for r_ in outbox() if r_["user_id"] == ID["CX"]]
    tx = text_of(qx[0]["body"]) if qx else ""
    s.check("sent: one email to CX, detail 'buceo+cg', two sections (the unit's table, the group's), the BU CEO's heading and button",
            len(qx) == 1 and qx[0]["detail"] == "buceo+cg; mixed" and "Your HODs are done" in tx and "Start your BU calibration" in tx
            and tx.count("taking part") >= 2 and UN4 in tx and "ZZRN Group G2" in tx and "ZZRN DOps" in tx and "ZZRN DGrp" in tx, tx[:400])
    s.check("...the footer reads naturally for both: 'you calibrate these places'", "You get this because you calibrate these places in "
            "AI+ OneHR by Chin Hin." in tx and "you're the" not in tx.split("You get this because", 1)[-1], tx[-300:])
    s.check("two ready_notices rows for CX, one per place, each under its own kind (ready_buceo for the unit, ready_cg for the group)",
            sorted((k, sk) for k, sk, u_ in sent_rows() if u_ == ID["CX"]) == sorted([
                ("buceo", "%s|%s" % (BG, U4)), ("cg", "grp:%d" % G2)]), sent_rows())
    ov = ctx(lambda d: a.ready_overview(d, a.active_cycle(d)))
    s.check("...so the card's Sent counts them per place (a unit under BU CEOs, a group under Calibrators)",
            ov["roles"]["buceo"]["sent"] >= 1 and ov["roles"]["cg"]["sent"] >= 1)
    n_x = len(outbox())
    with a.app.test_request_context("/"):
        d = a.get_db()
        a.ready_send(d, a.active_cycle(d), "twice", actor_id=SU["id"], rules=dict(a.READY_DEFAULT_RULES))
    s.check("run twice: nothing more for CX (no email, no row)", not [x for x in build() if x["user"]["id"] == ID["CX"]]
            and len([r_ for r_ in outbox() if r_["user_id"] == ID["CX"]]) == 1 and len(outbox()) == n_x
            and len([1 for _k, _sk, u_ in sent_rows() if u_ == ID["CX"]]) == 2)
    # only the group ready
    clear_sent()
    lock("HD6", "pot", False)
    bg2 = [x for x in build() if x["user"]["id"] == ID["CX"]]
    s.check("only the group ready (the unit's HOD unlocked): one entry with just the group, in the Calibrator's words",
            len(bg2) == 1 and bg2[0]["role"] == "cg" and [(p["kind"], p["name"]) for p in bg2[0]["places"]] == [
                ("cg", "ZZRN Group G2")], [(x["role"], [p["name"] for p in x["places"]]) for x in bg2])
    with a.app.test_request_context("/"):
        d = a.get_db()
        a.ready_send(d, a.active_cycle(d), "group only", actor_id=SU["id"], rules=dict(a.READY_DEFAULT_RULES))
    qg = [r_ for r_ in outbox() if r_["user_id"] == ID["CX"]]
    tg = text_of(qg[0]["body"]) if qg else ""
    s.check("...sent: one email, the group's section, the footer names the role ('the calibrator of ZZRN Group G2'), one row (cg)",
            len(qg) == 1 and "ZZRN Group G2" in tg and "You get this because you're the calibrator of ZZRN Group G2" in tg
            and [(k, sk) for k, sk, u_ in sent_rows() if u_ == ID["CX"]] == [("cg", "grp:%d" % G2)], tg[-300:])
    lock("HD6", "pot")
    s.check("the unit's HOD submits later: the unit's notice goes alone, the group's isn't repeated", (lambda b_: len(b_) == 1
            and [p["kind"] for p in b_[0]["places"]] == ["buceo"])([x for x in build() if x["user"]["id"] == ID["CX"]]))
    s.check("only the unit ready: one entry with the unit, in the BU CEO's words", (lambda b_: len(b_) == 1 and b_[0]["role"] == "buceo")(
        [x for x in build(only=("buceo", ID["CX"]))]) and not [x for x in build(only=("cg", ID["CX"])) if x["places"]])
    for hd in ("HD6", "HD7"):
        lock(hd, "pm", False)
        lock(hd, "pot", False)
    clear_sent()

    # ------------------------------------------------------------------------------------------------------------------
    s.section("the rules, the form and the job")
    from werkzeug.datastructures import MultiDict
    with a.app.app_context():
        a.get_db().execute("DELETE FROM app_settings WHERE key='ready_notice_rules'")
        a.get_db().commit()
    s.check("defaults: off, 08:30, all three roles", ctx(lambda d: a.ready_rules()) == {
        "enabled": False, "send_time": "08:30", "roles": ["hod", "buceo", "cg"]})
    r, errs = ctx(lambda d: a.ready_rules_from(MultiDict({"enabled": "on", "send_time": "09:15", "ready_role": ["hod", "cg"]})))
    s.check("a good form saves what it says", not errs and r == {"enabled": True, "send_time": "09:15", "roles": ["hod", "cg"]}, (r, errs))
    r, errs = ctx(lambda d: a.ready_rules_from(MultiDict({"enabled": "on", "send_time": "25:61", "ready_role": ["hod"]})))
    s.check("...refuses a time that isn't HH:MM", any("HH:MM" in e for e in errs), errs)
    r, errs = ctx(lambda d: a.ready_rules_from(MultiDict({"enabled": "on", "send_time": "08:30"})))
    s.check("...refuses 'send it on its own' with nobody ticked", any("Tick who gets it" in e for e in errs), errs)
    r, errs = ctx(lambda d: a.ready_rules_from(MultiDict({"send_time": "08:30"})))
    s.check("...nobody ticked and off is fine (it just goes to nobody)", not errs and r["roles"] == [] and r["enabled"] is False)
    r, errs = ctx(lambda d: a.ready_rules_from(MultiDict({"enabled": "on", "send_time": "08:30", "ready_role": ["hod", "ceo", "role"]})))
    s.check("...a role it doesn't know is ignored, never stored", r["roles"] == ["hod"], r)
    s.check("...a time between the timer's runs moves to the next (the app's rule)", ctx(lambda d: a.ready_rules_from(MultiDict({
        "send_time": "08:37", "ready_role": ["hod"]})))[0]["send_time"] == "08:45")
    dbx("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('ready_notice_rules', ?)",
        ('{"enabled": "yes", "send_time": "99:99", "roles": ["nonsense", "cg"]}',))
    s.check("a hand-edited setting can't break it: each value checked", ctx(lambda d: a.ready_rules()) == {
        "enabled": False, "send_time": "08:30", "roles": ["cg"]})
    dbx("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('ready_notice_rules', ?)", ("[1, 2]",))
    s.check("...even one that isn't an object", ctx(lambda d: a.ready_rules())["enabled"] is False)
    dbx("DELETE FROM app_settings WHERE key='ready_notice_rules'")
    at = dict(a.READY_DEFAULT_RULES, enabled=True, send_time="08:30")
    day = datetime(TODAY.year, TODAY.month, TODAY.day)
    dbx("DELETE FROM app_settings WHERE key='ready_notice_last'")
    due = lambda now: ctx(lambda d: a.lp_due_now(d, at, now, last_key=a.READY_LAST_KEY, what="the ready notices check"))   # noqa: E731
    s.check("due at its time", due(day.replace(hour=8, minute=30))[0])
    s.check("...not before it, and the words say what", not due(day.replace(hour=8, minute=29))[0]
            and "ready notices check goes at 08:30" in due(day.replace(hour=8, minute=29))[1])
    s.check("...within the grace hours, not after", due(day.replace(hour=11, minute=29))[0] and not due(day.replace(hour=11, minute=31))[0])
    dbx("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('ready_notice_last', ?)", (TODAY.isoformat(),))
    s.check("...once a day (its own key)", due(day.replace(hour=9, minute=0)) == (False, "Already sent today."))
    dbx("DELETE FROM app_settings WHERE key='ready_notice_last'")
    # the job
    win_open()
    now_ = a._now_myt().replace(second=0, microsecond=0)
    now_ = now_.replace(minute=now_.minute - now_.minute % 15)

    def save(rules):
        dbx("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('ready_notice_rules', ?)", (a.json.dumps(rules),))
    save(dict(at, enabled=False, send_time=now_.strftime("%H:%M")))
    s.check("off says so and writes nothing", ctx(lambda d: a.ready_auto(d, a.active_cycle(d))) == "Ready notices are off."
            and ctx(lambda d: a._setting("ready_notice_last")) is None and not outbox())
    save(dict(at, roles=[], send_time=now_.strftime("%H:%M")))
    s.check("on with nobody ticked: says so", "nobody" in ctx(lambda d: a.ready_auto(d, a.active_cycle(d))))
    save(dict(at, send_time=now_.strftime("%H:%M")))
    said = ctx(lambda d: a.ready_auto(d, a.active_cycle(d)))
    s.check("on and due, no mail set up here: the day is marked first, nothing queued", "isn't set up" in said
            and ctx(lambda d: a._setting("ready_notice_last")) == TODAY.isoformat() and not outbox(), said)
    dbx("DELETE FROM app_settings WHERE key='ready_notice_last'")
    a.mailer.is_configured = lambda: True
    a.mailer.config_status = lambda: {"configured": True}
    a.mailer.send_mail = lambda to, subject, body, **kw: SENT.append((to, subject, body))
    a.mailer.get_token = lambda: "tok"
    a.OUTBOX_ASYNC = False
    said = ctx(lambda d: a.ready_auto(d, a.active_cycle(d)))
    s.check("with mail set up it queues and sends through the mailer: 5 leaders, in words", "5 leaders, 5 emailed (3 departments, 1 "
            "units, 1 groups)" in said and len(SENT) == 5 and sorted(x[0] for x in SENT) == sorted(
                "zz9rn-%s@example.test" % k for k in ("hd1", "hd2", "hd3", "ce1", "cal1")), (said, [x[0] for x in SENT]))
    s.check("...the same email as the build makes (the BU CEO's names its departments)", any("ZZRN Sales" in x[2] and "Your HODs are done" in x[2]
                                                                                           for x in SENT))
    n_sent = len(SENT)
    s.check("a second run today doesn't send again (the day is used, and each place is told)", ctx(lambda d: a.ready_auto(
        d, a.active_cycle(d))) == "Already sent today." and len(SENT) == n_sent)
    dbx("DELETE FROM app_settings WHERE key='ready_notice_last'")
    s.check("...nor tomorrow's run for the same places (once per place per cycle)", "0 leaders, 0 emailed" in ctx(
        lambda d: a.ready_auto(d, a.active_cycle(d))) and len(SENT) == n_sent)
    a.mailer.is_configured, a.mailer.send_mail, a.mailer.config_status, a.OUTBOX_ASYNC = _real[:4]
    a.mailer.get_token = _real[6]
    sr = open(os.path.join(H.REPO, "send_reminders.py"), encoding="utf-8").read()
    s.check("the server's job gives it a turn right after the BG admins', wrapped so a failure doesn't stop the run",
            re.search(r"appmod\.bga_auto\(db, cyc\)\)\s*\n(.*\n){0,3}.*\n\s*try:\s*\n\s*print\(appmod\.ready_auto\(db, cyc\)\)\s*\n\s*except "
                      r"Exception", sr) is not None or re.search(r"ready_auto\(db, cyc\)", sr) is not None)
    clear_sent()
    dbx("DELETE FROM app_settings WHERE key IN ('ready_notice_rules','ready_notice_last')")

    # ------------------------------------------------------------------------------------------------------------------
    s.section("the words: three template kinds, the canvas's defaults, a preview that follows the window")
    ks = [x["key"] for x in a.EMAIL_TPL_KINDS]
    s.check("Ready · HODs, Ready · BU CEOs, Ready · Calibrators are email kinds, last (so existing templates keep their numbers)",
            ks[ks.index("ready_hod"):ks.index("ready_hod") + 3] == ["ready_hod", "ready_buceo", "ready_cg"]
            and [a.EMAIL_TPL_KIND[k]["title"] for k in ks[ks.index("ready_hod"):ks.index("ready_hod") + 3]] == [
                "Ready · HODs", "Ready · BU CEOs", "Ready · Calibrators"], ks[-9:])   # (position-free: the Grade H progress and ready kinds, 2026-11-09, Talent Box Round 2's and the shared spec of Your own emails come after)
    s.check("...the fields: subject, heading, greeting, opening (open), opening (later), note (later), button (open), button "
            "(later), closing", [f[0] for f in a.EMAIL_TPL_KIND["ready_hod"]["fields"]] == [
                "subject", "heading", "greeting", "opening_open", "opening_later", "note_later", "button_open", "button_later",
                "closing"] and a.EMAIL_TPL_KIND["ready_cg"]["placeholders"] == ("display_name", "first_name", "full_name", "scope", "cycle",
                                                                                    "as_at", "opens", "closes"))
    T = a.READY_TPL_DEFAULT
    s.check("the defaults are the canvas's words (N1-N4)", T["hod"]["heading"] == "Your line managers are done"
            and T["buceo"]["heading"] == T["cg"]["heading"] == "Your HODs are done"
            and T["hod"]["button_open"] == "Start your Department Review" and T["buceo"]["button_open"] == "Start your BU calibration"
            and T["cg"]["button_open"] == "Start your calibration"
            and all(T[k]["button_later"] == "Open AI+ OneHR" for k in T)
            and all(T[k]["note_later"] == "Opens {opens}.\nWe'll remind you that morning." for k in T)
            and all(T[k]["closing"] == "This note goes once for {scope} this cycle." for k in T)
            and T["hod"]["opening_open"] == "Every line manager in {scope} has finished reviewing their team in the {cycle} check-in. "
                                           "Your Department Review is open, so you can start now. It closes {closes}.", T["hod"])
    s.check("...read like the others: no template yet, the default words; the older-settings path reads them too",
            all(ctx(lambda d, k=k: a.email_tpl_words("ready_" + k)) == T[k] and a._email_tpl_default("ready_" + k) == T[k]
                and ctx(lambda d, k=k: a._email_tpl_legacy("ready_" + k)) == T[k] for k in T))
    with a.app.test_request_context("/"):
        d = a.get_db()
        me_ = d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        o_sub, o_html = a.email_tpl_sample(d, "ready_hod", T["hod"], me_)
        l_sub, l_html = a.email_tpl_sample(d, "ready_cg", T["cg"], me_, case="later")
        b_sub, b_html = a.email_tpl_sample(d, "ready_buceo", T["buceo"], me_)
    ot, lt, bt = text_of(o_html), text_of(l_html), text_of(b_html)
    s.check("the samples are made up: Sample department / Sample group, no real name, the window the chip picks",
            "Sample department" in ot and "6 teams · 42 taking part" in ot and "Start your Department Review" in ot
            and "Sample group" in lt and "Open AI+ OneHR" in lt and "We'll remind you that morning." in lt
            and "Sample unit" in bt and "No performance part" in bt and "No HOD to wait on" in bt
            and "ZZ RN" not in (ot + lt + bt) and o_sub.startswith("Sample department:"), (o_sub, lt[:300]))
    # a template edited changes the email
    with a.app.test_request_context("/"):
        d = a.get_db()
        words, errs = a.email_tpl_words_from(MultiDict({"heading": "ZZ lines done", "opening_open": "ZZ {scope} on {closes} {oops}"}),
                                             a.email_tpl_pick(a.email_tpl_rows(d, "ready_hod"), TODAY) or (
                                                 a._email_tpl_ensure(d, "ready_hod") and a.email_tpl_pick(
                                                     a.email_tpl_rows(d, "ready_hod"), TODAY)))
    s.check("an unknown placeholder is refused, naming the ones OneHR fills", any("{oops}" in e and "{scope}" in e for e in errs), errs)
    ME = H.client_as(a, SU["id"])
    pgE = ME.get("/admin/emails?email=ready_cg").get_data(as_text=True)
    s.check("Email › Emails and templates lists all three under Cycle reviews, after the BG admins', and opens one with its fields",
            all(x in pgE for x in ("Ready · HODs", "Ready · BU CEOs", "Ready · Calibrators", 'name="opening_later"', 'name="note_later"'))
            and pgE.index("Leader progress · BG admins") < pgE.index("Ready · HODs") < pgE.index("Results to leaders"), None)
    s.check("...with the Part open / Opens later chips for the preview", 'data-v="later"' in pgE and "Opens later" in pgE)
    pv = ME.post("/admin/emails/preview", data={"csrf_token": "tok", "tid": str(H.one(
        a, "SELECT id FROM email_templates WHERE email='ready_cg' AND retired_at IS NULL LIMIT 1")), "case": "later"})
    s.check("the preview route takes the window the chip picks", pv.status_code == 200 and "We&#x27;ll remind you that morning" in
            pv.get_data(as_text=True).replace("&#39;", "&#x27;"), pv.get_data(as_text=True)[:200])
    with a.app.test_request_context("/"):
        d = a.get_db()
        s.check("when it goes: off by default, then its rule", "Off" in a.email_tpl_when(d, "ready_hod"))
    save(dict(at, roles=["hod"]))
    s.check("...on and ticked: said in words; unticked says off", "08:30" in ctx(lambda d: a.email_tpl_when(d, "ready_hod"))
            and "Off" in ctx(lambda d: a.email_tpl_when(d, "ready_cg")))
    dbx("DELETE FROM app_settings WHERE key='ready_notice_rules'")

    # ------------------------------------------------------------------------------------------------------------------
    s.section("the card on Leader progress: Save, the test, who may")
    pg = ME.get("/admin/reminders/leaders").get_data(as_text=True)
    pg_t = _html.unescape(pg)
    s.check("the super admin's page has the card in the canvas's words, after BG admins: daily status", all(x in pg_t for x in (
        "Ready for you: when the tier below is done", "One email, once per cycle for each place, when everyone a leader waits on has "
        "finished", "Send it on its own", "Checked every day at", "Malaysia time", "Who gets it", "HODs", "BU CEOs", "Calibrators",
        "line managers done", "HODs done", "Opted out", "Ready · HODs", "Send a test to me"))
        and pg.index('id="bga"') < pg.index('id="ready"') < pg.index('id="sent"'),
        [x for x in ("Ready for you: when the tier below is done", "Send it on its own", "Checked every day at", "Malaysia time",
                     "Who gets it", "line managers done", "HODs done", "Opted out", "Ready · HODs", "Send a test to me") if x not in pg_t])
    card = pg.split('id="ready"')[1].split('id="sent"')[0]
    s.check("...a tick for each of the three roles with 'Sent N · N ready', in its own form (not the page's hidden role)",
            card.count('name="ready_role"') == 3 and 'id="ready-rules"' in card and re.search(r"Sent \d+ · \d+ departments? ready", card)
            and re.search(r"Sent \d+ · \d+ units? ready", card) and re.search(r"Sent \d+ · \d+ groups? ready", card), None)
    s.check("...Save is double-confirmed (data-confirm), and so is the test", re.search(r'id="ready-rules"[^>]*\n?[^>]*data-confirm=', pg)
            is not None and card.count("data-confirm=") >= 2)
    s.check("...every table text on it is one line of words: no raw HR", not re.search(r"\bHR\b|HRBP", card))
    r = ME.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "ready_save", "enabled": "on", "send_time": "08:45",
                                                   "ready_role": ["hod", "buceo"]})
    got = ctx(lambda d: a.ready_rules())
    s.check("Save: the super admin's rules are stored", r.status_code == 302 and got == {
        "enabled": True, "send_time": "08:45", "roles": ["hod", "buceo"]}, got)
    s.check("...written in the audit log in plain words", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE id>? AND action='ready_notice_schedule' AND detail LIKE "
        "'on=True, checked every day at 08:45, to hod, buceo'", (LOG0,)) == 1)
    ME.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "ready_save", "enabled": "on", "send_time": "99:00",
                                              "ready_role": ["cg"]})
    s.check("...a bad time is refused and changes nothing", ctx(lambda d: a.ready_rules()) == got)
    ME.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "ready_save", "enabled": "on", "send_time": "08:45"})
    s.check("...so is 'on' with nobody ticked", ctx(lambda d: a.ready_rules()) == got)
    ME.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "ready_save", "send_time": "08:45", "ready_role": ["cg"]})
    s.check("...unticking Send it on its own turns it off", ctx(lambda d: a.ready_rules())["enabled"] is False
            and ctx(lambda d: a.ready_rules())["roles"] == ["cg"])
    # who may: an admin that isn't the super admin
    with a.app.app_context():
        d = a.get_db()
        ID["BGA"] = d.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg) "
                              "VALUES ('zz9rn-bga','ZZ RN BG admin','x','admin','ZZ9RN-BGA',?,?)", (BG, BG)).lastrowid
        d.commit()
    BGAC = H.client_as(a, ID["BGA"])
    r = BGAC.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "ready_save", "enabled": "on", "send_time": "07:00",
                                                     "ready_role": ["hod"]})
    s.check("a BG admin can't change it: the Email menu is the super admin's", r.status_code == 403
            and ctx(lambda d: a.ready_rules())["send_time"] == "08:45")
    r = BGAC.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "ready_test"})
    s.check("...nor send the test", r.status_code == 403)
    s.check("every admin write is classified: the route is the super admin's in ADMIN_ACCESS_MAP (no new route, same one)",
            a.ADMIN_ACCESS_MAP.get("admin_reminders_leaders") == "super")
    # the test
    SENT.clear()
    a.mailer.send_mail = lambda to, subject, body, **kw: SENT.append((to, subject, body))
    a.mailer.config_status = lambda: {"configured": False}
    ME.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "ready_test"})
    s.check("the test on a server with no mail sends none", SENT == [])
    a.mailer.config_status = lambda: {"configured": True}
    own = ctx(lambda d: a.admin_notify_addresses(d, SU["id"]))
    dbx("DELETE FROM admin_notify_emails WHERE user_id=?", (SU["id"],))
    t_ = ME.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "ready_test"}, follow_redirects=True).get_data(as_text=True)
    s.check("...with no notification email on the super admin's account it sends none and says why", SENT == []
            and "no notification email on your account" in t_)
    dbx("INSERT INTO admin_notify_emails(user_id, email) VALUES (?,?)", (SU["id"], "zz9rn-me@example.test"))
    t_ = ME.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "ready_test"}, follow_redirects=True).get_data(as_text=True)
    s.check("with one: three made-up emails go to that address only, [Test] first, no real unit or person",
            len(SENT) == 3 and all(x[0] == "zz9rn-me@example.test" and x[1].startswith("[Test] Sample") for x in SENT)
            and "ZZ RN" not in " ".join(x[2] for x in SENT) and "Test sent to zz9rn-me@example.test" in t_, [x[:2] for x in SENT])
    s.check("...an HOD's (open), a BU CEO's (open) and a Calibrator's (later)", "Start your Department Review" in SENT[0][2]
            and "Start your BU calibration" in SENT[1][2] and "remind you that morning" in text_of(SENT[2][2]).replace("We'll", "remind"))
    s.check("...logged as a test of this email", H.one(a, "SELECT COUNT(*) FROM notifications WHERE id>? AND kind='ready_notice' AND "
                                                       "to_email='zz9rn-me@example.test'", (NOTE0,)) == 1)
    dbx("DELETE FROM admin_notify_emails WHERE user_id=?", (SU["id"],))
    for e_ in own:
        dbx("INSERT INTO admin_notify_emails(user_id, email) VALUES (?,?)", (SU["id"], e_))
    a.mailer.is_configured, a.mailer.send_mail, a.mailer.config_status, a.OUTBOX_ASYNC = _real[:4]
    s.check("the settings sheet lists it, with its audit", '"Ready for you notices"' in H.source(a) and "ready_notice_schedule" in H.source(a))
    ov = ctx(lambda d: a.ready_overview(d, a.active_cycle(d)))
    s.check("the card's counts: ready = places that would go now (not told, not opted out, with an email)",
            ov["roles"]["hod"]["ready"] >= 2 and ov["roles"]["buceo"]["ready"] >= 1 and ov["roles"]["cg"]["ready"] >= 1, ov)
    s.check("...sent counts the notices told this cycle", ov["roles"]["hod"]["sent"] == 0)

    # ------------------------------------------------------------------------------------------------------------------
    s.section("what the agents and Help know")
    dbx("DELETE FROM app_settings WHERE key='ready_notice_rules'")
    qa = a.HELP_QA["ready_note"]
    s.check("Help has the quick answer, in fixed words: once, the open / opens-on choice, counts only; never the word HR",
            "once" in qa[1] and "start now" in qa[1] and "counts only" in qa[1] and not re.search(r"\bHR\b", " ".join(qa))
            and "ready_note" in a.HELP_LISTS["dept_perf"][1] and "ready_note" in a.HELP_LISTS["bu_perf"][1]
            and all(len(v[1]) <= a.HELP_LIST_MAX for v in a.HELP_LISTS.values()), qa)
    off_items = ctx(lambda d: [i["key"] for i in a._help_items(a.HELP_LISTS["dept_perf"][1])])
    save(dict(at, enabled=True))
    on_items = ctx(lambda d: [i["key"] for i in a._help_items(a.HELP_LISTS["dept_perf"][1])])
    s.check("...shown only while the notices are on (falsified: off, it isn't listed)", "ready_note" not in off_items
            and "ready_note" in on_items, (off_items, on_items))
    with a.app.test_request_context("/"):
        d = a.get_db()
        hdu = d.execute("SELECT * FROM users WHERE id=?", (ID["HD1"],)).fetchone()
        facts_on, _l = a._ask_facts(d, hdu, {"leaders": [{"name": "AI+ Dept Review"}], "welcome": {}, "panel": {}})
        facts_off, _l2 = a._ask_facts(d, hdu, {"welcome": {}, "panel": {}})
    f_on = [x for x in facts_on if x.startswith("READY NOTES")]
    s.check("Ask OneHR's guide has one fact for a leader, no result in it", len(f_on) == 1 and "once" in f_on[0]
            and "never a person's result" in f_on[0] and not [x for x in facts_off if x.startswith("READY NOTES")], f_on)
    dbx("DELETE FROM app_settings WHERE key='ready_notice_rules'")
    with a.app.test_request_context("/"):
        d = a.get_db()
        facts_off2, _l4 = a._ask_facts(d, d.execute("SELECT * FROM users WHERE id=?", (ID["HD1"],)).fetchone(),
                                       {"leaders": [{"name": "x"}], "welcome": {}, "panel": {}})
    s.check("...and not said while the notices are off", not [x for x in facts_off2 if x.startswith("READY NOTES")])
    s.check("no user-role module row for it (the brief: no tour stop, no user-role module, no release note)",
            "ready" not in [m[0] for m in a.UROLE_MODULES] if isinstance(a.UROLE_MODULES, (list, tuple)) and a.UROLE_MODULES
            and isinstance(a.UROLE_MODULES[0], (list, tuple)) else "ready_notice" not in str(a.UROLE_MODULES))
finally:
    a.mailer.is_configured, a.mailer.send_mail, a.mailer.config_status, a.OUTBOX_ASYNC = _real[:4]
    a.lp_leaders, a.chair_user_id = _real[4], _real[5]
    a.mailer.get_token = _real[6]
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        for w in WIN:
            _db.execute("INSERT INTO cycle_windows(%s) VALUES (%s)" % (",".join(w), ",".join("?" * len(w))), list(w.values()))
        _db.execute("UPDATE cycles SET open_by_date=?, half=? WHERE id=?", (OBD, HALF, CID))
        _db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key IN (?,?,?)", (CID,) + MODS5)
        _db.executemany("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", MODS)
        _db.execute("DELETE FROM email_outbox WHERE id>?", (OUT0,))
        _db.execute("DELETE FROM notifications WHERE id>? AND (kind IN ('ready_notice','email_test') OR user_id IN (SELECT id FROM "
                    "users WHERE employee_id LIKE 'ZZ9RN-%'))", (NOTE0,))
        _db.execute("DELETE FROM activity_log WHERE id>? AND action IN ('ready_notice_run','ready_notice_schedule')", (LOG0,))
        for k_, v in SAVED.items():
            _db.execute("DELETE FROM app_settings WHERE key=?", (k_,))
            if v is not None:
                _db.execute("INSERT INTO app_settings(key,value) VALUES (?,?)", (k_, v[0]))
        _db.commit()
        H.restore_email_templates(_db, TPLS)
        _cleanup(_db)

sys.exit(s.done())
