"""Fixes from the developer-handoff code review (Chris, 2026-10-12: "go ahead with 1 to 5").

  * a person marked as left loses the session they already had open, on their next click (not only at login)
  * every CSV download neutralises a text cell that could run as a formula in Excel; signed numbers stay numbers
  * an admin reading someone's review conversation leaves a row in the audit log
  (the manager chat's permanent actions are in test_manager_agent.py, where its chat is driven end to end)

Runs on the scratch copy only (harness.setup asserts it). Every write it makes is put back.
"""
import csv
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Handoff review fixes -- leavers' sessions, CSV cells, transcript reads")
SU, _BG, _EMP = H.actors(a)

# ---------------------------------------------------------------------------
s.section("a person marked as left loses the session they already had open")
with a.app.app_context():
    db = a.get_db()
    who = db.execute("SELECT id FROM users WHERE role='user' AND left_at IS NULL AND COALESCE(is_demo,0)=0 "
                     "AND employee_id IS NOT NULL ORDER BY id LIMIT 2").fetchall()
LEAVER, STAYER = who[0]["id"], who[1]["id"]
E, K = H.client_as(a, LEAVER), H.client_as(a, STAYER)
s.check("before: their session opens the dashboard", E.get("/dashboard").status_code == 200)
with a.app.app_context():
    db = a.get_db()
    db.execute("UPDATE users SET left_at=datetime('now') WHERE id=?", (LEAVER,))
    db.commit()
try:
    r = E.get("/dashboard")
    s.check("after they're marked as left, the same session's next click goes to the sign-in page",
            r.status_code == 302 and "/login" in (r.headers.get("Location") or ""), (r.status_code, r.headers.get("Location")))
    with E.session_transaction() as sess:
        s.check("...and the session is cleared, not merely refused", "user_id" not in sess, dict(sess))
    page = E.get("/login").get_data(as_text=True)
    s.check("...with the login page's own sentence", "no longer active" in page)
    r2 = E.get("/dashboard")
    s.check("...and it stays out (no way back in on the old cookie)", r2.status_code == 302)
    s.check("someone who hasn't left is untouched", K.get("/dashboard").status_code == 200)
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET left_at=NULL WHERE id=?", (LEAVER,))
        db.commit()

# ---------------------------------------------------------------------------
s.section("CSV downloads: a text cell can't run as a formula; a signed number stays a number")
cell = a._csv_cell
s.check("text starting = + - @ gets the apostrophe",
        [cell(v) for v in ("=1+1", "+cmd", "-2+3", "@SUM(A1)", "\tx")] == ["'=1+1", "'+cmd", "'-2+3", "'@SUM(A1)", "'\tx"])
s.check("...a signed number, a percentage, a plain word or a real number is left alone",
        [cell(v) for v in ("-0.25", "+3", "-12%", "Aina", 5, -1.5, None, "")] == ["-0.25", "+3", "-12%", "Aina", 5, -1.5, None, ""])
s.check("...and a cell already guarded isn't guarded twice", cell(cell("=x")) == "'=x")
with a.app.app_context():
    db = a.get_db()
    _dept = db.execute("SELECT department FROM users WHERE id=?", (STAYER,)).fetchone()["department"]
    db.execute("UPDATE users SET department='=HYPERLINK(\"http://example.com\",\"x\")' WHERE id=?", (STAYER,))
    db.commit()
try:
    A = H.client_as(a, SU["id"])
    r = A.get("/admin/export/users.csv?show=all")
    rows = list(csv.reader(io.StringIO(H.as_csv_text(r))))
    hit = [row for row in rows if any("HYPERLINK" in c for c in row)]
    s.check("the people export writes a typed formula as text, never a live one",
            r.status_code == 200 and hit and all(c.startswith("'") for row in hit for c in row if "HYPERLINK" in c),
            (r.status_code, [c for row in hit for c in row if "HYPERLINK" in c][:1]))
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET department=? WHERE id=?", (_dept, STAYER))
        db.commit()
s.check("every table download goes out as Excel through the one guarded writer (2026-10-19: no csv.writer or text/csv "
        "left in app.py; _xlsx_response guards each cell)",
        H.source(a).count("csv.writer(") == 0 and 'mimetype="text/csv"' not in H.source(a)
        and "ws.append([_rr_cell(v) for v in r])" in H.source(a))

# ---------------------------------------------------------------------------
s.section("an admin reading someone's review conversation is in the audit log")
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    _chat = db.execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content) VALUES (?,?,'user',?)",
                       (STAYER, CID, "ZZ handoff test line")).lastrowid
    _before = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
    db.commit()
try:
    A = H.client_as(a, SU["id"])
    r = A.get("/admin/users/%d/conversation" % STAYER)   # the super admin's only since 2026-10-20
    with a.app.app_context():
        logs = a.get_db().execute("SELECT * FROM activity_log WHERE id>? AND action='view_transcript'",
                                  (_before,)).fetchall()
    s.check("opening the transcript works as before", r.status_code == 200 and "ZZ handoff test line" in r.get_data(as_text=True))
    s.check("...and writes one audit row: who read whose conversation",
            len(logs) == 1 and logs[0]["user_id"] == SU["id"] and logs[0]["target_user_id"] == STAYER
            and "review conversation" in (logs[0]["detail"] or ""),
            [(x["user_id"], x["target_user_id"], x["action"]) for x in logs])
    s.check("...in plain words on the audit log (a label, not the code)",
            a.ACTION_LABELS.get("view_transcript") == "Read a review conversation")
    s.check("...and it isn't hidden as self-service", "view_transcript" not in a.SELF_SERVICE_ACTIONS)
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM pm_review_chat WHERE id=?", (_chat,))
        db.execute("DELETE FROM activity_log WHERE id>? AND action='view_transcript'", (_before,))
        db.commit()

sys.exit(s.done())
