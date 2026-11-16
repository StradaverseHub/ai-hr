"""Fill BU result replaces a line manager's moderation (Chris, 2026-11-13: "All BU KPIs follow the number filled by Group People").

Before this, a BU KPI line an approver had acted on was skipped: one the line manager had confirmed read "Moderated, will be replaced"
(partly moderated) or "Locked, left as is" (chain complete) yet the save never wrote it, so one person kept the line manager's figure
while the rest of the unit followed Group People's. Real case: a person submitted their own figure, their line manager confirmed it,
then Group People filled the BU KPI and that one line was left out.

What this suite holds (synthetic ZZ9BM-* people on a fresh scratch database; the suite puts back what it changes):
  * (a) a one-step line the line manager confirmed is filled: its approval rows are gone, one lm_handover_archive row (part
    "pm_bu_fill") holds them with the person's own result, the line is locked as admin-filled and pm_effective_value reads the filled figure
  * (b) a partly moderated two-step line (step 1 acted, step 2 pending, a draft by the second approver) is filled the same way
  * (c) a moderated line whose person has a calibration adjustment is NOT touched and reads "Calibrated, left as is"
  * (d) the same for a person whose result is released
  * (e) the person's other KPI line, moderated, keeps its approval rows and its figure
  * (f) an unmoderated line (their own figure, or nothing) still fills as before; an unmoderated line is archived for nobody
  * the preview (calc JSON, rows, the page's counts), the confirm box's words and the save agree on which lines are written
  * the audit row says how many moderations were replaced; the flash says it; the save is refused without a reason and then writes nothing
  * nothing is emailed; the line manager's other lines and their overall remark are untouched; the filled line is locked for the approver
  * a second fill at the same figure writes nothing (the replaced line now reads as Group People's own fill)
"""
import os
import re
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Fill BU result: a moderated line follows Group People's figure")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA0, _EMP = H.actors(a)
PFX, BG, CO = "ZZ9BM-", "ZZBM Group", "ZZBM Unit"
REV, OWN = "ZZBM Revenue", "ZZBM Own KPI"
U = {}
db = sqlite3.connect(a.DB_PATH, timeout=5.0)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")
URL = "/admin/performance/bu-fill"
Q = "?business_group=%s&company=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"))
SENT = []
_REAL_SEND = a.mailer.send_mail
a.mailer.send_mail = lambda *x, **k: SENT.append(x[:2])   # a fill never emails: anything sent is a failure


def one(sql, args=()):
    r = db.execute(sql, args).fetchone()
    return r[0] if r else None


def csrf(**kw):
    d = {"csrf_token": "tok"}
    d.update(kw)
    return d


def mk(k, grade="15"):
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, job_grade, "
        "job_title, confirmation_date, email) VALUES (?,?, 'x', 'user', ?,?,?, 'ZZBM Dept', ?, 'Clerk', '2020-01-01', ?)",
        ((PFX + k).lower(), "ZZ BM " + k, PFX + k, BG, CO, grade, "zzbm.%s@example.test" % k.lower())).lastrowid


def line(k, name, own=None, chain=(), bu=True, weight=20):
    tid = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, threshold, target, multiple, "
                     "business_group, company, bu_kpi_id, status) VALUES (?,?,?,?,'more','%','Own',0,100,100,?,?,?, 'approved')",
                     (CID, U[k], name, weight, BG, CO, SID if bu else None)).lastrowid
    for i, ap in enumerate(chain, 1):
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,?,?)", (tid, i, U[ap]))
    if own is not None:
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, admin_filled, draft) VALUES (?,?,?,0,0)", (tid, own, U[k]))
    return tid


def approve(tid, seq, by, orig, adj=None):
    db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, adjusted_value, justification, acted_by) VALUES (?,?,?,?,?,?,?)",
               (tid, seq, "adjust" if adj is not None else "confirm", orig, adj, "ZZ why" if adj is not None else None, U[by]))


def calc(value, c=None):
    return (c or SUC).post(URL, data=csrf(action="calc", business_group=BG, company=CO, kpi_name=REV, actual_value=str(value))).get_json()


