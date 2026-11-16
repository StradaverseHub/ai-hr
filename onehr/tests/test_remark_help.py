"""The remark help menu (Chris, 2026-09-28): every remark box's "Write with AI" (was "Help me word it") is a dropdown of three -- "Help me
write it", "Help me refine it", "Help me improve clarity" -- and a pick pre-fills the chat with a set prompt ending in
[ ] for them to say what they need. This suite proves:

  * the three set prompts are read back (_remark_help_intent): which one, and what they typed in the brackets
  * a set prompt is never saved as the remark, and never stopped by the scope screen
  * the per-turn steer: write drafts from their words (one question when there are none); refine / clarity rework
    the remark saved NOW, keeping every point and fact; competency stays in their own words
  * the KPI chat turn: the steer reaches the model, a "Yes, save it" chip, and "yes" saves the NEW wording with no
    model call -- never the old remark quoted beside it; nothing is saved before the yes
  * the line manager's turn: the same steer, "yes" saved by the server, a false "saved" corrected
  * the client: one dropdown at all four boxes, the prompt's cursor inside the brackets, the box saved first
  * the opening message describes the page as it is: modules along the top, progress on the left

The model is stubbed. Writes, so fresh.
"""
import inspect
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
import ai_draft  # noqa: E402
s = H.Suite("Remark help menu -- write / refine / improve clarity")

CHBM = "CHIN HIN BUILDING MATERIAL (CHBM)"
JS = open(os.path.join(H.REPO, "static", "journey_chat.js"), encoding="utf-8").read()
CSS = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
PRESETS = ("write", "refine", "clarity")
WORDS = "in about 50\u201310\u0030 words".replace("\u0030", "0")   # "in about 50–100 words"
# (noun, cover, writeFrom, ownWords) -- the four remark boxes, as the page builds them
SURFACES = [("my overall remark", "what went right and any challenges I faced", " from my KPI results and supporting files",
             False),
            ("my remark on Alice Tan", "what I've seen Alice do, with a concrete example", "", False),
            ("my overall competency remark", "my strengths and the areas I'm still developing", "", True),
            ("my overall remark for Bob Lee", "how Bob performed this period, with a concrete example", "", False)]


def preset(kind, noun, box="", cover="", wf="", own=False):
    """The page's set prompt (a mirror of journey_chat.js helpPrompt -- checked against it with node below)."""
    t = " ".join((box or "").split()).rstrip("]").strip()
    if kind == "write":
        return ("Help me write " + noun + wf + (" in my own words" if own else "") + ": " + (cover + ", " if cover else "")
                + WORDS + ("" if own else ", using the STAR method where it fits") + ". "
                + ("What I have so far: [" + t + "]" if t else "What I'd like it to cover: []"))
    if kind == "refine":
        return ("Help me refine " + noun + ": " + ("keep my own words and points, tidy the order and grammar" if own
                                                   else "keep my points and facts, make it more specific and confident")
                + ", " + WORDS + ", and tell me if anything important is missing. My remark: [" + t + "]")
    return ("Help me improve the clarity of " + noun + ": plain words, short sentences, a clear order and the same meaning"
            + (", in my own words" if own else "") + ", " + WORDS + ". My remark: [" + t + "]")


def post(client, url, **form):
    form.setdefault("csrf_token", "tok")
    return client.post(url, data=form)


# ---------------------------------------------------------------------------
s.section("the three set prompts are the page's, and the server reads them back")
BOXES = ["", "we have a good year ahead, we manage to secure a lot of sales order and it helps move our margin",
         "I hit the [GP] target and my team's delivery rate improved"]   # a remark may carry brackets of its own
import shutil as _sh
import subprocess as _sp
if _sh.which("node"):
    _fn = JS[JS.index("  var HELP_WORDS"):JS.index("  // o = {noun:")]
    _cases = [(k, n, c, w, o, b) for k in PRESETS for (n, c, w, o) in SURFACES for b in BOXES]
    _js = _fn + "\nconsole.log(JSON.stringify(" + json.dumps(_cases) + ".map(function (x) { return helpPrompt(x[0], "
    _js += "{noun: x[1], cover: x[2], writeFrom: x[3], ownWords: x[4]}, x[5]); })));"
    _out = json.loads(_sp.run(["node", "-e", _js], capture_output=True, text=True, timeout=30).stdout)
    _mine = [preset(k, n, b, c, w, o) for (k, n, c, w, o, b) in _cases]
    s.check("the page's prompts (journey_chat.js helpPrompt, run in node) are exactly what this suite sends",
            _out == _mine, [x for x in zip(_out, _mine) if x[0] != x[1]][:2])
else:
    s.check("SKIP: node isn't installed, so the page's prompts aren't compared here", True)
s.check("every prompt states the 50-100 words; refine / clarity carry the box text in 'My remark: [...]'",
        all(WORDS in preset(k, n, "x y z", c, w, o) for k in PRESETS for (n, c, w, o) in SURFACES)
        and preset("refine", "my overall remark", BOXES[1]).endswith("My remark: [" + BOXES[1] + "]"))
_ok = True
for k in PRESETS:
    for (n, c, w, o) in SURFACES:
        for b in BOXES:
            m = preset(k, n, b, c, w, o)
            hi = a._remark_help_intent(m)
            want_ok = hi and hi["kind"] == k and hi["want"] == b and (hi["text"] == b if b else True)
            if not want_ok:
                _ok = False
                print("   miss:", m, hi)
s.check("each prompt, empty or carrying their remark (brackets and all), reads back as its kind with exactly that text",
        _ok)
_kw = preset("write", "my overall remark", "the supplier deals", SURFACES[0][1], SURFACES[0][2])
_ki = a._remark_help_intent(_kw)
s.check("the KPI box's write prompt ('... from my KPI results and supporting files') reads back as write",
        _ki["kind"] == "write" and _ki["want"] == "the supplier deals"
        and not a._remark_like(_kw) and not ai_draft.screen_message(_kw))
_cut = "Help me refine my overall remark: keep my points and facts, " + WORDS + ". My remark: [we had a strong year and"
s.check("a prompt that lost its closing bracket still reads the remark", a._remark_help_intent(_cut)["text"]
        == "we had a strong year and")
s.check("typed the same way: 'can you help me polish my remark' is refine, 'help me refine my remark so it's clearer' "
        "is clarity, 'help me word my remark' is write",
        a._remark_help_intent("can you help me polish my remark")["kind"] == "refine"
        and a._remark_help_intent("help me refine my remark so it's clearer")["kind"] == "clarity"
        and a._remark_help_intent("help me word my remark")["kind"] == "write")
s.check("...and without brackets, what comes after the colon is what they want (an ask, not the remark)",
        a._remark_help_intent("Help me refine my overall remark. What I'd like to improve: make it shorter")["want"]
        == "make it shorter"
        and a._remark_help_intent("Help me refine my overall remark. What I'd like to improve: make it shorter")["text"]
        == "")
s.check("not a remark ask -> None ('help me write my development goal', 'help me attach a file', a remark itself)",
        a._remark_help_intent("Help me write my development goal") is None
        and a._remark_help_intent("help me attach a file") is None
        and a._remark_help_intent("I kept margins up on the big accounts all half.") is None)
_never = True
for k in PRESETS:
    for (n, c, w, o) in SURFACES:
        for want in BOXES + ["focus on the supplier deals and the margin result"]:
            m = preset(k, n, want, c, w, o)
            if a._remark_like(m) or not a._remark_message_error(m) or ai_draft.screen_message(m):
                _never = False
                print("   bad:", m, a._remark_like(m), a._remark_message_error(m), ai_draft.screen_message(m))
s.check("a set prompt is never saved as the remark, and the scope screen never stops it", _never)

# ---------------------------------------------------------------------------
s.section("the steer: write from their words; refine / clarity rework the remark saved now")
CUR = "I kept margins up on the big accounts and got every delivery out on time despite the rains."
w0 = a._remark_help_steer("account", {"kind": "write", "want": ""}, "", [])
s.check("write, nothing said -> ONE question, never a draft from nothing",
        "ONE simple question" in w0 and "Do NOT write a draft from nothing" in w0 and "draft NOW" not in w0)
