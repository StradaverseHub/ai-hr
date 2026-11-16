"""Four small fixes from the security test, one suite (2026-10-31).

1b-06 + 3-09  `GET /performance/calibration` answered 500 for the calibrator of a BU calibration group: its tier is `bugrp`
              and its key a 3-part tuple, which the chooser bound as one business group. The loop skips it; the page opens.
1b-09         `GET /technical` answered 500 for a BG CEO or Group Chief with AI drafting on and no competencies assigned
              (`assessment` is None, `tc_can_self_edit(None)` is True): the quota is read only when there is an assessment.
1a-02         The line-manager lookup on an admin's person page named a person of ANOTHER group (the preview, the confirm
              box, the flash). For a manager outside the admin's scope it now shows only "Employee ID <x> (another group)";
              setting a cross-group manager stays allowed (HR's own data has real ones); the super admin sees names.
1b-05         A manager's evidence note is on the person's own ledger by design: the manager's form says so.

Its own synthetic groups; the suite writes, so it takes a fresh copy.
"""
import html
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
a.app.config["PROPAGATE_EXCEPTIONS"] = False   # a 500 is an answer to check, not a crash of the suite
s = H.Suite("Small access fixes: the calibrator's chooser, /technical, the manager lookup, the note's hint")
BG, CA, CB, DEPT = "ZZSA Group", "ZZSA Alpha Sdn Bhd", "ZZSA Beta Sdn Bhd", "ZZSA Dept"
BG2 = "ZZSA Other Group"

with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    PER = a.active_pm_period(db)["id"]
    db.execute("UPDATE cycles SET half=2, kind='year_end' WHERE id=?", (CID,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=?", (CID,))
    for k in ("ai_calib", "review_unified"):
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,'1')", (k,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, name, bg=BG, company=CA, kpi=False, role="user", admin_bg=None, role_id=None, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=bg, company=company, department=DEPT,
                 job_grade="16", years_of_service=3, confirmation_date="2020-01-01", left_at=None, is_demo=0, role=role,
                 admin_bg=admin_bg, admin_role_id=role_id)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        uid = db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
        if kpi:
            db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group) "
                       "VALUES (?,?,?,100,'more','approved',?)", (PER, uid, "ZZSA KPI", bg))
        return uid
    # a calibration group of the unit, its calibrator and a department's people
    CAL = mk("ZZSA-CAL", "ZZ SA Calibrator")
    GP = [mk("ZZSA-G%d" % i, "ZZ SA Grouped %d" % i, kpi=True) for i in range(2)]
    db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id) VALUES (?,?,?,?)",
               (BG, CA, "ZZSA panel", CAL))
    GID = db.execute("SELECT id FROM calib_bu_groups WHERE name='ZZSA panel'").fetchone()[0]
    db.execute("INSERT INTO calib_bu_group_units(group_id, business_group, company, department) VALUES (?,?,?,?)", (GID, BG, CA, DEPT))
    # a BG CEO with no competencies assigned
    BGC = mk("ZZSA-BGC", "ZZ SA Group CEO", bgceo_bg=BG)
    # the line-manager lookup: a limited BG admin, a person in scope, a manager in scope, a manager of another group
    db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZSA lm only', 'bg')")
    RID = db.execute("SELECT id FROM admin_roles WHERE name='ZZSA lm only'").fetchone()[0]
    db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(RID, "people.read"), (RID, "people.lm")])
    ADM = mk("ZZSA-ADM", "ZZ SA Limited Admin", role="admin", admin_bg=BG, role_id=RID)
    PERSON = mk("ZZSA-PER", "ZZ SA Person", company=CB)
    PERSON2 = mk("ZZSA-PE2", "ZZ SA Person Two", company=CB)
    MGR_IN = mk("ZZSA-MIN", "ZZ SA Inside Manager", company=CB)
    MGR_OUT = mk("ZZSA-MOUT", "ZZ SA Outside Manager", bg=BG2, company="ZZSA Elsewhere Sdn Bhd")
    db.commit()
SU = H.one(a, "SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL LIMIT 1")
LINES = "/admin/users/%d/lines"

# ---------------------------------------------------------------------------
s.section("1b-06 + 3-09 the BU calibration group's calibrator opens the chooser")
with a.app.test_request_context("/"):
    from flask import session as _fs
    _fs["user_id"] = CAL
    tiers = a.calibration_tier_of(a.get_db(), a.current_user())
