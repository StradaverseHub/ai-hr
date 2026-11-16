"""Grade H Appraisal on Reports: its four downloads and two on-screen reports, and the Grade H page without download buttons
(Chris, 4 Nov 2026: "cleanse the grade h appraisal module view"; canvas [design canvas link removed],
approved "as drawn"; Results is the super admin's alone).

What this suite holds:
  * Reports › Data downloads: a Grade H Appraisal group, four downloads in the drawn order, its Report pages line (People & progress,
    Final bands: each only to an admin who can open it); the super admin sees all four, a BG admin with gradeh.read People and
    progress alone, an admin without gradeh.read nothing; a dark server, or a cycle that doesn't offer Grade H (for a BG admin), lists
    none of it
  * the Download... panel: all four are the active cycle's; picks (one business group, one unit, two units) narrow each of them and
    never widen; the panel's count is the number of rows the file holds; the file name and About sheet carry the picks
  * Reports › On screen: Where it is (super admin, and a BG or BU admin with gradeh.read, own scope) and Results (super admin only,
    403 for anyone else); Where it is's columns add up to "On the list" and agree with People & progress's Show counts; Results counts
    only people who have a band (never the shown-not-stored default), Final by the same function Final bands reads
  * the Grade H page, each tab, for the super admin and a view-only admin, and the Release card, hold none of the four download
    addresses; Imports keeps both Template links
Synthetic (ZZ9GR-*) on a fresh scratch database.
"""
import io
import os
import re
import sys
from datetime import datetime, timedelta
from urllib.parse import urlencode

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Grade H on Reports: four downloads, two on-screen reports, a Grade H page without downloads")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA0, EMP = H.actors(a)
PFX, BG, BG2 = "ZZ9GR-", "ZZGR Group", "ZZGR Other Group"
UA, UB, UC, UO = "ZZGR Unit A", "ZZGR Unit B", "ZZGR Unit C", "ZZGR Unit O"
U, P = {}, {}
_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
BASE = "/admin/gradeh"
import sqlite3  # noqa: E402
from openpyxl import load_workbook  # noqa: E402

db = sqlite3.connect(a.DB_PATH, timeout=5.0)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")
HUB = "/admin/reports/all"
DL4 = ("admin_gradeh_list_xlsx", "admin_gradeh_results_xlsx", "admin_gradeh_export_not_on_list", "admin_gradeh_export_no_kpi_lines")
with a.app.test_request_context("/"):
    URL = {ep: a.url_for(ep) for ep in DL4}
HREFS = list(URL.values())


def one(sql, args=()):
    r = db.execute(sql, args).fetchone()
    return r[0] if r else None


def run(fn):
    with a.app.test_request_context("/"):
        d = a.get_db()
        r = fn(d)
        d.commit()
        return r


def utc(x):
    return x.strftime("%Y-%m-%d %H:%M:%S")


NOW = datetime.utcnow()


def mk(k, grade="H", hod=None, bg=BG, co=UA, dept="ZZGR Dept", mgr=None, role="user", eid=None):
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
        "job_grade, job_title, hod_id, manager_id, email, confirmation_date) VALUES (?,?, 'x', ?, ?,?,?,?,?, 'Driver', ?, ?, ?, '2020-01-01')",
        ((PFX + k).lower(), "ZZ GR " + k, role, eid or PFX + k, bg, co, dept, grade, hod, mgr, (PFX + k).lower() + "@example.test")).lastrowid


def person(k, route="B"):
    pid = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route, language) VALUES (?,?,?,?,?)",
                     (CID, PFX + k, U[k], route, "en")).lastrowid
    P[k] = pid
    return pid


def submit(k, ack=None, deemed=None):
    """A submitted Route B appraisal: ratings and answers written, the computed result stored."""
    pid = P[k]
    for at in a.GRADEH_ATTRIBUTES:
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
               "conversation_held=1, lm_submitted_at=?, perf_value=?, perf_rating=?, perf_band=?, pot_score=?, pot_band=?, acknowledged_at=?, deemed_at=? "
               "WHERE cycle_id=? AND person_id=?",
               (utc(NOW - timedelta(days=2)), c["perf_value"], c["perf_rating"], c["perf_band"], c["pot_score"], c["pot_band"],
                utc(ack) if ack else None, utc(deemed) if deemed else None, CID, pid))
    db.commit()


def people():
    return run(lambda d: {p["eid"]: p for p in a.gradeh_admin_people(d, CID)})


def xl(c, url):
    """(response, [header, rows...] of the first sheet, {About item: detail})."""
    r = c.get(url)
    if r.status_code != 200 or r.data[:2] != b"PK":
        return r, [], {}
    wb = load_workbook(io.BytesIO(r.data), read_only=True)
    rows = [list(x) for x in wb.worksheets[0].iter_rows(values_only=True)]
    ab = {x[0]: x[1] for x in wb["About"].iter_rows(values_only=True)} if "About" in wb.sheetnames else {}
    return r, rows, ab


def eids(rows, col="Employee ID"):
    """The Employee IDs of a download (its header names the column; the Grade H list's is 'Employee ID')."""
    if not rows:
        return []
    h = [str(x) for x in rows[0]]
    i = next((n for n, x in enumerate(h) if x.lower() in ("employee id", "employee id", col.lower())), 0)
    return [str(r[i]) for r in rows[1:]]


def hub(c, kind="data"):
    return c.get(HUB + ("?kind=data" if kind == "data" else "")).get_data(as_text=True)


def gh_block(h):
    m = re.search(r'id="data-gradeh">(.*?)</section>', h, re.S)
    return m.group(1) if m else ""


