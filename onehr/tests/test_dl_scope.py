"""The download panel on Reports › Data downloads (Chris, 2026-10-23: "for the report download, allow admin to select
which BG which BU and which cycle to download", "after admin clicks download, it will pop out the right panel for the
selection", "go with active cycle for now. Allow several units ticked at once", "remove department"; canvas
[design canvas link removed]).

What this suite holds:
  * every download has its kind (a cycle to pick, the active cycle only, the roster, or the audit log's dates): a new
    one fails here until it is given one
  * the page: Download... opens the one panel with the report's kind, and the panel's data is the admin's own scope (a
    BG admin's group fixed) with each cycle marked whether anything of it is in OneHR
  * every download, given a business group and two units, holds exactly the rows of the full download whose person
    sits there: never one more, never one less (asserted against an independent read of the users table)
  * a pick never widens: a BG admin's download for another group is empty
  * a "pick" download reads ?cycle=; the picks go in the file name, the About sheet and the audit line
"""
import io
import json
import os
import re
import sys
from urllib.parse import urlencode

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The download panel: cycle, business group and units for each download")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
from openpyxl import load_workbook  # noqa: E402

SU, BGA, _E = H.actors(a)
C_SU = H.client_as(a, SU["id"])
URL = {}
with a.app.test_request_context("/"):
    for _s, _l, _f, ep, _d in a.ADMIN_REPORTS:
        URL[ep] = a.url_for(ep)


def sheet(resp):
    """(header, rows) of a download's first sheet."""
    wb = load_workbook(io.BytesIO(resp.get_data()), read_only=True)
    rows = [list(r) for r in wb.worksheets[0].iter_rows(values_only=True)]
    return (rows[0] if rows else []), rows[1:]


def about(resp):
    wb = load_workbook(io.BytesIO(resp.get_data()), read_only=True)
    ws = [w for w in wb.worksheets if w.title == "About"]
    return {r[0]: r[1] for r in ws[0].iter_rows(values_only=True)} if ws else {}


def eid_col(header):
    for i, h in enumerate(header):
        if h in ("Employee ID", "Subject ID", "Subject Employee ID"):
            return i
    return None


# ---------------------------------------------------------------------------------------------- every download a kind
s.section("every download has its kind")
eps = {ep for _s, _l, _f, ep, _d in a.ADMIN_REPORTS} - a.DL_LIBRARY_EPS   # the three libraries' files (10 Nov 2026) are no cycle's or group's: they download straight
# Grade H's four downloads (2026-11-04) are on the same panel, the active cycle's; they need Grade H people to hold rows, so
# test_gradeh_reports narrows them: here they are counted apart from the platform's own
GH_EPS = {ep for _s, _l, _f, ep, _d in a.GRADEH_REPORTS}
MODE = {ep: m for ep, m in a.DL_CYCLE_MODE.items() if ep not in GH_EPS}
s.check("every download is a cycle to pick, the active cycle only, the roster, or (the audit log) its dates",
        eps == set(MODE) and set(MODE) <= eps and MODE["admin_export_audit_log"] == "dates",
        sorted(eps ^ set(MODE)))
# the module pages' downloads that moved here (2026-11-04) hold rows only where a copy has the data: test_reports_sweep seeds them and
# holds each one's picks; here they are on the panel, counted, and narrowed wherever this copy has rows
SWEEP = {"admin_export_calibration_progress", "admin_export_calibration_locks", "admin_export_final_bands", "admin_export_idp_progress",
         "admin_export_late_passes", "admin_roles_service_list", "admin_export_optouts", "admin_export_data_integrity",
         "admin_export_ask_log", "admin_feedback_export"}
_kinds = {k: list(MODE.values()).count(k) for k in ("pick", "active", "roster", "dates")}
s.check("...fourteen follow a picked cycle, twelve are the active cycle's, eight the roster, one the dates", _kinds == {
    "pick": 14, "active": 12, "roster": 8, "dates": 1}, _kinds)

with a.app.test_request_context("/admin/module/pm?fbg=ZZDL+X&fcompany=ZZDL+Y"):
    off = a.dl_picks()
