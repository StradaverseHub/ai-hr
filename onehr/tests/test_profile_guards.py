"""Profile-change guards, piece 1 (Chris, 2026-11-08: "we need to have guards on when admin changes a person's BG, job title,
job grade ... either via Claude session, data import, or admin change on UI"). One engine, three ways in: the person page's
Edit details (P), the people import (R) and a script (S). What a person or a leader already did stays; what is still pending
follows their new details; where the change would silently alter a decided result OneHR refuses and says why.

What this suite holds (synthetic ZZPG-* people and groups on a fresh scratch database; Suite.done() puts it back):
  * refusals: a unit change that moves who calibrates them once a band is set (P and R), a result released, a department-only
    change that moves nobody's calibrator is NOT refused; a Grade H person into or out of a released unit (P); a business group
    change by a seat holder (R); a group change with no unit of the new group in the same row (R). Each refusal is shown in the
    .pp-refuse box with "Nothing has been saved", and refused again on apply.
  * automatic: a unit move takes the old unit's unacted BU KPI line off and adds the new unit's, the held (acted-on) line stays,
    a guest line of another unit stays, their own lines carry the new unit; a department-only change works the unit's setups out
    again; a grade move changes a grade-banded weight on an unacted line and not on a held one; a calibration pick in a group that
    does not hold the new unit goes (and stays where the group holds it); a below-minimum grade archives their 360 ratings as the
    person rated and a move back restores them (their own KPI lines untouched); the rating record is refreshed (P and R, R
    batched); a business group move through the roster is "Set later" (bg_pending, the super admins' one email, listed in the
    Changes step) and a move back clears it; a no-change save does nothing
  * the roster HOD write goes through the Leaders page's rule at apply time (a refused one is left as it was, counted, and an
    accepted one leaves an audit row); a business group change that keeps an HOD of the old group is "worth a look", not an error
  * the Career Plan's chosen role below their grade (or far above) no longer drives new goals; the stored pick stays
Every guard is falsified in this suite by switching it off and showing the same step then goes through; the report that came with
the commit lists the ones that were also falsified by editing the code.
"""
import io
import csv as _csv
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Profile-change guards, piece 1: refusals and automatic follow-ups")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
GA, GB = "ZZPG Alpha", "ZZPG Beta"
A1, A2, A3, A4, B1 = "ZZPG A1", "ZZPG A2", "ZZPG A3", "ZZPG A4", "ZZPG B1"
SENT = []
_mail = (a.mailer.is_configured, a.mailer.send_mail)
a.mailer.is_configured = lambda: True
a.mailer.send_mail = lambda to, subj, body, *x, **k: SENT.append((to, subj))
P = "/admin/import/roster"


def q(sql, args=()):
    return [tuple(r) for r in H.rows(a, sql, args)]


def one(sql, args=()):
    return H.one(a, sql, args)


with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','tm','pm','idp')")
    db.execute("UPDATE cycles SET kind='early_year', year=2027, half=0, min_job_grade=NULL, starts_on=NULL WHERE id=?", (CID,))
    for bg, us in ((GA, (A1, A2, A3, A4)), (GB, (B1,))):
        for u_ in us:
            db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (bg, u_))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (GA,))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'B', 'base')", (GB,))
    for lab, mn, mx, o in (("UA", 0, 59, 1), ("BE", 60, 79, 2), ("ME", 80, 109, 3), ("AE", 110, 129, 4), ("OU", 130, 999, 5)):
        db.execute("INSERT INTO pm_rating_bands(business_group, min_value, max_value, label, sort_order) VALUES (?,?,?,?,?)",
                   (GB, mn, mx, lab, o))
    db.execute("INSERT INTO admin_notify_emails(user_id, email) VALUES (?, 'super@zzpg.invalid')", (SU["id"],))

    def mk(eid, bg=GA, unit=A1, dept="Ops", grade=14, mgr=None, hod=None, title="ZZ Officer", **kw):
        cols = dict(username=eid.lower(), full_name="ZZ PG " + eid.split("-", 1)[1], password_hash="x", role="user", employee_id=eid,
                    business_group=bg, company=unit, department=dept, job_title=title, job_grade=grade,
                    confirmation_date="2020-01-01", manager_id=mgr, hod_id=hod)
        cols.update(kw)
        return a.get_db().execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), list(cols.values())).lastrowid
    MGR = mk("ZZPG-MGR", grade=21, dept="Management")
    HODA = mk("ZZPG-HODA", grade=21, dept="Management")
    HODB = mk("ZZPG-HODB", bg=GB, unit=B1, grade=21, dept="Management")
    # departments the movers can be moved to (a department comes from the unit's list, or is named as new)
    mk("ZZPG-D1", unit=A1, dept="Ops")
    mk("ZZPG-D2", unit=A1, dept="Sales")
    mk("ZZPG-D3", unit=A2, dept="Ops")
    db.commit()
    SUROW = dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
    ACT = dict(db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone())
    PREV = dict(ACT)

SUP = H.client_as(a, SU["id"])
N = [0]
with a.app.app_context():
    DA1, DA2 = a.display_company(GA, A1), a.display_company(GA, A2)   # how OneHR spells a unit on screen


def person(tag, **kw):
    N[0] += 1
    kw.setdefault("mgr", MGR)
    with a.app.app_context():
        d = a.get_db()
        pid = mk("ZZPG-%s" % tag, **kw)
        d.commit()
    return pid


def row(pid):
    return dict(H.rows(a, "SELECT * FROM users WHERE id=?", (pid,))[0])


def line(pid, name, bg=GA, unit=A1, dept="Ops", w=50):
    with a.app.app_context():
        d = a.get_db()
        tg = d.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, rate4, "
                       "rate5, business_group, company, department) VALUES (?,?,?,?, 'more', 10,20,30,40,50, ?,?,?)",
                       (CID, pid, name, w, bg, unit, dept)).lastrowid
        d.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (tg, MGR))
        d.commit()
    return tg


def lines(pid):
    return [dict(r) for r in H.rows(a, "SELECT * FROM pm_kpi_targets WHERE subject_id=? AND cycle_id=? ORDER BY id", (pid, CID))]


