"""Grade H Appraisal: TWO HODs on one person (2026-11-03; Chris: "HOD A and B needs to calibrate person A"; plan OneHR/Grade H person page and shared HOD plan).

What this suite holds:
  * a person with ONE HOD is read exactly as before (no second HOD: shared False, no HOD list, the HOD's move counts at once, an agreed band only once
    that HOD has signed off; the existing calibration suites run untouched beside this one)
  * a shared person: each HOD's call counts only once THAT HOD has signed off the axis; before anyone signs the HOD level reads the line manager's band;
    one signed call stands alone; two are blended by the split with the normal review's bu_blend_n (exactly halfway takes the LOWER band, 50:50 and the
    70:30 / 30:70 steps); each HOD sees their OWN call on their page, and the other HOD's call as it stands under the row (and what the band will be)
  * the second HOD is in the scope, curve and counts of BOTH HODs, each with that HOD's own band; the two Agree ticks never touch each other
  * a HOD who holds a BU CEO or BG CEO seat holds no Grade H HOD role: the other takes 100%; both without it: the BU CEO covers the person
  * a calibration seat of the NORMAL review (a BU calibration group's calibrator, a Group Chief group's) takes no Grade H HOD role away (Chris,
    2026-11-03, "Yes, allow for Grade H"): two HODs, one of them such a calibrator, are both live at the split; the normal review is unchanged
  * a person who does not agree is never calibrated: no HOD row of either HOD reaches them
  * the BU CEO's stage waits on every HOD of its people, the second HOD included; the BU CEO's summary names both calls
  * a line manager submission after a HOD's sign-off ("late") is judged per HOD
  * the panel's writer (gradeh_set_hods): super admin only; refuses the same person, the person themselves, a leaver, a split with no second HOD, a split outside
    10..90 in 10s, a HOD who has already signed a stage, a locked unit; audited; removing the second HOD keeps the first HOD's agreed band
  * the list import's two columns: quality (errors, worth a look), the Changes counts, the answer a blank cell asks, apply; a file WITHOUT the columns never touches a second HOD
  * the admin list: one HOD line per HOD with its share, the "Shared by two HODs" chip, the Leaders strip only when N > 0, the Show filter, the Excel columns
Each new guard is falsified in the suite itself (a patched twin makes the check fail) or, where it sits inside a writer, by hand (the report names them).
Synthetic (ZZ9SH-*) on a fresh scratch database; the suite puts back what it changes.
"""
import csv
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Grade H Appraisal: two HODs on one person")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, EMP = H.actors(a)
PFX, BG, CO, COB = "ZZ9SH-", "ZZSH Group", "ZZSH Unit A", "ZZSH Unit B"
U, P = {}, {}
_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
BASE = "/calibration/gradeh"
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


def SU_ROW(d):
    return d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()


def csrf(**kw):
    d = {"csrf_token": "tok"}
    d.update(kw)
    return d


def mk(k, grade="H", hod=None, co=CO, dept="ZZSH Dept"):
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
        "job_grade, job_title, hod_id, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?,?,?, 'Driver', ?, '2020-01-01')",
        ((PFX + k).lower(), "ZZ SH " + k, PFX + k, BG, co, dept, grade, hod)).lastrowid


def person(k, perf="ME", pot="Mid", submitted=True, route="B", score=9.0, hod=None, hod2=None, split=None, at="2026-11-10 02:00:00"):
    pid = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route, hod_user_id, hod2_user_id, hod_split) VALUES (?,?,?,?,?,?,?)",
                     (CID, PFX + k, U[k], route, U[hod] if hod else None, U[hod2] if hod2 else None, split)).lastrowid
    P[k] = pid
    db.execute(
        "INSERT INTO gradeh_appraisals (cycle_id, person_id, lm_submitted_at, perf_band, pot_band, perf_rating, perf_value, pot_score, "
        "promo_nominate, b_achievements, b_strengths, b_development, conversation_held) VALUES (?,?,?,?,?,?,?,?, 'no', ?,?,?,1)",
        (CID, pid, at if submitted else None, perf if submitted else None, pot if submitted else None,
         3.2 if route == "B" else 3, None if route == "B" else 95, score, "ZZ-ACH-" + k, "ZZ-STR-" + k, "ZZ-DEV-" + k))
    return pid


def urow(k):
    return db.execute("SELECT * FROM users WHERE id=?", (U[k],)).fetchone()


def mv(k, pid, stage, band, remark="A fair reason."):
    return run(lambda d: a.gradeh_hod_move(d, urow(k), pid, stage, band, remark))


def agree_all(k, stage):
    def f(d):
        rows = a.gradeh_hod_scope(d, U[k], CID)
        ids = [r["id"] for r in rows if not r["disagree_at"]]
        return a.gradeh_hod_agree(d, urow(k), stage, ids, set(ids))
    return run(f)


def hsign(k, stage, reason="A fair reason for this spread."):
    return run(lambda d: a.gradeh_hod_signoff(d, urow(k), stage, reason))


def open_perf(k):
    """Potential signed off: performance opens for this HOD (it never opens before)."""
    agree_all(k, "pot")
    return hsign(k, "pot")


def sign_both(k):
    """Agree everyone not yet decided, then sign potential and performance."""
    out = []
    for stg in ("pot", "perf"):
        agree_all(k, stg)
        out.append(hsign(k, stg))
    return out


def calp(k, as_hod=None):
    """One person as the calibration pages read them (the admin's view when as_hod is None)."""
    def f(d):
        rows = d.execute(a._GH_CAL_SQL + "AND p.id=?", (CID, P[k])).fetchall()
        mvs, rvs, ys = a._gh_cal_load(d, CID, rows)
        return a._gh_cal_person(rows[0], mvs, rvs, ys, show_default=False, as_hod=(U[as_hod] if as_hod else None))
    return run(f)


def scope_ids(k):
    return {r["id"] for r in run(lambda d: a.gradeh_hod_scope(d, U[k], CID))}


def set_pair(k, hod2, split):
    db.execute("UPDATE gradeh_people SET hod2_user_id=?, hod_split=? WHERE id=?", (U[hod2] if hod2 else None, split, P[k]))
    db.commit()


def clear_ticks():
    db.execute("DELETE FROM gradeh_reviews")
    db.execute("DELETE FROM gradeh_hod_reviews")
    db.execute("DELETE FROM gradeh_signoffs")
    db.execute("DELETE FROM gradeh_band_moves")
    db.commit()


if True:
    CID = run(lambda d: a.active_cycle_id(d))
    HALF0 = db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()["half"]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
    db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 1)", (CID,))
    for c_ in (CO, COB):
        db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, c_))
    U["BCA"] = mk("BCA", "21")
    U["BCB"] = mk("BCB", "21", co=COB)
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, U["BCA"]))
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, COB, U["BCB"]))
    for k_ in ("HA", "HB", "HD"):
        U[k_] = mk(k_, "19", hod=U["BCA"], dept="ZZSH Dept " + k_)
    # HC and HE sit in unit B and hold its BU CEO seat: BCB is HC's seat; HE gets one in a third unit so both hold a calibrator seat
    U["HC"] = U["BCB"]
    U["HE"] = mk("HE", "21", co=COB)
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, "ZZSH Unit C", U["HE"]))
    db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, "ZZSH Unit C"))
    U["PLAIN"] = mk("PLAIN", "15")
    # single-HOD people of HA (the baseline) and HB
    for k_ in ("X1", "X2"):
        U[k_] = mk(k_, dept="ZZSH Dept HA")
        person(k_, hod="HA")
    U["Y1"] = mk("Y1", dept="ZZSH Dept HB")
    person("Y1", hod="HB")
    # S1: shared HA / HB 50:50; S2: shared 70:30; S3: shared 30:70
    for k_, sp_ in (("S1", 50), ("S2", 70), ("S3", 30)):
        U[k_] = mk(k_, dept="ZZSH Dept HA")
        person(k_, perf="ME", pot="Mid", hod="HA", hod2="HB", split=sp_)
    # R1: HA and a BU CEO (HC holds the BU seat of unit B: a BU CEO holds no Grade H HOD role); R2: two BU CEOs
    U["R1"] = mk("R1", dept="ZZSH Dept HA")
    person("R1", hod="HA", hod2="HC", split=50)
    U["R2"] = mk("R2", dept="ZZSH Dept HA")
    person("R2", hod="HC", hod2="HE", split=50)
    # D1: shared, does not agree
    U["D1"] = mk("D1", dept="ZZSH Dept HA")
    person("D1", hod="HA", hod2="HB", split=50)
    db.execute("UPDATE gradeh_appraisals SET disagree_at='2026-11-11 02:00:00', acknowledged_at=NULL WHERE person_id=?", (P["D1"],))
    # the journey gives an HOD / BU CEO a Dept / BU view only with someone in the NORMAL review: each seat has a JG 15 report with a KPI
    PID_ = run(lambda d: a.active_pm_period(d)["id"])
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','calibration','pm','tm')")
    for k_ in ("ai_calib", "review_unified"):
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,'1')", (k_,))
    for k_, hod_ in (("RA", "HA"), ("RB", "HB"), ("RBC", "BCA")):
        U[k_] = mk(k_, "15", hod=U[hod_], dept="ZZSH Dept Plain")
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, company) "
                   "SELECT ?,id,'ZZSH KPI',100,'more',business_group,company FROM users WHERE id=?", (PID_, U[k_]))
    db.commit()
    db.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%'")
    db.commit()

