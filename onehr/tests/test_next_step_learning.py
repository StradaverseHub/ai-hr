"""A Learning step in Your next step -- 2026-10-23, Chris (a staging screenshot of the card):

  "can we fix this card too, the rate it button can be placed to the right, and the learning tag looks off and not
   aligned, and it can shared the same row with the date. the date should have year too."

What it holds:
  * a Learning lead (e.g. Rate it) has its button on the right of its words; any other lead keeps its button below;
  * a Learning step's tag sits at the start of its date's line, never after the title;
  * the step's dates carry the year (9 Nov 2026; a course's days once: 9 - 11 Nov 2026, 30 Nov - 2 Dec 2026).
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A Learning step in Your next step: its button on the right, the tag on the date's line, dates with the year")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
TPL = open(os.path.join(ROOT, "templates", "dashboard.html"), encoding="utf-8").read()
CSS = open(os.path.join(ROOT, "static", "style.css"), encoding="utf-8").read()
APP = open(os.path.join(ROOT, "app.py"), encoding="utf-8").read()

# --------------------------------------------------------------------------- the dates
s.section("the dates carry the year")
s.check("a day: 9 Nov 2026", a._lms_day_year("2026-11-09") == "9 Nov 2026", a._lms_day_year("2026-11-09"))
cases = {("2026-11-09", "2026-11-09"): "9 Nov 2026", ("2026-11-09", None): "9 Nov 2026",
         ("2026-11-09", "2026-11-11"): "9 - 11 Nov 2026", ("2026-11-30", "2026-12-02"): "30 Nov - 2 Dec 2026",
         ("2026-12-30", "2027-01-02"): "30 Dec 2026 - 2 Jan 2027"}
got = {k: a._lms_days_year(*k) for k in cases}
s.check("a course's days, the year once: one day, a span in a month, across months, across years", got == cases, got)
s.check("an unreadable date says nothing rather than a wrong one", a._lms_day_year("soon") == "" and a._lms_day_year(None) == "")
_dl = APP[APP.find("def dash_learning("):APP.find("\ndef ", APP.find("def dash_learning(") + 10)]
s.check("Your next step's Learning steps use them (rate, absence, nominations, confirmed), never the year-less date",
        _dl.count("_lms_day_year(") >= 3 and "_lms_days_year(r[\"starts\"], r[\"ends\"])" in _dl
        and "You came on %s · four questions, a minute\"\n                     % _lms_day_year(" in _dl)


# --------------------------------------------------------------------------- the card, rendered from its own macros
def macro(name):
    m = re.search(r"\{%-? macro " + re.escape(name) + r"\(.*?\{%-? endmacro -?%\}", TPL, re.S)
    return m.group(0) if m else ""


src = "\n".join(macro(n) for n in ("spark", "calm_btn", "learn_line", "next_card")) + "\n{{ next_card(R) }}"
LEAD = {"title": "Rate A Programme", "sub": "You came on 16 Oct 2026 · four questions, a minute", "button": "Rate it",
        "url": "/learning#rate-1", "own": True, "solid": True, "kind": "learning", "tag": "Learning", "due": "",
        "aria": None, "ai": False}
ROW = {"title": "Another Programme is confirmed", "sub": "9 Nov 2026", "button": "Add to calendar",
       "url": "/learning/ics/1", "download": True, "kind": "learning", "tag": "Learning", "due": "", "aria": None,
       "ai": False}
CYCLE = {"title": "Your Career Plan", "sub": "Your goals", "button": "Continue", "url": "/review/journey",
         "solid": True, "due": "", "aria": None, "ai": True}
with a.app.test_request_context("/dashboard"):
    t = a.app.jinja_env.from_string(src)
    h1 = t.render(R={"next": LEAD, "rest": [ROW]})
    h2 = t.render(R={"next": CYCLE, "rest": [ROW]})

s.section("the card")
s.check("a Learning lead: its words and its button side by side, the button after the words",
        re.search(r'<div class="od-nside"><div class="od-nside-t"><h2[^>]*>Rate A Programme</h2>.*?</div>\s*'
                  r'<div class="od-nb"><a class="od-btn-nv"[^>]*>Rate it</a></div></div>', h1, re.S) is not None, h1[:600])
s.check("...the tag at the start of its date's line, not after the title",
        '<p class="od-ns od-tagline"><span class="od-new">Learning</span><span class="od-tagtx" '
        'title="You came on 16 Oct 2026 · four questions, a minute">' in h1
        and not re.search(r"Rate A Programme\s*<span class=\"od-new\"", h1))
s.check("a Learning row: the title alone, the tag beside its date",
        '<p class="od-att">Another Programme is confirmed</p><p class="od-ats od-tagline"><span class="od-new">Learning'
        '</span><span class="od-tagtx" title="9 Nov 2026">9 Nov 2026</span></p>' in h1)
s.check("any other lead keeps its button below its words", "od-nside" not in h2.split('<ul')[0]
        and re.search(r'<h2[^>]*>Your Career Plan</h2>\s*<p class="od-ns">Your goals</p>\s*<div class="od-nb">', h2) is not None)
_run = TPL[TPL.find("{% set N = here['calm']['next'] %}"):TPL.find("{% if here['waits'] or here['done'] %}")]
s.check("the cycle's own card does the same: its Learning lead side by side, its Learning rows through the tag line",
        "{% if N and N.get('kind') == 'learning' %}" in _run and '<div class="od-nside">' in _run
        and "{% if x.get('kind') == 'learning' %}{{ learn_line(x, 'od-ats') }}" in _run
        and "{% if x.get('kind') == 'learning' %} <span class=\"od-new\">" not in _run)
s.check("the CSS: the lead's row centred, the tag line one line, the tag centred on it",
        ".od-nside { display: flex; align-items: center; gap: 16px; }" in CSS
        and ".od-tagline { display: flex; align-items: center; gap: 8px; min-width: 0; }" in CSS
        and ".od-tagtx { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }" in CSS)

sys.exit(s.done())
