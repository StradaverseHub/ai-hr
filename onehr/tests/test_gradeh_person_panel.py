"""Grade H Appraisal, People & progress: one line a person, and the person's panel (2026-11-03; boards H6a / H6b, canvas [design canvas link removed]).

Chris (22:35): "there are too many buttons per row, can we make the item selectable and open up a right panel to edit the details? like how our people user
page operates today".

What this suite holds:
  * H6a: the By person table is one line a person: no `.gh-act` column or buttons (Set appraiser, HOD, Reopen, Open), the name and one "Open ›" open the panel
    (data-person-open, the People > Users peek's mechanism), Appraiser and HOD are columns of their own (amber "Needs an appraiser", the purple "2 HODs · 50 : 50"
    pill with the split, amber "No HOD · BU CEO"), Stage keeps its short words with the full ones in the title (Disagrees as a tag), every cut cell has its full words
    in its title; the tick column and the bulk bar stay; By HOD is untouched (no person panel there)
  * H6b: the panel is a read-only GET fragment (/admin/gradeh/person/<pid>?fragment=1): where it stands, who appraises them (appraiser with where it came from,
    HOD or both HODs with each one's share and sign-off state, the BU CEO), their appraisal (the KPI table for route A, the line manager's ratings for route B),
    Reopen only when submitted and not released; the step pills and the KPI table are the person page's Grade H tab's own markup (one macro), the Change forms are the
    Set appraiser / Set HOD panels' own (one partial) and post to today's routes with the session token and a double-confirm
  * scope, exactly the list's: the super admin sees anyone on the list; a BG admin with gradeh.read sees only their own group's people, with no Change and no Reopen; a
    person off the list, a private-company row, another group's person: 404; a role without the item, an employee, signed out: refused; falsified (the scope check
    and the item check, each patched open)
  * after a save in the panel the list comes back with that person's panel open (?panel=person&pp=<pid>), on the page the person is on NOW (a change re-sorts the list),
    or with the panel dropped when the Show choice no longer holds them
  * no write on GET, no model call, one batched read (gradeh_admin_people(only=) once); no new write route; the one new GET is classified (module "gradeh")
Synthetic (ZZ9PL-*) on a fresh scratch database; the suite puts back what it changes.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Grade H Appraisal: one line a person and the person's panel")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA0, EMP = H.actors(a)
PFX, BG, BG2, CO, COR, CO2 = "ZZ9PL-", "ZZPL Group", "ZZPL Other Group", "ZZPL Unit A", "ZZPL Unit R", "ZZPL Unit O"
U, P = {}, {}
_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
import sqlite3  # noqa: E402

db = sqlite3.connect(a.DB_PATH, timeout=5.0)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")
BASE = "/admin/gradeh"
LIST = BASE + "?tab=people"


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
    h = resp.get_data(as_text=True) if hasattr(resp, "get_data") else resp
    h = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", h)
    m = re.search(r'<main id="main"[\s\S]*', h)
    h = m.group(0) if m else h
    h = re.sub(r"<[^>]+>", " ", h)
    return " ".join(h.replace("&#39;", "'").replace("&amp;", "&").replace("&quot;", '"').replace("&rsaquo;", "›").replace("&lsaquo;", "‹")
                    .replace("&middot;", "·").split())


def csrf(**kw):
    d = {"csrf_token": "tok"}
    d.update(kw)
    return d


def mk(k, grade="H", hod=None, mgr=None, co=CO, bg=BG, dept="ZZPL Dept", email=True):
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, job_grade, job_title, "
        "hod_id, manager_id, confirmation_date, email) VALUES (?,?, 'x', 'user', ?,?,?,?,?, 'Driver', ?,?, '2020-01-01', ?)",
        ((PFX + k).lower(), "ZZ PL " + k, PFX + k, bg, co, dept, grade, hod, mgr, ((PFX + k).lower() + "@example.test") if email else None)).lastrowid


def mk_admin(k, bg, role_builtin=None, role_id=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg, admin_role_id) "
                      "VALUES (?,?, 'x', 'admin', ?, ?, ?, ?)",
                      ((PFX + k).lower(), "ZZ PL " + k, PFX + k, bg, bg,
                       role_id or db.execute("SELECT id FROM admin_roles WHERE builtin=?", (role_builtin,)).fetchone()[0])).lastrowid


def person(k, route="A", hod=None, hod2=None, split=None, appraiser=None):
    pid = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route, hod_user_id, hod2_user_id, hod_split, appraiser_id) VALUES (?,?,?,?,?,?,?,?)",
                     (CID, PFX + k, U[k], route, U[hod] if hod else None, U[hod2] if hod2 else None, split, U[appraiser] if appraiser else None)).lastrowid
    P[k] = pid
    return pid


def lines(k, rows):
    for i, (nm, w, st, lm, why) in enumerate(rows):
        lid = db.execute("INSERT INTO gradeh_kpi_lines (cycle_id, person_id, kpi_name, weight, group_scale, sort_order) VALUES (?,?, ?,?, 'FIAMMA', ?)",
                         (CID, P[k], nm, w, i)).lastrowid
        db.execute("INSERT INTO gradeh_kpi_entries (cycle_id, person_id, line_id, staff_pct, lm_pct, lm_reason, lm_at) VALUES (?,?,?,?,?,?,datetime('now'))",
                   (CID, P[k], lid, st, lm, why))


def submit(k, ack="person", dis=False):
    db.commit()
    comp = run(lambda d: a.gradeh_computed(d, CID, P[k]))
    db.execute("INSERT INTO gradeh_appraisals (cycle_id, person_id, staff_submitted_at, lm_submitted_at, perf_value, perf_rating, perf_band, pot_score, pot_band, "
               "b_achievements, b_strengths, b_development, conversation_held, promo_nominate, ack_in_person, ack_in_person_on, ack_in_person_by, disagree_at) "
               "VALUES (?,?, '2026-11-07 02:00:00', '2026-11-10 02:00:00', ?,?,?,?,?, ?,?,?, 1, 'no', ?,?,?, ?)",
               (CID, P[k], comp["perf_value"], comp["perf_rating"], comp["perf_band"], comp["pot_score"], comp["pot_band"],
                "ZZ-ACH-" + k, "ZZ-STR-" + k, "ZZ-DEV-" + k, 1 if ack == "person" else 0, "2026-11-12" if ack == "person" else None,
                U["LM"] if ack == "person" else None, "2026-11-11 02:00:00" if dis else None))
    return comp


def hod_sign(hk, stage):
    db.execute("INSERT OR IGNORE INTO gradeh_signoffs(cycle_id, tier, stage, scope_key, signed_by) VALUES (?, 'hod', ?, ?, ?)", (CID, stage, str(U[hk]), U[hk]))


def snapshot():
    return {t: one("SELECT COUNT(*) FROM %s" % t) for t in ("gradeh_people", "gradeh_appraisals", "gradeh_kpi_lines", "gradeh_kpi_entries", "gradeh_ratings",
                                                              "gradeh_lp_answers", "gradeh_band_moves", "gradeh_reviews", "gradeh_hod_reviews", "gradeh_signoffs",
                                                              "gradeh_releases", "activity_log", "users")} | {
        "people_rows": [tuple(r) for r in db.execute("SELECT id, appraiser_id, hod_user_id, hod2_user_id, hod_split FROM gradeh_people ORDER BY id")]}


def frag(client, k, **kw):
    q = "&".join("%s=%s" % (x, y) for x, y in dict(kw, fragment=1).items())
    return client.get("%s/person/%d?%s" % (BASE, P[k], q))


def rows_of(html):
    """The By person table's body rows: {the person's pid: the row's HTML}."""
    m = re.search(r'<table[^>]*id="gh-people".*?</table>', html, re.S)
    return {int(re.search(r'data-person-open="(\d+)"', tr).group(1)): tr for tr in re.findall(r"<tr>.*?</tr>", m.group(0), re.S) if "data-person-open" in tr} if m else {}


