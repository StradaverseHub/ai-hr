"""Grade H Appraisal admin: leaders, picking several people, the download, a BG / BU admin's read view (2026-10-31; canvases A1, A1b,
A2, R1, R2, L1, approved by Chris 31 Oct: "BG / BU admins read Grade H progress; nobody but the super admin writes").

What this suite holds:
  * the Leaders line and the Show choice: the No HOD count is the rows whose HOD stage is off (a calibrator HOD, a person who is their
    own HOD and one whose HOD is their unit's BU CEO included); the no-BU-CEO unit count is right; the Show filters and the list panel
    return exactly those people; a zero reads in grey with no pill
  * the LEADERS column names the HOD and the BU CEO and flags a gap
  * the Release card: a unit with no BU CEO seated reads "Can't" and says why, with the link to Leaders
  * (further sections are added below, one a piece: bulk set, the download, Roles & access, a BG admin's view, the line manager's list)
Synthetic (ZZ9GL-*) on a fresh scratch database.
"""
import io
import os
import re
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Grade H Appraisal admin: leaders, bulk appraiser, download, a BG admin's view, no work email")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA0, EMP = H.actors(a)
PFX, BG, BG2 = "ZZ9GL-", "ZZGL Group", "ZZGL Other Group"
UA, UB, UC, UO = "ZZGL Unit A", "ZZGL Unit B", "ZZGL Unit C", "ZZGL Unit O"
U, P = {}, {}
_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
BASE = "/admin/gradeh"
import sqlite3  # noqa: E402

db = sqlite3.connect(a.DB_PATH, timeout=5.0)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")


def one(sql, args=()):
    r = db.execute(sql, args).fetchone()
    return r[0] if r else None


def run(fn):
    with a.app.test_request_context("/"):
        d = a.get_db()
        r = fn(d)
        d.commit()
        return r


def text(resp):
    h = resp.get_data(as_text=True)
    h = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", h)
    m = re.search(r'<main id="main"[\s\S]*', h)
    h = m.group(0) if m else h
    h = re.sub(r"<[^>]+>", " ", h)
    return " ".join(h.replace("&#39;", "'").replace("&amp;", "&").replace("&quot;", '"').replace("&rsaquo;", "›").split())


def csrf(**kw):
    d = {"csrf_token": "tok"}
    d.update(kw)
    return d


def utc(x):
    return x.strftime("%Y-%m-%d %H:%M:%S")


NOW = datetime.utcnow()


def mk(k, grade="H", hod=None, bg=BG, co=UA, dept="ZZGL Dept", mgr=None, email=True, role="user"):
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
        "job_grade, job_title, hod_id, manager_id, email, confirmation_date) VALUES (?,?, 'x', ?, ?,?,?,?,?, 'Driver', ?, ?, ?, '2020-01-01')",
        ((PFX + k).lower(), "ZZ GL " + k, role, PFX + k, bg, co, dept, grade, hod, mgr,
         (PFX + k).lower() + "@example.test" if email else None)).lastrowid


def person(k, route="B", **kw):
    pid = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route, hr_supervisor_name, appraiser_id, language) VALUES (?,?,?,?,?,?,?)",
                     (CID, PFX + k, U[k], route, kw.get("sup"), kw.get("appr"), "en")).lastrowid
    P[k] = pid
    return pid


def submit(k, ack=None):
    """A submitted Route B appraisal (ratings and answers written, the computed result stored)."""
    pid = P[k]
    for i, at in enumerate(a.GRADEH_ATTRIBUTES):
        db.execute("INSERT OR REPLACE INTO gradeh_ratings (cycle_id, person_id, attr_key, rating) VALUES (?,?,?,?)", (CID, pid, at["key"], 3))
    for lp in range(1, 8):
        for st in (1, 2):
            db.execute("INSERT OR REPLACE INTO gradeh_lp_answers (cycle_id, person_id, lp, stmt, answer) VALUES (?,?,?,?,?)",
                       (CID, pid, lp, st, "yes" if (lp + st) % 2 else "not_yet"))
    db.commit()
    c = run(lambda d: a.gradeh_computed(d, CID, pid))
    assert not c["problems"], c["problems"]
    db.execute("INSERT OR IGNORE INTO gradeh_appraisals (cycle_id, person_id) VALUES (?,?)", (CID, pid))
    db.execute("UPDATE gradeh_appraisals SET b_achievements='Demo a', b_strengths='Demo s', b_development='Demo d', promo_nominate='no', "
               "conversation_held=1, lm_submitted_at=?, perf_value=?, perf_rating=?, perf_band=?, pot_score=?, pot_band=?, acknowledged_at=? "
               "WHERE cycle_id=? AND person_id=?",
               (utc(NOW - timedelta(days=2)), c["perf_value"], c["perf_rating"], c["perf_band"], c["pot_score"], c["pot_band"],
                utc(ack) if ack else None, CID, pid))
    db.commit()


def audit(action):
    return db.execute("SELECT * FROM activity_log WHERE action=? ORDER BY id", (action,)).fetchall()


def people():
    return run(lambda d: {p["eid"]: p for p in a.gradeh_admin_people(d, CID)})


if True:
    CID = run(lambda d: a.active_cycle_id(d))
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
    db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 1)", (CID,))
    for bg_, c_ in ((BG, UA), (BG, UB), (BG, UC), (BG2, UO)):
        db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (bg_, c_))
    # seats: unit A, unit C and the other group's unit O have a BU CEO; unit B has none
    U["BCA"] = mk("BCA", "21", co=UA, dept="ZZGL Division", email=False)
    U["BCC"] = mk("BCC", "21", co=UC, dept="ZZGL Division", email=False)
    U["BCO"] = mk("BCO", "21", bg=BG2, co=UO, dept="ZZGL Division", email=False)
    U["HODA"] = mk("HODA", "19", hod=U["BCA"], dept="ZZGL Dept One", email=False)      # a real HOD
    U["LMA"] = mk("LMA", "15", hod=U["HODA"], dept="ZZGL Dept One", email=False)
    U["APPR"] = mk("APPR", "15", dept="ZZGL Dept One", email=False)                       # someone to appoint as the appraiser
    U["APP2"] = mk("APP2", "15", dept="ZZGL Dept One", email=False)
    for u_, bg_, co_ in (("BCA", BG, UA), ("BCC", BG, UC), ("BCO", BG2, UO)):
        db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (bg_, co_, U[u_]))
    # unit A: A1-A3 under a real HOD; A4's HOD is a calibrator (holds unit C's seat); A5 is their own HOD; A6's HOD is their unit's BU CEO;
    # A7 has no HOD at all
    for k in ("A1", "A2", "A3"):
        U[k] = mk(k, hod=U["HODA"], mgr=U["LMA"], dept="ZZGL Dept One", email=k in ("A1", "A2"))
    U["A4"] = mk("A4", hod=U["BCC"], mgr=U["LMA"], dept="ZZGL Dept One")
    U["A5"] = mk("A5", mgr=U["LMA"], dept="ZZGL Dept One", email=False)
    db.execute("UPDATE users SET hod_id=id WHERE id=?", (U["A5"],))
    U["A6"] = mk("A6", hod=U["BCA"], mgr=U["LMA"], dept="ZZGL Dept One", email=False)
    U["A7"] = mk("A7", dept="ZZGL Dept One", email=False)                                  # no HOD, no line manager
    # unit B (no BU CEO seated): a real HOD
    for k in ("B1", "B2"):
        U[k] = mk(k, hod=U["HODA"], co=UB, mgr=U["LMA"], dept="ZZGL Dept B", email=k == "B1")
    # the other group
    U["O1"] = mk("O1", hod=U["HODA"], bg=BG2, co=UO, mgr=U["LMA"], dept="ZZGL Dept O")
    for k in ("A1", "A2", "A3", "A4", "A5", "A6", "A7", "B1", "B2", "O1"):
        person(k, sup="Demo Supervisor " + k if k in ("A7",) else None)
    submit("A1", ack=NOW - timedelta(days=1))
    submit("A3")
    submit("B1")
    db.commit()

