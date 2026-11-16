"""Profile (was Settings) and proper names on screen (Chris, 2026-10-22: "when go into the setting page, can we have a
profile card to show the person name, ID, job title, job grade, BG, BU, department, email etc. ... rename Settings to
Profile. And for the BG BU job title with all cap, can we use proper name?"; option A of the canvas "OneHR Profile
Page", [design canvas link removed]; then "remove employement type and work location, for the
rest of the fields, ensure our admin portal has all the data for our users"; "everywhere on screen"; and "ensure it is
linked ... next time admin updates the preferred name of a company ... it will reflect on everywhere including the user
profile, and all the pages in admin carrying it").

What this suite holds:
  * proper_name(): capitals-only text in proper case, short forms kept, mixed case untouched; static/proper.js has
    the very same short forms, small words and numerals
  * the Profile page: /profile (and /settings, its old address), the work record's fields, "Not on record yet" for an
    empty one, Confirmed "Not yet", no employment type or work location; the Account menu says Profile
  * the group and unit are the preferred names from Org structure: a rename there shows on the Profile at once
  * the picture and password panels post to the Profile; a wrong password reopens the panel with the reason; the
    shared writer changes the password
  * the top bar: the job title in proper case, the whole line on hover
  * the admin side: the joined date on the person page's Details (preview, apply, refused when unreadable), and the
    "People with missing profile details" download in the roster import's columns, registered and access-mapped
  * every template that prints a person's job title or department sends it through `proper` (a lint)
  * Help has the "My work details are wrong" topic, and a door can open on it

Fresh database (fresh_db=True): one person's record, password and a unit's display name are changed and put back.
"""
import glob
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Profile and proper names on screen")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
NAV = {"Sec-Fetch-Mode": "navigate"}
SU, _BG, _EMP = H.actors(a)
JS = open(os.path.join(H.REPO, "static", "proper.js"), encoding="utf-8").read()
HELPJS = open(os.path.join(H.REPO, "static", "help.js"), encoding="utf-8").read()
PN = a.proper_name


def q(sql, args=()):
    with a.app.app_context():
        return a.get_db().execute(sql, args).fetchone()


def ex(sql, args=()):
    with a.app.app_context():
        db = a.get_db()
        db.execute(sql, args)
        db.commit()


s.section("1. proper_name()")
cases = {"SENIOR MANAGER, QAQC & M&E": "Senior Manager, QAQC & M&E",
         "BKG DEVELOPMENT SDN BHD": "BKG Development Sdn Bhd",
         "HEAD OF GROUP PROJECT MANAGEMENT OFFICE": "Head of Group Project Management Office",
         "SITE SUPERVISOR CUM SAFETY OFFICER": "Site Supervisor cum Safety Officer",
         "VINO AIR-CONDITIONING (M) SDN BHD": "Vino Air-Conditioning (M) Sdn Bhd",
         "PROJECT-AVANTRO (WP24)": "Project-Avantro (WP24)", "HR&ADMINISTRATION": "HR&Administration",
         "ASSISTANT GENERAL MANAGER II": "Assistant General Manager II", "THE SITE": "The Site",
         "CHIN HIN BUILDING MATERIAL (CHBM)": "Chin Hin Building Material (CHBM)"}
bad = {k: PN(k) for k, v in cases.items() if PN(k) != v}
s.check("capitals read in proper case, short forms and numbered words kept, small words small", not bad, bad)
s.check("mixed case, empty, None and figures come back as they were",
        PN("Assistant Manager, Sales") == "Assistant Manager, Sales" and PN("") == "" and PN(None) is None
        and PN("12") == "12" and PN(15) == 15)
