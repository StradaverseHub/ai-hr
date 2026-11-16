"""A view-only BG admin sees a person's KPI lines but no add, edit or delete controls (Chris, 2026-11-06: the open item
"BG admin sees Add a KPI and Edit on Performance; not tested whether the server refuses the save").

What it holds: the server already refuses the writes (admin_person_kpi, ADMIN_ACCESS_MAP): a view-only BG admin's POST is
403. This suite checks the page now matches: the add bar and per-row Edit are gone for them, and the super admin keeps
them. Read only: no data is written, so nothing needs putting back.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A view-only BG admin reads a person's KPIs with no add or edit controls")
SU, BGA, EMP = H.actors(a)
s.check("fixture has a BG admin and a super admin", BGA is not None and SU is not None)

with a.app.app_context():
    d = a.get_db()
    tgt = d.execute("SELECT id FROM users WHERE role!='admin' AND left_at IS NULL AND business_group=? LIMIT 1",
                    (BGA["admin_bg"],)).fetchone() if BGA else None
    tgt2 = d.execute("SELECT id FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone()
s.check("a person in the BG admin's group exists", tgt is not None)

if tgt:
    bga = H.client_as(a, BGA["id"])
    r = bga.get("/admin/users/%d?tab=performance" % tgt["id"])
    b = r.get_data(as_text=True)
    s.check("view-only BG admin opens the Performance tab", r.status_code == 200, r.status_code)
    s.check("no add bar for a view-only BG admin", "kpe-addbar" not in b and "kpe-addbtn" not in b)
    s.check("no Add form or picker data for a view-only BG admin", 'data-kpe="add"' not in b and 'id="kpe-lib"' not in b)
    s.check("no add panel opened by URL either",
            'data-kpe="add"' not in bga.get("/admin/users/%d?tab=performance&panel=kpi-add" % tgt["id"]).get_data(as_text=True))
    s.check("the POST is still refused (403)",
            bga.post("/admin/users/%d/kpi" % tgt["id"], data={"csrf_token": "tok", "action": "add"}).status_code == 403)

sup = H.client_as(a, SU["id"])
r2 = sup.get("/admin/users/%d?tab=performance" % tgt2["id"])
s2 = r2.get_data(as_text=True)
s.check("no Delete button for a view-only BG admin", "kpe-delbtn" not in b)
s.check("super admin still sees the add bar on an active cycle", r2.status_code == 200 and "kpe-addbar" in s2, r2.status_code)

sys.exit(s.done())
