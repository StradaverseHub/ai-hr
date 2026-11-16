"""Dashboard-first IA redesign (2026-08-29): the /hub all-modules page is retired,
the dashboard is the one home, the guided-review CHAT is the during-cycle to-do
surface (it replaces "Needs you"), and a Leadership zone on the dashboard carries
the senior doors the Hub used to.

The suite is built around the invariant a mistake here would breach: NOTHING IS
ORPHANED. Every personal surface that matters out of cycle, and every leadership
door a person still holds, must be reachable from the dashboard -- and the chat,
which had no entry point at all before this, must now be reachable. Doors are
asserted against the SAME predicates that gate them, so dropping any door fails
the suite.
"""
import html as _html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Nav redesign -- dashboard-first, chat during cycle, Hub retired")
SU, _BG, EMP = H.actors(a)


def dash_html(uid):
    return H.client_as(a, uid).get("/dashboard").get_data(as_text=True)


with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    PMPID = a.active_pm_period_id(db)
s.check("there is an active cycle to test against", CID is not None, CID)

# The local repo DB happens to have `review` switched off; on staging it is on.
# Force it ON so the chat-entry path is exercised (the "replaces Needs you"
# section toggles it off again to prove the fallback).
with a.app.app_context():
    _db = a.get_db()
    _db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='review'", (CID,))
    _db.commit()

# ---------------------------------------------------------------------------
s.section("the Hub is retired -- redirects, endpoint kept, templates gone")
c = H.client_as(a, EMP["id"])
r = c.get("/hub")
s.check("/hub redirects to /dashboard",
        r.status_code in (301, 302) and "/dashboard" in r.headers.get("Location", ""),
        (r.status_code, r.headers.get("Location")))
rg = c.get("/hub/calibration")
s.check("/hub/<group> redirects to /dashboard",
        rg.status_code in (301, 302) and "/dashboard" in rg.headers.get("Location", ""),
        (rg.status_code, rg.headers.get("Location")))
with a.app.test_request_context("/"):
    s.check("url_for('hub') still resolves (the harness shim depends on it)",
            a.url_for("hub") == "/hub", None)
tdir = os.path.join(H.HARNESS, "templates")
s.check("hub.html deleted", not os.path.exists(os.path.join(tdir, "hub.html")))
s.check("hub_group.html deleted", not os.path.exists(os.path.join(tdir, "hub_group.html")))
# No template references the retired page.
bad = []
for fn in os.listdir(tdir):
    if fn.endswith(".html"):
        t = open(os.path.join(tdir, fn), encoding="utf-8").read()
        if "url_for('hub')" in t or 'url_for("hub")' in t or "url_for('hub_group'" in t \
           or "All modules" in t:
            bad.append(fn)
s.check("no template links the retired Hub or an 'All modules' tab", not bad, bad)

# ---------------------------------------------------------------------------
s.section("the chat finally has an entry point (it had NONE before)")
with a.app.app_context(), a.app.test_request_context("/"):
    from flask import session
    session["user_id"] = EMP["id"]
    rv = a.dash_review_summary(a.get_db(), dict(EMP))
s.check("dash_review_summary is not None for an employee in an active cycle",
        rv is not None, rv)
html = dash_html(EMP["id"])
s.check("the dashboard links /review", 'href="/review"' in html, "/review" in html)
rr = c.get("/review")
s.check("GET /review is reachable (200 or a redirect, not the old 404 orphan)",
        rr.status_code in (200, 302), rr.status_code)
# The Dashboard|Check-in nav toggle was REMOVED from the dashboard (2026-09-07, Chris):
# the "Your review" card CTA (href="/review", asserted above) is the dashboard's entry
# into the review; the toggle now lives only in the /review rail.
s.check("the dashboard no longer renders the Dashboard|Check-in nav toggle",
        'id="nav-review"' not in html and 'id="nav-dashboard"' not in html, html[:0])

# ---------------------------------------------------------------------------
s.section("the AI+ module cards replace 'Your review' + 'Leadership'")


def on_journey(uid):
    """Is this person on the unified journey? There the AI+ PM·TM·IDP card is the review panel (2026-10-08)."""
    with a.app.test_request_context("/"):
        from flask import session as _s
        _s["user_id"] = uid
        _u = a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        return bool(a._review_unified_on(_u))


EMP_J = on_journey(EMP["id"])
if EMP_J:
    s.check("on the unified journey, the You are here card is on the page (the cycle-journey dashboard, 2026-10-09)",
            'class="od-card od-here' in html and "AI+ PM·TM·IDP" not in html, None)
else:
    s.check("off the journey, the You are here card still leads, listing what is open", 'class="od-card od-here' in html, None)
s.check("...the old 'Your review' / 'Needs you' / 'Leadership' headings are gone",
        "Your review" not in html and "Needs you" not in html
        and ">Leadership<" not in html and "Leadership</h2>" not in html, None)
