"""An uploaded file must be what its name says; the preview box opens only OneHR's own addresses; an inline image or text
preview carries a strict policy (Chris, 2026-11-11, "Yes, fix all 3").

  1. ONE pure function, app.py `_upload_content_refusal(ext, data)`: None for a real file of the kind its name says, else the
     sentence to show. Every real type passes; a mismatch, a macro (docx/xlsx/pptx with vbaProject.bin or a macroEnabled content
     type, an old-format file with a _VBA_PROJECT or Macros directory entry) and a password-protected Office file are refused;
     a corrupt zip is refused without raising. Each guard is falsified: the function's source with that guard cut out fails the
     same battery.
  2. Every upload path calls it after its extension and size checks and before it stores: the KPI autosave, the bulk submit, the
     review chat's example attach and per-KPI attach, the evidence page's attach, a Group People admin's Add a file, and the
     AI+ Learning T3 scan. A disguised file (HTML in a .pdf) is refused through a real request and stores nothing, a real PDF is
     taken; a lint holds that every writer of the attachment tables calls it.
  3. `_file_response_headers`: nosniff always; inline PNG / JPG / GIF / WebP carry the sandboxed image policy, inline TXT the
     no-sandbox text policy, inline PDF none; a download carries neither. All three preview routes use it.
  4. static/file_preview.js: the box (and Open in a new tab and Download) takes only an http(s) address with the page's own origin;
     run under node with a stub page, a foreign, javascript:, data: or unparsable address is left alone.
The model is never called. Its own synthetic data on a fresh copy of the database.
"""
import io
import json
import os
import re
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402
import upload_samples as U  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Uploads are what their name says; the preview box is same-origin; inline previews have a policy")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
ROOT = H.REPO


def read(rel):
    return open(os.path.join(ROOT, rel), encoding="utf-8").read()


APP = read("app.py")
JS = read("static/file_preview.js")
EXTS = sorted(a.EVIDENCE_ATTACH_EXTS)


def fn_source(name):
    i = APP.index("\ndef %s(" % name) + 1
    j = APP.index("\n\n\n", i)
    return APP[i:j]


# ---------------------------------------------------------------------------------------------------------------------
s.section("1. the function: real files pass, everything else is said no to")
F = a._upload_content_refusal
MISMATCH = {e: a._up_mismatch_why(e) for e in EXTS}
s.check("the three sentences read as Chris approved them",
        a._up_mismatch_why("pdf") == "That file isn't the PDF its name says. Save it again in that format and attach it."
        and a._up_mismatch_why("xlsx") == "That file isn't the Excel file its name says. Save it again in that format and attach it."
        and a._UP_MACRO_WHY == "That file holds macros, so it can't be attached. Save it as a normal .docx, .xlsx or .pptx "
                               "(without macros) and attach that."
        and a._UP_PASSWORD_WHY == "That file is password-protected, so reviewers couldn't open it. Remove the password, then "
                                  "attach it again.")
s.check("no sentence says HR", not any("HR" in t for t in (a._UP_MACRO_WHY, a._UP_PASSWORD_WHY, *MISMATCH.values())))
s.check("every extension a person may attach has a kind in words", all(e in a._UP_KIND_WORDS for e in EXTS))
s.check("every allowed type: a real file of that kind passes",
        all(F(e, U.sample(e)) is None for e in EXTS), [e for e in EXTS if F(e, U.sample(e))])
s.check("...the extension is case-blind and takes a leading dot", F(".PDF", U.PDF) is None and F("Docx", U.sample("docx")) is None)
s.check("an extension that is not on the evidence list is not this function's business (the caller refuses it)",
        F("exe", b"MZ") is None and F("", b"x") is None)

