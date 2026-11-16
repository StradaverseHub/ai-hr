"""The admin review's clear-cut bugs (2026-10-13): four Sonnet reviewers went through every admin page as a super admin,
a BG admin and a unit sub-admin, and these needed no design decision.

  * a cycle with a half but no year took the admin Home down (pm_idp_plan_year divided by nothing)
  * the Reports page's 360 PDF answered 400 for every admin (it needs a business group and units first)
  * a BG admin's roster file could move a person out of another business group (matched by Employee ID alone)
  * the roster template's example rows were the first two real people, 15 values under 17 headings
  * Data integrity showed a unit sub-admin the whole business group, filtered after its 500-row cap, and its CSV
    was capped too, though the page says the CSV has every row
  * the super admin's Passwords and Clear panels modes never showed (their macros were imported without context)
  * the Calendar and the Dates cards showed "HOD · Department review" and "BU CEO · Calibration" twice
  * adding back a removed business unit kept it removed while saying "Added"
  * the roster import's leavers kept their pending assessments (and its returners didn't get theirs back), with no
    audit row on the person

Shares the suite database and puts back everything it changes.
"""
import csv
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Admin review fixes -- Home with no year, the 360 PDF, the roster import's scope and template, "
            "Data integrity's scope and cap, the mode switches, the calendar rows")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

SU, BGA, EMP = H.actors(a)
with a.app.app_context():
    db = a.get_db()
    SUB = db.execute("SELECT u.* FROM users u JOIN admin_companies c ON c.admin_id=u.id WHERE u.role='admin' "
                     "LIMIT 1").fetchone()
C_SU, C_BG = H.client_as(a, SU["id"]), H.client_as(a, BGA["id"])

# ---------------------------------------------------------------------------
s.section("a cycle started with a half but no year")
s.check("no plan year, rather than a TypeError", a.pm_idp_plan_year({"year": None, "half": 2}) is None
        and a.pm_idp_plan_year({"year": 2026, "half": 2}) == 2027 and a.pm_idp_plan_year(None) is None)
with a.app.app_context():
    db = a.get_db()
    acid = a.active_cycle_id(db)
    _y = db.execute("SELECT year, half FROM cycles WHERE id=?", (acid,)).fetchone()
    db.execute("UPDATE cycles SET year=NULL, half=2 WHERE id=?", (acid,))
    db.commit()
try:
    r = H.client_as(a, SU["id"]).get("/admin")
    s.check("...so the admin Home still opens (it answered 500 for every admin)", r.status_code == 200, r.status_code)
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycles SET year=?, half=? WHERE id=?", (_y["year"], _y["half"], acid))
        db.commit()

# ---------------------------------------------------------------------------
s.section("every download on the Reports page opens, for both admins")
import re  # noqa: E402
for who, c in (("super admin", C_SU), ("BG admin", C_BG)):
    # both tabs: On screen (the reports by level) and Data downloads (2026-10-19)
    page = c.get("/admin/reports/all").get_data(as_text=True) + c.get("/admin/reports/all?kind=data").get_data(
        as_text=True)
    hrefs = sorted(set(re.findall(r'href="(/admin/[^"#]+)"', page)))
    bad = [(h, c.get(h).status_code) for h in hrefs if "/export/" in h or h.startswith("/admin/reports")]
    bad = [x for x in bad if x[1] >= 400]
    s.check("%s: no download or report link answers an error (the 360 PDF answered 400)" % who, not bad, bad)
page = C_SU.get("/admin/reports/all").get_data(as_text=True)
s.check("the 360 report is reached through Results analysis, where its business group and units are picked (its "
        "own row, which only opened that page, went in the UI audit 2026-10-17)",
        'href="/admin/reports"' in page and "/admin/export/report.pdf" not in page)

# ---------------------------------------------------------------------------
s.section("the roster import changes only people inside the admin's own scope")
with a.app.app_context():
    db = a.get_db()
    other = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND business_group!=? "
                       "AND employee_id IS NOT NULL LIMIT 1", (BGA["admin_bg"],)).fetchone()
    my_co = db.execute("SELECT company FROM users WHERE business_group=? AND company IS NOT NULL AND company!='' "
                       "LIMIT 1", (BGA["admin_bg"],)).fetchone()[0]


def _csv(rows):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(a.ROSTER_COLUMNS)
    w.writerows(rows)
    return buf.getvalue().encode("utf-8")


def _upload(client, body, preview=True):
    data = {"csrf_token": "tok", "mode": "upsert", "file": (io.BytesIO(body), "roster.csv")}
    if preview:
        data["preview"] = "1"
    return client.post("/admin/import/roster", data=data, content_type="multipart/form-data", follow_redirects=True)


