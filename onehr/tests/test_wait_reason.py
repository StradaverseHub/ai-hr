"""The Team summary's wait chip says WHY a person waits (Chris, 2026-11-11: "show the reason instead of 'Waiting on them'").

A not-done person with nothing for the line manager to moderate now reads: "Group People to fill the BU KPI" (a BU KPI line
nobody has filled yet), else "With another approver" (a submitted line whose turn belongs to someone else in its chain);
the hover (`wait_why`) names the KPI and the approver. The queue's list is "Waiting". The client chip shows the row's own
status words. Synthetic ZZ people only; a fresh_db suite, so Suite.done() puts the scratch copy back.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("The wait chip says why: Group People to fill the BU KPI, With another approver")
assert H.SCRATCH_MARKER in a.DB_PATH

ctx = a.app.test_request_context("/")
ctx.push()
db = a.get_db()
CID = a.active_cycle_id(db)
P = dict(a.active_pm_period(db))
db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=?", (CID,))
base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 AND UPPER(TRIM(COALESCE(job_grade,'')))!='H' AND business_group IN "
                       "(SELECT business_group FROM pm_bg_config WHERE mechanism='A') LIMIT 1").fetchone())
BG, CO = base["business_group"], base["company"]
cols = [c for c in base if c != "id"]
ids = {}
for eid, mgr in (("LM", None), ("MX", None), ("BUP", "LM"), ("BUF", "LM"), ("OTH", "LM"), ("OKA", "LM"), ("UNS", "LM")):
    v = dict(base, username="zzwr-" + eid.lower(), employee_id="ZZWR-" + eid, full_name="ZZ Wait " + eid, display_name=None,
             email=None, hod_id=None, manager_id=ids.get(mgr), buceo_bg=None, buceo_company=None, bgceo_bg=None,
             confirmation_date="2020-01-01", left_at=None, role="user")
    db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v.get(c) for c in cols])
    ids[eid] = db.execute("SELECT id FROM users WHERE employee_id=?", ("ZZWR-" + eid,)).fetchone()[0]
LM, MX, BUP, BUF, OTH, OKA, UNS = (ids[k] for k in ("LM", "MX", "BUP", "BUF", "OTH", "OKA", "UNS"))
SUP = db.execute("SELECT id FROM users WHERE role='admin' AND left_at IS NULL LIMIT 1").fetchone()[0]
BU_NAME = "ZZWR BU PAT"
db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, method, rate1, rate2, "
           "rate3, rate4, rate5, bu_level, active) VALUES (?, '*', '*', 0, '*', ?, 'more', 80, 90, 100, 110, 120, 1, 1)",
           (BG, BU_NAME))


def line(sid, name, w, chain):
    t = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, rate4, "
                   "rate5, business_group, company, department, unit, status) VALUES (?,?,?,?,'more',1,2,3,4,5,?,?,?,'%','approved')",
                   (P["id"], sid, name, w, BG, CO, base["department"])).lastrowid
    for seq, ap in enumerate(chain, 1):
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,?,?)", (t, seq, ap))
    return t


def submit(t, sid, v=3.0):
    db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,?,?,0)", (t, v, sid))


def approve(t, seq, by, v=3.0):
    db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, acted_by) VALUES (?,?,'confirm',?,?)",
               (t, seq, v, by))


# BUP: their own line is submitted and the line manager confirmed it; the BU line's turn is MX's first, no figure yet
own1 = line(BUP, "ZZWR Own sales", 50, [LM])
submit(own1, BUP); approve(own1, 1, LM)
bu1 = line(BUP, BU_NAME, 50, [MX, LM])
# BUF: the same, but the BU line is the line manager's own step next (what today reads "Not submitted yet")
own2 = line(BUF, "ZZWR Own sales", 50, [LM])
submit(own2, BUF); approve(own2, 1, LM)
bu2 = line(BUF, BU_NAME, 50, [LM])
# OTH: a submitted line that MX moderates first, then the line manager
oth1 = line(OTH, "ZZWR Collection", 100, [MX, LM])
submit(oth1, OTH)
# OKA: a plain one for the line manager to moderate
oka1 = line(OKA, "ZZWR Collection", 100, [LM])
submit(oka1, OKA)
# UNS: an own line never submitted, the line manager's step next (still "Not submitted yet" / "Didn't submit")
line(UNS, "ZZWR Own sales", 100, [LM])
db.commit()
lm = dict(db.execute("SELECT * FROM users WHERE id=?", (LM,)).fetchone())
mx_name = db.execute("SELECT full_name FROM users WHERE id=?", (MX,)).fetchone()[0]


def reports():
    return {r["id"]: r for r in a._journey_team_reports(db, lm, "pm_review")}


s.section("a BU KPI nobody has filled yet")
r = reports()
s.check("the BU line really is a BU KPI for them (the names rule the review uses)",
        BU_NAME.lower() in a.pm_bu_level_names(db, dict(db.execute("SELECT * FROM users WHERE id=?", (BUP,)).fetchone()), P["id"]))
s.check("their own line is locked and the BU line is not: nothing to moderate, not done",
        not r[BUP]["done"] and not r[BUP]["pend"] and not r[BUP]["action"], r[BUP])
s.check("the row says Group People to fill the BU KPI", r[BUP]["meta"] == "Group People to fill the BU KPI", r[BUP]["meta"])
s.check("...and the hover names the KPI", r[BUP]["wait_why"] and BU_NAME in r[BUP]["wait_why"]
        and r[BUP]["wait_why"].startswith("Group People to fill the BU KPI"), r[BUP]["wait_why"])
s.check("a BU line with the line manager next and no figure, own lines moderated: the BU reason, no Assess action, not behalf",
        r[BUF]["meta"] == "Group People to fill the BU KPI" and not r[BUF]["action"] and not r[BUF]["behalf"]
        and BU_NAME in (r[BUF]["wait_why"] or ""), r[BUF])
from datetime import timedelta  # noqa: E402
_n = a._now_myt()
_f = lambda d: d.strftime("%Y-%m-%d %H:%M")
db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
           (CID, "pm_results", _f(_n - timedelta(days=9)), _f(_n - timedelta(days=1))))
db.commit()
a.g.pop("_cycle_windows", None)
r = reports()
s.check("...also once their own check-in window has closed (it read Didn't submit)",
        r[BUF]["meta"] == "Group People to fill the BU KPI" and not r[BUF]["action"] and not r[BUF]["behalf"], r[BUF])
s.check("FALSIFY: an own line never submitted still reads Didn't submit (behalf)",
        r[UNS]["meta"].startswith("Didn't submit") and r[UNS]["behalf"], r[UNS])
db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
db.commit()
a.g.pop("_cycle_windows", None)
r = reports()
s.check("FALSIFY: ...and with the window open, Not submitted yet", r[UNS]["meta"] == "Not submitted yet", r[UNS])
sm = {x["id"]: x for x in a._journey_team_summary(db, lm, "pm_review")["rows"]}
s.check("the Team summary row carries status and wait_why", sm[BUP]["status"] == r[BUP]["meta"]
        and sm[BUP]["wait_why"] == r[BUP]["wait_why"], sm[BUP])
# FALSIFY: Group People fills the BU line -> the reason goes
db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft, admin_filled) VALUES (?,?,?,0,1)",
           (bu1, 100.0, SUP))
db.commit()
r = reports()
s.check("FALSIFY: once the BU line has Group People's figure the row is done, with no wait reason",
        r[BUP]["done"] and r[BUP]["meta"] == "Reviewed" and not r[BUP]["wait_why"], r[BUP])

s.section("a submitted line with someone else's turn")
s.check("With another approver", r[OTH]["meta"] == "With another approver" and not r[OTH]["pend"] and not r[OTH]["action"], r[OTH])
s.check("...the hover names the approver and the count", mx_name in (r[OTH]["wait_why"] or "")
        and "1 KPI line to moderate next" in r[OTH]["wait_why"], r[OTH]["wait_why"])
s.check("a person it is the manager's turn for is unchanged: N to moderate, no wait reason",
        r[OKA]["meta"] == "1 to moderate" and not r[OKA]["wait_why"], r[OKA])
approve(oth1, 1, MX)   # FALSIFY: the other approver acts, so it is the line manager's turn
db.commit()
r = reports()
s.check("FALSIFY: once the other approver has acted it is theirs: 1 to moderate, no wait reason",
        r[OTH]["meta"] == "1 to moderate" and not r[OTH]["wait_why"], r[OTH])
s.check("every row has the wait_why key (None when nothing waits)", all("wait_why" in x for x in r.values()))

s.section("the moderation table flags a BU line, the queue is 'Waiting'")
card = a._journey_team_pm_data(db, lm, BUP, "ZZ Wait BUP")
fl = {l["kpi"]: l.get("bu_level") for l in card["lines"]}
s.check("the card's lines say which one is a BU line (a person who is not BU-only still gets Group People fills this in)",
        fl.get(BU_NAME) is True and fl.get("ZZWR Own sales") is False and not card.get("bu_only"), (fl, card.get("bu_only")))
items = [{"id": 1, "name": "ZZ A", "turn": False, "done": False, "meta": "With another approver"},
         {"id": 2, "name": "ZZ B", "turn": False, "done": True, "meta": "Reviewed"}]
q = a._team_queue(items, None, "summary")
labels = [x.get("label") for x in (q.get("lists") or [])]
s.check("the queue's waiting list is labelled Waiting", "Waiting" in labels and "Waiting on them" not in labels, (labels, list(q)))
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "journey_chat.js")).read()
i = src.index("function statusCell(r)")
stc = src[i:i + 2500]
s.check("client: the wait chip says the row's own words and hovers the full reason",
        '(r.done ? "Done" : (r.status || "Waiting"))' in stc and "c.title = r.wait_why || r.status;" in stc
        and '"Waiting on them"' not in stc)
s.check("client: the KPI table says Group People fills this in for a BU line",
        '((ctx && ctx.buOnly) || l.bu_level ? "Group People fills this in" : "Not submitted yet")' in src)
sys.exit(s.done())
