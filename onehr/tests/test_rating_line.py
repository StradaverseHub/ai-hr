"""1-5 rating lines (Chris, 2026-10-30, Option B of canvas [design canvas link removed]; "whole
ratings only"): a KPI line whose Rate 1 to 5 are exactly 1, 2, 3, 4, 5 AND whose unit is "Rating" is PICKED from the KPI's
own words, never typed, and the server refuses anything but a whole rating from 1 to 5 on every path that writes a figure.

What this suite holds:
  * the helper (`kpi_is_rating_line`): 1-5 + Rating yes; the same scale + "Number" no; 5,4,3,2,1 no; method is not part of it
  * `_rating_line_error`: 12, 0, 6, 3.5 refused; 3 taken; a figure line next to it takes anything
  * every writer: the employee's Save / save-all, the chat tool (`record_kpi_result`), the classic autosave and submit-all,
    the line manager's moderation draft and commit (and the manager agent's tool), the on-behalf draft and commit
  * a typed 12 in /review/kpi/preview counts as not typed (the Total is as without it)
  * the payloads: `direction_say` / `rating_line` added, `direction` unchanged ("higher is better")
  * the agents' rule, the Help answer, the KB sentence (reworded once, never over an admin's edit), Ask OneHR's fact
  * the client: the one shared pick, and the tables use it (static guards)
  * the guard is FALSIFIED by hand: with the call taken out of `_review_record_one` the "12 is refused" checks fail

Writes, so a fresh copy, put back at the end. Synthetic ZZ people only.
"""
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("1-5 rating lines: pick the rating by its words; the server refuses anything else")
assert H.SCRATCH_MARKER in a.DB_PATH
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
read = lambda *p: open(os.path.join(ROOT, *p)).read()
PICK = a.RATING_LINE_PICK_MSG

ctx = a.app.test_request_context("/")
ctx.push()
db = a.get_db()
CID = a.active_cycle_id(db)
db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','evidence','tm','pm')", (CID,))
db.execute("UPDATE cycles SET kind='mid_year', half=2, starts_on=NULL WHERE id=?", (CID,))
db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES('review_unified','1')")
P = dict(a.active_pm_period(db))
base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 AND UPPER(TRIM(COALESCE(job_grade,'')))!='H' AND business_group IN "
                       "(SELECT business_group FROM pm_bg_config WHERE mechanism='A') LIMIT 1").fetchone())
BG, CO = base["business_group"], base["company"]
cols = [c for c in base if c != "id"]
ids = {}
for nm in ("LM", "ME", "M1", "M2", "M3", "M4", "BEH"):
    v = dict(base, username="zzrl-" + nm.lower(), employee_id="ZZRL-" + nm, full_name="ZZ Rating " + nm, display_name=None,
             email=None, hod_id=None, manager_id=(None if nm == "LM" else ids["LM"]), buceo_bg=None, buceo_company=None,
             bgceo_bg=None, confirmation_date="2020-01-01", left_at=None, role="user")
    db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v.get(c) for c in cols])
    ids[nm] = db.execute("SELECT id FROM users WHERE employee_id=?", ("ZZRL-" + nm,)).fetchone()[0]
user = lambda i: dict(db.execute("SELECT * FROM users WHERE id=?", (i,)).fetchone())
LM, ME = ids["LM"], ids["ME"]
lm, me = user(LM), user(ME)
WORDS = ("Rate the year against these. Rating 1 = more than 10 complaints not closed in time; Rating 2 = 6 to 10 not "
         "closed in time; Rating 3 (Target): 3 to 5 not closed in time; Rating 4 = 1 to 2 not closed in time; "
         "Rating 5 = every complaint closed in time.")


