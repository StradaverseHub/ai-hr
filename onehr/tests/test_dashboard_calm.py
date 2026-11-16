"""The calmer dashboard (Chris, 2026-10-16: "Go with option B with a calmer view"; the "OneHR Dashboard, Calmer"
canvas, board B).

What this suite holds:
  * Your next step is ONE thing -- their own check-in, else the first other thing -- with the page's one solid button;
    everything else is a compact row with an outline button
  * the team's reviews are ONE row: "Your team · N reviews waiting on you", a chip per part whose counts add up to N;
    a single review goes straight to that person ("Review with AI"), several to the Team view ("Open team review")
  * the acts list the guide reads is unchanged (one act per team part), so the guide and the card can't drift apart
  * the rail's one short line: a step to do shows its count, a team or leader step its waiting count, anything else
    its state word; the whole "word · line" is the tooltip. The rail's head says when the cycle closes
  * Where you stand is label and value only: the helper line is the row's tooltip, a panel value is the link itself
  * the page itself: the rail's title is the cycle alone, "Details" opens this cycle, one solid button in the card

The model checks run on synthetic dicts; the page checks render real dashboards from the suite database (counts and
markup only). The cycle's ends_on is changed for one check and put back.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The calmer dashboard -- one next step, the team grouped, a quiet rail")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BG, EMP = H.actors(a)

OWN = {"tag": "Your AI check-in", "title": "Write your overall remark", "sub": "It goes to your manager", "due": "Due 31 Dec",
       "button": "Continue with AI check-in", "url": "/review", "aria": None, "kind": "own"}
LEAD = {"tag": "You lead", "title": "Department review", "sub": "2 to submit", "due": "", "button": "Move on to x",
        "url": "/review/journey?view=dept", "aria": None, "kind": "lead"}
APPR = {"tag": "Your team", "title": "3 people's KPIs to approve", "sub": "", "due": "", "button": "Review their KPIs",
        "url": "/performance/setting/review", "aria": None, "ai": False, "kind": "approve"}


def person(n, part):
    return {"name": "Person %02d" % n, "meta": "", "action": "Review with AI",
            "url": "/review/journey?view=team&stage=%s&mode=detail&report=%d" % (part, n)}


def team_of(counts):
    """A team card with {part key: people waiting on the manager}."""
    names = {"pm_review": "KPI Review", "tc_review": "Competency Review", "plan_review": "Plan Review"}
    parts = [{"key": k, "name": names[k], "turn": [person(i, k) for i in range(n)], "wait": [], "done": 0, "total": n,
              "url": "/review/journey?view=team&stage=%s" % k} for k, n in counts.items()]
    return {"people": 9, "turn": sum(counts.values()), "parts": parts, "url": "/review/journey?view=team"}


# ---------------------------------------------------------------------------
s.section("Your next step: one thing, then compact rows")
T = team_of({"pm_review": 8, "tc_review": 17, "plan_review": 8})
c = a._dash_calm([OWN, LEAD], T)
s.check("their own check-in is the next step", c["next"]["title"] == OWN["title"] and c["next"]["kind"] == "own")
s.check("...then the team as ONE row, then what they lead", [x["kind"] for x in c["rest"]] == ["team", "lead"],
        [x["kind"] for x in c["rest"]])
solid = [x for x in [c["next"]] + c["rest"] if x["solid"]]
s.check("only the next step is solid", solid == [c["next"]], [x["title"] for x in solid])
g = c["rest"][0]
s.check("the team row counts every review waiting on them", g["title"] == "Your team · %d reviews waiting on you"
        % T["turn"], g["title"])
s.check("...a chip per part, 'review' dropped, its count that part's", [(x["name"], x["n"]) for x in g["chips"]]
        == [("KPI", 8), ("Competency", 17), ("Plan", 8)], g["chips"])
s.check("...the chips add up to the row's count", sum(x["n"] for x in g["chips"]) == T["turn"])
s.check("...each chip opens its part in the Team view", all(x["url"].startswith("/review/journey?view=team&stage=")
                                                            for x in g["chips"]))
s.check("...several reviews: 'Open team review' to the Team view", g["button"] == "Open team review"
        and g["url"] == T["url"])
s.check("the inputs are not changed (the guide reads the same acts)", "solid" not in OWN and "solid" not in LEAD)

T1 = team_of({"tc_review": 1})
c1 = a._dash_calm([], T1)
s.check("no check-in of their own: the team row is the next step, solid", c1["next"]["kind"] == "team"
        and c1["next"]["solid"] and c1["rest"] == [], c1)
s.check("...one review: 'Review with AI', straight to that person",
        c1["next"]["button"] == "Review with AI" and c1["next"]["url"] == T1["parts"][0]["turn"][0]["url"]
        and c1["next"]["title"] == "Your team · 1 review waiting on you", c1["next"])
c2 = a._dash_calm([APPR, LEAD], None)
s.check("an approver: the approval first (navy, not AI), then the leader row", c2["next"]["kind"] == "approve"
        and c2["next"].get("ai") is False and [x["kind"] for x in c2["rest"]] == ["lead"])
c3 = a._dash_calm([], None)
s.check("nothing to do: no next step", c3 == {"next": None, "rest": []}, c3)
c4 = a._dash_calm([dict(OWN), {"kind": "team", "title": "Person 01"}], team_of({}))
s.check("a team with nobody waiting on them adds no row (the per-part acts are the guide's, never rows)",
        c4["rest"] == [] and c4["next"]["kind"] == "own", c4)

with a.app.test_request_context("/"):
    h = a.dash_here(None, T, [])
s.check("dash_here still lists one act per team part for the guide, and gives the card its calm view",
        [x["kind"] for x in h["acts"]] == ["team", "team", "team"] and h["calm"]["next"]["kind"] == "team"
        and h["calm"]["rest"] == [], ([x["kind"] for x in h["acts"]], h["calm"]["next"]["title"]))

# ---------------------------------------------------------------------------
s.section("the rail's one short line")
cases = [
    ({"state": "open", "who": "You", "line": "0 of 2 colleagues"}, "0 of 2 colleagues"),
    ({"state": "open", "who": "You", "line": ""}, "To do"),
    ({"state": "turn", "who": "You", "line": "2 of 2 results"}, "Your turn"),
    ({"state": "turn", "who": "Your team", "line": "33 waiting on you"}, "33 waiting"),
    ({"state": "turn", "who": "You lead", "line": "2 to submit"}, "2 to submit"),
    ({"state": "locked", "who": "You", "line": "Opens once your KPI check-in is in"}, "Locked"),
    ({"state": "progress", "who": "All results", "line": "Results are being calibrated"}, "In progress"),
    ({"state": "later", "who": "HR", "line": "to you first", "word": "Not yet"}, "Not yet"),
    ({"state": "closed", "who": "You", "line": "x", "word": "Not this cycle"}, "Not this cycle"),
]
bad = [(st, a._dash_step_short(st)) for st, want in cases if a._dash_step_short(st)[0] != want]
s.check("each state's short line", not bad, bad)
s.check("...and the tooltip is the whole 'word · line'",
        a._dash_step_short({"state": "turn", "who": "Your team", "line": "33 waiting on you"})[1]
        == "Your turn · 33 waiting on you")

# ---------------------------------------------------------------------------
s.section("the page")
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    _ends = db.execute("SELECT ends_on FROM cycles WHERE id=?", (CID,)).fetchone()[0] if CID else None
    _rev = db.execute("SELECT active FROM cycle_modules WHERE cycle_id=? AND module_key='review'", (CID,)).fetchone()
    _uni = db.execute("SELECT value FROM app_settings WHERE key='review_unified'").fetchone()
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='review'", (CID,))
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('review_unified', '1')")
    db.commit()


def ctx_of(uid):
    with a.app.test_request_context("/"):
        db = a.get_db()
        return a._dash_context(db, db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def card(html, cls):
    m = re.search(r'<section class="od-card %s[^"]*".*?</section>' % cls, html, re.S)
    return m.group(0) if m else ""


try:
    # someone with a running dashboard and something to do
    with a.app.app_context():
        cands = [r[0] for r in a.get_db().execute(
            "SELECT id FROM users WHERE role!='admin' AND left_at IS NULL ORDER BY id LIMIT 80").fetchall()]
    who = None
    for uid in cands:
        cx = ctx_of(uid)
        if cx.get("mode") == "running" and cx.get("panel") and (cx.get("here") or {}).get("calm", {}).get("next"):
            who, CX = uid, cx
            break
    s.check("found someone with a running dashboard and a next step", who is not None, len(cands))
    if who:
        html = H.client_as(a, who).get("/dashboard").get_data(as_text=True)
        here = card(html, "od-here")
        N = CX["here"]["calm"]["next"]
        s.check("the card says 'Your next step' and names it", "Your next step" in here
                and N["title"] in here, N["title"])
        _solid = [x for x in re.findall(r'class="(od-btn-(?:ai|nv)[^"]*)"', here) if "is-outline" not in x]
        s.check("...one solid button in the card", len(_solid) == 1, _solid)
        s.check("...a row per other thing", here.count('class="od-nrow"') == len(CX["here"]["calm"]["rest"]),
                (here.count('class="od-nrow"'), len(CX["here"]["calm"]["rest"])))
        rail = card(html, "od-rail")
        s.check("the rail's title is the cycle alone, its count says 'done'",
                ('<h2 id="od-rail-h">%s</h2>' % CX["rail"]["title"]) in rail
                and "where the cycle is" not in rail and re.search(r"\d+ of \d+ done", rail or "") is not None)
        s.check("...each step shows its short line, with the whole line as its tooltip",
                all(('<span class="w">%s</span>' % st["short"]) in rail and (">%s<" % st["label"]) in rail
                    for st in CX["rail"]["steps"])
                and all(('title="%s: %s"' % (st["name"], st["full"])) in rail.replace("&#39;", "'")
                        for st in CX["rail"]["steps"]), [st["short"] for st in CX["rail"]["steps"]])
        stand = card(html, "od-stand")
        if stand:
            s.check("Where you stand: label and value, no helper line under them", '<dd class="n">' not in stand
                    and "This cycle in detail" not in stand and ">Details &rarr;<" in stand)
            n_panel = sum(1 for st in CX["standing"] if st.get("panel"))
            s.check("...a value that opens a panel is the link itself", stand.count("od-vlink") == n_panel,
                    (stand.count("od-vlink"), n_panel))

        # a leader with several reviews waiting: the team card stubbed to three parts (no one on the suite database has
        # more than one), so the grouped row itself is drawn and read
        _real_team = a.dash_team_card
        a.dash_team_card = lambda *x, **k: team_of({"pm_review": 2, "tc_review": 3, "plan_review": 1})
        try:
            th = card(H.client_as(a, who).get("/dashboard").get_data(as_text=True), "od-here")
        finally:
            a.dash_team_card = _real_team
        _chips = re.findall(r'<a class="od-chip" href="([^"]+)">([^<]+) <b>(\d+)</b></a>', th)
        s.check("several reviews: ONE row, 'Your team · 6 reviews waiting on you', a chip per part, 'Open team review'",
                re.sub(r'data-move-sub="[^"]*"', "", th).count("Your team · 6 reviews waiting on you") == 1
                and "Open team review" in th
                and [(c_[1], c_[2]) for c_ in _chips] == [("KPI", "2"), ("Competency", "3"), ("Plan", "1")]
                and "Move on to AI+ team review" not in th, _chips)
        _solid2 = [x for x in re.findall(r'class="(od-btn-(?:ai|nv)[^"]*)"', th) if "is-outline" not in x]
        s.check("...still one solid button in the card", len(_solid2) == 1, _solid2)

    # the rail's head says when the cycle closes
    if CID:
        with a.app.app_context():
            db = a.get_db()
            db.execute("UPDATE cycles SET ends_on='2099-12-31' WHERE id=?", (CID,))
            db.commit()
        r_on = (ctx_of(who or EMP["id"]).get("rail") or {}).get("closes")
        with a.app.app_context():
            db = a.get_db()
            db.execute("UPDATE cycles SET ends_on='2001-01-31' WHERE id=?", (CID,))
            db.commit()
        r_off = (ctx_of(who or EMP["id"]).get("rail") or {}).get("closes")
        s.check("the rail's head: 'Closes <date>' ahead, 'Closed <date>' once passed",
                r_on == "Closes 31 Dec 2099" and r_off == "Closed 31 Jan 2001", (r_on, r_off))
finally:
    with a.app.app_context():
        db = a.get_db()
        if CID:
            db.execute("UPDATE cycles SET ends_on=? WHERE id=?", (_ends, CID))
            if _rev is not None:
                db.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'review', ?)",
                           (CID, _rev[0]))
        if _uni is None:
            db.execute("DELETE FROM app_settings WHERE key='review_unified'")
        else:
            db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('review_unified', ?)", (_uni[0],))
        db.commit()

# ---------------------------------------------------------------------------
s.section("the look")
_css = H.source(a, "static/style.css")
s.check("one type scale: the next step 16px, card titles 14px, rows 13px, chips 11.5px, the rail's line 11px",
        ".od-nt { margin: 0; font-size: 1rem;" in _css and ".od-hd h2 { font-size: 0.875rem;" in _css
        and ".od-nrow .od-att { margin: 0; font-size: 0.8125rem;" in _css and H.cv("font-size: max(10px, 0.71875rem); color: #3A4050;") in _css
        and ".od-calm .od-sl { display: block; font-size: max(10px, 0.6875rem);" in _css)
s.check("buttons 30-34px tall, lighter borders, 18px between cards",
        ".od-btn-ai, .od-btn-nv { min-height: 34px;" in _css and H.cvp(".od-card { border-color: #E6E8EF;") in _css
        and ".od, .od-grid { gap: 18px; }" in _css)
s.check("the next step's rows show in full up to three, then scroll; the two cards share one height by the grid's "
        "stretch, not a fixed one", ".od-grid > .od-here.od-calm:not(:only-child) { contain: none; min-height: 0; }" in _css
        and ".od-calm.od-here > .od-nrows { flex: 0 1 auto; max-height: 176px; }" in _css)
s.check("the rail's node is 12px, with no icon in it", ".od-calm .od-node { width: 12px; height: 12px;" in _css
        and ".od-calm .od-node svg { display: none; }" in _css)
_tpl = H.source(a, "templates/dashboard.html")
s.check("the 'who' kicker is kept for screen readers only", 'class="od-who sr-only"' in _tpl
        and 'class="od-who">' not in _tpl)

# a bare .ax rule (the sign-in wrapper) made every span.ax -- the 9-box's axis caption, What you led's grid -- a whole
# screen tall: the BG and BU CEO record views (2026-10-16). No rule may style .ax by itself again.
_bare = re.findall(r"(?m)^\s*\.ax\s*[{,]", _css)
s.check("the sign-in wrapper is div.ax; no rule styles a bare .ax (the 9-box caption is span.ax)",
        not _bare and "div.ax { --ax-blue:" in _css and "  div.ax { flex-direction: column;" in _css
        and '<span class="ax">' in H.source(a, "templates/dashboard.html"), _bare)
s.check("Cycles you led: plain rows with a line between them (Chris, 2026-10-16)",
        H.cvp(".od-hist .od-rows > .od-ledc { padding: 9px 2px; border: 0; border-top: 1px solid #F0F1F5;") in _css)

sys.exit(s.done())