def mk_admin(k, bg, units=(), role_builtin=None, role_id=None):
    uid = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg, admin_role_id) "
                     "VALUES (?,?, 'x', 'admin', ?, ?, ?, ?)",
                     ((PFX + k).lower(), "ZZ GL " + k, PFX + k, bg, bg,
                      role_id or db.execute("SELECT id FROM admin_roles WHERE builtin=?", (role_builtin,)).fetchone()[0])).lastrowid
    for u_ in units:
        db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?,?)", (uid, u_))
    return uid


# a BG admin and a BU admin on the built-in roles (View only), a BG admin of the other group, and a BG admin on a custom role that lacks
# the Grade H item
os.environ["ONEHR_GRADEH"] = "1"
a._seed_access_roles()   # the built-in BG and BU admin roles get gradeh.read, once, now that Grade H is on
NOROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZGL No Grade H', 'group')").lastrowid
db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(NOROLE, k) for k in sorted(a.role_preset_items("view")) if k != "gradeh.read"])
U["BGA"] = mk_admin("BGA", BG, role_builtin="bg")
U["BUA"] = mk_admin("BUA", BG, units=(UA,), role_builtin="bu")
U["BG2A"] = mk_admin("BG2A", BG2, role_builtin="bg")
U["NOA"] = mk_admin("NOA", BG, role_id=NOROLE)
db.commit()
SUC = H.client_as(a, SU["id"])
EMC = H.client_as(a, EMP["id"])
BGC, BUC, BG2C, NOC = (H.client_as(a, U[k]) for k in ("BGA", "BUA", "BG2A", "NOA"))