HTML = b"<html><script>alert(1)</script></html>"
cases = [   # (label, ext, bytes, the refusal expected)
    ("HTML named .pdf", "pdf", HTML, MISMATCH["pdf"]),
    ("a PDF named .png", "png", U.PDF, MISMATCH["png"]),
    ("HTML named .jpg", "jpg", HTML, MISMATCH["jpg"]),
    ("a PDF named .jpeg", "jpeg", U.PDF, MISMATCH["jpeg"]),
    ("a zip named .gif", "gif", b"PK\x03\x04rest", MISMATCH["gif"]),
    ("an empty file named .png", "png", b"", MISMATCH["png"]),
    ("RIFF but not WEBP (a WAV) named .webp", "webp", b"RIFF\x1a\x00\x00\x00WAVEfmt ", MISMATCH["webp"]),
    ("RIFF but not WEBP (a WAV) named .png", "png", b"RIFF\x1a\x00\x00\x00WAVEfmt ", MISMATCH["png"]),
    ("an OLE file named .jpg", "jpg", U.ole("WordDocument"), MISMATCH["jpg"]),
    ("a zip named .doc", "doc", U.ooxml("docx"), MISMATCH["doc"]),
    ("an OLE file named .docx", "docx", U.ole("WordDocument"), MISMATCH["docx"]),
    ("text named .xlsx", "xlsx", b"just some words", MISMATCH["xlsx"]),
    ("a docx named .xlsx", "xlsx", U.ooxml("docx"), MISMATCH["xlsx"]),
    ("a docx named .pptx", "pptx", U.ooxml("docx"), MISMATCH["pptx"]),
    ("an empty file named .pdf", "pdf", b"", MISMATCH["pdf"]),
    ("an empty file named .docx", "docx", b"", MISMATCH["docx"]),
    ("a PDF whose header sits past the first 1 KB", "pdf", b"x" * 1100 + b"%PDF-1.4", MISMATCH["pdf"]),
    ("a PDF named .txt", "txt", U.PDF, MISMATCH["txt"]),
    ("a zip named .csv", "csv", b"PK\x03\x04rest", MISMATCH["csv"]),
    ("a program named .txt (MZ)", "txt", b"MZ\x90\x00 program", MISMATCH["txt"]),
    ("a program named .txt (ELF)", "txt", b"\x7fELF\x02\x01", MISMATCH["txt"]),
    ("an OLE file named .csv", "csv", U.ole("WordDocument"), MISMATCH["csv"]),
    ("text with a NUL byte named .txt", "txt", b"hello\x00world", MISMATCH["txt"]),
    ("UTF-16 text (NULs) named .csv", "csv", "a,b\n1,2\n".encode("utf-16"), MISMATCH["csv"]),
    ("a docx without its main part", "docx", U.ooxml("docx").replace(b"word/document.xml", b"word/documentX.xml"), MISMATCH["docx"]),
    ("a docx with over 2,000 members", "docx", U.ooxml("docx", members=2001), MISMATCH["docx"]),
    ("a corrupt zip named .docx", "docx", b"PK\x03\x04" + b"\xff" * 200, MISMATCH["docx"]),
    ("a truncated zip named .xlsx", "xlsx", U.ooxml("xlsx")[:-30], MISMATCH["xlsx"]),
    ("an OLE file that does not end well named .doc is still an OLE file (passes)", "doc", None, None),
    ("a docx with vbaProject.bin", "docx", U.ooxml("docx", extra={"word/vbaProject.bin": b"x"}), a._UP_MACRO_WHY),
    ("a pptx with VBAPROJECT.BIN in another folder", "pptx", U.ooxml("pptx", extra={"a/b/VBAPROJECT.BIN": b"x"}), a._UP_MACRO_WHY),
    ("an xlsx with a macroEnabled content type", "xlsx",
     U.ooxml("xlsx", content_type="application/vnd.ms-excel.sheet.macroEnabled.main+xml"), a._UP_MACRO_WHY),
    ("a docx with a lower-case macroenabled content type", "docx",
     U.ooxml("docx", content_type="application/x.macroenabled.main+xml"), a._UP_MACRO_WHY),
    ("an old .doc with a _VBA_PROJECT entry", "doc", U.ole("WordDocument", "_VBA_PROJECT_CUR"), a._UP_MACRO_WHY),
    ("an old .xls with a Macros entry", "xls", U.ole("Workbook", "Macros"), a._UP_MACRO_WHY),
    ("an old .ppt with a Macros entry", "ppt", U.ole("PowerPoint Document", "Macros"), a._UP_MACRO_WHY),
    ("an encrypted docx (EncryptedPackage)", "docx", U.ole("EncryptionInfo", "EncryptedPackage"), a._UP_PASSWORD_WHY),
    ("an encrypted xlsx (EncryptionInfo only)", "xlsx", U.ole("EncryptionInfo"), a._UP_PASSWORD_WHY),
    ("an encrypted file named .pptx", "pptx", U.ole("EncryptedPackage"), a._UP_PASSWORD_WHY),
    ("an encrypted file named .doc", "doc", U.ole("EncryptedPackage"), a._UP_PASSWORD_WHY),
]
cases = [c for c in cases if c[2] is not None]
got = [(lab, F(ext, data)) for lab, ext, data, _w in cases]
bad = [(lab, g, w) for (lab, g), (_l, _e, _d, w) in zip(got, cases) if g != w]
s.check("%d refusals (mismatch, empty, macro, password, corrupt): each gets exactly its sentence" % len(cases), not bad, bad)

raised = []
for lab, ext, data, _w in cases:
    try:
        F(ext, data)
    except Exception as e:  # noqa: BLE001
        raised.append((lab, repr(e)))
s.check("...and none of them raises", not raised, raised)
fuzz = [b"PK\x03\x04", b"PK\x05\x06" + b"\x00" * 18, U.ooxml("docx")[:100], U.ooxml("docx")[:-1], b"\x00" * 600, U.OLE_SIG,
        U.OLE_SIG + b"\xff" * 5000, b"%PDF-", None]
try:
    for e in ("docx", "xlsx", "pptx", "doc", "xls", "ppt", "pdf", "png", "txt"):
        for d in fuzz:
            F(e, d)
    ok = True
except Exception as e:  # noqa: BLE001
    ok = repr(e)
s.check("a pile of corrupt and truncated inputs, in every format, never raises (None data too)", ok is True, ok)

s.check("a prose line that merely holds the word Macros (UTF-16, off the directory grid) is not a macro",
        F("doc", U.ole("WordDocument", "Macros", aligned=False)) is None)
s.check("text in Windows-1252, UTF-8 and with a BOM passes as .txt and .csv",
        all(F(e, d) is None for e in ("txt", "csv") for d in (
            "café “quote” €5".encode("cp1252", "ignore"), "café 你好".encode("utf-8"),
            b"\xef\xbb\xbf" + "name,score\né,1\n".encode("utf-8"), b"", b"plain ascii\r\nlines\r\n")))
s.check("a NUL past the first 64 KB of a text file is not looked for (the cap is the point)",
        F("txt", b"a" * 70000 + b"\x00") is None and F("txt", b"a" * 65535 + b"\x00") is not None)
s.check("a PDF's header may sit within the first 1,024 bytes (a mail-added preamble)", F("pdf", b"\n" * 1000 + b"%PDF-1.7") is None)
s.check("a jpg with only the 3-byte signature passes, a jpeg too", F("jpg", b"\xff\xd8\xff") is None and F("jpeg", U.JPG) is None)

# --- every guard falsified: the function's own source with that guard cut out fails the same battery ----------------------
SRC = fn_source("_upload_content_refusal")
HELP = fn_source("_up_ole_has_name")


def battery(fn):
    """Cases that each hold one guard up; returns the labels the given function gets wrong."""
    want = [(lab, ext, data, w) for lab, ext, data, w in cases]
    wrong = [lab for lab, ext, data, w in want if _safe(fn, ext, data) != w]
    wrong += [e for e in EXTS if _safe(fn, e, U.sample(e)) is not None]
    wrong += ["%s named .%s" % (k, e) for k, e in cross if _safe(fn, e, IMGS[k]) is not None]
    return wrong


def _safe(fn, ext, data):
    try:
        return fn(ext, data)
    except Exception as e:  # noqa: BLE001
        return "RAISED " + repr(e)[:40]


IMG = fn_source("_up_is_image")


def mutant(old, new, src=SRC, helper=HELP, img=IMG):
    assert src.count(old) == 1 or img.count(old) == 1, (old, src.count(old))
    ns = dict(a.__dict__)
    exec(helper, ns)
    exec(img.replace(old, new) if img.count(old) == 1 else img, ns)
    exec(src.replace(old, new) if src.count(old) == 1 else src, ns)
    return ns["_upload_content_refusal"]


