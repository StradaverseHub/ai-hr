"""A BU CEO's, BG CEO's or Group Chief's chat moves a band only when the leader ASKED for that move (security test 4-06,
2026-10-31).

Until now only the model stood between a stray action and a band: `move_band` / `move_person` wrote on any model action
(a "yes" to nothing, a wish, text read from a remark). `_team_move_band_asked` is the same kind of check as the commit tools'
(`_team_commit_asked`), over the leader's OWN message. Tested here as the phrases it accepts and refuses, then end to end
through the real chat routes with the model stubbed to FORCE the action: nothing is written unless they asked, the reply
offers a Move chip, and the HOD's path (which only puts the band on their page) is unchanged.

Its own synthetic business group; the suite writes, so it takes a fresh copy.

Second part (the same day, "security test 4-06 follow-up"): the leader's EARLIER explicit ask still counts when it names the
SAME person and band as the move the model proposes and nothing since withdrew, changed or did it -- so "move Siti to AE
because she did well" -> the model asks what she delivered -> "yes, move them, the reason is she closed RM2m of contracts"
moves her without a second ask. `_team_move_earlier_ask` (pure) and `_team_move_done_since` (the activity log) are tested
here guard by guard, then end to end through the real routes with the model stubbed. It runs only after today's two checks
refuse, so every pass case also asserts that today's path refuses it.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("A band moves in the leaders' chat only when they asked (4-06)")
a.ai_draft.review_agent_available = lambda: True
BG, CA = "ZZMV Group", "ZZMV Alpha Sdn Bhd"

# a build without the check reads as every phrase failing, not as a crash
asked = getattr(a, "_team_move_band_asked", lambda m, h=None: None)

# ---------------------------------------------------------------------------
s.section("the phrases: what asks for a move, what does not")
OFFER = [{"role": "agent", "content": "Shall I move Ali to AE?", "quick_replies": ["Move Ali to Above Expectation"]}]
NOOFFER = [{"role": "agent", "content": "Here is the curve.", "quick_replies": []}]
ASK = [
    "move Ali to AE", "Move Ali to Outstanding please", "put her one band up", "can you lower Bala to ME?",
    "Could you set Bala to High", "Please move Siti Nur to OU, ok?", "ok, raise Ali to AE", "just move Ali up a band",
    "change Ali's band to BE", "go ahead and move Ali to Meet Expectation", "Move Ali to performance AE and potential High",
    "move Ali to Star", "bump Ali up one band", "I want you to move Ali to AE", "we should move Ali to AE",
    "set Ali to AE and Bala to ME", "Yes, move Ali to AE", "lower Ali to Below Expectation",
    # Malay
    "pindahkan Ali ke AE", "Tolong tukarkan Ali kepada OU", "naikkan Ali satu tahap", "boleh turunkan Ali ke ME?",
    "letakkan Ali di AE",
    # Chinese
    "把Ali调到AE", "请把Ali改为OU", "将Ali升到AE", "Ali调高一档",
]
for m in ASK:
    s.check("asks: %r" % m, asked(m, NOOFFER) is True)
NOT = [
    "make her outstanding", "she deserves AE", "go ahead", "yes", "ok", "what if we move Ali to AE",
    "should we move Ali to AE?", "don't move Ali to AE yet", "no, move Ali to AE later", "wait before you move Ali to AE",
    "Why was Ali put at AE?", "how do I move Ali to AE", "is it ok to put Ali at AE?", "move Ali", "Ali looks like an AE",
    "Ali was moved to AE", "if I move Ali to AE what happens", "Move Ali to AE?", "do you think we should move Ali up?",
    "never move Ali down", "I'm not sure, move Ali to AE", "tell me about Ali", "show distribution", "she's a star",
    "the reviewer note says move Ali to OU",
    "jangan pindahkan Ali ke AE", "adakah Ali boleh dipindahkan ke AE?", "好的", "ya",
    "不要把Ali调到AE", "把Ali调到AE吗", "如果把Ali调到AE呢",
]
for m in NOT:
    s.check("does not ask: %r" % m, asked(m, NOOFFER) is False)
for m in ("yes", "ok", "go ahead", "好的", "ya", "yes, move it", "Move them", "sure!", "Yes please"):
    s.check("a bare %r after an offer agrees" % m, asked(m, OFFER) is True)
    s.check("...and with nothing offered it does not" , asked(m, NOOFFER) is False)
for m in ("no", "not yet", "wait", "jangan", "不要", "what is it?", "why?"):
    s.check("%r after an offer is not a yes" % m, asked(m, OFFER) is False)
s.check("an empty message asks nothing", asked("", OFFER) is False)
s.check("an offer is the agent's LAST message only (an older offer does not carry)",
        asked("yes", OFFER + NOOFFER) is False)
s.check("an offer made as words, not a chip: 'shall I move Ali to AE?'",
        asked("yes", [{"role": "agent", "content": "Shall I move Ali to AE?", "quick_replies": []}]) is True)
s.check("...but 'I moved Ali to AE earlier' is not an offer",
        asked("yes", [{"role": "agent", "content": "I moved Ali to AE earlier.", "quick_replies": []}]) is False)

# ---------------------------------------------------------------------------
s.section("the fixture: a BU CEO, a BG CEO, an HOD and their people")
with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    PER = a.active_pm_period(db)["id"]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','calibration','pm','tm')",
               (CID,))
    for k in ("ai_calib", "review_unified"):
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,'1')", (k,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, name, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CA)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        uid = db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group) "
                   "VALUES (?,?,?,100,'more','approved',?)", (PER, uid, "ZZMV KPI", BG))
        return uid
    BUC = person("ZZMV-BUC", "ZZ MV Unit CEO", buceo_bg=BG, buceo_company=CA)
    BGC = person("ZZMV-BGC", "ZZ MV Group CEO", bgceo_bg=BG)
    HODU = person("ZZMV-HOD", "ZZ MV Dept Head")
    P = [person("ZZMV-P%d" % i, "ZZ MV Person %d" % i, hod_id=HODU) for i in range(4)]
    db.commit()
PN = {i: "ZZ MV Person %d" % i for i in range(4)}


def adj(table, uid):
    return H.one(a, "SELECT COUNT(*) FROM %s WHERE subject_id=?" % table, (uid,))


def band(table, uid, col="adjusted_band"):
    r = H.rows(a, "SELECT %s FROM %s WHERE subject_id=? ORDER BY id DESC LIMIT 1" % (col, table), (uid,))
    return r[0][0] if r else None


def forced(tool, args, then_stop=True):
    """A model that proposes this action; with then_stop it says it is done once it has the tool's answer, else it
    keeps insisting (the loop ends on the refusal)."""
    calls = []

    def f(system, history):
        calls.append(len(history))
        if then_stop and history and history[-1].get("role") == "tool":
            return {"say": "Let me know.", "quick_replies": [], "action": None}
        return {"say": "I've moved them.", "quick_replies": [], "action": {"tool": tool, "args": args}}
    f.calls = calls
    return f


def turn(c, msg, view, stage, **kw):
    d = {"csrf_token": "tok", "message": msg, "journey": "1", "view": view, "stage": stage}
    d.update(kw)
    return c.post("/review/chat", data=d).get_json() or {}


_real = a.ai_draft.review_agent
cb = H.client_as(a, BUC)
cg = H.client_as(a, BGC)
ch = H.client_as(a, HODU)

# ---------------------------------------------------------------------------
s.section("the BU CEO, performance: a forced move_band with no ask writes nothing")
try:
    mv = {"subject": PN[0], "band": "AE"}
    a.ai_draft.review_agent = forced("move_band", mv, then_stop=False)   # insists, so the fixed offer is the reply
    n0 = adj("pm_calibration_adjustments", P[0])
    r1 = turn(cb, "go ahead", "bu", "calibration")
    s.check("'go ahead' with nothing offered: nothing is written", adj("pm_calibration_adjustments", P[0]) == n0, r1.get("say"))
    s.check("...and the reply says so, naming who and the band, with a Move chip that is itself an ask",
            "Nothing is moved yet" in (r1.get("say") or "") and "ZZ" in (r1.get("say") or "")
            and (r1.get("quick_replies") or [""])[0].startswith("Move ")
            and asked((r1.get("quick_replies") or [""])[0], NOOFFER), (r1.get("say"), r1.get("quick_replies")))
    s.check("...and the reply never claims the move happened", "I've moved" not in (r1.get("say") or ""))
    # that reply is the agent's last message: a bare yes now agrees
    r2 = turn(cb, "yes", "bu", "calibration")
    s.check("a bare 'yes' right after that offer moves them (the leader agreed)",
            adj("pm_calibration_adjustments", P[0]) == n0 + 1 and band("pm_calibration_adjustments", P[0]) == "AE",
            (r2.get("say"), band("pm_calibration_adjustments", P[0])))
    n1 = adj("pm_calibration_adjustments", P[1])
    mv1 = {"subject": PN[1], "band": "BE"}
    a.ai_draft.review_agent = forced("move_band", mv1)
    turn(cb, "make her outstanding", "bu", "calibration")
    s.check("a wish ('make her outstanding') writes nothing", adj("pm_calibration_adjustments", P[1]) == n1)
    turn(cb, "should we move %s to BE?" % PN[1], "bu", "calibration")
    s.check("a question writes nothing", adj("pm_calibration_adjustments", P[1]) == n1)
    turn(cb, "don't move %s to BE yet" % PN[1], "bu", "calibration")
    s.check("a negation writes nothing", adj("pm_calibration_adjustments", P[1]) == n1)
    turn(cb, "yes", "bu", "calibration")
    # the last agent message is the previous turn's offer chip, so that yes agrees: put a plain agent line in between
    H.rows(a, "SELECT 1")
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        d_.execute("INSERT INTO pm_manager_chat(reviewer_id, cycle_id, report_id, stage, role, content, scope) "
                   "VALUES (?,?,NULL,'calibration','agent','Here is the curve.',?)", (BUC, CID, "buceo"))
        d_.commit()
    n1 = adj("pm_calibration_adjustments", P[1])
    turn(cb, "ok", "bu", "calibration")
    s.check("a bare 'ok' when the agent's last line offered nothing writes nothing", adj("pm_calibration_adjustments", P[1]) == n1)
    r3 = turn(cb, "Move %s to BE" % PN[1], "bu", "calibration")
    s.check("an explicit ask ('Move <name> to BE') writes", adj("pm_calibration_adjustments", P[1]) == n1 + 1
            and band("pm_calibration_adjustments", P[1]) == "BE", (r3.get("say"), band("pm_calibration_adjustments", P[1])))
    # the model keeps insisting (always the action): the reply is still the fixed offer, not its claim
    a.ai_draft.review_agent = forced("move_band", {"subject": PN[2], "band": "OU"}, then_stop=False)
    n2 = adj("pm_calibration_adjustments", P[2])
    r4 = turn(cb, "she is great", "bu", "calibration")
    s.check("a model that insists on the move all turn: nothing written, and its 'I've moved them' is replaced",
            adj("pm_calibration_adjustments", P[2]) == n2 and "Nothing is moved yet" in (r4.get("say") or "")
            and "I've moved" not in (r4.get("say") or ""), r4.get("say"))
finally:
    a.ai_draft.review_agent = _real

# ---------------------------------------------------------------------------
s.section("the BU CEO, potential: the same gate")
try:
    a.ai_draft.review_agent = forced("move_band", {"subject": PN[0], "band": "High"})
    n = adj("calibration_adjustments", P[0])
    turn(cb, "she looks high", "bu", "calibration_pot")
    s.check("a forced potential move with no ask writes nothing", adj("calibration_adjustments", P[0]) == n)
    turn(cb, "Move %s to High" % PN[0], "bu", "calibration_pot")
    s.check("...and an explicit ask writes", adj("calibration_adjustments", P[0]) == n + 1
            and band("calibration_adjustments", P[0]) == "High", band("calibration_adjustments", P[0]))
finally:
    a.ai_draft.review_agent = _real

# ---------------------------------------------------------------------------
s.section("the BG CEO's Talent Box: move_person is gated the same way")
try:
    mp = {"subject": PN[3], "performance_band": "AE", "justification": ""}
    a.ai_draft.review_agent = forced("move_person", mp, then_stop=False)
    n = adj("pm_calibration_adjustments", P[3])
    r5 = turn(cg, "go ahead", "bg", "talent_box")
    s.check("a forced move_person with no ask writes nothing, and says so with a Move chip",
            adj("pm_calibration_adjustments", P[3]) == n and "Nothing is moved yet" in (r5.get("say") or "")
            and (r5.get("quick_replies") or [""])[0].startswith("Move "), (r5.get("say"), r5.get("quick_replies")))
    r6 = turn(cg, "Move %s to performance AE" % PN[3], "bg", "talent_box")
    s.check("...and an explicit ask writes", adj("pm_calibration_adjustments", P[3]) == n + 1
            and band("pm_calibration_adjustments", P[3]) == "AE", (r6.get("say"), band("pm_calibration_adjustments", P[3])))
finally:
    a.ai_draft.review_agent = _real

# ---------------------------------------------------------------------------
s.section("the HOD's path is unchanged: it holds for their page, with no ask needed")
try:
    a.ai_draft.review_agent = forced("move_band", {"subject": PN[0], "band": "ME",
                                                   "justification": "they carried the launch this year"})
    n = adj("pm_calibration_adjustments", P[0])
    r7 = turn(ch, "ok, they carried the launch this year", "dept", "calibration")
    s.check("an HOD's move_band is not refused by the new gate: it HOLDS (nothing saved, their page gets it)",
            "Nothing is saved yet" in (r7.get("say") or "") and "Nothing is moved yet" not in (r7.get("say") or "")
            and adj("pm_calibration_adjustments", P[0]) == n,
            r7.get("say"))
finally:
    a.ai_draft.review_agent = _real

# ---------------------------------------------------------------------------
s.section("the classic calibration assistant's chat holds the same gate")
try:
    a.ai_draft.review_agent = forced("move_band", {"subject": PN[2], "band": "AE"})
    n = adj("pm_calibration_adjustments", P[2])
    q = {"csrf_token": "tok", "tier": "buceo", "bg": BG, "company": CA}
    r8 = cb.post("/performance/calibration/assist/chat", data=dict(q, message="go ahead")).get_json() or {}
    s.check("classic chat: a forced move with no ask writes nothing", adj("pm_calibration_adjustments", P[2]) == n, r8.get("say"))
    r9 = cb.post("/performance/calibration/assist/chat", data=dict(q, message="Move %s to AE" % PN[2])).get_json() or {}
    s.check("...and an explicit ask writes", adj("pm_calibration_adjustments", P[2]) == n + 1, r9.get("say"))
finally:
    a.ai_draft.review_agent = _real

# ---------------------------------------------------------------------------
s.section("the prompts say it, and the help answer is on the leaders' lists")
src = H.source(a)
s.check("the BU / BG / Talent Box prompts carry the rule", src.count("_MOVE_ASK_RULE,") == 4 and "A MOVE RUNS ONLY ON THEIR OWN ASK" in src)
s.check("Help has an answer for it on the BU, BG and Group lists",
        "bu_chat" in a.HELP_QA and all("bu_chat" in a.HELP_LISTS[k][1] for k in ("bu_perf", "bu_pot", "bg", "group"))
        and all(len(a.HELP_LISTS[k][1]) <= a.HELP_LIST_MAX for k in ("bu_perf", "bu_pot", "bg", "group")))

# ===========================================================================
# 4-06 follow-up (2026-10-31): the leader's EARLIER explicit ask
# ===========================================================================
SUBJ = {"id": 101, "full_name": "Aminah Rahman"}
POP = [SUBJ, {"id": 102, "full_name": "Bala Krishnan"}, {"id": 103, "full_name": "Chen Wei Lim"},
       {"id": 104, "full_name": "Nur Siti"}, {"id": 105, "full_name": "Low Mei See"}]
OTH = a._team_move_other_tokens(POP, SUBJ)
T0 = "2026-10-31 10:00:00"
U = lambda t, at=T0: {"role": "user", "content": t, "created_at": at}
AG = lambda t, chips=(): {"role": "agent", "content": t, "quick_replies": list(chips), "created_at": T0}
ASKR = U("Move Aminah to AE because she did well")
QR = AG("What did she deliver that makes it Above Expectation?")
CUR = "yes, move them, the reason is she closed RM2m of contracts"
AEB = {"perf": "AE"}


def ea(cur, rows, subj=SUBJ, bands=AEB, others=OTH, with_cur=True):
    """The ask row, with this turn's own row last (as the routes load it) or not (as a test may pass it)."""
    return a._team_move_earlier_ask(cur, list(rows) + ([U(cur)] if with_cur else []), subj, bands, others)


