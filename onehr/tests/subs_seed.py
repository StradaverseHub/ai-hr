"""A made-up group of synthetic people for the "Who has submitted" suite and its browser QC (not a suite: run.sh only runs
test_*.py). Everything is ZZ9SB-... and put back by `teardown`. No real person is in it: the names are "Staff member NN", and
each has a display name the panel must never show."""
BG, BG2 = "ZZSB GROUP", "ZZSB OTHER GROUP"
U1, U2, U3 = "ZZSB BUILDING SUPPLIES SDN BHD", "ZZSB LOGISTICS SDN BHD", "ZZSB OTHER SDN BHD"
D_S, D_O, D_F, D_X = "SALES & MARKETING", "OPERATIONS", "FLEET", "OTHER DEPARTMENT"
DISPLAY = "ZZSecretDisplay"    # every synthetic person's display name: it must appear nowhere in the panel's payload
BAND = "ZZBANDLEAK"            # planted in a remark and a band column: no payload holds it
PREF = {BG: "Northwind Materials", (BG, U1): "Northwind Building Supplies Sdn Bhd", (BG, U2): "Northwind Logistics Sdn Bhd"}

# key: (unit, dept, hod, line manager, kpi, competency, plan, 360 (given, owed))
#   kpi / competency: None (not part of it), 'done', 'mod' (done and moderated / reviewed), 'no', 'behalf', 'late'
#   plan: None, 'shared', 'no'
PEOPLE = {
    "S01": (U1, D_S, "H1", "M1", "mod", "mod", "shared", (3, 3)),
    "S02": (U1, D_S, "H1", "M1", "done", "no", "no", (1, 3)),
    "S03": (U1, D_S, "H1", "M1", "no", "no", "no", (0, 3)),
    "S04": (U1, D_S, "H1", "M2", "late", "no", "no", (2, 3)),
    "S05": (U1, D_S, "H1", "M2", "behalf", "behalf", "no", (3, 3)),
    "S06": (U1, D_S, "H1", "M2", "done", "done", "shared", None),
    "S07": (U1, D_S, "H1", None, "no", None, "no", None),
    "O01": (U1, D_O, "H2", "M3", "mod", "mod", "shared", (2, 2)),
    "O02": (U1, D_O, "H2", "M3", "no", "no", "no", (0, 2)),
    "O03": (U1, D_O, "H2", "M3", "done", "done", "no", (2, 2)),
    "F01": (U2, D_F, "H3", "M4", "no", "no", "no", (0, 1)),
    "F02": (U2, D_F, "H3", "M4", "mod", "mod", "shared", (1, 1)),
    "F03": (U2, D_F, "H3", "M4", "done", "no", "no", None),
    "X01": (U3, D_X, "H4", "M5", "no", "no", "no", (0, 1)),
    "X02": (U3, D_X, "H4", "M5", "done", "done", "shared", (1, 1)),
}
LEADERS = ("H1", "H2", "H3", "H4", "M1", "M2", "M3", "M4", "M5", "C1", "G1", "K1", "X1")