IMGS = {"png": U.PNG, "jpg": U.JPG, "gif": U.GIF, "webp": U.WEBP}
cross = [(k, e) for k in IMGS for e in ("png", "jpg", "jpeg", "gif", "webp")]
s.check("images are lenient between kinds (a PNG screenshot saved as .jpg): any of the five signatures passes under any image name "
        "(%d pairs)" % len(cross), all(F(e, IMGS[k]) is None for k, e in cross), [(k, e) for k, e in cross if F(e, IMGS[k])])
s.check("...but only an image does: HTML, a PDF, a zip, a WAV, an OLE file and nothing at all under each image name are refused",
        all(F(e, d) == MISMATCH[e] for e in ("png", "jpg", "jpeg", "gif", "webp")
            for d in (HTML, U.PDF, b"PK\x03\x04x", b"RIFF\x1a\x00\x00\x00WAVEfmt ", U.ole("WordDocument"), b"")))
s.check("...and a non-image never passes as an image because it is a different kind of file (a docx named .png is refused)",
        F("png", U.ooxml("docx")) == MISMATCH["png"])
s.check("the battery is clean on the real function", battery(F) == [], battery(F))
MUT = [
    ("PDF signature", 'return None if b"%PDF-" in data[:1024] else bad', "return None"),
    ("image guard (any non-image under an image name)", "return None if _up_is_image(data) else bad", "return None"),
    ("PNG signature", 'data.startswith(b"\\x89PNG\\r\\n\\x1a\\n") or', "False or"),
    ("JPEG signature", 'data.startswith(b"\\xff\\xd8\\xff") or', "False or"),
    ("GIF signature", 'data[:6] in (b"GIF87a", b"GIF89a")', "False"),
    ("WebP signature", '(data[:4] == b"RIFF" and data[8:12] == b"WEBP")', "False"),
    ("image leniency (each kind strictly its own: the old rule)", "return None if _up_is_image(data) else bad",
     'return None if ((ext == "png" and data.startswith(b"\\x89PNG")) or (ext in ("jpg", "jpeg") and data.startswith(b"\\xff\\xd8\\xff")) '
     'or (ext == "gif" and data[:3] == b"GIF") or (ext == "webp" and data[8:12] == b"WEBP")) else bad'),
    ("text NUL guard", 'if b"\\x00" in data[:_UP_TEXT_SCAN] or', "if False or"),
    ("text binary-signature guard", "or data.startswith(_UP_BINARY_SIGS):", "or False:"),
    ("OLE signature for doc / xls / ppt", "if not data.startswith(_UP_OLE):\n                return bad", "if False:\n                return bad"),
    ("old-format macro guard", 'if _up_ole_has_name(data, ("_VBA_PROJECT", "Macros")):', "if False:"),
    ("password guard", 'and _up_ole_has_name(data, ("EncryptionInfo", "EncryptedPackage")):', "and False:"),
    ("zip member cap", "if len(infos) > _UP_ZIP_MEMBERS_MAX:", "if False:"),
    ("[Content_Types].xml and main part", 'if "[Content_Types].xml" not in names or main not in names:', "if False:"),
    ("vbaProject.bin guard", 'if any(n.replace("\\\\", "/").rsplit("/", 1)[-1].lower() == "vbaproject.bin" for n in names):', "if False:"),
    ("macroEnabled content-type guard", 'if b"macroenabled" in ct.lower():', "if False:"),
    ("the catch-all (a corrupt zip must not raise)", "except Exception:  # noqa: BLE001", "except KeyboardInterrupt:  # noqa: BLE001"),
]
for lab, old, new in MUT:
    try:
        m = mutant(old, new)
        wrong = battery(m)
    except AssertionError as e:
        wrong, lab = ["the cut did not apply: %s" % (e,)], lab + " (cut failed)"
    s.check("falsified: without the %s the battery fails (%d cases)" % (lab, len(wrong)), len(wrong) > 0 and "cut did not apply" not in str(wrong), wrong[:3])
assert HELP.count("if i % 128 == 0:") == 1
_ns = dict(a.__dict__)
exec(HELP.replace("if i % 128 == 0:", "if True:"), _ns)
exec(SRC, _ns)
ALIGN = _ns["_upload_content_refusal"]
s.check("falsified: without the directory-grid rule a prose 'Macros' is wrongly refused",
        _safe(ALIGN, "doc", U.ole("WordDocument", "Macros", aligned=False)) == a._UP_MACRO_WHY)

# ---------------------------------------------------------------------------------------------------------------------
# a subject with an approved KPI line, a shared review item and a draft evidence entry, in the active cycle
with a.app.app_context():
    db = a.get_db()
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','evidence')")
    cid = a.active_cycle_id(db)
    subj = db.execute("SELECT u.* FROM users u WHERE u.role!='admin' AND u.left_at IS NULL ORDER BY u.id LIMIT 1").fetchone()
    for tbl in ("pm_attachments", "pm_kpi_results"):
        db.execute("DELETE FROM %s WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?)" % tbl,
                   (cid, subj["id"]))
    db.execute("DELETE FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (cid, subj["id"]))
    TIDS = []
    for nm in ("ZZ Content Line One", "ZZ Content Line Two"):
        TIDS.append(db.execute(
            "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, unit, method, target, threshold, "
            "excellence, rate1, rate2, rate3, rate4, rate5, status, business_group, company, department) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'approved',?,?,?)",
            (cid, subj["id"], nm, 50.0, "%", "more", 90.0, 70.0, 100.0, 70.0, 80.0, 90.0, 95.0, 100.0,
             subj["business_group"] or "", subj["company"] or "", subj["department"] or "")).lastrowid)
    T1, T2 = TIDS
    EID_REV = db.execute("INSERT INTO pm_evidence(subject_id, author_id, occurred_on, kind, body, state) "
                         "VALUES (?,?, '2026-10-01', 'recognition', NULL, 'shared')", (subj["id"], subj["id"])).lastrowid
    EID_DRAFT = db.execute("INSERT INTO pm_evidence(subject_id, author_id, occurred_on, kind, body, state) "
                           "VALUES (?,?, '2026-10-01', 'other', 'ZZ content draft', 'draft')", (subj["id"], subj["id"])).lastrowid
    db.commit()
SU, _BG, _EMP = H.actors(a)
E = H.client_as(a, subj["id"])
A = H.client_as(a, SU["id"])


def multi(client, url, field, name, data, **form):
    d = dict(form, csrf_token="tok")
    d[field] = (io.BytesIO(data), name)
    return client.post(url, data=d, content_type="multipart/form-data")


def n_evidence_files():   # every item of the subject: the per-KPI attach and Add a file make their own file-only item
    return H.one(a, "SELECT COUNT(*) FROM pm_evidence_attachments WHERE evidence_id IN (SELECT id FROM pm_evidence WHERE subject_id=?)",
                 (subj["id"],))


def n_kpi_files():
    return H.one(a, "SELECT COUNT(*) FROM pm_attachments WHERE kpi_target_id IN (?,?)", (T1, T2))


def reset():
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM pm_evidence_attachments WHERE evidence_id IN (SELECT id FROM pm_evidence WHERE subject_id=?)",
                  (subj["id"],))
        d.execute("DELETE FROM pm_attachments WHERE kpi_target_id IN (?,?)", (T1, T2))
        d.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (?,?)", (T1, T2))
        d.commit()


