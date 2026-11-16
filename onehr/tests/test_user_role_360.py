"""A user role by hand that leaves out "360 feedback about them" takes the person off their raters' lists, and People ›
Users › Give a user role gives one role to several people at once (Chris, 2026-10-23, the BRE staff: "looks like we
need a new user access for only 360, IDP, and LMS", then "only rate others" and "fix + bulk give").

What this suite holds:
  * a role copied from Basic (rating colleagues, Career Plan, Learning) leaves out being rated: given by hand, their live
    360 rows as the person rated are archived with the role's reason; their rows rating others stay
  * back on Automatic (taking part by the rule), those rows return; a person also taken out on Participants stays out
    until that is undone, whatever their role
  * Give a user role: the super admin's page lists people with their role now and the roles to give; ticked people get
    the role through the same writer, the 360 following; a BG admin can neither open it nor post it
"""
import html
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A user role by hand: the 360 follows it, and Give a user role for several")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
C_SU = H.client_as(a, SU["id"])
ROLE_NAME = "ZZUR Rater, Career Plan, Learning"

with a.app.app_context():
    db = a.get_db()
    cyc = a.active_cycle(db)
    CID = cyc["id"]
    CAP0 = db.execute("SELECT assessor_cap FROM cycles WHERE id=?", (CID,)).fetchone()[0]
    db.execute("DELETE FROM user_roles WHERE name=?", (ROLE_NAME,))
    um = a._urole_map(db)
    RID = db.execute("INSERT INTO user_roles(name, created_by) VALUES (?,?)", (ROLE_NAME, SU["id"])).lastrowid
    db.executemany("INSERT INTO user_role_modules(role_id, module) VALUES (?,?)",
                   [(RID, m) for m in sorted(um["mods"].get(um["basic"], set()))])
    MODS = set(um["mods"].get(um["basic"], set()))
    two = [r[0] for r in db.execute(
        "SELECT u.id FROM users u WHERE u.role!='admin' AND u.user_role_id IS NULL AND " + a.participant_sql("u", "tm_rated")
        + " AND NOT EXISTS (SELECT 1 FROM cycle_participants cp WHERE cp.cycle_id=? AND cp.subject_id=u.id) AND "
        "(SELECT COUNT(*) FROM assignments x WHERE x.cycle_id=? AND x.subject_id=u.id AND x.archived=0) >= 2 AND EXISTS "
        "(SELECT 1 FROM assignments y WHERE y.cycle_id=? AND y.assessor_id=u.id AND y.archived=0) ORDER BY u.id LIMIT 2",
        (CID, CID, CID))]
    P, Q = two
    rated = {u: [r[0] for r in db.execute("SELECT id FROM assignments WHERE cycle_id=? AND subject_id=? AND archived=0",
                                          (CID, u))] for u in two}
    rating0 = {r[0]: (r[1], r[2]) for r in db.execute(
        "SELECT id, archived, archive_reason FROM assignments WHERE cycle_id=? AND assessor_id IN (?,?)", (CID, P, Q))}
    db.execute("UPDATE cycles SET assessor_cap=99 WHERE id=?", (CID,))   # room for every row to come back
    LOG0 = db.execute("SELECT COALESCE(MAX(id), 0) FROM activity_log").fetchone()[0]
    db.commit()


def st(u):
    with a.app.app_context():
        db = a.get_db()
        return {r[0]: (r[1], r[2]) for r in db.execute(
            "SELECT id, archived, archive_reason FROM assignments WHERE id IN (%s)" % ",".join("?" * len(rated[u])),
            rated[u])}


def page(r):
    return html.unescape(r.get_data(as_text=True))