s.check("the template filter is the same function", a.app.jinja_env.filters.get("proper") is a.proper_name)
m = re.search(r'var KEEP = \(""((?:\s*\+?\s*"[^"]*")+)\)', JS)
js_keep = set(" ".join(re.findall(r'"([^"]*)"', m.group(1))).split()) if m else set()
js_small = set((re.search(r'SMALL = "([^"]+)"', JS) or [None, ""])[1].split())
js_roman = set((re.search(r'ROMAN = "([^"]+)"', JS) or [None, ""])[1].split())
s.check("static/proper.js keeps the very same short forms, small words and numerals as app.py",
        js_keep == set(a.PROPER_KEEP_UPPER) and js_small == set(a.PROPER_SMALL) and js_roman == set(a.PROPER_ROMAN),
        (sorted(js_keep ^ set(a.PROPER_KEEP_UPPER)), sorted(js_small ^ set(a.PROPER_SMALL))))
s.check("...and every page loads it, before the page scripts",
        "filename='proper.js'" in open(os.path.join(H.REPO, "templates", "base.html"), encoding="utf-8").read())

s.section("2. The Profile page")
emp = q("SELECT * FROM users u WHERE role!='admin' AND left_at IS NULL AND business_group IS NOT NULL "
        "AND company IS NOT NULL AND TRIM(COALESCE(department,''))!='' AND TRIM(COALESCE(job_title,''))!='' "
        "AND manager_id IS NOT NULL AND EXISTS (SELECT 1 FROM users m WHERE m.id=u.manager_id AND m.left_at IS NULL) "
        "AND COALESCE(is_demo,0)=0 ORDER BY id LIMIT 1")
s.check("a person to test with (active, placed, with a line manager)", emp is not None)
E = H.client_as(a, emp["id"])
orig = {k: emp[k] for k in ("department", "email", "confirmation_date", "hod_id", "password_hash", "avatar")}
r = E.get("/profile", headers=NAV)
body = r.get_data(as_text=True)
s.check("/profile opens their Profile", r.status_code == 200 and "<h1>Profile</h1>" in body
        and "<title>Profile" in body, r.status_code)
s.check("...and /settings, its old address, still does", E.get("/settings", headers=NAV).status_code == 200)
with a.app.test_request_context("/"):
    prof_url = a.url_for("my_settings")
s.check("its address is /profile, and the Account menu names it Profile",
        prof_url == "/profile" and '<a href="/profile" role="menuitem">Profile</a>' in body)
labels = re.findall(r"<dt>([^<]+)</dt>", body)
s.check("the work record's fields, in order", labels == ["Employee ID", "Business group", "Business unit", "Department",
                                                         "Line manager", "HOD", "Work email", "Joined", "Confirmed"],
        labels)
s.check("...no employment type or work location (Chris: \"remove employement type and work location\")",
        "Employment type" not in body and "Work location" not in body)
s.check("the job title and department read in proper case",
        str(a.Markup.escape(PN(emp["job_title"]))) in body and str(a.Markup.escape(PN(emp["department"]))) in body)
mgr = q("SELECT full_name FROM users WHERE id=?", (emp["manager_id"],))[0]
s.check("...their line manager by name", "<dd>%s</dd>" % a.Markup.escape(PN(mgr)) in body)
s.check("...and a way to report a wrong detail, opening Help on its topic",
        'data-help-open="report" data-help-about="details"' in body)

ex("UPDATE users SET department=NULL, email=NULL, confirmation_date=NULL, hod_id=NULL WHERE id=?", (emp["id"],))
b2 = E.get("/profile", headers=NAV).get_data(as_text=True)
s.check("an empty field reads \"Not on record yet\", greyed (department, HOD, work email)",
        b2.count('<dd class="pf-none">Not on record yet</dd>') >= 3)
s.check("...and no confirmation date reads \"Not yet\"", '<dt>Confirmed</dt><dd class="pf-none">Not yet</dd>' in b2)
left = q("SELECT id FROM users WHERE left_at IS NOT NULL AND role!='admin' LIMIT 1")
if left:
    ex("UPDATE users SET hod_id=? WHERE id=?", (left[0], emp["id"]))
    b3 = E.get("/profile", headers=NAV).get_data(as_text=True)
    s.check("...an HOD who has left isn't shown as theirs", '<dt>HOD</dt><dd class="pf-none">Not on record yet</dd>' in b3)
