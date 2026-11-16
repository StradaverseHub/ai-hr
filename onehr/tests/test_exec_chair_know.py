"""The Executive Chairman view, piece P5: what the agents, Help and the first sign-in know about his three places (Chris,
2026-10-29: "Approve all picks"; "Every new feature or module updates what the agents and the first sign-in know", 2026-10-22).
Dark behind ONEHR_CHAIR=1.

  * Ask OneHR stays a GUIDE for him: his chips and his ways somewhere (the Group Talent Box on a business group he names, Talent by
    business group, his leaders' Talent Box, his 360 ratings, the insight) are answered in code with no model and never read a
    figure, a count or a name out; _ask_wants_result still answers a value request in code and _ASK_LEAK_RE still replaces a reply
    that names a band; nobody else gets his ways; its facts hold no result
  * his two KB rows are seeded by slug (idempotent), conceptual, and read by his agents ONLY (every kb_entries reader asks
    _kb_lms_hidden), so no leader's agent can read what he sees or does
  * Help: his dashboard, Group Talent Box and leaders' Talent Box each have their own fixed answers (no model, no result), and no
    one else is given them; a crafted ?view= for anyone else is not his list
  * the first sign-in tour's chair stops are on his dashboard's cards alone and the generic rail stop is not his
  * OneHR Agent: his welcome and chat brief name the 360 as his part and the two boxes as views of their own; the two boxes' turns
    stay fixed words with no model call
  * the user-role gate does not hold his routes (team / leader pages follow the seat); they are classified in the module map
Synthetic ZZ9PK people only; a fresh_db suite, so Suite.done() puts the scratch copy back."""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Executive Chairman, P5: what the agents, Help and the first sign-in know")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
os.environ.pop("ONEHR_CHAIR", None)
SU, _BGA0, _E = H.actors(a)
SRC = open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read()
ONB = open(os.path.join(H.REPO, "static", "onboarding.js"), encoding="utf-8").read()
ASKJS = open(os.path.join(H.REPO, "static", "ask_onehr.js"), encoding="utf-8").read()


def run(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def sql(q, args=()):
    def f(d):
        d.execute(q, args)
        d.commit()
    run(f)


def put(key, val):
    if val is None:
        sql("DELETE FROM app_settings WHERE key=?", (key,))
    else:
        sql("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", (key, str(val)))


BG1, BG2 = "ZZ9PK BG ONE", "ZZ9PK BG TWO"
CA, CC = "ZZ9PK ONE A", "ZZ9PK TWO C"
ids = {}
PEOPLE = [("A1", BG1, CA, "OU", "High"), ("A2", BG1, CA, "AE", "High"), ("A3", BG1, CA, "ME", "Mid"),
          ("B1", BG2, CC, "OU", "High"), ("B2", BG2, CC, "ME", "Mid")]
with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycles SET half=2, kind='year_end', no_potential=NULL, min_job_grade=NULL WHERE id=?", (CID,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base if c != "id"]

    def mk(tag, bg, co, **kw):
        eid = "ZZ9PK-" + tag
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="Zed Pkk %s Quill" % tag, display_name=None, email=None,
                 hod_id=None, manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None,
                 confirmation_date="2020-01-01", left_at=None, role="user", is_demo=0, user_role_id=None, job_grade="14",
                 business_group=bg, company=co, department="ZZ Dept", job_title="SENIOR MANAGER", years_of_service=5)
        v.update(kw)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v.get(c) for c in cols])
        ids[tag] = db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
    mk("CH", BG1, CA)
    mk("DL", BG1, CA)
    mk("BC", BG1, CA, bgceo_bg=BG1)
    mk("ST", BG1, CA)
    for tag, bg, co, pm, pot in PEOPLE:
        mk(tag, bg, co)
        u_ = db.execute("SELECT * FROM users WHERE id=?", (ids[tag],)).fetchone()
        db.execute("INSERT INTO rating_records(cycle_id, subject_id, employee_id, full_name, business_group, company, department, "
                   "job_grade, job_title, pm_final_band, pm_final_source, pot_final_band, pot_final_source) "
                   "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", (CID, ids[tag], u_["employee_id"], u_["full_name"], bg, co,
                                                          u_["department"], "14", u_["job_title"], pm, "bgceo", pot, "bgceo"))
        db.execute("INSERT INTO leader_releases(cycle_id, subject_id, kind, released_by) VALUES (?,?,'talent',?)",
                   (CID, ids[tag], SU["id"]))
    for tag in ("A1", "A2"):   # the chair rates two colleagues: one done, one not
        db.execute("INSERT OR REPLACE INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) VALUES "
                   "(?,?,?,'line_manager',?)", (CID, ids[tag], ids["CH"], "submitted" if tag == "A1" else "pending"))
    db.commit()
