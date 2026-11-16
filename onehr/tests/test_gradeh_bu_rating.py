"""A Grade H line rated 1-5 follows its unit's BU KPI rating (2026-11-06; Chris: "change it so LM doesn't have to rate, it follows the rating
from the BU KPI result"; brief OneHR/Grade H BU KPI rating build brief 2026-11-06.md). The mirror of test_gradeh_bu_link (a % line follows a %).

A Grade H line on the OTHER scale (the line manager rates each KPI 1-5) may follow a BU KPI of a group that rates 1-5 (Mechanism A). It takes
the rating Group People's filled figure scores on that setup (pm_score_kpi_line on the setup's own rate1-rate5), the SAME rating the normal
holders of the setup get; the line manager rates nothing on it and the staff member enters nothing.

What this suite holds:
  * the schema: gradeh_kpi_lines.bu_rating, additive
  * the name match: "PAT" follows "Profit after tax (PAT): GM A" (the short form in brackets), a line "PATX" or "Profit" does not; the root and the
    full name match as before; one matcher for the candidates and the link
  * gradeh_bu_candidates / gradeh_bu_link: an OTHER line is ok on a Mechanism-A setup and refused on a B one; a % line is refused on an A setup
    (each with the plain words) and ok on a B one; a setup missing one of rate1-rate5 is refused; every refusal writes nothing (falsified)
  * before the fill: shared_wait, no perf rating or band, no problem; the line manager submits without rating that line; a rating posted for it
    stores nothing (falsified against a normal line); the staff page has no box for it
  * the fill: bu_rating == pm_score_kpi_line(...) == the normal holder's rating for the same figure; bu_pct stays empty; the perf rating is the
    weighted average with the shared rating in place (worked out here from the parts); a correction re-scores a submitted AND an acknowledged
    person and leaves the acknowledgement and a HOD band move; a figure that scored the wrong kind is refused (nothing written)
  * a changed rating ladder re-rates (gradeh_bu_refresh, and through the card's save)
  * unlink: refused when submitted and the line has no rating of the line manager's, allowed otherwise and the line falls back to lm_rating
  * the pages (line manager's, staff, admin person page, BU KPI setup, Fill BU KPI) show "Rating N" / the waiting words
  * a Grade H KPI import keeps the link and the rating (the same line) and refuses a link moved between a % scale and a rating
Synthetic (ZZ9GR-*) on a fresh scratch database; the suite puts back what it changes.
"""
import hashlib
import html
import json
import os
import re
import sys
from datetime import datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Grade H lines rated 1-5 that follow a BU KPI rating")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, EMP = H.actors(a)
PFX, BG, CO = "ZZ9GR-", "ZZGR Group", "ZZGR Unit"          # a group that rates 1-5 (Mechanism A)
BGB, COB = "ZZGR Bgroup", "ZZGR BUnit"                      # a group that scores in % (Mechanism B)
NAME = "ZZGR Profit after tax (PAT)"
SETA, SETB = NAME + ": GM A", NAME + ": GM B"
RATES = (10, 20, 30, 40, 50)                                # the setup's own ladder: 'more' is better
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


def mk(k, grade="H", bg=BG, co=CO, mgr=None):
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
        "job_grade, job_title, manager_id, confirmation_date, email) VALUES (?,?, 'x', 'user', ?,?,?, 'ZZGR Dept', ?, 'Driver', ?, "
        "'2020-01-01', ?)", ((PFX + k).lower(), "ZZ GR " + k, PFX + k, bg, co, grade, mgr, "zzgr.%s@example.test" % k.lower())).lastrowid


def person(k, appraiser=None):
    P[k] = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route, appraiser_id, language, private_company) "
                      "VALUES (?,?,?, 'A', ?, 'en', 0)", (CID, PFX + k, U[k], appraiser)).lastrowid
    return P[k]


def lines_for(k, spec, scale="OTHER"):
    L[k] = []
    for i, (name, w) in enumerate(spec, 1):
        L[k].append(db.execute("INSERT INTO gradeh_kpi_lines (cycle_id, person_id, kpi_name, weight, group_scale, sort_order) VALUES (?,?,?,?,?,?)",
                               (CID, P[k], name, w, scale, i)).lastrowid)
    db.commit()
    return L[k]


def sent(k):
    """The person has sent their part (no figure on a line rated 1-5 is needed): the line manager may start."""
    db.execute("INSERT OR IGNORE INTO gradeh_appraisals (cycle_id, person_id) VALUES (?,?)", (CID, P[k]))
    db.execute("UPDATE gradeh_appraisals SET staff_submitted_at=? WHERE cycle_id=? AND person_id=?", (utc(NOW), CID, P[k]))
    db.commit()


def appr(k):
    return db.execute("SELECT * FROM gradeh_appraisals WHERE person_id=?", (P[k],)).fetchone()


def line(lid):
    return db.execute("SELECT * FROM gradeh_kpi_lines WHERE id=?", (lid,)).fetchone()


def entry(lid):
    return db.execute("SELECT * FROM gradeh_kpi_entries WHERE line_id=?", (lid,)).fetchone()


def setup_row(name, bg=BG, co=CO):
    return db.execute("SELECT * FROM pm_bu_kpis WHERE cycle_id=? AND business_group=? AND company=? AND kpi_name=?", (CID, bg, co, name)).fetchone()


def mk_lib(name, bg=BG):
    r = db.execute("SELECT id FROM pm_kpi_library WHERE business_group=? AND kpi_name=?", (bg, name)).fetchone()
    if r:
        return r[0]
    return db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, unit, method, "
                      "weightage_default, bu_level) VALUES (?, '*', '*', 0, '*', ?, 'Financial · Profitability', '%', 'more', 30, 1)", (bg, name)).lastrowid


def mk_setup(name, bg=BG, co=CO, rates=RATES, scale=(None, None, None), people=()):
    sid = db.execute("INSERT INTO pm_bu_kpis(cycle_id, business_group, company, library_id, kpi_name, unit, method, rate1, rate2, rate3, rate4, rate5, "
                     "threshold, target, multiple, carriers, carriers_json, weight_mode, updated_by) VALUES (?,?,?,?,?, '%', 'more', ?,?,?,?,?, ?,?,?, "
                     "'holders', ?, 'own', ?)",
                     (CID, bg, co, mk_lib(name, bg), name) + tuple(rates) + tuple(scale) + (json.dumps({"people": [a.ja_eid(PFX + p) for p in people]}), SU["id"])).lastrowid
    db.commit()
    return db.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (sid,)).fetchone()


