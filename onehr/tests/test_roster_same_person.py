"""The roster import's "May be the same person as another account" look-at item (Chris, 2026-10-29: "Yes, build it").

The import matches people by Employee ID alone, so a joiner under a new ID who is already in OneHR under an old one
(X0006 closed in June, FL900 live, same name, same joined date) became a second account. The Quality step now asks.

What this suite holds:
  * a NEW row whose normalised name (punctuation as a space, spaces collapsed, capitals ignored) is another account's
    under a different Employee ID is found; "very likely the same person" when the joined dates match
  * the account's state is named: active, left on a date, or would be marked as left by an authoritative file
  * several matches name the best (same joined date, then active) and say "and N more"
  * two new rows of one file sharing a name are found, both rows marked
  * an existing row (its ID is already in OneHR), a different name, an admin, a demo account and a retired ID (~)
    are never flagged / matched
  * it is a look-at item: Apply is not blocked; it shows on the real Quality page and is in the fingerprint

Synthetic (ZZSP-*) on the shared suite database; everything is put back at the end.
"""
import csv as _csv
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Roster import -- may be the same person as another account")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
C = H.client_as(a, SU["id"])
P = "/admin/import/roster"
COLS = {c.lower(): c for c in a.ROSTER_COLUMNS}

with a.app.app_context():
    db = a.get_db()
    UNIT = db.execute("SELECT business_group, company FROM org_units WHERE company!='' "
                      "ORDER BY business_group, company LIMIT 1").fetchone()
    assert UNIT, "no unit to test with"
    BG, CO = UNIT[0], UNIT[1]


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZSP%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL WHERE manager_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.commit()


def mk(db, eid, name, **kw):
    cols = dict(username=eid.lower(), full_name=name, password_hash="x", role="user", employee_id=eid,
                business_group=BG, company=CO, department="ZZSP Ops", job_grade=14, joined_date="2013-11-18")
    cols.update(kw)
    return db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                      list(cols.values())).lastrowid


def rec(eid, name, joined="2013-11-18", **kw):
    r = {"employee id": eid, "employee name": name, "business group": BG, "company": CO, "manager": "ZZSP-M1",
         "job grade": "14", "joined date": joined, "work email": eid.lower() + "@example.com"}
    r.update(kw)
    return r


def quality(records, authoritative=False):
    """(check, quality) of a list of records."""
    with a.app.test_request_context("/"):
        db = a.get_db()
        me = dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
        chk = a._roster_check(db, me, records, authoritative)
        return chk, a._roster_quality(db, me, chk)


def same(q):
    g = [x for x in q["look"] if x["key"] == "same_person"]
    return g[0]["found"] if g else []


