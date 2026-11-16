"""The job grade filter (Chris, 2026-10-21, canvas "OneHR JG Filter", [design canvas link removed]):
"can we add one more configuration for JG display? ... ideally in the row filter. Make it more flexible like super admin
can define the band of JG12-14, 15-18, 19 and above, or just individual JG as selection filter", built as Max
recommended ("ok go ahead"): a JG pill row under the DEPT row, shown per unit and view like the department filter
(hidden by default), the grades grouped per business group (named bands seeded 12-14 / 15-18 / 19 and above, or each
grade on its own), the picked group's own curve with the whole unit faintly, counts only under 10 people, super admin
only to change.

The Talent Box's own JG checks are in test_talent_box_chat."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The job grade filter: grouped per business group, shown unit by unit")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, EMP = H.actors(a)
C_SU, C_BG = H.client_as(a, SU["id"]), H.client_as(a, BGA["id"])

with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("DELETE FROM calib_jg_filter")   # whatever an earlier suite left: start from the default
    db.execute("DELETE FROM calib_jg_bands")
    db.commit()
    BG = next(r[0] for r in db.execute("SELECT business_group FROM org_units WHERE active=1 AND COALESCE(company,'')!='' "
                                       "GROUP BY business_group HAVING COUNT(*) >= 2 ORDER BY business_group"))
    U1, U2 = [r[0] for r in db.execute("SELECT company FROM org_units WHERE business_group=? AND active=1 AND "
                                        "COALESCE(company,'')!='' ORDER BY company LIMIT 2", (BG,))]
    CID = a.active_pm_period(db)["id"]
    CYC = a.active_cycle(db)
    MG0 = CYC["min_job_grade"]
    db.execute("UPDATE cycles SET min_job_grade=12 WHERE id=?", (CYC["id"],))   # the Year-End's floor, put back below
    db.commit()

count = lambda sql, *p: H.one(a, sql, p)
B = lambda lo, hi, name="": {"name": name, "lo": lo, "hi": hi}

s.section("the rules: default bands, keys, pills")
with a.app.test_request_context("/"):
    db = a.get_db()
    cfg = a.calib_jg_config(db, BG)
    s.check("no row: the default bands 12-14 / 15-18 / 19 and above, marked not set",
            cfg["mode"] == "bands" and not cfg["set"] and [a.calib_jg_band_name(b) for b in cfg["bands"]] == [
                "JG 12–14", "JG 15–18", "JG 19 and above"], cfg)
    s.check("a grade's pill: its band's key; a letter grade or one under every band is Other",
            [a.calib_jg_key_of(cfg, g) for g in (12, "14", 15, 18, 19, 23, "H", None, 9)] ==
            ["12-14", "12-14", "15-18", "15-18", "19-", "19-", "other", "other", "other"])
    each = {"mode": "each", "bands": []}
    s.check("each grade on its own: the grade itself", a.calib_jg_key_of(each, "16") == "16"
            and a.calib_jg_key_of(each, "GM") == "other")
    opts = a.calib_jg_options(cfg, [13, 13, 14, 20, "H"])
    s.check("the pills: bands in order, an empty band not drawn, Other last only when held",
            [(o["key"], o["n"]) for o in opts] == [("12-14", 3), ("19-", 1), ("other", 1)], opts)
    s.check("each grade's pills lowest first, numerically",
            [o["key"] for o in a.calib_jg_options(each, [21, 9, 13, 13])] == ["9", "13", "21"])
    s.check("a named band keeps its name on the pill", a.calib_jg_band_name(B(19, None, "Senior leaders")) == "Senior leaders")

s.section("the checks on the bands (the card's and the server's)")
err = a.calib_jg_bands_error
s.check("the default passes", err([B(12, 14), B(15, 18), B(19, None)], 12) is None)
s.check("overlap", "JG 14 is in two bands" in (err([B(12, 14), B(14, 18), B(19, None)], 12) or ""))
s.check("gap", "JG 15 is in no band" in (err([B(12, 14), B(16, 18), B(19, None)], 12) or ""))
s.check("a wider gap names its range", "JG 15 to 16 is in no band" in (err([B(12, 14), B(17, None)], 12) or ""))
s.check("the last band left closed", "let it run" in (err([B(12, 14), B(15, 21)], 12) or ""))
s.check("\"and above\" only on the last", "Only the last band" in (err([B(12, None), B(15, None)], 12) or ""))
s.check("starting above the cycle's minimum", "above the cycle's minimum JG 12" in (err([B(13, 14), B(15, None)], 12) or ""))
s.check("no minimum: any start", err([B(13, 14), B(15, None)], None) is None)
s.check("one band, or a band ending before it starts", "at least two" in (err([B(12, None)], 12) or "")
        and "ends below" in (err([B(12, 11), B(12, None)], 12) or ""))
s.check("at most six", "At most 6" in (err([B(i, i) for i in range(12, 19)] + [B(19, None)], 12) or ""))

s.section("off by default, everywhere")
with a.app.test_request_context("/"):
    db = a.get_db()
    s.check("no row: hidden on both views", not a.calib_jg_filter_shown(db, BG, [U1], "bu")
            and not a.calib_jg_filter_shown(db, BG, [U1, U2], "tb") and a.calib_jg_filter_map(db, BG) == {}
            and a.calib_jg_payload(db, BG, [U1], "bu") is None)
    s.check("the settings row reads 'Hidden everywhere'", a._st_jg_filter(db, SU) == "Hidden everywhere")

s.section("the card on Calibration & Talent's Settings")
r = C_SU.get("/admin/m/calibration/settings?jgbg=%s" % BG)
html = r.get_data(as_text=True)
s.check("the super admin sees the Job grade filter card, per business group, the default bands filled in",
        r.status_code == 200 and 'id="jg-filter"' in html and "Save job grade filter" in html and "data-jg-form" in html
        and 'name="band_lo_0"' in html and 'name="band_hi_2"' in html and "Each grade on its own" in html, r.status_code)
s.check("...a confirm box on Save (every admin action is double-confirmed)",
        'data-confirm-title="Change the job grade filter?"' in html and 'data-confirm-ok="Save job grade filter"' in html)
s.check("...the bands' headcounts come from counts only (the grade map), never names",
        "data-jg-grades='{" in html)
rb = C_BG.get("/admin/m/calibration/settings")
s.check("a BG admin reads it, can't change it", rb.status_code == 200 and "data-jg-form" not in rb.get_data(as_text=True)
        and "How job grades are grouped" in rb.get_data(as_text=True), rb.status_code)
_c0 = html.find('id="jg-filter"')
_card = html[_c0:html.find("</section>", _c0)]
s.check("the card keeps the grouping; where the Job grade chip shows is its rule on Filters at BU level (2026-10-30, was the tags)",
        'name="unit_' not in _card and "data-bulk-views" not in _card and 'data-cfr-row="jg"' in html
        and 'data-panel-open="cf-jg"' in html and 'name="jg_bu_0"' not in html)


def post(client, fields, bg=None):
    data = {"csrf_token": "tok", "action": "jg_filter", "bg": bg or BG}
    data.update(fields)
    return client.post("/admin/settings", data=data)


BANDS = {"jg_mode": "bands", "band_lo_0": "12", "band_hi_0": "14", "band_lo_1": "15", "band_hi_1": "18",
         "band_name_1": "Managers", "band_lo_2": "19", "band_hi_2": ""}

s.section("saving: the super admin only")
rb = post(C_BG, dict(BANDS, unit_0=U1, tb_0="1"))
s.check("a BG admin's save is refused and writes nothing", rb.status_code in (302, 403)
        and not count("SELECT COUNT(*) FROM calib_jg_filter") and not count("SELECT COUNT(*) FROM calib_jg_bands"),
        rb.status_code)
logs0 = count("SELECT COUNT(*) FROM activity_log WHERE action='settings' AND detail LIKE 'Job grade filter, %'")
r = post(C_SU, dict(BANDS, unit_0=U1, bu_0="1", unit_1=U2))
with a.app.test_request_context("/"):
    db = a.get_db()
    cfg = a.calib_jg_config(db, BG)
    on_bu, on_tb, other = (a.calib_jg_filter_shown(db, BG, [U1], "bu"), a.calib_jg_filter_shown(db, BG, [U1], "tb"),
                           a.calib_jg_filter_shown(db, BG, [U2], "bu"))
s.check("the grouping saved, named band kept; the BU CEO view switched on for one unit only",
        r.status_code == 302 and cfg["set"] and [a.calib_jg_band_name(b) for b in cfg["bands"]] == [
            "JG 12–14", "Managers", "JG 19 and above"] and on_bu and not on_tb and not other,
        (r.status_code, cfg, on_bu, on_tb, other))
s.check("...one activity row naming both changes", count("SELECT COUNT(*) FROM activity_log WHERE action='settings' AND "
        "detail LIKE 'Job grade filter, %'") == logs0 + 1 and count(
        "SELECT COUNT(*) FROM activity_log WHERE action='settings' AND detail LIKE 'Job grade filter, %Managers%Shown in "
        "the BU CEO calibration%'") >= 1)
s.check("...back on the same business group's card", r.headers.get("Location", "").endswith("#jg-filter")
        and "jgbg=" in r.headers.get("Location", ""), r.headers.get("Location"))
bands_before = H.one(a, "SELECT bands FROM calib_jg_bands WHERE business_group=?", (BG,))
for bad in ({"band_lo_1": "14"}, {"band_lo_1": "16"}, {"band_hi_2": "21"}, {"band_lo_0": "13"},
            {"band_name_0": "x" * 31}, {"band_lo_0": "abc"}):
    rr = post(C_SU, dict(BANDS, unit_0=U1, bu_0="1", tb_0="1", **bad))
    s.check("a wrong set of bands writes nothing at all (%s)" % ",".join(bad), rr.status_code == 302
            and H.one(a, "SELECT bands FROM calib_jg_bands WHERE business_group=?", (BG,)) == bands_before
            and not count("SELECT COUNT(*) FROM calib_jg_filter WHERE view='tb' AND shown=1"))
rr = post(C_SU, {"jg_mode": "sideways"})
s.check("an unknown grouping is refused", H.one(a, "SELECT mode FROM calib_jg_bands WHERE business_group=?", (BG,))
        == "bands")
r = post(C_SU, {"jg_mode": "each", "unit_1": U2, "tb_1": "1"})
with a.app.test_request_context("/"):
    db = a.get_db()
    s.check("each grade on its own; a unit the form didn't send is left as it was (absent never clears)",
            a.calib_jg_config(db, BG)["mode"] == "each" and a.calib_jg_filter_shown(db, BG, [U1], "bu")
            and a.calib_jg_filter_shown(db, BG, [U2], "tb"))
nbg = count("SELECT COUNT(DISTINCT business_group) FROM org_units WHERE active=1 AND COALESCE(business_group,'')!=''")
r = post(C_SU, dict(BANDS, jg_all_bgs="1"))
s.check("\"Use this grouping for every business group\" writes every one", count(
        "SELECT COUNT(*) FROM calib_jg_bands WHERE mode='bands' AND bands LIKE '%Managers%'") == nbg, nbg)
r = post(C_SU, dict(BANDS))
s.check("saving the same again changes nothing", "Nothing changed" in C_SU.get(r.headers.get("Location", "/")).get_data(
        as_text=True) or count("SELECT COUNT(*) FROM activity_log WHERE action='settings' AND detail LIKE "
                               "'Job grade filter, %'") >= logs0 + 3)
with a.app.test_request_context("/"):
    db = a.get_db()
    s.check("the settings row says where it shows", a._st_jg_filter(db, SU) == "Shown for 1 unit in the BU CEO "
            "calibration · 1 unit in the BG CEO Talent Box", a._st_jg_filter(db, SU))
    s.check("units calibrated together show it when any one has it on", a.calib_jg_filter_shown(db, BG, [U2, U1], "bu"))

s.section("the BU CEO's calibration card carries the grouping")
with a.app.test_request_context("/"):
    db = a.get_db()
    pop = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND business_group=? AND company=? "
                     "ORDER BY id LIMIT 3", (BG, U1)).fetchall()
    ctx = {"period": {"id": CID}, "population": pop, "session": None, "overalls": {},
           "scope_key": U1, "scope_label": U1, "business_group": BG}
    ov_on = a._pm_calib_assist_overview(db, SU, dict(ctx), "buceo", {"bg": BG, "company": U1})["data"]
    ov_hod = a._pm_calib_assist_overview(db, SU, dict(ctx, scope_key="9001"), "hod", {"hod_id": 9001})["data"]
    ctx2 = dict(ctx, scope_key=U2, scope_label=U2)
    ov_off = a._pm_calib_assist_overview(db, SU, ctx2, "buceo", {"bg": BG, "company": U2})["data"]
jf = ov_on.get("jg_filter") or {}
s.check("performance: the bands with keys and labels where switched on; none on another unit or an HOD's review",
        jf.get("mode") == "bands" and [(b["key"], b["label"]) for b in jf.get("bands") or []] == [
            ("12-14", "JG 12–14"), ("15-18", "Managers"), ("19-", "JG 19 and above")] and jf.get("small") == 10
        and ov_off.get("jg_filter") is None and ov_hod.get("jg_filter") is None,
        (jf, ov_off.get("jg_filter"), ov_hod.get("jg_filter")))
s.check("...and each row carries its job grade", all("job_grade" in r for r in ov_on.get("rows") or []))
SRC = H.source(a, "app.py")
s.check("potential: the same, from the unit(s) on screen (since 2026-11-02 through calib_card_filters, which a calibrator with filters of "
        "its own overrides)",
        '**(calib_card_filters(db, ctx, key[0]) if tier == "buceo"' in SRC
        and '"jg_filter": calib_jg_payload(db, bg, units, view),' in SRC)
s.check("the org rename carries both tables with their group / unit",
        "calib_jg_filter" in a._ORG_SETTINGS_TABLES and "calib_jg_bands" in a._ORG_SETTINGS_TABLES)
s.check("the access page names it as the super admin's", "the department and job grade filters" in SRC
        and a.ADMIN_ACCESS_MAP.get("admin_settings") == "super")

s.section("the client")
JS = H.chat_js(a)


def fn(name):
    i = JS.find("function %s(" % name)
    return JS[i:JS.find("\n  }\n", i)] if i >= 0 else ""


fbar, fline, filt, cw, dist = fn("calFilterBar"), fn("calFilterLine"), fn("calFiltered"), fn("calibWidget"), fn("calibDistBox")
s.check("BU CEO: Job grade is a chip of the filter line after Department, its values counted within the picks before it "
        "(the bands, 'Other' last)",
        'if (f.key === "jg") {' in fline and "calJgOptions(d.jg_filter, cur)" in fline
        and 'return picks.indexOf(calJgKey(d.jg_filter, r.job_grade)) >= 0;' in fline and "cur = cur.filter(" in fline)
s.check("BU CEO: the JG's own curve, named in the verdict; a small group counts only, the unit's verdict",
        "cf.dept.length || cf.unit || cf.jg.length" in filt and "calInJg(d, r)" in filt and "calJgLabel(d)" in filt
        and "out.small = true" in filt and "Too few to read a curve" in dist)
s.check("BU CEO: no JG lens without the row; a new scope starts on every grade",
        'if (!d.jg_filter) cf.jg = [];' in cw and 'cf.unit = ""; cf.jg = [];' in cw)
s.check("the client's key mirrors the server's (bands by range, 'other' for a letter grade)",
        "function calJgKey(cfg, g)" in JS and 'if (!/^\\d+$/.test(t)) return "other";' in JS)

with a.app.test_request_context("/"):   # put back: the default
    db = a.get_db()
    db.execute("DELETE FROM calib_jg_filter")
    db.execute("DELETE FROM calib_jg_bands")
    db.execute("UPDATE cycles SET min_job_grade=? WHERE id=?", (MG0, CYC["id"]))
    db.commit()

sys.exit(s.done())
