"""A person's full name in the person page's Edit details panel (Chris, 2026-10-20: "add full name to the edit panel";
canvas [design canvas link removed], board 6).

The super admin changes it through the panel's preview ("What this changes": Full name old -> new, a note that a roster
import writes the file's name, and who else already has the new name), then Save. Spaces are tidied, an empty name is
refused, and no other admin can change it (the field isn't shown to them, and the server refuses it). The trail keeps
the old name. Everything here is synthetic (ZZPN-*) and removed at the end.
"""
import html
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A person's full name in Edit details")

SU, BGA, _emp = H.actors(a)
SUP = SU["id"]


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZPN-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    _cleanup(db)
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 "
                           "AND COALESCE(company,'')!='' LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, name):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, left_at=None, is_demo=0,
                 role="user", manager_id=None, hod_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None,
                 admin_bg=None)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
    U = mk("ZZPN-1", "ZZ PN Old Name")
    TWIN = mk("ZZPN-2", "ZZ PN Taken Name")
    db.commit()
    P0 = dict(db.execute("SELECT * FROM users WHERE id=?", (U,)).fetchone())


def form(action, name, **kw):
    d = {"csrf_token": "tok", "action": action, "full_name": name, "company": P0["company"] or "",
         "department": P0["department"] or "", "job_title": P0["job_title"] or "", "job_grade": P0["job_grade"] or ""}
    d.update(kw)
    return d


def name_now():
    return H.one(a, "SELECT full_name FROM users WHERE id=?", (U,))


def text(r):
    return html.unescape(r.get_data(as_text=True))


sup = H.client_as(a, SUP)
try:
    s.section("The super admin's Edit details panel")
    b = text(sup.get("/admin/users/%d?panel=details" % U))
    s.check("the panel opens on Full name, the person's name in it", 'name="full_name" value="ZZ PN Old Name"' in b
            and "Super admin only." in b)

    s.section("Preview, then Save")
    r = sup.post("/admin/users/%d/lines" % U, data=form("details_preview", "  ZZ   PN  New Name "))
    b = text(r)
    s.check("the preview names the change, old to new, with spaces tidied, and nothing is saved yet",
            "Full name" in b and "ZZ PN Old Name" in b and "ZZ PN New Name" in b and name_now() == "ZZ PN Old Name"
            and 'name="full_name" value="ZZ PN New Name"' in b, name_now())
    s.check("...and says a roster import writes the file's name", "A roster import with their Employee ID writes the "
            "name in its file" in b)
    r = sup.post("/admin/users/%d/lines" % U, data=form("details_apply", "ZZ PN New Name"), follow_redirects=True)
    s.check("Save renames them, the flash naming the old name", name_now() == "ZZ PN New Name"
            and "Details saved for ZZ PN New Name (was ZZ PN Old Name)" in text(r), name_now())
    s.check("the trail keeps the old name", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='set_details' "
                                                     "AND target_user_id=? AND detail LIKE ?",
                                                     (U, "%full name ZZ PN Old Name -> ZZ PN New Name%")) == 1)
    r = sup.post("/admin/users/%d/lines" % U, data=form("details_apply", "ZZ PN New Name"), follow_redirects=True)
    s.check("the same name again changes nothing", "Nothing changed." in text(r))

    s.section("The guards")
    r = sup.post("/admin/users/%d/lines" % U, data=form("details_preview", "   "), follow_redirects=True)
    s.check("an empty name is refused, the name kept", "A name can't be empty." in text(r)
            and name_now() == "ZZ PN New Name", name_now())
    b = text(sup.post("/admin/users/%d/lines" % U, data=form("details_preview", "ZZ PN Taken Name")))
    s.check("a name someone here already has: said, not refused", "1 other person here is already called ZZ PN Taken "
            "Name" in b)
    if BGA is not None:
        with a.app.test_request_context("/admin/users/%d/lines" % U, method="POST",
                                        data=form("details_apply", "ZZ PN By A BG Admin")):
            db = a.get_db()
            p = db.execute("SELECT * FROM users WHERE id=?", (U,)).fetchone()
            a._person_details(db, BGA, p, True)
        s.check("another admin can't change a name, even posting one", name_now() == "ZZ PN New Name", name_now())
        with a.app.test_request_context("/admin/users/%d" % U):
            db = a.get_db()
            src = open(os.path.join(os.path.dirname(a.__file__), "templates", "person", "_overview.html"),
                       encoding="utf-8").read()
        s.check("...and the field is the super admin's only in the panel",
                "{% if is_super %}<label>Full name<input name=\"full_name\"" in src
                and "{% if is_super %}<input type=\"hidden\" name=\"full_name\"" in src)
    else:
        s.note("no BG admin on this database: the non-super checks were skipped")
    s.check("every template still compiles", H.every_template_compiles(a))
finally:
    with a.app.test_request_context("/"):
        _cleanup(a.get_db())
s.done()
