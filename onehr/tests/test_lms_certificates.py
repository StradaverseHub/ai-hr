"""AI+ Learning: course badges and CHART certificates (2026-10-23, LMS canvas section 20). Chris: "next is the badges
after user completes the training ... And the release or issuance of certificate to the participants", then "ok to
your suggestion, for the cert, issued it under CHART, and allow L&D admin to upload the template, and the portal should
help to assign the name, date, training detail etc."

What this suite holds:
  * a programme's setting: CHART's with the close by default, none for a briefing, held or the provider's when set; the
    programme form keeps it when the form doesn't send it
  * closing issues a numbered certificate (CHART-YYYY-NNNNN) to everyone who came every day, frozen with what it says
    (their HR-record name in proper case, the programme, hours, dates, venue, who delivered it, what it builds), and
    emails each their PDF; part of it and absent get none; a recount issues no second one and says who no longer came
    every day; L&D's hold tick holds them
  * held ones wait for L&D's release; the provider's are uploaded per person (a PDF, checked by its bytes); a briefing
    gives the badge with no certificate; by hand needs a reason and someone who came; revoking needs a reason, keeps the
    row, takes the badge, and the number is never reused
  * who opens one: the person, Group People L&D and the super admin, a BG admin for their own people; never another
    person, their line manager or another group's admin; a held one only L&D; L&D's download-all is one PDF a page
  * the template: L&D uploads CHART's design (a PNG or JPG, A4, big enough, re-made as a JPEG) and places the fields;
    bad files and bad places are refused and nothing is saved; a preview writes nothing; a BG admin can't change it;
    a certificate keeps the version it was made with
  * the person: Apply it's Completed card (until they open it), the queue, Progress's two badge shelves and How XP adds
    up, the dashboard row; completing adds no XP of its own; the line manager sees "certificate issued", not the file
  * the email kind, Help and the KB know it
Everything here is synthetic (ZZLC / ZZ9LC-) and removed at the end.
"""
import html
import io
import json
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning: course badges and CHART certificates")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO, OBG = "ZZLC Group", "ZZLC U1", "ZZLC Other"
_ENV0 = os.environ.get("ONEHR_LMS")
_MAIL0 = a.mailer.is_configured
TODAY = a._today_myt()
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
YEAR = TODAY.isoformat()[:4]


