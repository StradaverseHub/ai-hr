"""A request body and an import workbook are bounded (security test 3-05, 2026-10-31).

  * MAX_CONTENT_LENGTH is 16 MB, the ceiling nginx already enforces, and every attachment limit sits under it; a body past
    it is answered 413 whatever the route, instead of being read whole.
  * _xlsx_records (every import's reader) refuses a workbook that unpacks past XLSX_IMPORT_MAX_UNZIPPED, holds more than
    XLSX_IMPORT_MAX_PARTS parts or has more than XLSX_IMPORT_MAX_ROWS rows, and the import page says it could not read
    the file and changes nothing. The caps were set from the real files in Production Import/ (largest import file 13,940
    rows, 13 MB unpacked): a KPI-sized workbook still reads.

The guards are exercised both at their real values (a hostile 2-million-row workbook of about 300 KB) and at small values
patched in for the boundary (a workbook of exactly the cap reads; one row more does not).
"""
import io
import os
import sys
import time
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Request body and import workbook bounds")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
from openpyxl import Workbook  # noqa: E402

MB = 1024 * 1024
SU, _bg, EMP = H.actors(a)

s.section("the request ceiling")
cfg = a.app.config.get("MAX_CONTENT_LENGTH")
s.check("MAX_CONTENT_LENGTH is 16 MB", cfg == 16 * MB, cfg)
s.check("every attachment limit sits under it (so none is cut short)",
        cfg is not None and all(v < cfg for v in (a.PM_ATTACHMENT_MAX_BYTES, a.PM_ATTACHMENT_AGGREGATE_MAX_BYTES,
                                                  a.EVIDENCE_ATTACH_MAX_BYTES)),
        (cfg, a.PM_ATTACHMENT_MAX_BYTES, a.PM_ATTACHMENT_AGGREGATE_MAX_BYTES))
E = H.client_as(a, EMP["id"])


def post_file(n_bytes):
    return E.post("/performance/kpi/1/autosave", data={"csrf_token": "tok", "file": (io.BytesIO(b"x" * n_bytes), "a.pdf")},
                  content_type="multipart/form-data")


r = post_file(17 * MB)
s.check("a 17 MB body is refused with 413 before the route reads it", r.status_code == 413, r.status_code)
r = post_file(1 * MB)
s.check("a 1 MB body reaches the route (not a 413)", r.status_code != 413, r.status_code)
r = E.post("/account/password", data={"csrf_token": "tok", "pad": "y" * (17 * MB)})
s.check("a 17 MB form field is refused with 413 on another route too", r.status_code == 413, r.status_code)


def book(rows, cols=("Employee ID", "Name", "KPI")):
    wb = Workbook(write_only=True)
    ws = wb.create_sheet("Sheet1")
    ws.append(list(cols))
    for i in range(rows):
        ws.append(["EXAMPLE-%d" % i, "Person %d" % i, i])
    b = io.BytesIO()
    wb.save(b)
    return b.getvalue()


s.section("an ordinary import workbook reads, even a large one")
recs = a._xlsx_records(book(300))
s.check("300 rows: 300 records", len(recs) == 300 and recs[0]["employee id"] == "EXAMPLE-0", len(recs))
t0 = time.time()
big = book(20000)
recs = a._xlsx_records(big)
s.check("20,000 rows (several rows a person, a KPI-sized import): all read", len(recs) == 20000, len(recs))
s.check("...and 20,000 is well under the row cap", 20000 * 4 < a.XLSX_IMPORT_MAX_ROWS if hasattr(a, "XLSX_IMPORT_MAX_ROWS") else False)
s.check("an empty workbook reads as no records", a._xlsx_records(book(0)) == [])
s.check("the caps clear the largest real import file (13,940 rows, 13 MB unpacked)",
        getattr(a, "XLSX_IMPORT_MAX_ROWS", 0) >= 100000 and getattr(a, "XLSX_IMPORT_MAX_UNZIPPED", 0) >= 100 * MB)

s.section("the row cap, at the boundary")
_rows = getattr(a, "XLSX_IMPORT_MAX_ROWS", None)
a.XLSX_IMPORT_MAX_ROWS = 50
try:
    ok50 = len(a._xlsx_records(book(50))) == 50
    try:
        a._xlsx_records(book(51))
        why = None
    except ValueError as e:
        why = str(e)
    except Exception as e:  # noqa: BLE001
        why = "other: %r" % e