try:
    # ==================================================================================================================
    s.section("Leaders: who has no HOD, which units have no BU CEO seated")
    PP = people()
    gap_hod = {k for k in ("A1", "A2", "A3", "A4", "A5", "A6", "A7", "B1", "B2", "O1") if not PP[PFX + k]["hod_stage"]}
    s.check("a person with no HOD, one who is their own HOD, one whose HOD is their unit's BU CEO and one whose HOD is a calibrator "
            "have no HOD stage; a real HOD's people have one",
            gap_hod == {"A4", "A5", "A6", "A7"}, gap_hod)
    s.check("the HOD's name and the unit's BU CEO's name ride on the row",
            PP[PFX + "A1"]["hod_name"] == "ZZ GL HODA" and PP[PFX + "A1"]["bu_name"] == "ZZ GL BCA" and PP[PFX + "A4"]["hod_name"] == ""
            and PP[PFX + "B1"]["bu_name"] == "" and PP[PFX + "O1"]["bu_name"] == "ZZ GL BCO", [(k, PP[PFX + k]["hod_name"], PP[PFX + k]["bu_name"]) for k in ("A1", "A4", "B1", "O1")])
    s.check("a unit has a BU CEO seated when buceo_seats has a row for its (business group, company)",
            {k for k in ("A1", "B1", "O1") if PP[PFX + k]["bu_seated"]} == {"A1", "O1"})
    s.check("the same company name in another business group is another unit: a seat for UA in the other group does not seat unit A",
            (lambda: (db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG2, UB, U["BCO"])),
                      db.commit(), people()[PFX + "B1"]["bu_seated"] is False,
                      db.execute("DELETE FROM buceo_seats WHERE business_group=? AND company=?", (BG2, UB)), db.commit())[2])())
    L = a._gh_leaders(list(PP.values()))
    s.check("the No HOD count is the rows whose HOD stage is off", L["nohod"] == sum(1 for p in PP.values() if not p["hod_stage"]) == 4, L)
    s.check("the no-BU-CEO count is units, and people are counted apart", L["nobu_units"] == 1 and L["nobu_people"] == 2, L)
    r = SUC.get(BASE + "?tab=people")
    h, t = r.get_data(as_text=True), text(r)
    s.check("the page draws the Leaders line with both counts", "LEADERS" in t and "4 have no HOD" in t and "their BU CEO covers them" in t
            and "1 unit has no BU CEO seated" in t and "it can't be signed off or released" in t, t[:400])
    s.check("...the BU CEO pill links to the seats and the counts open the list panel",
            'href="/admin/leaders?tab=buceo"' in h and "Seat one on Leaders › BU CEOs" in t and "/admin/list/gh?f=nohod" in h and "/admin/list/gh?f=nobu" in h)
    sel = re.findall(r'<option value="(nohod|nobu)"[^>]*>([^<]+)</option>', h)
    s.check("Show gains No HOD (4) and No BU CEO seated (2), counts of people", ("nohod", "No HOD (4)") in sel and ("nobu", "No BU CEO seated (2)") in sel, sel)
    t = text(SUC.get(BASE + "?tab=people&show=nohod"))
    s.check("Show No HOD returns exactly those people", all(("ZZ GL " + k in t) == (k in gap_hod) for k in ("A1", "A2", "A3", "A4", "A5", "A6", "A7", "B1", "B2", "O1")), t[:300])
    t = text(SUC.get(BASE + "?tab=people&show=nobu"))
    s.check("Show No BU CEO seated returns exactly unit B's people", all(("ZZ GL " + k in t) == (k in ("B1", "B2")) for k in ("A1", "A7", "B1", "B2", "O1")))
    ok_ = True
    for key in ("nohod", "nobu"):
        lr = SUC.get("/admin/list/gh?f=%s&fragment=1" % key)
        want = {p["eid"] for p in a._gh_adm_pick(list(PP.values()), key)}
        got = set(re.findall(r"ZZ9GL-[A-Z0-9]+", lr.get_data(as_text=True)))
        ok_ &= lr.status_code == 200 and want <= got and not (got & {PFX + "BCA"} - want) and want == {PFX + k for k in (gap_hod if key == "nohod" else {"B1", "B2"})}
    s.check("the list panel for each count holds exactly the people the count counts", ok_)
    t = text(SUC.get(BASE + "?tab=people"))
    # one line a person (board H6a, 2026-11-03): Leaders split into Appraiser and HOD; the BU CEO and the supervisor note are in the person's panel
    h = SUC.get(BASE + "?tab=people").get_data(as_text=True)
    s.check("the table's headings are Appraiser and HOD (no Leaders column); the row says the HOD's name, and 'No HOD · BU CEO' for none",
            ">Appraiser</th>" in h and ">HOD</th>" in h and ">Leaders</th>" not in h and "ZZ GL HODA" in t and "No HOD · BU CEO" in t, t[:300])
    pp_ = list(people().values())
    seated = next(p_ for p_ in pp_ if p_["bu_seated"] and p_["appr"]["kind"] == "lm")
    unseated = next(p_ for p_ in pp_ if not p_["bu_seated"])
    sup = next(p_ for p_ in pp_ if p_["appr"]["kind"] == "sup")
    ts_, tu_ = text(SUC.get(BASE + "/person/%d?fragment=1" % seated["pid"])), text(SUC.get(BASE + "/person/%d?fragment=1" % unseated["pid"]))
    s.check("...the panel names the BU CEO (and says 'No BU CEO seated' where a unit has none), with the line manager as appraiser",
            ("BU CEO " + seated["bu_name"]) in ts_ and seated["appr"]["name"] in ts_ and "No BU CEO seated" in tu_, (ts_[:300], tu_[:300]))
    s.check("...and the supervisor note under the appraiser of a person whose supervisor has no account (the row says 'Needs an appraiser')",
            "no line manager and no OneHR account" in text(SUC.get(BASE + "/person/%d?fragment=1" % sup["pid"])) and "Needs an appraiser" in t)
    # a zero reads in grey with no pill
    db.execute("UPDATE users SET hod_id=? WHERE id IN (?,?,?,?)", (U["HODA"],) + tuple(U[k] for k in ("A4", "A5", "A6", "A7")))
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, UB, U["BCC"]))
    db.commit()
    t = text(SUC.get(BASE + "?tab=people"))
    h = SUC.get(BASE + "?tab=people").get_data(as_text=True)
    s.check("with nobody missing it reads 'Everyone has an HOD' and 'Every unit has a BU CEO seated', and draws no pill",
            "Everyone has an HOD" in t and "Every unit has a BU CEO seated" in t and "gh-pill-amber" not in h and "no HOD" not in t, t[:300])
    db.execute("DELETE FROM buceo_seats WHERE business_group=? AND company=?", (BG, UB))
    db.execute("UPDATE users SET hod_id=? WHERE id=?", (U["BCC"], U["A4"]))
    db.execute("UPDATE users SET hod_id=id WHERE id=?", (U["A5"],))
    db.execute("UPDATE users SET hod_id=? WHERE id=?", (U["BCA"], U["A6"]))
    db.execute("UPDATE users SET hod_id=NULL WHERE id=?", (U["A7"],))
    db.commit()
    s.check("(put back) the counts are as they were", a._gh_leaders(list(people().values())) == L)

    # ==================================================================================================================
    s.section("Release results: a unit with no BU CEO seated can't be signed off, and says so")
    rr = SUC.get("/admin/talent-release")
    h, t = rr.get_data(as_text=True), text(rr)
    s.check("the unit with no BU CEO shows Can't and the amber reason with a link to Leaders › BU CEOs",
            "Can't" in t and "No BU CEO seated" in t and ": nobody can sign it off, so it can't be released." in t and "Seat one on Leaders › BU CEOs" in t
            and 'href="/admin/leaders?tab=buceo"' in h, t[t.find("ready to release"):][:700])
    st = run(lambda d: a.gradeh_release_state(d, CID))
    by = {u["unit"]: u for u in st["units"]}
    s.check("...only unit B (the unit state carries no_bu; unit A, with a seat, reads Not yet)",
            by[UB]["no_bu"] is True and by[UA]["no_bu"] is False and by[UO]["no_bu"] is False)
    s.check("...its row has the warm background class, a unit with a seat does not", h.count("gh-rel-nobu") == 1)
    s.check("unit A (seated, not signed off) still reads 'Not yet' and 'Not signed off by the BU CEO'", "Not yet" in t and "Not signed off by the BU CEO" in t)

    # ==================================================================================================================
    s.section("Roles & access: a Grade H Appraisal group with one read item, where Grade H is on")
    BGR = db.execute("SELECT id FROM admin_roles WHERE builtin='bg'").fetchone()[0]
    BUR = db.execute("SELECT id FROM admin_roles WHERE builtin='bu'").fetchone()[0]
    CUSTOM = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZGL Custom', 'group')").lastrowid
    db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(CUSTOM, k) for k in sorted(a.role_preset_items("view"))])
    db.execute("DELETE FROM admin_role_access WHERE item='gradeh.read'")
    db.execute("DELETE FROM app_settings WHERE key='admin_roles_seeded_gradeh'")
    db.commit()

    def roles_page(show=""):
        return SUC.get("/admin/roles?tab=admin" + (("&show=" + show) if show else ""))

    def rows_of(role):
        return {r[0] for r in db.execute("SELECT item FROM admin_role_access WHERE role_id=?", (role,))}

    os.environ.pop("ONEHR_GRADEH", None)
    r = roles_page("%d,%d,%d" % (BGR, BUR, CUSTOM))
    h, t = r.get_data(as_text=True), text(r)
    items_off = set(re.findall(r'data-item="([a-z0-9_.]+)"', h))
    # rows another module hides while its own switch is off (the CSF Scorecard on the combined staging build) are not Grade H's
    other_hidden = set(a.admin_items_hidden()) if hasattr(a, "admin_items_hidden") else set()
    s.check("flag off: the page has no Grade H group and no gradeh.read row", r.status_code == 200 and "gradeh.read" not in h
            and 'data-mod="gradeh"' not in h and items_off == set(a.ADMIN_ITEM_KEYS) - {"gradeh.read"} - other_hidden,
            sorted(set(a.ADMIN_ITEM_KEYS) - items_off))
    mods_off = [m_.replace("&amp;", "&") for m_ in re.findall(r'<span class="rl-modname">([^<]+)', h)]
    s.check("...the groups are the old ones in the old order, Grade H's locked line still under Cycle, no NEW badge but Ticketing's, Sign-in's (the last group, 2026-11-02) and Leaders'",
            mods_off == ["Cycle", "Performance", "360 Feedback", "Competency", "Calibration & Talent", "Career Plan", "People",
                         "Leaders and seats", "Org structure", "Reports and downloads", "Audit and usage", "Ticketing", "Sign-in"]
            and "Grade H Appraisal: the list and KPI imports" in t and h.count('<span class="rl-new"') == 3, mods_off)
    s.check("...the built-in roles still read View only", t.count("View only") >= 2 and "Custom" not in re.findall(r'class="rl-card-sum[^"]*">([^<]+)', h))
    s.check("flag off, no seeding: booting the seed with the switch off adds no row", (a._seed_access_roles(), not any("gradeh.read" in rows_of(x) for x in (BGR, BUR, CUSTOM)))[1])
    s.check("flag off: the View only preset is the old one", "gradeh.read" not in a.role_preset_items("view") | a.role_preset_items("full"))

    os.environ["ONEHR_GRADEH"] = "1"
    s.check("flag on: the View only and Everything presets include it, Run the cycle too (a read item)",
            all("gradeh.read" in a.role_preset_items(k) for k in ("view", "cycle", "full")))
    a._seed_access_roles()
    s.check("seeded once: the built-in BG admin and BU admin roles have the item ticked",
            "gradeh.read" in rows_of(BGR) and "gradeh.read" in rows_of(BUR))
    s.check("...a custom role and the L&D role stay unticked", "gradeh.read" not in rows_of(CUSTOM)
            and not any("gradeh.read" in rows_of(r_[0]) for r_ in db.execute("SELECT id FROM admin_roles WHERE builtin='lnd'")))
    db.execute("DELETE FROM admin_role_access WHERE role_id=? AND item='gradeh.read'", (BUR,))
    db.commit()
    a._seed_access_roles()
    s.check("...once: the super admin unticks it, the next boot leaves it unticked", "gradeh.read" not in rows_of(BUR))
    db.execute("INSERT OR IGNORE INTO admin_role_access(role_id, item) VALUES (?, 'gradeh.read')", (BUR,))
    db.commit()
    r = roles_page("%d,%d,%d" % (BGR, BUR, CUSTOM))
    h, t = r.get_data(as_text=True), text(r)
    gm = re.search(r'<details class="rl-mod">\s*<summary[^>]*><span class="rl-modname">Grade H Appraisal<span class="rl-new"[^>]*>New</span>[\s\S]*?</details>', h)
    s.check("flag on: a Grade H Appraisal group with the NEW badge, after Career Plan and before People", bool(gm)
            and h.index("Career Plan</span>") < h.index("Grade H Appraisal<span") < h.index("rl-modname\">People"))
    g = gm.group(0) if gm else ""
    s.check("...one READ item, 'See Grade H Appraisal: people and progress, appraiser, HOD and BU CEO, where each one is, Download this list'",
            g.count("data-item=") == 1 and 'data-item="gradeh.read"' in g and "data-read" in g and ">read<" in g
            and "See Grade H Appraisal: people and progress, appraiser, HOD and BU CEO, where each one is, Download this list" in g)
    ticks = dict(zip((BGR, BUR, CUSTOM), re.findall(r'name="t_(\d+)" value="gradeh.read"[^>]*?( checked)?[^>]*>', g)))
    boxes = re.findall(r'<input type="checkbox" name="t_(\d+)" value="gradeh.read" data-rid="\d+" (checked)?', g)
    s.check("...ticked for the built-in BG admin and BU admin, not for the custom role",
            dict(boxes) == {str(BGR): "checked", str(BUR): "checked", str(CUSTOM): ""}, boxes)
    s.check("...the locked super-admin line moved in from Cycle: in the group, not under Cycle",
            "The list and KPI imports, Set appraiser, Reopen, Final bands, its Settings, releasing its results and its Excel" in g
            and "Grade H Appraisal: the list and KPI imports" not in t and "Super admin only" in g)
    s.check("...the built-in BG admin and BU admin cards still read View only", t.count("View only") >= 2)
    # saving the matrix with the switch on keeps and changes the item like any other
    r = SUC.post("/admin/roles?tab=admin", data=csrf(action="save", show="", roles_shown=str(CUSTOM), **{"t_%d" % CUSTOM: ["gradeh.read"]}))
    s.check("the super admin ticks it for a custom role: saved, in the audit log as a change", "gradeh.read" in rows_of(CUSTOM)
            and any("See Grade H Appraisal" in x["detail"] for x in audit("admin_role_access")))
    db.execute("DELETE FROM admin_role_access WHERE role_id=? AND item='gradeh.read'", (CUSTOM,))
    db.commit()
    # the switch goes off with a stored row: it is kept, never shown, never counted, and a save keeps it
    os.environ.pop("ONEHR_GRADEH", None)
    r = roles_page("%d,%d,%d" % (BGR, BUR, CUSTOM))
    h, t = r.get_data(as_text=True), text(r)
    s.check("switch off again with the rows stored: the page draws as it did before (no group, built-ins still View only)",
            "gradeh.read" not in h and t.count("View only") >= 2)
    r = SUC.post("/admin/roles?tab=admin", data=csrf(action="preset", role_id=str(BGR), preset="cycle"))
    r = SUC.post("/admin/roles?tab=admin", data=csrf(action="preset", role_id=str(BGR), preset="view"))
    s.check("...a preset or a save with the switch off leaves the stored row alone", "gradeh.read" in rows_of(BGR))
    os.environ["ONEHR_GRADEH"] = "1"

    # ==================================================================================================================
    s.section("Set appraiser for several people: the panel, the one writer, who is left out")
    # a released unit (B) and a submitted person (A1); A5 and A7 can be changed
    PIDS = [P["A5"], P["A7"], P["A1"], P["B2"]]
    db.execute("INSERT INTO gradeh_releases(cycle_id, unit, released_by) VALUES (?,?,?)", (CID, UB, SU["id"]))
    db.commit()
    APPR_EID = PFX + "APPR"
    r = SUC.get(BASE + "?tab=people&panel=bulk&pick=" + ",".join(str(x) for x in PIDS))
    h, t = r.get_data(as_text=True), text(r)
    s.check("the panel opens for the ticked people: 'Set the appraiser for 4 people', 'In 2 units'",
            r.status_code == 200 and "Set the appraiser for 4 people" in t and "In 2 units" in t and "GRADE H APPRAISAL · APPRAISER" in t.upper(), t[:100])
    s.check("...one row a person: name, ID · title, and Now: their appraiser (the supervisor's text says no OneHR account)",
            "ZZ GL A5" in t and "ZZ9GL-A5 · Driver" in t and "Now: Demo Supervisor A7 (no OneHR account)" in t and "Now: ZZ GL LMA" in t, t[t.find("Set the appraiser"):][:500])
    s.check("...a submitted person and a released person read 'Submitted · left out' / 'Released · left out'",
            "Submitted · left out" in t and "Released · left out" in t)
    s.check("...the button names the people who will be set (2) and is not disabled",
            re.search(r'<button type="submit" form="gh-bulk-form" class="primary">Set appraiser for 2</button>', h) is not None)
    s.check("...the amber note names who is left out, the foot line and Cancel are there",
            "ZZ GL A1 is already submitted, so they are left out (Reopen first)." in t and "ZZ GL B2 is in a unit that has been released" in t
            and "Picked from OneHR's people: a typed name that is not a pick is refused." in t and ">Cancel<" in h)
    s.check("...the picker is the strict one (a .pick, required, the hidden Employee ID field) and the confirm box is the app's own, "
            "with the verb repeated on its button",
            'data-pick' in h and 'name="appraiser_eid"' in h and 'class="pick-q"' in h and " required " in h[h.find("gh-bulk-form"):][:1400]
            and 'data-confirm="Make the person you picked the appraiser of 2 people (ZZ GL A5, ZZ GL A7)' in h and 'data-confirm-ok="Set appraiser for 2"' in h)
    r1 = SUC.get(BASE + "?tab=people&panel=bulk&pick=%d,%d" % (P["A5"], P["A7"]))
    s.check("two people in one unit: 'All in ZZGL Unit A'", "All in ZZGL Unit A" in text(r1) and "Set the appraiser for 2 people" in text(r1))
    kinds = {x: run(lambda d, x=x: a.gradeh_appraiser_block(d, CID, x, None)[1]) for x in PIDS}
    s.check("who is left out is the writer's own check (gradeh_appraiser_block): A1 submitted, B2 released, A5 and A7 free",
            kinds == {P["A5"]: None, P["A7"]: None, P["A1"]: "submitted", P["B2"]: "released"}, kinds)
    # the POST
    before = {k: one("SELECT appraiser_id FROM gradeh_people WHERE id=?", (P[k],)) for k in ("A5", "A7", "A1", "B2")}
    n_audit = len(audit("gradeh_set_appraiser"))
    r = SUC.post(BASE + "/appraiser/bulk", data=csrf(pid=[str(x) for x in PIDS], appraiser_eid=APPR_EID, next=BASE + "?tab=people"),
                 follow_redirects=True)
    t = text(r)
    after = {k: one("SELECT appraiser_id FROM gradeh_people WHERE id=?", (P[k],)) for k in ("A5", "A7", "A1", "B2")}
    s.check("the eligible people are set to that appraiser, the submitted and the released are untouched",
            after["A5"] == U["APPR"] and after["A7"] == U["APPR"] and after["A1"] == before["A1"] and after["B2"] == before["B2"], (before, after))
    s.check("the flash says 'Set for 2; left out: ...' naming both and why",
            "Set for 2; left out: ZZ GL A1 (submitted), ZZ GL B2 (released)." in t, t[:300])
    aud = audit("gradeh_set_appraiser")[n_audit:]
    s.check("one audit row each, against the person, by the super admin (the one writer)",
            len(aud) == 2 and {x["target_user_id"] for x in aud} == {U["A5"], U["A7"]} and all(x["user_id"] == SU["id"] for x in aud)
            and all("ZZ GL APPR" in x["detail"] for x in aud), [(x["target_user_id"], x["detail"]) for x in aud])
    # refusals
    def bulk(eid, pids=None, who=SUC, **kw):
        n0 = len(audit("gradeh_set_appraiser"))
        r_ = who.post(BASE + "/appraiser/bulk", data=csrf(pid=[str(x) for x in (PIDS if pids is None else pids)], appraiser_eid=eid, **kw), follow_redirects=True)
        return r_, text(r_), len(audit("gradeh_set_appraiser")) - n0
    db.execute("UPDATE gradeh_people SET appraiser_id=? WHERE id=?", (U["APP2"], P["A5"]))
    db.commit()
    r_, t_, n_ = bulk("")
    s.check("an empty pick is refused, never read as 'clear' (nobody's appraiser changes, nothing audited)",
            "Pick the appraiser from the list: a typed name that is not a pick is refused." in t_ and n_ == 0
            and one("SELECT appraiser_id FROM gradeh_people WHERE id=?", (P["A5"],)) == U["APP2"], t_[:200])
    r_, t_, n_ = bulk("ZZ GL APPR typed, not picked")
    s.check("a typed name that is not a pick is refused by the server too", "isn't an active member of OneHR" in t_ and n_ == 0
            and one("SELECT appraiser_id FROM gradeh_people WHERE id=?", (P["A5"],)) == U["APP2"], t_[:200])
    r_, t_, n_ = bulk(APPR_EID, pids=[])
    s.check("no one ticked is refused: 'Pick at least one person.'", "Pick at least one person." in t_ and n_ == 0, t_[:200])
    r_, t_, n_ = bulk(PFX + "BCA", pids=[P["A1"], P["B2"]])
    s.check("everyone left out: refused, says who, nothing set", "Nobody was changed; left out: ZZ GL A1 (submitted); ZZ GL B2 (released)." in t_ and n_ == 0, t_[:240])
    r_, t_, n_ = bulk(PFX + "A5", pids=[P["A5"], P["A7"]])
    s.check("the appraiser is one of the people picked: they are left out ('is the appraiser'), the other is set",
            "Set for 1; left out: ZZ GL A5 (is the appraiser)." in t_ and n_ == 1 and one("SELECT appraiser_id FROM gradeh_people WHERE id=?", (P["A7"],)) == U["A5"], t_[:240])
    db.execute("UPDATE gradeh_people SET appraiser_id=NULL WHERE id IN (?,?,?)", (P["A5"], P["A7"], P["A2"]))
    db.commit()
    r_ = SUC.post(BASE + "/appraiser/bulk", data={"pid": [str(P["A5"])], "appraiser_eid": APPR_EID})
    s.check("a POST with no CSRF token is refused (400) and writes nothing", r_.status_code == 400 and one("SELECT appraiser_id FROM gradeh_people WHERE id=?", (P["A5"],)) is None)
    s.check("a BG admin, a BU admin and an employee are refused the write (403 / not 200) and nothing changes",
            [c.post(BASE + "/appraiser/bulk", data=csrf(pid=[str(P["A5"])], appraiser_eid=APPR_EID)).status_code for c in (BGC, BUC, NOC)] == [403, 403, 403]
            and EMC.post(BASE + "/appraiser/bulk", data=csrf(pid=[str(P["A5"])], appraiser_eid=APPR_EID)).status_code != 200
            and one("SELECT appraiser_id FROM gradeh_people WHERE id=?", (P["A5"],)) is None)
    bga_row = dict(db.execute("SELECT * FROM users WHERE id=?", (U["BGA"],)).fetchone())
    s.check("...and the writer itself refuses anyone but the super admin (a BG admin's row, an employee's), writing nothing",
            run(lambda d: a.gradeh_set_appraiser_bulk(d, bga_row, [P["A5"]], APPR_EID)) == (False, "Only the super admin sets an appraiser.")
            and run(lambda d: a.gradeh_set_appraiser_bulk(d, dict(EMP), [P["A5"]], APPR_EID))[0] is False
            and run(lambda d: a.gradeh_set_appraiser_bulk(d, None, [P["A5"]], APPR_EID))[0] is False
            and one("SELECT appraiser_id FROM gradeh_people WHERE id=?", (P["A5"],)) is None)
    s.check("the route is the super admin's in the access map (and no item opens it)", a.admin_access_need("admin_gradeh_appraiser_bulk", {}) == "super")
    h = SUC.get(BASE + "?tab=people").get_data(as_text=True)
    s.check("the table has a tick column (a pick-all for the page, one box a person) and the bar says what to do with nothing picked",
            h.count("data-gh-pick") == len(PP) and "data-gh-all" in h and "Tick people to set one appraiser for several" in h
            and "Download this list" not in h and "gh-bar-dl" not in h and "/admin/gradeh/list.xlsx" not in h   # the download is on Reports (2026-11-04)
            and 'data-gh-bulk-url="/admin/gradeh?tab=people&amp;panel=bulk"' in h)
    db.execute("DELETE FROM gradeh_releases WHERE cycle_id=? AND unit=?", (CID, UB))
    db.commit()

    # ==================================================================================================================
    s.section("Download this list (Excel): the rows the filters show, no band, rating, potential or nomination")
    from openpyxl import load_workbook

    def xl(url, who=SUC):
        r_ = who.get(url)
        if r_.status_code != 200:
            return r_, None, None
        wb = load_workbook(io.BytesIO(r_.get_data()))
        ws = wb.worksheets[0]
        rows = [[c.value for c in r] for r in ws.iter_rows()]
        return r_, wb, rows
    r_, wb, rows = xl(BASE + "/list.xlsx")
    s.check("it is a real xlsx with the Excel content type and a file name AI+OneHR_AllBGs_AllBUs_GradeH_People_<date>.xlsx",
            r_.status_code == 200 and r_.get_data()[:2] == b"PK" and "spreadsheetml" in r_.mimetype
            and re.search(r'AI\+OneHR_AllBGs_AllBUs_GradeH_People_\d{4}-\d{2}-\d{2}\.xlsx', r_.headers["Content-Disposition"]), r_.headers.get("Content-Disposition"))
    s.check("the header row is Employee ID, Name, Business group, Unit, Department, Route, Appraiser, HOD, Second HOD, HOD split %, BU CEO, Where it is, Acknowledgement, Disagrees, Can sign in",
            rows and rows[0] == ["Employee ID", "Name", "Business group", "Unit", "Department", "Route", "Appraiser", "HOD", "Second HOD", "HOD split %",
                                 "BU CEO", "Where it is", "Acknowledgement", "Disagrees", "Can sign in"], rows[0] if rows else None)
    s.check("one row a person on the list (ZZ people only)", len(rows) - 1 == len(PP) and {x[0] for x in rows[1:]} == set(PP), len(rows))
    flat = " ".join(str(c) for r in rows for c in r if c).lower()
    s.check("no band, rating, potential or nomination column (header and every cell)",
            not any(w in " ".join(rows[0]).lower() for w in ("band", "rating", "potential", "nominat", "score"))
            and not any(w in flat for w in ("nominat", "potential", "rating")), rows[0])
    rowby = {x[0]: x for x in rows[1:]}
    s.check("the leaders and the state read as the page does", rowby[PFX + "A4"][7] == "No HOD (BU CEO covers)" and rowby[PFX + "A1"][7].startswith("ZZ GL HODA")
            and rowby[PFX + "B1"][10] == "No BU CEO seated" and rowby[PFX + "A1"][10].startswith("ZZ GL BCA") and rowby[PFX + "A7"][6].startswith("Demo Supervisor A7 (")
            and rowby[PFX + "A1"][11] == "Submitted" and rowby[PFX + "A1"][12].startswith("Acknowledged") and rowby[PFX + "A3"][14] == "No work email"
            and rowby[PFX + "A1"][14] == "Yes" and rowby[PFX + "A1"][8] in ("", None) and rowby[PFX + "A1"][9] in ("", None),
            [rowby[PFX + "A4"][7], rowby[PFX + "B1"][10]])
    s.check("a second sheet says what it is", len(wb.worksheets) == 2 and wb.worksheets[1].title == "About")
    _, _, rows_nobu = xl(BASE + "/list.xlsx?show=nobu")
    s.check("it follows Show: No BU CEO seated gives unit B's two people", {x[0] for x in rows_nobu[1:]} == {PFX + "B1", PFX + "B2"}, [x[0] for x in rows_nobu[1:]])
    _, _, rows_hod = xl(BASE + "/list.xlsx?show=nohod")
    s.check("...No HOD gives the four", {x[0] for x in rows_hod[1:]} == {PFX + k for k in ("A4", "A5", "A6", "A7")})
    _, _, rows_bg = xl(BASE + "/list.xlsx?bg=" + BG2.replace(" ", "+"))
    s.check("...a business group", {x[0] for x in rows_bg[1:]} == {PFX + "O1"}, [x[0] for x in rows_bg[1:]])
    _, _, rows_bu = xl(BASE + "/list.xlsx?bg=%s&bu=%s" % (BG.replace(" ", "+"), UB.replace(" ", "+")))
    s.check("...a unit", {x[0] for x in rows_bu[1:]} == {PFX + "B1", PFX + "B2"})
    _, _, rows_q = xl(BASE + "/list.xlsx?q=ZZ9GL-A6&qin=eid")
    s.check("...Search in", [x[0] for x in rows_q[1:]] == [PFX + "A6"])
    _, _, rows_c = xl(BASE + "/list.xlsx?bg=%s&show=nobu" % BG.replace(" ", "+"))
    s.check("...and the filters together", {x[0] for x in rows_c[1:]} == {PFX + "B1", PFX + "B2"})
    s.check("the download is in the audit log", any("GradeH_People" in x["detail"] for x in audit("export")))
    s.check("signed out it goes to sign-in; an employee is refused", a.app.test_client().get(BASE + "/list.xlsx").status_code == 302
            and EMC.get(BASE + "/list.xlsx").status_code != 200)
    # a BG admin: their own group only; a BU admin their units; the other group's admin the other group; without the item, nothing
    _, _, rb = xl(BASE + "/list.xlsx", BGC)
    s.check("a BG admin's download holds only their group's people (no other group's person, no unit-less rows)",
            rb is not None and {x[0] for x in rb[1:]} == {p["eid"] for p in PP.values() if p["bg"] == BG} and PFX + "O1" not in {x[0] for x in rb[1:]}
            and all(x[2] == BG for x in rb[1:]), [x[0] for x in rb[1:]][:4])
    _, _, ru = xl(BASE + "/list.xlsx", BUC)
    s.check("a BU admin's holds only their units' people", ru is not None and all(x[3] == UA for x in ru[1:]) and len(ru) > 1
            and {x[0] for x in ru[1:]} == {p["eid"] for p in PP.values() if p["company"] == UA}, [x[3] for x in ru[1:]][:3])
    _, _, r2 = xl(BASE + "/list.xlsx", BG2C)
    s.check("the other group's BG admin gets only theirs", r2 is not None and {x[0] for x in r2[1:]} == {PFX + "O1"})
    _, _, rb2 = xl(BASE + "/list.xlsx?bg=" + BG2.replace(" ", "+"), BGC)
    s.check("a BG admin asking for another group by hand still gets nothing of it", rb2 is None or PFX + "O1" not in {x[0] for x in rb2[1:]})
    s.check("a BG admin on a role without the Grade H item is refused the download", NOC.get(BASE + "/list.xlsx").status_code in (302, 403)
            and NOC.get(BASE + "/list.xlsx", follow_redirects=False).status_code != 200)

    # ==================================================================================================================
    s.section("A BG / BU admin's view: People & progress only, view only, their own group or units")
    allp = people()
    DBG = run(lambda d: a.display_bg(BG))
    bgp = {k for k, p in allp.items() if p["bg"] == BG}
    r = BGC.get(BASE)
    h, t = r.get_data(as_text=True), text(r)
    s.check("a BG admin with the item reads /admin/gradeh (200), with a grey View only pill beside the heading",
            r.status_code == 200 and 'class="gh-viewonly">View only<' in h and "Grade H Appraisal" in t, r.status_code)
    s.check("the intro names their group", "Who is on the Grade H list in %s, how each person is appraised" % DBG in t, t[:200])
    names = set(re.findall(r"ZZ GL ([A-Z]+\d)\b", t)) - {"BC1"}
    s.check("the page holds no other group's person, and every one of their group's people is on it (one page)",
            "ZZ GL O1" not in t and {"A1", "A2", "A3", "A4", "A5", "A6", "A7", "B1", "B2"} <= names, sorted(names))
    s.check("...only the People & progress tab: no Imports, Final bands or Settings tab",
            re.findall(r'<nav class="adm-tabs"[\s\S]*?</nav>', h)[0].count("<a ") == 1 and "tab=imports" not in h and "tab=bands" not in h and "tab=settings" not in h)
    s.check("...no tick column, no bulk bar, no Set appraiser, no Reopen, no list panel link",
            all(x not in h for x in ("data-gh-bar", "data-gh-pick", "data-gh-all", "Set appraiser", "Appraiser</a>", "admin_gradeh_reopen", "/admin/gradeh/reopen",
                                     "data-list-open", 'id="pnl-list"', "Tick people to set")))
    s.check("...counts are plain numbers, not links; the BU CEO pill's tail says the super admin seats one, with no link",
            "4 have no HOD" in t and 'class="gh-lead-n" href' not in h and "1 unit has no BU CEO seated" in t
            and "it can't be signed off or released; the super admin seats one" in t and "Seat one on Leaders" not in t and "tab=buceo" not in h)
    s.check("...no Download link (a view-only admin downloads People and progress on Reports, 2026-11-04)", 'class="gh-dl"' not in h
            and "Download this list" not in t and "/admin/gradeh/list.xlsx" not in h)
    s.check("...the foot note", "Changes (appraiser, Reopen, imports, final bands, release) are the super admin's." in t and "Super admin only." not in t)
    s.check("...Open > opens the person's panel (read only: no Set appraiser, HOD or Reopen button in the row, and no tick column)",
            re.search(r'<a class="btn-link" href="/admin/gradeh/person/\d+" data-person-open="\d+">Open &rsaquo;</a>', h) is not None
            and "Set appraiser" not in h and 'name="reason"' not in h and "data-gh-pick" not in h and 'data-panel="person"' in h)
    tiles_bg = re.findall(r'<b[^>]*>([\d,]+)</b><span>([^<]+)</span>', h)
    s.check("the tiles count their group's people only", dict((l_, n_) for n_, l_ in tiles_bg)["On OneHR"] == str(len(bgp)) and dict((l_, n_) for n_, l_ in tiles_bg)["Need an appraiser"] == str(
        sum(1 for k in bgp if allp[k]["need"])), tiles_bg)
    t2 = text(BGC.get(BASE + "?show=nohod"))
    s.check("Show works for them: No HOD gives their group's four", all(("ZZ GL " + k in t2) == (k in ("A4", "A5", "A6", "A7")) for k in ("A1", "A4", "A5", "A6", "A7", "B1", "O1")))
    t3 = text(BGC.get(BASE + "?bg=%s" % BG2.replace(" ", "+")))
    s.check("asking for the other group by hand shows none of it", "ZZ GL O1" not in t3)
    # BU admin
    r = BUC.get(BASE)
    h, t = r.get_data(as_text=True), text(r)
    names = set(re.findall(r"ZZ GL ([A-Z]+\d)\b", t))
    s.check("a BU admin sees their units only (unit A), the intro names it, and the unit with no BU CEO (B) is not counted for them",
            r.status_code == 200 and "in %s, how each person" % UA in t and "ZZ GL B1" not in t and "ZZ GL O1" not in t and {"A1", "A7"} <= names
            and "Every unit has a BU CEO seated" in t and "no BU CEO seated" not in t.replace("Every unit has a BU CEO seated", ""), sorted(names))
    r = BG2C.get(BASE)
    t = text(r)
    s.check("the other group's BG admin sees only theirs, and their unit has a BU CEO", "ZZ GL O1" in t and "ZZ GL A1" not in t and "ZZ GL B1" not in t and "Every unit has a BU CEO seated" in t)
    s.check("an admin whose role lacks the Grade H item cannot reach the page (sent back with a note, never a 200)",
            NOC.get(BASE).status_code in (302, 403) and "ZZ GL A1" not in text(NOC.get(BASE, follow_redirects=True)))
    s.check("an employee cannot", EMC.get(BASE).status_code != 200)
    s.check("signed out: the sign-in redirect", a.app.test_client().get(BASE).status_code == 302)
    # the hard refusals: every Grade H write and every super-only GET
    refused_get, refused_post = [], []
    for who_n, who in (("BG", BGC), ("BU", BUC)):
        for tab_ in ("imports", "bands", "settings"):
            if who.get(BASE + "?tab=" + tab_).status_code != 403:
                refused_get.append((who_n, tab_))
        for r_ in a.app.url_map.iter_rules():
            if not r_.rule.startswith("/admin/gradeh") or r_.rule in (BASE, BASE + "/list.xlsx", BASE + "/person/<int:pid>"):   # the readers' own GETs
                continue
            path = re.sub(r"<(?:[a-z]+:)?token>", "x", r_.rule)
            if "GET" in r_.methods and who.get(path).status_code != 403:
                refused_get.append((who_n, path))
            if "POST" in r_.methods and who.post(path, data=csrf(pid=1, action="deemed")).status_code != 403:
                refused_post.append((who_n, path))
        for path in ("/admin/talent-release", "/admin/list/gh?f=all&fragment=1"):
            if who.get(path).status_code != 403:
                refused_get.append((who_n, path))
    n_rules = sum(1 for r_ in a.app.url_map.iter_rules() if r_.rule.startswith("/admin/gradeh") and "POST" in r_.methods)
    s.check("the Imports, Final bands and Settings GETs, every other super-only Grade H GET, Release results and the list panel refuse them (403)", not refused_get, refused_get[:5])
    s.check("every Grade H write (%d POST routes) refuses a BG and a BU admin (403)" % n_rules, n_rules >= 6 and not refused_post, refused_post[:5])
    n0 = len(audit("gradeh_set_appraiser")) + len(audit("gradeh_reopen"))
    BGC.post(BASE + "/appraiser", data=csrf(pid=P["A5"], appraiser_eid=APPR_EID))
    BGC.post(BASE + "/reopen", data=csrf(pid=P["A1"], reason="why not"))
    s.check("...and nothing changed", len(audit("gradeh_set_appraiser")) + len(audit("gradeh_reopen")) == n0
            and one("SELECT appraiser_id FROM gradeh_people WHERE id=?", (P["A5"],)) is None
            and one("SELECT reopened_at FROM gradeh_appraisals WHERE person_id=?", (P["A1"],)) is None)
    s.check("Help's 'Where is Grade H Appraisal?' says a BG or BU admin with the item sees People & progress, view only",
            all(x in a.HELP_QA["gh_adm_where"][1] for x in ("BG or BU admin", "See Grade H Appraisal", "People & progress", "view only", "super admin's")))
    # the side menu
    def side_keys(uid, cycle_half=2, flag="1"):
        db.execute("UPDATE cycles SET half=? WHERE id=?", (cycle_half, CID))
        db.commit()
        os.environ["ONEHR_GRADEH"] = flag
        try:
            with a.app.test_request_context(BASE):
                row = dict(db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())
                side = a.admin_shell(row, BASE)["side"]
            return [i["key"] for g_ in side for i in g_["items"]] + [p_["key"] for g_ in side for i in g_["items"] for p_ in i.get("pages", [])]
        finally:
            db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
            db.commit()
            os.environ["ONEHR_GRADEH"] = "1"
    s.check("the side menu shows Grade H Appraisal to a BG admin and a BU admin who hold the item, while it is offered on the active cycle",
            "gradeh" in side_keys(U["BGA"]) and "gradeh" in side_keys(U["BUA"]) and "gradeh" in side_keys(SU["id"]))
    s.check("...not to an admin whose role lacks the item", "gradeh" not in side_keys(U["NOA"]))
    s.check("...not on a cycle that doesn't offer it (a Mid-Year cycle)", "gradeh" not in side_keys(U["BGA"], cycle_half=1))
    s.check("...not where Grade H is dark", "gradeh" not in side_keys(U["BGA"], flag="0") and "gradeh" not in side_keys(SU["id"], flag="0"))

    # ==================================================================================================================
    s.section("The line manager's team list: a No work email tag, filter and opening line, in English and Bahasa Melayu")
    LMC = H.client_as(a, U["LMA"])
    PPL = people()
    mine = {k for k in ("A1", "A2", "A3", "A4", "A5", "A6", "B1", "B2", "O1")}
    noem = {k for k in mine if not PPL[PFX + k]["has_email"]}
    s.check("(setup) LMA appraises nine people; four have no work email, two are waiting to acknowledge (one of them without)",
            noem == {"A3", "A5", "A6", "B2"} and PPL[PFX + "A3"]["ack"] == "wait" and PPL[PFX + "B1"]["ack"] == "wait", noem)
    tm = run(lambda d: a.gradeh_lm_team(d, db.execute("SELECT * FROM users WHERE id=?", (U["LMA"],)).fetchone(), "all", "en"))
    s.check("the team's rows, filter and counts: the No work email count is the people the admin page calls 'No work email' (one helper)",
            tm["n"] == 9 and tm["counts"]["noemail"] == 4 and {r["name"].lower() for r in tm["rows"] if r["no_email"]} == {"zz gl " + k.lower() for k in noem}
            and all(r["no_email"] == (not PPL[PFX + r["name"].split()[-1].upper()]["has_email"]) for r in tm["rows"]), (tm["counts"], [r["name"] for r in tm["rows"]][:3]))
    r = LMC.get("/review/gradeh")
    h, t = r.get_data(as_text=True), text(r)
    s.check("a grey 'No work email' tag sits under each such person's sub line (4 of them, a crossed-envelope svg)",
            r.status_code == 200 and h.count('class="ghl-noemail"') == 4 and h.count("No work email</span>") >= 4 and "M3 7l9 6 9-6M3 3l18 18" in h)
    css = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "gradeh_lm.css")).read()
    rule = re.search(r"\.ghl-table \.c-person \.ghl-noemail \{[^}]*\}", css).group(0)
    s.check("...its style is #eceef5 on #4b5164, 11.5px bold, a pill", all(x in rule for x in ("--d-bg-eceef5", "--d-fg-4b5164", "max(10px, 0.71875rem)", "font-weight: 700", "999px")), rule)
    chips = re.findall(r'<a class="ghl-pill[^"]*"[^>]*>([^<]+?)(?: <b>(\d+)</b>)?</a>', h)
    s.check("a 'No work email' chip with its count, between 'Waiting to acknowledge' and 'Done'",
            [c_[0] for c_ in chips] == ["All", "Ready for you", "Waiting for KPI achievement", "Waiting to acknowledge", "No work email", "Done"]
            and dict(chips)["No work email"] == "4" and dict(chips)["Waiting to acknowledge"] == "2", chips)
    t5 = text(LMC.get("/review/gradeh?f=noemail"))
    s.check("the chip shows exactly those people", all(("zz gl " + k.lower() in t5.lower()) == (k in noem) for k in sorted(mine)), t5[:200])
    s.check("Ask OneHR's opening line says how many wait and how many of them have no work email, and what to do",
            "2 are waiting to acknowledge; 1 of them has no work email, so no reminder reaches them." in t
            and "Talk it through with them and record “Acknowledged in person”." in t, t[t.find("You have"):][:400])
    s.check("the foot note names staff with no work email", "“Acknowledged in person” is for staff who cannot sign in or have no work email: you confirm the date of your talk, and the record says so." in t)
    db.execute("UPDATE gradeh_appraisals SET acknowledged_at=? WHERE person_id=?", (utc(NOW), P["B1"]))
    db.commit()
    t1 = text(LMC.get("/review/gradeh"))
    s.check("one waiting, no email: '1 is waiting to acknowledge and has no work email, so no reminder reaches them.'",
            "1 is waiting to acknowledge and has no work email, so no reminder reaches them." in t1)
    db.execute("UPDATE users SET email='zz9gl-a3@example.test' WHERE id=?", (U["A3"],))
    db.commit()
    t0 = text(LMC.get("/review/gradeh"))
    s.check("nobody waiting without an email: the line is not there (and the chip count follows)",
            "so no reminder reaches them" not in t0 and "Talk it through with them" not in t0 and "No work email 3" in t0, t0[t0.find("You have"):][:300])
    db.execute("UPDATE users SET email=NULL WHERE id=?", (U["A3"],))
    db.execute("UPDATE gradeh_appraisals SET acknowledged_at=NULL WHERE person_id=?", (P["B1"],))
    db.commit()
    # Bahasa Melayu (Max's draft: needs a BM speaker's check)
    LMC.post("/review/gradeh/language", data=csrf(lang="bm", next="/review/gradeh"))
    r = LMC.get("/review/gradeh")
    tb = text(r)
    s.check("in Bahasa Melayu: the tag, the chip, the opening line and the foot note all read in BM (nothing in English left)",
            tb.count("Tiada e-mel kerja") >= 5 and "No work email" not in tb and "2 sedang menunggu untuk mengesahkan; 1 daripada mereka tiada e-mel kerja" in tb
            and "Bincangkan dengan mereka dan rekodkan “Disahkan secara bersemuka”." in tb and "atau tiada e-mel kerja: anda mengesahkan tarikh perbincangan anda" in tb, tb[tb.find("Anda mempunyai"):][:360])
    LMC.post("/review/gradeh/language", data=csrf(lang="en", next="/review/gradeh"))
    s.check("every new string has a Bahasa Melayu version with the same {fields} (the LM suite's table check also holds them)",
            all(k in a.GRADEH_LM_T and a.GRADEH_LM_T[k][1] and a.GRADEH_LM_T[k][1] != a.GRADEH_LM_T[k][0] for k in ("f_noemail", "tag_noemail", "ask_hi_noemail", "ask_hi_noemail_k1",
                                                                                                                    "ask_hi_noemail1", "ask_hi_noemail2", "ack_note")))
    # Help and the KB
    s.check("Help's 'What if they can't sign in to acknowledge?' mentions the No work email tag and filter",
            all(x in a.HELP_QA["gh_lm_inperson"][1] for x in ("No work email", "tags them", "filter")))
    s.check("Ask OneHR's 'no email' answer says so in both languages", "No work email" in a.GRADEH_LM_FAQ[1][3][0] and "Tiada e-mel kerja" in a.GRADEH_LM_FAQ[1][3][1])
    s.check("the KB line-manager row (as seeded) carries the sentence", "tags them No work email" in a._KB_GRADEH_LM_BODY
            and a._KB_GRADEH_LM_BODY.startswith(a._KB_GRADEH_LM_BODY_BEFORE_NOEMAIL))
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-line-manager'", (a._KB_GRADEH_LM_BODY_BEFORE_NOEMAIL,))
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-hod'", ("ZZ an admin's own words",))
    db.commit()
    a._ensure_runtime_schema()
    s.check("a row still holding the previous text is reworded once, keyed on the exact old text",
            one("SELECT body FROM kb_entries WHERE slug='gradeh-line-manager'") == a._KB_GRADEH_LM_BODY)
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-line-manager'", (a._KB_GRADEH_LM_BODY_BEFORE_NOEMAIL + " An admin added this line.",))
    db.commit()
    a._ensure_runtime_schema()
    s.check("...an admin's edited row is left alone", one("SELECT body FROM kb_entries WHERE slug='gradeh-line-manager'").endswith("An admin added this line.")
            and "tags them No work email" not in one("SELECT body FROM kb_entries WHERE slug='gradeh-line-manager'"))
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-line-manager'", (a._KB_GRADEH_LM_BODY,))
    db.commit()

finally:
    for t_ in ("gradeh_people",):
        pass
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    else:
        os.environ["ONEHR_GRADEH"] = _ENV0
    db.close()

sys.exit(s.done())
