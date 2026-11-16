"""Fill BU KPI reads back what Group People filled (2026-11-05; Chris approved the canvas "Fill BU KPI: filled card").

Before this, the card after a fill was the blank entry form again (empty result box, Achievement / Score "—", every row "Filled before"), and a BU KPI
held by Grade H lines alone read "Not filled · 0 carry it" in the rail even when its lines held the figure.

What this suite holds (synthetic ZZ9BF-* people on a fresh scratch database; the suite puts back what it changes):
  * an unfilled KPI renders exactly as before: the entry form, "Will be filled", "Fill N lines", no filled-card marks
  * after a fill the card is the filled read view: the Filled pill, the figure in the locked box, Achievement / Score as the server scores
    that figure (the same words the live calc gives), the saved note as text, each row Filled with its figure and day, the foot naming
    when and who, and Edit for the super admin
  * a BG admin reads the same card and gets no Edit (and the foot says why); the server's own rules are unchanged
  * a calibrator's move or a release holds a line ("Calibrated, stays as filled"); all held -> Edit disabled, saying why; some held -> Edit stays
  * a carrier added after the fill reads "Filled · 1 to fill" in the head and the rail and "Not filled yet" in its row; a BG admin fills just that
    line; the super admin's save fills it too
  * two figures -> "Two figures: ..." (three listed, "N figures" beyond), Achievement / Score "—", an empty edit box, the rail says "N figures"
  * the live calc on a filled KPI reads "Changes: 104% -> 106%" / "Stays: 104%"; on an unfilled KPI it is the old words
  * an edit POST changes the figure and the note, and is refused without a reason
  * a KPI held by Grade H lines alone: the rail counts them (carry it (Grade H)), reads Filled after the fill with "result 97%" and no Score,
    the card has no Note box, the flash says "Filled 2 Grade H lines"
  * a mixed KPI counts "(1 Grade H)"; a non-super admin cannot fill it (the server's rule), so the page offers no button
  * the page reads in a fixed number of queries however many lines there are
  * every button on the card keeps its words on one line; the result row's figures use the box's size and weight
"""
import json
import os
import re
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Fill BU KPI: the filled card, Edit, the rail, Grade H lines")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA0, _EMP = H.actors(a)
PFX, BG, CO = "ZZ9BF-", "ZZBF Group", "ZZBF Unit"
REV, GPM, UPT, MIX = "ZZBF Revenue", "ZZBF Margin", "ZZBF Uptime", "ZZBF Mixed"
U, P = {}, {}
_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
import sqlite3  # noqa: E402

db = sqlite3.connect(a.DB_PATH, timeout=5.0)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")
URL = "/admin/performance/bu-fill"
Q = "?business_group=%s&company=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"))


def one(sql, args=()):
    r = db.execute(sql, args).fetchone()
    return r[0] if r else None


def csrf(**kw):
    d = {"csrf_token": "tok"}
    d.update(kw)
    return d


def mk(k, grade="15", role="user", admin_bg=None):
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg, company, department, job_grade, "
        "job_title, confirmation_date, email) VALUES (?,?, 'x', ?, ?,?,?,?, 'ZZBF Dept', ?, 'Clerk', '2020-01-01', ?)",
        ((PFX + k).lower(), "ZZ BF " + k, role, PFX + k, BG, admin_bg, CO, grade, "zzbf.%s@example.test" % k.lower())).lastrowid


def mk_lib(name):
    r = db.execute("SELECT id FROM pm_kpi_library WHERE business_group=? AND kpi_name=?", (BG, name)).fetchone()
    if r:
        return r[0]
    return db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, unit, method, "
                      "weightage_default, bu_level) VALUES (?, '*', '*', 0, '*', ?, 'Financial · Profitability', '%', 'more', 30, 1)", (BG, name)).lastrowid


def mk_setup(name):
    sid = db.execute("INSERT INTO pm_bu_kpis(cycle_id, business_group, company, library_id, kpi_name, unit, method, threshold, target, multiple, carriers, "
                     "carriers_json, weight_mode, updated_by) VALUES (?,?,?,?,?, '%', 'more', 0,100,100, 'holders', '{}', 'own', ?)",
                     (CID, BG, CO, mk_lib(name), name, SU["id"])).lastrowid
    db.commit()
    return sid


def carrier(k, name, sid):
    tid = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, threshold, target, multiple, "
                     "business_group, company, bu_kpi_id) VALUES (?,?,?,20,'more','%','Own',0,100,100,?,?,?)", (CID, U[k], name, BG, CO, sid)).lastrowid
    db.commit()
    return tid


