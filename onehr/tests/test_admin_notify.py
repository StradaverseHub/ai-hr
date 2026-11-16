"""Notification emails on admin accounts (Chris, 2026-10-18: "email setting for super admin, to allow multiple emails to
set on super admin account, so any action requires from super admin can be fired via email"; "same for bgadmin and
buadmin account too, to allow assignment of multiple emails for pending tasks notification"; canvas boards 20-21).

What this suite holds (mail is switched on in-process with a recording stub: nothing is sent):
  * an admin sets their own addresses (Account > Notification emails); the super admin sets anyone's; a BG admin sets
    their units' admins'; nobody else's; one address at a time, valid, not twice, at most five; each in the trail
  * opt-in: an admin with no address set gets no email, even with an email on the account
  * a KPI library proposal goes to every super admin's addresses; its answer to the proposer's
  * new joiners (Add a person, the roster import) go to the group's admins over them, a unit admin only for their
    units, never whoever added them, once per import
  * a test email; and no email at all when the server sends none
"""
import csv as _csv
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Notification emails on admin accounts")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, BG2 = "ZZNE Group", "ZZNE Other"
SENT = []
_real = (a.mailer.is_configured, a.mailer.send_mail)


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9NE-%'")]
    db.execute("DELETE FROM pm_library_requests WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM admin_notify_emails WHERE email LIKE '%@zzne.invalid'")
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM notifications WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM admin_companies WHERE admin_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM notifications WHERE to_email LIKE '%@zzne.invalid'")
    db.execute("DELETE FROM activity_log WHERE detail LIKE '%@zzne.invalid%'")
    db.execute("DELETE FROM pm_bg_config WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG, BG2))
    db.commit()


def addrs(uid):
    with a.app.app_context():
        return a.admin_notify_addresses(a.get_db(), uid)


def to(addr):
    return [m for m in SENT if m[0] == addr]


try:
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'U1'),(?, 'U2'),(?, 'U9')", (BG, BG, BG2))
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
        db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, method) "
                   "VALUES (?, '*', '*', 0, '*', 'ZZNE Existing', 'more')", (BG,))

        def adm(eid, bg, email=None, units=()):
            uid = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                             "admin_bg, email) VALUES (?,?, 'x', 'admin', ?,?,?,?)",
                             (eid.lower(), "ZZ NE " + eid[-3:], eid, bg, bg, email)).lastrowid
            for u_ in units:
                db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?,?)", (uid, u_))
            return uid
        BGA = adm("ZZ9NE-BGA", BG, "own.bga@zzne.invalid")
        UN1 = adm("ZZ9NE-UN1", BG, None, ("U1",))
        UN2 = adm("ZZ9NE-UN2", BG, None, ("U2",))
        OTH = adm("ZZ9NE-OTH", BG2, None, ("U9",))
        SUP2 = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, email) VALUES "
                          "('zz9ne-sup', 'ZZ NE Super', 'x', 'admin', 'ZZ9NE-SUP', NULL)").lastrowid
        for eid in ("ZZ9NE-M", "ZZ9NE-H"):
            db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                       "job_grade, confirmation_date) VALUES (?,?, 'x', 'user', ?,?, 'U1', '18', '2020-01-01')",
                       (eid.lower(), "ZZ NE " + eid[-1], eid, BG))
        db.commit()
    SUP = H.client_as(a, SU["id"])
    C = {k: H.client_as(a, v) for k, v in (("bga", BGA), ("un1", UN1), ("oth", OTH), ("sup2", SUP2))}

    def post(client, aid, **kw):
        d = {"csrf_token": "tok"}
        d.update(kw)
        return client.post("/admin/notify/%d" % aid, data=d, follow_redirects=True)

    s.section("setting the addresses: the super admin's (Chris, 2026-10-19: BG and unit admins are view only)")
    pg = C["bga"].get("/admin/notify").get_data(as_text=True)
    s.check("an admin's own page, from the Account menu, says the super admin sets them", "Your notification emails" in pg
            and 'href="/admin/notify"' in pg and "nothing reaches you by email" in pg and "The super admin sets them" in pg)
    r = post(C["bga"], BGA, action="add", email="self@zzne.invalid")
    s.check("a BG admin can't add their own: refused, view only", r.status_code == 403 and addrs(BGA) == [])
    r = post(C["un1"], UN1, action="add", email="self@zzne.invalid")
    s.check("...nor a unit admin", r.status_code == 403 and addrs(UN1) == [])
    r = post(C["bga"], UN1, action="add", email="sneak@zzne.invalid")
    s.check("...nor anyone else's", r.status_code == 403 and addrs(UN1) == [])
    post(SUP, BGA, action="add", email="HR.Shared@zzne.invalid")
    post(SUP, BGA, action="add", email="bga2@zzne.invalid")
    s.check("the super admin adds an admin's (kept lower case)", addrs(BGA) == ["hr.shared@zzne.invalid",
                                                                                 "bga2@zzne.invalid"], addrs(BGA))
    try:   # without the check, the table's UNIQUE would answer with a 500
        post(SUP, BGA, action="add", email="hr.shared@zzne.invalid")
        dupe_ok = True
    except Exception:   # noqa: BLE001
        dupe_ok = False
    post(SUP, BGA, action="add", email="not an address")
    post(SUP, BGA, action="add", email="a@zzne.invalid, b@zzne.invalid")
    s.check("not twice (told so, no error), not a non-address, not two at once", dupe_ok and len(addrs(BGA)) == 2)
    for i in range(5):
        post(SUP, BGA, action="add", email="extra%d@zzne.invalid" % i)
    s.check("at most five", len(addrs(BGA)) == 5, addrs(BGA))
    rid = H.one(a, "SELECT id FROM admin_notify_emails WHERE email='extra2@zzne.invalid'")
    post(SUP, BGA, action="remove", row_id=rid)
    s.check("...and removes one", "extra2@zzne.invalid" not in addrs(BGA) and len(addrs(BGA)) == 4)
    s.check("...each in the trail, on their account", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE action='admin_notify' AND target_user_id=?", (BGA,)) == 6)
    post(SUP, UN1, action="add", email="un1@zzne.invalid")
    post(SUP, SUP2, action="add", email="sup2@zzne.invalid")
    post(SUP, OTH, action="add", email="oth@zzne.invalid")
    s.check("the super admin sets anyone's", addrs(SUP2) == ["sup2@zzne.invalid"] and addrs(OTH) == ["oth@zzne.invalid"]
            and addrs(UN1) == ["un1@zzne.invalid"])
    pg = SUP.get("/admin/admins").get_data(as_text=True)
    s.check("the Admins page's Manage panel shows them, adding and removing through a confirm box",
            "un1@zzne.invalid" in pg and "pending tasks to this address too?" in pg
            and "Stop sending zz9ne-un1's pending tasks to un1@zzne.invalid?" in pg)
    s.check("opt-in: with none set, nowhere, even when the account has its own email", addrs(UN2) == [] and addrs(
        H.one(a, "SELECT id FROM users WHERE employee_id='ZZ9NE-BGA'")) != ["own.bga@zzne.invalid"])
    with a.app.app_context():
        own_only = a.get_db().execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, "
                                      "business_group, admin_bg, email) VALUES ('zz9ne-own', 'ZZ NE Own', 'x', 'admin', "
                                      "'ZZ9NE-OWN', ?, ?, 'own.only@zzne.invalid')", (BG2, BG2)).lastrowid
        a.get_db().commit()
    s.check("...an admin with only their own email set gets none", addrs(own_only) == [])

    s.section("nothing goes out when the server sends no email")
    n0 = H.one(a, "SELECT COUNT(*) FROM notifications WHERE kind='admin_task'")
    with a.app.app_context():
        a._notify_super_admins(a.get_db(), "x", "x", ["x"])
    s.check("no mail configured: nothing sent, nothing logged", H.one(
        a, "SELECT COUNT(*) FROM notifications WHERE kind='admin_task'") == n0)

    a.mailer.is_configured = lambda: True
    a.mailer.send_mail = lambda to_, subj, body, **kw: SENT.append((to_, subj, body))

    s.section("a KPI library proposal and its answer")
    C["bga"].post("/admin/performance/library/propose", data={
        "csrf_token": "tok", "kind": "new_kpi", "scope": "bg", "name": "ZZNE Walk-in conversion", "method": "more",
        "definition": "Walk-ins who order", "reason": "Showrooms carry it"})
    m = to("sup2@zzne.invalid")
    s.check("it reaches every super admin's addresses, saying what and why", len(m) == 1
            and m[0][1] == "A KPI library proposal is waiting for you" and "ZZNE Walk-in conversion" in m[0][2]
            and "Showrooms carry it" in m[0][2])
    s.check("...and not a BG admin", not [x for x in SENT if x[0].startswith("un1@")])
    SENT.clear()
    rq = H.one(a, "SELECT id FROM pm_library_requests WHERE payload_json LIKE '%ZZNE Walk-in%'")
    SUP.post("/admin/performance/library/requests", data={"csrf_token": "tok", "request_id": rq, "action": "reject",
                                                          "note": "Too close to ZZNE Existing"})
    got = sorted(x[0] for x in SENT)
    s.check("its answer reaches every address on the proposer's account, with the reason", got == sorted(
        addrs(BGA)) and all("Too close to ZZNE Existing" in x[2] for x in SENT), got)
    s.check("...each logged", H.one(a, "SELECT COUNT(*) FROM notifications WHERE kind='admin_task' AND user_id=? AND "
                                       "status='sent'", (BGA,)) == len(addrs(BGA)))

    s.section("new joiners")
    SENT.clear()
    SUP.post("/admin/users", data={"csrf_token": "tok", "action": "add_user", "employee_id": "ZZ9NE-J1",
                                   "full_name": "ZZ NE Joiner", "business_group": BG, "company": "U1",
                                   "manager_eid": "ZZ9NE-M", "hod_eid": "ZZ9NE-H", "job_grade": "12",
                                   "joined_date": "2026-10-01"})
    got = {x[0] for x in SENT}
    s.check("Add a person: the group's admin and the unit's admin hear, not another unit's or group's",
            "un1@zzne.invalid" in got and "hr.shared@zzne.invalid" in got and "oth@zzne.invalid" not in got
            and not [x for x in got if x.startswith("un2")], sorted(got))
    s.check("...saying one new joiner, with the way to New joiners", all(
        x[1] == "1 new joiner to set up in ZZNE Group" and "/admin/people/joiners" in x[2] for x in SENT))
    SENT.clear()
    r = C["bga"].post("/admin/users", data={"csrf_token": "tok", "action": "add_user", "employee_id": "ZZ9NE-J2",
                                            "full_name": "ZZ NE Joiner 2", "business_group": BG, "company": "U1",
                                            "manager_eid": "ZZ9NE-M", "hod_eid": "ZZ9NE-H", "job_grade": "12",
                                            "joined_date": "2026-10-01"})
    s.check("a BG admin can't add a person (view only, 2026-10-19): nobody added, nobody emailed",
            r.status_code == 403 and not SENT and not H.rows(a, "SELECT 1 FROM users WHERE employee_id='ZZ9NE-J2'"))
    SENT.clear()
    cols = {c.lower(): c for c in a.ROSTER_COLUMNS}
    buf = io.StringIO()
    w = _csv.writer(buf)
    w.writerow(a.ROSTER_COLUMNS)
    for eid, co in (("ZZ9NE-J3", "U2"), ("ZZ9NE-J4", "U2")):
        rec = dict.fromkeys(a.ROSTER_COLUMNS, "")
        for k, v in {"employee id": eid, "employee name": "ZZ NE " + eid, "business group": BG, "company": co,
                     "manager": "ZZ9NE-M", "job grade": "12", "joined date": "2026-10-01"}.items():
            rec[cols[k]] = v
        w.writerow([rec[c] for c in a.ROSTER_COLUMNS])
    H.import_steps(SUP, "/admin/import/roster", {"mode": "upsert", "file": (io.BytesIO(buf.getvalue().encode()), "ne.csv")})
    by = {}
    for x in SENT:
        by.setdefault(x[0], []).append(x[1])
    s.check("the roster import: once per import, how many", by.get("hr.shared@zzne.invalid") == [
        "2 new joiners to set up in ZZNE Group"], by)
    s.check("...to the unit admin over them (U2 has none with addresses), never U1's", "un1@zzne.invalid" not in by)

    s.section("a test")
    SENT.clear()
    out = post(SUP, SUP2, action="test").get_data(as_text=True)
    s.check("a test email to each address", [x[0] for x in SENT] == ["sup2@zzne.invalid"] and "Sent a test" in out)

    s.section("the forms post where a save is taken (Chris, 2026-10-19: Add address answered 'Method Not Allowed')")
    # url_for('admin_notify', aid=...) built /admin/notify?aid=N (the page) instead of /admin/notify/N (the save):
    # every form now names _method='POST', and every POST form on these pages must reach a rule that takes a POST
    import re as _re
    from werkzeug.exceptions import MethodNotAllowed, NotFound
    _ad = a.app.url_map.bind("localhost")
    for who, c_, path in (("the super admin's own page", SUP, "/admin/notify"), ("the Admins page", SUP, "/admin/admins"),
                          ("a BG admin's own page", C["bga"], "/admin/notify")):
        pg_ = c_.get(path).get_data(as_text=True)
        acts = _re.findall(r'<form method="post" action="([^"]+)"', pg_)
        wrong = []
        for act in acts:
            pth, _q, qs = act.partition("?")
            try:
                _ad.match(pth, method="POST", query_args=qs)
            except (MethodNotAllowed, NotFound) as e_:
                wrong.append("%s (%s)" % (act, type(e_).__name__))
        s.check("%s: every save form posts to an address that takes it (%d forms)" % (who, len(acts)),
                acts and not wrong, wrong[:4])
    s.check("Add address on the super admin's own page goes to /admin/notify/<their id>",
            ('action="/admin/notify/%d"' % SU["id"]) in SUP.get("/admin/notify").get_data(as_text=True))
finally:
    a.mailer.is_configured, a.mailer.send_mail = _real
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