row = [other["employee_id"], "Moved By A File", BGA["admin_bg"], my_co, "", "", "", "", "", "", "", "", "", "", "",
       "", ""]
_r = _upload(H.client_as(a, BGA["id"]), _csv([row]), preview=False)
with a.app.app_context():
    after = a.get_db().execute("SELECT full_name, business_group, company FROM users WHERE id=?",
                               (other["id"],)).fetchone()
s.check("a BG admin can't import a roster at all (view only, 2026-10-19), and the person named is unchanged",
        _r.status_code == 403 and (after["full_name"], after["business_group"], after["company"])
        == (other["full_name"], other["business_group"], other["company"]),
        (after["business_group"], other["business_group"]))
s.check("...the super admin's scope holds everyone, so the check never refuses them",
        "if existing and not can_access(me, existing[\"business_group\"], existing[\"company\"]):" in H.source(a))

s.section("the roster template is a format example that matches nobody")
tpl = H.as_csv_text(C_BG.get("/admin/import/roster/template.csv"))
trows = list(csv.reader(io.StringIO(tpl)))
with a.app.app_context():
    real = {r[0] for r in a.get_db().execute("SELECT employee_id FROM users WHERE employee_id IS NOT NULL")}
s.check("every row is an EXAMPLE- row, with one value per heading, and no real Employee ID anywhere in it",
        trows[0] == a.ROSTER_COLUMNS and len(trows) >= 2
        and all(r_[0].startswith("EXAMPLE-") and len(r_) == len(a.ROSTER_COLUMNS) for r_ in trows[1:])
        and not any(v in real for r_ in trows[1:] for v in r_), trows[1:])
got = _upload(C_SU, tpl.encode("utf-8")).get_data(as_text=True)
s.check("...and uploading it unchanged is refused, by name", "an example row from the template" in got.lower())

# ---------------------------------------------------------------------------
s.section("Data integrity: the admin's own units, filtered before the cap, the CSV every row")
if SUB is not None:
    C_SUB = H.client_as(a, SUB["id"])
    with a.app.app_context():
        comps = set(a.admin_companies_of(dict(SUB)))
    with a.app.test_request_context("/"):
        from flask import session as _ss
        _ss["user_id"] = SUB["id"]
        db = a.get_db()
        leaks = []
        for chk in a.DATA_CHECKS:
            rows, _c = a.data_check_rows(db, dict(SUB), a.active_cycle_id(db), chk, cap=False)
            leaks += [(chk["key"], r_["bu"]) for r_ in rows if (r_["bu"] or "") not in comps]
    s.check("a unit sub-admin sees only their own units' findings (it listed the whole business group)", not leaks,
            leaks[:5])
else:
    s.note("no unit sub-admin in this database: the scope check is skipped")
with a.app.test_request_context("/"):
    db = a.get_db()
    cid = a.active_cycle_id(db)
    big = None
    for chk in a.DATA_CHECKS:
        n = len(a.data_check_rows(db, dict(SU), cid, chk, cap=False)[0])
        if n > 3 and (big is None or n > big[1]):
            big = (chk, n)
_cap = a.DATA_CHECK_ROW_CAP
a.DATA_CHECK_ROW_CAP = 3
try:
    if big:
        body = H.as_csv_text(C_SU.get("/admin/data-integrity?check=%s&format=csv" % big[0]["key"]))
        n_csv = len(list(csv.reader(io.StringIO(body)))) - 1
        s.check("the CSV is every row, whatever the page's cap (it stopped at the cap)", n_csv == big[1], (n_csv, big[1]))
        with a.app.test_request_context("/"):
            db = a.get_db()
            allrows = a.data_check_rows(db, dict(SU), cid, big[0], cap=False)[0]
            bg1 = next((r_["bg"] for r_ in reversed(allrows) if r_["bg"]), None)
            want = [r_["eid"] for r_ in allrows if r_["bg"] == bg1]
            page_rows = a.data_check_rows(db, dict(SU), cid, big[0], fbg=bg1)[0]
        s.check("...and a business group filter runs before the cap, so the page holds that group's first rows "
                "(it filtered what the cap had left)", [r_["eid"] for r_ in page_rows] == want[:3] and want,
                (len(page_rows), len(want)))
    else:
        s.note("no check with more than 3 findings in this database: the cap checks are skipped")
finally:
    a.DATA_CHECK_ROW_CAP = _cap

