"""Bulk panel build -- 1b15c25.

RECONSTRUCTED after a macOS cleanup lost the original; same invariants, taken
from the commit's own record.

The whole safety claim of that page is that it only ever INSERTs, so most of
what follows asserts what must NOT have changed. The CLI it replaced opens with
`DELETE FROM assignments WHERE cycle_id=?` -- the whole cycle, submitted
feedback included -- which is why the page is strictly additive.

THIS SUITE WRITES, so it asks the harness for a fresh database copy. Its rule
checks are DELTAS, never absolutes: the data already carries letter-grade
subjects with a non-LM assessor, subjects with two line managers and people over
the peer cap, all from earlier builds and imports. Asserting absolute zero would
fail on data this page never touched and hide the real claim, which is "does not
make it worse".
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Bulk panel build")
SU, BG, EMP = H.actors(a)
S = H.client_as(a, SU["id"])
with a.app.app_context():
    CID = a.active_cycle_id(a.get_db())


def snapshot():
    """Everything the page promises not to touch."""
    return {
        "total": H.one(a, "SELECT COUNT(*) FROM assignments WHERE cycle_id=?", (CID,)),
        "archived": H.one(a, "SELECT COUNT(*) FROM assignments WHERE cycle_id=? "
                             "AND archived=1", (CID,)),
        "submitted": H.one(a, "SELECT COUNT(*) FROM assignments WHERE cycle_id=? "
                              "AND status='submitted'", (CID,)),
        "released": H.one(a, "SELECT COUNT(*) FROM report_releases WHERE cycle_id=?", (CID,)),
    }


def violations():
    """Rule breaches present in the data. Absolutes here are NOT zero."""
    q = lambda sql: H.one(a, sql, (CID,))  # noqa: E731
    return {
        "letter_nonlm": q("SELECT COUNT(*) FROM assignments x JOIN users u ON u.id=x.subject_id "
                          "WHERE x.cycle_id=? AND x.archived=0 AND x.relationship!='line_manager' "
                          "AND CAST(u.job_grade AS INTEGER)=0 "
                          "AND TRIM(COALESCE(u.job_grade,''))!=''"),
        "two_lm": q("SELECT COUNT(*) FROM (SELECT subject_id FROM assignments WHERE cycle_id=? "
                    "AND archived=0 AND relationship='line_manager' GROUP BY subject_id "
                    "HAVING COUNT(*)>1)"),
        # the cap is on everything a person rates, in any role (Chris, 2026-10-20)
        "over_cap": H.one(a, "SELECT COUNT(*) FROM (SELECT assessor_id FROM assignments "
                             "WHERE cycle_id=? AND archived=0 "
                             "GROUP BY assessor_id HAVING COUNT(*)>?)", (CID, a._ba.ASSESSOR_CAP)),
        "self": q("SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND subject_id=assessor_id"),
        "leaver": q("SELECT COUNT(*) FROM assignments x JOIN users u ON u.id=x.assessor_id "
                    "WHERE x.cycle_id=? AND x.archived=0 AND u.left_at IS NOT NULL"),
    }


s.section("the page")
s.check("super GET -> 200", S.get("/admin/panels/build").status_code == 200)
s.check("employee -> 403", H.client_as(a, EMP["id"]).get("/admin/panels/build").status_code == 403)
s.check("linked from the admin nav",
        any(p["ep"] == "admin_panel_build" for m in a.ADMIN_MODULES for p in m["pages"]))

s.section("preview writes NOTHING")
before = snapshot()
r = S.post("/admin/panels/build", data={"csrf_token": "tok", "mode": "missing"})
s.check("preview -> 200", r.status_code == 200, r.status_code)
s.check("assignment count unchanged", snapshot()["total"] == before["total"],
        (before["total"], snapshot()["total"]))
s.check("says nothing has changed yet", "nothing has been changed yet" in r.get_data(as_text=True))

s.section("the plan")
with a.app.test_request_context("/"):
    from flask import session
    session["user_id"] = SU["id"]
    db = a.get_db()
    plan = a._panel_build_plan(db, SU, CID, "missing")
    target = a.panel_target()
s.note("in_scope=%d eligible=%d changed=%d to_create=%d short=%d"
       % (plan["in_scope"], plan["eligible"], plan["changed"], plan["to_create"],
          len(plan["short"])))
s.check("panel size comes from panel_target(), not the engine's hardcoded 5",
        plan["target"] == target, (plan["target"], target))
s.check("rows == to_create", len(plan["rows"]) == plan["to_create"])
# changed != eligible on purpose: a panel is often short precisely because
# nobody eligible is left to add, and reporting eligible as "would be built"
# would promise work that is not going to happen.
s.check("changed <= eligible <= in_scope",
        plan["changed"] <= plan["eligible"] <= plan["in_scope"])
s.check("no planned panel exceeds the target",
        all(v <= plan["target"] for v in plan["dist_after"]), plan["dist_after"])
s.check("no self-assignment", not [1 for _c, sid, aid, _r in plan["rows"] if sid == aid])
s.check("no duplicate pairing inside the plan",
        len({(sid, aid) for _c, sid, aid, _r in plan["rows"]}) == len(plan["rows"]))
existing = {(r["subject_id"], r["assessor_id"]) for r in
            H.rows(a, "SELECT subject_id, assessor_id FROM assignments WHERE cycle_id=?", (CID,))}
# If a planned pairing already existed, INSERT OR IGNORE would drop it silently
# and the applied count would not match the promise.
s.check("no planned pairing already exists (archived rows included)",
        not [1 for _c, sid, aid, _r in plan["rows"] if (sid, aid) in existing])
s.check("every short panel carries a reason", all(r["reason"] for r in plan["short"]))
s.check("'short' means below the scoring minimum, not below the target",
        all(r["after"] < plan["min_valid"] for r in plan["short"]) and plan["min_valid"] <= target,
        (plan["min_valid"], target))

# the build and a person's suggestions both hand the engine the year's Mid-Year panels (Chris, 2026-10-21)
_seen, _real_engine, _real_prior = [], a._ba.build_panels_capped, a._bpdb.load_prior
MINE = {"ZZOTHER": "peer"}


class _Every(dict):          # every subject's Mid-Year panel is MINE
    def get(self, k, d=None):
        return MINE


SENT = _Every(ZZSENTINEL=MINE)
a._bpdb.load_prior = lambda db_, cyc_: SENT
a._ba.build_panels_capped = lambda *ar, **kw: (_seen.append(kw.get("prior")), _real_engine(*ar, **kw))[1]
try:
    with a.app.test_request_context("/"):
        from flask import session as _ss
        _ss["user_id"] = SU["id"]
        db = a.get_db()
        a._panel_build_plan(db, SU, CID, "missing")
        _cy = db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()
        _p = db.execute("SELECT u.* FROM users u JOIN assignments x ON x.subject_id=u.id WHERE x.cycle_id=? "
                        "AND x.archived=0 LIMIT 1", (CID,)).fetchone()
        n_build = len(_seen)
        _fv = a._panel_fill_view(db, _p, _cy, a.panel_target()) if _p is not None else {"sugg": []}
        _gr = {r[0]: r[1] or "" for r in db.execute("SELECT id, job_grade FROM users")}
finally:
    a._bpdb.load_prior, a._ba.build_panels_capped = _real_prior, _real_engine
s.check("the bulk build hands the engine the Mid-Year's panels", n_build >= 1 and _seen[0] is SENT, _seen[:1])
s.check("...and so does a person's own suggestion list (their own Mid-Year panel)",
        _p is not None and len(_seen) > n_build and isinstance(_seen[-1], dict)
        and list(_seen[-1].values()) == [MINE], (_p is not None, _seen[n_build:]))
s.check("each suggestion carries that person's own job grade (shown as JG; Chris, 2026-10-27)",
        bool(_fv["sugg"]) and any(x["grade"] for x in _fv["sugg"])
        and all(x["grade"] == _gr.get(x["id"], "") for x in _fv["sugg"]),
        [(x["id"], x["grade"]) for x in _fv["sugg"][:5]])

def loads():
    return {r["assessor_id"]: r["n"] for r in H.rows(
        a, "SELECT assessor_id, COUNT(*) n FROM assignments WHERE cycle_id=? AND archived=0 GROUP BY assessor_id",
        (CID,))}


s.section("apply")
promised = plan["to_create"]
before, v_before = snapshot(), violations()
load_before = loads()
r = S.post("/admin/panels/build", data={"csrf_token": "tok", "mode": "missing", "apply": "1"})
after = snapshot()
s.check("apply -> 200", r.status_code == 200, r.status_code)
s.check("created exactly what the preview promised",
        after["total"] - before["total"] == promised,
        (promised, after["total"] - before["total"]))
s.check("NOTHING was archived", after["archived"] == before["archived"])
s.check("NO submitted assessment was touched", after["submitted"] == before["submitted"])
s.check("no release was revoked", after["released"] == before["released"])
s.check("nothing was deleted", after["total"] >= before["total"])

s.section("the cap: nobody rates more than ASSESSOR_CAP (Chris, 2026-10-20)")
CAP = a._ba.ASSESSOR_CAP
load_after = loads()
gained = {k for k in load_after if load_after[k] > load_before.get(k, 0)}
s.note("%d people were given work; cap %d" % (len(gained), CAP))
s.check("the build gave work to somebody (the checks below reach their lines)", len(gained) > 0, len(gained))
s.check("nobody given work by the build rates more than the cap (an independent count)",
        all(load_after[k] <= CAP for k in gained),
        sorted((load_before.get(k, 0), load_after[k]) for k in gained if load_after[k] > CAP)[:5])

# the order, read back from the table and the roster with this suite's own queries
MING = H.one(a, "SELECT min_job_grade FROM cycles WHERE id=?", (CID,))
U = {r["id"]: r for r in H.rows(a, "SELECT id, manager_id, business_group, company, department, job_grade, role, "
                                   "is_demo FROM users WHERE left_at IS NULL")}


def can_rate(x):
    """An assessor by the rules, written here: active, not an admin or a demo account, a numeric grade at or above
    the cycle's minimum."""
    u = U.get(x)
    g = str(u["job_grade"] if u else "").strip()
    return bool(u) and u["role"] != "admin" and not u["is_demo"] and g.isdigit() and (MING is None or int(g) >= MING)


