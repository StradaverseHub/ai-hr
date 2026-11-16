"""Every admin link an admin is shown opens for them (found by the production rehearsal, 2026-10-14).

A BG admin's own pages linked to four super-admin-only pages that then refused them with 403: the 360 framework (from
360 Feedback > Settings and the person page's 360 tab), units calibrated together (Calibration > Settings), the audit log
and calibration groups (both on the person page). This walks the admin pages the way a person would -- from /admin,
following only the links each page shows -- as a BG admin and, when there is one, a unit admin, and fails on any link
that answers 403, 404 or a server error. Reads only: nothing that deletes, resets, unlocks or removes is followed.
"""
import os
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Admin links -- every link an admin is shown opens for them")

HREF = re.compile(r'href="(/admin[^"#]*)"')
SKIP = re.compile(r"logout|delete|reset|unlock|remove|/export/|\.csv|\.xlsx|\.pdf")


def walk(uid, limit=260):
    """(pages opened, [(code, path, linked from)] for anything that isn't 200)."""
    cl = H.client_as(a, uid)
    seen, queue, shapes, bad = set(), [("/admin", "-")], Counter(), []
    while queue and len(seen) < limit:
        pth, frm = queue.pop(0)
        pth = pth.replace("&amp;", "&")
        if pth in seen or SKIP.search(pth):
            continue
        shape = re.sub(r"\d+", "N", pth.split("?")[0])
        if shapes[shape] >= 2:   # a few of each kind of page, not every person
            continue
        shapes[shape] += 1
        seen.add(pth)
        r = cl.get(pth, follow_redirects=True)
        if r.status_code != 200:
            bad.append((r.status_code, pth.split("?")[0], frm.split("?")[0]))
        if (r.mimetype or "").startswith("text/html"):
            queue += [(h, pth) for h in HREF.findall(r.get_data(as_text=True)) if h not in seen]
    return len(seen), bad


with a.app.app_context():
    db = a.get_db()
    bga = db.execute("SELECT u.id FROM users u WHERE u.role='admin' AND COALESCE(u.admin_bg,'')!='' AND u.left_at IS "
                     "NULL AND NOT EXISTS (SELECT 1 FROM admin_companies ac WHERE ac.admin_id=u.id) ORDER BY u.id "
                     "LIMIT 1").fetchone()
    sub = db.execute("SELECT u.id FROM users u WHERE u.role='admin' AND u.left_at IS NULL AND EXISTS (SELECT 1 FROM "
                     "admin_companies ac WHERE ac.admin_id=u.id) ORDER BY u.id LIMIT 1").fetchone()

s.check("(the suite database has a BG admin)", bga is not None)
if bga:
    n, bad = walk(bga[0])
    s.check("a BG admin: every link on their pages opens (%d pages)" % n, n > 40 and not bad, bad[:6])
if sub:
    n, bad = walk(sub[0])
    s.check("a unit admin: every link on their pages opens (%d pages)" % n, n > 20 and not bad, bad[:6])
else:
    s.note("no unit admin in this database -- the BG admin's walk stands alone")
sys.exit(s.done())