C = {k: H.client_as(a, U[k]) for k in U}
CSU = H.client_as(a, SU["id"])
CBGA = H.client_as(a, BGA["id"])
CEMP = H.client_as(a, EMP["id"])
NAV = {"Sec-Fetch-Mode": "navigate"}
_real_avail = a.ai_draft.review_agent_available
a.ai_draft.review_agent_available = lambda: True

try:
    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("one HOD: read exactly as before")
    x1 = calp("X1")
    s.check("a person with no second HOD: not shared, no HOD list, no second id", x1["shared"] is False and x1["hods"] == [] and x1["hod2_id"] is None)
    s.check("...in the scope of their one HOD only", P["X1"] in scope_ids("HA") and P["X1"] not in scope_ids("HB"))
    open_perf("HA")
    ok, _m = mv("HA", P["X1"], "perf", "AE")
    s.check("a HOD's move counts at once, before any sign-off (the HOD level and the HOD's own page read AE)",
            ok and calp("X1")["b_hod"]["perf"] == "AE" and calp("X1", "HA")["b_hod"]["perf"] == "AE")
    clear_ticks()
    agree_all("HA", "pot")
    s.check("an agreed band before the sign-off reads the line manager's band (a tick alone is no sign-off)", calp("X2")["b_hod"]["pot"] == "Mid"
            and one("SELECT COUNT(*) FROM gradeh_reviews WHERE person_id=? AND tier='hod'", (P["X2"],)) == 1
            and one("SELECT COUNT(*) FROM gradeh_hod_reviews WHERE person_id=?", (P["X2"],)) == 0)
    clear_ticks()

    # the one-HOD band order against a verbatim copy of the pre-change picker, over every combination of the facts it reads
    def old_pick(axis, upto, pid, company, lm_band, moves, revs, hod_signs, bu_signs, disagreed):
        ix = a.GRADEH_STAGES.index(upto)
        if ix >= 2:
            m = moves.get((pid, axis, "final"))
            if m:
                return m["band"], "final"
        if disagreed:
            return (lm_band, "lm") if lm_band else (None, None)
        if ix >= 1:
            m = moves.get((pid, axis, "buceo"))
            if m:
                return m["band"], "buceo"
            r = revs.get((pid, axis, "buceo"))
            if r and company in bu_signs:
                return r["band"], "buceo"
        m = moves.get((pid, axis, "hod"))
        if m:
            return m["band"], "hod"
        r = revs.get((pid, axis, "hod"))
        if r and (str(r["by_user_id"]), axis) in hod_signs:
            return r["band"], "hod"
        return (lm_band, "lm") if lm_band else (None, None)
    import itertools
    n_cmp, bad = 0, []
    for upto, lm, dis, hm, ht, hsg, bm, bt, bsg, fm in itertools.product(("hod", "buceo", "final"), ("ME", None), (False, True), ("AE", None), ("UA", None),
                                                                      (False, True), ("OU", None), ("BE", None), (False, True), ("UA", None)):
        moves_ = {}
        revs_ = a._GhRevs()
        if hm:
            moves_[(1, "perf", "hod")] = {"band": hm}
        if bm:
            moves_[(1, "perf", "buceo")] = {"band": bm}
        if fm:
            moves_[(1, "perf", "final")] = {"band": fm}
        if ht:
            revs_[(1, "perf", "hod")] = {"band": ht, "by_user_id": 7}
        if bt:
            revs_[(1, "perf", "buceo")] = {"band": bt, "by_user_id": 8}
        hs_ = {("7", "perf"): "x"} if hsg else {}
        bs_ = {"U": "x"} if bsg else {}
        n_cmp += 1
        if a._gh_band_pick("perf", upto, 1, "U", lm, moves_, revs_, hs_, bs_, dis) != old_pick("perf", upto, 1, "U", lm, moves_, revs_, hs_, bs_, dis):
            bad.append((upto, lm, dis, hm, ht, hsg, bm, bt, bsg, fm))
    s.check("the one-HOD band order is identical to the picker before this change over every combination of its facts (%d)" % n_cmp, not bad and n_cmp == 3 * 2 * 2 * 2 * 2 * 2 * 2 * 2 * 2 * 2, bad[:2])

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("a shared person: each HOD's call counts once THAT HOD has signed off")
    cp = calp("S1")
    s.check("S1 is shared: two live HODs, 50 and 50, the first HOD's share first", cp["shared"] and [(h["id"], h["share"]) for h in cp["hods"]] == [(U["HA"], 50), (U["HB"], 50)],
            cp["hods"])
    s.check("in the scope of BOTH HODs (and of nobody else)", P["S1"] in scope_ids("HA") and P["S1"] in scope_ids("HB") and P["S1"] not in scope_ids("HD"))
    s.check("before anyone signs the HOD level reads the line manager's band", cp["b_hod"] == {"perf": "ME", "pot": "Mid"} and cp["b_fin"]["perf"] == "ME")
    open_perf("HA")
    ok, _m = mv("HA", P["S1"], "perf", "AE")
    s.check("HA moves S1 to AE: HA's own page reads AE at once; the HOD level (nobody has signed) still reads the line manager's ME",
            ok and calp("S1", "HA")["b_hod"]["perf"] == "AE" and calp("S1")["b_hod"]["perf"] == "ME" and calp("S1", "HB")["b_hod"]["perf"] == "ME")
    s.check("...HB sees HA's call as it stands (AE, not signed) in the HODs list", next(h for h in calp("S1", "HB")["hods"] if h["id"] == U["HA"])["perf"] == {"band": "AE", "moved": True, "signed": False})
    agree_all("HA", "perf")
    ok_perf = hsign("HA", "perf")
    s.check("HA signs performance (potential was signed to open it)", ok_perf[0], ok_perf)
    c1 = calp("S1")
    s.check("only HA has signed: HA's call (AE) stands alone, whatever the split", c1["b_hod"]["perf"] == "AE" and c1["b_hod"]["pot"] == "Mid", c1["b_hod"])
    s.check("...and the final band (nobody above) is the HOD level's", c1["b_fin"]["perf"] == "AE")
    agree_all("HB", "pot")
    hsign("HB", "pot")
    s.check("HB signs potential only: potential blends two Mid calls (Mid); performance is still HA alone (AE: HB has not signed that stage)",
            calp("S1")["b_hod"]["pot"] == "Mid" and calp("S1")["b_hod"]["perf"] == "AE")
    agree_all("HB", "perf")
    ok, _m = hsign("HB", "perf")
    c1 = calp("S1")
    s.check("both signed, AE (HA) and ME (HB's agreed LM band) at 50:50: exactly halfway takes the LOWER band, ME", ok and c1["b_hod"]["perf"] == "ME", c1["b_hod"])
    c2, c3 = calp("S2"), calp("S3")
    s.check("S2 (HA 70 : HB 30): HA agreed ME and HB agreed ME: ME", c2["b_hod"]["perf"] == "ME" and c3["b_hod"]["perf"] == "ME")

    s.section("the blend: the split steps, the tie, the lower band")
    def blended(parts, order=None):
        return a.bu_blend_n(parts, order or a.GRADEH_PERF_BANDS)
    s.check("AE 50 / ME 50 -> ME (the tie takes the lower)", blended([("AE", 50), ("ME", 50)]) == "ME")
    s.check("AE 60 / ME 40 -> AE; AE 40 / ME 60 -> ME", blended([("AE", 60), ("ME", 40)]) == "AE" and blended([("AE", 40), ("ME", 60)]) == "ME")
    s.check("OU 70 / UA 30 -> AE (4 x...: 5*.7 + 1*.3 = 3.8 rounds to 4)", blended([("OU", 70), ("UA", 30)]) == "AE")
    s.check("potential: High 50 / Low 50 -> Mid; High 50 / Mid 50 -> Mid (the tie, lower)", blended([("High", 50), ("Low", 50)], a.GRADEH_POT_BANDS) == "Mid"
            and blended([("High", 50), ("Mid", 50)], a.GRADEH_POT_BANDS) == "Mid")
    # now a real shared person with a real disagreement: S2 70:30, HA moves to AE, HB agrees ME -> AE (70% weight); S3 30:70 -> ME
    clear_ticks()
    open_perf("HA")
    for k_ in ("S2", "S3"):
        mv("HA", P[k_], "perf", "AE")
    for k_ in ("HA", "HB"):
        if k_ == "HB":
            open_perf("HB")
        agree_all(k_, "perf")
        hsign(k_, "perf", "A fair reason for this spread.")
    s.check("S2 (70 : 30): HA's AE vs HB's ME -> AE; S3 (30 : 70): the same calls -> ME; S1 (50 : 50) was ME",
            calp("S2")["b_hod"]["perf"] == "AE" and calp("S3")["b_hod"]["perf"] == "ME", (calp("S2")["b_hod"], calp("S3")["b_hod"]))
    s.check("...HA's own page still reads AE for S2 (their own call), HB's reads ME",
            calp("S2", "HA")["b_hod"]["perf"] == "AE" and calp("S2", "HB")["b_hod"]["perf"] == "ME")
    # falsify the tie rule: a half-up blend flips S1's result
    real = a.bu_blend_n
    def half_up(parts, order):
        o = list(order)
        ps = [(o.index(b), w) for b, w in parts if b in o and (w or 0) > 0]
        x = sum(i * w for i, w in ps) / float(sum(w for _i, w in ps))
        return o[int(x + 0.5)]
    # S1 has no AE call now (clear_ticks): build one on S1 and read it twice
    a.bu_blend_n = half_up
    try:
        s.check("falsified: with a half-up blend 50 : 50 AE / ME reads AE, so the tie check above can fail", a.bu_blend_n([("AE", 50), ("ME", 50)], a.GRADEH_PERF_BANDS) == "AE")
    finally:
        a.bu_blend_n = real

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("only one signed / neither signed, with the stage's own words")
    clear_ticks()
    mv("HB", P["S1"], "pot", "High")
    s.check("neither signed: the HOD level reads the line manager's band even though HB moved S1 (their own page reads High)",
            calp("S1")["b_hod"]["pot"] == "Mid" and calp("S1", "HB")["b_hod"]["pot"] == "High" and calp("S1", "HA")["b_hod"]["pot"] == "Mid")
    agree_all("HB", "pot")
    ok, m = hsign("HB", "pot")
    s.check("HB signs potential: only HB has signed, so HB's High stands alone (also if HA never signs)", ok and calp("S1")["b_hod"]["pot"] == "High", (m, calp("S1")["b_hod"]))
    # falsify: ignore the 'signed' condition
    real_lvl = a._gh_hod_level
    def unsigned_counts(axis, pid, slots, revs, hs, as_hod=None):
        return real_lvl(axis, pid, slots, revs, {(str(h), axis): 1 for h, _sh in slots}, as_hod)
    a._gh_hod_level = unsigned_counts
    try:
        clear_ticks()
        mv("HB", P["S1"], "pot", "High")
        s.check("falsified: if an unsigned move counted, the HOD level would read High before any sign-off (so the check above is the rule)", calp("S1")["b_hod"]["pot"] == "High")
    finally:
        a._gh_hod_level = real_lvl
    clear_ticks()

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("the ticks are each HOD's own; the curve counts a shared person in both pools")
    agree_all("HA", "pot")
    s.check("HA's Agree writes HA's own row for S1 (gradeh_hod_reviews), none for HB", one("SELECT COUNT(*) FROM gradeh_hod_reviews WHERE person_id=? AND by_user_id=?", (P["S1"], U["HA"])) == 1
            and one("SELECT COUNT(*) FROM gradeh_hod_reviews WHERE person_id=? AND by_user_id=?", (P["S1"], U["HB"])) == 0)
    agree_all("HB", "pot")
    s.check("HB's tick is a second row: both HODs hold their own", one("SELECT COUNT(*) FROM gradeh_hod_reviews WHERE person_id=?", (P["S1"],)) == 2)
    run(lambda d: a.gradeh_hod_agree(d, urow("HB"), "pot", [P["S1"]], set()))
    s.check("HB unticks: only HB's row goes, HA's stays", one("SELECT COUNT(*) FROM gradeh_hod_reviews WHERE person_id=? AND by_user_id=?", (P["S1"], U["HA"])) == 1
            and one("SELECT COUNT(*) FROM gradeh_hod_reviews WHERE person_id=? AND by_user_id=?", (P["S1"], U["HB"])) == 0)
    clear_ticks()
    open_perf("HA")
    open_perf("HB")
    va = run(lambda d: a.gradeh_hod_view(d, urow("HA"), CID, "perf"))
    vb = run(lambda d: a.gradeh_hod_view(d, urow("HB"), CID, "perf"))
    ids_a = {r["id"] for r in va["rows"]}
    ids_b = {r["id"] for r in vb["rows"]}
    s.check("S1, S2, S3 are rows on BOTH HODs' pages; D1 too (shown, not calibrated); Y1 only HB's, X1 only HA's",
            {P["S1"], P["S2"], P["S3"], P["D1"]} <= ids_a & ids_b and P["Y1"] in ids_b - ids_a and P["X1"] in ids_a - ids_b)
    mv("HA", P["S1"], "perf", "AE")
    va = run(lambda d: a.gradeh_hod_view(d, urow("HA"), CID, "perf"))
    vb = run(lambda d: a.gradeh_hod_view(d, urow("HB"), CID, "perf"))
    s.check("the curve counts S1 in BOTH pools, each with that HOD's own band (HA: AE; HB: ME)",
            va["curve"]["dist"]["AE"] == 1 and vb["curve"]["dist"]["AE"] == 0 and vb["curve"]["dist"]["ME"] >= 1
            and va["curve"]["total"] == len([r for r in va["rows"] if not r["dis"]]), (va["curve"]["dist"], vb["curve"]["dist"]))
    rb = next(r for r in vb["rows"] if r["id"] == P["S1"])
    s.check("HB's row for S1 carries the other HOD's call, as it stands, and what the HOD band will be",
            rb["shared"] and rb["shared"]["band"] == "AE" and rb["shared"]["state"] == "not signed off yet" and rb["shared"]["will"].endswith("ME")
            and "exactly halfway takes the lower band" in rb["shared"]["will_why"] and rb["shared"]["chip"] == "Shared 50 : 50", rb["shared"])
    ra = next(r for r in va["rows"] if r["id"] == P["S1"])
    s.check("HA's own row reads HA's own call (AE) and a 'moved' mark", ra["hod_band"] == "AE" and ra["moved"] and ra["shared"]["band"] == "" and ra["shared"]["state"] == "no call yet", ra["shared"])
    s.check("a person with one HOD has no shared line", next(r for r in va["rows"] if r["id"] == P["X1"])["shared"] is None)
    pa, pb = text(C["HA"].get(BASE + "/hod?stage=perf")), text(C["HB"].get(BASE + "/hod?stage=perf"))
    s.check("the HOD page draws the chip and the line under the row (words only; the band is the server's)",
            "Shared 50 : 50" in pb and "ZZ SH HA" in pb and "not signed off yet" in pb and "Their HOD band once you both sign off" in pb and "Shared 50 : 50" in pa)
    clear_ticks()

    # falsify the second slot of the scope
    real_scope = a._GH_HOD_SCOPE_SQL
    one_slot = ("AND p.user_id != ? AND ((" + a._GH_HOD_SQL + "=?" + a._GH_CAL_NOT_BU + ") OR (0 AND ?=?)) ")
    a._GH_HOD_SCOPE_SQL = one_slot.replace("(0 AND ?=?)", "(0 AND ?>-1)")
    try:
        s.check("falsified: with only the first slot in the scope, the second HOD's scope loses S1", P["S1"] not in scope_ids("HB"))
    finally:
        a._GH_HOD_SCOPE_SQL = real_scope
    s.check("...and it is back", P["S1"] in scope_ids("HB"))

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("a HOD who holds a BU CEO seat holds no Grade H HOD role")
    r1 = calp("R1")
    s.check("R1 (HA and a BU CEO): not shared, HA at 100%, HA's scope has them, the BU CEO's has not",
            not r1["shared"] and [(h["id"], h["share"]) for h in r1["hods"]] == [(U["HA"], 100)] and P["R1"] in scope_ids("HA") and P["R1"] not in scope_ids("HC"), r1["hods"])
    mv("HA", P["R1"], "pot", "High")
    agree_all("HA", "pot")
    hsign("HA", "pot")
    s.check("HA's signed call stands alone at 100% (High)", calp("R1")["b_hod"]["pot"] == "High")
    r2 = calp("R2")
    s.check("R2 (two BU CEOs): nobody's HOD, not in either scope, no HOD list: the BU CEO covers them",
            not r2["shared"] and r2["hods"] == [] and P["R2"] not in scope_ids("HC") and P["R2"] not in scope_ids("HE") and r2["b_hod"]["pot"] == "Mid")
    pe = {p_["pid"]: p_ for p_ in run(lambda d: a.gradeh_admin_people(d, CID))}
    s.check("the admin list agrees: R1 has one HOD line, R2 none (BU CEO covers), S1 two", len(pe[P["R1"]]["hods"]) == 1 and not pe[P["R1"]]["shared"]
            and not pe[P["R2"]]["hod_stage"] and pe[P["S1"]]["shared"] and len(pe[P["S1"]]["hods"]) == 2)
    clear_ticks()

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("a calibration seat of the normal review is no bar in Grade H (Chris, 2026-11-03)")
    clear_ticks()
    U["CALA"] = mk("CALA", "19", dept="ZZSH Dept CALA")      # a BU calibration group's calibrator
    U["CALG"] = mk("CALG", "19", dept="ZZSH Dept CALG")      # a Group Chief group's calibrator
    U["BGCX"] = mk("BGCX", "21")                              # a BG CEO (the column)
    db.execute("UPDATE users SET bgceo_bg=? WHERE id=?", (BG, U["BGCX"]))
    cgid = db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id) VALUES (?,?,?,?)", (BG, CO, "ZZSH Panel", U["CALA"])).lastrowid
    db.execute("INSERT INTO calib_bu_group_units(group_id, business_group, company, department) VALUES (?,?,?,?)", (cgid, BG, CO, "ZZSH Dept CALA"))
    pgid = db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES ('ZZSH GC GROUP', ?)", (U["CALG"],)).lastrowid
    for k_, hod_, hod2_, sp_ in (("Q1", "HA", "CALA", 50), ("Q2", "CALG", "HB", 70), ("Q3", "CALA", None, None), ("Q4", "HA", "BGCX", 50), ("Q5", "CALA", "CALG", 50)):
        U[k_] = mk(k_, dept="ZZSH Dept HA")
        person(k_, perf="ME", pot="Mid", hod=hod_, hod2=hod2_, split=sp_)
    db.commit()
    gh_role = lambda k: run(lambda d: (a.hod_has_role(d, U[k]), a.gradeh_hod_has_role(d, U[k])))   # (normal review, Grade H)
    s.check("the normal review is UNCHANGED: both calibrators still hold no HOD role there (hod_has_role, _hod_ids_with_review)",
            gh_role("CALA")[0] is False and gh_role("CALG")[0] is False and gh_role("BGCX")[0] is False and gh_role("BCA")[0] is False
            and run(lambda d: a._hod_ids_with_review(d, [U["CALA"], U["CALG"], U["HA"]])) == [U["HA"]])
    s.check("in Grade H a calibrator holds the HOD role; a BU CEO and a BG CEO do not; an ordinary HOD does",
            gh_role("CALA")[1] and gh_role("CALG")[1] and not gh_role("BGCX")[1] and not gh_role("BCA")[1] and not gh_role("HC")[1] and gh_role("HA")[1])
    s.check("...and the seat kinds are one read: _hod_review_holders is the union of the CEO ids and the calibrator ids",
            run(lambda d: a._hod_review_holders(d) == (a._hod_seat_kinds(d)[0] | a._hod_seat_kinds(d)[1])
                and U["CALA"] in a._hod_seat_kinds(d)[1] and U["CALA"] not in a._hod_seat_kinds(d)[0]
                and U["CALG"] in a._hod_seat_kinds(d)[1] and U["BGCX"] in a._hod_seat_kinds(d)[0] and U["BCA"] in a._hod_seat_kinds(d)[0]))
    can = lambda k: run(lambda d: a.gradeh_hod_can(d, urow(k)))
    s.check("a BU calibration group's calibrator named as Grade H HOD: the person is in their scope and gradeh_hod_can is true",
            P["Q3"] in scope_ids("CALA") and can("CALA"))
    s.check("a Group Chief group's calibrator named as Grade H HOD: likewise", P["Q2"] in scope_ids("CALG") and can("CALG"))
    s.check("a BU CEO seat holder named as Grade H HOD (R1's second HOD) gets nobody and has no HOD ability: the BU CEO covers",
            scope_ids("HC") == set() and not can("HC"))
    s.check("a BG CEO named as Grade H HOD gets nobody; the other HOD (HA) takes Q4 at 100%",
            scope_ids("BGCX") == set() and not can("BGCX") and P["Q4"] in scope_ids("HA")
            and [(h["id"], h["share"]) for h in calp("Q4")["hods"]] == [(U["HA"], 100)] and not calp("Q4")["shared"])
    q1, q2, q5 = calp("Q1"), calp("Q2"), calp("Q5")
    s.check("two HODs, one a calibrator (HA 50 : CALA 50): both live at the split (was: HA at 100%), shared, in both scopes",
            q1["shared"] and [(h["id"], h["share"]) for h in q1["hods"]] == [(U["HA"], 50), (U["CALA"], 50)]
            and P["Q1"] in scope_ids("HA") and P["Q1"] in scope_ids("CALA"), q1["hods"])
    s.check("...the same at 70 : 30 with the calibrator first (CALG 70 : HB 30), and two calibrators (CALA 50 : CALG 50)",
            q2["shared"] and [(h["id"], h["share"]) for h in q2["hods"]] == [(U["CALG"], 70), (U["HB"], 30)]
            and q5["shared"] and [(h["id"], h["share"]) for h in q5["hods"]] == [(U["CALA"], 50), (U["CALG"], 50)], (q2["hods"], q5["hods"]))
    pe = {p_["pid"]: p_ for p_ in run(lambda d: a.gradeh_admin_people(d, CID))}
    s.check("the admin list agrees (HOD stage, Shared chip, two HOD lines); no 'no HOD' row for a calibrator's person",
            pe[P["Q1"]]["shared"] and len(pe[P["Q1"]]["hods"]) == 2 and pe[P["Q3"]]["hod_stage"] and not pe[P["Q3"]]["shared"]
            and pe[P["Q4"]]["hod_stage"] and not pe[P["Q4"]]["shared"])
    s.check("the BU CEO's wait lists the calibrator as an HOD of the unit (their stage is real now)",
            U["CALA"] in {h_["id"] for h_ in run(lambda d: a.gradeh_unit_signoff_state(d, CID, CO))["hods"]})
    s.check("the Grade H notice's audience keeps a calibrator and drops a BU CEO / BG CEO (_gh_hod_ids_with_role); the normal review's filter drops all three",
            run(lambda d: a._gh_hod_ids_with_role(d, [U["CALA"], U["CALG"], U["BGCX"], U["BCA"], U["HA"]])) == [U["CALA"], U["CALG"], U["HA"]]
            and run(lambda d: a._hod_ids_with_review(d, [U["CALA"], U["CALG"], U["BGCX"], U["BCA"], U["HA"]])) == [U["HA"]])
    # the calibrator's signed call counts, blended with the other HOD's
    open_perf("HA")
    open_perf("CALA")
    mv("CALA", P["Q1"], "perf", "AE")
    mv("HA", P["Q1"], "perf", "OU")
    for k_ in ("HA", "CALA"):
        agree_all(k_, "perf")
        hsign(k_, "perf")
    s.check("both sign: Q1's HOD band is the blend of OU (HA 50) and AE (CALA 50): exactly halfway takes the lower band, AE; CALA's own page reads AE",
            calp("Q1")["b_hod"]["perf"] == "AE" and calp("Q1", "CALA")["b_hod"]["perf"] == "AE" and calp("Q1", "HA")["b_hod"]["perf"] == "OU", calp("Q1")["b_hod"])
    # the Grade H HOD page opens for the calibrator and lists their people
    r_ = H.client_as(a, U["CALA"]).get(BASE + "/hod")
    s.check("the calibrator's Grade H HOD page opens (200); a BU CEO's and a BG CEO's do not (404)",
            r_.status_code == 200 and H.client_as(a, U["BGCX"]).get(BASE + "/hod").status_code == 404 and C["HC"].get(BASE + "/hod").status_code == 404, r_.status_code)
    s.check("a calibrator has no Department Review, so their Grade H entry is the dashboard's Your next step (gradeh_hod_only); a BG CEO has no Grade H HOD entry",
            run(lambda d: bool(a.gradeh_hod_only(d, urow("CALA")))) and run(lambda d: not a.gradeh_hod_only(d, urow("BGCX"))))
    # falsify: the twin blind to the calibrator kind (the old rule) / the twin blind to everyone
    real_twin = a.gradeh_hod_has_role
    a.gradeh_hod_has_role = lambda db_, hid_: bool(hid_) and a.hod_has_role(db_, hid_)   # the old rule
    try:
        old_scope, old_can = scope_ids("CALA"), can("CALA")
        old_q1 = calp("Q1")
    finally:
        a.gradeh_hod_has_role = real_twin
    s.check("falsified (the old rule): with the twin asking hod_has_role, the calibrator has no scope, no ability and Q1 is HA at 100%, so the checks above reached their guard",
            old_scope == set() and not old_can and not old_q1["shared"] and [(h["id"], h["share"]) for h in old_q1["hods"]] == [(U["HA"], 100)])
    a.gradeh_hod_has_role = lambda db_, hid_: bool(hid_)   # blind: everyone, a BU CEO and a BG CEO too
    try:
        blind = (scope_ids("BGCX"), can("BGCX"), can("HC"))
    finally:
        a.gradeh_hod_has_role = real_twin
    s.check("falsified (blind twin): a BG CEO and a BU CEO would be Grade H HODs again, so the BU CEO / BG CEO checks above reached their guard",
            blind[0] != set() and blind[1] and blind[2], blind)
    s.check("...and restored", not can("BGCX") and not can("HC") and can("CALA"))
    # put back: the rows this section added
    clear_ticks()
    ids_ = [P.pop(k_) for k_ in ("Q1", "Q2", "Q3", "Q4", "Q5")]
    for pid_ in ids_:
        db.execute("DELETE FROM gradeh_appraisals WHERE person_id=?", (pid_,))
        db.execute("DELETE FROM gradeh_people WHERE id=?", (pid_,))
    db.execute("DELETE FROM calib_bu_group_units WHERE group_id=?", (cgid,))
    db.execute("DELETE FROM calib_bu_groups WHERE id=?", (cgid,))
    db.execute("DELETE FROM pm_calibration_groups WHERE id=?", (pgid,))
    db.execute("UPDATE users SET bgceo_bg=NULL WHERE id=?", (U["BGCX"],))
    db.commit()
    for k_ in ("Q1", "Q2", "Q3", "Q4", "Q5", "CALA", "CALG", "BGCX"):
        db.execute("DELETE FROM users WHERE id=?", (U.pop(k_),))
    db.commit()
    s.check("...put back: no calibrator or Q person left behind", one("SELECT COUNT(*) FROM calib_bu_groups WHERE name='ZZSH Panel'") == 0
            and one("SELECT COUNT(*) FROM pm_calibration_groups WHERE name='ZZSH GC GROUP'") == 0 and one("SELECT COUNT(*) FROM users WHERE username LIKE 'zz9sh-q%'") == 0)

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("ONE live HOD on a person with a second HOD set: read as a one-HOD person")
    for k_, h1_, h2_ in (("L1", "HA", "BCB"), ("L2", "BCB", "HB"), ("L3", "HA", "BCA")):   # a BU CEO second / a BU CEO first / the unit's BU CEO second
        U[k_] = mk(k_, dept="ZZSH Dept HA")
        person(k_, hod=h1_, hod2=h2_, split=50)
    clear_ticks()
    open_perf("HA")
    open_perf("HB")
    mv("HA", P["L1"], "perf", "AE")
    mv("HB", P["L2"], "perf", "OU")
    mv("HA", P["L3"], "perf", "BE")
    l1, l2, l3 = calp("L1"), calp("L2"), calp("L3")
    s.check("L1 (HA + a BU CEO): one live HOD at 100%, not shared; HA's UNSIGNED move is the HOD level at once, as for one HOD",
            not l1["shared"] and [(h["id"], h["share"]) for h in l1["hods"]] == [(U["HA"], 100)] and l1["b_hod"]["perf"] == "AE" and l1["hod_moved"]["perf"] and l1["hod_done"]["perf"]
            and run(lambda d: a.gradeh_band_at(d, CID, P["L1"], "perf", "final")) == ("AE", "hod"), (l1["b_hod"], l1["hods"]))
    s.check("L2 (a BU CEO first, HB second): HB takes 100%, HB's unsigned move counts at once", not l2["shared"] and [(h["id"], h["share"]) for h in l2["hods"]] == [(U["HB"], 100)]
            and l2["b_hod"]["perf"] == "OU" and P["L2"] in scope_ids("HB") and P["L2"] not in scope_ids("HC"), (l2["b_hod"], l2["hods"]))
    s.check("L3 (HA + the unit's own BU CEO as second): the BU CEO takes no HOD stage; HA alone, an unsigned move counts at once", not l3["shared"] and l3["b_hod"]["perf"] == "BE"
            and [h["id"] for h in l3["hods"]] == [U["HA"]] and P["L3"] not in scope_ids("BCA"))
    s.check("...their own page and the admin list agree (the HOD sees AE; the list shows one HOD line, no Shared chip)", calp("L1", "HA")["b_hod"]["perf"] == "AE"
            and (lambda pe: len(pe["hods"]) == 1 and not pe["shared"] and pe["hods"][0]["share"] == 100)({p_["pid"]: p_ for p_ in run(lambda d: a.gradeh_admin_people(d, CID))}[P["L1"]]))
    clear_ticks()
    open_perf("HA")
    agree_all("HA", "perf")
    before = calp("L1")["b_hod"]["perf"]
    hsign("HA", "perf")
    s.check("   L1: unsigned tick reads ME (the line manager's), signed tick reads ME as agreed (hod source)", before == "ME" and run(lambda d: a.gradeh_band_at(d, CID, P["L1"], "perf", "hod")) == ("ME", "hod"))
    # the BU CEO waits for the one live HOD only: a BU CEO second HOD never holds the unit
    s.check("the BU CEO's wait counts only the live HOD for L1 (a BU CEO second HOD is no HOD to wait for)", run(lambda d: [h for h in a._gh_row_hods(
        d, d.execute(a._GH_CAL_SQL + "AND p.id=?", (CID, P["L1"])).fetchone(), a._gh_seat_pairs(d))]) == [U["HA"]])
    # falsify: without the one-live-HOD rule the unsigned move would not count
    clear_ticks()
    open_perf("HA")
    mv("HA", P["L1"], "perf", "AE")
    real_lvl2 = a._gh_hod_level
    def old_level(axis, pid, slots, revs, hs, as_hod=None):
        order = a.GRADEH_PERF_BANDS if axis == "perf" else a.GRADEH_POT_BANDS
        if as_hod and any(h == as_hod for h, _sh in slots):
            return real_lvl2(axis, pid, slots, revs, hs, as_hod)
        parts = [(b, sh) for h, sh in slots for b in [a._gh_call(revs, pid, axis, h)] if b and (str(h), axis) in hs]
        return a.bu_blend_n(parts, order) if parts else None
    a._gh_hod_level = old_level
    try:
        s.check("falsified: without the one-live-HOD rule L1's unsigned move reads the line manager's ME (so the check above is the rule)", calp("L1")["b_hod"]["perf"] == "ME")
    finally:
        a._gh_hod_level = real_lvl2
    s.check("...and it is back", calp("L1")["b_hod"]["perf"] == "AE")
    clear_ticks()

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("a person who does not agree is never calibrated")
    d1 = calp("D1")
    s.check("D1 (shared, disagrees): in both scopes but the HOD level reads the line manager's band", d1["disagree"] and d1["b_hod"] == {"perf": "ME", "pot": "Mid"})
    ok, m = mv("HA", P["D1"], "perf", "AE")
    s.check("a move for D1 is refused", not ok and "does not agree" in m, m)
    # a stray tick and a signed stage cannot reach them
    db.execute("INSERT INTO gradeh_hod_reviews(cycle_id, person_id, axis, by_user_id, band) VALUES (?,?,?,?,?)", (CID, P["D1"], "perf", U["HA"], "OU"))
    db.execute("INSERT INTO gradeh_signoffs(cycle_id, tier, stage, scope_key, signed_by) VALUES (?, 'hod', 'perf', ?, ?)", (CID, str(U["HA"]), U["HA"]))
    db.commit()
    s.check("...a stray HOD row and a signed stage change nothing for them (both HODs)", calp("D1")["b_hod"]["perf"] == "ME" and calp("D1", "HA")["b_hod"]["perf"] == "ME"
            and run(lambda d: a.gradeh_effective_band(d, CID, P["D1"], "perf")) == ("ME", "lm"))
    clear_ticks()

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("the BU CEO waits on every HOD of its people, the second HOD included")
    def bu_open():
        return run(lambda d: a.gradeh_bu_open_for(d, CID, CO, BG))
    db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES('gradeh_bu_fallback_at', '\"2099-01-01 00:00\"')")
    db.commit()
    run(lambda d: a.gradeh_set_setting(d, a.GRADEH_BU_FALLBACK, "2099-01-01 00:00", None))
    # everyone in unit A: X1 X2 (HA), S1 S2 S3 D1 (HA + HB), R1 (HA), R2 (BU CEO covers), Y1 (HB)
    for k_ in ("HA",):
        sign_both(k_)
    o1 = bu_open()
    s.check("HA signed both, HB none: the shared people are not done (Y1 and S1..S3 wait on HB), so the unit is not open", not o1["open"] and o1["done"] < o1["total"], o1)
    st1 = run(lambda d: a.gradeh_unit_signoff_state(d, CID, CO))
    hb = next((h for h in st1["hods"] if h["id"] == U["HB"]), None)
    s.check("the unit state lists HB as a HOD of the unit with the shared people counted (S1, S2, S3, Y1 = 4; D1 is shown too)", hb and hb["n"] >= 4 and not hb["done"] and "ZZ SH HB" in st1["blocking"], hb)
    sign_both("HB")
    o2 = bu_open()
    s.check("HB signs both: everyone is done, the unit opens", o2["open"] and o2["done"] == o2["total"], o2)
    real_rows = a._gh_row_hods
    a._gh_row_hods = lambda db_, r, seats: [h for h in real_rows(db_, r, seats)][:1]
    try:
        # falsify: only the first HOD counted -> HB's missing sign-off would not hold the unit
        db.execute("DELETE FROM gradeh_signoffs WHERE scope_key=?", (str(U["HB"]),))
        db.commit()
        o3 = bu_open()
    finally:
        a._gh_row_hods = real_rows
    o4 = bu_open()
    s.check("falsified: counting only the first HOD, the shared people read as done although HB has not signed (so the check above is the second HOD's)", o3["done"] > o4["done"], (o3, o4))
    s.check("...and with both HODs counted again the unit waits for HB", not o4["open"])
    db.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%'")
    clear_ticks()

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("the BU CEO's summary names both calls")
    open_perf("HA")
    mv("HA", P["S1"], "perf", "AE")
    agree_all("HA", "perf")
    hsign("HA", "perf")
    vu = run(lambda d: a.gradeh_unit_view(d, urow("BCA"), CID, CO, pid=P["S1"], tab="sum"))
    it = vu["person"]["item"]
    s.check("the person's item carries both HODs with share, band and signed state", [h["share"] for h in it["hods"]] == [50, 50]
            and it["hods"][0]["perf"].endswith("AE") and it["hods"][0]["perf_signed"] and not it["hods"][1]["perf_signed"], it["hods"])
    pg = text(C["BCA"].get(BASE + "/unit?unit=%s&p=%d&tab=sum" % (CO.replace(" ", "+"), P["S1"])))
    s.check("the summary reads 'HOD · shared' and each HOD with its share and state", "HOD · shared" in pg and "ZZ SH HA · 50%" in pg and "signed off" in pg and "ZZ SH HB · 50%" in pg, pg[:600])
    s.check("a single-HOD person's summary says plain 'HOD'", "HOD · shared" not in text(C["BCA"].get(BASE + "/unit?unit=%s&p=%d&tab=sum" % (CO.replace(" ", "+"), P["X1"]))))
    clear_ticks()

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("late is judged per HOD")
    sign_both("HA")
    db.execute("UPDATE gradeh_signoffs SET signed_at='2026-11-01 02:00:00' WHERE scope_key=?", (str(U["HA"]),))
    db.commit()
    sign_both("HB")
    db.execute("UPDATE gradeh_signoffs SET signed_at='2026-11-20 02:00:00' WHERE scope_key=?", (str(U["HB"]),))
    db.commit()
    s.check("the line manager submitted 10 Nov: after HA's sign-off (1 Nov) and before HB's (20 Nov)", True)
    s.check("HA's page: late for S1; HB's page: not late; the unit-wide readers: late (a HOD's call was fixed first)",
            calp("S1", "HA")["late"]["hod"] and not calp("S1", "HB")["late"]["hod"] and calp("S1")["late"]["hod"] and calp("S1")["late_by"] == {U["HA"]: True})
    clear_ticks()

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("the writer: Set Grade H HODs")
    def setp(k, hod=None, hod2=None, split=None, clear2=False):
        return run(lambda d: a.gradeh_set_hods(d, SU_ROW(d), P[k], hod, hod2, split, clear2))
    U["N1"] = mk("N1", dept="ZZSH Dept HA")
    person("N1", hod="HA")
    U["LFT"] = mk("LFT", "19", hod=U["BCA"])
    db.execute("UPDATE users SET left_at=datetime('now') WHERE id=?", (U["LFT"],))
    db.commit()
    eid = lambda k: PFX + k
    s.check("the employee and a BG admin cannot post it: not a 200", CEMP.post("/admin/gradeh/hods", data=csrf(pid=P["N1"], hod2_eid=eid("HB"))).status_code in (302, 403)
            and CBGA.post("/admin/gradeh/hods", data=csrf(pid=P["N1"], hod2_eid=eid("HB"))).status_code in (302, 403)
            and one("SELECT hod2_user_id FROM gradeh_people WHERE id=?", (P["N1"],)) is None)
    s.check("the route is classed super in the access map", a.admin_access_need("admin_gradeh_hods", {}) == "super")
    ok, m = run(lambda d: a.gradeh_set_hods(d, urow("HA"), P["N1"], None, eid("HB"), None))
    s.check("a non-super account is refused by the writer itself", not ok and "Only the super admin" in m, m)
    cases = [("the same person as the HOD", dict(hod2=eid("HA")), "same person as the HOD"),
             ("the person themselves", dict(hod2=eid("N1")), "own HOD"),
             ("a leaver", dict(hod2=eid("LFT")), "isn't an active member"),
             ("an Employee ID nobody has", dict(hod2="NOPE-1"), "isn't an active member"),
             ("a split with no second HOD", dict(split="60"), "needs a second HOD"),
             ("a split of 55", dict(hod2=eid("HB"), split="55"), "10 to 90"),
             ("a split of 100", dict(hod2=eid("HB"), split="100"), "10 to 90"),
             ("a split of 0", dict(hod2=eid("HB"), split="0"), "10 to 90"),
             ("a split of 'half'", dict(hod2=eid("HB"), split="half"), "10 to 90"),
             ("removing a second HOD that is not there", dict(clear2=True), "no second Grade H HOD"),
             ("a pick and a removal together", dict(hod2=eid("HB"), clear2=True), "not both")]
    for label, kw, want in cases:
        ok, m = setp("N1", **kw)
        s.check("refused: %s" % label, not ok and want in m and one("SELECT hod2_user_id FROM gradeh_people WHERE id=?", (P["N1"],)) is None, m)
    n_audit = one("SELECT COUNT(*) FROM activity_log WHERE action='gradeh_set_hods'")
    ok, m = setp("N1", hod2=eid("HB"), split="60")
    row = db.execute("SELECT hod2_user_id, hod_split FROM gradeh_people WHERE id=?", (P["N1"],)).fetchone()
    s.check("a second HOD with a 60 : 40 split is set, naming both and the split", ok and row["hod2_user_id"] == U["HB"] and row["hod_split"] == 60 and "ZZ SH HA" in m and "ZZ SH HB" in m and "60 : 40" in m, m)
    s.check("...with one audit row naming both HODs and both shares", one("SELECT COUNT(*) FROM activity_log WHERE action='gradeh_set_hods'") == n_audit + 1
            and re.search(r"ZZ SH HA .* 60% and ZZ SH HB .* 40%", one("SELECT detail FROM activity_log WHERE action='gradeh_set_hods' ORDER BY id DESC LIMIT 1")))
    ok, m = setp("N1", hod2=eid("HB"))
    s.check("the same pair again with nothing new: nothing to change", not ok and "Nothing to change" in m, m)
    ok, m = setp("N1", split="30")
    s.check("a split alone moves the pair's split", ok and one("SELECT hod_split FROM gradeh_people WHERE id=?", (P["N1"],)) == 30, m)
    ok, m = setp("N1", hod2=eid("HD"))
    s.check("another second HOD replaces the first one (split kept at 50 for a new pick)", ok and one("SELECT hod2_user_id FROM gradeh_people WHERE id=?", (P["N1"],)) == U["HD"]
            and one("SELECT hod_split FROM gradeh_people WHERE id=?", (P["N1"],)) == 50, m)
    ok, m = run(lambda d: a.gradeh_set_hod(d, SU_ROW(d), P["N1"], eid("HD")))
    s.check("the older Set HOD writer refuses the account that is already the second HOD", not ok and "second Grade H HOD" in m, m)
    # signed
    sign_both("HB")
    ok, m = setp("N1", hod2=eid("HB"))
    s.check("refused: a HOD who has already signed a Grade H stage cannot take another person on", not ok and "already signed off" in m, m)
    clear_ticks()
    sign_both("HD")
    ok, m = setp("N1", clear2=True)
    s.check("...and removing a second HOD who has signed is refused too", not ok and "already signed off" in m and one("SELECT hod2_user_id FROM gradeh_people WHERE id=?", (P["N1"],)) == U["HD"], m)
    clear_ticks()
    ok, m = setp("N1", clear2=True)
    s.check("a second HOD is removed: one HOD again, split cleared", ok and one("SELECT hod2_user_id FROM gradeh_people WHERE id=?", (P["N1"],)) is None
            and one("SELECT hod_split FROM gradeh_people WHERE id=?", (P["N1"],)) is None and "one Grade H HOD again" in m, m)
    # locked unit
    db.execute("INSERT INTO gradeh_signoffs(cycle_id, tier, stage, scope_key, signed_by) VALUES (?, 'buceo', 'all', ?, ?)", (CID, CO, U["BCA"]))
    db.commit()
    ok, m = setp("N1", hod2=eid("HB"))
    s.check("a unit signed off by its BU CEO: refused", not ok and "signed off" in m, m)
    clear_ticks()
    # role-less second HOD: the message says so
    ok, m = setp("N1", hod2=eid("BCB"))
    s.check("a BU CEO as second HOD is allowed and the message says the HOD takes 100%", ok and "BU CEO or BG CEO seat" in m and "100%" in m, m)
    setp("N1", clear2=True)
    # removing the second HOD keeps the first HOD's agreed band
    set_pair("S1", "HB", 50)
    agree_all("HA", "pot")
    agree_all("HB", "pot")
    hsign("HA", "pot")
    before = run(lambda d: a.gradeh_effective_band(d, CID, P["S1"], "pot"))
    db.execute("DELETE FROM gradeh_signoffs WHERE scope_key=?", (str(U["HB"]),))
    db.execute("DELETE FROM gradeh_hod_reviews WHERE by_user_id=?", (U["HB"],))
    db.commit()
    ok, m = setp("S1", clear2=True)
    after = run(lambda d: a.gradeh_effective_band(d, CID, P["S1"], "pot"))
    s.check("taking the second HOD off keeps HA's agreed and signed band (it moves back to the one-HOD place)", ok and before == after == ("Mid", "hod")
            and one("SELECT COUNT(*) FROM gradeh_reviews WHERE person_id=? AND tier='hod' AND by_user_id=?", (P["S1"], U["HA"])) == 1
            and one("SELECT COUNT(*) FROM gradeh_hod_reviews WHERE person_id=?", (P["S1"],)) == 0, (before, after, m))
    set_pair("S1", "HB", 50)
    clear_ticks()
    # the panel renders, with the second HOD and the split, for the super admin only
    pn = CSU.get("/admin/gradeh?tab=people&panel=hod&set=%d" % P["S1"]).get_data(as_text=True)
    s.check("the HOD panel shows the second HOD, the split and the how-it-works note; its form posts to the pair route with a confirm",
            'name="hod2_eid"' in pn and 'name="hod_split"' in pn and "Set Grade H HODs" in pn and "data-confirm=" in pn and "exactly halfway takes the lower band" in pn.replace("\n", " ").lower()
            and "Remove the second HOD" in pn and "50 : 50" in pn)
    s.check("a BG admin does not get the panel", "hod2_eid" not in CBGA.get("/admin/gradeh?tab=people&panel=hod&set=%d" % P["S1"]).get_data(as_text=True))

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("the list: two HOD lines, the chip, the strip, the filter, the Excel")
    pl = text(CSU.get("/admin/gradeh?tab=people"))
    pl_html = CSU.get("/admin/gradeh?tab=people").get_data(as_text=True)
    s.check("a shared person: one line a person (2026-11-03): the pill '2 HODs · 50 : 50', both HODs with their shares in its title (the panel lists them one a line)",
            "2 HODs · 50 : 50" in pl and 'title="Both calibrate them: ZZ SH HA 50% · ZZ SH HB 50%"' in pl_html and "Shared by two HODs" in pl, pl[:200])
    s.check("the Leaders strip says how many share two HODs and that both calibrate them (D1 counts: S1 S2 S3 D1 = 4)", re.search(r"\d+ share two HODs · both calibrate them", pl) is not None, pl[:400])
    s.check("the Show filter offers Shared by two HODs (N)", re.search(r"Shared by two HODs \(\d+\)", CSU.get("/admin/gradeh?tab=people").get_data(as_text=True)) is not None)
    sh = text(CSU.get("/admin/gradeh?tab=people&show=shared"))
    s.check("...and picks exactly the shared people (S1 S2 S3 D1; not X1 or R1)", "ZZ SH S1" in sh and "ZZ SH D1" in sh and "ZZ SH X1" not in sh and "ZZ SH R1" not in sh)
    peo = run(lambda d: a.gradeh_admin_people(d, CID))
    s.check("the count and its list are the same function (_gh_adm_pick)", len(a._gh_adm_pick(peo, "shared")) == a._gh_leaders(peo)["shared"] == 4)
    db.execute("UPDATE gradeh_people SET hod2_user_id=NULL, hod_split=NULL WHERE hod2_user_id IS NOT NULL AND id NOT IN (?)", (P["R1"],))
    db.execute("UPDATE gradeh_people SET hod2_user_id=NULL, hod_split=NULL WHERE id IN (?,?)", (P["R1"], P["R2"]))
    db.commit()
    pl0 = text(CSU.get("/admin/gradeh?tab=people"))
    s.check("with nobody shared the strip has no 'share two HODs' piece (only when N > 0)", "share two HODs" not in pl0 and "shares two HODs" not in pl0)
    for k_, sp_ in (("S1", 50), ("S2", 70), ("S3", 30), ("D1", 50)):
        set_pair(k_, "HB", sp_)
    r_ = CSU.get("/admin/gradeh/list.xlsx")
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(r_.get_data()))
    rows = [[c.value for c in r] for r in wb.worksheets[0].iter_rows()]
    s.check("the Excel gains Second HOD and HOD split %", rows[0][7:10] == ["HOD", "Second HOD", "HOD split %"], rows[0])
    by = {x[0]: x for x in rows[1:]}
    s.check("S2 reads HA and HB with the first HOD's 70; a one-HOD person has both cells blank", by[PFX + "S2"][8].startswith("ZZ SH HB") and by[PFX + "S2"][9] == 70
            and by[PFX + "X1"][8] in ("", None) and by[PFX + "X1"][9] in ("", None))

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("the list import: two new columns")
    LH = list(a.GRADEH_LIST_IMPORT_COLUMNS)
    s.check("the columns: HOD employee ID, then Second HOD employee ID and HOD split %", LH[3:6] == ["HOD employee ID", "Second HOD employee ID", "HOD split %"], LH)
    def build(rows, cols=None):
        cols = cols or LH
        b = io.StringIO()
        w = csv.writer(b)
        w.writerow(cols)
        w.writerows(rows)
        return b.getvalue().encode()
    def row(eid_, hod="", hod2="", split="", route="KPI"):
        base = dict.fromkeys(LH, "")
        base.update({"Employee ID": eid_, "Route": route, "HOD employee ID": hod, "Second HOD employee ID": hod2, "HOD split %": split})
        return [base[c] for c in LH]
    def load(rows, cols=None):
        return run(lambda d: a._ghl_load(d, SU_ROW(d), {"filename": "gh.csv"}, build(rows, cols)))
    def whys(ctx):
        return [e["why"] for e in ctx["errors"]]
    ctx = load([row(eid("N1"), eid("HA"), eid("HA"), "50"), row(eid("X1"), eid("HA"), eid("X1")), row(eid("X2"), eid("HA"), "", "60"),
                row(eid("Y1"), eid("HB"), eid("HB2")), row(eid("S1"), eid("HA"), eid("LFT"), "50"), row(eid("S2"), eid("HA"), eid("HB"), "55"),
                row(eid("S3"), eid("HA"), eid("HB"), "100")])
    w = " | ".join(whys(ctx))
    s.check("errors: the second HOD is the same person as the HOD; the person themselves; a split with no second HOD; an unknown or departed second HOD; a split not in 10s",
            "same person as the HOD" in w and "own second HOD" in w and "needs a second HOD" in w and "second HOD " + eid("HB2") in w and "second HOD " + eid("LFT") in w and w.count("HOD split must be") == 2 and not ctx["valid"], w)
    s.check("...each filed under 'A second HOD OneHR can't use, or a split that doesn't fit' on the quality step", all(
        a._imp_err_kind(a._IMP[a.GRADEH_LIST_KIND], e["why"]).startswith("A second HOD") for e in ctx["errors"]))
    ctx = load([row(eid("N1"), eid("HA"), eid("BCB"), "50"), row(eid("X1"), eid("HA"), eid("HB"), "")])
    s.check("worth a look: a second HOD who holds a BU CEO seat (the HOD takes 100%)", len(ctx["look"]["hod2_norole"]) == 1 and not ctx["errors"], ctx["look"]["hod2_norole"])
    # a calibrator of the normal review as second HOD: no warning any more (Chris, 2026-11-03)
    U["CALX"] = mk("CALX", "19", dept="ZZSH Dept CALX")
    xg_ = db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id) VALUES (?,?,?,?)", (BG, CO, "ZZSH Panel X", U["CALX"])).lastrowid
    db.commit()
    ctx_c = load([row(eid("N1"), eid("HA"), eid("CALX"), "50"), row(eid("X1"), eid("CALX"), "", "")])
    s.check("a calibrator of the normal review as second HOD or as the HOD raises no 'holds a BU CEO or BG CEO seat' warning (they are Grade H HODs)",
            ctx_c["look"]["hod2_norole"] == [] and ctx_c["look"]["hod_norole"] == [] and not ctx_c["errors"], (ctx_c["look"]["hod2_norole"], ctx_c["look"]["hod_norole"]))
    real_twin_l = a.gradeh_hod_has_role
    a.gradeh_hod_has_role = lambda db_, hid_: bool(hid_) and a.hod_has_role(db_, hid_)   # the old rule
    try:
        ctx_o = load([row(eid("N1"), eid("HA"), eid("CALX"), "50"), row(eid("X1"), eid("CALX"), "", "")])
    finally:
        a.gradeh_hod_has_role = real_twin_l
    s.check("falsified (the old rule): the same rows warn again, second HOD and HOD, so the check above reached its guard",
            len(ctx_o["look"]["hod2_norole"]) == 1 and len(ctx_o["look"]["hod_norole"]) == 1)
    db.execute("DELETE FROM calib_bu_groups WHERE id=?", (xg_,))
    db.execute("DELETE FROM users WHERE id=?", (U.pop("CALX"),))
    db.commit()
    db.execute("UPDATE users SET business_group='ZZSH Other' WHERE id=?", (U["HB"],))
    db.commit()
    ctx = load([row(eid("X1"), eid("HA"), eid("HB"), "")])
    s.check("worth a look: a second HOD in another business group", len(ctx["look"]["hod2_bg"]) == 1 and not ctx["errors"])
    db.execute("UPDATE users SET business_group=? WHERE id=?", (BG, U["HB"]))
    db.commit()
    # apply: a split with the second HOD, a blank split = 50, a file without the columns leaves it alone
    ctx = load([row(eid("N1"), eid("HA"), eid("HB"), "60"), row(eid("X1"), eid("HA"), eid("HD"), "")])
    ch = run(lambda d: a._ghl_changes(d, SU_ROW(d), ctx, {}))
    tl = {t[1]: t[0] for t in ch["tiles"]}
    s.check("the Changes step counts HOD shared and second HOD removed", tl.get("HOD shared (two HODs)") == 2 and tl.get("second HOD removed") == 0, tl)
    run(lambda d: a._ghl_apply(d, SU_ROW(d), ctx, {}))
    s.check("apply: N1 shared HA/HB at 60, X1 shared HA/HD with the blank split read as 50", one("SELECT hod_split FROM gradeh_people WHERE id=?", (P["N1"],)) == 60
            and one("SELECT hod2_user_id FROM gradeh_people WHERE id=?", (P["X1"],)) == U["HD"] and one("SELECT hod_split FROM gradeh_people WHERE id=?", (P["X1"],)) == 50)
    old_cols = [c for c in LH if c not in ("Second HOD employee ID", "HOD split %")]
    ctx = load([[eid("N1"), "KPI", "", eid("HA"), "", "", ""][:len(old_cols)]], cols=old_cols)
    run(lambda d: a._ghl_apply(d, SU_ROW(d), ctx, {}))
    s.check("a file WITHOUT the new columns never touches a second HOD already set", one("SELECT hod2_user_id FROM gradeh_people WHERE id=?", (P["N1"],)) == U["HB"]
            and one("SELECT hod_split FROM gradeh_people WHERE id=?", (P["N1"],)) == 60)
    ctx = load([row(eid("N1"), eid("HA"), "", "")])
    ch = run(lambda d: a._ghl_changes(d, SU_ROW(d), ctx, {}))
    tl = {t[1]: t[0] for t in ch["tiles"]}
    s.check("a blank cell under the column asks the super admin (a decision) and the count says one second HOD removed", tl.get("second HOD removed") == 1
            and any(g["title"].startswith("The file's second HOD differs") for g in ch["decide"]), tl)
    run(lambda d: a._ghl_apply(d, SU_ROW(d), ctx, {"hod2:" + eid("N1"): "keep"}))
    s.check("answered Keep: the second HOD stays", one("SELECT hod2_user_id FROM gradeh_people WHERE id=?", (P["N1"],)) == U["HB"])
    run(lambda d: a._ghl_apply(d, SU_ROW(d), ctx, {"hod2:" + eid("N1"): "file"}))
    s.check("answered Use the file's: the second HOD is taken away and the split cleared", one("SELECT hod2_user_id FROM gradeh_people WHERE id=?", (P["N1"],)) is None
            and one("SELECT hod_split FROM gradeh_people WHERE id=?", (P["N1"],)) is None)
    r_ = CSU.get("/admin/gradeh/import/list/template.xlsx")
    wb = load_workbook(io.BytesIO(r_.get_data()))
    trows = [[c.value for c in r] for r in wb.worksheets[0].iter_rows()]
    s.check("the template follows the constant, and every example row is an EXAMPLE- placeholder", trows[0] == LH and all(str(r[0]).startswith("EXAMPLE-") for r in trows[1:]) and all(len(r) == len(LH) for r in trows[1:]), trows[0])

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("help: one line on a shared person")
    s.check("the HOD's Help answer 'How do I move someone?' says the other HOD's call shows under the row and the band is weighted by the split",
            "second HOD" in a.HELP_QA["gh_cal_move"][1] and "weighted by the split" in a.HELP_QA["gh_cal_move"][1])

finally:
    a.ai_draft.review_agent_available = _real_avail
    os.environ["ONEHR_GRADEH"] = _ENV0 if _ENV0 is not None else ""
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE cycles SET half=? WHERE id=?", (HALF0, CID))
        d.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%'")
        d.commit()

sys.exit(s.done())
