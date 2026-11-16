"""A person's past talent status for the BU CEO's and BG CEO's agents, only when asked (Chris, 2026-10-22: "give the
BU CEO and BG CEO agents each person's past three years of talent status (with its source, HR's records or OneHR)",
then "do not show on the talent box or calibration profile" and "only answer if the BUCEO or BGCEO query about it").

  * _past_talent: the three Year-Ends before the active cycle's year, newest first, each with its source; a year with no
    record says so; the current year and older ones never come in
  * past_talent{subject} is a tool of its own, served to the BU CEO and BG CEO tiers only (not the HOD, not the Group
    Chief), for someone in their own scope
  * the BG CEO's Talent Box prompt and the BU / BG CEO calibration prompts name it, with the only-when-asked rule; the
    Group Chief's does not
  * no page shows it: the Talent Box person page, open_person / explain_person and the client carry no past years
  * EXCEPT the Executive Chairman's Record tab (Chris, 2026-10-29: "past talent status for X0003 only"): the chair's own route
    (chair_leaders_record) and the client code that asks it (chairRecordSection / chairRecordFetch) are the ONLY other
    readers, named here; tests/test_exec_chair_box.py proves the route refuses everyone but the chair
  * and his AI insight card's "three years running" / "first time" findings (P3, 2026-10-29): _chair_insight_history is the one
    reader (through talent_history_for), called only by _chair_insight_compute, which is empty for anyone but the chair;
    tests/test_exec_chair_insight.py proves nobody else is counted for

Writes, so a fresh copy, put back at the end.
"""
import inspect
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Past talent status -- the BU / BG CEO agents' own tool, only when asked, on no page")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
JS = open(os.path.join(H.REPO, "static", "journey_chat.js"), encoding="utf-8").read()
TPL_DIR = os.path.join(H.REPO, "templates")

CATS = list(a.TALENT_CATEGORY_SLUG)
with a.app.test_request_context("/"):
    db = a.get_db()
    Y = a._cycle_year_half(a.active_cycle(db))[0]
    P1, P2 = [r["id"] for r in db.execute(
        "SELECT id FROM users WHERE role!='admin' AND left_at IS NULL ORDER BY id LIMIT 2")]
    db.execute("DELETE FROM talent_status_history WHERE subject_id IN (?,?)", (P1, P2))
    for yr, cat, perf, pot, src in ((Y, CATS[0], None, None, "calibration"),          # this year: never
                                    (Y - 1, CATS[2], "ME", "Mid", "import"),           # last year, HR's, both bands
                                    (Y - 2, CATS[1], None, None, "calibration"),       # OneHR's own lock
                                    (Y - 4, CATS[3], None, None, "import")):           # four years back: never
        db.execute("INSERT INTO talent_status_history(subject_id, year, category, performance_band, potential_band, "
                   "source) VALUES (?,?,?,?,?,?)", (P1, yr, cat, perf, pot, src))
    db.commit()
    past = a._past_talent(db, P1)
    none = a._past_talent(db, P2)
    sub1 = dict(db.execute("SELECT * FROM users WHERE id=?", (P1,)).fetchone())
    sub2 = dict(db.execute("SELECT * FROM users WHERE id=?", (P2,)).fetchone())
    ctx = {"population": [sub1]}
    t_bu = a._past_talent_tool(db, "buceo", ctx, {"subject": P1})
    t_bg = a._past_talent_tool(db, "bgceo", ctx, {"subject": sub1["full_name"]})
    t_hod = a._past_talent_tool(db, "hod", ctx, {"subject": P1})
    t_gc = a._past_talent_tool(db, "group", ctx, {"subject": P1})
    t_out = a._past_talent_tool(db, "buceo", ctx, {"subject": P2})
    r_calib = a._calib_run_tool(db, sub2, ctx, "buceo", None, {"tool": "past_talent", "args": {"subject": P1}})
    r_hod = a._calib_run_tool(db, sub2, ctx, "hod", None, {"tool": "past_talent", "args": {"subject": P1}})
    r_pot = a._pot_calib_run_tool(db, sub2, ("bgceo", None, ctx), {"tool": "past_talent", "args": {"subject": P1}})

s.section("the reader: the three Year-Ends before this one, with their source")
s.check("three years, newest first: last year, two years ago, three years ago",
        [x["year"] for x in past] == [Y - 1, Y - 2, Y - 3], past)
s.check("last year: HR's status with both its bands, said as Group People's records from before OneHR",
        past[0]["status"] == CATS[2] and past[0]["performance"] == a.PM_LABEL_NAMES["ME"]
        and past[0]["potential"] == "Mid" and past[0]["from"] == "Group People's records (before OneHR)", past[0])
s.check("two years ago: OneHR's own, no bands where the record holds none",
        past[1]["status"] == CATS[1] and past[1]["from"] == "OneHR" and past[1]["performance"] is None, past[1])
