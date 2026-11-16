"""A line that JOINS a BU KPI Group People already filled takes the unit's figure (2026-11-07).

The bug: Fill BU KPI writes a final result (admin_filled=1, draft=0) on every line linked to the setup at that moment. A person
linked AFTERWARDS had no result, so the Fill page read "Filled, N to fill" until someone filled the unit again. Now every join
goes through _bu_kpi_apply, which collects the lines NEWLY linked in the call and hands them to ONE function, _bu_fill_carry:
it copies the unit's latest filled result (value, remark, who, when) onto each of them that has no result row, check-in or
moderation, in the same transaction, with no email and no new note.

What this suite holds (synthetic ZZ9BJ-* people, ZZBJ units; it puts back what it changes):
  * the setup save (route) adding a holder to a filled setup: an admin_filled, draft=0 result equal to the unit's figure, the
    remark, the filler and the SAME submitted_at as the source (a copy, not a new fill); the others' results untouched; one audit
    row per person, ids only and no figure; no notification and no email for the person
  * the person page's add_bu (route), Add a person (route, "skip" the KPIs), the KPI import join (_kti_bu_join) and the unit move's
    call (_bu_kpi_apply with only=, direct): the same
  * a setup with no fill: the joiner gets no result row
  * the guard, falsified: a line already holding a draft result, or a check-in, that is adopted by a setup save is NOT overwritten
  * an already-linked line with no result (a gap from before) is NOT back-filled by a later setup save of its setup
  * after a refill at another figure the joiner takes the LATEST figure, while an older figure still stands on a line
  * a line joining in the same call as the only filled line takes nothing from it; a line of another setup is never written
  * Fill BU KPI then counts the joiner: no "to fill", the filled map counts every line
  * the "something changed" email: a started person joining a filled setup is NOT emailed (the line arrives with a result, which
    _redo_applies already treats as nothing to fill), while the same join on an unfilled setup still is
"""
import atexit
import html
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A line joining a filled BU KPI takes the unit's figure")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO, CO2, CO3 = "ZZBJ Group", "ZZBJ Unit", "ZZBJ Unit B", "ZZBJ Unit C"
PFX = "ZZ9BJ-"
U = {}
FIXED = "2026-11-05 09:00:00"     # the unit's fill, set by hand so a copy is told from a new row
OLDER = "2026-11-01 08:00:00"


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9BJ-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        tl = [r[0] for r in db.execute("SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)]
        if tl:
            pt = ",".join("?" * len(tl))
            for tb in ("pm_kpi_approvals", "pm_kpi_results", "pm_kpi_target_approvers", "pm_checkins"):
                db.execute("DELETE FROM %s WHERE kpi_target_id IN (%s)" % (tb, pt), tl)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM email_outbox WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM notifications WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE action IN ('pm_bu_fill','pm_bu_kpi') AND detail LIKE '%ZZBJ%'")
    db.execute("DELETE FROM pm_bu_kpis WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def say(r):
    return html.unescape(r.get_data(as_text=True))


def flat(h):
    h = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", h)
    m = re.search(r'<main id="main"[\s\S]*', h)
    h = m.group(0) if m else h
    h = re.sub(r"<[^>]+>", " ", h)
    return " ".join(html.unescape(h).split())


def card(h):
    m = re.search(r'<form method="post" id="bf-form"[\s\S]*?</form>', h)
    return m.group(0) if m else ""


def rail_row(h, kpi):
    m = re.search(r'<a class="bk2-row[^"]*"[^>]*kpi_name=%s[^>]*>[\s\S]*?</a>' % re.escape(kpi.replace(" ", "+")), h)
    return flat(m.group(0)) if m else ""


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    CYC = dict(a.active_cycle(db))
    PREV = {k: CYC[k] for k in ("kind", "year", "half", "min_job_grade", "open_by_date")}
    WIN0 = [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=?", (CID,))]
    MOD0 = [tuple(r) for r in db.execute("SELECT cycle_id, module_key, active FROM cycle_modules WHERE cycle_id=?", (CID,))]
    MAIL0, KICK0 = a.mailer.is_configured, a._outbox_kick

    def _put_back():
        a.mailer.is_configured, a._outbox_kick = MAIL0, KICK0
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("UPDATE cycles SET kind=?, year=?, half=?, min_job_grade=?, open_by_date=? WHERE id=?",
                       (PREV["kind"], PREV["year"], PREV["half"], PREV["min_job_grade"], PREV["open_by_date"], CID))
            d_.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
            for w in WIN0:
                d_.execute("INSERT INTO cycle_windows(%s) VALUES (%s)" % (",".join(w), ",".join("?" * len(w))), list(w.values()))
            d_.execute("DELETE FROM cycle_modules WHERE cycle_id=?", (CID,))
            for m_ in MOD0:
                d_.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", m_)
            _cleanup(d_)
    atexit.register(_put_back)
    # a Year-End (not an Early Year) with the Department Review still to come: BU KPI setup is open to the super admin
    db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL, open_by_date=0 WHERE id=?", (CID,))
    for mk_ in ("pm", "tm", "idp", "calibration", "evidence", "review"):
        db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1) ON CONFLICT(cycle_id, module_key) "
                   "DO UPDATE SET active=1", (CID, mk_))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', '2099-11-02 00:00', "
               "'2099-11-08 23:59')", (CID,))
    for cell in ("pm_results", "tc_self", "pm_approve", "tc_approve"):
        db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?, '2020-01-01 00:00', NULL)", (CID, cell))
    for co in (CO, CO2, CO3):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, co))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
    LIB = {}
    for nm, bu in (("ZZBJ PAT", 1), ("ZZBJ Margin", 1), ("ZZBJ Uptime", 1), ("ZZBJ Sales", 0), ("ZZBJ Own", 0)):
        LIB[nm] = db.execute(
            "INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, unit, "
            "method, rate1, rate2, rate3, rate4, rate5, weightage_default, bu_level) VALUES (?, '*', '*', 0, '*', ?, "
            "'Financial · Profit', '%', 'more', 90, 95, 100, 105, 110, 20, ?)", (BG, nm, bu)).lastrowid

    def mk(key, co=CO, grade="14"):
        U[key] = db.execute(
            "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
            "job_title, job_grade, confirmation_date, email) VALUES (?,?, 'x', 'user', ?,?,?, 'ZZBJ Dept', 'ZZ Analyst', ?, "
            "'2020-01-01', ?)", ((PFX + key).lower(), "ZZ BJ " + key, PFX + key, BG, co, grade,
                                 "zzbj.%s@example.test" % key.lower())).lastrowid
        return U[key]
    for k in ("A", "B", "C", "D", "P", "Q", "G", "H", "Z", "R", "W", "V", "T1", "T2"):
        mk(k)
    mk("F1", CO2)
    mk("Y", CO)
    mk("N", CO2)
    for k in ("R1", "R2", "R3"):
        mk(k, CO3)

    def put(d_, who, name, w, co=CO, bu=None, rates=(80, 90, 100, 110, 120)):
        return d_.execute(
            "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, rate2, rate3, "
            "rate4, rate5, business_group, company, library_id, bu_kpi_id) VALUES (?,?,?,?, 'more', '%', 'Own', ?,?,?,?,?, ?,?,?,?)",
            (CID, U[who], name, w) + tuple(rates) + (BG, co, LIB.get(name), bu)).lastrowid
    put(db, "A", "ZZBJ PAT", 30)
    put(db, "B", "ZZBJ PAT", 20)
    put(db, "A", "ZZBJ Margin", 30)
    put(db, "B", "ZZBJ Margin", 30)
    put(db, "A", "ZZBJ Uptime", 10)
    put(db, "B", "ZZBJ Uptime", 10)
    put(db, "D", "ZZBJ Sales", 40)
    T_G = put(db, "G", "ZZBJ PAT", 25)       # their own line of the setup's name: the setup adopts it
    T_H = put(db, "H", "ZZBJ PAT", 25)
    T_Z = put(db, "Z", "ZZBJ PAT", 25)
    db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, draft) VALUES (?, 7, 'ZZ own draft', ?, 1)",
               (T_G, U["G"]))
    db.execute("INSERT INTO pm_checkins(kpi_target_id, answer, note, answered_by) VALUES (?, 'on_track', 'ZZ check-in', ?)",
               (T_H, U["H"]))
    db.commit()
