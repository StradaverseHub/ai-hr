"""Colours are tokens (Chris, 2026-11-01: dark mode, Phase 2a; tools/css_tokens.py, OneHR/Dark mode build brief 2026-11-01.md).

Every colour in the product's CSS is `var(--token)`, whose light value is the colour it replaced (so light is pixel-identical)
and whose dark value is the dark palette (canvas board C1). A literal hex, rgb() or hsl() in the CSS is a colour dark mode
cannot repaint, so new CSS uses a token (the table in tools/css_tokens.py, or a --d-<role>-<hex> token the script makes).

What this lint holds, on static/style.css, every template that is not an email or a standalone page, and the script files:
  * no hex, rgb(a)() or white / black in a declaration, outside the generated token blocks, `@media print`, url(data:...)
    images, `rgba(var(--x), a)` (a triplet variable) and mask-image
  * the same rules as tools/css_tokens.py (one place), proved on planted violations: each one is found, each allowed form is not
  * tools/css_tokens.py --check passes on the tree (nothing left to convert, idempotent), and fails on a planted literal
  * the generated blocks: light on :root; dark on html[data-theme=dark] AND html[data-theme=auto] inside the
    prefers-color-scheme media query, both inside `@media screen` (print is always light), both with color-scheme: dark and
    the same values; every token the table names has a light and a dark value; every --d-* / --k-* token read anywhere is defined
  * what stays literal on purpose is the list in tools/css_tokens.py (STAYS): email builders, PDFs, the standalone pages, the
    sign-in mascot and the certificate canvas
"""
import contextlib
import glob
import importlib.util
import io
import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

s = H.Suite("Colours are tokens: no literal colour outside the token blocks")
REPO = H.REPO
spec = importlib.util.spec_from_file_location("css_tokens", os.path.join(REPO, "tools", "css_tokens.py"))
ct = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ct)
CSS = open(os.path.join(REPO, "static", "style.css"), encoding="utf-8").read()
TPL = {p: open(p, encoding="utf-8").read() for p in sorted(glob.glob(os.path.join(REPO, "templates", "**", "*.html"), recursive=True))}
SKIPPED = {p for p, t in TPL.items() if ct.is_email_template(p, t) or ct.is_standalone(p, t)}
LINTED = {p: t for p, t in TPL.items() if p not in SKIPPED}
rel = lambda p: os.path.relpath(p, REPO)  # noqa: E731


def css_left(text):
    return ct.leftover_literals(ct.strip_regions(text), "css")


s.section("the files")
s.check("static/style.css is there and large", len(CSS) > 500000)
s.check("it carries the generated token region (begin and end marks, once each)", CSS.count(ct.BEGIN) == 1 and CSS.count(ct.END) == 1)
s.check("(templates are linted, and the email and standalone pages are set apart)", len(LINTED) > 200 and 0 < len(SKIPPED) <= 20, (len(LINTED), len(SKIPPED)))
s.check("what is set apart is an email page, a standalone page (own <html>, no base.html) or a named one",
        all(ct.is_email_template(p, TPL[p]) or ct.is_standalone(p, TPL[p]) for p in SKIPPED))
s.check("base.html itself is linted (it carries the page frame)", any(p.endswith("templates/base.html") for p in LINTED))

s.section("no literal colour in the CSS")
bad = css_left(CSS)
s.check("static/style.css: no hex, rgb() or white / black outside the token blocks, print and url() images", not bad, bad[:6])

s.section("no literal colour in a template")
for p, t in LINTED.items():
    b = ct.leftover_literals(t, "tpl", os.path.basename(p) in ct.FALLBACK_FILES)
    if b:
        s.check("%s: no literal colour" % rel(p), False, b[:4])
        break
else:
    s.check("every linted template: no literal colour in a style, <style> block or svg attribute (%d templates)" % len(LINTED), True)
s.check("the two partials the offline export also includes keep their light colours only as var(--token, fallback)",
        all(not ct.leftover_literals(LINTED[p], "tpl", True) for p in LINTED if os.path.basename(p) in ct.FALLBACK_FILES)
        and any("var(--" in LINTED[p] and ", #" in LINTED[p] for p in LINTED if os.path.basename(p) in ct.FALLBACK_FILES))

s.section("the scripts read tokens, not hex")
for f in ("band_rules.js", "datepicker.js"):
    t = open(os.path.join(REPO, "static", f), encoding="utf-8").read()
    s.check("static/%s has no literal colour" % f, not re.search(r"""["'](?:#[0-9a-fA-F]{3,6}|rgba?\()""", t), "")
s.check("band_rules.js reads the band tokens (--ua-bg ... --ou-dot)", "var(--\" + t + \"-bg)" in open(os.path.join(REPO, "static", "band_rules.js"), encoding="utf-8").read())

