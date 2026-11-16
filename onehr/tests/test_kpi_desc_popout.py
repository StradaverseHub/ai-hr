"""A KPI description's "Read all" pop-out (Chris, 2026-10-29, canvas [design canvas link removed]).

What this suite holds:
  * static/kpi_line.js: a clamped description with a real "Read all" button only when the text is cut (measured, with a
    ResizeObserver), a pop-out in OneHR's own dialog classes (aria-modal, Escape, focus back), every word of the
    description through textContent
  * static/style.css: the [hidden] rule for the button (a display rule beats [hidden]) and the dialog's measures
  * parseRatings, run under node over every format found in the Year-End lines, with its edge cases
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A KPI description's Read all pop-out")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
JS = os.path.join(H.REPO, "static", "kpi_line.js")
kl = open(JS, encoding="utf-8").read()
css = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()

s.section("the helper")
s.check("a real Read all button, hidden until the text is cut",
        'className = "kpi-desc-more"' in kl and 'b.type = "button"' in kl and '"Read all"' in kl and "b.hidden = !cut" in kl)
s.check("cut is measured (scrollHeight > clientHeight + 1) and watched with a ResizeObserver",
        "d.scrollHeight > d.clientHeight + 1" in kl and "ResizeObserver" in kl)
s.check("the text itself opens it only when cut; the clamped description is not a tab stop (only the pop-out's body is)",
        'd.classList.contains("is-cut")' in kl and kl.count("tabindex") == 1 and 'setAttribute("tabindex", "0")' in kl)
s.check("desc() returns one wrapper holding the clamped text (its classes kept) and the button",
        'wrap.className = "kpi-desc-wrap"' in kl and '(cls || "rv-kpi-desc") + " kpi-desc"' in kl
        and "wrap.appendChild(d); wrap.appendChild(b)" in kl)
s.check("the pop-out: dialog classes, aria-modal, labelled, Escape, overlay click, focus out and back",
        "window.onehrKpiLine" in kl and "open: function (l, fromEl)" in kl and "modal-overlay confirm-dialog kpi-dlg" in kl
        and '"aria-modal", "true"' in kl and '"aria-labelledby"' in kl and 'e.key === "Escape"' in kl
        and "e.target === ov" in kl and "x.focus()" in kl and "fromEl.focus()" in kl and 'setAttribute("aria-label", "Close")' in kl)
s.check("three parts: a fixed head (x, eyebrow, title, meta), a scrolling body, a fixed foot holding the Close actions",
        'el("div", "kpi-dlg-head")' in kl and 'el("div", "kpi-dlg-body")' in kl and 'el("div", "kpi-dlg-foot")' in kl
        and "head.appendChild(x)" in kl and 'head.appendChild(el("p", "kpi-dlg-eyebrow"' in kl and "head.appendChild(h)" in kl
        and 'head.appendChild(el("p", "kpi-dlg-meta"' in kl and "foot.appendChild(acts)" in kl
        and "card.appendChild(head); card.appendChild(body); card.appendChild(foot)" in kl
        and 'body.appendChild(el("p", "kpi-dlg-label"' in kl and "body.appendChild(ol)" in kl
        and 'body.appendChild(el("p", "kpi-dlg-para"' in kl
        and 'if (pr.intro) body.appendChild(el("p", "kpi-dlg-intro"' in kl)
s.check("the body is a keyboard-scrollable region (tabindex 0, role region, label Description); tab trap still x -> Close",
        'body.setAttribute("role", "region")' in kl and 'body.setAttribute("aria-label", "Description")' in kl
        and "if (e.shiftKey && a === x)" in kl and "else if (!e.shiftKey && a === cb)" in kl)
s.check("the page behind is locked: documentElement overflow saved, set hidden on open, restored in the one close path",
        'savedOverflow = root.style.overflow; root.style.overflow = "hidden"' in kl
        and kl.count("root.style.overflow = savedOverflow") == 1
        and kl.index("root.style.overflow = savedOverflow") > kl.index("var close = function"))
s.check("edge lines: scroll listener and ResizeObserver toggle is-top-shadow / is-bottom-shadow; observer disconnected on close",
        'toggle("is-top-shadow", body.scrollTop > 0)' in kl and 'toggle("is-bottom-shadow", body.scrollTop + body.clientHeight < body.scrollHeight - 1)' in kl
        and 'body.addEventListener("scroll", edges)' in kl and "new ResizeObserver(edges)" in kl and "ro.disconnect()" in kl
        and kl.index("ro.disconnect()") > kl.index("var close = function"))
s.check("one dialog at a time", 'document.querySelector(".kpi-dlg")' in kl)
s.check("a dialog already open closes through its own close (so the page's overflow is put back before the new one saves it)",
        "if (old && old._kpiClose) old._kpiClose();" in kl and "ov._kpiClose = close;" in kl
        and kl.index("old._kpiClose()") < kl.index("savedOverflow = root.style.overflow"))
s.check("the description goes in through textContent only (no innerHTML, no confirm / alert)",
        "innerHTML" not in kl and "insertAdjacentHTML" not in kl and "textContent" in kl and "confirm(" not in kl
        and "alert(" not in kl and "outerHTML" not in kl)

s.section("the styles")
s.check("a display rule beats [hidden]: the button has its own", ".kpi-desc-more[hidden] { display: none; }" in css)
# a submitted check-in is a locked snapshot whose card turns pointer events off (.rv-stage-snapshot): reading stays open
s.check("Read all and the cut text take clicks inside a locked or record card",
        ".kpi-desc-more, .kpi-desc.is-cut { pointer-events: auto; }" in css
        and ".rv-stage-snapshot { width: 80%; opacity: 0.5; filter: grayscale(1); pointer-events: none;" in css)
s.check("the old in-place toggle is gone", ".kpi-desc.is-open" not in css)
s.check("the dialog: 560 wide, a column that does not scroll itself, close button top right",
        ".kpi-dlg .modal-card { width: 100%; max-width: 560px; max-height: calc(100vh - 96px); max-height: calc(100dvh - 96px); position: relative;\n"
        "  display: flex; flex-direction: column; overflow: hidden; padding: 0; }" in css
        and ".kpi-dlg-x { position: absolute; top: 14px; right: 14px; width: 32px; height: 32px;" in css)
s.check("room around the box: this overlay only, 48px top and bottom, 16px sides, safe-area aware",
        ".modal-overlay.kpi-dlg { padding: 48px 16px; padding: max(48px, env(safe-area-inset-top))" in css
        and "env(safe-area-inset-bottom)" in css and "env(safe-area-inset-left)" in css)
s.check("head, body and foot measures; the body is the only scroller (thin, contained)",
        ".kpi-dlg-head { position: relative; flex: 0 0 auto; padding: 24px 28px 14px;" in css
        and "flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 2px 28px 18px;" in css
        and "scrollbar-width: thin;" in css and ".kpi-dlg-foot { flex: 0 0 auto; padding: 14px 28px 20px;" in css
        and ".kpi-dlg-foot .modal-actions { margin-top: 0; }" in css)
s.check("the hairlines show only with their classes (#eef0f5)",
        H.cv(".kpi-dlg .modal-card.is-top-shadow .kpi-dlg-head { border-bottom-color: #eef0f5; }") in css
        and H.cv(".kpi-dlg .modal-card.is-bottom-shadow .kpi-dlg-foot { border-top-color: #eef0f5; }") in css)
mh = css.index("@media (max-height: 640px) {\n  .modal-overlay.kpi-dlg")
s.check("short screens: overlay 16px, card max-height calc(100dvh - 32px) with a vh fallback",
        "padding: 16px; }" in css[mh:mh + 400] and "max-height: calc(100vh - 32px); max-height: calc(100dvh - 32px);" in css[mh:mh + 400])
mw = css.index("@media (max-width: 600px) {\n  .modal-overlay.kpi-dlg")
s.check("phones: 12px sides, 18px inner sides, a rating's chip stacks above its text (beats the li rule)",
        "padding-left: 12px; padding-right: 12px;" in css[mw:mw + 900] and css[mw:mw + 900].count("padding-left: 18px; padding-right: 18px;") == 3
        and ".kpi-dlg .kpi-dlg-rates li { flex-direction: column; gap: 6px; align-items: flex-start; }" in css[mw:mw + 900])
s.check("`.modal-card p` is beaten by `.modal-card p.kpi-dlg-...` selectors",
        all((".modal-card p.kpi-dlg-%s" % k) in css for k in ("eyebrow", "meta", "intro", "label", "para")))

s.section("parseRatings under node")
shim = ("var window = {}; var document = undefined; " + kl + "\n"
        "var cases = JSON.parse(process.argv[1]);\n"
        "console.log(JSON.stringify(cases.map(function (t) { return window.onehrKpiLine.parseRatings(t); })));\n")


def run(texts):
    out = subprocess.run(["node", "-e", shim, json.dumps(texts)], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def R(n, text, target=False):
    return {"n": n, "text": text, "target": target}


CASES = [
    ("no markers", "Keep every site tidy.", {"intro": "Keep every site tidy.", "ratings": None}),
    ("one marker only", "Goal. Rating 3: ninety percent", {"intro": "Goal. Rating 3: ninety percent", "ratings": None}),
    ("a range is not a marker", "Rating 4 = 3 - 5 Days", {"intro": "Rating 4 = 3 - 5 Days", "ratings": None}),
    ("a range inside a rating", "Rating 5 = 1 - 2 Days Rating 4 = 3 - 5 Days",
     {"intro": "", "ratings": [R(5, "1 - 2 Days"), R(4, "3 - 5 Days")]}),
    ("bullets and a label", "Rating Scale: • Rating 5 = ≤ 2 days • Rating 4 = 3 - 5 Days • Rating 3 = 6 days",
     {"intro": "", "ratings": [R(5, "≤ 2 days"), R(4, "3 - 5 Days"), R(3, "6 days")]}),
    ("an intro before a label", "Close tenders on time.\nRatings:- R1 - more than 5 days R2 - within 4 to 5 days",
     {"intro": "Close tenders on time.", "ratings": [R(1, "More than 5 days"), R(2, "Within 4 to 5 days")]}),
    ("R1 - R2 -", "R1 - more than 5 days R2 - within 4 to 5 days",
     {"intro": "", "ratings": [R(1, "More than 5 days"), R(2, "Within 4 to 5 days")]}),
    ("(1) (2)", "Score it. (1) late (2) on time (3) early",
     {"intro": "Score it.", "ratings": [R(1, "Late"), R(2, "On time"), R(3, "Early")]}),
    ("rate 3 (Target):", "rate 1: <85% rate 2: 85% - 89% rate 3 (Target): 90% – 94% rate 4: 95%",
     {"intro": "", "ratings": [R(1, "<85%"), R(2, "85% - 89%"), R(3, "90% – 94%", True), R(4, "95%")]}),
    ("line breaks between ratings", "Fix defects\nRating 1: slow\nRating 2: fine\n\nRating 3: quick",
     {"intro": "Fix defects", "ratings": [R(1, "Slow"), R(2, "Fine"), R(3, "Quick")]}),
    ("PR1 and Rate 5% are not markers", "PR1 - budget. Rate 5% growth, R2 - kept",
     {"intro": "PR1 - budget. Rate 5% growth, R2 - kept", "ratings": None}),
    ("duplicates stay, order as written", "Rating 3: a; Rating 3: b; Rating 1: c;",
     {"intro": "", "ratings": [R(3, "A"), R(3, "B"), R(1, "C")]}),
    ("case-insensitive", "RATING 1: low RATE 2 = high",
     {"intro": "", "ratings": [R(1, "Low"), R(2, "High")]}),
]
got = run([c[1] for c in CASES])
for (label, _t, want), have in zip(CASES, got):
    s.check("parseRatings: %s" % label, have == want, {"got": have, "want": want})

s.section("falsify: break the marker and the cases fail")
broken = kl.replace("(?:Rating|Rate|R)\\s*([1-5])", "(?:Rating)\\s*([1-5])", 1)
s.check("the regex was really changed for the check", broken != kl)
shim_b = shim.replace(kl, broken)
out = subprocess.run(["node", "-e", shim_b, json.dumps([c[1] for c in CASES])], capture_output=True, text=True, timeout=60)
got_b = json.loads(out.stdout)
failing = [c[0] for c, h in zip(CASES, got_b) if h != c[2]]
s.check("...R1 / rate 1 cases no longer match", {"R1 - R2 -", "rate 3 (Target):"} <= set(failing), failing)
broken2 = kl.replace("hits.length < 2", "hits.length < 1", 1)
out = subprocess.run(["node", "-e", shim.replace(kl, broken2), json.dumps([c[1] for c in CASES])], capture_output=True, text=True, timeout=60)
failing2 = [c[0] for c, h in zip(CASES, json.loads(out.stdout)) if h != c[2]]
s.check("...a single marker would no longer give null", "one marker only" in failing2, failing2)

sys.exit(s.done())
