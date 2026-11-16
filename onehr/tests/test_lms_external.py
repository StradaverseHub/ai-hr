"""AI+ Learning's gap check, wave 3 (2026-10-23): an external course end to end (canvas boards 18E, 18F). Chris asked
whether employees can request their own training, e.g. an external course: they could; its after-life was missing.

What this suite holds:
  * the request takes the quotation or brochure (a PDF, 10 MB); anything else is refused and nothing is sent; the
    approvers at their step, Group People L&D and the person open it; nobody else does
  * once it's over the person is asked for the certificate: on Mine (Apply it, the queue), on the dashboard, and by
    email the day after, once
  * the certificate (a PDF or a photo, checked by its bytes) goes to L&D to check; only the person and L&D open it
  * no hours and no check-ins until L&D checks it; checking credits the hours (as asked, or as L&D gives them), starts
    the check-ins and earns the XP, in the audit log; "didn't attend" needs the reason and closes it with none; the
    person can say they didn't go, with why; a BG admin can't check
  * L&D's Requests › External courses lists them by where they are, with counts; a BG admin reads their own group's
  * an HRDC-claimable external course is its own row on the HRDC board, recorded like a session's filing
  * the calendar file works for an external course
  * external courses already counting before this keep counting, once
Everything here is synthetic (ZZLX / ZZ9LX-) and removed at the end.
"""
import html
import io
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning gap check, wave 3: external courses end to end")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO, OBG = "ZZLX Group", "ZZLX U1", "ZZLX Other"
_ENV0 = os.environ.get("ONEHR_LMS")
_MAIL0, _SCREEN0 = a.mailer.is_configured, a.ai_draft.screen_message
TODAY = a._today_myt()
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def D(n):
    return (TODAY + timedelta(days=n)).isoformat()


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LX-%' OR username LIKE 'zzlx-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        for f in db.execute("SELECT ext_doc, cert_path FROM lms_registrations WHERE user_id IN (%s)" % ph, ul):
            for name in (f[0], f[1]):
                p = a._lms_media_path(name)
                if p:
                    os.remove(p)
        for t in ("lms_registrations", "email_outbox", "lms_sent"):
            db.execute("DELETE FROM %s WHERE user_id IN (%s)" % (t, ph), ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group IN (?, ?)", (BG, OBG))
    db.commit()


def person(db, eid, mgr=None, bg=BG, co=CO):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, manager_id, confirmation_date, email) VALUES "
                      "(?,?, 'x', 'user', ?,?,?, 'ZZLX Sales', 'ZZLX Officer', '15', ?, '2020-01-01', ?)",
                      (eid.lower(), "ZZ LX " + eid.split("-")[1], eid, bg, co, mgr,
                       eid.lower() + "@zzlx.invalid")).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, CO))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'ZZLX O1')", (OBG,))
    MGR = person(db, "ZZ9LX-MGR")
    E1, E2, E3 = (person(db, "ZZ9LX-E%d" % i, MGR) for i in (1, 2, 3))
    STR = person(db, "ZZ9LX-STR")
    LND = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzlx-lnd', 'ZZ LX L&D', 'x', 'admin', ?)", (a.LMS_ADMIN_BG,)).lastrowid
    BGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzlx-bga', 'ZZ LX BG admin', 'x', 'admin', ?)", (BG,)).lastrowid
    OGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzlx-oga', 'ZZ LX other admin', 'x', 'admin', ?)", (OBG,)).lastrowid
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


def reg(rid):
    with a.app.app_context():
        return dict(a.get_db().execute("SELECT * FROM lms_registrations WHERE id=?", (rid,)).fetchone())


def ask(c, title, cost="800", hrdc=True, f=None):
    data = {"csrf_token": "tok", "ext_title": title, "ext_provider": "ZZLX Institute", "ext_starts_on": D(10),
            "ext_ends_on": D(11), "ext_hours": "14", "cost": cost, "why": "ZZLX: our new credit policy needs it."}
    if hrdc:
        data["hrdc_claimable"] = "1"
    if f:
        data["quote"] = f
    return c.post("/learning/request", data=data, content_type="multipart/form-data")


def approve(rid):
    for who in (MGR, LND):
        if reg(rid)["status"] == "pending":
            call(a.lms_decide, u_(who), rid, "approve", "ZZLX ok")


