"""BU KPI setup until the HOD Department Review starts (Chris, 2026-11-03; before it, the results check-in), and any library
KPI for one unit (Chris, 2026-10-23: "BU KPI should be
enabled anytime before the start date of the KPI result entry, also can we add a feature here to allow super admin to
select which KPIs to be inserted as the BU KPIs from the KPI library list, and show how many people carrying this
KPIs?"; his calls: this unit only, outside an Early Year only those who carry it now, unticked lines back as they were;
canvas [design canvas link removed]).

What this suite holds:
  * the table: widened to 'holders' / 'own', an older table rebuilt with every row kept
  * a Year-End before the Department Review starts: open, saying until when; each KPI says how many carry it
  * outside an Early Year only those who carry it now, at their own weight: their line adopted, what it held kept;
    everyone / one weight refused, nothing saved
  * unticked: an adopted line goes back to its holder as it was (weight, target), never deleted
  * the super admin's library pick: the panel lists the group's library with counts; ?add= draws its card, nothing
    changes until the save; the save makes it BU-level for this unit only (HR's for its people, not another unit's);
    unticked, the unit's copy is retired and the KPI is each holder's own again; a BG admin can't pick
  * once the Department Review has started: read only, the save refused, no library panel
"""
import atexit
import html
import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("BU KPI setup: open until the Department Review, any library KPI for one unit")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO, CO2 = "ZZBW Group", "ZZBW Unit", "ZZBW Unit B"
U = {}


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9BW-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%ZZBW%'")
    db.execute("DELETE FROM pm_bu_kpis WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.execute("DELETE FROM admin_roles WHERE name='ZZBW role'")
    db.commit()


def ln(eid, name):
    r = H.rows(a, "SELECT t.weightage, t.rate1, t.rate5, t.bu_kpi_id, t.bu_prev_json, t.library_id FROM pm_kpi_targets t "
                  "JOIN users u ON u.id=t.subject_id WHERE t.cycle_id=? AND u.employee_id=? AND t.kpi_name=?",
               (CID, eid, name))
    return tuple(r[0]) if r else None


def hr_owned(eid, name):
    with a.app.test_request_context():
        db = a.get_db()
        u = db.execute("SELECT * FROM users WHERE employee_id=?", (eid,)).fetchone()
        return a._kpi_key(name) in a.pm_bu_level_names(db, u)


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    PREV = dict(db.execute("SELECT kind, year, half, min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())
    W0 = db.execute("SELECT opens_at, closes_at FROM cycle_windows WHERE cycle_id=? AND cell='pm_hod'",
                    (CID,)).fetchone()

    def _put_back():
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("UPDATE cycles SET kind=?, year=?, half=?, min_job_grade=? WHERE id=?",
                       (PREV["kind"], PREV["year"], PREV["half"], PREV["min_job_grade"], CID))
            d_.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='pm_hod'", (CID,))
            if W0:
                d_.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', ?, ?)",
                           (CID, W0[0], W0[1]))
            d_.commit()
    atexit.register(_put_back)
    db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL WHERE id=?", (CID,))
    db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', "
               "'2099-11-02 00:00', '2099-11-08 23:59')", (CID,))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?),(?,?)", (BG, CO, BG, CO2))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
    LIB = {}
    for nm, bu, cat in (("ZZBW PAT", 1, "Financial · Profitability"), ("ZZBW Sales", 0, "Customer · Sales"),
                        ("ZZBW Training", 0, "People · Learning")):
        LIB[nm] = db.execute(
            "INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, "
            "unit, method, rate1, rate2, rate3, rate4, rate5, weightage_default, bu_level) VALUES (?, '*', '*', 0, '*', ?, "
            "?, '%', 'more', 90, 95, 100, 105, 110, 20, ?)", (BG, nm, cat, bu)).lastrowid
    U["M"] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                        "company, department, job_grade, confirmation_date) VALUES ('zz9bw-m', 'ZZ BW Manager', 'x', "
                        "'user', 'ZZ9BW-M', ?, ?, 'Management', '21', '2020-01-01')", (BG, CO)).lastrowid
    for eid, co, dept in (("ZZ9BW-A", CO, "Sales"), ("ZZ9BW-B", CO, "Sales"), ("ZZ9BW-C", CO, "Finance"),
                          ("ZZ9BW-X", CO2, "Sales")):
        U[eid[-1]] = db.execute(
            "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
            "department, job_grade, confirmation_date, manager_id) VALUES (?,?, 'x', 'user', ?,?,?,?, '14', '2020-01-01', ?)",
            (eid.lower(), "ZZ BW " + eid[-1], eid, BG, co, dept, U["M"])).lastrowid

    def put(who, name, w, rates):
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, "
                   "rate2, rate3, rate4, rate5, business_group, company, library_id) VALUES (?,?,?,?, 'more', '%', 'Own',"
                   " ?,?,?,?,?, ?,?,?)", (CID, U[who], name, w) + tuple(rates) + (
                       BG, CO2 if who == "X" else CO, LIB[name]))
    put("A", "ZZBW PAT", 30, (90, 95, 100, 105, 110))
    put("B", "ZZBW PAT", 20, (90, 95, 100, 105, 110))
    put("A", "ZZBW Sales", 50, (80, 90, 100, 110, 120))   # their own targets: two different scales
    put("B", "ZZBW Sales", 40, (70, 85, 100, 115, 130))
    put("X", "ZZBW Sales", 60, (80, 90, 100, 110, 120))   # the other unit's: never touched
    db.execute("DELETE FROM admin_roles WHERE name='ZZBW role'")
    ROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZBW role', 'group')").lastrowid
    db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)",   # BU KPI setup is theirs to use
                   [(ROLE, "pm.read"), (ROLE, "pm.bu_kpi")])
    BGADM = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                       "admin_bg, admin_role_id) VALUES ('zz9bw-adm', 'ZZ BW Admin', 'x', 'admin', 'ZZ9BW-ADM', ?, ?, ?)",
                       (BG, BG, ROLE)).lastrowid
    db.commit()
