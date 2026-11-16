"""The competency card pages by COMPETENCY (Chris, 2026-10-21, canvas LNPTK3eL11qMtAJDFmitjt, option A: "keep a max of 2
per view, and user can navigate right to go to next ... max 3 items on the dot points with '+2 more'"; then "arrange this
with current and future level in one screen", "we don't want to show current and next level to user, only for LM and
above", "use back our original left and right navigation thin bezel").

A page is one competency: a category's items with one title, so its current level and its next level sit side by side.
The server (_tc_comp_pages, for the queue panel) and the client (tcPagesOf, for both cards) build the same pages with the
same keys. Each level card shows three abilities and "+N more" (OneHR's fold). The manager's card names the levels; the
person's own never does. Browser QC of 2026-10-21 drove both cards (fold, page turn, the queue, Changed from theirs)."""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The competency card: one competency a page, both levels side by side")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
JS = open(os.path.join(ROOT, "static", "journey_chat.js"), encoding="utf-8").read()
CSS = open(os.path.join(ROOT, "static", "style.css"), encoding="utf-8").read()
APP = open(os.path.join(ROOT, "app.py"), encoding="utf-8").read()


def fn(name):
    i = JS.find("function %s(" % name)
    return JS[i:JS.find("\n  }\n", i)] if i >= 0 else ""


def with_ctx(uid, f):
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = uid
        db = a.get_db()
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())
        return f(db, u)


# --------------------------------------------------------------------------- the pages, on a made-up board
s.section("a page is a category's items with one title, in the category's order")
G = [{"category": "Ops", "items": [{"assignment_id": 1, "title": "Pricing"}, {"assignment_id": 2, "title": "Sourcing"},
                                   {"assignment_id": 3, "title": "Pricing"}, {"assignment_id": 4, "title": "Logistics"}]},
     {"category": "Cost", "items": [{"assignment_id": 5, "title": "Pricing"}]}]
P = a._tc_comp_pages(G)
s.check("a competency's next level joins its current level's page; a one-level competency is a page alone",
        [(p["key"], [it["assignment_id"] for it in p["items"]]) for p in P]
        == [("Ops::Pricing", [1, 3]), ("Ops::Sourcing", [2]), ("Ops::Logistics", [4]), ("Cost::Pricing", [5])],
        [(p["key"], [it["assignment_id"] for it in p["items"]]) for p in P])
s.check("...the same title in another category is its own page, and each page carries its category and title",
        P[3]["category"] == "Cost" and P[3]["title"] == "Pricing" and P[0]["category"] == "Ops")
s.check("nothing assigned, no pages", a._tc_comp_pages([]) == [] and a._tc_comp_pages(None) == [])

tpo = fn("tcPagesOf")
s.check("the client builds the same pages with the same key (category::title), in the same order",
        'var k = String(g.category || "") + "::" + String(it.title || "");' in tpo
        and 'k = "%s::%s" % (g.get("category") or "", it.get("title") or "")' in APP
        and "by[k].items.push(it);" in tpo and "pages.push(by[k]);" in tpo)

# --------------------------------------------------------------------------- on a real person's board
s.section("a real board: every assignment on exactly one page, one page a (category, title)")
raw = sqlite3.connect(a.DB_PATH)
raw.row_factory = sqlite3.Row
cyc = raw.execute("SELECT id FROM cycles WHERE is_active=1").fetchone()
who = raw.execute(
    "SELECT a.subject_id, COUNT(*) n, COUNT(DISTINCT COALESCE(NULLIF(s.skill_category,''),'~') || '|' || s.title) d, "
    "SUM(a.is_future) f FROM tc_assignments a JOIN tc_skills s ON s.id=a.skill_id WHERE a.cycle_id=? "
    "GROUP BY a.subject_id HAVING SUM(a.is_future) > 0 AND COUNT(*) > COUNT(DISTINCT s.title) ORDER BY n DESC LIMIT 1",
    (cyc["id"],)).fetchone() if cyc else None