# ---------------------------------------------------------------------------
s.section("the mode switches read the page's context")
imp = C_SU.get("/admin/import/roster").get_data(as_text=True)
pan = C_SU.get("/admin/panels/build").get_data(as_text=True)
pan_bg = C_BG.get("/admin/panels/build").get_data(as_text=True)
s.check("the super admin's Import shows People | Passwords, and Panels shows Clear panels",
        'class="adm-modes"' in imp and "/admin/import/passwords" in imp and "/admin/clear-panels" in pan)
s.check("...a BG admin's Panels never links to Clear panels (super-only: it answered 403)",
        "/admin/clear-panels" not in pan_bg and "ask a super admin" in pan_bg)

# ---------------------------------------------------------------------------
s.section("the org master: adding back a removed unit brings it back")
_U = "ZZ Review Re-add Unit"
_act = lambda: H.one(a, "SELECT active FROM org_units WHERE business_group=? AND company=?", (BGA["admin_bg"], _U))
try:
    C_SU.post("/admin/org", data={"csrf_token": "tok", "action": "add_company", "business_group": BGA["admin_bg"],
                                  "company": _U})
    a1 = _act()
    C_SU.post("/admin/org", data={"csrf_token": "tok", "action": "remove_company", "business_group": BGA["admin_bg"],
                                  "old": _U})
    a2 = _act()
    C_SU.post("/admin/org", data={"csrf_token": "tok", "action": "add_company", "business_group": BGA["admin_bg"],
                                  "company": _U})
    a3 = _act()
    s.check("added, removed, added again: active again (it stayed removed while saying 'Added')",
            (a1, a2, a3) == (1, 0, 1), (a1, a2, a3))
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM org_units WHERE business_group=? AND company=?", (BGA["admin_bg"], _U))
        db.commit()

s.section("the roster import's leavers and returners go through the Users page's helpers")
if SUB is not None:
    with a.app.app_context():
        db = a.get_db()
        sub_co = sorted(a.admin_companies_of(dict(SUB)))[0]
        # the super admin imports (BG and unit admins are view only since 2026-10-19); an authoritative file's leavers
        # are the groups it names, so the file is this unit's whole business group
        unit = db.execute("SELECT * FROM users WHERE role='user' AND left_at IS NULL AND is_demo=0 AND business_group=? "
                          "ORDER BY company='%s' DESC, id" % sub_co.replace("'", "''"), (SUB["admin_bg"],)).fetchall()
        cid = a.active_cycle_id(db)
        # the one who "leaves": someone with a pending assessment, so the archive is visible
        gone = next((u_ for u_ in unit if db.execute(
            "SELECT 1 FROM assignments WHERE cycle_id=? AND archived=0 AND status!='submitted' AND "
            "(subject_id=? OR assessor_id=?)", (cid, u_["id"], u_["id"])).fetchone()), unit[-1])
        pend = db.execute("SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND archived=0 AND status!='submitted' "
                          "AND (subject_id=? OR assessor_id=?)", (cid, gone["id"], gone["id"])).fetchone()[0]

    def _row(u_):
        return [u_["employee_id"], u_["full_name"], u_["business_group"], u_["company"]] + [""] * 13
    C_SUB = H.client_as(a, SU["id"])
    body = _csv([_row(u_) for u_ in unit if u_["id"] != gone["id"]])
    H.import_steps(C_SUB, "/admin/import/roster", {"mode": "authoritative", "file": (io.BytesIO(body), "roster.csv")},
                   choose=("leave",))   # the super admin answers: mark the one the file leaves out as left
    with a.app.app_context():
        db = a.get_db()
        st1 = db.execute("SELECT left_at FROM users WHERE id=?", (gone["id"],)).fetchone()[0]
        arch = db.execute("SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND archived=1 AND archive_reason='left' "
                          "AND (subject_id=? OR assessor_id=?)", (cid, gone["id"], gone["id"])).fetchone()[0]
        log1 = db.execute("SELECT COUNT(*) FROM activity_log WHERE action='mark_left' AND target_user_id=?",
                          (gone["id"],)).fetchone()[0]
        others = db.execute("SELECT COUNT(*) FROM users WHERE id IN (%s) AND left_at IS NOT NULL"
                            % ",".join(str(u_["id"]) for u_ in unit if u_["id"] != gone["id"])).fetchone()[0]
    s.check("an authoritative file without someone marks them left, archives their pending assessments and writes "
            "their own audit row (a bare left_at did neither); everyone in the file stays",
            st1 and arch == pend and log1 >= 1 and others == 0, (st1, arch, pend, log1, others))
    H.import_steps(C_SUB, "/admin/import/roster", {"mode": "upsert", "file": (io.BytesIO(_csv([_row(gone)])), "roster.csv")})
    with a.app.app_context():
        db = a.get_db()
        st2 = db.execute("SELECT left_at FROM users WHERE id=?", (gone["id"],)).fetchone()[0]
        back = db.execute("SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND archived=1 AND archive_reason='left' "
                          "AND (subject_id=? OR assessor_id=?)", (cid, gone["id"], gone["id"])).fetchone()[0]
        log2 = db.execute("SELECT COUNT(*) FROM activity_log WHERE action='reactivate' AND target_user_id=?",
                          (gone["id"],)).fetchone()[0]
    s.check("...and a file that has them again brings them back with those assessments (it only cleared left_at)",
            st2 is None and back == 0 and log2 >= 1, (st2, back, log2))
