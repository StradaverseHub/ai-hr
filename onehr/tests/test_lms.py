"""AI+ Learning, phase 1 (Chris, 2026-10-20: "go ahead and build phase 1 on staging"; plan OneHR/AI+ LMS/AI+ LMS plan
2026-10-20.md, canvas [design canvas link removed]).

What this suite holds:
  * dark unless ONEHR_LMS=1: a signed-in person gets 404 from every Learning page and write, a signed-out one goes on to
    sign-in (the deploy's route probe), the admin menu leaves Learning out and the dashboard keeps "Coming soon"
  * the schema text is the same in SCHEMA and _LMS_DDL; every route is classified (gate, access map)
  * the catalogue: a programme is the super admin's to write (a BG admin reads), its category is picked from a list,
    a competency only from the catalogue at a level it has, a session's cut-off 30 days before day one by default
  * matching: a published programme reaches the person whose Career Plan goal or assessed gap it builds, with the reason
    worked out from the levels; a draft, or a programme outside their audience, never does
  * interest: one row however often it's marked, never for a programme not open to them, a competency of their own
    needs only, exploring capped at lms_explore_cap
  * the needs analysis: a person counted once per competency from SHARED plans (a draft is private), their latest
    assessment's gaps and their interest, Stars counted, a BG admin's scope only, against an independently written count
  * the AI: a proposal's competencies only from the candidates and at a level they have, left unconfirmed; the needs read
    keeps only findings whose numbers the facts hold
Everything here is synthetic (ZZLM / ZZ9LM-) and removed at the end.
"""
import io
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning, phase 1")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
BG, BG2, CO = "ZZLM Group", "ZZLM Other", "ZZLM U1"
_ENV0 = os.environ.get("ONEHR_LMS")


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LM-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLM %' OR source_file LIKE 'zzlm%'")
    db.execute("DELETE FROM lms_reads WHERE scope_key LIKE '%ZZLM%'")
    db.execute("DELETE FROM app_settings WHERE key='lms_explore_cap'")
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM lms_interest WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM tc_scores WHERE assessment_id IN (SELECT id FROM tc_assessments WHERE subject_id IN (%s))"
                   % ph, ul)
        db.execute("DELETE FROM tc_assessments WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM tc_assignments WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_idp_goals WHERE idp_id IN (SELECT id FROM pm_idp WHERE subject_id IN (%s))" % ph, ul)
        db.execute("DELETE FROM pm_idp WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM talent_status_history WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE detail LIKE '%ZZLM%' OR detail LIKE '%zzlm%'")
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZLM-%'")
    db.execute("DELETE FROM org_units WHERE business_group IN (?, ?)", (BG, BG2))
    db.commit()


def person(db, eid, grade, bg=BG, co=CO):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade) VALUES (?,?, 'x', 'user', ?,?,?,?,?,?)",
                      (eid.lower(), "ZZ LM " + eid[-2:], eid, bg, co, "ZZLM Sales", "ZZLM Officer", str(grade))).lastrowid