def gh_card(h):
    m = re.search(r'id="rep-gradeh">(.*?)</section>', h, re.S)
    return m.group(1) if m else ""


def dl_data(h):
    import json
    m = re.search(r'id="dl-data">(.*?)</script>', h, re.S)
    return json.loads(m.group(1)) if m else {}


def mk_admin(k, bg, units=(), role_builtin=None, role_id=None):
    uid = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg, admin_role_id) "
                     "VALUES (?,?, 'x', 'admin', ?, ?, ?, ?)",
                     ((PFX + k).lower(), "ZZ GR " + k, PFX + k, bg, bg,
                      role_id or db.execute("SELECT id FROM admin_roles WHERE builtin=?", (role_builtin,)).fetchone()[0])).lastrowid
    for u_ in units:
        db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?,?)", (uid, u_))
    return uid


CID = run(lambda d: a.active_cycle_id(d))
db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 1)", (CID,))
for bg_, c_ in ((BG, UA), (BG, UB), (BG, UC), (BG2, UO)):
    db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (bg_, c_))
# a BU CEO seated in every unit, a real HOD in unit A
for k, bg_, co_ in (("BCA", BG, UA), ("BCB", BG, UB), ("BCC", BG, UC), ("BCO", BG2, UO)):
    U[k] = mk(k, "21", bg=bg_, co=co_, dept="ZZGR Division")
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (bg_, co_, U[k]))
U["HODA"] = mk("HODA", "19", hod=U["BCA"], dept="ZZGR Dept One")
U["LMA"] = mk("LMA", "15", hod=U["HODA"], dept="ZZGR Dept One")
# unit A: A1 not started, A2 KPI route with no lines (blocked), A3 submitted under a real HOD (with the HOD), A4 submitted with no HOD
# stage (with the BU CEO), A5 part-way (one rating)
for k in ("A1", "A3", "A5"):
    U[k] = mk(k, hod=U["HODA"], mgr=U["LMA"], dept="ZZGR Dept One")
U["A2"] = mk("A2", hod=U["HODA"], mgr=U["LMA"], dept="ZZGR Dept Two")
U["A4"] = mk("A4", mgr=U["LMA"], dept="ZZGR Dept Two")
# unit B: two submitted, signed off by the BU CEO. unit C: three submitted, released (own sign-in, deemed, waiting). unit O: one with the BU CEO
for k in ("B1", "B2"):
    U[k] = mk(k, mgr=U["LMA"], co=UB, dept="ZZGR Dept B")
for k in ("C1", "C2", "C3"):
    U[k] = mk(k, mgr=U["LMA"], co=UC, dept="ZZGR Dept C")
U["O1"] = mk("O1", mgr=U["LMA"], bg=BG2, co=UO, dept="ZZGR Dept O")
U["B3"] = mk("B3", mgr=U["LMA"], co=UB, dept="ZZGR Dept B")   # KPI route in unit B, no lines
for k in ("A1", "A3", "A4", "A5", "B1", "B2", "C1", "C2", "C3", "O1"):
    person(k)
person("A2", "A")
person("B3", "A")
db.execute("INSERT INTO gradeh_ratings (cycle_id, person_id, attr_key, rating) VALUES (?,?,?,3)", (CID, P["A5"], a.GRADEH_ATTRIBUTES[0]["key"]))
for k in ("A3", "A4", "B1", "B2", "O1"):
    submit(k)
submit("C1", ack=NOW - timedelta(days=1))
submit("C2", deemed=NOW - timedelta(hours=5))
submit("C3")
db.execute("INSERT INTO gradeh_signoffs (cycle_id, tier, stage, scope_key, signed_by) VALUES (?, 'buceo', 'all', ?, ?)", (CID, UB, U["BCB"]))
db.execute("INSERT INTO gradeh_signoffs (cycle_id, tier, stage, scope_key, signed_by) VALUES (?, 'buceo', 'all', ?, ?)", (CID, UC, U["BCC"]))
db.execute("INSERT INTO gradeh_releases (cycle_id, unit, released_by) VALUES (?,?,?)", (CID, UC, U["BCC"]))
# the super admin's own move of A4's final performance band: Final reads it, the line manager's band stays as submitted
db.execute("INSERT INTO gradeh_band_moves (cycle_id, person_id, axis, stage, band, came_in, remark, by_user_id) VALUES (?,?,?,?,?,?,?,?)",
           (CID, P["A4"], "perf", "final", "OU", None, "ZZGR test move", SU["id"]))
# Grade H people in OneHR who are not on this cycle's list (their own set), in three units of two groups
for k, bg_, co_ in (("N1", BG, UA), ("N2", BG, UB), ("N3", BG2, UO)):
    U[k] = mk(k, bg=bg_, co=co_, dept="ZZGR Dept N")
db.commit()

U["BGA"] = None
a._seed_access_roles()   # the built-in BG and BU admin roles get gradeh.read, once, now that Grade H is on
NOROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZGR No Grade H', 'group')").lastrowid
db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(NOROLE, k) for k in sorted(a.role_preset_items("view")) if k != "gradeh.read"])
U["BGA"] = mk_admin("BGA", BG, role_builtin="bg")
U["BUA"] = mk_admin("BUA", BG, units=(UA,), role_builtin="bu")
U["BG2A"] = mk_admin("BG2A", BG2, role_builtin="bg")
U["BU2"] = mk_admin("BU2", BG, units=(UA, UB), role_builtin="bu")   # two units: the report's own path can't narrow this, the scope does
U["NOA"] = mk_admin("NOA", BG, role_id=NOROLE)
db.commit()
SUC = H.client_as(a, SU["id"])
BGC, BUC, BG2C, NOC = (H.client_as(a, U[k]) for k in ("BGA", "BUA", "BG2A", "NOA"))
PP = people()
ALL = list(PP.values())
GH_EIDS = {p["eid"] for p in ALL}


