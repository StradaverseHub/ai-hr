"""The AI+ check-in's leader view tabs are greyed until their window opens (Chris, 2026-11-04).

  "Until a view's window opens, its tab is greyed out, is NOT a link, shows the not-allowed cursor on hover, and its hover text
   is the open date. Once any part of that view opens the tab is normal; after the deadline it stays a normal, readable tab."

One rule, `_view_not_open(db, u, view)` (over `_view_open_raw`): None while the tab is usable, else "Opens <date>" (the earliest
start among the view's counted cells) or "Not open yet". Cells per view: team = pm_approve / tc_approve / idp_review (an Early
Year: pm_setting_approve), dept = pm_hod / pot_hod, bu = pm_buceo / pot_buceo, bg and group = tb_bgceo (Grade H cells join while
Grade H runs); his Leaders tab (chairlead) = tb_bgceo. A cell whose module is off for the cycle is ignored. Mine and the Chairman's
Group view are never greyed.

What this suite holds: the tab row (a span, no link, aria-disabled, the date in its title; a normal link once ANY cell is open or
after the deadline), ?view= of a greyed view lands on Mine (a login with no Mine lands on its first usable view), the one plain
line and no chat for a login whose every view is greyed (no write, no model), the ignored module, the undated part on a by-date
cycle, links that name a greyed view (they degrade to Mine, no error), and the Mine side's team-review offer skipping a greyed
view. Every guard is FALSIFIED: with the helper forced to "usable" the same checks fail.

Synthetic ZZVT-* people only, on the shared suite database WITHOUT a fresh copy; the cycle's windows, modules, half, kind and
open_by_date and the settings are put back at the end.
"""
import os
import sqlite3
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
s = H.Suite("View tabs -- a leader view is greyed until its window opens, the open date on hover")
_real_avail = a.ai_draft.review_agent_available
_real_holders = a._hod_review_holders
_real_open_raw = a._view_open_raw
a.ai_draft.review_agent_available = lambda: True      # the calibration assistant needs a model reachable
a._hod_review_holders = lambda db: set()              # the fixture's BU CEO is also the HOD of their own unit (see test_leader_views)
os.environ.pop("ONEHR_GRADEH", None)
MODEL_CALLS = []
_real_chat = a.ai_draft._chat_complete_call
a.ai_draft._chat_complete_call = lambda *x, **k: MODEL_CALLS.append(1) or (_ for _ in ()).throw(AssertionError("a model call"))

ALL_CELLS = ("pm_approve", "tc_approve", "idp_review", "pm_setting_approve", "pm_hod", "pot_hod", "pm_buceo", "pot_buceo",
             "tb_bgceo", "gradeh_lm", "gradeh_hod_pot", "gradeh_hod_perf", "gradeh_buceo")
SETS = ("ai_calib", "review_unified")

with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    CYC = dict(db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone())
    ORIG = {"cycle": {k: CYC[k] for k in ("half", "kind", "open_by_date")},
            "windows": [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=?", (CID,))],
            "modules": {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?", (CID,))},
            "settings": {k: (r[0] if r else None) for k in SETS
                         for r in [db.execute("SELECT value FROM app_settings WHERE key=?", (k,)).fetchone()]},
            "max": {tb: db.execute("SELECT COALESCE(MAX(id),0) FROM %s" % tb).fetchone()[0]
                    for tb in ("calibration_sessions", "pm_calibration_sessions", "pm_manager_chat", "calibration_adjustments")}}
    db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZVT-%'")
    db.execute("UPDATE cycles SET half=2, kind='year_end', open_by_date=0 WHERE id=?", (CID,))   # the leader tiers are Year-End's
    for mk_ in ("pm", "tm", "idp", "calibration", "evidence", "review"):
        db.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, mk_))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    for k in SETS:
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,'1')", (k,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND business_group!='' "
                           "AND company!='' LIMIT 1").fetchone())
    BG, CO = base["business_group"], base["company"]
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, name, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]
    LEAD = person("ZZVT-LEAD", "ZZ VT Lead")                   # an HOD, also the BU CEO of the same unit: Mine | Dept | BU
    PEOPLE = [person("ZZVT-P%d" % i, "ZZ VT Person %d" % i, hod_id=LEAD) for i in range(4)]
    db.execute("UPDATE users SET buceo_bg=?, buceo_company=? WHERE id=?", (BG, CO, LEAD))
    TLM = person("ZZVT-TLM", "ZZ VT Line Manager")             # a line manager: Mine | Team (a report with a competency to review)
    TREP = person("ZZVT-TREP", "ZZ VT Report", manager_id=TLM)
    _sk = db.execute("SELECT id FROM tc_skills LIMIT 1").fetchone()
    if _sk:
        db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future) VALUES (?,?,?,0)", (CID, TREP, _sk["id"]))
    BGC = person("ZZVT-BGC", "ZZ VT BG CEO", bgceo_bg=BG)      # a BG CEO with no 360 duty: BG only, no Mine
    UNIT2 = CO + " ZZVT"
    BGBU = person("ZZVT-BGBU", "ZZ VT BG and BU CEO", bgceo_bg=BG, buceo_bg=BG, buceo_company=UNIT2)   # no Mine: BU (a unit of its own: one seat a unit) and BG
    for i in range(2):   # people in that unit, so its BU view has someone to calibrate
        person("ZZVT-Q%d" % i, "ZZ VT Unit Person %d" % i, company=UNIT2, hod_id=PEOPLE[0])
    db.commit()
    NOW = a._now_myt()