w1 = a._remark_help_steer("account", {"kind": "write", "want": "supplier talks, GP 15.9"}, "",
                          ["supplier talks, GP 15.9"])
s.check("write, with their words -> the draft NOW, quoted, first person, STAR, their words carried",
        "HELP ME WRITE IT" in w1 and "draft NOW" in w1 and "double quotes" in w1 and "first person" in w1
        and "STAR" in w1 and "supplier talks, GP 15.9" in w1 and "nothing is saved until they say yes" in w1)
_rp = preset("refine", "my overall remark", CUR)
r1 = a._remark_help_steer("account", a._remark_help_intent(_rp), CUR, [CUR])
s.check("refine -> the refined version NOW, keeping every point and fact, on the remark from the brackets, with "
        "their request", "HELP ME REFINE IT" in r1 and "keep every point, fact and figure" in r1
        and "The remark to rework: " + json.dumps(CUR) in r1 and "Their request, in their words" in r1
        and "Do NOT ask what they'd like changed first" in r1)
s.check("...in about 50-100 words, never padding a short one with anything new (it asks for more instead)",
        "50-100 words (never over 100)" in r1 and "do NOT pad it" in r1 and "what would make it fuller" in r1)
_EDIT = CUR + " We also cut waste by half."
r2 = a._remark_help_steer("account", a._remark_help_intent(preset("refine", "my overall remark", _EDIT)), CUR, [_EDIT])
s.check("...their words edited in the brackets are what's reworked, not the saved remark",
        "The remark to rework: " + json.dumps(_EDIT) in r2)
r3 = a._remark_help_steer("account", {"kind": "refine", "want": "sound more confident", "text": ""}, CUR,
                          ["sound more confident"])
s.check("typed the old way (the brackets hold an ask), the saved remark is reworked and the ask aimed at",
        "The remark to rework: " + json.dumps(CUR) in r3 and '"sound more confident"' in r3)
c1 = a._remark_help_steer("account", {"kind": "clarity", "want": ""}, CUR, [])
s.check("clarity -> clearer (plain words, one idea a sentence), same meaning, within 50-100 words, never padded",
        "IMPROVE CLARITY" in c1 and "CLEARER" in c1 and "within 50-100 words" in c1 and "never padded" in c1
        and "make the whole remark clearer" in c1 and json.dumps(CUR) in c1)
e1 = a._remark_help_steer("account", {"kind": "refine", "want": ""}, "", [])
s.check("refine / clarity with nothing written -> says so and asks ONE question (no draft from nothing)",
        "NOTHING IS WRITTEN YET" in e1 and "ONE" in e1
        and "NOTHING IS WRITTEN YET" in a._remark_help_steer("account", {"kind": "clarity", "want": ""}, "", []))
e2 = a._remark_help_steer("account", {"kind": "refine", "want": "supplier talks"}, "", ["supplier talks"])
s.check("...but with words in the brackets, those start a first draft", "HELP ME WRITE IT" in e2 and "supplier talks" in e2)
t1 = a._remark_help_steer("competency", {"kind": "clarity", "want": ""}, CUR, [])
s.check("competency: reads like them, may explain their points but invents nothing (Chris, 2026-11-01), no STAR",
        "reading like them" in t1 and "you may NOT invent an example, event, person, figure or date" in t1
        and "STAR" not in t1 and "ONLY their own words" not in t1)
f1 = a._remark_help_steer("feedback", {"kind": "write", "want": "calm under pressure"}, "", ["calm under pressure"],
                          "Alice Tan (CHBM)")
s.check("360: about the colleague by first name", "about Alice" in f1)
m1 = a._remark_help_steer("pm_review", {"kind": "write", "want": "strong on suppliers"}, "", ["strong on suppliers"],
                          "Bob Lee")
s.check("line manager: their own remark on the report", "line manager's own remark on Bob" in m1)
wc = a._remark_help_steer("account", {"kind": "write", "want": ""}, CUR, [])
s.check("write with words already in the box -> builds on them (no question first)",
        "draft NOW" in wc and "their remark so far (build on it" in wc and json.dumps(CUR) in wc)
REC = "THEIR KPI RESULTS (from their table):\n- RH Gross Profit: 12 -- rated 3.0 of 5, Meets Expectation"
wr = a._remark_help_steer("account", {"kind": "write", "want": ""}, "", [], record=REC)
s.check("write with only the record -> drafts from the results and files, never inventing what they did",
        "draft NOW" in wr and REC in wr and "do NOT invent what they did" in wr
        and "ask ONE short question about what they did" in wr)
rr = a._remark_help_steer("account", {"kind": "refine", "want": ""}, CUR, [], record=REC)
s.check("refine with the record -> may bring in a result or figure from it, nothing else new",
        "bring in a result, rating or figure shown in their record" in rr and REC in rr)
_hs = a._remark_help_said([{"role": "user", "stage": "account",
                            "content": preset("write", "my overall remark", "supplier talks, GP 15.9")}])
s.check("what they've said is the brackets, not the set prompt's own words", _hs == ["supplier talks, GP 15.9"], _hs)

# ---------------------------------------------------------------------------
s.section("the episode: a help request carries to its yes, and the NEW wording is what's saved")
_h360 = [{"role": "user", "stage": "feedback", "content": preset("write", "my remark on Alice Tan", "x y z")}]
s.check("360: a request about THIS colleague carries; one naming someone else never does",
        a._remark_help_episode(_h360, "Alice Tan") and a._remark_help_episode(_h360, "Bob Lee") is None
        and a._remark_help_episode([{"role": "user", "stage": "feedback",
                                     "content": "help me refine my remark"}], "Bob Lee"))
NEW = "I protected margins on our largest accounts and delivered every order on time."   # shorter than CUR
_hq = [{"role": "user", "stage": "account", "content": preset("refine", "my overall remark", "")},
       {"role": "agent", "stage": "account", "content": 'Your remark now: "%s" Here is a refined version: "%s" Save it?'
        % (CUR, NEW)},
       {"role": "user", "stage": "account", "content": "Yes, save it"}]
s.check("their saved remark quoted beside the new wording is never the draft; the last new quote is",
        a._journey_approved_draft(_hq, exclude=CUR, last=True) == NEW)
s.check("...a plain draft pick keeps its old rule (the longest quote)", a._journey_approved_draft(_hq) in (CUR, NEW))
_lapse = _h360 + [{"role": "agent", "stage": "feedback", "content": "What stood out?"}] + [
    {"role": r, "stage": "feedback", "content": "ok"} for r in ("user", "agent", "user", "agent", "user")]
s.check("a help request lapses after a few of their messages (it doesn't hijack the chat)",
        a._remark_help_episode(_lapse, "Alice Tan") is None
        and a._remark_help_episode(_lapse[:3], "Alice Tan") is not None)
_it = [{"role": "user", "stage": "account", "content": preset("refine", "my overall remark", "we have a good year ahead")},
       {"role": "agent", "stage": "account", "content": '"We have a strong year ahead." To make it fuller, add an example. '
                                                         'Save it?'},
       {"role": "user", "stage": "account", "content": "market demand grew as property development bloomed"},
       {"role": "agent", "stage": "account", "content": '"We had a good year, supported by demand as property development '
                                                         'bloomed." Save this wording or change anything?'},
       {"role": "user", "stage": "account", "content": "our production downtime decreases, so we pushed more volume"},
       {"role": "agent", "stage": "account", "content": '"Production downtime fell, so we raised volume and fulfilled more '
                                                         'orders." Would you like me to save this wording?'},
       {"role": "user", "stage": "account", "content": "Yes, save it"}]
s.check("a help request stays live through rounds of refining while every reply is on the remark (Chris, 2026-09-28)",
        a._remark_help_episode(_it) is not None)
