"""Date picker (2026-10-28): static/datepicker.js replaces the browser's date box on every date field.

What this suite holds:
  * base.html serves datepicker.js and carries today's date in MYT (body data-today), never the browser's
  * the audit log wraps its two date inputs in data-odp-range, both still named date_from / date_to, and the filter
    still filters (a range that excludes everything returns no rows; the same page without it returns some)
  * every date input in a template still has its name (the form posts what it always posted)
  * the script writes the value and fires input + change; the hidden box stays in the DOM
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
assert "onehr-tests" in a.DB_PATH
s = H.Suite("The date picker: served, MYT today, audit-log range, fields keep their names")
ROOT = H.REPO


def read(rel):
    return open(os.path.join(ROOT, rel), encoding="utf-8").read()


su, _bg, _emp = H.actors(a)
c = H.client_as(a, su["id"])

s.section("base.html")
r = c.get("/admin/audit-log")
body = r.get_data(as_text=True)
s.check("the audit log renders", r.status_code == 200, r.status_code)
s.check("datepicker.js is served on the page", "static/datepicker.js" in body)
today = a._today_myt().isoformat()
s.check("<body> carries today's date in MYT", 'data-today="%s"' % today in body)
js = c.get("/static/datepicker.js")
s.check("the script itself is served", js.status_code == 200 and b"OneHRDate" in js.data)
s.check("...and reads today from data-today, not only the clock", b"data-today" in js.data)
s.check("an opt-out exists (data-native-date)", b"data-native-date" in js.data)

s.section("audit log range")
s.check("the two inputs sit in one data-odp-range wrapper",
        bool(re.search(r"data-odp-range[^>]*>\s*<input type=\"date\" name=\"date_from\".*?<input type=\"date\" name=\"date_to\"", body, re.S)))
s.check("max is today on both", body.count('max="%s"' % today) >= 2)
s.check("one accessible name, 'Dates', replaces From and To, with no visible caption",
        'aria-label="Dates"' in body and 'data-odp-label="Dates"' in body and ">Dates<" not in body.replace("\n", "").replace(" ", "")
        and ">From<" not in body.replace("\n", ""))
none = c.get("/admin/audit-log?date_from=1999-01-01&date_to=1999-01-02").get_data(as_text=True)
wide = c.get("/admin/audit-log?date_from=1999-01-01&date_to=%s" % today).get_data(as_text=True)
m_none = re.search(r"<strong>([\d,]+)</strong> (?:action|actions) match", none)
m_wide = re.search(r"<strong>([\d,]+)</strong> (?:action|actions) match", wide)
s.check("a range that excludes everything matches 0 actions", bool(m_none) and m_none.group(1) == "0", m_none and m_none.group(1))
s.check("a range that includes today matches some (the guard is not vacuous)",
        bool(m_wide) and int(m_wide.group(1).replace(",", "")) > 0, m_wide and m_wide.group(1))
s.check("the typed range comes back in the picker's inputs", 'value="1999-01-01"' in none and 'value="1999-01-02"' in none)

s.section("every date input keeps its name")
bad, count = [], 0
for dirpath, _d, files in os.walk(os.path.join(ROOT, "templates")):
    for f in files:
        if not f.endswith(".html") or f == "base.html":   # base.html only mentions the tag in a comment
            continue
        src = read(os.path.relpath(os.path.join(dirpath, f), ROOT))
        for m in re.finditer(r"<input\b[^>]*type=\"(?:date|datetime-local)\"[^>]*>", src):
            count += 1
            if not re.search(r"\bname=\"", m.group(0)) and "idp-field" not in m.group(0) and "idp-mgr-field" not in m.group(0):
                bad.append("%s: %s" % (f, m.group(0)[:80]))
s.check("%d date inputs found, each named (or an autosave field)" % count, count >= 40 and not bad, bad)

s.section("script behaviour")
s.check("it writes the value and fires input and change, bubbling",
        b"new Event('input', { bubbles: true })" in js.data and b"new Event('change', { bubbles: true })" in js.data)
s.check("the native input stays in the DOM (hidden by class, not removed)", b"odp-native" in js.data and b"removeChild(inp" not in js.data)
s.check("required + empty is handled on the hidden input ('invalid')", b"'invalid'" in js.data)
css = read("static/style.css")
s.check("the .odp- block is in style.css, popover above the modals (z-index 1100)", ".odp-pop" in css and "z-index: 1100" in css)
s.check("no browser alert()/confirm() in the picker", b"alert(" not in js.data and b"confirm(" not in js.data)

s.section("selected day vs time selects (2026-11-09), default time")
jsrc = read("static/datepicker.js")
s.check("no <select> in datepicker.js carries odp-sel; the time selects are odp-tsel",
        not re.search(r"<select[^>]*odp-sel", jsrc) and len(re.findall(r"<select class=\"odp-tsel\"", jsrc)) == 2)
s.check("the selected day still gets odp-sel", "cls += ' odp-sel'" in jsrc)
s.check("CSS has a .odp-tsel rule", re.search(r"^\.odp-tsel \{", css, re.M) is not None)
bare = [m.group(0)[:60] for m in re.finditer(r"^\.odp-sel\s*[,{][^}]*", css, re.M) if re.search(r"width|padding", m.group(0))]
s.check("no bare .odp-sel rule sets width or padding (it would reshape the selected day)", not bare, bare)
s.check("datepicker.js reads data-odp-time and validates hours 0-23 / minutes 0-59",
        "data-odp-time" in jsrc and "+m[1] > 23" in jsrc and "+m[2] > 59" in jsrc)
s.check("the minute list takes the default's minute (mlist.push(st.mm))", "mlist.push(st.mm)" in jsrc)
pp = read("templates/person/_overview.html")
for nm in ("until", "lm_until"):
    m = re.search(r"<input[^>]*type=\"datetime-local\"[^>]*name=\"%s\"[^>]*>" % nm, pp)
    s.check("late pass %s input has data-odp-time=\"23:59\"" % nm, bool(m) and 'data-odp-time="23:59"' in m.group(0), m and m.group(0)[:90])
for rel, nm in (("templates/admin_windows.html", "closes_{{ r.cell }}"), ("templates/admin_cycle_home.html", "ends_on"),
                ("templates/admin_cycle_home.html", "closes_{{ panel.cell }}"), ("templates/admin_cycles.html", "ends_on")):
    m = re.search(r"<input[^>]*type=\"datetime-local\"[^>]*name=\"%s\"[^>]*>" % re.escape(nm), read(rel))
    s.check("%s %s defaults to 23:59" % (rel.split("/")[-1], nm), bool(m) and 'data-odp-time="23:59"' in m.group(0))
bad_open = [m.group(0)[:70] for rel in ("templates/admin_windows.html", "templates/admin_cycle_home.html", "templates/admin_cycles.html")
            for m in re.finditer(r"<input[^>]*name=\"(?:opens_[^\"]*|starts_on|shows_at)\"[^>]*>", read(rel)) if "data-odp-time" in m.group(0)]
s.check("opens / starts_on / shows_at keep the 00:00 default", not bad_open, bad_open)

sys.exit(s.done())