ex("UPDATE users SET department=?, email=?, confirmation_date=?, hod_id=? WHERE id=?",
   (orig["department"], orig["email"], orig["confirmation_date"], orig["hod_id"], emp["id"]))

# An HOD or a CEO with no HOD of their own sees no HOD row (Chris, 2026-10-26: "if the person is a HOD, or CEO,
# technically the HOD will be blank, in this case we can remove it from their user profile page").
def dt_labels():
    return re.findall(r"<dt>([^<]+)</dt>", E.get("/profile", headers=NAV).get_data(as_text=True))


lead0 = q("SELECT buceo_bg, buceo_company, bgceo_bg FROM users WHERE id=?", (emp["id"],))
heads0 = q("SELECT COUNT(*) FROM users WHERE hod_id=?", (emp["id"],))[0]
s.check("the test person heads nobody to start with", heads0 == 0 and not lead0["bgceo_bg"] and not lead0["buceo_bg"]
        and not q("SELECT 1 FROM pm_calibration_groups WHERE calibrator_id=?", (emp["id"],)), (heads0, dict(lead0)))
ex("UPDATE users SET hod_id=NULL WHERE id=?", (emp["id"],))
s.check("someone with no HOD who heads nobody still sees the row, \"Not on record yet\"", "HOD" in dt_labels())
mate = q("SELECT id, hod_id FROM users WHERE role!='admin' AND left_at IS NULL AND id!=? ORDER BY id LIMIT 1",
         (emp["id"],))
ex("UPDATE users SET hod_id=? WHERE id=?", (emp["id"], mate["id"]))
lb = dt_labels()
s.check("an HOD (someone's HOD points at them) with no HOD of their own: no HOD row",
        "HOD" not in lb and lb == ["Employee ID", "Business group", "Business unit", "Department", "Line manager",
                                   "Work email", "Joined", "Confirmed"], lb)
above = q("SELECT id, full_name FROM users WHERE role!='admin' AND left_at IS NULL AND id NOT IN (?, ?) ORDER BY id "
          "LIMIT 1", (emp["id"], mate["id"]))
ex("UPDATE users SET hod_id=? WHERE id=?", (above["id"], emp["id"]))
b4 = E.get("/profile", headers=NAV).get_data(as_text=True)
s.check("...an HOD who sits under another HOD still sees them",
        "<dt>HOD</dt><dd>%s</dd>" % a.Markup.escape(PN(above["full_name"])) in b4)
ex("UPDATE users SET hod_id=NULL WHERE id=?", (emp["id"],))
ex("UPDATE users SET hod_id=? WHERE id=?", (mate["hod_id"], mate["id"]))
s.check("...and with nobody under them again, the row is back", "HOD" in dt_labels())
ex("UPDATE users SET bgceo_bg=? WHERE id=?", (emp["business_group"], emp["id"]))
s.check("a BG CEO with no HOD: no HOD row", "HOD" not in dt_labels())
ex("UPDATE users SET bgceo_bg=? WHERE id=?", (lead0["bgceo_bg"], emp["id"]))
ex("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?, 'ZZTEST SEAT UNIT', ?)",
   (emp["business_group"], emp["id"]))
s.check("a BU CEO with no HOD: no HOD row", "HOD" not in dt_labels())
ex("DELETE FROM buceo_seats WHERE company='ZZTEST SEAT UNIT' AND user_id=?", (emp["id"],))
ex("UPDATE users SET buceo_bg=?, buceo_company=? WHERE id=?", (lead0["buceo_bg"], lead0["buceo_company"], emp["id"]))
ex("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES ('ZZTEST GC GROUP', ?)", (emp["id"],))
s.check("a Group Chief with no HOD: no HOD row", "HOD" not in dt_labels())
ex("DELETE FROM pm_calibration_groups WHERE name='ZZTEST GC GROUP'")
s.check("...and with every seat gone again, the row is back", "HOD" in dt_labels())
ex("UPDATE users SET hod_id=? WHERE id=?", (orig["hod_id"], emp["id"]))
s.check("the Ticketing agent's record leaves the HOD out where their Profile does",
        'if not (k == "hod" and rec.get("hod_hidden"))' in H.source(a))

