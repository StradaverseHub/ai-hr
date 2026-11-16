"""Module gating: off means off -- f72c126.

RECONSTRUCTED after a macOS cleanup lost the original; same invariants, taken
from the commit's own record.

A cycle can switch any of the seven modules off. Before this, the toggle only
filtered Hub tiles -- every route stayed live and still accepted POSTs, so a
bookmark kept a switched-off module fully usable.

THE COVERAGE ASSERTION BELOW IS THE POINT OF THE DESIGN. A decorator is only as
good as the day somebody remembers to add it; a central map can be asserted over
the whole URL map, so a new route that nobody classified fails here rather than
shipping ungated.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Module gate -- off means off")
SU, _BG, EMP = H.actors(a)

s.section("the machinery is installed")
for name in ("module_of_request", "_module_gate", "cycle_module_on",
             "cycle_modules_off", "CYCLE_MODULE_KEYS"):
    s.check("%s present" % name, hasattr(a, name))
# Eight since Phase A added the evidence ledger. Asserting the exact count on
# purpose: a module added without a route prefix would pass the coverage
# assertion below by simply having no routes yet, and this catches it.
# Seven since Succession and Reward were archived (2026-10-08) -- they left the tuple for ARCHIVED_MODULES; six since
# Promotion was (2026-10-13).
s.check("six modules", len(a.CYCLE_MODULE_KEYS) == 6, a.CYCLE_MODULE_KEYS)
s.check("evidence is one of them", "evidence" in a.CYCLE_MODULE_KEYS)

s.section("EVERY route is classified -- the assertion the design exists for")
# Each route must resolve to a module, sit under /admin, or be named in the
# ungated list. A route nobody classified fails HERE.
# module_of_request() takes (endpoint, path) precisely so a test can resolve
# every rule without issuing a request -- its own docstring says so.
unclassified = []
rules = [r for r in a.app.url_map.iter_rules() if r.endpoint != "static"]
for rule in rules:
    if rule.rule == "/admin" or rule.rule.startswith("/admin/"):
        continue
    if rule.endpoint in a.MODULE_UNGATED_ENDPOINTS:
        continue
    if rule.endpoint == "__scratch_login":
        continue          # the harness's own shim, injected into the copy only
    if not a.module_of_request(rule.endpoint, rule.rule):
        unclassified.append((rule.endpoint, rule.rule))
s.note("%d routes in the map, %d ungated by name, %d module prefixes"
       % (len(rules), len(a.MODULE_UNGATED_ENDPOINTS), len(a.MODULE_ROUTE_PREFIXES)))
s.check("every route resolves to a module, /admin, or the ungated list",
        not unclassified, unclassified[:5])

s.section("the safe default is inherited, not re-implemented")
# cycle_module_on() reads an unmapped key and a cycle with no rows as ON, so the
# gate can only ever refuse a module a human explicitly switched off.
with a.app.test_request_context("/"):
    from flask import session
    session["user_id"] = SU["id"]
    db = a.get_db()
    s.check("an unmapped key is ON", a.cycle_module_on("not_a_module", db) is True)
    # Every module that PREDATES the row-seeding convention is on by absence.
    # Two exceptions, both on purpose: Phase A seeds 'evidence' active=0 and
    # Phase C seeds 'review' the same way, so each SHIPS switched off -- which is
    # a row, not an absence. The claim that they are seeded off belongs in their
    # own suites, which take a FRESH database copy and can make it; this one
    # takes the scratch database as it finds it and cannot.
    SEEDED_OFF = ("evidence", "review")
    inherited = [k for k in a.CYCLE_MODULE_KEYS if k not in SEEDED_OFF]
    s.check("every module without a row reads as ON",
            all(a.cycle_module_on(k, db) for k in inherited),
            [k for k in inherited if not a.cycle_module_on(k, db)])
    # Whether 'evidence' is currently off is NOT asserted here: this suite takes
    # the scratch database as it finds it, and another suite (or a browser
    # session) may have switched it on. test_evidence.py owns that claim and
    # makes it against a fresh copy.

s.section("/admin is deliberately NOT gated")
# An admin must be able to open a module's settings WHILE it is off -- that is
# when you configure it, ahead of switching it on. Gating admin pages would shut
# the only door behind them.
admin_gated = [r.rule for r in a.app.url_map.iter_rules()
               if (r.rule == "/admin" or r.rule.startswith("/admin/"))
               and a.module_of_request(r.endpoint, r.rule)]
s.check("no /admin route resolves to a gated module", not admin_gated, admin_gated[:5])

s.section("switching a module off closes it -- recorded baseline, then delta")
# Several of these routes answer 302 or 403 on their own merits against the
# local database, so "still 404" would read as a pass. Record first, then assert
# CHANGED for the module's own probe and UNCHANGED for the others.
PROBE = {"idp": "/idp", "calibration": "/calibration",
         "pm": "/performance", "tm": "/my-report"}   # promotion: archived 2026-10-13 (below)
# Separate write probes: a GET-only route answers 405 from Flask's ROUTING,
# before any gate runs, so posting to /idp would "fail" while proving nothing.
# Each of these genuinely accepts POST and carries no URL parameters.
WRITE = {"idp": "/idp/autosave", "calibration": "/calibration/bg/lock",
         "pm": "/performance/submit-all", "tm": "/technical/autosave"}
E = H.client_as(a, EMP["id"])
baseline = {k: E.get(p).status_code for k, p in PROBE.items()}
s.note("baseline: %s" % baseline)

with a.app.app_context():
    db = a.get_db()
    cid = a.active_cycle_id(db)
    prev = db.execute("SELECT module_key, active FROM cycle_modules "
                      "WHERE cycle_id=?", (cid,)).fetchall()

def set_module(key, active):
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?) "
                   "ON CONFLICT(cycle_id, module_key) DO UPDATE SET active=excluded.active",
                   (cid, key, 1 if active else 0))
        db.commit()

try:
    for key, path in PROBE.items():
        set_module(key, False)
        E2 = H.client_as(a, EMP["id"])
        got = E2.get(path).status_code
        s.check("%-12s off -> its own page 404s" % key,
                got == 404 and baseline[key] != 404, (baseline[key], got))
        # A GET explains; a WRITE gets a bare 404 -- a form left open when the
        # module was switched off must not save.
        w = E2.post(WRITE[key], data={"csrf_token": "tok"})
        s.check("%-12s off -> a write is refused (%s)" % (key, WRITE[key]),
                w.status_code == 404, w.status_code)
        others = {k: H.client_as(a, EMP["id"]).get(p).status_code
                  for k, p in PROBE.items() if k != key}
        moved = {k: (baseline[k], v) for k, v in others.items() if v != baseline[k]}
        s.check("%-12s off -> the others are untouched" % key, not moved, moved)
        set_module(key, True)
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM cycle_modules WHERE cycle_id=?", (cid,))
        for r in prev:
            db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) "
                       "VALUES (?,?,?)", (cid, r["module_key"], r["active"]))
        db.commit()

s.section("an ANONYMOUS request goes to sign-in, never to the module-off page")
# This hook is a before_request, so it runs before @login_required and would
# otherwise answer 404 to somebody who is simply not signed in. Two reasons that
# is wrong: an anonymous visitor should not learn which modules a cycle runs,
# and the staging deploy's route probe fetches every parameterless GET route
# UNAUTHENTICATED and counts a 404 as a broken route. Shipping the evidence
# ledger switched off made /evidence the first genuinely-off module on that VM,
# and the deploy rolled itself back. Both mechanisms were right.
anon = a.app.test_client()
set_module("evidence", False)
r = anon.get("/evidence")
s.check("anonymous GET of an OFF module redirects to sign-in",
        r.status_code in (301, 302), r.status_code)
s.check("...and does not name the module",
        b"switched off" not in r.data and b"module" not in r.data.lower())
# Every parameterless GET route must answer the way that probe expects.
probe_bad = []
for rule in a.app.url_map.iter_rules():
    if rule.endpoint == "static" or "GET" not in (rule.methods or ()):
        continue
    if rule.arguments:
        continue
    code = a.app.test_client().get(rule.rule).status_code
    if code >= 400:
        probe_bad.append((rule.rule, code))
s.check("no parameterless GET route 4xx/5xx unauthenticated (the deploy probe)",
        not probe_bad, probe_bad[:6])
set_module("evidence", True)

s.section("a GET explains itself")
s.check("the module_off page exists",
        os.path.exists(os.path.join(H.HARNESS, "templates", "errors", "module_off.html")))

s.section("Succession and Reward are archived: taken out of OneHR, code and data kept (Chris, 2026-10-08)")
s.check("both are ARCHIVED_MODULES, out of the cycle's modules, and read OFF in every cycle",
        {"succession", "reward"} <= set(a.ARCHIVED_MODULES)
        and not set(a.ARCHIVED_MODULES) & set(a.CYCLE_MODULE_KEYS)
        and not a.cycle_module_on("succession") and not a.cycle_module_on("reward"))
s.check("every URL they own maps to them, their admin pages too; nothing else does",
        a.archived_module_of("/succession") == "succession" and a.archived_module_of("/succession/trc/3") == "succession"
        and a.archived_module_of("/reward/bonus") == "reward" and a.archived_module_of("/admin/reward/config") == "reward"
        and a.archived_module_of("/admin/succession/config") == "succession"
        and a.archived_module_of("/rewards") is None and a.archived_module_of("/performance") is None)
_E = H.client_as(a, EMP["id"])
_bad = [(p_, _E.get(p_).status_code, _E.get(p_).headers.get("Location", "")) for p_ in
        ("/succession", "/succession/trc", "/reward/bonus", "/reward/merit", "/reward/off-cycle")]
s.check("a signed-in GET of any of their pages goes to the dashboard, saying why",
        all(c in (301, 302) and loc.endswith("/dashboard") for _p, c, loc in _bad), _bad)
_E2 = H.client_as(a, EMP["id"])
_E2.get("/reward/bonus")
_land = _E2.get("/dashboard").get_data(as_text=True)
s.check("...the dashboard says the module has been taken out", "Reward has been taken out of OneHR." in _land)
_S = H.client_as(a, SU["id"])
_ad = [(p_, _S.get(p_).status_code, _S.get(p_).headers.get("Location", "")) for p_ in
       ("/admin/reward/config", "/admin/reward/salaries", "/admin/succession/config", "/reward/merit")]
s.check("an admin's GET (their admin pages too) goes to the admin home",
        all(c in (301, 302) and loc.endswith("/admin") for _p, c, loc in _ad), _ad)
_w = [(p_, H.client_as(a, EMP["id"]).post(p_, data={"csrf_token": "tok"}).status_code)
      for p_ in ("/succession/position", "/succession/nominate", "/reward/bonus")]
s.check("anything that writes gets a bare 404", all(c == 404 for _p, c in _w), _w)
_an = [(p_, a.app.test_client().get(p_).status_code) for p_ in ("/succession", "/reward/bonus", "/admin/reward/config")]
s.check("nobody signed in gets a plain 404: the pages themselves are deleted (2026-10-11), so the deploy's route "
        "probe never lists them", all(c == 404 for _p, c in _an), _an)
_keys = [m.get("key") for m in a.ADMIN_MODULES]
s.check("the admin menu offers neither", "succession" not in _keys and "reward" not in _keys, _keys)

s.section("Promotion and the PIP / promotion lists are archived: another platform runs them (Chris, 2026-10-13)")
s.check("Promotion and the decision lists are ARCHIVED_MODULES, out of the cycle's modules, read OFF; nothing is parked",
        set(a.ARCHIVED_MODULES) == {"succession", "reward", "promotion", "talent_decisions"}
        and "promotion" not in a.CYCLE_MODULE_KEYS and not a.cycle_module_on("promotion") and a.PARKED_MODULES == ())
s.check("its URLs map to it (its admin page too); the PIP / promotion lists, which share /talent-box/ with the box, "
        "by endpoint; the box itself and the PIP/Improvement category are untouched",
        a.archived_module_of("/promotion-nomination") == "promotion"
        and a.archived_module_of("/promotion-nomination/off-cycle") == "promotion"
        and a.archived_module_of("/admin/promotion/config") == "promotion"
        and a.archived_module_of("/promotion-nominations") is None
        and a.archived_module_of("/talent-box/bg/ZZ/pip", "talent_pip_bgceo") == "talent_decisions"
        and a.archived_module_of("/talent-box/company/ZZ/Co/promotion/lock", "talent_promotion_lock_buceo")
        == "talent_decisions"
        and a.archived_module_of("/talent-box/bg/ZZ", "talent_box_bgceo") is None
        and a.archived_module_of("/talent-box/bg/ZZ/tag", "talent_box_bgceo_tag") == "reward"   # the pins, 2026-10-13
        and "PIP/Improvement" in a.TALENT_CATEGORY_ORDER)
_pg = [(p_, _E.get(p_)) for p_ in ("/promotion-nomination", "/promotion-nomination/off-cycle", "/talent-box/bg/ZZ/pip",
                                    "/talent-box/company/ZZ/Co/promotion", "/talent-box/group/1/pip")]
_pg = [(p_, r_.status_code, r_.headers.get("Location", "")) for p_, r_ in _pg]
s.check("a signed-in GET of any of them goes to the dashboard", all(c in (301, 302) and loc.endswith("/dashboard")
                                                                  for _p, c, loc in _pg), _pg)
_E3 = H.client_as(a, EMP["id"])
_E3.get("/talent-box/bg/ZZ/pip")
s.check("...saying why", "The PIP and promotion step has been taken out of OneHR."
        in _E3.get("/dashboard").get_data(as_text=True))
_ra = _S.get("/admin/promotion/config")
s.check("its admin page goes to the admin home", _ra.status_code in (301, 302)
        and _ra.headers.get("Location", "").endswith("/admin"), (_ra.status_code, _ra.headers.get("Location")))
_w2 = [(p_, H.client_as(a, EMP["id"]).post(p_, data={"csrf_token": "tok"}).status_code)
       for p_ in ("/promotion-nomination/nominate", "/talent-box/bg/ZZ/pip/decide", "/talent-box/bg/ZZ/promotion/lock")]
s.check("anything that writes gets a bare 404", all(c == 404 for _p, c in _w2), _w2)
_an2 = [(p_, a.app.test_client().get(p_).status_code) for p_ in ("/promotion-nomination", "/admin/promotion/config")]
s.check("nobody signed in is sent to sign in, as before (the routes stay, so the deploy's route probe reads a redirect)",
        all(c in (301, 302) for _p, c in _an2), _an2)
_src = H.source(a)
_tb = open(os.path.join(H.HARNESS, "templates", "talent_box.html"), encoding="utf-8").read()
_jsx = H.source(a, "static/journey_chat.js")
s.check("no door leads to them: the Talent Box has no PIP / Promotion tabs, lock hand-over or promotion tag; the lock "
        "returns to the box; the dashboard has no Promotion door; the AI+ box has no PIP link or offer",
        "stage_tabs" not in _tb and "talent_pip_" not in _tb and "talent_promotion_" not in _tb
        and "promotion_tag" not in _tb and 'url_for(f"talent_pip_{tier}"' not in _src
        and 'url_for("promotion_nomination")' not in _src and '"pip_url"' not in _src and "_PIP_CHIP" not in _src
        and "pip_url" not in _jsx and "PIP candidates \\u2192" not in _jsx)
s.check("...and a stale form still posting the promotion tag is refused, not half-applied",
        'if request.form.get("promotion_tag"):   # Promotion is archived (2026-10-13)' in _src)
_html = H.client_as(a, SU["id"]).get("/admin/cycles").get_data(as_text=True)
s.check("the cycle page has no tick box for either", 'value="succession"' not in _html and 'value="reward"' not in _html)
_src = open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read()
s.check("the help never sends anyone to them (the four reworded KB entries, seed and one-time update)",
        "for succession planning" not in _src.split("_KB_MOBILITY_BODY = (")[1][:600]
        and "can inform reward" not in _src.split("_KB_AFTER_SUBMIT_BODY = (")[1][:600]
        and _src.count("AND body LIKE '%can inform reward%'") == 1
        and _src.count("AND body LIKE '%informs succession planning%'") == 1)
with a.app.app_context():
    _kb = {r["slug"]: r["body"] for r in a.get_db().execute(
        "SELECT slug, body FROM kb_entries WHERE slug IN "
        "('mobility-preference','potential-band','career-profile-about','after-submit')")}
s.check("...and the database's own rows read the new text",
        _kb and not any(("succession" in b.lower()) or ("reward" in b.lower()) for b in _kb.values()), _kb)

s.section("templates")
n, broken = H.every_template_compiles(a)
s.check("all %d templates compile" % n, not broken, broken[:3])

sys.exit(s.done())
