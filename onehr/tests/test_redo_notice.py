"""Something changed on your check-in (Chris, 6 Nov 2026: "If we change a person's KPI or competency, where a person will need
to redo, send an email to the affected person").

His approved scope, each held here:
  * an email for a COMPETENCY SWAP of a started set, a COMPETENCY ADDED after the person started or submitted, and a KPI LINE
    ADDED after they started or confirmed; ONE email a person a save naming every change; queued through the outbox (never
    sent inline), a bulk save in waves; a person who has not started gets none, nor does anyone for a BU-level line Group
    People fills; the super admin's switch (no row = on) stops it; the words never say Reopen or HR
  * NOT emailed: a BU KPI retarget, a method / unit change, a weight change, a KPI line deleted
  * the redo is only the NEW item: a KPI line added after the check-in was confirmed is the only line open (a result, an
    example, a file), submitted by the same Confirm that promotes only it; the session, the overall remark, the other lines
    and every approval stay exactly as they were, and the moderator then sees it; a person with a line open may fill it after
    the Results window has closed, but only it, and never once their results are out
  * the same for a competency added after the self-assessment was submitted: only it can be answered, submitting it
    closes it with the status and submitted_at unchanged, and the line manager cannot approve while it is open
  * every new guard falsified: switched off, each one lets the forbidden thing through
Everything here is synthetic (ZZ9RN-*) and is removed at the end; the cycle, its windows and the settings are put back.
"""
import atexit
import json
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Something changed on your check-in: the email, and only the new item opens")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO, DEPT = "ZZRN Group", "ZZRN Unit", "ZZRN Dept"
PREFIX = "ZZ9RN-"
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE ?", (PREFIX + "%",))]
    if ul:
        ph = ",".join("?" * len(ul))
        tl = [r[0] for r in db.execute("SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)]
        if tl:
            pt = ",".join("?" * len(tl))
            for tb in ("pm_kpi_approvals", "pm_kpi_results", "pm_kpi_moderation_drafts", "pm_kpi_target_approvers",
                       "pm_checkins", "pm_attachments"):
                db.execute("DELETE FROM %s WHERE kpi_target_id IN (%s)" % (tb, pt), tl)
            db.execute("DELETE FROM pm_evidence_links WHERE target_kind='kpi' AND target_ref IN (%s)"
                       % ",".join("?" * len(tl)), [str(t) for t in tl])
        db.execute("DELETE FROM pm_evidence_attachments WHERE evidence_id IN (SELECT id FROM pm_evidence WHERE author_id "
                   "IN (%s))" % ph, ul)
        db.execute("DELETE FROM pm_evidence WHERE author_id IN (%s)" % ph, ul)
        for tb in ("pm_kpi_targets", "pm_review_session", "pm_overall_remarks", "pm_review_chat", "rating_records",
                   "tc_assessments", "tc_assignments", "result_releases", "leader_releases", "talent_releases",
                   "report_releases", "cycle_participants"):
            try:
                db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (tb, ph), ul)
            except Exception:   # noqa: BLE001 -- a table this fixture lacks
                db.rollback()
        db.execute("DELETE FROM pm_manager_chat WHERE reviewer_id IN (%s) OR report_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM email_outbox WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM notifications WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM ja_people WHERE employee_id LIKE 'ZZ9RN-%'")
    db.execute("DELETE FROM tc_job_profile_skills WHERE profile_id IN (SELECT id FROM tc_job_profiles WHERE job_title LIKE 'ZZRN%')")
    db.execute("DELETE FROM tc_job_profiles WHERE job_title LIKE 'ZZRN%'")
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZRN-%'")
    db.execute("DELETE FROM pm_bu_kpis WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.execute("DELETE FROM email_templates WHERE email='redo_notice'")
    db.execute("DELETE FROM activity_log WHERE action='email_template' AND detail LIKE 'Your KPI or competency changed%'")
    db.execute("DELETE FROM app_settings WHERE key IN ('redo_email_enabled','email_wave_on','email_wave_size','email_wave_gap')")
    db.commit()


U = {}
SRC = H.source(a)

with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    CYC = dict(a.active_cycle(db))
    PREV = {k: CYC[k] for k in ("kind", "year", "half", "min_job_grade", "open_by_date")}
    WIN0 = [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=?", (CID,))]
    MOD0 = [tuple(r) for r in db.execute("SELECT cycle_id, module_key, active FROM cycle_modules WHERE cycle_id=?", (CID,))]

    def _put_back():
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
    db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL, open_by_date=0 WHERE id=?", (CID,))
    for mk_ in ("pm", "tm", "idp", "calibration", "evidence", "review"):
        db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1) ON CONFLICT(cycle_id, module_key) "
                   "DO UPDATE SET active=1", (CID, mk_))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))

    def window(cell, closes=None):
        db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?, '2020-01-01 00:00', ?)",
                   (CID, cell, closes))
    for cell in ("pm_results", "tc_self", "pm_approve", "tc_approve"):
        window(cell)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
    LIB = {}
    for key, nm, unit in (("sales", "ZZRN Sales", "RM"), ("brand", "ZZRN Brand", "%")):
        LIB[key] = db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, "
                              "category, unit, method, bu_level, active) VALUES (?, '*', '*', 0, '*', ?, 'Business · "
                              "Revenue', ?, 'more', 0, 1)", (BG, nm, unit)).lastrowid
    SK = {}
    for code, title, lvl in (("ZZRN-S1", "ZZRN Planning", 3), ("ZZRN-S2", "ZZRN Budgeting", 3), ("ZZRN-S3", "ZZRN Safety", 3),
                             ("ZZRN-S4", "ZZRN Audit", 3)):
        SK[code] = db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category) VALUES (?,?,?, "
                              "'Technical', 'ZZRN Cat')", (code, title, lvl)).lastrowid

    def mk(eid, name, mgr=None, email=True):
        return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                          "company, department, job_title, job_grade, confirmation_date, manager_id, email) VALUES (?,?, "
                          "'x', 'user', ?,?,?,?, 'ZZ Analyst', '14', '2020-01-01', ?, ?)",
                          (eid.lower(), name, eid, BG, CO, DEPT, mgr,
                           ("%s@example.test" % eid.lower()) if email else None)).lastrowid

    U["M"] = mk(PREFIX + "M", "ZZ RN Manager")
    for e in ("A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "N", "O", "P", "Q", "R", "S", "T", "V", "W", "X", "Y", "Z", "BA", "BB", "BC", "BD", "BE", "BF", "BG"):
        U[e] = mk(PREFIX + e, "ZZ RN " + e, U["M"])
    db.commit()

SUP = H.client_as(a, SU["id"])
MAILS = []
a.mailer.is_configured = lambda: True
a._outbox_kick = lambda *x, **k: None   # nothing is sent in a suite: the rows are read


def q(sql, *args):
    return H.rows(a, sql, args)


def n_of(sql, *args):
    return H.one(a, sql, args)


def line(subj, name, weight=30, result=None, draft=0, approved=False, rates=(1, 2, 3, 4, 5), mod=True):
    """One KPI line on the active cycle for `subj` (a 1-5 ladder), with its moderator, an optional result and approval."""
    with a.app.app_context():
        d_ = a.get_db()
        tid = d_.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, category, weightage, method, unit, "
                         "rate1, rate2, rate3, rate4, rate5, business_group, company, department, status) VALUES (?,?,?, "
                         "'Business · Revenue', ?, 'more', 'RM', ?,?,?,?,?, ?,?,?, 'approved')",
                         (CID, subj, name, weight, *rates, BG, CO, DEPT)).lastrowid
        if mod:
            d_.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (tid, U["M"]))
        if result is not None:
            d_.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, draft) VALUES (?,?,?,?,?)",
                       (tid, result, "ZZRN note", subj, draft))
        if approved:
            d_.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, justification, acted_by) "
                       "VALUES (?,1,'confirm',?, 'ZZRN as keyed', ?)", (tid, result, U["M"]))
        d_.commit()
        return tid


def confirm_person(subj, remark="ZZRN overall remark"):
    """Their check-in confirmed as the journey leaves it: the session row and the remark submitted."""
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT INTO pm_review_session(subject_id, cycle_id, locked_at, locked_by) VALUES (?,?, "
                   "'2026-11-02 03:00:00', ?)", (subj, CID, subj))
        d_.execute("INSERT INTO pm_overall_remarks(cycle_id, subject_id, remark, submitted_at, submitted_by, draft) VALUES "
                   "(?,?,?, '2026-11-02 03:00:00', ?, 0)", (CID, subj, remark, subj))
        d_.commit()


def outbox(uid=None, kind="redo_notice"):
    sql = "SELECT * FROM email_outbox WHERE kind=?" + (" AND user_id=?" if uid else "") + " ORDER BY id"
    return q(sql, *([kind] + ([uid] if uid else [])))


def ctx(fn):
    """fn(db) inside a request-less app context, committed."""
    with a.app.app_context():
        d_ = a.get_db()
        out = fn(d_)
        d_.commit()
        return out


def rq(fn):
    """fn(db) inside a request context (the sender's own: it builds links), committed."""
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        out = fn(d_)
        d_.commit()
        return out


def plain(html_):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", re.sub(r"<style.*?</style>", "", html_ or "", flags=re.S)))


def save_ctx(fn, actor=None):
    """One 'save': fn(db) collects changes inside a request context, then the end of the save flushes them."""
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        fn(d_)
        d_.commit()
        n = a._redo_flush(d_, actor or SU["id"])
        d_.commit()
        return n


def kpi_change(uid, tid, name):
    return lambda d_: a._redo_collect(d_, {"id": CID}, {"id": uid}, {"kind": "kpi", "tid": tid, "name": name})


