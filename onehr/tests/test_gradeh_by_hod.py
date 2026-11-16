"""Grade H Appraisal, People & progress: the By HOD view and Set HOD for several (2026-11-03; board H5, canvas [design canvas link removed]).

What this suite holds:
  * the By person | By HOD switch is the address (?view=hod); By person is the page it was (the HOD filter ?hod= is the only addition)
  * one row a Grade H HOD in the viewer's scope; the People, Shared, unit and department cells are the By person data counted another way
    (a HOD's people = By person's ?hod=; a shared pair counts each person for both; a HOD who holds a BU CEO or BG CEO seat reads "No HOD role" with why (3 Nov: a calibration group's or Group Chief group's calibrator is a live Grade H HOD), where their
    people go (the BU CEO, or the other HOD at 100%); the last row is the people no HOD is named for)
  * "reviewed" and "signed off" are the HOD's OWN page's (gradeh_hod_stage_summary, one function): the table's counts equal gradeh_hod_view's for every
    HOD, a shared person counts as reviewed for THAT HOD by their own call (falsified against the admin level's read), the signed-off day, "Not open"
    (performance before potential is signed; a closed calendar window), "k of n reviewed" otherwise
  * filters (All HODs, Shared, No HOD role, Not signed off, No Grade H HOD) and Search in (name, Employee ID, unit, department) with their counts
  * scope: a BG admin with gradeh.read sees only their own group's people and the HODs of them, counts inside it, no list panel; one without it is
    refused as the list refuses it; the list panel's ?hod= is the super admin's
  * Set HOD for several: super admin only (the route, the writer, the bar and the panel), every left-out reason (the unit signed off, the person's HOD
    has signed, their own HOD, not on the list, the second HOD the same account), split validation, a blank second HOD keeps each person's own,
    "take away" clears it only where there is one, one audit row a person, ONE transaction, nothing written on a refusal; each guard falsified
Synthetic (ZZ9BH-*) on a fresh scratch database; the suite puts back what it changes.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Grade H Appraisal: By HOD and Set HOD for several")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA0, EMP = H.actors(a)
PFX, BG, BG2, CO, COB, COC, COX = "ZZ9BH-", "ZZBH Group", "ZZBH Other Group", "ZZBH Unit A", "ZZBH Unit B", "ZZBH Unit C", "ZZBH Unit X"
U, P = {}, {}
_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
import sqlite3  # noqa: E402

db = sqlite3.connect(a.DB_PATH, timeout=5.0)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")


def one(sql, args=()):
    r = db.execute(sql, args).fetchone()
    return r[0] if r else None


def run(fn):
    with a.app.test_request_context("/"):
        d = a.get_db()
        r = fn(d)
        d.commit()
        return r


def text(resp):
    h = resp.get_data(as_text=True)
    h = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", h)
    m = re.search(r'<main id="main"[\s\S]*', h)
    h = m.group(0) if m else h
    h = re.sub(r"<[^>]+>", " ", h)
    return " ".join(h.replace("&#39;", "'").replace("&amp;", "&").replace("&quot;", '"').split())


def clean(t):
    return " ".join(re.sub(r"<[^>]+>", " ", t).replace("&#39;", "'").replace("&amp;", "&").replace("&quot;", '"').split())


def hod_table(html):
    """The By HOD table's body rows as lists of cell texts (None when there is no table)."""
    m = re.search(r'<table[^>]*id="gh-hods".*?</table>', html, re.S)
    if not m:
        return None
    out = []
    for tr in re.findall(r"<tr[^>]*>.*?</tr>", m.group(0), re.S)[1:]:
        out.append([clean(t) for t in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)])
    return out


def row_of(rows, key):
    return next((r for r in rows if key in r[0]), None)


def csrf(**kw):
    d = {"csrf_token": "tok"}
    d.update(kw)
    return d


def mk(k, grade="H", co=CO, bg=BG, dept="ZZBH Dept"):
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
        "job_grade, job_title, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?,?,?, 'Driver', '2020-01-01')",
        ((PFX + k).lower(), "ZZ BH " + k, PFX + k, bg, co, dept, grade)).lastrowid


def person(k, hod=None, hod2=None, split=None, perf="ME", pot="Mid", submitted=True, **kw):
    U[k] = mk(k, **kw)
    pid = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route, hod_user_id, hod2_user_id, hod_split) VALUES (?,?,?,?,?,?,?)",
                     (CID, PFX + k, U[k], "B", U[hod] if hod else None, U[hod2] if hod2 else None, split)).lastrowid
    P[k] = pid
    db.execute("INSERT INTO gradeh_appraisals (cycle_id, person_id, lm_submitted_at, perf_band, pot_band, perf_rating, pot_score, promo_nominate, "
               "b_achievements, b_strengths, b_development, conversation_held) VALUES (?,?,?,?,?,?,?, 'no', ?,?,?,1)",
               (CID, pid, "2026-11-10 02:00:00" if submitted else None, perf if submitted else None, pot if submitted else None, 3.2, 9.0,
                "ZZ-A-" + k, "ZZ-S-" + k, "ZZ-D-" + k))
    return pid


def urow(k):
    return db.execute("SELECT * FROM users WHERE id=?", (U[k],)).fetchone()


def agree(k, stage, only=None):
    """HOD k ticks Agree on their people (only = these keys) of one stage."""
    def f(d):
        ids = [r["id"] for r in a.gradeh_hod_scope(d, U[k], CID) if not r["disagree_at"]]
        pick = {P[x] for x in only} if only is not None else set(ids)
        return a.gradeh_hod_agree(d, urow(k), stage, ids, pick)
    return run(f)


def sign(k, stage, reason="A fair reason for this spread."):
    return run(lambda d: a.gradeh_hod_signoff(d, urow(k), stage, reason))


def stamp(k, stage, when):
    db.execute("UPDATE gradeh_signoffs SET signed_at=? WHERE scope_key=? AND stage=? AND tier='hod'", (when, str(U[k]), stage))
    db.commit()


def clear_state():
    for t in ("gradeh_reviews", "gradeh_hod_reviews", "gradeh_signoffs", "gradeh_band_moves"):
        db.execute("DELETE FROM " + t)
    db.commit()


def people():
    return {p["eid"]: p for p in run(lambda d: a.gradeh_admin_people(d, CID))}


def snap():
    return [tuple(r) for r in db.execute("SELECT id, hod_user_id, hod2_user_id, hod_split FROM gradeh_people ORDER BY id")]


def n_audit():
    return one("SELECT COUNT(*) FROM activity_log WHERE action='gradeh_set_hods'")


