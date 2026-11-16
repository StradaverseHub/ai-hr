"""The Team summary tells the bulk approve box who the line manager has NOT moderated (Chris, 2026-10-27, "option B": the
box lists anyone the AI+ check found not or only partly justified whose results the manager hasn't moderated, with a Go
to their page; the manager may approve the others only).

What this suite holds:
  * `lm_moderated` on every Team summary row, both stages. PM: false with no change from this manager; true once they hold
    a figure that differs from the person's own (a committed adjustment OR a saved draft); false again where their figure
    equals the person's own, where they only confirmed, or where the figure is another approver's. TM: false with no call
    of theirs; true where their answer differs from the person's self answer; false where it equals it.
  * the PM read is ONE batched query for the whole team, never one per person
  * the guard is falsified: with the flag stubbed always-false the "true" expectations fail
  * the client carries the awareness strings, the alt button and the wider card (a static guard)
Synthetic ZZ people only; a fresh_db suite, so Suite.done() puts the scratch copy back.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("lm_moderated on the Team summary rows; the bulk approve's awareness box")
assert H.SCRATCH_MARKER in a.DB_PATH

ctx = a.app.test_request_context("/")
ctx.push()
db = a.get_db()
CID = a.active_cycle_id(db)
P = dict(a.active_pm_period(db))
db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=?", (CID,))
base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 AND UPPER(TRIM(COALESCE(job_grade,'')))!='H' AND business_group IN "
                       "(SELECT business_group FROM pm_bg_config WHERE mechanism='A') LIMIT 1").fetchone())
cols = [c for c in base if c != "id"]
ids = {}
NAMES = ("LM", "MX", "A", "B", "C", "D", "E", "F", "T1", "T2", "T3")
for nm in NAMES:
    v = dict(base, username="zzlmm-" + nm.lower(), employee_id="ZZLMM-" + nm, full_name="ZZ Mod " + nm, display_name=None,
             email=None, hod_id=None, manager_id=(None if nm in ("LM", "MX") else ids["LM"]), buceo_bg=None,
             buceo_company=None, bgceo_bg=None, confirmation_date="2020-01-01", left_at=None, role="user")
    db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v.get(c) for c in cols])
    ids[nm] = db.execute("SELECT id FROM users WHERE employee_id=?", ("ZZLMM-" + nm,)).fetchone()[0]
user = lambda i: dict(db.execute("SELECT * FROM users WHERE id=?", (i,)).fetchone())
LM, MX = ids["LM"], ids["MX"]
lm = user(LM)

# ---- PM: two lines each, the person's own figure keyed and submitted, the line manager the one approver (F: MX is)
lines = {}
for who in ("A", "B", "C", "D", "E", "F"):
    for name, unit, w in (("ZZ Sales revenue", "RM (mil)", 60), ("ZZ Collection", "%", 40)):
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, company,"
                   " unit, rate1, rate2, rate3, rate4, rate5, status) VALUES (?,?,?,?,?,?,?,?,1,2,3,4,5,'approved')",
                   (P["id"], ids[who], name, w, "more", base["business_group"], base["company"], unit))
        tid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        lines.setdefault(who, []).append(tid)
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,?,?)", (tid, 1, LM))
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,?,?,0)",
                   (tid, 3.0, ids[who]))
db.commit()


def approval(tid, action, orig, adj, by):
    db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, adjusted_value, acted_by) "
               "VALUES (?,1,?,?,?,?)", (tid, action, orig, adj, by))


def draft(tid, adj, by):
    db.execute("INSERT INTO pm_kpi_moderation_drafts(kpi_target_id, approver_id, adjusted_value) VALUES (?,?,?)",
               (tid, by, adj))


def pm_flags():
    rows = a._journey_team_summary(db, lm, "pm_review")["rows"]
    return {r["id"]: r.get("lm_moderated") for r in rows}


base_flags = pm_flags()
s.section("PM")
s.check("every PM row carries the flag, and it is a boolean",
        all(ids[w] in base_flags and isinstance(base_flags[ids[w]], bool) for w in "ABCDEF"), base_flags)
s.check("nobody has moderated: false for everyone", not any(base_flags[ids[w]] for w in "ABCDEF"), base_flags)

approval(lines["B"][0], "adjust", 3.0, 4.0, LM)         # B: a committed adjustment that differs
draft(lines["C"][1], 2.0, LM)                            # C: a saved draft that differs
approval(lines["D"][0], "adjust", 3.0, 3.0, LM)         # D: an 'adjust' that lands on their own figure
approval(lines["D"][1], "confirm", 3.0, None, LM)       # ...and a confirm
draft(lines["E"][0], 3.0, LM)                            # E: a draft equal to their own
draft(lines["E"][1], None, LM)                           # ...and an empty one
approval(lines["F"][0], "adjust", 3.0, 5.0, MX)         # F: another approver's figure, never this manager's
db.commit()
fl = pm_flags()
s.check("a committed adjustment that differs counts", fl[ids["B"]] is True, fl)
s.check("a saved draft that differs counts", fl[ids["C"]] is True, fl)
s.check("a figure equal to theirs, or a confirm, is not moderation", fl[ids["D"]] is False, fl)
s.check("a draft equal to theirs, or an empty one, is not moderation", fl[ids["E"]] is False, fl)
s.check("another approver's figure is not this manager's moderation", fl[ids["F"]] is False, fl)
s.check("the person nobody touched stays false", fl[ids["A"]] is False, fl)

# put the manager's draft back to equal their own: false again
db.execute("UPDATE pm_kpi_moderation_drafts SET adjusted_value=3.0 WHERE kpi_target_id=?", (lines["C"][1],))
db.commit()
s.check("...and false again once the manager's figure equals the person's own", pm_flags()[ids["C"]] is False)

# one batched read for the team, not one per person
seen = []
db.set_trace_callback(lambda q: seen.append(q))
a._journey_team_summary(db, lm, "pm_review")
db.set_trace_callback(None)
n_reads = sum(1 for q in seen if "pm_kpi_approvals" in q and "pm_kpi_moderation_drafts" in q)
s.check("the moderated read is ONE query for the whole team (%d people)" % 6, n_reads == 1, n_reads)

# falsify: stub the guard always-false and the 'true' expectations must fail
_real = a._pm_lm_moderated_ids
a._pm_lm_moderated_ids = lambda *x, **k: set()
stub = pm_flags()
a._pm_lm_moderated_ids = _real
s.check("FALSIFIED: with the flag always false, B (committed adjustment) would read not moderated",
        stub[ids["B"]] is False and pm_flags()[ids["B"]] is True)

# ---- TM: three people with a submitted self-assessment of two competencies each
skills = [r[0] for r in db.execute("SELECT id FROM tc_skills ORDER BY id LIMIT 2")]
tca = {}
for who in ("T1", "T2", "T3"):
    for sk, fut in zip(skills, (0, 1)):
        db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future) VALUES (?,?,?,?)",
                   (CID, ids[who], sk, fut))
        tca.setdefault(who, []).append(db.execute("SELECT last_insert_rowid()").fetchone()[0])
    db.commit()
    asm = a.tc_get_or_create_assessment(db, CID, ids[who])
    db.execute("UPDATE tc_assessments SET status='submitted' WHERE id=?", (asm["id"],))
    for asg in tca[who]:
        db.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer, remark) VALUES (?,?,'yes','ZZ note')",
                   (asm["id"], asg))
db.commit()


def tm_flags():
    rows = a._journey_team_summary(db, lm, "tm_review")["rows"]
    return {r["id"]: r.get("lm_moderated") for r in rows}


s.section("TM")
t0 = tm_flags()
s.check("every TM row carries the flag; nobody changed a call: false",
        all(ids[w] in t0 and t0[ids[w]] is False for w in ("T1", "T2", "T3")), t0)
asm2 = db.execute("SELECT id FROM tc_assessments WHERE subject_id=? AND cycle_id=?", (ids["T2"], CID)).fetchone()[0]
asm3 = db.execute("SELECT id FROM tc_assessments WHERE subject_id=? AND cycle_id=?", (ids["T3"], CID)).fetchone()[0]
db.execute("UPDATE tc_scores SET manager_answer='no' WHERE assessment_id=? AND assignment_id=?", (asm2, tca["T2"][0]))
db.execute("UPDATE tc_scores SET manager_answer='yes' WHERE assessment_id=?", (asm3,))
db.commit()
t1 = tm_flags()
s.check("a competency answered differently from the person's own: true", t1[ids["T2"]] is True, t1)
s.check("the manager's answer equal to theirs: false", t1[ids["T3"]] is False, t1)
s.check("nothing changed for the third: false", t1[ids["T1"]] is False, t1)
db.execute("UPDATE tc_scores SET manager_answer='yes' WHERE assessment_id=?", (asm2,))
db.commit()
s.check("...and false again once their answer equals the person's", tm_flags()[ids["T2"]] is False)
db.execute("UPDATE tc_scores SET manager_answer='no' WHERE assessment_id=? AND assignment_id=?", (asm2, tca["T2"][0]))
db.commit()
_rows = a._tc_rows


def _never_moderated(*x, **k):
    rows, g = _rows(*x, **k)
    for r in rows:
        r["moderated"] = False
    return rows, g


a._tc_rows = _never_moderated
stub = tm_flags()
a._tc_rows = _rows
s.check("FALSIFIED: with the flag always false, T2 would read not moderated", stub[ids["T2"]] is False
        and tm_flags()[ids["T2"]] is True)
s.check("the plan stage's rows are untouched (no flag)",
        all("lm_moderated" not in r for r in a._journey_team_summary(db, lm, "plan_review")["rows"]))

# ---- the client: the awareness strings, the alt button, the wider card
s.section("the client")
js = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "journey_chat.js")).read()
css = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "style.css")).read()
for what, needle in (
        ("the heading", '"For your awareness: " + flagged.length + " of them"'),
        ("the PM line", "you haven't moderated any of their KPI lines. Approving locks their own figures as they stand."),
        ("the TM line", "you haven't changed any of their competency ratings. Approving locks their own ratings as they stand."),
        ("the note", "Go to opens their page; nothing is approved yet."),
        ("Approve all", '"Approve all " + checked.length'),
        ("Approve the other", '"Approve the other " + others.length'),
        ("the Go to bubble", "Nothing was approved. The AI+ check found"),
        ("the alt button", "opts.alt"), ("Go to closes the box", "opts.bindClose(close)"), ("the wide card", "rv-confirm-wide"),
        ("the flag read off the row", "lm_moderated: !!r.lm_moderated")):
    s.check("journey_chat.js has %s" % what, needle in js, needle)
s.check("only a flagged person who is not moderated is named", "if (info.lm_moderated || info.pending) return;" in js)
s.check("the wide card is 560px and the alt button is a navy outline",
        re.search(r"\.modal-card\.rv-confirm-wide\s*\{\s*max-width:\s*560px", css)
        and re.search(r"\.modal-actions button\.alt\s*\{[^}]*border:\s*1px solid var\(--accent-line\)", css))   # a navy outline: the accent line token
s.check("the server's approve route is untouched by the box (one POST route, no awareness params)",
        "lm_moderated" not in H.source(a, "app.py").split("def review_team_approve_bulk(", 1)[1].split("\n@app.route", 1)[0])

ctx.pop()
sys.exit(s.done())