SUP = H.client_as(a, SU["id"])
URL = "/admin/performance/bu-kpis?fbg=%s&fbu=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"))


def card(lid, carriers="holders", wmode="own", rates=(90, 95, 100, 105, 110), **kw):
    k = "k%d_" % lid
    f = {k + "rate%d" % i: str(v) for i, v in enumerate(rates, 1)}
    f[k + "carriers"] = carriers
    f[k + "wmode"] = wmode
    for key, v in kw.items():
        f[k + key] = v
    return f


def save(*cards, kpis=(), client=None):
    form = {"csrf_token": "tok", "action": "save", "kpi": [str(x) for x in kpis]}
    for c in cards:
        form.update(c)
    return (client or SUP).post(URL, data=form, follow_redirects=True)


try:
    s.section("the table takes the new modes; an older one is rebuilt with every row kept")
    with a.app.app_context():
        db = a.get_db()
        sql = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='pm_bu_kpis'").fetchone()[0]
        keep = [tuple(r) for r in db.execute("SELECT * FROM pm_bu_kpis ORDER BY id")]
    s.check("pm_bu_kpis takes 'holders' and 'own'", "'holders'" in sql and "'own'" in sql)
    raw = sqlite3.connect(a.DB_PATH)
    try:
        cols = [r[1] for r in raw.execute("PRAGMA table_info(pm_bu_kpis)")]
        # legacy rename: without it SQLite rewrites the other tables' REFERENCES pm_bu_kpis to the hold table, which is
        # dropped below, and the next suite to delete a cycle fails on "no such table: main.zzbw_bk_hold"
        raw.execute("PRAGMA legacy_alter_table=ON")
        raw.execute("ALTER TABLE pm_bu_kpis RENAME TO zzbw_bk_hold")
        raw.execute(a._PM_BU_KPIS_DDL.replace("'pick','holders'", "'pick'").replace("'grade','own'", "'grade'")
                    % "pm_bu_kpis")
        raw.execute("INSERT INTO pm_bu_kpis(%s) SELECT %s FROM zzbw_bk_hold" % (", ".join(cols), ", ".join(cols)))
        raw.execute("DROP TABLE zzbw_bk_hold")
        raw.commit()
    finally:
        raw.close()
    a._ensure_runtime_schema()
    with a.app.app_context():
        db = a.get_db()
        sql = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='pm_bu_kpis'").fetchone()[0]
        after = [tuple(r) for r in db.execute("SELECT * FROM pm_bu_kpis ORDER BY id")]
    s.check("an older table (no 'holders') is rebuilt by the migration, every row kept", "'holders'" in sql
            and after == keep, (len(keep), len(after)))

    s.section("a Year-End before the Department Review: open, each KPI with how many carry it")
    PADD = URL + "&add=%d&kpi=%d" % (LIB["ZZBW PAT"], LIB["ZZBW PAT"])   # PAT being set up, as the page's Add opens it
    pg = SUP.get(PADD).get_data(as_text=True)
    s.check("open, saying until when", "Open until the Department Review starts on 02 Nov 2099, 00:00." in pg
            and "Save as BU KPI</button>" in pg)
    s.check("PAT's rail row says 2 carry it; its card says so too, in one department", 'data-bk-name="ZZBW PAT"' in pg
            and "2 carry it now" in pg and ">2 people carry</a> it on" in pg and "carry it now · Sales" in pg)
    s.check("only those who carry it now, at their own weight; the others are for an Early Year",
            'value="holders" data-bk-mode checked' in pg and 'value="everyone" data-bk-mode  disabled' in pg
            and 'value="own" data-bk-wmode checked' in pg
            and "Everyone, a department or a grade is for an Early Year, where KPIs are set." in pg)   # the super admin's words (2026-11-06)

    s.section("outside an Early Year: only those who carry it now, at their own weight")
    n0 = H.one(a, "SELECT COUNT(*) FROM pm_bu_kpis WHERE business_group=?", (BG,))
    out = save(card(LIB["ZZBW PAT"], carriers="everyone"), kpis=[LIB["ZZBW PAT"]])
    s.check("everyone is refused, nothing saved", H.one(a, "SELECT COUNT(*) FROM pm_bu_kpis WHERE business_group=?",
                                                         (BG,)) == n0 == 0 and "'ZZBW PAT': outside an Early Year a BU KPI "
            "goes only on those who carry it now" in html.unescape(out.get_data(as_text=True)))
    out = save(card(LIB["ZZBW PAT"], wmode="one", weight="10"), kpis=[LIB["ZZBW PAT"]])
    s.check("one weight for all is refused, nothing saved", H.one(
        a, "SELECT COUNT(*) FROM pm_bu_kpis WHERE business_group=?", (BG,)) == 0
        and "keeps the weight on their line" in out.get_data(as_text=True))
    out = save(card(LIB["ZZBW PAT"], rates=(80, 90, 100, 110, 120)), kpis=[LIB["ZZBW PAT"]])
    pa, pb = ln("ZZ9BW-A", "ZZBW PAT"), ln("ZZ9BW-B", "ZZBW PAT")
    s.check("their lines adopted: the unit's target, each keeping their weight (30, 20)",
            pa[:3] == (30, 80, 120) and pb[:3] == (20, 80, 120) and pa[3] and pa[3] == pb[3], (pa, pb))
    s.check("...what each line held is kept on it", json.loads(pa[4] or "{}").get("rate1") == 90
            and json.loads(pa[4] or "{}").get("weightage") == 30, pa[4])
    s.check("...nobody new got a line (C, the manager)", ln("ZZ9BW-C", "ZZBW PAT") is None
            and ln("ZZ9BW-M", "ZZBW PAT") is None)
    s.check("...the page says how many were updated", "2 updated" in out.get_data(as_text=True))

    s.section("unticked: each adopted line goes back as it was")
    out = save(kpis=[])
    pa, pb = ln("ZZ9BW-A", "ZZBW PAT"), ln("ZZ9BW-B", "ZZBW PAT")
    s.check("never deleted: back to its own target and weight, unlinked", pa and pb and pa[:5] == (30, 90, 110, None, None)
            and pb[:5] == (20, 90, 110, None, None), (pa, pb))
    s.check("...the setup goes, and the page says they went back",
            H.one(a, "SELECT COUNT(*) FROM pm_bu_kpis WHERE business_group=?", (BG,)) == 0
            and "2 given back as they were" in out.get_data(as_text=True))

    s.section("the super admin's library pick: this unit only")
    pg = SUP.get(URL).get_data(as_text=True)
    s.check("the panel lists the group's library, most carried here first, with its counts", 'data-panel-open="bklib"' in pg
            and pg.index('data-bk-lprow="%d"' % LIB["ZZBW Sales"]) < pg.index('data-bk-lprow="%d"' % LIB["ZZBW Training"])
            and 'data-n="2" data-bgn="3"' in pg and "2 different targets: likely their own" in pg)
    s.check("...a BU-level KPI already on the list isn't offered", 'data-bk-lprow="%d"' % LIB["ZZBW PAT"] not in pg)
    pg = SUP.get(URL + "&add=%d&kpi=%d" % (LIB["ZZBW Sales"], LIB["ZZBW Sales"])).get_data(as_text=True)
    s.check("?add= draws its card, being set up and not saved, for this unit only", 'data-bk-card="%d"' % LIB["ZZBW Sales"] in pg
            and 'data-bk-pick="1"' in pg and "A BU KPI for ZZBW Unit only" in pg)
    s.check("...nothing has changed yet: no unit row, not HR's", H.one(
        a, "SELECT COUNT(*) FROM pm_kpi_library WHERE business_group=? AND company=?", (BG, CO)) == 0
        and not hr_owned("ZZ9BW-A", "ZZBW Sales"))
    BGA = H.client_as(a, BGADM)
    bp = BGA.get(URL + "&add=%d" % LIB["ZZBW Sales"]).get_data(as_text=True)
    s.check("a BG admin with BU KPI setup opens the page, with no library panel and no picked card",
            ">ZZBW PAT<" in bp and ">ZZBW Sales<" not in bp.split('aria-label="BU KPIs of this unit"')[1].split("</section>")[0] and 'data-panel-open="bklib"' not in bp and 'data-bk-pick="1"' not in bp)
    r = save(card(LIB["ZZBW Sales"]), kpis=[LIB["ZZBW Sales"]], client=BGA)
    s.check("...and can't save a pick from the library", r.status_code == 403, r.status_code)
    s.check("...nothing made", H.one(a, "SELECT COUNT(*) FROM pm_kpi_library WHERE business_group=? AND company=?",
                                     (BG, CO)) == 0 and ln("ZZ9BW-A", "ZZBW Sales")[3] is None)
    out = save(card(LIB["ZZBW Sales"], rates=(85, 92, 100, 108, 115)), kpis=[LIB["ZZBW Sales"]])
    urow = H.rows(a, "SELECT id, bu_level, active FROM pm_kpi_library WHERE business_group=? AND company=? AND "
                     "kpi_name='ZZBW Sales'", (BG, CO))
    s.check("saved: the unit's own BU-level library row is made", len(urow) == 1 and urow[0][1:] == (1, 1), urow)
    sa, sb = ln("ZZ9BW-A", "ZZBW Sales"), ln("ZZ9BW-B", "ZZBW Sales")
    s.check("...its two carriers here take the unit's target at their own weight", sa[:3] == (50, 85, 115)
            and sb[:3] == (40, 85, 115) and sa[5] == urow[0][0], (sa, sb))
    s.check("...HR's for this unit's people, not the other unit's", hr_owned("ZZ9BW-A", "ZZBW Sales")
            and not hr_owned("ZZ9BW-X", "ZZBW Sales"))
    s.check("...the other unit's line untouched", ln("ZZ9BW-X", "ZZBW Sales")[:4] == (60, 80, 120, None))
    s.check("...the trail says it was made a BU KPI for this unit only", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%ZZBW Sales%this unit only%'") == 1)
    pg = SUP.get(URL).get_data(as_text=True)
    rl = pg.split('aria-label="BU KPIs of this unit"')[1].split("</section>")[0]
    s.check("the list now holds it, saved", "Saved BU KPIs · 1" in rl and ">ZZBW Sales<" in rl)
    s.check("...and its card says it is a BU KPI for this unit only", "A BU KPI for ZZBW Unit only" in SUP.get(
        URL + "&kpi=%d&edit=1" % urow[0][0]).get_data(as_text=True))
    save(card(urow[0][0], rates=(85, 92, 100, 108, 115)), kpis=[urow[0][0]])
    s.check("saved again from its own row: unchanged, still the unit's", H.one(
        a, "SELECT COUNT(*) FROM pm_kpi_library WHERE business_group=? AND company=? AND active=1", (BG, CO)) == 1
        and ln("ZZ9BW-A", "ZZBW Sales")[:3] == (50, 85, 115))
    save(kpis=[])
    s.check("unticked: the unit's copy is retired and the lines go back as they were", tuple(H.rows(
        a, "SELECT bu_level, active FROM pm_kpi_library WHERE id=?", (urow[0][0],))[0]) == (0, 0)
        and ln("ZZ9BW-A", "ZZBW Sales")[:5] == (50, 80, 120, None, None)
        and ln("ZZ9BW-B", "ZZBW Sales")[:5] == (40, 70, 130, None, None), (H.rows(
        a, "SELECT bu_level, active FROM pm_kpi_library WHERE id=?", (urow[0][0],)), ln("ZZ9BW-A", "ZZBW Sales"),
        ln("ZZ9BW-B", "ZZBW Sales")))
    s.check("...and the KPI is its holders' own again", not hr_owned("ZZ9BW-A", "ZZBW Sales"))
    save(card(LIB["ZZBW Sales"]), kpis=[LIB["ZZBW Sales"]])
    s.check("picked again: the retired copy is put back, not doubled", tuple(H.rows(
        a, "SELECT COUNT(*), MAX(active), MAX(bu_level) FROM pm_kpi_library WHERE business_group=? AND company=?",
        (BG, CO))[0]) == (1, 1, 1), H.rows(a, "SELECT id, active, bu_level FROM pm_kpi_library WHERE business_group=? AND "
                                             "company=?", (BG, CO)))
    save(kpis=[])

    s.section("\"N carry it\" opens who they are, the super admin's (Chris, 2026-10-23)")
    pg = SUP.get(URL + "&add=%d&kpi=%d" % (LIB["ZZBW PAT"], LIB["ZZBW PAT"])).get_data(as_text=True)
    lu = "/admin/list/bu-kpi-holders?fragment=1&amp;bg=ZZBW+Group&amp;co=ZZBW+Unit&amp;kpi=ZZBW+PAT"
    s.check("the count is a link to its list panel, and the page has the panel", ('data-list-open="%s"' % lu) in pg
            and 'id="pnl-list"' in pg, lu)
    lp = html.unescape(SUP.get(html.unescape(lu)).get_data(as_text=True))
    s.check("the list: its two carriers by name, with their weight, and nobody who doesn't carry it",
            "ZZBW PAT · 2 carry it" in lp and "ZZ BW A" in lp and "ZZ BW B" in lp and "ZZ BW C" not in lp
            and "ZZ BW X" not in lp and "30%" in lp and "90 to 110 % · their own" in lp)
    s.check("...its headings one short word each, the full word on hover; Open has none (so no menu)",
            '<th title="Weight" data-full="Weight">W</th>' in lp and '<th title="Business unit" data-full="Business unit">BU'
            '</th>' in lp and '<th aria-label="Open"></th>' in lp and "sr-only" not in lp)
    bp = BGA.get(URL + "&add=%d&kpi=%d" % (LIB["ZZBW PAT"], LIB["ZZBW PAT"])).get_data(as_text=True)
    s.check("a BG admin reads the number, with no link and no panel", "2 people carry" in bp
            and "bu-kpi-holders" not in bp and 'id="pnl-list"' not in bp)
    s.check("...and can't open the list", BGA.get(html.unescape(lu)).status_code in (302, 403))

    s.section("once the Department Review has started: read only")
    with a.app.app_context():
        a.get_db().execute("UPDATE cycle_windows SET opens_at='2020-11-02 00:00' WHERE cycle_id=? AND cell='pm_hod'",
                           (CID,))
        a.get_db().commit()
    pg = SUP.get(URL + "&add=%d" % LIB["ZZBW Sales"]).get_data(as_text=True)
    # (2026-11-14) the super admin reads the late-amendment warning in place of the read-only note, with the same Fill BU result link
    s.check("it reads only, says since when, links Fill BU result", "The Department Review started on 02 Nov 2020, 00:00. As super admin "
            "you can still change" in pg.replace("&#39;", "'") and "so BU KPIs read only" not in pg and "Their results: <a" in pg
            and "Fill BU result</a>" in pg and "BU KPIs</button>" not in pg)
    s.check("...no library panel, no picked card", 'data-panel-open="bklib"' not in pg and 'data-bk-pick="1"' not in pg)
    out = save(card(LIB["ZZBW PAT"]), kpis=[LIB["ZZBW PAT"]])
    s.check("...and a save is refused", "Nothing was saved" in out.get_data(as_text=True) and H.one(
        a, "SELECT COUNT(*) FROM pm_bu_kpis WHERE business_group=?", (BG,)) == 0
        and ln("ZZ9BW-A", "ZZBW PAT")[3] is None)
finally:
    _put_back()
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