def audit(action):
    return one("SELECT COUNT(*) FROM activity_log WHERE action=?", (action,))


def SUROW(d):
    return d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()


def BGAROW(d):
    return d.execute("SELECT * FROM users WHERE id=?", (BGA["id"],)).fetchone() if BGA else None


def link(setup, ids, me=None, allow_from=None):
    return run(lambda d: a.gradeh_bu_link(d, me(d) if me else SUROW(d), dict(setup), ids, allow_from=allow_from))


def fill(setup, value, me=None):
    """Fill what the page fills: the result for the scale of the setup's linked lines (gradeh_bu_result_of), then gradeh_bu_fill."""
    def f(d):
        st = dict(d.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (setup["id"],)).fetchone())
        scale = d.execute("SELECT group_scale FROM gradeh_kpi_lines WHERE bu_kpi_id=? LIMIT 1", (setup["id"],)).fetchone()["group_scale"]
        kind, res = a.gradeh_bu_result_of(d, st, value, scale)
        return a.gradeh_bu_fill(d, me(d) if me else SUROW(d), st, res if kind == "pct" else None, value=value, rating=res if kind == "rating" else None)
    return run(f)


def unlink(ids, me=None):
    return run(lambda d: a.gradeh_bu_unlink(d, me(d) if me else SUROW(d), ids))


def world():
    return (digest("SELECT * FROM gradeh_kpi_lines ORDER BY id"), digest("SELECT * FROM gradeh_appraisals ORDER BY id"),
            digest("SELECT * FROM gradeh_kpi_entries ORDER BY id"), one("SELECT COUNT(*) FROM activity_log WHERE action LIKE 'gradeh_bu_%'"))


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
    """Everything a KPI-route submit needs except the shared line: the line manager's ratings on the person's own lines, 14 answers, comments."""
    c.post("%s/%d/kpis" % (BASE, P[k]), data=csrf(**posted))
    lp_all(c, P[k])
    comments(c, P[k])


def expected_avg(k, own):
    """The weighted average of the person's KPI ratings, worked out here from the stored parts: a line that follows a BU KPI is its bu_rating,
    any other the line manager's rating (`own`: {line id: rating}). Rounded half up to 2 places, as the server does."""
    tot = Decimal(0)
    for lid in L[k]:
        ln = line(lid)
        r = ln["bu_rating"] if ln["bu_kpi_id"] else own[lid]
        tot += Decimal(str(ln["weight"])) * Decimal(r)
    return (tot / 100).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def band_of(avg):
    return run(lambda d: a.gradeh_perf_band(avg, a.gradeh_setting("gradeh_perf_cuts", CID)))


# ---------------------------------------------------------------- fixture
CID = run(lambda d: a.active_cycle_id(d))
PREV = dict(db.execute("SELECT kind, year, half, min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())
db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL WHERE id=?", (CID,))
db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 1)", (CID,))
db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell LIKE 'gradeh_%'", (CID,))
db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', '2099-11-02 00:00', '2099-11-08 23:59')", (CID,))
db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?),(?,?)", (BG, CO, BGB, COB))
db.execute("INSERT OR REPLACE INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'A', 'base')", (BG,))
db.execute("INSERT OR REPLACE INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'B', 'base')", (BGB,))
U["LM"] = mk("LM", "15")
for k in ("N1", "N2"):
    U[k] = mk(k, "15", mgr=U["LM"])
for k in ("G1", "G2", "G3", "G4", "G5", "G6", "G8", "GP"):
    U[k] = mk(k, "H", mgr=U["LM"])
U["GB"] = mk("GB", "H", bg=BGB, co=COB, mgr=U["LM"])     # a Grade H person of the B group with a line rated 1-5
U["GBP"] = mk("GBP", "H", bg=BGB, co=COB, mgr=U["LM"])   # ... and one with a % line
for k in ("G1", "G6", "G8"):                             # "PAT" (the short form): G1 submitted, G6 sent but not submitted, G8 still to send
    person(k, U["LM"]); lines_for(k, [("PAT", 50), ("ZZGR Own KPI", 50)])
person("G2", U["LM"]); lines_for("G2", [(NAME, 50), ("ZZGR Own KPI", 50)])          # the root's own name: submitted
person("G3", U["LM"]); lines_for("G3", [("pat", 40), ("ZZGR Own KPI", 60)])         # a folded short form: acknowledged
person("G4", U["LM"]); lines_for("G4", [("PATX", 50), ("ZZGR Own KPI", 50)])        # not the short form
person("G5", U["LM"]); lines_for("G5", [("Profit", 100)])                            # not the short form either
person("GP", U["LM"]); lines_for("GP", [("PAT", 50), ("ZZGR Own KPI", 50)], scale="FIAMMA")   # a % line in a group that rates 1-5
person("GB", U["LM"]); lines_for("GB", [("PAT", 100)])
person("GBP", U["LM"]); lines_for("GBP", [("PAT", 100)], scale="FIAMMA")
for k in ("G1", "G2", "G3", "G6"):
    sent(k)
SETUP_A = mk_setup(SETA, people=("N1", "N2"))
SETUP_B = mk_setup(SETB, bg=BGB, co=COB, rates=(None,) * 5, scale=(0, 100, 100))
for k in ("N1", "N2"):   # the normal holders of the setup carry its ladder on their own lines (Mechanism A)
    db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, rate2, rate3, rate4, rate5, "
               "business_group, company, bu_kpi_id) VALUES (?,?,?,30,'more','%','Own',?,?,?,?,?,?,?,?)",
               (CID, U[k], SETA, *RATES, BG, CO, SETUP_A["id"]))
db.commit()
C_LM = H.client_as(a, U["LM"])
C_SU = H.client_as(a, SU["id"])
C_BGA = H.client_as(a, BGA["id"]) if BGA else None
SETUP_A = setup_row(SETA)
SETUP_B = setup_row(SETB, BGB, COB)
CFG_A = db.execute("SELECT * FROM pm_bg_config WHERE business_group=?", (BG,)).fetchone()


def cands(setup):
    return {c["eid"].replace(PFX, ""): c for c in run(lambda d: a.gradeh_bu_candidates(d, dict(setup)))}