def flashes(client):
    with client.session_transaction() as ss:
        return [m for _c, m in ss.get("_flashes", [])]


# every path: (label, send(name, data) -> (refused sentence or None, taken?)), the counter that proves nothing / something was stored
def p_autosave(name, data):
    r = multi(E, "/performance/kpi/%d/autosave" % T1, "file", name, data)
    j = r.get_json(silent=True) or {}
    return (j.get("message") if j.get("ok") is False else None), bool(j.get("ok"))


def p_submit_all(name, data):
    E.get("/dashboard")
    with E.session_transaction() as ss:
        ss.pop("_flashes", None)
    r = E.post("/performance/submit-all", data={"csrf_token": "tok", "actual_value_%d" % T1: "95", "actual_value_%d" % T2: "92",
                                                "file_%d" % T1: (io.BytesIO(data), name)}, content_type="multipart/form-data")
    fl = flashes(E)
    why = next((m for m in fl if "ZZ Content Line One" in m), None)
    return (why.split(": ", 1)[1] if why else None), why is None and r.status_code in (302, 303)


def p_review_example(name, data):
    r = multi(E, "/review/evidence/%d/attach" % EID_REV, "file", name, data)
    j = r.get_json(silent=True) or {}
    return j.get("error") if j.get("ok") is False else None, bool(j.get("ok"))


def p_review_kpi(name, data):
    r = multi(E, "/review/kpi/%d/attach" % T2, "file", name, data)
    j = r.get_json(silent=True) or {}
    return j.get("error") if j.get("ok") is False else None, bool(j.get("ok"))


def p_evidence_page(name, data):
    with E.session_transaction() as ss:
        ss.pop("_flashes", None)
    r = multi(E, "/evidence/%d/attach" % EID_DRAFT, "file", name, data)
    fl = flashes(E)
    return (fl[-1] if fl and fl[-1] != "Attached." else None), "Attached." in fl


def p_admin_add(name, data):
    with A.session_transaction() as ss:
        ss.pop("_flashes", None)
    r = multi(A, "/admin/users/%d/kpi-file/add" % subj["id"], "file", name, data, line=str(T2), reason="the signed copy came by email")
    fl = flashes(A)
    return (fl[-1] if fl and "Added" not in fl[-1] and "added" not in fl[-1].lower() else None), any("dded" in m for m in fl)


PATHS = [("KPI autosave", p_autosave), ("bulk submit", p_submit_all), ("review chat: an example's file", p_review_example),
         ("review: a KPI's paperclip", p_review_kpi), ("the evidence page", p_evidence_page), ("admin: Add a file", p_admin_add)]

s.section("2. every upload path refuses a disguised file and takes a real one")
HTML_PDF = ("proof.pdf", HTML, a._up_mismatch_why("pdf"))
DISG = [HTML_PDF, ("macro.docx", U.ooxml("docx", extra={"word/vbaProject.bin": b"x"}), a._UP_MACRO_WHY),
        ("locked.xlsx", U.ole("EncryptionInfo", "EncryptedPackage"), a._UP_PASSWORD_WHY),
        ("photo.png", U.PDF, a._up_mismatch_why("png"))]
for label, send in PATHS:
    reset()
    outs = []
    for name, data, want in DISG:
        before = (n_evidence_files(), n_kpi_files())
        why, taken = send(name, data)
        outs.append((name, why == want, (not taken), (n_evidence_files(), n_kpi_files()) == before, why))
    s.check("%s: HTML in a .pdf, a macro docx, a locked xlsx and a PDF named .png each get their sentence and store nothing" % label,
            all(o[1] and o[2] and o[3] for o in outs), [o for o in outs if not (o[1] and o[2] and o[3])])
    reset()
    why, taken = send("proof.pdf", U.PDF)
    s.check("%s: a real PDF is taken, with no refusal" % label, taken and why is None and (n_evidence_files() + n_kpi_files()) == 1,
            (why, taken, n_evidence_files(), n_kpi_files()))
    reset()
    ok_all = []
    for ext in ("docx", "xlsx", "pptx", "doc", "png", "csv", "txt"):
        why, taken = send("real.%s" % ext, U.sample(ext))
        ok_all.append((ext, taken, why))
        reset()
    s.check("%s: a real Word, Excel, PowerPoint, old-format, image, CSV and text file are each taken" % label,
            all(t and w is None for _e, t, w in ok_all), [x for x in ok_all if not x[1]])
    # falsified: with the function turned off, the same request stores the disguised file
    real = a._upload_content_refusal
    a._upload_content_refusal = lambda ext, data: None
    try:
        reset()
        why, taken = send(*HTML_PDF[:2])
        s.check("%s, falsified: with the check switched off the same disguised file IS stored (so the test reaches the call)" % label,
                taken and (n_evidence_files() + n_kpi_files()) == 1, (why, taken))
    finally:
        a._upload_content_refusal = real
        reset()

