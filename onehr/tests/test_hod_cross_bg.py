"""HOD across business groups: open to every person (Chris, 2026-11-09: "Open to all").

From 29 Oct the super admin had to allow each person first (users.hod_any_bg_at / _by, the person page's Roles panel). That
allowance is retired: any active person may be made HOD of people in another business group. The rule lives in one place,
_hod_candidate_error, so the Leaders page, the person page and the People (roster) import all follow it: the super admin may pick
anyone (not a leaver, an admin account or a demo login); a BG or unit admin stays inside the group and units they manage, and the
refusal names nobody.

The two columns stay (the schema is additive; old allowances keep their stamp and nothing reads it), the audit labels stay so old
rows still read, and what used to flag a cross-group HOD as a problem (the Needs attention row, the `hod_other_group` data check,
the roster quality step's "keeps an HOD of the old group") is gone.

Everything is synthetic (ZZXB-*) and removed at the end.
"""
import html as _html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("HOD across business groups -- open to every person; a BG admin stays inside their scope")

BGA_, BGB_, BGC_ = "ZZXB Alpha Group", "ZZXB Beta Group", "ZZXB Gamma Group"
CA, CB, CC = "ZZXB Unit A", "ZZXB Unit B", "ZZXB Unit C"
REFUSED = "Someone from another business group can only be picked by the super admin"
OLD_REFUSED = "can span business units, but not business groups"
LINES = "/admin/users/%d/lines"


def _cleanup(d):
    ids = [r[0] for r in d.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZXB-%' OR username LIKE 'zzxb_%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        d.execute("UPDATE users SET hod_id=NULL WHERE hod_id IN (%s)" % ph, ids)
        d.execute("UPDATE users SET manager_id=NULL WHERE manager_id IN (%s)" % ph, ids)
        d.execute("DELETE FROM rating_records WHERE subject_id IN (%s)" % ph, ids)
        d.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        d.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    d.execute("DELETE FROM org_units WHERE business_group LIKE 'ZZXB%'")
    d.execute("DELETE FROM admin_role_access WHERE role_id IN (SELECT id FROM admin_roles WHERE name LIKE 'ZZXB%')")
    d.execute("DELETE FROM admin_roles WHERE name LIKE 'ZZXB%'")
    d.commit()


with a.app.app_context():
    d = a.get_db()
    _cleanup(d)
    for b, c in ((BGA_, CA), (BGB_, CB), (BGC_, CC)):
        d.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (b, c))

    def person(eid, name, bg, co, dept="Finance", left=None, role="user", demo=0, hod=None, admin_bg=None, sysadm=0):
        return d.execute(
            "INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, "
            "department, job_grade, confirmation_date, left_at, is_demo, hod_id, admin_bg, is_system_admin) "
            "VALUES (?,?,'x',?,?,?,?,?,'20','2020-01-01',?,?,?,?,?)",
            (eid.lower().replace("-", "_") if role == "admin" else eid.lower(), name, role,
             None if role == "admin" else eid, bg, co, dept, left, demo, hod, admin_bg, sysadm)).lastrowid

    XH = person("ZZXB-XH", "ZZ XB Candidate", BGA_, CA, "Management")      # the person who may be allowed
    A1 = person("ZZXB-A1", "ZZ XB Ownperson", BGA_, CA, hod=XH)            # their own group's person
    Y1 = person("ZZXB-Y1", "ZZ XB Yone", BGB_, CB)
    Y2 = person("ZZXB-Y2", "ZZ XB Ytwo", BGB_, CB)
    Y3 = person("ZZXB-Y3", "ZZ XB Ythree", BGB_, CB, "Ops")
    Y4 = person("ZZXB-Y4", "ZZ XB Yfour", BGB_, CB, "Sales")
    Y5 = person("ZZXB-Y5", "ZZ XB Yfive", BGB_, CB, "Support")             # never given an HOD: the BG admin's refusals are tried on them
    Q1 = person("ZZXB-Q1", "ZZ XB Qone", BGC_, CC)
    OWN_B = person("ZZXB-OWNB", "ZZ XB Ownhodb", BGB_, CB, "Management")   # an HOD inside Beta
    OWN_C = person("ZZXB-OWNC", "ZZ XB Ownhodc", BGC_, CC, "Management")   # an HOD inside Gamma
    LEFTP = person("ZZXB-LEFT", "ZZ XB Leaver", BGA_, CA, left="2026-01-01")
    DEMOP = person("ZZXB-DEMO", "ZZ XB Demo", BGA_, CA, demo=1)
    SYSP = person("ZZXB-SYSP", "ZZ XB Sysperson", BGA_, CA, sysadm=1)       # a person row carrying the system flag
    SUP = person("ZZXB-SUP", "ZZ XB Super", None, None, role="admin")
    SYSA = person("ZZXB-SYSA", "ZZ XB Sysadmin", None, None, role="admin", sysadm=1)
    BGADM = person("ZZXB-BGA", "ZZ XB Betaadmin", BGB_, None, role="admin", admin_bg=BGB_)
    # a BG admin whose role CAN change HODs (Assign HODs, Change a person's HOD): the control that the refusals below are
    # the rule's, not a missing tick's
    ROLE = d.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZXB role', 'group')").lastrowid
    d.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)",
                  [(ROLE, i) for i in ("people.read", "people.hod", "leaders.read", "leaders.hod")])
    d.execute("UPDATE users SET admin_role_id=? WHERE id=?", (ROLE, BGADM))
    d.commit()
    CID = a.active_cycle_id(d)
    SUPROW = dict(d.execute("SELECT * FROM users WHERE id=?", (SUP,)).fetchone())

