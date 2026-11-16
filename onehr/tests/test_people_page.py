"""People: the person page with a 360 panel of No maximum, and the Users list's speed (Chris, 2026-10-23: "can you check
this error, and ... whenever im navigating the user list, it always lags").

What this suite holds:
  * with the panel size at No maximum (app_settings "none", production since 2026-10-23 15:46 MYT) a person's page
    opens: its "what they need" check compared the panel with None and 500'd; a panel short of the scoring minimum is
    said that way
  * users.hod_id has its index, and the Users page's role count reads it: without it the count scanned every user for
    each of ~3,600 people (1.1 s on every Users page, 0.004 s with it)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("People: the person page with No maximum, the Users list's speed")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
C = H.client_as(a, SU["id"])

with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    S0 = {r[0]: r[1] for r in db.execute("SELECT key, value FROM app_settings WHERE key='panel_size'")}
    C0 = db.execute("SELECT panel_size FROM cycles WHERE id=?", (CID,)).fetchone()[0]
    M0 = {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?", (CID,))}
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('panel_size', 'none')")
    db.execute("UPDATE cycles SET panel_size=NULL WHERE id=?", (CID,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key='tm'", (CID,))
    db.commit()
    MV = a.effective_min_valid(db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone())
    # someone rated in this cycle's 360 with fewer raters than the scoring minimum
    P = db.execute("SELECT u.id FROM users u WHERE u.role!='admin' AND " + a.participant_sql("u", "tm_rated")
                   + " AND (SELECT COUNT(*) FROM assignments x WHERE x.cycle_id=? AND x.subject_id=u.id AND x.archived=0)"
                   " < ? ORDER BY u.id LIMIT 1", (CID, MV)).fetchone()
    P = P[0] if P else None

try:
    s.section("the person page with a panel size of No maximum")
    with a.app.app_context():
        s.check("the panel size reads No maximum", a.effective_panel_size(
            a.get_db().execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()) is None)
    s.check("there is someone taking part whose panel is below the scoring minimum", P is not None)
    r = C.get("/admin/users/%d" % P)
    pg = r.get_data(as_text=True)
    s.check("their page opens (it was a 500)", r.status_code == 200, r.status_code)
    s.check("...and says the panel is below the number needed to score", "needed to score" in pg)
    s.check("...its side-panel tab opens too", C.get("/admin/users/%d?tab=overview&fragment=1" % P).status_code == 200)

    s.section("the Users list reads the HOD index")
    with a.app.app_context():   # the start-up migration makes it on a database without it
        db = a.get_db()
        db.execute("DROP INDEX IF EXISTS idx_users_hod")
        db.commit()
    a._ensure_runtime_schema()
    with a.app.app_context():
        db = a.get_db()
        idx = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='users'")}
        plan = " ".join(str(r[-1]) for r in db.execute(
            "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM users WHERE " + a._user_role_sql("hod")))
    s.check("users.hod_id has its index", "idx_users_hod" in idx, sorted(idx))
    s.check("...and the role count's HOD test uses it", "idx_users_hod" in plan, plan)
    s.check("the Users page opens", C.get("/admin/users").status_code == 200)
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM app_settings WHERE key='panel_size'")
        for k, v in S0.items():
            db.execute("INSERT INTO app_settings(key, value) VALUES (?,?)", (k, v))
        db.execute("UPDATE cycles SET panel_size=? WHERE id=?", (C0, CID))
        for k, v in M0.items():
            db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (v, CID, k))
        db.commit()

sys.exit(s.done())
