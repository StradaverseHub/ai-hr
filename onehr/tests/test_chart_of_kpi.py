"""The Chart of KPI, piece A1 (Chris, 2026-10-30, docs/chart-of-kpi.md): the flag, the schema, the code helpers, the
seed from today's library, the library page's Chart view and the chart's group actions.

What this suite holds:
  * dark unless ONEHR_COA=1: no Chart switch, the Where used page is today's, and every chart POST is a 404
  * the schema (kpi_chart, kpi_chart_names, pm_kpi_targets.chart_node_id, pm_kpi_library_people) and the four seeded
    perspectives, held to PM_PERSPECTIVES
  * codes: a group is its perspective's digit + 1-9, a KPI its group + 01-99, a variant its KPI + -01..-99; a full level
    is refused with its limit named; a retired code and every code in any node's was_codes is never reused
  * a line's code (chart_node_of_line), the plan's six steps, each with a case only that step can answer, so removing
    the step fails it; and the batched helper reads the chart once
  * the seed: groups, KPI nodes and the name map (alias keys too); an untagged KPI stays in Needs a place; a second run
    adds nothing
  * the Chart view: codes with "1." / "11." in the tree, the list's columns, variants under their KPI, the scrolling
    body; the super admin's actions double-confirmed, refused for anyone else, refused blank or unknown
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The Chart of KPI: flag, schema, codes, the seed and the Chart view")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
A, B = "ZZCO Group A", "ZZCO Group B"
PREFIX = "ZZ9CO-"

with a.app.app_context():
    _d = a.get_db()
    BASE_NODE = _d.execute("SELECT COALESCE(MAX(id), 0) FROM kpi_chart").fetchone()[0]
    BASE_NAME = _d.execute("SELECT COALESCE(MAX(id), 0) FROM kpi_chart_names").fetchone()[0]
    BASE_ACT = _d.execute("SELECT COALESCE(MAX(id), 0) FROM activity_log").fetchone()[0]
    BASE_ALIAS = _d.execute("SELECT COALESCE(MAX(id), 0) FROM pm_kpi_aliases").fetchone()[0]
FLAG0 = os.environ.get("ONEHR_COA")


def _cleanup_chart(db):
    """What the chart tables gained since the suite began (and a perspective's retirement or was_codes)."""
    db.execute("DELETE FROM kpi_chart_names WHERE id > ?", (BASE_NAME,))
    db.execute("UPDATE kpi_chart SET parent_id=NULL WHERE id > ?", (BASE_NODE,))
    db.execute("DELETE FROM kpi_chart WHERE id > ?", (BASE_NODE,))
    db.execute("UPDATE kpi_chart SET was_codes=NULL, retired_at=NULL WHERE id <= ? AND level='persp'", (BASE_NODE,))
    db.execute("DELETE FROM activity_log WHERE id > ? AND action='pm_kpi_chart'", (BASE_ACT,))
    db.commit()


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE ?", (PREFIX + "%",))]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    _cleanup_chart(db)
    db.execute("DELETE FROM pm_kpi_aliases WHERE id > ? AND business_group IN (?,?)", (BASE_ALIAS, A, B))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group IN (?,?)", (A, B))
    db.execute("DELETE FROM pm_bg_config WHERE business_group IN (?,?)", (A, B))
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (A, B))
    db.commit()


def nodes_n():
    with a.app.app_context():
        return a.get_db().execute("SELECT COUNT(*) FROM kpi_chart WHERE level!='persp'").fetchone()[0]


def names_n():
    with a.app.app_context():
        return a.get_db().execute("SELECT COUNT(*) FROM kpi_chart_names").fetchone()[0]


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'U1'),(?, 'U2'),(?, 'U9')", (A, A, B))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A'),(?, 'A')", (A, B))
    U = {}
    for eid, bg, co in ((PREFIX + "1", A, "U1"), (PREFIX + "2", A, "U1"), (PREFIX + "3", A, "U2"),
                        (PREFIX + "4", B, "U9")):
        U[eid] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                            "company, job_grade, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?, '14', "
                            "'2020-01-01')", (eid.lower(), "ZZ CO " + eid[-1], eid, bg, co)).lastrowid

    def lib(name, bg, persp=None, cat=None, bu=0, active=1):
        db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, "
                   "description, unit, method, rate1, rate2, rate3, rate4, rate5, bu_level, active, perspective) "
                   "VALUES (?, '*', '*', 0, '*', ?, ?, ?, 'RM', 'more', 1, 2, 3, 4, 5, ?, ?, ?)",
                   (bg, name, cat, "Defines " + name, bu, active, persp))

    def holds(name, *eids):
        for e in eids:
            db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, "
                       "rate4, rate5, business_group, company) SELECT ?, id, ?, 10, 'more', 1,2,3,4,5, business_group, "
                       "company FROM users WHERE employee_id=?", (CID, name, e))
    lib("ZZCO Gross profit", A, "Financial", "Financial · ZZCO Profitability", bu=1)
    lib("ZZCO Gross profit", B, "Financial", "Financial · ZZCO Profitability", bu=1)
    lib("ZZCO GP old", A, "Financial", "Financial · ZZCO Profitability", active=0)       # merged into Gross profit
    lib("ZZCO Collections", A, "Financial", "Financial · ZZCO Cash")
    lib("ZZCO Satisfaction", A, "Customer", "Customer · ZZCO Service")
    lib("ZZCO Untagged", A, None, "Financial · ZZCO Cash")
    lib("ZZCO Ungrouped", A, "Financial", "Financial")                                  # no part after " · "
    db.execute("INSERT INTO pm_kpi_aliases(business_group, alias_key, alias_name, into_key, into_name, kind) VALUES "
               "(?, 'zzco gp old', 'ZZCO GP old', 'zzco gross profit', 'ZZCO Gross profit', 'dupe'),"
               "(?, 'zzco gp ancient', 'ZZCO GP ancient', 'zzco gp old', 'ZZCO GP old', 'dupe')", (A, A))   # a chain
    holds("ZZCO Gross profit", PREFIX + "1", PREFIX + "2", PREFIX + "3", PREFIX + "4")
    holds("ZZCO Collections", PREFIX + "1", PREFIX + "2", PREFIX + "3")
    holds("ZZCO Mystery line", PREFIX + "2")       # in no library: never coded
    db.commit()

