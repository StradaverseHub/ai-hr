"""PAT Ref (Chris, 2026-10-27; canvas K1MvBr5HQApPBuRVXp4KZT): the PAT achievement page moved from Calibration Settings to
Calibration & Talent > Run, one business group at a time, one Save for the whole table, and no business group figure.

Two synthetic groups (ZZPR): the first with four units (Alpha, Beta, Gamma, Delta -- Delta locked by its BU CEO), the second with
one. A group-level row (company '') is planted in the first: no reader may use it any more. Everything is put back.
"""
import html
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402
from werkzeug.datastructures import MultiDict  # noqa: E402

a = H.setup()
s = H.Suite("PAT Ref -- under Run, one group at a time, one Save for the table, no business group figure")
BG, BG2 = "ZZPR AAA BG", "ZZPR BBB BG"
UA, UB, UC, UD, UE = "ZZPR Alpha", "ZZPR Beta", "ZZPR Gamma", "ZZPR Delta", "ZZPR Echo"
PAT = "/admin/performance/pbt"
ROLE = "ZZPR PAT role"


def _cleanup(db):
    db.execute("DELETE FROM activity_log WHERE action IN ('pm_pbt_set') AND detail LIKE 'ZZPR%'")
    for tb in ("pm_pbt_achievement", "pm_pat_lock_flags", "pm_calibration_sessions", "org_units"):
        db.execute("DELETE FROM %s WHERE business_group IN (?,?)" % tb, (BG, BG2))
    db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZPR-%'")
    db.execute("DELETE FROM admin_roles WHERE name=?", (ROLE,))
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    _cleanup(db)
    PER = a.active_pm_period(db)["id"]
    for bg, units in ((BG, (UA, UB, UC, UD)), (BG2, (UE,))):
        for u in units:
            db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (bg, u))
    db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES (?, 'group')", (ROLE,))
    RID = db.execute("SELECT id FROM admin_roles WHERE name=?", (ROLE,)).fetchone()[0]
    for item in ("calibration.read", "calibration.pat"):
        db.execute("INSERT OR IGNORE INTO admin_role_access(role_id, item) VALUES (?,?)", (RID, item))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]
    v = dict(base, username="zzpr-adm", employee_id="ZZPR-ADM", full_name="ZZ PR Admin", email=None, hod_id=None, manager_id=None,
             buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=UA, role="admin", admin_bg=BG,
             is_demo=0, left_at=None)
    if "admin_role_id" in cols:
        v["admin_role_id"] = RID
    db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
    ADM = db.execute("SELECT id FROM users WHERE username='zzpr-adm'").fetchone()[0]
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]
    # Delta is locked by its BU CEO
    sd = a._pm_calib_get_or_create_session(db, PER, "buceo", UD, BG, UD)
    db.execute("UPDATE pm_calibration_sessions SET locked_at=CURRENT_TIMESTAMP, locked_by=? WHERE id=?", (SUP, sd["id"]))
    # an old business group figure, as production may still hold: nothing reads it now
    db.execute("INSERT INTO pm_pbt_achievement(cycle_id, business_group, company, achievement_pct) VALUES (?,?,?,?)",
               (PER, BG, "", 150))
    db.commit()
    FIRST_BG = a.org_bgs(db)[0]

sup, adm = H.client_as(a, SUP), H.client_as(a, ADM)


def stored(co, bg=BG):
    r = H.rows(a, "SELECT achievement_pct FROM pm_pbt_achievement WHERE cycle_id=? AND business_group=? AND company=?",
               (PER, bg, co))
    return r[0][0] if r else None


def n_audit(like="ZZPR%"):
    return H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_pbt_set' AND detail LIKE ?", (like,))


def post(cl, pairs, bg=BG, extra=None):
    data = [("csrf_token", "tok"), ("business_group", bg)]
    for co, val in pairs:
        data += [("company", co), ("achievement_pct", val)]
    r = cl.post(PAT, data=MultiDict(data + (extra or [])), follow_redirects=True)
    return re.findall(r'class="flash flash-(\w+)"[^>]*>([^<]+)', html.unescape(r.get_data(as_text=True)))


def page(cl, qs=""):
    return html.unescape(cl.get(PAT + qs).get_data(as_text=True))


