"""Tiny REAL files for the upload suites (2026-11-11): since an uploaded file must be what its name says
(app.py `_upload_content_refusal`), a suite that posts "a file" through an upload route needs bytes of the right kind.
`sample(ext)` returns the smallest file of that kind the check accepts; the builders below make the hostile and edge ones.
Pure helpers, no app import, nothing written to disk."""
import io
import zipfile

OLE_SIG = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"

PDF = b"%PDF-1.4\n1 0 obj<< /Type /Catalog >>endobj\ntrailer<< /Root 1 0 R >>\n%%EOF\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x00" * 24
JPG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"\x00" * 16 + b"\xff\xd9"
GIF = b"GIF89a\x01\x00\x01\x00\x00\x00\x00;"
WEBP = b"RIFF\x1a\x00\x00\x00WEBPVP8 " + b"\x00" * 16

_MAIN = {"docx": "word/document.xml", "xlsx": "xl/workbook.xml", "pptx": "ppt/presentation.xml"}
_CT = {"docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
       "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
       "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"}


def ooxml(ext, extra=None, content_type=None, members=None):
    """A docx / xlsx / pptx: a zip with [Content_Types].xml and the main part. `extra` adds {member: bytes};
    `content_type` replaces the main part's content type; `members` adds that many empty filler members."""
    ct = ('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Override PartName="/%s" ContentType="%s"/></Types>' % (_MAIN[ext], content_type or _CT[ext]))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr(_MAIN[ext], "<doc>ZZ sample</doc>")
        for name, body in (extra or {}).items():
            z.writestr(name, body)
        for i in range(members or 0):
            z.writestr("filler/f%d.xml" % i, "")
    return buf.getvalue()


def ole(*entry_names, aligned=True):
    """A minimal compound file: the signature, a 512-byte header, then 128-byte directory entries whose UTF-16LE names are
    `entry_names` (aligned=False shifts them off the 128-byte grid, like prose that merely holds the word)."""
    out = bytearray(OLE_SIG + b"\x00" * (512 - len(OLE_SIG)))
    if not aligned:
        out += b"\x00" * 3
    for nm in ("Root Entry",) + tuple(entry_names):
        raw = nm.encode("utf-16-le")
        out += raw + b"\x00" * (128 - len(raw))
    return bytes(out)


def sample(ext):
    ext = ext.lower().lstrip(".")
    if ext == "pdf":
        return PDF
    if ext == "png":
        return PNG
    if ext in ("jpg", "jpeg"):
        return JPG
    if ext == "gif":
        return GIF
    if ext == "webp":
        return WEBP
    if ext in _MAIN:
        return ooxml(ext)
    if ext in ("doc", "xls", "ppt"):
        return ole("WordDocument")
    if ext == "csv":
        return b"name,score\nZZ,4\n"
    if ext == "txt":
        return b"ZZ sample text\n"
    raise ValueError(ext)