def end_it(rid, days_ago=1):   # the course has run: its dates move into the past
    exe("UPDATE lms_registrations SET ext_starts_on=?, ext_ends_on=? WHERE id=?", (D(-days_ago - 1), D(-days_ago), rid))


def body(r):
    return html.unescape(r.get_data(as_text=True))


try:
    os.environ["ONEHR_LMS"] = "1"
    a.ai_draft.screen_message = (lambda m: None)
    C1, C2, C3 = (H.client_as(a, x) for x in (E1, E2, E3))
    CM, CS, CL, CB, CO_ = (H.client_as(a, x) for x in (MGR, STR, LND, BGA, OGA))

    s.section("the request, with its quotation")
    pg = body(C1.get("/learning/request"))
    s.check("the form takes a file: the quotation or brochure, and names Group People L&D's step",
            'enctype="multipart/form-data"' in pg and 'name="quote"' in pg and "first, then Group People L&D" in pg)
    n0 = one("SELECT COUNT(*) FROM lms_registrations WHERE user_id=?", (E1,))
    r = ask(C1, "ZZLX Bad Quote", f=(io.BytesIO(b"just text"), "quote.txt"))
    s.check("a file that isn't a PDF: refused, and nothing is sent", one(
        "SELECT COUNT(*) FROM lms_registrations WHERE user_id=?", (E1,)) == n0)
    r = ask(C1, "ZZLX Photo Quote", f=(io.BytesIO(PNG), "quote.png"))
    s.check("...a photo isn't a quotation either: it's a PDF", one(
        "SELECT COUNT(*) FROM lms_registrations WHERE user_id=?", (E1,)) == n0)
    r = ask(C1, "ZZLX Fake Pdf", f=(io.BytesIO(b"not really"), "quote.pdf"))
    s.check("...nor one named .pdf that isn't one", one("SELECT COUNT(*) FROM lms_registrations WHERE user_id=?", (E1,))
            == n0)
    r = ask(C1, "ZZLX Credit Risk", f=(io.BytesIO(PDF), "quotation-zzlx.pdf"))
    R1 = one("SELECT id FROM lms_registrations WHERE user_id=? AND ext_title='ZZLX Credit Risk'", (E1,))
    s.check("with a PDF: sent, the quotation kept", r.status_code == 302 and R1 and reg(R1)["ext_doc_name"] ==
            "quotation-zzlx.pdf" and a._lms_media_path(reg(R1)["ext_doc"]))
    q = "/learning/req/%d/quote" % R1
    s.check("the line manager at their step opens it", CM.get(q).status_code == 200 and
            CM.get(q).data.startswith(b"%PDF"))
    _qn = reg(R1)["ext_doc_name"]
    try:
        with a.app.app_context():
            _d = a.get_db()
            _d.execute("UPDATE lms_registrations SET ext_doc_name=? WHERE id=?", ("Quote \u2014 \u62a5\u4ef7\u5355.pdf", R1))
            _d.commit()
        _r = C1.get(q)
        _cd = _r.headers.get("Content-Disposition", "")
        s.check("a quotation named with an em dash and Chinese: 200, inline, filename*=UTF-8'' carries it", _r.status_code == 200
                and _cd.startswith("inline;") and "filename*=UTF-8''Quote%20%E2%80%94%20%E6%8A%A5%E4%BB%B7%E5%8D%95.pdf" in _cd
                and _cd.encode("latin-1") is not None, _cd)
    finally:
        with a.app.app_context():
            _d = a.get_db()
            _d.execute("UPDATE lms_registrations SET ext_doc_name=? WHERE id=?", (_qn, R1))
            _d.commit()
    s.check("...the person and Group People L&D do", C1.get(q).status_code == 200 and CL.get(q).status_code == 200)
    s.check("...someone else doesn't, nor a BG admin", CS.get(q).status_code == 404 and CB.get(q).status_code == 404)
    tv = body(CM.get("/learning?view=team&tab=team"))
    s.check("the line manager's card links it", "quotation-zzlx.pdf" in tv)
    approve(R1)
    s.check("approved by the line manager and L&D", reg(R1)["status"] == "approved", reg(R1)["chain_json"])
    s.check("still to come: no certificate asked for", a.lms_ext_state(reg(R1)) == "upcoming")

    s.section("once it's over")
    end_it(R1)
    s.check("it waits for the certificate", a.lms_ext_state(reg(R1)) == "cert_due")
    s.check("...with no hours and no check-ins yet", not reg(R1)["hours"] and R1 not in
            [e["reg"] for e in call(a.lms_eval_plan, [E1], TODAY + timedelta(days=400))])
    ap = body(C1.get("/learning?view=mine&tab=apply"))
    s.check("Mine's Apply it asks for it, with I didn't go", 'id="ext-%d"' % R1 in ap and "Certificate needed" in ap and
            'value="not_going"' in ap and 'name="cert"' in ap)
    with a.app.test_request_context():
        sh = a.lms_shell(a.get_db(), u_(E1), a.lms_space(a.get_db(), u_(E1), "mine"), "apply")
    s.check("...and its queue leads with it", any(i["title"] == "Send your certificate: ZZLX Credit Risk" and
                                                   i["kind"] == "todo" for i in sh["queue"]["items"]))
    with a.app.test_request_context():
        dl = a.dash_learning(a.get_db(), u_(E1))
    acts = [x for x in (dl or {}).get("acts", []) if "certificate" in x.get("title", "")]
    s.check("the dashboard has the row", acts and acts[0]["url"].endswith("#ext-%d" % R1), dl and dl.get("acts"))
    a.mailer.is_configured = lambda: True
    ob0, ls0 = one("SELECT COALESCE(MAX(id), 0) FROM email_outbox"), one("SELECT COALESCE(MAX(id), 0) FROM lms_sent")
    with a.app.test_request_context():
        d = a.get_db()
        n1 = a.lms_mail_due(d, a._now_myt())
        n2 = a.lms_mail_due(d, a._now_myt())
    s.check("an email the day after, once", n1.get("cert", 0) >= 1 and not n2.get("cert") and one(
        "SELECT COUNT(*) FROM email_outbox WHERE to_email='zz9lx-e1@zzlx.invalid' AND subject LIKE 'Send your "
        "certificate%'") == 1, (n1, n2))
    a.mailer.is_configured = _MAIL0
    exe("DELETE FROM email_outbox WHERE id>? AND to_email NOT LIKE '%@zzlx.invalid'", (ob0,))   # the copy's other mail
    exe("DELETE FROM lms_sent WHERE id>? AND COALESCE(user_id, 0) NOT IN (?,?,?,?)", (ls0, E1, E2, E3, MGR))

    s.section("the certificate")
    r = C1.post("/learning/ext/%d" % R1, data={"csrf_token": "tok", "action": "cert",
                                               "cert": (io.BytesIO(b"<html>"), "cert.html")},
                content_type="multipart/form-data")
    s.check("not a PDF or a photo: refused", not reg(R1)["cert_path"])
    r = C1.post("/learning/ext/%d" % R1, data={"csrf_token": "tok", "action": "cert",
                                               "cert": (io.BytesIO(b"GIF89a"), "cert.png")},
                content_type="multipart/form-data")
    s.check("...nor a file whose bytes aren't what its name says", not reg(R1)["cert_path"])
    r = C2.post("/learning/ext/%d" % R1, data={"csrf_token": "tok", "action": "cert",
                                               "cert": (io.BytesIO(PNG), "cert.png")},
                content_type="multipart/form-data")
    s.check("...nor someone else's", not reg(R1)["cert_path"])
    r = C1.post("/learning/ext/%d" % R1, data={"csrf_token": "tok", "action": "cert",
                                               "cert": (io.BytesIO(PNG), "certificate-zzlx.png")},
                content_type="multipart/form-data")
    s.check("a photo of it: sent, to check", r.status_code == 302 and reg(R1)["cert_name"] == "certificate-zzlx.png" and
            a.lms_ext_state(reg(R1)) == "to_check")
    cf = "/learning/req/%d/cert" % R1
    s.check("the person and L&D open it", C1.get(cf).status_code == 200 and CL.get(cf).status_code == 200)
    s.check("...their line manager doesn't, nor a BG admin", CM.get(cf).status_code == 404 and
            CB.get(cf).status_code == 404)
    s.check("still no hours or check-ins", not reg(R1)["hours"] and R1 not in
            [e["reg"] for e in call(a.lms_eval_plan, [E1], TODAY + timedelta(days=400))])

    s.section("L&D's External courses")
    ex = body(CL.get("/admin/learning/requests?view=external"))
    s.check("listed, to check first, with its card", 'id="ext-%d"' % R1 in ex and "Certificate in · to check" in ex and
            "certificate-zzlx.png" in ex and "quotation-zzlx.pdf" in ex)
    s.check("...and the Requests page says how many to check", "to check" in body(CL.get("/admin/learning/requests")))
    s.check("a BG admin reads their own group's", 'ZZLX Credit Risk' in body(CB.get("/admin/learning/requests?"
                                                                                     "view=external")))
    s.check("...another group's admin doesn't see it", "ZZLX Credit Risk" not in body(
        CO_.get("/admin/learning/requests?view=external")))
    CB.post("/admin/learning/requests", data={"csrf_token": "tok", "action": "ext_checked",
                                              "registration_id": str(R1)})
    s.check("a BG admin can't check it", reg(R1)["outcome"] is None)
    ok, msg = call(a.lms_ext_check, u_(BGA), R1, "checked", {})
    s.check("...nor through the writer itself", not ok and "Group People L&D" in msg and reg(R1)["outcome"] is None,
            msg)
    r = CL.post("/admin/learning/requests", data={"csrf_token": "tok", "action": "ext_checked",
                                                  "registration_id": str(R1), "hours": ""})
    rr = reg(R1)
    s.check("L&D checks it: the hours asked are credited", rr["outcome"] == "attended" and rr["hours"] == 14 and
            rr["checked_by"] == LND, rr)
    s.check("...the check-ins start, from its last day", {e["kind"] for e in call(
        a.lms_eval_plan, [E1], TODAY + timedelta(days=400)) if e["reg"] == R1} == {"m1", "m3"})
    with a.app.test_request_context():
        xp = a.lms_xp(a.get_db(), [E1])[E1]
    s.check("...the XP counts its hours", any(row["title"] == "ZZLX Credit Risk" and row["parts"][0][0] == "14 h"
                                              for row in xp["rows"]), xp["rows"])
    s.check("...and it's in the audit log", one("SELECT COUNT(*) FROM activity_log WHERE user_id=? AND target_user_id=? "
                                                "AND detail LIKE '%certificate checked%'", (LND, E1)) == 1)
    s.check("checked once: a second check is refused", not call(a.lms_ext_check, u_(LND), R1, "checked", {})[0])

    s.section("didn't attend")
    r = ask(C2, "ZZLX Excel", cost="300", hrdc=False)
    R2 = one("SELECT id FROM lms_registrations WHERE user_id=? AND ext_title='ZZLX Excel'", (E2,))
    approve(R2)
    end_it(R2, 3)
    ok, msg = call(a.lms_ext_check, u_(LND), R2, "not_attended", {"reason": ""})
    s.check("L&D's didn't attend needs the reason", not ok and reg(R2)["outcome"] is None, msg)
    ok, msg = call(a.lms_ext_check, u_(LND), R2, "not_attended", {"reason": "ZZLX: the provider says they never came"})
    s.check("...with it: closed with no hours, the reason kept", ok and reg(R2)["outcome"] == "absent" and
            not reg(R2)["hours"] and "never came" in reg(R2)["ext_note"])
    r = ask(C3, "ZZLX Safety", cost="300", hrdc=False)
    R3 = one("SELECT id FROM lms_registrations WHERE user_id=? AND ext_title='ZZLX Safety'", (E3,))
    approve(R3)
    end_it(R3, 2)
    ok, msg = call(a.lms_ext_not_going, u_(E3), R3, "")
    s.check("the person's I didn't go needs why", not ok and reg(R3)["outcome"] is None, msg)
    r = C3.post("/learning/ext/%d" % R3, data={"csrf_token": "tok", "action": "not_going",
                                               "reason": "ZZLX: called back for an audit"})
    s.check("...with it: closed, no hours, L&D reads why", reg(R3)["outcome"] == "absent" and "audit" in
            reg(R3)["ext_note"] and not reg(R3)["hours"])
    s.check("...and it's off their Apply it", 'id="ext-%d"' % R3 not in body(C3.get("/learning?view=mine&tab=apply")))

    s.section("HRDC")
    hb = body(CL.get("/admin/learning/hrdc"))
    s.check("an HRDC-claimable external course is its own row", "External courses · HRDC-claimable" in hb and
            "ZZLX Credit Risk" in hb and "ZZLX Excel" not in hb)
    r = CL.post("/admin/learning/hrdc", data={"csrf_token": "tok", "action": "ext_cell", "registration_id": str(R1),
                                              "status": "approved", "grant_id": ""})
    s.check("approved needs the grant ID", not one("SELECT COUNT(*) FROM lms_hrdc_ext WHERE registration_id=?", (R1,)))
    r = CL.post("/admin/learning/hrdc", data={"csrf_token": "tok", "action": "ext_cell", "registration_id": str(R1),
                                              "status": "filed", "on_date": D(0)})
    s.check("L&D records it filed", one("SELECT status FROM lms_hrdc_ext WHERE registration_id=?", (R1,)) == "filed")
    hb = body(CL.get("/admin/learning/hrdc"))
    row = hb.split('id="lm-hx-h"')[1].split("ZZLX Credit Risk")[1][:900]
    s.check("...and the row says so", "Filed " in row, row)
    r = CB.post("/admin/learning/hrdc", data={"csrf_token": "tok", "action": "ext_cell", "registration_id": str(R1),
                                              "status": "rejected"})
    s.check("a BG admin reads it and can't record", r.status_code == 403 and one(
        "SELECT status FROM lms_hrdc_ext WHERE registration_id=?", (R1,)) == "filed" and "ZZLX Credit Risk" in
            body(CB.get("/admin/learning/hrdc")))
    s.check("...another group's admin doesn't see it", "ZZLX Credit Risk" not in body(CO_.get("/admin/learning/hrdc")))

    s.section("the calendar file")
    r = ask(C1, "ZZLX Coming Up", cost="300", hrdc=False)
    R4 = one("SELECT id FROM lms_registrations WHERE user_id=? AND ext_title='ZZLX Coming Up'", (E1,))
    approve(R4)
    r = C1.get("/learning/ics/%d" % R4)
    ics = r.get_data(as_text=True)
    s.check("an approved external course's calendar file: one all-day event, first day to last", r.status_code == 200
            and "DTSTART;VALUE=DATE:%s" % D(10).replace("-", "") in ics and
            "DTEND;VALUE=DATE:%s" % D(12).replace("-", "") in ics and "ZZLX Coming Up" in ics, ics[:400])
    s.check("...nobody else's", C2.get("/learning/ics/%d" % R4).status_code == 404)
    s.check("a course that isn't HRDC-claimable stays off the HRDC board", "ZZLX Coming Up" not in body(
        CL.get("/admin/learning/hrdc")))

    s.section("ones counting before")
    r = ask(C2, "ZZLX Old One", cost="300", hrdc=False)
    R5 = one("SELECT id FROM lms_registrations WHERE user_id=? AND ext_title='ZZLX Old One'", (E2,))
    approve(R5)
    end_it(R5, 50)
    exe("INSERT INTO lms_evaluations(registration_id, kind, due_on) VALUES (?, 'm1', ?)", (R5, D(-20)))
    keep = one("SELECT value FROM app_settings WHERE key='lms_ext_checked_backfill'")
    exe("DELETE FROM app_settings WHERE key='lms_ext_checked_backfill'")
    a._ensure_runtime_schema()
    s.check("an external course whose check-ins had started keeps counting, as checked", reg(R5)["outcome"] ==
            "attended" and reg(R5)["checked_at"] and reg(R5)["hours"] == 14)
    s.check("...one still waiting for its certificate is left as it is", a.lms_ext_state(reg(R4)) == "upcoming")
    s.check("...once", one("SELECT value FROM app_settings WHERE key='lms_ext_checked_backfill'") == "1")
    exe("DELETE FROM lms_evaluations WHERE registration_id=?", (R5,))
    if keep is None:
        exe("DELETE FROM app_settings WHERE key='lms_ext_checked_backfill'")

    s.section("Help and the KB")
    s.check("Help answers asking for a course that isn't listed, and what to do after it",
            "learn_ext_ask" in a.HELP_LISTS["learn_mine"][1] and "learn_ext" in a.HELP_LISTS["learn_apply"][1] and
            "certificate" in a.HELP_QA["learn_ext"][1] and "certificate" in a._KB_AI_LEARNING_BODY)
finally:
    a.mailer.is_configured, a.ai_draft.screen_message = _MAIL0, _SCREEN0
    if _ENV0 is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = _ENV0
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