cS = H.client_as(a, SUP)
cSys = H.client_as(a, SYSA)
cB = H.client_as(a, BGADM)


def one(sql, *args):
    return H.one(a, sql, args)


def flag(uid):
    return one("SELECT hod_any_bg_at FROM users WHERE id=?", uid)


def hod_of(uid):
    return one("SELECT hod_id FROM users WHERE id=?", uid)


def logged(action, uid):
    return one("SELECT COUNT(*) FROM activity_log WHERE action=? AND target_user_id=?", action, uid)


def txt(r):
    return _html.unescape(r.get_data(as_text=True))


def lines(c, pid, **kw):
    kw.setdefault("csrf_token", "tok")
    return c.post(LINES % pid, data=kw, follow_redirects=True)


def hods():
    return {r[0]: r[1] for r in H.rows(a, "SELECT id, hod_id FROM users WHERE employee_id LIKE 'ZZXB-%'")}


def person_page(c, uid):
    r = c.get("/admin/users/%d" % uid)
    return r.status_code, txt(r)


def apply_on_page(c, uid, hod_eid):
    """The person page's Change HOD, both steps: preview, then apply with its fingerprint (and its ticks, if asked)."""
    r = lines(c, uid, action="hod_preview", hod_eid=hod_eid)
    body = r.get_data(as_text=True)
    m = re.search(r'name="fingerprint" value="([0-9a-f]+)"', body)
    if not m:
        return r
    data = {"action": "hod_apply", "hod_eid": hod_eid, "uid": str(uid), "fingerprint": m.group(1),
            "ack": "1", "override_reason": "ZZXB test"}
    return lines(c, uid, **data)


def dbg(bg):
    with a.app.test_request_context("/"):
        return a.display_bg(bg) or bg



with a.app.app_context():
    d = a.get_db()
    ucols = {r[1] for r in d.execute("PRAGMA table_info(users)")}

# a person who still holds the old allowance (stamped 29 Oct-style): nothing may read it any more
with a.app.app_context():
    d = a.get_db()
    LEG = person("ZZXB-LEG", "ZZ XB Legacy", BGA_, CA, "Management")
    d.execute("UPDATE users SET hod_any_bg_at='2026-10-29 01:00:00', hod_any_bg_by=? WHERE id=?", (SUP, LEG))
    d.commit()