s.check("...and 'yes' right after a quoted draft that asked to save is an approval at any step",
        a._remark_save_approved("Yes, save it", _it))
s.check("...not when the agent quoted something without offering to save it (a descriptor, 'does this sound right?')",
        not a._remark_save_approved("yes", [{"role": "agent", "content": 'Your competency reads "Plans production to '
                                                                           'meet the weekly schedule". Does this fit?'},
                                            {"role": "user", "content": "yes"}]))
_off = _it[:2] + [{"role": "user", "stage": "account", "content": "what's my DMC target?"},
                  {"role": "agent", "stage": "account", "content": "Your Direct Materials Cost target is 42%."},
                  {"role": "user", "stage": "account", "content": "ok"}]
s.check("...but lapses once the chat moves off the remark", a._remark_help_episode(_off) is None)
_src = inspect.getsource(a._ai_draft_sources)
s.check("competency: the remark already saved is a source for the AI-draft check when a refine is approved",
        "_journey_current_remark(db, u, cid, stage, focus)" in _src
        and "_ai_draft_check" in inspect.getsource(a._remark_draft_ok))
_tidy = ("I am strong at cost analysis and supplier negotiation, and I am still developing my demand forecasting "
         "and budgeting skills.")
_hist_c = [{"role": "user", "content": preset("clarity", "my overall competency remark", "")},
           {"role": "agent", "content": '"%s" Save it?' % _tidy}, {"role": "user", "content": "yes"}]
_box = ("strong at cost analysis and supplier negotiation i am, still developing demand forecasting and budgeting "
        "skills is what I am")
s.check("...without it a tidy of the box text is refused; with it, it passes (strict, their own words)",
        a._remark_grounding_error(_hist_c, _tidy, extra="Cost Analysis", strict=True, ratio=0.0, floor=5)
        and not a._remark_grounding_error(_hist_c, _tidy, extra="Cost Analysis " + _box, strict=True, ratio=0.0,
                                          floor=5))

# ---------------------------------------------------------------------------
s.section("the KPI check-in turn: steer, chip, and the yes saves the new wording with no model call")
SCRIPT, SEEN = [], []


def stub(system, messages, timeout=90):
    SEEN.append(system)
    return SCRIPT.pop(0) if SCRIPT else {"say": "(no script)", "quick_replies": [], "action": None}


