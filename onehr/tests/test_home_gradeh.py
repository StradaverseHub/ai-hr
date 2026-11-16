"""Home: the Grade H Appraisal card (Chris, 6 Nov 2026, canvas [design canvas link removed] boards H1-H3, "ok proceed";
the footer legend cut to one row of five labels the same day).

What this suite holds:
  * who sees the card: the super admin; a BG / BU admin whose role has gradeh.read, for their own group or units only; nobody else (no
    gradeh.read, the L&D admin, a server or cycle that does not offer Grade H, a list with nobody in scope)
  * the numbers are Reports > Grade H > Where it is's (one source: gradeh_admin_people through _gh_scope_people): per business group the
    five stages add up to On the list, In calibration = With HOD + With BU CEO, Acknowledged = of those whose line manager submitted
    (acknowledged by themselves, in person or deemed, never someone who does not agree, never one whose line manager has not submitted);
    the total row is the sum
  * the links: the super admin's numbers open the Grade H list panel and the panel's people are exactly the ones the card counted; a BG /
    BU admin's go to People & progress (no list panel, and the list panel is refused them); People & progress takes the card's Show keys and
    the picker keeps them selected, its own options unchanged; a zero is not a link
  * before Grade H opens: one line with when it opens, no table, no "What stands out" line
  * the page head chip and "What stands out"
  * the report's Acknowledged now agrees with the card
Synthetic (ZZ9HG-*) on a fresh scratch database.
"""
import html
import io
import os
import re
import sys
from datetime import datetime, timedelta
from urllib.parse import urlencode

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Home: the Grade H Appraisal card")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA0, EMP = H.actors(a)
PFX, BG, BG2 = "ZZ9HG-", "ZZHG Group", "ZZHG Other Group"
UA, UB, UC, UO = "ZZHG Unit A", "ZZHG Unit B", "ZZHG Unit C", "ZZHG Unit O"
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


def mk(k, grade="H", hod=None, bg=BG, co=UA, dept="ZZHG Dept", mgr=None, role="user", eid=None):
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
        "job_grade, job_title, hod_id, manager_id, email, confirmation_date) VALUES (?,?, 'x', ?, ?,?,?,?,?, 'Driver', ?, ?, ?, '2020-01-01')",
        ((PFX + k).lower(), "ZZ HG " + k, role, eid or PFX + k, bg, co, dept, grade, hod, mgr, (PFX + k).lower() + "@example.test")).lastrowid


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
                     ((PFX + k).lower(), "ZZ HG " + k, PFX + k, bg, bg,
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
    U[k] = mk(k, "21", bg=bg_, co=co_, dept="ZZHG Division")
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (bg_, co_, U[k]))
U["HODA"] = mk("HODA", "19", hod=U["BCA"], dept="ZZHG Dept One")
U["LMA"] = mk("LMA", "15", hod=U["HODA"], dept="ZZHG Dept One")
# unit A: A1 not started, A2 KPI route with no lines (blocked), A3 submitted under a real HOD (with the HOD), A4 submitted with no HOD
# stage (with the BU CEO), A5 part-way (one rating)
for k in ("A1", "A3", "A5"):
    U[k] = mk(k, hod=U["HODA"], mgr=U["LMA"], dept="ZZHG Dept One")
U["A2"] = mk("A2", hod=U["HODA"], mgr=U["LMA"], dept="ZZHG Dept Two")
U["A4"] = mk("A4", mgr=U["LMA"], dept="ZZHG Dept Two")
# unit B: two submitted, signed off by the BU CEO. unit C: three submitted, released (own sign-in, deemed, waiting). unit O: one with the BU CEO
for k in ("B1", "B2"):
    U[k] = mk(k, mgr=U["LMA"], co=UB, dept="ZZHG Dept B")
for k in ("C1", "C2", "C3"):
    U[k] = mk(k, mgr=U["LMA"], co=UC, dept="ZZHG Dept C")
U["O1"] = mk("O1", mgr=U["LMA"], bg=BG2, co=UO, dept="ZZHG Dept O")
U["B3"] = mk("B3", mgr=U["LMA"], co=UB, dept="ZZHG Dept B")   # KPI route in unit B, no lines
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
           (CID, P["A4"], "perf", "final", "OU", None, "ZZHG test move", SU["id"]))
