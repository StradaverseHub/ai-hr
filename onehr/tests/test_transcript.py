"""The saved review transcript, surfaced two ways (2026-09-20):
  * ADMIN AUDIT -- /admin/users/<uid>/conversation, the SUPER ADMIN's only since 2026-10-20 (was
    /admin/subjects/<uid>/transcript, any admin in scope; test_conversation_access holds the rest). Reads an ARBITRARY subject's pm_review_chat via _review_chat_history's new
    subject_id param.
  * EMPLOYEE HISTORY -- /review/history, self-scoped, read-only (no composer, no write route).

Writes pm_review_chat rows, so a fresh copy.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Review transcript -- admin audit + employee history")

SECRET = "OTHER PERSON PRIVATE NOTE"
MINE = "I negotiated a 5% bulk discount with TYL Cement."

# ---------------------------------------------------------------------------
s.section("seed a transcript for one subject (+ a second subject's private row)")
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    # /review/history is classified 'review', so the module gate 404s it when review is OFF. The
    # generated CI fixture ships review off (it never seeds cycle_modules), so force it ON here --
    # the same setup step every other review suite does. (The repo's real DB has review on, which is
    # why this suite passed locally but 404'd the employee-history checks on CI.)
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','evidence')")
    db.commit()
    subs = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL "
                      "ORDER BY id LIMIT 2").fetchall()
    SUBJ, OTHER = subs[0], subs[1]
    SUBJ_BG = SUBJ["business_group"]
    for role, content in (("user", "I've saved my results."),
                          ("agent", "Gross Profit landed Outstanding -- what drove it?"),
                          ("user", MINE)):
        db.execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, stage) "
                   "VALUES (?,?,?,?, 'account')", (SUBJ["id"], CID, role, content))
    db.execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, stage) "
               "VALUES (?,?,'user',?, 'account')", (OTHER["id"], CID, SECRET))
    db.commit()

# ---------------------------------------------------------------------------
s.section("the reader is subject-scoped (reads the SUBJECT, not the caller)")
with a.app.app_context():
    db = a.get_db()
    su = db.execute("SELECT * FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' "
                    "LIMIT 1").fetchone()
    msgs = a._review_chat_history(db, dict(su), CID, limit=None, subject_id=SUBJ["id"])
    joined = " ".join(m["content"] for m in msgs)
    s.check("_review_chat_history(subject_id=X) returns X's rows", MINE in joined, joined[:120])
    s.check("...and NOT another subject's rows", SECRET not in joined, joined[:120])
    s.check("...it carries the stage tag for grouping",
            any(m.get("stage") == "account" for m in msgs), msgs[:1])

# ---------------------------------------------------------------------------
s.section("admin audit route -- the super admin's only")
SU, BG, EMP = H.actors(a)
URL = "/admin/users/%d/conversation" % SUBJ["id"]

r = H.client_as(a, SU["id"]).get(URL)
s.check("a super admin opens the transcript (200) and sees the subject's words",
        r.status_code == 200 and MINE.encode() in r.data, r.status_code)
s.check("...and it does NOT leak another subject's row", SECRET.encode() not in r.data, None)

r_emp = H.client_as(a, OTHER["id"]).get(URL)
s.check("a non-admin employee is refused (403)", r_emp.status_code == 403, r_emp.status_code)

r404 = H.client_as(a, SU["id"]).get("/admin/users/99999999/conversation")
s.check("a missing subject is 404", r404.status_code == 404, r404.status_code)

if BG and SUBJ_BG:
    # An out-of-BG admin is refused (can_access short-circuits on the BG mismatch).
    with a.app.app_context():
        db = a.get_db()
        other_bg = db.execute(
            "SELECT DISTINCT business_group b FROM users "
            "WHERE COALESCE(business_group,'')!='' AND business_group!=? LIMIT 1",
            (SUBJ_BG,)).fetchone()
        db.execute("UPDATE users SET admin_bg=? WHERE id=?",
                   ((other_bg["b"] if other_bg else "ZZ-NO-SUCH-BG"), BG["id"]))
        db.commit()
    s.check("an out-of-BG admin is refused (403)",
            H.client_as(a, BG["id"]).get(URL).status_code == 403, None)
else:
    s.check("(no BG-scoped admin in the fixture -- out-of-BG check skipped)", True, None)

# ---------------------------------------------------------------------------
s.section("employee history -- self-scoped, read-only")
rh = H.client_as(a, SUBJ["id"]).get("/review/history")
s.check("the employee opens their own history (200) with their words",
        rh.status_code == 200 and MINE.encode() in rh.data, rh.status_code)
s.check("...self-scoped: it never shows another person's row", SECRET.encode() not in rh.data, None)
s.check("...read-only: no chat composer / write form on the page",
        b"rv-chat-form" not in rh.data and b"rv-chat-input" not in rh.data, None)

# OTHER (the second subject) sees only THEIR own row, never SUBJ's.
rh2 = H.client_as(a, OTHER["id"]).get("/review/history")
s.check("a different employee's history shows THEIR row, not the first subject's",
        rh2.status_code == 200 and SECRET.encode() in rh2.data and MINE.encode() not in rh2.data,
        rh2.status_code)

# review_history is classified 'review' so the module gate covers it (no unclassified route).
with a.app.app_context():
    s.check("review_history is classified under the 'review' module",
            a.MODULE_ENDPOINTS.get("review_history") == "review",
            a.MODULE_ENDPOINTS.get("review_history"))

sys.exit(s.done())
