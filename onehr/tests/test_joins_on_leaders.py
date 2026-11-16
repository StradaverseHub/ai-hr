"""Units calibrated together, on Leaders > BU CEOs -- 2026-10-26, Chris: "Build it as drawn, with the shortcut, super
admin only" (it used to be a page of its own, /admin/calibration/joins, linked from Calibration & Talent > Settings).

What it holds:
  * the super admin sees "+ Join units" in the card's head, the Join units panel (the form, who calibrates, whose PAT),
    and, once units are joined, the join's own line (chip, cycle, curve, lock, "<BU CEO> calibrates", Manage), a
    "Calibrated with ..." sub-line on each joined unit, and the join's Manage panel with Separate
  * a BG admin sees none of it, the old route is the super admin's still, and a crafted post from a BG admin writes
    nothing
  * a join and a separate, posted from the panels, end back on Leaders > BU CEOs (a join with its Manage panel open;
    a refused join with the Join panel open); a locked join can't be separated and its panel says so
  * the old page's address redirects to Leaders with the Join units panel open
  * the shortcut: a BU CEO of two units that can be joined gets "Calibrate as one?" in each unit's panel, naming the
    other, with a link that opens Join units with both ticked and that unit leading; a BU CEO of one unit gets none;
    nor once those units are joined
  * the Settings card points at Leaders > BU CEOs; the route keeps its super-only access
"""
import html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Units calibrated together on Leaders > BU CEOs")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
BG, U1, U2, U3 = "ZZJOL Group", "ZZJOL Living", "ZZJOL Trading", "ZZJOL Bedding"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9JOL-%'")]
    db.execute("DELETE FROM calib_unit_joins WHERE business_group=?", (BG,))
    db.execute("DELETE FROM talent_box_bu_locks WHERE business_group=?", (BG,))
    if ids:
        ph = ",".join("?" * len(ids))
        for t, c in (("pm_kpi_targets", "subject_id"), ("cycle_participants", "subject_id"), ("buceo_seats", "user_id"),
                     ("rating_records", "subject_id"), ("ai_prerun_jobs", "subject_id")):
            try:
                db.execute("DELETE FROM %s WHERE %s IN (%s)" % (t, c, ph), ids)
            except Exception:   # noqa: BLE001 -- a table this copy lacks
                pass
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM activity_log WHERE action IN ('calib_join','calib_separate') AND detail LIKE 'ZZJOL%'")
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, co, name=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, is_demo) VALUES (?,?, 'x', 'user', ?,?,?, 'ZZJOL Dept', "
                      "'ZZJOL Officer', '15', 0)",
                      (eid.lower(), name or ("ZZ Jol " + eid.split("-", 1)[1]), eid, BG, co)).lastrowid


BGA0 = None
with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    PID = a.active_pm_period(db)["id"]
    for co in (U1, U2, U3):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, co))
    CEOX = person(db, "ZZ9JOL-CEOX", U1)   # leads two units
    CEOY = person(db, "ZZ9JOL-CEOY", U3)   # leads one
    P1, P2, P3 = person(db, "ZZ9JOL-P1", U1), person(db, "ZZ9JOL-P2", U2), person(db, "ZZ9JOL-P3", U3)
    for p_ in (CEOX, CEOY, P1, P2, P3):
        co_ = db.execute("SELECT company FROM users WHERE id=?", (p_,)).fetchone()[0]
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
                   "company) VALUES (?,?,'ZZJOL KPI',100,'more','approved',?,?)", (CID, p_, BG, co_))
        db.execute("INSERT OR REPLACE INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,'add')", (CID, p_))
    for co, ceo in ((U1, CEOX), (U2, CEOX), (U3, CEOY)):
        db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, co, ceo))
    for ceo in (CEOX, CEOY):
        a._sync_buceo_primary(db, ceo)
    db.commit()
    SLUG = {c: a._org_anchor_slug(c) for c in (U1, U2, U3)}
    CNAME = db.execute("SELECT name FROM cycles WHERE id=?", (CID,)).fetchone()[0]

