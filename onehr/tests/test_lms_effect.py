"""AI+ Learning, phase 3 slice 7: Learning > Effectiveness (plan OneHR/AI+ LMS/AI+ LMS plan 2026-10-20.md §4.6, canvas
[design canvas link removed] board 11).

What this suite holds:
  * dark without ONEHR_LMS; a tab of Learning in the admin menu
  * per business group, from courses OneHR ran that ended in the last six months: who came, rated it on the day, did
    the 1-month check-in, and had the 3-month one acted on by their manager, each against those due so far, matched
    against independent counts; a course outside the window counts for nothing
  * per programme: runs, the day-0 rating, Gold at 4.5 from five ratings or more (two 5s are not Gold), applied at 3
    months (confirmed), and how many people need what it builds
  * a BG admin sees their own group only, and can't write the read; the page is every admin's to read
  * the AI read: a finding with a number the facts don't hold is dropped, so is a quote that isn't word for word, and
    a quote from a programme with fewer than five comments; the facts carry no comments for such a programme
  * the ISO evidence download: one row per person per course, where each check-in stands, and never their rating
Everything here is synthetic (ZZLV / ZZ9LV-) and removed at the end.
"""
import io
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning, phase 3: Effectiveness")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BGA_, BGB_ = "ZZLV Alpha", "ZZLV Beta"
_ENV0 = os.environ.get("ONEHR_LMS")
import ai_draft  # noqa: E402


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LV-%' OR username LIKE 'zzlv-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLV %'")
    db.execute("DELETE FROM lms_reads WHERE scope_key LIKE 'eff|%'")
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM lms_registrations WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE detail LIKE '%ZZLV%'")
    db.execute("DELETE FROM org_units WHERE business_group IN (?, ?)", (BGA_, BGB_))
    db.commit()


def person(db, eid, bg):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?, "
                      "'ZZLV Ops', 'ZZLV Officer', '15', '2020-01-01')",
                      (eid.lower(), "ZZ LV " + eid.split("-")[1], eid, bg, bg + " U1")).lastrowid


COMMENTS = ["More hands-on drill, please", "The spill drill was the best part", "Too much slide reading",
            "Wanted more practice with the kit", "Good trainer, short on practice", "More drills next time"]
with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    TODAY = a._today_myt()
    D = lambda n: (TODAY + timedelta(days=n)).isoformat()   # noqa: E731
    for b in (BGA_, BGB_):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (b, b + " U1"))
    A = [person(db, "ZZ9LV-A%d" % i, BGA_) for i in range(1, 7)]      # six in Alpha
    B = [person(db, "ZZ9LV-B%d" % i, BGB_) for i in range(1, 3)]      # two in Beta
    BGADM = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                       "('zzlv-adm', 'ZZ LV Alpha admin', 'x', 'admin', ?)", (BGA_,)).lastrowid
    P1 = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days) VALUES "
                    "('ZZLV Chemical Handling', 'inhouse', 'published', 7, 1)").lastrowid
    P2 = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days) VALUES "
                    "('ZZLV Excel Basics', 'inhouse', 'published', 7, 1)").lastrowid

    def sess(pid, end):
        return db.execute("INSERT INTO lms_sessions(programme_id, starts_on, ends_on) VALUES (?,?,?)",
                          (pid, end, end)).lastrowid
    S1 = sess(P1, D(-100))     # in the window; its 1- and 3-month check-ins are due
    S2 = sess(P2, D(-40))      # in the window; the 1-month one is due
    S_OLD = sess(P1, D(-250))  # outside the window

    def reg(uid, sid, overall=None, comment=None, outcome="attended"):
        rid = db.execute("INSERT INTO lms_registrations(user_id, session_id, status, outcome, hours, chain_json) VALUES "
                         "(?,?, 'approved', ?, 7, '[]')", (uid, sid, outcome)).lastrowid
        if overall:
            db.execute("INSERT INTO lms_ratings(registration_id, relevant, clear, apply, overall, comment) VALUES "
                       "(?,5,5,5,?,?)", (rid, overall, comment))
        return rid
    R1 = [reg(uid, S1, 5 if i < 5 else 4, COMMENTS[i]) for i, uid in enumerate(A)]   # mean 4.8 from 6: Gold
    R2 = [reg(uid, S2, 5) for uid in B]                                              # 5.0 from 2: not Gold
    reg(A[0], S_OLD, 1, "outside the window")
    reg(B[0], S1, None, None, outcome="absent")
    # the check-ins: two of Alpha's 1-month done; one 3-month confirmed, one kept (acted on, not applied)
    for rid, k, st in ((R1[0], "m1", "done"), (R1[1], "m1", "done"), (R1[0], "m3", "confirmed"), (R1[2], "m3", "kept")):
        db.execute("INSERT INTO lms_evaluations(registration_id, kind, due_on, status) VALUES (?,?,?,?)",
                   (rid, k, D(-1), st))
    db.commit()


