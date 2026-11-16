"""The phone view, piece A (Chris, "ok, looks good" / "Yes, build A", 2026-11-07; canvas boards A1 and A2; OneHR/Phone view A build brief
2026-11-07.md): under 1024px wide the staff shell, the check-in frame, the dashboard and Profile have their phone layout; 1024px and up is
the desktop, untouched.

What this suite holds (each check is proved once on a source with the piece taken out, so none can pass by accident):
  * ONE phone section at the end of static/style.css, inside @media (max-width: 1023.98px), and ONE script switch (window.onehrIsPhone,
    backed by the same query, in move_in.js, which every page loads in its <head>)
  * the markup the phone drawing needs is on the page: the short cycle pill, the back chevron and title on the check-in, the To do button
    with its count, the sheet's head, the left panel's counts, the Ask OneHR foot card and its scrim
  * the To do sheet's behaviour in the script: the four ways to close it, focus in and back, the count kept after every swap
  * the phone section draws what the brief says (56px bar, 44px To do, sheet above the bar, 85% height, 88% bubbles, Ask closed and never
    a side column) and uses tokens and rem only (the colour and unit lints also run it)
  * the tour: every stop either points at something drawn on a phone or is skipped, and the Ask stop has a phone target
  * what the agents know: the welcome, Help's hints, Ask OneHR's facts and OneHR Agent's prompt name both screens; Help has the phone
    question and the knowledge base has its row by slug
No real names: the suite database is the synthetic scratch copy.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Phone view, piece A: shell, check-in frame, dashboard, Profile")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BG, EMP = H.actors(a)

SRC = {n: H.source(a, n) for n in (
    "static/style.css", "static/move_in.js", "static/journey_chat.js", "static/ask_onehr.js", "static/onboarding.js",
    "templates/base.html", "templates/dashboard.html", "templates/review_journey.html", "templates/_journey_nav.html", "app.py")}
QUERY = "@media (max-width: 1023.98px) {"
MARK = "PHONE VIEW, PIECE A"


def phone_css(css):
    """Piece A's section: from its marker to the start of piece B's section (phone view, piece B, 2026-11-07, which follows it)."""
    i = css.rfind(MARK)
    if i < 0:
        return ""
    j = css.find("/* ===== PHONE VIEW, PIECE B", i)
    return css[i:j] if j >= 0 else css[i:]


def falsify(name, test, file, cut):
    """The check must fail once `cut` (a string, or a function of the text) is taken out of `file`."""
    src = dict(SRC)
    src[file] = cut(src[file]) if callable(cut) else src[file].replace(cut, "")
    s.check("falsified: %s fails without its piece" % name, not test(src), "" if not test(src) else "still passes with %r removed" % (cut if isinstance(cut, str) else "..."))


CHECKS = []


def check(name, test, file=None, cut=None):
    s.check(name, test(SRC))
    if file:
        falsify(name, test, file, cut)


# ---------------------------------------------------------------------------
s.section("one phone section, one script switch")
check("the phone section is the LAST block of style.css, inside @media (max-width: 1023.98px)",
      lambda S: S["static/style.css"].count(MARK) == 1 and QUERY in phone_css(S["static/style.css"])
      and S["static/style.css"].rstrip().endswith("}") and phone_css(S["static/style.css"]).count("\n@media") == 1,
      "static/style.css", lambda t: t.replace(QUERY, "@media (max-width: 1100px) {", 1))
check("...and it closes with the end of the file (nothing of the desktop follows it)",
      lambda S: S["static/style.css"].rstrip().split("\n")[-1] == "}" and S["static/style.css"].rfind(MARK) > len(S["static/style.css"]) - 160000,
      "static/style.css", lambda t: t + "\n.late { color: red; }\n" * 0 + "\n" + ("x" * 160001))
check("window.onehrIsPhone is defined once, from the same 1023.98px query, in move_in.js",
      lambda S: "window.onehrIsPhone = function" in S["static/move_in.js"] and 'matchMedia("(max-width: 1023.98px)")' in S["static/move_in.js"]
      and "onehrIsPhone = function" not in S["static/journey_chat.js"] + S["static/ask_onehr.js"] + S["static/onboarding.js"],
      "static/move_in.js", "window.onehrIsPhone = function")
check("move_in.js is loaded in every page's <head>, so the helper is there first",
      lambda S: "move_in.js" in S["templates/base.html"].split("</head>")[0],
      "templates/base.html", "move_in.js")
check("no script tests the window's width itself for the phone (they ask the helper)",
      lambda S: not re.search(r"innerWidth\s*[<>]=?\s*10\d\d|matchMedia\([\"']\(max-width: 10", S["static/journey_chat.js"] + S["static/ask_onehr.js"] + S["static/onboarding.js"]),
      "static/ask_onehr.js", lambda t: t + "\nvar w = window.innerWidth < 1024;\n")

# ---------------------------------------------------------------------------
s.section("the markup the phone drawing needs")
check("the top bar has a short cycle pill (full words in its title), and the account's name and role for the menu",
      lambda S: 'class="tb-cs" hidden title=' in S["templates/base.html"] and 'class="acct-me" hidden' in S["templates/base.html"],
      "templates/base.html", 'class="tb-cs" hidden title=')
check("the check-in's bar has a back chevron to the Dashboard and the view's name",
      lambda S: 'class="tb-back"' in S["templates/base.html"] and 'class="tb-ttl"' in S["templates/base.html"]
      and "'My check-in' if view == 'mine'" in S["templates/base.html"],
      "templates/base.html", 'class="tb-back"')
check("the staging demo control carries an icon for the phone",
      lambda S: 'class="tb-demo-ico"' in S["templates/base.html"],
      "templates/base.html", 'class="tb-demo-ico"')
check("the check-in has the To do button with its count, in the sub-bar's first row",
      lambda S: 'id="rv-nav-drawerbtn"' in S["templates/review_journey.html"] and 'id="rv-todo-n"' in S["templates/review_journey.html"]
      and S["templates/review_journey.html"].index('id="rv-nav-drawerbtn"') < S["templates/review_journey.html"].index('class="rv-topbar-main"'),
      "templates/review_journey.html", 'id="rv-todo-n"')
check("the sheet has its head (grab bar, parts done, a close button) inside the panel's column",
      lambda S: 'class="rv-sheet-head" hidden' in S["templates/review_journey.html"] and 'id="rv-sheet-x"' in S["templates/review_journey.html"]
      and 'class="rv-sheet-grab"' in S["templates/review_journey.html"],
      "templates/review_journey.html", 'id="rv-sheet-x"')
check("the left panel carries what the button and sheet read: items to do, parts done and in all",
      lambda S: all(k in S["templates/_journey_nav.html"] for k in ('data-todo-n="', 'data-parts-done="', 'data-parts-total="')),
      "templates/_journey_nav.html", 'data-parts-done="')
check("the dashboard has the Ask OneHR foot card (Any questions?) with its button, and the sheet's dim and x",
      lambda S: 'class="od-askfoot" hidden' in S["templates/dashboard.html"] and "Any questions?" in S["templates/dashboard.html"]
      and 'id="ask-foot-open"' in S["templates/dashboard.html"] and 'id="gp-scrim"' in S["templates/dashboard.html"]
      and 'class="gp-x"' in S["templates/dashboard.html"],
      "templates/dashboard.html", 'id="ask-foot-open"')
html = H.client_as(a, EMP["id"]).get("/dashboard").get_data(as_text=True)
s.check("as the dashboard renders for a person: the foot card and the short pill are on the page",
        'od-askfoot' in html and 'class="tb-cs"' in html and 'Any questions?' in html)

# ---------------------------------------------------------------------------
s.section("the To do sheet and the Ask sheet behave")
check("To do closes four ways: the x, the dim, Esc, and choosing an item; and the count is kept after every swap",
      lambda S: all(k in S["static/journey_chat.js"] for k in (
          'sheetX.addEventListener("click", closeDrawer)', 'navScrim.addEventListener("click", closeDrawer)',
          'if (e.key === "Escape") { e.preventDefault(); closeDrawer(); return; }', "closeSwitchMenus(); closeDrawer();\n      pickNavItem(",
          "todoSync();   // the To do button's count follows the panel")),
      "static/journey_chat.js", 'sheetX.addEventListener("click", closeDrawer)')
check("focus goes into the sheet on open and back to To do on close; Tab stays inside",
      lambda S: 'if (x) x.focus();' in S["static/journey_chat.js"] and "todoBtn.focus()" in S["static/journey_chat.js"]
      and 'e.key !== "Tab"' in S["static/journey_chat.js"],
      "static/journey_chat.js", "todoBtn.focus()")
check("Ask OneHR opens from the foot card and closes by the x, the dim, Esc or choosing a card; it never touches the saved fold on a phone",
      lambda S: all(k in S["static/ask_onehr.js"] for k in (
          'footBtn.addEventListener("click", function () { sheet(true); })', 'scrim.addEventListener("click", function () { sheet(false); })',
          'e.key === "Escape" && panel.classList.contains("is-sheet")', "if (phone()) sheet(false); else fold(true);")),
      "static/ask_onehr.js", "if (phone()) sheet(false); else fold(true);")

# ---------------------------------------------------------------------------
s.section("the phone section draws what the brief says")
P = lambda S: phone_css(S["static/style.css"])  # noqa: E731
check("the bar is 56px, the account is a 40px picture in a 44px tap, the cycle pill is the short one",
      lambda S: ".topbar.tb-a { height: 56px;" in P(S) and ".tb-a .tb-av { width: 40px; height: 40px;" in P(S)
      and "width: 44px; min-width: 44px; height: 44px" in P(S) and ".tb-a .tb-cs[hidden] { display: inline-flex;" in P(S),
      "static/style.css", ".topbar.tb-a { height: 56px;")
check("the To do button is 44px with a navy count pill; the sub-bar is sticky; the module chips never shrink",
      lambda S: "height: 44px; min-width: 44px" in P(S) and ".rv-todo-n { display: inline-flex;" in P(S) and "background: var(--accent)" in P(S)
      and ".rv-topbar { position: sticky;" in P(S) and "#rv-modtabs .rv-modtab { flex: none;" in P(S),
      "static/style.css", ".rv-topbar { position: sticky;")
check("the panel is a bottom sheet over the bar (z-index above 890), at most 85% of the height, with a dim, a grab bar and room for the home bar",
      lambda S: "max-height: 85dvh; z-index: 906;" in P(S) and ".rv-nav-scrim { position: fixed; inset: 0; z-index: 905;" in P(S)
      and "env(safe-area-inset-bottom)" in P(S) and ".rv-sheet-grab { position: absolute;" in P(S),
      "static/style.css", "max-height: 85dvh; z-index: 906;")
check("bubbles up to 88%, stage cards the full width, the reply box at the foot with the home bar's padding",
      lambda S: ".rv-msg { max-width: 88%;" in P(S) and ".rv-stage-card { max-width: 100%; width: 100%;" in P(S)
      and "padding: 8px 12px calc(8px + env(safe-area-inset-bottom))" in P(S),
      "static/style.css", ".rv-msg { max-width: 88%;")
check("Ask OneHR starts closed on a phone, is never a fixed side column, and its folded rail is not drawn",
      lambda S: ".gp:not(.ecp):not(.is-onboarding) { display: none; }" in P(S) and ".gp-rail { display: none; }" in P(S)
      and ".gp.is-sheet:not(.ecp) { display: flex; }" in P(S) and "max-width: none; margin: 12px auto; padding: 0 12px; }" in P(S),
      "static/style.css", ".gp:not(.ecp):not(.is-onboarding) { display: none; }")
check("the dashboard is one column in the brief's order: next step, the rail, the role card, plan, learning, tools, grows, history, Ask",
      lambda S: ".od-grid { display: contents; }" in P(S) and all(
          re.search(r"\.od > \.%s[^{]*\{[^}]*order: %d" % (c, n), P(S)) or re.search(r"\.od-grid > \.%s[^{]*\{[^}]*order: %d" % (c, n), P(S))
          for c, n in (("od-here", 1), ("od-rail", 2), ("od-plv", 4), ("od-tools", 6), ("od-grows", 7), ("od-hist", 8), ("od-askfoot", 9))),
      "static/style.css", ".od-grid { display: contents; }")
check("the cycle rail is a vertical list of 48px rows: the dot, the step, its short state on the right",
      lambda S: "min-height: 48px; padding: 6px 0; border-top" in P(S) and ".od-step > .od-sl { grid-column: 3;" in P(S),
      "static/style.css", ".od-step > .od-sl { grid-column: 3;")
check("the next-step button is full width, 48px, navy",
      lambda S: "justify-content: center; min-height: 48px" in P(S) and ".od-here .od-nb .od-btn-ai { background: var(--accent);" in P(S),
      "static/style.css", ".od-here .od-nb .od-btn-ai { background: var(--accent);")
check("the BU | Own switch spans the full width; the deadline strip wraps",
      lambda S: ".od-lt-tabs { display: flex; flex: 1 1 100%; width: 100%;" in P(S) and "white-space: normal; -webkit-mask-image: none;" in P(S),
      "static/style.css", ".od-lt-tabs { display: flex; flex: 1 1 100%; width: 100%;")
check("Profile's cards stack to one column",
      lambda S: ".pf-grid { grid-template-columns: minmax(0, 1fr); }" in P(S),
      "static/style.css", ".pf-grid { grid-template-columns: minmax(0, 1fr); }")
check("the section uses tokens and rem: no hex, rgb() or px font sizes",
      lambda S: not re.search(r"#[0-9a-fA-F]{3,6}\b|rgba?\(", P(S)) and not re.search(r"font-size:\s*[\d.]+px", P(S)),
      "static/style.css", lambda t: (lambda i: t[:i] + "\n@media (max-width: 1023.98px) { .x { color: #fff; } }\n" + t[i:])(t.find("/* ===== PHONE VIEW, PIECE B") if "/* ===== PHONE VIEW, PIECE B" in t else len(t)))

# ---------------------------------------------------------------------------
s.section("the tour points at something drawn on a phone")
check("the Ask stop has a phone target (the foot card) and every stop only counts nodes that are drawn",
      lambda S: 'phone: [".od-askfoot"]' in S["static/onboarding.js"] and "getClientRects().length > 0" in S["static/onboarding.js"]
      and "window.onehrIsPhone && window.onehrIsPhone() && s.phone" in S["static/onboarding.js"],
      "static/onboarding.js", 'phone: [".od-askfoot"]')
# every stop's selector must be one the dashboard can draw on a phone: none of the desktop-only (hidden) pieces
_tour = SRC["static/onboarding.js"]
_sels = set(re.findall(r'sel: \[([^\]]*)\]', _tour))
_hidden_on_phone = (".gp-rail", "#gp-rail", ".od-closes", ".brand-by", ".tb-who")
s.check("no stop targets a piece the phone hides", not any(h in sel for sel in _sels for h in _hidden_on_phone), _sels)
s.check("...and the phone section hides none of the other stops' targets (.topbar, #acct-trigger, .od-rail, .od-here ... stay drawn)",
        not re.search(r"\.od-(rail|here|stand|learn|tools|hist)\s*\{\s*display:\s*none", P(SRC)) and "#acct-trigger { display: none" not in P(SRC))

# ---------------------------------------------------------------------------
s.section("what the agents and Help know")
app_src = SRC["app.py"]
check("the welcome names the To do list on both screens (both versions of line 2)",
      lambda S: S["app.py"].count("the To do button on a phone") >= 2 and "the panel on the left, or the To do button on a phone" in S["app.py"],
      "app.py", lambda t: t.replace("(the panel on the left, or the To do button on a phone)", "(the panel on the left)"))
check("Help's three 'Not here?' hints name the phone's way to Ask OneHR",
      lambda S: S["app.py"].count("on a phone, the Ask OneHR button at the foot of the dashboard") == 3,
      "app.py", "on a phone, the Ask OneHR button at the foot of the dashboard")
check("Ask OneHR's facts carry one line on using AI+ OneHR on a phone",
      lambda S: 'lines.append("ON A PHONE: AI+ OneHR works on a phone' in S["app.py"],
      "app.py", 'lines.append("ON A PHONE: AI+ OneHR works on a phone')
check("OneHR Agent's prompt says the left panel is the To do button on a phone",
      lambda S: "on a phone the same list opens from the To do button under the top bar" in S["app.py"],
      "app.py", "on a phone the same list opens from the To do button under the top bar")
check("Help has the question 'Can I use AI+ OneHR on my phone?', in the OneHR list",
      lambda S: '"phone_use": ("Can I use AI+ OneHR on my phone?"' in S["app.py"] and '"phone_use", "text_size"' in S["app.py"],
      "app.py", '"phone_use": ("Can I use AI+ OneHR on my phone?"')
ans = a.HELP_QA.get("phone_use")
s.check("...and it is in HELP_QA at run time, answered (yes) without any model", bool(ans) and ans[1].startswith("Yes"), ans)
import sqlite3  # noqa: E402
_c = sqlite3.connect(a.DB_PATH)
_kb = _c.execute("SELECT title, body FROM kb_entries WHERE slug='phone-view'").fetchone()
_c.close()
s.check("the knowledge base has the 'phone-view' row (seeded by slug, conceptual words)", bool(_kb) and "To do button" in _kb[1] and "Any questions?" in _kb[1], _kb)
check("...seeded INSERT OR IGNORE by slug, so an admin's edit is never overwritten",
      lambda S: re.search(r'INSERT OR IGNORE INTO kb_entries[^"]*"[^)]*\("phone-view"', S["app.py"].replace("\n", " ")) is not None,
      "app.py", '("phone-view", "Using AI+ OneHR on a phone",')

sys.exit(s.done())