_avail, _agent = ai_draft.review_agent_available, ai_draft.review_agent
ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = stub
try:
    with a.app.app_context():
        db = a.get_db()
        CID = a.active_cycle_id(db)
        db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','evidence','tm','idp','pm')")
        db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
        db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES('review_unified','1')")
        if not db.execute("SELECT 1 FROM pm_bg_config WHERE business_group=?", (CHBM,)).fetchone():
            db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (CHBM,))
        us = [dict(r) for r in db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL "
                                          "ORDER BY id LIMIT 3 OFFSET 20").fetchall()]
        EMP, MGR, REP = us[0], us[1], us[2]
        for uid in (EMP["id"], REP["id"]):
            db.execute("DELETE FROM pm_kpi_targets WHERE subject_id=? AND cycle_id=?", (uid, CID))
            db.execute("DELETE FROM pm_overall_remarks WHERE subject_id=? AND cycle_id=?", (uid, CID))
            db.execute("DELETE FROM pm_review_session WHERE subject_id=?", (uid,))
        db.execute("DELETE FROM pm_review_chat WHERE subject_id=?", (EMP["id"],))

        def kpi(subj, name, rates):
            return db.execute(
                "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
                "rate1, rate2, rate3, rate4, rate5) VALUES (?,?,?,50.0,'more','approved',?,?,?,?,?,?)",
                (CID, subj, name, CHBM) + tuple(rates)).lastrowid
        EGP = kpi(EMP["id"], "RH Gross Profit", (9, 11, 12, 13, 15))
        EDM = kpi(EMP["id"], "RH Deliveries", (1, 2, 3, 4, 5))
        db.commit()

    def key(vals):
        with a.app.app_context():
            x = a.get_db()
            x.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (?,?)", (EGP, EDM))
            for k_, v_ in zip((EGP, EDM), vals):
                if v_ is not None:
                    x.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) "
                              "VALUES (?,?,?,1)", (k_, v_, EMP["id"]))
            x.commit()

    def remark():
        return H.one(a, "SELECT (SELECT remark FROM pm_overall_remarks WHERE subject_id=? AND cycle_id=?)",
                     (EMP["id"], CID)) or ""

    C = H.client_as(a, EMP["id"])
    key((12, 3))   # both Meets -> no file owed
    post(C, "/review/kpi/remark", remark=CUR, stage="account")
    s.check("setup: the remark is in the box", remark() == CUR)

    SEEN[:] = []
    SCRIPT[:] = [{"say": 'Your remark now: "%s" Here is a refined version: "%s" Want me to save this as your remark?'
                  % (CUR, NEW), "quick_replies": ["Make it shorter"], "action": None}]
    j1 = post(C, "/review/chat?journey=1", message=preset("refine", "my overall remark", CUR),
              stage="account").get_json() or {}
    _sys1 = SEEN[0] if SEEN else ""
    s.check("refine (the box pulled into the brackets): the steer reaches the model, with that remark and their request",
            "HELP ME REFINE IT" in _sys1 and "The remark to rework: " + json.dumps(CUR) in _sys1
            and "Their request, in their words" in _sys1, len(SEEN))
    s.check("...not the Redraft-button steer ('do not write the new version for them')",
            "THEY JUST ASKED TO REDRAFT" not in _sys1)
    s.check("the reply keeps the new wording and offers 'Yes, save it' first",
            NEW in (j1.get("say") or "") and (j1.get("quick_replies") or [None])[0] == "Yes, save it",
            (j1.get("say"), j1.get("quick_replies")))
    s.check("...no final card yet, and nothing saved before the yes",
            not any(r.get("type") == "confirm" for r in (j1.get("renders") or [])) and remark() == CUR)

    SEEN[:] = []
    j2 = post(C, "/review/chat?journey=1", message="Yes, save it", stage="account").get_json() or {}
    s.check("'Yes, save it' saves the NEW wording -- not the old remark quoted beside it -- with no model call",
            remark() == NEW and not SEEN and "saved" in (j2.get("say") or ""), (remark(), len(SEEN), j2.get("say")))
    s.check("...and brings the live KPI table down, opened at the Remarks box, to check and Save (Chris: 'it should "
            "spawn the kpi table ... for me to view and save') -- not the final card yet",
            [r.get("type") for r in (j2.get("renders") or [])] == ["kpi_progress"]
            and (j2.get("renders") or [{}])[0].get("remark") is True and not (j2.get("renders") or [{}])[0].get("soft")
            and "tap Save & submit" in (j2.get("say") or "")
            and ((j2.get("overview") or {}).get("data") or {}).get("overall_remark") == NEW, j2.get("renders"))
    # edit further, the same route: refine again -> yes -> the table again
    NEW2 = "I protected margins on our largest accounts, delivered every order on time and kept customers loyal."
    SCRIPT[:] = [{"say": 'Refined again: "%s" Save it?' % NEW2, "quick_replies": [], "action": None}]
    post(C, "/review/chat?journey=1", message=preset("refine", "my overall remark", NEW), stage="account")
    SEEN[:] = []
    j2b = post(C, "/review/chat?journey=1", message="Yes, save it", stage="account").get_json() or {}
    s.check("...and can go round again: refine the saved remark, yes, the table again with the new wording",
            remark() == NEW2 and not SEEN and [r.get("type") for r in (j2b.get("renders") or [])] == ["kpi_progress"],
            (remark(), len(SEEN), j2b.get("renders")))
    # their Save on the table (only the remark to save) -> Save & submit is next (one card per part, 2026-09-29)
    SEEN[:] = []
    j2c = post(C, "/review/chat?journey=1", message="I've saved my remark.", stage="account").get_json() or {}
    s.check("...their Save on the table then points to Save & submit (no final card), with the remark in, no model call",
            [r.get("type") for r in (j2c.get("renders") or [])] == ["kpi_progress"] and not SEEN
            and "Save & submit" in (j2c.get("say") or "")
            and ((j2c.get("overview") or {}).get("data") or {}).get("overall_remark") == NEW2,
            (j2c.get("say"), [r.get("type") for r in (j2c.get("renders") or [])]))
    with a.app.app_context():   # back to NEW for the checks below
        x = a.get_db()
        x.execute("UPDATE pm_overall_remarks SET remark=? WHERE subject_id=? AND cycle_id=?", (NEW, EMP["id"], CID))
        x.commit()

    # clarity, empty brackets: a reply that asks first gets one more call, told to write it now
    SEEN[:] = []
    CLEAR = "I protected margins on our biggest accounts. I delivered every order on time, even in the rainy season."
    SCRIPT[:] = [{"say": "Which part would you like clearer?", "quick_replies": [], "action": None},
                 {"say": 'Here it is, clearer: "%s" Save it?' % CLEAR, "quick_replies": [], "action": None}]
    j3 = post(C, "/review/chat?journey=1", message=preset("clarity", "my overall remark", NEW),
              stage="account").get_json() or {}
    s.check("clarity (the box in the brackets): the steer is on that remark, and a reply asking first gets "
            "one more call that writes it", len(SEEN) == 2 and "IMPROVE CLARITY" in SEEN[0] and json.dumps(NEW) in SEEN[0]
            and CLEAR in (j3.get("say") or ""), (len(SEEN), j3.get("say")))
    s.check("...still nothing saved", remark() == NEW)
    post(C, "/review/chat?journey=1", message="no, keep the one I have", stage="account")

    # they edit the remark inside the brackets before sending: "yes" saves the agent's NEW wording -- never the saved
    # remark, never the edited text they sent (both may be quoted back)
    _ED = NEW + " We also cut waste by half."
    _EDN = "I protected margins on our largest accounts, delivered every order on time and halved waste."
    SEEN[:] = []
    SCRIPT[:] = [{"say": 'Refined: "%s" -- compared with what you sent: "%s". Save it?' % (_EDN, _ED),
                  "quick_replies": [], "action": None}]
    post(C, "/review/chat?journey=1", message=preset("refine", "my overall remark", _ED), stage="account")
    s.check("edited in the brackets: the steer works on their edited text",
            SEEN and ("The remark to rework: " + json.dumps(_ED)) in SEEN[0])
    SEEN[:] = []
    post(C, "/review/chat?journey=1", message="Yes, save it", stage="account")
    s.check("...and 'yes' saves the new wording, not the edited text they sent", remark() == _EDN and not SEEN, remark())

    # write with nothing in the brackets but a remark in the box: it builds on the box (a draft is owed now)
    SEEN[:] = []
    SCRIPT[:] = [{"say": "Happy to -- what's one thing that stood out this half?", "quick_replies": [], "action": None},
                 {"say": 'Building on yours: "%s" Save it?' % CLEAR, "quick_replies": [], "action": None}]
    j4 = post(C, "/review/chat?journey=1", message=preset("write", "my overall remark"), stage="account").get_json() or {}
    s.check("write with nothing in the brackets but words in the box: the steer builds on the box, and a reply that "
            "only asks gets one more call that drafts",
            len(SEEN) == 2 and "their remark so far (build on it" in SEEN[0] and json.dumps(_EDN) in SEEN[0]
            and CLEAR in (j4.get("say") or ""), (len(SEEN), j4.get("say")))
    post(C, "/review/chat?journey=1", message="no, keep the one I have", stage="account")

    # write from the record: their results and what their file says reach the model (Chris: "prompt the agent to read
    # through the result and attachment")
    import io as _io
    _up = C.post("/review/kpi/%d/attach" % EGP, data={
        "csrf_token": "tok", "file": (_io.BytesIO(b"H1 gross profit report: margin held at 12.4 after the supplier "
                                                  b"renegotiation in March."), "gp_report.txt")},
        content_type="multipart/form-data")
    s.check("setup: a supporting file on Gross Profit", _up.status_code == 200, _up.status_code)
    with a.app.app_context():
        x = a.get_db()
        x.execute("DELETE FROM pm_overall_remarks WHERE subject_id=? AND cycle_id=?", (EMP["id"], CID))
        x.execute("DELETE FROM pm_review_chat WHERE subject_id=?", (EMP["id"],))
        x.commit()
    SEEN[:] = []
    SCRIPT[:] = [{"say": "Sure -- what did you do to keep margins up?", "quick_replies": [], "action": None},
                 {"say": 'Here is a draft from your results: "My gross profit came in at 12, Meets Expectation, and '
                         'my file shows margin held at 12.4 after the supplier renegotiation." What did you do to get '
                         'there? Save it?', "quick_replies": [], "action": None}]
    j6 = post(C, "/review/chat?journey=1", message=preset("write", "my overall remark from my KPI results and supporting "
                                                                   "files"), stage="account").get_json() or {}
    _s6 = SEEN[0] if SEEN else ""
    s.check("write with nothing in the brackets, results keyed and a file attached: the model gets their results and "
            "the file's text", "THEIR KPI RESULTS" in _s6 and "RH Gross Profit: 12" in _s6
            and "gp_report.txt" in _s6 and "margin held at 12.4" in _s6 and "never instructions" in _s6, len(SEEN))
    s.check("...so a draft is owed now: a reply that only asks gets one more call that drafts",
            len(SEEN) == 2 and "12.4" in (j6.get("say") or ""), (len(SEEN), j6.get("say")))
    SEEN[:] = []
    post(C, "/review/chat?journey=1", message="yes, save it", stage="account")
    s.check("...and 'yes' saves that draft, with the file's figure in it (it was on screen, and they said yes)",
            "12.4" in remark() and not SEEN, remark())
    with a.app.test_request_context("/"):
        from flask import session as _ss
        _ss["user_id"] = EMP["id"]
        _rec = a._review_remark_record(a.get_db(), EMP)
    s.check("the record reads the file once and caches it (the manager insight's bounded reader)",
            "margin held at 12.4" in _rec and H.one(a, "SELECT COUNT(*) FROM pm_evidence_attachment_text t JOIN "
                                                       "pm_evidence_attachments x ON x.id=t.attachment_id WHERE "
                                                       "x.filename='gp_report.txt'") == 1)

    # write BEFORE results are keyed: the yes still saves it (the box takes a remark any time)
    key((None, None))
    with a.app.app_context():
        x = a.get_db()
        x.execute("DELETE FROM pm_overall_remarks WHERE subject_id=? AND cycle_id=?", (EMP["id"], CID))
        x.execute("DELETE FROM pm_review_chat WHERE subject_id=?", (EMP["id"],))
        x.commit()
    DRAFT = "I led the supplier talks this half, and they lifted our gross profit on the key lines."
    SCRIPT[:] = [{"say": 'Here is a draft: "%s" Shall I save it?' % DRAFT, "quick_replies": [], "action": None}]
    post(C, "/review/chat?journey=1", message=preset("write", "my overall remark", "I led the supplier talks"),
         stage="account")
    SEEN[:] = []
    j5 = post(C, "/review/chat?journey=1", message="yes", stage="account").get_json() or {}
    s.check("before any result is keyed, 'yes' to a written draft still saves it (no model call)",
            remark() == DRAFT and not SEEN, (remark(), len(SEEN), j5.get("say")))
    s.check("...and says what's next in plain words (never the raw 'still to key:')",
            "Next, enter your result for RH Gross Profit, RH Deliveries and tap Save" in (j5.get("say") or "")
            and "still to key" not in (j5.get("say") or ""), j5.get("say"))
    s.check("...and brings the live KPI table down under the reply (Chris: 'rather than asking user to scroll back up')",
            [r.get("type") for r in (j5.get("renders") or [])] == ["kpi_progress"]
            and not any(r.get("soft") for r in (j5.get("renders") or [])) and "just below" in (j5.get("say") or ""),
            j5.get("renders"))

    # Chris's case (2026-09-28): refine, two rounds of adding detail, then "Yes, save it" -- with the results NOT saved
    key((None, None))
    with a.app.app_context():
        x = a.get_db()
        x.execute("DELETE FROM pm_overall_remarks WHERE subject_id=? AND cycle_id=?", (EMP["id"], CID))
        x.execute("DELETE FROM pm_review_chat WHERE subject_id=?", (EMP["id"],))
        x.commit()
    _BOX = "we have a good year ahead, we manage to secure a lot of sales order and it helps move our margin"
    post(C, "/review/kpi/remark", remark=_BOX, stage="account")
    _D1 = "We secured a strong volume of sales orders this year, which helped improve our margin."
    _D2 = "We had a good year, supported by demand as property development bloomed, and our margin improved."
    _D3 = ("We had a good year, supported by demand as property development bloomed. Production downtime fell, which "
           "let us raise volume and fulfil more sales orders.")
    SCRIPT[:] = [{"say": '"%s" To make it fuller, you could add what drove it. Save it?' % _D1, "quick_replies": [],
                  "action": None},
                 {"say": '"%s" Would you like me to save this wording or change anything?' % _D2, "quick_replies": [],
                  "action": None},
                 {"say": '"%s" Would you like me to save this wording or change anything?' % _D3, "quick_replies": [],
                  "action": None}]
    post(C, "/review/chat?journey=1", message=preset("refine", "my overall remark", _BOX), stage="account")
    post(C, "/review/chat?journey=1", message="there was a huge increase in market demand as property development bloomed",
         stage="account")
    _jd = post(C, "/review/chat?journey=1", message="our production downtime decreases, enables us to push for more "
                                                    "production volume and more sales order", stage="account").get_json()
    s.check("Chris's case: after two rounds the reply still offers 'Yes, save it' first",
            ((_jd or {}).get("quick_replies") or [None])[0] == "Yes, save it", (_jd or {}).get("quick_replies"))
    SEEN[:] = []
    _jy = post(C, "/review/chat?journey=1", message="Yes, save it", stage="account").get_json() or {}
    s.check("...'Yes, save it' saves the latest draft into the Remarks box, results or not, with no model call",
            remark() == _D3 and not SEEN and "saved" in (_jy.get("say") or "")
            and "enter your result" in (_jy.get("say") or ""), (remark(), len(SEEN), _jy.get("say")))
    s.check("...with the live table brought to the reply, the saved remark in its box",
            [r.get("type") for r in (_jy.get("renders") or [])] == ["kpi_progress"]
            and ((_jy.get("overview") or {}).get("data") or {}).get("overall_remark") == _D3,
            (_jy.get("renders"), ((_jy.get("overview") or {}).get("data") or {}).get("overall_remark")))
    # and without a help request: a quoted draft the agent offered to save, results not saved -> the yes saves it
    with a.app.app_context():
        x = a.get_db()
        x.execute("DELETE FROM pm_overall_remarks WHERE subject_id=? AND cycle_id=?", (EMP["id"], CID))
        x.execute("DELETE FROM pm_review_chat WHERE subject_id=?", (EMP["id"],))
        x.commit()
    _D4 = "I kept our margins steady on the key accounts and delivered every order on time this half."
    SCRIPT[:] = [{"say": 'Here\'s a draft: "%s" Shall I save it as your remark?' % _D4, "quick_replies": [],
                  "action": None}]
    post(C, "/review/chat?journey=1", message="can you put my margins and on-time delivery into a remark",
         stage="account")
    SEEN[:] = []
    post(C, "/review/chat?journey=1", message="yes please", stage="account")
    s.check("a 'yes' to any quoted draft the agent offered to save is saved by the server, before results are in",
            remark() == _D4 and not SEEN, (remark(), len(SEEN)))
    _st_src = inspect.getsource(a._journey_store_remark_text)
    s.check("competency and 360 saves bring their card down too while answers are still open",
            '"focus": not g["all_answered"]' in _st_src and '"focus": _ev' in _st_src
            and "remark box on your card, just below" in _st_src and "remark box on their card, just below" in _st_src)
    key((None, None))

    # nothing at all to go on (no results, no files, an empty box): ONE question, no second call
    with a.app.app_context():
        x = a.get_db()
        x.execute("DELETE FROM pm_overall_remarks WHERE subject_id=? AND cycle_id=?", (EMP["id"], CID))
        x.execute("DELETE FROM pm_evidence WHERE author_id=?", (EMP["id"],))
        x.execute("DELETE FROM pm_review_chat WHERE subject_id=?", (EMP["id"],))
        x.commit()
    SEEN[:] = []
    SCRIPT[:] = [{"say": "Happy to -- what's one thing that stood out this half?", "quick_replies": [], "action": None}]
    j7 = post(C, "/review/chat?journey=1", message=preset("write", "my overall remark"), stage="account").get_json() or {}
    s.check("write with nothing to go on (no results, no files, an empty box): ONE question, and no second call",
            len(SEEN) == 1 and "ONE simple question" in SEEN[0] and "stood out" in (j7.get("say") or ""), len(SEEN))

    # --- "Help me elaborate it" on the KPI box (Chris, 2026-11-01): the thin line, and the record as a source for figures
    SEEN[:] = []
    SCRIPT[:] = [{"say": "SHOULD NOT BE ASKED", "quick_replies": [], "action": None}]
    j8 = post(C, "/review/chat?journey=1", message="Help me elaborate my overall remark: make what I wrote fuller, about "
              "70\u2013100 words, keeping my points and using my results and files where they help. My remark: [good year]",
              stage="account").get_json() or {}
    s.check("KPI: 'Help me elaborate it' on two words is the fixed line (a result and how you got there), no model call",
            not SEEN and "a result and how you got there" in (j8.get("say") or "")
            and (j8.get("say") or "").startswith("There isn't enough in what you've written"), (len(SEEN), j8.get("say")))
    SCRIPT[:] = []
    _REC = "THEIR KPI RESULTS (from their table):\n- RH Gross Profit: 12 -- rated 3.0 of 5, Meets Expectation"
    with a.app.test_request_context("/"):
        from flask import session as _fs
        _fs["user_id"] = EMP["id"]
        _fdb = a.get_db()
        _fu = dict(_fdb.execute("SELECT * FROM users WHERE id=?", (EMP["id"],)).fetchone())
        _hh = [{"role": "user", "content": "good year on suppliers"}]
        _ok = a._ai_draft_check(_fdb, _fu, CID, "account", None, _hh, "Our Gross Profit came in at 12 this half.", record=_REC)
        _no = a._ai_draft_check(_fdb, _fu, CID, "account", None, _hh, "Our Gross Profit came in at 15 this half.", record=_REC)
        _nr = a._ai_draft_check(_fdb, _fu, CID, "account", None, _hh, "Our Gross Profit came in at 12 this half.", record="")
    s.check("KPI: a figure in their record (12) may be used by an AI draft; one nobody gave (15) may not; without the record "
            "the same 12 is refused", _ok is None and "15" in (_no or "") and _nr is not None, (_ok, _no, _nr))

    # ------------------------------------------------------------------------
    s.section("the line manager's turn: the same steer; the server saves their yes")
    with a.app.app_context():
        db = a.get_db()
        RGP = kpi(REP["id"], "RM Gross Profit", (9, 11, 12, 13, 15))
        RDM = kpi(REP["id"], "RM Deliveries", (1, 2, 3, 4, 5))
        for k_, v_ in ((RGP, 12), (RDM, 3)):
            db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)",
                       (k_, MGR["id"]))
            db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,?,?,0)",
                       (k_, v_, REP["id"]))
        db.execute("DELETE FROM pm_manager_remarks WHERE subject_id=? AND submitted_by=?", (REP["id"], MGR["id"]))
        db.execute("DELETE FROM pm_manager_chat WHERE reviewer_id=?", (MGR["id"],))
        db.commit()

    def mrem():
        return H.one(a, "SELECT (SELECT remark FROM pm_manager_remarks WHERE subject_id=? AND submitted_by=?)",
                     (REP["id"], MGR["id"])) or ""
    M = H.client_as(a, MGR["id"])
    _first = (REP["full_name"] or "").split(" ")[0]
    MD = "%s kept margins on the key accounts and delivered on time, and I'd like to see more delegation next." % _first
    SEEN[:] = []
    SCRIPT[:] = [{"say": 'Here is a draft: "%s" Save it?' % MD, "quick_replies": [], "action": None}]
    t1 = post(M, "/review/chat?journey=1", message=preset("write", "my overall remark for " + REP["full_name"],
                                                          "kept margins, on time, should delegate more"),
              stage="pm_review", view="team", mode="detail", report=str(REP["id"])).get_json() or {}
    _ms = SEEN[0] if SEEN else ""
    s.check("the team turn gets the write steer, as the line manager's own remark",
            "HELP ME WRITE IT" in _ms and "line manager's own remark" in _ms
            and "kept margins, on time, should delegate more" in _ms, (len(SEEN), t1.get("say")))
    s.check("...offers 'Yes, save it', and nothing is saved yet",
            (t1.get("quick_replies") or [None])[0] == "Yes, save it" and mrem() == "", (t1.get("quick_replies"), mrem()))
    SEEN[:] = []
    t2 = post(M, "/review/chat?journey=1", message="Yes, save it", stage="pm_review", view="team", mode="detail",
              report=str(REP["id"])).get_json() or {}
    s.check("'Yes, save it' saves exactly the quoted wording through the one writer, with no model call",
            mrem() == MD and not SEEN and "saved" in (t2.get("say") or "") and t2.get("remark_saved"),
            (mrem(), len(SEEN), t2.get("say")))
    SEEN[:] = []
    MN = "%s protected margins on the key accounts and delivered every order on time; next, more delegation." % _first
    SCRIPT[:] = [{"say": 'I\'ve saved your refined remark: "%s"' % MN, "quick_replies": [], "action": None}]
    t3 = post(M, "/review/chat?journey=1", message=preset("refine", "my overall remark for " + REP["full_name"], ""),
              stage="pm_review", view="team", mode="detail", report=str(REP["id"])).get_json() or {}
    s.check("refine: the steer carries their saved remark", SEEN and json.dumps(MD) in SEEN[0], len(SEEN))
    s.check("...a reply claiming it's saved (nothing was) is corrected, and the remark is unchanged",
            "Nothing is saved yet" in (t3.get("say") or "") and "I've saved" not in (t3.get("say") or "")
            and mrem() == MD, (t3.get("say"), mrem()))

    # --- "Help me elaborate it" (Chris, 2026-11-01) on the line manager's box: the thin line, the check before showing,
    # and the server's "yes" running the same AI-draft check
    def _elab_m(box):
        return ("Help me elaborate my overall remark for " + REP["full_name"] + ": make what I wrote fuller, about 70\u2013100 "
                "words, keeping my points and adding no new examples, figures or claims. My remark: [" + box + "]")
    with a.app.app_context():
        x = a.get_db()
        x.execute("DELETE FROM pm_manager_remarks WHERE subject_id=? AND submitted_by=?", (REP["id"], MGR["id"]))
        x.execute("DELETE FROM pm_manager_chat WHERE reviewer_id=?", (MGR["id"],))
        x.commit()
    SEEN[:] = []
    SCRIPT[:] = [{"say": "SHOULD NOT BE ASKED", "quick_replies": [], "action": None}]
    e1 = post(M, "/review/chat?journey=1", message=_elab_m("good with suppliers"), stage="pm_review", view="team",
              mode="detail", report=str(REP["id"])).get_json() or {}
    s.check("manager: 'Help me elaborate it' on three words is the fixed line, with the manager's wording (something they did "
            "and the result it had), and no model call",
            not SEEN and (e1.get("say") or "").startswith("There isn't enough in what you've written for me to make it longer")
            and ("something %s did and the result it had" % _first) in (e1.get("say") or "") and mrem() == "",
            (len(SEEN), e1.get("say")))
    MFULL = ("%s kept margins steady on the key accounts and delivered every order on time this half. That matters because "
             "those accounts carry most of our volume, and %s handled supplier talks calmly while the schedule was tight. "
             "I would like to see more delegation next half, so the team can carry more of the load." % (_first, _first))
    MBAD = MFULL + " %s raised margins by 8%% for Acme Corp." % _first
    BOXM = "%s kept margins on the key accounts and delivered on time, and I'd like to see more delegation next" % _first
    SEEN[:] = []
    SCRIPT[:] = [{"say": 'Here is a fuller version: "%s" Check it reads like you. Shall I save it?' % MBAD, "quick_replies": [],
                  "action": None},
                 {"say": 'Fixed: "%s" Check it reads like you and change anything that isn\'t right. Shall I save it?' % MFULL,
                  "quick_replies": [], "action": None}]
    e2 = post(M, "/review/chat?journey=1", message=_elab_m(BOXM), stage="pm_review", view="team", mode="detail",
              report=str(REP["id"])).get_json() or {}
    s.check("manager: a draft that adds '8%' and 'Acme Corp' is never shown -- one more call, and the fixed draft is shown with "
            "'Yes, save it' then 'Change it'",
            len(SEEN) == 2 and MFULL in (e2.get("say") or "") and "8%" not in (e2.get("say") or "")
            and (e2.get("quick_replies") or [])[:2] == ["Yes, save it", "Change it"] and mrem() == "",
            (len(SEEN), e2.get("say"), e2.get("quick_replies")))
    SEEN[:] = []
    e3 = post(M, "/review/chat?journey=1", message="Yes, save it", stage="pm_review", view="team", mode="detail",
              report=str(REP["id"])).get_json() or {}
    s.check("...'Yes, save it' saves that fuller draft exactly (no model call): it passed the same check before it was shown",
            mrem() == MFULL and not SEEN and e3.get("remark_saved"), (mrem(), len(SEEN)))
    with a.app.app_context():
        x = a.get_db()
        x.execute("DELETE FROM pm_manager_remarks WHERE subject_id=? AND submitted_by=?", (REP["id"], MGR["id"]))
        x.execute("DELETE FROM pm_manager_chat WHERE reviewer_id=?", (MGR["id"],))
        for role_, text_ in (("user", _elab_m(BOXM)), ("agent", 'Here you go: "%s" Shall I save it?' % MBAD)):
            x.execute("INSERT INTO pm_manager_chat(reviewer_id, cycle_id, report_id, stage, role, content, scope) "
                      "VALUES (?,?,?,'pm_review',?,?,?)", (MGR["id"], CID, REP["id"], role_, text_, a._mchat_scope("pm_review")))
        x.commit()
    SEEN[:] = []
    SCRIPT[:] = [{"say": "SHOULD NOT BE ASKED", "quick_replies": [], "action": None}]
    e4 = post(M, "/review/chat?journey=1", message="Yes, save it", stage="pm_review", view="team", mode="detail",
              report=str(REP["id"])).get_json() or {}
    s.check("manager: 'Yes, save it' on an old draft with an invented figure and name saves NOTHING, with no model call, and "
            "the server says it could not write that without adding details",
            mrem() == "" and not SEEN and "details you haven't given" in (e4.get("say") or "")
            and not e4.get("remark_saved") and not (e4.get("quick_replies") or []), (mrem(), len(SEEN), e4.get("say")))
    SCRIPT[:] = []
    with a.app.app_context():
        x = a.get_db()
        x.execute("DELETE FROM pm_manager_chat WHERE reviewer_id=?", (MGR["id"],))
        x.execute("DELETE FROM pm_manager_remarks WHERE subject_id=? AND submitted_by=?", (REP["id"], MGR["id"]))
        x.commit()

    # one shot on the manager's box too (Chris, 2 Nov): enough to go on and a question instead of a draft -> the one extra call
    _seen_m = []

    def _stub_m(system, messages, timeout=90):
        _seen_m.append(system)
        return SCRIPT.pop(0) if SCRIPT else {"say": "(no script)", "quick_replies": [], "action": None}
    _agent_m = ai_draft.review_agent
    ai_draft.review_agent = _stub_m
    try:
        SCRIPT[:] = [{"say": "I can make that clearer, but there isn't enough here to expand. What's one example?",
                      "quick_replies": [], "action": None},
                     {"say": 'Fuller: "%s" Check it reads like you. Shall I save it?' % MFULL, "quick_replies": [], "action": None}]
        e5 = post(M, "/review/chat?journey=1", message=_elab_m(BOXM), stage="pm_review", view="team", mode="detail",
                  report=str(REP["id"])).get_json() or {}
        s.check("manager: a question instead of a draft with enough to go on is forced into the draft by the one extra call; "
                "the steer says there is enough and expands only their points",
                len(_seen_m) == 2 and MFULL in (e5.get("say") or "") and "THERE IS ENOUGH here to write it" in _seen_m[0]
                and "Expand only the points in their remark" in _seen_m[0], (len(_seen_m), e5.get("say")))
    finally:
        ai_draft.review_agent = _agent_m
        SCRIPT[:] = []
        with a.app.app_context():
            x = a.get_db()
            x.execute("DELETE FROM pm_manager_chat WHERE reviewer_id=?", (MGR["id"],))
            x.commit()

    # ------------------------------------------------------------------------
    s.section("the Team summary suggests people, not one person's KPIs (Chris, 2026-09-28)")
    _reps = [{"name": "Ann Lee", "done": False, "action": "Moderate 2 KPIs"}, {"name": "Bob Tan", "done": True},
             {"name": "Cy Ong", "done": False, "action": "Moderate 1 KPI"},
             {"name": "Dee Ng", "done": False, "action": None}]   # waiting on someone else: never offered (F9)
    s.check("one person's KPI chips on the summary become 'Review <name>' for the next ones it's your turn on",
            a._team_summary_chips(["Review Gross Profit", "Review Direct Materials Cost", "Show KPI table"], _reps)
            == ["Review Ann Lee", "Review Cy Ong"])
    s.check("...a chip naming someone, a part or a team-wide step stays",
            a._team_summary_chips(["Review Bob Tan", "Go to Competency Review", "Summarise my team"], _reps)
            == ["Review Bob Tan", "Go to Competency Review", "Summarise my team"])
    with a.app.test_request_context("/"):
        from flask import session as _ts
        _ts["user_id"] = MGR["id"]
        _d = a.get_db()
        _mu = dict(_d.execute("SELECT * FROM users WHERE id=?", (MGR["id"],)).fetchone())
        _mst = a.review_state(_d, _mu)
        _ps = a._journey_team_agent_system(_d, _mu, _mst, "pm_review", REP["id"], mode="summary")
        _pd = a._journey_team_agent_system(_d, _mu, _mst, "pm_review", REP["id"], mode="detail")
    s.check("the manager's prompt knows which view is on screen: the Team summary asks for people, a person's view "
            "names them", "ON SCREEN NOW: the TEAM SUMMARY" in _ps and "Suggest PEOPLE, not KPIs" in _ps
            and "ON SCREEN NOW: the TEAM SUMMARY" not in _pd and ("ON SCREEN NOW: %s's own table" % REP["full_name"]) in _pd)
    SEEN[:] = []
    SCRIPT[:] = [{"say": "Here's where your team stands.", "action": None,
                  "quick_replies": ["Review Gross Profit", "Review Direct Materials Cost", "Show KPI table"]}]
    _ts1 = post(M, "/review/chat?journey=1", message="how is my team doing?", stage="pm_review", view="team",
                mode="summary").get_json() or {}
    s.check("a Team summary turn: the model's one-person KPI chips are replaced by 'Review <name>'",
            _ts1.get("quick_replies") == ["Review %s" % REP["full_name"]], _ts1.get("quick_replies"))
    SEEN[:] = []
    SCRIPT[:] = [{"say": "Opening their table.", "quick_replies": [], "action": None}]
    _ts2 = post(M, "/review/chat?journey=1", message="Review %s" % REP["full_name"], stage="pm_review", view="team",
                mode="summary").get_json() or {}
    s.check("...and tapping 'Review <name>' opens that person's table",
            _ts2.get("mode") == "detail" and _ts2.get("report") == REP["id"], (_ts2.get("mode"), _ts2.get("report")))
