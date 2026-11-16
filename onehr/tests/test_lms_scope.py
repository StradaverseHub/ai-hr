"""AI+ Learning's gap check, wave 2 (2026-10-23): who sees what. Chris's call of 23 Oct: a line manager's or HOD's
nomination outside a programme's audience is allowed with a reason.

What this suite holds:
  * the session page's "Withdrawals and the waiting list": a BG admin sees their group's lines, a BU admin their units'
    only, L&D everyone's
  * a nomination outside the audience: refused without a reason, kept with one and marked, shown to L&D as "not in its
    audience"; inside it, no reason needed; an employee still can't ask for one outside it; an HOD's round lets them
    be ticked, and its reason goes only on the requests outside the audience
  * announcing reaches only people the programme is open to, and says how many it left out
  * a BU admin's Effectiveness and its evidence Excel cover their units only; a BG admin's their group
  * a session's averages show from 3 ratings, its comments from 5; a programme's rating from 3
  * the clock-in and clock-out codes: 10 wrong in 10 minutes, then paused, a right code included; a signed-out scan
    counts against its address
Everything here is synthetic (ZZLS / ZZ9LS-) and removed at the end.
"""
import html
import json
import os
import sys
import time
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning gap check, wave 2: who sees what")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, U1, U2, OBG = "ZZLS Group", "ZZLS U1", "ZZLS U2", "ZZLS Other"
_ENV0 = os.environ.get("ONEHR_LMS")
TODAY = a._today_myt()


def D(n):
    return (TODAY + timedelta(days=n)).isoformat()


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LS-%' OR username LIKE 'zzls-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLS %'")
    db.execute("DELETE FROM lms_rounds WHERE title LIKE 'ZZLS %'")
    db.execute("DELETE FROM lms_code_tries WHERE who LIKE 'zzls:%'")
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM lms_code_tries WHERE who IN (%s)" % ph, ["u:%d" % u_ for u_ in ul])
        for t in ("lms_registrations", "email_outbox", "lms_attendance"):
            db.execute("DELETE FROM %s WHERE user_id IN (%s)" % (t, ph), ul)
        db.execute("DELETE FROM admin_companies WHERE admin_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group IN (?, ?)", (BG, OBG))
    db.commit()


def person(db, eid, co=U1, mgr=None, hod=None, bg=BG, grade="15"):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, manager_id, hod_id, confirmation_date, email) VALUES "
                      "(?,?, 'x', 'user', ?,?,?, 'ZZLS Sales', 'ZZLS Officer', ?, ?, ?, '2020-01-01', ?)",
                      (eid.lower(), "ZZ LS " + eid.split("-")[1], eid, bg, co, grade, mgr, hod,
                       eid.lower() + "@zzls.test")).lastrowid


