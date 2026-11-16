"""Text sizes are rem (Chris, 2026-11-01: the Text size setting; tools/css_units.py).

The Text size control scales the root font size (html[data-text=s|l|xl]); every text size in the CSS is rem, so the whole
product follows it. A size left in px does not move, and one that is under 11.5px with no floor draws under 10px at Small.

What this lint holds, on static/style.css and every template that is not an email:
  * no `font-size` in px, no px `line-height`, no px size in a `font:` shorthand, outside `@media print`
  * every size at 11.5px or less, the rem ones included, is wrapped in max(10px, ...) (a size already under 10px floors at
    its own px, so Standard is unchanged)
  * the three html[data-text] rules exist, at 87.5%, 112.5% and 125%
  * the same rule set as tools/css_units.py (one place), proved on planted violations: each one is found, each allowed form
    (print, an email template, a floored size) is not
  * the text controls whose fixed 34px height spilled their label use min-height
What it leaves alone, on purpose: @media print, email templates and builders (Outlook has no rem; an email preview iframe has
its own root), the PDF styles, and the certificate canvas.
"""
import glob
import importlib.util
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

s = H.Suite("Text sizes are rem, with a floor under 11.5px")
REPO = H.REPO
spec = importlib.util.spec_from_file_location("css_units", os.path.join(REPO, "tools", "css_units.py"))
cu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cu)
CSS = open(os.path.join(REPO, "static", "style.css"), encoding="utf-8").read()
TPL = {p: open(p, encoding="utf-8").read() for p in sorted(glob.glob(os.path.join(REPO, "templates", "*.html")))}
NON_EMAIL = {p: t for p, t in TPL.items() if not cu.is_email_template(p, t)}
rel = lambda p: os.path.relpath(p, REPO)  # noqa: E731


def problems(text):
    """What the converter would still change or flag in `text`: a px size, or a small rem size with no floor."""
    out = list(cu.leftovers(text))
    if cu.convert(text, __import__("collections").Counter()) != text:
        out.append("an unconverted size")
    return out


s.section("the files")
s.check("static/style.css is there and large", len(CSS) > 500000)
s.check("(there are non-email templates to lint, and the email ones are set apart)", len(NON_EMAIL) > 150 and 0 < len(TPL) - len(NON_EMAIL) <= 8,
        (len(NON_EMAIL), len(TPL) - len(NON_EMAIL)))
s.check("the templates set apart are the email pages (named *email*, or holding bgcolor)",
        all("email" in os.path.basename(p).lower() or "bgcolor" in t for p, t in TPL.items() if p not in NON_EMAIL))

s.section("no px text size")
bad = problems(CSS)
s.check("static/style.css: no font-size / line-height / font: size in px, outside @media print", not bad, bad[:6])
for p, t in NON_EMAIL.items():
    b = problems(t)
    if b:
        s.check("%s: no px text size" % rel(p), False, b[:4])
        break
else:
    s.check("every non-email template: no px text size (%d templates)" % len(NON_EMAIL), True)

s.section("the floor")
small = []
for m in re.finditer(r"(?<![-\w])font-size\s*:\s*(\d*\.?\d+)rem(?![\w-])", CSS):
    if float(m.group(1)) * 16 <= 11.5:
        small.append(m.group(0))
s.check("no size at 11.5px or less is a bare rem value", not small, small[:5])
floors = re.findall(r"max\((\d*\.?\d+)px,\s*(\d*\.?\d+)rem\)", CSS)
s.check("the floors are there (hundreds: every small size)", len(floors) >= 300, len(floors))
s.check("...each floors at 10px, or at its own px when that is under 10px (so Standard is unchanged)",
        all(float(f) == 10 or abs(float(f) - float(r) * 16) < 0.01 for f, r in floors) and all(float(f) <= 10 for f, r in floors),
        [x for x in floors if not (float(x[0]) == 10 or abs(float(x[0]) - float(x[1]) * 16) < 0.01)][:4])
s.check("...a floor of 10px is only ever given to a size that is 10px or over (a 10px floor must not GROW a smaller one)",
        all(float(r) * 16 >= 10 - 0.01 for f, r in floors if float(f) == 10), [x for x in floors if float(x[0]) == 10 and float(x[1]) * 16 < 10][:4])
s.check("Small never draws under 10px except the sizes that were under 10px already (a handful)",
        sum(1 for f, r in floors if float(f) < 10) <= 30, sum(1 for f, r in floors if float(f) < 10))

s.section("the setting's three rules")
for key, pct in (("s", "87.5%"), ("l", "112.5%"), ("xl", "125%")):
    s.check("html[data-text=%s] { font-size: %s }" % (key, pct),
            re.search(r"html\[data-text=%s\]\s*\{\s*font-size:\s*%s;\s*\}" % (key, re.escape(pct)), CSS) is not None)