with a.app.app_context():
    d = a.get_db()
    s.check("the files the suite stored are all gone (put back)",
            n_evidence_files() == 0 and n_kpi_files() == 0)

s.section("...and a lint: every writer of the attachment tables calls the function")
import glob  # noqa: E402

SHARED_WRITERS = {"app.py:performance_kpi_autosave", "app.py:performance_kpi_submit_all", "app.py:_review_attach_one",
                  "app.py:evidence_attach"}   # the four on the shared branch; the combined build (CSF) may carry more files, never fewer
STORES = ("pm_store_attachment", "evidence_store_attachment")
writers = {}
for fn_ in ["app.py"] + sorted(os.path.basename(x) for x in glob.glob(os.path.join(ROOT, "onehr_*.py"))):
    code = re.sub(r"(?m)^\s*#.*$", "", read(fn_))
    pts = [m.start() for m in re.finditer(r"INSERT INTO (pm_attachments|pm_evidence_attachments)\(", code)]
    pts += [m.start() for m in re.finditer(r"\b(%s)\(" % "|".join(STORES), code)
            if not code[max(0, m.start() - 4):m.start()].endswith("def ")]
    for pos in pts:
        i = code.rfind("\ndef ", 0, pos)
        j = min(x for x in (code.find("\ndef ", pos), code.find("\n@app.route", pos), len(code)) if x >= 0)
        body = code[i + 1:j]
        nm = re.match(r"def (\w+)\(", body).group(1)
        if nm not in STORES:   # the stores themselves (a docstring names the other)
            writers["%s:%s" % (fn_, nm)] = body


def _writer_ok(b):
    first_store = min([x for x in (b.find(t + "(") for t in STORES) if x >= 0] or [len(b)])
    cap = "EVIDENCE_ATTACH_MAX_BYTES" if "EVIDENCE_ATTACH_MAX_BYTES" in b else "PM_ATTACHMENT_MAX_BYTES"
    return ("_upload_content_refusal(" in b and b.index("_upload_content_refusal(") < first_store
            and (cap not in b or b.index(cap) < b.index("_upload_content_refusal(")))


s.check("the four shared writers are all found (autosave, bulk submit, the review attach, the evidence page), and no other file or "
        "function writes the attachment tables without the call below (a combined build with more writers still holds)",
        SHARED_WRITERS <= set(writers), sorted(writers))
s.check("every writer found calls _upload_content_refusal, after its extension and size checks and before it stores "
        "(any writer, shared or added by a merged branch, that does not fails here)",
        all(_writer_ok(b) for b in writers.values()), [n for n, b in writers.items() if not _writer_ok(b)])
s.check("...falsified: a writer with the call cut out, or the call moved after the store, fails the same predicate",
        not _writer_ok(writers["app.py:evidence_attach"].replace("_upload_content_refusal(", "_x("))
        and not _writer_ok(writers["app.py:evidence_attach"].replace("why = _upload_content_refusal(ext, data)", "why = None")
                           + "\n    _upload_content_refusal(ext, data)\n"))
s.check("the AI+ Learning T3 scan (pdf / jpg / png on disk) calls it too",
        "_upload_content_refusal(" in fn_source("lms_t3_save"))
s.check("the Learning certificate, quotation, programme photo and brochure keep their own first-bytes checks",
        "data[:5] == b\"%PDF-\"" in fn_source("_lms_ext_store") and 'data[:5] != b"%PDF-"' in fn_source("lms_programme_media"))
s.check("...falsified: a writer with the call cut out fails the lint's predicate",
        not ("_upload_content_refusal(" in fn_source("evidence_attach").replace("_upload_content_refusal(", "_x(")))
s.check("every call site passes the extension and the bytes, never the file name",
        all(re.search(r"_upload_content_refusal\((ext|ext\[1:\]), (data|file_bytes)\)", b) for b in writers.values()), "")

# ---------------------------------------------------------------------------------------------------------------------
s.section("3. the preview routes: nosniff always, a strict policy on an inline image or text, none on a PDF")
H_ = a._file_response_headers
IMG_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"
TXT_CSP = "default-src 'none'; style-src 'unsafe-inline'"
s.check("the policies are exactly the approved strings", a._FILE_CSP_IMAGE == IMG_CSP and a._FILE_CSP_TEXT == TXT_CSP)
rows_ = {e: H_("f." + e, e, "inline") for e in ("png", "jpg", "jpeg", "gif", "webp", "txt", "pdf")}
s.check("the helper: every inline image gets the sandboxed image policy",
        all(rows_[e].get("Content-Security-Policy") == IMG_CSP for e in ("png", "jpg", "jpeg", "gif", "webp")))
s.check("...inline text gets the text policy, with no sandbox (the box's Esc-inside-the-text needs the frame reachable)",
        rows_["txt"].get("Content-Security-Policy") == TXT_CSP and "sandbox" not in rows_["txt"]["Content-Security-Policy"])
s.check("...inline PDF gets none (a sandbox policy breaks Chrome's PDF viewer)", "Content-Security-Policy" not in rows_["pdf"])
s.check("...a download gets none, whatever the type, and every one has nosniff and an attachment disposition",
        all("Content-Security-Policy" not in H_("f." + e, e, "attachment") and H_("f." + e, e, "attachment")["Content-Disposition"].startswith("attachment;")
            for e in EXTS) and all(h["X-Content-Type-Options"] == "nosniff" for h in rows_.values()))
s.check("...the name goes through _attachment_header (quotes and non-Latin letters are handled)",
        H_('q"—x.png', "png", "inline")["Content-Disposition"] == a._attachment_header('q"—x.png', "inline")
        and H_(None, "pdf", "attachment")["Content-Disposition"] == a._attachment_header("file", "attachment"))