s.section("the lint proves itself on planted violations")
planted_css = {
    "a hex colour": ".a { color: #fff; }",
    "a 3-digit hex": ".a { background: #abc; }",
    "an rgb()": ".a { border: 1px solid rgb(10, 20, 30); }",
    "an rgba() shadow": ".a { box-shadow: 0 1px 2px rgba(0,0,0,.2); }",
    "a named colour": ".a { color: white; }",
    "a hex inside a gradient": ".a { background: linear-gradient(90deg, #fff, var(--surface)); }",
    "a hex as a var fallback": ".a { color: var(--nope, #123456); }",
    "a literal after a print block closed": "@media print { .a { color: #000; } } .b { color: #111; }",
}
for name, css in planted_css.items():
    s.check("a planted violation is found: %s" % name, bool(ct.leftover_literals(css, "css")), css)
allowed_css = {
    "a token": ".a { color: var(--ink); background: var(--surface); }",
    "transparent and currentColor": ".a { background: transparent; border-color: currentColor; }",
    "a hex inside @media print": "@media print { .a { color: #000; background: #fff; } }",
    "a hex inside a url() image": ".a { background: url(\"data:image/svg+xml,%3Csvg fill='%23fff' stroke='#123456'/%3E\") no-repeat; }",
    "a triplet variable": ".a { box-shadow: 0 0 0 4px rgba(var(--od-glow), 0.12); }",
    "a mask": ".a { -webkit-mask-image: linear-gradient(black, transparent); }",
    "a colour word in a content string": ".a::after { content: \"white\"; }",
    "a hex in a comment": "/* the old colour was #fff */ .a { color: var(--ink); }",
}
for name, css in allowed_css.items():
    s.check("an allowed form is not flagged: %s" % name, not ct.leftover_literals(css, "css"), ct.leftover_literals(css, "css"))
s.check("a template: a planted style=\"color:#fff\" is found; a token is not",
        bool(ct.leftover_literals('<p style="color:#fff">x</p>', "tpl")) and not ct.leftover_literals('<p style="color:var(--ink)">x</p>', "tpl"))
s.check("a template: a planted <style> block literal is found", bool(ct.leftover_literals("<style>.a{color:#123456}</style>", "tpl")))
s.check("a template: a planted svg fill attribute is found", bool(ct.leftover_literals('<svg><path fill="#123456"/></svg>', "tpl")))
s.check("a template: Jinja text with a # in it is not a colour (&#10003; and #anchor)",
        not ct.leftover_literals('<a href="#add">&#10003;</a><p style="margin:0">x</p>', "tpl"))


def run_tokens(root, *flags):
    """tools/css_tokens.py main() on `root`: (exit code, what it printed). In this process: a child Python on macOS can sit
    waiting on its Dock icon in a headless session."""
    old = sys.argv
    buf = io.StringIO()
    code = 0
    try:
        sys.argv = ["css_tokens.py", root] + list(flags)
        with contextlib.redirect_stdout(buf):
            try:
                ct.main()
            except SystemExit as e:
                code = e.code or 0
    finally:
        sys.argv = old
    return code, buf.getvalue()


s.section("the converter: --check on the tree, a planted literal, idempotent")
code, out = run_tokens(REPO, "--check")
s.check("tools/css_tokens.py --check passes on this tree (nothing left to convert, the blocks are current)", code == 0, out[-300:])
with tempfile.TemporaryDirectory() as d:
    os.makedirs(os.path.join(d, "static"))
    os.makedirs(os.path.join(d, "templates"))
    open(os.path.join(d, "app.py"), "w").write("")
    open(os.path.join(d, "static", "style.css"), "w").write(".a { color: #5f6678; background: #ffffff; border: 1px solid #e4e7ef; } @media print { .b { color: #000; } }")
    open(os.path.join(d, "templates", "x.html"), "w").write('<p style="color:#1f2330;border-top:1px solid #d7dbe6">x</p>')
    open(os.path.join(d, "templates", "welcome_email.html"), "w").write('<p style="color:#123456" bgcolor="#fff">email</p>')
    code, out = run_tokens(d, "--check")
    s.check("--check fails on a planted literal in the CSS and a template", code == 1, out[-200:])
    run_tokens(d)
    once = open(os.path.join(d, "static", "style.css")).read()
    tpl = open(os.path.join(d, "templates", "x.html")).read()
    code, out = run_tokens(d, "--check")
    s.check("...the converter fixes both, and --check then passes", code == 0, out[-200:])
    s.check("a table colour becomes its named token, by role (text #5f6678 is --muted, a fill #ffffff is --surface, a line #e4e7ef is --line)",
            "color: var(--muted)" in once and "background: var(--surface)" in once and "border: 1px solid var(--line)" in once, "" if "color: var(--muted)" in once else once[-420:])
    s.check("a colour the table does not name gets a --d-<role>-<hex> token, in the light block", "var(--d-bd-d7dbe6)" in tpl and "--d-bd-d7dbe6: #d7dbe6;" in once, "" if "var(--d-bd-d7dbe6)" in tpl else tpl)
    s.check("the print block keeps its literal (print is light)", "@media print { .b { color: #000; } }" in once)
    s.check("the email template is left alone (Outlook has no CSS variables)",
            open(os.path.join(d, "templates", "welcome_email.html")).read() == '<p style="color:#123456" bgcolor="#fff">email</p>')
    run_tokens(d)
    s.check("a second run changes nothing (idempotent)", open(os.path.join(d, "static", "style.css")).read() == once)

