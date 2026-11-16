"""KPI files open in a preview box (Chris, 2026-11-07; canvas [design canvas link removed], "Yes, as drawn").

Every place a KPI line's file opens draws a link whose href is the plain DOWNLOAD (no ?disp, no target) and whose data-fpv-*
attributes tell static/file_preview.js what to show; the one delegated script opens the box for a previewable extension and
leaves everything else to the browser, so Word / Excel / PowerPoint / CSV download as before and with no script every link
downloads. What this suite holds, each guard falsified (the same predicate on a planted bad copy fails):
  - base.html loads file_preview.js once, with the same cache-busting as its neighbours, and a rendered page carries it
  - the admin person page (Remarks and files) and the leaders' calibration report, RENDERED: every file link has the plain download
    href, data-fpv-src with disp=inline for the same file, the file name, the KPI name, a size; Group People's file carries
    data-fpv-gp and an employee's own does not
  - the four journey links built in script (employee Files column, the manager's chips, the leaders' views): source checks that each
    goes through fpvLink, which sets the same attributes and never a target or a disp on the href
  - the script's previewable extensions equal app.py _ATTACH_INLINE_EXTS (a lint), its image list is a subset, the click is
    delegated in the capture phase and leaves Ctrl / Cmd / Shift / Alt / non-primary clicks alone, and the box is the KPI pop-out's
    shell with Esc, x, Close, an overlay click, a focus trap, the page held still and focus given back
  - the server side is unchanged: the inline src answers inline, the href answers attachment, an Excel file with ?disp=inline
    still downloads
  - the CSS: the wide card, no red, colour tokens (the lints in test_colour_tokens / test_text_units / test_no_hover_underline
    hold the rest)
  - the script has no browser dialog calls
The model is never called. Its own synthetic people on a fresh copy of the database.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("KPI files open in a preview box")
ROOT = H.REPO
BG, CO = "ZZFP Group", "ZZFP Co Sdn Bhd"


def read(rel):
    return open(os.path.join(ROOT, rel), encoding="utf-8").read()


JS = read("static/file_preview.js")
JC = read("static/journey_chat.js")
CSS = read("static/style.css")
BASE = read("templates/base.html")

# ---------------------------------------------------------------------------------------------------------------------
# the fixture: a subject with three KPI lines, evidence files (PDF, Excel, a Group People PDF, an image) and a legacy per-line file
with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    PER = a.active_pm_period(db)["id"]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key IN ('review','calibration','pm','tm','idp','evidence')", (CID,))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, CO))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, name, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CO, years_of_service=5,
                 left_at=None, is_demo=0, job_grade="16", role="user", admin_bg=None, admin_role_id=None,
                 confirmation_date="2020-01-01", is_system_admin=0, display_name=None)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]
    LM = person("ZZFP-LM", "ZZ FP Linemanager")
    S = person("ZZFP-S", "ZZ FP Subject", manager_id=LM)
    SU = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL LIMIT 1").fetchone()[0]

    def kpi(name):
        tid = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, category, weightage, method, business_group, company, "
                         "status, rate1, rate2, rate3, rate4, rate5) VALUES (?,?,?, 'Financial', 50, 'more', ?, ?, 'approved', 1,2,3,4,5)",
                         (CID, S, name, BG, CO)).lastrowid
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (tid, LM))
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_at, submitted_by, draft) "
                   "VALUES (?, 4, datetime('now'), ?, 0)", (tid, S))
        return tid
    T_SALES = kpi("ZZFP Sales Revenue")
    T_COLL = kpi("ZZFP Collection Efficiency")

    def jfile(tid, name, data, uploaded_by=None):
        db.execute("INSERT INTO pm_evidence(subject_id, author_id, cycle_id, occurred_on, kind, title, state) "
                   "VALUES (?,?,?,date('now'),'recognition','ZZFP item','shared')", (S, S, CID))
        ev = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        db.execute("INSERT INTO pm_evidence_links(evidence_id, target_kind, target_ref) VALUES (?, 'kpi', ?)", (ev, str(tid)))
        stored, backend = a.evidence_store_attachment(ev, name.rsplit(".", 1)[-1], data, "application/octet-stream")
        db.execute("INSERT INTO pm_evidence_attachments(evidence_id, filename, stored_path, content_type, size_bytes, storage_backend, "
                   "uploaded_by) VALUES (?,?,?,?,?,?,?)", (ev, name, stored, "application/octet-stream", len(data), backend, uploaded_by or S))
        return db.execute("SELECT last_insert_rowid()").fetchone()[0]
    A_XLSX = jfile(T_SALES, "Q4 sales ledger.xlsx", b"xlsx-bytes")
    A_PDF = jfile(T_SALES, "Signed revenue summary.pdf", b"%PDF-1.4 zzfp", uploaded_by=SU)   # Group People added it
    A_JPG = jfile(T_COLL, "Customer accounts tally.jpg", b"\xff\xd8\xff\xe0zzfp")
    # the calibration report lists the per-line (legacy) file the employee attached
    path, backend = a.pm_store_attachment(PER, T_SALES, ".pdf", b"%PDF-1.4 legacy", "application/pdf")
    db.execute("INSERT INTO pm_attachments(kpi_target_id, filename, stored_path, content_type, size_bytes, uploaded_by, storage_backend, "
               "draft) VALUES (?, 'Delivery receipts Q2.pdf', ?, 'application/pdf', 215040, ?, ?, 0)", (T_SALES, path, S, backend))
    LEG = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    db.commit()

CS = H.client_as(a, SU)

# ---------------------------------------------------------------------------------------------------------------------
s.section("1. base.html loads the script once, like its neighbours")
tags = re.findall(r"<script src=\"\{\{ url_for\('static', filename='file_preview\.js'\) \}\}\?v=\{\{ asset_v \}\}\"></script>", BASE)
s.check("base.html loads static/file_preview.js once, with ?v={{ asset_v }}", len(tags) == 1, tags)
s.check("...before the page's own scripts (next to kpi_line.js, in the head)",
        BASE.index("file_preview.js") < BASE.index("</head>") and BASE.index("kpi_line.js") < BASE.index("file_preview.js"))
r = CS.get("/admin/users/%d?tab=performance" % S)
html = r.get_data(as_text=True)
s.check("a rendered admin person page carries the script", r.status_code == 200 and re.search(r"file_preview\.js\?v=\w+", html) is not None, r.status_code)
s.check("...and the journey, the admin person page and the calibration pages extend base.html, so every place a KPI file opens has it",
        all('{% extends "base.html" %}' in read("templates/" + f) for f in
            ("review_journey.html", "admin_person.html", "calibration_hod.html", "calibration_bg.html", "calibration_company.html",
             "talent_box.html", "pm_calibration_tier.html")))
s.check("...falsified: a base.html without the tag fails the same pattern",
        not re.findall(r"<script src=\"\{\{ url_for\('static', filename='file_preview\.js'\) \}\}\?v=\{\{ asset_v \}\}\"></script>",
                       BASE.replace("file_preview.js", "other.js")))


# ---------------------------------------------------------------------------------------------------------------------
def attrs(tag):
    return dict(re.findall(r'([\w-]+)="([^"]*)"', tag))


def link_ok(tag, name, kpi):
    """The shape every file link must have: plain download href, no target, the inline src of the SAME url, name, KPI name, size."""
    at = attrs(tag)
    href, src = at.get("href", ""), at.get("data-fpv-src", "")
    return (bool(href) and "disp" not in href and "target" not in at and "_blank" not in tag
            and src == href + ("&" if "?" in href else "?") + "disp=inline"
            and at.get("data-fpv-name") == name and at.get("data-fpv-kpi") == kpi and bool(at.get("data-fpv-size")))


s.section("2. the admin person page (Remarks and files), rendered")
pp = re.findall(r'<a class="pp-file-name"[^>]*>', html)
s.check("four file links render (an Excel, a PDF, an image and the per-line legacy PDF)", len(pp) == 4, pp)
by_name = {attrs(t).get("data-fpv-name"): t for t in pp}
s.check("each is a plain-download href with its inline src, name, KPI name and size",
        link_ok(by_name.get("Q4 sales ledger.xlsx", ""), "Q4 sales ledger.xlsx", "ZZFP Sales Revenue")
        and link_ok(by_name.get("Signed revenue summary.pdf", ""), "Signed revenue summary.pdf", "ZZFP Sales Revenue")
        and link_ok(by_name.get("Customer accounts tally.jpg", ""), "Customer accounts tally.jpg", "ZZFP Collection Efficiency")
        and link_ok(by_name.get("Delivery receipts Q2.pdf", ""), "Delivery receipts Q2.pdf", "ZZFP Sales Revenue"),
        pp)
s.check("the href is the admin route for that file, the src the same route with ?disp=inline",
        ("/admin/users/%d/kpi-file/evidence/%d" % (S, A_PDF)) in attrs(by_name["Signed revenue summary.pdf"])["href"]
        and attrs(by_name["Signed revenue summary.pdf"])["data-fpv-src"].endswith("?disp=inline"), by_name.get("Signed revenue summary.pdf"))
s.check("a file Group People added carries data-fpv-gp, the employee's own do not",
        'data-fpv-gp="1"' in by_name["Signed revenue summary.pdf"] and "data-fpv-gp" not in by_name["Q4 sales ledger.xlsx"]
        and "data-fpv-gp" not in by_name["Customer accounts tally.jpg"])
s.check("...falsified: the old new-tab link fails the same predicate (target=_blank and disp on the href)",
        not link_ok('<a class="pp-file-name" href="/x?disp=inline" target="_blank" rel="noopener" data-fpv-src="/x?disp=inline" '
                    'data-fpv-name="n.pdf" data-fpv-kpi="K" data-fpv-size="1 KB">', "n.pdf", "K")
        and not link_ok('<a href="/x" data-fpv-src="/x" data-fpv-name="n.pdf" data-fpv-kpi="K" data-fpv-size="1 KB">', "n.pdf", "K")
        and not link_ok('<a href="/x" data-fpv-src="/x?disp=inline" data-fpv-name="n.pdf" data-fpv-kpi="K">', "n.pdf", "K"))
s.check("Remove and Add a file are still on the line, outside the link",
        "pp-file-rm" in html and "pp-file-add" in html and all("pp-file-rm" not in t for t in pp))

s.section("3. the leaders' calibration report, rendered")
rc = CS.get("/calibration/subject/%d/kpi-report" % S)
ch = rc.get_data(as_text=True)
cal = re.findall(r'<a class="small"[^>]*data-fpv-src[^>]*>', ch, re.S)
s.check("the report renders its one file link", rc.status_code == 200 and len(cal) == 1, (rc.status_code, len(cal)))
cal_tag = re.sub(r"\s+", " ", cal[0]) if cal else ""
s.check("plain download href, inline src, name, KPI name and a size",
        link_ok(cal_tag, "Delivery receipts Q2.pdf", "ZZFP Sales Revenue"), cal_tag)
s.check("...the size reads as the app writes it (210 KB for 215040 bytes), the href is the attachment route",
        attrs(cal_tag).get("data-fpv-size") == "210 KB" and "/performance/kpi/%d/attachment" % T_SALES in attrs(cal_tag).get("href", ""), cal_tag)
s.check("...no target on the link, no disp on the href", "target=" not in cal_tag and "disp" not in attrs(cal_tag).get("href", ""))

s.section("4. the journey's script-built links go through fpvLink")
fn = JC[JC.index("function fpvLink("):]
fn = fn[:fn.index("function kpiMetaEl(")]
s.check("fpvLink: the href is the url with any ?disp=inline taken off, the src puts it back, no target and no rel left",
        'replace(/\\?disp=inline$/, "")' in fn and "a.href = dl;" in fn and 'removeAttribute("target")' in fn
        and 'setAttribute("data-fpv-src", dl + "?disp=inline")' in fn and "data-fpv-name" in fn and "data-fpv-kpi" in fn
        and "data-fpv-size" in fn and 'data-fpv-gp", "1"' in fn and "_blank" not in fn)
s.check("the employee's Files column (.rv-att-link) uses it with the payload's url, name, KPI, size and gp",
        "fpvLink(a, att.url, att.filename, l.base || l.kpi, att.size, att.gp)" in JC)
s.check("the manager's chips (.rv-mgr-file, two places) and the leaders' view (.rv-cal-file) use it on the evidence route",
        JC.count('fpvLink(a, "/evidence/attachment/" + f.id, f.name, l.base || l.kpi, f.size, f.gp)') == 2
        and 'fpvLink(a, "/evidence/attachment/" + f.id, f.name, k.base || k.kpi, f.size, f.gp)' in JC)
s.check("no journey link is still built as a new tab or with ?disp=inline on its href",
        'a.href = "/evidence/attachment/' not in JC and "a.href = att.url" not in JC
        and not re.search(r'a\.target = "_blank"; a\.rel = "noopener"; a\.title = att\.filename', JC), "")
s.check("...falsified: the old shape would be caught by the same patterns",
        'a.href = "/evidence/attachment/' in 'a.href = "/evidence/attachment/" + f.id + "?disp=inline"; a.target = "_blank";')
s.check("the payloads carry the size in bytes (the employee's, the manager's, the calibrators', the AI+ Performance view)",
        '"size": r["sz"]' in read("app.py") and read("app.py").count("_pm_file_chips(") == 4)

s.section("5. the script: extensions, delegation, the box")
m = re.search(r'var PREVIEW_EXTS = \[([^\]]*)\]', JS)
js_exts = set(re.findall(r'"(\w+)"', m.group(1))) if m else set()
s.check("the script's previewable extensions equal app.py _ATTACH_INLINE_EXTS", js_exts == set(a._ATTACH_INLINE_EXTS), (js_exts, a._ATTACH_INLINE_EXTS))
s.check("...falsified: a list missing one, or with one more, is unequal",
        js_exts - {"txt"} != set(a._ATTACH_INLINE_EXTS) and js_exts | {"docx"} != set(a._ATTACH_INLINE_EXTS))
m2 = re.search(r'var IMAGE_EXTS = \[([^\]]*)\]', JS)
img_exts = set(re.findall(r'"(\w+)"', m2.group(1))) if m2 else set()
s.check("the image list is the images in it (no pdf or txt); Word, Excel, PowerPoint and CSV are in neither",
        img_exts == {"png", "jpg", "jpeg", "gif", "webp"} and not ({"docx", "xlsx", "pptx", "csv", "doc", "xls"} & js_exts))
s.check("the click is delegated on a[data-fpv-src], in the capture phase (a chip's own stopPropagation must not hide it)",
        'closest("a[data-fpv-src]")' in JS and re.search(r'document\.addEventListener\("click", function \(e\) \{.*?\}, true\);', JS, re.S) is not None)
s.check("Ctrl / Cmd / Shift / Alt and a non-primary button keep the browser's default; a non-previewable file does too",
        "e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey" in JS
        and 'PREVIEW_EXTS.indexOf(extOf(a.getAttribute("data-fpv-name"))) < 0) return;' in JS)
s.check("only a previewable link is cancelled and opened (preventDefault + stopPropagation, then open)",
        re.search(r'< 0\) return;[^\n]*\n\s*if \(!sameOrigin\(a\.getAttribute\("data-fpv-src"\)\)\) return;[^\n]*\n\s*e\.preventDefault\(\); e\.stopPropagation\(\);\s*\n\s*open\(a\);', JS) is not None)
s.check("...and only for OneHR's own address (2026-11-11): http(s) with the page's origin, else the link behaves as a plain link "
        "(the node run is in test_upload_content)",
        "new URL(" in JS and "r.origin === location.origin" in JS and "sameOrigin(a.getAttribute(\"data-fpv-src\"))" in JS)
s.check("the box is the KPI pop-out's shell with the wide modifier",
        '"modal-overlay confirm-dialog kpi-dlg fpv-dlg"' in JS and "kpi-dlg-head" in JS and "kpi-dlg-foot" in JS and "kpi-dlg-x" in JS)
s.check("dialog semantics: role=dialog, aria-modal, aria-labelledby the title; focus goes in on open",
        'setAttribute("role", "dialog")' in JS and 'setAttribute("aria-modal", "true")' in JS and 'setAttribute("aria-labelledby", hid)' in JS
        and "x.focus(" in JS)
s.check("closes on x, Close, Esc and a click on the overlay itself; Tab is trapped",
        'x.addEventListener("click", close); cb.addEventListener("click", close);' in JS and 'e.key === "Escape"' in JS
        and "e.target === ov" in JS and 'e.key === "Tab"' in JS)
s.check("the page behind does not scroll (html overflow hidden, put back) and focus returns to the link without a scroll jump",
        'root.style.overflow = "hidden"' in JS and "root.style.overflow = savedOverflow" in JS and "preventScroll: true" in JS)
s.check("closing removes the box and blanks the frame, so a PDF stops loading",
        "ov.parentNode.removeChild(ov)" in JS and 'frame.src = "about:blank"' in JS)
s.check("PDF and TXT go in a same-origin iframe; an image is an <img> that reports its pixel size",
        'el("iframe", "fpv-frame")' in JS and 'el("img", "fpv-img")' in JS and "naturalWidth" in JS)
s.check("the foot: Open in a new tab (the inline src, _blank, noopener), Download (the plain href), Close",
        'nt.href = src; nt.target = "_blank"; nt.rel = "noopener"' in JS and "dla.href = dl" in JS and '"Close"' in JS
        and "Open in a new tab" in JS)
s.check("the head: the KPI name (title attribute carries the full), the file name, the size and the Group People tag",
        "eb.title = kpi" in JS and "h.title = name" in JS and "Added by Group People" in JS)
s.check("no browser confirm() or alert()", "confirm(" not in JS and "alert(" not in JS)

s.section("6. the server is unchanged: src answers inline, href answers attachment")
for nm, src_ok, plain, ctype in (
        ("admin route, PDF", "/admin/users/%d/kpi-file/evidence/%d" % (S, A_PDF), None, "application/pdf"),
        ("admin route, image", "/admin/users/%d/kpi-file/evidence/%d" % (S, A_JPG), None, "image/jpeg"),
        ("legacy KPI route, PDF (calibration report)", "/performance/kpi/%d/attachment" % T_SALES, None, "application/pdf"),
        ("evidence route, PDF (the journey)", "/evidence/attachment/%d" % A_PDF, None, "application/pdf")):
    inl = CS.get(src_ok + "?disp=inline")
    dl = CS.get(src_ok)
    s.check("%s: the src answers inline (%s), the plain href as an attachment" % (nm, ctype),
            inl.status_code == 200 and inl.headers.get("Content-Disposition", "").startswith("inline")
            and inl.mimetype == ctype and dl.status_code == 200 and dl.headers.get("Content-Disposition", "").startswith("attachment"),
            (inl.status_code, inl.headers.get("Content-Disposition"), inl.mimetype, dl.status_code, dl.headers.get("Content-Disposition")))
x_inl = CS.get("/admin/users/%d/kpi-file/evidence/%d?disp=inline" % (S, A_XLSX))
s.check("...falsified: an Excel file with ?disp=inline still downloads (the box never gets it, the server would not show it)",
        x_inl.status_code == 200 and x_inl.headers.get("Content-Disposition", "").startswith("attachment"), x_inl.headers.get("Content-Disposition"))
s.check("both routes send nosniff", CS.get("/admin/users/%d/kpi-file/evidence/%d?disp=inline" % (S, A_PDF)).headers.get("X-Content-Type-Options") == "nosniff")

s.section("7. the CSS: wide card, tokens, no red")
blk = CSS[CSS.index("KPI files open in a preview box over the same page"):]
if "PHONE VIEW, PIECE A" in blk:   # the phone section is the file's last block (2026-11-07) and has its own checks (test_phone_view): this block ends where it starts
    blk = blk[:blk.index("PHONE VIEW, PIECE A")]
s.check("the card is min(1040px, 100vw - 96px) wide and 100vh - 96px high, in the pop-out's overlay",
        "width: min(1040px, calc(100vw - 96px))" in blk and "height: calc(100vh - 96px)" in blk and ".fpv-dlg" in blk)
s.check("Close is the navy fill, Download is outlined navy, the foot link the link colour",
        ".fpv-btn.is-pri { background: var(--accent); color: var(--on-fill); }" in blk and "border: 1px solid var(--accent)" in blk
        and "color: var(--link)" in blk)
s.check("no literal colour, no red, no underline anywhere in the new block",
        not re.search(r"#[0-9a-fA-F]{3,8}\b|rgba?\(|\bwhite\b(?!-)|\bblack\b", blk) and "--ai" not in blk and "--red" not in blk
        and "--danger" not in blk and "underline" not in blk.replace("text-decoration: none", ""))
s.check("...falsified: a hex or a red token would be caught by the same patterns",
        re.search(r"#[0-9a-fA-F]{3,8}\b", "color: #d61923;") is not None and "--ai" in "background: var(--ai);")

sys.exit(s.done())
