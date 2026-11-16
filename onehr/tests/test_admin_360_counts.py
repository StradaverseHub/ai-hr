"""Admin 360 progress counts follow the same rule as a rater's lists: a colleague who does not take part in the 360 is not
counted (Chris, 2026-10-30 "out means out", carried to the admin side 2026-10-31).

rater_task_sql (the rule a rater's own readers share) is ANDed into every admin 360 PROGRESS count: assessor progress (the
page, its Excel, the MCP's f360 progress), Ratings still to come, the 360 Overview (subjects / asked / in, the stage bar,
the department table), the people-being-rated, stage and ready-to-release lists, Home's "N of M raters done", the readiness
panel's Responses in / Reports released, Group People's Rater progress, the Admin Agent's 360 report and 360 People's
with-a-panel scope. What does NOT change, and this suite holds: the person page's 360 tab and the panel tools still show
every row, All people keeps everyone, a panel row of another cycle always counts, an archived row never does.

One business group of its own (ZZAC Group, one department), so every count is exact whatever the rest of the database holds:
  IN    takes part: R1's row submitted, R2's row pending, R3's row ARCHIVED (pending)
  OUT   not confirmed, so not taking part: R1's row pending, R2's row submitted
  LEFT  has left: R1's row submitted
  -> admin side: R1 owes nothing and has 1 of 1 in; R2 owes 1 (1 of 2 asked for IN); asked 2, in 1, one person rated.
Synthetic ZZAC people only; a fresh_db suite, so Suite.done() puts the scratch copy back.
"""
import atexit
import contextlib
import io
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
import onehr_mcp as M  # noqa: E402
from flask import template_rendered  # noqa: E402
_FINISHED = False
atexit.register(lambda: None if _FINISHED else H.restore_db())
s = H.Suite("Admin 360 progress counts leave out colleagues who do not take part")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)

BG, CO, DEPT = "ZZAC Group", "ZZAC Unit", "ZZAC Dept"


@contextlib.contextmanager
def D():
    with a.app.test_request_context("/"):
        yield a.get_db()


def render(client, url):
    """(status, {template name: context}) of one page: the numbers the page hands its template."""
    got = {}

    def rec(sender, template, context, **kw):
        got[template.name] = {k: v for k, v in context.items() if not k.startswith("_")}
    template_rendered.connect(rec, a.app)
    try:
        r = client.get(url)
    finally:
        template_rendered.disconnect(rec, a.app)
    return r.status_code, got


# ------------------------------------------------------------------------------------------------ the people
with D() as db:
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','tm','idp','pm')")
    MG = a.active_cycle(db)["min_job_grade"]
    if MG is None:
        db.execute("UPDATE cycles SET min_job_grade=12 WHERE id=?", (CID,))
        MG = 12
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base if c != "id"]
    GRADE = str(max(int(MG), 14))
    db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))

    def mk(tag, confirmed=True, left=False, role="user"):
        eid = "ZZAC-" + tag
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ Count " + tag, display_name=None, email=None,
                 manager_id=None, hod_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, role=role, is_demo=0,
                 business_group=BG, company=CO, department=DEPT, admin_bg=BG if role == "admin" else None,
                 confirmation_date="2020-01-01" if confirmed else None, years_of_service=5 if confirmed else 0.5,
                 left_at="2026-10-01" if left else None, job_grade=GRADE, user_role_id=None)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v.get(c) for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
    R1, R2, R3, R4 = mk("R1"), mk("R2"), mk("R3"), mk("R4")
    IN, OUT, LEFT = mk("IN"), mk("OUT", confirmed=False), mk("LEFT", left=True)
    BGADM = mk("ADM", role="admin")

    def row(cycle, subj, rater, status, archived=0):
        db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status, archived, "
                   "submitted_at) VALUES (?,?,?,'peer',?,?,%s)" % ("CURRENT_TIMESTAMP" if status == "submitted" else "NULL"),
                   (cycle, subj, rater, status, archived))
    row(CID, IN, R1, "submitted"), row(CID, IN, R2, "pending"), row(CID, IN, R3, "pending", archived=1)
    row(CID, OUT, R1, "pending"), row(CID, OUT, R2, "submitted")
    row(CID, LEFT, R1, "submitted")
    row(CID, LEFT, R4, "pending")   # R4 owes only a rating for someone not taking part: not a rater at all on Home
    # a panel row of ANOTHER cycle for the colleague who is out: history, always counted (the cycle's counts are unchanged)
    OLD = db.execute("SELECT id FROM cycles WHERE id!=? LIMIT 1", (CID,)).fetchone()
    if OLD is None:
        db.execute("INSERT INTO cycles(name, year, half, is_active) VALUES ('ZZAC old', 2020, 2, 0)")
        OLD = db.execute("SELECT id FROM cycles WHERE name='ZZAC old'").fetchone()
    OLD = OLD[0]
    row(OLD, OUT, R1, "pending"), row(OLD, OUT, R2, "submitted")
    db.commit()
    ME = db.execute("SELECT * FROM users WHERE id=?", (BGADM,)).fetchone()   # a BG admin: every count is this group's own

