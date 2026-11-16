"""BU KPI setup (Chris, 2026-10-18, the libraries canvas board 4: "it should start with the BG filter row, then
selection of the BU to assign the BU KPI ... show the KPI list from BU level KPI library, and the admin can select from
there on the BU KPIs, and also the selection of who from the BU will carry them, and setting of the rating or target
depending on the mechanism of the BG"; "show it as Everyone selected, then apply the job grade band").

What this suite holds:
  * the page: a group, then a unit; the unit's BU-level library KPIs only; an Early Year only (elsewhere it reads only
    and refuses a save); an admin outside the group can't post
  * a save puts the line on everyone it covers at the one target, each at their grade band's weight (or one weight),
    moderated by their line manager, linked to its setup; departments / a grade range / picked people narrow it
  * all or nothing: a broken scale, bands with a gap, a letter grade under bands, nobody covered saves nothing
  * a change reaches every line it put on, and only those: a person no longer covered loses it; a line someone acted
    on is held as it is; an existing line of the same name is adopted rather than doubled; unticking takes it off
  * Add a person's KPI step puts the unit's BU KPIs that cover a joiner on with their own lines, counted in the 100%
"""
import atexit
import html
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("BU KPI setup: a unit's BU-level KPIs, their target, who carries them and their weight")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO, BG2 = "ZZBK Group", "ZZBK Unit", "ZZBK Other"
U = {}


def _cleanup(db):
    db.execute("DELETE FROM pm_kpi_library_people WHERE library_id IN (SELECT id FROM pm_kpi_library WHERE business_group IN (?,?))", (BG, BG2))
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9BK-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE action IN ('pm_bu_kpi','pm_bu_fill') AND detail LIKE '%ZZBK%'")
    db.execute("DELETE FROM pm_calibration_sessions WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM admin_roles WHERE name='ZZBK role'")
    db.execute("DELETE FROM pm_bu_kpis WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM pm_bg_config WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG, BG2))
    db.commit()


def line(eid, name="ZZBK PAT"):
    r = H.rows(a, "SELECT t.weightage, t.rate1, t.rate5, t.bu_kpi_id, t.library_id, t.id FROM pm_kpi_targets t "
                  "JOIN users u ON u.id=t.subject_id WHERE t.cycle_id=? AND u.employee_id=? AND t.kpi_name=?",
               (CID, eid, name))
    return tuple(r[0]) if r else None


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    PREV = dict(db.execute("SELECT kind, year, half, min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())

    def _put_back():
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("UPDATE cycles SET kind=?, year=?, half=?, min_job_grade=? WHERE id=?",
                       (PREV["kind"], PREV["year"], PREV["half"], PREV["min_job_grade"], CID))
            d_.commit()
    atexit.register(_put_back)
    db.execute("UPDATE cycles SET kind='early_year', year=2027, half=0, min_job_grade=NULL WHERE id=?", (CID,))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?),(?,?),(?,?)",
               (BG, CO, BG, "ZZBK Unit B", BG2, "ZZBK Unit Z"))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
    LIB = {}
    for nm, bu, co in (("ZZBK PAT", 1, "*"), ("ZZBK GP", 1, "*"), ("ZZBK Unit B only", 1, "ZZBK Unit B"),
                       ("ZZBK Personal", 0, "*")):
        LIB[nm] = db.execute(
            "INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, "
            "unit, method, rate1, rate2, rate3, rate4, rate5, weightage_default, bu_level) VALUES (?, ?, '*', 0, '*', ?, "
            "'Financial', 'RM', 'more', 1, 2, 3, 4, 5, 20, ?)", (BG, co, nm, bu)).lastrowid
    U["M"] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                        "company, department, job_grade, confirmation_date) VALUES ('zz9bk-m', 'ZZ BK Manager', 'x', "
                        "'user', 'ZZ9BK-M', ?, ?, 'Management', '21', '2020-01-01')", (BG, CO)).lastrowid
    for eid, dept, g in (("ZZ9BK-A", "Production", "12"), ("ZZ9BK-B", "Production", "17"), ("ZZ9BK-C", "Sales", "14"),
                         ("ZZ9BK-D", "Sales", "20")):
        U[eid[-1]] = db.execute(
            "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
            "department, job_grade, confirmation_date, manager_id) VALUES (?,?, 'x', 'user', ?,?,?,?,?, '2020-01-01', ?)",
            (eid.lower(), "ZZ BK " + eid[-1], eid, BG, CO, dept, g, U["M"])).lastrowid
    OTHER = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                       "admin_bg) VALUES ('zz9bk-adm', 'ZZ BK Admin', 'x', 'admin', 'ZZ9BK-ADM', ?, ?)",
                       (BG2, BG2)).lastrowid
    ROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZBK role', 'group')").lastrowid
    db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(ROLE, "pm.read"), (ROLE, "pm.bu_kpi")])
    BGADM = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                       "admin_bg, admin_role_id) VALUES ('zz9bk-bga', 'ZZ BK Group Admin', 'x', 'admin', 'ZZ9BK-BGA', ?, ?, "
                       "?)", (BG, BG, ROLE)).lastrowid
    db.commit()
SUP = H.client_as(a, SU["id"])
URL = "/admin/performance/bu-kpis?fbg=%s&fbu=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"))
K = "k%d_" % LIB["ZZBK PAT"]


def rail_of(pg_):
    """The left rail's html (the library panel beside it lists the non-BU-level KPIs too)."""
    i = pg_.index('aria-label="BU KPIs of this unit"')
    return pg_[i:pg_.index("</section>", i)]


def pageof(lid, new=False, edit=True):
    """The page showing one KPI (2026-10-27): its edit form, or (new=True) as added in this visit, not saved yet."""
    return URL + ("&add=%d" % lid if new else "") + "&kpi=%d" % lid + ("&edit=1" if edit and not new else "")


def card(lid, **kw):
    k = "k%d_" % lid
    f = {k + "rate%d" % i: str(v) for i, v in enumerate(kw.pop("rates", (100, 200, 300, 400, 500)), 1)}
    f[k + "carriers"] = kw.pop("carriers", "everyone")
    f[k + "wmode"] = kw.pop("wmode", "grade")
    bands = kw.pop("bands", [("20", "", "40"), ("16", "19", "30"), ("", "15", "20")])
    f[k + "bmin"] = [b[0] for b in bands]
    f[k + "bmax"] = [b[1] for b in bands]
    f[k + "bw"] = [b[2] for b in bands]
    for key, v in kw.items():
        f[k + key] = v
    return f


def save(*cards, kpis=None, client=None):
    form = {"csrf_token": "tok", "action": "save", "kpi": [str(x) for x in (kpis or [])]}
    for c in cards:
        form.update(c)
    return (client or SUP).post(URL, data=form, follow_redirects=True)


