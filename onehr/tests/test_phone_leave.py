"""The phone's "Leave without saving?" (Chris, 8 Nov 2026: "Yes, ask first"; OneHR/Phone leave-unsaved build brief 2026-11-08.md). On a phone
(window.onehrIsPhone(), under 1024px) a band held on a leader's person page (the HOD's, the BU CEO / calibrator's), a remark typed there and not saved, or a pick
made in the BG CEO's / Group Chief's Move sheet asks first, in OneHR's own confirm box, before the layer closes by any way out. Stay changes nothing; Leave drops the
work and goes where it was going. Behaviour only: no route, no server change, nothing saved by itself.

What this suite holds (source only; each check is proved once on a source with its piece taken out, so none can pass by accident):
  * the box is the app's own confirm box (openConfirm), titled "Leave without saving?" with Stay and Leave (red), no browser confirm() / alert()
  * phone only: the person-page test begins with onPhone(); the Move sheet is phone-only; the box's CSS sits inside the phone media query
  * every way out of the person page asks: the bezel / back button / chip / folded band tile / Esc (sheetClose), the pager and a folded name (calOpenPerson,
    calGoTo), the Performance | Potential switch, the system back (sheetBackFn); every way out of the Move sheet (the x, the dim, Esc, the back) asks
  * what counts as unsaved is named: the HOD's calHeld and remark draft, the BU CEO's bar select against what it opened with and the pop-out draft, the Move
    sheet's cell, band and reason; Leave drops them
  * the system-back path never depends on a push made without a tap: the person layer's closeFn lets the entry go and never returns false, nothing registers while
    the box is open, and the layer is registered again only inside Stay's answer (a tap; by force only from the box's own popstate)
  * the helper change is only what is needed: numbered layers, and a popstate loop that never pops a layer opened by a closeFn inside it
No real names: the suite reads source files only.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Phone leave without saving: the box, every exit, the system-back path")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

MV, JS, CSS = "static/move_in.js", "static/journey_chat.js", "static/style.css"
SRC = {n: H.source(a, n) for n in (MV, JS, CSS)}


def fn(src, head, indent="  "):
    i = src.find(head)
    if i < 0:
        return ""
    m = re.search(r"\n" + indent + r"function \w+\(", src[i + len(head):])
    return src[i:i + len(head) + (m.start() if m else len(src))]


def falsify(name, test, file, cut):
    src = dict(SRC)
    src[file] = cut(src[file]) if callable(cut) else src[file].replace(cut, "XX_CUT_XX")
    ok = not test(src)
    s.check("falsified: %s fails without its piece" % name, ok, "" if ok else "still passes with the piece removed")


def check(name, test, file=None, cut=None):
    s.check(name, test(SRC))
    if file:
        falsify(name, test, file, cut)


F = lambda S, head: fn(S[JS], head)  # noqa: E731
# ---------------------------------------------------------------------------
s.section("the box is OneHR's own confirm box")
check("leaveAsk opens openConfirm: title, Stay, Leave (red); the dim and Esc are Stay (onCancel)",
      lambda S: (lambda t: 'openConfirm({ title: "Leave without saving?"' in t and 'cancelText: "Stay"' in t and 'confirmText: "Leave"' in t and "danger: true" in t
                 and "onCancel:" in t)(F(S, "  function leaveAsk(")),
      JS, 'confirmText: "Leave"')
check("openConfirm draws the red primary (is-danger) and tells Stay when it closes any way but Confirm (Cancel, Esc, the dim, the back)",
      lambda S: (lambda t: '" is-danger"' in t and "function dismissed(byBack)" in t and "opts.onCancel(!!byBack)" in t and t.count("dismissed(") >= 4)(F(S, "  function openConfirm(")),
      JS, "opts.onCancel(!!byBack)")
check("no browser confirm() or alert() in the leave code",
      lambda S: not re.search(r"(?<![\w.])(confirm|alert)\(", F(S, "  function leaveAsk(") + F(S, "  function leaveGuard(") + F(S, "  function leaveUnsavedPerson(")),
      JS, lambda t: t.replace("  function leaveAsk(o) {", "  function leaveAsk(o) { confirm('x');").replace('  function leaveAsk(line, o) {', "  function leaveAsk(line, o) { confirm('x');"))
check("the status lines are the brief's: one line, no how-to sentence",
      lambda S: '"Your band for " + r.name + " isn\'t saved."' in S[JS] and '"The move for " + p.name + " isn\'t saved."' in S[JS],
      JS, '"The move for " + p.name + " isn\'t saved."')
check("the box's buttons meet the 44px floor, inside the phone media query",
      lambda S: (lambda c: ".modal-overlay.rv-leave-box .modal-actions button { min-height: 44px;" in c and c.rfind("@media (max-width: 1023.98px) {", 0, c.find(".rv-leave-box")) > c.rfind("\n}\n", 0, c.find(".rv-leave-box")))(S[CSS]),
      CSS, "min-height: 44px; min-width: 88px;")

s.section("phone only")
check("the person page's test begins with onPhone() (a desktop width never asks)",
      lambda S: F(S, "  function leaveUnsavedPerson(").lstrip().split("\n")[1].strip().startswith("if (!onPhone() ||"),
      JS, "if (!onPhone() || sheetOpenKind() !== \"cal\"")
check("the Move sheet's test lives in the phone sheet only (tbStartMoveSheet is called only under onPhone())",
      lambda S: "if (onPhone()) { tbStartMoveSheet(p); return; }" in S[JS] and F(S, "  function tbStartMoveSheet(").count("unsaved: function") == 1,
      JS, "if (onPhone()) { tbStartMoveSheet(p); return; }")
check("a window turned to a desktop width takes the box away (no box on a desktop)",
      lambda S: 'onehrOnPhoneChange(function (p) {   // a window turned to a desktop width: no box' in S[JS] and "leaveClose" in S[JS].split("// a window turned to a desktop width: no box")[1][:400],
      JS, "if (leaveClose) { var c = leaveClose; leaveClose = null; c(); }")

s.section("every way out of the person page asks")
check("sheetClose (the bezel, the back button, the chip, a band tile in the folded column, Esc) asks first, and Leave comes back through it with leaveOk",
      lambda S: (lambda t: "leaveGuard(function () { sheetClose(why, Object.assign({}, opts, { leaveOk: true })); })" in t and "opts && opts.leaveOk" in t)(F(S, "  function sheetClose(")),
      JS, "leaveGuard(function () { sheetClose(why,")
check("the pager and a name in the folded column (calOpenPerson) ask, and Leave goes on to that person",
      lambda S: (lambda t: "leaveGuard(function () { calOpenPerson(id, focusSel, { leaveOk: true }); })" in t)(F(S, "  function calOpenPerson(")),
      JS, "leaveGuard(function () { calOpenPerson(")
check("the navigator's jump (calGoTo) asks",
      lambda S: "leaveGuard(function () { calGoTo(id); })" in F(S, "  function calGoTo("),
      JS, "leaveGuard(function () { calGoTo(id); })")
check("the Performance | Potential switch asks",
      lambda S: "leaveGuard(function () { opt.click(); })" in F(S, "  function phAxisSwitch("),
      JS, "leaveGuard(function () { opt.click(); })")
check("the system back asks from the layer's closeFn, flagged viaBack",
      lambda S: (lambda t: "leaveGuard(function () { sheetClose(\"back\", { leaveOk: true }); }, { viaBack: true })" in t)(F(S, "  function sheetBackFn(")),
      JS, "{ viaBack: true }")
check("a pick moved to the same person (calToPeople, the same id) never asks",
      lambda S: "String((cal.data.rows[cal.i] || {}).id) !== String(id)" in F(S, "  function calOpenPerson("),
      JS, "String((cal.data.rows[cal.i] || {}).id) !== String(id)\n        && leaveGuard(function () { calOpenPerson")

s.section("every way out of the Move sheet asks")
PH = lambda S: F(S, "  function phSheet(")  # noqa: E731
check("the x, the dim and Esc ask (asked(false)) before they close; the sheet's own Cancel and the code's close(true) do not",
      lambda S: (lambda t: t.count("asked(false)") >= 3 and "x.addEventListener(\"click\", function () { if (cfg.canClose && !cfg.canClose()) return; if (!asked(false)) close(); });" in t
                 and "scrim.addEventListener(\"click\"" in t and "scrim._kpiClose = function () { close(true); };" in t)(PH(S)),
      JS, "if (!asked(false)) close(); });\n    scrim.addEventListener")
check("the back asks (asked(true)) and a move being saved still refuses (return false), unchanged",
      lambda S: (lambda t: "asked(true)" in t and "return false;   // a move being saved: refuses, as before" in t)(PH(S)),
      JS, "asked(true)")
check("while the box is open the sheet's own Esc stands aside (the box's Esc is Stay)",
      lambda S: "if (leaveOpen) return;   // the leave box is up" in PH(S),
      JS, "if (leaveOpen) return;   // the leave box is up")
check("the Move sheet's unsaved test is a cell, a band or a reason typed, never while a save is in flight",
      lambda S: (lambda t: "tb.open != null && !tb.saving && (tb.tgt || tb.pick || (tb.why || \"\").trim())" in t)(F(S, "  function tbStartMoveSheet(")),
      JS, "(tb.tgt || tb.pick || (tb.why || \"\").trim())")

s.section("what counts as unsaved, and what Leave drops")
check("the person page: the HOD's held band and remark draft; the BU CEO's bar select against what it opened with, and the pop-out's draft",
      lambda S: (lambda t: "!!calHeld[r.id] || cardRmDirty(key)" in t and "bar._unsaved && bar._unsaved()" in t and "calRmkDraft[r.id] != null" in t and "if (r.adjusted) return null;" in t)(F(S, "  function leaveUnsavedPerson(")),
      JS, "!!calHeld[r.id] || cardRmDirty(key)")
check("the BU CEO bar's test: a band other than the one it opened with, and not while it is saving",
      lambda S: "bar._unsaved = function () { return !!sel.value && sel.value !== phInit && !sel.disabled; };" in S[JS],
      JS, "sel.value !== phInit && !sel.disabled; };")
check("Leave drops the held band, the typed remark and the draft",
      lambda S: (lambda t: "delete calHeld[u.id]; delete calRmkDraft[u.id];" in t and "st.draft = null;" in t)(F(S, "  function leaveDropPerson(")),
      JS, "delete calHeld[u.id]; delete calRmkDraft[u.id];")
check("a person with nothing to save (self, locked, closed, override, saved) never asks",
      lambda S: "r.is_self || cal.data.locked || cal.data.closed || r.super_override" in F(S, "  function leaveUnsavedPerson("),
      JS, "r.is_self || cal.data.locked || cal.data.closed || r.super_override")

s.section("the system-back path never depends on a push made without a tap")
check("the person layer's closeFn lets the entry go (sheetBk = null first) and never returns false",
      lambda S: (lambda t: t.lstrip().split("\n")[1].strip().startswith("sheetBk = null;") and "return false" not in t)(F(S, "  function sheetBackFn(")),
      JS, "    sheetBk = null;   // the helper has taken the entry: the back is spent\n")
check("nothing registers while the box is open (sheetBkHold), so a redraw cannot push an entry without a tap",
      lambda S: "if (sheetBkHold) return;" in F(S, "  function sheetBackSync(") and "sheetBkHold = true;" in F(S, "  function leaveGuard("),
      JS, "if (sheetBkHold) return;")
check("the person layer is registered again only in Stay's answer (sheetBackSync(true) appears once, in onStay)",
      lambda S: S[JS].count("sheetBackSync(true)") == 1 and "onStay: function () { sheetBkHold = false; if (!sheetBk) sheetBackSync(true); }" in F(S, "  function leaveGuard("),
      JS, "if (!sheetBk) sheetBackSync(true);")
check("Leave on the back path closes with no entry to drop (sheetClose runs with sheetBk already null)",
      lambda S: "onLeave: function () { sheetBkHold = false; leaveDropPerson(u); go(); }" in F(S, "  function leaveGuard("),
      JS, "leaveDropPerson(u); go();")
check("the Move sheet re-arms only in Stay (arm(true)) or at the sheet's next tap (arm(false)); the back's own entry is never re-pushed from the helper",
      lambda S: (lambda t: t.count("arm(true)") == 1 and "onStay: function () { if (!done && !armed) arm(true); }" in t and "pointerdown" in t and "armed = false;   // the helper has taken the entry" in t)(PH(S)),
      JS, "if (!done && !armed) arm(true);")
check("a second back while the box is open is the box's Cancel (its own forced entry, backForce), so it is Stay and never leaves the check-in",
      lambda S: "backForce: !!o.viaBack" in F(S, "  function leaveAsk(") and "opts.backForce ? { force: true } : undefined" in F(S, "  function openConfirm("),
      JS, "backForce: !!o.viaBack")

s.section("the helper: only what is needed")
H_ = lambda S: S[MV][S[MV].find("THE PHONE BACK GESTURE"):]  # noqa: E731
check("layers are numbered and the popstate loop never pops a layer opened inside it (the box opened by a closeFn)",
      lambda S: "seq: ++seq" in H_(S) and "stack[stack.length - 1].seq <= born" in H_(S) and "born = seq" in H_(S),
      MV, "stack[stack.length - 1].seq <= born")
check("force pushes without a tap and is used only by the leave box and the re-arming (three call sites in journey_chat.js)",
      lambda S: "!L.force" in H_(S) and S[JS].count("{ force: true }") == 3,
      JS, lambda t: t.replace("{ force: true }", "{ force: false }", 1))
check("no server change: the leave code names no route",
      lambda S: not re.search(r'"/(review|talent-box)[^"]*"', F(S, "  function leaveAsk(") + F(S, "  function leaveGuard(") + F(S, "  function leaveDropPerson(")),
      JS, lambda t: t.replace("  function leaveDropPerson(u) {", '  function leaveDropPerson(u) { var z = "/review/x";'))
sys.exit(s.done())
