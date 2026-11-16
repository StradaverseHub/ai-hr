"""The AI+ Learning dashboards (2026-10-20, plan `AI+ LMS/Dashboards build plan 2026-10-20.md`, STAGING ONLY).

Phase 1, the foundations:
  - dash2_on(): ONEHR_DASH2=1 only; without it the dashboard is today's.
  - the staging demo's "LMS: Yes / No" (Chris: "add one more on LMS with drop down of yes or no, yes to enable the
    LMS"): No hides Learning for that browser session (the menu, the pages, lms_on()); it 404s for a login that can't
    switch personas and for an admin, and it never turns Learning on where ONEHR_LMS is off.
  - the readers the dashboard cards are built from -- lms_person_summary, lms_scope_summary, lms_round_nominators,
    plan_goal_levels -- each against an independently written query.

Self-contained: seeds its own ZZDL people, programme, sessions and plans in one business group, and deletes them at the
end (try/finally), so the shared scratch database is left as found.
"""
import os
import re
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning dashboards: the switches, the readers, the dashboard while a cycle runs")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

BG = "ZZ Dash Learning BG"
_ENV0 = {k: os.environ.get(k) for k in ("ONEHR_LMS", "ONEHR_DASH2")}
ids = {}
made = {"prog": None, "prog2": None, "rounds": []}


def _env(k, v):
    if v is None:
        os.environ.pop(k, None)
    else:
        os.environ[k] = v


