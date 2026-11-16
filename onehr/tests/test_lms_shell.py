"""AI+ Learning in the AI+ check-in's own shell (Chris, 2026-10-22: "for the AI+ Learning, we need to redesign it to
follow our PMTMIDP AI+ UI", then "go with the redesign"; canvas section 17).

What this suite holds:
  * Mine, Team and Dept render the shell: the view switch and the queue card on the left, Learning's parts as tabs with
    their steps, the coach's conversation (its composer) in the middle; the calendar keeps its own page
  * the queue: what's to do first, then what waits on someone else, then what's settled; the next step and each "then"
    line point at a card that is on the page, in the tab they name
  * the open tab: the one asked for, else the one holding the first thing to do, else the first
  * every card keeps its writer: rating, check-in, withdraw, approve and return, confirm, nominate post where they always
    did; registering and asking for a course open inside the Find tab
  * the Find tab carries runs open to them (OneHR's facts), with Details and Register
Everything here is synthetic (ZZLS / ZZ9LS-) and removed at the end.
"""
import html
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning: the AI+ shell")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG = "ZZLS Group"
_ENV0 = os.environ.get("ONEHR_LMS")


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LS-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLS %'")
    if ul:
        ph = ",".join("?" * len(ul))
        for t in ("lms_registrations", "lms_coach_chat", "lms_interest"):
            db.execute("DELETE FROM %s WHERE user_id IN (%s)" % (t, ph), ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZLS-%'")
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, grade="15", mgr=None, hod=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, manager_id, hod_id) VALUES (?,?, 'x', 'user', ?,?, 'ZZLS U1', "
                      "'ZZLS Sales', 'ZZLS Officer', ?, ?, ?)", (eid.lower(), "ZZ LS " + eid.split("-")[1], eid, BG, grade,
                                                                 mgr, hod)).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'ZZLS U1')", (BG,))
    for lv in (3, 4):
        db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category, proficiency_description, "
                   "active) VALUES (?,?,?,?,?,?,1)", ("ZZLS-AAA-%d001-1.0" % lv, "ZZLS Pricing", lv, "tsc", "ZZLS",
                                                      "ZZLS Pricing at L%d." % lv))
    K = "ZZLS-AAA-001"
    H_ = person(db, "ZZ9LS-H", "20")
    M = person(db, "ZZ9LS-M", "18", hod=H_)
    E = person(db, "ZZ9LS-E", "15", mgr=M, hod=H_)
    today = a._today_myt()
    P = db.execute("INSERT INTO lms_programmes(title, kind, status, effectiveness) VALUES ('ZZLS Negotiation', 'inhouse', "
                   "'published', '1,3')").lastrowid
    db.execute("INSERT INTO lms_programme_competencies(programme_id, comp_key, level, confirmed) VALUES (?,?,4,1)", (P, K))

    # the pending request is on a second programme: one run of a programme at a time (2026-10-23)
    P2 = db.execute("INSERT INTO lms_programmes(title, kind, status, effectiveness) VALUES ('ZZLS Negotiation 2', "
                    "'inhouse', 'published', '1,3')").lastrowid
    db.execute("INSERT INTO lms_programme_competencies(programme_id, comp_key, level, confirmed) VALUES (?,?,4,1)", (P2, K))

    def sess(days, seats=10, pid=None):
        d = (today + timedelta(days=days)).isoformat()
        return db.execute("INSERT INTO lms_sessions(programme_id, run_label, starts_on, ends_on, seats, venue) VALUES "
                          "(?, 'ZZLS run', ?, ?, ?, 'ZZLS Room')", (pid or P, d, d, seats)).lastrowid
    S_PAST, S_OPEN, S_UP, S_PEND = sess(-5), sess(20), sess(25), sess(30, pid=P2)
    R_RATE = db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json, outcome, "
                        "hours) VALUES (?,?,?, 'approved', '[]', 'attended', 7)", (E, S_PAST, P)).lastrowid
    R_UP = db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json) VALUES "
                      "(?,?,?, 'approved', '[]')", (E, S_UP, P)).lastrowid
    db.commit()


def one(sql, args=()):
    return H.one(a, sql, args)


def env(v):
    if v is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = v


def page(c, url):
    r = c.get(url)
    return r.status_code, html.unescape(r.get_data(as_text=True))


def panel(pg, key):
    m = re.search(r'<div class="ln-panel" id="ln-panel-%s".*?(?=<div class="ln-panel" id="ln-panel-|<div class="ln-chat")'
                  % key, pg, re.S)
    return m.group(0) if m else ""