s.section("3. The group and unit follow Org structure's preferred names")
bg, co = emp["business_group"], emp["company"]
unit_before = q("SELECT preferred_name FROM org_units WHERE business_group=? AND company=?", (bg, co))
bg_before = q("SELECT preferred_name FROM org_bg_display WHERE business_group=?", (bg,))
has_unit_row = unit_before is not None
if has_unit_row:
    ex("UPDATE org_units SET preferred_name='ZZTEST UNIT ONE' WHERE business_group=? AND company=?", (bg, co))
    s.check("the Profile shows the unit's preferred name", "<dd>ZZTEST UNIT ONE</dd>" in
            E.get("/profile", headers=NAV).get_data(as_text=True))
    ex("UPDATE org_units SET preferred_name='ZZTEST UNIT ONE RENAMED' WHERE business_group=? AND company=?", (bg, co))
    s.check("...renamed there, the Profile shows the new one at once", "<dd>ZZTEST UNIT ONE RENAMED</dd>" in
            E.get("/profile", headers=NAV).get_data(as_text=True))
    ex("UPDATE org_units SET preferred_name=NULL WHERE business_group=? AND company=?", (bg, co))
    s.check("...with none set, the unit's own name in proper case", "<dd>%s</dd>" % PN(co) in
            E.get("/profile", headers=NAV).get_data(as_text=True))
    ex("UPDATE org_units SET preferred_name=? WHERE business_group=? AND company=?",
       (unit_before[0], bg, co))
else:
    s.check("the person's unit is in Org structure", False, "no org_units row")
ex("INSERT INTO org_bg_display(business_group, preferred_name) VALUES (?, 'ZZTEST GROUP') ON CONFLICT(business_group) "
   "DO UPDATE SET preferred_name='ZZTEST GROUP'", (bg,))
s.check("the group's preferred name too", "<dd>ZZTEST GROUP</dd>" in E.get("/profile", headers=NAV).get_data(as_text=True))
if bg_before is None:
    ex("DELETE FROM org_bg_display WHERE business_group=?", (bg,))
else:
    ex("UPDATE org_bg_display SET preferred_name=? WHERE business_group=?", (bg_before[0], bg))
src = H.source(a)
prof_fn = src[src.find("def profile_record("):src.find("\n@app.route", src.find("def profile_record("))]
s.check("...read through display_bg / display_company, the helpers every admin page uses",
        "display_bg(bg)" in prof_fn and "display_company(bg," in prof_fn)
tpl_raw = []
for f in sorted(glob.glob(os.path.join(H.REPO, "templates", "**", "*.html"), recursive=True)):
    t = open(f, encoding="utf-8").read()
    for mm in re.finditer(r"\{\{\s*([\w\.\[\]'\"]*(?:\['company'\]|\.company))\s*(?:or [^}]*)?\}\}", t):
        pre = t[max(0, mm.start() - 120):mm.start()]
        if re.search(r'([\w-]+)="[^"]*$', pre) and not re.search(r'(title|data-confirm|aria-label)="[^"]*$', pre):
            continue
        tpl_raw.append("%s: %s" % (os.path.relpath(f, H.REPO), mm.group(1)))
s.check("no page prints a person's raw unit name where its preferred name belongs", not tpl_raw, tpl_raw)

s.section("4. The picture and password panels")
s.check("both panels are on the page, each a form posting to the Profile",
        body.count('<aside class="od-drawer pf-drawer" data-pf-drawer="') == 2 and body.count('action="/profile"') == 3
        and 'name="action" value="picture"' in body and 'name="action" value="password"' in body)
s.check("...opened from Change picture / Change password (the old page stays the link without script)",
        'data-pf-open="picture"' in body and 'class="st-link" href="/account/password" data-pf-open="password"' in body)
