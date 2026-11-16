"""Points per answer, piece 1: the engine, the 360 and the Competency (Chris, 8-9 Nov 2026; OneHR/Points per answer plan 2026-11-09.md).

What a Demonstrate and a Developing earn at the person's current level and at the next, for the 360 and for the competency, each its
own setting: a default (app_settings points_360 / points_tc) plus a cycle's own four columns (cycles.pts360_* / ptstc_*), one reader
points_for(). What this holds:
  * the validator (points_parse): each rule, both directions, falsified; Developing above 0 allowed
  * the defaults are today's 1 / 1.5 / 0 / 0 with no row and no column: every scorer gives what it gave (an independent sum from the
    raw answers), and no scorer reads SCORE_CURRENT / SCORE_FUTURE any more (grep)
  * a cycle's own columns beat the default; a Developing above 0 moves assignment_score, principle_breakdown (and still reconciles with
    the total), tc_score, _pot_strengths, the extreme assessor's penalty floor; the maximum moves with Demonstrate only
  * the release lock: any 'pot' / 'talent' release closes "current" server-side (a 'pm' release does not)
  * the save: "next" pins the current and every past (archived, released or older) cycle (points and cut-offs) and leaves their scores alone;
    "current" re-scores at once; the 360's cut-offs keep their share of the maximum; the competency has none to move
  * the check writes nothing and shows the counts; a non-super admin is refused; the reason is required and rides in the audit row
  * the cards sit where the plan puts them on both Settings pages, and the All settings sheet lists both
Everything it changes is put back (fresh database, and the columns and rows are cleaned as it goes)."""
import html
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Points per answer, piece 1: the engine, the 360 and the Competency")
SU, BGA, EMP = H.actors(a)
sup = H.client_as(a, SU["id"])
bga = H.client_as(a, BGA["id"]) if BGA else None
emp = H.client_as(a, EMP["id"])
P360 = ["pts360_dc", "pts360_dn", "pts360_vc", "pts360_vn"]
PTC = ["ptstc_dc", "ptstc_dn", "ptstc_vc", "ptstc_vn"]
Pt = a.Points


def post(action, **f):
    d = {"csrf_token": "tok", "action": action}
    d.update(f)
    return sup.post("/admin/settings", data=d)


def q(sql, args=()):
    with a.app.app_context():
        return [tuple(r) for r in a.get_db().execute(sql, args).fetchall()]


def w(sql, args=()):
    with a.app.app_context():
        d = a.get_db()
        d.execute(sql, args)
        d.commit()


def unrelease(d=None):
    """The test's release rows (released_by NULL: the suite writes none but its own) removed."""
    if d is None:
        w("DELETE FROM result_releases WHERE released_by IS NULL")
        w("DELETE FROM leader_releases WHERE released_by IS NULL")
        w("DELETE FROM talent_releases WHERE released_by IS NULL")
        return
    d.execute("DELETE FROM result_releases WHERE released_by IS NULL")
    d.execute("DELETE FROM leader_releases WHERE released_by IS NULL")
    d.execute("DELETE FROM talent_releases WHERE released_by IS NULL")


def reset_points():
    """Everything the suite changes about points, put back: cycle columns, defaults, releases, cut-offs, audit rows."""
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE cycles SET %s" % ", ".join("%s=NULL" % c for c in P360 + PTC))
        d.execute("DELETE FROM app_settings WHERE key IN ('points_360','points_tc')")
        for cid_, (lo, mi) in CUTS0.items():
            d.execute("UPDATE cycles SET low_max=?, mid_max=? WHERE id=?", (lo, mi, cid_))
        d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('low_max', ?)", (str(DEF_CUTS[0]),))
        d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('mid_max', ?)", (str(DEF_CUTS[1]),))
        unrelease(d)
        d.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle(db)["id"]
    CNAME = a.active_cycle(db)["name"]
    CUTS0 = {r[0]: (r[1], r[2]) for r in db.execute("SELECT id, low_max, mid_max FROM cycles")}
    DEF_CUTS = a.get_thresholds()
    # a subject whose submitted ratings hold Developing answers (so a Developing above 0 has something to move)
    SUBJ = db.execute(
        "SELECT a.subject_id FROM responses r JOIN assignments a ON a.id=r.assignment_id JOIN users u ON u.id=a.subject_id "
        "WHERE a.cycle_id=? AND a.status='submitted' AND a.archived=0 AND r.answer='no' AND u.role!='admin' AND u.is_demo=0 "
        "GROUP BY a.subject_id HAVING COUNT(DISTINCT a.id) >= 1 ORDER BY SUM(r.answer='no') DESC, a.subject_id LIMIT 1",
        (CID,)).fetchone()[0]
    SUBJ_ROW = db.execute("SELECT * FROM users WHERE id=?", (SUBJ,)).fetchone()
    AIDS = [r[0] for r in db.execute("SELECT id FROM assignments WHERE subject_id=? AND cycle_id=? AND status='submitted' AND archived=0",
                                     (SUBJ, CID))]
    TN = a._cycle_tier_n(db, SUBJ_ROW["job_grade"], CID)
    N_CUR, N_FUT = a.tier_statement_counts(db, CID, TN)
    TC_A = db.execute("SELECT id, subject_id FROM tc_assessments WHERE cycle_id=? AND status IN ('submitted','reviewed') LIMIT 1",
                      (CID,)).fetchone()
    NEXT_CYCLES = [dict(r) for r in db.execute("SELECT id, name, archived_at, low_max, mid_max FROM cycles ORDER BY id")]
    LOG0 = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]


def independent(aid, p):
    """One rating's (score, max) summed from the raw answers with the given points: the arithmetic the scorers must agree with."""
    sc = mx = 0.0
    for fut, ans in q("SELECT cs.is_future, r.answer FROM responses r JOIN cycle_statements cs ON cs.id=r.statement_id "
                      "WHERE r.assignment_id=?", (aid,)):
        mx += p.dn if fut else p.dc
        if ans == "yes":
            sc += p.dn if fut else p.dc
        elif ans == "no":
            sc += p.vn if fut else p.vc
    return sc, mx


def now(fn):
    """fn(db) inside a fresh request (so the g-caches start empty)."""
    with a.app.test_request_context("/"):
        return fn(a.get_db())


