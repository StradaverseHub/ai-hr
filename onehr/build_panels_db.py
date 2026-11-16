"""Build assessor panels for the ACTIVE cycle, sourced from the live DB.

Reuses the agreed rules in build_assignments.build_panels_capped (Chris, 2026-10-20: nobody rates more than 4
people; the line manager first, then direct reports, then peers in the same BG / BU / department, the same BU's other
departments last; JG 'H' is on no panel at all, Grade H Appraisal 2026-10-28; confirmed people are SUBJECTS, but ANY
active staff member may be an ASSESSOR) — but sources people from
the database (the authoritative roster after import) and writes assignments WITH
cycle_id into the active cycle. No password hashing, so it's fast and safe to run
as a one-off.

    python3 build_panels_db.py            # PREVIEW: stats only, no writes
    python3 build_panels_db.py --apply    # build panels into the active cycle
    python3 build_panels_db.py --db PATH  # target a specific DB file

Confirmed = confirmation_date present OR years_of_service > 1; leavers
(left_at set) are excluded entirely. Re-running --apply rebuilds the active
cycle's panels (DELETE + INSERT) — only do that before any assessor has started.
"""
import argparse
import os
import sqlite3

import build_assignments as ba  # reuse build_panels + to_int_grade + rules/constants

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "leadership360.db")


def load_people(db, min_grade=None):
    """Active (non-leaver) non-admin users as engine-compatible person dicts,
    with managers resolved via manager_id.

    min_grade: the cycle's minimum job grade (2026-10-14). Anyone below it -- a letter grade counts as below -- is
    left out of the roster entirely, so they are never a subject, a line manager, a direct report or a peer on any
    panel. Someone whose line manager is below it is built with no manager (the same note as no manager on file).
    Grade H (job grade 'H') is always left out, floor or not: it is on Grade H Appraisal, never on a 360 (2026-10-28)."""
    rows = db.execute(
        "SELECT id, employee_id, full_name, business_group, company, department, "
        "job_grade, years_of_service, confirmation_date, joined_date, manager_id "
        "FROM users WHERE role!='admin' AND left_at IS NULL AND employee_id IS NOT NULL "
        "AND is_demo=0"
    ).fetchall()
    people, id2eid = {}, {}
    for r in rows:
        if ba.is_grade_h(r["job_grade"]):   # Grade H is on Grade H Appraisal, never on a 360 panel, whatever the cycle's floor (2026-10-28)
            continue
        if min_grade is not None:
            g = r["job_grade"]
            gn = (int(g) if isinstance(g, (int, float)) and not isinstance(g, bool)
                  else (int(str(g).strip()) if str(g or "").strip().isdigit() else None))
            if gn is None or gn < min_grade:
                continue
        eid = str(r["employee_id"]).strip()
        svc = float(r["years_of_service"]) if r["years_of_service"] is not None else 0.0
        conf = r["confirmation_date"]
        confirmed = bool((conf and str(conf).strip()) or svc > 1.0)
        people[eid] = {
            "eid": eid, "name": r["full_name"] or "",
            "business_group": r["business_group"] or "", "company": r["company"] or "",
            "department": r["department"] or "", "grade": ba.to_int_grade(r["job_grade"]),
            "service": svc, "joined": r["joined_date"], "confirmed": confirmed,
            "manager_name": "", "manager": None, "_mid": r["manager_id"],
        }
        id2eid[r["id"]] = eid
    for p in people.values():
        m = people.get(id2eid.get(p["_mid"])) if p["_mid"] else None
        if m and m["eid"] != p["eid"]:
            p["manager"] = m
    return people


def prior_cycle(db, cyc):
    """The cycle whose panels come first (Chris, 2026-10-21: "can we prioritize on the mid year panel"): for a Year-End,
    the same year's Mid-Year when it has panels; else None."""
    keys = cyc.keys()
    if "half" not in keys or cyc["half"] != 2 or "year" not in keys or cyc["year"] is None:
        return None
    return db.execute("SELECT c.* FROM cycles c WHERE c.year=? AND c.half=1 AND c.id!=? AND EXISTS (SELECT 1 FROM "
                      "assignments a WHERE a.cycle_id=c.id AND a.archived=0) ORDER BY c.id DESC LIMIT 1",
                      (cyc["year"], cyc["id"])).fetchone()


