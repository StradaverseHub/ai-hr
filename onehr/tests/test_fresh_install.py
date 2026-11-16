"""A brand-new environment can start.

WHY THIS SUITE EXISTS
---------------------
_ensure_runtime_schema() runs at import, so if it cannot migrate a virgin
database then a fresh OneHR environment cannot boot at all. It could not:
`CREATE TABLE IF NOT EXISTS pm_idp` created a hybrid shape, the first rebuild's
guard saw no plan_year and fired, and the rebuild referenced three columns that
did not exist -- `no such column: i.submitted_at` -- aborting the whole
migration.

None of the other suites could catch it, because every one of them starts by
copying a database that already evolved through the real history, where every
`CREATE TABLE IF NOT EXISTS` is a no-op and the mismatch is invisible. This one
starts from nothing on purpose.

It runs each bootstrap in a SUBPROCESS. `import app` is a one-shot event -- the
migration only runs on first import -- so a second bootstrap in the same
interpreter would silently reuse the first module and prove nothing.
"""
import os
import sqlite3
import subprocess
import sys
import textwrap

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

s = H.Suite("Fresh install -- a new environment can start")

PY = sys.executable


def boot(where, extra=""):
    """Lay down app.SCHEMA in a fresh dir, then import app in a SUBPROCESS."""
    d, db = H.bootstrap_fresh_db(where)
    # dedent BEFORE splicing `extra` in, never after: `extra` arrives already at
    # column 0, so a later dedent finds a common prefix of "" and strips nothing,
    # leaving the template's own lines indented -- an IndentationError in the
    # child that reads as "the app will not start on a fresh database".
    code = textwrap.dedent("""
        import os, sys, sqlite3, json
        sys.path.insert(0, %r); os.chdir(%r)
        import app as a
        c = sqlite3.connect(a.DB_PATH)
        out = {"tables": c.execute("SELECT COUNT(*) FROM sqlite_master "
                                   "WHERE type='table'").fetchone()[0]}
    """ % (d, d)) + textwrap.dedent(extra) + '\nprint("RESULT " + json.dumps(out))\n'
    p = subprocess.run([PY, "-c", code], capture_output=True, text=True)
    blob = [l for l in (p.stdout + p.stderr).splitlines() if l.startswith("RESULT ")]
    if not blob:
        return None, (p.stdout + p.stderr)[-400:], db
    import json
    return json.loads(blob[0][7:]), None, db


s.section("the base schema can be laid down without importing app")
schema = H.extract_schema()
s.check("SCHEMA extracted from source", bool(schema) and len(schema) > 1000, len(schema or ""))
s.check("it creates the users table the migration depends on",
        "CREATE TABLE IF NOT EXISTS users" in schema or "CREATE TABLE users" in schema)

s.section("a virgin database migrates")
res, err, db1 = boot(os.path.join(H.SCRATCH, "fresh1"))
s.check("_ensure_runtime_schema() completes on a fresh database", res is not None,
        (err or "")[-220:])
if res:
    s.note("%d tables after the migration" % res["tables"])
    s.check("it built a full schema, not a stub", res["tables"] > 60, res["tables"])

s.section("feedback_remarks (the 360 overall remark, 2026-09-23) exists on a virgin migration")
if res:
    c = sqlite3.connect(db1)
    fr_cols = [r[1] for r in c.execute("PRAGMA table_info(feedback_remarks)")]
    fr_sql = (c.execute("SELECT sql FROM sqlite_master WHERE name='feedback_remarks'").fetchone() or [""])[0]
    s.check("feedback_remarks exists with assignment_id / remark / updated_at",
            fr_cols == ["assignment_id", "remark", "updated_at"], fr_cols)
    s.check("...keyed one-per-assignment, cascading with the assignment",
            "PRIMARY KEY" in fr_sql and "ON DELETE CASCADE" in fr_sql, fr_sql)

s.section("pm_idp_summaries (the manager's AI plan summary cache, 2026-09-24) exists on a virgin migration")
if res:
    c = sqlite3.connect(db1)
    ps_cols = [r[1] for r in c.execute("PRAGMA table_info(pm_idp_summaries)")]
    ps_sql = (c.execute("SELECT sql FROM sqlite_master WHERE name='pm_idp_summaries'").fetchone() or [""])[0]
    s.check("pm_idp_summaries exists with its columns",
            ps_cols == ["subject_id", "plan_year", "fingerprint", "summary", "source", "data", "created_at"], ps_cols)
    s.check("...with `data`, the IDP fit insight (verdict, why, scores, next steps; 2026-09-29)", "data" in ps_cols)
    s.check("...one per person per plan year", "UNIQUE(subject_id, plan_year)" in ps_sql, ps_sql)