s.check("card 3 'AI+ LMS' Coming soon shows for everyone",
        "AI+ LMS" in html and "Coming soon" in html, None)
s.check("the 'Your team' card is removed",
        ">Your team<" not in html and "Your team</h2>" not in html, None)
s.check("'Where you stand' and 'Your history' are on the page (the one-page dashboard, 2026-10-08)",
        "Where you stand" in html and "Your history" in html, None)
# Review OFF -> card 1 is still present; the per-stage tasks fold into its popout,
# and there is no /review link (the journey is gated off).
with a.app.app_context():
    db = a.get_db()
    db.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) "
               "VALUES (?, 'review', 0)", (CID,))
    db.commit()
off = dash_html(EMP["id"])
s.check("review off -> the dashboard is the record view: no You are here card and no fallback to-do list of classic "
        "pages (Chris, 2026-10-10: 'drop the fallback links')",
        'class="od-card od-here' not in off and 'class="od-todo"' not in off and 'class="od-card od-res"' in off, None)
s.check("review off -> no /review link and no Review nav segment",
        'href="/review"' not in off and 'id="nav-review"' not in off, None)
with a.app.app_context():
    db = a.get_db()
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='review'", (CID,))
    db.commit()

# ---------------------------------------------------------------------------
s.section("nothing orphaned: the personal record & tools are on the dashboard")
html = dash_html(EMP["id"])
# My performance is the history panel, and the plan, the 360 and the full record open in the right-hand panel
# (Chris, 2026-10-09: "all should point to our new look/view, none should link to the old modular view"). So the
# personal doors are panels now, each iff its module is on, and none of the classic pages is linked.
# Log evidence is off the dashboard (Chris, 2026-10-09: "remove log evidence") -- asserted absent below
with a.app.app_context(), a.app.test_request_context("/"):
    db = a.get_db()
    _panels = [("plan", a.cycle_module_on("idp", db)), ("report", a.cycle_module_on("tm", db))]
    _classic = [a.url_for(ep) for ep in ("my_report", "idp_view", "review_history", "my_profile")]
for key, on in _panels:
    shown = ('class="od-tcard" data-panel="%s"' % key) in html
    s.check("the dashboard's %s tool opens the panel iff its module is on (on=%s)" % (key, on), shown == on, (shown, on))
_linked = [u_ for u_ in _classic if ('href="%s"' % u_) in html or ('href="%s?' % u_) in html]
s.check("...and links none of the classic personal pages (%s)" % ", ".join(_classic), not _linked, _linked)

# ---------------------------------------------------------------------------
s.section("the record lists past cycles only; the tools in three groups, one full-record link (the UX review's "
          "F11-F12, 2026-10-08)")
with a.app.test_request_context("/"):
    from flask import session as _rs
    _rs["user_id"] = EMP["id"]
    _rdb = a.get_db()
    _rec = a.dash_record(_rdb, dict(_rdb.execute("SELECT * FROM users WHERE id=?", (EMP["id"],)).fetchone()))
_past = [r for r in _rec if not r["open"]]
_open_names = [r["name"] for r in _rec if r["open"]]
_ti = html.find('class="od-rows"'); _tbl = html[_ti:html.find("</section>", _ti)] if _ti >= 0 else ""
if _past:
    s.check("with a past cycle the history lists past cycles only, by year (2026-10-14), each opening the full record "
            "at that year (F11, 2026-10-08)",
            _tbl != "" and all(n not in _tbl for n in _open_names)
            and ('data-arg="%s"' % _past[0]["year"] if _past[0].get("year") else _past[0]["name"]) in _tbl
            and 'class="od-row od-yrow" data-panel="records"' in _tbl, (_open_names, [r["name"] for r in _past][:3]))
else:
    s.check("with no past cycle there's no list, just a line saying past cycles appear here (F11)",
            _ti < 0 and "Your past cycles appear here once you have one" in html, [r["name"] for r in _rec])
s.check("no Training / Movement columns while neither has a source (F11)", "no source yet" not in html)
with a.app.app_context(), a.app.test_request_context("/"):
    _mdb = a.get_db()
    _ev, _pl = a.cycle_module_on("evidence", _mdb), a.cycle_module_on("idp", _mdb)
    _hi = any(a.cycle_module_on(m, _mdb) for m in ("pm", "tm", "review"))
s.check("the tools are 'Your tools', each shown iff its module is on, and no Log evidence (Chris, 2026-10-09)",
        ">Your tools<" in html and "Your record &amp; tools" not in html
        and "<span>Log evidence</span>" not in html and ('href="/evidence"' not in html)
        and ("<b>Career Plan</b>" in html) == _pl, (_ev, _pl, _hi))
s.check("...the links say what they open, without the overlapping '& history' names (F12)",
        "My 360 report &amp; history" not in html and "My performance &amp; history" not in html
        and "My review history" not in html)