on = {}
for r in H.rows(a, "SELECT subject_id, assessor_id, relationship FROM assignments WHERE cycle_id=?", (CID,)):
    on.setdefault(r["subject_id"], {})[r["assessor_id"]] = r["relationship"]   # archived rows too: never re-added
new_rows = [(sid, aid, rel) for _c, sid, aid, rel in plan["rows"]]
new_subj = {sid for sid, _a, _r in new_rows}
full = lambda x: load_after.get(x, 0) >= CAP  # noqa: E731
lm_missing = [sid for sid in new_subj if U.get(sid) and can_rate(U[sid]["manager_id"])
              and U[sid]["manager_id"] not in on.get(sid, {}) and not full(U[sid]["manager_id"])]
s.check("line manager first: nobody built is missing a line manager who still has room", not lm_missing,
        len(lm_missing))
s.check("...and the line manager is on most new panels (the check reaches its line)",
        sum(1 for _s, _a, r in new_rows if r == "line_manager") > 0)
peers_given = [sid for sid, _a, rel in new_rows if rel == "peer"]
dr_room = [sid for sid in set(peers_given)
           for d, ud in U.items() if ud["manager_id"] == sid and can_rate(d)
           and d not in on.get(sid, {}) and not full(d)]
s.check("direct reports before peers: nobody given a peer has a direct report left with room", not dr_room,
        len(dr_room))
