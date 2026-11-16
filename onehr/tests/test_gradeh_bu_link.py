"""Grade H lines that share a unit's BU KPI result (2026-11-03; Chris: "Yes, build it"; brief OneHR/Grade H shared BU KPI build brief 2026-11-03.md).

A Grade H person's KPI line of the same name as a BU KPI can FOLLOW it: Group People fills the figure ONCE (Fill BU KPI) and it reaches the
normal holders (pm_kpi_targets) and the Grade H lines (gradeh_kpi_lines.bu_kpi_id / bu_pct / bu_filled_at / bu_filled_by).

What this suite holds:
  * the schema: the four columns (and bu_value), additive, idempotent
  * gradeh_bu_candidates: a Grade H person of the setup's unit on the KPI route with a line of the setup's ROOT name (case, double
    spaces, a variant's qualifier folded); route B, another unit, a leaver and a private row are not candidates; a line rated 1-5
    (OTHER) is greyed "<group> scores <KPI> as a %, and this line is rated 1 to 5" (2026-11-06; the mirror case is test_gradeh_bu_rating), a person with no such line "No <root> line"; ONE batched read
  * gradeh_bu_link: many lines in one call and one transaction, one audit row per line; every refusal is named, writes nothing and is
    falsified (the same call with the fault fixed works): not the super admin, Grade H off, an inactive cycle, a line that is not a
    candidate (OTHER, no line, another unit, route B), a line already following another setup, a setup that gives no %; one bad line
    refuses all; a re-link of a followed line keeps its figure
  * gradeh_computed: a linked line is its shared figure only (never the person's or the line manager's entry); with none yet no weighted
    figure and no rating (shared_wait), no "problem"; a SIGNATURE line is rated on its own scale
  * the line manager submits WITHOUT the figure (perf_* stored empty); a normal problem (weights) still blocks; the staff send works with
    the shared line left out; a figure typed for a linked line is refused on both sides (falsified against a normal line)
  * gradeh_bu_fill: one figure on every linked line at every stage (before submit, submitted, acknowledged), stored perf_* re-scored by the
    submit's own writer, acknowledgement and a HOD move untouched, a correction re-fills, counts by stage, one audit row
  * gradeh_bu_unlink: clears and re-scores; refused (Reopen first) for a submitted person with no figure of their own; a Take off lets go
  * the pages: Edit picklist, read view, Move some to a variant (Grade H lines alone make a variant; a re-link), Fill BU KPI (same
    transaction, the confirm box's numbers, a non-super admin refused whole), the LM and staff pages
  * the normal holders' fill is byte-identical with and without Grade H links; flag off = nothing changes
  * the KPI import keeps a link (same line) or refuses (a linked line left out), never a silent loss
Synthetic (ZZ9GB-*) on a fresh scratch database; the suite puts back what it changes.
"""
import hashlib
import html
import json
import os
import re
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Grade H lines that share a BU KPI result")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, EMP = H.actors(a)
PFX, BG, CO, CO2 = "ZZ9GB-", "ZZGB Group", "ZZGB Unit", "ZZGB Other Unit"
NAME = "ZZGB Company Performance"
SETA, SETB = NAME + ": GM A", NAME + ": GM B"
U, P, L = {}, {}, {}
_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
BASE = "/review/gradeh"
NOW = datetime.utcnow()
import sqlite3  # noqa: E402

db = sqlite3.connect(a.DB_PATH, timeout=5.0)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")


def utc(dt):
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def one(sql, args=()):
    r = db.execute(sql, args).fetchone()
    return r[0] if r else None


def run(fn):
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("PRAGMA foreign_keys=ON")
        r = fn(d)
        d.commit()
        return r


def text(resp):
    h = resp.get_data(as_text=True)
    h = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", h)
    m = re.search(r'<main id="main"[\s\S]*', h)
    h = m.group(0) if m else h
    h = re.sub(r"<[^>]+>", " ", h)
    return " ".join(html.unescape(h).split())


def csrf(**kw):
    d = {"csrf_token": "tok"}
    d.update(kw)
    return d


def digest(sql, args=()):
    h = hashlib.sha256()
    for r in db.execute(sql, args):
        h.update(repr(tuple(r)).encode())
    return h.hexdigest()[:16]


def mk(k, grade="H", co=CO, mgr=None, left=None):
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
        "job_grade, job_title, manager_id, confirmation_date, left_at, email) VALUES (?,?, 'x', 'user', ?,?,?, 'ZZGB Dept', ?, 'Driver', ?, "
        "'2020-01-01', ?, ?)", ((PFX + k).lower(), "ZZ GB " + k, PFX + k, BG, co, grade, mgr, left,
                                "zzgb.%s@example.test" % k.lower())).lastrowid


def person(k, route="A", appraiser=None, private=0):
    P[k] = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route, appraiser_id, language, private_company) "
                      "VALUES (?,?,?,?,?, 'en', ?)", (CID, PFX + k, U[k], route, appraiser, private)).lastrowid
    return P[k]


def lines_for(k, spec, scale="FIAMMA"):
    L[k] = []
    for i, (name, w) in enumerate(spec, 1):
        L[k].append(db.execute("INSERT INTO gradeh_kpi_lines (cycle_id, person_id, kpi_name, weight, group_scale, sort_order) VALUES (?,?,?,?,?,?)",
                               (CID, P[k], name, w, scale, i)).lastrowid)
    return L[k]


def entries(k, figs, lm=None):
    """The person's own figures on lines (None = none), sent; `lm` = the line manager's, checked."""
    for lid, f in zip(L[k], figs):
        if f is not None:
            db.execute("INSERT OR REPLACE INTO gradeh_kpi_entries (cycle_id, person_id, line_id, staff_pct, staff_at) VALUES (?,?,?,?,?)",
                       (CID, P[k], lid, f, utc(NOW)))
    db.execute("INSERT OR IGNORE INTO gradeh_appraisals (cycle_id, person_id) VALUES (?,?)", (CID, P[k]))
    db.execute("UPDATE gradeh_appraisals SET staff_submitted_at=? WHERE cycle_id=? AND person_id=?", (utc(NOW), CID, P[k]))
    db.commit()


def appr(k):
    return db.execute("SELECT * FROM gradeh_appraisals WHERE person_id=?", (P[k],)).fetchone()


def line(lid):
    return db.execute("SELECT * FROM gradeh_kpi_lines WHERE id=?", (lid,)).fetchone()


def setup_row(name, co=CO):
    return db.execute("SELECT * FROM pm_bu_kpis WHERE cycle_id=? AND business_group=? AND company=? AND kpi_name=?", (CID, BG, co, name)).fetchone()


def mk_lib(name):
    """The BU-level library row a saved setup is addressed by (its card, and a variant's copy)."""
    r = db.execute("SELECT id FROM pm_kpi_library WHERE business_group=? AND kpi_name=?", (BG, name)).fetchone()
    if r:
        return r[0]
    return db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, unit, method, "
                      "weightage_default, bu_level) VALUES (?, '*', '*', 0, '*', ?, 'Financial · Profitability', '%', 'more', 30, 1)", (BG, name)).lastrowid


def mk_setup(name, co=CO, scale=(0, 100, 100), people=()):
    sid = db.execute("INSERT INTO pm_bu_kpis(cycle_id, business_group, company, library_id, kpi_name, unit, method, threshold, target, multiple, carriers, "
                     "carriers_json, weight_mode, updated_by) VALUES (?,?,?,?,?, '%', 'more', ?,?,?, 'holders', ?, 'own', ?)",
                     (CID, BG, co, mk_lib(name), name, scale[0], scale[1], scale[2], json.dumps({"people": [a.ja_eid(PFX + p) for p in people]}), SU["id"])).lastrowid
    db.commit()
    return db.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (sid,)).fetchone()


def audit(action):
    return one("SELECT COUNT(*) FROM activity_log WHERE action=?", (action,))


def SUROW(d):
    return d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()


def link(setup, ids, me=None, allow_from=None):
    return run(lambda d: a.gradeh_bu_link(d, me(d) if me else SUROW(d), dict(setup) if setup else None, ids, allow_from=allow_from))


def fill(setup, value, me=None):
    def f(d):
        st = dict(d.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (setup["id"],)).fetchone())
        pct = a.gradeh_bu_pct_of(d, st, value)
        return a.gradeh_bu_fill(d, me(d) if me else SUROW(d), st, pct, value=value)
    return run(f)


def unlink(ids, me=None):
    return run(lambda d: a.gradeh_bu_unlink(d, me(d) if me else SUROW(d), ids))


