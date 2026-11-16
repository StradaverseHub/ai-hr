"""Leaders > HODs, By HOD and Remove HOD (Chris, 2026-10-21; option B of canvas
[design canvas link removed]).

  "add a remove HOD button on our HOD setting page, there should be a view to see all the HOD and department they being
   assigned to, and from here super admin can adjust accordingly (remove or change HOD or add or remove department)"

His picks: cards, "Add a department" offers everyone in it or only those with no HOD now, the tab opens on By HOD.
Removing is the super admin's. Every write goes through the same preview, checks, fingerprint and writer as an assign
(_hod_plan_apply), so the asserts compare a full before/after snapshot of every hod_id: a write touching anyone it
shouldn't fails here. Its own synthetic business group; cleans up after itself.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Leaders > HODs, By HOD -- every HOD and their departments; remove, change, add")
SU, _BGA, _EMP = H.actors(a)
BG, CA, CB = "ZZHV BG", "ZZHV Alpha", "ZZHV Beta"



def clean(d):
    """Take away everything this suite makes (a run that stopped half way leaves it behind)."""
    ids = [r[0] for r in d.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZHV-%' OR username='zzhv_bga'")]
    ph = ",".join("?" * len(ids)) or "NULL"
    d.execute("UPDATE users SET hod_id=NULL WHERE hod_id IN (%s)" % ph, ids)
    d.execute("DELETE FROM rating_records WHERE subject_id IN (%s)" % ph, ids)
    d.execute("DELETE FROM pm_calibration_sessions WHERE tier='hod' AND scope_key IN (%s)" % ph, [str(i) for i in ids])
    d.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
    d.execute("DELETE FROM activity_log WHERE action='hod_assign_override' AND detail LIKE 'Removing an HOD: ZZHV%'")
    d.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    d.execute("DELETE FROM org_units WHERE business_group LIKE 'ZZHV%'")
    d.execute("DELETE FROM admin_role_access WHERE role_id IN (SELECT id FROM admin_roles WHERE name='ZZHV assign')")
    d.execute("DELETE FROM admin_roles WHERE name='ZZHV assign'")
    d.commit()


with a.app.app_context():
    d = a.get_db()
    clean(d)
    for c in (CA, CB):
        d.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, c))

    def person(eid, co, dept, hod=None, left=None):
        return d.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, "
                         "company, department, confirmation_date, left_at, job_grade, hod_id) VALUES (?,?,'x','user',?,?,"
                         "?,?,'2022-01-01',?,'16',?)", (eid.lower(), "ZZ HV " + eid, eid, BG, co, dept, left, hod)).lastrowid
    H1 = person("ZZHV-H1", CA, "Management")
    H2 = person("ZZHV-H2", CA, "Management")
    H3 = person("ZZHV-H3", CB, "Management", left="2026-01-01")   # an HOD who has left
    P = {"s1": person("ZZHV-S1", CA, "Sales", H1), "s2": person("ZZHV-S2", CA, "Sales", H1),
         "s3": person("ZZHV-S3", CA, " sales", H1), "s4": person("ZZHV-S4", CA, "Sales", H2),
         "s5": person("ZZHV-S5", CA, "Sales", H2), "s6": person("ZZHV-S6", CA, "Sales"),
         "o1": person("ZZHV-O1", CA, "Ops", H1), "o2": person("ZZHV-O2", CA, "Ops", H1),
         "f1": person("ZZHV-F1", CB, "Finance", H2), "f2": person("ZZHV-F2", CB, "Finance"),
         "q1": person("ZZHV-Q1", CB, "Quality"), "r1": person("ZZHV-R1", CB, "HR", H3)}
    BGA = d.execute("INSERT INTO users(username, full_name, password_hash, role, admin_bg) VALUES "
                    "('zzhv_bga','ZZ HV BG admin','x','admin',?)", (BG,)).lastrowid
    d.commit()
    CID = a.active_cycle_id(d)
SALES, OPS, FIN, QUAL = CA + "||sales", CA + "||ops", CB + "||finance", CB + "||quality"


def hods():
    return {r[0]: r[1] for r in H.rows(a, "SELECT id, hod_id FROM users")}


def post(c, **data):
    data.setdefault("csrf_token", "tok")
    return c.post("/admin/leaders", data=data)


def preview(c, **data):
    """(html, uids, fingerprint) of a preview."""
    data.setdefault("view", "hod")
    html = post(c, bg=BG, tab="hod", **data).get_data(as_text=True)
    fp = re.search(r'name="fingerprint" value="([0-9a-f]+)"', html)
    return html, {int(x) for x in re.findall(r'name="uid" value="(\d+)"', html)}, fp.group(1) if fp else None


def changed(before, after):
    return {k for k in after if after[k] != before.get(k)}


cS = H.client_as(a, SU["id"])
cB = H.client_as(a, BGA)

s.section("By HOD is the tab's first view: a card a person, the departments they head")
pg = cS.get("/admin/leaders?bg=%s&tab=hod" % BG).get_data(as_text=True)
s.check("the HOD tab opens on By HOD (Chris's pick), the switch lit on it",
        'class="ld-cards"' in pg and re.search(r'class="is-on" aria-current="page">By HOD<', pg) is not None)
cards = [int(x) for x in re.findall(r'<article class="admin-card ld-card" id="hod-(\d+)"', pg)]
# independently: every active, real person of the group who is someone's HOD there
expect = {r[0] for r in H.rows(a, "SELECT DISTINCT x.hod_id FROM users x WHERE x.business_group=? AND x.left_at IS NULL "
                                  "AND x.role!='admin' AND COALESCE(x.is_demo,0)=0 AND x.hod_id IS NOT NULL", (BG,))}
s.check("a card for exactly the people who head anyone in the group, the HOD who has left first",
        set(cards) == expect == {H1, H2, H3} and cards[0] == H3, (cards, sorted(expect)))
with a.app.test_request_context("/"):
    with a.app.app_context():
        dd = a.get_db()
        me = dd.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        cmap = {c["id"]: c for c in a._leader_hod_cards(dd, BG, a._leader_dept_map(dd, me, BG))}
h1 = {x["value"]: x for x in cmap[H1]["depts"]}
s.check("a department shared with another HOD is 'part', with how many of how many ('Sales' and ' sales' are one)",
        h1[SALES]["part"] and (h1[SALES]["n"], h1[SALES]["total"]) == (3, 6)
        and {o["name"] for o in h1[SALES]["others"]} == {"ZZ HV ZZHV-H2", None}, h1.get(SALES))
s.check("...a department wholly theirs is not, and their people add up", not h1[OPS]["part"]
        and cmap[H1]["people"] == 5 and cmap[H2]["people"] == 3)
s.check("the cards say it: '3 of 6' with a part chip", re.search(r"3 of 6\s*<span class=\"ld-chip is-split ld-part\">part", pg)
        is not None)
s.check("the coverage chips lead to By department, that state shown (?show=)",
        'view=dept&amp;show=none' in pg or 'show=none&amp;view=dept' in pg)
pgd = cS.get("/admin/leaders?bg=%s&tab=hod&view=dept&show=split" % BG).get_data(as_text=True)
s.check("...where the page starts on it", 'data-sel-show="split"' in pgd and "tr class=\"ld-dept\"" in pgd)
pgB = cB.get("/admin/leaders?tab=hod").get_data(as_text=True)
s.check("the super admin's cards carry Remove (one department, or the whole HOD)",
        pg.count('value="hod_remove_preview"') >= len(cards) * 2 and 'value="hod_remove_preview"' not in pgB)
_pgBd = cB.get("/admin/leaders?tab=hod&view=dept").get_data(as_text=True)
s.check("a BG admin reads the cards but gets no Remove anywhere", 'class="ld-cards"' in pgB
        and 'value="hod_remove_preview"' not in pgB and "data-ld-rm aria-label" not in _pgBd and "data-ld-rmall>" not in _pgBd)

s.section("one header on both views: the switch at a fixed spot, a real search box (Chris, 2026-10-21)")
def _head(page):
    m = re.search(r'<section class="admin-card ld-cover".*?</section>', page, re.S)
    return m.group(0) if m else ""
hh, hd = _head(pg), _head(cS.get("/admin/leaders?bg=%s&tab=hod&view=dept" % BG).get_data(as_text=True))
_shape = lambda h: re.sub(r'(placeholder|aria-label)="[^"]*"|href="[^"]*"|data-ld-\w+(="[^"]*")?|aria-pressed="\w+"|<(a|button)\b|</(a|button)>', "", h)
s.check("both views draw the same header: the counts and the switch on its top line, then the chips, search and Add",
        hh and hd and '<div class="ld-cover-top">' in hh and "ld-view" in hh.split('<div class="ld-cover-row">')[0]
        and "ld-view" in hd.split('<div class="ld-cover-row">')[0]
        and re.sub(r'\s+', ' ', re.sub(r'is-on|aria-current="page"', '', _shape(hh))).count("ld-chip")
        == re.sub(r'\s+', ' ', _shape(hd)).count("ld-chip") == 4)
s.check("...the search is the app's box with a magnifier on both, never a bare input",
        all('<label class="ld-search"><svg' in h and 'class="ld-find"' in h for h in (hh, hd)))
s.check("...Add an HOD in both, and its panel is on the By department page too",
        all("ld-add-btn" in h for h in (hh, hd))
        and 'data-panel="ld-add"' in cS.get("/admin/leaders?bg=%s&tab=hod&view=dept" % BG).get_data(as_text=True))
s.check("...By HOD's search reads each card's name, Employee ID and departments",
        ('data-find="zz hv zzhv-h1 zzhv-h1 ops sales"' in pg or "zzhv-h1" in (re.search(r'id="hod-%d"[^>]*data-find="([^"]*)"' % H1, pg) or [None, ""])[1])
        and "data-ld-cardfind" in hh)
_bu = cS.get("/admin/leaders?bg=%s&tab=buceo" % BG).get_data(as_text=True)
s.check("the CEO tabs use the HOD tab's chips, not the classic uppercase status pills",
        re.search(r'class="ld-chip is-none"[^>]*>Vacant<', _bu) is not None and "status-pill" not in _bu.split('id="ld-bu-table"')[-1].split("</table>")[0])

s.section("an HOD's drawer: departments they head (Change HOD inline, Remove), then the people they head (Chris, 2026-10-28)")
pp = cS.get("/admin/leaders?bg=%s&tab=hod&view=hod&hod=%d&panel=ld-hod" % (BG, H1)).get_data(as_text=True)
s.check("Manage opens their drawer with each department they head, part or whole",
        'data-panel="ld-hod"' in pp and "data-panel-autoopen" in pp and "whole department" in pp and "3 of 6 people" in pp)
dr = pp[pp.index('data-panel="ld-hod"'):]
s.check("the drawer has no Add a department, no Change HOD section (#ld-chg) and no red Remove as HOD box",
        "Add a department" not in dr and 'id="ld-chg"' not in dr and "ld-h-chg" not in dr and "adm-danger" not in dr
        and "Remove as HOD" not in dr, [k for k in ("Add a department", 'id="ld-chg"', "adm-danger", "Remove as HOD") if k in dr])
rows = re.findall(r'<div class="ld-hrow">.*?</form>\s*(?:</div>)?\s*(?=<div class="ld-hrow">|<p class="muted small">Remove takes)', dr, re.S)
s.check("one row per department they head (%d)" % len(cmap[H1]["depts"]), len(rows) == len(cmap[H1]["depts"]) == 2, len(rows))
s.check("...each with exactly one Change HOD and one Remove",
        all(r.count(">Change HOD</button>") == 1 and r.count(">Remove</button>") == 1 for r in rows))
ok_form = True
for r, dep in zip(rows, cmap[H1]["depts"]):
    m = re.search(r'<form method="post" class="adm-pform ld-chg" id="(ld-chg-\d+)" hidden>(.*?)</form>', r, re.S)
    f = m.group(2) if m else ""
    ok_form &= bool(m) and 'name="action" value="hod_preview"' in f and ('name="only" value="%d"' % H1) in f \
        and ('name="dept" value="%s"' % dep["value"]) in f and 'name="tab" value="hod"' in f and 'name="view" value="hod"' in f \
        and ('name="bg" value="%s"' % BG) in f and 'name="hod_id"' in f and "Preview who moves" in f \
        and ("The new HOD for their %d %s here" % (dep["n"], "person" if dep["n"] == 1 else "people")) in f \
        and ('data-ld-change="%s"' % m.group(1)) in r
s.check("...Change HOD opens that card's own hidden form: hod_preview, only=<HOD>, that department's value, the picker, Preview who moves",
        ok_form)
ids = re.findall(r'id="(ld-chg-\d+)"', dr)
s.check("...each form has its own id", len(ids) == len(set(ids)) == 2, ids)
s.check("the note under the cards is reworded", ("Remove takes ZZ HV ZZHV-H1 off that department only: their people there have no HOD until you assign one."
        " To give ZZ HV ZZHV-H1 another department, tick it on") in re.sub(r"\s+", " ", dr) and "Change HOD hands it" not in dr)
sec = dr[dr.index('id="ld-h-ppl"'):]
head_n = int(re.search(r"heads (\d+) (?:person|people)", pp).group(1))
db_n = H.one(a, "SELECT COUNT(*) FROM users WHERE business_group=? AND hod_id=? AND left_at IS NULL AND role!='admin' "
                "AND COALESCE(is_demo,0)=0", (BG, H1))
sec_n = int(re.search(r'data-ldp-count data-total="(\d+)"', sec).group(1))
tr_n = len(re.findall(r"<tr data-ldp-row", sec))
s.check("People they head: its count, the rows in it, the header's 'heads N' and a DB count are one figure",
        sec_n == tr_n == head_n == db_n == cmap[H1]["people"] and head_n > 0, (sec_n, tr_n, head_n, db_n))
s.check("...grouped like the cards: 'Sales · 3 of 6' (part) then 'Ops · 2', in the cards' order",
        [re.sub(r"<[^>]+>", "", g).strip() for g in re.findall(r'<div class="ld-ppl-gh">(.*?)</div>', sec, re.S)]
        == ["Ops · 2", "Sales · 3 of 6"] or [re.sub(r"<[^>]+>", "", g).strip() for g in re.findall(r'<div class="ld-ppl-gh">(.*?)</div>', sec, re.S)]
        == ["Sales · 3 of 6", "Ops · 2"], re.findall(r'<div class="ld-ppl-gh">(.*?)</div>', sec, re.S))
s.check("...columns Name, Employee ID, JG, Job title, official name shown",
        "<th>Name</th><th>Employee ID</th><th>JG</th><th>Job title</th>" in sec and "ZZ HV ZZHV-S1" in sec)
s.check("...Search in: the field choice (All, Name, Employee ID, Job title, Department) and an in-place box, not a name=q form",
        all(('>%s</option>' % w) in sec for w in ("All fields", "Name", "Employee ID", "Job title", "Department"))
        and "data-ldp-q" in sec and 'name="q"' not in sec)
# a big department: folds past the fifth, in the house fold pattern
with a.app.app_context():
    d = a.get_db()
    for i in range(7):
        d.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, "
                  "department, confirmation_date, job_grade, hod_id) VALUES (?,?,'x','user',?,?,?,?,'2022-01-01','16',?)",
                  ("zzhv-m%d" % i, "ZZ HV ZZHV-M%d" % i, "ZZHV-M%d" % i, BG, CA, "Ops", H1))
    # someone who has left and a demo login, both under H1: neither is counted (the cards' own population)
    d.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, department, "
              "confirmation_date, job_grade, hod_id, left_at) VALUES ('zzhv-mx','ZZ HV ZZHV-MX','x','user','ZZHV-MX',?,?,'Ops',"
              "'2022-01-01','16',?,'2026-01-01')", (BG, CA, H1))
    d.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, department, "
              "confirmation_date, job_grade, hod_id, is_demo) VALUES ('zzhv-my','ZZ HV ZZHV-MY','x','user','ZZHV-MY',?,?,'Ops',"
              "'2022-01-01','16',?,1)", (BG, CA, H1))
    d.commit()
pp2 = cS.get("/admin/leaders?bg=%s&tab=hod&view=hod&hod=%d&panel=ld-hod" % (BG, H1)).get_data(as_text=True)
sec2 = pp2[pp2.index('id="ld-h-ppl"'):]
ops_blk = sec2[sec2.index("<b>Ops</b>"):]
ops_blk = ops_blk[:ops_blk.index("</details>")]
s.check("a department of 9 shows 5 and folds the rest: '4 more' in a details.fold with Show less last",
        '<details class="fold ld-ppl-fold">' in ops_blk and "<summary>4 more</summary>" in ops_blk
        and ops_blk.count("<tr data-ldp-row") == 9 and ops_blk.rstrip().endswith("</button>")
        and "data-fold-less" in ops_blk.split("</table>")[-1], ops_blk.count("<tr data-ldp-row"))
s.check("...and the section count still equals the header (%d)" % (head_n + 7),
        'data-ldp-count data-total="%d"' % (head_n + 7) in sec2 and ("heads %d people" % (head_n + 7)) in pp2
        and "ZZHV-MX" not in sec2 and "ZZHV-MY" not in sec2)
with a.app.app_context():
    a.get_db().execute("DELETE FROM users WHERE employee_id LIKE 'ZZHV-M%'"); a.get_db().commit()
ppB = cB.get("/admin/leaders?tab=hod&view=hod&hod=%d&panel=ld-hod" % H1).get_data(as_text=True)
s.check("a View only BG admin's drawer only reads: no Change HOD, no Remove, still the people",
        'data-panel="ld-hod"' in ppB and 'value="hod_remove_preview"' not in ppB and ">Change HOD<" not in ppB
        and 'id="ld-h-ppl"' in ppB)
s.check("the people are computed for the open drawer only (a list page carries none)",
        'id="ld-h-ppl"' not in pg and "<tr data-ldp-row" not in pg)
def _card(page, hid):
    return re.search(r'<article class="admin-card ld-card" id="hod-%d".*?</article>' % hid, page, re.S).group(0)
s.check("HOD list cards: no per-department x on a one-department card, one per department on a card with 2 or more",
        'class="ld-x"' not in _card(pg, H3) and _card(pg, H1).count('class="ld-x"') == 2
        and _card(pg, H2).count('class="ld-x"') == 2)
pa = cS.get("/admin/leaders?bg=%s&tab=hod&view=hod" % BG).get_data(as_text=True)
s.check("the Add an HOD hint says to tick several on By department, not Manage",
        "More departments for the same person: tick several on By department." in pa and "card's Manage" not in pa)

s.section("By department's Assign panel: HOD now and who is in it (Chris, 2026-11-03, option A of canvas TerhpkBhfoAzgVk4zVHbMQ)")
DEPT_PAT = re.compile(r'<script type="application/json" id="ld-dept-data">(.*?)</script>', re.S)


def dept_data(client, bg=BG, view="dept"):
    """(parsed JSON or None, count of script tags) from a Leaders HOD page."""
    pg_ = client.get("/admin/leaders?bg=%s&tab=hod&view=%s" % (bg, view)).get_data(as_text=True)
    found = DEPT_PAT.findall(pg_)
    return (json.loads(found[0]) if found else None), len(found), pg_


def want_people(co_filter=None):
    """{department value: {hod_id or None: {employee_id: (name, grade)}}} from a fresh read of the database."""
    out = {}
    for r in H.rows(a, "SELECT full_name, employee_id, job_grade, company, department, hod_id FROM users WHERE business_group=? "
                       "AND role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0", (BG,)):
        if co_filter is not None and r[3] not in co_filter:
            continue
        out.setdefault("%s||%s" % (r[3] or "", a._dept_key(r[4])), {}).setdefault(r[5], {})[r[1]] = (r[0], r[2])
    return out


# someone who has left, a demo login and an admin account in Sales: none of them may be listed (the cards' population)
with a.app.app_context():
    d = a.get_db()
    for k_, extra in (("X1", "left_at='2026-01-01'"), ("X2", "is_demo=1"), ("X3", "role='admin'")):
        d.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, department, "
                  "confirmation_date, job_grade, hod_id) VALUES (?,?,'x','user',?,?,?,?,'2022-01-01','16',?)",
                  ("zzhv-" + k_.lower(), "ZZ HV ZZHV-" + k_, "ZZHV-" + k_, BG, CA, "Sales", H1))
        d.execute("UPDATE users SET %s WHERE employee_id=?" % extra, ("ZZHV-" + k_,))
    d.commit()
dd, n_tags, pgdd = dept_data(cS)
s.check("the By department page carries the panel's data ONCE, as JSON in a script tag (not markup)",
        dd is not None and n_tags == 1 and "<script type=\"application/json\" id=\"ld-dept-data\">" in pgdd)
want = want_people()
s.check("it holds every department the table lists, no more", set(dd) == set(want) == set(re.findall(
        r'<input type="checkbox" name="dept" value="([^"]+)"', pgdd)), (sorted(dd), sorted(want)))
ok_g = ok_n = ok_sort = ok_order = ok_flags = True
bad_g = []
for val, dep in dd.items():
    hs = dep["hods"]
    got = {h["id"]: {p[1]: (p[0], p[2]) for p in h["people"]} for h in hs}
    ok_g &= got == want[val] and len(hs) == len(want[val])
    ok_n &= all(h["n"] == len(h["people"]) == len(want[val][h["id"]]) for h in hs)
    ok_sort &= all([p[0].lower() for p in h["people"]] == sorted(p[0].lower() for p in h["people"]) for h in hs)
    ok_order &= [h["n"] for h in hs] == sorted((h["n"] for h in hs), reverse=True)
    if got != want[val]:
        bad_g.append(val)
s.check("each department's people, grouped by HOD, equal a fresh count by hod_id (id, name and grade as stored)", ok_g, bad_g)
s.check("...each entry's n is its people; the most people first; names A to Z in each", ok_n and ok_order and ok_sort)
s.check("...every person of the group is in exactly one department's group",
        sum(len(h["people"]) for dep in dd.values() for h in dep["hods"])
        == H.one(a, "SELECT COUNT(*) FROM users WHERE business_group=? AND role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0", (BG,)))
every_eid = {p[1] for dep in dd.values() for h in dep["hods"] for p in h["people"]}
s.check("nobody who has left, no admin account and no demo login is listed",
        not {"ZZHV-X1", "ZZHV-X2", "ZZHV-X3"} & every_eid and {"ZZHV-S1", "ZZHV-O1"} <= every_eid, sorted(every_eid & {"ZZHV-X1", "ZZHV-X2", "ZZHV-X3"}))
sal = {h["id"]: h for h in dd[SALES]["hods"]}
fin = {h["id"]: h for h in dd[FIN]["hods"]}
hr_ = {h["id"]: h for h in dd[CB + "||hr"]["hods"]}
mgmt = dd[CA + "||management"]["hods"]
s.check("the states the line needs: Sales split three ways (H1 3, H2 2, none 1), Finance split with the no-HOD entry (id null)",
        (len(sal), sal[H1]["n"], sal[H2]["n"], sal[None]["n"]) == (3, 3, 2, 1) and set(fin) == {H2, None}
        and fin[None]["name"] == "none", {k: v["n"] for k, v in sal.items()})
s.check("...an HOD who has left carries left=true (HR), a department with nobody's HOD is one null entry",
        hr_[H3]["left"] is True and len(hr_) == 1 and not sal[H1]["left"]
        and len(mgmt) == 1 and mgmt[0]["id"] is None and mgmt[0]["n"] == 2, hr_)
s.check("...a person's row is [name, Employee ID, grade] exactly as stored",
        ["ZZ HV ZZHV-S1", "ZZHV-S1", "16"] in [[p_[0], p_[1], str(p_[2])] for p_ in sal[H1]["people"]])
dd_h, n_h, pg_h = dept_data(cS, view="hod")
s.check("the By HOD view does not carry it (the people are for the Assign panel only)", dd_h is None and n_h == 0
        and 'type="application/json" id="ld-dept-data"' not in pg_h)
dd_v, n_v, _pg_v = dept_data(cB)
s.check("...nor does a View only admin's By department page (no Assign right, no data)", dd_v is None and n_v == 0)
# the data does not change what the table says (one population, one map)
with a.app.test_request_context("/"):
    with a.app.app_context():
        dd_ = a.get_db()
        me_ = dd_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        dmap = a._leader_dept_map(dd_, me_, BG)
s.check("_leader_dept_map's other readers are unmoved: the same keys as before, plus people, and each count is its people",
        all({"company", "key", "label", "n", "hods", "value", "people"} == set(x) for x in dmap)
        and all(x["n"] == len(x["people"]) == sum(h["n"] for h in x["hods"]) for x in dmap))
# a unit-scoped admin who may assign (a custom role with Assign HODs ticked, given Alpha only) gets nothing of Beta
with a.app.app_context():
    d = a.get_db()
    d.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?,?)", (BGA, CA))
    rid_ = d.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZHV assign', 'units')").lastrowid
    for it_ in set(a.role_preset_items("view")) | {"leaders.hod"}:
        d.execute("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", (rid_, it_))
    d.execute("UPDATE users SET admin_role_id=? WHERE id=?", (rid_, BGA))
    d.commit()
dd_b, n_b, pg_b = dept_data(cB)
if dd_b is not None:
    got_b = {p[1] for dep in dd_b.values() for h in dep["hods"] for p in h["people"]}
    beta_eids = {r[0] for r in H.rows(a, "SELECT employee_id FROM users WHERE business_group=? AND company=? AND left_at IS NULL "
                                         "AND role!='admin' AND COALESCE(is_demo,0)=0", (BG, CB))}
    s.check("a unit-scoped admin's data holds only the units they reach: Alpha's departments and people, nobody of Beta",
            set(dd_b) == set(want_people({CA})) and got_b and not (got_b & beta_eids)
            and all(v.startswith(CA + "||") for v in dd_b), (sorted(dd_b), len(got_b & beta_eids)))
else:
    s.check("a unit-scoped admin who can assign gets the data for their units only", False, "no ld-dept-data on the BG admin's page")
# falsify: with the access filter gone the same check FAILS, so it does test the filter
real_can_access = a.can_access
try:
    a.can_access = lambda *_x, **_k: True
    with a.app.test_request_context("/"):
        with a.app.app_context():
            dd_ = a.get_db()
            bga_ = dd_.execute("SELECT * FROM users WHERE id=?", (BGA,)).fetchone()
            leaky = a._leader_dept_panel_data(a._leader_dept_map(dd_, bga_, BG))
finally:
    a.can_access = real_can_access
leak_eids = {p[1] for dep in leaky.values() for h in dep["hods"] for p in h["people"]}
s.check("falsified: drop can_access and the scoped check fails (Beta's people leak in), so it holds only because of the filter",
        bool(leak_eids & {r[0] for r in H.rows(a, "SELECT employee_id FROM users WHERE business_group=? AND company=?", (BG, CB))}))
with a.app.app_context():
    a.get_db().execute("DELETE FROM admin_companies WHERE admin_id=?", (BGA,))
    a.get_db().execute("UPDATE users SET admin_role_id=NULL WHERE id=?", (BGA,))
    a.get_db().execute("DELETE FROM admin_role_access WHERE role_id IN (SELECT id FROM admin_roles WHERE name='ZZHV assign')")
    a.get_db().execute("DELETE FROM admin_roles WHERE name='ZZHV assign'")
    a.get_db().execute("DELETE FROM users WHERE employee_id IN ('ZZHV-X1','ZZHV-X2','ZZHV-X3')")
    a.get_db().commit()
s.check("the panel's script reads it with JSON.parse and builds every name as text (no innerHTML of a name)",
        "JSON.parse(ddEl.textContent)" in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "templates",
                                                            "admin_leaders.html"), encoding="utf-8").read()
        and "innerHTML = " not in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "templates",
                                                    "admin_leaders.html"), encoding="utf-8").read().split("var hodNow")[1].split("var count")[0])

s.section("Remove one HOD from one department: only their people there")
before = hods()
html, uids, fp = preview(cS, action="hod_remove_preview", from_hod=H1, dept=[SALES])
s.check("the preview is write-free and names exactly H1's three in Sales, not H2's",
        hods() == before and uids == {P["s1"], P["s2"], P["s3"]}, sorted(uids))
s.check("...as a removal: 'No HOD', the red confirm", "No HOD" in html and 'data-confirm-tone="danger"' in html
        and 'value="hod_remove_apply"' in html)
r = post(cS, action="hod_remove_apply", bg=BG, tab="hod", view="hod", from_hod=H1, dept=[SALES], fingerprint=fp, ack="1",
         uid=[str(x) for x in uids])
after = hods()
s.check("applied: those three have no HOD, nobody else changed", changed(before, after) == uids
        and all(after[x] is None for x in uids) and after[P["s4"]] == H2 and after[P["o1"]] == H1, changed(before, after))
s.check("...one audit row each ('-> none') plus a summary", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action="
        "'hod_assign' AND detail LIKE '%-> none' AND target_user_id IN (?,?,?)", tuple(uids)) == 3
        and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='hod_assign_summary' AND target_user_id=? AND detail "
                     "LIKE 'HOD removed: 3 people in ZZHV BG have no HOD now (from ZZ HV ZZHV-H1)'", (H1,)) == 1)
s.check("...and it goes back to By HOD", r.status_code == 302 and "view=hod" in r.headers.get("Location", ""))

s.section("Remove as HOD: every department of theirs")
before = hods()
html, uids, fp = preview(cS, action="hod_remove_preview", from_hod=H2, dept=[SALES, FIN])
s.check("names exactly H2's people in both departments, and warns they head no one after", uids == {P["s4"], P["s5"], P["f1"]}
        and "will head no one after this" in html, sorted(uids))
post(cS, action="hod_remove_apply", bg=BG, tab="hod", view="hod", from_hod=H2, dept=[SALES, FIN], fingerprint=fp, ack="1",
     uid=[str(x) for x in uids])
after = hods()
s.check("applied, nobody else changed, and H2's card is gone", changed(before, after) == uids
        and ('id="hod-%d"' % H2) not in cS.get("/admin/leaders?bg=%s&tab=hod" % BG).get_data(as_text=True))

s.section("By department's Remove: everyone in the ticked departments")
before = hods()
html, uids, fp = preview(cS, action="hod_remove_preview", view="dept", dept=[OPS, QUAL])
s.check("names everyone there with an HOD (Quality has none)", uids == {P["o1"], P["o2"]}, sorted(uids))
post(cS, action="hod_remove_apply", bg=BG, tab="hod", view="dept", dept=[OPS, QUAL], fingerprint=fp, ack="1",
     uid=[str(x) for x in uids])
s.check("applied, nobody else changed", changed(before, hods()) == uids)
s.check("a department with nobody to remove says so and writes nothing",
        "Nobody there has an HOD to remove" in post(cS, action="hod_remove_preview", bg=BG, tab="hod", dept=[QUAL]).get_data(as_text=True))
pgd = cS.get("/admin/leaders?bg=%s&tab=hod&view=dept" % BG).get_data(as_text=True)
s.check("By department: Remove on a row with an HOD only, and on the ticked bar",
        "data-ld-rmall" in pgd and pgd.count("data-ld-rm ") == len(re.findall(r'data-state="(?:set|split|left)"', pgd)))

s.section("Add an HOD's preview (Add an HOD panel): everyone in it, or only those with no HOD now")
with a.app.app_context():
    a.get_db().execute("UPDATE users SET hod_id=? WHERE id=?", (H3, P["s4"])); a.get_db().commit()   # s4 keeps one
before = hods()
html, uids, fp = preview(cS, action="hod_preview", hod_id=H1, only="unset", dept=[SALES])
s.check("only=unset: everyone in Sales with no HOD, never s4 who has one",
        uids == {P["s1"], P["s2"], P["s3"], P["s5"], P["s6"]}, sorted(uids))
post(cS, action="hod_apply", bg=BG, tab="hod", view="hod", hod_id=H1, only="unset", dept=[SALES], fingerprint=fp, ack="1",
     uid=[str(x) for x in uids])
after = hods()
s.check("applied: they have H1, s4 kept theirs", changed(before, after) == uids and after[P["s4"]] == H3)
pgd = cS.get("/admin/leaders?bg=%s&tab=hod&view=dept" % BG).get_data(as_text=True)
m = re.search(r'<tr class="ld-dept"[^>]*data-state="(\w+)"[^>]*>(?:(?!</tr>).)*?<td class="ld-dname">Sales</td>(?:(?!</tr>).)*?</tr>',
              pgd, re.S)
n_h1 = sum(1 for k in ("s1", "s2", "s3", "s5", "s6") if after[P[k]] == H1)
s.check("By department: a split department whose HOD has left names each HOD with their count, never run together",
        m is not None and m.group(1) == "left" and "ZZ HV ZZHV-H1 (%d) · ZZ HV ZZHV-H3 (1)" % n_h1 in m.group(0)
        and "Has left" in m.group(0), m.group(0)[-400:] if m else None)
html, uids_all, _fp = preview(cS, action="hod_preview", hod_id=H2, dept=[SALES])
s.check("everyone (the default): the whole department moves, s4 included", P["s4"] in uids_all and len(uids_all) == 6)
_html, _u, fp_wrong = preview(cS, action="hod_preview", hod_id=H1, only="unset", dept=[SALES])
r = post(cS, action="hod_apply", bg=BG, tab="hod", hod_id=H1, dept=[SALES], fingerprint=fp_wrong or "x", ack="1",
         uid=[str(P["s4"])])
s.check("a preview's fingerprint holds its narrowing: one made for 'only unset' can't apply to everyone",
        hods()[P["s4"]] == H3, r.status_code)

s.section("Change HOD: one HOD's part of a shared department, never a colleague's")
before = hods()
html, uids, fp = preview(cS, action="hod_preview", hod_id=H2, only=str(H1), dept=[SALES])
s.check("only=H1: H1's people in Sales move to H2, s4 (H3's) doesn't", uids == {P["s1"], P["s2"], P["s3"], P["s5"], P["s6"]}
        and P["s4"] not in uids, sorted(uids))
post(cS, action="hod_apply", bg=BG, tab="hod", view="hod", hod_id=H2, only=str(H1), dept=[SALES], fingerprint=fp, ack="1",
     uid=[str(x) for x in uids])
after = hods()
s.check("applied, nobody else changed", changed(before, after) == uids and all(after[x] == H2 for x in uids))

s.section("a submitted department review blocks a removal; the super admin may go on with a reason")
with a.app.app_context():
    d = a.get_db()
    d.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, locked_at, "
              "locked_by) VALUES (?, 'hod', ?, ?, 'x', datetime('now'), ?)", (CID, str(H2), BG, SU["id"]))
    d.commit()
before = hods()
html, uids, fp = preview(cS, action="hod_remove_preview", from_hod=H2, dept=[SALES])
s.check("the preview names the blocker", "department review is submitted" in html and "Reason to apply it anyway" in html)
post(cS, action="hod_remove_apply", bg=BG, tab="hod", from_hod=H2, dept=[SALES], fingerprint=fp, ack="1",
     uid=[str(x) for x in uids])
s.check("without a reason: refused, nothing written", hods() == before)
post(cS, action="hod_remove_apply", bg=BG, tab="hod", from_hod=H2, dept=[SALES], fingerprint=fp, ack="1",
     uid=[str(x) for x in uids], override_reason="ZZHV the department moved; the new HOD reviews it again")
s.check("with one: applied, and the override logged", changed(before, hods()) == uids
        and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='hod_assign_override' AND detail LIKE "
                     "'Removing an HOD: ZZHV%'") == 1)
with a.app.app_context():
    a.get_db().execute("DELETE FROM pm_calibration_sessions WHERE scope_key=? AND tier='hod'", (str(H2),)); a.get_db().commit()

s.section("removing is the super admin's")
with a.app.app_context():
    a.get_db().execute("UPDATE users SET hod_id=? WHERE id IN (?,?)", (H1, P["o1"], P["o2"])); a.get_db().commit()
before = hods()
html, uids, fp = preview(cS, action="hod_remove_preview", dept=[OPS])
rp = post(cB, action="hod_remove_preview", bg=BG, tab="hod", dept=[OPS])
ra = post(cB, action="hod_remove_apply", bg=BG, tab="hod", dept=[OPS], fingerprint=fp, ack="1", uid=[str(x) for x in uids])
s.check("a BG admin's preview and apply are refused, nothing written", hods() == before
        and rp.status_code in (302, 403) and ra.status_code in (302, 403), (rp.status_code, ra.status_code))
with a.app.test_request_context("/admin/leaders", method="POST", data={"action": "hod_remove_apply"}):
    need = a.admin_access_need("admin_leaders", {"action": "hod_remove_apply"})
s.check("the access map says super for both removal steps", need == "super"
        and a.admin_access_need("admin_leaders", {"action": "hod_remove_preview"}) == "super")
s.check("Roles & access names it among the super admin's", any("Removing an HOD" in x for x in a.ADMIN_SUPER_ROWS["leaders"]))

s.section("the By HOD search hides cards -- a display rule beats [hidden]")
_css = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "style.css"), encoding="utf-8").read()
s.check(".ld-card[hidden] is display:none, so the header search can narrow the cards",
        re.search(r"\.ld-card\[hidden\]\s*\{[^}]*display:\s*none", _css) is not None)

s.section("cleanup -- the harness database is shared with the suites after this one")
with a.app.app_context():
    clean(a.get_db())
s.check("nothing this suite made is left behind",
        H.one(a, "SELECT COUNT(*) FROM users WHERE employee_id LIKE 'ZZHV-%' OR username='zzhv_bga'") == 0
        and H.one(a, "SELECT COUNT(*) FROM org_units WHERE business_group LIKE 'ZZHV%'") == 0)
sys.exit(s.done())
