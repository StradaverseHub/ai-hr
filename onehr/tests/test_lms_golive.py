"""AI+ Learning's gap check, wave 5 (2026-10-23): the go-live plumbing.

What this suite holds:
  * the nightly backup archives uploads/learning/ with the other people's files
  * the scheduler's run goes on when Learning's turn fails: the outbox tick and the cycle's reminders still run
  * the journey agent's KB search, with nothing matched, never falls back to a Learning row while Learning is off
  * an admin account (Group People L&D) is emailed at its notification emails, every one, and nowhere without one;
    a person at their own email as before
  * Learning › Settings: an L&D admin added with an email gets it as their notification email; a bad one is refused;
    the super admin resets their password (8 characters at least, recorded as set by an admin, in the audit log); an
    L&D admin can't
  * L&D's daily digest sends nothing on a day with nothing in it
  * the production audit prints whether Learning is on, the flag's value only
Everything here is synthetic (ZZLG / zzlg-) and removed at the end.
"""
import importlib.util
import io
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning gap check, wave 5: go-live plumbing")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
_ENV0 = os.environ.get("ONEHR_LMS")
_MAIL0, _AUTO0, _ASYNC0 = a.mailer.is_configured, a.lms_auto, a.OUTBOX_ASYNC
_COUNTS0 = a.lms_digest_counts
from werkzeug.security import check_password_hash  # noqa: E402


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE username LIKE 'zzlg-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM email_outbox WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM lms_sent WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM admin_notify_emails WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM email_outbox WHERE to_email LIKE '%@zzlg.invalid'")
    db.execute("DELETE FROM lms_sent WHERE ref LIKE 'zzlg:%'")
    db.commit()


with a.app.app_context():
    db = a.get_db()
    _cleanup(db)
    LND = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzlg-lnd', 'ZZ LG L&D', 'x', 'admin', ?)", (a.LMS_ADMIN_BG,)).lastrowid
    LND0 = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg, email) VALUES "
                      "('zzlg-lnd0', 'ZZ LG L&D none', 'x', 'admin', ?, 'own@zzlg.invalid')",
                      (a.LMS_ADMIN_BG,)).lastrowid
    EMP = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, email) VALUES "
                     "('zzlg-emp', 'ZZ LG Emp', 'x', 'user', 'ZZ9LG-EMP', 'emp@zzlg.invalid')").lastrowid
    for e in ("ld1@zzlg.invalid", "ld2@zzlg.invalid"):
        db.execute("INSERT INTO admin_notify_emails(user_id, email, added_by) VALUES (?,?,?)", (LND, e, SU["id"]))
    db.commit()


def one(sql, args=()):
    return H.one(a, sql, args)


def u_(uid):
    with a.app.app_context():
        return a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()


def outbox(addr):
    return one("SELECT COUNT(*) FROM email_outbox WHERE to_email=?", (addr,))