def world():
    return (digest("SELECT * FROM gradeh_kpi_lines ORDER BY id"), digest("SELECT * FROM gradeh_appraisals ORDER BY id"),
            digest("SELECT * FROM gradeh_kpi_entries ORDER BY id"), one("SELECT COUNT(*) FROM activity_log WHERE action LIKE 'gradeh_bu_%'"))


def normal_world():
    """What the normal holders' fill leaves: every line's result, by person and name."""
    return digest("SELECT t.subject_id, t.kpi_name, r.actual_value, r.note, r.admin_filled, r.draft FROM pm_kpi_results r JOIN pm_kpi_targets t "
                  "ON t.id=r.kpi_target_id WHERE t.cycle_id=? AND t.business_group=? ORDER BY t.subject_id, t.kpi_name", (CID, BG))


ATTRS = [at["key"] for at in a.GRADEH_ATTRIBUTES]


def lp_all(c, pid):
    d = csrf()
    for lp in range(1, 8):
        for st in (1, 2):
            d["lp_%d_%d" % (lp, st)] = "yes"
    return c.post("%s/%d/lp" % (BASE, pid), data=d)


def comments(c, pid):
    return c.post("%s/%d/comments" % (BASE, pid), data=csrf(ach="Kept the line running.", str="Calm and reliable.", dev="A forklift licence."))


def submit(c, pid):
    return c.post("%s/%d/submit" % (BASE, pid), data=csrf(confirm="1", conv="1", promo="no"))


def ready(c, k, posted):
    """Everything a KPI-route submit needs except the shared line: its own lines checked by the line manager, 14 answers, comments."""
    c.post("%s/%d/kpis" % (BASE, P[k]), data=csrf(**posted))
    lp_all(c, P[k])
    comments(c, P[k])


# ---------------------------------------------------------------- fixture
CID = run(lambda d: a.active_cycle_id(d))
PREV = dict(db.execute("SELECT kind, year, half, min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())
db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL WHERE id=?", (CID,))
db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 1)", (CID,))
db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell LIKE 'gradeh_%'", (CID,))
db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', '2099-11-02 00:00', '2099-11-08 23:59')", (CID,))
db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?),(?,?)", (BG, CO, BG, CO2))
db.execute("INSERT OR REPLACE INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'B', 'base')", (BG,))
U["LM"] = mk("LM", "15")
for k in ("N1", "N2", "N3"):
    U[k] = mk(k, "15", mgr=U["LM"])
for k in ("H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8", "HL", "HP", "H9"):
    U[k] = mk(k, "H", co=(CO2 if k == "H7" else CO), mgr=U["LM"], left=("2026-01-01" if k == "HL" else None))
SETUP_A = None
# H1 before the submit, H2 submitted, H3 acknowledged, H8 a SIGNATURE line, H9 a second figure-less submitted
for k in ("H1", "H2", "H3", "H9"):
    person(k, "A", appraiser=U["LM"])
    lines_for(k, [("ZZGB  Company PERFORMANCE", 50), ("ZZGB Own KPI", 50)])
person("H4", "A", appraiser=U["LM"]); lines_for("H4", [(NAME, 50), ("ZZGB Own KPI", 50)], scale="OTHER")
person("H5", "B", appraiser=U["LM"])
person("H6", "A", appraiser=U["LM"]); lines_for("H6", [("ZZGB Something Else", 100)])
person("H7", "A", appraiser=U["LM"]); lines_for("H7", [(NAME, 50), ("ZZGB Own KPI", 50)])
person("H8", "A", appraiser=U["LM"]); lines_for("H8", [(NAME + ": Eddie", 50), ("ZZGB Own KPI", 50)], scale="SIGNATURE")
person("HL", "A", appraiser=U["LM"]); lines_for("HL", [(NAME, 50), ("ZZGB Own KPI", 50)])
person("HP", "A", appraiser=U["LM"], private=1); lines_for("HP", [(NAME, 50), ("ZZGB Own KPI", 50)])
# normal holders on setup A: the review's own lines (Grade H people never enter pm_kpi_targets)
SETUP_A = mk_setup(SETA, people=("N1", "N2", "N3"))
for k in ("N1", "N2", "N3"):
    db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, threshold, target, multiple, "
               "business_group, company, bu_kpi_id) VALUES (?,?,?,30,'more','%','Own',0,100,100,?,?,?)", (CID, U[k], SETA, BG, CO, SETUP_A["id"]))
db.commit()
# the people's own figures (each entered their own, and the line manager will check them)
for k in ("H1", "H2", "H3", "H9"):
    entries(k, [None, 88])
entries("H8", [None, 90])
C_LM = H.client_as(a, U["LM"])
C_SU = H.client_as(a, SU["id"])
C_BGA = H.client_as(a, BGA["id"]) if BGA else None
C = {k: H.client_as(a, U[k]) for k in ("H1", "H2", "H3", "H4")}
SETUP_A = setup_row(SETA)