try:
    s.section("1. it lives under Run, as PAT Ref, and not under Settings")
    cal = next(x for x in a.ADMIN_SECTIONS if x["key"] == "calibration")
    run = next(t for t in cal["tabs"] if t["key"] == "run")
    sett = next(t for t in cal["tabs"] if t["key"] == "settings")
    shown = [(p["label"]) for p in run["pages"] if not p.get("hidden")]
    s.check("Run lists Progress, PAT Ref, Lock status, Talent Box, Final bands, in that order",
            shown == ["Progress", "PAT Ref", "Lock status", "Talent Box", "Final bands"], shown)
    s.check("...and Settings no longer names the page", all(p["ep"] != "admin_performance_pbt" for p in sett["pages"]))
    b = page(sup, "?fbg=" + BG.replace(" ", "+"))
    s.check("the page renders (200) with PAT Ref in its title and the Run tab on", "<title>PAT Ref" in b
            and "Settings &rsaquo; PAT achievement" not in b and "Settings › PAT achievement" not in b)
    m = re.search(r'<a[^>]*href="/admin/performance/pbt"[^>]*>', b)
    s.check("...its pill is the one that is on", m and ("is-on" in m.group(0) or 'aria-current' in m.group(0)),
            m.group(0) if m else None)
    s.check("...and says PAT achievement in its own words", "profit after tax (PAT) achievement" in b)
    st = html.unescape(sup.get("/admin/m/calibration/settings").get_data(as_text=True))
    s.check("Calibration Settings has no PAT card any more", 'id="pbt"' not in st and "Open PAT" not in st)
    al = html.unescape(sup.get("/admin/all-settings").get_data(as_text=True))
    s.check("...but All settings keeps its line, pointing at the Run page", "PAT Ref" in al and 'href="/admin/performance/pbt"' in al)
    idx = sup.get("/admin/search.json").get_json()["items"]
    s.check("the search finds PAT Ref as a page under Calibration & Talent > Run",
            any(i["kind"] == "page" and i["label"] == "PAT Ref" and "Run" in i["path"] for i in idx))
    s.check("...and no page is still called PAT achievement", not any(i["kind"] == "page" and i["label"] == "PAT achievement" for i in idx))

    s.section("2. no business group figure: a unit never reads the group's old row")
    with a.app.test_request_context("/"):
        d = a.get_db()
        cv = a.pm_curve_for(d, PER, BG, UA)
        s.check("a unit with no figure of its own is on the normal curve, not entered, no scope even with a group row stored",
                cv["key"] == "normal" and cv["entered"] is False and cv["scope"] is None and cv["pct"] is None, cv)
        cv0 = a.pm_curve_for(d, PER, BG, None)
        s.check("...and so is a business group (no unit)", cv0["key"] == "normal" and not cv0["entered"] and cv0["scope"] is None, cv0)
        # falsify: the old fallback would have read the 150 row and turned both positive
        old = d.execute("SELECT achievement_pct FROM pm_pbt_achievement WHERE cycle_id=? AND business_group=? AND company=''",
                        (PER, BG)).fetchone()
        s.check("the planted group row is one the old fallback would have read (150% = positive)",
                old and a.pm_curve_key_for_pct(old[0]) == "positive")
        s.check("the Talent Box's PAT map and the agent's report leave it out",
                "" not in a._talent_box_pat(d, {"period": {"id": PER}, "business_group": BG}))
        s.check("a locked-unit lookup for a group (empty company) finds nothing", a._pat_locked_units(d, PER, BG, "") == [])
    r = post(sup, [("", "90")])
    s.check("a post for the business group itself ('') is refused, nothing stored", any(c == "error" for c, _m in r)
            and stored("") == 150 and n_audit() == 0, r)

    s.section("3. one post saves several units, one audit row each, and only the ones that changed")
    r = post(sup, [(UA, "69.4"), (UB, "100"), (UC, "")])
    s.check("three rows in one post: two figures stored, the blank one stays not entered",
            stored(UA) == 69.4 and stored(UB) == 100 and stored(UC) is None and r and r[0][1] == "Saved 2 units.", r)
    s.check("...one audit row for each unit that changed (two)", n_audit("ZZPR%") == 2)
    r = post(sup, [(UA, "69.4"), (UB, "135"), (UC, "")])
    s.check("an unchanged row is not written or audited; the changed one is", stored(UB) == 135 and n_audit() == 3
            and r[0][1] == "Saved 1 unit.", (r, n_audit()))
    r = post(sup, [(UA, "69.4"), (UB, "135"), (UC, "")])
    s.check("a post with nothing changed says so and audits nothing", n_audit() == 3 and "Nothing changed" in r[0][1], r)
    r = post(sup, [(UA, ""), (UB, "135")])
    s.check("a blank figure clears the unit (and is audited as cleared)", stored(UA) is None and n_audit() == 4
            and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_pbt_set' AND detail LIKE ?", ("ZZPR%: cleared",)) == 1)
    before = (stored(UA), stored(UB), n_audit())
    r = post(sup, [(UA, "80"), (UB, "abc")])
    s.check("one bad row refuses the whole save: nothing written, the unit named", (stored(UA), stored(UB), n_audit()) == before
            and r and r[0][0] == "error" and "Beta" in r[0][1], r)
    r = post(sup, [(UA, "80"), (UA, "90")])
    s.check("a unit twice in one post is refused whole", (stored(UA), n_audit()) == (before[0], before[2]), r)
    r = post(sup, [(UA, "-5")])
    s.check("a negative figure is refused", stored(UA) is None, r)
    r = post(sup, [(UE, "100")])
    s.check("a unit of another group posted under this group is refused (403), nothing stored", stored(UE, BG2) is None
            and stored(UE) is None)
    r = sup.post(PAT, data={"csrf_token": "tok", "business_group": BG, "company": UA}, follow_redirects=True)
    s.check("figures and units that don't line up are refused", stored(UA) is None)

    s.section("4. a unit its BU CEO locked: only the super admin, and the whole save is refused otherwise")
    s.check("the role holder (BG admin with the PAT tick) can save an unlocked unit",
            any(c == "ok" for c, _m in post(adm, [(UA, "75")])) and stored(UA) == 75)
    before = (stored(UA), stored(UD), n_audit())
    r = post(adm, [(UA, "60"), (UD, "140")])
    s.check("with a locked unit in the post, the whole save is refused for them: the unlocked unit is not written either",
            (stored(UA), stored(UD), n_audit()) == before and r and r[0][0] == "error" and "only the super admin" in r[0][1]
            and "Delta" in r[0][1], r)
    b = page(adm)
    s.check("...their page shows the locked unit read only (no input for it)", UD in b and not re.search(
        r'name="achievement_pct"[^>]*data-unit-name="%s"' % UD, b) and "only the super admin changes it now" in b)
    r = post(sup, [(UA, "60"), (UD, "140")])
    s.check("the super admin saves both in one post; the locked unit is flagged once",
            stored(UA) == 60 and stored(UD) == 140 and H.one(
                a, "SELECT COUNT(*) FROM pm_pat_lock_flags WHERE cycle_id=? AND business_group=? AND company=?", (PER, BG, UD)) == 1, r)

    s.section("5. one group at a time; a BG admin only their own")
    b = page(sup, "?fbg=" + BG.replace(" ", "+"))
    s.check("a super admin who picks a group sees that group's card and no other (one card, the group's units)",
            b.count('class="admin-card pat-card"') == 1 and UA in b and UE not in b)
    b2 = page(sup, "?fbg=" + BG2.replace(" ", "+"))
    s.check("...another pick shows the other group", UE in b2 and UA not in b2)
    b3 = page(sup)
    with a.app.test_request_context("/"):
        first_name = a.display_bg(FIRST_BG)
    s.check("with none picked it opens the first group in their scope, no All pill", b3.count('class="admin-card pat-card"') <= 1
            and ("<h2>%s</h2>" % html.escape(first_name, quote=False) in b3 or "<h2>%s</h2>" % first_name in b3)
            and not re.search(r'adm-frow-pill[^>]*>All', b3))
    s.check("...and the filter row is one row (the business group)", b3.count('class="adm-frow"') == 1)
    ba = page(adm)
    s.check("a BG admin goes straight to their own group: its units, no other group, no filter row",
            UA in ba and UE not in ba and "ZZPR BBB" not in ba and 'class="adm-frow"' not in ba)

    s.section("6. the page itself")
    b = page(sup, "?fbg=" + BG.replace(" ", "+"))
    s.check("no Whole Business Group row, and the four columns", "Whole Business Group" not in b
            and all(h in b for h in ("Business unit", "PAT achievement", "Curve it picks", "BU CEO lock")))
    m = re.search(r'<form[^>]*id="pat-save"[^>]*>(.*?)</form>', b, re.S)
    s.check("the one Save form carries the CSRF token and a confirm, outside the table", m and 'name="csrf_token"' in m.group(1)
            and "data-confirm=" in m.group(0) and 'data-confirm-list-label="What changes"' in m.group(0)
            and "Save changes" in m.group(1) and "Discard" in m.group(1))
    tb = re.search(r'<table class="admin-table pat-table".*?</table>', b, re.S)
    s.check("...the table is not inside any form of its own, and its inputs join the Save form", tb and "<form" not in re.sub(
        r'<form[^>]*class="pat-fit".*?</form>', "", tb.group(0), flags=re.S) and tb.group(0).count('form="pat-save"') >= 2 * 3)
    s.check("...a row's Save buttons are gone", 'class="btn-link">Save</button>' not in b)
    s.check("the reference curves fold to one line with the three chips and a fold", "Show the three curves" in b
            and 'class="fold pat-curves"' in b and "status-archived" in b and "status-reviewed" in b)
    s.check("the count line reads N of M units entered", re.search(r"<b>\d+ of 4</b> units entered", b))
    s.check("the unit's chip title carries the split", re.search(r'title="UA \d+% · BE \d+% · ME \d+% · AE \d+% · OU \d+%"', b))
    s.check("the locked unit shows a short-date lock pill with the full date in its title",
            re.search(r'class="pat-lock" title="The BU CEO locked calibration on \d+ \w+ \d{4}">Locked \d+ \w+<', b))

    s.section("7. the HR report for a business group reads the normal curve")
    r = sup.get("/admin/reports/all/pm-results?bg=" + BG.replace(" ", "+"))
    rb = html.unescape(r.get_data(as_text=True))
    s.check("at group level (no unit) it shows Normal, not the stored group figure, and says a group has no single PAT",
            r.status_code == 200 and "The curve: Normal" in rb and "no single PAT" in rb, r.status_code)
finally:
    with a.app.test_request_context("/"):
        _cleanup(a.get_db())
sys.exit(s.done())