with D() as db:
    NOW = a._now_myt()
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    for cell in a.WINDOW_KEYS:   # every part open, so Home's cells carry their numbers
        db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                   (CID, cell, (NOW - timedelta(days=2)).strftime("%Y-%m-%d %H:%M"),
                    (NOW + timedelta(days=5)).strftime("%Y-%m-%d %H:%M")))
    db.commit()

s.section("the rule: who is counted")
with D() as db:
    tp = {n: a._report_takes_part(db, i, "tm_rated") for n, i in (("IN", IN), ("OUT", OUT), ("LEFT", LEFT))}
s.check("fixture: IN takes part in the 360; OUT (not confirmed) and LEFT do not", tp == {"IN": True, "OUT": False, "LEFT": False}, tp)

bga = H.client_as(a, BGADM)
sup = H.client_as(a, SU["id"])

# ================================================================================================ 1 assessor progress
s.section("1. Assessor progress: the page, its Excel and the MCP count only colleagues who take part")
with D() as db:
    sql, params = a._assessor_progress_query(ME, "", "all", CID)
    prog = {r["employee_id"]: (r["assigned"], r["done"]) for r in db.execute(sql, params)}
s.check("R1 has 1 of 1 (OUT's and LEFT's rows left out) and R2 0 of 1 (OUT's submitted row left out)",
        prog.get("ZZAC-R1") == (1, 1) and prog.get("ZZAC-R2") == (1, 0), prog)
s.check("R3, whose only row is archived, is not on it", "ZZAC-R3" not in prog, prog)
with D() as db:
    sql, params = a._assessor_progress_query(ME, "", "incomplete", CID)
    inc = {r["employee_id"] for r in db.execute(sql, params)}
    sql, params = a._assessor_progress_query(ME, "", "all", OLD)
    old = {r["employee_id"]: (r["assigned"], r["done"]) for r in db.execute(sql, params)}
s.check("incomplete: only R2 still owes", inc == {"ZZAC-R2"}, inc)
s.check("another cycle's counts are unchanged: OUT's rows there still count (R1 1 pending, R2 1 submitted)",
        old.get("ZZAC-R1") == (1, 0) and old.get("ZZAC-R2") == (1, 1), old)
code, ctx = render(sup, "/admin/assessors?fbg=" + BG.replace(" ", "+"))
rows = ctx.get("admin_assessors.html", {}).get("rows", [])
s.check("the /admin/assessors page lists R1 and R2 with those counts and not R3",
        code == 200 and {r["employee_id"]: (r["assigned"], r["done"]) for r in rows} == {"ZZAC-R1": (1, 1), "ZZAC-R2": (1, 0)},
        [(r["employee_id"], r["assigned"], r["done"]) for r in rows])
x = sup.get("/admin/export/assessor-progress.xlsx?fbg=" + BG.replace(" ", "+"))
txt = H.as_csv_text(x)
s.check("its Excel carries the same rows (R1, R2; not R3)", x.status_code == 200 and "ZZAC-R1" in txt and "ZZAC-R2" in txt
        and "ZZAC-R3" not in txt, txt[:300])
with a.app.app_context():
    db = a.get_db()
    mrows, _l, _n = M._part_rows(db, ME, "f360", M._filters(db, ME, {}))
s.check("the MCP's f360 progress / whos_missing rows: R1 submitted, R2 not; no R3",
        {r["eid"]: r["stage"] for r in mrows} == {"ZZAC-R1": "submitted", "ZZAC-R2": "not_started"},
        {r["eid"]: r["stage"] for r in mrows})

# ================================================================================================ 2 owing
s.section("2. Ratings still to come: the rater list and its total")
with D() as db:
    ow = a._list_f360_owing(db, ME, CID, {})
s.check("one rater (R2) still owes one rating: the total and the list agree",
        "Ratings still to come · 1" in ow["title"] and len(ow["rows"]) == 1, (ow["title"], len(ow["rows"])))
