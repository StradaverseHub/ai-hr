"""(Since 2026-10-30 the switch is the rule panel of Filters at BU level and the pills are chips of the filter line; this suite keeps the
department's own meaning: hidden unless switched on, unit by unit, read from calib_dept_filter. The registry suite pins the rest.)

The department filter, unit by unit (Chris, 2026-10-17, canvas "OneHR Calibration Filters"): "for BUCEO calibration
view for both performance and potential, hide the department filter, make it a setting configurable by super admin to
show or hide it ... for the BGCEO talent box calibration view ... similarly hide the department filter ... and make it BU
specific"; DEPT and BU labels; "Show Moved" beside the Lock. Then: "disable the dept filter by default for both staging
and production for both buceo and bgceo calibration" -- no row is hidden.

The Talent Box's own department checks (test_talent_box_chat) switch it on for their unit and put it back."""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The department filter: hidden unless the super admin switches it on, unit by unit")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, EMP = H.actors(a)
C_SU, C_BG = H.client_as(a, SU["id"]), H.client_as(a, BGA["id"])

with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("DELETE FROM calib_dept_filter")   # whatever an earlier suite left: start from the default
    db.commit()
    # a business group with two or more units in Org structure, and the people of one of them
    BG = next(r[0] for r in db.execute("SELECT business_group FROM org_units WHERE active=1 AND COALESCE(company,'')!='' "
                                       "GROUP BY business_group HAVING COUNT(*) >= 2 ORDER BY business_group"))
    U1, U2 = [r[0] for r in db.execute("SELECT company FROM org_units WHERE business_group=? AND active=1 AND "
                                        "COALESCE(company,'')!='' ORDER BY company LIMIT 2", (BG,))]
    CID = a.active_pm_period(db)["id"]

count = lambda sql, *p: H.one(a, sql, p)
rows_of = lambda: H.one(a, "SELECT COUNT(*) FROM calib_dept_filter")

s.section("off by default, everywhere")
with a.app.test_request_context("/"):
    db = a.get_db()
    s.check("no row: hidden on both views, for any unit", not a.calib_dept_filter_shown(db, BG, [U1], "bu")
            and not a.calib_dept_filter_shown(db, BG, [U1, U2], "tb") and a.calib_dept_filter_map(db, BG) == {})
    s.check("the settings row reads 'Hidden everywhere'", a._st_dept_filter(db, SU) == "Hidden everywhere",
            a._st_dept_filter(db, SU))
    s.check("an unknown view or no unit is never shown", not a.calib_dept_filter_shown(db, BG, [U1], "xx")
            and not a.calib_dept_filter_shown(db, BG, [], "bu") and not a.calib_dept_filter_shown(db, "", [U1], "bu"))

s.section("the rule on Calibration & Talent's Settings: Filters at BU level (2026-10-30, canvas Option 2; was the tag table)")
r = C_SU.get("/admin/m/calibration/settings?bfbg=%s" % BG)
html = r.get_data(as_text=True)
_bf = html[html.find('id="bu-filters"'):html.find('id="jg-filter"')]
s.check("the super admin sets the Department filter on Filters at BU level, one rule per filter (the Department card is gone)",
        r.status_code == 200 and 'id="bu-filters"' in html and "Per business group" in html and 'id="dept-filter"' not in html
        and 'data-cfr-row="dept"' in _bf and 'data-panel-open="cf-dept"' in _bf, r.status_code)
_dp = _bf[_bf.find('data-panel="cf-dept"'):_bf.find('data-panel="cf-cal"')]
s.check("...the group's units in its panel, each with a tick, none ticked while it is off everywhere; both screens offered",
        'name="unit_0"' in _dp and 'name="on_0"' in _dp and re.search(r'name="on_\d+"[^>]*checked', _dp) is None
        and 'data-cfr-screen="bu"' in _dp and 'data-cfr-screen="tb"' in _dp)
s.check("...a confirm box on Save (every admin action is double-confirmed)",
        'data-confirm-title="Save the Department filter?"' in html and 'data-confirm-ok="Save filter"' in html)