with a.app.test_request_context(URL["admin_export_users"] + "?fbg=ZZDL+X&fcompany=ZZDL+Y"):
    on = a.dl_picks()
s.check("the picks are read on a download only, never on another page that has an fbg of its own",
        off == {} and on == {"bg": "ZZDL X", "units": ["ZZDL Y"]}, (off, on))

# ---------------------------------------------------------------------------------------------- the page
s.section("the page: Download... opens the panel, its data the admin's own scope")
page = C_SU.get("/admin/reports/all?kind=data").get_data(as_text=True)
modes = re.findall(r'data-dl-mode="(\w+)"', page)
s.check("each download with a kind opens the panel, carrying it", 'id="pnl-dl"' in page and len(modes) >= 20
        and set(modes) == {"pick", "active", "roster", "dates"}, (len(modes), set(modes)))
s.check("...the audit log opens it too, for its dates (it downloaded straight before 2026-11-04)",
        re.search(r'data-dl-href="%s"\s+data-dl-mode="dates"' % re.escape(URL["admin_export_audit_log"]), page) is not None
        and 'href="%s">Download</a>' % URL["admin_export_audit_log"] not in page)
m = re.search(r'<script type="application/json" id="dl-data">(.*?)</script>', page, re.S)
D = json.loads(m.group(1)) if m else {}
with a.app.app_context():
    db = a.get_db()
    n_bg = db.execute("SELECT COUNT(DISTINCT business_group) FROM users WHERE role!='admin' AND left_at IS NULL AND "
                      "COALESCE(is_demo,0)=0 AND COALESCE(business_group,'')!=''").fetchone()[0]
    ac = a.active_cycle(db)
s.check("the super admin's panel offers every business group with people, none fixed",
        D and not D["fixed_bg"] and len(D["bgs"]) >= n_bg, (len(D.get("bgs", [])), n_bg))
s.check("...the active cycle marked, and in OneHR", ac is not None and any(
    c["id"] == ac["id"] and c["active"] and c["ran"] for c in D.get("cycles", [])))
with a.app.app_context():
    db = a.get_db()
    hid = db.execute("INSERT INTO cycles(code, name, is_active, year, half) VALUES ('ZZDL-HR', 'ZZDL HR year', 0, 2019, "
                     "2)").lastrowid
    db.commit()
try:
    D2 = json.loads(re.search(r'id="dl-data">(.*?)</script>', C_SU.get("/admin/reports/all?kind=data").get_data(
        as_text=True), re.S).group(1))
    s.check("a cycle nothing in OneHR holds (an HR year before OneHR) is offered greyed", any(
        c["id"] == hid and not c["ran"] for c in D2["cycles"]))
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM cycles WHERE id=?", (hid,))
        db.commit()

if BGA:
    C_BGA = H.client_as(a, BGA["id"])
    pb = C_BGA.get("/admin/reports/all?kind=data").get_data(as_text=True)
    mb = re.search(r'id="dl-data">(.*?)</script>', pb, re.S)
    Db = json.loads(mb.group(1)) if mb else {}
    s.check("a BG admin's panel: their group fixed, nobody else's", Db and Db["fixed_bg"] == BGA["admin_bg"]
            and [b["bg"] for b in Db["bgs"]] == [BGA["admin_bg"]] and 'name="fbg" value="%s"' % BGA["admin_bg"] in pb,
            (Db.get("fixed_bg"), [b["bg"] for b in Db.get("bgs", [])]))

# ---------------------------------------------------------------------------------------------- every download narrows
s.section("every download, for a group and two of its units, holds exactly its rows there")
with a.app.app_context():
    db = a.get_db()
    big = db.execute("SELECT business_group, company, COUNT(*) n FROM users WHERE role!='admin' AND left_at IS NULL AND "
                     "COALESCE(is_demo,0)=0 AND COALESCE(company,'')!='' GROUP BY business_group, company "
                     "ORDER BY n DESC").fetchall()
    BG = big[0]["business_group"]
    UNITS = [r["company"] for r in big if r["business_group"] == BG][:2]
    where = {r["employee_id"]: (r["business_group"], r["company"]) for r in db.execute(
        "SELECT employee_id, business_group, company FROM users WHERE employee_id IS NOT NULL")}
