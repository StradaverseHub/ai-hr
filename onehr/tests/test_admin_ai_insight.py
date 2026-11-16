"""A person's AI insight for admins, and the health of the insights AI+ writes ahead (Chris, 2026-11-06; canvas
[design canvas link removed], "Tickable role item").

What this suite holds:
  - the item people.ai_insight: in the registry, a read item, ticked for no preset and for no built-in role, never the module's
    pages item (people.read stays that), on Roles & access without the pages mark; the super admin always has it
  - the gate: a BG admin without it sees no line, no card, no panel and the panel's route answers 403; with it (their role's
    tick) they read their own group's person and are refused another group's; the super admin always reads
  - READ ONLY, falsified: with the model and every writer that can reach it raising, every tab and the panel render and no cache
    row, fingerprint, created_at or ai_prerun_jobs row changes; every SQL statement of those GETs is a SELECT but the audit row
  - the audit: one row per part whose words a view carried, deduped within 10 minutes, none for a view of empty states only;
    a read is no change on the person's "What changed"
  - the four states of board 7 (nothing yet, being written, the fixed words, not taking part or the part is off), no spark
    outside an AI reading, and the seat a person has with no reading yet as a disabled segment
  - the health tab: the super admin's alone; every count equals an independent count over seeded jobs; the AI service card
    reads ai_backend_usage; the failed list names, searches and explains in plain words; Try again needs the super admin and
    the CSRF token, resets only failed jobs of the active cycle, is refused with the pre-run off, one audit row each

Its own synthetic people on the SHARED suite database (no fresh copy); everything put back at the end. The model is never called.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A person's AI insight for admins, and the health of the insights AI+ writes ahead")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BG, BG2, CO, CO2 = "ZZAI Group", "ZZAI2 Group", "ZZAI Co Sdn Bhd", "ZZAI2 Co Sdn Bhd"
ITEM = "people.ai_insight"
CACHE_TABLES = ("pm_perf_summaries", "pm_calib_summaries", "pm_remark_summaries", "tc_summaries", "pm_idp_summaries",
                "pot_calib_summaries", "pot_remark_summaries", "tb_insights")
KEEP = {}


def q(db, sql, args=()):
    return db.execute(sql, args).fetchall()


def snapshot(db):
    """Every cache row (all columns) and every queue row, as one comparable value."""
    out = {}
    for t in CACHE_TABLES + ("ai_prerun_jobs",):
        out[t] = sorted(tuple(r) for r in db.execute("SELECT * FROM %s" % t))
    return out


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    # a run that died half-way
    old = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZAI-%'")]
    if old:
        ph = ",".join("?" * len(old))
        for t in ("pm_perf_summaries", "pm_calib_summaries", "pm_remark_summaries", "tc_summaries", "pm_idp_summaries",
                  "pot_calib_summaries", "pot_remark_summaries"):
            db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (t, ph), old)
        db.execute("DELETE FROM pm_review_session WHERE subject_id IN (%s)" % ph, old)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), old + old)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, old)
    db.execute("DELETE FROM buceo_seats WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG, BG2))
    CID = a.active_cycle_id(db)
    KEEP["cycle"] = {"half": db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0],
                     "modules": [tuple(r) for r in db.execute(
                         "SELECT * FROM cycle_modules WHERE cycle_id=? AND module_key IN ('review','calibration','pm','tm','idp')", (CID,))]}
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    # a module with no row is ON: the five parts are switched on by removing any row that says otherwise
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key IN ('review','calibration','pm','tm','idp')", (CID,))
    KEEP["jobs"] = [tuple(r) for r in db.execute("SELECT * FROM ai_prerun_jobs")]
    KEEP["usage"] = [tuple(r) for r in db.execute("SELECT * FROM ai_backend_usage")]
    db.execute("DELETE FROM ai_prerun_jobs")
    db.execute("DELETE FROM ai_backend_usage")
    for b in (BG, BG2):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (b, CO if b == BG else CO2))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ AI " + eid, email=None, hod_id=None,
                 manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CO,
                 years_of_service=5, left_at=None, is_demo=0, job_grade="15", role="user", admin_bg=None,
                 admin_role_id=None, confirmation_date=None, is_system_admin=0)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]
    HOD = person("ZZAI-HOD")
    LM = person("ZZAI-LM", hod_id=HOD)
    BU = person("ZZAI-BU", buceo_bg=BG, buceo_company=CO)
    db.execute("INSERT OR REPLACE INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, BU))
    S = person("ZZAI-S", hod_id=HOD, manager_id=LM)      # AI readings in every part
    S2 = person("ZZAI-S2", business_group=BG2, company=CO2, hod_id=None, manager_id=None)   # another group's person
    S3 = person("ZZAI-S3", hod_id=HOD, manager_id=LM)    # nothing at all
    S4 = person("ZZAI-S4", hod_id=HOD, manager_id=LM)    # a queued job, no row
    S5 = person("ZZAI-S5", hod_id=HOD, manager_id=LM)    # the fixed words
    S6 = person("ZZAI-S6", hod_id=HOD, manager_id=LM, left_at="2026-01-01 00:00:00")   # a leaver: not taking part
    BGA = person("ZZAI-BGA", role="admin", business_group=BG, admin_bg=BG)
    BGA2 = person("ZZAI-BGA2", role="admin", business_group=BG2, admin_bg=BG2)
    ROLE_BG = db.execute("SELECT id FROM admin_roles WHERE builtin='bg'").fetchone()[0]
    db.execute("UPDATE users SET admin_role_id=? WHERE id IN (?,?)", (ROLE_BG, BGA, BGA2))
    SU = db.execute("SELECT * FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' LIMIT 1").fetchone()
    SUID = SU["id"]
    KEEP["role_items"] = sorted(r[0] for r in db.execute("SELECT item FROM admin_role_access WHERE role_id=?", (ROLE_BG,)))
    db.execute("DELETE FROM admin_role_access WHERE role_id=? AND item=?", (ROLE_BG, ITEM))   # off, as shipped

    PM = {"v": 5, "source": "ai", "verdict": "partly_justified", "verdict_label": "Partly justified",
          "verdict_why": "Two lines are on target and explained; the other two fall short.",
          "paragraph": "Occupancy beat target with a note that explains how. Renewals fell short and nothing explains it.",
          "read": "2 of 4 lines on or above target.",
          "kpis": [{"kpi": "Occupancy rate", "result": "92", "target": 85, "unit": "%", "justified": "yes",
                    "justified_why": "Their note names the two sites that filled.", "files": []},
                   {"kpi": "Lease renewals", "result": "28", "target": 40, "unit": "", "justified": "no",
                    "justified_why": "Well short, and nothing explains it.", "files": [{"id": 1, "name": "x.pdf"}]}],
          "discuss": ["What held back lease renewals.", "A file behind the occupancy figure."]}

    def put(table, sid, cols_vals):
        names = list(cols_vals)
        db.execute("INSERT INTO %s(subject_id, %s) VALUES (?,%s)" % (table, ",".join(names), ",".join("?" * len(names))),
                   [sid] + [cols_vals[k] for k in names])

    def rows_for(sid, source="ai", with_all=True):
        put("pm_perf_summaries", sid, dict(cycle_id=CID, approver_id=LM, fingerprint="zz", summary="zz lm summary",
                                           source=source, data=json.dumps(dict(PM, source=source)), created_at="2026-11-05 06:20:00"))
        put("tc_summaries", sid, dict(cycle_id=CID, fingerprint="zz", summary="zz tc",
                                      source=source, created_at="2026-11-05 08:02:00",
                                      data=json.dumps({"v": 2, "verdict": "well_justified", "verdict_label": "Well justified",
                                                       "verdict_why": "Their levels match the examples they gave.",
                                                       "paragraph": "The one stretch is stakeholder work.", "discuss": ["A second example."]})))
        put("pm_idp_summaries", sid, dict(plan_year=a.pm_idp_plan_year(db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()), fingerprint="zz", summary="zz idp",
                                          source=source, created_at="2026-11-05 09:40:00",
                                          data=json.dumps({"v": 2, "kind": "idp_fit", "verdict": "not_yet", "verdict_label": "Not yet a fit",
                                                           "verdict_why": "Both goals aim at leasing skills.",
                                                           "paragraph": "Cost control is the next step.", "discuss": [],
                                                           "scores": "Their view: ready to lead leasing"})))
        if with_all:
            put("pm_calib_summaries", sid, dict(cycle_id=CID, tier="hod", scope_key=str(HOD), fingerprint="zz", summary="zz hod",
                                                source=source, created_at="2026-11-05 07:00:00",
                                                data=json.dumps(dict(PM, paragraph="The HOD's written case for them."))))
            put("pm_remark_summaries", sid, dict(cycle_id=CID, tier="hod", fingerprint="zz", summary="Written about their results: zz",
                                                 source=source, created_at="2026-11-05 07:01:00"))
            put("pot_calib_summaries", sid, dict(cycle_id=CID, fingerprint="zz", summary="Raters agree on reliability.",
                                                 source=source, created_at="2026-11-05 09:12:00"))
            put("pot_remark_summaries", sid, dict(cycle_id=CID, tier="hod", fingerprint="zz", summary="Written about potential: zz",
                                                  source=source, created_at="2026-11-05 09:13:00"))
    rows_for(S)
    rows_for(S2)
    rows_for(S5, source="plain", with_all=False)
    db.execute("INSERT INTO ai_prerun_jobs(kind, subject_id, cycle_id, status, created_at) VALUES ('pm_lm', ?, ?, 'queued', "
               "'2026-11-06 06:02:00')", (S4, CID))
    db.commit()

PEOPLE = {"S": S, "S3": S3, "S4": S4, "S5": S5}
SUP, BAC, BAC2 = H.client_as(a, SUID), H.client_as(a, BGA), H.client_as(a, BGA2)


def dbq(sql, args=()):
    """A plain read on its own connection (outside the traced one)."""
    import sqlite3
    c = sqlite3.connect(a.DB_PATH)
    try:
        return c.execute(sql, args).fetchall()
    finally:
        c.close()


def get(c, path):
    r = c.get(path)
    return r.status_code, r.get_data(as_text=True)


def page(c, uid, tab="overview", **kw):
    qs = "&".join("%s=%s" % (k, v) for k, v in dict(kw, tab=tab).items())
    return get(c, "/admin/users/%d?%s" % (uid, qs))


def insight(c, uid, part="pm"):
    return get(c, "/admin/users/%d/insight?part=%s&fragment=1&cycle=%d" % (uid, part, CID))


def audit(db, uid=None, admin=None):
    sql, args = "SELECT * FROM activity_log WHERE action='view_ai_insight'", []
    if uid:
        sql += " AND target_user_id=?"
        args.append(uid)
    if admin:
        sql += " AND user_id=?"
        args.append(admin)
    return q(db, sql + " ORDER BY id", args)


def has_spark(html):
    return "rv-ai-src" in html or "rv-ico-spark" in html


def give_item(on):
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM admin_role_access WHERE role_id=? AND item=?", (ROLE_BG, ITEM))
        if on:
            d.execute("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", (ROLE_BG, ITEM))
        d.commit()


# the model and every writer that can reach it raise: a read must never come near any of them
CALLS = []
_REAL = {}


def trip(name):
    def boom(*x, **k):
        CALLS.append(name)
        raise AssertionError("a read called " + name)
    return boom


for _n in ("_pm_perf_summary_for", "_tc_summary_for", "_idp_summary_for", "_pot_summary_for", "_tb_insight_for",
           "_pot_remarks_summary_for", "_prerun_enqueue", "_prerun_want"):
    _REAL[_n] = getattr(a, _n)
    setattr(a, _n, trip(_n))
_REAL["ai_draft._chat_complete_call"] = a.ai_draft._chat_complete_call
a.ai_draft._chat_complete_call = trip("ai_draft._chat_complete_call")
_orig_get_db = a.get_db
STMTS = []


def traced_get_db():
    d = _orig_get_db()
    d.set_trace_callback(lambda stmt: STMTS.append(stmt))
    return d


a.get_db = traced_get_db
WRITE = re.compile(r"^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b", re.I)


def writes():
    return [x for x in STMTS if WRITE.match(x) and not re.match(r"^\s*INSERT INTO activity_log\b", x, re.I)]


try:
    # ------------------------------------------------------------------------------------------------------------------
    s.section("A. the item: registry, presets, the Roles & access page")
    it = a.ADMIN_ITEM_BY_KEY.get(ITEM)
    s.check("it is in the registry as a read item under People", bool(it) and it[0] == "people" and it[2] == "read", it)
    s.check("a role has it only when ticked by name (ADMIN_ITEMS_EXPLICIT)", ITEM in a.ADMIN_ITEMS_EXPLICIT)
    s.check("people.read stays the People module's pages item (a second read item must not take its place)",
            a.ADMIN_READ_ITEM["people"] == "people.read" and a.ADMIN_READ_ITEM["gradeh"] == "gradeh.read")
    with a.app.app_context():
        d = a.get_db()
        presets = {k: a.role_preset_items(k) for k, _l, _d in a.ACCESS_PRESETS}
        s.check("off in every preset (View only, Run the cycle, Everything)", all(ITEM not in v for v in presets.values()) and len(presets) == 3,
                {k: ITEM in v for k, v in presets.items()})
        s.check("...falsified: the preset reads people.read, so a preset that forgot the exclusion would carry it",
                "people.read" in presets["view"] and "people.details" in presets["full"])
        built = {r["builtin"]: a.admin_role_items(d, r["id"]) for r in d.execute("SELECT id, builtin FROM admin_roles WHERE builtin IS NOT NULL")}
        s.check("off in the built-in BG admin, BU admin and L&D admin roles", set(built) >= {"bg", "bu", "lnd"}
                and all(ITEM not in v for v in built.values()), {k: ITEM in v for k, v in built.items()})
        got = a._roles_items_from_form(__import__("werkzeug.datastructures", fromlist=["MultiDict"]).MultiDict(
            {"t_%d" % ROLE_BG: [ITEM]}), ROLE_BG)
        s.check("ticking it on the matrix brings the People pages with it (and nothing else)", got == {ITEM, "people.read"}, got)
        s.check("an old per-admin read tick never gives it (a ticked-by-name item is not inherited)",
                ITEM not in a._items_from_perms({"people": {"read", "edit"}}))
    sc, html = get(SUP, "/admin/roles?tab=admin")
    row = re.search(r'<div class="rl-row"[^>]*data-item="people\.ai_insight"[^>]*>', html)
    pages_row = re.search(r'<div class="rl-row"[^>]*data-item="people\.read"[^>]*>', html)
    s.check("Roles & access shows the item, and only People's pages row carries the pages mark",
            sc == 200 and bool(row) and "data-read" not in row.group(0) and bool(pages_row) and "data-read" in pages_row.group(0)
            and ("Read a person&#39;s AI insight" in html or "Read a person's AI insight" in html), (sc, bool(row)))
    s.check("...unticked for every role shown", bool(row) and "checked" not in re.search(
        r'data-item="people\.ai_insight".*?(?=<div class="rl-row)', html, re.S).group(0))
    with a.app.app_context():
        s.check("the super admin always has it; a BG admin without the tick does not",
                a._ai_ins_can(a.get_db().execute("SELECT * FROM users WHERE id=?", (SUID,)).fetchone()) is True)
    with a.app.test_request_context("/"):
        s.check("...(admin_can_item for the BG admin)", not a.admin_can_item(a.get_db().execute(
            "SELECT * FROM users WHERE id=?", (BGA,)).fetchone(), ITEM))

    # ------------------------------------------------------------------------------------------------------------------
    s.section("B. the gate: without the item nothing; with it their own group's people only")
    with a.app.app_context():
        base_audit = len(audit(a.get_db()))
    codes = {}
    sc, ov = page(BAC, S)
    codes["overview"] = sc
    s.check("a BG admin without the item opens the person's Overview, which has no AI insight line, no card, no panel",
            sc == 200 and "ais-line" not in ov and 'id="pnl-insight"' not in ov and "AI insight" not in ov, sc)
    for tab in ("performance", "competency", "f360", "plan"):
        sc, html = page(BAC, S, tab)
        s.check("...nor on the %s tab" % tab, sc == 200 and "ais-card" not in html and "AI insight" not in html, sc)
    sc, _h = insight(BAC, S)
    s.check("...and the panel's route answers 403", sc == 403, sc)
    with a.app.app_context():
        s.check("...nothing was logged", len(audit(a.get_db())) == base_audit)
    sc, _h = insight(SUP, S)
    s.check("the super admin reads it (200)", sc == 200, sc)
    give_item(True)
    with a.app.test_request_context("/"):
        s.check("tick the item on the role: admin_can_item is now true for the BG admin",
                a.admin_can_item(a.get_db().execute("SELECT * FROM users WHERE id=?", (BGA,)).fetchone(), ITEM))
    sc, ov = page(BAC, S)
    s.check("with it, their own group's person's Overview has the four lines and the panel",
            sc == 200 and ov.count('data-ais-line=') == 4 and 'id="pnl-insight"' in ov, (sc, ov.count("data-ais-line=")))
    sc, html = insight(BAC, S)
    s.check("...and the panel's route answers 200", sc == 200 and "Whose reading" in html, sc)
    sc, _h = page(BAC, S2)
    s.check("a person in another group is refused (403) on their page, whatever the item", sc == 403, sc)
    sc, _h = insight(BAC, S2)
    s.check("...and in the panel's route (the person page's own scope check)", sc == 403, sc)
    sc, _h = insight(BAC2, S2)
    s.check("...while the other group's admin, with the same role's item, reads their own", sc == 200, sc)
    sc, _h = insight(BAC, 999999)
    s.check("a person who doesn't exist is 404", sc == 404, sc)
    sc, _h = insight(BAC, BGA2)
    s.check("an admin login is 404, not an insight", sc == 404, sc)
    # the items of a role other than the BG one: the BU admin role has none either, whatever the item does elsewhere
    give_item(False)
    sc, _h = insight(BAC, S)
    s.check("...untick it and the same admin is refused again (the gate follows the role, not the account)", sc == 403, sc)

    # ------------------------------------------------------------------------------------------------------------------
    s.section("C. READ ONLY: the model and every writer raise; nothing changes; every statement is a SELECT")
    give_item(True)
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM activity_log WHERE action='view_ai_insight'")
        d.commit()
        before = snapshot(d)
    STMTS.clear()
    CALLS.clear()
    seen = []
    for c, who in ((SUP, "super"), (BAC, "BG admin")):
        for uid in (S, S3, S4, S5, S6):
            for tab in ("overview", "performance", "competency", "f360", "plan"):
                sc, html = page(c, uid, tab)
                seen.append(sc)
            for part in ("pm", "tc", "idp", "pot"):
                seen.append(insight(c, uid, part)[0])
    with a.app.app_context():
        after = snapshot(a.get_db())
    s.check("every tab and the panel rendered for both readers (%d GETs, all 200)" % len(seen), set(seen) == {200}, sorted(set(seen)))
    s.check("the model and every writer that can reach it were never called", CALLS == [], CALLS)
    s.check("every cache table (all columns: fingerprint, created_at too) and ai_prerun_jobs are identical afterwards",
            before == after, [t for t in before if before[t] != after[t]])
    s.check("every statement those GETs ran is a SELECT, but the audit row of the read itself", writes() == [], writes()[:3])
    s.check("...and the audit rows were written (the trace saw them)", any(re.match(r"^\s*INSERT INTO activity_log", x, re.I) for x in STMTS))
    # falsify the detector: a real writer must be seen, and a tripped function must stop the page
    STMTS.clear()
    a._prerun_enqueue = _REAL["_prerun_enqueue"]
    a._PRERUN["force"] = True
    with a.app.test_request_context("/"):
        dbx = a.get_db()
        a._prerun_enqueue(dbx, "pm_lm", S, CID, viewer_id=LM)
        dbx.rollback()
    a._PRERUN["force"] = False
    a._prerun_enqueue = trip("_prerun_enqueue")
    s.check("falsified: the same trace flags a real enqueue as a write", any("ai_prerun_jobs" in w for w in writes()), writes()[:2])
    with a.app.app_context():
        a.get_db().execute("DELETE FROM ai_prerun_jobs WHERE kind='pm_lm' AND subject_id=?", (S,))
        a.get_db().commit()
    # the helper itself, called straight: no write, no call
    STMTS.clear()
    with a.app.test_request_context("/"):
        dbx = a.get_db()
        subj = dbx.execute("SELECT * FROM users WHERE id=?", (S,)).fetchone()
        res = a._ai_insight_read(dbx, subj, a.active_cycle(dbx), "pm")
    s.check("the helper on its own writes nothing and returns the seats: line manager's and HOD's written, BU CEO's not yet",
            writes() == [] and [(x["key"], x["state"]) for x in res["readings"]] == [("lm", "ai"), ("hod", "ai"), ("buceo", "notyet")],
            [(x["key"], x["state"]) for x in res["readings"]])

    # ------------------------------------------------------------------------------------------------------------------
    s.section("D. the audit: one row a part, deduped within 10 minutes, none for empty states")
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM activity_log WHERE action='view_ai_insight'")
        d.commit()
    sc, ov = page(BAC, S)
    with a.app.app_context():
        d = a.get_db()
        rows = audit(d, S, BGA)
        parts = sorted(re.search(r"AI insight \((.+?), ", r["detail"]).group(1) for r in rows)
        s.check("an Overview with four readings logs four rows, one a part, by this admin about this person",
                parts == ["Career Plan", "Competency", "Performance", "Potential"] and all(r["target_user_id"] == S for r in rows), parts)
        pm = next(r for r in rows if "(Performance," in r["detail"])
        s.check("the row reads 'Read <name>'s AI insight (<part>, <whose>)', naming each reading shown",
                pm["detail"] == "Read ZZ AI ZZAI-S's AI insight (Performance, Line manager's and HOD's)", pm["detail"])
    page(BAC, S)
    page(BAC, S, "performance")
    insight(BAC, S, "pm")
    with a.app.app_context():
        s.check("the same admin, person and part again within 10 minutes logs nothing more (Overview, tab and panel)",
                len(audit(a.get_db(), S, BGA)) == 4)
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE activity_log SET created_at=datetime('now','-11 minutes') WHERE action='view_ai_insight'")
        d.commit()
    page(BAC, S, "competency")
    with a.app.app_context():
        rows = audit(a.get_db(), S, BGA)
        s.check("...falsified: after 10 minutes the same read is logged again, for the part viewed only (Competency)",
                len(rows) == 5 and "(Competency," in rows[-1]["detail"], [r["detail"][-30:] for r in rows[-2:]])
    insight(SUP, S, "idp")
    with a.app.app_context():
        s.check("a different admin's read of the same part is logged on its own (the super admin too)",
                len(audit(a.get_db(), S, SUID)) == 1)
        base_n = len(audit(a.get_db()))
    for uid in (S3, S4, S6):   # nothing to read, a queued job, not taking part: empty states only
        for tab in ("overview", "performance", "competency", "f360", "plan"):
            page(BAC, uid, tab)
        for part in ("pm", "tc", "idp", "pot"):
            insight(BAC, uid, part)
    with a.app.app_context():
        s.check("views of empty states only write no audit row", len(audit(a.get_db())) == base_n)
        d = a.get_db()
        d.execute("DELETE FROM activity_log WHERE action='view_ai_insight'")
        d.commit()
    page(BAC, S5, "overview")
    with a.app.app_context():
        s.check("...while the fixed words (a stored reading) are words a view carried: logged", len(audit(a.get_db(), S5)) == 3)
    sc, ov = page(SUP, S)
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM activity_log WHERE action='view_ai_insight'")
        d.commit()
    page(BAC, S)
    sc, ov = page(SUP, S)
    s.check("a read is no change: the person's 'What changed' never lists it", sc == 200 and "AI insight (" not in ov
            and "Read a person" not in ov)
    sc, al = get(SUP, "/admin/audit-log?q=ZZAI-S")
    s.check("...while the super admin's Audit log does", sc == 200 and "Read a person" in al and "AI insight" in al, sc)

    # ------------------------------------------------------------------------------------------------------------------
    s.section("E. the states of board 7, the spark, the seats")
    sc, html = page(BAC, S, "performance")
    card = re.search(r'<section class="admin-card pp-card ais-card".*?</section>', html, re.S).group(0)
    s.check("an AI reading: the red spark and 'AI insight', the verdict glyph and word, the lead and the paragraph",
            "rv-ai-src" in card and "rv-ico-spark" in card and "◐" in card and "Partly justified" in card
            and "Two lines are on target and explained" in card and "Occupancy beat target" in card)
    s.check("...the tab's KPI by KPI is the compact list (name, glyph and word, the reason on hover) beside what it suggests asking; "
            "no table there",
            "KPI by KPI" in card and 'class="ais-kk"' in card and "\u2713 Justified" in card and "\u2715 Not justified" in card
            and 'title="Well short, and nothing explains it."' in card and "What it suggests the line manager asks" in card
            and "What held back lease renewals." in card and "<table" not in card and "Their result" not in card)
    sc, pnl = insight(BAC, S, "pm")
    s.check("...the panel has the full table: KPI | Their result \u00b7 target | Justified? | Why, the figures and the reasons in words",
            "Their result \u00b7 target" in pnl and "92 \u00b7 85 %" in pnl and "\u2713 Justified" in pnl and "\u2715 Not justified" in pnl
            and "Well short, and nothing explains it." in pnl and "What it suggests the line manager asks" in pnl, sc)
    s.check("...the stamp names the line manager and the time in MYT (5 Nov 2026, 14:20) and what it was written from",
            "ZZ AI ZZAI-LM, their line manager" in card and "5 Nov 2026, 14:20" in card and "from 2 submitted results and 1 file" in card)
    s.check("...whose reading: line manager's and HOD's, the BU CEO's a disabled 'not yet' segment with its title",
            re.search(r'<button type="button" data-ais-pick="lm"[^>]*>Line manager&#39;s</button>', card) is not None
            and re.search(r'<button type="button" data-ais-pick="hod"', card) is not None
            and re.search(r'<button type="button" disabled title="Written once BU CEO calibration opens">BU CEO&#39;s · not yet</button>', card) is not None)
    s.check("...the HOD's reading is its own block (hidden until picked) with what was written about the results",
            'data-ais-seat="hod" hidden' in card and "The HOD&#39;s written case for them." in card
            and "Written about their results: zz" in card)
    s.check("a failed-colour check: nothing the AI wrote is red (no hex, no red token inside the reading)",
            "#d61923" not in card and "danger" not in card)
    sc, html = page(BAC, S, "competency")
    s.check("Competency: the card is the top of the left column, above the job strip",
            html.index("ais-card") < html.index('aria-label="Job profile match"') and "Well justified" in html and "✓" in html)
    sc, html = page(BAC, S, "plan")
    s.check("Career Plan: between Submitted and Their career path, with the scores as the soft line",
            html.index("ais-card") < html.index('aria-label="Their career path"') and "Their view: ready to lead leasing" in html
            and "Not yet a fit" in html and "✕" in html)
    sc, html = page(BAC, S, "f360")
    s.check("360: full width above 'Who gives ... feedback', the potential reading with its 'What was written about potential' switch",
            html.index("ais-card") < html.index("Who gives") and "Raters agree on reliability." in html
            and "What was written about potential" in html and "Written about potential: zz" in html)
    # (a) nothing yet
    sc, html = page(BAC, S3, "performance")
    card = re.search(r'<section class="admin-card pp-card ais-card".*?</section>', html, re.S).group(0)
    s.check("(a) no row and no job: 'Nothing to read yet ... once <name> submits their KPI results', no spark",
            "Nothing to read yet. AI+ writes it once ZZ AI ZZAI-S3 submits their KPI results." in card and not has_spark(card))
    sc, ov = page(BAC, S3)
    s.check("...and on the Overview 'No AI insight yet' under each card, 360 saying when potential is written",
            ov.count("No AI insight yet") == 4 and "Potential is written for the calibrators once calibration opens." in ov and not has_spark(ov.split('id="pnl-insight"')[0].split('class="pp-mods"')[1]))
    # (b) queued
    sc, html = page(BAC, S4, "performance")
    card = re.search(r'<section class="admin-card pp-card ais-card".*?</section>', html, re.S).group(0)
    s.check("(b) a queued job: 'AI+ is writing it · in the queue since 14:02' (06:02 UTC is 14:02 MYT), no spark",
            "AI+ is writing it · in the queue since 14:02" in card and not has_spark(card))
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE ai_prerun_jobs SET status='running' WHERE subject_id=?", (S4,))
        d.commit()
    sc, html = page(BAC, S4, "performance")
    s.check("...a running one reads the same", "in the queue since 14:02" in html)
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE ai_prerun_jobs SET status='done' WHERE subject_id=?", (S4,))
        d.commit()
    sc, html = page(BAC, S4, "performance")
    s.check("...falsified: a finished job is not 'writing it' (nothing to read yet again)",
            "in the queue since" not in html and "Nothing to read yet" in html)
    # (c) the fixed words
    sc, html = page(BAC, S5, "performance")
    card = re.search(r'<section class="admin-card pp-card ais-card".*?</section>', html, re.S).group(0)
    s.check("(c) a reading AI+ did not write: the fixed words, the grey 'From their figures' tag, no spark, and the muted line",
            "From their figures" in card and not has_spark(card) and "Partly justified" in card
            and "AI+ couldn't write this one" in card and "asks AI+ again when it opens" in card, ["From their figures" in card, not has_spark(card), "Partly justified" in card, "AI+ couldn't write this one" in card, "asks AI+ again when it opens" in card])
    sc, html = page(BAC, S5, "competency")
    s.check("...with each kind's own words (From their answers, From their plan and scores), none with a spark",
            "From their answers" in html and not has_spark(html.split('aria-label="Job profile match"')[0].split("ais-card")[1]))
    # (d) not taking part, or the part is off
    sc, html = page(BAC, S6, "performance")
    s.check("(d) not taking part: one line, no spark", "No AI insight: ZZ AI ZZAI-S6 is not taking part in" in html and not has_spark(html.split("ais-card")[1][:800]), [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", x))[:200] for x in html.split("ais-card")[1:3]])
    with a.app.app_context():
        d = a.get_db()
        d.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'idp', 0)", (CID,))
        d.commit()
    sc, html = page(SUP, S, "plan")
    s.check("(d) a part switched off this cycle: 'Career Plan is off in <cycle>' (the module's switch)",
            "No AI insight: Career Plan is off in" in html, (sc, re.sub(r"<[^>]+>", " ", html.split("ais-card")[1][:500]) if "ais-card" in html else html[:200]))
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='idp'", (CID,))
        d.commit()

    # ------------------------------------------------------------------------------------------------------------------
    s.section("F. the panel: the part tabs, the foot, the audit's words")
    sc, html = insight(BAC, S, "pm")
    s.check("the panel carries the four part tabs, Whose reading, the stamp, the verdict block and the note",
            all(w in html for w in ("Performance", "Competency", "Career Plan", "Potential", "Whose reading", "Written by AI+ for",
                                    "Exactly what the reviewer sees", "Read only: AI+ is not asked again from here"))
            and html.count("data-ais-tab=") == 4, sc)
    s.check("...its foot's tab follows the part (data-open-href / label)", "tab=performance" in html and "Open the Performance tab" in html)
    sc, html = insight(BAC, S, "pot")
    s.check("Potential: one reading for every calibrator and the written-about switch; foot opens the 360 tab",
            "What their 360 and competency show" in html and "What was written about potential" in html and "Open the 360 Feedback tab" in html)
    sc, ov = page(BAC, S, panel="insight", part="tc")
    s.check("?panel=insight opens it on load (autoopen), loaded for the part asked",
            "data-panel-autoopen" in ov and "part=tc" in ov.split('id="pnl-insight"')[1][:600], sc)
    sc, ov = page(BAC, S3, panel="insight")
    s.check("...and a person with nothing: the panel still opens, saying so", sc == 200 and 'id="pnl-insight"' in ov)
    give_item(False)
    sc, ov = page(BAC, S, panel="insight")
    s.check("without the item ?panel=insight opens nothing: no panel in the page at all", sc == 200 and 'id="pnl-insight"' not in ov)

    # ------------------------------------------------------------------------------------------------------------------
    s.section("G. the health tab: the super admin's alone; the counts equal an independent count")
    give_item(True)
    sc, _h = get(BAC, "/admin/ai-insights")
    s.check("a BG admin (even with the item) cannot open it (sent Home, or 403)", sc in (302, 403), sc)
    sc, _h = get(BAC, "/admin/list/ai-failed?fragment=1")
    s.check("...nor its Failed list (403)", sc == 403, sc)
    sc, _h = get(SUP, "/admin/ai-insights")
    s.check("the super admin opens it", sc == 200, sc)
    sc, html = get(SUP, "/admin/audit-log")
    s.check("it is the fifth tab of Audit and usage: Audit log | Usage | Data integrity | Ask OneHR | AI insights",
            re.findall(r'<a[^>]*>\s*([^<]+?)\s*</a>', re.search(r'<nav class="adm-tabs".*?</nav>', html, re.S).group(0))
            == ["Audit log", "Usage", "Data integrity", "Ask OneHR", "AI insights"])
    # seed the jobs: kind, status, age of created (hours), finished (hours ago), error, scope for attach
    now_q = "datetime('now','-%d hours')"
    seeded = [
        # kind, tier, subject, status, created h ago, finished h ago, last_error
        ("pm_lm", "", S, "done", 5, 4, None), ("pm_lm", "", S3, "done", 60, 55, None),    # the second is older than 2 days
        ("pm_lm", "", S4, "queued", 3, None, None), ("pm_lm", "", S5, "running", 0.2, None, None),
        ("pm_lm", "", S6, "failed", 6, 5, "TimeoutError: https://example.invalid/key=SECRET"),
        ("pm_calib", "hod", S, "done", 5, 3, None), ("pm_calib", "buceo", S, "skipped", 5, 2, None),
        ("pm_calib", "hod", S3, "queued", 2, None, None), ("pm_calib", "hod", S4, "failed", 7, 6, "JSONDecodeError: Expecting value"),
        ("tc", "", S, "done", 5, 4, None), ("tc", "", S3, "failed", 8, 7, "ValueError: verdict kinder than the server's"),
        ("idp", "", S, "queued", 4, None, None), ("idp", "", S4, "skipped", 9, 8, None),
        ("pot", "", S, "done", 5, 1, None), ("pot_rem", "hod", S, "done", 5, 1, None),
        ("tb", "bgceo", S, "skipped", 5, 1, None),
    ]
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM ai_prerun_jobs")
        for i, (kind, tier, subj, st, ch, fh, err) in enumerate(seeded):
            d.execute("INSERT INTO ai_prerun_jobs(kind, subject_id, cycle_id, tier, scope_key, status, attempts, created_at, finished_at, last_error) "
                      "VALUES (?,?,?,?,?,?,?,%s,%s,?)" % ("datetime('now','-%d minutes')" % int(ch * 60),
                                                         ("datetime('now','-%d minutes')" % int(fh * 60)) if fh is not None else "NULL"),
                      (kind, subj, CID, tier, "k%d" % i, st, 3 if st == "failed" else 0, err))
        # a file job: the person is in scope_key, the attachment in subject_id
        d.execute("INSERT INTO ai_prerun_jobs(kind, subject_id, cycle_id, tier, scope_key, status, attempts, created_at, finished_at, last_error) "
                  "VALUES ('attach', 987654, ?, '', ?, 'failed', 3, datetime('now','-300 minutes'), datetime('now','-250 minutes'), 'retry')",
                  (CID, str(S5)))
        d.commit()
        got = a._ai_ins_health(d)
        rows_ = [dict(r) for r in d.execute("SELECT * FROM ai_prerun_jobs")]
    import datetime as _dt

    def age_h(ts):
        return (_dt.datetime.utcnow() - _dt.datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")).total_seconds() / 3600

    def expect(kinds):
        js = [r for r in rows_ if r["kind"] in kinds]
        return {"written": sum(1 for r in js if r["status"] == "done" and age_h(r["finished_at"]) <= 48),
                "uptodate": sum(1 for r in js if r["status"] == "skipped" and age_h(r["finished_at"]) <= 48),
                "waiting": sum(1 for r in js if r["status"] in ("queued", "running")),
                "over_hour": sum(1 for r in js if r["status"] in ("queued", "running") and age_h(r["created_at"]) > 1),
                "failed": sum(1 for r in js if r["status"] == "failed")}
    mism = [(r["part"], {k: r[k] for k in ("written", "uptodate", "waiting", "over_hour", "failed")}, expect(r["kinds"]))
            for r in got["rows"] if {k: r[k] for k in ("written", "uptodate", "waiting", "over_hour", "failed")} != expect(r["kinds"])]
    s.check("every row of 'By part' equals an independent count over the seeded jobs (written, up to date, waiting, over 1 h, failed)",
            not mism and len(got["rows"]) == 9, mism)
    s.check("...pm_calib's four tiers are one row, the older-than-2-days done job is not 'written', and the total row sums them",
            got["tot"] == expect([k for r_ in got["rows"] for k in r_["kinds"]]) and got["tot"]["failed"] == 4
            and got["tot"]["written"] == 5, got["tot"])
    sc, html = get(SUP, "/admin/ai-insights")
    t = got["tot"]
    s.check("the tiles show them: Written %d with '%d more already up to date', Waiting %d with '%d over an hour', Failed %d (a link that opens the list)"
            % (t["written"], t["uptodate"], t["waiting"], t["over_hour"], t["failed"]),
            "<b>%d</b>" % t["written"] in html and "%d more already up to date" % t["uptodate"] in html
            and "%d over an hour" % t["over_hour"] in html and 'data-list-open="/admin/list/ai-failed?fragment=1"' in html
            and re.search(r'ais-bad">%d<' % t["failed"], html) is not None)
    cell = re.search(r"<tr><td><b>Performance</b></td><td class=\"muted small\">Line manager</td>(.*?)</tr>", html, re.S).group(1)
    nums = re.findall(r'<td class="num[^"]*">(?:<a[^>]*>)?(\d+)', cell)
    s.check("...and the By part table's Performance · Line manager row reads the same numbers", nums == [
        str(expect(("pm_lm",))[k]) for k in ("written", "uptodate", "waiting", "over_hour", "failed")], nums)
    s.check("a non-zero Failed count in the table opens the list; a zero one is plain 0",
            html.count("data-list-open") >= 3 and re.search(r'<td class="num">0</td>\s*<td class="muted small ais-nw">', html) is not None)
    # the ready tile: a delta over what was there, one batched query
    with a.app.app_context():
        d = a.get_db()
        r0 = a._ai_ins_health(d)["ready"]
        for sid in (S, S3, S5):
            d.execute("INSERT OR REPLACE INTO pm_review_session(subject_id, cycle_id, locked_at, locked_by) VALUES (?,?,datetime('now'),?)",
                      (sid, CID, sid))
        d.commit()
        r1 = a._ai_ins_health(d)["ready"]
    s.check("'Ready for line managers': three more people taking part submitted (+3 of M); two of them (the AI and the plain row, from their "
            "current line manager) are ready, the one with no row is not", (r1["m"] - r0["m"], r1["n"] - r0["n"]) == (3, 2), (r0, r1))
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE pm_perf_summaries SET approver_id=? WHERE subject_id=?", (HOD, S))   # a reading from someone who is not their line manager
        d.commit()
        r2 = a._ai_ins_health(d)["ready"]
        d.execute("UPDATE pm_perf_summaries SET approver_id=? WHERE subject_id=?", (LM, S))
        d.commit()
    s.check("...falsified: a reading from someone who is not their current line manager does not count", r1["n"] - r2["n"] == 1, (r1, r2))
    # the AI service card
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM ai_backend_usage")
        hr = lambda h: (_dt.datetime.utcnow().replace(minute=0, second=0, microsecond=0) - _dt.timedelta(hours=h)).strftime("%Y-%m-%d %H")  # noqa: E731
        for h, be, calls, e429, e5xx, tmo in ((1, "azure", 100, 2, 1, 3), (2, "azure", 40, 0, 0, 0), (2, "openai", 7, 0, 0, 0),
                                              (3, "none", 5, 0, 0, 0), (30, "azure", 999, 9, 9, 9)):   # the last is older than 24 h
            d.execute("INSERT INTO ai_backend_usage(hour, backend, calls, prompt_tokens, completion_tokens, err_429, err_5xx, err_timeout) "
                      "VALUES (?,?,?,?,?,?,?,?)", (hr(h), be, calls, calls * 10, calls, e429, e5xx, tmo))
        d.commit()
        svc = a._ai_ins_health(d)["service"]
    mht = lambda h: (_dt.datetime.utcnow().replace(minute=0) - _dt.timedelta(hours=h) + _dt.timedelta(hours=8)).strftime("%H:00")  # noqa: E731
    s.check("AI service card: calls answered 147 (azure and the backup, not the 'none' row, not the row older than 24 h), the backup 7, "
            "not answered 5 (backend 'none'), failed attempts 6 by kind",
            (svc["calls"], svc["backup"], svc["none"], svc["err_total"], svc["errs"]["429"], svc["errs"]["5xx"], svc["errs"]["timeout"])
            == (147, 7, 5, 6, 2, 1, 3), svc)
    s.check("...the busiest hour is 100 calls, shown in MYT (the stored hour is UTC, +8)", (svc["busiest_n"], svc["busiest_h"]) == (100, mht(1)),
            (svc["busiest_n"], svc["busiest_h"], mht(1)))
    s.check("...24 bars oldest to newest labelled by MYT hour; the tallest is the busiest hour's",
            len(svc["bars"]) == 24 and svc["bars"][-2]["h"] == mht(1) and svc["bars"][-2]["pct"] == 100 and svc["bars"][-2]["peak"]
            and svc["bars"][-3]["n"] == 47, [(b["h"], b["n"]) for b in svc["bars"][-4:]])
    sc, html = get(SUP, "/admin/ai-insights")
    s.check("the card draws only what the table holds: no 'busiest minute', no 'slowest reply'",
            "Busiest hour" in html and "Answered by the backup" in html and "Not answered" in html and "Failed attempts" in html
            and "Busiest minute" not in html and "Slowest reply" not in html and "of the limit" not in html)

    # ------------------------------------------------------------------------------------------------------------------
    s.section("H. the Failed list: who, why in plain words, Search in, Try again")
    sc, lst = get(SUP, "/admin/list/ai-failed?fragment=1")
    s.check("the list opens in the panel for the super admin", sc == 200 and 'class="clp"' in lst, sc)
    s.check("it names each failed person (a name opens their page), with the Employee ID, part, when and why",
            all(("ZZAI-S%s" % n) in lst for n in ("4", "3", "5", "6")) and "Performance · the line manager&#39;s" in lst
            and "Competency" in lst and "A file" in lst and "data-person-open" in lst)
    s.check("...the why is in plain words, never the raw error",
            "The AI service didn&#39;t answer" in lst and "Its reply was cut off" in lst
            and "Its answer didn&#39;t hold up to OneHR&#39;s checks" in lst and "The file couldn&#39;t be read" in lst
            and "TimeoutError" not in lst and "SECRET" not in lst and "JSONDecodeError" not in lst and "ValueError" not in lst)
    s.check("...the panel's Search in is the shared one (a Search in menu and a box)", "data-qin" in lst and 'name="q"' in lst)
    sc, one = get(SUP, "/admin/list/ai-failed?fragment=1&q=ZZAI-S4")
    s.check("...and it narrows the list (one person)", sc == 200 and "ZZAI-S4" in one and "ZZAI-S3" not in one and "ZZAI-S6" not in one)
    sc, none_ = get(SUP, "/admin/list/ai-failed?fragment=1&q=nobody-called-this")
    s.check("...a search with no match says so", "Nothing has failed" in none_)
    s.check("pre-run off: the list says nothing can be tried again and offers no button",
            "not switched on here" in lst and "Try again</button>" not in lst and "Try all" not in lst)
    a._PRERUN["force"] = True
    sc, lst = get(SUP, "/admin/list/ai-failed?fragment=1")
    n_act = len(dbq("SELECT 1 FROM ai_prerun_jobs WHERE status='failed' AND cycle_id=?", (CID,)))
    s.check("pre-run on: each row has Try again (a form with the CSRF token's place, data-confirm naming who and what and that it "
            "sends their data to the AI service again) and the foot has 'Try all %d again'" % n_act,
            lst.count("Try again</button>") == n_act and "sends their results and files to the AI service, as the first try did" in lst
            and "AI+ writes ZZ AI ZZAI-S4&#39;s Performance insight" in lst and "Try all %d again" % n_act in lst
            and lst.count('data-confirm="') >= n_act + 1, n_act)
    # Try again
    with a.app.app_context():
        d = a.get_db()
        job = d.execute("SELECT * FROM ai_prerun_jobs WHERE status='failed' AND kind='pm_lm'").fetchone()
        done = d.execute("SELECT * FROM ai_prerun_jobs WHERE status='done' LIMIT 1").fetchone()
        other = d.execute("SELECT * FROM ai_prerun_jobs WHERE status='failed' AND kind='tc'").fetchone()
        d.execute("DELETE FROM activity_log WHERE action='ai_insight_retry'")
        d.commit()

    def state(jid):
        with a.app.app_context():
            r = a.get_db().execute("SELECT status, attempts, last_error, finished_at, not_before FROM ai_prerun_jobs WHERE id=?", (jid,)).fetchone()
            return tuple(r) if r else None
    url = "/admin/ai-insights/retry"
    rr = BAC.post(url, data={"job": job["id"], "csrf_token": "tok"})
    s.check("a BG admin's POST is refused and the job stays failed", rr.status_code in (302, 403) and state(job["id"])[0] == "failed", rr.status_code)
    rr = SUP.post(url, data={"job": job["id"]})
    s.check("the super admin's POST without the CSRF token is refused (400) and the job stays failed", rr.status_code == 400 and state(job["id"])[0] == "failed", rr.status_code)
    rr = SUP.post(url, data={"job": done["id"], "csrf_token": "tok"})
    s.check("a job that is not failed is refused (a done one is left as it was)", state(done["id"])[0] == "done", state(done["id"]))
    with a.app.app_context():
        d = a.get_db()
        other_cid = d.execute("SELECT id FROM cycles WHERE id!=? LIMIT 1", (CID,)).fetchone()
        if other_cid:
            d.execute("UPDATE ai_prerun_jobs SET cycle_id=? WHERE id=?", (other_cid[0], other["id"]))
            d.commit()
    rr = SUP.post(url, data={"job": other["id"], "csrf_token": "tok"})
    s.check("a job of a cycle that is not the active one is refused", bool(other_cid) and state(other["id"])[0] == "failed", state(other["id"]))
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE ai_prerun_jobs SET cycle_id=? WHERE id=?", (CID, other["id"]))
        d.commit()
    a._PRERUN["force"] = False
    rr = SUP.post(url, data={"job": job["id"], "csrf_token": "tok"})
    s.check("with the pre-run off it is refused: still failed, no audit row", state(job["id"])[0] == "failed"
            and not dbq("SELECT 1 FROM activity_log WHERE action='ai_insight_retry'"))
    a._PRERUN["force"] = True
    # Try again calls the one enqueue: let the real one through
    a._prerun_enqueue = _REAL["_prerun_enqueue"]
    rr = SUP.post(url, data={"job": job["id"], "csrf_token": "tok"}, follow_redirects=False)
    st = state(job["id"])
    s.check("Try again puts that failed job back in the queue: queued, attempts 0, no error, not finished, due now (and a flash says so)",
            st[0] == "queued" and st[1] == 0 and st[2] is None and st[3] is None, st)
    s.check("...the other failed jobs are untouched", state(other["id"])[0] == "failed")
    with a.app.app_context():
        rows = q(a.get_db(), "SELECT * FROM activity_log WHERE action='ai_insight_retry'")
        s.check("...one audit row naming whose insight, against that person", len(rows) == 1 and rows[0]["target_user_id"] == S6
                and "ZZ AI ZZAI-S6" in rows[0]["detail"] and "Performance" in rows[0]["detail"], [r["detail"] for r in rows])
    rr = SUP.post(url, data={"job": job["id"], "csrf_token": "tok"})
    s.check("...a second Try again on the same job (now queued, not failed) does nothing and logs nothing more",
            state(job["id"])[0] == "queued" and len(dbq("SELECT 1 FROM activity_log WHERE action='ai_insight_retry'")) == 1)
    with a.app.app_context():
        nf = a.get_db().execute("SELECT COUNT(*) FROM ai_prerun_jobs WHERE status='failed' AND cycle_id=?", (CID,)).fetchone()[0]
    rr = SUP.post(url, data={"all": "1", "csrf_token": "tok"})
    with a.app.app_context():
        left = a.get_db().execute("SELECT COUNT(*) FROM ai_prerun_jobs WHERE status='failed'").fetchone()[0]
        logged = a.get_db().execute("SELECT COUNT(*) FROM activity_log WHERE action='ai_insight_retry'").fetchone()[0]
        untouched = a.get_db().execute("SELECT COUNT(*) FROM ai_prerun_jobs WHERE status IN ('done','skipped')").fetchone()[0]
    s.check("Try all N again: all %d remaining failed jobs of the active cycle back in the queue, one audit row each (%d in all), "
            "done and skipped jobs untouched" % (nf, nf + 1), left == 0 and logged == nf + 1 and untouched == sum(1 for r in rows_ if r["status"] in ("done", "skipped")), (left, logged, untouched))

    # ------------------------------------------------------------------------------------------------------------------
    s.section("I. plain words for a failure")
    f = a._ai_ins_fail_words
    s.check("the four reasons map from the stored error, never raw",
            f("pm_lm", "model unavailable") == "The AI service didn't answer" and f("pm_lm", "ReadTimeout: timed out") == "The AI service didn't answer"
            and f("tc", "JSONDecodeError: Expecting value") == "Its reply was cut off"
            and f("idp", "ValueError: nope") == "Its answer didn't hold up to OneHR's checks"
            and f("attach", "retry") == "The file couldn't be read" and f("pm_lm", None) == "The AI service didn't answer")
finally:
    # ----------------------------------------------------------------------------------------------------------------------
    for _n, _f in _REAL.items():
        if _n == "ai_draft._chat_complete_call":
            a.ai_draft._chat_complete_call = _f
        else:
            setattr(a, _n, _f)
    a.get_db = _orig_get_db
    a._PRERUN["force"] = False
    with a.app.app_context():
        d = a.get_db()
        d.execute("PRAGMA foreign_keys=ON")
        ids = [r[0] for r in d.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZAI-%'")]
        if ids:
            ph = ",".join("?" * len(ids))
            for t in ("pm_perf_summaries", "pm_calib_summaries", "pm_remark_summaries", "tc_summaries", "pm_idp_summaries",
                      "pot_calib_summaries", "pot_remark_summaries"):
                d.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (t, ph), ids)
            d.execute("DELETE FROM pm_review_session WHERE subject_id IN (%s)" % ph, ids)
            d.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
            d.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
        d.execute("DELETE FROM buceo_seats WHERE business_group IN (?,?)", (BG, BG2))
        d.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG, BG2))
        d.execute("DELETE FROM ai_prerun_jobs")
        d.execute("DELETE FROM ai_backend_usage")
        d.execute("DELETE FROM activity_log WHERE action IN ('view_ai_insight','ai_insight_retry')")
        for row in KEEP.get("jobs", []):
            d.execute("INSERT INTO ai_prerun_jobs VALUES (%s)" % ",".join("?" * len(row)), row)
        for row in KEEP.get("usage", []):
            d.execute("INSERT INTO ai_backend_usage VALUES (%s)" % ",".join("?" * len(row)), row)
        d.execute("DELETE FROM admin_role_access WHERE role_id=? AND item=?", (ROLE_BG, ITEM))
        if KEEP.get("cycle"):
            d.execute("UPDATE cycles SET half=? WHERE id=?", (KEEP["cycle"]["half"], CID))
            d.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key IN ('review','calibration','pm','tm','idp')", (CID,))
            for row in KEEP["cycle"]["modules"]:
                d.execute("INSERT INTO cycle_modules VALUES (?,?,?,?,?)", row)
        d.commit()

sys.exit(s.done())
