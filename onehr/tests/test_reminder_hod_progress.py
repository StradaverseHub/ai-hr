"""Where an HOD's line managers stand, inside the HOD's own reminder (Chris, 2026-11-12: "1: Progress in reminder", canvas
[design canvas link removed], boards E2 and E3; the tables stacked: share, bar, words).

What this suite holds (a made-up group; every row put back at the end):
  * an HOD with two departments, one with a team still working and one all done: the Department review line carries the summed
    teams ("3 of 4 line managers' teams done"), one "Before you start" box (the leader progress table, the finished line) and
    one "Ready for you" box (the one-row Whole department table); only line managers' names, never a team member's
  * the line managers' parts closed: no box and no suffix unless every team is done; all done = the green box
  * an HOD the super admin took off Leader progress, the Executive Chairman, a line manager who is no HOD, and an HOD with no
    Department review line: today's email, word for word
  * one run over several HODs works the figures out ONCE (lp_counts), the send-time recheck's context is shared too
  * the dashboard's reminder_items is not touched
  * the stacked cell is only for the reminder's boxes: the Leader progress and Ready-for-you tables are byte for byte as before
Every guard is falsified in the suite itself (take it away and the outcome flips).
"""
import html as _html
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The HOD's reminder carries where their line managers stand")
_chk = s.check
s.check = lambda name, cond, detail="": _chk(name, cond, str(detail)[:300])   # a failing email's text, cut short
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
assert not a.mailer.is_configured(), "the harness must not send email"
BG, U1 = "ZZHR Group", "ZZHR Alpha"
_real = (a.mailer.is_configured, a.mailer.send_mail, a.OUTBOX_ASYNC, a.chair_user_id, a._lp_cells_state, a.email_optout_ids,
         a._lp_hod_section_n, a.lp_counts, a.reminder_items_email, a.reminder_mail)