def fill(value, note="", reason="ZZ audited figure", c=None):
    return (c or SUC).post(URL, follow_redirects=True, data=csrf(business_group=BG, company=CO, kpi_name=REV, actual_value=str(value),
                                                                  note=note, reason=reason)).get_data(as_text=True)


def flat(h):
    h = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", h)
    m = re.search(r'<main id="main"[\s\S]*', h)
    h = m.group(0) if m else h
    h = re.sub(r"<[^>]+>", " ", h)
    import html as _h
    return " ".join(_h.unescape(h).split())


def page():
    return SUC.get("%s%s&kpi_name=%s" % (URL, Q, REV.replace(" ", "+"))).get_data(as_text=True)


def appr(tid):
    return [dict(r) for r in db.execute("SELECT seq, action, original_value, adjusted_value, acted_by FROM pm_kpi_approvals WHERE kpi_target_id=? "
                                        "ORDER BY seq", (tid,))]


def res(tid):
    r = db.execute("SELECT actual_value, note, submitted_by, admin_filled, draft FROM pm_kpi_results WHERE kpi_target_id=?", (tid,)).fetchone()
    return dict(r) if r else None


def drafts(tid):
    return one("SELECT COUNT(*) FROM pm_kpi_moderation_drafts WHERE kpi_target_id=?", (tid,))


def archives():
    return [dict(r) for r in db.execute("SELECT * FROM lm_handover_archive WHERE part='pm_bu_fill' AND subject_id IN (SELECT id FROM users WHERE "
                                        "employee_id LIKE 'ZZ9BM-%') ORDER BY id")]


def effective(tid):
    """(what scoring reads, is it locked, may the line manager still act on it): the app's own attach_pm_chains, pm_effective_value and
    _pm_line_actionable_by."""
    with a.app.test_request_context("/"):
        d = a.get_db()
        t = [dict(x) for x in d.execute("SELECT * FROM pm_kpi_targets WHERE id=?", (tid,))]
        a.attach_pm_chains(d, t)
        return t[0]["effective_value"], t[0]["locked"], a._pm_line_actionable_by(t[0], U["LM"])


def row_of(rows_html, name):
    m = re.search(r'<tr data-bf-row[^>]*data-name="%s"[\s\S]*?</tr>' % re.escape(name.lower()), rows_html)
    return flat(m.group(0)) if m else ""


with a.app.test_request_context("/"):
    CID = a.active_cycle_id(a.get_db())
PREV = dict(db.execute("SELECT kind, year, half, min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())
db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL WHERE id=?", (CID,))
db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', '2099-11-02 00:00', '2099-11-08 23:59')", (CID,))
db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
db.execute("INSERT OR REPLACE INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'B', 'base')", (BG,))
LIB = db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, unit, method, "
                 "weightage_default, bu_level) VALUES (?, '*', '*', 0, '*', ?, 'Financial · Profitability', '%', 'more', 30, 1)", (BG, REV)).lastrowid
SID = db.execute("INSERT INTO pm_bu_kpis(cycle_id, business_group, company, library_id, kpi_name, unit, method, threshold, target, multiple, carriers, "
                 "carriers_json, weight_mode, updated_by) VALUES (?,?,?,?,?, '%', 'more', 0,100,100, 'holders', '{}', 'own', ?)",
                 (CID, BG, CO, LIB, REV, SU["id"])).lastrowid
for k in ("LM", "MM", "A", "B", "C", "D", "E", "F"):
    U[k] = mk(k)
# A: one-step line the line manager confirmed (the real case), plus another line of theirs the LM moderated (not a BU KPI)
T = {"A": line("A", REV, own=90, chain=("LM",)), "A2": line("A", OWN, own=70, chain=("LM",), bu=False, weight=30)}
approve(T["A"], 1, "LM", 90)
approve(T["A2"], 1, "LM", 70, adj=75)
# B: two steps, the line manager acted (adjusted 88 -> 92), the second approver has only a draft
T["B"] = line("B", REV, own=88, chain=("LM", "MM"))
approve(T["B"], 1, "LM", 88, adj=92)
db.execute("INSERT INTO pm_kpi_moderation_drafts(kpi_target_id, approver_id, adjusted_value, justification) VALUES (?,?,?,?)", (T["B"], U["MM"], 95, "ZZ draft"))
# C: moderated, then a calibrator moved their band; D: moderated, then their result was released
T["C"] = line("C", REV, own=80, chain=("LM",))
approve(T["C"], 1, "LM", 80)
T["D"] = line("D", REV, own=60, chain=("LM",))
approve(T["D"], 1, "LM", 60)
SESS = db.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label) VALUES (?, 'super', ?, ?, 'ZZBM')",
                  (CID, a.PM_SUPER_SCOPE_KEY, BG)).lastrowid
