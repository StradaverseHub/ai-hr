"""No maximum on the 360's two numbers, each on its own (Chris, 2026-10-23): "allow no-cap or no max as an option",
"it should replace the max count of 4 and it just becomes unlimited rather a new standalone toggle", and "when i say no
cap, it applies to the two setting separately, one on the target panel size for a person, second is the most people one
person rates". With a panel size of No maximum the panel build is off (his pick).

What it holds: 360 Feedback › Settings › Rules and a cycle's own rules offer No maximum on both lists; it saves ("none",
a cycle's 0), is audited, and a BG admin can't set it. Most people one person rates at No maximum: every add (the panel
editor, the ticked suggestions, restore, a new line manager, a panel file) goes past 4, the name search and the
suggestions grey nobody, Data integrity flags nobody, and the build gives a busy line manager one more. Target panel size
at No maximum: a panel takes a fifth rater by hand and by restore, the build is off (page and POST), "short" means below
the scoring minimum, and nothing is "over the target". Back to numbers, the same adds are refused. Everything written is
synthetic (ZZNM-*) and removed at the end; the settings it changes are put back.
"""
import html
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("No maximum on the panel size and on how many one person rates")
SU, BGA, EMP = H.actors(a)
sup = H.client_as(a, SU["id"])
BG, CO, DEPT = "ZZNM BG", "ZZNM CO", "ZZNM Dept"
KEYS = ("panel_size", "min_valid", "tiers", "assessor_cap")


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZNM-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM activity_log WHERE target_user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM pm_kpi_target_approvers WHERE approver_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    CYC = dict(a.active_cycle(db))
    CID = CYC["id"]
    _cleanup(db)
    SETTINGS0 = {k: v for k, v in db.execute("SELECT key, value FROM app_settings WHERE key IN (%s)"
                                             % ",".join("?" * len(KEYS)), KEYS)}
    CYC_RULES0 = (CYC["panel_size"], CYC["assessor_cap"], CYC["min_valid"], CYC["tiers_json"])
    # this suite's rules: a panel of 4, nobody rates more than 4, no cycle override
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('panel_size','4'), ('assessor_cap','4')")
    db.execute("UPDATE cycles SET panel_size=NULL, assessor_cap=NULL WHERE id=?", (CID,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, name, mgr=None, jg="16", dept=DEPT):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=mgr,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CO, department=dept,
                 job_title="ZZNM Analyst", job_grade=jg, years_of_service=3, confirmation_date=None, left_at=None,
                 is_demo=0, role="user", admin_bg=None)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
    BOSS = mk("ZZNM-BOSS", "ZZ NM Boss", jg="20")
    X = mk("ZZNM-X", "ZZ NM Busy", mgr=BOSS)                       # rates four people already
    S = [mk("ZZNM-S%d" % i, "ZZ NM Subject %d" % i, mgr=BOSS) for i in range(12)]
    Y = mk("ZZNM-Y", "ZZ NM Report", mgr=X, dept=DEPT + " 2")      # the busy rater is their line manager
    R = [mk("ZZNM-R%d" % i, "ZZ NM Rater %d" % i, mgr=BOSS) for i in range(6)]   # Z's raters
    Z = mk("ZZNM-Z", "ZZ NM Full", mgr=BOSS)                       # a full panel of 4
    for i in range(4):
        db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship) VALUES (?,?,?,'peer')",
                   (CID, S[i], X))
        db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship) VALUES (?,?,?,'peer')",
                   (CID, Z, R[i]))
    db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, archived) "
               "VALUES (?,?,?,'peer',1)", (CID, Z, R[5]))
    ARCH_Z = db.execute("SELECT id FROM assignments WHERE cycle_id=? AND subject_id=? AND assessor_id=?",
                        (CID, Z, R[5])).fetchone()[0]
    db.commit()


def load_of(uid):
    return H.one(a, "SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND assessor_id=? AND archived=0", (CID, uid))


def panel_of(uid):
    return H.one(a, "SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND subject_id=? AND archived=0", (CID, uid))


def on_panel(sid, aid):
    return H.one(a, "SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND subject_id=? AND assessor_id=? "
                    "AND archived=0", (CID, sid, aid))


def setting(k):
    return H.one(a, "SELECT (SELECT value FROM app_settings WHERE key=?)", (k,))


def last_audit():
    return H.one(a, "SELECT detail FROM activity_log WHERE action='settings' ORDER BY id DESC LIMIT 1") or ""