with D() as db:
    ow_old = a._list_f360_owing(db, ME, OLD, {})
s.check("on the other cycle OUT's pending row still makes R1 owe one (history is untouched)",
        "Ratings still to come · 1" in ow_old["title"], ow_old["title"])

# ================================================================================================ 3-4 overview and lists
s.section("3-4. The 360 Overview and the people lists")
code, ctx = render(bga, "/admin/360")
d = ctx.get("admin_dashboard.html", {})
s.check("Overview: 1 person rated, 2 asked, 1 in (OUT, LEFT and the archived row are out)",
        code == 200 and (d.get("subjects"), d.get("assignments_total"), d.get("assignments_done")) == (1, 2, 1),
        (code, d.get("subjects"), d.get("assignments_total"), d.get("assignments_done")))
stage_sum = sum(d.get(k) or 0 for k in ("complete", "stage1", "in_progress", "not_started"))
s.check("the stage bar adds up to the people being rated", stage_sum == d.get("subjects") == 1,
        (stage_sum, d.get("subjects")))
dr = [r for r in d.get("dept_rows", []) if r["dept"] == DEPT]
s.check("the department table row: 1 person, 2 asked, 1 done", len(dr) == 1 and (dr[0]["people"], dr[0]["asked"], dr[0]["done"]) == (1, 2, 1),
        [(r["people"], r["asked"], r["done"]) for r in dr])
with D() as db:
    rated = a._list_f360_rated(db, ME, CID, {})
    stages = {k: a._list_f360_stage(db, ME, CID, {"stage": k}) for k in a.F360_STAGES}
    unrel = a._list_ready_unreleased(db, ME, CID, {})
s.check("People being rated lists one person (IN), with 2 raters", "People being rated · 1" in rated["title"]
        and len(rated["rows"]) == 1, rated["title"])
s.check("the four stage lists add up to the people being rated", sum(len(v["rows"]) for v in stages.values()) == 1,
        {k: len(v["rows"]) for k, v in stages.items()})
s.check("the ready-to-release list holds only IN (no report released yet)", len(unrel["rows"]) == 1, len(unrel["rows"]))

def _forbidden():
    try:
        with D() as db:
            a.ADMIN_LISTS["home-cell"]["build"](db, ME, CID, {"col": "f360", "bg": "ZZAC Some Other Group"})
    except Exception as e:   # werkzeug Forbidden
        return getattr(e, "code", None) == 403
    return False


# ================================================================================================ 5 Home
s.section("5. Home's grid: the 360 cell counts RAISERS of ratings (raters done) and its list is those raters")
with D() as db:
    cyc = a.active_cycle(db)
    mx = a._home_bg_matrix(db, ME, cyc, stage="emp")   # the employees' stage: the 360 lives there (2026-11-09)
    keys = [c["key"] for c in mx["cols"]]
    lst = a.ADMIN_LISTS["home-cell"]["build"](db, ME, CID, {"col": "f360", "bg": BG})
    lst_all = a.ADMIN_LISTS["home-cell"]["build"](db, ME, CID, {"col": "f360"})
    # the rule, written out apart from the cell's own SQL: a live rater owing a row for someone taking part, archived left out
    exp = {}
    for r in db.execute("SELECT a.assessor_id, a.status, a.subject_id FROM assignments a JOIN users u ON u.id=a.assessor_id "
                        "WHERE a.cycle_id=? AND a.archived=0 AND u.business_group=? AND u.left_at IS NULL", (CID, BG)):
        if a._report_takes_part(db, r["subject_id"], "tm_rated"):
            exp.setdefault(r["assessor_id"], []).append(r["status"])
    exp_done = {k for k, v in exp.items() if all(x == "submitted" for x in v)}
if "f360" in keys:
    cell = mx["rows"][0]["cells"][keys.index("f360")] if mx["rows"] else {}
    s.check("Home counts the raters by the rule: n raters, d done (R1 done, R2 not; R3 archived-only and R4 out-only are no raters)",
            (cell.get("sub") or "") == "%d of %d raters done" % (len(exp_done), len(exp)) and len(exp) == 2 and len(exp_done) == 1,
            (cell.get("sub"), len(exp), len(exp_done)))
    s.check("...the list is exactly those raters, not done last",
            lst["title"].endswith("%d of %d raters done" % (len(exp_done), len(exp))) and len(lst["rows"]) == len(exp)
            and {r["eid"] for r in lst["rows"]} == {"ZZAC-R1", "ZZAC-R2"} and lst["rows"][0]["eid"] == "ZZAC-R2",
            ([r["eid"] for r in lst["rows"]], lst["title"]))
    s.check("...the All list holds this group's two as well (and never R3 or R4)",
            {"ZZAC-R1", "ZZAC-R2"} <= {r["eid"] for r in lst_all["rows"]}
            and not {"ZZAC-R3", "ZZAC-R4"} & {r["eid"] for r in lst_all["rows"]})
    s.check("a BG admin gets a 403 on another group's list", _forbidden(), None)
    # the panel's "full list" door must open a page (the 360 has no module Progress page: admin_module_progress 404s)
    full = sup.get(lst["full"])
    s.check("...its full-list link opens the assessors page (200), not a 404", full.status_code == 200
            and lst["full"].startswith("/admin/assessors"), (lst["full"], full.status_code))
