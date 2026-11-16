"""The dashboard's tables keep every column heading on one line (Chris, 2026-10-26: "can you fix the width of you
entered and the approvedRating? or can we simplify the column header so it won't wrap? check through all personas'
dashboard table").

What the browser sweep at 1280 found and what holds it:
  * this cycle's KPI table (static/dashboard.js, every persona's record): its cells had no side padding, so "You entered"
    wrapped beside a long KPI description and "Approved" ran into "Rating". Every column after the KPI keeps a 14px gap
    and its heading on one line; the KPI-targets table keeps its own spacing.
  * the BU CEO's department table: two 104px status columns left the department 63px ("Department" itself clipped). The
    status columns are 88 / 70px and a review shows the day it came in ("✓ 3 Jul", the full date on hover).
  * the BG CEO's / Group Chief's table: "Business unit · department reviews" ran into "Reviews in". The heading is the
    business unit (or batch) alone, the rest on hover.
  * the BU CEO's department learning table (where AI+ Learning is on): four headings wrapped to two lines. Shorter
    words, the full ones on hover, one line.
"""
import os
import re
import sys

import jinja2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The dashboard's table headings stay on one line")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
CSS = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
DASH = open(os.path.join(H.REPO, "templates", "dashboard.html"), encoding="utf-8").read()
JS = open(os.path.join(H.REPO, "static", "dashboard.js"), encoding="utf-8").read()

s.section("1. This cycle's KPI table")
s.check("every column after the KPI keeps a gap, the targets table keeping its own",
        ".od-kt:not(.od-kt-tg) th + th, .od-kt:not(.od-kt-tg) td + td { padding-left: 14px; }" in CSS)
s.check("...and its headings never wrap", ".od-kt th { white-space: nowrap; }" in CSS)
s.check("the headings are the ones the sweep measured",
        '["KPI", "Weight", "You entered", "Approved", "Rating"]' in JS)

s.section("2. The BU CEO's department table")
m = re.search(r"\{% macro bu_cell\(at\) -%\}.*?\{%- endmacro %\}", DASH, re.S)
s.check("one cell for a department review's state", m is not None)
if m:
    env = jinja2.Environment(autoescape=True)
    out_in = env.from_string(m.group(0) + "{{ bu_cell('3 Jul 2026') }}").render()
    out_wait = env.from_string(m.group(0) + "{{ bu_cell(None) }}").render()
    s.check("a review in shows the day, the full date on hover",
            "&check; 3 Jul</span>" in out_in and 'title="Submitted 3 Jul 2026"' in out_in and 'class="is-in"' in out_in,
            out_in)
    s.check("...one still to come says so", "to submit</span>" in out_wait and 'class="is-wait"' in out_wait, out_wait)
s.check("both department tables use it, and the long '✓ in <date>' is gone",
        DASH.count("{{ bu_cell(d['pm']) }}{{ bu_cell(d['pot']) }}") == 2 and "'✓ in ' ~" not in DASH)
s.check("its status columns are 88 and 70px (5.5 and 4.375rem), so the department keeps the room",
        "grid-template-columns: minmax(0, 1fr) 5.5rem 4.375rem;" in CSS)

s.section("3. The BG CEO's and the Group Chief's table")
hd = re.search(r'<div class="od-bu-r od-bg-r is-h" role="row">(.*?)</div>', DASH, re.S)
s.check("the first heading is the business unit or batch alone, the rest on hover",
        hd is not None and "}}\">{{ 'Batch' if G['scope'] == 'group' else 'Business unit' }}</span>" in hd.group(1)
        and "title=\"{{ 'Batch' if G['scope'] == 'group' else 'Business unit' }} &middot;" in hd.group(1),
        hd and hd.group(1))

s.section("4. The BU CEO's department learning table (AI+ Learning, dark on production)")
s.check("its headings are short enough for their columns, the full words on hover",
        all(x in DASH for x in ('title="With a Career Plan goal">With a plan goal<',
                                'title="Learning done or booked for it">Learning done or booked<',
                                'title="Hours this year">Hours<', 'title="A need with no programme">Need, no programme<')))
s.check("...and on one line", ".od-lrn-r.is-h > span { white-space: nowrap; }" in CSS
        and ".od-lrn-r.is-h > span { white-space: normal; }" not in CSS)

sys.exit(s.done())