SK = {}
with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, CO))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG2, "ZZLM U2"))
    for num, title, levels in ((1, "ZZLM Pricing", (3, 4, 5)), (2, "ZZLM Negotiation", (3, 4)),
                               (3, "ZZLM Explore Alpha", (3, 4)), (4, "ZZLM Explore Beta", (3, 4))):
        for lv in levels:
            code = "ZZLM-AAA-%d%03d-1.0" % (lv, num)
            SK[(num, lv)] = db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category, "
                                       "proficiency_description, active) VALUES (?,?,?,?,?,?,1)",
                                       (code, title, lv, "tsc", "ZZLM Cat", "%s at L%d" % (title, lv))).lastrowid
    K1, K2, K3, K4 = "ZZLM-AAA-001", "ZZLM-AAA-002", "ZZLM-AAA-003", "ZZLM-AAA-004"
    E1 = person(db, "ZZ9LM-E1", 15)          # a shared plan: Pricing L3 -> L4; a Star
    E2 = person(db, "ZZ9LM-E2", 15)          # a DRAFT plan (Pricing), and an assessed gap on Negotiation L3
    E3 = person(db, "ZZ9LM-E3", 14, BG2, "ZZLM U2")   # nothing but what they explore
    E4 = person(db, "ZZ9LM-E4", 12)          # a shared plan on Pricing, but under the programme's grades
    cyc = db.execute("SELECT id FROM cycles ORDER BY id DESC LIMIT 1").fetchone()[0]

    def plan(uid, status, num, req, have):
        pid = db.execute("INSERT INTO pm_idp(plan_year, subject_id, status) VALUES (2027, ?, ?)", (uid, status)).lastrowid
        db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area, skill_id, required_level, have_level, gap_kind) "
                   "VALUES (?, 1, ?, ?, ?, ?, 'current')", (pid, "ZZLM goal", SK[(num, req)], req, have))
    plan(E1, "shared", 1, 4, 3)
    plan(E2, "draft", 1, 4, 3)
    plan(E4, "shared", 1, 4, 3)
    asg = db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future) VALUES (?,?,?,0)",
                     (cyc, E2, SK[(2, 3)])).lastrowid
    ass = db.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status) VALUES (?,?, 'submitted')",
                     (cyc, E2)).lastrowid
    db.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer) VALUES (?,?, 'no')", (ass, asg))
    db.execute("INSERT INTO talent_status_history(subject_id, year, category, source) VALUES (?, 2025, 'Star', 'test')",
               (E1,))
    db.commit()


def post(c, url, data, **kw):
    d = {"csrf_token": "tok"}
    d.update(data)
    return c.post(url, data=d, **kw)


def one(sql, args=()):
    return H.one(a, sql, args)