if True:
    CID = run(lambda d: a.active_cycle_id(d))
    HALF0 = db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()["half"]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
    db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 1)", (CID,))
    for b_, c_ in ((BG, CO), (BG, COR), (BG2, CO2)):
        db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (b_, c_))
    U["BCA"] = mk("BCA", "21")
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, U["BCA"]))   # unit R has no BU CEO seated
    U["HA"] = mk("HA", "19", hod=U["BCA"])
    U["HB"] = mk("HB", "19", hod=U["BCA"])
    U["LM"] = mk("LM", "15")
    U["APR"] = mk("APR", "15")
    # PA: route A, three KPI lines, submitted and acknowledged in person; the appraiser is set by hand
    U["PA"] = mk("PA", mgr=U["LM"], hod=U["HA"])
    person("PA", "A", appraiser="APR")
    lines("PA", [("ZZ KPI one", 25, 106, 106, None), ("ZZ KPI two", 25, 90, 85, "ZZ-LM-REASON two orders moved"), ("ZZ KPI three", 50, 95, 95, None)])
    COMP_A = submit("PA")
    # PB: route B, eight attribute ratings, submitted, waiting to acknowledge
    U["PB"] = mk("PB", mgr=U["LM"], hod=U["HA"])
    person("PB", "B")
    for i, at in enumerate(a.GRADEH_ATTRIBUTES):
        db.execute("INSERT INTO gradeh_ratings (cycle_id, person_id, attr_key, rating) VALUES (?,?,?,?)", (CID, P["PB"], at["key"], 3 + (i % 2)))
    COMP_B = submit("PB", ack="wait")
    # PS: shared by HA (60) and HB (40); HA has signed both stages, HB none
    U["PS"] = mk("PS", mgr=U["LM"], hod=U["HA"])
    person("PS", "A", hod="HA", hod2="HB", split=60)
    lines("PS", [("ZZ KPI s1", 50, 100, 100, None), ("ZZ KPI s2", 50, 90, 92, None)])
    submit("PS")
    for st_ in ("pot", "perf"):
        hod_sign("HA", st_)
    # PN: route A, no appraiser (no line manager), no HOD, no KPI lines, not submitted
    U["PN"] = mk("PN", email=False)
    person("PN", "A")
    # PU: route B with a line manager, not submitted (nothing to reopen)
    U["PU"] = mk("PU", mgr=U["LM"], hod=U["HA"])
    person("PU", "B")
    # PR: in unit R (no BU CEO seated), submitted, the unit released: no Reopen, no Change
    U["PR"] = mk("PR", mgr=U["LM"], hod=U["HA"], co=COR)
    person("PR", "B")
    for at in a.GRADEH_ATTRIBUTES:
        db.execute("INSERT INTO gradeh_ratings (cycle_id, person_id, attr_key, rating) VALUES (?,?,?,?)", (CID, P["PR"], at["key"], 3))
    submit("PR", ack="wait")
    db.execute("INSERT INTO gradeh_releases (cycle_id, unit, released_by) VALUES (?,?,?)", (CID, COR, SU["id"]))
    # PD: does not agree
    U["PD"] = mk("PD", mgr=U["LM"], hod=U["HA"])
    person("PD", "B")
    for at in a.GRADEH_ATTRIBUTES:
        db.execute("INSERT INTO gradeh_ratings (cycle_id, person_id, attr_key, rating) VALUES (?,?,?,?)", (CID, P["PD"], at["key"], 3))
    submit("PD", ack="wait", dis=True)
    # the other group's person, a private-company row, and a normal person (not on the list)
    U["OTH"] = mk("OTH", "H", co=CO2, bg=BG2)
    person("OTH", "B")
    U["PRIV"] = mk("PRIV", "H")
    P["PRIV"] = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route, private_company) VALUES (?,?,?, 'B', 1)", (CID, PFX + "PRIV", U["PRIV"])).lastrowid
    U["NORM"] = mk("NORM", "15", mgr=U["LM"], hod=U["HA"])
    db.commit()
    a._seed_access_roles()
    NOROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZPL No Grade H', 'group')").lastrowid
    db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(NOROLE, k) for k in sorted(a.role_preset_items("view")) if k != "gradeh.read"])
    NOPPL = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZPL No People', 'group')").lastrowid
    db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(NOPPL, k) for k in sorted(a.role_preset_items("view")) if k != "people.read"])
    U["BGA"] = mk_admin("BGA", BG, role_builtin="bg")
    U["NOA"] = mk_admin("NOA", BG, role_id=NOROLE)
    U["NPA"] = mk_admin("NPA", BG, role_id=NOPPL)
    U["BG2A"] = mk_admin("BG2A", BG2, role_builtin="bg")
    db.commit()
    db.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%'")
    db.commit()

