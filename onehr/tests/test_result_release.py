"""Result release -- the FINAL performance band, the FINAL potential band and the talent status reach a person only when
a super admin releases them (Chris, 2026-10-02: "HOD and CEO scores are hidden until admin decides to release them, so
there needs to be a setting for result release for Performance and Potential and the talent status").

One page (/admin/talent-release, now "Release results"), per person or in bulk by business group / unit, revocable.
Before release a person keeps seeing their line manager's approved rating and no potential band; the 360 report's own
release brings the report, not the band. Everything here is synthetic (ZZRR-*) and is removed at the end.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Result release -- final bands hidden until a super admin releases them")

BG, CO = "ZZRR BG", "ZZRR CO"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZRR-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        for t in ("result_releases", "talent_releases", "report_releases"):
            db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (t, ph), ids)
    for t in ("pm_calibration_sessions", "calibration_sessions"):
        db.execute("DELETE FROM %s WHERE business_group=?" % t, (BG,))
    if ids:
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    _cleanup(db)
    # a Year-End, set here: in a Mid-Year the HOD's band is already final, and the BG CEO tier this suite locks
    # doesn't exist. It used to inherit test_calib_assist's leftover Year-End (2026-10-21, the parallel runner).
    _half0 = db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(emp_id, name, hod=None):
        # "rel-": test_rating_records leaves its users behind, and its zzrr-hod is this suite's ZZRR-HOD lowercased
        v = dict(base, username="rel-" + emp_id.lower(), employee_id=emp_id, full_name=name, email=None, hod_id=hod,
                 manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CO,
                 confirmation_date="2020-01-01", left_at=None, is_demo=0, role="user")
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (emp_id,)).fetchone()[0]

    HOD = mk("ZZRR-HOD", "ZZ Release HOD")
    EMP = mk("ZZRR-EMP", "ZZ Release Person", hod=HOD)
    NONE = mk("ZZRR-NONE", "ZZ Release Nobody", hod=HOD)
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]

    def sess(table, tier, key, band, locked=True):
        db.execute("INSERT INTO %s(cycle_id, tier, scope_key, business_group, scope_label, locked_at) "
                   "VALUES (?,?,?,?,?,%s)" % (table, "datetime('now')" if locked else "NULL"),
                   (CID, tier, key, BG, "ZZRR"))
        sid = db.execute("SELECT id FROM %s WHERE cycle_id=? AND tier=? AND scope_key=?" % table,
                         (CID, tier, key)).fetchone()[0]
        adj = table.replace("sessions", "adjustments")
        db.execute("INSERT INTO %s(session_id, subject_id, original_band, adjusted_band, justification) "
                   "VALUES (?,?,?,?,?)" % adj, (sid, EMP, "", band, "ZZRR reason"))

    # the HOD set both bands directly (no approved score, no 360) and locked: a result, not yet final
    sess("pm_calibration_sessions", "hod", str(HOD), "AE")
    sess("calibration_sessions", "hod", str(HOD), "High")
    db.commit()


def ctx(fn):
    with a.app.test_request_context("/"):
        d = a.get_db()
        return fn(d)


def u(uid):
    return ctx(lambda d: dict(d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()))


def post(c, **form):
    form.setdefault("csrf_token", "tok")
    return c.post("/admin/talent-release", data=form)


try:
    # -----------------------------------------------------------------------
    s.section("the final result: the band the product counts, and where it stands")
    pm = ctx(lambda d: a.final_result(d, u(EMP), CID, "pm"))
    pot = ctx(lambda d: a.final_result(d, u(EMP), CID, "pot"))
    s.check("a band the HOD set and locked is the result, not yet final (no BG CEO lock)",
            pm and pm["band"] == "AE" and not pm["final"] and pm["stage"].startswith("HOD locked")
            and pot and pot["band"] == "High" and not pot["final"], (pm, pot))
    s.check("someone with no band on either axis has no result", ctx(lambda d: a.final_result(
        d, u(NONE), CID, "pm")) is None and ctx(lambda d: a.final_result(d, u(NONE), CID, "pot")) is None)

    # -----------------------------------------------------------------------
    s.section("before release: nothing final reaches the person")
    s.check("no released final performance or potential band",
            ctx(lambda d: a.released_final_band(d, u(EMP), CID, "pm")) is None
            and ctx(lambda d: a.released_final_band(d, u(EMP), CID, "pot")) is None)
    s.check("the dashboard's potential (released only) is empty",
            ctx(lambda d: a._dash_potential(d, u(EMP), CID)) is None)
    bi = ctx(lambda d: a._report_band_info(d, u(EMP), CID, {"band": "Mid", "score_valid": True, "min_valid": 4}))
    s.check("the 360 report's band is withheld and says why (the report's own release no longer brings it)",
            bi["band"] is None and not bi["score_valid"] and bi["pot_unreleased"], bi)

    # -----------------------------------------------------------------------
    s.section("the page: super admin only, filtered by business group, shows where each result stands")
    emp_c = H.client_as(a, EMP)
    r = emp_c.get("/admin/talent-release")
    s.check("an employee can't open it", r.status_code in (302, 403, 404), r.status_code)
    sup = H.client_as(a, SUP)
    r = sup.get("/admin/talent-release?period=%d&bg=%s" % (CID, BG))
    body = r.get_data(as_text=True)
    s.check("the super admin's page lists the person with both bands, 'HOD locked', and where they are in the two "
            "releases ('Not final yet' for leaders, 'After step 1' for the person)",
            r.status_code == 200 and "ZZ Release Person" in body and "HOD locked" in body
            and "Not final yet" in body and "After step 1" in body and "ZZ Release Nobody" not in body, r.status_code)
    s.check("...under the two steps, To leaders then To employees, with the Show filters",
            body.find("To leaders") < body.find("To employees") and "To leaders" in body
            and "Ready for leaders" in body and "Released to employees" in body)
    s.check("titled Release results, with the result picker and the business group filter",
            "Release results" in body and 'name="result"' in body and 'name="bg"' in body)

    # -----------------------------------------------------------------------
    s.section("release one result; the others stay hidden")
    r = post(sup, period=CID, bg=BG, result="pm", action="release", ids=[EMP])
    s.check("releasing Performance redirects back with the filters", r.status_code == 302
            and "bg=" in (r.headers.get("Location") or ""), r.headers.get("Location"))
    s.check("...the person now has their final performance band, and still no potential band",
            ctx(lambda d: a.released_final_band(d, u(EMP), CID, "pm")) == "AE"
            and ctx(lambda d: a.released_final_band(d, u(EMP), CID, "pot")) is None)
    s.check("...and it's logged against them", ctx(lambda d: d.execute(
        "SELECT COUNT(*) FROM activity_log WHERE action='result_release' AND target_user_id=?",
        (EMP,)).fetchone()[0]) >= 1)
    rec = ctx(lambda d: a._dash_record_row(d, u(EMP), d.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone(),
                                           d.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()))
    s.check("the record row carries the final band, and period_id for the KPI pop-out",
            rec["final_pm"] == "AE" and rec["period_id"] == CID and rec["band"] is None, rec)

    # -----------------------------------------------------------------------
    s.section("potential: its own release, and the 360 report follows it")
    ctx(lambda d: (d.execute("INSERT OR IGNORE INTO report_releases(cycle_id, subject_id) VALUES (?,?)", (CID, EMP)),
                   d.commit()))
    _spb = ctx(lambda d: (d.execute("SELECT value FROM app_settings WHERE key='show_potential_band'").fetchone()
                          or [None])[0])
    ctx(lambda d: (d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('show_potential_band','1')"),
                   d.commit()))   # the hero shows (put back at the end)
    hero_on = ctx(lambda d: a.get_show_potential_band())
    s.check("(the band hero is on for these checks)", hero_on)
    _rr = H.client_as(a, EMP).get("/my-report?cycle=%d" % CID)
    rep = _rr.get_data(as_text=True)
    s.note("my-report: %s %s" % (_rr.status_code, (rep[rep.find("<title>"):rep.find("</title>")] if "<title>" in rep else "")))
    s.check("with the report released but not Potential, the report says 'Not released yet' (no band)",
            (not hero_on) or ("Not released yet" in rep and "High Potential" not in rep),
            rep[rep.find("band-hero"):rep.find("band-hero") + 400] if "band-hero" in rep else rep[:300])
    rec = ctx(lambda d: a._dash_record_row(d, u(EMP), d.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone(),
                                           d.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()))
    s.check("...and the record row still links the report (gated on the report's release, not on a band)",
            bool(rec["report_url"]) and rec["band"] is None, rec)
    post(sup, period=CID, bg=BG, result="pot", action="release", ids=[EMP])
    rep = H.client_as(a, EMP).get("/my-report?cycle=%d" % CID).get_data(as_text=True)
    s.check("released, the report shows the FINAL potential band (the HOD's High)",
            (not hero_on) or "High Potential" in rep, hero_on)
    s.check("...and so does the dashboard", ctx(lambda d: a._dash_potential(d, u(EMP), CID)) == "High")

    # -----------------------------------------------------------------------
    s.section("a band decided higher up after release replaces it; the stage reads Final")
    with a.app.test_request_context("/"):
        _d = a.get_db()
        _d.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, "
                   "locked_at) VALUES (?,?,?,?,?,datetime('now'))", (CID, "bgceo", BG, BG, "ZZRR"))
        _sid = _d.execute("SELECT id FROM pm_calibration_sessions WHERE cycle_id=? AND tier='bgceo' AND scope_key=?",
                          (CID, BG)).fetchone()[0]
        _d.execute("INSERT INTO pm_calibration_adjustments(session_id, subject_id, original_band, adjusted_band) "
                   "VALUES (?,?,?,?)", (_sid, EMP, "AE", "OU"))
        _d.commit()
    pm = ctx(lambda d: a.final_result(d, u(EMP), CID, "pm"))
    s.check("the BG CEO's lock makes it Final", pm["band"] == "OU" and pm["final"] and pm["stage"] == "Final", pm)
    s.check("...and the released band follows the final one",
            ctx(lambda d: a.released_final_band(d, u(EMP), CID, "pm")) == "OU")

    # -----------------------------------------------------------------------
    s.section("revoke; skip people with nothing to release; refuse bad input")
    post(sup, period=CID, bg=BG, result="all", action="revoke", ids=[EMP])
    s.check("revoking all three hides both bands again",
            ctx(lambda d: a.released_final_band(d, u(EMP), CID, "pm")) is None
            and ctx(lambda d: a._dash_potential(d, u(EMP), CID)) is None)
    post(sup, period=CID, bg=BG, result="all", action="release", ids=[EMP, NONE])
    s.check("releasing all three for two people writes rows only for the one with results",
            ctx(lambda d: d.execute("SELECT COUNT(*) FROM result_releases WHERE subject_id=?", (EMP,)).fetchone()[0])
            == 2 and ctx(lambda d: d.execute("SELECT COUNT(*) FROM result_releases WHERE subject_id=?",
                                             (NONE,)).fetchone()[0]) == 0)
    s.check("no talent status row without a valid 360 (talent follows talent_status_for)",
            ctx(lambda d: d.execute("SELECT COUNT(*) FROM talent_releases WHERE subject_id=?",
                                    (EMP,)).fetchone()[0]) == 0)
    r = post(sup, period=CID, result="bonus", action="release", ids=[EMP])
    s.check("an unknown result is refused", r.status_code == 400, r.status_code)
    r = post(sup, period=CID, result="pm", action="release")
    s.check("no one selected: back to the page, nothing written", r.status_code == 302)

    # -----------------------------------------------------------------------
    s.section("templates")
    _n, bad = H.every_template_compiles(a)
    s.check("every template compiles", not bad, bad)
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "templates",
                            "admin_talent_release.html")).read()
    s.check("the bulk buttons confirm through the app's dialog (no native confirm / alert)",
            "data-confirm" in src and "confirm(" not in src.replace("data-confirm", "") and "alert(" not in src)
finally:
    ctx(lambda d: _cleanup(d))
    ctx(lambda d: (d.execute("UPDATE cycles SET half=? WHERE id=?", (_half0, CID)), d.commit()))
    try:
        if _spb is None:
            ctx(lambda d: (d.execute("DELETE FROM app_settings WHERE key='show_potential_band'"), d.commit()))
        else:
            ctx(lambda d: (d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('show_potential_band',?)",
                                     (_spb,)), d.commit()))
    except NameError:
        pass

sys.exit(s.done())