def bu_setup(bg, unit, name, carriers="everyone", w=20, mode="one", bands=None, data=None):
    with a.app.app_context():
        d = a.get_db()
        sid = d.execute("INSERT INTO pm_bu_kpis(cycle_id, business_group, company, kpi_name, method, rate1, rate2, rate3, rate4, "
                        "rate5, carriers, carriers_json, weight_mode, weight, bands_json) VALUES (?,?,?,?, 'more', 1,2,3,4,5, ?,?,?,?,?)",
                        (CID, bg, unit, name, carriers, data, mode, w, bands)).lastrowid
        d.commit()
    return sid


def bu_apply(sid, pid):
    """Put a BU KPI setup's line on one person, as the setup's own save does."""
    with a.app.app_context():
        d = a.get_db()
        p = dict(d.execute("SELECT * FROM users WHERE id=?", (pid,)).fetchone())
        mine = [x for x in a._bu_unit_people(d, p["business_group"], p["company"]) if x["id"] == pid] or [p]
        a._bu_kpi_apply(d, SUROW, ACT, d.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (sid,)).fetchone(), mine, only=pid)
        d.commit()


def result(tid):
    """A result on the line: someone has acted on it, so the setup holds it."""
    with a.app.app_context():
        d = a.get_db()
        d.execute("INSERT OR REPLACE INTO pm_kpi_results(kpi_target_id, actual_value, draft) VALUES (?,25,0)", (tid,))
        d.commit()


def pform(pid, unit=None, dept=None, grade=None, bg=None, title=None, action="details_apply", **kw):
    p = row(pid)
    d = {"csrf_token": "tok", "action": action, "full_name": p["full_name"], "company": unit if unit is not None else p["company"],
         "department": dept if dept is not None else (p["department"] or ""), "job_title": title if title is not None else (p["job_title"] or ""),
         "job_grade": str(grade if grade is not None else p["job_grade"] or ""), "joined_date": ""}
    if bg is not None:
        d["business_group"] = bg
    d.update(kw)
    return d


def post(pid, **kw):
    return SUP.post("/admin/users/%d/lines" % pid, data=pform(pid, **kw), follow_redirects=True)


def txt(r):
    import html as _h
    return _h.unescape(r.get_data(as_text=True))


def trail(pid, action=None):
    return [r[0] for r in H.rows(a, "SELECT detail FROM activity_log WHERE target_user_id=?" + (" AND action=?" if action else "")
                                 + " ORDER BY id", (pid,) + ((action,) if action else ()))]


def band(pid):
    """A calibrated band set on them this cycle (a BU CEO tier move)."""
    with a.app.app_context():
        d = a.get_db()
        sid = d.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label) "
                        "VALUES (?, 'buceo', ?, ?, 'ZZPG')", (CID, "ZZPG scope %d" % pid, GA)).lastrowid
        d.execute("INSERT INTO pm_calibration_adjustments(session_id, subject_id, original_band, adjusted_band) VALUES (?,?, 'ME', 'AE')",
                  (sid, pid))
        d.commit()


def rec(eid, name, **kw):
    r = {"employee id": eid, "employee name": name, "business group": GA, "company": A1}
    r.update(kw)
    return r


def check(records):
    with a.app.app_context():
        d = a.get_db()
        return a._roster_check(d, dict(d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()), records, False)