SUP = H.client_as(a, SU["id"])
URL = "/admin/performance/bu-kpis?fbg=%s&fbu=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"))
FILL = "/admin/performance/bu-fill"


def eid(k):
    return PFX + k


def card_form(lid, holders, adds=None, rates=(80, 90, 100, 110, 120)):
    k = "k%d_" % lid
    f = {k + "rate%d" % i: str(v) for i, v in enumerate(rates, 1)}
    f.update({k + "carriers": "holders", k + "wmode": "own", k + "unit": "%", k + "holder_set": "1",
              k + "holder": [eid(h) for h in holders]})
    for who, w in (adds or {}).items():
        f.setdefault(k + "addp", []).append(eid(who))
        f[k + "addw_" + eid(who)] = w
    return f


def save_kpi(lid, holders, adds=None):
    d = {"csrf_token": "tok", "action": "save_kpi", "kpi": str(lid)}
    d.update(card_form(lid, holders, adds))
    return say(SUP.post(URL, data=d, follow_redirects=True))


def fill(kpi, value, co=CO, note="ZZ unit note"):
    return say(SUP.post(FILL, follow_redirects=True, data={
        "csrf_token": "tok", "business_group": BG, "company": co, "kpi_name": kpi, "actual_value": str(value), "note": note,
        "reason": "ZZ audited figure"}))


