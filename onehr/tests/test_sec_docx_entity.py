"""An Office file whose XML declares a DOCTYPE or an ENTITY is refused before it is parsed (security test 3-04, 2026-10-31).

  A 360-byte Word file holding a nine-level nested-entity bomb cost an attachment reader its full 12 seconds. Word never
  writes a DOCTYPE or an ENTITY into word/document.xml, so the bounded extractor now refuses one outright ("unreadable")
  without parsing it: any letter case, and UTF-16 text too. Ordinary Word files (paragraphs, a table) read as before.

  Follow-up: the same probe (one helper, _xml_unsafe) guards every XML part read from a .pptx (the slide list, its rels,
  each slide) and every XML part of an .xlsx before openpyxl opens it, and the import reader _xlsx_records
  (_xml_has_doctype) refuses such a workbook with "That workbook could not be read safely."

Runs the real extractor in its child process (a._attach_extract) and times the bomb: refused in a fraction of a second.
"""
import io
import os
import sys
import time
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("An Office file with a DOCTYPE or an ENTITY is refused before parsing")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
CT = ('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      '<Default Extension="xml" ContentType="application/xml"/></Types>')


def docx(document_xml):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CT)
        z.writestr("word/document.xml", document_xml)
    return b.getvalue()


def body(text):
    return '<w:document %s><w:body><w:p><w:r><w:t>%s</w:t></w:r></w:p></w:body></w:document>' % (W, text)


def bomb(levels=9):
    ents = '<!ENTITY lol0 "lollollollollollollollollollol">'
    for i in range(1, levels + 1):
        ents += '<!ENTITY lol%d "%s">' % (i, "&lol%d;" % (i - 1) * 10)
    return ('<?xml version="1.0"?><!DOCTYPE lolz [%s]><w:document %s><w:body><w:p><w:r><w:t>&lol%d;</w:t></w:r></w:p>'
            '</w:body></w:document>' % (ents, W, levels))


def read(data):
    t0 = time.time()
    st, txt = a._attach_extract("docx", data)
    return st, txt, time.time() - t0


s.section("ordinary Word files read as before")
st, txt, dt = read(docx(body("Quarterly target met")))
s.check("a plain paragraph reads (ok, its words)", st == "ok" and "Quarterly target met" in txt, (st, txt))
tbl = ('<w:document %s><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Sales'
       '</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>' % W)
st, txt, dt = read(docx(tbl))
s.check("a table reads", st == "ok" and "Region" in txt and "Sales" in txt, (st, txt))
st, txt, dt = read(docx('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + body("with a declaration")))
s.check("a file with the usual XML declaration reads", st == "ok" and "with a declaration" in txt, (st, txt))
st, txt, dt = read(docx(body("A &amp; B and &lt;tags&gt; and doctype is a word here")))
s.check("the words 'doctype' and an escaped ampersand in the TEXT are fine", st == "ok" and "A & B" in txt, (st, txt))

s.section("a DOCTYPE or an ENTITY is refused, quickly")
b = docx(bomb(9))
s.check("the bomb is small (a few hundred bytes zipped)", len(b) < 2000, len(b))
st, txt, dt = read(b)
s.check("the nine-level entity bomb is refused as unreadable", st == "unreadable" and txt == "", (st, txt[:40]))
s.check("...in well under the 12 s a worker used to lose (under 3 s)", dt < 3, round(dt, 2))
CASES = {
    "a DOCTYPE with no entity": '<?xml version="1.0"?><!DOCTYPE w:document>' + body("x"),
    "lower-case doctype": '<?xml version="1.0"?><!doctype w:document>' + body("x"),
    "an ENTITY inside an internal subset": '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY e "v">]>' + body("&e;"),
    "an external entity": '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY e SYSTEM "file:///etc/hostname">]>' + body("&e;"),
    "mixed-case ENTITY": '<?xml version="1.0"?><!DocType d [<!Entity e "v">]>' + body("&e;"),
}
for label, xml in CASES.items():
    st, txt, dt = read(docx(xml))
    s.check("%s: refused" % label, st == "unreadable" and txt == "", (st, txt[:40]))
u16 = ('<?xml version="1.0" encoding="UTF-16"?>' + bomb(3)).encode("utf-16")
st, txt, dt = read(docx(u16))
s.check("the same bomb written in UTF-16 is refused too", st == "unreadable" and dt < 3, (st, round(dt, 2)))
s.check("a refusal is not a crash: the extractor answered a status (never raised)", st in ("unreadable", "too_big"))

# ---- .pptx and .xlsx (the follow-up) --------------------------------------------------------------------------------
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def slide_xml(text, prefix=""):
    return (prefix + '<p:sld xmlns:p="%s" xmlns:a="%s"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>%s</a:t></a:r></a:p>'
            '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>' % (P_NS, A_NS, text))


PRES = ('<p:presentation xmlns:p="%s" xmlns:r="%s"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>'
        % (P_NS, R_NS))
RELS = ('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>')


def pptx(slide, presentation=PRES, rels=RELS):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CT)
        z.writestr("ppt/presentation.xml", presentation)
        z.writestr("ppt/_rels/presentation.xml.rels", rels)
        z.writestr("ppt/slides/slide1.xml", slide)
    return b.getvalue()


def bomb_prefix(levels=9):
    ents = '<!ENTITY lol0 "lollollollollollollollollollol">'
    for i in range(1, levels + 1):
        ents += '<!ENTITY lol%d "%s">' % (i, "&lol%d;" % (i - 1) * 10)
    return '<?xml version="1.0"?><!DOCTYPE lolz [%s]>' % ents


def xlsx(sheet_xml=None):
    """A real workbook from openpyxl; with sheet_xml, its first sheet replaced by that XML."""
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.append(["Employee ID", "Name"])
    ws.append(["EXAMPLE-1", "Sales target met"])
    src = io.BytesIO()
    wb.save(src)
    if sheet_xml is None:
        return src.getvalue()
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(src.getvalue())) as zin, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for i in zin.infolist():
            zout.writestr(i.filename, sheet_xml if i.filename == "xl/worksheets/sheet1.xml" else zin.read(i))
    return out.getvalue()