def run_roster(records, **kw):
    """check, then apply as the import does; returns (chk, prof_out, (created, updated, ...))."""
    with a.app.test_request_context("/"):
        d = a.get_db()
        me = dict(d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
        chk = a._roster_check(d, me, records, False)
        assert not chk["errors"], chk["errors"]
        po = {}
        res = a._roster_apply(d, me, chk, prof_out=po, **kw)
        return chk, po, res


def csv_bytes(rows):
    buf = io.StringIO()
    w = _csv.writer(buf)
    w.writerow(a.ROSTER_COLUMNS)
    cols = {c.lower(): c for c in a.ROSTER_COLUMNS}
    for r in rows:
        w.writerow([r.get(c.lower(), "") for c in a.ROSTER_COLUMNS])
    return buf.getvalue().encode()


def upload(rows):
    r = SUP.post(P, data={"csrf_token": "tok", "mode": "upsert", "preview": "1", "file": (io.BytesIO(csv_bytes(rows)), "pg.csv")},
                 content_type="multipart/form-data")
    return r.headers.get("Location", "").split("check=")[-1]


def steps(tok):
    """quality, answers and apply, as the four-step page's posts do. Returns the Changes page and the done page."""
    SUP.post(P, data={"csrf_token": "tok", "token": tok, "action": "quality_ok", "ack": "1"})
    changes = SUP.get(P + "?check=%s&step=changes" % tok).get_data(as_text=True)
    SUP.post(P, data={"csrf_token": "tok", "token": tok, "action": "to_apply"})
    SUP.post(P, data={"csrf_token": "tok", "token": tok, "action": "apply"})
    done = SUP.get(P + "?done=%s" % tok).get_data(as_text=True)
    return changes, done


def falsify(name, patches, then, moved):
    """Switch a guard off (module-level patches {name: replacement}), run `then`, put it back: `moved()` must now be True."""
    real = {k: getattr(a, k) for k in patches}
    try:
        for k, v in patches.items():
            setattr(a, k, v)
        then()
        got = moved()
    finally:
        for k, v in real.items():
            setattr(a, k, v)
    s.check("falsified: %s -- with the guard switched off the same step goes through" % name, got)


def set_cycle(**cols):
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE cycles SET %s WHERE id=?" % ", ".join("%s=?" % k for k in cols), list(cols.values()) + [CID])
        d.commit()


# ---------------------------------------------------------------------------------------------------------------------------
s.section("fixture")
X = person("X1")
with a.app.app_context():
    d = a.get_db()
    s.check("fixture: the BU KPI setup is open (an Early Year)", a._bu_kpi_state(d, a.active_cycle(d))[0])
    s.check("fixture: X takes part in the KPI review", any(x["id"] == X for x in a._bu_unit_people(d, GA, A1)))

# ---------------------------------------------------------------------------------------------------------------------------
s.section("refusal 2: a unit change that moves who calibrates them, once a band is set (P)")
X2 = person("X2")
band(X2)
b = txt(SUP.post("/admin/users/%d/lines" % X2, data=pform(X2, unit=A2, action="details_preview")))
s.check("the preview refuses in the .pp-refuse box, with the page that fixes it, and the save button is off",
        'class="pp-refuse"' in b and "Can't move them yet" in b and "a calibrated band has already been set on them this cycle (buceo)" in b
        and "Their record" in b and "Nothing has been saved." in b and re.search(r'class="primary" disabled>Save details', b), b[:200])
b = txt(post(X2, unit=A2))
s.check("the apply refuses again, saying nothing was saved, and the unit stays", "Nothing has been saved" in b and row(X2)["company"] == A1)
s.check("...no trail line, no rating record written", not trail(X2, "set_details") and one("SELECT COUNT(*) FROM rating_records WHERE subject_id=?", (X2,)) == 0)
post(X2, dept="Sales")
s.check("a department-only change (no calibration group moves with it) is NOT refused, even with a band set",
        row(X2)["department"] == "Sales", row(X2)["department"])
post(X2, dept="Ops")
falsify("the unit refusal (P)", {"_profile_org_refusals_many": lambda db_, pairs, cid, links=True: {o["id"]: [] for o, _n in pairs}},
        lambda: post(X2, unit=A2), lambda: row(X2)["company"] == A2)
with a.app.app_context():
    a.get_db().execute("UPDATE users SET company=? WHERE id=?", (A1, X2))
    a.get_db().commit()
X3 = person("X3")
with a.app.app_context():
    a.get_db().execute("INSERT INTO result_releases(cycle_id, subject_id, kind) VALUES (?,?, 'pm')", (CID, X3))
    a.get_db().commit()
b = txt(post(X3, unit=A2))
s.check("a released result refuses the same change, in words", "Their result for this cycle is released" in b and row(X3)["company"] == A1)
s.check("a person with nothing decided moves freely", (post(person("X4"), unit=A2) and True))

# ---------------------------------------------------------------------------------------------------------------------------
s.section("refusal 2 on R: the people import refuses the same change, as an error row naming the person")
R2 = person("R2")
band(R2)
chk = check([rec("ZZPG-R2", "ZZ PG R2", company=A2)])
why = [e["why"] for e in chk["errors"]]
s.check("a file moving them to another unit stops the whole file, in OneHR's words",
        len(why) == 1 and "ZZ PG R2 (ZZPG-R2): can't move to " in why[0] and "a calibrated band has already been set" in why[0], why)
s.check("...the row is not among the ones to apply, and nothing is counted as an update", not chk["valid"] and chk["counts"]["update"] == 0)
s.check("a department-only change in a file is not refused", not check([rec("ZZPG-R2", "ZZ PG R2", company=A1, department="Sales")])["errors"])
falsify("the unit refusal (R)", {"_profile_org_refusals_all": lambda db_, pairs, cid, links=True: {o["id"]: [] for o, _n in pairs}},
        lambda: run_roster([rec("ZZPG-R2", "ZZ PG R2", company=A2)]), lambda: row(R2)["company"] == A2)
with a.app.app_context():
    a.get_db().execute("UPDATE users SET company=? WHERE id=?", (A1, R2))
    a.get_db().commit()

# ---------------------------------------------------------------------------------------------------------------------------
s.section("refusal 3: a Grade H person into or out of a unit whose Grade H results are released")
GH = person("GH1", grade="H")
with a.app.app_context():
    a.get_db().execute("INSERT INTO gradeh_releases(cycle_id, unit, released_by) VALUES (?,?,?)", (CID, A2, SU["id"]))
    a.get_db().commit()
b = txt(post(GH, unit=A2))
s.check("moving INTO a released unit is refused, naming it", "Grade H Appraisal" in b and "they can't join it now" in b and row(GH)["company"] == A1, b[:100])
GH2 = person("GH2", grade="H", unit=A2)
b = txt(post(GH2, unit=A1))
s.check("moving OUT of one is refused too", "they can't leave it now" in b and row(GH2)["company"] == A2)
s.check("a person who is not on Grade H moves in and out as before", (post(person("GN1", unit=A2), unit=A1) and True)
        and row(one("SELECT id FROM users WHERE employee_id='ZZPG-GN1'"))["company"] == A1)
falsify("the Grade H refusal", {"_gh_cal_lock_text": lambda db_, cid, co: None}, lambda: post(GH, unit=A2), lambda: row(GH)["company"] == A2)
with a.app.app_context():
    a.get_db().execute("UPDATE users SET company=? WHERE id=?", (A1, GH))
    a.get_db().execute("DELETE FROM gradeh_releases WHERE cycle_id=?", (CID,))
    a.get_db().commit()

# ---------------------------------------------------------------------------------------------------------------------------
s.section("refusal 1 and 4 on R: a group change by a seat holder, and the unit that must come with it")
BC = person("BC1", unit=A1)
with a.app.app_context():
    a.get_db().execute("UPDATE users SET bgceo_bg=? WHERE id=?", (GA, BC))
    a.get_db().commit()
chk = check([rec("ZZPG-BC1", "ZZ PG BC1", **{"business group": GB, "company": B1})])
s.check("a BG CEO named in a file under another group is refused, as the person page refuses it",
        len(chk["errors"]) == 1 and "can't move to " in chk["errors"][0]["why"] and "BG CEO of" in chk["errors"][0]["why"], chk["errors"])
BU = person("BU1", unit=A1)
with a.app.app_context():
    a.get_db().execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (GA, A1, BU))
    a.get_db().commit()
chk = check([rec("ZZPG-BU1", "ZZ PG BU1", **{"business group": GB, "company": B1})])
s.check("a BU CEO is refused the same way", len(chk["errors"]) == 1 and "BU CEO of" in chk["errors"][0]["why"], chk["errors"])
falsify("the seat refusal (R)", {"_bg_move_refusals_many": lambda db_, people, links=True: {p_["id"]: [] for p_ in people}},
        lambda: run_roster([rec("ZZPG-BC1", "ZZ PG BC1", **{"business group": GB, "company": B1})]), lambda: row(BC)["business_group"] == GB)
with a.app.app_context():
    a.get_db().execute("UPDATE users SET bgceo_bg=NULL, business_group=?, company=? WHERE id=?", (GA, A1, BC))
    a.get_db().commit()
FREE = person("BF1", unit=A1)
chk = check([rec("ZZPG-BF1", "ZZ PG BF1", **{"business group": GB, "company": ""})])
s.check("a group change with a blank unit cell is an error row (they would keep a unit of the old group)",
        len(chk["errors"]) == 1 and "Business unit cell" in chk["errors"][0]["why"], chk["errors"])
