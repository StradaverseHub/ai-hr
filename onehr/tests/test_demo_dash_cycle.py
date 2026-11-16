"""The demo's cycle switch on the dashboard (Chris, 2026-10-12: "on the demo, can we also make the cycle selectable so i
can view the dashboard look for offcycle time").

The demo's own cycle is open, so a demo login only ever saw the running dashboard. A seeded demo login (one with
personas, the same boundary as the "Viewing as" switch) picks a past cycle in the top bar, and the dashboard shows its
record view as it stood after that cycle: that cycle's journey and results, the history up to it, and the cycle after
it as the next one.

What this suite holds:
  * only a demo login sees it, only on the dashboard; its route 404s for everyone else
  * it offers the cycles before the active one, never the active one or one that sorts after it; a tampered value 400s
  * picked: the record view as of that cycle -- the history stops at it, the next cycle is the one after it, nothing of
    the open cycle shows (Ask OneHR reads the same); "running" brings the live dashboard back
  * it holds across a persona switch, writes nothing, and opens What you led on the record's own cycle

Self-contained: seeds its own personas, cycles and one released report, and deletes them at the end.
"""
import inspect
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Demo cycle switch -- the dashboard between cycles, on the demo only")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

BG = "ZZ Demo Cycle BG"
ids, cyc = {}, {}


def dash(c):
    return c.get("/dashboard").get_data(as_text=True)


def picker(html):
    """The cycle switch's form, or '' when the page has none."""
    i = html.find('action="/demo/dashboard-cycle"')
    return html[i:html.find("</form>", i)] if i >= 0 else ""