def flashes(c):
    with c.session_transaction() as ss:
        out = " ".join(m for _c, m in (ss.get("_flashes") or []))
        ss["_flashes"] = []
    return out


def post(url, c=sup, **f):
    d = {"csrf_token": "tok"}
    d.update(f)
    return c.post(url, data=d)


def archived_row(sid, aid):
    with a.app.app_context():
        d = a.get_db()
        d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, archived) "
                  "VALUES (?,?,?,'peer',1)", (CID, sid, aid))
        d.commit()
        return d.execute("SELECT id FROM assignments WHERE cycle_id=? AND subject_id=? AND assessor_id=?",
                         (CID, sid, aid)).fetchone()[0]


def check_rows(key):
    with a.app.test_request_context("/"):
        d = a.get_db()
        rows, _c = a.data_check_rows(d, SU, CID, a.DATA_CHECKS_BY_KEY[key], cap=False)
        return {r["eid"] for r in rows}


def import_one(subject_eid, assessor_eid="ZZNM-X"):
    csv_ = "Subject Employee ID,Assessor Employee ID,Relationship\n%s,%s,peer\n" % (subject_eid, assessor_eid)
    return html.unescape(H.import_steps(sup, "/admin/import", {"file": (io.BytesIO(csv_.encode()), "p.csv")}).get_data(
        as_text=True))


def build_plan():
    with a.app.test_request_context("/"):
        d = a.get_db()
        return a._panel_build_plan(d, SU, CID, "missing", bg=BG)


def lst(name, page):
    m = re.search(r'<select name="%s"[^>]*>(.*?)</select>' % name, page, re.S)
    if not m:
        return None, []
    opts = re.findall(r'<option value="([^"]+)"(\s+selected)?>', m.group(1))
    return next((v for v, sel in opts if sel), None), [v for v, _s in opts]


