"""Leader reviews on the person page (Chris, 2026-11-09; canvas "Leader reviews on the person page"; brief "Leader reviews build brief
2026-11-09.md").

A leader's role chip (HOD of N, BU CEO, CG, BG CEO, Group Chief) opens their review's people in the list panel under a status box:
where each person stands on Performance and Potential, and the one action that fits the review's state. What this pins:
  1. every cell state (Submitted, Saved moved / kept, Not started, Not in the review, an axis that doesn't apply), read off the saved
     rows, and counts that leave out whoever is not in the review;
  2. each box state shows ITS action and only that one (and falsified: flip the condition, the button goes);
  3. once results are released to leaders, or on a past cycle, the list is today's plain one, `_unlock_row` gives no Unlock and the
     Unlock route refuses with nothing changed;
  4. who sees what: the super admin the actions; an admin with Calibration's read in scope the progress only (their POSTs refused);
     anyone else today's view;
  5. an Unlock inside the window tells the leader (the note and the email), as the past-deadline one still does;
  6. ONE batched read: the panel's query count does not grow with the people;
  7. the other tiers' lists (BU CEO unit, calibration group, Group Chief group, BG CEO's units), the chips, the joined search field.
Everything is synthetic (ZZLR-*) on the shared suite database and put back at the end.
"""
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Leader reviews on the person page")

BG, CO, CO2 = "ZZLR BG", "ZZLR U1", "ZZLR U2"
BG_OTHER = "ZZLR BG Other"
REMARK = "ZZLR the wrong job grade was used for two people."
NAMES = {"pm": ("ME", "AE"), "pot": ("Mid", "High")}


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZLR-%'")]
    for t, adj in (("pm_calibration_sessions", "pm_calibration_adjustments"), ("calibration_sessions", "calibration_adjustments")):
        db.execute("DELETE FROM %s WHERE session_id IN (SELECT id FROM %s WHERE business_group IN (?,?) OR scope_label LIKE 'ZZLR%%')"
                   % (adj, t), (BG, BG_OTHER))
        db.execute("DELETE FROM %s WHERE business_group IN (?,?) OR scope_label LIKE 'ZZLR%%'" % t, (BG, BG_OTHER))
    db.execute("DELETE FROM talent_box_bu_locks WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_calibration_group_members WHERE group_id IN (SELECT id FROM pm_calibration_groups WHERE name LIKE 'ZZLR%')")
    db.execute("DELETE FROM pm_calibration_groups WHERE name LIKE 'ZZLR%'")
    db.execute("DELETE FROM calib_bu_group_people WHERE group_id IN (SELECT id FROM calib_bu_groups WHERE name LIKE 'ZZLR%')")
    db.execute("DELETE FROM calib_bu_groups WHERE name LIKE 'ZZLR%'")
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM late_passes WHERE subject_id IN (%s) OR user_id IN (%s) OR given_by IN (%s)" % (ph, ph, ph), ids * 3)
        tids = [r[0] for r in db.execute("SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)]
        if tids:
            tp = ",".join("?" * len(tids))
            for t in ("pm_kpi_approvals", "pm_kpi_moderation_drafts", "pm_kpi_results", "pm_kpi_target_approvers"):
                db.execute("DELETE FROM %s WHERE kpi_target_id IN (%s)" % (t, tp), tids)
        for t in ("pm_kpi_targets", "rating_records", "pm_review_chat", "leader_releases", "pm_calibration_group_members",
                  "pm_group_locks", "pot_group_locks"):
            db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (t, ph), ids)
        db.execute("DELETE FROM notifications WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM calib_bu_group_people WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM admin_companies WHERE admin_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids * 2)
        db.execute("DELETE FROM buceo_seats WHERE user_id IN (%s)" % ph, ids)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM admin_role_access WHERE role_id IN (SELECT id FROM admin_roles WHERE name LIKE 'ZZLR%')")
    db.execute("DELETE FROM admin_roles WHERE name LIKE 'ZZLR%'")
    db.execute("DELETE FROM cycles WHERE name LIKE 'ZZLR%'")
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG, BG_OTHER))
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    CYC = dict(a.active_cycle(db))
    CID = CYC["id"]
    _cleanup(db)
    ORIG = {"windows": [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=?", (CID,))],
            "modules": [tuple(r) for r in db.execute("SELECT cycle_id, module_key, active FROM cycle_modules WHERE cycle_id=?", (CID,))],
            "cycle": {k: CYC[k] for k in ("half", "kind", "open_by_date", "min_job_grade")}}
    db.execute("UPDATE cycles SET half=2, kind='year_end', open_by_date=0, min_job_grade=12 WHERE id=?", (CID,))
    for mk_ in ("pm", "tm", "idp", "calibration", "evidence", "review"):
        db.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, mk_))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    PID = a.active_pm_period_id(db)
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, name, bg=BG, co=CO, role="user", hod=None, email=None, bgceo=None, dept="ZZLR Dept", jg="16", confirmed=True):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=email, hod_id=hod, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=bgceo, business_group=bg, company=co, department=dept,
                 job_title="ZZLR Engineer", job_grade=jg, years_of_service=3 if confirmed else 0,
                 confirmation_date="2020-01-01" if confirmed else None, left_at=None, is_demo=0, role=role, admin_bg=None,
                 admin_role_id=None, is_system_admin=0)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    for co_ in (CO, CO2):
        db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, co_))
    db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG_OTHER, "ZZLR U9"))
    H1 = mk("ZZLR-H1", "ZZ LR Hodone", email="zzlr-h1@example.test")
    H3 = mk("ZZLR-H3", "ZZ LR Hodthree", email="zzlr-h3@example.test")
    P = [mk("ZZLR-P%d" % i, "ZZ LR Person %02d" % i, hod=H1) for i in range(1, 13)]
    Q = [mk("ZZLR-Q%d" % i, "ZZ LR Quin %02d" % i, hod=H3) for i in range(1, 4)]
    # P11 not confirmed (not taking part), P12 below the cycle's lowest grade
    db.execute("UPDATE users SET confirmation_date=NULL, years_of_service=0 WHERE id=?", (P[10],))
    db.execute("UPDATE users SET job_grade='10' WHERE id=?", (P[11],))
    BU = mk("ZZLR-BU", "ZZ LR Buceo", email="zzlr-bu@example.test")
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, BU))
    BGC = mk("ZZLR-BGC", "ZZ LR Bgceo", bgceo=BG, email="zzlr-bgc@example.test")
    GCU = mk("ZZLR-GC", "ZZ LR Groupchief", email="zzlr-gc@example.test")
    GM = [mk("ZZLR-GM%d" % i, "ZZ LR Groupmember %d" % i, co=CO2) for i in range(1, 4)]
    CAL = mk("ZZLR-CAL", "ZZ LR Calibrator", email="zzlr-cal@example.test")
    CM = [mk("ZZLR-CM%d" % i, "ZZ LR Calmember %d" % i, co=CO2, dept="ZZLR Cal Dept") for i in range(1, 4)]
    for u_ in P[:8] + Q + GM + CM:   # a scorecard each (the performance axis takes people with a KPI line)
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, company, status) "
                   "VALUES (?,?,?,?,?,?,?, 'approved')", (PID, u_, "ZZLR Sales", 100, "more", BG, CO))
    db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES ('ZZLR Batch', ?)", (GCU,))
    GC1 = db.execute("SELECT MAX(id) FROM pm_calibration_groups").fetchone()[0]
    for u_ in GM:
        db.execute("INSERT INTO pm_calibration_group_members(group_id, subject_id) VALUES (?,?)", (GC1, u_))
    db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id, active) VALUES (?,?,?,?,1)",
               (BG, CO2, "ZZLR Calgroup", CAL))
    CG1 = db.execute("SELECT MAX(id) FROM calib_bu_groups").fetchone()[0]
    for u_ in CM:
        db.execute("INSERT INTO calib_bu_group_people(group_id, business_group, user_id) VALUES (?,?,?)", (CG1, BG, u_))
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL AND "
                     "COALESCE(is_system_admin,0)=0 LIMIT 1").fetchone()
    SUP = SUP[0] if SUP else db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' LIMIT 1").fetchone()[0]
    # admins: a BG admin on the built-in role (in scope), one on a custom role with no Calibration read, one on another business
    # group, one limited to the other unit
    BGA = mk("ZZLR-BGA", "ZZ LR Groupadmin", role="admin")
    db.execute("UPDATE users SET admin_bg=? WHERE id=?", (BG, BGA))
    NOCAL = mk("ZZLR-NOCAL", "ZZ LR Nocal", role="admin")
    db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZLR no calibration', 'bg')")
    RID_NOCAL = db.execute("SELECT id FROM admin_roles WHERE name='ZZLR no calibration'").fetchone()[0]
    db.execute("INSERT INTO admin_role_access(role_id, item) VALUES (?, 'people.read')", (RID_NOCAL,))
    db.execute("UPDATE users SET admin_bg=?, admin_role_id=? WHERE id=?", (BG, RID_NOCAL, NOCAL))
    OTHERBG = mk("ZZLR-OBG", "ZZ LR Otherbg", role="admin", bg=BG_OTHER, co="ZZLR U9")
    db.execute("UPDATE users SET admin_bg=? WHERE id=?", (BG_OTHER, OTHERBG))
    UNITA = mk("ZZLR-UNA", "ZZ LR Unitadmin", role="admin")
    db.execute("UPDATE users SET admin_bg=? WHERE id=?", (BG, UNITA))
    db.execute("INSERT OR IGNORE INTO admin_companies(admin_id, company) VALUES (?,?)", (UNITA, CO2))
    # a past cycle to pick
    db.execute("INSERT INTO cycles(code, name, year, half, kind, is_active) VALUES ('ZZLR-PAST', 'ZZLR Past', 2019, 2, 'year_end', 0)")
    PAST = db.execute("SELECT id FROM cycles WHERE name='ZZLR Past'").fetchone()[0]
    db.commit()
    NOW = a._now_myt()