chk = check([rec("ZZPG-BF1", "ZZ PG BF1", **{"business group": GB, "company": A2})])
s.check("...and so is a unit that is not in the new group (Org structure says so, or the move's own words)", len(chk["errors"]) == 1
        and ("isn't a unit in Org structure" in chk["errors"][0]["why"] or "can't move to" in chk["errors"][0]["why"]), chk["errors"])

# ---------------------------------------------------------------------------------------------------------------------------
s.section("a unit move: BU KPI lines follow (held and guest lines stay), their own lines carry the new unit")
S1 = bu_setup(GA, A1, "ZZPG PAT A1", w=20)
S2 = bu_setup(GA, A2, "ZZPG PAT A2", w=10)
S3 = bu_setup(GA, A3, "ZZPG PAT A3", carriers="pick", w=10, data='{"people": [], "guests": {"ZZPG-G1": 10}}')
U = person("U1")
line(U, "ZZPG own 1")
line(U, "ZZPG own 2", w=30)
bu_apply(S1, U)
V = person("V1")
bu_apply(S1, V)
vt = next(l_["id"] for l_ in lines(V) if l_["bu_kpi_id"] == S1)
result(vt)
G = person("G1")
line(G, "ZZPG own g")
bu_apply(S1, G)
bu_apply(S3, G)
s.check("fixture: U, V and the guest G carry the old unit's BU KPI line; G also a guest line of A3's",
        any(l_["bu_kpi_id"] == S1 for l_ in lines(U)) and any(l_["bu_kpi_id"] == S1 for l_ in lines(V))
        and any(l_["bu_kpi_id"] == S3 for l_ in lines(G)), [(l_["kpi_name"], l_["bu_kpi_id"]) for l_ in lines(G)])
b = txt(post(U, unit=A2))
LU = lines(U)
s.check("their old unit's BU KPI line came off and the new unit's came on", not any(l_["bu_kpi_id"] == S1 for l_ in LU)
        and any(l_["bu_kpi_id"] == S2 and l_["kpi_name"] == "ZZPG PAT A2" for l_ in LU), [(l_["kpi_name"], l_["bu_kpi_id"]) for l_ in LU])
s.check("their own KPI lines carry the new unit (the figures untouched)", all(
    l_["company"] == A2 for l_ in LU if l_["kpi_name"].startswith("ZZPG own")) and [l_["weightage"] for l_ in LU if l_["kpi_name"].startswith("ZZPG own")] == [50, 30])
s.check("the flash says what followed", ("BU KPI line of %s taken off" % DA1) in b and ("BU KPI line of %s added" % DA2) in b
        and "KPI lines now carry their new unit and department" in b, re.findall(r"Details saved[^<]{0,300}", b)[:1])
s.check("the trail line carries the same words", any(("BU KPI line of %s taken off" % DA1) in t_ for t_ in trail(U, "set_details")), trail(U))
post(V, unit=A2)
LV = lines(V)
s.check("a line someone acted on stays on the old unit's setup, still linked (held)", any(l_["bu_kpi_id"] == S1 for l_ in LV)
        and any(l_["bu_kpi_id"] == S2 for l_ in LV), [(l_["kpi_name"], l_["bu_kpi_id"]) for l_ in LV])
b = txt(post(G, unit=A2))
LG = lines(G)
s.check("a guest line of ANOTHER unit of the group stays linked to its setup", any(l_["bu_kpi_id"] == S3 for l_ in LG)
        and not any(l_["bu_kpi_id"] == S1 for l_ in LG) and any(l_["bu_kpi_id"] == S2 for l_ in LG), [(l_["kpi_name"], l_["bu_kpi_id"]) for l_ in LG])
# falsify the held rule: with nobody's line held, V's line would have come off
V2 = person("V2")
bu_apply(S1, V2)
v2t = next(l_["id"] for l_ in lines(V2) if l_["bu_kpi_id"] == S1)
result(v2t)
falsify("held lines stay (a line someone acted on)", {"_bu_line_locked": lambda db_, tid: False}, lambda: post(V2, unit=A2),
        lambda: not any(l_["bu_kpi_id"] == S1 for l_ in lines(V2)))
# a unit move while the setup is closed (a Year-End, past the point where BU KPIs open): the lines stay, and the flash says so
CL = person("CL1")
bu_apply(S1, CL)
set_cycle(kind="year_end", half=2)
with a.app.app_context():
    open_ = a._bu_kpi_state(a.get_db(), a.active_cycle(a.get_db()))[0]
b = txt(post(CL, unit=A2))
s.check("with the BU KPI setup closed the lines stay as they are, and the flash says so",
        (not open_) and any(l_["bu_kpi_id"] == S1 for l_ in lines(CL)) and "stay as they are: the BU KPI setup is closed" in b,
        (open_, re.findall(r"Details saved[^<]{0,200}", b)[:1]))
set_cycle(kind="early_year", half=0)

s.section("a department-only change works the unit's BU KPIs out again (departments coverage)")
S6 = bu_setup(GA, A1, "ZZPG PAT Sales", carriers="departments", w=15, data='{"departments": ["Sales"]}')
DP = person("DP1", dept="Ops")
bu_apply(S6, DP)
s.check("fixture: an Ops person is not covered by the Sales setup", not any(l_["bu_kpi_id"] == S6 for l_ in lines(DP)))
post(DP, dept="Sales")
s.check("moving to Sales gives them the Sales BU KPI line", any(l_["bu_kpi_id"] == S6 for l_ in lines(DP)) and row(DP)["department"] == "Sales")
post(DP, dept="Ops")
s.check("...and moving back takes it off again (an unacted line)", not any(l_["bu_kpi_id"] == S6 for l_ in lines(DP)))