try:
    s.section("the role: Basic's, rating colleagues but not rated")
    s.check("copied from Basic it rates colleagues and isn't rated in the 360", "tm_rate" in MODS
            and "tm_rated" not in MODS and "pm" not in MODS and "competency" not in MODS, sorted(MODS))

    s.section("given by hand on the person page: off their raters' lists; back on Automatic: back")
    r = C_SU.post("/admin/users/%d/user-role" % P, data={"csrf_token": "tok", "user_role_id": str(RID)},
                  follow_redirects=True)
    s.check("their live rows as the person rated are archived with the role's reason",
            all(v == (1, a.ROLE_OUT_REASON) for v in st(P).values()), st(P))
    s.check("...the page says so", "where they're rated archived" in page(r))
    with a.app.app_context():
        db = a.get_db()
        rating = {r_[0]: (r_[1], r_[2]) for r_ in db.execute(
            "SELECT id, archived, archive_reason FROM assignments WHERE cycle_id=? AND assessor_id IN (?,?)", (CID, P, Q))}
        pu = db.execute("SELECT * FROM users WHERE id=?", (P,)).fetchone()
        rates = a.urole_allows(pu, "tm_rate", db)
    s.check("...their rows rating others stay, and the role still lets them rate", rating == rating0 and rates)
    s.check("...the audit line counts them", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE id>? AND action='user_role_set' AND target_user_id=? AND detail LIKE ?",
        (LOG0, P, "%%user role %s%%360 row%% archived%%" % ROLE_NAME)) == 1)
    C_SU.post("/admin/users/%d/user-role" % P, data={"csrf_token": "tok", "user_role_id": ""})
    s.check("back on Automatic (taking part by the rule): the rows return", all(v == (0, None) for v in st(P).values()),
            st(P))

    s.section("taken out on Participants too: out until that is undone, whatever the role")
    C_SU.post("/admin/participants", data={"csrf_token": "tok", "action": "remove", "ids": [str(P)]})
    C_SU.post("/admin/users/%d/user-role" % P, data={"csrf_token": "tok", "user_role_id": str(RID)})
    C_SU.post("/admin/users/%d/user-role" % P, data={"csrf_token": "tok", "user_role_id": ""})
    s.check("back on Automatic while still taken out: the rows stay archived",
            all(v[0] == 1 for v in st(P).values()), st(P))
    C_SU.post("/admin/participants", data={"csrf_token": "tok", "action": "clear", "ids": [str(P)]})
    s.check("...and the take-out undone, they return", all(v == (0, None) for v in st(P).values()), st(P))

    s.section("People › Users › Give a user role: several at once, the super admin's")
    g = page(C_SU.get("/admin/users?view=urole"))
    s.check("the page lists people with their role now and offers the roles", 'name="user_role_id"' in g
            and ROLE_NAME in g and "User role now" in g and 'value="bulk_user_role"' in g)
    s.check("...Users links to it", 'view=urole' in page(C_SU.get("/admin/users")))
    r = C_SU.post("/admin/users", data={"csrf_token": "tok", "action": "bulk_user_role", "user_role_id": str(RID),
                                        "user_id": [str(P), str(Q)]}, follow_redirects=True)
    with a.app.app_context():
        db = a.get_db()
        held = {r_[0]: r_[1] for r_ in db.execute("SELECT id, user_role_id FROM users WHERE id IN (?,?)", (P, Q))}
    s.check("both now hold the role, and their 360 as the person rated is archived",
            held == {P: RID, Q: RID} and all(v[0] == 1 for u in (P, Q) for v in st(u).values()), held)
    s.check("...the page says how many", "2 people now on %s" % ROLE_NAME in page(r))
    C_SU.post("/admin/users", data={"csrf_token": "tok", "action": "bulk_user_role", "user_role_id": "auto",
                                    "user_id": [str(P), str(Q)]})
    with a.app.app_context():
        db = a.get_db()
        held = {r_[0]: r_[1] for r_ in db.execute("SELECT id, user_role_id FROM users WHERE id IN (?,?)", (P, Q))}
    s.check("back on Automatic for both, their rows back", held == {P: None, Q: None}
            and all(v == (0, None) for u in (P, Q) for v in st(u).values()), held)
    if BGA:
        C_BGA = H.client_as(a, BGA["id"])
        no = C_BGA.post("/admin/users", data={"csrf_token": "tok", "action": "bulk_user_role", "user_role_id": str(RID),
                                              "user_id": [str(P)]})
        with a.app.app_context():
            db = a.get_db()
            still = db.execute("SELECT user_role_id FROM users WHERE id=?", (P,)).fetchone()[0]
        s.check("a BG admin can't give it", no.status_code in (302, 403) and still is None, no.status_code)
        s.check("...nor open the page", 'name="user_role_id"' not in page(C_BGA.get("/admin/users?view=urole")))
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycles SET assessor_cap=? WHERE id=?", (CAP0, CID))
        db.execute("UPDATE users SET user_role_id=NULL WHERE id IN (?,?)", (P, Q))
        db.execute("DELETE FROM cycle_participants WHERE cycle_id=? AND subject_id IN (?,?)", (CID, P, Q))
        for u in (P, Q):
            db.execute("UPDATE assignments SET archived=0, archived_at=NULL, archived_by=NULL, archive_reason=NULL "
                       "WHERE id IN (%s)" % ",".join("?" * len(rated[u])), rated[u])
        db.execute("DELETE FROM user_role_modules WHERE role_id=?", (RID,))
        db.execute("DELETE FROM user_roles WHERE id=?", (RID,))
        db.execute("DELETE FROM activity_log WHERE id>? AND target_user_id IN (?,?)", (LOG0, P, Q))
        db.commit()

sys.exit(s.done())
