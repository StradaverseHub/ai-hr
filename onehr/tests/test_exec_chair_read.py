"""The Executive Chairman view, piece P2: what he reads across every business group (Chris, 2026-10-29: "Approve all picks";
plan: OneHR/Executive Chairman view/Build plan (staging) v1.md; canvas boards 1 and 2). Dark behind ONEHR_CHAIR=1.

This is personal data and talent bands across every business group in one person's hands, so every read is held here:
  * flag off: every new endpoint is 404 (signed out still goes to sign in), nobody has the Group view, and the staff and BG
    CEO dashboards are byte for byte the same whether the flag is on or off
  * flag on: only the seat holder is let in (staff, BG CEO, HOD, super admin, BG admin and signed-out are refused on the
    summary and the download, and a crafted ?view=chairgrp is Mine for anyone else, with none of his data in it)
  * he sees only people released to leaders (step 1) whose bands are final (BG CEO, calibration group or super admin): a
    group with nothing released reads "Not released yet" with no count and no name anywhere in the payload; a group's people
    are there once released; the BG CEO's locked band sits over a lower tier's, never over the super admin's or a group's;
    a working (unlocked) BG CEO move does not leak
  * ONE batched read: the statement count does not grow with the people
  * a name opens a summary that carries exactly the allowed keys, built on the server; a remark and a past talent status
    seeded on the person never appear (falsified by reading the payload text)
  * the Excel holds only Stars and Super Stars, final released bands, formula-safe cells, HRIS's spelling, and each
    download is one audit row (who, how many rows, which filter)
  * the dashboard cards carry the counts, the share, the bar and "n of m units locked"; his leaders' step has a named hook and
    no link; the AI insight slot is P3's card (its own suite); his own review parts are not on the page
Synthetic ZZ9ER people only; a fresh_db suite, so Suite.done() puts the scratch copy back."""
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Executive Chairman, P2: the group-wide read")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
os.environ.pop("ONEHR_CHAIR", None)
SU, _BGA0, _E = H.actors(a)
SRC = open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read()
JS = open(os.path.join(H.REPO, "static", "journey_chat.js"), encoding="utf-8").read()


def run(fn, path="/"):
    with a.app.test_request_context(path):
        return fn(a.get_db())


def put(key, val):
    def f(d):
        if val is None:
            d.execute("DELETE FROM app_settings WHERE key=?", (key,))
        else:
            d.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", (key, str(val)))
        d.commit()
    run(f)


def n_log(action):
    return H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action=?", (action,))