s.check("the scratch copy has someone assessed at two levels of a competency", who is not None)
if who is not None:
    ov = with_ctx(who["subject_id"], lambda db, u: a._competency_overview(db, u))
    d = (ov or {}).get("data") or {}
    pages = a._tc_comp_pages(d.get("groups"))
    ids = [it["assignment_id"] for p in pages for it in p["items"]]
    s.check("every assignment is on exactly one page", sorted(ids) == sorted(
        r[0] for r in raw.execute("SELECT id FROM tc_assignments WHERE cycle_id=? AND subject_id=?",
                                  (cyc["id"], who["subject_id"]))), (len(ids), who["n"]))
    s.check("one page a (category, title), counted by an independent query", len(pages) == who["d"],
            (len(pages), who["d"]))
    s.check("each page's items share its title, and at least one page holds both levels",
            all(all(it["title"] == p["title"] for it in p["items"]) for p in pages)
            and any(len({it["is_future"] for it in p["items"]}) == 2 for p in pages))
    nav = with_ctx(who["subject_id"], lambda db, u: a._journey_nav_items(db, u, "competency"))
    comp = [it for it in nav.get("items", []) if it["id"] not in ("remark", "confirm")]
    s.check("the queue panel lists the same pages: one row a competency, named by its title, keyed as the card keys it",
            [it["id"] for it in comp] == [p["key"] for p in pages]
            and [it["name"] for it in comp] == [p["title"] or "Other" for p in pages], [it["id"] for it in comp])
    s.check("...its counts are the page's levels answered of its levels, and they add up to the panel's count",
            all(it["total"] == len(p["items"]) for it, p in zip(comp, pages))
            and sum(it["prog"] for it in comp) == d.get("answered"), (sum(it["prog"] for it in comp), d.get("answered")))
    want = next((p["key"] for p in pages if any(it["assignment_id"] == d.get("focus_assignment_id")
                                                for it in p["items"])), pages[0]["key"] if pages else None)
    s.check("...on screen is the page holding the first competency still to answer", nav.get("focus") == want,
            (nav.get("focus"), want))
    s.check("...the remark and Save & submit still come after every competency",
            [it["id"] for it in nav["items"][-2:]] == ["remark", "confirm"])
    s.check("...and it asks to pick a competency, not a category", 'summary="Pick a competency to start:"' in APP
            and "Pick a category to start" not in APP)

# --------------------------------------------------------------------------- the manager's payload
s.section("the manager's card names the level, with its number")
mgr = raw.execute(
    "SELECT u.manager_id m, u.id r, u.full_name n FROM users u JOIN tc_assessments t ON t.subject_id=u.id AND t.cycle_id=? "
    "WHERE t.status IN ('submitted','reviewed') AND u.manager_id IS NOT NULL AND EXISTS (SELECT 1 FROM tc_assignments x "
    "WHERE x.subject_id=u.id AND x.cycle_id=? AND x.is_future=1) LIMIT 1", (cyc["id"], cyc["id"])).fetchone() if cyc else None
s.check("the scratch copy has a submitted assessment with a next level, and its manager", mgr is not None)
if mgr is not None:
    td = with_ctx(mgr["m"], lambda db, u: a._journey_team_tm_data(db, u, mgr["r"], mgr["n"]))
    its = [it for g in (td or {}).get("groups", []) for it in g.get("items", [])]
    lv = {r["id"]: r["level"] for r in raw.execute(
        "SELECT a.id, s.level FROM tc_assignments a JOIN tc_skills s ON s.id=a.skill_id WHERE a.cycle_id=? AND "
        "a.subject_id=?", (cyc["id"], mgr["r"]))}
    s.check("each item carries its level's number (level_n) beside current / next",
            its and all(it.get("level_n") == lv.get(it["id"]) for it in its)
            and {it["level"] for it in its} == {"current", "next"}, [(it.get("level"), it.get("level_n")) for it in its][:4])
    s.check("...the payload keys the potential review relies on are all still there",
            all(k in td for k in ("potential", "manager_remark", "remark_required", "remark_move", "remark_max_words")),
            sorted(td))

