"""The BGCFO tag -- 2026-11-04, Chris "Yes, as drawn" on the canvas "BGCFO: the BG CFO's tag on a calibration panel".

A calibration panel (calib_bu_panels) has a tag: CG (Calibrator (CG), the default, every panel before) or BGCFO (BG CFO
(BGCFO)). Where a BGCFO panel's calibrator reads CG, they read BGCFO. A LABEL only: the abilities stay the Calibrator
role's cg.*, no gate, band or route moves. This suite holds (a made-up business group of synthetic people, put back):
  * the migration: the column, its default, the CREATE TABLE and the one ALTER guard agree, an existing panel reads CG
  * the save: a new panel without the field is CG, with BGCFO it is BGCFO, an edit without the field keeps its tag, a bad
    value is refused with nothing written, a non-super admin is refused, the tag changes after a calibrator has locked
    while who / how stay locked
  * every place for a BGCFO-only calibrator: People > Users chip and hover, the admin person page chip and Roles line, the
    Leaders list chip, step 3's note, the view's short name / title / Help label, the check-in's tab and title, the
    dashboard's switch, Help's seat answer, move.js's string
  * a CG-only calibrator: every place exactly as before; both kinds (no BU CEO seat): CG tab, CG switch, two chips; a BU
    CEO with a BGCFO panel: the BU tab, BU CEO + BGCFO chips
  * the KB row: the guarded UPDATE rewrites the current row once, is a no-op the second time and on a hand-edited body
"""
import html
import os
import re
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The BGCFO tag on a calibration panel")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
BG, CO, HQ = "ZZBCF Group", "ZZBCF Unit", "ZZBCF HQ"
OPS, FIN, SAL, TAX, LEG = "ZZBCF Ops", "ZZBCF Finance", "ZZBCF Sales", "ZZBCF Tax", "ZZBCF Legal"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
CELLS = ("pm_buceo", "pot_buceo", "tb_bgceo", "pm_hod", "pot_hod")


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9BCF-%'")]
    pids = [r[0] for r in db.execute("SELECT id FROM calib_bu_panels WHERE business_group=?", (BG,))]
    gids = [r[0] for r in db.execute("SELECT id FROM calib_bu_groups WHERE business_group=?", (BG,))]
    for st, at in (("pm_calibration_sessions", "pm_calibration_adjustments"),
                   ("calibration_sessions", "calibration_adjustments")):
        for (sid,) in db.execute("SELECT id FROM %s WHERE business_group=?" % st, (BG,)).fetchall():
            db.execute("DELETE FROM %s WHERE session_id=?" % at, (sid,))
            db.execute("DELETE FROM %s WHERE id=?" % st, (sid,))
    db.execute("DELETE FROM talent_box_bu_locks WHERE business_group=?", (BG,))
    for g_ in gids:
        for t_ in ("calib_bu_group_depts", "calib_bu_group_units", "calib_bu_group_people", "calib_bu_group_left"):
            try:
                db.execute("DELETE FROM %s WHERE group_id=?" % t_, (g_,))
            except Exception:   # noqa: BLE001 -- a table this copy lacks
                pass
    for p_ in pids:
        for t_ in ("calib_bu_panel_units", "calib_bu_panel_weights"):
            db.execute("DELETE FROM %s WHERE panel_id=?" % t_, (p_,))
    db.execute("DELETE FROM pm_pbt_achievement WHERE business_group=?", (BG,))
    db.execute("DELETE FROM calib_bu_groups WHERE business_group=?", (BG,))
    db.execute("DELETE FROM calib_bu_panels WHERE business_group=?", (BG,))
    if ids:
        ph = ",".join("?" * len(ids))
        for t, c in (("pm_kpi_targets", "subject_id"), ("cycle_participants", "subject_id"), ("buceo_seats", "user_id"),
                     ("rating_records", "subject_id"), ("ai_prerun_jobs", "subject_id")):
            try:
                db.execute("DELETE FROM %s WHERE %s IN (%s)" % (t, c, ph), ids)
            except Exception:   # noqa: BLE001
                pass
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("UPDATE users SET hod_id=NULL WHERE hod_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM activity_log WHERE action IN ('bu_panel_save','bu_panel_remove') AND detail LIKE '%ZZBCF%'")
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, co, dept, title="ZZBCF Officer"):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, is_demo, email) VALUES (?,?, 'x', 'user', ?,?,?,?,?, '15', 0, ?)",
                      (eid.lower(), "ZZ Bcf " + eid[-3:], eid, BG, co, dept, title,
                       eid.lower() + "@example.test")).lastrowid


def user(uid):
    return a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()