s.check("Standard has no rule of its own (m is the browser's 100%)", "html[data-text=m]" not in CSS)

s.section("the lint proves itself on planted violations")
good = ".a { font-size: 0.875rem; line-height: 1.4; } .b { font-size: max(10px, 0.6875rem); } .c { font: 600 0.78125rem/1 Arial; }"
s.check("(a clean sample is clean)", not problems(good), problems(good))
plants = {
    "a px font-size": ".a { font-size: 13px; }",
    "a px font-size with !important": ".a { font-size: 12px !important; }",
    "a px line-height": ".a { line-height: 20px; }",
    "a px size in a font: shorthand": ".a { font: 700 14px/1.3 Arial; }",
    "a small rem size with no floor": ".a { font-size: 0.6875rem; }",
    "a small rem size in a font: shorthand with no floor": ".a { font: 600 0.65rem/1 Arial; }",
    "a size at exactly 11.5px (0.71875rem) with no floor": ".a { font-size: 0.71875rem; }",
    "a px size inside a media query that is not print": "@media (max-width: 900px) { .a { font-size: 15px; } }",
    "a px size after a print block closed": "@media print { .a { font-size: 12px; } } .b { font-size: 13px; }",
}
for name, css in plants.items():
    s.check("a planted violation is found: %s" % name, bool(problems(css)), css)
allowed = {
    "a px size inside @media print": "@media print { .a { font-size: 12px; line-height: 16px; } }",
    "a floored small size": ".a { font-size: max(10px, 0.6875rem); }",
    "a size under 10px floored at its own px": ".a { font-size: max(9.6px, 0.6rem); }",
    "a size over 11.5px as plain rem": ".a { font-size: 0.75rem; }",
    "an em size": ".a { font-size: 0.8em; }",
}
for name, css in allowed.items():
    s.check("an allowed form is not flagged: %s" % name, not problems(css), problems(css))
# the same planted violation in a file, through the converter's own --check (in this process: a child Python on macOS can sit
# waiting on its Dock icon in a headless session)
import contextlib  # noqa: E402
import io  # noqa: E402
import tempfile  # noqa: E402


def run_units(root, *flags):
    """tools/css_units.py main() on `root`: (exit code, what it printed)."""
    old = sys.argv
    buf = io.StringIO()
    code = 0
    try:
        sys.argv = ["css_units.py", root] + list(flags)
        with contextlib.redirect_stdout(buf):
            try:
                cu.main()
            except SystemExit as e:
                code = e.code or 0
    finally:
        sys.argv = old
    return code, buf.getvalue()


with tempfile.TemporaryDirectory() as d:
    os.makedirs(os.path.join(d, "static"))
    os.makedirs(os.path.join(d, "templates"))
    open(os.path.join(d, "app.py"), "w").write("")
    open(os.path.join(d, "static", "style.css"), "w").write(good)
    open(os.path.join(d, "templates", "x.html"), "w").write('<p style="font-size:13px">x</p>')
    open(os.path.join(d, "templates", "welcome_email.html"), "w").write('<p style="font-size:13px">email</p>')
    code, out = run_units(d, "--check")
    s.check("tools/css_units.py --check fails on a planted px size in a template", code == 1, "" if code == 1 else out[-200:])
    os.remove(os.path.join(d, "templates", "x.html"))
    code, out = run_units(d, "--check")
    s.check("...and passes with it gone: an email template's px size is left alone", code == 0, "" if code == 0 else out[-200:])
    open(os.path.join(d, "static", "style.css"), "w").write(".a { font-size: 14px; }")
    run_units(d)
    once = open(os.path.join(d, "static", "style.css")).read()
    run_units(d)
    s.check("the converter turns 14px into 0.875rem, and a second run changes nothing (idempotent)",
            once.strip() == ".a { font-size: 0.875rem; }" and open(os.path.join(d, "static", "style.css")).read() == once, once)

s.section("text controls use min-height, not height")
for sel in (r"\.jg-addbtn", r"\.rv-tbox-save, \.rv-tbox-cancel", r"\.rv-dr-addrm", r"\.adm-chip", r"\.tb-acct", r"\.adm-search-trigger", r"\.ln-tab"):
    m = re.search(r"(?m)^%s\s*\{([^}]*)\}" % sel, CSS)
    body = m.group(1) if m else ""
    s.check("%s sets min-height and no fixed height" % sel.replace("\\", ""),
            bool(m) and re.search(r"(?<![-\w])min-height\s*:", body) is not None and re.search(r"(?<![-\w])height\s*:", body) is None, body[:120])

sys.exit(s.done())
