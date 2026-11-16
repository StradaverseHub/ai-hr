"""Taken out of a cycle on Participants, someone is no longer rated in its 360 (Chris, 2026-10-23: "check it and fix if
needed"). Before, Take out changed whether their own review was required but left the 360 panel built for them live,
so every rater still had them to rate (the AI+ check-in's 360 list, My assessments, the dashboard read the panel rows).

What this suite holds:
  * Take out archives their 360 rows as the person rated, with its own reason; their rows rating others stay
  * a rater's own list no longer has them
  * brought back (added), the rows return one by one as each rater's cap allows; a row the cap keeps back stays
    archived and is said; back to the confirmation rule, taking part by it, returns the rest
  * a row archived for any other reason is never brought back by it
  * the audit line says how many; the confirm box says what happens to their 360
"""
import html
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Taken out of a cycle: their 360 is archived, and back with them")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
C_SU = H.client_as(a, SU["id"])
REASON = a.PARTICIPANT_OUT_REASON

with a.app.app_context():
    db = a.get_db()
    cyc = a.active_cycle(db)
    CID = cyc["id"]
    CAP0 = db.execute("SELECT assessor_cap FROM cycles WHERE id=?", (CID,)).fetchone()[0]
    # someone taking part by the rule, rated by three or more and rating someone themself, with no admin setting yet
    P = db.execute(
        "SELECT u.id FROM users u WHERE u.role!='admin' AND " + a.participant_sql("u", "tm_rated") + " AND NOT EXISTS "
        "(SELECT 1 FROM cycle_participants cp WHERE cp.cycle_id=? AND cp.subject_id=u.id) AND (SELECT COUNT(*) FROM "
        "assignments x WHERE x.cycle_id=? AND x.subject_id=u.id AND x.archived=0) >= 3 AND EXISTS (SELECT 1 FROM "
        "assignments y WHERE y.cycle_id=? AND y.assessor_id=u.id AND y.archived=0) ORDER BY u.id LIMIT 1",
        (CID, CID, CID)).fetchone()[0]
    rated0 = [r[0] for r in db.execute("SELECT id FROM assignments WHERE cycle_id=? AND subject_id=? AND archived=0 "
                                       "ORDER BY id", (CID, P))]
    rating0 = {r[0]: tuple(r[1:]) for r in db.execute(
        "SELECT id, archived, archive_reason FROM assignments WHERE cycle_id=? AND assessor_id=?", (CID, P))}
    OTHER = rated0[0]   # archived beforehand for another reason: never brought back by Take out's way back
    db.execute("UPDATE assignments SET archived=1, archived_at=datetime('now'), archive_reason='ZZPO other reason' "
               "WHERE id=?", (OTHER,))
    db.commit()
    rated = rated0[1:]
    R = db.execute("SELECT assessor_id FROM assignments WHERE id=?", (rated[0],)).fetchone()[0]
    LOG0 = db.execute("SELECT COALESCE(MAX(id), 0) FROM activity_log").fetchone()[0]


def state(ids):
    with a.app.app_context():
        db = a.get_db()
        return {r[0]: (r[1], r[2]) for r in db.execute(
            "SELECT id, archived, archive_reason FROM assignments WHERE id IN (%s)" % ",".join("?" * len(ids)), ids)}


def post(action):
    return C_SU.post("/admin/participants", data={"csrf_token": "tok", "action": action, "ids": [str(P)]},
                     follow_redirects=True)


try:
    s.section("Take out: their 360 as the person rated is archived, with its reason")
    r = post("remove")
    st = state(rated)
    s.check("every live row where they're the one rated is archived, marked as taken out",
            all(v == (1, REASON) for v in st.values()), st)
    with a.app.app_context():
        db = a.get_db()
        rating = {r_[0]: tuple(r_[1:]) for r_ in db.execute(
            "SELECT id, archived, archive_reason FROM assignments WHERE cycle_id=? AND assessor_id=?", (CID, P))}
        rater = db.execute("SELECT * FROM users WHERE id=?", (R,)).fetchone()
        theirs = a._feedback_assignments(db, rater, CID)
        owes = [x for x in theirs if (x.get("subject_id") if isinstance(x, dict) else x["subject_id"]) == P]
    s.check("...their rows rating others stay as they were: they still rate colleagues", rating == rating0)
    s.check("...and a rater's own list no longer has them", owes == [], len(owes))
    s.check("the page says so", "where they're the one rated" in html.unescape(r.get_data(as_text=True)))
    s.check("the audit line counts them", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE id>? AND action='participant' AND target_user_id=? AND detail LIKE ?",
        (LOG0, P, "%% %d 360 row%s as the person rated archived%%" % (len(rated), "" if len(rated) == 1 else "s"))) == 1)

    s.section("Brought back: the rows return as each rater's cap allows")

    def loads():   # each of their raters' live rows now, read on its own
        with a.app.app_context():
            db = a.get_db()
            who = {i: db.execute("SELECT assessor_id FROM assignments WHERE id=?", (i,)).fetchone()[0] for i in rated}
            n = {x: db.execute("SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND assessor_id=? AND archived=0",
                               (CID, x)).fetchone()[0] for x in set(who.values())}
        return who, n

    who, n = loads()
    top = max(n.values())   # the cap set to the busiest of their raters' loads: that one (and any as busy) waits
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycles SET assessor_cap=? WHERE id=?", (top, CID))
        db.commit()
    want_back = {i for i in rated if n[who[i]] < top}
    r = post("add")
    st = state(rated)
    s.check("added: a row returns where its rater is under the cap; where the rater is at it, it stays archived",
            {i for i, v in st.items() if v == (0, None)} == want_back
            and all(st[i] == (1, REASON) for i in rated if i not in want_back) and len(want_back) < len(rated),
            (len(want_back), len(rated), st))
    s.check("...and the page says rows were kept back by the cap", "kept back" in r.get_data(as_text=True))
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycles SET assessor_cap=? WHERE id=?", (top + 1, CID))
        db.commit()
    post("clear")
    st = state(rated)
    s.check("back to the confirmation rule (taking part by it), with room under the cap, the rest returns",
            all(v == (0, None) for v in st.values()), st)
    s.check("a row archived for another reason is never brought back by it",
            state([OTHER])[OTHER][1] == "ZZPO other reason" and state([OTHER])[OTHER][0] == 1)

    s.section("the confirm box says what happens to their 360")
    tpl = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "templates", "admin_participants.html"),
               encoding="utf-8").read()
    s.check("Take out's message names the 360 and the way back", "Their 360, where they are the one rated, is archived"
            in tpl and "bringing them back returns their 360" in tpl)
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycles SET assessor_cap=? WHERE id=?", (CAP0, CID))
        db.execute("DELETE FROM cycle_participants WHERE cycle_id=? AND subject_id=?", (CID, P))
        db.execute("UPDATE assignments SET archived=0, archived_at=NULL, archived_by=NULL, archive_reason=NULL "
                   "WHERE id IN (%s)" % ",".join("?" * len(rated0)), rated0)
        db.execute("DELETE FROM activity_log WHERE id>? AND action='participant' AND target_user_id=?", (LOG0, P))
        db.commit()

sys.exit(s.done())
