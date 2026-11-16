"""Grade H Appraisal: the admin person page for a Grade H person (2026-11-03; Chris: "we can't view the KPI for those with KPI lines in the user
page, we might need a redesigned user page for grade H"; canvases P1, P2).

What this suite holds:
  * a person on the active cycle's Grade H list has Overview, Grade H Appraisal and History tabs only; Performance, Competency, 360 Feedback and Career
    Plan (and the AI+ conversation card) are not shown, and asked directly each falls back to the Overview (the page and its fragment)
  * the header reads "Grade H Appraisal · KPI route" / "· Line manager route" and "Not in the normal review", never "Not taking part"
  * the Overview: the Grade H card (the steps), "KPI achievement" and "Result so far", Needs attention listing Grade H items (no appraiser, KPI route with
    no lines, a shared HOD who has not signed off, does not agree) and none of "below the lowest grade" / "No HOD"; "Who appraises them" with the appraiser,
    the Grade H HOD(s) with their shares and the BU CEO, and Change links into the Grade H list's panel for the super admin only
  * the Grade H Appraisal tab is READ ONLY: the KPI table's numbers are exactly what gradeh_computed gives (weights, theirs, line manager, the weighted
    total, the rating and band); route B shows the eight attributes and their average; the bands level by level and the changes with remarks (a shared
    person: each HOD's call with its signed state); the 14 statements (yes count, a fold); the comments and the nomination; the acknowledgement
  * the reason a person gave for "I do not agree" is never on any tab; a person who does not agree reads "not calibrated" and shows no HOD or BU CEO row
  * who sees it: the super admin and admin roles with gradeh.read, for their own people; a role without the item sees the header chip only (no tab, no card;
    the tab asked directly falls back); another group's admin is refused; an employee is refused
  * the page writes nothing; a person who is not on the list keeps the normal page, tabs and all
Guards are falsified in the suite (a patched twin makes the check fail). Synthetic (ZZ9PP-*) on a fresh scratch database; the suite puts back what it changes.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Grade H Appraisal: the admin person page")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA0, EMP = H.actors(a)
PFX, BG, BG2, CO = "ZZ9PP-", "ZZPP Group", "ZZPP Other Group", "ZZPP Unit A"
SECRET = "ZZ-SECRET-REASON-NEVER-SHOWN"
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
    return " ".join(h.replace("&#39;", "'").replace("&amp;", "&").replace("&quot;", '"').replace("&rsaquo;", "›").replace("&middot;", "·").split())


def mk(k, grade="H", hod=None, mgr=None, co=CO, bg=BG, dept="ZZPP Dept"):
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, job_grade, job_title, "
        "hod_id, manager_id, confirmation_date, email) VALUES (?,?, 'x', 'user', ?,?,?,?,?, 'Driver', ?,?, '2020-01-01', ?)",
        ((PFX + k).lower(), "ZZ PP " + k, PFX + k, bg, co, dept, grade, hod, mgr, (PFX + k).lower() + "@example.test")).lastrowid


def mk_admin(k, bg, role_builtin=None, role_id=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg, admin_role_id) "
                      "VALUES (?,?, 'x', 'admin', ?, ?, ?, ?)",
                      ((PFX + k).lower(), "ZZ PP " + k, PFX + k, bg, bg,
                       role_id or db.execute("SELECT id FROM admin_roles WHERE builtin=?", (role_builtin,)).fetchone()[0])).lastrowid


def person(k, route="A", hod=None, hod2=None, split=None, appraiser=None):
    pid = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route, hod_user_id, hod2_user_id, hod_split, appraiser_id) VALUES (?,?,?,?,?,?,?,?)",
                     (CID, PFX + k, U[k], route, U[hod] if hod else None, U[hod2] if hod2 else None, split, U[appraiser] if appraiser else None)).lastrowid
    P[k] = pid
    return pid


def lines(k, rows):
    """rows: (name, weight, staff_pct, lm_pct, lm_reason)."""
    for i, (nm, w, st, lm, why) in enumerate(rows):
        lid = db.execute("INSERT INTO gradeh_kpi_lines (cycle_id, person_id, kpi_name, weight, group_scale, sort_order) VALUES (?,?, ?,?, 'FIAMMA', ?)",
                         (CID, P[k], nm, w, i)).lastrowid
        db.execute("INSERT INTO gradeh_kpi_entries (cycle_id, person_id, line_id, staff_pct, lm_pct, lm_reason, lm_at) VALUES (?,?,?,?,?,?,datetime('now'))",
                   (CID, P[k], lid, st, lm, why))


def answers(k, yes_n):
    n = 0
    for lp in a.GRADEH_LP:
        for st in lp["statements"]:
            n += 1
            db.execute("INSERT INTO gradeh_lp_answers (cycle_id, person_id, lp, stmt, answer) VALUES (?,?,?,?,?)",
                       (CID, P[k], lp["n"], st["n"], "yes" if n <= yes_n else "not_yet"))


def submit(k, ack="person", dis=False):
    db.commit()
    comp = run(lambda d: a.gradeh_computed(d, CID, P[k]))
    db.execute("INSERT INTO gradeh_appraisals (cycle_id, person_id, staff_submitted_at, lm_submitted_at, perf_value, perf_rating, perf_band, pot_score, pot_band, "
               "b_achievements, b_strengths, b_development, conversation_held, promo_nominate, promo_reason, ack_in_person, ack_in_person_on, ack_in_person_by, "
               "disagree_at, disagree_reason) VALUES (?,?, '2026-11-07 02:00:00', '2026-11-10 02:00:00', ?,?,?,?,?, ?,?,?, 1, 'yes', 'ZZ-PROMO-WHY', ?,?,?, ?,?)",
               (CID, P[k], comp["perf_value"], comp["perf_rating"], comp["perf_band"], comp["pot_score"], comp["pot_band"],
                "ZZ-ACH-" + k, "ZZ-STR-" + k, "ZZ-DEV-" + k, 1 if ack == "person" else 0, "2026-11-12" if ack == "person" else None,
                U["LM"] if ack == "person" else None, "2026-11-11 02:00:00" if dis else None, SECRET if dis else None))
    return comp


def hod_sign(hk, stage):
    db.execute("INSERT OR IGNORE INTO gradeh_signoffs(cycle_id, tier, stage, scope_key, signed_by) VALUES (?, 'hod', ?, ?, ?)", (CID, stage, str(U[hk]), U[hk]))


def snapshot():
    return {t: one("SELECT COUNT(*) FROM %s" % t) for t in ("gradeh_people", "gradeh_appraisals", "gradeh_kpi_lines", "gradeh_kpi_entries", "gradeh_ratings",
                                                              "gradeh_lp_answers", "gradeh_band_moves", "gradeh_reviews", "gradeh_hod_reviews", "gradeh_signoffs",
                                                              "activity_log", "users")}


if True:
    CID = run(lambda d: a.active_cycle_id(d))
    HALF0 = db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()["half"]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
    db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 1)", (CID,))
    for b_, c_ in ((BG, CO), (BG2, "ZZPP Unit O")):
        db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (b_, c_))
    U["BCA"] = mk("BCA", "21")
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, U["BCA"]))
    U["HA"] = mk("HA", "19", hod=U["BCA"])
    U["HB"] = mk("HB", "19", hod=U["BCA"])
    U["LM"] = mk("LM", "15")
    # PA: route A, three KPI lines, the line manager changed one; submitted, acknowledged in person; 9 of 14 Yes
    U["PA"] = mk("PA", mgr=U["LM"], hod=U["HA"])
    person("PA", "A")
    lines("PA", [("ZZ KPI one", 25, 106, 106, None), ("ZZ KPI two", 25, 90, 85, "ZZ-LM-REASON two orders moved"), ("ZZ KPI three", 50, 95, 95, None)])
    answers("PA", 9)
    COMP_A = submit("PA")
    # PB: route B, eight attribute ratings, 5 Yes, waiting to acknowledge
    U["PB"] = mk("PB", mgr=U["LM"], hod=U["HA"])
    person("PB", "B")
    for i, at in enumerate(a.GRADEH_ATTRIBUTES):
        db.execute("INSERT INTO gradeh_ratings (cycle_id, person_id, attr_key, rating) VALUES (?,?,?,?)", (CID, P["PB"], at["key"], 3 + (i % 2)))
    answers("PB", 5)
    COMP_B = submit("PB", ack="wait")
    # PS: shared by HA and HB, route A; HA has signed off both stages, HB none
    U["PS"] = mk("PS", mgr=U["LM"], hod=U["HA"])
    person("PS", "A", hod="HA", hod2="HB", split=60)
    lines("PS", [("ZZ KPI s1", 50, 100, 100, None), ("ZZ KPI s2", 50, 90, 92, None)])
    answers("PS", 7)
    submit("PS")
    for st_ in ("pot", "perf"):
        hod_sign("HA", st_)
    db.execute("INSERT INTO gradeh_band_moves(cycle_id, person_id, axis, stage, band, came_in, remark, by_user_id) VALUES (?,?,?,?,?,?,?,?)",
               (CID, P["PS"], "perf", "hod", "AE", "ME", "ZZ-HOD-REMARK covered the second shift", U["HA"]))
    # PD: does not agree; a stray HOD tick must not reach them
    U["PD"] = mk("PD", mgr=U["LM"], hod=U["HA"])
    person("PD", "B")
    for at in a.GRADEH_ATTRIBUTES:
        db.execute("INSERT INTO gradeh_ratings (cycle_id, person_id, attr_key, rating) VALUES (?,?,?,?)", (CID, P["PD"], at["key"], 3))
    answers("PD", 6)
    submit("PD", ack="wait", dis=True)
    db.execute("INSERT INTO gradeh_band_moves(cycle_id, person_id, axis, stage, band, came_in, remark, by_user_id) VALUES (?,?,?,?,?,?,?,?)",
               (CID, P["PD"], "perf", "hod", "OU", "ME", "ZZ-STRAY-HOD-MOVE", U["HA"]))
    # PN: route A, no appraiser (no line manager), no KPI lines, not submitted
    U["PN"] = mk("PN")
    person("PN", "A")
    # a normal person (not on the list), and one of the other group on the list
    U["NORM"] = mk("NORM", "15", mgr=U["LM"], hod=U["HA"])
    U["OTH"] = mk("OTH", "H", co="ZZPP Unit O", bg=BG2)
    db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route) VALUES (?,?,?, 'B')", (CID, PFX + "OTH", U["OTH"]))
    db.commit()
    a._seed_access_roles()
    NOROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZPP No Grade H', 'group')").lastrowid
    db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(NOROLE, k) for k in sorted(a.role_preset_items("view")) if k != "gradeh.read"])
    U["BGA"] = mk_admin("BGA", BG, role_builtin="bg")
    U["NOA"] = mk_admin("NOA", BG, role_id=NOROLE)
    U["BG2A"] = mk_admin("BG2A", BG2, role_builtin="bg")
    db.commit()
    db.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%'")
    db.commit()

CSU = H.client_as(a, SU["id"])
CBG, CNO, CBG2, CEMP = (H.client_as(a, U["BGA"]), H.client_as(a, U["NOA"]), H.client_as(a, U["BG2A"]), H.client_as(a, EMP["id"]))


def pg(client, k, tab="overview", **kw):
    q = "&".join("%s=%s" % (x, y) for x, y in kw.items())
    return client.get("/admin/users/%d?tab=%s%s" % (U[k], tab, ("&" + q) if q else ""))


def tabs_of(html):
    m = re.search(r'<nav class="pp-tabs"[\s\S]*?</nav>', html)
    return re.findall(r">([^<]+)</a>", m.group(0)) if m else []


try:
    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("the tabs and the header")
    r = pg(CSU, "PA")
    h = r.get_data(as_text=True)
    t = text(r)
    s.check("a Grade H person's page: Overview, Grade H Appraisal, History", r.status_code == 200 and tabs_of(h) == ["Overview", "Grade H Appraisal", "History"], tabs_of(h))
    s.check("the header chip says Grade H Appraisal · KPI route, and Not in the normal review; never Not taking part", "Grade H Appraisal · KPI route" in t
            and "Not in the normal review" in t and "Not taking part" not in t and "Taking part in" not in t)
    s.check("a line manager route person's chip says Line manager route", "Grade H Appraisal · Line manager route" in text(pg(CSU, "PB")))
    for tb in ("performance", "competency", "f360", "plan"):
        rr = pg(CSU, "PA", tb)
        s.check("%s asked directly falls back to the Overview" % tb, rr.status_code == 200 and re.search(r'class="is-on"[^>]*>Overview', rr.get_data(as_text=True)) is not None
                and "Needs attention" in text(rr) and "Add a KPI" not in text(rr))
        rf = pg(CSU, "PA", tb, fragment=1)
        s.check("...and as a side-panel fragment: no Performance / Competency / 360 / Career Plan content", rf.status_code == 200 and "Add a KPI" not in text(rf) and "Their 360 results" not in text(rf))
    s.check("the Overview has no Performance, Competency, 360 Feedback or Career Plan card and no AI+ conversation card",
            not any(w in t for w in ("No KPIs this cycle", "No competencies assigned", "Their 360 results", "No role choice yet", "Their own check-in with OneHR AI")), t[:300])
    s.check("Needs attention drops 'below the lowest grade' and 'No HOD'", "below this cycle" not in t and "No HOD" not in t and "so no department review" not in t)
    n_ = pg(CSU, "NORM")
    s.check("a person NOT on the list keeps the normal page and every tab", tabs_of(n_.get_data(as_text=True)) == ["Overview", "Performance", "Competency", "360 Feedback", "Career Plan", "History"]
            and "Grade H Appraisal ·" not in text(n_))

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("the Overview cards")
    s.check("the Grade H card with the steps: staff KPI sent, line manager submitted, acknowledged in person", "Staff · KPI sent 7 Nov" in t and "Line manager · submitted 10 Nov" in t and "Acknowledged · in person" in t, t[:600])
    s.check("...and the HOD stage (HA signed both stages for everyone, in the setup)", "HOD · 1 of 1 signed off" in t and "The HOD stage: signed off" in t, t[:700])
    s.check("KPI achievement: 3 lines, weights 100%, the weighted figure from the line manager's numbers", "3 lines · weights 100%" in t and ("%s%% weighted" % a._gh_pct_str(COMP_A["perf_value"])) in t, t[:900])
    tb_ = text(pg(CSU, "PB"))
    s.check("route B: 8 attributes and the average", "8 attributes · average %.2f" % COMP_B["perf_rating"] in tb_, tb_[:700])
    s.check("Result so far: the band at the highest level reached, and which level (the line manager's here)", COMP_A["perf_band"] in t and "Line manager's band" in t, t[:900])
    tn = text(pg(CSU, "PN"))
    s.check("a person nobody has decided shows 'No band yet', never a default band", "No band yet" in tn and "UA" not in re.sub(r"\s+", " ", tn).split("Result so far")[1][:120])
    s.check("Needs attention lists the Grade H items for a person with no appraiser and no KPI lines", "No appraiser: nobody can appraise them yet" in tn and "KPI route with no KPI lines yet" in tn, tn[:700])
    ts = text(pg(CSU, "PS"))
    s.check("a shared person: 'Shared by two HODs: <name> has not signed off ...' for the HOD who has not signed", "Shared by two HODs: ZZ PP HB has not signed off potential or performance" in ts, ts[:900])
    s.check("...the HOD card reads 1 of 2 signed off", "The HOD stage: 1 of 2 HODs signed off" in ts and "HOD · 1 of 2 signed off" in ts)
    td = text(pg(CSU, "PD"))
    s.check("a person who does not agree: the step reads 'Does not agree · not calibrated'; Needs attention says so; no HOD step", "Does not agree · not calibrated" in td and "HOD · " not in td.split("Needs attention")[0].split("Grade H Appraisal Open")[-1][:300])
    hh = pg(CSU, "PA").get_data(as_text=True)
    s.check("who appraises them: the appraiser, the Grade H HOD, the BU CEO; Change opens the Grade H list's panel (super admin)",
            "Who appraises them" in t and "ZZ PP LM" in t and "ZZ PP HA" in t and "ZZ PP BCA" in t and "panel=hod&amp;set=%d" % P["PA"] in hh and "panel=appraiser&amp;set=%d" % P["PA"] in hh
            and "Who they report to" not in t)
    s.check("a shared person's side card lists both HODs with their shares", "ZZ PP HA 60%" in ts and "ZZ PP HB 40%" in ts and "Grade H HODs · shared" in ts, ts[ts.find("Who appraises"):][:300])

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("the Grade H Appraisal tab: read only, from the Grade H records")
    ga = text(pg(CSU, "PA", "gradeh"))
    gh_html = pg(CSU, "PA", "gradeh").get_data(as_text=True)
    s.check("the tab renders its sections", all(w in ga for w in ("Where it stands", "KPI achievement", "Bands, level by level", "Changes and remarks", "Potential · the 14 statements",
                                                                  "The line manager's comments", "Acknowledgement")), ga[:300])
    det = run(lambda d: a.gradeh_buceo_person_detail(d, CID, d.execute(a._GH_CAL_SQL + "AND p.id=?", (CID, P["PA"])).fetchone()))
    ok_rows = all(("%s %s%%" % (k["name"], k["weight"])) in ga for k in det["kpis"])
    s.check("the KPI table: every line, its weight, theirs and the line manager's figure and reason, as the BU CEO's page reads them", ok_rows and "ZZ KPI one 25% 106% 106%" in ga
            and "ZZ KPI two 25% 90% 85% ZZ-LM-REASON two orders moved" in ga and "ZZ KPI three 50% 95% 95%" in ga, ga[ga.find("KPI achievement"):][:500])
    tot = "Weighted achievement 100%% %s%% %s%%" % (a._gh_pct_str(a.gradeh_weighted_achievement([(25, 106), (25, 90), (50, 95)])), a._gh_pct_str(COMP_A["perf_value"]))
    s.check("the weighted totals are gradeh_computed's and gradeh_weighted_achievement's (theirs and the line manager's), with the rating and band",
            tot in ga and ("Rating %d" % round(COMP_A["perf_rating"])) in ga and COMP_A["perf_band"] in ga, (tot, ga[ga.find("Weighted"):][:200]))
    gb = text(pg(CSU, "PB", "gradeh"))
    s.check("route B: the eight attributes with their ratings, and the average gradeh_computed gives",
            all(at["title"][0] in gb for at in a.GRADEH_ATTRIBUTES) and ("Average %.2f" % COMP_B["perf_rating"]) in gb, gb[gb.find("The line manager's ratings"):][:300])
    s.check("the statements: the yes count and the score, three principles and a fold for the rest", "9 of 14 Yes" in ga and ("%s / %s" % (a._gh_pct_str(COMP_A["pot_score"]), a._gh_pct_str(a.GRADEH_LP_MAX))) in ga
            and "4 more principles" in ga and '<details class="fold">' in gh_html)
    s.check("the comments and the nomination", "ZZ-ACH-PA" in ga and "ZZ-STR-PA" in ga and "ZZ-DEV-PA" in ga and "ZZ-PROMO-WHY" in ga)
    s.check("the acknowledgement: in person, on the day, recorded by the line manager", "Acknowledged in person on 12 Nov 2026, recorded by ZZ PP LM" in ga, ga[ga.find("Acknowledgement"):][:200])
    s.check("bands level by level: the line manager's band; the HOD, BU CEO and final levels say Not yet while nobody has set one", ga.count("Not yet") >= 6, ga[ga.find("Bands, level"):][:400])
    gs = text(pg(CSU, "PS", "gradeh"))
    s.check("a shared person: HOD level shared 60 : 40, each HOD's call with its signed state, and what the HOD level reads now",
            "HOD level · shared 60 : 40" in gs and "ZZ PP HA ·" in gs and "signed off" in gs and "ZZ PP HB · no call yet" in gs and "Now: ZZ PP HA's call alone" in gs, gs[gs.find("Bands"):][:700])
    s.check("...the HOD's move with its remark is in Changes and remarks", "ZZ PP HA" in gs and "ZZ-HOD-REMARK covered the second shift" in gs and "ME → AE" in gs)
    s.check("...and the HOD level reads AE (HA signed alone), from _gh_hod_level", run(lambda d: a.gradeh_band_at(d, CID, P["PS"], "perf", "hod")) == ("AE", "hod") and "4 · AE" in gs)
    hist = pg(CSU, "PA", "history")
    s.check("History still opens", hist.status_code == 200 and tabs_of(hist.get_data(as_text=True)) == ["Overview", "Grade H Appraisal", "History"])

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("a person who does not agree; the reason is never shown")
    every = ""
    for tb in ("overview", "gradeh", "history", "performance"):
        every += pg(CSU, "PD", tb).get_data(as_text=True)
    every += pg(CBG, "PD", "gradeh").get_data(as_text=True) + pg(CSU, "PD", "gradeh", fragment=1).get_data(as_text=True)
    s.check("the reason they gave appears on no tab, for the super admin or a BG admin (page, HTML and fragment)", SECRET not in every)
    gd = text(pg(CSU, "PD", "gradeh"))
    s.check("the Grade H tab says they do not agree, not calibrated, and shows no HOD stray move", "Does not agree · not calibrated" in gd and "ZZ-STRAY-HOD-MOVE" not in gd and "OU" not in gd.split("Bands")[1].split("Changes")[0])
    s.check("the HOD level reads the line manager's band (the stray HOD move never reaches them)", run(lambda d: a.gradeh_band_at(d, CID, P["PD"], "perf", "final")) == ("ME", "lm") or
            run(lambda d: a.gradeh_band_at(d, CID, P["PD"], "perf", "final"))[1] == "lm")

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("who sees what")
    rb = pg(CBG, "PA")
    s.check("a BG admin (built-in role, gradeh.read) sees the tab and the cards, and no Change links (view only)", tabs_of(rb.get_data(as_text=True)) == ["Overview", "Grade H Appraisal", "History"]
            and "Who appraises them" in text(rb) and "panel=hod" not in rb.get_data(as_text=True) and "Grade H Appraisal · KPI route" in text(rb))
    s.check("...and reads the Grade H tab", rb.status_code == 200 and "Bands, level by level" in text(pg(CBG, "PA", "gradeh")))
    rn = pg(CNO, "PA")
    tn_ = text(rn)
    s.check("an admin role WITHOUT gradeh.read sees the header chip only: no Grade H tab, no Grade H cards, no KPI table",
            tabs_of(rn.get_data(as_text=True)) == ["Overview", "History"] and "Grade H Appraisal · KPI route" in tn_ and "KPI achievement" not in tn_ and "Result so far" not in tn_
            and "Who appraises them" not in tn_ and "ZZ KPI one" not in tn_, tn_[:500])
    rg = pg(CNO, "PA", "gradeh")
    s.check("...and the Grade H tab asked directly falls back to the Overview", rg.status_code == 200 and "Bands, level by level" not in text(rg) and "ZZ KPI one" not in text(rg))
    s.check("another group's admin is refused (403) and an employee is refused", pg(CBG2, "PA").status_code == 403 and pg(CEMP, "PA").status_code in (302, 403, 404))
    s.check("a BG admin of the other group sees their own Grade H person", pg(CBG2, "OTH").status_code == 200 and "Grade H Appraisal · Line manager route" in text(pg(CBG2, "OTH")))
    # falsify: if the gate took anyone, the role without the item would see the tab
    real_can = a.admin_can
    a.admin_can = lambda u, m, k: True
    try:
        s.check("falsified: with the item check open, the role without gradeh.read WOULD see the Grade H tab (so the check above is the gate)",
                "Grade H Appraisal" in tabs_of(pg(CNO, "PA").get_data(as_text=True)))
    finally:
        a.admin_can = real_can
    s.check("...and it is closed again", tabs_of(pg(CNO, "PA").get_data(as_text=True)) == ["Overview", "History"])
    # falsify the tab fallback: a Grade H person asked for Performance would otherwise get the normal Performance tab
    real_pg = a._person_gradeh
    a._person_gradeh = lambda db_, me_, p_, cyc_: None
    try:
        s.check("falsified: with the Grade H view off the same person falls back to the normal tabs and 'Not taking part'",
                "Performance" in tabs_of(pg(CSU, "PA").get_data(as_text=True)) and "Not taking part" in text(pg(CSU, "PA")))
    finally:
        a._person_gradeh = real_pg

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("the People list's side panel (person in brief)")
    fa = pg(CSU, "PA", "overview", fragment=1)
    ft = text(fa)
    s.check("a Grade H person in brief: 'Grade H Appraisal · KPI route' and 'Not in the normal review'; none of the four normal module cards, no 'not taking part'",
            fa.status_code == 200 and "Grade H Appraisal · KPI route" in ft and "Not in the normal review" in ft and "No KPIs" not in ft and "No competencies assigned" not in ft
            and "No role choice yet" not in ft and "not taking part" not in ft.lower(), ft[:400])
    s.check("...with a link to their Grade H tab for the super admin", "tab=gradeh" in fa.get_data(as_text=True))
    fn = pg(CNO, "PA", "overview", fragment=1)
    s.check("a role without gradeh.read sees the chip only (no link to the tab, no Grade H facts)", "Grade H Appraisal · KPI route" in text(fn) and "tab=gradeh" not in fn.get_data(as_text=True)
            and "ZZ KPI one" not in text(fn))
    fb = text(pg(CSU, "PB", "overview", fragment=1))
    s.check("a line manager route person says so", "Grade H Appraisal · Line manager route" in fb)
    fm = text(pg(CSU, "NORM", "overview", fragment=1))
    s.check("a person not on the list keeps the four module cards and no Grade H chip", "Performance" in fm and "Career Plan" in fm and "Grade H Appraisal ·" not in fm)

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("the page writes nothing")
    before = snapshot()
    for k in ("PA", "PB", "PS", "PD", "PN"):
        for tb in ("overview", "gradeh", "history"):
            pg(CSU, k, tb)
            pg(CBG, k, tb)
    after = snapshot()
    s.check("reading every tab as the super admin and a BG admin changes no Grade H row, no user and writes no activity row", before == after, {k: (before[k], after[k]) for k in before if before[k] != after[k]})
    s.check("the tab has no form and no button that writes", "<form" not in re.search(r"<div class=\"pp-gh\">[\s\S]*", pg(CSU, "PA", "gradeh").get_data(as_text=True)).group(0).split("</main>")[0])

finally:
    os.environ["ONEHR_GRADEH"] = _ENV0 if _ENV0 is not None else ""
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE cycles SET half=? WHERE id=?", (HALF0, CID))
        d.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%'")
        d.commit()

sys.exit(s.done())