def mk(who, name, unit, rates, w, method="more", desc=None, result=None, draft=1):
    """One KPI line for `who`, LM the one approver; `result` keyed as a draft (draft=1) or submitted (draft=0)."""
    db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, company, unit, "
               "rate1, rate2, rate3, rate4, rate5, status, description) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'approved',?)",
               (P["id"], who, name, w, method, BG, CO, unit) + tuple(rates) + (desc,))
    tid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,?,?)", (tid, 1, LM))
    if result is not None:
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,?,?,?)",
                   (tid, result, who, draft))
    return tid


RL, FG = mk(ME, "ZZ Complaints handled", "Rating", (1, 2, 3, 4, 5), 50, desc=WORDS), \
    mk(ME, "ZZ Cases closed", "Number", (2, 4, 6, 8, 10), 50)
# the line manager's people: each has a rating line (their figure submitted) and a figure line beside it
mod = {}
for who in ("M1", "M2", "M3", "M4"):
    mod[who] = (mk(ids[who], "ZZ Complaints handled", "Rating", (1, 2, 3, 4, 5), 50, desc=WORDS, result=4, draft=0),
                mk(ids[who], "ZZ Cases closed", "Number", (2, 4, 6, 8, 10), 50, result=7, draft=0))
# someone who never submitted (on their behalf), a rating line and a figure line, a figure saved on neither
BEH = ids["BEH"]
bl = (mk(BEH, "ZZ Complaints handled", "Rating", (1, 2, 3, 4, 5), 50, desc=WORDS),
      mk(BEH, "ZZ Cases closed", "Number", (2, 4, 6, 8, 10), 50))
db.commit()

NOW = a._now_myt()
fmt = lambda d: d.strftime("%Y-%m-%d %H:%M")


def windows(employee_closed=False):
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    emp = (fmt(NOW - timedelta(days=9)), fmt(NOW - timedelta(days=1))) if employee_closed else \
        (fmt(NOW - timedelta(days=2)), fmt(NOW + timedelta(days=3)))
    lmw = (fmt(NOW - timedelta(days=1)), fmt(NOW + timedelta(days=6)))
    for cell in ("pm_results", "tc_self"):
        db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (CID, cell) + emp)
    for cell in ("pm_approve", "tc_approve"):
        db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (CID, cell) + lmw)
    db.commit()
    a.g.pop("_cycle_windows", None)   # read once per request: this suite is one long request


stored = lambda tid: H.one(a, "SELECT actual_value FROM pm_kpi_results WHERE kpi_target_id=?", (tid,)) \
    if H.rows(a, "SELECT 1 FROM pm_kpi_results WHERE kpi_target_id=?", (tid,)) else None

# ------------------------------------------------------------------ the helper
s.section("what a rating line is")
L = lambda unit="Rating", rates=(1, 2, 3, 4, 5), method="more": dict(
    unit=unit, method=method, rate1=rates[0], rate2=rates[1], rate3=rates[2], rate4=rates[3], rate5=rates[4])
s.check("1,2,3,4,5 with unit Rating is a rating line", a.kpi_is_rating_line(L()))
s.check("the same scale with unit Number is not", not a.kpi_is_rating_line(L(unit="Number")))
s.check("...nor % or no unit", not a.kpi_is_rating_line(L(unit="%")) and not a.kpi_is_rating_line(L(unit=None)))
s.check("5,4,3,2,1 with unit Rating is not (a count, lower is better)",
        not a.kpi_is_rating_line(L(rates=(5, 4, 3, 2, 1), method="less")))
s.check("1,2,3,4,6 and 2,4,6,8,10 are not", not a.kpi_is_rating_line(L(rates=(1, 2, 3, 4, 6)))
        and not a.kpi_is_rating_line(L(rates=(2, 4, 6, 8, 10))))
s.check("the method is not part of it: 'less' and none are still rating lines",
        a.kpi_is_rating_line(L(method="less")) and a.kpi_is_rating_line(L(method=None)))
s.check("the unit is read as the app normalises it (any case, spaces)",
        a.kpi_is_rating_line(L(unit="rating")) and a.kpi_is_rating_line(L(unit="  RATING ")))