_body = html[html.find('class="od"'):]
s.check("...at most ONE full-record link on the page, the history card's own, there iff it has a cycle (F12)",
        _body.count("Full record &rarr;") == (1 if _ti >= 0 else 0) and "My full record" not in _body, _ti)
s.check("...and the account menu's My record opens that panel, not the classic /me page (2026-10-09)",
        'href="/dashboard?panel=records" role="menuitem">My record</a>' in html and 'href="/me"' not in html, None)
s.check("the route hands the history the past cycles, and this one only once something of it is released",
        'for r in record if (not r["open"]) or _record_released(r)]' in H.source(a)
        and "record=past[:4], record_total=len(past)," in H.source(a))

# ---------------------------------------------------------------------------
s.section("find a calibration leader, a team-only manager, and a plain employee")
with a.app.app_context():
    db = a.get_db()
    calib_holder = None
    team_only = None
    plain = None
    for u in db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL "
                        "LIMIT 400").fetchall():
        with a.app.test_request_context("/"):
            doors = a.dash_leadership(db, dict(u))
        cal = [d for d in doors if d.get("group") == "calibration"]
        team = [d for d in doors if d.get("group") == "team"]
        if cal and calib_holder is None:
            calib_holder = (dict(u), doors)
        if team and not cal and team_only is None:
            team_only = (dict(u), doors)
        if not doors and plain is None:
            plain = dict(u)
        if calib_holder and team_only and plain:
            break
if calib_holder is None:
    # an HOD's review is the AI+ Dept Review card now (2026-09-30), so a calibration door belongs to a BU CEO / BG CEO:
    # look for one among the tier-holders, if the first rows had none
    with a.app.app_context():
        db = a.get_db()
        for u in db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND "
                            "(COALESCE(buceo_company,'')!='' OR COALESCE(bgceo_bg,'')!='') LIMIT 50").fetchall():
            with a.app.test_request_context("/"):
                doors = a.dash_leadership(db, dict(u))
            if any(d.get("group") == "calibration" for d in doors):
                calib_holder = (dict(u), doors)
                break
holder = calib_holder or team_only
s.check("a calibration leader exists in the data", calib_holder is not None)
s.check("a plain employee (no leadership doors) exists", plain is not None)

# ---------------------------------------------------------------------------
s.section("card 2 (AI+ Calibration) shows only to a calibration leader")
with a.app.test_request_context("/"):
    _promo = a.url_for("promotion_nomination")   # no AI+ version: never linked (Chris, 2026-10-10: "drop those three")
if calib_holder:
    hu, doors = calib_holder
    hhtml = dash_html(hu["id"])
    # A leader's doors are reached ONLY through the AI+ journey (Chris, 2026-10-10: "drop the fallback links, point them
    # to the AI+ journey"): a door with a chat seat opens that, on the rail or under You lead; one without (outside
    # Year-End, a BU CEO's own Talent Box page) isn't linked at all.
    with a.app.test_request_context("/dashboard"):
        from flask import session as _sess
        _sess["user_id"] = hu["id"]
        _chat = a.dash_calib_chat_urls(a.get_db(), hu)
    _classic = [d["url"] for d in doors if ('href="%s"' % d["url"]) in hhtml]
    _ai_missing = [_chat[d["url"]] for d in doors if _chat.get(d["url"]) and d.get("group") == "calibration"
                   and ('href="%s"' % _chat[d["url"]].replace("&", "&amp;")) not in hhtml]
    s.check("a calibration leader's dashboard links no classic leadership page -- each door with an AI+ seat opens that",
            not _classic and not _ai_missing, (_classic, _ai_missing))
    s.check("...the AI+ Calibration row shows exactly when the chat has a seat for them",
            ("AI+ Calibration" in hhtml or "AI+ Talent Box" in hhtml or "AI+ Dept Review" in hhtml) == bool(_chat)
            or not _chat, sorted(_chat.values())[:3])
    s.check("...and Promotion nomination is not linked from the dashboard", ('href="%s"' % _promo) not in hhtml)
if team_only:
    tu, tdoors = team_only
    thtml = dash_html(tu["id"])
    s.check("a team-only manager (no calibration tier) sees NO 'AI+ Calibration' card",
            "AI+ Calibration" not in thtml, None)
    tclassic = [d["url"] for d in tdoors if ('href="%s"' % d["url"]) in thtml]
    s.check("...and none of their team doors' classic pages is linked: the AI+ team review is the way in",
            not tclassic, tclassic)

