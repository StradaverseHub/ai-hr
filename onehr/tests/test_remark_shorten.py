"""Over the limit, the agent offers to shorten the remark (Chris, 2026-10-21: "if it hits limit, the agent should offer
to help shorten and make it more concise").

Two ways a remark meets the limit (_REVIEW_REMARK_MAX_WORDS):
  * typed or pasted into a remark box: every box with Write with AI shows "Shorten it with AI" while it is over; a
    click pre-fills the chat with a tighten request the server reads as a remark help request carrying the remark;
  * given to the agent to save: its tool refuses and tells it to offer the shorter version (never trims).
"""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Over the limit, the agent offers to shorten the remark")
assert "onehr-tests" in a.DB_PATH, a.DB_PATH
JS = open(os.path.join(H.REPO, "static", "journey_chat.js"), encoding="utf-8").read()
CSS = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
MX = a._REVIEW_REMARK_MAX_WORDS


def body(name, n=1600):
    i = JS.find("function %s(" % name)
    return JS[i:i + n] if i >= 0 else ""


s.section("every remark box with Write with AI offers it")
s.check("one helper builds the offer", "function remarkShortenOffer(box, help, mx)" in JS
        and "function remarkShortenPrompt(help, text, n, mx)" in JS)
s.check("the KPI check-in box", "remarkShortenOffer(box, { noun: \"my overall remark\" }, kpiRm.maxWords)" in body("kpiRmState"))
s.check("the 360 / competency / department review card box, only where the chat can save it",
        "if (!o.noHelp) remarkShortenOffer(box, { noun: o.helpNoun, ownWords: !!o.ownWords }" in body("cardRmPaint"))
s.check("the line manager's KPI remark", "remarkShortenOffer(box, { noun: \"my overall remark for \"" in body("pmRemarkState"))
s.check("the line manager's competency review remark", "remarkShortenOffer(box, { noun: \"my remark on \"" in body("tmRemarkState"))
_calls = JS.count("remarkShortenOffer(box,") - JS.count("function remarkShortenOffer(box,")
s.check("...four boxes in all (the four remarkHelpMenu builders)", _calls == 4 and JS.count("remarkHelpMenu({") == 4,
        _calls)
off = body("remarkShortenOffer")
s.check("it shows only over the limit, and hands the request to the chat (never saves, never trims)",
        "b.hidden = !(n > lim)" in off and "promptComposer(remarkShortenPrompt(" in off and "Save" not in off
        and "slice(" not in off and "substring(" not in off)
s.check("it is an AI control: the red spark link", "b.innerHTML = ICON.spark" in off and "rv-remark-link" in off)
s.check("its hidden state wins over its display", ".rv-myrm-shorten[hidden] { display: none; }" in CSS)