db.execute("INSERT INTO pm_calibration_adjustments(session_id, subject_id, original_band, adjusted_band) VALUES (?,?, 'ME', 'AE')", (SESS, U["C"]))
db.execute("INSERT OR REPLACE INTO result_releases(cycle_id, subject_id, kind, released_by) VALUES (?,?, 'pm', ?)", (CID, U["D"], SU["id"]))
# E: the person's own figure, nobody acted; F: nothing on the line
T["E"] = line("E", REV, own=50, chain=("LM",))
T["F"] = line("F", REV, chain=("LM",))
# the line manager's overall remark on A: a person-level thing the fill leaves alone
db.execute("INSERT INTO pm_manager_remarks(cycle_id, subject_id, remark, submitted_by) VALUES (?,?,?,?)", (CID, U["A"], "ZZ overall remark", U["LM"]))
# the fill is a group admin's here (2026-11-14): the super admin's own fill reaches calibrated people (tests/test_bu_kpi_late.py), a group
# admin's still leaves a calibrated or released person's line as it is, which is what this suite holds
ROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZBM role', 'group')").lastrowid
db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(ROLE, "pm.read"), (ROLE, "pm.bu_kpi")])
BGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg, admin_role_id) "
                 "VALUES ('zz9bm-bga', 'ZZ BM Group Admin', 'x', 'admin', 'ZZ9BM-BGA', ?, ?, ?)", (BG, BG, ROLE)).lastrowid
db.commit()
SUC = H.client_as(a, BGA)