def D(n):
    return (TODAY + timedelta(days=n)).isoformat()


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LC-%' OR username LIKE 'zzlc-%'")]
    for f in db.execute("SELECT c.file_path FROM lms_certificates c JOIN lms_registrations r ON r.id=c.registration_id "
                        "JOIN lms_programmes p ON p.id=r.programme_id WHERE p.title LIKE 'ZZLC %'"):
        pth = a._lms_media_path(f[0])
        if pth:
            os.remove(pth)
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLC %'")
    if ul:
        ph = ",".join("?" * len(ul))
        for t in ("lms_certificates", "lms_registrations", "email_outbox", "lms_sent", "lms_attendance"):
            db.execute("DELETE FROM %s WHERE user_id IN (%s)" % (t, ph), ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group IN (?, ?)", (BG, OBG))
    db.commit()


def person(db, eid, mgr=None, bg=BG, co=CO):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, manager_id, confirmation_date, email) VALUES "
                      "(?,?, 'x', 'user', ?,?,?, 'ZZLC Sales', 'ZZLC Officer', '15', ?, '2020-01-01', ?)",
                      (eid.lower(), "ZZ LC " + eid.split("-")[1], eid, bg, co, mgr,
                       eid.lower() + "@zzlc.invalid")).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    TPL0 = [r[0] for r in db.execute("SELECT id FROM lms_cert_templates")]
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, CO))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'ZZLC O1')", (OBG,))
    MGR = person(db, "ZZ9LC-MGR")
    E1, E2, E3, E4, E5 = (person(db, "ZZ9LC-E%d" % i, MGR) for i in range(1, 6))
    STR = person(db, "ZZ9LC-STR")
    LND = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzlc-lnd', 'ZZ LC L&D', 'x', 'admin', ?)", (a.LMS_ADMIN_BG,)).lastrowid
    BGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzlc-bga', 'ZZ LC BG admin', 'x', 'admin', ?)", (BG,)).lastrowid
    OGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzlc-oga', 'ZZ LC other admin', 'x', 'admin', ?)", (OBG,)).lastrowid
    K = next(iter(a.lms_catalogue(db)["fam"]))
    KT = a.lms_catalogue(db)["fam"][K]["title"]

    def prog(title, kind="inhouse", mode=None, hours=14, days=2):
        pid = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days, vendor, cert_mode) VALUES "
                         "(?,?, 'published', ?,?, 'ZZLC Training Co', ?)", (title, kind, hours, days, mode)).lastrowid
        db.execute("INSERT INTO lms_programme_competencies(programme_id, comp_key, level, confirmed) VALUES (?,?, 4, 1)",
                   (pid, K))
        return pid

    def sess(pid, a_, b_):
        return db.execute("INSERT INTO lms_sessions(programme_id, starts_on, ends_on, start_time, end_time, venue, seats) "
                          "VALUES (?,?,?, '09:00', '17:00', 'ZZLC Room 2', 20)", (pid, D(a_), D(b_))).lastrowid

    def reg(uid, sid, pid):
        return db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json) VALUES "
                          "(?,?,?, 'approved', '[]')", (uid, sid, pid)).lastrowid

    def came(sid, uid, *days):
        for d_ in days:
            db.execute("INSERT INTO lms_attendance(session_id, on_date, user_id, method) VALUES (?,?,?, 'qr')",
                       (sid, D(d_), uid))
    P = prog("ZZLC Negotiation")
    S = sess(P, -4, -3)
    R1, R2, R3, R4, R5 = (reg(u_, S, P) for u_ in (E1, E2, E3, E4, E5))
    for u_ in (E1, E2, E5):
        came(S, u_, -4, -3)
    came(S, E3, -4)
    PH = prog("ZZLC Assessed", mode="held", hours=7, days=1)
    SH = sess(PH, -2, -2)
    RH = reg(E1, SH, PH)
    came(SH, E1, -2)
    PP = prog("ZZLC Lead Auditor", mode="provider", hours=7, days=1)
    SP = sess(PP, -2, -2)
    RP = reg(E2, SP, PP)
    came(SP, E2, -2)
    PB = prog("ZZLC Townhall", kind="briefing", hours=2, days=1)
    SB = sess(PB, -2, -2)
    RB = reg(E3, SB, PB)
    came(SB, E3, -2)
    P2 = prog("ZZLC Second Run", hours=7, days=1)
    S2 = sess(P2, -2, -2)
    R2B = reg(E4, S2, P2)
    came(S2, E4, -2)
    db.commit()


def one(sql, args=()):
    return H.one(a, sql, args)


def u_(uid):
    with a.app.app_context():
        return dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def call(fn, *args, **kw):
    with a.app.test_request_context():
        return fn(a.get_db(), *args, **kw)


def exe(sql, args=()):
    with a.app.app_context():
        d = a.get_db()
        d.execute(sql, args)
        d.commit()


def cert(rid, live=True):
    with a.app.app_context():
        r = a.get_db().execute("SELECT * FROM lms_certificates WHERE registration_id=?%s ORDER BY id DESC LIMIT 1" % (
            " AND status!='revoked'" if live else ""), (rid,)).fetchone()
        return dict(r) if r else None


def body(r):
    return html.unescape(r.get_data(as_text=True))


def close(c, sid, **kw):
    return c.post("/admin/learning/sessions/%d" % sid, data=dict({"csrf_token": "tok", "action": "close"}, **kw))


def act(c, sid, **kw):
    return c.post("/admin/learning/sessions/%d" % sid, data=dict({"csrf_token": "tok"}, **kw),
                  content_type="multipart/form-data")


def png(w, h):
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (250, 252, 244)).save(buf, "PNG")
    return buf.getvalue()


def pages(data):
    import pypdf
    return len(pypdf.PdfReader(io.BytesIO(data)).pages)


