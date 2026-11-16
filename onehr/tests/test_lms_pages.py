"""AI+ Learning: a programme's own page (Chris, 2026-10-22: "For all program detail view, admin can upload photo and
bronchure and the details"; canvas boards 8B, 15B; "ok, build all of it on staging").

What this suite holds:
  * the photo: JPG / PNG / WebP by name AND by its first bytes, 5 MB; the brochure: a PDF by name and bytes, 10 MB, its
    text kept for the agent; removing either; files stored in Learning's folder and served only from there
  * who sees what: staff see a published programme's page, photo and brochure; a draft is L&D's only (404 for staff);
    an admin who isn't L&D gets 404; a BG admin can't change a page
  * the details: saved by L&D, shown to staff (summary, what you'll be able to do, outline, who it's for, before you
    come, trainer)
  * the AI's proposals from the brochure: proposals only, red until L&D keeps one (then it's the page's text) or drops
    it; refused with no brochure, with no AI, and kept honest when the AI fails
  * the runs: seats left, Register, the waiting list when full, the person's own request, "not open to you" outside its
    audience; the rating with Gold from five ratings at 4.5
  * where it's linked: Mine's titles, the Learning panel's "Details"; logged
Everything here is synthetic (ZZLP / ZZ9LP-) and removed at the end.
"""
import html
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning: a programme's own page")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG = "ZZLP Group"
_ENV0 = os.environ.get("ONEHR_LMS")
_AI0, _DET0, _EXT0 = a.ai_draft.is_configured, a.ai_draft.lms_programme_details, a._attach_extract
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
PDF = b"%PDF-1.4\n" + b"x" * 64


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LP-%'")]
    for r in db.execute("SELECT photo_path, brochure_path FROM lms_programmes WHERE title LIKE 'ZZLP %'"):
        for f in r:
            if f and os.path.isfile(os.path.join(a.LMS_UPLOAD_DIR, f)):
                os.remove(os.path.join(a.LMS_UPLOAD_DIR, f))
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLP %'")
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM lms_registrations WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, grade="15", role="user", admin_bg=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, email, admin_bg, confirmation_date) VALUES "
                      "(?,?, 'x', ?, ?,?, 'ZZLP U1', 'ZZLP Sales', 'ZZLP Officer', ?, ?, ?, '2020-01-01')",
                      (eid.lower(), "ZZ LP " + eid.split("-")[1], role, eid, BG, grade,
                       eid.lower() + "@example.invalid", admin_bg)).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'ZZLP U1')", (BG,))
    E1, E2, LOW = person(db, "ZZ9LP-E1"), person(db, "ZZ9LP-E2"), person(db, "ZZ9LP-LOW", grade="9")
    RATERS = [person(db, "ZZ9LP-R%d" % i) for i in range(5)]
    LND = person(db, "ZZ9LP-LND", None, "admin", a.LMS_ADMIN_BG)
    BGA = person(db, "ZZ9LP-BGA", None, "admin", BG)
    P = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days, trainer, vendor, description, "
                   "audience_json) VALUES ('ZZLP Negotiation', 'inhouse', 'published', 14, 2, 'Ms ZZLP', 'ZZLP Training', "
                   "'ZZLP holding price', '{\"grade_min\": 13}')").lastrowid
    PD = db.execute("INSERT INTO lms_programmes(title, kind, status) VALUES ('ZZLP Draft', 'inhouse', 'draft')").lastrowid
    fam = next(iter(a.lms_catalogue(db)["fam"].values()), None)
    if fam:
        db.execute("INSERT INTO lms_programme_competencies(programme_id, comp_key, level, confirmed) VALUES (?,?,?,1)",
                   (P, fam["key"] if "key" in fam else next(iter(a.lms_catalogue(db)["fam"])), 3))

    def sess(day, seats):
        return db.execute("INSERT INTO lms_sessions(programme_id, run_label, starts_on, ends_on, seats, reg_cutoff) "
                          "VALUES (?, 'ZZLP run', date('now','+8 hours',?), date('now','+8 hours',?), ?, "
                          "date('now','+8 hours','+5 days'))", (P, day, day, seats)).lastrowid
    S_OPEN, S_FULL, S_PAST = sess("+20 days", 10), sess("+25 days", 1), sess("-20 days", 10)
    db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json) VALUES "
               "(?,?,?, 'approved', '[]')", (E2, S_FULL, P))
    for uid in RATERS:
        rid = db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json, outcome) "
                         "VALUES (?,?,?, 'approved', '[]', 'attended')", (uid, S_PAST, P)).lastrowid
        db.execute("INSERT INTO lms_ratings(registration_id, relevant, clear, apply, overall) VALUES (?,5,5,5,5)", (rid,))
    db.commit()


def one(sql, args=()):
    return H.one(a, sql, args)


def env(v):
    if v is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = v


def up(client, action, name, data, pid=P):
    return client.post("/admin/learning/programmes/page?pid=%d" % pid, data={
        "csrf_token": "tok", "action": action, "file": (io.BytesIO(data), name)}, content_type="multipart/form-data")


def txt(r):
    return html.unescape(r.get_data(as_text=True))