s.check("a year with no record says so, never guessed", past[2]["status"] is None and past[2]["note"] == "no record"
        and past[2]["said"] == "%d: no record" % (Y - 3))
s.check("each year's ready line carries its source (Luna dropped it 2 of 3 without one)",
        past[0]["said"] == "%d: %s (%s performance, Mid potential), from Group People's records (before OneHR)"
        % (Y - 1, CATS[2], a.PM_LABEL_NAMES["ME"]) and past[1]["said"] == "%d: %s, from OneHR" % (Y - 2, CATS[1]),
        [x["said"] for x in past])
s.check("this year's and a four-years-back row never come in",
        CATS[0] not in [x["status"] for x in past] and CATS[3] not in [x["status"] for x in past])
s.check("someone with no history: three years of no record", [x["status"] for x in none] == [None, None, None])

s.section("the tool: BU CEO and BG CEO only, their own scope only")
SAID = [x["said"] for x in past]
s.check("the BU CEO gets it, by id: only the ready lines, short enough for the loop (under 400 characters)",
        t_bu.get("ok") and t_bu["years"] == SAID and set(t_bu) == {"ok", "person", "years"}
        and len(__import__("json").dumps(t_bu)) < 400, len(__import__("json").dumps(t_bu)))
s.check("the BG CEO gets it, by name", t_bg.get("ok") and t_bg["years"] == SAID)
s.check("an HOD and a Group Chief don't (the tool doesn't exist for them)",
        t_hod == {"ok": False, "error": "unknown tool"} and t_gc == {"ok": False, "error": "unknown tool"})
s.check("someone outside their scope is refused", not t_out.get("ok"), t_out)
s.check("through the BU CEO's calibration dispatcher", r_calib.get("ok") and r_calib["years"] == SAID)
s.check("...not an HOD's", r_hod == {"ok": False, "error": "unknown tool"}, r_hod)
s.check("through the potential calibration's dispatcher (BG CEO)", r_pot.get("ok") and r_pot["years"] == SAID)
s.check("the Talent Box's dispatcher serves it, registered with its tools",
        'if tool == "past_talent":' in inspect.getsource(a._tb_run_tool) and "past_talent" in a._TB_TOOLS)

s.section("the agents are told: only when asked, never volunteered, never a reason for a move")
b = a._PAST_TALENT_BRIEF
s.check("the brief: only when they ask; never bring it up; never to suggest or justify a move; never in a reason",
        "only when asked" in b and "Never bring past years up yourself" in b
        and "never use them to suggest or justify a move" in b and "never put them in a reason you record" in b
        and "nor again later in the conversation unless they ask again" in b and "its line from `years`" in b
        and "EVERY time they ask, give each year's line in full, even if you gave it before" in b)
s.check("the leader loop gives past_talent's result the same room as open_person (it cut it at 400 before)",
        '_room = 900 if tool in ("open_person", "past_talent", "person_profile") else 400' in open(
            os.path.join(H.REPO, "app.py"), encoding="utf-8").read())
s.check("the BG CEO's Talent Box prompt names the tool and the rule; the Group Chief's doesn't",
        "_PAST_TALENT_BRIEF" in inspect.getsource(a._talent_box_system)
        and "past_talent{subject}" in inspect.getsource(a._talent_box_system)
        and "past_talent" not in inspect.getsource(a._tb_group_system))
s.check("the calibration prompts add it for the BU / BG CEO tiers only",
        "if tier in _PAST_TALENT_TIERS:" in inspect.getsource(a._pm_calib_assist_system)
        and "if tier in _PAST_TALENT_TIERS:" in inspect.getsource(a._pot_calib_system)
        and a._PAST_TALENT_TIERS == ("buceo", "bgceo"))

s.section("no page shows it (Chris: not on the Talent Box or the calibration profile)")
s.check("the Talent Box's open_person / explain_person and the calibration explain_person carry no past years",
        all("past_talent" not in inspect.getsource(f) and "talent_status_history" not in inspect.getsource(f)
            for f in (a._tb_tool_open_person, a._calib_tool_explain_person, a._pot_tool_explain_person)))
s.check("the person page and the box (the client) never draw it, under any past-talent name", "past_talent" not in JS
        and "pastTalent" not in JS)
# AMENDED 2026-10-29 (the Executive Chairman's Record tab): the allowed readers are named, and nothing else may join them
import re  # noqa: E402
APP_SRC = open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read()
_defs = [(m.start(), m.group(1)) for m in re.finditer(r"^def (\w+)\(", APP_SRC, re.M)]


def _caller_of(pos):
    return [n for st, n in _defs if st <= pos][-1]


_readers = {_caller_of(m.start()) for m in re.finditer(r"(?<![\w])_past_talent\(", APP_SRC)
            if not APP_SRC[max(0, m.start() - 4):m.start()].endswith("def ")} - {"_past_talent"}
