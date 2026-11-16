"""The super admin's remark on every band action (Chris, 2026-10-17: "for any action that will impact or change the final
band of an employee by super admin, there must be a mandatory remark logged by super admin ... saved in the audit
trail"; the sweep, 2026-10-18: "yes, extend the band remark for super admin").

What this suite holds:
  * the list is whole: every POST route that writes, locks, unlocks or resets a band (or a rule that re-bands people)
    is in SUPER_BAND_ENDPOINTS, the journey's own routes aside (the super admin can't reach them)
  * every listed endpoint, posted by the super admin with no remark, is refused before the route runs -- a flash and
    back, or JSON 400 for the pages that autosave -- and a blank or over-long remark is refused too
  * nobody else is asked: a BG admin's post goes on to the route's own answer
  * a remark rides on every audit row the action writes, and on a band row with no note of its own
  * the confirm box asks it of the super admin only; the override saves by its button, never as the dropdown
    changes; the calibration rows ask before they autosave; the AI assistant moves no band for the super admin
  * end to end on a settings rule: refused without, saved with, the remark in its audit row
(Final bands, the override and the group mode end to end are in test_group_calibration.)
"""
import inspect
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
# Grade H's band routes (admin_gradeh_final, ...) answer 404 while ONEHR_GRADEH is off, ahead of the remark gate (2026-10-31,
# test_gradeh_dark); this suite is about the remark, so it runs with the module on (its own process: nothing to put back).
os.environ["ONEHR_GRADEH"] = "1"
s = H.Suite("The super admin's remark -- every band action, checked before it runs, kept in the audit trail")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
# Posting the settings form (here and in the endpoint loop) saves every setting it carries; the AI switches it does not post come out OFF (ai_calib
# among them). Put the whole app_settings table back at exit, or a suite that runs after this one finds the calibration assistant off and its
# Talent Box read empty (test_bu_panels, 7 Nov: it failed only when the queue ran it after this suite).
import atexit  # noqa: E402
SETTINGS0 = [tuple(x) for x in H.rows(a, "SELECT * FROM app_settings")]


def _put_back_settings():
    with a.app.app_context():
        d_ = a.get_db()
        cols_ = [c_[1] for c_ in d_.execute("PRAGMA table_info(app_settings)")]
        d_.execute("DELETE FROM app_settings")
        d_.executemany("INSERT INTO app_settings(%s) VALUES (%s)" % (",".join(cols_), ",".join("?" * len(cols_))), SETTINGS0)
        d_.commit()


atexit.register(_put_back_settings)
REMARK_ERR = "Write your remark first"

# ------------------------------------------------------------------------------------------------------------------
s.section("the list is whole")
rules = {r.endpoint: r for r in a.app.url_map.iter_rules()}
missing = [e for e in a.SUPER_BAND_ENDPOINTS if e not in rules or "POST" not in rules[e].methods]
s.check("every listed endpoint exists and takes a POST", not missing, missing)
# a route that calls one of these writes a band, locks or unlocks a tier, or resets one
WRITERS = ("_pm_calib_adjust(", "_pm_calib_reset(", "_pm_calib_lock(", "_pm_calib_unlock(", "_unlock_scope(", "_unlock_route(",
           "_gc_group_unlock(", "_pm_super_set(",
           "_pot_super_set(", "_talent_box_move(", "_talent_box_lock(", "group_lock_people(",
           "_calibration_upsert_adjustment(", "_pm_calib_upsert_adjustment(", "_tb_unpin(", "_tb_pin_bands(",
           "DELETE FROM pm_group_locks", "DELETE FROM pot_group_locks", "UPDATE calibration_sessions SET locked",
           "DELETE FROM pm_calibration_adjustments", "DELETE FROM calibration_adjustments",
           "UPDATE pm_calibration_sessions SET locked", "DELETE FROM talent_box_bu_locks")
# the PAT fit asks its own remark; the journey's routes 404 an admin (_review_guard); the demo reset is demo accounts only
OWN_REMARK = {"admin_performance_pbt_fit"}
unlisted = []
for ep, fn in a.app.view_functions.items():
    r = rules.get(ep)
    if not r or "POST" not in r.methods or ep in a.SUPER_BAND_ENDPOINTS or ep in OWN_REMARK:
        continue
    if ep.startswith("review_") or r.rule.startswith("/review/"):
        continue
    try:
        src = inspect.getsource(fn)
    except (OSError, TypeError):
        continue
    if any(w in src for w in WRITERS):
        unlisted.append(ep)