s.section("the generated blocks")
a = CSS.index(ct.BEGIN)
region = CSS[a:CSS.index(ct.END)]
root_m = re.search(r":root \{(.*?)\n\}", region, re.S)
dark_m = re.search(r"html\[data-theme=dark\] \{(.*?)\n\}", region, re.S)
auto_m = re.search(r"html\[data-theme=auto\] \{(.*?)\n\}", region, re.S)
s.check("the light block is on :root, the dark block on html[data-theme=dark], and again on html[data-theme=auto]", bool(root_m and dark_m and auto_m))


def decls(body):
    return dict(re.findall(r"--([\w-]+):\s*([^;]+);", body))


light, dark, auto = decls(root_m.group(1)), decls(dark_m.group(1)), decls(auto_m.group(1))
s.check("both dark blocks hold the same values (one table writes both)", dark == auto and len(dark) > 40, (len(dark), len(auto)))
s.check("both set color-scheme: dark (scrollbars, inputs and the native date picker follow)",
        "color-scheme: dark" in dark_m.group(1) and "color-scheme: dark" in auto_m.group(1))
s.check("light does not set color-scheme (Standard is untouched)", "color-scheme" not in root_m.group(1))
i_dark, i_auto = region.index("html[data-theme=dark] {"), region.index("html[data-theme=auto] {")
screen_a = region.index("@media screen {")
screen_b = region.index("@media screen and (prefers-color-scheme: dark) {")
s.check("the dark block sits inside @media screen (so print is light)", screen_a < i_dark < screen_b)
s.check("the auto block sits inside @media screen and (prefers-color-scheme: dark)", screen_b < i_auto)
table_names = [n for n, l, d, u in ct.TOKENS]
s.check("every token in the table is in the light block with its light value", all(light.get(n, "").lower() == l.lower() for n, l, d, u in ct.TOKENS))
s.check("...and in the dark block with its dark value", all(dark.get(n, "").lower() == d.lower() for n, l, d, u in ct.TOKENS if d != l or True))
s.check("the C1 names are there (page, surface, surface-2, surface-3, line, line-soft, line-strong, topbar, ink, ink-2, muted, faint, accent-ink, link, accent, "
        "ai, ai-ink, ai-tint, ai-line, danger-ink, overlay, shadow, the status pairs and the five band chips)",
        all(n in light for n in ("page surface surface-2 surface-3 line line-soft line-strong topbar ink ink-2 muted faint accent-ink link accent ai ai-ink "
                                 "ai-tint ai-line danger-ink overlay shadow ok-tint ok-ink info-tint info-ink warn-tint warn-ink bad-tint bad-ink "
                                 "ua-bg ua-fg ua-dot be-bg be-fg be-dot me-bg me-fg me-dot ae-bg ae-fg ae-dot ou-bg ou-fg ou-dot").split()))
s.check("the old names live on as aliases (--navy, --navy-700, --navy-600, --red, --red-700, --rl-line ...)",
        all(light.get(k, "").startswith("var(--") for k in ("navy", "navy-700", "navy-600", "red", "red-700", "rl-line", "rl-line-soft", "rl-danger")))
used = set()
for t in [CSS] + list(TPL.values()) + [open(p, encoding="utf-8").read() for p in glob.glob(os.path.join(REPO, "static", "*.js"))]:
    used.update(re.findall(r"var\(--((?:d-[a-z]+|k)-[0-9a-f]{6}(?:-a[0-9]+)?)", t))
s.check("every --d-* / --k-* token read anywhere is defined in the light block (%d tokens)" % len(used), all(u in light for u in used), [u for u in used if u not in light][:5])
s.check("every derived token has a light value that is a colour and a dark value that is one too",
        all(re.match(r"^(#[0-9a-f]{6}|rgba?\([\d., ]+\))$", light[k]) for k in light if k.startswith(("d-", "k-"))) and
        all(re.match(r"^(#[0-9a-f]{6}|rgba?\([\d., ]+\))$", v) for k, v in dark.items() if k.startswith("d-")))
s.check("no dark block is written by hand: the region says so, and a re-run rewrites it", "do not edit by hand" in ct.BEGIN)

s.section("what stays literal is the documented list")
s.check("the list is in tools/css_tokens.py (STAYS), with a reason on each", len(ct.STAYS) >= 6 and all(len(r) == 2 and r[1] for r in ct.STAYS))
APP = open(os.path.join(REPO, "app.py"), encoding="utf-8").read()
s.check("the email builders keep hex (Outlook has no CSS variables)", "def onehr_email" in APP and "var(--" not in APP.split("def onehr_email", 1)[1][:6000])

sys.exit(s.done())
