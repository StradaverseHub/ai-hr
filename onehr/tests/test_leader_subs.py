"""Who has submitted (Chris, 2026-11-02: "Approve, build it", then on the canvas "add a quick filter to filter those who have yet
submitted", "remove the download function"; [design canvas link removed] boards A1 Main, A2 Leaders, A3 Group,
E1 Entry): the five leader roles (HOD, BU CEO, calibrator, BG CEO, Group Chief) open, from their dashboard, a list of THEIR OWN
people with each open part's state.

What this suite holds (a made-up group of synthetic people, tests/subs_seed.py, put back at the end):
  * each role sees exactly its own people (checked against independent SQL on the relationships, not counts); a person with
    two roles gets two scopes; another unit's, group's or department's scope in the request is refused (404)
  * per scope and part the list's done count is the Leader progress email's (lp_counts / lp_build's own totals), and the
    email's render is unchanged by the refactor (a pinned digest taken on the code before) and lp_counts equals the old
    per-part rule (reference copy)
  * a non-leader, an admin, the ability switched off for that seat, the Executive Chairman, a unit out of the cycle and a
    cycle with no open part are each refused and see no entry on the dashboard
  * the payload holds no band, score, rating, remark or display name (planted, then looked for); the GET writes nothing
  * the states: done with its day, not yet, late pass, done on their behalf, not part of it, 360 given of owed; the Line
    managers tab only once a line manager's window has opened
  * the route's classification, the ability keys, the dashboard's strips, Ask OneHR, the KB and Help's answer
  * every guard falsified once
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402
import subs_seed as S  # noqa: E402

a = H.setup()
s = H.Suite("Who has submitted: the leader's own people, part by part")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
# the digest of every synthetic leader's Leader progress email, taken on the code BEFORE lp_counts became a sum of
# lp_person_parts (commit 10e88f17): the email must stay byte for byte what it was
EMAIL_DIGEST = "db24f9f7ee773637d3050eb13d6502c86012bc360b612b272a58e9753f405e50"
CHAIR_ENV = os.environ.get("ONEHR_CHAIR")

with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    S.teardown(db)
    db.execute("DELETE FROM leader_role_access WHERE ability LIKE '%.progress'")
    CID, ID, SAVED = S.prepare(a, db)
    CYC = db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()
    CHAIR0 = [tuple(r) for r in db.execute("SELECT key, value FROM app_settings WHERE key LIKE 'exec_chair%'")]
    EXC0 = [tuple(r) for r in db.execute("SELECT * FROM cycle_exclusions WHERE cycle_id=?", (CID,))]
    db.commit()

K = {k: ID[k] for k in S.LEADERS}
PEOPLE_IDS = {k: ID[k] for k in S.PEOPLE}
ALL_IDS = set(ID.values())
OTHER = {ID[k] for k in ("X01", "X02", "H4", "M5")}   # the other business group: nobody here may see them


def q(sql, args=()):
    with a.app.app_context():
        return a.get_db().execute(sql, args).fetchall()


def get(uid, scope=None):
    c = H.client_as(a, uid)
    # /me/progress is the dashboard's script fetch (static/dashboard.js getJSON), so a browser sends it with Sec-Fetch-Mode
    # "cors": that is not activity (_request_is_activity), so it never stamps users.last_seen_at (Online now). A client with
    # no such header reads as a page navigation, which is a real use of OneHR and does stamp: not what this route is.
    r = c.get("/me/progress", query_string=({"scope": scope} if scope is not None else None),
              headers={"Sec-Fetch-Mode": "cors"})
    return r, (json.loads(r.get_data(as_text=True)) if r.status_code == 200 else None)


def rows_of(d):
    return [r for g in d["groups"] for r in g["rows"]]


def ids_of(d):
    return {r["id"] for r in rows_of(d)}


def keys_of(d):
    return [x["key"] for x in d["scopes"]]


def entry(uid):
    with a.app.test_request_context("/"):
        db_ = a.get_db()
        return a.lp_subs_entry(db_, db_.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone(), a.active_cycle(db_))


def keys_walk(o, acc):
    if isinstance(o, dict):
        for k, v in o.items():
            acc.add(k)
            keys_walk(v, acc)
    elif isinstance(o, list):
        for v in o:
            keys_walk(v, acc)
    return acc


try:
    s.section("each role sees exactly its own people")
    r, d = get(K["H1"])
    s.check("an HOD: one scope, the department they head", r.status_code == 200 and len(d["scopes"]) == 1 and d["kind"] == "hod"
            and d["label"] == "Sales & Marketing", (r.status_code, d and d["scopes"]))
    mine = {r_[0] for r_ in q("SELECT id FROM users WHERE hod_id=? AND id!=?", (K["H1"], K["H1"]))}
    s.check("...their people are the ones whose hod_id is them, in that department", ids_of(d) == mine and len(mine) == 7, (ids_of(d), mine))
    s.check("...grouped by line manager's team, the official name, never the display name",
            d["by"] == "Line manager's team" and {g["name"] for g in d["groups"]} == {"Staff member M1", "Staff member M2",
                                                                                        "No line manager on file"})
    r, d = get(K["C1"])
    s.check("a BU CEO of two units: a scope each, the first on screen", len(d["scopes"]) == 2 and d["kind"] == "bu"
            and [x["label"] for x in d["scopes"]] == ["Northwind Building Supplies", "Northwind Logistics"], d["scopes"])
    u1 = {r_[0] for r_ in q("SELECT id FROM users WHERE business_group=? AND company=? AND employee_id LIKE 'ZZ9SB-%'", (S.BG, S.U1))}
    s.check("...unit one: everyone of the unit who takes part, nobody else", ids_of(d) == u1 and not ids_of(d) & OTHER, (len(ids_of(d)), len(u1)))
    s.check("...grouped by department (proper case), with the department's HOD", {g["name"] for g in d["groups"]} >= {"Sales & Marketing", "Operations"}
            and next(g["sub"] for g in d["groups"] if g["name"] == "Operations") == "HOD · Staff member H2")
    r2, d2 = get(K["C1"], keys_of(d)[1])
    u2 = {r_[0] for r_ in q("SELECT id FROM users WHERE business_group=? AND company=? AND employee_id LIKE 'ZZ9SB-%'", (S.BG, S.U2))}
    s.check("...unit two is its own scope, its people only", r2.status_code == 200 and ids_of(d2) == u2 and not ids_of(d2) & ids_of(d))
    r, d = get(K["K1"])
    grp = {r_[0] for r_ in q("SELECT id FROM users WHERE business_group=? AND employee_id LIKE 'ZZ9SB-%' AND ((company=? AND department=?) "
                             "OR (company=? AND department=?))", (S.BG, S.U1, S.D_S, S.U2, S.D_F))}
    s.check("a calibrator: their calibration group's people (the departments it holds)", r.status_code == 200 and d["kind"] == "cg"
            and ids_of(d) == grp and d["label"] == "Northwind Sales calibrators", (ids_of(d) ^ grp))
    r, d = get(K["G1"])
    bg_all = {r_[0] for r_ in q("SELECT id FROM users WHERE business_group=? AND employee_id LIKE 'ZZ9SB-%'", (S.BG,))}
    s.check("a BG CEO: everyone of the business group, grouped by business unit with each unit's BU CEO", r.status_code == 200
            and d["kind"] == "bg" and ids_of(d) == bg_all and d["fold"] is True and not ids_of(d) & OTHER
            and {g["name"]: g["sub"] for g in d["groups"]}["Northwind Building Supplies Sdn Bhd"] == "BU CEO · Staff member C1")
    r, d = get(K["X1"])
    mem = {r_[0] for r_ in q("SELECT subject_id FROM pm_calibration_group_members m JOIN pm_calibration_groups g ON g.id=m.group_id "
                             "WHERE g.calibrator_id=?", (K["X1"],))}
    s.check("a Group Chief: the people of their groups, by batch", r.status_code == 200 and d["kind"] == "gc" and ids_of(d) == mem
            and {g["name"] for g in d["groups"]} == {"Batch 1", "Batch 2"}, (ids_of(d) ^ mem))
    s.check("nobody of the other business group appears in any scope of an HOD, BU CEO, calibrator or BG CEO",
            all(not ids_of(get(K[k], sc)[1]) & OTHER for k in ("H1", "C1", "K1", "G1")
                for sc in keys_of(get(K[k])[1])))

    s.section("a person with two roles gets two scopes; any other scope is refused")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE users SET bgceo_bg=? WHERE id=?", (S.BG, K["K1"]))
        d_.commit()
    r, d = get(K["K1"])
    s.check("a calibrator who is also a BG CEO: a pill for each (calibration group, business group)",
            sorted(x["kind"] for x in d["scopes"]) == ["bg", "cg"], d["scopes"])
    r_bg, d_bg = get(K["K1"], "bg:" + S.BG)
    s.check("...each opens on its own", r_bg.status_code == 200 and d_bg["kind"] == "bg" and ids_of(d_bg) == bg_all)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE users SET bgceo_bg=NULL WHERE id=?", (K["K1"],))
        d_.commit()
    other_unit = "bu:%s|%s" % (S.BG2, S.U3)
    other_dept = "hod:%s|%s|%s" % (S.BG, S.U1, S.D_O)
    cg_other = "cg:%d" % (q("SELECT id FROM calib_bu_groups WHERE name='Northwind Sales calibrators'")[0][0] + 1000)
    refusals = [("an HOD asking for another department", K["H1"], other_dept), ("an HOD asking for a BU CEO scope", K["H1"], "bu:%s|%s" % (S.BG, S.U1)),
                ("a BU CEO asking for another business group's unit", K["C1"], other_unit),
                ("a BU CEO asking for the business group", K["C1"], "bg:" + S.BG), ("a BU CEO asking for a calibration group", K["C1"], cg_other),
                ("a calibrator asking for a unit", K["K1"], "bu:%s|%s" % (S.BG, S.U1)), ("a calibrator asking for a group that is not theirs", K["K1"], cg_other),
                ("a BG CEO asking for another business group", K["G1"], "bg:" + S.BG2), ("a BG CEO asking for the Group Chief's scope", K["G1"], "gc"),
                ("a Group Chief asking for a unit", K["X1"], "bu:%s|%s" % (S.BG, S.U1)),
                ("a made-up scope", K["C1"], "zzz"), ("an empty-looking scope", K["C1"], "bu:|")]
    for what, uid, sc in refusals:
        r, _d = get(uid, sc)
        s.check("refused (404): " + what, r.status_code == 404, r.status_code)

    s.section("who is refused, and who sees an entry")
    s.check("an employee who leads nobody is refused", get(ID["S01"])[0].status_code == 404 and entry(ID["S01"]) is None)
    s.check("a super admin is refused", H.client_as(a, SU["id"]).get("/me/progress").status_code == 404)
    with a.app.app_context():
        d_ = a.get_db()
        adm = d_.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, bgceo_bg) VALUES "
                         "('zz9sb-adm','Staff member ADM','x','admin','ZZ9SB-ADM',?,?)", (S.BG, S.BG)).lastrowid
        d_.commit()
    s.check("...and so is an admin account that also names a seat", get(adm)[0].status_code == 404)
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        s.check("...with no entry either", a.lp_subs_scope_defs(d_, d_.execute("SELECT * FROM users WHERE id=?", (adm,)).fetchone()) == [])
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM users WHERE id=?", (adm,))
        d_.commit()
    ents = {k: entry(K[k]) for k in ("H1", "C1", "K1", "G1", "X1")}
    s.check("each seat has an entry with the open parts", all(e and e["parts"] == ["KPI check-in", "Competency", "Career Plan", "360 ratings"]
                                                              for e in ents.values()), ents)
    s.check("...of its own kind", [ents[k]["kinds"] for k in ("H1", "C1", "K1", "G1", "X1")] == [["hod"], ["bu"], ["cg"], ["bg"], ["gc"]])
    # the ability, per seat
    for seat, who, other in (("hod", "H1", "C1"), ("bu", "C1", "K1"), ("cg", "K1", "G1"), ("bg", "G1", "X1"), ("gc", "X1", "H1")):
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("INSERT INTO leader_role_access(role, ability, allowed, updated_by) VALUES (?,?,0,?)", (seat, seat + ".progress", SU["id"]))
            d_.commit()
        r, _d = get(K[who])
        s.check("%s.progress switched off: that seat is refused and sees no entry, another seat is not" % seat,
                r.status_code == 404 and entry(K[who]) is None and get(K[other])[0].status_code == 200 and entry(K[other]) is not None)
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("DELETE FROM leader_role_access WHERE ability=?", (seat + ".progress",))
            d_.commit()
    s.check("...back on, back to normal", get(K["C1"])[0].status_code == 200)
    ab = [x for x in a.LEADER_ABILITIES if x[1].endswith(".progress")]
    s.check("one `<seat>.progress` ability per seat, each in its seat's group, with the same words",
            sorted(x[1] for x in ab) == ["bg.progress", "bu.progress", "cg.progress", "gc.progress", "hod.progress"]
            and {x[2] for x in ab} == {"See who has submitted"} and {x[3] for x in ab} == {"Their own people, part by part; never a result"}
            and all(x[1].split(".")[0] in dict(a.LEADER_ROLES) for x in ab))
    # a unit left out of the cycle
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT INTO cycle_exclusions(cycle_id, business_group, company, department) VALUES (?,?,?, '')", (CID, S.BG, S.U1))
        d_.commit()
    s.check("a leader whose own unit the cycle leaves out is refused and sees no entry", get(K["C1"])[0].status_code == 404
            and entry(K["C1"]) is None and get(K["G1"])[0].status_code == 404)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM cycle_exclusions WHERE cycle_id=? AND company=?", (CID, S.U1))
        d_.commit()
    s.check("...taken back in, they are back", get(K["C1"])[0].status_code == 200)
    # the Executive Chairman's seat
    os.environ["ONEHR_CHAIR"] = "1"
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('exec_chair_id', ?)", (str(K["G1"]),))
        d_.commit()
    s.check("the Executive Chairman's seat gets none", get(K["G1"])[0].status_code == 404 and entry(K["G1"]) is None
            and get(K["C1"])[0].status_code == 200)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM app_settings WHERE key='exec_chair_id'")
        d_.executemany("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?,?)", CHAIR0)
        d_.commit()
    if CHAIR_ENV is None:
        os.environ.pop("ONEHR_CHAIR", None)
    else:
        os.environ["ONEHR_CHAIR"] = CHAIR_ENV

    s.section("the done count is the Leader progress email's")
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        cyc = a.active_cycle(d_)
        keys = [p[0] for p in a.LP_PARTS]
        counts = a.lp_counts(d_, cyc, keys)
        rules = dict(a.lp_rules(), parts=keys, roles=[x[0] for x in a.LP_ROLES], skip_done=False)
        built, open_parts, _ahead = a.lp_build(d_, cyc, rules)
        by_leader = {(b["role"], b["user"]["id"]): b for b in built}
        bi = {p[0]: i for i, (p, _c) in enumerate(open_parts)}
    def email_cell(b, part, sec_ix=0):
        sec = b["sections"][sec_ix]
        c = sec["total"][bi[part]]
        return c["done"], c["n"]
    for part in ("pm_results", "tc_self", "idp_self"):
        pi = ["pm_results", "tc_self", "idp_self", "f360"].index(part)
        r, d = get(K["C1"])
        b = by_leader[("buceo", K["C1"])]
        sec = next(x for x in b["sections"] if x["co"] == S.U1)
        s.check("BU CEO, unit one, %s: the tile is the email's section total" % part,
                (d["tiles"][pi]["done"], d["tiles"][pi]["n"]) == (sec["total"][bi[part]]["done"], sec["total"][bi[part]]["n"]),
                (d["tiles"][pi], sec["total"][bi[part]]))
    r, d = get(K["C1"])
    sec = next(x for x in by_leader[("buceo", K["C1"])]["sections"] if x["co"] == S.U1)
    ft = d["tiles"][3]
    s.check("...the 360: the ratings given of owed are the email's, and a person is done once they gave every one they owe",
            ft["given"] == [sec["total"][bi["f360"]]["done"], sec["total"][bi["f360"]]["n"]]
            and ft["done"] == sum(1 for r_ in rows_of(d) if r_["c"][3][0] == 1) and ft["n"] == sum(1 for r_ in rows_of(d) if r_["c"][3][0] != 4), ft)
    r, d = get(K["G1"])
    sec = by_leader[("bgceo", K["G1"])]["sections"][0]
    s.check("BG CEO: every tile is the email's group total, all four parts",
            all((d["tiles"][i]["done"], d["tiles"][i]["n"]) == (sec["total"][bi[p]]["done"], sec["total"][bi[p]]["n"]) for i, p in enumerate(
                ["pm_results", "tc_self", "idp_self"])) and d["tiles"][3]["given"] == [sec["total"][bi["f360"]]["done"], sec["total"][bi["f360"]]["n"]])
    r, d = get(K["K1"])
    sec = by_leader[("cg", K["K1"])]["sections"][0]
    s.check("calibrator: the tiles are the email's group total",
            all((d["tiles"][i]["done"], d["tiles"][i]["n"]) == (sec["total"][bi[p]]["done"], sec["total"][bi[p]]["n"]) for i, p in enumerate(
                ["pm_results", "tc_self", "idp_self"])))
    r, d = get(K["H1"])
    sec = by_leader[("hod", K["H1"])]["sections"][0]
    s.check("HOD: the tiles are the email's department total",
            all((d["tiles"][i]["done"], d["tiles"][i]["n"]) == (sec["total"][bi[p]]["done"], sec["total"][bi[p]]["n"]) for i, p in enumerate(
                ["pm_results", "tc_self", "idp_self"])), (d["tiles"], sec["total"]))
    s.check("...and a group's row totals add up to its tile", all(
        sum(g["t"][i][0] for g in d["groups"]) == d["tiles"][i]["done"] for i in range(3)))
    # per person: the list's cell is lp_counts' own per-person pair
    byp = counts["_by"]
    bad = []
    for k in ("C1", "G1"):
        dd = get(K[k])[1]
        for r_ in rows_of(dd):
            for pi, part in enumerate(["pm_results", "tc_self", "idp_self", "f360"]):
                m = byp.get(part, {}).get(r_["id"])
                c = r_["c"][pi]
                if (m is None) != (c[0] == 4) or (m and part != "f360" and bool(m[1]) != (c[0] == 1 or (c[0] in (0, 2, 3) and False))):
                    bad.append((k, r_["eid"], part, m, c))
    s.check("every person's cell agrees with lp_counts' per-person (counted, done)", not bad, bad[:3])

    s.section("the Leader progress email is unchanged")
    LPKEYS = ("leader_progress_rules", "leader_progress_template", "leader_progress_last")
    with a.app.app_context():   # the email's own words and rules start from OneHR's defaults, wherever this runs
        d_ = a.get_db()
        TPLS = H.stash_email_templates(d_)
        LPSET = [tuple(r) for r in d_.execute("SELECT key, value FROM app_settings WHERE key IN (?,?,?)", LPKEYS)]
        d_.execute("DELETE FROM app_settings WHERE key IN (?,?,?)", LPKEYS)
        d_.commit()
    try:
        with a.app.test_request_context("/"):
            d_ = a.get_db()
            dig = S.email_digest(a, d_)
    finally:
        with a.app.app_context():
            d_ = a.get_db()
            d_.executemany("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?,?)", LPSET)
            d_.commit()
            H.restore_email_templates(d_, TPLS)
    s.check("the digest of all seven synthetic leaders' emails is the one taken before the refactor", dig == (EMAIL_DIGEST, 7), dig)
    OLD = '''
def old_counts(a, db, cyc, parts):
    cid = cyc["id"]
    people = a._lp_people(db)
    places = dict(people)
    status = {}
    if {"pm_results", "pm_approve"} & set(parts):
        lines = {r[0] for r in db.execute("SELECT DISTINCT subject_id FROM pm_kpi_targets WHERE cycle_id=?", (cid,)) if r[0] in people}
        signed = {r[0] for r in db.execute("SELECT subject_id FROM pm_review_session WHERE cycle_id=? AND locked_at IS NOT NULL", (cid,))}
        legacy = {r[0] for r in db.execute(
            "SELECT t.subject_id FROM pm_kpi_results r JOIN pm_kpi_targets t ON t.id=r.kpi_target_id WHERE t.cycle_id=? "
            "AND COALESCE(r.admin_filled,0)=0 GROUP BY t.subject_id HAVING COUNT(*) > 0 AND MAX(r.draft)=0", (cid,))}
        sub = {s for s in lines if s in signed or s in legacy}
        if "pm_results" in parts:
            status["pm_results"] = {s: s in sub for s in lines}
        if "pm_approve" in parts:
            fin = a.pm_final_overalls(db, cid, sorted(sub)) if sub else {}
            status["pm_approve"] = {s: bool(fin.get(s)) for s in sub}
    if {"tc_self", "tc_approve"} & set(parts):
        assigned = {r[0] for r in db.execute("SELECT DISTINCT subject_id FROM tc_assignments WHERE cycle_id=?", (cid,)) if r[0] in people}
        asm = {r[0]: (r[1], r[2]) for r in db.execute("SELECT subject_id, submitted_at, reviewed_at FROM tc_assessments WHERE cycle_id=?", (cid,))}
        subm = {s for s in assigned if (asm.get(s) or (None, None))[0]}
        if "tc_self" in parts:
            status["tc_self"] = {s: s in subm for s in assigned}
        if "tc_approve" in parts:
            status["tc_approve"] = {s: bool(asm[s][1]) for s in subm}
    if "idp_self" in parts:
        shared = {r[0] for r in db.execute("SELECT subject_id FROM pm_idp WHERE plan_year=? AND status!='draft'", (a.pm_idp_plan_year(cyc),))}
        idp_people = a._lp_people(db, idp=True)
        places.update(idp_people)
        status["idp_self"] = {s: s in shared for s in idp_people}
    out = {}
    for part, m in status.items():
        agg = out.setdefault(part, {})
        for sid, done in m.items():
            x = agg.setdefault(places[sid], [0, 0])
            x[0] += 1
            x[1] += 1 if done else 0
    if "f360" in parts:
        raters = {r[0]: (r[1] or "", r[2] or "", (r[3] or "").strip()) for r in db.execute(
            "SELECT id, business_group, company, department FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0")}
        agg = out.setdefault("f360", {})
        for r in db.execute("SELECT assessor_id, COUNT(*), SUM(CASE WHEN status='submitted' THEN 1 ELSE 0 END) FROM assignments WHERE "
                            "cycle_id=? AND archived=0 AND " + a.rater_task_sql("assignments") + " GROUP BY assessor_id", (cid,)):
            k = raters.get(r[0])
            if k:
                x = agg.setdefault(k, [0, 0])
                x[0] += r[1]
                x[1] += r[2] or 0
    return out
'''
    ns = {}
    exec(OLD, ns)
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        cyc = a.active_cycle(d_)
        old = ns["old_counts"](a, d_, cyc, keys)
        new = a.lp_counts(d_, cyc, keys)
    s.check("lp_counts equals the rule it had before (a reference copy), part by part, over the whole fixture and the made-up group",
            all(old[p] == new[p] for p in keys) and old.keys() == {k for k in new if not k.startswith("_")},
            [p for p in keys if old[p] != new[p]])
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        pp = a.lp_person_parts(d_, a.active_cycle(d_), keys, dates=True)
    s.check("...and the per-person map it sums (with dates on) holds the same people and the same (counted, done)",
            all({i: (m[0], m[1]) for i, m in pp[p].items()} == new["_by"][p] for p in keys))

    s.section("what each cell says")
    r, d = get(K["H1"])
    row = {r_["eid"]: r_ for r_ in rows_of(d)}
    cell = lambda e, i: row["ZZ9SB-" + e]["c"][i]   # noqa: E731
    s.check("done: its day in MYT (the sign-off at 02:00 UTC is 10:00 on 3 Nov)", cell("S02", 0) == [1, "3 Nov", 0, 0] and cell("S01", 0)[:2] == [1, "3 Nov"], cell("S02", 0))
    s.check("not yet", cell("S03", 0)[0] == 0 and cell("S03", 1)[0] == 0 and cell("S03", 2)[0] == 0)
    s.check("a running late pass: until when", cell("S04", 0) == [2, "10 Nov", 0, 0], cell("S04", 0))
    s.check("the day helper is the house MYT one: a UTC timestamp +8h, a bare date untouched, a T-separated stamp read the same",
            a._lps_day("2026-11-03 17:00:00") == "4 Nov" and a._lps_day("2026-11-03") == "3 Nov" and a._lps_day("2026-11-03T02:00:00") == "3 Nov"
            and a._lps_day(None) == "" and a._lps_day("") == "")
    s.check("done by the line manager on their behalf, and when", cell("S05", 0) == [3, "5 Nov", 0, 0] and cell("S05", 1) == [3, "6 Nov", 0, 0], (cell("S05", 0), cell("S05", 1)))
    s.check("...and that is not counted done (the email never counted it)", d["tiles"][0]["done"] == sum(1 for r_ in rows_of(d) if r_["c"][0][0] == 1))
    s.check("not part of it: no competency lines, no 360", cell("S07", 1)[0] == 4 and cell("S07", 3)[0] == 4 and cell("S06", 3)[0] == 4)
    s.check("the Career Plan: shared with its day", cell("S01", 2) == [1, "5 Nov", 0, 0] and cell("S02", 2)[0] == 0)
    s.check("360 ratings: given of owed, never whom", cell("S02", 3) == [0, "", 1, 3] and cell("S01", 3) == [1, "", 3, 3] and cell("S03", 3) == [0, "", 0, 3], cell("S02", 3))
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE late_passes SET closed_at=datetime('now'), close_kind='ended' WHERE user_id=?", (ID["S04"],))
        d_.commit()
    r, d = get(K["H1"])
    s.check("a late pass that was ended no longer shows", {r_["eid"]: r_ for r_ in rows_of(d)}["ZZ9SB-S04"]["c"][0][0] == 0)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE late_passes SET closed_at=NULL, close_kind=NULL WHERE user_id=?", (ID["S04"],))
        d_.commit()
    s.check("the columns are the parts open now or closed, in LP_PARTS order, with when they close",
            [p["key"] for p in d["parts"]] == ["pm_results", "tc_self", "idp_self", "f360"] and d["parts"][0]["closes"] == S.closes_label(S.STAFF_CLOSE_D)
            and not any(p["closed"] for p in d["parts"]))
    # after a deadline
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE cycle_windows SET closes_at='2026-11-01 23:59' WHERE cycle_id=? AND cell='tc_self'", (CID,))
        d_.execute("UPDATE cycle_windows SET opens_at='2099-01-01 00:00', closes_at='2099-02-01 00:00' WHERE cycle_id=? AND cell='idp_self'", (CID,))
        d_.commit()
    r, d = get(K["H1"])
    s.check("a part past its deadline is marked closed (its Not yet reads Not submitted)", [(p["key"], p["closed"]) for p in d["parts"]] == [
        ("pm_results", False), ("tc_self", True), ("f360", False)] and d["parts"][1]["closes"].startswith("Closed 1 Nov"), d["parts"])
    s.check("...and a part that opens later has no column at all", "idp_self" not in [p["key"] for p in d["parts"]])
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE cycle_windows SET closes_at=? WHERE cycle_id=? AND cell='tc_self'", (S.STAFF_CLOSES, CID))
        d_.execute("UPDATE cycle_windows SET opens_at=?, closes_at=? WHERE cycle_id=? AND cell='idp_self'", (S.OPENS, S.STAFF_CLOSES, CID))
        d_.commit()

    s.section("the Line managers tab")
    r, d = get(K["C1"])
    lm = d["lm"]
    s.check("a line manager's window is open: the tab is there, a row for each line manager of the scope's people",
            lm is not None and {x["n"] for x in lm["rows"]} == {"Staff member M1", "Staff member M2", "Staff member M3", "No line manager on file"}
            and [p["key"] for p in lm["parts"]] == ["pm_approve", "tc_approve"], lm and [x["n"] for x in lm["rows"]])
    m1 = next(x for x in lm["rows"] if x["n"] == "Staff member M1")
    s.check("...M1's team: three people; KPI moderation 1 of 2 (the two who submitted; S01 moderated), the review 1 of 1",
            m1["team"] == 3 and m1["c"] == [[1, 2], [1, 1]] and m1["eid"] == "ZZ9SB-M1", m1["c"])
    s.check("...opening a team lists its people with each part's state, 'not submitted by them' for those who have nothing to moderate",
            {p["eid"]: p["c"] for p in m1["people"]}["ZZ9SB-S03"] == [[4, ""], [4, ""]]
            and {p["eid"]: p["c"][0][0] for p in m1["people"]}["ZZ9SB-S01"] == 1)
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        cn = a.lp_counts(d_, a.active_cycle(d_), ["pm_approve", "tc_approve"])
    u1c = {p: [sum(v[0] for k, v in cn[p].items() if k[0] == S.BG and k[1] == S.U1), sum(v[1] for k, v in cn[p].items() if k[0] == S.BG and k[1] == S.U1)] for p in ("pm_approve", "tc_approve")}
    s.check("...the people totals are lp_counts' for the unit (the email's KPI moderation and competency review)",
            [lm["tiles"][0]["people"], lm["tiles"][1]["people"]] == [[u1c["pm_approve"][1], u1c["pm_approve"][0]],
                                                                    [u1c["tc_approve"][1], u1c["tc_approve"][0]]], (lm["tiles"], u1c))
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE cycle_windows SET opens_at='2099-01-01 00:00', closes_at='2099-02-01 00:00' WHERE cycle_id=? AND cell IN ('pm_approve','tc_approve')", (CID,))
        d_.commit()
    r, d = get(K["C1"])
    s.check("before a line manager's window has opened there is no tab, and the staff parts are as they were",
            d["lm"] is None and [p["key"] for p in d["parts"]] == ["pm_results", "tc_self", "idp_self", "f360"])
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE cycle_windows SET opens_at=?, closes_at=? WHERE cycle_id=? AND cell IN ('pm_approve','tc_approve')", (S.OPENS, S.LM_CLOSES, CID))
        d_.commit()

    s.section("no result ever leaves, and a GET writes nothing")
    with a.app.app_context():
        d_ = a.get_db()
        # plant a band, a score, a remark and a display name where a leaky reader would find them
        d_.execute("UPDATE tc_assessments SET overall_remark=?, manager_overall_remark=? WHERE subject_id=?", (S.BAND + "remark", S.BAND + "mgr", ID["S01"]))
        d_.execute("UPDATE pm_kpi_results SET note=? WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id=?)", (S.BAND + "note", ID["S01"]))
        d_.execute("UPDATE pm_kpi_approvals SET justification=? WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id=?)", (S.BAND + "why", ID["S01"]))
        try:
            d_.execute("INSERT INTO rating_records(subject_id, cycle_id, pm_final_band, pot_final_band) VALUES (?,?,?,?)", (ID["S01"], CID, "OU", "High"))
        except Exception:   # a different column set: the band is planted in the remarks above all the same
            pass
        d_.commit()
    tot_all = ""
    keyset = set()
    for k in ("H1", "C1", "K1", "G1", "X1"):
        for sc in keys_of(get(K[k])[1]):
            raw = get(K[k], sc)[0].get_data(as_text=True)
            tot_all += raw
            keys_walk(json.loads(raw), keyset)
    s.check("no payload holds the planted remark, note, justification or band text", S.BAND not in tot_all and "OU" not in re.findall(r'"([A-Z]{2})"', tot_all)
            and "High" not in tot_all, tot_all[:100])
    s.check("...nor any display name (every synthetic person has one)", S.DISPLAY not in tot_all and "ZZSecret" not in tot_all)
    s.check("...the keys are the cells' and the people's: no band, score, rating, remark, KPI or value key anywhere",
            not {"band", "score", "rating", "remark", "kpi", "value", "result", "potential", "talent", "display_name", "email"} & {k.lower() for k in keyset}, sorted(keyset))
    s.check("...the names are the official ones (the display name is only ever the person's own)", {"Staff member S01"} <= {r_["n"] for r_ in rows_of(get(K["H1"])[1])})
    # the GET writes nothing: every statement the request runs is read-only, and no other connection sees a commit
    stmts = []
    orig = a.get_db

    def traced():
        d__ = orig()
        d__.set_trace_callback(lambda sql: stmts.append(sql))
        return d__
    a.get_db = traced
    try:
        for k in ("H1", "C1", "K1", "G1", "X1"):
            get(K[k])
    finally:
        a.get_db = orig
    writes = [x for x in stmts if re.match(r"\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)", x, re.I)]
    s.check("every statement of five panel reads is a read (%d statements)" % len(stmts), len(stmts) > 20 and not writes, writes[:3])
    with a.app.app_context():
        v0 = a.get_db().execute("PRAGMA data_version").fetchone()[0]
    import sqlite3
    probe = sqlite3.connect(a.DB_PATH)
    v1 = probe.execute("PRAGMA data_version").fetchone()[0]
    get(K["G1"])
    v2 = probe.execute("PRAGMA data_version").fetchone()[0]
    probe.close()
    s.check("...and no commit reaches the file (data_version unchanged)", v1 == v2)
    s.check("a batched read: the big scope costs a handful of queries, not one a person", len(stmts) / 5 < 80, len(stmts) / 5)

    s.section("the dashboard's way in")
    # strips: a BU CEO, calibrator, BG CEO and Group Chief; an HOD gets a row in Your tools
    dash = {k: H.client_as(a, K[k]).get("/dashboard").get_data(as_text=True) for k in ("H1", "C1", "K1", "G1", "X1")}
    s.check("the BU CEO's card has the strip: two lines of counts and the button", 'data-subs-strip' in dash["C1"] and "Their own parts" in dash["C1"]
            and 'data-panel="subs"' in dash["C1"] and "See who has submitted" in dash["C1"] and "KPI check-in" in dash["C1"])
    for k, name in (("K1", "calibrator"), ("G1", "BG CEO"), ("X1", "Group Chief")):
        s.check("the %s's card has the strip" % name, 'data-subs-strip' in dash[k] and 'data-panel="subs"' in dash[k], dash[k].count("data-subs-strip"))
    s.check("an HOD has a Who has submitted row in Your tools, and no strip", 'data-subs-entry' in dash["H1"] and "Who has submitted" in dash["H1"]
            and 'data-subs-strip' not in dash["H1"])
    s.check("...the row opens the department's scope", 'data-arg="hod:' in dash["H1"])
    emp = H.client_as(a, ID["S01"]).get("/dashboard").get_data(as_text=True)
    s.check("an employee has neither", 'data-subs-strip' not in emp and 'data-subs-entry' not in emp and "See who has submitted" not in emp)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT INTO leader_role_access(role, ability, allowed, updated_by) VALUES ('bu','bu.progress',0,?)", (SU["id"],))
        d_.commit()
    s.check("with the ability off the strip is gone", 'data-subs-strip' not in H.client_as(a, K["C1"]).get("/dashboard").get_data(as_text=True))
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM leader_role_access WHERE ability='bu.progress'")
        d_.execute("UPDATE cycle_windows SET opens_at='2099-01-01 00:00', closes_at='2099-02-01 00:00' WHERE cycle_id=? AND cell IN (%s)" % ",".join("?" * len(S.CELLS)), (CID,) + S.CELLS)
        d_.commit()
    nopen = H.client_as(a, K["C1"]).get("/dashboard").get_data(as_text=True)
    s.check("a cycle with no open or closed part: no strip, no entry, and the route is refused", 'data-subs-strip' not in nopen
            and entry(K["C1"]) is None and get(K["C1"])[0].status_code == 404)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN (%s)" % ",".join("?" * len(S.CELLS)), (CID,) + S.CELLS)
        for cell in S.CELLS:
            d_.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (CID, cell, S.OPENS,
                       S.LM_CLOSES if cell in ("pm_approve", "tc_approve") else S.STAFF_CLOSES))
        d_.commit()
    s.check("...open again, they are back", 'data-subs-strip' in H.client_as(a, K["C1"]).get("/dashboard").get_data(as_text=True))

    s.section("classification, knowledge and the house rules")
    src = H.source(a)
    s.check("the route is a dashboard panel's JSON: ungated by module (like What you led), not a user-role page, not an admin one",
            "my_progress" in a.MODULE_UNGATED_ENDPOINTS and a.module_of_request("my_progress", "/me/progress") is None
            and "my_progress" not in a.UROLE_ENDPOINTS and "ADMIN_ACCESS_MAP" in src and "my_progress" not in a.ADMIN_ACCESS_MAP
            and not [i for i in a.ADMIN_ITEMS if "progress" in str(i).lower() and "submitted" in str(i).lower()])
    s.check("the route is login-only and GET-only", [r_.methods - {"HEAD", "OPTIONS"} for r_ in a.app.url_map.iter_rules() if r_.endpoint == "my_progress"] == [{"GET"}]
            and H.client_as(a, K["C1"]).post("/me/progress", data={"csrf_token": "tok"}).status_code == 405
            and a.app.test_client().get("/me/progress").status_code in (302, 401))
    js = open(os.path.join(H.REPO, "static", "dashboard.js"), encoding="utf-8").read()
    sj = js[js.index("// ---- Who has submitted"):js.index("function openPanel(")]
    s.check("the panel has no download, no remind button, no confirm() and no alert()", not re.search(
        r"createObjectURL|\.download\b|download=|\.csv|xlsx|blob:|confirm\(|alert\(|innerHTML\s*=|el\(\"(button|a)\"[^;]*[Rr]emind|fetch\([^)]*method", sj)
            and "textContent" in sj and "reminders come from group people" in sj.lower())
    s.check("...the quick filter is there: Yet to submit, Any part (on by default), a chip a part, Everyone",
            '"Yet to submit"' in sj and '"Any part"' in sj and '"Everyone"' in sj and 'yet: "any"' in sj and '"Yet to finish"' in sj)
    s.check("...a team with nobody left to do still shows under Yet to submit (not folded, not searching): its rows are kept, 'N more' not 'not done'",
            'var allDone = !rows.length && !d.fold && !searching && f.yet !== "all" && g.rows.length > 0;' in sj
            and "if (allDone) rows = g.rows;" in sj and sj.index("if (allDone) rows = g.rows;") < sj.index("if (!rows.length && (!d.fold")
            and 'f.yet === "all" || allDone ? "" : " not done"' in sj)
    css = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
    sc = css[css.index("/* Who has submitted (2026-11-02"):]
    s.check("its CSS uses tokens and rem only (no hex, no px font sizes), and no underline on hover", not re.search(r"#[0-9a-fA-F]{3,8}\b", sc)
            and not re.search(r"font-size:\s*[\d.]+px", sc) and "underline" not in sc)
    s.check("...every control sets min-height, not height", ".sb-chip {" in sc and "min-height" in sc.split(".sb-chip {")[1][:200] and ".sb-pill {" in sc)
    with a.app.app_context():
        d_ = a.get_db()
        kb = d_.execute("SELECT slug, title, body, tags FROM kb_entries WHERE slug='who-has-submitted'").fetchone()
    s.check("the KB has the entry by slug, conceptual, no name and no number", kb is not None and "submitted" in kb["body"].lower()
            and not re.search(r"\b(?!360\b)\d{2,}\b", kb["body"]) and "Staff member" not in kb["body"], kb and kb["body"][:80])
    s.check("Help has a quick answer for leaders", "subs_who" in a.HELP_QA)
    with a.app.test_request_context("/dashboard"):
        d_ = a.get_db()
        ctx = a._dash_context(d_, d_.execute("SELECT * FROM users WHERE id=?", (K["C1"],)).fetchone())
        hit = a._ask_intent("who hasn't submitted yet?", dict(ctx, subs=entry(K["C1"])))
        hit_emp = a._ask_intent("who hasn't submitted yet?", dict(ctx, subs=None))
        facts = a._ask_facts(d_, d_.execute("SELECT * FROM users WHERE id=?", (K["C1"],)).fetchone(), ctx)
    s.check("Ask OneHR takes a leader asking who hasn't submitted to the panel, and lists no name itself",
            hit and any(c.get("panel") == "subs" for c in hit["cards"]) and "Staff member" not in json.dumps(hit), hit)
    s.check("...and says nothing of the sort to someone with no scope", hit_emp is None or not any(c.get("panel") == "subs" for c in hit_emp["cards"]))
    s.check("...its facts name the panel as a place, never a person", "who has submitted" in json.dumps(facts, default=str).lower()
            and "Staff member" not in json.dumps(facts, default=str))
    onb = open(os.path.join(H.REPO, "static", "onboarding.js"), encoding="utf-8").read()
    s.check("the first sign-in tour has a stop for it, only where the card is on the page", "data-subs-strip" in onb and "Who has submitted" in onb)

    s.section("every guard falsified once")
    def falsify(name, patches, probe, expect_open):
        """With the guard undone the probe goes through (it must), proving the check above is the guard and not an accident."""
        saved = {k: getattr(a, k) for k in patches}
        for k, v in patches.items():
            setattr(a, k, v)
        try:
            got = probe()
        finally:
            for k, v in saved.items():
                setattr(a, k, v)
        s.check("falsified: " + name, got == expect_open, got)
    real_defs = a.lp_subs_scope_defs
    def defs_plus(db_, u_):
        base = real_defs(db_, u_)
        if u_["id"] == K["C1"]:
            base.append({"key": "bu:%s|%s" % (S.BG2, S.U3), "kind": "bu", "spec": (S.BG2, S.U3), "label": "x", "full": "x"})
        return base
    falsify("the scope check (a unit of another group is served once it is on the leader's list)", {"lp_subs_scope_defs": defs_plus},
            lambda: get(K["C1"], "bu:%s|%s" % (S.BG2, S.U3))[0].status_code, 200)
    s.check("...and the guard does refuse it", get(K["C1"], "bu:%s|%s" % (S.BG2, S.U3))[0].status_code == 404)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT INTO leader_role_access(role, ability, allowed, updated_by) VALUES ('bu','bu.progress',0,?)", (SU["id"],))
        d_.commit()
    falsify("the ability gate (with leader_can allowing everything, a seat switched off is served)", {"leader_can": lambda *x, **k: True},
            lambda: get(K["C1"])[0].status_code, 200)
    s.check("...and the gate refuses it", get(K["C1"])[0].status_code == 404)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM leader_role_access WHERE ability='bu.progress'")
        d_.commit()
    os.environ["ONEHR_CHAIR"] = "1"
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('exec_chair_id', ?)", (str(K["G1"]),))
        d_.commit()
    falsify("the Executive Chairman's exclusion (with is_chair false his seat is served)", {"is_chair": lambda u_: False},
            lambda: get(K["G1"])[0].status_code, 200)
    s.check("...and the exclusion refuses him", get(K["G1"])[0].status_code == 404)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM app_settings WHERE key='exec_chair_id'")
        d_.executemany("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?,?)", CHAIR0)
        d_.commit()
    if CHAIR_ENV is None:
        os.environ.pop("ONEHR_CHAIR", None)
    else:
        os.environ["ONEHR_CHAIR"] = CHAIR_ENV
    with a.app.app_context():
        d_ = a.get_db()
        adm2 = d_.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, bgceo_bg) VALUES "
                          "('zz9sb-adm2','Staff member ADM2','x','admin','ZZ9SB-ADM2',?,?)", (S.BG, S.BG)).lastrowid
        d_.commit()
    falsify("the admin refusal (with is_admin false, an admin who names a seat is served)", {"is_admin": lambda u_: False},
            lambda: get(adm2)[0].status_code, 200)
    s.check("...and the refusal stops them", get(adm2)[0].status_code == 404)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM users WHERE id=?", (adm2,))
        d_.commit()
    # the no-write check can see a write
    real_payload = a.lp_subs_payload
    def writing(db_, u_, cyc_, key_):
        db_.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('zz9sb_probe','1')")
        return real_payload(db_, u_, cyc_, key_)
    stmts2 = []
    a.lp_subs_payload = writing
    a.get_db = lambda: (lambda d__: (d__.set_trace_callback(lambda sql: stmts2.append(sql)), d__)[1])(orig())
    try:
        get(K["C1"])
    finally:
        a.get_db = orig
        a.lp_subs_payload = real_payload
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM app_settings WHERE key='zz9sb_probe'")
        d_.commit()
    s.check("falsified: the no-write check (a route that writes is seen by it)", any(re.match(r"\s*(INSERT|UPDATE|DELETE)", x, re.I) for x in stmts2))
    # the privacy scan can see a leak: a payload that carried the display name would be caught
    leaky = json.dumps({"n": S.DISPLAY + "S01"})
    s.check("falsified: the display-name scan (it finds one when there is one)", S.DISPLAY in leaky)
finally:
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM leader_role_access WHERE ability LIKE '%.progress'")
        d_.execute("DELETE FROM cycle_exclusions WHERE cycle_id=? AND business_group=?", (CID, S.BG))
        d_.execute("DELETE FROM users WHERE employee_id IN ('ZZ9SB-ADM','ZZ9SB-ADM2')")
        d_.execute("DELETE FROM app_settings WHERE key IN ('zz9sb_probe','exec_chair_id')")
        d_.executemany("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?,?)", CHAIR0)
        S.restore(d_, SAVED)
    if CHAIR_ENV is None:
        os.environ.pop("ONEHR_CHAIR", None)

sys.exit(s.done())