def bomb_sheet(levels=9):
    return (bomb_prefix(levels) + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
            '<row r="1"><c r="A1" t="inlineStr"><is><t>&lol%d;</t></is></c></row></sheetData></worksheet>' % levels)


def read_as(ext, data):
    t0 = time.time()
    st, txt = a._attach_extract(ext, data)
    return st, txt, time.time() - t0


s.section("a .pptx: ordinary reads, an entity bomb in any part is refused")
st, txt, dt = read_as("pptx", pptx(slide_xml("Deck headline")))
s.check("a plain deck reads (ok, its words)", st == "ok" and "Deck headline" in txt, (st, txt))
st, txt, dt = read_as("pptx", pptx(slide_xml("Deck headline", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')))
s.check("a deck with the usual XML declaration reads", st == "ok" and "Deck headline" in txt, (st, txt))
for label, data in (("a slide", pptx(slide_xml("&lol9;", bomb_prefix(9)))),
                    ("presentation.xml", pptx(slide_xml("x"), presentation=bomb_prefix(9) + PRES)),
                    ("the presentation's rels", pptx(slide_xml("x"), rels=bomb_prefix(9) + RELS)),
                    ("a slide, written in UTF-16", pptx(('<?xml version="1.0" encoding="UTF-16"?>' + slide_xml("&lol3;", bomb_prefix(3)[len('<?xml version="1.0"?>'):])).encode("utf-16")))):
    st, txt, dt = read_as("pptx", data)
    s.check("an entity bomb in %s: unreadable, in under 3 s" % label, st == "unreadable" and txt == "" and dt < 3, (st, round(dt, 2)))
st, txt, dt = read_as("pptx", pptx(slide_xml("x", '<?xml version="1.0"?><!DOCTYPE p:sld>')))
s.check("a bare DOCTYPE in a slide is refused too", st == "unreadable", st)

s.section("an .xlsx: ordinary reads, an entity bomb in a sheet is refused")
st, txt, dt = read_as("xlsx", xlsx())
s.check("an ordinary workbook reads (the attachment reader)", st == "ok" and "Sales target met" in txt, (st, txt[:60]))
st, txt, dt = read_as("xlsx", xlsx(bomb_sheet(9)))
s.check("a sheet holding an entity bomb: unreadable, in under 3 s", st == "unreadable" and txt == "" and dt < 3, (st, round(dt, 2)))
st, txt, dt = read_as("xlsx", xlsx(bomb_prefix(1) + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>'))
s.check("a sheet with a small entity (not a bomb) is refused as well: the rule is the declaration", st == "unreadable", st)

s.section("the import reader (_xlsx_records) says the same")
recs = a._xlsx_records(xlsx())
s.check("an ordinary workbook reads into records", len(recs) == 1 and recs[0]["employee id"] == "EXAMPLE-1", recs)
t0 = time.time()
try:
    a._xlsx_records(xlsx(bomb_sheet(9)))
    why = None
except ValueError as e:
    why = str(e)
except Exception as e:  # noqa: BLE001
    why = "other: %r" % e
dt = time.time() - t0
s.check("a workbook with an entity bomb raises ValueError: That workbook could not be read safely.",
        why == "That workbook could not be read safely.", why)
s.check("...in under 3 s, before openpyxl parses it", dt < 3, round(dt, 2))
try:
    a._xlsx_records(xlsx(("<?xml version=\"1.0\"?><!doctype x>" + "<worksheet/>")))
    why = None
except ValueError as e:
    why = str(e)
except Exception as e:  # noqa: BLE001
    why = "other: %r" % e
s.check("a lower-case doctype is refused too", why == "That workbook could not be read safely.", why)

sys.exit(s.done())
