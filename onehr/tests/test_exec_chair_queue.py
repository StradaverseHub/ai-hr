"""The Executive Chairman view, piece P4b: the super admin's Final bands queue shows his lock (2026-10-29).

Before: the queue read the cascade WITHOUT his tier (skip_tiers=("super","group")), so a BU CEO who is also in a Group Chief's
group showed the Group Chief's call as the suggestion and "Accept the suggestion" could write a super-tier band over the
Executive Chairman's lock, unseen. Now:
  * a person with a chair lock has HIS locked band as the queue's incoming / suggested band, on both axes, labelled for the super
    admin ("the Executive Chairman's lock", "Executive Chairman") -- the super admin may know; no leader's page ever does
  * the super tier stays above his: the super admin can still decide any band, and a decision is a super-tier row
  * "Accept the suggestion" accepts HIS band; the bulk "accept the clear ones" skips a row he locked
  * flag off: the queue reads exactly as it did even with a chair_locks row in the table
  * a leader's pages (the BG CEO's Talent Box data, the Group Chief's queue-side pages) never say "Chairman"
  * every guard is FALSIFIED
Synthetic ZZ9PQ people only; a fresh_db suite."""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Executive Chairman, P4b: the Final bands queue shows his lock")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
os.environ.pop("ONEHR_CHAIR", None)
SU, _BGA0, _E = H.actors(a)
REMARK = "ZZ9PQ super admin remark for the test"


def run(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def sql(q, args=()):
    def f(d):
        d.execute(q, args)
        d.commit()
    run(f)


BG1 = "ZZ9PQ BG ONE"
ids = {}
with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycles SET half=2, kind='year_end', no_potential=NULL, min_job_grade=NULL WHERE id=?", (CID,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base if c != "id"]

    def mk(tag, **kw):
        eid = "ZZ9PQ-" + tag
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ PQ " + tag, display_name=None, email=None,
                 hod_id=None, manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None,
                 confirmation_date="2020-01-01", left_at=None, role="user", is_demo=0, user_role_id=None, job_grade="22",
                 business_group=BG1, company="ZZ9PQ UNIT", department="ZZ Dept", job_title="CHIEF " + tag, years_of_service=9)
        v.update(kw)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v.get(c) for c in cols])
        ids[tag] = db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
    for t in ("CH", "GC", "BU", "PL"):   # the chair, a Group Chief, a BU CEO in the group (locked by him), a plain member
        mk(t)
    db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES (?,?)", ("ZZ9PQ GROUP", ids["GC"]))
    GID = db.execute("SELECT id FROM pm_calibration_groups WHERE name='ZZ9PQ GROUP'").fetchone()[0]
    for t in ("BU", "PL"):
        db.execute("INSERT INTO pm_calibration_group_members(group_id, subject_id, segment, source) VALUES (?,?,?,?)",
                   (GID, ids[t], "ZZ9PQ", "person"))
    sess = {}

    def session(tbl, tier, key, locked):
        db.execute("INSERT INTO %s(cycle_id, tier, scope_key, business_group, scope_label, locked_at) VALUES (?,?,?,?,?,?)" % tbl,
                   (CID, tier, key, BG1, key, "2026-11-20 03:00:00" if locked else None))
        sess[(tbl, tier)] = db.execute("SELECT id FROM %s WHERE cycle_id=? AND tier=? AND scope_key=?" % tbl,
                                       (CID, tier, key)).fetchone()[0]

    def adj(tbl, tier, tag, band):
        t = "pm_calibration_adjustments" if tbl.startswith("pm") else "calibration_adjustments"
        db.execute("INSERT INTO %s(session_id, subject_id, original_band, adjusted_band, justification, adjusted_by, seen_band, "
                   "pinned) VALUES (?,?,?,?,?,?,?,?)" % t, (sess[(tbl, tier)], ids[tag], band, band, "", SU["id"], band, "lm"))
    PMT, POT = "pm_calibration_sessions", "calibration_sessions"
    for tbl in (PMT, POT):
        session(tbl, "bgceo", BG1, True)
        session(tbl, "group", str(GID), True)
    # the BG CEO's call on both (AE / Mid), the Group Chief's locked call on both (BE / Low): the two the queue showed before
    for tag in ("BU", "PL"):
        adj(PMT, "bgceo", tag, "AE")
        adj(POT, "bgceo", tag, "Mid")
        adj(PMT, "group", tag, "BE")
        adj(POT, "group", tag, "Low")
        db.execute("INSERT INTO pm_group_locks(cycle_id, group_id, subject_id, band, locked_by) VALUES (?,?,?,?,?)",
                   (CID, GID, ids[tag], "BE", SU["id"]))
        db.execute("INSERT INTO pot_group_locks(cycle_id, group_id, subject_id, band, locked_by) VALUES (?,?,?,?,?)",
                   (CID, GID, ids[tag], "Low", SU["id"]))
    db.commit()
