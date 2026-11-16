"""AI+ Learning's gap check, wave 4 (2026-10-23): promises the screens made that the code didn't keep.

What this suite holds (4a, what people see):
  * the 6-month check-in is gone (Chris, 2026-10-23: "Remove the tick"): the programme form asks nothing, a saved
    programme asks 1 and 3 months whatever was posted, the schedule never plans a 6-month one
  * a 3-month check-in their line manager said "not yet" to comes back to the person with the note, to send again; it
    then waits on the line manager afresh
  * an assessed gap counts as their plan in the calendar and the coach (the code tested a "gap" label nothing writes)
  * the dashboard has a row for a request that came back, and for one declined, cancelled with its session or taken
    off by L&D in the last 14 days
  * Learning's rows show while a cycle hasn't opened yet (the dashboard's "awaiting" mode)
What it holds (4b-1, L&D's side):
  * e-learning: L&D marks who completed it, with one reason (L&D only); closing credits them and never marks anyone
    else absent; no room, QR or T3 on its page, the person's card or its calendar file
  * a programme with runs still to come can't be withdrawn or archived
  * the programme's audience takes units (listed ones only), so saving no longer wipes them
  * a chain saved with no steps needs its own tick ("confirmed at once, no approval")
  * a session's own trainer, else the programme's; an edit that doesn't send it keeps it
  * a JD14 claim older than the HRDC board's 90 days still opens to edit
  * rounds: an HOD can say nobody this round, which counts as answered and stops the reminder; every open round
    emails; an HOD with the round's ability off gets none
What it holds (4b-2):
  * the Needs page's people counts open their list (the super admin's): who, what they need, where it comes from
  * the CEO Learning cards count Learning's own population, not calibration's
  * seats read "18 left of 20" where staff see them; withdrawing is "until the day before"; "they see your note" only
    when there is one; the team XP note names L&D's reports
  * the approval reminder links by role, and says it passes on only when the step does; a line manager whose approving
    is switched off isn't emailed about it
  * the check-in email follows each kind's switch and L&D's own words
Everything here is synthetic (ZZLP / ZZ9LP-) and removed at the end.
"""
import html
import json
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning gap check, wave 4: promises kept")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO = "ZZLP Group", "ZZLP U1"
_ENV0 = os.environ.get("ONEHR_LMS")
_NEEDS0, _AWAIT0, _SCREEN0 = a.lms_person_needs, a.cycle_awaiting_open, a.ai_draft.screen_message
_MAIL0 = a.mailer.is_configured
TODAY = a._today_myt()
K = "zzlp-negotiation"


