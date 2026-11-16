"""Staff-facing text says "Group People", never "HR" (Chris, 2026-10-20: "replace with Group People"; 2026-10-29, the
dashboard's rail still named "HR" as the actor of "Results released" and "Reopened by HR").

What holds it:
  * a source lint: the actor labels, the reopen wording (the reopen email's "Group People has reopened ...", 2026-10-30) and the band chain's tier label in app.py, and every visible
    word of the dashboard, the review overview and the HOD view templates, never say HR (a Jinja comment is not shown)
  * a rendered check: an employee's and a line manager's dashboard, signed in through the harness, carry the rail with
    "Group People" as the actor of the release step, and no visible "HR" anywhere on the page (tags stripped, title and
    aria-label attributes included); the rail's reopen chip reads "Reopened by Group People"

Synthetic (ZZGPW-*) on the shared suite database; everything is put back at the end.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Group People wording -- the dashboard rail and staff-facing text never say HR")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
HR = re.compile(r"\bHR\b")


def read(*p):
    return open(os.path.join(H.REPO, *p), encoding="utf-8").read()


s.section("1. Source lint")
APP = read("app.py")
for bad in ('"HR releases', '"who": "HR"', 'add("HR"', "Reopened by HR", "HR reopened", "HR has reopened", '("super", "HR"', '"HR\'s override"',
            'else "HR")'):
    s.check("app.py has no %s" % bad, not re.search(r"(?<![A-Za-z])" + re.escape(bad), APP))
s.check("...and the product's own name survives (OneHR is not HR)", '"OneHR reopened after a notice"' in APP
        and "OneGroup People" not in APP)
s.check("the band chain's super tier reads Group People", APP.count('("super", "Group People", ') == 2)
JS = read("static", "dashboard.js")
s.check("static/dashboard.js (the dashboard's panels) says no HR", not HR.search(JS), [m.start() for m in HR.finditer(JS)][:3])
QHR = re.compile(r"""["']HR["']""")
for jf in ("journey_chat.js", "review_chat.js"):   # the sign-off box's KPI table: a BU line's empty Actual cell (QC 9 Nov)
    src = read("static", jf)
    s.check("static/%s has no quoted \"HR\" and its BU line's Actual cell reads Group People with the why on hover" % jf,
            not QHR.search(src) and '(l.bu_level ? "Group People" : DASH)' in src and "BU_ACTUAL_TITLE = " in src
            and "Group People fills this once for everyone who shares the unit's result" in src and "td.title = BU_ACTUAL_TITLE" in src,
            [m.start() for m in QHR.finditer(src)][:3])
s.check("...the lint can fail: it sees the old cell", bool(QHR.search('(l.actual != null ? l.actual : (l.bu_level ? "HR" : DASH))')))
for t in ("dashboard.html", "_review_overview.html", "hod_view.html"):
    src = re.sub(r"\{#.*?#\}", "", read("templates", t), flags=re.S)
    s.check("templates/%s shows no HR" % t, not HR.search(src), [m.group(0) for m in HR.finditer(src)][:3])
s.check("the lint can fail: it sees an HR in a sample", bool(HR.search("waiting for HR to release")))

s.section("2. The rendered dashboard")
BG, CO = "ZZGPW Group", "ZZGPW Co"


def visible(html):
    """Text a person can read or hover: tags stripped, title / aria-label / placeholder values kept."""
    attrs = " ".join(re.findall(r'(?:title|aria-label|placeholder|alt)="([^"]*)"', html))
    body = re.sub(r"<(script|style)\b.*?</\1>", "", html, flags=re.S)
    return re.sub(r"<[^>]+>", " ", body) + " " + attrs


def cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZGPW-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM result_releases WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.commit()


with a.app.app_context():
    db = a.get_db()
    cleanup(db)
    # its own running Year-End, whatever an earlier suite left behind; every other cycle is put back at the end
    PREV_ACTIVE = [(r[0], r[1]) for r in db.execute("SELECT id, is_active FROM cycles")]
    for _o in db.execute("SELECT id FROM cycles WHERE code='ZZGPW-YE'").fetchall():
        db.execute("DELETE FROM cycle_modules WHERE cycle_id=?", (_o[0],))
        db.execute("DELETE FROM cycles WHERE id=?", (_o[0],))
    db.execute("UPDATE cycles SET is_active=0")
    NOW = a._today_myt().year
    CID = db.execute("INSERT INTO cycles(code, name, is_active, year, half, starts_on, ends_on) "
                     "VALUES ('ZZGPW-YE', ?, 1, ?, 2, ?, ?)",
                     ("ZZGPW %d Year-End" % NOW, NOW, "%d-01-01" % NOW, "%d-12-31" % NOW)).lastrowid
    for _k in ("pm", "tm", "idp", "calibration", "evidence", "review"):
        db.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, _k))

    def person(n, **kw):
        cols = {"username": "zzgpw-%d" % n, "full_name": "ZZGPW Person%d Lim" % n, "password_hash": "x", "role": "user",
                "employee_id": "ZZGPW-%d" % n, "business_group": BG, "company": CO, "department": "ZZGPW Dept",
                "job_title": "Planner", "job_grade": 14, "years_of_service": 3}
        cols.update(kw)
        return db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                          tuple(cols.values())).lastrowid
    MGR = person(1)
    EMP = person(2, manager_id=MGR, hod_id=MGR)
    EMP2 = person(3, manager_id=MGR, hod_id=MGR)
    db.commit()
    db.commit()