BG1, BG2, BG3 = "ZZ9ER BG ONE", "ZZ9ER BG TWO", "ZZ9ER BG THREE"
CA, CB, CC, CD = "ZZ9ER ONE A", "ZZ9ER ONE B", "ZZ9ER TWO C", "ZZ9ER THREE D"
ids = {}
with a.app.test_request_context("/"):
    db = a.get_db()
    # the scratch copy's active cycle is a Mid-Year: this suite runs a Year-End with a potential result
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycles SET half=2, kind='year_end', no_potential=NULL, min_job_grade=NULL WHERE id=?", (CID,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base if c != "id"]

    def mk(tag, bg, co, mgr=None, **kw):
        eid = "ZZ9ER-" + tag
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ ER " + tag, display_name=None, email=None,
                 hod_id=None, manager_id=ids.get(mgr), buceo_bg=None, buceo_company=None, bgceo_bg=None,
                 confirmation_date="2020-01-01", left_at=None, role="user", is_demo=0, user_role_id=None, job_grade="14",
                 business_group=bg, company=co, department="ZZ Dept " + tag[:1], job_title="SENIOR MANAGER " + tag,
                 years_of_service=5)
        v.update(kw)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v.get(c) for c in cols])
        ids[tag] = db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
    mk("CH", BG1, CA)                        # the Executive Chairman: in a group himself, never in his own read
    mk("MG", BG1, CA)                        # a line manager of some, to be a name on the summary
    for tag in ("P1", "P2", "P3", "P7", "P8", "P9", "P10"):
        mk(tag, BG1, CA, "MG")
    for tag in ("P4", "P5", "P6", "P11"):
        mk(tag, BG1, CB, "MG")
    for tag in ("Q1", "Q2", "Q3", "Q4"):
        mk(tag, BG2, CC, "MG")
    for tag in ("R1", "R2"):
        mk(tag, BG3, CD, "MG")
    mk("ST", BG1, CB)                        # plain staff, never in the cycle's results
    mk("BC", BG1, CA, bgceo_bg=BG1)          # a BG CEO of group one
    mk("HD", BG1, CA)                        # an HOD
    db.execute("UPDATE users SET hod_id=? WHERE id=?", (ids["HD"], ids["P1"]))
    for tag, bg in (("BA", BG1),):           # a BG admin
        db.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, admin_bg) "
                   "VALUES (?, ?, 'x', 'admin', ?, ?, ?)", ("zz9er-" + tag.lower(), "ZZ ER " + tag, "ZZ9ER-" + tag, bg, bg))
        ids[tag] = db.execute("SELECT id FROM users WHERE employee_id=?", ("ZZ9ER-" + tag,)).fetchone()[0]
    # the final bands: (tag, pm band, pm source, pot band, pot source, released to leaders)
    PLAN = [("P1", "AE", "bgceo", "High", "bgceo", True), ("P2", "OU", "bgceo", "High", "bgceo", True),
            ("P3", "ME", "bgceo", "High", "bgceo", True), ("P4", "AE", "bgceo", "Mid", "bgceo", True),
            ("P5", "ME", "bgceo", "Mid", "bgceo", True), ("P6", "UA", "bgceo", "Low", "bgceo", True),
            ("P7", "AE", "hod", "High", "hod", True),          # released, but only the HOD has decided: not final
            ("P8", "AE", "hod", "High", "hod", True),          # the same, until the BG CEO's locked band sits over it
            ("P9", "AE", "super", "High", "super", True),      # the super admin's: a BG CEO band never covers it
            ("P10", "AE", "bgceo", "High", "bgceo", False),    # final but not released: he does not see them
            ("P11", "AE", "hod", "High", "hod", True),         # an unlocked BG CEO working move must not leak
            ("Q1", "OU", "group", "High", "group", True), ("Q2", "ME", "group", "High", "group", True),
            ("Q3", "ME", "group", "Mid", "group", True), ("Q4", "BE", "group", "Low", "group", True),
            ("R1", "AE", "bgceo", "High", "bgceo", False), ("R2", "ME", "bgceo", "Mid", "bgceo", False),
            ("CH", "AE", "bgceo", "High", "bgceo", True)]
    for tag, pm, pms, pot, pots, rel in PLAN:
        u_ = db.execute("SELECT * FROM users WHERE id=?", (ids[tag],)).fetchone()
        db.execute("INSERT INTO rating_records(cycle_id, subject_id, employee_id, full_name, business_group, company, "
                   "department, job_grade, job_title, pm_final_band, pm_final_source, pot_final_band, pot_final_source) "
                   "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", (CID, ids[tag], u_["employee_id"], u_["full_name"],
                                                          u_["business_group"], u_["company"], u_["department"], "14",
                                                          u_["job_title"], pm, pms, pot, pots))
        if rel:
            db.execute("INSERT INTO leader_releases(cycle_id, subject_id, kind, released_by) VALUES (?,?,'talent',?)",
                       (CID, ids[tag], SU["id"]))
    # the BG CEOs' locks: group one locks unit A only (unit B is open); group two locks the whole group (both sessions)
    db.execute("INSERT INTO talent_box_bu_locks(period_id, cycle_id, business_group, company, locked_by) VALUES (?,?,?,?,?)",
               (CID, CID, BG1, CA, SU["id"]))
    sess = {}
    for tbl, bg, locked in (("pm_calibration_sessions", BG1, None), ("calibration_sessions", BG1, None),
                            ("pm_calibration_sessions", BG2, "2026-11-20 03:00:00"),
                            ("calibration_sessions", BG2, "2026-11-20 03:00:00")):
        db.execute("INSERT INTO %s(cycle_id, tier, scope_key, business_group, scope_label, locked_at) VALUES (?,?,?,?,?,?)"
                   % tbl, (CID, "bgceo", bg, bg, bg, locked))
        sess[(tbl, bg)] = db.execute("SELECT id FROM %s WHERE cycle_id=? AND tier='bgceo' AND scope_key=?" % tbl,
                                     (CID, bg)).fetchone()[0]

    def adj(tbl, bg, tag, band):
        t = "pm_calibration_adjustments" if tbl.startswith("pm") else "calibration_adjustments"
        db.execute("INSERT INTO %s(session_id, subject_id, original_band, adjusted_band, justification, adjusted_by, "
                   "seen_band, pinned) VALUES (?,?,?,?,?,?,?,?)" % t, (sess[(tbl, bg)], ids[tag], band, band, "", SU["id"], band, "lm"))
    # P8 (unit A, locked): the BG CEO's pinned band sits over the HOD's -> final, a Star (OU / Mid)
    adj("pm_calibration_sessions", BG1, "P8", "OU")
    adj("calibration_sessions", BG1, "P8", "Mid")
    # P9: the super admin's band stays, whatever a BG CEO row says
    adj("pm_calibration_sessions", BG1, "P9", "ME")
    adj("calibration_sessions", BG1, "P9", "Low")
    # P11 (unit B, NOT locked, session NOT locked): a working move, never final, never his
    adj("pm_calibration_sessions", BG1, "P11", "OU")
    adj("calibration_sessions", BG1, "P11", "High")
    # a remark and a past talent status on P5 (a Solid Core now, a Super Star three years running before): neither may
    # reach his summary
    REMARK = "ZZ9ER-REMARK-never-shown-to-him"
    db.execute("UPDATE pm_calibration_adjustments SET justification=? WHERE subject_id=?", (REMARK, ids["P8"]))
    for yr in (2023, 2024, 2025):
        db.execute("INSERT OR REPLACE INTO talent_status_history(subject_id, year, category, performance_band, "
                   "potential_band, source) VALUES (?,?,?,?,?,'import')", (ids["P5"], yr, "Super Star", "OU", "High"))
    # his own 360: he rates three colleagues, two submitted
    for tag, status in (("P1", "submitted"), ("P2", "submitted"), ("P3", "pending")):
        db.execute("INSERT OR REPLACE INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) "
                   "VALUES (?,?,?,'line_manager',?)", (CID, ids[tag], ids["CH"], status))
    db.commit()
    PERIOD = dict(a.active_pm_period(db))
CH, MG, ST, BC, HD, BA = (ids[k] for k in ("CH", "MG", "ST", "BC", "HD", "BA"))
EXPECT = {"all": 12, BG1: 8, BG2: 4, CA: 5, CB: 3}
STARS_ALL = {"P1", "P2", "P3", "P4", "P8", "P9", "Q1", "Q2"}      # Super Star + Star, released and final
NOT_SEEN = ("P7", "P10", "P11", "R1", "R2", "CH")                  # never in his read
SUP, BGC, STC, BCC, HDC, CHC = (H.client_as(a, x) for x in (SU["id"], BA, ST, BC, HD, CH))
SIGNED_OUT = a.app.test_client()
_real_window, _real_open = a.window_closed, a.cycle_is_open
a.window_closed = lambda *x, **k: None
a.cycle_is_open = lambda *x, **k: True
HIST = "/review/chat/history?journey=1&view=chairgrp&stage=chair_group"
SUM, XLS = "/review/chair/summary", "/review/chair/stars.xlsx"


def j(r):
    return json.loads(r.get_data(as_text=True))


def names_in(text):
    return [t for t in ids if "ZZ ER " + t + '"' in text and t not in ("MG",)]


