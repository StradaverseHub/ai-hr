"""Save on Fill BU KPI writes only the lines whose result changes (Chris, 2026-11-09; the open "small known bug": Save rewrote every
line, unchanged ones too).

What this suite holds (synthetic ZZ9BU-* people on a fresh scratch database; the suite puts back what it changes):
  * a fill with one new line and four lines that already hold the same figure and remark writes ONE result row: the four keep their
    row untouched (who and when they were filled stay), get no audit row, no rating-record rebuild, no redo email, and their
    people are not asked of the AI pre-run; the one audit row for the fill counts 1 filled and says 4 were left as they were
  * a fill where nothing changes writes nothing: no result row moves, no audit row, no pre-run, and the flash says why
  * one changed line among unchanged ones (the figure of one differs): only that line is rewritten
  * the remark counts: the same figure with a different remark rewrites every line; a missing remark is the same as no remark
    (absent is not a different figure)
  * a hidden draft of the person, and the person's own final result, are still overwritten by a fill at the same figure (they are
    not Group People's fill, so the fill changes them)
  * a line a moderator acted on is replaced (2026-11-13, see test_bu_fill_moderated); a released person's moderated line is skipped and counted
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Fill BU KPI: a Save writes only the lines that changed")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA0, _EMP = H.actors(a)
PFX, BG, CO = "ZZ9BU-", "ZZBU Group", "ZZBU Unit"
REV = "ZZBU Revenue"
U = {}
db = sqlite3.connect(a.DB_PATH, timeout=5.0)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")
URL = "/admin/performance/bu-fill"
OLD = "2026-01-01 00:00:00"

SEEN_PRERUN, SEEN_RECORD, SEEN_REDO = [], [], []
_REAL_PRERUN, _REAL_RECORD, _REAL_REDO = a._prerun_on_event, a._rating_record_refresh, a._redo_collect
a._prerun_on_event = lambda db_, cid_, ids_, ev_: (SEEN_PRERUN.append((ev_, tuple(sorted(ids_)))), _REAL_PRERUN(db_, cid_, ids_, ev_))[1]
a._rating_record_refresh = lambda *x, **k: (SEEN_RECORD.append(x[2:3]), _REAL_RECORD(*x, **k))[1]
a._redo_collect = lambda *x, **k: (SEEN_REDO.append(1), _REAL_REDO(*x, **k))[1]


def one(sql, args=()):
    r = db.execute(sql, args).fetchone()
    return r[0] if r else None


def mk(k):
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, job_grade, "
        "job_title, confirmation_date, email) VALUES (?,?, 'x', 'user', ?,?,?, 'ZZBU Dept', '15', 'Clerk', '2020-01-01', ?)",
        ((PFX + k).lower(), "ZZ BU " + k, PFX + k, BG, CO, "zzbu.%s@example.test" % k.lower())).lastrowid


with a.app.test_request_context("/"):
    CID = a.active_cycle_id(a.get_db())
PREV = dict(db.execute("SELECT kind, year, half, min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())
db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL WHERE id=?", (CID,))
db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', '2099-11-02 00:00', '2099-11-08 23:59')", (CID,))
db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
db.execute("INSERT OR REPLACE INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'B', 'base')", (BG,))
LIB = db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, unit, method, "
                 "weightage_default, bu_level) VALUES (?, '*', '*', 0, '*', ?, 'Financial · Profitability', '%', 'more', 30, 1)", (BG, REV)).lastrowid
SID = db.execute("INSERT INTO pm_bu_kpis(cycle_id, business_group, company, library_id, kpi_name, unit, method, threshold, target, multiple, carriers, "
                 "carriers_json, weight_mode, updated_by) VALUES (?,?,?,?,?, '%', 'more', 0,100,100, 'holders', '{}', 'own', ?)",
                 (CID, BG, CO, LIB, REV, SU["id"])).lastrowid
T = {}
for k in ("N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8"):
    U[k] = mk(k)
    T[k] = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, threshold, target, multiple, "
                      "business_group, company, bu_kpi_id) VALUES (?,?,?,20,'more','%','Own',0,100,100,?,?,?)",
                      (CID, U[k], REV, BG, CO, SID)).lastrowid
db.commit()
SUC = H.client_as(a, SU["id"])


def fill(value, note="", reason="ZZ audited figure"):
    r = SUC.post(URL, follow_redirects=True, data={"csrf_token": "tok", "business_group": BG, "company": CO, "kpi_name": REV,
                                                    "actual_value": str(value), "note": note, "reason": reason})
    import html as _h
    import re
    return " ".join(_h.unescape(re.sub(r"<[^>]+>", " ", r.get_data(as_text=True))).split())


def res(k):
    r = db.execute("SELECT id, actual_value, note, submitted_by, submitted_at, admin_filled, draft FROM pm_kpi_results WHERE kpi_target_id=?",
                   (T[k],)).fetchone()
    return dict(r) if r else None


def audits():
    return one("SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_fill' AND user_id=?", (SU["id"],))


def reset_seen():
    SEEN_PRERUN.clear()
    SEEN_RECORD.clear()
    SEEN_REDO.clear()


def cleanup():
    d = sqlite3.connect(a.DB_PATH, timeout=5.0)
    d.execute("PRAGMA foreign_keys=OFF")
    ids = [r[0] for r in d.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9BU-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        tl = [r[0] for r in d.execute("SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)]
        if tl:
            pt = ",".join("?" * len(tl))
            d.execute("DELETE FROM pm_kpi_approvals WHERE kpi_target_id IN (%s)" % pt, tl)
            d.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (%s)" % pt, tl)
        d.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)
        d.execute("DELETE FROM rating_records WHERE subject_id IN (%s)" % ph, ids)
        d.execute("DELETE FROM result_releases WHERE subject_id IN (%s)" % ph, ids)
        d.execute("DELETE FROM lm_handover_archive WHERE subject_id IN (%s)" % ph, ids)
        d.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        d.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    d.execute("DELETE FROM pm_bu_kpis WHERE business_group=?", (BG,))
    d.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    d.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    d.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    d.execute("DELETE FROM activity_log WHERE action='pm_bu_fill' AND detail LIKE '%ZZBU%'")
    d.execute("UPDATE cycles SET kind=?, year=?, half=?, min_job_grade=? WHERE id=?", (PREV["kind"], PREV["year"], PREV["half"], PREV["min_job_grade"], CID))
    d.commit()
    d.close()


try:
    # ---- the first fill: four lines, then a fifth joins
    s.section("one new line among four that already hold the figure")
    t1 = fill(104, "Audited, Q3")
    s.check("(set-up) the first fill wrote all eight", "Filled 8 of 8 matching" in t1, "")
    db.execute("UPDATE pm_kpi_results SET submitted_at=?", (OLD,))   # an old fill date: a rewrite would move it
    # make four lines "new": take their result away (a person added later reads as having none)
    for k in ("N5", "N6", "N7", "N8"):
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id=?", (T[k],))
    db.commit()
    before = {k: res(k) for k in ("N1", "N2", "N3", "N4")}
    n_aud = audits()
    reset_seen()
    t2 = fill(104, "Audited, Q3")
    s.check("the fill reports 4 filled of 8 and says 4 already held the figure", "Filled 4 of 8 matching" in t2 and "4 already held that figure" in t2, t2[:300])
    s.check("the four unchanged lines' result rows are exactly as they were (no UPDATE: id, who and the old date stay)",
            all(res(k) == before[k] for k in before), [res(k) for k in before][:1])
    s.check("the four new lines hold the figure now, admin-filled and final",
            all(res(k) and res(k)["actual_value"] == 104 and res(k)["admin_filled"] == 1 and res(k)["draft"] == 0 for k in ("N5", "N6", "N7", "N8")))
    s.check("one audit row for the fill, counting 4 filled and 4 left as they were",
            audits() == n_aud + 1 and one("SELECT detail FROM activity_log WHERE action='pm_bu_fill' ORDER BY id DESC LIMIT 1").find("filled 4,") >= 0
            and "4 already held this figure" in one("SELECT detail FROM activity_log WHERE action='pm_bu_fill' ORDER BY id DESC LIMIT 1"))
    asked = {i for _ev, ids in SEEN_PRERUN for i in ids}
    s.check("the AI pre-run was asked once, for the four new lines' people only", len(SEEN_PRERUN) == 1
            and asked == {U[k] for k in ("N5", "N6", "N7", "N8")}, SEEN_PRERUN)
    s.check("no redo email collected and no rating record rebuilt for the unchanged lines", not SEEN_REDO
            and not any(set(ids or ()) & {U[k] for k in before} for ids in [x[0] for x in SEEN_RECORD if x]), (SEEN_REDO, SEEN_RECORD))

    # ---- nothing changes
    s.section("nothing changes: nothing is written")
    snap = {k: res(k) for k in T}
    n_aud = audits()
    reset_seen()
    t3 = fill(104, "Audited, Q3")
    s.check("the flash says 0 filled and 8 already held the figure", "Filled 0 of 8 matching" in t3 and "8 already held that figure" in t3, t3[:300])
    s.check("no result row moved", all(res(k) == snap[k] for k in T))
    s.check("no audit row, no pre-run, no redo, no record rebuilt", audits() == n_aud and not SEEN_PRERUN and not SEEN_REDO and not SEEN_RECORD,
            (audits() - n_aud, SEEN_PRERUN, SEEN_REDO, SEEN_RECORD))

    # ---- one changed line among unchanged
    s.section("one changed line among unchanged ones")
    db.execute("UPDATE pm_kpi_results SET actual_value=100 WHERE kpi_target_id=?", (T["N3"],))
    db.commit()
    snap = {k: res(k) for k in T}
    reset_seen()
    t4 = fill(104, "Audited, Q3")
    s.check("only that line is written (1 of 8) and 7 are left", "Filled 1 of 8 matching" in t4 and "7 already held that figure" in t4, t4[:300])
    s.check("N3 holds 104 now, every other row is as it was", res("N3")["actual_value"] == 104 and all(res(k) == snap[k] for k in T if k != "N3"))
    s.check("the pre-run was asked for N3's person alone", [ids for _e, ids in SEEN_PRERUN] == [(U["N3"],)], SEEN_PRERUN)

    # ---- the remark counts
    s.section("the remark counts, a missing remark is no remark")
    snap = {k: res(k) for k in T}
    t5 = fill(104, "Restated remark")
    s.check("the same figure with a different remark rewrites every line (8 of 8)", "Filled 8 of 8 matching" in t5
            and all(res(k)["note"] == "Restated remark" for k in T), t5[:200])
    db.execute("UPDATE pm_kpi_results SET note=NULL")   # a stored NULL note
    db.commit()
    snap = {k: res(k) for k in T}
    t6 = fill(104, "")
    s.check("a blank remark against a stored NULL note is no change: nothing written", "Filled 0 of 8 matching" in t6 and all(res(k) == snap[k] for k in T), t6[:200])
    db.execute("UPDATE pm_kpi_results SET note='   ' WHERE kpi_target_id=?", (T["N1"],))   # whitespace only
    db.commit()
    t6b = fill(104, "")
    s.check("a blank-only stored note reads as no note too", "Filled 0 of 8 matching" in t6b, t6b[:200])

    # ---- a person's own result and a hidden draft are still written
    s.section("a person's own result and a hidden draft are not Group People's fill")
    db.execute("UPDATE pm_kpi_results SET admin_filled=0, note=NULL, submitted_by=? WHERE kpi_target_id=?", (U["N4"], T["N4"]))   # their own final entry, same figure
    db.execute("UPDATE pm_kpi_results SET draft=1, admin_filled=0, submitted_by=? WHERE kpi_target_id=?", (U["N5"], T["N5"]))      # their own draft, same figure
    db.commit()
    reset_seen()
    t7 = fill(104, "")
    s.check("both are written by a fill at the same figure (2 of 8), the other six left", "Filled 2 of 8 matching" in t7 and "6 already held that figure" in t7, t7[:300])
    s.check("N4 and N5 are Group People's final fill now", all(res(k)["admin_filled"] == 1 and res(k)["draft"] == 0 and res(k)["submitted_by"] == SU["id"] for k in ("N4", "N5")))

    # ---- a moderated line is replaced (2026-11-13); a calibrated person's is skipped and counted
    s.section("a moderated line is replaced; a released person's moderated line is skipped")
    db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id=?", (T["N8"],))
    db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, acted_by) VALUES (?, 1, 'confirm', ?)", (T["N8"], U["N1"]))
    db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id=?", (T["N7"],))
    db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, acted_by) VALUES (?, 1, 'confirm', ?)", (T["N7"], U["N1"]))
    db.execute("INSERT OR REPLACE INTO result_releases(cycle_id, subject_id, kind, released_by) VALUES (?,?, 'pm', ?)", (CID, U["N7"], SU["id"]))
    db.commit()
    t8 = fill(105, "New figure")
    s.check("a fill at a new figure writes the others and the moderated N8, and skips the released N7",
            "Filled 7 of 8 matching" in t8 and "1 skipped" in t8 and res("N8") is not None and res("N8")["actual_value"] == 105 and res("N7") is None, t8[:300])
    s.check("N8's approval is gone, N7's stays", one("SELECT COUNT(*) FROM pm_kpi_approvals WHERE kpi_target_id=?", (T["N8"],)) == 0
            and one("SELECT COUNT(*) FROM pm_kpi_approvals WHERE kpi_target_id=?", (T["N7"],)) == 1)

    # ---- falsified: the guard is what holds the four rows
    s.section("the guard is in the source")
    src = open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read()
    s.check("the apply loop skips a line that already holds the figure", "unchanged += 1" in src and "already held this figure" in src)
finally:
    a._prerun_on_event, a._rating_record_refresh, a._redo_collect = _REAL_PRERUN, _REAL_RECORD, _REAL_REDO
    db.close()
    cleanup()

sys.exit(s.done())