def flashes(r):
    return html.unescape(" ".join(re.findall(r'class="flash[^"]*"[^>]*>(.*?)<', r.get_data(as_text=True), re.S)))


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    HALF0 = db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0]
    WIN0 = [tuple(r) for r in db.execute("SELECT cycle_id, cell, opens_at, closes_at FROM cycle_windows WHERE cycle_id=? "
                                         "AND cell IN (%s)" % ",".join("?" * len(CELLS)), (CID,) + CELLS)]
    MOD0 = [tuple(r) for r in db.execute("SELECT cycle_id, module_key, active FROM cycle_modules WHERE cycle_id=? AND "
                                         "module_key IN ('pm','tm','idp','calibration','review')", (CID,))]
    KB0 = db.execute("SELECT body, tags FROM kb_entries WHERE slug='bu-calibration-groups'").fetchone()
    LEADER0 = [tuple(r) for r in db.execute("SELECT role, ability, allowed, updated_by FROM leader_role_access")]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))   # the BU level is the Year-End's
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN (%s)" % ",".join("?" * len(CELLS)), (CID,) + CELLS)
    for c_ in CELLS:
        db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                   (CID, c_, "2020-01-01 00:00:00", "2099-12-31 15:59:00"))
    for m_ in ("pm", "tm", "idp", "calibration", "review"):
        db.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, m_))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?), (?,?)", (BG, CO, BG, HQ))
    CEO = person(db, "ZZ9BCF-CEO", CO, "ZZBCF Mgmt", title="Chief Executive Officer")   # BU CEO of CO, calibrator of Legal (HQ)
    BC2 = person(db, "ZZ9BCF-BC2", HQ, "ZZBCF HQ Mgmt", title="Chief Executive Officer")   # BU CEO of HQ
    CFO = person(db, "ZZ9BCF-CFO", HQ, "ZZBCF HQ Mgmt", title="CHIEF FINANCIAL OFFICER")   # pure BGCFO (Finance)
    CGC = person(db, "ZZ9BCF-CGC", HQ, "ZZBCF HQ Mgmt", title="Head of Operations")   # pure CG (Ops)
    BOT = person(db, "ZZ9BCF-BOT", HQ, "ZZBCF HQ Mgmt", title="Head of Sales")   # CG panel (Sales) and BGCFO panel (Tax)
    P = {}
    for key, dept, n in (("F", FIN, 3), ("O", OPS, 2), ("S", SAL, 2), ("T", TAX, 2)):
        P[key] = [person(db, "ZZ9BCF-%s%d" % (key, i), CO, dept) for i in range(1, n + 1)]
    P["L"] = [person(db, "ZZ9BCF-L%d" % i, HQ, LEG) for i in (1, 2)]
    EVERY = [CEO, BC2, CFO, CGC, BOT] + [x for v in P.values() for x in v]
    for p_ in EVERY:
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
                   "company) VALUES (?,?,'ZZBCF KPI',100,'more','approved',?,?)",
                   (CID, p_, BG, db.execute("SELECT company FROM users WHERE id=?", (p_,)).fetchone()[0]))
        db.execute("INSERT OR REPLACE INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,'add')", (CID, p_))
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, CEO))
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, HQ, BC2))
    a._sync_buceo_primary(db, CEO)
    a._sync_buceo_primary(db, BC2)
    db.execute("DELETE FROM leader_role_access")
    db.commit()
EID = {}
with a.app.app_context():
    for uid in EVERY:
        EID[uid] = a.get_db().execute("SELECT employee_id FROM users WHERE id=?", (uid,)).fetchone()[0]
C_SU = H.client_as(a, SU["id"])
C_BGA = H.client_as(a, BGA["id"]) if BGA else None


def form(name, units, curve, cals, depts, tag="absent", panel_id=None, action="bu_panel_save"):
    """The panel form as the page posts it; `tag` is the panel_tag radio: "absent" leaves the field out."""
    d = {"csrf_token": "tok", "action": action, "bg": BG, "tab": "buceo", "name": name, "panel_unit": list(units),
         "curve_of": curve, "cal_eids": ",".join(EID[c] for c in cals)}
    for c, ds in depts.items():
        d["dept_" + EID[c]] = ["%s||%s" % pd for pd in ds]
    if tag != "absent":
        d["panel_tag"] = tag
    if panel_id:
        d["panel_id"] = str(panel_id)
    return d


def post(client, data):
    return client.post("/admin/leaders", data=data, follow_redirects=True)


def panel_by(name):
    return H.rows(a, "SELECT id, name, tag, active FROM calib_bu_panels WHERE business_group=? AND name=? AND active=1",
                  (BG, name))


def n_panels():
    return H.one(a, "SELECT COUNT(*) FROM calib_bu_panels WHERE business_group=?", (BG,))


def n_saves():
    return H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='bu_panel_save' AND detail LIKE '%ZZBCF%'")


def lock(db, tbl, tier, key, who):
    db.execute("INSERT OR REPLACE INTO %s(cycle_id, tier, scope_key, business_group, scope_label, locked_at, locked_by) "
               "VALUES (?,?,?,?,?,datetime('now'),?)" % tbl, (CID, tier, key, BG, key, who))
    db.commit()


def row_of(page, name):
    """The <tr> of the table row naming `name`."""
    for tr in re.findall(r"<tr\b.*?</tr>", page, re.S):
        if name in tr:
            return tr
    return ""


def chips(tr):
    """[(text, title)] of the .adm-role chips of a Users row."""
    return [(html.unescape(t).strip(), html.unescape(ti)) for ti, t in
            re.findall(r'<span class="adm-role is-\w+" title="([^"]*)">([^<]*)</span>', tr)]


