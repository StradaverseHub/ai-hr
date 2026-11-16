"""The KPI targets import recommends ANOTHER unit's BU KPI, or a new one (Chris, 2026-11-07: "if a person A from BU 1 kpi line 1 is to follow PAT
from BU 2 (a BU KPI), the import should recommend to tag to BU 2 BU KPI"; canvas [design canvas link removed] board D1; brief
"Cross-BU KPI build brief 2026-11-07.md", Round 2 part B).

What this suite holds (every guard falsified by mutation, nothing left behind):
  * the match is plain text: the file row's KPI name or library alias has the setup's ROOT and its name, Focus or description names the unit (display
    name, HRIS name, or the setup's own variant qualifier) as WHOLE words, any case ("Starken 1" never matches "Starken 10"); that wins over the
    person's own unit's BU KPI of the same name; one unit named is pre-picked; two units named: the variant saved for both when there is one, else every
    option and none picked; another business group named: an info row; naming none: today's own-unit rule
  * a unit with no saved BU KPI of the root, the KPI BU-level in the library: "A new BU KPI for <unit>" (also for a row the library marks BU-level for
    the person's own unit); its lines form ONE group, the target picked from the file's own targets (the one most lines hold; a tie waits)
  * step 3 is a table of four fixed columns with a select on every line (the toggle and the Weight column are gone), recommended first
  * Apply (after the backup, one transaction): another unit's BU KPI is a GUEST at the file's weight through the one guest writer (the imported line
    adopted), a new BU KPI is made through the setup writer (carriers "holders", weight "own", the target picked, the unit's people its holders, the
    others guests), the final preview names each
  * every state rule is the writers': an Early Year or a closed setup greys the option with those words and pre-picks nothing; a line a writer
    refuses stays the person's own; the decisions are the super admin's alone and only an option a line offers can be decided
"""
import atexit
import glob
import html
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The KPI import: another unit's BU KPI, and a new one")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, BGX = "ZZKX Group", "ZZKX Other Group"
S1, S2, S10, CEM, ROOF, BEA = "ZZKX Starken 1", "ZZKX Starken 2", "ZZKX Starken 10", "ZZKXCEM", "ZZKX Roofing", "ZZKX Beacon"
CEM_D = "ZZKX Cement"   # the display name of the unit whose HRIS name is ZZKXCEM
PAT_N, GP_N = "ZZKX PAT", "ZZKX GP"
URL = "/admin/performance/import"
HEAD = "Employee ID,KPI,Focus,KPI Description,Unit of Measure,Weightage,Method,Rate 1,Rate 2,Rate 3,Rate 4,Rate 5,Matrix manager ID\n"
BK_DIR = os.path.join(os.path.dirname(os.path.abspath(a.DB_PATH)), "import-backups")
U = {}


def line(eid, kpi, w, desc="", rates=(80, 90, 100, 110, 120), focus=""):
    return '%s,%s,%s,"%s",%%,%s,More,%s\n' % (eid, kpi, focus, desc, w, ",".join(str(r) for r in rates))


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9KX-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        ids = "SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph
        for tb in ("pm_kpi_approvals", "pm_kpi_results", "pm_checkins", "pm_kpi_target_approvers"):
            db.execute("DELETE FROM %s WHERE kpi_target_id IN (%s)" % (tb, ids), ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE action IN ('pm_kpi_import','pm_bu_kpi') AND detail LIKE '%ZZKX%'")
    for g_ in (BG, BGX):
        db.execute("DELETE FROM pm_bu_kpis WHERE business_group=?", (g_,))
        db.execute("DELETE FROM pm_kpi_aliases WHERE business_group=?", (g_,))
        db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (g_,))
        db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (g_,))
        db.execute("DELETE FROM org_units WHERE business_group=?", (g_,))
    db.execute("DELETE FROM admin_roles WHERE name='ZZKX role'")
    db.commit()


def T(r):
    return html.unescape(r.get_data(as_text=True))


def lines_of(eid, name=None):
    q = ("SELECT t.* FROM pm_kpi_targets t JOIN users u ON u.id=t.subject_id WHERE t.cycle_id=? AND u.employee_id=?"
         + (" AND t.kpi_name=?" if name else ""))
    return [dict(r) for r in H.rows(a, q, (CID, "ZZ9KX-" + eid) + ((name,) if name else ()))]


def one_line(eid, name):
    r = lines_of(eid, name)
    return r[0] if r else None


def setups(co=None):
    q = "SELECT * FROM pm_bu_kpis WHERE cycle_id=? AND business_group=?" + (" AND company=?" if co else "") + " ORDER BY id"
    return [dict(r) for r in H.rows(a, q, (CID, BG) + ((co,) if co else ()))]


def setup_named(name, co):
    return next((x for x in setups(co) if x["kpi_name"] == name), None)


def cj(row):
    return json.loads(row["carriers_json"] or "{}") if row else {}


def snapshot():
    return ([tuple(r) for r in H.rows(a, "SELECT u.employee_id, t.kpi_name, t.weightage, t.rate1, t.bu_kpi_id FROM pm_kpi_targets t JOIN users u ON "
                                         "u.id=t.subject_id WHERE u.employee_id LIKE 'ZZ9KX-%' ORDER BY 1,2")],
            [tuple(r) for r in H.rows(a, "SELECT id, kpi_name, company, carriers_json, rate1 FROM pm_bu_kpis WHERE business_group=? ORDER BY id", (BG,))],
            [tuple(r) for r in H.rows(a, "SELECT id, kpi_name, company, bu_level, active FROM pm_kpi_library WHERE business_group=? ORDER BY id", (BG,))])


def stage(client, text, name="kpi.csv"):
    r = client.post(URL, data={"csrf_token": "tok", "preview": "1", "file": (io.BytesIO(text.encode()), name)}, content_type="multipart/form-data")
    m = re.search(r"check=([0-9a-f]{32})", r.headers.get("Location", ""))
    return r, (m.group(1) if m else "")


def step(client, tok, action, **form):
    return client.post(URL, data=dict({"csrf_token": "tok", "token": tok, "action": action}, **form), follow_redirects=True)


def page(client, tok, st=None):
    return T(client.get(URL + "?check=%s%s" % (tok, ("&step=" + st) if st else "")))


def fid(key):
    return "d_" + __import__("hashlib").sha1(key.encode()).hexdigest()[:10]


def tid_(gkey):
    return "t_" + __import__("hashlib").sha1(gkey.encode()).hexdigest()[:10]


def load(tok):
    with a.app.test_request_context():
        d_ = a.get_db()
        me_ = d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        got = a._kti_load(d_, me_, a.active_pm_period(d_), tok)
        return got[4], got[1]


def item(m, eid, kpi=PAT_N):
    return next((i for i in m["items"] if i["key"] == "ZZ9KX-%s|%s" % (eid, kpi)), None)


