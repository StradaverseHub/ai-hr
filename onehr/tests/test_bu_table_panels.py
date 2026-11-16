"""BU CEOs tab: a unit's own calibration panel sits under its row -- 2026-10-27, Chris (approved canvas).

What it holds:
  * a panel that covers ONE unit is a sub-row under that unit (name, chip, curve, calibrators with their counts, Manage)
    and is NOT in the panels' block at the bottom
  * a panel over SEVERAL units stays in the bottom block, its units line carries each unit's count; each unit it reaches
    gets an "In the <panel> panel" sub-row: a link to that block's row, the count from that unit, the calibrators
  * a unit with a BU CEO and panel people shows who is left (people - people in panels) after the BU CEO's name
  * a unit with no BU CEO: panel people and some left over -> a Vacant sub-row with the count of those left;
    everyone in a panel -> no Vacant chip anywhere in the unit's rows, a dash and Set instead, and the CEO filter's value
    is not "Vacant"; a unit with no panel people is exactly as before (Vacant on its row, no sub-rows)
  * sub-rows are plain rows (no data-row, no data-list-open) straight after their unit's row, which is what colmenu.js
    moves and hides with it
"""
import html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("BU CEOs tab: a unit's own panel under its row")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
BG = "ZZBTP Group"
UA, UB, UC, UD, HQ = ("ZZBTP Alpha", "ZZBTP Bravo", "ZZBTP Charlie", "ZZBTP Delta", "ZZBTP HQ")
FIN, OPS = "ZZBTP Finance", "ZZBTP Ops"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9BTP-%'")]
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


def person(db, eid, co, dept, title="ZZBTP Officer"):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, is_demo, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?,?,?, '15', 0, '2020-01-01')",
                      (eid.lower(), "ZZ Btp " + eid[-3:], eid, BG, co, dept, title)).lastrowid


def make_panel(db, name, curve, cal, depts):
    """A panel over the (unit, department) pairs, one calibrator; the panel's units are the pairs' units."""
    pid = db.execute("INSERT INTO calib_bu_panels(business_group, company, name) VALUES (?,?,?)", (BG, curve, name)).lastrowid
    for co in sorted({c for c, _d in depts}):
        db.execute("INSERT INTO calib_bu_panel_units(panel_id, business_group, company) VALUES (?,?,?)", (pid, BG, co))
    gid = db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id, panel_id) VALUES (?,?,?,?,?)",
                     (BG, curve, name, cal, pid)).lastrowid
    for co, d in depts:
        db.execute("INSERT INTO calib_bu_group_units(group_id, business_group, company, department) VALUES (?,?,?,?)",
                   (gid, BG, co, d))
    return pid


with a.app.app_context():
    db = a.get_db()
    _cleanup(db)
    for co in (UA, UB, UC, UD, HQ):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, co))
    CAL1 = person(db, "ZZ9BTP-CL1", HQ, "ZZBTP Group Finance", title="CHIEF FINANCIAL OFFICER")
    CAL2 = person(db, "ZZ9BTP-CL2", HQ, "ZZBTP Group Ops", title="Group Chief Operating Officer")
    CEOA = person(db, "ZZ9BTP-CEA", UA, OPS, title="Chief Executive Officer")
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, UA, CEOA))
    a._sync_buceo_primary(db, CEOA)
    N = {}
    for tag, co, dept, k in (("AF", UA, FIN, 3), ("AO", UA, OPS, 2), ("BF", UB, FIN, 2), ("BO", UB, OPS, 3),
                             ("CF", UC, FIN, 3), ("DO", UD, OPS, 2)):
        for i in range(k):
            person(db, "ZZ9BTP-%s%d" % (tag, i), co, dept)
    PA = make_panel(db, "ZZBTP Alpha Finance", UA, CAL1, [(UA, FIN)])                    # one unit
    PM = make_panel(db, "ZZBTP Shared Finance", UB, CAL2, [(UB, FIN), (UC, FIN)])         # two units
    db.commit()
    # what the page must show, worked out from the data
    N = {co: db.execute("SELECT COUNT(*) FROM users WHERE business_group=? AND company=? AND role!='admin' AND left_at "
                        "IS NULL AND COALESCE(is_demo,0)=0", (BG, co)).fetchone()[0] for co in (UA, UB, UC, UD)}
    IN_P = {(co, d): db.execute("SELECT COUNT(*) FROM users WHERE business_group=? AND company=? AND department=?",
                                (BG, co, d)).fetchone()[0] for co, d in ((UA, FIN), (UB, FIN), (UC, FIN))}

