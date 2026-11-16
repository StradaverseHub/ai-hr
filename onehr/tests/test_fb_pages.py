"""The 360 card, two leadership principles a page, a card each (Chris, 2026-10-22, canvas 4JisH5pVXWexaciDHRLPz3,
option A: "doing 2 leadership principle in two cards, and we don't need to bold the descriptor"). Client-only, so these
read static/journey_chat.js and style.css, and run the page arithmetic in node. Browser QC of 2026-10-22 drove the card
(the cards, the header's progress, the page turn, the last page's remark)."""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The 360 card: two principles a page, a card each, behaviours not bold")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
JS = open(os.path.join(ROOT, "static", "journey_chat.js"), encoding="utf-8").read()
CSS = open(os.path.join(ROOT, "static", "style.css"), encoding="utf-8").read()


def fn(name):
    i = JS.find("function %s(" % name)
    return JS[i:JS.find("\n  }\n", i)] if i >= 0 else ""


s.section("the page arithmetic")
src = "var FB_PER_PAGE = 2;\n" + fn("fbPageCount") + "\n  }\n" + fn("fbPageOf") + "\n  }\n"
out = subprocess.run(["node", "-e", src + "console.log(JSON.stringify([fbPageCount(new Array(7)), fbPageCount(new Array(8)),"
                      " fbPageCount([]), fbPageOf(0), fbPageOf(1), fbPageOf(2), fbPageOf(6)]))"],
                     capture_output=True, text=True)
s.check("seven principles are four pages; eight are four; none is none; principle 1-2 on page 1, 3 on page 2, 7 on page 4",
        out.returncode == 0 and out.stdout.strip() == "[4,4,0,0,0,1,3]", (out.stdout, out.stderr[:200]))
s.check("two a page", "var FB_PER_PAGE = 2;" in JS)

s.section("the card")
w = fn("fbWidget")
s.check("fb.section is the page: clamped to the page count, the page's principles sliced, the strips page it",
        "var nPages = fbPageCount(principles);" in w and "var onPageP = principles.slice(p0, p0 + FB_PER_PAGE);" in w
        and "return bezelWrap(box, fb.section, nPages," in w)
s.check("a white card per principle: its short name and 'N of 7' over its phrase",
        'rmkEl("section", "rv-fb-pcard")' in w and '"rv-fb-pkick"' in w and "(p0 + k + 1) + \" of \" + principles.length" in w
        and 'rmkEl("div", "rv-fb-ptitle", pp.description || pp.name || "")' in w)
s.check("the behaviour is NOT bold (Chris): its own class, regular weight; the old bold class is gone from the card",
        't.className = "rv-fb-stmt"' in w and '"rv-fb-text"' not in w
        and ".rv-fb-stmt { font-size: 0.88rem; line-height: 1.45; font-weight: 400;" in CSS)
s.check("who you're rating, their progress for this colleague and the page, once on the header",
        '"rv-fb-prog"' in w and '" of " + allSts.length' in w and '" · page " + (fb.section + 1) + " of " + nPages' in w
        and ".rv-fb-prog { margin-left: auto;" in CSS)
s.check("the page turns once both principles are rated (a page blank on arrival), naming them; 'are done' for two",
        "turnArrive(fb, fb.subject + \":\" + fb.section, !pageSts(fb.section).some(fbAnswered));" in w
        and "var fbFull = function (pg) { return pageSts(pg).every(fbAnswered); };" in w
        and "fromName: pgNames(from), toName: pgNames(from + 1)," in w
        and '(note.plural ? " are" : " is")' in fn("turnNoteEl"))
s.check("the red 'still to answer' count counts this page's principles", "if (fbPageOf(pi) === fb.section) onPage++;" in w)
s.check("the remark and Save sit on the LAST page (the seventh principle's)",
        "var lastPage = principles.length > 0 && fb.section === nPages - 1;" in w and "if (!submitted && lastPage) {" in w)
s.check("rows inside a card: a hairline, no card of their own; a still-unanswered one keeps its red bar",
        ".rv-tc-grp .rv-fb-pcard > .rv-fb-row.rv-tc-row { background: transparent; border: 0; border-top:" in CSS
        and H.cv(".rv-tc-grp .rv-fb-pcard > .rv-fb-row.rv-fb-row-todo { padding-left: 10px; box-shadow: inset 3px 0 0 #d64545; }")
        in CSS)

s.section("every other reader of the page")
s.check("following the conversation lands on the page holding the principle the agent is on",
        "if (key !== fb.key) fb.section = fbPageOf(idx);" in fn("feedbackFollow")
        and "fbPageCount(principles) - 1" in fn("feedbackFollow"))
s.check("the remark's way in and 'Yes, save it' open the last PAGE; a Go to opens its behaviour's page",
        "var np = fbPageCount(fb.data.principles);" in fn("focusCardRemark")
        and "var np = fbPageCount(fb.data.principles);" in fn("remarkPageChange")
        and "fb.section = fbPageOf(pi);" in JS)