s.note("%d new direct-report rows (the check above reaches its line only when some subjects manage people)"
       % sum(1 for _s, _a, r in new_rows if r == "direct_report"))
dept = lambda x: (U[x]["business_group"], U[x]["company"], U[x]["department"])  # noqa: E731
pu = [(sid, aid) for sid, aid, rel in new_rows if rel == "peer" and dept(aid) != dept(sid)]
s.note("%d new peers from another department of the unit" % len(pu))
same_room = [sid for sid, _aid in pu if U[sid]["department"]
             for y in U if y != sid and dept(y) == dept(sid) and can_rate(y)
             and y not in on.get(sid, {}) and not full(y)]
s.check("another department only as a last resort: nobody given one has a colleague in their own with room",
        not same_room, len(same_room))
s.check("a peer is always in the same business group and unit",
        all((U[aid]["business_group"], U[aid]["company"]) == (U[sid]["business_group"], U[sid]["company"])
            for sid, aid, rel in new_rows if rel == "peer"))

s.section("the engine on a team of its own (no database)")
B = a._ba


def P(eid, grade=14, mgr=None, dept="Sales", unit="U1"):
    return {"eid": eid, "name": "", "business_group": "BG", "company": unit, "department": dept, "grade": grade,
            "service": 1.0, "joined": None, "confirmed": True, "manager_name": "", "manager": mgr}