def admin(db, uname, bg, units=()):
    uid = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES (?, ?, 'x', 'admin', ?)",
                     (uname, "ZZ LS " + uname, bg)).lastrowid
    for c in units:
        db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?, ?)", (uid, c))
    return uid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    for b_, c_ in ((BG, U1), (BG, U2), (OBG, "ZZLS O1")):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (b_, c_))
    HOD = person(db, "ZZ9LS-HOD")
    MGR = person(db, "ZZ9LS-MGR", hod=HOD)
    E = {k: person(db, "ZZ9LS-" + k, U1, MGR, HOD) for k in ("A", "B", "C", "D", "F", "G")}
    SENIOR = person(db, "ZZ9LS-SNR", U1, MGR, HOD, grade="19")
    SENIOR2 = person(db, "ZZ9LS-SNR2", U2, MGR, HOD, grade="20")
    V = {k: person(db, "ZZ9LS-" + k, U2, MGR, HOD) for k in ("V1", "V2", "V3")}
    OUT = person(db, "ZZ9LS-OUT", "ZZLS O1", bg=OBG)
    LND = admin(db, "zzls-lnd", a.LMS_ADMIN_BG)
    BGA = admin(db, "zzls-bga", BG)
    BUA = admin(db, "zzls-bua", BG, (U1,))
    SENIOR_ONLY = json.dumps({"grade_min": 18})

    def prog(title, kind="inhouse", aud=None):
        return db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days, audience_json) VALUES "
                          "(?, ?, 'published', 7, 1, ?)", (title, kind, aud)).lastrowid

    def sess(pid, day, seats=None, times=("09:00", "17:00")):
        return db.execute("INSERT INTO lms_sessions(programme_id, starts_on, ends_on, start_time, end_time, venue, seats, "
                          "needs_out, reg_cutoff) VALUES (?,?,?,?,?, 'ZZLS Room', ?, 1, ?)",
                          (pid, D(day), D(day), times[0], times[1], seats, D(day - 20))).lastrowid
    P_ALL, P_SNR, P_EXT = prog("ZZLS Basics"), prog("ZZLS Leading", aud=SENIOR_ONLY), \
        prog("ZZLS Strategy", "external", SENIOR_ONLY)
    S_ALL, S_SNR, S_EXT = sess(P_ALL, 40), sess(P_SNR, 45), sess(P_EXT, 50)
    S_LOG = sess(P_ALL, 60)
    S_TODAY = sess(P_ALL, 0, times=("00:00", "23:59"))
    S_PAST = sess(P_ALL, -10)
    RD = db.execute("INSERT INTO lms_rounds(title, closes_on) VALUES ('ZZLS Q1 round', ?)", (D(20),)).lastrowid
    db.execute("INSERT INTO lms_round_sessions(round_id, session_id) VALUES (?, ?)", (RD, S_SNR))
    db.execute("INSERT INTO lms_round_sessions(round_id, session_id) VALUES (?, ?)", (RD, S_ALL))
    db.commit()


def one(sql, args=()):
    return H.one(a, sql, args)


def u_(uid):
    with a.app.app_context():
        return dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def call(fn, *args, **kw):
    with a.app.test_request_context():
        return fn(a.get_db(), *args, **kw)


def page(uid, url):
    return html.unescape(H.client_as(a, uid).get(url).get_data(as_text=True))


def exe(sql, args=()):
    with a.app.app_context():
        d = a.get_db()
        cur = d.execute(sql, args)
        d.commit()
        return cur.lastrowid