try:
    with a.app.app_context():
        db = a.get_db()
        _cleanup(db)
        mk(db, "ZZSP-M1", "ZZ SP Manager One")
        mk(db, "ZZSP-A", "ZZ SP Twin Person", left_at="2026-06-22")                       # closed in June
        mk(db, "ZZSP-B", "ZZ SP Other Person", joined_date="2015-02-02")                  # active, other joined date
        mk(db, "ZZSP-C", "ZZ SP Third Person")                                            # active, same joined date
        mk(db, "ZZSP-AD", "ZZ SP Admin Twin", role="admin")
        mk(db, "ZZSP-DM", "ZZ SP Demo Twin", is_demo=1)
        mk(db, "ZZSP-R~retired-1", "ZZ SP Retired Twin")
        mk(db, "ZZSP-X1", "ZZ SP Many Twin", joined_date="2010-01-01")
        mk(db, "ZZSP-X2", "ZZ SP Many Twin", joined_date="2011-01-01")
        mk(db, "ZZSP-X3", "ZZ SP Many Twin", joined_date="2012-12-12", left_at="2025-01-01")
        db.commit()

    s.section("the X0006 pattern: a left account, a new ID, the same name and joined date")
    chk, q = quality([rec("ZZSP-N1", "ZZ SP Twin Person")])
    f = same(q)
    s.check("the row is built, not an error", not chk["errors"] and [r["eid"] for r in chk["valid"]] == ["ZZSP-N1"],
            chk["errors"])
    s.check("found, once, and says very likely", len(f) == 1 and "very likely the same person" in f[0]["detail"], f)
    s.check("...with the row, both IDs, the shared joined date and the day the old one left",
            f and f[0]["detail"] == "Row 2: ZZSP-N1 is new here; ZZSP-A in OneHR has the same name and joined date "
                                    "(left 22 Jun 2026): very likely the same person", f and f[0]["detail"])
    s.check("it is a look-at item: nothing to fix, one thing to look at, and the row is not clean",
            q["n_fix"] == 0 and q["n_look"] == 1 and q["clean"] == 0, (q["n_fix"], q["n_look"], q["clean"]))
    key = [g for g in q["look"] if g["key"] == "same_person"][0]
    s.check("...with its what and why from the list",
            key["what"] == "May be the same person as another account" and "splits their history" in key["why"])

    s.section("a different joined date is flagged without 'very likely'")
    chk, q = quality([rec("ZZSP-N1", "ZZ SP Twin Person", joined="2020-03-04")])
    f = same(q)
    s.check("flagged, no 'very likely', no 'joined date' claim",
            len(f) == 1 and "very likely" not in f[0]["detail"] and "and joined date" not in f[0]["detail"]
            and f[0]["detail"] == "Row 2: ZZSP-N1 is new here; ZZSP-A in OneHR has the same name (left 22 Jun 2026)",
            f and f[0]["detail"])
    chk, q = quality([rec("ZZSP-N1", "ZZ SP Twin Person", joined="")])
    s.check("a blank joined date is not a match on the date", len(same(q)) == 1 and "very likely" not in same(q)[0]["detail"])
    s.check("an active account is named active",
            "(active)" in same(quality([rec("ZZSP-N2", "ZZ SP Other Person", joined="2015-02-02")])[1])[0]["detail"])

    s.section("an authoritative file that drops the old account")
    chk, q = quality([rec("ZZSP-N1", "ZZ SP Twin Person"), rec("ZZSP-N3", "ZZ SP Third Person")], authoritative=True)
    f = {x["eid"]: x["detail"] for x in same(q)}
    s.check("the old account is in the would-leave list", "ZZSP-C" in {w["employee_id"] for w in chk["would_leave"]})
    s.check("...so the active account says it would be marked as left; the left one still says the day it left",
            "(would be marked as left)" in f.get("ZZSP-N3", "") and "(left 22 Jun 2026)" in f.get("ZZSP-N1", ""), f)
    chk, q = quality([rec("ZZSP-N3", "ZZ SP Third Person")], authoritative=False)
    s.check("falsify: not an authoritative file, the same account is just active",
            "(active)" in same(q)[0]["detail"] and "would be marked" not in same(q)[0]["detail"])

    s.section("names are compared as the name_diff check does")
    for label, nm in (("a different name", "ZZ SP Nobody Else"),):
        s.check(label + " is not flagged", not same(quality([rec("ZZSP-N4", nm)])[1]))
    for label, nm in (("capitals", "zz sp TWIN person"), ("extra spaces", "  ZZ  SP   Twin  Person "),
                      ("punctuation", "ZZ, SP. Twin-Person")):
        s.check(label + " still flagged", len(same(quality([rec("ZZSP-N4", nm)])[1])) == 1, nm)
    s.check("a name that only shares a first word is not flagged", not same(quality([rec("ZZSP-N4", "ZZ SP Twin")])[1]))

    s.section("an existing row is not flagged")
    chk, q = quality([rec("ZZSP-C", "ZZ SP Twin Person")])   # ZZSP-C is in OneHR; the name here is ZZSP-A's
    s.check("the row is an existing person, and this check says nothing (name_diff covers a renamed ID)",
            chk["valid"] and chk["valid"][0]["_existing"] and not same(q), same(q))
    chk, q = quality([rec("ZZSP-A", "ZZ SP Twin Person")])
    s.check("a row for the old account itself does not match itself", not same(q))

    s.section("two new rows in one file with the same name")
    chk, q = quality([rec("ZZSP-N5", "ZZ SP File Twin"), rec("ZZSP-N6", "ZZ SP  FILE twin")])
    f = same(q)
    s.check("flagged once, on the second row, naming the first by its row",
            len(f) == 1 and f[0]["row"] == 3 and "ZZSP-N5 in row 2 of this file" in f[0]["detail"]
            and "very likely the same person" in f[0]["detail"], f)
    s.check("...and both rows are marked, so neither counts clean", sorted(f[0]["rows"]) == [2, 3] and q["clean"] == 0,
            (f and f[0]["rows"], q["clean"]))
    chk, q = quality([rec("ZZSP-N5", "ZZ SP File Twin"), rec("ZZSP-N6", "ZZ SP File Twin", joined="2001-01-01")])
    s.check("a different joined date: still flagged, without 'very likely'",
            len(same(q)) == 1 and "very likely" not in same(q)[0]["detail"])
    chk, q = quality([rec("ZZSP-N5", "ZZ SP File Twin"), rec("ZZSP-N6", "ZZ SP File Different")])
    s.check("falsify: two different names in one file are not flagged", not same(q))

    s.section("admin, demo and retired accounts are never matched")
    for nm in ("ZZ SP Admin Twin", "ZZ SP Demo Twin", "ZZ SP Retired Twin"):
        s.check("%s: not matched" % nm.split()[2], not same(quality([rec("ZZSP-N7", nm)])[1]), nm)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET role='user' WHERE employee_id='ZZSP-AD'")
        db.execute("UPDATE users SET is_demo=0 WHERE employee_id='ZZSP-DM'")
        db.execute("UPDATE users SET employee_id='ZZSP-R9', username='zzsp-r9' WHERE employee_id='ZZSP-R~retired-1'")
        db.commit()
    s.check("...once an ordinary user, not demo, and without the ~, each is matched",
            all(len(same(quality([rec("ZZSP-N7", nm)])[1])) == 1
                for nm in ("ZZ SP Admin Twin", "ZZ SP Demo Twin", "ZZ SP Retired Twin")))
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET role='admin' WHERE employee_id='ZZSP-AD'")
        db.execute("UPDATE users SET is_demo=1 WHERE employee_id='ZZSP-DM'")
        db.execute("UPDATE users SET employee_id='ZZSP-R~retired-1', username='zzsp-r~1' WHERE employee_id='ZZSP-R9'")
        db.commit()

    s.section("several matches: the best is named, and how many more")
    chk, q = quality([rec("ZZSP-N8", "ZZ SP Many Twin", joined="2012-12-12")])
    d = same(q)[0]["detail"]
    s.check("same joined date first, though that account has left; the other two counted",
            "ZZSP-X3 in OneHR has the same name and joined date (left 1 Jan 2025)" in d and d.endswith("; and 2 more with the same name"), d)
    chk, q = quality([rec("ZZSP-N8", "ZZ SP Many Twin", joined="2030-01-01")])
    d = same(q)[0]["detail"]
    s.check("no date match: an active account before the one that left (the lowest ID of the active)",
            "ZZSP-X1 in OneHR has the same name (active)" in d and "and 2 more" in d, d)

    s.section("on the real Quality page, and Apply is not blocked")
    buf = io.StringIO()
    w = _csv.writer(buf)
    w.writerow(a.ROSTER_COLUMNS)
    r = dict.fromkeys(a.ROSTER_COLUMNS, "")
    for k, v in rec("ZZSP-N1", "ZZ SP Twin Person").items():
        r[COLS[k]] = v
    w.writerow([r[c] for c in a.ROSTER_COLUMNS])
    resp = C.post(P, data={"csrf_token": "tok", "mode": "upsert", "preview": "1",
                           "file": (io.BytesIO(buf.getvalue().encode()), "sp.csv")}, content_type="multipart/form-data")
    tok = resp.headers.get("Location", "").split("check=")[-1]
    pg = C.get(P + "?check=" + tok).get_data(as_text=True)
    s.check("the page lists it with its why and the detail",
            "May be the same person as another account" in pg and "splits their history and reviews" in pg
            and "ZZSP-A in OneHR has the same name and joined date" in pg, "Quality page")
    s.check("...as one thing to look at, nothing to fix, with the tick to go on",
            "1 thing worth a look" in pg and 'name="ack" value="1" required' in pg and "Fix " not in pg.split("worth a look")[0][-200:])
    C.post(P, data={"csrf_token": "tok", "token": tok, "action": "quality_ok", "ack": "1"})
    C.post(P, data={"csrf_token": "tok", "token": tok, "action": "to_apply"})
    C.post(P, data={"csrf_token": "tok", "token": tok, "action": "apply"})
    s.check("with the tick, the file still applies: the new account is made (it only asks)",
            H.one(a, "SELECT COUNT(*) FROM users WHERE employee_id='ZZSP-N1'") == 1)
    # the finding is in the fingerprint: the same file against a OneHR without the old account gives another one
    _, q1 = quality([rec("ZZSP-N9", "ZZ SP Third Person")])
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET full_name='ZZ SP Third Renamed' WHERE employee_id='ZZSP-C'")
        db.commit()
    _, q2 = quality([rec("ZZSP-N9", "ZZ SP Third Person")])
    s.check("the finding is part of the fingerprint: when it goes away the fingerprint changes",
            len(same(q1)) == 1 and not same(q2) and q1["fingerprint"] != q2["fingerprint"])
finally:
    with a.app.app_context():
        db = a.get_db()
        _cleanup(db)

sys.exit(s.done())