C_SU = H.client_as(a, SU["id"])
C_BGA = H.client_as(a, BGA["id"]) if BGA else None
LEADERS = "/admin/leaders?tab=buceo&bg=" + BG.replace(" ", "+")


def page(client):
    r = client.get(LEADERS)
    return r.status_code, html.unescape(r.get_data(as_text=True))


def panel_of(pg, key):
    m = re.search(r'<aside class="adm-panel[^"]*" id="pnl-%s".*?</aside>' % re.escape(key), pg, re.S)
    return m.group(0) if m else ""


def joins_rows():
    return H.one(a, "SELECT COUNT(*) FROM calib_unit_joins WHERE cycle_id=? AND business_group=?", (CID, BG))


def jpost(client, **kw):
    d = {"csrf_token": "tok", "action": "join", "business_group": BG}
    d.update(kw)
    return client.post("/admin/calibration/joins", data=d)


try:
    # ---- the super admin's page, before any join
    code, pg = page(C_SU)
    s.check("the super admin opens Leaders > BU CEOs of the group", code == 200 and "BU CEOs in" in pg, code)
    s.check("+ Join units is in the card's head, an outline button before + Add a calibrator",
            re.search(r'class="btn" data-panel-open="bu-join">\+ Join units</button>', pg) is not None
            and pg.index("+ Join units") < pg.index("+ Add a calibrator") if "+ Add a calibrator" in pg
            else "+ Join units" in pg)
    s.check("the card's intro says what Units calibrated together are", "Units calibrated together</b> merge" in pg)
    jp_ = panel_of(pg, "bu-join")
    s.check("the Join units panel holds the form: units, who calibrates them, whose PAT curve, its own confirm",
            jp_ and 'name="company"' in jp_ and 'name="lead"' in jp_ and 'name="curve_of"' in jp_
            and "Join the units" in jp_ and 'data-confirm="Calibrate the ticked units together' in jp_
            and 'action="/admin/calibration/joins"' in jp_ and "is-wide" in jp_, bool(jp_))
    s.check("...with the narrowing script", "narrow(lead, on)" in jp_ and "narrow(curve, on)" in jp_)
    s.check("the three units are listed", all(u in jp_ for u in (U1, U2, U3)))
    s.check("no line of a join yet", 'id="bu-join-' not in pg and '<span class="ld-sub">Calibrated with' not in pg)

    # ---- the shortcut
    p1, p2, p3 = (panel_of(pg, "bu-" + SLUG[u]) for u in (U1, U2, U3))
    s.check("the shortcut: a BU CEO of two units that can be joined is offered 'Calibrate as one?' in each unit's panel, "
            "naming the other",
            "Calibrate as one?" in p1 and U2 in p1.split("Calibrate as one?")[1][:400]
            and "Calibrate as one?" in p2 and U1 in p2.split("Calibrate as one?")[1][:400], (bool(p1), bool(p2)))
    s.check("...its link opens Join units with both ticked and that unit leading",
            'data-panel-open="bu-join"' in p1 and 'data-join-ticks' in p1 and U1 in p1.split("data-join-lead=")[1][:60]
            and U2 in p1.split("data-join-ticks=")[1][:120])
    s.check("a BU CEO of one unit is offered none", p3 and "Calibrate as one?" not in p3, bool(p3))

    # ---- a BG admin sees none of it (and can't post)
    if C_BGA:
        with a.app.app_context():
            db = a.get_db()
            BGA0 = db.execute("SELECT admin_bg FROM users WHERE id=?", (BGA["id"],)).fetchone()[0]
            db.execute("UPDATE users SET admin_bg=? WHERE id=?", (BG, BGA["id"]))
            db.commit()
        a_, b_ = C_BGA.get(LEADERS), None
        pgb = html.unescape(a_.get_data(as_text=True))
        s.check("a BG admin opens the same tab", a_.status_code == 200 and "BU CEOs in" in pgb, a_.status_code)
        s.check("...and sees no Join units button, panel, shortcut or Units calibrated together text",
                all(t not in pgb for t in ("Join units", "pnl-bu-join", "Calibrate as one?", "Units calibrated together",
                                           "data-join-ticks")))
        rb = jpost(C_BGA, company=[U1, U2], lead=U1, curve_of=U1)
        s.check("a crafted post from a BG admin is refused and writes nothing", rb.status_code == 403 and joins_rows() == 0,
                (rb.status_code, joins_rows()))
        s.check("the old page is not the BG admin's either", C_BGA.get("/admin/calibration/joins").status_code == 403)

    # ---- a refused join comes back with the Join panel open
    r = jpost(C_SU, company=[U1], lead=U1, curve_of=U1)
    loc = r.headers.get("Location", "")
    s.check("a refused join (one unit) goes back to Leaders > BU CEOs with the Join units panel open",
            r.status_code == 302 and "/admin/leaders" in loc and "tab=buceo" in loc and "panel=bu-join" in loc
            and joins_rows() == 0, loc)

    # ---- a join from the panel
    r = jpost(C_SU, company=[U1, U2], lead=U1, curve_of=U1)
    loc = r.headers.get("Location", "")
    s.check("a join posted from the panel ends back on Leaders, its Manage panel open",
            r.status_code == 302 and "/admin/leaders" in loc and "tab=buceo" in loc and "panel=bj-" in loc
            and "/calibration/joins" not in loc and joins_rows() == 2, loc)
    code, pg = page(C_SU)
    line = re.search(r'<tr class="ld-grp-row" id="bu-join-.*?</tr>', pg, re.S)
    line = line.group(0) if line else ""
    s.check("the join has its own line: both names, the chip, the cycle, the curve, not locked",
            U1 in line and U2 in line and "Units calibrated together" in line and CNAME + " only" in line
            and "Curve: " + U1 + "'s PAT" in line and "Not locked" in line, line[:300])
    s.check("...with its people, '<BU CEO> calibrates', the sub-line and a Manage button",
            "ZZ Jol CEOX calibrates" in line and "One curve, one lock, one unit on the Talent Box" in line
            and 'data-panel-open="bj-' in line and ">Manage<" in line
            and re.search(r"<td>3</td>", line) is not None, line[-400:])
    s.check("the line sits in the grouped tbody, with no calibration panel at all",
            re.search(r'<tbody class="ld-grp-body">\s*<tr class="ld-grp-row" id="bu-join-', pg) is not None)
    rows_u = {u: re.search(r'<tr class="data-row[^"]*" data-bu="%s".*?</tr>' % re.escape(u), pg, re.S) for u in (U1, U2, U3)}
    s.check("each joined unit's own row says who it is calibrated with; the third has no such line",
            rows_u[U1] and "Calibrated with %s this cycle" % U2 in rows_u[U1].group(0)
            and rows_u[U2] and "Calibrated with %s this cycle" % U1 in rows_u[U2].group(0)
            and rows_u[U3] and "Calibrated with" not in rows_u[U3].group(0))
    mg = panel_of(pg, "bj-" + SLUG[U1])
    s.check("the Manage panel: Now (units with counts, calibrated by, curve, spread, lock), the change-by-rejoining line",
            mg and "Now" in mg and "%s (2)" % U1 in mg and "%s (1)" % U2 in mg and "Calibrated by" in mg
            and "Expected spread" in mg and "Not locked" in mg
            and "To change who calibrates or the curve" in mg
            and "Separate them and join them again, before the BU CEO&#39;s first move." in mg.replace("'", "&#39;"), bool(mg))
    s.check("...and the red Separate box with its own confirm, posting to the join route",
            'class="adm-danger"' in mg and "Separate&hellip;" in mg.replace("…", "&hellip;")
            and 'data-confirm-tone="danger"' in mg and 'value="separate"' in mg and "Locked: can't be separated" not in mg)
    s.check("the Join units panel greys the joined units out, with the reason",
            'disabled' in panel_of(pg, "bu-join") and "With " in panel_of(pg, "bu-join"))
    p1 = panel_of(pg, "bu-" + SLUG[U1])
    s.check("once joined, the shortcut is gone", "Calibrate as one?" not in p1, bool(p1))

    # ---- locked: nothing to separate with
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO talent_box_bu_locks(period_id, cycle_id, business_group, company) VALUES (?,?,?,?)",
                   (PID, CID, BG, U2))
        db.commit()
    code, pg = page(C_SU)
    mg = panel_of(pg, "bj-" + SLUG[U1])
    s.check("a locked join's Manage panel says so and has no Separate box",
            "Locked: can't be separated this cycle." in mg and 'class="adm-danger"' not in mg, bool(mg))
    r = C_SU.post("/admin/calibration/joins", data={"csrf_token": "tok", "action": "separate", "business_group": BG,
                                                     "lead": U1})
    s.check("...and a crafted separate is refused, back on Leaders with the Manage panel open",
            joins_rows() == 2 and r.status_code == 302 and "/admin/leaders" in r.headers.get("Location", "")
            and "panel=bj-" in r.headers.get("Location", ""), r.headers.get("Location"))
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM talent_box_bu_locks WHERE business_group=?", (BG,))
        db.commit()

    # ---- separate from the panel
    r = C_SU.post("/admin/calibration/joins", data={"csrf_token": "tok", "action": "separate", "business_group": BG,
                                                     "lead": U1})
    loc = r.headers.get("Location", "")
    s.check("separate posted from the panel ends back on Leaders > BU CEOs, and the units are apart again",
            r.status_code == 302 and "/admin/leaders" in loc and "tab=buceo" in loc and "/calibration/joins" not in loc
            and joins_rows() == 0, loc)
    code, pg = page(C_SU)
    s.check("...the line and the sub-lines are gone, and the shortcut is back",
            'id="bu-join-' not in pg and '<span class="ld-sub">Calibrated with' not in pg
            and "Calibrate as one?" in panel_of(pg, "bu-" + SLUG[U1]))

    # ---- the old address
    r = C_SU.get("/admin/calibration/joins?fbg=" + BG.replace(" ", "+"))
    loc = r.headers.get("Location", "")
    s.check("the old page's address redirects to Leaders > BU CEOs with the Join units panel open",
            r.status_code == 302 and "/admin/leaders" in loc and "tab=buceo" in loc and "panel=bu-join" in loc
            and "bg=ZZJOL" in loc, loc)

    # ---- the Settings card
    with a.app.test_request_context("/"):
        settings_url = a.url_for("admin_module_settings", key="calibration")
        want_href = a.url_for("admin_leaders", tab="buceo")
    rs = C_SU.get(settings_url)
    pgs = html.unescape(rs.get_data(as_text=True))
    card = re.search(r'<section class="admin-card adm-set-card" id="joins">.*?</section>', pgs, re.S)
    card = card.group(0) if card else ""
    s.check("the Settings card's button opens Leaders > BU CEOs, and says where it is set up",
            rs.status_code == 200 and want_href in card and "Open Leaders › BU CEOs" in card
            and "Set up on Leaders › BU CEOs." in card and "/admin/calibration/joins" not in card, card[-300:])
    s.check("the route stays the super admin's alone",
            a.ADMIN_ACCESS_MAP.get("admin_calibration_joins") == "super")
finally:
    with a.app.app_context():
        db = a.get_db()
        if BGA0 is not None or (BGA and C_BGA):
            db.execute("UPDATE users SET admin_bg=? WHERE id=?", (BGA0, BGA["id"]))
        _cleanup(db)

sys.exit(s.done())