# Grade H people in OneHR who are not on this cycle's list (their own set), in three units of two groups
for k, bg_, co_ in (("N1", BG, UA), ("N2", BG, UB), ("N3", BG2, UO)):
    U[k] = mk(k, bg=bg_, co=co_, dept="ZZHG Dept N")
db.commit()

U["BGA"] = None
a._seed_access_roles()   # the built-in BG and BU admin roles get gradeh.read, once, now that Grade H is on
NOROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZHG No Grade H', 'group')").lastrowid
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


def card_html(h):
    """The Grade H card's section (the table state or the one-line state), '' when Home has none."""
    m = re.search(r'<section class="admin-card hm gh-hm[^"]*" aria-label="Grade H Appraisal[^"]*">(.*?)</section>', h, re.S)
    return m.group(1) if m else ""


def text(x):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", x))).strip()


COLS = ("n", "not_started", "lm", "ack", "cal", "signed", "released")


def parse_rows(card):
    """{row label: {'n', 'not_started', 'lm', 'ack', 'ack_of', 'cal', 'signed', 'released', 'bar': title, 'html': the row}} from the table."""
    out = {}
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", card.split("<tbody>")[-1], re.S):
        lab = re.search(r'<th scope="row">(.*?)</th>', tr, re.S)
        tds = re.findall(r'<td class="gh-hm-num">(.*?)</td>', tr, re.S)
        if not lab or len(tds) != 7:
            continue
        v = {k: int(re.sub(r"\D", "", text(td).split(" of ")[0]) or 0) for k, td in zip(COLS, tds)}
        v["ack_of"] = int(text(tds[3]).split(" of ")[1].replace(",", ""))
        v["bar"] = (re.search(r'class="gh-hm-bar"[^>]*title="([^"]*)"', tr) or [None, ""])[1]
        v["html"] = tr
        out[text(lab.group(1))] = v
    return out


def show_selected(pg):
    """The value of the selected option in People & progress's Show picker."""
    sel = re.search(r'<select name="show"[^>]*>(.*?)</select>', pg, re.S).group(1)
    return [m[0] for m in re.findall(r'<option value="([^"]*)"\s*(selected)?>', sel) if m[1]]


def report_rows(client):
    r, rows, _ab = xl(client, HUB + "/gh-where?format=xlsx")
    head = [str(x) for x in rows[0]]
    return {str(r_[0]): dict(zip(head, r_)) for r_ in rows[1:]}


def set_windows(opens, closes_lm=None, closes=None):
    """Every Grade H cell opens at `opens` (a datetime); the line manager's closes at closes_lm, the rest at `closes`."""
    db.execute("UPDATE cycles SET open_by_date=1 WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell LIKE 'gradeh_%'", (CID,))
    for c in a.GRADEH_CELL_KEYS:
        cl = closes_lm if c == "gradeh_lm" else closes
        db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                   (CID, c, opens.strftime("%Y-%m-%d %H:%M"), cl.strftime("%Y-%m-%d %H:%M") if cl else None))
    db.commit()


def myt_now():
    with a.app.test_request_context("/"):
        return a._now_myt()


_CYC0 = dict(db.execute("SELECT half, open_by_date FROM cycles WHERE id=?", (CID,)).fetchone())
U["LND"] = mk_admin("LND", a.LMS_ADMIN_BG, role_builtin="bg")   # an L&D admin who, by role, would hold gradeh.read: the guard is what keeps them off
db.commit()
BU2C = H.client_as(a, U["BU2"])
with a.app.test_request_context("/"):
    BGN, BG2N = a.display_bg(BG), a.display_bg(BG2)
    UAN, UBN, UCN = (a.display_company(BG, x) for x in (UA, UB, UC))
    UON = a.display_company(BG2, UO)
NOWM = myt_now()
LIST = "/admin/list/gh"