s.check("no route that writes a band is left off the list", not unlisted, unlisted)
s.check("...and the lint can see a writer (it finds the override's own call)",
        any(w in inspect.getsource(a.app.view_functions["pm_calibration_override"]) for w in WRITERS))
s.check("the journey's routes the lint skips really are closed to an admin",
        "abort(404)" in inspect.getsource(a._review_guard) and "admin" in inspect.getsource(a._review_guard))


def url_for_rule(r):
    args = {}
    for name in r.arguments:
        conv = r._converters.get(name)
        args[name] = 999999 if conv.__class__.__name__ == "IntegerConverter" else "ZZSB-none"
    with a.app.test_request_context("/"):
        from flask import url_for
        return url_for(r.endpoint, **args)


def action_for(ep):
    acts = a.SUPER_BAND_ENDPOINTS[ep]
    return sorted(acts)[0] if acts else None


# ------------------------------------------------------------------------------------------------------------------
s.section("refused without a remark, before the route runs")
SUP, BG = H.client_as(a, SU["id"]), H.client_as(a, BGA["id"])
log0 = H.one(a, "SELECT COALESCE(MAX(id),0) FROM activity_log")
not_refused, json_bad, bg_asked = [], [], []
for ep in sorted(a.SUPER_BAND_ENDPOINTS):
    url = url_for_rule(rules[ep])
    data = {"csrf_token": "tok"}
    if action_for(ep):
        data["action"] = action_for(ep)
    r = SUP.post(url, data=data, follow_redirects=True)
    if REMARK_ERR not in r.get_data(as_text=True):
        not_refused.append((ep, r.status_code))
    rj = SUP.post(url, data=data, headers={"X-Requested-With": "XMLHttpRequest"})
    try:
        body = json.loads(rj.get_data(as_text=True))
    except ValueError:
        body = {}
    if rj.status_code != 400 or body.get("ok") is not False or REMARK_ERR not in (body.get("error") or ""):
        json_bad.append((ep, rj.status_code))
    rb = BG.post(url, data=data, headers={"X-Requested-With": "XMLHttpRequest"})
    if REMARK_ERR in rb.get_data(as_text=True):
        bg_asked.append(ep)
s.check("every listed endpoint refuses the super admin's post with no remark (%d endpoints)"
        % len(a.SUPER_BAND_ENDPOINTS), not not_refused, not_refused)
s.check("...answering JSON 400 to the autosave pages", not json_bad, json_bad)
s.check("...and nothing was written: no audit row from any of them",
        H.one(a, "SELECT COUNT(*) FROM activity_log WHERE id > ? AND user_id=?", (log0, SU["id"])) == 0)
s.check("a BG admin is never asked (their post goes on to the route's own answer)", not bg_asked, bg_asked)

url = url_for_rule(rules["pm_calibration_override"])
for bad, why in (("   ", "blank"), ("x" * (a.SUPER_BAND_REMARK_MAX + 1), "over the limit")):
    r = SUP.post(url, data={"csrf_token": "tok", "remark": bad}, headers={"X-Requested-With": "XMLHttpRequest"})
    s.check("a %s remark is refused" % why, r.status_code == 400, r.status_code)
r = SUP.post(url, data={"csrf_token": "tok", "remark": "ZZSB a real reason", "subject_id": "999999"},
             headers={"X-Requested-With": "XMLHttpRequest"})
s.check("with a remark the gate lets it through to the route (which answers for the missing person itself)",
        r.status_code == 200 and REMARK_ERR not in r.get_data(as_text=True), r.status_code)
r = SUP.post(url_for_rule(rules["admin_settings"]), data={"csrf_token": "tok", "action": "calib_assist"},
             follow_redirects=True)
s.check("a setting that moves no band is not asked (the AI assistant switch)", REMARK_ERR not in r.get_data(as_text=True))
r = SUP.post(url_for_rule(rules["pm_calibration_buceo_lock"]), data={"csrf_token": "tok", "override_reason": "ZZSB edge"},
             follow_redirects=True)
s.check("a Lock with override's reason counts as the remark", REMARK_ERR not in r.get_data(as_text=True))