M = P("M", 18)
team = {"M": M, **{f"R{i}": P(f"R{i}", 13, M) for i in range(6)}}
team.update({"O1": P("O1", 13, None, "Ops"), "O2": P("O2", 13, None, "Ops")})
pan = B.build_panels_capped(team, [f"R{i}" for i in range(6)], 5, 3, cap=4)
ld = {}
for e, p in pan.items():
    for _r, x in p["assessors"]:
        ld[x["eid"]] = ld.get(x["eid"], 0) + 1
s.check("the manager rates 4 of a team of 6, never more", ld.get("M") == 4, ld.get("M"))
s.check("nobody rates more than 4", max(ld.values()) <= 4, ld)
s.check("all six reach 3", all(len(p["assessors"]) >= 3 for p in pan.values()),
        {e: len(p["assessors"]) for e, p in pan.items()})
s.check("the other department is used only after the team is full",
        not (any(x["eid"] in ("O1", "O2") for p in pan.values() for _r, x in p["assessors"])
             and any(ld.get(f"R{i}", 0) < 4 for i in range(6))), ld)
# M already rates four people elsewhere in the cycle
pan2 = B.build_panels_capped(team, ["R0"], 5, 3, cap=4, existing={f"S{i}": {"M": "peer"} for i in range(4)})
s.check("an existing row counts toward the cap: a manager already rating 4 gets nobody more",
        not any(x["eid"] == "M" for _r, x in pan2["R0"]["assessors"])
        and pan2["R0"]["lm_status"] == "manager_full", pan2["R0"]["lm_status"])
s.check("...and the reason says so", "already rates 4" in B.note_capped(pan2["R0"], 5, 3, cap=4) or
        len(pan2["R0"]["assessors"]) >= 5, B.note_capped(pan2["R0"], 5, 3, cap=4))
pan3 = B.build_panels_capped(team, ["R0"], 5, 3, cap=4, barred={"R0": {"M", "R1"}})
s.check("a barred pairing (an archived row) is never given again",
        not {x["eid"] for _r, x in pan3["R0"]["assessors"]} & {"M", "R1"})
lone = {"Z": P("Z", 14, None, "Solo", "U9")}
s.check("someone with nobody to ask gets an empty panel and the reason",
        B.build_panels_capped(lone, ["Z"], 5, 3)["Z"]["assessors"] == []
        and "only 0 people close enough" in B.note_capped(B.build_panels_capped(lone, ["Z"], 5, 3)["Z"], 5, 3))
# a manager S with two direct reports and four peers under the same boss: LM, then both direct reports, then peers
BOSS = P("BOSS", 20)
S1 = P("S1", 16, BOSS)
mix = {"BOSS": BOSS, "S1": S1, "D1": P("D1", 13, S1), "D2": P("D2", 13, S1),
       **{f"Q{i}": P(f"Q{i}", 16, BOSS) for i in range(4)}}
got = [r for r, _x in B.build_panels_capped(mix, ["S1"], 5, 3)["S1"]["assessors"]]
s.check("line manager, then the direct reports, then peers to fill",
        got == ["line_manager", "direct_report", "direct_report", "peer", "peer"], got)
# direct reports highest JG first (Chris, 2026-10-20: "pick from the highest JG to lowest order"), ahead of who has the
# least to do: a JG 20 manager with six reports, the senior ones already rating others elsewhere in the cycle
M20 = P("M20", 20, P("TOP", 22))
six = {f"G{g}": P(f"G{g}", g, M20) for g in (12, 14, 18, 13, 16, 15)}
roster = {"M20": M20, "TOP": M20["manager"], **six}
busy = {"X1": {"G18": "peer"}, "X2": {"G18": "peer", "G16": "peer"}, "X3": {"G15": "peer"}}
got = sorted((x["grade"] for r, x in B.build_panels_capped(roster, ["M20"], 4, 2, existing=busy)["M20"]["assessors"]
              if r == "direct_report"), reverse=True)
s.check("a manager's direct reports go highest JG first, ahead of who has the least to do", got == [18, 16, 15], got)
full18 = dict(busy, **{f"Y{i}": {"G18": "peer"} for i in range(3)})
got = sorted((x["grade"] for r, x in B.build_panels_capped(roster, ["M20"], 4, 2, existing=full18)["M20"]["assessors"]
              if r == "direct_report"), reverse=True)