def gh_line(k, name, sid):
    if k not in P:
        P[k] = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route, appraiser_id, language, private_company) "
                          "VALUES (?,?,?, 'A', ?, 'en', 0)", (CID, PFX + k, U[k], U["LM"])).lastrowid
    lid = db.execute("INSERT INTO gradeh_kpi_lines (cycle_id, person_id, kpi_name, weight, group_scale, sort_order, bu_kpi_id) VALUES (?,?,?,30,'FIAMMA',1,?)",
                     (CID, P[k], name, sid)).lastrowid
    db.commit()
    return lid


def get(kpi, c=None):
    return (c or SUC).get("%s%s&kpi_name=%s" % (URL, Q, kpi.replace(" ", "+"))).get_data(as_text=True)


def calc(kpi, value, c=None):
    r = (c or SUC).post(URL, data=csrf(action="calc", business_group=BG, company=CO, kpi_name=kpi, actual_value=str(value)))
    return r.get_json()


def fill(kpi, value, note="", reason="ZZ audited figure", c=None):
    return (c or SUC).post(URL, follow_redirects=True, data=csrf(business_group=BG, company=CO, kpi_name=kpi, actual_value=str(value),
                                                                  note=note, reason=reason)).get_data(as_text=True)


def flat(h):
    h = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", h)
    m = re.search(r'<main id="main"[\s\S]*', h)
    h = m.group(0) if m else h
    h = re.sub(r"<[^>]+>", " ", h)
    import html as _h
    return " ".join(_h.unescape(h).split())


def card(h):
    m = re.search(r'<form method="post" id="bf-form"[\s\S]*?</form>', h)
    return m.group(0) if m else ""


def rail_row(h, kpi):
    m = re.search(r'<a class="bk2-row[^"]*"[^>]*kpi_name=%s[^>]*>[\s\S]*?</a>' % re.escape(kpi.replace(" ", "+")), h)
    return flat(m.group(0)) if m else ""


def results(kpi):
    return [dict(r) for r in db.execute(
        "SELECT t.subject_id, r.actual_value, r.note, r.submitted_by, r.submitted_at, r.admin_filled FROM pm_kpi_results r JOIN pm_kpi_targets t "
        "ON t.id=r.kpi_target_id WHERE t.cycle_id=? AND t.kpi_name=? ORDER BY t.subject_id", (CID, kpi))]


# ---------------------------------------------------------------- fixture
with a.app.test_request_context("/"):
    CID = a.active_cycle_id(a.get_db())
PREV = dict(db.execute("SELECT kind, year, half, min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())
db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL WHERE id=?", (CID,))
db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 1)", (CID,))
db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', '2099-11-02 00:00', '2099-11-08 23:59')", (CID,))
db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
db.execute("INSERT OR REPLACE INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'B', 'base')", (BG,))
U["LM"] = mk("LM")
for k in ("N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8", "N9", "NA", "NB", "NC", "ND", "NE", "NF", "NG"):
    U[k] = mk(k)
for k in ("H1", "H2", "H3"):
    U[k] = mk(k, "H")
ROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZBF role', 'group')").lastrowid
db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(ROLE, "pm.read"), (ROLE, "pm.bu_kpi")])
U["BGA"] = mk("BGA", role="admin", admin_bg=BG)
db.execute("UPDATE users SET admin_role_id=? WHERE id=?", (ROLE, U["BGA"]))
SET = {n: mk_setup(n) for n in (REV, GPM, UPT, MIX)}
T = {}
for k in ("N1", "N2", "N3", "N4", "N5", "N6"):
    T[k] = carrier(k, REV, SET[REV])
for k in ("N7", "N8", "N9"):
    T[k] = carrier(k, GPM, SET[GPM])
L = {"H1": gh_line("H1", UPT, SET[UPT]), "H2": gh_line("H2", UPT, SET[UPT])}
T["NA"] = carrier("NA", MIX, SET[MIX])
T["NB"] = carrier("NB", MIX, SET[MIX])
L["H3"] = gh_line("H3", MIX, SET[MIX])
SUC = H.client_as(a, SU["id"])
BGC = H.client_as(a, U["BGA"])
EXTRA_T, HOLDS = [], []


