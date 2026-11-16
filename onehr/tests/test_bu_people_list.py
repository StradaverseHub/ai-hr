"""Leaders > BU CEOs: a unit's row opens the people in it (Chris, 2026-10-27: "make the BU row here clickable and open a
side panel to show the people in the BU, their name, department, JG, and job title ... click change will go to the BUCEO
setting"). The list is the admin count list panel (ADMIN_LISTS "bu-people"), so it is the super admin's; its count is the
page's People column, a BG admin outside the group gets 404, the row carries the opener for the super admin only, and
Change BU CEO is drawn only where the page's own Change would be. Everything written is synthetic (ZZBP-*) and removed."""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Leaders > BU CEOs: a unit's row opens its people")
SU, _BGA, _E = H.actors(a)
BG, BG2, U1, U2 = "ZZBP BG", "ZZBP BG Other", "ZZBP Unit One", "ZZBP Unit Two"


def cleanup(db):
    for (g_,) in db.execute("SELECT id FROM calib_bu_groups WHERE business_group IN (?,?)", (BG, BG2)).fetchall():
        for t_ in ("calib_bu_group_units", "calib_bu_group_people", "calib_bu_group_left", "calib_bu_group_depts"):
            db.execute("DELETE FROM %s WHERE group_id=?" % t_, (g_,))
    db.execute("DELETE FROM calib_bu_groups WHERE business_group IN (?,?)", (BG, BG2))
    for (p_,) in db.execute("SELECT id FROM calib_bu_panels WHERE business_group IN (?,?)", (BG, BG2)).fetchall():
        db.execute("DELETE FROM calib_bu_panel_units WHERE panel_id=?", (p_,))
        db.execute("DELETE FROM calib_bu_panel_weights WHERE panel_id=?", (p_,))
    db.execute("DELETE FROM calib_bu_panels WHERE business_group IN (?,?)", (BG, BG2))
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZBP-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM buceo_seats WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM admin_companies WHERE admin_id IN (%s)" % ph, ids)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG, BG2))
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    cleanup(db)
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, name, co=U1, bg=BG, dept="ZZBP Dept A", title="ZZBP Analyst", jg="14", left=None, demo=0, role="user",
           admin_bg=None):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=bg, company=co, department=dept,
                 job_title=title, job_grade=jg, years_of_service=3, left_at=left, is_demo=demo, role=role,
                 admin_bg=admin_bg)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?),(?,?),(?,?)",
               (BG, U1, BG, U2, BG2, "ZZBP Other Unit"))
    P = [mk("ZZBP-P1", "ZZ BP Bea", dept="ZZBP Dept B"), mk("ZZBP-P2", "ZZ BP Ann", dept="ZZBP Dept A"),
         mk("ZZBP-P3", "ZZ BP Cal", dept="ZZBP Dept A", title="A Very Long Job Title For The Clip Check Group Head")]
    GONE = mk("ZZBP-GONE", "ZZ BP Gone", left="2026-01-31 00:00:00")
    DEMO = mk("ZZBP-DEMO", "ZZ BP Demo", demo=1)
    ADM = mk("ZZBP-ADM", "ZZ BP Adm", role="admin", admin_bg=BG)           # the group's admin
    UADM = mk("ZZBP-UADM", "ZZ BP UAdm", role="admin", admin_bg=BG)        # a unit admin of U1
    OADM = mk("ZZBP-OADM", "ZZ BP Other Adm", role="admin", admin_bg=BG2, bg=BG2, co="ZZBP Other Unit")
    mk("ZZBP-V2", "ZZ BP Vacant One", co=U2)
    mk("ZZBP-V3", "ZZ BP Vacant Two", co=U2, dept="ZZBP Dept X")
    mk("ZZBP-V4", "ZZ BP Vacant Three", co=U2, dept="ZZBP Dept X")
    CAL = mk("ZZBP-CAL", "ZZ BP Calibrator", bg=BG2, co="ZZBP Other Unit")   # a calibrator needs no unit of the panel
    CEO = mk("ZZBP-CEO", "ZZ BP Ceo", jg="21")
    db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?,?)", (UADM, U1))
    db.execute("INSERT INTO buceo_seats(user_id, business_group, company) VALUES (?,?,?)", (CEO, BG, U1))
    db.commit()