s.check("a missing rung is not a rating line", not a.kpi_is_rating_line(L(rates=(1, 2, 3, 4, None))))
s.check("a database row reads the same as a dict", a.kpi_is_rating_line(db.execute(
    "SELECT * FROM pm_kpi_targets WHERE id=?", (RL,)).fetchone()) and not a.kpi_is_rating_line(db.execute(
    "SELECT * FROM pm_kpi_targets WHERE id=?", (FG,)).fetchone()))
RLD, FGD = dict(L()), dict(L(unit="Number", rates=(2, 4, 6, 8, 10)))
for v in (12, 0, 6, 3.5, 0.5, -1, 100, float("nan"), float("inf")):
    s.check("%r is refused on a rating line" % v, a._rating_line_error(RLD, v) == PICK, a._rating_line_error(RLD, v))
for v in (1, 2, 3, 4, 5, 3.0, "4"):
    s.check("%r is taken on a rating line" % (v,), a._rating_line_error(RLD, v) is None)
s.check("a figure line takes anything, and nothing given is never an error",
        all(a._rating_line_error(FGD, v) is None for v in (12, 0, 6, 3.5)) and a._rating_line_error(RLD, None) is None)

# ------------------------------------------------------------------ the employee's writers
windows(employee_closed=False)
E = H.client_as(a, ME)
s.section("the employee's Save: save-all and the one writer")
for v in ("12", "0", "6", "3.5"):
    r = E.post("/review/kpi/save-all", data={"csrf_token": "tok", "actual_value_%d" % RL: v})
    j = r.get_json() or {}
    s.check("save-all refuses %s on the rating line, with the one sentence, and stores nothing" % v,
            r.status_code == 200 and j.get("recorded") == [] and [e.get("error") for e in j.get("errors") or []] == [PICK]
            and stored(RL) is None, j.get("errors"))
r = E.post("/review/kpi/save-all", data={"csrf_token": "tok", "actual_value_%d" % RL: "3", "actual_value_%d" % FG: "12"})
j = r.get_json() or {}
s.check("save-all takes Rating 3, and a figure line beside it still takes 12",
        len(j.get("recorded") or []) == 2 and not j.get("errors") and stored(RL) == 3.0 and stored(FG) == 12.0,
        j.get("errors"))
s.check("...the 12 on the figure line is scored by its own scale (Rating 5), the 3 is Rating 3",
        {x["kpi"]: x["rating"] for x in j.get("recorded") or []} == {"ZZ Complaints handled": "3.0 of 5",
                                                                     "ZZ Cases closed": "5.0 of 5"}, j.get("recorded"))
r = E.post("/review/kpi/save-all", data={"csrf_token": "tok", "actual_value_%d" % RL: "12"})
s.check("a 12 over a saved 3 is refused and the 3 stays", stored(RL) == 3.0)
res = a._review_record_one(db, me, CID, RL, 12.0)
s.check("_review_record_one itself refuses 12, 0, 6 and 3.5", res == {"ok": False, "error": PICK}
        and all(a._review_record_one(db, me, CID, RL, float(v)).get("error") == PICK for v in (0, 6, 3.5)), res)
s.check("...and takes 4", a._review_record_one(db, me, CID, RL, 4.0).get("ok") is True and stored(RL) == 4.0)

s.section("the chat's record_kpi_result")
res = a._review_tool_record_kpi(db, me, CID, {"kpi_id": RL, "actual_value": "12"})
s.check("a 12 comes back refused, with the sentence and what to do next (ask against the words, never the table)",
        res.get("ok") is False and res["error"].startswith(PICK) and "ask which rating" in res["error"]
        and "do not ask them to type it in the table" in res["error"], res)
