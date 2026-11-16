"""One rule for every redirect that comes back to a page (security test 3-02 + 3-06, 2026-10-31).

  GET /admin/cycle/select?next=/%09/evil.example answered `Location: //evil.example` (the browser drops the tab, leaving
  a protocol-relative URL), and so did POST /admin/release's `next`; the Referer redirects kept a leading `//`. Now
  _local_path(nxt, default) strips control characters, refuses a backslash, and needs one "/" followed by a character
  that is neither "/" nor "\\"; _referer_path() runs a same-host Referer through it.

Checks: the helper on every payload shape the test used (17) plus Referer shapes, normal values from real links come
back unchanged, and each redirect on the list (cycle select, the demo switch, release, the super-admin band gate's
Referer, the system-admin refusal, the closed-window refusal, the two calibration override `back` fields) end to end.
"""
import os
import re
import sys
from urllib.parse import quote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Redirects: one same-site path rule for next, back and Referer")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

# against a build without the helpers (falsifying: a clean copy of the old code) the stand-ins pass everything through,
# so the checks fail on what the old code did instead of the suite stopping at an AttributeError
_lp = getattr(a, "_local_path", lambda n, d: n or d)


def _rp(default):
    from flask import request as _rq
    from urllib.parse import urlparse as _up
    _r = _up(_rq.referrer or "")
    return _r.path if _r.netloc == _rq.host and _r.path else default


_rp = getattr(a, "_referer_path", _rp)

class _Boom:
    """What a request that crashed the app (a header the server refused to write) looks like to the checks."""
    status_code = 500
    headers = {}


class _Safe:
    def __init__(self, c):
        self.c = c

    def get(self, *a, **k):
        try:
            return self.c.get(*a, **k)
        except Exception:
            return _Boom()

    def post(self, *a, **k):
        try:
            return self.c.post(*a, **k)
        except Exception:
            return _Boom()


EV = "evilx.example"
PAY = ["//" + EV, "https:" + EV, "/\\" + EV, "/%5C" + EV, "%2F%2F" + EV, "\\\\" + EV, "/\\/" + EV, "http://" + EV,
       "///" + EV, "https://" + EV, "javascript:alert(1)", "/\t/" + EV, "/ /" + EV, "/admin/\\" + EV,
       "/review/journey//" + EV, "/review/journey\\" + EV, "/admin//" + EV,
       # more shapes
       "/\n/" + EV, "/\r\n/" + EV, "/\x00/" + EV, "\t//" + EV, " //" + EV, "/\x0b/" + EV, "/ /" + EV,
       "/\\\\" + EV, "data:text/html,x", "", "   ", "evil", "/\t\\" + EV]


def evil(loc):
    """True when this Location would take a browser off this site (what a browser does with it, tabs dropped)."""
    if loc is None:
        return False
    l = re.sub(r"[\t\r\n]", "", loc).strip()
    return bool(re.match(r"^(https?:)?[/\\]{2}", l) or re.match(r"^/\\", l) or re.match(r"^\\", l)
                or re.match(r"^[a-z][a-z0-9+.-]*:", l, re.I) or EV in l.split("?")[0].split("#")[0] and not l.startswith("/"))


s.section("the helper: nothing hostile comes back")
DEF = "/dash-default"
out = {p: _lp(p, DEF) for p in PAY}
s.check("%d shapes (tab, newline, NUL, backslash, //, scheme, blank ...): none comes back as an off-site target" % len(PAY),
        not [p for p, v in out.items() if evil(v)], [p for p, v in out.items() if evil(v)])
MUST_REFUSE = [p for p in PAY if re.sub(r"[\x00-\x1f\x7f]", "", p).strip()[:2] in ("//", "/\\", "\\\\")
               or not re.sub(r"[\x00-\x1f\x7f]", "", p).strip().startswith("/")]
s.check("every shape that opens with //, /\\ or no / at all (%d of them) is the default" % len(MUST_REFUSE),
        len(MUST_REFUSE) >= 20 and all(out[p] == DEF for p in MUST_REFUSE), [p for p in MUST_REFUSE if out[p] != DEF])
s.check("the finding's own payloads (a tab between the slashes, a protocol-relative URL) are the default",
        out["/\t/" + EV] == DEF and out["//" + EV] == DEF and out["/\\" + EV] == DEF)

