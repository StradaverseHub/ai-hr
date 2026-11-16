"""The confirmation cut-off (Chris, 2 Nov 2026; canvas [design canvas link removed] boards 1-5: "let's add a
step before auto converting their role, the admin that input the confirmation date should have one step to mark if to add the
person to this round active cycle or not ... for import, same as well").

cycles.confirm_cutoff is an ISO date (NULL = none). It does NOT change who takes part by the rule: it leans the question asked at
each way a confirmation date goes in -- the person page's Mark confirmed / Change date, Add a person, the roster import -- "Add
them to <cycle>" or "Not this cycle", through ONE writer (_confirm_cycle_choice). Super admin only. What this suite holds:
  * the cut-off: saved, cleared by a posted blank, refused for a non-super admin and for a bad date, absent is not blank; the
    Participants card and its counts; the helpers; participant_sql is unchanged by it
  * the shared writer: out = Participants' own Take out (remove row, their 360 rows as the person rated archived); add = clears a
    take-out and otherwise writes NO row; below the lowest grade / a unit left out writes nothing; the choice is recorded and logged
  * the person page: a date with no choice (or a bad one) is refused and changes nothing; out / add do what the writer says;
    below the lowest grade there is nothing to choose; the box carries the question for the dialog
  * Add a person: the amber note, step 2's "This cycle" shown only after the cut-off, its answers through the writer, an answer required
  * the roster import: step 3's group appears only for dates after the cut-off that the file changes (not on or before, not with no
    cut-off, not below the grade, not unchanged), its answers are required, apply writes exactly the answered Take outs and records
    the choices; step 4's tiles and rows
  * Participants add / take out / back to the rule delete the recorded choice; the reason lines render
Synthetic (ZZCC-*) people on a fresh scratch database; Suite.done() puts it back.
"""
import csv as _csv
import hashlib
import html
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Confirmation cut-off: whoever enters the date chooses Add them or Not this cycle")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

P_PART = "/admin/participants"
P_USERS = "/admin/users"
P_IMP = "/admin/import/roster"
CUT = "2026-09-01"

with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    CYC = dict(a.active_cycle(db))
    CID = CYC["id"]
    db.execute("UPDATE cycles SET half=2, kind='year_end', min_job_grade=12, confirm_cutoff=NULL WHERE id=?", (CID,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=?", (CID,))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, '0')", (a.UROLE_SERVICE_KEY,))   # only a date confirms
    UNIT = db.execute("SELECT business_group, company FROM org_units WHERE company!='' ORDER BY business_group, company "
                      "LIMIT 1").fetchone()
    BG, CO = UNIT[0], UNIT[1]
    CO2 = "ZZCC Left Out Unit"
    db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, CO2))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, name, jg="14", conf=None, company=None, role="user", admin_bg=None, mgr=None):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=mgr,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=company or CO,
                 department="ZZCC Dept", job_title="ZZCC Engineer", job_grade=jg, years_of_service=0.5,
                 confirmation_date=conf, left_at=None, is_demo=0, role=role, admin_bg=admin_bg, admin_role_id=None,
                 user_role_id=None)
        d_ = a.get_db()   # the connection of the request context it is called in
        d_.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        return d_.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]
    BGA = mk("ZZCC-BGA", "ZZ CC Bgadmin", role="admin", admin_bg=BG)
    RATER1 = mk("ZZCC-R1", "ZZ CC Rater One", conf="2020-01-01")
    RATER2 = mk("ZZCC-R2", "ZZ CC Rater Two", conf="2020-01-01")
    LATE = mk("ZZCC-LATE", "ZZ CC Late", conf=None)         # Basic now; the person page gives them a date after the cut-off
    LATE2 = mk("ZZCC-LATE2", "ZZ CC Latetwo", conf=None)
    EARLY = mk("ZZCC-EARLY", "ZZ CC Early", conf=None)      # given a date on or before the cut-off
    LOW = mk("ZZCC-LOW", "ZZ CC Low", jg="10", conf=None)   # below the cycle's lowest grade
    OUTU = mk("ZZCC-UNIT", "ZZ CC Unitout", conf=None, company=CO2)
    db.execute("INSERT INTO cycle_exclusions(cycle_id, business_group, company, department) VALUES (?,?,?, '')", (CID, BG, CO2))
    # 360 panels as the person rated, live: LATE has two, EARLY one
    for subj, assr in ((LATE, RATER1), (LATE, RATER2), (EARLY, RATER1)):
        db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship) VALUES (?,?,?, 'peer')",
                   (CID, subj, assr))
    db.commit()

sup = H.client_as(a, SUP)
bga = H.client_as(a, BGA)


def one(sql, args=()):
    return H.one(a, sql, args)


def rows_(sql, args=()):
    return [tuple(r) for r in H.rows(a, sql, args)]


def uid(eid):
    return one("SELECT id FROM users WHERE employee_id=?", (eid,))


def part_row(u):
    r = rows_("SELECT mode FROM cycle_participants WHERE cycle_id=? AND subject_id=?", (CID, u))
    return r[0][0] if r else None


def choice_row(u):
    r = rows_("SELECT choice, conf_date, source, set_by FROM cycle_confirm_choices WHERE cycle_id=? AND subject_id=?", (CID, u))
    return r[0] if r else None


def live360(u):
    return one("SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND subject_id=? AND archived=0", (CID, u))


def conf_of(u):
    return one("SELECT confirmation_date FROM users WHERE id=?", (u,))


def set_cut(v):
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE cycles SET confirm_cutoff=? WHERE id=?", (v, CID))
        d.commit()


def cyc_row():
    with a.app.test_request_context("/"):
        return a.get_db().execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()


def text(resp):
    return html.unescape(resp.get_data(as_text=True))


def post_conf(client, u, date, choice=None, follow=True):
    d = {"csrf_token": "tok", "action": "set_confirmed", "user_id": str(u), "confirmation_date": date, "next": P_USERS}
    if choice is not None:
        d["cycle_choice"] = choice
    return client.post(P_USERS, data=d, follow_redirects=follow)


