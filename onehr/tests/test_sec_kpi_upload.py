"""A KPI line's file: an allowlist, the type by extension, a clean name, a safe download (security test 3-03, 2026-10-31).

  The KPI upload (autosave and the bulk submit) refused only seven extensions, kept the uploader's own Content-Type, and
  copied the raw file name into the download's Content-Disposition. Now:
    * the allowed types are EVIDENCE_ATTACH_EXTS, the evidence list, one constant (a type added there is allowed here);
    * the stored type is the extension's (_ATTACH_SERVE_TYPES), never the one the browser declared;
    * the stored name loses control characters, double quotes, any path and trailing spaces / dots, at most 200 characters
      with its extension kept;
    * the download is built with _attachment_header, typed by the name's extension; a file stored before still opens;
    * a refused file says so in plain words and writes nothing.

Drives both write routes and the download route for a person with two KPI lines (their own rows, put back after).
"""
import os
import re
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402
import upload_samples as US  # noqa: E402   # real bytes of each kind: an upload must be what its name says (2026-11-11)

a = H.setup(fresh_db=True)
s = H.Suite("A KPI line's file: allowlist, type by extension, clean name, safe download")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
from io import BytesIO  # noqa: E402

# ---- a person with two approved KPI lines in the active period -------------------------------------------------------
with a.app.app_context():
    db = a.get_db()
    cid = a.active_cycle_id(db)
    subj = db.execute("SELECT u.* FROM users u WHERE u.role!='admin' AND u.left_at IS NULL ORDER BY u.id LIMIT 1").fetchone()
    for tbl in ("pm_attachments", "pm_kpi_results"):
        db.execute("DELETE FROM %s WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?)" % tbl,
                   (cid, subj["id"]))
    db.execute("DELETE FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (cid, subj["id"]))
    TIDS = []
    for nm in ("ZZ Upload Line One", "ZZ Upload Line Two"):
        TIDS.append(db.execute(
            "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, unit, method, target, threshold, "
            "excellence, rate1, rate2, rate3, rate4, rate5, status, business_group, company, department) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'approved',?,?,?)",
            (cid, subj["id"], nm, 50.0, "%", "more", 90.0, 70.0, 100.0, 70.0, 80.0, 90.0, 95.0, 100.0,
             subj["business_group"] or "", subj["company"] or "", subj["department"] or "")).lastrowid)
    db.commit()
T1, T2 = TIDS
E = H.client_as(a, subj["id"])
s.check("(the person has two editable KPI lines)", len(TIDS) == 2 and H.one(
    a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (cid, subj["id"])) == 2)

BAD_TYPE = "text/html"   # what a hostile upload declares, whatever the file's name says


def _real_bytes(name):
    """Bytes of the kind the name says (an upload is checked for that, 2026-11-11); any other name gets a PDF's."""
    ext = name.rsplit(".", 1)[-1].strip().lower() if "." in name else ""
    try:
        return US.sample(ext)
    except ValueError:
        return US.PDF


def autosave(tid, name, data=None, declared=BAD_TYPE):
    data = _real_bytes(name) if data is None else data
    try:
        r = E.post("/performance/kpi/%d/autosave" % tid,
                   data={"csrf_token": "tok", "file": (BytesIO(data), name, declared)}, content_type="multipart/form-data")
    except Exception:   # the old code crashed on a NUL in a name (a 500 for the person)
        return 500, {}
    return r.status_code, (r.get_json(silent=True) or {})


def stored(tid):
    r = H.rows(a, "SELECT filename, content_type, stored_path, size_bytes, draft FROM pm_attachments WHERE kpi_target_id=?", (tid,))
    return dict(r[0]) if r else None


def wipe(tid):
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM pm_attachments WHERE kpi_target_id=?", (tid,))
        d.commit()


s.section("the evidence list is the KPI list: every allowed type stores, typed by its extension")
exts = sorted(a.EVIDENCE_ATTACH_EXTS)
bad = []
for ext in exts:
    wipe(T1)
    st, js = autosave(T1, "report.%s" % ext)
    row = stored(T1)
    if not (st == 200 and js.get("ok") and row and row["filename"] == "report." + ext
            and row["content_type"] == a._ATTACH_SERVE_TYPES.get(ext)):
        bad.append((ext, st, row and row["content_type"]))
s.check("%d allowed types (%s): stored with the type of the extension, not the declared %s"
        % (len(exts), ", ".join(exts), BAD_TYPE), not bad, bad)
s.check("every allowed extension has a served type (adding one to EVIDENCE_ATTACH_EXTS is one line plus its row)",
        all(e in a._ATTACH_SERVE_TYPES for e in exts), [e for e in exts if e not in a._ATTACH_SERVE_TYPES])
s.check("the extension is case-blind", (lambda r: r[0] == 200 and stored(T1)["content_type"] == a._ATTACH_SERVE_TYPES["pdf"])(
    (wipe(T1), autosave(T1, "REPORT.PDF"))[1]))

s.section("everything else is refused, says so in plain words, and writes nothing")
wipe(T1)
st0, _ = autosave(T1, "keep.pdf")
before = stored(T1)
RISKY = ["x.exe", "x.exe ", "x.EXE", "x.scr", "x.jar", "x.vbs", "x.lnk", "x.dll", "x.docm", "x.hta", "x.js", "x.php",
         "x.html", "x.svg", "x.bat", "x.sh", "x.msi", "x.zip", "x.eml", "x.psd", "x.exe.", "x.exe\x00", "noext", "", ".", "x.pdf.exe",
         "x.exe\u2028"]
res = [(n, autosave(T1, n)) for n in RISKY if n]
s.check("%d risky names refused with 400 and a message" % len(res),
        all(st == 400 and js.get("ok") is False and js.get("reason") == "bad_file" and js.get("message") for _n, (st, js) in res),
        [(n, st) for n, (st, js) in res if st != 400][:5])
s.check("...and the earlier file is untouched (a refusal writes nothing)", stored(T1) == before, stored(T1))
msg_exe = dict(res)["x.exe"][1]["message"]
s.check("the refusal sentence for a type: '.exe' files aren't allowed as evidence attachments -- use <list>.",
        msg_exe == "'.exe' files aren't allowed as evidence attachments -- use %s." % a.EVIDENCE_ATTACH_TYPES_TEXT, msg_exe)
msg_no = dict(res)["noext"][1]["message"]
s.check("the refusal sentence for no type at all",
        msg_no == "That file has no type (like .pdf), so it can't be attached -- use %s." % a.EVIDENCE_ATTACH_TYPES_TEXT, msg_no)
s.note("type refusal : %s" % msg_exe)
s.note("no-type refusal: %s" % msg_no)
st, js = autosave(T1, "big.pdf", data=b"x" * (a.PM_ATTACHMENT_MAX_BYTES + 1))
s.check("the 10 MB limit still holds, with its old sentence",
        st == 400 and js.get("message") == "That file is over the 10MB attachment limit.", (st, js))

s.section("the stored name is cleaned")
# the test client writes a name into the multipart header as a browser does: a quote arrives as %22 (Chrome) or \" (Firefox);
# a CR/LF or a Windows path cannot be carried through a header at all, so those are proved on the cleaner itself below
CLEAN = [('x.exe%22;.pdf', "x.exe;.pdf"), ('x.exe\\";.pdf', "x.exe;.pdf"), ("x.EXE\x00.pdf", "x.EXE.pdf"),
         ("../../etc/x.pdf", "x.pdf"), ("  report.pdf  ", "report.pdf"), ("x.pdf ", "x.pdf"), ("x.pdf.", "x.pdf"),
         ("Q3 John's %22final%22 plan.xlsx", "Q3 John's final plan.xlsx"), ("x.bat.txt", "x.bat.txt")]
bad = []
for raw, want in CLEAN:
    wipe(T1)
    st, js = autosave(T1, raw)
    row = stored(T1)
    if not (st == 200 and row and row["filename"] == want and js.get("filename") == want):
        bad.append((raw, want, row and row["filename"], st))
s.check("%d names: quotes, control characters, paths, backslashes, trailing spaces and dots are gone" % len(CLEAN), not bad, bad)
_clean = getattr(a, "_attach_clean_name", lambda n: n)
_check = getattr(a, "_kpi_attach_check", lambda n: (n, "." + n.rsplit(".", 1)[-1], None))
UNIT = [("C:\\fakepath\\x.pdf", "x.pdf"), ("a\r\nb.pdf", "ab.pdf"), ("x.pdf\u2028", "x.pdf"), ('"quoted".pdf', "quoted.pdf"),
        ("dir/sub\\y.docx", "y.docx"), ("\t\x0b x.csv\x7f", "x.csv"), ("", ""), ('""', ""), (None, "")]
s.check("the cleaner: Windows paths, CR/LF, line separators, quotes, DEL and tabs all go (%d cases)" % len(UNIT),
        all(_clean(raw) == want for raw, want in UNIT), [(raw, _clean(raw)) for raw, want in UNIT if _clean(raw) != want])
s.check("an extension hidden behind a control character or a trailing dot is read for what it is",
        _check("x.exe\r\n")[2] is not None and _check("x.exe.")[2] is not None and _check("x.exe\u2028")[2] is not None
        and _check("x.pdf\r\n")[0] == "x.pdf")
wipe(T1)
st, js = autosave(T1, ("a" * 5000) + ".pdf")
row = stored(T1)
s.check("a 5,000-character name is capped at 200 and keeps its .pdf",
        st == 200 and row and len(row["filename"]) == 200 and row["filename"].endswith(".pdf"), row and len(row["filename"]))
wipe(T1)
st, js = autosave(T1, ("b" * 400))
s.check("...and a long name with no type is refused", st == 400)
with a.app.app_context():
    s.check("no stored name holds a quote, a backslash or a control character",
            not any(re.search(r'["\\\x00-\x1f]', r["filename"] or "") for r in a.get_db().execute("SELECT filename FROM pm_attachments")))

s.section("the bulk submit: the same rule, all or nothing")
wipe(T1); wipe(T2)
FORM = {"csrf_token": "tok", "actual_value_%d" % T1: "95", "actual_value_%d" % T2: "92"}
r = E.post("/performance/submit-all", data=dict(FORM, **{"file_%d" % T1: (BytesIO(b"%PDF-1.4"), "ok.pdf", BAD_TYPE),
                                                       "file_%d" % T2: (BytesIO(b"MZ"), "x.exe ", "application/octet-stream")}),
           content_type="multipart/form-data", follow_redirects=False)
with a.app.test_request_context("/"):
    pass
page = E.get("/performance/my").get_data(as_text=True) if False else ""
s.check("a refused file on one line rejects the whole submission (no result rows, no files)",
        H.one(a, "SELECT COUNT(*) FROM pm_kpi_results WHERE kpi_target_id IN (?,?)", (T1, T2)) == 0
        and H.one(a, "SELECT COUNT(*) FROM pm_attachments WHERE kpi_target_id IN (?,?)", (T1, T2)) == 0, r.status_code)
with E.session_transaction() as ss:
    flashes = [m for _c, m in ss.get("_flashes", [])]
s.check("...and the page tells them which line and why, in the same sentence",
        any(m == "'ZZ Upload Line Two': '.exe' files aren't allowed as evidence attachments -- use %s."
            % a.EVIDENCE_ATTACH_TYPES_TEXT for m in flashes), flashes)
r = E.post("/performance/submit-all", data=dict(FORM, **{"file_%d" % T1: (BytesIO(b"%PDF-1.4"), 'ok%22.pdf ', BAD_TYPE),
                                                       "file_%d" % T2: (BytesIO(US.sample("pptx")), "../deck.pptx", BAD_TYPE)}),
           content_type="multipart/form-data", follow_redirects=False)
rows = {t: stored(t) for t in (T1, T2)}
s.check("two good files submit; names cleaned, types by extension, not final-as-draft",
        H.one(a, "SELECT COUNT(*) FROM pm_kpi_results WHERE kpi_target_id IN (?,?)", (T1, T2)) == 2
        and rows[T1]["filename"] == "ok.pdf" and rows[T1]["content_type"] == a._ATTACH_SERVE_TYPES["pdf"]
        and rows[T2]["filename"] == "deck.pptx" and rows[T2]["content_type"] == a._ATTACH_SERVE_TYPES["pptx"]
        and rows[T1]["draft"] == 0, rows)

with a.app.app_context():   # the submitted lines are locked: open them again for the rest
    d = a.get_db()
    d.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (?,?)", (T1, T2))
    d.commit()
s.section("the download")
st_dir = os.path.dirname(os.path.abspath(a.PM_UPLOAD_DIR))
LEGACY = []   # rows stored before this change, as the old code wrote them (raw name, the uploader's own type)


def legacy(tid, name, ctype, data=b"legacy bytes"):
    wipe(tid)
    d = os.path.join(a.PM_UPLOAD_DIR, "legacy-test", str(tid))
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, "old-%d" % len(LEGACY))
    with open(path, "wb") as fh:
        fh.write(data)
    LEGACY.append(path)
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO pm_attachments(kpi_target_id, filename, stored_path, storage_backend, content_type, "
                   "size_bytes, uploaded_by, draft) VALUES (?,?,?,'local',?,?,?,0)",
                   (tid, name, path, ctype, len(data), subj["id"]))
        db.commit()


