"""The competency overall remark under Chris's 1 Nov 2026 rule ("whatever written or drafted by our Write with AI, shouldn't
trigger any rejection. The rule i mentioned the AI writing must be from the person is meant for if they use external AI tool
like chatgpt or claude to draft and paste them in"). It began as OWN WORDS ONLY (the staging screenshot: a saved 19-word
remark, "Write with AI ... in about 50-100 words ... help me make it longer", and every padded draft refused on "Yes, save
it": a loop). Now our own drafts are free in their words and checked by ONE function (_ai_draft_check: no figure or capitalised
name nobody gave, within the ceiling, the stored-text screen) BEFORE they are shown and again on "Yes, save it". This suite
proves, on the competency remark:

  * the help steer asks for a fuller draft that explains their points and invents nothing, and for thin material it asks, in
    the chat, for at most two pieces from their own story (the Developing competencies named)
  * a fuller draft with many new explanatory words is SHOWN and "Yes, save it" saves it exactly as shown -- the old strict
    check would have refused it
  * a draft with an invented figure or name is never shown: the honest own-story line (reworded: it no longer says "I can't
    add to it for you"), no approve chip, in the journey and the classic competency chat
  * "Yes, save it" on a draft the check refuses (an old one): nothing saved, no model call, the same line
  * a bare "yes" with no quoted draft never saves junk or overwrites a saved remark; the help-episode fallback stays off

The model is stubbed. Writes, so fresh.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
import ai_draft  # noqa: E402
s = H.Suite("Competency remark -- Write with AI drafts are free in words, checked once, and say what to add in the chat")
assert "onehr-tests" in a.DB_PATH, a.DB_PATH

NOUN = "my overall competency remark"
SAVED = ("i guess im just good at working under pressure and i always put high standard on things i do")
PAD1 = ("I guess I'm just good at working under pressure and I always put high standards on things I do. I see these "
        "as strengths in my work, and I want to continue building on them.")
PAD2 = (PAD1 + " I take pride in staying composed, focused and dependable when deadlines tighten, and I keep "
        "strengthening the skills that help me deliver consistently.")
TIDY = ("I guess I'm just good at working under pressure and I always put high standards on things I do. "
        "An area I am still developing is my negotiation skill.")


def preset(extra=""):
    """The page's set prompt for 'Write with AI' on the competency remark, with the saved remark in the brackets."""
    return ("Help me write " + NOUN + " in my own words: my strengths and the areas I'm still developing, in about 50-100 "
            "words. What I have so far: [" + SAVED + "]" + extra)


def post(client, url, **form):
    form.setdefault("csrf_token", "tok")
    return client.post(url, data=form)


# ---------------------------------------------------------------------------
s.section("build: a confirmed employee, three competencies (two rated Developing), a saved 19-word remark")
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','tm')")
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES('review_unified','1')")
    D = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL "
                   "AND (confirmation_date IS NOT NULL OR years_of_service > 1) ORDER BY id LIMIT 1 OFFSET 7").fetchone()
    DID = D["id"]
    TITLES = ["Cost Analysis", "Negotiation Skills", "Production Planning"]
    sk = [db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_category, proficiency_description, "
                     "ability_items, active) VALUES (?,?,3,'Operations',?, '- do it', 1)",
                     ("ZZOS-%d" % i, t, t + " at level 3")).lastrowid for i, t in enumerate(TITLES)]
    AS = [db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, source) "
                     "VALUES (?,?,?,0,'profile')", (CID, DID, k)).lastrowid for k in sk]
    db.commit()
    DB_USER = dict(D)


def tool(name, args):
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = DID
        x = a.get_db()
        u = dict(x.execute("SELECT * FROM users WHERE id=?", (DID,)).fetchone())
        return a._tc_run_tool(x, u, CID, {"tool": name, "args": args})


for _a, _ans in zip(AS, ("yes", "no", "no")):
    tool("set_competency", {"assignment_id": _a, "answer": _ans})


def in_ctx(fn):
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = DID
        x = a.get_db()
        return fn(x, dict(x.execute("SELECT * FROM users WHERE id=?", (DID,)).fetchone()))


def set_remark(text):
    with a.app.app_context():
        x = a.get_db()
        x.execute("UPDATE tc_assessments SET overall_remark=? WHERE cycle_id=? AND subject_id=?", (text, CID, DID))
        x.commit()


def remark():
    return H.one(a, "SELECT overall_remark FROM tc_assessments WHERE cycle_id=? AND subject_id=?", (CID, DID)) or ""


def reset_chat():
    with a.app.app_context():
        x = a.get_db()
        x.execute("DELETE FROM pm_review_chat WHERE subject_id=? AND cycle_id=?", (DID, CID))
        x.commit()


def agent_said(text):
    with a.app.app_context():
        x = a.get_db()
        x.execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, stage) VALUES (?,?,'agent',?, "
                  "'competency')", (DID, CID, text))
        x.commit()


