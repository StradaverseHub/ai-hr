"""The KPI targets import in four steps, with the super admin's BU KPI decisions (Chris, 2026-10-26: "for all our
import function, we should have the 4 steps flow, first is the file upload, second is QC, third is to mark the changes
(preview on how it will affect the production data) and get the inputs from the super admin, lastly is final preview
and apply"; "super admin only, KPI targets first then the rest"; canvas [design canvas link removed]).

What this suite holds:
  * step 1 keeps the file on the server, writes nothing, and only its uploader goes on with it
  * step 2: a row that can't go in stops the import (named, by row); things worth a look need "I've looked at these";
    weights that don't total 100%, people not taking part, units written another way, a KPI not in the library
  * step 3: added / updated / left as they are (moderated, or following the unit's BU KPI) / skipped; a later step can't
    be reached before the earlier one is seen; the BU KPI matches by name, a library alias and the same KPI with a
    Focus; a unit's rule that doesn't cover the person and a unit with no setup are said, not asked
  * the decisions are the super admin's alone: a BG admin can't import at all (the super admin's alone, 2026-10-31)
  * step 4: the final picture per person with the decisions in, and its download
  * Apply: a backup first (no backup, nothing applied); refused if OneHR changed since the changes were seen; a line
    decided the unit's BU KPI joins it (added to who carries it, linked, the unit's target, what the file gave it kept
    and given back when taken off); a line kept their own is never adopted by BU KPI setup and never stops a KPI
    coming off; the audit log names each decision; the done page and its download
  * once the Department Review has started, the matches are said and nothing is asked
"""
import atexit
import glob
import html
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The KPI targets import in four steps, with the super admin's BU KPI decisions")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO, CO2 = "ZZKI Group", "ZZKI Unit", "ZZKI Unit B"
U = {}
URL = "/admin/performance/import"
HEAD = "Employee ID,KPI,Focus,Unit of Measure,Weightage,Method,Rate 1,Rate 2,Rate 3,Rate 4,Rate 5,Matrix manager ID\n"
BK_DIR = os.path.join(os.path.dirname(os.path.abspath(a.DB_PATH)), "import-backups")
BK0 = set(glob.glob(os.path.join(BK_DIR, "*.db")))


def line(eid, kpi, w, rates=(80, 90, 100, 110, 120), focus="", unit="%"):
    return "%s,%s,%s,%s,%s,More,%s\n" % (eid, kpi, focus, unit, w, ",".join(str(r) for r in rates)) + ""


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9KI-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM pm_kpi_approvals WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE "
                   "subject_id IN (%s))" % ph, ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE action='pm_kpi_import' AND detail LIKE '%ZZ9KI%'")
    db.execute("DELETE FROM pm_bu_kpis WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_kpi_aliases WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.execute("DELETE FROM admin_roles WHERE name='ZZKI role'")
    db.commit()


def ln(eid, name):
    r = H.rows(a, "SELECT t.* FROM pm_kpi_targets t JOIN users u ON u.id=t.subject_id WHERE t.cycle_id=? AND "
                  "u.employee_id=? AND t.kpi_name=?", (CID, eid, name))
    return dict(r[0]) if r else None


def n_lines():
    return H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets t JOIN users u ON u.id=t.subject_id WHERE t.cycle_id=? AND "
                    "u.employee_id LIKE 'ZZ9KI-%'", (CID,))


def setup_row(name):
    r = H.rows(a, "SELECT * FROM pm_bu_kpis WHERE cycle_id=? AND business_group=? AND company=? AND kpi_name=?",
               (CID, BG, CO, name))
    return dict(r[0]) if r else None


def T(r):
    """A response's text with HTML entities read back (an apostrophe in a value comes out as &#39;)."""
    return html.unescape(r.get_data(as_text=True))


def token_of(body):
    return (re.search(r'name="token" value="([0-9a-f]{32})"', body) or [None, ""])[1]


def stage(client, text, name="kpi.csv"):
    r = client.post(URL, data={"csrf_token": "tok", "preview": "1", "file": (io.BytesIO(text.encode()), name)},
                    content_type="multipart/form-data")
    m = re.search(r"check=([0-9a-f]{32})", r.headers.get("Location", ""))
    return r, (m.group(1) if m else "")


def step(client, tok, action, **form):
    return client.post(URL, data=dict({"csrf_token": "tok", "token": tok, "action": action}, **form),
                       follow_redirects=True)


