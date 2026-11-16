"""The Chart of KPI, retire and archive (Chris, 2026-10-30; the canvas boards 8 and 9; docs/chart-of-kpi.md).

What this suite holds:
  * Retire (a KPI or a variant, any time, even in use): the node is not offered or matched -- absent from Match lines' suggestions and
    code selects, Add a variant, Add a KPI's reuse of a code (refused), Move -- but every line that carries it KEEPS its code (an
    override and a name-map line alike). Retiring a KPI retires its active variants and active library placements and records exactly
    those (retired_with); Bring back reopens exactly those, never a variant retired on its own; a variant under a retired KPI cannot
    be brought back first
  * Archive (only when nothing uses it): refused for a line in ANY cycle (a past one too), a data link, an unarchived variant; an
    active unused node is retired in the same step; the node's names are parked and leave the map (so they can be matched elsewhere),
    resolution skips an archived node, its code is never reused, the seed does not build it again
  * Restore: back to RETIRED, the names back on the map, a name another node took meanwhile skipped and counted; a variant under an
    archived KPI is refused
  * the list: In use | Retired | Archived pills with counts, the Retired list's "Lines now", the Archived list's when and who
  * all four actions are `chart_` actions on the library POST: flag off = 404, a BG admin = 403, the server re-checks every rule
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The Chart of KPI: retire and archive")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
A, B = "ZZRT Group A", "ZZRT Group B"
PREFIX = "ZZ9RT-"
LIBURL = "/admin/performance/library"
FLAG0 = os.environ.get("ONEHR_COA")

with a.app.app_context():
    _d = a.get_db()
    BASE_NODE = _d.execute("SELECT COALESCE(MAX(id), 0) FROM kpi_chart").fetchone()[0]
    BASE_NAME = _d.execute("SELECT COALESCE(MAX(id), 0) FROM kpi_chart_names").fetchone()[0]
    BASE_ACT = _d.execute("SELECT COALESCE(MAX(id), 0) FROM activity_log").fetchone()[0]
    BASE_ALIAS = _d.execute("SELECT COALESCE(MAX(id), 0) FROM pm_kpi_aliases").fetchone()[0]
    BASE_SYS = _d.execute("SELECT COALESCE(MAX(id), 0) FROM kpi_ext_systems").fetchone()[0]


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE ?", (PREFIX + "%",))]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM cycles WHERE code='ZZRT-PAST'")
    db.execute("DELETE FROM kpi_chart_links WHERE node_id > ?", (BASE_NODE,))
    db.execute("DELETE FROM kpi_ext_systems WHERE id > ?", (BASE_SYS,))
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


def dbx(sql, args=()):
    with a.app.app_context():
        d = a.get_db()
        d.execute(sql, args)
        d.commit()


def node(i):
    return q1("SELECT * FROM kpi_chart WHERE id=?", (i,))


def acts():
    return [r["detail"] for r in qa("SELECT detail FROM activity_log WHERE id > ? AND action='pm_kpi_chart' ORDER BY id", (BASE_ACT,))]


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    PAST = db.execute("INSERT INTO cycles(code, name, is_active, year, half) VALUES ('ZZRT-PAST', 'ZZRT 2025 Year-End', 0, 2025, 2)").lastrowid
    CNAME = db.execute("SELECT name FROM cycles WHERE id=?", (CID,)).fetchone()[0]
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'U1'),(?, 'U9')", (A, B))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A'),(?, 'A')", (A, B))
    U = {}
    for n_, bg, co in ((1, A, "U1"), (2, A, "U1"), (3, B, "U9"), (4, B, "U9")):
        eid = PREFIX + str(n_)
        U[n_] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                           "department, job_grade, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?, 'ZZRT Dept', '14', "
                           "'2020-01-01')", (eid.lower(), "ZZ RT " + str(n_), eid, bg, co)).lastrowid

    def lib(name, bg, active=1):
        return db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, "
                          "description, unit, method, rate1, rate2, rate3, rate4, rate5, bu_level, active, perspective) "
                          "VALUES (?, '*', '*', 0, '*', ?, NULL, ?, 'RM', 'more', 1, 2, 3, 4, 5, 0, ?, 'Financial')",
                          (bg, name, "Defines " + name, active)).lastrowid

    def holds(name, n_, cycle=None, node_id=None):
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, rate4, "
                   "rate5, business_group, company, description, chart_node_id) SELECT ?, id, ?, 10, 'more', 1,2,3,4,5, "
                   "business_group, company, 'own words', ? FROM users WHERE id=?", (cycle or CID, name, node_id, U[n_]))
    P = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM kpi_chart WHERE level='persp'")}
    G_P, c_gp = a._chart_add_node(db, "group", P["1"], "ZZRT Profit", SU["id"])
    G_C, c_gc = a._chart_add_node(db, "group", P["1"], "ZZRT Cash", SU["id"])
    G_Z, c_gz = a._chart_add_node(db, "group", P["2"], "ZZRT Fresh", SU["id"])

    def kpi(name, group=G_P, extra_names=()):
        nid, code = a._chart_add_node(db, "kpi", group, name, SU["id"])
        a._chart_map_name(db, nid, name, "", "seed", SU["id"])
        for x in extra_names:
            a._chart_map_name(db, nid, x, "", "seed", SU["id"])
        return nid, code

    def variant(k, qual):
        row = db.execute("SELECT name FROM kpi_chart WHERE id=?", (k,)).fetchone()
        full = "%s: %s" % (row["name"], qual)
        vid, code = a._chart_add_node(db, "variant", k, full, SU["id"], qualifier=qual)
        a._chart_map_name(db, vid, full, "", "variant", SU["id"])
        return vid, code
    # K1: two placements, three variants, lines of every kind
    L_NP_A, L_NP_B = lib("ZZRT Net profit", A), lib("ZZRT Net profit", B)
    K1, c1 = kpi("ZZRT Net profit")
    V1, cv1 = variant(K1, "Subsidiary")
    V2, cv2 = variant(K1, "Consolidated")
    V3, cv3 = variant(K1, "Plant")
    holds("ZZRT Net profit", 1)                      # a name-map line
    holds("ZZRT Net profit: Subsidiary", 2)          # a variant's name-map line
    holds("ZZRT Stray", 3, node_id=K1)               # an override line (its own words, the code from the override)
    holds("ZZRT Net profit: Plant", 4)
    holds("ZZRT Net profit (NP)", 3)                 # an uncoded line the Match page would suggest K1 for (same dupe key)
    # K2: nothing uses it
    L_UN = lib("ZZRT Unused", A)
    K2, c2 = kpi("ZZRT Unused")
    # K3: a data link, no line
    lib("ZZRT Linked", A)
    K3, c3 = kpi("ZZRT Linked")
    SYS = db.execute("INSERT INTO kpi_ext_systems(name) VALUES ('ZZRT Sys')").lastrowid
    db.execute("INSERT INTO kpi_chart_links(node_id, system_id, metric_id, period, whose, matched_on) VALUES (?,?,'M1','month','person','employee_id')",
               (K3, SYS))
    # K6: a line in a PAST cycle only
    lib("ZZRT Past", A)
    K6, c6 = kpi("ZZRT Past")
    holds("ZZRT Past", 1, cycle=PAST)
    # K4: two names, a variant, a placement
    lib("ZZRT Parent", A)
    K4, c4 = kpi("ZZRT Parent", extra_names=("ZZRT Parent legacy",))
    V4, cv4 = variant(K4, "Retail")
    # K5 / V5: archive the variant, then the KPI
    lib("ZZRT Pair", A)
    K5, c5 = kpi("ZZRT Pair")
    V5, cv5 = variant(K5, "Half")
    db.commit()

SUP = H.client_as(a, SU["id"])
BGC = H.client_as(a, BGA["id"]) if BGA else None
KEY = lambda name: " ".join(name.lower().split())   # noqa: E731


def post(client, data, follow=False):
    d = dict(data)
    d["csrf_token"] = "tok"
    return client.post(LIBURL, data=d, follow_redirects=follow)


def flashes(r):
    return " ".join(re.findall(r'class="flash[^"]*"[^>]*>(.*?)<', r.get_data(as_text=True), re.S)).replace("&#39;", "'")


def act(action, nid, kpi_name=None, follow=True, **extra):
    d = {"action": action, "node_id": str(nid)}
    if kpi_name:
        d["kpi"] = KEY(kpi_name)
    d.update(extra)
    return post(SUP, d, follow=follow)


def page(**args):
    from urllib.parse import urlencode
    return SUP.get(LIBURL + ("?" + urlencode(args) if args else "")).get_data(as_text=True)


def code_of(name, bg, node_id=None):
    with a.app.app_context():
        d = a.get_db()
        idx, al = a._chart_index(d), a._chart_aliases(d)
        return a.chart_code_of_line(idx, {"kpi_name": name, "business_group": bg, "chart_node_id": node_id}, al)


def pill(html, word):
    m = re.search(word + r" · (\d+)", html)
    return int(m.group(1)) if m else None


def rows_of(html):
    """The codes listed in the Chart list (the coa-code cells of the rows in the list body)."""
    body = html.split('class="coa-body"', 1)[-1]
    return re.findall(r'<span class="coa-code[^"]*">([^<]+)</span>', body)


try:
    # ---------------------------------------------------------------------------------------------------------------
    s.section("flag off = 404; a BG admin = 403")
    os.environ.pop("ONEHR_COA", None)
    for act_ in ("chart_retire", "chart_bringback", "chart_archive", "chart_restore"):
        s.check("flag off: %s is a 404 and changes nothing" % act_, act(act_, K2, "ZZRT Unused", follow=False).status_code == 404
                and node(K2)["retired_at"] is None and node(K2)["archived_at"] is None)
    os.environ["ONEHR_COA"] = "1"
    if BGC:
        for act_ in ("chart_retire", "chart_bringback", "chart_archive", "chart_restore"):
            r = post(BGC, {"action": act_, "node_id": str(K2)})
            s.check("a BG admin cannot %s (403), nothing changes" % act_, r.status_code == 403 and node(K2)["retired_at"] is None)
    s.check("an unknown node, or a group node, is a 400", act("chart_retire", 999999, follow=False).status_code == 400
            and act("chart_retire", G_P, follow=False).status_code == 400
            and post(SUP, {"action": "chart_retire", "node_id": "x"}).status_code == 400)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("Match lines: the control before anything is retired")
    with a.app.app_context():
        d = a.get_db()
        md = a._chart_match_rows(d)
        sug = {r["name"]: r["sugg"] for r in md["rows"] if r["name"].startswith("ZZRT")}
        opts = [n["id"] for n, _lab in md["options"]]
    s.check("control: the uncoded 'ZZRT Net profit (NP)' is suggested the KPI, and the KPI and its variants are code options",
            sug.get("ZZRT Net profit (NP)") and sug["ZZRT Net profit (NP)"]["node"]["id"] == K1 and K1 in opts and V1 in opts and V3 in opts, sug)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("Retire a variant on its own, then the KPI: what is recorded")
    r = act("chart_retire", V2, "ZZRT Net profit")
    s.check("a variant retires on its own (any time, here while its KPI is in use)", node(V2)["retired_at"] and node(V2)["retired_by"] == SU["id"]
            and node(V2)["retired_with"] is None and node(K1)["retired_at"] is None, flashes(r))
    s.check("...and says so, the trail has a row", "Retired %s" % cv2 in flashes(r) and any("retired variant %s" % cv2 in d_ for d_ in acts()), acts())
    r = act("chart_retire", V2, "ZZRT Net profit")
    s.check("retiring it again is refused", "already retired" in flashes(r))
    n_act = len(acts())
    r = act("chart_retire", K1, "ZZRT Net profit")
    k1 = node(K1)
    w = json.loads(k1["retired_with"] or "{}")
    s.check("retiring a KPI retires it, its two ACTIVE variants and its two active placements", k1["retired_at"] and node(V1)["retired_at"]
            and node(V3)["retired_at"] and q1("SELECT COUNT(*) FROM pm_kpi_library WHERE kpi_name='ZZRT Net profit' AND active=0")[0] == 2, flashes(r))
    s.check("...and records exactly what it retired with it (not the variant retired on its own)",
            sorted(w.get("nodes", [])) == sorted([V1, V3]) and sorted(w.get("lib", [])) == sorted([L_NP_A, L_NP_B]), w)
    s.check("...one trail row, naming the variants and placements", len(acts()) == n_act + 1 and "2 variants and 2 placements" in acts()[-1], acts()[-1])
    v2_when = node(V2)["retired_at"]

    # ---------------------------------------------------------------------------------------------------------------
    s.section("lines keep their code")
    s.check("a name-map line still reads as the retired KPI", code_of("ZZRT Net profit", A) == c1, code_of("ZZRT Net profit", A))
    s.check("an override line still reads as the retired KPI", code_of("ZZRT Stray", B, K1) == c1)
    s.check("a line on a retired variant keeps the variant's code", code_of("ZZRT Net profit: Subsidiary", A) == cv1)
    with a.app.app_context():
        d = a.get_db()
        use = a._chart_node_usage(d)
    s.check("the usage read counts them against the retired node (the Retired list's Lines now)",
            use.get(K1, {}).get(CID) == 2 and use.get(V1, {}).get(CID) == 1 and use.get(V3, {}).get(CID) == 1, {k: v for k, v in use.items() if k in (K1, V1, V3)})
    s.check("no line was touched", q1("SELECT COUNT(*) FROM pm_kpi_targets WHERE kpi_name='ZZRT Stray' AND chart_node_id=?", (K1,))[0] == 1
            and q1("SELECT COUNT(*) FROM pm_kpi_targets WHERE kpi_name LIKE 'ZZRT Net profit%'")[0] == 4)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("a retired node is not offered, not matched")
    with a.app.app_context():
        d = a.get_db()
        md = a._chart_match_rows(d)
        sug = {r["name"]: r["sugg"] for r in md["rows"] if r["name"].startswith("ZZRT")}
        opts = [n["id"] for n, _lab in md["options"]]
        po = a._chart_place_opts(d)
    s.check("Match lines no longer suggests the retired KPI or its variants for 'ZZRT Net profit (NP)'",
            not sug.get("ZZRT Net profit (NP)") or sug["ZZRT Net profit (NP)"]["node"]["id"] not in (K1, V1, V2, V3), sug.get("ZZRT Net profit (NP)"))
    s.check("...and the code select offers none of them (but still offers the in-use ones)",
            not ({K1, V1, V2, V3} & set(opts)) and K2 in opts, opts)
    mp = SUP.get("/admin/performance/library/match").get_data(as_text=True)
    s.check("...nor does the page's select", ('value="%d"' % K1) not in mp and c1 + " " not in re.sub(r"<[^>]+>", " ", mp).replace("ZZRT Net profit (NP)", ""), "")
    r = SUP.post("/admin/performance/library/match", data={"csrf_token": "tok", "action": "confirm", "key": KEY("ZZRT Net profit (NP)"),
                                                          "bg": B, "code_node": str(K1)}, follow_redirects=True)
    s.check("a forged Confirm to the retired code is refused", "not a KPI or variant in use" in flashes(r) and
            code_of("ZZRT Net profit (NP)", B) is None, flashes(r))
    r = post(SUP, {"action": "chart_variant_add", "kpi": KEY("ZZRT Net profit"), "qualifier": "Export"}, follow=True)
    s.check("Add a variant to a retired KPI is refused, in words, and writes nothing", "is retired: bring it back first" in flashes(r)
            and q1("SELECT COUNT(*) FROM kpi_chart WHERE parent_id=? AND level='variant'", (K1,))[0] == 3, flashes(r))
    n_lib = q1("SELECT COUNT(*) FROM pm_kpi_library")[0]
    r = post(SUP, {"action": "add", "business_group": A, "kpi_name": "zzrt net profit", "method": "more", "tier_n": "0", "company": "*",
                   "department_mode": "any", "perspective": "Financial", "chart_group": str(G_P)}, follow=True)
    s.check("Add a KPI that would reuse the retired code is refused: '%s is retired: bring it back first'" % c1,
            ("%s is retired: bring it back first" % c1) in flashes(r) and q1("SELECT COUNT(*) FROM pm_kpi_library")[0] == n_lib, flashes(r))
    r = post(SUP, {"action": "chart_move", "kpi": KEY("ZZRT Net profit"), "to_group": str(G_C)}, follow=True)
    s.check("Move of a retired KPI is refused and its codes stay", "is retired: bring it back first" in flashes(r) and node(K1)["code"] == c1
            and node(K1)["parent_id"] == G_P, flashes(r))
    kp = page(kpi=KEY("ZZRT Net profit"), panel="kpi")
    s.check("...and its panel offers no Move", 'data-coa-toggle="coa-move"' not in kp and "Add variant" not in kp)
    dbx("UPDATE kpi_chart SET retired_at=datetime('now') WHERE id=?", (G_C,))
    with a.app.app_context():
        po = a._chart_place_opts(a.get_db())
    s.check("a retired KPI group is not a Move target (not in the picker, and refused)", all(g["id"] != G_C for p in po for g in p["groups"])
            and "retired" in flashes(post(SUP, {"action": "chart_move", "kpi": KEY("ZZRT Unused"), "to_group": str(G_C)}, follow=True)))
    dbx("UPDATE kpi_chart SET retired_at=NULL WHERE id=?", (G_C,))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the panel of a retired KPI, and the list")
    s.check("a retired KPI's panel still opens, with 'Retired <day>' and Bring back", "Retired " in kp and "Bring back" in kp and 'value="chart_bringback"' in kp
            and 'value="chart_retire"' not in kp.split("Variants &middot;")[0], "")
    s.check("...its variants table has a Status column with the greyed retired rows and per-row actions",
            "coa-v5" in kp and "is-ret" in kp and 'class="coa-st ret"' in kp and kp.count(">Bring back<") >= 4)
    s.check("...the retired variant under it cannot be brought back first: that button is disabled and says why",
            ("Bring back %s first" % c1) in kp)
    s.check("...Archive is greyed with the first blocker in its title", re.search(r'disabled title="4 lines in %s still carry %s or its variants"' % (re.escape(CNAME), c1), kp)
            is not None, re.findall(r'disabled title="[^"]*"', kp))
    s.check("...each button asks first, with a title, the verb repeated and a list of what happens",
            "data-confirm-title=\"Bring back %s?\"" % c1 in kp and "data-confirm-ok=\"Bring back %s\"" % c1 in kp and "data-confirm-list='" in kp
            and "Variants retired on their own stay retired" in kp)
    ret = page(view="chart", status="retired")
    s.check("the Retired list has the KPI and its variants with Status and Lines now, and no in-use KPI", all(c in rows_of(ret) for c in (c1, cv1, cv2, cv3))
            and c2 not in rows_of(ret) and "Lines now" in ret and "Retired " in ret and ("2 in %s" % CNAME) in ret and "None" in ret)
    inuse = page(view="chart")
    s.check("In use lists no retired KPI or variant, but the others", c1 not in rows_of(inuse) and cv1 not in rows_of(inuse) and c2 in rows_of(inuse) and c4 in rows_of(inuse))
    s.check("the pills carry the counts: Retired . 4 (the KPI, 3 variants), Archived . 0", pill(inuse, "Retired") == 4 and pill(inuse, "Archived") == 0
            and 'class="is-on"' in inuse and ">In use<" in inuse, (pill(inuse, "Retired"), pill(inuse, "Archived")))
    s.check("the tree counts follow the pill: In use counts KPIs; Retired counts the retired KPI and variants",
            re.search(r'Whole chart</span><span class="kl-n">(\d+)<', inuse) and re.search(r'Whole chart</span><span class="kl-n">(\d+)<', ret).group(1) == "4",
            re.search(r'Whole chart</span><span class="kl-n">(\d+)<', ret))
    one = page(view="chart", status="retired", kpi=KEY("ZZRT Net profit"), panel="kpi")
    s.check("Open on a retired row opens the KPI panel", "Code and place" in one)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("Bring back")
    r = act("chart_bringback", V2, "ZZRT Net profit")
    s.check("a variant under a RETIRED KPI cannot be brought back: 'Bring back <KPI> first'", ("Bring back %s first" % c1) in flashes(r)
            and node(V2)["retired_at"] == v2_when, flashes(r))
    n_act = len(acts())
    r = act("chart_bringback", K1, "ZZRT Net profit")
    s.check("bringing the KPI back reopens it, the variants and placements retired WITH it", node(K1)["retired_at"] is None and node(K1)["retired_with"] is None
            and node(V1)["retired_at"] is None and node(V3)["retired_at"] is None
            and q1("SELECT COUNT(*) FROM pm_kpi_library WHERE kpi_name='ZZRT Net profit' AND active=1")[0] == 2, flashes(r))
    s.check("...but not the variant that was retired on its own", node(V2)["retired_at"] == v2_when)
    s.check("...one trail row, and the page says what came back", len(acts()) == n_act + 1 and "2 variants" in flashes(r) and "2 placements" in flashes(r), flashes(r))
    r = act("chart_bringback", K1, "ZZRT Net profit")
    s.check("bringing back what is in use is refused", "already in use" in flashes(r))
    r = act("chart_bringback", V2, "ZZRT Net profit")
    s.check("now the lone retired variant comes back", node(V2)["retired_at"] is None, flashes(r))
    # a placement the super admin brought back by hand is not touched twice; a deleted one is skipped
    act("chart_retire", K1, "ZZRT Net profit")
    dbx("UPDATE pm_kpi_library SET active=1 WHERE id=?", (L_NP_A,))
    dbx("DELETE FROM pm_kpi_library WHERE id=?", (L_NP_B,))
    r = act("chart_bringback", K1, "ZZRT Net profit")
    s.check("a placement already back, or removed meanwhile, is left alone; the KPI still comes back", node(K1)["retired_at"] is None
            and q1("SELECT active FROM pm_kpi_library WHERE id=?", (L_NP_A,))[0] == 1 and q1("SELECT 1 FROM pm_kpi_library WHERE id=?", (L_NP_B,)) is None
            and "0 placements" in flashes(r), flashes(r))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("Archive: only when nothing uses it")
    r = act("chart_archive", K1, "ZZRT Net profit")
    s.check("lines in the current cycle (on the KPI and its variants) refuse it, in words", node(K1)["archived_at"] is None
            and ("4 lines in %s still carry %s or its variants" % (CNAME, c1)) in flashes(r), flashes(r))
    s.check("...the page's disabled button says the same",
            ("disabled title=\"4 lines in %s still carry %s or its variants\"" % (CNAME, c1)) in page(kpi=KEY("ZZRT Net profit"), panel="kpi"))
    r = act("chart_archive", K6, "ZZRT Past")
    s.check("a line in a PAST cycle refuses it", node(K6)["archived_at"] is None and ("1 line in ZZRT 2025 Year-End still carries %s" % c6) in flashes(r), flashes(r))
    r = act("chart_archive", K3, "ZZRT Linked")
    s.check("a data link refuses it", node(K3)["archived_at"] is None and "it has a data link" in flashes(r), flashes(r))
    r = act("chart_archive", K4, "ZZRT Parent")
    s.check("an unarchived variant refuses it: 'Archive its 1 variant first'", node(K4)["archived_at"] is None and "Archive its 1 variant first" in flashes(r), flashes(r))
    s.check("...and refusals write nothing (no trail row, nothing retired)", not any("archived" in d_ for d_ in acts()) and node(K4)["retired_at"] is None)
    n_names = q1("SELECT COUNT(*) FROM kpi_chart_names WHERE node_id=?", (V4,))[0]
    n_act = len(acts())
    r = act("chart_archive", V4, "ZZRT Parent")
    v4 = node(V4)
    s.check("an ACTIVE unused variant is archived, and retired in the same step", v4["archived_at"] and v4["retired_at"] and v4["archived_by"] == SU["id"], flashes(r))
    parked = json.loads(v4["archived_names"] or "[]")
    s.check("its name-map rows are parked on the node (key, shown, group, source) and off the map",
            len(parked) == n_names == 1 and parked[0]["name_shown"] == "ZZRT Parent: Retail" and set(parked[0]) == {"name_key", "name_shown", "business_group", "source"}
            and q1("SELECT COUNT(*) FROM kpi_chart_names WHERE node_id=?", (V4,))[0] == 0, parked)
    s.check("...one trail row", len(acts()) == n_act + 1 and "archived variant %s" % cv4 in acts()[-1] and "retired in the same step" in acts()[-1], acts()[-1])
    with a.app.app_context():
        d = a.get_db()
        used = a._chart_used_codes(d)
    s.check("the archived code is in _chart_used_codes", cv4 in used)
    r = act("chart_archive", V4, "ZZRT Parent")
    s.check("archiving it twice is refused", "already archived" in flashes(r))
    r = act("chart_retire", V4, "ZZRT Parent")
    s.check("an archived node cannot be retired or brought back: restore it first",
            "archived: restore it first" in flashes(r) and "archived: restore it first" in flashes(act("chart_bringback", V4, "ZZRT Parent")))
    s.check("a line naming an archived node's old name no longer reads as it", code_of("ZZRT Parent: Retail", A) == c4 and code_of("ZZRT Parent: Retail", A) != cv4,
            code_of("ZZRT Parent: Retail", A))
    s.check("a line whose override names the archived node falls to the name map",
            code_of("ZZRT Parent", A, V4) == c4 and code_of("ZZRT Nothing", A, V4) is None)
    dbx("INSERT INTO kpi_chart_names(node_id, name_key, name_shown, business_group, source) VALUES (?, 'zzrt stale', 'ZZRT Stale', '', 'add')", (V4,))
    s.check("even a stale name row on an archived node does not resolve", code_of("ZZRT Stale", A) is None)
    dbx("DELETE FROM kpi_chart_names WHERE name_key='zzrt stale'")
    with a.app.app_context():
        d = a.get_db()
        ok_ = a._chart_map_name(d, K2, "ZZRT Parent: Retail", "", "match", SU["id"])
        d.commit()
    s.check("the parked name can be matched elsewhere right away", ok_ and code_of("ZZRT Parent: Retail", A) == c2, code_of("ZZRT Parent: Retail", A))
    dbx("DELETE FROM kpi_chart_names WHERE node_id=? AND name_key='zzrt parent: retail'", (K2,))

    # an active, unused KPI: retired in the same step, with its placement
    r = act("chart_archive", K4, "ZZRT Parent")
    k4 = node(K4)
    s.check("an active unused KPI (its only variant archived) is archived and retired in the same step", k4["archived_at"] and k4["retired_at"], flashes(r))
    s.check("...its placement was retired with it and recorded, so Bring back can reopen it later",
            q1("SELECT active FROM pm_kpi_library WHERE kpi_name='ZZRT Parent'")[0] == 0 and json.loads(k4["retired_with"] or "{}").get("lib"), k4["retired_with"])
    parked4 = {p["name_shown"] for p in json.loads(k4["archived_names"] or "[]")}
    s.check("...both its names are parked and the map has none of them", parked4 == {"ZZRT Parent", "ZZRT Parent legacy"}
            and q1("SELECT COUNT(*) FROM kpi_chart_names WHERE name_key IN ('zzrt parent', 'zzrt parent legacy')")[0] == 0, parked4)
    s.check("...so its lines would read as nothing here (the name is free)", code_of("ZZRT Parent", A) is None)
    r = act("chart_archive", K2, "ZZRT Unused")
    s.check("a KPI nothing uses, never retired, is archived in one step", node(K2)["archived_at"] and node(K2)["retired_at"], flashes(r))
    dbx("UPDATE kpi_chart SET archived_at=NULL, archived_by=NULL, archived_names=NULL, retired_at=NULL, retired_with=NULL WHERE id=?", (K2,))
    dbx("UPDATE pm_kpi_library SET active=1 WHERE id=?", (L_UN,))
    dbx("INSERT INTO kpi_chart_names(node_id, name_key, name_shown, business_group, source) VALUES (?, 'zzrt unused', 'ZZRT Unused', '', 'seed')", (K2,))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("an archived code is never reused; the seed does not bring it back")
    dbx("UPDATE pm_kpi_library SET category='Financial · ZZRT Profit' WHERE kpi_name='ZZRT Parent'")   # so the seed could build it
    with a.app.app_context():
        d = a.get_db()
        z1, cz1 = a._chart_add_node(d, "kpi", G_Z, "ZZRT Z one", SU["id"])
        z2, cz2 = a._chart_add_node(d, "kpi", G_Z, "ZZRT Z two", SU["id"])
        d.commit()
    act("chart_archive", z1)
    with a.app.app_context():
        d = a.get_db()
        nxt = a._chart_next_code(d, "kpi", G_Z)
        used = a._chart_used_codes(d)
    s.check("the lowest archived code is not handed out again (%s stays used; the next is not it)" % cz1, node(z1)["archived_at"] and cz1 in used and nxt not in (cz1, cz2)
            and nxt.startswith(c_gz), (cz1, cz2, nxt))
    with a.app.app_context():
        d = a.get_db()
        before = d.execute("SELECT COUNT(*) FROM kpi_chart").fetchone()[0]
        out = a._chart_seed(d, SU["id"])
        by_key = d.execute("SELECT COUNT(*) FROM kpi_chart_names WHERE name_key IN ('zzrt parent', 'zzrt parent legacy')").fetchone()[0]
        made = d.execute("SELECT COUNT(*) FROM kpi_chart WHERE name='ZZRT Parent' AND id != ?", (K4,)).fetchone()[0]
        d.rollback()
    s.check("the seed leaves an archived identity alone: no new node, none of its names back on the map (library row 'ZZRT Parent' is still there)",
            by_key == 0 and made == 0 and q1("SELECT COUNT(*) FROM pm_kpi_library WHERE kpi_name='ZZRT Parent'")[0] == 1, (by_key, made, out))
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE kpi_chart SET archived_names=NULL WHERE id=?", (K4,))
        a._chart_seed(d, SU["id"])
        again = d.execute("SELECT COUNT(*) FROM kpi_chart WHERE name='ZZRT Parent' AND id != ?", (K4,)).fetchone()[0]
        d.rollback()
    s.check("   control: with nothing parked the same seed DOES build the identity (the guard is what stops it)", again == 1, again)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("Restore")
    dbx("INSERT INTO kpi_chart_names(node_id, name_key, name_shown, business_group, source) VALUES (?, 'zzrt parent legacy', 'ZZRT Parent legacy', '', 'match')", (K2,))
    n_act = len(acts())
    r = act("chart_restore", K4, "ZZRT Parent")
    k4 = node(K4)
    s.check("restoring brings it back as RETIRED (not in use)", k4["archived_at"] is None and k4["archived_by"] is None and k4["retired_at"] and k4["archived_names"] is None, flashes(r))
    s.check("...its names go back on the map, and the one another KPI took meanwhile is skipped and counted",
            q1("SELECT node_id FROM kpi_chart_names WHERE name_key='zzrt parent'")[0] == K4
            and q1("SELECT node_id FROM kpi_chart_names WHERE name_key='zzrt parent legacy'")[0] == K2
            and "1 name skipped" in flashes(r) and "1 name back" in flashes(r), flashes(r))
    s.check("...one trail row with the counts", len(acts()) == n_act + 1 and "1 name back on the map, 1 skipped" in acts()[-1], acts()[-1])
    s.check("...its lines read as it again", code_of("ZZRT Parent", A) == c4)
    r = act("chart_restore", K4, "ZZRT Parent")
    s.check("restoring what is not archived is refused", "is not archived" in flashes(r))
    r = act("chart_bringback", K4, "ZZRT Parent")
    s.check("Bring back then reopens it, with its recorded placement", node(K4)["retired_at"] is None and q1("SELECT active FROM pm_kpi_library WHERE kpi_name='ZZRT Parent'")[0] == 1, flashes(r))
    # a pair: archive the variant then the KPI; the variant cannot come back before its KPI
    act("chart_archive", V5, "ZZRT Pair")
    act("chart_archive", K5, "ZZRT Pair")
    r = act("chart_restore", V5)
    s.check("a variant under an ARCHIVED KPI cannot be restored: 'Restore <KPI> first'", ("Restore %s first" % c5) in flashes(r) and node(V5)["archived_at"], flashes(r))
    s.check("...the Archived list greys that Restore and says why", ("disabled title=\"Restore %s first\"" % c5) in page(view="chart", status="archived"))
    act("chart_restore", K5)
    r = act("chart_restore", V5)
    s.check("with the KPI restored, the variant restores", node(V5)["archived_at"] is None and node(V5)["retired_at"], flashes(r))
    # Move skips an archived variant: its code never changes
    with a.app.app_context():
        d = a.get_db()
        mv, cmv = a._chart_add_node(d, "variant", K2, "ZZRT Unused: Moved", SU["id"], qualifier="Moved")
        d.commit()
    act("chart_archive", mv)
    r = post(SUP, {"action": "chart_move", "kpi": KEY("ZZRT Unused"), "to_group": str(G_C)}, follow=True)
    s.check("moving a KPI leaves its archived variant's code alone", node(K2)["parent_id"] == G_C and node(mv)["code"] == cmv, (node(mv)["code"], cmv))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the lists: filters, counts, who and when")
    act("chart_archive", K3)   # refused: a data link (control for the counts)
    r = act("chart_retire", K6, "ZZRT Past")
    exp_ret = q1("SELECT COUNT(*) FROM kpi_chart WHERE level IN ('kpi','variant') AND retired_at IS NOT NULL AND archived_at IS NULL")[0]
    exp_arc = q1("SELECT COUNT(*) FROM kpi_chart WHERE level IN ('kpi','variant') AND archived_at IS NOT NULL")[0]
    # the library page also lists a KPI whose placements are all retired: none here -- every placement of a retired KPI went with it
    html = page(view="chart")
    s.check("the pills count the retired and the archived (%d, %d)" % (exp_ret, exp_arc), pill(html, "Retired") == exp_ret and pill(html, "Archived") == exp_arc and exp_arc >= 3,
            (pill(html, "Retired"), pill(html, "Archived"), exp_ret, exp_arc))
    arc = page(view="chart", status="archived")
    arcs = rows_of(arc)
    s.check("...it lists the archived KPI and variants and nothing in use", cv4 in arcs and cz1 in arcs and cmv in arcs and c1 not in arcs and c6 not in arcs and
            len(arcs) == exp_arc, (arcs, exp_arc))
    s.check("...with the date and who (the actor's name, as the History shows people)", re.search(r"\d{1,2} \w{3} \d{4} · ", arc) and
            q1("SELECT full_name FROM users WHERE id=?", (SU["id"],))[0] in arc and ">Restore<" in arc and "Open</a>" not in arc.split('class="coa-body"', 1)[1])
    s.check("...each Restore asks first, with the verb repeated and a list", "data-confirm-title=\"Restore %s?\"" % cz1 in arc and "data-confirm-ok=\"Restore %s\"" % cz1 in arc
            and "Bring back then reopens it" in arc and 'value="chart_restore"' in arc)
    s.check("...the archived pill is on, and the tree counts follow it", re.search(r'<a class="is-on"[^>]*>Archived', arc) is not None
            and re.search(r'Whole chart</span><span class="kl-n">(\d+)<', arc).group(1) == str(exp_arc))
    ret = page(view="chart", status="retired")
    s.check("the Retired list: the KPI retired just now, its lines now, a variant listed under its own row, never an archived one",
            c6 in rows_of(ret) and cv4 not in rows_of(ret) and len(rows_of(ret)) == exp_ret and "ZZRT Past" in ret, (rows_of(ret), exp_ret))
    s.check("...a KPI with no line in the usage cycle says None (its past cycle's line does not count in Lines now)",
            re.search(r'ZZRT Past.*?None', ret, re.S) is not None)
    s.check("the empty states read well", "Nothing is archived here" in page(view="chart", status="archived", cn="p:3")
            and "Nothing is retired here" in page(view="chart", status="retired", cn="p:3"))
    s.check("search in Archived finds the node by its name, and only it", rows_of(page(view="chart", status="archived", q="z one")) == [cz1])
    # an archived node never shows up In use, in Needs a place, or in the pickers
    inuse = page(view="chart")
    s.check("an archived node is nowhere In use", cv4 not in rows_of(inuse) and cz1 not in rows_of(inuse))
    pnl = page(view="chart", panel="chart")
    s.check("...and not in the rename pickers", ("%s ZZRT Z one" % cz1) not in pnl)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("one batched read of the lines per request")
    calls = {"n": 0}
    orig = a._chart_node_usage

    def counting(*aa, **kk):
        calls["n"] += 1
        return orig(*aa, **kk)
    a._chart_node_usage = counting
    try:
        page(view="chart", status="retired")
        n_list = calls["n"]
        page(kpi=KEY("ZZRT Net profit"), panel="kpi")
        n_panel = calls["n"] - n_list
        act("chart_archive", K1, "ZZRT Net profit", follow=False)
        n_post = calls["n"] - n_list - n_panel
    finally:
        a._chart_node_usage = orig
    s.check("the Retired list, the KPI panel and an Archive each read the usage once, however many rows", (n_list, n_panel, n_post) == (1, 1, 1), (n_list, n_panel, n_post))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the standards")
    tpl = open(os.path.join(H.REPO, "templates", "admin_kpi_library.html"), encoding="utf-8").read()
    forms = re.findall(r"<form\b(?:[^<>]|\{\{.*?\}\}|\{%.*?%\})*?>", tpl, flags=re.S)
    mine = [f for f in forms if re.search(r"coa_form|data-confirm-list=.{0,30}(cf|restore)", f)]
    s.check("every retire / bring back / archive / restore form is double-confirmed (message, title, button word, list)", len(mine) == 2 and all(
        "data-confirm=" in f and "data-confirm-title=" in f and "data-confirm-ok=" in f and "data-confirm-list=" in f for f in mine), len(mine))
    src = H.source(a)
    s.check("the four actions are on the existing library POST, behind the chart_ prefix (flag, then super admin)", all(('"%s"' % x) in src for x in
            ("chart_retire", "chart_bringback", "chart_archive", "chart_restore")) and len(re.findall(r'@app\.route\("[^"]*(?:retire|archive)[^"]*"', src)) == 0)
    s.check("no browser confirm() or alert() in the new markup", "confirm(" not in tpl.split("coa_status")[1][:3000] and "alert(" not in tpl.split("coa_status")[1][:3000])
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
                + _db.execute("SELECT COUNT(*) FROM cycles WHERE code='ZZRT-PAST'").fetchone()[0]
                + _db.execute("SELECT COUNT(*) FROM kpi_chart WHERE retired_at IS NOT NULL OR archived_at IS NOT NULL").fetchone()[0])
    s.check("everything the suite made was put back", left == 0, left)

sys.exit(s.done())