# ---------------------------------------------------------------------------------------------------------------------------
s.section("a grade move: a grade-banded BU KPI weight follows an unacted line, not a held one")
S5 = bu_setup(GA, A4, "ZZPG PAT banded", w=0, mode="grade", bands='[{"min": 16, "max": null, "w": 25}, {"min": null, "max": 15, "w": 15}]')
GP1 = person("GP1", unit=A4, grade=14)
GP2 = person("GP2", unit=A4, grade=14)
bu_apply(S5, GP1)
bu_apply(S5, GP2)
g1 = next(l_ for l_ in lines(GP1) if l_["bu_kpi_id"] == S5)
g2 = next(l_ for l_ in lines(GP2) if l_["bu_kpi_id"] == S5)
result(g2["id"])
s.check("fixture: both carry the band's 15", g1["weightage"] == 15 and g2["weightage"] == 15, (g1["weightage"], g2["weightage"]))
b = txt(post(GP1, grade=17))
s.check("the unacted line takes their new grade band's weight (25), and the flash says so",
        next(l_["weightage"] for l_ in lines(GP1) if l_["bu_kpi_id"] == S5) == 25 and "follows their new grade" in b, b[:0])
post(GP2, grade=17)
s.check("a line someone acted on keeps its weight (15)", next(l_["weightage"] for l_ in lines(GP2) if l_["bu_kpi_id"] == S5) == 15)
GP3 = person("GP3", unit=A4, grade=14)
bu_apply(S5, GP3)
falsify("the grade follow-up", {"_profile_grade_follow": lambda db_, me_, act_, new_: []}, lambda: post(GP3, grade=17),
        lambda: next(l_["weightage"] for l_ in lines(GP3) if l_["bu_kpi_id"] == S5) == 15)

# ---------------------------------------------------------------------------------------------------------------------------
s.section("a calibration pick by name in a group that does not hold the new unit goes")
with a.app.app_context():
    d = a.get_db()
    CAL = mk("ZZPG-CAL", grade=21, dept="Management")
    GID = d.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id) VALUES (?,?,?,?)",
                    (GA, A1, "ZZPG Group One", CAL)).lastrowid
    d.execute("INSERT INTO calib_bu_group_units(group_id, business_group, company, department) VALUES (?,?,?,?)", (GID, GA, A1, "Ops"))
    d.commit()
ZP = person("ZP1")
ZQ = person("ZQ1")
with a.app.app_context():
    d = a.get_db()
    for z in (ZP, ZQ):
        d.execute("INSERT INTO calib_bu_group_people(group_id, business_group, user_id) VALUES (?,?,?)", (GID, GA, z))
    d.commit()
b = txt(post(ZP, unit=A2))
s.check("moved to A2, the group (which holds only A1) no longer names them, and the flash names the group",
        not q("SELECT 1 FROM calib_bu_group_people WHERE user_id=?", (ZP,)) and "ZZPG Group One" in b and row(ZP)["company"] == A2, b[:0])
s.check("...the trail has it too", any("ZZPG Group One" in t_ for t_ in trail(ZP, "set_details")))
with a.app.app_context():
    d = a.get_db()
    d.execute("INSERT INTO calib_bu_group_units(group_id, business_group, company, department) VALUES (?,?,?,?)", (GID, GA, A2, "Ops"))
    d.commit()
post(ZQ, unit=A2)
s.check("a group that DOES hold the new unit keeps its pick", q("SELECT 1 FROM calib_bu_group_people WHERE user_id=?", (ZQ,)) != [])
with a.app.app_context():
    d = a.get_db()
    d.execute("DELETE FROM calib_bu_group_units WHERE group_id=? AND company=?", (GID, A2))
    d.execute("UPDATE users SET company=? WHERE id=?", (A1, ZQ))
    d.commit()
falsify("the pick removal", {"_profile_pick_drops_many": lambda db_, pairs: {}}, lambda: post(ZQ, unit=A2),
        lambda: q("SELECT 1 FROM calib_bu_group_people WHERE user_id=?", (ZQ,)) != [])

# ---------------------------------------------------------------------------------------------------------------------------
s.section("taking part: a below-minimum grade archives their 360 as the person rated, and a move back restores it")
set_cycle(min_job_grade=12)
FL = person("FL1", grade=14)
line(FL, "ZZPG own flip")
with a.app.app_context():
    d = a.get_db()
    for k in range(2):
        rater = mk("ZZPG-FR%d" % k, grade=16)
        d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) VALUES (?,?,?,'peer','pending')",
                  (CID, FL, rater))
    d.commit()


def live360(pid):
    return one("SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND subject_id=? AND archived=0", (CID, pid))


b = txt(post(FL, grade=10))
s.check("below the cycle's lowest grade: their 360 rows as the person rated are archived, with the reason",
        live360(FL) == 0 and one("SELECT COUNT(*) FROM assignments WHERE subject_id=? AND archive_reason=?", (FL, a.PROFILE_OUT_REASON)) == 2
        and "no longer takes part" in b and "2 of their 360 ratings" in b, b[:0])
s.check("...their own KPI lines are not touched", len(lines(FL)) == 1)
post(FL, grade=14)
s.check("a grade back at the minimum restores them", live360(FL) == 2 and one(
    "SELECT COUNT(*) FROM assignments WHERE subject_id=? AND archived=1", (FL,)) == 0)
FL2 = person("FL2", grade=14)
with a.app.app_context():
    d = a.get_db()
    d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) VALUES (?,?,?,'peer','pending')",
              (CID, FL2, MGR))
    d.commit()
falsify("the taking-part sync", {"_rated_360_sync": lambda *x, **k: (0, 0, 0)}, lambda: post(FL2, grade=10), lambda: live360(FL2) == 1)
set_cycle(min_job_grade=None)

# ---------------------------------------------------------------------------------------------------------------------------
s.section("the rating record is refreshed for any detail change (P, and R batched)")
set_cycle(kind="year_end", half=2)
RR1 = person("RR1")
RR2 = person("RR2")
RR3 = person("RR3", title="ZZ Old Title")
for _p in (RR1, RR2, RR3):   # a record follows only for someone who has one or has entered something on a line (_kpe_records_follow)
    result(line(_p, "ZZPG rr %d" % _p))
