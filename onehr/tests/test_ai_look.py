"""The AI look, Level 2 (Chris, 2026-10-08): "For all AI related functions like AI suggestion to fit curve, AI to help
write the remark (rename this from help write the remark), AI insight/summary button and AI action button, use our red
tone ... And the chat enter button also change to red tone" -- the canvas "OneHR AI Visual Language", Level 2 approved.

The rule: the brand red WITH the spark marks what the AI does; red without the spark is a problem. This suite holds the
pieces in place and the guardrails around them:

  * the AI tokens and the one spark icon
  * Send is solid AI red; every agent reply carries the red spark mark (cards don't)
  * "Write with AI" (was "Help me word it") with a red kicker over its menu
  * the AI insight buttons draw the spark (never the calibrator's own remark pen); the Team summary's column is
    "AI insight"; an AI read's source tag is "AI insight" in red, a read from their figures keeps its grey label
  * "Fit the curve with AI" (was "AI suggestion: fit the curve") everywhere: button, dialog, chip, lock note, the
    agent's opener and prompts
  * guardrails: the commit buttons stay navy, the error red is untouched, the AI never writes in red

Reads the source only. Shares the suite database (nothing is written).
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The AI look -- red with the spark marks what the AI does")
JS = open(os.path.join(H.REPO, "static", "journey_chat.js"), encoding="utf-8").read()
CSS = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
SRC = H.source(a)


def block(sel):
    """The declarations of the LAST rule whose selector list is exactly `sel`."""
    hits = re.findall(r"(?m)^" + re.escape(sel) + r"\s*\{([^}]*)\}", CSS)
    return hits[-1] if hits else ""


s.section("the tokens and the mark")
s.check("the AI tokens: red #D61923, ink #B5141D, tint #FDF0F1, line #F4C7CA (light values; dark keeps the red, lifts the ink)",
        (H.tok("ai"), H.tok("ai-ink"), H.tok("ai-tint"), H.tok("ai-line")) == ("#d61923", "#b5141d", "#fdf0f1", "#f4c7ca")
        and H.tok("ai", dark=True) == "#d61923")
s.check("one spark icon, filled (the curve fit's own shape)",
        "spark: '<svg class=\"rv-ico rv-ico-spark\" viewBox=\"0 0 24 24\" fill=\"currentColor\"" in JS
        and "M12 2.5l2.3 6.2 6.2 2.3-6.2 2.3L12 19.5l-2.3-6.2L3.5 11l6.2-2.3z" in JS)

s.section("the chat")
s.check("Send is solid AI red, darker on hover, with a red focus ring",
        "background: var(--ai);" in block(".rv-send") and "var(--ai-ink)" in block(".rv-send:hover")
        and H.tok("d-sh-d61923-a28") == "rgba(214, 25, 35, .28)" and "var(--d-sh-d61923-a28)" in block(".rv-send:focus-visible"))
s.check("every agent reply carries the red spark mark beside it -- never a card (a table, a sign-off) or a folded line",
        ".rv-msg-agent:not(.rv-card)::before" in CSS and "background: var(--ai) url(\"data:image/svg+xml" in CSS
        and "margin-left: 34px" in block(".rv-msg-agent:not(.rv-card)"))
s.check("...and the AI's own words stay ink, never red",
        "color" not in block(".rv-msg-agent:not(.rv-card)") and "color: var(--ink)" in block(".rv-msg-agent"))

s.section("Write with AI")
_rh = JS[JS.index("  function remarkHelpMenu("):JS.index("  function placeHelpMenu(")]
s.check("'Help me word it' is now 'Write with AI', with the spark, in AI red",
        'btn.appendChild(document.createTextNode("Write with AI"));' in _rh and "btn.innerHTML = ICON.spark;" in _rh
        and '"Help me word it"' not in JS and "color: var(--ai-ink)" in block(".rv-help-trigger"))
s.check("...its menu opens under a red 'AI+ writing help' kicker (not a menu item: arrows still move between the three)",
        'menu.appendChild(rmkEl("div", "rv-ai-kicker", "AI+ writing help"));' in _rh
        and 'menu.querySelectorAll(".rv-help-opt:not([disabled])")' in _rh)
s.check("...and the agent is told the new name", "'Write with AI' drafts the remark with you" in SRC
        and "'Help me word it'" not in SRC)

s.section("the AI insight")
_rb = JS[JS.index("  function rmkButton("):JS.index("  function rmkContent(")]
s.check("the AI insight button draws the spark in AI red (the Team summary, the calibration rosters, the Talent Box)",
        "b.innerHTML = ICON.spark +" in _rb and "color: var(--ai)" in block(".rv-rmk-btn")
        and "border-color: var(--ai-line)" in block(".rv-rmk-btn"))
_crb = JS[JS.index("  function calRemarkBtn("):JS.index("\n  }\n", JS.index("  function calRemarkBtn("))]
s.check("...never the calibrator's own remark button: that stays the pen", "ICON.pen" in _crb and "ICON.spark" not in _crb)
s.check("the Team summary's column is 'AI insight', with the spark",
        "<th class='rv-rmk-th'>\" + ICON.spark + \"AI insight</th>" in JS and "<th class='rv-rmk-th'>Remark</th>" not in JS)
_st = JS[JS.index("  function aiSrcTag("):JS.index("\n  }\n", JS.index("  function aiSrcTag("))]
s.check("an AI read's source tag is 'AI insight' with the spark in red; a read from their figures keeps its grey label",
        '"rv-cal-src" + (isAi ? " rv-ai-src" : "")' in _st and 'createTextNode("AI insight")' in _st
        and "else t.textContent = plain;" in _st and "color: var(--ai-ink)" in block(".rv-cal-src.rv-ai-src"))
s.check("...on every AI read: the line manager's, the calibration card's and the Talent Box's",
        JS.count("aiSrcTag(e.source === \"ai\"") == 3 and '"AI read"' not in JS)
s.check("the Talent Box pop-out's AI kicker is red; 'Insight from their figures' stays grey",
        'e.source === "ai" ? rmkEl("div", "rv-ai-kicker", "AI insight")' in JS
        and 'rmkEl("div", "rv-ps-kicker", "Insight from their figures")' in JS)

s.section("Fit the curve with AI")
s.check("'AI suggestion: fit the curve' is 'Fit the curve with AI' everywhere: button, dialog, chip, the lock's note",
        "AI suggestion: fit the curve" not in JS and 'fit.appendChild(document.createTextNode("Fit the curve with AI"));' in JS
        and 'h.textContent = "Fit the curve with AI";' in JS and 'label: "Fit the curve with AI", fn: calFitSuggest' in JS
        and "Fit the curve with AI can do it for you." in JS)
s.check("...a red outline with the spark, and a red 'AI suggestion' kicker over its dialog",
        'fit.className = "rv-cal-fitbtn rv-ai-action";' in JS and "fit.innerHTML = ICON.spark;" in JS
        and 'card.appendChild(rmkEl("div", "rv-ai-kicker", "AI suggestion"));' in JS
        and "border: 1px solid var(--ai-line)" in CSS)
s.check("...and the agent's curve opener and prompts say it the same way",
        "(or use Fit the curve" in SRC and SRC.count("(or use 'Fit the curve with AI')") == 2)
s.check("...no 'use the AI suggestion' left for the model to repeat", "use the AI suggestion" not in SRC)

s.section("guardrails")
s.check("the committing buttons stay navy: Save & submit, the curve's Lock, the fit dialog's Apply are no AI action",
        'go.className = "rv-confirm-yes rv-ai-action"' in JS   # only the legacy STAR guide (it asks the AI to draft)
        and "rv-cal-lock rv-ai-action" not in JS and "rv-fit-apply rv-ai-action" not in JS
        and "rv-mod-lockall rv-ai-action" not in JS)
s.check("the AI red never replaces the danger red: --rl-danger is untouched and the 'still to answer' marks keep it",
        H.tok("rl-danger") == "#c0392b" and H.tok("danger-ink") == "#c0392b" and any(H.tok(k) == "#d64545" for k in H.css_tokens() if k.startswith("d-")))
s.check("the legacy STAR guide buttons (they ask the AI to draft) are AI actions with the spark",
        JS.count('go.className = "rv-confirm-yes rv-ai-action";') == 2
        and JS.count('go.innerHTML = ICON.spark; go.appendChild(document.createTextNode(d.button || "Help me draft it with STAR"));') == 2)

sys.exit(s.done())