def one(sql, args=()):
    return H.one(a, sql, args)


def env(v):
    if v is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = v


def eff_for(uid):
    with a.app.test_request_context():
        db = a.get_db()
        return a.lms_effectiveness(db, a._lms_user(db, uid))


real_cfg, real_read = ai_draft.is_configured, ai_draft.lms_eval_read
try:
    s.section("dark, and its tab")
    env(None)
    CS = H.client_as(a, SU["id"])
    s.check("a 404 without ONEHR_LMS", CS.get("/admin/learning/effectiveness").status_code == 404)
    env("1")
    page = CS.get("/admin/learning/effectiveness").get_data(as_text=True)
    s.check("on: it opens, a tab of Learning", "Programmes to look at" in page and ">Effectiveness<" in page)
    s.check("classified: the read is the L&D admin's ('lms'); the page every admin's to read",
            a.ADMIN_ACCESS_MAP.get("admin_learning_effectiveness_read") == "lms" and
            a._ACCESS_PAGE_MODULE.get("admin_learning_effectiveness", 0) is None)

    s.section("by business group")
    e = eff_for(SU["id"])
    bg = {b["bg"]: b for b in e["bgs"] if b["bg"] in (BGA_, BGB_)}
    s.check("Alpha: 6 came (the course outside the window doesn't count), 6 rated", (bg[BGA_]["came"], bg[BGA_]["rated"])
            == (6, 6), bg.get(BGA_))
    s.check("...1-month: 2 done of 6 due; 3 months: 2 acted on of 6 due",
            (bg[BGA_]["m1_done"], bg[BGA_]["m1_due"], bg[BGA_]["m3_done"], bg[BGA_]["m3_due"]) == (2, 6, 2, 6), bg[BGA_])
    s.check("Beta: 2 came (the absent one doesn't count), 1-month due for both, no 3-month yet",
            (bg[BGB_]["came"], bg[BGB_]["m1_due"], bg[BGB_]["m3_due"]) == (2, 2, 0), bg[BGB_])
    ind = one("SELECT COUNT(*) FROM lms_registrations r JOIN users u ON u.id=r.user_id JOIN lms_sessions s ON "
              "s.id=r.session_id WHERE u.business_group=? AND r.status='approved' AND r.outcome IN ('attended','partial') "
              "AND s.ends_on>=?", (BGA_, a._lms_add_months(TODAY, -6).isoformat()))
    s.check("...as an independent count", ind == bg[BGA_]["came"], ind)

    s.section("by programme")
    pr = {p["title"]: p for p in e["progs"]}
    p1, p2 = pr["ZZLV Chemical Handling"], pr["ZZLV Excel Basics"]
    s.check("Chemical Handling: 1 run in the window, 4.8 from 6 ratings: Gold", (p1["runs"], p1["mean"], p1["n_rated"],
                                                                               p1["gold"]) == (1, 4.8, 6, True), p1)
    s.check("...applied at 3 months: 1 of 6 (the kept one isn't applied)", (p1["applied"], p1["m3_due"]) == (1, 6))
    s.check("Excel Basics: 5.0 from 2 ratings is not Gold (five or more)", (p2["mean"], p2["gold"]) == (5.0, False))
    s.check("the page shows Gold and the rule", "4.8 Gold" in page and "4.5 and above from 5 ratings" in page)

    s.section("a BG admin")
    CB = H.client_as(a, BGADM)
    eb = eff_for(BGADM)
    s.check("sees their own group only", [b["bg"] for b in eb["bgs"]] == [BGA_] and eb["scope"].startswith("ZZLV"),
            [b["bg"] for b in eb["bgs"]])
    s.check("...can't write the read", CB.post("/admin/learning/effectiveness/read",
                                               data={"csrf_token": "tok"}).status_code == 403)
    s.check("...but reads the page", CB.get("/admin/learning/effectiveness").status_code == 200)

    s.section("the AI read")
    facts = a._lms_eff_facts(e)
    s.check("the facts quote Chemical Handling's comments (six of them)", "More hands-on drill, please" in facts)
    s.check("...and none for Excel Basics (two ratings, no comments to quote)", "Excel Basics" in facts and
            facts.split("ZZLV Excel Basics")[1].split("\n")[0].count('"') == 0)
    found = ["ZZLV Chemical Handling is Gold at 4.8, yet only 1 of 6 applied it at 3 months.",          # kept
             "ZZLV Chemical Handling: participants asked for \"More hands-on drill, please\".",          # kept
             "ZZLV Excel Basics rated 4.9 across 12 runs.",                                             # numbers invented
             "ZZLV Chemical Handling comments ask for \"a longer lunch\".",                             # quote invented
             ]
    kept = a._lms_eff_kept(found, e, facts)
    s.check("a finding holding to the facts is kept, word-for-word quotes too", kept == found[:2], kept)
    e2 = dict(e, progs=[dict(p, comments=p["comments"][:3]) if p["title"] == "ZZLV Chemical Handling" else p
                        for p in e["progs"]])
    s.check("...a quote from a programme with fewer than five comments is dropped",
            a._lms_eff_kept([found[1]], e2, a._lms_eff_facts(e2)) == [])
    ai_draft.is_configured = lambda: True
    ai_draft.lms_eval_read = lambda f, **kw: found
    r = CS.post("/admin/learning/effectiveness/read", data={"csrf_token": "tok"}, follow_redirects=True)
    page = r.get_data(as_text=True)
    s.check("written from the page: the two that hold, not the two that don't",
            "only 1 of 6 applied it" in page and "a longer lunch" not in page and "12 runs" not in page)
    s.check("...cached for the scope, and logged", one("SELECT COUNT(*) FROM lms_reads WHERE scope_key='eff|'") == 1 and
            one("SELECT COUNT(*) FROM activity_log WHERE action='lms_eff_read'") >= 1)
    s.check("the button is double-confirmed", re.search(r'action="/admin/learning/effectiveness/read"[^>]*data-confirm=',
                                                        page))
    ai_draft.is_configured, ai_draft.lms_eval_read = real_cfg, real_read

    s.section("the ISO evidence download")
    r = CS.get("/admin/learning/effectiveness?format=xlsx")
    import openpyxl  # noqa: E402
    ws = openpyxl.load_workbook(io.BytesIO(r.data)).active
    rows = [[c.value for c in row] for row in ws.iter_rows(min_row=2)]
    mine = [x for x in rows if (x[0] or "").startswith("ZZ9LV-")]
    s.check("one row per person per course in the window (8)", r.status_code == 200 and len(mine) == 8, len(mine))
    a1 = next(x for x in mine if x[0] == "ZZ9LV-A1")
    s.check("...where each check-in stands, 1 and 3 months (no 6-month column, 2026-10-23)", a1[9] == "Done" and
            a1[10] == "Applied (confirmed)" and len(a1) == 11, a1)
    a3 = next(x for x in mine if x[0] == "ZZ9LV-A3")
    s.check("...open, kept", a3[9] == "Open" and a3[10] == "Not applied yet (kept)", a3)
    flat = " ".join(str(c) for x in mine for c in x)
    s.check("...never their rating or comment", "hands-on drill" not in flat and "4.8" not in flat and
            "Rated on the day" in [c.value for c in ws[1]])
    rb = CB.get("/admin/learning/effectiveness?format=xlsx")
    wb = openpyxl.load_workbook(io.BytesIO(rb.data)).active
    with a.app.test_request_context():
        alpha = a.display_bg(BGA_)
    got = {row[2].value for row in wb.iter_rows(min_row=2)}
    s.check("a BG admin's download: their group only", got == {alpha}, got)
finally:
    ai_draft.is_configured, ai_draft.lms_eval_read = real_cfg, real_read
    env(_ENV0)
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
sys.exit(s.done())