# ---------------------------------------------------------------------------------------------------------------------
s.section("storage: the columns stay, the switch and everything that read it are gone")
_src = H.source(a)
# the line follow-through's registry (LINE_COPY_COLUMNS, 2026-11-13) names users.hod_any_bg_by as a column nobody acts on: that one line is not a read
_src = re.sub(r'"users\.hod_any_bg_by": \([^\n]*\n', "", _src)
s.check("users.hod_any_bg_at and hod_any_bg_by still exist (additive schema: never dropped)",
        {"hod_any_bg_at", "hod_any_bg_by"} <= ucols)
s.check("...in the SCHEMA text and in _ensure_runtime_schema's guarded ALTER",
        "hod_any_bg_at TEXT," in _src and '"hod_any_bg_at" not in ucols' in _src and '"hod_any_bg_by" not in ucols' in _src)
s.check("hod_any_bg(), _hod_xbg_apply and _hod_heads_elsewhere no longer exist",
        not any(hasattr(a, n) for n in ("hod_any_bg", "_hod_xbg_apply", "_hod_heads_elsewhere")))
s.check("nothing in the app reads or writes hod_any_bg_*: the name appears only in the SCHEMA text (2 columns) and the ALTER guard (2 x 2)",
        len(re.findall(r"hod_any_bg_(?:at|by)", _src)) == 6 and "hod_any_bg(" not in _src and "hod_xbg" not in
        _src.replace('"hod_xbg_allow"', "").replace('"hod_xbg_off"', ""), len(re.findall(r"hod_any_bg_(?:at|by)", _src)))
s.check("a new person starts with no stamp, as ever", one("SELECT hod_any_bg_at FROM users WHERE id=?", XH) is None)
s.check("the removed actions are not in the access map, and the page's access row for them is gone",
        not {"hod_xbg_allow", "hod_xbg_off"} & set(a.ADMIN_ACCESS_MAP["admin_person_lines"]["map"])
        and not any("across business groups" in x.lower() for x in a.ADMIN_SUPER_ROWS["leaders"]))
s.check("...but the audit labels stay, so the 29 Oct-9 Nov audit rows still read",
        a.ACTION_LABELS.get("hod_xbg_allow") == "Allowed someone to be HOD across business groups"
        and a.ACTION_LABELS.get("hod_xbg_off") == "Turned off someone's HOD across business groups")
css = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "style.css")).read()
s.check("the switch's CSS (.pp-xbg*) is gone with it", "pp-xbg" not in css)

# ---------------------------------------------------------------------------------------------------------------------
s.section("the Roles panel: no switch, for anyone")
for who, c_, uid_ in (("the super admin", cS, XH), ("the super admin, on someone who holds an old allowance", cS, LEG),
                      ("the system admin", cSys, XH)):
    code, pg = person_page(c_, uid_)
    raw = c_.get("/admin/users/%d" % uid_).get_data(as_text=True)
    s.check("%s sees no 'Across business groups' box, Allow / Turn off, or note" % who,
            code == 200 and 'id="hod-xbg"' not in raw and "Across business groups" not in pg and "pp-xbg" not in raw
            and 'value="hod_xbg_allow"' not in raw and 'value="hod_xbg_off"' not in raw
            and "head departments in other business groups" not in pg and "Super admin only. When allowed" not in pg, code)
code, pg = person_page(cS, XH)
s.check("...the HOD row is still there, with its Departments link", code == 200 and "<b>HOD</b>" in pg and "Departments ›" in pg, code)

