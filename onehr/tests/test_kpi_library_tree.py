"""The KPI library redesign, part 1: the tree and the KPI panel (Chris, 2026-10-18, the libraries canvas boards 1-2;
"Library redesign recommendation 2026-10-18.md").

What this suite holds:
  * each KPI files at the widest level its meaning holds, from the library and the usage cycle's lines: Global (two or
    more groups), a job family (70%+ of 3+ holders, with its main specialisation), a group (2+ units, or nobody yet),
    a unit (one unit's 3+ people); 1-2 holders go to their job family, tagged Specialised; a BU-level result is Global
    or its group
  * the page: the tree's nodes list their KPIs (a group node includes its units'), Specialised hidden until asked,
    retired ones on their own tab, the perspective and family filters and search, the balance bar
  * the KPI panel: its definition, its placements (one per library row, both groups), who uses it, its trail
  * a variant ("<root>: <qualifier>", 2026-11-06) rides under its root, display only: not in the tree's counts, filed where the root
    is, found by its own name (the parent shows), counted in the head and the parent's sub-line, linked both ways in the panel; a
    variant with no root in the library stays a row of its own
  * the form: no scale (the library holds no targets), a row keeps the figures it has; the perspective saved and
    checked; a BG admin sees only their group
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The KPI library redesign: the tree, the levels, the KPI panel")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
A, B = "ZZKL Group A", "ZZKL Group B"
LIB = {}


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9KL-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE action='pm_kpi_library' AND detail LIKE '%ZZKL%'")
    db.execute("DELETE FROM ja_people WHERE employee_id LIKE 'ZZ9KL-%'")
    db.execute("DELETE FROM ja_taxonomy WHERE code LIKE 'ZQK%'")
    db.execute("DELETE FROM pm_kpi_aliases WHERE business_group IN (?,?)", (A, B))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group IN (?,?)", (A, B))
    db.execute("DELETE FROM pm_bg_config WHERE business_group IN (?,?)", (A, B))
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (A, B))
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'U1'),(?, 'U2'),(?, 'U9')", (A, A, B))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A'),(?, 'A')", (A, B))
    for code, lvl, parent, name in (("ZQK", "family", None, "ZQK Family"), ("ZQK-FIN", "sub", "ZQK", "ZQK Finance"),
                                    ("ZQK-FIN-01", "spec", "ZQK-FIN", "ZQK Credit Control"),
                                    ("ZQK-SAL", "sub", "ZQK", "ZQK Sales"), ("ZQK-SAL-01", "spec", "ZQK-SAL", "ZQK B2B")):
        db.execute("INSERT INTO ja_taxonomy(code, level, parent_code, name) VALUES (?,?,?,?)", (code, lvl, parent, name))
    U = {}
    # (eid, group, unit, family)
    for eid, bg, co, fam in (("ZZ9KL-1", A, "U1", "FIN"), ("ZZ9KL-2", A, "U1", "FIN"), ("ZZ9KL-3", A, "U2", "FIN"),
                             ("ZZ9KL-4", B, "U9", "SAL"), ("ZZ9KL-5", A, "U1", "SAL"), ("ZZ9KL-6", B, "U9", "FIN"),
                             ("ZZ9KL-7", A, "U2", "SAL")):
        U[eid] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                            "company, job_grade, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?, '14', "
                            "'2020-01-01')", (eid.lower(), "ZZ KL " + eid[-1], eid, bg, co)).lastrowid
        db.execute("INSERT INTO ja_people(employee_id, family_code, sub_code, spec_code, source, version) VALUES "
                   "(?, 'ZQK', ?, ?, 'test', 't')", (eid, "ZQK-" + fam, "ZQK-%s-01" % fam))

    def lib(name, bg, bu=0, active=1, persp=None, desc=None, co="*"):
        rid = db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, "
                         "category, description, unit, method, rate1, rate2, rate3, rate4, rate5, bu_level, active, "
                         "perspective) VALUES (?, ?, '*', 0, '*', ?, 'Financial · Profitability', ?, 'RM', 'more', "
                         "1, 2, 3, 4, 5, ?, ?, ?)", (bg, co, name, desc, bu, active, persp)).lastrowid
        LIB.setdefault(name, []).append(rid)

    def holds(name, *eids):
        for e in eids:
            db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, "
                       "rate3, rate4, rate5, business_group, company) SELECT ?, id, ?, 10, 'more', 1,2,3,4,5, "
                       "business_group, company FROM users WHERE employee_id=?", (CID, name, e))
    lib("ZZKL PAT", A, bu=1, persp="Financial", desc="Profit after tax of the unit")
    lib("ZZKL PAT", B, bu=1, persp="Financial")
    holds("ZZKL PAT", "ZZ9KL-1", "ZZ9KL-4", "ZZ9KL-6")
    lib("ZZKL Collection", A, persp="Financial")
    lib("ZZKL Collection", B, persp="Financial")
    holds("ZZKL Collection", "ZZ9KL-1", "ZZ9KL-2", "ZZ9KL-3", "ZZ9KL-4")          # 3 of 4 in Finance: 75%
    lib("ZZKL DSO", A, persp="Customer")
    lib("ZZKL DSO", B)
    holds("ZZKL DSO", "ZZ9KL-1", "ZZ9KL-2", "ZZ9KL-4", "ZZ9KL-5")                  # 2 Finance, 2 Sales
    lib("ZZKL Plant output", A, persp="Internal Process")
    holds("ZZKL Plant output", "ZZ9KL-1", "ZZ9KL-5", "ZZ9KL-7")                   # A only, U1 and U2, mixed
    lib("ZZKL Branch GP", A)
    holds("ZZKL Branch GP", "ZZ9KL-1", "ZZ9KL-2", "ZZ9KL-5")                      # A, U1 only, mixed
    lib("ZZKL Oneoff", A)
    holds("ZZKL Oneoff", "ZZ9KL-5")                                              # one holder, Sales
    lib("ZZKL Unused", A)
    lib("ZZKL Retired", A, active=0)
    BGADM = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                       "admin_bg) VALUES ('zz9kl-adm', 'ZZ KL Admin', 'x', 'admin', 'ZZ9KL-ADM', ?, ?)", (B, B)).lastrowid
    db.commit()
SUP = H.client_as(a, SU["id"])


def page(**args):
    from urllib.parse import urlencode
    return SUP.get("/admin/performance/library?" + urlencode(args)).get_data(as_text=True)


def node_rows(html):
    return html.split('aria-label="KPIs at', 1)[1].split("</section>", 1)[0] if 'aria-label="KPIs at' in html else ""


try:
    s.section("the levels")
    with a.app.app_context():
        ix = a._kpi_lib_index(a.get_db(), [A, B])["ids"]
    lv = {k: (ix[k]["level"], ix[k]["where"]) for k in ix}
    s.check("a BU-level result used in two groups is Global", lv["zzkl pat"] == ("global", None), lv.get("zzkl pat"))
    s.check("75% of 4 holders in one job family: that family, with its specialisation", lv["zzkl collection"] == (
        "jf", "ZQK-FIN") and ix["zzkl collection"]["spec"] == "ZQK-FIN-01", lv.get("zzkl collection"))
    s.check("split across families, in two groups: Global", lv["zzkl dso"] == ("global", None), lv.get("zzkl dso"))
    s.check("one group, two units, mixed families: the group", lv["zzkl plant output"] == ("bg", A))
    s.check("one unit's 3 people, mixed families: the unit", lv["zzkl branch gp"] == ("bu", (A, "U1")),
            lv.get("zzkl branch gp"))
    s.check("one holder: their job family, tagged Specialised", lv["zzkl oneoff"] == ("jf", "ZQK-SAL")
            and ix["zzkl oneoff"]["specialised"])
    s.check("nobody yet, the whole group: the group", lv["zzkl unused"] == ("bg", A))
    s.check("usage is counted per person, group and unit", (ix["zzkl collection"]["n_people"], ix["zzkl collection"][
        "n_bgs"], ix["zzkl collection"]["n_units"]) == (4, 2, 3))

    s.section("the page")
    g = node_rows(page(node="global"))
    s.check("Global lists PAT and DSO, not the family's or the group's", "ZZKL PAT" in g and "ZZKL DSO" in g
            and "ZZKL Collection" not in g and "ZZKL Plant output" not in g)
    s.check("...PAT reads BU-level, with its target set in the Early Year", "BU-level" in g
            and "BU target, set in the Early Year" in g)
    jf = node_rows(page(node="jf:ZQK-FIN"))
    s.check("the job family lists Collection", "ZZKL Collection" in jf and "ZZKL DSO" not in jf)
    sp = node_rows(page(node="sp:ZQK-FIN-01"))
    s.check("...and its specialisation does too", "ZZKL Collection" in sp)
    bg = node_rows(page(node="bg:" + A))
    s.check("the group lists its own and its units' KPIs", "ZZKL Plant output" in bg and "ZZKL Unused" in bg
            and "ZZKL Branch GP" in bg and "ZZKL PAT" not in bg)
    bu = node_rows(page(node="bu:%s|U1" % A))
    s.check("the unit lists only its own", "ZZKL Branch GP" in bu and "ZZKL Plant output" not in bu)
    full = page(node="bg:" + A)
    s.check("the tree opens the group's units", 'href="/admin/performance/library?node=bu%3AZZKL+Group+A%7CU1' in full
            or "node=bu:ZZKL" in full or "U1</span>" in full)
    s.check("Specialised are hidden until asked", "ZZKL Oneoff" not in node_rows(page(node="jf:ZQK-SAL"))
            and "ZZKL Oneoff" in node_rows(page(node="jf:ZQK-SAL", spec="1")))
    s.check("retired ones have their own tab", "ZZKL Retired" not in bg and "ZZKL Retired" in node_rows(
        page(node="bg:" + A, status="retired")))
    s.check("the perspective filter", "ZZKL DSO" in node_rows(page(node="global", persp="Customer"))
            and "ZZKL PAT" not in node_rows(page(node="global", persp="Customer")))
    s.check("...and 'not tagged'", "ZZKL Unused" in node_rows(page(node="bg:" + A, persp="none"))
            and "ZZKL Plant output" not in node_rows(page(node="bg:" + A, persp="none")))
    s.check("search finds a definition's words", "ZZKL PAT" in node_rows(page(node="global", q="after tax of"))
            and "ZZKL DSO" not in node_rows(page(node="global", q="after tax of")))
    s.check("the balance bar counts the node's perspectives", "Internal Process 1" in bg and "not tagged 2" in bg, )

    s.section("the KPI panel")
    pn = page(node="global", kpi="zzkl pat", panel="kpi")
    pnl = pn.split('id="pnl-kpi"', 1)[1] if 'id="pnl-kpi"' in pn else ""
    s.check("opens on ?kpi=, headed by the KPI", "ZZKL PAT" in pnl and "Profit after tax of the unit" in pnl)
    s.check("its placements: one per library row, both groups", pnl.count('class="kl-pl"') + pnl.count(
        'class="kl-pl is-retired"') == 2 and "ZZKL Group A" in pnl and "ZZKL Group B" in pnl)
    s.check("who uses it, by group", "kl-usebar" in pnl)
    s.check("each placement's retire and remove ask first", 'data-confirm="Retire' in pnl
            and 'data-confirm-tone="danger"' in pnl)

    s.section("a variant rides under its root (display only)")
    import re as _re
    def _hold(d_, name, *eids):
        for e in eids:
            d_.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, rate4, rate5, "
                       "business_group, company) SELECT ?, id, ?, 10, 'more', 1,2,3,4,5, business_group, company FROM users "
                       "WHERE employee_id=?", (CID, name, e))
    with a.app.app_context():
        _d = a.get_db()
        # the root is held by three in unit U1 (files at U1); North is held in two groups (would file Global), South in the group
        _d.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, unit, method, "
                   "perspective, active) VALUES (?, '*', '*', 0, '*', 'ZZKL Rev', 'Financial · Profitability', 'RM', 'more', 'Financial', 1)", (A,))
        for q_, who_ in (("North", ("ZZ9KL-1", "ZZ9KL-4", "ZZ9KL-6")), ("South", ("ZZ9KL-2", "ZZ9KL-3", "ZZ9KL-7"))):
            _d.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, unit, method, "
                       "perspective, active) VALUES (?, '*', '*', 0, '*', ?, 'Financial · Profitability', 'RM', 'more', 'Customer', 1)",
                       (A, "ZZKL Rev: " + q_))
            _hold(_d, "ZZKL Rev: " + q_, *who_)
        _d.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, unit, method, "
                   "active) VALUES (?, '*', '*', 0, '*', 'ZZKL Lonely: Plant B', 'Financial · Profitability', 'RM', 'more', 1)", (A,))
        _hold(_d, "ZZKL Rev", "ZZ9KL-1", "ZZ9KL-2", "ZZ9KL-5")
        _hold(_d, "ZZKL Lonely: Plant B", "ZZ9KL-1", "ZZ9KL-2", "ZZ9KL-5")
        _d.commit()
        _ix = a._kpi_lib_index(_d, [A, B])["ids"]
    s.check("(set-up) the variants file at a different node from their root, so 'follows the parent' is a real check",
            _ix["zzkl rev"]["level"] != _ix["zzkl rev: north"]["level"], (_ix["zzkl rev"]["level"], _ix["zzkl rev: north"]["level"]))
    s.check("(set-up) the root is the first part of the name, by the helper the BU rails use",
            a._kpi_key(a._bu_root("ZZKL Rev: North")) == "zzkl rev")
    rn = _ix["zzkl rev"]["where"]
    root_node = "bu:%s|%s" % rn
    other_node = "bg:" + A

    def rows_of(html_):
        return _re.findall(r'<div class="(kl-row[^"]*)">\s*<span class="kl-name"><span><b>(.*?)</b>', node_rows(html_))
    at_root = rows_of(page(node=root_node))
    names_ = [n_ for _c, n_ in at_root]
    s.check("the variants list under the root, in name order, right after it",
            "ZZKL Rev" in names_ and names_[names_.index("ZZKL Rev"):names_.index("ZZKL Rev") + 3] ==
            ["ZZKL Rev", "ZZKL Rev: North", "ZZKL Rev: South"], names_)
    s.check("...as is-sub rows, the root not", all((("is-sub" in c_) == (n_ != "ZZKL Rev")) for c_, n_ in at_root
                                                      if n_.startswith("ZZKL Rev")), at_root)
    nr = node_rows(page(node=root_node))
    s.check("...each with a Variant chip after the name; the root has none",
            nr.count('<span class="pp-chip">Variant</span>') == 2, nr.count("Variant</span>"))
    s.check("the root's sub-line says '2 variants'", _re.search(r"higher is better · 2 variants", nr) is not None)
    s.check("...and the list head counts them", "2 variants" in nr.split("kl-bal", 1)[0], nr.split("kl-bal", 1)[0][-300:])
    s.check("a variant does not file at its own node: North would be Global (two groups hold it), but Global lists neither",
            _ix["zzkl rev: north"]["level"] == "global" and "ZZKL Rev: North" not in node_rows(page(node="global")))
    pg_ = page(node=other_node)

    def tn(html_, label_):
        m_ = _re.search(r'<span>%s</span><span class="kl-n">(\d+)</span>' % _re.escape(label_), html_)
        return int(m_.group(1)) if m_ else None
    rows_a = rows_of(pg_)
    s.check("(set-up) the group's page shows the root with its two variants under it",
            sum(1 for c_, n_ in rows_a if "is-sub" in c_) == 2, rows_a)
    with a.app.test_request_context("/"):
        _lab = a.display_bg(A)
    s.check("the tree's count for the group is the rows that are not variants (the variants add nothing)",
            tn(pg_, _lab) == sum(1 for c_, _n in rows_a if "is-sub" not in c_), (tn(pg_, _lab), len(rows_a)))
    s.check("a variant whose root is not in the library is a normal row of its own, no Variant chip",
            [(c_, n_) for c_, n_ in rows_of(page(node=a._kpi_node_of(_ix["zzkl lonely: plant b"])))
             if n_ == "ZZKL Lonely: Plant B"] and not any("is-sub" in c_ for c_, n_ in rows_of(
                page(node=a._kpi_node_of(_ix["zzkl lonely: plant b"]))) if n_ == "ZZKL Lonely: Plant B"))
    s.check("search by a variant's name shows the parent with all its variants",
            [n_ for _c, n_ in rows_of(page(node=root_node, q="rev: north"))] == ["ZZKL Rev", "ZZKL Rev: North", "ZZKL Rev: South"],
            [n_ for _c, n_ in rows_of(page(node=root_node, q="rev: north"))])
    s.check("a perspective that only a variant has (Customer) shows the parent with all variants",
            [n_ for _c, n_ in rows_of(page(node=root_node, persp="Customer")) if n_.startswith("ZZKL Rev")] ==
            ["ZZKL Rev", "ZZKL Rev: North", "ZZKL Rev: South"])
    s.check("a filter nothing matches shows none of them", not [n_ for _c, n_ in rows_of(page(node=root_node, persp="Internal Process"))
                                                                if n_.startswith("ZZKL Rev")])
    s.check("each variant keeps its own people count (not merged into the root's)",
            _ix["zzkl rev: north"]["n_people"] == 3 and _ix["zzkl rev"]["n_people"] == 3 and
            _ix["zzkl rev: north"]["people"] != _ix["zzkl rev"]["people"])
    pr_ = page(node=root_node, kpi="zzkl rev", panel="kpi")
    pr_ = pr_.split('id="pnl-kpi"', 1)[1]
    s.check("the root's panel lists VARIANTS · 2, each a link to its own panel with its people count",
            "Variants · 2" in pr_ and "kpi=zzkl+rev:+north" in pr_ and "kpi=zzkl+rev:+south" in pr_ and pr_.count("3 people") >= 2, _re.findall(r"kpi=[^\"&]+", pr_)[:8])
    pv_ = page(node=root_node, kpi="zzkl rev: north", panel="kpi").split('id="pnl-kpi"', 1)[1]
    s.check("a variant's panel says 'Variant of <root>' linking to the root's panel, and has no variants list",
            "Variant of" in pv_ and "kpi=zzkl+rev&" in pv_.split("Variant of", 1)[1][:400] + "&" and "Variants ·" not in pv_)
    s.check("a plain KPI's panel has neither", "Variant of" not in page(node="global", kpi="zzkl pat", panel="kpi")
            and "Variants ·" not in page(node="global", kpi="zzkl pat", panel="kpi"))
    _ret = page(node=root_node, status="retired")
    s.check("on the Retired tab the in-use variants are not shown under anything", "ZZKL Rev: North" not in node_rows(_ret))

    s.section("a 1-holder variant rides past the Specialised filter when its root is shown")
    with a.app.app_context():
        _d = a.get_db()
        for nm_ in ("ZZKL Rev: Solo", "ZZKL Orphan: Solo"):
            _d.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, unit, method, "
                       "perspective, active) VALUES (?, '*', '*', 0, '*', ?, 'Financial · Profitability', 'RM', 'more', 'Financial', 1)", (A, nm_))
        _hold(_d, "ZZKL Rev: Solo", "ZZ9KL-1")
        _hold(_d, "ZZKL Orphan: Solo", "ZZ9KL-1")
        _d.commit()
        _ix2 = a._kpi_lib_index(_d, [A, B])["ids"]
    s.check("(set-up) both are Specialised (one holder)", _ix2["zzkl rev: solo"]["specialised"] and _ix2["zzkl orphan: solo"]["specialised"])
    sp_off = rows_of(page(node=root_node))
    sp_names = [n_ for _c, n_ in sp_off]
    s.check("with Specialised hidden, the variant of a shown root is listed under it, with its Specialised chip",
            "ZZKL Rev: Solo" in sp_names and "Specialised</span>" in node_rows(page(node=root_node)).split("ZZKL Rev: Solo", 1)[1][:400]
            and dict((n_, c_) for c_, n_ in sp_off)["ZZKL Rev: Solo"].find("is-sub") > 0, sp_names)
    s.check("...it is counted in the variants (3) and not as a KPI of the node",
            "3 variants" in node_rows(page(node=root_node)).split("kl-bal", 1)[0])
    s.check("a 1-holder variant whose root is absent stays hidden with Specialised hidden, and shows when it is asked for",
            "ZZKL Orphan: Solo" not in node_rows(page(node=a._kpi_node_of(_ix2["zzkl orphan: solo"])))
            and "ZZKL Orphan: Solo" in node_rows(page(node=a._kpi_node_of(_ix2["zzkl orphan: solo"]), spec="1")))
    pg_spec = page(node=root_node)
    m_ = _re.search(r"Specialised · (\d+)", pg_spec)
    s.check("the Specialised count leaves out the variant that rides (only the absent-root one counts among these two)",
            m_ and int(m_.group(1)) == sum(1 for it_ in _ix2.values() if it_["specialised"] and it_["active"]
                                           and it_["key"] != "zzkl rev: solo"), (m_ and m_.group(1)))
    s.check("on the Retired tab an active variant does not ride under anything", "ZZKL Rev: Solo" not in node_rows(page(node=root_node, status="retired")))

    s.section("a variant whose root name was merged (scope alias) rides under the merged identity, in its own group only")
    def _lib2(d_, bg_, nm_):
        d_.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, unit, method, "
                   "active) VALUES (?, '*', '*', 0, '*', ?, 'Financial · Profitability', 'RM', 'more', 1)", (bg_, nm_))
    with a.app.app_context():
        _d = a.get_db()
        for nm_ in ("ZZKL Xmargin", "ZZKL Ymargin"):
            _lib2(_d, A, nm_)
        _lib2(_d, A, "ZZKL Business unit Xmargin: Label")
        _lib2(_d, B, "ZZKL Business unit Ymargin: Label")      # B has no alias for it: A's alias must not reach it
        for bg_, ak_, an_, ik_, in_ in ((A, "zzkl business unit xmargin", "ZZKL Business unit Xmargin", "zzkl xmargin", "ZZKL Xmargin"),
                                        (A, "zzkl business unit ymargin", "ZZKL Business unit Ymargin", "zzkl ymargin", "ZZKL Ymargin")):
            _d.execute("INSERT INTO pm_kpi_aliases(business_group, alias_key, alias_name, into_key, into_name, kind, qualifier) "
                       "VALUES (?,?,?,?,?, 'scope', 'Business unit')", (bg_, ak_, an_, ik_, in_))
        _d.commit()
        _ix3 = a._kpi_lib_index(_d, [A, B])
    _i3 = _ix3["ids"]
    s.check("(set-up) no identity carries the aliased root's key, so only the alias can place the variant",
            "zzkl business unit xmargin" not in _i3 and "zzkl business unit xmargin: label" in _i3)
    nx_ = node_rows(page(node="bg:" + A))
    _names = [n_ for _c, n_ in rows_of(page(node="bg:" + A))]
    s.check("a variant of an aliased root rides under the merged identity (a Variant chip, listed after it)",
            "ZZKL Business unit Xmargin: Label" in _names and _names.index("ZZKL Xmargin") + 1 == _names.index(
                "ZZKL Business unit Xmargin: Label") and nx_.count('<span class="pp-chip">Variant</span>') >= 1, _names)
    s.check("...and is not a row of its own (listed once)", _names.count("ZZKL Business unit Xmargin: Label") == 1)
    px_ = page(node="bg:" + A, kpi="zzkl xmargin", panel="kpi")
    s.check("the root's panel lists it under Variants", "Variants \u00b7 1" in px_ and "kpi=zzkl+business+unit+xmargin:+label" in px_, _re.findall(r"kpi=[^\"&]+", px_)[:6])
    pv3 = page(node="bg:" + A, kpi="zzkl business unit xmargin: label", panel="kpi")
    s.check("the variant's panel says 'Variant of' and links to the merged identity",
            "Variant of" in pv3 and "kpi=zzkl+xmargin" in pv3.split("Variant of", 1)[1][:500])
    s.check("a variant whose root is aliased in ANOTHER group only does not ride (a row of its own, no chip count from it)",
            a._kpi_root_key(_i3["zzkl business unit ymargin: label"], _i3, _ix3["alias"]) == "zzkl business unit ymargin"
            and "ZZKL Business unit Ymargin: Label" in [n_ for _c, n_ in rows_of(page(node=a._kpi_node_of(_i3["zzkl business unit ymargin: label"])))])
    # falsify: with the alias resolution off, the variant no longer rides
    _real_alias = a._kpi_lib_index
    def _no_alias(db_, bgs_):
        o_ = _real_alias(db_, bgs_)
        o_["alias"] = {}
        return o_
    a._kpi_lib_index = _no_alias
    try:
        _off = [n_ for _c, n_ in rows_of(page(node="bg:" + A))]
        _pxo = page(node="bg:" + A, kpi="zzkl xmargin", panel="kpi")
    finally:
        a._kpi_lib_index = _real_alias
    s.check("FALSIFY: with alias resolution off the variant does not nest (not right after its root) and the panel lists none",
            _off.index("ZZKL Xmargin") + 1 != _off.index("ZZKL Business unit Xmargin: Label") and "Variants \u00b7 1" not in _pxo, _off)

    s.section("the form")
    rid = LIB["ZZKL Plant output"][0]
    r = SUP.post("/admin/performance/library", data={
        "csrf_token": "tok", "action": "update", "library_id": rid, "business_group": A, "company": "*",
        "department_mode": "any", "tier_n": "0", "kpi_name": "ZZKL Plant output", "method": "more",
        "perspective": "Internal Process", "category": "__new__", "category_new": "Operations · Productivity",
        "description": "Tonnes produced"})
    row = H.rows(a, "SELECT rate1, rate5, perspective, category, description FROM pm_kpi_library WHERE id=?", (rid,))[0]
    s.check("an edit never writes the number columns: a figure the row still holds (a fixture here) is left exactly as it is, "
            "not rebuilt from the form", (row[0], row[1]) == (1, 5), tuple(row))
    s.check("...and saves the perspective, family and definition", tuple(row[2:]) == (
        "Internal Process", "Operations · Productivity", "Tonnes produced"), tuple(row))
    s.check("...and comes back to the KPI's panel", "kpi=zzkl+plant+output" in r.headers.get("Location", "")
            and "panel=kpi" in r.headers.get("Location", ""), r.headers.get("Location"))
    r = SUP.post("/admin/performance/library", data={
        "csrf_token": "tok", "action": "add", "business_group": A, "company": "*", "department_mode": "any",
        "tier_n": "0", "kpi_name": "ZZKL Added", "method": "less", "perspective": "Nonsense"})
    s.check("a perspective outside the four is refused", r.status_code == 400 and not H.rows(
        a, "SELECT 1 FROM pm_kpi_library WHERE kpi_name='ZZKL Added'"))
    SUP.post("/admin/performance/library", data={
        "csrf_token": "tok", "action": "add", "business_group": A, "company": "*", "department_mode": "any",
        "tier_n": "0", "kpi_name": "ZZKL Added", "method": "less", "perspective": "Customer"})
    row = H.rows(a, "SELECT perspective, rate1, threshold FROM pm_kpi_library WHERE kpi_name='ZZKL Added'")
    s.check("an add stores no figures (the library holds no targets)", row and tuple(row[0]) == ("Customer", None,
                                                                                              None), row and tuple(row[0]))
    add = page(panel="add", addbg=A)
    s.check("the add form has no scale and offers the four perspectives", 'name="rate1"' not in add
            and 'name="perspective"' in add and "Learning &amp; Growth" in add)

    s.section("scope")
    BA = H.client_as(a, BGADM)
    pg = BA.get("/admin/performance/library?node=global").get_data(as_text=True)
    s.check("a group's admin sees their group only: B's tree, no A", "ZZKL Group A" not in pg.split(
        'aria-label="The tree"', 1)[1].split("</section>", 1)[0] and "ZZKL Group B" in pg)
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