s.check("...and one at the cap is passed over for the next most senior", got == [16, 15, 14], got)
s.check("letter-grade people never assess", not any(
    x["grade"] < 0 for p in B.build_panels_capped({**team, "H1": P("H1", -1, M)}, ["R0", "R1"], 5, 3).values()
    for _r, x in p["assessors"]))

s.section("the Mid-Year's raters come straight after the line manager (Chris, 2026-10-21)")
# R0's Mid-Year panel: two of its own team, someone from Ops (not close today, but kept), a matrix manager from
# another unit, a leaver, and their line manager
far = P("FAR", 15, None, "Finance", "U7")
mt = {**team, "FAR": far}
mine = {"R3": "peer", "O1": "peer", "FAR": "matrix_manager", "GONE": "peer", "M": "line_manager"}
got = B.build_panels_capped(mt, ["R0"], 5, 2, cap=4, prior={"R0": mine})["R0"]["assessors"]
eids = [x["eid"] for _r, x in got]
s.check("the line manager first, then every Mid-Year rater still here, then the closest", eids[0] == "M"
        and set(eids[1:4]) == {"R3", "O1", "FAR"} and len(eids) == 5, eids)
rels = {x["eid"]: r for r, x in got}
s.check("...a Mid-Year rater still close takes today's relationship, else the one they had, else peer",
        rels.get("R3") == "peer" and rels.get("O1") == "peer" and rels.get("FAR") == "matrix_manager", rels)
s.check("...someone who has left (not in the roster) is never given", "GONE" not in eids, eids)
plain = [x["eid"] for _r, x in B.build_panels_capped(mt, ["R0"], 5, 2, cap=4)["R0"]["assessors"]]
s.check("...without a Mid-Year the build is as before (nobody from Ops or Finance)",
        "FAR" not in plain and "O1" not in plain, plain)
busy_far = {f"T{i}": {"FAR": "peer"} for i in range(4)}
got = [x["eid"] for _r, x in B.build_panels_capped(mt, ["R0"], 5, 2, cap=4, existing=busy_far,
                                                   prior={"R0": mine})["R0"]["assessors"]]
s.check("...the cap still holds: a Mid-Year rater already rating 4 is passed over", "FAR" not in got, got)
got = [x["eid"] for _r, x in B.build_panels_capped(mt, ["R0"], 5, 2, cap=4, barred={"R0": {"O1"}},
                                                   prior={"R0": mine})["R0"]["assessors"]]
s.check("...and a pairing HR took off is never given back", "O1" not in got, got)
near, mrel = B.with_prior(team["R0"], B.close_to(team["R0"], B.index_people(mt)), mt, mine)
s.check("a person's own suggestions take the same order (with_prior)",
        [t for t, _x in near][:4] == ["LM", "MY", "MY", "MY"] and mrel.get("FAR") == "matrix_manager",
        [t for t, _x in near][:5])

# the loader: a Year-End reads the same year's Mid-Year, and a leaver there is dropped by the roster
import sqlite3  # noqa: E402
mem = sqlite3.connect(":memory:")
mem.row_factory = sqlite3.Row
mem.executescript("""
CREATE TABLE users (id INTEGER PRIMARY KEY, employee_id TEXT, full_name TEXT, business_group TEXT, company TEXT,
  department TEXT, job_grade TEXT, years_of_service REAL, confirmation_date TEXT, joined_date TEXT, manager_id INTEGER,
  role TEXT DEFAULT 'user', left_at TEXT, is_demo INTEGER DEFAULT 0);
CREATE TABLE cycles (id INTEGER PRIMARY KEY, name TEXT, year INTEGER, half INTEGER);
CREATE TABLE assignments (id INTEGER PRIMARY KEY, cycle_id INTEGER, subject_id INTEGER, assessor_id INTEGER,
  relationship TEXT, archived INTEGER DEFAULT 0);
INSERT INTO users (id, employee_id, business_group, company, department, job_grade, confirmation_date) VALUES
  (1,'E1','BG','U1','Sales','14','2020-01-01'), (2,'E2','BG','U2','Ops','14','2020-01-01'),
  (3,'E3','BG','U3','Fin','14','2020-01-01');
UPDATE users SET left_at='2026-09-30' WHERE id=3;
INSERT INTO cycles VALUES (1,'2026 Mid-Year',2026,1), (2,'2026 Year-End',2026,2), (3,'2025 Mid-Year',2025,1);
INSERT INTO assignments (cycle_id, subject_id, assessor_id, relationship) VALUES
  (1,1,2,'peer'), (1,1,3,'peer'), (3,1,3,'peer');
INSERT INTO assignments (cycle_id, subject_id, assessor_id, relationship, archived) VALUES (1,2,1,'peer',1);
""")
ye = mem.execute("SELECT * FROM cycles WHERE id=2").fetchone()
ref = a._bpdb.prior_cycle(mem, ye)
s.check("a Year-End's reference is the same year's Mid-Year", ref is not None and ref["id"] == 1, ref and dict(ref))
s.check("...a Mid-Year itself has none", a._bpdb.prior_cycle(mem, mem.execute("SELECT * FROM cycles WHERE id=1")
                                                            .fetchone()) is None)