# ---------------------------------------------------------------------------------------------------------------------
s.section("the removed actions change nothing")
b0, nlog = hods(), one("SELECT COUNT(*) FROM activity_log WHERE action IN ('hod_xbg_allow', 'hod_xbg_off')")
for act in ("hod_xbg_allow", "hod_xbg_off"):
    r = cS.post(LINES % XH, data={"csrf_token": "tok", "action": act})
    s.check("a super admin posting %s gets a 400 (no such action) and nothing is written" % act,
            r.status_code == 400 and flag(XH) is None and hods() == b0
            and one("SELECT COUNT(*) FROM activity_log WHERE action IN ('hod_xbg_allow', 'hod_xbg_off')") == nlog, r.status_code)
r = cSys.post(LINES % XH, data={"csrf_token": "tok", "action": "hod_xbg_allow"})
s.check("...the system admin too", r.status_code == 400 and flag(XH) is None, r.status_code)
r = cB.post(LINES % Y1, data={"csrf_token": "tok", "action": "hod_xbg_allow"})
s.check("...and a BG admin (nothing set on anyone)", r.status_code in (400, 403) and flag(Y1) is None, r.status_code)
s.check("the stamp the old allowance left on LEG is untouched (nobody clears or reads it)",
        one("SELECT hod_any_bg_at FROM users WHERE id=?", LEG) == "2026-10-29 01:00:00")

# ---------------------------------------------------------------------------------------------------------------------
s.section("the super admin: any active person, with no allowance set, on every path")
picks = [CB + "||finance"]


def leaders(c, **kw):
    kw.setdefault("csrf_token", "tok")
    return c.post("/admin/leaders", data=kw)


s.check("(fixture) XH has no allowance and heads people only in their own group", flag(XH) is None and hod_of(A1) == XH)
b0 = hods()
r = lines(cS, Y1, action="hod_preview", hod_eid="ZZXB-XH")
s.check("the person page previews an HOD from another business group (no refusal, nothing written yet)",
        REFUSED not in txt(r) and OLD_REFUSED not in txt(r) and "Make ZZ XB Candidate their HOD" in txt(r) and hods() == b0)
r = leaders(cS, action="hod_preview", bg=BGB_, hod_id=XH, scope="bg", dept=picks)
body = r.get_data(as_text=True)
got = {int(x) for x in re.findall(r'name="uid" value="(\d+)"', body)}
expect = {r_[0] for r_ in H.rows(a, "SELECT id FROM users WHERE business_group=? AND TRIM(LOWER(department))='finance' "
                                    "AND role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0 AND employee_id LIKE 'ZZXB-%'", (BGB_,))}
s.check("Leaders › HODs previews XH for Beta's finance people, the independent query's set",
        REFUSED not in txt(r) and got == expect and {Y1, Y2} <= got, (sorted(got), sorted(expect)))
fp = re.search(r'name="fingerprint" value="([0-9a-f]+)"', body).group(1)
b0 = hods()
r = leaders(cS, action="hod_apply", bg=BGB_, hod_id=XH, scope="bg", dept=picks, fingerprint=fp, ack="1",
            override_reason="ZZXB test", uid=[str(Y1), str(Y2)])
b1 = hods()
chg = {k for k in b1 if b1[k] != b0.get(k)}
s.check("apply writes hod_id for the ticked people and no one else", chg == {Y1, Y2} and b1[Y1] == XH and b1[Y2] == XH, chg)
s.check("...an audit row for each, and the summary on XH",
        logged("hod_assign", Y1) == 1 and logged("hod_assign", Y2) == 1 and logged("hod_assign_summary", XH) >= 1)