def D(n):
    return (TODAY + timedelta(days=n)).isoformat()


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LP-%' OR username LIKE 'zzlp-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLP %'")
    db.execute("DELETE FROM lms_rounds WHERE title LIKE 'ZZLP %'")
    if ul:
        ph = ",".join("?" * len(ul))
        for t in ("lms_registrations", "email_outbox", "lms_sent", "lms_attendance"):
            db.execute("DELETE FROM %s WHERE user_id IN (%s)" % (t, ph), ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, mgr=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, manager_id, confirmation_date) VALUES "
                      "(?,?, 'x', 'user', ?,?,?, 'ZZLP Sales', 'ZZLP Officer', '15', ?, '2020-01-01')",
                      (eid.lower(), "ZZ LP " + eid.split("-")[1], eid, BG, CO, mgr)).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, CO))
    MGR = person(db, "ZZ9LP-MGR")
    E1, E2, E3, E4, E5 = (person(db, "ZZ9LP-E%d" % i, MGR) for i in range(1, 6))
    LND = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzlp-lnd', 'ZZ LP L&D', 'x', 'admin', ?)", (a.LMS_ADMIN_BG,)).lastrowid

    def prog(title, eff="1,3"):
        return db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days, effectiveness) VALUES "
                          "(?, 'inhouse', 'published', 7, 1, ?)", (title, eff)).lastrowid
    P, P6 = prog("ZZLP Negotiation"), prog("ZZLP Old Six", "1,3,6")
    db.execute("INSERT INTO lms_programme_competencies(programme_id, comp_key, level, confirmed) VALUES (?, ?, 3, 1)",
               (P, K))

    def sess(pid, day):
        return db.execute("INSERT INTO lms_sessions(programme_id, starts_on, ends_on, start_time, end_time, venue, seats, "
                          "reg_cutoff) VALUES (?,?,?, '09:00', '17:00', 'ZZLP Room', 20, ?)",
                          (pid, D(day), D(day), D(day - 20))).lastrowid
    S, S_OLD6, S_PAST = sess(P, 40), sess(P6, -200), sess(P6, -100)

    def reg(uid, sid, pid, status="approved", outcome=None, **kw):
        cols = ["user_id", "session_id", "programme_id", "status", "outcome", "chain_json"] + list(kw)
        vals = [uid, sid, pid, status, outcome, "[]"] + list(kw.values())
        return db.execute("INSERT INTO lms_registrations(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                          vals).lastrowid
    R6 = reg(E5, S_OLD6, P6, outcome="attended", hours=7)
    RK = reg(E1, S_PAST, P6, outcome="attended", hours=7)
    db.execute("INSERT INTO lms_evaluations(registration_id, kind, due_on, status, words_json) VALUES (?, 'm3', ?, "
               "'self_done', ?)", (RK, D(-10), json.dumps({"changed": "ZZLP: I now lead the dealer calls myself.",
                                                            "example": "ZZLP: held list price with two dealers."})))
    RR = reg(E2, S, P, status="returned", remark="ZZLP: say which goal it builds")
    RD = reg(E3, S, P, status="cancelled", closed_kind="declined", remark="ZZLP: not this quarter")
    RO = reg(E4, S, P, status="cancelled", closed_kind="session", remark="ZZLP: venue lost",
             updated_at=(TODAY - timedelta(days=20)).isoformat() + " 09:00:00")
    # 4b-1
    PE = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days, trainer) VALUES ('ZZLP Excel Online', "
                    "'elearning', 'published', 6, 1, 'ZZLP Programme Trainer')").lastrowid
    SE = db.execute("INSERT INTO lms_sessions(programme_id, starts_on, ends_on, start_time, end_time, seats) VALUES "
                    "(?,?,?, '00:00', '23:59', 50)", (PE, D(-5), D(-1))).lastrowid
    SEF = db.execute("INSERT INTO lms_sessions(programme_id, starts_on, ends_on, seats, reg_cutoff) VALUES (?,?,?, 50, ?)",
                     (PE, D(20), D(30), D(10))).lastrowid
    RE1, RE2 = reg(E1, SE, PE), reg(E2, SE, PE)
    REF = reg(E3, SEF, PE)
    PH = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days, hrdc_claimable) VALUES ('ZZLP Old HRDC', "
                    "'inhouse', 'published', 7, 1, 1)").lastrowid
    SH = sess(PH, -200)
    reg(E4, SH, PH, outcome="attended", hours=7)
    db.execute("INSERT INTO lms_jd14(session_id, business_group, step, due_on) VALUES (?, ?, 'sign', ?)", (SH, BG, D(-150)))
    HOD = person(db, "ZZ9LP-HOD")
    db.execute("UPDATE users SET hod_id=? WHERE id IN (?,?)", (HOD, E1, E2))
    RD1 = db.execute("INSERT INTO lms_rounds(title, closes_on) VALUES ('ZZLP Round One', ?)", (D(2),)).lastrowid
    RD2 = db.execute("INSERT INTO lms_rounds(title, closes_on) VALUES ('ZZLP Round Two', ?)", (D(25),)).lastrowid
    for rd_ in (RD1, RD2):
        db.execute("INSERT INTO lms_round_sessions(round_id, session_id) VALUES (?, ?)", (rd_, S))
    db.commit()


def one(sql, args=()):
    return H.one(a, sql, args)


def u_(uid):
    with a.app.app_context():
        return dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def call(fn, *args, **kw):
    with a.app.test_request_context():
        return fn(a.get_db(), *args, **kw)


def body(r):
    return html.unescape(r.get_data(as_text=True))


def exe(sql, args=()):
    with a.app.app_context():
        d = a.get_db()
        d.execute(sql, args)
        d.commit()


