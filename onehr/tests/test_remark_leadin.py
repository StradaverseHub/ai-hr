"""A dictated lead-in is not the person's words (2026-10-31). GPT-6 Luna saved "Here is my overall remark. Please save
it as it is:" at the head of the remark in 3 of 6 staging runs. Three ways a remark is stored, all three can carry it:

  * the agent's text tools (_PERSON_TEXT_TOOLS), through _person_text_tidy before _person_text_guard in all 6 loops
  * the server's own intake (_journey_remark_intake), before any model
  * save_remark{} / "yes, save it", both ending in _journey_store_remark

This suite proves:
  * _text_leadin_strip: every must-strip case strips, every must-stay case comes back as the IDENTICAL string
  * the agent path end to end (a scripted set_overall_remark through the real chat route) stores the remark without the
    lead-in, newlines kept; a control without a lead-in is stored as is
  * the intake path and save_remark{} store it without the lead-in
  * falsified: with _person_text_tidy a no-op the same run DOES store the lead-in (so the test reaches the line)
  * lint: every _person_text_guard( call is preceded by _person_text_tidy(action) within 3 lines
  * the classic Remarks box (_review_write_overall_remark) keeps exactly what a person typed
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
import ai_draft  # noqa: E402
s = H.Suite("Remark lead-in -- a dictated 'save it as it is:' is never saved as their words")

CHBM = "CHIN HIN BUILDING MATERIAL (CHBM)"   # mechanism A (5-point) in the fixture
strip = a._text_leadin_strip

# ---------------------------------------------------------------------------
s.section("_text_leadin_strip: what must stay, byte for byte")
STAY = [
    "Here is what I achieved this year: I grew sales by 12%.",
    "I keep my word. I delivered every project on time.",
    "Keep it simple: I hit 3 of 4 targets.",
    "Save costs: I cut spending by 10%.",
    "Please note that I joined in March. I led the audit.",
    "This is my reflection on the year: steady growth.",
    "Saya simpan rekod jualan setiap bulan: jualan naik 12%.",
    "Here is my overall remark.",                                    # nothing follows
    "Here is my overall remark:\nThanks.",                            # one real word follows
    "I led the team. Please save it as it is.",                       # a lead-in only counts at the start
    "I led the CHBM rollout on time.\nI coached two new hires.",      # no lead-in at all
    "My remark is that I led the team well this year.",              # content in the sentence
    "Please save the sales figures: I grew sales by 12% this year.",
    # a save verb alone is a content opener or a heading (needs an object or a manner after it)
    "Log in. I fixed the portal for 300 users.",
    "Use the new form. It saved us 3 days.",
    "Record: 12 deals closed this year.",
    "Simpan. Saya capai sasaran.",
    "Keep going. I hit 3 of 4 targets.",
    # a courtesy followed by content is their words
    "Ok. I led the team.",
    "Thanks! I led the team and coached two hires.",
    "",
    "   ",
]
for t in STAY:
    s.check("unchanged (the same string): %r" % t[:50], strip(t) is t, repr(strip(t)))
s.check("non-str input comes back as is", strip(None) is None and strip(5) == 5)
_lst = ["x"]
s.check("...a list too", strip(_lst) is _lst)

# ---------------------------------------------------------------------------
s.section("_text_leadin_strip: what must go")
THREE = "I led the CHBM rollout on time.\nI coached two new hires."
GO = [
    ("Here is my overall remark. Please save it as it is:\n" + THREE, THREE),
    ("Here is my overall remark... Please save it as it is: I led the CHBM rollout on time. I coached two new hires.",
     "I led the CHBM rollout on time. I coached two new hires."),
    ("Here's my remark, please save it exactly as written: I led the team well this year.",
     "I led the team well this year."),
    ("Please save this as my overall remark: I led the team well this year.", "I led the team well this year."),
    ("Can you save the following as my remark word for word? I led the team well this year.",
     "I led the team well this year."),
    ("Ok, here is my overall remark: I led the team well this year.", "I led the team well this year."),
    ("My overall remark is: I led the team well this year.", "I led the team well this year."),
    ('Please save it as it is: "I led the team well this year."', "I led the team well this year."),
    ("Please save it as it is: “I led the team well this year.”", "I led the team well this year."),
    ("Please save it as it is: 'I led the team well this year.'", "I led the team well this year."),
    ("Please save it as it is: ‘I led the team well this year.’", "I led the team well this year."),
    ("Berikut ialah ulasan keseluruhan saya. Sila simpan seperti yang ditulis:\nSaya memimpin pasukan.\nSaya melatih dua orang.",
     "Saya memimpin pasukan.\nSaya melatih dua orang."),
    ("Tolong simpan ulasan ini sebiji-sebiji: Saya memimpin pasukan dengan baik.", "Saya memimpin pasukan dengan baik."),
    ("Ini ulasan saya, sila simpan tanpa sebarang perubahan: Saya memimpin pasukan dengan baik.",
     "Saya memimpin pasukan dengan baik."),
    ("Ok. Here is my overall remark. Please save it as it is:\nA did B.\nC did D.", "A did B.\nC did D."),
    ("Thanks! Here is my remark: I led the team.", "I led the team."),
    ("Save as is: I led the team.", "I led the team."),
    ("Here is my remark. Thanks. I led the team.", "I led the team."),
    ("Take this as my remark: I led the team.", "I led the team."),
    ("Hello, thanks! Ok. Here is my remark: I led the team.", "I led the team."),
    # the remainder is kept exactly: inner newlines, double spaces, punctuation
    ("Here is my overall remark:\n\n  I led  the team -- well!\n\nAnd coached.  ", "I led  the team -- well!\n\nAnd coached.  "),
]
for t, want in GO:
    got = strip(t)
    s.check("stripped: %r" % t[:55], got == want, repr(got))
s.check("three lead-in sentences in a row go, four do not (at most 3)",
        strip("Save it. Keep it. Use it. I led the team well.") == "I led the team well."
        and strip("Save it. Keep it. Use it. Copy it. I led the team well.") == "Copy it. I led the team well.")
s.check("a quote that also holds another quote inside is NOT unwrapped",
        strip('Please save it as it is: "I said "go" and led the team."') == '"I said "go" and led the team."'
        and strip("Please save it as it is: 'I didn't stop and led the team.'") == "'I didn't stop and led the team.'")
s.check("quotes are unwrapped only when something was stripped",
        strip('"I led the team well this year."') == '"I led the team well this year."')
s.check("a remainder under two words is refused (the original comes back)",
        strip("Please save it as it is: Done") == "Please save it as it is: Done")
s.check("a comma does not end a sentence ('Here is my remark, I led the team.' keeps its content)",
        strip("Here is my remark, I led the team well this year.") == "Here is my remark, I led the team well this year.")
s.check("a sentence over 25 words is never a lead-in",
        strip("Please save " + "it " * 30 + "as it is: I led the team well.").startswith("Please save"))

# ---------------------------------------------------------------------------
s.section("lint: every agent loop tidies BEFORE it guards")
SRC = H.source(a)
_lines = SRC.split("\n")
_guard_calls = [i for i, ln in enumerate(_lines) if "_person_text_guard(" in ln and not ln.lstrip().startswith("def ")
                and not ln.lstrip().startswith("#")]
_tidy_ok = [i for i in _guard_calls if any("_person_text_tidy(action)" in _lines[j] for j in range(max(0, i - 3), i))]
s.check("there are guard call sites at all", len(_guard_calls) > 0, len(_guard_calls))
s.check("every _person_text_guard( call has _person_text_tidy(action) within the 3 lines before it",
        len(_tidy_ok) == len(_guard_calls), (len(_tidy_ok), len(_guard_calls)))
s.check("the tidy calls are exactly as many as the guard calls (none stray)",
        len(re.findall(r"^\s+_person_text_tidy\(action\)", SRC, re.M)) == len(_guard_calls)
        and len(re.findall(r"^def _person_text_tidy\(", SRC, re.M)) == 1
        and len(re.findall(r"^def _text_leadin_strip\(", SRC, re.M)) == 1,
        (len(re.findall(r"^\s+_person_text_tidy\(action\)", SRC, re.M)), len(_guard_calls)))
s.check("_person_text_guard itself is unchanged by this (it does not call the strip)",
        "_text_leadin_strip" not in SRC[SRC.index("def _person_text_guard("):SRC.index("def _person_text_tidy(")])
s.check("the classic Remarks box write does not strip (a person typing in the box keeps exactly what they typed)",
        "_text_leadin_strip" not in SRC[SRC.index("def _review_write_overall_remark("):
                                        SRC.index("def _review_write_overall_remark(") + 3000])

# ---------------------------------------------------------------------------
s.section("_person_text_tidy: the tool's text arguments, in place")
_act = {"tool": "set_overall_remark", "args": {"text": "Please save it as it is: I led the team well.", "other": "Please. Keep it."}}
a._person_text_tidy(_act)
s.check("a set_overall_remark text argument is stripped in place; an argument that is not a text arg is left",
        _act["args"]["text"] == "I led the team well." and _act["args"]["other"] == "Please. Keep it.", _act)
_mob = {"tool": "set_field", "args": {"field": "mobility", "value": "Please save it as it is: Yes anywhere."}}
a._person_text_tidy(_mob)
s.check("the mobility choice field is skipped, like the guard",
        _mob["args"]["value"] == "Please save it as it is: Yes anywhere.")
_other = {"tool": "record_kpi_result", "args": {"actual_value": "Please save it as it is: 4 now."}}
a._person_text_tidy(_other)
s.check("a tool outside _PERSON_TEXT_TOOLS is untouched", _other["args"]["actual_value"] == "Please save it as it is: 4 now.")
for _bad in (None, {}, {"tool": "set_overall_remark"}, {"tool": "set_overall_remark", "args": "x"},
             {"tool": "set_overall_remark", "args": {"text": 7}}):
    try:
        a._person_text_tidy(_bad)
        _fine = True
    except Exception as e:   # noqa: BLE001
        _fine = str(e)
    s.check("a malformed action does not raise: %r" % (_bad,), _fine is True, _fine)

# ---------------------------------------------------------------------------
s.section("build: two employees on the KPI check-in (the journey on)")
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','evidence','tm','idp','pm')")
    db.execute("UPDATE cycles SET kind='mid_year' WHERE id=?", (CID,))
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES('review_unified','1')")
    # Not Grade H: the combined build keeps Grade H out of the normal review (Grade H branch), so such a person has no KPI
    # check-in stage to post to; the shared branch has no such rule and this filter changes nothing there.
    us = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL "
                    "AND UPPER(TRIM(COALESCE(job_grade,''))) NOT IN ('H','JG H') ORDER BY id LIMIT 2").fetchall()
    UA, UB = dict(us[0]), dict(us[1])    # UA: the agent path (nothing keyed); UB: the intake path (all keyed)
    if not db.execute("SELECT 1 FROM pm_bg_config WHERE business_group=?", (CHBM,)).fetchone():
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (CHBM,))

    def _kpi(subj, name, rates):
        r = dict(zip(("rate1", "rate2", "rate3", "rate4", "rate5"), rates))
        return db.execute(
            "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
            "rate1, rate2, rate3, rate4, rate5) VALUES (?,?,?,?, 'more', 'approved', ?, ?, ?, ?, ?, ?)",
            (CID, subj, name, 50.0, CHBM, r["rate1"], r["rate2"], r["rate3"], r["rate4"], r["rate5"])).lastrowid
    for _u in (UA, UB):
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id=? AND cycle_id=?", (_u["id"], CID))
        db.execute("DELETE FROM pm_overall_remarks WHERE subject_id=? AND cycle_id=?", (_u["id"], CID))
        db.execute("DELETE FROM pm_review_chat WHERE subject_id=? AND cycle_id=?", (_u["id"], CID))
    _kpi(UA["id"], "ZZ Lead GP", (9, 11, 12, 13, 15))
    _kpi(UA["id"], "ZZ Lead DM", (1, 2, 3, 4, 5))
    _b1 = _kpi(UB["id"], "ZZ Lead GP", (9, 11, 12, 13, 15))
    _b2 = _kpi(UB["id"], "ZZ Lead DM", (1, 2, 3, 4, 5))
    db.commit()
with a.app.test_request_context("/"):
    from flask import session as _ses
    _ses["user_id"] = UB["id"]
    _kdb = a.get_db()
    _ku = dict(_kdb.execute("SELECT * FROM users WHERE id=?", (UB["id"],)).fetchone())
    a._review_record_one(_kdb, _ku, CID, _b1, 12)   # a middle rung each: no supporting file owed
    a._review_record_one(_kdb, _ku, CID, _b2, 3)
with a.app.app_context():
    _d = a.get_db()
    _ub_open = a._review_remark_step_open(_d, dict(_d.execute("SELECT * FROM users WHERE id=?", (UB["id"],)).fetchone()))
    _ua_open = a._review_remark_step_open(_d, dict(_d.execute("SELECT * FROM users WHERE id=?", (UA["id"],)).fetchone()))
s.check("precondition: UB's remark step is open, UA's is not (so UA's remark can only come from a model action)",
        _ub_open is True and _ua_open is False, (_ub_open, _ua_open))


def post(client, url, **form):
    form.setdefault("csrf_token", "tok")
    return client.post(url, data=form)


def remark_of(uid):
    return H.one(a, "SELECT (SELECT remark FROM pm_overall_remarks WHERE subject_id=? AND cycle_id=?)", (uid, CID))


def reset(uid, transcript=True):
    with a.app.app_context():
        _x = a.get_db()
        _x.execute("DELETE FROM pm_overall_remarks WHERE subject_id=? AND cycle_id=?", (uid, CID))
        if transcript:
            _x.execute("DELETE FROM pm_review_chat WHERE subject_id=? AND cycle_id=?", (uid, CID))
        _x.commit()


SCRIPT = []


def stub_agent(system, messages, timeout=90):
    return SCRIPT.pop(0)


_avail, _agent = ai_draft.review_agent_available, ai_draft.review_agent
ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = stub_agent
_real_tidy = a._person_text_tidy
try:
    GA = H.client_as(a, UA["id"])
    GB = H.client_as(a, UB["id"])
    DICTATED = "Here is my overall remark. Please save it as it is:\n" + THREE

    # -----------------------------------------------------------------------
    s.section("the agent path: set_overall_remark through the real chat route")
    reset(UA["id"])
    SCRIPT[:] = [{"say": "Saving it.", "quick_replies": [],
                  "action": {"tool": "set_overall_remark", "args": {"text": DICTATED}}},
                 {"say": "That's saved.", "quick_replies": [], "action": None}]
    ra = post(GA, "/review/chat?journey=1", message=DICTATED, stage="account").get_json(silent=True) or {}
    s.check("the model's action ran (both scripted turns used)", not SCRIPT, len(SCRIPT))
    s.check("the stored remark is exactly the 3 lines, newline kept, no lead-in",
            remark_of(UA["id"]) == THREE, repr(remark_of(UA["id"])))

    reset(UA["id"])
    CONTROL = "Here is what I achieved this year: I led the CHBM rollout on time."
    SCRIPT[:] = [{"say": "Saving it.", "quick_replies": [],
                  "action": {"tool": "set_overall_remark", "args": {"text": CONTROL}}},
                 {"say": "That's saved.", "quick_replies": [], "action": None}]
    post(GA, "/review/chat?journey=1", message=CONTROL, stage="account")
    s.check("control: a remark that only looks like a lead-in is stored unchanged",
            remark_of(UA["id"]) == CONTROL, repr(remark_of(UA["id"])))

    reset(UA["id"])
    SCRIPT[:] = [{"say": "Saving it.", "quick_replies": [],
                  "action": {"tool": "set_overall_remark", "args": {"text": THREE}}},
                 {"say": "That's saved.", "quick_replies": [], "action": None}]
    post(GA, "/review/chat?journey=1", message=THREE, stage="account")
    s.check("control: a remark with no lead-in at all is stored unchanged (newlines kept)",
            remark_of(UA["id"]) == THREE, repr(remark_of(UA["id"])))

    # -----------------------------------------------------------------------
    s.section("falsify: with the tidy switched off the same run DOES store the lead-in")
    reset(UA["id"])
    a._person_text_tidy = lambda action: None
    try:
        SCRIPT[:] = [{"say": "Saving it.", "quick_replies": [],
                      "action": {"tool": "set_overall_remark", "args": {"text": DICTATED}}},
                     {"say": "That's saved.", "quick_replies": [], "action": None}]
        post(GA, "/review/chat?journey=1", message=DICTATED, stage="account")
        _bad = remark_of(UA["id"])
    finally:
        a._person_text_tidy = _real_tidy
    s.check("tidy a no-op -> the stored remark carries the lead-in (the test reaches the line)",
            _bad == DICTATED, repr(_bad))
    s.check("...and the real function is back", a._person_text_tidy is _real_tidy)
    reset(UA["id"])

    # -----------------------------------------------------------------------
    s.section("the server's intake: saved before the model, without the lead-in")
    reset(UB["id"])
    SCRIPT[:] = [{"say": "SHOULD NOT BE REACHED", "quick_replies": [], "action": None}]
    rb = post(GB, "/review/chat?journey=1", message=DICTATED, stage="account").get_json(silent=True) or {}
    s.check("intake: the remark is stored without the lead-in, newlines kept (no model call)",
            remark_of(UB["id"]) == THREE and len(SCRIPT) == 1, (repr(remark_of(UB["id"])), len(SCRIPT)))
    s.check("...and the reply is the server's saved line, with the card at its remark box",
            (rb.get("say") or "").startswith("That's your remark saved"), rb.get("say"))

    reset(UB["id"])
    _real_strip = a._text_leadin_strip
    a._text_leadin_strip = lambda t: t
    try:
        SCRIPT[:] = [{"say": "SHOULD NOT BE REACHED", "quick_replies": [], "action": None}]
        post(GB, "/review/chat?journey=1", message=DICTATED, stage="account")
        _bad2 = remark_of(UB["id"])
    finally:
        a._text_leadin_strip = _real_strip
    s.check("falsify: with the strip a no-op the intake DOES store the lead-in (the test reaches the line)",
            _bad2 == DICTATED, repr(_bad2))

    reset(UB["id"])
    SCRIPT[:] = [{"say": "SHOULD NOT BE REACHED", "quick_replies": [], "action": None}]
    FLAT = ("Here is my overall remark... Please save it as it is: I led the CHBM rollout on time. "
            "I coached two new hires.")
    post(GB, "/review/chat?journey=1", message=FLAT, stage="account")
    s.check("intake: the same flattened onto one line",
            remark_of(UB["id"]) == "I led the CHBM rollout on time. I coached two new hires.", repr(remark_of(UB["id"])))

    reset(UB["id"])
    SCRIPT[:] = [{"say": "SHOULD NOT BE REACHED", "quick_replies": [], "action": None}]
    NOLEAD = "I led the CHBM rollout on time. I coached two new hires."
    post(GB, "/review/chat?journey=1", message=NOLEAD, stage="account")
    s.check("intake: a remark with no lead-in is stored exactly as typed", remark_of(UB["id"]) == NOLEAD,
            repr(remark_of(UB["id"])))

    # -----------------------------------------------------------------------
    s.section("save_remark{} and 'yes, save it' end in the same store")
    with a.app.test_request_context("/"):
        from flask import session as _ses2
        _ses2["user_id"] = UB["id"]
        _sdb = a.get_db()
        _su = dict(_sdb.execute("SELECT * FROM users WHERE id=?", (UB["id"],)).fetchone())
        reset_needed = _sdb.execute("DELETE FROM pm_overall_remarks WHERE subject_id=? AND cycle_id=?",
                                    (UB["id"], CID))
        _sdb.commit()
        _r1 = a._journey_store_remark(_sdb, _su, CID, "account", None, DICTATED)
    s.check("_journey_store_remark itself strips the lead-in (covers save_remark and the approval path)",
            _r1.get("ok") and remark_of(UB["id"]) == THREE, (_r1.get("ok"), repr(remark_of(UB["id"]))))
    reset(UB["id"])
    with a.app.test_request_context("/"):
        from flask import session as _ses3
        _ses3["user_id"] = UB["id"]
        _sdb = a.get_db()
        _su = dict(_sdb.execute("SELECT * FROM users WHERE id=?", (UB["id"],)).fetchone())
        _r2 = a._journey_save_remark(_sdb, _su, CID, "account", None, DICTATED, history=[])
    s.check("save_remark{} (_journey_save_remark) stores the person's last message without the lead-in",
            _r2.get("ok") and remark_of(UB["id"]) == THREE, (_r2, repr(remark_of(UB["id"]))))

    # 'yes, save it' for a remark they wrote earlier, which carries the lead-in
    reset(UB["id"])
    with a.app.app_context():
        _x = a.get_db()
        for _role, _txt in (("user", DICTATED), ("agent", "Here's your remark: “" + DICTATED + "”. Shall I save it?")):
            _x.execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, stage) VALUES (?,?,?,?, 'account')",
                       (UB["id"], CID, _role, _txt))
        _x.commit()
    SCRIPT[:] = [{"say": "SHOULD NOT BE REACHED", "quick_replies": [], "action": None}]
    post(GB, "/review/chat?journey=1", message="Yes, save it", stage="account")
    s.check("'yes, save it' on a remark that carries the lead-in stores it without",
            remark_of(UB["id"]) == THREE, repr(remark_of(UB["id"])))

    # -----------------------------------------------------------------------
    s.section("the classic Remarks box keeps exactly what a person typed")
    reset(UB["id"])
    with a.app.test_request_context("/"):
        from flask import session as _ses4
        _ses4["user_id"] = UB["id"]
        _cdb = a.get_db()
        _cu = dict(_cdb.execute("SELECT * FROM users WHERE id=?", (UB["id"],)).fetchone())
        a._review_write_overall_remark(_cdb, _cu, CID, DICTATED)
        _cdb.commit()
    s.check("_review_write_overall_remark stores the box text as typed, lead-in and all",
            remark_of(UB["id"]) == DICTATED, repr(remark_of(UB["id"])))
finally:
    ai_draft.review_agent_available, ai_draft.review_agent = _avail, _agent
    a._person_text_tidy = _real_tidy
    a._text_leadin_strip = strip
    for _u in (UA, UB):
        reset(_u["id"])

sys.exit(s.done())