else:
    s.note("no unit sub-admin in this database: the leaver checks are skipped")

# ---------------------------------------------------------------------------
s.section("the calendar's rows each name their axis")
cal = C_SU.get("/admin/cycle").get_data(as_text=True)
s.check("Department review of performance / of potential; Calibration of performance / of potential",
        all(w in cal for w in ("Department review of performance", "Department review of potential",
                               "Calibration of performance", "Calibration of potential")))

# ---------------------------------------------------------------------------
s.section("removing an admin closes the account and keeps what they did (Chris, 2026-10-13: \"1 yes\")")
with a.app.app_context():
    db = a.get_db()
    _co = db.execute("SELECT company FROM users WHERE business_group=? AND company IS NOT NULL AND company!='' LIMIT 1",
                     (BGA["admin_bg"],)).fetchone()[0]
C_SU.post("/admin/subadmins?bg=%s" % BGA["admin_bg"], data={"csrf_token": "tok", "action": "create",
                                                            "username": "zzrv-sub", "password": "zzrv-pass-1",
                                                            "companies": [_co]})
_aid = H.one(a, "SELECT id FROM users WHERE username='zzrv-sub'")
_C_old = H.client_as(a, _aid)
with a.app.app_context():
    db = a.get_db()
    a.log_activity(db, _aid, "zzrv_probe", "an action the removed admin took")
_n_before = H.one(a, "SELECT COUNT(*) FROM activity_log WHERE user_id=?", (_aid,))
C_SU.post("/admin/subadmins?bg=%s" % BGA["admin_bg"], data={"csrf_token": "tok", "action": "remove",
                                                            "admin_id": str(_aid)})
with a.app.app_context():
    _row = a.get_db().execute("SELECT username, left_at, role FROM users WHERE id=?", (_aid,)).fetchone()
_n_after = H.one(a, "SELECT COUNT(*) FROM activity_log WHERE user_id=?", (_aid,))
s.check("the account stays, closed (left_at) and its username freed; every audit row it wrote is still there "
        "(they cascaded away with the account)", _row is not None and _row["left_at"] and _row["role"] == "admin"
        and _row["username"] == "zzrv-sub~removed-%d" % _aid and _n_after == _n_before >= 1, (dict(_row or {}),
                                                                                             _n_before, _n_after))
_adm = C_SU.get("/admin/admins").get_data(as_text=True)   # (the removal's own flash names it once)
s.check("...the Admins page no longer lists it", 'name="admin_id" value="%d"' % _aid not in _adm
        and "zzrv-sub~removed" not in _adm)
_r = _C_old.get("/admin")
s.check("...a session it still had open ends on its next click", _r.status_code in (301, 302)
        and "/login" in _r.headers.get("Location", ""), (_r.status_code, _r.headers.get("Location")))
C_SU.post("/admin/subadmins?bg=%s" % BGA["admin_bg"], data={"csrf_token": "tok", "action": "create",
                                                            "username": "zzrv-sub", "password": "zzrv-pass-2",
                                                            "companies": [_co]})
_aid2 = H.one(a, "SELECT id FROM users WHERE username='zzrv-sub'")
s.check("...and the same username can be given to a new account", _aid2 and _aid2 != _aid, (_aid, _aid2))
with a.app.app_context():
    db = a.get_db()
    for _x in (_aid, _aid2):
        if _x:
            db.execute("DELETE FROM admin_companies WHERE admin_id=?", (_x,))
            db.execute("DELETE FROM users WHERE id=?", (_x,))
    db.commit()