pic = 3
E.post("/profile", data={"csrf_token": "tok", "action": "picture", "avatar": str(pic)})
s.check("a picture saved from the panel", q("SELECT avatar FROM users WHERE id=?", (emp["id"],))[0] == pic)
ex("UPDATE users SET avatar=? WHERE id=?", (orig["avatar"], emp["id"]))
ex("UPDATE users SET password_hash=? WHERE id=?",
   (a.generate_password_hash("Old-pass-123", method="pbkdf2:sha256"), emp["id"]))
E = H.client_as(a, emp["id"])   # a password set by hand ends their sessions (the handoff's 12.2): they sign in again
r = E.post("/profile", data={"csrf_token": "tok", "action": "password", "current": "wrong-one", "new": "New-pass-456",
                             "confirm": "New-pass-456"})
rb = r.get_data(as_text=True)
s.check("a wrong current password: the panel opens again, saying why, and nothing changes",
        r.status_code == 200 and "Your current password is incorrect." in rb and 'show("password");' in rb
        and a.check_password_hash(q("SELECT password_hash FROM users WHERE id=?", (emp["id"],))[0], "Old-pass-123"))
r = E.post("/profile", data={"csrf_token": "tok", "action": "password", "current": "Old-pass-123", "new": "short",
                             "confirm": "short"})
s.check("...too short is refused", "at least %d characters" % a.PASSWORD_MIN in r.get_data(as_text=True))
r = E.post("/profile", data={"csrf_token": "tok", "action": "password", "current": "Old-pass-123",
                             "new": "New-pass-456", "confirm": "New-pass-456"})
s.check("...right, it's changed and they're back on the Profile",
        r.status_code == 302 and r.headers.get("Location", "").endswith("/profile")
        and a.check_password_hash(q("SELECT password_hash FROM users WHERE id=?", (emp["id"],))[0], "New-pass-456"))
s.check("the Change password page and the panel share one writer",
        src.count("_password_change(") >= 3 and "def _password_change(db, u, cur, new, confirm)" in src)
ex("UPDATE users SET password_hash=? WHERE id=?", (orig["password_hash"], emp["id"]))
E = H.client_as(a, emp["id"])   # ...and again once it is put back

s.section("5. The top bar")
with a.app.test_request_context("/"):
    a.session["user_id"] = emp["id"]
    nm = a.inject_user().get("nav_me") or {}
s.check("nav_me carries the proper-cased title and the whole line",
        PN(emp["job_title"]) in (nm.get("role") or "") and nm.get("full", "").endswith(nm.get("role") or "~"),
        sorted(nm.keys()))
btn = body[body.find('id="acct-trigger"'):][:600]
s.check("...and the Account button's title holds that whole line, for the hover",
        nm.get("full") and ('title="%s"' % a.Markup.escape(nm["full"])) in btn)
CSS = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
s.check("...with room for it (the name column 320px, was 220)", ".tb-who b, .tb-who small { max-width: 320px;" in CSS)

s.section("6. The admin side: joined date and the missing-details download")
SA = H.client_as(a, SU["id"])
j0 = emp["joined_date"]
r = SA.post("/admin/users/%d/lines" % emp["id"], data={"csrf_token": "tok", "action": "details_preview",
                                                        "company": emp["company"], "joined_date": "2015-03-02"})
pb = r.get_data(as_text=True)
s.check("the Details preview names the joined date change", r.status_code == 200 and "Joined date" in pb
        and "2015-03-02" in pb, r.status_code)
s.check("...and carries it into the apply form", 'name="joined_date" value="2015-03-02"' in pb)
r = SA.post("/admin/users/%d/lines" % emp["id"], data={"csrf_token": "tok", "action": "details_apply",
                                                        "company": emp["company"], "department": emp["department"],
                                                        "job_title": emp["job_title"], "job_grade": emp["job_grade"] or "",
                                                        "joined_date": "2015-03-02"})
s.check("Save details writes it", q("SELECT joined_date FROM users WHERE id=?", (emp["id"],))[0] == "2015-03-02")
s.check("...and the audit trail says so", q("SELECT COUNT(*) FROM activity_log WHERE action='set_details' AND "
                                             "target_user_id=? AND detail LIKE '%joined date%'", (emp["id"],))[0] >= 1)
