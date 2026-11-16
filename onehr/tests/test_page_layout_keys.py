"""A page's own layout never lands on the dashboard -- 2026-10-23.

On 2026-10-23 Chris found staging's dashboard with its cards under the Ask OneHR panel. AI+ Learning's shell (f990208)
had keyed its full-screen layout on `body:has(.ln) #main.container`, and the dashboard's own rail icons are
`<path class="ln">`, so the dashboard took the shell's margin (an id outranks the guide panel's
`main.container:has(.gp...)` 340px) and slid under the panel. The fix keys the shell on its id (#ln, div.ln).

What it holds, for every rule in style.css that moves the page box (#main / main.container: margin or max-width) on a
`body:has(...)` condition: the condition's class or id appears nowhere in the dashboard's templates (dashboard.html and
everything it extends, includes or imports). The dashboard is the page whose Ask OneHR panel needs that margin.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A page's own layout never lands on the dashboard (body:has keys vs the dashboard's templates)")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
TPL = os.path.join(ROOT, "templates")
CSS = re.sub(r"/\*.*?\*/", "", open(os.path.join(ROOT, "static", "style.css"), encoding="utf-8").read(), flags=re.S)


def closure(name, seen=None):
    """The template and everything it extends, includes or imports."""
    seen = set() if seen is None else seen
    path = os.path.join(TPL, name)
    if name in seen or not os.path.exists(path):
        return seen
    seen.add(name)
    src = open(path, encoding="utf-8").read()
    for inc in re.findall(r"{%-?\s*(?:include|extends|import|from)\s+[\"']([^\"']+)[\"']", src):
        closure(inc, seen)
    return seen


DASH = closure("dashboard.html")
DASH_SRC = "\n".join(open(os.path.join(TPL, f), encoding="utf-8").read() for f in sorted(DASH))
s.check("the dashboard's templates are found (base.html among them)", "dashboard.html" in DASH and "base.html" in DASH,
        sorted(DASH))


def on_dashboard(tok):
    n = re.escape(tok[1:])
    if tok[0] == ".":
        return re.search(r'class="[^"]*(?<![\w-])%s(?![\w-])' % n, DASH_SRC) is not None
    return re.search(r'id="%s"' % n, DASH_SRC) is not None


movers, bad = [], []
for sel, decl in re.findall(r"([^{}]+)\{([^{}]*)\}", CSS):
    for one in sel.split(","):
        one = one.strip()
        if "body:has(" not in one or not re.search(r"#main\b|main\.container", one):
            continue
        if not re.search(r"(?:^|;)\s*(?:margin(?:-[a-z]+)?|max-width)\s*:", decl):
            continue
        movers.append(one)
        for cond in re.findall(r"body:has\(([^)]*)\)", one):
            for tok in re.findall(r"[.#][\w-]+", cond):
                if on_dashboard(tok):
                    bad.append("%s  (%s is on the dashboard)" % (one, tok))
s.check("there are page-level rules that move the page box, so the check reaches its lines", len(movers) >= 2, movers)
s.check("no page's body:has(...) layout keys on a class or id the dashboard carries", not bad, bad)

s.section("the case that broke it")
s.check("the dashboard's rail icons draw with class=\"ln\" (why a bare .ln can never key a page)",
        on_dashboard(".ln"))
s.check("AI+ Learning's shell keys its layout on its id: body:has(#ln), and its grid on div.ln",
        "body:has(#ln) #main.container" in CSS and "body:has(.ln)" not in CSS
        and re.search(r"(?:^|\})\s*\.ln\s*[{,]", CSS) is None and "div.ln {" in CSS)
s.check("...and the shell's wrapper carries that id",
        'class="ln" id="ln"' in open(os.path.join(TPL, "learning", "shell.html"), encoding="utf-8").read())
s.check("the guide panel's own margin rule is still there", "main.container:has(.gp:not([hidden]))" in CSS)

sys.exit(s.done())