def cleanup():
    d = sqlite3.connect(a.DB_PATH, timeout=5.0)
    d.execute("PRAGMA foreign_keys=OFF")
    ids = [r[0] for r in d.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9BM-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        tl = [r[0] for r in d.execute("SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)]
        if tl:
            pt = ",".join("?" * len(tl))
            for t_ in ("pm_kpi_approvals", "pm_kpi_moderation_drafts", "pm_kpi_target_approvers", "pm_kpi_results"):
                d.execute("DELETE FROM %s WHERE kpi_target_id IN (%s)" % (t_, pt), tl)
        d.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)
        d.execute("DELETE FROM pm_manager_remarks WHERE subject_id IN (%s)" % ph, ids)
        d.execute("DELETE FROM pm_calibration_adjustments WHERE subject_id IN (%s)" % ph, ids)
        d.execute("DELETE FROM result_releases WHERE subject_id IN (%s)" % ph, ids)
        d.execute("DELETE FROM lm_handover_archive WHERE subject_id IN (%s)" % ph, ids)
        d.execute("DELETE FROM rating_records WHERE subject_id IN (%s)" % ph, ids)
        d.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        d.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    d.execute("DELETE FROM admin_roles WHERE name='ZZBM role'")
    d.execute("DELETE FROM pm_calibration_sessions WHERE business_group=? AND scope_label='ZZBM'", (BG,))
    d.execute("DELETE FROM pm_bu_kpis WHERE business_group=?", (BG,))
    d.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    d.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    d.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    d.execute("DELETE FROM activity_log WHERE action='pm_bu_fill' AND detail LIKE '%ZZBM%'")
    d.execute("UPDATE cycles SET kind=?, year=?, half=?, min_job_grade=? WHERE id=?", (PREV["kind"], PREV["year"], PREV["half"], PREV["min_job_grade"], CID))
    d.commit()
    d.close()


try:
    # ------------------------------------------------------------ the preview
    s.section("the preview says which lines are replaced and which are left")
    s.check("(set-up) the one-step line reads locked, the two-step line is open, each with approvals",
            effective(T["A"])[1] is True and effective(T["B"])[1] is False and len(appr(T["A"])) == 1 and len(appr(T["B"])) == 1)
    cj = calc(104)
    rows = cj["rows"]
    s.check("four lines will be written (A, B moderated; E, F unmoderated), two held, six carry it", cj["n_fill"] == 4 and cj["n_total"] == 6
            and cj["n_mod"] == 2, (cj["n_fill"], cj["n_total"], cj["n_mod"]))
    s.check("(a) the confirmed one-step line reads 'Moderated, will be replaced' with a rating for the typed figure",
            "Moderated, will be replaced" in row_of(rows, "ZZ BM A") and re.search(r"(Rating \d|\d+\.\d%)", row_of(rows, "ZZ BM A")), row_of(rows, "ZZ BM A"))
    s.check("(b) the partly moderated line reads the same", "Moderated, will be replaced" in row_of(rows, "ZZ BM B"), row_of(rows, "ZZ BM B"))
    s.check("(c) the calibrated person's line reads 'Calibrated, left as is'", "Calibrated, left as is" in row_of(rows, "ZZ BM C")
            and "will be replaced" not in row_of(rows, "ZZ BM C"), row_of(rows, "ZZ BM C"))
    s.check("(d) the released person's line reads 'Calibrated, left as is'", "Calibrated, left as is" in row_of(rows, "ZZ BM D"), row_of(rows, "ZZ BM D"))
    s.check("(f) the unmoderated lines read as before (own figure: Filled before; nothing: Will be filled)",
            "Filled before: 50" in row_of(rows, "ZZ BM E") and "Will be filled" in row_of(rows, "ZZ BM F"), (row_of(rows, "ZZ BM E"), row_of(rows, "ZZ BM F")))
    s.check("the dead wording is gone from the preview", "Locked, left as is" not in rows)
    h0 = page()
    s.check("the page's own count and confirm box say 4 lines, 2 of them replacing a line manager's moderation",
            'data-bf-n="4"' in h0 and "Fill this result for 4 lines" in h0 and "It replaces the line manager's moderation on 2 lines." in h0, h0.count("moderation"))
    s.check("the page's rows are the preview's: the same two held lines", h0.count('title="Calibrated, left as is"') == 2
            and h0.count('title="Moderated, will be replaced"') == 2)

    # ------------------------------------------------------------ the save
    s.section("the save replaces the moderation on the right lines")
    before_C, before_D = (appr(T["C"]), res(T["C"])), (appr(T["D"]), res(T["D"]))
    before_A2 = (appr(T["A2"]), res(T["A2"]))
    rr = fill(104, note="Audited, Q3", reason="")
    s.check("a save without a reason is refused and writes nothing", len(appr(T["A"])) == 1 and res(T["A"])["admin_filled"] == 0 and not archives(),
            flat(rr)[:200])
    SENT.clear()
    r = fill(104, note="Audited, Q3")
    ft = flat(r)
    s.check("the save reports 4 of 6 filled and 2 with a line manager's moderation replaced", "Filled 4 of 6 matching" in ft
            and "2 had a line manager's moderation, which the new figure replaces." in ft and "2 skipped (calibrated, released or already filled)" in ft, ft[:400])
    s.check("(a) the one-step line holds Group People's figure, final", res(T["A"]) == {"actual_value": 104.0, "note": "Audited, Q3", "submitted_by": BGA,
                                                                                          "admin_filled": 1, "draft": 0}, res(T["A"]))
    s.check("(a) its approval rows are gone", appr(T["A"]) == [])
    s.check("(a) scoring reads the filled figure, the line is locked, the line manager cannot act on it",
            effective(T["A"]) == (104.0, True, False), effective(T["A"]))
    arch = {x["subject_id"]: x for x in archives()}
    s.check("(a) one archive row for the person's line, part pm_bu_fill, with the reason, the filler and the confirming line manager",
            U["A"] in arch and arch[U["A"]]["cycle_id"] == CID and arch[U["A"]]["created_by"] == BGA and arch[U["A"]]["old_lm_id"] == U["LM"]
            and arch[U["A"]]["reason"] == "ZZ audited figure", arch.get(U["A"]))
    import json
    pa = json.loads(arch[U["A"]]["payload"])
    s.check("(a) the archive holds the approval as it was, the person's own result and the figure that replaced it",
            pa["kpi_target_id"] == T["A"] and [x["original_value"] for x in pa["approvals"]] == [90.0] and pa["approvals"][0]["action"] == "confirm"
            and pa["result"]["actual_value"] == 90.0 and pa["filled_value"] == 104.0 and len(pa["chains"]) == 1, pa)
    s.check("(b) the partly moderated line is filled the same way: figure, approvals gone, draft gone, locked",
            res(T["B"])["actual_value"] == 104.0 and res(T["B"])["admin_filled"] == 1 and appr(T["B"]) == [] and drafts(T["B"]) == 0
            and effective(T["B"]) == (104.0, True, False), (res(T["B"]), appr(T["B"]), drafts(T["B"]), effective(T["B"])))
    pb = json.loads(arch[U["B"]]["payload"])
    s.check("(b) its archive holds the adjustment (88 -> 92), both chain steps and the second approver's draft",
            [(x["original_value"], x["adjusted_value"]) for x in pb["approvals"]] == [(88.0, 92.0)] and len(pb["chains"]) == 2
            and [d["adjusted_value"] for d in pb["drafts"]] == [95.0], pb)
    s.check("(c) the calibrated person's line is exactly as it was: approvals, result, and no archive row",
            (appr(T["C"]), res(T["C"])) == before_C and U["C"] not in arch, (appr(T["C"]), res(T["C"])))
    s.check("(d) the released person's line is exactly as it was", (appr(T["D"]), res(T["D"])) == before_D and U["D"] not in arch)
    s.check("(e) the person's other moderated line keeps its approval rows and its figure", (appr(T["A2"]), res(T["A2"])) == before_A2
            and appr(T["A2"])[0]["adjusted_value"] == 75.0 and effective(T["A2"])[0] == 75.0, appr(T["A2"]))
    s.check("(e) the line manager's overall remark on the person is untouched", one("SELECT remark FROM pm_manager_remarks WHERE subject_id=?", (U["A"],)) == "ZZ overall remark")
    s.check("(f) the unmoderated lines are filled as before and archived for nobody",
            all(res(T[k])["actual_value"] == 104.0 and res(T[k])["admin_filled"] == 1 for k in ("E", "F")) and U["E"] not in arch and U["F"] not in arch)
    s.check("exactly two archive rows, none for the held or the unmoderated", sorted(arch) == sorted([U["A"], U["B"]]) and len(archives()) == 2, sorted(arch))
    det = one("SELECT detail FROM activity_log WHERE action='pm_bu_fill' ORDER BY id DESC LIMIT 1")
    s.check("the audit row says filled 4 and replaced 2 line managers' moderation, with the reason",
            "filled 4," in det and "replaced 2 line managers' moderation" in det and "reason: ZZ audited figure" in det
            and "with approver action" not in det, det)
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        lm_ = d_.execute("SELECT * FROM users WHERE id=?", (U["LM"],)).fetchone()
        n_wait = a._pm_pending_split(d_, lm_, CID)["team_pending"]
        n_wait_all = a._pm_pending_count(d_, lm_)
    s.check("the line manager's 'waiting on you' counts do not take the filled lines back: none of A, B, E, F is waiting, nor are C and D",
            n_wait == 0 and n_wait_all == 0, (n_wait, n_wait_all))
    s.check("nothing was emailed", not SENT, SENT)
    s.check("the replaced lines refreshed their people's rating records, the held ones did not",
            one("SELECT COUNT(*) FROM rating_records WHERE subject_id IN (?,?) AND last_event='pm_bu_fill'", (U["A"], U["B"])) == 2
            and one("SELECT COUNT(*) FROM rating_records WHERE subject_id IN (?,?) AND last_event='pm_bu_fill'", (U["C"], U["D"])) == 0)

    # ------------------------------------------------------------ afterwards
    s.section("afterwards the filled lines read as any Group People fill")
    cj2 = calc(104)
    s.check("a second preview at the same figure: A and B read 'Stays: 104%', the two held read 'Calibrated, stays as filled' or 'left as is'",
            row_of(cj2["rows"], "ZZ BM A").count("Stays: 104%") == 1 and row_of(cj2["rows"], "ZZ BM B").count("Stays: 104%") == 1
            and "Calibrated, left as is" in row_of(cj2["rows"], "ZZ BM C") and "Moderated, will be replaced" not in cj2["rows"], cj2["rows"][:300])
    s.check("nothing left to replace: no has_approval rows, so the count is 0 moderated", cj2["n_mod"] == 0, cj2["n_mod"])
    snap = {k: (res(T[k]), appr(T[k])) for k in T}
    n_arch = len(archives())
    r2 = fill(104, note="Audited, Q3")
    s.check("a second fill at the same figure writes nothing and archives nothing", "Filled 0 of" in flat(r2) and len(archives()) == n_arch
            and {k: (res(T[k]), appr(T[k])) for k in T} == snap, flat(r2)[:300])
    hp = page()
    s.check("the read card shows the replaced lines as Filled with the figure", hp.count('title="Filled"') == 4 and 'title="Calibrated, left as is"' in hp, hp.count('title="Filled"'))

    # ------------------------------------------------------------ the held lines open up again
    s.section("falsified: with the calibration and the release gone, those two are replaced too")
    db.execute("DELETE FROM pm_calibration_adjustments WHERE subject_id=?", (U["C"],))
    db.execute("DELETE FROM result_releases WHERE subject_id=?", (U["D"],))
    db.commit()
    cj3 = calc(104)
    s.check("the preview now says 4 more lines... the two moderated ones read 'will be replaced'", cj3["n_mod"] == 2
            and "Moderated, will be replaced" in row_of(cj3["rows"], "ZZ BM C") and "Moderated, will be replaced" in row_of(cj3["rows"], "ZZ BM D"), cj3["rows"][:200])
    fill(104, note="Audited, Q3", reason="ZZ second pass")
    s.check("the save replaces them and keeps their own results in the archive",
            appr(T["C"]) == [] and appr(T["D"]) == [] and res(T["C"])["actual_value"] == 104.0 and res(T["D"])["admin_filled"] == 1
            and len(archives()) == n_arch + 2, len(archives()))

    # ------------------------------------------------------------ the move back
    s.section("a partly moderated line of a calibrated person stays; a locked tier holds too")
    T["G"] = None
    U["G"] = mk("G")
    T["G"] = line("G", REV, own=77, chain=("LM", "MM"))
    approve(T["G"], 1, "LM", 77)
    db.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, locked_at) VALUES (?, 'bgceo', ?, ?, 'ZZBM', datetime('now'))",
               (CID, BG, BG))
    db.commit()
    cj4 = calc(104)
    s.check("a tier locked over their group holds a partly moderated line (not locked by its chain): 'Calibrated, left as is'",
            "Calibrated, left as is" in row_of(cj4["rows"], "ZZ BM G") and cj4["n_mod"] == 0, row_of(cj4["rows"], "ZZ BM G"))
    fill(104, note="Audited, Q3", reason="ZZ held tier")
    s.check("...and the save leaves it alone", len(appr(T["G"])) == 1 and res(T["G"])["admin_filled"] == 0, (appr(T["G"]), res(T["G"])))
finally:
    a.mailer.send_mail = _REAL_SEND
    db.close()
    cleanup()

sys.exit(s.done())
