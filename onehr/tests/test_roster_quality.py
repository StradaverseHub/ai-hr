"""The roster import's quality step (Chris, 2026-10-13: "For the roster import, have a prestep for admin to check the
quality of the import and flag any issue"; the "OneHR Admin Round 4" canvas, D5). 1 File -> 2 Quality -> 3 Changes ->
4 Apply.

What this suite holds:
  * rows that can't be imported are grouped by what is wrong, with their rows; the page says to fix them and Continue
    stays off
  * things that won't stop the import but are probably a mistake are each found: a line manager or HOD not in OneHR or
    the file, a line manager who has left, their own line manager, a reporting loop, a department spelled two ways in one unit, no
    work email, an email someone else has, a grade or a date OneHR can't read, a date in the future, a name unlike
    OneHR's for the same ID, a seat taken away leaving its unit with nobody, a full roster that marks many as left
  * an HOD the file changes someone to goes through the Leaders page's checks (Chris, 2026-10-21): one who has left
    can't be imported
  * Continue needs a tick when there are things to look at; Apply is refused until the quality step was seen, and again
    if OneHR changed since (the findings no longer the ones looked at)
  * every issue downloads, and one kind of issue on its own; a clean file says so and goes on with no tick

Synthetic (ZZRQ-*) on the shared suite database; everything is put back at the end.
"""
import csv as _csv
import hashlib
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Roster import -- the quality step before the changes")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
C = H.client_as(a, SU["id"])
P = "/admin/import/roster"
COLS = {c.lower(): c for c in a.ROSTER_COLUMNS}
ids = {}

with a.app.app_context():
    db = a.get_db()
    # a unit of a real business group with nobody as its BU CEO, for the seat check
    UNIT = db.execute("SELECT o.business_group, o.company FROM org_units o LEFT JOIN buceo_seats b ON "
                      "b.business_group=o.business_group AND b.company=o.company WHERE b.user_id IS NULL AND "
                      "o.company!='' ORDER BY o.business_group, o.company LIMIT 1").fetchone()
    assert UNIT, "no unit without a BU CEO to test with"
    BG, CO = UNIT[0], UNIT[1]


def _cleanup(db):
    db.execute("DELETE FROM org_units WHERE business_group='ZZRQ Group'")
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZRQ-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM buceo_seats WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL WHERE manager_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET hod_id=NULL WHERE hod_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.commit()


def row(**kw):
    r = dict.fromkeys(a.ROSTER_COLUMNS, "")
    r.update({COLS["business group"]: BG, COLS["company"]: CO})
    for k, v in kw.items():
        r[COLS[k.replace("_", " ")]] = v
    return [r[c] for c in a.ROSTER_COLUMNS]


def upload(rows, mode="upsert", client=None):
    buf = io.StringIO()
    w = _csv.writer(buf)
    w.writerow(a.ROSTER_COLUMNS)
    w.writerows(rows)
    r_ = (client or C).post(P, data={"csrf_token": "tok", "mode": mode, "preview": "1",
                                     "file": (io.BytesIO(buf.getvalue().encode()), "rq.csv")},
                            content_type="multipart/form-data")
    return r_.headers.get("Location", "").split("check=")[-1]


def page(tok, step=""):
    return C.get(P + "?check=%s%s" % (tok, "&step=" + step if step else "")).get_data(as_text=True)


def quality(tok, authoritative=False):
    with a.app.test_request_context("/"):
        db = a.get_db()
        me = dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
        fn, data, auth = a._roster_staged(me, tok)
        chk = a._roster_check(db, me, a._read_records(fn, data), authoritative or auth)
        return a._roster_quality(db, me, chk)


def apply_(tok, client=None):
    """Steps 3 -> 4 -> Apply (the fourth step, 2026-10-26)."""
    (client or C).post(P, data={"csrf_token": "tok", "token": tok, "action": "to_apply"})
    return (client or C).post(P, data={"csrf_token": "tok", "token": tok, "action": "apply"})


def answer(tok, picks, action="to_apply"):
    """Post the super admin's answers ({item key: value}) at step 3."""
    data = {"csrf_token": "tok", "token": tok, "action": action}
    for k, v in picks.items():
        data["d_" + hashlib.sha1(k.encode()).hexdigest()[:10]] = v
    return C.post(P, data=data)