try:
    # ==================================================================================================================
    s.section("the setup is what the tests rely on")
    st = {k: PP[PFX + k]["status"] for k in ("A1", "A2", "A3", "A4", "A5", "B1", "C1", "O1")}
    s.check("every stage is represented", st == {"A1": "not_started", "A2": "blocked", "A3": "submitted", "A4": "bu", "A5": "lm_part", "B1": "signed", "C1": "released", "O1": "bu"}, st)
    set_windows(NOWM - timedelta(days=1), closes_lm=NOWM + timedelta(days=4), closes=NOWM + timedelta(days=9))

    # ==================================================================================================================
    s.section("the one mapping: the card's five stages are exclusive and add up to the list")
    stages = {k: {p["uid"] for p in a._gh_adm_pick(ALL, "hs:" + k)} for k in a._GH_HOME_STAGES}
    s.check("each person is in exactly one of the five (they add up to the list, none overlap)",
            sum(len(v) for v in stages.values()) == len(ALL) == len(set().union(*stages.values())), {k: len(v) for k, v in stages.items()})
    s.check("In calibration is exactly With the HOD + With the BU CEO + Submitted",
            stages["cal"] == {p["uid"] for p in ALL if p["status"] in ("submitted", "hod", "bu")} and len(stages["cal"]) == 3)
    s.check("With LM is KPI keyed + With the line manager + part-way; Not started is Blocked + Not started",
            stages["lm"] == {p["uid"] for p in ALL if p["status"] in ("kpi_keyed", "sent", "lm_part")}
            and stages["not_started"] == {p["uid"] for p in ALL if p["status"] in ("blocked", "not_started")})

    # ==================================================================================================================
    s.section("the super admin's Home: the card, its rows and the report agree")
    h = SUC.get("/admin").get_data(as_text=True)
    card = card_html(h)
    s.check("Home has the card, titled for business groups, after the matrix and before Needs you",
            "Grade H Appraisal: where each business group is" in text(card) and h.index('aria-label="Grade H Appraisal') < h.index("adm-home-needs")
            and (h.index('aria-label="Grade H Appraisal') > h.index('aria-label="Every business group, module by module"')
                 if 'aria-label="Every business group, module by module"' in h else True), card[:120])
    rows = parse_rows(card)
    rep = report_rows(SUC)
    s.check("a row for each business group with Grade H people (not a group with none), and a total row because there are two",
            set(rows) == {BGN, BG2N, "All business groups"}, list(rows))
    ok_all = True
    for bg, nm in ((BG, BGN), (BG2, BG2N)):
        r, w = rows[nm], rep[nm]
        mine = [p for p in ALL if p["bg"] == bg]
        ok = (r["n"] == w["On the list"] == len(mine) and r["not_started"] == w["Not started"] and r["lm"] == w["With LM"]
              and r["cal"] == w["With HOD"] + w["With BU CEO"] and r["signed"] == w["Signed off"] and r["released"] == w["Released"]
              and r["ack"] == w["Acknowledged"])
        s.check("%s: every count is the report's (In calibration = With HOD + With BU CEO), and the stages add up to On the list" % nm,
                ok and r["not_started"] + r["lm"] + r["cal"] + r["signed"] + r["released"] == r["n"], (r, w))
    tr = rows["All business groups"]
    s.check("the total row is the sum of the rows and is the report's Total",
            all(tr[k] == rows[BGN][k] + rows[BG2N][k] for k in COLS) and tr["n"] == len(ALL) == rep["Total"]["On the list"] and tr["ack"] == rep["Total"]["Acknowledged"], tr)
    s.check("the figures are what the setup built (3 not started, 1 with the LM, 3 in calibration, 2 signed off, 3 released)",
            (tr["not_started"], tr["lm"], tr["cal"], tr["signed"], tr["released"]) == (3, 1, 3, 2, 3), tr)

    # ---- Acknowledged: N of M
    sub_n = len([p for p in ALL if p["submitted"]])
    s.check("Acknowledged reads 'N of M': M is the people whose line manager has submitted, N those who acknowledged (own sign-in, in person or deemed)",
            tr["ack_of"] == sub_n == len(a._gh_adm_pick(ALL, "submitted")) and tr["ack"] == 2 < tr["ack_of"], tr)
    s.check("...the cell shows a bold number and a muted ' of M'", '<span class="gh-hm-of"> of %d</span>' % tr["ack_of"] in rows["All business groups"]["html"])
    db.execute("UPDATE gradeh_appraisals SET acknowledged_at=? WHERE cycle_id=? AND person_id=?", (utc(NOW), CID, P["A1"]))   # A1 has not even started
    db.execute("UPDATE gradeh_appraisals SET acknowledged_at=? WHERE cycle_id=? AND person_id=?", (utc(NOW), CID, P["A3"]))   # A3 is with the HOD
    db.commit()
    PPx = people()
    r2 = parse_rows(card_html(SUC.get("/admin").get_data(as_text=True)))["All business groups"]
    s.check("someone not submitted who somehow holds an acknowledged time is not counted (A1), one with the HOD who acknowledged is (A3): 2 -> 3",
            PPx[PFX + "A1"]["ack"] == "" and PPx[PFX + "A3"]["ack"] == "self" and r2["ack"] == 3 and r2["ack_of"] == tr["ack_of"], r2)
    db.execute("UPDATE gradeh_appraisals SET disagree_at=? WHERE cycle_id=? AND person_id=?", (utc(NOW), CID, P["A3"]))
    db.commit()
    r3 = parse_rows(card_html(SUC.get("/admin").get_data(as_text=True)))["All business groups"]
    s.check("...and A3, once they say they do not agree, is not counted (3 -> 2), though they are still one of those submitted and still in their stage",
            r3["ack"] == 2 and r3["ack_of"] == tr["ack_of"] and r3["cal"] == tr["cal"], r3)
    db.execute("UPDATE gradeh_appraisals SET acknowledged_at=NULL, disagree_at=NULL WHERE cycle_id=? AND person_id IN (?,?)", (CID, P["A1"], P["A3"]))   # put back
    db.commit()

    # ---- the bar
    r_a = rows[BGN]
    n_ = r_a["n"]
    s.check("the bar's title lists the five counts in the drawn words",
            r_a["bar"] == "Not started %d \u00b7 With LM %d \u00b7 In calibration %d \u00b7 Signed off %d \u00b7 Released %d" % (
                r_a["not_started"], r_a["lm"], r_a["cal"], r_a["signed"], r_a["released"]), r_a["bar"])
    wid = [float(x) for x in re.findall(r'style="width:([0-9.]+)%"', r_a["html"])]
    s.check("...its segments are shares of On the list and add up to 100%", abs(sum(wid) - 100) < 0.05 and len(wid) == len([k for k in COLS[1:] if k != "ack" and r_a[k]]), wid)
    s.check("...in stage order (Not started red first, Released green last)",
            re.findall(r'class="gh-b-(\w+)" style', r_a["html"])[0] == "ns" and re.findall(r'class="gh-b-(\w+)" style', r_a["html"])[-1] == "rel")

    # ---- the card's words: headings, legend and footer
    head = re.findall(r"<th scope=\"col\"[^>]*>(.*?)</th>", card, re.S)
    s.check("the columns, in the drawn order",
            [text(x) for x in head] == ["Business group", "On the list", "Not started", "With LM", "Acknowledged", "In calibration", "Signed off", "Released", "Where they are"],
            [text(x) for x in head])
    titles = dict(re.findall(r'<th scope="col"[^>]*title="([^"]*)"[^>]*>(.*?)</th>', card, re.S)[i][::-1] for i in range(6))
    want_t = {"Not started": "On the list, nothing keyed yet", "With LM": "KPI keyed or with the line manager",
              "Acknowledged": "Of those their line manager submitted, by sign-in, in person or deemed; someone who does not agree is not counted",
              "In calibration": "Submitted, with the HOD or BU CEO", "Signed off": "The BU CEO signed the unit off", "Released": "They can read their result"}
    s.check("each column heading carries its explanation as a title (hover)", {text(k): v for k, v in titles.items()} == want_t, titles)
    leg = card.split('class="gh-hm-legend"')[-1]
    s.check("the footer is ONE row of five dot + label items, labels only (Acknowledged has no dot, no explanations, no sentence under it)",
            [text(x) for x in re.findall(r"<span>(.*?)</span>", leg, re.S)] == ["Not started", "With LM", "In calibration", "Signed off", "Released"]
            and leg.count("<i ") == 5 and "acknowledge once" not in text(card) and "view only" not in text(card).lower() and "nothing keyed yet</span>" not in leg, text(leg))
    cap = text(re.search(r'class="muted small gh-hm-cap">(.*?)</span>\s*<a', card, re.S).group(1))
    s.check("the caption: how many are on the list, the open part, and that a number opens its people",
            cap.startswith("%d on the list \u00b7 line managers appraise until " % len(ALL)) and cap.endswith("a number opens its people"), cap)
    s.check("...and Full report opens the Where it is report", 'href="/admin/reports/all/gh-where"' in card and "Full report" in text(card))

    # ---- the page head chip and What stands out
    s.check("the page head's 'Open now' chip names Grade H Appraisal while a Grade H part is open", re.search(r'class="hm-open">Open now:[^<]*Grade H Appraisal', h) is not None, re.findall(r'class="hm-open">([^<]*)', h))
    notes = text(h.split('aria-label="What stands out"')[1].split("</section>")[0])
    s.check("What stands out has the Grade H line: counts, who has the most, and the open part sentence-cased",
            re.search(r"Grade H: 3 of %d not started; %s has the most, 3 of %d\. Line managers appraise until \d+ \w{3}\." % (len(ALL), re.escape(BGN), len([p for p in ALL if p["bg"] == BG])), notes) is not None, notes)

    # ==================================================================================================================
    s.section("the links: a super admin's numbers open the list panel, and its people are the ones the card counted")
    a_ = lambda html_: re.findall(r'<a class="gh-hm-n[^"]*" href="([^"]*)"(?: data-list-open="([^"]*)")?>(\d+)</a>', html_)
    links = a_(rows[BGN]["html"])
    s.check("a count above zero is a link with a list panel address and a full-page address; a zero is plain text",
            len(links) == len([k for k in COLS if k != "ack" and rows[BGN][k]]) + (1 if rows[BGN]["ack"] else 0)
            and all(l[1].startswith(LIST) and "fragment=1" in l[1] and l[0].startswith(LIST) and "fragment" not in l[0] for l in links)
            and (rows[BG2N]["not_started"] == 0 and 'class="gh-hm-n is-zero"' in rows[BG2N]["html"]), links[:2])
    s.check("Not started above zero is the alert tone, a zero is faint", 'gh-hm-n is-low' in rows[BGN]["html"] and 'gh-hm-n is-zero' in rows[BG2N]["html"])
    uid_of = {p["eid"]: p["uid"] for p in ALL}
    def panel(args):
        r = SUC.get(LIST + "?fragment=1&" + urlencode(args))
        return r, {e for e in re.findall(r"ZZ9HG-\w+", r.get_data(as_text=True)) if e in uid_of}
    ok_ = True
    for key in ("all", "hs:not_started", "hs:lm", "hs:cal", "hs:signed", "hs:released", "ack_sub"):
        for bg in (BG, BG2, None):
            for co in ((None, UA, UB, UC) if bg == BG else (None,)):
                args = {"f": key, **({"bg": bg} if bg else {}), **({"unit": co} if co else {})}
                r, got = panel(args)
                want = {p["eid"] for p in a._gh_adm_pick([p for p in ALL if (not bg or p["bg"] == bg) and (not co or p["company"] == co)], key)}
                if r.status_code != 200 or got != want:
                    ok_ = False
                    s.check("panel %s" % args, False, (r.status_code, sorted(got), sorted(want)))
    s.check("the list panel (f=<stage>, bg=, unit=) holds exactly the people the card counted: every key, every group and unit", ok_)
    r, got = panel({"f": "hs:lm", "bg": BG})
    s.check("(spot check) With LM in the group is A5 alone", got == {PFX + "A5"}, got)
    r, got = panel({"f": "ack_sub"})
    s.check("(spot check) Acknowledged is C1 and C2 (own sign-in, deemed)", got == {PFX + "C1", PFX + "C2"}, got)
    r = SUC.get(LIST + "?f=hs:lm&bg=" + BG.replace(" ", "%20"), follow_redirects=False)
    s.check("the list's full page goes to People & progress with that Show choice and that group",
            r.status_code == 302 and "/admin/gradeh" in r.headers["Location"] and "show=hs:lm" in r.headers["Location"] and "bg=" in r.headers["Location"], r.headers.get("Location"))
    s.check("the card's panel title for the new keys is in words, not the key", "With the line manager (any step)" in SUC.get(LIST + "?fragment=1&f=hs:lm").get_data(as_text=True))

    # ==================================================================================================================
    s.section("People & progress takes the card's keys and keeps them in its Show picker")
    base_pg = SUC.get(BASE + "?tab=people").get_data(as_text=True)
    base_opts = re.findall(r'<option value="([^"]*)"', base_pg.split('aria-label="Show"')[1].split("</select>")[0])
    pg = SUC.get(BASE + "?tab=people&show=hs%3Alm").get_data(as_text=True)
    sel = re.search(r'<select name="show"[^>]*>(.*?)</select>', pg, re.S).group(1)
    opts = re.findall(r'<option value="([^"]*)"\s*(selected)?>([^<]*)', sel)
    s.check("show=hs:lm: the picker shows it as the selected option with its words and count (the page is not reset to Everyone)",
            [o for o in opts if o[1]] == [("hs:lm", "selected", "With the line manager (any step) (1)")], [o for o in opts if o[1]])
    s.check("...the picker's own options are unchanged (all of them still there, in order)", [o[0] for o in opts if o[0] != "hs:lm"] == base_opts, (base_opts, [o[0] for o in opts]))
    s.check("...and without the key the picker has none of the card's keys", not any(k in base_opts for k in ("hs:lm", "ack_sub")) and show_selected(base_pg) == ["all"], show_selected(base_pg))
    ids = {e for e in re.findall(r"ZZ9HG-\w+", pg) if e in uid_of}
    s.check("...and the page lists that set: A5 alone", ids == {PFX + "A5"}, ids)
    for key in ("hs:not_started", "hs:cal", "hs:signed", "hs:released", "ack_sub"):
        pgk = SUC.get(BASE + "?tab=people&show=" + key.replace(":", "%3A")).get_data(as_text=True)
        got = {e for e in re.findall(r"ZZ9HG-\w+", pgk) if e in uid_of}
        want = {p["eid"] for p in a._gh_adm_pick(ALL, key)}
        s.check("People & progress show=%s lists the card's set (%d)" % (key, len(want)), got == want and ('value="%s" selected' % key) in pgk, (sorted(got), sorted(want)))
    pgb = SUC.get(BASE + "?tab=people&show=nonsense").get_data(as_text=True)
    s.check("an unknown Show key still falls back to Everyone", show_selected(pgb) == ["all"], show_selected(pgb))
    s.check("the people Excel takes the card's key too (not reset to Everyone)", SUC.get("/admin/gradeh/list.xlsx?show=hs%3Alm").status_code == 200)
    xr, xrows, xab = xl(SUC, "/admin/gradeh/list.xlsx?show=hs%3Alm")
    s.check("...with only that set and its Show choice in the About sheet", eids(xrows) == [PFX + "A5"] and xab.get("Show") == "With the line manager (any step)", (eids(xrows), xab.get("Show")))

    # ==================================================================================================================
    s.section("a BG admin: their units only, links to People & progress, no list panel")
    hb = BGC.get("/admin").get_data(as_text=True)
    cb = card_html(hb)
    rb = parse_rows(cb)
    s.check("the card is titled for business units and the first column says so", "where each business unit is" in text(cb) and "Business unit" in text(cb), text(cb)[:120])
    s.check("rows are their group's units that have Grade H people (A, B, C), with an 'All of <group>' total",
            set(rb) == {UAN, UBN, UCN, "All of " + BGN}, list(rb))
    mine = [p for p in ALL if p["bg"] == BG]
    s.check("...their counts are the report's for their group, and the total is their group's",
            rb["All of " + BGN]["n"] == len(mine) and rb["All of " + BGN]["ack"] == len([p for p in mine if a._gh_ack_sub(p)]) and rb[UAN]["n"] == len([p for p in mine if p["company"] == UA]), rb["All of " + BGN])
    s.check("...nothing of the other group", BG2N not in cb and "ZZHG Other" not in cb)
    s.check("no list panel on any number (on Home the panel is the super admin's alone)", "data-list-open" not in cb)
    hrefs = [html.unescape(x) for x in re.findall(r'<a class="gh-hm-n[^"]*" href="([^"]*)"', cb)]
    s.check("the numbers go to People & progress with the Show choice and the unit (zero counts are not links)",
            hrefs and all(x.startswith("/admin/gradeh?") and "tab=people" in x for x in hrefs) and any("show=hs:lm" in x and "bu=" in x for x in hrefs)
            and any("show=ack_sub" in x for x in hrefs), hrefs[:3])
    cap_b = text(re.search(r'class="muted small gh-hm-cap">(.*?)</span>\s*<a', cb, re.S).group(1))
    s.check("the caption says a number opens People & progress", cap_b.endswith("a number opens People & progress"), cap_b)
    pa = BGC.get(hrefs[0]).get_data(as_text=True)
    s.check("a BG admin can follow a number: People & progress loads, in their scope", BGC.get(hrefs[0]).status_code == 200 and PFX + "O1" not in pa)
    k_ = next(x for x in hrefs if "show=hs:lm" in x)
    pk_ = BGC.get(k_).get_data(as_text=True)
    s.check("...and a Show choice from the card is kept for them too", show_selected(pk_) == ["hs:lm"], show_selected(pk_))
    s.check("their list panel stays refused (the super admin's)", BGC.get(LIST + "?fragment=1&f=hs:lm").status_code == 403)
    ub = card_html(BUC.get("/admin").get_data(as_text=True))
    ru = parse_rows(ub)
    s.check("a BU admin of one unit: that unit's row only, no total", set(ru) == {UAN} and ru[UAN]["n"] == len([p for p in ALL if p["company"] == UA]) and "data-list-open" not in ub, list(ru))
    u2 = parse_rows(card_html(BU2C.get("/admin").get_data(as_text=True)))
    s.check("a BU admin of two units: those two and their total, not the third", set(u2) == {UAN, UBN, "All of " + BGN}
            and u2["All of " + BGN]["n"] == len([p for p in ALL if p["company"] in (UA, UB)]), list(u2))
    nb = text(hb.split('aria-label="What stands out"')[1].split("</section>")[0])
    s.check("a BG admin's What stands out has their group's Grade H line (not the other group's counts)",
            re.search(r"Grade H: \d+ of %d not started; " % len(mine), nb) is not None, nb)
    o2 = parse_rows(card_html(BG2C.get("/admin").get_data(as_text=True)))
    s.check("the other group's BG admin sees their one unit, and not a total", list(o2) == [UON] and o2[UON]["n"] == 1, list(o2))

    # ==================================================================================================================
    s.section("who does not see it")
    s.check("an admin whose role lacks gradeh.read: no card, no chip name, no Grade H line", card_html(NOC.get("/admin").get_data(as_text=True)) == ""
            and "Grade H" not in NOC.get("/admin").get_data(as_text=True).split("<main")[-1].replace("Grade H Appraisal</a>", ""))
    with a.app.test_request_context("/"):
        d = a.get_db()
        lnd = d.execute("SELECT * FROM users WHERE id=?", (U["LND"],)).fetchone()
        s.check("(setup) the L&D admin's role would give gradeh.read", a.admin_can(lnd, "gradeh", "read") and a.is_lnd_admin(lnd))
        s.check("an L&D admin: no card (falsify: their role alone would show it)", a._home_gradeh(d, lnd) is None)
        sup_row = d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        s.check("the super admin: a card (falsify the guards above)", a._home_gradeh(d, sup_row) is not None)
        emp = d.execute("SELECT * FROM users WHERE id=?", (EMP["id"],)).fetchone()
        s.check("a non-admin never gets one", a._home_gradeh(d, emp) is None)
    r = SUC.get("/admin")
    db.execute("UPDATE cycles SET half=1 WHERE id=?", (CID,))
    db.commit()
    try:
        s.check("a cycle that doesn't offer Grade H (Mid-Year): no card for the super admin or a BG admin, no chip name, no stands-out line",
                all(card_html(c.get("/admin").get_data(as_text=True)) == "" for c in (SUC, BGC))
                and not re.search(r'hm-open">Open now:[^<]*Grade H', SUC.get("/admin").get_data(as_text=True))
                and "Grade H:" not in SUC.get("/admin").get_data(as_text=True))
    finally:
        db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
        db.commit()
    os.environ["ONEHR_GRADEH"] = "0"
    try:
        s.check("a dark server (ONEHR_GRADEH off): no card even for the super admin", card_html(SUC.get("/admin").get_data(as_text=True)) == "")
    finally:
        os.environ["ONEHR_GRADEH"] = "1"
    s.check("(falsify) back on, the card is there again", card_html(SUC.get("/admin").get_data(as_text=True)) != "")
    # nobody in scope: a BG admin of a group with no Grade H people
    EMPTYBG = "ZZHG Empty Group"
    U["BGE"] = mk_admin("BGE", EMPTYBG, role_builtin="bg")
    db.commit()
    s.check("a BG admin with nobody on the Grade H list in their group: no card", card_html(H.client_as(a, U["BGE"]).get("/admin").get_data(as_text=True)) == "")

    # ==================================================================================================================
    s.section("before Grade H opens: one line")
    opens_at = NOWM + timedelta(days=3)
    opens_at = opens_at.replace(hour=0, minute=0, second=0, microsecond=0)
    set_windows(opens_at, closes_lm=opens_at + timedelta(days=12), closes=opens_at + timedelta(days=14))
    hw = SUC.get("/admin").get_data(as_text=True)
    cw = card_html(hw)
    s.check("every Grade H part not open yet: a one-line card with when it opens in MYT, no table",
            "<table" not in cw and "Opens " + opens_at.strftime("%a ") + str(opens_at.day) + opens_at.strftime(" %b, 00:00") in text(cw), text(cw))
    s.check("...with how many people on the list in how many business groups, and Full report",
            "%d people on the list in 2 business groups. The table starts here once it opens." % len(ALL) in text(cw) and 'href="/admin/reports/all/gh-where"' in cw, text(cw))
    s.check("...no 'Open now' name, no stands-out line", not re.search(r'hm-open">Open now:[^<]*Grade H', hw) and "Grade H:" not in hw.split('aria-label="What stands out"')[1])
    cwb = card_html(BGC.get("/admin").get_data(as_text=True))
    s.check("a BG admin's one line counts business units", "in 3 business units." in text(cwb) and "<table" not in cwb, text(cwb))
    set_windows(NOWM - timedelta(days=1), closes_lm=None, closes=None)   # open, nothing dated to close
    ho = SUC.get("/admin").get_data(as_text=True)
    s.check("open with no closing date: the table, and no 'until' part", card_html(ho) and " until " not in text(card_html(ho)) and "Grade H: " in ho and not re.search(r"Grade H: [^<]*until", ho), text(card_html(ho))[:200])
    set_windows(NOWM - timedelta(days=9), closes_lm=NOWM - timedelta(days=2), closes=NOWM - timedelta(days=1))   # everything closed
    hc = SUC.get("/admin").get_data(as_text=True)
    s.check("everything closed: the table stays (Grade H runs on to release), nothing is named as open", parse_rows(card_html(hc)) and not re.search(r'hm-open">Open now:[^<]*Grade H', hc))
    set_windows(NOWM - timedelta(days=1), closes_lm=NOWM + timedelta(days=4), closes=NOWM + timedelta(days=9))
    soon = (NOWM + timedelta(days=4))
    hs = SUC.get("/admin").get_data(as_text=True)
    s.check("the open part names the part that closes soonest, with its day", "line managers appraise until %d %s" % (soon.day, soon.strftime("%b")) in text(card_html(hs)), text(card_html(hs))[:200])
    set_windows(NOWM - timedelta(days=1), closes_lm=NOWM + timedelta(days=9), closes=NOWM + timedelta(days=2))
    hs2 = text(card_html(SUC.get("/admin").get_data(as_text=True)))
    s.check("...and when the line manager's part is not the soonest it is another one's words", " until " in hs2 and "line managers appraise" not in hs2, hs2[:200])

    # ==================================================================================================================
    s.section("the report agrees: Where it is's Acknowledged is the card's, after With LM")
    r, rrows, _ = xl(SUC, HUB + "/gh-where?format=xlsx")
    s.check("columns: Acknowledged sits right after With LM", [str(x) for x in rrows[0]][:5] == ["Business group", "On the list", "Not started", "With LM", "Acknowledged"], rrows[0])
    pgw = SUC.get(HUB + "/gh-where").get_data(as_text=True)
    tiles = re.findall(r'<div class="admin-card rptv-tile[^"]*">\s*<span>([^<]*)</span>', pgw)
    s.check("...its tile sits right after With line manager", tiles == ["On the list", "Not started", "With line manager", "Acknowledged", "In calibration", "Signed off", "Released"], tiles)
    rb_ = report_rows(BGC)
    cb_ = parse_rows(card_html(BGC.get("/admin").get_data(as_text=True)))
    s.check("a BG admin's card and report agree on Acknowledged (both their group's)", cb_["All of " + BGN]["ack"] == rb_["Total"]["Acknowledged"], (cb_["All of " + BGN]["ack"], rb_["Total"]))
finally:
    db.execute("UPDATE cycles SET half=?, open_by_date=? WHERE id=?", (_CYC0["half"], _CYC0["open_by_date"], CID))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell LIKE 'gradeh_%'", (CID,))
    db.commit()
    os.environ.pop("ONEHR_GRADEH", None)
    if _ENV0 is not None:
        os.environ["ONEHR_GRADEH"] = _ENV0

sys.exit(s.done())