# ---------------------------------------------------------------------------
s.section("a calibration group's membership holds still once its calls are locked (Chris, 2026-10-13: \"2 yes\")")
with a.app.app_context():
    db = a.get_db()
    _pid = a.active_pm_period(db)["id"]
    _ppl = [dict(r) for r in db.execute("SELECT id, employee_id FROM users WHERE role!='admin' AND left_at IS NULL "
                                        "AND employee_id IS NOT NULL AND id NOT IN (SELECT subject_id FROM "
                                        "pm_calibration_group_members) ORDER BY id LIMIT 4")]
    _gid = db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id, created_by) VALUES ('ZZRV group', ?, ?)",
                      (_ppl[0]["id"], SU["id"])).lastrowid
    for _p in _ppl[1:3]:
        db.execute("INSERT INTO pm_calibration_group_members(group_id, subject_id) VALUES (?,?)", (_gid, _p["id"]))
    _sid = db.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, "
                      "locked_at) VALUES (?, 'group', ?, '', 'ZZRV group', datetime('now'))", (_pid, str(_gid))).lastrowid
    db.commit()
_members = lambda: sorted(r[0] for r in H.rows(a, "SELECT subject_id FROM pm_calibration_group_members WHERE "
                                                  "group_id=?", (_gid,)))
_post = lambda **kw: C_SU.post("/admin/performance/calibration-groups",
                               data=dict({"csrf_token": "tok", "group_id": str(_gid)}, **kw), follow_redirects=True)
try:
    _m0 = _members()
    _d = _post(action="delete").get_data(as_text=True)
    _post(action="remove_member", subject_id=str(_ppl[1]["id"]))
    _post(action="add_member", employee_id=_ppl[3]["employee_id"])
    s.check("locked: no delete, no removal, no addition, and the page says why",
            H.one(a, "SELECT COUNT(*) FROM pm_calibration_groups WHERE id=?", (_gid,)) == 1 and _members() == _m0
            and "its calibration is locked" in _d, _members())
    _page = C_SU.get("/admin/performance/calibration-groups").get_data(as_text=True)
    _gblock = _page[_page.find("ZZRV group"):]
    s.check("...its page offers none of them", bool(re.search(r"Can(?:'|&#39;)t be deleted:\s+its calibration is "
                                                              r"locked", _page))
            and "Locked for" in _gblock, None)
    _adds_locked = _page.count('admin-form gc-add"')
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE pm_calibration_sessions SET locked_at=NULL WHERE id=?", (_sid,))
        db.execute("INSERT INTO pm_group_locks(cycle_id, group_id, subject_id, band, locked_by) VALUES (?,?,?, 'ME', ?)",
                   (_pid, _gid, _ppl[1]["id"], _ppl[0]["id"]))
        db.commit()
    _adds_open = C_SU.get("/admin/performance/calibration-groups").get_data(as_text=True).count('admin-form gc-add"')
    s.check("...and offers adding again once the scope is unlocked", _adds_open == _adds_locked + 1,
            (_adds_locked, _adds_open))
    _post(action="remove_member", subject_id=str(_ppl[1]["id"]))
    _post(action="delete")
    _held = _members()
    _post(action="remove_member", subject_id=str(_ppl[2]["id"]))
    _post(action="add_member", employee_id=_ppl[3]["employee_id"])
    s.check("open, with one person's call locked: that person stays, the group can't be deleted; someone else can "
            "leave and someone new can join", _held == _m0 and _members() == sorted([_ppl[1]["id"], _ppl[3]["id"]])
            and H.one(a, "SELECT COUNT(*) FROM pm_calibration_groups WHERE id=?", (_gid,)) == 1, (_held, _members()))
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM pm_group_locks WHERE group_id=?", (_gid,))
        db.execute("DELETE FROM pm_calibration_sessions WHERE id=?", (_sid,))
        db.execute("DELETE FROM pm_calibration_group_members WHERE group_id=?", (_gid,))
        db.execute("DELETE FROM pm_calibration_groups WHERE id=?", (_gid,))
        db.commit()

# ---------------------------------------------------------------------------
s.section("the Talent Box's Special reward pin went with Reward (Chris, 2026-10-13: \"3 remove it\")")
_tb = open(os.path.join(H.HARNESS, "templates", "talent_box.html"), encoding="utf-8").read()
_w = [H.client_as(a, EMP["id"]).post(p_, data={"csrf_token": "tok"}).status_code
      for p_ in ("/talent-box/bg/ZZ/tag", "/talent-box/company/ZZ/Co/tag", "/talent-box/group/1/tag")]
s.check("no pin on the box, and its route answers a bare 404 (archived with Reward); the talent category stays",
        "tbox-tag-form" not in _tb and "special_reward" not in _tb and _w == [404, 404, 404]
        and a.archived_module_of("/talent-box/bg/ZZ/tag", "talent_box_bgceo_tag") == "reward"
        and "PIP/Improvement" in a.TALENT_CATEGORY_ORDER, _w)

sys.exit(s.done())