def today_refuses(cur, rows, subj=SUBJ):
    prior = list(rows) + [U(cur)]
    return not (a._team_move_band_asked(cur, prior) and a._team_move_subject_bound(subj, cur, prior))


s.section("the earlier ask: the helpers, pure")
nb = a._team_move_bands_named
s.check("bands named: the codes (BE / ME only in capitals), the labels and potential words",
        nb("AE")["perf"] == {"AE"} and nb("ae and ou")["perf"] == {"AE", "OU"} and nb("be me")["perf"] == set()
        and nb("BE and ME")["perf"] == {"BE", "ME"} and nb("Above Expectation")["perf"] == {"AE"}
        and nb("meets expectations / below expectation / unacceptable / outstanding")["perf"] == {"ME", "BE", "UA", "OU"}
        and nb("potential medium")["pot"] == {"Mid"} and nb("Low or HIGH")["pot"] == {"Low", "High"}
        and nb("higher")["pot"] == set() and nb("lower")["pot"] == set())
s.check("...a Talent Box category and a step name no band",
        nb("move her to Star") == {"perf": set(), "pot": set()} and nb("up a band, one notch higher") == {"perf": set(), "pot": set()})
tb = a._team_move_tool_bands
s.check("tool bands: move_band on its axis, as the tool reads it (a label too); an unknown value fails closed",
        tb({"tool": "move_band", "args": {"band": "ae"}}, "perf") == {"perf": "AE"}
        and tb({"tool": "move_band", "args": {"band": "Above Expectation"}}, "perf") == {"perf": "AE"}
        and tb({"tool": "move_band", "args": {"band": "high"}}, "pot") == {"pot": "High"}
        and tb({"tool": "move_band", "args": {"band": "AE"}}, "pot") is None
        and tb({"tool": "move_band", "args": {"band": "High"}}, "perf") is None
        and tb({"tool": "move_band", "args": {"band": "Star"}}, "perf") is None
        and tb({"tool": "move_band", "args": {}}, "perf") is None and tb({"tool": "move_band", "args": "AE"}, "perf") is None
        and tb({"tool": "show_box", "args": {"band": "AE"}}, "perf") is None)