s.check("nothing pages the 360 card by principle any more",
        "(fb.data.principles || []).length;" not in JS and "principles[fb.section]" not in JS)

s.section("the remark's rule follows the ticks on the card (Chris, 2026-10-22)")
rr = fn("fbRemarkRule")
NODE = "var fb = {pending: {}};\n" + rr + "\n  }\n"


def rule(data, pending=None):
    src = NODE + "fb.pending = %s;\nconsole.log(JSON.stringify(fbRemarkRule(%s)));" % (
        __import__("json").dumps(pending or {}), __import__("json").dumps(data))
    o = subprocess.run(["node", "-e", src], capture_output=True, text=True)
    return __import__("json").loads(o.stdout) if o.returncode == 0 else {"err": o.stderr[:200]}


R = {"high_above": 12.5, "w_current": 1.0, "w_future": 1.5}
P = [{"statements": [{"statement_id": i * 2 + 1, "is_future": False, "answer": None},
                     {"statement_id": i * 2 + 2, "is_future": True, "answer": None}]} for i in range(7)]
base = {"principles": P, "focus_remark_rule": R, "focus_remark_required": False, "focus_remark_reason": None}
yes = {i: "yes" for i in range(1, 15)}
no = {i: "no" for i in range(1, 15)}
s.check("every behaviour ticked Demonstrate (not saved yet) -> required, 'high'", rule(base, yes) == {"required": True,
        "reason": "high"}, rule(base, yes))
s.check("every behaviour ticked Developing -> required, 'all_developing'", rule(base, no) == {"required": True,
        "reason": "all_developing"}, rule(base, no))
mostly = dict(yes); mostly[1] = "no"; mostly[3] = "no"          # 17.5 - 2 = 15.5 > 12.5: mostly Demonstrate
s.check("mostly Demonstrate (above the High cut-off) -> required, 'high'", rule(base, mostly)["reason"] == "high",
        rule(base, mostly))
mid = {i: ("yes" if i <= 8 else "no") for i in range(1, 15)}     # 4 x 2.5 = 10 <= 12.5
s.check("a middling mix -> optional", rule(base, mid) == {"required": False, "reason": None}, rule(base, mid))
part = {i: "yes" for i in range(1, 14)}                          # one behaviour still blank
s.check("not every behaviour answered -> the server's reading of the saved answers stands",
        rule(dict(base, focus_remark_required=False), part) == {"required": False, "reason": None}
        and rule(dict(base, focus_remark_required=True, focus_remark_reason="high"), part)["reason"] == "high")
s.check("the card's remark box takes the live rule, with Chris's words for each case",
        "var rr = fbRemarkRule(data), reason = rr.reason;" in fn("fbWidget") and "required: rr.required," in fn("fbWidget")
        and "as mostly demonstrating our leadership principles. Would you mind" in fn("fbWidget")
        and "explaining why, with specific examples?" in fn("fbWidget")
        and "as developing on all our leadership principles. Would you mind giving" in fn("fbWidget")
        and "feedback so they can improve?" in fn("fbWidget"))
with a.app.test_request_context("/"):
    db = a.get_db()
    cid = a.active_cycle_id(db)
    low, mid_ = a.thresholds_for_cycle(db, cid)
    s.check("the server hands the card _fb_step's own rule: the cycle's High cut-off and the points per Demonstrate",
            a._fb_remark_rule(db, cid) == {"high_above": mid_, "w_current": a.SCORE_CURRENT, "w_future": a.SCORE_FUTURE,
                                           "w_dev_current": 0.0, "w_dev_future": 0.0})   # the engine default (Points per answer)
    # parity on real saved answers: the card's rule on an assignment's saved answers = _fb_step's reason
    import sqlite3 as _sq
    rows = db.execute("SELECT a.id, a.assessor_id FROM assignments a WHERE a.cycle_id=? AND a.archived=0 AND "
                      "a.status!='submitted' AND NOT EXISTS (SELECT 1 FROM responses r WHERE r.assignment_id=a.id AND "
                      "r.answer IS NULL) AND EXISTS (SELECT 1 FROM responses r WHERE r.assignment_id=a.id) LIMIT 40",
                      (cid,)).fetchall()
    checked = bad = 0
    for r in rows:
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (r["assessor_id"],)).fetchone())
        ov = (a._feedback_overview(db, u, r["id"]) or {}).get("data") or {}
        if ov.get("focus_assignment_id") != r["id"]:
            continue
        server = a._fb_step(db, u, cid, r["id"]).get("remark_reason")
        client = rule({"principles": ov["principles"], "focus_remark_rule": ov["focus_remark_rule"],
                       "focus_remark_required": False, "focus_remark_reason": None}).get("reason")
        checked += 1
        bad += server != client
    s.check("on real fully answered panels the card's rule gives _fb_step's reason every time", checked > 0 and bad == 0,
            (checked, bad))

sys.exit(s.done())
