"""Search in on every admin list of people (Chris, 2026-10-26).

He showed People > Users' choice beside its search (All fields, Name, Employee ID, Job title, Job grade, Email) and a
Progress page's "Name, employee ID, unit, department, title | Search | 44 people" with none. Every admin list of
people now has the same choice, backed by one registry (people_search_in), one SQL clause (_people_search_sql) and its
mirror for the lists built in Python (people_search_match); a list whose search also looked in unit or department
keeps them, as options and in All fields.

What this pins:
- the lint: every list search in a template (an <input type="search" name="q">) is the shared macro, or says why not
  (data-no-qin); every route drawing the macro reads the search through people_search_args; no admin function
  hand-rolls a name search outside the pickers listed here;
- on each list (People, its bulk views, every module's Progress, 360 People, 360 raters, Participants): the menu, each
  field searching its own column only, All fields searching every one, a job grade matched whole, a % taken literally,
  the choice kept by the page's other forms;
- the downloads (Progress, 360 panels, raters) and the bulk views' "every one that matches" take the same field.

Its own synthetic people, each with a token in exactly one field, on the shared suite database; put back at the end.
"""
import html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Search in -- every admin list of people")
BG, CO, CO2 = "ZZSI Group", "ZZSI Unit Sdn Bhd", "ZZSI Qunz Sdn Bhd"
TPL = os.path.join(H.REPO, "templates")

# the functions that may search people by name without Search in: pickers, which choose one person, and the audit log,
# whose rows are actions. A new list of people searches through _people_search_sql / people_search_match instead.
PICKERS = {
    "_audit_log_where": "the audit log's search: actions by an admin or about a person, not a list of people",
    "admin_assessor_search": "a person's panel: finds a rater to add",
    "admin_leaders_people": "Leaders: finds a person for a seat",
    "admin_people_find": "the .pick finder every admin form uses",
    "admin_reminders_people": "Email: finds who a test goes to",
}
HELPERS = {"_people_search_sql", "people_search_match", "people_search_in"}


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZSI-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZSI-%'")
    db.commit()


s.section("the lint")
src = H.source(a)


def _bodies(text):
    """{top-level function name: its source}, each ending at the next line in column 0."""
    out, lines = {}, text.split("\n")
    for i, ln in enumerate(lines):
        m = re.match(r"def (\w+)\(", ln)
        if not m:
            continue
        j = i + 1
        while j < len(lines) and not (lines[j][:1] not in ("", " ", "\t", ")", "#") and lines[j].strip()):
            j += 1
        out[m.group(1)] = "\n".join(lines[i:j])
    return out


bodies = _bodies(src)
hand = sorted(n for n, b in bodies.items()
              if re.search(r"full_name\)?\s+LIKE", b, re.I) or re.search(r'\(\s*"full_name",\s*"employee_id"', b))
s.check("no function searches people by hand outside the pickers (search through _people_search_sql or "
        "people_search_match, with the Search in choice)", set(hand) - set(PICKERS) - HELPERS == set(),
        sorted(set(hand) - set(PICKERS) - HELPERS))
s.check("...and every picker listed still exists (a stale list proves nothing)", set(PICKERS) <= set(bodies),
        sorted(set(PICKERS) - set(bodies)))

loose, macro_tpls = [], []
for root, _dirs, files in os.walk(TPL):
    for fn in files:
        if not fn.endswith(".html"):
            continue
        path = os.path.join(root, fn)
        rel = os.path.relpath(path, TPL)
        text = open(path, encoding="utf-8").read()
        if "search_in_box(" in text and rel != "_search_in.html":
            macro_tpls.append(rel)
        if rel == "_search_in.html":
            continue
        for m in re.finditer(r"<input\b[^>]*>", text, re.S):
            tag = m.group(0)
            if re.search(r'\bname="q"', tag) and 'type="search"' in tag and "data-no-qin=" not in tag:
                loose.append("%s:%d" % (rel, text[:m.start()].count("\n") + 1))
s.check("every list search in a template is search_in_box() or says why not (data-no-qin)", loose == [], loose)
want_tpls = {"admin_users.html", "admin_users_bulk.html", "admin_module_progress.html", "admin_subjects.html",
             "admin_assessors.html", "admin_participants.html"}