def in_scope(rows_eids, bg=None, units=None):
    """What the picks should leave of these Employee IDs, from the users table (an independent read)."""
    out = set()
    for e in rows_eids:
        r = db.execute("SELECT business_group, company FROM users WHERE employee_id=?", (e,)).fetchone()
        if r and (not bg or r[0] == bg) and (not units or r[1] in units):
            out.add(e)
    return out


try:
    # ==================================================================================================================
    s.section("the setup is what the tests rely on")
    st = {k: PP[PFX + k]["status"] for k in ("A1", "A2", "A3", "A4", "A5", "B1", "C1", "O1")}
    s.check("every stage is represented: not started, blocked, with the HOD, with the BU CEO, part-way, signed off, released",
            st == {"A1": "not_started", "A2": "blocked", "A3": "submitted", "A4": "bu", "A5": "lm_part", "B1": "signed", "C1": "released", "O1": "bu"}, st)
    s.check("...and the three acknowledgements (own sign-in, deemed, waiting)", [PP[PFX + k]["ack"] for k in ("C1", "C2", "C3")] == ["self", "deemed", "wait"])
    s.check("...and the super admin's final move reads as the final band, the line manager's band left as submitted",
            PP[PFX + "A4"]["b_fin"]["perf"] == "OU" and PP[PFX + "A4"]["lm"]["perf"] not in (None, "OU"), (PP[PFX + "A4"]["b_fin"], PP[PFX + "A4"]["lm"]))

    # ==================================================================================================================
    s.section("Data downloads: the Grade H Appraisal group, for the super admin")
    h = hub(SUC)
    blk = gh_block(h)
    labels = re.findall(r'<li><span class="adm-rep-name"><b>([^<]+)</b>', blk)
    s.check("a Grade H Appraisal group with the four downloads in the drawn order",
            "Grade H Appraisal" in re.sub(r"<[^>]+>", "", blk.split("<ul")[0]) and labels == [
                "People and progress", "Results", "People not on the Grade H list", "KPI-route people with no KPI lines"], labels)
    words = (
        "One row a person on the Grade H list: who appraises them, their HOD and BU CEO, where it is and how they acknowledged. Never a band or a rating.",
        "One row a person: the line manager&#39;s result, each calibration stage, the final result, the talent label, every move and its remark, "
        "the acknowledgement and the promotion nomination.",
        "Grade H people in OneHR who aren&#39;t on this cycle&#39;s list, in the Grade H list import&#39;s columns: fill in their route, import it.",
        "Everyone on the KPI route with no KPI line yet, in the Strada8 KPI lines import&#39;s columns: fill in their lines, import it.")
    s.check("...each with its drawn words", all(x in blk for x in words), [x[:40] for x in words if x not in blk])
    s.check("...every one opens the Download... panel (the active cycle's), none is a bare link",
            blk.count('data-panel-open="dl"') == 4 and blk.count('data-dl-mode="active"') == 4, blk.count('data-dl-mode="active"'))
    s.check("...the Report pages line links People & progress and Final bands",
            "Report pages:" in blk and 'href="/admin/gradeh">People &amp; progress</a>' in blk and 'href="/admin/gradeh?tab=bands">Final bands</a>' in blk, blk[-400:])
    with a.app.test_request_context("/"):
        n_files = sum(len(g["files"]) for g in a._reports_for(dict(SU)))
    s.check("the data tab counts the four in its number", ">Data downloads <span>· %d</span>" % n_files in h, n_files)

    # ==================================================================================================================
    s.section("Data downloads: a BG admin with gradeh.read sees People and progress alone; an admin without it sees none of Grade H")
    hb = hub(BGC)
    bb = gh_block(hb)
    s.check("a BG admin (View only, which holds gradeh.read): the group, one download (People and progress), one report page (People & progress)",
            re.findall(r'<li><span class="adm-rep-name"><b>([^<]+)</b>', bb) == ["People and progress"]
            and 'href="/admin/gradeh">People &amp; progress</a>' in bb and "Final bands" not in bb, bb[-300:])
    hn = hub(NOC)
    s.check("an admin whose role lacks gradeh.read: no Grade H group on either tab", 'id="data-gradeh"' not in hn and 'id="rep-gradeh"' not in hub(NOC, "html")
            and not any(x in hn for x in HREFS))
    # dark: the server switch off, nothing of Grade H on the hub for anyone
    os.environ["ONEHR_GRADEH"] = "0"
    try:
        s.check("a dark server lists nothing of Grade H, even to the super admin (both tabs)", 'id="data-gradeh"' not in hub(SUC)
                and 'id="rep-gradeh"' not in hub(SUC, "html") and not any(x in hub(SUC) for x in HREFS))
        s.check("...and its two reports are not there (404)", all(SUC.get("%s/gh-%s" % (HUB, k)).status_code == 404 for k in ("where", "results")))
    finally:
        os.environ["ONEHR_GRADEH"] = "1"
    # a cycle that does not offer it (Mid-Year): a BG admin is not offered it; the super admin still is
    db.execute("UPDATE cycles SET half=1 WHERE id=?", (CID,))
    db.commit()
    try:
        s.check("a cycle that doesn't offer Grade H (Mid-Year): a BG admin sees none of it, on either tab",
                'id="data-gradeh"' not in hub(BGC) and 'id="rep-gradeh"' not in hub(BGC, "html"))
        s.check("...and their routes: the report is refused, the download is 404", BGC.get(HUB + "/gh-where").status_code in (403, 404)
                and BGC.get(URL["admin_gradeh_list_xlsx"]).status_code in (403, 404))
    finally:
        db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
        db.commit()

    # ==================================================================================================================
    s.section("the downloads' access is as it was: the super admin's three, and a BG admin's People and progress")
    r_su = {ep: SUC.get(u).status_code for ep, u in URL.items()}
    s.check("the super admin downloads all four", all(c == 200 for c in r_su.values()), r_su)
    r_bg = {ep: BGC.get(u).status_code for ep, u in URL.items()}
    s.check("a BG admin with gradeh.read gets People and progress; Results and both who's-missing files are refused (403)",
            r_bg["admin_gradeh_list_xlsx"] == 200 and all(r_bg[ep] == 403 for ep in DL4[1:]), r_bg)
    r_no = {ep: NOC.get(u, follow_redirects=False).status_code for ep, u in URL.items()}
    s.check("an admin without gradeh.read is refused every one (falsify: they are 200 for none)", all(c != 200 for c in r_no.values()), r_no)
    s.check("an employee and a signed-out visitor are refused", all(H.client_as(a, EMP["id"]).get(u).status_code != 200 for u in HREFS)
            and all(a.app.test_client().get(u).status_code == 302 for u in HREFS))

    # ==================================================================================================================
    s.section("the picks narrow each download inside its scope and never widen it")
    # the two who's-missing sets from an independent read of the tables (this copy holds other Grade H people too)
    not_on = {r[0] for r in db.execute(
        "SELECT employee_id FROM users WHERE role!='admin' AND left_at IS NULL AND UPPER(TRIM(job_grade))='H' AND employee_id IS NOT NULL AND "
        "employee_id NOT IN (SELECT employee_id FROM gradeh_people WHERE cycle_id=?)", (CID,))}
    no_kpi = {r[0] for r in db.execute(
        "SELECT p.employee_id FROM gradeh_people p WHERE p.cycle_id=? AND p.private_company=0 AND p.route='A' AND "
        "NOT EXISTS (SELECT 1 FROM gradeh_kpi_lines l WHERE l.person_id=p.id)", (CID,))}
    s.check("(setup) the three Grade H people off the list and the two KPI-route people with no lines are in those sets",
            {PFX + k for k in ("N1", "N2", "N3")} <= not_on and not ({PFX + k for k in ("A1", "A2")} & not_on) and {PFX + "A2", PFX + "B3"} <= no_kpi
            and PFX + "A1" not in no_kpi, (len(not_on), len(no_kpi)))
    gsets = {"admin_gradeh_list_xlsx": GH_EIDS, "admin_gradeh_results_xlsx": GH_EIDS,
             "admin_gradeh_export_not_on_list": not_on, "admin_gradeh_export_no_kpi_lines": no_kpi}
    full = {}
    for ep in DL4:
        r, rows, ab = xl(SUC, URL[ep])
        full[ep] = set(eids(rows))
        s.check("%s: with no pick the file holds exactly its people (%d)" % (ep, len(gsets[ep])), r.status_code == 200 and full[ep] == gsets[ep],
                (r.status_code, len(full[ep]), len(gsets[ep])))
    for ep in DL4:
        for what, qs, bg_, un_ in (("one business group", [("fbg", BG)], BG, None),
                                   ("one unit", [("fbg", BG), ("fcompany", UA)], BG, [UA]),
                                   ("two units", [("fbg", BG), ("fcompany", UA), ("fcompany", UB)], BG, [UA, UB]),
                                   ("the other group", [("fbg", BG2)], BG2, None)):
            r, rows, ab = xl(SUC, URL[ep] + "?" + urlencode(qs))
            want = in_scope(gsets[ep], bg_, un_)
            s.check("%s, %s: exactly the people there, no more, no fewer (%d of %d)" % (ep, what, len(want), len(gsets[ep])),
                    r.status_code == 200 and set(eids(rows)) == want and len(eids(rows)) == len(want), (r.status_code, len(eids(rows)), len(want)))
        r, rows, ab = xl(SUC, URL[ep] + "?" + urlencode([("fbg", "ZZGR No Such Group")]))
        s.check("%s, a group nobody is in: an empty file" % ep, r.status_code == 200 and eids(rows) == [])
    # nothing widens: a BG admin picking the other group, or a unit outside theirs, holds nothing of it
    r, rows, ab = xl(BGC, URL["admin_gradeh_list_xlsx"] + "?" + urlencode([("fbg", BG2)]))
    s.check("a BG admin picking another business group gets an empty file, not that group's people", r.status_code == 200 and eids(rows) == [], len(eids(rows)))
    r, rows, ab = xl(BGC, URL["admin_gradeh_list_xlsx"])
    s.check("...and with no pick, their own group's people only (not the other group's)",
            set(eids(rows)) == in_scope(GH_EIDS, BG) and not (set(eids(rows)) & in_scope(GH_EIDS, BG2)) and len(eids(rows)) > 0, len(eids(rows)))
    r, rows, ab = xl(BUC, URL["admin_gradeh_list_xlsx"] + "?" + urlencode([("fbg", BG), ("fcompany", UB)]))
    s.check("a BU admin of unit A picking unit B gets nothing; picking A and B holds A's people only",
            eids(rows) == [] and set(eids(xl(BUC, URL["admin_gradeh_list_xlsx"] + "?" + urlencode([("fbg", BG), ("fcompany", UA), ("fcompany", UB)]))[1]))
            == in_scope(GH_EIDS, BG, [UA]), len(eids(rows)))
    # file name and About sheet
    r, rows, ab = xl(SUC, URL["admin_gradeh_results_xlsx"] + "?" + urlencode([("fbg", BG), ("fcompany", UA), ("fcompany", UB)]))
    cd = r.headers.get("Content-Disposition", "")
    s.check("two units: the file names the group and no unit; its About sheet names the group and both units",
            re.search(r"AI\+OneHR_ZZGR-Group_AllBUs_GradeH_Results_\d{4}-\d{2}-\d{2}\.xlsx", cd)
            and ab.get("Business group") == BG and ab.get("Business units") == "%s, %s" % (UA, UB), (cd, ab))
    r, rows, ab = xl(SUC, URL["admin_gradeh_results_xlsx"] + "?" + urlencode([("fbg", BG), ("fcompany", UA)]))
    cd = r.headers.get("Content-Disposition", "")
    s.check("one unit: the file names the group and the unit", re.search(r"AI\+OneHR_ZZGR-Group_ZZGR-Unit-A_GradeH_Results_", cd) is not None, cd)
    r, rows, ab = xl(SUC, URL["admin_gradeh_results_xlsx"] + "?unit=" + UA.replace(" ", "%20"))
    s.check("a legacy ?unit= still narrows when nothing was picked, and a pick wins over it",
            set(eids(rows)) == in_scope(GH_EIDS, None, [UA])
            and set(eids(xl(SUC, URL["admin_gradeh_results_xlsx"] + "?" + urlencode([("unit", UA), ("fbg", BG), ("fcompany", UB)]))[1])) == in_scope(GH_EIDS, BG, [UB]))
    for ep in ("admin_gradeh_list_xlsx", "admin_gradeh_export_not_on_list", "admin_gradeh_export_no_kpi_lines"):
        r, rows, ab = xl(SUC, URL[ep] + "?" + urlencode([("fbg", BG), ("fcompany", UA), ("fcompany", UB)]))
        s.check("%s: About names the picks and counts its rows" % ep, ab.get("Business group") == BG and ab.get("Business units") == "%s, %s" % (UA, UB)
                and ab.get("Rows") == len(eids(rows)), ab)
    n_exp = len(db.execute("SELECT 1 FROM activity_log WHERE action='export' AND detail LIKE '%GradeH%'").fetchall())
    s.check("every download is logged as an export", n_exp >= 4, n_exp)

    # ==================================================================================================================
    s.section("the panel's count is the number of rows the file holds")
    D = dl_data(hub(SUC))
    ghc = lambda d_: {k: v for k, v in d_.get("counts", {}).items() if k.startswith("gh_")}   # noqa: E731  (the Reports sweep, 4 Nov 2026, adds sw_* counts of its own)
    cnt = ghc(D)
    s.check("the panel data carries Grade H's own counts, and the four buttons name theirs",
            set(cnt) == {"gh_list", "gh_missing", "gh_nokpi"} and all(
                'data-dl-count="%s"' % k in hub(SUC) for k in ("gh_list", "gh_missing", "gh_nokpi")), list(cnt))
    ok_all = True
    for key, ep in (("gh_list", "admin_gradeh_list_xlsx"), ("gh_list", "admin_gradeh_results_xlsx"),
                    ("gh_missing", "admin_gradeh_export_not_on_list"), ("gh_nokpi", "admin_gradeh_export_no_kpi_lines")):
        for bg_ in (BG, BG2):
            n_file = len(eids(xl(SUC, URL[ep] + "?" + urlencode([("fbg", bg_)]))[1]))
            n_pan = (cnt[key].get(bg_) or {}).get("n", 0)
            u_ok = all(len(eids(xl(SUC, URL[ep] + "?" + urlencode([("fbg", bg_), ("fcompany", c_)]))[1])) == n for c_, n in (cnt[key].get(bg_) or {}).get("u", {}).items())
            ok_all &= (n_file == n_pan and u_ok)
            s.check("%s, %s: the panel says %d and the file holds %d; each unit's number is its file's" % (ep, bg_, n_pan, n_file), n_file == n_pan and u_ok)
    s.check("the counts are the Grade H people, not today's users (the generic count would be every user in the unit)",
            sum(v["n"] for v in cnt["gh_list"].values()) == len(ALL) and ok_all)
    Db = dl_data(hub(BGC))
    s.check("a BG admin's counts hold People and progress's alone, their own group's people only",
            set(ghc(Db)) == {"gh_list"} and set(Db["counts"]["gh_list"]) == {BG}
            and Db["counts"]["gh_list"][BG]["n"] == len(in_scope(GH_EIDS, BG)), list(Db.get("counts", {})))
    s.check("an admin without gradeh.read has no Grade H counts", ghc(dl_data(hub(NOC))) == {})
    js = open(os.path.join(H.REPO, "static", "dl_scope.js"), encoding="utf-8").read()
    s.check("the panel's script reads them (data-dl-count, D.counts) and the note for Grade H's active cycle is the drawn words",
            "data-dl-count" in js and "D.counts" in js and "Grade H runs on the active cycle, so this is today's picture of it." in a.GRADEH_DL_NOTE
            and "data-dl-note=\"Grade H runs on the active cycle, so this is today&#39;s picture of it.\"" in hub(SUC))

    # ==================================================================================================================
    s.section("On screen: the two Grade H reports, and who sees them")
    ph = hub(SUC, "html")
    card = gh_card(ph)
    s.check("the super admin's On screen has a Grade H Appraisal card with Where it is and Results (the drawn words)",
            "Where it is" in card and "Results" in card and "/admin/reports/all/gh-where" in card and "/admin/reports/all/gh-results" in card
            and "Who is with the line manager, in calibration, signed off and released, and who has acknowledged, at each level." in card
            and "The performance and potential band spread at each level, as it stands now." in card, card[:200])
    cb = gh_card(hub(BGC, "html"))
    s.check("a BG admin with gradeh.read: Where it is only", "/admin/reports/all/gh-where" in cb and "gh-results" not in cb)
    s.check("an admin without gradeh.read: neither", "gh-where" not in hub(NOC, "html") and "gh-results" not in hub(NOC, "html"))
    codes = {who: (c.get(HUB + "/gh-where").status_code, c.get(HUB + "/gh-results").status_code) for who, c in
             (("su", SUC), ("bg", BGC), ("bu", BUC), ("bg2", BG2C), ("none", NOC))}
    s.check("Where it is: 200 for the super admin and for a BG and a BU admin with gradeh.read", codes["su"][0] == codes["bg"][0] == codes["bu"][0] == codes["bg2"][0] == 200, codes)
    s.check("Results: 200 for the super admin, 403 for a BG admin and a BU admin even with gradeh.read", codes["su"][1] == 200 and codes["bg"][1] == codes["bu"][1] == codes["bg2"][1] == 403, codes)
    s.check("an admin without gradeh.read is refused both (falsify: not 200)", codes["none"][0] != 200 and codes["none"][1] != 200, codes)
    s.check("...and Results' Excel is refused too (403), not only its page", BGC.get(HUB + "/gh-results?format=xlsx").status_code == 403)

    # ==================================================================================================================
    s.section("Where it is: columns add up to On the list and agree with People & progress")
    r, rows, ab = xl(SUC, HUB + "/gh-where?format=xlsx")
    head = [str(x) for x in rows[0]]
    s.check("the drawn columns (Acknowledged right after With LM: a person acknowledges once the line manager submits, before calibration)",
            head == ["Business group", "On the list", "Not started", "With LM", "Acknowledged", "With HOD", "With BU CEO", "Signed off", "Released"], head)
    tot = dict(zip(head, rows[-1]))
    STG = ("Not started", "With LM", "With HOD", "With BU CEO", "Signed off", "Released")   # the stage columns: exclusive, they add up to On the list
    s.check("the last row is the total, and its stage columns add up to On the list", rows[-1][0] == "Total" and sum(tot[k] for k in STG) == tot["On the list"]
            and tot["On the list"] == len(ALL), tot)
    s.check("every group's row adds up too", all(sum(dict(zip(head, r_))[k] for k in STG) == dict(zip(head, r_))["On the list"] for r_ in rows[1:]))
    cnt_st = lambda *ks: len(a._gh_adm_pick(ALL, "st:" + ks[0])) if len(ks) == 1 else sum(len(a._gh_adm_pick(ALL, "st:" + k)) for k in ks)  # noqa: E731
    s.check("each column is People & progress's Show counts: Not started = Blocked + Not started, With LM = KPI keyed + With the line manager + part-way, "
            "With HOD = Submitted + With the HOD, With BU CEO, Signed off, Released",
            (tot["Not started"], tot["With LM"], tot["With HOD"], tot["With BU CEO"], tot["Signed off"], tot["Released"]) == (
                cnt_st("blocked", "not_started"), cnt_st("kpi_keyed", "sent", "lm_part"), cnt_st("submitted", "hod"), cnt_st("bu"), cnt_st("signed"), cnt_st("released")), tot)
    s.check("...the figures are what the setup built (two blocked + one not started, one part-way, one submitted, two with the BU CEO, two signed off, three released)",
            (tot["Not started"], tot["With LM"], tot["With HOD"], tot["With BU CEO"], tot["Signed off"], tot["Released"]) == (3, 1, 1, 2, 2, 3), tot)
    ack_sub = [p for p in ALL if p["submitted"] and p["ack"] in ("self", "person", "deemed") and not p["dis"]]
    s.check("Acknowledged = of those whose line manager submitted, acknowledged by themselves, in person or deemed (a waiting one does not count; any stage counts)",
            tot["Acknowledged"] == len(ack_sub) == len(a._gh_adm_pick(ALL, "ack_sub")) == 2, tot)
    # the old meaning (released only) is gone: an acknowledged person who is NOT released still counts, a disagreeing one never does
    db.execute("UPDATE gradeh_appraisals SET acknowledged_at=? WHERE cycle_id=? AND person_id=?", (utc(NOW - timedelta(hours=3)), CID, P["A3"]))   # A3 is with the HOD
    db.commit()
    r_, rows_a, _ = xl(SUC, HUB + "/gh-where?format=xlsx")
    tot_a = dict(zip([str(x) for x in rows_a[0]], rows_a[-1]))
    s.check("someone with the HOD (not released) who acknowledges is counted (falsify: the old released-only rule would stay at 2)", tot_a["Acknowledged"] == 3, tot_a)
    db.execute("UPDATE gradeh_appraisals SET disagree_at=? WHERE cycle_id=? AND person_id=?", (utc(NOW), CID, P["A3"]))
    db.commit()
    r_, rows_a, _ = xl(SUC, HUB + "/gh-where?format=xlsx")
    s.check("...and the same person, once they say they do not agree, is not counted", dict(zip([str(x) for x in rows_a[0]], rows_a[-1]))["Acknowledged"] == 2)
    db.execute("UPDATE gradeh_appraisals SET acknowledged_at=NULL, disagree_at=NULL WHERE cycle_id=? AND person_id=?", (CID, P["A3"]))   # put back
    db.commit()
    pg = SUC.get(HUB + "/gh-where")
    t = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", pg.get_data(as_text=True))).replace("&#39;", "'").replace("&amp;", "&")
    want_w = ("On the list", "Not started", "With line manager", "Acknowledged", "In calibration", "Signed off", "Released",
              "of those their line manager submitted, by sign-in, in person or deemed; someone who does not agree is not counted",
              "Counts only: names stay on Grade H Appraisal › People & progress and in the data downloads.")
    s.check("the page: its tiles, the footnote and the names line are the drawn words", all(x in t for x in want_w), [x for x in want_w if x not in t])
    pg_h = pg.get_data(as_text=True)
    s.check("...Not started is the alert tile and there are seven tiles", pg_h.count('class="admin-card rptv-tile') == 7 and "is-alert" in pg_h, pg_h.count("rptv-tile"))
    # a level down
    r, rows1, _ = xl(SUC, HUB + "/gh-where?format=xlsx&bg=" + BG.replace(" ", "%20"))
    s.check("a level down: the group's units, adding up to the group's row", [str(x) for x in rows1[0]][0] == "Business unit"
            and {r_[0] for r_ in rows1[1:-1]} <= {UA, UB, UC} and rows1[-1][1] == len([p for p in ALL if p["bg"] == BG]), [r_[0] for r_ in rows1])
    r, rows2, _ = xl(SUC, HUB + "/gh-where?format=xlsx&bg=%s&bu=%s" % (BG.replace(" ", "%20"), UA.replace(" ", "%20")))
    s.check("...and a unit's departments", [str(x) for x in rows2[0]][0] == "Department" and rows2[-1][1] == len([p for p in ALL if p["company"] == UA]), rows2[0])
    # scope
    r, rb, _ = xl(BGC, HUB + "/gh-where?format=xlsx")
    s.check("a BG admin's report holds their own group's people only, even when the address asks for the other group",
            rb[-1][1] == len([p for p in ALL if p["bg"] == BG]) and xl(BGC, HUB + "/gh-where?format=xlsx&bg=" + BG2.replace(" ", "%20"))[1][-1][1]
            == len([p for p in ALL if p["bg"] == BG]), rb[-1])
    r, ru, _ = xl(BUC, HUB + "/gh-where?format=xlsx")
    s.check("a BU admin's report holds their unit's people only", ru[-1][1] == len([p for p in ALL if p["company"] == UA]), ru[-1])
    BU2C = H.client_as(a, U["BU2"])
    r, r2u, _ = xl(BU2C, HUB + "/gh-where?format=xlsx")
    s.check("a BU admin of two units: those two units' people, not the group's third unit",
            r2u[-1][1] == len([p for p in ALL if p["company"] in (UA, UB)]) < len([p for p in ALL if p["bg"] == BG]), r2u[-1])
    s.check("...and their download holds the same people",
            set(eids(xl(BU2C, URL["admin_gradeh_list_xlsx"])[1])) == in_scope(GH_EIDS, BG, [UA, UB]))
    r, rbo, _ = xl(BG2C, HUB + "/gh-where?format=xlsx")
    s.check("the other group's BG admin sees theirs: one person", rbo[-1][1] == len([p for p in ALL if p["bg"] == BG2]) == 1, rbo[-1])

    # ==================================================================================================================
    s.section("Results: counts only people who have a band; Final is what Final bands reads")
    r, rr, ab = xl(SUC, HUB + "/gh-results?format=xlsx")
    head = [str(x) for x in rr[0]]
    s.check("the drawn columns: Rated, a bar of the five performance bands, a bar of the three potential bands, AE + OU",
            head[:2] == ["Business group", "Rated"] and head[2:7] == ["Performance (final): %s" % b for b in a.PM_BAND_ORDER]
            and head[7:10] == ["Potential (final): %s" % b for b in a.TALENT_POTENTIAL_ORDER] and head[10] == "AE + OU %", head)
    tot = dict(zip(head, rr[-1]))
    with_band = [p for p in ALL if p["b_fin"]["perf"]]
    s.check("Rated is the people with a final band (%d of %d on the list): one with no submission is not counted, nor given the default band" % (len(with_band), len(ALL)),
            tot["Rated"] == len(with_band) < len(ALL) and sum(tot["Performance (final): %s" % b] for b in a.PM_BAND_ORDER) == len(with_band), tot)
    s.check("...the spread is the final band as Final bands reads it (A4's moved band counts in OU)",
            all(tot["Performance (final): %s" % b] == sum(1 for p in with_band if p["b_fin"]["perf"] == b) for b in a.PM_BAND_ORDER)
            and tot["Performance (final): OU"] >= 1, tot)
    s.check("...and the default band is never read: nobody without a band is counted UA", tot["Performance (final): UA"] == sum(1 for p in with_band if p["b_fin"]["perf"] == "UA"))
    s.check("...the potential bar counts the people with a final potential band",
            sum(tot["Potential (final): %s" % b] for b in a.TALENT_POTENTIAL_ORDER) == len([p for p in ALL if p["b_fin"]["pot"]]), tot)
    s.check("...AE + OU is the share of the rated with AE or OU (a whole percent)",
            tot["AE + OU %"] == round(100.0 * sum(1 for p in with_band if p["b_fin"]["perf"] in ("AE", "OU")) / len(with_band)), tot)
    r, rl, _ = xl(SUC, HUB + "/gh-results?format=xlsx&band=lm")
    hl = [str(x) for x in rl[0]]
    totl = dict(zip(hl, rl[-1]))
    lm_set = [p for p in ALL if p["lm"]["perf"]]
    s.check("Line manager's: as submitted, so A4's move is not in it, and its bars are headed so",
            hl[2] == "Performance (line manager's): UA" and totl["Rated"] == len(lm_set)
            and all(totl["Performance (line manager's): %s" % b] == sum(1 for p in lm_set if p["lm"]["perf"] == b) for b in a.PM_BAND_ORDER)
            and totl["Performance (line manager's): OU"] == sum(1 for p in lm_set if p["lm"]["perf"] == "OU") != tot["Performance (final): OU"], (hl[:4], totl))
    r, rb2, _ = xl(SUC, HUB + "/gh-results?format=xlsx&band=both")
    hb2 = [str(x) for x in rb2[0]]
    s.check("Both: the final bars and the line manager's, each headed by its own bands (the potential bar is not headed with the performance bands)",
            len(hb2) == len(head) + 8 and [h_ for h_ in hb2 if h_.startswith("Potential (final)")] == ["Potential (final): %s" % b for b in a.TALENT_POTENTIAL_ORDER]
            and [h_ for h_ in hb2 if h_.startswith("Potential (line manager's)")] == ["Potential (line manager's): %s" % b for b in a.TALENT_POTENTIAL_ORDER], hb2)
    pg = SUC.get(HUB + "/gh-results").get_data(as_text=True)
    t = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", pg))
    want_w = ("Final", "Line manager's", "Both", "Has a final band", "AE + OU (final)", "UA + BE (final)", "High potential (final)",
              "the band as it stands now (the BU CEO's or the super admin's move, else the line manager's); a unit's is final once released",
              "Someone with no band yet is not counted",
              "Counts only: names stay on Grade H Appraisal › Final bands and in the Results download.")
    t = t.replace("&#39;", "'").replace("&amp;", "&")
    s.check("the page: the band choice, the four tiles, the footnote and the names line are the drawn words", all(x in t for x in want_w), [x for x in want_w if x not in t])
    tiles = re.findall(r'<div class="admin-card rptv-tile[^"]*">\s*<span>([^<]+)</span><b>([^<]*)', pg)
    s.check("...the Has a final band tile is the number rated", ("Has a final band", str(len(with_band))) in [(x, y.strip()) for x, y in tiles], tiles)
    # an unsubmitted person gets a band: the count moves by exactly one (falsifies "counts everyone")
    n_before = tot["Rated"]
    submit("A1")
    r, rr2, _ = xl(SUC, HUB + "/gh-results?format=xlsx")
    s.check("a person who submits becomes rated: the count rises by one", dict(zip(head, rr2[-1]))["Rated"] == n_before + 1, (n_before, dict(zip(head, rr2[-1]))["Rated"]))
    db.execute("UPDATE gradeh_appraisals SET lm_submitted_at=NULL, perf_band=NULL, pot_band=NULL, perf_value=NULL, perf_rating=NULL, pot_score=NULL WHERE person_id=?", (P["A1"],))
    db.commit()

    # ==================================================================================================================
    s.section("the Grade H page has no download buttons, on any tab, for the super admin or a view-only admin")
    bad = []
    for tab_ in ("people", "imports", "bands", "settings"):
        for who_n, who in (("super", SUC), ("bg", BGC)):
            if who_n == "bg" and tab_ != "people":
                continue
            r = who.get(BASE + "?tab=" + tab_)
            h = r.get_data(as_text=True)
            if r.status_code != 200:
                bad.append((who_n, tab_, r.status_code))
            elif any(x in h for x in HREFS) or any(x in h for x in ("Download this list", "Download Excel", "Who is missing from the list", "Who has no KPI lines", "gh-bar-dl", "gh-tablefoot")):
                bad.append((who_n, tab_, "a download"))
    s.check("People, Imports, Final bands and Settings (super), People (a BG admin): none of the four addresses, no 'Download' button", not bad, bad)
    sub_ = SUC.get(BASE + "?tab=people&view=hod").get_data(as_text=True)
    s.check("...nor By HOD", not any(x in sub_ for x in HREFS))
    rel = SUC.get("/admin/talent-release").get_data(as_text=True)
    s.check("the Release card holds none of them and still says what its release does (the Talent rating note stays)",
            'id="gh-release"' in rel and not any(x in rel for x in HREFS) and "Download Excel for Group People" not in rel and "Talent rating" in rel
            and "Waiting on Group P&amp;R" in rel, [x for x in HREFS if x in rel])
    imp = SUC.get(BASE + "?tab=imports").get_data(as_text=True)
    s.check("Imports keeps Import and Template on both cards (the two Template links)",
            'href="/admin/gradeh/import/list/template.xlsx"' in imp and 'href="/admin/gradeh/import/kpi/template.xlsx"' in imp
            and "Import the Grade H list" in imp and "Import the KPI lines" in imp and imp.count("Template (Excel)") == 2, imp.count("Template (Excel)"))
    s.check("...and the routes themselves stay (Reports links to them): each still answers the super admin", all(SUC.get(u).status_code == 200 for u in HREFS))
    css = open(os.path.join(H.REPO, "static", "gradeh_admin.css"), encoding="utf-8").read()
    s.check("the CSS only the removed buttons used is gone (.gh-bar-dl, .gh-dl, .gh-tablefoot); the pager rule stays",
            not re.search(r"\.gh-bar-dl\b|\.gh-dl\b|\.gh-tablefoot\b", css) and ".gh-pager {" in css)
finally:
    os.environ.pop("ONEHR_GRADEH", None)
    if _ENV0 is not None:
        os.environ["ONEHR_GRADEH"] = _ENV0

sys.exit(s.done())