CSU = H.client_as(a, SU["id"])
CBG, CNO, CNP, CBG2, CEMP = (H.client_as(a, U["BGA"]), H.client_as(a, U["NOA"]), H.client_as(a, U["NPA"]), H.client_as(a, U["BG2A"]), H.client_as(a, EMP["id"]))
ON_LIST = ("PA", "PB", "PS", "PN", "PU", "PR", "PD")   # unit A and R of the first group; OTH (the other group's) is on the list too, for the super admin only

try:
    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("H6a: one line a person")
    r = CSU.get(LIST)
    h = r.get_data(as_text=True)
    rows = rows_of(h)
    s.check("the page draws one row for each of the %d people on the list (and none for the private-company row or the normal person)" % (len(ON_LIST) + 1),
            r.status_code == 200 and set(rows) == {P[k] for k in ON_LIST + ("OTH",)}, sorted(rows))
    tbl = re.search(r'<table[^>]*id="gh-people".*?</table>', h, re.S).group(0)
    heads = re.findall(r"<th[^>]*>(.*?)</th>", re.search(r"<thead>.*?</thead>", tbl, re.S).group(0), re.S)
    s.check("the headings: tick, Person, Unit, Route, Appraiser, HOD, Stage, Sign-in, and the Open column (no Leaders, no Actions)",
            [re.sub(r"<[^>]+>", "", x).strip() for x in heads] == ["", "Person", "Unit", "Route", "Appraiser", "HOD", "Stage", "Sign-in", "Open"], heads)
    s.check("the row has no .gh-act buttons: no Set appraiser, no HOD, no Reopen, no inline form; the cell is just one Open", "gh-act-top" not in tbl and "gh-act-links" not in tbl
            and "gh-btn" not in tbl and "<form" not in tbl and "Reopen" not in tbl and "Set appraiser" not in tbl and "?panel=appraiser" not in tbl and "?panel=hod" not in tbl
            and "panel=hod" not in tbl)
    s.check("every row opens the person's panel twice only: the name and one 'Open ›' (data-person-open, the Users peek's own mechanism), both at the panel's address",
            all(tr.count("data-person-open") == 2 and tr.count("Open &rsaquo;</a>") == 1 and ('href="%s/person/%d"' % (BASE, pid)) in tr for pid, tr in rows.items()))
    s.check("the row is one line: no second line, no <div> or <br> in a cell", all("<div" not in tr and "<br" not in tr for tr in rows.values()))
    s.check("the tick column, the pick-all and the bulk bar (Set appraiser for N, Set HOD for N) stay", all("data-gh-pick" in tr for tr in rows.values()) and "data-gh-all" in tbl
            and "data-gh-go" in h and "data-gh-go-hod" in h and "Set HOD for 0" in h and "Set appraiser for 0" in h)
    s.check("Appraiser is its own column: the name; an amber 'Needs an appraiser' where there is none (PN), the full words in the title",
            "ZZ PL APR" in re.sub(r"<[^>]+>", " ", rows[P["PA"]]) and "ZZ PL LM" in re.sub(r"<[^>]+>", " ", rows[P["PB"]])
            and '<span class="gh-warn">Needs an appraiser</span>' in rows[P["PN"]] and 'title="No appraiser: the file names none and they have no line manager on OneHR"' in rows[P["PN"]]
            and "Needs an appraiser" not in rows[P["PA"]])
    s.check("HOD is its own column: the name; a shared person's pill '2 HODs · 60 : 40' (both names and shares in the title); amber 'No HOD · BU CEO' for none",
            "ZZ PL HA" in re.sub(r"<[^>]+>", " ", rows[P["PA"]]) and '<span class="gh-chip is-shared">2 HODs · 60 : 40</span>' in rows[P["PS"]]
            and 'title="Both calibrate them: ZZ PL HA 60% · ZZ PL HB 40%"' in rows[P["PS"]] and '<span class="gh-warn">No HOD · BU CEO</span>' in rows[P["PN"]])
    s.check("Stage: the short words with the full words in the cell's title; Disagrees is a tag; the acknowledgement is in the title, not on a second line",
            re.search(r'<td title="With the BU CEO[^"]*">\s*<span class="gh-status is-bu">With BU CEO</span>', rows[P["PB"]]) is not None
            and "Acknowledged in person" in rows[P["PA"]] and '<span class="gh-dis-tag">Disagrees</span>' in rows[P["PD"]] and 'class="gh-dis-tag"' not in rows[P["PA"]]
            and "Waiting to acknowledge" in rows[P["PB"]] and "<div" not in rows[P["PB"]], rows[P["PB"]][-700:])
    s.check("every cut cell carries its full words in its title (person, unit, appraiser, HOD, stage, sign-in)",
            all(len(re.findall(r'<td title="[^"]+"', tr)) >= 6 for tr in rows.values()), [len(re.findall(r'<td title="[^"]+"', tr)) for tr in rows.values()])
    s.check("Sign-in: 'Yes' or the short 'No email', with the full words in the title", "No email" in rows[P["PN"]] and "No work email on OneHR" in rows[P["PN"]] and "No work email<" not in rows[P["PN"]] and ">Yes</td>" in rows[P["PA"]])
    s.check("the Route pill stays (KPI · 3 lines / Line manager)", "KPI · 3 lines" in rows[P["PA"]] and "Line manager" in rows[P["PB"]])
    s.check("the Leaders text that lived in the row (BU CEO · name, No BU CEO seated, the supervisor note) is not in the row any more", "BU CEO · ZZ" not in tbl and "No BU CEO seated" not in tbl
            and "supervisor, no line manager" not in tbl and "gh-leads" not in tbl)
    s.check("the person panel is on the page (kicker 'Grade H Appraisal', the steppers, 'Open their full page'), once", h.count('id="pnl-person"') == 1 and 'data-panel-peek' in h
            and "Grade H Appraisal</span>" in re.search(r'<aside class="adm-panel is-mid" id="pnl-person".*?</aside>', h, re.S).group(0).replace('<span class="adm-panel-pos"></span>', "")
            and "data-panel-prev" in h and "data-person-page" in h and "adm-panel-foot" in h)
    pnl = re.search(r'<aside class="adm-panel is-mid" id="pnl-person".*?</aside>', h, re.S).group(0)
    s.check("the panel is the peek's own shape: 720 wide (is-mid), a peek (the list stays live), with Previous and Next", "is-mid" in pnl and "data-panel-peek" in pnl and "data-panel-nav" not in pnl
            and "data-panel-prev" in pnl and "data-panel-next" in pnl)
    hodv = CSU.get(LIST + "&view=hod").get_data(as_text=True)
    s.check("By HOD is unchanged: its table, no person panel, no person rows", 'id="gh-hods"' in hodv and 'id="gh-people"' not in hodv and 'id="pnl-person"' not in hodv
            and "data-person-open" not in re.sub(r'<aside class="adm-panel.*?</aside>', "", hodv, flags=re.S))
    rb = CBG.get(LIST)
    hb = rb.get_data(as_text=True)
    s.check("a BG admin with gradeh.read sees the same lines for their own group, with the panel, and no tick column, bar or buttons",
            rb.status_code == 200 and set(rows_of(hb)) == {P[k] for k in ON_LIST} and 'id="pnl-person"' in hb and "data-gh-pick" not in hb and "data-gh-bar" not in hb
            and "Set appraiser" not in hb and "<form method=\"post\"" not in re.search(r'<table[^>]*id="gh-people".*?</table>', hb, re.S).group(0))
    pcss = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "gradeh_admin.css")).read()
    s.check("the table's CSS (round 4): every column that holds a pill or a fixed phrase has a width in rem; Person and Unit take the rest; the table never goes narrower than --gh-min; "
            "a cell has 0.875rem on its left; the row is Users' (7px above and below the text); the pills are nowrap with no ellipsis; the 130px Person column and the Actions rules are gone",
            all(("#gh-people col.gh-w-%s { width: " % k) in pcss and re.search(r"#gh-people col\.gh-w-%s \{ width: [\d.]+rem; \}" % k, pcss) for k in ("tick", "unit", "route", "appr", "hod", "stage", "sign", "open"))
            and "gh-w-person" not in pcss and "#gh-people { --gh-min: 56rem; min-width: var(--gh-min); }" in pcss and "#gh-people th, #gh-people td { padding-left: 0.875rem; padding-right: 0; }" in pcss
            and "#gh-people td { padding-top: 7px; padding-bottom: 7px; }" in pcss and "#gh-people td .gh-chip, #gh-people td .gh-dis-tag, #gh-people td .gh-warn, #gh-people td .gh-status" in pcss
            and "text-overflow" not in re.search(r"#gh-people td \.gh-chip[^}]*\}", pcss).group(0) and "gh-c-act { min-width" not in pcss and "gh-c-lead" not in pcss)
    s.check("a pill's cell and the Open cell carry their full words in a title (Route: 'KPI route: 3 KPI lines' / 'Line manager route'; Open: 'Open <name>'), and so does every text cell",
            'title="KPI route: 3 KPI lines"' in rows[P["PA"]] and 'title="Line manager route"' in rows[P["PB"]] and 'title="Open ZZ PL PA"' in rows[P["PA"]]
            and all(len(re.findall(r'<td[^>]* title="[^"]+"', tr)) == len(re.findall(r"<td[ >]", tr)) - (1 if "data-gh-pick" in tr else 0) for tr in rows.values()),
            [(len(re.findall(r'<td[^>]* title="[^"]+"', tr)), len(re.findall(r"<td[ >]", tr))) for tr in rows.values()][:3])
    sty = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "style.css")).read()
    kt = re.search(r'<div class="table-scroll"><table class="pp-gh-table">.*?</table>', frag(CSU, "PA").get_data(as_text=True), re.S).group(0)
    s.check("the panel's KPI table: the line manager's reason (heading, cells and the total's rating cell) is prose that wraps (.pp-gh-prose), so the table fits the 630px panel at every text size",
            kt.count("pp-gh-prose") >= 3 + 1 and ".pp-gh-table th.pp-gh-prose, .pp-gh-table td.pp-gh-prose { white-space: normal; overflow-wrap: anywhere;" in sty)

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("H6b: the panel, who sees it (scope exactly as the list)")
    s.check("the super admin opens every person on the list", all(frag(CSU, k).status_code == 200 for k in ON_LIST + ("OTH",)))
    other_cycle = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route) VALUES (?,?,?, 'B')",
                             (db.execute("INSERT INTO cycles (code, name, is_active) VALUES ('ZZPL-OLD', 'ZZPL old', 0)").lastrowid, PFX + "NORM", U["NORM"])).lastrowid
    db.commit()
    s.check("an unknown id, a private-company row and a row of another cycle's list (not on this cycle's list): 404", CSU.get("%s/person/%d?fragment=1" % (BASE, 999999)).status_code == 404
            and frag(CSU, "PRIV").status_code == 404 and CSU.get("%s/person/%d?fragment=1" % (BASE, other_cycle)).status_code == 404)
    s.check("a BG admin with gradeh.read opens their own group's people", all(frag(CBG, k).status_code == 200 for k in ON_LIST))
    s.check("...and the other group's person is a 404 (and theirs is the other admin's)", frag(CBG, "OTH").status_code == 404 and frag(CBG2, "OTH").status_code == 200
            and all(frag(CBG2, k).status_code == 404 for k in ON_LIST))
    s.check("a role WITHOUT gradeh.read is refused, and nothing of the person is in the answer", frag(CNO, "PA").status_code != 200 and "ZZ PL PA" not in frag(CNO, "PA").get_data(as_text=True)
            and "ZZ KPI one" not in frag(CNO, "PA", view="appraiser").get_data(as_text=True))
    s.check("an employee is refused; signed out goes to sign-in", frag(CEMP, "PA").status_code != 200 and "ZZ PL PA" not in frag(CEMP, "PA").get_data(as_text=True)
            and a.app.test_client().get("%s/person/%d?fragment=1" % (BASE, P["PA"])).status_code == 302)
    # falsified: each guard patched open lets the refused one in (so the checks above are what gates them)
    real_scope, real_can = a._gh_scope_people, a.admin_can
    a._gh_scope_people = lambda people, me: people
    try:
        s.check("falsified: with the scope check open the BG admin WOULD open the other group's person (so the 404 above is the scope check)", frag(CBG, "OTH").status_code == 200)
    finally:
        a._gh_scope_people = real_scope
    a.admin_can = lambda u, m, k: True
    try:
        s.check("falsified: with the item check open the role without gradeh.read WOULD open it (so the refusal above is the item check)", frag(CNO, "PA").status_code == 200)
    finally:
        a.admin_can = real_can
    s.check("...and both are closed again", frag(CBG, "OTH").status_code == 404 and frag(CNO, "PA").status_code != 200)
    nf = CSU.get("%s/person/%d" % (BASE, P["PA"]))
    s.check("without ?fragment=1 (a new tab, 'Open their full page') it is the person's full page, on the Grade H tab", nf.status_code == 302
            and nf.headers["Location"].endswith("/admin/users/%d?tab=gradeh" % U["PA"]), nf.headers.get("Location"))
    nb = CBG.get("%s/person/%d" % (BASE, P["PA"]))
    s.check("...for a BG admin too, and a person off the list is still a 404 there", nb.status_code == 302 and "/admin/users/%d?tab=gradeh" % U["PA"] in nb.headers["Location"]
            and CBG.get("%s/person/%d" % (BASE, P["OTH"])).status_code == 404)
    s.check("the route is GET only and classified: module 'gradeh' (a role reads it with gradeh.read), no new write route", a._ACCESS_PAGE_MODULE.get("admin_gradeh_person") == "gradeh"
            and a.app.url_map._rules_by_endpoint["admin_gradeh_person"][0].methods >= {"GET"} and "POST" not in a.app.url_map._rules_by_endpoint["admin_gradeh_person"][0].methods)
    os.environ["ONEHR_GRADEH"] = "0"
    s.check("with Grade H dark the panel is a 404, as every Grade H path", frag(CSU, "PA").status_code == 404)
    os.environ["ONEHR_GRADEH"] = "1"

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("H6b: what the panel says")
    fa = frag(CSU, "PA")
    ha = fa.get_data(as_text=True)
    ta = text(ha)
    s.check("it heads the panel the way the Users peek does: data-name, and the sub-line '<ID> · <title> · JG H · <department> · <unit>'",
            'data-name="ZZ PL PA"' in ha and re.search(r'data-sub="ZZ9PL-PA · Driver · JG H · ZZPL Dept · ZZPL Unit A"', ha) is not None, re.search(r'data-sub="[^"]*"', ha).group(0))
    s.check("the route chip reads 'KPI route · 3 lines'; a line manager route person's 'Line manager route'; a shared person's chip says Shared by two HODs",
            "KPI route · 3 lines" in ta and "Line manager route" in text(frag(CSU, "PB")) and "Shared by two HODs" in text(frag(CSU, "PS")) and "Shared by two HODs" not in ta)
    s.check("Where it stands: the staff and line manager steps, the acknowledgement, the HOD step", "Staff · KPI sent 7 Nov" in ta and "Line manager · submitted 10 Nov" in ta
            and "Acknowledged · in person" in ta and "HOD · 1 of 1 signed off" in ta, ta[:500])
    # the step pills and the KPI table are the person page's own markup (one macro, never a copy)
    pgh = CSU.get("/admin/users/%d?tab=gradeh" % U["PA"]).get_data(as_text=True)
    steps_p = re.search(r'<div class="pp-flow pp-gh-steps">.*?</div>', pgh, re.S).group(0)
    steps_f = re.search(r'<div class="pp-flow pp-gh-steps">.*?</div>', ha, re.S).group(0)
    tab_p = re.search(r'<div class="table-scroll"><table class="pp-gh-table">.*?</table></div>', pgh, re.S).group(0)
    tab_f = re.search(r'<div class="table-scroll"><table class="pp-gh-table">.*?</table></div>', ha, re.S).group(0)
    s.check("the step pills are the Grade H tab's own markup, byte for byte (one macro)", steps_p == steps_f and steps_f.count("pp-step") >= 4)
    s.check("...and so is the KPI table (route A), and route B's ratings table", tab_p == tab_f and "ZZ KPI one" in tab_f
            and re.search(r'<table class="pp-gh-table">.*?</table>', CSU.get("/admin/users/%d?tab=gradeh" % U["PB"]).get_data(as_text=True), re.S).group(0)
            == re.search(r'<table class="pp-gh-table">.*?</table>', frag(CSU, "PB").get_data(as_text=True), re.S).group(0))
    s.check("route A: the KPI table, every line with its weight, theirs and the line manager's figure and reason (the Grade H tab's numbers)",
            "ZZ KPI one 25% 106% 106%" in ta and "ZZ KPI two 25% 90% 85% ZZ-LM-REASON two orders moved" in ta and "ZZ KPI three 50% 95% 95%" in ta, ta[ta.find("KPI achievement"):][:400])
    tot = "Weighted achievement 100%% %s%% %s%%" % (a._gh_pct_str(a.gradeh_weighted_achievement([(25, 106), (25, 90), (50, 95)])), a._gh_pct_str(COMP_A["perf_value"]))
    s.check("...and the weighted totals, rating and band are gradeh_computed's (not worked out here)", tot in ta and COMP_A["perf_band"] in ta, (tot, ta[ta.find("Weighted"):][:160]))
    tb = text(frag(CSU, "PB"))
    s.check("route B: the line manager's eight ratings and the average gradeh_computed gives; no KPI table", all(at["title"][0] in tb for at in a.GRADEH_ATTRIBUTES)
            and ("Average %.2f" % COMP_B["perf_rating"]) in tb and "Weighted achievement" not in tb and "ZZ KPI" not in tb, tb[tb.find("The line manager"):][:300])
    s.check("Who appraises them: the appraiser (name, Employee ID, where it came from), the Grade H HOD, and the unit's BU CEO",
            "Appraiser ZZ PL APR" in ta and "%sAPR · named for Grade H" % PFX in ta and "HOD ZZ PL HA" in ta and "BU CEO ZZ PL BCA" in ta and "%sBCA · their unit's" % PFX in ta, ta[ta.find("Who appraises"):][:420])
    tbb = text(frag(CSU, "PB"))
    s.check("...a line manager appraiser says so", "Appraiser ZZ PL LM" in tbb and "%sLM · their line manager on OneHR" % PFX in tbb)
    ts = text(frag(CSU, "PS"))
    s.check("a shared person: both HODs, each with their share and sign-off state (HA signed both, HB neither)", "ZZ PL HA · 60%" in ts and "ZZ PL HB · 40%" in ts
            and re.search(r"ZZ PL HA · 60% [^·]*· Grade H HOD · signed off potential and performance", ts) is not None and re.search(r"ZZ PL HB · 40% [^·]*· Grade H HOD · not signed off yet", ts) is not None
            and "HODs ZZ PL HA" in ts, ts[ts.find("Who appraises"):][:520])
    tn = text(frag(CSU, "PN"))
    s.check("no appraiser: 'None yet' and 'Set one'; no HOD: 'None: the BU CEO covers them'; no KPI lines: said so", "Appraiser None yet" in tn and "Set one" in tn
            and "None: the BU CEO covers them" in tn and "No KPI lines yet" in tn and "Needs an appraiser" not in tn, tn[tn.find("Who appraises"):][:420])
    tr_ = text(frag(CSU, "PR"))
    s.check("a unit with no BU CEO seated says so, and why", "No BU CEO seated" in tr_ and "cannot be released" in tr_)
    td = text(frag(CSU, "PD"))
    s.check("a person who does not agree: the Disagrees tag and 'not calibrated' in Where it stands", "Disagrees" in td and "Does not agree · not calibrated" in td)

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("H6b: Change and Reopen (the super admin's), the forms are today's")
    s.check("Change is on the appraiser and the HOD lines for the super admin (Set one where there is none), and the BU CEO has no button",
            'href="/admin/gradeh/person/%d?view=appraiser&amp;tab=overview"' % P["PA"] in ha and 'href="/admin/gradeh/person/%d?view=hod&amp;tab=overview"' % P["PA"] in ha
            and ha.count('class="gh-pbtn"') == 2 and ">Change<" in ha and ">Set one<" in frag(CSU, "PN").get_data(as_text=True))
    s.check("Reopen only when the line manager has submitted and the unit is not released: PA, PB, PS, PD yes; PN, PU (not submitted) and PR (released) no",
            all("Submitted by the line manager on 10 Nov" in text(frag(CSU, k)) and 'action="/admin/gradeh/reopen"' in frag(CSU, k).get_data(as_text=True) for k in ("PA", "PB", "PS", "PD"))
            and all('action="/admin/gradeh/reopen"' not in frag(CSU, k).get_data(as_text=True) and "Submitted by the line manager" not in text(frag(CSU, k)) for k in ("PN", "PU", "PR")))
    rf = re.search(r'<form method="post" action="/admin/gradeh/reopen".*?</form>', ha, re.S).group(0)
    s.check("Reopen is the existing form: the session token, the pid, a reason asked in OneHR's own box, a red confirm, the audit-log reason; the button is red (.pp-reopen)",
            'name="csrf_token"' in rf and ('name="pid" value="%d"' % P["PA"]) in rf and 'data-confirm-reason-field="reason"' in rf and 'data-confirm-tone="danger"' in rf
            and 'data-confirm-reason-max="500"' in rf and 'data-confirm-ok="Reopen it"' in rf and "pp-reopen" in rf and 'name="next"' in rf)
    # a role with gradeh.read: the same panel, no Change, no Reopen, no form at all
    fb = frag(CBG, "PA")
    hb_ = fb.get_data(as_text=True)
    s.check("a role with gradeh.read gets the same panel (where it stands, who appraises them, their appraisal) with no Change, no Reopen and no form",
            fb.status_code == 200 and "Who appraises them" in hb_ and "ZZ KPI one" in hb_ and "Where it stands" in hb_ and "gh-pbtn" not in hb_ and "view=appraiser" not in hb_
            and "<form" not in hb_ and "Reopen" not in hb_ and "ZZ PL APR" in hb_)
    s.check("...asked for the Change view directly (?view=appraiser / hod) it still gets no form (the view is the super admin's)",
            all("<form" not in frag(CBG, "PA", view=v).get_data(as_text=True) and "Set the appraiser" not in frag(CBG, "PA", view=v).get_data(as_text=True) for v in ("appraiser", "hod")))
    s.check("a released unit has no Change: not the button, and the Change view falls back to the panel",
            "gh-pbtn" not in frag(CSU, "PR").get_data(as_text=True) and "gh-chv" not in frag(CSU, "PR", view="appraiser").get_data(as_text=True)
            and "Who appraises them" in frag(CSU, "PR", view="hod").get_data(as_text=True))
    s.check("'Open their full page' is hidden (data-nopage) for a role that cannot open the person page, and not for one that can",
            "data-nopage" in frag(CNP, "PA").get_data(as_text=True) and "data-nopage" not in frag(CBG, "PA").get_data(as_text=True) and "data-nopage" not in ha
            and ".adm-panel:has([data-nopage]) [data-person-page] { display: none; }" in pcss)
    # the Change forms
    fv = frag(CSU, "PN", view="appraiser")
    hv = fv.get_data(as_text=True)
    form = re.search(r'<form method="post" action="/admin/gradeh/appraiser".*?</form>', hv, re.S).group(0)
    s.check("Change > appraiser: '‹ Back to <name>', then the existing form: posts to /admin/gradeh/appraiser with the session token, the pid, a strict picker and a double-confirm",
            fv.status_code == 200 and "&lsaquo; Back to ZZ PL PN" in hv and ('href="/admin/gradeh/person/%d?tab=overview"' % P["PN"]) in hv and 'name="csrf_token"' in form
            and ('name="pid" value="%d"' % P["PN"]) in form and "data-pick" in form and 'name="appraiser_eid"' in form and 'data-confirm="Make the person you picked the appraiser of ZZ PL PN?' in form
            and 'data-confirm-ok="Set appraiser"' in form and 'id="gh-appr-form"' in form and 'form="gh-appr-form"' in hv and "Where it stands" not in hv)
    s.check("...its `next` is the panel's own address, which admin.js turns into the list with the panel open on this person", ('name="next" value="/admin/gradeh/person/%d"' % P["PN"]) in form)
    old = CSU.get(LIST + "&panel=appraiser&set=%d" % P["PN"]).get_data(as_text=True)
    oform = re.search(r'<form method="post" action="/admin/gradeh/appraiser".*?</form>', old, re.S).group(0)
    nrm = lambda f: re.sub(r'name="next" value="[^"]*"', 'name="next" value="X"', f)
    s.check("...and it is the SAME markup as the Set appraiser side panel's form (one partial), the old panel still opening for the person page's Change link", nrm(form) == nrm(oform)
            and 'id="pnl-appraiser"' in old)
    hs = frag(CSU, "PS", view="hod")
    hh = hs.get_data(as_text=True)
    hform = re.search(r'<form method="post" action="/admin/gradeh/hods".*?</form>', hh, re.S).group(0)
    old = CSU.get(LIST + "&panel=hod&set=%d" % P["PS"]).get_data(as_text=True)
    ohform = re.search(r'<form method="post" action="/admin/gradeh/hods".*?</form>', old, re.S).group(0)
    s.check("Change > HOD (a shared person): both HODs shown, the second picker, the split at 60 : 40, the existing form posts to /admin/gradeh/hods with the token and a double-confirm; "
            "the same markup as the Set HOD side panel", hs.status_code == 200 and "&lsaquo; Back to ZZ PL PS" in hh and "ZZ PL HA" in hform and "ZZ PL HB" in hform and 'name="hod2_eid"' in hform
            and '<option value="60" selected>' in hform and 'name="csrf_token"' in hform and "data-confirm=" in hform and nrm(hform) == nrm(ohform)
            and 'form="gh-hod-form"' in hh and "Remove the second HOD" in hh and 'action="/admin/gradeh/hods"' in hh)
    s.check("...the HOD form's wiring (the confirm box naming the picked HODs) is called by the fragment, and gradeh_admin.js exposes it",
            "onehrGradehWire" in hh and "window.onehrGradehWire = function" in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "gradeh_admin.js")).read())
    s.check("every POST form in the panel carries data-confirm (the admin standard)", all("data-confirm" in f for v in ("appraiser", "hod") for f in re.findall(r"<form method=\"post\".*?>", frag(CSU, "PS", view=v).get_data(as_text=True)))
            and all("data-confirm" in f for f in re.findall(r"<form method=\"post\".*?>", ha)))

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("the Grade H HOD role (3 Nov): a calibrator of the normal review is an HOD, a BG CEO / BU CEO seat is not")
    U["HCAL"] = mk("HCAL", "21")
    db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id, active) VALUES (?,?,?,?,1)", (BG, CO, "ZZPL Calib Group", U["HCAL"]))
    U["HBGC"] = mk("HBGC", "21")
    db.execute("UPDATE users SET bgceo_bg=? WHERE id=?", (BG, U["HBGC"]))
    U["PCAL"] = mk("PCAL", mgr=U["LM"], hod=U["HCAL"])
    person("PCAL", "B", hod="HCAL")
    U["PBGC"] = mk("PBGC", mgr=U["LM"], hod=U["HBGC"])
    person("PBGC", "B", hod="HBGC")
    db.commit()
    rr = rows_of(CSU.get(LIST).get_data(as_text=True))
    s.check("By person: the calibrator's person reads their name in HOD; the BG CEO's person reads amber 'No HOD · BU CEO'",
            "ZZ PL HCAL" in re.sub(r"<[^>]+>", " ", rr[P["PCAL"]]) and "No HOD · BU CEO" not in rr[P["PCAL"]] and "No HOD · BU CEO" in rr[P["PBGC"]])
    tc_, tb_ = text(frag(CSU, "PCAL")), text(frag(CSU, "PBGC"))
    s.check("the panel's HOD line: the calibrator is the person's HOD (with a Change); a BG CEO named as HOD is not: 'None: the BU CEO covers them' and why, in words naming only the two CEO seats",
            "HOD ZZ PL HCAL" in tc_ and "None: the BU CEO covers them" not in tc_ and "None: the BU CEO covers them" in tb_ and "hold a BU CEO or BG CEO seat" in tb_ and "calibrator seat" not in tb_, tb_[tb_.find("Who appraises"):][:420])
    real_has = a.gradeh_hod_has_role
    a.gradeh_hod_has_role = lambda db_, h_: a.hod_has_role(db_, h_)   # the OLD rule
    try:
        s.check("falsified: on the old rule the calibrator's person would read 'None: the BU CEO covers them' (so the HOD line above is the Grade H twin)",
                "None: the BU CEO covers them" in text(frag(CSU, "PCAL")))
    finally:
        a.gradeh_hod_has_role = real_has
    s.check("(put back) the calibrator is the HOD again", "HOD ZZ PL HCAL" in text(frag(CSU, "PCAL")))
    bp = text(CSU.get(LIST + "&panel=bulkhod&pick=%d,%d" % (P["PCAL"], P["PBGC"])))
    s.check("Set HOD for several: 'Now' names the calibrator as the HOD, and the BG CEO's person 'holds a BU CEO or BG CEO seat: BU CEO covers'", "Now: ZZ PL HCAL" in bp
            and "holds a BU CEO or BG CEO seat: BU CEO covers" in bp and "calibrator seat" not in bp, bp[bp.find("Set the HOD for"):][:400])

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("after a save the list comes back with the person's panel open")
    # as admin.js turns it: `next` becomes the list's own address with ?panel=person&pp=<id>
    back = "/admin/gradeh?tab=people&panel=person&pp=%d" % P["PN"]
    r = CSU.post(BASE + "/appraiser", data=csrf(pid=P["PN"], appraiser_eid=PFX + "APR", next=back))
    s.check("the POST goes to today's route and comes back to the list with ?panel=person&pp=<their id>", r.status_code == 302 and r.headers["Location"].endswith(back), r.headers.get("Location"))
    s.check("...the appraiser is set (audited, as always)", one("SELECT appraiser_id FROM gradeh_people WHERE id=?", (P["PN"],)) == U["APR"]
            and one("SELECT COUNT(*) FROM activity_log WHERE action LIKE 'gradeh%appraiser%'") >= 1)
    r2 = CSU.get(back)
    h2 = r2.get_data(as_text=True)
    s.check("the list opens with the flash and the row; the panel itself opens from the address (admin.js reads ?panel=person&pp=)", r2.status_code == 200 and 'data-person-open="%d"' % P["PN"] in h2
            and "appraiser" in text(h2).lower() and 'id="pnl-person"' in h2)
    s.check("...and the panel now reads the new appraiser, no longer 'None yet'", "Appraiser ZZ PL APR" in text(frag(CSU, "PN")) and "None yet" not in text(frag(CSU, "PN")).split("HOD")[0])
    # a save that re-sorts the list: the list is on the page the person is on NOW
    for i in range(55):
        k_ = "F%02d" % i
        U[k_] = mk(k_, mgr=U["LM"], hod=U["HA"], dept="ZZPL Dept F")
        person(k_, "B")
    kz = "ZZZ"
    U[kz] = mk(kz, email=True)   # sorts last by name, and needs an appraiser (no line manager): first on page 1 until it has one
    person(kz, "B")
    db.commit()
    ls_ = run(lambda d: a.gradeh_admin_people(d, CID))
    ix = next(i for i, p_ in enumerate(ls_) if p_["pid"] == P[kz])
    s.check("(setup) the person who needs an appraiser is on page 1 (those who need one sort first); once they have one they sort last, past page 1", ix < 50 and len(ls_) > 50, ix)
    r = CSU.post(BASE + "/appraiser", data=csrf(pid=P[kz], appraiser_eid=PFX + "APR", next="/admin/gradeh?tab=people&page=1&panel=person&pp=%d" % P[kz]))
    ls_ = run(lambda d: a.gradeh_admin_people(d, CID))
    ix = next(i for i, p_ in enumerate(ls_) if p_["pid"] == P[kz])
    pg_ = CSU.get(r.headers["Location"])
    ph = pg_.get_data(as_text=True)
    s.check("after the save they have moved off page 1: the list shown is the page they are on now (page %d), with their row in it and the pager saying so" % (ix // 50 + 1),
            ix >= 50 and 'data-person-open="%d"' % P[kz] in ph and "51–" in text(ph) and "Previous" in text(ph), (ix, text(ph)[-300:]))
    at_pa = next(i for i, p_ in enumerate(ls_) if p_["pid"] == P["PA"])
    s.check("...and the address wins over ?page=: a person asked for on the wrong page is shown on the page they are on", 'data-person-open="%d"' % P["PA"] in
            CSU.get(LIST + "&page=%d&panel=person&pp=%d" % (3 if at_pa < 50 else 1, P["PA"])).get_data(as_text=True))
    # the Show choice no longer holds them: the panel is dropped (the list, no ?panel / ?pp)
    r = CSU.get(LIST + "&show=need&panel=person&pp=%d" % P["PA"])
    s.check("a person the Show choice does not hold (PA needs no appraiser, Show = Need an appraiser): the list without the panel (redirect), never the Users page",
            r.status_code == 302 and "panel=" not in r.headers["Location"] and "pp=" not in r.headers["Location"] and "show=need" in r.headers["Location"], r.headers.get("Location"))
    s.check("...and a junk pp is ignored", CSU.get(LIST + "&panel=person&pp=zz").status_code == 200)

    # ------------------------------------------------------------------------------------------------------------------------------------
    s.section("read only: no write on GET, no model call, one batched read")
    before = snapshot()
    real_ai = a.ai_draft._chat_complete_call
    a.ai_draft._chat_complete_call = lambda *x, **k: (_ for _ in ()).throw(AssertionError("a model call from the panel"))
    real_adm = a.gradeh_admin_people
    calls = []

    def counting(db_, cid_, only=None):
        calls.append(only)
        return real_adm(db_, cid_, only=only)
    a.gradeh_admin_people = counting
    try:
        codes = [frag(c, k, **kw).status_code for c in (CSU, CBG) for k in ON_LIST for kw in ({}, {"view": "appraiser"}, {"view": "hod"})]
        calls_one = []
        calls[:] = []
        frag(CSU, "PA")
        calls_one = list(calls)
    finally:
        a.gradeh_admin_people = real_adm
        a.ai_draft._chat_complete_call = real_ai
    after = snapshot()
    s.check("reading every person's panel (and both Change views) as the super admin and a BG admin writes nothing: no Grade H row, no user, no activity row", all(c == 200 for c in codes) and before == after,
            {k: (before[k], after[k]) for k in before if before[k] != after[k]})
    s.check("...with no model call (the call is patched to fail) and one read of the list's own row (gradeh_admin_people(only=<id>) once)", calls_one == [P["PA"]], calls_one)
    s.check("the List page reading itself writes nothing either", (lambda b_: (CSU.get(LIST), CBG.get(LIST), b_ == snapshot())[2])(snapshot()))

finally:
    os.environ["ONEHR_GRADEH"] = _ENV0 if _ENV0 is not None else ""
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE cycles SET half=? WHERE id=?", (HALF0, CID))
        d.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%'")
        d.execute("DELETE FROM gradeh_releases WHERE cycle_id=? AND unit=?", (CID, COR))
        d.execute("DELETE FROM gradeh_people WHERE employee_id=? AND cycle_id!=?", (PFX + "NORM", CID))
        d.execute("DELETE FROM cycles WHERE code='ZZPL-OLD'")
        d.commit()

sys.exit(s.done())