def page(client, tok, st=None):
    return T(client.get(URL + "?check=%s%s" % (tok, ("&step=" + st) if st else "")))


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    PREV = dict(db.execute("SELECT kind, year, half, min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())
    W0 = db.execute("SELECT opens_at, closes_at FROM cycle_windows WHERE cycle_id=? AND cell='pm_hod'",
                    (CID,)).fetchone()

    def _put_back():
        with a.app.app_context():
            d_ = a.get_db()
            _cleanup(d_)
            d_.execute("UPDATE cycles SET kind=?, year=?, half=?, min_job_grade=? WHERE id=?",
                       (PREV["kind"], PREV["year"], PREV["half"], PREV["min_job_grade"], CID))
            d_.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='pm_hod'", (CID,))
            if W0:
                d_.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', "
                           "?, ?)", (CID, W0[0], W0[1]))
            d_.commit()
        for f in set(glob.glob(os.path.join(BK_DIR, "*.db"))) - BK0:
            os.remove(f)
    atexit.register(_put_back)
    db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL WHERE id=?", (CID,))
    db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', "
               "'2099-11-02 00:00', '2099-11-08 23:59')", (CID,))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?),(?,?)", (BG, CO, BG, CO2))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
    for nm, bu in (("ZZKI PAT", 1), ("ZZKI GP", 1), ("ZZKI Sales", 0), ("ZZKI Group PAT", 1)):
        db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, "
                   "category, unit, method, rate1, rate2, rate3, rate4, rate5, weightage_default, bu_level) VALUES "
                   "(?, '*', '*', 0, '*', ?, 'Financial', '%', 'more', 80, 90, 100, 110, 120, 10, ?)", (BG, nm, bu))
    db.execute("INSERT INTO pm_kpi_aliases(business_group, alias_key, alias_name, into_key, into_name, kind) VALUES "
               "(?, 'zzki pat old', 'ZZKI PAT old', 'zzki pat', 'ZZKI PAT', 'dupe')", (BG,))
    U["M"] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                        "company, department, job_grade, confirmation_date) VALUES ('zz9ki-m', 'ZZ KI Manager', 'x', "
                        "'user', 'ZZ9KI-M', ?, ?, 'Management', '21', '2020-01-01')", (BG, CO)).lastrowid
    for eid, co, dept, conf in (("ZZ9KI-A", CO, "Sales", "2020-01-01"), ("ZZ9KI-B", CO, "Sales", "2020-01-01"),
                                ("ZZ9KI-C", CO, "Finance", "2020-01-01"), ("ZZ9KI-D", CO, "Sales", "2020-01-01"),
                                ("ZZ9KI-E", CO, "Sales", "2020-01-01"), ("ZZ9KI-X", CO2, "Sales", "2020-01-01"),
                                ("ZZ9KI-Z", CO, "Sales", None)):
        U[eid[-1]] = db.execute(
            "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
            "department, job_grade, confirmation_date, manager_id) VALUES (?,?, 'x', 'user', ?,?,?,?, '14', ?, ?)",
            (eid.lower(), "ZZ KI " + eid[-1], eid, BG, co, dept, conf, U["M"])).lastrowid
    S1 = db.execute("INSERT INTO pm_bu_kpis(cycle_id, business_group, company, kpi_name, category, unit, method, rate1, "
                    "rate2, rate3, rate4, rate5, carriers, carriers_json, weight_mode, updated_by) VALUES (?,?,?, "
                    "'ZZKI PAT', 'Financial', '%', 'more', 85, 90, 95, 100, 105, 'holders', ?, 'own', ?)",
                    (CID, BG, CO, json.dumps({"people": [a.ja_eid("ZZ9KI-A")]}), SU["id"])).lastrowid
    S2 = db.execute("INSERT INTO pm_bu_kpis(cycle_id, business_group, company, kpi_name, category, unit, method, rate1, "
                    "rate2, rate3, rate4, rate5, carriers, carriers_json, weight_mode, weight, updated_by) VALUES "
                    "(?,?,?, 'ZZKI GP', 'Financial', '%', 'more', 60, 70, 80, 90, 100, 'departments', ?, 'one', 10, ?)",
                    (CID, BG, CO, json.dumps({"departments": ["Sales"]}), SU["id"])).lastrowid

    def put(who, name, w, rates, bu_kpi_id=None):
        return db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, rate1, "
                          "rate2, rate3, rate4, rate5, business_group, company, bu_kpi_id) VALUES (?,?,?,?, 'more', '%', "
                          "?,?,?,?,?, ?,?,?)", (CID, U[who], name, w) + tuple(rates) + (BG, CO, bu_kpi_id)).lastrowid
    put("A", "ZZKI PAT", 30, (85, 90, 95, 100, 105), S1)            # already the unit's BU KPI: left as it is
    T_CS = put("C", "ZZKI Sales", 40, (70, 80, 90, 100, 110))        # moderated: left as it is
    db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, acted_by) VALUES (?, 1, 'confirm', ?)",
               (T_CS, U["M"]))
    ROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZKI role', 'group')").lastrowid
    db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(ROLE, "pm.read"), (ROLE, "pm.kpi_add")])
    BGADM = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                       "admin_bg, admin_role_id) VALUES ('zz9ki-adm', 'ZZ KI Admin', 'x', 'admin', 'ZZ9KI-ADM', ?, ?, ?)",
                       (BG, BG, ROLE)).lastrowid
    db.commit()
