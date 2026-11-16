"""Add to this cycle with a Confirmation rating (Chris, 2026-10-22; canvas
[design canvas link removed]).

"for super admin to add in new person into the cycle pool, there should be an option during the add process flow, to
assign KPI (default to their confirmation rating as their KPI line) and option to set the rating on behalf"; "every BG
will follow 5 rating"; "we can just add a tag with 'newly confirmed'".

Participants' confirm_add (super admin only) adds each person with ONE KPI line, the Confirmation rating, 100%, rated
on their behalf on the 5-point rating whatever their group's mechanism (rating_line), as an HR-filled result with their
check-in signed off, and marks the add as via='confirmation' for the Newly confirmed tag. All or nothing. Everything here
is synthetic (ZZCF-*) and removed at the end.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Confirmation rating -- add to this cycle, rated on their behalf, tagged Newly confirmed")
# This fixture makes the BU CEO the HOD of people inside their own unit. Since 2026-10-30 a calibrator holds no HOD role at
# all (_hod_review_holders; tests/test_ceo_hod.py holds that rule), so this suite switches the rule off (nobody is a
# calibrator for it) to keep exercising the Department Review itself.
a._hod_review_holders = lambda db: set()
SU, BGA, _E = H.actors(a)
GA, GB = "ZZCF Agroup", "ZZCF Bgroup"


def q1(sql, args=()):
    with a.app.app_context():
        return a.get_db().execute(sql, args).fetchone()


def cleanup(db):
    db.execute("DELETE FROM buceo_seats WHERE business_group IN (?,?)", (GA, GB))
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZCF-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        # what this suite gave a role for a check carries updated_by = its own manager (ZZCF-LM), and only that goes
        db.execute("DELETE FROM admin_role_access WHERE updated_by IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM rating_records WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM pm_review_session WHERE subject_id IN (%s)" % ph, ids)
        tids = [r[0] for r in db.execute("SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)]
        if tids:
            tph = ",".join("?" * len(tids))
            for t in ("pm_kpi_results", "pm_kpi_approvals", "pm_kpi_chain"):
                try:
                    db.execute("DELETE FROM %s WHERE kpi_target_id IN (%s)" % (t, tph), tids)
                except Exception:
                    pass
            db.execute("DELETE FROM pm_kpi_targets WHERE id IN (%s)" % tph, tids)
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM pm_rating_bands WHERE business_group IN (?,?)", (GA, GB))
    db.execute("DELETE FROM pm_bg_config WHERE business_group IN (?,?)", (GA, GB))
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    cleanup(db)
    CYC = dict(a.active_cycle(db))
    CID = CYC["id"]
    MG0, H0 = CYC.get("min_job_grade"), CYC.get("half")
    db.execute("UPDATE cycles SET min_job_grade=NULL WHERE id=?", (CID,))
    # a 5-point group and an achievement-% group, each with its own scoring
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'A', NULL)", (GA,))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'B', 'base')", (GB,))
    for i, (lo, lab) in enumerate(((0, "UA"), (61, "BE"), (81, "ME"), (101, "AE"), (121, "OU"))):
        db.execute("INSERT INTO pm_rating_bands(business_group, min_value, max_value, label, sort_order) VALUES "
                   "(?,?,NULL,?,?)", (GB, lo, lab, i + 1))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, name, bg, mgr=None):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=mgr,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=bg, company=bg + " Unit",
                 department="ZZCF Dept", job_grade="13", confirmation_date=None, years_of_service=0.4, left_at=None,
                 is_demo=0, role="user")
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
    LM = mk("ZZCF-LM", "ZZ CF Manager", GA)
    PA = mk("ZZCF-A", "ZZ CF Alpha", GA, LM)     # the 5-point group
    PB = mk("ZZCF-B", "ZZ CF Bravo", GB, LM)     # the achievement-% group: still rated on the 5-point rating
    PC = mk("ZZCF-C", "ZZ CF Charlie", GA, LM)   # already holds a KPI line
    PD = mk("ZZCF-D", "ZZ CF Delta", GA)         # no line manager
    PE = mk("ZZCF-E", "ZZ CF Echo", GA, LM)      # Add a person's KPI step: left out by the rule
    PF = mk("ZZCF-F", "ZZ CF Foxtrot", GA, LM)   # ...taking part by the rule: no Confirmation rating for them
    db.execute("UPDATE users SET confirmation_date='2020-01-01', years_of_service=6 WHERE id=?", (PF,))
    PG = mk("ZZCF-G", "ZZ CF Golf", BGA["admin_bg"], None) if BGA and BGA["admin_bg"] else None   # in a BG admin's group
    db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, rate4, "
               "rate5, business_group) VALUES (?,?,?,100,'more',1,2,3,4,5,?)", (CID, PC, "ZZCF existing line", GA))
    db.commit()

S = H.client_as(a, SU["id"])


def post(client, ids, ratings, reason="Confirmation rating from their probation review."):
    data = {"csrf_token": "tok", "action": "confirm_add", "ids": [str(i) for i in ids], "reason": reason}
    data.update({"rating_%d" % i: str(r) for i, r in ratings.items()})
    return client.post("/admin/participants", data=data, follow_redirects=True)


def counts():
    return q1("SELECT (SELECT COUNT(*) FROM cycle_participants WHERE subject_id IN (?,?,?,?)), "
              "(SELECT COUNT(*) FROM pm_kpi_targets WHERE subject_id IN (?,?,?,?) AND kpi_name='Confirmation rating')",
              (PA, PB, PC, PD) * 2)[:]


try:
    s.section("refused, nothing written")
    if BGA:
        r = H.client_as(a, BGA["id"]).post("/admin/participants", data={
            "csrf_token": "tok", "action": "confirm_add", "ids": [str(PA)], "rating_%d" % PA: "3", "reason": "x"})
        s.check("a BG admin can't (no role has the right until the super admin ticks it)", r.status_code in (403, 404), r.status_code)
    base_counts = counts()
    r = post(S, [PA, PB], {PA: 3, PB: 4}, reason="")
    s.check("no reason: refused, nothing written", counts() == base_counts
            and "reason" in r.get_data(as_text=True).lower(), counts())
    r = post(S, [PA, PB], {PA: 3, PB: 6})
    s.check("a rating outside 1 to 5: refused, nothing written",
            counts() == base_counts and "5-point rating" in r.get_data(as_text=True), counts())
    r = post(S, [PA, PC], {PA: 3, PC: 3})
    s.check("someone who already holds KPI lines: the whole batch refused (all or nothing)",
            counts() == base_counts and "already holds KPI lines" in r.get_data(as_text=True).replace("&#39;", "'"),
            counts())

    s.section("added, rated on their behalf")
    r = post(S, [PA, PB, PD], {PA: 3, PB: 4, PD: 2})
    body = r.get_data(as_text=True)
    s.check("the super admin adds three, said back", r.status_code == 200 and "3 people added to" in body, body[-400:])
    cp = {x[0]: (x[1], x[2]) for x in H.rows(a, "SELECT subject_id, mode, via FROM cycle_participants WHERE cycle_id=? "
                                                 "AND subject_id IN (?,?,?)", (CID, PA, PB, PD))}
    s.check("each added to the cycle, via the Confirmation rating", cp == {PA: ("add", "confirmation"),
                                                                         PB: ("add", "confirmation"),
                                                                         PD: ("add", "confirmation")}, cp)
    lines = {x["subject_id"]: dict(x) for x in H.rows(
        a, "SELECT * FROM pm_kpi_targets WHERE cycle_id=? AND subject_id IN (?,?,?)", (CID, PA, PB, PD))}
    s.check("one line each: Confirmation rating, 100%, a rating line on 1 to 5, higher is better",
            set(lines) == {PA, PB, PD} and all(
                (t["kpi_name"], t["weightage"], t["rating_line"], t["method"],
                 (t["rate1"], t["rate2"], t["rate3"], t["rate4"], t["rate5"]), t["status"])
                == ("Confirmation rating", 100.0, 1, "more", (1.0, 2.0, 3.0, 4.0, 5.0), "approved")
                for t in lines.values()), {k: (v["kpi_name"], v["rating_line"]) for k, v in lines.items()})
    res = {x[0]: tuple(x[1:]) for x in H.rows(
        a, "SELECT t.subject_id, r.actual_value, r.admin_filled, r.draft, r.note FROM pm_kpi_results r JOIN "
           "pm_kpi_targets t ON t.id=r.kpi_target_id WHERE t.subject_id IN (?,?,?)", (PA, PB, PD))}
    s.check("rated on their behalf as an HR-filled result, the reason with it",
            res.get(PA)[:3] == (3.0, 1, 0) and res.get(PB)[:3] == (4.0, 1, 0) and res.get(PD)[:3] == (2.0, 1, 0)
            and all("probation review" in (v[3] or "") for v in res.values()), res)
    with a.app.test_request_context("/"):
        d = a.get_db()
        locked = {p: a.pm_review_locked(d, p, CID) for p in (PA, PB, PD)}
        part = {p: a.participation(d, d.execute("SELECT * FROM users WHERE id=?", (p,)).fetchone())[0]
                for p in (PA, PB, PD)}
        ov = a.pm_final_overalls(d, CID, [PA, PB, PD])
        newly = a.newly_confirmed_ids(d, CID)
    s.check("nothing for them to fill in: their check-in is signed off", all(locked.values()), locked)
    s.check("they take part in the cycle", all(part.values()), part)
    s.check("their final rating is the one given: ME, AE, BE",
            {p: (ov[p] or {}).get("label") for p in (PA, PB, PD)} == {PA: "ME", PB: "AE", PD: "BE"}, ov)
    s.check("the achievement-% group's person is rated on the 5-point rating too (every BG follows 5 rating)",
            (ov[PB] or {}).get("mechanism") == "A" and abs((ov[PB] or {}).get("value", 0) - 4.0) < 1e-9, ov[PB])
    s.check("the tag's reader names all three", {PA, PB, PD} <= newly and PC not in newly, newly)
    s.check("someone with no line manager still gets theirs (an HR-filled line needs no moderator)", lines.get(PD)
            and (ov[PD] or {}).get("label") == "BE")
    logs = H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='participant_confirmation' AND target_user_id IN "
                    "(?,?,?) AND detail LIKE '%probation review%'", (PA, PB, PD))
    s.check("one audit row each, with the rating and the reason", logs == 3, logs)
    s.check("their rating records are written", H.one(a, "SELECT COUNT(*) FROM rating_records WHERE cycle_id=? AND "
                                                          "subject_id IN (?,?,?)", (CID, PA, PB, PD)) == 3)
    r = post(S, [PA], {PA: 5})
    s.check("adding someone again is refused: they hold their Confirmation rating already",
            "already holds KPI lines" in r.get_data(as_text=True).replace("&#39;", "'")
            and H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE subject_id=?", (PA,)) == 1)

    s.section("the leaders' rows: the HOD's Department Review and the BU CEO's calibration, both axes")
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))   # calibration is Year-End only
        d.execute("UPDATE users SET hod_id=? WHERE id IN (?,?)", (LM, PA, PC))
        a._participant_set(d, SU, CYC, PC, "add")   # PC takes part the ordinary way, on their own line: no tag
        d.execute("INSERT INTO buceo_seats(business_group, company, user_id, assigned_at) VALUES (?,?,?,datetime('now'))",
                  (GA, GA + " Unit", LM))
        d.commit()
        lm = dict(d.execute("SELECT * FROM users WHERE id=?", (LM,)).fetchone())
        hctx = a._pm_calib_resolve(d, lm, "hod", hod_id=LM)
        hpm = {r["id"]: r for r in a._pm_calib_assist_overview(d, lm, hctx, "hod", {"hod_id": LM})["data"]["rows"]}
        hpot = {r["id"]: r for r in a._pot_calib_overview(d, lm, a._pot_calib_sc(d, CID, "hod", LM,
                                                                                  hctx["population"]))["rows"]}
        bkw = {"bg": GA, "company": GA + " Unit"}
        bctx = a._pm_calib_resolve(d, lm, "buceo", **bkw)
        bpm = {r["id"]: r for r in a._pm_calib_assist_overview(d, lm, bctx, "buceo", bkw)["data"]["rows"]}
        bpot = {r["id"]: r for r in a._pot_calib_overview(d, lm, a._pot_calib_sc(d, CID, "buceo", (GA, GA + " Unit"),
                                                                                  bctx["population"]))["rows"]}
    for label, rows in (("HOD, performance", hpm), ("HOD, potential", hpot), ("BU CEO, performance", bpm),
                        ("BU CEO, potential", bpot)):
        s.check("%s: the added person is tagged, the one on their own line is not" % label,
                PA in rows and PC in rows and rows[PA].get("newly") is True and rows[PC].get("newly") is False,
                {k: v.get("newly") for k, v in rows.items()})
    s.check("...and the HOD reviews the rating given: ME comes up to them",
            "ME" in (hpm.get(PA, {}).get("incoming_band"), hpm.get(PA, {}).get("current_band")), hpm.get(PA))

    s.section("Add a person: the Confirmation rating as their KPI (Chris, 2026-10-22)")
    pe_page = S.get("/admin/users?view=add&step=kpis&uid=%d" % PE).get_data(as_text=True)
    s.check("their KPI step offers it beside adding them and Not this cycle, with its own button",
            'name="cycle" value="confirm"' in pe_page and "Add them with a Confirmation rating" in pe_page
            and 'name="cycle" value="add"' in pe_page and 'id="wiz-conf-go"' in pe_page and 'name="rating"' in pe_page)
    pf_page = S.get("/admin/users?view=add&step=kpis&uid=%d" % PF).get_data(as_text=True)
    s.check("...never to someone taking part by the confirmation rule (their KPIs come from the library)",
            'value="confirm"' not in pf_page and 'id="wiz-lines"' in pf_page)

    def add_post(uid, **f):
        data = {"csrf_token": "tok", "action": "confirm", "cycle": "confirm", "then": "save"}
        data.update(f)
        return S.post("/admin/people/add/%d" % uid, data=data)

    def conf_lines(uid):
        return H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (CID, uid))
    r = add_post(PE, rating="4", reason="")
    s.check("no reason: refused, back on their KPIs, nothing written",
            conf_lines(PE) == 0 and "step=kpis" in (r.headers.get("Location") or ""), r.headers.get("Location"))
    r = add_post(PE, rating="0", reason="Confirmed on 1 December.")
    s.check("a rating outside 1 to 5: refused", conf_lines(PE) == 0)
    r = add_post(PF, rating="4", reason="Confirmed on 1 December.")
    s.check("someone taking part by the rule: refused", conf_lines(PF) == 0)
    r = add_post(PE, rating="4", reason="Confirmed on 1 December; rated from their probation review.")
    s.check("added and rated: on to their job", "step=job" in (r.headers.get("Location") or ""), r.headers.get("Location"))
    _next = S.get(r.headers.get("Location") or "/admin/users").get_data(as_text=True)
    s.check("...and the job step says so", "with the Confirmation rating, rated on their behalf" in _next,
            re.findall(r'class="flash[^"]*"[^>]*>([^<]{0,160})', _next))
    pe = {k: H.one(a, q, (CID, PE)) for k, q in (
        ("line", "SELECT kpi_name || '|' || rating_line || '|' || weightage FROM pm_kpi_targets WHERE cycle_id=? AND "
                 "subject_id=?"),
        ("result", "SELECT r.actual_value || '|' || r.admin_filled FROM pm_kpi_results r JOIN pm_kpi_targets t ON "
                   "t.id=r.kpi_target_id WHERE t.cycle_id=? AND t.subject_id=?"),
        ("via", "SELECT mode || '|' || via FROM cycle_participants WHERE cycle_id=? AND subject_id=?"))}
    with a.app.test_request_context("/"):
        pe_locked = a.pm_review_locked(a.get_db(), PE, CID)
    s.check("...Participants' own writer: one Confirmation rating line at 100%, 4 HR-filled, via the confirmation, their "
            "check-in signed off", pe == {"line": "Confirmation rating|1|100.0", "result": "4.0|1",
                                          "via": "add|confirmation"} and pe_locked, (pe, pe_locked))

    s.section("the right: cycle.confirm on Roles & access, no role's until the super admin ticks it")
    s.check("an item of the Cycle module", (a.ADMIN_ITEM_BY_KEY.get("cycle.confirm") or ("",))[0] == "cycle")
    s.check("...ticked for no role", H.one(a, "SELECT COUNT(*) FROM admin_role_access WHERE item='cycle.confirm'") == 0)
    s.check("both doors name it in the access map",
            a.ADMIN_ACCESS_MAP["admin_participants"]["map"].get("confirm_add") == ("items", ("cycle.confirm",))
            and a.ADMIN_ACCESS_MAP["admin_add_steps"]["map"].get("confirm") == ("items", ("cycle.confirm",)))
    if PG:
        B = H.client_as(a, BGA["id"])
        rid = H.one(a, "SELECT admin_role_id FROM users WHERE id=?", (BGA["id"],))

        def grant(item):
            with a.app.app_context():
                d = a.get_db()
                d.execute("INSERT INTO admin_role_access(role_id, item, updated_by) VALUES (?,?,?)", (rid, item, LM))
                d.commit()
        for it in ("people.read", "people.add", "pm.kpi_add", "cycle.read", "cycle.participants"):
            if not H.one(a, "SELECT COUNT(*) FROM admin_role_access WHERE role_id=? AND item=?", (rid, it)):
                grant(it)
        bp = B.get("/admin/users?view=add&step=kpis&uid=%d" % PG).get_data(as_text=True)
        s.check("a BG admin who can add a person: their KPI step without it", 'name="cycle" value="add"' in bp
                and 'value="confirm"' not in bp, 'name="cycle" value="add"' in bp)
        r = B.post("/admin/people/add/%d" % PG, data={"csrf_token": "tok", "action": "confirm", "cycle": "confirm",
                                                      "then": "save", "rating": "3", "reason": "Confirmed on 1 Dec."})
        s.check("...and posting it is refused", r.status_code == 403 and conf_lines(PG) == 0, r.status_code)
        s.check("...as is Participants' panel", 'id="ptc-form"' not in B.get("/admin/participants").get_data(as_text=True))
        grant("cycle.confirm")
        bp = B.get("/admin/users?view=add&step=kpis&uid=%d" % PG).get_data(as_text=True)
        s.check("their role ticked cycle.confirm: the KPI step offers it", 'name="cycle" value="confirm"' in bp)
        s.check("...and Participants' panel shows", 'id="ptc-form"' in B.get("/admin/participants").get_data(as_text=True))
        r = B.post("/admin/participants", data={"csrf_token": "tok", "action": "confirm_add", "ids": [str(PE)],
                                                "rating_%d" % PE: "3", "reason": "Confirmed on 1 Dec."})
        s.check("...for their own scope only: someone in another group is refused", r.status_code == 403, r.status_code)
        r = B.post("/admin/people/add/%d" % PG, data={"csrf_token": "tok", "action": "confirm", "cycle": "confirm",
                                                      "then": "save", "rating": "3", "reason": "Confirmed on 1 Dec."})
        s.check("...and in their group it goes through", conf_lines(PG) == 1
                and "step=job" in (r.headers.get("Location") or ""), r.headers.get("Location"))
        with a.app.app_context():
            d = a.get_db()
            d.execute("DELETE FROM admin_role_access WHERE updated_by=?", (LM,))
            d.commit()

    s.section("the scorer: a rating line is the 5-point rating; every other line keeps its group's mechanism")
    with a.app.test_request_context("/"):
        d = a.get_db()
        cfg_b = d.execute("SELECT * FROM pm_bg_config WHERE business_group=?", (GB,)).fetchone()
        rl = dict(d.execute("SELECT * FROM pm_kpi_targets WHERE subject_id=?", (PB,)).fetchone())
        plain = dict(rl, rating_line=0, threshold=60.0, target=100.0, multiple=0)
        s_rl = a.pm_score_kpi_line(cfg_b, rl, 4.0)
        s_plain = a.pm_score_kpi_line(cfg_b, plain, 95.0)
        s_none = a.pm_score_kpi_line(None, rl, 3.0)
    s.check("a rating line in an achievement-% group scores on 1 to 5", s_rl == {"mechanism": "A", "value": 4.0}, s_rl)
    s.check("...with no group scoring set at all", s_none == {"mechanism": "A", "value": 3.0}, s_none)
    s.check("a plain line in the same group keeps achievement against target", s_plain and s_plain["mechanism"] == "B",
            s_plain)

    s.section("the page and the views")
    page = S.get("/admin/participants?show=all").get_data(as_text=True)
    s.check("the super admin's Participants carries the three-step panel", 'id="ptc-form"' in page
            and 'value="confirm_add"' in page and "Confirmation rating" in page and 'data-confirm' in page
            and "Rate on their behalf" in page)
    s.check("...and the list says how they joined", "Confirmation rating" in page.split('id="participants-table"')[1])
    if BGA:
        bpage = H.client_as(a, BGA["id"]).get("/admin/participants").get_data(as_text=True)
        s.check("a BG admin's page has no such panel", 'id="ptc-form"' not in bpage)
    src = H.source(a)
    s.check("every view's rows carry the flag: performance and potential calibration, the Talent Box (both)",
            src.count('"newly": r["user"]["id"] in newly') == 3
            and '"newly": subj["id"] in newly_confirmed_ids(db, ctx["period"]["id"])' in src)
    js = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "journey_chat.js"),
              encoding="utf-8").read()
    s.check("the views draw it: the calibration tables' second line, the Talent Box list beside the name, its panel "
            "rows on the second line", "function newlyTag()" in js and '"Newly confirmed"' in js
            and "var newTag = !!r.newly;" in js and "if (p.newly && !tagBelow) ln.appendChild(newlyTag());" in js
            and "if (p.newly) sub.appendChild(newlyTag());" in js)
    css = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "style.css"),
               encoding="utf-8").read()
    s.check("the tag is never squeezed", re.search(r"\.rv-newconf \{[^}]*flex: 0 0 auto", css) is not None)
    s.check("Help's quick answers say what the tag means in the HOD's, BU CEO's and BG CEO's views",
            all("newly" in a.HELP_LISTS[k][1] for k in ("dept_perf", "dept_pot", "bu_pot", "bg", "group"))
            and "Confirmation rating" in a.HELP_QA["newly"][1]
            and not re.search(r"reopen", " ".join(a.HELP_QA["newly"]), re.I))
    s.check("...and the KB explains it to the agents",
            H.one(a, "SELECT COUNT(*) FROM kb_entries WHERE slug='newly-confirmed' AND active=1 "
                     "AND body LIKE '%Confirmation rating%'") == 1)
finally:
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE cycles SET min_job_grade=?, half=? WHERE id=?", (MG0, H0, CID))
        cleanup(d)
sys.exit(s.done())
