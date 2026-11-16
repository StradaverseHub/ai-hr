"""People > Users' "Search in" (Chris, 2026-10-20):

  "for the search, can we add a drop down to allow admin to select to search from name/employee id/ title/ email"

What this pins: the choice beside the search box (All fields first and the default, then Name, Employee ID, Job title,
Job grade, Email, and Department since 2026-10-26, when every admin list of people got the choice and kept its own
unit / department: test_search_in); each field searches that column only, while All fields searches as before
(department included); an unknown choice falls back to All fields; the choice is kept by the page's other forms; the
box's placeholder follows it.

Its own synthetic people on the shared suite database, each with a token in exactly one field, so a hit in the wrong
column shows. Everything is put back at the end.
"""
import html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("People search -- search in one field, or all of them")
BG, CO = "ZZPS Group", "ZZPS Unit Sdn Bhd"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZPS-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZPS-%'")
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    _cleanup(db)
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, name, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CO, department="ZZPS Dept",
                 job_title="ZZPS Officer", left_at=None, is_demo=0, role="user", admin_bg=None, job_grade=14,
                 confirmation_date="2020-01-01")
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
    # one token per field: QNAME only in a name, QEID only in an Employee ID, QTTL only in a title, QML only in an
    # email, QDEP only in a department (which only All fields searches)
    person("ZZPS-1", "ZZ PS Qname Person")
    person("ZZPS-QEID", "ZZ PS Second")
    person("ZZPS-3", "ZZ PS Third", job_title="Qttl Engineer")
    person("ZZPS-4", "ZZ PS Fourth", email="zz.qml@example.invalid")
    person("ZZPS-5", "ZZ PS Fifth", department="Qdep Works")
    person("ZZPS-G21", "ZZ PS Grade Twentyone", job_grade=21)       # the only JG 21 of ours
    person("ZZPS-G12", "ZZ PS Grade Twelve", job_grade=12)
    person("ZZPS-NC", "ZZ PS Not Confirmed", confirmation_date=None, years_of_service=5)
    db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
    db.commit()
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]


def found(cl, q, qin=None, extra=""):
    """The ZZPS Employee IDs the People list shows for this search (`extra`: more of the query string)."""
    url = "/admin/users?q=%s" % q + ("&qin=%s" % qin if qin is not None else "") + extra
    r = cl.get(url)
    body = html.unescape(r.get_data(as_text=True))
    return r.status_code, sorted(set(re.findall(r"\bZZPS-[A-Z0-9]+\b", body))), body


def expect(token, col):
    """An independent read: the ZZPS people whose <col> holds the token (case-insensitive)."""
    return sorted(r[0] for r in H.rows(a, "SELECT employee_id FROM users WHERE employee_id LIKE 'ZZPS-%%' AND "
                                          "lower(COALESCE(%s,'')) LIKE ?" % col, ("%" + token.lower() + "%",)))