SUP = H.client_as(a, SU["id"])
BGA = H.client_as(a, BGADM)
with a.app.test_request_context():
    UNIT = a.display_company(BG, CO)
    UNIT2 = a.display_company(BG, CO2)

FILE = (HEAD
        + line("ZZ9KI-A", "ZZKI Sales", 70)                                       # 2 new
        + line("ZZ9KI-B", "ZZKI PAT", 15, (75, 80, 85, 90, 95))                   # 3 decide: name, B added to holders
        + line("ZZ9KI-C", "ZZKI PAT old", 10, (85, 90, 95, 100, 105))             # 4 decide: a library alias
        + line("ZZ9KI-D", "ZZKI PAT", 10, focus="Plant 2")                        # 5 decide: the same KPI with a Focus
        + line("ZZ9KI-B", "ZZKI GP", 10, (60, 70, 80, 90, 100))                   # 6 decide: Sales is covered
        + line("ZZ9KI-C", "ZZKI GP", 10)                                          # 7 said: Finance isn't covered
        + line("ZZ9KI-X", "ZZKI Group PAT", 20)                                   # 8 BU-level, no unit target
        + line("ZZ9KI-A", "ZZKI PAT", 30, (70, 75, 80, 85, 90))                   # 9 left: the unit's BU KPI
        + line("ZZ9KI-C", "ZZKI Sales", 40, (60, 70, 80, 90, 100))                # 10 left: moderated
        + line("ZZ9KI-Z", "ZZKI Sales", 100)                                      # 11 skipped: not taking part
        + line("ZZ9KI-E", "ZZKI GP", 10)                                          # 12 decide: kept their own
        + line("ZZ9KI-D", "ZZKI Customer visits", 60, unit="RM mil")              # 13 not in the library, a unit
        + line("ZZ9KI-E", "ZZKI Sales", 90))
