"""Dashboard demo role switcher (2026-09-14, consolidated).

The persona "Viewing as" dropdown is the ONE role/view switcher, shown on every
page (dashboard included) whenever the login is a seeded `demo_switcher`. Switching
a role drives the AI+ module cards through the EXISTING mechanism -- demo_switch /
demo_personas / current_user -- with no new route and no synthetic tiers. Real
employees never see it: `nav_demo_personas` is empty on any non-demo-seeded database.

The module-specific demo dropdowns (the PM appraisal mechanism, the Period cohort)
live in the review demo bar on /review only -- NOT on the dashboard; asserted here.

Self-contained: seeds its own ZZ persona pool in one business group, asserts against
real rendered dashboard HTML, and DELETES the pool at the end (try/finally) so the
shared scratch database is left exactly as found.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Dashboard demo switcher -- one 'Viewing as' dropdown drives the cards")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

BG = "ZZ Demo Toggle BG"          # unique -> cleanup can key on it safely
ids = {}
# the active cycle's review / pm / calibration rows, deleted below (a missing row reads as ON) and put back at the end:
# left missing, the next suite's import seeds `review` OFF (_ensure_runtime_schema), and every later suite in the
# batch lost /review (2026-10-26: test_manager_journey failed in run_parallel.sh's batch 6, two ships blocked)
_MODS_WAS = None


def dash(uid):
    return H.client_as(a, uid).get("/dashboard").get_data(as_text=True)


try:
    # --- seed a five-role persona pool in one business group -----------------
    with a.app.app_context():
        db = a.get_db()
        CID = a.active_cycle_id(db)
        s.check("there is an active cycle to test against", CID is not None, CID)
        _MODS_WAS = [dict(r) for r in db.execute(
            "SELECT * FROM cycle_modules WHERE cycle_id=? AND module_key IN ('review','pm','calibration')", (CID,))]
        for m in ("review", "pm", "calibration"):
            db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key=?", (CID, m))

        def mk(persona, **extra):
            cols = ["username", "full_name", "password_hash", "role", "employee_id",
                    "business_group", "company", "department", "demo_persona", "demo_switcher"]
            vals = ["ZZDT-" + persona, "ZZ Demo " + persona.title(), "x", "user",
                    "ZZDT-" + persona, BG, "ZZ Demo Co", "ZZ Dept", persona,
                    1 if persona == "employee" else 0]
            for k, v in extra.items():
                cols.append(k)
                vals.append(v)
            cur = db.execute("INSERT INTO users (%s) VALUES (%s)"
                             % (",".join(cols), ",".join("?" * len(cols))), vals)
            return cur.lastrowid

        ids["hod"] = mk("hod")
        ids["mgr"] = mk("manager")
        ids["buceo"] = mk("buceo", buceo_bg=BG, buceo_company="ZZ Demo Co")
        ids["bgceo"] = mk("bgceo", bgceo_bg=BG)
        ids["emp"] = mk("employee")
        db.execute("UPDATE users SET hod_id=?, manager_id=? WHERE id=?",
                   (ids["hod"], ids["mgr"], ids["emp"]))
        db.execute("UPDATE users SET hod_id=? WHERE id=?", (ids["hod"], ids["mgr"]))
        db.commit()

        plain = db.execute(
            "SELECT id FROM users WHERE role!='admin' AND left_at IS NULL "
            "AND COALESCE(demo_switcher,0)=0 AND business_group!=? LIMIT 1", (BG,)
        ).fetchone()["id"]

    # --- the persona pool resolves through demo_personas() ------------------
    s.section("the persona pool resolves through the existing mechanism")
    with a.app.app_context(), a.app.test_request_context("/"):
        db = a.get_db()
        actor = db.execute("SELECT * FROM users WHERE id=?", (ids["emp"],)).fetchone()
        keys = [p["demo_persona"] for p in a.demo_personas(actor)]
        tiers_bgceo = a.calibration_tier_of(
            db, db.execute("SELECT * FROM users WHERE id=?", (ids["bgceo"],)).fetchone())
        tiers_emp = a.calibration_tier_of(db, actor)
    s.check("demo_personas(emp) returns all five roles",
            {"employee", "manager", "hod", "buceo", "bgceo"}.issubset(set(keys)), keys)
    s.check("the bgceo persona resolves a calibration tier", bool(tiers_bgceo), tiers_bgceo)
    s.check("the employee persona resolves NO calibration tier", not tiers_emp, tiers_emp)

    # --- ONE control on /dashboard: the 'Viewing as' dropdown --------------
    s.section("the 'Viewing as' dropdown is the one role switcher on /dashboard")
    html = dash(ids["emp"])
    s.check("the 'Viewing as' dropdown renders", 'class="demo-switch__select"' in html, None)
    s.check("...it carries every persona option (e.g. bgceo)",
            'value="bgceo"' in html and 'value="hod"' in html, None)
    s.check("the OLD segmented strip is gone (no .dash-demobar)",
            'class="dash-demobar"' not in html, None)
    s.check("the PM mechanism dropdown is NOT on the dashboard (it's /review-only)",
            'name="mech"' not in html, None)
    s.check("the Period dropdown is gone (removed 2026-09-30: only the open cohort still works)",
            'name="state"' not in html, None)

    # --- gated: a plain employee sees nothing ------------------------------
    s.section("a plain employee (no demo_switcher) sees no demo control")
    phtml = dash(plain)
    s.check("plain employee sees no dropdown", 'class="demo-switch__select"' not in phtml, None)
    s.check("plain employee sees no strip", 'class="dash-demobar"' not in phtml, None)

    # --- switching a role drives the module cards --------------------------
    s.section("switching a role drives the AI+ module cards")
    c = H.client_as(a, ids["emp"])
    solo = c.get("/dashboard").get_data(as_text=True)
    s.check("Solo (employee): no AI+ Calibration card", "AI+ Calibration" not in solo, None)

    r = c.post("/demo/switch", data={"persona": "bgceo", "csrf_token": "tok", "next": "/dashboard"})
    s.check("POST /demo/switch persona=bgceo redirects", r.status_code in (301, 302), r.status_code)
    bgv = c.get("/dashboard").get_data(as_text=True)
    # the leader row shows only through the AI+ journey -- never a classic calibration page (Chris, 2026-10-10: "drop
    # the fallback links, point them to the AI+ journey")
    with a.app.test_request_context("/dashboard"):
        from flask import session as _ss
        _ss["user_id"] = ids["emp"]
        _bu = dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (ids["emp"],)).fetchone())
        _seat = bool(a.dash_calib_chat_urls(a.get_db(), _bu))
    _hrefs = re.findall(r'href="([^"#]+)"', bgv[bgv.find('class="od"'):])
    s.check("BGCEO: the leader row shows exactly when the AI+ journey has a seat for them, never a classic page",
            (("AI+ Calibration" in bgv) or ("AI+ Talent Box" in bgv)) == _seat
            and not [h for h in _hrefs if h.startswith(("/calibration", "/performance/calibration", "/talent-box"))],
            (_seat, [h for h in _hrefs if not h.startswith("/review")]))
    s.check("BGCEO: the dropdown marks BGCEO selected",
            'value="bgceo"' in bgv and "selected" in bgv, None)

    c.post("/demo/switch", data={"persona": "manager", "csrf_token": "tok", "next": "/dashboard"})
    mgv = c.get("/dashboard").get_data(as_text=True)
    s.check("Manager: no AI+ Calibration card (not a calibration tier)",
            "AI+ Calibration" not in mgv, None)

    c.post("/demo/switch", data={"persona": "employee", "csrf_token": "tok", "next": "/dashboard"})
    back = c.get("/dashboard").get_data(as_text=True)
    s.check("back to Solo: the AI+ Calibration card is gone", "AI+ Calibration" not in back, None)

    # --- the Period cohort switch is gone (2026-09-30) ---------------------
    s.section("the Period switch is removed: the demo always views the open cohort")
    r = c.post("/demo/state", data={"state": "filled", "csrf_token": "tok", "next": "/dashboard"})
    s.check("POST /demo/state no longer exists", r.status_code in (404, 405), r.status_code)
    with c.session_transaction() as _ss:
        _ss["demo_state"] = "filled"   # a session left on another cohort before the switch was removed
    with a.app.test_request_context("/"):
        from flask import session as _fs
        _fs["demo_state"] = "filled"
        s.check("...and a session left on another cohort reads the open one", a.demo_state() == "open", a.demo_state())
    s.check("...so its personas still resolve (Viewing as keeps working)",
            'class="demo-switch__select"' in c.get("/dashboard").get_data(as_text=True), None)
    s.check("the banner carries no Period dropdown and no link to the removed route",
            "demo_state_switch" not in H.source(a, "templates/base.html")
            and 'name="state"' not in H.source(a, "templates/base.html"), None)

finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE business_group=?", (BG,))
        db.execute("DELETE FROM users WHERE business_group=?", (BG,))
        if _MODS_WAS is not None:
            db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key IN ('review','pm','calibration')",
                       (CID,))
            for r in _MODS_WAS:
                db.execute("INSERT INTO cycle_modules(%s) VALUES (%s)" % (",".join(r), ",".join("?" * len(r))),
                           list(r.values()))
        db.commit()
        if _MODS_WAS is not None:
            _now = [dict(r) for r in db.execute(
                "SELECT * FROM cycle_modules WHERE cycle_id=? AND module_key IN ('review','pm','calibration')", (CID,))]
            s.check("the active cycle's review / pm / calibration rows are back as found",
                    sorted(_now, key=lambda r: r["module_key"]) == sorted(_MODS_WAS, key=lambda r: r["module_key"]),
                    (_MODS_WAS, _now))

sys.exit(s.done())
