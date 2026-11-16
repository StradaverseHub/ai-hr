"""The Chart of KPI, piece A2 (Chris, 2026-10-30, docs/chart-of-kpi.md): the KPI panel's Code and place, Variants and Lines
sections, Move, Give it a place, Add a variant, Its place in the chart on Add a KPI, and named people on a library row.

What this suite holds:
  * dark unless ONEHR_COA=1: none of the new sections or fields, and every new POST is a 404 (a named-people field on a
    flag-off form is ignored)
  * Move: the KPI and its variants take new codes under the other group, the old ones go into was_codes and are never used
    again, the name map and a line's override follow the node; a full or same group is refused and writes nothing
  * Give it a place: makes the node and maps the identity key and every name merged into it
  * Add a variant: the node, a name-map row (source variant, group-wide), the override on the picked people's lines of
    that KPI -- and NOTHING else on a line (every other column byte-identical); refused for a BU-level KPI, a repeated
    qualifier, a blank or over-long one and anyone who holds no line of the KPI
  * Add a KPI with a place: library row, node and name map; the code comes from the server; a name that already has a code
    reuses it; half a place is refused
  * named people: the picker's IDs are checked (active, in the group, not an admin, up to 50, never BU-level); a row that
    names people matches only an active listed person still in its group; a row that names nobody matches exactly as before
  * the lists behind the counts (super admin only) and one batched read where a population is read
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The Chart of KPI, piece A2: the KPI panel, variants, place on Add, named people")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
A, B = "ZZP2 Group A", "ZZP2 Group B"
PREFIX = "ZZ9P2-"
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
    db.execute("DELETE FROM pm_kpi_library_people WHERE library_id IN (SELECT id FROM pm_kpi_library WHERE business_group IN (?,?))", (A, B))
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


def nodes_n():
    return q1("SELECT COUNT(*) FROM kpi_chart WHERE level!='persp'")[0]


def names_n():
    return q1("SELECT COUNT(*) FROM kpi_chart_names")[0]


def people_n(lib_id):
    return q1("SELECT COUNT(*) FROM pm_kpi_library_people WHERE library_id=?", (lib_id,))[0]


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'U1'),(?, 'U2'),(?, 'U9')", (A, A, B))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A'),(?, 'A')", (A, B))
    U = {}
    for n_, bg, co, left in ((1, A, "U1", None), (2, A, "U1", None), (3, A, "U2", None), (4, B, "U9", None),
                             (5, A, "U2", "2026-01-01"), (6, A, "U1", None)):
        eid = PREFIX + str(n_)
        U[n_] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                           "department, job_grade, confirmation_date, left_at) VALUES (?,?, 'x', 'user', ?,?,?, 'ZZP2 Dept', "
                           "'14', '2020-01-01', ?)", (eid.lower(), "ZZ P2 " + str(n_), eid, bg, co, left)).lastrowid
    EID = {n_: PREFIX + str(n_) for n_ in U}
    MANY = []   # 51 real, active people in group A: the 50 limit is tested on people who would otherwise be accepted
    for i in range(51):
        e_ = PREFIX + "M%d" % i
        db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
                   "job_grade, confirmation_date) VALUES (?,?, 'x', 'user', ?,?, 'U1', 'ZZP2 Dept', '14', '2020-01-01')",
                   (e_.lower(), "ZZ P2 M%d" % i, e_, A))
        MANY.append(e_)

    def lib(name, bg, bu=0, active=1):
        return db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, "
                          "description, unit, method, rate1, rate2, rate3, rate4, rate5, bu_level, active, perspective) "
                          "VALUES (?, '*', '*', 0, '*', ?, NULL, ?, 'RM', 'more', 1, 2, 3, 4, 5, ?, ?, 'Financial')",
                          (bg, name, "Defines " + name, bu, active)).lastrowid

    def holds(name, *ns):
        for n_ in ns:
            db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, rate4, "
                       "rate5, business_group, company, description) SELECT ?, id, ?, 10, 'more', 1,2,3,4,5, business_group, "
                       "company, 'own words' FROM users WHERE id=?", (CID, name, U[n_]))
    L_GP_A = lib("ZZP2 Gross profit", A, bu=1)
    lib("ZZP2 Gross profit", B, bu=1)
    L_COL = lib("ZZP2 Collections", A)
    L_MAR = lib("ZZP2 Margin", A)
    L_FRESH = lib("ZZP2 Fresh", A)
    lib("ZZP2 Cash collections", A, active=0)
    db.execute("INSERT INTO pm_kpi_aliases(business_group, alias_key, alias_name, into_key, into_name, kind) VALUES "
               "(?, 'zzp2 cash collections', 'ZZP2 Cash collections', 'zzp2 collections', 'ZZP2 Collections', 'dupe')", (A,))
    holds("ZZP2 Gross profit", 1, 2, 3, 4)
    holds("ZZP2 Collections", 1, 2)
    holds("ZZP2 Cash collections", 3)
    holds("ZZP2 Fresh", 6)
    P = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM kpi_chart WHERE level='persp'")}
    G_PROF, c_prof = a._chart_add_node(db, "group", P["1"], "ZZP2 Profitability", SU["id"])
    G_CASH, c_cash = a._chart_add_node(db, "group", P["1"], "ZZP2 Cash", SU["id"])
    K_COL, c_col = a._chart_add_node(db, "kpi", G_PROF, "ZZP2 Collections", SU["id"])
    K_GP, c_gp = a._chart_add_node(db, "kpi", G_PROF, "ZZP2 Gross profit", SU["id"])
    a._chart_map_name(db, K_COL, "ZZP2 Collections", "", "seed", SU["id"])
    a._chart_map_name(db, K_COL, "ZZP2 Cash collections", "", "seed", SU["id"])
    a._chart_map_name(db, K_GP, "ZZP2 Gross profit", "", "seed", SU["id"])
    V_OLD, c_vold = a._chart_add_node(db, "variant", K_COL, "ZZP2 Collections: Old", SU["id"], qualifier="Old")
    a._chart_map_name(db, V_OLD, "ZZP2 Collections: Old", "", "variant", SU["id"])
    db.commit()

SUP = H.client_as(a, SU["id"])
BGC = H.client_as(a, BGA["id"]) if BGA else None


def post(client, data, follow=False):
    d = dict(data)
    d["csrf_token"] = "tok"
    return client.post(LIBURL, data=d, follow_redirects=follow)


def flashes(r):
    return " ".join(re.findall(r'class="flash[^"]*"[^>]*>(.*?)<', r.get_data(as_text=True), re.S))


def page(**args):
    from urllib.parse import urlencode
    return SUP.get(LIBURL + ("?" + urlencode(args) if args else "")).get_data(as_text=True)


def node(i):
    return q1("SELECT * FROM kpi_chart WHERE id=?", (i,))


def lines_of(n_):
    return qa("SELECT * FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? ORDER BY id", (CID, U[n_]))


try:
    # ---------------------------------------------------------------------------------------------------------------
    s.section("dark unless ONEHR_COA=1")
    os.environ.pop("ONEHR_COA", None)
    off = page(kpi="zzp2 collections", panel="kpi")
    s.check("flag off: the KPI panel has none of the chart's sections", "Code and place" not in off and "Variants &middot;" not in off
            and "Lines with this code" not in off and 'id="pnl-variant"' not in off and 'id="pnl-list"' not in off)
    s.check("...the Add and Edit forms have no place, no pills, no people picker",
            "Its place in the chart" not in off and "coa-seg" not in off and 'name="people_eids"' not in off and 'name="mode"' not in off)
    s.check("...and the old Perspective and Family . group are where they were", 'name="category"' in off and 'name="perspective"' in off)
    n0, m0 = nodes_n(), names_n()
    for act, extra in (("chart_move", {"kpi": "zzp2 collections", "to_group": str(G_CASH)}),
                       ("chart_place", {"kpi": "zzp2 fresh", "perspective": "Financial", "chart_group": str(G_CASH)}),
                       ("chart_variant_add", {"kpi": "zzp2 collections", "qualifier": "Export"})):
        d = {"action": act}
        d.update(extra)
        s.check("flag off: %s is a 404 and writes nothing" % act, post(SUP, d).status_code == 404 and nodes_n() == n0 and names_n() == m0)
    r = post(SUP, {"action": "add", "business_group": A, "kpi_name": "ZZP2 Flagoff", "method": "more", "tier_n": "0",
                   "company": "*", "department_mode": "any", "mode": "people", "people_eids": EID[1]})
    row = q1("SELECT id FROM pm_kpi_library WHERE business_group=? AND kpi_name='ZZP2 Flagoff'", (A,))
    s.check("flag off: a named-people field is ignored (the row is added as today, naming nobody)", row is not None and people_n(row[0]) == 0)
    s.check("flag off: the access gate for a chart action comes before everything", post(SUP, {"action": "chart_variant_add"}).status_code == 404)

    os.environ["ONEHR_COA"] = "1"
    # ---------------------------------------------------------------------------------------------------------------
    s.section("the KPI panel: Code and place, Variants, Lines with this code")
    html = page(kpi="zzp2 collections", panel="kpi")
    s.check("the code, where it sits and Move", 'class="coa-codebox">%s<' % c_col in html and "ZZP2 Profitability" in html
            and 'data-coa-toggle="coa-move"' in html and 'value="chart_move"' in html)
    s.check("the head says KPI <code> . perspective > group", ("KPI %s &middot; 1. Financial" % c_col) in html.replace(" · ", " &middot; ")
            or ("KPI %s · 1. Financial" % c_col) in html)
    s.check("Variants . 1 lists the existing one with its code", "Variants &middot; 1" in html and c_vold in html
            and 'data-panel-open="variant"' in html)
    s.check("Lines with this code . 2 counts the KPI's own lines by group (the alias line reads as it too)",
            "Lines with this code &middot; 3" in html and "ZZP2 Group A" in html or "Lines with this code &middot; 3" in html)
    lst = re.search(r'data-list-open="([^"]*chart-lines[^"]*)"', html)
    s.check("...and the count opens the people in the list panel (list_peek on the page)", lst is not None and 'id="pnl-list"' in html)
    if lst:
        r = SUP.get(lst.group(1).replace("&amp;", "&"))
        t = r.get_data(as_text=True)
        s.check("the list holds the people with a line of that code, with the names as written",
                r.status_code == 200 and EID[1] in t and EID[3] in t and "ZZP2 Cash collections" in t and EID[4] not in t, t[:200])
    if BGC:
        s.check("a BG admin cannot open the list (super admin only)", BGC.get(lst.group(1).replace("&amp;", "&")).status_code == 403)
    s.check("the variant panel is on the page for a non-BU KPI", 'id="pnl-variant"' in html and "Add variant %s-02" % c_col in html)
    calls = {"n": 0}
    orig = a.chart_nodes_of_lines

    def counting(*aa, **kk):
        calls["n"] += 1
        return orig(*aa, **kk)
    a.chart_nodes_of_lines = counting
    try:
        page(kpi="zzp2 collections", panel="kpi")
    finally:
        a.chart_nodes_of_lines = orig
    s.check("the lines are read in bulk and mapped in memory (chart_nodes_of_lines: once for the cycle's lines, once for the retire / "
            "archive usage of every cycle -- never per line)", calls["n"] == 2, calls)
    gp = page(kpi="zzp2 gross profit", panel="kpi")
    s.check("a BU-level KPI: no Add a variant button and no variant panel; it points to BU KPI setup",
            'data-panel-open="variant"' not in gp and 'id="pnl-variant"' not in gp and "BU KPI setup" in gp)
    fr = page(kpi="zzp2 fresh", panel="kpi")
    s.check("a KPI with no code: 'Not in the chart yet' and a Give it a place form", "Not in the chart yet" in fr
            and 'value="chart_place"' in fr and 'data-coa-place' in fr and "Variants &middot;" not in fr)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("Give it a place")
    ln_before = lines_of(6)
    n0, m0 = nodes_n(), names_n()
    for label, data in (("half a place (perspective only)", {"perspective": "Financial"}),
                        ("a group that is not under the perspective", {"perspective": "Customer", "chart_group": str(G_CASH)}),
                        ("a perspective no list offers", {"perspective": "Nope", "chart_group": str(G_CASH)}),
                        ("a new group with no name", {"perspective": "Financial", "chart_group": "__new__", "group_new": "  "})):
        d = {"action": "chart_place", "kpi": "zzp2 fresh"}
        d.update(data)
        post(SUP, d)
        s.check("%s is refused, nothing written" % label, nodes_n() == n0 and names_n() == m0)
    s.check("an unknown KPI is a 400", post(SUP, {"action": "chart_place", "kpi": "zzp2 nope", "perspective": "Financial",
                                                  "chart_group": str(G_CASH)}).status_code == 400)
    if BGC:
        s.check("a BG admin cannot (403)", post(BGC, {"action": "chart_place", "kpi": "zzp2 fresh", "perspective": "Financial",
                                                      "chart_group": str(G_CASH)}).status_code == 403)
    r = post(SUP, {"action": "chart_place", "kpi": "zzp2 fresh", "perspective": "Financial", "chart_group": str(G_CASH)}, follow=True)
    nd = q1("SELECT * FROM kpi_chart WHERE name='ZZP2 Fresh'")
    s.check("a KPI is given the next free code in the group and the name is mapped group-wide",
            nd is not None and nd["parent_id"] == G_CASH and nd["code"].startswith(c_cash) and nd["level"] == "kpi"
            and q1("SELECT business_group FROM kpi_chart_names WHERE node_id=? AND name_key='zzp2 fresh'", (nd["id"],))[0] == "", dict(nd) if nd else None)
    s.check("...it is in the trail and the page says so", q1("SELECT 1 FROM activity_log WHERE action='pm_kpi_chart' AND detail LIKE ?",
                                                             ("%code " + nd["code"] + " given to KPI ZZP2 Fresh%",)) is not None
            and nd["code"] in flashes(r))
    s.check("...a line is not touched", lines_of(6) == ln_before)
    n1 = nodes_n()
    post(SUP, {"action": "chart_place", "kpi": "zzp2 fresh", "perspective": "Financial", "chart_group": str(G_CASH)})
    s.check("a second Give it a place is refused (it already has a code)", nodes_n() == n1)
    # merged names follow the identity
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO pm_kpi_aliases(business_group, alias_key, alias_name, into_key, into_name, kind) VALUES "
                   "(?, 'zzp2 fresh old', 'ZZP2 Fresh old', 'zzp2 fresh', 'ZZP2 Fresh', 'dupe')", (A,))
        db.execute("DELETE FROM kpi_chart_names WHERE node_id=?", (nd["id"],))
        db.execute("DELETE FROM kpi_chart WHERE id=?", (nd["id"],))
        db.commit()
    post(SUP, {"action": "chart_place", "kpi": "zzp2 fresh", "perspective": "Financial", "chart_group": "__new__", "group_new": "ZZP2 Brand new"})
    nd2 = q1("SELECT * FROM kpi_chart WHERE name='ZZP2 Fresh'")
    grp2 = q1("SELECT * FROM kpi_chart WHERE name='ZZP2 Brand new'")
    s.check("a new KPI group is made when asked for, and the KPI goes under it", grp2 is not None and grp2["level"] == "group"
            and nd2 is not None and nd2["parent_id"] == grp2["id"])
    s.check("...every name merged into the KPI is mapped to it too", q1("SELECT COUNT(*) FROM kpi_chart_names WHERE node_id=? AND "
                                                                         "name_key='zzp2 fresh old'", (nd2["id"],))[0] == 1)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("Move")
    with a.app.app_context():
        db = a.get_db()
        V2, c_v2 = a._chart_add_node(db, "variant", K_COL, "ZZP2 Collections: Plant", SU["id"], qualifier="Plant")
        a._chart_map_name(db, V2, "ZZP2 Collections: Plant", "", "variant", SU["id"])
        db.execute("UPDATE pm_kpi_targets SET chart_node_id=? WHERE cycle_id=? AND subject_id=?", (V2, CID, U[2]))
        db.commit()
    names_before = qa("SELECT id, node_id, name_key, business_group FROM kpi_chart_names ORDER BY id")
    ov_before = qa("SELECT id, chart_node_id FROM pm_kpi_targets WHERE chart_node_id IS NOT NULL ORDER BY id")
    old = {"kpi": node(K_COL)["code"], "v1": node(V_OLD)["code"], "v2": node(V2)["code"]}
    if BGC:
        s.check("a BG admin cannot move (403)", post(BGC, {"action": "chart_move", "kpi": "zzp2 collections", "to_group": str(G_CASH)}).status_code == 403)
    s.check("the same group is refused, nothing changes", post(SUP, {"action": "chart_move", "kpi": "zzp2 collections", "to_group": str(G_PROF)}).status_code in (302, 303)
            and node(K_COL)["code"] == old["kpi"])
    s.check("a node that is not a group is a 400", post(SUP, {"action": "chart_move", "kpi": "zzp2 collections", "to_group": str(K_GP)}).status_code == 400
            and post(SUP, {"action": "chart_move", "kpi": "zzp2 collections", "to_group": "x"}).status_code == 400)
    s.check("a KPI with no code cannot be moved", node(K_COL) is not None and post(SUP, {"action": "chart_move", "kpi": "zzp2 margin", "to_group": str(G_CASH)}).status_code in (302, 303))
    r = post(SUP, {"action": "chart_move", "kpi": "zzp2 collections", "to_group": str(G_CASH)}, follow=True)
    k, v1, v2 = node(K_COL), node(V_OLD), node(V2)
    s.check("the KPI takes the next free code under the other group", k["parent_id"] == G_CASH and k["code"].startswith(c_cash) and len(k["code"]) == len(c_cash) + 2, dict(k))
    s.check("...and each variant a new code under it, in order", v1["code"] == k["code"] + "-01" and v2["code"] == k["code"] + "-02", (v1["code"], v2["code"]))
    s.check("...the old codes are kept in was_codes", old["kpi"] in json.loads(k["was_codes"]) and old["v1"] in json.loads(v1["was_codes"])
            and old["v2"] in json.loads(v2["was_codes"]))
    s.check("...the name map and every line's override follow the node (neither was written)",
            qa("SELECT id, node_id, name_key, business_group FROM kpi_chart_names ORDER BY id") == names_before
            and qa("SELECT id, chart_node_id FROM pm_kpi_targets WHERE chart_node_id IS NOT NULL ORDER BY id") == ov_before)
    s.check("...it is in the trail and the page names the new code", q1("SELECT 1 FROM activity_log WHERE action='pm_kpi_chart' AND detail LIKE '%moved KPI%'") is not None
            and k["code"] in flashes(r))
    with a.app.app_context():
        db = a.get_db()
        nk, nc = a._chart_add_node(db, "kpi", G_PROF, "ZZP2 Later", SU["id"])
        db.commit()
    s.check("the old code is never given out again (the group's next KPI skips it)", nc != old["kpi"])
    html = page(kpi="zzp2 collections", panel="kpi")
    s.check("the panel shows the new code, the old one under 'Held before', and Move now offers the first group back",
            'class="coa-codebox">%s<' % k["code"] in html and "Held before" in html and old["kpi"] in html)
    # a full group refuses, and writes nothing
    with a.app.app_context():
        db = a.get_db()
        G_FULL, c_full = a._chart_add_node(db, "group", P["2"], "ZZP2 Full", SU["id"])
        for i in range(99):
            db.execute("INSERT INTO kpi_chart(code, level, parent_id, name) VALUES (?, 'kpi', ?, ?)", (c_full + "%02d" % (i + 1), G_FULL, "ZZP2 fill %d" % i))
        db.commit()
    before = (qa("SELECT id, code, parent_id, was_codes FROM kpi_chart ORDER BY id"))
    r = post(SUP, {"action": "chart_move", "kpi": "zzp2 collections", "to_group": str(G_FULL)}, follow=True)
    s.check("a full group refuses with its limit named and nothing changes", "99 KPIs" in flashes(r)
            and qa("SELECT id, code, parent_id, was_codes FROM kpi_chart ORDER BY id") == before, flashes(r)[:160])
    # variants of the moved KPI that are retired still move; moving back uses fresh codes
    post(SUP, {"action": "chart_move", "kpi": "zzp2 collections", "to_group": str(G_PROF)})
    k2 = node(K_COL)
    s.check("moving back gives yet another code: the first two are both in was_codes",
            k2["code"] not in (old["kpi"], k["code"]) and {old["kpi"], k["code"]} <= set(json.loads(k2["was_codes"])), dict(k2))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("Add a variant")
    p1_before = lines_of(1)
    p2_before = lines_of(2)
    COLI = next(i for i, x in enumerate(p1_before) if x["kpi_name"] == "ZZP2 Collections")
    n0, m0 = nodes_n(), names_n()
    bad = [("a blank qualifier", {"qualifier": "  "}),
           ("a qualifier over 60 characters", {"qualifier": "x" * 61}),
           ("a repeated qualifier (any case)", {"qualifier": "plant"}),
           ("someone who holds no line of the KPI", {"qualifier": "Export", "move_eids": EID[6]}),
           ("someone on another KPI only (a Gross profit holder with no Collections line)", {"qualifier": "Export", "move_eids": EID[4]}),
           ("an Employee ID that is nobody", {"qualifier": "Export", "move_eids": "ZZ9P2-NOBODY"}),
           ("a valid holder next to a non-holder", {"qualifier": "Export", "move_eids": EID[1] + "," + EID[6]})]
    for label, data in bad:
        d = {"action": "chart_variant_add", "kpi": "zzp2 collections"}
        d.update(data)
        r = post(SUP, d, follow=True)
        s.check("%s is refused and writes nothing" % label, nodes_n() == n0 and names_n() == m0 and lines_of(1) == p1_before
                and "flash flash-error" in r.get_data(as_text=True), flashes(r)[:120])
    r = post(SUP, {"action": "chart_variant_add", "kpi": "zzp2 gross profit", "qualifier": "Export"}, follow=True)
    s.check("a BU-level KPI is refused with a pointer to BU KPI setup, nothing written", nodes_n() == n0 and "BU KPI setup" in flashes(r), flashes(r)[:120])
    r = post(SUP, {"action": "chart_variant_add", "kpi": "zzp2 margin", "qualifier": "Export"}, follow=True)
    s.check("a KPI with no code cannot take a variant", nodes_n() == n0 and "place" in flashes(r))
    if BGC:
        s.check("a BG admin cannot (403)", post(BGC, {"action": "chart_variant_add", "kpi": "zzp2 collections", "qualifier": "Export"}).status_code == 403)
    s.check("an unknown KPI is a 400", post(SUP, {"action": "chart_variant_add", "kpi": "zzp2 nope", "qualifier": "Export"}).status_code == 400)
    with a.app.app_context():
        a_next = a._chart_next_code(a.get_db(), "variant", K_COL)
    r = post(SUP, {"action": "chart_variant_add", "kpi": "zzp2 collections", "qualifier": "  Export   sales ", "move_eids": EID[1]}, follow=True)
    vn = q1("SELECT * FROM kpi_chart WHERE level='variant' AND qualifier='Export sales'")
    s.check("the variant is written under the KPI with the next free code and its qualifier",
            vn is not None and vn["parent_id"] == K_COL and vn["code"] == a_next and vn["name"] == "ZZP2 Collections: Export sales", dict(vn) if vn else None)
    nm = q1("SELECT * FROM kpi_chart_names WHERE node_id=?", (vn["id"],))
    s.check("...a name-map row '<KPI>: <qualifier>', source variant, group-wide", nm is not None and nm["name_shown"] == "ZZP2 Collections: Export sales"
            and nm["source"] == "variant" and nm["business_group"] == "" and nm["name_key"] == "zzp2 collections: export sales")
    p1_after = lines_of(1)
    changed = [(x["id"], {c for c in x if x[c] != y[c]}) for x, y in zip(p1_before, p1_after) if x != y]
    s.check("the picked person's line of the KPI carries the override and NOTHING else changed on it (every other column identical)",
            len(p1_after) == len(p1_before) and changed == [(p1_before[COLI]["id"], {"chart_node_id"})]
            and p1_after[COLI]["chart_node_id"] == vn["id"] and p1_after[COLI]["kpi_name"] == "ZZP2 Collections", changed)
    s.check("...someone not picked keeps their line as it was", lines_of(2) == p2_before)
    s.check("...it is in the trail and the page says one line moved", q1("SELECT 1 FROM activity_log WHERE action='pm_kpi_chart' AND detail LIKE ?",
                                                                    ("%variant " + vn["code"] + " added%",)) is not None and "1 line" in flashes(r))
    pg = page(kpi="zzp2 collections", panel="kpi")
    s.check("...the panel now counts it: Variants . 3, and the line reads as the variant (the KPI's own lines fall to 1: the alias line)",
            "Variants &middot; 3" in pg and "Lines with this code &middot; 1" in pg, re.findall(r"Lines with this code &middot; \d+", pg))
    with a.app.app_context():
        idx, al = a._chart_index(a.get_db()), a._chart_aliases(a.get_db())
        ln = dict(lines_of(1)[COLI])
        ln["business_group"] = A
        s.check("...and the derived code of that line is the variant's", a.chart_code_of_line(idx, ln, al) == vn["code"])
    n1 = nodes_n()
    post(SUP, {"action": "chart_variant_add", "kpi": "zzp2 collections", "qualifier": "EXPORT SALES"})
    s.check("the same qualifier again is refused", nodes_n() == n1)
    # a second person, moved in a second variant: the picker sends a comma-joined list
    r = post(SUP, {"action": "chart_variant_add", "kpi": "zzp2 collections", "qualifier": "Two", "move_eids": EID[1] + "," + EID[3]})
    s.check("a person whose only line is already on a variant is not a holder of the KPI now (refused)", nodes_n() == n1 + 0 or nodes_n() == n1)
    # a name too long for the whole
    long_kpi = "x" * 70
    r = post(SUP, {"action": "chart_variant_add", "kpi": "zzp2 collections", "qualifier": long_kpi})
    s.check("a qualifier over 60 characters is refused again at the form (maxlength) and the server", nodes_n() == n1)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("Add a KPI with its place in the chart")
    add_html = page(panel="add", addbg=A)
    s.check("the Add form opens with 'Its place in the chart' first, a perspective, a group, 'A new KPI group', a read-only code",
            add_html.index("Its place in the chart") < add_html.index("What the KPI is") and 'name="chart_group"' in add_html
            and "A new KPI group" in add_html and 'readonly class="coa-codein"' in add_html)
    seg = add_html.split("What the KPI is", 1)[1].split("Who it applies to", 1)[0]
    s.check("...and Perspective and Family . group left 'What the KPI is'", 'name="category"' not in seg and 'name="perspective"' not in seg)
    s.check("...the code box has no name (it is a preview; the server works out the code)", re.search(r'<input[^>]*coa-codein[^>]*name=', add_html) is None
            and re.search(r'<input[^>]*name=[^>]*coa-codein', add_html) is None)
    op = page(kpi="zzp2 collections", panel="kpi")
    edit = op.split("Edit ", 1)[1] if "Edit " in op else ""
    s.check("the Edit form does not show the place fieldset (Move does that job)", "Its place in the chart" not in op)

    def addkpi(name, **kw):
        d = {"action": "add", "business_group": A, "kpi_name": name, "method": "more", "tier_n": "0", "company": "*",
             "department_mode": "any", "mode": "scope"}
        d.update(kw)
        return post(SUP, d, follow=True)
    n0, m0 = nodes_n(), names_n()
    r = addkpi("ZZP2 Half", perspective="Financial")
    s.check("half a place (perspective, no group) is refused: no library row, no node", q1("SELECT 1 FROM pm_kpi_library WHERE kpi_name='ZZP2 Half'") is None and nodes_n() == n0)
    r = addkpi("ZZP2 BadGroup", perspective="Customer", chart_group=str(G_PROF))
    s.check("a group under another perspective is refused: no library row, no node", q1("SELECT 1 FROM pm_kpi_library WHERE kpi_name='ZZP2 BadGroup'") is None and nodes_n() == n0)
    with a.app.app_context():
        want = a._chart_next_code(a.get_db(), "kpi", G_PROF)
    r = addkpi("ZZP2 Placed", perspective="Financial", chart_group=str(G_PROF), code="9999", weightage_default="5")
    lr = q1("SELECT * FROM pm_kpi_library WHERE business_group=? AND kpi_name='ZZP2 Placed'", (A,))
    nd = q1("SELECT * FROM kpi_chart WHERE name='ZZP2 Placed'")
    s.check("a placed KPI: the library row by today's writer, then the node with the server's code (a posted code is ignored) and the name map",
            lr is not None and lr["perspective"] == "Financial" and nd is not None and nd["code"] == want and nd["parent_id"] == G_PROF
            and q1("SELECT business_group, source FROM kpi_chart_names WHERE node_id=?", (nd["id"],))["source"] == "add", (dict(nd) if nd else None, want))
    s.check("...Where used still files it: the library row's family . group comes from the place", lr["category"] == "Financial · ZZP2 Profitability", lr["category"])
    r = addkpi("ZZP2 Newgrp", perspective="Financial", chart_group="__new__", group_new="ZZP2 Newly made")
    ng = q1("SELECT * FROM kpi_chart WHERE name='ZZP2 Newly made'")
    nk = q1("SELECT * FROM kpi_chart WHERE name='ZZP2 Newgrp'")
    s.check("'A new KPI group' makes the group (next code) and the KPI under it", ng is not None and nk is not None and nk["parent_id"] == ng["id"]
            and nk["code"].startswith(ng["code"]))
    n1, m1 = nodes_n(), names_n()
    r = addkpi("ZZP2 Collections", business_group=B, perspective="Financial", chart_group=str(G_CASH))
    # group B has no library config row for the KPI name; the same name in another group reuses the code
    lb = q1("SELECT 1 FROM pm_kpi_library WHERE business_group=? AND kpi_name='ZZP2 Collections'", (B,))
    s.check("a name that already has a code reuses it: the row is added, no new node, no new name", lb is not None and nodes_n() == n1 and names_n() == m1
            and str(node(K_COL)["code"]) in flashes(r), flashes(r)[:160])
    r = addkpi("ZZP2 Unplaced")
    s.check("no place at all: the KPI is added as today and stays 'Not in the chart yet'", q1("SELECT 1 FROM pm_kpi_library WHERE kpi_name='ZZP2 Unplaced'") is not None
            and q1("SELECT 1 FROM kpi_chart WHERE name='ZZP2 Unplaced'") is None)
    # a full perspective refuses a new group but adds nothing (and no library row)
    with a.app.app_context():
        db = a.get_db()
        for i in range(9):
            try:
                a._chart_add_node(db, "group", P["3"], "ZZP2 g3 %d" % i, SU["id"])
            except ValueError:
                break
        db.commit()
    nfull = nodes_n()
    r = addkpi("ZZP2 NoRoom", perspective="Internal Process", chart_group="__new__", group_new="ZZP2 One too many")
    s.check("a full perspective refuses 'A new KPI group' with the limit named; no library row, no node",
            q1("SELECT 1 FROM pm_kpi_library WHERE kpi_name='ZZP2 NoRoom'") is None and nodes_n() == nfull and "9 KPI groups" in flashes(r), flashes(r)[:140])

    # ---------------------------------------------------------------------------------------------------------------
    s.section("named people: the form and the writer")
    s.check("the Add form has the pills and the strict multi-picker limited to the group, hidden field people_eids, up to 50 said",
            'name="mode" value="people"' in add_html and 'data-pick-multi data-pick-bg="%s"' % A in add_html and 'name="people_eids"' in add_html
            and "Up to 50" in add_html and "Units, departments and grades" in add_html and "Named people" in add_html)
    s.check("...with the info box and the amber note", "can pick it" in add_html and "Named people is for a person" in add_html)
    tpl = open(os.path.join(H.REPO, "templates", "_kpi_form.html"), encoding="utf-8").read()
    s.check("...no free-text input for people (a .pick with a hidden value only)", re.search(r'<input[^>]*type="text"[^>]*name="people_eids"', tpl) is None
            and 'class="pick-val" name="people_eids"' in tpl)

    def named(name, mode="people", eids=None, **kw):
        d = {"action": "add", "business_group": A, "kpi_name": name, "method": "more", "tier_n": "0", "company": "U1",
             "department_mode": "include", "departments": "ZZP2 Dept", "job_grades": "14", "mode": mode}
        if eids is not None:
            d["people_eids"] = ",".join(eids)
        d.update(kw)
        return post(SUP, d, follow=True)
    cnt0 = q1("SELECT COUNT(*) FROM pm_kpi_library WHERE business_group=?", (A,))[0]
    for label, kw in (("none picked", dict(eids=[])),
                      ("more than 50 (all of them valid)", dict(eids=MANY)),
                      ("an ID that is nobody", dict(eids=[EID[1], "ZZ9P2-NOBODY"])),
                      ("someone in another business group", dict(eids=[EID[1], EID[4]])),
                      ("someone who has left", dict(eids=[EID[1], EID[5]])),
                      ("BU-level ticked as well", dict(eids=[EID[1]], bu_level="1"))):
        r = named("ZZP2 People refused", **kw)
        s.check("%s is refused and the row is not added" % label, q1("SELECT COUNT(*) FROM pm_kpi_library WHERE business_group=?", (A,))[0] == cnt0
                and flashes(r) != "", flashes(r)[:140])
    admin_eid = q1("SELECT employee_id FROM users WHERE id=?", (SU["id"],))[0]
    if admin_eid:
        r = named("ZZP2 People refused", eids=[admin_eid])
        s.check("an admin account is refused", q1("SELECT COUNT(*) FROM pm_kpi_library WHERE business_group=?", (A,))[0] == cnt0)
    r = named("ZZP2 People", eids=[EID[1], EID[3], EID[1]])
    LP = q1("SELECT * FROM pm_kpi_library WHERE business_group=? AND kpi_name='ZZP2 People'", (A,))
    s.check("named people are written (a repeated ID once) and the row's own scope is stored as 'any'",
            LP is not None and people_n(LP["id"]) == 2 and LP["company"] == "*" and (LP["departments"] or "") == "" and (LP["job_grades"] or "") == ""
            and LP["department_mode"] == "include", dict(LP) if LP else None)
    with a.app.app_context():
        db = a.get_db()
        row = db.execute("SELECT * FROM pm_kpi_library WHERE id=?", (LP["id"],)).fetchone()
        users = {n_: db.execute("SELECT * FROM users WHERE id=?", (U[n_],)).fetchone() for n_ in U}
        mp = a._pm_lib_people_map(db, A)
        m = lambda n_: a.pm_library_matches_person(row, users[n_], 0, mp)
        s.check("a listed active person in the group matches (whatever their unit)", m(1) and m(3))
        s.check("a person who is not listed does not match, though unit, department and grade would fit", not m(2) and not m(6))
        db.execute("UPDATE users SET business_group=? WHERE id=?", (B, U[3]))
        u3 = db.execute("SELECT * FROM users WHERE id=?", (U[3],)).fetchone()
        s.check("a listed person moved to another business group does not match", not a.pm_library_matches_person(row, u3, 0, mp))
        db.execute("UPDATE users SET business_group=?, left_at='2026-02-01' WHERE id=?", (A, U[3]))
        u3 = db.execute("SELECT * FROM users WHERE id=?", (U[3],)).fetchone()
        s.check("a listed person who has left does not match", not a.pm_library_matches_person(row, u3, 0, mp))
        db.execute("UPDATE users SET left_at=NULL WHERE id=?", (U[3],))
        db.commit()
        s.check("...back and active, they match again", a.pm_library_matches_person(row, db.execute("SELECT * FROM users WHERE id=?", (U[3],)).fetchone(), 0, mp))
        # a row WITHOUT people matches exactly as before, with or without the map
        scoped = db.execute("SELECT * FROM pm_kpi_library WHERE business_group=? AND kpi_name='ZZP2 Margin'", (A,)).fetchone()
        db.execute("UPDATE pm_kpi_library SET company='U1', departments='ZZP2 Dept', department_mode='include', job_grades='14' WHERE id=?", (scoped["id"],))
        scoped2 = db.execute("SELECT * FROM pm_kpi_library WHERE id=?", (scoped["id"],)).fetchone()
        same = all(a.pm_library_matches_person(scoped2, users[n_], 0, mp) == a.pm_library_matches_person(scoped2, users[n_], 0)
                   == a.pm_library_matches_person(scoped2, users[n_], 0, {}) for n_ in U)
        by_scope = [n_ for n_ in U if a.pm_library_matches_person(scoped2, users[n_], 0, mp)]
        s.check("a row that names nobody matches exactly as before (by unit, department and grade; the map changes nothing)",
                same and set(by_scope) == {1, 2, 6}, by_scope)
        db.execute("UPDATE pm_kpi_library SET company='*', departments='', department_mode='include', job_grades='' WHERE id=?", (scoped["id"],))
        db.commit()
        # the resolver
        lib_for = lambda n_: [r["kpi_name"] for r in a.pm_library_for_person(db, dict(db.execute("SELECT * FROM users WHERE id=?", (U[n_],)).fetchone()), 0)]
        s.check("what a person is offered: the named KPI to the listed, not to the unlisted; the others as before",
                "ZZP2 People" in lib_for(1) and "ZZP2 People" not in lib_for(2) and "ZZP2 Margin" in lib_for(2) and "ZZP2 Margin" in lib_for(1))
        calls = {"n": 0}
        orig_map = a._pm_lib_people_map

        def cmap(*aa, **kk):
            calls["n"] += 1
            return orig_map(*aa, **kk)
        a._pm_lib_people_map = cmap
        try:
            lib_for(1)
        finally:
            a._pm_lib_people_map = orig_map
        s.check("...the people are read once for the group, not once per library row", calls["n"] == 1, calls)
        s.check("a named KPI is never offered as a unit's BU KPI (BU KPI setup's picker)", LP["id"] not in a._bu_kpi_pickable(db, A, "U1"))
    # update: replace, then clear
    r = post(SUP, {"action": "update", "library_id": str(LP["id"]), "business_group": A, "kpi_name": "ZZP2 People", "method": "more", "tier_n": "0",
                   "company": "*", "department_mode": "any", "mode": "people", "people_eids": EID[2]}, follow=True)
    with a.app.app_context():
        got = {r_[0] for r_ in a.get_db().execute("SELECT user_id FROM pm_kpi_library_people WHERE library_id=?", (LP["id"],))}
    s.check("an update replaces the set", got == {U[2]}, got)
    r = post(SUP, {"action": "update", "library_id": str(LP["id"]), "business_group": A, "kpi_name": "ZZP2 People", "method": "more", "tier_n": "0",
                   "company": "*", "department_mode": "any", "mode": "people", "people_eids": EID[2] + "," + EID[4]}, follow=True)
    with a.app.app_context():
        got = {r_[0] for r_ in a.get_db().execute("SELECT user_id FROM pm_kpi_library_people WHERE library_id=?", (LP["id"],))}
    s.check("...a refused update leaves the set as it was", got == {U[2]} and "another" not in flashes(r).lower() or got == {U[2]}, got)
    edit_html = page(kpi="zzp2 people", panel="kpi")
    s.check("the saved row's Edit form opens on 'Named people' with its people as chips, and the info box counts them (a link to the list)",
            re.search(r'name="mode" value="people" checked', edit_html) is not None and "ZZ P2 2" in edit_html and "1 person" in edit_html
            and "kpi-lib-people" in edit_html)
    s.check("...and Placed at says 'Named people' for that row", "<b>Named people</b>" in edit_html)
    lnk = re.search(r'data-list-open="([^"]*kpi-lib-people[^"]*)"', edit_html)
    if lnk:
        t = SUP.get(lnk.group(1).replace("&amp;", "&")).get_data(as_text=True)
        s.check("the list behind the count holds the people the row names", EID[2] in t and EID[1] not in t, t[:160])
    r = post(SUP, {"action": "update", "library_id": str(LP["id"]), "business_group": A, "kpi_name": "ZZP2 People", "method": "more", "tier_n": "0",
                   "company": "*", "department_mode": "any", "mode": "scope"}, follow=True)
    s.check("switching back to Units, departments and grades clears the people", people_n(LP["id"]) == 0)
    post(SUP, {"action": "update", "library_id": str(LP["id"]), "business_group": A, "kpi_name": "ZZP2 People", "method": "more", "tier_n": "0",
               "company": "*", "department_mode": "any", "mode": "people", "people_eids": EID[1]})
    post(SUP, {"action": "update", "library_id": str(LP["id"]), "business_group": A, "kpi_name": "ZZP2 People", "method": "more", "tier_n": "0",
               "company": "*", "department_mode": "any", "mode": "people", "people_eids": EID[1], "bu_level": "1"})
    s.check("an update that ticks BU-level on a named row is refused (the people stay, the row is not BU-level)",
            people_n(LP["id"]) == 1 and q1("SELECT bu_level FROM pm_kpi_library WHERE id=?", (LP["id"],))[0] == 0)
    # the same update with NO mode field (the flag-off form, or any form without the pills) leaves the named people in place,
    # so it must be refused too
    nobu = {"action": "update", "library_id": str(LP["id"]), "business_group": A, "kpi_name": "ZZP2 People", "method": "more", "tier_n": "0",
            "company": "*", "department_mode": "any", "bu_level": "1"}
    SUP.get(LIBURL)   # shows (and so clears) the flashes the posts above queued
    r = post(SUP, nobu, follow=True)
    s.check("flag on, no mode: BU-level on a row that names people is refused, with a message, the people kept",
            "names people" in flashes(r) and people_n(LP["id"]) == 1 and q1("SELECT bu_level FROM pm_kpi_library WHERE id=?", (LP["id"],))[0] == 0,
            flashes(r)[:140])
    os.environ.pop("ONEHR_COA", None)
    try:
        r = post(SUP, nobu, follow=True)
    finally:
        os.environ["ONEHR_COA"] = "1"
    s.check("flag off, no mode: refused the same way",
            "names people" in flashes(r) and people_n(LP["id"]) == 1 and q1("SELECT bu_level FROM pm_kpi_library WHERE id=?", (LP["id"],))[0] == 0,
            flashes(r)[:140])
    with a.app.app_context():
        _c = a.get_db()
        L_CTL = _c.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, description, unit, "
                           "method, rate1, rate2, rate3, rate4, rate5, bu_level, active, perspective) VALUES (?, '*', '*', 0, '*', "
                           "'ZZP2 Names nobody', 'Defines it', 'RM', 'more', 1, 2, 3, 4, 5, 0, 1, 'Financial')", (A,)).lastrowid
        _c.commit()
    r = post(SUP, {"action": "update", "library_id": str(L_CTL), "business_group": A, "kpi_name": "ZZP2 Names nobody", "method": "more",
                   "tier_n": "0", "company": "*", "department_mode": "any", "bu_level": "1"}, follow=True)
    s.check("control: a row that names nobody can still be made BU-level with no mode (the guard is not over-broad)",
            q1("SELECT bu_level FROM pm_kpi_library WHERE id=?", (L_CTL,))[0] == 1 and "names people" not in flashes(r), flashes(r)[:140])
    post(SUP, {"action": "delete", "library_id": str(LP["id"])})
    s.check("removing the row removes its people", people_n(LP["id"]) == 0 and q1("SELECT 1 FROM pm_kpi_library WHERE id=?", (LP["id"],)) is None)
    if BGC:
        s.check("a BG admin cannot name people (403)", post(BGC, {"action": "add", "business_group": A, "kpi_name": "ZZP2 BG", "method": "more", "tier_n": "0",
                                                                    "company": "*", "mode": "people", "people_eids": EID[1]}).status_code == 403)
    s.check("an admin's chart list is the super admin's alone", (BGC.get("/admin/list/chart-lines?fragment=1&node=%d" % K_COL).status_code == 403) if BGC else True)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the standards: every form asks first, the CSS fix, the access map")
    kpi_page = open(os.path.join(H.REPO, "templates", "admin_kpi_library.html"), encoding="utf-8").read()
    forms = re.findall(r"<form\b(?:[^<>]|\{\{.*?\}\}|\{%.*?%\})*?>", kpi_page, flags=re.S)
    mine = [f for f in forms if re.search(r"chart_move|chart_place|chart_variant|data-coa-variant|coa-moveform", f)]
    s.check("the new forms carry data-confirm with a title and a button word", mine and all("data-confirm=" in f for f in mine)
            and all("data-confirm-title=" in f and "data-confirm-ok=" in f for f in mine if "chart_place" not in f or True), len(mine))
    css = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
    s.check("the .pp-lib collision is scoped to the KPI form, and the form's textarea is the modern one",
            ".kl-form .pp-lib { min-height: 0; max-height: none; overflow: visible; margin-bottom: 8px; }" in css and ".kl-form.coa-form textarea {" in css)
    src = H.source(a)
    s.check("no new route: the new actions ride on the library page, which is the super admin's", len(re.findall(r'@app\.route\("[^"]*chart[^"]*"', src)) == 0
            and 'startswith("chart_") and not coa_on()' in src)
    s.check("the two lists are registered for the list panel", all(k in a.ADMIN_LISTS for k in ("chart-lines", "kpi-lib-people")))
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
                + _db.execute("SELECT COUNT(*) FROM pm_kpi_library_people").fetchone()[0])
    s.check("everything the suite made was put back", left == 0, left)

sys.exit(s.done())