s.section("pm_perf_summaries (the manager's AI performance summary cache, 2026-09-24) exists on a virgin migration")
if res:
    c = sqlite3.connect(db1)
    pf_cols = [r[1] for r in c.execute("PRAGMA table_info(pm_perf_summaries)")]
    pf_sql = (c.execute("SELECT sql FROM sqlite_master WHERE name='pm_perf_summaries'").fetchone() or [""])[0]
    s.check("pm_perf_summaries exists with its columns",
            pf_cols == ["subject_id", "cycle_id", "approver_id", "fingerprint", "summary", "source", "created_at",
                        "data"], pf_cols)
    s.check("...one per person per cycle per APPROVER (each sees only the lines they approve)",
            "UNIQUE(subject_id, cycle_id, approver_id)" in pf_sql, pf_sql)

s.section("tc_summaries (the line manager's AI competency summary cache, 2026-09-25) exists on a virgin migration")
if res:
    c = sqlite3.connect(db1)
    tc_cols = [r[1] for r in c.execute("PRAGMA table_info(tc_summaries)")]
    tc_sql = (c.execute("SELECT sql FROM sqlite_master WHERE name='tc_summaries'").fetchone() or [""])[0]
    s.check("tc_summaries exists with its columns (data = the verdict, 2026-09-25)",
            tc_cols == ["subject_id", "cycle_id", "fingerprint", "summary", "source", "created_at", "data"], tc_cols)
    s.check("...one per person per cycle", "UNIQUE(subject_id, cycle_id)" in tc_sql, tc_sql)

s.section("pm_evidence_attachment_text (a file's contents read once, 2026-09-25) exists on a virgin migration")
if res:
    c = sqlite3.connect(db1)
    at_cols = [r[1] for r in c.execute("PRAGMA table_info(pm_evidence_attachment_text)")]
    at_sql = (c.execute("SELECT sql FROM sqlite_master WHERE name='pm_evidence_attachment_text'").fetchone() or [""])[0]
    s.check("pm_evidence_attachment_text exists with its columns",
            at_cols == ["attachment_id", "status", "method", "text", "created_at"], at_cols)
    s.check("...one row per attachment, removed with it", "PRIMARY KEY" in at_sql and "ON DELETE CASCADE" in at_sql, at_sql)

s.section("rating_records (the saved scores + bands per person per cycle, 2026-09-28) exists on a virgin migration")
if res:
    c = sqlite3.connect(db1)
    rr_cols = [r[1] for r in c.execute("PRAGMA table_info(rating_records)")]
    rr_sql = (c.execute("SELECT sql FROM sqlite_master WHERE name='rating_records'").fetchone() or [""])[0]
    s.check("rating_records exists with the performance, potential and provenance columns",
            {"pm_self_value", "pm_mgr_band", "pm_hod_band", "pm_final_band", "pot_score", "pot_raw_band",
             "pot_bgceo_band", "pot_final_band", "frozen_at", "tiers_json"} <= set(rr_cols), rr_cols)
    s.check("...one per person per cycle, and a leaver's history survives (SET NULL)",
            "UNIQUE(cycle_id, subject_id)" in rr_sql and "ON DELETE SET NULL" in rr_sql, rr_sql)

s.section("the Chart of KPI (2026-10-30) exists on a virgin migration, perspectives seeded")
if res:
    c = sqlite3.connect(db1)
    kc_cols = [r[1] for r in c.execute("PRAGMA table_info(kpi_chart)")]
    kn_cols = [r[1] for r in c.execute("PRAGMA table_info(kpi_chart_names)")]
    s.check("kpi_chart, kpi_chart_names and pm_kpi_library_people exist with their columns",
            {"code", "level", "parent_id", "was_codes", "retired_at"} <= set(kc_cols)
            and {"node_id", "name_key", "business_group", "source"} <= set(kn_cols)
            and [r[1] for r in c.execute("PRAGMA table_info(pm_kpi_library_people)")][:2] == ["library_id", "user_id"],
            (kc_cols, kn_cols))
    s.check("pm_kpi_targets carries the chart_node_id override",
            "chart_node_id" in [r[1] for r in c.execute("PRAGMA table_info(pm_kpi_targets)")])
    s.check("the four perspectives are seeded as 1 to 4",
            [tuple(r) for r in c.execute("SELECT code, name FROM kpi_chart WHERE level='persp' ORDER BY code")] ==
            [("1", "Financial"), ("2", "Customer"), ("3", "Internal Process"), ("4", "Learning & Growth")])

