"""Leader roles in admin -- the HOD of each department, the BU CEO of each BU, the BG CEO (2026-09-29, Chris).

  "to our admin page user management, we also need button for admin to update who is HOD, BUCEO, or BGCEO for each
   business group. For HOD, being assigned means they are head of the selected departments so we need a selection of
   the said business unit or business group (HOD can be cross BU within a BG), BUCEO is straightforward, they handle
   each BU, and BGCEO handles each BG"

HOD stays per person (users.hod_id): the page is a PREVIEWED bulk write. Asserts compare against independently written
queries and check DELTAS -- a full before/after snapshot of every hod_id, so a write that touches anyone it shouldn't
fails here. Its own synthetic business groups, so nothing depends on the suite database's roster.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()   # shares the suite database: it builds its own synthetic groups and cleans up after itself
s = H.Suite("Admin leader roles -- HOD by department, BU CEOs, BG CEOs")
SU, _BGA, _EMP = H.actors(a)
BG, BG2 = "ZZLR BG", "ZZLR OTHER BG"
CA, CB, CG = "ZZLR Alpha", "ZZLR Beta", "ZZLR Gamma"

with a.app.app_context():
    d = a.get_db()
    for b, c in ((BG, CA), (BG, CB), (BG2, CG)):
        d.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (b, c))

    def person(eid, co, dept, bg=BG, left=None, role="user", demo=0, hod=None):
        return d.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, "
                         "company, department, confirmation_date, left_at, is_demo, hod_id) VALUES (?,?,'x',?,?,?,?,?,"
                         "'2022-01-01',?,?,?)", (eid.lower(), "ZZ LR " + eid, role, eid, bg, co, dept, left, demo,
                                                hod)).lastrowid
    OLD = person("ZZLR-OLD", CA, "Management")
    X = person("ZZLR-X", CA, "Sales")
    P = {
        "fa1": person("ZZLR-FA1", CA, "Finance", hod=OLD), "fa2": person("ZZLR-FA2", CA, "finance ", hod=OLD),
        "fa3": person("ZZLR-FA3", CA, " Finance", hod=None),
        "sa1": person("ZZLR-SA1", CA, "Sales", hod=OLD), "fb1": person("ZZLR-FB1", CB, "Finance", hod=OLD),
        "fb2": person("ZZLR-FB2", CB, "Finance", hod=X), "ob1": person("ZZLR-OB1", CB, "Ops", hod=OLD),
        "lft": person("ZZLR-LFT", CA, "Finance", left="2026-01-01", hod=OLD),
        "dem": person("ZZLR-DEM", CA, "Finance", demo=1, hod=OLD),
        "gg1": person("ZZLR-GG1", CG, "Finance", bg=BG2, hod=OLD),
    }
    Z = person("ZZLR-Z", CG, "Finance", bg=BG2)
    LEFT_HOD = person("ZZLR-LEFTHOD", CA, "Sales", left="2026-01-01")
    DEMO_HOD = person("ZZLR-DEMOHOD", CA, "Sales", demo=1)
    # a BG admin of BG, and one of the other BG
    BGA = d.execute("INSERT INTO users(username, full_name, password_hash, role, admin_bg) VALUES "
                    "('zzlr_bga','ZZ LR BG admin','x','admin',?)", (BG,)).lastrowid
    d.commit()
    CID = a.active_cycle_id(d)


def hods():
    return {r[0]: r[1] for r in H.rows(a, "SELECT id, hod_id FROM users")}


def post(c, **data):
    data.setdefault("csrf_token", "tok")
    return c.post("/admin/leaders", data=data)


cS = H.client_as(a, SU["id"])
cB = H.client_as(a, BGA)
cE = H.client_as(a, P["fa1"])

s.section("access")
s.check("super admin opens the page", cS.get("/admin/leaders?bg=" + BG).status_code == 200)
r = cB.get("/admin/leaders")
s.check("a BG admin opens it, fixed to their own business group", r.status_code == 200 and BG in r.get_data(as_text=True))
s.check("...and asking for another business group is refused", cB.get("/admin/leaders?bg=" + BG2).status_code == 403)
s.check("an employee can't open it", cE.get("/admin/leaders").status_code in (302, 403))
s.check("anonymous is sent to log in", a.app.test_client().get("/admin/leaders").status_code == 302)
s.check("a write without the CSRF token is refused", cS.post("/admin/leaders", data={"action": "set_bgceo"}).status_code == 400)
s.check("Leaders is in the sidebar (the Users page's own button went with the review, canvas K4)",
        any(p_["ep"] == "admin_leaders" for t_ in a.ADMIN_SECTION_BY_KEY["leaders"]["tabs"] for p_ in t_["pages"]))

s.section("HODs, option A of the redesign (Chris, 2026-10-20)")
pg = cS.get("/admin/leaders?bg=%s&tab=hod&view=dept" % BG).get_data(as_text=True)   # By department (By HOD: test_hod_view)
s.check("the HOD tab opens on By HOD (Chris, 2026-10-21), By department one click away",
        'class="ld-cards"' in cS.get("/admin/leaders?bg=%s&tab=hod" % BG).get_data(as_text=True)
        or "Nobody heads a department" in cS.get("/admin/leaders?bg=%s&tab=hod" % BG).get_data(as_text=True))
s.check("the role tabs come first, then the business group as the kit's row under them (Chris: \"use back the BG "
        "selection row\"), never a menu beside the tabs",
        'role="tablist"' in pg and 'aria-label="Business group">' in pg and ">HODs<" in pg
        and pg.index('role="tablist"') < pg.index('class="admin-card adm-filters ld-bgrow"') and 'class="ld-bgpick"' not in pg)
_row = re.search(r'<section class="admin-card adm-filters ld-bgrow".*?</section>', pg, re.S)
_pills = re.findall(r'<a class="adm-frow-pill([^"]*)" href="([^"]*)"', _row.group(0) if _row else "")
s.check("...each group a link that keeps the HODs tab, this group lit",
        _pills and all("tab=hod" in h for _c, h in _pills) and any("is-on" in c_ for c_, _h in _pills), _pills[:3])
pgB = cB.get("/admin/leaders?tab=hod").get_data(as_text=True)
s.check("...a BG admin, fixed to their group, gets no group row", 'ld-bgrow' not in pgB and 'role="tablist"' in pgB)
js = open(os.path.join(H.REPO, "static", "admin.js"), encoding="utf-8").read()
s.check("the departments' box is the admin standard's 15 rows, re-measured on every view: the cap counts a row the "
        "page hides as not showing, and the page asks for it after each filter (Chris, 2026-10-20: \"when i select "
        "91 without an HOD, nothing appears\")",
        'r.style.display !== "none" && !r.hidden' in js and "window.onehrTableStandard(table)" in pg
        and '<div class="table-scroll">\n        <table class="admin-table no-auto-table" id="ld-dept-table">' in pg, None)
st = a._leader_hod_state
s.check("a department's state: no HOD, set, has left (wins), split between HODs or with some unassigned",
        st({"hods": [{"id": None, "left": False}]}) == "none" and st({"hods": [{"id": 5, "left": False}]}) == "set"
        and st({"hods": [{"id": 5, "left": True}, {"id": None, "left": False}]}) == "left"
        and st({"hods": [{"id": 5, "left": False}, {"id": None, "left": False}]}) == "split"
        and st({"hods": [{"id": 5, "left": False}, {"id": 6, "left": False}]}) == "split")
with a.app.test_request_context("/"):
    _db = a.get_db()
    _deps = a._leader_dept_map(_db, a.get_db().execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone(), BG)
    _units, _cov = a._leader_hod_units(_db, BG, _deps)
_todo = [u["todo"] > 0 for u in _units]
s.check("the units with something to fix come first, and the totals add up",
        _todo == sorted(_todo, reverse=True) and _cov["n_depts"] == len(_deps)
        and _cov["none"] + _cov["left"] + _cov["split"] + _cov["set"] == len(_deps), (_todo, _cov))
with a.app.test_request_context("/"):
    _u2, _c2 = a._leader_hod_units(a.get_db(), BG, [
        {"company": "ZZ AAA ALL SET", "n": 3, "hods": [{"id": 5, "left": False}]},
        {"company": "ZZ MMM ALL SET", "n": 2, "hods": [{"id": 6, "left": False}]},
        {"company": "ZZ ZZZ TO FIX", "n": 2, "hods": [{"id": None, "left": False}]}])
s.check("...a unit to fix leads even when A to Z would put it last",
        [u["company"] for u in _u2] == ["ZZ ZZZ TO FIX", "ZZ AAA ALL SET", "ZZ MMM ALL SET"]
        and _c2 == {"none": 1, "left": 0, "split": 0, "set": 2, "n_depts": 3, "n_people": 7, "n_units": 3},
        ([u["company"] for u in _u2], _c2))
s.check("every department is on the page with its state and its tick, every unit in the list",
        all(('data-ld-unit="%s"' % u["company"]) in pg for u in _units)
        and pg.count('class="ld-dept"') == len(_deps) and pg.count('name="dept" value=') == len(_deps)
        and ('data-ld-show="none"' in pg and "%d without an HOD" % _cov["none"] in pg))
s.check("the Assign panel names the HOD and sends the ticked departments to the preview",
        'data-panel="ld-assign"' in pg and 'name="hod_id"' in pg and "Preview who moves" in pg
        and 'name="action" value="hod_preview"' in pg)

s.section("person search")
j = cS.get("/admin/leaders/people?bg=%s&q=ZZ LR" % BG).get_json()["people"]
ids = [x["id"] for x in j]
s.check("the super admin's search finds active real people, the business group's own first",
        X in ids and Z in ids and ids.index(X) < ids.index(Z), ids[:5])
s.check("...never a leaver, a demo login or an admin",
        not {LEFT_HOD, DEMO_HOD, BGA, P["lft"], P["dem"]} & set(ids))
jb = cB.get("/admin/leaders/people?bg=%s&q=ZZ LR" % BG).get_json()["people"]
s.check("a BG admin's search stays inside their business group", jb and all(x["bg"] == BG for x in jb),
        sorted({x["bg"] for x in jb}))
s.check("a one-letter search returns nothing", cS.get("/admin/leaders/people?q=Z").get_json()["people"] == [])

s.section("HOD: the preview writes nothing, and picks exactly the right people")
picks = [CA + "||finance", CB + "||finance"]
before = hods()
writes = []
with a.app.app_context():
    a.get_db().set_trace_callback(lambda q: writes.append(q) if q.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE")) else None)
r = post(cS, action="hod_preview", bg=BG, hod_id=X, scope="bg", dept=picks)
with a.app.app_context():
    a.get_db().set_trace_callback(None)
html = r.get_data(as_text=True)
s.check("the preview is write-free", hods() == before and not [w for w in writes if "users" in w], writes[:3])
# independent rule: active, real, in BG, dept key finance, company in (CA, CB), not X, not already X
expect = {P["fa1"], P["fa2"], P["fa3"], P["fb1"]}
got = {int(x) for x in __import__("re").findall(r'name="uid" value="(\d+)"', html)}
s.check("it picks everyone in the ticked departments -- 'Finance', 'finance ' and ' Finance' are one department -- and "
        "leaves out a leaver, a demo login, the same department in another business group, and someone already theirs",
        got == expect, (sorted(got), sorted(expect)))
s.check("...and counts the one already reporting to them", "1 already report to them" in html)
fp = __import__("re").search(r'name="fingerprint" value="([0-9a-f]+)"', html).group(1)

s.section("HOD: apply writes exactly the ticked set, nothing else")
before = hods()
ticked = [P["fa1"], P["fa3"], P["fb1"]]    # fa2 unticked: keeps their own HOD
r = post(cS, action="hod_apply", bg=BG, hod_id=X, scope="bg", dept=picks, fingerprint=fp, ack="1",
         uid=[str(x) for x in ticked])
after = hods()
changed = {k for k in after if after[k] != before.get(k)}
s.check("exactly the ticked people now have X as HOD (cross-BU: both business units), nobody else changed",
        changed == set(ticked) and all(after[k] == X for k in ticked) and after[P["fa2"]] == OLD, (changed, r.status_code))
s.check("one audit row per person changed, targeting them, plus a summary on the new HOD",
        H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='hod_assign' AND target_user_id IN (?,?,?)", tuple(ticked)) == 3
        and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='hod_assign_summary' AND target_user_id=?", (X,)) == 1)
b0 = hods()
r = post(cS, action="hod_apply", bg=BG, hod_id=X, scope="bg", dept=picks, fingerprint=fp, ack="1", uid=[str(P["fa2"])])
s.check("a stale preview (the people changed since) writes nothing, and says so",
        hods() == b0 and "changed since your preview" in r.get_data(as_text=True), r.status_code)

s.section("HOD: who can be one, and where")
for bad, why in ((LEFT_HOD, "has left"), (DEMO_HOD, "a demo login"), (99999999, "unknown")):
    b0 = hods()
    post(cS, action="hod_preview", bg=BG, hod_id=bad, scope="bg", dept=picks)
    fp2 = "x"
    post(cS, action="hod_apply", bg=BG, hod_id=bad, scope="bg", dept=picks, fingerprint=fp2, ack="1",
         uid=[str(P["fa2"])])
    s.check("refused as HOD: someone who %s -- nothing written" % why, hods() == b0)
b0 = hods()
r = post(cB, action="hod_preview", bg=BG2, hod_id=Z, scope="bg", dept=[CG + "||finance"])
s.check("a BG admin can't act in another business group", r.status_code == 403 and hods() == b0, r.status_code)
# any person may be HOD across business groups now (Chris, 2026-11-09): the super admin's pick of the other group's person is
# not refused (test_hod_cross_bg covers every path), and the BG admin's scope is the only limit
with a.app.test_request_context("/"):
    _dd = a.get_db()
    _sup = _dd.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
    _zr = _dd.execute("SELECT * FROM users WHERE id=?", (Z,)).fetchone()
    s.check("...and the other group's person is a valid HOD pick for the super admin (the old per-person allowance is gone)",
            a._hod_candidate_error(_dd, _sup, BG, _zr) is None and _zr["business_group"] != BG)

s.section("HOD: calibration safety")
with a.app.app_context():
    d = a.get_db()
    d.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, locked_at, "
              "locked_by) VALUES (?, 'hod', ?, ?, 'x', datetime('now'), ?)", (CID, str(OLD), BG, SU["id"]))
    d.commit()
r = post(cS, action="hod_preview", bg=BG, hod_id=X, scope="bu", company=CA, dept=[CA + "||finance"])
html = r.get_data(as_text=True)
fp3 = __import__("re").search(r'name="fingerprint" value="([0-9a-f]+)"', html).group(1)
s.check("a person whose current HOD's department review is SUBMITTED shows as a blocker",
        "their current hod's department review is submitted (performance)" in __import__('html').unescape(html).lower())
b0 = hods()
post(cB, action="hod_apply", bg=BG, hod_id=X, scope="bu", company=CA, dept=[CA + "||finance"], fingerprint=fp3, ack="1",
     uid=[str(P["fa2"])])
s.check("...a BG admin can't apply it", hods() == b0)
post(cS, action="hod_apply", bg=BG, hod_id=X, scope="bu", company=CA, dept=[CA + "||finance"], fingerprint=fp3, ack="1",
     uid=[str(P["fa2"])])
s.check("...nor a super admin without a reason", hods() == b0)
post(cS, action="hod_apply", bg=BG, hod_id=X, scope="bu", company=CA, dept=[CA + "||finance"], fingerprint=fp3, ack="1",
     uid=[str(P["fa2"])], override_reason="The department moved to X on 1 Oct; the HOD will re-lock.")
s.check("...a super admin WITH a reason applies it, and the override is logged",
        hods()[P["fa2"]] == X and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='hod_assign_override'") == 1)
with a.app.app_context():
    a.get_db().execute("DELETE FROM pm_calibration_sessions WHERE scope_key=?", (str(OLD),)); a.get_db().commit()

s.section("HOD: the BG CEO's Talent Box lock, and a department review not submitted yet")
# sa1 (Alpha / Sales) still reports to OLD; X is in Alpha / Sales too, so X heads the rest of it
with a.app.app_context():
    d = a.get_db()
    d.execute("INSERT INTO talent_box_bu_locks(period_id, cycle_id, business_group, company, locked_by) VALUES "
              "(?,?,?,?,?)", (CID, CID, BG, CA, SU["id"]))
    d.commit()
r = post(cS, action="hod_preview", bg=BG, hod_id=X, scope="bu", company=CA, dept=[CA + "||sales"])
low = __import__('html').unescape(r.get_data(as_text=True)).lower()
s.check("a business unit the BG CEO has locked on the Talent Box blocks moving its people",
        "their business unit is locked on the bg ceo's talent box" in low and "zz lr zzlr-sa1" in low)
with a.app.app_context():
    d = a.get_db()
    d.execute("DELETE FROM talent_box_bu_locks WHERE business_group=?", (BG,))
    sid = d.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label) "
                    "VALUES (?, 'hod', ?, ?, 'x')", (CID, str(OLD), BG)).lastrowid
    d.execute("INSERT INTO pm_calibration_adjustments(session_id, subject_id, original_band, adjusted_band, "
              "adjusted_by) VALUES (?,?,'ME','ME',?)", (sid, P["sa1"], OLD))
    d.commit()
r = post(cS, action="hod_preview", bg=BG, hod_id=X, scope="bu", company=CA, dept=[CA + "||sales"])
low = __import__('html').unescape(r.get_data(as_text=True)).lower()
s.check("someone their HOD has already reviewed (review not submitted) is a warning, not a blocker",
        "1 person their current hod has already reviewed in a department review that isn't submitted yet" in low
        and "is submitted (" not in low and "locked on the bg ceo's talent box" not in low)
with a.app.app_context():
    d = a.get_db()
    d.execute("DELETE FROM pm_calibration_adjustments WHERE session_id=?", (sid,))
    d.execute("DELETE FROM pm_calibration_sessions WHERE id=?", (sid,))
    d.commit()

s.section("HOD: a blocker holds only for the people it is about (review, 2026-10-08)")
with a.app.app_context():
    d = a.get_db()
    SA2 = person("ZZLR-SA2", CA, "Sales")   # no HOD on file: nothing of theirs is locked
    d.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, locked_at, "
              "locked_by) VALUES (?, 'hod', ?, ?, 'x', datetime('now'), ?)", (CID, str(OLD), BG, SU["id"]))
    d.commit()
r = post(cS, action="hod_preview", bg=BG, hod_id=X, scope="bu", company=CA, dept=[CA + "||sales"])
fp4 = __import__("re").search(r'name="fingerprint" value="([0-9a-f]+)"', r.get_data(as_text=True)).group(1)
b0 = hods()
r = post(cS, action="hod_apply", bg=BG, hod_id=X, scope="bu", company=CA, dept=[CA + "||sales"], fingerprint=fp4,
         ack="1", uid=[])
s.check("Apply with nobody ticked says so and writes nothing",
        hods() == b0 and "Tick at least one person" in r.get_data(as_text=True))
r = post(cS, action="hod_apply", bg=BG, hod_id=X, scope="bu", company=CA, dept=[CA + "||sales"], fingerprint=fp4,
         ack="1", uid=[str(P["sa1"]), str(SA2)])
s.check("ticking the blocked person, with no reason, is refused (the super admin; BG admins are view only), nothing written",
        hods() == b0 and "Not applied" in r.get_data(as_text=True))
r = post(cS, action="hod_apply", bg=BG, hod_id=X, scope="bu", company=CA, dept=[CA + "||sales"], fingerprint=fp4,
         ack="1", uid=[str(SA2)])
after = hods()
s.check("...unticking them clears the blocker: only the unblocked one moves, no override logged",
        after[SA2] == X and after[P["sa1"]] == OLD and {k for k in after if after[k] != b0.get(k)} == {SA2}
        and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='hod_assign_override'") == 1, r.status_code)
with a.app.app_context():
    a.get_db().execute("DELETE FROM pm_calibration_sessions WHERE scope_key=? AND tier='hod'", (str(OLD),))
    a.get_db().commit()

s.section("HOD: the new HOD's department review is already closed")
# X heads fb1 in Beta; Beta's BU CEO locks performance -> X's whole department review is closed
with a.app.app_context():
    d = a.get_db()
    d.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, locked_at, "
              "locked_by) VALUES (?, 'buceo', ?, ?, 'x', datetime('now'), ?)", (CID, CB, BG, SU["id"]))
    d.commit()
r = post(cS, action="hod_preview", bg=BG, hod_id=X, scope="bu", company=CA, dept=[CA + "||sales"])
low = __import__('html').unescape(r.get_data(as_text=True)).lower()
s.check("moving people to an HOD whose review a locked unit has closed is a warning, naming why",
        "zz lr zzlr-x's department review is already closed (performance)" in low and "zzlr beta is locked by its bu ceo" in low,
        [l for l in low.split("\n") if "already closed" in l][:2])
with a.app.app_context():
    a.get_db().execute("DELETE FROM pm_calibration_sessions WHERE scope_key=? AND tier='buceo'", (CB,))
    a.get_db().commit()

s.section("HOD / CEO pickers: refusals name nobody out of scope, and an empty picker gets a message, not a 400")
r = post(cB, action="hod_preview", bg=BG, hod_id=Z, scope="bg", dept=picks)
body = r.get_data(as_text=True)
s.check("a BG admin who posts someone from another business group is refused (view only) and learns nothing about them",
        r.status_code == 403 and "ZZ LR ZZLR-Z" not in body, r.status_code)
r = post(cS, action="hod_preview", bg=BG, hod_id="", scope="bg", dept=picks)
s.check("Preview with nobody chosen: 'Pick a person from the list.' (200, not a bare 400)",
        r.status_code == 200 and "Pick a person from the list." in r.get_data(as_text=True), r.status_code)
r = cS.post("/admin/leaders", data={"csrf_token": "tok", "action": "set_buceo", "bg": BG, "company": CA,
                                    "person_id": "", "tab": "buceo"}, follow_redirects=True)
s.check("Save a BU CEO with nobody chosen: the same message", r.status_code == 200
        and "Pick a person from the list." in r.get_data(as_text=True), r.status_code)

s.section("BU CEO / BG CEO: one holder per unit")
with a.app.app_context():
    d = a.get_db()
    d.execute("UPDATE users SET buceo_bg=?, buceo_company=? WHERE id=?", (BG, CA, P["sa1"]))   # Y holds Alpha
    d.execute("UPDATE users SET buceo_bg=?, buceo_company=? WHERE id=?", (BG, CB, P["ob1"]))   # Z' holds Beta
    d.commit()
r = post(cB, action="set_buceo", bg=BG, company=CA, person_id=X, tab="buceo")
s.check("a BG admin can't assign a BU CEO, even in their own group (view only, Chris 2026-10-19)",
        r.status_code == 403 and H.one(a, "SELECT COALESCE(buceo_company,'') FROM users WHERE id=?", (X,)) != CA)
r = post(cS, action="set_buceo", bg=BG, company=CA, person_id=X, tab="buceo")
s.check("assigning X clears the previous holder; the other BU's CEO is untouched",
        H.one(a, "SELECT buceo_company FROM users WHERE id=?", (X,)) == CA
        and H.one(a, "SELECT buceo_company FROM users WHERE id=?", (P["sa1"],)) is None
        and H.one(a, "SELECT buceo_company FROM users WHERE id=?", (P["ob1"],)) == CB)
s.check("...both logged, each with its target",
        H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='set_buceo' AND target_user_id=?", (X,)) >= 1
        and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='clear_buceo' AND target_user_id=?", (P["sa1"],)) >= 1)
post(cS, action="set_buceo", bg=BG, company=CB, person_id=X, tab="buceo")
s.check("adding Beta keeps Alpha: X leads both, each locked on its own, and Beta's previous CEO is cleared "
        "(admin round 4: one BU CEO for several units)",
        sorted(r[0] for r in H.rows(a, "SELECT company FROM buceo_seats WHERE user_id=?", (X,))) == sorted([CA, CB])
        and H.one(a, "SELECT buceo_company FROM users WHERE id=?", (P["ob1"],)) is None)
post(cS, action="set_buceo", bg=BG, company=CB, person_id=X, tab="buceo", move="1")
s.check("'move them instead': X leads only Beta, Alpha left vacant",
        H.one(a, "SELECT buceo_company FROM users WHERE id=?", (X,)) == CB
        and H.one(a, "SELECT COUNT(*) FROM users WHERE buceo_company=?", (CA,)) == 0
        and H.one(a, "SELECT buceo_company FROM users WHERE id=?", (P["ob1"],)) is None)
for bad, why in ((LEFT_HOD, "has left"), (DEMO_HOD, "a demo login"), (BGA, "an admin")):
    post(cS, action="set_buceo", bg=BG, company=CA, person_id=bad, tab="buceo")
    s.check("refused as BU CEO: someone who is %s" % why, H.one(a, "SELECT COUNT(*) FROM users WHERE buceo_company=?", (CA,)) == 0)
post(cS, action="set_buceo", bg=BG, company="ZZLR Nowhere", person_id=P["fa1"], tab="buceo")
s.check("...and a business unit not in the org master", H.one(a, "SELECT buceo_company FROM users WHERE id=?", (P["fa1"],)) is None)
post(cS, action="clear_buceo", bg=BG, company=CB, tab="buceo")
s.check("Remove leaves the BU vacant", H.one(a, "SELECT COUNT(*) FROM users WHERE buceo_company=?", (CB,)) == 0)
post(cS, action="set_bgceo", bg=BG, target_bg=BG, person_id=P["fa1"], tab="bgceo")
post(cS, action="set_bgceo", bg=BG, target_bg=BG, person_id=X, tab="bgceo")
s.check("BG CEO: one per business group -- the previous holder is cleared",
        H.one(a, "SELECT bgceo_bg FROM users WHERE id=?", (X,)) == BG
        and H.one(a, "SELECT bgceo_bg FROM users WHERE id=?", (P["fa1"],)) is None)
r = post(cB, action="clear_bgceo", bg=BG, target_bg=BG, tab="bgceo")
s.check("...their group's BG admin can't remove it (view only, Chris 2026-10-19)",
        r.status_code == 403 and H.one(a, "SELECT bgceo_bg FROM users WHERE id=?", (X,)) == BG)
post(cS, action="set_bgceo", bg=BG, target_bg=BG, person_id=X, tab="bgceo")
cU = H.client_as(a, SU["id"])
cU.post("/admin/users", data={"csrf_token": "tok", "action": "set_bgceo", "user_id": P["fa2"], "bgceo_bg": BG})
s.check("the Users page no longer sets a CEO seat (Leaders and the person page do, the review 2026-10-10)",
        H.one(a, "SELECT bgceo_bg FROM users WHERE id=?", (P["fa2"],)) is None
        and H.one(a, "SELECT bgceo_bg FROM users WHERE id=?", (X,)) == BG)
post(cS, action="set_bgceo", bg=BG, target_bg=BG, person_id=P["fa2"], tab="bgceo")
s.check("...Leaders does it, one holder, logged",
        H.one(a, "SELECT bgceo_bg FROM users WHERE id=?", (P["fa2"],)) == BG
        and H.one(a, "SELECT bgceo_bg FROM users WHERE id=?", (X,)) is None
        and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='set_bgceo' AND target_user_id=?", (P["fa2"],)) >= 1)

s.section("renaming a business group or unit carries the leader roles")
with a.app.app_context():
    d = a.get_db()
    d.execute("UPDATE users SET buceo_bg=?, buceo_company=? WHERE id=?", (BG, CA, X)); d.commit()
cU.post("/admin/org", data={"csrf_token": "tok", "action": "rename_company", "business_group": BG, "old": CA, "new": CA + " Renamed",
                            "cascade": "1"})
s.check("rename a business unit (with cascade): its BU CEO follows", H.one(a, "SELECT buceo_company FROM users WHERE id=?", (X,)) == CA + " Renamed")
cU.post("/admin/org", data={"csrf_token": "tok", "action": "rename_bg", "old": BG, "new": BG + " RENAMED", "cascade": "1"})
s.check("rename a business group (with cascade): its BG CEO and BU CEOs follow",
        H.one(a, "SELECT bgceo_bg FROM users WHERE id=?", (P["fa2"],)) == BG + " RENAMED"
        and H.one(a, "SELECT buceo_bg FROM users WHERE id=?", (X,)) == BG + " RENAMED")

s.section("the page compiles and the URL map stays classified")
_n, broken = H.every_template_compiles(a)
s.check("every template compiles, admin_leaders.html included", not broken, broken)
_src = H.code_without_docstrings(H.source(a))
s.check("the Leaders page is under /admin (never module-gated) and admin-only",
        '@app.route("/admin/leaders", methods=["GET", "POST"])\n@admin_required' in _src
        and '@app.route("/admin/leaders/people")\n@admin_required' in _src)
s.section("cleanup -- the harness database is shared with the suites after this one")
with a.app.app_context():
    d = a.get_db()
    ids = [r[0] for r in d.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZLR-%' OR username='zzlr_bga'")]
    ph = ",".join("?" * len(ids))
    d.execute("UPDATE users SET hod_id=NULL WHERE hod_id IN (%s)" % ph, ids)
    d.execute("UPDATE users SET manager_id=NULL WHERE manager_id IN (%s)" % ph, ids)
    d.execute("DELETE FROM rating_records WHERE subject_id IN (%s)" % ph, ids)
    d.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
    d.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    d.execute("DELETE FROM org_units WHERE business_group LIKE 'ZZLR%'")
    d.commit()
s.check("nothing this suite made is left behind",
        H.one(a, "SELECT COUNT(*) FROM users WHERE employee_id LIKE 'ZZLR-%' OR username='zzlr_bga'") == 0
        and H.one(a, "SELECT COUNT(*) FROM org_units WHERE business_group LIKE 'ZZLR%'") == 0)
sys.exit(s.done())