try:
    # -------------------------------------------------------------------------------------------------------------
    s.section("both lists offer No maximum; the super admin's, saved and audited")
    page = html.unescape(sup.get("/admin/m/f360/settings").get_data(as_text=True))
    for name in ("panel_size", "assessor_cap"):
        sel, opts = lst(name, page)
        s.check("the rules card's %s is a list of 1-20 and No maximum, 4 picked" % name,
                opts == [str(n) for n in range(1, 21)] + ["none"] and sel == "4", (sel, opts[-3:]))
    with a.app.test_request_context("/"):
        tiers = a.default_tiers()
        mv = a.default_min_valid()
    form = {"action": "rules", "panel_size": "4", "min_valid": str(mv), "assessor_cap": "4", "remark": "ZZNM test"}
    for t in tiers:
        form["tier%d_min" % t["n"]], form["tier%d_max" % t["n"]] = str(t["min"]), str(t["max"])
    post("/admin/settings", **dict(form, assessor_cap="none"))
    s.check("Most people one person rates: No maximum saves 'none', the panel size untouched",
            setting("assessor_cap") == "none" and setting("panel_size") == "4", (setting("assessor_cap"),
                                                                                  setting("panel_size")))
    s.check("...the audit row says so", "rater cap no maximum (was 4)" in last_audit(), last_audit()[-120:])
    with a.app.test_request_context("/"):
        caps = (a.default_assessor_cap(), a.effective_assessor_cap(dict(CYC, assessor_cap=None)),
                a.effective_assessor_cap(dict(CYC, assessor_cap=0)), a.effective_assessor_cap(dict(CYC, assessor_cap=6)))
    s.check("...read as None (a cycle's 0 too; a cycle's own number still wins)", caps == (None, None, None, 6), caps)
    post("/admin/settings", **{k: v for k, v in form.items() if k != "assessor_cap"})
    s.check("a rules form that doesn't send it leaves it as it is", setting("assessor_cap") == "none")
    post("/admin/settings", **dict(form, assessor_cap="21"))
    s.check("21 is refused", setting("assessor_cap") == "none" and "between 1 and 20, or No maximum" in flashes(sup))
    if BGA:
        post("/admin/settings", c=H.client_as(a, BGA["id"]), **dict(form, assessor_cap="4"))
        s.check("a BG admin can't change it", setting("assessor_cap") == "none", setting("assessor_cap"))
    page = html.unescape(sup.get("/admin/m/f360/settings").get_data(as_text=True))
    s.check("the card shows No maximum picked", lst("assessor_cap", page)[0] == "none" and
            lst("panel_size", page)[0] == "4")
    alls = html.unescape(sup.get("/admin/all-settings").get_data(as_text=True))
    s.check("All settings says no maximum each", "4 assessors" in alls and "no maximum each" in alls)

    # -------------------------------------------------------------------------------------------------------------
    s.section("most people one person rates, No maximum: every add goes past 4")
    s.check("the busy rater rates 4 (the check reaches its line)", load_of(X) == 4, load_of(X))
    post("/admin/subjects/%d/panel" % S[4], action="add", assessor_eid="ZZNM-X", relationship="peer")
    s.check("the panel editor's add (5)", on_panel(S[4], X) == 1 and load_of(X) == 5, flashes(sup)[:200])
    post("/admin/subjects/%d/panel" % S[6], action="add_suggested", **{"pick_%d" % X: "1", "rel_%d" % X: "peer"})
    s.check("a ticked suggestion (6)", on_panel(S[6], X) == 1 and load_of(X) == 6, flashes(sup)[:200])
    post("/admin/subjects/%d/panel" % S[7], action="restore", assignment_id=str(archived_row(S[7], X)))
    s.check("restore (7)", on_panel(S[7], X) == 1 and load_of(X) == 7, flashes(sup)[:200])
    with a.app.test_request_context("/"):
        d = a.get_db()
        res = a._apply_line_manager_change(d, S[8], X, CID, disposition="reassign", actor_id=SU["id"])
        d.commit()
    s.check("a new line manager (8)", res["assignment_action"] != "capped" and on_panel(S[8], X) == 1,
            res["assignment_action"])
    imp = import_one("ZZNM-S5")
    s.check("a panel file (9)", on_panel(S[5], X) == 1 and load_of(X) == 9, imp[-200:])
    j = sup.get("/admin/subjects/%d/assessor-search?q=ZZ+NM+Busy&rel=peer" % S[9]).get_json() or {}
    hit = [x for x in j.get("results", []) if x.get("employee_id") == "ZZNM-X"]
    s.check("the name search: no cap, nobody greyed", hit and hit[0]["load"] == 9 and hit[0]["full"] is False
            and j.get("cap") is None, (hit, j.get("cap")))
    fr = html.unescape(sup.get("/admin/users/%d?tab=f360&fragment=1" % Y).get_data(as_text=True))
    s.check("their report's suggestions say no maximum, with the load and no box greyed",
            "No maximum on how many one person rates." in fr and "rates 9</span>" in fr
            and 'name="pick_%d"' % X in fr and re.search(r'name="pick_%d"[^>]*disabled' % X, fr) is None)
    s.check("Data integrity flags nobody over the cap", "ZZNM-X" not in check_rows("over_cap"))
    plan = build_plan()
    picked_y = [aid for _c, sid, aid, _r in plan["rows"] if sid == Y]
    s.check("the build follows it: their busy line manager (9) is the report's first pick",
            plan["cap"] is None and X in picked_y, (plan["cap"], picked_y))

    # -------------------------------------------------------------------------------------------------------------
    s.section("target panel size, No maximum: a panel takes more, the build is off")
    post("/admin/settings", **dict(form, assessor_cap="4", panel_size="none"))
    s.check("No maximum saves 'none', the rater cap back at 4", setting("panel_size") == "none"
            and setting("assessor_cap") == "4", (setting("panel_size"), setting("assessor_cap")))
    s.check("...the audit row says so", "panel no maximum (was 4)" in last_audit(), last_audit()[-160:])
    s.check("the full panel holds 4 (the check reaches its line)", panel_of(Z) == 4, panel_of(Z))
    post("/admin/subjects/%d/panel" % Z, action="add", assessor_eid="ZZNM-R4", relationship="peer")
    s.check("a fifth rater by hand", panel_of(Z) == 5 and on_panel(Z, R[4]) == 1, flashes(sup)[:200])
    post("/admin/subjects/%d/panel" % Z, action="restore", assignment_id=str(ARCH_Z))
    s.check("...and a sixth by restore", panel_of(Z) == 6 and on_panel(Z, R[5]) == 1, flashes(sup)[:200])
    bp = html.unescape(sup.get("/admin/panels/build").get_data(as_text=True))
    s.check("the build page says it's off, with no build form", "The panel build is off" in bp
            and 'name="apply"' not in bp and "Preview (no changes)" not in bp)
    before = H.one(a, "SELECT COUNT(*) FROM assignments WHERE cycle_id=?", (CID,))
    post("/admin/panels/build", mode="missing", bg=BG, apply="1")
    s.check("a build POST is refused, nothing written",
            H.one(a, "SELECT COUNT(*) FROM assignments WHERE cycle_id=?", (CID,)) == before
            and "The panel build is off" in flashes(sup))
    s.check("Data integrity flags no panel as over the target", "ZZNM-Z" not in check_rows("over_target"))
    with a.app.test_request_context("/"):
        short_n, mvn = a.panel_short_n(), a.min_valid()
    s.check("short means below the scoring minimum", short_n == mvn, (short_n, mvn))
    ov = html.unescape(sup.get("/admin/360").get_data(as_text=True))
    s.check("...and the 360 Overview's tile says so", "Below the scoring minimum" in ov)
    fz = html.unescape(sup.get("/admin/users/%d?tab=f360&fragment=1" % S[10]).get_data(as_text=True))
    s.check("the person's add form has no target to fill", 'data-target=""' in fz and "up to the panel target" not in fz)
    cyc_page = html.unescape(sup.get("/admin/cycles").get_data(as_text=True))
    s.check("the cycles page says no maximum", "panel size <strong>no maximum</strong>" in cyc_page)

    # -------------------------------------------------------------------------------------------------------------
    s.section("a cycle's own rules take No maximum too")
    post("/admin/cycles", action="set_rules", cycle_id=str(CID), panel_size="none", min_valid=str(mv),
         assessor_cap="none", **{k: v for k, v in form.items() if k.startswith("tier")})
    own = H.one(a, "SELECT panel_size || ',' || assessor_cap FROM cycles WHERE id=?", (CID,))
    s.check("stored as 0 and 0", own == "0,0", own)
    with a.app.test_request_context("/"):
        c_ = dict(a.get_db().execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone())
        got = (a.effective_panel_size(c_), a.effective_assessor_cap(c_))
    s.check("...read as no maximum", got == (None, None), got)
    cyc_page = html.unescape(sup.get("/admin/cycles").get_data(as_text=True))
    s.check("...and listed as its own rules", "panel no maximum" in cyc_page and "no maximum each" in cyc_page)
    post("/admin/cycles", action="clear_rules", cycle_id=str(CID))

    # -------------------------------------------------------------------------------------------------------------
    s.section("back to 4 and 4: refused again")
    post("/admin/settings", **form)
    s.check("both back to 4", setting("panel_size") == "4" and setting("assessor_cap") == "4")
    post("/admin/subjects/%d/panel" % S[10], action="add", assessor_eid="ZZNM-X", relationship="peer")
    s.check("the busy rater can't be added", not on_panel(S[10], X))
    s.check("...saying who and why", "ZZ NM Busy already rates 9 people this cycle" in flashes(sup))
    post("/admin/subjects/%d/panel" % Z, action="add", assessor_eid="ZZNM-S11", relationship="peer")
    s.check("a panel of 6 takes no seventh", panel_of(Z) == 6 and not on_panel(Z, S[11]))
    imp = import_one("ZZNM-S11")
    s.check("a panel file is refused at the cap", not on_panel(S[11], X) and "Over the rater limit" in imp, imp[-200:])
    s.check("Data integrity flags the busy rater", "ZZNM-X" in check_rows("over_cap"))
    s.check("...and the panel over the target", "ZZNM-Z" in check_rows("over_target"))
    plan = build_plan()
    s.check("the build is back, at 4, and leaves the busy rater out",
            plan["cap"] == 4 and X not in [aid for _c, sid, aid, _r in plan["rows"]], plan["cap"])
finally:
    with a.app.app_context():
        d = a.get_db()
        _cleanup(d)
        d.execute("DELETE FROM app_settings WHERE key IN (%s)" % ",".join("?" * len(KEYS)), KEYS)
        for k, v in SETTINGS0.items():
            d.execute("INSERT INTO app_settings(key, value) VALUES (?,?)", (k, v))
        d.execute("UPDATE cycles SET panel_size=?, assessor_cap=?, min_valid=?, tiers_json=? WHERE id=?",
                  CYC_RULES0 + (CID,))
        d.execute("DELETE FROM activity_log WHERE action IN ('settings', 'cycle') AND (detail LIKE '%ZZNM test%' "
                  "OR detail LIKE '%no maximum%' OR detail LIKE 'Set rule override for%' "
                  "OR detail LIKE 'Cleared rule override for%') AND created_at >= datetime('now', '-1 hour')")
        d.commit()

sys.exit(s.done())
