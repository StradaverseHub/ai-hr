"""Release results reads each tier's locked bands once for the page (Chris, 2026-10-23: "check our other pages too, both
user and admin pages, to ensure we have optimal and fast loading speed"). On production's copy the page made 21,866
database reads for 1,810 people (0.61 s warm): effective_band asked for each person's band at every calibration tier
one person at a time, and every setting again for each person.

What this suite holds:
  * with the page's opt-in memo (_band_memo) every row comes out exactly as without it: the same people, the same
    bands, finals, stages and release dates
  * it reads the database fewer times
  * the memo is the page's alone: it is gone when the rows are built, and a request that didn't opt in reads as before
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Release results: each tier's locked bands read once for the page")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
C = H.client_as(a, SU["id"])


class Count:
    """The request's db, counting its reads."""
    def __init__(self, c):
        self.c, self.n = c, 0

    def execute(self, *x):
        self.n += 1
        return self.c.execute(*x)

    def __getattr__(self, k):
        return getattr(self.c, k)


def build(memo):
    with a.app.test_request_context("/admin/talent-release"):
        a.app.preprocess_request()
        from flask import session
        session["user_id"] = SU["id"]
        db = Count(a.get_db())
        period, cyc = a.talent_period_cycle(db, None)
        pop = db.execute("SELECT * FROM users WHERE %s ORDER BY full_name" % a.calibration_population_sql()).fetchall()
        orig = a.get_db
        a.get_db = lambda: db
        try:
            if memo:
                a._req_cache()["_band_memo"] = {}
            n0 = db.n
            rows = a._result_release_rows(db, period, cyc, pop)
            used = db.n - n0
        finally:
            a.get_db = orig
        out = [{k: (v if k != "u" else v["id"]) for k, v in r.items()} for r in rows]
        return json.dumps(out, sort_keys=True, default=str), used, len(pop)


plain, n_plain, people = build(False)
memo, n_memo, _p = build(True)
s.section("the same rows, fewer reads")
s.check("there are people to release (%d)" % people, people > 0 and plain != "[]")
s.check("every row is exactly the same with the memo", memo == plain)
s.check("...in fewer reads (%d -> %d)" % (n_plain, n_memo), n_memo < n_plain, (n_plain, n_memo))
s.section("where calibrations are locked, the same band from every tier")
with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    CID = a.active_cycle_id(db)
    PREV = dict(db.execute("SELECT kind, year, half, no_potential FROM cycles WHERE id=?", (CID,)).fetchone())
    db.execute("UPDATE cycles SET kind='year_end', half=2, no_potential=0 WHERE id=?", (CID,))
    ppl = [dict(r) for r in db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND "
                                       "COALESCE(business_group,'')!='' ORDER BY id LIMIT 300")]
    X, Y = ppl[0], ppl[1]
    SESS, KEPT = [], []
    for tier, key, bg, who, band in (("bgceo", X["business_group"], X["business_group"], X, "High"),
                                     ("super", a.POT_SUPER_SCOPE_KEY, Y["business_group"], Y, "Low")):
        old = db.execute("SELECT * FROM calibration_sessions WHERE cycle_id=? AND tier=? AND scope_key=?",
                         (CID, tier, key)).fetchone()
        if old:   # kept to put back, with its moves
            KEPT.append((dict(old), [dict(r) for r in db.execute("SELECT * FROM calibration_adjustments WHERE "
                                                                 "session_id=?", (old["id"],))]))
            db.execute("DELETE FROM calibration_sessions WHERE id=?", (old["id"],))
        sid = db.execute("INSERT INTO calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, "
                         "locked_at, locked_by) VALUES (?,?,?,?, 'ZZRS', datetime('now'), ?)",
                         (CID, tier, key, bg, SU["id"])).lastrowid
        SESS.append(sid)
        db.execute("INSERT INTO calibration_adjustments(session_id, subject_id, original_band, adjusted_band, "
                   "adjusted_by) VALUES (?,?, 'Mid', ?, ?)", (sid, who["id"], band, SU["id"]))
    db.commit()
try:
    def bands(memo):
        with a.app.test_request_context("/admin/talent-release"):
            from flask import session
            session["user_id"] = SU["id"]
            db = a.get_db()
            if memo:
                a._req_cache()["_band_memo"] = {}
            return {p["id"]: a.effective_band(db, p, CID) for p in ppl}
    b0, b1 = bands(False), bands(True)
    s.check("300 people's potential band, tier by tier: the same with the memo as without", b0 == b1)
    s.check("...a BG CEO's locked move reads through it (High)", b1[X["id"]]["band"] == "High"
            and b1[X["id"]]["source"] == "bgceo", b1[X["id"]])
    s.check("...and the super admin's final band (Low)", b1[Y["id"]]["band"] == "Low" and b1[Y["id"]]["source"] == "super",
            b1[Y["id"]])
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        for sid in SESS:
            db.execute("DELETE FROM calibration_sessions WHERE id=?", (sid,))
        for sess, adjs in KEPT:
            db.execute("INSERT INTO calibration_sessions(%s) VALUES (%s)" % (", ".join(sess), ",".join("?" * len(sess))),
                       list(sess.values()))
            for adj in adjs:
                db.execute("INSERT INTO calibration_adjustments(%s) VALUES (%s)" % (", ".join(adj), ",".join(
                    "?" * len(adj))), list(adj.values()))
        db.execute("UPDATE cycles SET kind=?, year=?, half=?, no_potential=? WHERE id=?",
                   (PREV["kind"], PREV["year"], PREV["half"], PREV["no_potential"], CID))
        db.commit()

s.section("the page")
r = C.get("/admin/talent-release")
s.check("Release results opens", r.status_code == 200)
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app.py"), encoding="utf-8").read()
s.check("the memo is set only around the page's rows and taken away after", src.count('_req_cache()["_band_memo"] = {}')
        == 1 and '_req_cache().pop("_band_memo", None)' in src)

sys.exit(s.done())
