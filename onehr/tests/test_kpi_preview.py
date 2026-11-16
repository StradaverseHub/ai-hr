"""The Total KPI score follows the typing (Chris, 2026-10-22: "the total kpi score doesn't automatically reflect after
user key in the result, can we do that so it syncs?").

  * /review/kpi/preview scores the figures typed so far with the same scoring as Save, and stores nothing
  * it counts only the person's own editable lines: a BU-level line, someone else's line or a word is ignored
  * with nothing typed, or once the same figures are saved, it equals the table's own total
  * the page asks it as the boxes change (debounced, the newest answer wins) and never works the total out itself

Writes, so a fresh copy, put back at the end.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("The Total KPI score follows the typing -- a server preview, nothing stored")
HERE = os.path.dirname(os.path.abspath(__file__))
JS = open(os.path.join(HERE, "..", "static", "journey_chat.js")).read()
CHBM = "CHIN HIN BUILDING MATERIAL (CHBM)"

with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','evidence','tm','pm')",
               (CID,))
    db.execute("UPDATE cycles SET kind='mid_year', half=2, starts_on=NULL WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES('review_unified','1')")
    ME, OTHER = [r["id"] for r in db.execute(
        "SELECT id FROM users WHERE role!='admin' AND left_at IS NULL AND job_grade IS NOT NULL ORDER BY id LIMIT 2")]
    for sid in (ME, OTHER):
        db.execute("DELETE FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (CID, sid))
    ids = {}
    for sid, name, w, rates, bu in ((ME, "ZZ Preview GP", 40, (9, 11, 12, 13, 15), 0),
                                    (ME, "ZZ Preview DM", 30, (1, 2, 3, 4, 5), 0),
                                    (ME, "ZZ Preview PAT", 30, (4, 6, 8, 10, 12), 1),
                                    (OTHER, "ZZ Preview other", 100, (1, 2, 3, 4, 5), 0)):
        cur = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, "
                         "business_group, rate1, rate2, rate3, rate4, rate5) "
                         "VALUES (?,?,?,?,'more','approved',?,?,?,?,?,?)",
                         (CID, sid, name, w, CHBM) + rates)
        ids[name] = cur.lastrowid
        if bu:   # BU-level is the library's, by KPI name in the person's business group (pm_bu_level_names)
            db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, "
                       "method, bu_level, active) VALUES (?, '*', '*', 0, '*', ?, 'more', 1, 1)",
                       (db.execute("SELECT business_group FROM users WHERE id=?", (sid,)).fetchone()[0] or "", name))
    if not db.execute("SELECT 1 FROM pm_bg_config WHERE business_group=?", (CHBM,)).fetchone():
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (CHBM,))
    db.commit()
GP, DM, PAT, OT = ids["ZZ Preview GP"], ids["ZZ Preview DM"], ids["ZZ Preview PAT"], ids["ZZ Preview other"]


def results():
    return H.one(a, "SELECT COUNT(*) FROM pm_kpi_results")


def preview(client, **typed):
    q = "&".join("actual_value_%s=%s" % (k, v) for k, v in typed.items())
    r = client.get("/review/kpi/preview?" + q)
    return r.status_code, (r.get_json() or {}).get("overall")


def table_total(client):
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = ME
        db = a.get_db()
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (ME,)).fetchone())
        return a._review_kpi_overview(db, u)["data"]["overall"]


E = H.client_as(a, ME)
s.section("nothing typed: the table's own total (none yet)")
r0 = results()
code, ov = preview(E)
s.check("the preview answers, and with nothing keyed there is no total", code == 200 and ov is None, ov)

s.section("typed, not saved: scored the server's way, nothing stored")
code, ov = preview(E, **{str(GP): "12", str(DM): "4"})
# independently: GP 12 on 9/11/12/13/15 'more' lands on 3; DM 4 on 1..5 lands on 4; (3x40 + 4x30) / 70 = 3.43
want = (3 * 40 + 4 * 30) / 70.0
s.check("GP 12 and DM 4 give the weighted 3.4, Meets, covering 70 of 100 (PAT is HR's, not keyed)",
        ov and ov["value"] == "%.1f" % want and ov["band_code"] == "ME" and ov["covered"] == 70
        and ov["total"] == 100 and ov["mechanism"] == "A", ov)
s.check("...and nothing was written", results() == r0)
code, ov1 = preview(E, **{str(GP): "12"})
s.check("one line typed: 3.0 covering 40", ov1 and ov1["value"] == "3.0" and ov1["covered"] == 40, ov1)
code, ovc = preview(E, **{str(GP): "12,000"})
s.check("thousands commas read as Save reads them (12,000 lands on the top rung)",
        ovc and ovc["value"] == "5.0", ovc)

s.section("only the person's own editable lines count")
code, ovx = preview(E, **{str(GP): "12", str(PAT): "12", str(OT): "5"})
s.check("a BU-level line (HR's) and someone else's line are ignored", ovx == ov1, ovx)
code, ovw = preview(E, **{str(GP): "abc", str(DM): "nan"})
s.check("a word or a non-number scores nothing", code == 200 and ovw is None, ovw)

s.section("saved: the preview and the table agree")
post = E.post("/review/kpi/save-all", data={"csrf_token": "tok", "actual_value_%d" % GP: "12",
                                             "actual_value_%d" % DM: "4"})
s.check("Save records the same two figures", post.status_code == 200 and results() == r0 + 2)
code, ovs = preview(E, **{str(GP): "12", str(DM): "4"})
tt = table_total(E)
s.check("the table's total after Save equals the preview before it", tt == ov and ovs == tt, (tt, ov))
code, ovn = preview(E)
s.check("with the boxes as saved, the preview is the table's total", ovn == tt)

s.section("the page asks the server as the boxes change, and never works the total out itself")
s.check("each Result box asks for the preview as it changes",
        'inp.addEventListener("input", kpiPreviewSoon);' in JS and '"/review/kpi/preview?"' in JS)
s.check("debounced, and only the newest answer is painted",
        "setTimeout(kpiPreviewNow, 300)" in JS and "seq === kpiPrev.seq" in JS)
s.check("a figure still only typed keeps counting after a refresh; boxes back as saved show the saved total",
        "kpiPrev.shown = false; renderKpiTotal(data);\n    kpiPreviewSoon();" in JS
        and "if (!typed && !kpiPrev.shown) return;" in JS)
s.check("the preview route belongs to the review module (off with it) and is a GET only",
        a.MODULE_ENDPOINTS.get("review_kpi_preview") == "review"
        and E.post("/review/kpi/preview", data={"csrf_token": "tok"}).status_code == 405)

H.restore_db()
sys.exit(s.done())