try:
    put("exec_chair_id", CH)
    put("exec_chair_delegate_id", None)
    put("exec_chair_team", None)

    # ----------------------------------------------------------------------------------------------------- flag off
    s.section("flag off: every new endpoint is 404, nobody has the Group view, the dashboards are unchanged")
    s.check("the endpoints are registered and are in CHAIR_ENDPOINTS (so the gate holds them)",
            {"chair_person_summary", "chair_stars_download"} <= set(a.app.view_functions)
            and {"chair_person_summary", "chair_stars_download"} <= a.CHAIR_ENDPOINTS)
    s.check("the endpoint-based gate is registered once", SRC.count("def _chair_gate(") == 1)
    for path in (SUM + "?id=%d" % ids["P1"], XLS):
        s.check("flag off: the chair gets 404 on " + path.split("?")[0], CHC.get(path).status_code == 404,
                CHC.get(path).status_code)
        s.check("...so does the super admin", SUP.get(path).status_code == 404)
        r = SIGNED_OUT.get(path)
        s.check("...signed out still goes to sign in (a 404 would fail the deploy's route probe)",
                r.status_code == 302 and "/login" in r.headers.get("Location", ""), (r.status_code, r.headers.get("Location")))
    s.check("flag off: nobody has the Group view, the chair included", all(
        a.CHAIR_VIEW not in run(lambda d, x=x: a._journey_leader_views(d, x)) for x in
        (run(lambda d, i=i: d.execute("SELECT * FROM users WHERE id=?", (i,)).fetchone()) for i in (CH, BC, HD, ST))))
    s.check("flag off: no download row was written", n_log("chair_stars_download") == 0)
    off = {k: v.get("/dashboard").get_data(as_text=True) for k, v in (("staff", STC), ("bgceo", BCC), ("hod", HDC))}
    off_j = {k: v.get("/review/journey").get_data(as_text=True) for k, v in (("staff", STC), ("bgceo", BCC))}
    off_chair = CHC.get("/dashboard").get_data(as_text=True)
    s.check("flag off: even the chair's dashboard has no chair card", "ec-bgc" not in off_chair and "Talent by business group"
            not in off_chair)

    # ------------------------------------------------------------------------------------------------------ flag on
    os.environ["ONEHR_CHAIR"] = "1"
    s.section("flag on: the dashboards of everyone who isn't the chair are byte for byte what they were")
    for k, c in (("staff", STC), ("bgceo", BCC), ("hod", HDC)):
        on = c.get("/dashboard").get_data(as_text=True)
        s.check("%s's dashboard is the same with the flag on" % k, on == off[k], (len(on), len(off[k])))
        s.check("...and has no chair card or word", "ec-bgc" not in on and "Talent by business group" not in on
                and "Group Talent Box" not in on)

    for k, c in (("staff", STC), ("bgceo", BCC)):
        s.check("%s's journey page is the same with the flag on (no Group tab, no new strings)" % k,
                c.get("/review/journey").get_data(as_text=True) == off_j[k] and 'view=chairgrp' not in off_j[k])

    s.section("flag on: only the seat holder is let in")
    p1 = "?id=%d" % ids["P1"]
    for who, c in (("a plain employee", STC), ("a BG CEO", BCC), ("an HOD", HDC), ("the super admin", SUP),
                   ("a BG admin", BGC)):
        s.check("%s is refused the summary (403)" % who, c.get(SUM + p1).status_code == 403, c.get(SUM + p1).status_code)
        s.check("...and the download (403)", c.get(XLS).status_code == 403, c.get(XLS).status_code)
    s.check("signed out goes to sign in on both", all(SIGNED_OUT.get(x).status_code == 302 for x in (SUM, XLS, SUM + p1)))
    s.check("no refused download wrote an audit row", n_log("chair_stars_download") == 0)
    s.check("the Group view is offered to the chair and to nobody else", a.CHAIR_VIEW in run(
        lambda d: a._journey_leader_views(d, d.execute("SELECT * FROM users WHERE id=?", (CH,)).fetchone()))
        and all(a.CHAIR_VIEW not in run(lambda d, i=i: a._journey_leader_views(d, d.execute(
            "SELECT * FROM users WHERE id=?", (i,)).fetchone())) for i in (BC, HD, ST, MG)))
    s.check("a crafted ?view=chairgrp is Mine for anyone else, with none of his data in the page or the history", all(
        'data-view="chairgrp"' not in c.get("/review/journey?view=chairgrp").get_data(as_text=True)
        and '"readonly"' not in c.get(HIST).get_data(as_text=True)
        and not names_in(c.get(HIST).get_data(as_text=True)) for c in (STC, BCC, HDC)))
    s.check("the code holds the people read for anyone but the chair: _chair_people is empty for them", all(
        not run(lambda d, i=i: a._chair_people(d, d.execute("SELECT * FROM users WHERE id=?", (i,)).fetchone()))["people"]
        for i in (BC, HD, ST, MG)) and not run(lambda d: a._chair_people(d, None))["people"])
    s.check("...and _chair_box_payload is None for them", run(lambda d: a._chair_box_payload(
        d, d.execute("SELECT * FROM users WHERE id=?", (BC,)).fetchone())) is None)

    # ------------------------------------------------------------------------------------- who is in his read
    s.section("he sees only the released, final bands")
    P = run(lambda d: a._chair_people(d, d.execute("SELECT * FROM users WHERE id=?", (CH,)).fetchone()))
    got = {k for k, v in ids.items() if v in P["by_id"]}
    s.check("the people in his read are exactly the released ones whose bands are final", got == (
        {"P1", "P2", "P3", "P4", "P5", "P6", "P8", "P9", "Q1", "Q2", "Q3", "Q4"}), sorted(got))
    s.check("...not P7 (HOD only), P10 (not released), P11 (a working move), the unreleased group, nor himself",
            not any(t in got for t in NOT_SEEN))
    by = {k: P["by_id"][v] for k, v in ids.items() if v in P["by_id"]}
    s.check("the BG CEO's locked band covers the HOD's (P8 is a Star: OU, Mid)", by["P8"]["cat"] == "Star"
            and (by["P8"]["perf"], by["P8"]["pot"]) == ("OU", "Mid"), by["P8"])
    s.check("...but never the super admin's (P9 stays a Super Star: AE, High, whatever a BG CEO row says)",
            by["P9"]["cat"] == "Super Star" and (by["P9"]["perf"], by["P9"]["pot"]) == ("AE", "High"), by["P9"])
    s.check("the categories come from talent_category, the one rule", all(
        v["cat"] == a.talent_category(v["perf"], v["pot"]) for v in P["people"]))
    s.check("business groups: one and two are released, three is not", P["bgs"][BG1]["released"] and P["bgs"][BG2]["released"]
            and not P["bgs"][BG3]["released"] and P["bgs"][BG3]["n"] == 0, {k: v["n"] for k, v in P["bgs"].items()})
    s.check("units locked: group one has 1 of 2 (unit A), group two 1 of 1 (the whole group), all groups 2 of 3",
            a._chair_units_text(P, BG1) == (1, 2) and a._chair_units_text(P, BG2) == (1, 1)
            and a._chair_units_text(P) == (2, 3), (a._chair_units_text(P, BG1), a._chair_units_text(P, BG2),
                                                   a._chair_units_text(P)))
    s.check("released_at is when step 1 went out (a date, in MYT)", bool(P["released_at"]) and re.match(r"\d+ \w+ 20\d\d", P["released_at"]),
            P["released_at"])

    # ------------------------------------------------------------------ one batched read
    s.section("ONE batched read: the statement count does not grow with the people")

    def count_stmts():
        n = [0]
        with a.app.test_request_context("/"):
            d = a.get_db()
            d.set_trace_callback(lambda q: n.__setitem__(0, n[0] + 1))
            a._chair_people(d, d.execute("SELECT * FROM users WHERE id=?", (CH,)).fetchone())
            d.set_trace_callback(None)
        return n[0]
    before = count_stmts()
    with a.app.test_request_context("/"):
        d = a.get_db()
        base_row = dict(d.execute("SELECT * FROM users WHERE id=?", (ids["P1"],)).fetchone())
        c2 = [c for c in base_row if c != "id"]
        for i in range(40):
            eid = "ZZ9ER-BULK%d" % i
            v = dict(base_row, username=eid.lower(), employee_id=eid, full_name="ZZ ER BULK%d" % i)
            d.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(c2), ",".join("?" * len(c2))), [v.get(c) for c in c2])
            uid = d.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
            d.execute("INSERT INTO rating_records(cycle_id, subject_id, employee_id, full_name, business_group, company, "
                      "department, job_grade, job_title, pm_final_band, pm_final_source, pot_final_band, pot_final_source) "
                      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", (CID, uid, eid, v["full_name"], BG1, CA, "ZZ", "14", "T",
                                                             "ME", "bgceo", "Mid", "bgceo"))
            d.execute("INSERT INTO leader_releases(cycle_id, subject_id, kind, released_by) VALUES (?,?,'talent',?)",
                      (CID, uid, SU["id"]))
        d.commit()
    after = count_stmts()
    s.check("40 more released people, the same number of statements", before == after and before > 0, (before, after))
    s.check("...and they are all in the read (a count, not a skip)", run(lambda d: len(a._chair_people(
        d, d.execute("SELECT * FROM users WHERE id=?", (CH,)).fetchone())["people"])) == 12 + 40)
    run(lambda d: (d.execute("DELETE FROM leader_releases WHERE subject_id IN (SELECT id FROM users WHERE employee_id LIKE 'ZZ9ER-BULK%')"),
                   d.execute("DELETE FROM rating_records WHERE employee_id LIKE 'ZZ9ER-BULK%'"),
                   d.execute("DELETE FROM users WHERE employee_id LIKE 'ZZ9ER-BULK%'"), d.commit()))
    s.check("...taken out again: back to the twelve", run(lambda d: len(a._chair_people(
        d, d.execute("SELECT * FROM users WHERE id=?", (CH,)).fetchone())["people"])) == 12)

    # ------------------------------------------------------------------ the Group Talent Box
    s.section("the Group Talent Box: his view, read only, in the journey")
    pg = CHC.get("/review/journey?view=chairgrp&stage=chair_group")
    html = pg.get_data(as_text=True)
    s.check("he opens it (200) with the Group tab and the view on the chat", pg.status_code == 200
            and 'data-view="chairgrp"' in html and 'view=chairgrp' in html and ">Group<" in html, pg.status_code)
    r = CHC.get(HIST)
    hj = j(r)
    d0 = (hj.get("overview") or {}).get("data") or {}
    s.check("the history carries his box, read only, with the status line and the download", r.status_code == 200
            and hj["stage"] == "chair_group" and d0.get("readonly") is True and d0.get("tier") == "chair"
            and d0.get("status_text") == "Read only: final bands as the BG CEOs locked them"
            and d0.get("download_label") == "Download Stars and Super Stars (Excel)", (hj.get("stage"), d0.get("tier")))
    s.check("the chat box is locked (nothing is typed here)", (hj.get("overview") or {}).get("chat_lock"))
    s.check("all groups: 12 placed, the nine boxes add up, the columns and rows agree", d0["placed"] == EXPECT["all"]
            and sum(c["n"] for c in d0["cells"]) == 12 and sum(c["n"] for c in d0["cols"]) == 12
            and sum(c["n"] for c in d0["rows"]) == 12, d0["placed"])
    cell = {c["key"]: c for c in d0["cells"]}
    s.check("the boxes hold the right people: Super Star box = P1, P2, P9, Q1; the Star box (mid perf, high pot) = P3, Q2",
            {p["name"][6:] for p in cell["high|High"]["people"]} == {"P1", "P2", "P9", "Q1"}
            and {p["name"][6:] for p in cell["mid|High"]["people"]} == {"P3", "Q2"}
            and cell["high|High"]["label"] == "Super Star", {p["name"] for p in cell["high|High"]["people"]})
    s.check("the people carry no remark, no 360 line, no KPI line, no competency, no past status, no insight keys",
            all(set(p) <= {"id", "name", "dept", "grade", "company", "bg_label", "bu", "perf", "pot", "category", "moved", "up",
                           "from_cat", "from_key", "orig_cat", "recat", "perf_src", "pot_src", "locked", "trail", "grp",
                           "newly", "behalf_lm", "bugrp", "bucalls", "is_self"} for c in d0["cells"] for p in c["people"]))
    s.check("...and no unreleased, not-final or own name is in the payload", not any(
        "ZZ ER %s\"" % t in json.dumps(d0) for t in NOT_SEEN))
    s.check("...nor the seeded remark or a past status word for P5 (a Solid Core now)", REMARK not in json.dumps(hj)
            and "2023" not in json.dumps(d0) and not any(p["name"].endswith("P5") and p["category"] != "Solid Core"
                                                         for c in d0["cells"] for p in c["people"]))
    s.check("the BG row has every group; group three (and every real group, none released in this copy) says it is not "
            "released with no count", {g["key"] for g in d0["bgs"] if g["released"]} == {BG1, BG2}
            and all(g["n"] is None for g in d0["bgs"] if not g["released"]) and BG3 in {g["key"] for g in d0["bgs"]})
    d1 = j(CHC.get(HIST + "&bg=" + BG1))["overview"]["data"]
    s.check("one group narrows it (8 placed), and its BU row lists the units with their locks", d1["placed"] == EXPECT[BG1]
            and d1["bg"] == BG1 and [(c["key"], c["locked"]) for c in d1["companies"]] == [(CA, True), (CB, False)],
            (d1["placed"], d1["companies"]))
    d2 = j(CHC.get(HIST + "&bg=" + BG1 + "&company=" + CA))["overview"]["data"]
    s.check("one unit narrows it further (5 placed: P1, P2, P3, P8, P9)", d2["placed"] == EXPECT[CA] and {
        p["name"][6:] for c in d2["cells"] for p in c["people"]} == {"P1", "P2", "P3", "P8", "P9"}, d2["placed"])
    d3 = j(CHC.get(HIST + "&bg=" + BG1 + "&company=" + CC))["overview"]["data"]
    s.check("a unit of another group is no unit of this one: it widens to the group", d3["placed"] == EXPECT[BG1])
    d4 = j(CHC.get(HIST + "&bg=NOT-A-GROUP"))["overview"]["data"]
    s.check("an unknown group widens to all, never to nothing or something else", d4["placed"] == EXPECT["all"] and d4["bg"] == "")
    d5 = j(CHC.get(HIST + "&bg=" + BG3))["overview"]["data"]
    txt5 = json.dumps(d5)
    s.check("a group with nothing released: 'Not released yet', no count, no box content, no name (R1, R2) anywhere",
            d5["not_released"] is True and d5["placed"] == 0 and d5["count_text"] == "Not released yet"
            and all(c["n"] == 0 and not c["people"] for c in d5["cells"]) and sum(c["n"] for c in d5["cols"]) == 0
            and "ZZ ER R1" not in txt5 and "ZZ ER R2" not in txt5 and d5["companies"] == [], d5["count_text"])
    s.check("...and nothing of group three is in the all-groups numbers", d0["placed"] == 12)
    ttl = j(CHC.get(HIST))["nav_html"]
    s.check("the left panel lists all business groups and each group, group three as 'Not released yet'",
            "All business groups" in ttl and "Not released yet" in ttl and "units locked" in ttl and 'data-kind="chairbg"' in ttl, ttl[:200])

    # --------------------------------------------------------------- before step 1
    s.section("before step 1 nothing about a group's people is shown; after step 1 they are")
    saved = H.rows(a, "SELECT cycle_id, subject_id, kind, released_at, released_by FROM leader_releases")
    run(lambda d: (d.execute("DELETE FROM leader_releases"), d.commit()))
    b0 = j(CHC.get(HIST))["overview"]["data"]
    tb0 = json.dumps(b0)
    s.check("nothing released: not_released, no count, an empty grid, none of the 17 names", b0["not_released"] is True
            and b0["placed"] == 0 and b0["count_text"] == "Not released yet" and all(c["n"] == 0 for c in b0["cells"])
            and not any("ZZ ER %s\"" % t in tb0 for t in ids), b0["count_text"])
    # AMENDED 2026-10-30 (one layout all year): with nothing of this cycle released the Talent Box shows the latest released Year-End
    # from HR's records (P5's three imported years are the only ones here), said so; with no record anywhere, every card says
    # Not released yet. Both shown: first the records (no group card opens the Group Talent Box), then none at all.
    dash0h = CHC.get("/dashboard").get_data(as_text=True)
    s.check("...nothing released but HR's records on file: the Talent Box shows the latest Year-End there (said so), by counts, with no "
            "card opening the box and no 'units locked'",
            "Latest released: " in dash0h and "from Group People&#39;s records" in dash0h.replace("Group People's", "Group People&#39;s")
            and "units locked" not in dash0h and 'data-chair-bg=""' in dash0h and "href=\"/review/journey?view=chairgrp&amp;stage=chair_group&amp;bg="
            not in dash0h)
    saved_hist = H.rows(a, "SELECT subject_id, year, category, performance_band, potential_band, source FROM talent_status_history")
    run(lambda d: (d.execute("DELETE FROM talent_status_history"), d.commit()))
    dash0 = CHC.get("/dashboard").get_data(as_text=True)
    s.check("...no record anywhere: every card says 'Not released yet', with no figure and no 'calibrated'", dash0.count("Not released yet") >= 4
            and "calibrated" not in dash0 and "units locked" not in dash0 and "ec-bar" not in dash0.split("</style>")[-1].replace(
                "ec-bar-", ""), dash0.count("Not released yet"))
    run(lambda d: (d.executemany("INSERT INTO talent_status_history(subject_id, year, category, performance_band, potential_band, "
                                 "source) VALUES (?,?,?,?,?,?)", [tuple(x) for x in saved_hist]), d.commit()))
    s.check("...the summary and the download are empty: a 404 for anyone, a file with no rows",
            CHC.get(SUM + p1).status_code == 404)
    x0 = CHC.get(XLS)
    from openpyxl import load_workbook  # noqa: E402
    ws0 = load_workbook(io.BytesIO(x0.data)).active
    s.check("...and the download holds the header and no row", x0.status_code == 200 and ws0.max_row == 1, ws0.max_row)
    run(lambda d: (d.executemany("INSERT INTO leader_releases(cycle_id, subject_id, kind, released_at, released_by) "
                                 "VALUES (?,?,?,?,?)", [tuple(x) for x in saved]), d.commit()))
    b1 = j(CHC.get(HIST))["overview"]["data"]
    s.check("released again: they are there (12 placed)", b1["placed"] == 12 and not b1["not_released"])
    # one group's release at a time: take group two's back, group one's stay
    run(lambda d: (d.execute("DELETE FROM leader_releases WHERE subject_id IN (SELECT id FROM users WHERE business_group=?)",
                             (BG2,)), d.commit()))
    b2 = j(CHC.get(HIST))["overview"]["data"]
    s.check("a group released and another not: group one is in (8), group two is not (no count, no name)",
            b2["placed"] == 8 and not any("ZZ ER Q%d\"" % i in json.dumps(b2) for i in (1, 2, 3, 4)))
    dd = CHC.get("/dashboard").get_data(as_text=True)
    s.check("...and its dashboard card says 'Not released yet' beside the released ones",
            re.search(r'data-chair-bg="%s"[^>]*>\s*<span class="ec-bgc-hd"><b[^>]*>[^<]*</b><span class="od-muted">Not released yet' % re.escape(BG2), dd)
            is not None)
    run(lambda d: (d.executemany("INSERT OR IGNORE INTO leader_releases(cycle_id, subject_id, kind, released_at, released_by) "
                                 "VALUES (?,?,?,?,?)", [tuple(x) for x in saved]), d.commit()))

    # ------------------------------------------------------------------ the turn
    s.section("the one turn of his box is fixed words, no model, nothing stored")
    real_agent = a.ai_draft.review_agent

    def boom(*x, **k):
        raise AssertionError("the model must never be called for his read-only box")
    a.ai_draft.review_agent = boom
    n_chat0 = H.one(a, "SELECT COUNT(*) FROM pm_manager_chat")
    r = CHC.post("/review/chat", data={"journey": "1", "view": "chairgrp", "stage": "chair_group", "csrf_token": "tok"})
    t0 = j(r)
    s.check("the opener: his box, fixed words naming read only and the groups", r.status_code == 200 and t0["ok"]
            and "read only" in t0["say"] and t0["overview"]["data"]["readonly"] is True and t0["stage"] == "chair_group")
    r = CHC.post("/review/chat", data={"journey": "1", "view": "chairgrp", "stage": "chair_group", "csrf_token": "tok",
                                       "message": "move everyone up"})
    t1 = j(r)
    s.check("a typed message gets the read-only line, no model", r.status_code == 200 and "read only" in t1["say"].lower())
    s.check("...and nothing was stored", H.one(a, "SELECT COUNT(*) FROM pm_manager_chat") == n_chat0)
    r = BCC.post("/review/chat", data={"journey": "1", "view": "chairgrp", "stage": "chair_group", "csrf_token": "tok"})
    s.check("a BG CEO posting the same turn gets nothing of his (the view is not theirs)", '"readonly"' not in r.get_data(as_text=True)
            and not names_in(r.get_data(as_text=True)))
    a.ai_draft.review_agent = real_agent

    # ------------------------------------------------------------------ the summary
    s.section("a name opens a limited summary")
    r = CHC.get(SUM + p1)
    sj = j(r)
    ALLOWED = {"ok", "id", "name", "kpi_band", "potential_band", "talent_status", "job_title", "unit", "business_group",
               "line_manager"}
    s.check("the summary carries exactly the allowed keys", r.status_code == 200 and set(sj) == ALLOWED, sorted(set(sj) ^ ALLOWED))
    s.check("...with the final bands, the talent status, the job (proper case), unit, group and the line manager's name",
            sj["kpi_band"].startswith("AE (Above Expectation") and sj["potential_band"] == "High"
            and sj["talent_status"] == "Super Star" and sj["job_title"] == "Senior Manager P1" and sj["business_group"]
            and sj["unit"] and sj["line_manager"] == "ZZ ER MG", sj)
    sj5 = j(CHC.get(SUM + "?id=%d" % ids["P5"]))
    t5 = json.dumps(sj5)
    s.check("a seeded past Super Star (2023 to 2025) never appears on a Solid Core's summary (falsified: it is in the data)",
            sj5["talent_status"] == "Solid Core" and "Super Star" not in t5 and "2023" not in t5 and "2024" not in t5
            and H.one(a, "SELECT COUNT(*) FROM talent_status_history WHERE subject_id=? AND category='Super Star'", (ids["P5"],)) == 3)
    sj8 = json.dumps(j(CHC.get(SUM + "?id=%d" % ids["P8"])))
    s.check("...and a remark stored on someone's calibration row never appears (falsified: it is in the data)",
            REMARK not in sj8 and H.one(a, "SELECT COUNT(*) FROM pm_calibration_adjustments WHERE justification=?", (REMARK,)) == 1)
    s.check("the summary source reads none of: remarks, 360, KPI lines, competency, plans, talent history", not re.search(
        r"justification|feedback|pm_kpi|tc_|pm_idp|talent_status_history|_past_talent|remark",
        H.code_without_docstrings("def chair_person_summary(" + SRC.split("def chair_person_summary(")[1].split("_CHAIR_STARS_HEAD")[0])))
    for label, path, code in (("an unreleased person", SUM + "?id=%d" % ids["P10"], 404),
                              ("an HOD-only person", SUM + "?id=%d" % ids["P7"], 404),
                              ("a person in the unreleased group", SUM + "?id=%d" % ids["R1"], 404),
                              ("the chair himself", SUM + "?id=%d" % CH, 404),
                              ("an id that is nobody", SUM + "?id=99999999", 404),
                              ("no id", SUM, 400), ("text for an id", SUM + "?id=abc", 400)):
        s.check("%s: %d" % (label, code), CHC.get(path).status_code == code, CHC.get(path).status_code)

    # ------------------------------------------------------------------ the Excel
    s.section("the Excel of the Stars and Super Stars")
    n0 = n_log("chair_stars_download")
    r = CHC.get(XLS)
    ws = load_workbook(io.BytesIO(r.data)).active
    rows = [[c.value for c in row] for row in ws.iter_rows()]
    s.check("it is an Excel file named for the scope", r.status_code == 200 and "spreadsheetml" in r.mimetype
            and "Stars and Super Stars - All business groups.xlsx" in r.headers["Content-Disposition"], r.headers.get("Content-Disposition"))
    s.check("the header is the eleven columns he asked for", rows[0] == a._CHAIR_STARS_HEAD and rows[0] == [
        "Name", "Employee ID", "Job title", "Business group", "Unit", "Department", "Job grade", "Line manager", "KPI band",
        "Potential band", "Talent status"], rows[0])
    body = rows[1:]
    s.check("it holds exactly the eight Stars and Super Stars, released and final", {x[1][6:] for x in body} == STARS_ALL
            and len(body) == 8, sorted(x[1] for x in body))
    s.check("...only Star / Super Star rows, and each row's bands give its status", all(
        x[10] in ("Star", "Super Star") and a.talent_category(x[8], x[9]) == x[10] for x in body))
    s.check("...HRIS's own spelling (the raw group and unit, never a display name) and the line manager's name", all(
        x[3] in (BG1, BG2) and x[4] in (CA, CB, CC) and x[7] == "ZZ ER MG" for x in body))
    s.check("an audit row: who, how many rows, which filter", n_log("chair_stars_download") == n0 + 1 and H.rows(
        a, "SELECT user_id, detail FROM activity_log WHERE action='chair_stars_download' ORDER BY id DESC LIMIT 1")[0][0] == CH
        and "8 Stars and Super Stars, all business groups" in H.rows(
            a, "SELECT detail FROM activity_log WHERE action='chair_stars_download' ORDER BY id DESC LIMIT 1")[0][0])
    s.check("...with a plain-words label", a.action_label("chair_stars_download").startswith("Executive Chairman"))
    r = CHC.get(XLS + "?bg=" + BG1)
    b1x = [[c.value for c in row] for row in load_workbook(io.BytesIO(r.data)).active.iter_rows()][1:]
    s.check("one group's download is its six Stars and Super Stars, one more audit row naming the group", len(b1x) == 6
            and {x[1][6:] for x in b1x} == {"P1", "P2", "P3", "P4", "P8", "P9"} and n_log("chair_stars_download") == n0 + 2
            and ("business group %s" % BG1) in H.rows(a, "SELECT detail FROM activity_log WHERE action='chair_stars_download' "
                                                      "ORDER BY id DESC LIMIT 1")[0][0], len(b1x))
    r = CHC.get(XLS + "?bg=" + BG1 + "&company=" + CB)
    ub = [[c.value for c in row] for row in load_workbook(io.BytesIO(r.data)).active.iter_rows()][1:]
    s.check("one unit's download is its Stars only (unit B: P4)", {x[1][6:] for x in ub} == {"P4"})
    r = CHC.get(XLS + "?bg=" + BG3)
    s.check("an unreleased group's download holds no row (and is still one audit row)",
            len(list(load_workbook(io.BytesIO(r.data)).active.iter_rows())) == 1 and n_log("chair_stars_download") == n0 + 4)
    # formula safety
    run(lambda d: (d.execute("UPDATE users SET full_name=?, job_title=?, department=? WHERE id=?",
                             ('=HYPERLINK("http://evil","x")', "+cmd|' /C calc'!A0", "@SUM(A1)", ids["P1"])), d.commit()))
    r = CHC.get(XLS)
    wsf = load_workbook(io.BytesIO(r.data)).active
    cells = [c for row in wsf.iter_rows(min_row=2) for c in row if isinstance(c.value, str)]
    evil = [c for c in cells if "HYPERLINK" in c.value or "cmd|" in c.value or "SUM(A1)" in c.value]
    s.check("a name starting with = (and a title with +, a department with @) comes out inert: text, never a formula", len(evil) == 3
            and all(c.value[:1] == "'" and c.data_type != "f" for c in evil), [(c.value, c.data_type) for c in evil])
    s.check("...no cell in the file starts with = + - @ unquoted", not any(c.value[:1] in "=+-@" for c in cells))
    s.check("the download routes every cell through _csv_cell", "_csv_cell(v)" in SRC.split("def chair_stars_download(")[1][:2500])
    run(lambda d: (d.execute("UPDATE users SET full_name='ZZ ER P1', job_title='SENIOR MANAGER P1', department='ZZ Dept P' WHERE id=?",
                             (ids["P1"],)), d.commit()))

    # ------------------------------------------------------------------ the dashboard
    s.section("his dashboard: the Year-End card, his 360, the insight slot, Talent by business group")
    dh = CHC.get("/dashboard").get_data(as_text=True)
    s.check("it carries the Year-End card, Your 360 and Talent by business group", all(x in dh for x in (
        "Your 360 ratings", "Your leaders&#39; Talent Box", "Results to leaders", 'id="ec-360-h"', "Talent by business group")))
    s.check("his 360 step: 2 of 3 rated, with a link to finish them", re.search(
        r'data-chair-step="360".*?2 of 3 rated.*?</li>', dh, re.S) and 'href="/review/journey?stage=feedback"' in dh)
    run(lambda d: (d.execute("UPDATE assignments SET status='submitted' WHERE assessor_id=? AND cycle_id=?", (CH, CID)), d.commit()))
    dh2 = CHC.get("/dashboard").get_data(as_text=True)
    s.check("...all three rated: 'Done · 3 of 3', and Your 360 says he rated the 3 colleagues, anonymous", "Done · 3 of 3" in dh2
            and "You rated the 3 colleagues you were asked to. Ratings stay anonymous." in dh2)
    s.check("the leaders' Talent Box step (P4 built it behind the named hook) has NO link while no leader is in his box, and says so",
            re.search(r'data-chair-step="leaders".*?</li>', dh2, re.S) and "<a" not in re.search(
                r'data-chair-step="leaders".*?</li>', dh2, re.S).group(0) and "def _chair_leaders_step(" in SRC
            and "No leaders yet" in re.search(r'data-chair-step="leaders".*?</li>', dh2, re.S).group(0))
    s.check("results to leaders carries its date", "Released " + P["released_at"] in dh2, P["released_at"])
    s.check("the AI insight slot is P3's card (tests/test_exec_chair_insight.py): between the Year-End row and Talent by business "
            "group when it has a finding to show (this suite seeds one person's history, so one finding), never a name",
            ("ec-ins" not in dh2 or dh2.index('id="ec-360-h"') < dh2.index("data-chair-insight") < dh2.index('id="ec-bg-h"'))
            and "ZZ ER P5" not in dh2 and os.path.exists(os.path.join(H.REPO, "templates", "_dash_chair_insight.html")))
    cards = re.findall(r'<a class="ec-bgc[^"]*" href="([^"]*)" data-chair-bg="([^"]*)">(.*?)</a>', dh2, re.S)
    s.check("a card for all groups first, then each group (the three here, then every real group in this copy, each "
            "'Not released yet' with no figure)", [c[1] for c in cards][:1] == [""] and {"", BG1, BG2, BG3} <= {c[1] for c in cards}
            and [c[1] for c in cards][1:3] == [BG1, BG2] and all(
                "Not released yet" in c[2] and "calibrated" not in c[2] for c in cards if c[1] not in ("", BG1, BG2)), len(cards))

    def card(key):
        return next(c for c in cards if c[1] == key)[2]
    c_all, c1, c2, c3 = (re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", card(k))) for k in ("", BG1, BG2, BG3))
    s.check("All groups: 12 calibrated, 8 Super Star + Star, 66.7%, Solid Core 2, PIP 2, units locked 2 of 3",
            "12 calibrated" in c_all and re.search(r"\b8\b.*Super Star \+ Star", c_all) and "66.7%" in c_all
            and "Solid Core 2" in c_all and "PIP / Improvement 2" in c_all and "2 of 3 units locked" in c_all, c_all)
    s.check("group one: 8 calibrated, 6 + share 75.0%, Solid Core 1, PIP 1, 1 of 2 units locked", "8 calibrated" in c1
            and "75.0%" in c1 and "Solid Core 1" in c1 and "PIP / Improvement 1" in c1 and "1 of 2 units locked" in c1, c1)
    s.check("group two: 4 calibrated, 2 + 50.0%, 1 of 1 units locked", "4 calibrated" in c2 and "50.0%" in c2
            and "1 of 1 units locked" in c2, c2)
    s.check("group three: 'Not released yet' and not one figure, bar or lock count", "Not released yet" in c3
            and not re.search(r"\d", c3.replace("ZZ9ER", "")), c3)
    s.check("the card's bar is three widths that add to 100, in the order Super Star + Star, Solid Core, PIP", (lambda w: len(w) == 3
            and abs(sum(float(x) for x in w) - 100) < 0.1)(re.findall(r'style="width: ([\d.]+)%"', card(BG1))))
    s.check("a card opens that group in the Group Talent Box (all groups opens it unfiltered)", all(
        c[0].startswith("/review/journey?") and "view=chairgrp" in c[0] and "stage=chair_group" in c[0] for c in cards)
        and "bg=" in next(c for c in cards if c[1] == BG1)[0] and "bg=" not in next(c for c in cards if c[1] == "")[0])
    s.check("Ask OneHR's panel is on his dashboard, as on everyone's", 'id="ask-panel"' in dh2 or 'class="gp"' in dh2
            or "Ask OneHR" in dh2)
    s.check("his own review parts are not on the page: no rail of his own steps, no Where you stand, Career Plan, Learning, tools",
            not any(x in dh2 for x in ("od-stand", "Where you stand", "od-plv", "od-learn", "od-tools", "Your tools", "od-here",
                                       "You are here", "What your job grows into")))
    s.check("the page's measure classes are the dashboard's own (od-card, od-hd, od-steps) plus .ec- ones", "od-card" in dh2
            and "od-hd" in dh2 and "od-steps" in dh2 and "ec-bgc-grid" in dh2)
    # outside a Year-End there is no box
    run(lambda d: (d.execute("UPDATE cycles SET half=1, kind='mid_year' WHERE id=?", (CID,)), d.commit()))
    # AMENDED 2026-10-30 (one layout all year): in a Mid-Year the Talent Box shows the latest released Year-End (HR's records here); the
    # box opens at Year-End only when no Year-End is released anywhere
    dm = CHC.get("/dashboard").get_data(as_text=True)
    s.check("a Mid-Year: the Talent Box still shows the latest released Year-End (HR's records), by counts, no group card opens the box",
            "Latest released: " in dm and "units locked" not in dm and "href=\"/review/journey?view=chairgrp&amp;stage=chair_group&amp;bg=" not in dm)
    run(lambda d: (d.execute("DELETE FROM talent_status_history"), d.commit()))
    dm0 = CHC.get("/dashboard").get_data(as_text=True)
    s.check("...and with no Year-End on record anywhere the card says the box opens at Year-End and shows no group card",
            "opens at Year-End" in dm0 and "ec-bgc" not in dm0.replace("ec-bgc-grid", ""))
    run(lambda d: (d.executemany("INSERT INTO talent_status_history(subject_id, year, category, performance_band, potential_band, "
                                 "source) VALUES (?,?,?,?,?,?)", [tuple(x) for x in saved_hist]), d.commit()))
    s.check("...and the Group view is not there (a Year-End part, like every calibration view)",
            a.CHAIR_VIEW not in run(lambda d: a._journey_leader_views(d, d.execute("SELECT * FROM users WHERE id=?", (CH,)).fetchone())))
    run(lambda d: (d.execute("UPDATE cycles SET half=2, kind='year_end' WHERE id=?", (CID,)), d.commit()))

    # ------------------------------------------------------------------ falsified guards
    s.section("falsified: each guard is what stops it (take it away and the test sees the difference)")
    real_is_chair, real_lri, real_final = a.is_chair, a.leader_released_ids, a._CHAIR_FINAL_TIERS
    try:
        a.is_chair = lambda u: True
        s.check("without the seat check a plain employee reads the summary and the download (so the refusals above are the guard)",
                STC.get(SUM + p1).status_code == 200 and STC.get(XLS).status_code == 200)
        a.is_chair = real_is_chair
        n_before = n_log("chair_stars_download")
        a.leader_released_ids = lambda db_, kind, cid_: {r[0] for r in db_.execute("SELECT id FROM users")}
        P_ = run(lambda d: a._chair_people(d, d.execute("SELECT * FROM users WHERE id=?", (CH,)).fetchone()))
        s.check("without the release gate the unreleased P10 and the unreleased group are in his read",
                ids["P10"] in P_["by_id"] and ids["R1"] in P_["by_id"])
        a.leader_released_ids = real_lri
        a._CHAIR_FINAL_TIERS = ("bgceo", "group", "super", "hod")
        P_ = run(lambda d: a._chair_people(d, d.execute("SELECT * FROM users WHERE id=?", (CH,)).fetchone()))
        s.check("without the final-tier rule the HOD-only P7 is in his read", ids["P7"] in P_["by_id"])
    finally:
        a.is_chair, a.leader_released_ids, a._CHAIR_FINAL_TIERS = real_is_chair, real_lri, real_final
    s.check("...and put back: the refusals and the twelve are as they were", STC.get(SUM + p1).status_code == 403
            and run(lambda d: len(a._chair_people(d, d.execute("SELECT * FROM users WHERE id=?", (CH,)).fetchone())["people"])) == 12)
    run(lambda d: (d.execute("DELETE FROM activity_log WHERE action='chair_stars_download' AND user_id=?", (ids["ST"],)), d.commit()))

    # ------------------------------------------------------------------ route classification
    s.section("the routes are classified where the lints look")
    s.check("module_of_request names both (review)", a.module_of_request("chair_person_summary", "/review/chair/summary") == "review"
            and a.module_of_request("chair_stars_download", "/review/chair/stars.xlsx") == "review")
    s.check("every parameterless chair GET sends a signed-out visitor to sign in, flag on or off", all(
        SIGNED_OUT.get(x).status_code == 302 for x in (SUM, XLS)))
    s.check("the chair's routes read nothing a non-chair can reach: each starts with _chair_require",
            all("_chair_require()" in SRC.split("def %s(" % fn)[1][:900] for fn in ("chair_person_summary", "chair_stars_download")))
    s.check("every JS name for his box lives in the box's own code, not in the Group Chief's or the BG CEO's page-opening path",
            "chairOpenSummary" in JS and "if (tb.ro) { chairOpenSummary(p, null); return; }" in JS)
    s.check("no new def shadows another in app.py (a later def silently wins)", all(
        len(re.findall(r"^def %s\(" % fn, SRC, re.M)) == 1 for fn in (
            "_chair_people", "_chair_box_payload", "_chair_nav_items", "_chair_group_turn", "_chair_stage", "_chair_dash",
            "_chair_bg_cards", "_chair_leaders_step", "_chair_scope", "_chair_units_text", "_chair_require", "_chair_empty",
            "chair_person_summary", "chair_stars_download")))
finally:
    a.window_closed, a.cycle_is_open = _real_window, _real_open
    os.environ.pop("ONEHR_CHAIR", None)
    for k in ("exec_chair_id", "exec_chair_delegate_id", "exec_chair_team"):
        put(k, None)

sys.exit(s.done())