r = apply_on_page(cS, Y3, "ZZXB-XH")
s.check("the person page applies XH as Y3's HOD (preview, then apply)", hod_of(Y3) == XH, txt(r)[:0])
s.check("...logged the Leaders page's way", logged("hod_assign", Y3) == 1)
s.check("...and XH still has no allowance: none was needed", flag(XH) is None)
with a.app.test_request_context("/"):
    dd = a.get_db()
    sup_row = dd.execute("SELECT * FROM users WHERE id=?", (SUP,)).fetchone()
    sys_row = dd.execute("SELECT * FROM users WHERE id=?", (SYSA,)).fetchone()
    err_ok = a._roster_leader_error(dd, sup_row, dd.execute("SELECT * FROM users WHERE id=?", (Y4,)).fetchone(), BGB_, None,
                                    "ZZXB-XH")
    chk = a._roster_check(dd, sup_row, [{"employee id": "ZZXB-Y4", "employee name": "ZZ XB Yfour",
                                         "business group": BGB_, "company": CB, "hod": "ZZXB-XH"}], False)
    look_keys = {k for k, _w, _y in a._RQ_LOOK}
s.check("the People import loads it: no HOD error for the row", err_ok is None
        and not [e for e in chk["errors"] if "HOD" in e["why"]], (err_ok, chk["errors"][:2]))
with a.app.test_request_context("/"):
    dd = a.get_db()
    a._roster_apply(dd, dd.execute("SELECT * FROM users WHERE id=?", (SUP,)).fetchone(), chk)
s.check("...applying the file writes hod_id, and nothing is held or counted as refused", hod_of(Y4) == XH)
with a.app.test_request_context("/"):
    dd = a.get_db()
    po = {}
    chk2 = a._roster_check(dd, sup_row, [{"employee id": "ZZXB-Q1", "employee name": "ZZ XB Qone", "business group": BGC_,
                                          "company": CC, "hod": "ZZXB-XH"}], False)
    a._roster_apply(dd, sup_row, chk2, prof_out=po)
s.check("a file naming XH as the HOD of a third group's person loads too (prof_out has no refusal)",
        hod_of(Q1) == XH and not po.get("hod_refused") and not chk2["errors"], (chk2["errors"][:1], po))
with a.app.test_request_context("/"):
    dd = a.get_db()
    s.check("the rule itself: the super admin, the system admin and a super-admin pick of another group are all None",
            a._hod_candidate_error(dd, sup_row, BGB_, dd.execute("SELECT * FROM users WHERE id=?", (XH,)).fetchone()) is None
            and a._hod_candidate_error(dd, sys_row, BGB_, dd.execute("SELECT * FROM users WHERE id=?", (XH,)).fetchone()) is None
            and a._hod_candidate_error(dd, sup_row, BGC_, dd.execute("SELECT * FROM users WHERE id=?", (LEG,)).fetchone()) is None)
    s.check("...an HOD in the same group passes as ever",
            a._hod_candidate_error(dd, sup_row, BGB_, dd.execute("SELECT * FROM users WHERE id=?", (OWN_B,)).fetchone()) is None)

# ---------------------------------------------------------------------------------------------------------------------
s.section("still refused for the super admin: a leaver, a demo login, an admin account, nobody")
with a.app.test_request_context("/"):
    dd = a.get_db()
    ge = lambda uid_: a._hod_candidate_error(dd, sup_row, BGA_, dd.execute("SELECT * FROM users WHERE id=?", (uid_,)).fetchone())  # noqa: E731
    s.check("a leaver ('has left'), a demo login, an admin account and a system admin's row are refused; so is nobody",
            "has left" in (ge(LEFTP) or "") and ge(DEMOP) == "Pick a person from the list." and ge(SYSA) == "Pick a person from the list."
            and ge(SUP) == "Pick a person from the list." and a._hod_candidate_error(dd, sup_row, BGA_, None) == "Pick a person from the list.")