s.section("the helper: ordinary values from real links come back as they were")
NORMAL = ["/admin/performance?x=1&y=2", "/admin/cycle/home?cycle=3#panel", "/review/journey", "/dashboard",
          "/admin/users?q=a%20b&page=2&per_page=50", "/performance/calibration/x?back=//ok", "/admin/leaders?tab=buceo&bg=A%26B&panel=bp-3",
          "/admin/settings#band-visibility", "/", "/admin/module/pm?tab=a%5Cb", "/talent-box/bg?bg=CHBM&unit=A+B"]
s.check("normal values unchanged", all(_lp(v, DEF) == v for v in NORMAL),
        [v for v in NORMAL if _lp(v, DEF) != v])
s.check("whitespace around a good path is trimmed; a control character inside it is dropped",
        _lp("  /admin/users \n", DEF) == "/admin/users" and _lp("/admin/\tusers", DEF) == "/admin/users")
s.check("None and non-text give the default", _lp(None, DEF) == DEF and _lp(5, DEF) == DEF)

s.section("the Referer helper")
SU, BG, EMP = H.actors(a)


def ref_path(ref, default=DEF):
    with a.app.test_request_context("/x", headers={"Referer": ref} if ref is not None else {}):
        return _rp(default)


s.check("a same-host Referer comes back as its path and query",
        ref_path("http://localhost/admin/users?q=a&page=2") == "/admin/users?q=a&page=2")
s.check("the site's root Referer comes back as /", ref_path("http://localhost/") == "/")
s.check("another host, none, or junk gives the default", ref_path("http://" + EV + "/x") == DEF and ref_path(None) == DEF
        and ref_path("not a url") == DEF)
refs = ["http://localhost//" + EV, "http://localhost///" + EV, "http://localhost/\\" + EV, "http://localhost//%5C" + EV,
        "http://localhost/\t/" + EV, "http://localhost/ /" + EV, "http://localhost/\\/" + EV]
s.check("a same-host Referer whose path opens with // or a backslash gives the default (3-06)",
        all(not evil(ref_path(r)) and ref_path(r) in (DEF, "/ /" + EV) for r in refs),
        [(r, ref_path(r)) for r in refs if evil(ref_path(r))])
s.check("...and the old value would have kept the //: the path of the first shape is '//evilx.example'",
        __import__("urllib.parse", fromlist=["urlparse"]).urlparse(refs[0]).path == "//" + EV)

s.section("end to end: GET /admin/cycle/select?next=")
C = _Safe(H.client_as(a, SU["id"]))
cid = H.one(a, "SELECT id FROM cycles ORDER BY id DESC LIMIT 1")
seen = []
for p in PAY:
    r = C.get("/admin/cycle/select?cycle=%d&next=%s" % (cid, quote(p, safe="")))
    seen.append((p, r.status_code, r.headers.get("Location")))
s.check("every hostile next answers 302 to a path on this site", all(c == 302 and not evil(l) for _p, c, l in seen),
        [x for x in seen if x[1] != 302 or evil(x[2])][:4])
s.check("the tab payload (the finding) lands on the default, the admin overview",
        [l for p, c, l in seen if p == "/\t/" + EV] == [a.url_for_test("admin_overview")] if hasattr(a, "url_for_test") else
        all(l.endswith("/admin") or l.endswith("/admin/") or "/admin" in (l or "") for p, c, l in seen if p == "/\t/" + EV),
        [l for p, c, l in seen if p == "/\t/" + EV])
ok = []
for v in NORMAL:
    r = C.get("/admin/cycle/select?cycle=%d&next=%s" % (cid, quote(v, safe="")))
    ok.append((v, r.headers.get("Location")))
s.check("every normal next still goes where it said", all(l == v for v, l in ok), [x for x in ok if x[0] != x[1]])

s.section("end to end: POST /admin/release's next (_safe_next)")
seen = []
for p in PAY:
    r = C.post("/admin/release", data={"csrf_token": "tok", "next": p})
    seen.append((p, r.status_code, r.headers.get("Location")))
s.check("every hostile next answers 302 to a path on this site",
        all(c == 302 and not evil(l) for _p, c, l in seen), [x for x in seen if x[1] != 302 or evil(x[2])][:4])