try:
    os.environ["ONEHR_LMS"] = "1"
    a.ai_draft.screen_message = (lambda m: None)

    s.section("the session page's withdrawals log")
    for uid in (E["A"], V["V1"], OUT):
        rid = exe("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, withdraw_kind) VALUES "
                  "(?, ?, ?, 'withdrawn', 'clash')", (uid, S_LOG, P_ALL))
        exe("INSERT INTO lms_approvals(registration_id, level, role, actor_id, action, remark) VALUES (?, 0, 'self', ?, "
            "'withdrawn', ?)", (rid, uid, "ZZLS reason of %d" % uid))
    pl, pg, pu = (page(x, "/admin/learning/sessions/%d" % S_LOG) for x in (LND, BGA, BUA))
    s.check("L&D sees every line", all("ZZLS reason of %d" % x in pl for x in (E["A"], V["V1"], OUT)))
    s.check("a BG admin sees their group's lines, not another group's",
            "ZZLS reason of %d" % E["A"] in pg and "ZZLS reason of %d" % V["V1"] in pg and
            "ZZLS reason of %d" % OUT not in pg and "ZZ LS OUT" not in pg)
    s.check("a BU admin sees their units' lines only", "ZZLS reason of %d" % E["A"] in pu and
            "ZZLS reason of %d" % V["V1"] not in pu and "ZZ LS V1" not in pu and "ZZLS reason of %d" % OUT not in pu)

    s.section("a nomination outside the audience")
    ok, msg = call(a.lms_nominate, u_(MGR), [(S_SNR, E["A"])])
    s.check("a line manager's, with no reason: refused, saying why", not ok and "isn't in this programme's audience"
            in msg and "JG 18" in msg and not one("SELECT COUNT(*) FROM lms_registrations WHERE user_id=? AND "
                                                  "session_id=?", (E["A"], S_SNR)), msg)
    r = H.client_as(a, MGR).post("/learning/nominate", data={"csrf_token": "tok", "user_id": str(E["A"]),
                                                             "session_id": str(S_SNR),
                                                             "why": "ZZLS: runs the Klang line while the manager is away"})
    reg = H.rows(a, "SELECT * FROM lms_registrations WHERE user_id=? AND session_id=?", (E["A"], S_SNR))
    s.check("...with the reason (the form's Why): made, marked and kept", r.status_code == 302 and len(reg) == 1 and
            reg[0]["off_audience"] == 1 and "Klang line" in (reg[0]["why"] or "") and reg[0]["nomination"] == "manager",
            [dict(x) for x in reg])
    ok, msg = call(a.lms_nominate, u_(MGR), [(S_ALL, E["B"])])
    s.check("inside the audience: no reason needed, not marked", ok and one(
        "SELECT COALESCE(off_audience, 0) FROM lms_registrations WHERE user_id=? AND session_id=?", (E["B"], S_ALL)) == 0,
            msg)
    ok, msg = call(a.lms_nominate, u_(MGR), [(S_SNR, SENIOR)])
    s.check("someone in its audience needs no reason either", ok and one(
        "SELECT COALESCE(off_audience, 0) FROM lms_registrations WHERE user_id=? AND session_id=?", (SENIOR, S_SNR)) == 0,
            msg)
    ok, msg, _rid = call(a.lms_register, u_(E["C"]), S_SNR, why="I want to")
    s.check("an employee still can't ask for one outside it", not ok and "isn't open to you" in msg, msg)
    ok, msg = call(a.lms_nominate, u_(MGR), [(S_EXT, E["C"])], why="ZZLS: leads the pricing review next year")
    rx = one("SELECT id FROM lms_registrations WHERE user_id=? AND session_id=?", (E["C"], S_EXT))
    s.check("on a chain with L&D's steps after the line manager's, it waits on L&D", ok and rx and
            one("SELECT status FROM lms_registrations WHERE id=?", (rx,)) == "pending", msg)
    pl = page(LND, "/admin/learning/requests")
    s.check("...and L&D's Requests shows it, with the reason", "leads the pricing review" in pl)
    s.check("...the marker shows", "not in its audience" in pl.split("leads the pricing review")[0][-1500:])

    s.section("an HOD's round")
    dv = page(HOD, "/learning?view=dept&tab=dept")
    s.check("the round lists people outside the audience, tickable, asking for the reason",
            'value="%d:%d"' % (S_SNR, E["D"]) in dv and 'value="%d:%d" disabled' % (S_SNR, E["D"]) not in dv and
            "give the reason below" in dv and 'name="why"' in dv)
    ok, msg = call(a.lms_nominate, u_(HOD), [(S_SNR, E["D"])], round_id=RD)
    s.check("ticked with no reason: refused", not ok and "audience" in msg, msg)
    ok, msg = call(a.lms_nominate, u_(HOD), [(S_SNR, E["D"]), (S_ALL, E["F"])], round_id=RD,
                   why="ZZLS: acting supervisor since August")
    rd_d = H.rows(a, "SELECT * FROM lms_registrations WHERE user_id=? AND session_id=?", (E["D"], S_SNR))
    rd_f = H.rows(a, "SELECT * FROM lms_registrations WHERE user_id=? AND session_id=?", (E["F"], S_ALL))
    s.check("with it: both made", ok and len(rd_d) == 1 and len(rd_f) == 1, msg)
    s.check("...the reason goes on the one outside the audience", rd_d and rd_d[0]["off_audience"] == 1 and
            "acting supervisor" in (rd_d[0]["why"] or ""))
    s.check("...and not on the one inside it", rd_f and not rd_f[0]["why"] and not rd_f[0]["off_audience"])
    tv = page(MGR, "/learning?view=team&tab=plans")
    s.check("the line manager's form asks why", 'name="why"' in tv and "Why them" in tv)

    s.section("announcing")
    with a.app.test_request_context():
        d = a.get_db()
        pick = {"all": False, "bg": [BG], "bu": [], "dept": [], "grade": [], "jf": []}
        people, left_out, not_open = a.lms_announce_audience(d, P_SNR, pick)
        ids = {p["id"] for p in people}
        ours = {E[k] for k in E} | set(V.values()) | {HOD, MGR, SENIOR, SENIOR2}
        s.check("a programme for JG 18 and above reaches only them (one already confirmed is left out)",
                (ids & ours) == {SENIOR2} and left_out >= 1, (ids & ours, left_out))
        s.check("...and counts who it left out for its audience", not_open >= len(ours) - 2, not_open)
        people2, _lo, not2 = a.lms_announce_audience(d, P_ALL, pick)
        s.check("a programme open to everyone leaves nobody out for it", not2 == 0 and
                ours <= {p["id"] for p in people2} | {E["B"], E["F"]})
    ap = page(SU["id"], "/admin/learning/announce?pid=%d&bg=%s" % (P_SNR, BG))
    s.check("the announce page says how many aren't in its audience", "in its audience and won't get it" in ap and
            "The programme is for JG 18 and above" in ap)

    s.section("Effectiveness and its evidence, for a BU admin")
    regs = {}
    for k, uid in (("A", E["A"]), ("B", E["B"]), ("V1", V["V1"]), ("V2", V["V2"])):
        regs[k] = exe("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, outcome, hours) VALUES "
                      "(?, ?, ?, 'approved', 'attended', 7)", (uid, S_PAST, P_ALL))
    with a.app.test_request_context():
        d = a.get_db()
        eff_u = a.lms_effectiveness(d, u_(BUA))
        eff_g = a.lms_effectiveness(d, u_(BGA))
        mine = next((p for p in eff_u["progs"] if p["id"] == P_ALL), None)
        grp = next((p for p in eff_g["progs"] if p["id"] == P_ALL), None)
        came_u = sum(b["came"] for b in eff_u["bgs"])
        came_g = sum(b["came"] for b in eff_g["bgs"])
        s.check("the BU admin's counts are their units' people only", came_u == one(
            "SELECT COUNT(*) FROM lms_registrations r JOIN users u ON u.id=r.user_id JOIN lms_sessions s ON "
            "s.id=r.session_id WHERE r.status='approved' AND r.outcome IN ('attended','partial') AND u.business_group=? "
            "AND u.company=? AND s.ends_on<=? AND s.ends_on>=?", (BG, U1, D(0), D(-200))) and came_u < came_g,
                (came_u, came_g))
        s.check("...its scope says the units, and its read is its own", U1.title().split()[0] in eff_u["scope"] and
                ":" in eff_u["scope"] and eff_u["scope_key"] != eff_g["scope_key"], (eff_u["scope"], eff_u["scope_key"]))
        ev_u = {r[0] for r in a.lms_eff_evidence(d, u_(BUA))}
        ev_g = {r[0] for r in a.lms_eff_evidence(d, u_(BGA))}
        s.check("the evidence Excel: the BU admin's units only", "ZZ9LS-A" in ev_u and "ZZ9LS-V1" not in ev_u and
                {"ZZ9LS-A", "ZZ9LS-V1"} <= ev_g, (sorted(x for x in ev_u if x.startswith("ZZ9LS")),))

    s.section("a session's ratings")
    exe("INSERT INTO lms_ratings(registration_id, relevant, clear, apply, overall, comment) VALUES (?, 5, 5, 4, 5, "
        "'ZZLS one comment')", (regs["A"],))
    sp = page(LND, "/admin/learning/sessions/%d" % S_PAST)
    s.check("one rating: no averages, and no comment", "1 rating so far" in sp and "ZZLS one comment" not in sp and
            'class="lm-tile"' not in sp.split('id="lm-rate-h"')[1])
    with a.app.test_request_context():
        pv = a.lms_programme_view(a.get_db(), u_(E["G"]), P_ALL)
    s.check("...nor on the programme's page", pv["rating"]["avg"] is None and pv["rating"]["n"] == 1, pv["rating"])
    for k in ("B", "V1"):
        exe("INSERT INTO lms_ratings(registration_id, relevant, clear, apply, overall, comment) VALUES (?, 4, 4, 4, 4, "
            "?)", (regs[k], "ZZLS comment " + k))
    sp = page(LND, "/admin/learning/sessions/%d" % S_PAST)
    s.check("three: the averages show", 'class="lm-tile"' in sp.split('id="lm-rate-h"')[1] and "3 ratings" in sp)
    s.check("...the comments wait for five", "ZZLS one comment" not in sp and "once 5 people have written one" in sp)
    with a.app.test_request_context():
        pv = a.lms_programme_view(a.get_db(), u_(E["G"]), P_ALL)
    s.check("...and the programme's page shows its rating", pv["rating"]["avg"] == 4.3 and pv["rating"]["n"] == 3,
            pv["rating"])
    exe("INSERT INTO lms_ratings(registration_id, relevant, clear, apply, overall, comment) VALUES (?, 4, 4, 4, 4, "
        "'ZZLS comment V2')", (regs["V2"],))
    extra = exe("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, outcome) VALUES (?, ?, ?, "
                "'approved', 'attended')", (E["G"], S_PAST, P_ALL))
    exe("INSERT INTO lms_ratings(registration_id, relevant, clear, apply, overall, comment) VALUES (?, 3, 3, 3, 3, "
        "'ZZLS comment G')", (extra,))
    sp = page(LND, "/admin/learning/sessions/%d" % S_PAST)
    s.check("five comments: they show", all(("ZZLS comment " + k) in sp for k in ("B", "V1", "V2", "G")) and
            "ZZLS one comment" in sp)

    s.section("the clock-in and clock-out codes")
    with a.app.app_context():
        sec = a._lms_qr_secret(a.get_db(), S_TODAY)
    w = int(time.time()) // a.LMS_QR_SECONDS
    good_in, good_out = a._lms_code(sec, S_TODAY, w, "in"), a._lms_code(sec, S_TODAY, w, "out")
    bad = "%06d" % ((int(good_in) + 500000) % 1000000)
    if bad == a._lms_code(sec, S_TODAY, w - 1, "in"):
        bad = "%06d" % ((int(bad) + 1) % 1000000)
    with a.app.test_request_context():
        d = a.get_db()
        res = [a.lms_code_try(d, S_TODAY, bad, "in", "zzls:one") for _ in range(a.LMS_CODE_TRIES)]
        s.check("wrong codes are counted", res == ["wrong"] * a.LMS_CODE_TRIES and one(
            "SELECT COUNT(*) FROM lms_code_tries WHERE who='zzls:one'") == a.LMS_CODE_TRIES, res)
        s.check("after %d, even the right code is paused" % a.LMS_CODE_TRIES,
                a.lms_code_try(d, S_TODAY, good_in, "in", "zzls:one") == "blocked")
        s.check("someone else isn't held up", a.lms_code_try(d, S_TODAY, good_in, "in", "zzls:two") == "ok")
        d.execute("UPDATE lms_code_tries SET created_at=datetime('now', '-11 minutes') WHERE who='zzls:one'")
        d.commit()
        s.check("ten minutes on, it works again", a.lms_code_try(d, S_TODAY, good_in, "in", "zzls:one") == "ok")
    cg = H.client_as(a, E["G"])
    for _ in range(a.LMS_CODE_TRIES):
        cg.post("/learning/in/%d" % S_TODAY, data={"csrf_token": "tok", "c": bad})
    r = cg.post("/learning/in/%d" % S_TODAY, data={"csrf_token": "tok", "c": good_in})
    s.check("on the clock-in page: paused, ask the trainer", "Ask the trainer to mark you in" in html.unescape(
        r.get_data(as_text=True)) and not one("SELECT COUNT(*) FROM lms_attendance WHERE session_id=? AND user_id=?",
                                               (S_TODAY, E["G"])))
    r = cg.post("/learning/out/%d" % S_TODAY, data={"csrf_token": "tok", "c": good_out})
    s.check("...and on the clock-out page", "Ask the trainer to mark you out" in html.unescape(r.get_data(as_text=True)))
    cf = H.client_as(a, E["F"])
    r = cf.post("/learning/in/%d" % S_TODAY, data={"csrf_token": "tok", "c": good_in})
    s.check("someone else clocks in as ever", one("SELECT COUNT(*) FROM lms_attendance WHERE session_id=? AND user_id=?",
                                                  (S_TODAY, E["F"])) == 1)
    anon = a.app.test_client()
    with a.app.test_request_context(environ_base={"REMOTE_ADDR": "127.0.0.1"}):
        ip_who = a._lms_code_who()
    n0 = one("SELECT COUNT(*) FROM lms_code_tries WHERE who=?", (ip_who,))
    anon.get("/learning/in/%d?c=%s" % (S_TODAY, bad))
    s.check("a signed-out scan with a wrong code counts against its address", one(
        "SELECT COUNT(*) FROM lms_code_tries WHERE who=?", (ip_who,)) == n0 + 1 and ip_who.startswith("ip:"))
    exe("DELETE FROM lms_code_tries WHERE who=?", (ip_who,))

    s.section("Help and the KB")
    old_ai = ("AI+ Learning is where you find training. Your request goes to your line manager, then any step Group "
              "People L&D sets.")
    old_ld = ("In AI+ Learning, Team is a line manager's view. They can nominate someone for a run, which gives their "
              "own approval. At three months they confirm.")
    with a.app.app_context():
        d = a.get_db()
        keep = {r["slug"]: r["body"] for r in d.execute("SELECT slug, body FROM kb_entries WHERE slug IN "
                                                         "('ai-learning','learning-for-leaders')")}
        d.execute("UPDATE kb_entries SET body=? WHERE slug='ai-learning'", (old_ai,))
        d.execute("UPDATE kb_entries SET body=? WHERE slug='learning-for-leaders'", (old_ld,))
        d.commit()
    a._ensure_runtime_schema()   # what every boot runs
    s.check("the rows seeded with the first wording are reworded once", one(
        "SELECT body FROM kb_entries WHERE slug='ai-learning'") == a._KB_AI_LEARNING_BODY and one(
        "SELECT body FROM kb_entries WHERE slug='learning-for-leaders'") == a._KB_LEARN_LEADERS_BODY)
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE kb_entries SET body='ZZLS an admin edit' WHERE slug='learning-for-leaders'")
        d.commit()
    a._ensure_runtime_schema()
    s.check("...an admin's own edit is never overwritten", one(
        "SELECT body FROM kb_entries WHERE slug='learning-for-leaders'") == "ZZLS an admin edit")
    with a.app.app_context():
        d = a.get_db()
        for slug, body in keep.items():
            d.execute("UPDATE kb_entries SET body=? WHERE slug=?", (body, slug))
        d.commit()
    s.check("the leaders' row and Help say Decline, ticking several, and nominating outside the audience",
            "declines it for good" in a._KB_LEARN_LEADERS_BODY and "isn't open to" in a._KB_LEARN_LEADERS_BODY and
            "decline it for good" in a.HELP_QA["lt_approve"][1] and "isn't open to" in a.HELP_QA["lt_nominate"][1])

    s.section("the schema")
    src = H.source(a)
    ddl = src.split('_LMS_DDL = """')[1].split('"""')[0]
    s.check("lms_code_tries and off_audience are in the Learning DDL and SCHEMA alike",
            "CREATE TABLE IF NOT EXISTS lms_code_tries" in ddl and "off_audience INTEGER" in ddl and
            src.count("CREATE TABLE IF NOT EXISTS lms_code_tries") == 2 and src.count("    off_audience INTEGER") == 2)
finally:
    if _ENV0 is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = _ENV0
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
