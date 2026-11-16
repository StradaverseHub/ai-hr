"""The admin person page's 360 panel header with a "No maximum" panel size (Chris, 2026-11-05).

effective_panel_size() is None when the cycle's panel_size is 0 (production's 2026 Year-End). The header used to print
"4 of a target None"; it now says "N on the panel, no maximum". A numeric size keeps "N of a target T".
The cycle's panel_size is put back exactly as it was.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("360 panel header: no maximum")
assert H.SCRATCH_MARKER in a.DB_PATH and "onehr-tests" in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, EMP = H.actors(a)
sup = H.client_as(a, SU["id"])


def D():
    return a.app.test_request_context("/")


with D() as ctx:
    db = a.get_db()
    CID = a.active_cycle_id(db)
    ORIG = db.execute("SELECT panel_size FROM cycles WHERE id=?", (CID,)).fetchone()[0]


def set_size(v):
    with D():
        db = a.get_db()
        db.execute("UPDATE cycles SET panel_size=? WHERE id=?", (v, CID))
        db.commit()


def page():
    r = sup.get("/admin/users/%d?tab=f360" % EMP["id"])
    return r.status_code, r.get_data(as_text=True)


try:
    s.section("No maximum")
    set_size(0)
    code, body = page()
    s.check("the 360 tab opens", code == 200, code)
    s.check("header reads 'on the panel, no maximum'", "on the panel, no maximum" in body)
    s.check("header never prints 'target None'", "target None" not in body)
    s.check("no 'of a target' wording when there is no target", "of a target" not in body)

    s.section("A numeric panel size")
    set_size(6)
    code, body = page()
    s.check("header reads 'of a target 6'", code == 200 and "of a target 6" in body, code)
    s.check("no 'no maximum' wording when there is a target", "on the panel, no maximum" not in body)
finally:
    set_size(ORIG)
    with D():
        now = a.get_db().execute("SELECT panel_size FROM cycles WHERE id=?", (CID,)).fetchone()[0]
    s.check("the cycle's panel_size is put back exactly", now == ORIG, (now, ORIG))

sys.exit(s.done())