try:
    env("1")
    CE, CM, CH = H.client_as(a, E), H.client_as(a, M), H.client_as(a, H_)
    with a.app.test_request_context():
        db = a.get_db()
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (E,)).fetchone())
        ok, _m, R_PEND = a.lms_register(db, u, S_PEND, None, "ZZLS reason")

    s.section("Mine in the shell")
    code, pg = page(CE, "/learning")
    s.check("the shell: the view switch, the queue card, the tabs and the composer", code == 200 and 'class="ln-vs"' in pg
            and 'class="ln-q"' in pg and 'data-tab="find"' in pg and 'data-tab="apply"' in pg and 'data-tab="progress"'
            in pg and 'id="ln-form"' in pg and "learning_shell.js" in pg, code)
    s.check("...the coach is the conversation, not a side panel", 'id="lco"' not in pg and 'data-coach-page="calendar"' in pg)
    s.check("the open tab holds the first thing to do (Apply: rate it)", 'class="ln-tab is-open" data-tab="apply"' in pg
            and 'data-panel="apply" hidden' not in pg and 'data-panel="find" hidden' in pg)
    with a.app.test_request_context("/learning"):
        db = a.get_db()
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (E,)).fetchone())
        ctx = a.lms_space(db, u, "mine")
        sh = a.lms_shell(db, u, ctx)
    kinds = [i["kind"] for i in sh["queue"]["items"]]
    s.check("the queue: to do first, then waiting, then settled", kinds == sorted(kinds, key=["todo", "wait", "done"].index)
            and kinds[:1] == ["todo"] and "wait" in kinds and "done" in kinds, kinds)
    s.check("...the next step is rating what they came to", sh["queue"]["next"]["title"] == "Rate ZZLS Negotiation" and
            sh["queue"]["next"]["tab"] == "apply", sh["queue"]["next"])
    s.check("...the bar has a segment an item, coloured by kind", sh["queue"]["bar"] == kinds[:14])
    missing = [i["anchor"] for i in sh["queue"]["items"] if ('id="%s"' % i["anchor"]) not in panel(pg, i["tab"])]
    s.check("...every line points at a card on the page, in its own tab", not missing, missing)
    s.check("the tab asked for opens", 'class="ln-tab is-open" data-tab="progress"' in page(CE, "/learning?tab=progress")[1])
    s.check("...a tab that isn't the view's is ignored", 'class="ln-tab is-open" data-tab="apply"' in
            page(CE, "/learning?tab=team")[1])

    s.section("the cards keep their writers")
    ap, fd = panel(pg, "apply"), panel(pg, "find")
    s.check("Apply: the rating posts to the rating", 'action="/learning/rate/%d"' % R_RATE in ap and 'id="rate-%d"' % R_RATE in ap)
    s.check("Find: runs open to them, Details and Register", 'id="runs"' in fd and "/learning/register?session=%d" % S_OPEN in fd
            and "Details" in fd and "ZZLS Room" in fd)
    s.check("...their request in progress, with withdraw", 'id="req-%d"' % R_PEND in fd and
            'action="/learning/mine/%d"' % R_PEND in fd)
    s.check("...their place coming up, with its calendar file", 'id="up-%d"' % R_UP in fd and "/learning/ics/%d" % R_UP in fd)
    code, rg = page(CE, "/learning/register?session=%d" % S_OPEN)
    s.check("registering opens inside the shell's Find tab", code == 200 and 'class="ln-tab is-open" data-tab="find"' in rg
            and 'id="register"' in panel(rg, "find") and 'action="/learning/register"' in rg, code)
    code, xg = page(CE, "/learning/request")
    s.check("...so does asking for an external course", code == 200 and 'action="/learning/request"' in panel(xg, "find"))
    code, cg = page(CE, "/learning?view=calendar")
    s.check("the calendar keeps its own page, the coach on its left", code == 200 and 'class="lc"' in cg and 'id="lco"' in cg
            and 'class="ln"' not in cg)

    s.section("Team and Dept")
    code, tg = page(CM, "/learning?view=team")
    s.check("Team: Your team and Their learning, the request waiting on them first", code == 200 and 'data-tab="team"' in tg
            and 'data-tab="plans"' in tg and 'id="wait-%d"' % R_PEND in panel(tg, "team"), code)
    s.check("...approve and return post where they always did", 'action="/learning/decide/%d"' % R_PEND in tg)
    s.check("...nominate and their requests under Their learning", 'id="nominate"' in panel(tg, "plans") and
            'id="teamregs"' in panel(tg, "plans"))
    s.check("...the views they have: Mine and Team", '>Mine' in tg and '>Team' in tg)
    code, dg = page(CH, "/learning?view=dept")
    s.check("Dept: Your department with its rounds", code == 200 and 'data-tab="dept"' in dg and 'id="rounds"' in dg, code)
finally:
    env(_ENV0)
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
