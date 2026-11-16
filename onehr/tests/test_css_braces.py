"""Every stylesheet's braces balance -- 2026-11-08.

0c557243 left the file preview box's `@media (max-width: 600px) {` unclosed in static/style.css, so every rule written after
it was read as inside it and applied at 600px or less only (found 2026-11-08, closed in max/css-brace). A lint over every
static/**/*.css: braces balance, ignoring comments and "quoted" / 'quoted' strings; a failure names the file and the
line of the first `{` left open (or the line of a stray `}`). Falsified by feeding the same checker a planted bug.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("CSS braces balance (every static/**/*.css)")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

ROOT = H.REPO


def brace_problem(css):
    """None when balanced; else a message naming the line of the stray `}` or of the first `{` left open."""
    stack, line, i, n = [], 1, 0, len(css)
    while i < n:
        ch = css[i]
        if ch == "\n":
            line += 1
        elif css.startswith("/*", i):
            end = css.find("*/", i + 2)
            end = n if end < 0 else end + 2
            line += css.count("\n", i, end)
            i = end
            continue
        elif ch in "\"'":
            j = i + 1
            while j < n and css[j] != ch and css[j] != "\n":
                j += 2 if css[j] == "\\" else 1
            i = j + 1
            continue
        elif ch == "{":
            stack.append(line)
        elif ch == "}":
            if not stack:
                return "line %d: a `}` with no `{` open" % line
            stack.pop()
        i += 1
    if stack:
        return "line %d: the first `{` left unclosed (%d open at the end)" % (stack[0], len(stack))
    return None


files = []
for dirpath, _d, names in os.walk(os.path.join(ROOT, "static")):
    for f in names:
        if f.endswith(".css"):
            files.append(os.path.join(dirpath, f))
files.sort()

s.section("the scan")
rels = [os.path.relpath(p, ROOT) for p in files]
s.check("static/style.css was scanned (%d css files)" % len(files), "static/style.css" in rels)

s.section("the rule")
for p, rel in zip(files, rels):
    prob = brace_problem(open(p, encoding="utf-8").read())
    s.check("%s: braces balance%s" % (rel, "" if prob is None else " -- " + rel + " " + prob), prob is None)

s.section("falsified")
bug = "@media (max-width: 600px) {\n  .a { color: red; }\n.b { color: blue; }\n"
s.check("an unclosed @media is caught, naming its line", (brace_problem(bug) or "").startswith("line 1:"), str(brace_problem(bug)))
s.check("a stray } is caught, naming its line", (brace_problem(".a { x: 1; }\n}\n") or "").startswith("line 2:"))
s.check("braces in a comment or a quoted string are ignored",
        brace_problem('/* { */\n.a::before { content: "{"; }\n.b::after { content: \'}}\'; }\n') is None)
s.check("a balanced nested @media passes", brace_problem("@media (x) {\n .a { y: 1; }\n}\n") is None)

sys.exit(s.done())