SA.post("/admin/users/%d/lines" % emp["id"], data={"csrf_token": "tok", "action": "details_apply",
                                                    "company": emp["company"], "joined_date": "2099-01-01"})
s.check("...a date more than a year ahead is refused", q("SELECT joined_date FROM users WHERE id=?", (emp["id"],))[0]
        == "2015-03-02")
ex("UPDATE users SET joined_date=? WHERE id=?", (j0, emp["id"]))
s.check("the Details panel has the joined date field", 'type="date" name="joined_date"' in open(
    os.path.join(H.REPO, "templates", "person", "_overview.html"), encoding="utf-8").read())

ex("UPDATE users SET email=NULL WHERE id=?", (emp["id"],))
r = SA.get("/admin/export/no-details.xlsx")
s.check("the download opens for the super admin, as Excel", r.status_code == 200 and r.data[:2] == b"PK", r.status_code)
try:
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(r.data), read_only=True)
    ws = wb.worksheets[0]
    head = [c.value for c in next(ws.iter_rows(max_row=1))]
    rowsx = [[c.value for c in rw] for rw in ws.iter_rows(min_row=2)]
    s.check("...in the roster import's columns, then its Reference: columns",
            head[:len(a.ROSTER_COLUMNS)] == list(a.ROSTER_COLUMNS) and "Reference: missing" in head, head)
    mine = [rw for rw in rowsx if rw[0] == emp["employee_id"]]
    s.check("...the person with no work email is on it, saying so",
            mine and "Work email" in (mine[0][head.index("Reference: missing")] or ""))
except ImportError:
    s.check("openpyxl to read the file", False)
ex("UPDATE users SET email=? WHERE id=?", (orig["email"], emp["id"]))
s.check("...listed on Reports and access-mapped to People, like the other missing downloads",
        any(x[3] == "admin_export_no_details" and x[0] == "people" for x in a.ADMIN_REPORTS)
        and a._ACCESS_PAGE_MODULE.get("admin_export_no_details") == "people")

s.section("7. Every template prints a person's job title or department through `proper`")
FIELD = r"(?:job_title|department|dept)"
HEAD = re.compile(r"^((?:[A-Za-z_]\w*)(?:\[['\"]\w+['\"]\]|\.\w+)*?(?:\[['\"]" + FIELD + r"['\"]\]|\." + FIELD + r")|"
                  + FIELD + r")(\s+or\s+.+)?$", re.S)
OK_ATTR = ("data-confirm", "data-prompt", "data-sub", "title", "aria-label", "data-confirm-ok", "alt", "placeholder")
raw = []
for f in sorted(glob.glob(os.path.join(H.REPO, "templates", "**", "*.html"), recursive=True)):
    t = open(f, encoding="utf-8").read()
    for mm in re.finditer(r"\{\{-?\s*(.*?)\s*-?\}\}", t, re.S):
        hm = HEAD.match(mm.group(1))
        if not hm or "proper" in mm.group(1) or re.search(r"==|!=|\bif\b|\(", hm.group(2) or ""):
            continue
        am = re.search(r'([\w-]+)="[^"]*$', t[max(0, mm.start() - 160):mm.start()])
        if am and am.group(1) not in OK_ATTR:
            continue
        raw.append("%s: %s" % (os.path.relpath(f, H.REPO), mm.group(1)[:60]))
s.check("no template prints one raw (form values and data keys keep HRIS's spelling)", not raw, raw[:12])

s.section("8. Help: the work-details topic")
s.check("Report a problem offers \"My work details are wrong\"", ("details", "My work details are wrong") in a.HELP_ABOUT)
s.check("...and a door with data-help-about opens Help on that topic",
        'open(t.getAttribute("data-help-open") || "home", t.getAttribute("data-help-about"));' in HELPJS
        and "function pickAbout(key)" in HELPJS)

