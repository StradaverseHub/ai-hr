"""Reorder a person's KPI lines on the admin person page (Chris, 2026-11-08, canvas [design canvas link removed]:
"yes, as drawn"): `pm_kpi_targets.seq` is the position an admin gave a line, and the new order shows everywhere their KPIs are listed.

What this suite holds (the SERVER refuses; the page only hides the button):
  * the column: `seq INTEGER`, NULL for every line nobody reordered; a never-reordered person reads by id as before
  * the ONE writer, `_pm_kpi_reorder`, through its route (action=reorder on admin_person_kpi, the token in the FORM): `seq` is 1..n in the
    order sent, the flash is "KPI order saved for <name>.", the audit row (action pm_kpi_reorder, target the person) names the old and the
    new order by KPI name and id, and nothing else changes: no weight, target, result or moderator, no email, no redo
  * the order comes back everywhere: the admin's `_person_kpis` and page, the employee's check-in lines (`review_state`, which keeps the
    heaviest-first order for a person never reordered), the line manager's view, the KPI lines download, the calibration KPI report
  * it refuses, each falsified by hand (the guard broken, the test watched to fail, the guard restored; see the report): an id set that is not
    exactly this person's lines in this cycle (missing, extra, someone else's, repeated, not a number); fewer than 2 lines; a released
    result ("Their result is released, so their KPI order is final."); an admin whose role holds Edit but not Reorder; a person outside the
    admin's scope; a cycle that is not the active one; a post with no token
  * a line added after a reorder comes last; a copy to another cycle carries `seq`
  * the access item `pm.kpi_reorder`: in ADMIN_ITEMS right after Edit a KPI line, Run the cycle and Everything carry it and View only does not,
    classified in ADMIN_ACCESS_MAP, offered on Roles & access; the one-time backfill ticks it on every role holding Edit a KPI line and
    never again (an untick stays after the schema step runs again)
  * the page: Reorder beside Add a KPI for a super admin with 2+ lines; alone (with its own words) for a role with Reorder and not Add; no
    button for a role with Edit only, a View only role, fewer than 2 lines, a released result or a past cycle; the released line reads
    "added, changed, reordered or deleted"; the rows carry the grip, the arrows and the reorder bar's markup and the script loads
  * a lint: no read that lists one person's KPI lines ends in a bare `ORDER BY id` / `t.id` (the allowlist gives each kept one its reason)
"""
import ast
import html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Reorder a person's KPI lines: one order, everywhere")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO, BG2 = "ZZRO Group", "ZZRO Unit", "ZZRO Other Group"
DEPT = "ZZRO Dept"
NAMES = ["ZZRO Alpha", "ZZRO Bravo", "ZZRO Charlie", "ZZRO Delta", "ZZRO Echo"]
WEIGHTS = [10, 40, 20, 5, 25]          # Bravo is the heaviest: the check-in has always listed the heaviest first
U, L, ROLES = {}, {}, {}


def ctx(fn):
    with a.app.test_request_context("/"):
        d = a.get_db()
        return fn(d)


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9RO-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM result_releases WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_kpi_approvals WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s))" % ph, ul)
        db.execute("DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s))" % ph, ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM admin_companies WHERE admin_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    for rid in [r[0] for r in db.execute("SELECT id FROM admin_roles WHERE name LIKE 'ZZRO %'")]:
        db.execute("DELETE FROM admin_role_access WHERE role_id=?", (rid,))
        db.execute("DELETE FROM admin_roles WHERE id=?", (rid,))
    db.execute("DELETE FROM pm_kpi_targets WHERE cycle_id IN (SELECT id FROM cycles WHERE code='ZZRO-OLD')")
    db.execute("DELETE FROM cycles WHERE code IN ('ZZRO-OLD', 'ZZRO-NEXT')")
    db.execute("DELETE FROM pm_kpi_library WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM pm_bg_config WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG, BG2))
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG2, CO))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG2,))
    L["lib"] = db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, "
                          "description, unit, method, bu_level, active) VALUES (?, '*', '*', 0, '*', 'ZZRO Library KPI', "
                          "'Business · Revenue', 'words', 'RM', 'more', 0, 1)", (BG,)).lastrowid

    def mk(eid, name, bg=BG, mgr=None):
        return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                          "department, job_title, job_grade, confirmation_date, manager_id) VALUES (?,?, 'x', 'user', ?,?,?,?, "
                          "'ZZ Analyst', '14', '2020-01-01', ?)", (eid.lower(), name, eid, bg, CO, DEPT, mgr)).lastrowid
    U["M"] = mk("ZZ9RO-M", "ZZ RO Manager")
    U["P"] = mk("ZZ9RO-P", "ZZ RO Person", mgr=U["M"])       # five lines
    U["Q"] = mk("ZZ9RO-Q", "ZZ RO Colleague", mgr=U["M"])    # five lines of their own: "someone else's id"
    U["R"] = mk("ZZ9RO-R", "ZZ RO Solo", mgr=U["M"])         # one line: nothing to reorder
    U["X"] = mk("ZZ9RO-X", "ZZ RO Elsewhere", bg=BG2)        # another business group, three lines

    def put(uid, name, w, bg=BG, rates=(10, 20, 30, 40, 50)):
        t = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, rate2, rate3, "
                       "rate4, rate5, business_group, company, department) VALUES (?,?,?,?, 'more', '%', 'Own', ?,?,?,?,?, ?,?,?)",
                       (CID, uid, name, w) + tuple(rates) + (bg, CO, DEPT)).lastrowid
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (t, U["M"]))
        return t
    for who in ("P", "Q"):
        L[who] = [put(U[who], n, w) for n, w in zip(NAMES, WEIGHTS)]
    L["R"] = [put(U["R"], "ZZRO Only", 100)]
    L["X"] = [put(U["X"], n, w, bg=BG2) for n, w in zip(NAMES[:3], (50, 30, 20))]
    # admin roles: Edit only, Reorder only, Reorder + Add, View only; and a Reorder-only admin of ANOTHER group
    items = {"E": ["pm.read", "people.read", "pm.kpi_edit"], "R": ["pm.read", "people.read", "pm.kpi_reorder"],
             "RA": ["pm.read", "people.read", "pm.kpi_reorder", "pm.kpi_add"], "V": ["pm.read", "people.read"]}
    for k, its in items.items():
        ROLES[k] = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES (?, 'group')", ("ZZRO role " + k,)).lastrowid
        db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(ROLES[k], i) for i in its])
    for k, bg in (("E", BG), ("R", BG), ("RA", BG), ("V", BG), ("O", BG2)):
        U["adm" + k] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg, "
                                  "admin_role_id) VALUES (?,?, 'x', 'admin', ?,?,?,?)",
                                  ("zz9ro-adm" + k.lower(), "ZZ RO Admin " + k, "ZZ9RO-ADM" + k, bg, bg, ROLES["R" if k == "O" else k])
                                  ).lastrowid
    db.execute("INSERT INTO cycles(code, name, is_active) VALUES ('ZZRO-OLD', 'ZZRO old cycle', 0)")
    OLD = db.execute("SELECT id FROM cycles WHERE code='ZZRO-OLD'").fetchone()[0]
    db.commit()