b0 = hods()
r = lines(cS, Y1, action="hod_preview", hod_eid="ZZXB-LEFT")
s.check("the person page refuses a leaver as HOD, nothing written", "has left" in txt(r) and hods() == b0)
r = lines(cS, Y1, action="hod_preview", hod_eid="ZZXB-DEMO")
s.check("...and a demo login", "Pick a person from the list." in txt(r) and hods() == b0)
r = leaders(cS, action="hod_apply", bg=BGB_, hod_id=LEFTP, scope="bg", dept=picks, fingerprint="x", ack="1", uid=[str(Y1)])
s.check("Leaders › HODs refuses a leaver too: nothing written", "has left" in txt(r) and hods() == b0)
with a.app.test_request_context("/"):
    dd = a.get_db()
    s.check("the People import refuses a leaver as HOD", (a._roster_leader_error(
        dd, sup_row, dd.execute("SELECT * FROM users WHERE id=?", (Y1,)).fetchone(), BGB_, None, "ZZXB-LEFT") or "").startswith("HOD: "))

# ---------------------------------------------------------------------------------------------------------------------
s.section("a BG admin still stays inside their own scope, and the refusal names nobody")
b0 = hods()
r = lines(cB, Y5, action="hod_preview", hod_eid="ZZXB-XH")
s.check("on the person page: refused in the new words, nothing written", REFUSED in txt(r) and OLD_REFUSED not in txt(r)
        and hods() == b0 and hod_of(Y5) is None)
s.check("...and the page names nobody (the HOD they typed is not read back)", "ZZ XB Candidate" not in txt(r), "")
r = leaders(cB, action="hod_preview", bg=BGB_, hod_id=XH, scope="bg", dept=picks)
_fl = re.findall(r'class="flash[^"]*"[^>]*>(.*?)</div>', r.get_data(as_text=True), re.S)
s.check("on Leaders › HODs (preview): refused, and the refusal itself names nobody (the page lists XH only as the HOD they "
        "already are, from Beta's own people)", REFUSED in txt(r) and bool(_fl) and not any("ZZ XB" in x for x in _fl)
        and 'name="fingerprint"' not in r.get_data(as_text=True), _fl[:1])
r = leaders(cB, action="hod_apply", bg=BGB_, hod_id=XH, scope="bg", dept=picks, fingerprint="x", ack="1", uid=[str(Y5)])
s.check("...and apply writes nothing", hods() == b0 and hod_of(Y5) is None)
r = lines(cB, Y5, action="hod_preview", hod_eid="ZZXB-LEG")
s.check("an old allowance gives a BG admin nothing: someone holding the stamp is refused for them too",
        REFUSED in txt(r) and hods() == b0)
with a.app.test_request_context("/"):
    dd = a.get_db()
    bga_row = dd.execute("SELECT * FROM users WHERE id=?", (BGADM,)).fetchone()
    err_b = a._roster_leader_error(dd, bga_row, dd.execute("SELECT * FROM users WHERE id=?", (Y5,)).fetchone(), BGB_, None,
                                   "ZZXB-XH")
    msg_sc = a._hod_candidate_error(dd, bga_row, BGB_, dd.execute("SELECT * FROM users WHERE id=?", (XH,)).fetchone())
    own_ok = a._hod_candidate_error(dd, bga_row, BGB_, dd.execute("SELECT * FROM users WHERE id=?", (OWN_B,)).fetchone())
    crafted = a._hod_candidate_error(dd, bga_row, BGB_, dd.execute("SELECT * FROM users WHERE id=?", (Q1,)).fetchone())
s.check("in the People import the same words reach a BG admin", err_b and err_b.startswith("HOD: ") and REFUSED in err_b, err_b)
s.check("the scope refusal comes first and names nobody", msg_sc and "ZZ XB" not in msg_sc and REFUSED in msg_sc
        and crafted == msg_sc, (msg_sc, crafted))
s.check("control: the same BG admin still picks an HOD in their own group", own_ok is None)
r = cB.post(LINES % Y1, data={"csrf_token": "tok", "action": "hod_preview", "hod_eid": "ZZXB-OWNB"})
s.check("...on the person page too", r.status_code in (200, 302), r.status_code)