set_remark(SAVED)
s.check("setup: remark saved, all answered, Negotiation Skills and Production Planning are the Developing ones",
        remark() == SAVED and in_ctx(lambda x, u: a._tc_remark_gate(x, u, CID))["written"]
        and in_ctx(lambda x, u: a._tc_developing_titles(x, u)) == ["Negotiation Skills", "Production Planning"],
        in_ctx(lambda x, u: a._tc_developing_titles(x, u)))

# ---------------------------------------------------------------------------
s.section("the steer: a fuller draft that explains their points, nothing invented, thin material asks in the chat")
INT = a._remark_help_intent(preset())
st = a._remark_help_steer("competency", INT, SAVED, a._remark_help_said([{"role": "user", "content": preset()}]),
                          developing=["Negotiation Skills", "Production Planning"])
s.check("competency write: the draft NOW, 70-100 words (the preset's 50-100 is overruled), first person, reading like them",
        "write the draft NOW" in st and "aim at 70-100 words" in st and "aim at 70-100 words anyway" in st
        and "reading like them" in st, st[:300])
s.check("...it may explain their points (what a strength looks like in practice, why it matters) but may NOT invent an "
        "example, event, person, figure or date, nor a strength or development area they never mentioned",
        "what a strength looks like in practice, why it matters" in st
        and "you may NOT invent an example, event, person, figure or date" in st
        and "nor a strength or development area they never mentioned" in st)
s.check("...and the old tidy-only rules are gone", "NO minimum length" not in st and "tidy ONLY" not in st
        and "ONLY their own words" not in st and "never make it longer" not in st)
s.check("...the check-it line follows the draft, in the chat",
        "Check it reads like you and change anything that isn't right. Shall I save it?" in st)
s.check("...with ENOUGH to go on (19 words, two points) it says so plainly: write the draft in THIS reply, never a question "
        "instead, one optional 'If you'd like, add ...' line only AFTER it; the thin-path wording is not there",
        "THERE IS ENOUGH here to write it" in st and "never ask a question instead of the draft" in st
        and "never say there isn't enough" in st and "AFTER the draft" in st and "AT MOST TWO" not in st
        and "do NOT pad" not in st and "Never tell them to go back to the remark box" in st, st[-700:])
THIN = a._remark_help_steer("competency", {"kind": "write", "want": "", "text": ""}, "hardworking", [],
                            developing=["Negotiation Skills", "Production Planning"])
s.check("...with too little (one word) the honest path stays: what the remark says, AT MOST TWO pieces asked HERE IN THE CHAT "
        "(a strength's example, an area still developing), never back to the remark box",
        "AT MOST TWO" in THIN and "an example of a strength they named" in THIN and "an area they're still developing" in THIN
        and "do NOT pad" in THIN and "HERE IN THE CHAT" in THIN and "Never tell them to go back to the remark box" in THIN
        and "THERE IS ENOUGH" not in THIN)
s.check("...'Help me write it' may use their own card answers (the Developing competencies are named); elaborate never does",
        "You MAY draw on their own answers on the card" in st and "Negotiation Skills, Production Planning" in st
        and "Negotiation Skills" not in a._remark_help_steer(
            "competency", {"kind": "elaborate", "want": "", "text": SAVED}, SAVED, [SAVED],
            developing=["Negotiation Skills", "Production Planning"]))
s.check("...and what they've said is their saved remark (the preset's brackets) -- not repeated as 'what they told you'",
        json.dumps(SAVED) in st and "What they've told you since: []" in st, st[-300:])
sn = a._remark_help_steer("competency", INT, SAVED, [SAVED, "my negotiation skill i would say"])
s.check("...their later answer is carried, and with no Developing competency the steer says none is marked",
        "my negotiation skill i would say" in sn and "none is marked Developing" in sn)
sr = a._remark_help_steer("competency", {"kind": "refine", "want": "", "text": SAVED}, SAVED, [],
                          developing=["Negotiation Skills"])
sc_ = a._remark_help_steer("competency", {"kind": "clarity", "want": ""}, SAVED, [], developing=["Negotiation Skills"])
s.check("refine and clarity keep their own length (50-100) and take the same invent-nothing rule",
        "HELP ME REFINE IT" in sr and "HELP ME IMPROVE CLARITY" in sc_ and "about 50-100 words" in sr
        and "about 50-100 words" in sc_ and "you may NOT invent" in sr and "you may NOT invent" in sc_)
se = a._remark_help_steer("competency", {"kind": "elaborate", "want": "", "text": SAVED}, SAVED, [SAVED],
                          developing=["Negotiation Skills"])
s.check("elaborate (the menu's fourth option): ONE shot, quoted, 70-100 words, the check-it line, 'there is enough' (no thin "
        "path, no card titles), and it expands ONLY their points -- no new strength or area, not even from the card's ratings",
        "HELP ME ELABORATE IT" in se and "in ONE shot" in se and "aiming at 70-100 words" in se
        and "Check it reads like you" in se and "THERE IS ENOUGH here to write it" in se
        and "do NOT draft" not in se and "Negotiation Skills" not in se
        and "Explain and expand ONLY the points in their remark" in se
        and "Add NO new strength, development area" in se and "(its Demonstrate / Developing ratings or titles)" in se, se[:300])
