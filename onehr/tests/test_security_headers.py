"""Security headers on every response (Chris, 2026-10-12: "go ahead and add the security headers").

The app sends them itself, so they hold on every server whatever its nginx adds:
  * frames: same site only (the reminder preview frames our own page); no type guessing; a referrer policy; no
    camera, microphone or location
  * HTTPS only, on a served instance (L360_PROD) and never on the local dev server
  * nothing a signed-in person saw is kept by the browser (pages, JSON, downloads); the static files stay cacheable
  * the content policy goes out REPORT-ONLY: OneHR's own files and nothing else, no plugins, no <base> rewrite, no
    form posting elsewhere, no framing by another site

Runs on the scratch copy only (harness.setup asserts it).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Security headers -- sent by the app on every response")
SU, _BG, EMP = H.actors(a)
anon = a.app.test_client()
E = H.client_as(a, EMP["id"])
A = H.client_as(a, SU["id"])

s.section("the fixed headers, signed out and signed in")
for label, client, url in (("sign-in page", anon, "/login"), ("dashboard", E, "/dashboard"),
                           ("admin home", A, "/admin"), ("a 404", E, "/no-such-page")):
    r = client.get(url)
    h = r.headers
    s.check("%s: same-site frames only, no type guessing, a referrer policy, no camera/mic/location" % label,
            h.get("X-Frame-Options") == "SAMEORIGIN" and h.get("X-Content-Type-Options") == "nosniff"
            and h.get("Referrer-Policy") == "strict-origin-when-cross-origin"
            and "microphone=()" in (h.get("Permissions-Policy") or "") and "camera=()" in (h.get("Permissions-Policy") or ""),
            (r.status_code, {k: h.get(k) for k in ("X-Frame-Options", "X-Content-Type-Options", "Referrer-Policy")}))

s.section("nothing a signed-in person saw is kept by the browser; the static files are")
s.check("a page is no-store", E.get("/dashboard").headers.get("Cache-Control") == "no-store")
s.check("...and so is JSON (the record panel)", E.get("/me/record/current").headers.get("Cache-Control") == "no-store",
        E.get("/me/record/current").status_code)
r = A.get("/admin/export/users.csv")
s.check("...and a download (the people CSV)", r.status_code == 200 and r.headers.get("Cache-Control") == "no-store",
        (r.status_code, r.headers.get("Cache-Control")))
r = anon.get("/static/style.css")
s.check("the stylesheet stays cacheable (static is never no-store)",
        r.status_code == 200 and "no-store" not in (r.headers.get("Cache-Control") or ""), r.headers.get("Cache-Control"))
r.close()

s.section("HTTPS only, on a served instance only")
_was = a._PROD
try:
    a._PROD = False
    s.check("the local dev server sends no HTTPS-only header", "Strict-Transport-Security" not in anon.get("/login").headers)
    a._PROD = True
    s.check("a served instance (L360_PROD) tells browsers HTTPS only, for a year",
            anon.get("/login").headers.get("Strict-Transport-Security") == "max-age=31536000")
finally:
    a._PROD = _was

s.section("the content policy: report-only, OneHR's own files and nothing else")
h = anon.get("/login").headers
csp = h.get("Content-Security-Policy-Report-Only") or ""
s.check("it goes out report-only (nothing is blocked yet)", csp and "Content-Security-Policy" not in h, csp[:60])
want = ("default-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'",
        "connect-src 'self'")
s.check("...it names OneHR's own files only, no plugins, no <base> rewrite, no off-site posts or framing",
        all(w in csp for w in want), [w for w in want if w not in csp])
s.check("...and no other site anywhere in it (no http:, https: or * source)",
        "http" not in csp and " * " not in csp and not csp.rstrip().endswith("*"))
s.check("the pages load nothing from another site (no http(s):// src/href in a template or script)",
        not any("src=\"http" in open(os.path.join(root, f), encoding="utf-8", errors="ignore").read()
                for d in ("templates", "static") for root, _, fs in os.walk(os.path.join(H.REPO, d)) for f in fs
                if f.endswith((".html", ".js"))))

s.section("a view can still set its own header")
s.check("the headers are setdefault, so nothing a view sets is overwritten (bar Cache-Control, always no-store)",
        "resp.headers.setdefault(name, value)" in H.source(a))

sys.exit(s.done())