rb = C_BG.get("/admin/m/calibration/settings")
s.check("a BG admin reads it, can't change it", rb.status_code == 200 and "Only a super admin changes this" in
        rb.get_data(as_text=True) and 'data-cfr-form' not in rb.get_data(as_text=True), rb.status_code)

s.section("Set every unit is gone: the panel's own 'Tick every unit that has one' stands in (the registry suite pins the rest)")
s.check("no pop-up, no tag table", "data-bf-all" not in html and "Set every unit" not in html and "bf-tag" not in html)
s.check("the panel carries the tick-all link and saves only through the form's own Save and its confirm box",
        "Tick every unit that has one" in _dp and 'action="/admin/settings/calib-filter"' in _dp and "data-cfr-save" in _dp)

s.section("saving: the super admin only, one business group, only the units the form showed")


def post(client, units=(), screens=("bu", "tb"), extra=None):
    data = {"csrf_token": "tok", "filter": "dept", "bg": BG}
    for i, co in enumerate((U1, U2)):
        data["unit_%d" % i] = co
        if co in units:
            data["on_%d" % i] = "1"
    data.update(extra or {})
    data["screen"] = list(screens)
    return client.post("/admin/settings/calib-filter", data=data)


before = rows_of()
rb = post(C_BG, units=[U1], screens=["tb"])
s.check("a BG admin's save is refused and writes nothing", rb.status_code in (302, 403) and rows_of() == before
        and not H.one(a, "SELECT COUNT(*) FROM calib_dept_filter WHERE shown=1"), (rb.status_code, rows_of()))
logs0 = count("SELECT COUNT(*) FROM activity_log WHERE action='settings' AND detail LIKE 'Filters at BU level, %'")
r = post(C_SU, units=[U1], screens=["tb"])
with a.app.test_request_context("/"):
    db = a.get_db()
    on_tb, on_bu = a.calib_dept_filter_shown(db, BG, [U1], "tb"), a.calib_dept_filter_shown(db, BG, [U1], "bu")
    other = a.calib_dept_filter_shown(db, BG, [U2], "tb")
    st = a._st_dept_filter(db, SU)
s.check("switched on for one unit's Talent Box: that unit and screen only (calib_dept_filter, as ever)",
        r.status_code == 302 and on_tb and not on_bu and not other, (r.status_code, on_tb, on_bu, other))
s.check("...one activity row naming the change", count("SELECT COUNT(*) FROM activity_log WHERE action='settings' AND "
        "detail LIKE 'Filters at BU level, %'") == logs0 + 1)
s.check("...and the settings row says so", st == "Shown for 0 units in the BU CEO calibration · 1 unit in the BG CEO "
        "Talent Box", st)
s.check("...it goes back to the same business group's card", r.headers.get("Location", "").endswith("#bu-filters")
        and "bfbg=" in r.headers.get("Location", ""), r.headers.get("Location"))
with a.app.test_request_context("/"):
    db = a.get_db()
    s.check("units calibrated together show it when any one of them has it on",
            a.calib_dept_filter_shown(db, BG, [U2, U1], "tb") and not a.calib_dept_filter_shown(db, BG, [U2], "tb"))
r = C_SU.post("/admin/settings/calib-filter", data={"csrf_token": "tok", "filter": "dept", "bg": BG, "unit_1": U2,
                                                    "on_1": "1", "screen": ["bu"]})
with a.app.test_request_context("/"):
    db = a.get_db()
    s.check("a unit the form didn't send is left exactly as it was (absent never clears)",
            r.status_code == 302 and a.calib_dept_filter_shown(db, BG, [U1], "tb") and a.calib_dept_filter_shown(db, BG, [U2], "bu"))
r = post(C_SU, units=[U1], screens=["tb"], extra={"unit_5": "ZZ no such unit", "on_5": "1"})
s.check("a unit outside the business group refuses the save and is never written", not count(
    "SELECT COUNT(*) FROM calib_dept_filter WHERE company='ZZ no such unit'"))