def mk(db, key, persona=None, switcher=0, dept="ZZ Sales", **extra):
    cols = ["username", "full_name", "password_hash", "role", "employee_id", "business_group", "company", "department",
            "demo_persona", "demo_switcher"]
    vals = ["ZZDL-" + key, "ZZ Dash " + key, "x", "user", "ZZDL-" + key, BG, "ZZ Dash Co", dept, persona, switcher]
    for k, v in extra.items():
        cols.append(k)
        vals.append(v)
    return db.execute("INSERT INTO users (%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), vals).lastrowid


today = date.today()
yr = today.year
try:
    with a.app.app_context():
        db = a.get_db()
        # the dashboard runs its cycle view only with the cycle's review on: an earlier suite in the run may have left it
        # off, so switch it on here and put back what was there at the end
        made["cid"] = a.active_cycle_id(db)
        _r = db.execute("SELECT active FROM cycle_modules WHERE cycle_id=? AND module_key='review'",
                        (made["cid"],)).fetchone()
        made["review"] = _r[0] if _r else None          # None: no row (on by default)
        db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'review', 1) "
                   "ON CONFLICT(cycle_id, module_key) DO UPDATE SET active=1", (made["cid"],))
        ids["hod"] = mk(db, "hod", "hod")
        ids["mgr"] = mk(db, "mgr", "manager")
        ids["emp"] = mk(db, "emp", "employee", switcher=1)
        ids["peer"] = mk(db, "peer", dept="ZZ Ops")
        db.execute("UPDATE users SET manager_id=?, hod_id=? WHERE id IN (?,?)", (ids["mgr"], ids["hod"], ids["emp"],
                                                                               ids["peer"]))
        db.execute("UPDATE users SET hod_id=? WHERE id=?", (ids["hod"], ids["mgr"]))
        skill = db.execute("SELECT id FROM tc_skills WHERE active=1 AND skill_code IS NOT NULL LIMIT 1").fetchone()
        skill = skill[0] if skill else None
        p = db.execute("INSERT INTO lms_programmes(title, kind, hours, status, source) VALUES "
                       "('ZZDL Programme', 'inhouse', 7, 'published', 'demo')").lastrowid
        made["prog"] = p

        def sess(start):
            return db.execute("INSERT INTO lms_sessions(programme_id, starts_on, ends_on) VALUES (?,?,?)",
                              (p, start, start)).lastrowid
        past = sess((today - timedelta(days=10)).isoformat())
        future = sess((today + timedelta(days=30)).isoformat())
        last_year = sess(date(yr - 1, 6, 1).isoformat())
        # a plan with one goal naming a competency, for the employee only
        idp = db.execute("INSERT INTO pm_idp(plan_year, subject_id, status, manager_comment) VALUES (?,?, 'shared', "
                         "'ZZDL keep going')", (yr, ids["emp"])).lastrowid
        goal = db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area, skill_id, have_level, required_level) VALUES "
                          "(?,1,'ZZDL goal',?,3,4)", (idp, skill)).lastrowid

        def reg(uid, sid, status, outcome=None, hours=None, goal_id=None, **extra):
            cols = ["user_id", "session_id", "programme_id", "status", "outcome", "hours", "goal_id"]
            vals = [uid, sid, p, status, outcome, hours, goal_id]
            for k, v in extra.items():
                cols.append(k)
                vals.append(v)
            return db.execute("INSERT INTO lms_registrations(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                              vals).lastrowid
        reg(ids["emp"], past, "approved", "attended", 7.0, goal_id=goal)      # this year, done, to rate, for the goal
        reg(ids["emp"], future, "approved")                                     # still to come
        reg(ids["emp"], None, "pending", ext_title="ZZDL external", ext_starts_on=(today + timedelta(days=40)).isoformat(),
            ext_ends_on=(today + timedelta(days=40)).isoformat())               # an open request
        reg(ids["emp"], last_year, "approved", "attended", 5.0)                 # last year: not this year's hours
        reg(ids["peer"], past, "approved", "partial", 3.5)                      # a colleague, no plan
        rd = db.execute("INSERT INTO lms_rounds(title, closes_on) VALUES ('ZZDL round', ?)",
                        ((today + timedelta(days=7)).isoformat(),)).lastrowid
        made["rounds"].append(rd)
        reg(ids["peer"], future, "pending", nomination="hod", nominated_by=ids["hod"], round_id=rd)
        db.commit()

    # --- the switches ------------------------------------------------------------------------------------------------
    s.section("dash2_on: ONEHR_DASH2=1 only")
    _env("ONEHR_DASH2", None)
    s.check("off without ONEHR_DASH2", a.dash2_on() is False)
    _env("ONEHR_DASH2", "1")
    s.check("on with ONEHR_DASH2=1", a.dash2_on() is True)
    _env("ONEHR_DASH2", None)

    s.section("the demo's LMS choice")
    _env("ONEHR_LMS", None)
    c = H.client_as(a, ids["emp"])
    s.check("Learning off on the server: the choice 404s", c.post("/demo/lms", data={"lms": "on", "csrf_token": "tok"})
            .status_code == 404)
    with a.app.test_request_context("/"):
        a.session["demo_lms"] = "on"
        s.check("...and lms_on() stays off whatever the session says", a.lms_on() is False)
    _env("ONEHR_LMS", "1")
    plain = H.client_as(a, ids["peer"])
    s.check("a login that can't switch personas: 404",
            plain.post("/demo/lms", data={"lms": "off", "csrf_token": "tok"}).status_code == 404)
    su, _bga, _emp = H.actors(a)
    s.check("an admin: 404", H.client_as(a, su["id"]).post("/demo/lms", data={"lms": "off", "csrf_token": "tok"})
            .status_code == 404)
    adm = H.client_as(a, su["id"])
    with adm.session_transaction() as sess_:
        sess_["demo_lms"] = "off"
    s.check("an admin session carrying No still has Learning (the choice is a demo login's only)",
            adm.get("/admin/learning/needs").status_code == 200)
    c = H.client_as(a, ids["emp"])
    s.check("Learning on: /learning opens", c.get("/learning").status_code == 200)
    page = c.get("/dashboard").get_data(as_text=True)
    s.check("the demo menu offers LMS Yes / No", 'action="/demo/lms"' in page and ">No</option>" in page)
    s.check("No: the choice is taken", c.post("/demo/lms", data={"lms": "off", "csrf_token": "tok"}).status_code == 302)
    s.check("No: /learning is a 404 for this session", c.get("/learning").status_code == 404)
    page = c.get("/dashboard").get_data(as_text=True)
    s.check("No: the menu says so", "No LMS" in page)
    s.check("a junk value is refused", c.post("/demo/lms", data={"lms": "maybe", "csrf_token": "tok"}).status_code == 400)
    s.check("Yes: back on", c.post("/demo/lms", data={"lms": "on", "csrf_token": "tok"}).status_code == 302
            and c.get("/learning").status_code == 200)
    s.check("another login is untouched by this session's No",
            (c.post("/demo/lms", data={"lms": "off", "csrf_token": "tok"}).status_code == 302)
            and H.client_as(a, ids["mgr"]).get("/learning").status_code == 200)

    # --- the readers -------------------------------------------------------------------------------------------------
    s.section("lms_person_summary against its own query")
    with a.app.app_context():
        db = a.get_db()
        sm = a.lms_person_summary(db, [ids["emp"], ids["peer"], ids["hod"]])
        e = sm[ids["emp"]]
        want_hours = db.execute(
            "SELECT COALESCE(SUM(r.hours),0) FROM lms_registrations r LEFT JOIN lms_sessions x ON x.id=r.session_id "
            "WHERE r.user_id=? AND substr(COALESCE(x.ends_on, r.ext_ends_on),1,4)=?", (ids["emp"], str(yr))).fetchone()[0]
        s.check("hours this year match", e["hours"] == round(want_hours, 1), (e["hours"], want_hours))
        s.check("last year's course isn't this year's hours", e["hours"] == 7.0, e["hours"])
        s.check("one done this year", e["done"] == 1, e)
        s.check("one to come, and it's the next", e["upcoming"] == 1 and e["next"] and e["next"]["title"] ==
                "ZZDL Programme", e)
        want_rate = db.execute(
            "SELECT COUNT(*) FROM lms_registrations r WHERE r.user_id=? AND r.outcome IN ('attended','partial') AND "
            "r.session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM lms_ratings x WHERE x.registration_id=r.id)",
            (ids["emp"],)).fetchone()[0]
        s.check("to rate: every session they came to and haven't rated, any year (as the space counts)",
                e["to_rate"] == want_rate == 2, (e["to_rate"], want_rate))
        s.check("one open request", e["open"] == 1, e)
        s.check("someone with nothing gets zeros", sm[ids["hod"]] == {"hours": 0.0, "done": 0, "upcoming": 0,
                                                                      "next": None, "to_rate": 0, "open": 0})
        s.check("partial counts as done", sm[ids["peer"]]["done"] == 1 and sm[ids["peer"]]["hours"] == 3.5)

    s.section("lms_scope_summary against its own queries")
    with a.app.app_context():
        db = a.get_db()
        people = {r["id"]: r for r in db.execute("SELECT * FROM users WHERE business_group=?", (BG,))}
        sc = a.lms_scope_summary(db, people, by="department")
        want_plan = db.execute("SELECT COUNT(DISTINCT i.subject_id) FROM pm_idp i JOIN pm_idp_goals g ON g.idp_id=i.id "
                               "JOIN users u ON u.id=i.subject_id WHERE u.business_group=? AND i.status IN "
                               "('shared','closed') AND TRIM(COALESCE(g.area,''))!=''", (BG,)).fetchone()[0]
        s.check("people", sc["n"] == len(people) == 4, sc["n"])
        s.check("with a Career Plan goal", sc["plan"] == want_plan == 1, (sc["plan"], want_plan))
        s.check("learning done or booked for it", sc["booked"] == 1, sc["booked"])
        s.check("hours this year", sc["hours"] == 10.5, sc["hours"])
        by = {r["name"]: r for r in sc["by"]}
        s.check("split by department adds back up", sum(r["n"] for r in sc["by"]) == sc["n"] and
                round(sum(r["hours"] for r in sc["by"]), 1) == sc["hours"], sc["by"])
        s.check("ZZ Ops has the colleague's hours", by.get("ZZ Ops", {}).get("hours") == 3.5, by.get("ZZ Ops"))
        s.check("needs carry their cover count", all("programmes" in n_ for n_ in sc["needs"]))
        # a draft plan is private: it never counts
        db.execute("UPDATE pm_idp SET status='draft' WHERE subject_id=?", (ids["emp"],))
        s.check("a draft plan doesn't count", a.lms_scope_summary(db, people)["plan"] == 0)
        db.execute("UPDATE pm_idp SET status='shared' WHERE subject_id=?", (ids["emp"],))
        db.commit()

    s.section("lms_round_nominators and the L&D page that now uses it")
    with a.app.app_context():
        db = a.get_db()
        nom = a.lms_round_nominators(db, made["rounds"][0])
        s.check("the HOD who nominated is there", nom == {ids["hod"]}, nom)
        s.check("lms_open_round finds an open round", a.lms_open_round(db) is not None)
    s.check("Learning › Nominations still renders", H.client_as(a, su["id"]).get("/admin/learning/rounds")
            .status_code == 200)

    s.section("plan_goal_levels")
    with a.app.app_context(), a.app.test_request_context("/"):
        db = a.get_db()
        u = db.execute("SELECT * FROM users WHERE id=?", (ids["emp"],)).fetchone()
        pl = a.plan_goal_levels(db, u)
        s.check("the plan year and its goal", pl and pl["year"] == yr and [g["area"] for g in pl["goals"]] == ["ZZDL goal"],
                pl)
        s.check("the goal's levels, now and aimed for", pl and pl["goals"][0]["have"] == 3 and pl["goals"][0]["need"] == 4)
        rec = a._record_plan_year(db, u, yr)
        s.check("the manager's remark follows _record_plan_year's rule", pl["lm_remark"] == rec["lm_remark"],
                (pl["lm_remark"], rec["lm_remark"]))
        nobody = db.execute("SELECT * FROM users WHERE id=?", (ids["peer"],)).fetchone()
        s.check("no plan: None", a.plan_goal_levels(db, nobody) is None)
    # --- phase 2: the dashboard while a cycle runs -------------------------------------------------------------------
    import re as _re

    def _od(uid, client=None):
        h = (client or H.client_as(a, uid)).get("/dashboard").get_data(as_text=True)
        return h[h.find('class="od"'):h.find('data-od-scrim')] if 'class="od"' in h else h

    NEW_BITS = ('class="od-card od-learn"', 'class="od-new">Learning', 'data-lt-tab=', 'href="/learning')

    s.section("phase 2: with Learning off, the dashboard carries none of it")
    _env("ONEHR_LMS", None)
    for k in ("emp", "mgr", "hod"):
        h = _od(ids[k])
        s.check("%s: no Learning card, tag, tab or link; Coming soon stays" % k,
                not any(b_ in h for b_ in NEW_BITS) and "Coming soon" in h, [b_ for b_ in NEW_BITS if b_ in h])
    _env("ONEHR_LMS", "1")
    with a.app.app_context():
        db = a.get_db()
        # another programme: one run of a programme at a time (2026-10-23)
        made["prog2"] = db.execute("INSERT INTO lms_programmes(title, kind, hours, status) VALUES ('ZZDL Programme 2', "
                                   "'inhouse', 7, 'published')").lastrowid
        fut2 = db.execute("INSERT INTO lms_sessions(programme_id, starts_on, ends_on) VALUES (?,?,?)",
                          (made["prog2"], (today + timedelta(days=45)).isoformat(),
                           (today + timedelta(days=45)).isoformat())).lastrowid
        emp_row = db.execute("SELECT * FROM users WHERE id=?", (ids["emp"],)).fetchone()
        ok_, msg_, rid2 = a.lms_register(db, emp_row, fut2)
        db.commit()
        s.check("a real request goes in through lms_register (it waits on the line manager)", ok_ and rid2, msg_)
        mgr_row = db.execute("SELECT * FROM users WHERE id=?", (ids["mgr"],)).fetchone()
        waits_lm = [w for w in a.lms_waiting_on(db, mgr_row) if w["who"]["as"] == "lm"]

    s.section("phase 2: the employee (leads no one)")
    h = _od(ids["emp"])
    s.check("one card, 'Your learning', no tabs", 'id="od-learn-h">Your learning<' in h and "data-lt-tab=" not in h)
    with a.app.app_context(), a.app.test_request_context("/"):
        db = a.get_db()
        ctx_ = a._dash_context(db, db.execute("SELECT * FROM users WHERE id=?", (ids["emp"],)).fetchone())
        st_ = [x_ for x_ in ctx_["standing"] if x_["key"] == "learning"]
    s.check("Where you stand gains Learning this year, as the reader counts it (shown wherever that card is)",
            st_ and st_[0]["text"] == "7 h · 1 completed" and st_[0]["panel"] == "learning", st_)
    s.check("a next-step row to rate the session they came to, tagged Learning",
            "Rate ZZDL Programme" in h and 'class="od-new">Learning' in h and ('view=mine&amp;tab=apply#rate-' in h or 'view=mine&tab=apply#rate-' in h))
    s.check("the confirmed course within a month offers its calendar file, as a download",
            _re.search(r'href="/learning/ics/\d+"[^>]*download', h) is not None)
    s.check("the card's closing line counts their plan's goals with a course",
            "1 of your 1 Career Plan goal has a course." in h, _re.findall(r'od-lt-fit"><span>([^<]*)', h))

    s.section("phase 2: the line manager")
    h = _od(ids["mgr"])
    s.check("tabs: Your team · 2, then Yours", _re.findall(r'data-lt-tab="(\w+)">([^<]*)<', h) ==
            [("team", "Your team · 2"), ("mine", "Yours")], _re.findall(r'data-lt-tab="(\w+)">([^<]*)<', h))
    s.check("the team tile counts what waits on them, as lms_waiting_on does", len(waits_lm) == 1 and
            '<b>1</b><span>waits on you</span>' in h, len(waits_lm))
    s.check("a next-step row for it, into Learning's Team view", "Your team · 1 training request waits on you" in h
            and ('view=team&amp;tab=team#waiting' in h or 'view=team&tab=team#waiting' in h))
    s.check("the team's rows name their own people only", "ZZ Dash emp" in h and "ZZ Dash hod" not in h.split(
        'od-lt-p-team')[1].split('od-lt-p-mine')[0] if 'od-lt-p-team' in h else False)

    s.section("phase 2: the HOD")
    h = _od(ids["hod"])
    tabs = _re.findall(r'data-lt-tab="(\w+)">([^<]*)<', h)
    s.check("tabs: Your department · 3 (no team of their own), then Yours", tabs == [("dept", "Your department · 3"),
                                                                                    ("mine", "Yours")], tabs)
    with a.app.app_context():
        db = a.get_db()
        dept = {r["id"]: r for r in db.execute("SELECT * FROM users WHERE hod_id=? AND left_at IS NULL AND role!='admin'",
                                               (ids["hod"],))}
        sc = a.lms_scope_summary(db, dept)
    s.check("the department tiles are lms_scope_summary's", ('<b>%d</b><span>people</span>' % sc["n"]) in h and
            ('<b>%d</b><span>with a Career Plan goal</span>' % sc["plan"]) in h, (sc["n"], sc["plan"]))
    s.check("the open round's row: closes, and what they've nominated", "ZZDL round · nominations close" in h and
            "1 nominated" in h and ('view=dept&amp;tab=dept#rounds' in h or 'view=dept&tab=dept#rounds' in h))
    s.check("the needs list has a bar per row on fixed columns", ('class="od-lt-needs"' in h) == bool(sc["needs"]))

    s.section("the staging demo's seeder (deploy/demo/seed_lms_dash.py), on a copy")
    import subprocess as _sp
    import sqlite3 as _sq
    import tempfile as _tf
    _cp = os.path.join(_tf.mkdtemp(prefix="onehr-tests-seed-"), "copy.db")
    with a.app.app_context():
        _dst = _sq.connect(_cp)
        a.get_db().backup(_dst)
        _dst.close()
    _seed = os.path.join(H.REPO, "deploy", "demo", "seed_lms_dash.py")

    def _run(*args_):
        r_ = _sp.run([sys.executable, _seed, "--db", _cp] + list(args_), capture_output=True, text=True)
        return r_.returncode, r_.stdout + r_.stderr

    def _q(sql, *args_):
        c_ = _sq.connect(_cp)
        try:
            return c_.execute(sql, args_).fetchone()[0]
        finally:
            c_.close()
    _c0 = _sq.connect(_cp)   # staging has a persona set per demo group: make a second Employee persona account
    _c0.execute("UPDATE users SET demo_persona='employee' WHERE id=?", (ids["peer"],))
    _c0.commit()
    _c0.close()
    base_n = _q("SELECT COUNT(*) FROM lms_registrations")
    base_p = _q("SELECT COUNT(*) FROM lms_programmes")
    rc, out = _run()
    s.check("a dry run writes nothing", rc == 0 and "DRY RUN" in out and _q("SELECT COUNT(*) FROM lms_registrations")
            == base_n, out[-300:])
    rc, out = _run("--apply")
    n1 = _q("SELECT COUNT(*) FROM lms_registrations WHERE why LIKE '[dash-demo]%'")
    s.check("--apply backs up first and writes marked requests", rc == 0 and "integrity ok" in out and n1 > 0, out[-300:])
    s.check("every Employee persona account has its own: one to rate and one coming (the probe found only one did)",
            all(_q("SELECT COUNT(*) FROM lms_registrations WHERE user_id=? AND why LIKE '[dash-demo]%%'", i_) == 2
                for i_ in (ids["emp"], ids["peer"])))
    s.check("only demo accounts get anything", _q(
        "SELECT COUNT(*) FROM lms_registrations r JOIN users u ON u.id=r.user_id WHERE r.why LIKE '[dash-demo]%' AND "
        "u.employee_id NOT GLOB 'ZZ[A-Z]*'") == 0)
    rc, out = _run("--apply")
    s.check("a re-run converges (the same count, not double)",
            rc == 0 and _q("SELECT COUNT(*) FROM lms_registrations WHERE why LIKE '[dash-demo]%'") == n1)
    rc, out = _run("--apply", "--undo")
    s.check("--undo removes exactly its own (requests and sessions), nothing else",
            rc == 0 and _q("SELECT COUNT(*) FROM lms_registrations WHERE why LIKE '[dash-demo]%'") == 0 and
            _q("SELECT COUNT(*) FROM lms_sessions WHERE run_label LIKE 'Dash %'") == 0 and
            _q("SELECT COUNT(*) FROM lms_registrations") == base_n and _q("SELECT COUNT(*) FROM lms_programmes") == base_p)
    import shutil as _sh
    _sh.rmtree(os.path.dirname(_cp), ignore_errors=True)

    s.section("phase 2: Ask OneHR knows the card")
    with a.app.app_context(), a.app.test_request_context("/"):
        db = a.get_db()
        mrow = db.execute("SELECT * FROM users WHERE id=?", (ids["mgr"],)).fetchone()
        ctx_ = a._dash_context(db, mrow)
        lines_, links_ = a._ask_facts(db, mrow, ctx_)
        sug_ = a._ask_suggestions(ctx_)
    s.check("a chip to open their learning", "Open my learning" in sug_, sug_)
    lrn_line = [x_ for x_ in lines_ if x_.startswith("- Learning (below, left)")]
    s.check("the facts name the card, its tabs and the person's own counts", lrn_line and "Your team · 2" in lrn_line[0]
            and "completed" in lrn_line[0], lrn_line)
    s.check("...and may take them to AI+ Learning or mark the card", any(v_.get("href") == "/learning" for v_ in
                                                                       links_.values()) and
            any(v_.get("mark") == "learning" for v_ in links_.values()))

    s.section("phase 2: who doesn't see it")
    c = H.client_as(a, ids["emp"])
    c.post("/demo/lms", data={"lms": "off", "csrf_token": "tok"})
    h = _od(ids["emp"], c)
    s.check("the demo's LMS: No -- none of it", not any(b_ in h for b_ in NEW_BITS), [b_ for b_ in NEW_BITS if b_ in h])
    with a.app.app_context():
        db = a.get_db()
        rid_role = db.execute("INSERT INTO user_roles(name) VALUES ('ZZDL no learning')").lastrowid
        db.execute("INSERT INTO user_role_modules(role_id, module) VALUES (?, 'idp')", (rid_role,))
        db.execute("UPDATE users SET user_role_id=? WHERE id=?", (rid_role, ids["peer"]))
        db.commit()
        made["role"] = rid_role
    h = _od(ids["peer"])
    s.check("a user role without AI+ Learning -- none of it", not any(b_ in h for b_ in NEW_BITS),
            [b_ for b_ in NEW_BITS if b_ in h])
    hs = [_od(ids[k]) for k in ("emp", "mgr", "hod")]
    hrefs = sorted({x_ for h_ in hs for x_ in _re.findall(r'href="([^"#]+)', h_)})
    s.check("every link on these dashboards is the journey, review or AI+ Learning's own pages", hrefs and all(
        x_.startswith("/review/journey") or x_ == "/review" or x_.startswith("/learning") for x_ in hrefs), hrefs)

    # --- phase 3: the BU CEO and the BG CEO while a cycle runs ---------------------------------------------------------
    s.section("phase 3: a BU CEO and a BG CEO over the same people")
    with a.app.app_context():
        db = a.get_db()
        # in the calibration population (confirmed, a grade), as a CEO's counts are
        db.execute("UPDATE users SET confirmation_date='2020-01-01', job_grade='14' WHERE business_group=?", (BG,))
        ids["bgceo"] = mk(db, "bgceo", "bgceo", dept="ZZ Management", bgceo_bg=BG, confirmation_date="2020-01-01",
                          job_grade="14")
        ids["buceo"] = mk(db, "buceo", "buceo", dept="ZZ Management", confirmation_date="2020-01-01", job_grade="14")
        db.execute("DELETE FROM buceo_seats WHERE business_group=? AND company='ZZ Dash Co'", (BG,))
        db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?, 'ZZ Dash Co', ?)",
                   (BG, ids["buceo"]))
        # final bands for the people, so the BG CEO has a Talent Box to show (or not, without ONEHR_DASH2)
        made["rr_cid"] = a.active_cycle_id(db)
        for i_, (uid_, eid_) in enumerate(db.execute("SELECT id, employee_id FROM users WHERE business_group=? AND "
                                                      "bgceo_bg IS NULL", (BG,)).fetchall()):
            b_, p_ = ("ME", "AE", "BE")[i_ % 3], ("Mid", "High", "Low")[i_ % 3]
            db.execute("INSERT INTO rating_records(cycle_id, subject_id, employee_id, business_group, company, "
                       "pm_final_band, pm_hod_band, pot_final_band, pot_hod_band) VALUES (?,?,?,?, 'ZZ Dash Co', ?,?,?,?)",
                       (made["rr_cid"], uid_, eid_, BG, b_, b_, p_, p_))
        db.commit()
        pop_n = db.execute("SELECT COUNT(*) FROM users WHERE business_group=? AND company='ZZ Dash Co' AND role!='admin' "
                           "AND " + a.calibration_population_sql(), (BG,)).fetchone()[0]
        depts_n = db.execute("SELECT COUNT(DISTINCT department) FROM users WHERE business_group=? AND company='ZZ Dash Co' "
                             "AND role!='admin' AND " + a.calibration_population_sql(), (BG,)).fetchone()[0]
    names = [r_[0] for r_ in H.rows(a, "SELECT full_name FROM users WHERE business_group=?", (BG,))]
    h = _od(ids["buceo"])
    card = h[h.find('id="od-dept-learn"'):h.find('</section>', h.find('id="od-dept-learn"'))] if 'od-dept-learn' in h \
        else ""
    s.check("BU CEO: Where your BU is gains its two Learning rows", 'class="od-ceo-where"' in h and
            "Learning this year" in h and "Learning for their plan" in h)
    s.check("BU CEO: the department card, Reviews | Learning, opening on Learning", card and 'data-lt-tab="rev"' in card
            and 'data-lt-tab="lrn"' in card and 'id="od-lt-p-rev" aria-labelledby="od-lt-t-rev" hidden' in card)
    s.check("BU CEO: a learning row per department, and the unit's total over the same people as its calibration",
            card.count('class="od-lrn-r" role="row"') == depts_n and
            ('<span role="cell" class="num">%d</span>' % pop_n) in card.split('od-lrn-r is-tot')[-1], (depts_n, pop_n))
    s.check("BU CEO: counts only -- no person's name in the card", card and not [n_ for n_ in names if n_ in card])
    s.check("BU CEO: the round's row counts its departments' HODs who answered (nominated, or nobody; 2026-10-23)",
            "department has answered" in h or "departments have answered" in h)
    h = _od(ids["bgceo"])
    lc = h[h.find('id="od-bg-learn"'):] if 'od-bg-learn' in h else ""
    s.check("BG CEO: All business units first, then the unit", _re.findall(r'data-lunit-label="([^"]+)"', lc)[:2] ==
            ["All business units", "ZZ Dash Co"], _re.findall(r'data-lunit-label="([^"]+)"', lc))
    s.check("BG CEO: no Talent Box view without ONEHR_DASH2 (it isn't Learning)", lc and 'data-lview="box"' not in lc)
    lc_card = lc[:lc.find('od-hist')] if 'od-hist' in lc else lc
    s.check("BG CEO: counts only -- no person's name in the card", lc_card and not [n_ for n_ in names if n_ in lc_card])
    _env("ONEHR_DASH2", "1")
    with a.app.app_context(), a.app.test_request_context("/"):
        db = a.get_db()
        has_box = bool(a.dash_bg_box(db, db.execute("SELECT * FROM users WHERE id=?", (ids["bgceo"],)).fetchone(),
                                      a.active_cycle_id(db)))
    h = _od(ids["bgceo"])
    s.check("BG CEO: with ONEHR_DASH2, the Talent Box view is there (the people have final bands)",
            has_box and 'data-lview="box"' in h, has_box)
    _env("ONEHR_DASH2", None)
    _env("ONEHR_LMS", None)
    h = _od(ids["buceo"])
    s.check("Learning off: the BU card is today's (its department table inside), none of the CEO parts",
            'class="od-bu-tbl"' in h and "od-dept-learn" not in h and "od-ceo-where" not in h)
    h = _od(ids["bgceo"])
    s.check("Learning off: the BG CEO's dashboard has none of it", "od-bg-learn" not in h and "od-ceo-where" not in h)
    _env("ONEHR_LMS", "1")

    # --- phase 4: between cycles (the record view), the second round behind ONEHR_DASH2 -----------------------------
    s.section("phase 4: between cycles")
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycle_modules SET active=0 WHERE cycle_id=? AND module_key='review'", (made["cid"],))
        db.commit()
    _env("ONEHR_DASH2", None)
    h = _od(ids["emp"])
    nx = h.split('id="od-rn-h"')[1][:1500] if 'id="od-rn-h"' in h else ""
    s.check("ONEHR_DASH2 off: today's record view (today's plan card), with Learning's next step only (2026-10-23)",
            "od-plv" not in h and 'class="od-card od-planc"' in h and (not nx or 'od-new">Learning' in nx))
    _env("ONEHR_DASH2", "1")
    h = _od(ids["emp"])

    def _with_journey():
        """The record view rendered with a past cycle's journey in it (the suite's people have none of their own)."""
        with a.app.test_request_context("/dashboard"):
            a.session["user_id"] = ids["emp"]
            db = a.get_db()
            ctx_ = a._dash_context(db, db.execute("SELECT * FROM users WHERE id=?", (ids["emp"],)).fetchone())
            ctx_["rec"]["steps"] = [{"name": "KPI Check-in", "done": True, "word": "Done", "line": "", "who": "You",
                                     "tag": ""}]
            ctx_["rec"]["last"] = dict(ctx_["rec"].get("last") or {}, name="2025 Year-End", key="1", own=False)
            ctx_.update(nav_pill={"name": "x", "state": "between", "note": ""}, ask={"lead": "", "pending": 0,
                        "first_name": "", "available": False, "suggestions": []}, ob=None)
            return a.render_template("dashboard.html", **ctx_)
    s.check("no timeline between cycles (a past journey there, and still no rail)", "od-rail is-past" not in
            _with_journey())
    _env("ONEHR_DASH2", None)
    s.check("...where ONEHR_DASH2 is off, the same page keeps today's timeline", "od-rail is-past" in _with_journey())
    _env("ONEHR_DASH2", "1")
    s.check("Your next step leads, with Learning's rows", 'id="od-rn-h"' in h and 'class="od-new">Learning' in h)
    s.check("the Career Plan card with each goal's levels (now 3, aiming for 4)",
            'class="od-card od-plv"' in h and 'aria-label="Level 3 towards 4"' in h)
    s.check("the learning card sits in the narrow column beside it", "od-learn is-narrow" in h)
    h = _od(ids["hod"])
    s.check("a leader's tabs take the wide column, never the narrow one", "data-lt-tab=" in h and
            "od-learn is-narrow" not in h)
    h = _od(ids["buceo"])
    bp = h[h.find('id="od-bg-learn"'):] if 'od-bg-learn' in h else ""
    s.check("BU CEO: the picker holds the whole BU only, while the department filter is off",
            _re.findall(r'data-lunit-label="([^"]+)"', bp) == ["Whole BU"], _re.findall(r'data-lunit-label="([^"]+)"', bp))
    s.check("...and no department bars either", bp and "by department" not in bp.split('od-boxu')[0])
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO calib_dept_filter(business_group, company, view, shown) VALUES (?, 'ZZ Dash Co', 'bu', 1) "
                   "ON CONFLICT(business_group, company, view) DO UPDATE SET shown=1", (BG,))
        db.commit()
    h = _od(ids["buceo"])
    bp = h[h.find('id="od-bg-learn"'):] if 'od-bg-learn' in h else ""
    labels = _re.findall(r'data-lunit-label="([^"]+)"', bp)
    with a.app.app_context():
        want_d = sorted({r_[0] for r_ in a.get_db().execute(
            "SELECT DISTINCT department FROM users WHERE business_group=? AND company='ZZ Dash Co' AND role!='admin' AND "
            + a.calibration_population_sql(), (BG,))}, key=str.lower)
    s.check("BU CEO: with the super admin's switch on, each department of its calibration population follows the "
            "whole BU", labels == ["Whole BU"] + want_d and len(want_d) >= 2, (labels, want_d))
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM calib_dept_filter WHERE business_group=?", (BG,))
        db.commit()
    h = _od(ids["bgceo"])
    s.check("BG CEO: the same picker between cycles, All business units first",
            _re.findall(r'data-lunit-label="([^"]+)"', h)[:1] == ["All business units"])
    _env("ONEHR_DASH2", None)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key='review'", (made["cid"],))
        db.commit()

    # --- phase 5: own learning on the dashboard, a user-role setting ---------------------------------------------------
    s.section("phase 5: Roles & access › User roles has the rows")
    page = H.client_as(a, su["id"]).get("/admin/roles?tab=user").get_data(as_text=True)
    s.check("the parent row and one indented row per seat, while Learning is on",
            'data-umod="lms_self"' in page and len(re.findall(r'rl-urow is-sub"[^>]*data-umod="lms_self\.', page)) == 5,
            page.count('rl-urow is-sub'))
    _env("ONEHR_LMS", None)
    page = H.client_as(a, su["id"]).get("/admin/roles?tab=user").get_data(as_text=True)
    s.check("...and none of them where Learning is dark (production)", 'data-umod="lms_self' not in page)
    _env("ONEHR_LMS", "1")
    with a.app.app_context():
        db = a.get_db()
        full = db.execute("SELECT id FROM user_roles WHERE builtin='full'").fetchone()[0]
        s.check("every role that opens AI+ Learning has it on, seat by seat (the one-time seed)", not [
            m_ for m_ in a.UROLE_SELF_KEYS if not db.execute(
                "SELECT 1 FROM user_role_modules WHERE role_id=? AND module=?", (full, m_)).fetchone()])
        r5 = db.execute("INSERT INTO user_roles(name) VALUES ('ZZDL own learning off')").lastrowid
        made.setdefault("roles5", []).append(r5)
        db.executemany("INSERT INTO user_role_modules(role_id, module) VALUES (?,?)",
                       [(r5, m_) for m_ in ("pm", "tm_rated", "tm_rate", "competency", "idp", "lms", "results",
                                            "lms_self.own", "lms_self.lm", "lms_self.hod", "lms_self.bu", "lms_self.bg")])
        db.commit()
        u5 = dict(db.execute("SELECT * FROM users WHERE id=?", (ids["mgr"],)).fetchone())
        u5["user_role_id"] = r5
    with a.app.test_request_context("/"):
        s.check("a seat's row counts only with Own learning on (the parent) -- and Own learning only with AI+ Learning",
                a.urole_allows(u5, "lms_self.lm") is False and a.urole_allows(u5, "lms") is True)

    s.section("phase 5: the dashboard follows it, seat by seat")
    h0 = _od(ids["mgr"])
    s.check("the line manager has their Yours tab, as everyone does by default", 'data-lt-tab="mine"' in h0)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET user_role_id=? WHERE id IN (?,?,?)", (r5, ids["mgr"], ids["emp"], ids["buceo"]))
        db.commit()
    h = _od(ids["mgr"])
    s.check("own learning off: the line manager keeps their team's tab, loses Yours", 'data-lt-tab="team"' in h and
            'data-lt-tab="mine"' not in h)
    h = _od(ids["emp"])
    s.check("own learning off: the employee's own card, their Rate row and Learning this year go",
            'class="od-card od-learn' not in h and "Rate ZZDL Programme" not in h and "Learning this year" not in h)
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO user_role_modules(role_id, module) VALUES (?, 'lms_self')", (r5,))
        db.execute("DELETE FROM user_role_modules WHERE role_id=? AND module='lms_self.lm'", (r5,))
        db.commit()
    s.check("per seat: Own learning on but the line manager's row off -- Yours stays off for them",
            'data-lt-tab="mine"' not in _od(ids["mgr"]))
    s.check("...while the same role still shows the employee their own card (their own dashboard's row is on)",
            'id="od-learn-h">Your learning<' in _od(ids["emp"]))
    with a.app.app_context():
        db = a.get_db()
        reg_bu = db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, outcome, hours) "
                            "VALUES (?, (SELECT id FROM lms_sessions WHERE programme_id=? ORDER BY id LIMIT 1), ?, "
                            "'approved', 'attended', 7)", (ids["buceo"], made["prog"], made["prog"])).lastrowid
        db.commit()
    h = _od(ids["buceo"])
    s.check("BU CEO: their own learning card under the BU's, while their row is on",
            'id="od-learn-h">Your own learning<' in h)
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM user_role_modules WHERE role_id=? AND module='lms_self.bu'", (r5,))
        db.commit()
    h = _od(ids["buceo"])
    s.check("BU CEO: their row off -- no own card, and the BU's learning stays", "Your own learning<" not in h and
            "od-dept-learn" in h)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET user_role_id=NULL WHERE user_role_id=?", (r5,))
        db.commit()
        keep = [r_[0] for r_ in db.execute("SELECT module FROM user_role_modules WHERE role_id=?", (r5,))
                if r_[0] != "lms_self.hod"]
    r_ = H.client_as(a, su["id"]).post("/admin/roles?tab=user", data={"csrf_token": "tok", "action": "save",
                                                                      "roles_shown": str(r5), "u_%d" % r5: keep})
    with a.app.app_context():
        db = a.get_db()
        got = {x_[0] for x_ in db.execute("SELECT module FROM user_role_modules WHERE role_id=?", (r5,))}
        logged = db.execute("SELECT detail FROM activity_log WHERE action='user_role_access' ORDER BY id DESC LIMIT 1"
                            ).fetchone()
    s.check("the super admin unticks a seat on the matrix and saves: it's off, and the audit log says so",
            r_.status_code == 302 and "lms_self.hod" not in got and "lms_self" in got and logged and
            "When they are an HOD" in logged[0], (r_.status_code, sorted(got), logged and logged[0]))

    # --- phase 6: a Basic person (board A, Chris picked A) -------------------------------------------------------------
    s.section("phase 6: a Basic person's dashboard")
    with a.app.app_context():
        db = a.get_db()
        ids["basic"] = mk(db, "basic", None, manager_id=ids["mgr"], hod_id=ids["hod"], job_grade="14")   # no confirmation
        db.commit()
        brow = db.execute("SELECT * FROM users WHERE id=?", (ids["basic"],)).fetchone()
    with a.app.test_request_context("/"):
        s.check("they are Basic: no review of their own", a.dash_is_basic(a.get_db(), brow) is True)
    _env("ONEHR_DASH2", None)
    h = _od(ids["basic"])
    s.check("ONEHR_DASH2 off: today's -- the Not in this cycle's review card, no Basic rail", "od-notin" in h and
            "od-basic-rail" not in h)
    _env("ONEHR_DASH2", "1")
    h = _od(ids["basic"])
    s.check("their own steps on the rail, with the line that the rest opens on confirmation", "od-basic-rail" in h and
            "open here once Group People records your confirmation" in h)
    s.check("their next step is their Career Plan (no \"Nothing needs you\")", "Plan where you&#39;re growing next" in h
            and 'data-panel="plan"' in h)
    s.check("their learning card takes the Not in this cycle's review card's place", "od-notin" not in h and
            "od-learn is-narrow" in h)
    s.check("someone with a review of their own keeps the usual rail", "od-basic-rail" not in _od(ids["emp"]))
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycle_modules SET active=0 WHERE cycle_id=? AND module_key='review'", (made["cid"],))
        db.commit()
    h = _od(ids["basic"])
    s.check("between cycles: no empty results card for them -- the Career Plan leads with their learning",
            "Your record starts here" not in h and 'class="od-card od-plv"' in h)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key='review'", (made["cid"],))
        db.commit()
    _env("ONEHR_DASH2", None)