# ---------------------------------------------------------------------------
s.section("the door set matches the predicates (drop a door -> this fails)")
if holder:
    hu, doors = holder
    urls = {d["url"] for d in doors}
    with a.app.app_context(), a.app.test_request_context("/"):
        db = a.get_db()
        tiers = a.calibration_tier_of(db, dict(hu))
        pf = a._pm_entry_flags(db, dict(hu), PMPID) if PMPID else {}
        _ho, is_tc_mgr, _aw = a._hub_tc_flags(db, dict(hu), CID)
        can_reward = a._hub_can_reward(db, dict(hu))
        can_nom = a._hub_can_nominate(db, dict(hu))
        calib_on = a.cycle_module_on("calibration", db)
        u_calib = a.url_for("calibration_home"); u_pmcalib = a.url_for("pm_calibration_home")
        u_reward = "/reward/"; u_promo = a.url_for("promotion_nomination")   # Reward's pages are deleted (2026-10-11)
        u_team = a.url_for("performance_team_view"); u_setrev = a.url_for("performance_kpi_setting_review")
        u_tcteam = a.url_for("technical_team_view")
    if any(t == "buceo" for t, _k in tiers) and calib_on:
        s.check("BU CEO tier-holder -> a calibration door present",
                (u_calib in urls) or (u_pmcalib in urls), urls)
    elif any(t == "hod" for t, _k in tiers) and calib_on:   # an HOD-only: the AI+ Dept Review card (2026-09-30)
        s.check("HOD-only tier-holder -> no Performance / Potential calibration door (the Dept Review card has it)",
                u_calib not in urls and u_pmcalib not in urls, urls)
    elif tiers and calib_on:   # a BG CEO only: the Talent Box is their calibration (2026-09-29)
        with a.app.test_request_context("/"):
            u_box = a.url_for("talent_box_home")
        s.check("BG CEO-only tier-holder -> the Talent Box door, no Performance / Potential door",
                u_box in urls and u_calib not in urls and u_pmcalib not in urls, urls)
    if can_reward:   # Reward archived 2026-10-08: no door, even for a BG CEO
        s.check("can_reward -> still NO Reward door (archived, its pages deleted)",
                not any(u_reward in (x or "") for x in urls), urls)
    if can_nom:   # Promotion archived 2026-10-13: no door, even for someone who could nominate
        s.check("can_nominate -> still NO Promotion door (archived)", u_promo not in urls, urls)
    if pf.get("approver") or pf.get("setting_review"):
        s.check("approver/setting-reviewer -> a team-performance door present",
                (u_team in urls) or (u_setrev in urls), urls)
    if is_tc_mgr:
        s.check("tc-manager -> Team competency review door present (R1)",
                u_tcteam in urls, urls)

# ---------------------------------------------------------------------------
s.section("a plain employee: card 1 + card 3, and no card 2")
if plain:
    phtml = dash_html(plain["id"])
    if on_journey(plain["id"]):
        s.check("plain employee on the journey sees the You are here card",
                'class="od-card od-here' in phtml and "AI+ PM·TM·IDP" not in phtml, None)
    else:
        s.check("plain employee off the journey still sees the You are here card", 'class="od-card od-here' in phtml, None)
    s.check("plain employee sees card 3 (AI+ LMS Coming soon)",
            "AI+ LMS" in phtml and "Coming soon" in phtml, None)
    s.check("plain employee sees NO 'AI+ Calibration' card",
            "AI+ Calibration" not in phtml, None)

# ---------------------------------------------------------------------------
s.section("the review panel and the team card read the journey's own parts (the UX review, 2026-10-08)")
with a.app.app_context():
    _db = a.get_db()
    _had = _db.execute("SELECT value FROM app_settings WHERE key='review_unified'").fetchone()
    _db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('review_unified', '1')")
    _db.commit()