# --------------------------------------------------------------------------- the client
s.section("both cards page by competency, the levels side by side")
tcw, tmw, head, ab = fn("tcWidget"), fn("tmReviewWidget"), fn("tcPageHead"), fn("tcAbilities")
s.check("the helpers are there", all([tcw, tmw, head, ab, fn("tcPages"), fn("competencyFollow"), fn("tcSelectPage")]))
s.check("every reader of the person's card goes through tcPages: nothing reads the category groups for paging",
        "tc.data.groups" not in JS and "tcSelectCategory" not in JS and "var groups = tcPages(data);" in tcw
        and "var groups = tcPages(data);" in tmw)
s.check("the page's head: its category over the competency and its (i of N); the side strips page it",
        'rmkEl("div", "rv-tc-kicker", p.category)' in head and "sectionNav(p.title, i, n)" in head
        and "bezelWrap(box, tc.section, groups.length" in tcw and "bezelWrap(page, mtc.section, groups.length" in tmw)
s.check("the levels sit side by side, a card each; a one-level competency takes the row",
        tcw.count('"rv-fb-grp rv-tc-grp rv-tc-pair" + ((g.items || []).length < 2 ? " rv-tc-pair-1" : "")') == 1
        and tmw.count('"rv-fb-grp rv-tc-grp rv-tc-pair" + ((g.items || []).length < 2 ? " rv-tc-pair-1" : "")') == 1
        and ".rv-tc-grp.rv-tc-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));" in CSS
        and ".rv-tc-grp.rv-tc-pair-1 { grid-template-columns: minmax(0, 1fr); }" in CSS)
s.check("...each card's buttons along its foot, so the pair's buttons sit level; the manager's 260px basis can't become "
        "a height", ".rv-tc-grp.rv-tc-pair > .rv-tc-row > .rv-fb-btns { margin: 10px 0 0;" in CSS
        and ".rv-tc-grp.rv-tc-pair > .rv-tc-row > .rv-tc-cell { flex: 1 1 auto; }" in CSS
        and CSS.find(".rv-tc-grp.rv-tc-pair > .rv-tc-row > .rv-tc-cell") > CSS.find(".rv-mgr-pin .rv-tc-grp .rv-tc-cell {"))
s.check("the person's own card never names the level (Chris: 'only for LM and above'); the manager's does, with its "
        "number", "rv-tc-level" not in tcw and "Current level" not in tcw and "Next level" not in tcw
        and '(it.level === "next" ? "Next level" : "Current level") + (it.level_n ? " \\u00b7 L" + it.level_n : "")' in tmw)
s.check("the card follows the conversation by the page holding the focus, only when it moves on",
        "String(it.assignment_id) === String(data.focus_assignment_id)" in fn("competencyFollow")
        and "if (key !== null && key !== tc.key) tc.section = at;" in fn("competencyFollow"))

s.section("three abilities, then the fold")
s.check("three show, the rest hide behind '+N more', which opens in place and reads Show less under the list's end",
        "var TC_ABIL_SHOWN = 3" in JS and "li.hidden = !open && i >= TC_ABIL_SHOWN;" in ab
        and 'more.textContent = open ? "Show less" : "+" + extra + " more";' in ab
        and "wrap.appendChild(ul);" in ab and ab.find("wrap.appendChild(ul);") < ab.find("wrap.appendChild(more);")
        and 'more.setAttribute("aria-expanded", open ? "true" : "false");' in ab)
s.check("...no button when there are three or fewer", "if (extra > 0) {" in ab)
s.check("...kept open across the card's re-renders (every tick redraws it), per item, on both cards",
        "tcFoldOpen[key] = !tcFoldOpen[key]; paint();" in ab and 'tcAbilities(abil, "e" + it.assignment_id)' in tcw
        and 'tcAbilities(abil, "m" + rid + ":" + it.id)' in tmw)

s.section("every other place a person reads ability items folds after three too (2026-10-27)")
import subprocess, shutil
DASH = open(os.path.join(ROOT, "static", "dashboard.js"), encoding="utf-8").read()
CCJ = open(os.path.join(ROOT, "static", "competency_chat.js"), encoding="utf-8").read()
levelcell = fn("levelCell") or ""
s.check("the journey's both-levels list uses the same fold, one key per level and competency",
        'tcAbilities(abil, key)' in levelcell and '"d" + n + ":" + it.title' in JS and "cell._au" not in JS)