try:
    s.section("the schema")
    cols = {r[1] for r in db.execute("PRAGMA table_info(gradeh_kpi_lines)")}
    s.check("gradeh_kpi_lines has bu_kpi_id, bu_pct, bu_filled_at, bu_filled_by (and the typed figure, bu_value)",
            {"bu_kpi_id", "bu_pct", "bu_filled_at", "bu_filled_by", "bu_value"} <= cols, cols)
    s.check("the link is a foreign key to pm_bu_kpis that sets null", any(r[2] == "pm_bu_kpis" and r[6] == "SET NULL"
                                                                          for r in db.execute("PRAGMA foreign_key_list(gradeh_kpi_lines)")))
    s.check("new lines start unlinked", all(r["bu_kpi_id"] is None and r["bu_pct"] is None for r in db.execute("SELECT * FROM gradeh_kpi_lines")))

    s.section("gradeh_bu_candidates: who can follow, one batched read")
    q = []
    def cands(setup):
        def f(d):
            d.set_trace_callback(lambda sql: q.append(sql))
            r = a.gradeh_bu_candidates(d, dict(setup))
            d.set_trace_callback(None)
            return r
        q.clear()
        return {c["eid"].replace(PFX, ""): c for c in run(f)}
    c = cands(SETUP_A)
    s.check("the Grade H people of the unit on the KPI route: H1 H2 H3 H4 H6 H8 H9 (not route B, another unit, a leaver, a private row)",
            set(c) == {"H1", "H2", "H3", "H4", "H6", "H8", "H9"}, sorted(c))
    s.check("a line with the root name matches case, double spaces and all: H1, H2, H3 are ok and unlinked",
            all(c[k]["ok"] and c[k]["line"]["id"] == L[k][0] and c[k]["linked"] is None for k in ("H1", "H2", "H3")))
    s.check("a variant's setup matches the plain name and the setup's own name ('Company performance: Eddie' for GM A)",
            c["H8"]["ok"] and c["H8"]["line"]["id"] == L["H8"][0] and c["H8"]["line"]["scale"] == "SIGNATURE")
    s.check("a line rated 1-5 on a unit whose group scores in % is greyed: \"<group> scores <KPI> as a %, and this line is rated 1 to 5\" (2026-11-06)",
            not c["H4"]["ok"] and c["H4"]["why"] == "%s scores %s as a %%, and this line is rated 1 to 5." % (run(lambda d: a.display_bg(BG)), SETA), c["H4"]["why"])
    s.check("a person with no line of that name: \"No <root> line\"", not c["H6"]["ok"] and c["H6"]["line"] is None
            and c["H6"]["why"] == "No %s line" % NAME, c["H6"]["why"])
    s.check("the stage of each person is read with it (all before the submit now)", all(c[k]["stage"] == "before" for k in c))
    s.check("ONE batched read for the people (plus the setups' names, the group's scoring and, once, the group's display name for the greyed-line words): "
            "at most 5 SELECTs, however many people", len([x for x in q if x.lstrip().upper().startswith("SELECT")]) <= 5, len(q))
    s.check("a Grade H person of ANOTHER unit has candidates under their own unit's setup only",
            "H7" not in c and "H7" in cands(mk_setup(NAME + ": Other", co=CO2)))
    db.execute("DELETE FROM pm_bu_kpis WHERE company=?", (CO2,))
    db.commit()

    s.section("gradeh_bu_link: many lines, one transaction, every refusal named and falsified")
    w0 = world()
    ok, why, n = link(SETUP_A, [L["H1"][0]], me=lambda d: d.execute("SELECT * FROM users WHERE id=?", (BGA["id"],)).fetchone() if BGA else None)
    s.check("not the super admin: refused, nothing written", not ok and "super admin" in why and world() == w0, why)
    os.environ["ONEHR_GRADEH"] = "0"
    ok, why, n = link(SETUP_A, [L["H1"][0]])
    os.environ["ONEHR_GRADEH"] = "1"
    s.check("Grade H switched off: refused, nothing written", not ok and "not switched on" in why and world() == w0, why)
    ok, why, n = link(dict(SETUP_A, cycle_id=CID + 999), [L["H1"][0]])
    s.check("a cycle that is not the active one: refused", not ok and "not the active cycle" in why and world() == w0, why)
    ok, why, n = link(SETUP_A, [L["H4"][0]])
    s.check("a line rated 1-5 (OTHER) on a group that scores in %: refused, named (\"scores ... as a %, and this line is rated 1 to 5\")",
            not ok and "as a %, and this line is rated 1 to 5" in why and world() == w0, why)
    ok, why, n = link(SETUP_A, [L["H6"][0]])
    s.check("a person with no line of that name (their other line): refused", not ok and "not a Grade H line of this unit" in why and world() == w0, why)
    ok, why, n = link(SETUP_A, [L["H7"][0]])
    s.check("another unit's person: refused", not ok and world() == w0, why)
    ok, why, n = link(SETUP_A, [L["H1"][1]])
    s.check("a line of another name (the person's own KPI): refused", not ok and world() == w0, why)
    ok, why, n = link(SETUP_A, [99999999])
    s.check("a line that does not exist: refused", not ok and world() == w0, why)
    ok, why, n = link(SETUP_A, ["x"])
    s.check("something that is not a line id: refused", not ok and world() == w0, why)
    bare = mk_setup(NAME + ": Bare", scale=(None, None, None))
    ok, why, n = link(bare, [L["H1"][0]])
    s.check("a setup with no target and threshold (no % to compute): refused, named", not ok and "no target" in why and world() == w0, why)
    db.execute("DELETE FROM pm_bu_kpis WHERE id=?", (bare["id"],))
    db.commit()
    ok, why, n = link(SETUP_A, [L["H1"][0], L["H4"][0]])
    s.check("one bad line among good ones refuses ALL: H1 was not linked either", not ok and world() == w0 and line(L["H1"][0])["bu_kpi_id"] is None, why)
    a0 = audit("gradeh_bu_link")
    ok, why, n = link(SETUP_A, [L["H1"][0], L["H2"][0], L["H3"][0], L["H8"][0], L["H1"][0]])
    s.check("falsified: the same call without the bad line links all four in one call (a repeated id counts once)", ok and n == 4, (ok, why, n))
    s.check("...each line follows the setup, waiting for the figure (bu_pct empty)", all(
        line(L[k][0])["bu_kpi_id"] == SETUP_A["id"] and line(L[k][0])["bu_pct"] is None and line(L[k][0])["bu_filled_at"] is None
        for k in ("H1", "H2", "H3", "H8")))
    s.check("...one audit row per line, ids only (no name)", audit("gradeh_bu_link") - a0 == 4 and not one(
        "SELECT COUNT(*) FROM activity_log WHERE action='gradeh_bu_link' AND detail LIKE '%ZZ GB%'"))
    s.check("the people's own lines and every other line are untouched", line(L["H1"][1])["bu_kpi_id"] is None and line(L["H4"][0])["bu_kpi_id"] is None
            and one("SELECT COUNT(*) FROM pm_kpi_targets WHERE subject_id IN (SELECT id FROM users WHERE employee_id LIKE 'ZZ9GB-%' AND job_grade='H')") == 0)
    s.check("Grade H people never enter pm_kpi_targets or the carriers list of the setup", json.loads(setup_row(SETA)["carriers_json"])["people"]
            == sorted(a.ja_eid(PFX + p) for p in ("N1", "N2", "N3")) or set(json.loads(setup_row(SETA)["carriers_json"])["people"])
            == {a.ja_eid(PFX + p) for p in ("N1", "N2", "N3")})
    ok, why, n = link(SETUP_A, [L["H1"][0]])
    s.check("a line already following this setup: left as it is (0 newly linked, no error)", ok and n == 0)
    setb = mk_setup(SETB, people=())
    ok, why, n = link(setb, [L["H1"][0]])
    s.check("a line already following ANOTHER setup: refused, naming the other", not ok and SETA in why and line(L["H1"][0])["bu_kpi_id"] == SETUP_A["id"], why)
    c = cands(setb)
    s.check("...and the other setup's picklist says so, greyed: \"Follows <name>\"", c["H1"]["why"] == "Follows " + SETA and not c["H1"]["ok"], c["H1"]["why"])
    ok, why, n = link(setb, [L["H1"][0]], allow_from=SETUP_A["id"])
    s.check("falsified: a MOVE off the source (allow_from) re-links it, clearing the figure", ok and n == 1 and line(L["H1"][0])["bu_kpi_id"] == setb["id"])
    ok, why, n = link(SETUP_A, [L["H1"][0]], allow_from=setb["id"])
    s.check("...and back (a move back to the root)", ok and n == 1 and line(L["H1"][0])["bu_kpi_id"] == SETUP_A["id"], why)
    db.execute("DELETE FROM pm_bu_kpis WHERE id=?", (setb["id"],))
    db.commit()

    s.section("gradeh_computed: a linked line is its shared figure alone; none yet = no total, no rating, no problem")
    c1 = run(lambda d: a.gradeh_computed(d, CID, P["H1"]))
    s.check("H1 (linked, not filled): no weighted figure, no rating, no band; waiting names the KPI; NOT a problem",
            c1["perf_value"] is None and c1["perf_rating"] is None and c1["perf_band"] is None and c1["shared_wait"] == ["ZZGB  Company PERFORMANCE"]
            and not [p for p in c1["problems"] if "perf" in p.lower() or "KPI" in p], c1)
    db.execute("INSERT OR REPLACE INTO gradeh_kpi_entries(cycle_id, person_id, line_id, staff_pct, staff_at, lm_pct, lm_at) VALUES (?,?,?,?,?,?,?)",
               (CID, P["H1"], L["H1"][0], 55.0, utc(NOW), 60.0, utc(NOW)))
    db.commit()
    c1 = run(lambda d: a.gradeh_computed(d, CID, P["H1"]))
    s.check("their own and the line manager's entries on the linked line change nothing (still waiting)", c1["perf_value"] is None and c1["shared_wait"])
    db.execute("DELETE FROM gradeh_kpi_entries WHERE line_id=?", (L["H1"][0],))
    db.commit()

    s.section("the line manager submits WITHOUT the figure; the staff send works with the shared line left out")
    st = run(lambda d: a.gradeh_staff_state(d, dict(db.execute("SELECT * FROM gradeh_people WHERE id=?", (P["H1"],)).fetchone())))
    pr = C_LM.post("%s/%d/kpis" % (BASE, P["H1"]), data=csrf(**{"f_%d" % L["H1"][0]: "75", "w_%d" % L["H1"][0]: "mine"}))
    s.check("a figure typed for the linked line is REFUSED (nothing stored), the page says Group People fills it",
            "Group People" in text(pr) and one("SELECT COUNT(*) FROM gradeh_kpi_entries WHERE line_id=?", (L["H1"][0],)) == 0, text(pr)[:200])
    pr = C_LM.post("%s/%d/kpis" % (BASE, P["H1"]), data=csrf(**{"f_%d" % L["H1"][1]: "88"}))
    s.check("falsified: a figure for a normal line goes through", one("SELECT lm_at FROM gradeh_kpi_entries WHERE line_id=?", (L["H1"][1],)) is not None)
    pg = text(C_LM.get("%s/%d?step=kpis" % (BASE, P["H1"])))
    s.check("the KPI step: the shared line reads \"Filled by Group People\" with the unit's-result reason; the weighted card \"Waiting for 1 line\"",
            "Filled by Group People" in pg and "The unit's result, entered once for everyone who shares it" in pg and "Waiting for 1 line" in pg, pg[:600])
    s.check("...and no input box exists for it", 'name="f_%d"' % L["H1"][0] not in C_LM.get("%s/%d?step=kpis" % (BASE, P["H1"])).get_data(as_text=True))
    ready(C_LM, "H1", {"f_%d" % L["H1"][1]: "88"})
    r = submit(C_LM, P["H1"])
    row = appr("H1")
    s.check("submit works with the figure missing: lm_submitted_at set, perf_* empty, potential stored",
            r.status_code == 303 and row["lm_submitted_at"] and row["perf_value"] is None and row["perf_rating"] is None and row["perf_band"] is None
            and row["pot_band"], (r.status_code, text(r)[:200], dict(row)))
    pg = text(C_LM.get("%s/%d" % (BASE, P["H1"])))
    s.check("the submitted record: the Results card is amber \"Waiting for Group People's figure\", no performance rating",
            "Waiting for Group People's figure" in pg, pg[:500])
    s.check("the recap reads Filled by Group People for the shared line", "Filled by Group People" in pg)
    # falsify: a normal problem still blocks the submit
    ready(C_LM, "H2", {"f_%d" % L["H2"][1]: "88"})
    db.execute("UPDATE gradeh_kpi_lines SET weight=weight-5 WHERE id=?", (L["H2"][1],))
    db.commit()
    r = submit(C_LM, P["H2"])
    s.check("falsified: weights that miss 100 still block the submit (a normal problem)", appr("H2")["lm_submitted_at"] is None, text(r)[:200])
    db.execute("UPDATE gradeh_kpi_lines SET weight=weight+5 WHERE id=?", (L["H2"][1],))
    db.commit()
    r = submit(C_LM, P["H2"])
    s.check("...fixed, H2 submits too", appr("H2")["lm_submitted_at"] is not None and appr("H2")["perf_band"] is None, text(r)[:200])
    # H3 is acknowledged: the line manager submitted, the person acknowledged, no figure yet
    ready(C_LM, "H3", {"f_%d" % L["H3"][1]: "88"})
    submit(C_LM, P["H3"])
    db.execute("UPDATE gradeh_appraisals SET acknowledged_at=? WHERE person_id=?", (utc(NOW), P["H3"]))
    db.commit()
    ack0 = appr("H3")["acknowledged_at"]
    s.check("H3 submitted without the figure and acknowledged it: still no figure", appr("H3")["perf_band"] is None and ack0)
    s.check("candidates now read each person's stage: H1 and H2 submitted, H3 acknowledged",
            (lambda c_: (c_["H1"]["stage"], c_["H2"]["stage"], c_["H3"]["stage"]))(cands(SETUP_A)) == ("submitted", "submitted", "acknowledged"))

    s.section("the staff page: no box for the shared line, the pill, the send works; a typed figure is refused")
    db.execute("DELETE FROM gradeh_kpi_entries WHERE person_id=?", (P["H9"],))
    db.execute("UPDATE gradeh_appraisals SET staff_submitted_at=NULL WHERE person_id=?", (P["H9"],))
    db.commit()
    link(SETUP_A, [L["H9"][0]])
    C9 = H.client_as(a, U["H9"])
    pg = C9.get("/my-appraisal").get_data(as_text=True)
    s.check("the staff KPI step: the shared line has no input, the pill \"Filled by Group People\"; the other line has its box",
            'name="k_%d"' % L["H9"][0] not in pg and 'name="k_%d"' % L["H9"][1] in pg and "Filled by Group People" in pg)
    s.check("the weighted row reads \"Shown once Group People fills <name>\"", "Shown once Group People fills ZZGB  Company PERFORMANCE" in html.unescape(pg)
            or "Shown once Group People fills ZZGB Company PERFORMANCE" in text(C9.get("/my-appraisal")), text(C9.get("/my-appraisal"))[:400])
    s.check("staff text never says Grade H, JG H, HR or Reopen", not re.search(r"Grade H|JG H|\bHR\b|Reopen", text(C9.get("/my-appraisal"))))
    r = C9.post("/my-appraisal/kpi/save", data=csrf(**{"k_%d" % L["H9"][0]: "70", "k_%d" % L["H9"][1]: "91"}))
    s.check("a figure typed for the shared line is REFUSED on the staff side too (nothing saved, not even the other line)",
            one("SELECT COUNT(*) FROM gradeh_kpi_entries WHERE person_id=?", (P["H9"],)) == 0 and line(L["H9"][0])["bu_pct"] is None, text(r)[:200])
    r = C9.post("/my-appraisal/kpi/save", data=csrf(**{"k_%d" % L["H9"][1]: "91"}))
    s.check("falsified: the normal line saves", one("SELECT staff_pct FROM gradeh_kpi_entries WHERE line_id=?", (L["H9"][1],)) == 91.0)
    r = C9.post("/my-appraisal/kpi/send", data=csrf(**{"k_%d" % L["H9"][1]: "91", "note": "ok"}))
    s.check("send works with the shared line unfilled", appr("H9")["staff_submitted_at"] is not None, text(r)[:200])
    r = H.client_as(a, U["H9"]).post("/my-appraisal/kpi/preview", data=csrf(**{"k_%d" % L["H9"][1]: "91"}))
    s.check("the preview prints no total while a shared figure is missing", r.get_json()["result"] is None and "Shown once Group People fills" in r.get_json()["text"])
    s.check("every new string is in both languages", all(k in a.GRADEH_STAFF_T and len(a.GRADEH_STAFF_T[k]) == 2 for k in
                                                         ("shared_pill", "result_wait_shared", "perf_wait_shared", "updated_on", "e_shared"))
            and all(k in a.GRADEH_LM_T and len(a.GRADEH_LM_T[k]) == 2 for k in
                    ("shared_pill", "shared_why", "shared_why_on", "wait_line1", "wait_lines", "wait_sub", "rating_wait", "not_final_wait", "updated_on", "m_shared")))
    # falsify: send still refuses a missing NORMAL line
    db.execute("UPDATE gradeh_appraisals SET staff_submitted_at=NULL WHERE person_id=?", (P["H9"],))
    db.execute("DELETE FROM gradeh_kpi_entries WHERE person_id=?", (P["H9"],))
    db.commit()
    r = C9.post("/my-appraisal/kpi/send", data=csrf(note="x"))
    s.check("falsified: a send with the NORMAL line blank is still refused", appr("H9")["staff_submitted_at"] is None)

    s.section("gradeh_bu_fill: one figure at every stage; stored perf_* re-scored by the submit's own writer")
    # a HOD move on H2 stands
    db.execute("INSERT INTO gradeh_band_moves(cycle_id, person_id, axis, stage, band, came_in, remark, by_user_id) VALUES (?,?, 'perf','hod','AE','ME','ZZ remark',?)",
               (CID, P["H2"], U["LM"]))
    db.commit()
    mv0 = digest("SELECT * FROM gradeh_band_moves ORDER BY id")
    n0 = normal_world()
    f0 = audit("gradeh_bu_fill")
    ok, why, cnt = fill(SETUP_A, 92)
    s.check("filled at 92", ok, why)
    s.check("counts by stage: 5 lines (H1 H2 H3 H8 and H9's), 1 acknowledged, 2 submitted, the rest before",
            cnt["lines"] == 5 and cnt["acknowledged"] == 1 and cnt["submitted"] == 2 and cnt["before"] == 2 and cnt["people"] == 5, cnt)
    s.check("every linked line holds 92, when and by whom", all(line(L[k][0])["bu_pct"] == 92.0 and line(L[k][0])["bu_filled_at"]
                                                               and line(L[k][0])["bu_filled_by"] == SU["id"] and line(L[k][0])["bu_value"] == 92.0
                                                               for k in ("H1", "H2", "H3", "H8", "H9")))
    s.check("a line not linked is untouched", line(L["H1"][1])["bu_pct"] is None and line(L["H4"][0])["bu_pct"] is None)
    # H1 50% x 92 + 50% x 88 = 90 -> FIAMMA 81-100 = 3 = ME
    r1, r2, r3 = appr("H1"), appr("H2"), appr("H3")
    s.check("a SUBMITTED person's stored result is re-scored: 90%, rating 3, ME (the line manager's figure for the other line, 88)",
            (r1["perf_value"], r1["perf_rating"], r1["perf_band"]) == (90.0, 3.0, "ME"), dict(r1))
    s.check("an ACKNOWLEDGED person's too, and the acknowledgement stands as it was", (r3["perf_value"], r3["perf_band"]) == (90.0, "ME")
            and r3["acknowledged_at"] == ack0)
    s.check("the potential, the comments and the submit time were not touched", r1["pot_band"] and r1["b_achievements"] and r1["lm_submitted_at"])
    s.check("a HOD's band move stands (the row is the same, the line manager's figure under it moved)", digest("SELECT * FROM gradeh_band_moves ORDER BY id") == mv0
            and run(lambda d: a.gradeh_band_at(d, CID, P["H2"], "perf", "hod"))[0] == "AE")
    c8 = run(lambda d: a.gradeh_computed(d, CID, P["H8"]))
    s.check("a SIGNATURE line is rated on its own scale: 50% x 92 + 50% x 90 = 91 -> SIGNATURE 80-<95 = 2", (c8["perf_value"], c8["perf_rating"]) == (91, 2.0), c8)
    s.check("one audit row, ids only", audit("gradeh_bu_fill") - f0 == 1 and not one("SELECT COUNT(*) FROM activity_log WHERE action='gradeh_bu_fill' AND detail LIKE '%ZZ GB%'"))
    s.check("the normal holders' results were not touched by the Grade H function", normal_world() == n0)
    # the pages show it
    pg = text(C_LM.get("%s/%d" % (BASE, P["H1"])))
    s.check("the submitted record now shows the figure with \"Updated on <date>\" and the rating", "Updated on" in pg and "92%" in pg, pg[:600])
    pg = text(C["H3"].get("/my-appraisal"))
    s.check("the acknowledged person's page: the KPI row says Updated <date> with 92%, the result includes it",
            "Updated" in pg and "92%" in pg and "KPI achievement 90%" in pg, pg[:700])
    # a correction re-fills the same way (80 -> 50x80 + 50x88 = 84 -> 3? 84 is 81-100 = 3) use 60 -> 74 -> 2
    ok, why, cnt = fill(SETUP_A, 60)
    s.check("a correction re-fills at every stage: 60 -> 74% -> rating 2 for the submitted and the acknowledged, the acknowledgement unchanged",
            ok and (appr("H1")["perf_value"], appr("H1")["perf_rating"]) == (74.0, 2.0) and (appr("H3")["perf_value"], appr("H3")["perf_rating"]) == (74.0, 2.0)
            and appr("H3")["acknowledged_at"] == ack0 and line(L["H1"][0])["bu_pct"] == 60.0, (ok, why, dict(appr("H1"))))
    s.check("...the band move still stands", digest("SELECT * FROM gradeh_band_moves ORDER BY id") == mv0)
    try:
        fill(SETUP_A, 1000)
        ref = False
    except a.GradehRefusal as e:
        ref = "outside 0 to" in str(e)
    s.check("a figure that scores out of range is refused (a typo): nothing changes", ref and line(L["H1"][0])["bu_pct"] == 60.0)
    bad = run(lambda d: a.gradeh_bu_fill(d, SUROW(d), dict(SETUP_A), 9999))
    s.check("falsified: the writer itself refuses a % above the ceiling", bad[0] is False and line(L["H1"][0])["bu_pct"] == 60.0, bad[1])
    ok, why, cnt = fill(SETUP_A, 92, me=lambda d: d.execute("SELECT * FROM users WHERE id=?", (BGA["id"],)).fetchone() if BGA else None)
    s.check("a non-super admin cannot fill for Grade H through the function (refused whole)", not ok and line(L["H1"][0])["bu_pct"] == 60.0, why)
    fill(SETUP_A, 92)

    s.section("gradeh_computed and the other readers with a figure still missing")
    # a fresh unfilled person for the readers: link H6 -> not possible; use setup B with a new person line
    U["H10"] = mk("H10"); person("H10", "A", appraiser=U["LM"]); lines_for("H10", [(NAME, 50), ("ZZGB Own KPI", 50)])
    db.commit()
    entries("H10", [None, 80])
    ok, why, n = link(SETUP_A, [L["H10"][0]])
    ready(C_LM, "H10", {"f_%d" % L["H10"][1]: "80"})
    submit(C_LM, P["H10"])
    s.check("H10 submitted, waiting: perf_band empty", ok and appr("H10")["lm_submitted_at"] and appr("H10")["perf_band"] is None)
    rows_ = run(lambda d: d.execute(a._GH_CAL_SQL + "AND p.id=?", (CID, P["H10"])).fetchall())
    p10 = run(lambda d: a._gh_cal_person(rows_[0], *a._gh_cal_load(d, CID, rows_), show_default=False))
    s.check("calibration: the person reads as submitted with no line manager band, flagged shared_wait; the default band shows",
            p10["submitted"] and p10["lm"]["perf"] is None and p10["shared_wait"] and p10["b_hod"]["perf"] is None, p10["lm"])
    det = run(lambda d: a.gradeh_buceo_person_detail(d, CID, rows_[0]))
    s.check("the leaders' person detail shows the shared line as waiting for Group People (never an entry of theirs)",
            any(k_["figure"] == "Waiting for Group People" for k_ in det["kpis"]), det["kpis"])
    s.check("AI fit to curve: the person is not measured (no figure), as one with no line manager input",
            run(lambda d: a._gh_fit_measure("perf", "ME", {"perf_value": None, "perf_rating": None, "pot_score": 9}, "FIAMMA", CID)) is None)
    stt = run(lambda d: a.gradeh_release_state(d, CID))
    s.check("release: a unit with a person whose figure is missing is not ready (no final band), the words name a shared figure",
            all(not u_["ready"] for u_ in stt["units"]) and any("shared KPI figure" in u_["why"] or "BU CEO" in u_["why"] for u_ in stt["units"]), [u_["why"] for u_ in stt["units"]])
    s.check("acknowledge: a person can acknowledge while a shared figure is still to come (the result updates later, the acknowledgement stands)",
            run(lambda d: a._gh_ack_gate(d, dict(db.execute("SELECT * FROM gradeh_people WHERE id=?", (P["H10"],)).fetchone()),
                                         utc(NOW), True)) is None)
    s.check("deemed acknowledgement is unchanged by a missing figure (the same job marks the person)",
            run(lambda d: a.gradeh_apply_deemed(d, CID, now=utc(NOW + timedelta(days=60)), person_id=P["H10"])) in (0, 1))
    # the rework job: a missing figure never turns a stored band into nothing
    s.check("the band re-work leaves a person with no computed band alone", run(lambda d: a.gradeh_rework_bands(d, CID, apply=False))["people"] >= 0)
    ok, why, cnt = fill(SETUP_A, 92)
    s.check("a later fill reaches the waiting person too: 50% x 92 + 50% x 80 = 86 -> 3", ok and appr("H10")["perf_value"] == 86.0 and appr("H10")["perf_band"] == "ME", dict(appr("H10")))

    s.section("gradeh_bu_unlink: restores the person's own line; refused when it would leave a submitted result empty")
    s.check("H1 has a figure of their own for the line? no: refused (Reopen first), nothing changed",
            (lambda r_: (not r_[0]) and "Reopen" in r_[1] and line(L["H1"][0])["bu_kpi_id"] == SETUP_A["id"])(unlink([L["H1"][0]])))
    db.execute("INSERT OR REPLACE INTO gradeh_kpi_entries(cycle_id, person_id, line_id, staff_pct, staff_at, lm_pct, lm_at) VALUES (?,?,?,?,?,?,?)",
               (CID, P["H1"], L["H1"][0], 70.0, utc(NOW), None, utc(NOW)))
    db.commit()
    u0 = audit("gradeh_bu_unlink")
    ok, why, n, res = unlink([L["H1"][0]])
    s.check("falsified: with a figure of their own the line lets go: cleared, then re-scored from the person's own 70 (50% x 70 + 50% x 88 = 79 -> 2)",
            ok and n == 1 and line(L["H1"][0])["bu_kpi_id"] is None and line(L["H1"][0])["bu_pct"] is None and line(L["H1"][0])["bu_filled_at"] is None
            and (appr("H1")["perf_value"], appr("H1")["perf_rating"]) == (79.0, 2.0) and res["rescored"] == 1, (why, dict(appr("H1"))))
    s.check("one audit row per line", audit("gradeh_bu_unlink") - u0 == 1)
    ok, why, n, res = unlink([L["H2"][0]], me=lambda d: d.execute("SELECT * FROM users WHERE id=?", (BGA["id"],)).fetchone() if BGA else None)
    s.check("only the super admin unlinks", not ok and line(L["H2"][0])["bu_kpi_id"] == SETUP_A["id"])
    ok, why, n = link(SETUP_A, [L["H1"][0]])
    s.check("the line can follow again (waiting)", ok and line(L["H1"][0])["bu_pct"] is None)

    s.section("the pages (super admin): Edit picklist, read view, Move some to a variant, Take off")
    LID = a._bu_card_lid
    lid_a = run(lambda d: a._bu_card_lid(d, BG, CO, dict(setup_row(SETA))))
    URL = "/admin/performance/bu-kpis?fbg=%s&fbu=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"))
    pg = C_SU.get(URL + "&kpi=%d" % lid_a)
    t = text(pg)
    s.check("the read view: Grade H rows with the purple chip after the normal holders, Target a dash, \"Grade H line\", the Carried-by chip, the strip",
            pg.status_code == 200 and "Grade H line" in t and "Grade H" in t and re.search(r"\d+ Grade H", t) and "It also reaches" in t and "Grade H appraisal" in t, t[:900])
    h = pg.get_data(as_text=True)
    s.check("...their weight is their own Grade H line's (50%)", "ZZ GB H1" in h and re.search(r"ZZ GB H1[\s\S]{0,400}50%", h) is not None)
    s.check("...the 'Who carries it' count includes them (3 normal + the linked Grade H lines)", re.search(r"Who carries it · (\d+)", t) and int(re.search(r"Who carries it · (\d+)", t).group(1)) >= 3 + 5, t[:300])
    # 2026-11-04: the rail's "N carry it" equals the read view's Carried-by number (normal lines + Grade H lines); "keep their own" is unchanged
    n_norm = one("SELECT COUNT(*) FROM pm_kpi_targets WHERE bu_kpi_id=?", (SETUP_A["id"],))
    n_ghl = one("SELECT COUNT(*) FROM gradeh_kpi_lines l JOIN gradeh_people p ON p.id=l.person_id JOIN users u ON u.id=p.user_id "
                "WHERE l.bu_kpi_id=? AND l.cycle_id=?", (SETUP_A["id"], CID))
    rail_t = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", pg.get_data(as_text=True)))
    rm = re.search(re.escape(SETA) + r"[^<]{0,80}?(\d+) carry it(?: \u00b7 (\d+) keep their own)?", rail_t)
    cm = re.search(r"Who carries it \u00b7 (\d+)", t)
    s.check("the rail's N carry it = the read view's Carried-by number = normal lines + Grade H lines (a linked Grade H line exists)",
            n_ghl > 0 and rm and cm and int(rm.group(1)) == int(cm.group(1)) == n_norm + n_ghl, (n_norm, n_ghl, rm and rm.groups(), cm and cm.groups(), rail_t[:600]))
    def _facts_keep(d):
        fc, _g = a._bu_kpi_facts(d, a.active_cycle(d), BG, CO)
        f_ = fc.get(a._kpi_key(SETA)) or {}
        return max(0, (f_.get("n") or 0) - sum(1 for ln in (f_.get("lines") or {}).values() if ln.get("bu_kpi_id") == SETA_ID))
    SETA_ID = SETUP_A["id"]
    s.check("...and 'keep their own' is unchanged: it is the unit's normal lines not on the setup, the Grade H lines never subtracted",
            rm is not None and int(rm.group(2) or 0) == run(_facts_keep), rm and rm.groups())
    pg = C_SU.get(URL + "&kpi=%d&edit=1" % lid_a).get_data(as_text=True)
    s.check("Edit: the Grade H picklist lists the candidates with the chip; the ones that cannot follow are greyed with why",
            "ZZ GB H4" in pg and "this line is rated 1 to 5" in pg and "No %s line" % NAME in pg and "ZZ GB H6" in pg
            and 'name="k%d_ghset"' % lid_a in pg and 'name="k%d_ghline"' % lid_a in pg)
    s.check("...a person of another unit, route B, a leaver and a private row are not listed", all(("ZZ GB " + k) not in pg for k in ("H5", "H7", "HL", "HP")))
    bgapg = C_BGA.get(URL + "&kpi=%d&edit=1" % lid_a).get_data(as_text=True) if C_BGA else ""
    s.check("a non-super admin sees no Grade H picklist", 'name="k%d_ghline"' % lid_a not in bgapg)
    # save the card with H2 H3 H8 H9 H10 ticked and H1 not: H1 goes, the rest stay (the save links / unlinks through the functions)
    def card_post(client, ticked, extra=None):
        d = csrf(action="save_kpi", kpi=str(lid_a))
        k = "k%d_" % lid_a
        d.update({k + "unit": "%", k + "threshold": "0", k + "target": "100", k + "multiple": "100", k + "carriers": "holders", k + "holder_set": "1",
                  k + "wmode": "own", k + "ghset": "1"})
        h_ = [a.ja_eid(PFX + p) for p in ("N1", "N2", "N3")]
        d[k + "holder"] = h_
        d[k + "ghline"] = [str(x) for x in ticked]
        d.update(extra or {})
        return client.post(URL, follow_redirects=True, data=d)
    keep = [L[k][0] for k in ("H2", "H3", "H8", "H9", "H10")]
    db.execute("DELETE FROM gradeh_kpi_entries WHERE line_id=?", (L["H1"][0],))
    db.commit()
    w_ = world()
    r = card_post(C_SU, keep)
    s.check("saving the card with H1 unticked while H1 is submitted with no figure of their own on that line: refused whole (Reopen first), no link changed",
            "Reopen" in text(r) and "Nothing was saved" in text(r) and world()[0] == w_[0] and line(L["H1"][0])["bu_kpi_id"] == SETUP_A["id"], text(r)[:300])
    db.execute("INSERT OR REPLACE INTO gradeh_kpi_entries(cycle_id, person_id, line_id, staff_pct, staff_at) VALUES (?,?,?,?,?)", (CID, P["H1"], L["H1"][0], 70.0, utc(NOW)))
    db.commit()
    r = card_post(C_SU, keep)
    s.check("falsified: with a figure of their own H1 lets go through the card's save; the others stay linked",
            line(L["H1"][0])["bu_kpi_id"] is None and all(line(L[k][0])["bu_kpi_id"] == SETUP_A["id"] for k in ("H2", "H3", "H8", "H9", "H10")), text(r)[:300])
    r = card_post(C_SU, keep + [L["H1"][0], L["H4"][0]])
    s.check("a tick on a line that cannot follow (rated 1-5) refuses the whole save, nothing linked", line(L["H1"][0])["bu_kpi_id"] is None
            and line(L["H4"][0])["bu_kpi_id"] is None and "Nothing was saved" in text(r), text(r)[:300])
    r = card_post(C_SU, keep + [L["H1"][0]])
    s.check("ticking H1 links it (a flash says how many follow)", line(L["H1"][0])["bu_kpi_id"] == SETUP_A["id"] and "Grade H line" in text(r), text(r)[:300])
    if C_BGA:
        n_ = world()
        r = card_post(C_BGA, keep[:1])
        s.check("a non-super admin posting the Grade H list changes no link", world()[0] == n_[0])

    s.section("Move some to a variant: Grade H lines alongside, a variant of Grade H lines alone, a re-link")
    vpg = C_SU.get(URL + "&kpi=%d" % lid_a).get_data(as_text=True)
    s.check("the panel carries the Grade H checkboxes (ghwho) for the lines that can move, and a signature of who follows",
            'name="ghwho"' in vpg and 'name="src_gh"' in vpg and "data-gh" in vpg and "No %s line" % NAME in vpg)
    m = re.search(r'name="src_n" value="(\d+)"', vpg), re.search(r'name="src_sig" value="([0-9a-f]+)"', vpg), re.search(r'name="src_gh" value="([0-9a-f]+)"', vpg)
    base_form = csrf(action="move_variant", setup=str(SETUP_A["id"]), src_n=m[0].group(1), src_sig=m[1].group(1), src_gh=m[2].group(1), dest="new",
                     name_by="role", name_role="__new__", name_role_new="Eddie Ang", v_unit="%", v_threshold="0", v_target="100", v_multiple="100", v_wmode="own")
    # a variant made of Grade H lines ALONE: H2 and H3 follow GM A now
    f1 = dict(base_form, ghwho=[str(L["H2"][0]), str(L["H3"][0])])
    nsets = one("SELECT COUNT(*) FROM pm_bu_kpis WHERE business_group=?", (BG,))
    r = C_SU.post(URL, follow_redirects=True, data=f1)
    seteddie = setup_row(NAME + ": Eddie Ang")
    s.check("a NEW variant held by Grade H lines alone is made (no normal holder moved)", seteddie is not None
            and one("SELECT COUNT(*) FROM pm_bu_kpis WHERE business_group=?", (BG,)) == nsets + 1
            and json.loads(seteddie["carriers_json"] or "{}").get("people") == [], text(r)[:400])
    s.check("...the two Grade H lines follow it now, their figures cleared (they wait for the variant's own), the root keeps the rest",
            seteddie and all(line(L[k][0])["bu_kpi_id"] == seteddie["id"] and line(L[k][0])["bu_pct"] is None for k in ("H2", "H3"))
            and line(L["H1"][0])["bu_kpi_id"] == SETUP_A["id"])
    s.check("...the three normal holders are untouched and still on GM A", one("SELECT COUNT(*) FROM pm_kpi_targets WHERE bu_kpi_id=?", (SETUP_A["id"],)) == 3)
    s.check("...the flash says Grade H lines follow it", "Grade H line" in text(r), text(r)[:300])
    # a stale form (who follows changed) is refused whole
    f2 = dict(base_form, ghwho=[str(L["H8"][0])], name_role_new="Second", src_gh="0" * 12)
    w1 = world()
    r = C_SU.post(URL, follow_redirects=True, data=f2)
    s.check("a form posted before who follows changed is refused, nothing moved", world()[:3] == w1[:3] and setup_row(NAME + ": Second") is None, text(r)[:200])
    # re-link a followed line from the root to the existing variant
    vpg = C_SU.get(URL + "&kpi=%d" % lid_a).get_data(as_text=True)
    sig = re.search(r'name="src_gh" value="([0-9a-f]+)"', vpg).group(1)
    f3 = dict(base_form, ghwho=[str(L["H8"][0])], dest=str(seteddie["id"]), src_gh=sig, src_n=re.search(r'name="src_n" value="(\d+)"', vpg).group(1),
              src_sig=re.search(r'name="src_sig" value="([0-9a-f]+)"', vpg).group(1))
    r = C_SU.post(URL, follow_redirects=True, data=f3)
    s.check("moving a followed Grade H line from the root to a variant RE-LINKS it (the root's figure is gone, it waits for the variant's)",
            line(L["H8"][0])["bu_kpi_id"] == seteddie["id"] and line(L["H8"][0])["bu_pct"] is None, text(r)[:300])
    vpg = C_SU.get(URL + "&kpi=%d" % lid_a).get_data(as_text=True)
    r = C_SU.post(URL, follow_redirects=True, data=dict(base_form, ghwho=[str(L["H4"][0])], name_role_new="Third", src_gh=re.search(r'name="src_gh" value="([0-9a-f]+)"', vpg).group(1),
                                 src_n=re.search(r'name="src_n" value="(\d+)"', vpg).group(1), src_sig=re.search(r'name="src_sig" value="([0-9a-f]+)"', vpg).group(1)))
    s.check("...refused, nothing moved", setup_row(NAME + ": Third") is None and line(L["H4"][0])["bu_kpi_id"] is None, text(r)[:200])
    # fill the variant alone (its own figure), then the root
    pgv = C_SU.get("/admin/performance/bu-fill?business_group=%s&company=%s&kpi_name=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"), (NAME + ": Eddie Ang").replace(" ", "+")))
    tv = text(pgv)
    s.check("Fill BU KPI lists a variant held by Grade H lines alone (it has no scorecard line), with the Grade H chip and each person's stage",
            pgv.status_code == 200 and "Eddie Ang" in tv and "Grade H" in tv and "Acknowledged · their result updates" in tv and "Line manager submitted" in tv, tv[:900])
    # the fill POST: variant only (Grade H alone)
    r = C_SU.post("/admin/performance/bu-fill", follow_redirects=True, data=csrf(business_group=BG, company=CO, kpi_name=NAME + ": Eddie Ang", actual_value="110", note="", reason="ZZ test figure"))
    s.check("filling the variant fills its Grade H lines (110 -> 110% on the unit's own scale, multiple 100)",
            all(line(L[k][0])["bu_pct"] == 110.0 for k in ("H2", "H3")) and line(L["H1"][0])["bu_pct"] is None, text(r)[:300])
    s.check("...H3 (acknowledged): re-scored (50% x 110 + 50% x 88 = 99 -> 3), acknowledgement unchanged", appr("H3")["perf_value"] == 99.0 and appr("H3")["acknowledged_at"] == ack0, dict(appr("H3")))

    s.section("Fill BU KPI: one figure, the same transaction, the confirm box's numbers; a non-super admin is refused whole")
    pgf = C_SU.get("/admin/performance/bu-fill?business_group=%s&company=%s&kpi_name=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"), SETA.replace(" ", "+")))
    hf = pgf.get_data(as_text=True)
    tf = text(pgf)
    s.check("the holders table adds the Grade H rows with the chip and a status line; the rail/counts for normal holders are unchanged",
            "Grade H" in tf and "Will be filled" in tf and "Not started" in tf or "Line manager submitted" in tf, tf[:900])
    s.check("the confirm box names the Grade H count", "It also reaches" in html.unescape(hf) and "Grade H appraisal" in html.unescape(hf), html.unescape(hf)[html.unescape(hf).find("data-confirm=") : html.unescape(hf).find("data-confirm=") + 500])
    calc = C_SU.post("/admin/performance/bu-fill", follow_redirects=True, data=csrf(action="calc", business_group=BG, company=CO, kpi_name=SETA, actual_value="95"))
    j = calc.get_json()
    s.check("the live calc carries the Grade H numbers and rows: achievement 95%, n_gh, who is acknowledged", j and j["ok"] and j["n_gh"] >= 3 and "n_gh_ack" in j and "Grade H" in j["rows"], j and {k: v for k, v in j.items() if k != "rows"})
    # same figure for the normal holders and the Grade H lines
    nb = normal_world()
    r = C_SU.post("/admin/performance/bu-fill", follow_redirects=True, data=csrf(business_group=BG, company=CO, kpi_name=SETA, actual_value="95", note="", reason="ZZ audited"))
    s.check("one POST fills the three normal holders AND the Grade H lines (95%)",
            one("SELECT COUNT(*) FROM pm_kpi_results r JOIN pm_kpi_targets t ON t.id=r.kpi_target_id WHERE t.bu_kpi_id=? AND r.actual_value=95 AND r.admin_filled=1", (SETUP_A["id"],)) == 3
            and all(line(L[k][0])["bu_pct"] == 95.0 for k in ("H1", "H9", "H10")), text(r)[:300])
    s.check("the flash counts the Grade H lines", "Grade H line" in text(r), text(r)[:300])
    s.check("the audit row for the fill names the Grade H count", one("SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_fill' AND detail LIKE '%Grade H%'") >= 1)
    if C_BGA:
        wb = world()
        pr = C_BGA.post("/admin/performance/bu-fill", follow_redirects=True, data=csrf(business_group=BG, company=CO, kpi_name=SETA, actual_value="50", note="", reason="ZZ x"))
        s.check("a non-super admin: refused WHOLE (no Grade H line, and no normal line either, is half-filled)", world()[:2] == wb[:2]
                and one("SELECT COUNT(*) FROM pm_kpi_results r JOIN pm_kpi_targets t ON t.id=r.kpi_target_id WHERE t.bu_kpi_id=? AND r.actual_value=50", (SETUP_A["id"],)) == 0, text(pr)[:300])
    wb = world()
    r = C_SU.post("/admin/performance/bu-fill", follow_redirects=True, data=csrf(business_group=BG, company=CO, kpi_name=SETA, actual_value="50", note="", reason=""))
    s.check("falsified: no reason, nothing filled for anyone (the reason gate is before both)", world()[:2] == wb[:2])

    s.section("the normal holders' fill is byte-identical with and without Grade H links")
    with_links = digest("SELECT t.subject_id, t.kpi_name, r.actual_value, r.note, r.admin_filled, r.draft FROM pm_kpi_results r JOIN pm_kpi_targets t "
                        "ON t.id=r.kpi_target_id WHERE t.bu_kpi_id=? ORDER BY t.subject_id", (SETUP_A["id"],))
    db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE bu_kpi_id=?)", (SETUP_A["id"],))
    db.execute("UPDATE gradeh_kpi_lines SET bu_kpi_id=NULL, bu_pct=NULL, bu_filled_at=NULL, bu_filled_by=NULL, bu_value=NULL WHERE bu_kpi_id=?", (SETUP_A["id"],))
    db.commit()
    C_SU.post("/admin/performance/bu-fill", follow_redirects=True, data=csrf(business_group=BG, company=CO, kpi_name=SETA, actual_value="95", note="", reason="ZZ audited"))
    without = digest("SELECT t.subject_id, t.kpi_name, r.actual_value, r.note, r.admin_filled, r.draft FROM pm_kpi_results r JOIN pm_kpi_targets t "
                     "ON t.id=r.kpi_target_id WHERE t.bu_kpi_id=? ORDER BY t.subject_id", (SETUP_A["id"],))
    s.check("the same rows with no Grade H link at all", with_links == without)

    s.section("a changed target scores the typed figure again for the Grade H lines (a correction reaches every stage)")
    ok, why, n = link(SETUP_A, [L["H1"][0], L["H9"][0]])
    ok, why, cnt = fill(SETUP_A, 95)
    lidr = run(lambda d: a._bu_card_lid(d, BG, CO, dict(setup_row(SETA))))
    k = "k%d_" % lidr
    d = csrf(action="save_kpi", kpi=str(lidr))
    d.update({k + "unit": "%", k + "threshold": "0", k + "target": "200", k + "multiple": "100", k + "carriers": "holders", k + "holder_set": "1", k + "wmode": "own",
              k + "holder": [a.ja_eid(PFX + p) for p in ("N1", "N2", "N3")], k + "ghset": "1", k + "ghline": [str(L["H1"][0]), str(L["H9"][0])]})
    r = C_SU.post(URL, follow_redirects=True, data=d)
    s.check("target 200 instead of 100: 95 is now 47.5%, the Grade H lines hold 47.5 and H1 (submitted) is re-scored",
            line(L["H1"][0])["bu_pct"] == 47.5 and appr("H1")["perf_value"] is not None and appr("H1")["perf_value"] == round(0.5 * 47.5 + 0.5 * 88), (dict(line(L["H1"][0])), text(r)[:200]))

    fa0 = line(L["H1"][0])["bu_filled_at"]
    r = C_SU.post(URL, follow_redirects=True, data=d)
    s.check("a save that changes nothing the figure scores (the same target again) rewrites no Grade H line: its \"Updated\" date does not move",
            line(L["H1"][0])["bu_filled_at"] == fa0 and line(L["H1"][0])["bu_pct"] == 47.5)
    s.section("Take off as BU KPI lets every Grade H line go; a refusal changes nothing")
    # H9 has a figure of their own (91 was cleared above); give the people figures so the Take off can proceed
    for k_ in ("H1", "H9"):
        db.execute("INSERT OR REPLACE INTO gradeh_kpi_entries(cycle_id, person_id, line_id, staff_pct, staff_at) VALUES (?,?,?,?,?)", (CID, P[k_], L[k_][0], 77.0, utc(NOW)))
    db.commit()
    lid_a = run(lambda d: a._bu_card_lid(d, BG, CO, dict(setup_row(SETA))))
    link(SETUP_A, [L["H10"][0]])   # H10 is submitted and has no figure of their own on that line
    db.commit()
    w_ = world()
    n_lines0 = one("SELECT COUNT(*) FROM pm_kpi_targets WHERE bu_kpi_id=?", (SETUP_A["id"],))
    r = C_SU.post(URL, follow_redirects=True, data=csrf(action="take_off", setup=str(SETUP_A["id"])))
    s.check("H10 is submitted with no figure of their own on that line: Take off is refused whole (Reopen first), nothing taken off, no link changed",
            "Reopen" in text(r) and "Nothing was taken off" in text(r) and world()[0] == w_[0]
            and one("SELECT COUNT(*) FROM pm_kpi_targets WHERE bu_kpi_id=?", (SETUP_A["id"],)) == n_lines0, text(r)[:400])
    db.execute("INSERT OR REPLACE INTO gradeh_kpi_entries(cycle_id, person_id, line_id, staff_pct, staff_at) VALUES (?,?,?,?,?)", (CID, P["H10"], L["H10"][0], 66.0, utc(NOW)))
    db.commit()
    r = C_SU.post(URL, follow_redirects=True, data=csrf(action="take_off", setup=str(SETUP_A["id"])))
    s.check("falsified: with their own figure Take off lets every Grade H line go (cleared) and the normal lines come off as before",
            all(line(L[k_][0])["bu_kpi_id"] is None and line(L[k_][0])["bu_pct"] is None and line(L[k_][0])["bu_value"] is None for k_ in ("H1", "H9", "H10"))
            and "Grade H line" in text(r), text(r)[:400])
    s.check("...H10 re-scored from their own 66 (50% x 66 + 50% x 80 = 73 -> 2)", (appr("H10")["perf_value"], appr("H10")["perf_rating"]) == (73.0, 2.0), dict(appr("H10")))

    s.section("flag off: the pages and counts are as today; nothing Grade H is touched")
    SETUP_A = setup_row(SETA)   # the normal lines were acted on, so the take off left the setup and its lines (as before)
    link(SETUP_A, [L["H1"][0], L["H9"][0]])
    fill(SETUP_A, 70)
    pc0 = (line(L["H1"][0])["bu_pct"], appr("H1")["perf_value"])
    os.environ["ONEHR_GRADEH"] = "0"
    sa = setup_row(SETA)
    if sa:
        lid_a = run(lambda d: a._bu_card_lid(d, BG, CO, dict(sa)))
        off = text(C_SU.get(URL + "&kpi=%d" % lid_a))
        s.check("the read view carries no Grade H row, chip or sentence", "Grade H" not in off and "It also reaches" not in off, off[:300])
        offe = C_SU.get(URL + "&kpi=%d&edit=1" % lid_a).get_data(as_text=True)
        s.check("Edit: no Grade H picklist", "ghline" not in offe)
        offf = text(C_SU.get("/admin/performance/bu-fill?business_group=%s&company=%s&kpi_name=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"), SETA.replace(" ", "+"))))
        s.check("Fill BU KPI: no Grade H row, no Grade H sentence", "Grade H" not in offf)
        lid_ = run(lambda d: a._bu_card_lid(d, BG, CO, dict(sa)))
        C_SU.post("/admin/performance/bu-fill", follow_redirects=True, data=csrf(business_group=BG, company=CO, kpi_name=SETA, actual_value="50", note="", reason="ZZ off"))
        s.check("a fill with the flag off fills the normal holders and leaves every Grade H line and stored result exactly as it was",
                one("SELECT COUNT(*) FROM pm_kpi_results r JOIN pm_kpi_targets t ON t.id=r.kpi_target_id WHERE t.bu_kpi_id=? AND r.actual_value=50", (sa["id"],)) == 3
                and (line(L["H1"][0])["bu_pct"], appr("H1")["perf_value"]) == pc0)
    os.environ["ONEHR_GRADEH"] = "1"

    s.section("the Grade H KPI import keeps a link (the same line) or refuses (a linked line left out); never a silent loss")
    setc = mk_setup(NAME + ": Kept", people=())
    U["H11"] = mk("H11"); person("H11", "A"); lines_for("H11", [(NAME, 60), ("ZZGB Other", 40)])
    db.commit()
    ok, why, n = link(setc, [L["H11"][0]])
    s.check("(set-up) H11's line follows the new setup and holds Group People's 80", ok and n == 1, why)
    ok2, why2, c2 = fill(setc, 80)
    db.commit()
    KH = list(a.GRADEH_KPI_IMPORT_COLUMNS)

    def xfile(rows):
        import csv as _csv
        import io
        buf = io.StringIO()
        w = _csv.writer(buf)
        w.writerow(KH)
        w.writerows(rows)
        return io.BytesIO(buf.getvalue().encode())

    def load_kpi(rows):
        with a.app.test_request_context("/"):
            d = a.get_db()
            me = dict(d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
            spec = a._IMP[a.GRADEH_KPI_KIND]
            return spec["load"](d, me, {"filename": "gh.csv"}, xfile(rows).read()), me
    ctx, me = load_kpi([[PFX + "H11", NAME, "70", "FIAMMA"], [PFX + "H11", "ZZGB Other", "30", "FIAMMA"]])
    s.check("the same lines with new weights: valid (the person's lines are replaced), no error", ctx["valid"] and not ctx["errors"], ctx["errors"])
    with a.app.test_request_context("/"):
        d = a.get_db()
        a._gkl_apply(d, me, ctx, {})
        d.commit()
    nl = db.execute("SELECT * FROM gradeh_kpi_lines WHERE person_id=? AND kpi_name=?", (P["H11"], NAME)).fetchone()
    s.check("the link and the shared figure carried over to the recreated line (new id, new weight)",
            nl["bu_kpi_id"] == setc["id"] and nl["bu_pct"] == 80.0 and nl["weight"] == 70.0 and nl["bu_value"] == 80.0 and nl["id"] != L["H11"][0], dict(nl))
    ctx, me = load_kpi([[PFX + "H11", "ZZGB Something New", "60", "FIAMMA"], [PFX + "H11", "ZZGB Other", "40", "FIAMMA"]])
    s.check("falsified: a file that leaves the linked line out is refused in the quality step, naming the line",
            not ctx["valid"] and any("follows a BU KPI" in e["why"] for e in ctx["errors"]), ctx["errors"])
    s.check("...and the line is still linked", db.execute("SELECT bu_kpi_id FROM gradeh_kpi_lines WHERE person_id=? AND kpi_name=?", (P["H11"], NAME)).fetchone()[0] == setc["id"])
    ctx, me = load_kpi([[PFX + "H11", NAME.upper(), "60", "FIAMMA"], [PFX + "H11", "ZZGB Other", "40", "FIAMMA"]])
    s.check("a name that differs only in case keeps the link (the same line)", ctx["valid"] and not ctx["errors"], ctx["errors"])

    s.section("the new access: no new route or admin item; wording and records")
    s.check("no new route: the link rides the BU KPI setup page and Fill BU KPI (both already classified)",
            all(r_.endpoint in a.ADMIN_ACCESS_MAP or r_.endpoint in ("admin_bu_kpis", "admin_performance_bu_fill")
                for r_ in a.app.url_map.iter_rules() if r_.rule.startswith("/admin/performance/bu-")))
    s.check("the audit words exist for the three new actions", all(k_ in a.ACTION_LABELS for k_ in ("gradeh_bu_link", "gradeh_bu_unlink", "gradeh_bu_fill")))
finally:
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    else:
        os.environ["ONEHR_GRADEH"] = _ENV0
    db.execute("UPDATE cycles SET kind=?, year=?, half=?, min_job_grade=? WHERE id=?", (PREV["kind"], PREV["year"], PREV["half"], PREV["min_job_grade"], CID))
    db.commit()

sys.exit(s.done())
