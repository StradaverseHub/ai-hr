"""Every KPI a BU KPI Group People fills: nothing to key or submit, an optional note (Chris, 2026-10-26: "say their KPI is
a BU result Group People fills, an optional remark for the BG CEO, no submit, no reminder", "the cases could also be
BUCEO carries 3 BU KPIs, and it will apply the same method here", and "the line manager sees the note too, as well as
the leaders who calibrate them"; canvas [design canvas link removed]).

One rule, kpis_bu_only_ids: every KPI line of theirs this cycle is a BU KPI by the library's own rule (one line or
several). For them the KPI check-in has nothing to key or submit: review_state marks the part bu_only, the dashboard and
the check-in never say "Not required this round", no reminder, the welcome doesn't offer it, the remark is an optional
note shared as it saves (their line manager and calibrators read it at once), Save & submit is refused, the line
manager's Team view reads them as Group People's figures, and OneHR Agent is told the same. Someone with even one KPI
of their own keeps today's check-in. Everything here is synthetic (ZZBO-*) and is removed at the end.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Every KPI a BU KPI Group People fills -- nothing to key or submit, an optional note")

BG, CO, DEPT = "ZZBO Group", "ZZBO Unit", "ZZBO Office"
BU_KPIS = ("Profit after tax (PAT)", "Business unit gross profit (GP)", "Recognised revenue")
NOTE = "A one-off write-down in March held PAT back; the unit won two new distributors in the second half."


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZBO-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        tids = "SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph
        for sql in ("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (%s)" % tids,
                    "DELETE FROM pm_kpi_approvals WHERE kpi_target_id IN (%s)" % tids,
                    "DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id IN (%s)" % tids,
                    "DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph,
                    "DELETE FROM pm_overall_remarks WHERE subject_id IN (%s)" % ph,
                    "DELETE FROM pm_review_session WHERE subject_id IN (%s)" % ph,
                    "DELETE FROM pm_review_chat WHERE subject_id IN (%s)" % ph,
                    "DELETE FROM rating_records WHERE subject_id IN (%s)" % ph,
                    "DELETE FROM notifications WHERE user_id IN (%s)" % ph,
                    "DELETE FROM buceo_seats WHERE user_id IN (%s)" % ph):
            db.execute(sql, ids)
        db.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM ai_prerun_jobs WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    CYC = dict(a.active_cycle(db))
    CID = CYC["id"]
    _cleanup(db)
    _mods = [tuple(r) for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?", (CID,))]
    _wins = [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=?", (CID,))]
    _obd = db.execute("SELECT open_by_date FROM cycles WHERE id=?", (CID,)).fetchone()[0]
    for k, on in (("review", 1), ("pm", 1), ("tm", 1), ("idp", 0)):   # every condition this suite reads, set here
        db.execute("INSERT OR IGNORE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", (CID, k, on))
        db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (on, CID, k))
    _unified = db.execute("SELECT value FROM app_settings WHERE key='review_unified'").fetchone()
    db.execute("DELETE FROM app_settings WHERE key='review_unified'")   # the AI+ check-in on (its default)
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))   # every part open, no dates
    db.execute("UPDATE cycles SET open_by_date=0 WHERE id=?", (CID,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0 "
                           "AND job_grade GLOB '[0-9]*' LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(tag, name, mgr=None, jg="22"):
        eid = "ZZBO-" + tag
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=eid.lower() + "@zzbo.invalid",
                 hod_id=None, manager_id=mgr, buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG,
                 company=CO, department=DEPT, job_grade=jg, years_of_service=5, confirmation_date="2020-01-01",
                 left_at=None, is_demo=0, role="user", admin_bg=None)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    LM = mk("LM", "ZZ Bo Groupchief", jg="23")
    BUC = mk("BUC", "ZZ Bo Unitchief", LM)          # a BU CEO with three BU KPIs
    REP = mk("REP", "ZZ Bo Patonly", LM, jg="19")   # not a BU CEO, PAT only
    MIX = mk("MIX", "ZZ Bo Mixed", LM)              # PAT and a KPI of their own
    IDLE = mk("IDLE", "ZZ Bo Idle", LM)             # no KPI line, nothing else
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, BUC))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'A', NULL)", (BG,))
    for k in BU_KPIS:
        db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, "
                   "method, rate1, rate2, rate3, rate4, rate5, bu_level, active) VALUES (?, '*', '*', 0, '*', ?, 'more', "
                   "80, 90, 100, 110, 120, 1, 1)", (BG, k))
    TL = {}

    def line(sid, name, w):
        t = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, "
                       "rate3, rate4, rate5, business_group, company, department) VALUES (?,?,?,?,'more',80,90,100,"
                       "110,120,?,?,?)", (CID, sid, name, w, BG, CO, DEPT)).lastrowid
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (t, LM))
        TL[(sid, name)] = t
        return t
    for k, w in zip(BU_KPIS, (40, 30, 30)):
        line(BUC, k, w)
    line(REP, BU_KPIS[0], 100)
    line(MIX, BU_KPIS[0], 50)
    line(MIX, "ZZBO Customer satisfaction", 50)
    db.commit()
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]


def u(uid):
    return ctx(lambda d: d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def st(uid):
    return ctx(lambda d: a.review_state(d, d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()))


def acc(uid):
    return next((x for x in st(uid)["stages"] if x["key"] in ("account", "checkin")), {})


def panel(uid):
    def f(d):
        p = d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        return a.dash_review_panel(d, p, a.dash_review_summary(d, p))
    return ctx(f)


def here(uid):
    def f(d):
        p = d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        pn = a.dash_review_panel(d, p, a.dash_review_summary(d, p))
        return a.dash_here(pn, None, [])
    return ctx(f)


def items(uid):
    return ctx(lambda d: a.reminder_items(d, d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()))


def overview(uid):
    return ctx(lambda d: (a._review_kpi_overview(d, d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())
                          or {}).get("data") or {})


def remark_row(uid):
    return ctx(lambda d: d.execute("SELECT remark, draft FROM pm_overall_remarks WHERE cycle_id=? AND subject_id=?",
                                   (CID, uid)).fetchone())


def team_row(uid):
    rows = ctx(lambda d: a._journey_team_reports(d, d.execute("SELECT * FROM users WHERE id=?", (LM,)).fetchone(),
                                                 "pm_review"))
    return next((r for r in rows if r["id"] == uid), None)


def team_data(uid):
    return ctx(lambda d: a._journey_team_pm_data(d, d.execute("SELECT * FROM users WHERE id=?", (LM,)).fetchone(),
                                                 uid, "x"))


def entries(uid):
    return ctx(lambda d: a._pm_remark_entries(d, d.execute("SELECT * FROM users WHERE id=?", (SUP,)).fetchone(),
                                              uid, "bgceo"))


def hr_fill(uid, val):
    def f(d):
        for (sid, _n), t in TL.items():
            if sid == uid:
                d.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, admin_filled, "
                          "draft) VALUES (?,?,?,?,1,0)", (t, val, "Group People's fill", SUP))
        d.commit()
    ctx(f)


try:
    s.section("the rule: every KPI line a BU KPI Group People fills, one line or several")
    ids = ctx(lambda d: a.kpis_bu_only_ids(d, CID, [BUC, REP, MIX, IDLE, LM]))
    s.check("a BU CEO with three BU KPIs and someone with PAT alone are; PAT plus their own KPI, no KPI line, aren't",
            ids == {BUC, REP}, ids)
    s.check("the single-person form agrees", ctx(lambda d: a.kpis_bu_only(d, u(BUC), CID))
            and not ctx(lambda d: a.kpis_bu_only(d, u(MIX), CID)))
    s.check("review_state marks their KPI part bu_only, at 'later' with none of their own lines",
            acc(BUC).get("bu_only") is True and acc(BUC).get("state") == a.REVIEW_STATE_LATER
            and acc(BUC).get("n_total") == 0, {k: acc(BUC).get(k) for k in ("bu_only", "state", "n_total")})
    s.check("...not for someone with a KPI of their own", acc(MIX).get("bu_only") is False and acc(MIX).get("n_total") == 1)

    s.section("never 'Not required this round'; no reminder")
    s.check("with nothing else open they are not 'not required'", not ctx(lambda d: a._journey_not_required(st(BUC))))
    s.check("...someone with no KPI line and nothing else still is", ctx(lambda d: a._journey_not_required(st(IDLE))))
    pn = panel(BUC)
    s.check("the dashboard: 'Your KPIs are business unit results', the note for their BG CEO, no due date",
            pn["title"] == "Your KPIs are business unit results" and pn["button"] == "Add a note for your BG CEO"
            and "stage=account" in pn["url"] and pn["due"] == "" and not pn["not_required"], pn["title"])
    s.check("...the KPI part reads Group People's, done, never something to do",
            any(p.get("bu_only") and p["state"] == "done" and p["word"] == "Group People"
                for m in pn["modules"] for p in m["parts"]))
    h = here(BUC)
    s.check("...the note is never a thing that needs them (Ask OneHR reads the acts)",
            not h["acts"] and h["note_only"] and h["note_only"]["button"] == "Add a note for your BG CEO", h["acts"])
    s.check("someone not a BU CEO: the note is for their leaders",
            panel(REP)["button"] == "Add a note for your leaders")
    s.check("no reminder item for any of it", items(BUC) == [] and items(REP) == [], items(BUC))
    r = H.client_as(a, BUC).get("/dashboard")
    body = r.get_data(as_text=True)
    s.check("the dashboard page says so, never 'Not required this round'", r.status_code == 200
            and "Your KPIs are business unit results" in body and "Not required this round" not in body, r.status_code)
    # something else open: a 360 rating they owe
    ctx(lambda d: (d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship) VALUES "
                             "(?,?,?,'peer')", (CID, MIX, BUC)), d.commit()))
    pn = panel(BUC)
    s.check("with a 360 rating to give, the next step is the 360 and the KPI check-in is a quiet row with its note",
            pn["title"] != "Your KPIs are business unit results" and pn["bu_note"]
            and pn["bu_note"]["button"] == "Add a note (optional)", (pn["title"], pn["bu_note"]))
    s.check("...the reminder lists only the 360", [i["group"] for i in items(BUC)] == ["f360"], items(BUC))
    body = H.client_as(a, BUC).get("/dashboard").get_data(as_text=True)
    s.check("...and the page draws the row", "Group People fills your business unit KPIs" in body
            and "Add a note (optional)" in body)
    ctx(lambda d: (d.execute("DELETE FROM assignments WHERE cycle_id=? AND assessor_id=?", (CID, BUC)), d.commit()))

    s.section("the welcome and the left panel")
    starts = ctx(lambda d: a._journey_intro_starts(st(BUC)))
    s.check("the welcome never recommends the KPI check-in or puts it first: their card is the last pick, quietly",
            starts and starts[-1] == ("account", a._INTRO_BU_START) and not any("recommended" in c for _k, c in starts)
            and (len(starts) == 1 or starts[0][0] != "account"), starts)
    steps = ctx(lambda d: a._journey_intro_steps(d, u(BUC), st(BUC), "account"))
    s.check("...its last line says their KPIs are Group People's, and the note is on the KPI card",
            steps and "business unit results that Group People fills in" in steps[-1]["say"]
            and "note for your BG CEO" in steps[-1]["say"] and steps[-1]["quick_replies"][-1] == a._INTRO_BU_START
            and "I'd suggest your KPI check-in first" not in steps[-1]["say"], steps and steps[-1])
    s.check("...and holds their card until a pick, like every part's (it never plays on under the card)",
            steps and steps[-1].get("hold_card") is True, steps and steps[-1].get("hold_card"))
    _real_starts = a._journey_intro_starts
    a._journey_intro_starts = lambda st_: [("account", a._INTRO_BU_START)]
    steps0 = ctx(lambda d: a._journey_intro_steps(d, u(BUC), st(BUC), "account"))
    a._journey_intro_starts = _real_starts
    s.check("...with nothing else to start, it ends on their card's pick, no question about where to start",
            steps0 and steps0[-1]["quick_replies"] == [a._INTRO_BU_START, "I have a question"]
            and steps0[-1].get("hold_card") is True and "Would you like to start" not in steps0[-1]["say"]
            and "Where would you like to start" not in steps0[-1]["say"], steps0 and steps0[-1])
    s.check("the pick brings their card",
            ctx(lambda d: a._journey_intro_start_pick(d, u(BUC), CID, st(BUC), a._INTRO_BU_START, holding=True))
            == "account")

    def _reply(d):
        with a.app.test_request_context("/review/chat?stage=account"):
            return a._journey_intro_start_reply(a.get_db(), u(BUC), CID, st(BUC), "account").get_json()
    rp = ctx(_reply)
    s.check("...with its own line: nothing to key or submit, the note for their BG CEO",
            rp and rp.get("ok") and "nothing to key or submit" in rp.get("say", "")
            and "note for your BG CEO" in rp.get("say", "") and "Put each result" not in rp.get("say", ""),
            rp and rp.get("say"))
    s.check("...someone with their own KPI still starts on the KPI check-in, recommended",
            ctx(lambda d: a._journey_intro_starts(st(MIX)))[:1] == [("account", "KPI check-in (recommended)")])
    nav = ctx(lambda d: a._journey_nav_items(d, u(BUC), "account"))
    s.check("the left panel: their KPIs, then 'A note for your BG CEO' (optional), no Save & submit",
            [it["id"] for it in nav["items"]][-1] == "remark" and not any(it["id"] == "confirm" for it in nav["items"])
            and nav["items"][-1]["name"] == "A note for your BG CEO" and nav["items"][-1]["meta"] == "Optional",
            [(it["id"], it["meta"]) for it in nav["items"]])
    s.check("...its lines say Group People fills them", all(it["meta"] == "Group People fills it"
                                                            for it in nav["items"][:-1]))
    q = nav["queue"]
    s.check("...the queue names Group People and says there's nothing to key or submit",
            any(l_["label"] == "Filled by Group People" for l_ in q.get("lists") or [])
            and "Nothing for you to key or submit" in str(q.get("note")), q.get("note"))

    s.section("the KPI card: the note is optional, shared as it saves, never Save & submit")
    ov = overview(BUC)
    s.check("the card's data: bu_only, the note for their BG CEO", ov.get("bu_only") is True
            and ov.get("note_for") == "your BG CEO", {k: ov.get(k) for k in ("bu_only", "note_for")})
    s.check("...someone with their own KPI: not bu_only", overview(MIX).get("bu_only") is False)
    c = H.client_as(a, BUC)
    r = c.post("/review/kpi/remark", data={"csrf_token": "tok", "remark": NOTE, "stage": "account"})
    s.check("the note saves through the card's route", r.status_code == 200 and (r.get_json() or {}).get("ok"),
            r.status_code)
    rr = remark_row(BUC)
    s.check("...shared as it saves (draft 0): no submit step", rr and rr["draft"] == 0 and rr["remark"] == NOTE, rr
            and tuple(rr))
    s.check("the line manager reads it at once", team_data(BUC)["report_remark"] == NOTE)
    s.check("...and so do the leaders who calibrate them: 'Their note on the year'",
            any(e["who"] == "Their note on the year" and e["text"] == NOTE for e in entries(BUC)), entries(BUC))
    r = c.post("/review/confirm", data={"csrf_token": "tok"})
    s.check("Save & submit is refused: nothing to submit", r.status_code == 400
            and "nothing to submit" in ((r.get_json() or {}).get("error") or ""), r.get_data(as_text=True)[:120])
    s.check("...and nothing is locked", not ctx(lambda d: a.pm_review_locked(d, BUC, CID)))
    pc = ctx(lambda d: a._review_tool_prepare_confirm(d, u(BUC), CID, {}))
    s.check("the agent's prepare_confirm says the same", pc.get("ok") is False
            and "nothing to submit" in pc.get("error", ""), pc)
    r = c.post("/review/kpi/remark", data={"csrf_token": "tok", "remark": "", "stage": "account"})
    s.check("an emptied note clears it, for everyone", (r.get_json() or {}).get("ok")
            and team_data(BUC)["report_remark"] == "" and not entries(BUC))
    c.post("/review/kpi/remark", data={"csrf_token": "tok", "remark": NOTE, "stage": "account"})
    cm = H.client_as(a, MIX)
    cm.post("/review/kpi/remark", data={"csrf_token": "tok", "remark": "My own remark on my results.",
                                        "stage": "account"})
    s.check("someone with their own KPI: the remark stays a private draft until they submit",
            remark_row(MIX)["draft"] == 1 and team_data(MIX)["report_remark"] == "")
    pcm = ctx(lambda d: a._review_tool_prepare_confirm(d, u(MIX), CID, {}))
    s.check("...and their submit gate is today's (their own result still to key)",
            "still to key" in (pcm.get("error") or ""), pcm)

    s.section("the line manager's Team view")
    tr = team_row(BUC)
    s.check("before Group People's figures: done, 'Group People fills these', nothing for the manager",
            tr and tr["done"] and tr["meta"] == "Group People fills these" and not tr["action"], tr)
    s.check("...someone with their own KPI keeps today's line (not done, never Group People's)",
            not team_row(MIX)["done"] and "Group People" not in team_row(MIX)["meta"], team_row(MIX))
    s.check("no line manager is offered to assess them on their behalf",
            ctx(lambda d: a._pm_behalf_state(d, u(LM), BUC))[0] == [] and "business unit result" in
            ctx(lambda d: a._pm_behalf_state(d, u(LM), BUC))[1])
    s.check("their KPI data says bu_only (nothing to moderate)", team_data(BUC)["bu_only"] is True
            and team_data(MIX)["bu_only"] is False)
    s.check("...and its AI box says their KPIs are Group People's, not 'No KPI results submitted yet'",
            "business unit result Group People fills in" in (team_data(BUC).get("ai_summary") or "")
            and "submitted" not in (team_data(BUC).get("ai_summary") or ""), team_data(BUC).get("ai_summary"))
    hr_fill(BUC, 104)
    s.check("after the figures: 'Group People's figures'", team_row(BUC)["meta"] == "Group People's figures",
            team_row(BUC))
    ov = overview(BUC)
    s.check("their card's total now follows Group People's figures", ov.get("overall") is not None, ov.get("overall"))

    s.section("OneHR Agent and Help")
    sysp = ctx(lambda d: a._review_agent_system(d, u(BUC), st(BUC), journey=True))
    s.check("the agent is told there's nothing to key or submit, and the optional note",
            "NOTHING for them to key" in sysp and "OPTIONAL: a note for your BG CEO" in sysp
            and "STEP 1 -- RESULTS" not in sysp)
    s.check("...with their note and Group People's figures (104 on each, the total)", NOTE[:40] in sysp
            and "filled in at 104" in sysp and "total 3.0 of 5" in sysp, sysp[sysp.find("GROUP PEOPLE"):][:300])
    s.check("someone with their own KPI keeps the three steps", "STEP 1 -- RESULTS" in ctx(
        lambda d: a._review_agent_system(d, u(MIX), st(MIX), journey=True)))
    hp = ctx(lambda d: a.help_answers(d, u(BUC), "review_journey", "mine", "account"))
    keys = [i.get("key") for i in hp["items"]]
    s.check("Help in their KPI check-in answers 'Why is there nothing for me to key?' first",
            keys[:1] == ["kpi_bu"] and "kpi_wrong" not in keys and "kpi_file" not in keys, keys)
    s.check("the KB knows it", bool(ctx(lambda d: d.execute("SELECT 1 FROM kb_entries WHERE slug='business-unit-kpis'")
                                        .fetchone())))

    s.section("after the deadline")
    ctx(lambda d: (d.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES "
                             "(?, 'pm_results', '2020-01-01', '2020-01-02')", (CID,)), d.commit()))
    r = c.post("/review/kpi/remark", data={"csrf_token": "tok", "remark": "Changed after the close.",
                                           "stage": "account"})
    s.check("the note can't be changed once the KPI check-in has closed", r.status_code != 200
            or not (r.get_json() or {}).get("ok"), r.status_code)
    s.check("...it stays as it was", remark_row(BUC)["remark"] == NOTE)

    s.section("on their behalf: the line manager assesses only their own KPIs (Chris: \"line manager will skip BU KPI\")")
    # the KPI check-in is closed (above) and MIX never submitted: their line manager may assess them on their behalf
    T_PAT, T_OWN = TL[(MIX, BU_KPIS[0])], TL[(MIX, "ZZBO Customer satisfaction")]
    ctx(lambda d: (d.execute("DELETE FROM pm_overall_remarks WHERE subject_id=?", (MIX,)), d.commit()))
    lines_, why_ = ctx(lambda d: a._pm_behalf_state(d, u(LM), MIX))
    s.check("someone with PAT and their own KPI who didn't submit: the gate offers only their own KPI",
            [t_["id"] for t_ in lines_] == [T_OWN] and why_ is None, ([t_["id"] for t_ in lines_], why_))
    card = team_data(MIX).get("behalf") or {}
    s.check("...the card lists their own KPI to fill and PAT read only (Group People's)",
            card.get("ids") == [T_OWN] and card.get("bu_ids") == [T_PAT], {k: card.get(k) for k in ("ids", "bu_ids")})
    pv, err = ctx(lambda d: a._pm_behalf_draft(d, u(LM), MIX, T_PAT, "104"))
    s.check("...a figure for PAT is refused (not theirs to assess)", pv is None and err and err["reason"] == "not_actionable",
            err)
    pv, err = ctx(lambda d: a._pm_behalf_draft(d, u(LM), MIX, T_OWN, "100"))
    s.check("...their own KPI takes the line manager's figure", err is None and pv["missing"] == 0
            and [x["id"] for x in pv["lines"]] == [T_OWN] and [x["id"] for x in pv["bu"]] == [T_PAT], (err, pv))
    s.check("...the total waits for Group People's PAT (never a partial total)", pv["total"] is None and pv["bu_waiting"])
    ctx(lambda d: (d.execute("INSERT INTO pm_manager_remarks(cycle_id, subject_id, remark, submitted_by) VALUES "
                             "(?,?,?,?)", (CID, MIX, "Based on the customer survey results for the year.", LM)),
                   d.commit()))
    res, err = ctx(lambda d: a._pm_behalf_commit(d, u(LM), MIX))
    s.check("confirming on their behalf works without PAT", err is None, err)
    appr = ctx(lambda d: {r[0]: r[1] for r in d.execute("SELECT kpi_target_id, on_behalf FROM pm_kpi_approvals WHERE "
                                                         "kpi_target_id IN (?,?)", (T_PAT, T_OWN))})
    s.check("...their own KPI carries the line manager's figure on their behalf; PAT stays Group People's, untouched",
            appr.get(T_OWN) == 1 and T_PAT not in appr, appr)
    hr_fill(MIX, 104)
    pv2 = ctx(lambda d: a._pm_behalf_preview(d, u(LM), MIX))
    s.check("once Group People fills PAT, it reads on the card as their figure", any(
        x["id"] == T_PAT and x["value"] is not None for x in pv2["bu"]) or not pv2["bu"], pv2)

    lm_row = u(LM)
    with a.app.app_context():   # a background read: no request, no signed-in person (the pre-run, the CLI)
        summ_ok = a._journey_team_summary(a.get_db(), lm_row, "pm_review") is not None
    s.check("the Team summary still reads outside a request (the BU KPI names need no signed-in person)", summ_ok)

    s.section("the words")
    js = open(os.path.join(a.APP_DIR if hasattr(a, "APP_DIR") else os.path.dirname(a.__file__),
                           "static", "journey_chat.js")).read()
    s.check("the card says 'Group People fills this in', never 'Filled by HR'", "Group People fills this in" in js
            and "Filled by HR" not in js)
    s.check("the on-behalf card shows a BU KPI read only, never an input",
            "if (isBu) {   // a BU KPI: Group People's figure, never an input" in js
            and "Group People fills their business unit KPIs; you key in only their own." in js)
    s.check("its note has one Save note and the optional note's words", '"Save note"' in js
            and "data.bu_only" in js and "A note for " in js)
finally:
    def restore(d):
        _cleanup(d)
        d.execute("DELETE FROM cycle_modules WHERE cycle_id=?", (CID,))
        for k, v in _mods:
            d.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", (CID, k, v))
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        for w in _wins:
            d.execute("INSERT INTO cycle_windows(%s) VALUES (%s)" % (",".join(w), ",".join("?" * len(w))),
                      list(w.values()))
        d.execute("UPDATE cycles SET open_by_date=? WHERE id=?", (_obd, CID))
        if _unified:
            d.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('review_unified', ?)", (_unified[0],))
        d.commit()
    ctx(restore)

sys.exit(s.done())