try:
    with a.app.test_request_context("/dashboard"):
        from flask import session as _s
        _s["user_id"] = EMP["id"]
        _db = a.get_db()
        _u = _db.execute("SELECT * FROM users WHERE id=?", (EMP["id"],)).fetchone()
        _rv = a.dash_review_summary(_db, _u)
        _pn = a.dash_review_panel(_db, _u, _rv, None, None)
        _st = a.review_state(_db, _u)
        _live = {x["key"]: (x.get("short") or x.get("label")) for x in a._journey_live_stages(_st)}
        _kpi = a._journey_kpi_steps(_db, _u)
        _parts = [p for m in (_pn or {}).get("modules", []) for p in m["parts"]]
    s.check("the panel is built for someone on the journey, with its label from the journey's own title",
            _pn is not None and _pn["label"].startswith("Your ") and _pn["label"].endswith("Check-in"), _pn and _pn["label"])
    s.check("...every part it shows is a journey part, under the journey's own name (no 'Development Self-planning')",
            bool(_parts) and all(_live.get(p["key"]) == p["name"] for p in _parts)
            and "Development Self-planning" not in str(_pn) and "Career Profiling" not in str(_pn), [(p["key"], p["name"]) for p in _parts])
    _kp = next((p for p in _parts if p["key"] == "account"), None)
    s.check("...the KPI part counts what the journey's own KPI steps count (results keyed of keyable)",
            (_kp is None and not _kpi) or (_kp is not None and _kpi
             and _kp["count"] == "%d of %d results" % (_kpi[0]["keyed"], _kpi[0]["total"])), (_kp, _kpi and _kpi[0]))
    s.check("...exactly one part is 'your turn', and it is the part the journey would open",
            sum(1 for p in _parts if p["your_turn"]) <= 1
            and all(p["key"] == a._journey_active_stage(_st, None) for p in _parts if p["your_turn"]), None)
    # ...and on someone who HAS KPI lines (the employee above may have none, which would make that check vacuous)
    with a.app.test_request_context("/dashboard"):
        _db = a.get_db()
        _kr = _db.execute("SELECT u.* FROM users u WHERE u.left_at IS NULL AND u.role!='admin' AND " + a.no360_sql("u") + " AND u.id IN "
                          "(SELECT subject_id FROM pm_kpi_targets WHERE cycle_id=?) ORDER BY u.id LIMIT 1",   # (not Grade H: 2026-10-30)
                          (a.active_pm_period_id(_db),)).fetchone()
        _kp2 = _kk = None
        if _kr is not None:
            from flask import session as _s4
            _s4["user_id"] = _kr["id"]
            _pk = a.dash_review_panel(_db, _kr, a.dash_review_summary(_db, _kr), None, None)
            _kk = a._journey_kpi_steps(_db, _kr)
            _kp2 = next((p for m in (_pk or {}).get("modules", []) for p in m["parts"] if p["key"] == "account"), None)
    if _kr is not None and _kk:
        s.check("...on someone with KPI lines, the KPI part reads the journey's own count (not vacuous)",
                _kp2 is not None and _kp2["count"] == "%d of %d results" % (_kk[0]["keyed"], _kk[0]["total"])
                and _kp2["name"] == "KPI Check-in", (_kp2, _kk[0]))
    # the due line: a soft cycle deadline is 'Due' ahead and 'Was due' once passed -- never 'Closed' beside an open review
    with a.app.test_request_context("/"):
        _d1 = a._dash_due(a.get_db(), "account", "2099-12-31", 30)
        _d2 = a._dash_due(a.get_db(), "account", "2026-08-31", -38)
    s.check("the due line says 'Due' for a soft deadline ahead, 'Was due' once passed (never 'Closed')",
            _d1 in ("Due 31 Dec 2099",) or _d1.startswith("Closes "), (_d1, _d2))
    s.check("...", _d2 == "Was due 31 Aug 2026" or _d2.startswith("Closes "), _d2)
    ehtml = dash_html(EMP["id"])
    with a.app.test_request_context("/"):
        _hr = a.dash_here(_pn, None, [])
        _gd = a.get_db()
        # the guide panel's lead is the person's own deadline since the QC sweep (2026-10-24), or "nothing needs you"
        _lead = a.nav_cycle_pill(_gd, a.active_cycle(_gd), _gd.execute("SELECT * FROM users WHERE id=?",
                                                                       (EMP["id"],)).fetchone())["note"] \
            or "needs you right now"
    _act0 = (_hr["acts"] or [None])[0]
    s.check("the page draws it: the label, the next step (as the first thing that needs you) and the AI button -> /review",
            'class="od-card od-here' in ehtml and _lead.lower() in _html.unescape(ehtml).lower()   # the guide's lead
            and (_act0 is None or (_act0["title"] in ehtml and _act0["url"] == _pn["url"]))
            and ('href="/review"' in ehtml or not _pn["button"]), _act0)
    _solid = [c for c in re.findall(r'class="(od-btn-ai[^"]*)"', ehtml) if "is-outline" not in c]
    s.check("...the button says it opens the AI check-in (Start / Continue with / See your AI check-in summary) -- "
            "the ONE solid red button on the page (2026-10-08)",
            (not _pn["button"]) or (_pn["button"] in ("Start your AI check-in", "Continue with AI check-in",
                                                      "See your AI check-in summary")
                                    and _pn["button"] in ehtml and len(_solid) == 1),
            (_pn["button"], _solid))
    s.check("...and Coming soon is a line in the tools header", "AI+ LMS &middot; Coming soon" in ehtml, None)
    # a manager with a Team view: the team card splits each part by the Team view's own rows
    _mgr = None
    with a.app.app_context():
        for _r in a.get_db().execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL "
                                     "AND id IN (SELECT DISTINCT manager_id FROM users WHERE manager_id IS NOT NULL) "
                                     "LIMIT 60").fetchall():
            with a.app.test_request_context("/"):
                from flask import session as _s2
                _s2["user_id"] = _r["id"]
                if a._review_manages_team(a.get_db(), _r):
                    _mgr = _r
                    break
    if _mgr is not None:
        with a.app.test_request_context("/dashboard"):
            from flask import session as _s3
            _s3["user_id"] = _mgr["id"]
            _db = a.get_db()
            _rvm = a.dash_review_summary(_db, _mgr)
            _tc = a.dash_team_card(_db, _mgr, _rvm)
            _ok = True
            for _p in (_tc or {}).get("parts", []):
                _rows = a._journey_team_reports(_db, _mgr, _p["key"])
                _ok = _ok and len(_p["turn"]) == sum(1 for r in _rows if not r["done"] and r.get("action")) \
                    and len(_p["wait"]) == sum(1 for r in _rows if not r["done"] and not r.get("action")) \
                    and _p["done"] == sum(1 for r in _rows if r["done"]) and _p["total"] == len(_rows) \
                    and all("mode=detail" in t["url"] and "view=team" in t["url"] for t in _p["turn"])
        s.check("a manager's team card: each part's Your turn / Waiting / Done is the Team view's own split, and a "
                "Review link opens that person in the Team view", _tc is not None and _ok, _tc and [
                    (p["key"], len(p["turn"]), len(p["wait"]), p["done"]) for p in _tc["parts"]])
        mhtml = dash_html(_mgr["id"])
        _one = _tc["turn"] == 1
        _many = _tc["turn"] > 1
        s.check("...the page draws it as the rail's Team review step -> the Team view, and Your next step groups the "
                "team's reviews in one row (the calmer view, 2026-10-16): one review alone as 'Review with AI' on that "
                "person, several as 'Open team review' with a chip per part",
                'class="od-card od-rail' in mhtml and 'href="/review/journey?view=team"' in mhtml
                and ">Team review<" in mhtml and ((not _one) or "Review with AI" in mhtml)
                and ((not _many) or ("Open team review" in mhtml and mhtml.count('class="od-chip"')
                                     >= sum(1 for p in _tc["parts"] if p["turn"])))
                and "Move on to AI+ team review" not in mhtml, (_one, _many))