finally:
    ai_draft.review_agent_available, ai_draft.review_agent = _avail, _agent

# ---------------------------------------------------------------------------
s.section("the client: one dropdown at all four remark boxes")
s.check("one builder, used by the KPI box, the 360 / competency card box and the line manager's two boxes (KPI, competency review: 2026-10-21)",
        JS.count("remarkHelpMenu({") == 4 and "function remarkHelpMenu(o)" in JS
        and 'noun: "my remark on " + rn + "\'s competency review"' in JS
        and 'helpNoun: "my remark on " + fname' in JS and 'helpNoun: "my overall competency remark"' in JS
        and 'noun: "my overall remark"' in JS and 'noun: "my overall remark for " + rn' in JS
        and "noun: o.helpNoun" in JS)
s.check("the KPI box's write prompt says it uses their results and files",
        'writeFrom: " from my KPI results and supporting files"' in JS and '(o.writeFrom || "")' in JS)
s.check("refine / clarity pull the box's words into the brackets; every prompt carries the 50-100 words",
        'helpPrompt(op.kind, o, ta0 ? ta0.value : "")' in JS and 'My remark: [" + t + "]"' in JS
        and 'var HELP_WORDS = "in about 50–100 words";' in JS)
s.check("the four choices, in order: write, elaborate, refine, clarity (Chris, 2026-11-01)",
        JS.index('label: "Help me write it"') < JS.index('label: "Help me elaborate it"')
        < JS.index('label: "Help me refine it"') < JS.index('label: "Help me improve clarity"'))
