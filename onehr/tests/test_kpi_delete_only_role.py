"""An admin role with "Remove a KPI line" (pm.kpi_delete) and not "Edit a KPI line" (pm.kpi_edit) gets the Remove control
on a person's KPI line and no edit form (Chris, 2026-11-09): before, it saw the whole edit form and Save returned 403.

What this suite holds:
  * delete-only role: the line's panel is read only (no edit form, no Save changes, no weight box) with a Delete this KPI
    control, and the Delete works (the line goes, the rating record is followed); a moderated line shows no Delete and the
    server still refuses it; its edit POST is refused with 403 and the line is untouched
  * edit-only role: the edit form as before, no Delete control, a delete POST is 403
  * a role with both and the super admin: the edit form with Delete, unchanged
  * a role with neither (view only): read only, no Delete
"""
import html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A delete-only KPI role gets Remove and no edit form")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO, DEPT = "ZZDO Group", "ZZDO Unit", "ZZDO Dept"
ROLES = {"del": ["pm.read", "people.read", "pm.kpi_delete"], "edit": ["pm.read", "people.read", "pm.kpi_edit"],
         "both": ["pm.read", "people.read", "pm.kpi_edit", "pm.kpi_delete"], "view": ["pm.read", "people.read"]}
ADM = {}
U = {}


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9DO-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM rating_records WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_kpi_approvals WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s))" % ph, ul)
        db.execute("DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s))" % ph, ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.execute("DELETE FROM admin_roles WHERE name LIKE 'ZZDO role %'")
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
    LIB = db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, "
                     "unit, method, active) VALUES (?, '*', '*', 0, '*', 'ZZDO Sales', 'Business · Revenue', '%', 'more', 1)",
                     (BG,)).lastrowid
    U["M"] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                        "department, job_grade, confirmation_date) VALUES ('zz9do-m','ZZ DO Manager','x','user','ZZ9DO-M',?,?,?,'21','2020-01-01')",
                        (BG, CO, DEPT)).lastrowid
    U["P"] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                        "department, job_grade, confirmation_date, manager_id) VALUES ('zz9do-p','ZZ DO Person','x','user','ZZ9DO-P',?,?,?,'14','2020-01-01',?)",
                        (BG, CO, DEPT, U["M"])).lastrowid

    def put(name, w, **kw):
        return db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, "
                          "rate2, rate3, rate4, rate5, business_group, company, library_id) VALUES (?,?,?,?, 'more', '%', "
                          "'Business · Revenue', 10,20,30,40,50, ?,?,?)", (CID, U["P"], name, w, BG, CO, LIB)).lastrowid
    T = {n: put("ZZDO " + n, 20) for n in ("Open", "Open2", "Open3", "Open4", "Locked")}
    # the 'Locked' line has been moderated: nothing here touches it
    db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, acted_by) VALUES (?, 1, 'confirm', ?)",
               (T["Locked"], U["M"]))
    for k, items in ROLES.items():
        rid = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES (?, 'group')", ("ZZDO role " + k,)).lastrowid
        db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(rid, i) for i in items])
        ADM[k] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg, "
                            "admin_role_id) VALUES (?,?, 'x', 'admin', ?, ?, ?, ?)",
                            ("zz9do-" + k, "ZZ DO Admin " + k, "ZZ9DO-A" + k.upper(), BG, BG, rid)).lastrowid
    db.commit()

C = {k: H.client_as(a, v) for k, v in ADM.items()}
SUP = H.client_as(a, SU["id"])
URL = "/admin/users/%d/kpi" % U["P"]


def say(r):
    return html.unescape(r.get_data(as_text=True))


def panel(client, tname):
    """The HTML of one line's right-hand panel."""
    pg = say(client.get("/admin/users/%d?tab=performance" % U["P"]))
    m = re.search(r'id="pnl-kpi-%d".*?(?=id="pnl-kpi-\d+"|id="pnl-kpi-add"|$)' % T[tname], pg, re.S)
    return pg, (m.group(0) if m else "")


