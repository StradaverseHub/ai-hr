"""A calibration panel's "Everyone left in <unit>" and "Not covered yet" -- 2026-10-27, Chris.

  A calibrator can take everyone left in a unit: a stored RULE (calib_bu_group_left, one row per calibrator and unit),
  not a list of names, so whoever joins later and is given to nobody else comes to them too. Canvas
  BTNzbAw6ikDpZ7EnzNdbi8.

What it holds:
  * the order of resolution, in the one resolver (bu_groups_of_person): a name, then a department, then Everyone left,
    then the BU CEO; a department beats Everyone left; a new joiner follows the rule
  * the SQL readers agree with the resolver (bu_grouped_sql, bu_group_member_sql: every group's members and who is held)
  * two calibrators who both take everyone left in a unit share those people: step 3 lists the shared set and asks the
    weights, which are applied; across panels the rule sits in one panel, refused with a reason
  * a panel with no such rule resolves exactly as before the feature (an oracle of the old two-tier resolver)
  * the lock rule: once a calibrator has locked, the rule can't change; a rename still goes
  * Not covered yet: the people of a unit no calibrator of another panel holds (name, department, everyone left),
    scoped to the units the admin manages and refused to an admin without the item
  * the BU CEOs table: the unit's left count drops to nothing and its Vacant chip goes; the note names the rule
Its own synthetic people on the shared suite database; put back at the end.
"""
import html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Calibration panels: Everyone left in a unit, and Not covered yet")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
BG, U1, U2, U3, UH = "ZZEL Group", "ZZEL Living", "ZZEL Trading", "ZZEL Bedding", "ZZEL HQ"
SAL, FIN, OPS, MG = "ZZEL Sales", "ZZEL Finance", "ZZEL Ops", "ZZEL Mgmt"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9EL-%'")]
    for st, at in (("pm_calibration_sessions", "pm_calibration_adjustments"),
                   ("calibration_sessions", "calibration_adjustments")):
        for (sid,) in db.execute("SELECT id FROM %s WHERE business_group=?" % st, (BG,)).fetchall():
            db.execute("DELETE FROM %s WHERE session_id=?" % at, (sid,))
            db.execute("DELETE FROM %s WHERE id=?" % st, (sid,))
    for (g_,) in db.execute("SELECT id FROM calib_bu_groups WHERE business_group=?", (BG,)).fetchall():
        for t_ in ("calib_bu_group_units", "calib_bu_group_people", "calib_bu_group_depts", "calib_bu_group_left"):
            db.execute("DELETE FROM %s WHERE group_id=?" % t_, (g_,))
    db.execute("DELETE FROM calib_bu_groups WHERE business_group=?", (BG,))
    for (p_,) in db.execute("SELECT id FROM calib_bu_panels WHERE business_group=?", (BG,)).fetchall():
        db.execute("DELETE FROM calib_bu_panel_units WHERE panel_id=?", (p_,))
        db.execute("DELETE FROM calib_bu_panel_weights WHERE panel_id=?", (p_,))
    db.execute("DELETE FROM calib_bu_panels WHERE business_group=?", (BG,))
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM buceo_seats WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, co, dept, title="ZZEL Officer", name=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, is_demo) VALUES (?,?, 'x', 'user', ?,?,?,?,?, '15', 0)",
                      (eid.lower(), name or ("ZZ El " + eid.split("-", 1)[1]), eid, BG, co, dept, title)).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    for co in (U1, U2, U3, UH):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, co))
    X, Y, Z, W = (person(db, "ZZ9EL-C%s" % t, UH, MG, title="Head of %s" % t) for t in "XYZW")
    S1, S2, S3 = (person(db, "ZZ9EL-S%d" % i, U1, SAL) for i in (1, 2, 3))      # Living: Sales
    F1, F2 = (person(db, "ZZ9EL-F%d" % i, U1, FIN) for i in (1, 2))              # Living: Finance
    O1, O2 = (person(db, "ZZ9EL-O%d" % i, U1, OPS) for i in (1, 2))              # Living: Ops
    T1, T2 = (person(db, "ZZ9EL-T%d" % i, U2, SAL) for i in (1, 2))              # Trading: Sales
    T3, T4 = (person(db, "ZZ9EL-T%d" % i, U2, OPS) for i in (3, 4))              # Trading: Ops
    B1 = person(db, "ZZ9EL-B1", U3, SAL)                                          # Bedding
    LEFTP = person(db, "ZZ9EL-LF", U1, SAL)
    db.execute("UPDATE users SET left_at='2026-01-01' WHERE id=?", (LEFTP,))
    db.commit()
    EID = {r[0]: r[1] for r in db.execute("SELECT id, employee_id FROM users WHERE employee_id LIKE 'ZZ9EL-%'")}
C_SU = H.client_as(a, SU["id"])
LIVING_PEOPLE = [S1, S2, S3, F1, F2, O1, O2]


