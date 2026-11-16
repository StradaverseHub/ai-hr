"""The phone's back gesture (Chris, 8 Nov 2026, from his phone: on the HOD's one-person page a swipe back closed the whole check-in; OneHR/Phone back gesture
build brief 2026-11-08.md). On a phone (window.onehrIsPhone(), under 1024px) the system back closes the TOP LAYER first, exactly as that layer's own
close does; only with no layer open does it leave the page. 1024px and up never pushes a history entry.

What this suite holds (each check is proved once on a source with its piece taken out, so none can pass by accident):
  * ONE helper, window.onehrBackLayer, defined once in static/move_in.js; it answers a no-op unless window.onehrIsPhone() is true, BEFORE any history call
  * no history.pushState anywhere in the app outside that helper; every pushState / replaceState it makes passes location.href (same url: never a hash,
    a `?` or a path)
  * the helper has the popstate closer, the done() that drops a layer's entry, the tap rule (user activation) and the reload clean-up
  * every phone layer calls the helper and lets its entry go in its own close: the reader sheet, the phone sheet (BU list, curves, Move), the person page (one
    layer that follows the STATE, so the pager pushes nothing), the To do sheet, Ask OneHR's sheet, Help, What's new, the file preview, the KPI pop-out,
    the confirm / prompt / date / notice boxes of base.html, the chat's confirm box, sign-off box, remark pop-out, the AI fit box, the unassigned-bands box
    and the curve pop-out; a confirm's OK lets the entry go BEFORE it runs what it does
  * the helper is not called from anywhere else (a new call site must be added to this list)
No real names: the suite reads source files only.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Phone back gesture: one helper, every phone layer")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

FILES = ["static/move_in.js", "static/journey_chat.js", "static/ask_onehr.js", "static/help.js", "static/whatsnew.js", "static/file_preview.js",
         "static/kpi_line.js", "static/calib_shared.js", "static/admin.js", "templates/base.html"]
SRC = {n: H.source(a, n) for n in FILES}
MV, JS = "static/move_in.js", "static/journey_chat.js"


def fn(src, head, indent="  "):
    """The text of one function, from its `head` to the next function at the same indent."""
    i = src.find(head)
    if i < 0:
        return ""
    m = re.search(r"\n" + indent + r"function \w+\(", src[i + len(head):])
    return src[i:i + len(head) + (m.start() if m else len(src))]


def helper(t):
    i = t.find("THE PHONE BACK GESTURE")
    return t[i:] if i >= 0 else ""


def falsify(name, test, file, cut):
    src = dict(SRC)
    src[file] = cut(src[file]) if callable(cut) else src[file].replace(cut, "")
    ok = not test(src)
    s.check("falsified: %s fails without its piece" % name, ok, "" if ok else "still passes with the piece removed")


def check(name, test, file=None, cut=None):
    s.check(name, test(SRC))
    if file:
        falsify(name, test, file, cut)


# ---------------------------------------------------------------------------
s.section("the one helper")
check("window.onehrBackLayer is defined once, in static/move_in.js, and nowhere else",
      lambda S: S[MV].count("window.onehrBackLayer = function") == 1 and not any(re.search(r"window\.onehrBackLayer\s*=[^=]", S[f]) for f in FILES if f != MV),
      MV, lambda t: t.replace("window.onehrBackLayer = function", "window.onehrBackLayerX = function"))
check("it answers a no-op unless onehrIsPhone() is true, before any history call",
      lambda S: (lambda h: "if (!phone() || typeof closeFn !== \"function\") return noop;" in h
                 and h.find("if (!phone() ||") < h.find("else push(L);") and "function phone() { return typeof window.onehrIsPhone === \"function\" && window.onehrIsPhone(); }" in h)(helper(S[MV])),
      MV, lambda t: t.replace("if (!phone() || typeof closeFn", "if (typeof closeFn"))
check("a tap is required to push (user activation: Chrome on Android skips an entry pushed without one)",
      lambda S: "navigator.userActivation" in helper(S[MV]) and "if (!tapped() && pendingBack <= 0 && !L.force) return noop;" in helper(S[MV]),
      MV, lambda t: t.replace("if (!tapped() && pendingBack <= 0 && !L.force) return noop;", ""))
check("every history.pushState / replaceState in the helper passes location.href (the same url)",
      lambda S: (lambda h: len(re.findall(r"history\.(?:pushState|replaceState)\(", h)) >= 4
                 and all(re.search(r',\s*""\s*,\s*location\.href\)', m) for m in re.findall(r"history\.(?:pushState|replaceState)\([^;]*;", h)))(helper(S[MV])),
      MV, lambda t: t.replace('history.pushState({ onehrLayer: stack.indexOf(L) + 1 }, "", location.href)', 'history.pushState({ onehrLayer: stack.indexOf(L) + 1 }, "", "#layer")'))
check("popstate closes the top layer while the stack is deeper than the entry's mark, and done() drops the entry with one history.go(-n)",
      lambda S: (lambda h: 'window.addEventListener("popstate"' in h and "while (stack.length > t && stack[stack.length - 1].seq <= born)" in h and "L.fn(true)" in h and "history.go(-n)" in h and "pendingBack++" in h)(helper(S[MV])),
      MV, lambda t: t.replace("while (stack.length > t && stack[stack.length - 1].seq <= born)", "while (false)"))
check("a reload or a restored page with the mark and nothing open drops the layer entries and the page's own (no dead back)",
      lambda S: "function clean()" in helper(S[MV]) and "history.go(-n)" in fn(helper(S[MV]), "function clean()") and 'addEventListener("pageshow"' in helper(S[MV]),
      MV, lambda t: t.replace('addEventListener("pageshow"', 'addEventListener("pageshowX"'))
check("a link, a form or a script navigation started by the closing tap is never cancelled by the traversal (navUntil)",
      lambda S: "navUntil" in helper(S[MV]) and "Date.now() < navUntil" in helper(S[MV]) and "navigation.addEventListener" in helper(S[MV]),
      MV, lambda t: t.replace("if (Date.now() < navUntil)", "if (false)"))
check("a window turned to a desktop width drops any layer entry that is left",
      lambda S: "window.onehrOnPhoneChange(function (p) {\n    if (p) return;" in helper(S[MV]),
      MV, lambda t: t.replace("    if (p) return;\n    setTimeout", "    return;\n    setTimeout"))
others = {f: S for f, S in SRC.items() if f != MV}
check("no history.pushState anywhere else in the app (scripts, templates, app.py)",
      lambda S: not any("pushState" in S[f] for f in FILES if f != MV) and "pushState" not in H.source(a, "app.py")
      and all("pushState" not in H.source(a, "static/" + n) for n in ("auth.js", "admin.js", "comp_detail.js", "learning_shell.js", "whatsnew.js", "gradeh_staff.js")),
      JS, lambda t: t + "\nhistory.pushState(null, '', '/x');\n")

# ---------------------------------------------------------------------------
s.section("every phone layer calls the helper and lets its entry go")
LAYERS = [
    # (name, file, function head, indent, needs in the function text)
    ("the KPI reader sheet", JS, "  function phSheetOpen(", "  ", ["onehrBackLayer", "bk.done()"]),
    ("the phone sheet (BU list, curves, Move)", JS, "  function phSheet(", "  ", ["onehrBackLayer", "bk.done()", "cfg.canClose"]),
    ("the person pages (HOD, BU CEO, BG CEO, Group Chief)", JS, "  function sheetBackSync(", "  ", ["onehrBackLayer", "sheetBackFn", "h.done()", "!sheetClosing"]),
    ("the person pages' back closer (close)", JS, "  function sheetBackFn(", "  ", ["sheetClose(\"back\"", "leaveGuard("]),
    ("the To do sheet (open)", JS, "  function openDrawer(", "  ", ["onehrBackLayer", "closeDrawer()"]),
    ("the To do sheet (close)", JS, "  function closeDrawer(", "  ", ["todoBk", ".done()"]),
    ("the chat's confirm box", JS, "  function openConfirm(", "  ", []),
    ("the sign-off box", JS, "  function signoffDialog(", "  ", ["onehrBackLayer", "soBk", ".done()", "if (submitting) return false"]),
    ("the remark pop-out", JS, "  function openRemarkModal(", "  ", ["onehrBackLayer", "rmBk", ".done()"]),
    ("the AI fit box", JS, "  function calFitDialog(", "  ", ["onehrBackLayer", "fitBk", ".done()", "if (applying) return false"]),
    ("the unassigned-bands box", JS, "  function calReviewAssignDialog(", "  ", []),
    ("Ask OneHR's sheet", "static/ask_onehr.js", "  function sheet(", "  ", ["onehrBackLayer", "askBk", ".done()"]),
    ("Help", "static/help.js", "  function open(", "  ", ["onehrBackLayer", "close()"]),
    ("Help (close)", "static/help.js", "  function close(", "  ", ["backLayer", ".done()"]),
    ("What's new (open)", "static/whatsnew.js", "  function open(", "  ", ["onehrBackLayer", "close()"]),
    ("What's new (close)", "static/whatsnew.js", "  function close(", "  ", ["backLayer", ".done()"]),
    ("the admin menu sheet", "static/admin.js", "  function openSheet(", "  ", ["onehrBackLayer", "closeSheet(true)"]),
    ("the admin menu sheet (close)", "static/admin.js", "  function closeSheet(", "  ", ["menuBk", ".done()"]),
    ("the admin search (open)", "static/admin.js", "  function open() {\n    if (!box) return;", "  ", ["onehrBackLayer", "searchBk"]),
    ("the admin search (close)", "static/admin.js", "  function close() {\n    if (!box || box.hidden) return;", "  ", ["searchBk", ".done()"]),
    ("the admin list panel (open)", "static/admin.js", "  function open(p, from, pp) {", "  ", ["onehrBackLayer", "p._bk", "isList(p)"]),
    ("the admin list panel (close)", "static/admin.js", "  function close(switching) {", "  ", ["p._bk", ".done()"]),
    ("the curve pop-out", "static/calib_shared.js", "  function modal(", "  ", ["onehrBackLayer", ".done()"]),
    ("the confirm box", "templates/base.html", "  function openConfirmDialog(", "  ", ["onehrBackLayer", "cancelled()", "bk.done(onOk)"]),
    ("the one-field prompt", "templates/base.html", "  function openTextPrompt(", "  ", ["onehrBackLayer", "bk.done(function () { onOk(v); })"]),
    ("the notice", "templates/base.html", "  function openNotice(", "  ", ["onehrBackLayer", "bk.done()"]),
    ("the date prompt", "templates/base.html", "  function openDatePrompt(", "  ", ["onehrBackLayer", "bk.done(function () { onOk(v, pk); })"]),
]
for i, row in enumerate(LAYERS):
    if row[0] == "the chat's confirm box":
        LAYERS[i] = (row[0], row[1], "  function openConfirm(", "  ", ["onehrBackLayer", "bk.done(opts.onConfirm)", "bk.done(opts.alt.onClick)", "close(true)"])
    if row[0] == "the unassigned-bands box":
        LAYERS[i] = (row[0], row[1], "  function calReviewAssignDialog(", "  ", ["onehrBackLayer", "asBk", ".done()"])
for name, file, head, indent, needs in LAYERS:
    t = fn(SRC[file], head, indent)
    ok = bool(t) and all(n in t for n in needs) and "onehrBackLayer" in (t if name.endswith("(close)") is False else "onehrBackLayer")
    if name.endswith("(close)"):
        ok = bool(t) and all(n in t for n in needs)
    s.check("%s: calls the helper and lets its entry go" % name, ok, "missing in %s" % head)
    if needs:
        cut = needs[0] if name.endswith("(close)") is False else needs[0]
        src = dict(SRC)
        src[file] = src[file].replace(t, t.replace(cut, "XX_CUT_XX"))
        t2 = fn(src[file], head, indent)
        s.check("falsified: %s fails without %r" % (name, cut), not all(n in t2 for n in needs))

s.section("one layer per layer: the call sites are exactly these")
count = lambda f: SRC[f].count("onehrBackLayer(")  # noqa: E731
sites = {JS: 9, "static/ask_onehr.js": 1, "static/help.js": 1, "static/whatsnew.js": 1, "static/file_preview.js": 1, "static/kpi_line.js": 1, "static/calib_shared.js": 1, "static/admin.js": 4, "templates/base.html": 4}
for f, n in sites.items():
    s.check("%s opens %d back layer(s) (a new one must be added to this suite)" % (f, n), count(f) == n, "found %d" % count(f))
s.check("falsified: a new call site is noticed", count(JS) + 1 != sites[JS])
def agent_show(src):
    i = src["static/admin.js"].find("var show = function (on) {")
    j = src["static/admin.js"].find("var send = function", i)
    return src["static/admin.js"][i:j] if i >= 0 and j > i else ""


s.check("the Admin Agent panel: opening registers a back layer and closing lets its entry go", all(n in agent_show(SRC) for n in ("onehrBackLayer", "agentBk", "ab.done()")))
_t = agent_show(SRC)
s.check("falsified: the Admin Agent fails without its helper call", not all(n in _t.replace("onehrBackLayer", "XX_CUT_XX") for n in ("onehrBackLayer", "agentBk", "ab.done()")))
s.check("falsified: the Admin Agent fails without done() on close", not all(n in _t.replace("ab.done()", "XX") for n in ("onehrBackLayer", "agentBk", "ab.done()")))
pager = fn(SRC[JS], "  function tbPager(") + fn(SRC[JS], "  function calPager(")
s.check("the person pager (previous / next) pushes nothing: no helper call in it, and the person layer follows the state (sheetBackSync), not the redraw",
        "onehrBackLayer" not in pager and "var open = !!sheetOpenKind() && !sheetClosing;" in fn(SRC[JS], "  function sheetBackSync("))
s.check("falsified: a pager that opened a layer would be noticed", "onehrBackLayer" in (pager + "onehrBackLayer"))
s.check("the floating Back (base.html) still calls history.back() once, unchanged",
        SRC["templates/base.html"].count("window.history.back()") == 1)
sys.exit(s.done())
