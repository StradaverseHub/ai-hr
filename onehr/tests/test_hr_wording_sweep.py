"""An admin reading a person whose every KPI is a BU result is told so, and "HR" becomes "Group People" in what staff and admins read
(Chris, 2026-11-09; two of the open small bugs: "AI insight when every KPI is a BU KPI" and "Some HR wordings remain").

What this suite holds:
  1. A person whose KPI lines are ALL BU-level (kpis_bu_only_ids, the one rule) reads "No AI insight: every KPI is a BU result, filled for
     the whole unit by Group People." on the Performance tab and the Overview line, never "Nothing to read yet" / "No AI insight yet";
     a person with one line of their own besides, and a person with no lines at all, read exactly as before. Falsified: with the rule
     forced empty the first reads the old words again.
  2. _pm_perf_headline and the case file say "set by Group People", never "HR" (the model is told the same words).
  3. Source lint: no non-docstring string of app.py or ai_draft.py says HR as a word, bar the four named exceptions; no template shows HR
     outside a Jinja comment. The lint can fail (it sees a sample).
  4. The three help rows that said HR (mobility-preference, career-profile-about, after-submit) are reworded ONCE by the real migration,
     only while the row holds the exact previous text; a hand-edited row is left alone; a second run changes nothing.

Synthetic ZZHW-* people and library rows on the shared suite database; everything is put back at the end.
"""
import ast
import glob
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A person with only BU KPIs reads a plain remark; HR wordings say Group People")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BG, CO = "ZZHW Group", "ZZHW Co Sdn Bhd"
HR = re.compile(r"\bHR\b")
U = {}


def read(*p):
    return open(os.path.join(H.REPO, *p), encoding="utf-8").read()


def cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZHW-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


KB = {}
with a.app.app_context():
    db = a.get_db()
    cleanup(db)
    CID = a.active_cycle_id(db)
    KEEP = {"half": db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0],
            "modules": [tuple(r) for r in db.execute("SELECT * FROM cycle_modules WHERE cycle_id=? AND module_key IN ('review','calibration','pm','tm','idp')", (CID,))]}
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key IN ('review','calibration','pm','tm','idp')", (CID,))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
    for nm, bu in (("ZZHW PAT", 1), ("ZZHW Sales", 0)):
        db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, unit, method, "
                   "weightage_default, bu_level) VALUES (?, '*', '*', 0, '*', ?, 'Financial · Profit', '%', 'more', 30, ?)", (BG, nm, bu))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ HW " + eid, email=None, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CO, years_of_service=5, left_at=None,
                 is_demo=0, job_grade="15", role="user", admin_bg=None, admin_role_id=None, confirmation_date=None, is_system_admin=0)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]

    def line(uid, name, w):
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, rate2, rate3, "
                   "rate4, rate5, business_group, company) VALUES (?,?,?,?, 'more', '%', 'Own', 10,20,30,40,50, ?,?)", (CID, uid, name, w, BG, CO))
    U["BU"] = person("ZZHW-BU")      # every line a BU result
    U["MIX"] = person("ZZHW-MIX")    # a BU line and one of their own
    U["NONE"] = person("ZZHW-NONE")  # no line at all
    line(U["BU"], "ZZHW PAT", 100)
    line(U["MIX"], "ZZHW PAT", 50)
    line(U["MIX"], "ZZHW Sales", 50)
    for slug in ("mobility-preference", "career-profile-about", "after-submit"):
        r = db.execute("SELECT body FROM kb_entries WHERE slug=?", (slug,)).fetchone()
        KB[slug] = r[0] if r else None
    db.commit()
    SU = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' LIMIT 1").fetchone()[0]
SUP = H.client_as(a, SU)
NEW = "No AI insight: every KPI is a BU result, filled for the whole unit by Group People."


def page(uid, tab):
    r = SUP.get("/admin/users/%d?tab=%s" % (uid, tab))
    return r.status_code, r.get_data(as_text=True)


def card(html):
    m = re.search(r'<section class="admin-card pp-card ais-card".*?</section>', html, re.S)
    return m.group(0) if m else ""


