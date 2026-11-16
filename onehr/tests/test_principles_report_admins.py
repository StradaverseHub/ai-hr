"""The Leadership Principle report opens to BG and BU admins (Chris, 2026-11-11: "Enable Leadership Principle report (from 360
Feedback reports) to BG and BU admin"; rater names: "Raters-by-name holders" at first, then "Yes, super admin only" the same day).

It was super admin only. What this suite holds, each guard falsified (the same call with the guard off shows the opposite):
  - the gate is Results analysis's: @admin_required plus the role's f360 read tick; an admin without it, an L&D admin, is refused on
    the page AND the export, and the Reports hub carries no link for them (the link shows for a role that reads 360 Feedback)
  - scope: a BG admin's rows are exactly their own group's (the super admin's rows for that group), never one person twice
    (_report_scope narrows to a group for the super admin only, so the loop must), their `bgs` list is their group alone; a BU
    admin stays inside their units; a company-wide role (not super) sees every group once each
  - a spoofed ?bg= / ?bu= on the export is dropped; the context itself refuses a group the caller may not see
  - rater names: for the super admin ALONE ("Yes, super admin only", 2026-11-11; a holder of people.remarks_files had them for a few
    hours that day and no longer does: tests/test_rater_names_super.py); anyone else's payload carries NO name at all (page and
    exported file), a holder of the item included, only the count of raters who submitted, shown as "N raters submitted"

Its own synthetic admins and roles on the SHARED suite database, all removed at the end; the built-in roles are never edited.
The model is never called.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Leadership Principle report -- BG and BU admins, rater names for the super admin alone")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
RF = a.RF_ITEM
PAYLOAD = re.compile(r'<script id="lp-payload" type="application/json">(.*?)</script>', re.S)


def payload(resp):
    m = PAYLOAD.search(resp.get_data(as_text=True))
    return json.loads(m.group(1)) if m else None


def cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZLP-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM admin_companies WHERE admin_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids * 2)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM admin_role_access WHERE role_id IN (SELECT id FROM admin_roles WHERE name LIKE 'ZZLP %')")
    db.execute("DELETE FROM admin_roles WHERE name LIKE 'ZZLP %'")
    db.commit()


try:
    with a.app.test_request_context("/"):
        db = a.get_db()
        cleanup(db)
        cid = db.execute("SELECT cycle_id FROM assignments WHERE status='submitted' AND archived=0 GROUP BY cycle_id "
                         "ORDER BY COUNT(*) DESC LIMIT 1").fetchone()[0]
        SUPR = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                          "LIMIT 1").fetchone()[0]
        sup_me = db.execute("SELECT * FROM users WHERE id=?", (SUPR,)).fetchone()
        sup_rows = a._principles_report_context(db, sup_me, cid)["rows"]
        by_bg = {}
        for r in sup_rows:
            by_bg.setdefault(r["bg"], []).append(r)
        # the group to act in: the one with the most people across at least two units; and another group with people
        multi = [b for b, rs in by_bg.items() if len({r["bu"] for r in rs if r["bu"]}) >= 2]
        BGX = max(multi or by_bg, key=lambda b: len(by_bg[b]))
        BGY = next(b for b in sorted(by_bg) if b != BGX)
        x_rows = by_bg[BGX]
        cos = sorted({r["bu"] for r in x_rows if r["bu"]})
        BU_CO = [cos[0]]
        s.check("(the suite data: two groups with people, the first across two or more units, someone submitted a 360)",
                len(by_bg) >= 2 and len(cos) >= 2 and any(r["assessorCount"] for r in x_rows),
                (len(by_bg), len(cos)))

        base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
        cols = [c for c in base.keys() if c != "id"]

        def admin(eid, role_id, admin_bg, bg=None):
            v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ LP " + eid, email=None, hod_id=None,
                     manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=bg or BGX,
                     left_at=None, is_demo=0, role="admin", admin_bg=admin_bg, admin_role_id=role_id,
                     is_system_admin=0, display_name=None)
            db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                       [v[c] for c in cols])
            return db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]

        view = sorted(a.role_preset_items("view"))
        F360 = a.ADMIN_READ_ITEM["f360"]
        ROLE = {}
        for nm, items in (("ZZLP View", view), ("ZZLP Names", view + [RF]),
                          ("ZZLP NoF360", [i for i in view if i != F360])):
            db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES (?, 'group')", (nm,))
            rid = db.execute("SELECT id FROM admin_roles WHERE name=?", (nm,)).fetchone()[0]
            ROLE[nm] = rid
            db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)",
                           [(rid, i) for i in sorted(set(items))])
        lnd_role = db.execute("SELECT id FROM admin_roles WHERE builtin='lnd'").fetchone()[0]
        U = {
            "bga": admin("ZZLP-BGA", ROLE["ZZLP View"], BGX),            # BG admin, f360 read, no names
            "bga_names": admin("ZZLP-BGAN", ROLE["ZZLP Names"], BGX),    # BG admin with people.remarks_files
            "bua": admin("ZZLP-BUA", ROLE["ZZLP View"], BGX),            # unit admin, no names
            "bua_names": admin("ZZLP-BUAN", ROLE["ZZLP Names"], BGX),    # unit admin with names
            "nof": admin("ZZLP-NOF", ROLE["ZZLP NoF360"], BGX),          # no 360 Feedback read
            "lnd": admin("ZZLP-LND", lnd_role, a.LMS_ADMIN_BG),          # L&D admin
            "co": admin("ZZLP-CO", ROLE["ZZLP View"], a.ADMIN_COMPANY_SCOPE),   # a company-wide role, not the super admin
        }
        for k in ("bua", "bua_names"):
            db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?,?)", (U[k], BU_CO[0]))
        db.commit()
        s.check("(the roles: View reads 360 Feedback and has no names item; the Names role adds it; NoF360 cannot read it)",
                F360 in view and RF not in view and RF in a.admin_role_items(db, ROLE["ZZLP Names"])
                and F360 not in a.admin_role_items(db, ROLE["ZZLP NoF360"]))

        # ---- the context, called directly (the loop's own guards)
        def ctx_for(uid, **kw):
            me = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
            return a._principles_report_context(db, me, cid, **kw)
        c_bga = ctx_for(U["bga"])
        s.check("a BG admin's rows are exactly their group's people: the super admin's rows for that group, each once",
                sorted(r["eid"] for r in c_bga["rows"]) == sorted(r["eid"] for r in x_rows)
                and len({r["eid"] for r in c_bga["rows"]}) == len(c_bga["rows"]) and c_bga["rows"], len(c_bga["rows"]))
        s.check("...every row filed under its own group, and their bgs list is their group alone",
                all(r["bg"] == BGX for r in c_bga["rows"]) and [b["key"] for b in c_bga["bgs"]] == [BGX],
                [b["key"] for b in c_bga["bgs"]])
        s.check("...the context refuses a group they may not see, even when asked for it",
                ctx_for(U["bga"], fbgs=[BGY])["rows"] == [] and
                sorted(r["eid"] for r in ctx_for(U["bga"], fbgs=[BGX, BGY])["rows"]) == sorted(r["eid"] for r in x_rows))
        c_bua = ctx_for(U["bua"])
        want_bu = sorted(r["eid"] for r in x_rows if r["bu"] in BU_CO)
        s.check("a BU admin's rows are only their units' people, each once, and fewer than the group's",
                sorted(r["eid"] for r in c_bua["rows"]) == want_bu and want_bu
                and len(want_bu) < len(x_rows) and len({r["eid"] for r in c_bua["rows"]}) == len(c_bua["rows"]),
                (len(c_bua["rows"]), len(want_bu)))
        c_co = ctx_for(U["co"])
        s.check("a company-wide (non-super) role sees every group once each: the super admin's population, no duplicates",
                sorted(r["eid"] for r in c_co["rows"]) == sorted(r["eid"] for r in sup_rows)
                and all(r["bg"] in {b["key"] for b in c_co["bgs"]} for r in c_co["rows"]), len(c_co["rows"]))
        sup_names = {r["eid"]: sorted(r["assessors"]) for r in sup_rows}
        sup_counts = {r["eid"]: r["assessorCount"] for r in sup_rows}
        s.check("the super admin's rows carry the names, and the count equals the names listed",
                any(sup_names.values()) and all(len(sup_names[e]) == sup_counts[e] for e in sup_names))
        for k in ("bga", "bua", "co"):
            c_ = ctx_for(U[k])
            s.check("%s without the names item: no assessor name in the payload, the count equals the super admin's" % k,
                    all(r["assessors"] == [] for r in c_["rows"])
                    and all(r["assessorCount"] == sup_counts[r["eid"]] for r in c_["rows"])
                    and any(r["assessorCount"] for r in c_["rows"]))
        for k in ("bga_names", "bua_names"):
            c_ = ctx_for(U[k])
            s.check("%s with people.remarks_files: still no name (names are the super admin's alone), the count as the super admin's" % k,
                    c_["rows"] and all(r["assessors"] == [] for r in c_["rows"])
                    and all(r["assessorCount"] == sup_counts[r["eid"]] for r in c_["rows"])
                    and any(r["assessorCount"] for r in c_["rows"]))

    # ---- the routes
    C = {k: H.client_as(a, v) for k, v in U.items()}
    C["sup"] = H.client_as(a, SUPR)
    P, E = "/admin/reports/principles", "/admin/export/principles.html"

    r = C["sup"].get(P)
    pl = payload(r)
    s.check("super admin: the page opens with every group's people, names present",
            r.status_code == 200 and pl and len(pl["rows"]) == len(sup_rows) and len(pl["bgs"]) >= 2
            and any(x["assessors"] for x in pl["rows"]), r.status_code)
    r = C["bga"].get(P)
    pl = payload(r)
    s.check("a BG admin: the page opens (200), every row their group's, no one twice, bgs their group alone",
            r.status_code == 200 and pl and {x["bg"] for x in pl["rows"]} == {BGX}
            and len({x["eid"] for x in pl["rows"]}) == len(pl["rows"]) == len(x_rows)
            and [b["key"] for b in pl["bgs"]] == [BGX], r.status_code)
    s.check("...without the names item: no name in the page's payload, the count in its place",
            all(x["assessors"] == [] for x in pl["rows"]) and sum(x["assessorCount"] for x in pl["rows"]) > 0)
    body = r.get_data(as_text=True)
    s.check("...the page script words it N raters submitted (singular for one) where there is no name",
            "' rater' : ' raters') + ' submitted'" in body)
    pl = payload(C["bga_names"].get(P))
    s.check("a BG admin with people.remarks_files: no name in the payload either, their group's people and the counts",
            all(x["assessors"] == [] for x in pl["rows"]) and sum(x["assessorCount"] for x in pl["rows"]) > 0
            and {x["bg"] for x in pl["rows"]} == {BGX})
    pl = payload(C["bua"].get(P))
    s.check("a BU admin: only their units' people, no one twice",
            C["bua"].get(P).status_code == 200 and {x["bu"] for x in pl["rows"]} == set(BU_CO)
            and len({x["eid"] for x in pl["rows"]}) == len(pl["rows"]))
    pl = payload(C["bua_names"].get(P))
    s.check("...with the item, still no names; their pills list one group",
            all(x["assessors"] == [] for x in pl["rows"]) and sum(x["assessorCount"] for x in pl["rows"]) > 0
            and [b["key"] for b in pl["bgs"]] == [BGX])

    # refused: no f360 read, and an L&D admin; page and export both
    for k in ("nof", "lnd"):
        rp, re_ = C[k].get(P), C[k].get(E)
        s.check("%s: refused on the page and the export (never a 200 with the report)" % k,
                rp.status_code != 200 and re_.status_code != 200
                and 'id="lp-payload"' not in rp.get_data(as_text=True) and "lp-payload" not in re_.get_data(as_text=True),
                (rp.status_code, re_.status_code))
    hub_f = C["nof"].get("/admin/reports/all")
    hub_ok = C["bga"].get("/admin/reports/all")
    s.check("the Reports hub: no link to the report without 360 Feedback read; the link for a role that reads it",
            hub_f.status_code == 200 and P not in hub_f.get_data(as_text=True)
            and P in hub_ok.get_data(as_text=True) and "Leadership Principle report" in hub_ok.get_data(as_text=True),
            (hub_f.status_code, hub_ok.status_code))

    # ---- the export
    re_ = C["bga"].get(E + "?cycle=%d" % cid)
    pl = payload(re_)
    s.check("export, BG admin: a file with only their group's people, once each; no name in the file",
            re_.status_code == 200 and {x["bg"] for x in pl["rows"]} == {BGX}
            and len({x["eid"] for x in pl["rows"]}) == len(pl["rows"]) == len(x_rows)
            and all(x["assessors"] == [] for x in pl["rows"]) and [b["key"] for b in pl["bgs"]] == [BGX], re_.status_code)
    spoof = C["bga"].get(E + "?cycle=%d&bg=%s&bg=%s" % (cid, BGY.replace(" ", "+"), BGX.replace(" ", "+")))
    pl = payload(spoof)
    s.check("export, a spoofed ?bg= for another group (alone, and beside their own): only their own people",
            spoof.status_code == 200 and {x["bg"] for x in pl["rows"]} == {BGX}
            and len(pl["rows"]) == len(x_rows))
    spoof = C["bga"].get(E + "?cycle=%d&bg=%s" % (cid, BGY.replace(" ", "+")))
    pl = payload(spoof)
    s.check("...?bg= for another group alone: dropped, their group's people, never the other group's",
            spoof.status_code == 200 and {x["bg"] for x in pl["rows"]} == {BGX})
    other_bu = next(r["bu"] for r in by_bg[BGY] if r["bu"])
    spoof = C["bua"].get(E + "?cycle=%d&bu=%s&bu=%s" % (cid, other_bu.replace(" ", "+"), cos[1].replace(" ", "+")))
    pl = payload(spoof)
    s.check("export, a BU admin naming another unit or group's unit: only their own units' people",
            spoof.status_code == 200 and {x["bu"] for x in pl["rows"]} == set(BU_CO))
    pl = payload(C["bga_names"].get(E + "?cycle=%d" % cid))
    s.check("export, a holder of the item: no names in the file, their group only",
            all(x["assessors"] == [] for x in pl["rows"]) and sum(x["assessorCount"] for x in pl["rows"]) > 0
            and {x["bg"] for x in pl["rows"]} == {BGX})
    pl = payload(C["sup"].get(E + "?cycle=%d" % cid))
    s.check("export, super admin: everyone, names present",
            len(pl["rows"]) == len(sup_rows) and any(x["assessors"] for x in pl["rows"]))
finally:
    with a.app.test_request_context("/"):
        d = a.get_db()
        cleanup(d)

sys.exit(s.done())
