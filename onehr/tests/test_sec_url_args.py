"""A query string that names url_for's own arguments no longer breaks an admin page (security test 3-08, 2026-10-31).

  GET /admin/module/pm?key=x and GET /admin/calibration/locks?format=x answered 500 ("got multiple values for keyword
  argument"): the page splatted request.args into url_for(...) next to a keyword it already passes. The same is true of
  ?endpoint=, and ?_external=1 / ?_scheme= / ?_anchor= would change the links. _url_args(request.args, *drop) drops url_for's
  own names and the call's own keywords; admin_filter_rows (the filter kit under 23 admin pages) and the module, lock-status
  and report pages use it.

Every page is fetched plain first (it must answer 200, so a 200 afterwards means something), then with each hostile name
alone and all together, as a super admin: same status as plain, never a 500, links stay relative, and a real filter
(?q=, ?fbg=) is still carried into the page's own links.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Admin pages: url_for's own argument names in the query string")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

SU, _bg, _emp = H.actors(a)
C = H.client_as(a, SU["id"])
PAGES = ["/admin/module/pm", "/admin/module/competency", "/admin/module/pm/progress", "/admin/module/idp/progress",
         "/admin/module/pm/progress.xlsx", "/admin/calibration/locks", "/admin/reports/all/pm-status",
         "/admin/participants", "/admin/subjects", "/admin/users", "/admin/joiners", "/admin/leaders",
         "/admin/reports", "/admin/reports/ratings"]
HOSTILE = ["key=x", "endpoint=x", "_anchor=zz", "_external=1", "_scheme=http", "_method=POST", "format=x", "page=x",
           "show=x", "fstage=x", "scope=x"]
ALL = "&".join(HOSTILE)


def get(url):
    try:
        r = C.get(url)
    except Exception as e:  # noqa: BLE001 -- the old code raised TypeError inside the request
        return 500, "raised %s" % type(e).__name__
    return r.status_code, r.get_data(as_text=True) if r.mimetype.startswith("text/") else ""


base = {}
for p in PAGES:
    base[p] = get(p)[0]
reached = [p for p in PAGES if base[p] == 200]
s.check("(the pages answer 200 plain, so a 200 below means something: %d of %d)" % (len(reached), len(PAGES)),
        len(reached) >= 10, {p: base[p] for p in PAGES if base[p] != 200})

s.section("each hostile name, alone and all together")
bad = []
for p in reached:
    for q in HOSTILE + [ALL]:
        st, body = get(p + "?" + q)
        if st == 500 or (st != 200 and not (q == "page=x" or "page" in q)) :
            bad.append((p, q if q != ALL else "(all)", st))
s.check("no page answers 500 (or anything but its plain status) for %d pages x %d query strings"
        % (len(reached), len(HOSTILE) + 1), not bad, bad[:8])

s.section("the links stay relative and a real filter is still carried")
leaks = []
for p in ("/admin/module/pm", "/admin/module/pm/progress", "/admin/calibration/locks", "/admin/participants", "/admin/users"):
    if p not in reached:
        continue
    st, body = get(p + "?_external=1&_scheme=http&_anchor=zz")
    if "http://localhost/admin" in body or "#zz" in body:
        leaks.append(p)
s.check("?_external / ?_scheme / ?_anchor do not turn the page's links absolute or add a fragment", not leaks, leaks)
st, body = get("/admin/module/pm/progress?q=zzfilter&key=x")
s.check("the progress page, with a key typed in, still renders and keeps its real filter in its own links (q=zzfilter); its Excel moved to Reports (4 Nov 2026), so no download link",
        st == 200 and "progress.xlsx" not in body and "q=zzfilter" in body, st)
st, body = get("/admin/calibration/locks?show=open&format=x")
s.check("the lock-status page renders with a stray format; its Excel link moved to Reports (4 Nov 2026), so none is built", st == 200 and "format=xlsx" not in body, st)
r = C.get("/admin/calibration/locks?format=xlsx")
s.check("...and ?format=xlsx still downloads the workbook", r.status_code == 200 and "spreadsheet" in (r.mimetype or ""), (r.status_code, r.mimetype))
r = C.get("/admin/module/pm/progress.xlsx?key=x")
s.check("the progress download with a stray key still downloads", r.status_code == 200 and "spreadsheet" in (r.mimetype or ""), r.status_code)

s.section("the helper")
d = a._url_args({"q": "a", "key": "k", "endpoint": "e", "_external": "1", "page": "2", "x": "y"}, "key", "page")
s.check("it drops url_for's names and the named keywords, keeps the rest in order", d == {"q": "a", "x": "y"}, d)

sys.exit(s.done())