inside = lambda e: where.get(str(e)) is not None and where[str(e)][0] == BG and where[str(e)][1] in UNITS  # noqa: E731
q = urlencode([("fbg", BG)] + [("fcompany", u) for u in UNITS])

# two ratings records of the active cycle in one unit and one elsewhere, so the records' own downloads (the movements, the
# ratings record) have rows to narrow in this copy; taken out at the end
SEEDED = []
with a.app.app_context():
    db = a.get_db()
    if ac:
        free = ("SELECT id, employee_id, full_name, business_group, company FROM users WHERE role!='admin' AND left_at "
                "IS NULL AND COALESCE(is_demo,0)=0 AND id NOT IN (SELECT subject_id FROM rating_records WHERE cycle_id=? "
                "AND subject_id IS NOT NULL) AND ")
        ppl = db.execute(free + "business_group=? AND company=? LIMIT 2", (ac["id"], BG, UNITS[0])).fetchall()
        ppl += db.execute(free + "business_group!=? LIMIT 1", (ac["id"], BG)).fetchall()
        for p_ in ppl:
            SEEDED.append(db.execute(
                "INSERT INTO rating_records(cycle_id, subject_id, employee_id, full_name, business_group, company, "
                "pm_mgr_band, pm_final_band, pot_raw_band, pot_final_band) VALUES (?,?,?,?,?,?,'ME','AE','Mid','High')",
                (ac["id"], p_["id"], p_["employee_id"], p_["full_name"], p_["business_group"], p_["company"])).lastrowid)
        db.commit()

NOT_BY_PERSON = {"admin_export_audit_log", "admin_export_calibration_locks", "admin_export_ask_log"}
reached, empty = [], []
try:
    for ep in sorted(MODE):
        full = C_SU.get(URL[ep])
        if full.status_code != 200:
            s.check("%s downloads" % ep, False, full.status_code)
            continue
        hf, rf = sheet(full)
        ci = eid_col(hf)
        if ep in NOT_BY_PERSON:   # a file of scopes, questions or actions: test_reports_sweep holds its picks by its own columns
            s.note("%s has no person on its rows: narrowed in test_reports_sweep" % ep)
            continue
        if ci is None:
            s.check("%s has an Employee ID column to check by" % ep, False, hf[:6])
            continue
        # the group and two units this download has the most rows in (else the default pair): every download with any
        # rows is checked on rows it really has
        tally = {}
        for r in rf:
            w_ = where.get(str(r[ci]))
            if w_ and w_[0]:
                tally[w_] = tally.get(w_, 0) + 1
        if tally:   # (rows whose people have no unit are checked by the group alone)
            top = max(tally, key=tally.get)
            bg_ = top[0]
            us_ = [k[1] for k in sorted(tally, key=tally.get, reverse=True) if k[0] == bg_ and k[1]][:2]
        else:
            bg_, us_ = BG, UNITS
        ins = lambda e, b=bg_, u=us_: (where.get(str(e)) is not None and where[str(e)][0] == b  # noqa: E731
                                       and (not u or where[str(e)][1] in u))
        part = C_SU.get(URL[ep] + "?" + urlencode([("fbg", bg_)] + [("fcompany", u) for u in us_]))
        _hp, rp = sheet(part) if part.status_code == 200 else ([], [])
        cp = eid_col(_hp)   # the identity block drops the group and unit columns for one group or unit
        want = sorted(str(r[ci]) for r in rf if ins(r[ci]))
        got = sorted(str(r[cp]) for r in rp) if cp is not None else None
        (reached if want else empty).append(ep)
        s.check("%s: the full download's rows in one group · %d unit(s), no more, no fewer (%d of %d)"
                % (ep, len(us_), len(got), len(rf)), part.status_code == 200 and got == want
                and all(ins(e) for e in got or []), (part.status_code, len(got), len(want), len(rf)))
        if rf:   # a group nobody is in: nothing, however many rows the download has
            nb = C_SU.get(URL[ep] + "?" + urlencode([("fbg", "ZZDL No Such Group")]))
            _hn, rn = sheet(nb) if nb.status_code == 200 else ([], [None])
            s.check("...%s for a group nobody is in: nothing" % ep, rn == [], len(rn))
    s.note("downloads checked on rows: %d; with no rows at all in this copy: %s" % (len(reached), empty))
    OLD = set(MODE) - SWEEP - NOT_BY_PERSON   # the sweep's own downloads hold rows only where a copy has the data (test_reports_sweep seeds them)
    s.check("...and the check reaches rows on nearly every download that held rows before the sweep", len(set(reached) & OLD) >= len(OLD) - 3,
            (len(reached), empty))
