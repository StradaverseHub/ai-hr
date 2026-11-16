"""The admin table standard and Ask OneHR on the dashboard (the canvas "OneHR Ask Agent and Admin Standard", 2026-10-11;
Chris: "table should have max view of 15 rows and the column header to behave like excel-like sort and filter, filter
of BG/BU/department in one row with navigation button, all actions affecting users must have a double confirmation
box").

What this pins:
  * Ask OneHR is a button and a side panel on the employee's own dashboard only, with its offline variant; a question
    it declines is counted (no text), and HR's page of questions it couldn't answer never names who asked, follows
    the admin's scope and the filter rows, and its download can't open as a formula
  * every POST form on the admin, settings and person pages asks first (OneHR's own box, or a box that asks for the
    value), except a short list of previews and forms whose question is set by their script
  * business group, unit and department are rows above the table, never column filters, on the pages converted here;
    the shared enhancer gives every plain admin table a header menu and a 15-row view
  * the column menu carries a row's detail row with it; a cancelled confirm puts a select back; a Users save keeps
    the unit and department rows

Read-mostly on the shared suite database; the activity rows it writes are removed at the end.
"""
import glob
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Admin table standard + Ask OneHR on the dashboard")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


with a.app.app_context():
    db = a.get_db()
    EMP = db.execute("SELECT u.id FROM users u WHERE u.role!='admin' AND u.left_at IS NULL AND u.is_demo=0 "
                     "AND COALESCE(u.business_group,'')!='' ORDER BY u.id LIMIT 1").fetchone()[0]
    EMP_BG = db.execute("SELECT business_group FROM users WHERE id=?", (EMP,)).fetchone()[0]
    OTHER = db.execute("SELECT id FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 AND "
                       "COALESCE(business_group,'') NOT IN ('', ?) ORDER BY id LIMIT 1", (EMP_BG,)).fetchone()[0]
    OTHER_BG = db.execute("SELECT business_group FROM users WHERE id=?", (OTHER,)).fetchone()[0]
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' LIMIT 1").fetchone()[0]
    BGA = db.execute("SELECT u.id FROM users u WHERE u.role='admin' AND u.admin_bg=? AND NOT EXISTS (SELECT 1 FROM "
                     "admin_companies c WHERE c.admin_id=u.id) LIMIT 1", (EMP_BG,)).fetchone()
    BGA = BGA[0] if BGA else None
    NAMES = {r[0]: (r[1], r[2]) for r in db.execute("SELECT id, full_name, employee_id FROM users WHERE id IN (?,?)",
                                                     (EMP, OTHER))}
    LOG0 = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]

