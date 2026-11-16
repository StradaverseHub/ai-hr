"""Grade H Appraisal is dark on a server that does not set ONEHR_GRADEH: every REAL route, not a stand-in (2026-10-31).

test_gradeh_gate proves the gate on stand-in probe routes. This suite walks the real url_map, because the production deploy
ships Grade H dark and its unauthenticated route probe accepts only 200 / 301 / 302 / 303 for a GET: one 404 or 500 on a
signed-out Grade H page fails the deploy.

What this suite holds, with ONEHR_GRADEH unset:
  * at least 40 real routes sit under /my-appraisal, /review/gradeh, /calibration/gradeh and /admin/gradeh, plus
    /demo/gradeh-reset (POST only, the staging demo's reset)
  * signed out, every parameterless GET answers 301 / 302 / 303 (the route probe's rule)
  * signed in as an ordinary employee and as the super admin, every GET answers 404 (a route's <int:..> values are filled
    with a real user id) and every POST answers 404 (the CSRF token is in the form, so a 404 is the gate's, never a 400)
  * control: with ONEHR_GRADEH=1 the super admin gets 200 on /admin/gradeh (the walk would not find a dark page that is
    simply broken)
  * falsified in the suite itself: with _gradeh_gate taken out of the app's before_request chain, the same signed-in walk
    finds routes that do not answer 404, so the walk can fail; the gate is then put back and the walk is clean again

Synthetic scratch copy only; the suite puts back the environment variable and the before_request chain.
"""
import os
import sys

from werkzeug.routing.converters import NumberConverter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Grade H Appraisal: dark on every real route")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, EMP = H.actors(a)
_ENV0 = os.environ.get("ONEHR_GRADEH")
PREFIXES = ("/my-appraisal", "/review/gradeh", "/calibration/gradeh", "/admin/gradeh")
EXTRA = ("/demo/gradeh-reset",)


def env(v):
    if v is None:
        os.environ.pop("ONEHR_GRADEH", None)
    else:
        os.environ["ONEHR_GRADEH"] = v


def grade_h_rules():
    return [r for r in a.app.url_map.iter_rules()
            if any(r.rule == p or r.rule.startswith(p + "/") for p in PREFIXES) or r.rule in EXTRA]


def fill(rule, uid):
    """The path for a rule: an <int:..> takes a real user id, any other converter a plain word."""
    vals = {arg: (uid if isinstance(rule._converters[arg], NumberConverter) else "x") for arg in rule.arguments}
    return rule.build(vals)[1]


def walk_signed_in(client, uid):
    """Every Grade H route, as one signed-in person: the (method, path, status) of each that is NOT a 404."""
    bad = []
    for r in grade_h_rules():
        path = fill(r, uid)
        if "GET" in r.methods:
            st = client.get(path).status_code
            if st != 404:
                bad.append(("GET", path, st))
        if "POST" in r.methods:
            st = client.post(path, data={"csrf_token": "tok"}).status_code
            if st != 404:
                bad.append(("POST", path, st))
    return bad


try:
    env(None)
    rules = grade_h_rules()
    s.section("the real routes")
    s.check("at least 40 real Grade H routes (found %d)" % len(rules), len(rules) >= 40, len(rules))
    s.check("the staging demo's reset is among them, POST only", any(r.rule == "/demo/gradeh-reset" and "GET" not in r.methods
                                                                      for r in rules))
    for p in PREFIXES:
        s.check("something sits under %s" % p, any(r.rule == p or r.rule.startswith(p + "/") for r in rules))
    s.check("an <int:..> converter is what the filler recognises (the walk would otherwise send 'x' as an id)",
            any(isinstance(r._converters[arg], NumberConverter) for r in rules for arg in r.arguments))

    s.section("signed out: every parameterless GET answers 301 / 302 / 303 (the deploy's route probe)")
    out = a.app.test_client()
    gets = [r for r in rules if "GET" in r.methods and not r.arguments]
    s.check("there are parameterless GETs to probe (found %d)" % len(gets), len(gets) >= 10, len(gets))
    seen = {r.rule: out.get(r.rule).status_code for r in gets}
    s.check("every one answers 301 / 302 / 303, never a 404 or 500", all(v in (301, 302, 303) for v in seen.values()),
            {k: v for k, v in seen.items() if v not in (301, 302, 303)})
    s.check("a signed-out POST is not served either (no 200)", all(
        out.post(r.rule, data={"csrf_token": "tok"}).status_code != 200 for r in rules if "POST" in r.methods and not r.arguments))

    s.section("flag off, signed in: every GET and every POST answers 404")
    for who, u in (("an employee", EMP), ("the super admin", SU)):
        c = H.client_as(a, u["id"])
        bad = walk_signed_in(c, EMP["id"])
        s.check("%s: all %d routes answer 404 (GET and POST)" % (who, len(rules)), not bad, bad[:6])

    s.section("falsified: with the gate out of the chain the same walk finds routes that are not 404")
    chain = a.app.before_request_funcs[None]
    kept = list(chain)
    try:
        s.check("the gate is in the chain to begin with", a._gradeh_gate in chain)
        chain[:] = [f for f in chain if f is not a._gradeh_gate]
        bad_open = walk_signed_in(H.client_as(a, SU["id"]), EMP["id"])
        s.check("without the gate the walk reports routes that answer something other than 404 (%d)" % len(bad_open),
                len(bad_open) > 0, bad_open[:3])
    finally:
        chain[:] = kept
    s.check("the gate is back in the chain", a._gradeh_gate in a.app.before_request_funcs[None])
    s.check("and the walk is clean again", not walk_signed_in(H.client_as(a, SU["id"]), EMP["id"]))

    s.section("control: with ONEHR_GRADEH=1 the super admin reaches the admin page")
    env("1")
    r = H.client_as(a, SU["id"]).get("/admin/gradeh")
    s.check("/admin/gradeh answers 200 for the super admin", r.status_code == 200, r.status_code)
    env(None)
    s.check("and 404 again the moment the switch is off", H.client_as(a, SU["id"]).get("/admin/gradeh").status_code == 404)
finally:
    env(_ENV0)

sys.exit(s.done())
