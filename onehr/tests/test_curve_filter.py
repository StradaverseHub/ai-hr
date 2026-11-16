"""The BU CEO's curve as a filter -- 2026-10-22, Chris.

  "for BUCEO calibration, can we make the bar and the label UA, BE, ME clickable and acts as filter? similar like HOD
   filter, click once to select, click again to deselect. The filter worked by the highest rank that gives the final
   band, e.g. if the BUCEO already saved the band, then the filter works on it, if not, goes by HOD -> LM -> self, in
   that order. for not final classify them under UA"

What it holds:
  * the key a person is filtered by is the band the curve counts them in (current_band: this BU CEO's saved move, else
    the HOD's, the line manager's, their own), and someone with no band at all falls in the lowest band (UA / Low), so
    a band's rows are its bar's count;
  * a band's row (label and bar) is a button: one click picks it, a click on the lit one clears it, Enter too; a band
    nobody sits in is not a button;
  * only the BU CEO's card gets it (not the HOD's review, which has its tally boxes), the roster narrows and the curve
    never does, and a new scope or part starts on everyone.
"""
import json as _json
import os
import subprocess as _sp
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The BU CEO's curve as a filter: a band's row picks its people, a second click shows everyone")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
JS = H.chat_js(a)
CSS = open(os.path.join(ROOT, "static", "style.css"), encoding="utf-8").read()


def fn(name):
    i = JS.find("function %s(" % name)
    return JS[i:JS.find("\n  }\n", i) + 4] if i >= 0 else ""


def node(src):
    o = _sp.run(["node", "-e", src], capture_output=True, text=True)
    return _json.loads(o.stdout) if o.returncode == 0 and o.stdout.strip() else ("err", (o.stderr or o.stdout)[:300])


PM = {"band_order": ["UA", "BE", "ME", "AE", "OU"]}
POT = {"band_order": ["Low", "Mid", "High"]}

# --------------------------------------------------------------------------- the key
s.section("a person's band on the curve is the key (BU CEO > HOD > LM > self, as current_band); no band = the lowest")
_key = fn("calCurveKey")
s.check("calCurveKey is there", bool(_key))
rows = [{"id": 1, "current_band": "ME"}, {"id": 2, "current_band": "BE"}, {"id": 3, "current_band": None},
        {"id": 4, "current_band": ""}, {"id": 5, "current_band": "OU"}, {"id": 6, "current_band": "ZZ"}]
got = node(_key + "\nconsole.log(JSON.stringify(%s.map(function (r) { return calCurveKey(%s, r); })));"
           % (_json.dumps(rows), _json.dumps(PM)))
s.check("a band they resolve to is their key; none (or one off the order) counts in UA", got
        == ["ME", "BE", "UA", "UA", "OU", "UA"], got)
got = node(_key + "\nconsole.log(JSON.stringify([calCurveKey(%s, {current_band: 'High'}), calCurveKey(%s, {})]));"
           % (_json.dumps(POT), _json.dumps(POT)))
s.check("on potential: their band, or Low with none", got == ["High", "Low"], got)
# the curve's own count, independently: pm_band_distribution counts current_band, so a band's filter shows its bar
srv = [{"current_band": r["current_band"] or None} for r in rows if r["current_band"] in PM["band_order"] + [None, ""]]
dist = a.pm_band_distribution([r for r in srv if r["current_band"]])
keys = node(_key + "\nconsole.log(JSON.stringify(%s.map(function (r) { return calCurveKey(%s, r); })));"
            % (_json.dumps(srv), _json.dumps(PM)))
nobody = sum(1 for r in srv if not r["current_band"])
s.check("each band's filter shows its bar's count; only people with no band at all join UA",
        isinstance(keys, list) and all(keys.count(b) == dist[b] + (nobody if b == "UA" else 0) for b in PM["band_order"]),
        (keys, dist))

# --------------------------------------------------------------------------- the button
s.section("a band's row is a button: one click picks it, a click on the lit one clears it")
_pick = fn("calPickRow")
s.check("calPickRow is there", bool(_pick))
STUB = ("function el() { var a = {}, cls = {}, ev = {}; return { attrs: a, ev: ev, tabIndex: -1, title: '',"
        " classList: { add: function (c) { cls[c] = 1; }, contains: function (c) { return !!cls[c]; } },"
        " setAttribute: function (k, v) { a[k] = String(v); }, getAttribute: function (k) { return a[k]; },"
        " addEventListener: function (t, f) { ev[t] = f; }, cls: cls }; }\n")