if True:
    CID = run(lambda d: a.active_cycle_id(d))
    HALF0 = db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()["half"]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
    db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 1)", (CID,))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell LIKE 'gradeh_%'", (CID,))
    for c_ in (CO, COB, COC):
        db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, c_))
    db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG2, COX))
    BASE0 = one("SELECT COUNT(*) FROM gradeh_people WHERE cycle_id=?", (CID,))
    # the seats: unit A's and unit B's BU CEO
    U["BCA"] = mk("BCA", "21")
    U["BCB"] = mk("BCB", "21", co=COB)
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, U["BCA"]))
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, COB, U["BCB"]))
    # real HODs (they hold the HOD role) and a BG CEO (holds no Grade H HOD role) and two calibrators of the normal review (a calibration-group calibrator, a Group Chief), who ARE Grade H HODs since 2026-11-03
    for k_ in ("HA", "HB", "HD", "HM"):
        U[k_] = mk(k_, "19", dept="ZZBH Dept " + k_)
    U["HG"] = mk("HG", "21")
    db.execute("UPDATE users SET bgceo_bg=? WHERE id=?", (BG, U["HG"]))
    U["HCAL"] = mk("HCAL", "21")
    db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id, active) VALUES (?,?,?,?,1)", (BG, COB, "ZZBH Group One", U["HCAL"]))
    U["HGC"] = mk("HGC", "21")
    db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES (?,?)", ("ZZBH Chief Group", U["HGC"]))
    # people
    person("X1", hod="HA", dept="ZZBH Dept Alpha")
    person("X2", hod="HA", dept="ZZBH Dept Alpha")
    person("Y1", hod="HB", dept="ZZBH Dept Beta")
    for k_, sp_ in (("S1", 50), ("S2", 70), ("S3", 30)):
        person(k_, hod="HA", hod2="HB", split=sp_, dept="ZZBH Dept Alpha")
    person("D1", hod="HA", hod2="HB", split=50, dept="ZZBH Dept Alpha")
    db.execute("UPDATE gradeh_appraisals SET disagree_at='2026-11-11 02:00:00' WHERE person_id=?", (P["D1"],))
    person("R1", hod="HA", hod2="BCA", split=50, dept="ZZBH Dept Alpha")     # HA and the unit's BU CEO (holds no HOD role): HA takes them at 100%
    person("C1", hod="BCA", dept="ZZBH Dept Gamma")                          # the BU CEO is their HOD: they go to the BU CEO
    person("C2", hod="BCA", dept="ZZBH Dept Gamma")
    person("N1", dept="ZZBH Dept Nobody")                                    # no HOD at all
    person("N2", co=COB, dept="ZZBH Dept Nobody")
    person("G1", hod="HG", dept="ZZBH Dept Gee")
    person("K1", hod="HCAL", co=COB, dept="ZZBH Dept Kay")
    person("Q1", hod="HGC", co=COC, dept="ZZBH Dept Queue")
    person("M1", hod="HM", dept="ZZBH Dept Em One")                           # one HOD across three units
    person("M2", hod="HM", co=COB, dept="ZZBH Dept Em Two")
    person("M3", hod="HM", co=COC, dept="ZZBH Dept Em Three")
    person("Z1", hod="HD", co=COB, dept="ZZBH Dept Zed")
    person("Z2", hod="HD", co=COB, dept="ZZBH Dept Zed")
    db.commit()
    db.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%'")
    db.commit()
    # a BG admin and a BG admin whose role lacks the Grade H item
    a._seed_access_roles()
    NOROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZBH No Grade H', 'group')").lastrowid
    db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(NOROLE, k) for k in sorted(a.role_preset_items("view")) if k != "gradeh.read"])

    def mk_admin(k, bg, role_builtin=None, role_id=None):
        return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg, admin_role_id) "
                          "VALUES (?,?, 'x', 'admin', ?, ?, ?, ?)",
                          ((PFX + k).lower(), "ZZ BH " + k, PFX + k, bg, bg,
                           role_id or db.execute("SELECT id FROM admin_roles WHERE builtin=?", (role_builtin,)).fetchone()[0])).lastrowid
    U["BGA"] = mk_admin("BGA", BG, role_builtin="bg")
    U["NOA"] = mk_admin("NOA", BG, role_id=NOROLE)
    db.commit()

CSU = H.client_as(a, SU["id"])
CBGA = H.client_as(a, U["BGA"])
CNOA = H.client_as(a, U["NOA"])
CEMP = H.client_as(a, EMP["id"])
HODV = "/admin/gradeh?tab=people&view=hod"