pr = a._bpdb.load_prior(mem, ye)
s.check("...its active rows only (an archived one left out)", pr == {"E1": {"E2": "peer", "E3": "peer"}}, pr)
ros = a._bpdb.load_people(mem, 12)
got = [x["eid"] for _r, x in B.build_panels_capped(ros, ["E1"], 4, 2, prior=pr)["E1"]["assessors"]]
s.check("...and the one who resigned since (left_at) is checked against the active list, never given",
        got == ["E2"], got)

s.section("idempotent")
mid = snapshot()
S.post("/admin/panels/build", data={"csrf_token": "tok", "mode": "missing", "apply": "1"})
s.check("a second identical run creates 0", snapshot()["total"] == mid["total"],
        (mid["total"], snapshot()["total"]))

s.section("the build must not make any rule breach worse -- DELTA, not absolute")
S.post("/admin/panels/build", data={"csrf_token": "tok", "mode": "topup", "apply": "1"})
v_after = violations()
s.note("pre-existing in this database: %s" % v_before)
for key in v_before:
    s.check("%-14s not made worse" % key, v_after[key] <= v_before[key],
            (v_before[key], v_after[key]))
s.check("no NEW breach of any kind", all(v_after[k] == v_before[k] for k in v_before),
        {k: (v_before[k], v_after[k]) for k in v_before if v_after[k] != v_before[k]})

s.section("scope and authorisation")
if BG:
    B = H.client_as(a, BG["id"])
    s.check("a BG admin can open their own scope", B.get("/admin/panels/build").status_code == 200)
    with a.app.app_context():
        other = next((b for b in a.org_bgs(a.get_db()) if b != BG["admin_bg"]), None)
    if other:
        # Out of scope is an AUTHORISATION question and 403s...
        s.check("asking for another BG -> 403",
                B.get("/admin/panels/build", query_string={"bg": other}).status_code == 403)
    with a.app.test_request_context("/"):
        from flask import session as _s
        _s["user_id"] = BG["id"]
        pb = a._panel_build_plan(a.get_db(), BG, CID, "missing")
    outside = [1 for _c, sid, _a, _r in pb["rows"]
               if H.one(a, "SELECT business_group FROM users WHERE id=?", (sid,))
               != BG["admin_bg"]]
    s.check("a BG admin's plan writes no subject outside their BG", not outside, len(outside))
# ...but a BG that simply does not exist widens back, rather than rendering an
# empty scope. Same split admin_reward_config uses.
r = S.get("/admin/panels/build", query_string={"bg": "NOT A REAL BG"})
# the scope is the business group row since 2026-10-11 (the admin table standard): "All" is the lit pill
s.check("a nonexistent BG widens back rather than showing an empty scope",
        r.status_code == 200 and re.search(r'class="adm-frow-pill is-on"[^>]*aria-current="true">All<',
                                           r.get_data(as_text=True)) is not None,
        r.status_code)

s.section("audit")
modes = {row["detail"].split(" |")[0] for row in
         H.rows(a, "SELECT detail FROM activity_log WHERE action='panel_build'")}
s.check("the run is logged", modes, modes)
s.check("both modes logged separately", modes == set(a.PANEL_BUILD_MODES), modes)

s.section("neighbouring pages still render")
for path in ("/admin/import", "/admin/clear-panels", "/admin/subjects", "/admin"):
    s.check("super GET %-22s" % path, S.get(path).status_code in (200, 302))

sys.exit(s.done())