def load_prior(db, cyc):
    """{subject employee ID: {assessor employee ID: relationship}}: every active row of prior_cycle(cyc), in one
    query; {} when there's none."""
    ref = prior_cycle(db, cyc)
    if ref is None:
        return {}
    out = {}
    for s_, a_, rel in db.execute(
            "SELECT su.employee_id, au.employee_id, a.relationship FROM assignments a JOIN users su ON su.id=a.subject_id "
            "JOIN users au ON au.id=a.assessor_id WHERE a.cycle_id=? AND a.archived=0 AND su.employee_id IS NOT NULL "
            "AND au.employee_id IS NOT NULL", (ref["id"],)):
        out.setdefault(str(s_).strip(), {})[str(a_).strip()] = rel
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write panels into the active cycle")
    ap.add_argument("--db", default=DB_PATH)
    args = ap.parse_args()

    db = sqlite3.connect(args.db)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    cyc = db.execute("SELECT * FROM cycles WHERE is_active=1").fetchone()
    if not cyc:
        raise SystemExit("No active cycle found.")

    people = load_people(db, cyc["min_job_grade"] if "min_job_grade" in cyc.keys() else None)
    # the capped rule (Chris, 2026-10-20), the same engine as the in-app build: nobody rates more than ASSESSOR_CAP
    # the target panel size: the cycle's own, else the default (app.py's effective_panel_size); No maximum (a cycle's 0
    # or the default's "none") turns the build off (Chris, 2026-10-23)
    own_ps = cyc["panel_size"] if "panel_size" in cyc.keys() else None
    if own_ps is None:
        row = db.execute("SELECT value FROM app_settings WHERE key='panel_size'").fetchone()
        v = str(row[0]).strip() if row and row[0] is not None else ""
        own_ps = 0 if v == "none" else int(v) if v.isdigit() else ba.PANEL_SIZE
    if not int(own_ps):
        raise SystemExit("The target panel size is No maximum: the panel build is off. Add raters by hand or by file.")
    size = int(own_ps)
    mv = min(int(cyc["min_valid"]) if "min_valid" in cyc.keys() and cyc["min_valid"] else 3, size)
    confirmed = {e for e, p in people.items() if p["confirmed"]}
    # the rater cap is the super admin's rule: the cycle's own, else the default, else the engine's (app.py's
    # effective_assessor_cap, read here without the app). A cycle's 0 or the default's "none" is no maximum (None).
    own = cyc["assessor_cap"] if "assessor_cap" in cyc.keys() else None
    if own is not None:
        cap = int(own) or None
    else:
        row = db.execute("SELECT value FROM app_settings WHERE key='assessor_cap'").fetchone()
        v = str(row[0]).strip() if row and row[0] is not None else ""
        cap = None if v == "none" else int(v) if v.isdigit() else ba.ASSESSOR_CAP
    # the year's Mid-Year raters straight after the line manager (Chris, 2026-10-21)
    panels = ba.build_panels_capped(people, confirmed, size, mv, cap=cap, prior=load_prior(db, cyc))

    sizes, with_lm, full, total = {}, 0, 0, 0
    for pan in panels.values():
        n = len(pan["assessors"])
        sizes[n] = sizes.get(n, 0) + 1
        total += n
        if any(rel == "line_manager" for rel, _ in pan["assessors"]):
            with_lm += 1
        if n >= size:
            full += 1
    existing = db.execute("SELECT COUNT(*) FROM assignments WHERE cycle_id=?", (cyc["id"],)).fetchone()[0]
    print(f"Active cycle: {cyc['name']}  (existing assignments: {existing})")
    print(f"Confirmed subjects: {len(confirmed)}")
    print(f"Assignments to create: {total}")
    print(f"  subjects with a line manager: {with_lm}")
    print(f"  full panel (>= {size}): {full}   (nobody rates more than {cap if cap else 'no maximum'})")
    print(f"  panel-size distribution: {dict(sorted(sizes.items()))}")

    if not args.apply:
        print("\nPREVIEW only — nothing written. Re-run with --apply to build.")
        return

    uid = {str(r["employee_id"]).strip(): r["id"] for r in
           db.execute("SELECT id, employee_id FROM users WHERE employee_id IS NOT NULL")}
    rows = []
    for eid, pan in panels.items():
        sid = uid.get(eid)
        if not sid:
            continue
        for rel, a in pan["assessors"]:
            aid = uid.get(a["eid"])
            if aid:
                rows.append((cyc["id"], sid, aid, rel))
    db.execute("DELETE FROM assignments WHERE cycle_id=?", (cyc["id"],))
    db.executemany(
        "INSERT OR IGNORE INTO assignments(cycle_id, subject_id, assessor_id, relationship) "
        "VALUES (?,?,?,?)", rows)
    db.commit()
    n = db.execute("SELECT COUNT(*) FROM assignments WHERE cycle_id=?", (cyc["id"],)).fetchone()[0]
    print(f"\nApplied: {n} assignments now in {cyc['name']}.")


if __name__ == "__main__":
    main()