su = H.client_as(a, SU["id"])
bga = H.client_as(a, H.one(a, "SELECT id FROM users WHERE employee_id='ZZBP-ADM'"))
uad = H.client_as(a, H.one(a, "SELECT id FROM users WHERE employee_id='ZZBP-UADM'"))
oth = H.client_as(a, H.one(a, "SELECT id FROM users WHERE employee_id='ZZBP-OADM'"))


def url(co, bg=BG):
    return "/admin/list/bu-people?fragment=1&bg=%s&co=%s" % (bg.replace(" ", "%20"), co.replace(" ", "%20"))


def build(uid, co, bg=BG):
    with a.app.test_request_context("/admin/list/bu-people?bg=x"):
        a.g.user = None
        return a.ADMIN_LISTS["bu-people"]["build"](a.get_db(), a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone(),
                                                  None, {"bg": bg, "co": co})


try:
    s.section("the list: who, in order, and the same count as the page")
    r = su.get(url(U1))
    t = r.get_data(as_text=True)
    page = su.get("/admin/leaders?tab=buceo&bg=%s" % BG.replace(" ", "%20")).get_data(as_text=True)
    mrow = re.search(r'<tr class="data-row[^"]*" data-bu="ZZBP Unit One" data-n="(\d+)"', page)
    n_page = int(mrow.group(1)) if mrow else -1
    n_list = len(re.findall(r'<tr class="data-row"', t))
    s.check("the list opens for the super admin", r.status_code == 200, r.status_code)
    s.check("its rows are the page's People count for the unit (active, no admin, no demo, no leaver)",
            n_list == n_page == 4, (n_list, n_page))
    BGQ = BG.replace(" ", "%20")
    s.check("the page's number is the independent query's", n_page == H.one(
        a, "SELECT COUNT(*) FROM users WHERE business_group=? AND company=? AND role!='admin' AND left_at IS NULL "
           "AND is_demo=0", (BG, U1)))
    s.check("a leaver, a demo account and an admin are not in it",
            not any(x in t for x in ("ZZBP-GONE", "ZZBP-DEMO", "ZZBP-ADM", "ZZBP-UADM")))
    ids = re.findall(r'<span class="muted small clp-eid">([^<]*)</span>', t)
    s.check("under each name is the Employee ID alone (department and JG have their own columns)",
            all(re.fullmatch(r"ZZBP-[A-Z0-9]+", i.strip()) for i in ids) and len(ids) == 4, ids)
    s.check("ordered by department, then name (Dept A: Ann, Cal, Ceo; Dept B: Bea)",
            [i.strip() for i in ids] == ["ZZBP-P2", "ZZBP-P3", "ZZBP-CEO", "ZZBP-P1"], ids)
    s.check("headed Person, Department, JG, Job title, Calibrator (no BU column)",
            re.findall(r"<th[^>]*>([^<]*)</th>", t)[:5] == ["Person", "Dept", "JG", "Job title", "Calibrator"], re.findall(r"<th[^>]*>([^<]*)</th>", t)[:5])
    s.check("a long job title is clipped with the full words on hover",
            'class="clp-clip" title="A Very Long Job Title For The Clip Check Group Head"' in t)
    s.check("the head names the unit, the count and the BU CEO", 'data-list-title="ZZBP Unit One · 4 people"' in t
            and "ZZ BP Ceo (ZZBP-CEO)" in t, re.findall(r'data-list-[a-z]+="[^"]*"', t)[:4])
    v = su.get(url(U2)).get_data(as_text=True)
    s.check("a unit with no BU CEO says Vacant and offers Set", 'data-list-sub="BU CEO: Vacant"' in v and "Set the BU CEO" in v)
    s.check("the full page is People filtered to the unit", "/admin/users?" in t and "fbu=ZZBP+Unit+One" in t, 0)

    s.section("who may see it (Chris, 2026-10-27: \"all admins can view\")")
    BGURL = "/admin/leaders?tab=buceo&bg=%s" % BG.replace(" ", "%20")
    s.check("a BG admin outside the group gets nothing", oth.get(url(U1)).status_code in (302, 403, 404),
            oth.get(url(U1)).status_code)
    rb = bga.get(url(U1))
    s.check("a BG admin opens the list for their own unit, the same four people",
            rb.status_code == 200 and len(re.findall(r'<tr class="data-row"', rb.get_data(as_text=True))) == 4, rb.status_code)
    s.check("a unit admin opens it for their unit too", uad.get(url(U1)).status_code == 200)
    s.check("...and not for the group's other unit", uad.get(url(U2)).status_code == 404, uad.get(url(U2)).status_code)
    s.check("an employee can't", H.client_as(a, H.one(a, "SELECT id FROM users WHERE employee_id='ZZBP-P1'")).get(url(U1)).status_code in (302, 403, 404))
    s.check("every other list stays the super admin's: a BG admin gets 403 on the 360 list",
            bga.get("/admin/list/f360-rated?fragment=1").status_code == 403)
    bpage = bga.get(BGURL).get_data(as_text=True)
    s.check("a BG admin's page carries the row opener and the list panel",
            'data-list-open="/admin/list/bu-people?' in bpage and 'data-panel="list"' in bpage)
    with a.app.test_request_context("/"):
        aborted = None
        try:
            build(H.one(a, "SELECT id FROM users WHERE employee_id='ZZBP-OADM'"), U1)
        except Exception as e:  # noqa: BLE001
            aborted = getattr(e, "code", repr(e))
        s.check("the builder itself 404s a unit outside the admin's group", aborted == 404, aborted)

    s.section("the row, and Change follows the Roles & access tick")
    s.check("the unit's row carries the opener for the super admin, and its name is a link",
            page.count('data-list-open="/admin/list/bu-people?') >= 2 and 'class="btn-link ld-bu-name"' in page)
    s.check("the page draws the list panel", 'data-panel="list"' in page)
    s.check("the super admin's row has Change and the panel exists", 'data-panel-open="bu-zzbp-unit-one"' in page
            and 'data-panel="bu-zzbp-unit-one"' in page)
    s.check("the list's Change BU CEO opens that same panel", 'data-panel-open="bu-zzbp-unit-one"' in t and "Change BU CEO" in t)
    # the built-in BG admin role: seat tick off by default (View only), then ticked
    def seat_tick(on):
        with a.app.app_context():
            d = a.get_db()
            rid = d.execute("SELECT id FROM admin_roles WHERE builtin='bg'").fetchone()[0]
            d.execute("DELETE FROM admin_role_access WHERE role_id=? AND item IN ('leaders.seat','leaders.unseat')", (rid,))
            if on:
                d.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(rid, "leaders.seat"), (rid, "leaders.unseat")])
            d.commit()
    seat_tick(False)
    def seated():
        return H.rows(a, "SELECT user_id FROM buceo_seats WHERE business_group=? AND company=?", (BG, U2))
    s.check("the built-in BG admin role has no seat tick by default (a new install)",
            "leaders.seat" not in a.role_preset_items("view") and "leaders.seat" not in a.role_preset_items("cycle"))
    pg0 = bga.get(BGURL).get_data(as_text=True)
    s.check("without the tick a BG admin sees no Change or Set, and the sentence says why",
            'data-panel-open="bu-zzbp-unit' not in pg0 and 'data-panel="bu-zzbp-unit' not in pg0
            and "Only the super admin changes these, unless your admin role has Appoint a BU or BG CEO ticked" in pg0)
    s.check("...and the list has no Change BU CEO button (the note shows, without one)",
            "Change BU CEO" not in bga.get(url(U1)).get_data(as_text=True)
            and "clp-bulk-go" not in bga.get(url(U1)).get_data(as_text=True)
            and "Who calibrates this unit." in bga.get(url(U1)).get_data(as_text=True))
    r0 = bga.post("/admin/leaders", data={"csrf_token": "tok", "action": "set_buceo", "bg": BG, "tab": "buceo", "company": U2,
                                          "person_id": str(H.one(a, "SELECT id FROM users WHERE employee_id='ZZBP-P1'"))})
    s.check("...and their seat POST is refused, nothing seated", not seated(), (r0.status_code, seated()))
    seat_tick(True)
    pg1 = bga.get(BGURL).get_data(as_text=True)
    s.check("with the tick the BG admin sees Change / Set for their units and the list's action",
            'data-panel-open="bu-zzbp-unit-one"' in pg1 and "Change BU CEO" in bga.get(url(U1)).get_data(as_text=True)
            and "Only the super admin changes these" not in pg1)
    bga.post("/admin/leaders", data={"csrf_token": "tok", "action": "set_buceo", "bg": BG, "tab": "buceo", "company": U2,
                                     "person_id": str(H.one(a, "SELECT id FROM users WHERE employee_id='ZZBP-P1'"))})
    s.check("...and their seat POST works", len(seated()) == 1, seated())
    with a.app.test_request_context("/"):
        d = a.get_db()
        un_l = build(H.one(a, "SELECT id FROM users WHERE employee_id='ZZBP-UADM'"), U1)
        s.check("a unit admin (never seats a BU CEO) gets the list but no action", len(un_l["rows"]) == 4 and "action" not in un_l)
    seat_tick(False)

    # ------------------------------------------------------------------------------------------------------------
    s.section("calibration panels: the note, the Calibrator column and the panel's own list (Chris, 2026-10-28)")
    PANEL, PANEL2 = "ZZBP Sales panel", "ZZBP Other panel"
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM buceo_seats WHERE business_group=? AND company=?", (BG, U2))   # U2: no BU CEO
        CALID = d.execute("SELECT id FROM users WHERE employee_id='ZZBP-CAL'").fetchone()[0]

        def mkpanel(bg_, name, units, depts):
            pid_ = d.execute("INSERT INTO calib_bu_panels(business_group, company, name, created_by) VALUES (?,?,?,?)",
                             (bg_, units[0], name, CALID)).lastrowid
            d.executemany("INSERT INTO calib_bu_panel_units(panel_id, business_group, company) VALUES (?,?,?)",
                          [(pid_, bg_, u) for u in units])
            gid_ = d.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id, split, created_by, "
                             "panel_id) VALUES (?,?,?,?,100,?,?)", (bg_, units[0], name, CALID, CALID, pid_)).lastrowid
            d.executemany("INSERT INTO calib_bu_group_units(group_id, business_group, company, department) VALUES (?,?,?,?)",
                          [(gid_, bg_, c_, dp_) for c_, dp_ in depts])
            d.commit()
            return pid_
        PID = mkpanel(BG, PANEL, [U1, U2], [(U1, "ZZBP Dept A"), (U2, "ZZBP Dept X")])
        PID2 = mkpanel(BG2, PANEL2, ["ZZBP Other Unit"], [("ZZBP Other Unit", "ZZBP Dept A")])

    def page_n(pat, html_):
        m_ = re.search(pat, html_, re.S)
        return int(m_.group(1)) if m_ else -1
    pg = su.get(BGURL).get_data(as_text=True)
    n_in = {u_: page_n(r'In the <button[^>]*data-list-open="[^"]*co=%s[^"]*"[^>]*>[^<]*</button> panel</td>\s*<td>(?:<span class="ld-pn">)?(\d+)'
                       % u_.replace(" ", "[+%20]"), pg) for u_ in (U1, U2)}
    n_pan = page_n(r'id="bu-panel-%d">.*?</td>\s*<td>(?:<span class="ld-pn">)?(\d+)' % PID, pg)
    n_left = {U2: page_n(r'Vacant</span> in no panel and no BU CEO</td>\s*<td>(?:<span class="ld-pn">)?(\d+)', pg)}
    s.check("the page counts the panel's people per unit (U1 3, U2 2, 1 in none) and 5 in all",
            n_in == {U1: 3, U2: 2} and n_pan == 5 and n_left[U2] == 1, (n_in, n_pan, n_left))
    tu2, tu1 = su.get(url(U2)).get_data(as_text=True), su.get(url(U1)).get_data(as_text=True)
    note2 = re.search(r'<div class="clp-bulk"><span>([^<]*)</span>', tu2).group(1)
    note1 = re.search(r'<div class="clp-bulk"><span>([^<]*)</span>', tu1).group(1)
    exp2 = "%d in %s; nobody calibrates the other %d yet." % (n_in[U2], PANEL, n_left[U2])
    s.check("no BU CEO, some in a panel: the note is the page's counts, and never 'Nobody calibrates this unit yet.'",
            note2 == exp2 and "Nobody calibrates this unit yet." not in tu2 and "Set the BU CEO" in tu2, note2)
    s.check("BU CEO held, some in a panel: 'The BU CEO calibrates the N in no panel. M are in the <panel>.'",
            note1 == "The BU CEO calibrates the 1 person in no panel. %d are in the %s." % (n_in[U1], PANEL), note1)
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE users SET department='ZZBP Dept X' WHERE employee_id='ZZBP-V2'")   # U2 now all in the panel
        d.commit()
        a.bu_groups_forget()
        all_in = build(SU["id"], U2)
        s.check("no BU CEO, everyone in a panel: 'Calibration panels cover everyone here: ...' and the Set button stays",
                all_in["action"]["note"] == "Calibration panels cover everyone here: 3 in %s." % PANEL
                and all_in["action"]["label"] == "Set the BU CEO", all_in["action"])
        d.execute("UPDATE users SET department='ZZBP Dept A' WHERE employee_id='ZZBP-V2'")
        d.commit()
        a.bu_groups_forget()
        ua = build(H.one(a, "SELECT id FROM users WHERE employee_id='ZZBP-UADM'"), U1)
        s.check("a unit admin (no seat right) gets the same note as info, with no action and no button",
                "action" not in ua and ua.get("info") == note1, ua.get("info"))
    uhtml = uad.get(url(U1)).get_data(as_text=True)
    s.check("...and the panel draws it without a button", note1 in uhtml and "clp-bulk-go" not in uhtml)

    s.section("the Calibrator column")
    def chunk(html_, eid):
        return next((c_ for c_ in html_.split('<tr class="data-row"') if ">%s<" % eid in c_ or "%s</span>" % eid in c_), "")
    s.check("a panel person shows the calibrator's name, the panel on hover",
            "ZZ BP Calibrator" in chunk(tu1, "ZZBP-P2") and 'title="ZZ BP Calibrator · %s"' % PANEL in chunk(tu1, "ZZBP-P2"))
    s.check("a person in no panel in a unit with a BU CEO shows the BU CEO, with '(BU CEO)'",
            "ZZ BP Ceo (BU CEO)" in chunk(tu1, "ZZBP-P1"), chunk(tu1, "ZZBP-P1")[-300:])
    tv = su.get(url(U2)).get_data(as_text=True)
    s.check("a panel person in a unit with no BU CEO shows the calibrator", "ZZ BP Calibrator" in chunk(tv, "ZZBP-V3"))
    s.check("a person nobody calibrates (no panel, no BU CEO) shows Vacant in the amber pill",
            'class="clp-pill is-none"' in chunk(tv, "ZZBP-V2") and ">Vacant<" in chunk(tv, "ZZBP-V2"), chunk(tv, "ZZBP-V2")[-300:])
    css = open(os.path.join(H.REPO, "static", "style.css")).read()
    s.check("the pill's colours are the page's Vacant chip's (.ld-chip.is-none)",
            re.search(r"\.ld-chip\.is-none \{ background: (var\(--[\w-]+\)); color: (var\(--[\w-]+\)); \}", css).groups()
            == re.search(r"\.clp-pill\.is-none \{ background: (var\(--[\w-]+\)); color: (var\(--[\w-]+\)); \}", css).groups())
    s.check("the heading is a plain word, so the column gets its own sort and tick-box filter (not a department/BG dimension)",
            "Calibrator" in re.findall(r"<th[^>]*>([^<]*)</th>", tv))

    s.section("a panel's own list (bu-panel-people)")
    def purl(pid, co=None, bg=BG):
        return "/admin/list/bu-panel-people?fragment=1&bg=%s&pid=%s%s" % (bg.replace(" ", "%20"), pid,
                                                                         ("&co=" + co.replace(" ", "%20")) if co else "")
    s.check("the list is registered for every admin who reads Leaders", a.ADMIN_LISTS["bu-panel-people"]["all_admins"] is True)
    rp = su.get(purl(PID))
    tp = rp.get_data(as_text=True)
    s.check("it holds exactly the panel's people, the page's panel count",
            rp.status_code == 200 and len(re.findall(r'<tr class="data-row"', tp)) == n_pan == 5
            and 'data-list-title="%s · 5 people"' % PANEL in tp, (rp.status_code, n_pan))
    s.check("...with the BU column, Department, JG and Calibrator, and every row names the calibrator",
            re.findall(r"<th[^>]*>([^<]*)</th>", tp)[:5] == ["Person", "BU", "Dept", "JG", "Calibrator"]
            and tp.count("ZZ BP Calibrator") >= 5, re.findall(r"<th[^>]*>([^<]*)</th>", tp)[:6])
    s.check("the head names the curve, and Manage panel opens the page's panel", "Curve: " in tp and 'data-panel-open="bp-%d"' % PID in tp
            and "Manage panel" in tp and "#bu-panel-%d" % PID in tp)
    tpc = su.get(purl(PID, U2)).get_data(as_text=True)
    s.check("?co= narrows it to one unit", len(re.findall(r'<tr class="data-row"', tpc)) == n_in[U2] == 2
            and "in " in re.search(r'data-list-sub="([^"]*)"', tpc).group(1), re.search(r'data-list-sub="([^"]*)"', tpc).group(1))
    s.check("an unknown panel is a 404", su.get(purl(99999999)).status_code == 404)
    s.check("a panel of another business group is a 404 (asked under this group)", su.get(purl(PID2)).status_code == 404)
    s.check("a panel asked under the wrong group is a 404", su.get(purl(PID, bg=BG2)).status_code == 404)
    s.check("a BG admin of another group gets nothing", oth.get(purl(PID)).status_code in (302, 403, 404))
    tpu = uad.get(purl(PID)).get_data(as_text=True)
    s.check("a unit admin sees only their unit's people, and no Manage panel",
            len(re.findall(r'<tr class="data-row"', tpu)) == n_in[U1] == 3 and "Manage panel" not in tpu, 0)
    s.check("...and a unit they don't manage is a 404", uad.get(purl(PID, U2)).status_code == 404)
    pg = su.get(BGURL).get_data(as_text=True)
    s.check("the page's panel line, and its 'In the <panel>' lines, open the panel's list",
            re.search(r'<b><button type="button" class="btn-link ld-bu-name" data-list-open="/admin/list/bu-panel-people\?[^"]*pid=%d[^"]*"' % PID, pg)
            and len(re.findall(r'In the <button[^>]*data-list-open="/admin/list/bu-panel-people\?[^"]*pid=%d&amp;co=' % PID, pg)) == 2, 0)

    s.section("falsify: with no panel the note is the old one")
    with a.app.app_context():
        d = a.get_db()
        cleanup_panels = d.execute("SELECT id FROM calib_bu_groups WHERE business_group IN (?,?)", (BG, BG2)).fetchall()
        for (g_,) in cleanup_panels:
            for t_ in ("calib_bu_group_units", "calib_bu_group_people", "calib_bu_group_left"):
                d.execute("DELETE FROM %s WHERE group_id=?" % t_, (g_,))
        d.execute("UPDATE calib_bu_groups SET active=0 WHERE business_group IN (?,?)", (BG, BG2))
        d.commit()
    tn = su.get(url(U2)).get_data(as_text=True)
    s.check("no panel, no BU CEO: 'Nobody calibrates this unit yet.'", "Nobody calibrates this unit yet." in tn
            and "Calibration panels cover" not in tn)
    tn1 = su.get(url(U1)).get_data(as_text=True)
    s.check("no panel, BU CEO held: 'Who calibrates this unit.'", "Who calibrates this unit." in tn1 and "no panel" not in tn1)
    s.check("the Calibrator cell then says '(BU CEO)' or Vacant", "ZZ BP Ceo (BU CEO)" in chunk(tn1, "ZZBP-P2")
            and ">Vacant<" in chunk(tn, "ZZBP-V3"))

    s.section("the front end")
    js = open(os.path.join(H.REPO, "static", "admin.js")).read()
    s.check("admin.js: a click on a control inside the row is the control's own",
            'lo.tagName === "TR" && e.target.closest("a, button' in js)
    s.check("the panel's action is a data-panel-open (the existing handler closes the list and opens the target)",
            'data-panel-open="{{ lst.action.panel }}"' in open(os.path.join(H.REPO, "templates", "_people_list_panel.html")).read())
finally:
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM admin_role_access WHERE item IN ('leaders.seat','leaders.unseat') AND role_id=(SELECT id FROM admin_roles WHERE builtin='bg')")
        cleanup(d)

sys.exit(s.done())
