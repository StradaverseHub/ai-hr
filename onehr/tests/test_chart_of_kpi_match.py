"""The Chart of KPI, piece B: Match lines (Chris, 2026-10-30, docs/chart-of-kpi.md; the canvas board 5).

What this suite holds:
  * dark unless ONEHR_COA=1: the route is a 404 (GET and POST) and writes nothing, no library tab says "Match lines", the Add
    panel takes no prefilled name; flag on, only the super admin (403 for a BG admin), and the access map says "super"
  * the population: every distinct uncoded line name of the usage cycle plus the active library names with no code, by
    (name, business group); a coded name is not listed; the tiles agree with the list; ONE batched read of the lines and one
    of the library names, however many rows
  * the suggestions, each rule and its tie-break: same dupe key; the root of "Root: q" or the line base has a code (the KPI,
    never a variant); the scope words taken out; word overlap of 0.6 (exactly 0.6 in, less out); a retired node, a group and a
    perspective are never suggested; no suggestion reads "No match"
  * Confirm: writes one name-map row (source match) and the line then reads as that code; "this group only" writes a
    group-scoped row and another group's same name stays uncoded; a retired, group, perspective or unknown node, a blank pick
    and a name that has a code already are refused and write nothing; one activity_log row per POST
  * Confirm all: only the pairs the page showed, a name coded meanwhile is skipped and counted, one activity_log row
  * the screen: tiles, pills, search, a scrolling list, the select named code_node preset to the suggestion, New KPI to the
    Add panel prefilled with the name, every form double-confirmed
"""
import json
import os
import re
import sys
from urllib.parse import urlencode

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The Chart of KPI, piece B: Match lines")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
A, B = "ZZMT Group A", "ZZMT Group B"
PREFIX = "ZZ9MT-"
URL = "/admin/performance/library/match"
LIBURL = "/admin/performance/library"
FLAG0 = os.environ.get("ONEHR_COA")

with a.app.app_context():
    _d = a.get_db()
    BASE_NODE = _d.execute("SELECT COALESCE(MAX(id), 0) FROM kpi_chart").fetchone()[0]
    BASE_NAME = _d.execute("SELECT COALESCE(MAX(id), 0) FROM kpi_chart_names").fetchone()[0]
    BASE_ACT = _d.execute("SELECT COALESCE(MAX(id), 0) FROM activity_log").fetchone()[0]
    BASE_ALIAS = _d.execute("SELECT COALESCE(MAX(id), 0) FROM pm_kpi_aliases").fetchone()[0]


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE ?", (PREFIX + "%",))]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM kpi_chart_names WHERE id > ?", (BASE_NAME,))
    db.execute("UPDATE kpi_chart SET parent_id=NULL WHERE id > ?", (BASE_NODE,))
    db.execute("DELETE FROM kpi_chart WHERE id > ?", (BASE_NODE,))
    db.execute("UPDATE kpi_chart SET was_codes=NULL, retired_at=NULL WHERE id <= ? AND level='persp'", (BASE_NODE,))
    db.execute("DELETE FROM activity_log WHERE id > ? AND action IN ('pm_kpi_chart', 'pm_kpi_library')", (BASE_ACT,))
    db.execute("DELETE FROM pm_kpi_aliases WHERE id > ? AND business_group IN (?,?)", (BASE_ALIAS, A, B))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group IN (?,?)", (A, B))
    db.execute("DELETE FROM pm_bg_config WHERE business_group IN (?,?)", (A, B))
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (A, B))
    db.commit()


def q1(sql, args=()):
    with a.app.app_context():
        return a.get_db().execute(sql, args).fetchone()


def qa(sql, args=()):
    with a.app.app_context():
        return [dict(r) for r in a.get_db().execute(sql, args).fetchall()]


def names_n():
    return q1("SELECT COUNT(*) FROM kpi_chart_names")[0]