def get(tid):
    r = E.get("/performance/kpi/%d/attachment" % tid)
    return r.status_code, r.headers.get("Content-Type", ""), r.headers.get("Content-Disposition", ""), r.data


legacy(T1, 'x.exe";.pdf', "text/html")
code, ctype, disp, body = get(T1)
s.check("an old file named x.exe\";.pdf declared text/html: still downloads (200, its bytes)", code == 200 and body == b"legacy bytes", code)
s.check("...typed by its extension (application/pdf), not the declared text/html", ctype.startswith("application/pdf"), ctype)
s.check("...as an attachment with a header that is one quoted name plus the UTF-8 form (no break-out)",
        re.fullmatch(r"attachment; filename=\"[^\"]*\"; filename\*=UTF-8''[^;\"]*", disp) is not None, disp)
legacy(T1, "page.html", "text/html")
code, ctype, disp, body = get(T1)
s.check("an old .html file (declared text/html) downloads as a plain stream, never as a page",
        code == 200 and ctype.startswith("application/octet-stream") and disp.startswith("attachment"), (code, ctype, disp))
for nm in ("noext", "x.exe ", "pic.svg"):
    legacy(T1, nm, "image/svg+xml")
    code, ctype, disp, body = get(T1)
    s.check("an old file named %r downloads as a plain stream" % nm, code == 200 and ctype.startswith("application/octet-stream"), (code, ctype))