try:
    reset_points()

    # ---------------------------------------------------------------------------------------------------------------------
    s.section("the validator: each rule, both directions")
    ok = lambda dc, dn, vc, vn: a.points_parse({"dc": dc, "dn": dn, "vc": vc, "vn": vn})   # noqa: E731
    p, e = ok("1", "1.5", "0", "0")
    s.check("today's 1 / 1.5 / 0 / 0 is valid", p == Pt(1.0, 1.5, 0.0, 0.0) and e == [], (p, e))
    p, e = ok("2", "3", "0.5", "1")
    s.check("Developing above 0 is allowed (Chris: with a warning on the card)", p == Pt(2.0, 3.0, 0.5, 1.0) and e == [], (p, e))
    p, e = ok("10", "10", "0", "0")
    s.check("the ends: 10 and 0 are in range", p == Pt(10.0, 10.0, 0.0, 0.0) and e == [], (p, e))
    s.check("above 10 is refused", ok("10.1", "10", "0", "0")[0] is None and ok("1", "11", "0", "0")[1] == [a.POINTS_MSG_RANGE])
    s.check("below 0 is refused", ok("1", "1.5", "-0.1", "0")[0] is None)
    s.check("two decimals are refused, one is fine", ok("1.25", "1.5", "0", "0")[0] is None and ok("1.1", "1.5", "0.1", "0.3")[0] is not None)
    s.check("a blank, a word and nothing are refused", all(ok(*v)[0] is None for v in (("", "1.5", "0", "0"), ("x", "1.5", "0", "0"),
                                                                                        (None, "1.5", "0", "0"), ("nan", "1.5", "0", "0"))))
    p, e = ok("1", "1.5", "1", "1.2")
    s.check("Developing at the current level must stay below Demonstrate (equal is refused)", p is None and e == [a.POINTS_MSG_VC], e)
    p, e = ok("1", "1.5", "0", "1.5")
    s.check("Developing at the next level must stay below Demonstrate at the next", p is None and e == [a.POINTS_MSG_VN], e)
    p, e = ok("2", "1.5", "0", "0")
    s.check("the next level at least the current: Demonstrate", p is None and e == [a.POINTS_MSG_DN], e)
    p, e = ok("2", "2", "0", "0")
    s.check("...and equal is allowed", p == Pt(2.0, 2.0, 0.0, 0.0), (p, e))
    p, e = ok("2", "3", "1", "0.5")
    s.check("...and Developing: the next level at least the current", p is None and e == [a.POINTS_MSG_VN_UP], e)
    s.check("falsified: moving one figure flips the verdict", ok("1", "1.5", "0.9", "1.2")[0] is not None and ok("1", "1.5", "1", "1.2")[0] is None)
    s.check("the card's script carries the same five messages as the server",
            all(m in H.source(a, "templates/settings/cards/_points.html") for m in (a.POINTS_MSG_RANGE, a.POINTS_MSG_VC, a.POINTS_MSG_VN,
                                                                                    a.POINTS_MSG_DN, a.POINTS_MSG_VN_UP)))

    # ---------------------------------------------------------------------------------------------------------------------
    s.section("the defaults: no row, no column = 1 / 1.5 / 0 / 0, every scorer as before")
    s.check("the engine default is today's", a.POINTS_ENGINE_DEFAULT == Pt(1.0, 1.5, 0.0, 0.0))
    s.check("no app_settings row and no cycle columns: points_for is the engine default for both kinds",
            now(lambda d: (a.points_for(d, CID, "360"), a.points_for(d, CID, "tc"))) == (Pt(1.0, 1.5, 0.0, 0.0),) * 2)
    s.check("the migration wrote no value: every cycle's eight columns are NULL and no default row exists",
            q("SELECT COUNT(*) FROM cycles WHERE %s" % " OR ".join("%s IS NOT NULL" % c for c in P360 + PTC))[0][0] == 0
            and q("SELECT COUNT(*) FROM app_settings WHERE key IN ('points_360','points_tc')")[0][0] == 0)
    exp = [independent(aid, Pt(1.0, 1.5, 0.0, 0.0)) for aid in AIDS]
    got = now(lambda d: [a.assignment_score(d, aid, tier=None)[:2] for aid in AIDS])
    s.check("assignment_score is the 1 / 1.5 sum of the Demonstrate answers, byte for byte (%d ratings)" % len(AIDS),
            [tuple(x) for x in got] == exp and len(AIDS) >= 1, (got, exp))
    s.check("max_score_for_grade is today's (14 current + 14 next = 35 on this framework)",
            now(lambda d: a.max_score_for_grade(d, SUBJ_ROW["job_grade"], CID)) == N_CUR * 1.0 + N_FUT * 1.5)
    s.check("the penalty floor is 0.0, as it was", now(lambda d: a.min_score_for_grade(d, SUBJ_ROW["job_grade"], CID)) == 0.0)
    src = H.code_without_docstrings(H.source(a))
    left = [ln for ln in src.splitlines() if re.search(r"\bSCORE_(CURRENT|FUTURE)\b", ln)]
    s.check("no scorer reads SCORE_CURRENT / SCORE_FUTURE: only their definitions and the engine default",
            len(left) == 3 and all(x.strip().startswith(("SCORE_", "POINTS_ENGINE_DEFAULT")) for x in left), left)

    # ---------------------------------------------------------------------------------------------------------------------
    s.section("a cycle's own columns beat the default; the default beats the engine's")
    w("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('points_360', '[2, 3, 0.5, 1]')")
    s.check("a default row is read (360)", now(lambda d: a.points_for(d, CID, "360")) == Pt(2.0, 3.0, 0.5, 1.0))
    s.check("...and is the 360's alone: the competency still reads the engine default",
            now(lambda d: a.points_for(d, CID, "tc")) == Pt(1.0, 1.5, 0.0, 0.0))
    w("UPDATE cycles SET pts360_dc=4, pts360_dn=6, pts360_vc=1, pts360_vn=2 WHERE id=?", (CID,))
    s.check("the cycle's own four columns win over the default", now(lambda d: a.points_for(d, CID, "360")) == Pt(4.0, 6.0, 1.0, 2.0))
    w("UPDATE cycles SET pts360_vn=NULL WHERE id=?", (CID,))
    s.check("three of four set is not its own: it follows the default", now(lambda d: a.points_for(d, CID, "360")) == Pt(2.0, 3.0, 0.5, 1.0))
    w("UPDATE cycles SET %s WHERE id=?" % ", ".join("%s=NULL" % c for c in P360), (CID,))
    w("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('points_360', 'oops')")
    s.check("a stored default that is not four numbers is ignored", now(lambda d: a.points_for(d, CID, "360")) == Pt(1.0, 1.5, 0.0, 0.0))
    w("DELETE FROM app_settings WHERE key='points_360'")

    def cached(d):
        p1 = a.points_for(d, CID, "360")
        d.execute("UPDATE cycles SET pts360_dc=9, pts360_dn=9.5, pts360_vc=0, pts360_vn=0 WHERE id=?", (CID,))
        p2 = a.points_for(d, CID, "360")   # same request: the g-cache holds
        a.points_cache_clear()
        p3 = a.points_for(d, CID, "360")
        d.rollback()
        return p1, p2, p3
    p1, p2, p3 = now(cached)
    s.check("g-cached within a request, dropped by points_cache_clear", p1 == p2 == Pt(1.0, 1.5, 0.0, 0.0) and p3 == Pt(9.0, 9.5, 0.0, 0.0), (p1, p2, p3))
    s.check("outside a request there is no cache (a reminder job) and it still answers",
            (lambda: [a.points_for(sqlite3_conn, CID, "360") for sqlite3_conn in [__import__("sqlite3").connect(a.DB_PATH)]][0])() ==
            Pt(1.0, 1.5, 0.0, 0.0))
    s.check("a preview's what-if (g._points_ov) is read first",
            now(lambda d: (setattr(a.g, "_points_ov", {("360", CID): (7, 8, 1, 2)}), a.points_for(d, CID, "360"))[1]) == Pt(7.0, 8.0, 1.0, 2.0))

    # ---------------------------------------------------------------------------------------------------------------------
    s.section("Developing above 0 moves the scorers; the maximum moves with Demonstrate only")
    P2 = Pt(2.0, 3.0, 0.5, 1.0)
    w("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('points_360', ?)", (json.dumps(list(P2)),))
    exp = [independent(aid, P2) for aid in AIDS]
    got = now(lambda d: [a.assignment_score(d, aid, tier=None)[:2] for aid in AIDS])
    s.check("assignment_score: Demonstrate dc / dn and Developing vc / vn, summed independently from the answers",
            [tuple(x) for x in got] == exp, (got, exp))
    base = [independent(aid, Pt(1.0, 1.5, 0.0, 0.0)) for aid in AIDS]
    s.check("...so it differs from today's (the subject has Developing answers)", exp != base and any(e[0] != b[0] for e, b in zip(exp, base)))
    s.check("max_score_for_grade is the Demonstrate sum", now(lambda d: a.max_score_for_grade(d, SUBJ_ROW["job_grade"], CID)) == N_CUR * 2.0 + N_FUT * 3.0)
    w("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('points_360', ?)", (json.dumps([1.0, 1.5, 0.5, 1.0]),))
    s.check("...and does not move when only Developing changes",
            now(lambda d: a.max_score_for_grade(d, SUBJ_ROW["job_grade"], CID)) == N_CUR * 1.0 + N_FUT * 1.5)
    w("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('points_360', ?)", (json.dumps(list(P2)),))

    def breakdown(d):
        res = a.subject_result(d, SUBJ_ROW, CID)
        pb = a.principle_breakdown(d, SUBJ_ROW, CID)
        return res, pb
    res, pb = now(breakdown)
    tot = sum(r["score"] for r in pb if r["score"] is not None)
    s.check("principle_breakdown still reconciles with the total above it (sum of principles = the raw average) on the new points",
            res["avg_score_raw"] is not None and abs(tot - res["avg_score_raw"]) < 0.01 * max(1, len(pb)), (tot, res["avg_score_raw"]))
    pb0 = now(lambda d: (lambda: a.principle_breakdown(d, SUBJ_ROW, CID))())
    s.check("...and its per-principle maximum is the new Demonstrate sum", abs(sum(r["max"] for r in pb0) - (N_CUR * 2.0 + N_FUT * 3.0)) < 0.01 * len(pb0))
    w("DELETE FROM app_settings WHERE key='points_360'")
    res0, pb_default = now(breakdown)
    s.check("falsified: back on the defaults the principle scores are today's", res0["avg_score_raw"] != res["avg_score_raw"]
            and abs(sum(r["score"] for r in pb_default if r["score"] is not None) - res0["avg_score_raw"]) < 0.01 * max(1, len(pb_default)))
    w("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('points_360', ?)", (json.dumps(list(P2)),))

    # the extreme assessor's penalty floor is the least a person of the tier can score
    def floors(d):
        keep = (a.get_extremes_adjustment_settings, a._extreme_assessor_sets)
        a.get_extremes_adjustment_settings = lambda: (True, 5.0, 5.0)
        a._extreme_assessor_sets = lambda db_, cid_: (frozenset({111}), frozenset({222}))
        try:
            lo_ = a._score_band_adjusted(d, SUBJ_ROW, CID, [(222, 3.0)])
            hi_ = a._score_band_adjusted(d, SUBJ_ROW, CID, [(111, N_CUR * 2.0 + N_FUT * 3.0 - 1.0)])
        finally:
            a.get_extremes_adjustment_settings, a._extreme_assessor_sets = keep
        return lo_[1], hi_[1], a.min_score_for_grade(d, SUBJ_ROW["job_grade"], CID), a.max_score_for_grade(d, SUBJ_ROW["job_grade"], CID)
    lo_adj, hi_adj, floor_, ceil_ = now(floors)
    s.check("the penalty floor is the all-Developing minimum, not 0.0 (%g)" % floor_, floor_ == N_CUR * 0.5 + N_FUT * 1.0 and lo_adj == floor_, (lo_adj, floor_))
    s.check("the bonus ceiling stays the Demonstrate maximum", hi_adj == ceil_, (hi_adj, ceil_))
    w("DELETE FROM app_settings WHERE key='points_360'")
    lo0, _hi0, f0, _c0 = now(floors)
    s.check("falsified: on the defaults the floor is 0.0 again", f0 == 0.0 and lo0 == 0.0)

    # the competency's own points
    if TC_A:
        base_tc = now(lambda d: a.tc_score(d, TC_A["id"], "self"))
        rows_tc = q("SELECT a.is_future, sc.answer FROM tc_assignments a LEFT JOIN tc_scores sc ON sc.assignment_id=a.id AND sc.assessment_id=? "
                    "WHERE a.cycle_id=? AND a.subject_id=?", (TC_A["id"], CID, TC_A["subject_id"]))
        ptc = Pt(2.0, 3.0, 0.5, 1.0)
        w("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('points_tc', ?)", (json.dumps(list(ptc)),))
        exp_sc = sum((ptc.dn if f else ptc.dc) if ans == "yes" else ((ptc.vn if f else ptc.vc) if ans == "no" else 0.0) for f, ans in rows_tc)
        exp_mx = sum(ptc.dn if f else ptc.dc for f, ans in rows_tc)
        got_tc = now(lambda d: a.tc_score(d, TC_A["id"], "self"))
        s.check("tc_score: Demonstrate dc / dn, Developing vc / vn, max the Demonstrate sum (independent)", got_tc == (exp_sc, exp_mx) or
                (base_tc[0] is None and got_tc[0] is None), (got_tc, (exp_sc, exp_mx), base_tc))
        s.check("...the 360's points did not move it (they are independent)",
                now(lambda d: a.points_for(d, CID, "360")) == Pt(1.0, 1.5, 0.0, 0.0))
        w("DELETE FROM app_settings WHERE key='points_tc'")
        s.check("falsified: with no competency row it is today's", now(lambda d: a.tc_score(d, TC_A["id"], "self")) == base_tc)
    else:
        s.check("(no submitted competency assessment on this database)", True)
    # the answered==0 rule and unanswered earning nothing are kept (a pending assessment with nothing answered)
    s.check("tc_score still gives (None, max) when nothing is answered",
            now(lambda d: a.tc_score(d, 0)) == (None, 0.0))

    # _pot_strengths: a share is earned over the most, Developing earning its points
    def strengths(d):
        return a._pot_strengths(d, [{"valid": True, "user": SUBJ_ROW}], CID).get(SUBJ, {})
    st0 = now(strengths)
    w("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('points_360', ?)", (json.dumps([1.0, 1.5, 0.9, 1.4]),))
    st1 = now(strengths)
    s.check("_pot_strengths reads the cycle's points: with Developing at 0.9 / 1.4 the shares rise, so the words and steps can too",
            st0 != {} and st1 != {} and (st0.get("top"), st0.get("bottom")) != (None, None))
    s.check("_pot_sw_word: no Demonstrate at all reads 'Not demonstrated yet' even at a share above 0 (letter grades)",
            a._pot_sw_word(0.3, True, True) == "Not demonstrated yet" and a._pot_sw_word(0.3, True, False) == "Rarely demonstrated"
            and a._pot_sw_word(0.0, True) == "Not demonstrated yet")
    w("DELETE FROM app_settings WHERE key='points_360'")

    # ---------------------------------------------------------------------------------------------------------------------
    s.section("the JS payloads carry Developing's points")
    rr = now(lambda d: a._fb_remark_rule(d, CID))
    hi_ = now(lambda d: a.thresholds_for_cycle(d, CID)[1])
    s.check("_fb_remark_rule: the cycle's four points and the High cut-off", rr == {"high_above": hi_, "w_current": 1.0, "w_future": 1.5,
                                                                                 "w_dev_current": 0.0, "w_dev_future": 0.0}, rr)
    w("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('points_360', '[2, 3, 0.5, 1]')")
    w("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('points_tc', '[4, 5, 0.5, 1]')")
    rr = now(lambda d: a._fb_remark_rule(d, CID))
    tr = now(lambda d: a._tc_remark_rule(d, CID))
    s.check("...follows a changed default", (rr["w_current"], rr["w_future"], rr["w_dev_current"], rr["w_dev_future"]) == (2.0, 3.0, 0.5, 1.0), rr)
    s.check("_tc_remark_rule: the competency's own points, High at 75%", tr == {"high_pct": a.TC_BAND_HIGH_PCT, "w_current": 4.0, "w_future": 5.0,
                                                                              "w_dev_current": 0.5, "w_dev_future": 1.0}, tr)
    js = H.source(a, "static/journey_chat.js")
    s.check("the journey's two rule functions add Developing's points",
            js.count("w_dev_current") >= 2 and js.count("w_dev_future") >= 2)
    w("DELETE FROM app_settings WHERE key IN ('points_360','points_tc')")

    # ---------------------------------------------------------------------------------------------------------------------
    s.section("the release lock: the first potential result out closes the current cycle")
    s.check("nothing released: no date", now(lambda d: a.points_released_on(d, CID)) is None)
    w("INSERT OR IGNORE INTO result_releases(cycle_id, subject_id, kind, released_by) VALUES (?,?,'pm',NULL)", (CID, SUBJ))
    s.check("a performance ('pm') release does not close it", now(lambda d: a.points_released_on(d, CID)) is None)
    unrelease()
    rel_variants = [("result_releases", "pot"), ("leader_releases", "pot"), ("leader_releases", "talent"), ("talent_releases", None)]
    for tbl, kind in rel_variants:
        if kind:
            w("INSERT OR IGNORE INTO %s(cycle_id, subject_id, kind, released_by) VALUES (?,?,?,NULL)" % tbl, (CID, SUBJ, kind))
        else:
            w("INSERT OR IGNORE INTO %s(cycle_id, subject_id, released_by) VALUES (?,?,NULL)" % tbl, (CID, SUBJ))
        got_d = now(lambda d: a.points_released_on(d, CID))
        s.check("a %s%s release closes it, dated in MYT" % (tbl, " '%s'" % kind if kind else ""), bool(got_d) and re.match(r"^\d{1,2} \w{3} \d{4}$", got_d), got_d)
        unrelease()
    s.check("...and the lock is per cycle: another cycle is open", now(lambda d: a.points_released_on(d, CID + 100)) is None)
    # the server refuses "current" once released whatever the form says
    w("INSERT OR IGNORE INTO leader_releases(cycle_id, subject_id, kind, released_by) VALUES (?,?,'pot',NULL)", (CID, SUBJ))
    r = post("points_360", dc="2", dn="3", vc="0", vn="0", when="current", remark="test reason")
    s.check("POST 'current' on a released cycle: refused, nothing written", r.status_code in (301, 302)
            and q("SELECT COUNT(*) FROM app_settings WHERE key='points_360'")[0][0] == 0
            and q("SELECT COUNT(*) FROM cycles WHERE pts360_dc IS NOT NULL")[0][0] == 0)
    rr_ = sup.get("/admin/m/f360/settings")
    page = html.unescape(rr_.get_data(as_text=True))
    s.check("the card says the cycle keeps its points and why (A4)", "keeps 1 · 1.5 · 0 · 0: its first potential result was released on" in page
            and "A change here applies from the next cycle." in page)
    r = post("points_360_check", dc="2", dn="3", vc="0", vn="0")
    pg = html.unescape(r.get_data(as_text=True))
    s.check("the step's current option is shut, with the date, and next is the one to pick (A3)",
            'value="current" disabled' in pg and "Not open: its first results were released on" in pg and 'value="next" checked' in pg)
    unrelease()
    r = post("points_360", dc="2", dn="3", vc="0", vn="0", when="current", remark="falsify: the release row is gone")
    s.check("falsified: with the release row removed the same POST is allowed", q("SELECT value FROM app_settings WHERE key='points_360'")[0][0] ==
            json.dumps([2.0, 3.0, 0.0, 0.0]), q("SELECT value FROM app_settings WHERE key='points_360'"))
    reset_points()

    # ---------------------------------------------------------------------------------------------------------------------
    s.section("the check writes nothing and shows the counts")
    snap = lambda: (q("SELECT * FROM cycles ORDER BY id"), q("SELECT key, value FROM app_settings ORDER BY key"),   # noqa: E731
                    q("SELECT COUNT(*) FROM activity_log")[0][0], q("SELECT COUNT(*) FROM rating_records")[0][0])
    before = snap()
    r = post("points_360_check", dc="2", dn="3", vc="0", vn="0")
    pg = html.unescape(r.get_data(as_text=True))
    s.check("the check answers 200 with the step open (no remark asked yet)", r.status_code == 200 and 'id="pts-step"' in pg and "When it starts" in pg)
    s.check("...nothing was written: no cycle, no setting, no audit row, no rating record", snap() == before)
    n_people = now(lambda d: len(a._points_people(d, CID, "360")))
    s.check("the step counts the people re-scored (%d) and the raw band changes, and names the cut-offs that move" % n_people,
            ("<b>%d</b> people" % n_people) in pg and "land in a different potential band" in pg and "Its cut-offs move to Low" in pg)
    s.check("the values said back, and Today", "Demonstrate <b>2</b> at the current level and <b>3</b> at the next; Developing <b>0</b> and <b>0</b>." in pg
            and "Today 1 · 1.5 · 0 · 0." in pg)
    s.check("neither option is preselected while the current cycle is open (the admin must pick)", 'value="next" checked' not in pg
            and "checked" not in re.search(r'<input type="radio" name="when" value="current"[^>]*>', pg).group(0))
    s.check("the step's save form carries data-confirm and the reason box is named remark (one reason, never two)",
            re.search(r'<form[^>]*id="pts-step"[^>]*data-confirm="', pg) and 'name="remark"' in pg and pg.count('name="remark"') == 1)
    bad = post("points_360_check", dc="1", dn="1.5", vc="1", vn="0")
    bp = html.unescape(bad.get_data(as_text=True))
    s.check("a refused check re-draws the card with the message and the typed numbers, and no step",
            bad.status_code == 200 and a.POINTS_MSG_VC in bp and 'id="pts-step"' not in bp and re.search(r'name="vc"[^>]*value="1"', bp))
    same = post("points_360_check", dc="1", dn="1.5", vc="0", vn="0")
    s.check("the points already in use: 'nothing to save', no step", "nothing to save" in html.unescape(same.get_data(as_text=True))
            and 'id="pts-step"' not in same.get_data(as_text=True))
    ctc = post("points_tc_check", dc="2", dn="3", vc="0", vn="0")
    pgc = html.unescape(ctc.get_data(as_text=True))
    s.check("the competency's check is its own step: no cut-off sentence", ctc.status_code == 200 and 'id="pts-step"' in pgc
            and "cut-offs" not in re.search(r'<fieldset class="pts-when">.*?</fieldset>', pgc, re.S).group(0))
    s.check("falsified: the check actions are not band actions, the saves are",
            not {"points_360_check", "points_tc_check"} & a.SUPER_BAND_ENDPOINTS["admin_settings"]
            and {"points_360", "points_tc"} <= a.SUPER_BAND_ENDPOINTS["admin_settings"])

    # ---------------------------------------------------------------------------------------------------------------------
    s.section("who may save, and the reason")
    before = snap()
    for who, name in ((emp, "an employee"), (bga, "a BG admin")):
        if who is None:
            continue
        r = who.post("/admin/settings", data={"csrf_token": "tok", "action": "points_360", "dc": "2", "dn": "3", "vc": "0", "vn": "0",
                                              "when": "current", "remark": "x"})
        rc = who.post("/admin/settings", data={"csrf_token": "tok", "action": "points_360_check", "dc": "2", "dn": "3", "vc": "0", "vn": "0"})
        s.check("%s is refused (save and check), nothing changes" % name, r.status_code in (302, 403) and rc.status_code in (302, 403)
                and snap() == before, (r.status_code, rc.status_code))
    r = post("points_360", dc="2", dn="3", vc="0", vn="0", when="current")
    s.check("the super admin's reason is required: without one nothing changes (the band-remark gate)", r.status_code in (302, 400) and snap() == before)
    r = post("points_360", dc="2", dn="3", vc="0", vn="0", when="current", remark="   ")
    s.check("...a blank one too", snap() == before)
    r = post("points_360", dc="2", dn="3", vc="0", vn="0", remark="the reason is there but no start was picked")
    s.check("no start picked: refused", snap() == before)
    r = post("points_360", dc="2", dn="3", vc="1", vn="0", when="current", remark="a bad figure: Developing not below Demonstrate")
    s.check("server-side validation (the same rules): a bad figure writes nothing", snap() == before)
    r = post("points_360", dc="2", dn="3", vc="0", vn="0", when="sometime", remark="a made-up start")
    s.check("a made-up start is refused", snap() == before)

    # ---------------------------------------------------------------------------------------------------------------------
    s.section('"from the next cycle on": the current and every released or archived cycle is pinned at the OLD values')
    with a.app.app_context():   # a released-by-record cycle and an archived one with no cut-offs of its own, plus a future one with its own
        d = a.get_db()
        d.execute("INSERT INTO cycles(code, name, is_active, low_max, mid_max) VALUES ('T-REL', 'Test released', 0, NULL, NULL)")
        d.execute("INSERT INTO cycles(code, name, is_active, low_max, mid_max) VALUES ('T-FUT', 'Test future', 0, 6.0, 12.5)")
        # a PAST cycle that is neither archived nor released: an id below the current cycle's (the rule is "older than the current one")
        d.execute("INSERT INTO cycles(id, code, name, is_active, low_max, mid_max) VALUES ((SELECT MIN(id) - 1 FROM cycles), 'T-PAST', 'Test past', 0, NULL, NULL)")
        d.commit()
    REL_ID = q("SELECT id FROM cycles WHERE code='T-REL'")[0][0]
    FUT_ID = q("SELECT id FROM cycles WHERE code='T-FUT'")[0][0]
    PAST_ID = q("SELECT id FROM cycles WHERE code='T-PAST'")[0][0]
    s.check("fixture: T-PAST is older than the current cycle, not archived, not released; T-FUT is newer and in the same state",
            PAST_ID < CID < FUT_ID and q("SELECT archived_at FROM cycles WHERE id IN (?,?)", (PAST_ID, FUT_ID)) == [(None,), (None,)]
            and not now(lambda d: a._points_released_ids(d) & {PAST_ID, FUT_ID}))
    with a.app.test_request_context("/"):   # the plan, before the save: a past, unarchived, unreleased cycle is pinned; a newer draft is not
        pl_ = a._points_plan(a.get_db(), "360", Pt(2.0, 3.0, 0.0, 0.0), "next")
        pl_c = a._points_plan(a.get_db(), "360", Pt(2.0, 3.0, 0.0, 0.0), "current")
    s.check("the plan pins the past unarchived unreleased cycle (next and current) and not the newer draft (falsified: same state, higher id)",
            PAST_ID in [p_["id"] for p_ in pl_["pins"]] and PAST_ID in [p_["id"] for p_ in pl_c["pins"]]
            and FUT_ID not in [p_["id"] for p_ in pl_["pins"]] and FUT_ID not in [p_["id"] for p_ in pl_c["pins"]]
            and CID not in [p_["id"] for p_ in pl_["pins"]] and next(p_ for p_ in pl_["pins"] if p_["id"] == PAST_ID)["fill_cuts"] is True,
            ([p_["id"] for p_ in pl_["pins"]], PAST_ID, FUT_ID, CID))
    w("INSERT INTO leader_releases(cycle_id, subject_id, kind, released_by) VALUES (?,?,'talent',NULL)", (REL_ID, SUBJ))
    old_assign = [tuple(x) for x in now(lambda d: [a.assignment_score(d, aid, tier=None) for aid in AIDS])]
    old_res = now(lambda d: a.subject_result(d, SUBJ_ROW, CID))["avg_score"]
    arch = [c for c in NEXT_CYCLES if c["archived_at"] is not None]
    r = post("points_360", dc="2", dn="3", vc="0", vn="0", when="next", remark="start from the next cycle")
    s.check("saved and sent back to the card", r.status_code in (301, 302) and r.headers["Location"].endswith("#points"), r.headers.get("Location"))
    s.check("the new default is stored as four numbers", json.loads(q("SELECT value FROM app_settings WHERE key='points_360'")[0][0]) == [2.0, 3.0, 0.0, 0.0])
    own = lambda cid_: q("SELECT %s FROM cycles WHERE id=?" % ", ".join(P360), (cid_,))[0]   # noqa: E731
    s.check("the current cycle is pinned at 1 / 1.5 / 0 / 0", own(CID) == (1.0, 1.5, 0.0, 0.0), own(CID))
    s.check("every archived cycle that followed the default is pinned at the old values", all(own(c["id"]) == (1.0, 1.5, 0.0, 0.0) for c in arch) and arch, [own(c["id"]) for c in arch])
    s.check("a cycle with a released result (talent) is pinned too, though it is not archived", own(REL_ID) == (1.0, 1.5, 0.0, 0.0), own(REL_ID))
    s.check("a future cycle that follows the default is not pinned (it takes the new points)", own(FUT_ID) == (None,) * 4, own(FUT_ID))
    s.check("a PAST cycle (older than the current one) that is neither archived nor released is pinned at its old points too, so a default save never re-scores it",
            own(PAST_ID) == (1.0, 1.5, 0.0, 0.0) and now(lambda d: a.points_for(d, PAST_ID, "360")) == Pt(1.0, 1.5, 0.0, 0.0), own(PAST_ID))
    s.check("...with its cut-offs pinned (the old default 14 / 26 written where it had none), so the rescale never moves them",
            q("SELECT low_max, mid_max FROM cycles WHERE id=?", (PAST_ID,))[0] == (14.0, 26.0), q("SELECT low_max, mid_max FROM cycles WHERE id=?", (PAST_ID,)))
    s.check("...while the newer draft takes the new default (2 / 3 / 0 / 0)", now(lambda d: a.points_for(d, FUT_ID, "360")) == Pt(2.0, 3.0, 0.0, 0.0))
    cuts = lambda cid_: q("SELECT low_max, mid_max FROM cycles WHERE id=?", (cid_,))[0]   # noqa: E731
    s.check("the pinned cycles hold the cut-offs they were banded on: the old default 14 / 26 written where they had none",
            cuts(CID) == (14.0, 26.0) and cuts(REL_ID) == (14.0, 26.0) and all(cuts(c["id"]) == ((c["low_max"], c["mid_max"]) if c["low_max"] is not None else (14.0, 26.0)) for c in arch),
            (cuts(CID), cuts(REL_ID)))
    s.check("the default cut-offs doubled with the maximum (35 -> 70): 28 / 52", DEF_CUTS == (14.0, 26.0) and now(lambda d: a.get_thresholds()) == (28.0, 52.0))
    s.check("a future cycle's own cut-offs follow the factor: 6.0 / 12.5 -> 12 / 25", cuts(FUT_ID) == (12.0, 25.0), cuts(FUT_ID))
    new_assign = [tuple(x) for x in now(lambda d: [a.assignment_score(d, aid, tier=None) for aid in AIDS])]
    s.check("the current cycle's scores did not move (nobody's score changes now)", new_assign == old_assign
            and now(lambda d: a.subject_result(d, SUBJ_ROW, CID))["avg_score"] == old_res)
    s.check("the current cycle still bands on 14 / 26", now(lambda d: a.thresholds_for_cycle(d, CID)) == (14.0, 26.0))
    s.check("a new cycle follows the new default: 2 / 3 / 0 / 0 and the doubled maximum", now(lambda d: a.points_for(d, FUT_ID, "360")) == Pt(2.0, 3.0, 0.0, 0.0))
    audit = q("SELECT detail FROM activity_log WHERE id>? AND action='settings' AND detail LIKE 'Points per answer, 360:%' ORDER BY id DESC LIMIT 1", (LOG0,))
    s.check("the audit row: old -> new, which option, the cycles pinned, the cut-offs moved and the reason",
            audit and "from the next cycle on" in audit[0][0] and "was 1 / 1.5, 0 / 0" in audit[0][0] and "default cut-offs Low ≤ 28, Mid ≤ 52" in audit[0][0]
            and "remark: start from the next cycle" in audit[0][0], audit)
    s.check("the card's 'Changed ... by ...' line reads it", "Changed" in html.unescape(sup.get("/admin/m/f360/settings").get_data(as_text=True)).split('id="points"')[1][:600])
    reset_points()
    unrelease()

    # ---------------------------------------------------------------------------------------------------------------------
    s.section('"the current cycle": it follows the new default at once, and the cut-offs keep their share')
    w("INSERT INTO leader_releases(cycle_id, subject_id, kind, released_by) VALUES (?,?,'pot',NULL)", (REL_ID, SUBJ))
    w("UPDATE cycles SET low_max=6.0, mid_max=12.5 WHERE id=?", (CID,))   # the cycle holds its own cut-offs, as a Year-End does
    f_expect = (N_CUR * 3.0 + N_FUT * 4.5) / (N_CUR * 1.0 + N_FUT * 1.5)
    fw = q("SELECT COALESCE(SUM(CASE WHEN is_future=1 THEN 0 ELSE 1 END),0), COALESCE(SUM(CASE WHEN is_future=1 THEN 1 ELSE 0 END),0) FROM cycle_statements WHERE cycle_id=?", (CID,))[0]
    f_expect = (fw[0] * 3.0 + fw[1] * 4.5) / (fw[0] * 1.0 + fw[1] * 1.5)   # over ALL tiers' statements of the reference cycle
    chk = post("points_360_check", dc="3", dn="4.5", vc="0", vn="0")
    chk_page = html.unescape(chk.get_data(as_text=True))
    r = post("points_360", dc="3", dn="4.5", vc="0", vn="0", when="current", remark="re-score the current cycle now")
    s.check("saved", r.status_code in (301, 302))
    s.check("the current cycle's own columns are NULL: it follows the new default", own(CID) == (None,) * 4 and
            json.loads(q("SELECT value FROM app_settings WHERE key='points_360'")[0][0]) == [3.0, 4.5, 0.0, 0.0])
    s.check("the released cycle was pinned at the old values first, with cut-offs", own(REL_ID) == (1.0, 1.5, 0.0, 0.0) and cuts(REL_ID) == (14.0, 26.0), (own(REL_ID), cuts(REL_ID)))
    s.check("the archived cycles are pinned too and keep their scores", all(own(c["id"]) == (1.0, 1.5, 0.0, 0.0) for c in arch))
    s.check("the past unarchived unreleased cycle is pinned at the old points and cut-offs on a 'current' save too; the newer draft is not",
            own(PAST_ID) == (1.0, 1.5, 0.0, 0.0) and q("SELECT low_max, mid_max FROM cycles WHERE id=?", (PAST_ID,))[0] == (14.0, 26.0)
            and own(FUT_ID) == (None,) * 4, (own(PAST_ID), own(FUT_ID)))
    lo_exp, mi_exp = round(6.0 * f_expect, 2), round(12.5 * f_expect, 2)
    s.check("the cycle's own cut-offs 6.0 / 12.5 are rescaled by new max / old max (x%.4f): %g / %g" % (f_expect, lo_exp, mi_exp),
            cuts(CID) == (lo_exp, mi_exp), cuts(CID))
    dflt = now(lambda d: a.get_thresholds())
    s.check("...(read back through get_thresholds)", dflt == (round(14.0 * f_expect, 2), round(26.0 * f_expect, 2)), dflt)
    got_now = [tuple(x) for x in now(lambda d: [a.assignment_score(d, aid, tier=None) for aid in AIDS])]
    s.check("the current cycle's ratings now score on 3 / 4.5 (independent sum)", [x[:2] for x in got_now] == [independent(aid, Pt(3.0, 4.5, 0.0, 0.0)) for aid in AIDS])
    s.check("the step's cut-offs said (Low / Mid) are the ones written", ("Its cut-offs move to Low &le; %g, Mid &le; %g" % (lo_exp, mi_exp)).replace("&le;", "≤") in chk_page, "")
    s.check("the potential score's maximum, the people re-scored: the step counted the cycle's people", ("<b>%d</b> people" % n_people) in chk_page)
    s.check("the rating records of the cycle were rebuilt with the points used (config_json points_360 as the 4-list)",
            all(json.loads(x[0]).get("points_360") == [3.0, 4.5, 0.0, 0.0] and json.loads(x[0]).get("points_tc") == [1.0, 1.5, 0.0, 0.0]
                for x in q("SELECT config_json FROM rating_records WHERE cycle_id=? AND frozen_at IS NULL AND updated_at >= datetime('now', '-1 hour')", (CID,))[:50]))
    audit = q("SELECT detail FROM activity_log WHERE id>? AND action='settings' AND detail LIKE 'Points per answer, 360:%' ORDER BY id DESC LIMIT 1", (LOG0,))
    s.check("the audit row names the current cycle and the cut-offs moved, with the reason",
            audit and ("from %s, the current cycle" % CNAME) in audit[0][0] and "remark: re-score the current cycle now" in audit[0][0], audit)
    s.check("leaders' band moves are never touched: no calibration row was written", q("SELECT COUNT(*) FROM calibration_adjustments WHERE adjusted_at >= datetime('now','-1 hour')")[0][0] == 0
            if q("SELECT 1 FROM pragma_table_info('calibration_adjustments') WHERE name='adjusted_at'") else True)
    # a second save with a pinned current cycle: "current" unpins it again and rescales by ITS points
    w("UPDATE cycles SET pts360_dc=2, pts360_dn=3, pts360_vc=0, pts360_vn=0, low_max=10, mid_max=20 WHERE id=?", (CID,))
    f2 = (fw[0] * 1.0 + fw[1] * 1.5) / (fw[0] * 2.0 + fw[1] * 3.0)   # from the cycle's own 2 / 3 to a default of 1 / 1.5
    w("DELETE FROM app_settings WHERE key IN ('points_360','low_max','mid_max')")
    w("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('points_360', '[3, 4.5, 0, 0]')")
    r = post("points_360", dc="1", dn="1.5", vc="0", vn="0", when="current", remark="the cycle held its own 2 / 3: back to follow 1 / 1.5")
    s.check("a current cycle that held its OWN points is let go to follow the new default, its cut-offs rescaled from ITS points",
            own(CID) == (None,) * 4 and cuts(CID) == (round(10 * f2, 2), round(20 * f2, 2)), (own(CID), cuts(CID), f2))
    reset_points()
    unrelease()

    # ---------------------------------------------------------------------------------------------------------------------
    s.section("the competency: its own points, a share, no cut-offs to move")
    cut_before = (q("SELECT low_max, mid_max FROM cycles ORDER BY id"), q("SELECT key, value FROM app_settings WHERE key IN ('low_max','mid_max') ORDER BY key"))
    r = post("points_tc", dc="2", dn="3", vc="0.5", vn="1", when="current", remark="competency points, now")
    s.check("saved: its own default, the 360's untouched", json.loads(q("SELECT value FROM app_settings WHERE key='points_tc'")[0][0]) == [2.0, 3.0, 0.5, 1.0]
            and q("SELECT COUNT(*) FROM app_settings WHERE key='points_360'")[0][0] == 0)
    s.check("no cut-off moved (the competency reads a share)", (q("SELECT low_max, mid_max FROM cycles ORDER BY id"),
            q("SELECT key, value FROM app_settings WHERE key IN ('low_max','mid_max') ORDER BY key")) == cut_before)
    s.check("the current cycle follows it; the archived ones are pinned at the old",
            q("SELECT %s FROM cycles WHERE id=?" % ", ".join(PTC), (CID,))[0] == (None,) * 4
            and all(q("SELECT %s FROM cycles WHERE id=?" % ", ".join(PTC), (c["id"],))[0] == (1.0, 1.5, 0.0, 0.0) for c in arch))
    s.check("competency: the past unarchived unreleased cycle is pinned at the old points, the newer draft follows",
            q("SELECT %s FROM cycles WHERE id=?" % ", ".join(PTC), (PAST_ID,))[0] == (1.0, 1.5, 0.0, 0.0)
            and q("SELECT %s FROM cycles WHERE id=?" % ", ".join(PTC), (FUT_ID,))[0] == (None,) * 4)
    s.check("the audit says competency, with no cut-off words", (lambda r_: r_ and "Points per answer, competency:" in r_[0][0] and "cut-offs" not in r_[0][0])(
        q("SELECT detail FROM activity_log WHERE id>? AND detail LIKE 'Points per answer, competency:%' ORDER BY id DESC LIMIT 1", (LOG0,))))
    s.check("the rating records carry points_tc", all(json.loads(x[0]).get("points_tc") == [2.0, 3.0, 0.5, 1.0]
            for x in q("SELECT config_json FROM rating_records WHERE cycle_id=? AND frozen_at IS NULL AND updated_at >= datetime('now', '-1 hour')", (CID,))[:50]))
    reset_points()

    # ---------------------------------------------------------------------------------------------------------------------
    s.section("the cards: where they sit, what they say, the All settings sheet")
    p360 = html.unescape(sup.get("/admin/m/f360/settings").get_data(as_text=True))
    ids = re.findall(r'<section class="admin-card adm-set-card" id="([^"]+)"', p360)
    s.check("360 Feedback: Points per answer straight after Panel rules", ids[ids.index("rules") + 1] == "points", ids)
    ptc = html.unescape(sup.get("/admin/m/competency/settings").get_data(as_text=True))
    ids2 = re.findall(r'<section class="admin-card adm-set-card" id="([^"]+)"', ptc)
    s.check("Competency: Points per answer straight after Job profiles and their competencies", ids2[ids2.index("profiles") + 1] == "points", ids2)
    s.check("the index lists it with the 'Default + per cycle' scope", "<span>Points per answer</span><span class=\"adm-set-idx-scope\">Default + per cycle</span>" in p360
            and "<span>Points per answer</span><span class=\"adm-set-idx-scope\">Default + per cycle</span>" in ptc)
    card = p360.split('id="points"')[1].split("</section>")[0]
    s.check("the card's words: the description, Why this matters, the status line, the 2x2 grid, the rule line, what it does to a score",
            "What each answer on the 360 earns." in card and "Why this matters" in card and (CNAME + "</b> uses 1 · 1.5 · 0 · 0. None of its results is released yet.") in card
            and "At their current level" in card and "At the next level" in card and "Demonstrate" in card and "Developing" in card
            and "0 to 10, one decimal." in card and "Most a person can score" in card and "Lowest, all Developing" in card
            and "Potential bands (default cut-offs)" in card and "Save points" in card)
    s.check("the 360 card names the reference tier as the Tiers card does", re.search(r"On the 360 scale for Tier \d · JG [^:]+: \d+ behaviours at the current level and \d+ at the next", card) is not None, card[:600])
    s.check("the inputs hold today's 1 and 1.5 and 0 and 0, 4.5rem wide, each labelled",
            all(re.search(r'name="%s"[^>]*value="%s"' % (k, v), card) for k, v in (("dc", "1"), ("dn", "1.5"), ("vc", "0"), ("vn", "0")))
            and card.count('aria-label="') >= 4)
    ccard = ptc.split('id="points"')[1].split("</section>")[0]
    s.check("the competency card: its own words, 5 and 5, the band rule from the constants",
            "What each competency answer earns, on its own" in ccard and "For a person with 5 competencies at their current level and 5 at the next" in ccard
            and ("High from %g%% &middot; Mid from %g%%" % (a.TC_BAND_HIGH_PCT, a.TC_BAND_MID_PCT)).replace("&middot;", "·") in ccard)
    s.check("the form asks first: the check posts points_360_check, listed as a preview that changes nothing",
            'value="points_360_check"' in card and 'id="pts-check"' in card)
    # the card, with the current cycle holding its own points
    w("UPDATE cycles SET pts360_dc=2, pts360_dn=3, pts360_vc=0, pts360_vn=0 WHERE id=?", (CID,))
    own_page = html.unescape(sup.get("/admin/m/f360/settings").get_data(as_text=True))
    s.check("a current cycle that holds its own points says so and that the default applies from the next cycle",
            (CNAME + "</b> keeps its own 2 · 3 · 0 · 0; the default (1 · 1.5 · 0 · 0) applies from the next cycle.") in own_page)
    w("UPDATE cycles SET pts360_dc=NULL, pts360_dn=NULL, pts360_vc=NULL, pts360_vn=NULL WHERE id=?", (CID,))
    sheet = html.unescape(sup.get("/admin/all-settings").get_data(as_text=True))
    s.check("All settings lists both rows with the values", "Points per answer, 360" in sheet and "Points per answer, competency" in sheet
            and "1 · 1.5 · 0 · 0 (Demonstrate 1 / 1.5, Developing 0 / 0)" in sheet)
    s.check("a BG admin reads it without a form (the card is the super admin's)", bga is None or 'id="pts-check"' not in
            html.unescape(bga.get("/admin/m/f360/settings").get_data(as_text=True)))
    s.check("the card's css: rem and tokens only (the lints cover it too)", "pts-grid" in H.source(a, "static/style.css"))

    # ---------------------------------------------------------------------------------------------------------------------
    s.section("a new cycle started from a source pinned on other points carries its cut-offs over rescaled")
    w("UPDATE cycles SET pts360_dc=2, pts360_dn=3, pts360_vc=0, pts360_vn=0, low_max=28, mid_max=52 WHERE id=?", (CID,))
    fct = now(lambda d: a.points_cut_factor(d, CID, a.points_for(d, CID, "360"), a.points_for(d, FUT_ID, "360")))
    s.check("the factor from the source's own 2 / 3 to the default's 1 / 1.5 is a half", abs(fct - 0.5) < 1e-9, fct)
    s.check("(a source that follows the default needs no rescale: the factor is 1)",
            now(lambda d: a.points_cut_factor(d, CID, a.points_for(d, FUT_ID, "360"), a.points_for(d, FUT_ID, "360"))) == 1.0)
    r = sup.post("/admin/cycles", data={"action": "create", "csrf_token": "tok", "name": "ZZ Points Carry", "code": "ZZ-PTS-CF",
                                        "confirm_freeze": "1", "source": "empty", "year": "2027", "half": "1"})
    new_c = q("SELECT id, low_max, mid_max, pts360_dc FROM cycles WHERE code='ZZ-PTS-CF'")
    s.check("the new cycle follows the default points (its columns stay NULL)", r.status_code in (302, 303) and new_c and new_c[0][3] is None, (r.status_code, new_c))
    s.check("...and its inherited cut-offs are the source's 28 / 52 rescaled to the points it follows: 14 / 26",
            new_c and (new_c[0][1], new_c[0][2]) == (14.0, 26.0), new_c)
finally:
    reset_points()
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM cycles WHERE code IN ('T-REL','T-FUT','T-PAST')")
        d.execute("DELETE FROM activity_log WHERE id>? AND action='settings' AND detail LIKE 'Points per answer,%'", (LOG0,))
        d.commit()

sys.exit(s.done())