try:
    os.environ["ONEHR_LMS"] = "1"

    s.section("the backup")
    src = open(os.path.join(H.REPO, "deploy", "backup_db.sh"), encoding="utf-8").read()
    loop = next((ln for ln in src.splitlines() if ln.startswith("for d in uploads/")), "")
    s.check("uploads/learning/ is archived with the KPI files and the evidence",
            all(d_ in loop.replace(";", " ").split() for d_ in ("uploads/pm", "uploads/evidence", "uploads/learning")),
            loop)

    s.section("the scheduler's run goes on")
    spec = importlib.util.spec_from_file_location("send_reminders_lg", os.path.join(H.REPO, "send_reminders.py"))
    sr = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sr)

    def boom(db):
        raise RuntimeError("ZZLG learning fell over")
    a.lms_auto = boom
    with a.app.app_context():
        d = a.get_db()
        keep = d.execute("SELECT value FROM app_settings WHERE key='reminder_auto_enabled'").fetchone()
        d.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('reminder_auto_enabled', '0')")
        d.commit()
    out, err = io.StringIO(), io.StringIO()
    sys.argv = ["send_reminders.py", "--auto"]
    old_err = sys.stderr
    sys.stderr = err
    raised = None
    try:
        with redirect_stdout(out):
            sr.main()
    except Exception as e:   # noqa: BLE001
        raised = e
    finally:
        sys.stderr = old_err
        a.lms_auto, a.OUTBOX_ASYNC = _AUTO0, _ASYNC0
        with a.app.app_context():
            d = a.get_db()
            if keep:
                d.execute("UPDATE app_settings SET value=? WHERE key='reminder_auto_enabled'", (keep[0],))
            else:
                d.execute("DELETE FROM app_settings WHERE key='reminder_auto_enabled'")
            d.commit()
    out = out.getvalue()
    s.check("Learning's turn failing doesn't stop the run", raised is None and "the rest of the run goes on" in out,
            (raised, out[:300]))
    s.check("...the outbox tick still runs after it", "Outbox:" in out.split("the rest of the run goes on")[-1],
            out[-300:])
    s.check("...and the error is printed for the log", "ZZLG learning fell over" in err.getvalue())

    s.section("the KB fallback")
    os.environ.pop("ONEHR_LMS", None)
    with a.app.app_context():
        d = a.get_db()
        sorts = {r["slug"]: r["sort_order"] for r in d.execute(
            "SELECT slug, sort_order FROM kb_entries WHERE slug IN (%s)" % ",".join("?" * len(a._KB_LMS_SLUGS)),
            a._KB_LMS_SLUGS)}
        d.execute("UPDATE kb_entries SET sort_order=-100 WHERE slug IN (%s)" % ",".join("?" * len(a._KB_LMS_SLUGS)),
                  a._KB_LMS_SLUGS)   # Learning's rows first, so the fallback would take them
        d.commit()
        try:
            res = a._journey_tool_search_kb(d, {"query": "zzlgqqq zzlgxxx"})
            titles = [g["title"] for g in res["guidance"]]
            lms_titles = {r["title"] for r in d.execute("SELECT title FROM kb_entries WHERE slug IN (%s)" % ",".join(
                "?" * len(a._KB_LMS_SLUGS)), a._KB_LMS_SLUGS)}
            s.check("with nothing matched and Learning off, no Learning row comes back",
                    res["found"] == 3 and not (set(titles) & lms_titles), titles)
            os.environ["ONEHR_LMS"] = "1"
            res = a._journey_tool_search_kb(d, {"query": "zzlgqqq zzlgxxx"})
            s.check("...with Learning on, they may", set(g["title"] for g in res["guidance"]) & lms_titles)
        finally:
            for slug, so in sorts.items():
                d.execute("UPDATE kb_entries SET sort_order=? WHERE slug=?", (so, slug))
            d.commit()
    os.environ["ONEHR_LMS"] = "1"

    s.section("Learning's emails to L&D")
    a.mailer.is_configured = lambda: True
    with a.app.test_request_context():
        d = a.get_db()
        ok = a._lms_mail(d, "digest", u_(LND), "zzlg:1", "ZZLG subject", ["ZZLG line"])
        d.commit()
    s.check("an L&D admin is emailed at every one of their notification emails", ok and
            outbox("ld1@zzlg.invalid") == 1 and outbox("ld2@zzlg.invalid") == 1)
    with a.app.test_request_context():
        d = a.get_db()
        ok0 = a._lms_mail(d, "digest", u_(LND0), "zzlg:2", "ZZLG subject", ["ZZLG line"])
        d.commit()
    s.check("...one with none set gets nothing, not even at the account's own address", not ok0 and
            outbox("own@zzlg.invalid") == 0)
    with a.app.test_request_context():
        d = a.get_db()
        oke = a._lms_mail(d, "digest", u_(EMP), "zzlg:3", "ZZLG subject", ["ZZLG line"])
        d.commit()
    s.check("a person is emailed at their own address as before", oke and outbox("emp@zzlg.invalid") == 1)

    s.section("L&D admins on Learning › Settings")
    CS = H.client_as(a, SU["id"])
    r = CS.post("/admin/learning/settings", data={"csrf_token": "tok", "action": "lnd_add", "username": "zzlg-new",
                                                  "full_name": "ZZ LG New", "password": "zzlg-pass-1",
                                                  "email": "New@ZZLG.invalid"})
    nid = one("SELECT id FROM users WHERE username='zzlg-new'")
    s.check("added with an email: it's their notification email", r.status_code == 302 and nid and
            one("SELECT email FROM admin_notify_emails WHERE user_id=?", (nid,)) == "new@zzlg.invalid" and
            one("SELECT pw_source FROM users WHERE id=?", (nid,)) == "admin")
    r = CS.post("/admin/learning/settings", data={"csrf_token": "tok", "action": "lnd_add", "username": "zzlg-bad",
                                                  "full_name": "ZZ LG Bad", "password": "zzlg-pass-1",
                                                  "email": "not an address"})
    s.check("...a bad email is refused, and nothing is added", not one("SELECT COUNT(*) FROM users WHERE "
                                                                         "username='zzlg-bad'"))
    pg = CS.get("/admin/learning/settings").get_data(as_text=True)
    s.check("the card shows their emails, adds and removes them, and resets the password",
            "new@zzlg.invalid" in pg and 'value="lnd_pw"' in pg and "/admin/notify/%d" % nid in pg and
            "Learning's emails to L&amp;D don't reach them" in pg,
            ["new@zzlg.invalid" in pg, 'value="lnd_pw"' in pg, "/admin/notify/%d" % nid in pg,
             "Learning's emails to L&amp;D don't reach them" in pg, pg[pg.find("lm-lnd-h"):][:300]])
    r = CS.post("/admin/learning/settings", data={"csrf_token": "tok", "action": "lnd_pw", "user_id": str(nid),
                                                  "new_password": "short"})
    s.check("a password under 8 characters is refused", check_password_hash(
        one("SELECT password_hash FROM users WHERE id=?", (nid,)), "zzlg-pass-1"))
    with a.app.app_context():   # as if they had changed it themselves since
        d = a.get_db()
        d.execute("UPDATE users SET pw_source='own' WHERE id=?", (nid,))
        d.commit()
    r = CS.post("/admin/learning/settings", data={"csrf_token": "tok", "action": "lnd_pw", "user_id": str(nid),
                                                  "new_password": "zzlg-pass-2"})
    s.check("the super admin sets a new one", r.status_code == 302 and check_password_hash(
        one("SELECT password_hash FROM users WHERE id=?", (nid,)), "zzlg-pass-2"))
    s.check("...recorded as set by an admin, in the audit log", one("SELECT pw_source FROM users WHERE id=?", (nid,))
            == "admin" and one("SELECT COUNT(*) FROM activity_log WHERE action='reset_pw' AND target_user_id=?",
                               (nid,)) == 1)
    r = H.client_as(a, LND).post("/admin/learning/settings", data={"csrf_token": "tok", "action": "lnd_pw",
                                                                   "user_id": str(nid), "new_password": "zzlg-pass-3"})
    s.check("an L&D admin can't", r.status_code == 403 and check_password_hash(
        one("SELECT password_hash FROM users WHERE id=?", (nid,)), "zzlg-pass-2"))
    r = CS.post("/admin/notify/%d" % nid, data={"csrf_token": "tok", "action": "add", "email": "two@zzlg.invalid",
                                                "next": "/admin/learning/settings"})
    s.check("adding a second email from the card comes back to it", r.status_code == 302 and
            r.headers["Location"].endswith("/admin/learning/settings") and
            one("SELECT COUNT(*) FROM admin_notify_emails WHERE user_id=?", (nid,)) == 2)

    s.section("L&D's digest")
    monday = datetime(2026, 11, 2, 9, 0)
    ob0, ls0 = one("SELECT COALESCE(MAX(id), 0) FROM email_outbox"), one("SELECT COALESCE(MAX(id), 0) FROM lms_sent")
    a.lms_digest_counts = lambda db, today: (0, 0, 0, 0)
    with a.app.test_request_context():
        d = a.get_db()
        n = a.lms_mail_due(d, monday)
    s.check("a day with nothing in it sends nothing", not n.get("digest") and not one(
        "SELECT COUNT(*) FROM lms_sent WHERE kind='digest' AND ref='digest:2026-11-02'"))
    a.lms_digest_counts = lambda db, today: (1, 0, 0, 0)
    with a.app.test_request_context():
        d = a.get_db()
        n = a.lms_mail_due(d, monday)
    s.check("one waiting at L&D's step: it goes", n.get("digest", 0) >= 1 and outbox("ld1@zzlg.invalid") == 2)
    a.lms_digest_counts = _COUNTS0
    with a.app.app_context():   # the run queued the copy's other Learning emails too: put them back
        d = a.get_db()
        d.execute("DELETE FROM email_outbox WHERE id>?", (ob0,))
        d.execute("DELETE FROM lms_sent WHERE id>?", (ls0,))
        d.commit()

    s.section("the production audit")
    audit = open(os.path.join(H.REPO, "deploy", "prod_audit.sh"), encoding="utf-8").read()
    block = audit.split('echo "== AI+ Learning"')[1].split('echo "== nginx')[0]
    with tempfile.TemporaryDirectory() as t:
        env_on, env_off = os.path.join(t, "on.env"), os.path.join(t, "off.env")
        open(env_on, "w").write("SECRET=zz\nONEHR_LMS=1\n")
        open(env_off, "w").write("SECRET=zz\nONEHR_LMS=0\n")

        def run(envf):
            sh = ("systemctl() { echo 'EnvironmentFiles=%s (ignore_errors=no)'; }\nAPP=%s\n" % (envf, t)) + block
            return subprocess.run(["bash", "-c", sh], capture_output=True, text=True).stdout.strip()
        on, off = run(env_on), run(env_off)
    s.check("it prints whether Learning is on there, the flag only", on == "ONEHR_LMS on" and off == "ONEHR_LMS off",
            (on, off))
    s.check("...and Learning's row counts from the copy", "'lms programmes / sessions / requests / L&D admins'" in audit)
finally:
    a.mailer.is_configured, a.lms_auto, a.OUTBOX_ASYNC, a.lms_digest_counts = _MAIL0, _AUTO0, _ASYNC0, _COUNTS0
    if _ENV0 is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = _ENV0
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