r = post(C_SU, units=[], screens=["bu", "tb"])
with a.app.test_request_context("/"):
    db = a.get_db()
    s.check("switched off again: sent with no tick, both hidden",
            not a.calib_dept_filter_shown(db, BG, [U1, U2], "tb") and not a.calib_dept_filter_shown(db, BG, [U1, U2], "bu")
            and a._st_dept_filter(db, SU) == "Hidden everywhere")

s.section("the BU CEO's calibration card carries it")
with a.app.test_request_context("/"):
    db = a.get_db()
    pop = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND business_group=? AND company=? "
                     "ORDER BY id LIMIT 3", (BG, U1)).fetchall()
    ctx = {"period": {"id": CID}, "population": pop, "session": None, "overalls": {},
           "scope_key": U1, "scope_label": U1, "business_group": BG}
    ov_off = a._pm_calib_assist_overview(db, SU, dict(ctx), "buceo", {"bg": BG, "company": U1})["data"]
    db.execute("INSERT OR REPLACE INTO calib_dept_filter(business_group, company, view, shown) VALUES (?, ?, 'bu', 1)",
               (BG, U1))
    db.commit()
    ov_on = a._pm_calib_assist_overview(db, SU, dict(ctx), "buceo", {"bg": BG, "company": U1})["data"]
    ov_hod = a._pm_calib_assist_overview(db, SU, dict(ctx, scope_key="9001"), "hod", {"hod_id": 9001})["data"]
    db.execute("DELETE FROM calib_dept_filter WHERE business_group=? AND company=?", (BG, U1))
    db.commit()
s.check("performance: off by default, on once switched on for the unit, never for an HOD's review",
        ov_off.get("dept_filter") is False and ov_on.get("dept_filter") is True and ov_hod.get("dept_filter") is False,
        (ov_off.get("dept_filter"), ov_on.get("dept_filter"), ov_hod.get("dept_filter")))
SRC = H.source(a, "app.py")
s.check("potential: the same flag, from the unit(s) on screen",
        '**(calib_card_filters(db, ctx, key[0]) if tier == "buceo"' in SRC   # 2026-11-02: through calib_card_filters
        and '"dept_filter": calib_dept_filter_shown(db, bg, units, view),' in SRC)
s.check("the org rename carries it with its unit (a settings table)", "calib_dept_filter" in a._ORG_SETTINGS_TABLES)

s.section("the client")
JS = H.chat_js(a)
CSS = H.source(a, "static/style.css")


def fn(name):
    i = JS.find("function %s(" % name)
    return JS[i:JS.find("\n  }\n", i)] if i >= 0 else ""


fbar, fline, mv, cw, tbw = fn("calFilterBar"), fn("calFilterLine"), fn("calMovedBtn"), fn("calibWidget"), fn("talentBoxWidget")
s.check("BU CEO: the department is a chip of the filter line, only where switched on (d.filters); no bar at all when it holds nothing",
        'if (f.key === "dept"' in fline and "String(r.department || \"\").trim()" in fline
        and "return bar.children.length ? bar : null;" in fbar and "Moved only" not in fbar)
s.check("BU CEO: no department lens without the row",
        'if (!d.dept_filter) cf.dept = [];' in cw and "var fbar = calFilterBar(d); if (fbar) box.appendChild(fbar);" in cw)
s.check("BU CEO: Show moved is the Talent Box's button, beside the Lock",
        'b.className = "rv-tbox-showmoved rv-cal-showmoved";' in mv and 'b.appendChild(document.createTextNode("Show moved"));'
        in mv and "lbx.insertBefore(mvb, lfm)" in cw and ".rv-cal-lockbox > .rv-cal-showmoved {" in CSS)
s.check("BG CEO: the BU row labelled BU; the department is a chip of the filter line under it (a Group Chief's batches are its Segment chip)",
        'rmkEl("span", "rv-grp-flbl rv-tbox-rowlbl", "BU")' in tbw and "var frow = tbFilterLine(d);" in tbw
        and "tbDeptRow" not in tbw and ".rv-tbox-rowlbl { flex: none; width: 40px; }" in CSS)

with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("DELETE FROM calib_dept_filter")   # put back: the default
    db.commit()

sys.exit(s.done())