legacy(T1, "a\r\nb\x00.pdf", "text/html")
code, ctype, disp, body = get(T1)
s.check("a control character in an old stored name never reaches the header raw",
        code == 200 and "\r" not in disp and "\n" not in disp and "\x00" not in disp, repr(disp))
wipe(T1)
autosave(T1, "mine.pdf")
code, ctype, disp, body = get(T1)
s.check("a new upload downloads with its extension's type and the standard header",
        code == 200 and ctype.startswith("application/pdf") and 'filename="mine.pdf"' in disp and "filename*=UTF-8''mine.pdf" in disp, (ctype, disp))
s.check("the nosniff header is on the download", E.get("/performance/kpi/%d/attachment" % T1).headers.get("X-Content-Type-Options") == "nosniff")

# ---- preview in a new tab (Chris, 2026-11-07): ?disp=inline only for an extension that previews --------------------------------
s.section("the preview: ?disp=inline by the extension rule")
for nm, want in (("mine.pdf", "application/pdf"), ("pic.png", "image/png"), ("note.txt", "text/plain")):
    wipe(T1)
    autosave(T1, nm)
    r = E.get("/performance/kpi/%d/attachment?disp=inline" % T1)
    s.check("%s with ?disp=inline: inline, typed by extension, nosniff, name kept" % nm,
            r.status_code == 200 and r.headers.get("Content-Disposition", "").startswith("inline;")
            and 'filename="%s"' % nm in r.headers.get("Content-Disposition", "") and r.mimetype == want
            and r.headers.get("X-Content-Type-Options") == "nosniff", (r.status_code, r.headers.get("Content-Disposition"), r.mimetype))
    r = E.get("/performance/kpi/%d/attachment" % T1)
    s.check("...falsified: %s without the parameter downloads" % nm, r.headers.get("Content-Disposition", "").startswith("attachment;"))