def acts():
    return qa("SELECT detail FROM activity_log WHERE id > ? AND action='pm_kpi_chart' ORDER BY id", (BASE_ACT,))


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'U1'),(?, 'U9')", (A, B))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A'),(?, 'A')", (A, B))
    U = {}
    for n_, bg, co in ((1, A, "U1"), (2, A, "U1"), (3, B, "U9"), (4, B, "U9")):
        eid = PREFIX + str(n_)
        U[n_] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                           "department, job_grade, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?, 'ZZMT Dept', '14', "
                           "'2020-01-01')", (eid.lower(), "ZZ MT " + str(n_), eid, bg, co)).lastrowid

    def lib(name, bg, active=1):
        return db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, "
                          "description, unit, method, rate1, rate2, rate3, rate4, rate5, bu_level, active, perspective) "
                          "VALUES (?, '*', '*', 0, '*', ?, NULL, ?, 'RM', 'more', 1, 2, 3, 4, 5, 0, ?, 'Financial')",
                          (bg, name, "Defines " + name, active)).lastrowid

    def holds(name, *ns, focus=None):
        for n_ in ns:
            db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, focus, weightage, method, rate1, rate2, rate3, "
                       "rate4, rate5, business_group, company, description) SELECT ?, id, ?, ?, 10, 'more', 1,2,3,4,5, "
                       "business_group, company, 'own words' FROM users WHERE id=?", (CID, name, focus, U[n_]))
    P = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM kpi_chart WHERE level='persp'")}
    G, c_g = a._chart_add_node(db, "group", P["1"], "ZZMT Profitability", SU["id"])
    G2, c_g2 = a._chart_add_node(db, "group", P["1"], "ZZMT Cash", SU["id"])

    def kpi(name, bg="", group=G):
        nid, code = a._chart_add_node(db, "kpi", group, name, SU["id"])
        a._chart_map_name(db, nid, name, bg, "seed", SU["id"])
        return nid, code
    K_GP, c_gp = kpi("ZZMT Gross profit (GP)")
    K_COL, c_col = kpi("ZZMT Collections")
    V_COLX, c_colx = (lambda r: r)(a._chart_add_node(db, "variant", K_COL, "ZZMT Collections: Export", SU["id"], qualifier="Export"))
    a._chart_map_name(db, V_COLX, "ZZMT Collections: Export", "", "variant", SU["id"])
    K_DAYS, c_days = kpi("ZZMT Debtor days")
    K_OCT, c_oct = kpi("ZZMT Order cycle time days")
    K_T1, c_t1 = kpi("ZZMT Churn rate")
    K_T2, c_t2 = kpi("ZZMT Churn ratio")
    K_LO, c_lo = kpi("ZZMT Lead time days extra more")      # the lower code, the lower score
    K_HI, c_hi = kpi("ZZMT Lead time days extra")           # the higher code, the higher score
    K_BILL, c_bill = kpi("ZZMT Billing", bg=A)               # coded in group A's map only
    K_YIELD, c_yield = kpi("ZZMT Yield", bg=A)
    K_TEMPO, c_tempo = kpi("ZZMT Tempo")
    V_SLOW, c_slow = a._chart_add_node(db, "variant", K_TEMPO, "ZZMT Tempo: Slow", SU["id"], qualifier="Slow")
    a._chart_map_name(db, V_SLOW, "ZZMT Tempo slow", A, "variant", SU["id"])   # a variant known by a spelling of its own, in group A only
    V_KILN, c_kiln = a._chart_add_node(db, "variant", K_YIELD, "ZZMT Yield: Kiln", SU["id"], qualifier="Kiln")
    a._chart_map_name(db, V_KILN, "ZZMT Yield: Kiln", A, "variant", SU["id"])
    K_SAME, c_same = kpi("ZZMT Own spelling", bg=A)
    K_RET, c_ret = kpi("ZZMT Retired measure")
    db.execute("UPDATE kpi_chart SET retired_at=datetime('now') WHERE id=?", (K_RET,))
    # lines (one per person per name); group A holds U1, U2 and group B U3, U4
    holds("ZZMT gross profit", 1, 2)                         # (a) the same KPI, written differently
    holds("ZZMT Own spelling", 3)                            # (a) the same name, coded in group A's map only
    holds("ZZMT Billing: Retail", 3, 4)                      # (b) its root has a code (in group A's map; group B reads none)
    holds("ZZMT Yield: Kiln · Q3", 4, focus="Q3")       # (b) the line's base is a variant: the KPI is suggested
    holds("ZZMT Tempo slow \u00b7 Q3", 4, focus="Q3")        # (b) only the variant is found, by the line's base: still the KPI
    holds("ZZMT Plant collections", 1)                       # (c) a scope word
    holds("ZZMT Debtor days outstanding", 2)                 # (d) 75%
    holds("ZZMT Order cycle", 1)                             # (d) exactly 60%
    holds("ZZMT Order cycle weeks", 1)                       # 50%: no
    holds("ZZMT Churn", 1)                                   # (d) a tie on score: the lower code
    holds("ZZMT Lead time days", 1)                          # (d) the higher score beats the lower code
    holds("ZZMT Retired measure value", 1)                   # a retired node is never suggested
    holds("ZZMT Profitability", 2)                           # a group's name is not a code to give
    holds("ZZMT Showroom footfall", 1, 3)                    # no match
    holds("ZZMT Collections", 1)                             # coded: not listed
    holds("ZZMT Shared name", 1, 3)                          # uncoded in both groups; matched to one group only
    holds("ZZMT Held by override", 2)
    lib("ZZMT Library only", A)                              # an active library name nobody holds yet
    lib("ZZMT Collections", A)                               # coded: not listed
    lib("ZZMT Old library name", A, active=0)                # retired in the library: not listed
    db.commit()