r = C.post("/admin/release", data={"csrf_token": "tok", "next": "/admin/subjects?q=a"})
s.check("a normal next is kept", r.headers.get("Location") == "/admin/subjects?q=a", r.headers.get("Location"))

s.section("end to end: the demo switch (needs a demo login; the persona list is stubbed)")
_real_personas = a.demo_personas
a.demo_personas = lambda actor=None: [{"demo_persona": "x", "id": EMP["id"]}]
try:
    D = _Safe(H.client_as(a, EMP["id"]))
    seen = []
    for p in PAY:
        r = D.post("/demo/switch", data={"csrf_token": "tok", "persona": "self", "next": p})
        seen.append((p, r.status_code, r.headers.get("Location")))
    s.check("every hostile next answers 302 to a path on this site",
            all(c == 302 and not evil(l) for _p, c, l in seen), [x for x in seen if x[1] != 302 or evil(x[2])][:4])
    r = D.post("/demo/switch", data={"csrf_token": "tok", "persona": "self", "next": "/review/journey"})
    s.check("a normal next is kept", r.headers.get("Location") == "/review/journey", (r.status_code, r.headers.get("Location")))
finally:
    a.demo_personas = _real_personas

s.section("end to end: the super admin band gate's Referer (a lock with no remark)")
seen = []
for ref in refs + ["http://" + EV + "/x"]:
    r = C.post("/calibration/bg/lock", data={"csrf_token": "tok"}, headers={"Referer": ref})
    seen.append((ref, r.status_code, r.headers.get("Location")))
s.check("the route redirected (the gate was reached)", all(c in (301, 302) for _r, c, _l in seen), seen[:3])
s.check("no Location leaves the site", all(not evil(l) for _r, _c, l in seen), [x for x in seen if evil(x[2])][:4])
r = C.post("/calibration/bg/lock", data={"csrf_token": "tok"}, headers={"Referer": "http://localhost/admin/calibration/locks?q=1"})
s.check("a real Referer still comes back to its page",
        r.status_code in (301, 302) and r.headers.get("Location") == "/admin/calibration/locks?q=1", r.headers.get("Location"))

s.section("the system-admin refusal and the closed-window refusal use the same helper")
for ref in refs:
    with a.app.test_request_context("/x", method="POST", headers={"Referer": ref}):
        resp = a._system_admin_locked_handler(a.SystemAdminLocked("no"))
        s.check("system-admin refusal, Referer %r: stays on the site" % ref, not evil(resp.headers.get("Location")),
                resp.headers.get("Location"))
with a.app.test_request_context("/x", method="POST", headers={"Referer": "http://localhost/admin/admins?panel=adm-3"}):
    s.check("...and a real Referer comes back to its page",
            a._system_admin_locked_handler(a.SystemAdminLocked("no")).headers.get("Location") == "/admin/admins?panel=adm-3")
SRC = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app.py"), encoding="utf-8").read()
s.check("no redirect in app.py still builds its target from request.referrer or startswith('/')",
        "redirect(back if back.startswith(request.host_url)" not in SRC
        and 'nxt.startswith("/") and not nxt.startswith("//")' not in SRC
        and "back.path + (" not in SRC)

s.section("the two classic override routes' `back` field")
subj = H.one(a, "SELECT id FROM users WHERE role!='admin' AND left_at IS NULL ORDER BY id LIMIT 1")
for route in ("/performance/calibration/override", "/performance/calibration/override/clear"):
    seen = []
    for p in PAY[:12]:
        r = C.post(route, data={"csrf_token": "tok", "back": p, "subject_id": subj, "remark": "a justification for this test"})
        seen.append((p, r.status_code, r.headers.get("Location")))
    s.check("%s: no hostile back leaves the site" % route, all(not evil(l) for _p, _c, l in seen),
            [x for x in seen if evil(x[2])][:3])
    r = C.post(route, data={"csrf_token": "tok", "back": "/performance/calibration?x=1", "subject_id": subj,
                            "remark": "a justification for this test"})
    s.check("%s: a normal back is used (the field is what the route reads)" % route,
            r.headers.get("Location") == "/performance/calibration?x=1", r.headers.get("Location"))
    s.check("%s: the route redirected at least once (reached)" % route, any(c in (301, 302) for _p, c, _l in seen),
            [(c, l) for _p, c, l in seen][:3])

sys.exit(s.done())
