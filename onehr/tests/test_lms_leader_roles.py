"""AI+ Learning's line manager and HOD actions as leader abilities (2026-10-23; OneHR's rule: "a new leader action gets
its LEADER_ABILITIES key"). Roles & access › Leader roles switches them per seat, for every leader in it.

What this suite holds:
  * the registry: six Learning abilities, each a line manager's or an HOD's; on Leader roles only where Learning is on
  * saving Leader roles touches only the rows on screen: a Learning row keeps its state where Learning is off
  * each one, switched off, stops its shared writer and drops its "waiting on you" lines, saying why where the action
    would be: approve or return (the line manager's step, and the HOD's, an escalated one too), nominate, a round's
    nominations, confirming a 3-month check-in and learning on the job, excusing an absence (L&D still can)
  * Learning isn't part of a cycle: a unit left out of the cycle keeps them; an admin is never stopped
Everything here is synthetic (ZZLL / ZZ9LL-) and removed at the end.
"""
import html
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning: line manager and HOD actions on Leader roles")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO = "ZZLL Group", "ZZLL U1"
_ENV0 = os.environ.get("ONEHR_LMS")
_OUT0 = a._leader_unit_out
TODAY = a._today_myt()
LMS_KEYS = [k for _g, k, _l, _n in a.LMS_LEADER_ABILITIES]


def D(n):
    return (TODAY + timedelta(days=n)).isoformat()


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LL-%' OR username LIKE 'zzll-%'")]
    db.execute("DELETE FROM lms_rounds WHERE title LIKE 'ZZLL %'")
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLL %'")
    if ul:
        ph = ",".join("?" * len(ul))
        for t in ("lms_ojt", "lms_registrations", "email_outbox"):
            db.execute("DELETE FROM %s WHERE user_id IN (%s)" % (t, ph), ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, mgr=None, hod=None, grade="15"):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, manager_id, hod_id, confirmation_date) VALUES "
                      "(?,?, 'x', 'user', ?,?,?, 'ZZLL Sales', 'ZZLL Officer', ?, ?, ?, '2020-01-01')",
                      (eid.lower(), "ZZ LL " + eid.split("-")[1], eid, BG, CO, grade, mgr, hod)).lastrowid


def lm_step(mgr, state="waiting"):
    return {"role": "lm", "days": 3, "escalate": "hod", "approver": mgr, "state": state, "by": None, "at": None,
            "note": ""}


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    SAVED = [tuple(r) for r in db.execute("SELECT role, ability, allowed FROM leader_role_access")]
    LOG0 = db.execute("SELECT COALESCE(MAX(id), 0) FROM activity_log").fetchone()[0]
    db.execute("DELETE FROM leader_role_access")
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, CO))
    HOD = person(db, "ZZ9LL-HOD", grade="19")
    M = person(db, "ZZ9LL-M", hod=HOD, grade="17")
    E1, E2, E3, E4 = (person(db, "ZZ9LL-E%d" % i, M, HOD) for i in range(1, 5))
    LND = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzll-lnd', 'ZZ LL L&D', 'x', 'admin', ?)", (a.LMS_ADMIN_BG,)).lastrowid
    P = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days) VALUES ('ZZLL Negotiation', 'inhouse', "
                   "'published', 7, 1)").lastrowid
    S = db.execute("INSERT INTO lms_sessions(programme_id, starts_on, ends_on, start_time, end_time, venue, seats) VALUES "
                   "(?,?,?, '09:00', '17:00', 'ZZLL Room', 20)", (P, D(70), D(70))).lastrowid
    SP = db.execute("INSERT INTO lms_sessions(programme_id, starts_on, ends_on, start_time, end_time, venue, closed_at) "
                    "VALUES (?,?,?, '09:00', '17:00', 'ZZLL Room', datetime('now'))", (P, D(-100), D(-100))).lastrowid

    def reg(uid, sid, status, chain, since=None, outcome=None):
        return db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json, level, "
                          "level_since, outcome) VALUES (?,?,?,?,?, 0, ?, ?)",
                          (uid, sid, P, status, a.json.dumps(chain), since, outcome)).lastrowid
    RA = reg(E1, S, "pending", [lm_step(M)], D(0))           # at the line manager's step, in time
    RB = reg(E2, S, "pending", [lm_step(M)], D(-20))         # at the line manager's step, past due: escalates to the HOD
    RC = reg(E3, SP, "approved", [lm_step(M, "approved")], None, "attended")
    RD = reg(E4, SP, "approved", [lm_step(M, "approved")], None, "absent")
    EV = db.execute("INSERT INTO lms_evaluations(registration_id, kind, due_on, status, words_json, self_level) VALUES "
                    "(?, 'm3', ?, 'self_done', '{}', 3)", (RC, D(-10))).lastrowid
    OJ = db.execute("INSERT INTO lms_ojt(user_id, kind, what, example, status, manager_id) VALUES (?, 'others', "
                    "'ZZLL Mentoring a joiner', 'Sat in on her dealer calls, then went through each quote.', 'sent', ?)",
                    (E3, M)).lastrowid
    AB = db.execute("INSERT INTO lms_absences(registration_id, on_date, status, reason) VALUES (?,?, 'explained', "
                    "'ZZLL a clash')", (RD, D(-100))).lastrowid
    RND = db.execute("INSERT INTO lms_rounds(title, closes_on) VALUES ('ZZLL Q1 nominations', ?)", (D(14),)).lastrowid
    db.execute("INSERT INTO lms_round_sessions(round_id, session_id) VALUES (?,?)", (RND, S))
    db.commit()