def stamp(dt):
    return dt.strftime("%Y-%m-%d %H:%M")


def disp(dt):
    return a._when_disp(stamp(dt))


def run(fn, uid=None, path="/"):
    with a.app.test_request_context(path):
        if uid:
            a.session["user_id"] = uid
        d = a.get_db()
        u = dict(d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()) if uid else None
        return fn(d, u)


def exe(sql, args=()):
    run(lambda d, _u: (d.execute(sql, args), d.commit()))


def setwin(cell, opens, closes=None):
    exe("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (CID, cell, opens, closes))


def clearwin():
    exe("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))


def future(cells, days=5):
    for i, c in enumerate(cells):
        setwin(c, stamp(NOW + timedelta(days=days + i)), stamp(NOW + timedelta(days=days + 30)))


def opened(cell):
    setwin(cell, stamp(NOW - timedelta(days=1)), stamp(NOW + timedelta(days=10)))


def closed(cell):
    setwin(cell, stamp(NOW - timedelta(days=10)), stamp(NOW - timedelta(days=1)))


def mod(key, on):
    exe("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", (CID, key, 1 if on else 0))


def off(uid, view):
    return run(lambda d, u: a._view_not_open(d, u, view), uid)


def page(uid, qs=""):
    r = H.client_as(a, uid).get("/review/journey" + qs)
    return r.status_code, r.get_data(as_text=True), r.headers.get("Location", "")


def tab(html, key):
    """('link' | 'span' | None, the tag) of one view's tab in the row."""
    i = html.find('href="/review/journey?view=%s"' % key)
    if i >= 0:
        return "link", html[html.rfind("<a", 0, i):html.find("</a>", i) + 4]
    for tag in html.split("<span class=\"rv-vt-off\"")[1:]:
        t = tag[:tag.find("</span>") + 7]
        return "span", t
    return None, ""


def spans(html):
    out, rest = [], html
    while '<span class="rv-vt-off"' in rest:
        i = rest.index('<span class="rv-vt-off"')
        j = rest.index("</span>", i) + 7
        out.append(rest[i:j])
        rest = rest[j:]
    return out


def view_of(html):
    i = html.find('data-view="')
    return html[i + 11:html.find('"', i + 11)] if i >= 0 else None


def data_version():
    c = sqlite3.connect(a.DB_PATH)
    try:
        return c.execute("PRAGMA data_version").fetchone()[0]
    finally:
        c.close()


try:
    # =======================================================================================================
    s.section("the fixture reaches the views it is about")
    clearwin()
    views = {n: run(lambda d, u: a._journey_views(d, u), uid) for n, uid in
             (("lead", LEAD), ("tlm", TLM), ("bgc", BGC), ("bgbu", BGBU))}
    s.check("an HOD who is a BU CEO has Mine | Dept | BU; a line manager Mine | Team; a BG CEO with no 360 duty BG alone; a BG + BU CEO "
            "BU and BG without Mine",
            views["lead"] == ["mine", "dept", "bu"] and views["tlm"] == ["mine", "team"] and views["bgc"] == ["bg"]
            and views["bgbu"] == ["bu", "bg"], views)

    # =======================================================================================================
    s.section("the helper: usable, or the open date")
    clearwin()
    s.check("no dates on a cycle whose parts are open all cycle: every view is usable",
            all(off(u_, v_) is None for u_, v_ in ((TLM, "team"), (LEAD, "dept"), (LEAD, "bu"), (BGC, "bg"), (BGC, "group"))))
    future(("pm_approve", "tc_approve", "idp_review"))
    t_first = NOW + timedelta(days=5)
    s.check("Team: every part still ahead -> 'Opens <the earliest start>' (the app's own _when_disp)",
            off(TLM, "team") == "Opens " + disp(t_first), off(TLM, "team"))
    setwin("pm_approve", stamp(NOW + timedelta(days=9)), None)
    setwin("tc_approve", stamp(NOW + timedelta(days=7)), None)
    setwin("idp_review", stamp(NOW + timedelta(days=8)), None)
    s.check("...the EARLIEST of the parts, not the first listed", off(TLM, "team") == "Opens " + disp(NOW + timedelta(days=7)),
            off(TLM, "team"))
    opened("idp_review")
    s.check("...usable as soon as ANY part is open", off(TLM, "team") is None, off(TLM, "team"))
    closed("idp_review")
    s.check("...and after its deadline (closed, no pass): still usable, a normal readable tab", off(TLM, "team") is None,
            off(TLM, "team"))
    clearwin()
    future(("pm_hod", "pot_hod"))
    s.check("Dept follows pm_hod / pot_hod only (Team's cells are undated and open: Team is usable)",
            off(LEAD, "dept") == "Opens " + disp(t_first) and off(LEAD, "bu") is None and off(TLM, "team") is None,
            (off(LEAD, "dept"), off(LEAD, "bu")))
    clearwin()
    future(("pm_buceo", "pot_buceo"))
    s.check("BU follows pm_buceo / pot_buceo", off(LEAD, "bu") == "Opens " + disp(t_first) and off(LEAD, "dept") is None,
            (off(LEAD, "bu"), off(LEAD, "dept")))
    clearwin()
    future(("tb_bgceo",))
    s.check("BG and Group both follow tb_bgceo", off(BGC, "bg") == "Opens " + disp(t_first)
            and off(BGC, "group") == "Opens " + disp(t_first), (off(BGC, "bg"), off(BGC, "group")))
    s.check("Mine and the Chairman's Group view are never greyed", all(off(BGC, v_) is None for v_ in ("mine", "chairgrp")))
    s.check("his Leaders tab follows tb_bgceo too (Chris, 2026-11-04; tests/test_chair_leaders_grey.py holds the rest)",
            off(BGC, "chairlead") == "Opens " + disp(t_first), off(BGC, "chairlead"))
    clearwin()
    exe("UPDATE cycles SET open_by_date=1 WHERE id=?", (CID,))
    s.check("a by-date cycle with an undated part: 'Not open yet', no date",
            off(TLM, "team") == "Not open yet" and off(LEAD, "dept") == "Not open yet" and off(BGC, "bg") == "Not open yet",
            (off(TLM, "team"), off(LEAD, "dept"), off(BGC, "bg")))
    setwin("tc_approve", stamp(NOW + timedelta(days=6)), None)
    s.check("...one dated part among undated ones: that date", off(TLM, "team") == "Opens " + disp(NOW + timedelta(days=6)),
            off(TLM, "team"))
    exe("UPDATE cycles SET open_by_date=0 WHERE id=?", (CID,))
    clearwin()

    # =======================================================================================================
    s.section("an Early Year swaps Team's parts for pm_setting_approve")
    exe("UPDATE cycles SET half=0, kind='early_year' WHERE id=?", (CID,))
    setwin("pm_setting_approve", stamp(NOW + timedelta(days=4)), None)
    opened("pm_approve")   # a Year-End part, open: not Team's in an Early Year
    s.check("only pm_setting_approve counts (pm_approve being open does not open Team)",
            off(TLM, "team") == "Opens " + disp(NOW + timedelta(days=4)), off(TLM, "team"))
    opened("pm_setting_approve")
    s.check("...open once pm_setting_approve is", off(TLM, "team") is None, off(TLM, "team"))
    exe("UPDATE cycles SET half=2, kind='year_end' WHERE id=?", (CID,))
    clearwin()

    # =======================================================================================================
    s.section("a part whose module is off for the cycle is ignored")
    setwin("pm_approve", stamp(NOW + timedelta(days=3)), None)
    setwin("tc_approve", stamp(NOW + timedelta(days=5)), None)
    setwin("idp_review", stamp(NOW + timedelta(days=9)), None)
    mod("pm", False)
    s.check("Performance off: Team reads the next earliest part (Talent, day 5)",
            off(TLM, "team") == "Opens " + disp(NOW + timedelta(days=5)), off(TLM, "team"))
    mod("tm", False)
    s.check("...Talent off too: the IDP's day 9", off(TLM, "team") == "Opens " + disp(NOW + timedelta(days=9)), off(TLM, "team"))
    opened("pm_approve")
    s.check("...an OPEN part of a module that is off does not open the tab", off(TLM, "team") == "Opens " + disp(NOW + timedelta(days=9)),
            off(TLM, "team"))
    mod("idp", False)
    s.check("...every part's module off: nothing left to wait for, the view is usable", off(TLM, "team") is None, off(TLM, "team"))
    for k_ in ("pm", "tm", "idp"):
        mod(k_, True)
    clearwin()
    setwin("pm_hod", stamp(NOW + timedelta(days=4)), None)
    setwin("pot_hod", stamp(NOW + timedelta(days=6)), None)
    mod("calibration", False)
    s.check("the Department Review's cells follow the Calibration module: off, Dept is usable", off(LEAD, "dept") is None,
            off(LEAD, "dept"))
    mod("calibration", True)
    s.check("...on again: greyed with the earliest date", off(LEAD, "dept") == "Opens " + disp(NOW + timedelta(days=4)),
            off(LEAD, "dept"))
    clearwin()

    # =======================================================================================================
    s.section("Grade H's parts open Dept / BU for a login holding that Grade H seat only; never Team (Chris's review, 2026-11-04)")
    os.environ["ONEHR_GRADEH"] = "1"
    exe("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, a.GRADEH_MODULE_KEY))

    def gh_person(eid, uid, **over):
        def f(d, _u):
            d.execute("DELETE FROM gradeh_people WHERE employee_id=?", (eid,))
            d.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route) VALUES (?,?,?,?)", (CID, eid, uid, "B"))
            d.commit()
        run(f)
    with a.app.test_request_context("/"):
        db = a.get_db()
        GHHOD = person("ZZVT-GHHOD", "ZZ VT Grade H HOD")                      # an HOD with a Grade H person under them
        for i_ in range(2):
            person("ZZVT-GQ%d" % i_, "ZZ VT Grade H HOD Person %d" % i_, hod_id=GHHOD)
        GHLM = person("ZZVT-GHLM", "ZZ VT Grade H LM")                         # a line manager of a Grade H person, with a Team view
        GHREP = person("ZZVT-GHREP", "ZZ VT Grade H LM Report", manager_id=GHLM)
        if _sk:
            db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future) VALUES (?,?,?,0)", (CID, GHREP, _sk["id"]))
        GHP = person("ZZVT-GHP", "ZZ VT Grade H Person", job_grade="H", hod_id=GHHOD, manager_id=GHLM)
        GHP2 = person("ZZVT-GHP2", "ZZ VT Grade H Person in LEAD's unit", job_grade="H")   # in LEAD's BU CEO unit (BG, CO)
        db.commit()
    gh_person("ZZVT-GHP", GHP)
    gh_person("ZZVT-GHP2", GHP2)
    aud = {n: run(lambda d, u: set(a.gradeh_audiences(d, u)), uid) for n, uid in
           (("ghhod", GHHOD), ("ghlm", GHLM), ("tlm", TLM), ("lead", LEAD), ("bgbu", BGBU))}
    s.check("(the fixture) the Grade H HOD holds 'hod', the Grade H line manager 'lm', LEAD's unit has Grade H people so LEAD holds 'buceo', "
            "and a plain line manager, plain HOD-less login and the other BU CEO hold none",
            "hod" in aud["ghhod"] and "lm" in aud["ghlm"] and "buceo" in aud["lead"] and not aud["tlm"] and not aud["bgbu"], aud)
    s.check("(the fixture) Grade H is running for this cycle", run(lambda d, u: a.gradeh_module_on(d, CID)))
    s.check("(the fixture) the Grade H HOD has a Dept view and the Grade H line manager a Team view",
            "dept" in run(lambda d, u: a._journey_views(d, u), GHHOD) and "team" in run(lambda d, u: a._journey_views(d, u), GHLM),
            (run(lambda d, u: a._journey_views(d, u), GHHOD), run(lambda d, u: a._journey_views(d, u), GHLM)))

    # Team: gradeh_lm never counts. Grade H's line manager part is OPEN, the normal ones are ahead.
    clearwin()
    future(("pm_approve", "tc_approve", "idp_review"), days=9)
    opened("gradeh_lm")
    want_team = "Opens " + disp(NOW + timedelta(days=9))
    s.check("Team, a line manager with NO Grade H people, Grade H's appraisal open: still greyed, dated by the NORMAL parts",
            off(TLM, "team") == want_team, off(TLM, "team"))
    s.check("...a Grade H line manager too: the journey's Team view carries no Grade H work (its own pages do), so greyed the same",
            off(GHLM, "team") == want_team, off(GHLM, "team"))
    setwin("gradeh_lm", stamp(NOW + timedelta(days=1)), None)
    s.check("...and Grade H's appraisal dated EARLIER than the normal parts does not set Team's date either",
            off(TLM, "team") == want_team and off(GHLM, "team") == want_team, (off(TLM, "team"), off(GHLM, "team")))

    # Dept: gradeh_hod_* count for the Grade H HOD only.
    clearwin()
    setwin("pm_hod", stamp(NOW + timedelta(days=12)), None)
    setwin("pot_hod", stamp(NOW + timedelta(days=13)), None)
    setwin("gradeh_hod_pot", stamp(NOW + timedelta(days=3)), None)
    setwin("gradeh_hod_perf", stamp(NOW + timedelta(days=4)), None)   # an undated part is open all cycle: date every counted one
    s.check("Dept, an HOD with NO Grade H people, Grade H's HOD parts ahead of the normal ones: dated by pm_hod, not Grade H",
            off(LEAD, "dept") == "Opens " + disp(NOW + timedelta(days=12)), off(LEAD, "dept"))
    s.check("...the Grade H HOD: Grade H's earlier part sets the date",
            off(GHHOD, "dept") == "Opens " + disp(NOW + timedelta(days=3)), off(GHHOD, "dept"))
    opened("gradeh_hod_pot")
    s.check("...an OPEN Grade H part opens Dept for the Grade H HOD and not for the plain HOD",
            off(GHHOD, "dept") is None and off(LEAD, "dept") == "Opens " + disp(NOW + timedelta(days=12)),
            (off(GHHOD, "dept"), off(LEAD, "dept")))
    s.check("...(Grade H's page links back to Dept, so it must be usable there: the Grade H HOD's topbar tab is a live link)",
            tab(page(GHHOD)[1], "dept")[0] == "link")

    # BU: gradeh_buceo counts for a BU CEO whose unit has Grade H people only.
    clearwin()
    setwin("pm_buceo", stamp(NOW + timedelta(days=16)), None)
    setwin("pot_buceo", stamp(NOW + timedelta(days=17)), None)
    opened("gradeh_buceo")
    s.check("BU, a BU CEO whose unit has Grade H people, Grade H's sign-off open: usable",
            off(LEAD, "bu") is None, off(LEAD, "bu"))
    s.check("...a BU CEO with NO Grade H people in their unit: greyed, dated by the normal parts",
            off(BGBU, "bu") == "Opens " + disp(NOW + timedelta(days=16)), off(BGBU, "bu"))
    exe("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key=?", (CID, a.GRADEH_MODULE_KEY))
    s.check("...Grade H not running for the cycle: its open part is ignored for the seat holder too",
            off(LEAD, "bu") == "Opens " + disp(NOW + timedelta(days=16)), off(LEAD, "bu"))
    exe("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, a.GRADEH_MODULE_KEY))

    # FALSIFIED: with the seat gate removed (everyone counts as a seat holder) the no-seat assertions fail
    _real_aud = a.gradeh_audiences
    a.gradeh_audiences = lambda db=None, u=None: frozenset({"staff", "lm", "hod", "buceo"})
    try:
        s.check("falsified: BU, the plain BU CEO is usable once Grade H counts for everyone (the no-seat check above would fail)",
                off(BGBU, "bu") is None)
        clearwin()
        setwin("pm_hod", stamp(NOW + timedelta(days=12)), None)
        setwin("pot_hod", stamp(NOW + timedelta(days=13)), None)
        setwin("gradeh_hod_pot", stamp(NOW + timedelta(days=3)), None)
        setwin("gradeh_hod_perf", stamp(NOW + timedelta(days=4)), None)
        s.check("falsified: Dept, the plain HOD is dated Grade H's day 3, not pm_hod's day 12, without the audience gate",
                off(LEAD, "dept") == "Opens " + disp(NOW + timedelta(days=3)) != "Opens " + disp(NOW + timedelta(days=12)))
    finally:
        a.gradeh_audiences = _real_aud
    exe("DELETE FROM gradeh_people WHERE employee_id LIKE 'ZZVT-%'")
    exe("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key=?", (CID, a.GRADEH_MODULE_KEY))
    os.environ.pop("ONEHR_GRADEH", None)
    clearwin()

    # =======================================================================================================
    s.section("the tab row: a span, not a link, the date in its title; a normal tab once open")
    future(("pm_approve", "tc_approve", "idp_review"))
    code, html_t, _loc = page(TLM)
    kind_t, tag_t = tab(html_t, "team")
    s.check("Team greyed: a span (no link to ?view=team), aria-disabled, the open date as its title, the tab's own name",
            code == 200 and kind_t == "span" and 'aria-disabled="true"' in tag_t and 'title="Opens %s"' % disp(NOW + timedelta(days=5)) in tag_t
            and ">Team<" in tag_t and 'href="/review/journey?view=team"' not in html_t, (code, tag_t))
    s.check("...Mine is still a link and the page is the Mine view", 'href="/review/journey?view=mine"' in html_t and view_of(html_t) == "mine")
    code, html_t2, _ = page(TLM, "?view=team")
    s.check("?view=team while Team is greyed lands on Mine", code == 200 and view_of(html_t2) == "mine", (code, view_of(html_t2)))
    opened("tc_approve")
    code, html_o, _ = page(TLM)
    kind_o, tag_o = tab(html_o, "team")
    s.check("one part open: Team is a normal link again, no span", kind_o == "link" and "rv-vt-off" not in html_o, tag_o)
    code, html_o2, _ = page(TLM, "?view=team")
    s.check("...and ?view=team opens the Team view", view_of(html_o2) == "team", view_of(html_o2))
    for c_ in ("pm_approve", "tc_approve", "idp_review"):
        closed(c_)
    code, html_c, _ = page(TLM, "?view=team")
    s.check("after the deadline the tab stays a normal link and the Team view opens (readable, as today)",
            "rv-vt-off" not in html_c and view_of(html_c) == "team", view_of(html_c))
    clearwin()
    future(("pm_hod", "pot_hod", "pm_buceo", "pot_buceo"))
    opened("pot_buceo")
    code, html_l, _ = page(LEAD)
    sp = spans(html_l)
    s.check("Dept greyed by its own cells, BU a link (its pot_buceo is open): one span, Dept's, with the date",
            len(sp) == 1 and ">Dept<" in sp[0] and 'title="Opens %s"' % disp(NOW + timedelta(days=5)) in sp[0]
            and 'href="/review/journey?view=bu"' in html_l and 'href="/review/journey?view=dept"' not in html_l,
            (len(sp), sp[:1]))
    code, html_l2, _ = page(LEAD, "?view=dept")
    s.check("...and ?view=dept lands on Mine, ?view=bu on BU", view_of(html_l2) == "mine" and view_of(page(LEAD, "?view=bu")[1]) == "bu")
    clearwin()
    future(("tb_bgceo",))
    opened("pm_buceo")
    code, html_b, _ = page(BGBU)
    sp = spans(html_b)
    s.check("a BG + BU CEO (no Mine): BG greyed by tb_bgceo, BU a link; they land on BU, and ?view=bg lands there too",
            len(sp) == 1 and ">BG<" in sp[0] and view_of(html_b) == "bu" and view_of(page(BGBU, "?view=bg")[1]) == "bu",
            (len(sp), view_of(html_b)))
    clearwin()

    # =======================================================================================================
    s.section("every view greyed: the tab row and one plain line, no chat, nothing written, no model")
    future(("tb_bgceo",), days=6)
    v0, calls0 = data_version(), len(MODEL_CALLS)
    code, html_n, _ = page(BGC)
    v1 = data_version()
    s.check("a BG CEO with nothing open: the page answers, BG is a greyed span and no link",
            code == 200 and len(spans(html_n)) == 1 and ">BG<" in spans(html_n)[0] and 'href="/review/journey?view=bg"' not in html_n, code)
    want_line = "Your team's reviews open on %s." % disp(NOW + timedelta(days=6))
    s.check("...ONE plain line in place of the card, with the earliest date", html_n.count(want_line.replace("'", "&#39;")) == 1
            or html_n.count(want_line) == 1, [x for x in html_n.split("\n") if "reviews open" in x][:2])
    s.check("...no chat box, no stage, no scripts of the chat", 'id="rv-chat"' not in html_n and "journey_chat.js" not in html_n
            and 'id="rv-chat-form"' not in html_n)
    s.check("...nothing written (the database's data version did not move) and no model called",
            v0 == v1 and len(MODEL_CALLS) == calls0, (v0, v1, len(MODEL_CALLS)))
    code, html_n2, _ = page(BGC, "?view=bg&stage=talent_box")
    s.check("...a link into it (?view=bg&stage=talent_box) shows the same line, no error", code == 200 and "reviews open on" in html_n2.replace("&#39;", "'"), code)
    future(("pm_buceo", "pot_buceo"), days=3)
    code, html_nb, _ = page(BGBU)
    s.check("two greyed views: the line gives the EARLIEST of them",
            "Your team's reviews open on %s." % disp(NOW + timedelta(days=3)) in html_nb.replace("&#39;", "'")
            and len(spans(html_nb)) == 2, len(spans(html_nb)))
    clearwin()
    exe("UPDATE cycles SET open_by_date=1 WHERE id=?", (CID,))
    opened("pm_results")   # the cycle itself has opened (else the whole check-in sends them to the dashboard); the Talent Box is undated
    code, html_u, _ = page(BGC)
    s.check("undated on a by-date cycle: 'Your team's reviews aren't open yet.' and the span's title says 'Not open yet'",
            ("Your team&#39;s reviews aren&#39;t open yet." in html_u or "Your team's reviews aren't open yet." in html_u)
            and 'title="Not open yet"' in html_u, [x for x in html_u.split("\n") if "reviews" in x][:2])
    s.check("...the title reads 'Not open yet'", 'title="Not open yet"' in html_u)
    exe("UPDATE cycles SET open_by_date=0 WHERE id=?", (CID,))
    opened("tb_bgceo")
    code, html_ok, _ = page(BGC)
    s.check("once the Talent Box opens the same login gets the normal page again (the chat, no notice)",
            view_of(html_ok) == "bg" and 'id="rv-chat"' in html_ok and "reviews open on" not in html_ok and "rv-vt-off" not in html_ok,
            view_of(html_ok))
    clearwin()

    # =======================================================================================================
    s.section("links that name a greyed view degrade to Mine, no error")
    future(("pm_hod", "pot_hod", "pm_buceo", "pot_buceo"))
    for qs in ("?view=dept&stage=calibration", "?view=bu&stage=calibration_pot", "?view=dept&stage=calibration&mode=detail&report=1",
               "?view=team&stage=calibration", "?view=bg&stage=talent_box"):
        code, h_, loc = page(LEAD, qs)
        s.check("%s: 200 on Mine, not an error and not a bounce into the greyed view" % qs,
                code == 200 and view_of(h_) == "mine" and "rv-vt-off" in h_, (code, loc, view_of(h_)))
    opened("pot_buceo")
    code, _h, loc = page(LEAD, "?view=team&stage=calibration_pot")
    s.check("an old ?view=team&stage=calibration_pot link still follows it to a leader view that has OPENED (BU), never the greyed Dept",
            code == 302 and "view=bu" in loc and "view=dept" not in loc, (code, loc))
    clearwin()

    # =======================================================================================================
    s.section("the Mine side's team-review offer skips a greyed view")

    def parts_views(uid):
        def f(d, u):
            st = a.review_state(d, u)
            return sorted({v_ for v_, _x in a._journey_manager_parts(st)})
        return run(f, uid, "/review/journey")
    clearwin()
    open_views = parts_views(LEAD)
    future(("pm_hod", "pot_hod", "pm_buceo", "pot_buceo"))
    grey_views = parts_views(LEAD)
    s.check("with every window open the offer sees the leader views; with them greyed it sees none of them",
            open_views and set(open_views) <= {"dept", "bu"} and grey_views == [], (open_views, grey_views))
    clearwin()

    # =======================================================================================================
    s.section("style and template guards")
    css = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
    i = css.index("\n.mod-tabs .rv-vt-off {")
    rule = css[i:css.index("}", i)]
    s.check("the greyed tab's rule: not-allowed cursor, a colour token (never a hex), rem font size, no underline",
            "cursor: not-allowed" in rule and "var(--faint)" in rule and "#" not in rule and "rem" in rule
            and "underline" not in rule and "px" in rule, rule)
    s.check("...it shares the live tab's sizing rules in the journey's top row and at Larger / XL text",
            ".rv-topbar-nav .rv-viewtabs .rv-vt-off" in css and ".rv-viewtabs .rv-vt-off" in css
            and css.count(".rv-vt-off") >= 8)
    vt = open(os.path.join(H.REPO, "templates", "_review_viewtabs.html"), encoding="utf-8").read()
    s.check("the template renders the greyed view as a span with aria-disabled and its title, never an <a>",
            '<span class="rv-vt-off" aria-disabled="true" title="{{ v.off }}">{{ v.short }}</span>' in vt)
    src = H.source(a)
    s.check("every caller that builds the tab row's views passes 'off' (the journey page and the Grade H pages)",
            src.count('"off": _view_not_open(db, u, ') >= 2)
    # the all-greyed page hides base's two-icon switch as the full journey does (it has no .rv-wrap): a rule keyed on its own id
    _hide = "body:has(#rv-closed-note) #main > .mod-tabs { display: none; }"
    s.check("the all-greyed page's CSS hides base's icon switch, keyed on #rv-closed-note", _hide in css)
    s.check("falsified: without that rule the check fails", _hide not in css.replace(_hide, ""))
    s.check("one helper name, defined once (a later def would silently win)", src.count("\ndef _view_not_open(") == 1
            and src.count("\ndef _view_open_raw(") == 1)

    # =======================================================================================================
    s.section("FALSIFIED: with the helper forced to 'usable' the same checks fail")
    future(("pm_approve", "tc_approve", "idp_review", "pm_hod", "pot_hod", "pm_buceo", "pot_buceo", "tb_bgceo"))

    def preds():
        _c, h1, _l = page(TLM)
        _c, h2, _l = page(TLM, "?view=team")
        _c, h3, _l = page(BGC)
        return {"team is a span, not a link": tab(h1, "team")[0] == "span" and 'href="/review/journey?view=team"' not in h1,
                "?view=team lands on Mine": view_of(h2) == "mine",
                "the title carries the date": 'title="Opens' in h1,
                "the all-greyed login gets the one line and no chat": "reviews open on" in h3.replace("&#39;", "'") and 'id="rv-chat"' not in h3,
                "the helper says when": off(TLM, "team") is not None and off(LEAD, "dept") is not None and off(BGC, "bg") is not None,
                "the offer skips a greyed view": parts_views(LEAD) == []}
    real = preds()
    s.check("(real helper) every one of those holds", all(real.values()), real)
    a._view_open_raw = lambda db, u, view: None
    try:
        fake = preds()
    finally:
        a._view_open_raw = _real_open_raw
    for name, ok in fake.items():
        s.check("falsified: '%s' fails when the helper says usable" % name, not ok)
    clearwin()
finally:
    a._view_open_raw = _real_open_raw
    a.ai_draft.review_agent_available = _real_avail
    a.ai_draft._chat_complete_call = _real_chat
    a._hod_review_holders = _real_holders
    os.environ.pop("ONEHR_GRADEH", None)
    with a.app.test_request_context("/"):   # put the shared suite database back as this suite found it
        db = a.get_db()
        for tb, mx in ORIG["max"].items():
            db.execute("DELETE FROM %s WHERE id>?" % tb, (mx,))
        db.execute("DELETE FROM gradeh_people WHERE employee_id LIKE 'ZZVT-%'")
        ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZVT-%'")]
        if ids:
            ph = ",".join("?" * len(ids))
            for t in ("tc_assignments", "assignments"):
                col = "assessor_id" if t == "assignments" else "subject_id"
                db.execute("DELETE FROM %s WHERE %s IN (%s)" % (t, col, ph), ids)
            db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ids)
            for t in ("pm_calibration_adjustments", "calibration_adjustments"):
                try:
                    db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (t, ph), ids)
                except Exception:  # noqa: BLE001
                    pass
            db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
        db.execute("UPDATE cycles SET half=?, kind=?, open_by_date=? WHERE id=?",
                   (ORIG["cycle"]["half"], ORIG["cycle"]["kind"], ORIG["cycle"]["open_by_date"], CID))
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        for w in ORIG["windows"]:
            db.execute("INSERT INTO cycle_windows(%s) VALUES (%s)" % (",".join(w), ",".join("?" * len(w))), list(w.values()))
        db.execute("DELETE FROM cycle_modules WHERE cycle_id=?", (CID,))
        for k, v in ORIG["modules"].items():
            db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", (CID, k, v))
        for k, v in ORIG["settings"].items():
            if v is None:
                db.execute("DELETE FROM app_settings WHERE key=?", (k,))
            else:
                db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES (?,?)", (k, v))
        db.commit()

sys.exit(s.done())