finally:
    with a.app.app_context():
        _db = a.get_db()
        if _had is None:
            _db.execute("DELETE FROM app_settings WHERE key='review_unified'")
        else:
            _db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('review_unified', ?)", (_had["value"],))
        _db.commit()

# ---------------------------------------------------------------------------
s.section("the dashboard as the cycle's journey: one rail, then what needs you (direction C, Chris 2026-10-09)")


def _rail_for(uid):
    """(panel, team, leaders, rail, here, html) for one person, built the way the dashboard route builds them."""
    with a.app.test_request_context("/dashboard"):
        from flask import session as _s5
        _s5["user_id"] = uid
        _d = a.get_db()
        _u = _d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        _rv = a.dash_review_summary(_d, _u)
        _p = a.dash_review_panel(_d, _u, _rv, None, None)
        _t = a.dash_team_card(_d, _u, _rv) if _p else None
        _cards = a.dash_cards(_d, _u, _rv, a.dash_leadership(_d, _u), None if _rv else a.dash_tasks(_d, _u))
        _l = [dict(c, dest=("AI+ Talent Box" if "stage=talent_box" in c["url"] else
                            "AI+ Dept Review" if c["key"] == "dept_review" else "AI+ Calibration"),
                   button="Move on to x") for c in _cards
              if c["key"] in ("dept_review", "calibration") and c.get("url")]
        return _p, _t, _l, a.dash_rail(_d, _u, _p, _t, _l), a.dash_here(_p, _t, _l)


_p, _t, _l, _rl, _hr = _rail_for(EMP["id"])
_own = [p for m in (_p or {}).get("modules", []) for p in m["parts"]]
if _rl:
    _names = [x["name"] for x in _rl["steps"]]
    s.check("the rail lists their own parts first, in the panel's order and names, then team, what they lead, "
            "and Results released last",
            _names[:len(_own)] == [p["name"] for p in _own] and _names[-1] == "Results released"
            and _rl["total"] == len(_rl["steps"]) and _rl["done"] == sum(1 for x in _rl["steps"] if x["state"] == "done"),
            _names)
    _turn = any(x["state"] == "turn" for x in _rl["steps"])
    s.check("...at most one step is 'you are here': their turn, or with nothing to do, where the cycle is "
            "(calibration or the release, 2026-10-12)",
            sum(1 for x in _rl["steps"] if x.get("here")) <= 1
            and all(x["state"] == "turn" if _turn else x["name"] in ("Calibration", "Results released")
                    for x in _rl["steps"] if x.get("here")), [(x["name"], x["state"]) for x in _rl["steps"]])
    with a.app.test_request_context("/"):
        _mid = a.cycle_is_mid_year(a.get_db(), a.active_cycle_id(a.get_db()))
    # Mid-Year has no calibration (Chris, 2026-10-12): the HOD's review leads straight to the release
    s.check("...and the cycle ends with Calibration, then Results released (2026-10-12, canvas boards T1-T2) -- at "
            "Year-End; at Mid-Year with Results released and no Calibration step",
            (_names[-1] == "Results released" and "Calibration" not in _names) if _mid
            else _names[-2:] == ["Calibration", "Results released"], (_mid, _names))
    _nx = (_p or {}).get("next")
    s.check("...the part the panel's button names is the rail's turn step (when it's open)",
            not _nx or not any(p["key"] == _nx and p["state"] == "open" for p in _own)
            or any(x["state"] == "turn" and x["name"] == next(p["name"] for p in _own if p["key"] == _nx)
                   for x in _rl["steps"]), (_nx, [(x["name"], x["state"]) for x in _rl["steps"]]))
    s.check("...a locked part is not a link; every other own part opens the journey on that part",
            all((x["url"] is None) == (x["state"] == "locked") for x in _rl["steps"][:len(_own)])
            and all("stage=" in x["url"] for x in _rl["steps"][:len(_own)] if x["url"]), None)