# the three routes, through the test client: a stored PNG, TXT, PDF and DOCX each way
with a.app.app_context():
    d = a.get_db()
    d.execute("UPDATE pm_evidence SET state='shared' WHERE id=?", (EID_DRAFT,))
    ev = a.get_db().execute("SELECT id FROM pm_evidence WHERE id=?", (EID_REV,)).fetchone()[0]
    d.execute("INSERT INTO pm_evidence_links(evidence_id, target_kind, target_ref) VALUES (?, 'kpi', ?)", (ev, str(T2)))
    AID = {}
    for ext in ("png", "txt", "pdf", "docx"):
        data = U.sample(ext)
        rel, be = a.evidence_store_attachment(ev, ext, data, "application/octet-stream")
        d.execute("INSERT INTO pm_evidence_attachments(evidence_id, filename, stored_path, content_type, size_bytes, storage_backend, "
                  "uploaded_by) VALUES (?,?,?,?,?,?,?)", (ev, "proof." + ext, rel, "text/html", len(data), be, subj["id"]))
        AID[ext] = d.execute("SELECT last_insert_rowid()").fetchone()[0]
    KP = {}
    for ext in ("png", "txt", "pdf", "docx"):
        data = U.sample(ext)
        path, be = a.pm_store_attachment(cid, T1 if ext == "png" else T2, "." + ext, data, "application/octet-stream")
        d.execute("DELETE FROM pm_attachments WHERE kpi_target_id=?", (T1 if ext == "png" else T2,))
        d.execute("INSERT INTO pm_attachments(kpi_target_id, filename, stored_path, content_type, size_bytes, uploaded_by, "
                  "storage_backend, draft) VALUES (?,?,?,?,?,?,?,0)",
                  (T1 if ext == "png" else T2, "line." + ext, path, "text/html", len(data), subj["id"], be))
        KP[ext] = T1 if ext == "png" else T2
        if ext != "png":
            break   # the legacy route holds one file a line: png on line one, txt on line two; pdf and docx are served by the others
    d.commit()
    KP_TXT_PATH = d.execute("SELECT 1").fetchone()


def hdr(resp, name):
    return resp.headers.get(name)


def check_route(label, url_for_ext, client):
    out = []
    for ext, want_csp in (("png", IMG_CSP), ("txt", TXT_CSP), ("pdf", None)):
        u = url_for_ext(ext)
        if u is None:
            continue
        inl, dl = client.get(u + "?disp=inline"), client.get(u)
        out.append((ext, inl.status_code, hdr(inl, "Content-Security-Policy"), hdr(inl, "X-Content-Type-Options"),
                    (hdr(inl, "Content-Disposition") or "")[:6], hdr(dl, "Content-Security-Policy"), hdr(dl, "X-Content-Type-Options"),
                    (hdr(dl, "Content-Disposition") or "")[:10], hdr(dl, "Cache-Control"), want_csp))
    ok = all(o[1] == 200 and o[2] == o[9] and o[3] == "nosniff" and o[4] == "inline" and o[5] is None and o[6] == "nosniff"
             and o[7] == "attachment" and o[8] == "no-store" for o in out)
    s.check("%s: inline PNG and TXT carry their policy and nosniff, inline PDF has none; the download is unchanged (attachment, nosniff, no-store)" % label,
            ok and len(out) >= 2, out)
    return out


check_route("evidence route (/evidence/attachment)", lambda e: "/evidence/attachment/%d" % AID[e], E)
check_route("admin route (/admin/users/<id>/kpi-file/evidence)", lambda e: "/admin/users/%d/kpi-file/evidence/%d" % (subj["id"], AID[e]), A)
legacy_ids = {r["kpi_target_id"]: r["id"] for r in H.rows(a, "SELECT id, kpi_target_id FROM pm_attachments WHERE kpi_target_id IN (?,?)", (T1, T2))}
leg = {"png": "/performance/kpi/%d/attachment" % T1 if T1 in legacy_ids else None,
       "txt": "/performance/kpi/%d/attachment" % T2 if T2 in legacy_ids else None, "pdf": None}
check_route("legacy KPI route (/performance/kpi/<id>/attachment)", lambda e: leg.get(e), E)
x = E.get("/evidence/attachment/%d?disp=inline" % AID["docx"])
s.check("a Word file with ?disp=inline still downloads, with no policy and nosniff",
        hdr(x, "Content-Disposition").startswith("attachment") and hdr(x, "Content-Security-Policy") is None
        and hdr(x, "X-Content-Type-Options") == "nosniff", dict(x.headers))
r = E.get("/evidence/attachment/%d?disp=inline" % AID["png"])
s.check("the global report-only policy rides along with the file's own (both present, they do not conflict)",
        "Content-Security-Policy-Report-Only" in r.headers and r.headers.get("Content-Security-Policy") == IMG_CSP, list(r.headers.keys()))
s.check("each of the three routes builds its headers with the one helper, none by hand",
        all("_file_response_headers(att[\"filename\"], ext, disp)" in fn_source(n)
            for n in ("performance_kpi_attachment_download", "evidence_attachment_download", "admin_person_kpi_file"))
        and not any('"X-Content-Type-Options": "nosniff"' in fn_source(n)
                    for n in ("performance_kpi_attachment_download", "evidence_attachment_download", "admin_person_kpi_file")))


def route_ok(resp):
    return hdr(resp, "Content-Security-Policy") == IMG_CSP and hdr(resp, "X-Content-Type-Options") == "nosniff"


class _Planted:   # a response with the policy cut out
    headers = {"X-Content-Type-Options": "nosniff"}


s.check("...falsified: a response without the policy fails the same predicate", not route_ok(_Planted()))
real_h = a._file_response_headers
a._file_response_headers = lambda f, e, d: {"Content-Disposition": a._attachment_header(f, d)}
try:
    gone = E.get("/evidence/attachment/%d?disp=inline" % AID["png"])
    s.check("...falsified: with the helper stripped, the live route fails the predicate (the route really uses it)", not route_ok(gone))
finally:
    a._file_response_headers = real_h
s.check("the file is served inline as the extension's type, never the stored (hostile) one",
        E.get("/evidence/attachment/%d?disp=inline" % AID["png"]).mimetype == "image/png")

# ---------------------------------------------------------------------------------------------------------------------
s.section("4. the preview box opens only OneHR's own addresses (static/file_preview.js, under node)")
s.check("the header comment says so", "ONLY ONEHR'S OWN ADDRESSES" in JS)
s.check("source: one resolver, new URL(.., location.href), http(s) and origin === location.origin",
        "new URL(String(u), location.href)" in JS and "an empty address would resolve to this very page" in JS and 'r.protocol === "http:" || r.protocol === "https:"' in JS
        and "r.origin === location.origin" in JS)