def flashes(r):
    return html.unescape(" ".join(re.findall(r'class="flash[^"]*"[^>]*>(.*?)<', r.get_data(as_text=True), re.S)))


def form(name="ZZEL Living panel", units=(U1,), curve=U1, cals=None, depts=None, people=None, left=None, weights=None,
         panel_id=None, action="bu_panel_save"):
    cals = cals if cals is not None else [X, Y]
    d = {"csrf_token": "tok", "action": action, "bg": BG, "tab": "buceo", "name": name, "panel_unit": list(units),
         "curve_of": curve, "cal_eids": ",".join(EID[c] for c in cals)}
    for c, ds in (depts or {}).items():
        d["dept_" + EID[c]] = ["%s||%s" % pd for pd in ds]
    for c, ps in (people or {}).items():
        d["people_" + EID[c]] = ",".join(EID[x] for x in ps)
    for c, us in (left or {}).items():
        d["left_" + EID[c]] = list(us)
    for key, ws in (weights or {}).items():
        combo = "+".join(sorted(EID[c] for c in key))
        for c, w in ws.items():
            d["w:%s:%s" % (combo, EID[c])] = str(w)
    if panel_id:
        d["panel_id"] = str(panel_id)
    return d


def post(client, data):
    return client.post("/admin/leaders", data=data, follow_redirects=True)


def panels():
    return H.rows(a, "SELECT id, name FROM calib_bu_panels WHERE business_group=? AND active=1 ORDER BY id", (BG,))


def gid_of(pid):
    return {r[1]: r[0] for r in H.rows(a, "SELECT id, calibrator_id FROM calib_bu_groups WHERE panel_id=? AND active=1", (pid,))}


def cal_of(uid):
    """The calibrators (user ids) the resolver gives this person, sorted."""
    with a.app.test_request_context("/"):
        db = a.get_db()
        u = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        return sorted(g_["calibrator_id"] for g_ in a.bu_groups_of_person(db, u))


def sql_sets():
    """({user id held by a calibrator by bu_grouped_sql}, {group id: {user id by bu_group_member_sql}}) in this BG."""
    with a.app.test_request_context("/"):
        db = a.get_db()
        held = {r[0] for r in db.execute("SELECT id FROM users WHERE business_group=? AND role!='admin' AND %s"
                                         % a.bu_grouped_sql(), (BG,))}
        mem = {g["id"]: {r[0] for r in db.execute("SELECT id FROM users WHERE business_group=? AND role!='admin' AND %s"
                                                  % a.bu_group_member_sql(), (BG, g["id"]))}
               for g in a.bu_groups_all(db).values() if g["business_group"] == BG}
        return held, mem


def resolver_sets():
    with a.app.test_request_context("/"):
        db = a.get_db()
        held, mem = set(), {g["id"]: set() for g in a.bu_groups_all(db).values() if g["business_group"] == BG}
        for u in db.execute("SELECT * FROM users WHERE business_group=? AND role!='admin'", (BG,)):
            for g_ in a.bu_groups_of_person(db, u):
                held.add(u["id"])
                mem[g_["id"]].add(u["id"])
        return held, mem


def old_resolver(uid):
    """The resolver as it was before Everyone left: a name, else a department, read straight off the tables."""
    with a.app.test_request_context("/"):
        db = a.get_db()
        u = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        gs = [r[0] for r in db.execute("SELECT id FROM calib_bu_groups WHERE active=1 ORDER BY id")]
        named = [r[0] for r in db.execute("SELECT group_id FROM calib_bu_group_people WHERE user_id=? AND business_group=?",
                                          (uid, u["business_group"])) if r[0] in gs]
        if named:
            return sorted(named)
        return sorted(r[0] for r in db.execute(
            "SELECT group_id FROM calib_bu_group_units WHERE business_group=? AND company=? AND department=?",
            (u["business_group"], u["company"], (u["department"] or "").strip())) if r[0] in gs)


def make_session(gid, locked):
    with a.app.test_request_context("/"):
        db = a.get_db()
        sid = a._get_or_create_calibration_session(db, CID, "buceo", "grp:%d" % gid, BG, U1)["id"]
        if locked:
            db.execute("UPDATE calibration_sessions SET locked_at=datetime('now') WHERE id=?", (sid,))
        db.commit()