SUP = H.client_as(a, SU["id"])
BGC = H.client_as(a, BGA["id"]) if BGA else None


def post(client, data, url=URL):
    d = dict(data)
    d["csrf_token"] = "tok"
    return client.post(url, data=d)


def flashes(r):
    return " ".join(re.findall(r'class="flash[^"]*"[^>]*>(.*?)<', r.get_data(as_text=True), re.S))


def page(**args):
    return SUP.get(URL + ("?" + urlencode(args) if args else "")).get_data(as_text=True)


def rows(q="ZZMT", kind=""):
    with a.app.app_context():
        return a._chart_match_rows(a.get_db(), q, kind)


def by_name(name, bg, q="ZZMT"):
    return next((r for r in rows(q)["rows"] if r["name"] == name and r["bg"] == bg), None)


def sg(name, bg):
    r = by_name(name, bg)
    return r["sugg"] if r else "ABSENT"


def coded_as(name, bg, focus=None):
    with a.app.app_context():
        db_ = a.get_db()
        n = a.chart_node_of_line(a._chart_index(db_), {"kpi_name": name, "business_group": bg, "focus": focus or ""}, a._chart_aliases(db_))
        return n["code"] if n else None


try:
    # ---------------------------------------------------------------------------------------------------------------
    s.section("dark unless ONEHR_COA=1; super admin only")
    os.environ.pop("ONEHR_COA", None)
    lib_off = SUP.get(LIBURL + "?panel=add&addbg=%s&kpi_name=ZZMT+Prefill" % A.replace(" ", "+")).get_data(as_text=True)
    merges_off = SUP.get(LIBURL + "/merges").get_data(as_text=True)
    n0 = names_n()
    s.check("flag off: the route is a 404 for the super admin, GET and POST, and writes nothing",
            SUP.get(URL).status_code == 404 and post(SUP, {"action": "confirm_all", "pair": json.dumps([K_GP, A, "x"])}).status_code == 404
            and post(SUP, {"action": "confirm"}).status_code == 404 and names_n() == n0)
    s.check("flag off: no library page says Match lines, and the Add panel takes no prefilled name",
            "Match lines" not in lib_off and "Match lines" not in merges_off and "ZZMT Prefill" not in lib_off
            and 'data-panel-params="addbg"' in lib_off)
    if BGC:
        s.check("flag off: a BG admin gets a 404 too", BGC.get(URL).status_code == 404)

    os.environ["ONEHR_COA"] = "1"
    s.check("flag on: the super admin opens it", SUP.get(URL).status_code == 200)
    if BGC:
        s.check("a BG admin cannot (403), GET or POST, and writes nothing",
                BGC.get(URL).status_code == 403 and post(BGC, {"action": "confirm_all"}).status_code == 403 and names_n() == n0)
    s.check("a signed-out visitor does not get the page", a.app.test_client().get(URL).status_code in (301, 302, 303, 401, 403))
    s.check("the access map says super and the page is in the menu under the library",
            a.ADMIN_ACCESS_MAP.get("admin_kpi_chart_match") == "super"
            and '_pg("admin_kpi_chart_match", "Match lines", hidden=True, under="admin_kpi_library")' in H.source(a))
    s.check("flag on: the library tabs show Match lines (library, merge queue, requests)",
            all("Match lines" in SUP.get(u).get_data(as_text=True) for u in (LIBURL, LIBURL + "/merges", "/admin/performance/library/requests")
                if SUP.get(u).status_code == 200))
    s.check("an unknown action is a 400", post(SUP, {"action": "nope"}).status_code == 400)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the population")
    d = rows("")
    names = {(r["name"], r["bg"]) for r in d["rows"]}
    s.check("an uncoded line name is listed once per business group with its lines",
            ("ZZMT Shared name", A) in names and ("ZZMT Shared name", B) in names and by_name("ZZMT Shared name", A)["lines"] == 1
            and by_name("ZZMT gross profit", A)["lines"] == 2 and by_name("ZZMT Showroom footfall", A)["lines"] == 1
            and by_name("ZZMT Showroom footfall", B)["lines"] == 1)
    s.check("a coded name (its line and its library row) is not listed", ("ZZMT Collections", A) not in names and ("ZZMT Collections", B) not in names)
    s.check("an active library name with no code is listed with no lines; a retired library row is not",
            by_name("ZZMT Library only", A) and by_name("ZZMT Library only", A)["lines"] == 0 and by_name("ZZMT Library only", A)["in_lib"]
            and ("ZZMT Old library name", A) not in names)
    s.check("a name another line already holds is the same row, spelling as first written",
            len([r for r in d["rows"] if r["key"] == "zzmt showroom footfall"]) == 2)
    # a line's own override counts as coded
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE pm_kpi_targets SET chart_node_id=? WHERE cycle_id=? AND kpi_name='ZZMT Held by override'", (K_DAYS, CID))
        db.commit()
    s.check("a line with its own override is coded, so its name is not listed", ("ZZMT Held by override", A) not in {(r["name"], r["bg"]) for r in rows("")["rows"]})
    # the tiles agree with the list
    d = rows("")
    with a.app.app_context():
        db = a.get_db()
        idx_, al_ = a._chart_index(db), a._chart_aliases(db)
        cyc_ = a._kpi_usage_cycle(db)
        lns = [dict(r) for r in db.execute("SELECT kpi_name, COALESCE(focus,'') AS focus, chart_node_id, (SELECT business_group FROM users u "
                                           "WHERE u.id=t.subject_id) AS business_group FROM pm_kpi_targets t WHERE cycle_id=?", (cyc_["id"],))]
        has = [n is not None for n in a.chart_nodes_of_lines(db, lns, idx_, al_)]
    s.check("the tiles: lines with a code + without = every line of the usage cycle, and they match a direct count",
            d["coded"] == sum(has) and d["uncoded"] == len(has) - sum(has) and d["coded"] + d["uncoded"] == len(lns))
    s.check("...the uncoded lines are exactly the lines of the listed names", d["uncoded"] == sum(r["lines"] for r in d["rows"]))
    s.check("...names with a suggestion + no match = names listed; the pills carry the same counts",
            d["t_sugg"] + d["t_none"] == d["n_names"] == len(d["rows"]) and d["n_all"] == d["n_names"] and d["n_sugg"] == d["t_sugg"]
            and d["n_none"] == d["t_none"] and len(rows("", "sugg")["rows"]) == d["n_sugg"] and len(rows("", "none")["rows"]) == d["n_none"])
    html = page()
    tiles = re.findall(r'class="ri-tile"[^>]*><b>(\d+)</b><span>([^<]*)</span>', html)
    s.check("...and the page's four tiles say them", [int(t[0]) for t in tiles] == [d["coded"], d["uncoded"], d["t_sugg"], d["t_none"]]
            and "lines with a code" in tiles[0][1] and "lines without" in tiles[1][1], tiles)
    s.check("...the tab counts the names", "Match lines &middot; %d" % d["n_names"] in html)
    calls = {"idx": 0, "nodes": 0}
    o_idx, o_nodes = a._chart_index, a.chart_nodes_of_lines

    def c_idx(*aa, **kk):
        calls["idx"] += 1
        return o_idx(*aa, **kk)

    def c_nodes(*aa, **kk):
        calls["nodes"] += 1
        return o_nodes(*aa, **kk)
    a._chart_index, a.chart_nodes_of_lines = c_idx, c_nodes
    try:
        page()
    finally:
        a._chart_index, a.chart_nodes_of_lines = o_idx, o_nodes
    s.check("one batched read of the lines and one of the library names, the chart read once (not per row)",
            calls == {"idx": 1, "nodes": 2}, calls)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the suggestions, each rule")
    r_ = sg("ZZMT gross profit", A)
    s.check("(a) the same dupe key as a coded name: that code, 'Same KPI, written differently'",
            r_["node"]["id"] == K_GP and r_["reason"] == "Same KPI, written differently", r_)
    r_ = sg("ZZMT Own spelling", B)
    s.check("(a) the very name coded only in another group's map: that code, 'coded in another group'",
            r_["node"]["id"] == K_SAME and r_["reason"] == "Same name, coded in another group", r_)
    r_ = sg("ZZMT Billing: Retail", B)
    s.check("(b) its root has a code (here in another group's map): the KPI code, 'Its root KPI has a code'",
            r_["node"]["id"] == K_BILL and r_["reason"] == "Its root KPI has a code", r_)
    s.check("...and group A, whose map holds the root, reads it already, so the name is not listed there", by_name("ZZMT Billing: Retail", A) is None)
    r_ = sg("ZZMT Yield: Kiln · Q3", B)
    s.check("(b) the line base is a variant's name: the suggestion is the KPI, never the variant",
            r_["node"]["id"] == K_YIELD and r_["node"]["level"] == "kpi" and r_["reason"] == "Its root KPI has a code", r_)
    r_ = sg("ZZMT Tempo slow \u00b7 Q3", B)
    s.check("(b) ONLY a variant is found (by the line's base): the suggestion is its KPI, not the variant",
            r_ and r_["node"]["id"] == K_TEMPO and r_["node"]["level"] == "kpi" and r_["reason"] == "Its root KPI has a code", r_)
    s.check("(b) no suggestion is ever a variant", all(r["sugg"]["node"]["level"] == "kpi" for r in rows("ZZMT")["rows"]
                                                       if r["sugg"] and r["sugg"]["rule"] == "root"))
    r_ = sg("ZZMT Plant collections", A)
    s.check("(c) scope words taken out equal a coded name: 'Same measure, with a scope word'",
            r_["node"]["id"] == K_COL and r_["reason"] == "Same measure, with a scope word", r_)
    r_ = sg("ZZMT Debtor days outstanding", A)
    s.check("(d) word overlap: 'Similar words (75%)'", r_["node"]["id"] == K_DAYS and r_["reason"] == "Similar words (75%)", r_)
    r_ = sg("ZZMT Order cycle", A)
    s.check("(d) exactly 0.6 is in ('Similar words (60%)')", r_["node"]["id"] == K_OCT and r_["reason"] == "Similar words (60%)", r_)
    s.check("(d) 0.5 is out: 'No match'", sg("ZZMT Order cycle weeks", A) is None)
    r_ = sg("ZZMT Churn", A)
    s.check("(d) a tie on score takes the lower code", r_["node"]["id"] == K_T1 and c_t1 < c_t2 and r_["reason"] == "Similar words (67%)",
            (r_["node"]["code"], c_t1, c_t2, r_["reason"]))
    r_ = sg("ZZMT Lead time days", A)
    s.check("(d) the higher score beats the lower code (the lower-coded node scores 67%, the higher-coded 80%)",
            c_lo < c_hi and r_["node"]["id"] == K_HI and r_["reason"] == "Similar words (80%)", r_)
    s.check("a retired node is never suggested", sg("ZZMT Retired measure value", A) is None)
    s.check("a KPI group's name is not a code to give (only KPI and variant nodes are matched)", sg("ZZMT Profitability", A) is None)
    s.check("no suggestion: 'No match' on the page", sg("ZZMT Showroom footfall", A) is None
            and "No KPI in the chart reads like it" in page(q="showroom") and "No match &middot;" in page(q="showroom"))
    s.check("the same data gives the same suggestions twice (deterministic)",
            [(r["name"], r["bg"], r["sugg"] and r["sugg"]["node"]["id"]) for r in rows("")["rows"]]
            == [(r["name"], r["bg"], r["sugg"] and r["sugg"]["node"]["id"]) for r in rows("")["rows"]])
    t = a._chart_match_tokens
    s.check("tokens: lowercase, one-letter and little words dropped", t("The Cost of a Unit by Q") == frozenset({"cost", "unit"}), t("The Cost of a Unit by Q"))
    s.check("scope words come out as whole words ('business unit' before 'unit'; 'unitary' stays)",
            a._chart_scope_free("Business unit gross profit (GP)") == "gross profit" and a._chart_scope_free("Unitary cost") == "unitary cost")

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the screen")
    html = page(q="zzmt")
    d = rows("zzmt")
    s.check("a row: the name as written, its group, N lines, the preset code and the reason in words",
            'class="pp-chip">ZZMT gross profit<' in html and "ZZMT Group A" in html and "2 lines" in html and "Same KPI, written differently" in html
            and ("%s ZZMT Gross profit (GP)</option>" % c_gp) in html)
    s.check("the select is named code_node and presets the suggestion; a name with no match starts on 'Pick a code'",
            re.search(r'name="code_node"[^>]*>\s*<option value="%d" selected>%s ZZMT Gross profit \(GP\)</option>' % (K_GP, c_gp), html) is not None
            and re.search(r'name="code_node"[^>]*>\s*<option value="" selected>Pick a code', html) is not None)
    tpl = re.search(r'<template id="coa-m-opts">(.*?)</template>', html, re.S).group(1)
    opt_ids = [int(x) for x in re.findall(r'<option value="(\d+)"', tpl)]
    with a.app.app_context():
        want = sorted(n["id"] for n in a._chart_index(a.get_db())["nodes"].values() if n["level"] in ("kpi", "variant") and not n["retired_at"])
    s.check("the codes are listed once, as 'code name': every KPI and variant in use, no group, perspective or retired node",
            sorted(opt_ids) == want and K_RET not in opt_ids and G not in opt_ids and P["1"] not in opt_ids
            and ">%s ZZMT Collections: Export</option>" % c_colx in tpl, (len(opt_ids), len(want)))
    s.check("This group only is a checkbox named scope_bg, and a row has Confirm and New KPI",
            'name="scope_bg"' in html and "This group only" in html and ">Confirm</button>" in html and ">New KPI</a>" in html)
    newk = re.search(r'href="([^"]*)">New KPI</a>', html).group(1).replace("&amp;", "&")
    s.check("New KPI opens Add a KPI with the business group and the name (and only the name)",
            newk.startswith(LIBURL + "?") and "panel=add" in newk and "addbg=" in newk and "kpi_name=" in newk and newk.count("=") == 3, newk)
    lp = SUP.get(newk).get_data(as_text=True)
    s.check("...the Add panel's KPI name is filled in, and closing it drops the parameter",
            re.search(r'name="kpi_name" required value="ZZMT [^"]*"', lp) is not None and 'data-panel-params="addbg kpi_name"' in lp)
    tag = SUP.get(LIBURL + "?panel=add&addbg=%s&kpi_name=%%3Cb%%3Ex" % A.replace(" ", "+")).get_data(as_text=True)
    s.check("...a tag in the name is escaped, never run", "<b>x" not in tag and 'value="&lt;b&gt;x"' in tag)
    forms = re.findall(r"<form\b[^>]*?>", html, flags=re.S)
    posts = [f for f in forms if 'method="post"' in f and 'class="logout-form"' not in f]   # the sign-out menu is app chrome
    s.check("every POST form asks first (data-confirm, a title and a button word)",
            posts and all("data-confirm=" in f and "data-confirm-title=" in f and "data-confirm-ok=" in f for f in posts), len(posts))
    s.check("the search is marked as a list of names, not people (data-no-qin) and keeps the pill",
            'data-no-qin="KPI names, not people"' in html and "q=zzmt" in html)
    s.check("pills All | A suggestion | No match, each linking with the search",
            all(x in html for x in ("All<span>", "A suggestion<span>", "No match<span>")) and "kind=sugg" in html and "kind=none" in html)
    css = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
    s.check("the list scrolls inside its card and the select follows the design (36px, 14px, 340 wide: the longest variant name fits)",
            re.search(r"\.coa-m-list \{[^}]*max-height: 760px; overflow-y: auto", css) is not None
            and ".coa-m .mq-to select { width: 340px; max-width: 100%; min-height: 36px; font-size: 0.875rem; line-height: 1.3; padding-top: 0; padding-bottom: 0; }" in css)
    allf = re.search(r'<form method="post"[^>]*class="coa-m-all"[^>]*>', html, re.S).group(0)
    s.check("Confirm all N suggestions names the count and the lines, and is double-confirmed",
            "Confirm all %d suggestion" % sum(1 for r in d["rows"] if r["sugg"]) in html and "data-confirm-title=\"Confirm all" in allf
            and ("Give %d name" % sum(1 for r in d["rows"] if r["sugg"])) in allf)
    sk = page(q="zzmt", kind="sugg")
    s.check("the A suggestion pill lists only names with one, No match only the others, and Confirm all follows the filter",
            "No match &middot;" not in sk.split('aria-label="Names to match"')[1] and "Suggested &middot;" in sk
            and "Confirm all" in sk
            and "No match &middot;" in page(q="zzmt", kind="none").split('aria-label="Names to match"')[1]
            and "Confirm all" not in page(q="zzmt", kind="none").split('aria-label="Names to match"')[0].split("ri-tiles")[1].split("coa-bar")[1])
    s.check("a search narrows the list and the pill counts, not the tiles",
            len(rows("showroom")["rows"]) == 2 and 'class="adm-frow-pill is-on" href="%s">All<span>2<' % (URL + "?q=showroom") in page(q="showroom"))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("Confirm")
    n0, a0 = names_n(), len(acts())
    r0 = by_name("ZZMT gross profit", A)

    def conf(name, key, bg, node, extra=None, **kw):
        d_ = {"action": "confirm", "key": key, "bg": bg, "code_node": str(node)}
        d_.update(extra or {})
        return post(SUP, d_)
    for label, node_id in (("a retired node", K_RET), ("a KPI group", G), ("a perspective", P["1"]), ("an unknown id", 999999),
                           ("nothing picked", ""), ("text", "abc")):
        r = conf("x", "zzmt gross profit", A, node_id)
        s.check("%s is refused, nothing written" % label, r.status_code in (302, 303) and names_n() == n0 and len(acts()) == a0)
    s.check("a name that is not on the list (already coded, or made up) is refused",
            names_n() == n0 and "no longer on the list" in flashes(SUP.get(conf("x", "zzmt collections", A, K_COL).headers["Location"])))
    r = conf("x", "zzmt gross profit", A, K_GP)
    row = q1("SELECT * FROM kpi_chart_names WHERE name_key='zzmt gross profit'")
    s.check("Confirm writes one name-map row: group-wide, source match, the name as written",
            row is not None and row["node_id"] == K_GP and row["business_group"] == "" and row["source"] == "match"
            and row["name_shown"] == "ZZMT gross profit" and names_n() == n0 + 1)
    s.check("...and the lines then read as that code, in both groups", coded_as("ZZMT gross profit", A) == c_gp and coded_as("ZZMT gross profit", B) == c_gp)
    s.check("...the name left the list; no line was touched (names, targets, override)",
            by_name("ZZMT gross profit", A) is None
            and qa("SELECT COUNT(*) n FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name='ZZMT gross profit' AND chart_node_id IS NULL AND weightage=10", (CID,))[0]["n"] == 2)
    ac = acts()[a0:]
    s.check("one activity_log row, with the counts, and the page says what was done",
            len(ac) == 1 and "1 name (2 lines)" in ac[0]["detail"] and c_gp in ac[0]["detail"] and "2 lines coded" in flashes(SUP.get(r.headers["Location"])), ac)
    r = conf("x", "zzmt gross profit", A, K_GP)
    s.check("confirming it again says it has a code and writes nothing more", names_n() == n0 + 1 and len(acts()) == a0 + 1)
    # this group only
    a1 = len(acts())
    s.check("before: the shared name is uncoded in both groups", coded_as("ZZMT Shared name", A) is None and coded_as("ZZMT Shared name", B) is None)
    conf("x", "zzmt shared name", A, K_DAYS, {"scope_bg": "1"})
    row = q1("SELECT * FROM kpi_chart_names WHERE name_key='zzmt shared name'")
    s.check("'this group only' writes a row scoped to that group", row is not None and row["business_group"] == A and row["node_id"] == K_DAYS)
    s.check("...the group reads the code and the other group's same name stays uncoded and listed",
            coded_as("ZZMT Shared name", A) == c_days and coded_as("ZZMT Shared name", B) is None
            and by_name("ZZMT Shared name", B) is not None and by_name("ZZMT Shared name", A) is None)
    s.check("...one trail row saying so", len(acts()) == a1 + 1 and "(%s only)" % A in acts()[-1]["detail"])
    conf("x", "zzmt shared name", B, K_GP)
    row = q1("SELECT * FROM kpi_chart_names WHERE name_key='zzmt shared name' AND business_group=''")
    s.check("the other group then takes a group-wide code of its own, and group A keeps its scoped one",
            row is not None and row["node_id"] == K_GP and coded_as("ZZMT Shared name", B) == c_gp and coded_as("ZZMT Shared name", A) == c_days)
    # a variant can be picked by hand
    conf("x", "zzmt showroom footfall", B, V_COLX)
    s.check("a variant can be picked by hand: the group-wide row names it", coded_as("ZZMT Showroom footfall", A) == c_colx and coded_as("ZZMT Showroom footfall", B) == c_colx)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("Confirm all")
    html = page(q="zzmt")
    pairs = re.findall(r'name="pair" value="([^"]*)"', html)
    pairs = [p.replace("&#34;", '"').replace("&quot;", '"') for p in pairs]
    shown = [r for r in rows("zzmt")["rows"] if r["sugg"]]
    s.check("the form carries exactly the suggested pairs shown (node, group, name key)",
            sorted(pairs) == sorted(r["pair"] for r in shown) and len(pairs) == len(shown) and all(json.loads(p)[0] for p in pairs), (len(pairs), len(shown)))
    # one of them gets a code meanwhile (another admin, another tab)
    meanwhile = next(r for r in shown if r["name"] == "ZZMT Plant collections")
    conf("x", meanwhile["key"], meanwhile["bg"], K_COL, {"scope_bg": "1"})   # group-only, so a group-wide write would still be possible
    n0, a0 = names_n(), len(acts())
    expect_lines = sum(r["lines"] for r in shown if r["key"] != meanwhile["key"])
    r = post(SUP, {"action": "confirm_all", "pair": pairs, "q": "zzmt"})
    msg = flashes(SUP.get(r.headers["Location"]))
    done = [x for x in shown if x["key"] != meanwhile["key"]]
    keys_done = {x["key"] for x in done}
    s.check("Confirm all codes every suggested name still uncoded; the one coded meanwhile is skipped and counted",
            names_n() == n0 + len(keys_done) and "1 skipped" in msg, (names_n() - n0, len(keys_done), msg))
    s.check("...and it was not written again group-wide", q1("SELECT COUNT(*) FROM kpi_chart_names WHERE name_key=? AND business_group=''", (meanwhile["key"],))[0] == 0)
    s.check("...each took the suggested code, group-wide, source match",
            all(q1("SELECT node_id, business_group, source FROM kpi_chart_names WHERE name_key=? AND business_group=''", (x["key"],))["node_id"] == x["sugg"]["node"]["id"]
                and q1("SELECT source FROM kpi_chart_names WHERE name_key=?", (x["key"],))["source"] == "match" for x in done))
    s.check("...and the message counts the names and lines it did",
            "Coded %d name" % sum(1 for x in done) in msg and "(%d line" % expect_lines in msg, msg)
    ac = acts()[a0:]
    s.check("one activity_log row, with the counts", len(ac) == 1 and "matched %d name" % len(done) in ac[0]["detail"] and "all suggestions" in ac[0]["detail"], ac)
    left = [r for r in rows("zzmt")["rows"] if r["sugg"]]
    s.check("what is left with a suggestion is only what the new codes made possible: 'Order cycle weeks' now reads like the 'Order cycle' just coded (75%)",
            [(r["name"], r["sugg"]["reason"]) for r in left] == [("ZZMT Order cycle weeks", "Similar words (75%)")], [(r["name"], r["sugg"]["reason"]) for r in left])
    n0 = names_n()
    r = post(SUP, {"action": "confirm_all", "pair": [json.dumps([K_RET, A, "zzmt order cycle weeks"]), json.dumps([G, A, "zzmt order cycle weeks"]),
                                                     json.dumps([P["1"], B, "zzmt library only"]), "not json", json.dumps([1]), json.dumps([K_GP, [], {}]),
                                                     json.dumps([K_GP, A, "no such name"])]})
    s.check("a retired, group or perspective node, a made-up name and bad data are skipped, nothing written", names_n() == n0 and "0 name" in flashes(SUP.get(r.headers["Location"])))
    s.check("a post with no pairs writes nothing and says so", post(SUP, {"action": "confirm_all"}).status_code in (302, 303) and names_n() == n0)
    # a group-wide name shown for two groups, both suggested the same: coded once, both rows counted
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM kpi_chart_names WHERE id > ?", (BASE_NAME,))
        db.commit()
    with a.app.app_context():
        db = a.get_db()
        for nm_, id_ in (("ZZMT Collections", K_COL), ("ZZMT Gross profit (GP)", K_GP), ("ZZMT Debtor days", K_DAYS), ("ZZMT Order cycle time days", K_OCT)):
            a._chart_map_name(db, id_, nm_, "", "seed", SU["id"])
        db.commit()
    both = [r for r in rows("zzmt")["rows"] if r["key"] == "zzmt showroom footfall"]
    s.check("a name held in two groups is two rows with the same suggestion state", len(both) == 2)
    pr = [json.dumps([K_DAYS, r["bg"], r["key"]]) for r in both]
    r = post(SUP, {"action": "confirm_all", "pair": pr})
    s.check("...a group-wide confirm all codes both rows from the first pair and the second is not reported as skipped",
            "Coded 2 name" in flashes(SUP.get(r.headers["Location"])) and "skipped" not in flashes(SUP.get(r.headers["Location"])) and by_name("ZZMT Showroom footfall", B) is None)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the standards")
    tpl_src = open(os.path.join(H.REPO, "templates", "admin_kpi_chart_match.html"), encoding="utf-8").read()
    s.check("no confirm() or alert() in the page", "confirm(" not in tpl_src.replace("data-confirm", "") and "alert(" not in tpl_src)
    s.check("no free-text field but the search: the code is picked from a select",
            len(re.findall(r'<input type="(?:text|number)"', tpl_src)) == 0)
    src = H.source(a)
    s.check("the route is flag-first then super, and no per-row query in the population",
            re.search(r"def admin_kpi_chart_match\(\):.*?if not coa_on\(\):\s+abort\(404\).*?if not is_super\(me\):\s+abort\(403\)", src, re.S) is not None)
finally:
    if FLAG0 is None:
        os.environ.pop("ONEHR_COA", None)
    else:
        os.environ["ONEHR_COA"] = FLAG0
    with a.app.app_context():
        _db = a.get_db()
        _cleanup(_db)
        left = (_db.execute("SELECT COUNT(*) FROM kpi_chart WHERE id > ?", (BASE_NODE,)).fetchone()[0]
                + _db.execute("SELECT COUNT(*) FROM kpi_chart_names WHERE id > ?", (BASE_NAME,)).fetchone()[0]
                + _db.execute("SELECT COUNT(*) FROM users WHERE employee_id LIKE ?", (PREFIX + "%",)).fetchone()[0])
    s.check("everything the suite made was put back", left == 0, left)

sys.exit(s.done())