finally:
    if _rows is not None:
        a.XLSX_IMPORT_MAX_ROWS = _rows
s.check("a workbook with exactly the cap's rows reads", ok50)
s.check("one row more is refused (ValueError, in words)", bool(why) and "more than" in why and "rows" in why, why)

s.section("the unpacked-size cap and the hostile workbook")


def hostile(sheet_mb, rows_hint=None):
    """A workbook whose sheet XML unpacks to sheet_mb MB and zips to a few hundred KB (one repeated row)."""
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                   '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr("xl/workbook.xml", '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                   'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        row = '<row r="2"><c r="A2" t="inlineStr"><is><t>EXAMPLE-1</t></is></c><c r="B2" t="inlineStr"><is><t>x</t></is></c></row>'
        head = ('<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
                '<row r="1"><c r="A1" t="inlineStr"><is><t>Employee ID</t></is></c><c r="B1" t="inlineStr"><is><t>Name</t></is></c></row>')
        with z.open("xl/worksheets/sheet1.xml", "w", force_zip64=True) as w:
            w.write(head.encode())
            chunk = (row * 10000).encode()
            for _ in range(int(sheet_mb * MB / len(chunk)) + 1):
                w.write(chunk)
            w.write(b"</sheetData></worksheet>")
    return b.getvalue()


hb = hostile(125)   # past the 120 MB cap; about 2 million rows
s.check("the hostile workbook is small on the wire (under 1 MB) and the upload ceiling would pass it", len(hb) < MB, len(hb))
t0 = time.time()
try:
    a._xlsx_records(hb)
    why = None
except ValueError as e:
    why = str(e)
except Exception as e:  # noqa: BLE001
    why = "other: %r" % e
dt = time.time() - t0
s.check("it is refused as too large (ValueError naming the size)", bool(why) and "too large" in why, why)
s.check("...in a fraction of a second, before any row is read (under 2 s)", dt < 2, round(dt, 2))

_un = getattr(a, "XLSX_IMPORT_MAX_UNZIPPED", None)
a.XLSX_IMPORT_MAX_UNZIPPED = 2 * MB
try:
    small_ok = len(a._xlsx_records(book(50))) == 50
    try:
        a._xlsx_records(hostile(3))
        why = None
    except ValueError as e:
        why = str(e)
finally:
    if _un is not None:
        a.XLSX_IMPORT_MAX_UNZIPPED = _un
s.check("at a small cap an ordinary workbook still reads and a 3 MB-unpacked one is refused", small_ok and bool(why), why)
try:
    a._xlsx_records(b"this is not a workbook at all")
    notzip = "no error"
except ValueError as e:
    notzip = "ValueError: %s" % e
except Exception as e:  # noqa: BLE001
    notzip = type(e).__name__
s.check("...a text file named .xlsx raises something other than the size refusal", "too large" not in notzip and notzip != "no error", notzip)

s.section("the import page, end to end (roster import, super admin)")
C = H.client_as(a, SU["id"])
_rows = getattr(a, "XLSX_IMPORT_MAX_ROWS", None)
a.XLSX_IMPORT_MAX_ROWS = 50
n_before = H.one(a, "SELECT COUNT(*) FROM users")
act_before = H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action LIKE '%import%'")
try:
    r = C.post("/admin/import/roster", data={"csrf_token": "tok", "preview": "1", "mode": "additive",
                                              "file": (io.BytesIO(book(60)), "roster.xlsx")},
               content_type="multipart/form-data", follow_redirects=False)
    with C.session_transaction() as ss:
        flashes = [m for _c, m in ss.get("_flashes", [])]
finally:
    if _rows is not None:
        a.XLSX_IMPORT_MAX_ROWS = _rows
s.check("an over-cap workbook is answered with a redirect back and a message that it could not be read",
        r.status_code == 302 and any("Could not read the file" in m or "split it and import the parts" in m for m in flashes), (r.status_code, flashes))
s.check("...and nothing was imported (no people added, no import logged)",
        H.one(a, "SELECT COUNT(*) FROM users") == n_before
        and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action LIKE '%import%'") == act_before)

sys.exit(s.done())