s.section("the server reads the box's request as a remark help request, with the whole remark")
REMARK = ("I led the Q3 price review for our two biggest accounts and kept margin above target while holding volume; "
          * (MX // 19 + 2)).strip()   # 19 words a sentence: always over the ceiling, whatever it is
n = len(REMARK.split())
s.check("the sample remark is over the limit", n > MX, n)
HELP_WORDS = re.search(r'var HELP_WORDS = "([^"]+)"', JS).group(1)
PROMPT_FN = body("remarkShortenPrompt", 700).split("\n  function remarkShortenOffer")[0]
for noun, own in (("my overall remark", "false"), ("my remark on Demo Report's competency review", "false"),
                  ("my overall competency remark", "true")):
    code = ("var HELP_WORDS = %s;\n%s\nprocess.stdout.write(remarkShortenPrompt({noun: %s, ownWords: %s}, %s, %d, %d));"
            % (json.dumps(HELP_WORDS), PROMPT_FN, json.dumps(noun), own, json.dumps(REMARK), n, MX))
    out = subprocess.run(["node", "-e", code], capture_output=True, text=True)
    prompt = out.stdout
    s.check("node built the prompt for %r" % noun, out.returncode == 0 and prompt.startswith("Help me tighten"),
            out.stderr[:200])
    hi = a._remark_help_intent(prompt)
    s.check("...read as a refine request (the agent drafts, nothing saved until they agree)",
            hi and hi["kind"] == "refine", hi and hi["kind"])
    s.check("...carrying the whole remark as the text", hi and hi["text"] == REMARK, hi and hi["text"][:60])
    s.check("...and the count and the limit", ("it's %d words, over the %d-word limit" % (n, MX)) in prompt)
    # Chris, 2026-10-22: "as long as it is under 300 is fine" -- under the limit, never squeezed to 50-100
    s.check("...asking for under the limit, trimming only what's needed (never 50-100)",
            ("under %d words, trimming only what's needed" % MX) in prompt and "50–100" not in prompt, prompt[:220])

s.section("given to the agent over the limit, its tool offers the shorter version")
s.check("one wording, offering to shorten and asking before saving: under the limit, every achievement kept, never "
        "'about 100 words'",
        "offer to shorten it for them" in a._REMARK_SHORTEN_OFFER and "once they agree" in a._REMARK_SHORTEN_OFFER
        and "under the limit" in a._REMARK_SHORTEN_OFFER and "every achievement" in a._REMARK_SHORTEN_OFFER
        and "100" not in a._REMARK_SHORTEN_OFFER)

s.section("the agent's steer: a remark over the limit is shortened to under it, whole, never to 50-100")
_ask = "Help me tighten my overall remark: it's %d words, over the %d-word limit" % (n, MX)
_over = a._remark_help_steer("account", {"kind": "refine", "text": REMARK, "ask": _ask, "want": ""}, "", [])
s.check("over the limit: UNDER the limit, trimming only what's needed, every achievement kept; no 50-100 cap",
        ("UNDER %d words (it is %d)" % (MX, n)) in _over and "never drop an achievement" in _over
        and "never over 100" not in _over and "50-100" not in _over, _over[:300])
s.check("...and the model gets the remark whole, not its first 1,500 characters (a 300-word remark is about 2,000)",
        len(REMARK) > 1500 and a.json.dumps(REMARK, ensure_ascii=False) in _over, len(REMARK))
_short = "I led the price review and kept margin above target while holding volume across both accounts this year."
_ref = a._remark_help_steer("account", {"kind": "refine", "text": _short, "ask": "Help me refine my remark", "want": ""},
                            "", [])
s.check("...while an ordinary refine keeps its 50-100 words", "never over 100" in _ref and "UNDER" not in _ref, _ref[:200])
msg = a._remark_message_error(REMARK)
s.check("the employee's remark guard (_remark_message_error) offers it", msg and "offer to shorten it" in msg, msg)
with a.app.app_context():
    db = a.get_db()
    period = a.active_pm_period(db)
    mgr = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND UPPER(TRIM(COALESCE(job_grade,'')))!='H' LIMIT 1").fetchone())
    subj = db.execute("SELECT id FROM users WHERE id!=? AND role!='admin' AND UPPER(TRIM(COALESCE(job_grade,'')))!='H' LIMIT 1", (mgr["id"],)).fetchone()["id"]
    realm = a._pm_team_mine
    a._pm_team_mine = lambda u, ts: [{"locked": False}]
    try:
        out = a._mgr_tool_set_report_remark(db, mgr, None, subj, {"remark": REMARK}) if period else None
    finally:
        a._pm_team_mine = realm
s.check("the line manager's KPI remark tool offers it",
        out is not None and out.get("ok") is False and "offer to shorten it" in out.get("error", ""), out)
src = H.source(a)
tm = src[src.find("def _mgr_tool_set_competency_remark("):][:900]
s.check("the line manager's competency remark tool offers it on too_long",
        'if err["reason"] == "too_long"' in tm and "_REMARK_SHORTEN_OFFER" in tm)

sys.exit(s.done())