def sid_of(name, co=CO):
    return H.one(a, "SELECT id FROM pm_bu_kpis WHERE cycle_id=? AND business_group=? AND company=? AND kpi_name=?", (CID, BG, co, name))


def holders_now(name):
    r = H.rows(a, "SELECT carriers_json FROM pm_bu_kpis WHERE cycle_id=? AND business_group=? AND company=? AND kpi_name=?",
               (CID, BG, CO, name))
    return [x[len(PFX):] for x in (json.loads(r[0][0] or "{}").get("people") or [])] if r else []


def res(k, name):
    """(value, note, submitted_by, submitted_at, admin_filled, draft) of the person's line of that name, or None."""
    r = H.rows(a, "SELECT r.actual_value, r.note, r.submitted_by, r.submitted_at, r.admin_filled, r.draft FROM pm_kpi_results r "
                  "JOIN pm_kpi_targets t ON t.id=r.kpi_target_id WHERE t.cycle_id=? AND t.subject_id=? AND t.kpi_name=?",
               (CID, U[k], name))
    return tuple(r[0]) if r else None


def tid_of(k, name):
    return H.one(a, "SELECT id FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? AND kpi_name=?", (CID, U[k], name))


def linked(k, name):
    r = H.rows(a, "SELECT bu_kpi_id FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? AND kpi_name=?", (CID, U[k], name))
    return r[0][0] if r else None


def trail(k):
    return [r[0] for r in H.rows(a, "SELECT detail FROM activity_log WHERE action='pm_bu_fill' AND target_user_id=? ORDER BY id", (U[k],))]


def n_of(sql, *args):
    return H.one(a, sql, args)


def ctx(fn):
    """fn(db, me row, cycle row) in a request context, committed (the redo email reads the request's bucket)."""
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        me_ = d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        act_ = d_.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()
        out = fn(d_, me_, act_)
        d_.commit()
        return out


def unit_people(co, ids):
    return lambda d_: [p for p in a._bu_unit_people(d_, BG, co) if p["id"] in ids]


def person_post(who, setup, weight):
    return SUP.post("/admin/users/%d/kpi" % U[who], data={"csrf_token": "tok", "action": "add_bu", "bu_setup": str(setup),
                                                          "weight": weight}, follow_redirects=True)