s.check("...and Help on the Profile has the Profile's own answers (Chris, 2026-10-22: new features reach Help, the KB "
        "and the agents)", (lambda j: j.get("label") == "Profile" and j.get("where") == "Profile"
                            and [x.get("key") for x in j.get("items") or []][:3] == ["prof_wrong", "prof_from", "prof_empty"])(
            E.get("/help/answers", query_string={"ep": "my_settings"}).get_json() or {}))
with a.app.app_context():
    kb = a.get_db().execute("SELECT title, body, active FROM kb_entries WHERE slug='your-profile'").fetchone()
s.check("the KB knows the Profile (your-profile), in words, no ids or thresholds",
        kb is not None and kb["active"] and "Account menu" in kb["body"] and "Report it with Help" in kb["body"]
        and not re.search(r"\d", kb["body"]))
s.check("the Account menu's Change password opens the Profile's panel for an employee",
        '<a href="/profile?panel=password" role="menuitem">Change password</a>' in body)
s.check("...and the tour's top-bar stop names the Profile", "Profile shows your work details" in open(
    os.path.join(H.REPO, "static", "onboarding.js"), encoding="utf-8").read())


def _winning(prop, classes):
    """The value style.css gives `prop` on an element carrying exactly `classes`: the most specific compound selector
    of those classes wins, a later one breaks a tie, as the browser does."""
    css = re.sub(r"/\*.*?\*/", "", open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read(), flags=re.S)
    best = None
    for n, (sels, decl) in enumerate(re.findall(r"([^{}]+)\{([^{}]*)\}", css)):
        vals = re.findall(r"(?:^|;)\s*%s\s*:\s*([^;]+)" % re.escape(prop), decl)
        if not vals:
            continue
        for sel in sels.split(","):
            sel = sel.strip()
            if re.fullmatch(r"(\.[\w-]+)+", sel) and set(sel[1:].split(".")) <= set(classes):
                key = (sel.count("."), n)
                if best is None or key > best[0]:
                    best = (key, vals[-1].strip())
    return best and best[1]


# Initials (no picture) are a span with both classes, on the card, the picture card and the picker's preview.
s.check("a Profile without a picture draws its initials as one span with .st-init and .pf-av",
        'class="st-init pf-av"' in open(os.path.join(H.REPO, "templates", "settings.html"), encoding="utf-8").read())
s.check("...and those initials sit in the middle of the circle: display flex, centred both ways (they once sat clipped "
        "at the top left, .pf-av's block winning)",
        [_winning(p, ("st-init", "pf-av")) for p in ("display", "align-items", "justify-content")]
        == ["flex", "center", "center"],
        [_winning(p, ("st-init", "pf-av")) for p in ("display", "align-items", "justify-content")])
s.check("...while a picture stays a block", _winning("display", ("pf-av",)) == "block")

# A page script's alias for the proper-name helper is that name's only binding in the file: a local of the same name
# shadows it, and the call throws. On 2026-10-22 the calibration roster's name cell was `var pn`, so pn(r.department)
# threw and the BU CEO's curve and roster never drew (Start too).
_shadowed, _aliases = [], 0
for _f in sorted(glob.glob(os.path.join(H.REPO, "static", "*.js"))):
    _src = re.sub(r"/\*.*?\*/|//[^\n]*", "", open(_f, encoding="utf-8").read(), flags=re.S)
    for _name in re.findall(r"\bvar\s+(\w+)\s*=\s*window\.onehrProper\b", _src):
        _aliases += 1
        _decl = len(re.findall(r"\b(?:var|let|const)\s+%s\b" % re.escape(_name), _src))
        _params = [p for p in re.findall(r"\bfunction\b[^(]*\(([^)]*)\)", _src)
                   if re.search(r"\b%s\b" % re.escape(_name), p)]
        if _decl != 1 or _params:
            _shadowed.append("%s: %s declared %d times, a parameter %d times"
                             % (os.path.basename(_f), _name, _decl, len(_params)))
s.check("the page scripts' proper-name helper is never shadowed by a local of the same name (it once broke the BU "
        "CEO's calibration roster)", _aliases > 0 and not _shadowed, _shadowed or "%d alias(es) checked" % _aliases)

sys.exit(s.done())