s.check("no single-prompt help button is left",
        'promptComposer("Help me write my overall remark.")' not in JS and "promptComposer(o.help)" not in JS)
s.check("a pick saves the box first, then pre-fills the chat with the cursor inside the brackets",
        "Promise.resolve(o.flush ? o.flush() : null)" in JS and "promptComposer(text, text.length - 1)" in JS
        and "input.setSelectionRange(caret, caret)" in JS)
s.check("refine and clarity need words in the box (greyed with a note otherwise)",
        "opts[i].disabled = needs && empty;" in JS and "Write a few words first" in JS)
s.check("after 'Yes, save it' the live card comes down opened at its remark box (the 360 / competency card on its "
        "last page)", "if (card.remark && !replay) { fo.change = remarkPageChange(); fo.after = showRemarkBox; }" in JS
        and "function remarkPageChange()" in JS and "if (opts.after) setTimeout(opts.after, 140);" in JS)
s.check("← / → page the side-strip card most in view (the live one wins a tie) -- never while typing, with a "
        "modifier, a greyed copy / snapshot, or a menu / pop-out open (Chris, 2026-09-28)",
        "function pagedStripInView()" in JS and 'e.key !== "ArrowLeft" && e.key !== "ArrowRight"' in JS
        and "/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)" in JS and "e.altKey || e.ctrlKey || e.metaKey || e.shiftKey" in JS
        and '[inert], .rv-stage-retired, .rv-stage-snapshot' in JS and '".modal-overlay, .rv-help-dd.rv-help-open, .hp:not([hidden])"' in JS
        and "b.click();" in JS)
