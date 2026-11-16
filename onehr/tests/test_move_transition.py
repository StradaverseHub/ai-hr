"""Dashboard -> module: the OneHR agent hands you over (Chris, 2026-10-16: "go with A, build it and deploy to both"; the
canvas "OneHR Moving To Transition", board A).

What this suite holds:
  * every page carries move_in.js in its <head> (before the first paint), so an arrival fades in from the same veil
  * the dashboard carries move.js, and its next-step buttons tell the hand-over what's first (data-move-sub)
  * move.js takes over only a plain left click on a same-site link into a module (the AI+ journey, KPI setting, KPI
    approval), never a modified click, a new tab, a download, or a link something else already handled; it says where
    in words (the journey by its view, the Mine view by its part), sets every word as text, and never leaves the veil
    up (Back from the module, a load that never comes)
  * every link the dashboard renders, for every demo persona and a sample of managers, is either a module link
    move.js understands or one of the known non-module links -- so a new module link can't slip past the hand-over
  * the look: under the top bar (which stays), the agent's red tile, and nothing moving for anyone asking for less motion

Pages render from the suite database; only paths are compared, never a name.
"""
import os
import re
import sys
from urllib.parse import urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Dashboard -> module: the agent hands you over")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BG, EMP = H.actors(a)

js = H.source(a, "static/move.js")
jin = H.source(a, "static/move_in.js")
css = H.source(a, "static/style.css")
base = H.source(a, "templates/base.html")
dash = H.source(a, "templates/dashboard.html")

# ---------------------------------------------------------------------------
s.section("where the scripts load")
head = base.split("</head>")[0]
s.check("every page loads move_in.js in its <head>, before the first paint (not deferred)",
        len(re.findall(r"<script\b[^>]*move_in\.js[^>]*>", head)) == 1
        and not re.search(r"\b(defer|async|type=\"module\")", re.search(r"<script\b[^>]*move_in\.js[^>]*>", head).group(0)))
html = H.client_as(a, EMP["id"]).get("/dashboard").get_data(as_text=True)
s.check("...as the dashboard renders it", "/static/move_in.js" in html.split("</head>")[0])
s.check("the dashboard loads move.js", "/static/move.js" in html and "filename='move.js'" in dash)
s.check("its next-step buttons say what's first: data-move-sub is the step's title, on both kinds of button",
        dash.count('data-move-sub="{{ x[\'title\'] }}"') == 2)
s.check("an Ask OneHR card that goes to a page says what's first too",
        'b.setAttribute("data-move-sub", c.title)' in H.source(a, "static/ask_onehr.js"))

# ---------------------------------------------------------------------------
s.section("what it takes over, and what it never does")
s.check("only a plain left click: not a modified click, not another button, not one something else handled",
        "if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;" in js)
s.check("...not a link to a new tab, a download, or one marked data-no-move",
        '(a.target && a.target !== "_self") || a.hasAttribute("download") || a.hasAttribute("data-no-move")' in js)
s.check("...only on this site", "if (u.origin !== window.location.origin) return null;" in js)
s.check("...only into a module: the journey page (not a chat's own calls), KPI setting and KPI approval",
        'if (u.pathname.indexOf("/review/") === 0 && u.pathname !== "/review/journey") return null;' in js
        and '"/review/setting": [' in js and '"/performance/setting/review": [' in js)
_views = re.findall(r"^\s{4}(\w+): \[\"Moving to", js, re.M)
s.check("it says where for each leader view: team, dept, bu, bg, group", _views == ["team", "dept", "bu", "bg", "group"],
        _views)
s.check("every word is set as text (no innerHTML)", "innerHTML" not in js and "textContent = text" in js)
s.check("it goes after a short beat, and a load that never comes never leaves the veil up",
        re.search(r"var HOLD = (\d+);", js) and 300 <= int(re.search(r"var HOLD = (\d+);", js).group(1)) <= 900
        and "setTimeout(hide, 15000)" in js)
s.check("Back from the module: a page restored from the back-forward cache comes back without the veil",
        'window.addEventListener("pageshow", function (e) { if (e.persisted) hide(); });' in js)
s.check("the arrival mark: set in a try (storage can be blocked), read once and cleared, ignored after six seconds",
        'try { sessionStorage.setItem("onehr-move", String(Date.now())); }' in js
        and 'window.sessionStorage.removeItem("onehr-move");' in jin and "Date.now() - t < 6000" in jin
        and "catch (e)" in jin)

# ---------------------------------------------------------------------------
s.section("every link on the dashboard is a module link it understands, or a known other link")
PAGES = set(re.findall(r'^\s{4}"(/[^"]+)": \[', js, re.M))
OTHER = {"/", "/settings", "/profile", "/account/password", "/logout", "/dashboard", "/login", "/my-report"}


def kind(href):
    u = urlsplit(href.replace("&amp;", "&"))
    if u.scheme or u.netloc or href.startswith("#") or href.startswith("mailto:"):
        return "other"
    if u.path in PAGES or u.path in ("/review", "/review/journey"):
        return "module"
    if u.path in OTHER or u.path.startswith("/static/") or u.path.startswith("/learning/ics/"):   # a calendar file
        return "other"
    return "unknown:" + re.sub(r"\d+", "N", u.path)


with a.app.app_context():
    _db = a.get_db()
    ppl = [r[0] for r in _db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZDEMO-CHBM-%' OR "
                                     "employee_id LIKE 'ZZPMDEMO-%'")]
    ppl += [r[0] for r in _db.execute("SELECT DISTINCT manager_id FROM users WHERE manager_id IS NOT NULL AND "
                                      "left_at IS NULL ORDER BY manager_id LIMIT 12")]
seen, mods = set(), 0
for uid in ppl:
    h = H.client_as(a, uid).get("/dashboard").get_data(as_text=True)
    for m in re.finditer(r'<a\b[^>]*\bhref="([^"]+)"', h):
        k_ = kind(m.group(1))
        seen.add(k_)
        mods += k_ == "module"
s.check("the dashboards rendered link into a module (the check reaches its line)", mods > 0 and len(ppl) >= 3,
        (len(ppl), mods))
s.check("no dashboard link goes anywhere move.js doesn't know about", not [k_ for k_ in seen if k_.startswith("unknown")],
        sorted(seen))

# ---------------------------------------------------------------------------
s.section("the look")
# top: var(--topbar-h) since the notice bar (2026-10-26): 56px, or 56px plus the bar while one shows
s.check("the veil sits under the top bar, which stays (top --topbar-h, below its z-index 890)",
        ".mv-veil { position: fixed; left: 0; right: 0; top: var(--topbar-h); bottom: 0; z-index: 885;" in css
        and H.cv(".topbar { background: var(--navy); padding: 0 24px; min-height: 56px; position: sticky; top: 0; z-index: 890; }") in css)
s.check("the agent: its red tile, the spark turning once, the line filling",
        H.cvp(".mv-tile { width: 64px; height: 64px; border-radius: 18px; background: var(--red);") in css
        and "animation: mvSpin 1s" in css and "animation: mvFill .9s" in css)
s.check("arriving: the module paints under the same veil and tile, which fade away",
        "html.mv-arrive body::after {" in css and "animation: mvArrive .35s ease-out .08s forwards;" in css
        and "fill='%23D61923'" in css)
_rm = re.search(r"@media \(prefers-reduced-motion: reduce\) \{\n  \.mv-veil, .*?\n\}", css, re.S)
s.check("...nothing moves for anyone asking for less motion",
        _rm is not None and ".mv-spark" in _rm.group(0) and "animation: none" in _rm.group(0))

sys.exit(s.done())