def reach(tok):
    """Past the quality step (the file has things worth a look: weights that don't total 100)."""
    return step(SUP, tok, "quality_ok", ack="1")


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    PREV = dict(db.execute("SELECT kind, year, half, min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())
    W0 = db.execute("SELECT opens_at, closes_at FROM cycle_windows WHERE cycle_id=? AND cell='pm_hod'", (CID,)).fetchone()

    def _put_back():
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("UPDATE cycles SET kind=?, year=?, half=?, min_job_grade=? WHERE id=?", (PREV["kind"], PREV["year"], PREV["half"], PREV["min_job_grade"], CID))
            d_.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='pm_hod'", (CID,))
            if W0:
                d_.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', ?, ?)", (CID, W0[0], W0[1]))
            _cleanup(d_)
    atexit.register(_put_back)
    db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL WHERE id=?", (CID,))
    db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', '2099-11-02 00:00', '2099-11-08 23:59')", (CID,))
    for g_, co_ in ((BG, S1), (BG, S2), (BG, S10), (BG, CEM), (BG, ROOF), (BGX, BEA)):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (g_, co_))
    db.execute("UPDATE org_units SET preferred_name=? WHERE business_group=? AND company=?", (CEM_D, BG, CEM))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A'), (?, 'A')", (BG, BGX))
    LIB = {}
    for nm, bu in ((PAT_N, 1), ("ZZKX Sales", 0)):
        LIB[nm] = db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, unit, method, rate1, rate2, rate3, "
                             "rate4, rate5, weightage_default, bu_level) VALUES (?, '*', '*', 0, '*', ?, 'Financial', '%', 'more', 80, 90, 100, 110, 120, 10, ?)", (BG, nm, bu)).lastrowid
    # GP is BU-level for Starken 2 only: for any other unit the library "didn't say so" (a new BU KPI there makes it BU-level for that unit only)
    LIB[GP_N] = db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, unit, method, rate1, rate2, rate3, "
                           "rate4, rate5, weightage_default, bu_level) VALUES (?, ?, '*', 0, '*', ?, 'Financial', '%', 'more', 80, 90, 100, 110, 120, 10, 1)", (BG, S2, GP_N)).lastrowid
    db.execute("INSERT INTO pm_kpi_aliases(business_group, alias_key, alias_name, into_key, into_name, kind) VALUES (?, 'zzkx pat old', 'ZZKX PAT old', 'zzkx pat', 'ZZKX PAT', 'dupe')", (BG,))
    U["M"] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, job_grade, confirmation_date) "
                        "VALUES ('zz9kx-m', 'ZZ KX Manager', 'x', 'user', 'ZZ9KX-M', ?, ?, 'Management', '21', '2020-01-01')", (BG, S1)).lastrowid
    PEOPLE = [(e, S1) for e in "ABCDEFGHIJK"] + [("P1", S1), ("P2", S2), ("PC", CEM), ("L", ROOF), ("M2", ROOF), ("N", ROOF), ("Q", S1), ("R", ROOF), ("T", ROOF), ("AL", S1), ("W", S1)]
    for e, co_ in PEOPLE:
        U[e] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, job_grade, confirmation_date, manager_id) "
                          "VALUES (?,?, 'x', 'user', ?,?,?, 'Sales', '14', '2020-01-01', ?)", ("zz9kx-" + e.lower(), "ZZ KX " + e, "ZZ9KX-" + e, BG, co_, U["M"])).lastrowid

    def mk_setup(co, name, rates, people):
        return db.execute("INSERT INTO pm_bu_kpis(cycle_id, business_group, company, kpi_name, category, unit, method, rate1, rate2, rate3, rate4, rate5, carriers, carriers_json, "
                          "weight_mode, library_id, updated_by) VALUES (?,?,?,?, 'Financial', '%', 'more', ?,?,?,?,?, 'holders', ?, 'own', ?, ?)",
                          (CID, BG, co, name) + tuple(rates) + (json.dumps({"people": [a.ja_eid("ZZ9KX-" + p) for p in people]}), LIB[PAT_N], SU["id"])).lastrowid
    SB = mk_setup(S1, PAT_N, (85, 90, 95, 100, 105), ["P1"])
    SA = mk_setup(S2, PAT_N + ": " + S2, (60, 70, 80, 90, 100), ["P2"])
    SC = mk_setup(CEM, PAT_N, (70, 80, 90, 100, 110), ["PC"])
    SD = mk_setup(CEM, "%s: %s & %s" % (PAT_N, CEM_D, S2), (50, 60, 70, 80, 90), ["PC"])
    SE = mk_setup(CEM, PAT_N + ": GCEO", (40, 50, 60, 70, 80), ["PC"])
    ROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZKX role', 'group')").lastrowid
    db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(ROLE, "pm.read"), (ROLE, "pm.kpi_add")])
    BGADM = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg, admin_role_id) VALUES ('zz9kx-adm', "
                       "'ZZ KX Admin', 'x', 'admin', 'ZZ9KX-ADM', ?, ?, ?)", (BG, BG, ROLE)).lastrowid
    db.commit()
SUP = H.client_as(a, SU["id"])
BGA = H.client_as(a, BGADM)
with a.app.test_request_context():
    dc = a.display_company

FILE = (HEAD
        + line("ZZ9KX-A", PAT_N, 20, "Follows %s's PAT" % S2, (75, 80, 85, 90, 95))                      # 1 other unit, by the description; its own unit has a PAT too
        + line("ZZ9KX-B", PAT_N + ": " + S2, 15, "", (60, 70, 80, 90, 100))                              # 2 other unit, by the name (the target is theirs already)
        + line("ZZ9KX-C", PAT_N, 25, "Combined PAT of %s and %s" % (CEM_D, S2))                          # 3 two units, the variant saved for both
        + line("ZZ9KX-D", PAT_N, 20, "%s plus %s" % (S2, ROOF))                                          # 4 two units: one saved, one new: none picked
        + line("ZZ9KX-E", PAT_N, 20, "Follows %s's PAT" % BEA)                                           # 5 another business group
        + line("ZZ9KX-F", PAT_N, 20, "Follows %s's PAT" % S10)                                           # 6 whole word: Starken 10 is not Starken 1; a NEW BU KPI there
        + line("ZZ9KX-G", PAT_N, 20, "Same as the gceo's")                                               # 7 the setup's own variant qualifier
        + line("ZZ9KX-H", PAT_N, 20, "Follows %s PAT" % CEM)                                             # 8 the unit's HRIS name
        + line("ZZ9KX-I", PAT_N, 20, "")                                                                 # 9 names none: the own unit's, today's rule
        + line("ZZ9KX-J", GP_N, 20, "Follows %s's GP" % ROOF)                                            # 10 a new BU KPI the library didn't mark for that unit
        + line("ZZ9KX-K", PAT_N, 20, "Compare %s and %s" % (S1, S2))                                    # 11 the person's own unit and another named
        + line("ZZ9KX-L", PAT_N, 30, "")                                                                 # 12 the library marks PAT BU-level for Roofing, which has none
        + line("ZZ9KX-M2", PAT_N, 25, "")
        + line("ZZ9KX-N", PAT_N, 25, "", (70, 80, 90, 100, 110))
        + line("ZZ9KX-AL", "ZZKX PAT old", 20, "Follows %s's PAT" % S2, (75, 80, 85, 90, 95))                 # 13 a library alias of PAT, the other unit named
        + line("ZZ9KX-I", "ZZKX Sales", 30, "Sales of the %s region" % S2))                                    # 14 names a unit, but Sales is not a BU KPI: nothing offered