try:
    os.environ["ONEHR_LMS"] = "1"
    a.ai_draft.screen_message = (lambda m: None)
    CL = H.client_as(a, LND)

    s.section("the 6-month check-in is gone")
    pg = body(CL.get("/admin/learning/programmes"))
    s.check("the programme form asks no 6 months", 'name="eff_6"' not in pg and 'name="eff_1"' not in pg and
            "Every programme asks these" in pg)
    CL.post("/admin/learning/programmes", data={"csrf_token": "tok", "action": "save", "title": "ZZLP Posted Six",
                                                "kind": "inhouse", "eff_1": "1", "eff_3": "1", "eff_6": "1"})
    s.check("a 6 posted anyway isn't kept", one("SELECT effectiveness FROM lms_programmes WHERE title='ZZLP Posted Six'")
            == "1,3")
    kinds = {e["kind"] for e in call(a.lms_eval_plan, [E5], TODAY) if e["reg"] == R6}
    s.check("a programme that once asked 6 plans 1 and 3 only", kinds == {"m1", "m3"}, kinds)

    s.section("not yet, then again")
    ok, msg = call(a.lms_eval_confirm, u_(MGR), one("SELECT id FROM lms_evaluations WHERE registration_id=?", (RK,)),
                   "kept", None, "ZZLP: show me it on the Southern accounts first")
    s.check("the line manager says not yet, with a note", ok and "send it again" in msg, msg)
    due = call(a.lms_eval_due, [E1])[E1]
    s.check("it comes back to the person", [(e["reg"], e["kind"], e["again"]) for e in due] == [(RK, "m3", True)], due)
    ap = body(H.client_as(a, E1).get("/learning?view=mine&tab=apply"))
    with a.app.test_request_context():
        sh = a.lms_shell(a.get_db(), u_(E1), a.lms_space(a.get_db(), u_(E1), "mine"), "apply")
    s.check("...its queue line says so", any(i["sub"].startswith("Your line manager: not yet") for i in
                                             sh["queue"]["items"]), sh["queue"]["items"])
    s.check("...who reads the note and can send it again", "Not yet: send it again" in ap and
            "show me it on the Southern accounts first" in ap and "Send it again" in ap)
    ok, msg = call(a.lms_eval_answer, u_(E1), RK, "m3", {"changed": "ZZLP: I now run the Southern accounts' pricing.",
                                                           "example": "ZZLP: three quotes held at list this month."})
    row = H.rows(a, "SELECT * FROM lms_evaluations WHERE registration_id=? AND kind='m3'", (RK,))[0]
    s.check("sent again: it waits on the line manager afresh", ok and row["status"] == "self_done" and
            row["mgr_action"] is None and row["confirmed_by"] is None, (msg, dict(row)))
    s.check("...who sees it to confirm again", RK in [e["rid"] for e in call(a.lms_eval_to_confirm, u_(MGR))])
    s.check("...and it's off the person's to-do", not call(a.lms_eval_due, [E1])[E1])

    s.section("an assessed gap is their plan")
    a.lms_person_needs = lambda db, u: [{"key": K, "title": "ZZLP Negotiation skills", "level": 3, "have": 2,
                                          "source": "assessed", "area": None}]
    with a.app.test_request_context():
        d = a.get_db()
        cards = a.lms_coach_find(d, u_(E5))["cards"]
        cal = a.lms_calendar(d, u_(E5), D(40)[:7])
    card = next((c for c in cards if c.get("sid") == S), None)
    ev = cal["events"].get(S)
    s.check("the coach puts it first as their plan", card and card["plan"], cards[:3])
    s.check("the calendar marks it their plan", ev and ev["state"] == "plan", ev)
    a.lms_person_needs = lambda db, u: [{"key": K, "title": "ZZLP Negotiation skills", "level": 3, "have": 2,
                                          "source": "future", "area": None}]
    with a.app.test_request_context():
        ev = a.lms_calendar(a.get_db(), u_(E5), D(40)[:7])["events"].get(S)
    s.check("...their job's next level isn't (it isn't a plan)", ev and ev["state"] == "open", ev)
    a.lms_person_needs = _NEEDS0
    pp = body(H.client_as(a, E5).get("/learning/programme/%d" % P))
    s.check("the programme page's words follow the labels", "a gap of yours" in open(
        os.path.join(H.REPO, "templates", "learning", "programme.html")).read() and "'gap'" not in open(
        os.path.join(H.REPO, "templates", "learning", "programme.html")).read() and pp)

    s.section("the dashboard's rows")
    with a.app.test_request_context():
        d = a.get_db()
        t2 = [x["title"] for x in a.dash_learning(d, u_(E2))["acts"]]
        t3 = [x["title"] for x in a.dash_learning(d, u_(E3))["acts"]]
        t4 = [x["title"] for x in a.dash_learning(d, u_(E4))["acts"]]
    s.check("a request back with them", "Your request came back: ZZLP Negotiation" in t2, t2)
    s.check("one declined in the last 14 days", "Declined: ZZLP Negotiation" in t3, t3)
    s.check("...not one closed 20 days ago", not any("ZZLP Negotiation" in x for x in t4), t4)

    s.section("while a cycle hasn't opened")
    a.cycle_awaiting_open = lambda db, cyc: bool(cyc)
    h = body(H.client_as(a, E2).get("/dashboard"))
    a.cycle_awaiting_open = _AWAIT0
    s.check("Learning's rows show in the awaiting dashboard", "od-await" in h and "od-await-learn" in h and
            "Your request came back: ZZLP Negotiation" in h, h[h.find("od-await"):][:600])
    s.section("e-learning")
    ok, msg = call(a.lms_mark_completed, u_(LND), SE, [E1], "")
    s.check("marking a completion needs the reason", not ok and "reason" in msg, msg)
    ok, msg = call(a.lms_mark_completed, u_(MGR), SE, [E1], "ZZLP report")
    s.check("...and is L&D's", not ok, msg)
    r = CL.post("/admin/learning/sessions/%d" % SE, data={"csrf_token": "tok", "action": "mark_done", "uid": [str(E1)],
                                                          "reason": "ZZLP: the platform's completion report"})
    s.check("L&D marks the ticked completed", one("SELECT COUNT(*) FROM lms_attendance WHERE session_id=? AND "
                                                  "user_id=?", (SE, E1)) == 1)
    sp = body(CL.get("/admin/learning/sessions/%d" % SE))
    s.check("its page: who completed it, and no room screen, trainer's link or T3", "Who completed it" in sp and
            "Open the room screen" not in sp and "The trainer's link" not in sp and "Print the T3" not in sp)
    ok, msg = call(a.lms_close_session, u_(LND), SE)
    s.check("closing: the marked one attended with the hours", ok and H.rows(
        a, "SELECT outcome, hours FROM lms_registrations WHERE id=?", (RE1,))[0][:] == ("attended", 6.0), msg)
    s.check("...the other not counted, never absent", H.rows(a, "SELECT outcome FROM lms_registrations WHERE id=?",
                                                             (RE2,))[0][0] is None and not one(
        "SELECT COUNT(*) FROM lms_absences WHERE registration_id=?", (RE2,)), msg)
    fp = body(H.client_as(a, E3).get("/learning?view=mine&tab=find"))
    up = fp.split('id="up-%d"' % REF)[1][:1500] if 'id="up-%d"' % REF in fp else ""
    s.check("the person's card says complete it online, not scan the QR", "complete it online" in up and
            "scan the QR" not in up, up[:300])
    ics = H.client_as(a, E3).get("/learning/ics/%d" % REF).get_data(as_text=True)
    s.check("...and its calendar file too", "e-learning course" in ics and "QR" not in ics)

    s.section("L&D's admin gaps")
    ok, msg = call(a.lms_programme_status, u_(LND), P, "draft")
    s.check("a programme with a run to come can't be withdrawn", not ok and "still to come" in msg, msg)
    ok, msg = call(a.lms_programme_status, u_(LND), P, "archived")
    s.check("...nor archived", not ok, msg)
    ok, msg = call(a.lms_programme_status, u_(LND), PH, "archived")
    s.check("...one whose runs are over can", ok, msg)
    CL.post("/admin/learning/programmes", data={"csrf_token": "tok", "action": "save", "title": "ZZLP Units Only",
                                                "kind": "inhouse", "companies": [CO, "ZZLP Not A Unit"]})
    aud = a.lms_audience(one("SELECT audience_json FROM lms_programmes WHERE title='ZZLP Units Only'"))
    s.check("the audience keeps the units ticked, listed ones only", aud["companies"] == [CO], aud)
    pg = body(CL.get("/admin/learning/programmes"))
    s.check("...and the form lists them", 'name="companies"' in pg)
    with a.app.app_context():
        _k = a.get_db().execute("SELECT value FROM app_settings WHERE key='lms_chains'").fetchone()
    keep = _k[0] if _k else None
    try:
        CL.post("/admin/learning/settings", data={"csrf_token": "tok", "action": "chain", "kind": "elearning"})
        s.check("a chain with no steps isn't saved without its tick", call(a.lms_chains)["elearning"]["levels"])
        CL.post("/admin/learning/settings", data={"csrf_token": "tok", "action": "chain", "kind": "elearning",
                                                  "none_ok": "1"})
        s.check("...with it, it is", call(a.lms_chains)["elearning"]["levels"] == [])
    finally:
        with a.app.app_context():
            d = a.get_db()
            if keep is None:
                d.execute("DELETE FROM app_settings WHERE key='lms_chains'")
            else:
                d.execute("UPDATE app_settings SET value=? WHERE key='lms_chains'", (keep,))
            d.commit()
    with a.app.test_request_context():
        d = a.get_db()
        a.lms_session_save(d, u_(LND), PE, {"starts_on": D(60), "ends_on": D(60), "trainer_s": "ZZLP Run Trainer",
                                            "trainer_email_s": "run@zzlp.invalid"})
        a.lms_session_save(d, u_(LND), PE, {"starts_on": D(61), "ends_on": D(61)})
        sids = [r[0] for r in d.execute("SELECT id FROM lms_sessions WHERE programme_id=? AND starts_on IN (?,?) ORDER "
                                        "BY starts_on", (PE, D(60), D(61)))]
        t1, t2 = (a._lms_session_row(d, x)["trainer"] for x in sids)
        e1 = a._lms_session_row(d, sids[0])["trainer_email"]
    s.check("a run's own trainer, else the programme's", (t1, e1, t2) == ("ZZLP Run Trainer", "run@zzlp.invalid",
                                                                          "ZZLP Programme Trainer"), (t1, e1, t2))
    with a.app.test_request_context():
        d = a.get_db()
        a.lms_session_edit(d, u_(LND), sids[0], {"starts_on": D(60), "ends_on": D(60), "venue": "ZZLP Room 2"})
        kept = a._lms_session_row(d, sids[0])["trainer"]
        a.lms_session_edit(d, u_(LND), sids[0], {"starts_on": D(60), "ends_on": D(60), "trainer_s": ""})
        back = a._lms_session_row(d, sids[0])["trainer"]
    s.check("...an edit that doesn't send it keeps it; one that clears it falls back", kept == "ZZLP Run Trainer" and
            back == "ZZLP Programme Trainer", (kept, back))
    hp = body(CL.get("/admin/learning/hrdc?edit=claim&s=%d&bg=%s" % (SH, BG)))
    s.check("a JD14 claim on a session 200 days back still opens to edit", 'name="step"' in hp and "ZZLP Old HRDC" in hp)

    s.section("nomination rounds")
    a.mailer.is_configured = lambda: True
    ob0, ls0 = one("SELECT COALESCE(MAX(id), 0) FROM email_outbox"), one("SELECT COALESCE(MAX(id), 0) FROM lms_sent")
    try:
        with a.app.test_request_context():
            a.lms_mail_due(a.get_db(), a._now_myt())
        refs = {r[0] for r in H.rows(a, "SELECT ref FROM lms_sent WHERE kind='round' AND user_id=?", (HOD,))}
        s.check("every open round emails the HOD", {"round:%d:closing" % RD1, "round:%d:open" % RD2} <= refs, refs)
        r = H.client_as(a, HOD).post("/learning/nominate", data={"csrf_token": "tok", "round_id": str(RD1),
                                                                "nobody": "1"})
        s.check("the HOD says nobody this round", HOD in call(a.lms_round_answered, RD1))
        dv = body(H.client_as(a, HOD).get("/learning?view=dept&tab=dept"))
        s.check("...their round says so", "You said nobody from your department goes this round" in dv)
        with a.app.app_context():
            d = a.get_db()
            d.execute("DELETE FROM lms_sent WHERE kind='round' AND user_id=?", (HOD,))
            d.commit()
        with a.app.test_request_context():
            a.lms_mail_due(a.get_db(), a._now_myt())
        refs = {r[0] for r in H.rows(a, "SELECT ref FROM lms_sent WHERE kind='round' AND user_id=?", (HOD,))}
        s.check("...so the closing reminder skips them; the other round still emails", "round:%d:closing" % RD1 not in
                refs and "round:%d:open" % RD2 in refs, refs)
        with a.app.app_context():
            d = a.get_db()
            d.execute("DELETE FROM lms_sent WHERE kind='round' AND user_id=?", (HOD,))
            d.commit()
        _off0 = a.leader_learn_off
        a.leader_learn_off = lambda u, ab, db=None: "off" if (ab == "hod.learn_round" and u["id"] == HOD) else \
            _off0(u, ab, db)
        try:
            with a.app.test_request_context():
                a.lms_mail_due(a.get_db(), a._now_myt())
        finally:
            a.leader_learn_off = _off0
        s.check("an HOD with the round's ability off gets none", not one(
            "SELECT COUNT(*) FROM lms_sent WHERE kind='round' AND user_id=?", (HOD,)))
    finally:
        a.mailer.is_configured = _MAIL0
        exe("DELETE FROM email_outbox WHERE id>?", (ob0,))
        exe("DELETE FROM lms_sent WHERE id>?", (ls0,))
    s.section("the Needs page's counts open their people")
    _pn0 = a.lms_population_needs
    a.lms_population_needs = lambda db, people: {u: ({K: {"plan"}} if u in (E1, E2) else {}) for u in people}
    try:
        CS = H.client_as(a, SU["id"])
        lst = body(CS.get("/admin/list/lms-need?fragment=1&bg=%s" % BG))
        s.check("the people with a need, with what and from where", "ZZ LP E1" in lst and "ZZ LP E2" in lst and
                "ZZ LP E3" not in lst and "Career Plan goal" in lst, lst[:400])
        s.check("...the Career Plan count too", "ZZ LP E1" in body(CS.get("/admin/list/lms-plan?fragment=1&bg=%s" % BG)))
        np_ = body(CS.get("/admin/learning/needs?bg=%s" % BG))
        s.check("the tiles open them on the page", 'data-list-open="/admin/list/lms-need?' in np_ and
                'data-list-open="/admin/list/lms-plan?' in np_)
        s.check("...the super admin's only", 'data-list-open' not in body(CL.get("/admin/learning/needs")) and
                CL.get("/admin/list/lms-need?fragment=1").status_code in (302, 403, 404))
    finally:
        a.lms_population_needs = _pn0
    import inspect
    src_ceo = inspect.getsource(a.dash_ceo_learning)
    s.check("the CEO cards count Learning's own population", "calibration_population_sql()" not in src_ceo and
            src_ceo.count("_lms_population_sql()") == 2 and 'urole_allows_sql' in inspect.getsource(a._lms_population_sql))

    s.section("copy")
    with a.app.app_context():
        line = a._lms_session_line({"starts_on": D(40), "ends_on": D(40), "seats": 20, "taken": 2})
        cap = a._lms_session_line({"starts_on": D(40), "ends_on": D(40), "seats": 20})
        opens = [x["line"] for x in a.lms_open_sessions(a.get_db()) if x["id"] == S]
    s.check("seats as staff see them: 18 left of 20", line.endswith("18 left of 20") and cap.endswith("20 seats") and
            opens and " left of " in opens[0], (line, opens))
    sh = open(os.path.join(H.REPO, "templates", "learning", "shell.html"), encoding="utf-8").read()
    s.check("withdrawing is until the day before; the note only if written; L&D's reports read the XP",
            "until the session starts" not in sh and "until the day before it starts" in sh and
            "they see your note.\"" not in sh and "if you write one" in sh and "Group People L&amp;D's reports" in sh)

    s.section("approval emails")
    a.mailer.is_configured = lambda: True
    ob0, ls0 = one("SELECT COALESCE(MAX(id), 0) FROM email_outbox"), one("SELECT COALESCE(MAX(id), 0) FROM lms_sent")
    _due0, _off0 = a._lms_level_due, a.leader_learn_off
    try:
        exe("UPDATE users SET email='zz9lp-mgr@zzlp.invalid' WHERE id=?", (MGR,))
        ok, msg, RA = call(a.lms_register, u_(E1), S)
        a._lms_level_due = lambda reg: TODAY if reg["id"] == RA else _due0(reg)
        with a.app.test_request_context():
            a.lms_mail_due(a.get_db(), a._now_myt())
        b1 = (H.rows(a, "SELECT body FROM email_outbox WHERE to_email='zz9lp-mgr@zzlp.invalid' AND subject LIKE "
                        "'Approve by%' ORDER BY id DESC LIMIT 1") or [[""]])[0][0]
        s.check("the reminder links the line manager's Team, and says it passes on", "view=team" in b1 and
                "passes to the next person up" in b1, (ok, msg, b1[-500:]))
        ch = json.loads(one("SELECT chain_json FROM lms_registrations WHERE id=?", (RA,)))
        ch[0]["escalate"] = None
        exe("UPDATE lms_registrations SET chain_json=? WHERE id=?", (json.dumps(ch), RA))
        exe("DELETE FROM lms_sent WHERE kind='approve_remind' AND user_id=?", (MGR,))
        with a.app.test_request_context():
            a.lms_mail_due(a.get_db(), a._now_myt())
        b2 = (H.rows(a, "SELECT body FROM email_outbox WHERE to_email='zz9lp-mgr@zzlp.invalid' AND subject LIKE "
                        "'Approve by%' ORDER BY id DESC LIMIT 1") or [[""]])[0][0]
        s.check("...a step that doesn't escalate: just the day to decide by", "Please decide it by" in b2 and
                "passes to the next person up" not in b2)
        exe("DELETE FROM lms_sent WHERE kind='approve_remind' AND user_id=?", (MGR,))
        n0 = one("SELECT COUNT(*) FROM email_outbox WHERE to_email='zz9lp-mgr@zzlp.invalid'")
        a.leader_learn_off = lambda u, ab, db=None: "off" if (ab == "lm.learn_approve" and u["id"] == MGR) else \
            _off0(u, ab, db)
        with a.app.test_request_context():
            a.lms_mail_due(a.get_db(), a._now_myt())
        s.check("a line manager whose approving is off isn't emailed about it", one(
            "SELECT COUNT(*) FROM email_outbox WHERE to_email='zz9lp-mgr@zzlp.invalid'") == n0)
    finally:
        a._lms_level_due, a.leader_learn_off = _due0, _off0

    s.section("the check-in email")
    try:
        exe("UPDATE users SET email='zz9lp-e5@zzlp.invalid' WHERE id=?", (E5,))
        exe("INSERT OR REPLACE INTO lms_email_settings(kind, enabled, subject, intro) VALUES ('m3', 1, "
            "'ZZLP: how is {programme} going?', 'ZZLP: a word from Group People L&D.')")
        with a.app.test_request_context():
            a.lms_auto(a.get_db())
        b5 = H.rows(a, "SELECT subject, body FROM email_outbox WHERE to_email='zz9lp-e5@zzlp.invalid' ORDER BY id DESC "
                       "LIMIT 1")
        s.check("it takes L&D's own words for its kind", b5 and b5[0][0] == "ZZLP: how is ZZLP Old Six going?" and
                "a word from Group People L" in b5[0][1], [tuple(x)[:1] for x in b5])
        exe("UPDATE lms_evaluations SET nudged_at=NULL WHERE registration_id=?", (R6,))
        exe("UPDATE lms_email_settings SET enabled=0 WHERE kind='m3'")
        n5 = one("SELECT COUNT(*) FROM email_outbox WHERE to_email='zz9lp-e5@zzlp.invalid'")
        with a.app.test_request_context():
            a.lms_auto(a.get_db())
        s.check("...and none while its kind is switched off", one(
            "SELECT COUNT(*) FROM email_outbox WHERE to_email='zz9lp-e5@zzlp.invalid'") == n5)
    finally:
        exe("DELETE FROM lms_email_settings WHERE kind='m3' AND subject LIKE 'ZZLP%'")
        a.mailer.is_configured = _MAIL0
        exe("DELETE FROM email_outbox WHERE id>?", (ob0,))
        exe("DELETE FROM lms_sent WHERE id>?", (ls0,))
finally:
    a.lms_person_needs, a.cycle_awaiting_open, a.ai_draft.screen_message = _NEEDS0, _AWAIT0, _SCREEN0
    if _ENV0 is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = _ENV0
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