def cleanup():
    d = sqlite3.connect(a.DB_PATH, timeout=5.0)
    d.execute("PRAGMA foreign_keys=OFF")
    ids = [r[0] for r in d.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9BF-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        tl = [r[0] for r in d.execute("SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)]
        if tl:
            pt = ",".join("?" * len(tl))
            d.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (%s)" % pt, tl)
        d.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)
        d.execute("DELETE FROM result_releases WHERE subject_id IN (%s)" % ph, ids)
        d.execute("DELETE FROM gradeh_kpi_lines WHERE person_id IN (SELECT id FROM gradeh_people WHERE user_id IN (%s))" % ph, ids)
        d.execute("DELETE FROM gradeh_people WHERE user_id IN (%s)" % ph, ids)
        d.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        d.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    d.execute("DELETE FROM admin_roles WHERE name='ZZBF role'")
    d.execute("DELETE FROM pm_bu_kpis WHERE business_group=?", (BG,))
    d.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    d.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    d.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    d.execute("DELETE FROM activity_log WHERE action IN ('pm_bu_fill','gradeh_bu_fill') AND detail LIKE '%ZZBF%'")
    d.execute("UPDATE cycles SET kind=?, year=?, half=?, min_job_grade=? WHERE id=?", (PREV["kind"], PREV["year"], PREV["half"], PREV["min_job_grade"], CID))
    d.commit()
    d.close()


try:
    # ------------------------------------------------------------ unfilled
    s.section("an unfilled KPI renders as before")
    h = get(GPM)
    c0 = card(h)
    s.check("(set-up) the page is the Fill BU KPI page with a card", "bf-form" in c0 and "Will be filled" in c0)
    s.check("no filled-card marks: no data-bf-f, no Editing pill, no Edit button, no locked box",
            "data-bf-f" not in c0 and "Editing" not in c0 and "data-bf-edit" not in c0 and re.search(r"data-bf-ro(?![a-z-])", c0) is None and "bf-ed" not in c0, [m for m in ("data-bf-f", "Editing", "data-bf-edit", "bf-ed") if m in c0])
    s.check("the entry form: empty result box, Note box, 'Fill 3 lines' button disabled",
            'name="actual_value"' in c0 and 'name="note"' in c0 and re.search(r'data-bf-go disabled>Fill 3 lines<', c0) is not None)
    s.check("its words are today's", "The result is final at once and skips the moderator. A line a calibrator has acted on, or whose result is released, is left as it is." in flat(c0)
            and "Fill this result for 3 lines of %s now?" % GPM in c0)
    s.check("the rail says Not filled and the old summary", "Not filled" in rail_row(h, GPM) and "3 carry it" in rail_row(h, GPM)
            and "Grade H" not in rail_row(h, GPM), rail_row(h, GPM))
    cj = calc(GPM, 92.5)
    s.check("the live calc on an unfilled KPI keeps the old row words", "Will be filled" in cj["rows"] and "Changes:" not in cj["rows"]
            and "Stays:" not in cj["rows"] and cj["achievement"], cj["rows"][:200])

    # ------------------------------------------------------------ the fill, the read view
    s.section("after a fill the card reads back the figure")
    r = fill(REV, 104, note="Audited figure, Q3")
    s.check("the fill went through (6 lines)", "Filled 6 of 6 matching" in flat(r) and len(results(REV)) == 6, flat(r)[:300])
    h = get(REV)
    c1 = card(h)
    ct = flat(c1)
    cj = calc(REV, 104)
    s.check("the card is the filled read view: data-bf-f, Filled pill, no 'to fill'", "data-bf-f" in c1 and re.search(
        r'bk2-pill bf-rd is-ok">Filled</span>', c1) is not None, re.findall(r'bk2-pill bf-rd[^>]*>[^<]*', c1))
    ro = re.search(r'<span class="bf-ro bf-rd" data-bf-ro[^>]*>([\s\S]*?)</span>\s*<span class="bf-resin', c1)
    s.check("the filled figure is in the locked box (not the input), 104 %", ro is not None and "104" in flat(ro.group(1)) and "%" in flat(ro.group(1)),
            ro.group(1)[:200] if ro else "")
    s.check("the input is there for Edit, prefilled with 104 and hidden in the read view", re.search(r'name="actual_value"[^>]*value="104"', c1) is not None)
    s.check("Achievement is what the server's calc gives for 104 (never computed in the page)",
            re.search(r'data-bf-ach>%s<' % re.escape(cj["achievement"]), c1) is not None and cj["achievement"] not in ("", "—"), (cj["achievement"],))
    s.check("Score is what the server's calc gives for 104", re.search(r'data-bf-rt>%s<' % re.escape(cj["rating"]), c1) is not None and cj["rating"], cj["rating"])
    s.check("the note is read-only text", re.search(r'data-bf-ronote>Audited figure, Q3<', c1) is not None)
    s.check("every row is Filled with its figure and day, and a rating from its own figure",
            c1.count('title="Filled"') == 6 and len(re.findall(r'<small class="bf-stage">104% · \d{1,2} [A-Z][a-z]{2}</small>', c1)) == 6
            and "Filled before" not in c1 and "Will be filled" not in c1, c1.count('title="Filled"'))
    s.check("the Rating column carries the score of each filled figure", c1.count(cj["rating"]) >= 6 + 1, cj["rating"])
    who = db.execute("SELECT full_name FROM users WHERE id=?", (SU["id"],)).fetchone()[0]
    s.check("the foot names when (MYT) and who filled", re.search(r"Filled \d{1,2} [A-Z][a-z]{2} 20\d\d, \d\d:\d\d MYT by %s" % re.escape(who), ct) is not None, ct[-300:])
    s.check("the super admin gets a navy Edit button", re.search(r'<button type="button" class="bk2-edit? ?[^"]*" data-bf-edit>Edit</button>', c1) is not None
            or 'data-bf-edit>Edit</button>' in c1)
    s.check("the edit foot is there for Edit: Cancel and the Save button (disabled)", "data-bf-cancel" in c1 and re.search(r'data-bf-go disabled>Save 6 lines<', c1) is not None)
    rr = rail_row(h, REV)
    s.check("the rail says Filled with the result and Score", "Filled" in rr and "Filled ·" not in rr and "result 104%" in rr and "Score" in rr, rr)
    s.check("falsified: the unfilled KPI's page has none of this", "data-bf-f" not in card(get(GPM)))

    # ------------------------------------------------------------ the calc on a filled KPI
    s.section("the live calc on a filled KPI reads as an edit")
    cj106 = calc(REV, 106)
    cj104 = calc(REV, 104)
    s.check("a different figure: Changes: 104% -> 106% on every refill row", cj106["rows"].count(">Changes: 104% → 106%<") == 6, cj106["rows"][:300])
    s.check("the same figure: Stays: 104%", cj104["rows"].count(">Stays: 104%<") == 6 and "Changes:" not in cj104["rows"])
    s.check("no figure yet: Filled: 104%", calc(REV, "")["rows"].count(">Filled: 104%<") == 6)
    s.check("the score moves with the figure (server scored)", cj106["rating"] != cj104["rating"] and cj106["value_text"] == "106%")

    # ------------------------------------------------------------ a BG admin
    s.section("a BG admin reads the same card and gets no Edit")
    hb = get(REV, BGC)
    cb = card(hb)
    s.check("(the BG admin sees the filled card)", "data-bf-f" in cb and 'data-bf-ro' in cb and cj["achievement"] in cb)
    s.check("no Edit button and no way to enter edit", "data-bf-edit" not in cb)
    s.check("the foot says only the super admin changes a filled result", "only the super admin changes a filled result" in flat(cb))
    s.check("falsified: the super admin's same page has the button", "data-bf-edit" in get(REV))
    v0 = results(REV)
    r = fill(REV, 90, reason="ZZ bg try", c=BGC)
    s.check("the server's rule is unchanged: a BG admin's POST leaves the filled lines as they are", results(REV) == v0, flat(r)[:200])

    # ------------------------------------------------------------ held lines
    s.section("a calibrated or released line stays as filled")
    for k in ("N1", "N2"):
        db.execute("INSERT OR REPLACE INTO result_releases(cycle_id, subject_id, kind, released_by) VALUES (?,?, 'pm', ?)", (CID, U[k], SU["id"]))
    db.commit()
    ch = card(get(REV))
    s.check("two held: those rows read 'Released, stays as filled' (the super admin's view leaves only a released result, 2026-11-14), four Filled", ch.count('title="Released, stays as filled"') == 2
            and ch.count('title="Filled"') == 4)
    s.check("...and Edit stays for the four", "data-bf-edit>Edit" in ch and 'disabled title=' not in ch)
    cj_h = calc(REV, 107)
    s.check("...the calc counts only the four (Changes on four, the held two stay)", cj_h["rows"].count(">Changes: 104% → 107%<") == 4
            and cj_h["rows"].count(">Released, stays as filled<") == 2 and cj_h["n_fill"] == 4, (cj_h["n_fill"],))
    for k in ("N3", "N4", "N5", "N6"):
        db.execute("INSERT OR REPLACE INTO result_releases(cycle_id, subject_id, kind, released_by) VALUES (?,?, 'pm', ?)", (CID, U[k], SU["id"]))
    db.commit()
    hh = get(REV)
    ch = card(hh)
    s.check("all held: Edit is disabled, with a title saying why", re.search(r'<button type="button" class="bk2-btn bk2-edit" disabled title="[^"]+">Edit</button>', ch) is not None
            and "data-bf-edit" not in ch)
    s.check("...and the foot says all 6 have their result released", "All 6 have their result released: the figure stays as filled." in flat(ch), flat(ch)[-250:])
    v0 = results(REV)
    fill(REV, 99, reason="ZZ try held")
    s.check("the server agrees: a held line is not refilled", results(REV) == v0)
    db.execute("DELETE FROM result_releases WHERE subject_id IN (SELECT id FROM users WHERE employee_id LIKE 'ZZ9BF-%')")
    db.commit()
    s.check("falsified: with the releases gone, Edit is back", "data-bf-edit>Edit" in card(get(REV)) and 'title="Released' not in card(get(REV)))

    # ------------------------------------------------------------ a carrier added after the fill
    s.section("a carrier added after the fill is 'to fill'")
    T["N7x"] = carrier("NC", REV, SET[REV])
    hh = get(REV)
    ch = card(hh)
    s.check("the head reads 'Filled · 1 to fill' (amber)", re.search(r'bk2-pill bf-rd is-warn">Filled · 1 to fill<', ch) is not None)
    s.check("the rail says 'Filled · 1 to fill'", "Filled · 1 to fill" in rail_row(hh, REV), rail_row(hh, REV))
    s.check("the row reads 'Not filled yet'", ch.count('title="Not filled yet"') == 1 and ch.count('title="Filled"') == 6)
    s.check("the super admin still gets Edit, which opens prefilled (Save would read 7 lines)", "data-bf-edit>Edit" in ch and 'data-bf-unf="1"' in ch)
    cb = card(get(REV, BGC))
    s.check("a BG admin gets 'Fill the 1 not filled' (the same edit mode) and no Edit", "data-bf-edit>Fill the 1 not filled<" in cb and ">Edit<" not in cb)
    s.check("...the figure and the note are read-only for them (they fill the rest with the same figure)", re.search(r'name="actual_value"[^>]*readonly', cb) is not None
            and re.search(r'<textarea[^>]*readonly', cb) is not None)
    v0 = {r["subject_id"]: r for r in results(REV)}
    fill(REV, 104, note="Audited figure, Q3", reason="ZZ the one added", c=BGC)
    v1 = {r["subject_id"]: r for r in results(REV)}
    s.check("the BG admin's save fills just the new line", len(v1) == 7 and all(v1[k] == v0[k] for k in v0) and v1[U["NC"]]["actual_value"] == 104
            and v1[U["NC"]]["submitted_by"] == U["BGA"], (len(v0), len(v1)))
    hh = get(REV)
    s.check("...and nothing reads 'to fill' any more", "to fill" not in card(hh) and "to fill" not in rail_row(hh, REV))
    # the super admin's save fills a second added line
    T["ND"] = carrier("ND", REV, SET[REV])
    s.check("(set-up) another is added: 1 to fill again", "Filled · 1 to fill" in flat(card(get(REV))))
    fill(REV, 104, note="Audited figure, Q3", reason="ZZ super fills the rest")
    v2 = {r["subject_id"]: r for r in results(REV)}
    s.check("the super admin's save fills it too, all eight on 104", len(v2) == 8 and {r["actual_value"] for r in v2.values()} == {104.0}
            and v2[U["ND"]]["submitted_by"] == SU["id"])

    # ------------------------------------------------------------ edit POST
    s.section("an edit POST changes the figure and the note; a reason is required")
    before = results(REV)
    fill(REV, 106, note="Restated", reason="")
    s.check("without a reason nothing changes", results(REV) == before)
    fill(REV, 106, note="Restated", reason="ZZ Finance restated Q3")
    after = results(REV)
    s.check("with a reason all eight lines hold 106 and the new note", {r["actual_value"] for r in after} == {106.0}
            and {r["note"] for r in after} == {"Restated"} and all(r["admin_filled"] == 1 for r in after), after[:2])
    ch = card(get(REV))
    s.check("the card now reads 106 and 'Restated'", 'data-bf-ronote>Restated<' in ch and re.search(r'name="actual_value"[^>]*value="106"', ch) is not None)
    s.check("falsified: the reason is what gated it (the audit row carries it)", one("SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_fill' AND detail LIKE '%ZZ Finance restated Q3%'") == 1)

    # ------------------------------------------------------------ two figures
    s.section("lines holding different figures")
    tids = [r[0] for r in db.execute("SELECT t.id FROM pm_kpi_targets t WHERE t.cycle_id=? AND t.kpi_name=? ORDER BY t.subject_id", (CID, REV))]
    db.execute("UPDATE pm_kpi_results SET actual_value=98 WHERE kpi_target_id IN (%s)" % ",".join(map(str, tids[:2])))
    db.commit()
    hh = get(REV)
    ch = card(hh)
    s.check("the box reads 'Two figures: 106% on 6 lines · 98% on 2'", "Two figures: 106% on 6 lines · 98% on 2" in flat(ch), re.findall(r"Two figures[^<]*", ch))
    s.check("Achievement and Score read —", re.search(r'data-bf-ach>—<', ch) is not None and re.search(r'data-bf-rt>—<', ch) is not None)
    s.check("Edit opens empty: the input has no value and data-bf-init is empty", 'data-bf-init=""' in ch and re.search(r'name="actual_value"[^>]*value="', ch) is None)
    s.check("the rail says 'result: 2 figures'", "result: 2 figures" in rail_row(hh, REV), rail_row(hh, REV))
    s.check("the table shows each line's own figure", ch.count("98% · ") == 2 and ch.count("106% · ") == 6)
    db.execute("UPDATE pm_kpi_results SET actual_value=97 WHERE kpi_target_id=?", (tids[2],))
    db.execute("UPDATE pm_kpi_results SET actual_value=96 WHERE kpi_target_id=?", (tids[3],))
    db.commit()
    ch = card(get(REV))
    s.check("four figures: the box reads '4 figures'", "4 figures" in flat(ch) and "Four" not in flat(ch) and "Two figures" not in flat(ch))
    db.execute("UPDATE pm_kpi_results SET actual_value=106 WHERE kpi_target_id IN (%s)" % ",".join(map(str, tids)))
    db.commit()
    s.check("falsified: put back to one figure, the single box returns", "Two figures" not in card(get(REV)) and "data-bf-ro" in card(get(REV)))

    # ------------------------------------------------------------ Grade H only
    s.section("a BU KPI held by Grade H lines alone")
    hh = get(UPT)
    rr0 = rail_row(hh, UPT)
    s.check("before the fill the rail counts the Grade H lines as carriers ('2 carry it (Grade H)') and says Not filled",
            "2 carry it (Grade H)" in rr0 and "0 carry it" not in rr0 and "Not filled" in rr0, rr0)
    r = fill(UPT, 97, reason="ZZ gh fill")
    s.check("the flash says 'Filled 2 Grade H lines for ...'", "Filled 2 Grade H lines for '%s'" % UPT in flat(r) and "0 of 0" not in flat(r), flat(r)[:300])
    hh = get(UPT)
    ch = card(hh)
    rr = rail_row(hh, UPT)
    s.check("the rail now reads Filled, 'result 97%' and no Score", "Filled" in rr and "Not filled" not in rr and "result 97%" in rr and "Score" not in rr
            and "2 carry it (Grade H)" in rr, rr)
    s.check("the card is the filled read view with the figure 97", "data-bf-f" in ch and re.search(r'data-bf-ro[^>]*>[\s\S]*?97', ch) is not None)
    s.check("no Note box in read or in edit (Grade H lines keep no note)", 'name="note"' not in ch and "data-bf-ronote" not in ch and "Note" not in flat(ch).replace("Notes", ""),
            re.findall(r"Note[^<]{0,30}", ch))
    s.check("Achievement reads from the Grade H lines' shared achievement", re.search(r'data-bf-ach>%s<' % re.escape(calc(UPT, 97)["achievement"]), ch) is not None, re.findall(r"data-bf-ach>[^<]*", ch))
    s.check("the rows are Filled with figure, day and stage", ch.count('title="Filled"') == 2 and len(re.findall(r'97% · \d{1,2} [A-Z][a-z]{2} · Not started', ch)) == 2,
            re.findall(r'bf-stage">[^<]*', ch))
    s.check("the super admin gets Edit", "data-bf-edit>Edit" in ch)
    cjg = calc(UPT, 98)
    s.check("the calc in edit reads Changes: 97% -> 98% on the Grade H rows", cjg["rows"].count(">Changes: 97% → 98%<") == 2, cjg["rows"][:200])
    fill(UPT, 98, reason="ZZ gh refill")
    s.check("an edit POST re-fills the Grade H lines", {r[0] for r in db.execute("SELECT bu_value FROM gradeh_kpi_lines WHERE bu_kpi_id=?", (SET[UPT],))} == {98.0})
    s.check("falsified: a KPI with normal holders keeps its Note box", 'name="note"' in card(get(REV)))

    # ------------------------------------------------------------ mixed
    s.section("a KPI held by normal lines and a Grade H line")
    hh = get(MIX)
    rr = rail_row(hh, MIX)
    s.check("the rail counts both: '3 carry it (1 Grade H)'", "3 carry it (1 Grade H)" in rr, rr)
    r = fill(MIX, 90, note="mixed", reason="ZZ mixed fill")
    s.check("a super admin's fill reaches both (flash keeps its words)", "Filled 2 of 2 matching" in flat(r) and "Also filled 1 Grade H line" in flat(r), flat(r)[:300])
    hh = get(MIX)
    ch = card(hh)
    s.check("filled card: 3 Filled rows, the Grade H row among them, the Note box present", ch.count('title="Filled"') == 3 and "mixed" in ch and 'name="note"' in ch)
    carrier("NE", MIX, SET[MIX])
    cb = card(get(MIX, BGC))
    s.check("a BG admin with a Grade H line on the KPI is offered no button (the server refuses them whole)", "data-bf-edit" not in cb
            and "Grade H lines share this result, so only the super admin can fill the rest" in flat(cb), flat(cb)[-250:])
    r = fill(MIX, 90, reason="ZZ bg", c=BGC)
    s.check("...and the server does refuse", "Nothing was filled" in flat(r))
    s.check("the super admin's page says 1 to fill", "Filled · 1 to fill" in flat(card(get(MIX))))

    # ------------------------------------------------------------ variants in the rail
    s.section("a variant sits under its root in the rail, as on BU KPI setup")
    VR, VV, VO = "ZZBF Rollup", "ZZBF Rollup: Plant A", "ZZBF Lonely: Plant B"
    vroot = mk_setup(VR)
    vvar = mk_setup(VV)
    vorph = mk_setup(VO)
    try:
        s.check("(set-up) _bu_root reads the variant's root", a._kpi_key(a._bu_root(VV)) == a._kpi_key(VR) and a._kpi_key(a._bu_root(VO)) != a._kpi_key(VO))

        def rail_a(h, kpi):
            m_ = re.search(r'<a class="(bk2-row[^"]*)"[^>]*kpi_name=%s[^>]*>' % re.escape(kpi.replace(" ", "+")), h)
            return (m_.group(1).split(), m_.start(), m_.end()) if m_ else (None, -1, -1)
        hv = get(GPM)
        c_root, i_root, e_root = rail_a(hv, VR)
        c_var, i_var, _e = rail_a(hv, VV)
        c_orph, _i, _e2 = rail_a(hv, VO)
        s.check("the variant's row is is-sub", c_var is not None and "is-sub" in c_var, c_var)
        s.check("the root's row is not is-sub", c_root is not None and "is-sub" not in c_root, c_root)
        between = re.findall(r'<a class="bk2-row', hv[e_root:i_var]) if i_var > 0 else ["x"]
        s.check("the variant's row comes right after the root's", i_var > i_root >= 0 and not between, between)
        s.check("its summary starts 'Variant · '", rail_row(hv, VV).find("Variant · ") > 0 and re.search(r"Not filled Variant · \d+ carry it", rail_row(hv, VV)) is not None, rail_row(hv, VV))
        s.check("the root's summary keeps its scope word", "Variant" not in rail_row(hv, VR) and re.search(r"(This unit|Group-wide) · 0 carry it", rail_row(hv, VR)) is not None, rail_row(hv, VR))
        s.check("a lone variant whose root is not saved sits under a heading for its root (1+, 2026-11-08)", c_orph is not None and "is-sub" in c_orph and "Variant · " in rail_row(hv, VO)
                and '<b>ZZBF Lonely</b></span><span class="bk2-sum">1 variant<' in hv, (c_orph, rail_row(hv, VO)))
        db.execute("DELETE FROM pm_bu_kpis WHERE id=?", (vroot,))
        db.commit()
        c_var2, _i3, _e3 = rail_a(get(GPM), VV)
        s.check("with the root not saved, the variant still sits under a heading for it (is-sub)", c_var2 is not None and "is-sub" in c_var2, c_var2)
    finally:
        db.execute("DELETE FROM pm_bu_kpis WHERE id IN (?,?,?)", (vroot, vvar, vorph))
        db.commit()

    # ------------------------------------------------------------ a heading over 2+ variants whose root is not saved
    s.section("2+ variants of an unsaved root sit under a heading for it (shared with BU KPI setup)")
    HR2, HA2, HB2 = "ZZBF Brand", "ZZBF Brand: North", "ZZBF Brand: South"
    h_a, h_b = mk_setup(HA2), mk_setup(HB2)
    vorph2 = mk_setup(VO)
    try:
        def rail_sec(h):
            sec = h[h.index("BU KPIs to fill"):]
            return sec[:sec.index("</section>")]
        hg = rail_sec(get(GPM))
        items = re.findall(r'<(a|div) class="(bk2-row[^"]*)"[^>]*>\s*<span class="bk2-rowh"><b>(.*?)</b>', hg)
        nms = [n_ for _t, _c, n_ in items]
        s.check("a heading for the unsaved root sits right before its two variants", HR2 in nms and nms[nms.index(HR2):nms.index(HR2) + 3] == [HR2, HA2, HB2], nms)
        t_, c_ = next(((t0, c0) for t0, c0, n0 in items if n0 == HR2), (None, None))
        s.check("...it is a div (not a link) with no Filled / Not filled pill, and reads '2 variants'",
                t_ == "div" and "bk2-head" in c_ and "2 variants" in hg.split(HR2, 1)[1][:160] and "pill" not in hg.split(HR2, 1)[1].split("</div>", 1)[0],
                (t_, c_, hg.split(HR2, 1)[1][:200]))
        s.check("...its variants are is-sub with 'Variant · ' first in their summary", all("is-sub" in c0 for _t0, c0, n0 in items if n0 in (HA2, HB2))
                and "Variant · " in rail_row(get(GPM), HA2) and "Variant · " in rail_row(get(GPM), HB2))
        s.check("a lone variant of an unsaved root sits under its heading (VO has one)", any(n0 == VO and "is-sub" in c0 and t0 == "a" for t0, c0, n0 in items) and "ZZBF Lonely" in nms)
        tops = [n_ for _t, c0, n_ in items if "is-sub" not in c0]
        s.check("the heading takes the position its root's name takes among the saved rows", [t.lower() for t in tops] == sorted(t.lower() for t in tops), tops)
        n_set = one("SELECT COUNT(DISTINCT kpi_name) FROM pm_bu_kpis WHERE cycle_id=? AND business_group=? AND company=?", (CID, BG, CO))
        s.check("the label counts the setups, never the heading", ("BU KPIs · %d" % n_set) in hg, (n_set, re.findall(r"BU KPIs · \d+", hg)))
        s.check("the page still opens on a setup (not the heading) when none is asked for", 'aria-current="true"' in hg and "bk2-head\" aria-current" not in hg)
        s.check("the heading is not a selectable link anywhere", 'kpi_name=%s"' % HR2.replace(" ", "+") not in hg)
    finally:
        db.execute("DELETE FROM pm_bu_kpis WHERE id IN (?,?,?)", (h_a, h_b, vorph2))
        db.commit()

    # ------------------------------------------------------------ queries
    s.section("one batched read however many lines")
    cnt = [0]
    orig = a.get_db

    def wrapped():
        d = orig()
        d.set_trace_callback(lambda q: cnt.__setitem__(0, cnt[0] + 1))
        return d
    a.get_db = wrapped
    try:
        get(REV)
        n8 = cnt[0]
        cnt[0] = 0
        for k in ("NF", "NG", "N7", "N8"):
            t_ = carrier(k, REV, SET[REV])
            db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, admin_filled, draft) VALUES (?,106,'Restated',?,1,0)", (t_, SU["id"]))
        db.commit()
        get(REV)
        n12 = cnt[0]
    finally:
        a.get_db = orig
    s.check("the page reads in the same number of queries with 12 lines as with 8", n8 == n12 and n8 > 0, (n8, n12))

    # ------------------------------------------------------------ source
    s.section("the card's source: buttons on one line, figures the size of the box")
    css = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
    tpl = open(os.path.join(H.REPO, "templates", "admin_performance_bu_fill.html"), encoding="utf-8").read()
    s.check("every button on the Fill BU KPI page is nowrap and flex: none", re.search(r"\.bf-grid \.bk2-btn \{[^}]*flex: none;[^}]*white-space: nowrap", css) is not None)
    s.check("Achievement and Score use the box's rem size and weight (1rem, 700), as the input and the locked box do",
            all(re.search(r"%s \{[^}]*font-size: 1rem; font-weight: 700" % re.escape(sel), css) for sel in (".bf-fig", ".bf-ro", ".bf-resin input")))
    s.check("the result row is a grid whose columns share rows (subgrid)", "grid-template-rows: subgrid" in css)
    s.check("the confirm words exist for the three edits", all(w in tpl for w in ("Change this KPI result?", "Change the note of ", " not filled yet?", "'Change ' + t", "'Fill ' + unf")))
    s.check("the Python names are defined once", all(len(re.findall(r"^def %s\(" % n, open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read(), re.M)) == 1
                                                  for n in ("_bu_fill_state", "_bu_fill_headline", "_bu_filled_any", "_bu_day", "_bu_fig", "gradeh_bu_filled_stats")))
finally:
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    else:
        os.environ["ONEHR_GRADEH"] = _ENV0
    db.close()
    cleanup()

sys.exit(s.done())