res = a._journey_tool_record_kpi(db, me, CID, {"kpi_id": RL, "actual_value": "12"})
s.check("...the same on the journey's tool", res.get("ok") is False and res["error"].startswith(PICK), res)
s.check("...and nothing changed", stored(RL) == 4.0)
res = a._journey_tool_record_kpi(db, me, CID, {"kpi_id": RL, "actual_value": "3"})
s.check("a 3 records Rating 3", res.get("ok") is True and res["rating"] == "3.0 of 5" and stored(RL) == 3.0, res)
res = a._journey_tool_record_kpi(db, me, CID, {"kpi_id": FG, "actual_value": "12"})
s.check("a 12 on the figure line is recorded as before", res.get("ok") is True and stored(FG) == 12.0, res)
batch = a._journey_batch(db, me, CID, a._journey_tool_record_kpi,
                         {"items": [{"kpi_id": RL, "actual_value": "9"}, {"kpi_id": FG, "actual_value": "7"}]})
s.check("several in one call: the rating line refused, the other recorded",
        stored(RL) == 3.0 and stored(FG) == 7.0, batch)

s.section("the classic page's autosave and submit-all")
r = E.post("/performance/kpi/%d/autosave" % RL, data={"csrf_token": "tok", "actual_value": "12"})
s.check("autosave refuses 12 (400, bad_rating) and the stored 3 stays",
        r.status_code == 400 and (r.get_json() or {}).get("reason") == "bad_rating" and stored(RL) == 3.0,
        (r.status_code, r.get_json()))
r = E.post("/performance/kpi/%d/autosave" % RL, data={"csrf_token": "tok", "actual_value": "3.5"})
s.check("...and 3.5", r.status_code == 400 and stored(RL) == 3.0)
r = E.post("/performance/kpi/%d/autosave" % RL, data={"csrf_token": "tok", "actual_value": "5"})
s.check("autosave takes 5", r.status_code == 200 and (r.get_json() or {}).get("value_saved") and stored(RL) == 5.0,
        (r.status_code, r.get_json()))
r = E.post("/performance/kpi/%d/autosave" % FG, data={"csrf_token": "tok", "actual_value": "12"})
s.check("autosave takes 12 on the figure line", r.status_code == 200 and stored(FG) == 12.0, r.status_code)
r = E.post("/performance/submit-all", data={"csrf_token": "tok", "actual_value_%d" % RL: "12", "actual_value_%d" % FG: "9"})
s.check("submit-all refuses the batch for a 12 on the rating line (all or nothing): nothing is submitted",
        H.one(a, "SELECT COUNT(*) FROM pm_kpi_results WHERE draft=0 AND kpi_target_id IN (?,?)", (RL, FG)) == 0
        and stored(RL) == 5.0 and stored(FG) == 12.0, r.status_code)

s.section("the Total follows a typed figure, but not a 12 on a rating line")
base_ov = (E.get("/review/kpi/preview").get_json() or {}).get("overall")
ov12 = (E.get("/review/kpi/preview?actual_value_%d=12" % RL).get_json() or {}).get("overall")
s.check("a typed 12 on the rating line leaves the Total as without it", ov12 == base_ov and base_ov, (ov12, base_ov))
ov35 = (E.get("/review/kpi/preview?actual_value_%d=3.5" % RL).get_json() or {}).get("overall")
s.check("...and 3.5 and 0", ov35 == base_ov and (E.get("/review/kpi/preview?actual_value_%d=0" % RL).get_json() or {})
        .get("overall") == base_ov)
ov2 = (E.get("/review/kpi/preview?actual_value_%d=2" % RL).get_json() or {}).get("overall")
s.check("a typed 2 is counted (the Total moves)", ov2 and ov2 != base_ov, (ov2, base_ov))
ovf = (E.get("/review/kpi/preview?actual_value_%d=12" % FG).get_json() or {}).get("overall")
s.check("a typed 12 on the figure line is counted as ever", ovf and ovf["value"] == "%.1f" % ((5 * 50 + 5 * 50) / 100.0),
        ovf)