try:
    with a.app.app_context():
        db = a.get_db()
        NOW = a._today_myt().year
        ACT = db.execute("SELECT id, name FROM cycles WHERE is_active=1").fetchone()
        s.check("there is an active cycle to test against", ACT is not None)
        db.execute("DELETE FROM cycles WHERE code LIKE 'ZZDC-%'")
        for k, y in (("old", NOW - 7), ("new", NOW - 6)):
            cyc[k] = db.execute("INSERT INTO cycles(code, name, is_active, year, half, ends_on) VALUES (?,?,0,?,2,?)",
                                ("ZZDC-" + k, "ZZDC %d Year-End" % y, y, "%d-12-31" % y)).lastrowid

        def mk(persona, **extra):
            cols = ["username", "full_name", "password_hash", "role", "employee_id", "business_group", "company",
                    "department", "demo_persona", "demo_switcher"]
            vals = ["ZZDC-" + persona, "ZZ Demo " + persona.title(), "x", "user", "ZZDC-" + persona, BG, "ZZ Demo Co",
                    "ZZ Dept", persona, 1 if persona == "employee" else 0]
            for k_, v_ in extra.items():
                cols.append(k_)
                vals.append(v_)
            return db.execute("INSERT INTO users (%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                              vals).lastrowid

        ids["mgr"] = mk("manager")
        ids["emp"] = mk("employee", manager_id=ids["mgr"])
        ids["plain"] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, "
                                  "business_group, company, department) VALUES ('zzdc-plain','ZZDC Plain','x','user',"
                                  "'ZZDC-PLAIN',?,'ZZ Demo Co','ZZ Dept')", (BG,)).lastrowid
        # the employee persona holds a released 360 report in both seeded cycles: one history row each
        for k in ("old", "new"):
            db.execute("INSERT INTO report_releases(cycle_id, subject_id) VALUES (?,?)", (cyc[k], ids["emp"]))
        db.commit()
        allc = [r["id"] for r in db.execute("SELECT id FROM cycles ORDER BY year DESC, half DESC, id DESC")]
        PAST = allc[allc.index(ACT["id"]) + 1:]
        NEWER = allc[:allc.index(ACT["id"])]
        AFTER_OLD = allc[allc.index(cyc["old"]) - 1]

    E = H.client_as(a, ids["emp"])
    P = H.client_as(a, ids["plain"])

    s.section("only a demo login sees it, only on the dashboard")
    ph = dash(P)
    s.check("a real login: no cycle switch on the dashboard", not picker(ph) and 'name="cycle"' not in ph)
    s.check("...and its route 404s for them", P.post("/demo/dashboard-cycle", data={
        "csrf_token": "tok", "cycle": str(cyc["old"])}).status_code == 404)
    eh = dash(E)
    pk = picker(eh)
    s.check("a demo login: the switch is on the dashboard, beside Viewing as", bool(pk) and 'class="demo-switch__select"' in pk)
    s.check("...offering every cycle before the active one, as 'After <cycle>'",
            all('value="%d"' % c in pk for c in PAST) and ("After ZZDC %d Year-End" % (NOW - 6)) in pk, PAST)
    s.check("...never the active cycle or one that sorts after it",
            'value="%d"' % ACT["id"] not in pk and not any('value="%d"' % c in pk for c in NEWER), NEWER)
    s.check("...the first choice is the running cycle, the live dashboard", ('value="">%s · running' % ACT["name"]) in pk)
    s.check("not on other pages", not picker(E.get("/account/password").get_data(as_text=True)))
    s.check("unclassified pages stay closed: the route belongs to no module, like the persona switch",
            "demo_dash_cycle" in a.MODULE_UNGATED_ENDPOINTS)

    s.section("tampering")
    for bad in (str(ACT["id"]), "abc", "99999999") + tuple(str(c) for c in NEWER):
        r = E.post("/demo/dashboard-cycle", data={"csrf_token": "tok", "cycle": bad})
        s.check("cycle=%s is refused (400)" % bad, r.status_code == 400, r.status_code)
    with E.session_transaction() as ss:
        ss["demo_dash_cycle"] = ACT["id"]   # a session value that names the active cycle is ignored
    s.check("a session naming the active cycle shows the live dashboard", 'selected' not in picker(dash(E)))

    s.section("picked: the record view as it stood after that cycle")
    r = E.post("/demo/dashboard-cycle", data={"csrf_token": "tok", "cycle": str(cyc["old"])})
    s.check("picking a past cycle goes back to the dashboard", r.status_code in (301, 302)
            and r.headers.get("Location", "").endswith("/dashboard"), r.headers.get("Location"))
    oh = dash(E)
    s.check("...the switch shows it picked", ('value="%d" selected' % cyc["old"]) in picker(oh))
    with a.app.app_context():
        nxt = a._cycle_label(a.get_db().execute("SELECT name FROM cycles WHERE id=?", (AFTER_OLD,)).fetchone()["name"])
    s.check("...the record view, the top bar naming the cycle after it as the next (top panel A, 2026-10-15)",
            'class="tb-cycle is-between"' in oh and ("Next: %s" % nxt) in oh
            and "where the cycle is, and you in it" not in oh, nxt)
    s.check("...its history stops at that cycle", "ZZDC %d Year-End" % (NOW - 7) in oh
            and "ZZDC %d Year-End" % (NOW - 6) not in oh.split('id="od-records-tpl"')[1].split("</template>")[0])
    with a.app.test_request_context("/dashboard"):
        from flask import session as _fs
        _fs["user_id"] = ids["emp"]
        _fs["demo_dash_cycle"] = cyc["old"]
        db = a.get_db()
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (ids["emp"],)).fetchone())
        ao = a.demo_dash_as_of(db)
        ctx = a._dash_context(db, u)
        lines, _l = a._ask_facts(db, u, ctx)
        s.check("demo_dash_as_of: the cycle, every cycle up to it, the one after it",
                ao and ao["id"] == cyc["old"] and cyc["new"] not in ao["upto"] and cyc["old"] in ao["upto"]
                and ao["next"]["id"] == AFTER_OLD, ao and (ao["id"], ao["next"]))
        s.check("...the dashboard's context: the record, the history up to it, nothing of the open cycle",
                ctx["mode"] == "record" and ctx["rail"] is None and ctx["cycle"] is None and ctx["period"] is None
                and [r_["cycle_id"] for r_ in ctx["record_all"]] == [cyc["old"]]
                and ctx["rec"]["last"]["cycle_id"] == cyc["old"],
                (ctx["mode"], [r_["cycle_id"] for r_ in ctx["record_all"]]))
        s.check("...so Ask OneHR reads it the same way: no cycle open", any("no cycle is open" in l_ for l_ in lines))
        _rep = next((t for t in ctx["tool_cards"] if t["key"] == "report"), None)
        s.check("...and the 360 tool card names no later report", _rep is None or "ZZDC %d" % (NOW - 6) not in
                (_rep["line1"] + _rep["line2"]), _rep)
        s.check("...and a plan check-in is open, as between cycles", a.plan_checkin_open(db, u) is True)
        _fs.pop("demo_dash_cycle")
        ctx2 = a._dash_context(db, u)
        s.check("without it: the whole history again", cyc["new"] in [r_["cycle_id"] for r_ in ctx2["record_all"]])

    s.section("it holds across a persona switch, and 'running' brings the live dashboard back")
    E.post("/demo/switch", data={"persona": "manager", "csrf_token": "tok", "next": "/dashboard"})
    s.check("switching to the manager persona keeps the cycle", ('value="%d" selected' % cyc["old"]) in picker(dash(E)))
    E.post("/demo/switch", data={"persona": "employee", "csrf_token": "tok", "next": "/dashboard"})
    r = E.post("/demo/dashboard-cycle", data={"csrf_token": "tok", "cycle": ""})
    lh = dash(E)
    s.check("'running' clears it: nothing picked, no next cycle named",
            r.status_code in (301, 302) and "selected" not in picker(lh) and "Next: %s" % nxt not in lh)
    with E.session_transaction() as ss:
        s.check("...and the session holds no cycle", "demo_dash_cycle" not in ss)

    s.section("read-only, and What you led opens on the record's own cycle")
    _src = inspect.getsource(a.demo_dash_cycle)
    s.check("the route only sets the session: no write", "db.execute" not in _src and "commit" not in _src)
    s.check("What you led's button opens the panel on the card's cycle (not the active one)",
            "data-panel=\"led\"{% if L['cycle_id'] or L['period_id'] %} data-arg=" in H.source(a, "templates/dashboard.html"))

finally:
    with a.app.app_context():
        db = a.get_db()
        for k in cyc.values():
            db.execute("DELETE FROM report_releases WHERE cycle_id=?", (k,))
        _ids = [r[0] for r in db.execute("SELECT id FROM users WHERE business_group=?", (BG,))]
        for _uid in _ids:
            db.execute("DELETE FROM record_snapshots WHERE subject_id=?", (_uid,))
            db.execute("DELETE FROM activity_log WHERE user_id=? OR target_user_id=?", (_uid, _uid))
        db.execute("UPDATE users SET manager_id=NULL WHERE business_group=?", (BG,))
        db.execute("DELETE FROM users WHERE business_group=?", (BG,))
        db.execute("DELETE FROM cycles WHERE code LIKE 'ZZDC-%'")
        db.commit()

sys.exit(s.done())
