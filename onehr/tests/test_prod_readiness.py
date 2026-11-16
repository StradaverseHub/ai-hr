"""Production readiness: the fixes the rollout plan needs before the platform reaches live production (2026-10-14).

- The legacy users.report_released_at copy runs only while report_releases is empty. It used to run at every boot into
  whichever cycle was active, so a new cycle becoming active would auto-release the 360 report of everyone still
  carrying the legacy flag (14 people on production).
- "Forgot password" never says "we've emailed you" when there is no email on the server. (2026-10-15: it now gives one
  answer whatever was entered, so a failed send and a wrong email read as a match does -- see test_login_security.)

Synthetic (ZZPR-*) on the shared suite database; everything is put back at the end.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Production readiness -- the legacy release copy is one-time, Forgot password is honest")


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZPR-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM report_releases WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM password_resets WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    _cleanup(db)
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, **over):
        v = dict(base, username=eid, employee_id=eid, full_name=eid, email=None, manager_id=None, hod_id=None,
                 left_at=None, role="user", admin_bg=None, report_released_at=None, report_released_by=None)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    LEG = mk("ZZPR-LEGACY", report_released_at="2025-01-01 00:00:00")
    MAIL = mk("ZZPR-MAIL", email="zzpr-mail@example.invalid")
    db.commit()
    cid = a.active_cycle_id(db)
    had_rows = db.execute("SELECT 1 FROM report_releases LIMIT 1").fetchone() is not None

# --- the legacy release copy ------------------------------------------------------------------------------------
s.check("(the suite database already has per-cycle releases, the state every live database is in)", had_rows)
a._ensure_runtime_schema()   # a boot: the migration runs again over the same database
s.check("a boot never releases a report from the legacy flag once per-cycle releases exist",
        H.one(a, "SELECT COUNT(*) FROM report_releases WHERE subject_id=? AND cycle_id=?", (LEG, cid)) == 0)
src = H.source(a, "app.py")
s.check("the copy is guarded on an empty report_releases",
        'and "report_released_at" in ucols and not c.execute(\n                "SELECT 1 FROM report_releases LIMIT 1")'
        in src)

# --- Forgot password ----------------------------------------------------------------------------------------------
_prod, _cfg, _send = a._PROD, a.mailer.is_configured, a.mailer.send_mail
c = a.app.test_client()


def ask(eid, email):
    with c.session_transaction() as ss_:
        ss_["csrf_token"] = "tok"
    return c.post("/forgot", data={"username": eid, "email": email, "csrf_token": "tok"}).get_data(as_text=True)


try:
    a._PROD = True
    a.RESET_MAIL_ASYNC = False
    a.mailer.is_configured = lambda: False
    b = ask("ZZPR-MAIL", "zzpr-mail@example.invalid")
    s.check("no email on the server: it says reset by email isn't available, and to contact HR -- never 'we'll email'",
            "isn't available on OneHR just now" in b and "we'll email" not in b)
    s.check("...and no reset link is created", H.one(a, "SELECT COUNT(*) FROM password_resets WHERE user_id=?",
                                                     (MAIL,)) == 0)
    a.mailer.is_configured = lambda: True
    sent = []
    a.mailer.send_mail = lambda *a_, **k_: sent.append(a_[0])
    b = ask("ZZPR-MAIL", "zzpr-mail@example.invalid")
    s.check("email working: the one answer, and it was sent", "we'll email" in b
            and sent == ["zzpr-mail@example.invalid"], sent)
finally:
    a._PROD, a.mailer.is_configured, a.mailer.send_mail = _prod, _cfg, _send
    a.RESET_MAIL_ASYNC = True

with a.app.test_request_context("/"):
    _cleanup(a.get_db())
sys.exit(s.done())