s.check("...move_person: its performance and / or potential band; any unknown value fails closed",
        tb({"tool": "move_person", "args": {"performance_band": "ae", "potential_band": "high"}}, "perf") == {"perf": "AE", "pot": "High"}
        and tb({"tool": "move_person", "args": {"potential_band": "Mid"}}, "perf") == {"pot": "Mid"}
        and tb({"tool": "move_person", "args": {"performance_band": "AE", "potential_band": "Star"}}, "perf") is None
        and tb({"tool": "move_person", "args": {"performance_band": "Above Expectation"}}, "perf") is None
        and tb({"tool": "move_person", "args": {}}, "perf") is None)
s.check("other names: everyone but the subject, less the subject's words and the common words (low, see ...)",
        {"bala", "krishnan", "chen", "wei", "lim", "mei", "nur", "siti"} <= OTH and "aminah" not in OTH
        and "low" not in OTH and "see" not in OTH and "rahman" not in OTH)
s.check("the question rule is shared: a polite request is not a question, a question is",
        a._team_move_is_question("can you move her to AE?")[0] is False and a._team_move_is_question("why is she AE?")[0] is True
        and a._team_move_is_question("Move Ali to AE, ok?")[0] is False)

s.section("the earlier ask: what carries a follow-up, and today's path refuses each")
PASS_CASES = [
    ("the answer the model asked for ('yes, move them, the reason is ...')", [ASKR, QR], CUR),
    ("a bare yes after the model's question", [ASKR, QR], "yes"),
    ("the ask two leader turns back, an answer between",
     [ASKR, QR, U("she closed RM2m of contracts"), AG("Thanks. Anything to add?")], "yes please"),
    ("a plain answer with no yes", [ASKR, QR], "She led the Penang launch and closed RM2m of contracts."),
    ("the agent offered the same move since", [ASKR, AG("Shall I move Aminah to Above Expectation?",
                                                        ["Move Aminah to Above Expectation"])], "yes, because she did well"),
    # a reason with no / never / stop / actually / rather / except INSIDE it is what the model asked for, not a withdrawal
    ("a reason with 'no' in it", [ASKR, QR], "yes, she moved the plant to the new ERP with no downtime"),
    ("a reason with 'never' in it", [ASKR, QR], "she never missed a delivery date and closed RM2m of contracts"),
    ("a reason with 'non-stop' and 'actually' in it", [ASKR, QR], "she actually ran the plant non-stop all year"),
    ("a reason with 'rather' and 'except' in it", [ASKR, QR], "rather impressive: every target met except one"),
    # the agent's question may say where they are now while it offers the asked band
    ("an agent offer since that names the band they are on now too",
     [ASKR, AG("Aminah is ME today. I can move her to AE once you share a concrete result.")],
     "she closed RM2m of contracts"),
]
for label, rows, cur in PASS_CASES:
    got = ea(cur, rows)
    s.check("passes: " + label, got is ASKR, got)
    s.check("   ...and without this turn's own row in the history", ea(cur, rows, with_cur=False) is ASKR)
    if "offered the same" not in label:
        s.check("   ...and today's path refuses it (the new path is what lets it through)", today_refuses(cur, rows))