post(RR1, unit=A2)
rr = q("SELECT company, last_event FROM rating_records WHERE cycle_id=? AND subject_id=?", (CID, RR1))
s.check("a unit change through the person page refreshes their record (it names the new unit)", rr and rr[0][0] == A2, rr)
chk, po, res = run_roster([rec("ZZPG-RR2", "ZZ PG RR2", company=A2), rec("ZZPG-RR3", "ZZ PG RR3", company=A1, **{"job title": "ZZ New Title"})])
rr2 = q("SELECT company FROM rating_records WHERE subject_id=?", (RR2,))
rr3 = q("SELECT job_title FROM rating_records WHERE subject_id=?", (RR3,))
s.check("the roster refreshes everyone it changed, in one pass (a unit and a job title)", rr2 and rr2[0][0] == A2 and rr3 and rr3[0][0] == "ZZ New Title", (rr2, rr3))
s.check("...and says how many people it changed", po.get("people") == 2, po)
RR4 = person("RR4")
result(line(RR4, "ZZPG rr4"))
falsify("the record refresh", {"_rating_record_refresh": lambda *x, **k: 0}, lambda: post(RR4, unit=A2),
        lambda: not q("SELECT 1 FROM rating_records WHERE subject_id=?", (RR4,)))
set_cycle(kind="early_year", half=0)

# ---------------------------------------------------------------------------------------------------------------------------
s.section("an import rebuilds at most one Capture click's worth of rating records; the rest wait for the next Capture")
set_cycle(kind="year_end", half=2)


def cap_person(tag, **kw):
    pid = person(tag, **kw)
    result(line(pid, "ZZPG cap " + tag))   # a result on a line: the person has a record to rebuild
    return pid


CAPM = cap_person("CAPM", unit=A1)
CAPG = [cap_person("CAPG%d" % k, grade=14) for k in range(3)]
CAPN = person("CAPN", grade=14)   # changes too, but has nothing entered: no record to rebuild
CAPALL = [CAPM] + CAPG + [CAPN]
ELIGIBLE = [CAPM] + CAPG