s.check("nothing written and nothing said is still ONE question, never a draft from nothing",
        "NOTHING IS WRITTEN YET" in a._remark_help_steer("competency", {"kind": "refine", "want": ""}, "", [])
        and "ONE simple question" in a._remark_help_steer("competency", {"kind": "write", "want": ""}, "", []))
k1 = a._remark_help_steer("account", {"kind": "write", "want": "supplier talks"}, "", ["supplier talks"])
f1 = a._remark_help_steer("feedback", {"kind": "write", "want": "calm"}, "", ["calm"], "Alice Tan (CHBM)")
k2 = a._remark_help_steer("account", {"kind": "clarity", "want": ""}, SAVED, [])
s.check("KPI / 360 / manager write steers: 70-100 words now, still draft NOW with STAR; clarity keeps 50-100",
        "70-100 words" in k1 and "draft NOW" in k1 and "STAR" in k1 and "Do NOT ask for more details" in k1
        and "70-100 words" in f1 and "draft NOW" in f1 and "within 50-100 words" in k2
        and "NO minimum length" not in k1 + f1 + k2)
_dsteer = a._remark_draft_steer("competency", [{"role": "user", "content": "I rebuilt the monthly cost report"}])
s.check("'Draft with AI' (no help menu): 70-100 words on every stage, the competency one reads like them and invents nothing",
        "70-100 words" in _dsteer and "never pad it to reach a word count" not in _dsteer
        and "you may NOT invent an example, event, person, figure or date" in _dsteer
        and "70-100 words" in a._remark_draft_steer("account", [{"role": "user", "content": "I rebuilt the monthly cost report"}])
        and "40-100 words" not in a._remark_draft_steer("feedback", [{"role": "user", "content": "calm under pressure"}], "Al"))
_sys = " ".join(in_ctx(lambda x, u: a._competency_agent_system(x, u, a._tc_context(x, u, create=False), journey=True)).split())
s.check("the agent's own instructions: a draft may be fuller and explain their points, never adds an example, event, person, "
        "figure or date; a redraft's tips say what to ADD from their story, naming the Developing ones",
        "A draft you write may be fuller than what they wrote" in _sys and "what to ADD from their own story" in _sys
        and "never adds an example, event, person" in _sys and "A draft you write only TIDIES" not in _sys)
set_remark("")
_sys2 = " ".join(in_ctx(lambda x, u: a._competency_agent_system(x, u, a._tc_context(x, u, create=False), journey=True)).split())
set_remark(SAVED)
s.check("...and while the remark is still to write", "A draft you write may be fuller than what they wrote" in _sys2)
_rd = in_ctx(lambda x, u: a._journey_redraft_note(x, u, CID, "competency", None, "I'd like to redraft my remark"))
_rd2 = in_ctx(lambda x, u: a._journey_redraft_note(x, u, CID, "account", None, "I'd like to redraft my remark"))
s.check("the Redraft steer for the competency remark points at the Developing competencies; the KPI one is as before",
        "Negotiation Skills, Production Planning" in _rd and "what to ADD from their own story" in _rd
        and "what it could add or make clearer" in _rd2 or not _rd2, (_rd[:300], _rd2[:100]))

# ---------------------------------------------------------------------------
s.section("the own-story line: the honest path, in the chat")
LINE = in_ctx(lambda x, u: a._tc_remark_own_story_line(x, u, CID, ["15%", "Siti", "extra"],
                                                        [{"role": "user", "content": preset()}]))
print("   LINE:", LINE)
s.check("it says what it could not do and why, names up to 4 of the things it added, and no longer says it can't add to it",
        "I couldn't make that fuller without adding details you haven't given (15%, Siti, extra)" in LINE
        and "so I've left your remark as it is" in LINE and "can't add to it for you" not in LINE
        and "your own words, so" not in LINE, LINE)
s.check("...asks, in the chat, for an example of a strength (what happened, what they did)",
        "Tell me here, from your own story" in LINE
        and "an example of a strength you've named -- what happened and what you did" in LINE)
s.check("...and, with no development cue in their words, an area still developing naming the Developing competencies",
        "you rated Negotiation Skills and Production Planning as Developing" in LINE and "getting in the way" in LINE
        and "what would help" in LINE)
s.check("...ends saying the fuller version follows straight away, from that and what they wrote",
        LINE.endswith("I'll write the fuller version straight away, from that and what you've already written."))
s.check("...no quotes and no 'save' wording (so no approve chip or save offer can hang on it); never says go back to the box",
        '"' not in LINE and "save" not in LINE.lower() and not a._remark_quotes(LINE) and "remark box" not in LINE)
L3 = in_ctx(lambda x, u: a._tc_remark_own_story_line(x, u, CID, [], [{"role": "user", "content": "I'm still weak at it"}]))
s.check("a development cue in what they've said (or a Developing title in their words) drops the area ask; no words -> still fine",
        "an area you're still developing" not in L3 and "an example of a strength" in L3 and "()" not in L3)
L4 = in_ctx(lambda x, u: a._tc_remark_own_story_line(
    x, u, CID, ["alpha"], [{"role": "user", "content": "my negotiation skills are the weakest part"}]))