else:
    s.check("the 360 is on Home's grid", False, keys)

# ================================================================================================ 5b Home's People column
s.section("5b. Home's People column reads taking part | all (the active cycle only)")
import re  # noqa: E402
with D() as db:
    cyc_ = a.active_cycle(db)
    mx = a._home_bg_matrix(db, SU, cyc_, stage="emp")
    row_ = next((r for r in mx["rows"] if r["bg"] == BG), None)
    # the rule written out apart from the matrix's own SQL
    n_part = db.execute("SELECT COUNT(*) FROM users u WHERE u.role!='admin' AND u.left_at IS NULL AND COALESCE(u.is_demo,0)=0 "
                        "AND u.business_group=? AND " + a.participant_sql("u"), (BG,)).fetchone()[0]
    n_live = db.execute("SELECT COUNT(*) FROM users u WHERE u.role!='admin' AND u.left_at IS NULL AND COALESCE(u.is_demo,0)=0 "
                        "AND u.business_group=?", (BG,)).fetchone()[0]
s.check("the group's taking_part = a direct COUNT with participant_sql, and people = its live headcount",
        row_ is not None and row_["taking_part"] == n_part and row_["people"] == n_live, (row_ and (row_["taking_part"], row_["people"]), n_part, n_live))
s.check("fixture sanity: some take part and some do not (OUT is not confirmed), so the split means something",
        0 < n_part < n_live, (n_part, n_live))
s.check("every row: taking part <= all; the total is the sum of the rows",
        all(0 <= r["taking_part"] <= r["people"] for r in mx["rows"])
        and mx["total"]["taking_part"] == sum(r["taking_part"] for r in mx["rows"])
        and mx["total"]["people"] == sum(r["people"] for r in mx["rows"]), None)
code, ctx = render(sup, "/admin?stage=emp")
body = sup.get("/admin?stage=emp").get_data(as_text=True)
m_ = re.search(r"<tr><th scope=\"row\">[^<]*ZZAC[^<]*</th><td class=\"hm-people\">(.*?)</td>", body, re.S)
s.check("the page's header reads 'Taking part | All' and the group's cell reads 'N | M'",
        code == 200 and "Taking part | All" in body and m_ is not None
        and re.sub(r"<[^>]+>|\s+", "", m_.group(1)) == "%d|%d" % (n_part, n_live), (code, m_ and m_.group(1)))
# falsify: a viewed cycle that is not the active one falls back to the total alone
with D() as db:
    past = dict(a.active_cycle(db))
    past["is_active"] = 0
    mx_past = a._home_bg_matrix(db, SU, past)
s.check("guard: a non-active viewed cycle has no split (taking_part None on every row and the total), people unchanged",
        all(r["taking_part"] is None for r in mx_past["rows"]) and mx_past["total"]["taking_part"] is None
        and mx_past["total"]["people"] == mx["total"]["people"], None)
with D() as db:
    mx_none = a._home_bg_matrix(db, SU, None)
s.check("no cycle at all: no split either", mx_none["total"]["taking_part"] is None, None)

# ================================================================================================ 6 readiness
s.section("6. Readiness: Responses in and Reports released")
with D() as db:
    groups, _d, _t = a._cycle_readiness(db, ME, a.active_cycle(db))
steps = {st["label"]: st for g in groups for st in g["steps"]}
ri, rr = steps.get("Responses in"), steps.get("Reports released")
s.check("Responses in is 1 of 2 assessments", ri and (ri["n"], ri["of"]) == (1, 2), ri and (ri["n"], ri["of"]))
s.check("Reports released is 0 of 1 person", rr and (rr["n"], rr["of"]) == (0, 1), rr and (rr["n"], rr["of"]))