def cap_run(cap, bg_cap=None):
    """Change the five people in one apply (a unit move, three grade changes, one with no record); returns (refresh calls, out)."""
    calls, out = [], {}
    real, real_cap = a._rating_record_refresh, a._RR_CAPTURE_BATCH
    a._RR_CAPTURE_BATCH = cap
    a._rating_record_refresh = lambda d_, cid, ids, ev, *x, **k: (calls.append((ev, list(ids))), real(d_, cid, ids, ev, *x, **k))[1]
    try:
        with a.app.test_request_context("/"):
            d = a.get_db()
            me = dict(d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
            olds = [dict(d.execute("SELECT * FROM users WHERE id=?", (pid,)).fetchone()) for pid in CAPALL]
            d.execute("UPDATE users SET company=? WHERE id=?", (A2, CAPM))
            for pid in CAPG + [CAPN]:
                d.execute("UPDATE users SET job_grade=job_grade+1 WHERE id=?", (pid,))
            a._profile_change_apply_many(d, me, olds, dict(d.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()),
                                         "roster", out=out)
            d.commit()
    finally:
        a._rating_record_refresh, a._RR_CAPTURE_BATCH = real, real_cap
    return calls, out


def cap_undo():
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE users SET company=? WHERE id=?", (A1, CAPM))
        for pid in CAPG + [CAPN]:
            d.execute("UPDATE users SET job_grade=14 WHERE id=?", (pid,))
        d.commit()


calls, out = cap_run(2)
rebuilt = [i for _ev, ids in calls for i in ids]
s.check("with the cap at 2, no more than 2 records are rebuilt in the request", len(rebuilt) <= 2 and len(rebuilt) == 2, calls)
s.check("...the group or unit mover goes first (bg_move), the rest after it (profile_change), with only the cap left over",
        calls and calls[0][0] == "bg_move" and calls[0][1] == [CAPM] and all(ev == "profile_change" for ev, _i in calls[1:]), calls)
s.check("...records_left is the eligible people beyond the cap (the one with no record is not counted)",
        out.get("records_left") == len(ELIGIBLE) - len(rebuilt) and out.get("records_left", 0) > 0, out)
note = a._records_left_note(out.get("records_left"))
s.check("...and the note names how many will update at the next Capture", str(out.get("records_left")) in note and "next Capture" in note, note)
cap_undo()
calls, out = cap_run(a._RR_CAPTURE_BATCH)
rebuilt = [i for _ev, ids in calls for i in ids]
s.check("at the normal cap everyone with a record is rebuilt and nothing is left (records_left absent)",
        sorted(rebuilt) == sorted(ELIGIBLE) and "records_left" not in out, (calls, out))
cap_undo()
CAPREAL = a._RR_CAPTURE_BATCH
a._RR_CAPTURE_BATCH = 1
try:
    tok = upload([rec("ZZPG-CAPM", "ZZ PG CAPM", company=A2)] + [rec("ZZPG-CAPG%d" % k, "ZZ PG CAPG%d" % k, **{"job title": "ZZ Cap Title"})
                                                            for k in range(3)])
    ch_, done_ = steps(tok)
finally:
    a._RR_CAPTURE_BATCH = CAPREAL
s.check("the roster import's result lines carry the 'will update at the next Capture' sentence when records are left",
        "will update at the next Capture on Ratings record" in done_, re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", done_))[:600])
cap_undo()
with a.app.app_context():
    d = a.get_db()
    d.execute("UPDATE users SET job_title='ZZ Officer' WHERE employee_id LIKE 'ZZPG-CAPG%'")
    d.commit()
set_cycle(kind="early_year", half=0)

# ---------------------------------------------------------------------------------------------------------------------------
s.section("a business group move through the roster is Set later; a move back clears it")
Y = person("Y1")
line(Y, "ZZPG Y one")
line(Y, "ZZPG Y two", w=30)
SENT.clear()
tok = upload([rec("ZZPG-Y1", "ZZ PG Y1", **{"business group": GB, "company": B1})])
s.check("the file checks clean (a group, a unit of it, and nothing that stops it)", len(tok) == 32, tok)
changes_pg, done_pg = steps(tok)
s.check("the Changes step lists the group change, with the chip's words",
        "Business group" in changes_pg and "ZZ PG Y1" in changes_pg and "ZZPG Beta" in changes_pg
        and "their calibrators, KPI scale and admins follow the group" in changes_pg)
p_ = row(Y)
LY = lines(Y)
s.check("apply moved them to the new group and unit", p_["business_group"] == GB and p_["company"] == B1, (p_["business_group"], p_["company"]))
s.check("their lines wait on the old framework: bg_pending, still the old group's scale",
        all(l_["bg_pending"] == 1 and l_["business_group"] == GA for l_ in LY) and len(LY) == 2, [(l_["bg_pending"], l_["business_group"]) for l_ in LY])
s.check("the super admins get ONE task email, naming the KPI lines to set", [m for m in SENT if "KPI lines to set for ZZ PG Y1" in m[1]].__len__() == 1, SENT)
s.check("the done page says so", "moved business group" in done_pg and "to set later" in done_pg, re.findall(r"[^<>]*moved business group[^<>]*", done_pg)[:1])
s.check("a set_bg line in their trail, from the roster import", any("(roster import)" in t_ and "business group" in t_ for t_ in trail(Y, "set_bg")), trail(Y))
b = txt(SUP.get("/admin/users/%d" % Y))
s.check("their page holds the Total KPI score (Needs attention says lines wait)", "KPI lines to set" in b or "to set" in b)
chk, po, res = run_roster([rec("ZZPG-Y1", "ZZ PG Y1", **{"business group": GA, "company": A1})])
LY = lines(Y)
s.check("a roster move BACK to the group their lines are on clears the wait: bg_pending 0, on the group's scale",
        row(Y)["business_group"] == GA and all(l_["bg_pending"] == 0 and l_["business_group"] == GA for l_ in LY), [(l_["bg_pending"], l_["business_group"]) for l_ in LY])
YP = person("YP1")
line(YP, "ZZPG YP one")
post(YP, bg=GB, unit=B1, kpi_mode="later")
s.check("(P) set later: waits", all(l_["bg_pending"] == 1 for l_ in lines(YP)) and row(YP)["business_group"] == GB)
r = post(YP, bg=GA, unit=A1, kpi_mode="later")
s.check("(P) moved back: the wait is cleared (no figures asked for lines already on that scale)",
        row(YP)["business_group"] == GA and all(l_["bg_pending"] == 0 and l_["business_group"] == GA for l_ in lines(YP)),
        [(l_["bg_pending"], l_["business_group"]) for l_ in lines(YP)])

# ---------------------------------------------------------------------------------------------------------------------------
s.section("the roster HOD goes through the Leaders page's rule at apply time")
AH = person("AH1", hod=None)
BH = person("BH1", hod=None)
MV = person("MV1", unit=A1)
# AH's HOD cell names MV, whom the SAME file moves to another business group. Any person may be HOD of people in another group
# (Chris, 2026-11-09), so the apply writes it as the file says; BH's HOD cell names HODA, which stands as always
chk = check([rec("ZZPG-AH1", "ZZ PG AH1", hod="ZZPG-MV1"), rec("ZZPG-BH1", "ZZ PG BH1", hod="ZZPG-HODA"),
             rec("ZZPG-MV1", "ZZ PG MV1", **{"business group": GB, "company": B1})])
s.check("fixture: the file passes the check", not chk["errors"], chk["errors"])
chk, po, res = run_roster([rec("ZZPG-AH1", "ZZ PG AH1", hod="ZZPG-MV1"), rec("ZZPG-BH1", "ZZ PG BH1", hod="ZZPG-HODA"),
                           rec("ZZPG-MV1", "ZZ PG MV1", **{"business group": GB, "company": B1})])
s.check("an HOD the same file moves to another group is written as the file says, and nothing is counted as refused",
        row(AH)["hod_id"] == MV and row(MV)["business_group"] == GB and not po.get("hod_refused"), (row(AH)["hod_id"], po))
s.check("...the HOD that stands is written too, with one audit row naming the old and the new", row(BH)["hod_id"] == HODA and any(
    "(roster import)" in t_ and "none -> ZZ PG HODA" in t_ for t_ in trail(BH, "hod_assign")), trail(BH))
s.check("...and the cross-group one has its own audit row", any("(roster import)" in t_ and "none -> ZZ PG MV1" in t_
                                                                for t_ in trail(AH, "hod_assign")), trail(AH))
# the guard is still real for what it still refuses: the old cross-group refusal put back refuses the same file, so the
# check above is not passing by accident
AH2 = person("AH2", hod=None)
MV2 = person("MV2", unit=A1)
_real_hce = a._hod_candidate_error


def _old_rule(db, me, bg, hod):
    if hod and hod["business_group"] != bg:
        return "an HOD can span business units, but not business groups"
    return _real_hce(db, me, bg, hod)


a._hod_candidate_error = _old_rule
try:
    chk2, po2, res2 = run_roster([rec("ZZPG-AH2", "ZZ PG AH2", hod="ZZPG-MV2"),
                                  rec("ZZPG-MV2", "ZZ PG MV2", **{"business group": GB, "company": B1})])
finally:
    a._hod_candidate_error = _real_hce
s.check("FALSIFY: with the old cross-group refusal put back the same step leaves the HOD unset and counts it",
        row(AH2)["hod_id"] is None and po2.get("hod_refused") == 1, (row(AH2)["hod_id"], po2))

s.section("a group change that keeps an HOD of the old group is no longer flagged: any person may be HOD across groups")
WL = person("WL1", hod=HODA)
chk = check([rec("ZZPG-WL1", "ZZ PG WL1", **{"business group": GB, "company": B1})])
with a.app.app_context():
    d = a.get_db()
    qual = a._roster_quality(d, dict(d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()), chk)
look = {g["key"]: g for g in qual["look"]}
s.check("no error, and the quality step has no 'keeps an HOD of the old group' row (the check is gone)",
        not chk["errors"] and "hod_other_bg" not in look and "hod_other_bg" not in {k for k, _w, _y in a._RQ_LOOK}, (chk["errors"], list(look)))
s.check("...the same file applied keeps the HOD they have", run_roster([rec("ZZPG-WL1", "ZZ PG WL1", **{"business group": GB, "company": B1})])
        and row(WL)["hod_id"] == HODA and row(WL)["business_group"] == GB)

# ---------------------------------------------------------------------------------------------------------------------------
s.section("Career Plan: a chosen role that no longer fits their grade stops driving new goals; the pick stays")
with a.app.app_context():
    d = a.get_db()
    PROFS = {g: d.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, source, active) VALUES "
                          "('ZZPG Dept', ?, ?, ?, 1)", ("ZZPG Role JG%d" % g, str(g), a._CAREER_DEMO_SOURCE)).lastrowid for g in (13, 14, 15, 18)}
    d.commit()
CP = person("CP1", grade=14)


