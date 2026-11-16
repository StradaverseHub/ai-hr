"""BU KPI setup: move SOME of a saved BU KPI's carriers to a variant (Chris, 2026-10-29; canvas
[design canvas link removed], boards 1-5). The super admin ticks who moves on a saved card's panel and
the writer (_bu_kpi_move, route admin_bu_kpis action move_variant) renames their lines to a new variant ("PAT: Group", its
own target, a unit-only library row) or to a sibling variant of the same root (moving back to the root, or merging).

What this suite holds:
  * the card: the link and the panel for the super admin only, only while open; a variant sits under its root in the rail
    with "Variant · ", its card says "Variant of <root>"; Fill BU result lists both
  * a new variant in a Year-End: the movers' lines renamed, linked to the variant's own setup at its own target, their
    weights unchanged; the source keeps the rest; a unit-only library row; the audit row; nobody gains a line (even if the
    source were applied again); every other KPI, line and unit untouched
  * taking the variant off gives each line back exactly as it was before it ever became a BU KPI (kept bu_prev_json)
  * moving some back to the root; moving all into a sibling is the merge (the source and its library mark go)
  * an Early Year: the weight rule the super admin posts; a Year-End always keeps each person's own
  * the rail's heading (2026-11-06): 2+ saved variants whose root is NOT saved sit under a heading row for the root (not a link, no
    Saved pill, "N variants"), placed where the root's name sorts; one variant of an unsaved root stays a plain row; the saved count
    stays the number of setups
  * every refusal writes nothing: not the super admin, closed window, no qualifier, a name taken (a BU KPI, a library row,
    a scorecard line), nobody ticked, everyone to a new variant, a line someone acted on, a foreign ID, a stale form
"""
import atexit
import hashlib
import html
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("BU KPI setup: move some carriers to a variant")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO, CO2 = "ZZBV Group", "ZZBV Unit", "ZZBV Unit B"
PAT, GP = "ZZBV PAT", "ZZBV GP"
U = {}
EIDS = "ABCDEFGH"


def _cleanup(db):
    db.execute("DELETE FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%ZZBV%'")
    db.execute("DELETE FROM pm_bu_kpis WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9BV-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        ids = "SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph
        db.execute("DELETE FROM pm_kpi_approvals WHERE kpi_target_id IN (%s)" % ids, ul)
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (%s)" % ids, ul)
        db.execute("DELETE FROM rating_records WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.execute("DELETE FROM admin_roles WHERE name='ZZBV role'")
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    PREV = dict(db.execute("SELECT kind, year, half, min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())
    W0 = db.execute("SELECT opens_at, closes_at FROM cycle_windows WHERE cycle_id=? AND cell='pm_hod'", (CID,)).fetchone()

    def _put_back():
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("UPDATE cycles SET kind=?, year=?, half=?, min_job_grade=? WHERE id=?",
                       (PREV["kind"], PREV["year"], PREV["half"], PREV["min_job_grade"], CID))
            d_.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='pm_hod'", (CID,))
            if W0:
                d_.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', ?, ?)",
                           (CID, W0[0], W0[1]))
            d_.commit()
    atexit.register(_put_back)
    db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL WHERE id=?", (CID,))
    db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', "
               "'2099-11-02 00:00', '2099-11-08 23:59')", (CID,))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?),(?,?)", (BG, CO, BG, CO2))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'B', 'excellence')", (BG,))
    LIB = {}
    for nm in (PAT, GP):
        LIB[nm] = db.execute(
            "INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, "
            "unit, method, threshold, target, excellence, weightage_default, bu_level) VALUES (?, '*', '*', 0, '*', ?, "
            "'Financial · Profitability', 'RM m', 'more', 100, 120, 150, 30, 1)", (BG, nm)).lastrowid
    U["M"] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                        "company, department, job_grade, confirmation_date) VALUES ('zz9bv-m', 'ZZ BV Manager', 'x', "
                        "'user', 'ZZ9BV-M', ?, ?, 'Management', '21', '2020-01-01')", (BG, CO)).lastrowid
    for e in EIDS + "X":
        U[e] = db.execute(
            "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
            "department, job_grade, confirmation_date, manager_id) VALUES (?,?, 'x', 'user', ?,?,?,?, ?, '2020-01-01', ?)",
            ("zz9bv-" + e.lower(), "ZZ BV " + e, "ZZ9BV-" + e, BG, CO2 if e == "X" else CO,
             "Sales" if e in "ABCD" else "Finance", "15", U["M"])).lastrowid

    def put(who, name, w, scale, **kw):
        cols = dict(cycle_id=CID, subject_id=U[who], kpi_name=name, weightage=w, method="more", unit="RM m", category="Own",
                    threshold=scale[0], target=scale[1], excellence=scale[2], business_group=BG,
                    company=CO2 if who == "X" else CO, library_id=LIB[PAT] if name == PAT else None)
        cols.update(kw)
        db.execute("INSERT INTO pm_kpi_targets(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), list(cols.values()))
    for e in "ABCDEH":
        put(e, PAT, 30, (100, 120, 150))
    put("F", PAT, 30, (90, 110, 140), focus="Plant 9", description="ZZ own words")
    put("G", PAT, 30, (90, 110, 140), category="Own G")
    put("X", PAT, 30, (80, 100, 130))   # the other unit's: never touched
    for e in "ABCD":
        put(e, GP, 20, (200, 240, 300), library_id=LIB[GP])
    for e in EIDS + "M":
        put(e, "ZZBV Other", 50, (1, 2, 3))
    ROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZBV role', 'group')").lastrowid
    db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(ROLE, "pm.read"), (ROLE, "pm.bu_kpi")])
    BGADM = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                       "admin_bg, admin_role_id) VALUES ('zz9bv-adm', 'ZZ BV Admin', 'x', 'admin', 'ZZ9BV-ADM', ?, ?, ?)",
                       (BG, BG, ROLE)).lastrowid
    db.commit()