_avail, _assist = a.ai_draft.review_agent_available, a._calib_assist_on
a.ai_draft.review_agent_available = lambda: True
a._calib_assist_on = lambda u_: True
try:
    # ------------------------------------------------------------------ the migration
    s.section("the migration: the column, its default, one CREATE and one ALTER guard that agree")
    cols = {r[1]: r for r in sqlite3.connect(a.DB_PATH).execute("PRAGMA table_info(calib_bu_panels)")}
    s.check("calib_bu_panels.tag exists, TEXT NOT NULL DEFAULT 'CG'",
            "tag" in cols and cols["tag"][2].upper() == "TEXT" and cols["tag"][3] == 1 and cols["tag"][4] == "'CG'",
            cols.get("tag"))
    src = H.source(a)
    s.check("the CREATE TABLE describes today's shape (tag in it) and the ALTER guard is the same column",
            "\"tag TEXT NOT NULL DEFAULT 'CG')\")" in src
            and src.count("ALTER TABLE calib_bu_panels ADD COLUMN tag TEXT NOT NULL DEFAULT 'CG'") == 1
            and src.count("not in [r[1] for r in c.execute(\"PRAGMA table_info(calib_bu_panels)\")]") == 1)
    cn = sqlite3.connect(a.DB_PATH)
    cn.execute("INSERT INTO calib_bu_panels(business_group, company, name) VALUES (?,?,?)", (BG, CO, "ZZBCF Old"))
    cn.commit()
    cn.execute("ALTER TABLE calib_bu_panels DROP COLUMN tag")   # the table as an older database has it
    cn.commit()
    s.check("fixture: the old shape has no tag", "tag" not in [r[1] for r in cn.execute("PRAGMA table_info(calib_bu_panels)")])
    cn.close()
    a._ensure_runtime_schema()   # what the deploy's migration step runs: the guard adds the column back
    cn = sqlite3.connect(a.DB_PATH)
    s.check("the guard adds the column back, and the panel that existed reads CG",
            cn.execute("SELECT tag FROM calib_bu_panels WHERE name='ZZBCF Old'").fetchone()[0] == "CG")
    a._ensure_runtime_schema()
    s.check("...running it again changes nothing (guarded)",
            [r[1] for r in cn.execute("PRAGMA table_info(calib_bu_panels)")].count("tag") == 1)
    cn.execute("DELETE FROM calib_bu_panels WHERE name='ZZBCF Old'")
    cn.commit()
    cn.close()
    with a.app.app_context():
        s.check("bu_panel_tag reads anything but BGCFO as CG",
                [a.bu_panel_tag(x) for x in ("BGCFO", "CG", "ceo", "", None)] == ["BGCFO", "CG", "CG", "CG", "CG"])

    # ------------------------------------------------------------------ the save
    s.section("the save: absent is not empty; a listed value only; the super admin's only")
    r = post(C_SU, form("ZZBCF Ops panel", [CO], CO, [CGC], {CGC: [(CO, OPS)]}))
    p_ops = panel_by("ZZBCF Ops panel")
    s.check("a new panel without the field is CG", len(p_ops) == 1 and p_ops[0]["tag"] == "CG", (flashes(r)[:120], p_ops))
    r = post(C_SU, form("ZZBCF Finance panel", [CO], CO, [CFO], {CFO: [(CO, FIN)]}, tag="BGCFO"))
    p_fin = panel_by("ZZBCF Finance panel")
    s.check("a new panel with BGCFO is BGCFO", len(p_fin) == 1 and p_fin[0]["tag"] == "BGCFO", (flashes(r)[:120], p_fin))
    pid_fin = p_fin[0]["id"] if p_fin else 0
    r = post(C_SU, form("ZZBCF Finance panel", [CO], CO, [CFO], {CFO: [(CO, FIN)]}, panel_id=pid_fin))
    s.check("an edit without the field keeps BGCFO (absent is not empty)",
            panel_by("ZZBCF Finance panel")[0]["tag"] == "BGCFO", (flashes(r)[:120], panel_by("ZZBCF Finance panel")))
    n0, w0 = n_panels(), n_saves()
    for bad in ("ceo", "", "bgcfo", "CG,BGCFO"):
        try:   # a guard that is missing may crash the save: that is a red check, not a crashed suite
            fl = flashes(post(C_SU, form("ZZBCF Bad tag", [HQ], HQ, [CGC], {CGC: [(HQ, LEG)]}, tag=bad)))   # otherwise a good form
        except Exception as e:   # noqa: BLE001
            fl = "raised %r" % e
        s.check("a bad tag %r on a new panel is refused with a plain message, nothing written" % bad,
                "Pick the tag" in fl and n_panels() == n0 and n_saves() == w0 and not panel_by("ZZBCF Bad tag"), fl[:140])
    try:
        fl = flashes(post(C_SU, form("ZZBCF Finance panel", [CO], CO, [CFO], {CFO: [(CO, FIN)]}, tag="ceo", panel_id=pid_fin)))
    except Exception as e:   # noqa: BLE001
        fl = "raised %r" % e
    s.check("...and on an edit: refused, the stored tag unchanged, nothing logged",
            "Pick the tag" in fl and panel_by("ZZBCF Finance panel")[0]["tag"] == "BGCFO" and n_saves() == w0, fl[:140])
    pv = C_SU.post("/admin/leaders", data=form("ZZBCF Preview", [HQ], HQ, [CGC], {CGC: [(HQ, LEG)]}, tag="ceo",
                                               action="bu_panel_preview")).get_json() or {}
    s.check("step 3's preview refuses a bad tag too, and takes a good one",
            pv.get("ok") is False and "Pick the tag" in str(pv.get("error"))
            and (C_SU.post("/admin/leaders", data=form("ZZBCF Preview", [HQ], HQ, [CGC], {CGC: [(HQ, LEG)]}, tag="BGCFO",
                                                       action="bu_panel_preview")).get_json() or {}).get("ok") is True, pv)
    if C_BGA:
        n1 = n_panels()
        r = post(C_BGA, form("ZZBCF BG admin", [CO], CO, [CGC], {CGC: [(CO, OPS)]}, tag="BGCFO"))
        s.check("a non-super admin's save is refused, as today (the panel route is the super admin's)",
                n_panels() == n1 and not panel_by("ZZBCF BG admin"), flashes(r)[:120])
    s.check("no new route or admin item: the save is the existing leaders.calib_groups one",
            "bu_panel_save=_it(\"leaders.calib_groups\")" in src and "panel_tag" not in src.split("ADMIN_ACCESS_MAP")[1][:6000])
    # the audit line names the tag, and a change of it
    r = post(C_SU, form("ZZBCF Finance panel", [CO], CO, [CFO], {CFO: [(CO, FIN)]}, tag="CG", panel_id=pid_fin))
    det = H.one(a, "SELECT detail FROM activity_log WHERE action='bu_panel_save' AND detail LIKE '%ZZBCF Finance panel%' "
                   "ORDER BY id DESC LIMIT 1")
    s.check("the audit line names the tag and what it was", "; tag CG (was BGCFO) (changed)" in det, det)
    r = post(C_SU, form("ZZBCF Finance panel", [CO], CO, [CFO], {CFO: [(CO, FIN)]}, tag="BGCFO", panel_id=pid_fin))
    s.check("...and back to BGCFO", panel_by("ZZBCF Finance panel")[0]["tag"] == "BGCFO")

    # the tag after a lock
    s.section("after a calibrator has locked: the tag can change, who and how stay locked")
    with a.app.app_context():
        db = a.get_db()
        gid_fin = db.execute("SELECT id FROM calib_bu_groups WHERE panel_id=? AND active=1", (pid_fin,)).fetchone()[0]
        lock(db, "pm_calibration_sessions", "buceo", a.BU_GROUP_PREFIX + str(gid_fin), CFO)
    r = post(C_SU, form("ZZBCF Finance panel", [CO], CO, [CFO], {CFO: [(CO, FIN)]}, tag="CG", panel_id=pid_fin))
    s.check("a tag change goes through once the calibrator has locked", panel_by("ZZBCF Finance panel")[0]["tag"] == "CG",
            flashes(r)[:160])
    r = post(C_SU, form("ZZBCF Finance panel", [CO], CO, [CFO], {CFO: [(CO, FIN), (CO, SAL)]}, tag="BGCFO", panel_id=pid_fin))
    s.check("...while a change of departments is refused, naming the name and tag rule, and the tag is NOT taken",
            "only its name and tag can change" in flashes(r) and panel_by("ZZBCF Finance panel")[0]["tag"] == "CG",
            flashes(r)[:200])
    r = post(C_SU, form("ZZBCF Finance panel", [CO], CO, [CGC], {CGC: [(CO, FIN)]}, tag="BGCFO", panel_id=pid_fin))
    s.check("...and so is swapping the calibrator", "only its name and tag can change" in flashes(r)
            and panel_by("ZZBCF Finance panel")[0]["tag"] == "CG", flashes(r)[:200])
    r = post(C_SU, form("ZZBCF Finance panel renamed", [CO], CO, [CFO], {CFO: [(CO, FIN)]}, tag="BGCFO", panel_id=pid_fin))
    s.check("...a rename with the tag together is allowed", panel_by("ZZBCF Finance panel renamed")
            and panel_by("ZZBCF Finance panel renamed")[0]["tag"] == "BGCFO", flashes(r)[:160])
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM pm_calibration_sessions WHERE business_group=?", (BG,))
        db.commit()
    post(C_SU, form("ZZBCF Finance panel", [CO], CO, [CFO], {CFO: [(CO, FIN)]}, tag="BGCFO", panel_id=pid_fin))

    # the rest of the fixture: a BU CEO with a BGCFO panel, someone with both kinds
    r = post(C_SU, form("ZZBCF Legal panel", [HQ], HQ, [CEO], {CEO: [(HQ, LEG)]}, tag="BGCFO"))
    s.check("fixture: a BU CEO (of another unit) calibrates a BGCFO panel", len(panel_by("ZZBCF Legal panel")) == 1,
            flashes(r)[:140])
    r = post(C_SU, form("ZZBCF Sales panel", [CO], CO, [BOT], {BOT: [(CO, SAL)]}, tag="CG"))
    r2 = post(C_SU, form("ZZBCF Tax panel", [CO], CO, [BOT], {BOT: [(CO, TAX)]}, tag="BGCFO"))
    s.check("fixture: someone calibrates a CG panel and a BGCFO panel",
            len(panel_by("ZZBCF Sales panel")) == 1 and len(panel_by("ZZBCF Tax panel")) == 1,
            (flashes(r)[:100], flashes(r2)[:100]))
    pid_ops = panel_by("ZZBCF Ops panel")[0]["id"]
    pid_leg = panel_by("ZZBCF Legal panel")[0]["id"]

    # ------------------------------------------------------------------ the helpers
    s.section("the view's label, for each kind of login")
    with a.app.app_context():
        db = a.get_db()
        U = {k: user(v) for k, v in dict(cfo=CFO, cgc=CGC, bot=BOT, ceo=CEO, bc2=BC2).items()}
        lab = lambda k: a._view_cg_label(db, U[k], "bu")   # noqa: E731
        s.check("_view_cg_label: BGCFO-only -> BGCFO, CG-only -> CG, both kinds -> CG, a BU CEO -> None, a plain BU CEO -> None",
                (lab("cfo"), lab("cgc"), lab("bot"), lab("ceo"), lab("bc2")) == ("BGCFO", "CG", "CG", None, None),
                (lab("cfo"), lab("cgc"), lab("bot"), lab("ceo"), lab("bc2")))
        s.check("...only for the BU-level view", a._view_cg_label(db, U["cfo"], "bg") is None
                and a._view_cg_label(db, U["cfo"], "team") is None)
        s.check("_view_is_cg stays True for both kinds (the gates' question)",
                a._view_is_cg(db, U["cfo"], "bu") and a._view_is_cg(db, U["cgc"], "bu") and a._view_is_cg(db, U["bot"], "bu")
                and not a._view_is_cg(db, U["ceo"], "bu"))
        s.check("BGCFO calibrator: short BGCFO, title BGCFO Calibration, Help label BGCFO",
                (a._view_short(db, U["cfo"], "bu"), a._view_title(db, U["cfo"], "bu"), a._help_view_label(db, U["cfo"], "bu"))
                == ("BGCFO", "BGCFO Calibration", "BGCFO"))
        s.check("CG calibrator: CG / CG Calibration / CG, as before",
                (a._view_short(db, U["cgc"], "bu"), a._view_title(db, U["cgc"], "bu"), a._help_view_label(db, U["cgc"], "bu"))
                == ("CG", "CG Calibration", "CG"))
        s.check("both kinds: CG / CG Calibration / CG",
                (a._view_short(db, U["bot"], "bu"), a._view_title(db, U["bot"], "bu"), a._help_view_label(db, U["bot"], "bu"))
                == ("CG", "CG Calibration", "CG"))
        s.check("a BU CEO with a BGCFO panel keeps BU / Business unit calibration",
                (a._view_short(db, U["ceo"], "bu"), a._view_title(db, U["ceo"], "bu")) == ("BU", "Business unit calibration"))
        s.check("the dept view keeps its words for the BGCFO calibrator",
                a._view_short(db, U["cfo"], "dept") == "Dept" and a._view_title(db, U["cfo"], "dept") == "Department Review")
        T = a._calibrator_tags(db)
        s.check("_calibrator_tags: by kind with each kind's panel names",
                T.get(CFO) == {"BGCFO": ["ZZBCF Finance panel"]} and T.get(CGC) == {"CG": ["ZZBCF Ops panel"]}
                and T.get(BOT) == {"CG": ["ZZBCF Sales panel"], "BGCFO": ["ZZBCF Tax panel"]}
                and T.get(CEO) == {"BGCFO": ["ZZBCF Legal panel"]}, {k: T.get(k) for k in (CFO, CGC, BOT, CEO)})
        s.check("_calibrator_tags narrows to the ids asked and _calibrator_group_names is unchanged (names only)",
                set(a._calibrator_tags(db, [CFO])) == {CFO}
                and a._calibrator_group_names(db, [CFO, BOT]) == {CFO: ["ZZBCF Finance panel"],
                                                                  BOT: ["ZZBCF Sales panel", "ZZBCF Tax panel"]},
                a._calibrator_group_names(db, [CFO, BOT]))
        s.check("the caches carry the panel's tag as role_tag (the calibrators' own `tag` is untouched)",
                a.bu_panels_all(db)[pid_fin]["role_tag"] == "BGCFO" and a.bu_panels_all(db)[pid_ops]["role_tag"] == "CG"
                and all(g["role_tag"] == a.bu_panels_all(db)[g["panel_id"]]["role_tag"] for g in a.bu_groups_all(db).values()
                        if g["business_group"] == BG))
        pc = a._person_calibrates(db, BOT)
        s.check("_person_calibrates carries the tag", sorted((x["name"], x["tag"]) for x in pc)
                == [("ZZBCF Sales panel", "CG"), ("ZZBCF Tax panel", "BGCFO")], pc)

    # ------------------------------------------------------------------ People > Users
    s.section("People > Users: the chip, its hover; both kinds two chips; the Calibrators filter keeps both")
    pg = C_SU.get("/admin/users?role=cg&q=ZZ+Bcf&per_page=100").get_data(as_text=True)
    ch = lambda sfx: chips(row_of(pg, "ZZ Bcf " + sfx))   # noqa: E731
    s.check("a BGCFO-only calibrator: a BGCFO chip, hover 'BG CFO of <panel>'",
            ch("CFO") == [("BGCFO", "BG CFO of ZZBCF Finance panel")], ch("CFO"))
    s.check("a CG-only calibrator: CG, 'Calibrator of <panel>' as today", ch("CGC") == [("CG", "Calibrator of ZZBCF Ops panel")], ch("CGC"))
    s.check("both kinds: two chips, each with its own panels",
            ch("BOT") == [("CG", "Calibrator of ZZBCF Sales panel"), ("BGCFO", "BG CFO of ZZBCF Tax panel")], ch("BOT"))
    s.check("a BU CEO with a BGCFO panel: BU CEO + BGCFO chips",
            [c[0] for c in ch("CEO")] == ["BU CEO", "BGCFO"] and ch("CEO")[1][1] == "BG CFO of ZZBCF Legal panel", ch("CEO"))
    s.check("the Calibrators filter keeps both kinds", all(row_of(pg, "ZZ Bcf " + x) for x in ("CFO", "CGC", "BOT")))
    s.check("the chip keeps the green is-cg class for both",
            len(re.findall(r'class="adm-role is-cg"', row_of(pg, "ZZ Bcf BOT"))) == 2)

    # ------------------------------------------------------------------ the admin person page
    s.section("the admin person page: header chip and the Roles line")
    pp = lambda uid: C_SU.get("/admin/users/%d" % uid).get_data(as_text=True)   # noqa: E731
    pbadges = lambda pg_: re.findall(r'<(?:span|a) class="pp-role is-cg(?: is-link)?"[^>]*>([^<]*)</(?:span|a)>', html.unescape(pg_))   # noqa: E731  (a link since 2026-11-09: the chip opens the group's review)
    cl = lambda pg_: [(html.unescape(w).strip(), html.unescape(t)) for w, t in re.findall(   # noqa: E731
        r'data-cg-line><span><b>([^<]*)</b> <span class="muted">· ([^<]*)</span>', pg_)]
    pg_cfo, pg_cgc, pg_bot = pp(CFO), pp(CGC), pp(BOT)
    s.check("BGCFO-only: header chip 'BGCFO · <panel>'", pbadges(pg_cfo) == ["BGCFO · ZZBCF Finance panel"], pbadges(pg_cfo))
    s.check("CG-only: 'CG · <panel>' as today", pbadges(pg_cgc) == ["CG · ZZBCF Ops panel"], pbadges(pg_cgc))
    s.check("both kinds: one chip each", pbadges(pg_bot) == ["CG · ZZBCF Sales panel", "BGCFO · ZZBCF Tax panel"], pbadges(pg_bot))
    n_cfo = H.one(a, "SELECT COUNT(*) FROM users t WHERE t.business_group=? AND t.role!='admin' AND t.left_at IS NULL AND "
                     "t.department=?", (BG, FIN))
    s.check("BGCFO-only: Roles line 'BG CFO · calibrates <panel> (n people)'",
            cl(pg_cfo) == [("BG CFO", "calibrates ZZBCF Finance panel (%d people)" % n_cfo)], cl(pg_cfo))
    s.check("CG-only: 'Calibrator · calibrates ...' as today", [w for w, _t in cl(pg_cgc)] == ["Calibrator"], cl(pg_cgc))
    s.check("both kinds: one line per kind", [w for w, _t in cl(pg_bot)] == ["Calibrator", "BG CFO"]
            and "ZZBCF Sales panel" in cl(pg_bot)[0][1] and "ZZBCF Tax panel" in cl(pg_bot)[1][1], cl(pg_bot))
    pg_none = pp(P["O"][0])
    s.check("someone who calibrates nothing: the one Calibrator line, 'calibrates no group'",
            cl(pg_none) == [("Calibrator", "calibrates no group")], cl(pg_none))
    s.check("the Roles list line says 'BG CFO of <panel>' for BGCFO, 'Calibrator of' for CG",
            "BG CFO of ZZBCF Finance panel" in html.unescape(pg_cfo) and "Calibrator of ZZBCF Ops panel" in html.unescape(pg_cgc)
            and "Calibrator of ZZBCF Finance panel" not in html.unescape(pg_cfo))

    # ------------------------------------------------------------------ Leaders > BU CEOs
    s.section("Leaders > BU CEOs: the BGCFO chip after 'Calibration panel'; CG panels unchanged")
    lp = C_SU.get("/admin/leaders?bg=%s&tab=buceo" % BG.replace(" ", "+")).get_data(as_text=True)

    def panel_row(name):
        for tr in re.findall(r'<tr class="ld-subrow"[^>]*>.*?</tr>', lp, re.S):
            if ('title="Who is in %s"' % name) in tr and "Calibration panel</span>" in tr:
                return tr
        return ""
    r_fin, r_ops = panel_row("ZZBCF Finance panel"), panel_row("ZZBCF Ops panel")
    chip_fin = re.search(r'Calibration panel</span>\s*<span class="adm-role is-cg ld-ptag" title="BG CFO \(BGCFO\)">BGCFO</span>', r_fin)
    s.check("a BGCFO panel's line: the BGCFO chip right after the 'Calibration panel' chip", bool(r_fin) and bool(chip_fin), r_fin[:300])
    s.check("a CG panel's line has no tag chip (today's line)", bool(r_ops) and "adm-role" not in r_ops and "BGCFO" not in r_ops, r_ops[:300])
    forms = re.findall(r'<form method="post" class="adm-panel-form bp-form".*?</form>', lp, re.S)
    blk = lambda pid: next((f for f in forms if 'name="panel_id" value="%d"' % pid in f), "")   # noqa: E731
    s.check("every panel's Manage form is on the page, and the add form (no panel_id) too",
            all(blk(x) for x in (pid_fin, pid_ops, pid_leg)) and any('name="panel_id"' not in f for f in forms), len(forms))
    radios = lambda b: re.findall(r'<input type="radio" name="panel_tag" value="(\w+)"( checked)?>', b)   # noqa: E731
    s.check("...Manage on the BGCFO panel preselects BGCFO", radios(blk(pid_fin)) == [("CG", ""), ("BGCFO", " checked")], radios(blk(pid_fin)))
    s.check("...on the CG panel preselects CG", radios(blk(pid_ops)) == [("CG", " checked"), ("BGCFO", "")], radios(blk(pid_ops)))
    bnew = next((f for f in forms if 'name="panel_id"' not in f), "")
    s.check("...a new panel preselects CG", radios(bnew) == [("CG", " checked"), ("BGCFO", "")], radios(bnew))
    s.check("the section reads 'Their tag' with its two hints, each radio with its chip",
            all(x in blk(pid_fin) for x in ("Their tag", "What shows beside the calibrators&#39;", "Same abilities either way",
                                           "BG CFO is for a business group&#39;s CFO calibrating that group&#39;s finance people.",
                                           'title="BG CFO (BGCFO)">BGCFO</span>', 'title="Calibrator (CG)">CG</span>'))
            or all(x in html.unescape(blk(pid_fin)) for x in ("Their tag", "What shows beside the calibrators' names",
                                                              "BG CFO is for a business group's CFO calibrating that group's finance people.")))
    ub = html.unescape(blk(pid_fin))
    s.check("step 3's note for the BGCFO panel is board 2's BGCFO words, word for word",
            ("They become a Calibrator, tagged BG CFO (BGCFO). They get the Calibrator role's abilities on Roles & access › "
             "Leader roles: see the group's curve, move a band, fit with AI, lock the group. Their AI+ check-in shows a BGCFO "
             "tab, and the BGCFO tag shows beside their name. Taking them off this panel ends the role.") in
            re.sub(r"<[^>]+>", "", re.search(r"data-bp-cg-note>(.*?)</div>", ub, re.S).group(1)), ub[:200])
    ub2 = html.unescape(blk(pid_ops))
    s.check("...the CG panel's note is today's CG words",
            ("They become a Calibrator (CG). They get the role's abilities on Roles & access › Leader roles: see the group's "
             "curve, move a band, fit with AI, lock the group. Their AI+ check-in shows a CG tab, and the CG tag shows beside "
             "their name. Taking them off this panel ends the role.") in
            re.sub(r"<[^>]+>", "", re.search(r"data-bp-cg-note>(.*?)</div>", ub2, re.S).group(1)))
    s.check("...both notes sit in <template>s for the script to swap in (no reload)",
            'template data-bp-cg-tpl="CG"' in ub and 'template data-bp-cg-tpl="BGCFO"' in ub
            and 'e.target.name !== "panel_tag"' in open(os.path.join(ROOT, "static", "bu_panel.js"), encoding="utf-8").read())
    s.check("the Manage lock note reads '...only the panel's name and tag can change this cycle.'",
            "Once any calibrator has locked, only the panel&#39;s name and tag can change this cycle." in blk(pid_fin)
            or "Once any calibrator has locked, only the panel's name and tag can change this cycle." in ub)

    # ------------------------------------------------------------------ the check-in tab
    s.section("the AI+ check-in: the tab and its title (key stays bu)")
    C_CFO, C_CGC, C_BOT, C_CEO = (H.client_as(a, x) for x in (CFO, CGC, BOT, CEO))
    pg_c = C_CFO.get("/review/journey?view=bu").get_data(as_text=True)
    s.check("the BGCFO calibrator's tab: text BGCFO, title 'BGCFO Calibration', key bu, no CG/BU naming",
            'href="/review/journey?view=bu"' in pg_c and 'title="BGCFO Calibration">BGCFO</a>' in pg_c
            and 'title="CG Calibration"' not in pg_c and 'Business unit calibration' not in pg_c, pg_c.count("BGCFO"))
    pg_g = C_CGC.get("/review/journey?view=bu").get_data(as_text=True)
    s.check("the CG calibrator's tab is as before", 'title="CG Calibration">CG</a>' in pg_g and "BGCFO" not in pg_g)
    pg_b = C_BOT.get("/review/journey?view=bu").get_data(as_text=True)
    s.check("both kinds: CG / 'CG Calibration'", 'title="CG Calibration">CG</a>' in pg_b and "BGCFO" not in pg_b)
    pg_e = C_CEO.get("/review/journey?view=bu").get_data(as_text=True)
    s.check("a BU CEO with a BGCFO panel: BU / 'Business unit calibration'",
            'title="Business unit calibration">BU</a>' in pg_e and "BGCFO" not in pg_e)
    mv = open(os.path.join(ROOT, "static", "move.js"), encoding="utf-8").read()
    s.check("move.js: 'BGCFO Calibration' -> 'Moving to BGCFO calibration'; CG's string still there",
            '"BGCFO Calibration"' in mv and "Moving to BGCFO calibration" in mv and "Moving to CG calibration" in mv)

    # ------------------------------------------------------------------ the dashboard card
    s.section("the dashboard card: the switch beside Own (title 'Your Calibration Group' stays)")
    d_cfo = C_CFO.get("/dashboard").get_data(as_text=True)
    s.check("a BGCFO calibrator's card: title unchanged, the switch BGCFO (hover 'BG CFO'), not CG",
            "Your Calibration Group" in d_cfo and re.search(r'title="BG CFO"[^>]*>BGCFO<', d_cfo)
            and not re.search(r'data-lt-tab="bu"[^>]*>CG<', d_cfo), re.findall(r'data-lt-tab="bu"[^>]*>[^<]*<', d_cfo))
    d_cgc = C_CGC.get("/dashboard").get_data(as_text=True)
    s.check("a CG calibrator's card is as before: CG, hover 'Calibration Group'",
            re.search(r'title="Calibration Group"[^>]*>CG<', d_cgc) and "BGCFO" not in d_cgc)
    d_bot = C_BOT.get("/dashboard").get_data(as_text=True)
    s.check("both kinds: the switch reads CG", re.search(r'title="Calibration Group"[^>]*>CG<', d_bot) and "BGCFO" not in d_bot)
    d_bc2 = H.client_as(a, BC2).get("/dashboard").get_data(as_text=True)
    s.check("a plain BU CEO's card is untouched: Where your BU is, BU", "Where your BU is" in d_bc2 and "BGCFO" not in d_bc2)
    with a.app.test_request_context("/dashboard"):
        db = a.get_db()
        card = a.dash_bu_status(db, user(CFO), db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone())
    s.check("the card's head carries the label (group_tag BGCFO)", card and card.get("group_tag") == "BGCFO", card and card.get("group_tag"))

    # ------------------------------------------------------------------ Help and Ask OneHR
    s.section("Help's seat answer; Ask OneHR's facts")
    ans = lambda cl_: " ".join(i["a"] for i in (cl_.get("/help/answers", query_string={"ep": "dashboard"}).get_json() or {}).get("items", []))   # noqa: E731
    a_cfo, a_cgc, a_bot = ans(C_CFO), ans(C_CGC), ans(C_BOT)
    s.check("a BGCFO calibrator's answer says 'switch to BGCFO above the left panel'",
            "switch to BGCFO above the left panel" in a_cfo and "switch to CG above" not in a_cfo, a_cfo[:200])
    s.check("a CG calibrator's answer is as today ('switch to CG above the left panel')",
            "switch to CG above the left panel" in a_cgc and "BGCFO" not in a_cgc, a_cgc[:200])
    s.check("both kinds: CG's answer", "switch to CG above the left panel" in a_bot and "BGCFO" not in a_bot)
    s.check("the dashboard's own-card answer: BGCFO switches to Own for a BG CFO, CG switches to Own as before",
            "BGCFO switches to Own, your own results." in a.HELP_QA["dash_bgcfo"][1]
            and "CG switches to Own, your own results." in a.HELP_QA["dash_cg"][1]
            and a.HELP_QA["dash_bgcfo"][0] == a.HELP_QA["dash_cg"][0]
            and '"dash_bgcfo" if _view_cg_label(db, u, "bu") == "BGCFO" else "dash_cg"' in src)
    q = {"ep": "review_journey", "view": "bu", "stage": "calibration"}
    h_ = C_CFO.get("/help/answers", query_string=q).get_json() or {}
    s.check("the check-in's Help heading and where-line say BGCFO", str(h_.get("label", "")).startswith("BGCFO · ")
            and "BGCFO" in str(h_.get("where", "")), (h_.get("label"), h_.get("where")))
    s.check("HELP_QA has seat_bgcfo beside seat_cg", "seat_bgcfo" in a.HELP_QA and a.HELP_QA["seat_bgcfo"][0] == a.HELP_QA["seat_cg"][0])
    with a.app.test_request_context("/dashboard"):
        db = a.get_db()
        ctx_ = a._dash_context(db, user(CFO)) if hasattr(a, "_dash_context") else None
        facts = "\n".join(a._ask_facts(db, user(CFO), ctx_)[0]) if ctx_ is not None else ""
        facts_g = "\n".join(a._ask_facts(db, user(CGC), a._dash_context(db, user(CGC)))[0]) if ctx_ is not None else ""
    s.check("Ask OneHR's facts: a BG CFO is told the tab and the switch read BGCFO, and the view line says BGCFO Calibration; "
            "a CG calibrator is told neither", "BG CFO (BGCFO)" in facts and "BGCFO Calibration" in facts
            and "BGCFO" not in facts_g and "CG Calibration" in facts_g, [x for x in facts.split("\n") if "BGCFO" in x][:3])

    # ------------------------------------------------------------------ the KB
    s.section("the KB row: one guarded rewording")
    with a.app.app_context():
        db = a.get_db()
        kb_now = db.execute("SELECT body, tags FROM kb_entries WHERE slug='bu-calibration-groups'").fetchone()
        s.check("the seed text carries board 7's sentence",
                "A panel is tagged Calibrator (CG) or BG CFO (BGCFO): a business group's CFO calibrating the group's finance "
                "people carries the BGCFO tag, and their AI+ check-in tab reads BGCFO. The abilities are the same."
                in a._BU_GROUPS_KB and "carries the CG tag" in a._BU_GROUPS_KB)
        guard = ("UPDATE kb_entries SET body=?, tags=COALESCE(tags,'') || ',bgcfo,bg cfo' WHERE slug='bu-calibration-groups' AND "
                 "body LIKE '%the Calibrator chip on the Filter line names each calibrator%' AND body NOT LIKE '%BGCFO%'")
        s.check("the guard in app.py is exactly this statement", guard.replace("%", "%") in
                src.replace('"\n                  "', "").replace("\n", " ") or "the Calibrator chip on the Filter line names each calibrator%' AND body NOT LIKE '%BGCFO%'" in src.replace('"\n                  "', ""))
        before = a._BU_GROUPS_KB.replace(
            " A panel is tagged Calibrator (CG) or BG CFO (BGCFO): a business group's CFO calibrating the group's finance "
            "people carries the BGCFO tag, and their AI+ check-in tab reads BGCFO. The abilities are the same.", "")
        s.check("fixture: the row before has the phrase and no BGCFO", "the Calibrator chip on the Filter line names each calibrator" in before
                and "BGCFO" not in before and before != a._BU_GROUPS_KB)
        run = lambda: db.execute(   # noqa: E731
            "UPDATE kb_entries SET body=?, tags=COALESCE(tags,'') || ',bgcfo,bg cfo' WHERE slug='bu-calibration-groups' AND "
            "body LIKE '%the Calibrator chip on the Filter line names each calibrator%' AND body NOT LIKE '%BGCFO%'",
            (a._BU_GROUPS_KB,)).rowcount
        db.execute("UPDATE kb_entries SET body=?, tags='calibration group,cfo' WHERE slug='bu-calibration-groups'", (before,))
        n1 = run()
        got = db.execute("SELECT body, tags FROM kb_entries WHERE slug='bu-calibration-groups'").fetchone()
        s.check("the current row is rewritten once, its tags gain the new words", n1 == 1 and got["body"] == a._BU_GROUPS_KB
                and got["tags"] == "calibration group,cfo,bgcfo,bg cfo", (n1, got["tags"]))
        s.check("a second run is a no-op", run() == 0 and db.execute("SELECT tags FROM kb_entries WHERE slug='bu-calibration-groups'"
                                                                    ).fetchone()[0] == "calibration group,cfo,bgcfo,bg cfo")
        edited = "Group People's own hand-edited words about calibrators."
        db.execute("UPDATE kb_entries SET body=? WHERE slug='bu-calibration-groups'", (edited,))
        s.check("a hand-edited body (without the phrase) is left alone", run() == 0 and db.execute(
            "SELECT body FROM kb_entries WHERE slug='bu-calibration-groups'").fetchone()[0] == edited)
        db.execute("UPDATE kb_entries SET body=?, tags=? WHERE slug='bu-calibration-groups'", (KB0["body"], KB0["tags"]) if KB0
                   else (a._BU_GROUPS_KB, kb_now["tags"]))
        db.commit()
    s.check("the migration carries that statement (beside the earlier rewordings)",
            "'%the Calibrator chip on the Filter line names each calibrator%' AND body NOT LIKE '%BGCFO%'" in src)

    # ------------------------------------------------------------------ no ability moves
    s.section("labels only: the abilities are the Calibrator role's, whatever the tag")
    with a.app.app_context():
        db = a.get_db()
        s.check("leader_can for a BGCFO calibrator reads the same cg.* as a CG calibrator's, and a BGCFO panel adds no role key",
                all(a.leader_can(user(CFO), ab, db) == a.leader_can(user(CGC), ab, db)
                    for ab in ("cg.view", "cg.move", "cg.lock", "cg.fit"))
                and "BGCFO" not in str(a.LEADER_TIER_ROLE) and a.LEADER_TIER_ROLE["bugrp"] == "cg")
        s.check("calibration_tier_of is the same bugrp tier for both",
                [t for t, _k in a.calibration_tier_of(db, user(CFO))] == ["bugrp"]
                and [t for t, _k in a.calibration_tier_of(db, user(CGC))] == ["bugrp"])
finally:
    a.ai_draft.review_agent_available, a._calib_assist_on = _avail, _assist
    with a.app.app_context():
        db = a.get_db()
        _cleanup(db)
        db.execute("DELETE FROM leader_role_access")
        db.executemany("INSERT INTO leader_role_access(role, ability, allowed, updated_by) VALUES (?,?,?,?)", LEADER0)
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN (%s)" % ",".join("?" * len(CELLS)), (CID,) + CELLS)
        db.executemany("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", WIN0)
        for m_ in ("pm", "tm", "idp", "calibration", "review"):
            db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key=?", (CID, m_))
        db.executemany("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", MOD0)
        db.execute("UPDATE cycles SET half=? WHERE id=?", (HALF0, CID))
        db.commit()
sys.exit(s.done())