SUP = H.client_as(a, SU["id"])
CL = {k: H.client_as(a, U["adm" + k]) for k in ("E", "R", "RA", "V", "O")}
URL = {k: "/admin/users/%d/kpi" % U[k] for k in ("P", "Q", "R", "X")}


def say(r):
    return html.unescape(r.get_data(as_text=True))


def flash(r):
    """The flash(es) a response carries, as words: what the admin would read."""
    return " | ".join(re.findall(r'<div class="flash flash-\w+"[^>]*>(.*?)</div>', say(r), re.S)) or "(no flash)"


def seqs(who="P"):
    return {r[0]: r[1] for r in H.rows(a, "SELECT id, seq FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (CID, U[who]))}


def snapshot(who="P"):
    """Every column of the person's lines but seq: reordering must leave all of it alone."""
    return [tuple(r) for r in H.rows(
        a, "SELECT id, kpi_name, weightage, method, unit, category, rate1, rate2, rate3, rate4, rate5, threshold, target, status, "
           "library_id, focus, bu_kpi_id, updated_at FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? ORDER BY id", (CID, U[who]))]


def post(client, who, order, **kw):
    d = {"csrf_token": "tok", "action": "reorder", "order": ",".join(str(x) for x in order) if not isinstance(order, str) else order}
    d.update(kw)
    return client.post(URL[who], data=d, follow_redirects=True)


def n_log(who="P"):
    return H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_kpi_reorder' AND target_user_id=?", (U[who],))


def n_mail():
    return H.one(a, "SELECT COUNT(*) FROM email_outbox")


def n_notes():
    try:
        return H.one(a, "SELECT COUNT(*) FROM redo_notes")
    except Exception:
        return None


def person_page(client, who="P", extra=""):
    r = client.get("/admin/users/%d?tab=performance%s" % (U[who], extra))
    return r.status_code, say(r)


def names_in_order(who="P"):
    """The person's lines as _person_kpis lists them: [(n, name)]."""
    def f(d):
        p = d.execute("SELECT * FROM users WHERE id=?", (U[who],)).fetchone()
        rows, _summ = a._person_kpis(d, p, CID, True, detail=True)
        return [(r["n"], r["name"]) for r in rows]
    return ctx(f)


def checkin_names(who="P"):
    return ctx(lambda d: [t["kpi_name"] for t in a.review_state(d, d.execute("SELECT * FROM users WHERE id=?", (U[who],)).fetchone())["targets"]])


def export_names(who="P"):
    r = SUP.get("/admin/performance/export.csv")
    recs = a._xlsx_records(r.get_data())
    eid = "ZZ9RO-" + who
    return [rec.get("kpi") for rec in recs if str(rec.get("employee id") or "").strip() == eid]


def first_seen(text, names=NAMES):
    """The KPI names in the order each first appears in a page or fragment."""
    pos = {n: text.find(n) for n in names}
    return [n for n, _p in sorted(((n, p) for n, p in pos.items() if p >= 0), key=lambda x: x[1])]


HEAVY_FIRST = [n for _w, n in sorted(zip(WEIGHTS, NAMES), key=lambda x: (-x[0], NAMES.index(x[1])))]
try:
    # -------------------------------------------------------------------------------------------------------------
    s.section("The column, and a person nobody reordered")
    cols = {r[1]: r for r in H.rows(a, "PRAGMA table_info(pm_kpi_targets)")}
    s.check("pm_kpi_targets.seq is an INTEGER, nullable, with no default", "seq" in cols and cols["seq"][2].upper() == "INTEGER"
            and not cols["seq"][3] and cols["seq"][4] is None, cols.get("seq"))
    s.check("no index on it (nothing filters on seq)", not [r for r in H.rows(a, "PRAGMA index_list(pm_kpi_targets)")
                                                          if "seq" in " ".join(x[2] for x in H.rows(a, "PRAGMA index_info(%s)" % r[1]))])
    s.check("every line starts with seq NULL", set(seqs().values()) == {None}, seqs())
    s.check("the admin's list reads by id as it always did: numbers 1..5 in the order the lines were made",
            names_in_order() == list(zip(range(1, 6), NAMES)), names_in_order())
    s.check("the employee's check-in keeps its own order for a person never reordered: heaviest weight first",
            checkin_names() == HEAVY_FIRST, checkin_names())
    s.check("the constants: one rule for the lines, an aliased one, and the check-in's two weight-first forms",
            a.PM_LINE_ORDER == "(seq IS NULL), seq, id" and a.PM_LINE_ORDER_T == "(t.seq IS NULL), t.seq, t.id"
            and "weightage DESC" in a.PM_LINE_ORDER_W and "weightage DESC" in a.PM_LINE_ORDER_TW)

    # -------------------------------------------------------------------------------------------------------------
    s.section("The writer through its route: seq 1..n, the flash, the audit row, and nothing else changed")
    new = [L["P"][i] for i in (3, 0, 4, 2, 1)]       # Delta, Alpha, Echo, Charlie, Bravo
    new_names = [NAMES[i] for i in (3, 0, 4, 2, 1)]
    before, mail0, notes0, logs0 = snapshot(), n_mail(), n_notes(), n_log()
    r = post(SUP, "P", new)
    s.check("the super admin's save answers on the Performance tab with the flash in the official name",
            r.status_code == 200 and "KPI order saved for ZZ RO Person." in flash(r), r.status_code)
    s.check("seq is 1..5 in the order sent, on this person's lines only", [seqs()[i] for i in new] == [1, 2, 3, 4, 5], seqs())
    s.check("another person's lines are untouched (still NULL)", set(seqs("Q").values()) == {None})
    s.check("no weight, target, scale, status, library link or time changed on any line (only seq did)", snapshot() == before)
    s.check("the audit row: one pm_kpi_reorder, the person as its target, the cycle, the old order and the new by name and id",
            n_log() == logs0 + 1 and all(
                x in (H.one(a, "SELECT detail FROM activity_log WHERE action='pm_kpi_reorder' AND target_user_id=? ORDER BY id DESC LIMIT 1",
                            (U["P"],)) or "") for x in ["Was: 1 %s (#%d)" % (NAMES[0], L["P"][0]), "Now: 1 %s (#%d)" % (new_names[0], new[0]),
                                                 "5 %s (#%d)" % (new_names[4], new[4])]),
            H.rows(a, "SELECT detail FROM activity_log WHERE action='pm_kpi_reorder' ORDER BY id DESC LIMIT 1"))
    s.check("the audit log words it (Reordered a person's KPI lines), the actor is the admin",
            a.action_label("pm_kpi_reorder") == "Reordered a person's KPI lines"
            and H.one(a, "SELECT user_id FROM activity_log WHERE action='pm_kpi_reorder' ORDER BY id DESC LIMIT 1") == SU["id"])
    s.check("no email was queued and no redo note was made (only the order changed)", n_mail() == mail0 and n_notes() == notes0,
            (n_mail(), mail0, n_notes(), notes0))
    mid = H.one(a, "SELECT COUNT(*) FROM activity_log WHERE target_user_id=? AND action LIKE '%redo%'", (U["P"],))
    s.check("...and nothing in the trail says redo", mid == 0, mid)

    s.section("The new order shows everywhere their KPIs are listed")
    s.check("the admin's list (_person_kpis): numbered 1..5 in the new order", names_in_order() == list(zip(range(1, 6), new_names)), names_in_order())
    code, pg = person_page(SUP)
    ids_in_page = [int(m) for m in re.findall(r'<div class="pp-krow" id="kpi-(\d+)">', pg)]
    s.check("the admin's page draws the rows in the new order", ids_in_page == new, ids_in_page)
    s.check("the employee's check-in lines (review_state): the new order, not heaviest first", checkin_names() == new_names, checkin_names())
    s.check("the KPI lines download: the person's rows in the new order", export_names() == new_names, export_names())
    rep = SUP.get("/calibration/subject/%d/kpi-report" % U["P"])
    s.check("the calibration KPI report (a calibrator's evidence) lists them in the new order",
            rep.status_code == 200 and first_seen(say(rep)) == new_names, (rep.status_code, first_seen(say(rep))))
    mgr = H.client_as(a, U["M"])
    tm = mgr.get("/performance/team/%d" % U["P"])
    s.check("the line manager's moderation page for the person lists them in the new order",
            tm.status_code == 200 and first_seen(say(tm)) == new_names, (tm.status_code, first_seen(say(tm))))
    one = ctx(lambda d: [r[0] for r in d.execute("SELECT kpi_name FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? ORDER BY "
                                                 + a.PM_LINE_ORDER, (CID, U["P"]))])
    s.check("the one rule, used on its own, gives the same order", one == new_names, one)

    s.section("A second save replaces the first; a save of the same order is accepted and changes nothing")
    again = list(reversed(new))
    r = post(SUP, "P", again)
    s.check("a new order is saved over the old", "KPI order saved" in flash(r) and [seqs()[i] for i in again] == [1, 2, 3, 4, 5], seqs())
    s.check("...and its audit row names the previous order as Was", "Was: 1 %s" % new_names[0] in (H.one(
        a, "SELECT detail FROM activity_log WHERE action='pm_kpi_reorder' AND target_user_id=? ORDER BY id DESC LIMIT 1", (U["P"],)) or ""))
    # put P back to a known order for the refusals below
    post(SUP, "P", L["P"])
    s.check("back to the order the lines were made in", [seqs()[i] for i in L["P"]] == [1, 2, 3, 4, 5])

    # -------------------------------------------------------------------------------------------------------------
    s.section("It refuses a set of ids that is not exactly this person's lines (nothing is written, the page says so)")
    base_seq, logs0, mail0 = seqs(), n_log(), n_mail()

    def refused(label, order, who="P", client=None, words="not the same list of KPI lines"):
        r = post(client or SUP, who, order)
        ok = (words in flash(r) and "KPI order saved" not in flash(r) and seqs(who) == (base_seq if who == "P" else seqs(who))
              and n_log(who) == logs0 and n_mail() == mail0)
        s.check(label, ok, flash(r) if not ok else "")
    refused("one line missing", L["P"][:-1])
    refused("an extra id that is no line at all", L["P"] + [999999])
    refused("a line of someone else's (Q's), in place of one of theirs", L["P"][:-1] + [L["Q"][0]])
    refused("a repeated id (one line twice, one missing)", [L["P"][0]] + L["P"][:-1])
    refused("a repeated id on top of the whole set", L["P"] + [L["P"][0]])
    refused("an id that is not a number", L["P"][:-1] + ["x1"])
    refused("no ids at all", "")
    s.check("every one of those left the order as it was, in the page too",
            [int(m) for m in re.findall(r'<div class="pp-krow" id="kpi-(\d+)">', person_page(SUP)[1])] == L["P"])

    s.section("Fewer than 2 lines")
    r = post(SUP, "R", L["R"])
    s.check("one line: refused in words, seq stays NULL, no audit row",
            "fewer than 2 KPI lines" in flash(r) and "KPI order saved" not in flash(r) and set(seqs("R").values()) == {None}
            and n_log("R") == 0, flash(r))
    code, pg = person_page(SUP, "R")
    s.check("...and the page offers no Reorder for one line", code == 200 and 'id="rord-open"' not in pg and 'id="rord-bar"' not in pg)

    s.section("A released result")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT OR REPLACE INTO result_releases(cycle_id, subject_id, kind) VALUES (?,?, 'pm')", (CID, U["P"]))
        d_.commit()
    r = post(SUP, "P", list(reversed(L["P"])))
    s.check("their KPI order is final: the exact words, nothing written", "Their result is released, so their KPI order is final." in flash(r)
            and seqs() == base_seq and n_log() == logs0, flash(r))
    code, pg = person_page(SUP)
    s.check("the page: no Reorder button, no bar, and the final line says reordered",
            code == 200 and 'id="rord-open"' not in pg and 'id="rord-bar"' not in pg
            and "so nothing here can be added, changed, reordered or deleted." in pg)
    s.check("the same test as the page's: setup_released_at says it is out", ctx(lambda d: a.setup_released_at(d, U["P"], CID, "pm")) is not None)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM result_releases WHERE subject_id=?", (U["P"],))
        d_.commit()
    s.check("released and put back: it saves again", "KPI order saved" in flash(post(SUP, "P", L["P"])))

    s.section("An admin without Reorder, a person outside their scope, a past cycle, no token")
    base_seq, logs0 = seqs(), n_log()
    shuffled = [L["P"][i] for i in (4, 3, 2, 1, 0)]
    r = CL["E"].post(URL["P"], data={"csrf_token": "tok", "action": "reorder", "order": ",".join(map(str, shuffled))})
    s.check("a role with Edit a KPI line and no Reorder is refused by the route (403) and nothing is written",
            r.status_code == 403 and seqs() == base_seq and n_log() == logs0, r.status_code)
    r = CL["V"].post(URL["P"], data={"csrf_token": "tok", "action": "reorder", "order": ",".join(map(str, shuffled))})
    s.check("a View only role is refused too", r.status_code == 403 and seqs() == base_seq, r.status_code)
    why = ctx(lambda d: a._pm_kpi_reorder(d, d.execute("SELECT * FROM users WHERE id=?", (U["admE"],)).fetchone(), U["P"], CID, shuffled))
    s.check("the writer refuses it by itself too (a caller that skipped the route)", why and "do not have access" in why and seqs() == base_seq, why)
    r = CL["R"].post(URL["P"], data={"csrf_token": "tok", "action": "reorder", "order": ",".join(map(str, shuffled))}, follow_redirects=True)
    s.check("a role holding Reorder alone saves inside its own group", "KPI order saved for ZZ RO Person." in flash(r)
            and [seqs()[i] for i in shuffled] == [1, 2, 3, 4, 5], flash(r))
    post(SUP, "P", L["P"])
    base_seq, logs0 = seqs(), n_log()
    xs = list(reversed(L["X"]))
    r = CL["R"].post(URL["X"], data={"csrf_token": "tok", "action": "reorder", "order": ",".join(map(str, xs))})
    s.check("a person of ANOTHER business group: 403 for the group's admin, nothing written", r.status_code == 403
            and set(seqs("X").values()) == {None}, r.status_code)
    why = ctx(lambda d: a._pm_kpi_reorder(d, d.execute("SELECT * FROM users WHERE id=?", (U["admR"],)).fetchone(), U["X"], CID, xs))
    s.check("...and the writer refuses it by itself (outside what the admin manages)", why and "outside what you manage" in why
            and set(seqs("X").values()) == {None}, why)
    r = CL["O"].post(URL["X"], data={"csrf_token": "tok", "action": "reorder", "order": ",".join(map(str, xs))}, follow_redirects=True)
    s.check("the other group's own admin, holding Reorder, can", "KPI order saved" in flash(r) and [seqs("X")[i] for i in xs] == [1, 2, 3], flash(r))
    why = ctx(lambda d: a._pm_kpi_reorder(d, d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone(), U["P"], OLD, L["P"]))
    s.check("a cycle that is not the active one is refused (a past cycle's lines are read only)",
            why and "active cycle" in why and seqs() == base_seq, why)
    r = SUP.post(URL["P"], data={"action": "reorder", "order": ",".join(map(str, shuffled))}, follow_redirects=False)
    s.check("a post with no token proves nothing: it is refused before the writer and writes nothing",
            r.status_code in (400, 403) and seqs() == base_seq, r.status_code)
    r = SUP.get(URL["P"])
    s.check("a GET of the route does nothing (POST only)", r.status_code == 405 and seqs() == base_seq, r.status_code)

    # -------------------------------------------------------------------------------------------------------------
    s.section("A line added after a reorder comes last; a copy to another cycle carries seq")
    post(SUP, "P", [L["P"][i] for i in (2, 0, 1, 4, 3)])
    rr = SUP.post(URL["P"], data={"csrf_token": "tok", "action": "add", "library_id": str(L["lib"]), "weightage": "5", "moderator": "lm",
                                  "rate 1": "10", "rate 2": "20", "rate 3": "30", "rate 4": "40", "rate 5": "50"}, follow_redirects=True)
    added = H.rows(a, "SELECT id, seq FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? AND kpi_name='ZZRO Library KPI'", (CID, U["P"]))
    s.check("a KPI added through the real Add route is made (seq NULL)", len(added) == 1 and added[0][1] is None, flash(rr))
    nm = names_in_order()
    s.check("...and the admin's list puts it last, the reordered five in their order before it",
            nm[-1][1] == "ZZRO Library KPI" and [n for _i, n in nm[:5]] == [NAMES[i] for i in (2, 0, 1, 4, 3)], nm)
    s.check("...and so does the employee's check-in (the reordered lines by seq, the new one after them)",
            checkin_names()[-1] == "ZZRO Library KPI" and checkin_names()[:5] == [NAMES[i] for i in (2, 0, 1, 4, 3)], checkin_names())
    s.check("...and the download", export_names()[-1] == "ZZRO Library KPI")
    post(SUP, "P", [r_[0] for r_ in H.rows(a, "SELECT id FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? ORDER BY (seq IS NULL), seq, id",
                                          (CID, U["P"]))][::-1])
    s.check("the Library line can be reordered like any (six lines, seq 1..6)", sorted(seqs().values()) == [1, 2, 3, 4, 5, 6], seqs())
    # copy to a new cycle: _pm_carry_kpis keeps every column of a line, seq included, and lists in the order
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT INTO cycles(code, name, is_active) VALUES ('ZZRO-NEXT', 'ZZRO next cycle', 0)")
        NEXT = d_.execute("SELECT id FROM cycles WHERE code='ZZRO-NEXT'").fetchone()[0]
        res = a._pm_carry_kpis(d_, CID, NEXT, SU["id"])
        d_.commit()
    got = H.rows(a, "SELECT kpi_name, seq FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? ORDER BY (seq IS NULL), seq, id", (NEXT, U["P"]))
    was = H.rows(a, "SELECT kpi_name, seq FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? ORDER BY (seq IS NULL), seq, id", (CID, U["P"]))
    s.check("a carry to another cycle copies the lines with their seq, in the same order", res["lines"] >= 6 and [tuple(x) for x in got] == [tuple(x) for x in was]
            and [x[1] for x in got] == [1, 2, 3, 4, 5, 6], (got, was))
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM pm_kpi_targets WHERE cycle_id=?", (NEXT,))
        d_.execute("DELETE FROM cycles WHERE id=?", (NEXT,))
        d_.commit()

    # -------------------------------------------------------------------------------------------------------------
    s.section("The access item")
    keys = [i[1] for i in a.ADMIN_ITEMS]
    s.check("pm.kpi_reorder is an 'edit' item in Performance, labelled Reorder KPI lines, right after Edit a KPI line",
            a.ADMIN_ITEM_BY_KEY.get("pm.kpi_reorder") == ("pm", "pm.kpi_reorder", "edit", "Reorder KPI lines")
            and keys.index("pm.kpi_reorder") == keys.index("pm.kpi_edit") + 1)
    s.check("Run the cycle and Everything carry it; View only does not; it is no explicit-only item",
            "pm.kpi_reorder" in a.role_preset_items("cycle") and "pm.kpi_reorder" in a.role_preset_items("full")
            and "pm.kpi_reorder" not in a.role_preset_items("view") and "pm.kpi_reorder" not in a.ADMIN_ITEMS_EXPLICIT)
    amap = a.ADMIN_ACCESS_MAP["admin_person_kpi"]
    s.check("ADMIN_ACCESS_MAP classifies action=reorder as _it('pm.kpi_reorder'), the other actions as before",
            amap["map"].get("reorder") == a._it("pm.kpi_reorder") and amap["map"]["edit"] == a._it("pm.kpi_edit")
            and amap["map"]["add"] == a._it("pm.kpi_add") and amap["map"]["delete"] == a._it("pm.kpi_delete"))
    roles_page = say(SUP.get("/admin/roles"))
    s.check("Roles & access offers it to the super admin", "Reorder KPI lines" in roles_page and "Edit a KPI line" in roles_page)

    s.section("The one-time backfill: every role holding Edit gets Reorder once, and an untick stays")
    with a.app.app_context():
        d_ = a.get_db()
        have_key = d_.execute("SELECT value FROM app_settings WHERE key='admin_roles_seeded_kpi_reorder'").fetchone()
        s.check("the boot that ran this suite has already set the backfill's flag", have_key is not None)
        d_.execute("DELETE FROM admin_role_access WHERE item='pm.kpi_reorder' AND role_id IN (?,?,?,?)",
                   (ROLES["E"], ROLES["R"], ROLES["RA"], ROLES["V"]))
        d_.execute("DELETE FROM app_settings WHERE key='admin_roles_seeded_kpi_reorder'")
        d_.commit()
    a._seed_access_roles()

    def holds(k):
        return bool(H.one(a, "SELECT COUNT(*) FROM admin_role_access WHERE role_id=? AND item='pm.kpi_reorder'", (ROLES[k],)))
    s.check("the role holding Edit a KPI line now holds Reorder KPI lines", holds("E"))
    s.check("a role that did not hold Edit is not given it (View only, and the Reorder-only roles whose tick was taken off in this test)",
            not holds("V") and not holds("R") and not holds("RA"))
    s.check("the flag is set", H.one(a, "SELECT COUNT(*) FROM app_settings WHERE key='admin_roles_seeded_kpi_reorder'") == 1)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM admin_role_access WHERE role_id=? AND item='pm.kpi_reorder'", (ROLES["E"],))
        d_.commit()
    a._seed_access_roles()
    s.check("the super admin unticked it and the schema step ran again: it stays unticked", not holds("E"))
    ids_now = [r[0] for r in H.rows(a, "SELECT id FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? ORDER BY (seq IS NULL), seq, id", (CID, U["P"]))]
    fl = flash(post(SUP, "P", ids_now))
    s.check("...the super admin's own rights never depended on a row: they still reorder", "KPI order saved" in fl, fl)
    with a.app.app_context():   # put the two Reorder roles back as this suite made them
        d_ = a.get_db()
        d_.executemany("INSERT OR IGNORE INTO admin_role_access(role_id, item) VALUES (?, 'pm.kpi_reorder')", [(ROLES["R"],), (ROLES["RA"],)])
        d_.commit()

    # -------------------------------------------------------------------------------------------------------------
    s.section("The page")
    code, pg = person_page(SUP)
    s.check("the super admin, 5+ lines, active cycle: + Add a KPI and Reorder in one bar, the reorder bar and its form in the page",
            code == 200 and 'id="kpe-addbar"' in pg and 'id="add"' in pg and 'id="rord-open"' in pg and 'id="rord-bar"' in pg
            and 'id="rord-form"' in pg and pg.index('id="add"') < pg.index('id="rord-open"') < pg.index("Every KPI is picked"))
    s.check("the reorder form posts to the route with the token in the form, action=reorder, and its confirm words are the page script's",
            re.search(r'<form method="post" action="/admin/users/%d/kpi" id="rord-form"[^>]*data-confirm-ok="Save order"' % U["P"], pg)
            and 'name="csrf_token" value="tok"' in pg.split('id="rord-form"')[1][:600] and 'name="action" value="reorder"' in pg
            and "Nobody is emailed." in pg)
    s.check("the bar's words: the bold title, the line under it, Cancel, and Save order off until something moves",
            "<b>Reorder KPIs</b>" in pg and "Drag a row by its handle, or move it with the arrows. Only the order changes: weights, targets, "
            "results and ratings stay as they are." in pg and re.search(r'id="rord-save" form="rord-form" disabled>Save order<', pg)
            and ">Cancel<" in pg)
    s.check("every row carries a grip (Drag <KPI>), a pair of arrows (Move <KPI> up / down), and the header says Move",
            all(('aria-label="Drag %s"' % n) in pg and ('aria-label="Move %s up"' % n) in pg and ('aria-label="Move %s down"' % n) in pg
                for n in NAMES) and 'class="pp-hmove">Move<' in pg)
    s.check("the table is #pp-kpis and kpi_reorder.js loads after kpi_edit.js", 'id="pp-kpis"' in pg and pg.index("kpi_edit.js") < pg.index("kpi_reorder.js"))
    s.check("the Final result row says it stays last (shown only in reorder mode)", "pp-kfixed" in pg and "stays last, never moves" in pg)
    code, pg = person_page(CL["RA"])
    s.check("a role with Reorder and Add: both buttons", code == 200 and 'id="add"' in pg and 'id="rord-open"' in pg)
    code, pg = person_page(CL["R"])
    s.check("a role with Reorder and not Add: the bar shows Reorder alone, with its own words, and no Add",
            code == 200 and 'id="rord-open"' in pg and 'id="add"' not in pg and "Change the order their KPIs read in, everywhere they are "
            "listed." in pg and "Every KPI is picked from the KPI library" not in pg and 'id="kpe-addbar"' in pg)
    code, pg = person_page(CL["E"])
    s.check("a role with Edit and no Reorder: no button, no bar, no reorder markup", code == 200 and "rord-" not in pg and "pp-grip" not in pg)
    code, pg = person_page(CL["V"])
    s.check("a View only role: no add bar at all, no Reorder", code == 200 and "kpe-addbar" not in pg and "rord-" not in pg)
    code, pg = person_page(SUP, "R")
    s.check("fewer than 2 lines: no Reorder, the add bar as today", code == 200 and "rord-open" not in pg and 'id="add"' in pg)
    code, pg = person_page(SUP, "P", "&cycle=%d" % OLD)
    s.check("a past cycle (read only): no add bar, no Reorder", code == 200 and "rord-open" not in pg and 'id="add"' not in pg)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT OR REPLACE INTO result_releases(cycle_id, subject_id, kind) VALUES (?,?, 'pm')", (CID, U["P"]))
        d_.commit()
    code, pg = person_page(CL["R"])
    s.check("released: a Reorder-only role has no bar at all", code == 200 and "kpe-addbar" not in pg and "rord-" not in pg
            and "reordered or deleted" in pg)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM result_releases WHERE subject_id=?", (U["P"],))
        d_.commit()
    js = open(os.path.join(H.REPO, "static", "kpi_reorder.js"), encoding="utf-8").read()
    s.check("the script: arrows, drag by pointer events, Space / arrows / Esc, an aria-live line, and no browser confirm()",
            all(x in js for x in ("data-rord-mv", "pointerdown", "ArrowUp", "Escape", "aria-pressed", "live.textContent")) and "confirm(" not in
            re.sub(r"askConfirm\(|window\.askConfirm|data-confirm", "", js))
    s.check("...it asks Leave without saving? (Stay / Leave) through OneHR's own box, and the box takes a title and a Cancel word",
            "Leave without saving?" in js and 'cancel: "Stay"' in js and 'extra.title' in open(os.path.join(H.REPO, "templates", "base.html")).read())

    # -------------------------------------------------------------------------------------------------------------
    s.section("Lint: no read that lists one person's KPI lines ends in a bare ORDER BY id")
    SRC = open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read()

    def flat(node):
        """A SQL string's text, '<RULE>' where one of the PM_LINE_ORDER constants goes in; None when it is not a string."""
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.JoinedStr):
            return "".join(v.value if isinstance(v, ast.Constant) else
                           ("<RULE>" if isinstance(v.value, ast.Name) and v.value.id.startswith("PM_LINE_ORDER") else "{}") for v in node.values)
        if isinstance(node, ast.Name) and node.id.startswith("PM_LINE_ORDER"):
            return "<RULE>"
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            l_, r_ = flat(node.left), flat(node.right)
            return None if l_ is None and r_ is None else (l_ or "{}") + (r_ or "{}")
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mod):
            l_ = flat(node.left)
            if l_ is None:
                return None
            return l_ + (" <RULE>" if any(isinstance(n, ast.Name) and n.id.startswith("PM_LINE_ORDER") for n in ast.walk(node.right)) else "")
        return None

    def findings(src):
        """[(function, ORDER BY clause)] for every query on pm_kpi_targets whose last ORDER BY term is a bare id."""
        tree, out, seen = ast.parse(src), [], set()

        def walk(node, fn):
            for ch in ast.iter_child_nodes(node):
                name = ch.name if isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef)) else fn
                if isinstance(ch, ast.Call):
                    for arg in ch.args[:3]:
                        key = (arg.lineno, arg.col_offset)
                        t = flat(arg) if isinstance(arg, (ast.Constant, ast.JoinedStr, ast.BinOp)) else None
                        if t and key not in seen and re.search(r"pm_kpi_targets", t, re.I) and re.search(r"ORDER BY", t, re.I):
                            seen.add(key)
                            clause = re.split(r"ORDER BY", t, flags=re.I)[-1]
                            clause = re.sub(r"\s+LIMIT\b.*$", "", clause.strip(), flags=re.I | re.S).strip()
                            terms = [x.strip() for x in clause.split(",")]
                            if "<RULE>" not in clause and re.fullmatch(r"(\w+\.)?id", terms[-1]):
                                out.append((name, " ".join(clause.split())))
                walk(ch, name)
        walk(tree, "<module>")
        return out
    # the reads kept ordered by id, each with its reason: the order has no meaning there
    ALLOW = {
        ("_dash_overall", "id"): "an overall score over the lines: a sum, order-free",
        ("_split_figures", "id"): "the transferred person's two figures: sums over the lines",
        ("_pm_manager_remark_write", "id"): "lock and ownership checks over the person's lines (all / any): no list is shown",
        ("_split_role_from", "id"): "LIMIT 1: the first line's group and unit",
        ("_bu_kpi_apply", "(bu_kpi_id IS NULL), id"): "picks the ONE line per person that already holds the BU KPI (it wins over a same-name line)",
        ("_bu_kpi_carriers", "id"): "keyed by the carrier's Employee ID, one line each: a dict, not a list",
        ("_pm_lm_lines_to_move_many", "t.id"): "the ids of the lines that follow a line-manager change: a set (the names the page shows are "
                                              "re-read in line order by admin_person_lines)",
        ("_bg_move_bu_lines", "t.id"): "the group move's BU lines, apply and preview alike (one helper, a lint in test_bu_kpi_cross_unit reads this very "
                                      "line): a set of lines the move acts on, not a list of their KPIs",
        ("_idp_kpi_reader", "a.seq, a.id"): "orders the approvers' chain (a.seq, a.id) and takes the first: LIMIT 1, not the person's lines",
    }
    found = findings(SRC)
    got_keys = {(f, c) for f, c in found}
    s.check("the app has no per-person KPI list ordered by a bare id outside the allowlist", not (got_keys - set(ALLOW)), sorted(got_keys - set(ALLOW)))
    s.check("every allowlisted read is still there and still ordered that way (no stale entry)", set(ALLOW) <= got_keys, sorted(set(ALLOW) - got_keys))
    s.check("each allowlist entry says why", all(len(v) > 15 for v in ALLOW.values()))
    planted = [
        ('def f(db):\n    return db.execute("SELECT * FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? ORDER BY id", (1, 2))\n', 1),
        ('def f(db):\n    return db.execute("SELECT t.* FROM pm_kpi_targets t WHERE t.cycle_id=? ORDER BY t.subject_id, t.id", (1,))\n', 1),
        ('def f(db):\n    return db.execute("SELECT * FROM pm_kpi_targets WHERE a=? ORDER BY subject_id, id LIMIT 1", (1,))\n', 1),
        ('def f(db):\n    return db.execute("SELECT * FROM pm_kpi_targets WHERE a=? ORDER BY " + PM_LINE_ORDER, (1,))\n', 0),
        ('def f(db):\n    return db.execute(f"SELECT * FROM pm_kpi_targets t WHERE a=? ORDER BY t.subject_id, {PM_LINE_ORDER_T}", (1,))\n', 0),
        ('def f(db):\n    return db.execute("SELECT * FROM pm_kpi_targets WHERE a=? ORDER BY %s" % PM_LINE_ORDER, (1,))\n', 0),
        ('def f(db):\n    return db.execute("SELECT * FROM pm_kpi_targets WHERE a=? ORDER BY kpi_name", (1,))\n', 0),
        ('def f(db):\n    return db.execute("SELECT * FROM users WHERE a=? ORDER BY id", (1,))\n', 0),
    ]
    s.check("the lint finds each planted bare-id read and passes each ordered one (it can fail)",
            all(len(findings(src)) == n for src, n in planted), [(n, len(findings(src))) for src, n in planted])
finally:
    with a.app.app_context():
        _d = a.get_db()
        _d.execute("DELETE FROM result_releases WHERE subject_id IN (SELECT id FROM users WHERE employee_id LIKE 'ZZ9RO-%')")
        _d.commit()
        _cleanup(_d)
sys.exit(s.done())