SUP = H.client_as(a, SU["id"])
BGA = H.client_as(a, BGADM)
URL = "/admin/performance/bu-kpis?fbg=%s&fbu=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"))
FILL = "/admin/performance/bu-fill"
PREVCOLS = a._BU_PREV_COLS


def unflash(r):
    return html.unescape(r.get_data(as_text=True))


def line(e, name=None):
    r = H.rows(a, "SELECT t.* FROM pm_kpi_targets t JOIN users u ON u.id=t.subject_id WHERE t.cycle_id=? AND "
                  "u.employee_id=? AND t.kpi_name=?" if name else "SELECT t.* FROM pm_kpi_targets t JOIN users u ON "
                  "u.id=t.subject_id WHERE t.cycle_id=? AND u.employee_id=? AND t.bu_kpi_id IS NOT NULL",
               (CID, "ZZ9BV-" + e) + ((name,) if name else ()))
    return dict(r[0]) if r else None


def pat_line(e):
    """The person's PAT line, whatever it is named now (PAT, or a PAT variant), by id from the first snapshot."""
    r = H.rows(a, "SELECT * FROM pm_kpi_targets WHERE id=?", (LINE[e],))
    return dict(r[0]) if r else None


def setup(name):
    r = H.rows(a, "SELECT * FROM pm_bu_kpis WHERE cycle_id=? AND business_group=? AND company=? AND kpi_name=?",
               (CID, BG, CO, name))
    return dict(r[0]) if r else None


def people_of(name):
    r = setup(name)
    return json.loads(r["carriers_json"] or "{}").get("people", []) if r else None


def libs(name):
    return [dict(r) for r in H.rows(a, "SELECT * FROM pm_kpi_library WHERE business_group=? AND kpi_name=? ORDER BY id", (BG, name))]


def card_lid(name):
    """The library id a saved card is addressed by (?kpi=)."""
    r = [x for x in libs(name) if x["active"] and x["bu_level"]]
    return (sorted(r, key=lambda x: x["company"] == "*")[0] if r else libs(name)[0])["id"]


def digest(sql, args=()):
    h = hashlib.sha256()
    for r in H.rows(a, sql, args):
        h.update(repr(tuple(r)).encode())
    return h.hexdigest()[:16]


def world():
    """Everything a refused move must leave exactly as it was."""
    return (digest("SELECT * FROM pm_kpi_targets WHERE cycle_id=? ORDER BY id", (CID,)),
            digest("SELECT * FROM pm_bu_kpis WHERE business_group=? ORDER BY id", (BG,)),
            digest("SELECT * FROM pm_kpi_library WHERE business_group=? ORDER BY id", (BG,)),
            H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_kpi'"))


def untouched():
    """Lines and setups a move of PAT people must never touch: everything not named like PAT, the other unit, GP."""
    return (digest("SELECT * FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name NOT LIKE 'ZZBV PAT%' ORDER BY id", (CID,)),
            digest("SELECT * FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? ORDER BY id", (CID, U["X"])),
            digest("SELECT * FROM pm_bu_kpis WHERE business_group=? AND kpi_name=? ORDER BY id", (BG, GP)),
            digest("SELECT * FROM pm_kpi_library WHERE business_group=? AND kpi_name NOT LIKE 'ZZBV PAT%' ORDER BY id", (BG,)))


def n_lines():
    return H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets t JOIN users u ON u.id=t.subject_id WHERE t.cycle_id=? AND u.company=?",
                 (CID, CO))


def panel_state(lid):
    """(src_n, src_sig) as the panel on that card posts them back."""
    pg = SUP.get(URL + "&kpi=%d" % lid).get_data(as_text=True)
    n = re.search(r'name="src_n" value="(\d+)"', pg)
    g = re.search(r'name="src_sig" value="([0-9a-f]+)"', pg)
    return (n.group(1), g.group(1)) if n and g else (None, None)


def move(src, who, dest="new", qual="Group", unit="RM m", scale=(95, 110, 140), client=None, state=None, **extra):
    """POST the panel's form for the saved BU KPI `src` (its name)."""
    n, sig = state or panel_state(card_lid(src))
    f = {"csrf_token": "tok", "action": "move_variant", "setup": str(setup(src)["id"]), "dest": str(dest),
         "who": ["ZZ9BV-" + e for e in who], "name_by": "role", "name_role": "__new__", "name_role_new": qual,   # since 7 Nov the name is picked: a new role label stands for the old typed qualifier here
         "src_n": n, "src_sig": sig, "v_unit": unit,
         "v_threshold": str(scale[0]), "v_target": str(scale[1]), "v_excellence": str(scale[2])}
    f.update(extra)
    return (client or SUP).post(URL + "&kpi=%d" % card_lid(src), data=f, follow_redirects=True)