def one(sql, args=()):
    return H.one(a, sql, args)


def env(v):
    if v is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = v


def u_(uid):
    with a.app.app_context():
        return dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def call(fn, *args):
    with a.app.test_request_context():
        return fn(a.get_db(), *args)


def off(keys):
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM leader_role_access")
        d.executemany("INSERT INTO leader_role_access(role, ability, allowed) VALUES (?,?,0)",
                      [(k.split(".")[0], k) for k in keys])
        d.commit()


def reg_of(rid):
    with a.app.app_context():
        return a._lms_reg(a.get_db(), rid)


def page(uid, path):
    return html.unescape(H.client_as(a, uid).get(path).get_data(as_text=True))


try:
    s.section("the registry")
    roles = {r for r, _l in a.LEADER_ROLES}
    s.check("six Learning abilities, each a line manager's or an HOD's",
            len(LMS_KEYS) == 6 and {k.split(".")[0] for k in LMS_KEYS} == {"lm", "hod"} and roles >= {"lm", "hod"})
    s.check("...each with its label, and none clashing with a cycle ability",
            all(k in a.LEADER_ABILITY_LABEL for k in LMS_KEYS)
            and not set(LMS_KEYS) & {k for _g, k, _l, _n in a.LEADER_ABILITIES})
    env(None)
    s.check("Learning off: Leader roles' rows are the cycle's only", a.leader_abilities_shown() == a.LEADER_ABILITIES)
    pg = page(SU["id"], "/admin/roles?tab=leader")
    s.check("...and the tab shows none of Learning's", "l_lm.learn_approve" not in pg and "Their team's learning" not in pg)
    env("1")
    s.check("Learning on: its rows follow the cycle's",
            a.leader_abilities_shown() == a.LEADER_ABILITIES + a.LMS_LEADER_ABILITIES)
    pg = page(SU["id"], "/admin/roles?tab=leader")
    s.check("...on the tab, each in its own seat's column, ticked",
            all('name="l_%s" value="1" checked' % k in pg for k in LMS_KEYS)
            and "Their team's learning" in pg and "Their department's learning" in pg)

    s.section("saving touches only the rows on screen")
    SUP = H.client_as(a, SU["id"])
    off(["lm.learn_approve"])
    env(None)
    form = {"csrf_token": "tok", "action": "save"}
    form.update({"l_" + k: "1" for _g, k, _l, _n in a.LEADER_ABILITIES if k != "bu.fit"})
    SUP.post("/admin/roles?tab=leader", data=form)
    with a.app.app_context():
        now_off = a._leader_off(a.get_db())
    s.check("Learning off: a Learning row nobody saw keeps its state (still off), the change on screen lands",
            now_off == {"lm.learn_approve", "bu.fit"}, now_off)
    env("1")
    form = {"csrf_token": "tok", "action": "save"}
    form.update({"l_" + k: "1" for _g, k, _l, _n in a.leader_abilities_shown() if k != "lm.learn_confirm"})
    SUP.post("/admin/roles?tab=leader", data=form)
    with a.app.app_context():
        now_off = a._leader_off(a.get_db())
    det = one("SELECT detail FROM activity_log WHERE action='leader_role_access' ORDER BY id DESC LIMIT 1") or ""
    s.check("Learning on: its rows save like any other", now_off == {"lm.learn_confirm"}, now_off)
    s.check("...in the audit log, by seat and ability",
            "− Line manager: Confirm what a report applied, and their learning on the job" in det
            and "+ Line manager: Approve or return their reports' learning requests" in det, det)
    off([])

    s.section("approve or return")
    s.check("on: the line manager's step is theirs", (call(a.lms_actor_role, u_(M), reg_of(RA)) or {}).get("as") == "lm")
    off(["lm.learn_approve"])
    s.check("off: it isn't waiting on them any more", call(a.lms_actor_role, u_(M), reg_of(RA)) is None
            and RA not in [w["id"] for w in call(a.lms_waiting_on, u_(M))])
    ok, msg = call(a.lms_decide, u_(M), RA, "approve")
    s.check("...approving is refused, saying why, and nothing moves",
            not ok and "switched off for your role" in msg and reg_of(RA)["status"] == "pending", msg)
    pg = page(M, "/learning?view=team&tab=team")
    s.check("...the Team tab says so where the requests would be",
            "Approve or return their reports' learning requests is switched off for your role" in pg)
    s.check("...a step past its time passes up to the HOD as before",
            (call(a.lms_actor_role, u_(HOD), reg_of(RB)) or {}).get("escalated") is True)
    off(["lm.learn_approve", "hod.learn_approve"])
    ok, msg = call(a.lms_decide, u_(HOD), RB, "approve")
    s.check("the HOD's switched off too: refused, saying why", not ok and "switched off" in msg
            and call(a.lms_actor_role, u_(HOD), reg_of(RB)) is None, msg)
    off([])

    s.section("nominate")
    off(["lm.learn_nominate"])
    n0 = one("SELECT COUNT(*) FROM lms_registrations WHERE user_id IN (?,?)", (E3, E4))
    ok, msg = call(a.lms_nominate, u_(M), [(S, E3)])
    s.check("off: the line manager's nomination is refused, saying why, nothing made",
            not ok and "Nominate their reports" in msg and
            one("SELECT COUNT(*) FROM lms_registrations WHERE user_id IN (?,?)", (E3, E4)) == n0, msg)
    pg = page(M, "/learning?view=team&tab=plans")
    s.check("...the Their learning tab says so instead of the form",
            "Nominate their reports for a run is switched off" in pg and 'class="ln-card ls-npick"' not in pg)
    sh = call(a.lms_shell, u_(M), call(a.lms_space, u_(M), "team"), "plans")
    s.check("...and the tab's opening line no longer offers it", "Nominate" not in sh["opening"]["plans"],
            sh["opening"]["plans"])
    off(["hod.learn_round"])
    s.check("on: the form is back", 'class="ln-card ls-npick"' in page(M, "/learning?view=team&tab=plans"))
    ok, msg = call(a.lms_nominate, u_(HOD), [(S, E3)], RND)
    s.check("a round's nominations off: the HOD's are refused, saying why", not ok and "nomination round" in msg, msg)
    sp = call(a.lms_space, u_(HOD), "dept")
    s.check("...the Dept view lists no round, and says why", sp["rounds"] == [] and "switched off" in (
        sp["learn_off"]["round"] or ""))
    s.check("...and the dashboard's Nominate row goes", not any(
        "Nominate" == x.get("button") for x in ((call(a.dash_learning, u_(HOD)) or {}).get("acts") or [])))
    off([])
    s.check("on: the round shows in Dept", RND in [r["r"]["id"] for r in call(a.lms_space, u_(HOD), "dept")["rounds"]])

    s.section("confirm what they applied, and learning on the job")
    s.check("on: both wait on the line manager", [e["id"] for e in call(a.lms_eval_to_confirm, u_(M))] == [EV]
            and [o["id"] for o in call(a.lms_ojt_to_confirm, u_(M))] == [OJ])
    off(["lm.learn_confirm"])
    s.check("off: neither is listed", call(a.lms_eval_to_confirm, u_(M)) == [] and call(a.lms_ojt_to_confirm, u_(M)) == [])
    ok, msg = call(a.lms_eval_confirm, u_(M), EV, "confirm", "3")
    s.check("...confirming the 3-month check-in is refused, nothing moves",
            not ok and "switched off" in msg and one("SELECT status FROM lms_evaluations WHERE id=?", (EV,)) == "self_done",
            msg)
    ok, msg = call(a.lms_ojt_decide, u_(M), OJ, "confirm")
    s.check("...confirming learning on the job is refused, nothing moves",
            not ok and "switched off" in msg and one("SELECT status FROM lms_ojt WHERE id=?", (OJ,)) == "sent", msg)
    s.check("...someone else's is still \"not one of your team's\"", "isn't one of your team's" in
            call(a.lms_ojt_decide, u_(HOD), OJ, "confirm")[1])
    off([])

    s.section("excuse an absence")
    off(["lm.learn_excuse"])
    pg = page(M, "/learning?view=team&tab=team")
    s.check("off: no Excuse… on the Team tab", "ZZ LL E4" in pg and "Excuse…" not in pg)
    ok, msg = call(a.lms_absence_excuse, u_(M), AB, "MC on file")
    s.check("...the line manager's is refused, saying why",
            not ok and "switched off" in msg and one("SELECT status FROM lms_absences WHERE id=?", (AB,)) == "explained", msg)
    ok, msg = call(a.lms_absence_excuse, u_(LND), AB, "MC on file")
    s.check("...L&D still can", ok and one("SELECT status FROM lms_absences WHERE id=?", (AB,)) == "excused", msg)
    off([])

    s.section("who is never stopped")
    off(LMS_KEYS)
    s.check("an admin", all(a.leader_learn_can(u_(LND), k) for k in LMS_KEYS))
    off([])
    a._leader_unit_out = lambda u, db=None: {"label": "ZZLL U1"}
    with a.app.test_request_context():
        mm = u_(M)
        s.check("a leader whose unit the cycle leaves out keeps Learning's (it isn't part of a cycle)",
                not a.leader_can(mm, "lm.moderate") and a.leader_learn_can(mm, "lm.learn_approve"))
    a._leader_unit_out = _OUT0
finally:
    a._leader_unit_out = _OUT0
    env(_ENV0)
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM leader_role_access")
        db.executemany("INSERT INTO leader_role_access(role, ability, allowed) VALUES (?,?,?)", SAVED)
        db.execute("DELETE FROM activity_log WHERE action='leader_role_access' AND id>?", (LOG0,))
        db.commit()
        _cleanup(db)

sys.exit(s.done())