_orig_avail = a.ai_draft.review_agent_available
emp, sup = H.client_as(a, EMP), H.client_as(a, SUP)
try:
    # -----------------------------------------------------------------------
    s.section("Ask OneHR: a permanent guide panel on the left of the employee's own dashboard (2026-10-15)")
    a.ai_draft.review_agent_available = lambda: True
    html = emp.get("/dashboard").get_data(as_text=True)
    s.check("a permanent panel, open on arrival, with a rail to fold it to -- no floating icon any more",
            re.search(r'<aside class="gp" id="ask-panel"(?![^>]*hidden)', html) is not None
            and re.search(r'<aside class="gp-rail" id="gp-rail"[^>]*hidden', html) is not None
            and 'id="ask-open"' not in html and 'class="ai-fab' not in html)
    s.check("at rest: a short greeting and the prompts, nothing preloaded (Chris, 2026-10-16)",
            'class="gp-items"' not in html and 'class="gp-wait"' not in html and 'class="gp-lead"' in html
            and 'ask-sugg' in html)
    _css = read("static/style.css")
    s.check("...and its text field has no ring of its own inside the box's (the page-wide focus shadow is off there)",
            ".gp-box input:focus, .gp-box input:focus-visible { outline: none; box-shadow: none; border: 0; }" in _css)
    s.check("the panel posts to /ask and offers places to go", 'data-endpoint="/ask"' in html
            and 'ask-sugg' in html and "ask_onehr.js" in html and 'id="gp-fold"' in html)
    s.check("...and no daily question count (Chris, 2026-10-11: \"we don't need to fix the number of questions\")",
            'id="ask-left"' not in html and "questions left today" not in html)
    a.ai_draft.review_agent_available = lambda: False
    html = emp.get("/dashboard").get_data(as_text=True)
    s.check("with no model it turns to search: grey, 'Search only', a navy Search button",
            'class="gp is-offline"' in html and "Search only" in html and 'class="gp-send is-offline"' in html
            and 'aria-label="Search"' in html and 'data-available="0"' in html)
    a.ai_draft.review_agent_available = lambda: True
    r = sup.get("/dashboard", follow_redirects=True)
    s.check("an admin's pages never carry it (they have the Admin Agent)", 'id="ask-panel"' not in
            r.get_data(as_text=True))
    ok_other = True
    for path in ("/review", "/idp"):
        rr = emp.get(path, follow_redirects=True)
        ok_other &= 'id="ask-panel"' not in rr.get_data(as_text=True)
    s.check("...nor any page but the dashboard", ok_other)

    js = read("static/ask_onehr.js")
    s.check("answers are drawn as text, never HTML", "innerHTML" not in js and "textContent" in js)
    s.check("it folds to the rail and back, remembered in this browser only (storage failures ignored)",
            'getElementById("gp-fold")' in js and 'getElementById("gp-open")' in js and "localStorage.setItem" in js
            and "catch (e)" in js)
    s.check("an answer's button is a dashboard panel, an address on this site only, or a card it marks",
            'c.href.charAt(0) === "/" && c.href.charAt(1) !== "/"' in js and 'setAttribute("data-panel"' in js
            and "MARKS[c.mark]" in js)

    # -----------------------------------------------------------------------
    s.section("a declined question is counted, with no text")
    with a.app.app_context():
        n0 = H.one(a, "SELECT COUNT(*) FROM activity_log WHERE id>? AND user_id=? AND action='ask_declined'",
                   (LOG0, EMP))
    j = emp.post("/ask", data={"csrf_token": "tok", "message": "How is my potential score calculated?"}).get_json()
    s.check("a scoring question is declined in code", (j or {}).get("blocked") == "scoring", j)
    s.check("...and counted as declined, keeping no text", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE id>? AND user_id=? AND action='ask_declined' AND detail IS NULL",
        (LOG0, EMP)) == n0 + 1)
    s.check("...and it stays out of the admin audit log", "ask_declined" in a.SELF_SERVICE_ACTIONS
            and "ask_declined" in a.ACTION_LABELS)

    # -----------------------------------------------------------------------
    s.section("HR's page of questions it couldn't answer: never who asked, in the admin's scope")
    with a.app.app_context():
        d_ = a.get_db()
        for uid, q in ((EMP, "ZZSTD where do I see my leave balance"), (OTHER, "ZZSTD can I swap my moderator"),
                       (OTHER, "=HYPERLINK(\"http://x\",\"ZZSTD\")")):
            d_.execute("INSERT INTO activity_log(user_id, action, detail) VALUES (?, 'ask_unanswered', ?)", (uid, q))
        d_.commit()
    r = sup.get("/admin/ask-log")
    page = r.get_data(as_text=True)
    s.check("the super admin's page lists both groups' questions", r.status_code == 200
            and "ZZSTD where do I see my leave balance" in page and "ZZSTD can I swap my moderator" in page)
    s.check("...and never names who asked (no name, no Employee ID)",
            all(n not in page and (e or "ZZ-none") not in page for n, e in NAMES.values()))
    s.check("...with the tiles and the business group row", "Questions this week" in page
            and "Declined by the rules" in page and 'class="adm-frows"' in page)
    tpl = read("templates/admin_ask_log.html")
    s.check("the business group column sorts only (the rows above filter it); the unit column sorts and filters "
            "(Chris, 2026-10-20)",
            re.search(r"'bg':\s*\{'mode': 'sort'", tpl) is not None
            and re.search(r"'unit':\s*\{'mode': 'clientFilter'", tpl) is not None)
    page = sup.get("/admin/ask-log", query_string={"fbg": OTHER_BG}).get_data(as_text=True)
    s.check("picking a business group row narrows the list", "ZZSTD can I swap my moderator" in page
            and "ZZSTD where do I see my leave balance" not in page)
    if BGA:
        r_ = H.client_as(a, BGA).get("/admin/ask-log")
        s.check("a group admin can't open it: Audit and usage is the super admin's (Chris, 2026-10-21)",
                r_.status_code in (302, 403), r_.status_code)
    r = sup.get("/admin/ask-log.csv")
    body = H.as_csv_text(r)
    s.check("the download carries the questions, never names", r.status_code == 200 and "ZZSTD can I swap" in body
            and all(n not in body for n, _e in NAMES.values()))
    s.check("...and a question typed as a formula can't run as one", "'=HYPERLINK" in body
            and "\n=HYPERLINK" not in body and ",=HYPERLINK" not in body)
    s.check("an employee can't open it", emp.get("/admin/ask-log").status_code in (302, 403))
    s.check("it sits under Audit and usage in the admin menu", "admin_ask_log" in H.source(a).split(
        '"key": "ask", "label": "Ask OneHR"')[1][:120])

    # -----------------------------------------------------------------------
    s.section("every action on the admin pages asks first")
    # A form passes when the form or one of its submit buttons carries data-confirm (OneHR's own box), or the form
    # asks for a value in that box (data-prompt). The exceptions change nothing, or set their question by script.
    EXEMPT = {
        ("admin_leaders.html", "hod_preview"), ("admin_leaders.html", "hod_remove_preview"),   # the removal's preview
        ("person/_overview.html", "lm_preview"),
        ("person/_overview.html", "hod_preview"), ("person/_overview.html", "details_preview"),
        ("admin_import_roster.html", "preview"),                  # previews and the roster check: nothing changes
        ("admin_import_roster.html", "quality_ok"),               # past the quality step: nothing changes yet
        ("admin_import_kpi_targets.html", "preview"),             # the KPI import's four steps: nothing changes
        ("admin_import_kpi_targets.html", "quality_ok"),          # before Apply, which asks (2026-10-26)
        ("admin_import_kpi_targets.html", "decide"), ("admin_import_kpi_targets.html", "to_apply"),
        ("admin_learning_hrdc_levy.html", "levy_upload"),        # checks the file: the four steps, then Apply asks
        ("admin_performance_bu_fill.html", "preview"),            # Preview only; Fill is its own confirmed form
        ("admin_learning_certificates.html", "preview"),          # a certificate preview as a PDF: nothing is saved
        ("admin_reminders.html", "test"),                         # a test email to the address typed, no one else
        ("admin_participants.html", "pt-form"), ("admin_talent_release.html", "rr-form"),
        ("admin_users_bulk.html", "bulk-form"), ("admin_kpi_library_import.html", "kpilib-upload"),  # set by script
        ("settings/cards/_points.html", "pts-check"),             # Points per answer's "Save points" only CHECKS (writes nothing); the step's own form asks
    }
    files = sorted(glob.glob(os.path.join(ROOT, "templates", "admin_*.html"))
                   + glob.glob(os.path.join(ROOT, "templates", "settings", "**", "*.html"), recursive=True)
                   + glob.glob(os.path.join(ROOT, "templates", "person", "**", "*.html"), recursive=True))
    missing, scanned, script_ok = [], 0, True
    for f in files:
        rel = os.path.relpath(f, os.path.join(ROOT, "templates"))
        src = re.sub(r"\{#.*?#\}", "", open(f, encoding="utf-8").read(), flags=re.S)
        for m in re.finditer(r"<form\b(?:[^<>]|\{\{.*?\}\}|\{%.*?%\})*?>", src, flags=re.S):
            tag = m.group(0)
            if not re.search(r"method=[\"']post[\"']", tag, re.I):
                continue
            scanned += 1
            end = src.find("</form>", m.end())
            body = src[m.end():end if end > 0 else len(src)]
            if ("data-confirm=" in tag or "data-prompt=" in tag
                    or re.search(r"<button\b[^>]*data-confirm=", body, re.S)):
                continue
            fid = (re.search(r"\bid=[\"']([^\"']+)", tag) or [None, ""])[1]
            acts = re.findall(r"name=[\"']action[\"']\s+value=[\"']([^\"']+)", body)
            keys = {fid} | set(acts) | ({"preview"} if re.search(r"name=[\"']preview[\"']", body) and not acts else set())
            hit = [k for k in keys if (rel, k) in EXEMPT]
            if not hit:
                missing.append("%s:%d %s" % (rel, src[:m.start()].count("\n") + 1, fid or ",".join(acts)))
            elif fid in ("pt-form", "rr-form", "bulk-form", "kpilib-upload"):
                script_ok &= "data-confirm" in src[m.end():]   # the script that sets the question is on the page
    s.check("every POST form asks first, bar the listed exceptions (%d forms scanned)" % scanned,
            scanned > 100 and not missing, missing)
    s.check("...and the forms whose question is set by script do set it", script_ok)
    base = read("templates/base.html")
    s.check("the box is OneHR's own, never the browser's: no confirm() left on these pages",
            not [f for f in files if re.search(r"\bconfirm\(", open(f, encoding="utf-8").read())])
    s.check("cancelling a confirm puts an auto-submitting select back as it was",
            "select[data-was]" in base and "onCancel" in base)
    f360 = read("templates/person/_f360.html")
    s.check("...as the 360 panel's relationship select needs", 'data-was="{{ a[\'relationship\'] }}"' in f360
            and "requestSubmit" in f360)
    busy = base[base.index("Submit feedback: dim the clicked button"):][:1200]
    s.check("after OK the confirmed form's button shows it is working, so it can't be sent twice",
            "f.hasAttribute('data-no-busy')) return;" in busy and "hasAttribute('data-confirm')" not in busy)
    s.check("a destructive change is red", "data-confirm-tone=\"danger\"" in read("templates/settings/_pm.html")
            and "data-confirm-tone=\"danger\"" in read("templates/_gc_panels.html"))   # the groups' panels (2026-10-22)

    # -----------------------------------------------------------------------
    s.section("the 360 tab: a line manager added by name gets the conflict check; Add the ticked waits for a tick")
    # Chris, 2026-10-11: "fix both of the open items too"
    src360 = re.sub(r"\{#.*?#\}", "", f360, flags=re.S)
    addform = src360[src360.index('class="pp-inline pp-addsearch"'):][:700]
    s.check("the add-by-name form joins the line-manager conflict check, reading the relationship it sets",
            "data-lm-subject=" in addform and 'data-lm-rel-field="relationship"' in addform)
    pick = src360[src360.index("function pick(r)"):][:400]
    run_ = src360[src360.index("function run()"):][:300]
    s.check("...and tells it who was picked, clearing that when the search changes",
            "f.setAttribute('data-lm-eid', r.employee_id)" in pick and "f.removeAttribute('data-lm-eid')" in run_)
    s.check("a cancelled conflict choice (or a failed check) puts a changed select back",
            "if (!disposition) { restoreWas(f); return; }" in base and "function restoreWas(f)" in base
            and base.count("restoreWas(f); openNotice(") == 2)
    sugg = src360[src360.index('class="pp-sugg"'):]
    s.check("Add the ticked starts greyed out and wakes on a tick", '<button type="submit" class="btn-link" disabled>Add '
            'the ticked</button>' in sugg and "btn.disabled = !ticked.length" in sugg)
    s.check("...and its box names who is ticked, how many fit, and what a ticked line manager changes",
            "' and ' + (names.length - 3) + ' more'" in sugg and "fit under the panel target" in sugg
            and "Math.min(ticked.length, room)" in sugg and "'The panel is full'" in sugg
            and "data-has-lm" in sugg and "becomes a matrix manager" in sugg)
    with a.app.app_context():
        d_ = a.get_db()
        cid_ = a.active_cycle_id(d_)
        SUBJ = d_.execute("SELECT subject_id FROM assignments WHERE cycle_id=? GROUP BY subject_id ORDER BY "
                          "subject_id LIMIT 1", (cid_,)).fetchone()[0]
        n_before = H.one(a, "SELECT COUNT(*) FROM assignments WHERE subject_id=? AND cycle_id=?", (SUBJ, cid_))
        log_before = H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='panel_add_suggested'")
    r = sup.post("/admin/subjects/%d/panel" % SUBJ, data={"csrf_token": "tok", "action": "add_suggested",
                                                          "next": "/admin/users/%d?tab=f360" % SUBJ},
                 follow_redirects=True)
    s.check("an empty Add the ticked is refused with a sentence, nothing added, nothing logged",
            "Tick at least one person to add." in r.get_data(as_text=True)
            and H.one(a, "SELECT COUNT(*) FROM assignments WHERE subject_id=? AND cycle_id=?", (SUBJ, cid_)) == n_before
            and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='panel_add_suggested'") == log_before)
    page = sup.get("/admin/users/%d" % SUBJ, query_string={"tab": "f360"}).get_data(as_text=True)
    s.check("the 360 tab renders with both forms wired", r.status_code == 200 and 'data-lm-rel-field="relationship"'
            in page and "pp-addsearch" in page)

    # -----------------------------------------------------------------------
    s.section("QC finding: renaming onto a name already taken says so instead of crashing")
    # the admin form crawl (2026-10-11): renaming a unit onto a name its group already has was a 500 (UNIQUE), and
    # renaming a group onto another group's name merged the two
    with a.app.app_context():
        d_ = a.get_db()
        org = a.org_map(d_)
        BGX = next((b for b, cs in org.items() if len(cs) >= 2), None)
        BGY = next((b for b in org if b != BGX), None)
        units0 = d_.execute("SELECT COUNT(*) FROM org_units").fetchone()[0]
    if BGX:
        u1, u2 = org[BGX][0], org[BGX][1]
        r = sup.post("/admin/org", data={"csrf_token": "tok", "action": "rename_company", "business_group": BGX,
                                         "old": u1, "new": u2, "cascade": "1"}, follow_redirects=True)
        body = r.get_data(as_text=True)
        with a.app.app_context():
            still = a.org_map(a.get_db())[BGX]
        s.check("renaming a unit onto one its group already has: a sentence, nothing renamed", r.status_code == 200
                and "already has a business unit called" in body and u1 in still and u2 in still, r.status_code)
        r = sup.post("/admin/org", data={"csrf_token": "tok", "action": "rename_bg", "old": BGX, "new": BGY,
                                         "cascade": "1"}, follow_redirects=True)
        with a.app.app_context():
            org2 = a.org_map(a.get_db())
            units1 = a.get_db().execute("SELECT COUNT(*) FROM org_units").fetchone()[0]
        s.check("renaming a group onto another group's name: a sentence, the two groups stay apart",
                r.status_code == 200 and "There is already a business group called" in r.get_data(as_text=True)
                and BGX in org2 and BGY in org2 and units1 == units0, r.status_code)

    # -----------------------------------------------------------------------
    s.section("renaming a group or unit carries everything keyed on its name (the PMO item; Chris, 2026-10-12: 'fix 1')")

    def name_counts(name, cols, unit=None):
        """{table.column: rows} holding `name` (a unit's, within group `unit`) in every column the rename should move."""
        out = {}
        with a.app.app_context():
            d_ = a.get_db()
            for col in cols:
                t, c = col[0], col[1]
                if unit is None:
                    out["%s.%s" % (t, c)] = d_.execute('SELECT COUNT(*) FROM "%s" WHERE "%s"=?' % (t, c), (name,)).fetchone()[0]
                elif col[2]:
                    out["%s.%s" % (t, c)] = d_.execute('SELECT COUNT(*) FROM "%s" WHERE "%s"=? AND "%s"=?' % (t, c, col[2]),
                                                       (name, unit)).fetchone()[0]
        return out
    with a.app.app_context():
        d_ = a.get_db()
        BGR = (d_.execute("SELECT business_group FROM pm_bg_config WHERE business_group IN (SELECT business_group FROM "
                          "org_units WHERE active=1) AND business_group IN (SELECT business_group FROM users) LIMIT 1").fetchone()
               or d_.execute("SELECT business_group FROM org_units o WHERE active=1 AND company IN (SELECT company FROM users "
                             "WHERE business_group=o.business_group) LIMIT 1").fetchone())[0]
        # the synthetic fixture (CI, a plain export) has no PM settings at all: give the group one, so "its settings
        # always move" is exercised there too
        d_.execute("INSERT OR IGNORE INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'A', 'base')", (BGR,))
        UNR = d_.execute("SELECT company FROM org_units WHERE business_group=? AND active=1 AND company IN (SELECT company "
                         "FROM users WHERE business_group=?) LIMIT 1", (BGR, BGR)).fetchone()[0]
        cid_ = next(c_[0] for c_ in d_.execute("SELECT id FROM cycles ORDER BY id").fetchall() if not d_.execute(
            "SELECT 1 FROM calibration_sessions WHERE cycle_id=? AND ((tier='bgceo' AND scope_key=?) OR (tier='buceo' AND "
            "scope_key=?))", (c_[0], BGR, UNR)).fetchone())
        # calibration state keyed on the names: a BG CEO session (scope key = the group) and a BU CEO one (= the unit)
        d_.execute("INSERT INTO calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label) VALUES "
                   "(?, 'bgceo', ?, ?, ?)", (cid_, BGR, BGR, "ZZRN " + BGR))
        d_.execute("INSERT INTO calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label) VALUES "
                   "(?, 'buceo', ?, ?, ?)", (cid_, UNR, BGR, "ZZRN " + UNR))
        d_.commit()
        BGC, UNC, SCOPED, _lab = a._org_name_columns(d_)
    NEW = "ZZRN Renamed Group"
    before = name_counts(BGR, BGC + [("org_units", "business_group")])
    r = sup.post("/admin/org", data={"csrf_token": "tok", "action": "rename_bg", "old": BGR, "new": NEW, "cascade": "1"},
                 follow_redirects=True)
    after_new, after_old = (name_counts(NEW, BGC + [("org_units", "business_group")]),
                            name_counts(BGR, BGC + [("org_units", "business_group")]))
    s.check("a group rename moves every column keyed on its name: settings, people, roles, records (%d columns)" % len(BGC),
            r.status_code == 200 and after_new == before and not any(after_old.values()),
            {k: (before[k], after_new[k], after_old[k]) for k in before if before[k] != after_new[k] or after_old[k]})
    s.check("...its settings by name (scoring, bands, KPI library, PBT)", before.get("pm_bg_config.business_group")
            and after_new.get("pm_bg_config.business_group") == before.get("pm_bg_config.business_group"))
    with a.app.app_context():
        d_ = a.get_db()
        sess = d_.execute("SELECT tier, scope_key, scope_label FROM calibration_sessions WHERE scope_label LIKE 'ZZRN %' "
                          "ORDER BY tier").fetchall()
    s.check("...and the BG CEO's calibration, keyed on the group's name, follows (its label too); the BU CEO's stays on its unit",
            [tuple(x) for x in sess] == [("bgceo", NEW, "ZZRN " + NEW), ("buceo", UNR, "ZZRN " + UNR)], [tuple(x) for x in sess])
    s.check("...and the message says what moved", "Its settings moved with it" in r.get_data(as_text=True))
    r = sup.post("/admin/org", data={"csrf_token": "tok", "action": "rename_bg", "old": NEW, "new": BGR, "cascade": "1"},
                 follow_redirects=True)
    s.check("renaming it back restores every column", name_counts(BGR, BGC + [("org_units", "business_group")]) == before
            and not any(name_counts(NEW, BGC).values()))
    # unticked: the settings still move, the people don't
    r = sup.post("/admin/org", data={"csrf_token": "tok", "action": "rename_bg", "old": BGR, "new": NEW}, follow_redirects=True)
    mid = name_counts(NEW, BGC)
    s.check("unticked, the group's settings still move with it and its people stay on the old name",
            mid.get("pm_bg_config.business_group") == before.get("pm_bg_config.business_group")
            and mid.get("users.business_group") == 0 and name_counts(BGR, BGC).get("users.business_group")
            == before.get("users.business_group"), {k: v for k, v in mid.items() if v})
    sup.post("/admin/org", data={"csrf_token": "tok", "action": "rename_bg", "old": NEW, "new": BGR, "cascade": "1"})
    s.check("...and back again", name_counts(BGR, BGC + [("org_units", "business_group")]) == before)
    # a unit
    ubefore = name_counts(UNR, UNC, unit=BGR)
    with a.app.app_context():
        ubefore["org_units.company"] = a.get_db().execute("SELECT COUNT(*) FROM org_units WHERE business_group=? AND "
                                                         "company=?", (BGR, UNR)).fetchone()[0]
    UNEW = "ZZRN Renamed Unit"
    r = sup.post("/admin/org", data={"csrf_token": "tok", "action": "rename_company", "business_group": BGR, "old": UNR,
                                     "new": UNEW, "cascade": "1"}, follow_redirects=True)
    unew, uold = name_counts(UNEW, UNC, unit=BGR), name_counts(UNR, UNC, unit=BGR)
    with a.app.app_context():
        d_ = a.get_db()
        unew["org_units.company"] = d_.execute("SELECT COUNT(*) FROM org_units WHERE business_group=? AND company=?",
                                               (BGR, UNEW)).fetchone()[0]
        bus = d_.execute("SELECT scope_key FROM calibration_sessions WHERE tier='buceo' AND scope_label LIKE 'ZZRN %'").fetchone()[0]
    s.check("a unit rename moves every unit-keyed column in its group, and the BU CEO's calibration with it",
            r.status_code == 200 and unew == ubefore and not any(uold.values()) and bus == UNEW,
            {k: (ubefore.get(k), unew.get(k), uold.get(k)) for k in ubefore if ubefore.get(k) != unew.get(k) or uold.get(k)})
    sup.post("/admin/org", data={"csrf_token": "tok", "action": "rename_company", "business_group": BGR, "old": UNEW,
                                 "new": UNR, "cascade": "1"})
    s.check("...and back", name_counts(UNR, UNC, unit=BGR) == {k: v for k, v in ubefore.items() if k != "org_units.company"})
    # settings left under the new name (a group removed earlier) are never mixed in
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES ('ZZRN Taken', 'A')")
        d_.commit()
    r = sup.post("/admin/org", data={"csrf_token": "tok", "action": "rename_bg", "old": BGR, "new": "ZZRN Taken",
                                     "cascade": "1"}, follow_redirects=True)
    s.check("a rename onto a name whose settings are still on file is refused, and nothing moves",
            "be mixed" in r.get_data(as_text=True) and name_counts(BGR, BGC) == {k: v for k, v in before.items()
                                                                                   if k != "org_units.business_group"})
    s.check("the rename's columns come from the schema, so a table added later is carried too",
            "sqlite_master" in H.source(a).split("def _org_name_columns")[1][:900])
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM pm_bg_config WHERE business_group='ZZRN Taken'")
        d_.execute("DELETE FROM calibration_sessions WHERE scope_label LIKE 'ZZRN %'")
        d_.commit()

    # -----------------------------------------------------------------------
    s.section("business group, unit and department are rows above the table, not column filters")
    with a.app.app_context():
        key = next(iter(a.DATA_CHECKS_BY_KEY))
    for path, qs, what in (("/admin/performance/exceptions", {}, "KPI lines with no moderator"),
                           ("/admin/panels/build", {}, "Panels"),
                           ("/admin/data-integrity", {"check": key}, "a data integrity check")):
        r = sup.get(path, query_string=qs)
        s.check("%s carries the filter rows" % what, r.status_code == 200 and 'class="adm-frows"'
                in r.get_data(as_text=True), r.status_code)
    page = sup.get("/admin/panels/build", query_string={"bg": EMP_BG}).get_data(as_text=True)
    s.check("Panels: picking a group lights it and opens the unit row, the build choice beside",
            'aria-current="true"' in page and "Business unit" in page and 'name="mode"' in page
            and 'name="bg" onchange' not in page)
    page = sup.get("/admin/data-integrity", query_string={"check": key, "fbg": EMP_BG}).get_data(as_text=True)
    s.check("a data check's export follows the rows picked", ("fbg=" + EMP_BG.replace(" ", "+")) in page
            or ("fbg=" + EMP_BG.replace(" ", "%20")) in page)
    pat = re.compile(r"'(bg|dept)':\s*\{'mode': 'clientFilter'")   # a unit column filters too (Chris, 2026-10-20)
    clean = {}
    for t in ("admin_performance_exceptions.html", "admin_panel_build.html", "admin_data_integrity.html",
              "admin_rating_records.html", "admin_pm_calibration_groups.html", "settings/_pm.html",
              "admin_pat_ref.html", "settings/_tm_profiles.html", "admin_ask_log.html"):
        clean[t] = not pat.search(read("templates/" + t))
    s.check("no group or department column filter left on the converted pages (a unit column filters: 2026-10-20)",
            all(clean.values()), [t for t, ok in clean.items() if not ok])
    led = read("templates/admin_leaders.html")
    s.check("Leaders: the business unit columns sort and filter (Chris, 2026-10-20); the group column sorts only; the "
            "department pick list keeps its search (the department is the row)",
            not re.search(r"'bg':\s*\{'mode': 'clientFilter'", led)
            and len(re.findall(r"'bu':\s*\{'mode': 'clientFilter'", led)) == 2
            # the HOD tab's department list (option A, 2026-10-20) narrows by unit, coverage chip and search instead
            and 'id="ld-dept-table"' in led and "data-ld-unit" in led and "data-ld-show" in led and 'class="ld-find"' in led)

    # -----------------------------------------------------------------------
    s.section("every plain admin table: a header menu and 15 rows in view")
    adm = read("static/admin.js")
    css = read("static/style.css")
    s.check("the enhancer gives a header menu to an admin table that has none, and caps it at 15 rows",
            "window.onehrTableStandard" in adm and "table-cap15" in adm and "col-menu-btn" in adm
            and re.search(r"\b15\b", adm.split("onehrTableStandard")[0][-6000:]) is not None)
    s.check("...leaving group and department headers to sort only; a business unit column sorts and filters (Chris, "
            "2026-10-20)", "var ROW_DIM = /business group|department/i;" in adm)
    import glob as _glob
    _bu_sort = [f for f in _glob.glob(os.path.join(ROOT, "templates", "admin*.html"))
                if re.search(r"'(?:bu|unit)':\s*\{'mode':\s*'sort'", read(f))]
    s.check("...and no admin page's hand-set menu keeps a BU column to sort only", not _bu_sort, _bu_sort)
    prog = read("templates/admin_module_progress.html")
    s.check("...unless the table asks for them to filter too (data-col-filter): the module Progress list has Unit and "
            "Department as two columns, each sorting and filtering (Chris, 2026-10-20)",
            'th.hasAttribute("data-col-filter") || !ROW_DIM.test(label)' in adm
            and "<th>Unit</th><th data-col-filter>Department</th>" in prog
            and "&middot; department" not in prog and "{{ r.department | proper or '—' }}" in prog)
    s.check("...and skipping a table it can't read (merged cells, or marked no-auto-table)", "rowSpan > 1" in adm
            and "no-auto-table" in adm)
    s.check("the header stays put while the rows scroll", ".table-cap15" in css and "sticky" in css[
        css.index(".table-cap15"):][:600])
    cm = read("static/colmenu.js")
    s.check("a row's detail row (the KPI library's Edit) travels with it when sorted, and hides with it",
            "__cmFollow" in cm and cm.count("__cmFollow") >= 3)
    s.check("the 360 subject page's column menu is wired up", "colmenu_script(asset_v)" in read(
        "templates/admin_subject_detail.html"))

    # -----------------------------------------------------------------------
    s.section("the frozen top bar, and the journey's way home")
    # Chris, 2026-10-11: "should we freeze the top navy row with the ask agent button and the account button" and "for
    # the agent chat view, add back the floating back button at bottom left, to go back to the dashboard view"
    s.check("the top bar stays at the top, above the side panels and under the drawers and dialogs",
            H.cv(".topbar { background: var(--navy); padding: 0 24px; min-height: 56px; position: sticky; top: 0; z-index: 890; }")
            in css and "scroll-padding-top" in css)
    s.check("...and the page-level sticky bars start below it (the admin sidebar, the settings index)",
            ".adm-side-in { position: sticky; top: var(--topbar-h);" in css
            and ".adm-set-index { position: sticky; top: calc(var(--topbar-h) + 12px);" in css)
    jt = read("templates/review_journey.html")
    s.check("the AI chat view has the floating Dashboard button, bottom left, straight to the dashboard",
            'class="fab-back is-dash"' in jt and "url_for('dashboard')" in jt.split("block back_button")[1][:400]
            and "body:has(.fab-back.is-dash) .rv-nav" in css)

    # -----------------------------------------------------------------------
    s.section("People: one line a row, so 15 rows sit in about a screen (Chris, 2026-10-12)")
    ut = read("templates/admin_users.html")
    page = sup.get("/admin/users").get_data(as_text=True)
    s.check("the table is fixed-width, every cell one line, cut with its full text as the tooltip",
            "<colgroup>" in ut and ".adm-users { table-layout: fixed; width: 100%; }" in css
            and ".adm-users td { white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" in css
            and 'style="display:block"' not in ut.split('<table class="admin-table adm-users')[1].split("</table>")[0])
    s.check("...the person's job title and department live in the tooltips, still found by the search",
            re.search(r'<td title="[^"]+ · [^"]+">', page) is not None
            and {"job_title", "department"} <= set(a.people_search_in(a.USERS_SEARCH_EXTRA)["all"][2]))   # All fields

    # -----------------------------------------------------------------------
    s.section("a Users save keeps the rows picked")
    src = H.source(a)
    blk = src.split("Stay on the same filtered/searched/paged view after an action")[1][:900]
    s.check("the redirect keeps business group, unit and department", '"fbg", "fbu", "fdept"' in blk)
finally:
    a.ai_draft.review_agent_available = _orig_avail
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM activity_log WHERE id>? AND action IN ('ask_onehr','ask_unanswered','ask_declined',"
                   "'export')", (LOG0,))
        d_.commit()
sys.exit(s.done())