s.check("the pre-cycle dashboard list shows three and folds the rest behind '+N more' / Show less",
        "li.hidden = ai >= 3" in DASH and "var extra = p[0].abilities.length - 3;" in DASH and "if (extra > 0) {" in DASH
        and '"Show less" : "+" + extra + " more"' in DASH)
s.check("the competency page's row does the same, kept open per item across re-renders",
        "li.hidden = !open_ && i >= 3" in CCJ and "var extra = abil.length - 3" in CCJ and "abilOpen[fkey] = !abilOpen[fkey]" in CCJ)
node = shutil.which("node")
if node and ab:
    # run the shared fold on a stub DOM: 3 shown + a button for 7 items, no button for 3, and the guard falsified
    harness = (
        "var els=[];function mk(t){var e={tag:t,children:[],hidden:false,attrs:{},listeners:{},className:'',textContent:'',"
        "appendChild:function(c){this.children.push(c);return c;},setAttribute:function(k,v){this.attrs[k]=v;},"
        "addEventListener:function(n,f){this.listeners[n]=f;}};return e;}"
        "var document={createElement:mk};function rmkEl(t,c,x){var e=mk(t);e.className=c||'';e.textContent=x||'';return e;}"
        "var TC_ABIL_SHOWN=3,tcFoldOpen={};" + ab + "\n  }\n"
        "function run(n){var it=[];for(var i=0;i<n;i++)it.push('x'+i);var w=tcAbilities(it,'k'+n);var ul=w.children[0];"
        "var vis=ul.children.filter(function(l){return !l.hidden;}).length;var b=w.children[1];"
        "var out={vis:vis,btn:b?b.textContent:null};if(b){b.listeners.click();out.open=ul.children.filter(function(l){return !l.hidden;}).length;"
        "out.openBtn=b.textContent;}return out;}"
        "console.log(JSON.stringify([run(7),run(4),run(3),run(1)]));")
    r = subprocess.run([node, "-e", harness], capture_output=True, text=True, timeout=30)
    try:
        import json as _j
        r7, r4, r3, r1 = _j.loads(r.stdout)
    except Exception:
        r7 = r4 = r3 = r1 = {}
    s.check("7 items: 3 show, '+4 more' opens all 7 and reads Show less", r7.get("vis") == 3 and r7.get("btn") == "+4 more"
            and r7.get("open") == 7 and r7.get("openBtn") == "Show less", r.stdout + r.stderr)
    s.check("4 items: 3 show, '+1 more'; 3 or fewer: all show and no button", r4.get("vis") == 3 and r4.get("btn") == "+1 more"
            and r3.get("vis") == 3 and r3.get("btn") is None and r1.get("vis") == 1 and r1.get("btn") is None)
    bad = subprocess.run([node, "-e", harness.replace("if (extra > 0) {", "if (true) {")], capture_output=True, text=True)
    try:
        b3 = _j.loads(bad.stdout)[2]
    except Exception:
        b3 = {}
    s.check("falsified: with the guard removed, a list of three gets a button (so the check above can fail)",
            b3.get("btn") is not None, bad.stdout + bad.stderr)
else:
    s.check("node is available to run the fold", False)

s.section("the manager's call beside theirs")
s.check("'Changed from theirs' shows when your call differs from theirs, and follows each click in place",
        "return !!(it.mod_answer && it.report_answer && it.mod_answer !== it.report_answer);" in fn("tcChangedFromTheirs")
        and "chg.hidden = !tcChangedFromTheirs(it);" in tmw
        and "if (chg) chg.hidden = !tcChangedFromTheirs(it);" in fn("tcModerate")
        and ".rv-tc-changed[hidden] { display: none; }" in CSS)
s.check("the potential review's parts are untouched (tmPotSection before, the remarks after the pages)",
        "if (data.potential) box.appendChild(tmPotSection(data));" in tmw
        and "if (shared) box.appendChild(tmRemarksSection(data, reviewed));" in tmw
        and tmw.find("tmPotSection(data)") < tmw.find("bezelWrap(page") < tmw.find("tmRemarksSection(data, reviewed)"))

_tps = fn("tmPotSection")
s.check("the potential block shows its tiles with no line spelling out the weighted parts under them (Chris, "
        "2026-10-21: 'remove this line from the LM view on the TM moderation')",
        "rv-tmp-row" in _tps and "for their grade" not in _tps and "can still move the band" not in _tps
        and "P.c_360_max" not in _tps)

