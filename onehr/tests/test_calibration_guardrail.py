"""Calibration framework guardrail (2026-09-19, Chris).

HOD (department) and BUCEO (business unit) must LOCK a spread within tolerance of the
framework -- 15-70-15 for potential, the PAT-driven curve for performance -- with a
small-team exception: tolerance = max(1 person, X% of headcount), so a single person's move
is always allowed (a team of 3 can't hit 15-70-15 exactly). A justified override lets a real
edge case through. Pure logic + wiring lint (no DB seeding of calibration sessions).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Calibration framework guardrail -- 15-70-15 / PAT, small-team exception")
SU, _BG, _EMP = H.actors(a)

CT = a.CALIBRATION_TARGET   # {"Low": 15, "Mid": 70, "High": 15}


def pot_over(dist, pct=10):
    return a._calib_over_framework(a.calibration_target_gaps(dist, CT), sum(dist.values()), pct)


# ---------------------------------------------------------------------------
s.section("small-team exception -- a team of 3 (15-70-15 can't be hit exactly)")
for label, d in [("1/1/1", {"Low": 1, "Mid": 1, "High": 1}),
                 ("2 mid + 1 low", {"Low": 1, "Mid": 2, "High": 0}),
                 ("2 mid + 1 high", {"Low": 0, "Mid": 2, "High": 1}),
                 ("3 mid", {"Low": 0, "Mid": 3, "High": 0})]:
    s.check("team of 3 %s is WITHIN framework" % label, pot_over(d) == {}, (label, pot_over(d)))
for label, d in [("3 low", {"Low": 3, "Mid": 0, "High": 0}),
                 ("3 high", {"Low": 0, "Mid": 0, "High": 3})]:
    s.check("team of 3 %s is a BREACH" % label, pot_over(d) != {}, (label, pot_over(d)))

# ---------------------------------------------------------------------------
s.section("a larger team is held to the % (tolerance grows with headcount)")
s.check("100 at 15/70/15 is within framework", pot_over({"Low": 15, "Mid": 70, "High": 15}) == {})
s.check("100 at +10 in Low is still within tolerance (tol = 10% of 100 = 10)",
        pot_over({"Low": 25, "Mid": 60, "High": 15}) == {}, pot_over({"Low": 25, "Mid": 60, "High": 15}))
s.check("100 at +11 in Low breaches",
        "Low" in pot_over({"Low": 26, "Mid": 59, "High": 15}))

# ---------------------------------------------------------------------------
s.section("the small-team floor is ONE person, not zero (the exception itself)")
s.check("talent_move_allowance floors at 1 for a tiny team", a.talent_move_allowance(3, 10) == 1)
s.check("...and scales with headcount for a big team", a.talent_move_allowance(100, 10) == 10)

# ---------------------------------------------------------------------------
s.section("performance follows the PAT-driven curve (5 bands)")
NORMAL = a.PM_DIST_CURVES["normal"]   # {"UA":5,"BE":10,"ME":70,"AE":10,"OU":5} == 15-70-15 grouped


def perf_over(dist, pct=10):
    return a._calib_over_framework(a.pm_calibration_target_gaps(dist, NORMAL), sum(dist.values()), pct)


s.check("100 on the normal PAT curve is within framework",
        perf_over({"UA": 5, "BE": 10, "ME": 70, "AE": 10, "OU": 5}) == {})
s.check("everyone Outstanding breaches",
        perf_over({"UA": 0, "BE": 0, "ME": 0, "AE": 0, "OU": 100}) != {})
# The curve shifts with PAT achievement: >130% (positive) tolerates far more AE/OU.
POS = a.PM_DIST_CURVES["positive"]   # {"UA":0,"BE":5,"ME":60,"AE":25,"OU":10}
s.check("a positive (PAT>130%) curve exists and is more top-heavy than normal",
        POS["AE"] + POS["OU"] > NORMAL["AE"] + NORMAL["OU"])

# ---------------------------------------------------------------------------
s.section("the setting + the lock wiring")
with a.app.app_context():
    s.check("default deviation % is 10", a.get_calib_dev_pct() == 10.0)
_src = H.source(a)
# An HOD does a department review, not a calibration (Chris, 2026-09-30): no curve rule on their submit.
_pm_lock_src = _src.split("def _pm_calib_lock(tier, **kw):", 1)[1].split("\ndef ", 1)[0]
_hod_lock_src = _src.split("def calibration_hod_lock(hod_id):", 1)[1].split("\n@app.route", 1)[0]
s.check("the performance lock enforces the guardrail for BUCEO only (an HOD's department review has none)",
        "_pm_calib_lock_breaches" in _pm_lock_src and 'if tier == "buceo":' in _pm_lock_src
        and 'tier in ("hod", "buceo")' not in _pm_lock_src)
s.check("the potential BUCEO lock enforces the guardrail; the HOD's submit doesn't",
        "_pot_calib_lock_breaches" in _src and "_pot_calib_lock_breaches" not in _hod_lock_src)
s.check("the talent-box lock enforces both axes for BUCEO",
        "talent_box_override" in _src)
s.check("an override reason lets a genuine edge case through (logged, never silent)",
        "override_reason" in _src and "off-framework" in _src)

# ---------------------------------------------------------------------------
s.section("the deviation % is admin-settable and moves the tolerance")
with a.app.app_context():
    a.set_calib_dev_pct(15)
    s.check("set_calib_dev_pct round-trips through get_calib_dev_pct", a.get_calib_dev_pct() == 15.0)
    # 100 people, +12 over in Low (and 12 short in Mid): a breach at 10% (tol 10),
    # within tolerance at 15% (tol 15). Proves the admin % actually drives the gate.
    _d = {"Low": 27, "Mid": 58, "High": 15}
    _gaps = a.calibration_target_gaps(_d, CT)
    s.check("+12 off breaches at 10%", "Low" in a._calib_over_framework(_gaps, 100, 10))
    s.check("...but is within tolerance at 15%", a._calib_over_framework(_gaps, 100, 15) == {})
    a.get_db().execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('calib_tol_mode','percent')")
    a.get_db().commit()
    s.check("the default (pct=None) path, in percent mode, reads the stored 15% and passes",
            a._calib_over_framework(_gaps, 100) == {})
    a.get_db().execute("DELETE FROM app_settings WHERE key='calib_tol_mode'"); a.get_db().commit()
    a.set_calib_dev_pct(10)   # restore the default for any later reader
    s.check("restored to 10", a.get_calib_dev_pct() == 10.0)

# ---------------------------------------------------------------------------
s.section("the override affordance + admin deviation field are wired")
_appsrc = H.source(a)
s.check("app.py has the calib_dev settings action", 'action == "calib_dev"' in _appsrc)
s.check("app.py has set_calib_dev_pct", "def set_calib_dev_pct(" in _appsrc)
s.check("the general settings render passes calib_dev_pct",
        "calib_dev_pct=get_calib_dev_pct()" in _appsrc)
_base = H.source(a, "templates/base.html")
s.check("openConfirmDialog takes the reason option",
        "opts.reason" in _base and "function openConfirmDialog(form, message, onOk, opts)" in _base)
s.check("base.html wires the .calib-override-btn handler into override_reason",
        "calib-override-btn" in _base and "override_reason" in _base)
# the card lives on Calibration & Talent's Settings page since 2026-10-10 (the General page was split up)
_gen = H.source(a, "templates/settings/cards/_calib_dev.html")
s.check("the admin rule card exists: +-N people or % of headcount, and strict or lock-with-a-reason",
        any(x["id"] == "calib-dev" and x.get("card") == "calib_dev" for x in a.ADMIN_SETTINGS["calibration"]["sections"])
        and 'name="calib_dev_pct"' in _gen and 'name="calib_tol_people"' in _gen
        and 'name="calib_tol_mode"' in _gen and 'name="calib_lock_strict"' in _gen)

# ---------------------------------------------------------------------------
s.section("THE CURVE RULE (Chris, 2026-09-29): HOD and BU CEO honour the curve within +-1 person, admin-set")
with a.app.app_context():
    _db = a.get_db()
    for _k in ("calib_tol_mode", "calib_tol_people", "calib_lock_strict"):
        _db.execute("DELETE FROM app_settings WHERE key=?", (_k,))
    _db.commit()
    s.check("by default: +-1 person per band, whatever the headcount, and strict",
            a.calib_tolerance(14) == 1 and a.calib_tolerance(100) == 1 and a.calib_tolerance(0) == 0
            and a.get_calib_rule()["mode"] == "people" and a.calib_lock_strict() is True)
    _g100 = a.calibration_target_gaps({"Low": 17, "Mid": 68, "High": 15}, CT)
    s.check("...so 100 people with Low 2 over the curve is now a BREACH (it was within 10% of 100)",
            "Low" in a._calib_over_framework(_g100, 100), a._calib_over_framework(_g100, 100))
    s.check("...and 1 over is within", a._calib_over_framework(a.calibration_target_gaps(
        {"Low": 16, "Mid": 69, "High": 15}, CT), 100) == {})
    s.check("strict: the refusal says to adjust the bands (no override offered)",
            "before you lock" in a._calib_breach_message({"Low": -2}))
    _db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('calib_tol_people','3')")
    _db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('calib_lock_strict','0')")
    _db.commit()
    s.check("the admin's number drives it (+-3), and lock-with-a-reason can be switched back on",
            a.calib_tolerance(100) == 3 and a.calib_lock_strict() is False
            and "override reason" in a._calib_breach_message({"Low": -4}))
    for _k in ("calib_tol_mode", "calib_tol_people", "calib_lock_strict"):
        _db.execute("DELETE FROM app_settings WHERE key=?", (_k,))
    _db.commit()
# 4 sites since 2026-10-22: the three before, plus a calibration group's own potential lock
s.check("every BU CEO lock site honours strict: an override reason is ignored when strict (4 sites; no HOD site)",
        _src.count('_ovr = "" if calib_lock_strict() else (request.form.get("override_reason") or "").strip()') == 4)
_c = H.client_as(a, SU["id"]) if hasattr(H, "client_as") else None
if _c is not None:
    _r = _c.post("/admin/settings", data={"csrf_token": "tok", "action": "calib_dev", "calib_tol_mode": "people",
                                          "calib_tol_people": "2", "calib_lock_strict": "1"})
    with a.app.app_context():
        _rule = a.get_calib_rule()
    s.check("the admin form saves the rule (+-2, strict)", _r.status_code in (200, 302)
            and _rule["people"] == 2 and _rule["mode"] == "people" and _rule["strict"] is True, (_r.status_code, _rule))
    with a.app.app_context():
        for _k in ("calib_tol_mode", "calib_tol_people", "calib_lock_strict"):
            a.get_db().execute("DELETE FROM app_settings WHERE key=?", (_k,))
        a.get_db().commit()
    # (review) +-0 people can be impossible to meet (each band's expected count is rounded, so they rarely add up to
    # the headcount): the form refuses it, and a stored 0 still reads as 1
    _r0 = _c.post("/admin/settings", data={"csrf_token": "tok", "action": "calib_dev", "calib_tol_mode": "people",
                                           "calib_tol_people": "0", "calib_lock_strict": "1"})
    with a.app.app_context():
        _saved0 = a.get_db().execute("SELECT value FROM app_settings WHERE key='calib_tol_people'").fetchone()
        a.get_db().execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('calib_tol_people','0')")
        a.get_db().commit()
        _rule0 = a.get_calib_rule()
        for _k in ("calib_tol_mode", "calib_tol_people", "calib_lock_strict"):
            a.get_db().execute("DELETE FROM app_settings WHERE key=?", (_k,))
        a.get_db().commit()
    s.check("(review) the admin form refuses +-0 people, and a stored 0 reads as 1",
            _saved0 is None and _rule0["people"] == 1, (_saved0 and dict(_saved0), _rule0))
for _tmpl in ("pm_calibration_tier.html",
              "calibration_company.html", "talent_box.html"):
    s.check("%s carries the override button" % _tmpl,
            "calib-override-btn" in H.source(a, "templates/" + _tmpl))
s.check("calibration_hod.html has no override button (a department review has no curve rule)",
        "calib-override-btn" not in H.source(a, "templates/calibration_hod.html"))
s.check("pm_calibration_tier.html offers the override to a BU CEO only",
        "{% if tier == 'buceo' %}" in H.source(a, "templates/pm_calibration_tier.html"))

sys.exit(s.done())
