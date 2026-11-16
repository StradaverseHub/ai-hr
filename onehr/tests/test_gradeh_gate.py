"""Grade H Appraisal, piece 1: the gate, the cycle module, the tables (2026-10-28; spec OneHR/JG H Appraisal/BUILD-SPEC.md).

What this suite holds:
  * ONEHR_GRADEH off (or unset): every Grade H path answers 404 to a signed-in person, passes a signed-out one on to the
    sign-in redirect; on: the gate lets it through. Read on every call.
  * the cycle module `gradeh`: Year-End cycles only (an Early or Mid-Year cycle never lists it, never enables it, even
    with a stored row), opt-in (absence is OFF), and the server switch is checked too; CYCLE_MODULE_KEYS stays six
  * its prefixes are classified (module_of_request), /admin/gradeh is never module-gated, the older prefixes are untouched
  * the tables exist, SCHEMA holds _GRADEH_DDL word for word, and the DDL runs twice without harm
"""
import os
import re
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Grade H Appraisal: gate, cycle module, tables")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, EMP = H.actors(a)
_ENV0 = os.environ.get("ONEHR_GRADEH")


def env(v):
    if v is None:
        os.environ.pop("ONEHR_GRADEH", None)
    else:
        os.environ["ONEHR_GRADEH"] = v


# Piece 1 has no routes of its own, and the module gate only judges a path that has an endpoint: stand-in probes for the
# four prefixes, registered before any request is served (the scratch app only; nothing here ships).
for _i, _p in enumerate(("/my-appraisal", "/review/gradeh/x", "/calibration/gradeh/x", "/admin/gradeh/x")):
    a.app.add_url_rule(_p, "zz_gradeh_probe_%d" % _i, lambda: "ok", methods=["GET", "POST"])


def gate(path, uid, method="GET"):
    """What the before_request chain makes of a path: 'pass' (None), or the status code it answers."""
    with a.app.test_request_context(path, method=method, data={"csrf_token": "tok"} if method == "POST" else None):
        if uid:
            a.session["user_id"] = uid
            a.session["csrf_token"] = "tok"
        try:
            r = a.app.preprocess_request()
        except Exception as e:  # noqa: BLE001 -- werkzeug's NotFound
            return getattr(e, "code", repr(e))
        if r is None:
            return "pass"
        return r[1] if isinstance(r, tuple) else r.status_code