try:
    env("1")
    CL, CB, CS = H.client_as(a, LND), H.client_as(a, BGA), H.client_as(a, SU["id"])
    C1, C2, CLOW = H.client_as(a, E1), H.client_as(a, E2), H.client_as(a, LOW)

    s.section("the photo and the brochure")
    up(CL, "photo", "pic.gif", PNG)
    s.check("a photo by its name: JPG, PNG or WebP", not one("SELECT photo_path FROM lms_programmes WHERE id=?", (P,)))
    up(CL, "photo", "pic.png", b"GIF89a" + b"\x00" * 64)
    s.check("...and by its first bytes", not one("SELECT photo_path FROM lms_programmes WHERE id=?", (P,)))
    up(CL, "photo", "pic.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * (a.LMS_PHOTO_MAX_BYTES + 1))
    s.check("...up to 5 MB", not one("SELECT photo_path FROM lms_programmes WHERE id=?", (P,)))
    r = up(CB, "photo", "pic.png", PNG)
    s.check("a BG admin can't change a page", r.status_code == 403 and
            not one("SELECT photo_path FROM lms_programmes WHERE id=?", (P,)))
    up(CL, "photo", "pic.png", PNG)
    ph = one("SELECT photo_path FROM lms_programmes WHERE id=?", (P,))
    s.check("L&D uploads it, into Learning's folder", ph and ph.startswith("prog-%d-photo-" % P) and
            os.path.isfile(os.path.join(a.LMS_UPLOAD_DIR, ph)))
    a._attach_extract = lambda ext, data: ("ok", "ZZLP brochure: day 1 the walk-away, day 2 objections.")
    up(CL, "brochure", "b.docx", PDF)
    s.check("a brochure is a PDF by name", not one("SELECT brochure_path FROM lms_programmes WHERE id=?", (P,)))
    up(CL, "brochure", "b.pdf", b"not a pdf at all")
    s.check("...and by its bytes", not one("SELECT brochure_path FROM lms_programmes WHERE id=?", (P,)))
    up(CL, "brochure", "ZZLP-Negotiation.pdf", PDF)
    s.check("uploaded, its text kept for the agent", one(
        "SELECT brochure_name||'|'||brochure_text FROM lms_programmes WHERE id=?", (P,)) ==
        "ZZLP-Negotiation.pdf|ZZLP brochure: day 1 the walk-away, day 2 objections.")
    s.check("logged", one("SELECT COUNT(*) FROM activity_log WHERE action='lms_programme_page' AND user_id=?",
                          (LND,)) >= 2)
    r = C1.get("/learning/programme/%d/photo" % P)
    s.check("staff get the photo", r.status_code == 200 and r.mimetype == "image/png" and r.data == PNG)
    r = C1.get("/learning/programme/%d/brochure" % P)
    s.check("...and the brochure", r.status_code == 200 and r.mimetype == "application/pdf" and
            "ZZLP-Negotiation.pdf" in r.headers.get("Content-Disposition", ""))
    _bn = one("SELECT brochure_name FROM lms_programmes WHERE id=?", (P,))
    try:
        with a.app.app_context():
            _d = a.get_db()
            _d.execute("UPDATE lms_programmes SET brochure_name=? WHERE id=?", ("Brochure \u2014 \u62a5\u4ef7\u5355.pdf", P))
            _d.commit()
        r = C1.get("/learning/programme/%d/brochure" % P)
        _cd = r.headers.get("Content-Disposition", "")
        s.check("a brochure name with an em dash and Chinese: 200, inline, filename*=UTF-8'' carries it", r.status_code == 200
                and _cd.startswith("inline;") and "filename*=UTF-8''Brochure%20%E2%80%94%20%E6%8A%A5%E4%BB%B7%E5%8D%95.pdf" in _cd
                and _cd.encode("latin-1") is not None, _cd)
    finally:
        with a.app.app_context():
            _d = a.get_db()
            _d.execute("UPDATE lms_programmes SET brochure_name=? WHERE id=?", (_bn, P))
            _d.commit()
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE lms_programmes SET photo_path='../../app.py' WHERE id=?", (P,))
        db.commit()
    s.check("only from Learning's folder", C1.get("/learning/programme/%d/photo" % P).status_code == 404)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE lms_programmes SET photo_path=? WHERE id=?", (ph, P))
        db.commit()

    s.section("who sees what")
    s.check("a draft is L&D's only", C1.get("/learning/programme/%d" % PD).status_code == 404 and
            CL.get("/learning/programme/%d" % PD).status_code == 200)
    s.check("an admin who isn't L&D gets 404", CB.get("/learning/programme/%d" % P).status_code == 404)

    s.section("the details")
    CL.post("/admin/learning/programmes/page?pid=%d" % P, data={
        "csrf_token": "tok", "action": "details", "summary": "ZZLP Two days on holding price.",
        "outcomes": "Set a walk-away price\nTrade a concession, never give one", "outline": "Day 1 · preparing\nDay 2 · in the room",
        "audience_text": "ZZLP sales staff who quote prices", "prereq": "ZZLP two lost quotes"})
    pg = txt(C1.get("/learning/programme/%d" % P))
    s.check("staff see them", all(t_ in pg for t_ in (
        "ZZLP Two days on holding price.", "Set a walk-away price", "Trade a concession, never give one",
        "Day 1 · preparing", "ZZLP sales staff who quote prices", "ZZLP two lost quotes", "Ms ZZLP, ZZLP Training")))
    s.check("...the photo and the brochure", "/learning/programme/%d/photo" % P in pg and
            "/learning/programme/%d/brochure" % P in pg)

    s.section("the AI's proposals")
    a.ai_draft.is_configured = lambda: True
    a.ai_draft.lms_programme_details = lambda title, text, timeout=25: {
        "summary": "ZZLP AI summary", "outcomes": ["ZZLP AI outcome one", "ZZLP AI outcome two"], "prereq": ""}
    CL.post("/admin/learning/programmes/page?pid=%d" % P, data={"csrf_token": "tok", "action": "ai_fill"})
    s.check("proposals only: the page's text unchanged", one("SELECT summary FROM lms_programmes WHERE id=?", (P,)) ==
            "ZZLP Two days on holding price." and "ZZLP AI summary" in one(
                "SELECT details_ai_json FROM lms_programmes WHERE id=?", (P,)))
    pg = txt(CL.get("/admin/learning/programmes/page?pid=%d" % P))
    s.check("...shown red until kept", "proposed from the brochure, check it" in pg and "ZZLP AI summary" in pg)
    s.check("...never to staff", "ZZLP AI summary" not in txt(C1.get("/learning/programme/%d" % P)))
    CL.post("/admin/learning/programmes/page?pid=%d" % P, data={"csrf_token": "tok", "action": "keep", "field": "summary"})
    s.check("kept: it's the page's text", one("SELECT summary FROM lms_programmes WHERE id=?", (P,)) == "ZZLP AI summary"
            and "ZZLP AI summary" not in (one("SELECT details_ai_json FROM lms_programmes WHERE id=?", (P,)) or ""))
    CL.post("/admin/learning/programmes/page?pid=%d" % P, data={"csrf_token": "tok", "action": "drop", "field": "outcomes"})
    s.check("dropped: gone, the page's own text stays", one("SELECT details_ai_json FROM lms_programmes WHERE id=?",
                                                            (P,)) is None and "Set a walk-away price" in one(
        "SELECT outcomes FROM lms_programmes WHERE id=?", (P,)))

    def boom(title, text, timeout=25):
        raise a.ai_draft.AIDraftError("x")
    a.ai_draft.lms_programme_details = boom
    with a.app.app_context():
        db = a.get_db()
        lnd = db.execute("SELECT * FROM users WHERE id=?", (LND,)).fetchone()
        ok, msg = a.lms_programme_ai_fill(db, lnd, P)
        s.check("the AI failing: said, nothing proposed", not ok and "couldn't" in msg and
                one("SELECT details_ai_json FROM lms_programmes WHERE id=?", (P,)) is None)
        ok, msg = a.lms_programme_ai_fill(db, lnd, PD)
        s.check("no brochure: refused", not ok and "brochure" in msg)
        a.ai_draft.is_configured = lambda: False
        ok, msg = a.lms_programme_ai_fill(db, lnd, P)
        s.check("no AI here: refused", not ok)

    s.section("the runs, the rating")
    pg = txt(C1.get("/learning/programme/%d" % P))
    s.check("seats left (as 'N left of M', 2026-10-23) and Register", "10 left of 10" in pg and "/learning/register?session=%d" % S_OPEN in pg)
    s.check("full: the waiting list", "Join the waiting list" in pg)
    s.check("a past run isn't listed", pg.count("ZZLP run") == 2)
    s.check("the rating, Gold from five at 4.5", "Rated 5.0 by 5 who came · Gold" in pg)
    pg2 = txt(C2.get("/learning/programme/%d" % P))
    s.check("their own request instead of Register", "Confirmed" in pg2 and "See it" in pg2)
    pgl = txt(CLOW.get("/learning/programme/%d" % P))
    s.check("outside its audience: not open to them", "Not open to you" in pgl and
            "/learning/register?session=" not in pgl)

    s.section("where it's linked")
    pg = txt(C2.get("/learning"))
    s.check("Mine's titles open the page", "/learning/programme/%d" % P in pg)
    s.check("the registry", {"learning_programme", "learning_programme_file"} <= a.MODULE_UNGATED_ENDPOINTS and
            a.ADMIN_ACCESS_MAP.get("admin_learning_programme_page") == "lms" and "lms_programme_page" in a.ACTION_LABELS)
    s.check("the schema text is the same in both", all(t_ in a._LMS_DDL and t_ in a.SCHEMA for t_ in (
        "brochure_text TEXT", "photo_path TEXT", "details_ai_json TEXT")))
    env(None)
    s.check("dark: the page is a 404", C1.get("/learning/programme/%d" % P).status_code == 404)
finally:
    env(_ENV0)
    a.ai_draft.is_configured, a.ai_draft.lms_programme_details, a._attach_extract = _AI0, _DET0, _EXT0
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
sys.exit(s.done())