try:
    # ---------------------------------------------------------------------------------------------------------------
    s.section("the one text test: whole words, any case")
    N_ = a._kti_names
    s.check("'Starken 1' is named by 'Starken 1' and 'starken 1's PAT' but never by 'Starken 10'",
            N_("Follows Starken 1", "Starken 1") and N_("starken 1's PAT", "Starken 1") and not N_("Follows Starken 10", "Starken 1")
            and not N_("Starken 100", "Starken 1") and not N_("xStarken 1", "Starken 1") and N_("(Starken 1)", "Starken 1"), "")
    s.check("white space folds, an empty term names nothing", N_("Starken   1  PAT", "Starken 1") and not N_("anything", "") and not N_("", "Starken 1"), "")
    s.check("the variant qualifier is what follows the first ': '", a._kti_qualifier("PAT: Starken 2") == "Starken 2" and a._kti_qualifier("PAT") == ""
            and a._kti_qualifier("PAT: A: B") == "A: B", "")

    # ---------------------------------------------------------------------------------------------------------------
    s.section("what each row matches (the file's thirteen rows)")
    r, TOK = stage(SUP, FILE)
    s.check("the file is kept, nothing written", len(TOK) == 32 and not lines_of("A"), r.status_code)
    reach(TOK)
    m, chk = load(TOK)
    sid = {"SB": SB, "SA": SA, "SC": SC, "SD": SD, "SE": SE}
    A_, B_, C_, D_, E_, F_, G_, H_, I_, J_, K_ = (item(m, e, GP_N if e == "J" else (PAT_N + ": " + S2 if e == "B" else PAT_N)) for e in "ABCDEFGHIJK")
    s.check("A (own unit has a PAT, the description names Starken 2): recommended there, not the own unit's: ONE option, 'bu', pre-picked, kind other",
            A_ and A_["kind"] == "other" and A_["rec"] == "bu" and len(A_["options"]) == 1 and A_["options"][0]["setup_id"] == SA
            and A_["status"] == "decide" and A_["how"] == "Description names %s" % S2 and A_["snippet"] == "Follows %s's PAT" % S2, A_ and (A_["kind"], A_["rec"], A_["how"]))
    s.check("B (the name 'PAT: Starken 2'): the same setup, 'Name names ...', its target the same as the setup's",
            B_ and B_["options"][0]["setup_id"] == SA and B_["how"] == "Name names %s" % S2 and B_["same"] is True and B_["rec"] == "bu" and B_["snippet"] == "", B_ and B_["how"])
    s.check("C (Cement and Starken 2 named): the variant saved for both, ONE option, pre-picked, in Cement's unit",
            C_ and len(C_["options"]) == 1 and C_["options"][0]["setup_id"] == SD and C_["rec"] == "bu" and C_["how"] == "Description names 2 units"
            and C_["options"][0]["co"] == CEM, C_ and [(o["setup_id"], o["value"]) for o in C_["options"]])
    s.check("D (Starken 2 and Roofing named): both offered, the saved one and a new BU KPI, NOTHING pre-picked",
            D_ and sorted(o["kind"] for o in D_["options"]) == ["new", "saved"] and D_["rec"] is None and D_["status"] == "decide"
            and {o["value"] for o in D_["options"]} == {"bu:%d" % SA, "new:%s" % ROOF}, D_ and [(o["kind"], o["value"]) for o in D_["options"]])
    s.check("E (Beacon, another business group): an info row, nothing to decide, said in words",
            E_ and E_["status"] == "info" and E_["options"] == [] and E_["why"] == "xgroup"
            and "Names %s, another business group" % BEA in E_["why_text"], E_ and E_["why_text"])
    s.check("F ('Starken 10'): the own unit 'Starken 1' is NOT named (whole words), so the only option is a new BU KPI for Starken 10, pre-picked",
            F_ and len(F_["options"]) == 1 and F_["options"][0]["kind"] == "new" and F_["options"][0]["co"] == S10 and F_["rec"] == "new"
            and F_["kind"] == "new", F_ and [(o["kind"], o["co"]) for o in F_["options"]])
    s.check("G (the description says 'gceo'): the qualifier of Cement's 'PAT: GCEO' names the unit AND picks that variant over the root PAT",
            G_ and len(G_["options"]) == 1 and G_["options"][0]["setup_id"] == SE and G_["options"][0]["co"] == CEM, G_ and [o["setup_id"] for o in G_["options"]])
    s.check("H (the unit's HRIS name 'ZZKXCEM'): Cement's root PAT, by its name", H_ and len(H_["options"]) == 1 and H_["options"][0]["setup_id"] == SC, H_ and [o["setup_id"] for o in H_["options"]])
    s.check("I (names no unit): today's rule, the own unit's PAT, 'Same name', kind own, pre-picked",
            I_ and I_["kind"] == "own" and I_["options"][0]["setup_id"] == SB and I_["rec"] == "bu" and I_["how"] == "Same name" and I_["options"][0]["own_unit"] is True, I_ and I_["how"])
    s.check("J (GP, BU-level for Starken 2 only; the description names Roofing): a new BU KPI for Roofing, not yet BU-level there ('made BU-level for this unit only')",
            J_ and len(J_["options"]) == 1 and J_["options"][0]["kind"] == "new" and J_["options"][0]["co"] == ROOF and J_["options"][0]["bu_here"] is False
            and J_["options"][0]["setup_name"] == GP_N and J_["rec"] == "new", J_ and [(o["kind"], o["bu_here"]) for o in J_["options"]])
    s.check("K (its own unit Starken 1 and Starken 2 named, no variant for both): both offered, none picked",
            K_ and len(K_["options"]) == 2 and K_["rec"] is None and {o["value"] for o in K_["options"]} == {"bu:%d" % SB, "bu:%d" % SA}
            and K_["how"] == "Description names 2 units", K_ and [(o["value"], o["own_unit"]) for o in K_["options"]])
    AL_ = item(m, "AL", "ZZKX PAT old")
    s.check("AL (a library alias of PAT, Starken 2 named): the alias's root counts, so Starken 2's variant is recommended", AL_ and AL_["options"][0]["setup_id"] == SA and AL_["rec"] == "bu"
            and AL_["how"] == "Description names %s" % S2, AL_ and AL_["how"])
    L_, M_, N_i = item(m, "L"), item(m, "M2"), item(m, "N")
    s.check("L, M2, N (Roofing: PAT is BU-level in the library, Roofing has none, nothing named): a new BU KPI for their own unit, pre-picked",
            all(x and x["kind"] == "new" and x["rec"] == "new" and x["options"][0]["co"] == ROOF and x["how"] == "BU-level in the library" for x in (L_, M_, N_i)), "")
    gk = L_["options"][0]["gkey"]
    d_new = next(o for o in D_["options"] if o["kind"] == "new")
    s.check("...they, and D's new option, are ONE group (Roofing, PAT): the file's targets most held first: 80..120 on 3 lines (L, M2, D), 70..110 on 1 (N); the most held is pre-picked",
            list(m["new_groups"]).count(gk) == 1 and len(m["new_groups"][gk]["targets"]) == 2 and [t["n"] for t in m["new_groups"][gk]["targets"]] == [3, 1]
            and m["new_groups"][gk]["default"] == m["new_groups"][gk]["targets"][0]["id"] and M_["options"][0]["gkey"] == gk and d_new["gkey"] == gk,
            {k: [(t["n"], t["scale"]) for t in v["targets"]] for k, v in m["new_groups"].items()})
    s.check("the library-only info list keeps today's meaning: nobody here (every BU-level row was offered a new BU KPI)", m["library_only"] == [], m["library_only"])
    s.check("a row that names a unit but whose KPI is not a BU KPI (Sales: in the library, not BU-level, no setup) is NOT offered anything: an ordinary line",
            item(m, "I", "ZZKX Sales") is None and any(r["kpi_name"] == "ZZKX Sales" and r["eid"] == "ZZ9KX-I" for r in chk["valid"]), "")

    # ---------------------------------------------------------------------------------------------------------------
    s.section("step 3 as the page draws it (board D1)")
    b = page(SUP, TOK, "changes")
    s.check("the heading counts every line that can be decided and says saved or new", ("Your decisions · %d lines match a BU KPI, saved or new" % sum(1 for i in m["items"] if i["status"] == "decide")) in b, re.findall(r"Your decisions · [^<]*", b)[:1])
    n_dec = sum(1 for i in m["items"] if i["status"] == "decide")
    s.check("Decide is a select on every decide line, the toggle is gone", b.count('data-kti-sel title=') == n_dec and 'type="radio"' not in b and "kti-seg" not in b, (b.count('data-kti-sel title='), n_dec))
    s.check("four fixed columns, the Weight column is gone: Person, Line in the file, The file's target, Decide",
            "<th scope=\"col\">Person</th><th scope=\"col\">Line in the file</th><th scope=\"col\">The file's target</th><th scope=\"col\">Decide</th>" in b
            and "<th scope=\"col\">Weight</th>" not in b and "kti-c-person" in b and "kti-c-line" in b and "kti-c-target" in b, "")
    s.check("the weight sits under the target ('Weight 20%'); the person's ID and unit under the name", "Weight 20%" in b and "ZZ9KX-A · %s" % S1 in b, "")
    s.check("a recommended option is first with '(recommended)'; where nothing is pre-picked: 'Pick one…' and the red outline (is-open)",
            "Follows" in b and "%s's BU KPI (recommended)" % S2 in b and "Pick one…" in b and 'kti-pick is-open' in b and "New BU KPI for %s (recommended)" % S10 in b, "")
    s.check("a line that names two units says so, nothing pre-picked", "Description names 2 units: pick one, nothing is pre-picked." in b, "")
    s.check("the description that named the unit is quoted under the line", "“Follows %s's PAT”" % S2 in b, "")
    s.check("a group head for another unit says 'another unit', its target and 'theirs, from the file'", "another unit · its target" in b and "weight: theirs, from the file" in b, "")
    s.check("a new BU KPI's head carries its target pick with 'Its target', red until picked where tied, the most held first", "a new BU KPI for %s" % ROOF in b and "Its target" in b and "kti-tsel" in b, "")
    s.check("the info row says why in words, no select", "Names %s, another business group: it goes in as their own line." % BEA in b, "")
    s.check("the final step is not reachable before the decisions", "after you apply this file" not in page(SUP, TOK, "apply"), "")

    # ---------------------------------------------------------------------------------------------------------------
    s.section("deciding: only an option the line offers, only the file's own targets, the super admin alone")
    before = snapshot()
    items_all = {i["key"]: i for i in m["items"] if i["status"] == "decide"}
    _r, TA = stage(BGA, FILE, "bga.csv")
    s.check("a BG admin cannot import KPI targets at all (403), nothing is kept", _r.status_code == 403 and not TA, _r.status_code)
    r = SUP.post(URL, data={"csrf_token": "tok", "token": TOK, "action": "decide", fid(A_["key"]): "bu:999999", fid(B_["key"]): "new"}, follow_redirects=True)
    dec0 = a._imp_meta("kpi_targets", TOK).get("decisions") or {}
    s.check("a value the line does not offer ('bu:999999', 'new' on a line with no new option) is not stored", A_["key"] not in dec0 and B_["key"] not in dec0, dec0)
    r = SUP.post(URL, data={"csrf_token": "tok", "token": TOK, "action": "decide", tid_(gk): "deadbeef"}, follow_redirects=True)
    s.check("a target that is not one of the file's own is not stored", ("target|" + gk) not in (a._imp_meta("kpi_targets", TOK).get("decisions") or {}), "")
    # the writers' own state: a BU admin session cannot decide either (the token is the super admin's)
    r = BGA.post(URL, data={"csrf_token": "tok", "token": TOK, "action": "decide", fid(I_["key"]): "bu"}, follow_redirects=True)
    s.check("someone else cannot decide on the super admin's kept file", I_["key"] not in (a._imp_meta("kpi_targets", TOK).get("decisions") or {}), "")
    # decide everything but D and K (nothing pre-picked) and the target of the Roofing group
    rec_post = {fid(i["key"]): i["rec"] for i in m["items"] if i["status"] == "decide" and i["rec"]}
    r = step(SUP, TOK, "to_apply", **rec_post)
    s.check("the recommended ones decided, D and K not: going on is refused, saying how many still to decide", "2 still to decide" in T(r), re.findall(r"\d+ still to decide", T(r)))
    dec1 = a._imp_meta("kpi_targets", TOK)["decisions"]
    s.check("...exactly the posted recommendations are stored", all(dec1.get(k_) == v_ for k_, v_ in ((i["key"], i["rec"]) for i in m["items"] if i["rec"] and i["status"] == "decide")), dec1)
    r = step(SUP, TOK, "to_apply", **{fid(D_["key"]): "bu:%d" % SA, fid(K_["key"]): "bu:%d" % SB})
    s.check("D to Starken 2's saved one, K to its own unit's: the final preview opens (the Roofing target had a clear most-held)", "after you apply this file" in T(r), re.findall(r"\d+ still to decide", T(r)))
    b = T(r)
    s.check("the final preview names the new BU KPIs this file sets up (Starken 10's, Roofing's PAT, Roofing's GP)", "3 new BU KPIs this file sets up" in b, re.findall(r"\d+ new BU KPIs? this file sets up", b))
    s.check("...Roofing's: its target the most held, its three people carry it (L, M2, N); a guest is named with their unit (F, of Starken 1, for Starken 10's)",
            ("for %s · target 1–5: 80 · 90 · 100 · 110 · 120" % ROOF) in b and "ZZ KX L" in b and "ZZ KX N" in b and ("(ZZ9KX-F, %s)" % S1) in b, re.findall(r"for %s · target[^<]*" % ROOF, b)[:1])
    s.check("...each decision recapped with its words ('<Unit>'s BU KPI', 'A new BU KPI for <Unit>', 'The unit's BU KPI')",
            "%s's BU KPI</b>: ZZ KX A" % S2 in b and "A new BU KPI for %s</b>: ZZ KX F" % S10 in b and "The unit's BU KPI</b>: ZZ KX I" in b, "")
    s.check("...and tiles: the unit's own, another unit's as guests, a new BU KPI", "join another unit's BU KPI as guests" in b and "join a new BU KPI" in b, "")
    s.check("nothing was written yet", snapshot() == before, "")

    # ---------------------------------------------------------------------------------------------------------------
    s.section("apply: one transaction after the backup")
    BK0 = set(glob.glob(os.path.join(BK_DIR, "*.db")))
    r = step(SUP, TOK, "apply")
    out = T(r)
    s.check("a backup of the database was taken first", any(f.endswith("-import-kpi-targets.db") for f in set(glob.glob(os.path.join(BK_DIR, "*.db"))) - BK0), "")
    s.check("the done page says what it did: guests and new BU KPIs are counted", "Applied" in out and "as guests" in out and "new BU KPIs set up" in out, re.findall(r"Applied[^<]*<[^>]*>[^<]*<span>([^<]*)", out)[:1])
    sa, sd, sc, se, sbr = (setup_named(PAT_N + ": " + S2, S2), setup_named("%s: %s & %s" % (PAT_N, CEM_D, S2), CEM), setup_named(PAT_N, CEM), setup_named(PAT_N + ": GCEO", CEM), setup_named(PAT_N, S1))
    la = one_line("A", PAT_N + ": " + S2)
    s.check("A is a GUEST of Starken 2's PAT at the file's 20%: ONE PAT line, linked, on the setup's name and target (60..100), their OWN unit",
            la and la["bu_kpi_id"] == SA and la["weightage"] == 20 and (la["rate1"], la["rate5"]) == (60, 100) and la["company"] == S1 and la["business_group"] == BG
            and len(lines_of("A")) == 1 and cj(sa).get("guests", {}).get("ZZ9KX-A") == 20.0, la)
    s.check("...what the file gave A is kept to go back to (the name 'ZZKX PAT' and the 75..95 target)",
            la and json.loads(la["bu_prev_json"] or "{}").get("kpi_name") == PAT_N and json.loads(la["bu_prev_json"]).get("rate1") == 75, la and la["bu_prev_json"])
    lal = one_line("AL", PAT_N + ": " + S2)
    s.check("AL (the alias) is a guest of Starken 2's PAT; the name it came in under is kept to go back to",
            lal and lal["bu_kpi_id"] == SA and json.loads(lal["bu_prev_json"] or "{}").get("kpi_name") == "ZZKX PAT old" and not one_line("AL", "ZZKX PAT old"), lal)
    lb = one_line("B", PAT_N + ": " + S2)
    s.check("B (the same target already) is a guest at 15%", lb and lb["bu_kpi_id"] == SA and lb["weightage"] == 15 and cj(sa)["guests"].get("ZZ9KX-B") == 15.0, lb)
    lc = one_line("C", "%s: %s & %s" % (PAT_N, CEM_D, S2))
    s.check("C is a guest of Cement's combined variant at 25%", lc and lc["bu_kpi_id"] == SD and lc["weightage"] == 25 and cj(sd)["guests"].get("ZZ9KX-C") == 25.0, lc)
    s.check("G (the 'GCEO' qualifier) is a guest of 'PAT: GCEO', H (the HRIS name) of Cement's PAT",
            one_line("G", PAT_N + ": GCEO") and one_line("G", PAT_N + ": GCEO")["bu_kpi_id"] == SE and cj(se)["guests"].get("ZZ9KX-G") == 20.0
            and one_line("H", PAT_N)["bu_kpi_id"] == SC and cj(sc)["guests"].get("ZZ9KX-H") == 20.0, "")
    li = one_line("I", PAT_N)
    s.check("I (names none) joined the own unit's PAT as a unit carrier (today's join): carriers 'people', never a guest",
            li and li["bu_kpi_id"] == SB and "ZZ9KX-I" in cj(sbr)["people"] and "ZZ9KX-I" not in (cj(sbr).get("guests") or {}), li)
    lk = one_line("K", PAT_N)
    s.check("K, decided its own unit's of the two offered, joined the own unit's PAT as a carrier too", lk and lk["bu_kpi_id"] == SB and "ZZ9KX-K" in cj(sbr)["people"], lk)
    ld = one_line("D", PAT_N + ": " + S2)
    s.check("D, decided Starken 2's saved one, is its guest at 20%", ld and ld["bu_kpi_id"] == SA and cj(sa)["guests"].get("ZZ9KX-D") == 20.0, ld)
    s.check("E (another group named) is an ordinary line of their own with the file's target, unlinked and not marked",
            one_line("E", PAT_N) and one_line("E", PAT_N)["bu_kpi_id"] is None and one_line("E", PAT_N)["rate1"] == 80 and not one_line("E", PAT_N)["bu_keep_own"], "")
    s10 = setup_named(PAT_N, S10)
    lf = one_line("F", PAT_N)
    s.check("F: a NEW BU KPI for Starken 10 was made through the setup writer: the library KPI's name, carriers 'holders', weight 'own', the file's target, Starken 10's setup",
            s10 and s10["carriers"] == "holders" and s10["weight_mode"] == "own" and (s10["rate1"], s10["rate5"]) == (80, 120) and s10["library_id"] == LIB[PAT_N]
            and cj(s10).get("people") == [] and cj(s10).get("guests") == {"ZZ9KX-F": 20.0}, s10 and (s10["carriers"], cj(s10)))
    s.check("...F's line is its guest line: linked, 20%, still on their own unit, ONE PAT line", lf and lf["bu_kpi_id"] == s10["id"] and lf["weightage"] == 20 and lf["company"] == S1 and len(lines_of("F")) == 1, lf)
    sr = setup_named(PAT_N, ROOF)
    s.check("Roofing's PAT was made once, its unit's people L, M2 and N the holders (D decided Starken 2's, so no guest), the target the most held (80..120)",
            sr and sorted(cj(sr)["people"]) == ["ZZ9KX-L", "ZZ9KX-M2", "ZZ9KX-N"] and not cj(sr).get("guests")
            and (sr["rate1"], sr["rate5"]) == (80, 120) and len([x for x in setups(ROOF) if x["kpi_name"] == PAT_N]) == 1, sr and cj(sr))
    ln_ = one_line("N", PAT_N)
    s.check("N (whose file target was 70..110) takes the target picked (80..120) at THEIR weight 25; L at 30",
            ln_ and ln_["bu_kpi_id"] == sr["id"] and (ln_["rate1"], ln_["rate5"]) == (80, 120) and ln_["weightage"] == 25 and one_line("L", PAT_N)["weightage"] == 30, ln_)
    s.check("...and N's own figures are kept to go back to", ln_ and json.loads(ln_["bu_prev_json"] or "{}").get("rate1") == 70, ln_ and ln_["bu_prev_json"])
    ld2 = one_line("D", PAT_N)
    s.check("D has no second PAT line (the Roofing option was not the one decided)", ld2 is None, ld2)
    lj = one_line("J", GP_N)
    sg = setup_named(GP_N, ROOF)
    s.check("J: a new BU KPI 'ZZKX GP' for Roofing; the library was not BU-level for Roofing, so it became BU-level for Roofing ONLY (a copy marked 'made'), J its guest at 20%",
            sg and cj(sg).get("made") == "copy" and cj(sg).get("guests") == {"ZZ9KX-J": 20.0} and lj and lj["bu_kpi_id"] == sg["id"]
            and H.one(a, "SELECT COUNT(*) FROM pm_kpi_library WHERE business_group=? AND kpi_name=? AND company=? AND bu_level=1 AND active=1", (BG, GP_N, ROOF)) == 1
            and H.one(a, "SELECT bu_level FROM pm_kpi_library WHERE id=?", (LIB[GP_N],)) == 1, sg and cj(sg))
    s.check("the trail names the decisions in words, the new BU KPIs and the guests",
            all(w in H.rows(a, "SELECT detail FROM activity_log WHERE action='pm_kpi_import' ORDER BY id DESC LIMIT 1")[0][0] for w in (
                "ZZ9KX-A ZZKX PAT -> %s's BU KPI (another unit, as a guest)" % S2, "ZZ9KX-F ZZKX PAT -> a new BU KPI for %s" % S10, "ZZ9KX-I ZZKX PAT -> the unit's BU KPI",
                "joined another unit's BU KPI as guests", "new BU KPIs set up")), "")
    s.check("the BU KPI card's trail has the guest line in its own words ('1 added from another unit (ZZ9KX-A, ZZKX Starken 1 at 20%)')",
            H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%1 added from another unit (ZZ9KX-A, ZZKX Starken 1 at 20%)%their imported line joined it%'") == 1, "")

    # ---------------------------------------------------------------------------------------------------------------
    s.section("what the guests are afterwards: the writers' own, taking one off gives their own line back")
    ra = SUP.post("/admin/users/%d/kpi" % U["A"], data={"csrf_token": "tok", "action": "take_off_bu", "kpi_target_id": str(la["id"])}, follow_redirects=True)
    back = one_line("A", PAT_N)
    s.check("taking A off Starken 2's PAT gives back the line as the file had it ('ZZKX PAT', 75..95, 20%), and A leaves 'guests'",
            back and back["bu_kpi_id"] is None and back["rate1"] == 75 and back["weightage"] == 20 and "ZZ9KX-A" not in (cj(setup_named(PAT_N + ": " + S2, S2)).get("guests") or {}),
            (back, "taken off" in T(ra)))
    s.check("...the holders panel of Starken 2's PAT lists B (a guest) with the outlined chip, A gone",
            "From %s" % S1 in T(SUP.get("/admin/list/bu-kpi-holders?fragment=1&bg=%s&co=%s&kpi=%s" % (BG.replace(" ", "+"), S2.replace(" ", "+"), (PAT_N + ": " + S2).replace(" ", "+")))), "")

    # ---------------------------------------------------------------------------------------------------------------
    s.section("a tie waits for the pick; a typed target is never read; the group's target is the posted pick")
    ROOF_TIE = (HEAD + line("ZZ9KX-Q", PAT_N, 20, "Follows %s's PAT" % S10, (80, 90, 100, 110, 120)) + line("ZZ9KX-R", PAT_N, 20, "", (70, 80, 90, 100, 110))
                + line("ZZ9KX-T", PAT_N, 20, "", (60, 70, 80, 90, 100)))
    # tear the earlier import's setups down so the units have none again
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE pm_kpi_targets SET bu_kpi_id=NULL WHERE bu_kpi_id IN (SELECT id FROM pm_bu_kpis WHERE business_group=? AND id NOT IN (?,?,?,?,?))", (BG, SB, SA, SC, SD, SE))
        d_.execute("DELETE FROM pm_bu_kpis WHERE business_group=? AND id NOT IN (?,?,?,?,?)", (BG, SB, SA, SC, SD, SE))
        d_.execute("DELETE FROM pm_kpi_library WHERE business_group=? AND company=? AND kpi_name=?", (BG, ROOF, GP_N))
        for sid_, who_ in ((SB, "P1"), (SA, "P2"), (SC, "PC"), (SD, "PC"), (SE, "PC")):
            d_.execute("UPDATE pm_bu_kpis SET carriers_json=? WHERE id=?", (json.dumps({"people": ["ZZ9KX-" + who_]}), sid_))
        d_.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (SELECT id FROM users WHERE employee_id LIKE 'ZZ9KX-%')")
        d_.commit()
    _r, TT = stage(SUP, ROOF_TIE, "tie.csv")
    reach(TT)
    mt, _c = load(TT)
    gtie = next(iter(mt["new_groups"]), None)
    tg = mt["new_groups"][gtie]
    s.check("Q (names Starken 10), R and T (Roofing): two groups; Roofing's targets 70..110 and 60..100, one line each: a TIE, nothing pre-picked",
            len(mt["new_groups"]) == 2 and any(len(g["targets"]) == 2 and g["default"] is None for g in mt["new_groups"].values()), {k: g["default"] for k, g in mt["new_groups"].items()})
    gr = next(g for g in mt["new_groups"].values() if g["co"] == ROOF)
    gs = next(g for g in mt["new_groups"].values() if g["co"] == S10)
    s.check("...Starken 10's single target IS pre-picked", gs["default"] == gs["targets"][0]["id"] and len(gs["targets"]) == 1, "")
    rec_t = {fid(i["key"]): i["rec"] for i in mt["items"] if i["status"] == "decide" and i["rec"]}
    r = step(SUP, TT, "to_apply", **rec_t)
    s.check("every line decided 'new', but Roofing's target is not picked: still blocked, the pick counted as one still to decide", "1 still to decide" in T(r), re.findall(r"\d+ still to decide", T(r)))
    bt = page(SUP, TT, "changes")
    s.check("...the page shows the target select red (is-open) with 'Pick one…'", 'class="kti-tsel is-open"' in bt, "")
    r = step(SUP, TT, "to_apply", **{tid_(gr["gkey"]): "feedface"})
    s.check("a target that is not one of the file's own (a typed or forged id) is refused: still 1 to decide", "1 still to decide" in T(r), "")
    t60 = next(t for t in gr["targets"] if t["row"]["rate1"] == 60)
    r = step(SUP, TT, "to_apply", **{tid_(gr["gkey"]): t60["id"]})
    s.check("the picked target (60..100) opens the final preview", "after you apply this file" in T(r), re.findall(r"\d+ still to decide", T(r)))
    res_ = step(SUP, TT, "apply")
    sr2 = setup_named(PAT_N, ROOF)
    s.check("Apply makes Roofing's PAT at the PICKED target (60..100), R and T the holders at their own weights, Q's Starken 10 PAT as a guest",
            sr2 and (sr2["rate1"], sr2["rate5"]) == (60, 100) and sorted(cj(sr2)["people"]) == ["ZZ9KX-R", "ZZ9KX-T"]
            and one_line("R", PAT_N)["rate1"] == 60 and one_line("T", PAT_N)["weightage"] == 20
            and cj(setup_named(PAT_N, S10)).get("guests") == {"ZZ9KX-Q": 20.0}, sr2 and cj(sr2))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the writers' own state rules: an Early Year and a closed setup grey the option, nothing is pre-picked")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM pm_bu_kpis WHERE business_group=? AND id NOT IN (?,?,?,?,?)", (BG, SB, SA, SC, SD, SE))
        d_.execute("UPDATE pm_kpi_targets SET bu_kpi_id=NULL WHERE bu_kpi_id IS NOT NULL AND subject_id IN (SELECT id FROM users WHERE employee_id LIKE 'ZZ9KX-%')")
        d_.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (SELECT id FROM users WHERE employee_id LIKE 'ZZ9KX-%')")
        d_.commit()
    TWO = HEAD + line("ZZ9KX-A", PAT_N, 20, "Follows %s's PAT" % S2) + line("ZZ9KX-F", PAT_N, 20, "Follows %s's PAT" % S10)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE cycles SET kind='early_year', half=0 WHERE id=?", (CID,))
        d_.commit()
    _r, TE = stage(SUP, TWO, "early.csv")
    mE, _c = load(TE)
    aE, fE = item(mE, "A"), item(mE, "F")
    s.check("in an Early Year both options are refused with the writers' words, the lines are info (nothing to decide), nothing pre-picked",
            aE["status"] == "info" and aE["rec"] is None and aE["options"][0]["disabled"] and "Early Year" in aE["why_text"]
            and fE["status"] == "info" and fE["rec"] is None and fE["options"][0]["disabled"] and "Early Year" in fE["why_text"], (aE["why_text"], fE["why_text"]))
    reach(TE)
    bE = page(SUP, TE, "changes")
    s.check("...the page says why under a disabled select, and 'Continue to the final preview' needs no decision", "Early Year" in bE and "kti-pick" in bE and 'data-kti-sel title=' not in bE, "")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE cycles SET kind='year_end', half=2 WHERE id=?", (CID,))
        d_.execute("UPDATE cycle_windows SET opens_at='2020-01-01 00:00' WHERE cycle_id=? AND cell='pm_hod'", (CID,))
        d_.commit()
    _r, TCL = stage(SUP, TWO, "closed.csv")
    mC, _c = load(TCL)
    aC, fC = item(mC, "A"), item(mC, "F")
    s.check("once the Department Review has started: refused with the writers' words, info, nothing pre-picked",
            aC["status"] == "info" and aC["rec"] is None and "Department Review started" in aC["why_text"] and fC["status"] == "info" and fC["rec"] is None
            and not mC["open"], (aC["why_text"], fC["why_text"]))
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', '2099-11-02 00:00', '2099-11-08 23:59')", (CID,))
        d_.commit()

    # ---------------------------------------------------------------------------------------------------------------
    s.section("a guest the writer refuses: said in the writer's words, the line stays the person's own")
    # P2 already holds a line of the same root (their own PAT) -> the one check refuses, in the preview AND at Apply
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, rate2, rate3, rate4, rate5, business_group, company) "
                   "VALUES (?,?,?,10,'more','%','Own',1,2,3,4,5,?,?)", (CID, U["A"], PAT_N + ": Old", BG, S1))
        d_.commit()
    _r, TR = stage(SUP, HEAD + line("ZZ9KX-A", PAT_N, 20, "Follows %s's PAT" % S2), "clash.csv")
    mR, _c = load(TR)
    aR = item(mR, "A")
    s.check("A already carries 'ZZKX PAT: Old' (the same root): the option is refused in the writer's words, the line is info, nothing pre-picked",
            aR["status"] == "info" and aR["options"][0]["disabled"] and aR["options"][0]["why"] == "xclash" and "already carry a KPI named ZZKX PAT: take that off first." in aR["why_text"]
            and aR["rec"] is None, (aR["status"], aR["why_text"]))
    with a.app.app_context():   # the writer called straight: refuses, writes NOTHING
        d_ = a.get_db()
        me_ = d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        act_ = a.active_pm_period(d_)
        t_a = d_.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, rate2, rate3, rate4, rate5, business_group, company) "
                         "VALUES (?,?,?,20,'more','%','Own',1,2,3,4,5,?,?)", (CID, U["A"], PAT_N, BG, S1)).lastrowid
        c0 = (d_.execute("SELECT carriers_json, updated_at FROM pm_bu_kpis WHERE id=?", (SA,)).fetchone()[:], d_.execute("SELECT COUNT(*) FROM activity_log").fetchone()[0],
              d_.execute("SELECT bu_kpi_id FROM pm_kpi_targets WHERE id=?", (t_a,)).fetchone()[0])
        why_ = a._kti_bu_guest(d_, me_, act_, {"subject_id": U["A"], "unit_co": S1}, t_a, SA)
        c1 = (d_.execute("SELECT carriers_json, updated_at FROM pm_bu_kpis WHERE id=?", (SA,)).fetchone()[:], d_.execute("SELECT COUNT(*) FROM activity_log").fetchone()[0],
              d_.execute("SELECT bu_kpi_id FROM pm_kpi_targets WHERE id=?", (t_a,)).fetchone()[0])
        d_.rollback()
    s.check("`_kti_bu_guest` calls the one writer, which refuses and writes NOTHING (the setup, the trail, the line are as they were)", why_ and "already carry" in why_ and c0 == c1 and c1[2] is None, (why_, c0, c1))
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (SELECT id FROM users WHERE employee_id LIKE 'ZZ9KX-%')")
        d_.commit()

    # ---------------------------------------------------------------------------------------------------------------
    s.section("a mixed line: one option open, one refused (weight over 100%): only the open one can be decided")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, rate2, rate3, rate4, rate5, business_group, company) "
                   "VALUES (?,?, 'ZZKX Sales', 80, 'more','%','Own',1,2,3,4,5,?,?)", (CID, U["W"], BG, S1))
        d_.commit()
    _r, TW0 = stage(SUP, HEAD + line("ZZ9KX-W", PAT_N, 20, "Compare %s and %s" % (S1, S2)), "exact.csv")
    iw0 = item(load(TW0)[0], "W")
    s.check("W holds 80% elsewhere and the file gives the PAT line 20%: that is exactly 100%, so BOTH options are open (the imported line's own weight is not counted twice)",
            iw0["status"] == "decide" and not any(o["disabled"] for o in iw0["options"]) and len(iw0["options"]) == 2, [(o["setup_id"], o["why"]) for o in iw0["options"]])
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE pm_kpi_targets SET weightage=90 WHERE subject_id=? AND kpi_name='ZZKX Sales'", (U["W"],))
        d_.commit()
    _r, TW = stage(SUP, HEAD + line("ZZ9KX-W", PAT_N, 20, "Compare %s and %s" % (S1, S2)), "mixed.csv")
    mW, _c = load(TW)
    iw = item(mW, "W")
    off_ = [o for o in iw["options"] if o["disabled"]]
    s.check("W holds 90% elsewhere: the own unit's PAT is open, Starken 2's is refused in the writer's words (at most 10% more), the line is still a decision, nothing pre-picked",
            iw["status"] == "decide" and iw["rec"] is None and len(off_) == 1 and off_[0]["setup_id"] == SA and "at most 10% more" in off_[0]["why_text"]
            and [o["setup_id"] for o in iw["options"] if not o["disabled"]] == [SB], (iw["status"], [(o["setup_id"], o["why"]) for o in iw["options"]]))
    reach(TW)
    step(SUP, TW, "decide", **{fid(iw["key"]): "bu:%d" % SA})
    s.check("a refused option cannot be decided: 'bu:<Starken 2's>' is not stored", iw["key"] not in (a._imp_meta("kpi_targets", TW).get("decisions") or {}), "")
    step(SUP, TW, "decide", **{fid(iw["key"]): "bu:%d" % SB})
    s.check("...the open one can", (a._imp_meta("kpi_targets", TW).get("decisions") or {}).get(iw["key"]) == "bu:%d" % SB, "")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM pm_kpi_targets WHERE subject_id=?", (U["W"],))
        d_.commit()

    s.section("OneHR moved after the preview: the option state is part of what the preview showed")
    _r, TF = stage(SUP, HEAD + line("ZZ9KX-A", PAT_N, 20, "Follows %s's PAT" % S2), "moved.csv")
    reach(TF)
    mF, _c = load(TF)
    step(SUP, TF, "to_apply", **{fid(item(mF, "A")["key"]): "bu"})
    b = page(SUP, TF, "apply")
    s.check("set up: A decided Starken 2's, the final preview is open", "after you apply this file" in b, "")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, rate2, rate3, rate4, rate5, business_group, company) "
                   "VALUES (?,?, 'ZZKX PAT: Old', 0, 'more','%','Own',1,2,3,4,5,?,?)", (CID, U["A"], BG, S1))   # weight 0: the quality step's totals do not move
        d_.commit()
    snap_f = snapshot()
    r = step(SUP, TF, "apply")
    s.check("a line the writer would now refuse sends it back to look again, nothing applied", "changed since you looked at the changes" in T(r) and snapshot() == snap_f,
            (re.findall(r'role="alert"[^>]*>\s*([^<]*)', T(r))[:3], snapshot() == snap_f))
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM pm_kpi_targets WHERE subject_id=?", (U["A"],))
        d_.commit()

    s.section("the options themselves are part of what the preview showed (a second option closing leaves the line a decision, but not the same one)")
    _r, TG = stage(SUP, HEAD + line("ZZ9KX-W", PAT_N, 20, "Compare %s and %s" % (S1, S2)), "options.csv")
    reach(TG)
    mG, _c = load(TG)
    step(SUP, TG, "to_apply", **{fid(item(mG, "W")["key"]): "bu:%d" % SB})
    s.check("set up: W decided the own unit's of the two, the final preview is open", "after you apply this file" in page(SUP, TG, "apply"), "")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, rate2, rate3, rate4, rate5, business_group, company) "
                   "VALUES (?,?, 'ZZKX PAT: Old', 0, 'more','%','Own',1,2,3,4,5,?,?)", (CID, U["W"], BG, S1))
        d_.commit()
    mG2, _c = load(TG)
    iw2 = item(mG2, "W")
    s.check("Starken 2's option closed (the same root held now), the own unit's is open: still a decision, the choice stands",
            iw2["status"] == "decide" and [o["disabled"] for o in iw2["options"]] == [False, True], [(o["value"], o["disabled"]) for o in iw2["options"]])
    snap_g = snapshot()
    r = step(SUP, TG, "apply")
    s.check("...yet Apply sends it back to look again: nothing applied", "changed since you looked at the changes" in T(r) and snapshot() == snap_g,
            re.findall(r'role="alert"[^>]*>\s*([^<]*)', T(r))[:2])
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM pm_kpi_targets WHERE subject_id=?", (U["W"],))
        d_.commit()

    s.section("a caller with nobody signed in keeps today's own-unit rule only (no cross-unit, no new)")
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        per_ = a.active_pm_period(d_)
        me_ = d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        chk_ = a._kti_check(d_, me_, per_, a._read_records("k.csv", (HEAD + line("ZZ9KX-A", PAT_N, 20, "Follows %s's PAT" % S2) + line("ZZ9KX-L", PAT_N, 30, "")).encode()))
        cls_ = a._kti_classify(d_, per_, chk_)
        m0 = a._kti_bu_matches(d_, per_, chk_, cls_)
    a0 = item(m0, "A")
    s.check("without `me`: A matches its own unit's PAT by name (today's rule), Roofing's L has no new BU KPI offered (it is the old info list)",
            a0 and a0["kind"] == "own" and a0["options"][0]["setup_id"] == SB and item(m0, "L") is None and len(m0["library_only"]) == 1, (a0 and a0["kind"], m0["library_only"]))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("lint: one matcher, one guest writer, no model, no typed target")
    src = H.source(a)
    s.check("the import's guest join is `_bu_kpi_add_guest` (adopt) and a new BU KPI is made by `_bu_kpi_save_one`; the matcher reads no model",
            "_bu_kpi_add_guest(db, me, act, s, {\"id\": it[\"subject_id\"]}, w[0], adopt=tid, touched=touched)" in src and "_bu_kpi_save_one(db, me, act, g[\"bg\"], g[\"co\"], lib, st, [], touched=touched)" in src
            and "ai_draft" not in src[src.index("def _kti_row_options"):src.index("def _kti_bu_matches")], "")
    s.check("the target is read only as one of the file's own ids", 'v in {t["id"] for t in g["targets"]}' in src, "")
finally:
    pass

sys.exit(s.done())