def taking_idp(u):
    with a.app.test_request_context("/"):
        d = a.get_db()
        return a.idp_participation(d, d.execute("SELECT * FROM users WHERE id=?", (u,)).fetchone())


def taking(u):
    with a.app.test_request_context("/"):
        d = a.get_db()
        return a.participation(d, d.execute("SELECT * FROM users WHERE id=?", (u,)).fetchone(), a.active_cycle(d))


try:
    # =======================================================================
    s.section("the helpers, and the rule is untouched")
    set_cut(None)
    s.check("no cut-off: confirm_cutoff_of is None and nothing is after it",
            a.confirm_cutoff_of(cyc_row()) is None and not a.confirmed_after_cutoff(cyc_row(), "2030-01-01"))
    set_cut(CUT)
    s.check("a cut-off reads as the ISO date", a.confirm_cutoff_of(cyc_row()) == CUT)
    s.check("after it only strictly after: the day itself is on the cut-off",
            a.confirmed_after_cutoff(cyc_row(), "2026-09-02") and not a.confirmed_after_cutoff(cyc_row(), CUT)
            and not a.confirmed_after_cutoff(cyc_row(), "2026-08-31") and not a.confirmed_after_cutoff(cyc_row(), None)
            and not a.confirmed_after_cutoff(cyc_row(), ""))
    s.check("a junk value is no cut-off", (lambda: (set_cut("soon"), a.confirm_cutoff_of(cyc_row()))[1])() is None)
    set_cut(CUT)
    with a.app.test_request_context("/"):
        d = a.get_db()
        sql_before = a.participant_sql("u")
    src = H.code_without_docstrings(H.source(a))
    s.check("participant_sql does not read the cut-off", "confirm_cutoff" not in sql_before)

    # =======================================================================
    s.section("Participants: the cut-off card, saved, cleared, refused")
    set_cut(None)
    pg = text(sup.get(P_PART + "?show=all"))
    s.check("the card is there with its title and a blank date", 'aria-labelledby="pt-co-h"' in pg and "Confirmation cut-off" in pg
            and "No cut-off set" in pg)
    r = sup.post(P_PART, data={"csrf_token": "tok", "action": "confirm_cutoff", "confirm_cutoff": CUT}, follow_redirects=True)
    s.check("the super admin saves it", a.confirm_cutoff_of(cyc_row()) == CUT, text(r)[:0])
    s.check("...and it is logged with the cycle and the date", one(
        "SELECT COUNT(*) FROM activity_log WHERE action='participant_confirm_cutoff' AND detail LIKE ?", ("%1 Sep 2026%",)) == 1)
    s.check("...the page says what it means", "chooses Add them or Not this cycle" in text(r))
    pg = text(sup.get(P_PART + "?show=all"))
    s.check("the card then says who is in by the rule and who chooses",
            "Confirmed on or before 1 Sep 2026: in " + CYC["name"] + " by the rule." in pg and "confirmed after it" in pg
            and 'name="confirm_cutoff"' in pg and 'value="2026-09-01"' in pg)
    s.check("Participants says the Career Plan is everyone's, taken out or not, and its Take out box says they keep it and still rate "
            "(no longer that the plan is no longer required)",
            "Career Plan (at Year-End) is everyone's, confirmed or not, taken out or not" in pg
            and "They keep their Career Plan and still rate colleagues on the 360." in pg
            and "their Career Plan included, are no longer required" not in pg)
    s.check("its Save asks first, naming the cycle (data-confirm)", "data-confirm-title=\"Change the confirmation cut-off?\"" in pg
            and CYC["name"] in pg)
    r = sup.post(P_PART, data={"csrf_token": "tok", "action": "confirm_cutoff", "confirm_cutoff": "31/12/2026"}, follow_redirects=True)
    s.check("a date that is not a date is refused and the cut-off stays", a.confirm_cutoff_of(cyc_row()) == CUT
            and "Pick the cut-off date" in text(r))
    r = sup.post(P_PART, data={"csrf_token": "tok", "action": "confirm_cutoff"})
    s.check("absent is not blank: a post with no field is refused and nothing changes", r.status_code == 400
            and a.confirm_cutoff_of(cyc_row()) == CUT)
    r = bga.post(P_PART, data={"csrf_token": "tok", "action": "confirm_cutoff", "confirm_cutoff": "2026-01-01"})
    s.check("a BG admin can't set it (403) and it stays", r.status_code == 403 and a.confirm_cutoff_of(cyc_row()) == CUT, r.status_code)
    r = bga.post(P_PART, data={"csrf_token": "tok", "action": "confirm_cutoff", "confirm_cutoff": ""})
    s.check("...nor clear it", r.status_code == 403 and a.confirm_cutoff_of(cyc_row()) == CUT)
    s.check("the access map has it as the super admin's", a.ADMIN_ACCESS_MAP["admin_participants"]["map"].get("confirm_cutoff") == "super")
    pg_bga = text(bga.get(P_PART + "?show=all"))
    s.check("a BG admin reads the card but has no form", "Confirmation cut-off" in pg_bga and 'name="confirm_cutoff"' not in pg_bga)
    r = sup.post(P_PART, data={"csrf_token": "tok", "action": "confirm_cutoff", "confirm_cutoff": ""}, follow_redirects=True)
    s.check("a posted blank clears it", a.confirm_cutoff_of(cyc_row()) is None and "has no confirmation cut-off" in text(r))
    set_cut(CUT)

    # =======================================================================
    s.section("the shared writer: out is a Take out, add clears one and writes no row")
    def writer(u, conf, choice, source="person", join_now=False):
        with a.app.test_request_context("/"):
            d = a.get_db()
            me = dict(d.execute("SELECT * FROM users WHERE id=?", (SUP,)).fetchone())
            res = a._confirm_cycle_choice(d, me, a.active_cycle(d), u, conf, choice, source, join_now)
            d.commit()
            return res
    with a.app.test_request_context("/"):   # as in the real flow, the date is already on them when the writer runs
        d = a.get_db()
        d.execute("UPDATE users SET confirmation_date='2026-10-15' WHERE id=?", (LATE,))
        d.commit()
    n0 = live360(LATE)
    rows, why = writer(LATE, "2026-10-15", "out")
    s.check("out: the remove row is written, their live 360 rows as the person rated are archived with Participants' reason",
            part_row(LATE) == "remove" and rows[0] == n0 == 2 and live360(LATE) == 0 and why is None
            and one("SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND subject_id=? AND archive_reason=?",
                    (CID, LATE, a.PARTICIPANT_OUT_REASON)) == 2, (part_row(LATE), rows))
    s.check("...the choice is recorded with the date, the source and who", choice_row(LATE) == ("out", "2026-10-15", "person", SUP),
            choice_row(LATE))
    s.check("...and logged with who, what and the date", one(
        "SELECT COUNT(*) FROM activity_log WHERE action='participant_confirm_choice' AND target_user_id=? AND detail LIKE ? AND "
        "detail LIKE ?", (LATE, "%not this cycle%15 Oct 2026%after the cut-off%", "%2 360 rows%")) == 1)
    s.check("...they take no part by the rule's mirror", taking(LATE)[0] is False and taking(LATE)[1] == "removed")
    rows, why = writer(LATE, "2026-10-15", "add")
    s.check("add: the take-out is cleared (Back to the rule) and nothing else written; their 360 rows return",
            part_row(LATE) is None and live360(LATE) == 2 and rows[1] == 2 and why is None, (part_row(LATE), rows))
    s.check("...the choice row now says add", choice_row(LATE)[0] == "add")
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE users SET confirmation_date='2026-10-15' WHERE id=?", (LATE2,))
        d.commit()
    rows, why = writer(LATE2, "2026-10-15", "add")
    s.check("add on someone with no override writes NO cycle_participants row (the rule brings them in on their date)",
            part_row(LATE2) is None and rows == (0, 0, 0) and choice_row(LATE2)[0] == "add")
    s.check("...and they take part by the rule, their date being past", taking(LATE2) == (True, "confirmed"), taking(LATE2))
    rows, why = writer(LATE2, "2026-10-15", "out")
    s.check("a take-out is the plain Take out: the one remove row", part_row(LATE2) == "remove")
    # back to clean for the next section
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("DELETE FROM cycle_participants WHERE subject_id IN (?,?)", (LATE, LATE2))
        d.execute("DELETE FROM cycle_confirm_choices WHERE subject_id IN (?,?)", (LATE, LATE2))
        d.execute("UPDATE users SET confirmation_date=NULL WHERE id IN (?,?)", (LATE, LATE2))
        d.execute("UPDATE assignments SET archived=0, archived_at=NULL, archived_by=NULL, archive_reason=NULL WHERE subject_id IN (?,?)",
                  (LATE, LATE2))
        d.commit()
    rows, why = writer(LOW, "2026-10-15", "out")
    s.check("below the lowest grade: refused, nothing written", why == "below_min_grade" and rows is None
            and part_row(LOW) is None and choice_row(LOW) is None)
    rows, why = writer(OUTU, "2026-10-15", "add")
    s.check("in a unit the cycle leaves out: refused, nothing written", why == "unit_out" and part_row(OUTU) is None
            and choice_row(OUTU) is None)
    rows, why = writer(LATE, "2026-10-15", "maybe")
    s.check("an answer that is neither add nor out writes nothing", why == "bad" and part_row(LATE) is None and choice_row(LATE) is None)
    rows, why = writer(LATE, "2026-10-15", "out", source="somewhere")
    s.check("nor a made-up source", why == "bad" and part_row(LATE) is None and choice_row(LATE) is None)

    # =======================================================================
    s.section("the person page: Mark confirmed / Change date")
    r = sup.get("/admin/users/%d" % LATE)
    pgp = text(r)
    s.check("the box carries the cycle question for the dialog (data-cycle-choice) and the new words",
            'data-cycle-choice="' in pgp and CYC["name"] in pgp and "On it they move from Basic to Full." in pgp
            and "join the running cycle" not in pgp, r.status_code)
    m = re.search(r'data-cycle-choice="([^"]*)"', r.get_data(as_text=True))
    import json as _json
    cfg = _json.loads(html.unescape(m.group(1))) if m else {}
    s.check("...with the cut-off, the cycle, what they hold (no KPI lines, a panel of 2) and no standing answer",
            cfg.get("cutoff") == CUT and cfg.get("cutoff_day") == "1 Sep 2026" and cfg.get("kpis") == 0 and cfg.get("panel") == 2
            and cfg.get("current") is None and cfg.get("refuse") is None, cfg)
    pgl = text(sup.get("/admin/users/%d" % LOW))
    m = re.search(r'data-cycle-choice="([^"]*)"', html.unescape(pgl) and sup.get("/admin/users/%d" % LOW).get_data(as_text=True))
    cfg_low = _json.loads(html.unescape(m.group(1))) if m else {}
    s.check("below the lowest grade the box carries one line and no choice", "below" in (cfg_low.get("refuse") or "")
            and "JG 12" in (cfg_low.get("refuse") or ""), cfg_low.get("refuse"))
    pgu = sup.get("/admin/users/%d" % OUTU).get_data(as_text=True)
    m = re.search(r'data-cycle-choice="([^"]*)"', pgu)
    cfg_u = _json.loads(html.unescape(m.group(1))) if m else {}
    s.check("in a unit left out: one line as well", "isn't taking part" in (cfg_u.get("refuse") or ""), cfg_u.get("refuse"))
    s.check("a BG admin gets no such box (the date is the super admin's)",
            'data-cycle-choice="' not in bga.get("/admin/users/%d" % LATE).get_data(as_text=True))

    # the guard: a date with no choice, and a bad one, change nothing
    r = post_conf(sup, LATE, "2026-10-15")
    s.check("a date with no choice is refused with a flash, and the date, the rows and the choice are all unchanged",
            conf_of(LATE) is None and part_row(LATE) is None and choice_row(LATE) is None and live360(LATE) == 2
            and "Choose Add them to" in text(r), text(r)[:0])
    r = post_conf(sup, LATE, "2026-10-15", "maybe")
    s.check("...so is a choice that is neither add nor out", conf_of(LATE) is None and choice_row(LATE) is None
            and "Choose Add them to" in text(r))
    r = post_conf(sup, LATE, "2026-10-15", "")
    s.check("...nor a blank one (absent is not empty)", conf_of(LATE) is None and choice_row(LATE) is None)
    r = post_conf(sup, LATE, "not-a-date", "out")
    s.check("...nor a bad date with a good choice", conf_of(LATE) is None and part_row(LATE) is None)
    r = post_conf(bga, LATE, "2026-10-15", "out", follow=False)
    s.check("a BG admin's post changes nothing (set_confirmed is the super admin's)", conf_of(LATE) is None and part_row(LATE) is None
            and choice_row(LATE) is None, r.status_code)
    # and with a choice it goes in: the guard is what stopped the posts above
    r = post_conf(sup, LATE, "2026-10-15", "out")
    s.check("with a choice the same post goes in: the date is set and Not this cycle is a Take out",
            conf_of(LATE) == "2026-10-15" and part_row(LATE) == "remove" and live360(LATE) == 0
            and choice_row(LATE) == ("out", "2026-10-15", "person", SUP), (conf_of(LATE), part_row(LATE)))
    t = text(r)
    s.check("the flash says what happened in both parts", "confirmed — effective 2026-10-15" in t and "is not in " + CYC["name"] in t
            and "2 360 rows as the person rated are archived" in t, t[:0])
    # Not this cycle ends only their OWN review: the Career Plan and the 360 they give stay (Chris, 2026-11-03: "those not
    # participating should all get to be 360 rater and IDP"; the trigger was a person confirmed after the cut-off who lost the
    # plan they had been writing while unconfirmed)
    with a.app.test_request_context("/"):
        d = a.get_db()
        lu = d.execute("SELECT * FROM users WHERE id=?", (LATE,)).fetchone()
        has_plan = a.idp_participation(d, lu)
        in_plan = d.execute("SELECT 1 FROM users WHERE id=? AND " + a.idp_participant_sql(), (LATE,)).fetchone() is not None
        in_review = d.execute("SELECT 1 FROM users WHERE id=? AND " + a.participant_sql(), (LATE,)).fetchone() is not None
        may_rate = d.execute("SELECT 1 FROM users WHERE id=? AND " + a.assessor_eligible_sql(), (LATE,)).fetchone() is not None
        st_l = a.review_state(d, lu)
        stages_l = [x["key"] for x in a._journey_live_stages(st_l)]
    s.check("Not this cycle: no review of their own, yet their Career Plan stays (idp_participation, idp_participant_sql, their journey)",
            has_plan == (True, "removed") and in_plan and not in_review and st_l["participant"] is False
            and st_l["idp_participant"] is True and "career_plan" in stages_l, (has_plan, in_plan, in_review, stages_l))
    s.check("...and they may still rate colleagues on the 360 (assessor_eligible_sql reads no take-out)", may_rate)
    rg = H.client_as(a, LATE).post("/idp/autosave", data={"csrf_token": "tok", "action": "add", "area": "ZZCC take-out goal"})
    s.check("...and they write a Career Plan goal through its POST route",
            rg.status_code == 200 and (rg.get_json(silent=True) or {}).get("ok") is True and one(
                "SELECT COUNT(*) FROM pm_idp_goals g JOIN pm_idp i ON i.id=g.idp_id WHERE i.subject_id=?", (LATE,)) == 1,
            (rg.status_code, rg.get_json(silent=True)))
    s.check("control: below the lowest grade and in a left-out unit stay without a plan", all(
        taking_idp(u) == (False, w) for u, w in ((LOW, "below_min_grade"), (OUTU, "unit_out"))), (taking_idp(LOW), taking_idp(OUTU)))
    pgp = sup.get("/admin/users/%d" % LATE).get_data(as_text=True)
    m = re.search(r'data-cycle-choice="([^"]*)"', pgp)
    cfg = _json.loads(html.unescape(m.group(1)))
    s.check("their standing take-out is what the next Change date pre-selects", cfg["current"] == "out", cfg["current"])
    s.check("the date box's Not this cycle words say they keep their Career Plan and still rate (and no longer 'no Career Plan')",
            "They keep their Career Plan, still rate colleagues on the 360" in html.unescape(pgp) and "no Career Plan in" not in pgp)
    r = post_conf(sup, LATE, "2026-10-16", "add")
    s.check("Change date, Add them: the take-out goes (Back to the rule), their rows come back, the choice says add",
            conf_of(LATE) == "2026-10-16" and part_row(LATE) is None and live360(LATE) == 2 and choice_row(LATE)[0] == "add"
            and "added to " + CYC["name"] in text(r))
    r = post_conf(sup, LATE2, "2026-09-15", "add")
    s.check("Add them for someone with no row writes no cycle_participants row, and they take part from their date",
            part_row(LATE2) is None and conf_of(LATE2) == "2026-09-15" and choice_row(LATE2)[0] == "add"
            and taking(LATE2)[0] is True)
    r = post_conf(sup, EARLY, "2026-08-20", "add")
    s.check("a date on or before the cut-off goes through the same writer: add, no row, and the choice is recorded",
            part_row(EARLY) is None and choice_row(EARLY) == ("add", "2026-08-20", "person", SUP) and live360(EARLY) == 1)
    # below the grade / unit left out: nothing to choose
    r = post_conf(sup, LOW, "2026-10-15")
    s.check("below the lowest grade: the date goes in with no choice, nothing is written for the cycle, and it says so",
            conf_of(LOW) == "2026-10-15" and part_row(LOW) is None and choice_row(LOW) is None
            and "nothing to choose" in text(r), text(r)[:0])
    r = post_conf(sup, LOW, "2026-10-16", "out")
    s.check("...and a choice posted for them is not written (the server refuses it)", conf_of(LOW) == "2026-10-16"
            and part_row(LOW) is None and choice_row(LOW) is None)
    r = post_conf(sup, OUTU, "2026-10-15", "out")
    s.check("in a unit left out: the same, no Take out row, no choice", conf_of(OUTU) == "2026-10-15" and part_row(OUTU) is None
            and choice_row(OUTU) is None and "nothing to choose" in text(r))
    # no active cycle: the plain date as before
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE cycles SET is_active=0 WHERE id=?", (CID,))
        d.commit()
    try:
        r = post_conf(sup, RATER1, "2020-02-02")
        s.check("with no cycle active a date goes in with no choice asked, as before", conf_of(RATER1) == "2020-02-02")
    finally:
        with a.app.test_request_context("/"):
            d = a.get_db()
            d.execute("UPDATE cycles SET is_active=1 WHERE id=?", (CID,))
            d.execute("UPDATE users SET confirmation_date='2020-01-01' WHERE id=?", (RATER1,))
            d.commit()

    # =======================================================================
    s.section("Participants: reason lines, counts, and every later admin action deletes the choice")
    pg = text(sup.get(P_PART + "?show=all"))
    s.check("an add after the cut-off reads 'Added when confirmed, after the cut-off · who, date'",
            "Added when confirmed, after the cut-off · " in pg)
    s.check("an add on or before it reads 'Added when confirmed ·' (no 'after the cut-off')",
            re.search(r"Added when confirmed · ", pg) is not None)
    pg_out = text(sup.get(P_PART + "?show=out"))
    # a person whose date is after it and who is out
    post_conf(sup, LATE, "2026-10-17", "out")
    pg_out = text(sup.get(P_PART + "?show=out"))
    s.check("a Not this cycle reads 'Not this cycle, chosen when confirmed, after the cut-off · who, date' and is under Not taking part",
            "Not this cycle, chosen when confirmed, after the cut-off · " in pg_out and "ZZ CC Late" in pg_out)
    # a plain person with a date on or before and no override
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE users SET confirmation_date='2026-07-01' WHERE id=?", (RATER2,))
        d.commit()
    pg_all = text(sup.get(P_PART + "?show=all"))
    s.check("someone confirmed on or before the cut-off, no override: 'Confirmed on or before the cut-off'",
            "Confirmed on or before the cut-off" in pg_all)
    s.check("the confirmation column reads as a day ('1 Jul 2026')", "1 Jul 2026" in pg_all)
    s.check("the card's count line counts those confirmed after it, those added and those not this cycle",
            re.search(r"([\d,]+) confirmed after it .{0,30}· ([\d,]+) added · ([\d,]+) not this cycle", pg_all) is not None)
    mm = re.search(r"([\d,]+) confirmed after it .{0,30}· ([\d,]+) added · ([\d,]+) not this cycle", pg_all)
    with a.app.test_request_context("/"):
        d = a.get_db()
        late_ids = {r_[0] for r_ in d.execute("SELECT id FROM users WHERE role!='admin' AND left_at IS NULL AND confirmation_date > ? "
                                              "AND is_demo=0", (CUT,))}
        want_after = sum(1 for i in late_ids if d.execute("SELECT job_grade, company FROM users WHERE id=?", (i,)).fetchone()
                         and a.below_min_grade(d, d.execute("SELECT * FROM users WHERE id=?", (i,)).fetchone()) is None
                         and not a.unit_out(d, d.execute("SELECT * FROM users WHERE id=?", (i,)).fetchone()))
        want_add = sum(1 for i in late_ids if (c := choice_row(i)) and c[0] == "add" and taking(i)[0])
        want_out = sum(1 for i in late_ids if (c := choice_row(i)) and c[0] == "out" and taking(i)[1] == "removed")
    s.check("...and the numbers are the people the page's own rule finds", mm and tuple(int(x.replace(",", "")) for x in mm.groups()) ==
            (want_after, want_add, want_out), (mm.groups() if mm else None, (want_after, want_add, want_out)))
    # Participants' own actions delete the choice (a later admin action supersedes it)
    def part(action, u):
        return sup.post(P_PART, data={"csrf_token": "tok", "action": action, "ids": [str(u)]}, follow_redirects=True)
    s.check("before: LATE holds an 'out' choice", choice_row(LATE) and choice_row(LATE)[0] == "out")
    part("clear", LATE)
    s.check("Back to the confirmation rule deletes the choice", choice_row(LATE) is None and part_row(LATE) is None)
    post_conf(sup, LATE, "2026-10-17", "out")
    s.check("(re-recorded)", choice_row(LATE) and choice_row(LATE)[0] == "out")
    part("add", LATE)
    s.check("Add to this cycle deletes the choice (and writes its own add row)", choice_row(LATE) is None and part_row(LATE) == "add")
    post_conf(sup, LATE, "2026-10-17", "add")   # add over an add row: the admin's add stands
    s.check("(a choice over an admin's add leaves the add alone)", part_row(LATE) == "add" and choice_row(LATE)[0] == "add")
    part("remove", LATE)
    s.check("Take out of this cycle deletes the choice", choice_row(LATE) is None and part_row(LATE) == "remove")
    part("clear", LATE)
    # the Confirmation rating add
    post_conf(sup, LATE, "2026-10-17", "out")
    with a.app.test_request_context("/"):
        d = a.get_db()
        me = dict(d.execute("SELECT * FROM users WHERE id=?", (SUP,)).fetchone())
        p_ = d.execute("SELECT * FROM users WHERE id=?", (LATE,)).fetchone()
        n_, why_ = a._confirmation_add(d, me, a.active_cycle(d), [(p_, 3)], "ZZCC reason")
        d.commit()
    s.check("a Confirmation-rating add deletes the choice too", why_ is None and choice_row(LATE) is None and part_row(LATE) == "add",
            (why_, part_row(LATE)))
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id=?)", (LATE,))
        d.execute("DELETE FROM pm_review_session WHERE subject_id=?", (LATE,))
        d.execute("DELETE FROM pm_kpi_targets WHERE subject_id=?", (LATE,))
        d.commit()
    part("clear", LATE)

    # =======================================================================
    s.section("Add a person: the amber note, and step 2's 'This cycle' only after the cut-off")
    pg = text(sup.get("/admin/users?view=add"))
    s.check("the Details step carries the cut-off for its note (the JS has it) and the note's words",
            '"cutoff": "2026-09-01"' in pg and "confirmation cut-off (" in pg and "you choose whether they take part in it" in pg)
    s.check("a BG admin's page carries no cut-off (they cannot enter a date)",
            '"cutoff": null' in text(bga.get("/admin/users?view=add")))
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE users SET confirmation_date='2026-10-15' WHERE id=?", (LATE,))     # after: the rule takes them (date past)
        d.execute("UPDATE users SET confirmation_date='2026-08-15' WHERE id=?", (EARLY,))    # on or before: in by the rule
        d.execute("UPDATE users SET confirmation_date='2026-12-15' WHERE id=?", (LATE2,))    # after, still to come: Basic
        d.execute("DELETE FROM cycle_participants WHERE subject_id IN (?,?,?)", (LATE, EARLY, LATE2))
        d.execute("DELETE FROM cycle_confirm_choices WHERE subject_id IN (?,?,?)", (LATE, EARLY, LATE2))
        d.commit()

    def step2(u):
        return text(sup.get("/admin/users?view=add&step=kpis&uid=%d" % u))
    pg = step2(LATE)
    s.check("after the cut-off and taking part by the rule: 'This cycle' shows, with the cut-off's words on Add them",
            'aria-label="This cycle"' in pg and "They're confirmed after its cut-off (1 Sep 2026), so you choose." in pg
            and "from 15 Oct 2026" in pg and "Not this cycle" in pg, pg[:0])
    s.check("...Not this cycle is the pre-selected answer (after the cut-off)",
            re.search(r'name="cycle" value="skip" data-wiz-cycle checked', pg) is not None
            and re.search(r'name="cycle" value="add" data-wiz-cycle checked', pg) is None)
    s.check("...and Not this cycle says they keep their Career Plan and still rate colleagues",
            "They keep their Career Plan and still rate colleagues on the 360" in pg)
    pg = step2(EARLY)
    s.check("on or before the cut-off and taking part: no 'This cycle' section", 'aria-label="This cycle"' not in pg)
    pg = step2(LATE2)
    s.check("after it and not taking part yet (date to come): the section shows with the cut-off's words",
            'aria-label="This cycle"' in pg and "so you choose" in pg)
    pg = step2(LOW)
    s.check("below the lowest grade: its own one line, no radios", "is below" in pg and 'name="cycle" value="add"' not in pg)
    # the answers
    KP = "/admin/people/add/%d"

    def kpi_post(u, cycle=None, then="skip"):
        d = {"csrf_token": "tok", "action": "kpis", "then": then}
        if cycle is not None:
            d["cycle"] = cycle
        return sup.post(KP % u, data=d, follow_redirects=False)
    r = kpi_post(LATE)   # no answer
    s.check("no answer is refused: nothing written, and back on the same step", choice_row(LATE) is None and part_row(LATE) is None
            and "step=kpis" in r.headers.get("Location", ""))
    r = kpi_post(LATE, "maybe")
    s.check("...nor an answer that is neither", choice_row(LATE) is None and part_row(LATE) is None)
    r = kpi_post(LATE, "skip")
    s.check("Not this cycle (skip) goes through the writer: a Take out, the rows archived, the choice recorded as Add a person's",
            part_row(LATE) == "remove" and live360(LATE) == 0 and choice_row(LATE)[2] == "add_person" and choice_row(LATE)[0] == "out"
            and "step=job" in r.headers.get("Location", ""), (part_row(LATE), choice_row(LATE)))
    r = kpi_post(LATE, "add")
    s.check("Add them clears that take-out and writes no row (the rule takes them: their date is past)",
            part_row(LATE) is None and choice_row(LATE)[0] == "add" and live360(LATE) == 2 and taking(LATE)[0])
    r = kpi_post(LATE2, "add")
    s.check("Add them for a date still to come writes the usual admin add (so their KPIs can be set now) and records the choice",
            part_row(LATE2) == "add" and choice_row(LATE2) == ("add", "2026-12-15", "add_person", SUP))
    r = kpi_post(LATE2, "skip")
    s.check("...and Not this cycle then takes them out", part_row(LATE2) == "remove" and choice_row(LATE2)[0] == "out")
    # not after the cut-off: the old rules
    r = kpi_post(EARLY, "skip")
    s.check("on or before the cut-off the old path stands: skip writes nothing", part_row(EARLY) is None and choice_row(EARLY) is None)
    # the Confirmation rating, for someone the rule already takes but confirmed after the cut-off
    r = sup.post(KP % LATE, data={"csrf_token": "tok", "action": "confirm", "rating": "3", "reason": "ZZCC rated"},
                 follow_redirects=False)
    s.check("the Confirmation rating is allowed for someone confirmed after the cut-off even though the rule already takes them",
            part_row(LATE) == "add" and choice_row(LATE) is None and "step=job" in r.headers.get("Location", ""),
            (part_row(LATE), r.headers.get("Location")))
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id=?)", (LATE,))
        d.execute("DELETE FROM pm_review_session WHERE subject_id=?", (LATE,))
        d.execute("DELETE FROM pm_kpi_targets WHERE subject_id=?", (LATE,))
        d.execute("DELETE FROM cycle_participants WHERE subject_id IN (?,?,?)", (LATE, EARLY, LATE2))
        d.execute("DELETE FROM cycle_confirm_choices WHERE subject_id IN (?,?,?)", (LATE, EARLY, LATE2))
        d.commit()
    r = sup.post(KP % EARLY, data={"csrf_token": "tok", "action": "confirm", "rating": "3", "reason": "ZZCC rated"})
    s.check("...but not for someone confirmed on or before it who takes part by the rule (unchanged)",
            part_row(EARLY) is None, part_row(EARLY))
    # a BG admin never gets the question
    r = bga.post(KP % LATE2, data={"csrf_token": "tok", "action": "kpis", "then": "skip", "cycle": "skip"})
    s.check("a BG admin's Add a person step is the old one: no choice recorded", choice_row(LATE2) is None
            or choice_row(LATE2)[3] != BGA)
    # Add, and stop here with a date after the cut-off goes on to the question
    add = {"csrf_token": "tok", "action": "add_user", "business_group": BG, "company": CO, "manager_eid": "ZZCC-R1",
           "hod_eid": "ZZCC-R2", "job_grade": "14", "joined_date": "2026-06-01", "employment_type": "Permanent",
           "job_title": "ZZCC Engineer", "department": "ZZCC Dept", "full_name": "ZZ CC Added",
           "employee_id": "ZZCC-ADD", "confirmation_date": "2026-10-20", "then": "stop"}
    r = sup.post(P_USERS, data=add, follow_redirects=False)
    nu = rows_("SELECT id FROM users WHERE employee_id='ZZCC-ADD'")
    s.check("Add, and stop here with a date after the cut-off still goes on to the cycle question (the step), not the list",
            bool(nu) and "step=kpis" in r.headers.get("Location", "") and "view=add" in r.headers.get("Location", ""),
            (r.status_code, r.headers.get("Location"), text(r)[:0]))
    add2 = dict(add, employee_id="ZZCC-ADD2", full_name="ZZ CC Addedtwo", confirmation_date="2026-08-20")
    r = sup.post(P_USERS, data=add2, follow_redirects=False)
    s.check("...and with a date on or before it, stop here stops", "step=kpis" not in r.headers.get("Location", ""),
            r.headers.get("Location"))

    # =======================================================================
    s.section("the roster import: step 3's group, the answers, step 4")
    COLS = {c.lower(): c for c in a.ROSTER_COLUMNS}

    def row(**kw):
        r_ = dict.fromkeys(a.ROSTER_COLUMNS, "")
        r_.update({COLS["business group"]: BG, COLS["company"]: CO, COLS["job grade"]: "14", COLS["joined date"]: "2018-01-01"})
        for k, v in kw.items():
            r_[COLS[k.replace("_", " ")]] = v
        return [r_[c] for c in a.ROSTER_COLUMNS]

    def upload(rs):
        buf = io.StringIO()
        w = _csv.writer(buf)
        w.writerow(a.ROSTER_COLUMNS)
        w.writerows(rs)
        r_ = sup.post(P_IMP, data={"csrf_token": "tok", "mode": "upsert", "preview": "1",
                                   "file": (io.BytesIO(buf.getvalue().encode()), "cc.csv")}, content_type="multipart/form-data")
        return r_.headers.get("Location", "").split("check=")[-1]

    def fid(key):
        return "d_" + hashlib.sha1(key.encode()).hexdigest()[:10]

    def pg_imp(tok, step=""):
        return text(sup.get(P_IMP + "?check=%s%s" % (tok, "&step=" + step if step else "")))

    def groups(rs):
        tok = upload(rs)
        sup.post(P_IMP, data={"csrf_token": "tok", "token": tok, "action": "quality_ok", "ack": "1"})
        with a.app.test_request_context("/"):
            d = a.get_db()
            me = dict(d.execute("SELECT * FROM users WHERE id=?", (SUP,)).fetchone())
            fn, data, auth = a._roster_staged(me, tok)
            chk = a._roster_check(d, me, a._read_records(fn, data), False)
            chg = a._rimp_changes(d, me, chk, {})
        grp = [g for g in chg["decide"] if g["title"].startswith("Confirmed after the cycle's cut-off")]
        return tok, grp

    # fresh people for the import
    with a.app.test_request_context("/"):
        d = a.get_db()
        I_A = mk("ZZCC-IA", "ZZ CC Importa", conf=None)           # date changes to after the cut-off: asked
        I_B = mk("ZZCC-IB", "ZZ CC Importb", conf=None)           # to on or before: not asked, in by the rule
        I_D = mk("ZZCC-ID", "ZZ CC Importd", jg="10", conf=None)  # below the grade: not asked
        I_E = mk("ZZCC-IE", "ZZ CC Importe", conf="2026-10-05")   # date unchanged (after the cut-off): not asked
        I_F = mk("ZZCC-IF", "ZZ CC Importf", conf=None)           # asked, answered add
        I_G = mk("ZZCC-IG", "ZZ CC Importg", conf=None, company=CO2)   # unit left out: not asked
        d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship) VALUES (?,?,?, 'peer')", (CID, I_A, RATER1))
        d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship) VALUES (?,?,?, 'peer')", (CID, I_A, RATER2))
        d.commit()
    recs = [row(employee_id="ZZCC-IA", employee_name="ZZ CC Importa", confirmation_date="2026-10-02", manager="ZZCC-R1"),
            row(employee_id="ZZCC-IB", employee_name="ZZ CC Importb", confirmation_date="2026-08-30", manager="ZZCC-R1"),
            row(employee_id="ZZCC-ID", employee_name="ZZ CC Importd", confirmation_date="2026-10-03", manager="ZZCC-R1", job_grade="10"),
            row(employee_id="ZZCC-IE", employee_name="ZZ CC Importe", confirmation_date="2026-10-05", manager="ZZCC-R1"),
            row(employee_id="ZZCC-IF", employee_name="ZZ CC Importf", confirmation_date="2026-10-04", manager="ZZCC-R1"),
            row(employee_id="ZZCC-IG", employee_name="ZZ CC Importg", confirmation_date="2026-10-06", manager="ZZCC-R1", company=CO2),
            row(employee_id="ZZCC-NEWJ", employee_name="ZZ CC Newjoiner", confirmation_date="2026-10-07", manager="ZZCC-R1"),
            row(employee_id="ZZCC-NEWK", employee_name="ZZ CC Newearly", confirmation_date="2026-08-25", manager="ZZCC-R1")]
    tok, grp = groups(recs)
    keys = sorted(it["key"] for g in grp for it in g["items"])
    s.check("the group is there for exactly: a changed date after the cut-off (existing, and a new joiner), in grade and unit",
            len(grp) == 1 and keys == ["cyc:ZZCC-IA", "cyc:ZZCC-IF", "cyc:ZZCC-NEWJ"], keys)
    g0 = grp[0] if grp else {}
    s.check("...titled with its count, the sub-line naming the cut-off, options Add them / Not this cycle, the three columns",
            g0.get("title") == "Confirmed after the cycle's cut-off (3)" and g0.get("sub") == "The file gives a confirmation date after 1 Sep 2026"
            and g0.get("options") == [("add", "Add them"), ("out", "Not this cycle")]
            and g0.get("head") == ["Person", "Confirmation date", "Already set up"], (g0.get("title"), g0.get("sub")))
    cells = {it["key"]: it["cells"] for it in g0.get("items", [])}
    s.check("...'Already set up' says what they hold: a panel of 2 for one, nothing for a new joiner",
            cells.get("cyc:ZZCC-IA", [0, 0, ""])[2] == "No KPI lines · 360 panel of 2"
            and cells.get("cyc:ZZCC-NEWJ", [0, 0, ""])[2] == "No KPI lines · no 360 panel"
            and cells.get("cyc:ZZCC-IA", [0, "", ""])[1] == "2 Oct 2026", cells.get("cyc:ZZCC-IA"))
    s.check("...with the board's 'why' words", "Back to the confirmation rule on Participants undoes either." in g0.get("why", ""))
    s.check("...which say Not this cycle leaves their Career Plan and the 360 they give (Chris, 2026-11-03), never 'no Career Plan'",
            "they keep their Career Plan, still rate colleagues on the 360" in g0.get("why", "") and "no Career Plan" not in g0.get("why", ""))
    s.check("the people not asked are absent from it", not any(k in keys for k in ("cyc:ZZCC-IB", "cyc:ZZCC-ID", "cyc:ZZCC-IE", "cyc:ZZCC-IG",
                                                                                   "cyc:ZZCC-NEWK")))
    pg3 = pg_imp(tok, "changes")
    s.check("the page shows it as one of the answers to give", "Confirmed after the cycle's cut-off (3)" in pg3 and
            "Your answers" in pg3 and 'value="out"' in pg3)
    # no cut-off: no group
    set_cut(None)
    _t, g_none = groups(recs)
    s.check("with no cut-off set there is no such group", g_none == [])
    set_cut(CUT)
    # answers are required
    r = sup.post(P_IMP, data={"csrf_token": "tok", "token": tok, "action": "to_apply", fid("cyc:ZZCC-IA"): "out"})
    s.check("answering only some stays on the step ('still to answer')", "step=apply" not in r.headers.get("Location", ""))
    r = sup.post(P_IMP, data={"csrf_token": "tok", "token": tok, "action": "to_apply", fid("cyc:ZZCC-IA"): "maybe"})
    s.check("a value that is neither option is not an answer", "step=apply" not in r.headers.get("Location", ""))
    r = sup.post(P_IMP, data={"csrf_token": "tok", "token": tok, "action": "to_apply", fid("cyc:ZZCC-IA"): "out",
                              fid("cyc:ZZCC-IF"): "add", fid("cyc:ZZCC-NEWJ"): "out"})
    s.check("all answered goes on to step 4", "step=apply" in r.headers.get("Location", ""), r.headers.get("Location"))
    pg4 = pg_imp(tok, "apply")
    s.check("step 4: the cycle's two tiles and each row's cycle outcome",
            "in " + CYC["name"] in pg4 and "not this cycle" in pg4
            and "Confirmation date · not in " + CYC["name"] + " (your answer)" in pg4
            and "Confirmation date · in " + CYC["name"] + " from 4 Oct 2026 (your answer)" in pg4
            and "Added · not in " + CYC["name"] + " (your answer)" in pg4
            and "Confirmation date · in " + CYC["name"] + " (on or before the cut-off)" in pg4, pg4[:0])
    s.check("the answers recap lists them", "<b>Not this cycle</b>: ZZ CC Importa (ZZCC-IA)" in pg4 and "<b>Add them</b>: ZZ CC Importf (ZZCC-IF)" in pg4)
    tiles_in = re.search(r"<b>(\d+)</b><span>in " + re.escape(CYC["name"]) + r"</span>", pg4)
    tiles_out = re.search(r"<b>(\d+)</b><span>not this cycle</span>", pg4)
    s.check("...tiles: in = the add answer + the two on-or-before rows (3), not this cycle = the out answers (2)",
            tiles_in and tiles_out and (tiles_in.group(1), tiles_out.group(1)) == ("3", "2"),
            (tiles_in and tiles_in.group(1), tiles_out and tiles_out.group(1)))
    # nothing written before apply
    s.check("nothing is written to the cycle by the preview", part_row(I_A) is None and choice_row(I_A) is None)
    ap = sup.post(P_IMP, data={"csrf_token": "tok", "token": tok, "action": "apply"}, follow_redirects=True)
    t = text(ap)
    ia, if_, nj = uid("ZZCC-IA"), uid("ZZCC-IF"), uid("ZZCC-NEWJ")
    s.check("apply: exactly the answered Take outs are written (IA and the new joiner), their choices recorded as the import's",
            part_row(ia) == "remove" and part_row(nj) == "remove" and part_row(if_) is None
            and choice_row(ia) == ("out", "2026-10-02", "import", SUP) and choice_row(nj)[0] == "out"
            and choice_row(if_) == ("add", "2026-10-04", "import", SUP), (part_row(ia), part_row(nj), part_row(if_)))
    s.check("...the person with a panel had it archived", live360(ia) == 0 and one(
        "SELECT COUNT(*) FROM assignments WHERE subject_id=? AND archive_reason=?", (ia, a.PARTICIPANT_OUT_REASON)) == 2)
    s.check("...nobody else was touched: not asked means no row and no choice",
            all(part_row(uid(e)) is None and choice_row(uid(e)) is None for e in ("ZZCC-IB", "ZZCC-ID", "ZZCC-IE", "ZZCC-IG", "ZZCC-NEWK")))
    s.check("...the dates went in", conf_of(ia) == "2026-10-02" and conf_of(uid("ZZCC-IB")) == "2026-08-30")
    s.check("the done page says what happened to the cycle", "Confirmed after" in t and "1 added to it, 2 left out" in t, t[:0])
    s.check("it is in the audit log, one row per person", one(
        "SELECT COUNT(*) FROM activity_log WHERE action='participant_confirm_choice' AND detail LIKE '%the roster import%'") == 3)
    # a stale check: an answer the file no longer asks is ignored; changed state refuses
    s.check("every template compiles", H.every_template_compiles(a))
finally:
    pass

sys.exit(s.done())
