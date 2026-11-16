"""Hover never underlines text -- Chris, 2026-10-30.

A lint over every stylesheet: no rule whose selector has :hover or :focus may carry `underline` in its body (links
darken, text links get a soft wash, whole cells tint instead). It reads every static/**/*.css and every <style> block
in templates/**/*.html, with CSS comments stripped, and names file:line and selector for each offender. Falsified by
planting a hover underline in a string and feeding it to the same checker.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Hover never underlines (no :hover / :focus rule holds underline)")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

ROOT = H.REPO
RULE = re.compile(r"([^{}]+)\{([^{}]*)\}")


def strip_comments(src):
    """Blank comments but keep every newline, so line numbers stay true."""
    return re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group()), src, flags=re.S)


def check_css(css, label, base_line=1):
    """Return (rules_checked, offenders) for one stylesheet's text."""
    css = strip_comments(css)
    checked, bad = 0, []
    for m in RULE.finditer(css):
        sel = " ".join(m.group(1).split())
        checked += 1
        if re.search(r":(hover|focus)", sel) and "underline" in m.group(2):
            line = base_line + css.count("\n", 0, m.start(2))
            bad.append("%s:%d %s" % (label, line, sel))
    return checked, bad


total, offenders, files = 0, [], []
for dirpath, _d, names in os.walk(os.path.join(ROOT, "static")):
    for f in names:
        if f.endswith(".css"):
            rel = os.path.relpath(os.path.join(dirpath, f), ROOT)
            c, b = check_css(open(os.path.join(dirpath, f), encoding="utf-8").read(), rel)
            total += c
            offenders += b
            files.append(rel)
for dirpath, _d, names in os.walk(os.path.join(ROOT, "templates")):
    for f in names:
        if not f.endswith(".html"):
            continue
        rel = os.path.relpath(os.path.join(dirpath, f), ROOT)
        src = open(os.path.join(dirpath, f), encoding="utf-8").read()
        for m in re.finditer(r"<style\b[^>]*>(.*?)</style>", src, re.S):
            c, b = check_css(m.group(1), rel, src.count("\n", 0, m.start(1)) + 1)
            total += c
            offenders += b

s.section("the scan")
s.check("static/style.css was scanned", "static/style.css" in files)
s.check("rules were checked (%d)" % total, total > 500)

s.section("the rule")
s.check("no :hover / :focus rule underlines" + ("" if not offenders else ": " + "; ".join(offenders)), not offenders)

s.section("abbr tips (Chris, 2026-11-01)")
_base = strip_comments(open(os.path.join(ROOT, "static", "style.css"), encoding="utf-8").read())
_abbr = [m.group(2) for m in RULE.finditer(_base) if " ".join(m.group(1).split()) == "abbr[title]"]
s.check("abbr[title] drops the browser's dotted underline",
        any(re.search(r"text-decoration\s*:\s*none", b) for b in _abbr), str(_abbr))

s.section("falsified")
_c, planted = check_css("a:hover { color: red; }\n.x:focus-visible { text-decoration: underline; }", "planted")
s.check("a planted focus underline is caught, with its line", planted == ["planted:2 .x:focus-visible"], str(planted))
_c, planted = check_css("/* .x:hover { text-decoration: underline; } */\n.y { text-decoration: underline; }", "planted")
s.check("a commented-out rule and an at-rest underline are not flagged", planted == [], str(planted))
_c, planted = check_css(".z:hover{text-underline-offset:3px;text-decoration:underline}", "planted")
s.check("a minified hover underline is caught", len(planted) == 1, str(planted))

sys.exit(s.done())