s.section("the competency remark's words follow the ticks (Chris, 2026-10-22)")
import json as _json  # noqa: E402
import subprocess as _sp  # noqa: E402
_trr = fn("tcRemarkRule")
_NODE = ("var tc = {pending: {}};\nfunction tcAnswerOf(x) { return (x.assignment_id in tc.pending) ? "
         "tc.pending[x.assignment_id] : x.answer; }\n" + _trr + "\n  }\n")


def trule(data, pending=None):
    o = _sp.run(["node", "-e", _NODE + "tc.pending = %s;\nconsole.log(JSON.stringify(tcRemarkRule(%s)));"
                 % (_json.dumps(pending or {}), _json.dumps(data))], capture_output=True, text=True)
    return _json.loads(o.stdout) if o.returncode == 0 else ("err", o.stderr[:200])


_R = {"high_pct": 75.0, "w_current": 1.0, "w_future": 1.5}
_G = [{"category": "C", "items": [{"assignment_id": i, "is_future": i > 5, "answer": None} for i in range(1, 11)]}]
_d = {"groups": _G, "remark_rule": _R}
s.check("every competency ticked Demonstrate (not saved yet) -> 'high'",
        trule(_d, {i: "yes" for i in range(1, 11)}) == "high")
s.check("every one Developing -> 'all_developing'", trule(_d, {i: "no" for i in range(1, 11)}) == "all_developing")
_mostly = {i: "yes" for i in range(1, 11)}; _mostly[1] = "no"; _mostly[2] = "no"       # 10.5 of 12.5 = 84%
s.check("mostly Demonstrate, at the High share -> 'high'", trule(_d, _mostly) == "high")
_low = {i: ("yes" if i <= 5 else "no") for i in range(1, 11)}                        # 5 of 12.5 = 40%
s.check("current levels only -> no special wording", trule(_d, _low) is None)
s.check("not every one answered -> no special wording", trule(_d, {i: "yes" for i in range(1, 10)}) is None)
_tw = fn("tcWidget")
s.check("the remark box (always required) takes Chris's words for each case",
        "var tk = tcRemarkRule(data);" in _tw and "Looks like you've shown strong demonstration of these competencies." in _tw
        and "Please give specific examples to " in _tw and '"What, or where, would you like to improve?' in _tw
        and "required: true," in _tw)
with a.app.test_request_context("/"):
    db = a.get_db()
    s.check("the server hands the card _tc_self_band's rule", True if not who else
            ((with_ctx(who["subject_id"], lambda d_, u_: a._competency_overview(d_, u_)) or {}).get("data") or {})
            .get("remark_rule") == {"high_pct": a.TC_BAND_HIGH_PCT, "w_current": a.SCORE_CURRENT,
                                    "w_future": a.SCORE_FUTURE, "w_dev_current": 0.0, "w_dev_future": 0.0})   # the engine default (Points per answer)
    _cid = a.active_cycle_id(db)
    _ppl = [r[0] for r in db.execute(
        "SELECT t.subject_id FROM tc_assessments t WHERE t.cycle_id=? AND NOT EXISTS (SELECT 1 FROM tc_assignments x "
        "LEFT JOIN tc_scores sc ON sc.assignment_id=x.id AND sc.assessment_id=t.id WHERE x.subject_id=t.subject_id AND "
        "x.cycle_id=t.cycle_id AND sc.answer IS NULL) LIMIT 40", (_cid,))]
    _n = _bad = 0
    for _sid in _ppl:
        _ov = (with_ctx(_sid, lambda d_, u_: a._competency_overview(d_, u_)) or {}).get("data") or {}
        if not _ov.get("groups"):
            continue
        _band = with_ctx(_sid, lambda d_, u_: a._tc_self_band(d_, u_, _cid))["band"]
        _n += 1
        _bad += (trule(_ov) == "high") != (_band == "High")
    s.check("on real fully answered self-assessments the card's 'high' is _tc_self_band's High every time",
            _n > 0 and _bad == 0, (_n, _bad))

raw.close()
sys.exit(s.done())