s.check("the server's only readers of _past_talent are the BU / BG CEO agents' tool and the chair's Record route",
        _readers == {"_past_talent_tool", "chair_leaders_record"}, sorted(_readers))
# AMENDED 2026-10-29 (the Executive Chairman's AI insight, P3): his "three years running" / "first time" findings read the history
# through ONE function, and only his own compute calls it (which returns nothing for anyone else)
_th = {_caller_of(m.start()) for m in re.finditer(r"(?<![\w])talent_history_for\(", APP_SRC)
       if not APP_SRC[max(0, m.start() - 4):m.start()].endswith("def ")} - {"talent_history_for"}
s.check("talent_history_for's readers are the promotion pages' own and the chair insight's history reader, nothing new",
        _th == {"_chair_insight_history", "_promotion_nomination_page", "_talent_promotion_people", "promo_auto_reason",
                "promotion_nomination_save"}, sorted(_th))
_ih = {_caller_of(m.start()) for m in re.finditer(r"(?<![\w])_chair_insight_history\(", APP_SRC)
       if not APP_SRC[max(0, m.start() - 4):m.start()].endswith("def ")} - {"_chair_insight_history"}
s.check("the chair insight's history reader has ONE caller (his compute), which hands back nothing unless is_chair(u)",
        _ih == {"_chair_insight_compute"} and "if not is_chair(u):" in APP_SRC.split("def _chair_insight_compute(")[1][:1200], sorted(_ih))
s.check("the route that words his insight is a CHAIR_ENDPOINT and refuses anyone but him (tests/test_exec_chair_insight.py proves it)",
        "chair_insight_make" in a.CHAIR_ENDPOINTS
        and "_chair_require()" in APP_SRC.split("def chair_insight_make(")[1].split('"""')[2][:200])
s.check("the client asks for the Record in ONE place (the chair's Record tab), by the chair's own route",
        JS.count("/review/chair/leaders/record") == 1 and "function chairRecordFetch(" in JS
        and "function chairRecordSection(" in JS)
s.check("the Record route is the chair's alone: it starts with _chair_require and is a CHAIR_ENDPOINT",
        "_chair_require()" in APP_SRC.split("def chair_leaders_record(")[1].split('"""')[2][:200]
        and "chair_leaders_record" in a.CHAIR_ENDPOINTS)
s.check("the Talent Box person page and the insight carry no past years (the Record is its own route)",
        all("_past_talent" not in inspect.getsource(f) and "talent_status_history" not in inspect.getsource(f)
            for f in (a._tbox_person_frame, a._tb_insight_case, a.review_team_tbox_person)))
s.check("no template draws it", not any("past_talent" in open(os.path.join(TPL_DIR, f), encoding="utf-8").read()
                                         for f in os.listdir(TPL_DIR) if f.endswith(".html")))

# AMENDED 2026-10-30 (AI+ OneHR, the Executive Chairman's talent chat; Chris approved): ONE more reader of a person's past talent status,
# for him alone. _ec_history is the chat's only per-person reader of talent_status_history (HR's records, OneHR's released Year-Ends,
# this cycle's only once released to leaders): it hands back nothing unless is_chair(u), and only the chat's tools, his key-person rule and
# the person card call it. The dashboard's fallback (_chair_history_people) reads the same table for COUNTS by business group and the
# insight's names-free sets, and is chair-gated the same way. tests/test_ec_pa.py proves the rest (the 404s, the unreleased, the sentinels).
_eh = {_caller_of(m.start()) for m in re.finditer(r"(?<![\w])_ec_history\(", APP_SRC)
       if not APP_SRC[max(0, m.start() - 4):m.start()].endswith("def ")} - {"_ec_history"}
s.check("_ec_history's callers are the chat's tools, his key-person rule and the person card, nothing else",
        _eh == {"_ec_key_info", "_ec_tool_find_people", "_ec_tool_fit_for_role", "_ec_person_card", "_ec_tool_key_people"}, sorted(_eh))
s.check("_ec_history and the dashboard fallback's reader hand back nothing unless is_chair(u)",
        "if not is_chair(u):" in APP_SRC.split("def _ec_history(")[1][:1800]
        and "if not is_chair(u) or not year:" in APP_SRC.split("def _chair_history_people(")[1][:900])
_tr = {_caller_of(m.start()) for m in re.finditer(r"talent_status_history", APP_SRC)}
s.check("no new reader of the table appears outside the names above (the promotion pages, the calibration writers, the imports and the chair's)",
        {"_ec_history", "_chair_history_people", "_chair_talent_view"} >= {x for x in _tr if x.startswith(("_ec_", "_chair_history", "_chair_talent"))})
s.check("the talent chat's route is the chair's alone: it 404s unless ec_pa_on(u) (the Executive Chairman, with the flags on)",
        "if not ec_pa_on(u):" in APP_SRC.split("def ec_talent(")[1][:400] and "ec_talent" not in a.CHAIR_ENDPOINTS)

H.restore_db()
sys.exit(s.done())
