"""The dashboard's Team review, Department review and Calibration steps are no link while their view is greyed (Chris's known bug,
"Team / HOD dashboard cards link to a greyed-out view", fixed 2026-11-09).

A leader view of the AI+ check-in (team / dept / bu) is greyed until its window opens (_view_not_open); a link to it lands on Mine,
not on what the card names. The dashboard rail's step for it now shows its words ("Opens 15 Nov") and no link until the view opens,
then it links as before. One helper, _dash_open_url, used by dash_rail.

What this suite holds: every leader window ahead -> the line manager's Team review step and the HOD / BU CEO's Department review and
Calibration steps carry no link to /review/journey?view=...; their words (name, "Opens <date>") stay; one window open -> that view's
step links again, the others do not; every window open -> all link; links that name no view (Mine's steps) are untouched; the
helper's guard is FALSIFIED (forced to pass the link through, the same page links to the greyed view).

Synthetic ZZVT-* people on the shared suite database; the cycle's windows, modules, half, kind and settings are put back.
"""
import os
import sqlite3
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
s = H.Suite("Dashboard steps: no link to a greyed leader view")
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


import re

LINK = re.compile(r'<a [^>]*href="(/review/journey\?view=(?:team|dept|bu|bg|group)[^"]*)"')


def dash(uid):
    r = H.client_as(a, uid).get("/", follow_redirects=True)
    return r.status_code, r.get_data(as_text=True)


def view_links(h):
    return sorted({m.group(1).split("&")[0].split("=")[1] for m in LINK.finditer(h.replace("&amp;", "&"))})


def step_text(h, name):
    m = re.search(r'<li class="od-step[^"]*"[^>]*title="%s:[^"]*">[\s\S]*?</li>' % re.escape(name), h)
    return " ".join(re.sub(r"<[^>]+>", " ", m.group(0)).split()) if m else ""


try:
    s.section("every leader window ahead: the steps are words, no link")
    clearwin()
    future(("pm_approve", "tc_approve", "idp_review", "pm_hod", "pot_hod", "pm_buceo", "pot_buceo"))
    cs, h_tlm = dash(TLM)
    cs2, h_lead = dash(LEAD)
    s.check("both dashboards open", cs == 200 and cs2 == 200, (cs, cs2))
    s.check("the line manager's page has no link to the Team view", "team" not in view_links(h_tlm), view_links(h_tlm))
    s.check("the HOD and BU CEO's page has no link to the Dept or BU view", not ({"dept", "bu"} & set(view_links(h_lead))), view_links(h_lead))
    s.check("the Team review step still says when it opens, as a plain label", "Team review" in step_text(h_tlm, "Team review")
            and "Opens" in step_text(h_tlm, "Team review"), step_text(h_tlm, "Team review"))
    s.check("the Department review and Calibration steps still name themselves and say when they open",
            "Opens" in step_text(h_lead, "Department review") and "Opens" in step_text(h_lead, "Calibration"),
            (step_text(h_lead, "Department review"), step_text(h_lead, "Calibration")))
    s.check("the steps are plain spans now (class od-sn, no anchor)", re.search(r'<span class="od-sn">Team review</span>', h_tlm) is not None
            and re.search(r'<span class="od-sn">Department review</span>', h_lead) is not None)
    s.check("a step that names no view keeps its link (Mine's Career Plan)", "/review/journey?stage=career_plan" in h_tlm)

    s.section("falsified: with the helper letting every link through, the same page links to the greyed views")
    _real = a._dash_open_url
    a._dash_open_url = lambda db_, u_, url_: url_
    try:
        _, f_tlm = dash(TLM)
        _, f_lead = dash(LEAD)
    finally:
        a._dash_open_url = _real
    s.check("the guard is what removes them: Team, Dept and BU links are back without it",
            "team" in view_links(f_tlm) and {"dept", "bu"} <= set(view_links(f_lead)), (view_links(f_tlm), view_links(f_lead)))

    s.section("one window open: only that view links")
    opened("pm_hod")
    opened("pot_hod")
    _, h_lead = dash(LEAD)
    s.check("Dept links once its window is open; BU, still ahead, does not",
            "dept" in view_links(h_lead) and "bu" not in view_links(h_lead), view_links(h_lead))
    opened("pm_approve")
    _, h_tlm = dash(TLM)
    s.check("Team links once any of its parts is open", "team" in view_links(h_tlm), view_links(h_tlm))
    opened("pm_buceo")
    _, h_lead = dash(LEAD)
    s.check("with every window open all of them link", {"dept", "bu"} <= set(view_links(h_lead)), view_links(h_lead))

    s.section("after the deadline the step stays a link (the tab stays, readable)")
    closed("pm_hod")
    closed("pot_hod")
    _, h_lead = dash(LEAD)
    s.check("a closed Dept window still links", "dept" in view_links(h_lead), view_links(h_lead))
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