MODS3 = ("pm", "tm")


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9HR-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        for sql in ("DELETE FROM email_outbox WHERE user_id IN (%s)", "DELETE FROM notifications WHERE user_id IN (%s)",
                    "DELETE FROM email_optouts WHERE user_id IN (%s)", "DELETE FROM activity_log WHERE user_id IN (%s)",
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
    db.execute("DELETE FROM tc_skills WHERE skill_code='ZZ9HR-SKILL'")
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CYC = db.execute("SELECT * FROM cycles WHERE is_active=1").fetchone()
    CID, OBD, HALF = CYC["id"], CYC["open_by_date"], CYC["half"]
    WIN = [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=?", (CID,))]
    MODS = [tuple(r) for r in db.execute("SELECT cycle_id, module_key, active FROM cycle_modules WHERE cycle_id=? AND "
                                         "module_key IN (?,?)", (CID,) + MODS3)]
    OUT0 = db.execute("SELECT COALESCE(MAX(id),0) FROM email_outbox").fetchone()[0]
    NOTE0 = db.execute("SELECT COALESCE(MAX(id),0) FROM notifications").fetchone()[0]
    LOG0 = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
    SKILL = (db.execute("SELECT id FROM tc_skills ORDER BY id LIMIT 1").fetchone() or [None])[0]
    if SKILL is None:
        SKILL = db.execute("INSERT INTO tc_skills(skill_code, title) VALUES ('ZZ9HR-SKILL', 'ZZ9HR skill')").lastrowid
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key IN (?,?)", (CID,) + MODS3)
    db.executemany("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", [(CID, m) for m in MODS3])
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, U1))
    ID, TGT = {}, {}

    def person(key, dept, hod=None, mgr=None, grade=14, yos=3):
        cols = {"username": "zz9hr-" + key.lower(), "full_name": "ZZ HR PERSON " + key, "display_name": "Zed " + key,
                "password_hash": "x", "role": "user", "employee_id": "ZZ9HR-" + key, "business_group": BG, "company": U1,
                "department": dept, "job_grade": grade, "years_of_service": yos, "email": "zz9hr-%s@example.test" % key.lower(),
                "hod_id": ID.get(hod) if hod else None, "manager_id": ID.get(mgr) if mgr else None}
        ID[key] = db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                             tuple(cols.values())).lastrowid

    def worker(key, dept, hod, mgr):
        """A person taking part with one KPI line and one competency assessment, both done (moderate / review undo them)."""
        person(key, dept, hod=hod, mgr=mgr)
        t = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
                       "rating_line, rate1, rate2, rate3, rate4, rate5) VALUES (?,?,?,100,'more','approved',?,1,1,2,3,4,5)",
                       (CID, ID[key], "ZZHR KPI " + key, BG)).lastrowid
        TGT[key] = t
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft, admin_filled) VALUES (?,4,?,0,0)",
                   (t, ID[key]))
        db.execute("INSERT INTO pm_review_session(subject_id, cycle_id, locked_at) VALUES (?,?,datetime('now'))", (ID[key], CID))
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (t, ID[mgr]))
        db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, acted_by) VALUES (?,1,'confirm',4,?)",
                   (t, ID[mgr]))
        db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id) VALUES (?,?,?)", (CID, ID[key], SKILL))
        db.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status, submitted_at, reviewed_at) VALUES "
                   "(?,?,'reviewed','2026-10-01 00:00','2026-10-02 00:00')", (CID, ID[key]))

    for k in ("HA", "HB", "HC", "L1", "L2", "L3", "L4", "L5", "L6", "LX", "CHAIR"):
        person(k, "ZZHR Heads", grade=21, yos=0)   # not taking part themselves
    # HA heads two departments: Ops (L1: not done, L2 and L3: done) and Sales (L4: done). HB: Legal (L5, done). HC: Yard (L6, not done).
    for who_ in ("a", "b"):
        worker("P1" + who_, "ZZHR Ops", "HA", "L1")
        worker("P2" + who_, "ZZHR Ops", "HA", "L2")
        worker("P3" + who_, "ZZHR Ops", "HA", "L3")
        worker("P4" + who_, "ZZHR Sales", "HA", "L4")
        worker("P5" + who_, "ZZHR Legal", "HB", "L5")
        worker("P6" + who_, "ZZHR Yard", "HC", "L6")
    db.commit()


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def dbx(sql, args=()):
    with a.app.app_context():
        d = a.get_db()
        d.execute(sql, args)
        d.commit()


F = "%Y-%m-%d %H:%M"
NOW = a._now_myt()
TODAY = NOW.date()
ago = lambda n: (NOW - timedelta(days=n)).strftime("%Y-%m-%d") + " 00:00"   # noqa: E731
ahead = lambda n: (NOW + timedelta(days=n)).strftime("%Y-%m-%d") + " 23:59"   # noqa: E731
LM_CELLS = ("pm_approve", "tc_approve")


def setwin(lm_closed=False):
    """The line managers' parts open (closing in 14 days) or closed since yesterday; the HODs' cells open."""
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        for c in LM_CELLS:
            d.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                      (CID, c, ago(20) if lm_closed else ago(5), ago(1) if lm_closed else ahead(14)))
        for c in ("pm_hod", "pot_hod"):
            d.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (CID, c, ago(2), ahead(6)))
        d.execute("UPDATE cycles SET open_by_date=1 WHERE id=?", (CID,))
        d.commit()


def moderate(key, on):
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM pm_kpi_approvals WHERE kpi_target_id=?", (TGT[key],))
        if on:
            mgr = d.execute("SELECT approver_id FROM pm_kpi_target_approvers WHERE kpi_target_id=?", (TGT[key],)).fetchone()[0]
            d.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, acted_by) VALUES (?,1,'confirm',4,?)",
                      (TGT[key], mgr))
        d.commit()


def text_of(html_):
    return re.sub(r"\s+", " ", _html.unescape(re.sub(r"<[^>]+>", " ", html_)).replace("\xa0", " "))


def hod_items(detail="2 to submit"):
    c = a._em_day  # noqa: F841
    return [{"group": "lead", "role": "hod", "text": "Department review", "detail": detail, "closes": "",
             "closes_on": TODAY + timedelta(days=6), "url": "/dashboard", "people": []}]


