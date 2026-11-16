"""A gated band move must be about the person the leader meant (security test 4-06, second part, 2026-10-31).

`_team_move_band_asked` says the leader asked for A move; `_team_move_subject_bound` says it is about the right PERSON. The move
the model proposes runs only when one of these holds: (a) the person is the one open on the leader's screen ("move her to AE"
on their card); (b) a name of theirs (2+ letters) is in the leader's own message ("move Bala to ME"); (c) for a bare yes or a
verb-only ask, a name of theirs is in the agent's last message that made the offer. Otherwise nothing is written and the reply
offers the move for the model's proposed person. Held in the journey chat (BU CEO both axes, BG CEO's Talent Box) and the classic
assistant's chat. Distinct names here, so a shared word never makes a stranger match.

Its own synthetic group; the suite writes, so it takes a fresh copy.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("A gated band move is about the person the leader meant (4-06, subject binding)")
a.ai_draft.review_agent_available = lambda: True
BG, CA = "ZZMS Group", "ZZMS Alpha Sdn Bhd"
NAMES = {"A": "Aminah Rahman", "B": "Bala Krishnan", "C": "Chen Wei Lim"}

with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    PER = a.active_pm_period(db)["id"]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','calibration','pm','tm')", (CID,))
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
                   "VALUES (?,?,?,100,'more','approved',?)", (PER, uid, "ZZMS KPI", BG))
        return uid
    BUC = person("ZZMS-BUC", "Unit Chief Officer", buceo_bg=BG, buceo_company=CA)
    BGC = person("ZZMS-BGC", "Group Chief Executive", bgceo_bg=BG)
    ID = {k: person("ZZMS-%s" % k, n) for k, n in NAMES.items()}
    db.commit()


def n_rows(table, k):
    return H.one(a, "SELECT COUNT(*) FROM %s WHERE subject_id=?" % table, (ID[k],))


def band(table, k):
    r = H.rows(a, "SELECT adjusted_band FROM %s WHERE subject_id=? ORDER BY id DESC LIMIT 1" % table, (ID[k],))
    return r[0][0] if r else None


def band_at(k, tier):
    r = H.rows(a, "SELECT ca.adjusted_band FROM pm_calibration_adjustments ca JOIN pm_calibration_sessions cs ON cs.id=ca.session_id "
                  "WHERE cs.tier=? AND ca.subject_id=? ORDER BY ca.id DESC LIMIT 1", (tier, ID[k]))
    return r[0][0] if r else None


def forced(tool, args):
    """A model that proposes this action and, once it has the answer, says it is done."""
    def f(system, history):
        if history and history[-1].get("role") == "tool":
            return {"say": "Let me know.", "quick_replies": [], "action": None}
        return {"say": "Moving.", "quick_replies": [], "action": {"tool": tool, "args": args}}
    return f


def agent_said(who, stage, text, chips, scope):
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("INSERT INTO pm_manager_chat(reviewer_id, cycle_id, report_id, stage, role, content, quick_replies, scope) "
                  "VALUES (?,?,NULL,?,'agent',?,?,?)", (who, CID, stage, text, json.dumps(chips), scope))
        d.commit()


def turn(c, msg, view, stage, **kw):
    d = {"csrf_token": "tok", "message": msg, "journey": "1", "view": view, "stage": stage}
    d.update(kw)
    return c.post("/review/chat", data=d).get_json() or {}


_real = a.ai_draft.review_agent
cb, cg = H.client_as(a, BUC), H.client_as(a, BGC)
PM = "pm_calibration_adjustments"
mvA = {"subject": NAMES["A"], "band": "AE"}
mvB = {"subject": NAMES["B"], "band": "AE"}
try:
    # -----------------------------------------------------------------------
    s.section("(c) a bare yes follows the offer: for the person offered, never another")
    agent_said(BUC, "calibration", "Shall I move Aminah to Above Expectation?", ["Move Aminah to Above Expectation"], "buceo")
    a.ai_draft.review_agent = forced("move_band", mvB)
    r = turn(cb, "yes", "bu", "calibration")
    s.check("a yes after an offer for Aminah, the model calling for Bala: refused, no row for either",
            n_rows(PM, "B") == 0 and n_rows(PM, "A") == 0, (r.get("say"), n_rows(PM, "B")))
    agent_said(BUC, "calibration", "Shall I move Aminah to Above Expectation?", ["Move Aminah to Above Expectation"], "buceo")
    a.ai_draft.review_agent = forced("move_band", mvB)
    r = turn(cb, "yes, move it", "bu", "calibration")
    s.check("...the verb-only ask the same", n_rows(PM, "B") == 0 and n_rows(PM, "A") == 0, r.get("say"))
    agent_said(BUC, "calibration", "Shall I move Aminah to Above Expectation?", ["Move Aminah to Above Expectation"], "buceo")
    a.ai_draft.review_agent = forced("move_band", mvA)
    r = turn(cb, "yes", "bu", "calibration")
    s.check("the same yes with the model calling for Aminah: moved", n_rows(PM, "A") == 1 and band(PM, "A") == "AE", r.get("say"))
    # the refusal text, on a fresh stray ask
    a.ai_draft.review_agent = lambda sy, h: {"say": "I've moved them.", "quick_replies": [], "action": {"tool": "move_band", "args": mvB}}
    agent_said(BUC, "calibration", "Shall I move Aminah to Above Expectation?", ["Move Aminah to Above Expectation"], "buceo")
    r = turn(cb, "yes", "bu", "calibration")
    s.check("a model that insists: 'Nothing is moved yet...' with a Move Bala chip, nothing written",
            "Nothing is moved yet" in (r.get("say") or "") and (r.get("quick_replies") or [""])[0].startswith("Move Bala")
            and n_rows(PM, "B") == 0, (r.get("say"), r.get("quick_replies")))

    # -----------------------------------------------------------------------
    s.section("(b) a name in the leader's own message")
    a.ai_draft.review_agent = forced("move_band", {"subject": NAMES["B"], "band": "ME"})
    r = turn(cb, "move Bala to ME", "bu", "calibration")
    s.check("'move Bala to ME' for Bala: moved", n_rows(PM, "B") == 1 and band(PM, "B") == "ME", r.get("say"))
    a.ai_draft.review_agent = forced("move_band", {"subject": NAMES["C"], "band": "ME"})
    r = turn(cb, "move Bala to ME", "bu", "calibration")
    s.check("'move Bala to ME' with the model proposing Chen instead: refused, nothing written for Chen",
            n_rows(PM, "C") == 0, r.get("say"))
    a.ai_draft.review_agent = forced("move_band", {"subject": NAMES["C"], "band": "ME"})
    r = turn(cb, "move chen to ME", "bu", "calibration")
    s.check("a name is matched case-insensitively, by any word of 2+ letters ('chen')", n_rows(PM, "C") == 1, r.get("say"))

    # -----------------------------------------------------------------------
    s.section("(a) the person open on the screen")
    a.ai_draft.review_agent = forced("move_band", {"subject": NAMES["B"], "band": "OU"})
    n = n_rows(PM, "B")
    turn(cb, "move her to OU", "bu", "calibration")
    s.check("'move her to OU' with nobody in focus: refused (no name, nothing on screen)", band(PM, "B") == "ME", band(PM, "B"))
    turn(cb, "move her to OU", "bu", "calibration", person=str(ID["B"]))
    s.check("...with Bala open on screen: moved", band(PM, "B") == "OU", band(PM, "B"))
    a.ai_draft.review_agent = forced("move_band", {"subject": NAMES["A"], "band": "OU"})
    turn(cb, "move her to OU", "bu", "calibration", person=str(ID["B"]))
    s.check("...with Bala open but the model proposing Aminah: refused", band(PM, "A") == "AE", band(PM, "A"))

    # -----------------------------------------------------------------------
    s.section("the BG CEO's Talent Box")
    agent_said(BGC, "talent_box", "Shall I move Aminah to performance ME?", ["Move Aminah to performance ME"], "bgceo")
    a.ai_draft.review_agent = forced("move_person", {"subject": NAMES["B"], "performance_band": "ME"})
    n = n_rows(PM, "B")
    turn(cg, "yes", "bg", "talent_box")
    s.check("a yes after an offer for Aminah, the model moving Bala: refused", n_rows(PM, "B") == n and
            H.one(a, "SELECT COUNT(*) FROM pm_calibration_adjustments ca JOIN pm_calibration_sessions cs ON cs.id=ca.session_id "
                     "WHERE cs.tier='bgceo' AND ca.subject_id=?", (ID["B"],)) == 0)
    turn(cg, "move Bala to performance ME", "bg", "talent_box")
    s.check("a named ask for Bala: moved", H.one(
        a, "SELECT COUNT(*) FROM pm_calibration_adjustments ca JOIN pm_calibration_sessions cs ON cs.id=ca.session_id "
           "WHERE cs.tier='bgceo' AND ca.subject_id=?", (ID["B"],)) == 1)
    a.ai_draft.review_agent = forced("move_person", {"subject": NAMES["C"], "performance_band": "AE"})
    turn(cg, "move her to performance AE", "bg", "talent_box", person=str(ID["C"]))
    s.check("'move her to performance AE' with Chen open on the box: moved", H.one(
        a, "SELECT COUNT(*) FROM pm_calibration_adjustments ca JOIN pm_calibration_sessions cs ON cs.id=ca.session_id "
           "WHERE cs.tier='bgceo' AND ca.subject_id=?", (ID["C"],)) == 1)

    # -----------------------------------------------------------------------
    s.section("the classic assistant's chat holds the same rule")
    q = {"csrf_token": "tok", "tier": "buceo", "bg": BG, "company": CA}

    def classic_offer():
        with a.app.test_request_context("/"):
            d = a.get_db()
            d.execute("INSERT INTO pm_calib_chat(actor_id, cycle_id, tier, scope_key, role, content, quick_replies) "
                      "VALUES (?,?,'buceo',?,'agent','Shall I move Aminah to Above Expectation?',?)",
                      (BUC, PER, CA, json.dumps(["Move Aminah to Above Expectation"])))
            d.commit()
    n = n_rows(PM, "C")
    classic_offer()
    a.ai_draft.review_agent = forced("move_band", {"subject": NAMES["C"], "band": "OU"})
    cb.post("/performance/calibration/assist/chat", data=dict(q, message="yes"))
    s.check("classic chat: a yes after an offer for Aminah, the model moving Chen: refused", band_at("C", "buceo") == "ME", band_at("C", "buceo"))
    cb.post("/performance/calibration/assist/chat", data=dict(q, message="move Chen to OU"))
    s.check("...a named ask for Chen: moved", band_at("C", "buceo") == "OU", band_at("C", "buceo"))
    classic_offer()
    a.ai_draft.review_agent = forced("move_band", {"subject": NAMES["A"], "band": "OU"})
    cb.post("/performance/calibration/assist/chat", data=dict(q, message="yes"))
    s.check("...a yes after an offer for Aminah, the model moving Aminah: moved", band_at("A", "buceo") == "OU", band_at("A", "buceo"))
finally:
    a.ai_draft.review_agent = _real

# ---------------------------------------------------------------------------
s.section("common name parts never identify anyone: bin, Muhammad, Nur, Siti ...")
NAMES2 = {"D": "Ahmad bin Ali", "E": "Kamal bin Yusof", "F": "Muhammad Hakim", "G": "Muhammad Zaid", "H": "Ng Wei",
          "I": "Nur Siti"}
with a.app.test_request_context("/"):
    db = a.get_db()
    for k, n in NAMES2.items():
        ID[k] = person("ZZMS-%s" % k, n)
    db.commit()
NAMES.update(NAMES2)
try:
    def stray(who_msg, k, band="AE", **kw):
        a.ai_draft.review_agent = forced("move_band", {"subject": NAMES[k], "band": band})
        turn(cb, who_msg, "bu", "calibration", **kw)
    stray("move Ahmad bin Ali to AE", "D")
    s.check("'move Ahmad bin Ali to AE' binds Ahmad bin Ali", band_at("D", "buceo") == "AE", band_at("D", "buceo"))
    stray("move Ahmad bin Ali to AE", "E")
    s.check("...but not Kamal bin Yusof (the same 'bin')", n_rows(PM, "E") == 0)
    stray("move Muhammad Hakim to AE", "F")
    s.check("'move Muhammad Hakim to AE' binds Hakim", band_at("F", "buceo") == "AE")
    stray("move Muhammad Hakim to ME", "G")
    s.check("...and does not cross-bind Muhammad Zaid on 'Muhammad'", n_rows(PM, "G") == 0)
    stray("move Muhammad to ME", "G")
    s.check("'Muhammad' alone names no one", n_rows(PM, "G") == 0 and n_rows(PM, "F") == 1)
    stray("move Ng to ME", "H", "ME")
    s.check("'move Ng to ME' binds the person named Ng Wei (a 2-letter surname still counts)", band_at("H", "buceo") == "ME")
    stray("move Nur Siti to AE", "I")
    s.check("a name of nothing but particles (Nur Siti) is bound by no typed name", n_rows(PM, "I") == 0)
    stray("move her to AE", "I", person=str(ID["I"]))
    s.check("...only by the person open on the screen (a)", band_at("I", "buceo") == "AE")
    agent_said(BUC, "calibration", "Shall I move Nur Siti to Above Expectation?", ["Move Nur Siti to Above Expectation"], "buceo")
    stray("yes", "E")
    s.check("...or by the offer that named them (c): a yes after it moves them, never someone else", n_rows(PM, "E") == 0)
    agent_said(BUC, "calibration", "Shall I move Nur Siti to Outstanding?", ["Move Nur Siti to Outstanding"], "buceo")
    stray("yes", "I", "OU")
    s.check("...the same yes for Nur Siti moves her", band_at("I", "buceo") == "OU", band_at("I", "buceo"))
finally:
    a.ai_draft.review_agent = _real
s.check("the stoplist: particles and titles dropped, 2-letter surnames kept",
        a._team_move_name_tokens("Dr Ahmad bin Ali") == {"ahmad", "ali"} and a._team_move_name_tokens("Ng Wei") == {"ng", "wei"}
        and a._team_move_name_tokens("Nur Siti") == set() and a._team_move_name_tokens("Nur Siti", keep_common=True) == {"nur", "siti"})

s.section("the client sends the person on screen")
js = H.source(a, "static/journey_chat.js")
s.check("the BU CEO's open person page and the Talent Box's open person are sent as `person`",
        'if (_pr) { f.append("person", String(_pr.id)); if (cal.data.review && calHeld[_pr.id])' in js
        and 'f.append("person", String(tb.person.id));' in js)

sys.exit(s.done())