def seed(a, db, cid, cyc, skill):
    """Insert the synthetic org, its people and their parts into the open scratch DB; return {key: user id}."""
    ID = {}
    if skill is None:   # the synthetic fixture has no skills: make one, taken out again by teardown
        skill = db.execute("INSERT INTO tc_skills(skill_code, title) VALUES ('ZZ9SB-SKILL', 'ZZ9SB skill')").lastrowid
    for bg, co in ((BG, U1), (BG, U2), (BG2, U3)):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (bg, co))
    for bg in (BG, BG2):   # a scoring rule, so a moderated line has a final figure to read (never shown anywhere)
        db.execute("INSERT OR REPLACE INTO pm_bg_config(business_group, mechanism, variant) VALUES (?,'B','base')", (bg,))
    db.execute("INSERT OR REPLACE INTO org_bg_display(business_group, preferred_name) VALUES (?,?)", (BG, PREF[BG]))
    for k in ((BG, U1), (BG, U2)):
        db.execute("UPDATE org_units SET preferred_name=? WHERE business_group=? AND company=?", (PREF[k], k[0], k[1]))

    def person(key, bg, co, dept, grade=14, part=True, name=None, hod=None, mgr=None):
        ID[key] = db.execute(
            "INSERT INTO users (username, full_name, display_name, password_hash, role, employee_id, business_group, company, "
            "department, job_grade, years_of_service, email, hod_id, manager_id) VALUES (?,?,?,'x','user',?,?,?,?,?,?,?,?,?)",
            ("zz9sb-" + key.lower(), name or "Staff member " + key, DISPLAY + key, "ZZ9SB-" + key, bg, co, dept, grade,
             3 if part else 0, "zz9sb-%s@example.test" % key.lower(), ID.get(hod) if hod else None,
             ID.get(mgr) if mgr else None)).lastrowid
    # the heads and managers first (the people point at them)
    for k, bg, co, dept in (("H1", BG, U1, D_S), ("H2", BG, U1, D_O), ("H3", BG, U2, D_F), ("H4", BG2, U3, D_X),
                            ("M1", BG, U1, D_S), ("M2", BG, U1, D_S), ("M3", BG, U1, D_O), ("M4", BG, U2, D_F),
                            ("M5", BG2, U3, D_X)):
        person(k, bg, co, dept, grade=18)
    person("C1", BG, U1, "LEADERSHIP", grade=21, name="Staff member C1")
    person("G1", BG, U1, "LEADERSHIP", grade=23, name="Staff member G1")
    person("K1", BG, U1, "LEADERSHIP", grade=22, name="Staff member K1")
    person("X1", BG, U1, "LEADERSHIP", grade=23, name="Staff member X1")   # the Group Chief
    db.execute("UPDATE users SET bgceo_bg=? WHERE id=?", (BG, ID["G1"]))
    for co in (U1, U2):
        db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, co, ID["C1"]))
    for key, (co, dept, hod, mgr, kpi, tc, idp, f360) in PEOPLE.items():
        person(key, BG2 if co == U3 else BG, co, dept, hod=hod, mgr=mgr)
    # the calibrator K1: a group over the Sales department of U1 and the Fleet department of U2
    gk = db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id) VALUES (?,?,?,?)",
                    (BG, U1, "Northwind Sales calibrators", ID["K1"])).lastrowid
    for co, dept in ((U1, D_S), (U2, D_F)):
        db.execute("INSERT INTO calib_bu_group_units(group_id, business_group, company, department) VALUES (?,?,?,?)",
                   (gk, BG, co, dept))
    # the Group Chief X1: two batches
    gx = db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES (?,?)", ("ZZSB Chief group", ID["X1"])).lastrowid
    for key, seg in (("S01", "Batch 1"), ("S02", "Batch 1"), ("O01", "Batch 2"), ("F02", "Batch 2"), ("X02", "Batch 2")):
        db.execute("INSERT INTO pm_calibration_group_members(group_id, subject_id, segment) VALUES (?,?,?)", (gx, ID[key], seg))
    year = a.pm_idp_plan_year(cyc)
    for key, (co, dept, hod, mgr, kpi, tc, idp, f360) in PEOPLE.items():
        sid, bg = ID[key], BG2 if co == U3 else BG
        if kpi:
            t = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, status) "
                           "VALUES (?,?,?,100,'more',?,'approved')", (cid, sid, "ZZSB KPI " + key, bg)).lastrowid
            if kpi in ("done", "mod"):
                db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, draft, admin_filled, submitted_at) VALUES (?,10,0,0,?)",
                           (t, "2026-11-03 02:00:00"))
                db.execute("INSERT INTO pm_review_session(subject_id, cycle_id, locked_at) VALUES (?,?,?)", (sid, cid, "2026-11-03 02:00:00"))
            db.execute("UPDATE pm_kpi_targets SET target=10, threshold=5, excellence=15, unit='%' WHERE id=?", (t,))   # scoreable
            if kpi == "mod":   # every step of its chain acted: the moderation is final
                db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (t, ID[mgr]))
                db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, acted_by, acted_at) "
                           "VALUES (?,1,'confirm',10,?,'2026-11-05 03:00:00')", (t, ID[mgr]))
            if kpi == "behalf":
                db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, adjusted_value, acted_by, "
                           "acted_at, on_behalf) VALUES (?,1,'adjust',NULL,10,?,'2026-11-05 03:00:00',1)", (t, ID[mgr]))
            if kpi == "late":
                db.execute("INSERT INTO late_passes(cycle_id, user_id, cell, subject_id, until_at, reason) VALUES (?,?,'pm_results',?,"
                           "'2099-11-10 15:59:00','ZZSB test')", (cid, sid, sid))
        if tc:
            db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id) VALUES (?,?,?)", (cid, sid, skill))
            st = {"done": "submitted", "mod": "reviewed", "behalf": "reviewed"}.get(tc, "pending")
            db.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status, submitted_at, reviewed_at, on_behalf) "
                       "VALUES (?,?,?,?,?,?)", (cid, sid, st, "2026-11-04 03:00:00" if tc in ("done", "mod") else None,
                                                "2026-11-06 03:00:00" if tc in ("mod", "behalf") else None, 1 if tc == "behalf" else 0))
        if idp:
            db.execute("INSERT INTO pm_idp(plan_year, subject_id, status, shared_at) VALUES (?,?,?,?)",
                       (year, sid, "shared" if idp == "shared" else "draft", "2026-11-05 03:00:00" if idp == "shared" else None))
        if f360:
            given, owed = f360
            pool = [ID[k] for k in (("S01", "S02", "S03", "O01") if bg == BG else ("X01", "X02")) if ID[k] != sid]
            for n in range(owed):   # owed ratings: the rater is this person, the subject a colleague who takes part
                subj = pool[n]
                db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) VALUES (?,?,?,'peer',?)",
                           (cid, subj, sid, "submitted" if n < given else "pending"))
    db.commit()
    return ID