C_SU, C1, C2, C3, C4 = (H.client_as(a, x) for x in (SU["id"], E1, E2, E3, E4))
C_BG = H.client_as(a, BGA["id"]) if BGA else None
try:
    s.section("dark unless ONEHR_LMS=1")
    os.environ.pop("ONEHR_LMS", None)
    s.check("signed in, the panel is a 404", C1.get("/learning/panel").status_code == 404)
    s.check("...and so is a write", post(C1, "/learning/interest", {"kind": "explore", "comp_key": K3}).status_code == 404)
    r = a.app.test_client().get("/learning/panel")
    s.check("signed out, it goes on to sign-in (the deploy's route probe reads a redirect)",
            r.status_code == 302 and "/login" in r.headers.get("Location", ""), r.status_code)
    s.check("the admin pages are a 404 for the super admin", C_SU.get("/admin/learning/needs").status_code == 404
            and C_SU.get("/admin/learning/programmes").status_code == 404)
    s.check("...and the admin menu has no Learning", ">Learning<" not in C_SU.get("/admin").get_data(as_text=True))
    dash = C1.get("/dashboard").get_data(as_text=True)
    s.check("the dashboard keeps 'AI+ LMS · Coming soon' and no Learning tool",
            "AI+ LMS &middot; Coming soon" in dash and 'data-panel="learning"' not in dash)
    if C_BG:
        codes = [post(C_BG, u_, {"action": "save"}).status_code for u_ in (
            "/admin/learning/programmes", "/admin/learning/needs/read")]
        s.check("...a BG admin's write is refused 403 as every super-only write is (test_admin_viewonly)",
                codes == [403, 403], codes)
    aj = post(C1, "/ask", {"message": "training"}).get_json() or {}
    s.check("Ask OneHR doesn't offer Learning", not any((c_ or {}).get("panel") == "learning"
                                                       for c_ in aj.get("cards") or []), aj.get("cards"))

    os.environ["ONEHR_LMS"] = "1"
    s.section("the registry")
    norm = lambda t: " ".join(t.split())   # noqa: E731
    s.check("SCHEMA holds _LMS_DDL word for word", norm(a._LMS_DDL) in norm(a.SCHEMA))
    s.check("the staff routes are never cycle-gated", {"learning_panel", "learning_interest"} <= a.MODULE_UNGATED_ENDPOINTS)
    s.check("the admin writes are classified, the super admin's and (phase 2) the L&D admin's: 'lms' (a BG admin reads)",
            all(a.ADMIN_ACCESS_MAP.get(ep) == "lms" for ep in ("admin_learning_programmes",
                                                                  "admin_learning_proposal_read",
                                                                  "admin_learning_needs_read")))
    s.check("...and the pages are named as every admin's to read", a._ACCESS_PAGE_MODULE.get("admin_learning_needs", 0)
            is None and a._ACCESS_PAGE_MODULE.get("admin_learning_programmes", 0) is None)
    adm = C_SU.get("/admin/learning/needs")
    s.check("on: the needs page opens, and the menu shows Learning", adm.status_code == 200
            and ">Learning<" in C_SU.get("/admin").get_data(as_text=True), adm.status_code)

    s.section("the catalogue")
    base = "/admin/learning/programmes"
    post(C_SU, base, {"action": "save", "title": "ZZLM Margin Workshop", "kind": "inhouse", "category": "Not a listed one"})
    s.check("a category not on the list is refused (picked, not typed)",
            one("SELECT COUNT(*) FROM lms_programmes WHERE title='ZZLM Margin Workshop'") == 0)
    post(C_SU, base, {"action": "save", "title": "ZZLM Margin Workshop", "kind": "inhouse", "category": "__new__",
                      "category_new": "ZZLM Commercial", "grade_min": "13", "grade_max": "17", "days": "2",
                      "hours": "14", "eff_1": "1", "eff_3": "1"})
    P1 = one("SELECT id FROM lms_programmes WHERE title='ZZLM Margin Workshop'")
    row = H.rows(a, "SELECT * FROM lms_programmes WHERE id=?", (P1,))[0]
    s.check("...a new one through 'A new category…' is taken; the programme starts a draft with its audience",
            row["category"] == "ZZLM Commercial" and row["status"] == "draft"
            and a.lms_audience(row["audience_json"])["grade_min"] == 13, dict(row))
    if C_BG:
        r = post(C_BG, base, {"action": "save", "title": "ZZLM BG Try", "kind": "inhouse"})
        s.check("a BG admin can't write the catalogue (403), and reads it",
                r.status_code == 403 and one("SELECT COUNT(*) FROM lms_programmes WHERE title='ZZLM BG Try'") == 0
                and C_BG.get(base).status_code == 200, r.status_code)
    post(C_SU, base, {"action": "comp_add", "programme_id": P1, "comp_key": "NOPE-XXX-001", "level": "4"})
    post(C_SU, base, {"action": "comp_add", "programme_id": P1, "comp_key": K1, "level": "6"})
    s.check("a competency not in the catalogue, or at a level its family hasn't, is refused",
            one("SELECT COUNT(*) FROM lms_programme_competencies WHERE programme_id=?", (P1,)) == 0)
    post(C_SU, base, {"action": "comp_add", "programme_id": P1, "comp_key": K1, "level": "4"})
    s.check("...one at a level it has is added, confirmed (an admin chose it)",
            one("SELECT confirmed FROM lms_programme_competencies WHERE programme_id=? AND comp_key=?", (P1, K1)) == 1)
    with a.app.test_request_context("/"):
        d0 = a._today_myt() + timedelta(days=40)
    post(C_SU, base, {"action": "session_add", "programme_id": P1, "starts_on": d0.isoformat(),
                      "ends_on": (d0 + timedelta(days=1)).isoformat(), "seats": "20", "venue": "ZZLM Room"})
    cut = one("SELECT reg_cutoff FROM lms_sessions WHERE programme_id=?", (P1,))
    s.check("a session's registration closes 30 days before day one when left blank",
            cut == (d0 - timedelta(days=30)).isoformat(), cut)
    post(C_SU, base, {"action": "session_add", "programme_id": P1, "starts_on": d0.isoformat(),
                      "ends_on": (d0 - timedelta(days=2)).isoformat()})
    s.check("...a last day before the first is refused", one("SELECT COUNT(*) FROM lms_sessions WHERE programme_id=?",
                                                              (P1,)) == 1)

    s.section("matching: the right people, the right reason")

    def panel(c, tab="plan", **kw):
        q = "&".join("%s=%s" % kv for kv in kw.items())
        r_ = c.get("/learning/panel?tab=%s%s" % (tab, ("&" + q) if q else ""))
        return r_.status_code, (r_.get_json() or {}).get("html", "")
    st, h = panel(C1)
    s.check("a draft programme reaches nobody", st == 200 and "ZZLM Margin Workshop" not in h and "ZZLM Pricing" in h, st)
    post(C_SU, base, {"action": "publish", "programme_id": P1})
    st, h = panel(C1)
    s.check("published, it shows beside the Career Plan goal it builds, the reason from the two levels",
            "ZZLM Margin Workshop" in h and "Builds ZZLM Pricing to L4, the level your target role needs. You&#39;re at L3."
            in h, re.findall(r'class="lm-why">([^<]*)', h))
    _st, h4 = panel(C4)
    s.check("...never to someone outside its audience (JG 12, under JG 13)", "ZZLM Margin Workshop" not in h4
            and "ZZLM Pricing" in h4)
    _st, h2 = panel(C2)
    s.check("a draft plan still drives its own author's panel; their assessed gap shows too",
            "ZZLM Pricing" in h2 and "ZZLM Negotiation" in h2 and "From your competency assessment" in h2)

    s.section("interest")
    for _ in range(2):
        post(C1, "/learning/interest", {"kind": "programme", "programme_id": P1})
    s.check("one row however often it's marked",
            one("SELECT COUNT(*) FROM lms_interest WHERE user_id=? AND programme_id=?", (E1, P1)) == 1)
    r = post(C4, "/learning/interest", {"kind": "programme", "programme_id": P1})
    s.check("never for a programme not open to them (400)", r.status_code == 400
            and one("SELECT COUNT(*) FROM lms_interest WHERE user_id=?", (E4,)) == 0, r.status_code)
    ok_ = post(C2, "/learning/interest", {"kind": "competency", "comp_key": K2}).status_code
    bad = post(C2, "/learning/interest", {"kind": "competency", "comp_key": K3}).status_code
    s.check("interest in a competency: one of their own needs only (else Explore)", ok_ == 200 and bad == 400, (ok_, bad))
    with a.app.app_context():
        a.get_db().execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('lms_explore_cap', '1')")
        a.get_db().commit()
    e1 = post(C3, "/learning/interest", {"kind": "explore", "comp_key": K3})
    e2 = post(C3, "/learning/interest", {"kind": "explore", "comp_key": K4})
    s.check("exploring is capped (here at 1)", e1.status_code == 200 and e2.status_code == 400
            and "Stop one" in (e2.get_json() or {}).get("message", ""), (e1.status_code, e2.status_code))
    off = post(C3, "/learning/interest", {"kind": "explore", "comp_key": K3, "on": "0"})
    s.check("...stopping one frees the place", off.status_code == 200
            and post(C3, "/learning/interest", {"kind": "explore", "comp_key": K4}).status_code == 200)
    _st, hx = panel(C3, "explore", key=K4)
    s.check("the Explore tab shows the competency, what builds it and that they explore it",
            "ZZLM Explore Beta" in hx and "Exploring" in hx, _st)

    s.section("the needs analysis")
    with a.app.test_request_context("/"):
        lna = a.lms_lna(a.get_db(), SU, bg=BG)
    rows = {r_["key"]: r_ for r_ in lna["rows"]}
    s.check("Pricing: E1 and E4 from their shared plans; E2's DRAFT plan never counts", rows.get(K1, {}).get("n") == 2
            and rows[K1]["plan"] == 2, rows.get(K1))
    s.check("...Negotiation: E2 once, from the assessment and their interest", rows.get(K2, {}).get("n") == 1
            and rows[K2]["assessed"] == 1 and rows[K2]["interest"] == 1, rows.get(K2))
    s.check("...Stars are counted (E1)", rows[K1]["stars"] == 1, rows[K1]["stars"])
    s.check("...by unit inside one business group", lna["by_unit"] and rows[K1]["cells"].get(CO) == 2)
    s.check("...the calendar's cover: one programme, its 20 seats", rows[K1]["cover"] == {"programmes": 1, "seats": 20},
            rows[K1]["cover"])
    indep = one("SELECT COUNT(DISTINCT i.subject_id) FROM pm_idp i JOIN pm_idp_goals g ON g.idp_id=i.id "
                "JOIN users u ON u.id=i.subject_id WHERE u.business_group=? AND i.status IN ('shared','closed') "
                "AND g.skill_id IN (SELECT id FROM tc_skills WHERE skill_code LIKE 'ZZLM-AAA-_001-%')", (BG,))
    s.check("...against an independently written count of shared-plan goals", indep == rows[K1]["plan"], indep)
    s.check("E3 (another group) is outside this view", not any(r_["cells"].get("ZZLM U2") for r_ in lna["rows"]))
    r = C_SU.get("/admin/learning/needs?bg=%s&format=xlsx" % BG)
    s.check("the download is an Excel file", r.status_code == 200 and "spreadsheetml" in r.headers.get("Content-Type", ""))
    if BGA and (BGA["admin_bg"] or "") not in (BG, BG2):
        with a.app.test_request_context("/"):
            mine = a.lms_lna(a.get_db(), BGA)
        s.check("a BG admin's view holds their own group only (no ZZLM people)",
                not any(k in {r_["key"] for r_ in mine["rows"]} for k in (K1, K2)))

    s.section("the dashboard and Ask OneHR")
    dash = C1.get("/dashboard").get_data(as_text=True)
    s.check("on: a Learning tool card, and no 'Coming soon'", 'data-panel="learning"' in dash
            and "Coming soon" not in dash)
    aj = post(C1, "/ask", {"message": "training"}).get_json() or {}
    s.check("Ask OneHR's way to it opens the Learning panel and marks its card",
            any((c_ or {}).get("panel") == "learning" for c_ in aj.get("cards") or []) and aj.get("mark") == "learning"
            and "learning" in a.ASK_MARKS, aj)
    if C_BG:
        s.check("a BG admin reads the needs and the catalogue", C_BG.get("/admin/learning/needs").status_code == 200
                and C_BG.get("/admin/learning/programmes").status_code == 200)
    tpl = open(os.path.join(H.REPO, "templates", "learning", "_panel.html"), encoding="utf-8").read()
    s.check("the panel's HTML is Jinja's, autoescaped: no |safe or Markup in it (dashboard.js sets it as HTML)",
            "|safe" not in tpl.replace(" ", "") and "Markup" not in tpl)

    s.section("the AI: checked before anything is kept")
    real = (a.ai_draft.is_configured, a._attach_extract, a.ai_draft.lms_read_proposal, a.ai_draft.lms_needs_read)
    try:
        a.ai_draft.is_configured = lambda: True
        a._attach_extract = lambda ext, data: ("ok", "A workshop on pricing and margin, and on negotiation.")
        a.ai_draft.lms_read_proposal = lambda text, cands: {
            "title": "ZZLM Read Workshop", "kind": "external", "days": 2, "hours": 14, "cost_per_pax": "1240",
            "hrdc_claimable": True, "description": "ZZLM",
            "competencies": [{"key": K1, "level": 4, "strength": "strong", "evidence": "protect margin"},
                             {"key": "INVENTED-XXX-001", "level": 4}, {"key": K2, "level": 9}]}
        r = C_SU.post("/admin/learning/programmes/read", data={"csrf_token": "tok",
                      "proposal": (io.BytesIO(b"%PDF-1.4 zzlm"), "zzlm-proposal.pdf")},
                      content_type="multipart/form-data")
        PR = one("SELECT id FROM lms_programmes WHERE title='ZZLM Read Workshop'")
        comps = H.rows(a, "SELECT comp_key, level, confirmed FROM lms_programme_competencies WHERE programme_id=?", (PR,))
        s.check("a proposal becomes a DRAFT, its figures taken, from the proposal", PR and r.status_code == 302
                and one("SELECT status FROM lms_programmes WHERE id=?", (PR,)) == "draft"
                and one("SELECT source FROM lms_programmes WHERE id=?", (PR,)) == "proposal"
                and one("SELECT hrdc_claimable FROM lms_programmes WHERE id=?", (PR,)) == 1, r.status_code)
        s.check("...only the candidate's competency at a level it has, and NOT confirmed",
                [(c["comp_key"], c["level"], c["confirmed"]) for c in comps] == [(K1, 4, 0)], [tuple(c) for c in comps])
        r = C_SU.post("/admin/learning/programmes/read", data={"csrf_token": "tok",
                      "proposal": (io.BytesIO(b"x"), "zzlm.exe")}, content_type="multipart/form-data")
        s.check("...a file that isn't PDF, Word or text is refused", one("SELECT COUNT(*) FROM lms_programmes WHERE "
                                                                       "source_file='zzlm.exe'") == 0)
        a.ai_draft.lms_needs_read = lambda facts: ["ZZLM Pricing is needed by 2 people.", "There are 9999 gaps."]
        post(C_SU, "/admin/learning/needs/read", {"bg": BG})
        kept = one("SELECT body FROM lms_reads WHERE scope_key=?", ("lna|%s||" % BG,))
        s.check("the needs read keeps only findings whose numbers the facts hold",
                kept and "9999" not in kept and "2 people" in kept, kept)
        a.ai_draft.lms_needs_read = lambda facts: ["There are 9999 gaps."]
        post(C_SU, "/admin/learning/needs/read", {"bg": BG})
        s.check("...and a read with nothing true is refused, the last one kept",
                one("SELECT body FROM lms_reads WHERE scope_key=?", ("lna|%s||" % BG,)) == kept)
        page = C_SU.get("/admin/learning/needs?bg=%s" % BG).get_data(as_text=True)
        s.check("...the page shows the read", "ZZLM Pricing is needed by 2 people." in page)
    finally:
        (a.ai_draft.is_configured, a._attach_extract, a.ai_draft.lms_read_proposal, a.ai_draft.lms_needs_read) = real

    s.section("pages render")
    pg = C_SU.get("%s?programme=%d&panel=prog&show=all" % (base, P1))
    body = pg.get_data(as_text=True)
    s.check("a programme's panel opens with its competencies and sessions", pg.status_code == 200
            and "ZZLM Pricing" in body and "ZZLM Room" in body, pg.status_code)
    s.check("every POST form on it is double-confirmed",
            all("data-confirm" in f_ for f_ in re.findall(r"<form[^>]*method=\"post\"[^>]*>", body)
                if 'action="/logout"' not in f_))   # Log out is a POST form (security test 2-14), no action that asks first
    for tab in ("plan", "explore", "catalogue"):
        s.check("the %s tab answers" % tab, panel(C1, tab)[0] == 200)
finally:
    if _ENV0 is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = _ENV0
    with a.app.app_context():
        _cleanup(a.get_db())
sys.exit(s.done())
