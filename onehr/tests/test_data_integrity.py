"""Data integrity page -- 278839a.

RECONSTRUCTED after a macOS cleanup lost the original; same invariants, taken
from the commit's own record.

HOW TO TEST A DIAGNOSTIC. The risk here is a WRONG CHECK -- a false positive
sends HR chasing nothing, a false negative hides a fault. So every count is
asserted against a query written INDEPENDENTLY here, never against the page's
own SQL. Where the original asserted a number taken from the live VM, this
asserts the relationship, because it runs against the repo's local database.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Data integrity")
SU, BG, EMP = H.actors(a)
S = H.client_as(a, SU["id"])
with a.app.app_context():
    CID = a.active_cycle_id(a.get_db())
with a.app.test_request_context("/"):
    from flask import session
    session["user_id"] = SU["id"]
    db = a.get_db()
    MIN_VALID, TARGET = a.min_valid(), a.panel_target()
    t0 = time.time()
    COUNTS = {c["key"]: c["count"] for c in a.data_check_counts(db, SU, CID)}
    ELAPSED = time.time() - t0
s.note("%d checks in %.3fs | min_valid=%s target=%s"
       % (len(COUNTS), ELAPSED, MIN_VALID, TARGET))

s.section("each count, re-derived by an INDEPENDENTLY written query")
EXPECT = {
 "two_lm": ("SELECT COUNT(*) FROM (SELECT subject_id FROM assignments WHERE cycle_id=? "
            "AND archived=0 AND relationship='line_manager' GROUP BY subject_id "
            "HAVING COUNT(*)>1)", (CID,)),
 "letter_grade_extra": (
    "SELECT COUNT(DISTINCT x.subject_id) FROM assignments x JOIN users u ON u.id=x.subject_id "
    "WHERE x.cycle_id=? AND x.archived=0 AND x.relationship<>'line_manager' "
    "AND CAST(u.job_grade AS INTEGER)=0 AND TRIM(COALESCE(u.job_grade,''))<>''", (CID,)),
 "no_panel": (
    "SELECT COUNT(*) FROM users u WHERE u.role<>'admin' AND u.left_at IS NULL AND u.is_demo=0 "
    "AND (u.confirmation_date IS NOT NULL OR COALESCE(u.years_of_service,0)>1) "
    "AND UPPER(TRIM(COALESCE(u.job_grade,'')))<>'H' "   # Grade H is on no 360, so has no panel to be missing (2026-10-28)
    "AND u.id NOT IN (SELECT subject_id FROM assignments WHERE cycle_id=? AND archived=0)",
    (CID,)),
 "self_assess": ("SELECT COUNT(*) FROM assignments WHERE cycle_id=? "
                 "AND subject_id=assessor_id", (CID,)),
 "no_email": ("SELECT COUNT(*) FROM users WHERE role<>'admin' AND left_at IS NULL "
              "AND is_demo=0 AND TRIM(COALESCE(email,''))=''", ()),
 "no_manager": ("SELECT COUNT(*) FROM users WHERE role<>'admin' AND left_at IS NULL "
                "AND is_demo=0 AND manager_id IS NULL", ()),
 "self_manager": ("SELECT COUNT(*) FROM users WHERE manager_id=id", ()),
 "no_department": ("SELECT COUNT(*) FROM users WHERE role<>'admin' AND left_at IS NULL "
                   "AND is_demo=0 AND TRIM(COALESCE(department,''))=''", ()),
 "dup_eid": ("SELECT COUNT(*) FROM users WHERE employee_id IN "
             "(SELECT employee_id FROM users WHERE employee_id IS NOT NULL "
             "GROUP BY employee_id HAVING COUNT(*)>1)", ()),
 "manager_left": ("SELECT COUNT(*) FROM users u JOIN users m ON m.id=u.manager_id "
                  "WHERE u.role<>'admin' AND u.left_at IS NULL AND u.is_demo=0 "
                  "AND m.left_at IS NOT NULL", ()),
 "bu_not_in_org": (
    "SELECT COUNT(*) FROM users u WHERE u.role<>'admin' AND u.left_at IS NULL AND u.is_demo=0 "
    "AND TRIM(COALESCE(u.company,''))<>'' AND u.company NOT IN "
    "(SELECT company FROM org_units WHERE business_group=u.business_group)", ()),
 "dup_email": (
    "SELECT COUNT(*) FROM users u WHERE u.left_at IS NULL "
    "AND LOWER(TRIM(COALESCE(u.email,''))) IN "
    "(SELECT LOWER(TRIM(email)) FROM users WHERE left_at IS NULL "
    "AND TRIM(COALESCE(email,''))<>'' GROUP BY LOWER(TRIM(email)) HAVING COUNT(*)>1)", ()),
 "over_cap": (   # the cap is on everything a person rates, in any role (Chris, 2026-10-20)
    "SELECT COUNT(*) FROM (SELECT assessor_id FROM assignments WHERE cycle_id=? "
    "AND archived=0 GROUP BY assessor_id HAVING COUNT(*)>?)",
    (CID, a._ba.ASSESSOR_CAP)),
 "admin_on_panel": (
    "SELECT COUNT(*) FROM (SELECT assessor_id FROM assignments x "
    "JOIN users u ON u.id=x.assessor_id WHERE x.cycle_id=? AND x.archived=0 "
    "AND u.role='admin' GROUP BY assessor_id)", (CID,)),
}
for key, (query, args) in EXPECT.items():
    want = H.one(a, query, args)
    s.check("%-20s = %s" % (key, want), COUNTS[key] == want, (COUNTS[key], want))
# leaver_assessor counts only UNSUBMITTED work: a submitted assessment is done.
want = H.one(a, "SELECT COUNT(*) FROM (SELECT x.assessor_id FROM assignments x "
                "JOIN users u ON u.id=x.assessor_id WHERE x.cycle_id=? AND x.archived=0 "
                "AND x.status<>'submitted' AND u.left_at IS NOT NULL "
                "GROUP BY x.assessor_id)", (CID,))
s.check("leaver_assessor      = %s" % want, COUNTS["leaver_assessor"] == want)

s.section("the release check is GRADE-AWARE -- the one easiest to get wrong")
# min_valid_submissions() returns 1 for a letter grade. A flat "< min_valid"
# over-reports, and each false positive is a wasted investigation.
flat = H.one(a, "SELECT COUNT(*) FROM report_releases r WHERE r.cycle_id=? AND "
                "(SELECT COUNT(*) FROM assignments x WHERE x.subject_id=r.subject_id "
                "AND x.cycle_id=r.cycle_id AND x.archived=0 AND x.status='submitted') < ?",
             (CID, MIN_VALID))
with a.app.test_request_context("/"):
    from flask import session as _s
    _s["user_id"] = SU["id"]
    rel = a.get_db().execute(
        "SELECT u.job_grade jg, (SELECT COUNT(*) FROM assignments x "
        "WHERE x.subject_id=r.subject_id AND x.cycle_id=r.cycle_id AND x.archived=0 "
        "AND x.status='submitted') subs FROM report_releases r "
        "JOIN users u ON u.id=r.subject_id WHERE r.cycle_id=?", (CID,)).fetchall()
    aware = sum(1 for r in rel if r["subs"] < a.min_valid_submissions(r["jg"]))
s.check("matches the per-subject rule, not a flat comparison",
        COUNTS["released_below_threshold"] == aware,
        (COUNTS["released_below_threshold"], aware))
s.check("a flat comparison would report at least as many", flat >= aware, (flat, aware))
s.note("grade-aware %d, flat %d over %d released reports" % (aware, flat, len(rel)))

s.section("the same fault is never counted twice")
# "Panel larger than target" and "two line managers" are the SAME people -- a
# duplicate line manager is what pushes a panel from 5 to 6. Reporting both
# would double the total.
two = {r[0] for r in H.rows(a, "SELECT subject_id FROM assignments WHERE cycle_id=? "
                               "AND archived=0 AND relationship='line_manager' "
                               "GROUP BY subject_id HAVING COUNT(*)>1", (CID,))}
over = {r[0] for r in H.rows(a, "SELECT subject_id FROM assignments WHERE cycle_id=? "
                                "AND archived=0 GROUP BY subject_id HAVING COUNT(*)>?",
                             (CID, TARGET))}
s.check("over_target excludes the two-line-manager subjects",
        COUNTS["over_target"] == len(over - two), (COUNTS["over_target"], len(over - two)))
s.note("two_lm=%d over_target(all)=%d overlap=%d -> reported %d"
       % (len(two), len(over), len(two & over), COUNTS["over_target"]))

s.section("a diagnostic must not change anything")
def world():
    return tuple(H.one(a, "SELECT COUNT(*) FROM " + t)
                 for t in ("assignments", "users", "report_releases", "org_units"))
before = world()
S.get("/admin/data-integrity")
for key in list(COUNTS)[:6]:
    S.get("/admin/data-integrity", query_string={"check": key})
s.check("nothing was written by loading or drilling in", world() == before)

s.section("the page")
r = S.get("/admin/data-integrity")
body = r.get_data(as_text=True)
s.check("landing -> 200", r.status_code == 200)
s.check("every check is named on the page",
        all(c["label"][:28] in body for c in a.DATA_CHECKS),
        [c["key"] for c in a.DATA_CHECKS if c["label"][:28] not in body])
s.check("employee -> 403", H.client_as(a, EMP["id"]).get("/admin/data-integrity").status_code == 403)
# A bogus key must not fall back to showing everything.
s.check("a bogus check key 404s",
        S.get("/admin/data-integrity", query_string={"check": "nope"}).status_code == 404)
for key, n in COUNTS.items():
    rr = S.get("/admin/data-integrity", query_string={"check": key})
    listed = rr.get_data(as_text=True).count('class="data-row"')
    want = min(n, a.DATA_CHECK_ROW_CAP)
    s.check("drill-down %-22s lists %d" % (key, want), listed == want, (listed, want, n))

s.section("the row cap says what it is hiding")
real_cap = a.DATA_CHECK_ROW_CAP
try:
    a.DATA_CHECK_ROW_CAP = 5
    biggest = max(COUNTS, key=lambda k: COUNTS[k])
    if COUNTS[biggest] > 5:
        t = S.get("/admin/data-integrity", query_string={"check": biggest}).get_data(as_text=True)
        s.check("a capped list renders exactly the cap", t.count('class="data-row"') == 5)
        s.check("...and says there are more", "Showing the first" in t)
    else:
        s.note("no check exceeds 5 rows on this database; cap untested")
finally:
    a.DATA_CHECK_ROW_CAP = real_cap

s.section("a BG admin sees only their own BG")
if BG:
    s.check("BG admin can't open the page: Audit and usage is the super admin's (Chris, 2026-10-21); the scoping "
            "below still holds for the counts the readiness steps read",
            H.client_as(a, BG["id"]).get("/admin/data-integrity").status_code in (302, 403))
    with a.app.test_request_context("/"):
        from flask import session as _s2
        _s2["user_id"] = BG["id"]
        db = a.get_db()
        bcounts = {c["key"]: c["count"] for c in a.data_check_counts(db, BG, CID)}
        brows, _cap = a.data_check_rows(db, BG, CID, a.DATA_CHECKS_BY_KEY["no_email"])
    s.check("every BG count <= the org-wide count",
            all(bcounts[k] <= COUNTS[k] for k in bcounts),
            {k: (bcounts[k], COUNTS[k]) for k in bcounts if bcounts[k] > COUNTS[k]})
    s.check("no row belongs to another BG",
            all(r["bg"] == BG["admin_bg"] for r in brows))

s.section("CSV export")
r = S.get("/admin/data-integrity", query_string={"check": "no_manager", "format": "csv"})
cd = r.headers.get("Content-Disposition", "")
s.check("csv -> 200", r.status_code == 200)
s.check("MYT-dated filename", a._today_myt().isoformat() in cd and cd.endswith(".xlsx"), cd)
lines = H.as_csv_text(r).strip().splitlines()
s.check("one header + one row per finding",
        len(lines) == min(COUNTS["no_manager"], a.DATA_CHECK_ROW_CAP) + 1,
        (len(lines), COUNTS["no_manager"]))
s.check("header names the columns", lines[0].startswith("Employee ID,Name"))
s.check("the export is audit-logged",
        H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='export' "
                 "AND detail LIKE 'data_%'") >= 1)

s.section("COVERAGE -- how many of these checks actually inspected anything")
# The whole risk on this page is a WRONG check, so every count above is re-derived
# with an independently written query. But when a check returns 0, that comparison
# is 0 == 0: it proves the two queries agree that nothing matched, and nothing
# more. A check that inspects nothing is indistinguishable from one that passed --
# the same trap as test_phase0's calibration trail, which sat green over ZERO
# entries because all() of an empty sequence is True.
#
# So the vacuity is MEASURED rather than hidden. If the fixture or the database
# degrades, "7 of 17" becomes a number on screen that drops, instead of a suite
# that stays quietly green.
#
# A FLOOR, not an equality: a developer's real database exercises more of these
# than the synthetic fixture does, and improving the fixture must not require
# editing this test.
FIRING = sorted(k for k, v in COUNTS.items() if v)
VACUOUS = sorted(k for k, v in COUNTS.items() if not v)
s.note("%d of %d checks returned a non-zero count" % (len(FIRING), len(COUNTS)))
s.note("exercised: %s" % ", ".join(FIRING))
s.note("vacuous  : %s" % ", ".join(VACUOUS))
# Six of these read zero on the real staging database too -- deliberately kept so
# they exist before they first fire -- so a floor is the honest assertion, and 7
# is what the generated fixture produces today.
s.check("at least 7 checks were exercised non-vacuously", len(FIRING) >= 7,
        "%d: %s" % (len(FIRING), FIRING))
# The ones that matter most for people's scores must never go quiet unnoticed.
for key in ("two_lm", "released_below_threshold"):
    if key in COUNTS:
        s.check("%-26s is exercised, not 0 == 0" % key, COUNTS[key] > 0, COUNTS[key])

s.section("cost")
# The first cut of the duplicate-email check used a correlated subquery over
# 3,600 users with no index on email: 2.9 SECONDS, the entire cost of the page.
s.check("all %d counts in under 250ms" % len(COUNTS), ELAPSED < 0.25, "%.3fs" % ELAPSED)

sys.exit(s.done())