# ------------------------------------------------------------------ the line manager's writers
s.section("the line manager's moderation: draft and commit")
windows(employee_closed=False)
m1r, m1f = mod["M1"]
for v in ("12", "0", "6", "3.5"):
    res, err = a._pm_moderate_draft(db, lm, m1r, v, None)
    s.check("a moderated %s on the rating line is refused (draft)" % v,
            res is None and err and err["reason"] == "bad_rating" and err["code"] == 400 and err["msg"] == PICK, err)
s.check("...and nothing was drafted", not H.rows(a, "SELECT 1 FROM pm_kpi_moderation_drafts WHERE kpi_target_id=?", (m1r,)))
res, err = a._pm_moderate_draft(db, lm, m1r, "3", None)
s.check("a moderated 3 is drafted", err is None and res["ok"] and res["mod_n"] == 3, (res, err))
res, err = a._pm_moderate_draft(db, lm, m1r, "", None)
s.check("confirm-as-is (no value) is not a figure: no error", err is None and res["ok"], err)
res, err = a._pm_moderate_draft(db, lm, m1f, "12", None)
s.check("a moderated 12 on the figure line beside it is drafted as ever", err is None and res["ok"], err)
res, err = a._pm_moderate_draft(db, lm, m1r, None, "ZZ why")
s.check("a justification alone (value left out) is untouched by the guard", err is None and res["ok"], err)
r = H.client_as(a, LM).post("/performance/kpi/%d/moderate-draft-autosave" % m1r,
                            data={"csrf_token": "tok", "adjusted_value": "12"})
s.check("the draft route answers 400 for a 12", r.status_code == 400, (r.status_code, r.get_json()))

m2r, m2f = mod["M2"]
for v in ("12", "0", "6", "3.5"):
    res, err = a._pm_moderate_commit(db, lm, m2r, v, None)
    s.check("locking at %s on the rating line is refused (commit)" % v,
            res is None and err and err["reason"] == "bad_rating" and err["msg"] == PICK, err)
s.check("...and nothing was locked", not H.rows(a, "SELECT 1 FROM pm_kpi_approvals WHERE kpi_target_id=?", (m2r,)))
db.execute("INSERT OR REPLACE INTO pm_kpi_moderation_drafts(kpi_target_id, approver_id, adjusted_value) VALUES (?,?,12)",
           (m2r, LM))   # an older draft that got in before the guard
db.commit()
res, err = a._pm_moderate_commit(db, lm, m2r, None, None)
s.check("a 12 left in an older draft is not locked either", res is None and err and err["reason"] == "bad_rating", err)
res, err = a._pm_moderate_commit(db, lm, m2r, "", None)
s.check("confirming their own figure as-is is not a figure typed: it locks",
        err is None and H.rows(a, "SELECT 1 FROM pm_kpi_approvals WHERE kpi_target_id=? AND action='confirm'", (m2r,)),
        err)
m3r, m3f = mod["M3"]
res, err = a._pm_moderate_commit(db, lm, m3r, "3", None)
s.check("locking at 3 is taken", err is None and H.rows(
    a, "SELECT 1 FROM pm_kpi_approvals WHERE kpi_target_id=? AND action='adjust' AND adjusted_value=3", (m3r,)), err)
res, err = a._pm_moderate_commit(db, lm, m3f, "12", None)
s.check("locking the figure line at 12 is taken as ever", err is None, err)
m4r, _m4f = mod["M4"]
out = a._mgr_tool_moderate_kpi(db, lm, CID, ids["M4"], {"kpi_id": m4r, "value": "12"})
s.check("the manager agent's moderate tool returns the same refusal", out.get("ok") is False and out["error"] == PICK, out)
out = a._mgr_tool_moderate_kpi(db, lm, CID, ids["M4"], {"kpi_id": m4r, "value": "5"})
s.check("...and takes a 5", out.get("ok") is True, out)

s.section("assessing on someone's behalf")
windows(employee_closed=True)
res, err = a._pm_behalf_draft(db, lm, BEH, bl[0], "12")
s.check("a 12 on the rating line is refused", res is None and err and err["reason"] == "bad_rating" and err["msg"] == PICK, err)
for v in ("0", "6", "3.5"):
    res, err = a._pm_behalf_draft(db, lm, BEH, bl[0], v)
    s.check("...and %s" % v, res is None and err and err["reason"] == "bad_rating", err)