s.check("the cheap first look finds an earlier full ask, and nothing in a wish or a bare yes",
        a._team_move_may_have_earlier_ask(CUR, [ASKR, QR, U(CUR)]) is True
        and a._team_move_may_have_earlier_ask(CUR, [U("she deserves AE"), QR, U(CUR)]) is False
        and a._team_move_may_have_earlier_ask("yes", [U("yes"), QR, U("yes")]) is False
        and a._team_move_may_have_earlier_ask(CUR, [ASKR, QR, U("ok"), U("right"), U("sure"), U(CUR)]) is False)
s.check("the ask may be the third leader turn back (two answers between)",
        ea("yes", [ASKR, QR, U("ok"), AG("Ok."), U("right")]) is ASKR)
s.check("a neutral question in between is not a withdrawal (only this turn's message must not be one)",
        ea("yes", [ASKR, QR, U("how did she do last year?"), AG("Well.")]) is ASKR)

s.section("the earlier ask: each refusal, its own check")
NONE = lambda label, got: s.check("refuses: " + label, got is None, got)
NONE("no earlier ask: only a wish", ea(CUR, [U("she deserves AE"), QR]))
NONE("no earlier message at all", ea(CUR, []))
NONE("the earlier message was a question", ea(CUR, [U("should we move Aminah to AE?"), QR]))
NONE("the earlier message was a hypothetical", ea(CUR, [U("what if we move Aminah to AE"), QR]))
NONE("the earlier message was a negation", ea(CUR, [U("don't move Aminah to AE yet"), QR]))
NONE("the earlier ask names no one (the person on screen binds only today's path)", ea(CUR, [U("move her to AE"), QR]))
NONE("the earlier ask has no band in it", ea(CUR, [U("move Aminah"), QR]))
NONE("this message is a question", ea("Is she the one who closed RM2m of contracts?", [ASKR, QR]))
NONE("this message is a question (a trailing ?)", ea("she closed RM2m of contracts?", [ASKR, QR]))
for w in ("no, not yet", "wait", "never mind", "nevermind", "cancel that", "keep her where she is", "hold on", "don't do it",
          "leave her as she is", "forget it", "scrap that", "on second thought no", "actually no", "undo", "tak payah",
          "batal", "算了", "取消", "保持原样", "not yet, she closed RM2m of contracts", "不要了"):
    NONE("now: %r" % w, ea(w, [ASKR, QR]))
    NONE("in between: %r" % w, ea("yes", [ASKR, QR, U(w), AG("Ok.")]))
NONE("a hypothetical in between", ea("yes", [ASKR, QR, U("what if she only led the launch"), AG("Hmm.")]))
NONE("a different band now ('actually ME')", ea("actually ME", [ASKR, QR]))
NONE("a different band now, with a yes", ea("yes, move them to ME because she closed RM2m of contracts", [ASKR, QR]))
NONE("a second band now (the asked one and another)", ea("AE or OU, she closed RM2m of contracts", [ASKR, QR]))
NONE("a different band in between", ea("yes", [ASKR, QR, U("make it Outstanding"), AG("Ok.")]))
NONE("the tool's band differs from the ask's", ea(CUR, [ASKR, QR], bands={"perf": "ME"}))
NONE("the tool's band is on another axis than the ask's", ea(CUR, [ASKR, QR], bands={"pot": "High"}))
NONE("the tool's person differs", ea(CUR, [ASKR, QR], subj={"id": 102, "full_name": "Bala Krishnan"},
                                    others=a._team_move_other_tokens(POP, {"id": 102, "full_name": "Bala Krishnan"})))
NONE("another person named now ('what about Bala?')", ea("what about Bala?", [ASKR, QR]))
NONE("another person named now, as a statement", ea("yes, and Bala too, she closed RM2m of contracts", [ASKR, QR]))
NONE("another person named in between", ea("yes", [ASKR, QR, U("Bala closed RM2m too"), AG("Noted.")]))
NONE("another person named in between by a particle name (Nur Siti)", ea("yes", [ASKR, QR, U("and Siti too"), AG("Noted.")]))
NONE("a change word now ('instead')", ea("do Bala instead", [ASKR, QR]))
NONE("the ask names two people", ea(CUR, [U("move Aminah and Bala to AE"), QR]))
NONE("the ask names two bands", ea(CUR, [U("move Aminah from ME to AE"), QR]))
NONE("the ask names two bands (a label too)", ea(CUR, [U("move Aminah to AE, or Outstanding"), QR]))
NONE("the ask is relative ('up a band')", ea(CUR, [U("move Aminah up a band"), QR]))
NONE("the ask names a category ('to Star')", ea(CUR, [U("move Aminah to Star"), QR]))
NONE("the ask is four leader turns back",
     ea("yes", [ASKR, QR, U("ok"), U("right"), U("sure"), AG("Ok.")]))