try:
    os.environ["ONEHR_LMS"] = "1"
    a.mailer.is_configured = (lambda: True)
    C1, C2, C3, C4, C5 = (H.client_as(a, x) for x in (E1, E2, E3, E4, E5))
    CM, CS, CL, CB, CO_, CSU = (H.client_as(a, x) for x in (MGR, STR, LND, BGA, OGA, SU["id"]))

    s.section("who gives a programme's certificate")
    with a.app.app_context():
        d0 = a.get_db()
        s.check("CHART's with the close by default; none for a briefing; held and the provider's when set",
                a.lms_cert_mode(d0.execute("SELECT * FROM lms_programmes WHERE id=?", (P,)).fetchone()) == "close" and
                a.lms_cert_mode(d0.execute("SELECT * FROM lms_programmes WHERE id=?", (PB,)).fetchone()) == "none" and
                a.lms_cert_mode(d0.execute("SELECT * FROM lms_programmes WHERE id=?", (PH,)).fetchone()) == "held" and
                a.lms_cert_mode(d0.execute("SELECT * FROM lms_programmes WHERE id=?", (PP,)).fetchone()) == "provider")
    form = {"title": "ZZLC Negotiation", "kind": "inhouse", "hours": "14", "days": "2"}
    call(a.lms_programme_save, u_(LND), PH, dict(form, title="ZZLC Assessed", hours="7", days="1"))
    s.check("the programme form keeps it when the form doesn't send it", one(
        "SELECT cert_mode FROM lms_programmes WHERE id=?", (PH,)) == "held")
    call(a.lms_programme_save, u_(LND), P2, dict(form, title="ZZLC Second Run", hours="7", days="1", cert_mode="none"))
    s.check("...sets it when it does", one("SELECT cert_mode FROM lms_programmes WHERE id=?", (P2,)) == "none")
    call(a.lms_programme_save, u_(LND), P2, dict(form, title="ZZLC Second Run", hours="7", days="1", cert_mode=""))
    s.check("...and blank is by its kind again", one("SELECT cert_mode FROM lms_programmes WHERE id=?", (P2,)) is None)
    pg = body(CL.get("/admin/learning/programmes?pick=%d" % P))
    s.check("the programme form offers the choice", 'name="cert_mode"' in pg and "held until L&D releases them" in pg)

    s.section("closing issues them")
    n_mail0 = one("SELECT COUNT(*) FROM email_outbox WHERE user_id IN (?,?,?)", (E1, E2, E5))
    pre = body(CL.get("/admin/learning/sessions/%d" % S))
    s.check("before closing, the confirm says how many get a certificate, with a hold tick",
            "About 3 who came every day get their course badge and their CHART certificate" in pre and
            'name="hold"' in pre)
    r = close(CB, S)
    s.check("a BG admin can't close it", r.status_code in (403, 404) and cert(R1) is None)
    r = close(CL, S)
    c1, c2, c5 = cert(R1), cert(R2), cert(R5)
    s.check("Group People L&D closes it: everyone who came every day has one, issued with the close",
            r.status_code == 302 and all(c_ and c_["status"] == "issued" and c_["how"] == "close" for c_ in (c1, c2, c5)))
    s.check("...part of it and absent have none", cert(R3) is None and cert(R4) is None)
    nums = sorted(c_["number"] for c_ in (c1, c2, c5))
    s.check("numbered in the year's CHART series, each its own", all(n.startswith("CHART-%s-" % YEAR) and len(n) == 16
                                                                    for n in nums) and len(set(nums)) == 3)
    v1 = json.loads(c1["fields_json"])
    s.check("what it says is frozen from the records: their HR-record name in proper case, the programme",
            v1["name"] == a.proper_name("ZZ LC E1") and v1["programme"] == "ZZLC Negotiation", v1)
    s.check("...hours, dates and venue", v1["details"].startswith("14 hours · ") and "ZZLC Room 2" in v1["details"] and
            a._lms_cert_dates(D(-4), D(-3)) in v1["details"], v1["details"])
    s.check("...who delivered it and what it builds, at its level", v1["delivered"] ==
            "Delivered by ZZLC Training Co · builds %s, Level 4" % KT, v1["delivered"])
    s.check("...the number and the date issued", v1["number"] == "Certificate no. " + c1["number"] and
            v1["issued"].startswith("Issued "))
    with a.app.app_context():
        mails = [dict(x) for x in a.get_db().execute("SELECT * FROM email_outbox WHERE user_id IN (?,?,?) ORDER BY id",
                                                      (E1, E2, E5))]
    att = json.loads(mails[-1]["attach_json"] or "[]") if mails else []
    s.check("each is emailed, once, with their PDF attached", len(mails) - n_mail0 == 3 and att and
            att[0]["name"].endswith(".pdf") and att[0]["content_type"] == "application/pdf" and
            __import__("base64").b64decode(att[0]["content_b64"]).startswith(b"%PDF"))
    s.check("...the email is a 'completed' one, and says CHART", "completed" in a.LMS_EMAIL_KINDS and
            one("SELECT COUNT(*) FROM lms_sent WHERE kind='completed' AND user_id=?", (E1,)) == 1 and
            "CHART certificate" in mails[-1]["body"])
    s.check("in the audit log", one("SELECT COUNT(*) FROM activity_log WHERE action='lms_session' AND detail LIKE "
                                    "'Session %d closed%%3 certificates issued%%'" % S) == 1)
    close(CL, S)
    s.check("a recount issues no second certificate, and the numbers stay", one(
        "SELECT COUNT(*) FROM lms_certificates WHERE registration_id IN (?,?,?)", (R1, R2, R5)) == 3 and
        cert(R1)["number"] == c1["number"])
    exe("DELETE FROM lms_attendance WHERE session_id=? AND user_id=? AND on_date=?", (S, E2, D(-3)))
    r = close(CL, S)
    flash = body(CL.get("/admin/learning/sessions/%d" % S))
    s.check("a recount where someone no longer came every day keeps theirs and says so", cert(R2) and
            cert(R2)["status"] == "issued" and "no longer came every day" in flash)
    exe("INSERT INTO lms_attendance(session_id, on_date, user_id, method) VALUES (?,?,?, 'qr')",
                    (S, D(-3), E2))
    close(CL, S)

    s.section("held, the provider's, none, by hand")
    close(CL, SH)
    s.check("a held programme's certificate waits, held", cert(RH) and cert(RH)["status"] == "held" and
            cert(RH)["issued_at"] is None)
    s.check("...the person can't open it yet, nor is it a badge", C1.get("/learning/certificate/%d" % cert(RH)["id"])
            .status_code == 404 and not any(b["rid"] == RH for b in call(a.lms_course_badges, E1)["badges"]) and
            any("release" in p_["why"] for p_ in call(a.lms_course_badges, E1)["pending"]))
    s.check("...L&D opens it", CL.get("/learning/certificate/%d" % cert(RH)["id"]).status_code == 200)
    r = act(CB, SH, action="cert_release", cid=str(cert(RH)["id"]))
    s.check("a BG admin can't release it", cert(RH)["status"] == "held")
    act(CL, SH, action="cert_release", cid=str(cert(RH)["id"]))
    s.check("L&D releases it: issued, a badge, emailed", cert(RH)["status"] == "issued" and cert(RH)["issued_at"] and
            any(b["rid"] == RH for b in call(a.lms_course_badges, E1)["badges"]) and
            one("SELECT COUNT(*) FROM lms_sent WHERE kind='completed' AND ref=?", ("cert:%d" % cert(RH)["id"],)) == 1)
    ok, _m = call(a.lms_close_session, u_(LND), S2, hold=True)
    s.check("L&D's hold tick at the close holds a programme's that would go with it", ok and cert(R2B) and
            cert(R2B)["status"] == "held")
    close(CL, SP)
    s.check("the provider's: none at the close", cert(RP) is None and any(
        "provider" in p_["why"] for p_ in call(a.lms_course_badges, E2)["pending"]))
    r = act(CL, SP, action="cert_upload", registration_id=str(RP), file=(io.BytesIO(b"not a pdf"), "c.pdf"))
    s.check("...a file that isn't a PDF is refused", cert(RP) is None)
    act(CL, SP, action="cert_upload", registration_id=str(RP), file=(io.BytesIO(PDF), "provider-cert.pdf"))
    cp = cert(RP)
    s.check("...L&D uploads theirs: issued, the provider's, kept as it came", cp and cp["how"] == "provider" and
            cp["status"] == "issued" and C2.get("/learning/certificate/%d" % cp["id"]).data == PDF)
    s.check("...with its badge", any(b["rid"] == RP for b in call(a.lms_course_badges, E2)["badges"]))
    close(CL, SB)
    bb = [b for b in call(a.lms_course_badges, E3)["badges"] if b["rid"] == RB]
    s.check("a briefing: the course badge, no certificate", cert(RB) is None and bb and bb[0]["cert"] is None)
    r = act(CL, S, action="cert_hand", registration_id=str(R3), reason="")
    s.check("by hand needs a reason", cert(R3) is None)
    r = act(CL, S, action="cert_hand", registration_id=str(R4), reason="ZZLC: please")
    s.check("...and someone who came", cert(R4) is None)
    act(CB, S, action="cert_hand", registration_id=str(R3), reason="ZZLC: made it up")
    s.check("...a BG admin can't", cert(R3) is None)
    act(CL, S, action="cert_hand", registration_id=str(R3), reason="ZZLC: made up day 2 in the next run")
    c3 = cert(R3)
    s.check("L&D issues one by hand to someone who came part of it, with the reason", c3 and c3["how"] == "hand" and
            c3["reason"] == "ZZLC: made up day 2 in the next run" and
            any(b["rid"] == R3 for b in call(a.lms_course_badges, E3)["badges"]))
    s.check("...their hours stay what they came to", one("SELECT hours FROM lms_registrations WHERE id=?", (R3,)) == 7)
    act(CL, S, action="cert_revoke", cert_id=str(c5["id"]), reason="")
    s.check("revoking needs a reason", cert(R5)["status"] == "issued")
    act(CL, S, action="cert_revoke", cert_id=str(c5["id"]), reason="ZZLC: attendance corrected")
    gone = cert(R5, live=False)
    s.check("L&D revokes one with the reason: the row stays, revoked", cert(R5) is None and gone["status"] == "revoked"
            and gone["revoke_reason"] == "ZZLC: attendance corrected")
    cb5 = call(a.lms_course_badges, E5)
    s.check("...the badge goes, and they read why", not any(b["rid"] == R5 for b in cb5["badges"]) and
            cb5["revoked"] and cb5["revoked"][0]["reason"] == "ZZLC: attendance corrected")
    s.check("...they can't open it", C5.get("/learning/certificate/%d" % c5["id"]).status_code == 404)
    act(CL, S, action="cert_hand", registration_id=str(R5), reason="ZZLC: checked again, came both days")
    s.check("issued again: a new number, never the old one", cert(R5) and cert(R5)["number"] != c5["number"] and
            one("SELECT COUNT(*) FROM lms_certificates WHERE number=?", (c5["number"],)) == 1)
    s.check("certificates are logged", one("SELECT COUNT(*) FROM activity_log WHERE action='lms_certificates' AND "
                                           "detail LIKE '%%revoked (ZZLC: attendance corrected)%%'") == 1)

    s.section("who opens a certificate")
    cid1 = c1["id"]
    r = C1.get("/learning/certificate/%d" % cid1)
    s.check("the person: their PDF", r.status_code == 200 and r.mimetype == "application/pdf" and
            r.data.startswith(b"%PDF") and pages(r.data) == 1)
    s.check("...opening it counts as seen", one("SELECT seen_at FROM lms_certificates WHERE id=?", (cid1,)) is not None)
    s.check("...Download sends it as a file", "attachment" in C1.get("/learning/certificate/%d?dl=1" % cid1)
            .headers.get("Content-Disposition", ""))
    s.check("...both forms carry the shared header helper's UTF-8 name (Latin-1 safe)", all(
        "filename*=UTF-8''" in h_ and h_.encode("latin-1") is not None for h_ in (
            C1.get("/learning/certificate/%d?dl=1" % cid1).headers.get("Content-Disposition", ""),
            C1.get("/learning/certificate/%d" % cid1).headers.get("Content-Disposition", ""))))
    s.check("someone else, and their line manager, can't", CS.get("/learning/certificate/%d" % cid1).status_code == 404
            and CM.get("/learning/certificate/%d" % cid1).status_code == 404)
    s.check("L&D, the super admin and their own group's admin can", all(
        c_.get("/learning/certificate/%d" % cid1).status_code == 200 for c_ in (CL, CSU, CB)))
    s.check("...another group's admin can't", CO_.get("/learning/certificate/%d" % cid1).status_code == 404)
    r = CL.get("/admin/learning/sessions/%d/certificates.pdf" % S)
    n_s = one("SELECT COUNT(*) FROM lms_certificates c JOIN lms_registrations r ON r.id=c.registration_id WHERE "
              "r.session_id=? AND c.status='issued' AND c.how!='provider'", (S,))
    s.check("L&D's download-all: one PDF, a page each", r.status_code == 200 and pages(r.data) == n_s == 4, n_s)
    s.check("...another group's admin gets none", CO_.get("/admin/learning/sessions/%d/certificates.pdf" % S)
            .status_code == 404)
    _PID = one("SELECT programme_id FROM lms_sessions WHERE id=?", (S,))
    _t0 = one("SELECT title FROM lms_programmes WHERE id=?", (_PID,))
    try:
        with a.app.app_context():
            _d = a.get_db()
            _d.execute("UPDATE lms_programmes SET title=? WHERE id=?", ("Quote \u2014 \u62a5\u4ef7\u5355 caf\u00e9", _PID))
            _d.commit()
        _cd = CL.get("/admin/learning/sessions/%d/certificates.pdf" % S).headers.get("Content-Disposition", "")
        s.check("a session title with an em dash and Chinese: Latin-1-safe header with filename*=UTF-8'' (the name kept)",
                _cd.startswith("inline;") and "filename*=UTF-8''Certificates%20-%20Quote%20%E2%80%94%20%E6%8A%A5" in _cd
                and _cd.encode("latin-1") is not None, _cd)
    finally:
        with a.app.app_context():
            _d = a.get_db()
            _d.execute("UPDATE lms_programmes SET title=? WHERE id=?", (_t0, _PID))
            _d.commit()
    pg = body(CL.get("/admin/learning/sessions/%d" % S))
    s.check("the session's Certificates section lists them, with the actions", "Certificates" in pg and
            c1["number"] in pg and "Revoke…" in pg and "Download all (one PDF)" in pg and
            "revoked" in pg and "ZZLC: attendance corrected" in pg)
    pgb = body(CB.get("/admin/learning/sessions/%d" % S))
    s.check("...a BG admin reads it, with no actions", c1["number"] in pgb and "Revoke…" not in pgb)

    s.section("the template: CHART's design, and where OneHR writes")
    n_t = one("SELECT COUNT(*) FROM lms_cert_templates")
    pg = body(CL.get("/admin/learning/certificates"))
    s.check("Settings › Certificates: the design, the fields to place, each programme's choice",
            "OneHR's plain CHART page" in pg or "CHART's design" in pg)
    s.check("...with what OneHR fills in, and the programmes", "Their name" in pg and "Hours, dates, venue" in pg and
            "ZZLC Negotiation" in pg and 'name="cert_mode"' in pg)

    def up(c, data, name="design.png"):
        return c.post("/admin/learning/certificates", data={"csrf_token": "tok", "action": "upload",
                                                             "design": (io.BytesIO(data), name)},
                      content_type="multipart/form-data")
    up(CL, b"plain text, not an image", "design.png")
    s.check("a file that isn't an image: refused, nothing saved", one("SELECT COUNT(*) FROM lms_cert_templates") == n_t)
    up(CL, png(800, 566))
    s.check("...nor one too small to print", one("SELECT COUNT(*) FROM lms_cert_templates") == n_t)
    up(CL, png(1800, 1800))
    s.check("...nor one that isn't A4", one("SELECT COUNT(*) FROM lms_cert_templates") == n_t)
    up(CB, png(1754, 1240))
    s.check("...a BG admin can't upload one", one("SELECT COUNT(*) FROM lms_cert_templates") == n_t)
    up(CL, png(1754, 1240))
    with a.app.app_context():
        t1 = a.lms_cert_template(a.get_db())
    s.check("an A4 PNG from L&D: saved as a new version, re-made as a JPEG", one(
        "SELECT COUNT(*) FROM lms_cert_templates") == n_t + 1 and t1["image_path"].endswith(".jpg") and
        open(a._lms_media_path(t1["image_path"]), "rb").read(3) == b"\xff\xd8\xff" and (t1["width"], t1["height"]) ==
        (1754, 1240))
    s.check("...the editor shows it", CL.get("/admin/learning/certificates/design/%d" % t1["id"]).status_code == 200)

    def place(c, fields, action="fields"):
        return c.post("/admin/learning/certificates", data={"csrf_token": "tok", "action": action,
                                                             "fields": json.dumps(fields)})
    good = [{"key": "name", "x": 0.1, "y": 0.4, "w": 0.8, "size": 30, "font": "serif", "bold": False, "color": "ink",
             "align": "center"},
            {"key": "programme", "x": 0.1, "y": 0.5, "w": 0.8, "size": 20, "font": "sans", "bold": True,
             "color": "navy", "align": "center"},
            {"key": "own", "text": "CERTIFICATE OF COMPLETION", "x": 0.1, "y": 0.3, "w": 0.8, "size": 22,
             "font": "sans", "bold": True, "color": "navy", "align": "center"}]
    n_t = one("SELECT COUNT(*) FROM lms_cert_templates")
    for bad, why in ((good[1:], "without their name"), ([dict(good[0], x=0.5, w=0.8)] + good[1:], "off the page"),
                     ([dict(good[0], key="salary")] + good[1:], "a field OneHR doesn't fill"),
                     (good + [dict(good[2], text="x" * 121)], "own words too long"),
                     ([dict(good[0], size=200)] + good[1:], "type too big")):
        place(CL, bad)
        s.check("placing refused %s: nothing saved" % why, one("SELECT COUNT(*) FROM lms_cert_templates") == n_t)
    r = place(CL, good, action="preview")
    s.check("a preview: a PDF, and nothing saved", r.status_code == 200 and r.mimetype == "application/pdf" and
            r.data.startswith(b"%PDF") and one("SELECT COUNT(*) FROM lms_cert_templates") == n_t)
    r = CL.post("/admin/learning/certificates", data={"csrf_token": "tok", "action": "preview",
                                                       "fields": json.dumps(good), "employee_id": "ZZ9LC-E1"})
    s.check("...for someone: their name and their latest course", r.status_code == 200 and b"%PDF" in r.data[:5])
    place(CB, good)
    s.check("a BG admin can't place them", one("SELECT COUNT(*) FROM lms_cert_templates") == n_t)
    place(CL, good)
    with a.app.app_context():
        t2 = a.lms_cert_template(a.get_db())
    s.check("L&D places them: a new version, on the same design", t2["id"] != t1["id"] and
            t2["image_path"] == t1["image_path"] and [f["key"] for f in t2["fields"]] == ["name", "programme", "own"])
    s.check("...logged", one("SELECT COUNT(*) FROM activity_log WHERE action='lms_certificates' AND detail LIKE "
                             "'%%the fields placed%%'") >= 1)
    old_tpl = cert(R1)["template_id"]
    act(CL, S, action="cert_hand", registration_id=str(R4), reason="ZZLC: never mind")   # still refused: absent
    exe("INSERT INTO lms_attendance(session_id, on_date, user_id, method) VALUES (?,?,?, 'qr')", (S, D(-4), E4))
    close(CL, S)
    act(CL, S, action="cert_hand", registration_id=str(R4), reason="ZZLC: made up both days")
    s.check("a certificate issued now uses the new version; one issued before keeps its own",
            cert(R4)["template_id"] == t2["id"] and cert(R1)["template_id"] == old_tpl and old_tpl != t2["id"])
    r = C4.get("/learning/certificate/%d" % cert(R4)["id"])
    s.check("...and it carries the design", r.status_code == 200 and b"/Subtype /Image" in r.data)
    if old_tpl is None:
        s.check("...while one issued on OneHR's plain page stays on it", b"/Subtype /Image" not in C1.get(
            "/learning/certificate/%d" % cid1).data)
    CL.post("/admin/learning/certificates", data={"csrf_token": "tok", "action": "plain"})
    with a.app.app_context():
        t3 = a.lms_cert_template(a.get_db())
    s.check("OneHR's plain page again: a new version with no design, the fields kept", t3["image_path"] is None and
            [f["key"] for f in t3["fields"]] == ["name", "programme", "own"])
    CL.post("/admin/learning/certificates", data={"csrf_token": "tok", "action": "mode", "programme_id": str(P2),
                                                  "cert_mode": "provider"})
    s.check("each programme's choice is set from the page too", one(
        "SELECT cert_mode FROM lms_programmes WHERE id=?", (P2,)) == "provider")

    s.section("what the person sees")
    exe("UPDATE lms_certificates SET seen_at=NULL WHERE registration_id=?", (R2,))
    pg = body(C2.get("/learning?view=mine&tab=apply"))
    s.check("Apply it: the Completed card with the course badge, the certificate and what comes next",
            "Completed · ZZLC Negotiation" in pg and "Download PDF" in pg and "1-month check-in" in pg and
            "Your line manager confirms" in pg and "The badge and certificate add no XP of their own" in pg)
    s.check("...the queue leads with it", "Your certificate · ZZLC Negotiation" in pg)
    with a.app.test_request_context():
        acts = (a.dash_learning(a.get_db(), u_(E2)) or {}).get("acts") or []
    s.check("the dashboard's row", any(x["title"] == "You've completed ZZLC Negotiation" and
                                       x["url"].startswith("/learning/certificate/") for x in acts))
    C2.get("/learning/certificate/%d" % cert(R2)["id"])
    pg = body(C2.get("/learning?view=mine&tab=apply"))
    s.check("once opened, the card goes (it stays under Progress)", "Completed · ZZLC Negotiation" not in pg)
    pg = body(C2.get("/learning?view=mine&tab=progress"))
    s.check("Progress: Courses completed, each with its certificate", "Courses completed" in pg and
            "ZZLC Negotiation" in pg and "ZZLC Lead Auditor" in pg and "/learning/certificate/" in pg)
    s.check("...Competencies applied, and How XP adds up", "Competencies applied" in pg and "How XP adds up" in pg and
            "Completing a course" in pg)
    with a.app.app_context():
        x1 = a.lms_xp(a.get_db(), [E1])[E1]
    s.check("completing adds no XP of its own: E1's is their hours", x1["total"] == 140 + 70, x1["total"])
    tv = body(CM.get("/learning?view=team&tab=team"))
    s.check("the line manager: who completed this month, certificate issued, never the file",
            "Completed this month" in tv and "zz lc e1" in tv.lower() and
            "certificate issued" in tv)
    with a.app.test_request_context():
        prog_ = a.lms_progress(a.get_db(), u_(E1))
    s.check("the dashboard's Learning panel has them too", prog_["course"]["badges"])

    s.section("Help, the KB, the registries")
    s.check("Help answers where the certificate is", "learn_cert" in a.HELP_LISTS["learn_apply"][1] and
            "CHART" in a.HELP_QA["learn_cert"][1])
    s.check("the KB says so", "CHART" in a._KB_AI_LEARNING_BODY and "course badge" in a._KB_AI_LEARNING_BODY)
    with a.app.test_request_context():
        ans = a._ask_intent("where is my certificate?", {"learn": {"x": 1}, "tools": {}})
    s.check("Ask OneHR answers where the certificate is, with a card to Progress", ans and "CHART" in ans["say"] and
            ans["cards"] and "tab=progress" in ans["cards"][0]["href"], ans)
    s.check("the routes are classified", a.ADMIN_ACCESS_MAP["admin_learning_certificates"]["default"] == "lms" and
            a.ADMIN_ACCESS_MAP["admin_learning_certificates"]["map"].get("preview") == "always" and
            "learning_certificate" in a.MODULE_UNGATED_ENDPOINTS)
    s.check("the schema text is the same in both", a._LMS_DDL.strip() in a.SCHEMA)
finally:
    a.mailer.is_configured = _MAIL0
    if _ENV0 is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = _ENV0
    with a.app.app_context():
        d = a.get_db()
        for t in d.execute("SELECT id, image_path FROM lms_cert_templates").fetchall():
            if t["id"] not in TPL0:
                pth = a._lms_media_path(t["image_path"])
                if pth and not d.execute("SELECT 1 FROM lms_cert_templates WHERE image_path=? AND id IN (%s)" % (
                        ",".join("?" * len(TPL0)) or "NULL"), [t["image_path"]] + TPL0).fetchone():
                    os.remove(pth)
                d.execute("UPDATE lms_certificates SET template_id=NULL WHERE template_id=?", (t["id"],))
                d.execute("DELETE FROM lms_cert_templates WHERE id=?", (t["id"],))
        d.commit()
        _cleanup(d)

sys.exit(s.done())