s.check("...nothing was drafted", not H.rows(a, "SELECT 1 FROM pm_kpi_moderation_drafts WHERE kpi_target_id=?", (bl[0],)))
res, err = a._pm_behalf_draft(db, lm, BEH, bl[0], "3")
s.check("a 3 is drafted", err is None and res["lines"][0]["value"] == 3.0, (res, err))
res, err = a._pm_behalf_draft(db, lm, BEH, bl[1], "12")
s.check("a 12 on the figure line is drafted as ever", err is None, err)
db.execute("UPDATE pm_kpi_moderation_drafts SET adjusted_value=12 WHERE kpi_target_id=?", (bl[0],))   # a stale draft
db.commit()
res, err = a._pm_behalf_commit(db, lm, BEH)
s.check("confirming with a 12 left in a draft is refused, naming the KPI",
        res is None and err and err["reason"] == "bad_rating" and "ZZ Complaints handled" in err["msg"], err)
s.check("...and nothing was recorded for them", not H.rows(a, "SELECT 1 FROM pm_kpi_approvals WHERE kpi_target_id IN (?,?)",
                                                             bl))

# ------------------------------------------------------------------ the payloads
s.section("what the tables are given")
windows(employee_closed=False)
s.check("a rating line says how it is rated, short and long",
        a._kpi_direction_say(RLD) == "Rated 1 to 5 · 5 is best"
        and a._kpi_direction_say_full(RLD) == "Rated 1 to 5 by the wording · 5 is best")
s.check("a figure line says what it always did", a._kpi_direction_say(FGD) == "higher is better"
        and a._kpi_direction_say_full(FGD) == "" and a._kpi_direction_plain(RLD) == "higher is better")
ov = a._review_kpi_overview(db, me)["data"]["lines"]
byk = {x["kpi_id"]: x for x in ov}
s.check("the check-in table: direction_say + rating_line on the rating line, direction unchanged",
        byk[RL]["rating_line"] is True and byk[RL]["direction_say"] == "Rated 1 to 5 · 5 is best"
        and byk[RL]["direction_say_full"].startswith("Rated 1 to 5 by the wording")
        and byk[RL]["direction"] == "higher is better", byk[RL])
s.check("...the figure line beside it: rating_line false, direction_say is its own words, direction the same",
        byk[FG]["rating_line"] is False and byk[FG]["direction_say"] == "higher is better"
        and byk[FG]["direction"] == "higher is better" and byk[FG]["direction_say_full"] == "", byk[FG])
tdata = a._journey_team_pm_data(db, lm, ids["M1"], "ZZ")
tl = {x["id"]: x for x in tdata["lines"]}
s.check("the line manager's table: the same fields, and direction still the literal the perf summary compares",
        tl[m1r]["rating_line"] is True and tl[m1r]["direction_say"] == "Rated 1 to 5 · 5 is best"
        and tl[m1r]["direction"] == "higher is better" and tl[m1f]["rating_line"] is False
        and tl[m1f]["direction"] == "higher is better", (tl[m1r]["direction"], tl[m1f]["direction"]))
windows(employee_closed=True)
bdata = a._journey_team_pm_data(db, lm, BEH, "ZZ")
bl_ = {x["id"]: x for x in bdata["lines"]}
s.check("...the on-behalf card's lines carry them too (the card is open)",
        (bdata.get("behalf") or {}).get("open") and bl_[bl[0]]["rating_line"] is True and bl_[bl[1]]["rating_line"] is False
        and bl_[bl[0]]["direction_say"] == "Rated 1 to 5 \u00b7 5 is best" and bl_[bl[0]]["direction"] == "higher is better",
        bdata.get("behalf"))
