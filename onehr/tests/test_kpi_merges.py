"""The KPI library redesign, part 2: the merge queue (Chris, 2026-10-18, the libraries canvas board 3).

What this suite holds:
  * the suggestions, per group: one measure at several scopes (Plant / Company GP and GP), variants ("KPI: qualifier",
    two of them, or one whose KPI exists), near-duplicate wording (an abbreviation in brackets); a lone name is none
  * only the super admin settles one; a group's admin sees the queue, can't post
  * keep apart: the suggestion goes, nothing else changes
  * grouping scopes keeps every row as it is (the BU-level mark too, so HR's unit result is still recognised by name)
    and the tree reads them as one KPI, the usage of each old name counted to it
  * merging variants retires their rows into the KPI (made from the first when it isn't there), each old name kept as
    an alias with its qualifier; a near-duplicate needs the name chosen; a BU-level row is never retired
  * the library's tab counts the queue; the KPI's panel lists the old names merged into it
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The KPI library's merge queue")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG = "ZZKM Group"


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9KM-%'")]
    # library rows and aliases first: a row an admin of the suite wrote points at them (created_by)
    db.execute("DELETE FROM pm_kpi_aliases WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE action='pm_kpi_library' AND detail LIKE '%ZZKM%'")
    db.execute("DELETE FROM pm_kpi_aliases WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_kpi_merge_apart WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'ZZKM Unit')", (BG,))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
    for nm, bu, cat in (("Plant gross profit (GP)", 0, "Financial · Profitability"),
                        ("Company gross profit (GP)", 1, "Financial · Profitability"),
                        ("Gross profit (GP)", 0, "Financial · Profitability"),
                        ("ZZKM Channel sales: A tier", 0, "Customer · Sales"),
                        ("ZZKM Channel sales: B tier", 0, "Customer · Sales"),
                        ("ZZKM Close time", 0, "Financial · Reporting"),
                        ("ZZKM Close time: Day 1 closing", 0, "Financial · Reporting"),
                        ("ZZKM Net promoter score (NPS)", 0, "Customer · Satisfaction"),
                        ("ZZKM Net promoter score", 0, "Customer · Satisfaction"),
                        ("ZZKM Unit result: plant A", 1, "Financial · Profitability"),
                        ("ZZKM Unit result: plant B", 0, "Financial · Profitability"),
                        ("ZZKM Lonely KPI", 0, "Operations · Quality")):
        db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, "
                   "category, description, unit, method, bu_level, perspective) VALUES (?, '*', '*', 0, '*', ?, ?, ?, "
                   "'RM', 'more', ?, 'Financial')", (BG, nm, cat, "definition of " + nm, bu))
    P = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                   "job_grade, confirmation_date) VALUES ('zz9km-p', 'ZZ KM P', 'x', 'user', 'ZZ9KM-P', ?, "
                   "'ZZKM Unit', '14', '2020-01-01')", (BG,)).lastrowid
    for nm in ("Company gross profit (GP)", "ZZKM Channel sales: A tier"):
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, "
                   "rate4, rate5, business_group, company) VALUES (?,?,?, 10, 'more', 1,2,3,4,5, ?, 'ZZKM Unit')",
                   (CID, P, nm, BG))
    BGADM = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                       "admin_bg) VALUES ('zz9km-adm', 'ZZ KM Admin', 'x', 'admin', 'ZZ9KM-ADM', ?, ?)",
                       (BG, BG)).lastrowid
    db.commit()
SUP = H.client_as(a, SU["id"])


def sugg():
    with a.app.app_context():
        return [x for x in a._kpi_merge_suggestions(a.get_db(), [BG])]


def find(kind, contains):
    return next((x for x in sugg() if x["kind"] == kind and any(contains in n for n in x["names"])), None)


def post(x, action="merge", client=None, **extra):
    d = {"csrf_token": "tok", "action": action, "sig": x["sig"], "bg": x["bg"]}
    d.update(extra)
    return (client or SUP).post("/admin/performance/library/merges", data=d, follow_redirects=True)


def active(nm):
    r = H.rows(a, "SELECT active, bu_level FROM pm_kpi_library WHERE business_group=? AND kpi_name=?", (BG, nm))
    return tuple(r[0]) if r else None


try:
    s.section("the suggestions")
    sc = find("scope", "Plant gross")
    s.check("one measure at three scopes -> the plain name, BU-level mixed", sc and sc["names"] == [
        "Company gross profit (GP)", "Gross profit (GP)", "Plant gross profit (GP)"] and sc["into"] == "Gross profit (GP)"
        and sc["bu_mixed"], sc)
    va = find("variant", "Channel sales")
    s.check("two variants with no KPI yet -> the KPI, each qualifier a Focus", va and va["into"] == "ZZKM Channel sales"
            and va["focus"] == ["A tier", "B tier"] and not va["parent_exists"], va)
    vb = find("variant", "Close time")
    s.check("one variant whose KPI exists -> that KPI", vb and vb["names"] == ["ZZKM Close time: Day 1 closing"]
            and vb["parent_exists"], vb)
    du = find("dupe", "Net promoter")
    s.check("the same words but for a bracketed abbreviation: near-duplicate, the admin chooses", du and len(
        du["names"]) == 2 and du["into"] is None, du)
    s.check("a lone name is no suggestion", not any("Lonely" in n for x in sugg() for n in x["names"]))
    pg = SUP.get("/admin/performance/library/merges").get_data(as_text=True)
    s.check("the queue lists them, each settled through a confirm box", "ZZKM Channel sales: A tier" in pg
            and pg.count('data-confirm="Keep') >= 4 and 'name="into"' in pg)
    s.check("the library's tab counts the queue", "Merge queue · " in SUP.get(
        "/admin/performance/library").get_data(as_text=True))

    s.section("who settles them")
    BA = H.client_as(a, BGADM)
    pg = BA.get("/admin/performance/library/merges").get_data(as_text=True)
    s.check("a group's admin sees the queue, without the buttons", "ZZKM Channel sales: A tier" in pg
            and 'value="merge"' not in pg)
    r = post(va, client=BA)
    s.check("...and can't post one", r.status_code == 403 and active("ZZKM Channel sales: A tier") == (1, 0))

    s.section("keep apart")
    post(du, action="apart")
    s.check("the suggestion goes, nothing else changes", find("dupe", "Net promoter") is None
            and active("ZZKM Net promoter score") == (1, 0) and active("ZZKM Net promoter score (NPS)") == (1, 0))

    s.section("grouping one measure's scopes")
    post(sc)
    s.check("every row stays as it is, the BU-level mark included", active("Company gross profit (GP)") == (1, 1)
            and active("Plant gross profit (GP)") == (1, 0) and active("Gross profit (GP)") == (1, 0))
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        pu = d_.execute("SELECT * FROM users WHERE id=?", (P,)).fetchone()
        bun = a.pm_bu_level_names(d_, pu)
        ix = a._kpi_lib_index(d_, [BG])["ids"]
    s.check("...so HR's unit result is still recognised by name", "company gross profit (gp)" in bun)
    g = ix.get("gross profit (gp)")
    s.check("the tree reads them as one KPI with three placements", g and len(g["rows"]) == 3
            and "plant gross profit (gp)" not in ix and "company gross profit (gp)" not in ix)
    s.check("...the old names listed, each placement with its scope", g and sorted(g["aliases"]) == [
        "Company gross profit (GP)", "Plant gross profit (GP)"] and sorted(
        (x["scope_word"] or "") for x in g["rows"]) == ["", "company", "plant"])
    s.check("...and an old name's line counts to it", g and g["n_people"] == 1 and g["lines"] == 1)
    s.check("settled: no longer suggested", find("scope", "Plant gross") is None)

    s.section("merging variants")
    post(va)
    s.check("the KPI is made, for the whole group, from the first variant", active("ZZKM Channel sales") == (1, 0)
            and H.one(a, "SELECT category FROM pm_kpi_library WHERE business_group=? AND kpi_name='ZZKM Channel sales'",
                      (BG,)) == "Customer · Sales")
    s.check("the variants' rows are retired into it", active("ZZKM Channel sales: A tier") == (0, 0)
            and active("ZZKM Channel sales: B tier") == (0, 0))
    al = dict(H.rows(a, "SELECT alias_name, qualifier FROM pm_kpi_aliases WHERE business_group=? AND kind='variant'",
                     (BG,)))
    s.check("each old name kept as an alias, its qualifier for the line's Focus", al == {
        "ZZKM Channel sales: A tier": "A tier", "ZZKM Channel sales: B tier": "B tier"}, al)
    with a.app.app_context():
        ix = a._kpi_lib_index(a.get_db(), [BG])["ids"]
    cs = ix.get("zzkm channel sales")
    s.check("the tree reads one KPI, in use, the old name's line counted", cs and cs["active"] and cs["n_people"] == 1
            and "zzkm channel sales: a tier" not in ix)
    pg = SUP.get("/admin/performance/library?kpi=zzkm+channel+sales&panel=kpi&node=bg:" + BG).get_data(as_text=True)
    s.check("its panel lists the old names merged into it", "Old names merged into it" in pg
            and "ZZKM Channel sales: B tier" in pg)

    s.section("near-duplicates and BU-level rows")
    with a.app.app_context():
        a.get_db().execute("DELETE FROM pm_kpi_merge_apart WHERE business_group=?", (BG,))
        a.get_db().commit()
    du = find("dupe", "Net promoter")
    post(du)
    s.check("a near-duplicate without a chosen name changes nothing", active("ZZKM Net promoter score") == (1, 0)
            and active("ZZKM Net promoter score (NPS)") == (1, 0))
    post(du, into="ZZKM Net promoter score (NPS)")
    s.check("with it: the chosen name stays, the other is retired into it", active(
        "ZZKM Net promoter score (NPS)") == (1, 0) and active("ZZKM Net promoter score") == (0, 0))
    ub = find("variant", "Unit result")
    out = post(ub)
    s.check("a BU-level row is never retired into another (told why)", active("ZZKM Unit result: plant A") == (1, 1)
            and "BU-level" in out.get_data(as_text=True) and not H.rows(
                a, "SELECT 1 FROM pm_kpi_library WHERE business_group=? AND kpi_name='ZZKM Unit result'", (BG,)))
    s.check("every merge is in the trail", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_kpi_library' "
                                                    "AND detail LIKE 'merged in ZZKM%'") == 3)

    s.section("a chain of merges")
    with a.app.app_context():   # a plant's variant merged into Plant GP, which is grouped into GP above
        d_ = a.get_db()
        d_.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, unit, "
                   "method, active) VALUES (?, '*', '*', 0, '*', 'Plant gross profit (GP): Meranti', 'RM', 'more', 0)",
                   (BG,))
        d_.execute("INSERT INTO pm_kpi_aliases(business_group, alias_key, alias_name, into_key, into_name, kind, "
                   "qualifier) VALUES (?, 'plant gross profit (gp): meranti', 'Plant gross profit (GP): Meranti', "
                   "'plant gross profit (gp)', 'Plant gross profit (GP)', 'variant', 'Meranti')", (BG,))
        d_.commit()
        ix = a._kpi_lib_index(d_, [BG])["ids"]
    s.check("the tree follows it to the last name", "plant gross profit (gp)" not in ix
            and "Plant gross profit (GP): Meranti" in ix["gross profit (gp)"]["aliases"])
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