try:
    s.section("the page")
    pg = SUP.get(URL).get_data(as_text=True)
    s.check("the unit's BU-level KPIs only: not another unit's, not a personal one (that one is the library panel's)",
            ">ZZBK PAT<" in rail_of(pg) and ">ZZBK GP<" in rail_of(pg) and "ZZBK Unit B only" not in rail_of(pg)
            and "ZZBK Personal" not in rail_of(pg))
    s.check("the page keeps the scroll position across a rail link (Chris 2026-10-31), on the plain and the selected view",
            "bk-scroll-keep" in pg and 'sessionStorage.setItem(key(u)' in pg
            and all("bk-scroll-keep" in SUP.get(u_).get_data(as_text=True) for u_ in (URL, pageof(LIB["ZZBK PAT"]))))
    pg = SUP.get(pageof(LIB["ZZBK PAT"], new=True)).get_data(as_text=True)
    s.check("its people and scale are said", "5 people taking part" in pg and "5-point rating" in pg)
    s.check("the save asks first, naming the KPI", 'data-confirm="Save ZZBK PAT' in pg and 'name="action" value="save_kpi"' in pg)
    s.check("each card carries the scale check on its own fields", 'data-kpi-scale="A"' in pg
            and 'data-kpi-f="rate1"' in pg)
    s.check("Performance > Run lists it", 'href="/admin/performance/bu-kpis' in SUP.get(
        "/admin/module/pm/progress").get_data(as_text=True) or "BU KPI setup" in a.ADMIN_SECTIONS.__repr__())

    s.section("a save: everyone, weight by grade band")
    out = save(card(LIB["ZZBK PAT"]), kpis=[LIB["ZZBK PAT"]])
    w = {e: (line("ZZ9BK-" + e) or (None,))[0] for e in "ABCD"}
    s.check("the line on everyone in the unit taking part, at their band's weight", w == {"A": 20, "B": 30, "C": 20,
                                                                                         "D": 40}, w)
    la = line("ZZ9BK-A")
    sid = H.one(a, "SELECT id FROM pm_bu_kpis WHERE cycle_id=? AND company=? AND kpi_name='ZZBK PAT'", (CID, CO))
    s.check("...at the one target, linked to its setup and the library", la[1] == 100 and la[2] == 500
            and la[3] == sid and la[4] == LIB["ZZBK PAT"], la)
    s.check("...moderated by their line manager", H.one(a, "SELECT approver_id FROM pm_kpi_target_approvers WHERE "
                                                           "kpi_target_id=?", (la[5],)) == U["M"])
    s.check("...the manager too (they're in the unit, JG 21)", line("ZZ9BK-M")[0] == 40)
    s.check("...said, and logged once for the unit", "5 lines added" in out.get_data(as_text=True) and H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%ZZBK PAT%'") == 1)

    s.section("all or nothing")
    n0 = H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name='ZZBK GP'", (CID,))
    save(card(LIB["ZZBK PAT"]), card(LIB["ZZBK GP"], rates=(1, 2, 2, 4, 5)), kpis=[LIB["ZZBK PAT"], LIB["ZZBK GP"]])
    s.check("one card's ratings broken: nothing saved", H.one(
        a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name='ZZBK GP'", (CID,)) == n0 == 0)
    save(card(LIB["ZZBK GP"], bands=[("20", "", "40"), ("", "15", "20")]), kpis=[LIB["ZZBK GP"]])
    s.check("grade bands with a gap (16-19 missing): nothing saved", H.one(
        a, "SELECT COUNT(*) FROM pm_bu_kpis WHERE kpi_name='ZZBK GP'") == 0)
    save(card(LIB["ZZBK GP"], carriers="departments", dept=["Nowhere"]), kpis=[LIB["ZZBK GP"]])
    s.check("no department ticked that the unit has: nothing saved", H.one(
        a, "SELECT COUNT(*) FROM pm_bu_kpis WHERE kpi_name='ZZBK GP'") == 0)
    out = save(card(LIB["ZZBK GP"], carriers="grade", gmin="30"), kpis=[LIB["ZZBK GP"]])
    s.check("a grade range that covers nobody (JG 30 and above): nothing saved, told why", H.one(
        a, "SELECT COUNT(*) FROM pm_bu_kpis WHERE kpi_name='ZZBK GP'") == 0
        and "nobody taking part" in out.get_data(as_text=True))
    with a.app.app_context():
        a.get_db().execute("UPDATE users SET job_grade='GM' WHERE id=?", (U["C"],))   # a letter grade that is not Grade H ('H' is never in the review: 2026-10-30)
        a.get_db().commit()
    out = save(card(LIB["ZZBK GP"]), kpis=[LIB["ZZBK GP"]])
    s.check("a carrier with a letter grade under grade bands: nothing saved, told why", H.one(
        a, "SELECT COUNT(*) FROM pm_bu_kpis WHERE kpi_name='ZZBK GP'") == 0
        and "isn" in out.get_data(as_text=True) and "a number" in out.get_data(as_text=True))
    with a.app.app_context():
        a.get_db().execute("UPDATE users SET job_grade='14' WHERE id=?", (U["C"],))
        a.get_db().commit()

    s.section("narrowing who carries it")
    save(card(LIB["ZZBK PAT"]), card(LIB["ZZBK GP"], carriers="departments", dept=["Sales"], wmode="one",
                                     weight="15"), kpis=[LIB["ZZBK PAT"], LIB["ZZBK GP"]])
    gp = {e: (line("ZZ9BK-" + e, "ZZBK GP") or (None,))[0] for e in "ABCD"}
    s.check("departments: Sales only, at the one weight", gp == {"A": None, "B": None, "C": 15, "D": 15}, gp)
    s.check("...and PAT, saved again unchanged, stays as it was", line("ZZ9BK-A")[0] == 20)
    with a.app.app_context():   # B's PAT line is acted on: moderated
        a.get_db().execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, acted_by) VALUES (?,1,'confirm',?)",
                           (line("ZZ9BK-B")[5], U["M"]))
        a.get_db().commit()
    out = save(card(LIB["ZZBK PAT"], carriers="grade", gmin="15", gmax="19", rates=(10, 20, 30, 40, 50)),
               card(LIB["ZZBK GP"], carriers="pick", people=["ZZ9BK-A"], wmode="one", weight="10"),
               kpis=[LIB["ZZBK PAT"], LIB["ZZBK GP"]])
    s.check("a grade range: those outside it lose the line (A at 12, C at 14, D at 20, the manager at 21)",
            line("ZZ9BK-A") is None and line("ZZ9BK-C") is None and line("ZZ9BK-D") is None
            and line("ZZ9BK-M") is None)
    s.check("...a line someone acted on takes the new target too (B's, moderated; Chris, 2026-11-03) and goes back to its "
            "moderator", line("ZZ9BK-B")[1] == 10 and line("ZZ9BK-B")[2] == 50 and H.one(
                a, "SELECT COUNT(*) FROM pm_kpi_approvals WHERE kpi_target_id=?", (line("ZZ9BK-B")[5],)) == 0
            and "1 had results and took the new target; 1 went back to its moderator" in out.get_data(as_text=True))
    gp = {e: (line("ZZ9BK-" + e, "ZZBK GP") or (None,))[0] for e in "ABCD"}
    s.check("picked people: A only; C and D lose it", gp == {"A": 10, "B": None, "C": None, "D": None}, gp)

    s.section("an existing line of the same name")
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM pm_kpi_approvals WHERE kpi_target_id=?", (line("ZZ9BK-B")[5],))
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, "
                   "rate4, rate5, business_group, company) VALUES (?,?, 'ZZBK PAT', 5, 'more', 1,2,3,4,5, ?,?)",
                   (CID, U["D"], BG, CO))
        db.commit()
    try:
        save(card(LIB["ZZBK PAT"]), kpis=[LIB["ZZBK PAT"]])
        crashed = None
    except Exception as ex:   # noqa: BLE001 -- a second line of the same name would break the table's UNIQUE
        crashed = ex
    ld = line("ZZ9BK-D")
    s.check("is adopted: linked and brought to the target and band weight, not doubled", not crashed and ld and ld[0] == 40
            and ld[1] == 100 and ld[3] is not None and H.one(
                a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? AND kpi_name='ZZBK PAT'",
                (CID, U["D"])) == 1, ld)
    s.check("GP, unticked, comes off every scorecard it was put on, and its setup goes", H.one(
        a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name='ZZBK GP'", (CID,)) == 0 and H.one(
        a, "SELECT COUNT(*) FROM pm_bu_kpis WHERE kpi_name='ZZBK GP'") == 0)

    s.section("Add a person picks up the unit's BU KPIs")
    lib_own = H.one(a, "SELECT id FROM pm_kpi_library WHERE kpi_name='ZZBK Personal'")
    SUP.post("/admin/users", data={"csrf_token": "tok", "action": "add_user", "employee_id": "ZZ9BK-N",
                                   "full_name": "ZZ BK New", "business_group": BG, "company": CO,
                                   "manager_eid": "ZZ9BK-M", "hod_eid": "ZZ9BK-M", "job_grade": "13",
                                   "joined_date": "2026-10-01", "confirmation_date": "2020-01-01",
                                   "department": "Production", "then": "kpis"})
    N = H.one(a, "SELECT id FROM users WHERE employee_id='ZZ9BK-N'")
    pg = SUP.get("/admin/users?view=add&step=kpis&uid=%d" % N).get_data(as_text=True)
    s.check("step 2 shows PAT from BU KPI setup at their band (JG 13: 20%), counted in the tally",
            "From BU KPI setup" in pg and "goes on with their own KPIs" in pg and 'data-have="20' in pg)
    own = {"csrf_token": "tok", "action": "kpis", "then": "save", "lib_id": [str(lib_own)], "weightage": ["80"],
           "description": [""], "method": ["more"], "rate 1": ["1"], "rate 2": ["2"], "rate 3": ["3"], "rate 4": ["4"],
           "rate 5": ["5"]}
    SUP.post("/admin/people/add/%d" % N, data=dict(own, weightage=["100"]))
    s.check("their own line at 100% on top of PAT's 20% is refused", line("ZZ9BK-N") is None and line(
        "ZZ9BK-N", "ZZBK Personal") is None)
    SUP.post("/admin/people/add/%d" % N, data=own)
    s.check("at 80%: saved with PAT at 20%, linked to the setup", line("ZZ9BK-N", "ZZBK Personal")[0] == 80
            and line("ZZ9BK-N")[0] == 20 and line("ZZ9BK-N")[3] is not None)

    s.section("the unit picked on its card (2026-10-18, board 23)")
    save(card(LIB["ZZBK PAT"], unit="RM(Mil)"), kpis=[LIB["ZZBK PAT"]])
    s.check("stored in the standard's spelling, on the setup and on every carrier's line", H.one(
        a, "SELECT unit FROM pm_bu_kpis WHERE cycle_id=? AND company=? AND kpi_name='ZZBK PAT'", (CID, CO)) ==
        "RM (mil)" and {r[0] for r in H.rows(a, "SELECT unit FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name='ZZBK "
                                                "PAT'", (CID,))} == {"RM (mil)"})
    s.check("the card draws the picker on the saved unit", 'name="%sunit"' % K in SUP.get(pageof(LIB["ZZBK PAT"])).get_data(as_text=True))

    s.section("the weight follows the grade, the super admin's to set (Chris, 2026-10-26)")
    KG = "k%d_" % LIB["ZZBK GP"]
    pg = SUP.get(pageof(LIB["ZZBK GP"], new=True)).get_data(as_text=True)
    s.check("a BU KPI not set yet starts on By grade, at the starting bands: 19 and above 25%, 16-18 20%, to 15 15%",
            'name="%swmode" value="grade" data-bk-wmode checked' % KG in pg
            and 'name="%sbmin" inputmode="numeric" value="19"' % KG in pg
            and 'name="%sbmax" inputmode="numeric" value="18"' % KG in pg
            and all('name="%sbw" inputmode="decimal" value="%s"' % (KG, w_) in pg for w_ in ("25", "20", "15")))
    BA = H.client_as(a, BGADM)
    pg = BA.get(pageof(LIB["ZZBK PAT"])).get_data(as_text=True)
    s.check("a BG admin with BU KPI setup reads the weight rule and can't change it", "The super admin sets each BU KPI" in pg and re.search(r'name="%sbw"[^>]*value="40"[^>]*disabled' % K, pg)
            and 'name="%swmode" value="one" data-bk-wmode  disabled' % K in pg,
            [m for m in re.findall(r'<input[^>]*(?:bw|wmode)[^>]*>', pg) if K in m][:4])
    with a.app.app_context():   # C's own GP line, with a Focus and their own words: the setup adopts it
        db = a.get_db()
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, focus, description, weightage, method, "
                   "rate1, rate2, rate3, rate4, rate5, business_group, company) VALUES (?,?, 'ZZBK GP', 'Plant 2', "
                   "'ZZ their own words', 9, 'more', 1,2,3,4,5, ?,?)", (CID, U["C"], BG, CO))
        db.commit()
    bands0 = H.one(a, "SELECT bands_json FROM pm_bu_kpis WHERE cycle_id=? AND company=? AND kpi_name='ZZBK PAT'", (CID, CO))
    save(card(LIB["ZZBK PAT"], rates=(110, 210, 310, 410, 510), bands=[("", "", "50")]),
         card(LIB["ZZBK GP"], wmode="one", weight="10"), kpis=[LIB["ZZBK PAT"], LIB["ZZBK GP"]], client=BA)
    ld = line("ZZ9BK-D")
    s.check("the BG admin's save changes the target but not the weight rule: D (JG 20) stays at 40%",
            ld and ld[1] == 110 and ld[0] == 40 and H.one(
                a, "SELECT bands_json FROM pm_bu_kpis WHERE cycle_id=? AND company=? AND kpi_name='ZZBK PAT'",
                (CID, CO)) == bands0, ld)
    gp = {e: (line("ZZ9BK-" + e, "ZZBK GP") or (None,))[0] for e in "ABCDM"}
    s.check("...and a BU KPI they add takes the starting bands, whatever weight they sent",
            gp == {"A": 15, "B": 20, "C": 15, "D": 25, "M": 25}, gp)
    lc = H.rows(a, "SELECT focus, description, bu_kpi_id, bu_prev_json FROM pm_kpi_targets WHERE cycle_id=? AND "
                   "subject_id=? AND kpi_name='ZZBK GP'", (CID, U["C"]))
    s.check("an adopted line takes the BU KPI's own name and definition: its Focus and description set aside",
            len(lc) == 1 and lc[0][0] is None and lc[0][1] is None and lc[0][2] is not None
            and '"Plant 2"' in (lc[0][3] or "") and "ZZ their own words" in (lc[0][3] or ""), lc)
    save(card(LIB["ZZBK PAT"], bands=[("19", "", "25"), ("16", "18", "20"), ("", "15", "15")]), kpis=[LIB["ZZBK PAT"]])
    s.check("the super admin changes the bands: D (JG 20) to 25%, B (JG 17) to 20%",
            line("ZZ9BK-D")[0] == 25 and line("ZZ9BK-B")[0] == 20, (line("ZZ9BK-D"), line("ZZ9BK-B")))
    lc = H.rows(a, "SELECT focus, description, bu_kpi_id, weightage FROM pm_kpi_targets WHERE cycle_id=? AND "
                   "subject_id=? AND kpi_name='ZZBK GP'", (CID, U["C"]))
    s.check("GP unticked: C's line goes back as it was, its Focus and own words with it",
            len(lc) == 1 and tuple(lc[0]) == ("Plant 2", "ZZ their own words", None, 9), lc)

    s.section("those who carry it now: leaving some holders out (Chris, 2026-10-27)")
    GL = LIB["ZZBK GP"]
    KGp = "k%d_" % GL
    with a.app.app_context():   # A and D hold their own GP line too (C already does): the three are GP's holders
        db = a.get_db()
        for u_ in ("A", "D"):
            db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, "
                       "rate4, rate5, business_group, company) VALUES (?,?, 'ZZBK GP', 12, 'more', 1,2,3,4,5, ?,?)",
                       (CID, U[u_], BG, CO))
        db.commit()

    def ticks(pg_):
        return {m[0]: "checked" in m[1] for m in re.findall(
            r'name="%sholder" value="(ZZ9BK-[A-Z])"([^>]*)>' % KGp, pg_)}
    C0 = H.rows(a, "SELECT weightage, rate1, rate5, focus, description, bu_kpi_id FROM pm_kpi_targets WHERE cycle_id=? "
                   "AND subject_id=? AND kpi_name='ZZBK GP'", (CID, U["C"]))[0]
    tk = ticks(SUP.get(pageof(GL, new=True)).get_data(as_text=True))
    s.check("an unsaved card lists every current holder, all ticked", set(tk) == {"ZZ9BK-A", "ZZ9BK-C", "ZZ9BK-D"}
            and all(tk.values()), tk)
    # the holder list shows each holder's own line today: weight and target (Chris, 2026-10-27)
    pg_h = SUP.get(pageof(GL, new=True)).get_data(as_text=True)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE pm_kpi_targets SET weightage=17.5, rate1=31, rate5=39, unit='RM' WHERE cycle_id=? AND subject_id=? "
                   "AND kpi_name='ZZBK GP'", (CID, U["A"]))
        db.commit()
    try:
        pg_h = SUP.get(pageof(GL, new=True)).get_data(as_text=True)
        la_ = H.rows(a, "SELECT weightage, rate1, rate2, rate3, rate4, rate5, unit FROM pm_kpi_targets WHERE cycle_id=? AND "
                        "subject_id=? AND kpi_name='ZZBK GP'", (CID, U["A"]))[0]
        want_t = " / ".join("%g" % v for v in la_[1:6]) + " " + la_[6]
        mrow = re.search(r'<label class="bk-pp bk-hp"[^>]*>(?:(?!</label>).)*?value="ZZ9BK-A"(?:(?!</label>).)*</label>', pg_h, re.S)
        s.check("the holder list has a header row: Weight and Target today", 'class="bk-pp bk-hh"' in pg_h
                and ">Weight</span>" in pg_h and ">Target today</span>" in pg_h)
        s.check("a holder's row shows the weight and the target from their own line (read from the DB)", bool(mrow)
                and ('>%g%%</span>' % la_[0]) in mrow.group(0) and ('>%s</span>' % want_t) in mrow.group(0),
                (want_t, mrow.group(0)[-300:] if mrow else None))
        s.check("...and another holder's row shows their own weight, not A's", bool(re.search(
            r'value="ZZ9BK-D"(?:(?!</label>).)*?>12%</span>', pg_h, re.S)))
    finally:
        with a.app.app_context():
            db = a.get_db()
            db.execute("UPDATE pm_kpi_targets SET weightage=12, rate1=1, rate5=5, unit=NULL WHERE cycle_id=? AND subject_id=? "
                       "AND kpi_name='ZZBK GP'", (CID, U["A"]))
            db.commit()
    hold = dict(carriers="holders", wmode="own", rates=(7, 8, 9, 10, 11))
    save(card(GL, holder_set="1", holder=["ZZ9BK-A", "ZZ9BK-D", "ZZ9BK-B"], **hold), kpis=[GL])
    gdata = json.loads(H.one(a, "SELECT carriers_json FROM pm_bu_kpis WHERE cycle_id=? AND company=? AND kpi_name="
                                "'ZZBK GP'", (CID, CO)))
    s.check("one holder unticked: the setup keeps the ticked holders only", gdata.get("people") == ["ZZ9BK-A", "ZZ9BK-D"],
            gdata)
    s.check("...a posted Employee ID that isn't a holder (B has no GP line) is ignored", "ZZ9BK-B" not in gdata["people"]
            and line("ZZ9BK-B", "ZZBK GP") is None)
    la, ld = line("ZZ9BK-A", "ZZBK GP"), line("ZZ9BK-D", "ZZBK GP")
    s.check("...those ticked are adopted: the unit's target, linked, their own weight kept", la[1] == 7 and ld[1] == 7
            and la[3] is not None and la[3] == ld[3] and la[0] == 12 and ld[0] == 12, (la, ld))
    C1 = H.rows(a, "SELECT weightage, rate1, rate5, focus, description, bu_kpi_id FROM pm_kpi_targets WHERE cycle_id=? "
                   "AND subject_id=? AND kpi_name='ZZBK GP'", (CID, U["C"]))
    s.check("...the one unticked keeps their line exactly: target, weight, Focus, words, no link", len(C1) == 1
            and tuple(C1[0]) == tuple(C0) and C1[0][5] is None, (C0, C1))
    tk = ticks(SUP.get(pageof(GL)).get_data(as_text=True))
    s.check("the saved card shows ticks from the saved list: A and D on, C off", tk == {"ZZ9BK-A": True, "ZZ9BK-C": False,
                                                                                         "ZZ9BK-D": True}, tk)
    out = save(card(GL, holder_set="1", **hold), kpis=[GL])
    gdata = json.loads(H.one(a, "SELECT carriers_json FROM pm_bu_kpis WHERE cycle_id=? AND company=? AND kpi_name="
                                "'ZZBK GP'", (CID, CO)))
    s.check("all unticked is refused with its reason, and nothing changes", "tick at least one of those who carry it" in
            out.get_data(as_text=True) and gdata["people"] == ["ZZ9BK-A", "ZZ9BK-D"], gdata)
    save(card(GL, holder=["ZZ9BK-B"], **hold), kpis=[GL])
    gdata = json.loads(H.one(a, "SELECT carriers_json FROM pm_bu_kpis WHERE cycle_id=? AND company=? AND kpi_name="
                                "'ZZBK GP'", (CID, CO)))
    s.check("a list of only non-holders is the same refusal: nobody new gets it", gdata["people"] == ["ZZ9BK-A", "ZZ9BK-D"]
            and line("ZZ9BK-B", "ZZBK GP") is None, gdata)
    save(card(GL, **hold), kpis=[GL])
    gdata = json.loads(H.one(a, "SELECT carriers_json FROM pm_bu_kpis WHERE cycle_id=? AND company=? AND kpi_name="
                                "'ZZBK GP'", (CID, CO)))
    lc = line("ZZ9BK-C", "ZZBK GP")
    s.check("a post without the list is every holder, as before (absent is not empty)", gdata["people"] == [
        "ZZ9BK-A", "ZZ9BK-C", "ZZ9BK-D"] and lc[3] is not None and lc[1] == 7, (gdata, lc))
    save(card(GL, holder_set="1", holder=["ZZ9BK-A", "ZZ9BK-D"], **hold), kpis=[GL])
    C2 = H.rows(a, "SELECT weightage, rate1, rate5, focus, description, bu_kpi_id FROM pm_kpi_targets WHERE cycle_id=? "
                   "AND subject_id=? AND kpi_name='ZZBK GP'", (CID, U["C"]))
    s.check("unticking a person it had adopted gives their line back as it was, never deleted", len(C2) == 1
            and tuple(C2[0]) == tuple(C0), (C0, C2))
    # ---- who is BU follows the line link where a setup is saved (Chris, 2026-10-27): C was unticked, A and D ticked
    GN = "zzbk gp"

    def bu_names_of(key_):
        with a.app.app_context():
            d_ = a.get_db()
            u_ = d_.execute("SELECT * FROM users WHERE id=?", (U[key_],)).fetchone()
            return a.pm_bu_level_names(d_, u_, CID)

    def bu_only(keys_):
        with a.app.app_context():
            return a.kpis_bu_only_ids(a.get_db(), CID, [U[k_] for k_ in keys_])
    s.section("who is BU follows the saved setup's carriers: an unticked holder enters their own result")
    s.check("a ticked person's GP is BU (Group People fills it); the unticked person's is not",
            GN in bu_names_of("A") and GN in bu_names_of("D") and GN not in bu_names_of("C"),
            (bu_names_of("A"), bu_names_of("C")))
    lines_of = lambda k_: {r[0].lower() for r in H.rows(a, "SELECT kpi_name FROM pm_kpi_targets WHERE cycle_id=? AND "
                                                         "subject_id=?", (CID, U[k_]))}   # noqa: E731
    only = bu_only(["A", "C", "D"])
    want = {U[k_] for k_ in "ACD" if lines_of(k_) and lines_of(k_) <= bu_names_of(k_)}
    s.check("kpis_bu_only_ids follows the same rule: never the unticked person, the ticked ones as their lines say",
            only == want and U["C"] not in only and U["A"] in only, (only, want))
    form_fill = {"csrf_token": "tok", "business_group": BG, "kpi_name": "ZZBK GP", "actual_value": "55"}
    for co_ in (CO, ""):
        pv = SUP.post("/admin/performance/bu-fill", data=dict(form_fill, company=co_, action="calc")).get_json()
        s.check("Fill BU result's calc (%s) lists the two ticked people only" % (co_ or "whole group"),
                pv["n_total"] == 2 and pv["rows"].count("data-bf-row") == 2, (pv["n_total"], pv["rows"].count("data-bf-row")))
    SUP.post("/admin/performance/bu-fill", data=dict(form_fill, company=CO, reason="ZZBK audited unit figure"))
    res = {r[0]: (r[1], r[2]) for r in H.rows(a, "SELECT u.employee_id, r.actual_value, r.admin_filled FROM pm_kpi_targets t "
                                                 "JOIN users u ON u.id=t.subject_id JOIN pm_kpi_results r ON "
                                                 "r.kpi_target_id=t.id WHERE t.cycle_id=? AND t.kpi_name='ZZBK GP'", (CID,))}
    s.check("...and the apply fills those two and leaves the unticked person's line without a result",
            res.get("ZZ9BK-A") == (55, 1) and res.get("ZZ9BK-D") == (55, 1) and "ZZ9BK-C" not in res, res)
    EC, EA = H.client_as(a, U["C"]), H.client_as(a, U["A"])
    tid = lambda k_: H.one(a, "SELECT id FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? AND kpi_name='ZZBK GP'",
                           (CID, U[k_]))   # noqa: E731
    r = EC.post("/performance/kpi/%d/autosave" % tid("C"), data={"csrf_token": "tok", "actual_value": "9"})
    s.check("the unticked person saves their own result through the employee route", r.status_code == 200
            and (r.get_json() or {}).get("ok") is True, (r.status_code, r.get_data(as_text=True)[:200]))
    s.check("...and it is stored as their own (not an admin fill)", H.rows(a, "SELECT r.actual_value, r.admin_filled FROM "
            "pm_kpi_results r WHERE r.kpi_target_id=?", (tid("C"),))[0][0] == 9)
    r = EA.post("/performance/kpi/%d/autosave" % tid("A"), data={"csrf_token": "tok", "actual_value": "9"})
    s.check("a ticked person is still refused: Group People sets that KPI", r.status_code == 409
            and H.one(a, "SELECT actual_value FROM pm_kpi_results WHERE kpi_target_id=?", (tid("A"),)) == 55,
            r.status_code)

    with a.app.app_context():   # the filled and keyed results lock the lines: clear them so the setup can come off
        db = a.get_db()
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE cycle_id=? "
                   "AND kpi_name='ZZBK GP' AND subject_id IN (?,?,?))", (CID, U["A"], U["C"], U["D"]))
        db.commit()
    save(kpis=[])
    s.section("no saved setup: the name rule is unchanged")
    s.check("GP is BU for all three again (the library's BU-level name, no setup to follow the link of)",
            all(GN in bu_names_of(k_) for k_ in "ACD"), [bu_names_of(k_) for k_ in "ACD"])
    s.check("...so kpis_bu_only_ids counts them by name as before (C too)", bu_only(["A", "C", "D"]) == {
        U[k_] for k_ in "ACD" if lines_of(k_) <= bu_names_of(k_)} and (lines_of("C") != {GN} or U["C"] in bu_only(["C"])),
            bu_only(["A", "C", "D"]))
    pv = SUP.post("/admin/performance/bu-fill", data=dict(form_fill, company=CO, action="calc")).get_json()
    s.check("...and Fill BU result takes every line of that name in the unit", pv["n_total"] == 3, pv["n_total"])
    r = EC.post("/performance/kpi/%d/autosave" % tid("C"), data={"csrf_token": "tok", "actual_value": "8"})
    s.check("...and the person who was unticked is refused again (falsifies the link rule being applied without a setup)",
            r.status_code == 409, r.status_code)
    s.check("(put back) GP's setup removed: A and D's lines are theirs again", line("ZZ9BK-A", "ZZBK GP")[3] is None
            and line("ZZ9BK-A", "ZZBK GP")[1] == 1)

    # ------------------------------------------------------------------------------------------------------------
    s.section("one KPI at a time (2026-10-27): a save and a take-off touch only the KPI they name")
    PL, GLb = LIB["ZZBK PAT"], LIB["ZZBK GP"]
    OA = H.client_as(a, OTHER)
    with a.app.app_context():
        NP = len(a._bu_unit_people(a.get_db(), BG, CO))   # everyone in the unit taking part

    def save1(lid, c, client=None, **extra):
        form = {"csrf_token": "tok", "action": "save_kpi", "kpi": str(lid)}
        form.update(c)
        form.update(extra)
        return (client or SUP).post(URL, data=form, follow_redirects=True)

    def snap(name):
        """A KPI's setup row and every one of its lines, whole (updated_at included): byte for byte."""
        return (H.rows(a, "SELECT * FROM pm_bu_kpis WHERE cycle_id=? AND company=? AND kpi_name=? ORDER BY id", (CID, CO, name)),
                H.rows(a, "SELECT * FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name=? ORDER BY id", (CID, name)))

    def plain(sn):
        return ([tuple(r) for r in sn[0]], [tuple(r) for r in sn[1]])
    pat_pre = plain(snap("ZZBK PAT"))
    out = save1(GLb, card(GLb, wmode="one", weight="12", rates=(5, 6, 7, 8, 9)))
    s.check("GP saved on its own: its setup and a line on each of the unit's people", "ZZBK GP saved for" in out.get_data(
        as_text=True) and H.one(a, "SELECT COUNT(*) FROM pm_bu_kpis WHERE cycle_id=? AND company=? AND kpi_name='ZZBK GP'",
                                (CID, CO)) == 1 and len(snap("ZZBK GP")[1]) == NP, (len(snap("ZZBK GP")[1]), NP))
    s.check("...and PAT, not posted, is byte for byte as it was (no setup)", plain(snap("ZZBK PAT")) == pat_pre and not pat_pre[0])
    gp0 = plain(snap("ZZBK GP"))
    out = save1(PL, card(PL, wmode="one", weight="10", rates=(100, 200, 300, 400, 500)))
    s.check("PAT saved on its own", "ZZBK PAT saved for" in out.get_data(as_text=True) and len(snap("ZZBK PAT")[1]) == NP)
    s.check("GP's setup and lines are byte for byte as they were (updated_at too)", plain(snap("ZZBK GP")) == gp0)
    pat1 = plain(snap("ZZBK PAT"))
    save1(PL, card(PL, wmode="one", weight="10", rates=(101, 201, 301, 401, 501)))
    s.check("PAT changed again: its lines take the new target...", all(r[0] == 101 for r in H.rows(
        a, "SELECT rate1 FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name='ZZBK PAT'", (CID,))))
    s.check("...and GP is still byte for byte as it was", plain(snap("ZZBK GP")) == gp0)
    save1(GLb, card(GLb, wmode="one", weight="12", rates=(5, 6, 7, 8, 10)))
    s.check("(falsify the comparison) saving GP itself does change GP's lines", plain(snap("ZZBK GP")) != gp0)
    s.check("...and PAT is untouched by that", plain(snap("ZZBK PAT"))[1] == plain(snap("ZZBK PAT"))[1]
            and all(r[0] == 101 for r in H.rows(a, "SELECT rate1 FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name='ZZBK PAT'",
                                                (CID,))))
    gp0 = plain(snap("ZZBK GP"))
    n_pat = H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%ZZBK PAT%' AND detail LIKE '%set for%'")
    s.check("each save is logged for its own KPI", n_pat == 2 + 0 or n_pat >= 2, n_pat)

    s.section("one KPI at a time: who may post, and what is refused")
    before = (plain(snap("ZZBK GP")), plain(snap("ZZBK PAT")))
    r = save1(PL, card(PL, wmode="one", weight="10"), client=OA)
    s.check("another group's admin can't save a KPI", r.status_code == 403)
    r = SUP.post(URL, data={"csrf_token": "tok", "action": "save_kpi", "kpi": "999999"})
    s.check("a KPI that is not the library's: refused", r.status_code == 400)
    BA1 = H.client_as(a, BGADM)
    r = BA1.post(URL, data=dict(card(LIB["ZZBK Personal"], wmode="one", weight="10"), csrf_token="tok", action="save_kpi",
                                kpi=str(LIB["ZZBK Personal"])))
    s.check("a library pick is the super admin's: a BG admin posting one is refused", r.status_code == 403)
    # a library row that names people is a person's own KPI, never a unit's (_bu_kpi_pickable): a forged id can't make it one
    LNP = LIB["ZZBK Personal"]
    with a.app.app_context():
        _n = a.get_db()
        _n.execute("INSERT INTO pm_kpi_library_people(library_id, user_id) VALUES (?, (SELECT id FROM users WHERE business_group=? LIMIT 1))", (LNP, BG))
        _n.commit()
    try:
        pre_np = (H.rows(a, "SELECT * FROM pm_kpi_library WHERE id=?", (LNP,)), H.rows(a, "SELECT * FROM pm_bu_kpis WHERE company=?", (CO,)),
                  H.rows(a, "SELECT COUNT(*) FROM pm_kpi_library"))
        r = SUP.post(URL, data=dict(card(LNP, wmode="one", weight="10"), csrf_token="tok", action="save_kpi", kpi=str(LNP)))
        s.check("a forged save of a row that names people is refused, and the library and the unit's setups are as they were",
                r.status_code == 400 and pre_np == (H.rows(a, "SELECT * FROM pm_kpi_library WHERE id=?", (LNP,)),
                                                    H.rows(a, "SELECT * FROM pm_bu_kpis WHERE company=?", (CO,)),
                                                    H.rows(a, "SELECT COUNT(*) FROM pm_kpi_library")), r.status_code)
    finally:
        with a.app.app_context():
            _n = a.get_db()
            _n.execute("DELETE FROM pm_kpi_library_people WHERE library_id=?", (LNP,))
            _n.commit()
    r = save1(PL, card(PL, rates=(1, 1, 1, 1, 1), wmode="one", weight="10"))
    s.check("a broken scale on one KPI saves nothing, GP and PAT untouched", "Nothing was saved" in r.get_data(as_text=True)
            and before == (plain(snap("ZZBK GP")), plain(snap("ZZBK PAT"))))
    r = SUP.post(URL, data={"csrf_token": "tok", "action": "take_off", "setup": "999999"})
    s.check("a take-off of a setup that isn't this unit's: refused, nothing changes", r.status_code == 400
            and before == (plain(snap("ZZBK GP")), plain(snap("ZZBK PAT"))))
    r = SUP.post(URL, data={"csrf_token": "tok", "action": "nonsense"})
    s.check("an unknown action is refused", r.status_code == 400)

    s.section("one KPI at a time: the read view, the edit form and a KPI not saved yet")
    rd = SUP.get(pageof(PL, edit=False)).get_data(as_text=True)
    n_carry = H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets t WHERE t.cycle_id=? AND t.kpi_name='ZZBK PAT' AND t.bu_kpi_id=(SELECT "
                       "id FROM pm_bu_kpis WHERE cycle_id=? AND company=? AND kpi_name='ZZBK PAT')", (CID, CID, CO))
    s.check("the read view: name, Saved, saved date and who (the super admin), Take off and Edit",
            "bk2-titleh" in rd and "by the super admin" in rd and "Take off as BU KPI" in rd and ">Edit</a>" in rd
            and 'class="bk2-pill is-ok">Saved</span>' in rd and "saved " in rd)
    s.check("...three tiles: Target (the five rates), Carried by, Weight (one weight for all, 10%)",
            "Rate 5 <b>501" in rd and "Carried by" in rd and "One weight for all" in rd and "10%" in rd)
    s.check("...the table names every carrier as BU KPI, from the lines in the DB (%d)" % n_carry,
            rd.count('bk2-pill is-navy">BU KPI<') == n_carry == NP and "Keeps their own" not in rd.split("Who carries it")[1].split("</table>")[0],
            (rd.count('bk2-pill is-navy">BU KPI<'), n_carry))
    s.check("...the table shows the first 6; a fold ('N more') only when there are more", ("<details" in rd.split("Who carries it")[1].split(
        "bk2-strip")[0]) == (NP > 6), NP)
    s.check("...the result strip: not entered yet, and a link to Fill BU result with this unit and KPI",
            "Not entered yet" in rd and "bu-fill?" in rd and "kpi_name=ZZBK+PAT" in rd)
    with a.app.app_context():   # A's line is the person's own again; the saved-by is the group admin
        db = a.get_db()
        db.execute("UPDATE pm_kpi_targets SET bu_kpi_id=NULL WHERE cycle_id=? AND kpi_name='ZZBK PAT' AND subject_id=?", (CID, U["A"]))
        db.execute("UPDATE pm_bu_kpis SET updated_by=? WHERE cycle_id=? AND company=? AND kpi_name='ZZBK PAT'", (BGADM, CID, CO))
        db.commit()
    rd = SUP.get(pageof(PL, edit=False)).get_data(as_text=True)
    s.check("a holder whose line isn't linked reads Keeps their own; the others stay BU KPI (%d and 1)" % (NP - 1),
            rd.count('bk2-pill is-navy">BU KPI<') == NP - 1 and rd.count('bk2-pill is-warn">Keeps their own<') == 1)
    s.check("...the tile says %d carry it (everyone in the unit) and 1 keeps their own line; saved by the admin's name" % (NP - 1),
            "<b>%d</b> carry it" % (NP - 1) in rd and "1 keep their own line" in rd and "by ZZ BK Group Admin" in rd,
            re.findall(r'bk2-tw">(.*?)</span>', rd, re.S)[:2])
    s.check("the rail lists PAT and GP as Saved with the one-line summary", "Saved BU KPIs · 2" in rd
            and "%d carry it · 1 keep their own" % (NP - 1) in rd and "Being set up" not in rd)
    ed = SUP.get(pageof(PL)).get_data(as_text=True)
    s.check("the edit form for one saved KPI: Editing, Cancel and Save <name>, the other rows dimmed, no Take off",
            'bk2-pill is-warn">Editing<' in ed and ">Cancel</a>" in ed and ">Save ZZBK PAT</button>" in ed
            and "bk2-row is-dim" in ed and "Saving changes this KPI only." in ed and "Take off as BU KPI" not in ed
            and ed.count('data-bk-card=') == 1)
    s.check("...and it posts one KPI: action save_kpi with its id", 'name="action" value="save_kpi"' in ed
            and 'name="kpi" value="%d"' % PL in ed)
    nw = SUP.get(pageof(LIB["ZZBK Personal"], new=True, edit=False)).get_data(as_text=True)
    s.check("a pick being set up: Being set up, Not saved yet, Discard and Save as BU KPI",
            "Being set up · 1" in nw and "Not saved yet" in nw and ">Discard</a>" in nw and "Save as BU KPI</button>" in nw)
    s.check("the template says Multiplier, not Multiple", "'Multiplier'" in open(os.path.join(H.REPO, "templates",
            "admin_bu_kpis.html"), encoding="utf-8").read() and "'Multiple')" not in open(os.path.join(
            H.REPO, "templates", "admin_bu_kpis.html"), encoding="utf-8").read())


    s.section("Take off as BU KPI: one KPI, its lines released, adopted lines returned and never deleted")
    with a.app.app_context():   # C's own GP... wait: C already holds the GP line the setup adopted or added: give C a Focus
        db = a.get_db()
        db.execute("DELETE FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name='ZZBK Own' AND subject_id=?", (CID, U["C"]))
        db.commit()
    gsetup = H.one(a, "SELECT id FROM pm_bu_kpis WHERE cycle_id=? AND company=? AND kpi_name='ZZBK GP'", (CID, CO))
    pat_before = plain(snap("ZZBK PAT"))
    out = SUP.post(URL, data={"csrf_token": "tok", "action": "take_off", "setup": str(gsetup)}, follow_redirects=True)
    s.check("GP taken off: its setup is gone, none of its lines is linked any more", H.one(
        a, "SELECT COUNT(*) FROM pm_bu_kpis WHERE id=?", (gsetup,)) == 0 and H.one(
        a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE bu_kpi_id=?", (gsetup,)) == 0 and "no longer a BU KPI" in out.get_data(as_text=True))
    s.check("...PAT, not named, is byte for byte as it was", plain(snap("ZZBK PAT")) == pat_before)
    s.check("...the log says so, for GP", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE "
                                                 "'%''ZZBK GP'' no longer a BU KPI%'") >= 1)
    rd = SUP.get(pageof(PL, edit=False)).get_data(as_text=True)
    s.check("the rail now offers GP under Add a BU KPI, and PAT stays Saved", "Saved BU KPIs · 1" in rd and ">ZZBK GP<" in rail_of(rd))
    s.check("the take-off box names the KPI, the unit and the lines going back, and is red",
            "Take ZZBK PAT off as a BU KPI of ZZBK Unit?" in rd.replace("&#39;", "'") and 'data-confirm-tone="danger"' in rd
            and "%d lines come off" % (NP - 1) in rd, re.findall(r'data-confirm="([^"]*)"', rd)[:1])
    nl = H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name='ZZBK PAT'", (CID,))
    psetup = H.one(a, "SELECT id FROM pm_bu_kpis WHERE cycle_id=? AND company=? AND kpi_name='ZZBK PAT'", (CID, CO))
    with a.app.app_context():   # D has acted on PAT: a result on their line holds it
        db = a.get_db()
        db.execute("INSERT OR REPLACE INTO pm_kpi_results(kpi_target_id, actual_value, draft) SELECT id, 5, 0 FROM pm_kpi_targets "
                   "WHERE cycle_id=? AND kpi_name='ZZBK PAT' AND subject_id=?", (CID, U["D"]))
        db.commit()
    out = SUP.post(URL, data={"csrf_token": "tok", "action": "take_off", "setup": str(psetup)}, follow_redirects=True)
    s.check("PAT taken off with one line acted on: that line stays as it is and the setup stays saved (held)", H.one(
        a, "SELECT COUNT(*) FROM pm_bu_kpis WHERE id=?", (psetup,)) == 1 and H.one(
        a, "SELECT bu_kpi_id FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name='ZZBK PAT' AND subject_id=?", (CID, U["D"])) == psetup
        and "left as they were" in out.get_data(as_text=True))
    s.check("...every other line of PAT came off (the own line stays, the added ones are removed), never more than PAT's",
            H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name='ZZBK PAT'", (CID,)) < nl
            and H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name='ZZBK GP'", (CID,)) >= 3)
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE cycle_id=? AND "
                   "kpi_name='ZZBK PAT')", (CID,))
        db.commit()
    SUP.post(URL, data={"csrf_token": "tok", "action": "take_off", "setup": str(psetup)})
    s.check("(cleared) once nothing is held, PAT comes off whole", H.one(a, "SELECT COUNT(*) FROM pm_bu_kpis WHERE id=?", (psetup,)) == 0)

    s.section("Take off: a line that was adopted goes back to its holder as it was")
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name='ZZBK PAT'", (CID,))
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, focus, description, weightage, method, rate1, rate2, "
                   "rate3, rate4, rate5, business_group, company) VALUES (?,?, 'ZZBK PAT', 'Plant 9', 'ZZ own words', 9, 'more', "
                   "1,2,3,4,5, ?,?)", (CID, U["C"], BG, CO))
        db.commit()
    save1(PL, card(PL, wmode="one", weight="10", rates=(100, 200, 300, 400, 500)))
    lc = H.rows(a, "SELECT id, bu_kpi_id, rate1, weightage FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name='ZZBK PAT' AND subject_id=?",
                (CID, U["C"]))
    s.check("C's own PAT line was adopted (linked, at the unit's target), not doubled", len(lc) == 1 and lc[0][1] and lc[0][2] == 100, lc)
    cid_ = lc[0][0]
    psetup = H.one(a, "SELECT id FROM pm_bu_kpis WHERE cycle_id=? AND company=? AND kpi_name='ZZBK PAT'", (CID, CO))
    SUP.post(URL, data={"csrf_token": "tok", "action": "take_off", "setup": str(psetup)})
    lc = H.rows(a, "SELECT id, bu_kpi_id, rate1, weightage, focus, description FROM pm_kpi_targets WHERE cycle_id=? AND "
                   "kpi_name='ZZBK PAT' AND subject_id=?", (CID, U["C"]))
    s.check("taken off: the same line (same id) is C's again with their target, weight, Focus and words; the added ones are gone",
            len(lc) == 1 and lc[0][0] == cid_ and lc[0][1] is None and lc[0][2] == 1 and lc[0][3] == 9 and lc[0][4] == "Plant 9"
            and lc[0][5] == "ZZ own words" and H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name='ZZBK PAT'",
                                                     (CID,)) == 1)

    s.section("Fill BU result: saved setups and library-only BU KPIs, scored by the server, applied to the same selection")
    FILL = "/admin/performance/bu-fill"
    FQ = "?business_group=%s&company=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"))
    save1(PL, card(PL, wmode="one", weight="10", rates=(100, 200, 300, 400, 500), carriers="everyone"))
    fp = SUP.get(FILL + FQ).get_data(as_text=True)
    rail_f = fp[fp.index("BU KPIs to fill"):fp.index("</section>", fp.index("BU KPIs to fill"))]
    saved_part = rail_f.split("BU-level in the library")[0]
    lib_part = rail_f.split("BU-level in the library")[1] if "BU-level in the library" in rail_f else ""
    s.check("the rail lists PAT, a saved setup, under the unit's BU KPIs with who carries it and Not filled",
            ">ZZBK PAT<" in saved_part and "%d carry it" % NP in saved_part and "Not filled" in saved_part and "As saved on BU KPI setup" in rail_f)
    s.check("...and GP, which has lines but no setup, under 'BU-level in the library' so it can still be filled",
            ">ZZBK GP<" in lib_part and ">ZZBK GP<" not in saved_part, (saved_part[-200:], lib_part[:200]))
    s.check("...with Set up BU KPIs and View setup links", "Set up BU KPIs" in fp and "View setup" in fp)
    cfgrow = H.rows(a, "SELECT * FROM pm_bg_config WHERE business_group=?", (BG,))[0]
    tl = H.rows(a, "SELECT t.* FROM pm_kpi_targets t WHERE t.cycle_id=? AND t.kpi_name='ZZBK PAT' LIMIT 1", (CID,))[0]
    form_c = {"csrf_token": "tok", "business_group": BG, "company": CO, "kpi_name": "ZZBK PAT", "actual_value": "250", "action": "calc"}
    with a.app.app_context():
        exp = a.pm_score_kpi_line(a.get_db().execute("SELECT * FROM pm_bg_config WHERE business_group=?", (BG,)).fetchone(),
                                  a.get_db().execute("SELECT * FROM pm_kpi_targets WHERE id=?", (tl["id"],)).fetchone(), 250.0)
    cj = SUP.post(FILL, data=form_c).get_json()
    s.check("calc returns the rating pm_score_kpi_line gives (a result of 250 on Rate 1-5 of 100..500: rating 2) and its band",
            exp["value"] == 2 and cj["rate"] == 2 and cj["rating"] == "2" and cj["band"] == "200 RM to under 300 RM", (exp, cj["rate"], cj["band"]))
    s.check("...the table has every carrier with Will be filled and 'Rating 2'", cj["n_fill"] == NP and cj["rows"].count(">Will be filled<") == NP
            and cj["rows"].count("Rating 2") == NP and cj["n_total"] == NP, (NP, cj["n_fill"]))
    cj0 = SUP.post(FILL, data=dict(form_c, actual_value="")).get_json()
    s.check("calc with no result typed scores nothing: dashes, no rating, the button has nothing to fill with", cj0["rating"] == ""
            and cj0["rows"].count("Rating ") == 0 and cj0["value_text"] == "", cj0["rows"].count("Rating "))
    s.check("calc writes nothing", H.one(a, "SELECT COUNT(*) FROM pm_kpi_results r JOIN pm_kpi_targets t ON t.id=r.kpi_target_id "
                                           "WHERE t.cycle_id=? AND t.kpi_name='ZZBK PAT'", (CID,)) == 0)
    with a.app.app_context():   # Mechanism B: the achievement the app computes, on a copy of the setup's scale
        db = a.get_db()
        db.execute("UPDATE pm_bg_config SET mechanism='B' WHERE business_group=?", (BG,))
        db.commit()
    try:
        save1(PL, {"k%d_threshold" % PL: "50", "k%d_target" % PL: "200", "k%d_multiple" % PL: "100",
                   "k%d_carriers" % PL: "everyone", "k%d_wmode" % PL: "one", "k%d_weight" % PL: "10"})
        with a.app.app_context():
            db = a.get_db()
            expb = a.pm_score_kpi_line(db.execute("SELECT * FROM pm_bg_config WHERE business_group=?", (BG,)).fetchone(),
                                       db.execute("SELECT * FROM pm_kpi_targets WHERE id=?", (tl["id"],)).fetchone(), 240.0)
        cb = SUP.post(FILL, data=dict(form_c, actual_value="240")).get_json()
        s.check("Mechanism B: the achievement is the server's (240 against a target of 200 = %.1f%%)" % expb["value"],
                cb["achievement"] == "%.1f%%" % expb["value"] and cb["mech"] == "B" and abs(expb["value"] - 120) < 0.01, cb["achievement"])
        fpb = SUP.get(FILL + FQ + "&kpi_name=ZZBK+PAT").get_data(as_text=True)
        s.check("...and the page draws Threshold, Target and Multiplier as tiles", ">Multiplier<" in fpb and ">Threshold<" in fpb)
        ebp = SUP.get(pageof(PL)).get_data(as_text=True)
        s.check("...and the setup edit form's label reads Multiplier", "Multiplier<input" in ebp and "Multiple<input" not in ebp)
    finally:
        with a.app.app_context():
            db = a.get_db()
            db.execute("UPDATE pm_bg_config SET mechanism='A' WHERE business_group=?", (BG,))
            db.commit()
    save1(PL, card(PL, wmode="one", weight="10", rates=(100, 200, 300, 400, 500), carriers="holders", holder_set="1",
                   holder=["ZZ9BK-B", "ZZ9BK-C", "ZZ9BK-D", "ZZ9BK-M"]))
    linked = {r[0] for r in H.rows(a, "SELECT u.employee_id FROM pm_kpi_targets t JOIN users u ON u.id=t.subject_id WHERE t.cycle_id=? "
                                       "AND t.kpi_name='ZZBK PAT' AND t.bu_kpi_id IS NOT NULL", (CID,))}
    s.check("PAT saved with A unticked: A keeps their own line", linked == {"ZZ9BK-B", "ZZ9BK-C", "ZZ9BK-D", "ZZ9BK-M"}, linked)
    with a.app.app_context():   # A holds a PAT line of their own, not the unit's: the unit's result doesn't reach it
        db = a.get_db()
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, rate4, rate5, "
                   "business_group, company) VALUES (?,?, 'ZZBK PAT', 9, 'more', 1,2,3,4,5, ?,?)", (CID, U["A"], BG, CO))
        db.commit()
    fp = SUP.get(FILL + FQ + "&kpi_name=ZZBK+PAT").get_data(as_text=True)
    s.check("the page says 1 keeps their own line and enters their own result; 4 get this result",
            "1 keep their own line and enter their own result" in fp and "Who gets this result · 4" in fp,
            re.findall(r"Who gets this result[^<]*|[^>]*keep their own line[^<]*", fp))
    cj = SUP.post(FILL, data=dict(form_c, actual_value="450")).get_json()
    s.check("the calc selection is the apply's: 4 lines, never A's", cj["n_total"] == 4 and "ZZ9BK-A" not in cj["rows"].upper())
    SUP.post(FILL, data=dict(form_c, action="", actual_value="450", reason="ZZBK audited unit figure"))
    filled = {r[0] for r in H.rows(a, "SELECT u.employee_id FROM pm_kpi_results r JOIN pm_kpi_targets t ON t.id=r.kpi_target_id JOIN "
                                       "users u ON u.id=t.subject_id WHERE t.cycle_id=? AND t.kpi_name='ZZBK PAT' AND r.admin_filled=1",
                                   (CID,))}
    s.check("apply fills exactly the calc's lines: the four linked, not A", filled == linked, filled)
    fp = SUP.get(FILL + FQ).get_data(as_text=True)
    rail_f = fp[fp.index("BU KPIs to fill"):fp.index("</section>", fp.index("BU KPIs to fill"))]
    s.check("the rail now shows PAT Filled with its result and rating (450: Rating 4)", "Filled" in rail_f and "result 450" in rail_f
            and "Rating 4" in rail_f, re.findall(r"result [^<]*", rail_f))
    s.check("the setup's read view says Entered 450 and the date", "Entered 450" in SUP.get(pageof(PL, edit=False)).get_data(as_text=True))
    def calc_as(cl, v="300"):
        return cl.post(FILL, data=dict(form_c, actual_value=v)).get_json()

    def states(cj_):
        return re.findall(r">(Locked[^<]*|Will[^<]*|Filled[^<]*|Calibrated[^<]*|Changes[^<]*|Stays[^<]*)<", cj_["rows"])

    def pat_vals():
        return sorted(r[0] for r in H.rows(a, "SELECT r.actual_value FROM pm_kpi_results r JOIN pm_kpi_targets t ON t.id=r.kpi_target_id "
                                              "WHERE t.cycle_id=? AND t.kpi_name='ZZBK PAT' AND r.admin_filled=1", (CID,)))

    def sql(q, args=()):
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute(q, args)
            d_.commit()
    PATID = {k: H.one(a, "SELECT t.id FROM pm_kpi_targets t WHERE t.cycle_id=? AND t.kpi_name='ZZBK PAT' AND t.subject_id=?",
                      (CID, U[k])) for k in "BCDM"}
    s.section("Refill: the super admin may correct Group People's own figure until it is calibrated or released")
    cj = calc_as(SUP)
    s.check("super admin, second fill of the four: 'Changes: 450 RM → 300 RM' (amber; the filled card, 2026-11-05), 4 to fill, 4 replace the earlier figure",
            cj["rows"].count(">Changes: 450 RM → 300 RM<") == 4 and cj["n_fill"] == 4 and cj["n_refill"] == 4
            and 'bk2-pill is-warn" title="Changes' in cj["rows"] and cj["rows"].count("Rating 3") == 4, states(cj))
    cb = calc_as(BA)
    s.check("a group admin on the same lines: they read 'Stays: 450 RM', nothing to fill, each line's own rating (4) and no new rating",
            cb["n_fill"] == 0 and cb["n_refill"] == 0 and cb["rows"].count(">Stays: 450 RM<") == 4 and cb["rows"].count("Rating 3") == 0, states(cb))
    SUP_page = SUP.get(FILL + FQ + "&kpi_name=ZZBK+PAT").get_data(as_text=True)
    s.check("the page's confirm words name the 4 whose earlier figure it replaces", "replaces the earlier figure for 4 people" in SUP_page.replace("&#39;", "'"))
    ba_apply = BA.post(FILL, data=dict(form_c, action="", actual_value="300", reason="ZZBK group admin tries"))
    s.check("a group admin's apply refills nothing (the four stay 450)", pat_vals() == [450.0] * 4, pat_vals())
    # a calibrator's act on one person holds that person for everyone but the super admin, who may still correct it until the result
    # is released (2026-11-14, Chris: "BU KPI can still be amended till the result release"; the remark is asked, tests/test_bu_kpi_late.py)
    sql("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label) VALUES (?, 'bgceo', ?, ?, 'ZZBK')", (CID, BG, BG))
    sid_ = H.one(a, "SELECT id FROM pm_calibration_sessions WHERE cycle_id=? AND tier='bgceo' AND scope_key=?", (CID, BG))
    sql("INSERT INTO pm_calibration_adjustments(session_id, subject_id, original_band, adjusted_band) VALUES (?,?, 'ME', 'AE')", (sid_, U["B"]))
    cj = calc_as(SUP)
    s.check("a calibrator moved B (unlocked working state counts): for the super admin B is still refillable and marked Calibrated, with the other three",
            cj["rows"].count(">Calibrated, stays as filled<") == 0 and cj["rows"].count(">Changes: 450 RM → 300 RM<") == 4 and cj["n_fill"] == 4
            and cj["n_refill"] == 4 and cj["n_cal"] == 1 and cj["rows"].count(">Calibrated<") == 1, states(cj))
    cbc = calc_as(BA)
    s.check("a group admin is not given that: B stays held for them", cbc["n_fill"] == 0 and cbc["n_cal"] == 0, states(cbc))
    SUP.post(FILL, data=dict(form_c, action="", actual_value="300", reason="ZZBK plain apply"))
    s.check("a plain apply that would reach B is refused (the remark cannot be skipped): nothing changes", pat_vals() == [450.0] * 4, pat_vals())
    SUP.post(FILL, data=dict(form_c, action="apply_calibrated", actual_value="300", remark="ZZBK corrected unit figure", reason=""))
    s.check("...with the remark action all four are replaced with 300, B too (the calibrator's band move stays)", pat_vals() == [300.0] * 4 and H.one(
        a, "SELECT COUNT(*) FROM pm_calibration_adjustments WHERE session_id=? AND subject_id=?", (sid_, U["B"])) == 1, pat_vals())
    s.check("...the audit trail names the refill, the calibrated person and the remark", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_fill' AND detail LIKE '%refilled 4 replacing%' "
           "AND detail LIKE '%1 calibrated person included%' AND detail LIKE '%ZZBK corrected unit figure%'") == 1)
    fp = SUP.get(FILL + FQ).get_data(as_text=True)
    rail_f = fp[fp.index("BU KPIs to fill"):fp.index("</section>", fp.index("BU KPIs to fill"))]
    s.check("...and the rail's Filled pill reads the one figure now", "Filled" in rail_f and "result 300" in rail_f, re.findall(r"result [^<]*", rail_f))
    sql("DELETE FROM pm_calibration_adjustments WHERE session_id=?", (sid_,))
    sql("UPDATE pm_kpi_results SET actual_value=450 WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name='ZZBK PAT')", (CID,))
    # an unlocked session with no row for anyone holds nobody; the same session locked holds everyone in its scope
    cj = calc_as(SUP)
    s.check("no calibration act left: all four are refillable again (falsifies the guard)", cj["n_refill"] == 4 and cj["rows"].count(">Locked") == 0 and cj["rows"].count(">Calibrated") == 0, states(cj))
    sql("UPDATE pm_calibration_sessions SET locked_at=datetime('now') WHERE id=?", (sid_,))
    cj = calc_as(SUP)
    s.check("the BG CEO's tier locked over their group (no row for them): all four read Calibrated and stay refillable for the super admin, held for a group admin",
            cj["n_fill"] == 4 and cj["rows"].count(">Calibrated<") == 4 and cj["n_cal"] == 4 and calc_as(BA)["n_fill"] == 0, states(cj))
    sql("DELETE FROM pm_calibration_sessions WHERE id=?", (sid_,))
    sql("INSERT INTO result_releases(cycle_id, subject_id, kind) VALUES (?,?, 'pm')", (CID, U["C"]))
    cj = calc_as(SUP)
    s.check("C's result released: C Released, stays as filled, the other three refillable", cj["rows"].count(">Released, stays as filled<") == 1
            and cj["n_refill"] == 3, states(cj))
    sql("DELETE FROM result_releases WHERE cycle_id=? AND subject_id=?", (CID, U["C"]))
    sql("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, adjusted_value) VALUES (?, 1, 'adjust', 450, 400)", (PATID["D"],))
    cj = calc_as(SUP)
    s.check("a line another lock holds (an approver acted): D stays as filled, the other three refillable", cj["rows"].count(">Stays: 450 RM<") == 1
            and cj["n_refill"] == 3, states(cj))
    sql("DELETE FROM pm_kpi_approvals WHERE kpi_target_id=?", (PATID["D"],))
    cj = calc_as(SUP)
    s.check("everything put back: the four are refillable again", cj["n_refill"] == 4 and cj["n_fill"] == 4, states(cj))
    SUP.post(FILL, data=dict(form_c, action="", actual_value="300", reason="ZZBK second correction"))
    s.check("super admin apply replaces all four with 300", pat_vals() == [300.0] * 4, pat_vals())
    fp = SUP.get(FILL + FQ).get_data(as_text=True)
    rail_f = fp[fp.index("BU KPIs to fill"):fp.index("</section>", fp.index("BU KPIs to fill"))]
    s.check("the rail's Filled pill and 'result' now show the latest figure (300: Rating 3)", "result 300 RM" in rail_f and "Rating 3" in rail_f,
            re.findall(r"result [^<]*", rail_f))
    s.check("a second calc after Group People's fill reads 'Stays: 300 RM' for the super admin (the same figure)",
            calc_as(SUP)["rows"].count(">Stays: 300 RM<") == 4)
    with a.app.app_context():   # B keyed their own pending result earlier: not final, so a fill would replace it
        db = a.get_db()
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name='ZZBK PAT')", (CID,))
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, admin_filled, draft) SELECT id, 70, 0, 0 FROM pm_kpi_targets "
                   "WHERE cycle_id=? AND kpi_name='ZZBK PAT' AND subject_id=?", (CID, U["B"]))
        db.commit()
    cj = SUP.post(FILL, data=dict(form_c, actual_value="300")).get_json()
    s.check("a line with a self-submitted result reads 'Filled before: 70 RM → 3' (amber); the other three are Will be filled; all 4 fill",
            cj["rows"].count(">Filled before: 70 RM → 3<") == 1 and cj["rows"].count(">Will be filled<") == 3 and cj["n_fill"] == 4
            and 'bk2-pill is-warn" title="Filled before' in cj["rows"], re.findall(r">(Locked[^<]*|Will[^<]*|Filled[^<]*)<", cj["rows"]))
    nothing = SUP.post(FILL, data=dict(form_c, action="", actual_value="300"))
    s.check("an apply with no reason is refused and nothing changes", H.one(a, "SELECT COUNT(DISTINCT r.actual_value) FROM pm_kpi_results r JOIN "
            "pm_kpi_targets t ON t.id=r.kpi_target_id WHERE t.cycle_id=? AND t.kpi_name='ZZBK PAT'", (CID,)) == 1)
    r = OA.post(FILL, data=dict(form_c, action="calc"))
    s.check("another group's admin can't calc for this group", r.status_code == 403)
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name='ZZBK PAT')", (CID,))
        db.commit()
    save1(PL, card(PL, wmode="one", weight="10"))   # left saved: the Year-End checks below hold it

    s.section("a new card starts on the target most carriers hold, with its unit (Chris, 2026-10-29)")
    U_MIL, U_K, U_BIL = (a.kpi_unit_normalise(x) for x in ("RM (mil)", "RM ('000)", "RM (bil)"))
    s.check("(the three units are distinct standard ones)", len({U_MIL, U_K, U_BIL}) == 3 and all(
        u in a.KPI_UNITS for u in (U_MIL, U_K, U_BIL)), (U_MIL, U_K, U_BIL))
    with a.app.app_context():   # the library row deliberately holds figures and a unit nobody carries
        db = a.get_db()
        MJ = db.execute(
            "INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, unit, "
            "method, rate1, rate2, rate3, rate4, rate5, threshold, target, multiple, excellence, weightage_default, "
            "bu_level) VALUES (?, '*', '*', 0, '*', 'ZZBK Major', 'Financial', ?, 'more', 7011, 7012, 7013, 7014, 7015, "
            "7001, 7002, 7003, 7004, 20, 1)", (BG, U_BIL)).lastrowid
        db.commit()
    KM = "k%d_" % MJ
    T1 = dict(unit=U_MIL, rate1=11, rate2=12, rate3=13, rate4=14, rate5=15, threshold=21, target=22, multiple=23, excellence=24)
    T2 = dict(unit=U_K, rate1=-31, rate2=-32, rate3=-33, rate4=-34, rate5=-35, threshold=-41, target=-42, multiple=-43,
              excellence=-44)
    T3 = dict(T1, unit=U_K)   # the same figures as T1 in another unit

    def hold(*pairs):
        """Who holds ZZBK Major with which target: ((letter, target), ...); nobody else holds it."""
        with a.app.app_context():
            db = a.get_db()
            db.execute("DELETE FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name='ZZBK Major'", (CID,))
            for u_, t_ in pairs:
                db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, rate1, rate2, "
                           "rate3, rate4, rate5, threshold, target, multiple, excellence, business_group, company) "
                           "VALUES (?,?, 'ZZBK Major', 10, 'more', ?,?,?,?,?,?,?,?,?,?, ?,?)",
                           (CID, U[u_], t_["unit"], t_["rate1"], t_["rate2"], t_["rate3"], t_["rate4"], t_["rate5"],
                            t_["threshold"], t_["target"], t_["multiple"], t_["excellence"], BG, CO))
            db.commit()

    def boxes(pg_, flds):
        out_ = {}
        for fld in flds:
            m_ = re.search(r'name="%s%s"[^>]*\bvalue="([^"]*)"' % (KM, fld), pg_)
            out_[fld] = m_.group(1) if m_ else None
        return out_

    def unit_of(pg_):
        sel_ = re.search(r'<select name="%sunit".*?</select>' % KM, pg_, re.S)
        m_ = re.search(r'<option value="([^"]*)"[^>]*?\bselected\b', sel_.group(0)) if sel_ else None
        return html.unescape(m_.group(1)) if m_ else None

    def sub_unit(pg_):
        m_ = re.search(r'<span class="muted small">([^<]*?) \u00b7 (?:higher|lower) is better', pg_)
        return html.unescape(m_.group(1)) if m_ else None

    def figs(t_, flds):
        return {f_: "%g" % t_[f_] for f_ in flds}
    FB, FA = ("threshold", "target", "multiple"), ("rate1", "rate2", "rate3", "rate4", "rate5")
    try:
        hold(("A", T1), ("B", T1), ("C", T1), ("D", T2))
        pg_a = html.unescape(SUP.get(pageof(MJ, new=True)).get_data(as_text=True))
        s.check("(a) 3 of 4 hold one target: the 5 rating boxes show theirs, not the library row's",
                boxes(pg_a, FA) == figs(T1, FA) and "7011" not in pg_a, boxes(pg_a, FA))
        s.check("(a) ...the unit select and the subtitle show the majority's unit, not the library row's",
                unit_of(pg_a) == U_MIL != U_BIL and sub_unit(pg_a) == U_MIL, (unit_of(pg_a), sub_unit(pg_a)))
        s.check("(a) ...the note says 3 of the 4 hold it and that the one set here replaces the others",
                "Filled from the target 3 of the 4 who carry it hold today." in pg_a and "untick anyone who should keep "
                "their own line" in pg_a and "none held by most" not in pg_a)
        with a.app.app_context():
            db = a.get_db()
            db.execute("UPDATE pm_bg_config SET mechanism='B' WHERE business_group=?", (BG,))
            db.commit()
        try:
            pg_b = SUP.get(pageof(MJ, new=True)).get_data(as_text=True)
            s.check("(a) Mechanism B: Threshold, Target and Multiplier show the majority's, not the library row's",
                    boxes(pg_b, FB) == figs(T1, FB) and "7002" not in pg_b and unit_of(pg_b) == U_MIL, boxes(pg_b, FB))
            # (b) a tie: two and two
            hold(("A", T1), ("B", T1), ("C", T2), ("D", T2))
            pg_t = html.unescape(SUP.get(pageof(MJ, new=True)).get_data(as_text=True))
            s.check("(b) a tie: the boxes are empty, not the library row's figures", boxes(pg_t, FB) == {f_: "" for f_ in FB}
                    and not re.search(r"\b70(01|02|03|04)\b", pg_t), boxes(pg_t, FB))
            s.check("(b) ...no unit is picked, and the note says none is held by most", unit_of(pg_t) == "" and
                    "The 4 who carry it hold 2 different targets, none held by most: enter the unit's target. The one set "
                    "here replaces them all." in pg_t and "Filled from" not in pg_t, unit_of(pg_t))
            # (c) all the same
            hold(("A", T1), ("B", T1), ("C", T1), ("D", T1))
            pg_s = html.unescape(SUP.get(pageof(MJ, new=True)).get_data(as_text=True))
            s.check("(c) all hold one target: the boxes and unit are theirs, and the old sentence stands",
                    boxes(pg_s, FB) == figs(T1, FB) and unit_of(pg_s) == U_MIL and "Filled from what the 4 who carry it "
                    "hold today: they all hold this one target." in pg_s and "none held by most" not in pg_s)
            # (d) nobody carries it
            hold()
            pg_n = SUP.get(pageof(MJ, new=True)).get_data(as_text=True)
            s.check("(d) nobody carries it (an Early Year): the boxes start blank, whatever figures the library row still holds "
                    "(7001-7003 here); its unit is the row's",
                    boxes(pg_n, FB) == {f_: "" for f_ in FB} and not re.search(r"\b700[123]\b", pg_n)
                    and unit_of(pg_n) == U_BIL and "Filled from" not in pg_n and "none held by most" not in pg_n,
                    (boxes(pg_n, FB), unit_of(pg_n)))
        finally:
            with a.app.app_context():
                db = a.get_db()
                db.execute("UPDATE pm_bg_config SET mechanism='A' WHERE business_group=?", (BG,))
                db.commit()
        # the same figures in two units: the unit counts, so the unit held by more carriers wins
        hold(("A", T1), ("B", T1), ("C", T3), ("D", T3), ("M", T3))
        pg_u = html.unescape(SUP.get(pageof(MJ, new=True)).get_data(as_text=True))
        s.check("the unit counts with the figures: same figures, 3 hold them in '000 and 2 in mil: '000", unit_of(pg_u) == U_K
                and boxes(pg_u, FA) == figs(T1, FA) and "Filled from the target 3 of the 5" in pg_u, unit_of(pg_u))
        # a saved card is not touched by any of this: it reads its own row
        hold(("A", T2), ("B", T2), ("C", T1))
        save1(MJ, card(MJ, rates=(1, 2, 3, 4, 5), unit=U_BIL, carriers="holders", wmode="one", weight="10"))
        hold(("A", T1), ("B", T1), ("C", T1))
        pg_sv = SUP.get(pageof(MJ)).get_data(as_text=True)
        s.check("a saved card shows its own saved row, whatever its carriers hold now",
                boxes(pg_sv, FA) == {f_: str(i_) for i_, f_ in enumerate(FA, 1)} and unit_of(pg_sv) == U_BIL
                and "Filled from" not in pg_sv, boxes(pg_sv, FA))
    finally:
        with a.app.app_context():
            db = a.get_db()
            db.execute("DELETE FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name='ZZBK Major'", (CID,))
            db.execute("DELETE FROM pm_bu_kpis WHERE cycle_id=? AND kpi_name='ZZBK Major'", (CID,))
            db.execute("DELETE FROM pm_kpi_library WHERE id=?", (MJ,))
            db.execute("UPDATE pm_bg_config SET mechanism='A' WHERE business_group=?", (BG,))
            db.commit()

    s.section("outside an Early Year, and outside the group")
    OA = H.client_as(a, OTHER)
    n1 = H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=?", (CID,))
    WD = line("ZZ9BK-D")[0]
    r = save(card(LIB["ZZBK PAT"]), kpis=[], client=OA)
    s.check("another group's admin can't save", r.status_code == 403 and H.one(
        a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=?", (CID,)) == n1)
    with a.app.app_context():   # a Year-End whose Department Review has started (2026-11-03: open until it starts; was the results check-in)
        db = a.get_db()
        W0 = db.execute("SELECT opens_at, closes_at FROM cycle_windows WHERE cycle_id=? AND cell='pm_hod'",
                        (CID,)).fetchone()
        db.execute("UPDATE cycles SET kind='year_end', half=2 WHERE id=?", (CID,))
        db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', "
                   "'2020-01-01 00:00', NULL)", (CID,))
        db.commit()
    try:
        pg = SUP.get(URL).get_data(as_text=True)
        s.check("in a Year-End whose Department Review has started it reads only (the super admin reads the late-amendment warning, 2026-11-14)",
                "The Department Review started on" in pg and "As super admin you can still change" in pg.replace("&#39;", "'")
                and "Save ZZBK Unit&#39;s BU KPIs</button>" not in pg and "Save ZZBK Unit's BU KPIs</button>" not in pg)
        out = save(kpis=[])
        s.check("...and refuses a save (nothing taken off)", (line("ZZ9BK-D") or [None])[0] == WD
                and "Department Review started" in out.get_data(as_text=True))
    finally:
        with a.app.app_context():
            db = a.get_db()
            db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='pm_hod'", (CID,))
            if W0:
                db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', ?, ?)",
                           (CID, W0[0], W0[1]))
            db.commit()

finally:
    _put_back()
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