wipe(T1)
autosave(T1, "deck.pptx")
r = E.get("/performance/kpi/%d/attachment?disp=inline" % T1)
s.check("...falsified: a .pptx with ?disp=inline still downloads", r.status_code == 200
        and r.headers.get("Content-Disposition", "").startswith("attachment;") and r.headers.get("X-Content-Type-Options") == "nosniff",
        r.headers.get("Content-Disposition"))
legacy(T1, "page.html", "text/html")
r = E.get("/performance/kpi/%d/attachment?disp=inline" % T1)
s.check("...an old .html file with ?disp=inline still downloads as a plain stream, never a page",
        r.status_code == 200 and r.headers.get("Content-Disposition", "").startswith("attachment;")
        and r.mimetype == "application/octet-stream", (r.headers.get("Content-Disposition"), r.mimetype))
CAL = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "templates", "_calib_report_kpi.html"), encoding="utf-8").read()
m = re.search(r"<a class=\"small\"[^>]*>", CAL[CAL.index("{% if t['attachment'] %}"):])
s.check("the calibration report's KPI file link opens in the preview box (2026-11-07): href the plain download, data-fpv-src the inline url, no target",
        m is not None and "target=" not in m.group(0) and "performance_kpi_attachment_download', kpi_target_id=t['id']) }}\"" in m.group(0)
        and "data-fpv-src" in m.group(0) and "disp='inline'" in m.group(0)
        and "performance_kpi_attachment_download" in m.group(0), m and m.group(0))

s.section("what is left of the old rule")
SRC = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app.py"), encoding="utf-8").read()
s.check("the seven-extension blocklist is gone", "PM_ATTACHMENT_BLOCKED_EXT" not in SRC)
s.check("both write routes ask _kpi_attach_check; no route stores the uploader's own content type",
        SRC.count("_kpi_attach_check(f.filename)") == 2 and "f.content_type" not in
        SRC[SRC.index("def performance_kpi_autosave"):SRC.index("def performance_overall_remark_autosave")]
        and "f.content_type" not in SRC[SRC.index("def performance_kpi_submit_all"):SRC.index("def performance_kpi_attachment_download")])

# ---- put back ------------------------------------------------------------------------------------------------------
shutil.rmtree(os.path.join(a.PM_UPLOAD_DIR, "legacy-test"), ignore_errors=True)
for t in TIDS:
    for k in (os.path.join(a.PM_UPLOAD_DIR, str(cid), str(t)),):
        shutil.rmtree(k, ignore_errors=True)
sys.exit(s.done())