finally:
    for k, v in _ENV0.items():
        _env(k, v)
    with a.app.app_context():
        db = a.get_db()
        uids = list(ids.values())
        if made.get("rr_cid"):
            db.execute("DELETE FROM rating_records WHERE cycle_id=? AND employee_id LIKE 'ZZDL-%'", (made["rr_cid"],))
        for r5_ in made.get("roles5", []):
            db.execute("UPDATE users SET user_role_id=NULL WHERE user_role_id=?", (r5_,))
            db.execute("DELETE FROM user_role_modules WHERE role_id=?", (r5_,))
            db.execute("DELETE FROM user_roles WHERE id=?", (r5_,))
        if made.get("role"):
            db.execute("UPDATE users SET user_role_id=NULL WHERE user_role_id=?", (made["role"],))
            db.execute("DELETE FROM user_role_modules WHERE role_id=?", (made["role"],))
            db.execute("DELETE FROM user_roles WHERE id=?", (made["role"],))
        if uids:
            ph = ",".join("?" * len(uids))
            db.execute("DELETE FROM lms_registrations WHERE user_id IN (%s)" % ph, uids)
            db.execute("DELETE FROM pm_idp WHERE subject_id IN (%s)" % ph, uids)
            db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, uids)
            db.execute("DELETE FROM users WHERE id IN (%s)" % ph, uids)
        if made["prog"]:
            db.execute("DELETE FROM lms_programmes WHERE id=?", (made["prog"],))
        if made["prog2"]:
            db.execute("DELETE FROM lms_programmes WHERE id=?", (made["prog2"],))
        db.execute("DELETE FROM calib_dept_filter WHERE business_group=?", (BG,))
        if made.get("cid"):
            if made.get("review") is None:
                db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='review'", (made["cid"],))
            else:
                db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key='review'",
                           (made["review"], made["cid"]))
        for rd in made["rounds"]:
            db.execute("DELETE FROM lms_rounds WHERE id=?", (rd,))
        db.commit()
sys.exit(s.done())