try:
    s.section("the schema")
    cols = {r[1] for r in db.execute("PRAGMA table_info(gradeh_kpi_lines)")}
    s.check("gradeh_kpi_lines has bu_rating beside bu_pct (additive)", {"bu_rating", "bu_pct", "bu_value", "bu_kpi_id"} <= cols, cols)
    s.check("new lines start unlinked, with no rating", all(r["bu_kpi_id"] is None and r["bu_rating"] is None for r in db.execute("SELECT * FROM gradeh_kpi_lines")))

    s.section("the name match: one matcher for the candidates and the link")
    m = a.gradeh_bu_match_keys
    s.check("a root without brackets matches itself only: 'Company performance: GM A' -> {'company performance'}",
            m("Company performance: GM A") == {"company performance"}, m("Company performance: GM A"))
    s.check("a root ending in a short form in brackets also matches the short form: 'Profit after tax (PAT): CHBM Group' -> PAT",
            m("Profit after tax (PAT): CHBM Group") == {"profit after tax (pat)", "pat"}, m("Profit after tax (PAT): CHBM Group"))
    s.check("'PAT' (any case, spacing) follows it", all(a.gradeh_bu_line_matches("Profit after tax (PAT): CHBM Group", n) for n in ("PAT", "pat", " P A T".replace(" ", "") + " ")))
    s.check("...so do the root and the setup's own name, as before", a.gradeh_bu_line_matches("Profit after tax (PAT): CHBM Group", "Profit after tax (PAT)")
            and a.gradeh_bu_line_matches("Profit after tax (PAT): CHBM Group", "Profit  after TAX (PAT): CHBM Group"))
    s.check("falsified: 'PATX', 'Profit', 'PAT x' and 'Tax' do not", not any(a.gradeh_bu_line_matches("Profit after tax (PAT): CHBM Group", n)
                                                                         for n in ("PATX", "Profit", "PAT x", "Tax", "")))
    s.check("falsified: a bracket in the middle of the root is not a short form", m("Profit (PAT) after tax: GM") == {"profit (pat) after tax"})
    s.check("an empty bracket adds nothing", m("Profit after tax (): GM") == {"profit after tax ()"}, m("Profit after tax (): GM"))

    s.section("gradeh_bu_candidates: an OTHER line is ok on a Mechanism-A setup; a % line is not")
    c = cands(SETUP_A)
    s.check("the people with a line that matches: G1 (PAT) G2 (the root's name) G3 (pat) G6 G8, and GP (a % line, greyed); not PATX / Profit",
            {k for k, v in c.items() if v["line"]} == {"G1", "G2", "G3", "G6", "G8", "GP"}, {k: bool(v["line"]) for k, v in c.items()})
    s.check("a line rated 1-5 is ok on the A setup, unlinked, found by the short form",
            all(c[k]["ok"] and c[k]["linked"] is None for k in ("G1", "G2", "G3", "G6", "G8")) and c["G1"]["line"]["id"] == L["G1"][0])
    s.check("G4 'PATX' and G5 'Profit' have no line of that name: \"No <root> line\"", c["G4"]["line"] is None and c["G5"]["line"] is None
            and c["G4"]["why"] == "No %s line" % NAME, c["G4"]["why"])
    s.check("a % line in a group that rates 1-5 is greyed with the plain words",
            not c["GP"]["ok"] and c["GP"]["why"] == "%s rates %s 1 to 5, and this line is scored as a %%." % (run(lambda d: a.display_bg(BG)), SETA), c["GP"]["why"])
    cb = cands(SETUP_B)
    s.check("on a group that scores in %: the line rated 1-5 is greyed (\"scores ... as a %, and this line is rated 1 to 5\"), the % line is ok",
            not cb["GB"]["ok"] and cb["GB"]["why"] == "%s scores %s as a %%, and this line is rated 1 to 5." % (run(lambda d: a.display_bg(BGB)), SETB)
            and cb["GBP"]["ok"], (cb["GB"]["why"], cb["GBP"]["ok"]))

    s.section("gradeh_bu_result_of: the one answer; the same rating the normal holders get")
    figs = (-5, 5, 10, 19.9, 20, 29, 30, 35, 45, 50, 99)
    same = []
    for v in figs:
        kind, res = run(lambda d: a.gradeh_bu_result_of(d, dict(SETUP_A), v, "OTHER"))
        want = a.pm_score_kpi_line(CFG_A, dict(SETUP_A), v)["value"]
        norm = a.pm_score_kpi_line(CFG_A, dict(db.execute("SELECT * FROM pm_kpi_targets WHERE subject_id=?", (U["N1"],)).fetchone()), v)["value"]
        same.append((kind == "rating", res == want == norm, isinstance(res, int) and 1 <= res <= 5))
    s.check("for 11 figures: kind 'rating', == pm_score_kpi_line on the setup == the same on a normal holder's line, an integer 1-5",
            all(all(t) for t in same), same)
    s.check("the ladder floors: below rate1 is 1, rate5 and above is 5", run(lambda d: a.gradeh_bu_result_of(d, dict(SETUP_A), -5, "OTHER")) == ("rating", 1)
            and run(lambda d: a.gradeh_bu_result_of(d, dict(SETUP_A), 99, "OTHER")) == ("rating", 5))
    for label, fn in (("a % scale on the A setup", lambda d: a.gradeh_bu_result_of(d, dict(SETUP_A), 35, "FIAMMA")),
                      ("OTHER on the B setup", lambda d: a.gradeh_bu_result_of(d, dict(SETUP_B), 35, "OTHER")),
                      ("a figure that is not a number", lambda d: a.gradeh_bu_result_of(d, dict(SETUP_A), "x", "OTHER")),
                      ("a figure that is not finite", lambda d: a.gradeh_bu_result_of(d, dict(SETUP_A), float("nan"), "OTHER"))):
        try:
            run(fn)
            ref = None
        except a.GradehRefusal as e:
            ref = str(e)
        s.check("%s: refused with words" % label, bool(ref), ref)
    s.check("falsified: the B setup gives a % line its % (a plain 35 -> 35%)", run(lambda d: a.gradeh_bu_result_of(d, dict(SETUP_B), 35, "FIAMMA")) == ("pct", 35.0))
    bare = mk_setup(NAME + ": Bare", rates=(10, 20, None, 40, 50))
    try:
        run(lambda d: a.gradeh_bu_result_of(d, dict(bare), 35, "OTHER"))
        ref = None
    except a.GradehRefusal as e:
        ref = str(e)
    s.check("a setup missing one of rate1-rate5: refused, named", ref and "no method and ratings 1 to 5" in ref, ref)
    s.check("gradeh_bu_scale_why answers per scale: None for OTHER on A, words for a % scale on A",
            run(lambda d: a.gradeh_bu_scale_why(d, dict(SETUP_A), "OTHER")) is None and run(lambda d: a.gradeh_bu_scale_why(d, dict(SETUP_A), "FIAMMA"))
            and run(lambda d: a.gradeh_bu_scale_why(d, dict(SETUP_B), "FIAMMA")) is None and run(lambda d: a.gradeh_bu_scale_why(d, dict(bare), "OTHER")))
    db.execute("DELETE FROM pm_bu_kpis WHERE id=?", (bare["id"],))
    db.commit()

    s.section("gradeh_bu_link: refusals named, nothing written; then it links")
    w0 = world()
    ok, why, n = link(SETUP_B, [L["GB"][0]])
    s.check("OTHER -> a B setup: refused, nothing written", not ok and "as a %, and this line is rated 1 to 5" in why and world() == w0, why)
    ok, why, n = link(SETUP_A, [L["GP"][0]])
    s.check("a % line -> an A setup: refused, nothing written", not ok and "this line is scored as a %" in why and world() == w0, why)
    bare = mk_setup(NAME + ": Bare", rates=(10, 20, None, 40, 50))
    ok, why, n = link(bare, [L["G1"][0]])
    s.check("a setup missing a rating: refused, nothing written", not ok and "no method and ratings 1 to 5" in why and world() == w0, why)
    db.execute("DELETE FROM pm_bu_kpis WHERE id=?", (bare["id"],))
    db.commit()
    ok, why, n = link(SETUP_A, [L["G4"][0]])
    s.check("a line whose name is 'PATX' (not the short form): refused, not a line of this unit that can follow", not ok and "not a Grade H line of this unit" in why and world() == w0, why)
    ok, why, n = link(SETUP_A, [L["G1"][0]], me=BGAROW)
    s.check("not the super admin: refused", not ok and "super admin" in why and world() == w0, why)
    ok, why, n = link(SETUP_A, [L["G1"][0], L["GP"][0]])
    s.check("one bad line among good ones refuses ALL", not ok and line(L["G1"][0])["bu_kpi_id"] is None and world() == w0, why)
    ok, why, n = link(SETUP_B, [L["GBP"][0]])
    s.check("falsified: a % line links to a B setup", ok and n == 1 and line(L["GBP"][0])["bu_kpi_id"] == SETUP_B["id"] and line(L["GBP"][0])["bu_rating"] is None, why)
    a0 = audit("gradeh_bu_link")
    ok, why, n = link(SETUP_A, [L["G1"][0], L["G2"][0], L["G3"][0]])
    s.check("falsified: the OTHER lines link to the A setup in one call", ok and n == 3, (ok, why, n))
    s.check("...each follows it, waiting (bu_rating and bu_pct empty)", all(
        line(L[k][0])["bu_kpi_id"] == SETUP_A["id"] and line(L[k][0])["bu_rating"] is None and line(L[k][0])["bu_pct"] is None
        and line(L[k][0])["bu_filled_at"] is None for k in ("G1", "G2", "G3")))
    s.check("...one audit row per line, ids only (no name)", audit("gradeh_bu_link") - a0 == 3 and not one(
        "SELECT COUNT(*) FROM activity_log WHERE action='gradeh_bu_link' AND detail LIKE '%ZZ GR%'"))
    s.check("the person's own lines are untouched", all(line(L[k][1])["bu_kpi_id"] is None for k in ("G1", "G2", "G3")))

    s.section("before the fill: waiting, no band, the line manager submits without rating it")
    c1 = run(lambda d: a.gradeh_computed(d, CID, P["G1"]))
    s.check("G1: shared_wait names the KPI; no perf rating, no band, no value; not a problem (it blocks nothing)",
            c1["shared_wait"] == ["PAT"] and c1["perf_rating"] is None and c1["perf_band"] is None and c1["perf_value"] is None
            and not [p for p in c1["problems"] if "KPI" in p or "perf" in p.lower()], c1)
    # an own line without a rating still blocks the average the usual way, but the shared line does not ask for one
    g1_own = L["G1"][1]
    pg = C_LM.get("%s/%d?step=kpis" % (BASE, P["G1"]))
    h = pg.get_data(as_text=True)
    t = text(pg)
    s.check("the KPI step GETs 200: the shared line reads \"Filled by Group People\"; no rating picker for it; the person's own line has one",
            pg.status_code == 200 and "Filled by Group People" in t and 'name="r_%d"' % L["G1"][0] not in h and 'name="r_%d"' % g1_own in h, t[:400])
    s.check("...and the card says Waiting for 1 line", "Waiting for 1 line" in t, t[:600])
    pr = C_LM.post("%s/%d/kpis" % (BASE, P["G1"]), data=csrf(**{"r_%d" % L["G1"][0]: "4", "r_%d" % g1_own: "3"}))
    s.check("a rating posted for the shared line is REFUSED whole: nothing is kept for it (nor for the other line posted with it)",
            entry(L["G1"][0]) is None and entry(g1_own) is None and "Group People" in text(pr), text(pr)[:300])
    pr = C_LM.post("%s/%d/kpis" % (BASE, P["G1"]), data=csrf(**{"r_%d" % g1_own: "4"}))
    s.check("falsified: a rating for the person's own line is kept", entry(g1_own)["lm_rating"] == 4 and entry(g1_own)["lm_at"])
    s.check("...and lm_rating is never written for the shared line", entry(L["G1"][0]) is None or entry(L["G1"][0])["lm_rating"] is None)
    lp_all(C_LM, P["G1"])
    comments(C_LM, P["G1"])
    r = submit(C_LM, P["G1"])
    s.check("G1 submits without waiting: lm_submitted_at set, perf_* empty, potential stored",
            r.status_code == 303 and appr("G1")["lm_submitted_at"] and appr("G1")["perf_rating"] is None and appr("G1")["perf_band"] is None
            and appr("G1")["pot_band"], (r.status_code, text(r)[:200]))
    pg = text(C_LM.get("%s/%d" % (BASE, P["G1"])))
    s.check("the submitted record: waiting for Group People's figure, and the recap says Filled by Group People",
            ("Waiting for 1 line" in pg or "Waiting for Group People" in pg) and "Filled by Group People" in pg, pg[:500])
    # G2 and G3 the same way
    for k, own in (("G2", "2"), ("G3", "5")):
        ready(C_LM, k, {"r_%d" % L[k][1]: own})
        submit(C_LM, P[k])
    db.execute("UPDATE gradeh_appraisals SET acknowledged_at=? WHERE person_id=?", (utc(NOW), P["G3"]))
    db.commit()
    ack0 = appr("G3")["acknowledged_at"]
    s.check("G2 submitted and G3 submitted + acknowledged, both without a figure yet", appr("G2")["lm_submitted_at"] and appr("G3")["lm_submitted_at"]
            and appr("G3")["perf_band"] is None and ack0)
    db.execute("UPDATE gradeh_kpi_lines SET weight=weight-5 WHERE id=?", (L["G6"][1],))
    db.commit()
    ready(C_LM, "G6", {"r_%d" % L["G6"][1]: "3"})
    link(SETUP_A, [L["G6"][0]])
    r = submit(C_LM, P["G6"])
    s.check("falsified: weights that miss 100 still block the submit (a normal problem): G6 (a linked line, weights 95%) is refused", appr("G6")["lm_submitted_at"] is None, text(r)[:200])
    db.execute("UPDATE gradeh_kpi_lines SET weight=weight+5 WHERE id=?", (L["G6"][1],))
    db.commit()
    ids_before = world()[0]
    s.check("the candidates read each person's stage: G1 G2 submitted, G3 acknowledged, G6 before",
            (lambda c_: (c_["G1"]["stage"], c_["G2"]["stage"], c_["G3"]["stage"], c_["G6"]["stage"]))(cands(SETUP_A))
            == ("submitted", "submitted", "acknowledged", "before"))

    rows_ = run(lambda d: d.execute(a._GH_CAL_SQL + "AND p.id=?", (CID, P["G2"])).fetchall())
    det = run(lambda d: a.gradeh_buceo_person_detail(d, CID, rows_[0]))
    s.check("calibration and the leaders' reads: a submitted person with a linked line not yet filled is flagged shared_wait (the SQL count) and the shared line reads \"Waiting for Group People\"",
            rows_ and rows_[0]["shared_wait"] == 1 and any(k_["name"] == NAME and k_["figure"] == "Waiting for Group People" for k_ in det["kpis"]), (rows_ and rows_[0]["shared_wait"], det["kpis"]))

    s.section("the staff page: no box for the line, the pill, a typed figure refused")
    ok, why, n = link(SETUP_A, [L["G8"][0]])
    C8 = H.client_as(a, U["G8"])
    pg = C8.get("/my-appraisal").get_data(as_text=True)
    s.check("G8's KPI step: no input for the shared line, the pill \"Filled by Group People\"; the own line has its box",
            'name="k_%d"' % L["G8"][0] not in pg and 'name="k_%d"' % L["G8"][1] in pg and "Filled by Group People" in pg)
    r = C8.post("/my-appraisal/kpi/save", data=csrf(**{"k_%d" % L["G8"][0]: "70", "k_%d" % L["G8"][1]: "91"}))
    s.check("a figure typed for the shared line is REFUSED whole (nothing saved)", one("SELECT COUNT(*) FROM gradeh_kpi_entries WHERE person_id=? AND staff_pct IS NOT NULL", (P["G8"],)) == 0, text(r)[:200])
    r = C8.post("/my-appraisal/kpi/save", data=csrf(**{"k_%d" % L["G8"][1]: "91"}))
    s.check("falsified: the own line saves", one("SELECT staff_pct FROM gradeh_kpi_entries WHERE line_id=?", (L["G8"][1],)) == 91.0)
    pv = C8.post("/my-appraisal/kpi/preview", data=csrf(**{"k_%d" % L["G8"][1]: "91"})).get_json()
    s.check("the preview prints no total while the shared line waits, and says Group People fills it", pv["result"] is None and "Shown once Group People fills" in pv["text"], pv)
    s.check("every new string is in both languages", all(k_ in a.GRADEH_STAFF_T and len(a.GRADEH_STAFF_T[k_]) == 2 for k_ in ("result_rated_shared", "kpi_rated"))
            and all(k_ in a.GRADEH_LM_T and len(a.GRADEH_LM_T[k_]) == 2 for k_ in ("rating_wait_rated",)))

    s.section("the fill: the rating is the setup's, the same as the normal holders' for the same figure")
    db.execute("INSERT INTO gradeh_band_moves(cycle_id, person_id, axis, stage, band, came_in, remark, by_user_id) VALUES (?,?, 'perf','hod','AE','ME','ZZ remark',?)",
               (CID, P["G2"], U["LM"]))
    db.commit()
    mv0 = digest("SELECT * FROM gradeh_band_moves ORDER BY id")
    # a figure that scored a % is not a rating: the function refuses the wrong kind, nothing written
    w0 = world()
    bad = run(lambda d: a.gradeh_bu_fill(d, SUROW(d), dict(SETUP_A), 90.0, value=90))
    s.check("falsified: a % passed for lines rated 1-5 is refused whole (\"gives no rating\"), nothing written", not bad[0] and "no rating" in bad[1] and world() == w0, bad[1])
    bad = run(lambda d: a.gradeh_bu_fill(d, SUROW(d), dict(SETUP_A), None, value=35, rating=9))
    s.check("falsified: a rating outside 1-5 is refused", not bad[0] and world() == w0, bad[1])
    bad = fill(SETUP_A, 35, me=BGAROW)
    s.check("falsified: a non-super admin cannot fill for Grade H (refused whole)", not bad[0] and world() == w0, bad[1])
    n0 = digest("SELECT t.subject_id, t.kpi_name, r.actual_value FROM pm_kpi_results r JOIN pm_kpi_targets t ON t.id=r.kpi_target_id WHERE t.bu_kpi_id=?", (SETUP_A["id"],))
    f0 = audit("gradeh_bu_fill")
    # Fill BU KPI's own POST: the normal holders and the Grade H lines in one transaction
    r = C_SU.post("/admin/performance/bu-fill", follow_redirects=True, data=csrf(business_group=BG, company=CO, kpi_name=SETA, actual_value="35", note="", reason="ZZ audited"))
    nrate = [a.pm_score_kpi_line(CFG_A, dict(t_), res["actual_value"])["value"] for t_, res in
             ((db.execute("SELECT * FROM pm_kpi_targets WHERE id=?", (x["kpi_target_id"],)).fetchone(), x) for x in
              db.execute("SELECT * FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE bu_kpi_id=?)", (SETUP_A["id"],)))]
    s.check("one POST filled the normal holders (a rating for each), and the page says the Grade H lines were filled too",
            len(nrate) == 2 and len(set(nrate)) == 1 and "Also filled 5 Grade H lines" in text(r), (nrate, text(r)[:300]))
    lines_ = [line(L[k][0]) for k in ("G1", "G2", "G3", "G6", "G8")]
    s.check("every Grade H line holds bu_rating == pm_score_kpi_line on the setup == the normal holders' rating for the same 35",
            all(x["bu_rating"] == a.pm_score_kpi_line(CFG_A, dict(SETUP_A), 35)["value"] == nrate[0] for x in lines_) and nrate[0] == 3, ([x["bu_rating"] for x in lines_], nrate))
    s.check("...bu_pct stays empty, the figure typed, when and by whom are kept", all(x["bu_pct"] is None and x["bu_value"] == 35.0 and x["bu_filled_at"]
                                                                                   and x["bu_filled_by"] == SU["id"] for x in lines_))
    s.check("...a line that is not linked is untouched", line(L["G1"][1])["bu_rating"] is None and line(L["GBP"][0])["bu_rating"] is None)
    s.check("one audit row for the fill, ids only, reading \"rated 3\"", audit("gradeh_bu_fill") - f0 == 1 and one(
        "SELECT COUNT(*) FROM activity_log WHERE action='gradeh_bu_fill' AND detail LIKE '%rated 3%' AND detail NOT LIKE '%ZZ GR%'") == 1)
    own = {L["G1"][1]: 4, L["G2"][1]: 2, L["G3"][1]: 5, L["G6"][1]: 3}
    for k in ("G1", "G2", "G3"):
        avg = expected_avg(k, own)
        ap = appr(k)
        s.check("%s: the stored perf rating is the weighted average with the shared rating in place (%s), the band follows it" % (k, avg),
                ap["perf_rating"] == float(avg) and ap["perf_band"] == band_of(avg) and ap["perf_value"] is None, dict(ap))
    rows_ = run(lambda d: d.execute(a._GH_CAL_SQL + "AND p.id=?", (CID, P["G2"])).fetchall())
    det = run(lambda d: a.gradeh_buceo_person_detail(d, CID, rows_[0]))
    s.check("calibration and the leaders' reads after the fill: shared_wait is 0 and the shared line reads \"Rating 3\" (never waiting)",
            rows_[0]["shared_wait"] == 0 and any(k_["name"] == NAME and k_["figure"] == "Rating 3" for k_ in det["kpis"]) and rows_[0]["perf_band"] == appr("G2")["perf_band"], (rows_[0]["shared_wait"], det["kpis"]))
    s.check("an ACKNOWLEDGED person (G3) is re-scored and the acknowledgement stands", appr("G3")["acknowledged_at"] == ack0)
    s.check("the potential, the comments and the submit time were not touched", appr("G1")["pot_band"] and appr("G1")["b_achievements"] and appr("G1")["lm_submitted_at"])
    s.check("a HOD's band move stands (the same row)", digest("SELECT * FROM gradeh_band_moves ORDER BY id") == mv0
            and run(lambda d: a.gradeh_band_at(d, CID, P["G2"], "perf", "hod"))[0] == "AE")
    cg6 = run(lambda d: a.gradeh_computed(d, CID, P["G6"]))
    s.check("G6 (not submitted): nothing stored, but the page's live figure is worked out, with no wait left",
            not cg6["shared_wait"] and cg6["perf_rating"] == float(expected_avg("G6", own)), cg6)
    # a correction re-fills at every stage
    ok, why, cnt = fill(SETUP_A, 45)
    s.check("a correction (45 -> rating 4) re-fills: 5 lines, 2 submitted, 1 acknowledged, 2 before; the stored results move",
            ok and cnt["lines"] == 5 and cnt["submitted"] == 2 and cnt["acknowledged"] == 1 and cnt["before"] == 2 and cnt["rescored"] == 3, (ok, why, cnt))
    s.check("...every line holds 4 and each stored result is the new average", all(line(L[k][0])["bu_rating"] == 4 for k in ("G1", "G2", "G3", "G6", "G8"))
            and all(appr(k)["perf_rating"] == float(expected_avg(k, own)) and appr(k)["perf_band"] == band_of(expected_avg(k, own)) for k in ("G1", "G2", "G3")))
    s.check("...the acknowledgement and the HOD move still stand", appr("G3")["acknowledged_at"] == ack0 and digest("SELECT * FROM gradeh_band_moves ORDER BY id") == mv0)
    ok, why, cnt = fill(SETUP_A, 5)
    s.check("a figure below the ladder is rating 1 (never excluded): lines hold 1", ok and all(line(L[k][0])["bu_rating"] == 1 for k in ("G1", "G2", "G3", "G6", "G8")))
    fill(SETUP_A, 35)

    # a mix (never expected: the link refuses a mismatch) is refused whole, never half-written
    db.execute("UPDATE gradeh_kpi_lines SET bu_kpi_id=? WHERE id=?", (SETUP_A["id"], L["GP"][0]))
    db.commit()
    w0 = world()
    bad = run(lambda d: a.gradeh_bu_fill(d, SUROW(d), dict(SETUP_A), 90.0, value=35, rating=3))
    s.check("falsified: a setup whose lines are of both kinds (a % line and lines rated 1-5) is refused whole, in words, nothing written",
            not bad[0] and "both a % scale and a 1-5 rating" in bad[1] and world() == w0, bad[1])
    bad = run(lambda d: a.gradeh_bu_refresh(d, SUROW(d), dict(setup_row(SETA))))
    s.check("...and the refresh refuses it the same way", not bad[0] and "both a % scale and a 1-5 rating" in bad[1] and world() == w0, bad[1])
    gh_ = run(lambda d: a._bu_fill_gh(d, SUROW(d), {"id": CID}, BG, CO, SETA, 35))
    s.check("...and Fill BU KPI's own read of it carries the error (so the page refuses before writing)", gh_ and gh_[0]["res"] is None and "both a %" in gh_[0]["err"], gh_ and gh_[0]["err"])
    db.execute("UPDATE gradeh_kpi_lines SET bu_kpi_id=NULL WHERE id=?", (L["GP"][0],))
    db.commit()
    s.check("falsified: with the odd line gone the same fill works", fill(SETUP_A, 35)[0] and all(line(L[k][0])["bu_rating"] == 3 for k in ("G1", "G2", "G3", "G6", "G8")))

    s.section("the pages show the rating")
    pg = C_LM.get("%s/%d" % (BASE, P["G1"]))
    t = text(pg)
    s.check("the line manager's submitted record shows the shared rating (\"Rating 3\") with \"Updated on\", and the weighted average",
            pg.status_code == 200 and "Rating 3" in t and "Updated on" in t, t[:700])
    t = text(C_LM.get("%s/%d?step=kpis" % (BASE, P["G6"])))
    s.check("the KPI step (not yet submitted) shows \"Rating 3\" in the shared line, still no picker",
            "Rating 3" in t and 'name="r_%d"' % L["G6"][0] not in C_LM.get("%s/%d?step=kpis" % (BASE, P["G6"])).get_data(as_text=True), t[:500])
    C1 = H.client_as(a, U["G1"])
    t = text(C1.get("/my-appraisal"))
    s.check("the staff page of a submitted person (G1, acknowledging): the KPI row reads Rating 3 and Updated <date>", "Rating 3" in t and "Updated" in t, t[:700])
    t = text(C8.get("/my-appraisal"))
    s.check("the staff KPI step (G8, still to send): the shared line reads Rating 3, no total while a rating is in the list",
            "Rating 3" in t and "No weighted % is shown" in t, t[:700])
    t = text(H.client_as(a, U["G3"]).get("/my-appraisal"))
    s.check("the acknowledged person's page (G3): Rating 3, no \"Waiting\"", "Rating 3" in t and "Waiting for Group People" not in t, t[:700])
    ap = C_SU.get("/admin/users/%d?tab=gradeh" % U["G1"])
    t = text(ap)
    s.check("the admin person page GETs 200 and shows the shared rating (\"Rating 3\") for the line, never \"Waiting\"", ap.status_code == 200 and "Rating 3" in t
            and "Waiting for Group People" not in t, t[:500])
    URL = "/admin/performance/bu-kpis?fbg=%s&fbu=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"))
    lid_a = run(lambda d: a._bu_card_lid(d, BG, CO, dict(setup_row(SETA))))
    rv = C_SU.get(URL + "&kpi=%d" % lid_a)
    t = text(rv)
    s.check("the BU KPI setup read view lists the Grade H lines rated 1 to 5 (\"Grade H line\", the rating text)", rv.status_code == 200 and "Grade H line" in t
            and "rated 1 to 5 takes the rating this result scores" in rv.get_data(as_text=True).replace("&#39;", "'"), t[:500])
    ed = C_SU.get(URL + "&kpi=%d&edit=1" % lid_a).get_data(as_text=True)
    s.check("Edit: the Grade H picklist lists the OTHER lines as tickable (not greyed) and the % line greyed with the words",
            re.search(r'name="k%d_ghline" value="%d"[^>]*checked' % (lid_a, L["G1"][0]), ed) is not None
            and "this line is scored as a %" in html.unescape(ed) and "ZZ GR G4" in ed and "No %s line" % NAME in ed)
    fp = C_SU.get("/admin/performance/bu-fill?business_group=%s&company=%s&kpi_name=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"), SETA.replace(" ", "+")))
    t = text(fp)
    s.check("Fill BU KPI (filled): the Grade H rows read \"Rating 3\" where a % line reads N%, with their stage", fp.status_code == 200 and "Grade H" in t and "Rating 3" in t
            and "Acknowledged" in t, t[:900])
    calc = C_SU.post("/admin/performance/bu-fill", data=csrf(action="calc", business_group=BG, company=CO, kpi_name=SETA, actual_value="45")).get_json()
    s.check("the live calc: no error, Grade H rows count, the rows read the new rating (\"Rating 4\") for the Grade H lines",
            calc["ok"] and calc["n_gh"] == 5 and not calc["gh_err"] and "Rating 4" in html.unescape(re.sub(r"<[^>]+>", " ", calc["rows"])), {k_: v for k_, v in calc.items() if k_ != "rows"})
    # waiting words on the Fill page before any fill: a fresh setup with an unfilled linked line
    fresh = mk_setup(NAME + ": Fresh", people=())
    U["G7"] = mk("G7", "H", mgr=U["LM"])
    person("G7", U["LM"]); lines_for("G7", [(NAME + ": Fresh", 100)])
    ok, why, n = link(fresh, [L["G7"][0]])
    fp = C_SU.get("/admin/performance/bu-fill?business_group=%s&company=%s&kpi_name=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"), (NAME + ": Fresh").replace(" ", "+")))
    t = text(fp)
    s.check("Fill BU KPI (nobody filled yet): the Grade H line reads \"Will be filled\" and no result till a figure is typed; a held-by-Grade-H-alone KPI keeps its Rating column",
            ok and fp.status_code == 200 and "Will be filled" in t and "Grade H's own scale rates it" not in t, (ok, why, t[:600]))
    ok2, why2, cnt2 = fill(fresh, 25)
    s.check("a KPI held by Grade H lines alone fills: the line is rated 2 on that ladder (25 -> 2)", ok2 and line(L["G7"][0])["bu_rating"] == 2 and cnt2["lines"] == 1, (ok2, why2))
    unlink([L["G7"][0]])
    db.execute("DELETE FROM pm_bu_kpis WHERE id=?", (fresh["id"],))
    db.commit()

    s.section("a changed ladder re-rates the Grade H lines (gradeh_bu_refresh and the card's save)")
    URL = "/admin/performance/bu-kpis?fbg=%s&fbu=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"))
    k = "k%d_" % lid_a
    d = csrf(action="save_kpi", kpi=str(lid_a))
    d.update({k + "unit": "%", k + "carriers": "holders", k + "holder_set": "1", k + "wmode": "own", k + "ghset": "1",
              k + "holder": [a.ja_eid(PFX + p) for p in ("N1", "N2")], k + "ghline": [str(L[x][0]) for x in ("G1", "G2", "G3", "G6", "G8")]})
    d.update({k + "rate%d" % i: str(v) for i, v in enumerate((20, 40, 60, 80, 100), 1)})
    fa0 = line(L["G1"][0])["bu_filled_at"]
    r = C_SU.post(URL, follow_redirects=True, data=d)
    want = a.pm_rating_mechanism_a(35, "more", 20, 40, 60, 80, 100)
    s.check("the card saved a steeper ladder (20..100): 35 now rates %d for the Grade H lines, as the setup scores it" % want,
            all(line(L[x][0])["bu_rating"] == want for x in ("G1", "G2", "G3", "G6", "G8")) and want != 3, ([line(L[x][0])["bu_rating"] for x in ("G1", "G2", "G3", "G6", "G8")], text(r)[:300]))
    s.check("...the submitted and acknowledged people are re-scored from it",
            all(appr(x)["perf_rating"] == float(expected_avg(x, own)) for x in ("G1", "G2", "G3")), [dict(appr(x))["perf_rating"] for x in ("G1", "G2", "G3")])
    fa1 = line(L["G1"][0])["bu_filled_at"]
    s.check("the normal holders' own lines carry the same steeper ladder, so they rate the same figure the same way",
            all(db.execute("SELECT rate1, rate5 FROM pm_kpi_targets WHERE subject_id=?", (U[x],)).fetchone()[:] == (20.0, 100.0) for x in ("N1", "N2")))
    r = C_SU.post(URL, follow_redirects=True, data=d)
    s.check("a save that changes nothing the figure rates (the same ladder again) rewrites no Grade H line: \"Updated\" does not move", line(L["G1"][0])["bu_filled_at"] == fa1)
    ok, why, cnt = run(lambda d_: a.gradeh_bu_refresh(d_, SUROW(d_), dict(setup_row(SETA))))
    s.check("gradeh_bu_refresh by itself: nothing to do (the ladder is already applied)", ok and cnt is None)
    db.execute("UPDATE pm_bu_kpis SET rate1=10, rate2=20, rate3=30, rate4=40, rate5=50 WHERE id=?", (SETUP_A["id"],))
    db.commit()
    ok, why, cnt = run(lambda d_: a.gradeh_bu_refresh(d_, SUROW(d_), dict(setup_row(SETA))))
    s.check("falsified: the ladder back to 10..50 and a refresh puts the rating back to 3 for all five", ok and cnt and cnt["lines"] == 5
            and all(line(L[x][0])["bu_rating"] == 3 for x in ("G1", "G2", "G3", "G6", "G8")), (ok, why, cnt))
    SETUP_A = setup_row(SETA)

    s.section("gradeh_bu_unlink: falls back to the line manager's rating; refused when it would leave a submitted result empty")
    w0 = world()
    ok, why, n, res = unlink([L["G1"][0]])
    s.check("G1 is submitted and the line has no rating of the line manager's: refused (Reopen first), nothing changed",
            not ok and "Reopen" in why and "no rating from the line manager" in why and world() == w0 and line(L["G1"][0])["bu_kpi_id"] == SETUP_A["id"], why)
    ok, why, n, res = unlink([L["G1"][0]], me=BGAROW)
    s.check("only the super admin unlinks", not ok and line(L["G1"][0])["bu_kpi_id"] == SETUP_A["id"], why)
    db.execute("INSERT OR REPLACE INTO gradeh_kpi_entries(cycle_id, person_id, line_id, lm_rating, lm_at) VALUES (?,?,?,?,?)", (CID, P["G1"], L["G1"][0], 5, utc(NOW)))
    db.commit()
    u0 = audit("gradeh_bu_unlink")
    ok, why, n, res = unlink([L["G1"][0]])
    own2 = dict(own)
    own2[L["G1"][0]] = 5
    s.check("falsified: with a rating of the line manager's the line lets go: cleared (bu_rating too), then re-scored from lm_rating (5)",
            ok and n == 1 and line(L["G1"][0])["bu_kpi_id"] is None and line(L["G1"][0])["bu_rating"] is None and line(L["G1"][0])["bu_filled_at"] is None
            and appr("G1")["perf_rating"] == float(expected_avg("G1", own2)) and res["rescored"] == 1, (why, dict(appr("G1"))))
    s.check("...one audit row", audit("gradeh_bu_unlink") - u0 == 1)
    ok, why, n, res = unlink([L["G6"][0]])
    s.check("a person not submitted yet (G6) lets go with nothing stored to re-score; the line falls back to the line manager's rating (none yet)",
            ok and line(L["G6"][0])["bu_rating"] is None and run(lambda d: a.gradeh_computed(d, CID, P["G6"]))["perf_rating"] is None, why)
    ok, why, n = link(SETUP_A, [L["G1"][0], L["G6"][0]])
    s.check("the lines can follow again (waiting)", ok and n == 2 and line(L["G1"][0])["bu_rating"] is None)
    fill(SETUP_A, 35)

    s.section("the Grade H KPI import keeps the link and the rating, and refuses a move between a % scale and a rating")
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
            d_ = a.get_db()
            me = dict(d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
            spec = a._IMP[a.GRADEH_KPI_KIND]
            return spec["load"](d_, me, {"filename": "gh.csv"}, xfile(rows).read()), me
    ctx, me = load_kpi([[PFX + "G2", NAME, "60", "OTHER"], [PFX + "G2", "ZZGR Own KPI", "40", "OTHER"]])
    s.check("the same lines with new weights: valid", ctx["valid"] and not ctx["errors"], ctx["errors"])
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        a._gkl_apply(d_, me, ctx, {})
        d_.commit()
    nl = db.execute("SELECT * FROM gradeh_kpi_lines WHERE person_id=? AND kpi_name=?", (P["G2"], NAME)).fetchone()
    s.check("the link, the rating and the figure carried over to the recreated line (new id, new weight)",
            nl["bu_kpi_id"] == SETUP_A["id"] and nl["bu_rating"] == 3 and nl["bu_pct"] is None and nl["weight"] == 60.0 and nl["bu_value"] == 35.0 and nl["id"] != L["G2"][0], dict(nl))
    L["G2"] = [r_["id"] for r_ in db.execute("SELECT id FROM gradeh_kpi_lines WHERE person_id=? ORDER BY sort_order, id", (P["G2"],))]
    ctx, me = load_kpi([[PFX + "G2", NAME, "60", "FIAMMA"], [PFX + "G2", "ZZGR Own KPI", "40", "FIAMMA"]])
    s.check("falsified: a file that moves the linked line from a rating to a % scale is refused, naming the line",
            not ctx["valid"] and any("follows a BU KPI" in e["why"] and "different kind of scale" in e["why"] for e in ctx["errors"]), ctx["errors"])

    s.section("words and records")
    s.check("the audit words exist for the three actions", all(k_ in a.ACTION_LABELS for k_ in ("gradeh_bu_link", "gradeh_bu_unlink", "gradeh_bu_fill")))
finally:
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    else:
        os.environ["ONEHR_GRADEH"] = _ENV0
    db.execute("UPDATE cycles SET kind=?, year=?, half=?, min_job_grade=? WHERE id=?", (PREV["kind"], PREV["year"], PREV["half"], PREV["min_job_grade"], CID))
    db.commit()

sys.exit(s.done())