s.check("what needs you: their own check-in first (when it has a button and isn't done), worded from the panel's "
        "next step", (not _p or not _p.get("button") or _p.get("complete") or _p.get("not_required"))
        or (_hr["acts"] and _hr["acts"][0]["tag"] == "Your AI check-in" and _hr["acts"][0]["url"] == _p["url"]),
        _hr["acts"][:1])
# the results step follows the release
with a.app.app_context():
    _db = a.get_db()
    _pid = a.active_pm_period_id(_db)
    _had_rel = _db.execute("SELECT 1 FROM result_releases WHERE cycle_id=? AND subject_id=? AND kind='pm'",
                           (_pid, EMP["id"])).fetchone()
if _rl and _pid and not _had_rel:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("INSERT INTO result_releases(cycle_id, subject_id, kind) VALUES (?,?,'pm')", (_pid, EMP["id"]))
        _db.commit()
    try:
        _rl2 = _rail_for(EMP["id"])[3]
        s.check("...the Results released step is done once a result is released to them, 'Not yet' before",
                _rl["steps"][-1]["state"] == "later" and _rl2["steps"][-1]["state"] == "done", (_rl["steps"][-1], _rl2["steps"][-1]))
    finally:
        with a.app.app_context():
            _db = a.get_db()
            _db.execute("DELETE FROM result_releases WHERE cycle_id=? AND subject_id=? AND kind='pm'", (_pid, EMP["id"]))
            _db.commit()
# the page
_eh = dash_html(EMP["id"])
s.check("the page draws the rail and marks the step you're on for screen readers",
        (not _rl) or ('class="od-card od-rail' in _eh and _eh.count('aria-current="step"') == sum(1 for x in _rl["steps"] if x.get("here"))),
        None)
_solid_e = [c for c in re.findall(r'class="(od-btn-ai[^"]*)"', _eh) if "is-outline" not in c]
s.check("...one solid AI button at most, and it is the first thing that needs you",
        len(_solid_e) <= 1 and (not _hr["acts"] or len(_solid_e) == 1), _solid_e)
# a leader's step + act come from the leader row
if calib_holder:
    _lp, _lt, _ll, _lrl, _lhr = _rail_for(calib_holder[0]["id"])
    s.check("a leader's rail ends with what they lead, then the results; a row with something left is their turn "
            "and an action under You are here",
            _lrl and all(any(x["who"] == "You lead" and x["url"] == c["url"] for x in _lrl["steps"]) for c in _ll)
            and all((a._dash_lead_state(c) == "turn") == any(x["url"] == c["url"] for x in _lhr["acts"]) for c in _ll),
            [(c.get("sub"), c["url"]) for c in _ll])