s.check("...the six lists of people draw it", want_tpls <= set(macro_tpls), sorted(want_tpls - set(macro_tpls)))
no_args = []
for t in macro_tpls:
    # a settings card (templates/settings/cards/) is included by admin_module_settings.html, which that route renders (2026-11-02:
    # the Filters card's Calibrators and Group Chiefs tabs draw the macro)
    host = "admin_module_settings.html" if t.startswith("settings/cards/") else t
    # the LM of N team panel (2026-11-09) is drawn by admin_list_view through lst["template"]; its builder _lm_team_list reads the search
    if t == "_lm_team_panel.html":
        host = "_people_list_panel.html"
    callers = [n for n, b in bodies.items() if '"%s"' % host in b and "render_template" in b]
    no_args += ["%s <- %s" % (t, n) for n in callers if "people_search_args(" not in bodies[n]]
    if not callers:
        no_args.append("%s <- nobody" % t)
s.check("...and each route drawing it reads the search through people_search_args", no_args == [], no_args)

with a.app.test_request_context("/"):
    db = a.get_db()
    _cleanup(db)
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, name, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CO, department="ZZSI Dept",
                 job_title="ZZSI Officer", left_at=None, is_demo=0, role="user", admin_bg=None, job_grade=14,
                 confirmation_date="2020-01-01", user_role_id=None)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
    # one token per field: QNMZ only in a name, QEIDZ only in an Employee ID, QTTZ only in a title, QMLZ only in an
    # email, QDPZ only in a department, QUNZ only in a unit; JG 21 and JG 12 once each, everyone else JG 14
    person("ZZSI-1", "ZZ SI Qnmz Person")
    person("ZZSI-QEIDZ", "ZZ SI Second")
    person("ZZSI-3", "ZZ SI Third", job_title="Qttz Engineer")
    person("ZZSI-4", "ZZ SI Fourth", email="zz.qmlz@example.invalid")
    person("ZZSI-5", "ZZ SI Fifth", department="Qdpz Works")
    person("ZZSI-6", "ZZ SI Sixth", company=CO2)
    person("ZZSI-G21", "ZZ SI Grade Twentyone", job_grade=21)
    person("ZZSI-G12", "ZZ SI Grade Twelve", job_grade=12)
    for co in (CO, CO2):
        db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, co))
    CYC = db.execute("SELECT id FROM cycles WHERE is_active=1").fetchone()
    ours = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZSI-%' ORDER BY employee_id")]
    if CYC:   # a ring of raters, so each is rated (360 People, panels) and rates (raters)
        for i, uid in enumerate(ours):
            db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship) VALUES (?,?,?,?)",
                       (CYC[0], ours[(i + 1) % len(ours)], uid, "peer"))
    db.commit()
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]
    ALL = sorted(r[0] for r in db.execute("SELECT employee_id FROM users WHERE employee_id LIKE 'ZZSI-%'"))
    MENU_U = a.people_search_in(a.USERS_SEARCH_EXTRA)
    MENU_P = a.people_search_in(a.PROGRESS_SEARCH_EXTRA)

FIELDS = {"name": ("Qnmz", "full_name"), "eid": ("QEIDZ", "employee_id"), "title": ("Qttz", "job_title"),
          "email": ("qmlz", "email"), "dept": ("Qdpz", "department"), "unit": ("Qunz", "company")}
s.check("the suite has an active cycle to list people in", CYC is not None)


def ids_of(text):
    return sorted(set(re.findall(r"\bZZSI-[A-Z0-9]+\b", text)))


def expect(token, col):
    """An independent read: our people whose <col> holds the token (case-insensitive)."""
    return sorted(r[0] for r in H.rows(a, "SELECT employee_id FROM users WHERE employee_id LIKE 'ZZSI-%%' AND "
                                          "lower(COALESCE(%s,'')) LIKE ?" % col, ("%" + token.lower() + "%",)))


sup = H.client_as(a, SUP)


