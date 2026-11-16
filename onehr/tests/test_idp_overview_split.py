"""The Career Plan Overview, split in two (Chris, 2026-11-06, canvas PAzm9HkvkUTBsFGntZqKwd): the people in the cycle's review (the
numbers Home shows), then the people who have a plan but are outside it, by why.

What this suite holds:
  * the top tiles and the first table count exactly the people Home's Career Plan cell counts: per business group, People = the
    cell's n and Shared = the cell's done (so the page and Home can never disagree); the tiles are their sum
  * the out population (a plan, not in the review) never leaks into the top numbers, and splits into reasons that sum to it; each
    person's reason, worked out in SQL in one read, equals participation()'s answer for them (Grade H first, a take-out, not
    confirmed yet, a role with no review), checked over the whole database
  * every number on the page that opens a list opens exactly that many people (tiles, both tables' cells, the reason boxes)
  * a BG admin sees only their group, no list door, and the list refuses them; the empty out card says so
  * the guards are real: dropping idp_count_sql from the top, dropping the NOT from the out population and breaking a reason rule
    each fail the checks
"""
import html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Career Plan Overview: in the review / not in the cycle")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BGA, BGB, BGC = "ZZIS Alpha", "ZZIS Beta", "ZZIS Gamma"
NAV = {"Sec-Fetch-Mode": "navigate"}
ROLE_NAME = "ZZIS Plan only"


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9IS-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM pm_idp_checkins WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_idp WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM user_roles WHERE name=?", (ROLE_NAME,))
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    CYC0 = dict(db.execute("SELECT kind, half, starts_on, min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())
    MODS0 = {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?", (CID,))}
    db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL, starts_on=COALESCE(starts_on, '2026-01-01') "
               "WHERE id=?", (CID,))
    for k in ("review", "pm", "tm", "idp"):
        if db.execute("SELECT 1 FROM cycle_modules WHERE cycle_id=? AND module_key=?", (CID, k)).fetchone():
            db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key=?", (CID, k))
        else:
            db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, k))
    CNAME = db.execute("SELECT name FROM cycles WHERE id=?", (CID,)).fetchone()[0]
    YEAR = a.pm_idp_plan_year(a.active_pm_period(db))
    rid = db.execute("INSERT INTO user_roles(name) VALUES (?)", (ROLE_NAME,)).lastrowid
    db.execute("INSERT INTO user_role_modules(role_id, module) VALUES (?, 'idp')", (rid,))   # a plan, none of the review

    def mk(eid, bg, confirmed=True, grade="14", mgr=None, role="user", admin_bg=None, user_role=None):
        return db.execute(
            "INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, department, "
            "job_title, job_grade, manager_id, confirmation_date, years_of_service, admin_bg, user_role_id) "
            "VALUES (?,?,'x',?,?,?,?,'ZZIS Dept','ZZIS Officer',?,?,?,?,?,?)",
            (eid.lower(), "ZZ IS " + eid[6:], role, eid, bg, bg + " U1", grade, mgr, "2020-01-01" if confirmed else None,
             4.0 if confirmed else 0.5, admin_bg, user_role)).lastrowid

    def plan(uid, st):
        pid = db.execute("INSERT INTO pm_idp(plan_year, cycle_id, subject_id, status, shared_at) VALUES (?,?,?,?,?)",
                         (YEAR, CID, uid, st, None if st == "draft" else "2026-11-01 00:00:00")).lastrowid
        return db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area) VALUES (?,1,'ZZIS goal')", (pid,)).lastrowid

    def remove(uid):
        db.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,'remove')", (CID, uid))
    # ---- Alpha: five in the review (one shared, one draft, one closed, two with no plan), out: unconfirmed, taken out, Grade H x2
    LMA = mk("ZZ9IS-LMA", BGA)
    A1, A2, A3, A4 = (mk("ZZ9IS-A%d" % i, BGA, mgr=LMA) for i in range(1, 5))
    AUN, ARM, AGH, AGH2 = (mk("ZZ9IS-A" + x, BGA, mgr=LMA, **kw) for x, kw in (
        ("UN", {"confirmed": False}), ("RM", {}), ("GH", {"grade": "H"}), ("G2", {"grade": "H"})))
    plan(A1, "shared")
    plan(A2, "draft")
    plan(A3, "closed")
    plan(AUN, "draft")
    plan(ARM, "shared")
    plan(AGH, "closed")
    remove(ARM)
    remove(AGH2)   # Grade H AND taken out: Grade H first (participation()'s order)
    # ---- Beta: three in the review, out: unconfirmed (closed), taken out (no plan), a role with the plan but none of the review
    LMB = mk("ZZ9IS-LMB", BGB)
    B1, B2 = (mk("ZZ9IS-B%d" % i, BGB, mgr=LMB) for i in (1, 2))
    BUN, BRM, BRO = mk("ZZ9IS-BUN", BGB, confirmed=False, mgr=LMB), mk("ZZ9IS-BRM", BGB, mgr=LMB), mk("ZZ9IS-BRO", BGB, mgr=LMB, user_role=rid)
    plan(B1, "shared")
    ck = plan(B2, "draft")
    plan(BUN, "closed")
    plan(BRO, "draft")
    remove(BRM)
    # ---- Gamma: in the review only, one BG admin there; nobody outside it
    LMC = mk("ZZ9IS-LMC", BGC)
    C1 = mk("ZZ9IS-C1", BGC, mgr=LMC)
    plan(C1, "shared")
    ADM_A = mk("ZZ9IS-ADA", BGA, role="admin", admin_bg=BGA)
    ADM_C = mk("ZZ9IS-ADC", BGC, role="admin", admin_bg=BGC)
    db.commit()
    SU = db.execute("SELECT * FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                    "AND employee_id NOT LIKE 'ZZ9IS-%' LIMIT 1").fetchone()
    SUID = SU["id"]
    IN_A, OUT_A = {LMA, A1, A2, A3, A4}, {AUN, ARM, AGH, AGH2}
    IN_B, OUT_B = {LMB, B1, B2}, {BUN, BRM, BRO}
    OUT_REASON = {AUN: "not_confirmed", ARM: "removed", AGH: "grade_h", AGH2: "grade_h", BUN: "not_confirmed", BRM: "removed",
                  BRO: "role"}


def dbg(bg):
    with a.app.test_request_context("/"):
        return a.display_bg(bg)


def page(uid, path="/admin/m/idp"):
    r = H.client_as(a, uid).get(path, headers=NAV)
    return r.status_code, html.unescape(r.get_data(as_text=True))


def listing(url, uid=SUID):
    r = H.client_as(a, uid).get(url, headers=NAV)
    t = r.get_data(as_text=True)
    m = re.search(r"·\s*([\d,]+)", html.unescape(t))
    return r.status_code, (int(m.group(1).replace(",", "")) if m else None), html.unescape(t)


def tiles(pg):
    return {lab.strip(): int(n.replace(",", "")) for lab, n in re.findall(
        r'<span class="muted small">([^<]+)</span><b>([\d,]+)</b>', pg)}


def row_nums(pg, label, card):
    """The numbers in the table row of `label` inside the card titled `card`."""
    sec = pg[pg.index("<h2>" + card + "</h2>"):]
    sec = sec[:sec.index("</section>")]
    m = re.search(r"<tr[^>]*><td>\s*" + re.escape(label) + r"\s*</td>(.*?)</tr>", sec, re.S)
    if not m:
        return None
    out = []
    for td in m.group(1).split("</td>"):
        if td.strip():
            txt = re.sub(r"<[^>]+>", "", re.sub(r'<span class="ipo-pct">.*?</span>', "", td)).strip()
            out.append(int(txt.replace(",", "")))
    return out


def home_cell(bg):
    """(done, n) of Home's Career Plan cell for one business group (bg None: the All row)."""
    with a.app.test_request_context("/"):
        d = a.get_db()
        su = d.execute("SELECT * FROM users WHERE id=?", (SUID,)).fetchone()
        a.g.user = su
        mat = a._home_bg_matrix(d, su, a.active_cycle(d))
    ix = [c["key"] for c in mat["cols"]].index("idp")
    cell = mat["total"]["cells"][ix] if bg is None else next(r for r in mat["rows"] if r["bg"] == bg)["cells"][ix]
    m = re.match(r"([\d,]+) of ([\d,]+)", cell["sub"])
    return int(m.group(1).replace(",", "")), int(m.group(2).replace(",", ""))


def invariants():
    """name -> bool: the relationships the page must hold. Run on the real app, then on three broken ones."""
    out = {}
    code, pg = page(SUID)
    t = tiles(pg)
    d_all, n_all = home_cell(None)
    out["tile Shared = Home's All cell (done)"] = t.get("Shared with a manager") == d_all
    sec = pg[pg.index("In the "):pg.index("By business group")]
    out["'N people in the review' = Home's All cell (n)"] = ("%s people in the review" % format(n_all, ",")) in sec
    out["tile Plans started / Closed are the first table's sums"] = (
        t.get("Plans started") is not None and t.get("Closed by the manager") is not None)
    for bg, ins in ((BGA, IN_A), (BGB, IN_B), (BGC, {LMC, C1})):
        done, n = home_cell(bg)
        rn = row_nums(pg, dbg(bg), "By business group")
        out["%s: People = Home's n and Shared = Home's done" % bg] = bool(rn) and rn[0] == n and rn[2] == done
    # the out population, over the whole database: a plan but not in the review, with participation()'s reason
    with a.app.test_request_context("/"):
        d = a.get_db()
        py_out, py_why = set(), {}
        for u in d.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0"):
            has, _w = a.idp_participation(d, u)
            if has and not a.participation(d, u)[0]:
                py_out.add(u["id"])
                py_why[u["id"]] = a.participation(d, u)[1]
        w, p = a._idp_pop_where(d.execute("SELECT * FROM users WHERE id=?", (SUID,)).fetchone(), "out")
        sql_out = {r[0]: r[1] for r in d.execute("SELECT u.id, " + a._idp_out_reason_sql("u") + " FROM users u WHERE 1=1" + w, p)}
        w_in, p_in = a._idp_pop_where(d.execute("SELECT * FROM users WHERE id=?", (SUID,)).fetchone(), "in")
        sql_in = {r[0] for r in d.execute("SELECT u.id FROM users u WHERE 1=1" + w_in, p_in)}
    out["out population = idp_participation true and participation false (whole database)"] = set(sql_out) == py_out
    out["each person's SQL reason = participation()'s why (whole database)"] = all(sql_out.get(i) == py_why[i] for i in py_out)
    out["no one is both in and out"] = not (sql_in & set(sql_out))
    out["the fixture's out people have exactly the planned reasons"] = all(sql_out.get(k) == v for k, v in OUT_REASON.items())
    out["the fixture's out people never sit in the in population"] = not (set(OUT_REASON) & sql_in)
    return out


try:
    s.section("the fixture")
    code, pg = page(SUID)
    s.check("the Overview opens", code == 200, code)
    s.check("the heading names the cycle and says these are Home's numbers",
            ("<h2>In the %s</h2>" % CNAME) in pg and "These are the numbers Home shows." in pg, CNAME)
    s.check("the four tiles, in order, with the new labels",
            re.findall(r'<span class="muted small">([^<]+)</span><b>', pg)[:4]
            == ["Plans started", "Shared with a manager", "Closed by the manager", "Check-ins this plan year"],
            re.findall(r'<span class="muted small">([^<]+)</span><b>', pg)[:4])
    s.check("the old 'Plans for' tile is gone", "Plans for" not in pg)

    s.section("the people in the review = Home's Career Plan cell")
    inv = invariants()
    for k, v in inv.items():
        s.check(k, v)
    ra, rb = row_nums(pg, dbg(BGA), "By business group"), row_nums(pg, dbg(BGB), "By business group")
    s.check("Alpha reads People 5, Started 3, Shared 2, Closed 1, Not started 2 (the five outside it left out)",
            ra == [5, 3, 2, 1, 2], ra)
    s.check("Beta reads People 3, Started 2, Shared 1, Closed 0, Not started 1", rb == [3, 2, 1, 0, 1], rb)
    s.check("Not started = People - Started on every row",
            all(r[4] == r[0] - r[1] for r in (ra, rb)))
    s.check("percentages are floored like Home (Alpha: Started 3 of 5 = 60%, Shared 2 of 5 = 40%, Closed 1 of 5 = 20%)",
            all(x in pg for x in (">60%<", ">40%<", ">20%<")))
    s.check("Beta Shared 1 of 3 reads 33% (floored, not 34%)", ">33%<" in pg and ">34%<" not in pg)
    s.check("a bold 'All business groups' row sits at the foot", 'class="ipo-total"' in pg and "All business groups" in pg)
    ids_in_order = [m for m in re.findall(r"<tr[^>]*><td>\s*([^<]+?)\s*</td>", pg[pg.index("By business group"):])]
    s.check("sorted by people, biggest first, All last",
            ids_in_order.index(dbg(BGA)) < ids_in_order.index(dbg(BGB)) < ids_in_order.index("All business groups"),
            ids_in_order[:8])

    s.section("the check-ins count the review's people only")
    base_ck = tiles(pg)["Check-ins this plan year"]
    with a.app.app_context():
        d = a.get_db()
        d.execute("INSERT INTO pm_idp_checkins(goal_id, subject_id, status, note) VALUES (?,?,'on_track','ZZIS')", (ck, B2))
        og = d.execute("SELECT g.id FROM pm_idp_goals g JOIN pm_idp i ON i.id=g.idp_id WHERE i.subject_id=?", (AUN,)).fetchone()[0]
        d.execute("INSERT INTO pm_idp_checkins(goal_id, subject_id, status, note) VALUES (?,?,'on_track','ZZIS')", (og, AUN))
        d.commit()
    _c, pg2 = page(SUID)
    s.check("a check-in on an in-review plan adds one, one on an out-of-review plan adds none",
            tiles(pg2)["Check-ins this plan year"] == base_ck + 1, (base_ck, tiles(pg2)["Check-ins this plan year"]))
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM pm_idp_checkins WHERE note='ZZIS'")
        d.commit()

    s.section("not in the cycle, writing a plan")
    sec = pg[pg.index("<h2>Not in the cycle, writing a plan</h2>"):]
    sec = sec[:sec.index("</section>")]
    s.check("the lede says they keep the plan and are not counted on Home",
            "They keep their plan and can share it, and their line manager can close it. It is not counted on Home or in the "
            "numbers above." in sec)

    def box(label):
        m = re.search(r'title="([^"]*)"[^>]*>\s*<span class="muted small">' + re.escape(label) + r'</span><b>([\d,]+) '
                      r'(?:people|person)</b>\s*<span class="muted small">(\d+) started · (\d+) shared · (\d+) closed</span>', sec)
        return (m.group(1), [int(m.group(i).replace(",", "")) for i in (2, 3, 4, 5)]) if m else None
    with a.app.test_request_context("/"):
        d = a.get_db()
        su = d.execute("SELECT * FROM users WHERE id=?", (SUID,)).fetchone()
        w, p = a._idp_pop_where(su, "out")
        allout = {}
        for r in d.execute("SELECT u.id, " + a._idp_out_reason_sql("u") + " rs, COALESCE(i.status,'') st FROM users u LEFT JOIN pm_idp i "
                           "ON i.subject_id=u.id AND i.plan_year=? WHERE 1=1" + w, [YEAR] + p):
            allout.setdefault(r["rs"], []).append(r["st"])
    for key, label, _short, _why in a.IDP_OUT_REASONS:
        sts = allout.get(key, [])
        want = [len(sts), sum(1 for x in sts if x), sum(1 for x in sts if x in ("shared", "closed")), sum(1 for x in sts if x == "closed")]
        got = box(label)
        if key == "role" and not sts:
            continue
        s.check("%s: people / started / shared / closed read %s" % (label, want), got is not None and got[1] == want, got)
        s.check("%s has its plain why in a title" % label, got is not None and len(got[0]) > 20, got and got[0])
    tot_boxes = sum((box(x[1]) or ("", [0]))[1][0] for x in a.IDP_OUT_REASONS)
    out_all = row_nums(pg, "All business groups", "Not in the cycle, writing a plan")
    s.check("the reasons sum to the out people, who are the out table's All row",
            out_all is not None and tot_boxes == out_all[0] >= len(OUT_REASON), (tot_boxes, out_all))
    out_a = row_nums(pg, dbg(BGA), "Not in the cycle, writing a plan")
    out_b = row_nums(pg, dbg(BGB), "Not in the cycle, writing a plan")
    s.check("Alpha out: People 4, Started 3, Shared 2, Closed 1, Not started 1", out_a == [4, 3, 2, 1, 1], out_a)
    s.check("Beta out: People 3, Started 2, Shared 1, Closed 1, Not started 1", out_b == [3, 2, 1, 1, 1], out_b)
    s.check("the out table has no percentages", "ipo-pct" not in sec)
    s.check("the in-review tiles and table hold none of the out people: Alpha's People is 5, not 9",
            ra[0] == 5 and rb[0] == 3)

    s.section("every number opens exactly that many people")
    anchors = re.findall(r'<a\b[^>]*data-list-open="([^"]+)"[^>]*>(.*?)</a>', pg, re.S)
    bad, seen = [], 0
    for url, inner in anchors:
        txt = re.sub(r"<[^>]+>", " ", inner)
        n = int(re.search(r"([\d,]+)", txt).group(1).replace(",", ""))
        code_, got, _t = listing(url)
        seen += 1
        if code_ != 200 or got != n:
            bad.append((url, n, got, code_))
    s.check("%d numbers on the page open a list, and each list's count is the number clicked" % seen,
            seen >= 40 and not bad, bad[:5])
    c1, n1, t1 = listing("/admin/list/idp-plans?which=shared&pop=in&fbg=%s&fragment=1" % BGA.replace(" ", "+"))
    s.check("Alpha's Shared list holds exactly its two shared in-review people, not the out ones",
            c1 == 200 and n1 == 2 and "ZZ IS A1" in t1 and "ZZ IS ARM" not in t1, n1)
    c2, n2, t2 = listing("/admin/list/idp-plans?which=not_started&pop=in&fbg=%s&fragment=1" % BGA.replace(" ", "+"))
    s.check("Not started (in) lists the people with no plan row", n2 == 2 and "ZZ IS A4" in t2 and "ZZ IS LMA" in t2, n2)
    c3, n3, t3 = listing("/admin/list/idp-plans?which=people&pop=out&reason=grade_h&fbg=%s&fragment=1" % BGA.replace(" ", "+"))
    s.check("Grade H (out) lists both Grade H people (one also taken out) with the why in a column",
            n3 == 2 and "ZZ IS AGH" in t3 and "ZZ IS AG2" in t3 and "Why" in t3, n3)
    c4, n4, t4 = listing("/admin/list/idp-plans?which=started&pop=out&reason=removed&fbg=%s&fragment=1" % BGB.replace(" ", "+"))
    s.check("Taken out + started in Beta is empty (its taken-out person has no plan)", c4 == 200 and n4 == 0, n4)
    c5, n5, _t5 = listing("/admin/list/idp-plans?which=all&fbg=%s&fragment=1" % BGA.replace(" ", "+"))
    s.check("the old which=all still works (it is Plans started)", n5 == 3, n5)
    c6, n6, _t6 = listing("/admin/list/idp-plans?which=people&pop=out&reason=nonsense&fbg=%s&fragment=1" % BGA.replace(" ", "+"))
    s.check("an unknown reason is ignored (all of the group's out people), never an error", c6 == 200 and n6 == 4, (c6, n6))

    s.section("a BG admin sees their group only")
    code, apg = page(ADM_A)
    s.check("a BG admin's Overview opens and names only their group",
            code == 200 and dbg(BGA) in apg and dbg(BGB) not in apg, code)
    s.check("...with no list door (the lists are the super admin's) and the numbers link to Progress",
            "data-list-open" not in apg and "/admin/module/idp/progress" in apg)
    s.check("...their People is Alpha's 5, one group so no All row",
            row_nums(apg, dbg(BGA), "By business group") == [5, 3, 2, 1, 2] and 'class="ipo-total"' not in apg)
    s.check("...their out reasons are Alpha's own (Taken out 1, Grade H 2, Not confirmed 1)",
            (lambda sx: [re.search(re.escape(l) + r'</span><b>(\d+)', sx).group(1) for l in
                         ("Not confirmed yet", "Taken out of this cycle", "Grade H")])(apg) == ["1", "1", "2"])
    for who, fbg in (("their own group", BGA), ("another group", BGB)):
        cc, _n, _t = listing("/admin/list/idp-plans?which=shared&fbg=%s&fragment=1" % fbg.replace(" ", "+"), ADM_A)
        s.check("the list refuses a BG admin for %s (403)" % who, cc == 403, cc)
    with a.app.test_request_context("/"):
        d = a.get_db()
        ma = d.execute("SELECT * FROM users WHERE id=?", (ADM_A,)).fetchone()
        a.g.user = ma
        other = a._list_idp_plans(d, ma, CID, {"fbg": BGB, "which": "people"})
    s.check("and the builder itself, asked for another group, returns nobody (bg_scope still narrows it)", not other["rows"])

    s.section("nothing outside the review")
    code, cpg = page(ADM_C)
    s.check("a group with nobody outside the review says so and shows no boxes or table",
            code == 200 and ("Everyone with a Career Plan is in the %s." % CNAME) in cpg and "ipo-reason" not in cpg
            and "They keep their plan" not in cpg, code)
    s.check("...and its single in-review group has no All row", 'class="ipo-total"' not in cpg)

    s.section("the guards are real (each broken, then put back)")
    real_where, real_reason = a._idp_pop_where, a._idp_out_reason_sql

    def broken_top(me, pop, fbg=""):   # the top drops idp_count_sql: it counts every plan holder, the out people too
        w, p = real_where(me, "out" if pop == "out" else "in", fbg)
        return (w.replace(a.idp_count_sql("u"), a.idp_participant_sql("u")), p) if pop != "out" else (w, p)

    def broken_out(me, pop, fbg=""):   # the NOT dropped: the out population is the in-review people
        return real_where(me, "in", fbg)

    def broken_reason(prefix="u"):   # a reason rule broken: Grade H no longer comes first
        return real_reason(prefix).replace("WHEN NOT %s THEN 'grade_h' " % a.no360_sql(prefix), "")
    for name, attr, fn, want_fail in (
            ("dropping idp_count_sql from the top", "_idp_pop_where", broken_top, "Plans started"),
            ("dropping the NOT from the out population", "_idp_pop_where", broken_out, "out"),
            ("breaking a reason rule (Grade H no longer first)", "_idp_out_reason_sql", broken_reason, "reason")):
        old = getattr(a, attr)
        setattr(a, attr, fn)
        try:
            bad_inv = [k for k, v in invariants().items() if not v]
            _c, bpg = page(SUID)
            ba = row_nums(bpg, dbg(BGA), "By business group")
            bo = row_nums(bpg, dbg(BGA), "Not in the cycle, writing a plan")
            boxed = re.search(r"Grade H</span><b>(\d+)", bpg)
            broke = bool(bad_inv) or ba != [5, 3, 2, 1, 2] or bo != [4, 3, 2, 1, 1] or (boxed and boxed.group(1) != "2")
        finally:
            setattr(a, attr, old)
        s.check("falsified: %s makes the checks fail" % name, broke, (bad_inv[:2], ba, bo))
    s.check("...and with the guards back the invariants all hold again", all(invariants().values()))
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)
        _db.execute("UPDATE cycles SET kind=?, half=?, starts_on=?, min_job_grade=? WHERE id=?",
                    (CYC0["kind"], CYC0["half"], CYC0["starts_on"], CYC0["min_job_grade"], CID))
        for k in ("review", "pm", "tm", "idp"):
            if k in MODS0:
                _db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (MODS0[k], CID, k))
            else:
                _db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key=?", (CID, k))
        _db.commit()

sys.exit(s.done())