finally:
    with a.app.app_context():
        db = a.get_db()
        for i in SEEDED:
            db.execute("DELETE FROM rating_records WHERE id=?", (i,))
        db.commit()

# ---------------------------------------------------------------------------------------------- never widens
s.section("a pick never widens what the admin can see")
if BGA:
    other = [b for b in {v[0] for v in where.values()} if b and b != BGA["admin_bg"]]
    for ep in ("admin_export_users", "admin_export_pm_results", "admin_export_results"):
        r = C_BGA.get(URL[ep] + "?" + urlencode([("fbg", other[0])]))
        _h, rows = sheet(r) if r.status_code == 200 else ([], [None])
        s.check("a BG admin's %s for another group is empty" % ep, r.status_code == 200 and rows == [], len(rows))

# ---------------------------------------------------------------------------------------------- the cycle, the file
s.section("a picked cycle is read; the picks are in the file name, its About sheet and the audit line")
with a.app.app_context():
    db = a.get_db()
    quiet = db.execute("SELECT id FROM cycles WHERE id NOT IN (SELECT DISTINCT cycle_id FROM assignments) ORDER BY id "
                       "LIMIT 1").fetchone()
    has360 = db.execute("SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND archived=0", (ac["id"],)).fetchone()[0]
if quiet and has360:
    _h, r_def = sheet(C_SU.get(URL["admin_export_results"] + "?cycle=%d" % ac["id"]))
    _h, r_q = sheet(C_SU.get(URL["admin_export_results"] + "?cycle=%d" % quiet[0]))
    s.check("360 Results reads ?cycle=: the active cycle's rows, none for a cycle with no 360",
            len(r_def) > 0 and r_q == [], (len(r_def), len(r_q)))
else:
    s.note("no 360 rows or no quiet cycle in this copy: the cycle check skipped")
r = C_SU.get(URL["admin_export_pm_results"] + "?" + q)
cd = r.headers.get("Content-Disposition", "")
ab = about(r)
def wordof(n):
    m = re.search(r"\(([A-Za-z0-9]+)\)\s*$", n)
    return m.group(1) if m else "-".join(re.sub(r"[^A-Za-z0-9 -]", "", n).split())


with a.app.test_request_context("/"):
    bgl = a.display_bg(BG)
    unl = ", ".join(a.display_company(BG, u) or u for u in UNITS)
s.check("the file's name carries the group and '2BUs'", "AI+OneHR_%s_2BUs_" % wordof(bgl) in cd, cd)
s.check("...and its About sheet the group and the units, in HRIS's own spelling", ab.get("Business group") == BG
        and ab.get("Business units") == ", ".join(UNITS), ab)
last = H.one(a, "SELECT detail FROM activity_log WHERE user_id=? AND action='export' ORDER BY id DESC LIMIT 1",
             (SU["id"],))
s.check("...and the audit line says what it was for", last and (", for %s: " % bgl) in last, last)
r = C_SU.get(URL["admin_export_no_lm"] + "?" + q)
s.check("a people list's file name carries them too", "AI+OneHR_%s_2BUs_" % wordof(bgl) in r.headers.get(
    "Content-Disposition", ""), r.headers.get("Content-Disposition"))
with a.app.app_context():
    db = a.get_db()
    db.execute("DELETE FROM activity_log WHERE user_id=? AND action='export' AND detail LIKE ?", (SU["id"], "%, for %"))
    db.commit()

sys.exit(s.done())