CH, GC, BU, PL = (ids[k] for k in ("CH", "GC", "BU", "PL"))
SUP = H.client_as(a, SU["id"])
GCC = H.client_as(a, GC)
PERIOD = run(lambda d: dict(a.active_pm_period(d)))

# a scorecard for everyone in the group (the queue lists people with a final rating; the KPI fixture is not what is tested)
_real_ov, _real_pop = a.pm_final_overalls, a.pm_calibration_population_sql
a.pm_final_overalls = lambda db_, pid_, ids_: {i: {"label": "ME", "score": 3.0} for i in ids_}
a.pm_calibration_population_sql = lambda prefix="": "(? IS NOT NULL)"
FINAL = "/admin/calibration/final-bands"


def rows(axis):
    def f(d):
        fn = a._final_bands_rows_pot if axis == "pot" else None
        if fn:
            r_, _m = fn(d, CID, GID)
        else:
            r_, _m = a._final_bands_rows(d, a.active_pm_period(d), GID)
        return {x["p"]["id"]: x for x in r_}
    return run(f)


def page(axis="pm"):
    r = SUP.get("%s?g=%d%s" % (FINAL, GID, "&axis=pot" if axis == "pot" else ""))
    return r.status_code, r.get_data(as_text=True)


def lock_chair(tag, pm="OU", pot="High"):
    sql("INSERT INTO chair_locks(cycle_id, subject_id, axis, band, locked_by) VALUES (?,?,'pm',?,?)", (CID, ids[tag], pm, CH))
    sql("INSERT INTO chair_locks(cycle_id, subject_id, axis, band, locked_by) VALUES (?,?,'pot',?,?)", (CID, ids[tag], pot, CH))


def super_rows():
    return H.one(a, "SELECT (SELECT COUNT(*) FROM pm_calibration_adjustments x JOIN pm_calibration_sessions z ON z.id=x.session_id "
                    "WHERE z.tier='super' AND z.cycle_id=?) + (SELECT COUNT(*) FROM calibration_adjustments x JOIN "
                    "calibration_sessions z ON z.id=x.session_id WHERE z.tier='super' AND z.cycle_id=?)", (CID, CID))