# one Calibration step, not two (Chris, 2026-10-29): the leader's calibration row folds into the cycle's step
# (the data's active cycle may be a Mid-Year, which has no calibration step: put it at Year-End for this check, back after)
if calib_holder:
    with a.app.app_context():
        _d7 = a.get_db()
        _c7 = a.active_cycle_id(_d7)
        _half7 = _d7.execute("SELECT half FROM cycles WHERE id=?", (_c7,)).fetchone()["half"]
        _d7.execute("UPDATE cycles SET half=2 WHERE id=?", (_c7,)); _d7.commit()
    try:
        _lp, _lt, _ll, _lrl, _lhr = _rail_for(calib_holder[0]["id"])
        with a.app.test_request_context("/dashboard"):
            from flask import session as _s7
            _s7["user_id"] = calib_holder[0]["id"]
            _d7 = a.get_db()
            _u7 = _d7.execute("SELECT * FROM users WHERE id=?", (calib_holder[0]["id"],)).fetchone()
            _own7 = bool(_lp and _lp.get("own", True) and _lp.get("modules"))
            _raw7 = a._dash_rail_results(_d7, _u7, a.active_cycle_id(_d7) or a.active_pm_period_id(_d7), _own7,
                                         a._led_tabs(_d7, _u7))
        _lead_c = [c for c in _ll if a._DASH_LEAD_NAME.get(c.get("dest"), c.get("dest")) == "Calibration"]
        _res_c = [x for x in _raw7 if x["name"] == "Calibration"]
        # the guard is only tested where the inputs really make both steps (else the check would pass vacuously)
        s.check("the inputs make BOTH a leader Calibration row and the cycle's Calibration step (so the merge has work)",
                len(_lead_c) == 1 and len(_res_c) == 1, (len(_lead_c), len(_res_c)))
        if _lead_c and _res_c and _lrl:
            _nm = [x["name"] for x in _lrl["steps"]]
            _cs = [x for x in _lrl["steps"] if x["name"] == "Calibration"]
            s.check("a leader's rail has ONE Calibration step, right before Results released, and it opens their "
                    "calibration page", _nm.count("Calibration") == 1 and _nm[-2:] == ["Calibration", "Results released"]
                    and _cs[0]["url"] == _lead_c[0]["url"] and bool(_cs[0]["url"]), _nm)
            if a._dash_lead_state(_lead_c[0]) == "turn":
                s.check("...while people wait on them it is their turn and its short line names the count",
                        _cs[0]["state"] == "turn" and _cs[0]["short"] == _lead_c[0]["sub"]
                        and re.match(r"\d+ to calibrate", _cs[0]["short"]), (_cs[0]["state"], _cs[0]["short"]))
            else:
                s.check("...with their own part done it keeps the cycle's own state and line",
                        _cs[0]["state"] == _res_c[0]["state"] and _cs[0]["line"] == _res_c[0]["line"],
                        (_cs[0]["state"], _res_c[0]["state"]))
            s.check("...and it keeps the cycle step's who", _cs[0]["who"] == _res_c[0]["who"], (_cs[0]["who"], _res_c[0]["who"]))
    finally:
        with a.app.app_context():
            _d7 = a.get_db()
            _d7.execute("UPDATE cycles SET half=? WHERE id=?", (_half7, _c7)); _d7.commit()

# Where you stand asks a competency only of someone their own review asks it of
with a.app.test_request_context("/dashboard"):
    from flask import session as _s6
    _d = a.get_db()
    _cu = _d.execute("SELECT u.* FROM users u WHERE u.role!='admin' AND u.left_at IS NULL AND u.id IN "
                     "(SELECT subject_id FROM tc_assignments WHERE cycle_id=?) AND u.id NOT IN "
                     "(SELECT subject_id FROM tc_assessments WHERE cycle_id=? AND status IN ('submitted','reviewed')) "
                     "LIMIT 1", (CID, CID)).fetchone()
    if _cu is not None:
        _s6["user_id"] = _cu["id"]
        _ask = [x["key"] for x in a.dash_standing(_d, _cu, a.active_pm_period(_d), a.active_cycle(_d))]
        _no = [x["key"] for x in a.dash_standing(_d, _cu, a.active_pm_period(_d), a.active_cycle(_d), asked=False)]
if _cu is not None:
    s.check("Where you stand: an unsubmitted competency shows only when their own review asks it (a BG CEO isn't "
            "asked, 2026-10-05)", "competency" in _ask and "competency" not in _no, (_ask, _no))
s.check("the route passes whether their own review asks it, links leader rows only through the AI+ journey, and "
        "hands the page no team doors (2026-10-10)",
        'asked = ((review or {}).get("st") or {}).get("participant", True)' in H.source(a)
        and 'not _dash_ai_url(c.get("url"))' in H.source(a) and "team_doors=" not in H.source(a))

# the step you're on glows (Chris, 2026-10-14): a still halo plus a ripple, navy where the cycle is, AI red on your turn;
# the ripple animates transform + opacity only and pulses constantly; reduced motion keeps just the halo
_css_g = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
s.check("the rail's current step glows: a halo on its node, navy by default and AI red on your turn",
        ".od-step.is-here .od-node { position: relative; --od-glow: 37, 42, 89;" in _css_g
        and ".od-step.is-here.is-turn .od-node { --od-glow: 214, 25, 35; }" in _css_g
        and "0 0 14px 3px rgba(var(--od-glow), 0.30)" in _css_g)
_rip = re.search(r"@keyframes odHereRipple \{([^@]*?)\}\s*\n", _css_g)
s.check("...a ripple that animates only transform and opacity, pulsing constantly (Chris, 2026-10-14), never under reduced motion",
        ".od-step.is-here .od-node::after {" in _css_g and "opacity: 0; animation: odHereRipple 2.4s ease-out infinite; }" in _css_g
        and _rip is not None and "box-shadow" not in _rip.group(1) and "transform: scale(1.75)" in _rip.group(1)
        and "@media (prefers-reduced-motion: reduce) { .od-step.is-here .od-node::after { animation: none; opacity: 0; } }" in _css_g,
        _rip.group(1) if _rip else None)

sys.exit(s.done())