s.check("...a Developing competency's title in their words counts too",
        "an area you're still developing" not in L4)
s.check("novel words are still read from a strict refusal (kept for text pasted in from another tool)",
        a._remark_novel_words("NOT SAVED -- x adds figures they never gave: 12; things they did not say: aaa, bbb. Use")
        == ["aaa", "bbb"] and a._remark_novel_words("figures they never gave: 12.") == [])
s.check("the strict refusal (own-words-only tools, if any) still tells the model to name the words and ask for the piece",
        "Tell them which words were not theirs" in a._remark_grounding_error(
            [{"role": "user", "content": "hello there"}], "Completely different wording about everything today", strict=True,
            ratio=0.0, floor=1))
s.check("set_overall_note is no longer an own-words-only tool (Chris, 2026-11-01)",
        "set_overall_note" not in a._OWN_WORDS_ONLY_TOOLS)

# ---------------------------------------------------------------------------
s.section("the journey turn: the screenshot chat, now with fuller drafts")
SCRIPT, SEEN = [], []


def stub(system, messages, timeout=90):
    SEEN.append(system)
    return SCRIPT.pop(0) if SCRIPT else {"say": "(no script)", "quick_replies": [], "action": None}


_avail, _agent = ai_draft.review_agent_available, ai_draft.review_agent
ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = stub
try:
    C = H.client_as(a, DID)

    def jpost(m):
        return post(C, "/review/chat?journey=1", message=m, stage="competency").get_json(silent=True) or {}

    reset_chat()
    SEEN[:] = []
    SCRIPT[:] = [{"say": 'Here is a fuller version: "%s" Would you like me to save it as your remark?' % PAD2,
                  "quick_replies": ["Yes, save it", "Make it longer"], "action": None}]
    j1 = jpost(preset(" help me make it longer"))
    say1 = j1.get("say") or ""
    s.check("the steer for the help request reaches the model (a fuller draft, the Developing titles)",
            SEEN and "aim at 70-100 words" in SEEN[0] and "Negotiation Skills, Production Planning" in SEEN[0], len(SEEN))
    s.check("THE KEY CHANGE: a fuller draft with many new explanatory words over a saved 19-word remark IS shown, as written "
            "(the old strict check refused every one of these)",
            "strengthening the skills" in say1 and PAD2 in say1 and "couldn't make that fuller" not in say1, say1)
    s.check("...'Yes, save it' first, then 'Change it', and nothing is saved yet",
            (j1.get("quick_replies") or [None, None])[:2] == ["Yes, save it", "Change it"] and remark() == SAVED,
            (j1.get("quick_replies"), remark()))
    SEEN[:] = []
    j1y = jpost("Yes, save it")
    s.check("...and 'Yes, save it' saves exactly that wording, with no model call (a shown draft always saves)",
            remark() == PAD2 and not SEEN and j1y.get("remark_saved") is True, (remark(), len(SEEN), j1y.get("say")))
    set_remark(SAVED)

    # an invented FIGURE or NAME is never shown: one retry; a passing retry is shown
    reset_chat()
    BAD = PAD2 + " I cut cycle time by 15% last quarter for Siti's line."
    SEEN[:] = []
    SCRIPT[:] = [{"say": 'Here is a fuller version: "%s" Shall I save it?' % BAD, "quick_replies": ["Yes, save it"], "action": None},
                 {"say": 'Here it is again: "%s" Shall I save it?' % PAD2, "quick_replies": ["Yes, save it"], "action": None}]
    j2 = jpost(preset(" help me make it longer"))
    say2 = j2.get("say") or ""
    s.check("a draft that adds '15%' and 'Siti' is never shown: ONE more call tells the model what to drop, its fixed draft is shown",
            len(SEEN) == 2 and "15%" not in say2 and "Siti" not in say2 and PAD2 in say2, (len(SEEN), say2))
    # ...and the retry that still fails -> the honest line, no chip
    reset_chat()
    SEEN[:] = []
    SCRIPT[:] = [{"say": 'Here is a fuller version: "%s" Shall I save it?' % BAD, "quick_replies": ["Yes, save it"], "action": None},
                 {"say": 'Again: "%s" Shall I save it?' % BAD, "quick_replies": ["Yes, save it"], "action": None}]
    j3 = jpost(preset(" help me make it longer"))
    say3 = j3.get("say") or ""
    s.check("a retry that still adds details gets the server's own line (the reworded own-story line): no draft shown, no "
            "'Yes, save it', nothing saved, still ONE extra call",
            len(SEEN) == 2 and "I couldn't make that fuller without adding details you haven't given" in say3
            and "15%" in say3 and "Siti" not in BAD.replace("Siti", "") and "cycle time" not in say3
            and not any(a._RG_APPROVE_RE.search(str(q)) for q in (j3.get("quick_replies") or []))
            and remark() == SAVED, (len(SEEN), say3, j3.get("quick_replies")))
    s.check("...it says what to add, in the chat (a strength's example, the Developing competencies), never 'can't add to it'",
            "an example of a strength" in say3 and "Negotiation Skills" in say3 and "can't add to it" not in say3, say3)

    # "Yes, save it" on a draft the check refuses (one already in the chat): the SERVER answers
    reset_chat()
    jpost(preset(" help me make it longer"))   # the model is out of script: "(no script)"
    agent_said('Here is a fuller version: "%s" Would you like me to save it as your remark?' % BAD)
    SEEN[:] = []
    SCRIPT[:] = [{"say": "SHOULD NOT BE ASKED", "quick_replies": [], "action": None}]
    j4b = jpost("Yes, save it")
    say4b = j4b.get("say") or ""
    s.check("'Yes, save it' on a draft with an invented figure: nothing saved, no model call, the same line, no chip",
            remark() == SAVED and not SEEN and "details you haven't given" in say4b and "15%" in say4b
            and not (j4b.get("quick_replies") or []) and not j4b.get("remark_saved"), (remark(), len(SEEN), say4b))
    SCRIPT[:] = []

    # a help reply that only ASKS for the missing piece (no draft) stands: no forced second call that would pad
    reset_chat()
    SEEN[:] = []
    _ASK = "Your remark says you work well under pressure. Can you give me an example, and name an area you're still developing?"
    SCRIPT[:] = [{"say": _ASK, "quick_replies": [], "action": None},
                 {"say": 'Draft: "%s" Save it?' % PAD2, "quick_replies": [], "action": None}]
    j3b = jpost(preset(" help me make it longer"))
    s.check("a 'Help me write it' reply that asks a question instead, with 19 words of their own (ENOUGH): the turn's one extra "
            "call forces the draft and the draft is shown (Chris, 2 Nov: one shot)",
            len(SEEN) == 2 and PAD2 in (j3b.get("say") or "") and _ASK not in (j3b.get("say") or ""),
            (len(SEEN), j3b.get("say")))
    reset_chat()
    SEEN[:] = []
    SCRIPT[:] = [{"say": _ASK, "quick_replies": [], "action": None},
                 {"say": "Still asking: what is one example?", "quick_replies": [], "action": None}]
    j3c = jpost(preset(" help me make it longer"))
    s.check("...if it still won't draft its first reply is shown as it is, and that was ONE extra call, not more",
            len(SEEN) == 2 and _ASK in (j3c.get("say") or ""), (len(SEEN), j3c.get("say")))
    SCRIPT[:] = []

    # their answer -> a draft is shown (a short one from 25 words of material gets the one fuller-version call, which here
    # returns nothing better, so it stands), and "Yes, save it" saves it
    reset_chat()
    SCRIPT[:] = [{"say": 'Here is a fuller version: "%s" Would you like me to save it as your remark?' % PAD1,
                  "quick_replies": ["Yes, save it"], "action": None},
                 {"say": 'Here is your remark with that added: "%s" Would you like me to save it?' % TIDY,
                  "quick_replies": ["Yes, save it"], "action": None},
                 {"say": 'Here is your remark with that added: "%s" Would you like me to save it?' % TIDY,
                  "quick_replies": ["Yes, save it"], "action": None}]
    jpost(preset(" help me make it longer"))
    j4 = jpost("my negotiation skill i would say")
    s.check("their answer, then a draft joining it to their saved remark: shown as written, 'Yes, save it' offered",
            TIDY in (j4.get("say") or "") and (j4.get("quick_replies") or [None])[0] == "Yes, save it"
            and remark() == SAVED, (j4.get("say"), j4.get("quick_replies")))
    SEEN[:] = []
    j5 = jpost("Yes, save it")
    s.check("...and 'Yes, save it' saves exactly that wording, with no model call",
            remark() == TIDY and not SEEN and j5.get("remark_saved") is True, (remark(), len(SEEN), j5.get("say")))
    SCRIPT[:] = []

    # a refusal that is NOT a grounding one keeps the old path (the model answers): never "add to it"
    set_remark(SAVED)
    with a.app.app_context():
        x = a.get_db()
        x.execute("UPDATE tc_assessments SET status='submitted', submitted_at='2026-11-01 00:00:00' WHERE cycle_id=? "
                  "AND subject_id=?", (CID, DID))
        x.commit()
    reset_chat()
    jpost(preset(" help me make it longer"))
    agent_said('Here is your remark with that added: "%s" Would you like me to save it?' % TIDY)
    SEEN[:] = []
    SCRIPT[:] = [{"say": "MODEL ANSWERED", "quick_replies": [], "action": None}]
    j6 = jpost("Yes, save it")
    s.check("'Yes, save it' on a SUBMITTED assessment does not get the own-story line (the model path, as before)",
            "can't add to it for you" not in (j6.get("say") or "") and remark() == SAVED, (j6.get("say"), remark()))
    with a.app.app_context():
        x = a.get_db()
        x.execute("UPDATE tc_assessments SET status='pending', submitted_at=NULL WHERE cycle_id=? AND subject_id=?", (CID, DID))
        x.commit()
    set_remark(SAVED)
    LONG = " ".join([SAVED] * 40)
    reset_chat()
    jpost(preset(" help me make it longer"))
    agent_said('Here is your remark with that added: "%s" Would you like me to save it?' % LONG)
    SEEN[:] = []
    SCRIPT[:] = [{"say": "MODEL ANSWERED", "quick_replies": [], "action": None}]
    j7 = jpost("Yes, save it")
    _e7 = in_ctx(lambda x, u: a._remark_draft_ok(x, u, CID, "competency", None, [
        {"role": "user", "content": preset()}], LONG))
    s.check("...an over-limit draft is refused by the ceiling alone, with the length line (never 'adding details'), nothing saved",
            str(_e7).startswith(a._AI_REFUSED) and "over the 300-word limit" in str(_e7)
            and "300-word limit, so I haven't shown it" in (j7.get("say") or "")
            and "details you haven't given" not in (j7.get("say") or "") and remark() == SAVED, (_e7, j7.get("say")))
    SCRIPT[:] = []

    # the Luna probe (2026-11-01): help, "longer and add more elaboration", the agent asks for an example, then "Yes, save it"
    # with NO quoted draft -- it saved "longer and add more elaboration" as the remark
    set_remark(SAVED)
    reset_chat()
    SCRIPT[:] = [{"say": "What's one example of working under pressure?", "quick_replies": [], "action": None},
                 {"say": "I can't add elaboration without details from your own experience: so far, you've said you work "
                         "well under pressure and hold your work to a high standard. What's one example? Or I can keep "
                         "your remark as it is.", "quick_replies": [], "action": None},
                 {"say": "There's nothing new to save yet -- what's one example?", "quick_replies": [], "action": None}]
    jpost(preset(" help me make it longer"))
    jpost("longer and add more elaboration")
    SEEN[:] = []
    j8 = jpost("Yes, save it")
    s.check("probe sequence: 'Yes, save it' with no quoted draft saves nothing; the agent takes the turn",
            remark() == SAVED and len(SEEN) == 1 and not j8.get("remark_saved") and "remark saved" not in (j8.get("say") or ""),
            (remark(), len(SEEN), j8.get("say")))
    set_remark(SAVED)
    reset_chat()
    SCRIPT[:] = [{"say": "Which of your points?", "quick_replies": [], "action": None},
                 {"say": "Thanks. Shall I save your remark as it is, or add that?", "quick_replies": [], "action": None},
                 {"say": "Nothing new to save yet.", "quick_replies": [], "action": None}]
    jpost(preset(" help me make it longer"))
    jpost("my negotiation skill i would say")
    j9 = jpost("Yes, save it")
    s.check("'my negotiation skill i would say' then 'Yes, save it' with no quoted draft, in a help episode: saves nothing",
            remark() == SAVED and not j9.get("remark_saved"), (remark(), j9.get("say")))
    SCRIPT[:] = []
    set_remark(SAVED)
    reset_chat()
    _TY = "I kept margins up on the big accounts and delivered every order on time despite the rains."
    _H = [{"role": "user", "content": _TY}, {"role": "agent", "content": "Thanks. Shall I save your remark as it is?"},
          {"role": "user", "content": "Yes, save it"}]
    s.check("outside a help episode the old fallback still works: they typed a remark, the agent asked, 'yes' saves it",
            a._remark_target(_H) == (_TY, False), a._remark_target(_H))
    _H2 = [{"role": "user", "content": "longer and add more elaboration"},
           {"role": "user", "content": _TY},
           {"role": "agent", "content": "Shall I save your remark as it is?"}, {"role": "user", "content": "yes"}]
    s.check("...and it skips an instruction typed before it (the remark is the last remark-like message)",
            a._remark_target(_H2) == (_TY, False))
    _H3 = [{"role": "user", "content": _TY}, {"role": "agent", "content": "Shall I save your remark?"},
           {"role": "user", "content": "longer and add more elaboration"}, {"role": "agent", "content": "Shall I save your remark?"},
           {"role": "user", "content": "yes"}]
    s.check("...and never takes the instruction itself", a._remark_target(_H3) == (_TY, False), a._remark_target(_H3))
    s.check("an instruction about the wording is not a remark on any stage; real remarks still are",
            not any(a._remark_like(m) for m in ("longer and add more elaboration", "make it longer please", "more detail",
                                                "rewrite it and tidy it", "add more details about it", "expand on that"))
            and all(a._remark_like(m) for m in ("I improve margins on large accounts every month",
                                                "He is calm under pressure and long on patience",
                                                "my negotiation skill i would say",
                                                "Longer term, I want to lead the regional sales team and coach new "
                                                "joiners on how we close deals",
                                                "When the client asked, I gave them more details on pricing and "
                                                "followed up within the week")))
    _HP = [{"role": "user", "content": preset()}, {"role": "agent", "content": "Shall I save your remark?"},
           {"role": "user", "content": _TY}, {"role": "agent", "content": "Shall I save your remark as it is?"},
           {"role": "user", "content": "yes"}]
    s.check("in a help episode the fallback is off entirely, even for a real remark typed during it",
            a._remark_target(_HP) == (None, False), a._remark_target(_HP))

    # Luna probe run 1 (2026-11-01), replayed row by row: d's "Your current remark is already saved" read as a save
    # boundary, ended the help episode before the preset, and f's "Yes, save it" saved e's fragment over the remark
    RUN1_D = ("I don't have an expanded draft for you to approve yet, and I won't add details you haven't shared. Your "
              "current remark is already saved; what's one area you're still developing\u2014Negotiation Skills or "
              "Production Planning?")
    RUN1_E = ("Your remark already names working under pressure and holding your work to a high standard; you've also "
              "said Negotiation Skills is an area you're developing. What's one example of that from your work?")

    def user_said(text):
        with a.app.app_context():
            x = a.get_db()
            x.execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, stage) VALUES (?,?,'user',?, "
                      "'competency')", (DID, CID, text))
            x.commit()

    def run1(e_agent):
        set_remark(SAVED)
        reset_chat()
        user_said(preset(" help me make it longer"))
        agent_said("Your remark says you work well under pressure and hold your work to a high standard. To add your own "
                   "detail, what's one example of that, and what's one area you're still developing in Negotiation "
                   "Skills or Production Planning?")
        user_said("longer and add more elaboration")
        agent_said("I can help tidy what you've shared, but I shouldn't invent more detail: your remark currently says you "
                   "work well under pressure and hold your work to a high standard. What's one area you're still "
                   "developing\u2014Negotiation Skills or Production Planning?")
        user_said("Yes, save it")
        agent_said(RUN1_D)
        user_said("my negotiation skill i would say")
        agent_said(e_agent)
        SEEN[:] = []
        SCRIPT[:] = [{"say": "Nothing new to save yet -- what's one example?", "quick_replies": [], "action": None}]
        return jpost("Yes, save it")

    j10 = run1(RUN1_E)
    s.check("run 1 replayed: 'Yes, save it' at f saves nothing; the remark is unchanged and the agent takes the turn",
            remark() == SAVED and not j10.get("remark_saved") and len(SEEN) == 1, (remark(), len(SEEN), j10.get("say")))
    _hist = [{"role": "agent", "stage": "competency", "content": RUN1_D}]
    s.check("root cause: 'Your current remark is already saved' is not a save boundary; 'That's your remark saved' still is",
            not a._remark_boundary(_hist[0]) and a._remark_boundary(
                {"role": "agent", "content": "That's your remark saved -- it's in the remark box on your card."})
            and a._remark_boundary({"role": "agent", "content": "Your remark is saved. Next, tap Save & submit."}))
    # the guard on its own (no help episode at all): a fragment, the agent asks to save it, "yes" -- the saved remark stays
    set_remark(SAVED)
    reset_chat()
    user_said("my negotiation skill i would say")
    agent_said("Thanks. Shall I save your remark as it is?")
    SCRIPT[:] = [{"say": "Nothing new to save yet.", "quick_replies": [], "action": None}]
    j10b = jpost("Yes, save it")
    s.check("with no help episode: a 'yes' on a fragment never replaces the saved competency remark",
            remark() == SAVED and not j10b.get("remark_saved"), (remark(), j10b.get("say")))
    j11 = run1('Here is your remark with that added: "%s" Would you like me to save it?' % TIDY)
    s.check("the same history with a quoted, grounded draft at e: 'Yes, save it' saves it",
            remark() == TIDY and j11.get("remark_saved") is True, (remark(), j11.get("say")))
    SCRIPT[:] = []
    set_remark(SAVED)
    reset_chat()
    _NEW = "I led the weekly cost review and I explained every variance to my manager before the month closed."
    agent_said("Type the new version of your remark when you are ready.")
    SCRIPT[:] = [{"say": "(unused)", "quick_replies": [], "action": None}]
    SEEN[:] = []
    jpost(_NEW)
    s.check("a whole new remark typed in full still replaces the saved one (plain intake, not the approval fallback)",
            remark() == _NEW and not SEEN, (remark(), len(SEEN)))
    SCRIPT[:] = []
    set_remark(SAVED)
    _sv = in_ctx(lambda x, u: a._journey_save_remark(x, u, CID, "competency", None, _NEW, [
        {"role": "agent", "stage": "competency", "content": 'Your saved remark: "%s" Type the new version.' % SAVED},
        {"role": "user", "stage": "competency", "content": _NEW}]))
    s.check("...and the agent's save_remark tool stores a typed replacement as typed",
            _sv.get("ok") and remark() == _NEW, (_sv, remark()))
    set_remark(SAVED)
    _sv2 = in_ctx(lambda x, u: a._journey_save_remark(x, u, CID, "competency", None, "Yes, save it", [
        {"role": "user", "stage": "competency", "content": "my negotiation skill i would say"},
        {"role": "agent", "stage": "competency", "content": "Shall I save your remark as it is?"},
        {"role": "user", "stage": "competency", "content": "Yes, save it"}]))
    s.check("...but the agent's save_remark on a bare 'yes' (no quoted draft) never overwrites the saved remark",
            _sv2.get("ok") is False and remark() == SAVED, (_sv2, remark()))
    s.check("...competency with a remark saved and no quoted draft is blocked; a draft or no saved remark is not",
            in_ctx(lambda x, u: a._remark_yes_overwrites(x, u, CID, "competency", None, False))
            and not in_ctx(lambda x, u: a._remark_yes_overwrites(x, u, CID, "competency", None, True))
            and not in_ctx(lambda x, u: a._remark_yes_overwrites(x, u, CID, "account", None, False)))
    set_remark("")
    s.check("...nor when nothing is saved yet (the old fallback saves their typed remark)",
            not in_ctx(lambda x, u: a._remark_yes_overwrites(x, u, CID, "competency", None, False)))
    set_remark(SAVED)

    # the backstop's scope off the live step (the remark is written here)
    set_remark(SAVED)
    DESC = 'At this level it means "negotiate routine deals within approved limits and escalate exceptions" for Negotiation Skills.'
    REASON = ('Your note for Negotiation Skills reads "I handled the supplier price talks by myself and I closed three '
              'deals under the approved limits" -- want to keep it?')
    BADQ = PAD2 + " I cut cycle time by 15% last quarter for Siti's line."
    FP_REMARK = 'Here is a fuller version of your remark: "%s" Shall I use it?' % BADQ
    FP_PLAIN = 'Here is a fuller version: "%s" Shall I use it?' % BADQ
    FP_OK = 'Here is a fuller version of your remark: "%s" Shall I use it?' % PAD2
    H_ASK = [{"role": "user", "content": "what does negotiation cover"}]
    H_HELP = [{"role": "user", "content": preset()}]

    def bs(say, hist):
        return in_ctx(lambda x, u: a._tc_remark_backstop(x, u, CID, say, ["Yes, save it"], hist, "ok"))[0]

    s.check("a quoted third-person descriptor with the remark written is left as is (even with 'remark' in the reply)",
            bs(DESC, H_ASK) == DESC and bs(DESC + " Your remark is saved.", H_ASK) == DESC + " Your remark is saved.")
    s.check("a quoted first-person per-competency reason, no help episode, no 'remark' in the reply, is left as is",
            bs(REASON, H_ASK) == REASON)
    s.check("a first-person draft with an invented figure or name is caught when the reply mentions the remark, or a help "
            "episode is live (the safety net behind the gate: no retry here)",
            "details you haven't given" in bs(FP_REMARK, H_ASK) and "details you haven't given" in bs(FP_PLAIN, H_HELP))
    s.check("...while a fuller first-person draft with no invented figure or name is left as written (words are free)",
            bs(FP_OK, H_ASK) == FP_OK)
    LOW = 'Here is it: "%s"' % BADQ.replace("I ", "i ").replace("I'm", "i'm").replace(" my ", " the ").replace(" me ", " us ")
    s.check("...and not for a lowercase 'i' alone (the I is case-sensitive)", bs(LOW, H_HELP) == LOW)

    # the classic competency chat: the same backstop, the remark already written
    set_remark(SAVED)
    ai_draft.review_agent = lambda system, messages, timeout=90: {
        "say": 'Does this capture your remark: "%s" Shall I save it?' % BADQ, "quick_replies": ["Yes, save it", "Edit it"],
        "action": None}
    cl = post(C, "/review/competency/chat", message="make it longer").get_json() or {}
    s.check("the classic competency chat runs it too: a quoted draft with an invented figure over a saved remark -> the line, no chip",
            "details you haven't given" in (cl.get("say") or "") and "Yes, save it" not in (cl.get("quick_replies") or []),
            cl.get("say"))
    ai_draft.review_agent = lambda system, messages, timeout=90: {
        "say": 'Here is your remark fuller: "%s" Shall I save it?' % PAD2, "quick_replies": ["Yes, save it"],
        "action": None}
    cl2 = post(C, "/review/competency/chat", message="make it fuller").get_json() or {}
    s.check("...a fuller draft with no invented figure or name is shown as written",
            PAD2 in (cl2.get("say") or "") and "Yes, save it" in (cl2.get("quick_replies") or []), cl2.get("say"))
    # the NOT-written case: the same line (one function)
    set_remark("")
    reset_chat()
    ai_draft.review_agent = lambda system, messages, timeout=90: {
        "say": 'Does this capture it: "%s" Shall I save it?' % BADQ, "quick_replies": ["Yes, save it", "Skip"],
        "action": None}
    cl3 = post(C, "/review/competency/chat", message="help me write it").get_json() or {}
    s.check("remark not written: a quoted draft with an invented figure also gets the line, no approve chip",
            "details you haven't given" in (cl3.get("say") or "") and "Yes, save it" not in (cl3.get("quick_replies") or []),
            cl3.get("say"))
finally:
    ai_draft.review_agent_available, ai_draft.review_agent = _avail, _agent
    set_remark(SAVED)
    with a.app.app_context():
        x = a.get_db()
        x.execute("UPDATE tc_assessments SET overall_remark=NULL WHERE cycle_id=? AND subject_id=?", (CID, DID))
        x.execute("DELETE FROM pm_review_chat WHERE subject_id=? AND cycle_id=?", (DID, CID))
        x.commit()

sys.exit(s.done())
