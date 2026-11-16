"""Reactivate brings a person back under Org structure's group name (Chris, 4 Nov 2026).

HR's master files use long business group names ("SIGNATURE GROUP OF COMPANIES"); the roster import maps them to Org
structure's names through BG_IMPORT_ALIASES. Records loaded before that mapping still carry the long name, and when an
admin brought one of those leavers back (Admin > Users > Reactivate) only left_at was cleared, so the person came back
under a group Org structure does not have (the admin Home table showed a stray row with 1 person, 2 Nov).

What this pins, through the REAL admin route with the CSRF token in the form (single Reactivate and Bring several back):
  * a leaver whose group is HR's long name for a group Org structure has comes back under Org structure's name, with
    left_at cleared, and the Reactivate audit row says so (old name, new name); the bulk action counts it
  * the mapping is on the normalised value (case, spaces) and nothing else moves (company, department, grade)
  * the guard, falsified: an unknown string with no alias, a group already in Org structure, and an alias whose target
    is not an ACTIVE Org structure group each stay exactly as they were, with no "business group" words in the audit row
  * the helper _bg_canonical on its own, and that the roster import is untouched (still maps before it writes)
  * the restored-assignment count is still what _reactivate_user returns

Synthetic people only (ZZRB-...), synthetic org_units rows; everything put back at the end. IDs and counts only.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
assert "onehr-tests" in a.DB_PATH, "REFUSING TO RUN: not the scratch copy (%s)" % a.DB_PATH
s = H.Suite("Reactivate -- a returning person takes Org structure's group name, not HR's old long name")

LONG = "SIGNATURE GROUP OF COMPANIES"                  # a real alias key (BG_IMPORT_ALIASES)
CANON = "SIGNATURE INTERNATIONAL BERHAD"               # what Org structure calls it
CO = "ZZRB Test Sdn Bhd"
ORG_BG = "ZZRB Org Group"                              # a group Org structure has (synthetic)
NOT_ORG = "ZZRB Not In Org Structure"                  # no alias, not in Org structure
ALIAS_NOT_ACTIVE = "ZZRB Long Name Two"                # test alias -> a group that exists only as an INACTIVE row
ALIAS_MISSING = "ZZRB Long Name Three"                 # test alias -> a group Org structure has no row for at all
INACTIVE_BG = "ZZRB Inactive Target"
MISSING_BG = "ZZRB Target Nobody Has"
TEST_ALIASES = {ALIAS_NOT_ACTIVE.lower(): INACTIVE_BG, ALIAS_MISSING.lower(): MISSING_BG}


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZRB-%' OR username LIKE 'zzrb-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
    db.execute("DELETE FROM org_units WHERE company=? OR business_group LIKE 'ZZRB %'", (CO,))
    db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZRB-%' OR username LIKE 'zzrb-%'")
    db.commit()


for _k in TEST_ALIASES:
    a.BG_IMPORT_ALIASES.pop(_k, None)
with a.app.test_request_context("/"):
    db = a.get_db()
    _cleanup(db)   # a run that died half-way
    CID = a.active_cycle_id(db)
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "AND COALESCE(is_system_admin,0)=0 LIMIT 1").fetchone()[0]
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, bg, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ RB " + eid, email=None, hod_id=None,
                 manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=bg, company=CO,
                 department="ZZRB Dept", left_at="2026-01-01 00:00:00", is_demo=0, role="user", admin_bg=None,
                 is_system_admin=0, job_grade=15, confirmation_date="2020-01-01")
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]
    # Org structure: the target of the real alias gets one of our own units (so it is an active group whatever the copy
    # held), one synthetic active group, and one group that exists only as an inactive row
    db.execute("INSERT INTO org_units(business_group, company, active) VALUES (?,?,1)", (CANON, CO))
    db.execute("INSERT INTO org_units(business_group, company, active) VALUES (?,?,1)", (ORG_BG, CO))
    db.execute("INSERT INTO org_units(business_group, company, active) VALUES (?,?,0)", (INACTIVE_BG, CO))
    a.BG_IMPORT_ALIASES.update(TEST_ALIASES)
    P_LONG = person("ZZRB-1", LONG)
    P_SPACED = person("ZZRB-2", "  signature group of COMPANIES ")
    P_UNKNOWN = person("ZZRB-3", NOT_ORG)
    P_ORG = person("ZZRB-4", ORG_BG)
    P_INACT = person("ZZRB-5", ALIAS_NOT_ACTIVE)
    P_MISS = person("ZZRB-6", ALIAS_MISSING)
    P_BULK_LONG = person("ZZRB-7", LONG)
    P_BULK_ORG = person("ZZRB-8", ORG_BG)
    P_DIRECT = person("ZZRB-9", LONG)
    P_CANON = person("ZZRB-10", CANON)
    # one archived-for-leaving assignment, to see the restored count still comes back
    other = db.execute("SELECT id FROM users WHERE id!=? AND left_at IS NULL AND role!='admin' LIMIT 1",
                       (P_DIRECT,)).fetchone()[0]
    db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status, archived, "
               "archived_at, archive_reason) VALUES (?,?,?,'peer','pending',1,datetime('now'),'left')",
               (CID, P_DIRECT, other))
    db.commit()
    ACTIVE_ORG = set(a.org_bgs(db))


def row(uid):
    return H.rows(a, "SELECT business_group, company, department, job_grade, left_at FROM users WHERE id=?", (uid,))[0]


def last_log(uid):
    r = H.rows(a, "SELECT detail FROM activity_log WHERE action='reactivate' AND target_user_id=? ORDER BY id DESC "
                  "LIMIT 1", (uid,))
    return (r[0][0] or "") if r else ""


def log_count(action, uid=None):
    q, args = "SELECT COUNT(*) FROM activity_log WHERE action=?", [action]
    if uid is not None:
        q, args = q + " AND target_user_id=?", args + [uid]
    return H.one(a, q, tuple(args))


sup = H.client_as(a, SUP)
try:
    s.section("the data this suite builds is what it says it is")
    s.check("the real alias still points at Org structure's name, and that name is an active group here",
            a.BG_IMPORT_ALIASES.get(LONG.lower()) == CANON and CANON in ACTIVE_ORG)
    s.check("the guard cases hold: the unknown string and the alias targets are NOT active Org structure groups",
            NOT_ORG not in ACTIVE_ORG and INACTIVE_BG not in ACTIVE_ORG and MISSING_BG not in ACTIVE_ORG
            and ORG_BG in ACTIVE_ORG)
    s.check("every test leaver starts as left", all(row(u)[4] for u in (
        P_LONG, P_SPACED, P_UNKNOWN, P_ORG, P_INACT, P_MISS, P_BULK_LONG, P_BULK_ORG, P_DIRECT, P_CANON)))

    # -----------------------------------------------------------------------
    s.section("the helper")
    with a.app.test_request_context("/"):
        d = a.get_db()
        _bgc = getattr(a, "_bg_canonical", lambda db_, x: "(no helper)")   # old code: the checks fail, the suite goes on
        s.check("_bg_canonical: HR's long name -> Org structure's name; spacing and case do not matter",
                _bgc(d, LONG) == CANON and _bgc(d, "  signature GROUP of companies ") == CANON)
        s.check("_bg_canonical: a group Org structure has, an unknown string, an inactive-only or missing target, "
                "None and blank all come back unchanged",
                all(_bgc(d, x) == x for x in (CANON, ORG_BG, NOT_ORG, ALIAS_NOT_ACTIVE, ALIAS_MISSING, "",
                                                          None)))

    # -----------------------------------------------------------------------
    s.section("Reactivate (one person) on the real route")
    before = row(P_LONG)
    r = sup.post("/admin/users", data={"csrf_token": "tok", "action": "reactivate", "user_id": str(P_LONG)})
    now = row(P_LONG)
    s.check("the route answered and the person is back (left_at cleared)", r.status_code in (200, 302)
            and before[4] and now[4] is None, (r.status_code, before[4], now[4]))
    s.check("...under Org structure's name, not HR's long name", now[0] == CANON, (before[0], now[0]))
    s.check("...nothing else about them moved (company, department, grade)", now[1:4] == before[1:4])
    lg = last_log(P_LONG)
    s.check("the Reactivate audit row names the change: old name, new name, 'Org structure'",
            "business group" in lg and LONG in lg and CANON in lg and "Org structure" in lg, lg)
    s.check("...and it is ONE row for the person, not a second one", log_count("reactivate", P_LONG) == 1)
    s.check("the person's group is now one Org structure has", row(P_LONG)[0] in ACTIVE_ORG)

    sup.post("/admin/users", data={"csrf_token": "tok", "action": "reactivate", "user_id": str(P_SPACED)})
    s.check("a long name with stray spaces and case maps too", row(P_SPACED)[0] == CANON and row(P_SPACED)[4] is None,
            row(P_SPACED)[0] == CANON)
    s.check("...and its audit row names the change", "business group" in last_log(P_SPACED) and CANON in last_log(P_SPACED))

    # -----------------------------------------------------------------------
    s.section("the guard, falsified: these stay exactly as they were")
    for label, uid, bg in (("an unknown string with no alias", P_UNKNOWN, NOT_ORG),
                           ("a group already in Org structure", P_ORG, ORG_BG),
                           ("a canonical name already (the roster's own mapping)", P_CANON, CANON),
                           ("an alias whose target is only an INACTIVE Org structure group", P_INACT, ALIAS_NOT_ACTIVE),
                           ("an alias whose target Org structure has no row for", P_MISS, ALIAS_MISSING)):
        before = row(uid)
        sup.post("/admin/users", data={"csrf_token": "tok", "action": "reactivate", "user_id": str(uid)})
        now = row(uid)
        s.check("%s: back, group unchanged, no change in the audit row" % label,
                before[4] and now[4] is None and now[0] == bg and now[1:4] == before[1:4]
                and "business group" not in last_log(uid) and last_log(uid).endswith("reactivated"),
                (now[0] == bg, last_log(uid)[-40:]))

    # -----------------------------------------------------------------------
    s.section("Bring several back (bulk) on the real route")
    n0 = log_count("bulk_reactivate")
    sup.post("/admin/users", data={"csrf_token": "tok", "action": "bulk_reactivate",
                                   "user_id": [str(P_BULK_LONG), str(P_BULK_ORG)]})
    s.check("both are back", row(P_BULK_LONG)[4] is None and row(P_BULK_ORG)[4] is None)
    s.check("the long-name one takes Org structure's name; the one already in Org structure stays",
            row(P_BULK_LONG)[0] == CANON and row(P_BULK_ORG)[0] == ORG_BG, (row(P_BULK_LONG)[0] == CANON,))
    bl = H.rows(a, "SELECT detail FROM activity_log WHERE action='bulk_reactivate' ORDER BY id DESC LIMIT 1")[0][0]
    s.check("the bulk audit row counts the group changes (one, here), and is still one row",
            log_count("bulk_reactivate") == n0 + 1 and "1 business group" in bl and "Org structure" in bl, bl)
    # restore the bulk row we added, so the suite leaves no audit trail of its own
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("DELETE FROM activity_log WHERE id=(SELECT MAX(id) FROM activity_log WHERE action='bulk_reactivate') "
                  "AND detail LIKE '%business group%'")
        d.commit()

    # -----------------------------------------------------------------------
    s.section("_reactivate_user itself: signature and return value kept, group set in the same step")
    with a.app.test_request_context("/"):
        d = a.get_db()
        n = a._reactivate_user(d, CID, P_DIRECT)
        d.commit()
    now = row(P_DIRECT)
    s.check("it returns the restored-assignment count (1) and clears left_at", n == 1 and now[4] is None, n)
    s.check("...and sets Org structure's name in the same call", now[0] == CANON, now[0] == CANON)
    s.check("the archived assignment is restored", H.one(
        a, "SELECT COUNT(*) FROM assignments WHERE subject_id=? AND archived=0 AND archive_reason IS NULL",
        (P_DIRECT,)) == 1)

    # -----------------------------------------------------------------------
    s.section("every reactivation path goes through the helper")
    src = H.source(a)
    s.check("the roster import still maps the group itself before it writes (left alone)",
            "BG_IMPORT_ALIASES" in src and src.count("_reactivate_user(db,") - 1 == 3)   # minus the def line: 3 callers
    s.check("no admin path clears left_at without _reactivate_user: the only 'left_at=NULL' writers are the helper "
            "and the roster import's upsert, which maps its group",
            src.count("left_at=NULL") == 2)
finally:
    with a.app.test_request_context("/"):   # put the shared suite database back as this suite found it
        db = a.get_db()
        _cleanup(db)
        for _k in TEST_ALIASES:
            a.BG_IMPORT_ALIASES.pop(_k, None)
        s.check("everything this suite built is gone (people, org rows, audit rows, test aliases)",
                db.execute("SELECT (SELECT COUNT(*) FROM users WHERE employee_id LIKE 'ZZRB-%') + "
                           "(SELECT COUNT(*) FROM org_units WHERE business_group LIKE 'ZZRB %' OR company=?)",
                           (CO,)).fetchone()[0] == 0 and not any(k in a.BG_IMPORT_ALIASES for k in TEST_ALIASES))
sys.exit(s.done())