CH, DL, BC, ST = (ids[k] for k in ("CH", "DL", "BC", "ST"))
CHC, DLC, BCC, STC, SUP = (H.client_as(a, x) for x in (CH, DL, BC, ST, SU["id"]))
NAMES = ["Zed Pkk %s Quill" % t for t, *_ in PEOPLE]
BAND_WORDS = a._ASK_LEAK_RE   # the guide's own rule for "a band or a talent status in a reply"
NO_FIGURE = re.compile(r"\d")


def ask(client, msg):
    r = client.post("/ask", data={"csrf_token": "tok", "message": msg})
    return r.status_code, (r.get_json() or {})


def user(uid):
    return run(lambda d: d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def facts(uid):
    def f(d):
        u_ = d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        ctx = a._dash_context(d, u_)
        ctx["chair"] = a._chair_dash(d, u_)
        return a._ask_facts(d, u_, ctx)
    return run(f)


def helps(uid, ep, view="", stage=""):
    return run(lambda d: a.help_answers(d, d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone(), ep, view, stage))


try:
    put("exec_chair_id", CH)
    put("exec_chair_delegate_id", DL)
    real_avail, real_agent = a.ai_draft.review_agent_available, a.ai_draft.review_agent

    def boom(*x, **k):
        raise AssertionError("the model must not be called for a way somewhere answered in code")
    a.ai_draft.review_agent = lambda *x, **k: {"say": "Hello.", "quick_replies": []}
    a.ai_draft.review_agent_available = lambda: True

    # --------------------------------------------------------------------------------------------- flag off
    s.section("flag off: nothing of his anywhere")
    code, j = ask(CHC, "Show the Super Stars in %s" % "ZZ9PK BG One")
    s.check("flag off: the chair's chips are not his (no chair suggestions), and nothing opens the Group Talent Box", code in (200, 500)
            and "chairgrp" not in json.dumps(j))
    s.check("flag off: his help is the ordinary one and his KB rows are hidden even from him",
            helps(CH, "dashboard")["label"] in ("Dashboard",) and all(i["key"] not in ("chair_what", "chair_insight") for i in
                                                                       helps(CH, "dashboard")["items"])
            and run(lambda d: a._kb_chair_may_read()) is False)

    # --------------------------------------------------------------------------------------------- Ask OneHR
    os.environ["ONEHR_CHAIR"] = "1"
    a.ai_draft.review_agent = boom
    s.section("Ask OneHR: a guide to his three places, answered in code, never a result")
    r = CHC.get("/ask")
    sug = r.get_json()["suggestions"]
    bgname = run(lambda d: [c["name"] for c in a._chair_dash(d, user(CH))["cards"] if c["key"] and c["released"]][0])
    s.check("his chips are board 1's: 'Show the Super Stars in <a group>', 'Which group has the most Stars?', 'Take me to my 360 "
            "ratings' (he has colleagues to rate)", sug[:3] == ["Show the Super Stars in %s" % bgname, "Which group has the most "
                                                                "Stars?", "Take me to my 360 ratings"], sug)
    s.check("nobody else is offered them (a BG CEO, staff, the delegate)", all("Super Stars" not in " ".join(
        c.get("/ask").get_json()["suggestions"]) for c in (BCC, STC, DLC)))
    code, j = ask(CHC, sug[0])
    card = (j.get("cards") or [{}])[0]
    s.check("'Show the Super Stars in <group>' opens the Group view filtered to that group's Stars, in code (no model)",
            code == 200 and j.get("mode") == "direct" and "view=chairgrp" in card.get("href", "") and "show=talent" in card["href"]
            and "bg=" in card["href"], j)
    code, j = ask(CHC, sug[1])
    s.check("'Which group has the most Stars?' marks Talent by business group and opens nothing narrowed: it is a guide",
            j.get("mark") == "chairbg" and "Talent by business group" in j["say"] and j.get("mode") == "direct", j)
    code, j = ask(CHC, sug[2])
    s.check("'Take me to my 360 ratings' goes to his 360 (the feedback stage)", "stage=feedback" in ((j.get("cards") or [{}])[0].get("href")
                                                                                               or ""), j)
    code, j = ask(CHC, "Take me to my leaders' Talent Box")
    s.check("his leaders' Talent Box is a way somewhere too (not open yet in this fixture: it says so, with no card)",
            code == 200 and j.get("mark") == "chairye" and "isn't open yet" in j["say"], j)
    code, j = ask(CHC, "Where is the AI insight?")
    s.check("the insight card is marked, and its figures are not read out", j.get("mark") == "chairins" and "don't read the figures"
            in j["say"], j)
    said = []
    for q in sug[:3] + ["Where is the AI insight?", "Show the Stars and Super Stars"]:
        code, j = ask(CHC, q)
        said.append(j.get("say", ""))
    scrub = lambda t: t.replace(bgname, "").replace("Stars and Super Stars", "").replace("360", "")   # noqa: E731  (a group's name, a category's, the 360)
    s.check("no way somewhere reads a figure, a count, a band, a talent status or a name out",
            not any(re.search(r"\d", scrub(t)) or BAND_WORDS.search(scrub(t)) or any(n in t for n in NAMES) for t in said), said)
    a.ai_draft.review_agent = lambda *x, **k: {"say": "Hello.", "quick_replies": []}   # the others fall through to the model
    code, j = ask(BCC, "Show the Super Stars in %s" % bgname)
    s.check("a BG CEO asking the same gets none of his places (no chairgrp link)", "chairgrp" not in json.dumps(j), j)
    code, j = ask(STC, "Take me to my leaders' Talent Box")
    s.check("staff asking for the leaders' box gets none of his places", "chairlead" not in json.dumps(j))
    a.ai_draft.review_agent = boom

    # a value request is still answered in code; a reply that names a band is still replaced
    code, j = ask(CHC, "Show me my team's results")
    s.check("a value request is answered in code, pointed to the card, never read out (_ask_wants_result still holds)",
            j.get("blocked") == "result" and "I don't read results out here" in j["say"], j)
    a.ai_draft.review_agent = lambda sysm, hist, **k: {"say": "%s has 2 Super Stars and 1 Star." % bgname, "quick_replies": []}
    code, j = ask(CHC, "What do you make of the groups?")
    s.check("a model reply that names a talent status is replaced (_ASK_LEAK_RE still holds, for him too)",
            j.get("blocked") == "result" and "Super Star" not in j["say"], j)
    a.ai_draft.review_agent = boom
    s.check("the leak guard (now also the plural: 'Super Stars', 'Stars') and the result guard hold", "_ASK_LEAK_RE" in SRC
            and a._ask_wants_result("what are my team's ratings") and bool(a._ASK_LEAK_RE.search("two Super Stars"))
            and bool(a._ASK_LEAK_RE.search("12 Stars")) and not a._ASK_LEAK_RE.search("a star performer is you"))
    lines, links = facts(CH)
    at = next(i for i, l in enumerate(lines) if "EXECUTIVE CHAIRMAN'S DASHBOARD" in l)
    blob = "\n".join(lines[at:at + 6])
    s.check("his facts say where his cards and places are, and hold no result, no count of anyone, no name",
            "Talent by business group" in blob and not BAND_WORDS.search(blob) and not any(n in blob for n in NAMES)
            and not re.search(r"\d", re.sub(r"\[L\d+\]", "", blob).replace("360", "")), blob[:300])
    s.check("every mark a link carries is one the page knows (ASK_MARKS, and the client's MARKS)",
            all(v.get("mark") in a.ASK_MARKS for v in links.values() if v.get("mark"))
            and all(k in ASKJS for k in ("chairye", "chairins", "chairbg")) and {"chairye", "chairins", "chairbg"} <= set(a.ASK_MARKS))
    s.check("the cards those marks name are on his dashboard (and not on anyone else's)",
            all(x in CHC.get("/dashboard").get_data(as_text=True) for x in ("ec-top", "ec-bgs"))
            and not any(x in BCC.get("/dashboard").get_data(as_text=True) for x in ("ec-top", "ec-bgs")))
    lines_bc, _l = facts(BC)
    s.check("a BG CEO's facts carry nothing of his dashboard", "EXECUTIVE CHAIRMAN" not in "\n".join(lines_bc))
    intro = run(lambda d: a._ask_intro(dict(a._dash_context(d, user(CH)), chair=a._chair_dash(d, user(CH))), {}))
    s.check("his lead line is a guide's: the cycle, the number of groups, no count of anyone's talent",
            "business group" in intro["lead"] and not re.search(r"\b\d+ (Super|Star)", intro["lead"]) and "Super" not in intro["lead"]
            and "I find things and take you to them" in intro["lead"], intro["lead"])
    s.check("the dashboard draws that lead on his page and a BG CEO's keeps the ordinary one",
            "I find things and take you to them" in CHC.get("/dashboard").get_data(as_text=True)
            and "I find things and take you to them" not in BCC.get("/dashboard").get_data(as_text=True))

    # --------------------------------------------------------------------------------------------- KB
    s.section("KB rows: his two, seeded by slug, conceptual, read by his agents only")
    SL = ("executive-chairman-view", "chairman-leaders-talent-box")
    rows = run(lambda d: [dict(r) for r in d.execute("SELECT slug, title, body, tags FROM kb_entries WHERE slug IN (?,?)", SL)])
    s.check("both rows are there, once each", sorted(r["slug"] for r in rows) == sorted(SL)
            and H.one(a, "SELECT COUNT(*) FROM kb_entries WHERE slug IN (?,?)", SL) == 2)
    bodies = " ".join(r["body"] for r in rows).lower()
    s.check("their bodies are conceptual: no result, no figure beyond 'step 1', no id or tool word, no name",
            not re.search(r"\d", bodies.replace("step 1", "").replace("360", "")) and not any(w in bodies for w in ("kpi_id", "chair_locks", "tool{", "_id"))
            and not any(n.lower() in bodies for n in NAMES))
    sql("INSERT OR IGNORE INTO kb_entries(slug, title, body, tags, sort_order) VALUES (?,?,?,?,?)", (SL[0], "other", "other", "", 1))
    s.check("seeding again is idempotent (INSERT OR IGNORE by slug: the row is not replaced, no duplicate)",
            H.one(a, "SELECT title FROM kb_entries WHERE slug=?", (SL[0],)) == next(r_["title"] for r_ in rows if r_["slug"] == SL[0])
            and H.one(a, "SELECT COUNT(*) FROM kb_entries WHERE slug=?", (SL[0],)) == 1)

    def hidden_for(uid, slug):
        real = a.current_user
        with a.app.test_request_context("/"):
            a.current_user = lambda: user(uid) if uid else None
            try:
                return a._kb_lms_hidden(slug)
            finally:
                a.current_user = real
    s.check("hidden from a BG CEO, staff, the delegate, the super admin and signed-out; open to him alone",
            all(hidden_for(x, SL[0]) and hidden_for(x, SL[1]) for x in (BC, ST, DL, SU["id"], None))
            and not hidden_for(CH, SL[0]) and not hidden_for(CH, SL[1]))

    def guide_titles(uid, q):
        real = a.current_user
        with a.app.test_request_context("/"):
            a.current_user = lambda: user(uid)
            try:
                return [g["title"] for g in a._ask_guide(a.get_db(), q)]
            finally:
                a.current_user = real
    gq = "executive chairman leaders talent box place lock"
    s.check("Ask OneHR's guide finds them for him and for no one else",
            any("leaders' Talent Box" in t for t in guide_titles(CH, gq)) and not any("Executive Chairman" in t or "leaders' Talent Box"
                                                                                       in t for t in guide_titles(BC, gq)),
            (guide_titles(CH, gq), guide_titles(BC, gq)))
    readers = len(re.findall(r"FROM kb_entries WHERE active=1", SRC))
    # with Grade H merged: every reader asks _kb_hidden, which is _kb_lms_hidden (Learning, the chair's) or _kb_gradeh_hidden;
    # on a build without Grade H the readers call _kb_lms_hidden directly, so either form counts
    _asks = SRC.count('_kb_lms_hidden(r["slug"])') + SRC.count('_kb_hidden(r["slug"])')
    _wraps = "_kb_lms_hidden(slug)" in SRC[SRC.index("def _kb_hidden(slug)"):SRC.index("def _kb_hidden(slug)") + 400] \
        if "def _kb_hidden(slug)" in SRC else True
    s.check("every reader of kb_entries asks _kb_lms_hidden (so a new reader of the chair's rows can't skip it)",
            readers == 3 and _asks == 3 and _wraps, (readers, _asks, _wraps))
    real_cr = a._kb_chair_may_read
    try:
        a._kb_chair_may_read = lambda: True
        s.check("falsified: if the seat check let everyone in, a BG CEO's guide would find them (so the hiding above is the guard)",
                hidden_for(BC, SL[0]) is False)
    finally:
        a._kb_chair_may_read = real_cr

    # --------------------------------------------------------------------------------------------- Help
    s.section("Help: his own fixed answers for his dashboard, his Group Talent Box and his leaders' box")
    hd = helps(CH, "dashboard")
    hg = helps(CH, "review_journey", "chairgrp", "chair_group")
    hl = helps(CH, "review_journey", "chairlead", "chair_leaders")
    keys = lambda h: [i["key"] for i in h["items"]]   # noqa: E731
    s.check("his dashboard: his own list (what is on it, the insight, when he sees results, why only the 360), then the seat's line",
            keys(hd)[:4] == ["chair_what", "chair_insight", "chair_when", "chair_360"] and keys(hd)[-1] == "seat_chair_group"
            and len(hd["items"]) <= a.HELP_LIST_MAX and hd["label"] == "Dashboard", keys(hd))
    s.check("his Group Talent Box: read only, what a name opens, narrowing, Excel, Not released yet",
            keys(hg) == ["cg_read", "cg_open", "cg_filter", "cg_excel", "cg_released"] and hg["label"].endswith("Group Talent Box"), keys(hg))
    s.check("his leaders' box: who, Not placed yet, the reason, the lock, the Record",
            keys(hl) == ["cl_who", "cl_place", "cl_move", "cl_lock", "cl_record"] and "Leaders" in hl["label"], keys(hl))
    s.check("no answer of his holds a result, a name or a figure beyond 'step 1'", all(
        not BAND_WORDS.search(i["a"].replace("Stars and Super Stars", "")) and not re.search(r"\d", i["a"].replace("step 1", "").replace("360", ""))
        and not any(n in i["a"] for n in NAMES) for h in (hd, hg, hl) for i in h["items"]))
    s.check("no one else is given them: a BG CEO, staff and the delegate get the ordinary lists, on the dashboard and with a crafted "
            "?view=chairgrp", all(not (set(keys(helps(x, ep, v, st))) & {"chair_what", "chair_insight", "cg_read", "cl_who", "seat_chair_group"})
                                  for x in (BC, ST, DL) for ep, v, st in (("dashboard", "", ""),
                                                                           ("review_journey", "chairgrp", "chair_group"),
                                                                           ("review_journey", "chairlead", "chair_leaders"))))
    s.check("the answers are fixed words in HELP_QA, every key a list names is there", all(
        k in a.HELP_QA for l in ("chair_dash", "chair_group", "chair_lead") for k in a.HELP_LISTS[l][1]) and all(
        k in a.HELP_QA for k in ("seat_chair_group", "seat_chair_lead")))
    r = CHC.get("/help/answers?ep=review_journey&view=chairgrp&stage=chair_group")
    s.check("the Help panel route serves them to him", r.status_code == 200 and "cg_read" in json.dumps(r.get_json()))

    # --------------------------------------------------------------------------------------------- the tour
    s.section("the first sign-in tour: his stops show on his cards alone")
    ch_page = CHC.get("/dashboard").get_data(as_text=True)
    bc_page = BCC.get("/dashboard").get_data(as_text=True)
    only = re.findall(r"only: \"([^\"]+)\", sel: \[(.*?)\], title: \"([^\"]+)\"", ONB)
    # AMENDED 2026-10-30: AI+ OneHR, his talent chat, has a stop of its own, shown only while its panel (#ask-panel.ecp) is on the page
    s.check("four stops of his (Your Year-End, the AI insight, Talent by business group, his leaders' Talent Box), each for a page "
            "with .ec-top, one more for the talent chat's panel, and the generic rail stop is not his", [t for _o, _s, t in only if _o == ".ec-top"] == [
                "Your Year-End", "The AI insight", "Talent by business group", "Your leaders' Talent Box"]
            and [(o, t) for o, _s, t in only if o != ".ec-top"] == [("#ask-panel.ecp", "AI+ OneHR, your talent partner")]
            and 'not: ".ec-top", sel: [".od-rail"]' in ONB, only)
    sels = {"Your Year-End": 'class="od-grid ec-top"', "The AI insight": "data-chair-insight", "Talent by business group": "ec-bgs",
            "Your leaders' Talent Box": 'data-chair-step="leaders"'}
    s.check("the elements those stops point at are on his dashboard", all(v in ch_page for v in sels.values()), [k for k, v in sels.items()
                                                                                                          if v not in ch_page])
    s.check("...and on no one else's, so the stops never show for them", not any(v in bc_page for v in sels.values())
            and "ec-top" not in bc_page)
    s.check("the tour filters its stops by only / not before looking for them",
            "(!s.only || document.querySelector(s.only)) && (!s.not || !document.querySelector(s.not))" in ONB)
    s.check("his stops name no result and no person", not any(w in ONB[ONB.index('"Your Year-End"'):ONB.index('"You are here"')]
                                                                for w in ("Zed", "UA", "OU")))

    # --------------------------------------------------------------------------------------------- OneHR Agent
    s.section("OneHR Agent: his welcome and brief, and the two boxes' own fixed words")
    def intro_steps(uid):
        def f(d):
            u_ = d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
            st = a.review_state(d, u_)
            return a._journey_intro_steps(d, u_, st, a._journey_active_stage(st, ""))
        return run(f)
    w_ch, w_bc = intro_steps(CH), intro_steps(BC)
    text_ch = " ".join(x["say"] for x in w_ch)
    s.check("his welcome says the 360 is his part and names the Group Talent Box and his leaders' Talent Box, and offers no KPI check-in",
            w_ch and "360" in text_ch and "Group Talent Box" in text_ch and "leaders' Talent Box" in text_ch
            and "Performance Management" not in text_ch and "KPI check-in" not in w_ch[0]["say"] + w_ch[1]["say"], text_ch[:240])
    s.check("a BG CEO's welcome is the ordinary one (nothing of his)", not w_bc or "Group Talent Box" not in " ".join(x["say"] for x in w_bc))

    def agent_prompt(uid):
        def f(d):
            u_ = d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
            st = a.review_state(d, u_)
            return a._journey_agent_system(d, u_, st, a._journey_active_stage(st, ""))
        return run(f)
    p_ch, p_bc = agent_prompt(CH), agent_prompt(BC)
    s.check("his chat's prompt is built (a string)", isinstance(p_ch, str) and len(p_ch) > 500, (type(p_ch), str(p_ch)[:80]))
    s.check("his chat's prompt carries the brief (the 360 alone; the boxes are views of their own; never read a band out) and the "
            "scope guard still follows it", a._CHAIR_MINE_BRIEF in p_ch and a._AGENT_SCOPE_GUARD in p_ch
            and p_ch.index(a._CHAIR_MINE_BRIEF) < p_ch.rindex(a._AGENT_SCOPE_GUARD))
    s.check("nobody else's prompt carries it", a._CHAIR_MINE_BRIEF not in p_bc)
    for fn in ("_chair_group_turn", "_chairlead_turn"):
        body = SRC.split("def %s(" % fn)[1].split("\ndef ")[0]
        s.check("%s stays fixed words: no model, no agent prompt" % fn, "ai_draft" not in body and "review_agent" not in body
                and "_journey_team_agent_system" not in body and "_journey_agent_system" not in body)
    a.ai_draft.review_agent = boom
    r = CHC.post("/review/chat", data={"journey": "1", "view": "chairgrp", "stage": "chair_group", "csrf_token": "tok",
                                       "show": "talent"})
    jt = r.get_json()
    s.check("an insight link's turn says what the box is narrowed to, in fixed words, naming no one and no figure",
            r.status_code == 200 and "narrowed to" in jt["say"] and "Show everyone" in jt["say"]
            and not any(n in jt["say"] for n in NAMES) and not re.search(r"\d", jt["say"]), jt.get("say"))
    r = CHC.post("/review/chat", data={"journey": "1", "view": "chairgrp", "stage": "chair_group", "csrf_token": "tok"})
    s.check("...and without a link it is the box's opener, as before", "Group Talent Box" in r.get_json()["say"])

    # --------------------------------------------------------------------------------------------- user roles
    s.section("user access by user role: his routes follow the seat, not a module, and are classified")
    CH_EPS = ("admin_leaders_chair", "chair_person_summary", "chair_stars_download", "chair_leaders_move", "chair_leaders_lock",
              "chair_leaders_record", "chair_insight_make")
    s.check("every chair endpoint is registered and in CHAIR_ENDPOINTS", all(e in a.app.view_functions and e in a.CHAIR_ENDPOINTS
                                                                            for e in CH_EPS))
    s.check("none is in UROLE_ENDPOINTS: team and leader pages follow seats (the comment on that table), and the admin page is "
            "an admin's; his '360 only' role would otherwise shut his own boxes", not (set(CH_EPS) & set(a.UROLE_ENDPOINTS)))
    s.check("each of his review routes is classified in the module map (a test fails an unclassified route)", all(
        a.module_of_request(e, p_) == "review" for e, p_ in (
            ("chair_person_summary", "/review/chair/summary"), ("chair_stars_download", "/review/chair/stars.xlsx"),
            ("chair_leaders_move", "/review/chair/leaders/move"), ("chair_leaders_lock", "/review/chair/leaders/lock"),
            ("chair_leaders_record", "/review/chair/leaders/record"), ("chair_insight_make", "/review/chair/insight"))))
    # a '360 only' user role (Rate in the 360 on, the rest off), as the super admin configures it on Roles & access
    rid = None
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("INSERT INTO user_roles(name) VALUES ('ZZ9PK 360 only')")
        rid = d.execute("SELECT id FROM user_roles WHERE name='ZZ9PK 360 only'").fetchone()[0]
        d.execute("INSERT INTO user_role_modules(role_id, module) VALUES (?, 'tm_rate')", (rid,))
        d.commit()
    try:
        sql("UPDATE users SET user_role_id=? WHERE id=?", (rid, CH))
        s.check("control: that role shuts his own KPI check-in (a module it does not open)",
                run(lambda d: a.urole_allows(user(CH), "pm", d)) is False)
        r = CHC.post("/review/chair/insight", data={"csrf_token": "tok"})
        s.check("with that '360 only' role on him, the card's route still answers him (his routes are not held by the user-role gate)",
                r.status_code == 200, r.status_code)
        r = CHC.get("/review/chair/stars.xlsx")
        s.check("...and so does his download", r.status_code == 200, r.status_code)
    finally:
        sql("UPDATE users SET user_role_id=NULL WHERE id=?", (CH,))
        sql("DELETE FROM user_role_modules WHERE role_id=?", (rid,))
        sql("DELETE FROM user_roles WHERE id=?", (rid,))
finally:
    os.environ.pop("ONEHR_CHAIR", None)
    a.ai_draft.review_agent, a.ai_draft.review_agent_available = real_agent, real_avail
    sql("DELETE FROM app_settings WHERE key IN ('exec_chair_id','exec_chair_delegate_id','exec_chair_team')")

H.restore_db()
sys.exit(s.done())