NONE("an agent offer since for someone else",
     ea(CUR, [ASKR, AG("Shall I move Bala to Above Expectation?", ["Move Bala to Above Expectation"])]))
NONE("an agent offer since that names nobody",
     ea(CUR, [ASKR, AG("Shall I move them to Above Expectation?", ["Move them"])]))
NONE("an agent offer since for the same person but another band",
     ea(CUR, [ASKR, AG("Shall I move Aminah to Outstanding?", ["Move Aminah to Outstanding"])]))
NONE("an agent offer since for the person and a second person",
     ea(CUR, [ASKR, AG("Shall I move Aminah to Above Expectation, and Bala?", ["Move Aminah to Above Expectation"])]))
NONE("an empty message", ea("", [ASKR, QR]))
NONE("no person", a._team_move_earlier_ask(CUR, [ASKR, QR], None, AEB, OTH))
NONE("no bands", a._team_move_earlier_ask(CUR, [ASKR, QR], SUBJ, {}, OTH))
NONE("a name of nothing but particles (Nur Siti): only the chip",
     a._team_move_earlier_ask(CUR, [U("move Nur Siti to AE"), QR, U(CUR)], {"id": 104, "full_name": "Nur Siti"}, AEB, OTH))
s.check("the ask is found by the person's name, not a shared word: Chen's ask does not carry Lim's move",
        a._team_move_earlier_ask(CUR, [U("move Chen to AE"), QR, U(CUR)], {"id": 106, "full_name": "Ng Wei Lim"}, AEB,
                                 frozenset()) is None)
s.check("a potential ask carries a potential move (axis 'pot', exactly one word)",
        ea("yes", [U("move Aminah to High"), QR], bands={"pot": "High"}) is not None
        and ea("yes", [U("move Aminah to High or Mid"), QR], bands={"pot": "High"}) is None
        and ea("yes", [U("move Aminah to High"), QR], bands={"pot": "Mid"}) is None)
s.check("a Talent Box move on both axes needs both in the ask, each exactly",
        ea("yes", [U("move Aminah to performance AE and potential High"), QR], bands={"perf": "AE", "pot": "High"}) is not None
        and ea("yes", [U("move Aminah to performance AE"), QR], bands={"perf": "AE", "pot": "High"}) is None
        and ea("yes", [U("move Aminah to performance AE and potential High"), QR], bands={"perf": "AE", "pot": "Mid"}) is None)

s.section("the activity log: has anyone changed this person's band since the ask")
with a.app.test_request_context("/"):
    db = a.get_db()
    _u = db.execute("SELECT id FROM users WHERE role!='admin' ORDER BY id LIMIT 2").fetchall()
    X, Y = _u[0][0], _u[1][0]
    SINCE = "2099-01-01 00:00:00"
    LATER = "2099-01-01 00:00:05"
    BEFORE = "2098-12-31 23:59:00"

    def logrow(action, target, at):
        db.execute("INSERT INTO activity_log(user_id, action, detail, target_user_id, created_at) VALUES (?,?,?,?,?)",
                   (Y, action, "zz-test", target, at))

    def done(since=SINCE):
        return a._team_move_done_since(db, X, since)

    s.check("no time on the ask: fails closed", a._team_move_done_since(db, X, None) is True and a._team_move_done_since(db, X, "") is True)
    s.check("nothing logged since: not done", done() is False)
    for act in sorted(a._BAND_MOVE_ACTIONS):
        logrow(act, X, LATER)
        s.check("a %r on them since the ask: done" % act, done() is True)
        db.execute("DELETE FROM activity_log WHERE detail='zz-test'")
        logrow(act, X, BEFORE)
        logrow(act, Y, LATER)
        s.check("...before the ask, or on someone else: not done (%s)" % act, done() is False)
        db.execute("DELETE FROM activity_log WHERE detail='zz-test'")
    for act in sorted(a._BAND_RESET_ACTIONS):
        logrow(act, None, LATER)
        s.check("a %r with no target (it may have touched anyone) since the ask: done" % act, done() is True)
        db.execute("DELETE FROM activity_log WHERE detail='zz-test'")
        logrow(act, None, BEFORE)
        s.check("...before the ask: not done (%s)" % act, done() is False)
        db.execute("DELETE FROM activity_log WHERE detail='zz-test'")
    logrow("login", X, LATER)
    logrow("pm_calibration_lock", None, LATER)
    logrow("pm_calibration_adjust", None, LATER)   # a move row with no person is not a reset
    s.check("a login, a lock, or a move row with no target is not a band change", done() is False)
    logrow("pm_calibration_adjust", X, SINCE)
    s.check("a change in the very second of the ask counts (>=)", done() is True)
    db.execute("DELETE FROM activity_log WHERE detail='zz-test'")
    db.commit()
    plan = [r[3] for r in db.execute("EXPLAIN QUERY PLAN SELECT 1 FROM activity_log WHERE created_at >= ? AND "
                                     "((target_user_id = ? AND action IN (?)) OR (target_user_id IS NULL AND action IN (?))) "
                                     "LIMIT 1", ("x", 1, "a", "b")).fetchall()]
    s.check("one read, through an activity_log index", any("INDEX" in x.upper() for x in plan), plan)
s.check("every action in the two sets is one the app really logs (no typo makes a guard silent)",
        all(('"%s"' % x) in H.source(a) for x in a._BAND_MOVE_ACTIONS | a._BAND_RESET_ACTIONS))
s.check("the move and reset sets cover the writers the audit found",
        {"pm_calibration_adjust", "talent_box_move", "pm_calibration_override", "pm_calibration_override_clear",
         "calibration_override", "calibration_adjust"} <= a._BAND_MOVE_ACTIONS
        and {"calibration_reset", "pm_calibration_reset", "pm_group_lock"} <= a._BAND_RESET_ACTIONS
        and "calibration_adjust" not in a._BAND_RESET_ACTIONS)
_cadj = H.source(a).split('log_activity(db, u["id"], "calibration_adjust",')[1:]
s.check("every potential move writer logs the person it moved (a row with no person would block everyone's follow-up)",
        len(_cadj) >= 4 and all("target_user_id=subject_id)" in blk.split("\n", 3)[2] for blk in _cadj),
        [blk.split("\n", 3)[:2] for blk in _cadj])


