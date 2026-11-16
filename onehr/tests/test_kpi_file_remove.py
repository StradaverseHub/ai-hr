"""The KPI check-in's file remove button -- Chris, 2026-11-05.

An employee could not find how to remove a wrong file: the x was a 13x15px pale grey glyph (2.4:1) and nothing showed for
1-2 s after a click. Now the x is a 24x24 button in a dark token with an accessible name from the file, the chip says
"Removing…" at once, a failure shows a line under the chip, and the employee's check-in table has row dividers.
A lint over static/style.css and static/journey_chat.js (the route itself is held by test_review_agent.py: the owner
removes, another person gets 404, a confirmed check-in is refused). Each assertion is falsified by feeding the same
checker a copy with that piece taken out.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("KPI check-in file remove: a 24px dark x, named by the file, Removing... at once, an error line, row dividers")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

CSS = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
JS = open(os.path.join(H.REPO, "static", "journey_chat.js"), encoding="utf-8").read()


def no_comments(css):
    return re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group()), css, flags=re.S)


def rule_body(css, selector):
    """The declarations of the last rule whose selector list is exactly `selector`."""
    body = None
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", no_comments(css)):
        if " ".join(m.group(1).split()) == selector:
            body = m.group(2)
    return body


def decl(body, prop):
    m = re.search(r"(?:^|;)\s*%s\s*:\s*([^;]+)" % re.escape(prop), body or "")
    return m.group(1).strip() if m else None


def to_px(v):
    m = re.fullmatch(r"([\d.]+)(rem|px)", v or "")
    return None if not m else float(m.group(1)) * (16 if m.group(2) == "rem" else 1)


def func_body(js, name):
    i = js.find("function %s(" % name)
    if i < 0:
        return ""
    j = js.find("\n  function ", i + 10)
    return js[i:j if j > 0 else len(js)]


def checks(css, js):
    rm = rule_body(css, ".rv-att-rm")
    fn = func_body(js, "removeAttachment")
    return {
        "rm_w": to_px(decl(rm, "width")) is not None and to_px(decl(rm, "width")) >= 24,
        "rm_h": to_px(decl(rm, "height")) is not None and to_px(decl(rm, "height")) >= 24,
        "rm_colour": decl(rm, "color") not in (None, "var(--d-fg-9aa0af)") and "9aa0af" not in (decl(rm, "color") or ""),
        "aria": bool(re.search(r'setAttribute\("aria-label",\s*"Remove "\s*\+\s*att\.filename\)', js)),
        "passes_chip": bool(re.search(r"removeAttachment\(att\.id,\s*wrap,\s*rm\)", js)),
        "busy": 'classList.add("is-busy")' in fn and 'className = "rv-att-busy"' in fn and "Removing" in fn,
        "err_path": 'className = "rv-att-err"' in fn and "Try again" in fn,
        "divider": bool(re.search(r"\.rv-scorecard\.rv-kpi-flat:has\(td\.rv-kpi-files\) tbody td\s*\{[^}]*border-top:[^;}]*var\(--line-strong\)",
                                  no_comments(css))),
    }


s.section("the stylesheet and the chat script as they stand")
ok = checks(CSS, JS)
s.check(".rv-att-rm is at least 24px wide", ok["rm_w"])
s.check(".rv-att-rm is at least 24px high", ok["rm_h"])
s.check(".rv-att-rm is no longer the pale token (--d-fg-9aa0af, 2.4:1)", ok["rm_colour"], decl(rule_body(CSS, ".rv-att-rm"), "color"))
s.check("the remove button is named from the file (aria-label 'Remove ' + filename)", ok["aria"])
s.check("the click hands the chip and the button to removeAttachment", ok["passes_chip"])
s.check("removeAttachment shows Removing... at once (is-busy chip + rv-att-busy)", ok["busy"])
s.check("removeAttachment has a failure line under the chip (rv-att-err, 'Try again')", ok["err_path"])
s.check("the row divider is scoped with :has(td.rv-kpi-files) and uses --line-strong", ok["divider"])
s.check("the remove button is hidden once the check-in is locked (kpiCtx.locked guard kept)",
        re.search(r"if \((?:!kpiCtx\.locked|kpiFilesOpen\(l\))\) \{\s*var rm = document\.createElement\(\"button\"\)", JS) is not None
        and "return !!kpiCtx && !kpiCtx.locked" in JS)   # kpiFilesOpen: never once locked (a line added since is the one exception)
s.check("the file name is never built into HTML (no innerHTML with att.filename)",
        not re.search(r"innerHTML[^;\n]*att\.filename", JS))

s.section("falsified: the same checker, with each piece taken out, fails")
bad_css = [
    ("width 1.5rem -> 12px", CSS.replace("flex: none; width: 1.5rem; height: 1.5rem;", "flex: none; width: 12px; height: 1.5rem;"), JS, "rm_w"),
    ("height 1.5rem -> 12px", CSS.replace("flex: none; width: 1.5rem; height: 1.5rem;", "flex: none; width: 1.5rem; height: 12px;"), JS, "rm_h"),
    ("colour back to the pale token", CSS.replace("  color: var(--d-fg-4a5165); }\n.rv-att-rm svg", "  color: var(--d-fg-9aa0af); }\n.rv-att-rm svg"), JS, "rm_colour"),
    ("divider selector loses :has", CSS.replace(".rv-scorecard.rv-kpi-flat:has(td.rv-kpi-files) tbody td {", ".rv-scorecard.rv-kpi-flat tbody td {"), JS, "divider"),
    ("aria-label back to 'Remove attachment'", CSS, JS.replace('"Remove " + att.filename); rm.title', '"Remove attachment"); rm.title', 1), "aria"),
    ("chip not passed", CSS, JS.replace("removeAttachment(att.id, wrap, rm)", "removeAttachment(att.id)"), "passes_chip"),
    ("no is-busy", CSS, JS.replace('chip.classList.add("is-busy");', ""), "busy"),
    ("no error line", CSS, JS.replace('err.className = "rv-att-err";', 'err.className = "x";'), "err_path"),
]
for label, c, j, key in bad_css:
    changed = (c != CSS) or (j != JS)
    s.check("planted fault '%s' changes the source and trips '%s'" % (label, key), changed and not checks(c, j)[key])

sys.exit(s.done())