sup = H.client_as(a, SUP)
try:
    s.section("the choice beside the search box")
    code, ids, b = found(sup, "")
    sel = re.search(r'<select name="qin"[^>]*>(.*?)</select>', b, re.S)
    opts = re.findall(r'<option value="([^"]*)"[^>]*>([^<]*)</option>', sel.group(1)) if sel else []
    s.check("People shows a Search in choice: All fields, Name, Employee ID, Job title, Job grade, Email, Department",
            code == 200 and [o[1] for o in opts] == ["All fields", "Name", "Employee ID", "Job title", "Job grade",
                                                     "Email", "Department"], opts)
    s.check("...All fields is the one picked by default", sel and re.search(
        r'<option value="all"[^>]*selected', sel.group(1)) is not None)
    s.check("...it sits in the search form, before the box", re.search(
        r'<form method="get" class="adm-fsearch">.*?<select name="qin".*?<input type="search" name="q"', b, re.S)
        is not None)

    s.section("each field searches that column only")
    for token, qin, col in (("Qname", "name", "full_name"), ("QEID", "eid", "employee_id"),
                            ("Qttl", "title", "job_title"), ("qml", "email", "email")):
        code, ids, b = found(sup, token, qin)
        want = expect(token, col)
        s.check("%s finds the person with it in their %s" % (qin, col), code == 200 and want and ids == want,
                (ids, want))
        others = [q2 for q2, c2 in (("Qname", "name"), ("QEID", "eid"), ("Qttl", "title"), ("qml", "email"))
                  if c2 != qin]
        miss = {q2: found(sup, q2, qin)[1] for q2 in others}
        s.check("...and none of the other fields' tokens (%s)" % ", ".join(others),
                all(v == [] for v in miss.values()), miss)
        s.check("...the choice stays picked and the box says what it searches",
                re.search(r'<option value="%s"[^>]*selected' % qin, b) is not None
                and 'placeholder="%s"' % a.people_search_in(a.USERS_SEARCH_EXTRA)[qin][1] in b)

    s.section("All fields is the search as it was")
    code, ids, b = found(sup, "Qdep", "all")
    s.check("All fields still finds a department", ids == expect("Qdep", "department") != [], ids)
    every = [found(sup, t, "all")[1] for t in ("Qname", "QEID", "Qttl", "qml")]
    s.check("...and every field's token", every == [expect("Qname", "full_name"), expect("QEID", "employee_id"),
                                                     expect("Qttl", "job_title"), expect("qml", "email")], every)
    s.check("no choice sent = All fields", found(sup, "Qdep")[1] == ids)
    s.check("an unknown choice falls back to All fields", found(sup, "Qdep", "password")[1] == ids)
    s.check("a field picked, a department token finds nobody (All fields and Department search departments)",
            all(found(sup, "Qdep", k)[1] == [] for k in ("name", "eid", "title", "email")))
    s.check("...Department finds it", found(sup, "Qdep", "dept")[1] == ids != [], found(sup, "Qdep", "dept")[1])

    s.section("Job grade matches whole (Chris, 2026-10-21: \"the drop down list to filter here should include job grade\")")
    # narrowed to our own group: a full copy has a page or more of real JG 21 people before ours
    FB = "&fbg=" + BG.replace(" ", "+")
    s.check("21 finds JG 21, never JG 12 or a 1 in an ID", found(sup, "21", "grade", FB)[1] == ["ZZPS-G21"],
            found(sup, "21", "grade", FB)[1])
    s.check("...'JG 21' reads as 21", found(sup, "JG%2021", "grade", FB)[1] == ["ZZPS-G21"])
    s.check("...'1' finds no grade (a whole grade only)", found(sup, "1", "grade", FB)[1] == [])
    s.check("All fields finds a grade too", "ZZPS-G21" in found(sup, "21", "all", FB)[1]
            and "ZZPS-G12" not in found(sup, "21", "all", FB)[1])
    s.check("the download takes the same search", "ZZPS-G21" in H.as_csv_text(sup.get(
        "/admin/export/users.xlsx?q=21&qin=grade")) and "ZZPS-G12" not in H.as_csv_text(sup.get(
        "/admin/export/users.xlsx?q=21&qin=grade")))

    s.section("Not confirmed is no confirmation date (years of service stopped counting, 2026-10-20)")
    r_ = sup.get("/admin/users?show=unconfirmed&q=ZZPS")
    b_ = html.unescape(r_.get_data(as_text=True))
    s.check("someone with five years' service and no date is listed; someone dated isn't",
            "ZZPS-NC" in b_ and "ZZPS-G21" not in b_, sorted(set(re.findall(r"\bZZPS-[A-Z0-9]+\b", b_))))

    s.section("the choice is kept")
    code, ids, b = found(sup, "Qttl", "title")
    s.check("the page's other forms carry it", '<input type="hidden" name="qin" value="title">' in b)
    s.check("...and the search form doesn't carry it twice",
            not re.search(r'<form method="get" class="adm-fsearch">(?:(?!</form>).)*type="hidden" name="qin"', b,
                          re.S))
    pills = re.findall(r'<a class="adm-frow-pill[^"]*" href="([^"]*)"', b)
    s.check("...and the filter rows' links (business group, role)", pills and all("qin=title" in h for h in pills),
            pills[:3])

    s.section("the users download takes the same search (its button moved to Reports, 4 Nov 2026: the address is what is tested)")
    s.check("the Users page has no download link now", not re.search(r'href="[^"]*admin/export/users', b))

    class _Exp:   # the address the page used to link to: the search, its field, and Show
        @staticmethod
        def group(_n):
            return "/admin/export/users.xlsx?q=Qttl&qin=title&show=active"
    exp = _Exp()

    def downloaded(url):
        r = sup.get(url)
        return r.status_code, sorted(set(re.findall(r"\bZZPS-[A-Z0-9]+\b", H.as_csv_text(r))))
    code, got = downloaded(exp.group(1)) if exp else (0, [])
    s.check("...and holds the people the list shows", code == 200 and got == expect("Qttl", "job_title"), got)
    s.check("a field's download leaves out the other fields' tokens",
            downloaded("/admin/export/users.xlsx?q=Qttl&qin=name&show=all")[1] == [])
    s.check("All fields' download finds a job title and an email too, as the list does (it used to look in name, "
            "Employee ID and department only)",
            [downloaded("/admin/export/users.xlsx?q=%s&show=all" % t_)[1] for t_ in ("Qttl", "qml", "Qdep")]
            == [expect("Qttl", "job_title"), expect("qml", "email"), expect("Qdep", "department")])
finally:
    with a.app.test_request_context("/"):
        _cleanup(a.get_db())
sys.exit(s.done())
