"""Who may give and take a BU CEO / BG CEO / Group Chief seat (Chris, 2026-10-18: "only bg admin can appoint buceo and
bgceo"; it was 2026-10-13's "BU admin can edit and add BUCEO, BG admin can edit and add BGCEO, BUCEO").

What this suite holds:
  * the rule (_seat_scope_error, kept underneath): a unit admin -- no seat at all; a BG admin -- BU CEO and BG CEO in
    their group; the super admin -- everything; Group Chief -- the super admin only
  * since 2026-10-19 BG and unit admins are view only in the admin portal (Chris: "only super admin can have the full
    access"): on the Leaders page, the person page and the roster import their seat changes are refused and change
    nothing; the super admin gives and takes seats

Self-contained: its own business groups, units, admins and people, deleted at the end.
"""
import csv as _csv
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Seat rules -- a unit admin, a BG admin and the super admin on BU CEO, BG CEO and Group Chief")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, OT = "ZZSR Seat Group", "ZZSR Other Group"
U1, U2, U3 = "ZZSR Unit One", "ZZSR Unit Two", "ZZSR Unit Three"
ids = {}


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZSR-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM buceo_seats WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM admin_companies WHERE admin_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM buceo_seats WHERE business_group IN (?,?)", (BG, OT))
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG, OT))
    db.execute("DELETE FROM admin_role_access WHERE role_id IN (SELECT id FROM admin_roles WHERE name LIKE 'ZZSR %')")
    db.execute("DELETE FROM admin_roles WHERE name LIKE 'ZZSR %'")
    db.commit()


def give_role(uid, items):
    """Put this admin on a test role holding exactly these items (None = back to their built-in role)."""
    with a.app.app_context():
        db = a.get_db()
        if items is None:
            db.execute("UPDATE users SET admin_role_id=NULL WHERE id=?", (uid,))
        else:
            name = "ZZSR role %d" % uid
            db.execute("INSERT OR IGNORE INTO admin_roles(name, scope_kind) VALUES (?, 'group')", (name,))
            rid = db.execute("SELECT id FROM admin_roles WHERE name=?", (name,)).fetchone()[0]
            db.execute("DELETE FROM admin_role_access WHERE role_id=?", (rid,))
            db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(rid, k) for k in items])
            db.execute("UPDATE users SET admin_role_id=? WHERE id=?", (rid, uid))
        db.commit()


READS = sorted(a.role_preset_items("view"))   # View only: every module's reads


def user(uid):
    return a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()