s.check("the Career Plan outlines what still needs filling in red, by the plan's own rules, and clears it as it's "
        "filled (Chris, 2026-09-28)", "function cpMarkNeeds(box, plan)" in JS
        and 'rule === "all" ? empty(ta) : (rule === "any" && none)' in JS and "mark(mob, empty(mob));" in JS
        and "asp.forEach(function (el) { mark(el, !anyAsp); });" in JS
        and H.cvp(".rv-cp-need, .rv-cp-need:focus { border-color: #d64545 !important;") in CSS)
s.check("Career Plan Remove hides a saved goal's card: the card is hidden, and the .rv-cp-goal display rule can't beat [hidden]",
        'if (g.goal_id != null) { card.setAttribute("data-removed", "1"); card.hidden = true; }' in JS
        and "\n.rv-cp-goal { " in CSS and ".rv-cp-goal[hidden] { display: none; }" in CSS)
_dp = JS[JS.index("function buildDevPlan(plan)"):JS.index("function cpFieldRow(")]
_pa = JS[JS.index("function pinAhead(data)"):JS.index("function pinAhead(data)") + 700]
s.check("Career Plan heading reads 'goals filled in' (not 'complete'), in the live plan and the read-only pin",
        '" goals filled in"' in _dp and '" goals filled in"' in _pa
        and ' + " complete"' not in _dp and ' + " complete"' not in _pa
        and '" (shared — locked)"' in _dp and '" (opens at year-end)"' in _dp)