try:
    s.section("step 1: the file is kept, nothing is written")
    before = n_lines()
    r, TOK = stage(SUP, FILE)
    s.check("choosing the file keeps it and goes to the quality step", r.status_code == 302 and len(TOK) == 32,
            r.headers.get("Location"))
    s.check("...the file is on the server under its token",
            os.path.exists(os.path.join(a.IMPORT_CHECK_DIR, "kpi_targets", TOK + ".bin")))
    s.check("...and nothing is written yet", n_lines() == before, (before, n_lines()))
    b = T(BGA.get(URL + "?check=" + TOK, follow_redirects=True))
    s.check("someone else can't go on with it", "expired, isn't yours" in b and token_of(b) == "")
    b = T(SUP.get(URL))
    s.check("the first step says nothing changes yet and has one button", "Check the file" in b
            and "Nothing changes yet" in b and "1 · File" in b and "4 · Apply" in b)

    s.section("step 2: quality")
    bad = FILE + line("ZZ9KI-NOPE", "ZZKI Sales", 100) + line("ZZ9KI-A", "ZZKI Training", 0)
    _r, TB = stage(SUP, bad, "bad.csv")
    b = page(SUP, TB)
    s.check("a row that can't go in stops it, named by kind and row", "Fix 2 rows before you can go on." in b
            and "Unknown Employee ID" in b and "row 15" in b and "A missing or invalid weight" in b and "row 16" in b, b[:0])
    r = step(SUP, TB, "quality_ok", ack="1")
    s.check("...going on is refused, and nothing is written", "Fix the rows that can't be imported" in
            T(r) and n_lines() == before)
    dl = SUP.get(URL + "/check/%s.xlsx?what=issues" % TB)
    s.check("...every issue downloads as Excel", dl.status_code == 200 and dl.data[:2] == b"PK")
    b = page(SUP, TOK)
    s.check("a clean file shows what's worth a look", "4 · Apply" in b and "worth a look" in b
            and "weights don't add up to 100%" in b and "person isn't taking part" in b and "ZZ9KI-Z: 1 row skipped" in b
            and "units written another way" in b and '"RM mil" is stored as RM (mil)' in b
            and "KPI isn't in the library" in b and '"ZZKI Customer visits"' in b)
    s.check("...and the changes step can't be reached before it's seen", "What it changes in" not in page(SUP, TOK,
                                                                                                          "changes"))
    r = step(SUP, TOK, "quality_ok")
    s.check("going on needs “I've looked at these”", "to go on, or fix them" in T(r))
    r = step(SUP, TOK, "quality_ok", ack="1")
    b = T(r)
    s.check("...with it, the changes step", "What it changes in" in b)

    s.section("step 3: the changes, and the BU KPI matches")
    s.check("lines added, updated, left as they are and skipped are counted",
            "KPI lines to add" in b and "left as they are" in b and "skipped (not taking part)" in b)
    s.check("...a line that follows the unit's BU KPI and a moderated one are left, each said why",
            "It follows the unit's BU KPI setup" in b and "A moderator has already acted on it" in b)
    s.check("matched by name, a library alias and the same KPI with a Focus", "Same name" in b
            and "Library alias of ZZKI PAT" in b and "Same KPI with a Focus" in b)
    s.check("...a unit's rule that doesn't cover the person is said, not asked", "who carries it is set by department"
            in b)
    s.check("...a BU-level KPI whose unit has no target is now offered as a NEW BU KPI for that unit (it was listed apart as info; Part 3, 7 Nov)",
            "a new BU KPI for %s" % UNIT2 in b and 'value="new"' in b)
    s.check("the decisions are the super admin's, six to decide (the five matches and the new BU KPI)", "Super admin decides" in b
            and "Your decisions · 6 lines match" in b and b.count('value="bu"') == 5 and b.count('value="new"') == 1)
    s.check("the final step can't be reached before the decisions", "after you apply this file" not in page(SUP, TOK,
                                                                                                          "apply"))
    with a.app.test_request_context():
        got = a._kti_load(a.get_db(), a.get_db().execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone(),
                          a.active_pm_period(a.get_db()), TOK)
    items = {i["key"]: i for i in got[4]["items"]}
    fid = {k: "d_" + __import__("hashlib").sha1(k.encode()).hexdigest()[:10] for k in items}
    k_b, k_c, k_d = "ZZ9KI-B|ZZKI PAT", "ZZ9KI-C|ZZKI PAT old", "ZZ9KI-D|ZZKI PAT · Plant 2"
    k_bg, k_eg, k_cg = "ZZ9KI-B|ZZKI GP", "ZZ9KI-E|ZZKI GP", "ZZ9KI-C|ZZKI GP"
    k_xg = "ZZ9KI-X|ZZKI Group PAT"   # BU-level in the library, its unit has no setup: a NEW BU KPI is offered (here decided their own)
    s.check("(the match keys)", all(k in items for k in (k_b, k_c, k_d, k_bg, k_eg, k_cg, "ZZ9KI-X|ZZKI Group PAT"))
            and items[k_cg]["why"] == "rule", sorted(items))

    s.section("the decisions are the super admin's alone")
    _r, TA = stage(BGA, FILE, "bga.csv")
    s.check("a BG admin can't import KPI targets at all, whatever their role holds (the super admin's alone, 2026-10-31):"
            " step 1 is refused and nothing is kept", _r.status_code == 403 and not TA and n_lines() == before)

    s.section("deciding, then the final preview")
    r = step(SUP, TOK, "to_apply", **{fid[k_b]: "bu", fid[k_c]: "bu"})
    s.check("going on with some undecided is refused, saying how many", "4 still to decide" in T(r)
            and a._imp_meta("kpi_targets", TOK)["decisions"] == {k_b: "bu", k_c: "bu"})
    r = step(SUP, TOK, "to_apply", **{fid[k_d]: "own", fid[k_bg]: "bu", fid[k_eg]: "own", fid[k_xg]: "own"})
    b = T(r)
    s.check("every one decided: the final preview", "after you apply this file" in b
            and "Apply this file" in b and 'data-confirm-tone="danger"' in b)
    s.check("...each person with the decisions in", ("ZZKI PAT joins %s's BU KPI" % UNIT) in b
            and "ZZKI PAT · Plant 2 stays their own line" in b and "join their unit's BU KPI" in b)
    s.check("...the decisions recapped, with a way back to change them", "Change them" in b
            and "The unit's BU KPI</b>: ZZ KI B" in b)
    dl = SUP.get(URL + "/check/%s.xlsx?what=final" % TOK)
    s.check("...the final preview downloads as Excel", dl.status_code == 200 and dl.data[:2] == b"PK")
    s.check("...and nothing is written yet", n_lines() == before)

    s.section("apply: refused when OneHR moved, or with no backup")
    with a.app.app_context():
        d_ = a.get_db()
        tid_e = d_.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, rate1, "
                           "rate2, rate3, rate4, rate5, business_group, company) VALUES (?,?, 'ZZKI Sales', 10, 'more', "
                           "'%', 1, 2, 3, 4, 5, ?, ?)", (CID, U["E"], BG, CO)).lastrowid
        d_.commit()
    r = step(SUP, TOK, "apply")
    s.check("a line OneHR gained since the changes were seen sends it back to look again",
            "changed since you looked at the changes" in T(r) and not ln("ZZ9KI-B", "ZZKI PAT"))
    with a.app.app_context():
        a.get_db().execute("DELETE FROM pm_kpi_targets WHERE id=?", (tid_e,))
        a.get_db().commit()
    step(SUP, TOK, "to_apply")
    os.environ["L360_IMPORT_BACKUP_DIR"] = "/proc/nowhere/ok"
    r = step(SUP, TOK, "apply")
    del os.environ["L360_IMPORT_BACKUP_DIR"]
    s.check("no backup, nothing applied", "the backup taken before applying failed" in T(r)
            and n_lines() == before)

    s.section("apply")
    r = step(SUP, TOK, "apply")
    b = T(r)
    new_bk = set(glob.glob(os.path.join(BK_DIR, "*.db"))) - BK0
    s.check("a backup of the database is taken first", any(re.search(r"-import-kpi-targets\.db$", f) for f in new_bk),
            new_bk)
    s.check("the done page says what it did", "Applied" in b and "joined their unit's BU KPI" in b
            and "kept their own" in b and "Download what changed" in b)
    s.check("...the kept file is gone once applied",
            not os.path.exists(os.path.join(a.IMPORT_CHECK_DIR, "kpi_targets", TOK + ".bin")))
    dl = SUP.get(URL + "/check/%s.xlsx?what=done" % TOK)
    s.check("...what changed downloads as Excel", dl.status_code == 200 and dl.data[:2] == b"PK")
    tb = ln("ZZ9KI-B", "ZZKI PAT")
    s1 = setup_row("ZZKI PAT")
    s.check("a line decided the unit's BU KPI is linked, with the unit's target and its own weight",
            tb and tb["bu_kpi_id"] == S1 and tb["rate1"] == 85 and tb["rate5"] == 105 and tb["weightage"] == 15, tb)
    s.check("...what the file gave it is kept to go back to", tb and json.loads(tb["bu_prev_json"] or "{}").get("rate1")
            == 75)
    s.check("...and the person joins those who carry it", a.ja_eid("ZZ9KI-B") in json.loads(s1["carriers_json"])["people"]
            and a.ja_eid("ZZ9KI-C") in json.loads(s1["carriers_json"])["people"])
    tc = ln("ZZ9KI-C", "ZZKI PAT")
    s.check("a line under a library alias joins under the unit's name, its own name kept to go back to",
            tc and tc["bu_kpi_id"] == S1 and not ln("ZZ9KI-C", "ZZKI PAT old")
            and json.loads(tc["bu_prev_json"] or "{}").get("kpi_name") == "ZZKI PAT old", tc)
    td = ln("ZZ9KI-D", "ZZKI PAT · Plant 2")
    s.check("a line kept their own stays theirs, marked", td and not td["bu_kpi_id"] and td["bu_keep_own"] == 1, td)
    tbg = ln("ZZ9KI-B", "ZZKI GP")
    s.check("a line covered by the unit's rule joins with the unit's weight", tbg and tbg["bu_kpi_id"] == S2
            and tbg["weightage"] == 10, tbg)
    tcg = ln("ZZ9KI-C", "ZZKI GP")
    s.check("a line the rule doesn't cover goes in as their own", tcg and not tcg["bu_kpi_id"] and not tcg["bu_keep_own"])
    ta = ln("ZZ9KI-A", "ZZKI PAT")
    s.check("the line that follows the unit's BU KPI keeps the unit's target", ta and ta["rate1"] == 85
            and ta["weightage"] == 30)
    s.check("the moderated line keeps its target", ln("ZZ9KI-C", "ZZKI Sales")["rate1"] == 70)
    s.check("the person not taking part gets nothing", not ln("ZZ9KI-Z", "ZZKI Sales"))
    log = H.rows(a, "SELECT detail FROM activity_log WHERE action='pm_kpi_import' ORDER BY id DESC LIMIT 1")[0][0]
    s.check("the audit log names each decision and the backup", "decided by the super admin" in log
            and "ZZ9KI-B ZZKI PAT -> the unit's BU KPI" in log and "ZZ9KI-D ZZKI PAT · Plant 2 -> their own" in log
            and "backup leadership360-" in log, log[-300:])

    s.section("after: BU KPI setup and a kept-own line")
    with a.app.test_request_context():
        d_ = a.get_db()
        sup_u = d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        act = a.active_pm_period(d_)
        e = d_.execute("SELECT * FROM users WHERE id=?", (U["E"],)).fetchone()
        n = a._bu_kpi_apply(d_, sup_u, act, d_.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (S2,)).fetchone(), [e])
        d_.commit()
    te = ln("ZZ9KI-E", "ZZKI GP")
    s.check("BU KPI setup saved again never adopts a line kept their own, nor puts a second beside it",
            n["own"] == 1 and n["held"] == 0 and te and not te["bu_kpi_id"] and H.one(
                a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE subject_id=? AND kpi_name='ZZKI GP'", (U["E"],)) == 1, n)
    with a.app.test_request_context():
        d_ = a.get_db()
        sup_u = d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        people = [d_.execute("SELECT * FROM users WHERE id=?", (U[k],)).fetchone() for k in ("B", "E")]
        n = a._bu_kpi_apply(d_, sup_u, a.active_pm_period(d_),
                            d_.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (S2,)).fetchone(), people, remove=True)
        d_.commit()
    s.check("...and never stops the KPI coming off (nothing held)", n["held"] == 0 and n["returned"] == 1, n)
    with a.app.test_request_context():
        d_ = a.get_db()
        sup_u = d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        a._bu_line_release(d_, sup_u, dict(d_.execute("SELECT * FROM pm_kpi_targets WHERE id=?", (tc["id"],)).fetchone()))
        a._bu_line_release(d_, sup_u, dict(d_.execute("SELECT * FROM pm_kpi_targets WHERE id=?", (tb["id"],)).fetchone()))
        d_.commit()
    s.check("taken off, a joined line goes back to what the file gave it, its name included",
            ln("ZZ9KI-C", "ZZKI PAT old") is not None and ln("ZZ9KI-B", "ZZKI PAT")["rate1"] == 75
            and ln("ZZ9KI-B", "ZZKI PAT")["weightage"] == 15)

    s.section("once the Department Review has started: said, not asked")
    with a.app.app_context():
        a.get_db().execute("UPDATE cycle_windows SET opens_at='2020-01-01 00:00' WHERE cycle_id=? AND cell='pm_hod'",
                           (CID,))
        a.get_db().commit()
    _r, TC = stage(SUP, HEAD + line("ZZ9KI-D", "ZZKI GP", 10) + line("ZZ9KI-D", "ZZKI Sales", 90), "late.csv")
    step(SUP, TC, "quality_ok", ack="1")
    b = page(SUP, TC, "changes")
    s.check("the match is said, BU KPI setup reads only, nothing to decide", "BU KPI setup reads only now." in b
            and 'value="bu"' not in b and "Continue to the final preview" in b)
    r = step(SUP, TC, "to_apply")
    s.check("...and the final step opens with no decision", "after you apply this file" in T(r))
finally:
    sys.exit(s.done())
