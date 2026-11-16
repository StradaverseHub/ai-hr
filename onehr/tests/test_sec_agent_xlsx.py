"""The admin agent's Excel report never writes a live formula (security test 3-01, 2026-10-31).

  Every other download runs each cell through _rr_cell. The agent's own report workbook did not, so a roster name
  starting with = was stored as a formula Excel evaluates. Now title, headings and every row go through it, and the
  layout (sheet name, a bold title in A1, a bold heading row 3, column widths) is unchanged.

Each report kind is read back with openpyxl: no cell is a formula, the planted value shows as text, and a control row
(an ordinary name) is untouched. The planted names are put back (fresh scratch copy).
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
from openpyxl import load_workbook  # noqa: E402

s = H.Suite("The admin agent's Excel report is formula-safe")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

su, _bg, _emp = H.actors(a)
C = H.client_as(a, su["id"])
PAYLOADS = ['=HYPERLINK("http://x.example","y")', "+SUM(1,1)", "-2+3", "@SUM(1,1)"]

with a.app.app_context():
    db = a.get_db()
    # who the participants report lists: borrow people it really names
    cyc = a.active_cycle(db)
    listed = [p for p in db.execute("SELECT u.id, u.full_name FROM users u WHERE " + a.calibration_population_sql("u")
                                    + " ORDER BY u.id").fetchall()]
s.check("(the suite database has people in the review to plant a marker on)", len(listed) >= len(PAYLOADS) + 1, len(listed))
planted = listed[:len(PAYLOADS)]
control = listed[len(PAYLOADS)]
try:
    with a.app.app_context():
        db = a.get_db()
        for p, pay in zip(planted, PAYLOADS):
            db.execute("UPDATE users SET full_name=? WHERE id=?", (pay, p["id"]))
        db.commit()

    def sheet(url):
        r = C.get(url)
        if r.status_code != 200:
            return r.status_code, None
        return 200, load_workbook(io.BytesIO(r.data)).active

    st, ws = sheet("/admin/agent/report.xlsx?kind=participants&group_by=person&status=all")
    s.check("the participants report builds", st == 200, st)
    cells = [c for row in ws.iter_rows() for c in row if c.value is not None] if ws else []
    s.check("the report reaches the planted names (the guard is exercised)",
            all(any(isinstance(c.value, str) and pay in c.value for c in cells) for pay in PAYLOADS),
            [pay for pay in PAYLOADS if not any(isinstance(c.value, str) and pay in c.value for c in cells)])
    s.check("no cell in the workbook is a formula", not [c.coordinate for c in cells if c.data_type == "f"],
            [c.coordinate for c in cells if c.data_type == "f"][:5])
    s.check("every planted value shows as text with a leading apostrophe, like every other export",
            all(any(c.value == "'" + pay for c in cells) for pay in PAYLOADS))
    s.check("an ordinary name is untouched", any(c.value == control["full_name"] for c in cells))
    s.check("the layout is the same: sheet 'Report', bold title in A1, bold heading row 3",
            ws.title == "Report" and ws["A1"].font.bold and all(c.font.bold for c in ws[3] if c.value is not None))
    s.check("...and column widths are set", ws.column_dimensions["A"].width and ws.column_dimensions["A"].width >= 10)

    # the other report kinds go through the same writer: a marker in a business-group-like heading is the title/columns
    for qs in ("kind=progress&module=pm&group_by=person&status=all",
               "kind=progress&module=f360&group_by=person&status=all",
               "kind=pbt", "kind=scoring"):
        st, ws2 = sheet("/admin/agent/report.xlsx?" + qs)
        cells2 = [c for row in ws2.iter_rows() for c in row if c.value is not None] if ws2 else []
        s.check("%s: builds, no formula cell" % qs, st == 200 and not any(c.data_type == "f" for c in cells2), st)
    st, ws3 = sheet("/admin/agent/report.xlsx?kind=progress&module=pm&group_by=person&status=all")
    cells3 = [c for row in ws3.iter_rows() for c in row if c.value is not None] if ws3 else []
    names3 = [c.value for c in cells3 if isinstance(c.value, str) and any(pay in c.value for pay in PAYLOADS)]
    s.check("a progress report by person (a second kind) shows any planted name as text, never a formula",
            st == 200 and all(v.startswith("'") for v in names3), (st, len(names3)))
finally:
    with a.app.app_context():
        db = a.get_db()
        for p in planted:
            db.execute("UPDATE users SET full_name=? WHERE id=?", (p["full_name"], p["id"]))
        db.commit()
    s.check("(the planted names are put back)", H.one(a, "SELECT COUNT(*) FROM users WHERE full_name LIKE '=HYPERLINK%'") == 0)

sys.exit(s.done())