s.check("Career Plan heading recounts live from the cards on screen: skips removed cards, mirrors _idp_goal_ready's "
        "action rule, and is wired to Remove, Add a goal and typing",
        'rv-fb-head rv-cp-plan-head' in _dp and 'sec.cpRecount = function ()' in _dp
        and '.rv-cp-goal:not([data-removed])' in _dp.split("sec.cpRecount = function")[1].split("var list")[0]
        and 'rule === "all" ? acts.every(Boolean) : rule === "any" ? acts.some(Boolean) : true' in _dp
        and 'list.addEventListener("input", function () { sec.cpRecount(); });' in _dp
        and 'list.addEventListener("cp-recount"' in _dp
        and 'par.dispatchEvent(new CustomEvent("cp-recount"' in JS
        and "list.appendChild(cpGoalCard(null, plan));\n        sec.cpRecount();" in _dp
        and "planSec.cpRecount()" in JS[JS.index("function cpRefreshFromServer"):])
_cw = JS[JS.index("function careerPlanWidget(data)"):]
_cw = _cw[:_cw.index("box.setAttribute(\"data-goals-editable\"")]
_rf = JS[JS.index("function cpRefreshFromServer"):]
_rf = _rf[:_rf.index("return true;")]
s.check("Career Plan's top line follows the live goal count: cpRecount dispatches a bubbling cp-goals-count {ready, total} from its "
        "section; the widget box listens (scoped to its own header span, profile part untouched); the server-refresh recount "
        "runs on the new box's section before the swap, so the box listener is already attached",
        'sec.dispatchEvent(new CustomEvent("cp-goals-count", { bubbles: true, detail: { ready: ready, total: total } }));'
        in _dp.split("sec.cpRecount = function")[1].split("var list")[0]
        and 'rv-fb-head rv-cp-top-head' in _cw and 'headGoals.className = "rv-cp-top-goals"' in _cw
        and 'box.addEventListener("cp-goals-count", function (e) {' in _cw
        and 'headGoals.textContent = "Career Plan — goals " + (d.ready || 0) + "/" + (d.total || 0) + " filled in";' in _cw
        and "document.querySelector" not in _cw
        and 'document.createTextNode(" · profile "' in _cw and 'headText.className = "rv-cp-top-text"' in _cw
        and _rf.index("var fresh = careerPlanWidget(data)") < _rf.index("planSec.cpRecount()") < _rf.index("swapStageBody(fresh)"))
s.check("the manager summary's Remark column is left-aligned, the icon and verdict on one line (Chris, 2026-09-28)",
        'rin.className = "rv-rmk-in"' in JS and ".rv-rmk-in { display: flex; align-items: center; gap: 6px; }" in CSS
        and ".rv-mgr-sumtable .rv-rmk-th, .rv-mgr-sumtable .rv-rmk-cell { width: 1%; text-align: left;" in CSS)
s.check("a failed turn says what happened: a network drop (a typed message goes back in the box) vs a page error, "
        "logged to the console", 'console.error("[journey] turn failed:", err)' in JS and "gotReply = true;" in JS
        and "your message is back in the box" in JS and "something went wrong showing that reply" in JS)
s.check("no Redraft on any final card (Chris, 2026-09-28: 'we already have the edit function')",
        'textContent = "Redraft"' not in JS and 'rd.textContent = rem ? "Redraft"' not in JS)
s.check("the manager's rating pills show one decimal (3 -> 3.0) and the summary's score pills one width (Chris, "
        "2026-09-28)", "function fmtScore(v)" in JS and "n.toFixed(1)" in JS
        and 'sp.classList.add("rv-score-pill");' in JS and "fmtNum(r.score)" not in JS
        and ".rv-mgr-sumtable .rv-score-pill { display: inline-block; min-width: 6.2em; text-align: center;" in CSS)
s.check("client: after a switch the chips follow the view -- the Team summary offers the next people to review, a "
        "person's view starts clean, and a reload on the summary never shows one person's KPI chips",
        "function teamSummaryChips(ov, keepFrom)" in JS
        and 'setQuick(curMode === "summary" ? teamSummaryChips(j.overview) : []);' in JS
        and 'if (curView === "team" && curMode === "summary") setQuick(teamSummaryChips(j.overview, last && last.quick_replies));' in JS)
s.check("the line manager's box is saved before a chat turn too",
        'isMgr ? pmRemarkFlush() : null' in JS and "function pmRemarkFlush()" in JS)
s.check("closes on a pick, an outside click and Escape; arrow keys move through it",
        "closeHelpMenus();" in JS and 'e.key === "ArrowDown"' in JS and 'closest(".rv-help-dd")' in JS)
s.check("the menu floats over the page (the scrolling card never clips it), under the link or above it; a scroll "
        "closes it", "function placeHelpMenu(btn, menu)" in JS and "top = r.top - 6 - h" in JS
        and 'window.addEventListener("scroll"' in JS)
s.check("CSS: the menu is fixed to the page, over everything", ".rv-help-menu { position: fixed;" in CSS
        and ".rv-help-menu[hidden] { display: none; }" in CSS)

# ---------------------------------------------------------------------------
s.section("the opening message describes the page as it is (Chris, 2026-09-28)")
with a.app.app_context():
    db = a.get_db()
    _nm = db.execute("SELECT name FROM cycles WHERE id=?", (CID,)).fetchone()["name"]
    db.execute("UPDATE cycles SET name='2026 Year-End (staging)', half=2 WHERE id=?", (CID,))
    db.commit()


def opener(uid):
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = uid
        d = a.get_db()
        u = dict(d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())
        st = a.review_state(d, u)
        return a._journey_agent_system(d, u, st, a._journey_active_stage(st, ""), is_opener=True)


try:
    _o = opener(EMP["id"])
    _od = _o[_o.index("OPENING --"):].split("\n\n")[0]
    s.check("the tabs along the TOP are the modules (full names), the one you're in shows its steps",
            "the tabs along the TOP are the modules" in _od and "Performance Management (PM)" in _od
            and "Individual Development Plan (IDP)" in _od and "Results, Justification, Confirm" in _od)
    s.check("the LEFT panel shows progress in the part you're on (what's still to enter and what's done)",
            "the panel on the LEFT shows their progress in the part they're on" in _od
            and "the list on the LEFT is the parts" not in _od and "running score" in _od
            and "do NOT say the top shows a running score" in _od)
    s.check("the period without '(staging)'", "2026 Year-End" in _od and "(staging)" not in _od)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycles SET half=1 WHERE id=?", (CID,))
        db.commit()
    _om = opener(EMP["id"])
    _omd = _om[_om.index("OPENING --"):].split("\n\n")[0]
    s.check("Mid-Year: PM and TM only -- no IDP, no Career Plan in the order",
            "PM -> TM)" in _omd and "IDP" not in _omd and "Career Plan" not in _omd)
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycles SET name=?, half=2 WHERE id=?", (_nm, CID))
        db.commit()

sys.exit(s.done())