# ---------------------------------------------------------------------------------------------------------------------
s.section("a cross-group HOD is no longer a problem anywhere")
code, pg = person_page(cS, Y3)
s.check("Needs attention: Y3's page (their HOD, XH, is in another group) has no 'HOD is in another business group' row",
        code == 200 and "Their HOD is in another business group" not in pg and "an HOD must be in their own" not in pg
        and hod_of(Y3) == XH, code)
s.check("the hod_other_group data check is gone from the registry",
        "hod_other_group" not in a.DATA_CHECKS_BY_KEY and "hod_other_group" not in {c_["key"] for c_ in a.DATA_CHECKS})
s.check("...and the roster quality step has no 'keeps an HOD of the old group' row", "hod_other_bg" not in look_keys)
rows = [x for x in H.rows(a, "SELECT 1 FROM users WHERE employee_id LIKE 'ZZXB-%' AND hod_id IS NOT NULL")]
s.check("(fixture) the cross-group links exist for those checks to have fired on", len(rows) >= 5, len(rows))

# ---------------------------------------------------------------------------------------------------------------------
s.section("the Roles panel counts the split; Lock status names every group of a cross-group HOD")
with a.app.app_context():
    d = a.get_db()
    by_bg = [(r_[0], r_[1]) for r_ in d.execute("SELECT business_group, COUNT(*) FROM users WHERE hod_id=? AND role!='admin' "
                                                "AND left_at IS NULL GROUP BY business_group", (XH,))]
n_all = sum(n for _b, n in by_bg)
code, pg = person_page(cS, XH)
split = ", ".join("%d in %s" % (n, dbg(b)) for b, n in sorted(by_bg, key=lambda x: (x[0] != BGA_, x[0])))
s.check("the HOD row names the split across groups: 'heads N: n in <group>, ...' (the independent query's numbers)",
        "heads %d: %s" % (n_all, split) in pg and len(by_bg) == 3, (n_all, split))
code, pg1 = person_page(cS, A1)
s.check("a person who heads nobody reads 'not an HOD', not a split",
        "not an HOD" in pg1 and "heads " not in pg1[pg1.find("<b>HOD</b>"): pg1.find("<b>HOD</b>") + 200])
with a.app.test_request_context("/"):
    dd = a.get_db()
    cyc = a.active_cycle(dd)
    rws = [r_ for r_ in a._calib_lock_scopes(dd, dd.execute("SELECT * FROM users WHERE id=?", (SUP,)).fetchone(), cyc)
           if r_["tier"] == "hod" and r_["key"] == str(XH)]
want = sorted(b for b, _n in by_bg)
row = rws[0] if rws else {}
s.check("XH's HOD row exists, keyed on their id as before (the lock key is untouched)", len(rws) == 1 and row["key"] == str(XH), rws)
s.check("...it lists every group their people are in, in one line, not the alphabetically first",
        row and row["bgs"] == want and row["sub"] == " · ".join(dbg(b) for b in want) and row["bg"] == want[0], row and (row["bgs"], row["sub"]))
s.check("...and the count is all their people", row and row["n"] >= 1)
page = cS.get("/admin/calibration/locks?bg=%s" % BGB_)
s.check("the Lock status page filtered to one of their groups still lists the row",
        page.status_code == 200 and "ZZ XB Candidate" in page.get_data(as_text=True), page.status_code)

# ---------------------------------------------------------------------------------------------------------------------
s.section("the page compiles and the suite leaves nothing behind")
_n, broken = H.every_template_compiles(a)
s.check("every template compiles, person/_overview.html included", not broken, broken)
with a.app.app_context():
    _cleanup(a.get_db())
s.check("nothing this suite made is left behind",
        one("SELECT COUNT(*) FROM users WHERE employee_id LIKE 'ZZXB-%' OR username LIKE 'zzxb_%'") == 0
        and one("SELECT COUNT(*) FROM org_units WHERE business_group LIKE 'ZZXB%'") == 0
        and one("SELECT COUNT(*) FROM admin_roles WHERE name LIKE 'ZZXB%'") == 0)
sys.exit(s.done())