s.section("the Chart of KPI's handshake keys (piece C) exist on a virgin migration")
if res:
    c = sqlite3.connect(db1)
    cc = lambda t: [r[1] for r in c.execute("PRAGMA table_info(%s)" % t)]
    ix = {r[0]: (r[1] or "") for r in c.execute("SELECT name, sql FROM sqlite_master WHERE type='index'")}
    s.check("kpi_ext_systems, kpi_chart_links, user_ext_ids and org_ext_ids exist with their columns",
            cc("kpi_ext_systems") == ["id", "name", "note", "added_by", "added_at", "retired_at"]
            and cc("kpi_chart_links") == ["id", "node_id", "system_id", "metric_id", "period", "whose", "matched_on", "unit", "factor",
                                          "updated_by", "updated_at"]
            and cc("user_ext_ids") == ["id", "user_id", "system_id", "ext_id", "linked_at", "linked_by", "removed_at", "removed_by"]
            and cc("org_ext_ids") == ["id", "business_group", "company", "system_id", "ext_code", "linked_by", "linked_at"])
    s.check("an active ID is unique in its system and a person has one active ID per system",
            "ON user_ext_ids(system_id, ext_id) WHERE removed_at IS NULL" in ix.get("idx_user_ext_ids_active", "")
            and "ON user_ext_ids(user_id, system_id) WHERE removed_at IS NULL" in ix.get("idx_user_ext_ids_one", ""))
    s.check("a unit's code and a (unit, system) pair are unique; a node has one link",
            "UNIQUE(system_id, ext_code)" in c.execute("SELECT sql FROM sqlite_master WHERE name='org_ext_ids'").fetchone()[0]
            and "UNIQUE(business_group, company, system_id)" in c.execute("SELECT sql FROM sqlite_master WHERE name='org_ext_ids'").fetchone()[0]
            and "node_id INTEGER NOT NULL UNIQUE" in c.execute("SELECT sql FROM sqlite_master WHERE name='kpi_chart_links'").fetchone()[0])
    s.check("they start empty", all(c.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0] == 0
                                    for t in ("kpi_ext_systems", "kpi_chart_links", "user_ext_ids", "org_ext_ids")))

s.section("pm_idp is created in TODAY's shape")
# This is the specific fault. The CREATE must describe the current shape, so the
# two historical rebuilds below it skip themselves on a fresh database.
if res:
    c = sqlite3.connect(db1)
    sql = (c.execute("SELECT sql FROM sqlite_master WHERE name='pm_idp'").fetchone() or [""])[0]
    cols = [r[1] for r in c.execute("PRAGMA table_info(pm_idp)")]
    s.check("has plan_year", "plan_year" in cols, cols)
    s.check("keyed UNIQUE(plan_year, subject_id)", "UNIQUE(plan_year, subject_id)" in sql)
    s.check("cycle_id is nullable provenance, not ownership",
            "cycle_id" in cols and "cycle_id INTEGER NOT NULL" not in sql)
    s.check("the status CHECK carries 'shared'", "'shared'" in sql)
    # Both guards must be False, or a rebuild would fire on a database that has
    # nothing to migrate.
    s.check("guard 1 (no plan_year) is False -> rebuild skipped", "plan_year" in sql)
    s.check("guard 2 (no 'shared') is False -> rebuild skipped", "'shared'" in sql)