windows(employee_closed=False)
kt = a._calib_kpi_table(db, ids["M1"], P["id"])
cl = {x["id"]: x for x in kt["lines"]}
s.check("the calibrators' table: the same, direction unchanged",
        cl[m1r]["rating_line"] is True and cl[m1r]["direction_say"] == "Rated 1 to 5 · 5 is best"
        and cl[m1r]["direction"] == "higher is better" and cl[m1f]["rating_line"] is False, cl[m1r]["direction"])
agent_lines = {x["kpi_id"]: x for x in a._review_kpi_lines(db, me)}
s.check("the agent's lines: rating_line and the scale as a pick against the wording, 5 best",
        agent_lines[RL]["rating_line"] is True and agent_lines[RL]["scale"].startswith("a 1-5 rating: the person picks the "
        "rating whose wording (in the description) fits their year") and "5 is best" in agent_lines[RL]["scale"]
        and agent_lines[FG]["rating_line"] is False and agent_lines[FG]["scale"].startswith("5-point ladder"),
        (agent_lines[RL]["scale"], agent_lines[FG]["scale"]))
s.check("a rating reads 'Rating 4' in the agent's text, never '4 Rating'",
        a._pm_fig_unit("4", "Rating") == "Rating 4" and a._pm_fig_unit("12", "RM (mil)") == "12 RM (mil)"
        and a._pm_fig_unit("42", "%") == "42%")

s.section("the agents' rule")
st = a.review_state(db, me)
sysm = a._review_agent_system(db, me, st, journey=True)
s.check("the check-in agent is told: read the words, ask which rating, never ask for a figure, never convert one",
        "RATING LINES" in sysm and "which rating, 1 to 5, fits" in sysm and "Never ask for or record a raw figure" in sysm
        and "never turn a figure into a rating yourself" in sysm and "come from the tool result" in sysm)
s.check("...in the standalone check-in as well", "RATING LINES" in a._review_agent_system(db, me, st, journey=False))
plain = user(ids["M1"])
db.execute("UPDATE pm_kpi_targets SET unit='Number' WHERE subject_id=? AND cycle_id=?", (ids["M1"], P["id"]))
db.commit()
s.check("a person with no rating line is not given the rule",
        "RATING LINES" not in a._review_agent_system(db, plain, a.review_state(db, plain), journey=True))
db.execute("UPDATE pm_kpi_targets SET unit='Rating' WHERE id=?", (m1r,))
db.commit()
task = a._journey_team_stage_task(db, lm, "pm_review", ids["M1"])
s.check("the line manager's moderation agent is told the same (and the line is marked)",
        "RATING LINES" in task and "never a figure" in task and '"rating_line": true' in task, task[-400:])

# ------------------------------------------------------------------ help, KB, Ask OneHR
s.section("Help, the KB and Ask OneHR")
s.check("the Help answer, in Group People's words",
        a.HELP_QA["kpi_rating"] == ("Some KPIs ask for a rating, not a figure. Why?",
                                    "Some KPIs are rated 1 to 5 by their own words. Pick the rating whose words fit your "
                                    "year; Read all shows what each means. 5 is best."))
keys = a.HELP_LISTS["mine_kpi"][1]
s.check("...listed with the other KPI check-in answers", keys.index("kpi_rating") == keys.index("kpi_agent") + 1
        and "kpi_file" in keys and "kpi_who" in keys, keys)
SENT = "Some KPIs are rated 1 to 5 by their own words: you pick the rating that fits, not a figure."
s.check("the KB body carries the sentence, once", a._KPI_CHECKIN_BODY.count(SENT) == 1
        and a._KPI_CHECKIN_BODY_BEFORE_RATING.count(SENT) == 0
        and a._KPI_CHECKIN_BODY.replace(SENT + " ", "") == a._KPI_CHECKIN_BODY_BEFORE_RATING)