def line_of(html, part):
    m = re.search(r'<div class="ais-line[^"]*" data-ais-line="%s">.*?</div>' % part, html, re.S)
    return m.group(0) if m else ""


try:
    s.section("1. every KPI is a BU result")
    with a.app.app_context():
        d = a.get_db()
        s.check("(set-up) the rule says S_BU and nobody else is all-BU (kpis_bu_only_ids)",
                a.kpis_bu_only_ids(d, CID, [U["BU"], U["MIX"], U["NONE"]]) == {U["BU"]})
    sc, html = page(U["BU"], "performance")
    c = card(html)
    s.check("the Performance tab's card says every KPI is a BU result, with no spark", sc == 200 and NEW in c and "rv-ai-src" not in c, (sc, c[:300]))
    s.check("...and not 'Nothing to read yet' or 'once ... submits their KPI results'", "Nothing to read yet" not in c and "submits their KPI" not in c)
    sc, ov = page(U["BU"], "overview")
    pm = line_of(ov, "pm")
    s.check("the Overview's Performance line says the same, not 'No AI insight yet'", NEW in pm and "No AI insight yet" not in pm, pm[:300])
    s.check("the other three parts' lines are as before (No AI insight yet)", ov.count("No AI insight yet") == 3, ov.count("No AI insight yet"))
    sc, html = page(U["MIX"], "performance")
    c = card(html)
    s.check("a person with a line of their own too reads as before", "Nothing to read yet. AI+ writes it once ZZ HW ZZHW-MIX submits their KPI results." in c
            and "BU result" not in c, c[:300])
    sc, html = page(U["NONE"], "performance")
    c = card(html)
    s.check("a person with no KPI lines reads as before", "Nothing to read yet. AI+ writes it once ZZ HW ZZHW-NONE submits their KPI results." in c, c[:300])
    sc, ov = page(U["MIX"], "overview")
    s.check("...on the Overview too (No AI insight yet under each of the four cards)", ov.count("No AI insight yet") == 4, ov.count("No AI insight yet"))
    _real = a.kpis_bu_only_ids
    a.kpis_bu_only_ids = lambda *x, **k: set()
    try:
        sc, html = page(U["BU"], "performance")
    finally:
        a.kpis_bu_only_ids = _real
    s.check("falsified: with the rule forced empty the all-BU person reads the old words again", "Nothing to read yet" in card(html) and NEW not in card(html))

    s.section("2. the headline and the case file")
    hl = a._pm_perf_headline({"hr": [{"kpi": "ZZ PAT", "band": "OUT"}], "lines": 1, "scored": 1, "rows": []})
    s.check("the headline says 'ZZ PAT was set by Group People', no HR", "ZZ PAT was set by Group People" in hl and not HR.search(hl), hl)
    case = a._pm_perf_case_text({"hr": [{"kpi": "ZZ PAT"}], "rows": []}, {})
    s.check("the case file tells the model 'SET BY GROUP PEOPLE', no HR", "SET BY GROUP PEOPLE, not the person's own result" in case and not HR.search(case), case[-200:])

    s.section("3. source lint")
    ALLOW = ("GM GMD GP HQ HR HSE",            # the acronym list proper() keeps in capitals
             "follows it so HR's roster",       # a comment inside the stored schema text
             "an admin, HR, a manager",         # the list of authorities a message may pretend to be
             "Say 'Group People', never HR",    # the rule itself, told to the model
             "Say Group People, never HR")      # ...and in the ticket-reply prompt

    def strings(path):
        tree = ast.parse(read(path))
        doc = set()
        for n in ast.walk(tree):
            if isinstance(n, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.body and isinstance(n.body[0], ast.Expr) \
                    and isinstance(getattr(n.body[0], "value", None), ast.Constant) and isinstance(n.body[0].value.value, str):
                doc.add(id(n.body[0].value))
        return [(n.lineno, n.value) for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in doc
                and HR.search(n.value)]
    for path in ("app.py", "ai_draft.py"):
        before = {getattr(a, n + "_BEFORE_GP") for n in ("_KB_MOBILITY_BODY", "_KB_CAREER_BODY", "_KB_AFTER_SUBMIT_BODY")}   # the exact old texts the migration keys on
        bad = [(ln, v[max(0, HR.search(v).start() - 30):HR.search(v).end() + 30]) for ln, v in strings(path)
               if v not in before and not any(x in v for x in ALLOW)]
        s.check("%s: no string says HR as a word (bar the named exceptions and the three old help texts)" % path, not bad, bad[:5])
    left = [os.path.relpath(f, os.path.join(H.REPO, "templates")) for f in glob.glob(os.path.join(H.REPO, "templates", "**", "*.html"), recursive=True)
            if HR.search(re.sub(r"\{#.*?#\}", "", read(os.path.relpath(f, H.REPO)), flags=re.S))]
    s.check("no template shows HR outside a Jinja comment", not left, left[:5])
    s.check("the lint can fail: it sees an HR in a sample", bool(HR.search(re.sub(r"\{#.*?#\}", "", "{# x #} waiting for HR"))))
    s.check("the three help bodies in source say Group People", all(not HR.search(getattr(a, n)) and "Group People" in getattr(a, n)
                                                                      for n in ("_KB_MOBILITY_BODY", "_KB_CAREER_BODY", "_KB_AFTER_SUBMIT_BODY")))

    s.section("4. the three help rows: reworded once by the real migration")
    SLUGS = (("mobility-preference", "_KB_MOBILITY_BODY"), ("career-profile-about", "_KB_CAREER_BODY"), ("after-submit", "_KB_AFTER_SUBMIT_BODY"))
    s.check("(set-up) the rows exist", all(KB[sl] for sl, _n in SLUGS), KB.keys())
    s.check("the previous wording differs from the new and says HR", all(
        getattr(a, n + "_BEFORE_GP") != getattr(a, n) and HR.search(getattr(a, n + "_BEFORE_GP")) for _sl, n in SLUGS))

    def bodies():
        with a.app.app_context():
            d = a.get_db()
            return {sl: d.execute("SELECT body FROM kb_entries WHERE slug=?", (sl,)).fetchone()[0] for sl, _n in SLUGS}
    with a.app.app_context():
        d = a.get_db()
        for sl, n in SLUGS:
            d.execute("UPDATE kb_entries SET body=? WHERE slug=?", (getattr(a, n + "_BEFORE_GP"), sl))
        d.execute("UPDATE kb_entries SET body=? WHERE slug='career-profile-about'", ("Group People's own hand-edited words about the profile.",))
        d.commit()
    a._ensure_runtime_schema()
    got = bodies()
    s.check("the two rows still holding the previous text are reworded to today's", got["mobility-preference"] == a._KB_MOBILITY_BODY
            and got["after-submit"] == a._KB_AFTER_SUBMIT_BODY, {k: v[:40] for k, v in got.items()})
    s.check("the hand-edited row is left alone", got["career-profile-about"] == "Group People's own hand-edited words about the profile.")
    a._ensure_runtime_schema()
    s.check("a second run changes nothing", bodies() == got)
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE kb_entries SET body=? WHERE slug='career-profile-about'", (a._KB_CAREER_BODY_BEFORE_GP,))
        d.commit()
    a._ensure_runtime_schema()
    s.check("...and the career row, still on the previous text, is reworded too", bodies()["career-profile-about"] == a._KB_CAREER_BODY)
finally:
    with a.app.app_context():
        d = a.get_db()
        for sl, body in KB.items():
            if body is not None:
                d.execute("UPDATE kb_entries SET body=? WHERE slug=?", (body, sl))
        d.execute("UPDATE cycles SET half=? WHERE id=?", (KEEP["half"], CID))
        d.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key IN ('review','calibration','pm','tm','idp')", (CID,))
        for r in KEEP["modules"]:
            d.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", (r[0], r[1], r[2]))
        cleanup(d)

sys.exit(s.done())