try:
    # ------------------------------------------------------------------------------------------------ baseline, flag on, no lock
    os.environ["ONEHR_CHAIR"] = "1"
    sql("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('exec_chair_id', ?)", (str(CH),))
    s.section("before his lock: the queue is as it was (the Group Chief's call is the suggestion)")
    rp, rt = rows("pm"), rows("pot")
    s.check("both axes: no chair field, the Group Chief's locked call is the suggestion, and the BG CEO's call is the BG CEO column",
            all(rp[i]["chair"] is None and rp[i]["sug"] == "BE" and rp[i]["bg"] == "AE" for i in (BU, PL))
            and all(rt[i]["chair"] is None and rt[i]["sug"] == "Low" and rt[i]["bg"] == "Mid" for i in (BU, PL)),
            [(rp[i]["sug"], rp[i]["bg"], rt[i]["sug"], rt[i]["bg"]) for i in (BU, PL)])
    code, body = page()
    s.check("the page reads, and says nothing of a chairman", code == 200 and "Executive Chairman" not in body, code)

    # ------------------------------------------------------------------------------------------------ with his lock
    s.section("with his lock on one person: his band IS the incoming / suggested band, labelled for the super admin")
    lock_chair("BU")
    rp, rt = rows("pm"), rows("pot")
    s.check("performance: the BU CEO's suggestion is his locked band, not the Group Chief's, with the Executive Chairman's reason",
            rp[BU]["sug"] == "OU" and rp[BU]["chair"] == "OU" and rp[BU]["why"] == a.CHAIR_QUEUE_WHY and rp[BU]["tie"] is None,
            (rp[BU]["sug"], rp[BU]["why"]))
    s.check("potential: the same, High", rt[BU]["sug"] == "High" and rt[BU]["chair"] == "High" and rt[BU]["why"] == a.CHAIR_QUEUE_WHY)
    s.check("the BG CEO's and the Group Chief's own calls stay as they were in their columns (BE / AE; Low / Mid)",
            rp[BU]["chief"] == "BE" and rp[BU]["bg"] == "AE" and rt[BU]["chief"] == "Low" and rt[BU]["bg"] == "Mid")
    s.check("the other member (no chair lock) is untouched: still the Group Chief's call, no label",
            rp[PL]["sug"] == "BE" and rp[PL]["chair"] is None and rt[PL]["sug"] == "Low" and rt[PL]["chair"] is None)
    s.check("a locked row is never one of the 'clear' ones the bulk accept writes; the member who has none still is",
            rp[BU]["agreed"] is False and rt[BU]["agreed"] is False and rp[PL]["agreed"] is True and rt[PL]["agreed"] is True,
            (rp[BU]["agreed"], rp[PL]["agreed"]))
    code, body = page()
    chunk = body.split('id="p%d"' % BU)[1].split('id="p%d"' % PL)[0] if ('id="p%d"' % BU) in body else body
    s.check("the super admin's page names it on his row, and only on his row", code == 200 and "Executive Chairman" in chunk
            and "the Executive Chairman&#39;s lock" in chunk.replace("'", "&#39;") and "data-chair-lock" in chunk
            and "Executive Chairman" not in body.split('id="p%d"' % PL)[1], code)
    s.check("...and the decide box starts on HIS band (OU), not the Group Chief's (BE)",
            re.search(r'<option value="OU" selected', chunk) is not None, chunk[-600:])
    code, body = page("pot")
    s.check("potential tab: his row says it and starts on High", code == 200 and "data-chair-lock" in body
            and re.search(r'<option value="High" selected', body) is not None)

    # ------------------------------------------------------------------------------------------------ accept = his band; super stays above
    s.section("Accept the suggestion accepts HIS band; the super tier stays above his")
    n0 = super_rows()
    r = SUP.post(FINAL, data={"csrf_token": "tok", "action": "decide", "g": str(GID), "subject_id": str(BU), "band": "OU",
                              "remark": REMARK})
    pm = run(lambda d: a.pm_effective_band(d, d.execute("SELECT * FROM users WHERE id=?", (BU,)).fetchone(), CID, None))
    s.check("accepting writes his band (OU) as the super tier: the same band, never the Group Chief's BE or the BG CEO's AE",
            r.status_code in (200, 302) and super_rows() == n0 + 1 and pm["band"] == "OU" and pm["source"] == "super", (pm, super_rows()))
    r = SUP.post(FINAL, data={"csrf_token": "tok", "action": "decide", "g": str(GID), "subject_id": str(BU), "band": "ME",
                              "remark": REMARK})
    pm = run(lambda d: a.pm_effective_band(d, d.execute("SELECT * FROM users WHERE id=?", (BU,)).fetchone(), CID, None))
    s.check("the super admin may still decide another band: the super tier is above his lock (ME wins over OU)",
            pm["band"] == "ME" and pm["source"] == "super", pm)
    s.check("his locked row is still there under it, untouched", H.one(a, "SELECT band FROM chair_locks WHERE cycle_id=? AND "
                                                                         "subject_id=? AND axis='pm'", (CID, BU)) == "OU")
    r = SUP.post(FINAL, data={"csrf_token": "tok", "action": "clear", "g": str(GID), "subject_id": str(BU), "remark": REMARK})
    pm = run(lambda d: a.pm_effective_band(d, d.execute("SELECT * FROM users WHERE id=?", (BU,)).fetchone(), CID, None))
    s.check("clearing the super band returns to HIS band (above the Group Chief's), as the cascade says", pm["band"] == "OU"
            and pm["source"] == a.CHAIR_SOURCE, pm)
    n1 = super_rows()
    r = SUP.post(FINAL, data={"csrf_token": "tok", "action": "accept_agreed", "g": str(GID), "remark": REMARK})
    s.check("the bulk accept wrote only the member with no lock: one performance row and one potential row would be two, but "
            "the BU CEO got none (his lock is never bulk-accepted)",
            r.status_code in (200, 302) and super_rows() == n1 + 1
            and H.one(a, "SELECT COUNT(*) FROM pm_calibration_adjustments x JOIN pm_calibration_sessions z ON z.id=x.session_id "
                         "WHERE z.tier='super' AND z.cycle_id=? AND x.subject_id=?", (CID, BU)) == 0,
            (super_rows() - n1))

    # ------------------------------------------------------------------------------------------------ nobody else
    s.section("the queue is the super admin's: a leader never sees it, and no leader's page says 'Chairman'")
    r = GCC.get("%s?g=%d" % (FINAL, GID))
    s.check("the Group Chief is refused the queue (not 200)", r.status_code != 200 and "Executive Chairman" not in r.get_data(as_text=True),
            r.status_code)
    gc_pages = [GCC.get(p_) for p_ in ("/review/journey", "/review/team", "/dashboard")]
    s.check("the Group Chief's own pages never say Chairman or name his lock",
            not any(re.search(r"chairman|chair_locks", x.get_data(as_text=True), re.I) for x in gc_pages),
            [x.status_code for x in gc_pages])
    s.check("a leader's band reads (the cascade below the Group Chief's seat) never carry his tier",
            run(lambda d: a.pm_effective_band(d, d.execute("SELECT * FROM users WHERE id=?", (BU,)).fetchone(), CID, "ME",
                                              skip_tiers=("super", "group"))["source"] != a.CHAIR_SOURCE))

    # ------------------------------------------------------------------------------------------------ flag off
    s.section("flag off: the queue reads as it did even with the lock row in the table")
    os.environ.pop("ONEHR_CHAIR", None)
    sql("DELETE FROM pm_calibration_adjustments WHERE session_id IN (SELECT id FROM pm_calibration_sessions WHERE tier='super')")
    sql("DELETE FROM calibration_adjustments WHERE session_id IN (SELECT id FROM calibration_sessions WHERE tier='super')")
    rp, rt = rows("pm"), rows("pot")
    s.check("flag off: no chair field, the Group Chief's call is the suggestion, the label is not on the page",
            rp[BU]["chair"] is None and rp[BU]["sug"] == "BE" and rt[BU]["chair"] is None and rt[BU]["sug"] == "Low"
            and "Executive Chairman" not in page()[1])

    # ------------------------------------------------------------------------------------------------ falsify
    s.section("falsified: take each guard away and the difference shows")
    os.environ["ONEHR_CHAIR"] = "1"
    rp = rows("pm")
    s.check("control: with the flag on and his lock the label shows again", rp[BU]["chair"] == "OU" and "data-chair-lock" in page()[1])
    real = a._final_bands_chair_band
    try:
        a._final_bands_chair_band = lambda *x, **k: None
        rp = rows("pm")
        s.check("falsified (no chair read): the suggestion falls back to the Group Chief's BE and the label goes: the read is what "
                "holds it", rp[BU]["sug"] == "BE" and rp[BU]["chair"] is None and "data-chair-lock" not in page()[1])
    finally:
        a._final_bands_chair_band = real
    real_ag = a.CHAIR_QUEUE_WHY
    s.check("his reason is one declared word, shown to the super admin only (the template is the super-only page)",
            a.CHAIR_QUEUE_WHY == "the Executive Chairman's lock"
            and "data-chair-lock" not in open(os.path.join(H.REPO, "templates", "dashboard.html"), encoding="utf-8").read())
    s.check("the queue route is super_required (a leader gets no page)", "super_required" in open(
        os.path.join(H.REPO, "app.py"), encoding="utf-8").read().split("def admin_final_bands(")[0][-200:])
finally:
    os.environ.pop("ONEHR_CHAIR", None)
    a.pm_final_overalls, a.pm_calibration_population_sql = _real_ov, _real_pop
    sql("DELETE FROM chair_locks WHERE cycle_id=?", (CID,))
    sql("DELETE FROM app_settings WHERE key IN ('exec_chair_id','exec_chair_delegate_id','exec_chair_team')")

H.restore_db()
sys.exit(s.done())