s.check("source: the click handler leaves a foreign link alone BEFORE it cancels anything, and open() refuses one too",
        re.search(r'if \(!sameOrigin\(a\.getAttribute\("data-fpv-src"\)\)\) return;[^\n]*\n\s*e\.preventDefault\(\); e\.stopPropagation\(\);', JS)
        is not None and 'var src = sameOrigin(a.getAttribute("data-fpv-src"))' in JS and "if (!src) return false;" in JS)
s.check("source: Download's href and Open in a new tab use only a checked address",
        'dl = sameOrigin(a.getAttribute("href")) || src' in JS and "nt.href = src;" in JS and "dla.href = dl;" in JS
        and "img.src = src;" in JS and "frame.src = src;" in JS)

NODE = shutil.which("node")
HARNESS = r'''
const fs = require("fs");
const code = fs.readFileSync(process.argv[1], "utf8");
function el(tag) {
  const e = { tag, children: [], attrs: {}, style: {}, className: "", listeners: {}, parentNode: null, hidden: false,
    textContent: "", classList: { add() {}, remove() {} }, dataset: {},
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }, focus() {}, contains() { return true; },
    closest(sel) { return sel === "a[data-fpv-src]" && this.attrs["data-fpv-src"] !== undefined ? this : null; } };
  return e;
}
const body = el("body"), clickers = [];
const doc = { body, documentElement: el("html"), createElement: el, createElementNS: (ns, t) => el(t),
  querySelector() { return null; }, contains() { return true; },
  addEventListener(t, f, cap) { if (t === "click") clickers.push(f); }, removeEventListener() {} };
const win = {};
const loc = new URL(process.argv[2]);
new Function("window", "document", "location", "URL", code)(win, doc, loc, URL);
const FP = win.onehrFilePreview;
const out = { exts: FP.exts, same: {}, click: {}, open: {} };
const urls = JSON.parse(process.argv[3]);
for (const u of urls) out.same[u] = FP.sameOrigin(u);
function link(src, name, href) {
  const a = el("a"); a.attrs["data-fpv-src"] = src; a.attrs["data-fpv-name"] = name; if (href != null) a.attrs.href = href; return a;
}
function click(a) {
  let prevented = false, stopped = false;
  const ev = { defaultPrevented: false, button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: a,
    preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } };
  const before = body.children.length;
  clickers.forEach(f => f(ev));
  const box = body.children.length > before ? body.children[body.children.length - 1] : null;
  const info = { prevented, stopped, opened: !!box, frame: null, newtab: null, download: null };
  if (box) {
    const walk = n => { (n.children || []).forEach(walk);
      if (n.tag === "iframe") info.frame = n.src; if (n.tag === "img") info.img = n.src;
      if (n.className === "fpv-newtab") info.newtab = n.href; if (n.className === "fpv-btn") info.download = n.href; };
    walk(box); box.parentNode && box.parentNode.removeChild(box);
  }
  return info;
}
for (const c of JSON.parse(process.argv[4])) {
  const a = link(c.src, c.name, c.href);
  out.click[c.id] = click(a);
  const b0 = body.children.length;
  let r; try { r = FP.open(a); } catch (e) { r = "threw " + e.message; }
  out.open[c.id] = { ret: r, opened: body.children.length > b0 };
  while (body.children.length > b0 - 0 && body.children.length > 0) body.removeChild(body.children[body.children.length - 1]);
}
console.log(JSON.stringify(out));
'''
URLS = ["https://pm.test/x", "/evidence/attachment/5?disp=inline", "evidence/attachment/5", "https://pm.test/evidence/attachment/5", "HTTPS://PM.TEST/x",
        "https://pm.test:443/x", "http://pm.test/x", "https://evil.test/evidence/attachment/5", "//evil.test/x", "https://pm.test.evil.test/x",
        "https://evil.test\\@pm.test/x", "https://pm.test@evil.test/x", "javascript:alert(1)", "data:text/html,<script>1</script>",
        "blob:https://pm.test/abc", "file:///etc/passwd", "ftp://pm.test/x", "http://", "", None, "  ", "https://pm.test:8443/x"]
CLICKS = [
    {"id": "own", "src": "/admin/users/1/kpi-file/evidence/9?disp=inline", "name": "a.pdf", "href": "/admin/users/1/kpi-file/evidence/9"},
    {"id": "own_abs", "src": "https://pm.test/evidence/attachment/9?disp=inline", "name": "a.png", "href": "https://pm.test/evidence/attachment/9"},
    {"id": "own_txt", "src": "/performance/kpi/3/attachment?disp=inline", "name": "n.txt", "href": "/performance/kpi/3/attachment"},
    {"id": "foreign", "src": "https://evil.test/a.pdf", "name": "a.pdf", "href": "https://evil.test/a.pdf"},
    {"id": "protocol_relative", "src": "//evil.test/a.png", "name": "a.png", "href": "/ok"},
    {"id": "js", "src": "javascript:alert(1)", "name": "a.pdf", "href": "/ok"},
    {"id": "data", "src": "data:text/html,<script>1</script>", "name": "a.txt", "href": "/ok"},
    {"id": "other_port", "src": "https://pm.test:8443/a.pdf", "name": "a.pdf", "href": "/ok"},
    {"id": "foreign_href_only", "src": "/ok/a.pdf?disp=inline", "name": "a.pdf", "href": "https://evil.test/dl"},
    {"id": "word_own", "src": "/ok/a.docx?disp=inline", "name": "a.docx", "href": "/ok/a.docx"},
]


def run_node(js_path):
    p = subprocess.run([NODE, "-e", HARNESS, "--", js_path, "https://pm.test/admin/users/1", json.dumps(URLS), json.dumps(CLICKS)],
                       capture_output=True, text=True, timeout=60)
    try:
        return json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        return {"error": (p.stderr or p.stdout)[-400:]}


