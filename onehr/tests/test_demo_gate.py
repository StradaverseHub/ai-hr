"""A "ZZ" Employee ID is not a demo account on its own (2026-10-15).

Real Chin Hin Employee IDs start with "ZZ" too: the real roster has 65 active SAG staff numbered X0001, ZZ-9001 ...
Until today 12 places in app.py treated ANY ZZ ID as a synthetic demo account, so on production those people would have
had the demo banner and Reset, the KPI / check-in / competency / plan editability overrides and the demo career ladder.
Now is_demo_account() needs BOTH halves: the server runs with L360_DEMO_ACCOUNTS=1 (staging and the suites; never
production) AND the ID is "ZZ" followed by a letter (every seeded demo account; none of the real ones).

This proves each half on its own -- with two real-shaped ZZ people and one demo-shaped person made in the scratch copy
(their old IDs are put back) -- and that no prefix test is left anywhere in app.py.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Demo gate -- a ZZ Employee ID is not a demo account on its own")


def demo_server(on):
    if on:
        os.environ["L360_DEMO_ACCOUNTS"] = "1"
    else:
        os.environ.pop("L360_DEMO_ACCOUNTS", None)


def gate_for(uid, path="/review/journey"):
    """(_review_demo_user() is set, the banner's demo strip flag) for `uid`, inside a request -- no writes."""
    from flask import session as _s
    with a.app.test_request_context(path):
        _s["user_id"] = uid
        return bool(a._review_demo_user()), bool(a.inject_user().get("nav_review_demo"))


with a.app.app_context():
    db = a.get_db()
    picks = db.execute("SELECT id, employee_id FROM users WHERE role!='admin' AND left_at IS NULL "
                       "AND COALESCE(employee_id,'') NOT LIKE 'ZZ%' ORDER BY id LIMIT 3").fetchall()
s.check("(the suite database has three ordinary people to borrow)", len(picks) == 3)
OLD = {r["id"]: r["employee_id"] for r in picks}
REAL_A, REAL_B, DEMO = [r["id"] for r in picks]
NEW = {REAL_A: "ZZ00991", REAL_B: "ZZ-0992", DEMO: "ZZDEMOGATE-A"}

try:
    with a.app.app_context():
        db = a.get_db()
        for uid, eid in NEW.items():
            db.execute("UPDATE users SET employee_id=? WHERE id=?", (eid, uid))
        # the demo routes sit under the review module, which CI's generated data ships OFF -- without this the Reset
        # would 404 from the module gate and the check below would pass for the wrong reason (the 2026-09-21 lesson)
        db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','evidence')")
        db.commit()
        rows = {r["id"]: dict(r) for r in db.execute("SELECT * FROM users WHERE id IN (?,?,?)", tuple(NEW))}

    s.section("On a demo server (staging, the suites)")
    demo_server(True)
    s.check("a seeded demo ID is a demo account (ZZPMDEMO-EMP, ZZDEMO-CHBM-EMP, ZZCHBM-0001)",
            all(a.is_demo_account(e) for e in ("ZZPMDEMO-EMP", "ZZDEMO-CHBM-EMP", "ZZCHBM-0001")))
    s.check("a real-shaped ZZ ID is NOT (X0001, ZZ-9001, ZZ1A)",
            not any(a.is_demo_account(e) for e in ("X0001", "ZZ-9001", "ZZ1A")))
    s.check("nor is a blank, a lowercase one, or an ordinary ID",
            not any(a.is_demo_account(e) for e in (None, "", "zzdemo-x", "X0004", "S00123")))
    s.check("a user row reads the same as its ID",
            a.is_demo_account(rows[DEMO]) and not a.is_demo_account(rows[REAL_A])
            and not a.is_demo_account(rows[REAL_B]))
    with a.app.app_context():
        got = {r[0] for r in a.get_db().execute(
            "SELECT id FROM users WHERE id IN (?,?,?) AND " + a.demo_account_sql("employee_id"), tuple(NEW))}
    s.check("the SQL form picks the demo-shaped person only", got == {DEMO}, got)
    s.check("the demo-shaped person gets the review demo controls", gate_for(DEMO) == (True, True), gate_for(DEMO))
    s.check("a real-shaped ZZ person gets none, on a demo server too",
            gate_for(REAL_A) == (False, False) and gate_for(REAL_B) == (False, False))
    cl = H.client_as(a, REAL_A)
    s.check("...and the demo Reset refuses them (404)",
            cl.post("/review/demo/reset-all", data={"csrf_token": "tok"}).status_code == 404)
    s.check("...the editability overrides don't apply to them (a plan outside the authoring window stays shut)",
            a._idp_self_editable(rows[DEMO], {"status": "draft"}, False) is True
            and a._idp_self_editable(rows[REAL_A], {"status": "draft"}, False) is False)
    s.check("...nor the competency override (a draft assessment with no setup is the demo's to edit, not theirs)",
            a._tc_self_editable(rows[DEMO], None) is True
            and a._tc_self_editable(rows[REAL_A], None) == a.tc_can_self_edit(None))

    s.section("On production (no L360_DEMO_ACCOUNTS)")
    demo_server(False)
    s.check("no ID at all is a demo account -- seeded ones included",
            not any(a.is_demo_account(e) for e in ("ZZPMDEMO-EMP", "ZZDEMOGATE-A", "X0001")))
    s.check("the SQL form matches nobody", a.demo_account_sql("employee_id") == "(0)")
    s.check("the demo-shaped person gets no demo controls", gate_for(DEMO) == (False, False), gate_for(DEMO))
    cl = H.client_as(a, DEMO)
    s.check("...and the demo Reset refuses them (404)",
            cl.post("/review/demo/reset-all", data={"csrf_token": "tok"}).status_code == 404)
    s.check("...nor the plan override", a._idp_self_editable(rows[DEMO], {"status": "draft"}, False) is False)
    with a.app.app_context():
        sw = a.get_db().execute("SELECT * FROM users WHERE COALESCE(demo_switcher,0)=1 AND left_at IS NULL "
                                "LIMIT 1").fetchone()
    if sw:
        s.check("the persona switcher offers nobody anything", a.demo_personas(sw) == [])
    else:
        s.note("no demo-switcher login in this database -- the persona check is skipped")
finally:
    demo_server(True)
    with a.app.app_context():
        db = a.get_db()
        for uid, eid in OLD.items():
            db.execute("UPDATE users SET employee_id=? WHERE id=?", (eid, uid))
        db.commit()

s.section("No prefix test is left")
src = H.code_without_docstrings(H.source(a))
left = [m.group(0) for m in re.finditer(r"""startswith\(\s*["']ZZ["']\s*\)|LIKE\s*'ZZ%'""", src)]
s.check("app.py tests no Employee ID for a bare 'ZZ' prefix (use is_demo_account / demo_account_sql)", not left, left)
with a.app.app_context():
    back = {r[0]: r[1] for r in a.get_db().execute("SELECT id, employee_id FROM users WHERE id IN (?,?,?)",
                                                   tuple(OLD))}
s.check("(the borrowed people have their own IDs back)", back == OLD)
sys.exit(s.done())