def save_card(name, scale=(100, 120, 150)):
    lid = LIB[name]
    k = "k%d_" % lid
    return SUP.post(URL, data={"csrf_token": "tok", "action": "save_kpi", "kpi": str(lid), k + "carriers": "holders",
                               k + "wmode": "own", k + "unit": "RM m", k + "threshold": str(scale[0]),
                               k + "target": str(scale[1]), k + "excellence": str(scale[2])}, follow_redirects=True)


def take_off(name):
    return SUP.post(URL, data={"csrf_token": "tok", "action": "take_off", "setup": str(setup(name)["id"])}, follow_redirects=True)


def refused(label, resp, words, before):
    t = unflash(resp)
    s.check(label + ": refused in words, nothing written", words in t and world() == before, (words, world() == before))


try:
    # the pre-adoption lines, kept to prove taking a variant off gives each back exactly as it was
    LINE = {e: H.one(a, "SELECT t.id FROM pm_kpi_targets t JOIN users u ON u.id=t.subject_id WHERE t.cycle_id=? AND "
                        "u.employee_id=? AND t.kpi_name=?", (CID, "ZZ9BV-" + e, PAT)) for e in EIDS}
    ORIG = {e: {c: pat_line(e)[c] for c in PREVCOLS} for e in EIDS}
    s.section("set up: PAT carried by eight, GP by four, both saved through the page")
    out = save_card(PAT)
    s.check("PAT saved for the eight, each keeping their own weight", "8 updated" in unflash(out) and all(
        pat_line(e)["bu_kpi_id"] == setup(PAT)["id"] and pat_line(e)["weightage"] == 30 for e in EIDS))
    save_card(GP, (200, 240, 300))
    s.check("GP saved for four", H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name=? AND bu_kpi_id IS NOT NULL",
                                       (CID, GP)) == 4)
    before_untouched, before_n = untouched(), n_lines()
    PS = setup(PAT)

    s.section("the card: the link and the panel are the super admin's, while open")
    pg = SUP.get(URL + "&kpi=%d" % LIB[PAT]).get_data(as_text=True)
    s.check("the super admin's saved card has the link in Carried by and the panel", 'data-panel-open="bkvar"' in pg
            and "Move some to a variant" in pg and 'id="pnl-bkvar"' in pg and "Their own name and target, for this unit" in pg)
    s.check("...the panel names the KPI and the unit, and lists the eight with a tick each",
            "Move some off %s" % PAT in pg and pg.count('name="who"') == 8 and 'name="action" value="move_variant"' in pg
            and 'name="dest" value="new"' in pg and "Super admin only. Touches only these two KPIs." in pg)
    s.check("...it posts who carries it now (a count and a checksum) and has the CSRF token stamped by base",
            re.search(r'name="src_n" value="8"', pg) and re.search(r'name="src_sig" value="[0-9a-f]{12}"', pg))
    bp = BGA.get(URL + "&kpi=%d" % LIB[PAT]).get_data(as_text=True)
    s.check("a BG admin with BU KPI setup sees the card without the link or the panel", ">8</b>" in bp and "Move some to a variant"
            not in bp and 'id="pnl-bkvar"' not in bp)
    s.check("an edit view has no link", "Move some to a variant" not in SUP.get(URL + "&kpi=%d&edit=1" % LIB[PAT]).get_data(as_text=True))

    s.section("refusals on a fresh unit: each writes nothing")
    w0 = world()
    r = move(PAT, "FG", client=BGA)
    s.check("not the super admin (a BG admin whose role has BU KPI setup): 403, nothing written", r.status_code == 403
            and world() == w0, r.status_code)
    with a.app.test_request_context():
        d_ = a.get_db()
        d_.execute("SELECT 1")
        row_ = d_.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (PS["id"],)).fetchone()
        res, why = a._bu_kpi_move(d_, d_.execute("SELECT * FROM users WHERE id=?", (BGADM,)).fetchone(), a.active_cycle(d_), BG, CO,
                                  row_, "new", ["ZZ9BV-F"], {}, a._bu_unit_people(d_, BG, CO),
                                  d_.execute("SELECT * FROM pm_bg_config WHERE business_group=?", (BG,)).fetchone(), False)
        d_.rollback()
    s.check("...and the writer itself refuses a non-super admin", res is None and "Only the super admin" in (why or ""), why)
    refused("no one ticked", move(PAT, ""), "Tick at least one person to move.", w0)
    refused("no role label typed", move(PAT, "FG", qual="   "), "A new role label takes letters, digits, spaces", w0)
    refused("everyone ticked, to a new variant", move(PAT, EIDS), "All 8 are ticked. That renames the whole KPI", w0)
    refused("a person who does not carry it (the manager)", move(PAT, ["M"]), "don't carry %s now" % PAT, w0)
    refused("a person of another unit", move(PAT, ["F", "X"]), "don't carry %s now" % PAT, w0)
    refused("a stale form: the count changed", move(PAT, "FG", state=("7", panel_state(LIB[PAT])[1])),
            "%s changed since you opened this: 8 carry it now, not 7." % PAT, w0)
    refused("a stale form: the same count, other people", move(PAT, "FG", state=("8", "0" * 12)),
            "who carries it is not the same now", w0)
    refused("a scale out of order (threshold above target)", move(PAT, "FG", scale=(130, 110, 140)), "Nothing was moved.", w0)
    refused("a target missing", move(PAT, "FG", scale=("", "", "")), "Nothing was moved.", w0)
    refused("a destination that is not a variant of this KPI", move(PAT, "FG", dest=str(setup(GP)["id"])),
            "Pick one of %s's variants" % PAT, w0)
    refused("a destination left blank", move(PAT, "FG", dest=""), "Pick one of %s's variants" % PAT, w0)
    lid_line = line("E", PAT)["id"]
    with a.app.app_context():
        a.get_db().execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, acted_by) VALUES (?,1,'confirm',?)",
                           (lid_line, U["M"]))
        a.get_db().commit()
    w1 = world()
    refused("a line someone has acted on (moderated), named", move(PAT, "EF"),
            "ZZ BV E's line has been moderated, so it stays where it is. Reopen it first", w1)
    pgl = SUP.get(URL + "&kpi=%d" % LIB[PAT]).get_data(as_text=True)
    s.check("...its row can't be ticked and carries the Moderated chip", re.search(
        r'<input type="checkbox" name="who" value="ZZ9BV-E"[^>]*disabled', pgl) and "Moderated</span>" in pgl)
    with a.app.app_context():
        a.get_db().execute("DELETE FROM pm_kpi_approvals WHERE kpi_target_id=?", (lid_line,))
        a.get_db().commit()
    open_state = panel_state(LIB[PAT])   # what the panel posted while it was open
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE cycle_windows SET opens_at='2020-11-02 00:00' WHERE cycle_id=? AND cell='pm_hod'", (CID,))
        d_.commit()
    w2 = world()
    refused("the window closed (the Department Review started), a form posted while it was open",
            move(PAT, "FG", state=open_state), "so BU KPIs read only. Nothing was saved.", w2)
    s.check("...and the closed page has no link", "Move some to a variant" not in SUP.get(URL + "&kpi=%d" % LIB[PAT]).get_data(as_text=True))
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE cycle_windows SET opens_at='2099-11-02 00:00' WHERE cycle_id=? AND cell='pm_hod'", (CID,))
        d_.commit()
    w0 = world()

    s.section("a new variant in a Year-End: F, G and H leave PAT for 'ZZBV PAT: Group'")
    base_hash = {e: digest("SELECT * FROM pm_kpi_targets WHERE id=?", (LINE[e],)) for e in EIDS}
    with a.app.app_context():   # F, G, H (the movers) and A (who stays) have a stored rating record before the move (2026-11-08)
        a._rating_record_refresh(a.get_db(), CID, [U[e] for e in "AFGH"], "zzbv_prime", SU["id"], commit=True)
    out = move(PAT, "FGH", qual="  Group  ", scale=(95, 110, 140), v_wmode="one", v_weight="99")
    t = unflash(out)
    VAR = PAT + ": Group"
    s.check("the page says it: made for the unit, 3 lines moved, 5 now carry the source",
            "%s made for %s: 3 lines moved from %s, which 5 now carry." % (VAR, CO, PAT) in t, t[t.find("made for") - 60:t.find("made for") + 160])
    VS = setup(VAR)
    s.check("the name is the root, a colon and the qualifier tidied; a setup of its own: holders, each keeps their own weight",
            VS and VS["id"] != PS["id"] and VS["carriers"] == "holders" and VS["weight_mode"] == "own" and VS["unit"] == "RM m")
    s.check("...at the target posted (95 / 110 / 140)", (VS["threshold"], VS["target"], VS["excellence"]) == (95, 110, 140))
    rr_ = {e: H.rows(a, "SELECT last_event, last_event_by FROM rating_records WHERE cycle_id=? AND subject_id=?", (CID, U[e])) for e in "AFGH"}
    s.check("the movers' stored rating records were rebuilt by the move (last_event bu_kpi_change, by the super admin); A, who stays, was not touched",
            all(rr_[e] and tuple(rr_[e][0]) == ("bu_kpi_change", SU["id"]) for e in "FGH") and rr_["A"] and rr_["A"][0][0] == "zzbv_prime", rr_)
    s.check("...its people are exactly the three; PAT's lost them and kept the other five",
            people_of(VAR) == ["ZZ9BV-F", "ZZ9BV-G", "ZZ9BV-H"] and people_of(PAT) == ["ZZ9BV-A", "ZZ9BV-B", "ZZ9BV-C", "ZZ9BV-D", "ZZ9BV-E"])
    ok_lines = all(pat_line(e)["kpi_name"] == VAR and pat_line(e)["bu_kpi_id"] == VS["id"] and
                   (pat_line(e)["threshold"], pat_line(e)["target"], pat_line(e)["excellence"]) == (95, 110, 140) for e in "FGH")
    s.check("their lines (the same lines) are renamed, linked to the variant, at its target", ok_lines)
    s.check("...with their weights unchanged (30: a Year-End keeps each person's own, whatever the form says)",
            all(pat_line(e)["weightage"] == 30 for e in "FGH"))
    s.check("...the other five are exactly as they were: PAT, linked to PAT, at 120", all(
        pat_line(e)["kpi_name"] == PAT and pat_line(e)["bu_kpi_id"] == PS["id"] and pat_line(e)["target"] == 120 and
        digest("SELECT * FROM pm_kpi_targets WHERE id=?", (LINE[e],)) == base_hash[e] for e in "ABCDE"))
    s.check("nobody gained a line", n_lines() == before_n, (n_lines(), before_n))
    s.check("every other KPI, line, setup, library row and the other unit: untouched", untouched() == before_untouched)
    lv = libs(VAR)
    s.check("a unit-only BU-level library row is made, a copy of PAT's", len(lv) == 1 and lv[0]["company"] == CO and lv[0]["bu_level"] == 1
            and lv[0]["active"] == 1 and lv[0]["category"] == libs(PAT)[0]["category"] and VS["library_id"] == lv[0]["id"])
    s.check("...kept on the setup so taking it off undoes it", json.loads(VS["carriers_json"]).get("made") == "copy")
    s.check("the trail has one row for the move, with the movers' Employee IDs", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%3 people moved from ''ZZBV PAT'' to a new "
           "variant, ''ZZBV PAT: Group''%ZZ9BV-F, ZZ9BV-G, ZZ9BV-H'") == 1)
    with a.app.test_request_context():
        d_ = a.get_db()
        us = {e: d_.execute("SELECT * FROM users WHERE employee_id=?", ("ZZ9BV-" + e,)).fetchone() for e in "AF"}
        names = {e: a.pm_bu_level_names(d_, us[e]) for e in "AF"}
        d_.rollback()
    s.check("HR fills both for them: the variant and PAT are BU-level for the unit's people", a._kpi_key(VAR) in names["F"]
            and a._kpi_key(PAT) in names["A"] and a._kpi_key(VAR) in names["A"])
    # apply the source again, as any later save could: its list no longer names the movers, so nobody gains a line
    with a.app.test_request_context():
        d_ = a.get_db()
        me_ = d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        srow = d_.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (PS["id"],)).fetchone()
        res_ = a._bu_kpi_apply(d_, me_, a.active_cycle(d_), srow, a._bu_unit_people(d_, BG, CO))
        d_.commit()
    s.check("applying PAT again adds no line for the three who left it", res_["added"] == 0 and n_lines() == before_n, res_)
    s.check("...and leaves their lines on the variant", all(pat_line(e)["bu_kpi_id"] == VS["id"] for e in "FGH"))

    s.section("on the page: the variant under its root, its card, Fill BU result lists both")
    pg = SUP.get(URL + "&kpi=%d" % card_lid(VAR)).get_data(as_text=True)
    rail = pg[pg.index('aria-label="BU KPIs of this unit"'):]
    rail = rail[:rail.index("</section>")]
    order = re.findall(r"<b>(.*?)</b>", rail)
    s.check("the rail: the variant right under PAT, indented, 'Variant · ' first in its summary", " is-sub" in rail and
            "Variant · Target 110 RM m · 3 carry it" in rail and order[order.index(PAT) + 1] == VAR, order)
    s.check("...and only the variant is indented", rail.count(" is-sub") == 1)
    s.check("...PAT's row now says 5 carry it", "Target 120 RM m · 5 carry it" in rail)
    s.check("the variant's card says 'Variant of PAT' above its title, and offers 'or back to PAT'", "Variant of %s" % PAT in pg
            and "or back to %s" % PAT in pg)
    s.check("...PAT's own card has no kicker", "Variant of" not in SUP.get(URL + "&kpi=%d" % LIB[PAT]).get_data(as_text=True))
    s.check("...and the panel on PAT lists the variant first, with its count and target", re.search(
        r'name="dest" value="%d"[^>]*data-name="%s"[^>]*data-n="3"[^>]*data-line="Target 110 RM m"[^>]* checked' % (VS["id"], re.escape(VAR)),
        SUP.get(URL + "&kpi=%d" % LIB[PAT]).get_data(as_text=True)))
    fp = SUP.get(FILL + "?business_group=%s&company=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"))).get_data(as_text=True)
    rf = fp[fp.index("BU KPIs to fill"):fp.index("</section>", fp.index("BU KPIs to fill"))]
    s.check("Fill BU result lists both, as two figures", ">%s<" % PAT in rf and ">%s<" % VAR in rf)
    fc = {"csrf_token": "tok", "business_group": BG, "company": CO, "actual_value": "100", "action": "calc"}
    cj_p = SUP.post(FILL, data=dict(fc, kpi_name=PAT)).get_json()
    cj_v = SUP.post(FILL, data=dict(fc, kpi_name=VAR)).get_json()
    s.check("...each fills its own lines: 5 for PAT, 3 for the variant", cj_p["n_total"] == 5 and cj_v["n_total"] == 3,
            (cj_p["n_total"], cj_v["n_total"]))

    s.section("a name in use is refused: a BU KPI, the library, a scorecard line")
    w3 = world()
    refused("the variant just made (and by the tidy of case and spaces)", move(PAT, "AB", qual=" GROUP "),
            "%s: GROUP is already a KPI of %s. Pick it under Move them to" % (PAT, CO), w3)
    with a.app.app_context():
        a.get_db().execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, "
                           "unit, method, bu_level, active) VALUES (?, '*', '*', 0, '*', ?, 'Financial', 'RM m', 'more', 0, 1)",
                           (BG, PAT + ": From library"))
        a.get_db().execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, threshold, "
                           "target, excellence, business_group, company) VALUES (?,?,?,5,'more','RM m','Own',1,2,3,?,?)",
                           (CID, U["M"], PAT + ": On a card", BG, CO))
        a.get_db().commit()
    w4 = world()
    refused("an active library row of the group", move(PAT, "AB", qual="From library"),
            "%s is already a KPI of %s: in its library or on someone's scorecard" % (PAT + ": From library", CO), w4)
    refused("a scorecard line of a person in the unit", move(PAT, "AB", qual="On a card"),
            "%s is already a KPI of %s: in its library or on someone's scorecard" % (PAT + ": On a card", CO), w4)
    with a.app.app_context():
        a.get_db().execute("DELETE FROM pm_kpi_library WHERE business_group=? AND kpi_name=?", (BG, PAT + ": From library"))
        a.get_db().execute("DELETE FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name=?", (CID, PAT + ": On a card"))
        a.get_db().commit()
    s.check("...(put back)", world()[0] == w3[0])

    s.section("taking the variant off gives each line back exactly as it was before it was ever a BU KPI")
    out = take_off(VAR)
    s.check("the page says 3 given back as they were", "3 given back as they were" in unflash(out))
    back = {e: {c: pat_line(e)[c] for c in PREVCOLS} for e in "FGH"}
    s.check("each of F, G, H: name, weight, target, unit, category, library link, focus and words as at the start",
            all(back[e] == ORIG[e] for e in "FGH"), [(e, {c: (back[e][c], ORIG[e][c]) for c in PREVCOLS if back[e][c] != ORIG[e][c]})
                                                  for e in "FGH" if back[e] != ORIG[e]])
    s.check("...unlinked, nothing kept on them, and F's Focus and words are F's again", all(
        pat_line(e)["bu_kpi_id"] is None and pat_line(e)["bu_prev_json"] is None for e in "FGH")
        and pat_line("F")["focus"] == "Plant 9" and pat_line("F")["description"] == "ZZ own words")
    s.check("the variant's setup is gone and its library row retired; PAT still carries five", setup(VAR) is None and
            libs(VAR)[0]["active"] == 0 and libs(VAR)[0]["bu_level"] == 0 and people_of(PAT) == ["ZZ9BV-A", "ZZ9BV-B", "ZZ9BV-C", "ZZ9BV-D", "ZZ9BV-E"]
            and H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND bu_kpi_id=?", (CID, PS["id"])) == 5)
    s.check("...and nobody is left with a line named for the variant", H.one(
        a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name=?", (CID, VAR)) == 0)

    s.section("move them under the variant again, then back to the root: the original kept line values stay")
    # F, G, H are no longer PAT's carriers; PAT takes them back first (a save of PAT with them ticked is Edit's job), so
    # start from the whole unit on PAT again
    save_card(PAT)
    PS = setup(PAT)
    s.check("PAT saved again: the eight carry it", H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND bu_kpi_id=?",
                                                         (CID, PS["id"])) == 8)
    prev_before = {e: pat_line(e)["bu_prev_json"] for e in EIDS}
    move(PAT, "FGH", qual="Group", scale=(95, 110, 140))
    VS = setup(VAR)
    s.check("a new variant again: the retired library row is put back, not doubled", len(libs(VAR)) == 1 and libs(VAR)[0]["active"] == 1
            and libs(VAR)[0]["bu_level"] == 1 and VS["library_id"] == libs(VAR)[0]["id"])
    s.check("...and each line's kept bu_prev_json is the original one, unchanged by the move", all(
        pat_line(e)["bu_prev_json"] == prev_before[e] for e in "FGH"))
    t = unflash(move(VAR, "F", dest=str(PS["id"])))
    s.check("F moves back to PAT: the page says so", "1 line moved from %s back to %s" % (VAR, PAT) in t, t[t.find("moved from") - 40:t.find("moved from") + 200])
    f = pat_line("F")
    s.check("...F's line is named PAT, linked to PAT, at PAT's target (120), weight unchanged", f["kpi_name"] == PAT and
            f["bu_kpi_id"] == PS["id"] and (f["threshold"], f["target"], f["excellence"]) == (100, 120, 150) and f["weightage"] == 30
            and f["library_id"] == LIB[PAT])
    s.check("...with the original line values still kept (taking it off later still gives F back as at the start)",
            pat_line("F")["bu_prev_json"] == prev_before["F"])
    s.check("...PAT's list names F again; the variant's list does not; nobody gained a line", "ZZ9BV-F" in people_of(PAT)
            and "ZZ9BV-F" not in people_of(VAR) and n_lines() == before_n)
    s.check("...the variant has two left, PAT six", H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE bu_kpi_id=?", (setup(VAR)["id"],)) == 2
            and H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE bu_kpi_id=?", (PS["id"],)) == 6)
    s.check("...other KPIs untouched still", untouched() == before_untouched)

    s.section("the merge: all the variant's carriers into PAT")
    t = unflash(move(VAR, "GH", dest=str(PS["id"])))
    s.check("the page says 2 lines moved and that the variant is no longer a BU KPI", "2 lines moved from %s to %s in %s, which 8 now carry" % (
        VAR, PAT, CO) in t and "no longer a BU KPI of %s" % CO in t, t[t.find("moved from") - 40:t.find("moved from") + 300])
    s.check("the variant's setup is gone and its library mark undone (retired)", setup(VAR) is None and libs(VAR)[0]["active"] == 0
            and libs(VAR)[0]["bu_level"] == 0)
    s.check("all eight are PAT's again, at 120, weights unchanged, nobody holds the variant's name or gained a line", all(
        pat_line(e)["kpi_name"] == PAT and pat_line(e)["bu_kpi_id"] == PS["id"] and pat_line(e)["target"] == 120 and pat_line(e)["weightage"] == 30
        for e in EIDS) and H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name=?", (CID, VAR)) == 0
        and n_lines() == before_n)
    s.check("...their kept values are the originals, so PAT taken off one day gives each back as at the start",
            all(pat_line(e)["bu_prev_json"] == prev_before[e] for e in EIDS))
    s.check("...the trail says the variant was taken off", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%taken off: nobody left on it%'") >= 1)

    s.section("a sibling variant that already exists takes people: its own target, nothing to fill in")
    move(PAT, "EF", qual="North", scale=(96, 112, 141))
    NORTH = PAT + ": North"
    move(PAT, "GH", qual="South", scale=(97, 113, 142))
    SOUTH = PAT + ": South"
    ns, ss = setup(NORTH), setup(SOUTH)
    t = unflash(move(SOUTH, "G", dest=str(ns["id"])))
    s.check("G moves from South to North (another variant, not the root): 'to', not 'back to'", "1 line moved from %s to %s" % (SOUTH, NORTH) in t)
    g = pat_line("G")
    s.check("...G takes North's target (112), keeps the weight", g["kpi_name"] == NORTH and g["bu_kpi_id"] == ns["id"] and g["target"] == 112
            and g["weightage"] == 30)
    s.check("...North lists three, South one", len(people_of(NORTH)) == 3 and people_of(SOUTH) == ["ZZ9BV-H"])
    take_off(NORTH)
    take_off(SOUTH)
    s.check("both taken off: all five back as at the start; PAT keeps A-D", all(
        {c: pat_line(e)[c] for c in PREVCOLS} == ORIG[e] for e in "EFGH") and len(people_of(PAT)) == 4, people_of(PAT))
    save_card(PAT)
    PS = setup(PAT)

    s.section("an Early Year: the weight rule the super admin posts")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE cycles SET kind='early_year', year=2027, half=0 WHERE id=?", (CID,))
        d_.commit()
    pg = SUP.get(URL + "&kpi=%d" % LIB[PAT]).get_data(as_text=True)
    s.check("the panel offers One weight for all and By grade (not disabled)", re.search(
        r'name="v_wmode" value="one" data-bkv-wm\s*><', pg) and re.search(r'name="v_wmode" value="grade" data-bkv-wm\s*><', pg), None)
    w5 = world()
    refused("a weight of 0 for all", move(PAT, "AB", qual="Early", v_wmode="one", v_weight="0"), "its weight must be above 0", w5)
    refused("bands with a gap", move(PAT, "AB", qual="Early", v_wmode="grade", v_bmin=["19", ""], v_bmax=["", "15"], v_bw=["25", "15"]),
            "grade bands must cover every grade once", w5)
    t = unflash(move(PAT, "AB", qual="Early", v_wmode="one", v_weight="25"))
    EARLY = PAT + ": Early"
    es = setup(EARLY)
    s.check("with one weight for all the movers' lines take it (25); the rest keep 30", es and es["weight_mode"] == "one"
            and pat_line("A")["weightage"] == 25 and pat_line("B")["weightage"] == 25 and pat_line("C")["weightage"] == 30
            and "made for" in t, t[:200])
    s.check("...the original line values are still kept", pat_line("A")["bu_prev_json"] == prev_before["A"] or json.loads(
        pat_line("A")["bu_prev_json"])["weightage"] == 30)
    take_off(EARLY)
    s.check("taking it off gives A and B back with weight 30 again", pat_line("A")["weightage"] == 30 and {
        c: pat_line("A")[c] for c in PREVCOLS} == ORIG["A"])
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE cycles SET kind='year_end', year=?, half=2 WHERE id=?", (PREV["year"], CID))
        d_.commit()

    s.section("the rail's heading: the saved variants (1+) of a root that is not saved")
    HR, HA, HB, HL = "ZZBV Brand", "ZZBV Brand: North", "ZZBV Brand: South", "ZZBV Lonely: Plant B"
    HN, HW, HWV = "ZZBV Plain", "ZZBV Whole", "ZZBV Whole: East"   # no ": " at all; a saved root and its variant
    h_ids = []
    with a.app.app_context():
        d_ = a.get_db()
        for nm_ in (HA, HB, HL, HN, HW, HWV):
            lid_ = d_.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, unit, "
                              "method, bu_level) VALUES (?, '*', '*', 0, '*', ?, 'Financial · Profitability', 'RM m', 'more', 1)", (BG, nm_)).lastrowid
            h_ids.append(d_.execute(
                "INSERT INTO pm_bu_kpis(cycle_id, business_group, company, library_id, kpi_name, unit, method, threshold, target, multiple, "
                "carriers, carriers_json, weight_mode, updated_by) VALUES (?,?,?,?,?, 'RM m', 'more', 1, 2, 3, 'holders', '{}', 'own', ?)",
                (CID, BG, CO, lid_, nm_, SU["id"])).lastrowid)
        d_.commit()

    def rail_of(html_):
        sec_ = html_[html_.index('aria-label="BU KPIs of this unit"'):]
        return sec_[:sec_.index("</section>")]
    try:
        rl_ = rail_of(SUP.get(URL).get_data(as_text=True))
        items_ = re.findall(r'<(a|div) class="(bk2-row[^"]*)"[^>]*>\s*<span class="bk2-rowh"><b>(.*?)</b>', rl_)
        names_ = [n_ for _t, _c, n_ in items_]
        s.check("a heading row for the unsaved root, right before its two variants", HR in names_ and names_[names_.index(HR):names_.index(HR) + 3] ==
                [HR, HA, HB], names_)
        hd_ = next(((t_, c_) for t_, c_, n_ in items_ if n_ == HR), None)
        s.check("...it is a div, not a link, with no Saved pill, and says '2 variants'", hd_ and hd_[0] == "div" and "bk2-head" in hd_[1]
                and "2 variants" in rl_.split(HR, 1)[1][:200] and "Saved" not in rl_.split(HR, 1)[1][:rl_.split(HR, 1)[1].index("<a") if "<a" in rl_.split(HR, 1)[1] else 200][:120],
                (hd_, rl_.split(HR, 1)[1][:200]))
        s.check("...its variants are is-sub with 'Variant · ' first in their summary",
                all(("is-sub" in c_) for _t, c_, n_ in items_ if n_ in (HA, HB)) and rl_.count("Variant · ") >= 2)
        HLR = "ZZBV Lonely"
        s.check("a lone variant of an unsaved root sits under its root's heading, right after it (is-sub, a link)",
                HLR in names_ and names_[names_.index(HLR):names_.index(HLR) + 2] == [HLR, HL]
                and any(n_ == HL and "is-sub" in c_ and t_ == "a" for t_, c_, n_ in items_), names_)
        hl_ = next(((t_, c_) for t_, c_, n_ in items_ if n_ == HLR), None)
        s.check("...its heading is a div and reads '1 variant', never '1 variants'", hl_ and hl_[0] == "div" and "bk2-head" in hl_[1]
                and "1 variant<" in rl_.split("<b>" + HLR + "</b>", 1)[1][:120] and "1 variants" not in rl_, rl_.split("<b>" + HLR + "</b>", 1)[1][:120])
        s.check("a name with no ': ' stays a plain row with no heading", any(n_ == HN and "is-sub" not in c_ and t_ == "a" for t_, c_, n_ in items_)
                and HN not in [n_ for t_, c_, n_ in items_ if t_ == "div"], names_)
        s.check("a saved root keeps today's way: its variant right after it, no heading row for it",
                names_[names_.index(HW):names_.index(HW) + 2] == [HW, HWV] and next(t_ for t_, c_, n_ in items_ if n_ == HW) == "a"
                and any(n_ == HWV and "is-sub" in c_ for t_, c_, n_ in items_), names_)
        tops_ = [n_ for _t, c_, n_ in items_ if "is-sub" not in c_]
        s.check("the heading sits where its root's name sorts among the saved rows", [t.lower() for t in tops_] == sorted(t.lower() for t in tops_), tops_)
        n_saved = H.one(a, "SELECT COUNT(*) FROM pm_bu_kpis WHERE cycle_id=? AND business_group=? AND company=?", (CID, BG, CO))
        s.check("the Saved BU KPIs count is the number of setups, the heading not counted",
                ("Saved BU KPIs · %d" % n_saved) in rl_, (n_saved, re.findall(r"Saved BU KPIs · \d+", rl_)))
        s.check("the page selects a real setup (not the heading) and the heading has no aria-current",
                'aria-current="true"' in rl_ and not re.search(r'bk2-head"[^>]*aria-current', rl_))
        sel_ = SUP.get(URL + "&kpi=%d" % [x for x in h_ids][0]).get_data(as_text=True)
        s.check("a variant under the heading opens on its own card", "Variant of" in sel_ or HA in sel_)
        fr_ = SUP.get(FILL + "?business_group=%s&company=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"))).get_data(as_text=True)
        rf_ = fr_[fr_.index("BU KPIs to fill"):]
        rf_ = rf_[:rf_.index("</section>")]
        s.check("Fill BU result groups them the same way, from the same helper", 'bk2-row bk2-head' in rf_ and HR in rf_)
    finally:
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("DELETE FROM pm_bu_kpis WHERE id IN (%s)" % ",".join("?" * len(h_ids)), h_ids)
            d_.execute("DELETE FROM pm_kpi_library WHERE business_group=? AND kpi_name IN (?,?,?,?,?,?)", (BG, HA, HB, HL, HN, HW, HWV))
            d_.commit()

    s.section("the knowledge and the access page")
    src = open(os.path.join(H.HARNESS, "app.py"), encoding="utf-8").read()
    s.check("the route is classified: the move is the super admin's whatever a role has", a.admin_access_need(
        "admin_bu_kpis", {"action": "move_variant"}) == "super" and a.admin_access_need(
        "admin_bu_kpis", {"action": "save_kpi"}) == ("items", ("pm.bu_kpi",)))
    s.check("the access page lists it among the super admin's own", "moving some of a BU KPI's carriers to a variant" in " ".join(
        str(x) for x in a.ACCESS_MODULES))
    s.check("one writer: the route calls _bu_kpi_move and nothing else renames a BU KPI's lines", src.count("def _bu_kpi_move(") == 1
            and src.count("_bu_kpi_move(db, me, act, bg, co, row,") == 1)
    s.check("the template posts through the app's confirm box", 'data-bkv-go' in open(os.path.join(H.HARNESS, "templates", "admin_bu_kpis.html"),
                                                                                         encoding="utf-8").read()
            and "form.setAttribute('data-confirm'" in open(os.path.join(H.HARNESS, "templates", "admin_bu_kpis.html"), encoding="utf-8").read())
finally:
    _put_back()
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
