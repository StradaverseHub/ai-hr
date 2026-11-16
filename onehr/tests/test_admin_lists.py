"""An admin count opens its people in the right panel, and the 360 rater cap is a rule for everyone (Chris, 2026-10-20).

"clicking on these box should open up view of the list with filtered users inside ... admin can straight away amend and
add the panel members in the panel in one page view" (canvas [design canvas link removed]), and on
the cap: "block for everyone, unless super admin change the max assessor panel".

What it holds: the cap is a super-admin rule (default + a cycle's own) read by every manual add -- the panel editor's
add, the ticked suggestions, restore, a line-manager change, the panel import -- and the assessor search reports each
person's load; the 360 Overview's numbers each open a list built by the same query as the number; a person in the list
opens in the same panel and a save comes back to it. Everything written is synthetic (ZZAL-*) and is removed at the end;
the settings it changes are put back.
"""
import html
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Admin counts open their people; the rater cap holds for every add")
SU, BGA, EMP = H.actors(a)
sup = H.client_as(a, SU["id"])
BG, CO, DEPT = "ZZAL BG", "ZZAL CO", "ZZAL Dept"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZAL-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM pm_idp_checkins WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM pm_idp_goals WHERE idp_id IN (SELECT id FROM pm_idp WHERE subject_id IN (%s))" % ph, ids)
        db.execute("DELETE FROM pm_idp WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE target_user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM pm_kpi_target_approvers WHERE approver_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    CYC = dict(a.active_cycle(db))
    CID = CYC["id"]
    _cleanup(db)
    SETTINGS0 = {k: v for k, v in db.execute("SELECT key, value FROM app_settings WHERE key IN "
                                             "('panel_size','min_valid','tiers','assessor_cap')")}
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, name, mgr=None, jg="16", left=None, co=CO):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=mgr,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=co, department=DEPT,
                 job_title="ZZAL Analyst", job_grade=jg, years_of_service=3, confirmation_date=None, left_at=left,
                 is_demo=0, role="user", admin_bg=None)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?),(?,?)", (BG, CO, BG, CO + " 2"))
    BOSS = mk("ZZAL-BOSS", "ZZ AL Boss", jg="20")
    X = mk("ZZAL-X", "ZZ AL Busy", mgr=BOSS)                       # rates four people already
    S = [mk("ZZAL-S%d" % i, "ZZ AL Subject %d" % i, mgr=BOSS) for i in range(9)]
    GONE = mk("ZZAL-GONE", "ZZ AL Gone", left="2026-01-31 00:00:00")
    ORPH = mk("ZZAL-ORPH", "ZZ AL Orphan", mgr=GONE)               # their line manager has left
    mk("ZZAL-U2", "ZZ AL Second Unit", mgr=BOSS, co=CO + " 2")      # a second unit, so a unit pick narrows
    NEWJ = mk("ZZAL-NEW", "ZZ AL Newjoiner", mgr=BOSS)            # a new joiner not taking part (under a year, unconfirmed)
    for i in range(4):
        db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship) VALUES (?,?,?,'peer')",
                   (CID, S[i], X))
    # two synthetic Career Plans this plan year (one draft, one closed) and a check-in, so the Career Plan's lists
    # are checked on rows that exist
    YEAR = a.pm_idp_plan_year(a.active_pm_period(db))
    for sid, st in ((S[0], "draft"), (S[1], "closed")):
        db.execute("INSERT INTO pm_idp(plan_year, subject_id, status) VALUES (?,?,?)", (YEAR, sid, st))
    _idp1 = db.execute("SELECT id FROM pm_idp WHERE subject_id=? AND plan_year=?", (S[1], YEAR)).fetchone()[0]
    db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area) VALUES (?,1,'ZZAL goal')", (_idp1,))
    _g1 = db.execute("SELECT id FROM pm_idp_goals WHERE idp_id=?", (_idp1,)).fetchone()[0]
    db.execute("INSERT INTO pm_idp_checkins(goal_id, subject_id, status) VALUES (?,?,'on_track')", (_g1, S[1]))
    # two of ours came in by Add a person today, so Home's New joiners card has rows to check
    db.execute("UPDATE users SET created_at=datetime('now'), created_via='admin' WHERE id IN (?,?,?)", (S[2], ORPH, NEWJ))
    db.execute("UPDATE users SET years_of_service=0.2, confirmation_date=NULL WHERE id=?", (NEWJ,))
    db.commit()
    CAP0 = a.default_assessor_cap()


def load_of(uid):
    return H.one(a, "SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND assessor_id=? AND archived=0", (CID, uid))


def on_panel(sid, aid):
    return H.one(a, "SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND subject_id=? AND assessor_id=? "
                    "AND archived=0", (CID, sid, aid))


def set_cap(v):
    with a.app.app_context():
        d = a.get_db()
        if v is None:
            d.execute("DELETE FROM app_settings WHERE key='assessor_cap'")
        else:
            d.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('assessor_cap', ?)", (str(v),))
        d.commit()


def flashes(c):
    """What the last steps flashed, emptied as it's read (so each check reads its own step's)."""
    with c.session_transaction() as ss:
        out = " ".join(m for _c, m in (ss.get("_flashes") or []))
        ss["_flashes"] = []
    return out


def post(url, c=sup, **f):
    d = {"csrf_token": "tok"}
    d.update(f)
    return c.post(url, data=d)