# ------------------------------------------------------------------------------------------------------------------
s.section("the remark in the audit trail")
with a.app.test_request_context("/"):
    from flask import g
    g.super_band_remark = "ZZSB agreed at the group meeting"
    s.check("an audit row's detail carries it", a._with_super_remark("X: AE -> OU") ==
            "X: AE -> OU · remark: ZZSB agreed at the group meeting")
    s.check("...once, when the detail already says it",
            a._with_super_remark("X: AE -> OU — ZZSB agreed at the group meeting").count("ZZSB") == 1)
    s.check("...and an empty detail becomes the remark", a._with_super_remark(None) ==
            "remark: ZZSB agreed at the group meeting")
with a.app.test_request_context("/"):
    s.check("no remark outside a band action: the detail is untouched", a._with_super_remark("plain") == "plain")
s.check("both audit writers carry it, and both band-row writers default to it", all(
    "_with_super_remark(" in inspect.getsource(f) for f in (a.log_activity, a._leader_log)) and all(
    "_super_remark_now()" in inspect.getsource(f) for f in (a._pm_calib_upsert_adjustment,
                                                             a._calibration_upsert_adjustment)))

# ------------------------------------------------------------------------------------------------------------------
s.section("the confirm box asks the super admin only")
with a.app.test_request_context("/"):
    from flask import session as _s
    _s["user_id"] = SU["id"]
    on = str(a.super_remark_attrs(confirm="Save it?", ok="Save"))
    _s["user_id"] = BGA["id"]
    off = str(a.super_remark_attrs(confirm="Save it?", ok="Save"))
s.check("the super admin's forms carry the remark box (into `remark`, at the remark's limit)",
        'data-confirm-reason-field="remark"' in on and 'data-confirm-reason-max="%d"' % a.SUPER_BAND_REMARK_MAX in on
        and 'data-confirm="Save it?"' in on)
s.check("...nobody else's", off == "")
TPL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "templates")


def tpl(name):
    return open(os.path.join(TPL, name), encoding="utf-8").read()
for name in ("admin_final_bands.html", "pm_calibration_tier.html", "calibration_hod.html", "calibration_company.html",
             "calibration_bg.html", "talent_box.html", "_gc_panels.html", "settings/_pm.html",
             "settings/cards/_thresholds.html", "settings/cards/_band_weights.html", "settings/cards/_extremes.html",
             "settings/cards/_rules.html"):
    s.check("%s asks for it" % name, "super_remark_attrs(" in tpl(name))
pt = tpl("pm_calibration_tier.html")
ov = pt[pt.find("url_for('pm_calibration_override')"):][:1400]
s.check("the override saves only by its button (no autosave, no separate note box)",
        "data-no-autosave" in ov and 'name="justification"' not in ov)
cj = open(os.path.join(TPL, "..", "static", "calibration.js"), encoding="utf-8").read()
s.check("calibration.js skips it and asks the remark before a row autosaves",
        "data-no-autosave" in cj and "askFormReason" in cj and "function postRow" in cj)
s.check("base.html offers that ask", "window.askFormReason" in tpl("base.html"))
s.check("the AI assistant link is hidden from the super admin", "not is_super_view" in pt)
src = inspect.getsource(a.pm_calib_chat)
s.check("...and the assistant moves no band for them (refused before the model runs)",
        src.find("is_super(u)") != -1 and src.find("is_super(u)") < src.find("review_agent("))

# ------------------------------------------------------------------------------------------------------------------
s.section("end to end: a settings rule")
with a.app.test_request_context("/"):
    en, bonus, penalty = a.get_extremes_adjustment_settings()
form = {"csrf_token": "tok", "action": "extremes", "extremes_bonus_points": "%g" % bonus,
        "extremes_penalty_points": "%g" % penalty, **({"extremes_enabled": "1"} if en else {})}
log1 = H.one(a, "SELECT COALESCE(MAX(id),0) FROM activity_log")
r = SUP.post("/admin/settings", data=form, follow_redirects=True)
s.check("without a remark: refused, nothing logged", REMARK_ERR in r.get_data(as_text=True) and H.one(
    a, "SELECT COUNT(*) FROM activity_log WHERE id > ? AND user_id=?", (log1, SU["id"])) == 0)
try:
    SUP.post("/admin/settings", data=dict(form, remark="ZZSB checked with P&R"), follow_redirects=True)
    s.check("with one: saved (the same values), its audit row carrying the remark", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE id > ? AND user_id=? AND action='settings' AND "
           "detail LIKE '%Extreme-assessor%remark: ZZSB checked with P&R%'", (log1, SU["id"])) == 1)
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM activity_log WHERE id > ? AND user_id=?", (log1, SU["id"]))
        db.commit()

sys.exit(s.done())