s.section("the whole decision: bands from the tool call, the ask, and the log")
FAR = "2099-06-01 00:00:00"   # nothing in the log is later than this: the 'nobody moved them since' leg is clear
ASKF = U("Move Aminah to AE because she did well", FAR)
with a.app.test_request_context("/"):
    db = a.get_db()
    ok_ = lambda cur, rows, tool, axis="perf", subj=SUBJ: a._team_move_earlier_ask_ok(
        db, cur, list(rows) + [U(cur)], subj, tool, axis, POP)
    MB = lambda band_: {"tool": "move_band", "args": {"subject": "Aminah Rahman", "band": band_}}
    s.check("the ask, the person and the band agree, nobody moved them since: allowed", ok_(CUR, [ASKF, QR], MB("AE")) is True)
    s.check("...the same with the label the tool also reads", ok_(CUR, [ASKF, QR], MB("Above Expectation")) is True)
    s.check("...an unknown band value in the tool call fails closed", ok_(CUR, [ASKF, QR], MB("Star")) is False
            and ok_(CUR, [ASKF, QR], MB("")) is False and ok_(CUR, [ASKF, QR], {"tool": "move_band", "args": "AE"}) is False)
    s.check("...another band than the ask's: refused", ok_(CUR, [ASKF, QR], MB("ME")) is False)
    s.check("...no ask time on the history row: refused (fails closed)",
            ok_(CUR, [dict(ASKF, created_at=None), QR], MB("AE")) is False
            and ok_(CUR, [{k: v for k, v in ASKF.items() if k != "created_at"}, QR], MB("AE")) is False)
    s.check("...no person: refused", a._team_move_earlier_ask_ok(db, CUR, [ASKF, QR, U(CUR)], None, MB("AE"), "perf", POP) is False)
    s.check("...a tool that is not a band move: refused",
            ok_(CUR, [ASKF, QR], {"tool": "show_box", "args": {"subject": "Aminah Rahman", "band": "AE"}}) is False)
    s.check("...a potential call read on the performance axis (or the reverse): refused",
            ok_(CUR, [U("move Aminah to High", FAR), QR], MB("High"), "perf") is False
            and ok_(CUR, [U("move Aminah to High", FAR), QR], MB("High"), "pot") is True)

    class _Boom:
        def execute(self, *a_, **k_):
            raise RuntimeError("log unavailable")
    s.check("an unreadable log fails closed (the move is not let through)",
            a._team_move_done_since(_Boom(), 1, "2026-01-01 00:00:00") is True
            and a._team_move_earlier_ask_ok(_Boom(), CUR, [ASKF, QR, U(CUR)], SUBJ, MB("AE"), "perf", POP) is False)

# ---------------------------------------------------------------------------
s.section("end to end: the fixture for the follow-up (more people, distinct names)")
FU = {"A": "Aminah Rahman", "B": "Bala Krishnan", "C": "Chen Wei Lim", "D": "Devi Pillai", "E": "Farid Hamzah",
      "F": "Gopal Nair", "G": "Hana Ismail", "H": "Ivan Lopez", "I": "Jamal Othman", "J": "Kavita Menon", "K": "Lina Kassim",
      "L": "Mario Tanaka", "M": "Nadia Hussein", "N": "Omar Faizal", "O": "Priya Raman", "Q": "Ravi Shankar", "R": "Sanjay Verma"}
with a.app.test_request_context("/"):
    db = a.get_db()
    FID = {k: person("ZZMV-F%s" % k, n, hod_id=HODU) for k, n in FU.items()}
    db.commit()
ADJ = "pm_calibration_adjustments"
ACT = "SELECT COUNT(*) FROM activity_log WHERE target_user_id=? AND action IN ('pm_calibration_adjust','talent_box_move')"


def settle():
    """activity_log and the chat rows are stamped to the second: leave the earlier writes behind this scenario's ask."""
    time.sleep(1.05)


def asks_a_question(who):
    def f(system, history):
        return {"say": "What did %s deliver that makes it that band?" % who, "quick_replies": [], "action": None}
    return f


SEEN = []
_orig_ok = a._team_move_earlier_ask_ok


def _spy(db_, msg, history, *r, **k):
    SEEN.append((msg, [dict(h) for h in history]))
    return _orig_ok(db_, msg, history, *r, **k)