s.section("the fresh shape agrees with a historically-migrated one")
# The real database in this repo has been through every migration. A fresh one
# must land in the same place, or the two environments diverge silently.
# Open with immutable=1, not mode=ro: the repo DB is a STATIC snapshot, and if it is
# in WAL mode a plain mode=ro open fails with "unable to open database file" whenever a
# -wal/-shm sidecar is present or being touched by another connection during the run
# (RO cannot create/recover the shm). immutable=1 reads the committed main file directly
# -- no locks, no sidecars -- which is exactly right for a schema-only comparison and
# fixes the long-standing intermittent failure of this section.
if res and os.path.exists(os.path.join(H.REPO, "leadership360.db")):
    live = sqlite3.connect("file:%s?immutable=1" % os.path.join(H.REPO, "leadership360.db"), uri=True)
    live_cols = [r[1] for r in live.execute("PRAGMA table_info(pm_idp)")]
    fresh_cols = [r[1] for r in sqlite3.connect(db1).execute("PRAGMA table_info(pm_idp)")]
    s.check("pm_idp columns match, column for column",
            sorted(live_cols) == sorted(fresh_cols),
            {"only_live": sorted(set(live_cols) - set(fresh_cols)),
             "only_fresh": sorted(set(fresh_cols) - set(live_cols))})
    # The per-cycle potential-band cutoffs must exist on the SCHEMA path (a virgin
    # boot). The repo's leadership360.db is a STATIC snapshot that has not been
    # booted through the latest ALTERs, so it can LAG on recently-added columns
    # (e.g. kind/low_max/mid_max) -- hence a superset check, not equality: a fresh
    # DB must never be MISSING a column the snapshot has, and must add the new ones.
    live_cyc = [r[1] for r in live.execute("PRAGMA table_info(cycles)")]
    fresh_cyc = [r[1] for r in sqlite3.connect(db1).execute("PRAGMA table_info(cycles)")]
    s.check("fresh cycles has low_max + mid_max",
            "low_max" in fresh_cyc and "mid_max" in fresh_cyc, fresh_cyc)
    s.check("fresh cycles is a superset of the snapshot's columns",
            set(live_cyc) <= set(fresh_cyc), sorted(set(live_cyc) - set(fresh_cyc)))
elif not res:
    s.note("the fresh bootstrap failed -- shape comparison cannot run")
else:
    s.note("no local leadership360.db -- shape comparison skipped")

s.section("migrating twice changes nothing")
# Idempotence on the fresh database: a second boot must not rebuild a table.
if res:
    before = sqlite3.connect(db1).execute(
        "SELECT group_concat(name || '|' || COALESCE(sql,''), '\\n') "
        "FROM sqlite_master WHERE type='table' ORDER BY name").fetchone()[0]
    code = textwrap.dedent("""
        import os, sys
        sys.path.insert(0, %r); os.chdir(%r)
        import app
        print("SECOND BOOT OK")
    """ % (os.path.join(H.SCRATCH, "fresh1"), os.path.join(H.SCRATCH, "fresh1")))
    p = subprocess.run([PY, "-c", code], capture_output=True, text=True)
    s.check("a second boot succeeds", "SECOND BOOT OK" in (p.stdout + p.stderr),
            (p.stdout + p.stderr)[-200:])
    after = sqlite3.connect(db1).execute(
        "SELECT group_concat(name || '|' || COALESCE(sql,''), '\\n') "
        "FROM sqlite_master WHERE type='table' ORDER BY name").fetchone()[0]
    s.check("not one table was rebuilt or altered", before == after)
    # substr, not LIKE: '_' is a single-character wildcard in LIKE and the
    # ESCAPE clause is more trouble than the check is worth.
    s.check("no *_new leftovers from a half-run rebuild",
            not sqlite3.connect(db1).execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE substr(name,-4)='_new'"
            ).fetchone()[0])

s.section("the app is actually usable on a fresh database")
if res:
    res2, err2, _ = boot(os.path.join(H.SCRATCH, "fresh2"), extra=textwrap.dedent("""
        a.app.config["TESTING"] = True
        cl = a.app.test_client()
        out["login"] = cl.get("/login").status_code
        out["root"] = cl.get("/").status_code
        out["routes"] = len([r for r in a.app.url_map.iter_rules()
                             if r.endpoint != "static"])
    """))
    if res2:
        s.check("GET /login answers 200 on a virgin install", res2.get("login") == 200,
                res2.get("login"))
        s.check("the URL map is fully built", res2.get("routes", 0) > 200, res2.get("routes"))
    else:
        s.check("the app serves on a virgin install", False, (err2 or "")[-220:])

sys.exit(s.done())