def js_ok(o):
    if "error" in o:
        return False, o["error"]
    sm, ck, op = o["same"], o["click"], o["open"]
    good = ["/evidence/attachment/5?disp=inline", "evidence/attachment/5", "https://pm.test/evidence/attachment/5", "HTTPS://PM.TEST/x",
            "https://pm.test:443/x", "https://pm.test/x"]
    bad_urls = [u for u in URLS if u is not None and u.strip() and u not in good and u != "http://pm.test/x"]
    problems = []
    for u in good:
        if u == "https://pm.test:443/x" or u == "HTTPS://PM.TEST/x":
            if not sm.get(u):
                problems.append(("same-origin refused", u))
        elif not sm.get(u):
            problems.append(("same-origin refused", u))
    for u in bad_urls + ["http://pm.test/x", None, "  "]:
        k = u if u is not None else "null"
        if sm.get(k if u is not None else "null") not in ("", None):
            problems.append(("foreign accepted", u))
    for cid in ("own", "own_abs", "own_txt"):
        if not (ck[cid]["prevented"] and ck[cid]["opened"] and op[cid]["opened"]):
            problems.append(("own link did not open", cid))
    for cid in ("foreign", "protocol_relative", "js", "data", "other_port", "foreign_href_only_x"):
        if cid in ck and (ck[cid]["prevented"] or ck[cid]["opened"] or op[cid]["opened"]):
            problems.append(("foreign link handled", cid))
    if ck["foreign_href_only"]["opened"] and ck["foreign_href_only"]["download"] and "evil.test" in ck["foreign_href_only"]["download"]:
        problems.append(("a foreign href reached Download", ck["foreign_href_only"]))
    for cid in ("own", "own_txt"):
        i = ck[cid]
        shown = [x for x in (i.get("frame"), i.get("img"), i.get("newtab"), i.get("download")) if x]
        if not shown or any(not x.startswith("https://pm.test/") for x in shown):
            problems.append(("a shown address is not OneHR's own", cid, shown))
    if ck["word_own"]["prevented"] or ck["word_own"]["opened"]:
        problems.append(("a Word file opened in the box", "word_own"))
    return not problems, problems


if not NODE:
    s.check("node is available", False, "node not found")
else:
    o = run_node(os.path.join(ROOT, "static", "file_preview.js"))
    good, why = js_ok(o)
    s.check("under node: addresses resolved against the page - http(s) on this origin only (%d forms tried, incl. javascript:, data:, "
            "blob:, //host, userinfo tricks, another port and scheme)" % len(URLS), good, why)
    s.check("...an own link (relative, absolute, PDF, image, text) opens the box with only OneHR addresses in its frame, image, "
            "Open in a new tab and Download", good and o["click"]["own"]["frame"].startswith("https://pm.test/admin/") and
            o["click"]["own_abs"]["img"].startswith("https://pm.test/evidence/") and
            o["click"]["own"]["download"] == "https://pm.test/admin/users/1/kpi-file/evidence/9", o.get("click", {}).get("own"))
    s.check("...a foreign, protocol-relative, javascript:, data: or other-port link is not cancelled (it behaves as a plain link) and "
            "no box is built, from the click or from FP.open",
            all(not o["click"][c]["prevented"] and not o["click"][c]["opened"] and not o["open"][c]["opened"] and o["open"][c]["ret"] is False
                for c in ("foreign", "protocol_relative", "js", "data", "other_port")), {c: o["click"][c] for c in ("foreign", "js")})
    s.check("...a link whose href alone is foreign: the box opens on the own src and Download falls back to it, never the foreign href",
            o["click"]["foreign_href_only"]["opened"] and o["click"]["foreign_href_only"]["download"] == "https://pm.test/ok/a.pdf?disp=inline",
            o["click"]["foreign_href_only"])
    s.check("...Word, Excel and the rest still download as before (the click is not cancelled)",
            not o["click"]["word_own"]["prevented"] and not o["click"]["word_own"]["opened"])
    s.check("...the preview extensions are unchanged", set(o["exts"]) == set(a._ATTACH_INLINE_EXTS), o["exts"])
    # falsified: the resolver cut to "anything"
    import tempfile
    for lab, old, new in (("the origin test", "r.origin === location.origin", "true"),
                          ("the protocol test", '(r.protocol === "http:" || r.protocol === "https:")', "true"),
                          ("the click's guard", 'if (!sameOrigin(a.getAttribute("data-fpv-src"))) return;', ""),
                          ("open()'s guard", "if (!src) return false;", "")):
        assert JS.count(old) == 1, old
        d = tempfile.mkdtemp(prefix="onehr-tests-fp-")
        pth = os.path.join(d, "fp.js")
        open(pth, "w", encoding="utf-8").write(JS.replace(old, new))
        mg, mw = js_ok(run_node(pth))
        shutil.rmtree(d, ignore_errors=True)
        s.check("falsified: without %s the same node check fails" % lab, not mg, mw[:2] if mw else mw)

# ---------------------------------------------------------------------------------------------------------------------
s.section("5. what Help and the agents tell a person about the file")
REAL = a.EVIDENCE_ATTACH_REAL_TEXT
s.check("the sentence says the file must really be that kind and that macros or a password stop it, with no 'HR'",
        "really be that kind" in REAL and "macros" in REAL and "password" in REAL and "HR" not in REAL, REAL)
s.check("Help's KPI-file answer carries it, beside the limits and the types",
        REAL in a.HELP_QA["kpi_file"][1] and a.EVIDENCE_ATTACH_TYPES_TEXT in a.HELP_QA["kpi_file"][1])
s.check("the limits line the agent adds when it first asks for a file carries it",
        REAL in a._REVIEW_FILE_LIMIT_LINE and a._REVIEW_FILE_LIMIT_LINE.startswith("You can attach " + a._REVIEW_FILE_LIMIT_TEXT))
s.check("both agent prompts that describe the file limits carry it (the check-in's FILES step and the limits answer)",
        APP.count('+ EVIDENCE_ATTACH_REAL_TEXT + "') + APP.count('" + EVIDENCE_ATTACH_REAL_TEXT + " ') >= 2 and APP.count("EVIDENCE_ATTACH_REAL_TEXT") >= 5)
s.check("...no KB row, Ask OneHR fact or tour stop describes what can be attached, so none changed",
        "attach" not in read("static/onboarding.js").lower())
sys.exit(s.done())