try:
    with a.app.app_context():
        db = a.get_db()
        _cleanup(db)
        for b_, c_ in ((BG, U1), (BG, U2), (OT, U3)):
            db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (b_, c_))

        def mk(eid, role="user", bg=BG, co=U1, admin_bg=None):
            return db.execute(
                "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                "department, job_grade, confirmation_date, admin_bg) VALUES (?,?, 'x', ?, ?, ?, ?, 'ZZ Dept', '16', "
                "'2020-01-01', ?)", (eid.lower(), "ZZ SR " + eid[5:], role, eid, bg, co, admin_bg)).lastrowid
        ids["bgadm"] = mk("ZZSR-BGADM", "admin", admin_bg=BG)
        ids["subadm"] = mk("ZZSR-SUBADM", "admin", admin_bg=BG)
        db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?,?)", (ids["subadm"], U1))
        ids["p1"] = mk("ZZSR-P1", co=U1)
        ids["p2"] = mk("ZZSR-P2", co=U2)
        ids["p3"] = mk("ZZSR-P3", bg=OT, co=U3)
        db.commit()

    s.section("the rule (on a role that holds the seat ticks: the built-in BG admin role is View only)")
    give_role(ids["bgadm"], READS + ["leaders.seat", "leaders.unseat"])
    give_role(ids["subadm"], READS + ["leaders.seat", "leaders.unseat"])
    with a.app.test_request_context("/"):
        bga, sub, su = user(ids["bgadm"]), user(ids["subadm"]), user(SU["id"])
        E = a._seat_scope_error
        s.check("a BG admin: BU CEO of any unit of their group, BG CEO of their group",
                E(bga, "buceo", BG, U1) is None and E(bga, "buceo", BG, U2) is None and E(bga, "bgceo", BG) is None)
        s.check("...never another group's, never a Group Chief",
                E(bga, "buceo", OT, U3) and E(bga, "bgceo", OT) and E(bga, "gc", ""))
        s.check("a unit admin: no seat, not even BU CEO of their own unit", E(sub, "buceo", BG, U1)
                and E(sub, "buceo", BG, U2) and E(sub, "bgceo", BG) and E(sub, "gc", ""), E(sub, "buceo", BG, U1))
        s.check("...and the refusal names who can", "business group's admin" in (E(sub, "buceo", BG, U1) or ""))
        s.check("the super admin: everything", all(x is None for x in (
            E(su, "buceo", OT, U3), E(su, "bgceo", OT), E(su, "gc", ""))))
    give_role(ids["bgadm"], READS + ["leaders.seat"])
    with a.app.test_request_context("/"):
        bga = user(ids["bgadm"])
        s.check("the seat tick gives, the unseat tick takes away (Roles & access, 2026-10-21)",
                E(bga, "buceo", BG, U1) is None and "taking a CEO seat away" in (E(bga, "buceo", BG, U1, clear=True) or "")
                and "taking" in (E(bga, "bgceo", BG, clear=True) or ""), E(bga, "buceo", BG, U1, clear=True))
    give_role(ids["bgadm"], READS + ["people.roster", "people.details", "people.add"])
    with a.app.test_request_context("/"):
        bga = user(ids["bgadm"])
        s.check("...a role that edits people but not seats: no seat, in their own group too",
                "appointing a BU or BG CEO" in (E(bga, "buceo", BG, U1) or "") and E(bga, "bgceo", BG)
                and E(bga, "buceo", BG, U1, clear=True), E(bga, "buceo", BG, U1))
    give_role(ids["bgadm"], None)
    give_role(ids["subadm"], None)

    s.section("the Leaders page: view only for BG and unit admins (Chris, 2026-10-19)")
    BGC, SUB, SUP = H.client_as(a, ids["bgadm"]), H.client_as(a, ids["subadm"]), H.client_as(a, SU["id"])
    r = BGC.post("/admin/leaders", data={"csrf_token": "tok", "action": "set_buceo", "bg": BG, "tab": "buceo",
                                          "company": U2, "person_id": ids["p2"]})
    s.check("a BG admin can't make a BU CEO, even in their group: refused, nothing set", r.status_code == 403
            and not H.rows(a, "SELECT 1 FROM buceo_seats WHERE business_group=? AND company=?", (BG, U2)))
    r = BGC.post("/admin/leaders", data={"csrf_token": "tok", "action": "set_bgceo", "bg": BG, "tab": "bgceo",
                                          "target_bg": BG, "person_id": ids["p1"]})
    s.check("...nor their group's BG CEO", r.status_code == 403 and H.one(
        a, "SELECT COALESCE(bgceo_bg,'') FROM users WHERE id=?", (ids["p1"],)) == "")
    r = SUB.post("/admin/leaders", data={"csrf_token": "tok", "action": "set_buceo", "bg": BG, "tab": "buceo",
                                          "company": U1, "person_id": ids["p1"]})
    s.check("a unit admin can't either", r.status_code == 403 and not H.rows(
        a, "SELECT 1 FROM buceo_seats WHERE business_group=? AND company=?", (BG, U1)))
    SUP.post("/admin/leaders", data={"csrf_token": "tok", "action": "set_buceo", "bg": BG, "tab": "buceo",
                                      "company": U1, "person_id": ids["p1"]})
    SUP.post("/admin/leaders", data={"csrf_token": "tok", "action": "set_bgceo", "bg": BG, "tab": "bgceo",
                                      "target_bg": BG, "person_id": ids["p1"]})
    s.check("the super admin makes the BU CEO and the BG CEO", H.rows(
        a, "SELECT user_id FROM buceo_seats WHERE business_group=? AND company=?", (BG, U1))[0][0] == ids["p1"]
        and H.one(a, "SELECT bgceo_bg FROM users WHERE id=?", (ids["p1"],)) == BG)
    r = BGC.post("/admin/leaders", data={"csrf_token": "tok", "action": "clear_buceo", "bg": BG, "tab": "buceo",
                                          "company": U1})
    s.check("a BG admin can't take a seat away", r.status_code == 403 and bool(H.rows(
        a, "SELECT 1 FROM buceo_seats WHERE business_group=? AND company=?", (BG, U1))))
    SUP.post("/admin/leaders", data={"csrf_token": "tok", "action": "clear_buceo", "bg": BG, "tab": "buceo",
                                      "company": U1})
    s.check("...the super admin can", not H.rows(a, "SELECT 1 FROM buceo_seats WHERE business_group=? AND company=?",
                                                 (BG, U1)))
    pg = BGC.get("/admin/leaders?bg=%s&tab=buceo" % BG).get_data(as_text=True)
    s.check("a BG admin still reads the page, marked view only for the script, with no note (Chris, 2026-10-20)",
            r.status_code == 403 and "data-adm-viewonly" in pg and "View only." not in pg)

    s.section("the person page")
    pg = BGC.get("/admin/users/%d" % ids["p1"]).get_data(as_text=True)
    s.check("a BG admin reads a person's page, view only", "data-adm-viewonly" in pg)
    r = BGC.post("/admin/users/%d/lines" % ids["p2"], data={"csrf_token": "tok", "action": "set_gc", "group_id": 1})
    s.check("...and their seat changes there are refused too", r.status_code == 403, r.status_code)

    s.section("the roster import")
    cols = {c.lower(): c for c in a.ROSTER_COLUMNS}

    def csvfile(**kw):
        row = dict(zip(a.ROSTER_COLUMNS, [""] * len(a.ROSTER_COLUMNS)))
        for k, v in kw.items():
            row[cols[k]] = v
        buf = io.StringIO()
        w = _csv.writer(buf)
        w.writerow(a.ROSTER_COLUMNS)
        w.writerow([row[c] for c in a.ROSTER_COLUMNS])
        return io.BytesIO(buf.getvalue().encode())

    def upload(client, **kw):
        r_ = client.post("/admin/import/roster", data={"csrf_token": "tok", "mode": "upsert", "preview": "1",
                                                        "file": (csvfile(**kw), "s.csv")},
                         content_type="multipart/form-data")
        if r_.status_code == 403:
            return None
        tok_ = r_.headers.get("Location", "").split("check=")[-1]
        client.post("/admin/import/roster", data={"csrf_token": "tok", "token": tok_, "action": "quality_ok", "ack": "1"})
        return (client.get("/admin/import/roster?check=" + tok_).get_data(as_text=True)
                + client.get("/admin/import/roster?check=%s&step=changes" % tok_).get_data(as_text=True))
    base = {"employee id": "ZZSR-P2", "employee name": "ZZ SR P2", "business group": BG, "company": U2}
    s.check("a BG admin can't import the roster at all (view only)",
            upload(BGC, **dict(base, **{"bu ceo of": "%s; %s" % (U1, U2)})) is None)
    s.check("...nor a unit admin", upload(SUB, **dict(base, **{"bu ceo of": U2})) is None)
    pg = upload(SUP, **dict(base, **{"bu ceo of": "%s; %s" % (U1, U2)}))
    s.check("the super admin's file sets BU CEO of units", pg and "Role changes" in pg
            and "can&#39;t be imported" not in pg.split("Role changes")[0][-400:])
    # the roster file is the super admin's alone (Chris, 2026-10-31, finding 1a-04): no role can import it, whatever
    # ticks it holds. The seat refusal stays in the check itself, for any admin who ever reaches it.
    give_role(ids["bgadm"], READS + ["people.details", "people.add", "people.close", "leaders.seat"])
    BGC = H.client_as(a, ids["bgadm"])
    s.check("a BG admin's role can't import the roster, with every people tick and the seat tick",
            upload(BGC, **dict(base, **{"employee name": "ZZ SR P2 Renamed"})) is None
            and H.one(a, "SELECT full_name FROM users WHERE employee_id='ZZSR-P2'") != "ZZ SR P2 Renamed")
    give_role(ids["bgadm"], READS + ["people.details", "people.add", "people.close"])
    with a.app.test_request_context("/"):
        bga = user(ids["bgadm"])
        d_ = a.get_db()
        for col, val in (("bu ceo of", U2), ("bg ceo of", BG)):
            ch_ = a._roster_check(d_, bga, [dict(base, **{col: val})], False)
            s.check("...and the check still refuses a '%s' column from a role without the seat tick" % col,
                    any("appointing a BU or BG CEO" in e["why"] for e in ch_["errors"]), ch_["errors"][:2])
    give_role(ids["bgadm"], None)
finally:
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
