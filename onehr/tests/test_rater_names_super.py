"""A 360 rater's name is shown to the super admin only (Chris, 2026-11-11, "Yes, super admin only").

Earlier that day the 360 Responses and Results downloads were masked for every admin but the super admin (Rater N, N from
_rater_order: the SUBMITTED raters by submitted_at, then the assignment id). The same rule now holds on the three screens that
used to name a rater to a holder of People > remarks and raters, or to every in-scope admin. A non-super admin may still see WHO is
on a panel and whether they have submitted (building and chasing a panel needs it), never WHICH rater wrote, answered or scored what:

  1. the person page's 360 tab, remark block ("What their raters wrote", gate people.remarks_files): the super admin as before (named,
     relationship, date); a role holder reads "Rater N" (N as _rater_order gives it), sorted by N, no relationship, no date, and the
     sub-line says "raters by number". The panel list on that tab keeps the names and "Submitted" but drops the date and the Answers
     link (the submission order is what N is numbered by: a named panel with dates would decode the numbers).
  2. the Leadership Principle report (page and HTML download): rater names for the super admin alone; everyone else the count.
  3. the admin 360 result page /admin/subjects/<id>: per-principle comments and the overall remarks are "Rater N" with no name and
     no relationship, the Assessor panel keeps names, relationship and status but has no extremes chip, no score, no date, no
     "View answers", and is not in submission order. The masking is on the server: outside the panel table no rater's name, ID
     or email is anywhere in the HTML.

Self-contained: its own group (ZZRN), two units, a subject, six raters, a BG admin holding people.remarks_files, a BU admin, a
whole-company custom role without and with the item, on the SHARED suite database; the extremes setting and the built-in BG
role's item are put back, everything removed at the end. The model is never called.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A 360 rater's name is the super admin's alone: person page, Leadership Principle report, 360 result page")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BG, CO1, CO2 = "ZZRN Group", "ZZRN Unit One", "ZZRN Unit Two"
PFX = "ZZRN-"
RF = a.RF_ITEM
ROLE_FULL, ROLE_RF = "ZZRN Role Full", "ZZRN Role Remarks"
REL_WORDS = ("Line manager", "Matrix manager", "Peer", "Direct report", "line_manager", "matrix_manager", "direct_report")
KEEP = {}


def cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE ?", (PFX + "%",))]
    if ids:
        ph = ",".join("?" * len(ids))
        aids = [r[0] for r in db.execute("SELECT id FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ids * 2)]
        if aids:
            ap = ",".join("?" * len(aids))
            for t in ("responses", "criterion_comments", "feedback_remarks"):
                db.execute("DELETE FROM %s WHERE assignment_id IN (%s)" % (t, ap), aids)
            db.execute("DELETE FROM assignments WHERE id IN (%s)" % ap, aids)
        db.execute("DELETE FROM admin_companies WHERE admin_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids * 2)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM admin_role_access WHERE role_id IN (SELECT id FROM admin_roles WHERE name LIKE 'ZZRN %')")
    db.execute("DELETE FROM admin_roles WHERE name LIKE 'ZZRN %'")
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def restore(db):
    if "extremes" in KEEP:
        for k, v in KEEP["extremes"].items():
            if v is None:
                db.execute("DELETE FROM app_settings WHERE key=?", (k,))
            else:
                db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?,?)", (k, v))
    if KEEP.get("bg_rf_added"):
        db.execute("DELETE FROM admin_role_access WHERE role_id=(SELECT id FROM admin_roles WHERE builtin='bg') AND item=?", (RF,))
    db.commit()


def get(c, path):
    r = c.get(path)
    return r.status_code, r.get_data(as_text=True)


def region(html, start_pat, end_pat):
    """The text from the first match of start_pat to the next end_pat after it ('' when absent)."""
    m = re.search(start_pat, html)
    if not m:
        return ""
    e = html.find(end_pat, m.end())
    return html[m.start(): e + len(end_pat) if e >= 0 else len(html)]


def strip_tags(x):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", x)).strip()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    cleanup(db)
    CID = a.viewed_cycle_id(db) or a.active_cycle_id(db)
    KEEP["extremes"] = {k: (lambda r: r[0] if r else None)(db.execute("SELECT value FROM app_settings WHERE key=?", (k,)).fetchone())
                        for k in ("extremes_adjust_enabled", "extremes_bonus_points", "extremes_penalty_points")}
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('extremes_adjust_enabled', '1')")
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, CO1))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, CO2))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, name, co=CO1, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=eid.lower() + "@example.test", hod_id=None,
                 manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=co,
                 years_of_service=5, left_at=None, is_demo=0, job_grade="16", role="user", admin_bg=None, admin_role_id=None,
                 confirmation_date="2020-01-01", is_system_admin=0, display_name=None)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]

    S1 = person(PFX + "S1", "ZZ RN Subject Alpha")
    NAMES = (("R1", "Zulu"), ("R2", "Yankee"), ("R3", "Xray"), ("R4", "Whiskey"), ("R5", "Victor"), ("R6", "Uniform"))
    R = {k: person(PFX + k, "ZZ RN Rater " + n) for k, n in NAMES}
    S2 = person(PFX + "S2", "ZZ RN Subject Beta")   # someone the subject rates himself: the "Feedback they give" list
    # roles: the built-in BG and BU admin roles, and a whole-company custom role without and with the remarks item
    ROLE = {r["builtin"]: r["id"] for r in db.execute("SELECT id, builtin FROM admin_roles WHERE builtin IS NOT NULL")}
    KEEP["bg_rf_added"] = db.execute("SELECT 1 FROM admin_role_access WHERE role_id=? AND item=?", (ROLE["bg"], RF)).fetchone() is None
    if KEEP["bg_rf_added"]:   # the built-in BG admin role holds the item by its one-time seed: make sure, put back at the end
        db.execute("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", (ROLE["bg"], RF))
    full = sorted(a.role_preset_items("full"))
    for nm, items in ((ROLE_FULL, full), (ROLE_RF, sorted(set(full + [RF])))):
        db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES (?, 'company')", (nm,))
        rid = db.execute("SELECT id FROM admin_roles WHERE name=?", (nm,)).fetchone()[0]
        ROLE[nm] = rid
        db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(rid, i) for i in items])
    BGA = person(PFX + "BGA", "ZZ RN Admin BG", role="admin", admin_bg=BG, admin_role_id=ROLE["bg"])      # BG admin, holds the item
    BUA = person(PFX + "BUA", "ZZ RN Admin BU", role="admin", admin_bg=BG, admin_role_id=ROLE["bu"])      # BU admin (unit one)
    db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?,?)", (BUA, CO1))
    CRA = person(PFX + "CRA", "ZZ RN Admin Custom", role="admin", admin_bg=a.ADMIN_COMPANY_SCOPE, admin_role_id=ROLE[ROLE_FULL])
    CRH = person(PFX + "CRH", "ZZ RN Admin Holder", role="admin", admin_bg=a.ADMIN_COMPANY_SCOPE, admin_role_id=ROLE[ROLE_RF])
    SU = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL LIMIT 1").fetchone()[0]
    HOLDS = {k: RF in a.admin_role_items(db, v) for k, v in (("bg", ROLE["bg"]), ("bu", ROLE["bu"]), ("cr", ROLE[ROLE_FULL]), ("crh", ROLE[ROLE_RF]))}

    tier = a._cycle_tier_n(db, "16", CID)
    stm = [r[0] for r in db.execute("SELECT id FROM cycle_statements WHERE cycle_id=? AND tier_n=? ORDER BY id LIMIT 3", (CID, tier))]
    assert len(stm) == 3, "the cycle needs three statements of the grade-16 tier"
    crits = [r[0] for r in db.execute("SELECT DISTINCT criterion_id FROM cycle_statements WHERE id IN (%s) ORDER BY criterion_id" % ",".join("?" * 3), stm)]
    CRIT = crits[0]
    # R1 answers Yes to everything (the penalty chip), R2 No to everything (the bonus chip), the rest in a mix
    SIG = {"R1": ("yes", "yes", "yes"), "R2": ("no", "no", "no"), "R3": ("yes", "no", "no"), "R4": ("no", "yes", "no"),
           "R5": ("no", "no", "yes"), "R6": ("yes", "yes", "no")}

    def assign(rater, rel, status, at=None, archived=0):
        aid = db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status, submitted_at, archived) "
                         "VALUES (?,?,?,?,?,?,?)", (CID, S1, R[rater], rel, status, at, archived)).lastrowid
        for sid, ans in zip(stm, SIG[rater]):
            db.execute("INSERT INTO responses(assignment_id, statement_id, answer) VALUES (?,?,?)", (aid, sid, ans))
        return aid
    # assignment ids run R1..R6; they SUBMITTED R2, R4, R1, R6 (R3 pending, R5 archived): submission order is not id order
    A = {}
    A["R1"] = assign("R1", "peer", "submitted", "2026-11-05 10:00:00")
    A["R2"] = assign("R2", "line_manager", "submitted", "2026-11-03 09:00:00")
    A["R3"] = assign("R3", "direct_report", "pending")
    A["R4"] = assign("R4", "matrix_manager", "submitted", "2026-11-04 08:00:00")
    A["R5"] = assign("R5", "peer", "submitted", "2026-11-01 08:00:00", archived=1)
    A["R6"] = assign("R6", "peer", "submitted", "2026-11-06 12:00:00")
    db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status, submitted_at, archived) "
               "VALUES (?,?,?,?,?,?,0)", (CID, S2, S1, "peer", "submitted", "2026-11-07 10:00:00"))
    REMARK = {"R2": "ZZRN overall remark by the first to submit", "R4": "ZZRN overall remark by the second to submit",
              "R1": "ZZRN overall remark by the third to submit", "R6": "ZZRN overall remark by the fourth to submit",
              "R3": "ZZRN DRAFT overall remark", "R5": "ZZRN ARCHIVED overall remark"}
    for k, text in REMARK.items():
        db.execute("INSERT INTO feedback_remarks(assignment_id, remark) VALUES (?,?)", (A[k], text))
    COMMENT = {"R2": "ZZRN principle comment by the first to submit", "R4": "ZZRN principle comment by the second to submit",
               "R1": "ZZRN principle comment by the third to submit", "R3": "ZZRN DRAFT principle comment"}
    for k, text in COMMENT.items():
        db.execute("INSERT INTO criterion_comments(assignment_id, criterion_id, comment) VALUES (?,?,?)", (A[k], CRIT, text))
    db.commit()
    HIDDEN = ("ZZRN DRAFT", "ZZRN ARCHIVED")   # a draft or archived rater's words are in nobody's page

try:
    C = {"su": H.client_as(a, SU), "bg": H.client_as(a, BGA), "bu": H.client_as(a, BUA), "cr": H.client_as(a, CRA),
         "crh": H.client_as(a, CRH)}
    NONSUPER = ("bg", "bu", "cr", "crh")
    WHO = {"bg": "BG admin (holds the item)", "bu": "BU admin", "cr": "custom role (no item)", "crh": "custom role (with the item)"}

    def rows_db(sql, args=()):
        return H.rows(a, sql, args)

    # the rater order from the database alone: SUBMITTED, not archived, by submitted_at then the assignment id
    sub = sorted(rows_db("SELECT id, submitted_at FROM assignments WHERE cycle_id=? AND subject_id=? AND archived=0 "
                         "AND status='submitted'", (CID, S1)), key=lambda r: (r["submitted_at"], r["id"]))
    RANK = {r["id"]: i + 1 for i, r in enumerate(sub)}
    RANK_OF = {k: RANK[v] for k, v in A.items() if v in RANK}   # "R2" -> 1 ...
    with a.app.test_request_context("/"):
        got = a._rater_order(a.get_db(), [S1], CID)[S1]
    s.section("the data: the number is the submission order, not the assignment order")
    s.check("(the roles: BG admin and the 'with item' custom role hold people.remarks_files; the BU admin and the other custom role do not)",
            HOLDS == {"bg": True, "bu": False, "cr": False, "crh": True}, HOLDS)
    s.check("_rater_order matches the database read: four submitted raters, no draft, no archived", got == [r["id"] for r in sub]
            and len(got) == 4, got)
    s.check("...and the assignment ids are NOT in submission order here (else the test could pass by accident)",
            got != sorted(got), got)
    s.check("(the facts: R2 first, R4 second, R1 third, R6 fourth)", (RANK_OF["R2"], RANK_OF["R4"], RANK_OF["R1"], RANK_OF["R6"]) == (1, 2, 3, 4),
            RANK_OF)

    def ident(k):
        """Every string that would name rater k: full name, Employee ID, email."""
        r = rows_db("SELECT full_name, employee_id, email FROM users WHERE id=?", (R[k],))[0]
        return [r["full_name"], r["employee_id"], r["email"]]
    ALL_IDENT = {k: ident(k) for k in R}

    def leaks(text, only=None):
        """[(rater, string)] for every rater identity string found in `text`."""
        return [(k, x) for k, ids in ALL_IDENT.items() if (only is None or k in only) for x in ids if x and x in text]

    # =========================================================================================================== 1. person page
    P1 = "/admin/users/%d?tab=f360" % S1
    s.section("1. the person page's 360 tab: the remark block")
    code, html = get(C["su"], P1)
    blk = region(html, r'<section class="admin-card pp-card pp-rmks"', "</section>") + region(html, r'<details class="fold pp-rmk-fold"', "</details>")
    names = re.findall(r'<div class="pp-rmk-who"><b>([^<]+)</b>', blk)
    s.check("super admin: the remark block names the raters, relationship and date beside each, as before",
            code == 200 and "ZZ RN Rater Yankee" in blk and "Line manager · 3 Nov 2026" in blk and "Matrix manager · 4 Nov 2026" in blk
            and "named for admins only" in blk and "4 of 5 submitted" in blk and len(names) >= 3, (code, names))
    s.check("...every submitted rater with a remark is in it, and no draft or archived rater's remark",
            all(REMARK[k] in blk for k in ("R1", "R2", "R4", "R6")) and not any(h in html for h in HIDDEN))
    sup_panel = region(html, r'aria-label="Their panel"', "</section>")
    s.check("...and the panel list keeps its dates and the Answers links (the super admin's page is unchanged)",
            "Submitted 2026-11-03" in sup_panel and "/responses/%d" % A["R2"] in sup_panel
            and "Submitted 2026-11-07" in region(html, r'aria-label="Feedback they give"', "</section>"))

    def tab_checks(k, url, label):
        code, html = get(C[k], url)
        s.check("%s: the 360 tab opens (200)" % label, code == 200, code)
        blk = region(html, r'<section class="admin-card pp-card pp-rmks"', "</section>")
        if k == "bu" or k == "cr":
            # the role does not hold the item: no remark block at all, and the raters' words are nowhere on the page
            s.check("%s: no item, so no remark block and no rater's remark anywhere" % label,
                    not blk and not any(t in html for t in REMARK.values()), bool(blk))
            return html
        more = region(html, r'<details class="fold pp-rmk-fold"', "</details>")
        whole = blk  # the card holds the fold
        s.check("%s: the block is there (rows > 0)" % label, bool(whole) and "What their raters wrote" in whole and "pp-rmk-who" in whole)
        whos = re.findall(r'<div class="pp-rmk-who"><b>([^<]*)</b>(<span>[^<]*</span>)?', whole)
        labels = [w[0] for w in whos]
        s.check("%s: every row is labelled 'Rater N' (and nothing else: no name, no relationship or date in a <span>)" % label,
                labels and all(re.fullmatch(r"Rater \d+", x) for x in labels) and all(w[1] == "" for w in whos), whos)
        nums = [int(x.split()[1]) for x in labels]
        s.check("%s: sorted by N, and N is the rater's place in the submission order (each remark sits under its own number)" % label,
                nums == sorted(nums) == [1, 2, 3, 4], nums)
        by_text = {}
        for m in re.finditer(r'<div class="pp-rmk-who"><b>(Rater \d+)</b></div>\s*<div class="pp-rmk-body"><p>([^<]*)</p>', whole):
            by_text[m.group(2)] = int(m.group(1).split()[1])
        s.check("%s: each remark carries the N the database gives its rater" % label,
                by_text == {REMARK[k_]: RANK_OF[k_] for k_ in ("R1", "R2", "R4", "R6")}, by_text)
        s.check("%s: only three shown, the rest behind '1 more' (the house fold, as before)" % label,
                "<summary>1 more</summary>" in whole and len(re.findall(r'class="pp-rmk"', whole)) == 4)
        s.check("%s: no rater's name, Employee ID or email in the remark block" % label, not leaks(whole), leaks(whole))
        s.check("%s: no relationship word and no date in the remark block" % label,
                not any(w in whole for w in REL_WORDS) and not re.search(r"\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}", whole),
                strip_tags(whole)[:200])
        s.check("%s: the sub-line says the raters are by number, and no longer 'named for admins only'" % label,
                "4 of 5 submitted · raters by number" in whole and "named for admins only" not in whole, re.findall(r"\d of \d submitted[^<]*", whole))
        s.check("%s: no draft or archived rater's remark" % label, not any(h in html for h in HIDDEN))
        # the panel list: who and whether submitted, no date, no link to a rater's answers
        panel = region(html, r'aria-label="Their panel"', "</section>")
        gives = region(html, r'aria-label="Feedback they give"', "</section>")
        s.check("%s: the panel list still lists the panel (5 live raters: 4 submitted, 1 not) and says Submitted" % label,
                panel.count('class="pp-frow ') >= 5 and "Submitted" in panel and "Not submitted yet" in panel
                and "4 submitted" in panel, panel.count('class="pp-frow '))
        s.check("%s: ...but no submission date and no Answers link (the dates would decode the numbers)" % label,
                not re.search(r"Submitted\s+\d", strip_tags(panel)) and "/responses/" not in panel
                and not re.search(r"\b\d{1,2} (Nov) 2026|2026-11-0\d", strip_tags(panel)), re.findall(r"Submitted[^<]{0,20}", panel))
        s.check("%s: the 'Feedback they give' list is there (one row, Submitted) and carries no date either" % label,
                "ZZ RN Subject Beta" in gives and "Submitted" in gives and not re.search(r"Submitted\s+\d|2026-11-0\d", strip_tags(gives)), strip_tags(gives)[:120])
        return html
    for k in NONSUPER:
        tab_checks(k, P1, WHO[k])
    s.section("1b. the same block in the person page's side panel (the fragment)")
    for k in ("bg", "crh"):
        tab_checks(k, P1 + "&fragment=1", WHO[k] + ", fragment")

    s.section("1c. the item's description no longer promises names")
    with a.app.test_request_context("/"):
        desc = [x[3] for x in a.ADMIN_ITEMS if x[1] == RF][0]
    s.check("the people.remarks_files description says by number and the super admin's names, not 'by name' / 'named'",
            "by number" in desc and "super admin" in desc and "by name" not in desc and "named" not in desc, desc)

    # =========================================================================================================== 2. principles report
    s.section("2. the Leadership Principle report: names for the super admin alone")
    PAYLOAD = re.compile(r'<script id="lp-payload" type="application/json">(.*?)</script>', re.S)

    def pl(resp):
        m = PAYLOAD.search(resp.get_data(as_text=True))
        return json.loads(m.group(1)) if m else None

    PG, EXP = "/admin/reports/principles", "/admin/export/principles.html?cycle=%d" % CID
    for url, what in ((PG, "page"), (EXP, "download")):
        r = C["su"].get(url)
        body = r.get_data(as_text=True)
        rows_ = [x for x in (pl(r) or {"rows": []})["rows"] if x["eid"] == PFX + "S1"]
        s.check("super admin, %s: the subject's row is there with the four submitted raters named (rows > 0 first)" % what,
                r.status_code == 200 and len(rows_) == 1 and rows_[0]["assessorCount"] == 4
                and sorted(rows_[0]["assessors"]) == sorted(ALL_IDENT[k][0] for k in ("R1", "R2", "R4", "R6")),
                (r.status_code, rows_[0]["assessors"] if rows_ else None))
        for k in NONSUPER:
            r = C[k].get(url)
            body = r.get_data(as_text=True)
            p_ = pl(r)
            mine = [x for x in (p_ or {"rows": []})["rows"] if x["eid"] == PFX + "S1"]
            s.check("%s, %s: the subject's row is there with the count (4) and no name in the payload" % (WHO[k], what),
                    r.status_code == 200 and len(mine) == 1 and mine[0]["assessorCount"] == 4 and mine[0]["assessors"] == [],
                    (r.status_code, len(mine)))
            s.check("%s, %s: no rater's name, ID or email anywhere in the HTML (raw body, attributes and script included)" % (WHO[k], what),
                    not leaks(body), leaks(body))

    # =========================================================================================================== 3. subject page
    S_URL = "/admin/subjects/%d" % S1
    s.section("3. the admin 360 result page: the super admin as before")
    code, html = get(C["su"], S_URL)
    table = region(html, r'<table class="admin-table" id="subject-panel-table">', "</table>")
    items = re.findall(r'<div class="feedback-item">\s*<div class="muted small">(.*?)</div>\s*<p>(.*?)</p>', html, re.S)
    s.check("super admin: comments and overall remarks are named with their relationship (rows > 0 first)",
            code == 200 and len(items) == 3 + 4 and any("ZZ RN Rater Yankee" in strip_tags(i[0]) and "Line manager" in strip_tags(i[0]) for i in items),
            (code, len(items)))
    s.check("...the panel table has the Score column, View answers links and both extremes chips (always No / always Yes)",
            "<th" in table and ">Score" in html and "View answers" in table and "Always No · bonus applied" in table
            and "Always Yes · penalty applied" in table and 'data-score="' in table)
    s.check("...and no draft or archived rater's words", not any(h in html for h in HIDDEN))

    def subject_checks(k):
        label = WHO[k]
        code, html = get(C[k], S_URL)
        s.check("%s: the page opens (200)" % label, code == 200, code)
        table = region(html, r'<table class="admin-table" id="subject-panel-table">', "</table>")
        outside = html.replace(table, "") if table else html
        items = re.findall(r'<div class="feedback-item">\s*<div class="muted small">(.*?)</div>\s*<p>(.*?)</p>', html, re.S)
        s.check("%s: the comments and overall remarks are in the page (3 + 4 items: rows > 0)" % label, len(items) == 7, len(items))
        s.check("%s: every comment and remark is labelled 'Rater N' and nothing more (no name, no relationship, no chip)" % label,
                all(re.fullmatch(r"Rater \d+", strip_tags(i[0])) for i in items), [strip_tags(i[0]) for i in items])
        want = {COMMENT[k_]: RANK_OF[k_] for k_ in ("R2", "R4", "R1")}
        want.update({REMARK[k_]: RANK_OF[k_] for k_ in ("R1", "R2", "R4", "R6")})
        got_ = {strip_tags(i[1]): int(strip_tags(i[0]).split()[1]) for i in items}
        s.check("%s: each comment and remark carries the N the database gives its rater (the same N as the downloads)" % label,
                got_ == want, got_)
        comm = [int(strip_tags(i[0]).split()[1]) for i in items[:3]]
        rem = [int(strip_tags(i[0]).split()[1]) for i in items[3:]]
        s.check("%s: per-principle comments run by N, the overall remarks by N" % label, comm == sorted(comm) and rem == sorted(rem) == [1, 2, 3, 4],
                (comm, rem))
        s.check("%s: outside the panel table no rater's name, Employee ID or email is anywhere in the HTML (attributes included)" % label,
                bool(table) and not leaks(outside), leaks(outside))
        s.check("%s: no relationship word beside a remark or comment" % label,
                not any(w in strip_tags(i[0]) for i in items for w in REL_WORDS))
        s.check("%s: no extremes chip, no Always No / Always Yes anywhere" % label,
                "Always No" not in html and "Always Yes" not in html and "bonus applied" not in html and "penalty applied" not in html
                and "status-pending\" title=\"This assessor" not in html)
        s.check("%s: no draft or archived rater's words" % label, not any(h in html for h in HIDDEN))
        # the panel table: still the panel, names / relationship / status, no dates, no score, no answers link
        trs = re.findall(r'<tr class="data-row"[^>]*>', table)
        s.check("%s: the panel table still lists the live panel (5 rows)" % label, len(trs) == 5, len(trs))
        asr = [re.search(r'data-assessor="([^"]*)"', t).group(1) for t in trs]
        order_rel = {"line_manager": 0, "matrix_manager": 1, "peer": 2, "direct_report": 3}
        want_rows = sorted(rows_db("SELECT u.full_name nm, a.relationship rel FROM assignments a JOIN users u ON u.id=a.assessor_id "
                                   "WHERE a.cycle_id=? AND a.subject_id=? AND a.archived=0", (CID, S1)),
                           key=lambda r: (order_rel[r["rel"]], r["nm"]))
        s.check("%s: ...named, by relationship then name (not by when they submitted)" % label, asr == [r["nm"] for r in want_rows], asr)
        s.check("%s: ...with each one's relationship and status (4 Submitted, 1 Pending)" % label,
                table.count("status-reviewed") == 4 and table.count("status-pending") == 1
                and all(w in table for w in ("Line manager", "Matrix manager", "Peer", "Direct report")),
                (table.count("status-reviewed"), table.count("status-pending")))
        s.check("%s: ...and no submission date or time, no score, no View answers link, no data-score" % label,
                not re.search(r"2026-11-0\d", table) and not re.search(r"\b\d{1,2} Nov 2026", table) and "View answers" not in table
                and "/responses/" not in table and "data-score" not in table and "Score" not in table
                and not re.search(r"\d+(\.\d+)? / \d+", strip_tags(table)), strip_tags(table)[:160])
        s.check("%s: the panel completion still reads 4 / 5 submitted" % label, "4 / 5 submitted" in html)
    for k in NONSUPER:
        subject_checks(k)

    s.section("3b. the masking is on the server, one guard at a time (each falsified: the same read with the guard off shows the leak)")
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        sj = d_.execute("SELECT * FROM users WHERE id=?", (S1,)).fetchone()
        ag_n, _ = a.statement_agreement(d_, sj, CID, numbered=True)
        ag_f, _ = a.statement_agreement(d_, sj, CID)
    cn = [c for crit in ag_n for c in crit["comments"]]
    cf = [c for crit in ag_f for c in crit["comments"]]
    s.check("statement_agreement(numbered=True): no key carries a name or relationship, only rater / rank / comment",
            cn and all(set(c) == {"rater", "rank", "comment"} for c in cn), [sorted(c) for c in cn][:1])
    s.check("...falsified: without numbered=True the same comments carry the name and relationship (the guard is the whole difference)",
            cf and all({"assessor_name", "relationship"} <= set(c) for c in cf) and len(cn) == len(cf))

    s.section("4. one rater's named answers (/admin/subjects/<id>/responses/<aid>): the super admin's alone")
    with a.app.test_request_context("/"):
        _aid = a.get_db().execute("SELECT id FROM assignments WHERE subject_id=? AND cycle_id=? AND status='submitted' AND archived=0 "
                                  "ORDER BY id LIMIT 1", (S1, CID)).fetchone()[0]
    _url = "/admin/subjects/%d/responses/%d" % (S1, _aid)
    s.check("the super admin opens a submitted rater's answers (200)", C["su"].get(_url).status_code == 200)
    for k in NONSUPER:
        _r = C[k].get(_url)
        s.check("%s: the same address is refused (403), nothing of the rater in the reply" % k, _r.status_code == 403
                and not any(n and n in _r.get_data(as_text=True) for n in (RATER_NAMES if "RATER_NAMES" in globals() else ())),
                _r.status_code)

finally:
    with a.app.test_request_context("/"):
        d = a.get_db()
        cleanup(d)
        restore(d)

sys.exit(s.done())