s.check("the fixture: the calibrator holds a `bugrp` tier with a 3-part key", any(t == "bugrp" and len(k) == 3 for t, k in tiers), tiers)
r = H.client_as(a, CAL).get("/performance/calibration", follow_redirects=False)
s.check("GET /performance/calibration opens (200 or a redirect) instead of a 500", r.status_code in (200, 301, 302), r.status_code)
# the same for a login that holds a BU seat AND a group: the unit's row is still listed, the group's is not a business group
with a.app.test_request_context("/"):
    d = a.get_db()
    d.execute("UPDATE users SET buceo_bg=?, buceo_company=? WHERE id=?", (BG, CA, CAL))
    d.commit()
r2 = H.client_as(a, CAL).get("/performance/calibration", follow_redirects=False)
s.check("...and for a calibrator who also holds the unit's seat", r2.status_code in (200, 301, 302), r2.status_code)

# ---------------------------------------------------------------------------
s.section("1b-09 /technical for a BG CEO with no competencies and AI drafting on")
_conf = a.ai_draft.is_configured
a.ai_draft.is_configured = lambda: True
try:
    r = H.client_as(a, BGC).get("/technical")
    s.check("GET /technical opens for the BG CEO instead of a 500", r.status_code == 200, r.status_code)
finally:
    a.ai_draft.is_configured = _conf

# ---------------------------------------------------------------------------
s.section("1a-02 the line-manager lookup names only people the admin may see")
adm, sup = H.client_as(a, ADM), H.client_as(a, SU)
OUT_TXT = "Employee ID ZZSA-MOUT (another group)"


def lookup(client, uid, eid, action="lm_preview"):
    return client.post(LINES % uid, data={"csrf_token": "tok", "action": action, "lm_eid": eid})


r = lookup(adm, PERSON, "ZZSA-MOUT")
b = html.unescape(r.get_data(as_text=True))
s.check("a BG admin previewing a manager of ANOTHER group sees only 'Employee ID <x> (another group)', never the name",
        r.status_code == 200 and OUT_TXT in b and "ZZ SA Outside Manager" not in b, r.status_code)
s.check("...the confirm box and the heading carry the same words", ("Make %s the line manager of" % OUT_TXT) in b
        and ("Make %s their line manager" % OUT_TXT) in b)
r = lookup(adm, PERSON, "ZZSA-MIN")
b = html.unescape(r.get_data(as_text=True))
s.check("a manager inside the admin's group is named as before", "Make ZZ SA Inside Manager their line manager" in b
        and "another group" not in b, r.status_code)
r = lookup(sup, PERSON, "ZZSA-MOUT")
b = html.unescape(r.get_data(as_text=True))
s.check("the super admin sees the name as today", "Make ZZ SA Outside Manager their line manager" in b
        and "another group" not in b, r.status_code)
r = lookup(adm, PERSON, "ZZSA-MOUT", action="lm_apply")
mgr = H.one(a, "SELECT manager_id FROM users WHERE id=?", (PERSON,))
s.check("applying is still allowed (HR's own data has cross-group managers): the manager is set", mgr == MGR_OUT, mgr)
with H.client_as(a, ADM) as c2:
    c2.post(LINES % PERSON2, data={"csrf_token": "tok", "action": "lm_apply", "lm_eid": "ZZSA-MOUT"})
    with c2.session_transaction() as ss:
        flashes = [m for _c, m in ss.get("_flashes", [])]
s.check("...and its confirmation names the Employee ID, not the person", any(OUT_TXT in f for f in flashes)
        and not any("ZZ SA Outside Manager" in f for f in flashes), flashes)
with H.client_as(a, ADM) as c3:   # PERSON now has that manager: the preview says "already", still without the name
    c3.post(LINES % PERSON, data={"csrf_token": "tok", "action": "lm_preview", "lm_eid": "ZZSA-MOUT"})
    with c3.session_transaction() as ss3:
        flashes3 = [m for _c, m in ss3.get("_flashes", [])]
s.check("a manager the person already has, outside the admin's group, is also only an Employee ID (the 'already' line)",
        any(OUT_TXT in f and "already" in f for f in flashes3) and not any("ZZ SA Outside Manager" in f for f in flashes3), flashes3)

# ---------------------------------------------------------------------------
s.section("1b-05 the manager's evidence note says the person can see it")
tpl = open(os.path.join(H.REPO, "templates", "review_team_member.html"), encoding="utf-8").read()
s.check("the manager's note form carries 'The person can see this note.' in the page's small muted style",
        '<p class="muted small" style="margin:6px 0 0">The person can see this note.</p>' in tpl
        and tpl.index("The person can see this note.") > tpl.index('id="rv-note-body"')
        and tpl.index("The person can see this note.") < tpl.index('id="rv-note-save"'))

sys.exit(s.done())