try:
    PAT, MAR, UPT = LIB["ZZBJ PAT"], LIB["ZZBJ Margin"], LIB["ZZBJ Uptime"]
    # ---------------------------------------------------------------------------------------------------------------
    s.section("set up: PAT saved for A and B, then filled once by Group People through the Fill BU KPI route")
    save_kpi(PAT, ["A", "B"])
    SID = sid_of("ZZBJ PAT")
    s.check("PAT is saved for A and B, linked", SID and linked("A", "ZZBJ PAT") == SID and linked("B", "ZZBJ PAT") == SID, SID)
    out = fill("ZZBJ PAT", 104)
    s.check("the fill wrote a final admin-filled result on both", "Filled 2 of 2 matching" in out and all(
        res(k, "ZZBJ PAT") and res(k, "ZZBJ PAT")[4:] == (1, 0) and res(k, "ZZBJ PAT")[0] == 104 for k in ("A", "B")))
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE pm_kpi_results SET submitted_at=? WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE bu_kpi_id=?)",
                   (FIXED, SID))
        d_.commit()
    SRC = res("A", "ZZBJ PAT")
    s.check("(set-up) the unit's figure: 104, the note, Group People's id, the fixed day", SRC[0] == 104 and SRC[1] == "ZZ unit note"
            and SRC[2] == SU["id"] and SRC[3] == FIXED, SRC)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the setup save (route) adds C to a filled setup")
    b_before = res("B", "ZZBJ PAT")
    n_notes0, n_mail0 = n_of("SELECT COUNT(*) FROM notifications WHERE user_id=?", U["C"]), n_of(
        "SELECT COUNT(*) FROM email_outbox WHERE user_id=?", U["C"])
    out = save_kpi(PAT, holders_now("ZZBJ PAT"), adds={"C": "20"})
    rc = res("C", "ZZBJ PAT")
    s.check("C joined the setup (a line linked to it)", linked("C", "ZZBJ PAT") == SID and "ZZBJ PAT saved" in out)
    s.check("...and holds an admin-filled, final result equal to the unit's figure: value, remark, who, and the SAME day as the source",
            rc == SRC, (rc, SRC))
    s.check("...the others' results are byte for byte as they were", res("A", "ZZBJ PAT") == SRC and res("B", "ZZBJ PAT") == b_before)
    tr = trail("C")
    s.check("one audit row for C: ids only, naming the setup and the line, and no figure",
            len(tr) == 1 and ("setup %d" % SID) in tr[0] and ("line %d" % tid_of("C", "ZZBJ PAT")) in tr[0]
            and "104" not in tr[0] and "ZZ BJ" not in tr[0], tr)
    s.check("no new in-app note and no email for C from the carry",
            n_of("SELECT COUNT(*) FROM notifications WHERE user_id=?", U["C"]) == n_notes0
            and n_of("SELECT COUNT(*) FROM email_outbox WHERE user_id=?", U["C"]) == n_mail0)
    s.check("nobody else got an audit row", n_of("SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_fill' AND target_user_id IN (?,?)",
                                                 U["A"], U["B"]) == 0)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the person page's Add a KPI (route, add_bu) adds D")
    r = person_post("D", SID, "20")
    rd = res("D", "ZZBJ PAT")
    s.check("D joined through add_bu", linked("D", "ZZBJ PAT") == SID)
    s.check("...and holds the unit's figure, copied as it is", rd == SRC, rd)
    s.check("...with one audit row", len(trail("D")) == 1, trail("D"))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("an already-linked line with no result (a gap) is not back-filled by a later save; the joiner beside it is")
    with a.app.app_context():   # linked after the fill, as production's gaps were: a line on the setup, no result
        d_ = a.get_db()
        put(d_, "P", "ZZBJ PAT", 10, bu=SID, rates=(70, 80, 90, 100, 110))   # its figures differ, so the save retargets it too
        d_.execute("UPDATE pm_bu_kpis SET carriers_json=? WHERE id=?", (json.dumps({"people": sorted(
            {eid(h) for h in holders_now("ZZBJ PAT")} | {eid("P")})}), SID))
        d_.commit()
    s.check("(set-up) P holds a linked line and no result", linked("P", "ZZBJ PAT") == SID and res("P", "ZZBJ PAT") is None)
    t_p = tid_of("P", "ZZBJ PAT")
    save_kpi(PAT, holders_now("ZZBJ PAT"), adds={"Q": "20"})
    s.check("Q joined and took the unit's figure", linked("Q", "ZZBJ PAT") == SID and res("Q", "ZZBJ PAT") == SRC, res("Q", "ZZBJ PAT"))
    s.check("P, linked before this save, is NOT back-filled (a production data step, never a setup save)",
            res("P", "ZZBJ PAT") is None and trail("P") == [], (res("P", "ZZBJ PAT"), trail("P")))
    s.check("...although that save did reach P's line (it took the unit's target: the retarget ran)",
            n_of("SELECT rate1 FROM pm_kpi_targets WHERE id=?", t_p) == 80, n_of("SELECT rate1 FROM pm_kpi_targets WHERE id=?", t_p))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the guard, falsified: a line with a result of its own, or a check-in, is adopted but never overwritten")
    g0, h0 = res("G", "ZZBJ PAT"), res("H", "ZZBJ PAT")
    s.check("(set-up) G holds an own draft, H an own check-in and no result", g0 == (7, "ZZ own draft", U["G"], g0[3], 0, 1) and h0 is None, (g0, h0))
    save_kpi(PAT, holders_now("ZZBJ PAT") + ["G", "H"])
    s.check("G and H were adopted onto the setup (linked)", linked("G", "ZZBJ PAT") == SID and linked("H", "ZZBJ PAT") == SID,
            (linked("G", "ZZBJ PAT"), linked("H", "ZZBJ PAT")))
    s.check("G's own draft is exactly as it was (not replaced by the unit's figure)", res("G", "ZZBJ PAT") == g0, res("G", "ZZBJ PAT"))
    s.check("H's line, with a check-in, got no result written over it", res("H", "ZZBJ PAT") is None, res("H", "ZZBJ PAT"))
    s.check("no audit row for either", trail("G") == [] and trail("H") == [])

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the KPI import join (_kti_bu_join, called directly: no file is uploaded here)")
    s.check("(set-up) Z's own line of that name is not linked yet and has no result", linked("Z", "ZZBJ PAT") is None
            and res("Z", "ZZBJ PAT") is None)
    ok = ctx(lambda d_, me_, act_: a._kti_bu_join(d_, me_, act_, {"setup_id": SID, "subject_id": U["Z"]}, T_Z))
    s.check("the join succeeded and linked the line (it was linked before _bu_kpi_apply saw it)", ok and linked("Z", "ZZBJ PAT") == SID, ok)
    s.check("...and the joined line holds the unit's figure", res("Z", "ZZBJ PAT") == SRC, res("Z", "ZZBJ PAT"))
    s.check("...called again it changes nothing (a line with a result is skipped)", ctx(
        lambda d_, me_, act_: a._bu_fill_carry(d_, me_, act_, d_.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (SID,)).fetchone(), [T_Z])) == 0
        and res("Z", "ZZBJ PAT") == SRC and len(trail("Z")) == 1, trail("Z"))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("a setup with NO fill: the joiner gets no result row")
    save_kpi(MAR, ["A", "B"])
    MSID = sid_of("ZZBJ Margin")
    save_kpi(MAR, holders_now("ZZBJ Margin"), adds={"W": "20"})
    s.check("W joined Margin", linked("W", "ZZBJ Margin") == MSID, linked("W", "ZZBJ Margin"))
    s.check("...and has no result row, and no audit row (nothing was filled to carry)", res("W", "ZZBJ Margin") is None and trail("W") == [])

    # ---------------------------------------------------------------------------------------------------------------
    s.section("after a refill the joiner takes the LATEST figure, while an older figure still stands on a line")
    fill("ZZBJ PAT", 106, note="ZZ refill")
    with a.app.app_context():   # a calibrated line keeps the older figure: Z's result put back to 104, an older day
        d_ = a.get_db()
        d_.execute("UPDATE pm_kpi_results SET actual_value=104, note='ZZ unit note', submitted_at=? WHERE kpi_target_id=?", (OLDER, T_Z))
        d_.commit()
    newest = H.one(a, "SELECT MAX(r.submitted_at) FROM pm_kpi_results r JOIN pm_kpi_targets t ON t.id=r.kpi_target_id WHERE t.bu_kpi_id=?", (SID,))
    s.check("(set-up) the unit now holds 106 on most lines and the older 104 on one", res("A", "ZZBJ PAT")[0] == 106 and res("Z", "ZZBJ PAT")[0] == 104
            and newest > OLDER, (res("A", "ZZBJ PAT"), res("Z", "ZZBJ PAT"), newest))
    save_kpi(PAT, holders_now("ZZBJ PAT"), adds={"R": "20"})
    rr = res("R", "ZZBJ PAT")
    s.check("R took the LATEST figure: 106, the refill's remark and its day, not the older 104", rr and rr[0] == 106 and rr[1] == "ZZ refill"
            and rr[3] == newest and rr[4:] == (1, 0), (rr, newest))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("Add a person (route) and the unit move's call, into a unit whose KPI Group People already filled")
    with a.app.app_context():
        d_ = a.get_db()
        # Revenue B: a setup of unit B for everyone, one weight; F1 carries it and Group People filled it
        RSID = d_.execute("INSERT INTO pm_bu_kpis(cycle_id, business_group, company, kpi_name, unit, method, rate1, rate2, rate3, rate4, "
                          "rate5, carriers, weight_mode, weight) VALUES (?,?,?, 'ZZBJ Revenue B', '%', 'more', 80,90,100,110,120, "
                          "'everyone', 'one', 10)", (CID, BG, CO2)).lastrowid
        d_.commit()
    ctx(lambda d_, me_, act_: a._bu_kpi_apply(d_, me_, act_, d_.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (RSID,)).fetchone(),
                                              unit_people(CO2, {U["F1"]})(d_), locked_ok=True))
    fill("ZZBJ Revenue B", 99, co=CO2, note="ZZ unit B note")
    RSRC = res("F1", "ZZBJ Revenue B")
    s.check("(set-up) F1 carries it and it is filled", RSRC and RSRC[0] == 99 and RSRC[4:] == (1, 0), RSRC)
    r = SUP.post("/admin/people/add/%d" % U["N"], data={"csrf_token": "tok", "action": "kpis", "then": "skip"}, follow_redirects=False)
    rn = res("N", "ZZBJ Revenue B")
    s.check("Add a person (KPIs skipped): N's BU KPI line came on", linked("N", "ZZBJ Revenue B") == RSID and r.status_code in (302, 303), (r.status_code,))
    s.check("...with the unit's figure, as a copy", rn is not None and rn[:5] == RSRC[:5] and rn[3] == RSRC[3] and rn[4:] == (1, 0), (rn, RSRC))
    # the unit move: Y changes unit (the route's own statement), then the route's call: apply(only=) for the new unit's setups
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE users SET company=? WHERE id=?", (CO2, U["Y"]))
        d_.commit()
    nadd = ctx(lambda d_, me_, act_: a._bu_kpi_apply(d_, me_, act_, d_.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (RSID,)).fetchone(),
                                                     unit_people(CO2, {U["Y"]})(d_), only=U["Y"]))
    ry = res("Y", "ZZBJ Revenue B")
    s.check("the unit move's call (_bu_kpi_apply only=, direct): Y added and holding the unit's figure", nadd["added"] == 1 and nadd["carried"] == 1
            and ry is not None and ry[:5] == RSRC[:5], (nadd, ry))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the shared function on its own")
    # a Solo setup: its only filled line joins in the same call as another line -> nothing to copy from
    with a.app.app_context():
        d_ = a.get_db()
        SOLO = d_.execute("INSERT INTO pm_bu_kpis(cycle_id, business_group, company, kpi_name, unit, method, carriers, weight_mode) "
                          "VALUES (?,?,?, 'ZZBJ Solo', '%', 'more', 'everyone', 'own')", (CID, BG, CO)).lastrowid
        t1 = put(d_, "T1", "ZZBJ Solo", 10, bu=SOLO)
        t2 = put(d_, "T2", "ZZBJ Solo", 10, bu=SOLO)
        d_.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, admin_filled, draft) VALUES (?, 5, 'x', ?, 1, 0)",
                   (t1, SU["id"]))
        d_.commit()
    n_pm = n_of("SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_fill'")
    nc = ctx(lambda d_, me_, act_: a._bu_fill_carry(d_, me_, act_, d_.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (SOLO,)).fetchone(), [t1, t2]))
    s.check("the filled line is not its own source: with only that one filled and both joining, nothing is copied", nc == 0
            and res("T2", "ZZBJ Solo") is None and n_of("SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_fill'") == n_pm, nc)
    nc = ctx(lambda d_, me_, act_: a._bu_fill_carry(d_, me_, act_, d_.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (SOLO,)).fetchone(), [t2]))
    s.check("...but with the filled line staying out of the call, the other takes it", nc == 1 and res("T2", "ZZBJ Solo")[0] == 5, nc)
    # a line of ANOTHER setup named in tids is never written; an empty list is nothing
    nc = ctx(lambda d_, me_, act_: a._bu_fill_carry(d_, me_, act_, d_.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (SOLO,)).fetchone(),
                                                    [tid_of("W", "ZZBJ Margin")]))
    s.check("a line of another setup passed in is skipped, and an empty list returns 0", nc == 0 and res("W", "ZZBJ Margin") is None and ctx(
        lambda d_, me_, act_: a._bu_fill_carry(d_, me_, act_, d_.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (SOLO,)).fetchone(), [])) == 0)
    # nothing is sent: counts of notes, mail and audit rows around a carry onto a fresh linked line
    with a.app.app_context():
        d_ = a.get_db()
        t3 = put(d_, "V", "ZZBJ Solo", 10, bu=SOLO)
        d_.commit()
    before = (n_of("SELECT COUNT(*) FROM notifications"), n_of("SELECT COUNT(*) FROM email_outbox"), n_of("SELECT COUNT(*) FROM activity_log"))
    nc = ctx(lambda d_, me_, act_: a._bu_fill_carry(d_, me_, act_, d_.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (SOLO,)).fetchone(), [t3]))
    after = (n_of("SELECT COUNT(*) FROM notifications"), n_of("SELECT COUNT(*) FROM email_outbox"), n_of("SELECT COUNT(*) FROM activity_log"))
    s.check("a carry sends no email and writes no note: only its one audit row is new", nc == 1 and after[0] == before[0]
            and after[1] == before[1] and after[2] == before[2] + 1, (before, after))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("Fill BU KPI reads the joiner as filled")
    save_kpi(UPT, ["A", "B"])
    fill("ZZBJ Uptime", 99.5)
    save_kpi(UPT, holders_now("ZZBJ Uptime"), adds={"V": "10"})
    with a.app.app_context():
        d_ = a.get_db()
        me_ = d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        period = a.active_pm_period(d_)
        fm = a._bu_filled_map(d_, me_, period, BG, CO)
    f1 = fm.get((CO, a._kpi_key("ZZBJ Uptime")))
    lines_n = n_of("SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND bu_kpi_id=?", CID, sid_of("ZZBJ Uptime"))
    s.check("the filled map counts every line of the setup (the joiner too) at the one figure", f1 and f1["n"] == lines_n == 3
            and list(f1["values"]) == [99.5], (f1, lines_n))
    pg = say(SUP.get("%s?business_group=%s&company=%s&kpi_name=%s" % (FILL, BG.replace(" ", "+"), CO.replace(" ", "+"), "ZZBJ+Uptime")))
    s.check("the page says Filled with nothing left 'to fill', on the card and in the rail",
            "to fill" not in flat(card(pg)) and "to fill" not in rail_row(pg, "ZZBJ Uptime") and "Filled" in rail_row(pg, "ZZBJ Uptime"),
            (flat(card(pg))[:200], rail_row(pg, "ZZBJ Uptime")))
    # falsified: the same page does read "1 to fill" when a line is linked without a result (the bug's old shape)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id=?", (tid_of("V", "ZZBJ Uptime"),))
        d_.commit()
    pg = say(SUP.get("%s?business_group=%s&company=%s&kpi_name=%s" % (FILL, BG.replace(" ", "+"), CO.replace(" ", "+"), "ZZBJ+Uptime")))
    s.check("falsified: with the joiner's result taken away, the page reads '1 to fill' again", "1 to fill" in rail_row(pg, "ZZBJ Uptime"),
            rail_row(pg, "ZZBJ Uptime"))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the 'something changed' email: a started person joining a filled setup is not emailed; an unfilled one is")
    a.mailer.is_configured = lambda: True
    a._outbox_kick = lambda *x, **k: None
    with a.app.app_context():
        d_ = a.get_db()
        for k in ("R2", "R3"):   # both have started their check-in: an own result of their own (a draft) on another line
            t_ = d_.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, rate2, "
                            "rate3, rate4, rate5, business_group, company, status) VALUES (?,?, 'ZZBJ Personal', 30, 'more', 'RM', "
                            "'Own', 1,2,3,4,5, ?,?, 'approved')", (CID, U[k], BG, CO3)).lastrowid
            d_.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, draft) VALUES (?, 3, 'ZZ', ?, 1)",
                       (t_, U[k]))
        # two setups of unit C whose names the library does not mark BU-level: their lines are theirs to fill by the name rule
        MAIL1 = d_.execute("INSERT INTO pm_bu_kpis(cycle_id, business_group, company, kpi_name, method, rate1, rate2, rate3, rate4, rate5, "
                           "carriers, weight_mode, weight) VALUES (?,?,?, 'ZZBJ Mail one', 'more', 1,2,3,4,5, 'everyone', 'one', 10)",
                           (CID, BG, CO3)).lastrowid
        MAIL2 = d_.execute("INSERT INTO pm_bu_kpis(cycle_id, business_group, company, kpi_name, method, rate1, rate2, rate3, rate4, rate5, "
                           "carriers, weight_mode, weight) VALUES (?,?,?, 'ZZBJ Mail two', 'more', 1,2,3,4,5, 'everyone', 'one', 10)",
                           (CID, BG, CO3)).lastrowid
        d_.commit()

    def join(setup_id, k):
        """One 'save': the join in a request context, committed, then the end of the save flushes the collected emails."""
        with a.app.test_request_context("/"):
            d_ = a.get_db()
            me_ = d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
            act_ = d_.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()
            srow = d_.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (setup_id,)).fetchone()
            n_ = a._bu_kpi_apply(d_, me_, act_, srow, unit_people(CO3, {U[k]})(d_), only=U[k])
            d_.commit()
            a._redo_flush(d_, SU["id"])
            d_.commit()
            return n_

    def mails(k):
        return n_of("SELECT COUNT(*) FROM email_outbox WHERE kind='redo_notice' AND user_id=?", U[k])
    join(MAIL1, "R1")
    fill("ZZBJ Mail one", 3, co=CO3)
    n_r1 = res("R1", "ZZBJ Mail one")
    s.check("(set-up) R1 carries Mail one and Group People filled it", n_r1 and n_r1[0] == 3 and n_r1[4:] == (1, 0), n_r1)
    nj = join(MAIL1, "R2")
    t_r2 = tid_of("R2", "ZZBJ Mail one")

    def applies(k, t):
        return ctx(lambda d_, me_, act_: a._redo_applies(d_, act_, d_.execute("SELECT * FROM users WHERE id=?", (U[k],)).fetchone(),
                                                         {"kind": "kpi", "tid": t, "name": "x"}))
    s.check("R2 (started) joined the FILLED setup: the line arrives with the unit's figure and R2 is NOT emailed",
            nj["added"] == 1 and nj["carried"] == 1 and res("R2", "ZZBJ Mail one")[0] == 3 and mails("R2") == 0, (nj, mails("R2")))
    s.check("...because _redo_applies already reads a line with a result as nothing to fill (no change to it was needed)",
            applies("R2", t_r2) is False)
    nj = join(MAIL2, "R3")
    t_r3 = tid_of("R3", "ZZBJ Mail two")
    s.check("control: R3 (started) joined the UNFILLED setup and IS emailed once: the email path is live in this fixture",
            nj["added"] == 1 and nj["carried"] == 0 and res("R3", "ZZBJ Mail two") is None and mails("R3") == 1, (nj, mails("R3")))
    s.check("...and _redo_applies reads that line as theirs to fill", applies("R3", t_r3) is True)
finally:
    _put_back()
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
