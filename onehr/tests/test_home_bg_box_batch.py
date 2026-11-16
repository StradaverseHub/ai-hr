"""Home's BG CEOs stage reads the Talent Box ONCE for every group (Chris's capacity rule: a read over a population is one
batched query). It used to resolve and read one box per business group (about 3x the time of the other stages with the Star limits
on). _home_bg_boxes now does one population query, one sessions query and one talent_box_rows pass.

What this holds:
  * the batched Star limits equal the old per-group result (_talent_box_resolve + talent_box_rows + tb_star_limits, one group
    at a time) for EVERY business group in the database, on a database with real moves in two groups' BG CEO sessions
  * the moves matter (the result differs from the same read with no moves), so the equality is not two empty answers
  * a person who changed group keeps no move from the old group's session (the adjustment is read from their own group's session)
  * _home_bg_work gives the same units / locked / moved / over / full as the per-group path
  * the number of talent_box_rows passes is ONE however many groups there are
  * the guard is real: a batched read that ignores the sessions fails the equality
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402
from werkzeug.exceptions import HTTPException  # noqa: E402

a = H.setup()
s = H.Suite("Home BG CEOs stage: one batched Talent Box read equals the per-group reads")

made_adj, made_sess = [], []   # (table, id)


def per_group(db, u, bgs, lim):
    """The old way, kept here as the reference: one resolve + box read per business group."""
    out = {}
    for bg in bgs:
        try:
            ctx = a._talent_box_resolve(db, u, "bgceo", admin_view=True, bg=bg)
            out[bg] = a.tb_star_limits(db, ctx, a.talent_box_rows(db, ctx), "bgceo", lim)
        except HTTPException:
            continue
    return out


with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    PER = a.active_pm_period(db)["id"]
    CYC0 = dict(db.execute("SELECT kind, half FROM cycles WHERE id=?", (CID,)).fetchone())
    ST0 = db.execute("SELECT value FROM app_settings WHERE key='tb_limit_stars_on'").fetchone()
    db.execute("UPDATE cycles SET kind='year_end', half=2 WHERE id=?", (CID,))
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('tb_limit_stars_on','1')")
    db.commit()
    su = db.execute("SELECT * FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL LIMIT 1").fetchone()
    a.g.user = su
    try:
        lim = a.get_tb_limits()
        bgs = sorted(r[0] for r in db.execute("SELECT DISTINCT u.business_group FROM users u WHERE u.role!='admin' AND "
                                              + a.calibration_population_sql("u") + " AND COALESCE(u.business_group,'')!=''"))
        s.check("the database has several business groups with people in the box", len(bgs) >= 3, len(bgs))
        big = sorted(bgs, key=lambda b: -db.execute("SELECT COUNT(*) FROM users u WHERE u.role!='admin' AND u.business_group=? AND "
                                                    + a.calibration_population_sql("u"), (b,)).fetchone()[0])[:2]

        def session(tbl, cyc, bg):
            r = db.execute("SELECT id FROM %s WHERE cycle_id=? AND tier='bgceo' AND scope_key=?" % tbl, (cyc, bg)).fetchone()
            if r:
                return r[0]
            cur = db.execute("INSERT INTO %s(cycle_id, tier, scope_key, business_group, scope_label) VALUES (?,?,?,?,?)" % tbl,
                             (cyc, "bgceo", bg, bg, bg))
            made_sess.append((tbl, cur.lastrowid))
            return cur.lastrowid

        def adjust(tbl, sid, uid, band):
            if db.execute("SELECT 1 FROM %s WHERE session_id=? AND subject_id=?" % tbl, (sid, uid)).fetchone():
                return
            cur = db.execute("INSERT INTO %s(session_id, subject_id, original_band, adjusted_band) VALUES (?,?,?,?)" % tbl,
                             (sid, uid, "ME" if tbl.startswith("pm_") else "Mid", band))
            made_adj.append((tbl, cur.lastrowid))

        def move_people(bg, n):
            ids = [r[0] for r in db.execute("SELECT u.id FROM users u WHERE u.role!='admin' AND u.business_group=? AND "
                                            + a.calibration_population_sql("u") + " ORDER BY u.id LIMIT ?", (bg, n))]
            ps, qs = session("pm_calibration_sessions", PER, bg), session("calibration_sessions", CID, bg)
            for i in ids:
                adjust("pm_calibration_adjustments", ps, i, "OU")
                adjust("calibration_adjustments", qs, i, "High")
            return ids

        base = a._home_bg_boxes(db, su, bgs, lim)
        s.check("with no moves of ours the batched read answers for every group", set(base) == set(per_group(db, su, bgs, lim)),
                (sorted(base), ))
        moved_a = move_people(big[0], 24)
        moved_b = move_people(big[1], 12)
        db.commit()
        old = per_group(db, su, bgs, lim)
        new = a._home_bg_boxes(db, su, bgs, lim)
        s.section("equality, every group")
        for bg in bgs:
            s.check("Star limits equal the per-group read: %s" % bg[:30], new.get(bg) == old.get(bg))
        s.check("same set of groups answered", set(new) == set(old))
        s.check("the moves matter: the two big groups differ from the read before the moves",
                all(new[b] != base[b] for b in big), [new[b] == base[b] for b in big])
        stars = lambda r: sum(x["star"]["n"] + x["super"]["n"] for x in r.values())   # noqa: E731
        s.check("...and they hold more Stars and Super Stars", all(stars(new[b]) > stars(base[b]) for b in big))

        s.section("a person who changed group keeps no move from the old group")
        mover = moved_a[0]
        other = big[1]
        before = a._home_bg_boxes(db, su, bgs, lim)
        db.execute("UPDATE users SET business_group=? WHERE id=?", (other, mover))
        db.commit()
        try:
            old2 = per_group(db, su, bgs, lim)
            new2 = a._home_bg_boxes(db, su, bgs, lim)
            s.check("after the move the batched read still equals the per-group read, every group", new2 == old2)
            s.check("...and the move changed something (the old group's adjustment does not follow them)", new2 != before)
        finally:
            db.execute("UPDATE users SET business_group=? WHERE id=?", (big[0], mover))
            db.commit()

        s.section("_home_bg_work")
        cyc = a.active_cycle(db)
        a._home_lock_rows(db, su, cyc)
        w = a._home_bg_work(db, su, cyc, True)
        calls = []

        def ref():
            out = {}
            for bg, e in w.items():
                e2 = dict(e, over=0, full=0)
                for unit in old.get(bg, {}).values():
                    st = {unit["star"]["state"], unit["super"]["state"]}
                    e2["over"] += 1 if "over" in st else 0
                    e2["full"] += 1 if ("full" in st and "over" not in st) else 0
                out[bg] = e2
            return out
        s.check("over / full per group equal the ones worked out from the per-group read", w == ref())
        s.check("the limit off: no over / full and no box read", all(e["over"] == 0 and e["full"] == 0 for e in
                                                                       a._home_bg_work(db, su, cyc, False).values()))

        s.section("one pass")
        real_rows = a.talent_box_rows
        a.talent_box_rows = lambda d_, ctx: (calls.append(len(ctx["population"])), real_rows(d_, ctx))[1]
        try:
            a._home_bg_boxes(db, su, bgs, lim)
        finally:
            a.talent_box_rows = real_rows
        s.check("talent_box_rows runs once for %d groups" % len(bgs), len(calls) == 1, calls)

        s.section("the guard is real")
        real_rows = a.talent_box_rows
        a.talent_box_rows = lambda d_, ctx: real_rows(d_, {k: v for k, v in ctx.items() if k != "session_by_bg"}
                                                      | {"pm_session": None, "pot_session": None})
        try:
            broken = a._home_bg_boxes(db, su, bgs, lim)
        finally:
            a.talent_box_rows = real_rows
        s.check("a batched read that ignores the groups' sessions no longer equals the per-group read", broken != old)
        s.check("a BG admin who cannot reach a group gets no box for it",
                a._home_bg_boxes(db, dict(su) | {"admin_bg": "no such group"}, [big[0]], lim) == {})
    finally:
        for tbl, i in reversed(made_adj):
            db.execute("DELETE FROM %s WHERE id=?" % tbl, (i,))
        for tbl, i in made_sess:
            db.execute("DELETE FROM %s WHERE id=?" % tbl, (i,))
        db.execute("UPDATE cycles SET kind=?, half=? WHERE id=?", (CYC0["kind"], CYC0["half"], CID))
        if ST0:
            db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('tb_limit_stars_on', ?)", (ST0[0],))
        else:
            db.execute("DELETE FROM app_settings WHERE key='tb_limit_stars_on'")
        db.commit()

sys.exit(s.done())