def found(path, q, qin=None, extra=""):
    url = path + ("&" if "?" in path else "?") + "q=%s" % q + ("&qin=%s" % qin if qin is not None else "") + extra
    r = sup.get(url)
    body = html.unescape(r.get_data(as_text=True))
    return r.status_code, ids_of(body), body


PAGES = [("People", "/admin/users?show=active", "fbg", MENU_U),
         ("Mark several as left", "/admin/users?view=inactivate", "fbg", MENU_U),
         ("Give a user role", "/admin/users?view=urole", "fbg", MENU_U)]
PAGES += [("%s progress" % m["label"], "/admin/module/%s/progress" % m["key"], "fbg", MENU_P) for m in a.MODULE_VIEWS]
PAGES += [("360 People", "/admin/subjects?scope=all", "fbg", MENU_P),
          ("360 raters", "/admin/assessors?scope=all", "fbg", MENU_U),
          ("Participants", "/admin/participants?show=all", "bg", MENU_U)]

try:
    for label, path, bgp, menu in PAGES:
        s.section(label)
        code, got, b = found(path, "ZZSI-", "eid")
        sel = re.search(r'<select name="qin"[^>]*>(.*?)</select>', b, re.S)
        opts = re.findall(r'<option value="([^"]*)"[^>]*>([^<]*)</option>', sel.group(1)) if sel else []
        s.check("the Search in choice, in the search form before the box: %s" % ", ".join(f[0] for f in menu.values()),
                code == 200 and [o[0] for o in opts] == list(menu) and [o[1] for o in opts] == [f[0] for f in
                                                                                                    menu.values()]
                and re.search(r'class="adm-fsearch[^"]*">(?:(?!</form>).)*<select name="qin"(?:(?!</form>).)*'
                              r'<input type="search" name="q"', b, re.S) is not None, (code, opts))
        s.check("one rounded field (icon, the chip, divider, box, Enter hint, clear) with a hidden submit; no visible Search button "
                "(Enter submits)", all(x in b for x in ('class="sib"', 'class="sib-ico"', 'class="sib-div"', 'class="sib-enter"', 'data-sib-clear',
                                                        'class="sr-only" tabindex="-1">Search</button>'))
                and not re.search(r'<button[^>]*class="(?:btn-link|btn|lm-btn)"[^>]*>\s*Search\s*</button>', b)
                and 'name="q" class="sib-in"' in b and "oninput" not in b.split('class="sib-in"', 1)[1].split(">", 1)[0], path)
        s.check("...it lists every one of ours (the base the checks below read)", got == ALL, got)
        keys = [k for k in menu if k in FIELDS]
        for k in keys:
            token, col = FIELDS[k]
            code, got, b = found(path, token, k)
            want = expect(token, col)
            s.check("%s finds the one with it in their %s" % (menu[k][0], col), code == 200 and want and got == want,
                    (got, want))
            miss = {FIELDS[o][0]: found(path, FIELDS[o][0], k)[1] for o in keys if o != k}
            s.check("...and none of the other fields' tokens", all(v == [] for v in miss.values()), miss)
            s.check("...the choice stays picked and the box says what it searches",
                    re.search(r'<option value="%s"[^>]*selected' % k, b) is not None
                    and 'placeholder="%s"' % menu[k][1] in b)
        every = {k: found(path, FIELDS[k][0], "all")[1] for k in keys}
        s.check("All fields finds every field's token", every == {k: expect(*FIELDS[k]) for k in keys}, every)
        left = [k for k in ("unit", "dept") if k not in menu]
        s.check("...and none it never searched (%s)" % (", ".join(left) or "none left out"),
                all(found(path, FIELDS[k][0], "all")[1] == [] for k in left))
        s.check("no choice, or an unknown one, is All fields",
                found(path, "Qttz")[1] == found(path, "Qttz", "password")[1] == expect("Qttz", "job_title"))
        fb = "&%s=%s" % (bgp, BG.replace(" ", "+"))
        s.check("a job grade matches whole: 21 finds JG 21 only, '1' none, 'JG 21' reads as 21",
                found(path, "21", "grade", fb)[1] == ["ZZSI-G21"] and found(path, "1", "grade", fb)[1] == []
                and found(path, "JG%2021", "grade", fb)[1] == ["ZZSI-G21"],
                (found(path, "21", "grade", fb)[1], found(path, "1", "grade", fb)[1]))
        s.check("...All fields matches a grade whole too", "ZZSI-G21" in found(path, "21", "all", fb)[1]
                and "ZZSI-G12" not in found(path, "21", "all", fb)[1])
        s.check("a % is a percent sign, not 'anything'", found(path, "%25", "name", fb)[1] == [])
        code, got, b = found(path, "Qttz", "title")
        kept = re.findall(r'href="([^"]*)"', b)
        kept = [h for h in kept if "q=Qttz" in h]
        s.check("the page's links carrying the search carry the field too", kept and all("qin=title" in h for h in kept),
                [h for h in kept if "qin=title" not in h][:3])
        posts = re.findall(r'<form method="post"(?:(?!</form>).)*?name="q" value="Qttz"(?:(?!</form>).)*</form>', b,
                           re.S)
        s.check("...and its forms posting the search", all('name="qin" value="title"' in f for f in posts),
                len(posts))

    s.section("the downloads take the same field")

    def downloaded(url):
        r = sup.get(url)
        return r.status_code, ids_of(H.as_csv_text(r))
    for key in [m["key"] for m in a.MODULE_VIEWS]:
        b = found("/admin/module/%s/progress" % key, "Qttz", "title")[2]
        s.check("%s progress: no download link on the page now (its Excel moved to Reports, 4 Nov 2026)" % key,
                "progress.xlsx" not in b)
        s.check("...the address still holds the people the list shows", downloaded("/admin/module/%s/progress.xlsx?q=Qttz&qin=title" % key)[1]
                == expect("Qttz", "job_title"))
        s.check("...a field picked leaves the other fields out",
                downloaded("/admin/module/%s/progress.xlsx?q=Qttz&qin=name" % key)[1] == [])
    b = found("/admin/subjects?scope=all", "Qttz", "title")[2]
    s.check("360 People has no Download panels form now (it moved to Reports, 4 Nov 2026)", "export/panels" not in b)
    code, got = downloaded("/admin/export/panels.xlsx?q=Qttz&qin=title")
    s.check("...its file holds the one rated with that title (and their rater)", code == 200 and "ZZSI-3" in got
            and set(got) <= set(ALL) and len(got) == 2, got)
    s.check("...and a field picked leaves the other fields out",
            downloaded("/admin/export/panels.xlsx?q=Qttz&qin=name")[1] == [])
    b = found("/admin/assessors?scope=all", "Qttz", "title")[2]
    s.check("360 raters has no Download form now (it moved to Reports, 4 Nov 2026)", "assessor-progress" not in b)
    s.check("...its file holds the rater with that title only",
            downloaded("/admin/export/assessor-progress.xlsx?q=Qttz&qin=title&scope=all")[1] == ["ZZSI-3"])
    s.check("...and a field picked leaves the other fields out",
            downloaded("/admin/export/assessor-progress.xlsx?q=Qttz&qin=name&scope=all")[1] == [])

    s.section("the bulk views' every-one-that-matches takes the field")

    def give_all(q, qin):
        r = sup.post("/admin/users", data={"csrf_token": "tok", "action": "bulk_user_role", "select_all": "1",
                                           "user_role_id": "auto", "q": q, "qin": qin, "fbg": BG})
        with sup.session_transaction() as ss:
            msgs = [m for _c, m in ss.get("_flashes", [])]
            ss.pop("_flashes", None)
        return r, msgs
    r, msgs = give_all("Qnmz", "name")
    s.check("Give a user role to every match, Name: the one named", r.status_code == 302
            and any(m.startswith("0 people now on Automatic (1 already were)") for m in msgs), msgs)
    s.check("...and back on the same field", "qin=name" in r.headers.get("Location", ""), r.headers.get("Location"))
    r, msgs = give_all("Qnmz", "email")
    s.check("...the same words in Email: nobody", any(m.startswith("0 people now on Automatic.") for m in msgs), msgs)
finally:
    with a.app.test_request_context("/"):
        _cleanup(a.get_db())
sys.exit(s.done())