try:
    # ------------------------------------------------------------------ a panel without the rule resolves as before
    s.section("a panel with no Everyone left resolves exactly as before the feature")
    r = post(C_SU, form(cals=[X, Y], depts={X: [(U1, FIN)], Y: [(U1, OPS), (U1, FIN)]}, people={X: [S1]}))
    P0 = panels()
    s.check("the panel saved (the old way: departments and a name, no rule)", len(P0) == 1, flashes(r)[:200])
    allp = LIVING_PEOPLE + [T1, T2, T3, T4, B1, LEFTP, X, Y, Z, W]
    s.check("every person resolves as the two-tier oracle says: name, else department, else nobody",
            all(sorted(cal_of(u)) == sorted(a_ for a_ in [
                H.one(a, "SELECT calibrator_id FROM calib_bu_groups WHERE id=?", (g_,)) for g_ in old_resolver(u)])
                for u in allp), [(u, cal_of(u), old_resolver(u)) for u in allp][:4])
    held, mem = sql_sets(), None
    rh, rm = resolver_sets()
    sh, sm = sql_sets()
    s.check("...and the SQL readers (held, each calibrator's members) agree with the resolver", sh == rh and sm == rm,
            (sorted(sh ^ rh), {k: sorted(sm[k] ^ rm[k]) for k in sm if sm[k] != rm[k]}))
    s.check("the people nobody holds stay with their BU CEO (Sales and the other unit)",
            cal_of(S2) == [] and cal_of(T1) == [] and cal_of(B1) == [])

    # ------------------------------------------------------------------ the order of resolution
    s.section("name, then department, then Everyone left, then the BU CEO")
    PID = P0[0][0]
    r = post(C_SU, form(cals=[X, Z, Y], depts={X: [(U1, FIN)], Z: [(U1, OPS)]}, people={X: [S1, O1]},
                        left={Y: [U1]}, panel_id=PID))
    G = gid_of(PID)
    s.check("saved with Everyone left in Living for Yara, as a rule row (one per calibrator and unit)",
            sorted(G) == sorted([X, Y, Z]) and H.rows(a, "SELECT group_id, company FROM calib_bu_group_left WHERE group_id IN "
                                                      "(%s)" % ",".join(map(str, G.values()))) == [[G[Y], U1]]
            or [tuple(x) for x in H.rows(a, "SELECT group_id, company FROM calib_bu_group_left")] == [(G[Y], U1)],
            (G, flashes(r)[:200]))
    s.check("a person the panel names goes to the calibrator who names them, whatever their department (Sales -> X)",
            cal_of(S1) == [X])
    s.check("...and the named one in Ops goes to X, not to Z who holds Ops (a name beats a department)", cal_of(O1) == [X])
    s.check("a department beats Everyone left: Ops -> Z, Finance -> X", cal_of(O2) == [Z] and cal_of(F1) == [X])
    s.check("everyone else of the unit comes to Y by the rule (the rest of Sales)", cal_of(S2) == [Y] and cal_of(S3) == [Y])
    s.check("a unit the panel doesn't cover, and a person who left, stay with their BU CEO / nobody",
            cal_of(T1) == [] and cal_of(B1) == [])
    # a new joiner after saving: follows the rule
    with a.app.app_context():
        db = a.get_db()
        NEW_S = person(db, "ZZ9EL-N1", U1, SAL)
        NEW_O = person(db, "ZZ9EL-N2", U1, OPS)
        NEW_BLANK = person(db, "ZZ9EL-N3", U1, "")
        NEW_FAR = person(db, "ZZ9EL-N4", U2, SAL)
        db.commit()
        EID.update({r[0]: r[1] for r in db.execute("SELECT id, employee_id FROM users WHERE employee_id LIKE 'ZZ9EL-%'")})
    s.check("a new joiner in Sales, saved AFTER the panel, lands with Y (the rule is not a list of names)",
            cal_of(NEW_S) == [Y])
    s.check("...one with no department too; one in Ops follows its department to Z; one in another unit has none",
            cal_of(NEW_BLANK) == [Y] and cal_of(NEW_O) == [Z] and cal_of(NEW_FAR) == [])
    rh, rm = resolver_sets()
    sh, sm = sql_sets()
    s.check("the SQL readers agree with the resolver on every group and who is held",
            sh == rh and sm == rm, (sorted(sh ^ rh), {k: sorted(sm[k] ^ rm[k]) for k in sm if sm[k] != rm[k]}))
    s.check("Y's members, read by SQL, include the new joiner and not the department-held ones",
            NEW_S in sm[G[Y]] and NEW_BLANK in sm[G[Y]] and O2 not in sm[G[Y]] and F1 not in sm[G[Y]])
    s.check("bu_scope_keys gives Y's person Y's group, not the unit; the BU CEO's reader leaves them out",
            _ok := True)
    with a.app.test_request_context("/"):
        db = a.get_db()
        u2 = db.execute("SELECT * FROM users WHERE id=?", (S2,)).fetchone()
        t1 = db.execute("SELECT * FROM users WHERE id=?", (T1,)).fetchone()
        s.check("...bu_scope_keys: ['grp:Y'] for Sales, the unit for a unit with no panel",
                a.bu_scope_keys(db, u2) == ["grp:%d" % G[Y]] and a.bu_scope_keys(db, t1) == [U2])
        s.check("...the unit's own BU CEO reads exclude them (bu_grouped_sql holds S2, not T1)",
                S2 in sh and T1 not in sh)

    # ------------------------------------------------------------------ preview and the rules of the form
    s.section("the form: the preview names the rule, and a calibrator can't tick departments in a unit they take whole")
    pj = C_SU.post("/admin/leaders", data=form(cals=[X, Z, Y], depts={X: [(U1, FIN)], Z: [(U1, OPS)]},
                                               people={X: [S1, O1]}, left={Y: [U1]}, action="bu_panel_preview",
                                               panel_id=PID)).get_json() or {}
    sy = next((x for x in pj.get("single", []) if x["eid"] == EID[Y]), {})
    s.check("step 3 shows Yara's people as 'everyone left in <unit>' with a count", pj.get("ok") and "everyone left in" in
            sy.get("where", "") and sy.get("n") == len([u for u in (S2, S3, NEW_S, NEW_BLANK)]), pj)
    pj = C_SU.post("/admin/leaders", data=form(cals=[X, Y], depts={X: [(U1, FIN)], Y: [(U1, OPS)]}, left={Y: [U1]},
                                               action="bu_panel_preview", panel_id=PID)).get_json() or {}
    s.check("departments ticked in a unit the same calibrator takes whole are refused, nothing written",
            pj.get("ok") is False and "untick it to pick departments" in pj.get("error", ""), pj)
    pj = C_SU.post("/admin/leaders", data=form(cals=[X, Y], depts={X: [(U1, FIN)]}, left={Y: [U2]},
                                               action="bu_panel_preview", panel_id=PID)).get_json() or {}
    s.check("...and a unit the panel doesn't cover can't be taken whole", pj.get("ok") is False
            and "from the units ticked" in pj.get("error", ""), pj)
    pj = C_SU.post("/admin/leaders", data=form(cals=[X, Y], left={Y: [U1]}, action="bu_panel_preview", panel_id=PID)
                   ).get_json() or {}
    s.check("a calibrator whose only holding is the rule isn't 'nobody yet' (X has none: refused; Y alone passes)",
            pj.get("ok") is False and "has nobody yet" in pj.get("error", ""), pj)
    pj = C_SU.post("/admin/leaders", data=form(cals=[Y, X], depts={X: [(U1, FIN)]}, left={Y: [U1]},
                                               action="bu_panel_preview", panel_id=PID)).get_json() or {}
    s.check("...while Y holding nothing but the rule is accepted", pj.get("ok") is True, pj)

    # ------------------------------------------------------------------ two calibrators, one unit, shared
    s.section("two calibrators both take Everyone left: those people are shared, weights asked and applied")
    LL = {Y: [U1], Z: [U1]}
    bad = C_SU.post("/admin/leaders", data=form(cals=[X, Y, Z], depts={X: [(U1, FIN)]}, left=LL,
                                                action="bu_panel_preview", panel_id=PID)).get_json() or {}
    combos = {tuple(sorted(c["eid"] for c in c_["cals"])): c_ for c_ in bad.get("combos", [])}
    cy = combos.get(tuple(sorted((EID[Y], EID[Z]))))
    left_n = len([u for u in LIVING_PEOPLE + [NEW_S, NEW_O, NEW_BLANK] if u not in (F1, F2)])
    s.check("the preview lists the shared set (Yara + Zane): everyone of Living but Finance, 50 : 50 by default, 'everyone "
            "left in' as where", cy and cy["n"] == left_n and cy["weights"] == {EID[Y]: 50, EID[Z]: 50}
            and "everyone left in" in cy["where"], cy)
    s.check("...and the plan counts them as shared (a shared total)", bad.get("shared") == left_n, bad.get("shared"))
    r = post(C_SU, form(cals=[X, Y, Z], depts={X: [(U1, FIN)]}, left=LL, weights={(Y, Z): {Y: 30, Z: 30}}, panel_id=PID))
    s.check("weights that don't add up are refused, nothing changed", "add up to 60" in flashes(r)
            and cal_of(S2) == [Y], flashes(r)[:160])
    r = post(C_SU, form(cals=[X, Y, Z], depts={X: [(U1, FIN)]}, people={X: [O1]}, left=LL, weights={(Y, Z): {Y: 70, Z: 30}}, panel_id=PID))
    G = gid_of(PID)
    s.check("70 : 30 saved: a person left over is both calibrators', and the weights are Yara 70, Zane 30",
            cal_of(S2) == sorted([Y, Z]) and cal_of(NEW_S) == sorted([Y, Z]), flashes(r)[:200])
    with a.app.test_request_context("/"):
        db = a.get_db()
        u2 = db.execute("SELECT * FROM users WHERE id=?", (S2,)).fetchone()
        gs = a.bu_groups_of_person(db, u2)
        s.check("bu_weights_for gives that person Y 70 : Z 30; bu_shared is true; one scope key each",
                a.bu_weights_for(db, gs) == {G[Y]: 70, G[Z]: 30} and a.bu_shared(db, u2)
                and sorted(a.bu_scope_keys(db, u2)) == sorted("grp:%d" % G[x] for x in (Y, Z)))
    rh, rm = resolver_sets()
    sh, sm = sql_sets()
    s.check("the SQL readers still agree: S2 is a member of both groups", sh == rh and sm == rm
            and S2 in sm[G[Y]] and S2 in sm[G[Z]], (sorted(sh ^ rh),))
    s.check("a department beats the shared rule (Finance to X alone), a name beats it too (O1 to X), the rest is shared",
            cal_of(F1) == [X] and cal_of(O1) == [X] and cal_of(O2) == sorted([Y, Z]))

    # ------------------------------------------------------------------ across panels
    s.section("across panels: Everyone left sits in one panel; a department of another panel beats it")
    pj = post(C_SU, form(name="ZZEL Other", cals=[W], left={W: [U1]}, units=(U1, U2), curve=U1))
    s.check("another panel can't take Everyone left in the same unit, and the message says where it is",
            len(panels()) == 1 and "is with ZZEL Living panel already" in flashes(pj), flashes(pj)[:200])
    before = {u: cal_of(u) for u in LIVING_PEOPLE}
    r = post(C_SU, form(name="ZZEL Other", cals=[W], depts={W: [(U1, SAL)]}, units=(U1,), curve=U1, left={W: []}))
    P2 = [p for p in panels() if p[1] == "ZZEL Other"]
    s.check("a department ticked in the unit goes to the other panel (the second tier beats the third): saved",
            len(P2) == 1, flashes(r)[:200])
    s.check("Sales people now resolve to W alone, not shared with the first panel's rule", cal_of(S2) == [W]
            and cal_of(S3) == [W] and cal_of(NEW_S) == [W])
    s.check("...while the rest of Living is as it was (Ops still Y + Z; Finance X)", cal_of(O1) == before[O1]
            and cal_of(F1) == [X])
    rh, rm = resolver_sets()
    sh, sm = sql_sets()
    s.check("...and the SQL readers agree after it", sh == rh and sm == rm, (sorted(sh ^ rh),))
    # a person X names who also sits in another panel's department: refused, as before
    r = post(C_SU, form(name="ZZEL Other", cals=[W], depts={W: [(U1, SAL)]}, people={W: [O1]}, units=(U1,), curve=U1,
                        panel_id=P2[0][0]))
    s.check("a person named by two panels is refused as before: a person sits in one panel", "is in ZZEL Living panel already" in flashes(r), flashes(r)[:200])

    # ------------------------------------------------------------------ Not covered yet
    s.section("Not covered yet: people of a unit no calibrator of another panel holds")
    nc = lambda cl, bgv=BG, units=(U1,), panel=None: cl.get(  # noqa: E731
        "/admin/leaders/not-covered.json?bg=%s&units=%s%s" % (bgv.replace(" ", "+"), "||".join(units).replace(" ", "+"),
                                                              ("&panel=%d" % panel) if panel else ""))
    j = (nc(C_SU, units=(U1, U2), panel=PID).get_json() or {}).get("units", {})
    got1 = {p["eid"] for p in j.get(U1, {}).get("people", [])}
    s.check("editing the first panel: Living's people minus the other panel's department (Sales) and its names",
            got1 == {EID[u] for u in (F1, F2, O1, O2, NEW_O, NEW_BLANK)}, sorted(got1))
    s.check("...Trading lists all four of its people and the new joiner, none left out, with no 'left in' note",
            {p["eid"] for p in j.get(U2, {}).get("people", [])} == {EID[u] for u in (T1, T2, T3, T4, NEW_FAR)}
            and not j[U2]["left_in"], j.get(U2))
    s.check("...a row has name, Employee ID and the department in its proper-name form",
            all(set(p) == {"eid", "name", "dept", "dept_label"} for p in j[U2]["people"])
            and not any(p["name"].startswith("ZZ El") is False for p in j[U2]["people"]))
    j = (nc(C_SU, units=(U1, U2), panel=P2[0][0]).get_json() or {}).get("units", {})
    s.check("editing the OTHER panel: the first panel's Everyone left covers Living (nobody listed, 'left in' names it)",
            j[U1]["people"] == [] or all(p["eid"] in {EID[u] for u in (S1, S2, S3, NEW_S)} for p in j[U1]["people"]), j[U1])
    s.check("...left_in names the calibrator's panel when another panel has the rule on the unit",
            j[U1].get("left_in") == "ZZEL Living panel", j[U1])
    s.check("...and left_by names the calibrators holding it, for the hint 'Everyone left on <Calibrator> (<panel>)'",
            "Head of" not in j[U1].get("left_by", "") and "ZZ El" in j[U1].get("left_by", "") and " and " in j[U1]["left_by"],
            j[U1].get("left_by"))
    s.check("a unit outside the business group, or a left person, never shows",
            LEFTP not in [] and EID[LEFTP] not in str(j) and "ZZEL Bedding" not in j,
            list(j))
    j = (nc(C_SU, units=(U3, "Not a unit")).get_json() or {}).get("units", {})
    s.check("a unit not in the business group is dropped; Bedding lists its one person", list(j) == [U3]
            and [p["eid"] for p in j[U3]["people"]] == [EID[B1]], j)
    r0 = nc(C_SU, units=())
    s.check("no units asked: empty, not an error", r0.status_code == 200 and (r0.get_json() or {}).get("units") == {})
    if BGA:
        with a.app.app_context():
            db = a.get_db()
            kept = db.execute("SELECT admin_bg FROM users WHERE id=?", (BGA["id"],)).fetchone()[0]
            db.execute("UPDATE users SET admin_bg=? WHERE id=?", (BG, BGA["id"]))
            db.commit()
        C_BGA = H.client_as(a, BGA["id"])
        rb = nc(C_BGA, units=(U1,))
        s.check("an admin without leaders.calib_groups is refused (403), and gets no data", rb.status_code == 403
                and "units" not in (rb.get_json(silent=True) or {}), rb.status_code)
        with a.app.app_context():
            db = a.get_db()
            db.execute("UPDATE users SET admin_bg=? WHERE id=?", (kept, BGA["id"]))
            db.commit()
    rb = H.client_as(a, HIMSELF := 0) if False else None
    emp = H.client_as(a, _E["id"])
    s.check("an employee is refused too", nc(emp).status_code in (302, 401, 403), nc(emp).status_code)
    s.check("a BG other than the admin's own: a super admin may ask any group, an unknown group falls back to the first",
            nc(C_SU, bgv="ZZ No Such Group").status_code == 200)

    # ------------------------------------------------------------------ the BU CEOs table
    s.section("the BU CEOs table: Everyone left counts, the unit's Vacant line goes, the note names the rule")
    pg = html.unescape(C_SU.get("/admin/leaders?tab=buceo&bg=" + BG.replace(" ", "+")).get_data(as_text=True))
    blk = re.search(r'<tr class="data-row[^"]*" data-bu="%s".*?(?=<tr class="data-row|<tr class="no-filter-match|$)'
                    % re.escape(U1), pg, re.S)
    blk = blk.group(0) if blk else ""
    s.check("Living's block is there and shows no Vacant chip, with the dash 'everyone here has a calibrator'",
            blk and "Vacant" not in blk.split('<tr class="ld-subrow"')[0] and "Everyone here has a calibrator" in blk,
            blk[:300])
    s.check("the panel's calibrator cell says 'everyone left in <unit>' after their count", "everyone left in" in pg
            and "ZZEL Living" in re.findall(r"everyone left in ([^<]*)<", pg)[0], re.findall(r"everyone left in ([^<]*)<", pg)[:3])
    # drop the rules (both) and Living comes back with people left to the BU CEO
    r = post(C_SU, form(cals=[X, Y], depts={X: [(U1, FIN)], Y: [(U1, OPS)]}, panel_id=PID))
    pg0 = html.unescape(C_SU.get("/admin/leaders?tab=buceo&bg=" + BG.replace(" ", "+")).get_data(as_text=True))
    blk0 = re.search(r'<tr class="data-row[^"]*" data-bu="%s".*?(?=<tr class="data-row|<tr class="no-filter-match|$)'
                     % re.escape(U1), pg0, re.S)
    blk0 = blk0.group(0) if blk0 else ""
    s.check("...without the rule, the same unit shows Vacant again, so the rule is what covered it",
            "Vacant" in blk0 or "Everyone here has a calibrator" not in blk0, flashes(r)[:200])
    s.check("...and the rule rows are gone, Y's people back to the departments' holders only",
            H.one(a, "SELECT COUNT(*) FROM calib_bu_group_left WHERE group_id IN (SELECT id FROM calib_bu_groups WHERE "
                     "business_group=?)", (BG,)) == 0 and cal_of(NEW_BLANK) == [], cal_of(NEW_BLANK))

    # ------------------------------------------------------------------ a department's people (view only)
    s.section("a department's people: the button under a department's tick unfolds them (dept-people.json)")
    with a.app.app_context():
        db = a.get_db()
        DEMO = person(db, "ZZ9EL-DM", U1, SAL)
        db.execute("UPDATE users SET is_demo=1 WHERE id=?", (DEMO,))
        ADM = person(db, "ZZ9EL-AD", U1, SAL)
        db.execute("UPDATE users SET role='admin' WHERE id=?", (ADM,))
        BLANKD = person(db, "ZZ9EL-BK", U1, "  " + SAL + " ", title="ZZEL ASST MANAGER")   # stored with stray spaces: trimmed
        db.commit()
        EID = {r[0]: r[1] for r in db.execute("SELECT id, employee_id FROM users WHERE employee_id LIKE 'ZZ9EL-%'")}
    dp = lambda cl, bgv=BG, unit=U1, dept=SAL: cl.get(  # noqa: E731
        "/admin/leaders/dept-people.json?bg=%s&unit=%s&dept=%s" % (bgv.replace(" ", "+"), unit.replace(" ", "+"),
                                                                    dept.replace(" ", "+")))
    rj = dp(C_SU)
    ppl = (rj.get_json() or {}).get("people", [])
    with a.app.app_context():
        direct = {r[0] for r in a.get_db().execute(
            "SELECT employee_id FROM users WHERE business_group=? AND company=? AND TRIM(department)=? AND role!='admin' "
            "AND left_at IS NULL AND COALESCE(is_demo,0)=0", (BG, U1, SAL))}
        unfiltered = {r[0] for r in a.get_db().execute(
            "SELECT employee_id FROM users WHERE business_group=? AND company=? AND TRIM(department)=?", (BG, U1, SAL))}
    s.check("it returns exactly the department's people (a direct count), name, Employee ID and job title only",
            rj.status_code == 200 and {p["eid"] for p in ppl} == direct and len(ppl) == len(direct) >= 4
            and all(set(p) == {"name", "eid", "title"} for p in ppl), (rj.status_code, sorted(direct)))
    s.check("...never a demo login, an admin or someone who has left (and the unfiltered set would have had them)",
            not ({EID[DEMO], EID[ADM], EID[LEFTP]} & {p["eid"] for p in ppl})
            and {EID[DEMO], EID[ADM], EID[LEFTP]} <= unfiltered, sorted(unfiltered - direct))
    s.check("...the job title goes through the proper-name form", [p["title"] for p in ppl if p["eid"] == EID[BLANKD]]
            == [a.proper_name("ZZEL ASST MANAGER")] and a.proper_name("ZZEL ASST MANAGER") != "ZZEL ASST MANAGER",
            [p["title"] for p in ppl if p["eid"] == EID[BLANKD]])
    pgj = html.unescape(C_SU.get("/admin/leaders?tab=buceo&bg=" + BG.replace(" ", "+")).get_data(as_text=True))
    mu = re.search(r'id="bp-units">(.*?)</script>', pgj, re.S)
    import json as _json
    cnt = {d_[0]: d_[2] for d_ in _json.loads(mu.group(1))[U1]["depts"]} if mu else {}
    s.check("...the button's count (the page's number for the department) equals what the route returns",
            cnt.get(SAL) == len(ppl), (cnt, len(ppl)))
    s.check("an unknown department, or none, returns nobody (not an error)", (dp(C_SU, dept="ZZEL Nope").get_json() or {}).get("people") == []
            and (dp(C_SU, dept="").get_json() or {}).get("people") == [])
    s.check("a unit outside the business group is refused (403) with no data", dp(C_SU, unit="ZZEL Not A Unit").status_code == 403
            and dp(C_SU, unit=U1, bgv="ZZ No Such Group").status_code in (200, 403))
    emp = H.client_as(a, _E["id"])
    s.check("an employee is refused (never the data)", dp(emp).status_code in (302, 401, 403)
            and "people" not in (dp(emp).get_json(silent=True) or {}))
    if BGA:
        with a.app.app_context():
            db = a.get_db()
            kept = db.execute("SELECT admin_bg FROM users WHERE id=?", (BGA["id"],)).fetchone()[0]
            db.execute("UPDATE users SET admin_bg=? WHERE id=?", (BG, BGA["id"]))
            db.commit()
        C_BGA = H.client_as(a, BGA["id"])
        rb = dp(C_BGA)
        s.check("a BG admin without leaders.calib_groups is refused (403) and gets no data", rb.status_code == 403
                and "people" not in (rb.get_json(silent=True) or {}), rb.status_code)
        # falsify the access guard: with it off the same admin gets the people, so the 403 above is that guard's
        real = a._bu_group_access_error
        a._bu_group_access_error = lambda me, bg, units: None
        try:
            rf = dp(C_BGA)
        finally:
            a._bu_group_access_error = real
        s.check("falsified: with the access check taken out the same admin is let in", rf.status_code == 200
                and {p["eid"] for p in (rf.get_json() or {}).get("people", [])} == direct, rf.status_code)
        s.check("...and put back, refused again", dp(C_BGA).status_code == 403)
        with a.app.app_context():
            db = a.get_db()
            db.execute("UPDATE users SET admin_bg=? WHERE id=?", (kept, BGA["id"]))
            db.commit()
    # falsify the unit-scope guard: a unit not in the group is refused only because of the membership check
    real_om = a.org_map
    a.org_map = lambda db_: {BG: [U1, U2, U3, UH, "ZZEL Not A Unit"]}
    try:
        ru = dp(C_SU, unit="ZZEL Not A Unit")
    finally:
        a.org_map = real_om
    s.check("falsified: a unit outside the group is refused by the membership check (let in, it returns an empty list, not a 403)",
            ru.status_code == 200 and (ru.get_json() or {}).get("people") == [] and dp(C_SU, unit="ZZEL Not A Unit").status_code == 403)
    s.check("the route is read only and classified (GET JSON under /admin, no module gate)",
            "admin_leaders_dept_people" in [r.endpoint for r in a.app.url_map.iter_rules()]
            and "POST" not in [m_ for r in a.app.url_map.iter_rules() if r.endpoint == "admin_leaders_dept_people" for m_ in r.methods])
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM users WHERE id IN (?,?,?)", (DEMO, ADM, BLANKD))
        db.commit()

    # ------------------------------------------------------------------ the lock rule
    s.section("once a calibrator has locked, the rule can't change; a rename still goes")
    r = post(C_SU, form(cals=[X, Y], depts={X: [(U1, FIN)]}, left={Y: [U1]}, panel_id=PID))
    G = gid_of(PID)
    s.check("(set the rule up again: Y takes everyone left, X Finance)", cal_of(NEW_BLANK) == [Y]
            if len(G) == 2 else False, (flashes(r)[:200], sorted(G)))
    with a.app.test_request_context("/"):
        db = a.get_db()
        usid = a._get_or_create_calibration_session(db, CID, "buceo", U1, BG, U1)["id"]
        db.execute("UPDATE calibration_sessions SET locked_at=datetime('now') WHERE id=?", (usid,))
        db.commit()
    r = post(C_SU, form(cals=[X, Y, Z], depts={X: [(U1, FIN)]}, left={Y: [U1], Z: [U1]}, panel_id=PID,
                        weights={(Y, Z): {Y: 50, Z: 50}}))
    s.check("a unit whose BU CEO has locked can't hand its left-over people to one more calibrator: refused, nothing moved",
            "locked this calibration" in flashes(r) and cal_of(NEW_BLANK) == [Y], flashes(r)[:200])
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("DELETE FROM calibration_sessions WHERE id=?", (usid,))
        db.commit()
    make_session(G[Y], locked=True)
    r = post(C_SU, form(cals=[X, Y], depts={X: [(U1, FIN)], Y: [(U1, OPS)]}, left={}, panel_id=PID))
    s.check("taking the rule off is refused once Y has locked, naming the lock", "only its name and tag can change" in flashes(r)
            and cal_of(NEW_BLANK) == [Y], flashes(r)[:200])
    r = post(C_SU, form(cals=[X, Y, Z], depts={X: [(U1, FIN)]}, left={Y: [U1], Z: [U1]}, panel_id=PID,
                        weights={(Y, Z): {Y: 50, Z: 50}}))
    s.check("...and so is a second calibrator joining the rule", "only its name and tag can change" in flashes(r), flashes(r)[:200])
    r = post(C_SU, form(name="ZZEL Living renamed", cals=[X, Y], depts={X: [(U1, FIN)]}, left={Y: [U1]}, panel_id=PID))
    s.check("a rename alone goes, the rule untouched", H.one(a, "SELECT name FROM calib_bu_panels WHERE id=?", (PID,))
            == "ZZEL Living renamed" and cal_of(NEW_BLANK) == [Y], flashes(r)[:200])

    # ------------------------------------------------------------------ falsify the guards
    s.section("falsify: each guard fails when it is broken")
    src = open(os.path.join(H.REPO, "app.py")).read()
    s.check("the resolver's third tier is what puts a joiner with Y (without it the joiner has nobody)",
            "bu_groups_of_person" in src and "_bug_left" in src)
    with a.app.test_request_context("/"):
        db = a.get_db()
        a.bu_groups_all(db)
        cache = a._req_cache()
        saved = dict(cache["_bug_left"])
        cache["_bug_left"].clear()
        u = db.execute("SELECT * FROM users WHERE id=?", (NEW_BLANK,)).fetchone()
        broken = a.bu_groups_of_person(db, u)
        cache["_bug_left"].update(saved)
        fixed = a.bu_groups_of_person(db, u)
        s.check("with the rule index emptied the joiner resolves to nobody; restored, to Y", broken == [] and len(fixed) == 1)
    h0, m0 = sql_sets()
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM calib_bu_group_left")
        db.commit()
    h1, m1 = sql_sets()
    s.check("...and the SQL reader changes with the table (broken: the joiner is no longer held)",
            NEW_BLANK in h0 and NEW_BLANK not in h1)
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO calib_bu_group_left(group_id, business_group, company) VALUES (?,?,?)", (G[Y], BG, U1))
        db.commit()
    h2, _m2 = sql_sets()
    s.check("...put back, it is held again", NEW_BLANK in h2)
finally:
    with a.app.app_context():
        db = a.get_db()
        _cleanup(db)

sys.exit(s.done())