SUP = H.client_as(a, SU["id"])
BGC = H.client_as(a, BGA["id"]) if BGA else None
LIBURL = "/admin/performance/library"


def post(client, data):
    d = dict(data)
    d["csrf_token"] = "tok"
    return client.post(LIBURL, data=d)


def listing(html):
    """Only the Chart view's list (the panel's pickers also name every KPI)."""
    return html.split('class="coa-body">', 1)[1].split('kl-foot', 1)[0] if 'class="coa-body">' in html else ""


def page(client=None, **args):
    from urllib.parse import urlencode
    return (client or SUP).get(LIBURL + ("?" + urlencode(args) if args else "")).get_data(as_text=True)


try:
    # ---------------------------------------------------------------------------------------------------------------
    s.section("dark unless ONEHR_COA=1")
    os.environ.pop("ONEHR_COA", None)
    s.check("coa_on() is false by default", a.coa_on() is False)
    off = page()
    s.check("the library page loads", "KPI library" in off and 'aria-label="The tree"' in off)
    s.check("...with no Chart switch and nothing of the chart in its markup",
            "coa-switch" not in off and "view=chart" not in off and "coa-" not in off and "Seed from the library" not in off)
    unnext = lambda h: re.sub(r'next=[^"]*', "", h)   # noqa: E731  -- the cycle switch's links carry the page's own address
    s.check("?view=chart is ignored: the same page as without it", unnext(page(view="chart")) == unnext(off))
    before_nodes, before_names = nodes_n(), names_n()
    r = post(SUP, {"action": "chart_seed"})
    s.check("the seed is a 404 for the super admin", r.status_code == 404, r.status_code)
    s.check("...and every other chart action", all(post(SUP, {"action": x, "parent_id": "1", "group_name": "ZZCO x",
                                                              "node_id": "1", "node_name": "ZZCO x"}).status_code == 404
                                                   for x in ("chart_group_add", "chart_group_rename", "chart_kpi_rename")))
    if BGC:
        s.check("...and a BG admin is refused too (the admin write gate answers 403 before the library page does)",
                post(BGC, {"action": "chart_seed"}).status_code in (403, 404))
    s.check("nothing was written", (nodes_n(), names_n()) == (before_nodes, before_names))
    s.check("...and the page without the flag still posts a library action as today (an unknown action is a 400)",
            post(SUP, {"action": "nope"}).status_code == 400)

    os.environ["ONEHR_COA"] = "1"
    s.check("coa_on() reads the variable on every call", a.coa_on() is True)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the schema")
    with a.app.app_context():
        db = a.get_db()
        cols = lambda t: [r[1] for r in db.execute("PRAGMA table_info(%s)" % t)]   # noqa: E731
        s.check("kpi_chart has its columns", cols("kpi_chart") == [
            "id", "code", "level", "parent_id", "name", "qualifier", "definition", "retired_at", "retired_by", "was_codes",
            "created_by", "created_at", "updated_by", "updated_at", "retired_with", "archived_at", "archived_by", "archived_names"],
            cols("kpi_chart"))
        s.check("kpi_chart_names has its columns", cols("kpi_chart_names") == [
            "id", "node_id", "name_key", "name_shown", "business_group", "source", "created_by", "created_at"],
            cols("kpi_chart_names"))
        s.check("pm_kpi_targets.chart_node_id exists", "chart_node_id" in cols("pm_kpi_targets"))
        s.check("pm_kpi_library_people has its columns", cols("pm_kpi_library_people") == [
            "library_id", "user_id", "added_by", "added_at"], cols("pm_kpi_library_people"))
        sql = lambda n: (db.execute("SELECT sql FROM sqlite_master WHERE name=?", (n,)).fetchone() or [""])[0]   # noqa: E731
        s.check("a code is unique, a name is unique per group, the people table is keyed and cascades",
                "code TEXT NOT NULL UNIQUE" in sql("kpi_chart") and "UNIQUE(name_key, business_group)" in sql("kpi_chart_names")
                and "PRIMARY KEY(library_id, user_id)" in sql("pm_kpi_library_people")
                and "ON DELETE CASCADE" in sql("pm_kpi_library_people"))
        s.check("the name map is indexed by node", db.execute(
            "SELECT 1 FROM sqlite_master WHERE name='idx_kpi_chart_names_node'").fetchone() is not None)
        pers = [(r["code"], r["name"]) for r in db.execute("SELECT code, name FROM kpi_chart WHERE level='persp' ORDER BY code")]
        s.check("the four perspectives are seeded, named as PM_PERSPECTIVES (codes 1 to 4)",
                pers == [(str(i), n) for i, n in enumerate(a.PM_PERSPECTIVES, 1)], pers)
        try:
            db.execute("INSERT INTO kpi_chart(code, level, name) VALUES ('1', 'persp', 'dup')")
            dup = False
        except a.sqlite3.IntegrityError:
            dup = True
        db.rollback()
        s.check("a second '1' is refused by the schema", dup)
        try:
            db.execute("INSERT INTO kpi_chart(code, level, name) VALUES ('ZZ', 'galaxy', 'x')")
            bad = False
        except a.sqlite3.IntegrityError:
            bad = True
        db.rollback()
        s.check("a level outside persp / group / kpi / variant is refused", bad)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("codes: next, limits, never reused")
    with a.app.app_context():
        db = a.get_db()
        P = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM kpi_chart WHERE level='persp'")}
        # perspective 4 stays free for the group actions below; this uses 2 and 3
        codes = []
        for i in range(9):
            _id, c = a._chart_add_node(db, "group", P["3"], "ZZCO G%d" % i, SU["id"])
            codes.append(c)
        db.commit()
        s.check("a group is its perspective's digit + 1 to 9, in order", codes == ["3%d" % i for i in range(1, 10)], codes)
        try:
            a._chart_next_code(db, "group", P["3"])
            msg = ""
        except ValueError as e:
            msg = str(e)
        s.check("a tenth group is refused, naming the limit", "9 KPI groups" in msg and "full" in msg, msg)
        gid = db.execute("SELECT id FROM kpi_chart WHERE code='31'").fetchone()[0]
        s.check("a KPI is its group's code + 01", a._chart_next_code(db, "kpi", gid) == "3101")
        kid, kc = a._chart_add_node(db, "kpi", gid, "ZZCO K1", SU["id"])
        s.check("...and a variant its KPI's code + -01", a._chart_next_code(db, "variant", kid) == "3101-01")
        db.commit()
        # a full KPI level: 99 KPIs by direct insert, then the 100th is refused
        for n in range(2, 100):
            db.execute("INSERT INTO kpi_chart(code, level, parent_id, name) VALUES (?, 'kpi', ?, ?)",
                       ("31%02d" % n, gid, "ZZCO fill %d" % n))
        try:
            a._chart_next_code(db, "kpi", gid)
            msg = ""
        except ValueError as e:
            msg = str(e)
        s.check("a hundredth KPI is refused, naming the limit (and the code does not wrap to 3100 or 3201)",
                "99 KPIs" in msg and "full" in msg, msg)
        db.rollback()
        # 99 variants
        kid2, _ = a._chart_add_node(db, "kpi", db.execute("SELECT id FROM kpi_chart WHERE code='32'").fetchone()[0],
                                    "ZZCO K2", SU["id"])
        for n in range(1, 100):
            db.execute("INSERT INTO kpi_chart(code, level, parent_id, name) VALUES (?, 'variant', ?, ?)",
                       ("3201-%02d" % n, kid2, "ZZCO v %d" % n))
        try:
            a._chart_next_code(db, "variant", kid2)
            msg = ""
        except ValueError as e:
            msg = str(e)
        s.check("a hundredth variant is refused, naming the limit", "99 variants" in msg, msg)
        db.rollback()
        # never reused: retired rows stay, and was_codes count
        for i in range(3):
            a._chart_add_node(db, "group", P["4"], "ZZCO R%d" % i, SU["id"])      # 41 42 43
        db.execute("UPDATE kpi_chart SET retired_at=datetime('now') WHERE code='42'")
        db.execute("UPDATE kpi_chart SET was_codes=? WHERE code='43'", ('["45", "47"]',))
        db.commit()
        _i, c44 = a._chart_add_node(db, "group", P["4"], "ZZCO R3", SU["id"])
        _i, c46 = a._chart_add_node(db, "group", P["4"], "ZZCO R4", SU["id"])
        _i, c48 = a._chart_add_node(db, "group", P["4"], "ZZCO R5", SU["id"])
        s.check("a retired code (42) is never handed out again; the next is 44", c44 == "44", c44)
        s.check("...nor a code any node held before a move (45, 47 in was_codes): 46 then 48", (c46, c48) == ("46", "48"),
                (c46, c48))
        db.execute("UPDATE kpi_chart SET was_codes='not json' WHERE code='41'")
        s.check("a damaged was_codes is read as empty, not a crash", a._chart_next_code(db, "group", P["4"]) == "49")
        db.rollback()
        try:
            a._chart_next_code(db, "kpi", P["4"])
            wrong = ""
        except ValueError as e:
            wrong = str(e)
        s.check("a KPI cannot go straight under a perspective", "goes under a KPI group" in wrong, wrong)
        db.execute("UPDATE kpi_chart SET retired_at=datetime('now') WHERE code='31'")
        try:
            a._chart_next_code(db, "kpi", gid)
            ret = ""
        except ValueError as e:
            ret = str(e)
        s.check("nothing new goes under a retired node", "retired" in ret, ret)
        db.rollback()
        try:
            a._chart_next_code(db, "galaxy", gid)
            lv = ""
        except ValueError as e:
            lv = str(e)
        s.check("an unknown level is refused", "Unknown chart level" in lv, lv)
        _cleanup_chart(db)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("a line's code: the plan's six steps, each answered by its own case")
    with a.app.app_context():
        db = a.get_db()
        P = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM kpi_chart WHERE level='persp'")}
        G, _g = a._chart_add_node(db, "group", P["2"], "ZZCO Test group", SU["id"])
        N = {}
        for k in ("ovr", "bg", "all", "alias", "chain", "root", "base", "other"):
            N[k] = a._chart_add_node(db, "kpi", G, "ZZCO node " + k, SU["id"])[0]
        V = a._chart_add_node(db, "variant", N["root"], "ZZCO root: variant", SU["id"], qualifier="variant")[0]
        M = a._chart_map_name
        M(db, N["bg"], "ZZCO Shared", A, "add", SU["id"])            # step 2: this group's own
        M(db, N["all"], "ZZCO Shared", "", "add", SU["id"])          # step 3: every group
        M(db, N["all"], "ZZCO Everywhere", "", "add", SU["id"])
        M(db, N["alias"], "ZZCO Alias target", "", "add", SU["id"])  # step 4: the name it was merged into
        M(db, N["chain"], "ZZCO Chain end", "", "add", SU["id"])
        M(db, N["root"], "ZZCO Root", "", "add", SU["id"])           # step 5: the root, and the base
        M(db, V, "ZZCO Root: variant", "", "variant", SU["id"])
        M(db, N["base"], "ZZCO Base", "", "add", SU["id"])
        M(db, N["other"], "ZZCO Override me", "", "add", SU["id"])
        M(db, V, "ZZCO Vonly", "", "variant", SU["id"])              # a name that maps straight to a variant
        db.commit()
        idx = a._chart_index(db)
        AL = {(A, "zzco old name"): {"into_key": "zzco alias target"},
              (A, "zzco chain a"): {"into_key": "zzco chain b"}, (A, "zzco chain b"): {"into_key": "zzco chain end"},
              (A, "zzco loop a"): {"into_key": "zzco loop b"}, (A, "zzco loop b"): {"into_key": "zzco loop a"}}
        code_of = lambda **ln: a.chart_code_of_line(idx, ln, AL)   # noqa: E731
        node = lambda k: idx["nodes"][N[k]]["code"]               # noqa: E731
        vcode = idx["nodes"][V]["code"]
        s.check("the nodes got real codes (21 under Customer; 2101...; the variant 2103-01 style)",
                node("ovr").startswith("21") and "-" in vcode and vcode.startswith(node("root") + "-"),
                (node("ovr"), vcode))
        # 1. the override
        s.check("1. the line's own chart_node_id wins over a name that maps elsewhere",
                code_of(kpi_name="ZZCO Override me", business_group=A, chart_node_id=N["ovr"]) == node("ovr"))
        s.check("1. ...and without it the name map answers", code_of(kpi_name="ZZCO Override me", business_group=A) == node("other"))
        db.execute("UPDATE kpi_chart SET retired_at=datetime('now') WHERE id=?", (N["ovr"],))
        db.commit()
        idx = a._chart_index(db)
        s.check("1. a RETIRED node is still the line's own code (retire keeps the lines' codes), not the name map's node",
                code_of(kpi_name="ZZCO Override me", business_group=A, chart_node_id=N["ovr"]) == node("ovr"))
        db.execute("UPDATE kpi_chart SET archived_at=datetime('now') WHERE id=?", (N["ovr"],))
        db.commit()
        idx = a._chart_index(db)
        s.check("1. an ARCHIVED node is not an override: the line falls through to the name map",
                code_of(kpi_name="ZZCO Override me", business_group=A, chart_node_id=N["ovr"]) == node("other"))
        s.check("1. ...and an override naming no node at all falls through too",
                code_of(kpi_name="ZZCO Override me", business_group=A, chart_node_id=999999) == node("other"))
        # 2 and 3
        s.check("2. a group's own map beats the group-wide one", code_of(kpi_name="ZZCO Shared", business_group=A) == node("bg"))
        s.check("3. another group falls to the group-wide map", code_of(kpi_name="ZZCO Shared", business_group=B) == node("all"))
        s.check("3. ...a name only the group-wide map holds, in a group with no map of its own",
                code_of(kpi_name="  zzco   EVERYWHERE ", business_group=A) == node("all"))
        s.check("2/3. the key folds case and spaces like the library's (_kpi_key)",
                code_of(kpi_name="zzco SHARED", business_group=A) == node("bg"))
        # 4. alias
        s.check("4. a merged name reads as the name it went into", code_of(kpi_name="ZZCO Old Name", business_group=A) == node("alias"))
        s.check("4. ...in its own group only", code_of(kpi_name="ZZCO Old Name", business_group=B) is None)
        s.check("4. ...a merge into a merge is followed", code_of(kpi_name="ZZCO Chain A", business_group=A) == node("chain"))
        s.check("4. ...a loop of merges ends at nothing, not forever", code_of(kpi_name="ZZCO Loop A", business_group=A) is None)
        # 5. root and base
        s.check("5. 'Root: qualifier' with no map of its own gives the root's KPI",
                code_of(kpi_name="ZZCO Root: Plant 7", business_group=A) == node("root"))
        s.check("5. ...a name that maps straight to a variant is that variant (step 2)",
                code_of(kpi_name="ZZCO Vonly", business_group=A) == vcode)
        s.check("5. ...but the root of a name never gives a variant: a root mapped to one gives its KPI",
                code_of(kpi_name="ZZCO Vonly: Plant 7", business_group=A) == node("root"))
        s.check("5. 'KPI · Focus' gives the base's KPI", code_of(kpi_name="ZZCO Base · Elba", focus="Elba", business_group=A) == node("base"))
        s.check("5. ...only when the focus really ends the name (the base is not guessed)",
                code_of(kpi_name="ZZCO Base · Elba", focus="Other", business_group=A) is None)
        # 6. nothing
        s.check("6. a name nothing maps is None, 'Not in the chart yet'", code_of(kpi_name="ZZCO Mystery line", business_group=A) is None)
        s.check("6. ...and a blank name", code_of(kpi_name="", business_group=A) is None)
        # the batched read
        stmts = []
        db.set_trace_callback(stmts.append)
        lines3 = [{"kpi_name": "ZZCO Shared", "business_group": A}, {"kpi_name": "ZZCO Shared", "business_group": B},
                  {"kpi_name": "ZZCO Mystery line", "business_group": A}]
        out3 = a.chart_nodes_of_lines(db, lines3)
        n3 = len(stmts)
        stmts.clear()
        out300 = a.chart_nodes_of_lines(db, lines3 * 100)
        n300 = len(stmts)
        db.set_trace_callback(None)
        s.check("many lines at once: the same few statements for 3 lines as for 300 (one batched read)",
                n3 == n300 and n3 <= 3, (n3, n300))
        s.check("...in order, None where nothing maps", [(n or {}).get("code") for n in out3] == [node("bg"), node("all"), None]
                and len(out300) == 300)
        stmts.clear()
        db.set_trace_callback(stmts.append)
        a._chart_index(db)
        db.set_trace_callback(None)
        s.check("_chart_index reads the nodes and the name map in two statements", len(stmts) == 2, stmts)
        idx = a._chart_index(db)
        s.check("the index is keyed by id, code, parent and (name key, group)",
                idx["by_code"][node("bg")]["id"] == N["bg"] and any(k == N["root"] for k in [c["parent_id"] for c in idx["children"][N["root"]]])
                and idx["names"][("zzco shared", A)] == N["bg"] and idx["names"][("zzco shared", "")] == N["all"])
        # a line row through the column (pm_kpi_targets.chart_node_id)
        db.execute("UPDATE pm_kpi_targets SET chart_node_id=? WHERE kpi_name='ZZCO Mystery line'", (N["other"],))
        db.commit()
        row = db.execute("SELECT t.*, u.business_group AS business_group FROM pm_kpi_targets t JOIN users u ON u.id=t.subject_id "
                         "WHERE t.kpi_name='ZZCO Mystery line'").fetchone()
        s.check("a stored override is read from the line's own row", a.chart_code_of_line(idx, row, {}) == node("other"))
        db.execute("UPDATE pm_kpi_targets SET chart_node_id=NULL WHERE kpi_name='ZZCO Mystery line'")
        db.commit()
        _cleanup_chart(db)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the seed from today's library")
    with a.app.app_context():
        pre_lib = a.get_db().execute("SELECT COUNT(DISTINCT LOWER(kpi_name)) FROM pm_kpi_library WHERE business_group NOT IN (?,?)",
                                     (A, B)).fetchone()[0]
    if BGC:
        s.check("a BG admin's seed is a 403", post(BGC, {"action": "chart_seed"}).status_code == 403)
    s.check("...and wrote nothing", nodes_n() == 0)
    r = post(SUP, {"action": "chart_seed"})
    s.check("the super admin's seed redirects to the Chart view", r.status_code in (302, 303) and "view=chart" in r.headers["Location"],
            (r.status_code, r.headers.get("Location")))
    with a.app.app_context():
        db = a.get_db()
        node_of_name = lambda nm, bg="": db.execute(   # noqa: E731
            "SELECT n.* FROM kpi_chart_names m JOIN kpi_chart n ON n.id=m.node_id WHERE m.name_key=? AND m.business_group=?",
            (a._kpi_key(nm), bg)).fetchone()
        gp, co, sat = node_of_name("ZZCO Gross profit"), node_of_name("ZZCO Collections"), node_of_name("ZZCO Satisfaction")
        s.check("one KPI node per identity across ALL groups: Gross profit (in A and B) is one node",
                gp is not None and gp["level"] == "kpi" and db.execute(
                    "SELECT COUNT(*) FROM kpi_chart WHERE name='ZZCO Gross profit'").fetchone()[0] == 1)
        s.check("a Financial KPI sits in a group under perspective 1, Customer under 2",
                gp["code"].startswith("1") and sat["code"].startswith("2"), (gp["code"], sat["code"]))
        par = lambda n: db.execute("SELECT * FROM kpi_chart WHERE id=?", (n["parent_id"],)).fetchone()   # noqa: E731
        s.check("the group is the part after ' · ' (Profitability / Cash / Service), one group each",
                (par(gp)["name"], par(co)["name"], par(sat)["name"]) == ("ZZCO Profitability", "ZZCO Cash", "ZZCO Service")
                and par(gp)["level"] == "group" and par(gp)["id"] != par(co)["id"])
        s.check("a KPI's code is its group's code + 2 digits", re.fullmatch(r"%s\d\d" % par(gp)["code"], gp["code"]) is not None, gp["code"])
        s.check("the KPI keeps the library's definition", (gp["definition"] or "").startswith("Defines"), gp["definition"])
        s.check("the name map holds the identity key, group-wide, source 'seed'",
                db.execute("SELECT source FROM kpi_chart_names WHERE name_key='zzco gross profit' AND business_group=''").fetchone()["source"] == "seed")
        s.check("...and an alias key whose old name has a library row", node_of_name("ZZCO GP old")["id"] == gp["id"])
        s.check("...and an alias key that only pm_kpi_aliases knows, through a chain of merges",
                node_of_name("ZZCO GP ancient")["id"] == gp["id"])
        s.check("a KPI with no perspective stays unplaced", node_of_name("ZZCO Untagged") is None)
        s.check("...as does one tagged but with no group in its category", node_of_name("ZZCO Ungrouped") is None)
        idx = a._chart_index(db)
        AL = a._chart_aliases(db)
        s.check("a line named by an old name reads as the KPI it was merged into",
                a.chart_code_of_line(idx, {"kpi_name": "ZZCO GP old", "business_group": A}, AL) == gp["code"])
        s.check("...and one named for the KPI itself", a.chart_code_of_line(idx, {"kpi_name": "ZZCO Gross profit", "business_group": B}, AL) == gp["code"])
        s.check("a line in no library is not coded", a.chart_code_of_line(idx, {"kpi_name": "ZZCO Mystery line", "business_group": A}, AL) is None)
        log = db.execute("SELECT detail FROM activity_log WHERE action='pm_kpi_chart' AND id > ? ORDER BY id DESC LIMIT 1", (BASE_ACT,)).fetchone()
        s.check("the seed wrote an activity_log row with its counts",
                log is not None and "seeded" in log["detail"] and re.search(r"\d+ KPIs?", log["detail"]) and "Needs a place" in log["detail"],
                log["detail"] if log else None)
        n_nodes, n_names = nodes_n(), names_n()
    r2 = post(SUP, {"action": "chart_seed"})
    with a.app.app_context():
        s.check("a second run adds no node and no name (idempotent)", (nodes_n(), names_n()) == (n_nodes, n_names),
                ((nodes_n(), names_n()), (n_nodes, n_names)))
        msg2 = a.get_db().execute("SELECT detail FROM activity_log WHERE action='pm_kpi_chart' ORDER BY id DESC LIMIT 1").fetchone()[0]
        s.check("...and says so: 0 groups, 0 KPIs, 0 names", re.search(r"\b0 KPI groups?, 0 KPIs? and 0 names?", msg2) is not None, msg2)
        # a later merge adds only its alias key
        a.get_db().execute("INSERT INTO pm_kpi_aliases(business_group, alias_key, alias_name, into_key, into_name, kind) VALUES "
                           "(?, 'zzco gp newest', 'ZZCO GP newest', 'zzco gross profit', 'ZZCO Gross profit', 'dupe')", (B,))
        a.get_db().commit()
    post(SUP, {"action": "chart_seed"})
    with a.app.app_context():
        s.check("a name merged since is picked up by the next run: one name, no node",
                (nodes_n(), names_n()) == (n_nodes, n_names + 1), (nodes_n(), names_n()))
        # a spelling that is another KPI's own name goes into its group's map, not the group-wide one
        db = a.get_db()
        db.execute("INSERT INTO pm_kpi_aliases(business_group, alias_key, alias_name, into_key, into_name, kind) VALUES "
                   "(?, 'zzco collections', 'ZZCO Collections', 'zzco satisfaction', 'ZZCO Satisfaction', 'dupe')", (B,))
        db.commit()
    post(SUP, {"action": "chart_seed"})
    with a.app.app_context():
        db = a.get_db()
        own = db.execute("SELECT node_id FROM kpi_chart_names WHERE name_key='zzco collections' AND business_group=''").fetchone()
        s.check("a merged spelling that is also another KPI's own name stays out of the group-wide map",
                own is not None and own["node_id"] == node_of_name("ZZCO Collections")["id"])
        db.execute("DELETE FROM pm_kpi_aliases WHERE business_group=? AND alias_key IN ('zzco collections','zzco gp newest')", (B,))
        db.commit()

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the library page: the Chart switch, and Where used stays the default")
    where = page()
    s.check("the super admin gets the switch on the tree, 'Where used' active", 'class="coa-switch"' in where
            and re.search(r'<a class="active" href="[^"]*" aria-current="true">Where used</a>', where) is not None)
    s.check("...and the default is still today's tree ('The tree', the Used by column)", 'aria-label="The tree"' in where
            and "<span>Used by</span>" in where and "<span>Level · used by</span>" not in where)
    s.check("...Chart is one click: view=chart", 'href="/admin/performance/library?view=chart">Chart</a>' in where, "view=chart" in where)
    if BGC:
        bgp = page(BGC)
        s.check("a BG admin never sees the switch, flag on or off", "coa-switch" not in bgp and "view=chart" not in bgp)
        s.check("...and ?view=chart changes nothing for them", unnext(page(BGC, view="chart")) == unnext(bgp))

    s.section("the Chart view")
    ch = page(view="chart")
    s.check("the tree is the chart, the switch has Chart active", 'aria-label="The chart"' in ch
            and re.search(r'<a class="active" href="[^"]*" aria-current="true">Chart</a>', ch) is not None)
    s.check("the tree opens with Whole chart (a count), then Perspectives", re.search(r"Whole chart</span><span class=\"kl-n\">\d+</span>", ch)
            and "Perspectives" in ch)
    s.check("a perspective shows as '1. Financial'", '<span class="coa-c">1.</span>Financial' in ch, "coa-c" in ch)
    s.check("...all four, in order", all('<span class="coa-c">%d.</span>%s' % (i, n.replace("&", "&amp;")) in ch
                                         for i, n in enumerate(a.PM_PERSPECTIVES, 1)))
    s.check("'Not in the chart yet' holds 'Needs a place' with the unplaced count",
            re.search(r"Not in the chart yet</span>\s*<a [^>]*>\s*<span>Needs a place</span><span class=\"kl-n\">(\d+)</span>", ch) is not None)
    with a.app.app_context():
        db = a.get_db()
        gp = db.execute("SELECT n.* FROM kpi_chart_names m JOIN kpi_chart n ON n.id=m.node_id WHERE m.name_key='zzco gross profit' "
                        "AND m.business_group=''").fetchone()
        grp = db.execute("SELECT * FROM kpi_chart WHERE id=?", (gp["parent_id"],)).fetchone()
        var_id, var_code = a._chart_add_node(db, "variant", gp["id"], "ZZCO Gross profit: Plant", SU["id"], qualifier="Plant")
        a._chart_map_name(db, var_id, "ZZCO Gross profit: Plant", "", "variant", SU["id"])
        db.commit()
    s.check("the first variant's code is the KPI's + -01", var_code == gp["code"] + "-01", var_code)
    p1 = page(view="chart", cn="p:1")
    s.check("a perspective's groups show under it as '11. Profitability'",
            re.search(r'<span class="coa-c">%s\.</span>ZZCO Profitability' % grp["code"], p1) is not None)
    s.check("the list's head: Code | KPI | Level · used by | Target",
            all("<span>%s</span>" % x in p1 for x in ("Code", "KPI", "Level · used by", "Target")))
    s.check("...in a body that scrolls inside the card", 'class="coa-body"' in p1 and ".coa-body" in open(os.path.join(H.REPO, "static/style.css")).read()
            and "overflow-y: auto" in open(os.path.join(H.REPO, "static/style.css")).read().split(".coa-body {", 1)[1].split("}", 1)[0])
    s.check("...tree and list both 720px tall", ".coa-grid .kl-tree, .coa-grid .kl-node { height: 720px;" in open(os.path.join(H.REPO, "static/style.css")).read())
    s.check("the KPI's code is drawn, its group heading reads '11. Profitability'",
            ('<span class="coa-code">%s</span>' % gp["code"]) in p1 and ('<div class="kl-grp">%s. ZZCO Profitability</div>' % grp["code"]) in p1)
    s.check("the variant sits under its KPI with its own code, indented",
            re.search(r'<div class="kl-row coa-row is-sub[^"]*">\s*<span class="coa-code is-sub">%s</span>' % re.escape(var_code), p1) is not None
            and p1.index('>%s</span>' % gp["code"]) < p1.index('>%s</span>' % var_code))
    s.check("...and the KPI says it has one variant", "1 variant" in p1)
    m = re.search(r'<span class="coa-code">%s</span>(.*?)</div>' % re.escape(gp["code"]), p1, re.S)
    row_html = m.group(1) if m else ""
    s.check("Level · used by: the derived level over a muted people line, the full text in title",
            "<b>Global</b>" in row_html and re.search(r'<span class="muted small" title="4 people · 2 BGs · 3 units">4 people · 2 BGs · 3 units</span>', row_html) is not None)
    s.check("Target: a BU-level KPI says so", "BU target, set in the Early Year" in row_html and "BU-level" in row_html)
    s.check("Open opens today's KPI panel, keeping the chart view", 'kpi=zzco+gross+profit&amp;panel=kpi' in row_html
            and "view=chart" in row_html)
    pk = page(view="chart", cn="p:1", kpi="zzco gross profit", panel="kpi")
    s.check("...and the panel opens (its definition, placed at)", 'id="pnl-kpi"' in pk and "Placed at" in pk and 'is-open' in pk)
    g1 = listing(page(view="chart", cn="g:" + grp["code"]))
    s.check("a group's own list shows only its KPIs (Collections is in another group)", "ZZCO Collections" not in g1 and "ZZCO Gross profit" in g1)
    s.check("a group's heading in a perspective's list is the group; in the whole chart it is 'perspective › group'",
            ("%s. ZZCO Profitability" % grp["code"]) in g1 and "1. Financial › %s. ZZCO Profitability" % grp["code"] in page(view="chart"))
    none = listing(page(view="chart", cn="none"))
    s.check("Needs a place lists the unplaced KPIs with no code",
            "ZZCO Untagged" in none and "ZZCO Ungrouped" in none and "ZZCO Gross profit" not in none and "<span class=\"coa-code\">—</span>" in none)
    s.check("...untagged says so", "not tagged" in none)
    srch = listing(page(view="chart", q="gp ancient"))
    s.check("search finds a KPI by an old name that was merged into it", "ZZCO Gross profit" in srch and "ZZCO Collections" not in srch)
    byc = listing(page(view="chart", q=gp["code"]))
    s.check("search finds a code", "ZZCO Gross profit" in byc and "ZZCO Satisfaction" not in byc)
    s.check("an unknown node falls back to the whole chart", "Whole chart" in page(view="chart", cn="zz") and "Whole chart</b>" in page(view="chart", cn="zz"))
    s.check("the line coverage reads: lines with a code of all lines", re.search(r"\d+ of \d+ KPI lines have a code|All \d+ KPI lines have a code", ch) is not None)
    retired = listing(page(view="chart", status="retired"))
    s.check("the Retired tab lists none of the in-use KPIs (the old name's retired row folds into Gross profit)",
            "ZZCO Satisfaction" not in retired and "ZZCO Gross profit" not in retired)
    with a.app.app_context():
        a.get_db().execute("UPDATE pm_kpi_library SET active=0 WHERE kpi_name='ZZCO Satisfaction'")
        a.get_db().commit()
    retired = listing(page(view="chart", status="retired"))
    s.check("...a KPI whose library rows are all retired moves to the Retired tab and leaves In use",
            "ZZCO Satisfaction" in retired and "ZZCO Satisfaction" not in listing(page(view="chart")))
    with a.app.app_context():
        a.get_db().execute("UPDATE pm_kpi_library SET active=1 WHERE kpi_name='ZZCO Satisfaction'")
        a.get_db().commit()

    s.section("every form is double-confirmed; nothing is a typed list value")
    forms = re.findall(r"<form\b[^>]*>", ch)
    posts = [f for f in forms if re.search(r'method="post"', f, re.I) and 'class="logout-form"' not in f]   # the sign-out menu is app chrome
    s.check("the Chart view has POST forms (the seed and the three actions)", len(posts) >= 4, len(posts))
    s.check("...each carries data-confirm", all("data-confirm=" in f for f in posts), [f[:80] for f in posts if "data-confirm=" not in f])
    s.check("...the seed names what it does, with a titled button", "data-confirm-title=\"Seed the chart?\"" in ch and "data-confirm-ok=\"Seed the chart\"" in ch)
    s.check("a group name is typed as group_name / node_name, never as category, department or the like",
            not re.search(r'<input\b[^>]*\bname="(category|department|departments|job_title|job_grades|segment|dept)"', ch)
            and 'name="group_name"' in ch and 'name="node_name"' in ch)
    s.check("a perspective and a group are PICKED (selects of ids), never typed", re.search(r'<select name="parent_id"', ch) and
            re.search(r'<select name="node_id"', ch))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("chart groups: add, rename a group, rename a KPI")
    with a.app.app_context():
        db = a.get_db()
        P = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM kpi_chart WHERE level='persp'")}
        n0 = nodes_n()
    if BGC:
        r = post(BGC, {"action": "chart_group_add", "parent_id": str(P["4"]), "group_name": "ZZCO Learning"})
        s.check("a BG admin cannot add a group (403)", r.status_code == 403)
    r = post(SUP, {"action": "chart_group_add", "parent_id": str(P["4"]), "group_name": "  ZZCO   Learning  "})
    with a.app.app_context():
        db = a.get_db()
        lg = db.execute("SELECT * FROM kpi_chart WHERE level='group' AND parent_id=?", (P["4"],)).fetchone()
        s.check("the super admin adds a group under a perspective: the next code, the name's spaces folded",
                lg is not None and lg["code"] == "41" and lg["name"] == "ZZCO Learning" and nodes_n() == n0 + 1, dict(lg) if lg else None)
        s.check("...and it is in the activity log", db.execute("SELECT 1 FROM activity_log WHERE action='pm_kpi_chart' AND detail LIKE '%added KPI group 41%'").fetchone() is not None)
    s.check("...and the Chart shows it as '41. ZZCO Learning' under 4", '<span class="coa-c">41.</span>ZZCO Learning' in page(view="chart", cn="p:4"))
    n1 = None
    with a.app.app_context():
        n1 = nodes_n()
    for label, data in (("a blank name", {"action": "chart_group_add", "parent_id": str(P["4"]), "group_name": "   "}),
                        ("a name over 120 characters", {"action": "chart_group_add", "parent_id": str(P["4"]), "group_name": "x" * 121}),
                        ("a name already used there", {"action": "chart_group_add", "parent_id": str(P["4"]), "group_name": "zzco learning"})):
        r = post(SUP, data)
        with a.app.app_context():
            s.check("%s adds nothing (and says why)" % label, nodes_n() == n1 and r.status_code in (302, 303), nodes_n())
    s.check("an unknown perspective id is a 400", post(SUP, {"action": "chart_group_add", "parent_id": "999999", "group_name": "ZZCO x"}).status_code == 400)
    s.check("...a group's id given as a perspective is a 400", post(SUP, {"action": "chart_group_add", "parent_id": str(lg["id"]), "group_name": "ZZCO x"}).status_code == 400)
    s.check("...a missing or non-numeric one", post(SUP, {"action": "chart_group_add", "group_name": "ZZCO x"}).status_code == 400
            and post(SUP, {"action": "chart_group_add", "parent_id": "abc", "group_name": "ZZCO x"}).status_code == 400)
    with a.app.app_context():
        s.check("...none of them wrote", nodes_n() == n1)
    # full perspective: 9 groups
    with a.app.app_context():
        db = a.get_db()
        for i in range(8):
            a._chart_add_node(db, "group", P["4"], "ZZCO fill %d" % i, SU["id"])
        db.commit()
        n2 = nodes_n()
    r = post(SUP, {"action": "chart_group_add", "parent_id": str(P["4"]), "group_name": "ZZCO Tenth"})
    with a.app.app_context():
        s.check("a tenth group is refused through the page too, with the limit in the message", nodes_n() == n2
                and "9 KPI groups" in " ".join(re.findall(r'class="flash[^"]*"[^>]*>(.*?)<', page(view="chart"), re.S)), nodes_n())
    # rename a group
    r = post(SUP, {"action": "chart_group_rename", "node_id": str(lg["id"]), "group_name": "ZZCO Learning & growth"})
    with a.app.app_context():
        db = a.get_db()
        g2 = db.execute("SELECT * FROM kpi_chart WHERE id=?", (lg["id"],)).fetchone()
        s.check("a group is renamed and its code never changes", g2["name"] == "ZZCO Learning & growth" and g2["code"] == "41" and g2["updated_by"] == SU["id"], dict(g2))
        s.check("...and logged", db.execute("SELECT 1 FROM activity_log WHERE action='pm_kpi_chart' AND detail LIKE '%renamed KPI group 41%'").fetchone() is not None)
    for label, data in (("a blank new name", {"action": "chart_group_rename", "node_id": str(lg["id"]), "group_name": " "}),
                        ("a name another group there already has", {"action": "chart_group_rename", "node_id": str(lg["id"]), "group_name": "zzco fill 0"}),
                        ("the same name", {"action": "chart_group_rename", "node_id": str(lg["id"]), "group_name": "ZZCO Learning & growth"})):
        post(SUP, data)
        with a.app.app_context():
            s.check("%s changes nothing" % label, a.get_db().execute("SELECT name FROM kpi_chart WHERE id=?", (lg["id"],)).fetchone()[0] == "ZZCO Learning & growth")
    s.check("a KPI's id given to rename a group is a 400", post(SUP, {"action": "chart_group_rename", "node_id": str(gp["id"]), "group_name": "ZZCO x"}).status_code == 400)
    s.check("...and a perspective's", post(SUP, {"action": "chart_group_rename", "node_id": str(P["1"]), "group_name": "ZZCO x"}).status_code == 400)
    if BGC:
        s.check("a BG admin cannot rename (403)", post(BGC, {"action": "chart_group_rename", "node_id": str(lg["id"]), "group_name": "ZZCO x"}).status_code == 403)
    # rename a KPI node
    post(SUP, {"action": "chart_kpi_rename", "node_id": str(gp["id"]), "node_name": "ZZCO Gross profit (GP)"})
    with a.app.app_context():
        db = a.get_db()
        k2 = db.execute("SELECT * FROM kpi_chart WHERE id=?", (gp["id"],)).fetchone()
        s.check("a KPI node is renamed; its code never changes", k2["name"] == "ZZCO Gross profit (GP)" and k2["code"] == gp["code"], dict(k2))
        s.check("...the name map and the library are untouched (lines keep their own words)",
                db.execute("SELECT COUNT(*) FROM kpi_chart_names WHERE node_id=? AND name_shown='ZZCO Gross profit'", (gp["id"],)).fetchone()[0] == 1
                and db.execute("SELECT COUNT(*) FROM pm_kpi_library WHERE kpi_name='ZZCO Gross profit'").fetchone()[0] == 2)
        s.check("...and logged", db.execute("SELECT 1 FROM activity_log WHERE action='pm_kpi_chart' AND detail LIKE ?", ("%renamed KPI " + gp["code"] + "%",)).fetchone() is not None)
    s.check("a group's id given to rename a KPI is a 400", post(SUP, {"action": "chart_kpi_rename", "node_id": str(lg["id"]), "node_name": "ZZCO x"}).status_code == 400)
    blank = post(SUP, {"action": "chart_kpi_rename", "node_id": str(gp["id"]), "node_name": ""})
    with a.app.app_context():
        s.check("a blank KPI name changes nothing", blank.status_code in (302, 303)
                and a.get_db().execute("SELECT name FROM kpi_chart WHERE id=?", (gp["id"],)).fetchone()[0] == "ZZCO Gross profit (GP)")
    if BGC:
        s.check("a BG admin cannot rename a KPI (403)", post(BGC, {"action": "chart_kpi_rename", "node_id": str(gp["id"]), "node_name": "ZZCO x"}).status_code == 403)
    s.check("an unknown chart action is a 400", post(SUP, {"action": "chart_nope"}).status_code == 400)
    s.check("the chart actions need the CSRF token like every write", SUP.post(LIBURL, data={"action": "chart_seed"}).status_code in (400, 403))

    s.section("the access map and the code stay in line")
    src = H.source(a)
    s.check("the library route is still the super admin's in ADMIN_ACCESS_MAP", '"admin_kpi_library", "admin_kpi_library_import"' in src)
    s.check("no new route was added for the chart (it posts through the library page)", len(re.findall(r'@app\.route\("[^"]*chart[^"]*"', src)) == 0)
    s.check("a chart action is gated by the flag before the super check", src.index('startswith("chart_") and not coa_on()') < src.index("if not is_super(me):   # the super admin edits the libraries"))
finally:
    if FLAG0 is None:
        os.environ.pop("ONEHR_COA", None)
    else:
        os.environ["ONEHR_COA"] = FLAG0
    with a.app.app_context():
        _db = a.get_db()
        _cleanup(_db)
        left = (_db.execute("SELECT COUNT(*) FROM kpi_chart WHERE id > ?", (BASE_NODE,)).fetchone()[0]
                + _db.execute("SELECT COUNT(*) FROM kpi_chart_names WHERE id > ?", (BASE_NAME,)).fetchone()[0])
    s.check("everything the suite made was put back", left == 0, left)

sys.exit(s.done())