C_SU = H.client_as(a, SU["id"])


def page():
    return html.unescape(C_SU.get("/admin/leaders?tab=buceo&bg=" + BG.replace(" ", "+")).get_data(as_text=True))


def unit_block(pg, co):
    """A unit's data row and the sub-rows after it, up to the next data row."""
    m = re.search(r'<tr class="data-row[^"]*" data-bu="%s".*?(?=<tr class="data-row|<tr class="no-filter-match)'
                  % re.escape(co), pg, re.S)
    return m.group(0) if m else ""


try:
    pg = page()
    bottom = pg[pg.find('<tbody class="ld-grp-body">'):] if '<tbody class="ld-grp-body">' in pg else ""
    bottom = bottom[:bottom.find("</tbody>")]
    A, B, C, D = (unit_block(pg, u) for u in (UA, UB, UC, UD))
    s.check("every unit's block was found", all((A, B, C, D)), [len(x) for x in (A, B, C, D)])

    s.section("a panel over one unit: a sub-row under the unit, not in the bottom block")
    arow = re.search(r'<tr class="ld-subrow" id="bu-panel-%d">.*?</tr>' % PA, A, re.S)
    arow = arow.group(0) if arow else ""
    s.check("the unit's block carries the panel's sub-row: name, chip, curve, its people, Manage",
            "ZZBTP Alpha Finance" in arow and "Calibration panel" in arow and "Curve: %s's PAT" % UA in arow
            and "<td>%d</td>" % IN_P[(UA, FIN)] in arow and 'data-panel-open="bp-%d"' % PA in arow, arow[:300])
    s.check("...with its calibrator, their tag and their count", "ZZ Btp CL1" in arow and ">CFO</span>" in arow
            and 'class="ld-eid">%d<' % IN_P[(UA, FIN)] in arow, arow[-300:])
    s.check("...and it is not in the bottom block, which holds the panel over several units",
            'id="bu-panel-%d"' % PA not in bottom and 'id="bu-panel-%d"' % PM in bottom and 'id="bu-panel-%d"' % PA in pg)
    s.check("its Manage side panel is still there", 'data-panel="bp-%d"' % PA in pg)
    s.check("the unit's row says nothing of the panel in its People cell", re.search(r"in ZZBTP Alpha Finance", A.split(
        '<tr class="ld-subrow"')[0]) is None)
    s.check("a unit with a BU CEO and panel people shows who is left after the BU CEO's name",
            'class="muted small" title="People of this unit in no calibration panel' in A
            and re.search(r'ZZ9BTP-CEA</span>\s*<span class="muted small"[^>]*>· %d people</span>' % (N[UA] - IN_P[(UA, FIN)]), A) is not None
            and "Vacant" not in A, A[:700])

    s.section("a panel over several units: the bottom row counts each unit; each unit has an 'In the ... panel' line")
    mrow = re.search(r'<tr class="ld-grp-row" id="bu-panel-%d">.*?</tr>' % PM, bottom, re.S)
    mrow = mrow.group(0) if mrow else ""
    s.check("the bottom row lists each unit with its people in the panel",
            "%s %d, %s %d" % (UB, IN_P[(UB, FIN)], UC, IN_P[(UC, FIN)]) in mrow and "Manage" in mrow, mrow[:400])
    s.check("...and it counts everyone in it once", "<td>%d</td>" % (IN_P[(UB, FIN)] + IN_P[(UC, FIN)]) in mrow)
    for co, blk in ((UB, B), (UC, C)):
        # the panel's name opens its people narrowed to this unit (bu-panel-people ?co=, 2026-10-28), no longer an anchor
        ln = re.search(r'<tr class="ld-subrow">\s*<td><span class="ld-tree"[^>]*>.*?</span>In the <button type="button" '
                       r'class="btn-link ld-bu-name" data-list-open="[^"]*bu-panel-people[^"]*pid=%d[^"]*co=[^"]*"[^>]*>'
                       r'ZZBTP Shared Finance</button> panel</td>\s*<td>(\d+)</td>(.*?)</tr>' % PM, blk, re.S)
        s.check("%s: 'In the ZZBTP Shared Finance panel', the count from that unit, the calibrator (no count, no Manage)" % co,
                ln is not None and int(ln.group(1)) == IN_P[(co, FIN)] and "ZZ Btp CL2" in ln.group(2)
                and "ld-eid" not in ln.group(2) and "data-panel-open" not in ln.group(2), ln and ln.group(0)[:300])

    s.section("no BU CEO: a Vacant line for who is left, and no Vacant at all once everyone has a calibrator")
    left_b = N[UB] - IN_P[(UB, FIN)]
    vac = re.search(r'<tr class="ld-subrow">\s*<td><span class="ld-tree"[^>]*>.*?</span><span class="ld-chip is-none"[^>]*>'
                    r'Vacant</span> in no panel and no BU CEO</td>\s*<td>(\d+)</td>(.*?)</tr>', B, re.S)
    s.check("a unit with some people in a panel and some in none: a last Vacant line with the count left",
            left_b > 0 and vac is not None and int(vac.group(1)) == left_b
            and "No BU-level calibration; the BG CEO decides them on the Talent Box" in vac.group(2), B[-500:])
    s.check("...after the panel line, as the unit's last line", B.rfind('Vacant</span> in no panel') > B.find("In the"))
    s.check("...and the unit's own row keeps its Vacant chip and its Set button",
            'class="ld-chip is-none" title="Nobody calibrates this unit at BU level; the BG CEO decides its people on the Talent Box' in B.split('<tr class="ld-subrow"')[0]
            and ">Set</button>" in B.split('<tr class="ld-subrow"')[0])
    s.check("the page no longer says the BG CEO's lock waits on a vacant unit (Chris, 2026-10-07)", "lock waits on" not in B)
    s.check("everyone in a panel (nobody left, no BU CEO): no Vacant chip in any of the unit's rows",
            N[UC] == IN_P[(UC, FIN)] and "Vacant" not in C and "ld-chip is-none" not in C, C[:600])
    s.check("...a dash that says why, the Set button, and the CEO filter's value is the first calibrator, never Vacant",
            'title="Everyone here has a calibrator">&mdash;' in C.replace("—", "&mdash;") and ">Set</button>" in C
            and 'data-ceo="ZZ Btp CL2"' in C and 'data-ceo="Vacant"' not in C, C[:400])
    s.check("a unit with no panel people is as before: Vacant on its row, no sub-rows",
            "ld-subrow" not in D and "ld-chip is-none" in D and 'data-ceo="Vacant"' in D and ">Set</button>" in D, D[:400])
    s.check("a unit with a BU CEO keeps its BU CEO as the filter value", 'data-ceo="ZZ Btp CEA"' in A)

    s.section("sub-rows travel with their unit (colmenu.js moves plain rows after a data row)")
    subs = re.findall(r'<tr class="ld-subrow"[^>]*>', pg)
    s.check("sub-rows exist and are plain rows: not data-row, no list peek",
            len(subs) >= 4 and all("data-row" not in x and "data-list-open" not in x for x in subs), len(subs))
    s.check("...each sits inside the units' tbody, after its unit's data row",
            all(pg.find(x) < pg.find('<tbody class="ld-grp-body">') for x in subs)
            and A.startswith('<tr class="data-row') and A.count("<tr ") == 2 and C.count("<tr ") == 2 and B.count("<tr ") == 3)
    s.check("...and the tree marks end with an elbow", A.count("&#9492;") == 1 or "└" in A)
finally:
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