try:
    pages = {}
    for who, uid in (("an employee", EMP), ("a line manager", MGR)):
        r = H.client_as(a, uid).get("/dashboard")
        pages[who] = r.get_data(as_text=True)
        s.check("%s's dashboard loads" % who, r.status_code == 200, r.status_code)
    with a.app.test_request_context("/dashboard"):
        db = a.get_db()
        for who, uid in (("an employee", EMP), ("a line manager", MGR)):
            u = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
            ctx = a._dash_context(db, u)
            steps = (ctx.get("rail") or {}).get("steps") or []
            rel = [x for x in steps if x["name"] == "Results released"]
            s.check("%s: the rail is there and has a release step (not an empty list)" % who, bool(steps) and bool(rel),
                    (ctx.get("mode"), [(x["who"], x["name"]) for x in steps]))
            s.check("...its actor is Group People" , bool(rel) and all(x["who"] == "Group People" for x in rel), rel)
            s.check("...and no step names HR as its actor", not any(HR.search(x["who"]) for x in steps),
                    [x["who"] for x in steps])
            s.check("...and the page carries that actor in the rail",
                    "Group People" in pages[who][pages[who].find('id="od-rail-h"'):], None)
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM cycle_modules WHERE cycle_id=?", (CID,))
        db.execute("DELETE FROM cycles WHERE id=?", (CID,))
        for _i, _a in PREV_ACTIVE:
            db.execute("UPDATE cycles SET is_active=? WHERE id=?", (_a, _i))
        db.commit()
for who, html in pages.items():
    seen = visible(html)
    s.check("%s's dashboard: no visible HR (text, titles, labels)" % who, len(seen) > 2000 and not HR.search(seen),
            [seen[max(0, m.start() - 40):m.end() + 40] for m in HR.finditer(seen)][:3])

s.section("3. The rail's reopen chip")
with a.app.test_request_context("/dashboard"):
    db = a.get_db()
    u = db.execute("SELECT * FROM users WHERE id=?", (EMP,)).fetchone()
    panel = {"next": "kpi", "modules": [{"key": "pm", "parts": [
        {"key": "kpi", "name": "KPI check-in", "state": "open", "reopened": True, "count": "0 of 2"}]}]}
    rail = a.dash_rail(db, u, panel, None, [])
    st = next((x for x in (rail or {}).get("steps") or [] if x["name"] == "KPI check-in"), None)
    s.check("a reopened part's chip says Reopened by Group People", bool(st) and "Group People" in st["full"]
            and not HR.search(st["full"] + st["short"]), st)

with a.app.app_context():
    db = a.get_db()
    cleanup(db)
sys.exit(s.done())