try:
    s.section("the machinery")
    for name in ("gradeh_on", "gradeh_module_on", "gradeh_cycle_offered", "_gradeh_gate", "GRADEH_PATHS", "GRADEH_MODULE_KEY"):
        s.check("%s present" % name, hasattr(a, name))
    s.check("the module key is gradeh", a.GRADEH_MODULE_KEY == "gradeh")
    s.check("the six older modules stay six and gradeh is not among them (absence there means ON)",
            len(a.CYCLE_MODULE_KEYS) == 6 and "gradeh" not in a.CYCLE_MODULE_KEYS)
    s.check("four path prefixes", set(a.GRADEH_PATHS) == {"/my-appraisal", "/review/gradeh", "/calibration/gradeh", "/admin/gradeh"},
            a.GRADEH_PATHS)

    s.section("the server switch: dark unless ONEHR_GRADEH=1, read on every call")
    env(None)
    s.check("unset: gradeh_on() is False", a.gradeh_on() is False)
    env("0")
    s.check("'0': off", a.gradeh_on() is False)
    env("true")
    s.check("'true' is not '1': off", a.gradeh_on() is False)
    env("1")
    s.check("'1': on", a.gradeh_on() is True)
    env(None)
    s.check("and off again at once", a.gradeh_on() is False)

    PATHS = [p + sfx for p in a.GRADEH_PATHS for sfx in ("", "/x", "/x/y")]
    s.section("off: signed-in 404, signed-out passes to the sign-in redirect")
    env(None)
    got = {p: gate(p, SU["id"]) for p in PATHS}
    s.check("a signed-in super admin gets 404 on every Grade H path", all(v == 404 for v in got.values()),
            [k for k, v in got.items() if v != 404])
    got = {p: gate(p, EMP["id"]) for p in PATHS}
    s.check("a signed-in employee gets 404 on every Grade H path", all(v == 404 for v in got.values()))
    got = {p: gate(p, EMP["id"], "POST") for p in PATHS}
    s.check("a write gets 404 too", all(v == 404 for v in got.values()))
    got = {p: gate(p, None) for p in PATHS}
    s.check("signed out passes (the route's own sign-in redirect; the deploy's probe reads it)",
            all(v == "pass" for v in got.values()), got)
    for p in ("/my-appraisalx", "/review", "/review/journey", "/calibration", "/admin", "/admin/gradeh-not", "/"):
        s.check("a path outside the prefixes is not the gate's: %s" % p, gate(p, EMP["id"]) != 404 or p in ("/review/journey",),
                gate(p, EMP["id"]))
    s.check("the gate itself is silent outside the prefixes", all(
        a.app.test_request_context(p).__enter__() is not None and a._gradeh_gate() is None
        for p in ("/my-appraisalx", "/admin/gradeh-not", "/calibration/x")))

    s.section("on: the gate lets it through (the cycle module then decides)")
    env("1")
    with a.app.test_request_context("/my-appraisal"):
        a.session["user_id"] = EMP["id"]
        s.check("on: _gradeh_gate returns None for a signed-in employee", a._gradeh_gate() is None)
    with a.app.test_request_context("/admin/gradeh/x"):
        a.session["user_id"] = SU["id"]
        s.check("on: ...and for the super admin's pages", a._gradeh_gate() is None)

    s.section("the cycle module: Year-End only, opt-in")
    with a.app.app_context():
        db = a.get_db()
        CID = a.active_cycle_id(db)
        half0 = db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0]

    def set_half(h):
        with a.app.app_context():
            db = a.get_db()
            db.execute("UPDATE cycles SET half=? WHERE id=?", (h, CID))
            db.commit()

    def set_row(active):
        with a.app.app_context():
            db = a.get_db()
            if active is None:
                db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
            else:
                db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', ?) "
                           "ON CONFLICT(cycle_id, module_key) DO UPDATE SET active=excluded.active", (CID, active))
            db.commit()

    def mod_on(cid=None):
        with a.app.app_context():
            return a.gradeh_module_on(a.get_db(), cid or CID)

    def offered():
        with a.app.app_context():
            return a.gradeh_cycle_offered(a.get_db().execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone())

    env("1")
    set_half(2)
    set_row(None)
    s.check("a Year-End is offered the module", offered() is True)
    s.check("no row: OFF (opt-in, unlike every older module)", mod_on() is False)
    with a.app.app_context():
        s.check("cycle_module_on('gradeh') says the same", a.cycle_module_on("gradeh", a.get_db(), CID) is False)
    set_row(0)
    s.check("a row with active=0: OFF", mod_on() is False)
    set_row(1)
    s.check("a row with active=1 on a Year-End: ON", mod_on() is True)
    with a.app.app_context():
        s.check("cycle_module_on('gradeh') follows", a.cycle_module_on("gradeh", a.get_db(), CID) is True)
    env(None)
    s.check("with the server switch off the row counts for nothing", mod_on() is False and offered() is False)
    env("1")
    for h, nm in ((0, "an Early Year"), (1, "a Mid-Year")):
        set_half(h)
        set_row(1)
        s.check("%s is never offered" % nm, offered() is False, h)
        s.check("%s never runs it, even with a stored row active=1" % nm, mod_on() is False, h)
    set_half(2)

    s.section("the module gate follows: off means off")
    set_row(None)
    for p in ("/my-appraisal", "/review/gradeh/x", "/calibration/gradeh/x"):
        r = gate(p, EMP["id"])
        s.check("module off on a Year-End: %s is 404 for a signed-in person" % p, r == 404, r)
        s.check("...signed out passes", gate(p, None) == "pass")
        s.check("...a write is 404", gate(p, EMP["id"], "POST") == 404)
    s.check("/admin/gradeh is never module-gated (the admin configures it while it is off)",
            gate("/admin/gradeh/x", SU["id"]) == "pass")
    set_row(1)
    for p in ("/my-appraisal", "/review/gradeh/x", "/calibration/gradeh/x"):
        s.check("module on: %s passes the gates" % p, gate(p, EMP["id"]) == "pass", gate(p, EMP["id"]))
    set_half(1)
    s.check("the same cycle switched to a Mid-Year closes it again (row still active=1)",
            gate("/my-appraisal", EMP["id"]) == 404)
    set_half(2)
    with a.app.test_request_context("/my-appraisal"):
        a.session["user_id"] = EMP["id"]
        set_row(None)
        pg = a._module_gate()
        body = pg[0] if isinstance(pg, tuple) else pg
        body = body if isinstance(body, str) else ""
        s.check("the staff 'module off' page says My Appraisal, never Grade H",
                "My Appraisal" in body and "Grade H" not in body and "JG H" not in body)

    s.section("Modules on this cycle lists it on a Year-End only")
    C_SU = H.client_as(a, SU["id"])
    def listed(h, server_on="1"):
        set_half(h)
        env(server_on)
        t = C_SU.get("/admin/cycle?cycle=%d" % CID).get_data(as_text=True)
        return 'value="gradeh"' in t
    s.check("Year-End, server on: listed", listed(2) is True)
    s.check("Mid-Year: not listed", listed(1) is False)
    s.check("Early Year: not listed", listed(0) is False)
    s.check("Year-End but the server is off: not listed", listed(2, None) is False)
    set_half(2)
    env("1")
    set_row(None)
    shown = [k for k in a.CYCLE_MODULE_KEYS if k not in a.PARKED_MODULES]
    C_SU.post("/admin/cycles", data={"csrf_token": "tok", "action": "set_modules", "cycle_id": str(CID),
                                     "module": shown + ["gradeh"]})
    s.check("ticking it on a Year-End stores active=1",
            H.one(a, "SELECT active FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,)) == 1)
    C_SU.post("/admin/cycles", data={"csrf_token": "tok", "action": "set_modules", "cycle_id": str(CID), "module": shown})
    s.check("unticking stores active=0",
            H.one(a, "SELECT active FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,)) == 0)
    set_row(None)
    set_half(1)
    C_SU.post("/admin/cycles", data={"csrf_token": "tok", "action": "set_modules", "cycle_id": str(CID),
                                     "module": shown + ["gradeh"]})
    s.check("a Mid-Year's save, even forged with gradeh, stores nothing for it",
            H.one(a, "SELECT COUNT(*) FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,)) == 0)
    set_half(half0)

    s.section("every Grade H prefix is classified")
    with a.app.test_request_context("/"):
        for p, want in (("/my-appraisal", "gradeh"), ("/my-appraisal/x", "gradeh"), ("/review/gradeh", "gradeh"),
                        ("/review/gradeh/x", "gradeh"), ("/calibration/gradeh/x", "gradeh"),
                        ("/admin/gradeh", None), ("/admin/gradeh/x", None),
                        ("/calibration/bg/lock", "calibration"), ("/calibration", "calibration"),
                        ("/performance", "pm"), ("/idp", "idp"), ("/review/gradeh-not", None)):
            s.check("module_of_request(%s) = %s" % (p, want), a.module_of_request("zz_endpoint", p) == want,
                    a.module_of_request("zz_endpoint", p))
    s.check("the module has a label", a.CYCLE_MODULE_LABELS.get("gradeh") == "Grade H Appraisal")

    s.section("the tables")
    TABLES = {
        "gradeh_people": ("cycle_id", "employee_id", "user_id", "route", "appraiser_id", "hr_supervisor_employee_id",
                          "hr_supervisor_name", "language", "private_company"),
        "gradeh_kpi_lines": ("cycle_id", "person_id", "kpi_name", "weight", "group_scale", "sort_order"),
        "gradeh_appraisals": ("cycle_id", "person_id", "staff_submitted_at", "b_achievements", "b_strengths",
                              "b_development", "b_lp_focus", "b_lp_how", "promo_nominate", "promo_reason",
                              "conversation_held", "lm_submitted_at", "perf_band", "pot_band", "acknowledged_at",
                              "deemed_at", "ack_in_person", "ack_in_person_on"),
        "gradeh_kpi_entries": ("cycle_id", "person_id", "line_id", "staff_pct", "lm_pct", "lm_reason", "lm_rating"),
        "gradeh_ratings": ("cycle_id", "person_id", "attr_key", "rating"),
        "gradeh_lp_answers": ("cycle_id", "person_id", "lp", "stmt", "answer"),
        "gradeh_band_moves": ("cycle_id", "person_id", "axis", "stage", "band", "came_in", "remark", "by_user_id"),
        "gradeh_signoffs": ("cycle_id", "tier", "stage", "scope_key", "signed_by", "signed_at", "off_curve_reason"),
        "gradeh_releases": ("cycle_id", "unit", "released_by", "released_at"),
    }
    with a.app.app_context():
        db = a.get_db()
        for t, cols in TABLES.items():
            have = [r[1] for r in db.execute("PRAGMA table_info(%s)" % t)]
            s.check("%s exists with its columns" % t, bool(have) and all(c in have for c in cols),
                    [c for c in cols if c not in have])
            s.check("%s is created empty" % t, db.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0] == 0)

    def norm(t):
        return re.sub(r"\s+", " ", t).strip()
    s.check("SCHEMA holds _GRADEH_DDL word for word", norm(a._GRADEH_DDL) in norm(a.SCHEMA))
    s.check("the harness's ast read of SCHEMA (a virgin database) has the tables too",
            "gradeh_band_moves" in H.extract_schema())
    con = sqlite3.connect(":memory:")
    con.execute("PRAGMA foreign_keys=ON")
    con.executescript("CREATE TABLE cycles(id INTEGER PRIMARY KEY); CREATE TABLE users(id INTEGER PRIMARY KEY);")
    for _ in range(2):
        for st in a._GRADEH_DDL.split(";"):
            if st.strip():
                con.execute(st)
    s.check("the DDL runs twice on an empty database (IF NOT EXISTS)", True)
    con.execute("INSERT INTO cycles(id) VALUES (1)")
    con.execute("INSERT INTO gradeh_people(cycle_id, employee_id, route) VALUES (1,'ZZ1','A')")
    for bad in ("INSERT INTO gradeh_people(cycle_id, employee_id, route) VALUES (1,'ZZ2','C')",
                "INSERT INTO gradeh_people(cycle_id, employee_id, route) VALUES (1,'ZZ1','B')",
                "INSERT INTO gradeh_ratings(cycle_id, person_id, attr_key, rating) VALUES (1,1,'k',6)",
                "INSERT INTO gradeh_lp_answers(cycle_id, person_id, lp, stmt, answer) VALUES (1,1,1,1,'maybe')",
                "INSERT INTO gradeh_band_moves(cycle_id, person_id, axis, stage, band, remark) VALUES (1,1,'perf','lm','UA','x')"):
        try:
            con.execute(bad)
            ok = False
        except sqlite3.IntegrityError:
            ok = True
        s.check("a bad row is refused by the table: %s" % bad[:70], ok)
    con.close()
finally:
    env(_ENV0)

sys.exit(s.done())