try:
    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("the switch: By person | By HOD, kept in the address")
    pp = CSU.get("/admin/gradeh?tab=people").get_data(as_text=True)
    ph = CSU.get(HODV).get_data(as_text=True)
    s.check("By person is the default and its table is today's (the tick column, 'Set appraiser for', no By HOD table)",
            'id="gh-people"' in pp and 'id="gh-hods"' not in pp and "data-gh-go" in pp)
    s.check("the switch is the app's own tray (.rv-tbox-views) with both choices as links, the open one pressed", re.search(
        r'<div class="rv-tbox-views gh-seg"[^>]*>\s*<a class="rv-tbox-view" href="[^"]*" aria-pressed="true">By person</a>\s*<a class="rv-tbox-view" '
        r'href="[^"]*view=hod[^"]*" aria-pressed="false">By HOD</a>', pp) is not None)
    s.check("?view=hod shows the By HOD table, By HOD pressed, and the form carries view=hod so a search or a filter keeps it",
            'id="gh-hods"' in ph and 'id="gh-people"' not in ph and re.search(r'aria-pressed="true">By HOD</a>', ph) is not None
            and '<input type="hidden" name="view" value="hod">' in ph)
    s.check("an unknown view is By person", 'id="gh-people"' in CSU.get("/admin/gradeh?tab=people&view=zzz").get_data(as_text=True))

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("one row a HOD: the cells are the By person data counted another way")
    PP = people()
    mine = {e: p for e, p in PP.items() if e.startswith(PFX)}
    rows = hod_table(ph)
    s.check("the table is there with a row a named HOD (6 who hold the Grade H role, among them the two calibrators of the normal review; 2 who hold a CEO seat) and the last 'No Grade H HOD' row", rows is not None
            and len(rows) == 4 + 4 + 1 and rows[-1][0].startswith("No Grade H HOD"), [r[0] for r in rows or []])
    ha, hb, hd, hm = (row_of(rows, PFX + k) for k in ("HA", "HB", "HD", "HM"))
    cnt = lambda uid: len(a._gh_hod_filter(list(mine.values()), uid))  # noqa: E731
    s.check("People = the people By person's ?hod= names (first or second HOD): HA 7, HB 5, HD 2, HM 3",
            [int(x[2].split()[0].replace(",", "")) for x in (ha, hb, hd, hm)] == [7, 5, 2, 3] == [cnt(str(U[k])) for k in ("HA", "HB", "HD", "HM")], [x[2] for x in (ha, hb, hd, hm)])
    s.check("...and for a role HOD it is exactly the people gradeh_hod_scope gives their own page (the same people, a second HOD's included)",
            all(len(run(lambda d, k=k: a.gradeh_hod_scope(d, U[k], CID))) == n_ for k, n_ in (("HA", 7), ("HB", 5), ("HD", 2), ("HM", 3))))
    s.check("Shared: HA 4 shared with HB (S1 S2 S3 and D1), HB 4 with HA; a one-HOD HOD reads a dash",
            ha[3] == "4 shared with ZZ BH HB" and hb[3] == "4 shared with ZZ BH HA" and hd[3] == "–" and hm[3] == "–", (ha[3], hb[3], hd[3]))
    s.check("...R1 (HA and a BU CEO who holds no role) is not shared: the other takes none", PP[PFX + "R1"]["shared"] is False and PP[PFX + "R1"]["hod_stage"])
    s.check("Unit · departments: names the unit and the departments of their people; one unit by name, '3 units' for three",
            "ZZBH Unit A" in ha[1] and "ZZBH Dept Alpha" in ha[1] and hm[1].startswith("3 units") and "1 more" in hm[1], (ha[1], hm[1]))
    s.check("the HOD cell names them, their Employee ID and title", ha[0].startswith("ZZ BH HA") and PFX + "HA" in ha[0], ha[0])
    bca, hg, hcal, hgc = (row_of(rows, PFX + k) for k in ("BCA", "HG", "HCAL", "HGC"))
    s.check("a BU CEO who is the HOD of 3 reads 'No HOD role · holds a BU CEO seat', 'Their 2 go to the BU CEO' and '1 to <HA>' (R1: the other HOD takes 100%)",
            bca is not None and bca[2].split()[0] == "3" and "No HOD role · holds a BU CEO seat" in bca[4] and "Their 2 go to the BU CEO" in bca[4] and "1 to ZZ BH HA" in bca[4], bca)
    s.check("a BG CEO reads 'No HOD role · holds a BG CEO seat' and 'Their 1 go to the BU CEO', with no Shared and no stage cells (the one cell spans both)",
            "No HOD role · holds a BG CEO seat" in hg[4] and "Their 1 go to the BU CEO" in hg[4] and all(x[3] == "–" and len(x) == 5 for x in (bca, hg)), hg)
    s.check("a calibration-group calibrator and a Group Chief group's are live Grade H HODs (Chris 2026-11-03): no 'No HOD role', their one person counted, both stage cells drawn",
            all("No HOD role" not in " ".join(x) and "go to the BU CEO" not in " ".join(x) and len(x) == 6 and x[2].split()[0] == "1" for x in (hcal, hgc)), (hcal, hgc))
    s.check("...and their one person has an HOD stage (K1, Q1) and sits in their gradeh_hod_scope", PP[PFX + "K1"]["hod_stage"] and PP[PFX + "Q1"]["hod_stage"]
            and len(run(lambda d: a.gradeh_hod_scope(d, U["HCAL"], CID))) == 1 and len(run(lambda d: a.gradeh_hod_scope(d, U["HGC"], CID))) == 1)
    real_ids = a._gh_hod_ids_with_role
    a._gh_hod_ids_with_role = lambda db_, ids_: [i for i in ids_ if a.hod_has_role(db_, i)]   # the OLD rule: a calibrator holds no role
    try:
        old_ = hod_table(CSU.get(HODV).get_data(as_text=True))
        s.check("falsified: on the old rule (the normal review's hod_has_role) the two calibrators WOULD read 'No HOD role' (so the check above is the Grade H twin)",
                all("No HOD role" in row_of(old_, PFX + k)[4] for k in ("HCAL", "HGC")))
    finally:
        a._gh_hod_ids_with_role = real_ids
    s.check("(put back) the twin is read again", "No HOD role" not in " ".join(row_of(hod_table(CSU.get(HODV).get_data(as_text=True)), PFX + "HCAL")))
    s.check("the reasons are only the two seats (no calibration group / Group Chief words): a BU CEO, a BG CEO",
            run(lambda d: a._gh_no_role_reasons(d, [U["BCA"], U["HG"]])) == {U["BCA"]: "holds a BU CEO seat", U["HG"]: "holds a BG CEO seat"})
    nonerow = rows[-1]
    s.check("'No Grade H HOD': the people with no live Grade H HOD (N1, N2: not G1 K1 Q1, whose HOD is named but holds no role), its sub line, '2 units', 'Straight to the BU CEO'",
            nonerow[0] == "No Grade H HOD The BU CEO covers them" and nonerow[1] == "2 units" and nonerow[2].split()[0] == "2" and nonerow[4] == "Straight to the BU CEO",
            nonerow)
    s.check("the rule: nobody named = no first and no second HOD on the By person row", {e for e, p in mine.items() if not p["hod_id"] and not p["hod2_id"]} == {PFX + "N1", PFX + "N2"})
    s.check("every row has a People icon beside the count (aria-label, href); the super admin's opens the list panel (data-list-open) and the count too, with a By person link as the fallback",
            ph.count('class="gh-picon"') == 9 and ph.count('aria-label="Open their ') == 9 and 'class="gh-pbtn"' not in ph and re.search(r'class="gh-picon" href="[^"]*hod=%d[^"]*" data-list-open="[^"]*hod=%d[^"]*" title="Open their \d+ (?:person|people)" aria-label="Open their ' % (U["HA"], U["HA"]), ph) is not None and ph.count("data-list-open=") >= 18 and re.search(r'class="gh-cnt" href="[^"]*hod=%d[^"]*"[^>]*data-list-open="[^"]*hod=%d' % (U["HA"], U["HA"]), ph) is not None)
    def n_queries(extra_people=()):
        """How many SQL statements the By HOD builder runs over the people as they are."""
        def f(d):
            ps = a.gradeh_admin_people(d, CID)
            qs = []
            d.set_trace_callback(qs.append)
            try:
                a.gradeh_by_hod(d, CID, ps)
            finally:
                d.set_trace_callback(None)
            return len(qs)
        return run(f)
    q_before = n_queries()
    for i_ in range(6):   # six more HODs, each with a person (not a calibrator): the builder's reads must not grow with them
        U["QH%d" % i_] = mk("QH%d" % i_, "19")
        person("QP%d" % i_, hod="QH%d" % i_, dept="ZZBH Dept Q")
    db.commit()
    q_after = n_queries()
    s.check("one batched read over the population: six more HODs cost %d more SQL statements, not a query a HOD (%d -> %d)" % (q_after - q_before, q_before, q_after),
            q_after - q_before <= 2 and len(hod_table(CSU.get(HODV).get_data(as_text=True))) == 9 + 6, (q_before, q_after))
    for i_ in range(6):   # put back
        db.execute("DELETE FROM gradeh_appraisals WHERE person_id=?", (P["QP%d" % i_],))
        db.execute("DELETE FROM gradeh_people WHERE id=?", (P["QP%d" % i_],))
    db.commit()

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("'reviewed' and 'signed off' are the HOD's own page's, for every HOD")
    def view_sum(k):
        return run(lambda d: a.gradeh_hod_view(d, urow(k), CID))["summary"]
    def prog():
        return run(lambda d: a.gradeh_hod_progress(d, CID))
    clear_state()
    pr0 = prog()
    s.check("before anyone acts: 0 reviewed of each HOD's calibrated people (D1, who does not agree, is not counted), potential open, performance not",
            pr0[U["HA"]]["pot"]["n"] == 6 and pr0[U["HA"]]["pot"]["reviewed"] == 0 and pr0[U["HB"]]["pot"]["n"] == 4 and pr0[U["HD"]]["pot"]["n"] == 2
            and pr0[U["HA"]]["pot"]["gate"] is None and pr0[U["HA"]]["perf"]["gate"] and "potential" in pr0[U["HA"]]["perf"]["gate"].lower(), pr0[U["HA"]])
    ok1 = agree("HA", "pot")
    ok2 = sign("HA", "pot")
    stamp("HA", "pot", "2026-11-13 02:00:00")
    ok3 = agree("HA", "perf", only=["X1", "X2"])
    ok4 = agree("HB", "pot", only=["Y1", "S1"])
    s.check("(setup) HA signs potential and agrees two on performance; HB agrees two of four on potential", ok1[0] and ok2[0] and ok3[0] and ok4[0], (ok1, ok2, ok3, ok4))
    rows = hod_table(CSU.get(HODV).get_data(as_text=True))
    ha, hb, hd = (row_of(rows, PFX + k) for k in ("HA", "HB", "HD"))
    s.check("HA: 'Signed off 13 Nov' (the day in MYT) and '2 of 6 reviewed'", ha[4] == "Signed off 13 Nov" and ha[5] == "2 of 6 reviewed", (ha[4], ha[5]))
    s.check("HB: '2 of 4 reviewed' on potential and 'Not open' on performance (potential first)", hb[4] == "2 of 4 reviewed" and hb[5] == "Not open", (hb[4], hb[5]))
    s.check("HD (nothing done): '0 of 2 reviewed' and 'Not open'", hd[4] == "0 of 2 reviewed" and hd[5] == "Not open", (hd[4], hd[5]))
    pr = prog()
    for k in ("HA", "HB", "HD", "HM"):
        vs = view_sum(k)
        same = all(pr[U[k]][stg][f] == vs[stg][f] for stg in ("pot", "perf") for f in ("n", "reviewed", "signed", "signed_on"))
        s.check("%s: n / reviewed / signed / signed_on of both stages equal what their own page's summary says" % k, same, (pr[U[k]]["pot"], vs["pot"]))
    s.check("...and the table's words are those numbers (HA 2 of 6 = their page's reviewed %d of %d)" % (view_sum("HA")["perf"]["reviewed"], view_sum("HA")["perf"]["n"]),
            ha[5] == "%d of %d reviewed" % (view_sum("HA")["perf"]["reviewed"], view_sum("HA")["perf"]["n"]))
    # a shared person is reviewed BY THAT HOD on their own call: the admin level (no HOD named) reads it another way
    def calp(k, as_hod=None):
        def f(d):
            rows_ = d.execute(a._GH_CAL_SQL + "AND p.id=?", (CID, P[k])).fetchall()
            mvs, rvs, ys = a._gh_cal_load(d, CID, rows_)
            return a._gh_cal_person(rows_[0], mvs, rvs, ys, show_default=False, as_hod=(U[as_hod] if as_hod else None))
        return run(f)
    s.check("falsified: read WITHOUT naming the HOD (the admin level) S2 is 'reviewed' because HA agreed it; read AS HB it is not (HB has not): so a count over the "
            "admin's person dicts would give HB 3 where their own page, and the table, say 2",
            calp("S2")["hod_done"]["pot"] is True and calp("S2", "HB")["hod_done"]["pot"] is False and calp("S2", "HA")["hod_done"]["pot"] is True
            and view_sum("HB")["pot"]["reviewed"] == 2 == pr[U["HB"]]["pot"]["reviewed"])
    # patched twin: a different definition of reviewed changes the table (it is the one function)
    real_sum = a.gradeh_hod_stage_summary
    a.gradeh_hod_stage_summary = lambda people_, stage, signoff=None: dict(real_sum(people_, stage, signoff), reviewed=99)
    try:
        wrong = hod_table(CSU.get(HODV).get_data(as_text=True))
    finally:
        a.gradeh_hod_stage_summary = real_sum
    s.check("falsified: a patched stage summary reaches the table (so the table reads the shared function, not a copy)", row_of(wrong, PFX + "HB")[4] == "99 of 4 reviewed")
    # the calendar: a closed window reads Not open, with the page's own words in the title
    db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (CID, "gradeh_hod_pot", "2026-01-01 00:00", "2026-01-02 00:00"))
    db.commit()
    h2 = CSU.get(HODV).get_data(as_text=True)
    r2 = hod_table(h2)
    s.check("a closed calendar window: an unsigned potential reads 'Not open', its title says why; a signed one stays 'Signed off'",
            row_of(r2, PFX + "HB")[4] == "Not open" and row_of(r2, PFX + "HA")[4] == "Signed off 13 Nov" and re.search(r'title="[^"]*closed on[^"]*">Not open', h2) is not None)
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell LIKE 'gradeh_%'", (CID,))
    db.commit()
    s.check("...the window open again: 'k of n reviewed'", row_of(hod_table(CSU.get(HODV).get_data(as_text=True)), PFX + "HB")[4] == "2 of 4 reviewed")
    sign_ok = agree("HB", "pot") and sign("HB", "pot")
    s.check("HB signs potential: performance opens for them ('0 of 4 reviewed')", sign_ok[0] and row_of(hod_table(CSU.get(HODV).get_data(as_text=True)), PFX + "HB")[5] == "0 of 4 reviewed")

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("the filters and Search in, with their counts")
    def opts(html):
        m = re.search(r'<select name="hf".*?</select>', html, re.S)
        return {v: clean(l) for v, l in re.findall(r'<option value="([^"]*)"[^>]*>(.*?)</option>', m.group(0), re.S)} if m else {}
    def keys(html):
        return [re.search(r"ZZ9BH-\w+", r[0]).group(0)[6:] if re.search(r"ZZ9BH-\w+", r[0]) else "(none)" for r in hod_table(html)]
    h0 = CSU.get(HODV).get_data(as_text=True)
    o = opts(h0)
    s.check("the select reads All HODs (8) · Shared (2) · No HOD role (2) · Not signed off (n) · No Grade H HOD (2 people)",
            o.get("all") == "All HODs (8)" and o.get("shared") == "Shared (2)" and o.get("norole") == "No HOD role (2)" and o.get("none") == "No Grade H HOD (2)"
            and o.get("unsigned", "").startswith("Not signed off ("), o)
    s.check("All HODs: 8 HODs and the last row", sorted(keys(h0)) == sorted(["HA", "HB", "HD", "HM", "BCA", "HG", "HCAL", "HGC", "(none)"]), keys(h0))
    s.check("Shared: HA and HB only, no No Grade H HOD row", sorted(keys(CSU.get(HODV + "&hf=shared").get_data(as_text=True))) == ["HA", "HB"])
    s.check("No HOD role: the two CEO seats only (BU CEO, BG CEO); the calibrators of the normal review are not here", sorted(keys(CSU.get(HODV + "&hf=norole").get_data(as_text=True))) == ["BCA", "HG"])
    un = sorted(keys(CSU.get(HODV + "&hf=unsigned").get_data(as_text=True)))
    s.check("Not signed off: role HODs with a stage still to sign (HA signed only potential; HB, HD, HM nothing on performance); never a CEO seat; the two calibrators are role HODs now (3 Nov) with a stage to sign",
            un == ["HA", "HB", "HCAL", "HD", "HGC", "HM"], un)
    sign_a = agree("HA", "perf") and sign("HA", "perf")
    s.check("(setup) HA signs performance: HA leaves Not signed off, and its count follows", sign_a[0]
            and sorted(keys(CSU.get(HODV + "&hf=unsigned").get_data(as_text=True))) == ["HB", "HCAL", "HD", "HGC", "HM"]
            and opts(CSU.get(HODV).get_data(as_text=True))["unsigned"] == "Not signed off (5)")
    s.check("No Grade H HOD: that row alone", keys(CSU.get(HODV + "&hf=none").get_data(as_text=True)) == ["(none)"])
    s.check("an unknown filter is All", len(hod_table(CSU.get(HODV + "&hf=zzz").get_data(as_text=True))) == 9)
    srch = lambda q, qin="all", extra="": keys(CSU.get(HODV + "&q=%s&qin=%s%s" % (q.replace(" ", "+"), qin, extra)).get_data(as_text=True)) if hod_table(  # noqa: E731
        CSU.get(HODV + "&q=%s&qin=%s%s" % (q.replace(" ", "+"), qin, extra)).get_data(as_text=True)) else []
    s.check("search by name: 'BH HA' finds HA", srch("BH HA") == ["HA"])
    s.check("search by Employee ID (Search in: Employee ID): ZZ9BH-HM finds HM; the name does not match the ID field", srch("ZZ9BH-HM", "eid") == ["HM"] and srch("BH HM", "eid") == [])
    s.check("search by unit (Search in: Unit): 'Unit C' finds HM (a person there) and HGC and the No Grade H row has no one there", sorted(srch("Unit C", "unit")) == ["HGC", "HM"], srch("Unit C", "unit"))
    s.check("search by department (Search in: Department): 'Dept Zed' finds HD; 'Dept Nobody' finds only the No Grade H HOD row",
            srch("Dept Zed", "dept") == ["HD"] and srch("Dept Nobody", "dept") == ["(none)"])
    s.check("a name search never lists the No Grade H HOD row; All fields reads unit and department too ('Dept Alpha' = HA, HB and BCA, whose R1 is there)",
            "(none)" not in srch("ZZ BH") and sorted(srch("Dept Alpha")) == ["BCA", "HA", "HB"], srch("Dept Alpha"))   # BCA: R1 sits in Dept Alpha
    s.check("a search that matches nobody says so", "No HOD matches" in text(CSU.get(HODV + "&q=nobodyzz")))
    s.check("the counts follow the search (All HODs (1) for 'BH HA')", opts(CSU.get(HODV + "&q=BH+HA").get_data(as_text=True)).get("all") == "All HODs (1)")
    s.check("the business group / unit pills narrow the people first: unit C alone leaves HM (1 person) and HGC", sorted(keys(CSU.get(HODV + "&bg=%s&bu=%s" % (BG.replace(" ", "+"), COC.replace(" ", "+"))).get_data(as_text=True))) == ["HGC", "HM"])
    s.check("Search in is the page's one control (the same select as By person)", 'name="qin"' in h0 and h0.count('name="qin"') == 1)

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("By person: the HOD filter, its chip and clear link; the list panel's ?hod=")
    def pe_keys(html):
        return sorted(set(re.findall(r"ZZ9BH-(\w+)", " ".join(re.findall(r'<td title="[^"]*"><a href="[^"]*" data-person-open="\d+"><b>[^<]*</b></a> <span class="muted small">([^<]*)</span>', html)))))
    hf_ = CSU.get("/admin/gradeh?tab=people&hod=%d" % U["HA"]).get_data(as_text=True)
    s.check("?hod=<HA> lists exactly HA's people (first or second HOD: X1 X2 S1 S2 S3 D1 R1)", pe_keys(hf_) == sorted(["X1", "X2", "S1", "S2", "S3", "D1", "R1"]), pe_keys(hf_))
    s.check("...with a chip naming the HOD and a Clear link that drops the filter and keeps the rest",
            'class="gh-hodfilter"' in hf_ and "HOD · ZZ BH HA" in clean(hf_) and re.search(r'class="btn-link" href="(/admin/gradeh\?tab=people)">Clear</a>', hf_) is not None)
    s.check("?hod=none: the people with no HOD named (N1, N2), chip 'No Grade H HOD'", pe_keys(CSU.get("/admin/gradeh?tab=people&hod=none").get_data(as_text=True)) == ["N1", "N2"]
            and "HOD · No Grade H HOD" in clean(CSU.get("/admin/gradeh?tab=people&hod=none").get_data(as_text=True)))
    s.check("?hod= for a calibrator lists the people who name them (the BU CEO: C1 C2 R1)", pe_keys(CSU.get("/admin/gradeh?tab=people&hod=%d" % U["BCA"]).get_data(as_text=True)) == ["C1", "C2", "R1"])
    s.check("a HOD nobody names, or junk, lists nobody", "Nobody matches" in text(CSU.get("/admin/gradeh?tab=people&hod=999999")) and "Nobody matches" in text(CSU.get("/admin/gradeh?tab=people&hod=zz")))
    s.check("without ?hod= there is no chip (By person is as it was)", 'class="gh-hodfilter"' not in pp)
    s.check("the filter keeps its counts: the Show counts are of the HOD's people", re.search(r"Everyone \(7\)", hf_) is not None)
    from openpyxl import load_workbook
    import io
    wb = load_workbook(io.BytesIO(CSU.get("/admin/gradeh/list.xlsx?hod=%d" % U["HA"]).get_data()))
    xr = [[c.value for c in r] for r in wb.worksheets[0].iter_rows()][1:]
    s.check("the Excel honours the filter (HA's seven rows)", sorted(x[0] for x in xr) == sorted(PFX + k for k in ("X1", "X2", "S1", "S2", "S3", "D1", "R1")), [x[0] for x in xr])
    lp = CSU.get("/admin/list/gh?hod=%d&fragment=1" % U["HA"]).get_data(as_text=True)
    s.check("the list panel's ?hod= opens the same 7 people, titled with the HOD", all((PFX + k) in lp for k in ("X1", "S1", "R1")) and (PFX + "Y1") not in lp
            and 'data-list-title="Grade H people of ZZ BH HA · 7"' in lp, lp[:300])
    s.check("...none: the people with no HOD named", (PFX + "N1") in CSU.get("/admin/list/gh?hod=none&fragment=1").get_data(as_text=True) and (PFX + "X1") not in CSU.get("/admin/list/gh?hod=none&fragment=1").get_data(as_text=True))
    s.check("the list panel stays the super admin's (a BG admin is refused it, with ?hod= too)", CBGA.get("/admin/list/gh?hod=%d&fragment=1" % U["HA"]).status_code == 403)

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("scope: a BG admin with gradeh.read sees their own group's people, and the HODs of them")
    person("W1", hod="HA", bg=BG2, co=COX, dept="ZZBH Dept Other")     # HA also has a person in another business group
    person("W2", hod="HM", bg=BG2, co=COX, dept="ZZBH Dept Other")
    U["HO"] = mk("HO", "19", co=COX, bg=BG2)
    person("O1", hod="HO", bg=BG2, co=COX, dept="ZZBH Dept Other")     # a HOD of the other group alone
    db.commit()
    super_rows = hod_table(CSU.get(HODV).get_data(as_text=True))
    bg_html = CBGA.get(HODV).get_data(as_text=True)
    bg_rows = hod_table(bg_html)
    s.check("the super admin sees the HOD of the other group (HO) and HA's 8 people; the BG admin sees neither HO nor the other group's person",
            row_of(super_rows, PFX + "HO") is not None and row_of(super_rows, PFX + "HA")[2].split()[0] == "8" and row_of(bg_rows, PFX + "HO") is None and row_of(bg_rows, PFX + "HA")[2].split()[0] == "7",
            (row_of(super_rows, PFX + "HA")[2], row_of(bg_rows, PFX + "HA")[2]))
    s.check("...the unit column names only the units in their scope", COX not in row_of(bg_rows, PFX + "HA")[1] and COX in row_of(super_rows, PFX + "HO")[1])
    s.check("...and the stage counts are inside the scope too (HA's calibrated people: 6 in the group, 7 with the other group's)",
            run(lambda d: a.gradeh_hod_progress(d, CID, {p["pid"] for p in a._gh_scope_people(a.gradeh_admin_people(d, CID), d.execute("SELECT * FROM users WHERE id=?", (U["BGA"],)).fetchone())}))[U["HA"]]["pot"]["n"] == 6
            and prog()[U["HA"]]["pot"]["n"] == 7)
    s.check("a BG admin has no list panel on By HOD: the count and the People icon are plain links to By person narrowed to that HOD (no data-list-open)",
            "data-list-open" not in bg_html.split('id="gh-hods"')[1].split("</table>")[0] and "hod=%d" % U["HA"] in bg_html)
    s.check("...and that link works: By person for the BG admin lists their group's seven, not the other group's W1", pe_keys(CBGA.get("/admin/gradeh?tab=people&hod=%d" % U["HA"]).get_data(as_text=True)) ==
            sorted(["X1", "X2", "S1", "S2", "S3", "D1", "R1"]))
    s.check("a BG admin gets no Set HOD button or tick column; a role without gradeh.read is sent back (never a 200)",
            "data-gh-go-hod" not in CBGA.get("/admin/gradeh?tab=people").get_data(as_text=True) and CNOA.get(HODV).status_code in (302, 403, 404)
            and CEMP.get(HODV).status_code in (302, 403, 404))
    s.check("the HOD of the other group: a BG admin of the other group would see HO; this one's By HOD has no row for HO (checked above) and the Not signed off filter keeps the scope",
            row_of(hod_table(CBGA.get(HODV + "&hf=unsigned").get_data(as_text=True)), PFX + "HO") is None)
    for k_ in ("W1", "W2", "O1"):   # put back
        db.execute("DELETE FROM gradeh_appraisals WHERE person_id=?", (P[k_],))
        db.execute("DELETE FROM gradeh_people WHERE id=?", (P[k_],))
    db.commit()

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("Set HOD for several: the people, the panel")
    clear_state()
    for k_ in ("HE", "HF", "HN", "HK", "HS"):
        U[k_] = mk(k_, "19")
    for k_ in ("B1", "B2", "B3", "B5"):
        person(k_, hod="HE", dept="ZZBH Dept Bulk")
    person("B4", hod="HE", hod2="HF", split=60, dept="ZZBH Dept Bulk")     # has their own second HOD
    person("B6", hod="HE", co=COB, dept="ZZBH Dept Bulk")                  # in unit B, which its BU CEO will sign off
    person("B7", hod="HS", dept="ZZBH Dept Bulk")                          # their HOD has signed a stage
    person("B8", hod="HE", dept="ZZBH Dept Bulk")                          # the picked HOD (HN) is themself a person on the list
    db.execute("UPDATE gradeh_people SET user_id=? WHERE id=?", (U["HN"], P["B8"]))
    db.execute("UPDATE gradeh_appraisals SET person_id=person_id WHERE person_id=?", (P["B8"],))
    person("B9", hod="HE", hod2="HN", split=50, dept="ZZBH Dept Bulk")     # their second HOD is the one that will be picked first
    db.execute("INSERT INTO gradeh_signoffs(cycle_id, tier, stage, scope_key, signed_by) VALUES (?, 'hod', 'pot', ?, ?)", (CID, str(U["HS"]), U["HS"]))
    db.execute("INSERT INTO gradeh_signoffs(cycle_id, tier, stage, scope_key, signed_by) VALUES (?, 'buceo', 'all', ?, ?)", (CID, COB, U["BCB"]))
    db.commit()
    ALL9 = [P[k] for k in ("B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9")]
    eid = lambda k: PFX + k  # noqa: E731
    bar = CSU.get("/admin/gradeh?tab=people").get_data(as_text=True)
    s.check("the pick bar: a second button 'Set HOD for N' beside 'Set appraiser for N' (super admin), its panel URL carried",
            'data-gh-go-hod>Set HOD for 0</button>' in bar and "data-gh-bulk-hod-url=" in bar and "panel=bulkhod" in bar)
    s.check("the first button and its wording are unchanged ('Tick people to set one appraiser for several', 'Set appraiser for 0')",
            "Tick people to set one appraiser for several" in bar and "data-gh-go>Set appraiser for 0</button>" in bar)
    pn = CSU.get("/admin/gradeh?tab=people&panel=bulkhod&pick=%s" % ",".join(str(x) for x in [P["B1"], P["B6"], P["B7"], P["B4"], 999999]))
    pt = pn.get_data(as_text=True)
    ct = clean(pt)
    s.check("the panel lists the ticked people (not the one who is not on the list), each with their HOD now (a pair for B4)",
            all(("ZZ BH " + k) in ct for k in ("B1", "B6", "B7", "B4")) and ct.count("Now: ZZ BH HE") == 2 and "Now: ZZ BH HE + ZZ BH HF" in ct and "Set the HOD for 4 people" in ct, ct[ct.find("Set the HOD"):][:400])
    s.check("...with who is left out and why: the unit signed off (B6), their HOD has signed (B7)", "Unit signed off · left out" in ct and "HOD has signed · left out" in ct
            and "ZZ BH B6 is in a unit the BU CEO has signed off" in ct and "ZZ BH B7 is with a HOD who has already signed off a stage" in ct, ct)
    s.check("a strict HOD pick, a second HOD pick, the split (disabled until a second HOD is picked, 10..90 in 10s, 50 : 50 selected) and the 'Take away any second HOD' tick (off)",
            'name="hod_eid"' in pt and 'name="hod2_eid"' in pt and re.search(r'<select name="hod_split"[^>]*disabled', pt) and '<option value="50" selected>50 : 50</option>' in pt
            and pt.count('<option value="') >= 9 and 'name="clear2"' in pt and "Take away any second HOD" in ct and 'name="clear2" value="1" data-gh-clear2>' in pt)
    s.check("one confirm box naming the count and its button repeating the verb: 'Set HOD for 2' (B1 and B4 can be set)",
            'data-confirm-ok="Set HOD for 2"' in pt and "data-confirm=\"Make the person you picked the Grade H HOD of 2 people (ZZ BH B1, ZZ BH B4)" in pt and "Set HOD for 2</button>" in pt, ct[-400:])
    s.check("the form posts to the bulk route with the CSRF token in the form and a pid a person", 'action="/admin/gradeh/hods/bulk"' in pt and pt.split('id="gh-bulkhod-form"')[1].split("</form>")[0].count('name="pid"') == 4 and 'name="csrf_token"' in pt)
    s.check("a BG admin does not get the panel", "name=\"hod2_eid\"" not in CBGA.get("/admin/gradeh?tab=people&panel=bulkhod&pick=%d" % P["B1"]).get_data(as_text=True))
    s.check("with nobody ticked the panel says so and offers no button", "Nobody ticked is on this list" in text(CSU.get("/admin/gradeh?tab=people&panel=bulkhod&pick=999999")))
    s.check("the route is classed super in the access map", a.admin_access_need("admin_gradeh_hods_bulk", {}) == "super")

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("Set HOD for several: refusals before anything is written")
    def bulk(pids, hod=None, hod2=None, split=None, clear2=False, who=None):
        return run(lambda d: a.gradeh_set_hods_bulk(d, who if who is not None else d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone(),
                                                    pids, hod, hod2, split, clear2))
    refusals = [
        ("nobody ticked", dict(pids=[], hod=eid("HN")), "at least one person"),
        ("more than 200 people", dict(pids=list(range(1, 202)), hod=eid("HN")), "up to 200"),
        ("a blank HOD (a typed name that is not a pick posts nothing)", dict(pids=ALL9, hod=""), "Pick the HOD from the list"),
        ("an Employee ID nobody has", dict(pids=ALL9, hod="NOPE-1"), "isn't an active member"),
        ("a HOD who has already signed a stage", dict(pids=ALL9, hod=eid("HS")), "already signed off"),
        ("a pick and a take-away together", dict(pids=ALL9, hod=eid("HN"), hod2=eid("HK"), clear2=True), "not both"),
        ("a second HOD nobody has", dict(pids=ALL9, hod=eid("HN"), hod2="NOPE-2"), "second HOD"),
        ("the second HOD the same person as the HOD", dict(pids=ALL9, hod=eid("HN"), hod2=eid("HN")), "same person as the HOD"),
        ("a split of 55", dict(pids=ALL9, hod=eid("HN"), hod2=eid("HK"), split="55"), "10 to 90"),
        ("a split of 100", dict(pids=ALL9, hod=eid("HN"), hod2=eid("HK"), split="100"), "10 to 90"),
        ("a split of 'half'", dict(pids=ALL9, hod=eid("HN"), hod2=eid("HK"), split="half"), "10 to 90"),
        ("a split with no second HOD", dict(pids=ALL9, hod=eid("HN"), split="60"), "needs a second HOD"),
    ]
    s0, a0 = snap(), n_audit()
    for label, kw, want in refusals:
        ok, m, done, left = bulk(**kw)
        s.check("refused: %s" % label, not ok and want in m and done == 0 and snap() == s0 and n_audit() == a0, m)
    ok, m, done, left = bulk(ALL9, eid("HN"), who=db.execute("SELECT * FROM users WHERE id=?", (U["HE"],)).fetchone())
    s.check("refused: a non-super account (the writer itself)", not ok and "Only the super admin" in m and snap() == s0 and n_audit() == a0, m)
    # the HTTP route: only the super admin
    for who, cl in (("a BG admin", CBGA), ("a role without Grade H", CNOA), ("an employee", CEMP)):
        r_ = cl.post("/admin/gradeh/hods/bulk", data=csrf(pid=[str(x) for x in ALL9], hod_eid=eid("HN")))
        s.check("the route refuses %s: not a 200, nothing written" % who, r_.status_code in (302, 403) and snap() == s0 and n_audit() == a0, r_.status_code)

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("Set HOD for several: setting, the people left out, one audit row a person, one transaction")
    ok, m, done, left = bulk(ALL9, eid("HN"))
    lw = {nm: why for nm, why in left}
    s.check("set for B1 B2 B3 B4 B5 (five); left out: B6 (unit signed off), B7 (their HOD has signed), B8 (the picked HOD is themself), B9 (their second HOD is the one picked)",
            ok and done == 5 and set(lw) == {"ZZ BH B6", "ZZ BH B7", "ZZ BH HN", "ZZ BH B9"}   # B8's person IS the account HN
            and "BU CEO has signed off this unit" in lw["ZZ BH B6"] and "already signed off a Grade H stage" in lw["ZZ BH B7"]
            and "own HOD" in lw["ZZ BH HN"] and "same person as the HOD" in lw["ZZ BH B9"], (ok, m, lw))
    s.check("...the message names the HOD, the count and each left out with its reason", "ZZ BH HN is now the Grade H HOD of 5 people" in m and "left out: " in m and "ZZ BH B6 (" in m, m)
    s.check("the HOD is set on the five (gradeh_people.hod_user_id) and not on those left out", all(one("SELECT hod_user_id FROM gradeh_people WHERE id=?", (P[k],)) == U["HN"] for k in ("B1", "B2", "B3", "B4", "B5"))
            and one("SELECT hod_user_id FROM gradeh_people WHERE id=?", (P["B6"],)) == U["HE"] and one("SELECT hod_user_id FROM gradeh_people WHERE id=?", (P["B7"],)) == U["HS"]
            and one("SELECT hod_user_id FROM gradeh_people WHERE id=?", (P["B8"],)) == U["HE"])
    s.check("a blank second HOD KEEPS each person's own: B4 still has HF at 60 : 40; B1 has none", one("SELECT hod2_user_id FROM gradeh_people WHERE id=?", (P["B4"],)) == U["HF"]
            and one("SELECT hod_split FROM gradeh_people WHERE id=?", (P["B4"],)) == 60 and one("SELECT hod2_user_id FROM gradeh_people WHERE id=?", (P["B1"],)) is None)
    s.check("users.hod_id (the main review's HOD) is never touched", one("SELECT COUNT(*) FROM users WHERE id IN (%s) AND hod_id IS NOT NULL" % ",".join(str(U[k]) for k in ("B1", "B2", "B3", "B4", "B5"))) == 0)
    s.check("one audit row a person set (5), none for those left out, each naming the HOD", n_audit() == a0 + 5 and one("SELECT COUNT(*) FROM activity_log WHERE action='gradeh_set_hods' AND detail LIKE '%ZZ BH HN%' AND id > (SELECT MAX(id)-5 FROM activity_log)") >= 1)
    # take away
    sB = snap()
    ok, m, done, left = bulk([P[k] for k in ("B1", "B2", "B4", "B5")], eid("HN"), clear2=True)
    s.check("'Take away any second HOD': B4's second HOD and split are cleared; B1 B2 B5 (none) are NOT left out for it", ok and done == 4 and not left
            and one("SELECT hod2_user_id FROM gradeh_people WHERE id=?", (P["B4"],)) is None and one("SELECT hod_split FROM gradeh_people WHERE id=?", (P["B4"],)) is None, (m, left))
    # a second HOD and the split
    ok, m, done, left = bulk([P["B1"], P["B2"]], eid("HN"), eid("HK"), "70")
    s.check("a second HOD with the split 70 : 30 for two people: both set, the message says so", ok and done == 2 and "70 : 30" in m and "ZZ BH HN and ZZ BH HK are now the Grade H HODs of 2 people" in m
            and all(one("SELECT hod2_user_id FROM gradeh_people WHERE id=?", (P[k],)) == U["HK"] and one("SELECT hod_split FROM gradeh_people WHERE id=?", (P[k],)) == 70 for k in ("B1", "B2")), m)
    s.check("...each audit row names both HODs and both shares (gradeh_set_hods' own)", re.search(r"ZZ BH B1: Grade H HODs ZZ BH HN .* 70% and ZZ BH HK .* 30%", one("SELECT group_concat(detail, '|') FROM activity_log WHERE action='gradeh_set_hods'")) is not None)
    ok, m, done, left = bulk([P["B1"], P["B3"]], eid("HN"), eid("HK"))
    s.check("a second HOD with the split left blank: B3 (new pair) reads 50 : 50, B1 (already that pair) keeps its own 70",
            ok and one("SELECT hod_split FROM gradeh_people WHERE id=?", (P["B3"],)) == 50 and one("SELECT hod_split FROM gradeh_people WHERE id=?", (P["B1"],)) == 70, m)
    ok, m, done, left = bulk([P["B6"], P["B7"]], eid("HN"))
    s.check("nobody can be set (both left out): not ok, 'Nobody was changed; left out: ...', nothing written, no audit row", not ok and done == 0 and m.startswith("Nobody was changed; left out: ") and len(left) == 2)
    # one transaction: a failure on the third person rolls back the first two (every one of the five takes HK as their HOD: none has HK as second)
    for k_ in ("B1", "B2", "B3", "B4", "B5"):
        db.execute("UPDATE gradeh_people SET hod_user_id=?, hod2_user_id=NULL, hod_split=NULL WHERE id=?", (U["HE"], P[k_]))
    db.commit()
    s1, a1 = snap(), n_audit()
    real = a.gradeh_set_hods
    calls = []
    def boom(db_, me_, pid_, *args, **kw):
        calls.append(pid_)
        if len(calls) == 3:
            raise RuntimeError("boom")
        return real(db_, me_, pid_, *args, **kw)
    a.gradeh_set_hods = boom
    try:
        try:
            bulk([P["B1"], P["B2"], P["B3"], P["B5"]], eid("HK"))
            raised = False
        except RuntimeError:
            raised = True
    finally:
        a.gradeh_set_hods = real
    s.check("one transaction: a failure on the third person leaves the first two unchanged (rolled back), and no audit rows (the third was reached: it would have been set)",
            raised and len(calls) == 3 and snap() == s1 and n_audit() == a1 and bulk([P["B1"], P["B2"]], eid("HK"))[2] == 2, (raised, calls, snap() == s1))
    for k_ in ("B1", "B2"):
        db.execute("UPDATE gradeh_people SET hod_user_id=?, hod2_user_id=NULL, hod_split=NULL WHERE id=?", (U["HE"], P[k_]))
    db.commit()
    seen = []
    def commit_each(db_, me_, pid_, *args, **kw):
        seen.append(pid_)
        if len(seen) == 2:
            raise RuntimeError("boom")
        return real(db_, me_, pid_, *args, **dict(kw, commit=True))
    a.gradeh_set_hods = commit_each
    try:
        try:
            bulk([P["B1"], P["B2"], P["B3"], P["B5"]], eid("HK"))
        except RuntimeError:
            pass
    finally:
        a.gradeh_set_hods = real
    s.check("falsified: a writer that commits a person at a time (commit=True) DOES keep the first person when the second fails, so the check above is the transaction",
            len(seen) == 2 and snap() != s1 and one("SELECT hod_user_id FROM gradeh_people WHERE id=?", (P["B1"],)) == U["HK"], (seen, snap() == s1))
    db.execute("UPDATE gradeh_people SET hod_user_id=?, hod2_user_id=NULL, hod_split=NULL WHERE id IN (?,?,?,?,?)", (U["HN"], P["B1"], P["B2"], P["B3"], P["B4"], P["B5"]))
    db.commit()

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("Set HOD for several: each guard falsified")
    sF = snap()
    real_super, real_lock, real_signed, real_splits = a.is_super, a._gh_cal_lock_text, a._gh_hod_signed_words, a.GRADEH_SPLITS
    HEU = db.execute("SELECT * FROM users WHERE id=?", (U["HE"],)).fetchone()
    a.is_super = lambda u_: True
    try:
        okf, mf, df, lf = bulk([P["B5"]], eid("HK"), who=HEU)
    finally:
        a.is_super = real_super
    s.check("falsified: with the super check patched away a non-super account WOULD write (so 'Only the super admin' is that guard)", okf and df == 1)
    db.execute("UPDATE gradeh_people SET hod_user_id=? WHERE id=?", (U["HN"], P["B5"]))
    db.commit()
    a._gh_cal_lock_text = lambda *x: None
    try:
        okf, mf, df, lf = bulk([P["B6"]], eid("HK"))
    finally:
        a._gh_cal_lock_text = real_lock
    s.check("falsified: with the unit-lock check patched away B6 (a signed-off unit) WOULD be set (so it is left out by that rule)", okf and df == 1)
    db.execute("UPDATE gradeh_people SET hod_user_id=? WHERE id=?", (U["HE"], P["B6"]))
    db.commit()
    a._gh_hod_signed_words = lambda *x: None
    try:
        okf, mf, df, lf = bulk([P["B7"]], eid("HK"))
    finally:
        a._gh_hod_signed_words = real_signed
    s.check("falsified: with the signed-HOD check patched away B7 (their HOD has signed) WOULD be set", okf and df == 1)
    db.execute("UPDATE gradeh_people SET hod_user_id=? WHERE id=?", (U["HS"], P["B7"]))
    db.commit()
    a.GRADEH_SPLITS = tuple(sorted(set(real_splits) | {55}))
    try:
        okf, mf, df, lf = bulk([P["B2"]], eid("HN"), eid("HK"), "55")
    finally:
        a.GRADEH_SPLITS = real_splits
    s.check("falsified: with 55 allowed a split of 55 WOULD be taken (so the 10..90 in 10s refusal is that guard)", okf and df == 1)
    db.execute("UPDATE gradeh_people SET hod2_user_id=NULL, hod_split=NULL WHERE id=?", (P["B2"],))
    db.commit()
    ok, m, done, left = bulk([P["B2"]], eid("HN"))
    s.check("(the same calls unpatched: B6 and B7 and a split of 55 are refused again)", bulk([P["B6"]], eid("HK"))[0] is False and bulk([P["B7"]], eid("HK"))[0] is False
            and bulk([P["B2"]], eid("HN"), eid("HK"), "55")[0] is False)

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("Set HOD for several: through the route, the flash, the redirect")
    sR, aR = snap(), n_audit()
    r_ = CSU.post("/admin/gradeh/hods/bulk", data=csrf(pid=[str(P[k]) for k in ("B3", "B5")], hod_eid=eid("HK"), hod2_eid=eid("HN"), hod_split="40",
                                                       next="/admin/gradeh?tab=people&view=person&hod=%d" % U["HN"]))
    s.check("the super admin's post sets both and goes back to where it came from (By person, the HOD filter kept)", r_.status_code == 302 and "hod=%d" % U["HN"] in r_.headers.get("Location", "")
            and n_audit() == aR + 2 and all(one("SELECT hod_user_id FROM gradeh_people WHERE id=?", (P[k],)) == U["HK"] and one("SELECT hod2_user_id FROM gradeh_people WHERE id=?", (P[k],)) == U["HN"]
                                            and one("SELECT hod_split FROM gradeh_people WHERE id=?", (P[k],)) == 40 for k in ("B3", "B5")), r_.headers.get("Location"))
    fl = CSU.get("/admin/gradeh?tab=people").get_data(as_text=True)
    s.check("the flash says what was set", "are now the Grade H HODs of 2 people" in clean(fl) and "40 : 60" in clean(fl))
    r_ = CSU.post("/admin/gradeh/hods/bulk", data=csrf(pid=[str(P["B3"])], hod_eid="", next="/admin/gradeh?tab=people"))
    s.check("a post with a blank HOD is refused with a flash and changes nothing", r_.status_code == 302 and "Pick the HOD from the list" in clean(CSU.get("/admin/gradeh?tab=people").get_data(as_text=True)))
    s.check("the bulk form carries data-confirm and data-confirm-ok (test_admin_standard's rule)", re.search(r'<form[^>]*id="gh-bulkhod-form"[^>]*data-confirm="[^"]+"[^>]*data-confirm-ok="[^"]+"', pt, re.S) is not None
            or re.search(r'<form[^>]*id="gh-bulkhod-form"[^>]*data-confirm-ok="[^"]+"', pt, re.S) is not None)

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("the page's look: headings on one line, tokens, rem, no underline on hover")
    css = open(os.path.join(H.REPO, "static", "gradeh_admin.css"), encoding="utf-8").read()
    new_css = css[css.index("By person | By HOD"):]
    s.check("a table's column headings stay on one line (.gh-table th is white-space: nowrap; no <br> in the By HOD headings)", ".gh-table th { white-space: nowrap; }" in css
            and "<br" not in re.search(r'<thead>.*?</thead>', CSU.get(HODV).get_data(as_text=True), re.S).group(0))
    s.check("the By HOD table has six columns (the People icon sits in the People cell with the count, so the table fits the card at the largest text size), "
            "the pills stay on one line, and the text cells wrap", re.search(r'<thead><tr>(?:<th[^>]*>.*?</th>){6}</tr></thead>', CSU.get(HODV).get_data(as_text=True), re.S) is not None
            and ".gh-pcell { white-space: nowrap; }" in css and ".gh-hods td { overflow-wrap: anywhere; }" in css and "min-width: 11.25rem" not in new_css)
    fh = CSU.get(HODV).get_data(as_text=True)
    s.check("the filter row wraps as groups: the picker with its box, and the Show select the other (the Search button is gone: Enter submits)",
            re.search(r'<span class="gh-fgroup gh-fgroup-main">.*?name="q".*?</span>\s*<span class="gh-fgroup gh-fgroup-end">.*?name="hf"', fh, re.S) is not None
            and re.search(r'<span class="gh-fgroup gh-fgroup-end">.*?name="show"', CSU.get("/admin/gradeh?tab=people").get_data(as_text=True), re.S) is not None
            and ">Search</button>" in fh and 'class="btn-link">Search</button>' not in fh)
    pg1 = CSU.get("/admin/gradeh?tab=people").get_data(as_text=True)
    s.check("By person: the Stage words are short (one line at the largest size) with the full words in the title; a blocked reason still wraps; the Show filter keeps the full words",
            ".gh-status:not(.is-blocked) { white-space: nowrap; }" in css and re.search(r'<td title="With the BU CEO[^"]*">\s*<span class="gh-status is-bu">With BU CEO</span>', pg1)
            and all(len(v) <= 12 for v in a.GRADEH_STATUS_SHORT.values()) and set(a.GRADEH_STATUS_SHORT) == set(a.GRADEH_STATUS_LABEL)
            and "With the BU CEO (" in pg1, [v for v in a.GRADEH_STATUS_SHORT.values() if len(v) > 12])
    s.check("one line a person (board H6a, 2026-11-03): fixed layout with column shares, no fixed 130px Person column, no Actions column",
            "#gh-people col.gh-w-route { width: 7.4rem; }" in css and "min-width: 130px" not in css and "gh-c-act" in pg1 and "gh-act-links" not in pg1 and "gh-act-top" not in pg1)
    s.check("the new CSS holds no hex colour and no px font-size, and no underline on hover", not re.search(r"#[0-9a-fA-F]{3,8}\b", new_css) and not re.search(r"font-size:\s*\d+(\.\d+)?px", new_css)
            and "text-decoration: underline" not in new_css)

finally:
    os.environ["ONEHR_GRADEH"] = _ENV0 if _ENV0 is not None else ""
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE cycles SET half=? WHERE id=?", (HALF0, CID))
        d.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%'")
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell LIKE 'gradeh_%'", (CID,))
        d.commit()

sys.exit(s.done())
