"""The Leadership Principle report, ported from production's main at the AI+ rollout (2026-10-14).

Production's main carries a report the AI+ platform never had: each person's 360 by Leadership Principle, as a page and as a
standalone HTML export (super admin only until 2026-11-11; since then BG and BU admins who read 360 Feedback, inside their own
scope, with rater names only for a People > remarks and raters holder: tests/test_principles_report_admins.py). Shipping the platform without it would have removed it from
production. What it promises, checked here against the suite database:
- the super admin sees everyone, names included; a BG admin who reads 360 Feedback opens page and export, own group only;
- the seven principles add up to the person's raw 360 score (the reconciliation the report is built on);
- the band is the 360's own, off the score shown and the cycle's cut-offs -- not the combined potential band;
- a score below the threshold is withheld WITH its breakdown; letter grades are left out;
- only assessors who submitted are named; the export is named ChinHinLeadershipPrinciple_<BG>_<BU>_<cycle>.html.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Leadership Principle report -- ported from production, reconciles with the score")

with a.app.test_request_context("/"):
    db = a.get_db()
    sup = db.execute("SELECT id FROM users WHERE role='admin' AND (admin_bg IS NULL OR admin_bg='') AND "
                     "left_at IS NULL LIMIT 1").fetchone()[0]
    bga = db.execute("SELECT id FROM users WHERE role='admin' AND admin_bg IS NOT NULL AND admin_bg!='' AND left_at "
                     "IS NULL LIMIT 1").fetchone()
    # the cycle with the most submitted 360s, so there is something to report on
    cid = db.execute("SELECT cycle_id FROM assignments WHERE status='submitted' AND archived=0 GROUP BY cycle_id "
                     "ORDER BY COUNT(*) DESC LIMIT 1").fetchone()[0]
    me = db.execute("SELECT * FROM users WHERE id=?", (sup,)).fetchone()
    ctx = a._principles_report_context(db, me, cid)
    rows = ctx["rows"]
    s.check("(the report has people in it)", len(rows) > 5, len(rows))
    valid = [r for r in rows if r["valid"]]
    cuts = a.thresholds_for_cycle(db, cid)
    bad_sum, bad_band = [], []
    for r in valid[:60]:
        u = db.execute("SELECT * FROM users WHERE employee_id=?", (r["eid"],)).fetchone()
        res = a.subject_result(db, u, cid)
        tot = sum(p["score"] or 0 for p in r["principles"])
        if abs(tot - (res["avg_score_raw"] or 0)) > 0.06:
            bad_sum.append((r["eid"], tot, res["avg_score_raw"]))
        if r["band"] != a.potential_band(res["avg_score"], cuts):
            bad_band.append((r["eid"], r["band"]))
    s.check("the seven principles add up to the person's raw 360 score", valid and not bad_sum, bad_sum[:3])
    s.check("the band is the 360's own, off the score shown and the cycle's cut-offs", not bad_band, bad_band[:3])
    # subject_result()'s band is the COMBINED potential band; make it differ from the 360's, so the check above can't
    # pass just because the two happen to agree on this data
    _real_sr = a.subject_result

    def _combined_differs(*args, **kw):
        res = dict(_real_sr(*args, **kw))
        res["band"] = "ZZ-COMBINED"
        return res
    a.subject_result = _combined_differs
    try:
        forced = a._principles_report_context(db, me, cid)["rows"]
    finally:
        a.subject_result = _real_sr
    s.check("...never subject_result()'s combined band", forced and not any(r["band"] == "ZZ-COMBINED" for r in forced))
    withheld = [r for r in rows if not r["valid"]]
    s.check("a withheld score withholds its breakdown too", all(r["score"] is None and not r["principles"]
                                                                 for r in withheld))
    s.check("letter grades are left out", not any(a._is_letter_grade(r["jg"]) for r in rows))
    with_names = next((r for r in valid if r["assessors"]), None)
    if with_names:
        u = db.execute("SELECT * FROM users WHERE employee_id=?", (with_names["eid"],)).fetchone()
        sub = sorted(x["assessor_name"] for x in a.subject_result(db, u, cid)["assessors"]
                     if x["status"] == "submitted")
        s.check("only the assessors who submitted are named", sorted(with_names["assessors"]) == sub)

c = H.client_as(a, sup)
r = c.get("/admin/reports/principles")
body = r.get_data(as_text=True)
s.check("the page opens for a super admin, with its payload", r.status_code == 200 and 'id="lp-payload"' in body,
        r.status_code)
s.check("...in the admin menu under 360 Feedback > Reports", "Leadership Principle report" in body)
r = c.get("/admin/export/principles.html?cycle=%d" % cid)
cd = r.headers.get("Content-Disposition", "")
s.check("the export downloads as ChinHinLeadershipPrinciple_<BG>_<BU>_<cycle>.html",
        r.status_code == 200 and re.search(r"filename=\"?ChinHinLeadershipPrinciple_AllBGs_AllBUs_\w+\.html", cd), cd)
s.check("...a standalone file (its own page, no app chrome)", "<html" in r.get_data(as_text=True).lower()
        and "lp-payload" in r.get_data(as_text=True))
r = c.get("/admin/reports/all")
s.check("Reports (On screen) opens it, beside Results analysis: the 360's report pages live under Reports since "
        "2026-10-19 (option A), and the old button beside the pill stays gone",
        "/admin/reports/principles" in r.get_data(as_text=True) and 'href="/admin/reports"' in r.get_data(as_text=True)
        and "Leadership Principle report &rarr;" not in c.get("/admin/reports").get_data(as_text=True))
if bga:
    cb = H.client_as(a, bga[0])
    rb, eb = cb.get("/admin/reports/principles"), cb.get("/admin/export/principles.html")
    s.check("a BG admin (360 Feedback read, since 2026-11-11) opens the page and the export", rb.status_code == 200
            and eb.status_code == 200, (rb.status_code, eb.status_code))
    with a.app.test_request_context("/"):
        db = a.get_db()
        bme = db.execute("SELECT * FROM users WHERE id=?", (bga[0],)).fetchone()
        bg_of = a.admin_bg_of(bme)
        brows = a._principles_report_context(db, bme, cid)["rows"]
    s.check("...and their rows are their own group's", all(r["bg"] == bg_of for r in brows))
    s.check("...with the link in Reports", "/admin/reports/principles" in cb.get("/admin/reports/all").get_data(as_text=True))
sys.exit(s.done())