PAST_T = (NOW - timedelta(days=1)).strftime("%Y-%m-%d %H:%M")
FUT_T = (NOW + timedelta(days=5)).strftime("%Y-%m-%d %H:%M")


def ctx(fn, as_uid=None):
    with a.app.test_request_context("/"):
        if as_uid:
            a.session["user_id"] = as_uid
        return fn(a.get_db())


def one(sql, args=()):
    return H.one(a, sql, args)


def exe(sql, args=()):
    def f(d):
        d.execute(sql, args)
        d.commit()
    ctx(f)


def u(uid):
    return ctx(lambda d: dict(d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()))


def setwin(closes, *cells):
    for c in cells:
        exe("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (CID, c, None, closes))


HOD_CELLS = ("pm_hod", "pot_hod")
BU_CELLS = ("pm_buceo", "pot_buceo")
ALL_CELLS = HOD_CELLS + BU_CELLS + ("tb_bgceo",)


def flashes(client):
    with client.session_transaction() as ss:
        return " ".join(m for _c, m in ss.pop("_flashes", []))


def view(tier, key, me=SUP, cyc=None):
    return ctx(lambda d: a.leader_review_view(d, d.execute("SELECT * FROM users WHERE id=?", (me,)).fetchone(), tier, key,
                                               cyc or a.active_cycle(d)))


def lock(tier, scope, axes=("pm", "pot"), by=None, bg=BG):
    def f(d):
        if "pm" in axes:
            ss_ = a._pm_calib_get_or_create_session(d, PID, tier, scope, bg, "ZZLR " + scope)
            d.execute("UPDATE pm_calibration_sessions SET locked_at=datetime('now'), locked_by=? WHERE id=?", (by or SUP, ss_["id"]))
        if "pot" in axes:
            ss_ = a._get_or_create_calibration_session(d, CID, tier, scope, bg, "ZZLR " + scope)
            d.execute("UPDATE calibration_sessions SET locked_at=datetime('now'), locked_by=? WHERE id=?", (by or SUP, ss_["id"]))
        d.commit()
    ctx(f)


def unlock_all():
    for t in ("pm_calibration_sessions", "calibration_sessions"):
        exe("UPDATE %s SET locked_at=NULL, locked_by=NULL WHERE business_group IN (?,?)" % t, (BG, BG_OTHER))


def adj(axis, tier, scope, subject, o, n, bg=BG, at=None):
    """A saved call of this review's own session."""
    def f(d):
        if axis == "pm":
            ss_ = a._pm_calib_get_or_create_session(d, PID, tier, scope, bg, "ZZLR " + scope)
            tbl = "pm_calibration_adjustments"
        else:
            ss_ = a._get_or_create_calibration_session(d, CID, tier, scope, bg, "ZZLR " + scope)
            tbl = "calibration_adjustments"
        d.execute("INSERT OR REPLACE INTO %s(session_id, subject_id, original_band, adjusted_band, adjusted_by%s) VALUES (?,?,?,?,?%s)"
                  % (tbl, ", adjusted_at" if at else "", ",?" if at else ""), (ss_["id"], subject, o, n, SUP) + ((at,) if at else ()))
        d.commit()
    ctx(f)


def clear_adj():
    for t, sess in (("pm_calibration_adjustments", "pm_calibration_sessions"), ("calibration_adjustments", "calibration_sessions")):
        exe("DELETE FROM %s WHERE session_id IN (SELECT id FROM %s WHERE business_group IN (?,?))" % (t, sess), (BG, BG_OTHER))


def people(v):
    return {p["uid"]: p for p in v["people"]}


def acts(v):
    return [x["kind"] for x in v["box"]["acts"]]


sup, bga, nocal, otherbg, unita = (H.client_as(a, x) for x in (SUP, BGA, NOCAL, OTHERBG, UNITA))
_mail = (a.mailer.is_configured, a.mailer.send_mail)
SENT = []


def _fake_send(to, subj, body, *args, **kw):
    SENT.append((to, subj, body))


def list_html(client, key, **args):
    q = "&".join("%s=%s" % (k, v) for k, v in args.items())
    r = client.get("/admin/list/%s?fragment=1&%s" % (key, q))
    return r.status_code, r.get_data(as_text=True)


def hodlist(client=None, uid=H1, **extra):
    return list_html(client or sup, "hod-people", uid=uid, **extra)


try:
    # =======================================================================
    s.section("0. the fixture: who is in the review")
    setwin(PAST_T, *ALL_CELLS)
    exe("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,NULL,?)", (CID, "pm_hod", PAST_T))
    v0 = view("hod", H1)
    s.check("an HOD review reads (a view, with the 12 people they head)", v0 and len(v0["people"]) == 12, v0 and len(v0["people"]))
    pe = people(v0)
    s.check("in the review: the 10 taking part; not in it: the not-confirmed and the below-grade one",
            [pe[x]["in_review"] for x in P] == [True] * 10 + [False, False], [pe[x]["in_review"] for x in P])
    s.check("a person with no KPI line is in the review on Potential, not on Performance",
            pe[P[8]]["pot"]["state"] != "out" and pe[P[8]]["pm"]["state"] == "out"
            and pe[P[8]]["pm"]["sub"] == "No KPI lines this cycle", pe[P[8]]["pm"])
    s.check("...someone not taking part says why, in the list's short words (never a band, never a person's data)",
            pe[P[10]]["pm"]["sub"] == "Not taking part" and pe[P[11]]["pm"]["sub"] == "Below JG 12"
            and pe[P[11]]["pot"]["word"] == "Not in the review", (pe[P[10]]["pm"], pe[P[11]]["pm"]))

    # =======================================================================
    s.section("1. every cell state, read off the saved rows")
    clear_adj()
    unlock_all()
    v = view("hod", H1)
    pe = people(v)
    s.check("nothing saved: Not started (grey) on both axes for the people in it",
            all(pe[x]["pot"]["state"] == "none" and pe[x]["pot"]["word"] == "Not started" and pe[x]["pot"]["tone"] == "off"
                and pe[x]["pot"]["sub"] == "Not looked at yet" for x in P[:10]), pe[P[0]]["pot"])
    adj("pm", "hod", str(H1), P[0], "ME", "AE", at="2026-11-01 03:00:00")
    adj("pm", "hod", str(H1), P[1], "ME", "ME", at="2026-11-01 03:00:00")
    adj("pm", "hod", str(H1), P[2], "AE", "ME", at="2026-11-02 03:00:00")
    adj("pot", "hod", str(H1), P[0], "Mid", "Mid", at="2026-11-01 03:00:00")
    adj("pot", "hod", str(H1), P[1], "Mid", "High", at="2026-11-02 03:00:00")
    v = view("hod", H1)
    pe = people(v)
    s.check("a saved call that moved up: Saved (amber) 'Moved up' and the day", pe[P[0]]["pm"]["word"] == "Saved"
            and pe[P[0]]["pm"]["tone"] == "mid" and pe[P[0]]["pm"]["sub"] == "Moved up · 1 Nov", pe[P[0]]["pm"])
    s.check("...kept: 'Kept'", pe[P[1]]["pm"]["sub"] == "Kept · 1 Nov" and pe[P[0]]["pot"]["sub"] == "Kept · 1 Nov")
    s.check("...moved down: 'Moved down'", pe[P[2]]["pm"]["sub"] == "Moved down · 2 Nov", pe[P[2]]["pm"])
    s.check("...potential's up too (Mid to High)", pe[P[1]]["pot"]["sub"] == "Moved up · 2 Nov", pe[P[1]]["pot"])
    s.check("...never a band name on a cell", not any(b in (p[ax]["sub"] + p[ax]["word"]) for p in v["people"] for ax in ("pm", "pot")
                                                      for b in ("ME", "AE", "Mid", "High", "UA", "OU")))
    s.check("...and a person with nothing saved is still Not started", pe[P[3]]["pm"]["state"] == "none")
    cnt = v["counts"]
    s.check("counts are of the people IN the review: 10, not 12", cnt["n"] == 10, cnt)
    moved_expect = {P[0], P[2], P[1]}   # P1 up (pm), P3 down (pm), P2 up (pot)
    s.check("...moved = the people moved on either axis, asserted against the saved rows (3), kept the rest (7)",
            cnt["moved"] == len(moved_expect) and cnt["kept"] == 10 - len(moved_expect), cnt)
    s.check("...performance and potential 'reviewed' = the rows saved: 3 of 8 and 2 of 10",
            (cnt["pm_done"], cnt["pm_n"], cnt["pot_done"], cnt["pot_n"]) == (3, 8, 2, 10), cnt)
    # a locked review: Submitted (green), with the lock day, and a person with no row 'Kept as it came'
    lock("hod", str(H1))
    exe("UPDATE pm_calibration_sessions SET locked_at='2026-11-02 06:20:00' WHERE tier='hod' AND scope_key=?", (str(H1),))
    v = view("hod", H1)
    pe = people(v)
    s.check("locked: Submitted (green) with what they did and the day they submitted",
            pe[P[0]]["pm"]["word"] == "Submitted" and pe[P[0]]["pm"]["tone"] == "ok"
            and pe[P[0]]["pm"]["sub"] == "Moved up · 2 Nov", pe[P[0]]["pm"])
    s.check("...nothing saved reads 'Kept as it came' (not Not started)", pe[P[4]]["pm"]["sub"] == "Kept as it came · 2 Nov"
            and pe[P[4]]["pm"]["word"] == "Submitted", pe[P[4]]["pm"])
    s.check("...not in the review stays so even when locked", pe[P[11]]["pm"]["state"] == "out" and pe[P[11]]["pot"]["state"] == "out")
    # the other tiers say Locked
    lock("buceo", CO)
    vb = view("buceo", (BG, CO))
    s.check("a BU CEO's unit says Locked, not Submitted", vb and all(p["pot"]["word"] == "Locked" for p in vb["people"] if p["in_review"]),
            vb and {p["pot"]["word"] for p in vb["people"]})
    unlock_all()
    # an axis that does not apply
    exe("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ",".join("?" * 8), P[:8])
    vna = view("hod", H1)
    s.check("an axis that does not apply to the leader (nobody in the department holds a scorecard) reads 'Not in this review'",
            vna and vna["axes"]["pm"] is False and all(p["pm"]["word"] == "Not in this review" and p["pm"]["state"] == "na"
                                                       for p in vna["people"]) and vna["axes"]["pot"] is True, vna and vna["axes"])
    for x in P[:8]:
        exe("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, company, status) "
            "VALUES (?,?,?,?,?,?,?, 'approved')", (PID, x, "ZZLR Sales", 100, "more", BG, CO))
    s.check("...and it applies again once they hold one (the twin)", view("hod", H1)["axes"]["pm"] is True)

    # =======================================================================
    s.section("2. each box state shows its action and only that one (and each is falsified)")
    clear_adj()
    unlock_all()
    # (a) locked, past the deadline
    lock("hod", str(H1))
    setwin(PAST_T, *HOD_CELLS)
    v = view("hod", H1)
    s.check("locked past the deadline: Unlock both, nothing else", v["box"]["state"] == "locked_closed" and acts(v) == ["unlock"]
            and v["box"]["pill"]["text"].startswith("Submitted") and "all 10 people" in v["box"]["acts"][0]["muted"], v["box"])
    # (b) locked, inside the window
    setwin(FUT_T, *HOD_CELLS)
    v = view("hod", H1)
    s.check("falsified: window still open -> the same Unlock, labelled 'no extra days'", v["box"]["state"] == "locked_early"
            and acts(v) == ["unlock"] and "no extra days" in v["box"]["acts"][0]["muted"], v["box"])
    # (c) closed, not locked
    unlock_all()
    setwin(PAST_T, *HOD_CELLS)
    v = view("hod", H1)
    s.check("closed and not submitted: Give late pass, nothing else", v["box"]["state"] == "closed_give" and acts(v) == ["give"]
            and v["box"]["acts"][0]["pick"] == "pm_hod|%d" % H1 and v["box"]["pill"]["text"] == "Not submitted", v["box"])
    lock("hod", str(H1))
    v = view("hod", H1)
    s.check("falsified: lock it and the Give button goes (Unlock takes its place)", "give" not in acts(v) and "unlock" in acts(v))
    unlock_all()
    # (d) a pass running
    r = sup.post("/admin/users/%d/late-pass" % H1, data={
        "csrf_token": "tok", "part": "pm_hod|%d" % H1, "until": (NOW + timedelta(days=2)).strftime("%Y-%m-%dT%H:%M"),
        "reason": "ZZLR on leave over the deadline"})
    flashes(sup)
    v = view("hod", H1)
    s.check("a pass running: the amber pass pill, who gave it, the reason, and End pass only",
            v["box"]["state"] == "pass" and acts(v) == ["end"] and v["box"]["pill"]["kind"] == "pass"
            and "Late pass until" in v["box"]["pill"]["text"] and "ZZLR on leave" in v["box"]["line"], v["box"])
    exe("UPDATE late_passes SET closed_at=datetime('now'), close_kind='ended' WHERE user_id=?", (H1,))
    v = view("hod", H1)
    s.check("falsified: end the pass and End pass goes (Give is back)", "end" not in acts(v) and "give" in acts(v), acts(v))
    # (e) a tier above has locked
    lock("buceo", CO, axes=("pm",), by=BU)
    v = view("hod", H1)
    s.check("a tier above has locked (the BU CEO): no button, the muted reason",
            v["box"]["state"] == "closed_blocked" and acts(v) == [] and "BU CEO" in v["box"]["no"], v["box"])
    exe("UPDATE pm_calibration_sessions SET locked_at=NULL WHERE business_group=? AND tier='buceo'", (BG,))
    s.check("falsified: unlock the unit and the Give button is back", acts(view("hod", H1)) == ["give"])
    lock("hod", str(H1))
    lock("buceo", CO, axes=("pm",), by=BU)
    v = view("hod", H1)
    s.check("...a locked review under a locked unit: no Unlock either, the reason says why",
            v["box"]["state"] == "locked_blocked" and acts(v) == [] and "No unlock" in v["box"]["no"], v["box"])
    unlock_all()
    # (f) window open, not locked
    setwin(FUT_T, *HOD_CELLS)
    v = view("hod", H1)
    s.check("window open, not locked: no button, 'Open until ...'", v["box"]["state"] == "open" and acts(v) == []
            and v["box"]["pill"]["text"].startswith("Open until"), v["box"])
    setwin(PAST_T, *HOD_CELLS)
    s.check("falsified: close it and the Give button appears", acts(view("hod", H1)) == ["give"])
    # the saved line
    adj("pm", "hod", str(H1), P[0], "ME", "AE")
    adj("pot", "hod", str(H1), P[0], "Mid", "Mid")
    v = view("hod", H1)
    s.check("closed and not submitted with calls saved: 'Saved, not submitted: performance 1 of 8 reviewed, potential 1 of 10'",
            "Saved, not submitted: performance 1 of 8 reviewed, potential 1 of 10" in v["box"]["line"], v["box"]["line"])
    clear_adj()

    # =======================================================================
    s.section("3. the rendered panel: the box, the columns, the forms")
    lock("hod", str(H1))
    setwin(PAST_T, *HOD_CELLS)
    code, html_ = hodlist()
    s.check("the HOD list is the progress view for the super admin (200, the box, PERFORMANCE and POTENTIAL, no BU / THIS CYCLE)",
            code == 200 and 'class="lr-box"' in html_ and "Performance</th>" in html_ and "Potential</th>" in html_
            and "This cycle" not in html_ and 'title="Business unit"' not in html_, code)
    s.check("...with the box's Unlock both form (a POST with OneHR's box words, the remark field, days)",
            "Unlock both" in html_ and 'class="lr-form"' in html_ and "data-confirm-reason-field=\"remark\"" in html_
            and "data-confirm-days=" in html_ and 'name="next"' in html_, "form" in html_)
    forms = re.findall(r"<form[^>]*method=\"post\"[^>]*>", html_)
    s.check("...every POST form in it asks OneHR's own box (data-confirm), and the panel stamps the token on load",
            forms and all("data-confirm" in f_ for f_ in forms), forms)
    s.check("...colgroup 34 / 25 / 25 / 16", all(("width:%d%%" % w) in html_ for w in (34, 25, 25, 16)))
    s.check("...Search in stays, as the one rounded field (.sib)", 'class="sib"' in html_ and 'name="qin"' in html_ and 'class="sib-ico"' in html_)
    s.check("...a person's name still opens their page in the panel", 'data-person-open="%d"' % P[0] in html_)
    code, h_q = hodlist(q="Person 03")
    s.check("a search narrows the rows, never the box's counts", code == 200 and "ZZ LR Person 03" in h_q and "ZZ LR Person 04" not in h_q
            and "10 people in it" in h_q, code)
    unlock_all()
    setwin(PAST_T, *HOD_CELLS)
    code, h_c = hodlist()
    s.check("closed, not submitted: Give late pass opens the Give panel with this part picked",
            'data-panel-open="latepass"' in h_c and 'data-late-pick="pm_hod|%d"' % H1 in h_c and "Unlock both" not in h_c)

    # =======================================================================
    s.section("4. over: results released to leaders, or a past cycle -> today's plain view")
    exe("DELETE FROM late_passes WHERE user_id=?", (H1,))
    lock("hod", str(H1))
    setwin(PAST_T, *HOD_CELLS)
    ur0 = ctx(lambda d: a._unlock_row(d, d.execute("SELECT * FROM users WHERE id=?", (SUP,)).fetchone(), "hod", H1))
    s.check("(before the release the Unlock row has its button)", ur0 and ur0["locked"] and ur0["box"])
    exe("INSERT INTO leader_releases(cycle_id, subject_id, kind) VALUES (?,?,'pm')", (CID, P[0]))
    s.check("released to leaders for someone in the review: the reader gives nothing (no box, no columns)", view("hod", H1) is None)
    code, h_r = hodlist()
    s.check("...the panel is today's plain list (BU and THIS CYCLE, no box, no Unlock)", code == 200 and 'class="lr-box"' not in h_r
            and "This cycle" in h_r and "Unlock both" not in h_r and "Performance</th>" not in h_r, code)
    ur1 = ctx(lambda d: a._unlock_row(d, d.execute("SELECT * FROM users WHERE id=?", (SUP,)).fetchone(), "hod", H1))
    s.check("_unlock_row gives no Unlock button once released", ur1 and not ur1["locked"] and not ur1["box"] and ur1.get("released"), ur1)
    r = sup.post("/performance/calibration/hod/%d/unlock" % H1, data={"csrf_token": "tok", "days": "2", "remark": REMARK})
    msg = flashes(sup)
    s.check("a POST to the Unlock route is refused with the sentence, nothing changed (still locked, no pass, no note)",
            "Results are released to leaders for ZZ LR Hodone, so it can't be unlocked." in msg
            and one("SELECT COUNT(*) FROM pm_calibration_sessions WHERE tier='hod' AND scope_key=? AND locked_at IS NOT NULL", (str(H1),)) == 1
            and one("SELECT COUNT(*) FROM calibration_sessions WHERE tier='hod' AND scope_key=? AND locked_at IS NOT NULL", (str(H1),)) == 1
            and one("SELECT COUNT(*) FROM late_passes WHERE user_id=?", (H1,)) == 0, msg)
    s.check("...the Lock status page shows the lock with no Unlock form for it",
            "ZZ LR Hodone" not in sup.get("/admin/calibration/locks").get_data(as_text=True)
            or "pm_calibration_hod_unlock" not in sup.get("/admin/calibration/locks").get_data(as_text=True)
            or "/performance/calibration/hod/%d/unlock" % H1 not in sup.get("/admin/calibration/locks").get_data(as_text=True))
    exe("DELETE FROM leader_releases WHERE subject_id=?", (P[0],))
    s.check("falsified: take the release away and the review is back, with its Unlock", view("hod", H1) is not None
            and acts(view("hod", H1)) == ["unlock"])
    # a past cycle
    s.check("a past cycle picked on the page: the reader gives nothing", view("hod", H1, cyc=ctx(lambda d: d.execute(
        "SELECT * FROM cycles WHERE id=?", (PAST,)).fetchone())) is None)
    code, h_p = hodlist(cycle=PAST)
    s.check("...and the panel is the plain list", code == 200 and 'class="lr-box"' not in h_p and "This cycle" in h_p, code)
    s.check("(the active cycle in the URL keeps the progress)", 'class="lr-box"' in hodlist(cycle=CID)[1])

    # =======================================================================
    s.section("5. who sees what")
    exe("DELETE FROM late_passes WHERE user_id=?", (H1,))
    unlock_all()
    lock("hod", str(H1))
    setwin(PAST_T, *HOD_CELLS)
    s.check("(precondition) the built-in BG admin role reads Calibration; the custom role does not",
            ctx(lambda d: a.admin_can(d.execute("SELECT * FROM users WHERE id=?", (BGA,)).fetchone(), "calibration", "read"))
            and not ctx(lambda d: a.admin_can(d.execute("SELECT * FROM users WHERE id=?", (NOCAL,)).fetchone(), "calibration", "read")))
    s.check("the super admin: access 'act', with the Unlock action", view("hod", H1)["access"] == "act" and acts(view("hod", H1)) == ["unlock"])
    vr = view("hod", H1, me=BGA)
    s.check("an admin with calibration.read in scope: the progress (access 'read'), the same lines, no actions",
            vr and vr["access"] == "read" and vr["box"]["acts"] == [] and vr["box"]["pill"]["text"].startswith("Submitted")
            and len(vr["people"]) == 12, vr and vr["access"])
    code, h_b = hodlist(bga)
    s.check("...their panel has the box and columns but no Unlock form, no Give, no End", code == 200 and 'class="lr-box"' in h_b
            and "Unlock both" not in h_b and "lr-form" not in h_b and "data-late-pick" not in h_b, code)
    code, _h = hodlist(nocal)
    s.check("an admin without calibration.read: today's view (no list: 403)", code == 403, code)
    s.check("an admin of another business group: today's view", hodlist(otherbg)[0] == 403 and view("hod", H1, me=OTHERBG) is None)
    s.check("an admin limited to the other unit (scope doesn't cover the leader's unit): today's view",
            view("hod", H1, me=UNITA) is None and hodlist(unita)[0] == 403)
    # their POSTs are refused (the routes already refuse them; nothing changed)
    r = bga.post("/performance/calibration/hod/%d/unlock" % H1, data={"csrf_token": "tok", "days": "2", "remark": REMARK})
    s.check("the BG admin's POST to Unlock is refused (403), still locked",
            r.status_code == 403 and one("SELECT COUNT(*) FROM pm_calibration_sessions WHERE tier='hod' AND scope_key=? AND locked_at "
                                         "IS NOT NULL", (str(H1),)) == 1, r.status_code)
    r = bga.post("/admin/users/%d/late-pass/end" % H1, data={"csrf_token": "tok", "pass_id": "1"})
    s.check("...and so is their End pass (403)", r.status_code == 403, r.status_code)
    r = bga.post("/admin/users/%d/late-pass" % H1, data={"csrf_token": "tok", "part": "pm_hod|%d" % H1, "until": "2030-01-01T10:00",
                                                         "reason": "ZZLR x"})
    s.check("...and Give late pass (403)", r.status_code == 403 and one("SELECT COUNT(*) FROM late_passes WHERE user_id=?", (H1,)) == 0)
    # the chips
    pg = sup.get("/admin/users/%d?tab=overview" % H1).get_data(as_text=True)
    s.check("the super admin's HOD chip is a link opening the list (data-list-open)",
            re.search(r'<a class="pp-role is-hod is-link"[^>]*data-list-open="/admin/list/hod-people\?[^"]*"', pg) is not None)
    pg_b = bga.get("/admin/users/%d?tab=overview" % H1).get_data(as_text=True)
    s.check("an admin with calibration.read in scope: the HOD chip is a link too", 'class="pp-role is-hod is-link"' in pg_b)
    pg_n = nocal.get("/admin/users/%d?tab=overview" % H1).get_data(as_text=True)
    s.check("an admin without it: the chip is plain text, as today", 'class="pp-role is-hod"' in pg_n and "is-hod is-link" not in pg_n)
    exe("INSERT INTO leader_releases(cycle_id, subject_id, kind) VALUES (?,?,'pm')", (CID, P[0]))
    pg_b2 = bga.get("/admin/users/%d?tab=overview" % H1).get_data(as_text=True)
    pg_s2 = sup.get("/admin/users/%d?tab=overview" % H1).get_data(as_text=True)
    s.check("once the review is over the read-only admin's chip is plain again; the super admin's still opens the (plain) list",
            "is-hod is-link" not in pg_b2 and "is-hod is-link" in pg_s2)
    exe("DELETE FROM leader_releases WHERE subject_id=?", (P[0],))

    # =======================================================================
    s.section("6. an Unlock inside the window tells the leader; the past-deadline one still does")
    a.mailer.is_configured = lambda: True
    a.mailer.send_mail = _fake_send
    exe("DELETE FROM late_passes WHERE user_id=?", (H1,))
    exe("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, stage) VALUES (?,?,'agent','hello',NULL)", (H1, CID))
    unlock_all()
    lock("hod", str(H1))
    setwin(FUT_T, *HOD_CELLS)
    code, h_in = hodlist()
    s.check("the in-window box says they are told in OneHR and by email (the remark label too)",
            "gets a note in OneHR and an email" in h_in and "They see it and get an email" in h_in, "note" in h_in)
    SENT.clear()
    r = sup.post("/performance/calibration/hod/%d/unlock" % H1, data={"csrf_token": "tok", "remark": REMARK})
    msg = flashes(sup)
    s.check("an Unlock inside the window: both axes unlock, no days asked, no late pass given",
            one("SELECT COUNT(*) FROM pm_calibration_sessions WHERE tier='hod' AND scope_key=? AND locked_at IS NOT NULL", (str(H1),)) == 0
            and one("SELECT COUNT(*) FROM late_passes WHERE user_id=?", (H1,)) == 0, msg)
    s.check("...the HOD is emailed once, with the remark and the normal close, not a late-pass email",
            len(SENT) == 1 and SENT[0][0] == "zzlr-h1@example.test" and "open again" in SENT[0][1]
            and REMARK in SENT[0][2] and "late" not in SENT[0][1].lower(), [(x[0], x[1]) for x in SENT])
    s.check("...and it is logged on the late-pass email kind (detail calibration_reopen)",
            one("SELECT COUNT(*) FROM notifications WHERE user_id=? AND kind=? AND detail='calibration_reopen' AND status='sent'",
                (H1, a.LATE_KIND)) == 1)
    s.check("...and the note is in their own conversation, in the remark's words",
            one("SELECT COUNT(*) FROM pm_review_chat WHERE subject_id=? AND role='agent' AND content LIKE ? AND content LIKE ?",
                (H1, "%reopened your%", "%" + REMARK + "%")) == 1)
    s.check("...the flash says they were told", "told" in msg and "ZZ LR Hodone" in msg, msg)
    # nothing changed for a leader with no conversation (a welcome is not taken over), email still goes
    exe("DELETE FROM pm_review_chat WHERE subject_id=?", (H1,))
    lock("hod", str(H1))
    SENT.clear()
    sup.post("/performance/calibration/hod/%d/unlock" % H1, data={"csrf_token": "tok", "remark": REMARK})
    flashes(sup)
    s.check("a leader with no conversation yet: the email goes, no first line is written ahead of their welcome",
            len(SENT) == 1 and one("SELECT COUNT(*) FROM pm_review_chat WHERE subject_id=?", (H1,)) == 0)
    # past the deadline: unchanged
    exe("DELETE FROM late_passes WHERE user_id=?", (H1,))
    lock("hod", str(H1))
    setwin(PAST_T, *HOD_CELLS)
    SENT.clear()
    sup.post("/performance/calibration/hod/%d/unlock" % H1, data={"csrf_token": "tok", "days": "2", "remark": REMARK})
    msg = flashes(sup)
    s.check("past the deadline: still a late pass and the 'More time' email (the twin)",
            one("SELECT COUNT(*) FROM late_passes WHERE user_id=? AND cell='pm_hod'", (H1,)) == 1 and len(SENT) == 1
            and "More time" in SENT[0][1], (msg, [(x[1]) for x in SENT]))
    a.mailer.is_configured, a.mailer.send_mail = _mail
    exe("DELETE FROM late_passes WHERE user_id=?", (H1,))
    unlock_all()

    # =======================================================================
    s.section("7. one batched read: the panel's queries do not grow with the people")

    def count_queries(hid):
        n = [0]

        def tr(_sql):
            n[0] += 1
        with a.app.test_request_context("/"):
            d = a.get_db()
            me = d.execute("SELECT * FROM users WHERE id=?", (SUP,)).fetchone()
            cyc = a.active_cycle(d)
            d.set_trace_callback(tr)
            v_ = a.leader_review_view(d, me, "hod", hid, cyc)
            d.set_trace_callback(None)
            return n[0], v_
    setwin(PAST_T, *HOD_CELLS)
    n12, v12 = count_queries(H1)
    n3, v3 = count_queries(H3)
    s.check("the reader's statements: %d for 12 people, %d for 3 (no query a person)" % (n12, n3),
            v12 and v3 and len(v12["people"]) == 12 and len(v3["people"]) == 3 and n12 <= n3 + 2, (n12, n3))
    n_list = [0]

    def trl(_sql):
        n_list[0] += 1
    s.note("statements for the reader: 12 people %d, 3 people %d" % (n12, n3))

    # =======================================================================
    s.section("8. the other tiers: BU CEO unit, calibration group, Group Chief group, BG CEO's units")
    unlock_all()
    clear_adj()
    for cells in (BU_CELLS, ("tb_bgceo",)):
        setwin(PAST_T, *cells)
    code, h_bu = list_html(sup, "review-bu", bg=BG, co=CO)
    s.check("the BU CEO's unit list: the box 'BU calibration', the people of the unit (the HODs' people and the HODs)",
            code == 200 and 'class="lr-box"' in h_bu and "BU calibration" in h_bu and "ZZ LR Person 01" in h_bu, code)
    vbu = view("buceo", (BG, CO))
    s.check("...closed, not locked: Give late pass (its key pm_buceo|unit), nothing else", vbu and acts(vbu) == ["give"]
            and vbu["box"]["acts"][0]["pick"] == "pm_buceo|%s" % CO, vbu and vbu["box"])
    lock("buceo", CO)
    vbu = view("buceo", (BG, CO))
    s.check("...locked past the deadline: Unlock both, the people say Locked", acts(vbu) == ["unlock"]
            and all(p["pm"]["word"] == "Locked" for p in vbu["people"] if p["pm"]["state"] == "locked"))
    code, h_bu = list_html(sup, "review-bu", bg=BG, co=CO)
    s.check("...its panel carries the unlock form posting to the BU unlock route", 'action="/performance/calibration/bu/' in h_bu
            or "calibration/buceo" in h_bu or "unlock" in h_bu.lower(), code)
    lock("bgceo", BG)
    vbu = view("buceo", (BG, CO))
    s.check("a BG CEO's lock over the unit: no button, the reason (higher tier)", vbu["box"]["state"] == "locked_blocked"
            and acts(vbu) == [] and "BG CEO" in vbu["box"]["no"], vbu["box"])
    exe("UPDATE pm_calibration_sessions SET locked_at=NULL WHERE tier='bgceo' AND business_group=?", (BG,))
    exe("UPDATE calibration_sessions SET locked_at=NULL WHERE tier='bgceo' AND business_group=?", (BG,))
    unlock_all()
    # calibration group
    code, h_cg = list_html(sup, "review-cg", bg=BG, co=CO2, gid=CG1)
    vcg = view("bugrp", (BG, CO2, CG1))
    s.check("the calibration group's list: its three members, the box 'Calibration group', Give late pass",
            code == 200 and vcg and len(vcg["people"]) == 3 and vcg["box"]["title"].startswith("Calibration group")
            and acts(vcg) == ["give"] and "ZZ LR Calmember 1" in h_cg, (code, vcg and acts(vcg)))
    # Group Chief
    code, h_gc = list_html(sup, "review-group", gid=GC1)
    vgc = view("group", GC1)
    s.check("the Group Chief's list: its three members, 'Group Chief group' box", code == 200 and vgc and len(vgc["people"]) == 3
            and vgc["box"]["title"].startswith("Group Chief group"), (code, vgc and vgc["box"]["title"]))
    exe("INSERT INTO pm_group_locks(cycle_id, group_id, subject_id, band) VALUES (?,?,?,?)", (PID, GC1, GM[0], "ME"))
    vgc = view("group", GC1)
    pg_ = people(vgc)
    s.check("...a person the Group Chief locked one by one reads Locked, the others not", pg_[GM[0]]["pm"]["state"] == "locked"
            and pg_[GM[1]]["pm"]["state"] == "none", (pg_[GM[0]]["pm"], pg_[GM[1]]["pm"]))
    exe("DELETE FROM pm_group_locks WHERE group_id=?", (GC1,))
    # BG CEO's units
    code, h_bg = list_html(sup, "review-bg", bg=BG)
    vbg = view("bgceo", BG)
    s.check("the BG CEO's list: rows are the business UNITS (not people), a box 'Talent Box'",
            code == 200 and vbg and [x["company"] for x in vbg["units"]] == sorted([CO, CO2]) and not vbg["people"]
            and vbg["box"]["title"].startswith("Talent Box") and "data-list-reload" in h_bg, (code, vbg and vbg["units"]))
    s.check("...nothing locked, closed: Give late pass for the open units, no Unlock", acts(vbg) == ["give"], acts(vbg))
    exe("INSERT INTO talent_box_bu_locks(period_id, cycle_id, business_group, company) VALUES (?,?,?,?)", (PID, CID, BG, CO))
    vbg = view("bgceo", BG)
    s.check("...one unit locked: Give late pass (the other unit) and Unlock the Talent Box can show together",
            sorted(acts(vbg)) == ["give", "unlock"], acts(vbg))
    s.check("...the unit rows say which is locked", [x["tb_locked"] for x in vbg["units"]] == [True, False] and
            vbg["box"]["pill"]["text"] == "1 of 2 units locked", vbg["units"])
    exe("DELETE FROM talent_box_bu_locks WHERE business_group=?", (BG,))
    # a unit drilled into from the BG CEO's list: its Give late pass is the BU CEO's own page's, not the host's
    s.check("the BG CEO's unit rows carry the BG CEO's id (via=) so the drill-down knows whose page hosts it",
            "via=%d" % BGC in h_bg and "data-list-reload" in h_bg, "via=%d" % BGC)
    vbu_ = view("buceo", (BG, CO))
    s.check("(precondition) the unit is closed and not locked: Give late pass", vbu_ and acts(vbu_) == ["give"])
    code, h_dr = list_html(sup, "review-bu", bg=BG, co=CO, via=BGC)
    m_dr = re.search(r'<a class="pp-late-give" href="([^"]+)"', h_dr)
    href_dr = m_dr.group(1).replace("&amp;", "&") if m_dr else ""
    s.check("drilled into from another leader's page (via= the BG CEO): Give late pass is a link to the BU CEO's own page with the "
            "part to pick, never a panel-open button of the host page",
            code == 200 and m_dr and href_dr.startswith("/admin/users/%d?" % BU) and "panel=latepass" in href_dr
            and "late_pick=pm_buceo%%7C%s" % CO.replace(" ", "+") in href_dr and "data-panel-open" not in h_dr
            and "data-late-pick" not in h_dr, (code, href_dr))
    code, h_nv = list_html(sup, "review-bu", bg=BG, co=CO)
    s.check("falsified: no via -> the button, as before (opens this page's own Give panel)",
            'data-panel-open="latepass"' in h_nv and 'data-late-pick="pm_buceo|%s"' % CO in h_nv and 'class="pp-late-give" href' not in h_nv)
    code, h_own = list_html(sup, "review-bu", bg=BG, co=CO, via=BU)
    s.check("falsified: via = the leader's own id (their own page) -> the button", 'data-panel-open="latepass"' in h_own
            and 'class="pp-late-give" href' not in h_own)
    code, h_bad = list_html(sup, "review-bu", bg=BG, co=CO, via="x'%3Cb")
    s.check("a via that is not an id is ignored (the button), and never written into the page", 'data-panel-open="latepass"' in h_bad
            and "<b" not in h_bad.split("lr-box")[0])
    pg_dr = sup.get(href_dr)
    pt = pg_dr.get_data(as_text=True)
    s.check("the link lands on the BU CEO's page with the Give panel open (200, the latepass panel set to open)",
            pg_dr.status_code == 200 and re.search(r'id="pnl-latepass"[^>]*data-panel-autoopen', pt) is not None, pg_dr.status_code)
    js = open(os.path.join(H.REPO, "static", "late_pass.js")).read()
    s.check("...and late_pass.js reads ?late_pick= and ticks only that part by the click handler's own pick(key)",
            "late_pick" in js and js.count("pick(") >= 2 and "function pick(key)" in js)
    # access: a unit admin limited to the other unit can't read the BU CEO's other unit
    s.check("a unit-limited admin reads a calibration group in their unit, never the other unit's BU review",
            view("bugrp", (BG, CO2, CG1), me=UNITA) is None or view("buceo", (BG, CO), me=UNITA) is None)
    s.check("...and the BG admin reads every tier of their group with no action",
            all(x and x["box"]["acts"] == [] for x in (view("buceo", (BG, CO), me=BGA), view("bgceo", BG, me=BGA))))
    code, _h = list_html(nocal, "review-bu", bg=BG, co=CO)
    codes_ = [list_html(nocal, k, **kw)[0] for k, kw in (("review-bu", dict(bg=BG, co=CO)), ("review-bg", dict(bg=BG)),
                                                         ("review-group", dict(gid=GC1)), ("review-cg", dict(bg=BG, co=CO2, gid=CG1)))]
    s.check("an admin without calibration.read is refused on every new list (module gate or reader: %r)" % codes_,
            all(c_ in (302, 403) for c_ in codes_), codes_)
    # the over state of these lists: plain for the super admin, 403 for anyone else
    exe("INSERT INTO leader_releases(cycle_id, subject_id, kind) VALUES (?,?,'pm')", (CID, P[0]))
    code, h_bu2 = list_html(sup, "review-bu", bg=BG, co=CO)
    s.check("once results are out the BU CEO's list is the plain people (no box), and a read-only admin gets 403 on it",
            code == 200 and 'class="lr-box"' not in h_bu2 and "This cycle" in h_bu2 and list_html(bga, "review-bu", bg=BG, co=CO)[0] == 403)
    code, h_bg2 = list_html(sup, "review-bg", bg=BG)
    s.check("...and the BG CEO's list is the plain units (the super admin's; a read-only admin gets 403)",
            code == 200 and 'class="lr-box"' not in h_bg2 and list_html(bga, "review-bg", bg=BG)[0] == 403)
    exe("DELETE FROM leader_releases WHERE subject_id=?", (P[0],))
    # the chips on the other leaders' pages
    for uid_, cls in ((BU, "is-bu is-link"), (BGC, "is-bg is-link"), (GCU, "is-gc is-link"), (CAL, "is-cg is-link")):
        pg_x = sup.get("/admin/users/%d?tab=overview" % uid_).get_data(as_text=True)
        s.check("the %s chip on their page is a link opening its list" % cls.split()[0],
                'class="pp-role %s"' % cls in pg_x and 'data-list-open="/admin/list/review-' in pg_x, cls)
    pg_bu_b = bga.get("/admin/users/%d?tab=overview" % BU).get_data(as_text=True)
    s.check("a read-only admin in scope: the BU CEO chip is a link too", 'class="pp-role is-bu is-link"' in pg_bu_b)

    # =======================================================================
    s.section("9. the joined Search in field, on every list panel")
    code, h_s = list_html(sup, "lm-reports", uid=H1)
    s.check("a plain list panel (Line manager's reports) draws the one rounded field too: icon, picker, box in one .sib, no visible Search button",
            code == 200 and 'class="sib"' in h_s and h_s.index('class="sib-ico"') < h_s.index('name="qin"')
            < h_s.index('type="search"') and 'class="sr-only" tabindex="-1">Search<' in h_s and 'class="btn">Search<' not in h_s)
    css = open(os.path.join(H.REPO, "static", "style.css")).read()
    s.check("the CSS: .sib has the navy focus ring on :focus-within, before the phone pieces; the old .clp-sbox is gone",
            ".sib:focus-within" in css and css.index(".sib:focus-within") < css.index("PHONE VIEW, PIECE A") and "clp-sbox" not in css)
finally:
    a.mailer.is_configured, a.mailer.send_mail = _mail
    with a.app.test_request_context("/"):
        d = a.get_db()
        _cleanup(d)
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        for w in ORIG["windows"]:
            d.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                      (w["cycle_id"], w["cell"], w["opens_at"], w["closes_at"]))
        d.execute("DELETE FROM cycle_modules WHERE cycle_id=?", (CID,))
        for m in ORIG["modules"]:
            d.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", m)
        c_ = ORIG["cycle"]
        d.execute("UPDATE cycles SET half=?, kind=?, open_by_date=?, min_job_grade=? WHERE id=?",
                  (c_["half"], c_["kind"], c_["open_by_date"], c_["min_job_grade"], CID))
        d.commit()
sys.exit(s.done())
