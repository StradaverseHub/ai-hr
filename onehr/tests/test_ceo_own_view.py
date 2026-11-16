"""A BU / BG CEO's card switches to their own results (Chris, 2026-10-26: "we can do a toggle like the reviews and
learning on the where your BU is card, so we have toggle of BU view and Own view, own view will open the personal
card"; canvas [design canvas link removed], "i am ok with the design for no-LMS view").

What this suite holds:
  * a BU CEO's Where your BU is carries BU | Own, opening on BU: the BU pane shows, the Own pane is hidden, and the Own
    pane holds every row Where you stand gives them (the dashboard's own standing list, by label), with Details
    opening this cycle's record; the title and the line under it follow the switch
  * only a BU CEO taking part in this cycle gets the switch: never the BG CEO's card (no Mine for a BG CEO, 2026-10-05;
    Chris, 2026-10-26: "take Own off the BGCEO card") nor a Group Chief's (2026-10-14: test_group_dashboard holds it)
  * once a result is released to the person, Where you stand (and so Own) shows the final band, never the line
    manager's score or band (Chris, 2026-10-26: "once a result is released to the person, Where you stand drops the
    line manager's band and shows the final bands")
  * an employee's Where you stand is unchanged: no switch, the same rows
  * Ask OneHR: "where are my own results?" is answered in code, the card marked "own" for a CEO (which switches it) and
    "stand" for anyone else; a results question points a CEO to Own; ASK_MARKS knows "own"
  * Help: a CEO's dashboard answers carry "Where are my own results this cycle?"; an employee's don't
  * the KB row and the first sign-in tour's line

Self-contained: its own ZZOV people in their own business group, removed at the end (try/finally).
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A CEO's card: BU | Own, their own results this cycle")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

BG, CO = "ZZ Own View BG", "ZZ Own View Co"
ids = {}
made = {}


def mk(db, key, **extra):
    cols = ["username", "full_name", "password_hash", "role", "employee_id", "business_group", "company", "department",
            "job_title", "job_grade", "confirmation_date"]
    vals = ["ZZOV-" + key, "ZZ Own " + key, "x", "user", "ZZOV-" + key, BG, CO, "ZZ Own Dept", "Planner", "14",
            "2020-01-01"]
    for k, v in extra.items():
        cols.append(k)
        vals.append(v)
    return db.execute("INSERT INTO users (%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), vals).lastrowid


def page(uid):
    h = H.client_as(a, uid).get("/dashboard").get_data(as_text=True)
    return h[h.find('class="od"'):h.find('data-od-scrim')] if 'class="od"' in h else h


def section_of(h, cls):
    i = h.find('<section class="od-card %s' % cls)
    return h[i:h.find("</section>", i)] if i >= 0 else ""


def pane(card, pid):
    i = card.find('id="%s"' % pid)
    if i < 0:
        return ""
    j = card.rfind("<div", 0, i)
    nxt = card.find('class="od-own-pane"', i)
    return card[j:nxt if nxt > 0 else len(card)]


def dts(html):
    return [re.sub(r"<[^>]+>", "", x).strip() for x in re.findall(r"<dt>(.*?)</dt>", html, re.S)]


def ctx_of(uid):
    rc = a.app.test_request_context("/dashboard")
    rc.push()
    from flask import session as _ss
    _ss["user_id"] = uid
    db_ = a.get_db()
    u_ = dict(db_.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())
    return rc, db_, u_


try:
    with a.app.app_context():
        db = a.get_db()
        # the dashboard runs its cycle view only with the cycle's review on: switch it on, and put back what was there
        made["cid"] = a.active_cycle_id(db)
        _r = db.execute("SELECT active FROM cycle_modules WHERE cycle_id=? AND module_key='review'",
                        (made["cid"],)).fetchone()
        made["review"] = _r[0] if _r else None
        db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'review', 1) "
                   "ON CONFLICT(cycle_id, module_key) DO UPDATE SET active=1", (made["cid"],))
        ids["bgceo"] = mk(db, "bgceo", bgceo_bg=BG, job_grade="23", department="ZZ Own Mgmt")
        ids["buceo"] = mk(db, "buceo", job_grade="21", department="ZZ Own Mgmt")
        ids["emp"] = mk(db, "emp")
        ids["emp2"] = mk(db, "emp2", department="ZZ Own Ops")
        db.execute("UPDATE users SET manager_id=? WHERE id=?", (ids["bgceo"], ids["buceo"]))
        db.execute("UPDATE users SET manager_id=? WHERE id IN (?,?)", (ids["buceo"], ids["emp"], ids["emp2"]))
        db.execute("DELETE FROM buceo_seats WHERE business_group=? AND company=?", (BG, CO))
        db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, ids["buceo"]))
        db.commit()

    # ---------------------------------------------------------------------------
    s.section("a BU CEO: Where your BU is, BU | Own")
    rc, db, u = ctx_of(ids["buceo"])
    try:
        ctx = a._dash_context(db, u)
    finally:
        rc.pop()
    h = page(ids["buceo"])
    card = section_of(h, "od-bu")
    s.check("the dashboard runs its cycle view for them, with the BU card and their standing rows",
            ctx.get("mode") == "running" and ctx.get("bu_status") and ctx.get("standing") and card,
            (ctx.get("mode"), bool(ctx.get("bu_status")), len(ctx.get("standing") or [])))
    s.check("the switch: BU on and selected, Own off", 'data-lt-tab="bu"' in card and 'data-lt-tab="own"' in card
            and re.search(r'class="od-lt-tab is-on"[^>]*aria-selected="true" data-lt-tab="bu">BU<', card)
            and re.search(r'aria-selected="false" data-lt-tab="own">Own<', card))
    p_bu, p_own = pane(card, "od-own-p-bu"), pane(card, "od-own-p-own")
    s.check("the BU pane shows (not hidden) and holds the axes; the Own pane is hidden",
            p_bu and "hidden" not in p_bu[:p_bu.find(">")] and "od-bu-axes" in p_bu
            and p_own and p_own[:p_own.find(">")].rstrip().endswith("hidden"), (p_bu[:200], p_own[:200]))
    want = [r["label"].replace(" rating", "") for r in ctx["standing"]]
    s.check("Own holds every row Where you stand gives them, in its order", dts(p_own) == want and want,
            (dts(p_own), want))
    s.check("...with Details opening this cycle's record", 'data-record="current"' in p_own)
    s.check("...and no BU rows in it (no axes, no department table)", "od-bu-axes" not in p_own
            and "od-bu-tbl" not in p_own)
    s.check("the title and the line under it follow the switch: BU's showing, Own's hidden",
            re.search(r'<span data-lt-for="bu">Where your BU is</span><span data-lt-for="own" hidden>Where you stand'
                      r'</span>', card)
            and re.search(r'data-lt-for="own" hidden>Your own review this cycle, up to your line manager<', card))
    _part = a.participation
    a.participation = lambda *x, **k: (False, "removed")   # a BU CEO taken out of this cycle's review
    rc, db, u2 = ctx_of(ids["buceo"])
    try:
        ctx_out = a._dash_context(db, u2)
        html_out = a.render_template("dashboard.html", **dict(ctx_out, ask={"available": False, "suggestions": [],
                                                                            "first_name": "", "cycle": None}))
    finally:
        a.participation = _part
        rc.pop()
    s.check("a BU CEO not taking part in this cycle: the card as before, no switch (nothing of theirs to show)",
            ctx_out.get("bu_status") and not ctx_out.get("own_view") and "Where your BU is" in html_out
            and 'data-lt-tab="own"' not in html_out, (bool(ctx_out.get("bu_status")), ctx_out.get("own_view")))

    # ---------------------------------------------------------------------------
    s.section("a BG CEO: Where the group is, no switch (no review of their own; Chris: \"take Own off the BGCEO card\")")
    rc, db, ub = ctx_of(ids["bgceo"])
    try:
        ctxb = a._dash_context(db, ub)
    finally:
        rc.pop()
    hb = page(ids["bgceo"])
    cardb = section_of(hb, "od-bu od-bg")
    s.check("their card as before: Where the group is, no Group | Own, no Own pane",
            ctxb.get("bg_status") and cardb and "Where the group is" in cardb and not ctxb.get("own_view")
            and 'data-lt-tab="own"' not in cardb and "od-own-p-own" not in cardb,
            (bool(ctxb.get("bg_status")), ctxb.get("own_view")))

    # ---------------------------------------------------------------------------
    s.section("an employee: Where you stand as it was")
    rc, db, ue = ctx_of(ids["emp"])
    try:
        ctxe = a._dash_context(db, ue)
    finally:
        rc.pop()
    he = page(ids["emp"])
    st = section_of(he, "od-stand")
    s.check("their own card, no switch, no Own pane", st and 'data-lt-tab="own"' not in he and "od-own-pane" not in he)
    s.check("...its rows Where you stand's", dts(st) == [r["label"].replace(" rating", "")
                                                          for r in ctxe.get("standing") or []] and dts(st), dts(st))
    s.check("...and its Details in the head, as before", re.search(
        r'<h2 id="od-st-h">Where you stand</h2>\s*<button type="button" class="od-linkbtn" data-record="current"', st))

    # ---------------------------------------------------------------------------
    s.section("Ask OneHR and Help point a CEO to Own")
    s.check("ASK_MARKS knows own", "own" in a.ASK_MARKS)
    with a.app.test_request_context("/"):
        hit = a._ask_intent("where are my own results?", ctx)
        hit_e = a._ask_intent("where are my own results?", ctxe)
        hit_b = a._ask_intent("where can I see my results this cycle", ctxb)
        w_b = a._ask_where_results(ctxb)
    s.check("'where are my own results?': a CEO's card marked own (it switches), answered in code",
            hit and hit["mark"] == "own" and "Own" in hit["say"], hit)
    s.check("...never a BG CEO's (no Own on their card)", (hit_b or {}).get("mark") != "own" and w_b[1] != "own",
            (hit_b, w_b))
    s.check("...an employee's Where you stand marked", hit_e and hit_e["mark"] == "stand"
            and "Where you stand" in hit_e["say"], hit_e)
    w_ = a._ask_where_results(ctx)
    s.check("a results question points a CEO to Own", w_[1] == "own" and "Own" in w_[0], w_)
    s.check("...and an employee to Where you stand", a._ask_where_results(ctxe)[1] == "stand")
    with a.app.test_request_context("/"):
        facts, links = a._ask_facts(a.get_db(), u, ctx)
    s.check("the guide's facts name the Own switch, as a way on that marks own",
            any(v.get("mark") == "own" for v in links.values()) and any("Own switch" in x for x in facts), links)
    js = open(os.path.join(H.REPO, "static", "ask_onehr.js"), encoding="utf-8").read()
    s.check("ask_onehr.js marks own on the CEO's card and clicks its Own tab",
            'own: [".od-bu"' in js and "data-lt-tab=\"own\"" in js.replace("'", '"'))
    rc, db, _u = ctx_of(ids["buceo"])
    try:
        ha = a.help_answers(db, _u, "dashboard")
    finally:
        rc.pop()
    rc, db, _e = ctx_of(ids["emp"])
    try:
        he_ = a.help_answers(db, _e, "dashboard")
    finally:
        rc.pop()
    s.check("Help on a CEO's dashboard: 'Where are my own results this cycle?'",
            any(i.get("key") == "dash_own" for i in ha["items"]), [i.get("key") for i in ha["items"]])
    s.check("...not on an employee's", not any(i.get("key") == "dash_own" for i in he_["items"]),
            [i.get("key") for i in he_["items"]])
    with a.app.app_context():
        kb = a.get_db().execute("SELECT body FROM kb_entries WHERE slug='ceo-own-results'").fetchone()
    s.check("the KB row says to switch the card to Own", kb and "Switch it to Own" in kb[0]
            and "business group" not in kb[0], kb)
    tour = open(os.path.join(H.REPO, "static", "onboarding.js"), encoding="utf-8").read()
    s.check("the first sign-in tour's stop on the CEO's card names Own",
            "unit's card, Own shows your own results this cycle." in tour)
    dj = open(os.path.join(H.REPO, "static", "dashboard.js"), encoding="utf-8").read()
    s.check("dashboard.js: the switch's title and line follow the picked tab", "[data-lt-for]" in dj)

    # ---------------------------------------------------------------------------
    s.section("released to the person: the final band takes the row, the line manager's score and band are gone")
    # something still waits on them (the dashboard stays in the running view): the case the fix is for
    _mode, _fr = a.dash_mode, a.final_result
    FINAL = {"pm": "AE", "pot": "High"}
    a.dash_mode = lambda *x, **k: "running"
    a.final_result = lambda db_, subj, cid, kind, ov_map=None: {"band": FINAL[kind]}
    try:
        def standing_of(uid):
            rc_, db_, u_ = ctx_of(uid)
            try:
                return {r["key"]: r for r in a._dash_context(db_, u_)["standing"]}
            finally:
                rc_.pop()
        before = standing_of(ids["emp"])
        s.check("before any release: Performance (the line manager's, or awaiting them) and the competency row",
                before.get("performance", {}).get("label") == "Performance rating" and "competency" not in before
                or before.get("competency", {}).get("label") == "Competency", before.get("performance"))
        with a.app.app_context():
            db = a.get_db()
            made["rel_cid"] = a.active_cycle_id(db)
            pid = (a.active_pm_period(db) or {"id": made["rel_cid"]})["id"]
            made["rel"] = [(pid, ids["emp"], "pm"), (made["rel_cid"], ids["emp"], "pot"), (pid, ids["buceo"], "pm")]
            for c_, s_, k_ in made["rel"]:
                db.execute("INSERT OR IGNORE INTO result_releases(cycle_id, subject_id, kind) VALUES (?,?,?)",
                           (c_, s_, k_))
            db.commit()
        after = standing_of(ids["emp"])
        pf, pt = after.get("performance") or {}, after.get("competency") or {}
        s.check("Performance released: 'Final performance', its final band, no score and no line manager's note",
                pf.get("label") == "Final performance" and pf.get("band") == "AE" and not pf.get("value")
                and "line manager" not in (pf.get("note") or ""), pf)
        s.check("Potential released: 'Final potential' with its final band, never the demonstrated count",
                pt.get("label") == "Final potential" and pt.get("band") == "High" and not pt.get("text"), pt)
        he2 = page(ids["emp"])
        st2 = section_of(he2, "od-stand")
        s.check("the card draws them: Final performance and Final potential, their band pills, no 'Approved by your "
                "line manager'", "Final performance" in st2 and 'data-band="AE"' in st2 and "Final potential" in st2
                and 'data-band="High"' in st2 and "Approved by your line manager" not in st2, dts(st2))
        hb2 = page(ids["buceo"])
        own2 = pane(section_of(hb2, "od-bu"), "od-own-p-own")
        s.check("a BU CEO's Own view follows the same rule (Performance released only: the competency row stays)",
                "Final performance" in own2 and 'data-band="AE"' in own2 and "Final potential" not in own2,
                dts(own2))
    finally:
        a.dash_mode, a.final_result = _mode, _fr
finally:
    with a.app.app_context():
        db = a.get_db()
        for c_, s_, k_ in made.get("rel") or []:
            db.execute("DELETE FROM result_releases WHERE cycle_id=? AND subject_id=? AND kind=?", (c_, s_, k_))
        uids = list(ids.values())
        if uids:
            ph = ",".join("?" * len(uids))
            db.execute("DELETE FROM buceo_seats WHERE user_id IN (%s)" % ph, uids)
            db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, uids)
            db.execute("DELETE FROM users WHERE id IN (%s)" % ph, uids)
        if made.get("cid"):
            if made.get("review") is None:
                db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='review'", (made["cid"],))
            else:
                db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key='review'",
                           (made["review"], made["cid"]))
        db.commit()

sys.exit(s.done())