def made(eid):
    return H.one(a, "SELECT COUNT(*) FROM users WHERE employee_id=?", (eid,)) == 1


new = {"hod": "ZZRQ-M1", "job grade": "14", "joined date": "2025-01-06", "work email": ""}
try:
    with a.app.app_context():
        db = a.get_db()
        _cleanup(db)

        def mk(eid, name, **kw):
            cols = dict(username=eid.lower(), full_name=name, password_hash="x", role="user", employee_id=eid,
                        business_group=BG, company=CO, department=kw.pop("department", "ZZRQ Ops"), job_grade=14)
            cols.update(kw)
            return db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                              list(cols.values())).lastrowid
        ids["m1"] = mk("ZZRQ-M1", "ZZ RQ Manager One", email="rq-m1@example.com")
        ids["m2"] = mk("ZZRQ-M2", "ZZ RQ Manager Gone", email="rq-m2@example.com", left_at="2026-08-01")
        ids["ex"] = mk("ZZRQ-EX", "ZZ RQ Existing Person", email="rq-ex@example.com", manager_id=ids["m1"])
        ids["sh"] = mk("ZZRQ-SH", "ZZ RQ Shared Inbox", email="rq-shared@example.com")
        ids["fin"] = mk("ZZRQ-FN", "ZZ RQ Finance", email="rq-fn@example.com", department="ZZRQ Finance")
        db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, ids["ex"]))
        a._sync_buceo_primary(db, ids["ex"])
        db.commit()

    s.section("what can't be imported, grouped by what is wrong")
    rows_all = [
        row(employee_id="ZZRQ-N1", employee_name="ZZ RQ New One", manager="ZZRQ-NOPE", **new),
        row(employee_id="ZZRQ-N2", employee_name="ZZ RQ New Two", manager="ZZRQ-M2",
            **dict(new, work_email="RQ-SHARED@example.com")),
        row(employee_id="ZZRQ-N3", employee_name="ZZ RQ New Three", manager="ZZRQ-N3",
            **dict(new, work_email="rq-n3@example.com")),
        row(employee_id="ZZRQ-N4", employee_name="ZZ RQ New Four", manager="ZZRQ-N5",
            **dict(new, work_email="rq-n4@example.com")),
        row(employee_id="ZZRQ-N5", employee_name="ZZ RQ New Five", manager="ZZRQ-N4",
            **dict(new, work_email="rq-n5@example.com")),
        row(employee_id="ZZRQ-N6", employee_name="ZZ RQ New Six", manager="ZZRQ-M1", department="zzrq  finance",
            **dict(new, work_email="rq-n6@example.com")),
        row(employee_id="ZZRQ-N7", employee_name="ZZ RQ New Seven", manager="ZZRQ-M1",
            **dict(new, job_grade="G1O", joined_date="2031-02-01", confirmation_date="sometime",
                   work_email="rq-n7@example.com")),
        row(employee_id="ZZRQ-EX", employee_name="Quite Another Name Entirely", bu_ceo_of="NONE"),
        row(employee_id="ZZRQ-N8", employee_name="ZZ RQ Clean", manager="ZZRQ-M1",
            **dict(new, work_email="rq-n8@example.com")),
        row(employee_id="ZZRQ-N9", employee_name="ZZ RQ Clean Finance", manager="ZZRQ-M1", department="ZZRQ Finance",
            **dict(new, work_email="rq-n9@example.com")),
    ]
    errs = [row(employee_id="ZZRQ-E1", employee_name="ZZ RQ No Line Manager",
                **dict(new, work_email="rq-e1@example.com")),
            row(employee_id="ZZRQ-E2", employee_name="ZZ RQ No Line Manager Two",
                **dict(new, work_email="rq-e2@example.com")),
            row(employee_id="ZZRQ-E3", employee_name="ZZ RQ Bad Unit", company="ZZRQ No Such Unit", manager="ZZRQ-M1",
                **dict(new, work_email="rq-e3@example.com"))]
    tok = upload(rows_all + errs)
    q = quality(tok)
    kinds = {f["kind"]: f for f in q["fix"]}
    s.check("rows that can't be imported come in groups, each with its rows",
            q["n_fix"] == 3 and len(q["fix"]) == 2
            and any(f["n"] == 2 and f["rows"] == [len(rows_all) + 2, len(rows_all) + 3] and "line manager" in k
                    for k, f in kinds.items())
            and any("'ZZRQ No Such Unit' isn't a unit in Org structure" in k for k in kinds), q["fix"])
    pg = page(tok)
    s.check("the page says how many rows to fix first, and Continue stays off",
            "Fix 3 rows before you can go on." in pg and 'class="primary" disabled>Continue to the changes' in pg
            and "Apply this file" not in pg)
    s.check("nothing has changed: no new joiner yet", not made("ZZRQ-N1") and not made("ZZRQ-N8"))
    C.post(P, data={"csrf_token": "tok", "token": tok, "action": "quality_ok", "ack": "1"})
    s.check("Continue is refused while a row fails", "Apply this file" not in page(tok, "changes")
            and "Continue to the changes" in page(tok, "changes"))

    s.section("things worth a look, each found")
    tok = upload(rows_all)
    q = quality(tok)
    look = {g["key"]: g for g in q["look"]}
    want = {"mgr_missing", "mgr_left", "mgr_self", "mgr_loop", "dept_like", "no_email", "email_shared", "grade",
            "date_bad", "date_future", "name_diff", "seat_vacant"}
    s.check("every kind the file carries is found", want <= set(look), sorted(set(want) - set(look)))
    s.check("...the manager not found names the ID", "ZZRQ-NOPE" in look["mgr_missing"]["found"][0]["detail"])
    s.check("...the one who left, and the email someone else has (any capitals)",
            "has left" in look["mgr_left"]["found"][0]["detail"]
            and "ZZ RQ Shared Inbox" in look["email_shared"]["found"][0]["detail"])
    s.check("...the loop names both, once", look["mgr_loop"]["n"] == 1
            and "ZZ RQ New Four" in look["mgr_loop"]["found"][0]["detail"]
            and "ZZ RQ New Five" in look["mgr_loop"]["found"][0]["detail"])
    s.check("...the department spelled two ways in one unit: only the row with the odd spelling",
            look["dept_like"]["n"] == 1 and "'zzrq  finance' beside 'ZZRQ Finance'"
            in look["dept_like"]["found"][0]["detail"], look["dept_like"])
    s.check("...the grade, the date it can't read, the date after today",
            "'G1O'" in look["grade"]["found"][0]["detail"] and "'sometime'" in look["date_bad"]["found"][0]["detail"]
            and "after today" in look["date_future"]["found"][0]["detail"])
    s.check("...the name unlike OneHR's, and the unit left with no BU CEO",
            "ZZ RQ Existing Person" in look["name_diff"]["found"][0]["detail"]
            and "no BU CEO" in look["seat_vacant"]["found"][0]["detail"])
    s.check("a clean row is counted clean (one using the department's usual spelling too); the rest are not",
            q["clean"] == 2 and q["rows"] == len(rows_all) and q["n_fix"] == 0, (q["clean"], q["rows"]))
    with a.app.test_request_context("/"):
        db = a.get_db()
        # an authoritative file closes only the groups it names (2026-10-19): give this group a dozen people it leaves out
        for i_ in range(12):
            db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                       "company) VALUES (?,?, 'x', 'user', ?, ?, ?)", ("zzrq-l%02d" % i_, "ZZ RQ Left %d" % i_,
                                                                       "ZZRQ-L%02d" % i_, BG, CO))
        db.commit()
        me = dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
        chk = a._roster_check(db, me, [{"employee id": "ZZRQ-N8", "employee name": "ZZ RQ Clean", "business group": BG,
                                        "company": CO}], True)
        qa = a._roster_quality(db, me, chk)
    s.check("a full roster that leaves out most of the people says so",
            any(g["key"] == "many_leave" for g in qa["look"]), (len(chk["valid"]), len(chk["would_leave"]),
                                                               [g["key"] for g in qa["look"]], chk["errors"][:2]))
    # a joiner with no HOD comes in (the BG admin assigns HODs; Chris, 2026-10-16); one with no line manager doesn't
    with a.app.test_request_context("/"):
        db = a.get_db()
        me = dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
        base_ = {"employee name": "ZZ RQ Joiner", "business group": BG, "company": CO,
                 "job grade": "14"}
        c_nohod = a._roster_check(db, me, [dict(base_, **{"employee id": "ZZRQ-J1", "manager": "ZZRQ-M1"})], False)
        c_nolm = a._roster_check(db, me, [dict(base_, **{"employee id": "ZZRQ-J2", "hod": "ZZRQ-M1"})], False)
        c_hodl = a._roster_check(db, me, [dict(base_, **{"employee id": "ZZRQ-J3", "manager": "ZZRQ-M1",
                                                         "hod": "ZZRQ-M2"})], False)
    s.check("a new joiner with no HOD passes the check (the BG admin assigns one later)",
            not c_nohod["errors"] and [r["eid"] for r in c_nohod["valid"]] == ["ZZRQ-J1"]
            and c_nohod["valid"][0]["hod"] is None, c_nohod["errors"])
    s.check("an HOD who has left can't be imported: the Leaders page's checks (2026-10-21)",
            any("HOD:" in e["why"] and "has left" in e["why"] for e in c_hodl["errors"]), c_hodl["errors"])
    s.check("...but a new joiner with no line manager is still refused",
            [e["why"] for e in c_nolm["errors"]] == ["New joiner with no line manager (Employee ID) in the file"],
            c_nolm["errors"])
    pg = page(tok)
    s.check("the page lists what, why it matters and an example, with a tick to go on",
            "worth a look" in pg and "Reporting loop" in pg and "Each is the other" in pg
            and 'name="ack" value="1" required' in pg and 'class="primary" >Continue to the changes' in pg)

    s.section("Continue, then Apply on the same findings")
    C.post(P, data={"csrf_token": "tok", "token": tok, "action": "quality_ok"})
    s.check("Continue without the tick is refused", "Apply this file" not in page(tok, "changes"))
    apply_(tok)
    s.check("Apply before the quality step was seen is refused, nothing changed", not made("ZZRQ-N1"))
    C.post(P, data={"csrf_token": "tok", "token": tok, "action": "quality_ok", "ack": "1"})
    pg = page(tok, "changes")
    s.check("with the tick, the changes page opens, with the way on to the final preview and the way back",
            "Continue to the final preview" in pg and "Back to the quality check" in pg and "to add" in pg
            and "Apply this file" not in pg)
    C.post(P, data={"csrf_token": "tok", "token": tok, "action": "to_apply"})
    pg = page(tok, "apply")
    s.check("...then the final preview: each person, and Apply in OneHR's own box",
            "The people records after you apply this file" in pg and "ZZ RQ New One" in pg and "Added" in pg
            and 'data-confirm-ok="Apply this file"' in pg and not made("ZZRQ-N1"))
    with a.app.app_context():
        db = a.get_db()
        # someone in OneHR takes a new joiner's email meanwhile (it was their HOD leaving; an HOD who has left is now
        # refused outright, 2026-10-21, so the change that asks for a second look is one that's still worth a look)
        db.execute("UPDATE users SET email='rq-n8@example.com' WHERE id=?", (ids["fin"],))
        db.commit()
    C.post(P, data={"csrf_token": "tok", "token": tok, "action": "apply"})
    s.check("if OneHR changed since (someone took a joiner's email), Apply is refused: look again", not made("ZZRQ-N1"))
    s.check("...and the quality step now shows it", any(
        g["key"] == "email_shared" and any("ZZ RQ Finance" in f["detail"] for f in g["found"])
        for g in quality(tok)["look"]))
    C.post(P, data={"csrf_token": "tok", "token": tok, "action": "quality_ok", "ack": "1"})
    r = apply_(tok)
    s.check("looked at again, Apply applies that same file", made("ZZRQ-N1") and made("ZZRQ-N8"))
    done = C.get(r.headers.get("Location", "")).get_data(as_text=True)
    s.check("...and says it applied, with the backup taken first", "Applied rq.csv" in done
            and "backed up just before it applied" in done and "4 · Apply" in done, r.headers.get("Location"))
    bk = [f for f in os.listdir(a._imp_backup_dir()) if "-import-roster.db" in f]
    s.check("...a copy of the database was taken just before", bool(bk), bk)

    s.section("the downloads, and a clean file")
    tok = upload(rows_all + errs)
    csvb = H.as_csv_text(C.get(P + "/check/%s.csv?what=issues" % tok))
    s.check("every issue downloads: what can't be imported and what's worth a look, each with its row",
            "Can't be imported" in csvb and "Worth a look" in csvb and "Reporting loop" in csvb
            and "ZZRQ-E1" in csvb)
    csvb = H.as_csv_text(C.get(P + "/check/%s.csv?what=issues&kind=grade" % tok))
    s.check("...and one kind on its own", "G1O" in csvb and "Reporting loop" not in csvb and "ZZRQ-E1" not in csvb)
    tok = upload([row(employee_id="ZZRQ-SH", employee_name="ZZ RQ Shared Inbox", job_title="ZZ RQ Title")])
    pg = page(tok)
    s.check("a clean file says so, and goes on with no tick",
            "Every row is clean." in pg and 'name="ack"' not in pg)
    C.post(P, data={"csrf_token": "tok", "token": tok, "action": "quality_ok"})
    apply_(tok)
    s.check("...and applies", H.one(a, "SELECT job_title FROM users WHERE id=?", (ids["sh"],)) == "ZZ RQ Title")

    s.section("the super admin's answers: who a full roster marks as left, and a seat it moves (2026-10-26)")
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES ('ZZRQ Group', 'ZZRQ Unit')")
        for eid_, nm_ in (("ZZRQ-K0", "ZZ RQ Keeper"), ("ZZRQ-L1", "ZZ RQ Stays"), ("ZZRQ-L2", "ZZ RQ Goes")):
            ids[eid_] = db.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, "
                                   "business_group, company, job_grade) VALUES (?,?, 'x', 'user', ?, 'ZZRQ Group', "
                                   "'ZZRQ Unit', 14)", (eid_.lower(), nm_, eid_)).lastrowid
        if not db.execute("SELECT 1 FROM buceo_seats WHERE business_group=? AND company=?", (BG, CO)).fetchone():
            db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, ids["ex"]))
            a._sync_buceo_primary(db, ids["ex"])
        db.commit()
    left_at = lambda eid_: H.one(a, "SELECT left_at FROM users WHERE employee_id=?", (eid_,))  # noqa: E731
    tok = upload([row(employee_id="ZZRQ-K0", employee_name="ZZ RQ Keeper", business_group="ZZRQ Group",
                      company="ZZRQ Unit", department="ZZRQ Desk")], mode="authoritative")
    C.post(P, data={"csrf_token": "tok", "token": tok, "action": "quality_ok", "ack": "1"})
    pg = page(tok, "changes")
    s.check("a full roster asks about each person it would mark as left, the super admin's to answer",
            "Not in the file (2)" in pg and "ZZ RQ Stays" in pg and "ZZ RQ Goes" in pg and "Mark as left" in pg
            and "Keep them" in pg and "Super admin answers" in pg and "0 of 2 answered" in pg)
    answer(tok, {"leave:ZZRQ-L1": "keep"})
    s.check("one left to answer: Continue is refused, nobody marked", "Continue to the final preview" in page(
        tok, "apply") and "Apply this file" not in page(tok, "apply") and not left_at("ZZRQ-L2")
        and not a._imp_meta("roster", tok).get("changes"))
    C.post(P, data={"csrf_token": "tok", "token": tok, "action": "apply"})
    s.check("...and Apply with one unanswered applies nothing", not left_at("ZZRQ-L2")
            and H.one(a, "SELECT department FROM users WHERE employee_id='ZZRQ-K0'") is None)
    answer(tok, {"leave:ZZRQ-L2": "leave"})
    pg = page(tok, "apply")
    s.check("both answered: the final preview says who stays and who is marked as left",
            "Kept: not in the file, stays active" in pg and "Marked as left" in pg
            and "and 1 marked as left" in pg and "Your answers" in pg)
    q0 = quality(tok, True)["fingerprint"]
    with a.app.app_context():   # what the file changes moves under it (the quality step doesn't): K0's department
        db = a.get_db()
        db.execute("UPDATE users SET department='ZZRQ Desk' WHERE employee_id='ZZRQ-K0'")
        db.commit()
    C.post(P, data={"csrf_token": "tok", "token": tok, "action": "apply"})
    s.check("if what the file changes moved since the final preview, Apply is refused: look at the changes again",
            not left_at("ZZRQ-L2") and quality(tok, True)["fingerprint"] == q0
            and "Continue to the final preview" in page(tok, "apply"))
    C.post(P, data={"csrf_token": "tok", "token": tok, "action": "to_apply"})
    with a.app.app_context():   # someone joins the group meanwhile: what the file does has changed
        db = a.get_db()
        ids["ZZRQ-L3"] = db.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, "
                                    "business_group, company, job_grade) VALUES ('zzrq-l3', 'ZZ RQ Late', 'x', 'user', "
                                    "'ZZRQ-L3', 'ZZRQ Group', 'ZZRQ Unit', 14)").lastrowid
        db.commit()
    C.post(P, data={"csrf_token": "tok", "token": tok, "action": "apply"})
    s.check("if OneHR changed since the answers (someone joined the group), Apply is refused, nobody marked",
            not left_at("ZZRQ-L2") and not left_at("ZZRQ-L3"))
    C.post(P, data={"csrf_token": "tok", "token": tok, "action": "quality_ok", "ack": "1"})
    answer(tok, {"leave:ZZRQ-L3": "keep"})
    C.post(P, data={"csrf_token": "tok", "token": tok, "action": "apply"})
    s.check("answered again and applied: the kept stay active, the one marked has left",
            not left_at("ZZRQ-L1") and not left_at("ZZRQ-L3") and bool(left_at("ZZRQ-L2")))
    s.check("...the audit trail names the super admin's answers", "kept 2 not in the file (ZZRQ-L1, ZZRQ-L3)" in (H.one(
        a, "SELECT detail FROM activity_log WHERE action='roster_import' AND user_id=? AND detail LIKE "
           "'the super admin%' ORDER BY id DESC LIMIT 1", (SU["id"],)) or ""))
    tok = upload([row(employee_id="ZZRQ-M1", employee_name="ZZ RQ Manager One", job_title="ZZ RQ Lead", bu_ceo_of=CO)])
    C.post(P, data={"csrf_token": "tok", "token": tok, "action": "quality_ok", "ack": "1"})
    pg = page(tok, "changes")
    s.check("a seat the file gives to someone else is asked, naming who loses it",
            "A seat the file gives to someone else (1)" in pg
            and "%s stops being BU CEO" % H.one(a, "SELECT full_name FROM users WHERE id=?", (ids["ex"],)) in pg
            and "Make the change" in pg and "Leave the seats" in pg)
    answer(tok, {"seat:ZZRQ-M1": "keep"})
    C.post(P, data={"csrf_token": "tok", "token": tok, "action": "apply"})
    s.check("left as they are: the seat stays where it was, and the rest of the row still goes in",
            H.one(a, "SELECT user_id FROM buceo_seats WHERE business_group=? AND company=?", (BG, CO)) == ids["ex"]
            and H.one(a, "SELECT job_title FROM users WHERE id=?", (ids["m1"],)) == "ZZ RQ Lead")
    with a.app.test_request_context("/"):   # only the super admin answers, whoever kept the file (the engine's guard)
        db = a.get_db()
        bga = dict(db.execute("SELECT * FROM users WHERE id=?", (_BGA["id"],)).fetchone())
        one_ = db.execute("SELECT employee_id, full_name, business_group, company FROM users WHERE role='user' AND "
                          "left_at IS NULL AND business_group=? AND company IS NOT NULL AND company!='' ORDER BY id "
                          "LIMIT 1", (bga["admin_bg"],)).fetchone()
        buf = io.StringIO()
        _csv.writer(buf).writerows([a.ROSTER_COLUMNS, row(employee_id=one_[0], employee_name=one_[1],
                                                         business_group=one_[2], company=one_[3])])
        t2 = a._imp_stage("roster", bga, "bga.csv", buf.getvalue().encode(), authoritative=True)
        a._imp_meta_set("roster", t2, quality=a._imp_load("roster", db, bga, t2)[3]["fingerprint"])
        ctx_ = a._imp_load("roster", db, bga, t2)[2]
        errs_ = ctx_["errors"]
        it_ = a._imp_items(a._rimp_changes(db, bga, ctx_, {}))
    with a.app.test_request_context("/", method="POST", data=dict(
            {"token": t2, "action": "to_apply"}, **{i["fid"]: "keep" for i in it_})):
        db = a.get_db()
        a._imp_post("roster", db, bga)
    s.check("a BG admin's own kept file, every row passing: their answers are refused, nothing saved",
            bool(it_) and not errs_ and not a._imp_meta("roster", t2).get("decisions") and not a._imp_meta("roster", t2).get("changes"),
            (len(it_), errs_[:2]))
finally:
    with a.app.app_context():
        db = a.get_db()
        _cleanup(db)

sys.exit(s.done())