def exists(tname):
    return bool(H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE id=?", (T[tname],)))


def weight(tname):
    return H.one(a, "SELECT weightage FROM pm_kpi_targets WHERE id=?", (T[tname],))


s.check("fixture: a person with five lines, four open and one moderated", len(T) == 5)

# ---- delete-only ----
pg, pn = panel(C["del"], "Open")
s.check("delete-only: the page opens and the line's panel is there", pg and pn, len(pn))
s.check("delete-only: no edit form on the line (no data-kpe=\"edit\", no Save changes)",
        'data-kpe="edit"' not in pg and "Save changes" not in pn, "")
s.check("delete-only: no weight box or picker on the page", 'name="weightage"' not in pn and 'id="kpe-lib"' not in pg)
s.check("delete-only: the panel says why it is read only, in the role's words", "can remove a KPI line but not change one" in pn, pn[:200])
s.check("delete-only: the Delete this KPI control is there", "Delete this KPI" in pn and ('id="kpe-del-%d"' % T["Open"]) in pg)
s.check("delete-only: no Delete on the moderated line", "Delete this KPI" not in panel(C["del"], "Locked")[1])
r = C["del"].post(URL, data={"csrf_token": "tok", "action": "edit", "kpi_target_id": str(T["Open"]), "weightage": "35"})
s.check("delete-only: an edit POST is still refused (403) and the weight is as it was", r.status_code == 403 and weight("Open") == 20,
        (r.status_code, weight("Open")))
r = C["del"].post(URL, data={"csrf_token": "tok", "action": "delete", "kpi_target_id": str(T["Locked"])}, follow_redirects=True)
s.check("delete-only: deleting the moderated line is refused and it stays", exists("Locked") and "locked" in say(r).lower(), r.status_code)
r = C["del"].post(URL, data={"csrf_token": "tok", "action": "delete", "kpi_target_id": str(T["Open"])}, follow_redirects=True)
s.check("delete-only: the Remove control works: the line is gone", r.status_code == 200 and not exists("Open"), r.status_code)
s.check("delete-only: ...and it is in the trail as the admin's own delete",
        H.one(a, "SELECT COUNT(*) FROM activity_log WHERE user_id=? AND action='pm_kpi_delete' AND target_user_id=?",
              (ADM["del"], U["P"])) == 1)

# ---- edit-only ----
pg, pn = panel(C["edit"], "Open2")
s.check("edit-only: the edit form is there, unchanged", 'data-kpe="edit"' in pg and "Save changes" in pn)
s.check("edit-only: no Delete control", "Delete this KPI" not in pn and "kpe-delbtn" not in pn and 'id="kpe-del-' not in pg,
        ("Delete this KPI" in pn, "kpe-delbtn" in pn, 'id="kpe-del-' in pg))
r = C["edit"].post(URL, data={"csrf_token": "tok", "action": "delete", "kpi_target_id": str(T["Open2"])})
s.check("edit-only: a delete POST is refused (403)", r.status_code == 403 and exists("Open2"), r.status_code)

# ---- both, and super ----
for who, cl in (("both", C["both"]), ("super", SUP)):
    pg, pn = panel(cl, "Open3")
    s.check("%s: the edit form and the Delete control, as before" % who,
            'data-kpe="edit"' in pg and "Save changes" in pn and "Delete this KPI" in pn and ('id="kpe-del-%d"' % T["Open3"]) in pg)
    s.check("%s: no read-only notice on an open line" % who, "can remove a KPI line but not change" not in pn)

# ---- view only ----
pg, pn = panel(C["view"], "Open3")
s.check("view-only: no edit form, no Delete", 'data-kpe="edit"' not in pg and "Delete this KPI" not in pn and 'id="kpe-del-' not in pg)
s.check("view-only: read only, and not told it is a past cycle", "Your admin role can't change KPI lines" in pn and "past cycle" not in pn, pn[:200])
r = C["view"].post(URL, data={"csrf_token": "tok", "action": "delete", "kpi_target_id": str(T["Open3"])})
s.check("view-only: a delete POST is refused (403)", r.status_code == 403 and exists("Open3"), r.status_code)

with a.app.app_context():
    _cleanup(a.get_db())
sys.exit(s.done())