def teardown(db):
    """Take every ZZ9SB row out again (the tables a suite touches; the caller restores windows and cycle fields)."""
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9SB-%'")]
    gids = [r[0] for r in db.execute("SELECT id FROM calib_bu_groups WHERE business_group IN (?,?)", (BG, BG2))]
    if gids:
        db.execute("DELETE FROM calib_bu_group_units WHERE group_id IN (%s)" % ",".join("?" * len(gids)), gids)
        db.execute("DELETE FROM calib_bu_groups WHERE id IN (%s)" % ",".join("?" * len(gids)), gids)
    db.execute("DELETE FROM pm_calibration_group_members WHERE group_id IN (SELECT id FROM pm_calibration_groups WHERE name='ZZSB Chief group')")
    db.execute("DELETE FROM pm_calibration_groups WHERE name='ZZSB Chief group'")
    if ids:
        ph = ",".join("?" * len(ids))
        tg = "SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph
        db.execute("DELETE FROM pm_kpi_approvals WHERE kpi_target_id IN (%s)" % tg, ids)
        db.execute("DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id IN (%s)" % tg, ids)
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (%s)" % tg, ids)
        for sql in ("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)", "DELETE FROM pm_review_session WHERE subject_id IN (%s)",
                    "DELETE FROM tc_assessments WHERE subject_id IN (%s)", "DELETE FROM tc_assignments WHERE subject_id IN (%s)",
                    "DELETE FROM pm_idp WHERE subject_id IN (%s)", "DELETE FROM late_passes WHERE user_id IN (%s)",
                    "DELETE FROM assignments WHERE assessor_id IN (%s) OR subject_id IN (%s)",
                    "DELETE FROM buceo_seats WHERE user_id IN (%s)", "DELETE FROM activity_log WHERE user_id IN (%s)",
                    "DELETE FROM users WHERE id IN (%s)"):
            n = sql.count("%s")
            db.execute(sql % tuple([ph] * n), ids * n)
    db.execute("DELETE FROM tc_skills WHERE skill_code='ZZ9SB-SKILL'")
    db.execute("DELETE FROM pm_bg_config WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM org_bg_display WHERE business_group IN (?,?)", (BG, BG2))
    db.commit()


CELLS = ("pm_results", "tc_self", "idp_self", "f360", "pm_approve", "tc_approve")

# The windows prepare() opens, dated from TODAY (MYT) so the suites never expire (8 Nov 2026: the staff parts were hard-coded to close on
# 8 Nov 23:59, so from 9 Nov 00:00 every suite using this seed saw them closed). They open on 1 Nov (the seeded sign-offs of 3-6 Nov fall
# inside); the staff parts close a week from today, the line managers' two weeks from today.
import datetime as _dt
_TODAY = (_dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(hours=8)).date()
STAFF_CLOSE_D = _TODAY + _dt.timedelta(days=6)
LM_CLOSE_D = _TODAY + _dt.timedelta(days=13)
OPENS = "2026-11-01 00:00"
STAFF_CLOSES = STAFF_CLOSE_D.isoformat() + " 23:59"
LM_CLOSES = LM_CLOSE_D.isoformat() + " 23:59"
CYCLE_ENDS = max(_dt.date(2026, 12, 31), LM_CLOSE_D + _dt.timedelta(days=30)).isoformat()


def closes_label(d):
    """The strip's words for a window closing at 23:59 on date d, e.g. 'Closes 15 Nov, 23:59'."""
    return "Closes %d %s, 23:59" % (d.day, d.strftime("%b"))