_PART0 = {}   # what the 'This cycle' section changed on the cycle, put back in the finally
try:
    # -------------------------------------------------------------------------------------------------------------
    s.section("the rater cap is a super-admin rule")
    set_cap(None)
    with a.app.test_request_context("/"):
        s.check("with nothing set, the cap is the engine's own (4)", a.default_assessor_cap() == a._ba.ASSESSOR_CAP == 4,
                a.default_assessor_cap())
        tiers = a.default_tiers()
        ps, mv = a.default_panel_size(), a.default_min_valid()
    form = {"action": "rules", "panel_size": str(ps), "min_valid": str(mv), "assessor_cap": "6",
            "remark": "ZZAL test: raising the rater cap"}
    for t in tiers:
        form["tier%d_min" % t["n"]], form["tier%d_max" % t["n"]] = str(t["min"]), str(t["max"])
    r = post("/admin/settings", **form)
    s.check("Settings › Rules saves the cap", r.status_code == 302 and
            H.one(a, "SELECT value FROM app_settings WHERE key='assessor_cap'") == "6", r.status_code)
    s.check("...and the audit row names it", "rater cap 6" in (H.one(
        a, "SELECT detail FROM activity_log WHERE action='settings' ORDER BY id DESC LIMIT 1") or ""))
    r = post("/admin/settings", **dict(form, assessor_cap="0"))
    s.check("a cap outside 1-20 is refused, the rule unchanged",
            H.one(a, "SELECT value FROM app_settings WHERE key='assessor_cap'") == "6")
    r = post("/admin/settings", **{k: v for k, v in form.items() if k != "assessor_cap"})
    s.check("a rules form that doesn't send the cap leaves it as it is (absent is not empty)",
            H.one(a, "SELECT value FROM app_settings WHERE key='assessor_cap'") == "6")
    if BGA:
        r = post("/admin/settings", c=H.client_as(a, BGA["id"]), **dict(form, assessor_cap="9"))
        s.check("a BG admin can't change it", H.one(a, "SELECT value FROM app_settings WHERE key='assessor_cap'") == "6",
                r.status_code)
    with a.app.test_request_context("/"):
        c6 = a.effective_assessor_cap(dict(CYC, assessor_cap=None))
        c9 = a.effective_assessor_cap(dict(CYC, assessor_cap=9))
    s.check("a cycle follows the default, or its own when it has one", c6 == 6 and c9 == 9, (c6, c9))
    set_cap(None)
    r = sup.get("/admin/m/f360/settings")
    s.check("the rules card has the field", 'name="assessor_cap"' in r.get_data(as_text=True), r.status_code)

    # -------------------------------------------------------------------------------------------------------------
    s.section("every add by hand stops at the cap")
    s.check("the busy rater rates 4 (the check reaches its line)", load_of(X) == 4, load_of(X))
    r = post("/admin/subjects/%d/panel" % S[4], action="add", assessor_eid="ZZAL-X", relationship="peer")
    s.check("the panel editor's add is refused at the cap", not on_panel(S[4], X), r.status_code)
    s.check("...saying who and why", "ZZ AL Busy already rates 4 people this cycle" in flashes(sup), flashes(sup)[:200])
    r = post("/admin/subjects/%d/panel" % S[5], action="add_suggested", **{"pick_%d" % X: "1", "rel_%d" % X: "peer"})
    s.check("a ticked suggestion at the cap is skipped", not on_panel(S[5], X), r.status_code)
    with a.app.app_context():
        d = a.get_db()
        d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, archived) "
                  "VALUES (?,?,?,'peer',1)", (CID, S[6], X))
        d.commit()
        arch = d.execute("SELECT id FROM assignments WHERE cycle_id=? AND subject_id=? AND assessor_id=?",
                         (CID, S[6], X)).fetchone()[0]
    r = post("/admin/subjects/%d/panel" % S[6], action="restore", assignment_id=str(arch))
    s.check("restoring an archived rater at the cap is refused", not on_panel(S[6], X), r.status_code)
    with a.app.test_request_context("/"):
        d = a.get_db()
        res = a._apply_line_manager_change(d, S[7], X, CID, disposition="reassign", actor_id=SU["id"])
        d.commit()
        mgr = d.execute("SELECT manager_id FROM users WHERE id=?", (S[7],)).fetchone()[0]
    s.check("a line-manager change still makes them the line manager, but not a rater past the cap",
            res["assignment_action"] == "capped" and mgr == X and not on_panel(S[7], X), (res["assignment_action"], mgr))
    csv_ = "Subject Employee ID,Assessor Employee ID,Relationship\nZZAL-S8,ZZAL-X,peer\n"
    r = H.import_steps(sup, "/admin/import", {"file": (io.BytesIO(csv_.encode()), "p.csv")})
    imp = html.unescape(r.get_data(as_text=True))
    s.check("the panel import refuses a row that takes someone past the cap, saying so",
            not on_panel(S[8], X) and "ZZ AL Busy already rates 4 people this cycle, the most allowed" in imp and "Over the rater limit" in imp,
            imp[-300:])
    j = sup.get("/admin/subjects/%d/assessor-search?q=ZZ+AL+Busy&rel=peer" % S[4]).get_json() or {}
    hit = [x for x in j.get("results", []) if x.get("employee_id") == "ZZAL-X"]
    s.check("the name search reports their load and that they're full",
            hit and hit[0]["load"] == 4 and hit[0]["full"] is True and j.get("cap") == 4, (hit, j.get("cap")))
    fr = html.unescape(sup.get("/admin/users/%d?tab=f360&fragment=1" % S[4]).get_data(as_text=True))
    s.check("the person's suggestions show the load and can't tick a full one",
            "rates 4 of 4 · full" in fr and re.search(r'name="pick_%d"[^>]*disabled' % X, fr) is not None)
    set_cap(5)
    r = post("/admin/subjects/%d/panel" % S[4], action="add", assessor_eid="ZZAL-X", relationship="peer")
    s.check("once the super admin raises the cap, the same add goes through", on_panel(S[4], X) == 1, r.status_code)
    set_cap(None)

    # -------------------------------------------------------------------------------------------------------------
    s.section("the 360 Overview's numbers open their people")
    page = html.unescape(sup.get("/admin/360").get_data(as_text=True))
    trig = {k: u for u, k in re.findall(r'data-list-open="(/admin/list/([\w-]+)\?fragment=1)"', page)}
    s.check("all four tiles open a list", {"f360-rated", "f360-short", "f360-owing", "f360-released"} <= set(trig), trig)
    s.check("...in the page's one list panel", 'id="pnl-list"' in page and "data-panel-peek" in page)
    tiles = dict(re.findall(r'<span class="muted small">([^<]+)</span>\s*<b>([\d,]+)</b>', page))
    num = lambda k: int(tiles.get(k, "-1").replace(",", ""))  # noqa: E731

    def frag(key, **q):
        r_ = sup.get("/admin/list/%s" % key, query_string=dict(q, fragment=1))
        b_ = html.unescape(r_.get_data(as_text=True))
        n_ = re.search(r'data-list-n="(\d+)"', b_)
        return r_.status_code, b_, int(n_.group(1)) if n_ else -1

    for key, label in (("f360-rated", "People being rated"), ("f360-short", "Short of a full panel"),
                       ("f360-released", "Reports released")):
        st, b, n = frag(key)
        s.check("%-22s lists the tile's number (%d)" % (label, num(label)), st == 200 and n == num(label) >= 0,
                (st, n, num(label)))
        shown = len(set(re.findall(r'data-person-open="(\d+)"', b)))
        s.check("%-22s is a fragment, its first %d rows open in the panel" % (label, a.LIST_ROWS_SHOWN),
                "<html" not in b and shown == min(n, a.LIST_ROWS_SHOWN), (shown, n))
        s.check("%-22s says when it holds only the first rows" % label,
                ("Showing the first" in b) == (n > a.LIST_ROWS_SHOWN))
    st, b, n = frag("f360-short")
    s.check("the short list carries our short person and why", "ZZAL-S5" in b and "Why short" in b)
    asked = re.search(r"Ratings in</span>\s*<b>([\d,]+)</b><span class=\"muted small\">of ([\d,]+) asked", page)
    st, b, n = frag("f360-owing")
    todo = re.search(r"Ratings still to come · ([\d,]+)", b)
    s.check("Ratings in: the list's still-to-come is the tile's asked minus in",
            asked and todo and int(todo.group(1).replace(",", "")) == int(asked.group(2).replace(",", ""))
            - int(asked.group(1).replace(",", "")), (asked and asked.groups(), todo and todo.group(1)))
    s.check("...with Remind at the top", "clp-bulk" in b and "/admin/reminders" in b)
    stages = sum(frag("f360-stage", stage=k)[2] for k in a.F360_STAGES)
    s.check("the stage key's four lists add up to the people being rated", stages == num("People being rated"),
            (stages, num("People being rated")))
    r = sup.get("/admin/list/f360-short")
    s.check("without ?fragment the list goes to its full page", r.status_code == 302
            and "/admin/subjects" in r.headers.get("Location", ""), r.headers.get("Location"))
    s.check("an unknown list is a 404", sup.get("/admin/list/nope?fragment=1").status_code == 404)
    s.check("every list belongs to a module an admin's access can tick",
            all(spec["module"] in a.ACCESS_MODULE_KEYS for spec in a.ADMIN_LISTS.values()),
            {k: v["module"] for k, v in a.ADMIN_LISTS.items()})
    s.check("an employee can't open one", H.client_as(a, EMP["id"]).get("/admin/list/f360-rated?fragment=1").status_code
            in (302, 403, 404))
    if BGA:
        # the super admin's only for now (Chris, 2026-10-20: "Super admin only for now", until Roles & access is built)
        # (2026-10-27: Leaders > BU CEOs' "bu-people" list opts in with all_admins, Chris: "all admins can view"; every other list stays super-only: tests/test_bu_people_list.py)
        rb = H.client_as(a, BGA["id"]).get("/admin/list/f360-rated?fragment=1")
        s.check("a BG admin can't open a list (the super admin's only for now)",
                rb.status_code == 403 and "data-person-open" not in rb.get_data(as_text=True), rb.status_code)
        ob = H.client_as(a, BGA["id"]).get("/admin/360").get_data(as_text=True)
        s.check("...their 360 Overview's counts open the full page, not the panel",
                "data-list-open" not in ob and 'id="pnl-list"' not in ob and "adm-tile-link" in ob)

    # -------------------------------------------------------------------------------------------------------------
    s.section("phase 2: each module's stage tiles and by-group numbers open their people")
    def nlist(url):
        b_ = html.unescape(sup.get(url).get_data(as_text=True))
        m_ = re.search(r'data-list-n="(\d+)"', b_)
        return int(m_.group(1)) if m_ else -1, b_
    reached = 0
    for key in ("pm", "competency", "calibration"):
        pg = html.unescape(sup.get("/admin/module/%s" % key).get_data(as_text=True))
        tiles = re.findall(r'data-list-open="(/admin/list/mod-%s\?[^"]*)">\s*<span class="adm-stage-k">.*?</span>\s*'
                           r'<b>([\d,]+)</b>' % key, pg, re.S)
        if not tiles:
            s.note("%s: no stage tiles here (the module's note shows instead)" % key)
            continue
        reached += 1
        bad = [(u, n, nlist(u)[0]) for u, n in tiles if nlist(u)[0] != int(n.replace(",", ""))]
        s.check("%-12s every stage tile lists its own number (%d tiles)" % (key, len(tiles)), not bad, bad[:3])
        cells = re.findall(r'<a href="[^"]*" data-list-open="(/admin/list/mod-%s\?[^"]*)">([\d,]+)</a>' % key, pg)
        badc = [(u, n) for u, n in cells[:12] if nlist(u)[0] != int(n.replace(",", ""))]
        s.check("%-12s the by-group numbers list their own (%d checked)" % (key, min(len(cells), 12)),
                cells and not badc, badc[:3])
        s.check("%-12s the page has the list panel" % key, 'id="pnl-list"' in pg)
    s.check("at least one module had stage tiles (the checks above reached their lines)", reached >= 1, reached)
    # one level down: our synthetic group picked, the table cuts by unit and each cell carries the unit pick
    pg = html.unescape(sup.get("/admin/module/pm", query_string={"fbg": BG}).get_data(as_text=True))
    cells = re.findall(r'<a href="[^"]*" data-list-open="(/admin/list/mod-pm\?[^"]*)">([\d,]+)</a>', pg)
    unit = [(u, n) for u, n in cells if "fbu=" in u]
    s.check("inside a group, each unit's numbers carry the unit and list their own",
            unit and all(nlist(u)[0] == int(n.replace(",", "")) for u, n in unit), unit[:3])
    # Performance's Not started has no KPI line: the action is the admin's, never a reminder (Chris, 2026-10-21: "isn't
    # this an admin action to set the KPI?"); Remind them is for Targets set, and only while the KPI check-in is open
    n_r, b_r = nlist("/admin/list/mod-pm?fstage=not_started&fragment=1")
    s.check("Performance's Not started offers Add their KPI lines (the targets import), never Remind them",
            n_r > 0 and "/admin/performance/import" in b_r and "Add their KPI lines" in b_r
            and "/admin/reminders" not in b_r, n_r)
    with a.app.app_context():
        _d = a.get_db()
        _cid = a.active_cycle(_d)["id"]
        _w0 = _d.execute("SELECT opens_at, closes_at FROM cycle_windows WHERE cycle_id=? AND cell='pm_results'",
                         (_cid,)).fetchone()
        # one of ours with a KPI line and no result, so Targets set has someone in it whatever the copy holds
        _d.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, "
                   "company, status) VALUES (?,?, 'ZZAL KPI', 100, 'more', ?, ?, 'approved')", (_cid, S[0], BG, CO))
        _d.commit()
    try:
        for opens, closes, want in (("2001-01-01 00:00", "2001-01-02 00:00", False),
                                    ("2001-01-01 00:00", "2099-01-01 00:00", True)):
            with a.app.app_context():
                _d = a.get_db()
                _d.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, "
                           "'pm_results', ?, ?)", (_cid, opens, closes))
                _d.commit()
            n_t, b_t = nlist("/admin/list/mod-pm?fstage=targets&fragment=1")
            pg_p = sup.get("/admin/module/pm/progress").get_data(as_text=True)
            s.check("Targets set reminds them %s" % ("while the KPI check-in is open" if want else
                                                     "only while it's open: closed, no Remind them"),
                    n_t > 0 and (("/admin/reminders" in b_t) == want)
                    and (("with results still to submit" in pg_p) == want), (n_t, want))
    finally:
        with a.app.app_context():
            _d = a.get_db()
            if _w0:
                _d.execute("UPDATE cycle_windows SET opens_at=?, closes_at=? WHERE cycle_id=? AND cell='pm_results'",
                           (_w0[0], _w0[1], _cid))
            else:
                _d.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='pm_results'", (_cid,))
            _d.execute("DELETE FROM pm_kpi_targets WHERE subject_id=? AND kpi_name='ZZAL KPI'", (S[0],))
            _d.commit()

    s.section("phase 2: the Career Plan Overview's numbers")
    pg = html.unescape(sup.get("/admin/m/idp").get_data(as_text=True))
    t_ = dict((lab.strip(), int(n.replace(",", ""))) for lab, n in re.findall(
        r'<span class="muted small">([^<]+)</span><b>([\d,]+)</b>', pg))
    plans = next((v for k_, v in t_.items() if k_.startswith("Plans started")), -1)
    s.check("Plans lists its number (our two synthetic plans among them)",
            nlist("/admin/list/idp-plans?which=all&fragment=1")[0] == plans >= 2
            and "ZZAL-S0" in nlist("/admin/list/idp-plans?which=all&fragment=1")[1], (plans, t_))
    s.check("Shared lists its number", nlist("/admin/list/idp-plans?which=shared&fragment=1")[0]
            == t_.get("Shared with a manager", -1))
    s.check("Closed lists its number", nlist("/admin/list/idp-plans?which=closed&fragment=1")[0]
            == t_.get("Closed by the manager", -1))
    _n, bci = nlist("/admin/list/idp-checkins?fragment=1")
    m_ci = re.search(r"Check-ins this plan year · ([\d,]+)", bci)
    s.check("Check-ins: the list adds up to the tile", m_ci and int(m_ci.group(1).replace(",", ""))
            == t_.get("Check-ins this plan year", -1) >= 1 and "ZZAL-S1" in bci,
            (m_ci and m_ci.group(1), t_.get("Check-ins this plan year")))
    s.check("Closed holds the closed plan, not the draft", "ZZAL-S1" in nlist(
        "/admin/list/idp-plans?which=closed&fragment=1")[1] and "ZZAL-S0" not in nlist(
        "/admin/list/idp-plans?which=closed&fragment=1")[1])
    s.check("every Career Plan tile opens a list", pg.count('data-list-open="/admin/list/idp-') >= 4)

    s.section("phase 2: What needs you opens the people a step waits on")
    with a.app.test_request_context("/"):
        from flask import session as _ss
        _ss["user_id"] = SU["id"]
        groups, _d, _t = a._cycle_readiness(a.get_db(), dict(SU), a.viewed_cycle(a.get_db()))
    steps = {st["label"]: st for g in groups for st in g["steps"]}
    listed = [st for st in steps.values() if st.get("list")]
    s.note("steps with a list now: %s" % [st["label"] for st in listed])
    s.check("an open step with people behind it has a list (the check reaches its line)", listed)
    for st in listed:
        n_, b_ = nlist(st["list"])
        s.check("%-40s its list opens (200, a count)" % st["label"][:40], n_ >= 0, st["list"])
    _n, b_lm = nlist("/admin/list/ready-no-lm?fragment=1")
    s.check("No line manager lists someone whose manager has left, saying so",
            "ZZAL-ORPH" in b_lm and "Their line manager has left" in b_lm and "ZZAL-S0" not in b_lm)
    lm = steps.get("Everyone taking part has a line manager")
    if lm and lm.get("list"):
        s.check("No line manager: the list is the step's missing ones exactly", nlist(lm["list"])[0] == lm["of"] - lm["n"],
                (nlist(lm["list"])[0], lm["of"], lm["n"]))
    for lbl_ in ("Assessor panels built", "KPI targets in", "Results submitted"):
        st_ = steps.get(lbl_)
        if st_ and st_.get("list"):
            s.check("%-22s the list is the step's missing ones exactly" % lbl_, nlist(st_["list"])[0] == st_["of"] - st_["n"],
                    (nlist(st_["list"])[0], st_["of"], st_["n"]))
    km = steps.get("Every KPI line has a moderator")
    if km and km.get("list"):
        m_k = re.search(r"KPI lines with no moderator · ([\d,]+)", nlist(km["list"])[1])
        s.check("KPI lines with no moderator: the list's lines are the step's missing ones",
                m_k and int(m_k.group(1).replace(",", "")) == km["of"] - km["n"], (m_k and m_k.group(1), km["of"], km["n"]))
    pm_page = html.unescape(sup.get("/admin/module/pm").get_data(as_text=True))
    s.check("a module's What needs you rows carry their list", any(st["list"] in pm_page for st in listed
                                                                  if "/admin/list/ready-" in (st["list"] or ""))
            or not any("ready-" in (st["list"] or "") for st in listed))
    if BGA:
        pb = html.unescape(H.client_as(a, BGA["id"]).get("/admin/module/pm").get_data(as_text=True))
        s.check("a BG admin's module Overview opens no list (the super admin's for now)",
                "data-list-open" not in pb and 'id="pnl-list"' not in pb)
        s.check("...and they can't open one directly", H.client_as(a, BGA["id"]).get(
            "/admin/list/mod-pm?fragment=1").status_code == 403)

    s.section("phase 3: Home, Data integrity and Lock status")
    home = html.unescape(sup.get("/admin").get_data(as_text=True))
    cells = re.findall(r'<a class="hm-cell[^"]*" href="[^"]*" data-list-open="(/admin/list/home-cell\?[^"]*)">\s*'
                       r'<span class="hm-pct"><b>[^<]*</b><span>([\d,]+) of ([\d,]+) ([^<]+)</span>', home)
    s.check("Home's matrix cells open their people (the check reaches its line)", cells, len(cells))
    bad = []
    for u_, done_, of_, word_ in cells[:12]:
        b_ = nlist(u_)[1]
        ok_ = ("%s of %s %s" % (done_, of_, word_.strip())) in b_   # f360 too: its list is the raters the cell counts
        if not ok_:
            bad.append((u_, done_, of_, word_))
    s.check("...each list says the cell's own N of M", not bad, bad[:3])
    s.check("Home's Needs you rows open their people", "data-list-open=\"/admin/list/ready-" in home)
    s.check("Home's page has the list panel", 'id="pnl-list"' in home)
    jl = re.findall(r'data-list-open="(/admin/list/joiners\?[^"]*)"><b>([\d,]+)</b>', home)
    s.check("New joiners' numbers open their people, each its own count",
            jl and all(nlist(u_)[0] == int(n_.replace(",", "")) for u_, n_ in jl), jl)
    s.check("...our joiner not taking part is under Not taking part, never under No KPI lines",
            "ZZAL-NEW" in nlist("/admin/list/joiners?which=not_taking&fragment=1")[1]
            and "ZZAL-NEW" not in nlist("/admin/list/joiners?which=no_kpi&fragment=1")[1])
    s.check("...our synthetic joiner whose manager left is under No line manager",
            "ZZAL-ORPH" in nlist("/admin/list/joiners?which=no_lm&fragment=1")[1])
    di = html.unescape(sup.get("/admin/data-integrity").get_data(as_text=True))
    t_hi = re.search(r'severity=high[^"]*"><span class="muted small">High severity</span><b>([\d,]+)</b>', di)
    t_all = re.search(r'/admin/list/check\?fragment=1"><span class="muted small">Findings in total</span>'
                      r'<b>([\d,]+)</b>', di)
    n_hi = nlist("/admin/list/check?severity=high&fragment=1")[0]
    n_all = nlist("/admin/list/check?fragment=1")[0]
    s.check("Data integrity: High severity lists its number", t_hi and n_hi == int(t_hi.group(1).replace(",", "")),
            (t_hi and t_hi.group(1), n_hi))
    s.check("...Findings in total lists its number", t_all and n_all == int(t_all.group(1).replace(",", "")),
            (t_all and t_all.group(1), n_all))
    rows_ = re.findall(r'data-list-open="(/admin/list/check\?check=[\w-]+&fragment=1)"><strong>([\d,]+)</strong>', di)
    s.check("...each check's findings list their number (%d checks)" % len(rows_),
            rows_ and all(nlist(u_)[0] == int(n_.replace(",", "")) for u_, n_ in rows_), rows_[:3])
    lk = html.unescape(sup.get("/admin/calibration/locks").get_data(as_text=True))
    tiers = re.findall(r'data-list-open="(/admin/list/lock-tier\?[^"]*)"><span class="adm-stage-k">[^<]*</span>\s*'
                       r'<b>([\d,]+) <small class="muted">of ([\d,]+) locked', lk)
    if tiers:
        s.check("Lock status: each tier lists its scopes, N of M locked", all(
            ("%s of %s locked" % (n_, of_)) in nlist(u_)[1] for u_, n_, of_ in tiers), tiers)
    else:
        s.note("no calibration scopes this cycle: the Lock status tiles aren't drawn")

    s.section("the lint: every count tile on these pages opens a list for the super admin, or says why not")
    PAGES = ("/admin", "/admin/360", "/admin/module/pm", "/admin/module/competency", "/admin/module/calibration",
             "/admin/m/idp", "/admin/data-integrity", "/admin/calibration/locks")
    lone = []
    for path in PAGES:
        b_ = html.unescape(sup.get(path).get_data(as_text=True))
        for tag in re.findall(r'<(?:a|div)[^>]*class="[^"]*\badm-(?:stage-)?tile\b[^"]*"[^>]*>', b_):
            if "data-list-open=" not in tag and "data-no-list=" not in tag:
                lone.append((path, tag[:90]))
    s.check("no count tile without its list (or a data-no-list reason)", not lone, lone[:4])

    s.section("a person in the list opens in the same panel, and a save comes back")
    for v, ok in (("/admin/360?panel=list&ls=/admin/list/f360-short&pp=5", True),
                  ("/admin/subjects?panel=person&pp=5", True), ("//evil.example/admin?panel=list", False),
                  ("/admin/360?panel=other", False), ("https://x/admin?panel=list", False)):
        with a.app.test_request_context("/", method="POST", data={"panel_back": v}):
            s.check("panel_back %-55s %s" % (v[:55], "kept" if ok else "refused"), bool(a._panel_back()) is ok)
    js = open(os.path.join(H.REPO, "static", "admin.js")).read()
    for needle in ('closest("[data-list-open]")', "function openList(", "function listPerson(", "function listBack(",
                   'u.searchParams.set("ls"', 'want === "list"', "listPersonMode(p)) hidden(f, \"panel_back\""):
        s.check("admin.js: %s" % needle, needle in js)
    tpl = open(os.path.join(H.REPO, "templates", "_adm_panel.html")).read()
    s.check("the list panel has Back, Previous / Next and Open as a full page",
            "macro list_peek" in tpl and "data-list-back" in tpl and "data-list-page" in tpl)
    s.section("a leader's Line manager / HOD counts open their people (Chris, 2026-11-06)")
    with a.app.app_context():
        d = a.get_db()
        # BOSS already leads X, S0-S8, U2, NEW as line manager; add an admin-role user and a leaver under them, and make
        # some of them (and a leaver, an admin-role user, and a person of another business group) HODs' people
        d.execute("UPDATE users SET manager_id=? WHERE id IN (?,?)", (BOSS, GONE, S[0]))   # a leaver under them, counted never
        d.execute("UPDATE users SET role='admin' WHERE id=?", (NEWJ,))                      # an admin-role user: never counted
        d.execute("UPDATE users SET hod_id=? WHERE id IN (?,?,?,?,?)", (BOSS, S[1], S[2], S[3], GONE, NEWJ))
        d.execute("UPDATE users SET business_group='ZZAL BG other' WHERE id=?", (S[3],))    # another group: the HOD list covers it
        d.commit()
        roles = a._person_roles(d, d.execute("SELECT * FROM users WHERE id=?", (BOSS,)).fetchone(), CID)
    s.check("the synthetic leader has both a line-manager and an HOD count", roles["reports"] > 0 and roles["heads"] > 0, roles)

    def panel_ids(key, **kw):
        r_ = sup.get("/admin/list/%s?fragment=1&uid=%d" % (key, BOSS) + "".join("&%s=%s" % kv for kv in kw.items()))
        b_ = r_.get_data(as_text=True)
        return r_, b_, re.findall(r'data-person-open="(\d+)"', b_)
    r_, b_, ids_ = panel_ids("lm-reports")
    s.check("lm-reports: 200, and as many people as the page's count", r_.status_code == 200 and len(set(ids_)) == roles["reports"],
            (r_.status_code, len(set(ids_)), roles["reports"]))
    s.check("lm-reports: the title carries that count", ("· %d" % roles["reports"]) in html.unescape(b_))
    s.check("lm-reports: a leaver and an admin-role user are not in it", GONE not in map(int, ids_) and NEWJ not in map(int, ids_))
    r_, b_, ids2_ = panel_ids("hod-people")
    s.check("hod-people: as many people as the page's count (every business group)", r_.status_code == 200 and
            len(set(ids2_)) == roles["heads"] and S[3] in map(int, ids2_), (len(set(ids2_)), roles["heads"]))
    s.check("hod-people: a leaver and an admin-role user are not in it", GONE not in map(int, ids2_) and NEWJ not in map(int, ids2_))
    r_, b_, ids3_ = panel_ids("lm-reports", q="ZZ AL Subject 1", qin="name")
    s.check("lm-reports: Search in narrows the rows but not the title's count",
            0 < len(set(ids3_)) < roles["reports"] and ("· %d" % roles["reports"]) in html.unescape(b_) and 'class="clp-search"' in b_,
            len(set(ids3_)))
    s.check("an unknown person is a 404", sup.get("/admin/list/lm-reports?fragment=1&uid=99999999").status_code == 404 and
            sup.get("/admin/list/hod-people?fragment=1").status_code == 404)
    s.section("the lists' 'This cycle' column reads participation() for every row, from one query (Chris, 2026-11-06)")
    with a.app.app_context():
        d = a.get_db()
        _PART0["min"] = d.execute("SELECT min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone()[0]
        _PART0["active"] = [r[0] for r in d.execute("SELECT id FROM cycles WHERE is_active=1")]
        d.execute("UPDATE cycles SET min_job_grade=12 WHERE id=?", (CID,))
        U2 = d.execute("SELECT id FROM users WHERE employee_id='ZZAL-U2'").fetchone()[0]
        d.execute("UPDATE users SET job_grade='5' WHERE id=?", (S[0],))                       # below the floor
        d.execute("UPDATE users SET job_grade='H' WHERE id=?", (S[1],))                       # Grade H
        d.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,'remove')", (CID, S[2]))   # taken out
        d.execute("INSERT INTO cycle_exclusions(cycle_id, business_group, company, department) VALUES (?,?,?,'')",
                  (CID, BG, CO + " 2"))                                                       # U2's unit left out
        d.execute("UPDATE users SET years_of_service=0, confirmation_date=NULL WHERE id IN (?,?)", (S[3], S[4]))   # not confirmed
        d.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,'add')", (CID, S[4]))    # ...but added
        d.commit()

    def cells_of(key):
        """{user id: (tone, pill text)} from the panel, plus the header row's text. (A super admin's lm-reports while the cycle runs is the
        TEAM panel since 2026-11-09, tests/test_lm_team.py: this is today's list, the one after the cycle closes, so the cycle is marked
        closed for the read.)"""
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("UPDATE cycles SET closed_at=datetime('now') WHERE id=?", (CID,))
            d_.commit()
        try:
            b = html.unescape(sup.get("/admin/list/%s?fragment=1&uid=%d" % (key, BOSS)).get_data(as_text=True))
        finally:
            with a.app.app_context():
                d_ = a.get_db()
                d_.execute("UPDATE cycles SET closed_at=NULL WHERE id=?", (CID,))
                d_.commit()
        out = {}
        for tr in re.findall(r'<tr class="data-row".*?</tr>', b, re.S):
            m = re.search(r'data-person-open="(\d+)"', tr)
            pill = re.search(r'<span class="clp-pill is-(\w+)"[^>]*>(.*?)</span>', tr, re.S)
            out[int(m.group(1))] = (pill.group(1), pill.group(2).strip()) if pill else None
        return out, re.search(r"<thead>.*?</thead>", b, re.S).group(0), b

    def want_of(d, cyc, uid):
        row = d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        taking, why = a.participation(d, row, cyc)
        if why == "below_min_grade" and a.is_grade_h(row):   # a letter grade is "below" any floor; the list names Grade H
            why = "grade_h"
        if taking:
            return ("ok", "Taking part")
        short = {"below_min_grade": "below JG %s" % cyc["min_job_grade"], "grade_h": "Grade H Appraisal", "unit_out": "unit left out",
                 "removed": "taken out", "not_confirmed": "not confirmed", "role": "user role"}[why]
        return ("off", "Not taking part · " + short)

    def disagree(got, want):
        return {u: (got.get(u), w) for u, w in want.items() if got.get(u) != w}

    got, head, body = cells_of("lm-reports")
    with a.app.app_context():
        d = a.get_db()
        cyc = d.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()
        want = {u: want_of(d, cyc, u) for u in got}
    s.check("lm-reports: the This cycle heading is there, Dept and JG are not columns any more",
            ">This cycle<" in head and ">Dept<" not in head and 'data-full="Department"' not in head and ">JG<" not in head
            and len(re.findall(r"<th[ >]", head)) == 4, head)
    s.check("lm-reports: every row's cell agrees with participation()", got and not disagree(got, want), disagree(got, want))
    kinds = {w[1] for w in want.values()}
    s.check("lm-reports: the fixture covers taking part, below the grade, Grade H, taken out and a left-out unit",
            {"Taking part", "Not taking part · below JG 12", "Not taking part · Grade H Appraisal",
             "Not taking part · taken out", "Not taking part · unit left out"} <= kinds, kinds)
    s.check("lm-reports: the specific people read right (S0 below, S1 Grade H, S2 taken out, U2 unit, S4 added in)",
            got[S[0]][1].endswith("below JG 12") and got[S[1]][1].endswith("Grade H Appraisal") and got[S[2]][1].endswith("taken out")
            and got[U2][1].endswith("unit left out") and got[S[4]] == ("ok", "Taking part"), [got[x] for x in (S[0], S[1], S[2], U2, S[4])])
    s.check("lm-reports: the cell carries the whole reason on hover", 'title="Not taking part: taken out by an admin"' in body)
    # falsify the agreement check once: a cell that says the wrong thing must be caught
    bad = dict(got)
    bad[S[0]] = ("ok", "Taking part")
    s.check("falsify: the agreement check catches a wrong cell", S[0] in disagree(bad, want), disagree(bad, want))
    got2, head2, _b2 = cells_of("hod-people")
    with a.app.app_context():
        d = a.get_db()
        want2 = {u: want_of(d, cyc, u) for u in got2}
    s.check("hod-people: the same column, every row agrees with participation()", got2 and not disagree(got2, want2) and
            ">This cycle<" in head2 and ">Dept<" not in head2, disagree(got2, want2))
    # the column is one batched read: the list's own query adds it, and participation() is never called per row
    calls = []
    _orig_part = a.participation
    a.participation = lambda *x, **k: (calls.append(1), _orig_part(*x, **k))[1]
    try:
        cells_of("lm-reports")
    finally:
        a.participation = _orig_part
    s.check("the list never calls participation() per row", not calls, len(calls))
    # no active cycle, no column
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE cycles SET is_active=0")
        d.commit()
    try:
        r_ = sup.get("/admin/list/lm-reports?fragment=1&uid=%d" % BOSS)
        b0 = html.unescape(r_.get_data(as_text=True))
        s.check("no active cycle: the list still opens, with no This cycle column and no pills",
                r_.status_code == 200 and "This cycle" not in b0 and "clp-pill" not in b0 and "<colgroup>" in b0 and
                len(re.findall(r'data-person-open="\d+"', b0)) > 0 and len(re.findall(r"<th[ >]", re.search(r"<thead>.*?</thead>", b0, re.S).group(0))) == 3,
                r_.status_code)
    finally:
        with a.app.app_context():
            d = a.get_db()
            for cid_ in _PART0["active"]:
                d.execute("UPDATE cycles SET is_active=1 WHERE id=?", (cid_,))
            d.commit()
    pg = sup.get("/admin/users/%d" % BOSS).get_data(as_text=True)
    for key in ("lm-reports", "hod-people"):
        opens = [html.unescape(x) for x in re.findall(r'data-list-open="([^"]*/admin/list/%s\?[^"]*)"' % key, pg)]
        s.check("super admin's person page: %s opens in the chip and in the Roles panel" % key,
                len(opens) == 2 and all(("uid=%d" % BOSS) in x and "fragment=1" in x for x in opens), opens)
    s.check("the chips are links; the page carries the list panel", 'class="pp-role is-lm is-link"' in pg and 'class="pp-role is-hod is-link"' in pg
            and 'data-panel="list"' in pg)
    if BGA:
        bc = H.client_as(a, BGA["id"])
        s.check("a BG admin can't open lm-reports or hod-people (403)", all(
            bc.get("/admin/list/%s?fragment=1&uid=%d" % (k_, BOSS)).status_code == 403 for k_ in ("lm-reports", "hod-people")))
        with a.app.app_context():
            d = a.get_db()
            BGA0 = d.execute("SELECT admin_bg FROM users WHERE id=?", (BGA["id"],)).fetchone()[0]
            d.execute("UPDATE users SET admin_bg=? WHERE id=?", (BG, BGA["id"]))
            d.commit()
        try:
            r_ = bc.get("/admin/users/%d" % BOSS)
            pg2 = r_.get_data(as_text=True)
            s.check("a BG admin sees the chips as plain text, no list links", r_.status_code == 200 and "LM of" in pg2 and
                    "data-list-open" not in pg2 and 'class="pp-role is-lm"' in pg2, r_.status_code)
        finally:
            with a.app.app_context():
                d = a.get_db()
                d.execute("UPDATE users SET admin_bg=? WHERE id=?", (BGA0, BGA["id"]))
                d.commit()
    else:
        s.note("no BG-scoped admin in the fixture: the 403 and the plain-text checks are not run")
    css = open(os.path.join(H.REPO, "static", "style.css")).read()
    # the Roles panel is itself a side panel: admin.js skips a [data-list-open] inside one unless it opts in, so without
    # the opt-in the click fell through to a GET that lands back on this page and no list opened (6 Nov QC)
    s.check("the Roles panel's two counts opt in to opening the list from inside a panel",
            pg.count('class="pp-count" data-list-from-panel') == 2, pg.count('class="pp-count"'))
    _js = open(os.path.join(H.REPO, "static", "admin.js")).read()
    s.check("admin.js honours data-list-from-panel, and never from inside the list panel itself",
            'lo.hasAttribute("data-list-from-panel") && lo.closest(".adm-panel") !== find("list")' in _js)
    s.check("the clickable chip never underlines (text-decoration: none on the link)", "a.pp-role.is-link, a.pp-count { text-decoration: none" in css)
finally:
    with a.app.app_context():
        d = a.get_db()
        if _PART0:   # the 'This cycle' section's changes to the cycle: put back
            d.execute("UPDATE cycles SET min_job_grade=? WHERE id=?", (_PART0["min"], CID))
            d.execute("DELETE FROM cycle_exclusions WHERE business_group=?", (BG,))
            d.execute("UPDATE cycles SET is_active=0")
            for cid_ in _PART0["active"]:
                d.execute("UPDATE cycles SET is_active=1 WHERE id=?", (cid_,))
            d.commit()
        _cleanup(d)
        d.execute("DELETE FROM app_settings WHERE key IN ('panel_size','min_valid','tiers','assessor_cap')")
        for k, v in SETTINGS0.items():
            d.execute("INSERT INTO app_settings(key, value) VALUES (?,?)", (k, v))
        d.execute("DELETE FROM activity_log WHERE action='settings' AND detail LIKE '%ZZAL test%'")
        d.commit()

sys.exit(s.done())