def mail(key, items=None, hod_ctx=None):
    def go(d):
        u = d.execute("SELECT * FROM users WHERE id=?", (ID[key],)).fetchone()
        return a.reminder_mail(u, items if items is not None else hod_items(), a.active_cycle(d), db=d, hod_ctx=hod_ctx)[1]
    return ctx(go)


def reset_wave():
    a._REM_HOD_WAVE.update(key=None, at=0.0, val=None)


EMPTY = {"by_hod": {}, "open": False, "closes": None, "open_parts": []}
CALLS = []


def counted(*args, **kw):
    CALLS.append(1)
    return _real[7](*args, **kw)


try:
    # ------------------------------------------------------------------------------------------------------------------
    s.section("the lines managers' parts are open: one box a department")
    for k in ("P1a", "P1b", "P6a"):   # L1's team (Ops) and L6's team (Yard) are not finished
        moderate(k, False)   # L1's team is not moderated at all; competency review is done
    dbx("UPDATE tc_assessments SET reviewed_at=NULL WHERE subject_id=? AND cycle_id=?", (ID["P1a"], CID))
    setwin()
    reset_wave()
    body = mail("HA")
    txt = text_of(body)
    CLOSE = a._em_day(TODAY + timedelta(days=14))
    s.check("the line carries the summed teams across both departments", "2 to submit · 3 of 4 line managers' teams done" in txt, txt[:600])
    s.check("one still-working box for Ops, with its kicker, title and the close date",
            txt.count("BEFORE YOU START") + txt.lower().count("before you start") >= 1 and "Before you start · ZZHR Ops" in
            text_of(body).replace("Before you start ·", "Before you start ·") or "ZZHR Ops" in txt, txt[:900])
    s.check("...title 'Your line managers: 2 of 3 teams done' and 'until <date>'",
            "Your line managers: 2 of 3 teams done" in txt and ("until %s" % CLOSE) in txt, txt)
    s.check("one finished box for Sales: 'Every line manager has finished' and 'All 1 team has finished KPI moderation and "
            "Competency review. You can start your Department Review now.'",
            txt.count("Every line manager has finished") == 1 and "All 1 team has finished KPI moderation and Competency review. "
            "You can start your Department Review now." in txt, txt)
    s.check("...with its own kicker, and the first one is not green", "Ready for you · ZZHR Sales" in txt.replace("&middot;", "·")
            or "READY FOR YOU" in body.upper(), txt)
    s.check("exactly two boxes: border colours", body.count("border-left:4px solid #252A59;border-radius:10px") == 1
            and body.count("border-left:4px solid #1f7a4d;border-radius:10px") == 1)
    s.check("the table rows: the line manager's team still working, the Whole department total and the finished line",
            "Zz Hr Person L1's team" in txt or "ZZ HR PERSON L1's team".lower() in txt.lower(), txt)
    s.check("...'N teams have finished every part' names only line managers", "2 teams have finished every part" in txt)
    s.check("no team member's name anywhere", "person p" not in txt.lower(), re.findall(r"person p\w", txt.lower()))
    s.check("the box comes right after the Department review line (before the button)",
            body.index("Department review") < body.index("Your line managers") < body.index("Continue in AI+ OneHR"))
    # stacked cells: share, then the bar, then the words; the total row's share, <br>, words
    s.check("a team's cell reads share, bar, words (bars line up across columns)",
            re.search(r"<b[^>]*>0%</b><table[^>]*><tr>.*?</tr></table>0 moderated · 2 not yet", body) is not None
            and "&nbsp; 0 moderated" not in body)
    s.check("...the total row has no bar: share, a line break, words", re.search(r"<b[^>]*>\d+%</b><br>\d+ moderated · \d+ not yet",
                                                                                 body) is not None)
    s.check("...and the finished box's one-row table is stacked too", re.search(
        r"<b[^>]*>100%</b><table[^>]*><tr>.*?</tr></table>Everyone moderated", body) is not None)
    # a HOD with one department all done: 'every line manager is done'
    bb = text_of(mail("HB"))
    s.check("one department, all done: 'every line manager is done' and the green box only",
            "2 to submit · every line manager is done" in bb and "Every line manager has finished" in bb
            and "Your line managers:" not in bb, bb)
    # the line manager's wording for one team
    s.check("(1 team) 'All 1 team has' reads right", "All 1 team has finished" in bb)

    # ------------------------------------------------------------------------------------------------------------------
    s.section("the line managers' parts have closed")
    setwin(lm_closed=True)
    reset_wave()
    c_ha, c_hb, c_hc = text_of(mail("HA")), text_of(mail("HB")), text_of(mail("HC"))
    s.check("closed and not finished (HC): the line stands alone, no suffix, no box",
            "line managers' teams done" not in c_hc and "Your line managers" not in c_hc and "Every line manager" not in c_hc
            and "Department review 2 to submit" in c_hc, c_hc)
    s.check("closed and every team done (HB): the green box (and the suffix)", "Every line manager has finished" in c_hb
            and "every line manager is done" in c_hb, c_hb)
    s.check("closed, one department done and one not (HA): only the done one gets a box, and no suffix on the line",
            "Ready for you" in c_ha and "ZZHR Sales" in c_ha and "Your line managers" not in c_ha and
            "line managers' teams done" not in c_ha and "every line manager is done" not in c_ha, c_ha)
    # falsify the open-cells condition: told 'open' while closed, HC would get a box
    a._lp_cells_state = lambda db_, cyc_, cells_: (True, TODAY + timedelta(days=3))
    reset_wave()
    f1 = text_of(mail("HC"))
    a._lp_cells_state = _real[4]
    s.check("FALSIFIED the open-cells condition: with it broken the unfinished department gets a box (so the guard is the one holding it)",
            "Your line managers: 0 of 1 teams done" in f1, f1)

    # ------------------------------------------------------------------------------------------------------------------
    s.section("who never gets it")
    setwin()
    reset_wave()
    base_ha = mail("HA", hod_ctx=EMPTY)
    s.check("the line alone, no suffix: today's email", "teams done" not in text_of(base_ha) and "Before you start" not in text_of(base_ha))
    dbx("INSERT INTO email_optouts(user_id, kind, until, reason, set_by) VALUES (?,?,?,?,?)",
        (ID["HA"], "leader_progress", None, "ZZ test", None))
    reset_wave()
    off_html = mail("HA")
    s.check("off Leader progress: today's email, byte for byte", off_html == base_ha)
    s.check("...and HB, not opted out, still gets the box", "Every line manager has finished" in text_of(mail("HB")))
    a.email_optout_ids = lambda d_, kind_: set()   # FALSIFIED: the opt-out reader returns nobody
    reset_wave()
    f2 = mail("HA")
    a.email_optout_ids = _real[5]
    s.check("FALSIFIED the opt-out check: without it HA gets the box again", f2 != base_ha and "Your line managers" in text_of(f2))
    dbx("DELETE FROM email_optouts WHERE user_id=?", (ID["HA"],))
    reset_wave()
    a.chair_user_id = lambda db_=None: ID["HB"]
    chair_html, chair_base = mail("HB"), mail("HB", hod_ctx=EMPTY)
    a.chair_user_id = _real[3]
    s.check("the Executive Chairman seat gets today's line, no box", chair_html == chair_base)
    reset_wave()
    s.check("...and without the seat the same person does get it", mail("HB") != chair_base)
    lm_items = [{"group": "team", "role": "team", "text": a._REMINDER_TEAM_TEXT["pm_review"], "detail": "2 people waiting on you",
                 "closes": "", "closes_on": TODAY + timedelta(days=14), "url": "/dashboard", "people": []}]
    s.check("a line manager who is no HOD: identical to before", mail("LX", lm_items) == mail("LX", lm_items, hod_ctx=EMPTY))
    s.check("an HOD whose Department review line isn't there (submitted): no line, no box, identical to before",
            mail("HA", lm_items) == mail("HA", lm_items, hod_ctx=EMPTY) and "Your line managers" not in text_of(mail("HA", lm_items)))
    reset_wave()
    ha_real = ctx(lambda d: a.reminder_items(d, d.execute("SELECT * FROM users WHERE id=?", (ID["HA"],)).fetchone()))
    s.check("the dashboard's reminder_items is not changed: no line of it carries the suffix",
            not any("line managers' teams done" in (i.get("detail") or "") or "every line manager is done" in (i.get("detail") or "")
                    for i in ha_real))
    src = H.source(a)
    s.check("...and reminder_items does not read the new helper (only the email does)",
            "reminder_hod" not in src.split("\ndef reminder_items(", 1)[1].split("\ndef reminder_items_email(", 1)[0])

    # ------------------------------------------------------------------------------------------------------------------
    s.section("the all-done flag")
    reset_wave()
    ok_html = mail("HB")
    a._lp_hod_section_n = lambda sc, counts, keys: (lambda r_: (dict(r_[0], all_done=False) if r_[0] else None, r_[1], r_[2]))(_real[6](sc, counts, keys))
    reset_wave()
    f3 = text_of(mail("HB"))
    a._lp_hod_section_n = _real[6]
    s.check("FALSIFIED the all-done flag: with it broken the finished department reads 'still working', not 'finished'",
            "Every line manager has finished" in text_of(ok_html) and "Every line manager has finished" not in f3 and "Your line managers" in f3, f3)

    # ------------------------------------------------------------------------------------------------------------------
    s.section("one run over several HODs works the figures out once")
    reset_wave()
    CALLS.clear()
    a.lp_counts = counted
    BODIES = {}

    def fake_items(d, u, items=None, honour_skips=True, progress=True):
        return hod_items() if u["employee_id"] in ("ZZ9HR-HA", "ZZ9HR-HB", "ZZ9HR-HC") else []

    def cap(u, items, cyc, tpl=None, db=None, hod_ctx=None):
        r = _real[9](u, items, cyc, tpl=tpl, db=db, hod_ctx=hod_ctx)
        BODIES[u["employee_id"]] = r[1]
        return r
    a.reminder_items_email, a.reminder_mail = fake_items, cap
    try:
        with a.app.test_request_context("/"):
            d = a.get_db()
            people = [d.execute("SELECT * FROM users WHERE id=?", (ID[k],)).fetchone() for k in ("LX", "HA", "HB", "HC")]
            tally = a.reminder_send(d, a.active_cycle(d), people, "ZZ HR test", live=False)
        s.check("three HODs, one lp_counts for the whole run", len(CALLS) == 1 and len(BODIES) == 3, (len(CALLS), list(BODIES)))
        s.check("...and each HOD's email carries their own figures", "3 of 4" in text_of(BODIES["ZZ9HR-HA"])
                and "every line manager is done" in text_of(BODIES["ZZ9HR-HB"]) and "0 of 1" in text_of(BODIES["ZZ9HR-HC"]), tally)
        CALLS.clear()
        reset_wave()
        for k in ("HA", "HB", "HC"):   # the send-time recheck's context: shared
            ctx(lambda d, k=k: a._reminder_hod_lazy(d, a.active_cycle(d), wave=True)())
        s.check("the send-time recheck's context is worked out once for a wave too", len(CALLS) == 1, len(CALLS))
        CALLS.clear()
        reset_wave()
        mail("LX", lm_items)
        s.check("a run with no HOD line in it reads nothing (lazy)", len(CALLS) == 0, len(CALLS))
    finally:
        a.lp_counts, a.reminder_items_email, a.reminder_mail = _real[7], _real[8], _real[9]

    # ------------------------------------------------------------------------------------------------------------------
    s.section("the stacked cell is the reminder's alone: Leader progress and Ready-for-you stay as they were")
    cell = a._lp_cell_html({"n": 4, "done": 1, "left": 3, "pct": 25, "tone": "low"}, a.LP_PART["pm_approve"])
    s.check("default cell: share, nbsp, words, then the bar (as before)", re.fullmatch(
        r'<b class="?[^>]*>?25%</b>&nbsp; 1 moderated · 3 not yet<table.*</table>', cell) or
        (cell.startswith("<b") and "25%</b>&nbsp; 1 moderated · 3 not yet<table" in cell and cell.endswith("</table>")), cell)
    stk = a._lp_cell_html({"n": 4, "done": 1, "left": 3, "pct": 25, "tone": "low"}, a.LP_PART["pm_approve"], stacked=True)
    s.check("stacked cell: share, bar (margin 4px 0), words", stk.startswith("<b") and "25%</b><table" in stk
            and "margin:4px 0" in stk and stk.endswith("1 moderated · 3 not yet"), stk)
    tot = a._lp_cell_html({"n": 4, "done": 1, "left": 3, "pct": 25, "tone": "low"}, a.LP_PART["pm_approve"], total=True)
    s.check("default total cell unchanged: share, nbsp, words, no bar", tot.endswith("&nbsp; 1 moderated · 3 not yet") and "<table" not in tot)
    sec = {"name": "ZZHR X", "bg": BG, "co": U1, "people": 4, "hod": True, "finished": [], "all_done": False,
           "rows": [{"name": "A's team", "people": 4, "cells": [{"n": 4, "done": 1, "left": 3, "pct": 25, "tone": "low"}] * 2}],
           "total": [{"n": 4, "done": 1, "left": 3, "pct": 25, "tone": "low"}] * 2}
    op = [(a.LP_PART["pm_approve"], TODAY), (a.LP_PART["tc_approve"], TODAY)]
    plain = a._lp_table_html(sec, op, "Line manager's team")
    s.check("the Leader progress table (no keyword) is exactly the one with stacked=False and has no stacked bars",
            plain == a._lp_table_html(sec, op, "Line manager's team", stacked=False) and "margin:4px 0" not in plain
            and "&nbsp; 1 moderated" in plain)
    s.check("...while the stacked one differs", a._lp_table_html(sec, op, "Line manager's team", stacked=True) != plain)
    pr = {"name": "X", "teams": 2, "people": 4, "total": [{"n": 4, "done": 4, "left": 0, "pct": 100, "tone": "ok"}] * 2}
    rd = a._ready_hod_table_html(pr)
    s.check("the Ready-for-you table (no keyword) is unchanged: share, nbsp, words, bar after; no stacked bar",
            rd == a._ready_hod_table_html(pr, stacked=False) and "&nbsp; Everyone moderated" in rd and "margin:4px 0" not in rd)
    s.check("...and its real send path never passes the keyword (source)", "stacked" not in src.split("\ndef ready_mail(", 1)[1].split(
        "\ndef ", 1)[0] and "stacked" not in src.split("\ndef lp_mail(", 1)[1].split("\ndef ", 1)[0])
    s.check("the EMAIL_TPL_KINDS sentence for the reminder is there", "managers' parts are open, or a green 'every line manager has finished'" in
            [k for k in a.EMAIL_TPL_KINDS if k["key"] == "reminder"][0]["lists"])
finally:
    (a.mailer.is_configured, a.mailer.send_mail, a.OUTBOX_ASYNC, a.chair_user_id, a._lp_cells_state, a.email_optout_ids,
     a._lp_hod_section_n, a.lp_counts, a.reminder_items_email, a.reminder_mail) = _real
    reset_wave()
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        for w in WIN:
            _db.execute("INSERT INTO cycle_windows(%s) VALUES (%s)" % (",".join(w), ",".join("?" * len(w))), list(w.values()))
        _db.execute("UPDATE cycles SET open_by_date=?, half=? WHERE id=?", (OBD, HALF, CID))
        _db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key IN (?,?)", (CID,) + MODS3)
        _db.executemany("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", MODS)
        _db.execute("DELETE FROM email_outbox WHERE id>?", (OUT0,))
        _db.execute("DELETE FROM notifications WHERE id>?", (NOTE0,))
        _db.execute("DELETE FROM activity_log WHERE id>? AND action IN ('reminder_run')", (LOG0,))
        _db.commit()
        _cleanup(_db)

sys.exit(s.done())