a._team_move_earlier_ask_ok = _spy
FOLLOW = "yes, move them, the reason is she closed RM2m of contracts"
try:
    # -----------------------------------------------------------------------
    s.section("end to end, the BU CEO's performance part: ask, the model asks back, the answer moves them")
    settle()
    a.ai_draft.review_agent = asks_a_question("she")
    r1 = turn(cb, "Move Aminah to AE because she did well", "bu", "calibration")
    s.check("turn 1, the full ask: the model asks back with no action, nothing is written",
            adj(ADJ, FID["A"]) == 0 and "Nothing is moved yet" not in (r1.get("say") or ""), r1.get("say"))
    s.check("...and today's gate alone would refuse turn 2 (no band, no name, no offer)", today_refuses(FOLLOW, [ASKR, QR]))
    a.ai_draft.review_agent = forced("move_band", {"subject": FU["A"], "band": "AE"})
    n_seen = len(SEEN)
    r2 = turn(cb, FOLLOW, "bu", "calibration")
    s.check("turn 2, 'yes, move them, the reason is ...', the model moving Aminah to AE: written",
            adj(ADJ, FID["A"]) == 1 and band(ADJ, FID["A"]) == "AE" and H.one(a, ACT, (FID["A"],)) == 1, (r2.get("say"), band(ADJ, FID["A"])))
    s.check("...the route handed the check its history: every row dated, this turn's own message last",
            len(SEEN) > n_seen and all(h.get("created_at") for h in SEEN[-1][1] if h.get("role") in ("user", "agent"))
            and SEEN[-1][1][-1].get("role") == "user" and SEEN[-1][1][-1]["content"] == FOLLOW, SEEN[-1][1][-2:] if SEEN else None)

    # a model that moves someone else, or another band
    settle()
    a.ai_draft.review_agent = asks_a_question("she")
    turn(cb, "Move Bala to AE because she did well", "bu", "calibration")
    a.ai_draft.review_agent = forced("move_band", {"subject": FU["C"], "band": "AE"}, then_stop=False)
    r = turn(cb, FOLLOW, "bu", "calibration")
    s.check("turn 2 with the model moving SOMEONE ELSE (Chen): nothing written for Chen or Bala, the reply carries the Move chip",
            adj(ADJ, FID["C"]) == 0 and adj(ADJ, FID["B"]) == 0 and "Nothing is moved yet" in (r.get("say") or "")
            and (r.get("quick_replies") or [""])[0].startswith("Move Chen"), (r.get("say"), r.get("quick_replies")))
    settle()
    a.ai_draft.review_agent = asks_a_question("she")
    turn(cb, "Move Devi to AE because she did well", "bu", "calibration")
    a.ai_draft.review_agent = forced("move_band", {"subject": FU["D"], "band": "ME"}, then_stop=False)
    r = turn(cb, FOLLOW, "bu", "calibration")
    s.check("turn 2 with the model moving ANOTHER BAND (ME, not AE): nothing written, the reply carries the Move chip",
            adj(ADJ, FID["D"]) == 0 and "Nothing is moved yet" in (r.get("say") or "")
            and (r.get("quick_replies") or [""])[0].startswith("Move Devi"), (r.get("say"), r.get("quick_replies")))
    settle()
    a.ai_draft.review_agent = asks_a_question("he")
    turn(cb, "Move Farid to AE because he did well", "bu", "calibration")
    a.ai_draft.review_agent = forced("move_band", {"subject": FU["E"], "band": "AE"}, then_stop=False)
    for q_ in ("Is it right that he closed RM2m of contracts?", "never mind, he closed RM2m of contracts"):
        r = turn(cb, q_, "bu", "calibration")
        s.check("turn 2 %r with a forced move: nothing written, the chip is offered" % q_,
                adj(ADJ, FID["E"]) == 0 and "Nothing is moved yet" in (r.get("say") or ""), (r.get("say"), adj(ADJ, FID["E"])))

    # nobody changed them since: the real grid writer
    settle()
    a.ai_draft.review_agent = asks_a_question("he")
    turn(cb, "Move Gopal to AE because he did well", "bu", "calibration")
    with a.app.test_request_context("/"):
        _grid = a.url_for("pm_calibration_buceo_adjust", bg=BG, company=CA)
    rg = cb.post(_grid, data={"csrf_token": "tok", "subject_id": str(FID["F"]), "adjusted_band": "ME", "justification": ""},
                 headers={"X-Requested-With": "XMLHttpRequest"})
    s.check("(fixture) the real grid writer moved Gopal to ME after the ask", band(ADJ, FID["F"]) == "ME", (rg.status_code, band(ADJ, FID["F"])))
    a.ai_draft.review_agent = forced("move_band", {"subject": FU["F"], "band": "AE"}, then_stop=False)
    r = turn(cb, FOLLOW, "bu", "calibration")
    s.check("a later move done: turn 2 with a forced AE changes nothing (still ME), and the chip is offered",
            band(ADJ, FID["F"]) == "ME" and adj(ADJ, FID["F"]) == 1 and "Nothing is moved yet" in (r.get("say") or ""),
            (r.get("say"), band(ADJ, FID["F"])))

    # -----------------------------------------------------------------------
    s.section("end to end, the BU CEO's potential part")
    settle()
    a.ai_draft.review_agent = asks_a_question("she")
    turn(cb, "Move Hana to High because she did well", "bu", "calibration_pot")
    s.check("turn 1 writes nothing", adj("calibration_adjustments", FID["G"]) == 0)
    a.ai_draft.review_agent = forced("move_band", {"subject": FU["G"], "band": "High"})
    turn(cb, FOLLOW, "bu", "calibration_pot")
    s.check("turn 2: the model moving Hana to High: written (potential)",
            adj("calibration_adjustments", FID["G"]) == 1 and band("calibration_adjustments", FID["G"]) == "High",
            band("calibration_adjustments", FID["G"]))
    settle()
    a.ai_draft.review_agent = asks_a_question("she")
    turn(cb, "Move Lina to Mid because she did well", "bu", "calibration_pot")
    a.ai_draft.review_agent = forced("move_band", {"subject": FU["K"], "band": "High"}, then_stop=False)
    r = turn(cb, FOLLOW, "bu", "calibration_pot")
    s.check("potential, the model moving another band (High, not Mid): nothing written",
            adj("calibration_adjustments", FID["K"]) == 0 and "Nothing is moved yet" in (r.get("say") or ""), r.get("say"))
    def curve_move(stage, who, band_):
        """The curve's own band change (the page, not the chat)."""
        return cb.post("/review/team/calib-move", data={"csrf_token": "tok", "stage": stage, "subject": str(who),
                                                        "band": band_, "justification": ""},
                       headers={"X-Requested-With": "XMLHttpRequest"}).get_json() or {}
    settle()
    a.ai_draft.review_agent = asks_a_question("he")
    turn(cb, "Move Mario to Mid because he did well", "bu", "calibration_pot")
    rc = curve_move("calibration_pot", FID["N"], "Low")   # someone ELSE's potential, on the curve, after the ask
    s.check("(fixture) the curve moved Omar's potential after the ask, and the log names Omar",
            band("calibration_adjustments", FID["N"]) == "Low"
            and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='calibration_adjust' AND target_user_id=?",
                      (FID["N"],)) >= 1, rc)
    a.ai_draft.review_agent = forced("move_band", {"subject": FU["L"], "band": "Mid"})
    r = turn(cb, FOLLOW, "bu", "calibration_pot")
    s.check("someone else's potential move since the ask does not block the follow-up: Mario's Mid is written",
            adj("calibration_adjustments", FID["L"]) == 1 and band("calibration_adjustments", FID["L"]) == "Mid", r.get("say"))
    settle()
    a.ai_draft.review_agent = asks_a_question("he")
    turn(cb, "Move Farid to High because he did well", "bu", "calibration_pot")
    rc = curve_move("calibration_pot", FID["E"], "Low")   # the SAME person's potential, on the curve, after the ask
    s.check("(fixture) the curve moved Farid's potential to Low after the ask", band("calibration_adjustments", FID["E"]) == "Low", rc)
    a.ai_draft.review_agent = forced("move_band", {"subject": FU["E"], "band": "High"}, then_stop=False)
    r = turn(cb, FOLLOW, "bu", "calibration_pot")
    s.check("a later potential move of the same person: the follow-up changes nothing (still Low), the chip is offered",
            band("calibration_adjustments", FID["E"]) == "Low" and adj("calibration_adjustments", FID["E"]) == 1
            and "Nothing is moved yet" in (r.get("say") or ""), (r.get("say"), band("calibration_adjustments", FID["E"])))

    # -----------------------------------------------------------------------
    s.section("end to end, the BG CEO's Talent Box (move_person)")
    settle()
    a.ai_draft.review_agent = asks_a_question("he")
    turn(cg, "Move Ivan to performance AE because he did well", "bg", "talent_box")
    s.check("turn 1 writes nothing", adj(ADJ, FID["H"]) == 0)
    a.ai_draft.review_agent = forced("move_person", {"subject": FU["H"], "performance_band": "AE", "justification": ""})
    turn(cg, FOLLOW, "bg", "talent_box")
    s.check("turn 2: move_person for Ivan, AE: written", adj(ADJ, FID["H"]) == 1 and band(ADJ, FID["H"]) == "AE", band(ADJ, FID["H"]))
    settle()
    a.ai_draft.review_agent = asks_a_question("she")
    turn(cg, "Move Nadia to performance AE because she did well", "bg", "talent_box")
    a.ai_draft.review_agent = forced("move_person", {"subject": FU["M"], "performance_band": "OU"}, then_stop=False)
    r = turn(cg, FOLLOW, "bg", "talent_box")
    s.check("the Talent Box, another band (OU, not AE): nothing written, the chip is offered",
            adj(ADJ, FID["M"]) == 0 and "Nothing is moved yet" in (r.get("say") or ""), r.get("say"))
    settle()
    a.ai_draft.review_agent = asks_a_question("she")
    turn(cg, "Move Sanjay to performance AE because he did well", "bg", "talent_box")
    a.ai_draft.review_agent = forced("move_person", {"subject": FU["R"], "performance_band": "AE", "potential_band": "High"},
                                     then_stop=False)
    r = turn(cg, FOLLOW, "bg", "talent_box")
    s.check("...an axis the ask never named (potential High with an ask for performance AE only): nothing written",
            adj(ADJ, FID["R"]) == 0 and adj("calibration_adjustments", FID["R"]) == 0
            and "Nothing is moved yet" in (r.get("say") or ""), r.get("say"))
    settle()
    a.ai_draft.review_agent = asks_a_question("she")
    turn(cg, "Move Priya to performance AE because she did well", "bg", "talent_box")
    a.ai_draft.review_agent = forced("move_person", {"subject": FU["B"], "performance_band": "AE"}, then_stop=False)
    n_b = adj(ADJ, FID["B"])
    r = turn(cg, FOLLOW, "bg", "talent_box")
    s.check("the Talent Box, someone else (Bala): nothing written", adj(ADJ, FID["B"]) == n_b and adj(ADJ, FID["O"]) == 0, r.get("say"))
    a.ai_draft.review_agent = asks_a_question("she")
    settle()
    turn(cg, "Move Ravi to performance AE because he did well", "bg", "talent_box")
    with a.app.test_request_context("/"):
        _tbm = a.url_for("talent_box_bgceo_move", bg=BG)
    rt = cg.post(_tbm, data={"csrf_token": "tok", "subject_id": str(FID["Q"]), "performance_band": "ME", "justification": ""},
                 headers={"X-Requested-With": "XMLHttpRequest"})
    s.check("(fixture) the Talent Box's own page writer moved Ravi to ME after the ask", band(ADJ, FID["Q"]) == "ME",
            (rt.status_code, rt.get_data(as_text=True)[:200]))
    a.ai_draft.review_agent = forced("move_person", {"subject": FU["Q"], "performance_band": "AE"}, then_stop=False)
    r = turn(cg, FOLLOW, "bg", "talent_box")
    s.check("a later move done through the box's page: the follow-up changes nothing (still ME)",
            band(ADJ, FID["Q"]) == "ME" and adj(ADJ, FID["Q"]) == 1, (r.get("say"), band(ADJ, FID["Q"])))

    # -----------------------------------------------------------------------
    s.section("end to end, the classic calibration assistant")
    q = {"csrf_token": "tok", "tier": "buceo", "bg": BG, "company": CA}
    CLS = "/performance/calibration/assist/chat"

    def cturn(msg):
        return cb.post(CLS, data=dict(q, message=msg)).get_json() or {}
    settle()
    a.ai_draft.review_agent = asks_a_question("he")
    cturn("Move Jamal to AE because he did well")
    s.check("classic turn 1 writes nothing", adj(ADJ, FID["I"]) == 0)
    n_seen = len(SEEN)
    a.ai_draft.review_agent = forced("move_band", {"subject": FU["I"], "band": "AE"})
    cturn(FOLLOW)
    s.check("classic turn 2: the model moving Jamal to AE: written", adj(ADJ, FID["I"]) == 1 and band(ADJ, FID["I"]) == "AE", band(ADJ, FID["I"]))
    s.check("...the route's history carries created_at, this turn's own message last",
            len(SEEN) > n_seen and all(h.get("created_at") for h in SEEN[-1][1])
            and SEEN[-1][1][-1]["role"] == "user" and SEEN[-1][1][-1]["content"] == FOLLOW)
    settle()
    a.ai_draft.review_agent = asks_a_question("she")
    cturn("Move Kavita to AE because she did well")
    a.ai_draft.review_agent = forced("move_band", {"subject": FU["B"], "band": "AE"}, then_stop=False)
    n_b = adj(ADJ, FID["B"])
    r = cturn(FOLLOW)
    s.check("classic: the model moving someone else (Bala): nothing written for Bala or Kavita, the chip is offered",
            adj(ADJ, FID["B"]) == n_b and adj(ADJ, FID["J"]) == 0 and "Nothing is moved yet" in (r.get("say") or ""), r.get("say"))
    a.ai_draft.review_agent = forced("move_band", {"subject": FU["J"], "band": "OU"}, then_stop=False)
    r = cturn(FOLLOW)
    s.check("classic: another band (OU, not AE): nothing written", adj(ADJ, FID["J"]) == 0, r.get("say"))
    r = cturn("Is that why she should be AE?")
    s.check("classic: a question as turn 2 with a forced move: nothing written", adj(ADJ, FID["J"]) == 0, r.get("say"))
    settle()
    a.ai_draft.review_agent = asks_a_question("she")
    cturn("Move Lina to AE because she did well")
    rg = cb.post(_grid, data={"csrf_token": "tok", "subject_id": str(FID["K"]), "adjusted_band": "ME", "justification": ""},
                 headers={"X-Requested-With": "XMLHttpRequest"})
    a.ai_draft.review_agent = forced("move_band", {"subject": FU["K"], "band": "AE"}, then_stop=False)
    r = cturn(FOLLOW)
    s.check("classic: a later move done through the grid: the follow-up changes nothing (still ME)",
            band(ADJ, FID["K"]) == "ME" and adj(ADJ, FID["K"]) == 1, (r.get("say"), band(ADJ, FID["K"])))
finally:
    a.ai_draft.review_agent = _real
    a._team_move_earlier_ask_ok = _orig_ok

# ---------------------------------------------------------------------------
s.section("the new code is defined once, and Help says it")
src = H.source(a)
s.check("each new name is defined exactly once (a later def silently wins)",
        all(src.count("def %s(" % n) == 1 for n in (
            "_team_move_bands_named", "_team_move_tool_bands", "_team_move_other_tokens", "_team_move_earlier_ask",
            "_team_move_done_since", "_team_move_earlier_ask_ok", "_team_move_followup_ok", "_team_move_is_question",
            "_team_move_subject_and_people", "_team_move_earlier_rows", "_team_move_may_have_earlier_ask")))
s.check("the two routes call the earlier-ask check only after today's two checks (and the HOD's path is not gated by it)",
        src.count("_team_move_earlier_ask_ok(db, msg, prior_history") == 2)
s.check("Help's answer says a follow-up needs no second ask, in the house words",
        "just answer" in a.HELP_QA["bu_chat"][1] and "needn't say the move again" in a.HELP_QA["bu_chat"][1]
        and "HR" not in a.HELP_QA["bu_chat"][1].replace("Group People", ""))

sys.exit(s.done())