def pick_row(code, n, picked):
    return node(STUB + _pick + """
var got = [], row = el();
calPickRow(row, %s, %d, "Label", { picked: %s, pick: function (k) { got.push(k); } });
var out = { role: row.attrs.role || null, pressed: row.attrs["aria-pressed"] || null, on: row.classList.contains("is-on"),
            empty: row.classList.contains("is-empty"), tab: row.tabIndex, code: row.attrs["data-code"] };
if (row.ev.click) row.ev.click();
if (row.ev.keydown) { row.ev.keydown({ key: "Enter", preventDefault: function () {} });
                      row.ev.keydown({ key: "a", preventDefault: function () {} }); }
out.picks = got; console.log(JSON.stringify(out));""" % (_json.dumps(code), n, _json.dumps(picked)))


r1 = pick_row("ME", 40, "")
s.check("a band with people: a button, not pressed; a click (or Enter) picks it, another key does nothing",
        isinstance(r1, dict) and r1["role"] == "button" and r1["pressed"] == "false" and r1["tab"] == 0
        and r1["code"] == "ME" and r1["picks"] == ["ME", "ME"], r1)
r2 = pick_row("ME", 40, "ME")
s.check("the lit band: pressed, and a click clears the filter (\"click again to deselect\")",
        isinstance(r2, dict) and r2["on"] and r2["pressed"] == "true" and r2["picks"] == ["", ""], r2)
r3 = pick_row("OU", 0, "ME")
s.check("a band nobody sits in isn't a button", isinstance(r3, dict) and r3["role"] is None and r3["empty"]
        and r3["picks"] == [], r3)
r4 = pick_row("UA", 0, "UA")
s.check("...unless it is the one picked, so it can always be cleared", isinstance(r4, dict) and r4["role"] == "button"
        and r4["picks"] == ["", ""], r4)

# --------------------------------------------------------------------------- where it applies
s.section("the BU CEO's card only; the roster narrows, the curve never does; a new scope starts on everyone")
_w = fn("calibWidget")
s.check("the BU CEO's card hands the curve its picker; the HOD's review doesn't get one",
        'var pickOn = d.tier === "buceo" && !d.review;' in _w and "pick: pickOn ?" in _w and "cf.band = k;" in _w
        and "picked: pickOn ? cf.band" in _w)
_f = fn("calFiltered")
s.check("the roster narrows to the band's people, through the same key",
        '(!cf.band || calCurveKey(d, r) === cf.band)' in _f)
_dist_part = _f[_f.find("if (cf.dept.length || cf.unit || cf.jg.length || calXPicked(d))"):]
s.check("...while the curve's own counts never read the band filter", "cf.band" not in _dist_part)
s.check("the band filter turns the BU CEO's filters on, and resets with them on a new scope or part",
        "cf.band || calXPicked(d)));" in fn("calFilterOn") and 'cf.jg = []; cf.cc = []; cf.branch = []; cf.band = "";' in JS)
_box = fn("calibDistBox")
s.check("the curve box makes each band's row the button and says what is showing and the way back",
        "if (opts && opts.pick) calPickRow(row, b, n, labels[b] || b, opts);" in _box
        and "Click it again to show everyone." in _box)
s.check("the lit row takes its band's colour, the others fade, and the row keeps its size (padding paid back by "
        "the margin)", '.calib-dist-row.is-on[data-code="UA"]' in CSS and '.calib-dist-row.is-on[data-code="High"]' in CSS
        and ".rv-calib-dist.has-pick .calib-dist-row.is-filter:not(.is-on) { opacity: .5; }" in CSS
        and ".rv-calib-pin .rv-calib-dist .calib-dist-row.is-filter { margin: 1px -6px; padding: 2px 6px;" in CSS)

s.section("Help knows it (the workspace rule of 2026-10-22: a new feature reaches Help's quick answers)")
_qa = (a.HELP_QA.get("bu_dept") or ("", ""))
s.check("the BU CEO's answer says a band on the curve shows its people and a second click shows everyone",
        "one band" in _qa[0] and "Click a band on the curve" in _qa[1] and "click it again" in _qa[1])
s.check("...on both of the BU CEO's lists, the performance curve and the potential curve, five each",
        all("bu_dept" in a.HELP_LISTS[k][1] and len(a.HELP_LISTS[k][1]) <= 5 for k in ("bu_perf", "bu_pot")))
s.check("the lock's own answer still says who can undo it", "super admin can unlock" in a.HELP_QA["bu_lock"][1])

sys.exit(s.done())