body = lambda: H.one(a, "SELECT body FROM kb_entries WHERE slug='kpi-check-in'")
s.check("a freshly seeded database already has it", body() == a._KPI_CHECKIN_BODY)
db.execute("UPDATE kb_entries SET body=? WHERE slug='kpi-check-in'", (a._KPI_CHECKIN_BODY_BEFORE_RATING,))
db.commit()
a._ensure_runtime_schema()
s.check("a live row on the old text is reworded by the boot", body() == a._KPI_CHECKIN_BODY)
edited = a._KPI_CHECKIN_BODY + " ZZ an admin's own words."
db.execute("UPDATE kb_entries SET body=? WHERE slug='kpi-check-in'", (edited,))
db.commit()
a._ensure_runtime_schema()
s.check("a second boot does not re-apply it (and an edit stays)", body() == edited)
admin_old = a._KPI_CHECKIN_BODY_BEFORE_RATING + " ZZ an admin's own words."
db.execute("UPDATE kb_entries SET body=? WHERE slug='kpi-check-in'", (admin_old,))
db.commit()
a._ensure_runtime_schema()
s.check("an admin's edit of the old text is never overwritten", body() == admin_old)
db.execute("UPDATE kb_entries SET body=? WHERE slug='kpi-check-in'", (a._KPI_CHECKIN_BODY,))
db.commit()
facts, _links = a._ask_facts(db, me, {})
s.check("Ask OneHR's facts carry the sentence", any(SENT in x for x in facts))

# ------------------------------------------------------------------ the client
s.section("the client: one pick, and the tables use it")
KL, JC, RC, CSS = read("static", "kpi_line.js"), read("static", "journey_chat.js"), read("static", "review_chat.js"), \
    read("static", "style.css")
s.check("kpi_line.js has ONE shared pick on window.onehrKpiLine, a listbox of the KPI's own words",
        KL.count("pick: function (l, opts)") == 1 and 'setAttribute("role", "listbox")' in KL
        and 'setAttribute("role", "option")' in KL and "parseRatings(l.detail" in KL and '"Pick 1 to 5"' in KL)
s.check("...with no words it is chips only (Lowest, Best) and 'Pick a rating'",
        '"Pick a rating"' in KL and '"Lowest"' in KL and '"Best"' in KL)
s.check("...Esc closes, arrows move, one popover at a time, click outside closes",
        '"Escape"' in KL and '"ArrowDown"' in KL and "_pickClose" in KL and 'addEventListener("mousedown", onDoc, true)' in KL)
s.check("the quiet line prints direction_say, and Read all's meta the long form",
        "l.direction_say" in KL and "direction_say_full" in KL and "K.meta(l, true)" in KL)
s.check("the check-in, the line manager's moderation and the on-behalf tables all build the pick the one way",
        JC.count("kpiPickFor(") >= 4 and "l.rating_line" in JC and JC.count("KL.pick(l,") == 1)
s.check("a recorded or locked rating line reads 'Rating 3', never '3 Rating'",
        'l.rating_line ? "Rating " + l.result' in JC and "kpiFigSay(l, l.report_value)" in JC)
s.check("the hidden input keeps Save, the live rung and the Total working",
        'rin.type = "hidden"; rin.className = "rv-res-input"' in JC and 'rin.addEventListener("input", kpiPreviewSoon);' in JC
        and "kpiLiveMark(rin, l)" in JC)
s.check("the classic chat table draws the same pick and prints the same meta",
        "window.onehrKpiLine.pick(line," in RC and "l.direction_say || l.direction" in RC)
s.check("the pick's look is one block of CSS: 168 x 38, navy ring, a fixed popover over the table",
        re.search(r"\.kpi-pick \{[^}]*width: 168px;[^}]*height: 38px;", CSS)
        and re.search(r"\.kpi-pick-pop \{[^}]*position: fixed;[^}]*width: 420px;", CSS)
        and "kpi-pick" in CSS and "#D61923" not in CSS.split(".kpi-pick {", 1)[1].split(".pp-kname", 1)[0])

H.restore_db()
sys.exit(s.done())