def prepare(a, db):
    """Make the active cycle a running Year-End with every part's window open (the staff parts to a week from today, the line managers' to
    two weeks from today), the modules on, then seed the people. Returns (cycle id, user ids, what to give back with `restore`)."""
    cyc = db.execute("SELECT * FROM cycles WHERE is_active=1").fetchone()
    cid = cyc["id"]
    saved = {"cid": cid, "cyc": dict(cyc),
             "win": [tuple(r) for r in db.execute("SELECT cycle_id, cell, opens_at, closes_at FROM cycle_windows WHERE cycle_id=? "
                                                  "AND cell IN (%s)" % ",".join("?" * len(CELLS)), (cid,) + CELLS)],
             "mods": [tuple(r) for r in db.execute("SELECT cycle_id, module_key, active FROM cycle_modules WHERE cycle_id=? AND "
                                                    "module_key IN ('pm','tm','idp','review','calibration')", (cid,))]}
    db.execute("UPDATE cycles SET half=2, ends_on=?, starts_on='2026-11-01' WHERE id=?", (CYCLE_ENDS, cid))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN (%s)" % ",".join("?" * len(CELLS)), (cid,) + CELLS)
    for cell in CELLS:
        db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                   (cid, cell, OPENS, LM_CLOSES if cell in ("pm_approve", "tc_approve") else STAFF_CLOSES))
    for m in ("pm", "tm", "idp", "review", "calibration"):
        db.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (cid, m))
    skill = (db.execute("SELECT id FROM tc_skills ORDER BY id LIMIT 1").fetchone() or [None])[0]
    cyc = db.execute("SELECT * FROM cycles WHERE id=?", (cid,)).fetchone()
    ids = seed(a, db, cid, cyc, skill)
    db.commit()
    return cid, ids, saved


def restore(db, saved):
    """Take the people out and put the cycle, its windows and modules back as prepare found them."""
    teardown(db)
    cid, c = saved["cid"], saved["cyc"]
    db.execute("UPDATE cycles SET half=?, ends_on=?, starts_on=? WHERE id=?", (c["half"], c["ends_on"], c["starts_on"], cid))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN (%s)" % ",".join("?" * len(CELLS)), (cid,) + CELLS)
    db.executemany("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", saved["win"])
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key IN ('pm','tm','idp','review','calibration')", (cid,))
    db.executemany("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", saved["mods"])
    db.commit()


def _pin_dates(text):
    """The digest was pinned when the windows closed on 8 Nov (staff) and 15 Nov (line managers); prepare() now dates them from
    today, so the email's closing dates (and the weekday written with them) are put back to those before hashing. Everything else in the email is hashed as it is."""
    out = text
    for d, iso, was_d, was_iso in ((STAFF_CLOSE_D, STAFF_CLOSES, "8 Nov", "2026-11-08 23:59"), (LM_CLOSE_D, LM_CLOSES, "15 Nov", "2026-11-15 23:59")):
        out = out.replace(iso, was_iso).replace(d.isoformat(), was_iso[:10])
        # the weekday moves with the date too ("until Sun 15 Nov" on 9 Nov, "until Mon 15 Nov" from 10 Nov): back to the weekday it had
        was_wd = _dt.date(2026, 11, int(was_d.split()[0]))
        out = out.replace("%s %d %s" % (d.strftime("%A"), d.day, d.strftime("%B")), "%s %s" % (was_wd.strftime("%A"), {"8 Nov": "8 November", "15 Nov": "15 November"}[was_d]))
        out = out.replace("%s %d %s" % (d.strftime("%a"), d.day, d.strftime("%b")), "%s %s" % (was_wd.strftime("%a"), was_d))
        out = out.replace("%d %s" % (d.day, d.strftime("%B")), {"8 Nov": "8 November", "15 Nov": "15 November"}[was_d])
        out = out.replace("%s %d %s" % (d.strftime("%a"), d.day, d.strftime("%b")), "Sun " + was_d)   # the email names the weekday too (both were Sundays)
        out = out.replace("%d %s" % (d.day, d.strftime("%b")), was_d)
    return out


def email_digest(a, db):
    """A fingerprint of every Leader progress email the synthetic leaders would get (all parts, all roles, nothing skipped):
    each one's subject, body and sections. Taken once on the code before "Who has submitted" changed lp_counts, and pinned in
    test_leader_subs: the email must stay byte for byte what it was. Call inside a request context (the mail builds a URL)."""
    import hashlib
    import json
    from datetime import datetime
    cyc = a.active_cycle(db)
    rules = dict(a.lp_rules())
    rules["parts"] = [p[0] for p in a.LP_PARTS]
    rules["roles"] = [r[0] for r in a.LP_ROLES]
    rules["skip_done"] = False
    built, open_parts, ahead = a.lp_build(db, cyc, rules)
    h, n = hashlib.sha256(), 0
    for b in sorted(built, key=lambda b: (b["role"], b["user"]["employee_id"] or "")):
        if not (b["user"]["employee_id"] or "").startswith("ZZ9SB-"):
            continue
        subj, body = a.lp_mail(db, b["role"], b["user"], b["sections"], open_parts, ahead, cyc, rules=rules,
                               now=datetime(2026, 11, 3, 10, 0), note=b["note"])
        secs = [{k: v for k, v in sec.items() if k != "gid"} for sec in b["sections"]]   # a group's row id is autoincrement
        blob = json.dumps([b["role"], b["user"]["employee_id"], subj, body, secs], sort_keys=True, default=str)
        h.update(_pin_dates(blob).encode())
        n += 1
    return h.hexdigest(), n