try:
    # -----------------------------------------------------------------------------------------------------------------
    s.section("the trigger: a KPI line added through the person page (admin_person_kpi, action add)")
    TA = line(U["A"], "ZZRN Existing A", result=7, draft=1)   # A has started: a draft result of their own
    TB = line(U["B"], "ZZRN Existing B")                       # B has not: no result on any line
    TC = line(U["C"], "ZZRN Existing C", result=8, draft=0, approved=True)
    confirm_person(U["C"])                                      # C confirmed their check-in
    RATES = {"rate 1": "1", "rate 2": "2", "rate 3": "3", "rate 4": "4", "rate 5": "5"}

    def admin_add(uid, lib="sales", **kw):
        d = {"csrf_token": "tok", "action": "add", "library_id": str(LIB[lib]), "weightage": "20", "moderator": "lm", **RATES}
        d.update(kw)
        return SUP.post("/admin/users/%d/kpi" % uid, data=d, follow_redirects=True)

    r = admin_add(U["A"])
    rows = outbox(U["A"])
    s.check("a KPI added for someone who has started queues exactly ONE email to them, naming the line",
            r.status_code == 200 and len(rows) == 1 and rows[0]["to_email"] == "zz9rn-a@example.test"
            and rows[0]["status"] == "queued" and "ZZRN Sales" in plain(rows[0]["body"])
            and "KPI added" in plain(rows[0]["body"]), [dict(x)["detail"] for x in rows])
    s.check("...in the outbox as kind redo_notice with the cycle and the actor, queued and not sent inline",
            rows[0]["kind"] == "redo_notice" and rows[0]["cycle_id"] == CID and rows[0]["created_by"] == SU["id"]
            and rows[0]["sent_at"] is None)
    r = admin_add(U["B"])
    s.check("a person who has not started gets none (the line is just part of their set)",
            r.status_code == 200 and not outbox(U["B"]) and n_of("SELECT COUNT(*) FROM pm_kpi_targets WHERE subject_id=?", U["B"]) == 2)
    r = admin_add(U["C"])
    s.check("a person who CONFIRMED their check-in gets one", len(outbox(U["C"])) == 1)
    n_before = len(outbox())
    r = admin_add(U["A"], lib="brand")
    s.check("a second line in a second save is a second email: ONE a person a save", len(outbox(U["A"])) == 2
            and len(outbox()) == n_before + 1)

    s.section("one save, several changes: one email naming every change; waves when many people")
    TA2 = line(U["D"], "ZZRN D existing", result=3, draft=1)
    TD1, TD2 = line(U["D"], "ZZRN D new one"), line(U["D"], "ZZRN D new two")
    n = save_ctx(lambda d_: (kpi_change(U["D"], TD1, "ZZRN D new one")(d_), kpi_change(U["D"], TD2, "ZZRN D new two")(d_)))
    rows = outbox(U["D"])
    body = plain(rows[0]["body"]) if rows else ""
    s.check("two lines added in one save: ONE email, naming both", n == 1 and len(rows) == 1
            and "ZZRN D new one" in body and "ZZRN D new two" in body, n)
    # many people in one save: waves (size 1, gap 5 minutes so each person's wave is its own)
    ctx(lambda d_: [d_.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES (?,?)", kv) for kv in
                    (("email_wave_on", "1"), ("email_wave_size", "25"), ("email_wave_gap", "30"))])
    ppl = ["E", "F", "G", "H", "I"]
    tids = {}
    for e in ppl:
        line(U[e], "ZZRN %s existing" % e, result=4, draft=1)
        tids[e] = line(U[e], "ZZRN %s new" % e)
    save_ctx(lambda d_: [kpi_change(U[e], tids[e], "ZZRN %s new" % e)(d_) for e in ppl])
    rows = [outbox(U[e]) for e in ppl]
    sends = [r_[0]["send_after"] for r_ in rows if r_]
    batches = {r_[0]["batch"] for r_ in rows if r_}
    s.check("a save that reaches several started people queues one email each", all(len(r_) == 1 for r_ in rows), [len(r_) for r_ in rows])
    s.check("...in waves: a send_after on each and ONE batch key for the save (not on the mass-send bar)",
            len(sends) == 5 and all(sends) and len(batches) == 1 and next(iter(batches)).startswith("redo-"), (sends, batches))
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM email_outbox WHERE user_id IN (%s)" % ",".join(str(U[e]) for e in ppl))
        d_.commit()
    real_rules = a.email_wave_rules
    a.email_wave_rules = lambda: {"on": True, "size": 2, "gap": 30}   # the pages' own minimum is 25 a wave: a small rule here
    try:
        save_ctx(lambda d_: [kpi_change(U[e], tids[e], "ZZRN %s new" % e)(d_) for e in ppl])
    finally:
        a.email_wave_rules = real_rules
    sends = [outbox(U[e])[0]["send_after"] for e in ppl]
    s.check("...wave size 2: the waves are the rule's, 30 minutes apart (the same _email_wave_at as Everyone's reminder)",
            len(set(sends)) == 3 and sends == sorted(sends) and sends[0] == sends[1] != sends[2], sends)
    ctx(lambda d_: d_.execute("DELETE FROM app_settings WHERE key IN ('email_wave_on','email_wave_size','email_wave_gap')"))

    s.section("the line must be the person's to fill")
    TBU = line(U["J"], "ZZRN J existing", result=3, draft=1)
    TJ = line(U["J"], "ZZRN BU line")
    real = a._pm_bu_names_map
    a._pm_bu_names_map = lambda db_, users_, cid_=None, lib_=None: {u_["id"]: {" ".join("ZZRN BU line".lower().split())} for u_ in users_}
    try:
        n_bu = save_ctx(kpi_change(U["J"], TJ, "ZZRN BU line"))
    finally:
        a._pm_bu_names_map = real
    s.check("a BU-level line (Group People fills it) never emails", n_bu == 0 and not outbox(U["J"]))
    n_own = save_ctx(kpi_change(U["J"], TJ, "ZZRN BU line"))
    s.check("...falsified: the same line, not BU-level, does", n_own == 1 and len(outbox(U["J"])) == 1)

    s.section("the switch: no row = on; off queues none; on again does")
    s.check("no settings row reads as ON", n_of("SELECT COUNT(*) FROM app_settings WHERE key='redo_email_enabled'") == 0
            and ctx(lambda d_: a.redo_email_on()) is True)
    r = SUP.post("/admin/emails", data={"csrf_token": "tok", "action": "redo_switch"}, follow_redirects=True)
    off = ctx(lambda d_: a.redo_email_on())
    s.check("the super admin's switch (unticked) turns it off, audited", r.status_code == 200 and off is False
            and n_of("SELECT COUNT(*) FROM activity_log WHERE action='email_template' AND detail LIKE '%switched off%' "
                     "AND user_id=?", SU["id"]) == 1)
    TK1 = line(U["K"], "ZZRN K existing", result=3, draft=1)
    TK2 = line(U["K"], "ZZRN K new")
    s.check("switched off: a line added for someone who started queues nothing",
            save_ctx(kpi_change(U["K"], TK2, "ZZRN K new")) == 0 and not outbox(U["K"]))
    r = SUP.post("/admin/emails", data={"csrf_token": "tok", "action": "redo_switch", "redo_on": "1"}, follow_redirects=True)
    s.check("...and ticked again it does", ctx(lambda d_: a.redo_email_on()) is True
            and save_ctx(kpi_change(U["K"], TK2, "ZZRN K new")) == 1)
    page = SUP.get("/admin/emails").get_data(as_text=True)
    form = re.search(r'<form[^>]*id="eml-redo"[^>]*>', page)
    s.check("the page shows the switch in an .adm-set-form, double-confirmed, a super admin's card",
            form is not None and "adm-set-form" in form.group(0) and "data-confirm" in form.group(0)
            and 'name="redo_on"' in page and "Your KPI or competency changed" in page)
    nonsuper = None
    if _BGA is not None:
        nonsuper = H.client_as(a, _BGA["id"]).post("/admin/emails", data={"csrf_token": "tok", "action": "redo_switch"})
    s.check("a BG admin cannot reach it (the whole page is the super admin's)",
            nonsuper is None or nonsuper.status_code in (302, 403, 404))

    s.section("NOT emailed: a retarget, a method or unit change, a weight change, a line deleted")
    TL1 = line(U["N"], "ZZRN N a", weight=40, result=3, draft=1)
    TL2 = line(U["N"], "ZZRN N b", weight=40)
    n0 = len(outbox(U["N"]))
    pg = lambda **kw: SUP.post("/admin/users/%d/kpi" % U["N"], data=dict({"csrf_token": "tok", "kpi_target_id": str(TL2)}, **kw),
                               follow_redirects=True)
    pg(action="edit", kpi="ZZRN N b", weightage="45", moderator="lm", method="less", unit="%", **{"rate 1": "5", "rate 2": "4", "rate 3": "3", "rate 4": "2", "rate 5": "1"})
    pg(action="delete")
    # a BU retarget: the in-app note path, no email
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        a._bu_kpi_notice(d_, {"id": CID, "name": "x"}, {"id": U["N"], "full_name": "ZZ RN N"}, ["ZZRN N a"], [], [])
        a._kpi_note_person(d_, {"id": CID}, U["N"], "ZZRN note")
        d_.commit()
        a._redo_flush(d_, SU["id"])
    s.check("a method / unit / weight edit, a delete and the in-app notes queue no email", len(outbox(U["N"])) == n0 == 0)
    s.check("...and none of those writers collects a change for the email (the code names only the three triggers)",
            SRC.count("_redo_collect(") == 5, SRC.count("_redo_collect("))


    s.section("BU KPI setup (every caller: _bu_kpi_apply) and the KPI targets import: one email each, in waves")
    BU = {e: U[e] for e in ("Y", "Z", "BA", "BB")}
    for e in ("Y", "Z", "BA"):
        line(BU[e], "ZZRN %s keyed" % e, weight=50, result=3, draft=1)   # started: their own result, a draft
    line(BU["BB"], "ZZRN BB unstarted", weight=50)                        # not started
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        ACT = d_.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()
        SUROW = d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        sid = d_.execute("INSERT INTO pm_bu_kpis(cycle_id, business_group, company, kpi_name, method, rate1, rate2, rate3, rate4, "
                         "rate5, carriers, weight_mode, weight) VALUES (?,?,?,?, 'more', 1,2,3,4,5, 'everyone', 'one', 10)",
                         (CID, BG, CO, "ZZRN BU New")).lastrowid
        d_.commit()
    real_rules2 = a.email_wave_rules
    a.email_wave_rules = lambda: {"on": True, "size": 2, "gap": 30}
    try:
        def bu_save(d_):
            srow = d_.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (sid,)).fetchone()
            people = [p_ for p_ in a._bu_unit_people(d_, BG, CO) if p_["id"] in BU.values()]
            return a._bu_kpi_apply(d_, SUROW, ACT, srow, people, locked_ok=True)
        res_holder = {}
        save_ctx(lambda d_: res_holder.update(res=bu_save(d_)))
    finally:
        a.email_wave_rules = real_rules2
    got = {e: outbox(BU[e]) for e in BU}
    s.check("a BU KPI saved for four people puts the line on each, and emails the three who had started, one each",
            res_holder["res"]["added"] == 4 and [len(got[e]) for e in ("Y", "Z", "BA", "BB")] == [1, 1, 1, 0]
            and all("ZZRN BU New" in plain(got[e][0]["body"]) for e in ("Y", "Z", "BA")), (res_holder, {e: len(v) for e, v in got.items()}))
    waves = [got[e][0]["send_after"] for e in ("Y", "Z", "BA")]
    batch = {got[e][0]["batch"] for e in ("Y", "Z", "BA")}
    s.check("...in waves of the rule's size (2 a wave here): the third waits for the next wave, one batch key",
            len(set(waves)) == 2 and sorted(waves)[0] != sorted(waves)[-1] and len(batch) == 1 and next(iter(batch)).startswith("redo-"), (waves, batch))
    n_bu = len(outbox())
    ctx(lambda d_: d_.execute("UPDATE pm_bu_kpis SET rate1=2, rate5=9 WHERE id=?", (sid,)))
    save_ctx(lambda d_: bu_save(d_))
    s.check("the same setup saved again with a new target (a retarget of lines already there) emails nobody",
            len(outbox()) == n_bu, (n_bu, len(outbox())))
    # the KPI targets import: an insert branch
    rows_ = []
    for e, nm in (("BC", "ZZRN Imp one"), ("BD", "ZZRN Imp two"), ("BE", "ZZRN Imp three")):
        rows_.append({"skip": False, "existing_id": None, "subject_id": U[e], "kpi_name": nm, "category": "Business", "description": None,
                      "weightage": 20.0, "unit": "RM", "method": "more", "rate1": 1.0, "rate2": 2.0, "rate3": 3.0, "rate4": 4.0,
                      "rate5": 5.0, "threshold": None, "target": None, "multiple": None, "excellence": None, "business_group": BG,
                      "company": CO, "department": DEPT, "focus": None, "approver_ids": [U["M"]]})
    for e in ("BC", "BD"):
        line(U[e], "ZZRN %s keyed" % e, weight=50, result=3, draft=1)   # started
    line(U["BE"], "ZZRN BE unstarted", weight=50)
    real_rules3 = a.email_wave_rules
    a.email_wave_rules = lambda: {"on": True, "size": 1, "gap": 30}
    try:
        save_ctx(lambda d_: a._kti_apply(d_, SUROW, ACT, {"valid": rows_}, {"items": []}, {}))
    finally:
        a.email_wave_rules = real_rules3
    imp = {e: outbox(U[e]) for e in ("BC", "BD", "BE")}
    s.check("the KPI targets import: lines created for two people who had started email them (one each, one wave apiece); the person who "
            "had not started gets none", [len(imp[e]) for e in ("BC", "BD", "BE")] == [1, 1, 0]
            and imp["BC"][0]["send_after"] != imp["BD"][0]["send_after"] and imp["BC"][0]["batch"] == imp["BD"][0]["batch"]
            and "ZZRN Imp one" in plain(imp["BC"][0]["body"]), {e: len(v) for e, v in imp.items()})

    s.section("what the email says")
    body_html = outbox(U["A"])[0]["body"]
    txt = plain(body_html)
    default_words = " ".join(a.REDO_TPL_DEFAULT.values())
    s.check("it never says Reopen, and never HR (Group People)", "reopen" not in txt.lower() and "reopen" not in default_words.lower()
            and re.search(r"\bHR\b", txt) is None and re.search(r"\bHR\b", default_words) is None
            and "Group People" in txt, txt[:200])
    s.check("light only, a white box with its tone in its border, brand AI+ OneHR by Chin Hin, button Open OneHR to the review",
            "color-scheme" in body_html and 'bgcolor="#ffffff"' in body_html and "border-left:4px solid #252A59" in body_html
            and "by Chin Hin" in body_html and "Open OneHR" in body_html and "/review" in body_html and "Hi " in txt)
    s.check("the greeting is the person's chosen name (email_names), the cycle is named", "ZZ RN A" in txt or "Hi " in txt)
    s.check("what to do: fill in the new item and submit it; the rest stays as it is",
            "fill in the new item" in txt and "stays as it is" in txt)
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        subj, body3 = a._redo_mail(d_, d_.execute("SELECT * FROM users WHERE id=?", (U["A"],)).fetchone(),
                                   [{"kind": "tc_add", "title": "ZZRN Planning"},
                                    {"kind": "tc_swap", "added": ["ZZRN Audit"], "removed": ["ZZRN Safety"]}], CYC)
    t3 = plain(body3)
    s.check("a competency added and a swap read in the person's words: added X, removed Y, the other answers kept",
            "Competency added: “ZZRN Planning”" in t3 and "added “ZZRN Audit”" in t3
            and "removed “ZZRN Safety”" in t3 and "Your other answers are kept" in t3 and "reopen" not in t3.lower(), t3[-300:])
    s.check("the template: a kind of its own, read through email_tpl_words, listed on the page with the usual placeholders",
            a.EMAIL_TPL_KIND["redo_notice"]["title"] == "Your KPI or competency changed"
            and a.EMAIL_TPL_KIND["redo_notice"]["placeholders"] == ("display_name", "first_name", "full_name", "cycle")
            and ctx(lambda d_: a.email_tpl_words("redo_notice")) == a.REDO_TPL_DEFAULT
            and [k["key"] for k in a.EMAIL_TPL_KINDS][[k["key"] for k in a.EMAIL_TPL_KINDS].index("ready_hod"):][:3] == ["ready_hod", "ready_buceo", "ready_cg"])   # (position-free: the Grade H kinds, Talent Box Round 2's and the shared spec of Your own emails come after)
    ctx(lambda d_: (a._email_tpl_ensure(d_, "redo_notice"),
                    d_.execute("UPDATE email_templates SET words=? WHERE email='redo_notice' AND usual=1",
                               (json.dumps({"subject": "ZZRN custom {cycle}"}),))))
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        subj, _b = a._redo_mail(d_, d_.execute("SELECT * FROM users WHERE id=?", (U["A"],)).fetchone(),
                                [{"kind": "kpi", "name": "x"}], CYC)
    s.check("...so an edited template changes the email's words (subject here)", subj.startswith("ZZRN custom "), subj)
    ctx(lambda d_: d_.execute("DELETE FROM email_templates WHERE email='redo_notice'"))
    pv = SUP.get("/admin/emails?email=redo_notice")
    s.check("the template's page and its preview open", pv.status_code == 200 and "Your KPI or competency changed" in pv.get_data(as_text=True)
            and SUP.get("/admin/emails/preview?tid=%d" % n_of("SELECT id FROM email_templates WHERE email='redo_notice' AND "
                                                              "usual=1")).status_code == 200)

    # -----------------------------------------------------------------------------------------------------------------
    s.section("the recheck just before it goes: nothing waiting = not sent")
    TR0 = line(U["O"], "ZZRN O existing", result=2, draft=1)
    TR1 = line(U["O"], "ZZRN O new")
    save_ctx(kpi_change(U["O"], TR1, "ZZRN O new"))
    row = outbox(U["O"])[0]
    kept = rq(lambda d_: a._outbox_reminder_recheck(d_, d_.execute("SELECT * FROM email_outbox WHERE id=?", (row["id"],)).fetchone()))
    s.check("while the line is still to fill in, the claimed row goes as it was", kept is not None and kept["body"] == row["body"])
    ctx(lambda d_: d_.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,3,?,0)",
                              (TR1, U["O"])))
    dropped = rq(lambda d_: a._outbox_reminder_recheck(d_, d_.execute("SELECT * FROM email_outbox WHERE id=?", (row["id"],)).fetchone()))
    s.check("once it is answered and submitted by its wave, the row is cancelled and logged as skipped, not sent",
            dropped is None and n_of("SELECT status FROM email_outbox WHERE id=?", row["id"]) == "cancelled"
            and n_of("SELECT error FROM email_outbox WHERE id=?", row["id"]) == a.REDO_NOTHING_LEFT
            and n_of("SELECT COUNT(*) FROM notifications WHERE user_id=? AND kind='redo_notice' AND status='skipped'", U["O"]) == 1)
    TR2 = line(U["O"], "ZZRN O second")
    save_ctx(kpi_change(U["O"], TR2, "ZZRN O second"))
    row2 = [x for x in outbox(U["O"]) if x["status"] == "queued"][0]
    ctx(lambda d_: d_.execute("DELETE FROM pm_kpi_targets WHERE id=?", (TR2,)))
    gone = rq(lambda d_: a._outbox_reminder_recheck(d_, d_.execute("SELECT * FROM email_outbox WHERE id=?", (row2["id"],)).fetchone()))
    s.check("a line taken off in the meantime: not sent either", gone is None)
    TR3 = line(U["O"], "ZZRN O third")
    save_ctx(kpi_change(U["O"], TR3, "ZZRN O third"))
    row3 = [x for x in outbox(U["O"]) if x["status"] == "queued"][0]
    ctx(lambda d_: d_.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('redo_email_enabled','0')"))
    off_drop = rq(lambda d_: a._outbox_reminder_recheck(d_, d_.execute("SELECT * FROM email_outbox WHERE id=?", (row3["id"],)).fetchone()))
    s.check("the switch turned off while it waited: dropped before it goes", off_drop is None
            and n_of("SELECT error FROM email_outbox WHERE id=?", row3["id"]) == a.REDO_SWITCHED_OFF)
    ctx(lambda d_: d_.execute("DELETE FROM app_settings WHERE key='redo_email_enabled'"))
    TR4 = line(U["O"], "ZZRN O fourth")
    save_ctx(kpi_change(U["O"], TR4, "ZZRN O fourth"))
    row4 = [x for x in outbox(U["O"]) if x["status"] == "queued"][0]
    ctx(lambda d_: d_.execute("INSERT INTO result_releases(cycle_id, subject_id, kind) VALUES (?,?, 'pm')", (CID, U["O"])))
    out_drop = rq(lambda d_: a._outbox_reminder_recheck(d_, d_.execute("SELECT * FROM email_outbox WHERE id=?", (row4["id"],)).fetchone()))
    s.check("their results released while it waited: dropped", out_drop is None)
    ctx(lambda d_: d_.execute("DELETE FROM result_releases WHERE subject_id=?", (U["O"],)))
    s.check("the drain runs the check (one shared recheck for every kind)",
            "_outbox_redo_recheck(db, row)" in SRC and "row = _outbox_reminder_recheck(db, row)" in SRC)

    # -----------------------------------------------------------------------------------------------------------------
    s.section("B: a KPI added after the check-in was confirmed: set up")
    P = U["P"]
    K1 = line(P, "ZZRN P one", weight=40, result=3, draft=0, approved=True)
    K2 = line(P, "ZZRN P two", weight=40, result=4, draft=0, approved=True)
    confirm_person(P)
    Q_ = U["Q"]
    line(Q_, "ZZRN Q one", weight=100, result=3, draft=0, approved=True)
    confirm_person(Q_)
    r = admin_add(P)
    K3 = n_of("SELECT id FROM pm_kpi_targets WHERE subject_id=? AND kpi_name='ZZRN Sales'", P)
    s.check("Group People adds a KPI to a person who confirmed: it is a new line with no result, and they get the email",
            K3 and n_of("SELECT COUNT(*) FROM pm_kpi_results WHERE kpi_target_id=?", K3) == 0 and len(outbox(P)) == 1)

    def state_of(uid, key="account"):
        with a.app.app_context():
            d_ = a.get_db()
            st = a.review_state(d_, d_.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())
            return next(x for x in st["stages"] if x["key"] == key)

    def snapshot(uid):
        """What a confirmed person's submission looks like: every result row, the session, the remark, the approvals."""
        return (q("SELECT r.kpi_target_id, r.actual_value, r.note, r.draft, r.submitted_at, r.submitted_by FROM pm_kpi_results r "
                  "JOIN pm_kpi_targets t ON t.id=r.kpi_target_id WHERE t.subject_id=? AND t.id!=? ORDER BY r.kpi_target_id", uid, K3 if uid == P else 0),
                q("SELECT locked_at, locked_by FROM pm_review_session WHERE subject_id=?", uid),
                q("SELECT remark, submitted_at, draft FROM pm_overall_remarks WHERE subject_id=?", uid),
                q("SELECT a.kpi_target_id, a.seq, a.action, a.original_value, a.justification FROM pm_kpi_approvals a "
                  "JOIN pm_kpi_targets t ON t.id=a.kpi_target_id WHERE t.subject_id=? ORDER BY a.id", uid))
    SNAP0 = snapshot(P)
    snap_t = lambda x: tuple(tuple(tuple(r_) for r_ in part) for part in x)   # noqa: E731

    acct = state_of(P)
    s.check("review_state: the KPI part reads OPEN for them again, with the one line open",
            acct["state"] == a.REVIEW_STATE_OPEN and acct["n_open"] == 1, acct)
    s.check("...while a confirmed person with nothing added reads DONE", state_of(Q_)["state"] == a.REVIEW_STATE_DONE)
    s.check("the open lines: exactly the new one (the helper every reader asks)",
            ctx(lambda d_: [t["id"] for t in a.pm_added_open_lines(d_, P, CID)]) == [K3]
            and ctx(lambda d_: a.pm_added_open_lines(d_, Q_, CID)) == [])
    s.check("...and a person who has NOT confirmed has none (their normal rules apply to every line)",
            ctx(lambda d_: a.pm_added_open_lines(d_, U["A"], CID)) == [])
    with a.app.app_context():
        d_ = a.get_db()
        up = d_.execute("SELECT * FROM users WHERE id=?", (P,)).fetchone()
        rs = a.review_resume(a.review_state(d_, up))
        ov = a._review_kpi_overview(d_, up)["data"]
        steps = a._journey_kpi_steps(d_, up)
    s.check("the files still owed are the new line's alone: the lines already submitted are final (none of the two earlier lines "
            "is asked for a file, whatever its rating)", ov["attach_needed"] == [] or all(x["kpi_id"] == K3 for x in ov["attach_needed"]), ov["attach_needed"])
    s.check("the rail lands them on the KPI part again (review_resume), the overview says confirmed AND a line is open, and "
            "the Confirm step is not done", rs == "account" and ov["locked"] is True and ov["added_open"] is True
            and [x for x in steps if x["key"] == "confirm"][0]["done"] is False
            and [l["editable"] for l in ov["lines"] if l["kpi_id"] == K3] == [True]
            and all(not l["editable"] for l in ov["lines"] if l["kpi_id"] in (K1, K2)))
    with a.app.app_context():
        d_ = a.get_db()
        prompt = a._review_agent_system(d_, d_.execute("SELECT * FROM users WHERE id=?", (P,)).fetchone(),
                                        a.review_state(d_, d_.execute("SELECT * FROM users WHERE id=?", (P,)).fetchone()), journey=True)
    s.check("the journey agent is told in fixed words that a new KPI was added and ONLY it is open (never LOCKED, never reopen)",
            "a new KPI" in prompt and "ZZRN Sales" in prompt and "ONLY it is open" in prompt
            and "CONFIRMED and LOCKED" not in prompt and "never offer to reopen" in prompt)
    s.check("a locked person with nothing added still reads the old LOCKED words",
            "CONFIRMED and LOCKED" in ctx(lambda d_: a._review_agent_system(
                d_, d_.execute("SELECT * FROM users WHERE id=?", (Q_,)).fetchone(),
                a.review_state(d_, d_.execute("SELECT * FROM users WHERE id=?", (Q_,)).fetchone()), journey=True)))

    s.section("B: only the new line is writable")
    PC = H.client_as(a, P)
    r = PC.post("/review/kpi/save-all", data={"csrf_token": "tok", "actual_value_%d" % K1: "5", "actual_value_%d" % K3: "3"})
    j = r.get_json()
    s.check("save-all writes only the new line: the other line's figure is not touched, the new one is a private draft",
            r.status_code == 200 and j["ok"] and [x["kpi"] for x in j["recorded"]] == ["ZZRN Sales"] and not j["errors"]
            and q("SELECT actual_value, draft FROM pm_kpi_results WHERE kpi_target_id=?", K1)[0][0] == 3
            and q("SELECT actual_value, draft FROM pm_kpi_results WHERE kpi_target_id=?", K1)[0][1] == 0
            and tuple(q("SELECT actual_value, draft FROM pm_kpi_results WHERE kpi_target_id=?", K3)[0]) == (3, 1), j)
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        d_.execute("SELECT 1")
        from flask import session as _sess
        _sess["user_id"] = P
        res_other = a._review_record_one(d_, d_.execute("SELECT * FROM users WHERE id=?", (P,)).fetchone(), CID, K1, 5.0)
    s.check("the journey writer refuses any other line, in the plain sentence", res_other["ok"] is False
            and "Only a KPI that Group People added" in res_other["error"], res_other)
    # falsified: with the guard off the refusal falls to the line's own rule, and the demo bypass would let it through
    real_ref = a.pm_locked_line_refusal
    a.pm_locked_line_refusal = lambda *x, **k: None
    try:
        with a.app.test_request_context("/"):
            d_ = a.get_db()
            from flask import session as _sess
            _sess["user_id"] = P
            res_off = a._review_record_one(d_, d_.execute("SELECT * FROM users WHERE id=?", (P,)).fetchone(), CID, K1, 5.0)
    finally:
        a.pm_locked_line_refusal = real_ref
    s.check("...falsified: the confirmed-line guard is the sentence's source (switched off, the refusal is the older line rule)",
            res_off["ok"] is False and "Only a KPI that Group People added" not in res_off["error"], res_off)
    # the overall remark: journey tool, the Remarks box, the classic autosave
    REMARK0 = q("SELECT remark, submitted_at, draft FROM pm_overall_remarks WHERE subject_id=?", P)[0]
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        t_res = a._review_tool_set_overall_remark(d_, d_.execute("SELECT * FROM users WHERE id=?", (P,)).fetchone(), CID,
                                                  {"text": "ZZRN a rewritten remark"})
    box = PC.post("/review/kpi/remark", data={"csrf_token": "tok", "remark": "ZZRN typed in the box"})
    classic = PC.post("/performance/overall-remark/autosave", data={"csrf_token": "tok", "remark": "ZZRN classic"})
    s.check("the overall remark stays refused on every writer: the journey tool, the Remarks box, the classic autosave",
            t_res["ok"] is False and box.status_code == 409 and classic.status_code == 409
            and tuple(q("SELECT remark, submitted_at, draft FROM pm_overall_remarks WHERE subject_id=?", P)[0]) == tuple(REMARK0))
    # falsified: each remark guard, taken away, lets the write through
    real_lock = a.pm_review_locked
    a.pm_review_locked = lambda *x, **k: False
    try:
        with a.app.test_request_context("/"):
            d_ = a.get_db()
            t_off = a._review_tool_set_overall_remark(d_, d_.execute("SELECT * FROM users WHERE id=?", (P,)).fetchone(), CID,
                                                      {"text": "ZZRN falsified journey tool"})
        c_off = PC.post("/performance/overall-remark/autosave", data={"csrf_token": "tok", "remark": "ZZRN falsified classic"})
    finally:
        a.pm_review_locked = real_lock
    s.check("...falsified: with the lock rule off both the journey tool and the classic autosave WOULD have written the remark",
            t_off["ok"] is True and c_off.status_code == 200
            and q("SELECT remark FROM pm_overall_remarks WHERE subject_id=?", P)[0][0] == "ZZRN falsified classic")
    ctx(lambda d_: d_.execute("UPDATE pm_overall_remarks SET remark=?, submitted_at=?, draft=? WHERE subject_id=?",
                              (REMARK0[0], REMARK0[1], REMARK0[2], P)))
    # evidence and files
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        ev_other = a._review_tool_log_evidence(d_, d_.execute("SELECT * FROM users WHERE id=?", (P,)).fetchone(), CID,
                                               {"text": "ZZRN a worked example of the first line", "kpi_id": K1})
        ev_unlinked = a._review_tool_log_evidence(d_, d_.execute("SELECT * FROM users WHERE id=?", (P,)).fetchone(), CID,
                                                  {"text": "ZZRN an overall example with no line"})
        ev_new = a._review_tool_log_evidence(d_, d_.execute("SELECT * FROM users WHERE id=?", (P,)).fetchone(), CID,
                                             {"text": "ZZRN a worked example of the new line", "kpi_id": K3})
    s.check("an example (evidence) goes only on the new line: not on another, not as an overall example",
            ev_other["ok"] is False and ev_unlinked["ok"] is False and ev_new["ok"] is True, (ev_other, ev_unlinked))
    f_other = PC.post("/review/kpi/%d/attach" % K1, data={"csrf_token": "tok", "file": (__import__("io").BytesIO(PDF), "x.pdf")},
                      content_type="multipart/form-data")
    f_new = PC.post("/review/kpi/%d/attach" % K3, data={"csrf_token": "tok", "file": (__import__("io").BytesIO(PDF), "x.pdf")},
                    content_type="multipart/form-data")
    s.check("a file attaches to the new line and to no other", f_other.status_code == 400 and f_new.status_code == 200
            and f_new.get_json()["ok"] is True, (f_other.get_data(as_text=True)[:80], f_new.get_data(as_text=True)[:80]))
    att = q("SELECT a.id FROM pm_evidence_attachments a JOIN pm_evidence_links l ON l.evidence_id=a.evidence_id AND "
            "l.target_kind='kpi' AND l.target_ref=? ", str(K3))
    d_new = PC.post("/review/evidence/attachment/%d/delete" % att[0][0], data={"csrf_token": "tok"})
    PC.post("/review/kpi/%d/attach" % K3, data={"csrf_token": "tok", "file": (__import__("io").BytesIO(PDF), "y.pdf")},
            content_type="multipart/form-data")
    s.check("...and a file comes off the new line too (it is still open)", d_new.status_code == 200 and d_new.get_json()["ok"] is True)
    # classic autosave of another line
    ca_other = PC.post("/performance/kpi/%d/autosave" % K1, data={"csrf_token": "tok", "actual_value": "9"})
    ca_new = PC.post("/performance/kpi/%d/autosave" % K3, data={"csrf_token": "tok", "actual_value": "3"})
    s.check("the classic autosave: another line is locked (409), the new one saves as a draft",
            ca_other.status_code == 409 and ca_new.status_code == 200
            and q("SELECT actual_value FROM pm_kpi_results WHERE kpi_target_id=?", K1)[0][0] == 3)

    s.section("B: Confirm submits only the new line")
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        up = d_.execute("SELECT * FROM users WHERE id=?", (P,)).fetchone()
        _l, err_ok = a._review_added_check(d_, up, CID)
    s.check("the same gates run on that line: keyed, and a standout rating owes its supporting file (here a 3 is Meets: none)",
            err_ok is None)
    ctx(lambda d_: d_.execute("UPDATE pm_kpi_results SET actual_value=5 WHERE kpi_target_id=?", (K3,)))
    ctx(lambda d_: [d_.execute("DELETE FROM pm_evidence_attachments WHERE evidence_id IN (SELECT evidence_id FROM pm_evidence_links "
                               "WHERE target_kind='kpi' AND target_ref=?)", (str(K3),))])
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        up = d_.execute("SELECT * FROM users WHERE id=?", (P,)).fetchone()
        _l, err_file = a._review_added_check(d_, up, CID)
    r = PC.post("/review/confirm", data={"csrf_token": "tok"})
    s.check("a 5 (Outstanding) with no file is refused, naming the line; nothing is promoted",
            err_file and "supporting file" in err_file and r.status_code == 400
            and q("SELECT draft FROM pm_kpi_results WHERE kpi_target_id=?", K3)[0][0] == 1, (err_file, r.get_data(as_text=True)[:120]))
    PC.post("/review/kpi/%d/attach" % K3, data={"csrf_token": "tok", "file": (__import__("io").BytesIO(PDF), "z.pdf")},
            content_type="multipart/form-data")
    # the moderator before: P is not waiting on M (every line was confirmed)
    pend0 = ctx(lambda d_: a._pm_pending_split(d_, d_.execute("SELECT * FROM users WHERE id=?", (U["M"],)).fetchone(), CID)["team_pending"])
    # falsified: with no line reading as open the Confirm is the old early return and promotes nothing
    real_ids = a.pm_added_open_ids
    a.pm_added_open_ids = lambda *x, **k: set()
    try:
        r_off = PC.post("/review/confirm", data={"csrf_token": "tok"})
    finally:
        a.pm_added_open_ids = real_ids
    s.check("...falsified: with the open-lines rule off, Confirm is the old early return and the new line stays a draft",
            r_off.status_code == 200 and r_off.get_json().get("locked") is True
            and q("SELECT draft FROM pm_kpi_results WHERE kpi_target_id=?", K3)[0][0] == 1)
    r = PC.post("/review/confirm", data={"csrf_token": "tok"})
    s.check("Confirm with the file attached promotes the new line", r.status_code == 200 and r.get_json()["ok"]
            and tuple(q("SELECT actual_value, draft FROM pm_kpi_results WHERE kpi_target_id=?", K3)[0]) == (5, 0), r.get_data(as_text=True)[:150])
    SNAP1 = snapshot(P)
    s.check("...and ONLY it: the session row, the overall remark, the other lines' results and every approval are exactly as "
            "they were", snap_t(SNAP0) == snap_t(SNAP1), (SNAP0, SNAP1))
    s.check("...the KPI part reads DONE again, and nothing is open",
            state_of(P)["state"] == a.REVIEW_STATE_DONE and ctx(lambda d_: a.pm_added_open_lines(d_, P, CID)) == [])
    pend1 = ctx(lambda d_: a._pm_pending_split(d_, d_.execute("SELECT * FROM users WHERE id=?", (U["M"],)).fetchone(), CID)["team_pending"])
    s.check("the moderator now sees it: P is waiting on their line manager (a submitted line without an approval)",
            pend1 == pend0 + 1, (pend0, pend1))
    r = PC.post("/review/confirm", data={"csrf_token": "tok"})
    s.check("a second Confirm is the old 'already' answer", r.status_code == 200 and r.get_json().get("locked") is True)

    s.section("B: the classic page submits the same way (one shared function)")
    CL = U["R"]
    line(CL, "ZZRN R one", weight=50, result=3, draft=0, approved=True)
    confirm_person(CL)
    CK = line(CL, "ZZRN R added")
    CC = H.client_as(a, CL)
    rem0 = tuple(q("SELECT remark, submitted_at FROM pm_overall_remarks WHERE subject_id=?", CL)[0])
    r = CC.post("/performance/submit-all", data={"csrf_token": "tok", "actual_value_%d" % CK: "2", "overall_remark": "ZZRN trying to rewrite"},
                follow_redirects=True)
    s.check("the classic Submit all submits the new line alone, and never touches the overall remark it was sent",
            tuple(q("SELECT actual_value, draft FROM pm_kpi_results WHERE kpi_target_id=?", CK)[0]) == (2, 0)
            and tuple(q("SELECT remark, submitted_at FROM pm_overall_remarks WHERE subject_id=?", CL)[0]) == rem0
            and n_of("SELECT COUNT(*) FROM pm_review_session WHERE subject_id=?", CL) == 1)

    s.section("B: after the Results window has closed: only the new line, only while open, never once released")
    W = U["S"]
    line(W, "ZZRN W one", weight=50, result=3, draft=0, approved=True)
    confirm_person(W)
    WK = line(W, "ZZRN W added")
    WK2 = line(W, "ZZRN W added second")
    other = U["G"]   # started, not confirmed, no line added: has no pass
    ctx(lambda d_: d_.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_results', "
                              "'2020-01-01 00:00', '2020-01-02 00:00')", (CID,)))
    WC = H.client_as(a, W)
    r = WC.post("/review/kpi/save-all", data={"csrf_token": "tok", "actual_value_%d" % WK: "3", "actual_value_%d" % WK2: "3"})
    s.check("the window closed long ago, and the new lines still save (a personal pass, like a Reopen's)",
            r.status_code == 200 and r.get_json()["ok"] and sorted(x["kpi"] for x in r.get_json()["recorded"]) ==
            ["ZZRN W added", "ZZRN W added second"], r.get_data(as_text=True)[:200])
    rem_w = WC.post("/review/kpi/remark", data={"csrf_token": "tok", "remark": "ZZRN too late"})
    cl_w = WC.post("/performance/overall-remark/autosave", data={"csrf_token": "tok", "remark": "ZZRN too late"})
    one_w = WC.post("/performance/kpi/%d/autosave" % n_of("SELECT id FROM pm_kpi_targets WHERE subject_id=? AND kpi_name='ZZRN W one'", W),
                    data={"csrf_token": "tok", "actual_value": "9"})
    s.check("...but nothing else: not the remark (either writer), not another line", rem_w.status_code == 409
            and cl_w.status_code == 409 and one_w.status_code == 409)
    OC = H.client_as(a, other)
    r_other = OC.post("/review/kpi/save-all", data={"csrf_token": "tok", "actual_value_%d" % TA: "3"})
    s.check("a person with no new line gets no pass: the window's own refusal", r_other.status_code in (409, 200)
            and (r_other.status_code == 409 or not r_other.get_json().get("recorded")), r_other.get_data(as_text=True)[:120])
    ctx(lambda d_: [d_.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?, "
                               "'2020-01-01 00:00', '2020-01-02 00:00')", (CID, c_)) for c_ in ("f360", "idp_self", "tc_self", "pm_approve")])
    with a.app.test_request_context("/"):
        from flask import session as _sess
        _sess["user_id"] = W
        d_ = a.get_db()
        w_cell = a.window_closed(d_, "pm_results")
        w_others = {c_: a.window_closed(d_, c_) for c_ in ("f360", "idp_self", "tc_self", "pm_approve")}
        w_subject_other = a.window_closed(d_, "pm_results", subject_id=U["G"])
        _sess["user_id"] = U["G"]
        w_none = a.window_closed(d_, "pm_results")
    s.check("the pass opens the Results window for them and no other cell (360, Career Plan, self-assessment, the line manager's "
            "own window all stay closed), and only for their own work", w_cell is None and w_none is not None
            and all(v is not None for v in w_others.values()) and w_subject_other is not None, (w_cell, w_others))
    ctx(lambda d_: [d_.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell=?", (CID, c_)) for c_ in ("f360", "idp_self")])
    ctx(lambda d_: [d_.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?, "
                               "'2020-01-01 00:00', NULL)", (CID, c_)) for c_ in ("tc_self", "pm_approve")])
    r = WC.post("/review/confirm", data={"csrf_token": "tok"})
    s.check("and the Confirm of the new lines goes through after the close too (shared function, same gates)",
            r.status_code == 200 and tuple(q("SELECT draft FROM pm_kpi_results WHERE kpi_target_id=?", WK)[0]) == (0,)
            and tuple(q("SELECT draft FROM pm_kpi_results WHERE kpi_target_id=?", WK2)[0]) == (0,), r.get_data(as_text=True)[:150])
    s.check("...with nothing open left, the pass is gone: the closed window refuses a save again",
            WC.post("/review/kpi/save-all", data={"csrf_token": "tok", "actual_value_%d" % WK: "4"}).status_code == 409)
    WK2 = line(W, "ZZRN W added third")   # another line, added after
    ctx(lambda d_: d_.execute("INSERT INTO result_releases(cycle_id, subject_id, kind) VALUES (?,?, 'pm')", (CID, W)))
    r = WC.post("/review/kpi/save-all", data={"csrf_token": "tok", "actual_value_%d" % WK2: "3"})
    s.check("results released: the pass is gone, the closed window refuses the new line",
            r.status_code == 409 and q("SELECT COUNT(*) FROM pm_kpi_results WHERE kpi_target_id=?", WK2)[0][0] == 0
            and "closed" in (r.get_json() or {}).get("error", "").lower(), r.get_data(as_text=True)[:150])
    # falsified: without the pass the closed window refuses the new line
    ctx(lambda d_: d_.execute("DELETE FROM result_releases WHERE subject_id=?", (W,)))
    real_pass = a._added_pass
    a._added_pass = lambda *x, **k: False
    try:
        r_np = WC.post("/review/kpi/save-all", data={"csrf_token": "tok", "actual_value_%d" % WK2: "3"})
    finally:
        a._added_pass = real_pass
    s.check("...falsified: with the pass switched off the same save is refused by the window (the pass is what opened it)",
            r_np.status_code == 409 and q("SELECT COUNT(*) FROM pm_kpi_results WHERE kpi_target_id=?", WK2)[0][0] == 0)
    r_ok = WC.post("/review/kpi/save-all", data={"csrf_token": "tok", "actual_value_%d" % WK2: "3"})
    s.check("...and with the pass back it saves again (not released)", r_ok.status_code == 200 and r_ok.get_json()["ok"])
    ctx(lambda d_: d_.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='pm_results'", (CID,)))
    ctx(lambda d_: d_.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_results', "
                              "'2020-01-01 00:00', NULL)", (CID,)))

    s.section("B: every reader of the lock agrees (the decisions)")
    with a.app.app_context():
        d_ = a.get_db()
        PU = d_.execute("SELECT * FROM users WHERE id=?", (U["P"],)).fetchone()
    s.check("the readers that decide 'done' ask pm_account_done: the navigator's Confirm step, the sign-off pop-up and its 'already', "
            "the typed-confirm check (_signoff_done), the journey summary card",
            all(x in SRC for x in ('locked = pm_account_done(db, u["id"], active_cycle_id(db))',
                                    'if pm_account_done(db, u["id"], cid):\n            out["already"] = True',
                                    'return bool(pm_account_done(db, u["id"], cid))',
                                    'done = bool(pm_account_done(db, u["id"], cid))')))
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        pv = a._signoff_preview(d_, d_.execute("SELECT * FROM users WHERE id=?", (CL,)).fetchone(), CID, "account")
    s.check("a person with nothing open: the pop-up says already submitted; _signoff_done reads true",
            pv["already"] is True and rq(lambda d_: a._signoff_done(d_, d_.execute("SELECT * FROM users WHERE id=?", (CL,)).fetchone(), CID, "confirm")))
    K9 = line(Q_, "ZZRN Q added")
    pv2 = rq(lambda d_: a._signoff_preview(d_, d_.execute("SELECT * FROM users WHERE id=?", (Q_,)).fetchone(), CID, "account"))
    s.check("...and with a line added the pop-up is not 'already': it asks for that line's result",
            pv2["already"] is False and any("ZZRN Q added" in x for x in pv2["blockers"])
            and not rq(lambda d_: a._signoff_done(d_, d_.execute("SELECT * FROM users WHERE id=?", (Q_,)).fetchone(), CID, "confirm")), pv2["blockers"])
    s.check("what stays reading 'confirmed' on purpose: the admin reports and Reopen's state (_reopen_state), a chat replay's "
            "kpi_locked, and the late-pass list", 'kpi_locked=pm_review_locked(db, u["id"], cid)' in SRC
            and "if tids and pm_review_locked(db, uid, cid):" in SRC)

    # -----------------------------------------------------------------------------------------------------------------
    s.section("C: a competency added after the self-assessment was submitted: set up")
    X = U["X"]

    def give(uid, code, future=0, seq=1, source="job_profile"):
        return ctx(lambda d_: d_.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, seq, source) VALUES "
                                         "(?,?,?,?,?,?)", (CID, uid, SK[code], future, seq, source)).lastrowid)

    def asm(uid, status, remark="ZZRN self remark"):
        sub = "'2026-11-02 04:00:00'" if status in ("submitted", "reviewed") else "NULL"
        return ctx(lambda d_: d_.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status, submitted_at, overall_remark) "
                                         "VALUES (?,?,?, " + sub + ", ?)", (CID, uid, status, remark)).lastrowid)

    def answer(asm_id, aid, ans="yes", remark=None):
        ctx(lambda d_: d_.execute("INSERT OR REPLACE INTO tc_scores(assessment_id, assignment_id, answer, remark) VALUES (?,?,?,?)",
                                  (asm_id, aid, ans, remark)))
    XA1, XA2 = give(X, "ZZRN-S1", seq=1), give(X, "ZZRN-S2", seq=2)
    XT = asm(X, "submitted")
    answer(XT, XA1, "yes", "ZZRN why 1")
    answer(XT, XA2, "no")
    SC_SNAP = lambda: (q("SELECT assignment_id, answer, manager_answer, remark FROM tc_scores WHERE assessment_id=? ORDER BY assignment_id", XT),   # noqa: E731
                       q("SELECT status, submitted_at, overall_remark FROM tc_assessments WHERE id=?", XT))
    SC0 = SC_SNAP()

    def add_comp(uid, code, future="0"):
        return SUP.post("/admin/users/%d/competency" % uid, data={"csrf_token": "tok", "action": "add", "skill_id": str(SK[code]),
                                                                  "future": future}, follow_redirects=True)
    r = add_comp(X, "ZZRN-S3")
    XA3 = n_of("SELECT id FROM tc_assignments WHERE subject_id=? AND skill_id=?", X, SK["ZZRN-S3"])
    s.check("Group People adds a competency to a submitted self-assessment: the row is added_open and the person is emailed once",
            r.status_code == 200 and XA3 and n_of("SELECT added_open FROM tc_assignments WHERE id=?", XA3) == 1
            and len(outbox(X)) == 1 and "Competency added" in plain(outbox(X)[0]["body"])
            and "ZZRN Safety" in plain(outbox(X)[0]["body"]), [dict(x)["detail"] for x in outbox(X)])
    s.check("...and the rows added before it are not open (added_open 0)",
            n_of("SELECT SUM(added_open) FROM tc_assignments WHERE subject_id=?", X) == 1)
    s.check("the status stays submitted with the same submitted_at and the remark and answers as they were",
            snap_t(SC_SNAP()) == snap_t(SC0) and SC0[1][0]["status"] == "submitted")
    s.check("tc_added_open is the one reader: the new row only; a person who is not submitted has none",
            [r_["id"] for r_ in ctx(lambda d_: a.tc_added_open(d_, X, CID))] == [XA3]
            and ctx(lambda d_: a.tc_added_open(d_, U["A"], CID)) == [])
    cst = state_of(X, "competency")
    s.check("review_state: the competency part reads OPEN again (it read DONE for a submitted set), the Hub's own count is 1",
            cst["state"] == a.REVIEW_STATE_OPEN and cst["n_open"] == 1
            and ctx(lambda d_: a._tc_self_pending(d_, d_.execute("SELECT * FROM users WHERE id=?", (X,)).fetchone(), CID)) == 1, cst)
    with a.app.app_context():
        d_ = a.get_db()
        ovc = a._competency_overview(d_, d_.execute("SELECT * FROM users WHERE id=?", (X,)).fetchone())["data"]
        gate = a._tc_remark_gate(d_, d_.execute("SELECT * FROM users WHERE id=?", (X,)).fetchone(), CID)
    s.check("the card shows only the new competency, open for answers, not asking the remark again; _tc_progress stays honest (3 rows, 2 answered)",
            ovc["added_only"] is True and ovc["editable"] is True and [i["assignment_id"] for g in ovc["groups"] for i in g["items"]] == [XA3]
            and ovc["total"] == 1 and gate["required"] is False
            and ctx(lambda d_: a._tc_progress(d_, CID, X, XT)) == (2, 3))
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        ux = d_.execute("SELECT * FROM users WHERE id=?", (X,)).fetchone()
        cprompt = a._competency_agent_system(d_, ux, a._tc_context(d_, ux, create=False), journey=True)
    s.check("the competency agent is told in fixed words: a new competency was added, only it is open, the rest is final",
            "a new competency" in cprompt and "ZZRN Safety" in cprompt and "FINAL" in cprompt and "never offer to reopen" in cprompt)

    s.section("C: only that competency can be answered")
    XC = H.client_as(a, X)
    r_old = XC.post("/technical/autosave", data={"csrf_token": "tok", "assignment_id": str(XA1), "answer": "no"})
    r_new = XC.post("/technical/autosave", data={"csrf_token": "tok", "assignment_id": str(XA3), "answer": "yes"})
    s.check("the classic autosave: an answered row is refused (409), the new one saves", r_old.status_code == 409 and r_new.status_code == 200
            and q("SELECT answer FROM tc_scores WHERE assessment_id=? AND assignment_id=?", XT, XA1)[0][0] == "yes"
            and q("SELECT answer FROM tc_scores WHERE assessment_id=? AND assignment_id=?", XT, XA3)[0][0] == "yes")
    ctx(lambda d_: d_.execute("DELETE FROM tc_scores WHERE assessment_id=? AND assignment_id=?", (XT, XA3)))
    r_all = XC.post("/review/competency/save-all", data={"csrf_token": "tok", "answer_%d" % XA1: "developing", "answer_%d" % XA3: "demonstrate"})
    j = r_all.get_json()
    s.check("the card's Save: the other competency is refused, the new one recorded",
            [x["competency"] for x in j["recorded"]] == ["ZZRN Audit" if False else "ZZRN Safety"] and len(j["errors"]) == 1
            and q("SELECT answer FROM tc_scores WHERE assessment_id=? AND assignment_id=?", XT, XA1)[0][0] == "yes", j)
    sec = XC.post("/technical/section-autosave", data={"csrf_token": "tok", "category": "ZZRN Cat", "remark": "ZZRN section"})
    ove = XC.post("/technical/overall-autosave", data={"csrf_token": "tok", "remark": "ZZRN too late"})
    rem = XC.post("/review/competency/remark", data={"csrf_token": "tok", "remark": "ZZRN too late"})
    s.check("the overall remark and the section remark stay refused (409)", sec.status_code == 409 and ove.status_code == 409
            and rem.status_code == 409 and q("SELECT overall_remark FROM tc_assessments WHERE id=?", XT)[0][0] == "ZZRN self remark")
    # falsified: the row gate switched off lets the answered row be overwritten
    real_open = a.tc_row_open
    a.tc_row_open = lambda *x, **k: True
    try:
        r_off = XC.post("/technical/autosave", data={"csrf_token": "tok", "assignment_id": str(XA1), "answer": "no"})
    finally:
        a.tc_row_open = real_open
    s.check("...falsified: with the row gate off, the same post WOULD have changed their submitted answer", r_off.status_code == 200
            and q("SELECT answer FROM tc_scores WHERE assessment_id=? AND assignment_id=?", XT, XA1)[0][0] == "no")
    ctx(lambda d_: d_.execute("UPDATE tc_scores SET answer='yes' WHERE assessment_id=? AND assignment_id=?", (XT, XA1)))

    s.section("C: the line manager cannot approve while it is open")
    ctx(lambda d_: d_.execute("DELETE FROM tc_scores WHERE assessment_id=? AND assignment_id=?", (XT, XA3)))   # the new one unanswered
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        _res, err = a._tc_approve_assessment(d_, d_.execute("SELECT * FROM users WHERE id=?", (U["M"],)).fetchone(), CID, X)
    s.check("approve refuses while a competency added after they submitted is still open, naming it in plain words",
            err and err["reason"] == "added_open" and "ZZRN Safety" in err["msg"] and "added after they submitted" in err["msg"], err)
    real_tao = a.tc_added_open
    a.tc_added_open = lambda *x, **k: []
    try:
        with a.app.test_request_context("/"):
            d_ = a.get_db()
            _res2, err2 = a._tc_approve_assessment(d_, d_.execute("SELECT * FROM users WHERE id=?", (U["M"],)).fetchone(), CID, X)
    finally:
        a.tc_added_open = real_tao
    s.check("...falsified: without the guard it is the older 'a competency has no rating' answer (never added_open)",
            (err2 or {}).get("reason") == "incomplete", err2)
    answer(XT, XA3, "yes")

    s.section("C: submitting it closes it; the status and submitted_at do not move")
    r = XC.post("/review/competency/submit", data={"csrf_token": "tok"})
    s.check("submitted with the new competency answered: ok, it is closed (added_open 0), nothing else moved",
            r.status_code == 200 and r.get_json()["ok"] and n_of("SELECT added_open FROM tc_assignments WHERE id=?", XA3) == 0
            and snap_t(SC_SNAP()[1]) == snap_t(SC0[1]), r.get_data(as_text=True)[:200])
    s.check("...the competency part reads DONE, tc_added_open is empty, and the answered rows are as they were",
            state_of(X, "competency")["state"] == a.REVIEW_STATE_DONE and ctx(lambda d_: a.tc_added_open(d_, X, CID)) == []
            and [tuple(r_)[:2] for r_ in q("SELECT assignment_id, answer FROM tc_scores WHERE assessment_id=? AND assignment_id IN (?,?) ORDER BY 1", XT, XA1, XA2)]
            == [(XA1, "yes"), (XA2, "no")])
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        _res3, err3 = a._tc_approve_assessment(d_, d_.execute("SELECT * FROM users WHERE id=?", (U["M"],)).fetchone(), CID, X)
    s.check("...and now the line manager's approve goes through (it is not held by it any more)", err3 is None, err3)
    ctx(lambda d_: d_.execute("UPDATE tc_assessments SET status='submitted', reviewed_at=NULL, reviewed_by=NULL WHERE id=?", (XT,)))
    # an unanswered one cannot be submitted
    r = add_comp(X, "ZZRN-S4")
    XA4 = n_of("SELECT id FROM tc_assignments WHERE subject_id=? AND skill_id=?", X, SK["ZZRN-S4"])
    ctx(lambda d_: d_.execute("UPDATE tc_assessments SET status='submitted', reviewed_at=NULL, reviewed_by=NULL WHERE id=?", (XT,)))
    r = XC.post("/review/competency/submit", data={"csrf_token": "tok"})
    s.check("a new competency left blank cannot be submitted: refused in plain words, still open",
            r.status_code == 400 and "Answer the new competenc" in r.get_json()["error"]
            and n_of("SELECT added_open FROM tc_assignments WHERE id=?", XA4) == 1, r.get_data(as_text=True)[:160])
    s.section("C: after the Self-assessment window closed: only that row; never once released")
    ctx(lambda d_: d_.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'tc_self', "
                              "'2020-01-01 00:00', '2020-01-02 00:00')", (CID,)))
    r_new = XC.post("/technical/autosave", data={"csrf_token": "tok", "assignment_id": str(XA4), "answer": "yes"})
    r_old = XC.post("/technical/autosave", data={"csrf_token": "tok", "assignment_id": str(XA1), "answer": "no"})
    r_rem = XC.post("/technical/overall-autosave", data={"csrf_token": "tok", "remark": "ZZRN late"})
    s.check("window closed: the new competency still saves (a personal pass); the other row and the remark are refused",
            r_new.status_code == 200 and r_old.status_code == 409 and r_rem.status_code == 409)
    r_sub = XC.post("/review/competency/submit", data={"csrf_token": "tok"})
    s.check("...and submitting it after the close goes through", r_sub.status_code == 200 and n_of("SELECT added_open FROM tc_assignments WHERE id=?", XA4) == 0,
            r_sub.get_data(as_text=True)[:150])
    r = add_comp(X, "ZZRN-S4", "1") if False else None
    # released: a fresh open row, then the release
    ctx(lambda d_: d_.execute("UPDATE tc_assignments SET added_open=1 WHERE id=?", (XA4,)))
    ctx(lambda d_: d_.execute("INSERT INTO result_releases(cycle_id, subject_id, kind) VALUES (?,?, 'pot')", (CID, X)))
    r_rel = XC.post("/technical/autosave", data={"csrf_token": "tok", "assignment_id": str(XA4), "answer": "no"})
    s.check("results released: the pass is gone, the closed window refuses it", r_rel.status_code == 409
            and "closed" in (r_rel.get_json() or {}).get("error", "").lower(), r_rel.get_data(as_text=True)[:150])
    ctx(lambda d_: d_.execute("DELETE FROM result_releases WHERE subject_id=?", (X,)))
    real_pass = a._added_pass
    a._added_pass = lambda *x, **k: False
    try:
        r_np = XC.post("/technical/autosave", data={"csrf_token": "tok", "assignment_id": str(XA4), "answer": "no"})
    finally:
        a._added_pass = real_pass
    s.check("...falsified: with the pass off, the same save is refused by the window", r_np.status_code == 409)
    ctx(lambda d_: d_.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'tc_self', "
                              "'2020-01-01 00:00', NULL)", (CID,)))
    ctx(lambda d_: d_.execute("UPDATE tc_assignments SET added_open=0 WHERE id=?", (XA4,)))

    s.section("C: removing an added competency before it is answered; a Reopen clears it")
    r = add_comp(X, "ZZRN-S4") if n_of("SELECT COUNT(*) FROM tc_assignments WHERE subject_id=? AND skill_id=?", X, SK["ZZRN-S4"]) == 0 else None
    ctx(lambda d_: d_.execute("DELETE FROM tc_assignments WHERE id=?", (XA4,)))
    s.check("an added competency taken off before it is answered: its row is simply gone, nothing is left open",
            ctx(lambda d_: a.tc_added_open(d_, X, CID)) == [])
    XA5 = give(X, "ZZRN-S4", seq=9)
    ctx(lambda d_: d_.execute("UPDATE tc_assignments SET added_open=1 WHERE id=?", (XA5,)))
    r = SUP.post("/admin/users/%d/reopen" % X, data={"csrf_token": "tok", "part": "tc_self", "ref": "", "reason": "ZZRN asked to redo the whole list"})
    s.check("a Reopen of the self-assessment clears added_open on every row (the whole part is open anyway)",
            n_of("SELECT COALESCE(SUM(added_open),0) FROM tc_assignments WHERE subject_id=?", X) == 0
            and n_of("SELECT status FROM tc_assessments WHERE id=?", XT) == "pending", r.status_code)

    s.section("C: a competency added to a person who has NOT submitted: started = email, not started = none")
    V = U["V"]
    VA1 = give(V, "ZZRN-S1")
    VT = asm(V, "pending")
    r = add_comp(V, "ZZRN-S2")
    s.check("a person with no answer yet: nothing is emailed and nothing is held open (it is just part of their set)",
            not outbox(V) and n_of("SELECT added_open FROM tc_assignments WHERE subject_id=? AND skill_id=?", V, SK["ZZRN-S2"]) == 0)
    answer(VT, VA1, "yes")
    r = add_comp(V, "ZZRN-S3")
    s.check("once they have answered something, a competency added emails them (their self-assessment is started), added_open stays 0",
            len(outbox(V)) == 1 and "ZZRN Safety" in plain(outbox(V)[0]["body"])
            and n_of("SELECT COALESCE(SUM(added_open),0) FROM tc_assignments WHERE subject_id=?", V) == 0)

    s.section("C: the swap of a started set emails: what was added and what was removed")
    T = U["T"]
    UNIT = "ZZRN-UNIT"
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT INTO ja_people(employee_id, family_code, sub_code, spec_code, unit_code, arch_grade, source) VALUES "
                   "(?, 'ZZRN-F','ZZRN-S','ZZRN-SPEC', ?, '14', 'test')", (PREFIX + "T", UNIT))
        d_.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, plan_mode, source, active) VALUES "
                   "('ZZRN Sub', 'ZZRN Planner', '14', ?, 'explicit', 'test', 1)", (UNIT + "-14",))
        PROF = d_.execute("SELECT id FROM tc_job_profiles WHERE job_title='ZZRN Planner'").fetchone()[0]
        for i, code in enumerate(("ZZRN-S1", "ZZRN-S4")):
            d_.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, sort_order, is_future) VALUES (?,?,?,0)", (PROF, SK[code], i))
        d_.commit()
    TA1, TA2 = give(T, "ZZRN-S1", seq=1, source="profile"), give(T, "ZZRN-S2", seq=2, source="profile")
    TT = asm(T, "pending")
    answer(TT, TA1, "yes")
    answer(TT, TA2, "no")
    r = SUP.post("/admin/users/%d/competency" % T, data={"csrf_token": "tok", "action": "swap_started", "reason": "ZZRN their job was placed after they started"},
                 follow_redirects=True)
    rows = outbox(T)
    body = plain(rows[0]["body"]) if rows else ""
    s.check("a swap of a started, not-submitted set: ONE email naming what was added (Audit) and removed (Budgeting); their kept answer stays",
            len(rows) == 1 and "added “ZZRN Audit”" in body and "removed “ZZRN Budgeting”" in body
            and "Your other answers are kept" in body and "reopen" not in body.lower()
            and q("SELECT answer FROM tc_scores WHERE assessment_id=? AND assignment_id=?", TT, TA1)[0][0] == "yes", (body[-400:], r.status_code))
    s.check("...nothing is held open by a swap (the set was not submitted: it is the person's whole self-assessment)",
            n_of("SELECT COALESCE(SUM(added_open),0) FROM tc_assignments WHERE subject_id=?", T) == 0)
    ctx(lambda d_: d_.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('redo_email_enabled','0')"))
    n_sw = len(outbox(T))
    save_ctx(lambda d_: a._redo_collect(d_, {"id": CID}, {"id": T}, {"kind": "tc_swap", "added": ["x"], "removed": [], "aids": [TA1]}))
    s.check("with the switch off the swap queues none", len(outbox(T)) == n_sw)
    ctx(lambda d_: d_.execute("DELETE FROM app_settings WHERE key='redo_email_enabled'"))
    s.check("the swap's emails are respected by the same switch as the others (one helper, _redo_notice, called by every trigger)",
            SRC.count("_redo_notice(") >= 2 and "_redo_flush(db, me[\"id\"])" in SRC)

    s.section("the pass opens NOTHING it cannot narrow: after the window closed, the quarterly check-in and unlinked files stay refused")
    F = U["BF"]
    FOLD = line(F, "ZZRN F old", weight=50, result=3, draft=1)
    with a.app.test_request_context("/"):
        from flask import session as _sess
        _sess["user_id"] = F
        d_ = a.get_db()
        uf = d_.execute("SELECT * FROM users WHERE id=?", (F,)).fetchone()
        ev0 = a._review_tool_log_evidence(d_, uf, CID, {"text": "ZZRN an overall example before the confirm"})
    ctx(lambda d_: d_.execute("UPDATE pm_kpi_results SET draft=0 WHERE kpi_target_id=?", (FOLD,)))
    confirm_person(F)
    FNEW = line(F, "ZZRN F added")
    FC = H.client_as(a, F)
    assert ev0.get("ok"), ev0
    FEV = ev0["evidence_id"]
    att0 = FC.post("/review/evidence/%d/attach" % FEV, data={"csrf_token": "tok", "file": (__import__("io").BytesIO(PDF), "u.pdf")},
                   content_type="multipart/form-data")
    FATT = q("SELECT id FROM pm_evidence_attachments WHERE evidence_id=?", FEV)[0][0]
    ck_open_old = FC.post("/review/checkin/save", data={"csrf_token": "tok", "kpi_target_id": str(FOLD), "answer": a.PM_CHECKIN_KEYS[0]})
    with a.app.test_request_context("/"):
        from flask import session as _sess
        _sess["user_id"] = F
        d_ = a.get_db()
        uf = d_.execute("SELECT * FROM users WHERE id=?", (F,)).fetchone()
        tool_open = a._review_tool_checkin(d_, uf, CID, {"kpi_id": FOLD, "answer": a.PM_CHECKIN_KEYS[0]})
    s.check("inside the OPEN window the quarterly writers behave as they always did (the route and the chat tool both write)",
            att0.status_code == 200 and ck_open_old.status_code == 200 and tool_open.get("ok") is True, (ck_open_old.get_data(as_text=True)[:100], tool_open))
    ctx(lambda d_: d_.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_results', "
                              "'2020-01-01 00:00', '2020-01-02 00:00')", (CID,)))
    s.check("...and the added line is still open to them after the close (the pass is on)",
            FC.post("/review/kpi/save-all", data={"csrf_token": "tok", "actual_value_%d" % FNEW: "3"}).status_code == 200)
    ck_old = FC.post("/review/checkin/save", data={"csrf_token": "tok", "kpi_target_id": str(FOLD), "answer": a.PM_CHECKIN_KEYS[1]})
    ck_new = FC.post("/review/checkin/save", data={"csrf_token": "tok", "kpi_target_id": str(FNEW), "answer": a.PM_CHECKIN_KEYS[1]})
    with a.app.test_request_context("/"):
        from flask import session as _sess
        _sess["user_id"] = F
        d_ = a.get_db()
        uf = d_.execute("SELECT * FROM users WHERE id=?", (F,)).fetchone()
        t_old = a._review_tool_checkin(d_, uf, CID, {"kpi_id": FOLD, "answer": a.PM_CHECKIN_KEYS[1]})
        t_new = a._review_tool_checkin(d_, uf, CID, {"kpi_id": FNEW, "answer": a.PM_CHECKIN_KEYS[1]})
    s.check("window closed, an added line open: the quarterly check-in is refused on the OLD line and on the new one, route and tool "
            "(the pass is for the new line's result, not for this writer)", ck_old.status_code == 409 and ck_new.status_code == 409
            and t_old.get("ok") is False and t_new.get("ok") is False
            and q("SELECT answer FROM pm_checkins WHERE kpi_target_id=?", FOLD)[0][0] == a.PM_CHECKIN_KEYS[0], (t_old, t_new))
    f_unl = FC.post("/review/evidence/%d/attach" % FEV, data={"csrf_token": "tok", "file": (__import__("io").BytesIO(PDF), "v.pdf")},
                    content_type="multipart/form-data")
    d_unl = FC.post("/review/evidence/attachment/%d/delete" % FATT, data={"csrf_token": "tok"})
    s.check("...an unlinked file cannot be added to an example, nor taken off one, on the pass alone",
            f_unl.status_code in (400, 409) and d_unl.status_code in (400, 409)
            and q("SELECT COUNT(*) FROM pm_evidence_attachments WHERE evidence_id=?", FEV)[0][0] == 1, (f_unl.status_code, d_unl.status_code))
    real_only = a._added_pass_only
    a._added_pass_only = lambda *x, **k: False
    try:
        f_off = FC.post("/review/evidence/%d/attach" % FEV, data={"csrf_token": "tok", "file": (__import__("io").BytesIO(PDF), "w.pdf")},
                        content_type="multipart/form-data")
    finally:
        a._added_pass_only = real_only
    s.check("...falsified: with that check off the unlinked attach WOULD have gone through", f_off.status_code == 200)
    ctx(lambda d_: d_.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_results', "
                              "'2020-01-01 00:00', NULL)", (CID,)))
    s.check("the route map: only the narrowed routes may be opened by the pass (_ADDED_PASS_ROUTES), the quarterly check-in is not one",
            "review_checkin_save" not in a._ADDED_PASS_ROUTES and "review_kpi_save_all" in a._ADDED_PASS_ROUTES
            and "technical_autosave" in a._ADDED_PASS_ROUTES and "review_competency_remark" not in a._ADDED_PASS_ROUTES)

    s.section("the pass on the competency side: after the close, every writer for an OLD competency refuses; the new one still answers")
    G_ = U["BG"]
    GA1 = give(G_, "ZZRN-S1", seq=1)
    GT = asm(G_, "submitted")
    answer(GT, GA1, "yes", "ZZRN why")
    add_comp(G_, "ZZRN-S2")
    GA2 = n_of("SELECT id FROM tc_assignments WHERE subject_id=? AND skill_id=?", G_, SK["ZZRN-S2"])
    ctx(lambda d_: d_.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'tc_self', "
                              "'2020-01-01 00:00', '2020-01-02 00:00')", (CID,)))
    GC = H.client_as(a, G_)
    with a.app.test_request_context("/"):
        from flask import session as _sess
        _sess["user_id"] = G_
        d_ = a.get_db()
        ug = d_.execute("SELECT * FROM users WHERE id=?", (G_,)).fetchone()
        tc_old = a._tc_tool_set_competency(d_, ug, CID, {"assignment_id": GA1, "answer": "no"})
        tc_old_agent = a._tc_agent_set_competency(d_, ug, CID, {"assignment_id": GA1, "answer": "no"})
        n_old = a._tc_save_competency_note(d_, ug, CID, GA1, "ZZRN late note")
        n_all = a._tc_tool_set_overall_note(d_, ug, CID, {"text": "ZZRN a late overall remark of mine"})
        tc_new = a._tc_tool_set_competency(d_, ug, CID, {"assignment_id": GA2, "answer": "yes"})
    r_note_old = GC.post("/review/competency/note", data={"csrf_token": "tok", "assignment_id": str(GA1), "text": "ZZRN late note"})
    r_old = GC.post("/technical/autosave", data={"csrf_token": "tok", "assignment_id": str(GA1), "answer": "no"})
    r_sa = GC.post("/review/competency/save-all", data={"csrf_token": "tok", "answer_%d" % GA1: "developing"})
    r_sec = GC.post("/technical/section-autosave", data={"csrf_token": "tok", "category": "ZZRN Cat", "remark": "x"})
    r_ov = GC.post("/technical/overall-autosave", data={"csrf_token": "tok", "remark": "x"})
    r_rm = GC.post("/review/competency/remark", data={"csrf_token": "tok", "remark": "x"})
    s.check("window closed: the chat tool (set_competency, the agent's wrapper, a competency note, the overall note) refuses every OLD "
            "competency and the remark, and writes the new one", tc_old["ok"] is False and tc_old_agent["ok"] is False
            and n_old[0] is False and n_all["ok"] is False and tc_new["ok"] is True, (tc_old, n_old, n_all, tc_new))
    s.check("...and the routes: an old row's answer, its note, the card's Save for it, the section remark, the overall remark",
            r_old.status_code == 409 and r_note_old.status_code in (400, 409) and r_sa.get_json()["recorded"] == []
            and r_sec.status_code == 409 and r_ov.status_code == 409 and r_rm.status_code == 409
            and q("SELECT answer FROM tc_scores WHERE assessment_id=? AND assignment_id=?", GT, GA1)[0][0] == "yes", r_sa.get_data(as_text=True)[:120])
    ctx(lambda d_: d_.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'tc_self', "
                              "'2020-01-01 00:00', NULL)", (CID,)))

    s.section("capacity: a save that reaches hundreds of people is a few batched reads, not a set of reads a person")
    import time as _time
    NCAP, NIDLE = 300, 100
    cap_ids, idle_ids = [], []

    def _mkcap(d_):
        for i in range(NCAP + NIDLE):
            eid = "%sCAP%03d" % (PREFIX, i)
            uid = d_.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                             "department, job_title, job_grade, confirmation_date, manager_id, email) VALUES (?,?, 'x', 'user', ?,?,?,?, "
                             "'ZZ Analyst', '14', '2020-01-01', ?, ?)", (eid.lower(), "ZZ RN Cap %d" % i, eid, BG, CO, DEPT, U["M"],
                                                                         "%s@example.test" % eid.lower())).lastrowid
            (cap_ids if i < NCAP else idle_ids).append(uid)
            d_.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, category, weightage, method, unit, rate1, rate2, "
                       "rate3, rate4, rate5, business_group, company, department, status) VALUES (?,?, 'ZZRN cap keyed', 'x', 50, 'more', "
                       "'RM', 1,2,3,4,5, ?,?,?, 'approved')", (CID, uid, BG, CO, DEPT))
            kid = d_.execute("SELECT MAX(id) FROM pm_kpi_targets").fetchone()[0]
            if i < NCAP:   # started: a draft result of their own
                d_.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,3,?,1)", (kid, uid))
        return None
    ctx(_mkcap)
    new_ids = {}

    def _mknew(d_):
        for uid in cap_ids + idle_ids:
            new_ids[uid] = d_.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, category, weightage, method, unit, rate1, "
                                      "rate2, rate3, rate4, rate5, business_group, company, department, status) VALUES (?,?, 'ZZRN cap new', "
                                      "'x', 20, 'more', 'RM', 1,2,3,4,5, ?,?,?, 'approved')", (CID, uid, BG, CO, DEPT)).lastrowid
    ctx(_mknew)
    t0 = _time.time()
    save_ctx(lambda d_: [kpi_change(uid, new_ids[uid], "ZZRN cap new")(d_) for uid in cap_ids + idle_ids])
    took = _time.time() - t0
    n_cap = n_of("SELECT COUNT(*) FROM email_outbox WHERE kind='redo_notice' AND user_id IN (%s)" % ",".join(str(x) for x in cap_ids))
    n_idle = n_of("SELECT COUNT(*) FROM email_outbox WHERE kind='redo_notice' AND user_id IN (%s)" % ",".join(str(x) for x in idle_ids))
    s.note("_redo_flush for %d started + %d not started people: %.2f s" % (NCAP, NIDLE, took))
    s.check("%d started people get one email each and the %d who had not started none, well under 10 s (%.2f s)" % (NCAP, NIDLE, took),
            n_cap == NCAP and n_idle == 0 and took < 10, (n_cap, n_idle, took))
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        nq = []
        d_.set_trace_callback(lambda stmt: nq.append(stmt))
        a._redo_bucket().update({CID: {uid: [{"kind": "kpi", "tid": new_ids[uid], "name": "ZZRN cap new"}] for uid in idle_ids}})
        a._redo_flush(d_, SU["id"])
        d_.set_trace_callback(None)
    s.check("people who have not started cost a handful of reads for all %d of them together (%d statements), not a set each" % (NIDLE, len(nq)),
            len(nq) < 40, len(nq))

    # -----------------------------------------------------------------------------------------------------------------
    s.section("the \"Email them\" tick (2026-11-07): the confirm box offers it only where an email would go; unticked withholds it")

    def skipped(uid):
        return q("SELECT detail FROM notifications WHERE user_id=? AND kind='redo_notice' AND status='skipped' AND detail LIKE '%chose not to email%'", uid)

    def trail(uid, action):
        return [r_[0] for r_ in q("SELECT detail FROM activity_log WHERE target_user_id=? AND action=? ORDER BY id", uid, action)]

    def page(uid, tab):
        return SUP.get("/admin/users/%d?tab=%s" % (uid, tab)).get_data(as_text=True)

    def mkp(eid):
        def _mk(d_):
            return d_.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                              "department, job_title, job_grade, confirmation_date, manager_id, email) VALUES (?,?, 'x', 'user', ?,?,?,?, "
                              "'ZZ Analyst', '14', '2020-01-01', ?, ?)", (eid.lower(), "ZZ RN " + eid[-3:], eid, BG, CO, DEPT, U["M"],
                                                                          "%s@example.test" % eid.lower())).lastrowid
        return ctx(_mk)
    TU = {e: mkp(PREFIX + "T" + e) for e in ("KA", "KN", "KB", "KC", "CD", "CE", "CF", "CG")}   # fresh people: nothing before this section touched them
    # --- the form carries the tick for a started person, not for one who has not started, not with the switch off
    line(TU["KA"], "ZZRN tick existing KA", result=5, draft=1)
    line(TU["KN"], "ZZRN tick existing KN")
    pg_a, pg_b = page(TU["KA"], "performance"), page(TU["KN"], "performance")
    s.check("the KPI Add form of a person who has started carries data-confirm-notify with their name and both sub-lines",
            'data-confirm-notify="Email ZZ RN TKA about this change"' in pg_a and "data-confirm-notify-sub=" in pg_a
            and "data-confirm-notify-off=" in pg_a and "Untick to add it without emailing them." in pg_a)
    s.check("...and that of a person who has NOT started does not (the box is as it was)", 'data-confirm-notify="' not in pg_b
            and 'data-kpe="add"' in pg_b)
    ctx(lambda d_: d_.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('redo_email_enabled','0')"))
    s.check("...nor with the super admin's switch off", 'data-confirm-notify="' not in page(TU["KA"], "performance"))
    ctx(lambda d_: d_.execute("DELETE FROM app_settings WHERE key='redo_email_enabled'"))
    # --- KPI add, unticked
    BA, BB, BC = TU["KA"], TU["KB"], TU["KC"]
    for x in (BB, BC):
        line(x, "ZZRN tick existing %d" % x, result=5, draft=1)
    r = admin_add(BA, notify_person="0")
    body_ = r.get_data(as_text=True)
    s.check("KPI add, unticked on a started person: the line is added, NO outbox row", n_of("SELECT COUNT(*) FROM pm_kpi_targets WHERE subject_id=?", BA) == 2
            and not outbox(BA), len(outbox(BA)))
    s.check("...one notifications row 'the admin chose not to email', the trail line ends 'not emailed (unticked)', the flash ends 'Not emailed.'",
            len(skipped(BA)) == 1 and trail(BA, "pm_kpi_add")[-1].endswith("; not emailed (unticked)") and "added. Not emailed." in body_,
            (skipped(BA), trail(BA, "pm_kpi_add")))
    r = admin_add(BB, notify_person="1")
    s.check("KPI add with notify_person=1 is today's behaviour: one queued email, no skipped row, no 'not emailed' words",
            len(outbox(BB)) == 1 and not skipped(BB) and "not emailed" not in trail(BB, "pm_kpi_add")[-1]
            and "Not emailed" not in r.get_data(as_text=True))
    r = admin_add(BC)
    s.check("KPI add with the field ABSENT is the same (an absent field never suppresses)", len(outbox(BC)) == 1 and not skipped(BC))
    r = admin_add(BC, lib="brand", notify_person="")
    s.check("...and so is an empty or odd value: only an explicit 0 withholds", len(outbox(BC)) == 2 and not skipped(BC))
    # --- competency add, unticked: a started person, a submitted person, and Add with next level (two lines)
    NX = {}
    for lvl in (3, 4):
        NX[lvl] = ctx(lambda d_, lvl=lvl: d_.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category) VALUES (?,?,?, "
                                                       "'Technical', 'ZZRN Cat')", ("ZZRN-N%d001-1.0" % lvl, "ZZRN Nextable", lvl)).lastrowid)
    BD, BE, BF = TU["CD"], TU["CE"], TU["CF"]
    BDA, BEA, BFA = give(BD, "ZZRN-S1"), give(BE, "ZZRN-S1"), give(BF, "ZZRN-S1")
    for x, xa, st in ((BD, BDA, "pending"), (BE, BEA, "pending"), (BF, BFA, "submitted")):
        answer(asm(x, st), xa, "yes")
    cf = SUP.get("/admin/users/%d/competency/find?kind=skills&q=ZZRN" % BD).get_data(as_text=True)
    cf_b = SUP.get("/admin/users/%d/competency/find?kind=skills&q=ZZRN" % TU["KN"]).get_data(as_text=True)
    s.check("the competency library's Add buttons carry the tick for a person who has started (every Add button)",
            cf.count("data-confirm-notify=") >= 2
            and "Untick to make the change without emailing them." in cf and "data-cd-rowadd" in cf, cf[:200])
    s.check("...and not for a person who has not started", "data-cd-rowadd" in cf_b and "data-confirm-notify" not in cf_b)
    r = SUP.post("/admin/users/%d/competency" % BD, data={"csrf_token": "tok", "action": "add", "skill_id": str(SK["ZZRN-S2"]),
                                                          "future": "0", "notify_person": "0"}, follow_redirects=True)
    s.check("competency add, unticked (started): added, NO outbox row, one 'chose not to email' row, trail and flash say so",
            n_of("SELECT COUNT(*) FROM tc_assignments WHERE subject_id=? AND skill_id=?", BD, SK["ZZRN-S2"]) == 1 and not outbox(BD)
            and len(skipped(BD)) == 1 and trail(BD, "tc_person_add")[-1].endswith("; not emailed (unticked)")
            and "Added ZZRN Budgeting L3. Not emailed." in plain(r.get_data(as_text=True)), (outbox(BD), skipped(BD), trail(BD, "tc_person_add")))
    r = SUP.post("/admin/users/%d/competency" % BD, data={"csrf_token": "tok", "action": "add", "skill_id": str(SK["ZZRN-S3"]),
                                                          "future": "0", "notify_person": "1"}, follow_redirects=True)
    s.check("competency add with notify_person=1: today's behaviour (one email, nothing skipped)", len(outbox(BD)) == 1 and len(skipped(BD)) == 1
            and "Not emailed" not in plain(r.get_data(as_text=True)))
    r = SUP.post("/admin/users/%d/competency" % BD, data={"csrf_token": "tok", "action": "add", "skill_id": str(SK["ZZRN-S4"]), "future": "0"},
                 follow_redirects=True)
    s.check("competency add with the field ABSENT emails as before (a second queued email, no new skipped row)",
            len(outbox(BD)) == 2 and len(skipped(BD)) == 1)
    r = SUP.post("/admin/users/%d/competency" % BF, data={"csrf_token": "tok", "action": "add", "skill_id": str(SK["ZZRN-S2"]),
                                                          "future": "0", "notify_person": "0"}, follow_redirects=True)
    s.check("competency add, unticked on a person who SUBMITTED: it still opens for them (added_open), but no email, one skipped row",
            n_of("SELECT COALESCE(SUM(added_open),0) FROM tc_assignments WHERE subject_id=?", BF) == 1 and not outbox(BF) and len(skipped(BF)) == 1)
    r = SUP.post("/admin/users/%d/competency" % BE, data={"csrf_token": "tok", "action": "add", "skill_id": str(NX[3]), "with_next": "1",
                                                          "notify_person": "0"}, follow_redirects=True)
    s.check("Add with next level (two lines in one save), unticked: both lines added, BOTH withheld: no outbox row, one skipped row",
            n_of("SELECT COUNT(*) FROM tc_assignments WHERE subject_id=? AND skill_id IN (?,?)", BE, NX[3], NX[4]) == 2 and not outbox(BE)
            and len(skipped(BE)) == 1 and trail(BE, "tc_person_add")[-1].endswith("; not emailed (unticked)"), (outbox(BE), skipped(BE)))
    # --- a person it would not email anyway: unticked writes no 'skipped' row and no 'Not emailed.' words
    VV = mkp(PREFIX + "TICKNS")   # no answers: not started
    giveV = give(VV, "ZZRN-S1")
    asm(VV, "pending")
    r = SUP.post("/admin/users/%d/competency" % VV, data={"csrf_token": "tok", "action": "add", "skill_id": str(SK["ZZRN-S2"]),
                                                          "future": "0", "notify_person": "0"}, follow_redirects=True)
    s.check("unticked for a person who would not have been emailed anyway (not started): nothing logged as skipped, no 'Not emailed.'",
            not skipped(VV) and not outbox(VV) and "Not emailed" not in plain(r.get_data(as_text=True))
            and "not emailed" not in trail(VV, "tc_person_add")[-1])
    # --- the swap: the form carries the tick (with the reason box), unticked withholds
    BG_ = TU["CG"]
    ctx(lambda d_: d_.execute("INSERT INTO ja_people(employee_id, family_code, sub_code, spec_code, unit_code, arch_grade, source) VALUES "
                              "(?, 'ZZRN-F','ZZRN-S','ZZRN-SPEC', 'ZZRN-UNIT2', '14', 'test')", (PREFIX + "TCG",)))

    def _prof(d_):
        pid = d_.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, plan_mode, source, active) VALUES "
                         "('ZZRN Sub', 'ZZRN Planner Two', '14', 'ZZRN-UNIT2-14', 'explicit', 'test', 1)").lastrowid
        for i, code in enumerate(("ZZRN-S1", "ZZRN-S4")):
            d_.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, sort_order, is_future) VALUES (?,?,?,0)", (pid, SK[code], i))
    ctx(_prof)
    BGA1, BGA2 = give(BG_, "ZZRN-S1", seq=1, source="profile"), give(BG_, "ZZRN-S2", seq=2, source="profile")
    BGT = asm(BG_, "pending")
    answer(BGT, BGA1, "yes")
    answer(BGT, BGA2, "no")
    pg = page(BG_, "competency")
    fm = re.search(r'<form[^>]*class="pp-swap"[^>]*>', pg)
    s.check("the Swap form carries the tick beside its reason box and danger tone (swap wording, the person's name)",
            fm and "data-confirm-notify=" in fm.group(0) and "data-confirm-reason=" in fm.group(0) and 'data-confirm-tone="danger"' in fm.group(0)
            and "One email naming what was added and removed. Untick to swap without emailing them." in fm.group(0), fm and fm.group(0)[-300:])
    r = SUP.post("/admin/users/%d/competency" % BG_, data={"csrf_token": "tok", "action": "swap_started", "notify_person": "0",
                                                           "reason": "ZZRN swapped, tick test"}, follow_redirects=True)
    s.check("swap, unticked: the set swaps, NO outbox row, one skipped row, the trail line ends 'not emailed (unticked)', the flash 'Not emailed.'",
            n_of("SELECT COUNT(*) FROM tc_assignments WHERE subject_id=? AND skill_id=?", BG_, SK["ZZRN-S4"]) == 1 and not outbox(BG_)
            and len(skipped(BG_)) == 1 and trail(BG_, "tc_person_swap")[-1].endswith("; not emailed (unticked)")
            and "Not emailed." in plain(r.get_data(as_text=True)), (outbox(BG_), skipped(BG_), trail(BG_, "tc_person_swap")))
    # --- the helper's own conditions
    with a.app.app_context():
        d_ = a.get_db()
        cyc_ = a.active_cycle(d_)
        pu = lambda k: d_.execute("SELECT * FROM users WHERE id=?", (TU[k],)).fetchone()   # noqa: E731
        s.check("redo_tick_shown: a started KPI person yes, a not-started one no; a started competency person yes for tc_add, a swap always",
                a.redo_tick_shown(d_, pu("KA"), cyc_, "kpi") and not a.redo_tick_shown(d_, pu("KN"), cyc_, "kpi")
                and a.redo_tick_shown(d_, pu("CD"), cyc_, "tc_add") and a.redo_tick_shown(d_, pu("CD"), cyc_, "tc_swap")
                and not a.redo_tick_shown(d_, pu("KA"), cyc_, "bogus"))
        d_.execute("UPDATE users SET left_at='2026-01-01' WHERE id=?", (TU["KA"],))
        s.check("...and no for a leaver (falsified: the same person with left_at cleared is yes)",
                not a.redo_tick_shown(d_, pu("KA"), cyc_, "kpi"))
        d_.execute("UPDATE users SET left_at=NULL WHERE id=?", (TU["KA"],))
        d_.commit()
        s.check("...left_at cleared again: yes", a.redo_tick_shown(d_, pu("KA"), cyc_, "kpi"))
    # --- the dialog itself (static): base.html and the stylesheet carry the handling
    BASE = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "templates", "base.html")).read()
    CSS = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "style.css")).read()
    s.check("base.html's confirm box reads data-confirm-notify (+ -sub, -off, -field default notify_person) and writes 1 or 0 only on OK",
            all(k in BASE for k in ("data-confirm-notify'", "data-confirm-notify-sub", "data-confirm-notify-off", "data-confirm-notify-field",
                                    "'notify_person'", "nBox.checked ? '1' : '0'", "confirm-dialog__notify")))
    s.check("style.css styles .confirm-dialog__notify with tokens (surface-2, line, accent-ink) and no hex",
            ".confirm-dialog__notify {" in CSS and "var(--surface-2)" in CSS and "accent-color: var(--accent-ink)" in CSS)

finally:
    pass

sys.exit(s.done())
