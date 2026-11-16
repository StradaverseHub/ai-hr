"""The competency and 360 cards turn their own page (Chris, 2026-10-17: "go with D turn the page automatically ... only
on first time. If an user chooses to go back to previous page to edit, then after editing, it shouldn't auto move on. In
short, it only auto switches to next page after user fills a blank page").

Client-only behaviour, so these read static/journey_chat.js (as test_competency_agent does) for the rule's every guard:
arrival decided in the card's render, a page that was blank on arrival and is now full turns a beat later, never the last
page, never once they've paged or gone back, and the note with its Go back. The browser QC of 2026-10-17 drove it."""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The cards turn their own page, once, after a blank page is filled")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
JS = open(os.path.join(ROOT, "static", "journey_chat.js"), encoding="utf-8").read()
CSS = open(os.path.join(ROOT, "static", "style.css"), encoding="utf-8").read()


def fn(name):
    i = JS.find("function %s(" % name)
    return JS[i:JS.find("\n  }\n", i)] if i >= 0 else ""


arrive, later, cancel, note = fn("turnArrive"), fn("turnLater"), fn("turnCancel"), fn("turnNoteEl")
tcw, fbw, tcp, fbp = fn("tcWidget"), fn("fbWidget"), fn("tcPage"), fn("fbPage")
s.check("the four helpers are there", all([arrive, later, cancel, note, tcw, fbw, tcp, fbp]))
s.check("arrival is set only when the page CHANGES (a re-render on the same page keeps what it was on arrival)",
        "if (st.arrived !== at) { st.arrived = at; st.arrivedBlank = blank; }" in arrive)
s.check("the turn waits a beat (TURN_MS) and re-checks before it moves",
        "var TURN_MS = 650;" in JS and "setTimeout(function () { st.turnT = null; if (ok()) go(); }, TURN_MS);" in later)
s.check("cancel drops the waiting turn and the note", "clearTimeout(st.turnT)" in cancel and "st.turnNote = null" in cancel)
s.check("the note names both pages and offers Go back, announced (role=status)",
        '(note.plural ? " are" : " is") + " done. Moved you on to "' in note and 'b.textContent = "Go back"' in note
        and '"role", "status"' in note)

# --- the competency card
s.check("competency: a page is blank on arrival when no item has an answer, saved or ticked",
        "var tcAns = function (x) { return (x.assignment_id in tc.pending) ? tc.pending[x.assignment_id] : x.answer; };" in tcw
        and "turnArrive(tc, tc.section, !(g.items || []).some(tcAnswered));" in tcw)
s.check("competency: it turns only if editable, blank on arrival, not the last page, and the page is now full",
        "if (!editable || !tc.arrivedBlank || from >= groups.length - 1 || !tcFull(from)) return;" in tcw)
s.check("competency: a beat later it still has to be the same card, stage and page, still full, nothing saving",
        'tc.data === data && curStage === "competency" && tc.section === from && tc.arrivedBlank && tcFull(from) && !busy'
        in tcw)
s.check("competency: the move sets the note and goes to the next page",
        "tc.turnNote = { from: from, to: from + 1, fromName: groups[from].title, toName: groups[from + 1].title };"
        in tcw and "tc.section = from + 1;" in tcw)
s.check("competency: every tick re-checks after the re-render; Go back returns to the page it came from",
        re.search(r"tc\.turnNote = null;[^\n]*\n\s*swapStageBody\(tcWidget\(tc\.data\)\);[^\n]*\n\s*tcMaybeTurn\(\);", tcw)
        is not None and "turnCancel(tc); tc.section = tcNote.from;" in tcw)
s.check("competency: paging by hand cancels a waiting turn", "turnCancel(tc);" in tcp)

# --- the 360 card
s.check("360: a page (two principles since 2026-10-22) is FOR ONE colleague (the arrival key carries the colleague)",
        'turnArrive(fb, fb.subject + ":" + fb.section, !pageSts(fb.section).some(fbAnswered));' in fbw)
s.check("360: it turns only if not submitted, blank on arrival, not the last principle, and now full",
        "if (submitted || !fb.arrivedBlank || from >= nPages - 1 || !fbFull(from)) return;" in fbw)
s.check("360: a beat later it has to be the same colleague and principle, still full, nothing saving",
        'fb.data === data && curStage === "feedback" && fb.subject === who && fb.section === from' in fbw
        and "&& fb.arrivedBlank && fbFull(from) && !busy" in fbw)
s.check("360: a note from another colleague never shows",
        "if (fb.turnNote && (fb.turnNote.subject !== fb.subject || fb.turnNote.to !== fb.section)) fb.turnNote = null;" in fbw)
s.check("360: every tick re-checks; Go back returns; paging by hand cancels",
        re.search(r"fb\.turnNote = null;[^\n]*\n\s*swapStageBody\(fbWidget\(fb\.data\)\);[^\n]*\n\s*fbMaybeTurn\(\);", fbw)
        is not None and "turnCancel(fb); fb.section = fbNote.from;" in fbw and "turnCancel(fb);" in fbp)

nqw, swap = fn("nqWant"), fn("swapStageBody")
s.check("the queue panel's On screen follows the CARD's competency page, not the conversation's focus (Chris, "
        "2026-10-17: 'fix the on screen panel to follow the card'), and every card redraw asks for it",
        "var tcg = tcPages(tc.data)[tc.section];" in nqw and 'return tcg ? tcg.key' in nqw
        and "nqSync();" in swap)
live, swapc = fn("nqLive"), fn("swapChrome")
s.check("the counts follow the card's ticks (Chris, 2026-10-17: 'doesn't seem to sync between the card answer and the on "
        "screen panel'): recounted after every card redraw and every panel / tab redraw",
        "nqLive();   // ...and its counts, the card's ticks included" in swap and "nqLive();   // a redrawn panel" in swapc)
s.check("...competency: saved or ticked, in the panel's 'N of M answered', each competency's 'N left', the bar and its key, "
        "the TM tab's N/M and Rate ring, the banner",
        "function tcAnswerOf(x) { return (x.assignment_id in tc.pending) ? tc.pending[x.assignment_id] : x.answer; }" in JS
        and 'pg.textContent = L.ans + " of " + L.tot + " answered";' in live
        and 'return p.t - p.n ? (p.t - p.n) + " left" : "All answered";' in live
        and 'sg.classList.toggle("is-done", p.n === p.t);' in live and "nqKeyCounts(nav);" in live
        and '.rv-mt-part[data-stage="competency"] .rv-mt-part-n' in live and 'ring.closest(".rv-mt-done")' in live)
s.check("...360: the colleague on screen's 'N of M' and bar, and the banner's (N/M); the card's own header counts ticks",
        "var c = (x.statement_id in fb.pending) ? fb.pending[x.statement_id] : x.answer;" in JS
        and 'mt2.textContent.replace(/\\d+ of \\d+$/, F.n + " of " + F.t)' in live
        and 'head.textContent = "Competencies — " + liveAns + " of " + (data.total || 0) + " answered";' in tcw)
s.check("the note's style: navy, one line, its own Go back", ".rv-turn-note {" in CSS and ".rv-turn-back {" in CSS
        and H.cv("background: var(--navy)") in CSS[CSS.find(".rv-turn-note {"):CSS.find(".rv-turn-note {") + 400])

sys.exit(s.done())