def released_state():
    with D() as db:
        g_, _d, _t = a._cycle_readiness(db, ME, a.active_cycle(db))
        st_ = {x["label"]: x for gg in g_ for x in gg["steps"]}["Reports released"]
        return st_["n"], st_["of"], len(a._list_ready_unreleased(db, ME, CID, {})["rows"])


def release(who, on=True):
    with D() as db:
        if on:
            db.execute("INSERT OR REPLACE INTO report_releases(cycle_id, subject_id, released_by) VALUES (?,?,?)",
                       (CID, who, SU["id"]))
        else:
            db.execute("DELETE FROM report_releases WHERE cycle_id=? AND subject_id=?", (CID, who))
        db.commit()


try:
    release(OUT)
    n_, of_, lst_ = released_state()
    s.check("a release on OUT (not taking part) is not counted: still 0 of 1, and IN is still on the list",
            (n_, of_, lst_) == (0, 1, 1), (n_, of_, lst_))
    release(IN)
    n_, of_, lst_ = released_state()
    s.check("IN released too: 1 of 1 and the ready-to-release list is empty", (n_, of_, lst_) == (1, 1, 0), (n_, of_, lst_))
    s.check("of less n is what the ready-to-release list holds, whoever is released", of_ - n_ == lst_, (n_, of_, lst_))
    release(IN, on=False)
    n_, of_, lst_ = released_state()
    s.check("of less n is what the list holds with only OUT released", of_ - n_ == lst_, (n_, of_, lst_))
finally:
    release(OUT, on=False)
    release(IN, on=False)

# ================================================================================================ 7 Group People
s.section("7. Group People > Rater progress")
people = {i: {"job_grade": GRADE} for i in (IN, OUT, LEFT)}
with D() as db:
    v = a._hr_f360(db, ME, a.active_cycle(db), people)
s.check("only IN has a panel: asked 2, submitted 1", list(v["vals"]) == [IN] and v["vals"][IN][:2] == (2, 1), v["vals"])
s.check("the tiles read the same: 1 with a panel, 2 asked, 1 still owed",
        [t["v"] for t in v["tiles"](list(v["vals"].values()))[:3]] == [1, 2, 1])

# ================================================================================================ 8 Admin Agent
s.section("8. The Admin Agent's 360 report")
with D() as db:
    rep = a._agent_report(db, ME, {"kind": "progress", "module": "f360", "group_by": "person"})
rr_ = {r[1]: (r[5], r[6]) for r in rep.get("rows", [])}
s.check("per assessor: R1 1 of 1, R2 0 of 1, no R3", rr_ == {"ZZAC-R1": (1, 1), "ZZAC-R2": (0, 1)}, rep.get("error") or rr_)

# ================================================================================================ 9 360 People
s.section("9. 360 People: with a panel leaves out the people who do not take part; All keeps everyone")
code, ctx = render(sup, "/admin/subjects?scope=with_panel&fbg=" + BG.replace(" ", "+"))
ids = {r["user"]["employee_id"] for r in ctx.get("admin_subjects.html", {}).get("rows", [])}
s.check("with a panel: IN only", code == 200 and ids == {"ZZAC-IN"}, ids)
code, ctx = render(sup, "/admin/subjects?scope=all&fbg=" + BG.replace(" ", "+"))
ids_all = {r["user"]["employee_id"] for r in ctx.get("admin_subjects.html", {}).get("rows", [])}
s.check("All people still lists OUT (and IN)", {"ZZAC-IN", "ZZAC-OUT"} <= ids_all, ids_all)

# ================================================================================================ class B: unchanged
s.section("what must keep seeing every row: the person page's 360 tab and the panel")
page = sup.get("/admin/users/%d?tab=f360" % OUT)
body = page.get_data(as_text=True)
s.check("OUT's person page (360 tab) still opens and shows OUT's raters' rows (R1 and R2 by name)",
        page.status_code == 200 and "ZZ Count R1" in body and "ZZ Count R2" in body, page.status_code)
with D() as db:
    n_panel = db.execute("SELECT COUNT(*) FROM assignments WHERE subject_id=? AND cycle_id=? AND archived=0", (OUT, CID)).fetchone()[0]
s.check("OUT's panel rows are still on file (nothing was deleted)", n_panel == 2, n_panel)
with D() as db:
    _p, _id_of, _l, existing, _b = a._panel_engine_state(db, a.active_cycle(db))
s.check("the panel tools still see OUT's two raters (the panel engine's existing panels)",
        len(existing.get("ZZAC-OUT", {})) == 2, existing.get("ZZAC-OUT"))

_FINISHED = True
sys.exit(s.done())