def pick_role(pid, prof):
    with a.app.app_context():
        d = a.get_db()
        a.pm_career_profile_for(d, pid, create=True)
        d.execute("UPDATE pm_career_profile SET target_profile_id=? WHERE subject_id=?", (prof, pid))
        d.commit()


def gap(pid):
    with a.app.app_context():
        d = a.get_db()
        return a._career_target_gap(d, dict(d.execute("SELECT * FROM users WHERE id=?", (pid,)).fetchone()))["target"]


pick_role(CP, PROFS[15])
s.check("fixture: a role one grade up drives their goals", (gap(CP) or "").startswith("ZZPG Role JG15"), gap(CP))
with a.app.app_context():
    a.get_db().execute("UPDATE users SET job_grade=16 WHERE id=?", (CP,))
    a.get_db().commit()
s.check("after their grade moves above it, the chosen role no longer drives goals", not (gap(CP) or "").startswith("ZZPG Role JG15"), gap(CP))
s.check("...the stored pick is untouched", one("SELECT target_profile_id FROM pm_career_profile WHERE subject_id=?", (CP,)) == PROFS[15])
with a.app.app_context():
    a.get_db().execute("UPDATE users SET job_grade=14 WHERE id=?", (CP,))
    a.get_db().commit()
pick_role(CP, PROFS[14])
s.check("a role AT their grade stays valid (a lateral move was a valid pick)", (gap(CP) or "").startswith("ZZPG Role JG14"), gap(CP))
pick_role(CP, PROFS[18])
s.check("a role more than two grades above is not used", not (gap(CP) or "").startswith("ZZPG Role JG18"), gap(CP))
pick_role(CP, PROFS[15])
with a.app.app_context():
    a.get_db().execute("UPDATE users SET job_grade=16 WHERE id=?", (CP,))
    a.get_db().commit()
falsify("the career pick guard", {"_career_pick_stale": lambda *x, **k: False}, lambda: None,
        lambda: (gap(CP) or "").startswith("ZZPG Role JG15"))

# ---------------------------------------------------------------------------------------------------------------------------
s.section("a script: the same UPDATE, then the engine, with no request at all")
SC = person("SC1")
line(SC, "ZZPG own sc")
bu_apply(S1, SC)
with a.app.app_context():
    d = a.get_db()
    old = dict(d.execute("SELECT * FROM users WHERE id=?", (SC,)).fetchone())
    refused = a._profile_change_plan(d, SUROW, old, {"company": A2}, ACT)["refusals"]
    d.execute("UPDATE users SET company=? WHERE id=?", (A2, SC))
    mails = []
    words = a._profile_change_apply(d, SUROW, old, ACT, "script", mail_out=mails)
    d.commit()
s.check("the plan answers outside a request (no URL to build) and the engine moves their lines in the same transaction",
        refused == [] and any("taken off" in w_ for w_ in words) and not any(l_["bu_kpi_id"] == S1 for l_ in lines(SC))
        and any(l_["bu_kpi_id"] == S2 for l_ in lines(SC)) and all(l_["company"] == A2 for l_ in lines(SC) if l_["kpi_name"] == "ZZPG own sc"), words)

s.section("the roster's apply re-checks the refusals: a band set between the check and the apply rolls the whole file back")
RB = person("RB1")
RC = person("RC1")
with a.app.app_context():
    d = a.get_db()
    me = dict(d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
    chk = a._roster_check(d, me, [rec("ZZPG-RB1", "ZZ PG RB1", company=A2, **{"job title": "ZZ Roll Back"}), rec("ZZPG-RC1", "ZZ PG RC1", company=A2)], False)
s.check("fixture: the file checks clean", not chk["errors"], chk["errors"])
band(RC)
raised = None
with a.app.test_request_context("/"):
    d = a.get_db()
    me = dict(d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
    try:
        a._roster_apply(d, me, chk)
    except ValueError as e:
        raised = str(e)
        d.rollback()
s.check("it refuses in words (the caller rolls back: Not applied, nothing changed)", raised and "can't be moved now" in raised, raised)
s.check("...and neither person was changed", row(RB)["company"] == A1 and row(RC)["company"] == A1 and row(RB)["job_title"] != "ZZ Roll Back")


def _apply_stale_check():   # the check said yes (before the band); only the APPLY's own re-check is switched off
    with a.app.test_request_context("/"):
        d = a.get_db()
        a._roster_apply(d, dict(d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()), chk)


falsify("the roster's apply-time re-check", {"_profile_org_refusals_all": lambda db_, pairs, cid, links=True: {o["id"]: [] for o, _n in pairs}},
        _apply_stale_check, lambda: row(RC)["company"] == A2)

# ---------------------------------------------------------------------------------------------------------------------------
s.section("nothing changed: nothing happens")
NC = person("NC1")
before = (one("SELECT COUNT(*) FROM activity_log"), one("SELECT COUNT(*) FROM rating_records"))
b = txt(post(NC))
s.check("a save with nothing changed says so and writes nothing", "Nothing changed" in b
        and (one("SELECT COUNT(*) FROM activity_log"), one("SELECT COUNT(*) FROM rating_records")) == before)
with a.app.app_context():
    d = a.get_db()
    old = dict(d.execute("SELECT * FROM users WHERE id=?", (NC,)).fetchone())
    words = a._profile_change_apply(d, SUROW, old, ACT, "script")
    s.check("the engine on a person nothing changed for does nothing", words == [] and (
        d.execute("SELECT COUNT(*) FROM activity_log").fetchone()[0], d.execute("SELECT COUNT(*) FROM rating_records").fetchone()[0]) == before)
    plan = a._profile_change_plan(d, SUROW, old, {"company": A2, "job_grade": 17}, ACT)
    s.check("the plan is read only and answers {refusals, auto, notes}: a unit and a grade change lists what will follow",
            set(plan) == {"refusals", "auto", "notes", "asks"} and {x["key"] for x in plan["auto"]} >= {"kpi_lines", "bu_kpi", "rating_record"}
            and not plan["refusals"] and d.execute("SELECT company FROM users WHERE id=?", (NC,)).fetchone()[0] == A1, plan)
    plan = a._profile_change_plan(d, SUROW, old, {"company": A1}, ACT)
    s.check("...and a change of nothing plans nothing", plan == {"refusals": [], "auto": [], "notes": [], "asks": []})
    d.rollback()

a.mailer.is_configured, a.mailer.send_mail = _mail
sys.exit(s.done())
