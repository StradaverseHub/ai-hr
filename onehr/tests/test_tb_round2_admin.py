"""Talent Box Round 2 -- the admin page (Chris, 2026-11-14, canvas boards A-E, I, J; plan: OneHR/Talent Box Round 2 2026-11-14/BUILD-PLAN.md,
piece 2). The back end is tests/test_tb_round2.py; this suite holds what the ADMIN TALENT BOX PAGE draws and offers in each state of a
unit's Round 2, for the super admin and for a BG admin:

  * the "Round 1 · Forecast | Round 2 · Actual" toggle (left of Grid / List), its address keeping the unit and the filters
  * Round 1 is the record: a unit with a round shows the placements as the BG CEO locked them (the Round 1 marks), the forecast PAT and
    its curve, nobody shown as moved; Round 2 shows the live box, who moved since Round 1, and the actual PAT
  * each state's strip: not locked yet / the actual PAT form (super admin only) / read only for a BG admin / same curve / curve shifted
    with Do Round 2 here and Push to BG CEO (lock-by day defaults to 5 working days, never in the past) / admin round (editable: Suggest
    with AI, Lock Round 2) / pushed (read only, lock-by day, Remind) / due (the super admin finishes it) / locked
  * every write form is the app's double confirm (data-confirm) and the band-moving ones ask the super admin's remark; a BG admin gets no
    form and no editable card; the AI strip, "+n suggested" and "AI: -> ME" are drawn by the page's script only after Suggest with AI
  * PAT Ref: a unit the BG CEO has locked is read only there, with the link to Round 2 · Actual
Its own synthetic business group on the SHARED suite database (ZZR2A-*); everything is put back at the end."""
import html as _html
import json
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Talent Box Round 2 -- the admin page: the toggle, each state's strip, the forms, read only for a BG admin")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA0, _E = H.actors(a)
BG = "ZZR2A Group"
Q = {k: "ZZR2A %s" % k for k in ("Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel")}
QN, QW, QS, QA, QP, QD, QL, QU = (Q[k] for k in ("Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"))
# Alpha: locked, no actual yet. Bravo: curve shifted, waiting. Charlie: same curve. Delta: an admin round. Echo: pushed, open.
# Foxtrot: pushed, past its lock-by day. Golf: Round 2 locked. Hotel: never locked by the BG CEO.
PFX = "ZZR2A-"
REASON = "ZZR2A the actual PAT is in"
XHR = {"X-Requested-With": "XMLHttpRequest", "Sec-Fetch-Mode": "cors"}

with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    PER = a.active_pm_period(db)["id"]
    db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZR2A-%'")   # a run that died half-way
    _ORIG = {"half": db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0],
             "settings": {k: (r[0] if r else None) for k in ("ai_calib", "review_unified", "tb_limit_moves_on", "tb_limit_moves_pct",
                                                              "tb_limit_stars_on")
                          for r in [db.execute("SELECT value FROM app_settings WHERE key=?", (k,)).fetchone()]},
             "modules": {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=? "
                                                         "AND module_key IN ('review','calibration','pm','tm')", (CID,))},
             "windows": [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=? AND cell='tb_bgceo'", (CID,))],
             "max": {tb: db.execute("SELECT COALESCE(MAX(id),0) FROM %s" % tb).fetchone()[0]
                     for tb in ("calibration_sessions", "pm_calibration_sessions", "calibration_adjustments",
                                "pm_calibration_adjustments", "pm_kpi_targets", "activity_log", "email_outbox", "late_passes",
                                "notifications")}}
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','calibration','pm','tm')", (CID,))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='tb_bgceo'", (CID,))   # open all cycle
    for k in ("ai_calib", "review_unified"):
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,'1')", (k,))
    for k in ("tb_limit_moves_on", "tb_limit_stars_on"):
        db.execute("DELETE FROM app_settings WHERE key=?", (k,))
    for co in Q.values():
        db.execute("INSERT OR IGNORE INTO org_units(business_group, company, active) VALUES (?,?,1)", (BG, co))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, name, company, email=None, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=email, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=company)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        uid = db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group) "
                   "VALUES (?,?,?,100,'more','approved',?)", (PER, uid, "ZZR2A KPI", BG))
        return uid
    BOSS = person(PFX + "CEO", "ZZ R2A Group CEO", QN, bgceo_bg=BG, email="zzr2a-ceo@example.test")
    BGADM = person(PFX + "ADM", "ZZ R2A BG Admin", None, role="admin", admin_bg=BG, email="zzr2a-adm@example.test")
    SPEC = {QN: [("ME", "Mid")] * 2, QW: [("ME", "Mid"), ("ME", "Mid"), ("AE", "Mid"), ("BE", "Low")], QS: [("ME", "Mid")] * 2,
            QA: [("ME", "Mid")] * 3 + [("AE", "Mid"), ("BE", "Low")], QP: [("ME", "Mid")] * 2, QD: [("ME", "Mid")] * 2,
            QL: [("ME", "Mid"), ("ME", "Mid"), ("BE", "Low")], QU: [("ME", "Mid")] * 2}
    P = {}
    for co, specs in SPEC.items():
        P[co] = [person("%s%s%d" % (PFX, co.split()[-1][:3].upper(), i), "ZZ R2A %s %d" % (co.split()[-1], i), co)
                 for i in range(len(specs))]
    # their BU CEOs banded and locked both axes (the BG CEO's lock pins what the box shows)
    for co, ids in P.items():
        pa = a._pm_calib_get_or_create_session(db, PER, "buceo", co, BG, co)
        ca = a._get_or_create_calibration_session(db, CID, "buceo", co, BG, co)
        for sid, (pb, qb) in zip(ids, SPEC[co]):
            a._pm_calib_upsert_adjustment(db, pa["id"], sid, "", pb, "BU set", BOSS)
            a._calibration_upsert_adjustment(db, ca["id"], sid, "", qb, "BU set", BOSS)
        db.execute("UPDATE pm_calibration_sessions SET locked_at=CURRENT_TIMESTAMP WHERE id=?", (pa["id"],))
        db.execute("UPDATE calibration_sessions SET locked_at=CURRENT_TIMESTAMP WHERE id=?", (ca["id"],))
        db.execute("INSERT OR REPLACE INTO pm_pbt_achievement(cycle_id, business_group, company, achievement_pct) VALUES (?,?,?,85)",
                   (PER, BG, co))
    db.commit()
    SUROW = dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())

a.mailer.is_configured = lambda: True      # the push's email queues (the sender is never started: _outbox_kick is stubbed)
a._outbox_kick = lambda *x, **k: False


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def exe(sql, args=()):
    def f(d):
        d.execute(sql, args)
        d.commit()
    ctx(f)


def one(sql, args=()):
    return H.one(a, sql, args)


def rnd(co):
    return ctx(lambda d: dict(a._tb_round_row(d, PER, BG, co) or {}))


def state(co):
    return ctx(lambda d: a._tb_round_state(a._tb_round_row(d, PER, BG, co)))


SUP, BOSSC, BGAC = H.client_as(a, SU["id"]), H.client_as(a, BOSS), H.client_as(a, BGADM)
EMPC = H.client_as(a, P[QW][0])
URL = "/admin/calibration/talent-box/round2/"


def post(c, url, **d):
    d.setdefault("csrf_token", "tok")
    return c.post(url, data=d, headers=XHR)


def js(r):
    try:
        return r.get_json() or {}
    except Exception:   # noqa: BLE001
        return {}


def doit(c, ep, co, **d):
    return js(post(c, URL + ep, bg=BG, company=co, **d))


def tblock(co):
    return js(post(BOSSC, "/talent-box/bg/%s/lock" % BG, company=co, ajax="1"))


def move(sid, perf=None, pot=None, rid=None):
    d = {"subject_id": str(sid)}
    if perf:
        d["performance_band"] = perf
    if pot:
        d["potential_band"] = pot
    if rid:
        d["round_id"] = str(rid)
    return js(post(SUP, "/talent-box/bg/%s/move" % BG, **d))


def get(c, co, rd=2, extra=""):
    r = c.get("/admin/calibration/talent-box?bg=%s&company=%s%s%s" % (BG.replace(" ", "+"), co.replace(" ", "+"),
                                                                       "&round=2" if rd == 2 else "", extra))
    html = r.get_data(as_text=True)
    m = re.search(r'<script type="application/json" id="atb-data">(.*?)</script>', html, re.S)
    return r.status_code, html, (json.loads(m.group(1)) if m else None)


def text_of(html, pat):
    m = re.search(pat, html, re.S)
    return re.sub(r"<[^>]+>", " ", m.group(0)) if m else ""


def strip_of(html):
    """The Round 2 strip's markup (from its opening tag to the filter line)."""
    m = re.search(r'<div class="atb-r2[^"]*" id="atb-r2".*?<div class="rv-tbox-filter"', html, re.S)
    return m.group(0) if m else ""


def forms_of(html):
    return re.findall(r"<form\b[^>]*>", html)


def snap_of(co):
    """{person id: (perf, pot, category)} of the BG CEO's box as it reads now (what Round 1 locked, before any Round 2 move)."""
    def f(d):
        c_ = a._talent_box_resolve(d, SUROW, "bgceo", admin_view=True, bg=BG)
        return {r["user"]["id"]: (r["perf_band"], r["pot_band"], r["category"]) for r in a.talent_box_rows(d, c_)}
    return ctx(f)


def cell_counts(payload):
    return {c["key"]: c["n"] for c in payload["cells"]}


# ======================================================================================================================
# set the states up through the real routes: Round 1 locks, the actual PATs, the choices
for co in (QN, QW, QS, QA, QP, QD, QL):
    r = tblock(co)
    assert r.get("ok"), (co, r)
R1 = snap_of(None)   # the box as the BG CEO locked it
for co in (QW, QS, QA, QP, QD, QL):
    r = doit(SUP, "actual", co, actual_pct="90" if co == QS else "62", remark=REASON)
    assert r.get("ok"), (co, r)
due = (a._today_myt() + timedelta(days=4)).isoformat()
assert doit(SUP, "open", QA, mode="admin", remark=REASON).get("ok")
assert doit(SUP, "open", QP, mode="bgceo", remark=REASON, due_on=due).get("ok")
assert doit(SUP, "open", QD, mode="bgceo", remark=REASON, due_on=due).get("ok")
exe("UPDATE tb_rounds SET due_at=datetime('now','-2 days') WHERE business_group=? AND company=?", (BG, QD))
assert doit(SUP, "open", QL, mode="admin", remark=REASON).get("ok")
RID_A, RID_L = rnd(QA)["id"], rnd(QL)["id"]
assert move(P[QA][0], perf="AE", rid=RID_A).get("ok") and move(P[QA][1], perf="BE", rid=RID_A).get("ok")   # Delta: two moved since Round 1
assert doit(SUP, "lock", QL, round_id=str(RID_L)).get("ok")
s.check("set up: Alpha none, Bravo waiting, Charlie same, Delta admin round, Echo pushed, Foxtrot due, Golf locked, Hotel never locked",
        [state(c) for c in (QN, QW, QS, QA, QP, QD, QL, QU)] == ["none", "waiting", "same", "open", "open", "due", "locked", "none"],
        [state(c) for c in (QN, QW, QS, QA, QP, QD, QL, QU)])

# ======================================================================================================================
s.section("the toggle")
code, h, pl = get(SUP, QW, 2)
s.check("the page draws, with the card's data", code == 200 and pl and pl["round"] == 2)
s.check("a 'Round' group sits in the title bar BEFORE the Grid / List group, its two links reading 'Round 1 · Forecast' and 'Round 2 · Actual'",
        re.search(r'aria-label="Round">.*?Round 1 &middot; Forecast</a>.*?Round 2 &middot; Actual</a>\s*</div>\s*<div class="rv-tbox-views" role="group" aria-label="View"', h, re.S))
s.check("on Round 2 the second link is the current one (aria-current), on Round 1 the first",
        re.search(r'href="[^"]*round=2"[^>]*aria-current="page"', h) is not None
        and 'aria-current' not in re.search(r'<a class="rv-tbox-view" href="[^"]*"[^>]*>Round 1', h).group(0)
        and re.search(r'<a class="rv-tbox-view" href="[^"]*" aria-current="page"[^>]*>Round 1', get(SUP, QW, 1)[1]))
code, h1, _p = get(SUP, QW, 2, "&dept=Nope")
hrefs = re.findall(r'<a class="rv-tbox-view" href="([^"]*)"', h)
s.check("each link keeps the business group and the unit; Round 1's has no round param, Round 2's has round=2",
        len(hrefs) == 2 and all("bg=" in x and "company=" in x for x in hrefs) and "round=" not in hrefs[0].replace("&amp;", "&")
        and "round=2" in hrefs[1].replace("&amp;", "&"), hrefs)
code, hf, _p = get(SUP, QW, 2, "&cc=ZZ")
hrefs_f = re.findall(r'<a class="rv-tbox-view" href="([^"]*)"', hf)
s.check("...and a filter pick on the address rides on both", all("cc=ZZ" in x for x in hrefs_f), hrefs_f)
s.check("the toggle shows for a BG admin too (they read Round 2)", get(BGAC, QW, 2)[0] == 200 and "Round 2 &middot; Actual" in get(BGAC, QW, 2)[1])
s.check("an employee is refused the page, and the Round 2 view with it", EMPC.get("/admin/calibration/talent-box?round=2").status_code in (302, 403))

# ======================================================================================================================
s.section("Round 1 is the record; Round 2 is the live box")
code, h1, p1 = get(SUP, QA, 1)
code, h2, p2 = get(SUP, QA, 2)
snapA = {k: v for k, v in R1.items() if k in P[QA]}
r1_cells = {}
for pid, (pf, pt, cat) in snapA.items():
    k = "%s|%s" % (a.TALENT_PERF_GROUP_OF[pf], pt)
    r1_cells[k] = r1_cells.get(k, 0) + 1
s.check("Delta's admin round: Round 1 shows the placements as the BG CEO locked them (the Round 1 marks), nobody moved",
        {k: v for k, v in cell_counts(p1).items() if v} == r1_cells and p1["moved_n"] == 0
        and not any(p["moved"] for c in p1["cells"] for p in c["people"]), (cell_counts(p1), r1_cells))
s.check("...and Round 2 is the live box: the two people the admin moved are different cells, counted as moved since Round 1, each with where they were",
        {k: v for k, v in cell_counts(p2).items() if v} != r1_cells and p2["moved_n"] == 2
        and sorted(p["from_cat"] for c in p2["cells"] for p in c["people"] if p["moved"]) == sorted(
            R1[P[QA][i]][2] for i in (0, 1)), (cell_counts(p2), p2["moved_n"]))
s.check("Round 1 reads the forecast PAT and the Normal curve: the title count says 85%, the curve cards the forecast; Round 2 the actual 62%",
        p1["pat"] == 85.0 and p2["pat"] == 62.0 and p1["perf_curve"]["curve"]["label"] == "Normal"
        and p2["perf_curve"]["curve"]["label"] == "Negatively skewed", (p1["pat"], p2["pat"], p1["perf_curve"]["curve"], p2["perf_curve"]["curve"]))
s.check("Round 1's curve spread is the record's (the marks counted), not the live box's",
        sum(p1["perf_curve"]["distribution"].values()) == 5 and p1["perf_curve"]["distribution"] != p2["perf_curve"]["distribution"],
        (p1["perf_curve"]["distribution"], p2["perf_curve"]["distribution"]))
code, hn, pn = get(SUP, QN, 1)
live = ctx(lambda d: a._talent_box_resolve(d, SUROW, "bgceo", admin_view=True, bg=BG)) and True
s.check("a unit with no round row (Alpha, no actual yet) shows Round 1 as today: no strip, the lock in today's words",
        'id="atb-r2"' not in hn and re.search(r'id="atb-lock"[^>]*>Locked by .*? \u00b7 \d', hn) and pn["round"] == 1)
code, hu, _pu = get(SUP, QU, 1)
s.check("...and a unit the BG CEO has not locked says so, as today", "Not locked yet: the BG CEO is still placing" in hu)
code, hs, _ps = get(SUP, QS, 1)
s.check("a unit with a round row (Charlie) gets a grey note on Round 1: the record, read only, with the link to Round 2",
        'class="atb-r2 is-grey" id="atb-r2"' in hs and "Read only: the record Round 2 starts from" in hs and "forecast PAT <b>85%</b>" in hs)
s.check("Round 1's foot says Round 1 locked", "Round 1 locked by " in text_of(hs, r'id="atb-lock".*?</span>'))

# ======================================================================================================================
s.section("each unit's pill")
code, h, pl = get(SUP, QW, 2)
pills = re.findall(r'<a class="rv-tbox-bu[^"]*"[^>]*>(.*?)</a>', h, re.S)
pt = {re.sub(r"<[^>]+>", "", x).split("PAT")[0].strip(): re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", x)).strip() for x in pills}
s.check("Round 2: a unit with an actual reads 'PAT 85% → 62%' with its state's tag (Curve shifted / Round 2 · admin / With the BG CEO / Past lock-by day / Round 2 ✓)",
        "PAT 85% → 62%" in pt.get(QW, "") and "Curve shifted" in pt[QW] and "Round 2 · admin" in pt[QA]
        and "With the BG CEO" in pt[QP] and "Past lock-by day" in pt[QD] and "Round 2 ✓" in pt[QL], pt)
s.check("...a same-curve unit shows the figures and no tag; a unit with no actual shows its forecast",
        "PAT 85% → 90%" in pt[QS] and "Curve" not in pt[QS] and "Round" not in pt[QS] and "→" not in pt[QN] and "PAT 85%" in pt[QN], pt)
code, h1, _p = get(SUP, QW, 1)
pills1 = {re.sub(r"<[^>]+>", "", x).split("PAT")[0].strip(): re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", x)).strip()
          for x in re.findall(r'<a class="rv-tbox-bu[^"]*"[^>]*>(.*?)</a>', h1, re.S)}
s.check("Round 1: the same unit reads the FORECAST ('PAT 85%', no arrow, no tag), as the BG CEO locked it",
        all("→" not in v and "PAT 85%" in v and "Curve shifted" not in v for v in pills1.values()), pills1)
s.check("a pill's link carries round=2 in the Round 2 view and not in Round 1",
        all("round=2" in x for x in re.findall(r'<a class="rv-tbox-bu[^"]*" href="([^"]*)"', h))
        and not any("round=2" in x for x in re.findall(r'<a class="rv-tbox-bu[^"]*" href="([^"]*)"', h1)))

# ======================================================================================================================
s.section("Round 2 strips, one state at a time (the super admin's view)")
code, h, pl = get(SUP, QU, 2)
s.check("Hotel (the BG CEO has not locked it): 'Round 2 starts after the BG CEO locks'; no actual form, no buttons",
        "Round 2 starts after the BG CEO locks" in text_of(strip_of(h), r".*") and 'id="atb-actual"' not in h and "<form" not in strip_of(h)
        and "Round 2 starts after the BG CEO locks this unit" in text_of(h, r'id="atb-lock".*?</span>'))

code, h, pl = get(SUP, QN, 2)
st_ = strip_of(h)
fm = re.search(r'<form[^>]*id="atb-actual"[^>]*>', h)
s.check("Alpha (locked, no actual): the actual PAT form is there for the super admin: posts to the Round 2 actual route, double-confirmed with the remark box",
        fm and 'action="/admin/calibration/talent-box/round2/actual"' in fm.group(0) and "data-confirm=" in fm.group(0)
        and 'data-confirm-reason="Your remark (required): why, for the audit trail"' in fm.group(0)
        and 'data-confirm-reason-field="remark"' in fm.group(0) and 'data-confirm-title="Save the actual PAT for ZZR2A Alpha?"' in fm.group(0)
        and 'data-confirm-ok="Save actual PAT"' in fm.group(0), fm and fm.group(0))
s.check("...carrying the CSRF token, the business group and the unit whose PAT it is, with a number input named actual_pct and the Save button",
        re.search(r'id="atb-actual".*?name="csrf_token".*?name="bg" value="ZZR2A Group".*?name="company" value="ZZR2A Alpha".*?name="actual_pct".*?Save actual PAT', st_, re.S)
        and "Forecast" in st_ and "Normal" in st_)
s.check("...and the page knows the curve's cut-offs the way the server does (data-cuts 70,130 = pm_curve_key_for_pct at its boundaries)",
        'data-cuts="70,130"' in fm.group(0) and [a.pm_curve_key_for_pct(x) for x in (69.9, 70, 130, 130.1)] == ["negative", "normal", "normal", "positive"])
code, hb, _p = get(BGAC, QN, 2)
s.check("a BG admin on the same unit: 'Actual PAT not entered yet', no form, no input, no button",
        "Actual PAT not entered yet" in text_of(strip_of(hb), r".*") and not forms_of(strip_of(hb)) and "actual_pct" not in hb
        and "<button" not in strip_of(hb))

code, h, pl = get(SUP, QW, 2)
st_ = strip_of(h)
s.check("Bravo (curve shifted): the figures 85% Normal -> 62% Negatively skewed with 'Curve shifted', and what the shift means",
        "85%" in st_ and "62%" in st_ and "Negatively skewed" in st_ and "Curve shifted" in st_ and "moves this unit to Negatively skewed" in st_)
fo = [f for f in forms_of(st_) if "round2/open" in f]
s.check("...two choices, each its own double-confirmed form: Do Round 2 here (mode admin) and Push to BG CEO (mode bgceo), each asking the remark",
        len(fo) == 2 and all("data-confirm=" in f and "data-confirm-reason=" in f and 'data-confirm-reason-field="remark"' in f for f in fo)
        and 'data-confirm-ok="Do Round 2 here"' in fo[0] and 'data-confirm-ok="Push to BG CEO"' in fo[1]
        and 'data-confirm-title="Push Round 2 to the BG CEO?"' in fo[1] and 'name="mode" value="admin"' in st_ and 'name="mode" value="bgceo"' in st_, fo)
dd, mn = a._tb_round_due_on("")
s.check("the push's lock-by day: a date input defaulting to 5 working days on (MYT) and never before today",
        'name="due_on" value="%s" min="%s"' % (dd.isoformat(), a._today_myt().isoformat()) in st_ and dd.weekday() < 5 and dd > a._today_myt(), st_[-900:])
s.check("...the push's confirm text names the BG CEO who will be emailed; the 'Do Round 2 here' text says the BG CEO is not emailed",
        "ZZ R2A Group CEO gets an email" in h and "The BG CEO is not emailed" in h)
s.check("a 'Change actual PAT' button opens the same form again (hidden until then), before the round opens",
        "data-atb-change" in st_ and re.search(r'<form[^>]*id="atb-actual"[^>]*hidden', h))
s.check("the release hold is said on the strip", "can't be released until Round 2 is locked" in h)
s.check("an admin Round 2 isn't opened yet, so the card is NOT editable: no Move, no Suggest, no Lock Round 2",
        not pl["r2"]["editable"] and 'id="atb-suggest"' not in h and 'id="atb-lockform"' not in h)
code, hb, plb = get(BGAC, QW, 2)
s.check("a BG admin on a shifted unit: the same words, NO form at all in the strip (no Do Round 2 here, no Push, no Change)",
        "Curve shifted" in strip_of(hb) and not forms_of(strip_of(hb)) and "data-atb-change" not in hb and not plb["r2"]["can_write"], strip_of(hb)[-400:])

code, h, pl = get(SUP, QS, 2)
s.check("Charlie (same curve): 'Same curve: Round 1 stands', no choice offered, but the correction button stays",
        "Same curve: Round 1 stands" in text_of(strip_of(h), r".*") and not [f for f in forms_of(strip_of(h)) if "round2/open" in f]
        and "data-atb-change" in h)

code, h, pl = get(SUP, QA, 2)
st_ = strip_of(h)
s.check("Delta (an admin round): 'Round 2 · you', who started it and when; the card is editable for the super admin",
        "ROUND 2 \u00b7 YOU" in _html.unescape(text_of(st_, r".*")).upper() and "Started by you" in text_of(st_, r".*") and pl["r2"]["editable"], st_[:300])
s.check("...with Suggest with AI (the AI-red button with the spark), the AI strip drawn hidden and empty, Apply all and Dismiss in it",
        'id="atb-suggest"' in h and "rv-ai-action" in re.search(r'<button[^>]*id="atb-suggest"[^>]*>', h).group(0)
        and re.search(r'<div class="atb-r2 is-ai" id="atb-ai" hidden', h) and 'id="atb-ai-apply"' in h and 'id="atb-ai-dismiss"' in h)
card = h[h.index('id="atb"'):h.index('id="atb-data"')]
s.check("...and nothing of the AI is drawn by the server: no '+n suggested', no 'AI: →' mark, an empty strip text and list (they come from the page's script, after the click)",
        'class="atb-sg"' not in card and 'class="atb-sugg"' not in card and re.search(r'id="atb-ai-say"></span>', card)
        and re.search(r'<ol class="atb-ailist" id="atb-ai-list"></ol>', card) and card.count('class="atb-sgrow" hidden') == 9)
lf = re.search(r'<form[^>]*id="atb-lockform"[^>]*>.*?</form>', h, re.S)
s.check("...and Lock Round 2: a double-confirmed form to the Round 2 lock route naming the round (its remark rides on it), with the moved count in its words",
        lf and 'action="/admin/calibration/talent-box/round2/lock"' in lf.group(0) and 'data-confirm-title="Lock Round 2 for ZZR2A Delta?"' in lf.group(0)
        and "2 people moved from Round 1" in lf.group(0) and 'data-confirm-ok="Lock Round 2"' in lf.group(0)
        and 'name="round_id" value="%d"' % RID_A in lf.group(0) and "Lock Round 2</button>" in lf.group(0), lf and lf.group(0)[:400])
r2 = pl["r2"]
s.check("the card's script gets what it needs: editable, the round, its routes (suggest, apply, the BG move route)",
        r2["editable"] and r2["state"] == "open" and r2["mode"] == "admin" and r2["round_id"] == RID_A and r2["bg"] == BG and r2["company"] == QA
        and r2["suggest_url"] == "/talent-box/round2/suggest" and r2["apply_url"] == "/talent-box/round2/apply"
        and r2["move_url"].startswith("/talent-box/bg/") and r2["move_url"].endswith("/move"), r2)
code, hb, plb = get(BGAC, QA, 2)
s.check("a BG admin on the same admin round: read only. Group People are placing it; no Suggest, no Lock, no AI strip, no Move data, editable false",
        "Group People are placing this unit" in text_of(strip_of(hb), r".*") and 'id="atb-suggest"' not in hb and 'id="atb-lockform"' not in hb
        and 'id="atb-ai"' not in hb and not plb["r2"]["editable"] and not plb["r2"]["can_write"] and "atb-sgrow" not in hb)
s.check("the foot of a read-only admin round says it in a pill", "Round 2 is open: Group People are placing this unit" in text_of(hb, r'id="atb-lock".*?</span>'))
s.check("the super admin's foot swaps the pill for Lock Round 2", 'id="atb-lock"' not in h)

code, h, pl = get(SUP, QP, 2)
st_ = strip_of(h)
s.check("Echo (pushed, before its lock-by day): read only with the lock-by day and who it was pushed to; 'Remind' is the one form (double-confirmed, no remark: it changes no band)",
        "ZZ R2A Group CEO" in st_ and a._tb_r2_on(due) in st_ and "email sent" in st_ and not pl["r2"]["editable"]
        and 'id="atb-suggest"' not in h and 'id="atb-lockform"' not in h and 'id="atb-ai"' not in h
        and len(forms_of(st_)) == 1 and "round2/remind" in forms_of(st_)[0] and "data-confirm=" in forms_of(st_)[0]
        and "data-confirm-reason" not in forms_of(st_)[0], (forms_of(st_), st_[-500:]))
s.check("...and its foot says it is with the BG CEO", "With the BG CEO: not locked yet" in text_of(h, r'id="atb-lock".*?</span>'))
code, hb, plb = get(BGAC, QP, 2)
s.check("a BG admin on a pushed unit: no Remind, no forms", not forms_of(strip_of(hb)) and a._tb_r2_on(due) in strip_of(hb))

code, h, pl = get(SUP, QD, 2)
s.check("Foxtrot (pushed, its lock-by day has passed): the super admin can finish it: editable, Suggest with AI, Lock Round 2",
        pl["r2"]["editable"] and pl["r2"]["state"] == "due" and 'id="atb-suggest"' in h and 'id="atb-lockform"' in h
        and "has passed" in text_of(strip_of(h), r".*") and "finish it now" in text_of(strip_of(h), r".*"))
code, hb, plb = get(BGAC, QD, 2)
s.check("...a BG admin sees 'Group People finish it', read only", "Group People finish it" in text_of(strip_of(hb), r".*") and not plb["r2"]["editable"]
        and 'id="atb-lockform"' not in hb)

code, h, pl = get(SUP, QL, 2)
s.check("Golf (Round 2 locked): 'This is the result that is released', who locked it and when, read only; the foot is the green pill; nothing to press",
        "This is the result that is released" in text_of(strip_of(h), r".*") and "Group People" in text_of(strip_of(h), r".*") and not pl["r2"]["editable"]
        and 'id="atb-suggest"' not in h and 'id="atb-lockform"' not in h and "Round 2 locked by Group People" in text_of(h, r'id="atb-lock".*?</span>')
        and 'atb-lockpill is-ok' in h and not forms_of(strip_of(h)))
s.check("...and Round 1 still shows the box as the BG CEO first locked it (Golf: the 3 people where the record put them)",
        {k: v for k, v in cell_counts(get(SUP, QL, 1)[2]).items() if v} == {
            k: sum(1 for pid in P[QL] if "%s|%s" % (a.TALENT_PERF_GROUP_OF[R1[pid][0]], R1[pid][1]) == k)
            for k in {"%s|%s" % (a.TALENT_PERF_GROUP_OF[R1[pid][0]], R1[pid][1]) for pid in P[QL]}})

# ======================================================================================================================
s.section("the write forms hold the app's standards")
allh = "".join(get(SUP, co, 2)[1] for co in Q.values())
posts = [f for f in forms_of(allh) if 'method="post"' in f and "round2" in f]
s.check("every Round 2 POST form on the page is a double confirm (data-confirm) naming its action",
        posts and all("data-confirm=" in f and "data-confirm-ok=" in f and "data-confirm-title=" in f for f in posts), [f[:120] for f in posts if "data-confirm=" not in f])
s.check("every band-moving one (actual, open, lock) asks the super admin's remark through the box, never a typed field on the page",
        all("data-confirm-reason=" in f for f in posts if re.search(r"round2/(actual|open)", f))
        and 'name="remark"' not in allh and "lockform" in allh)
jsx = open(os.path.join(H.REPO, "static", "admin_talent_box.js"), encoding="utf-8").read()
s.check("no browser confirm()/alert() in the card's script; the app's own dialog (askConfirm) is used for Apply all",
        not re.search(r"(?<![A-Za-z.])(confirm|alert)\(", jsx) and "window.askConfirm(" in jsx)
s.check("Suggest with AI proposes only: the script reads the suggestion (GET), draws it, and posts nothing until Apply all, which asks the app's dialog first",
        "R.suggest_url" in jsx and "window.askConfirm(" in jsx and jsx.index("R.suggest_url") < jsx.index("R.apply_url")
        and "method: \"POST\"" not in jsx[jsx.index("R.suggest_url"):jsx.index("R.suggest_url") + 200])
s.check("the AI marks are the script's: '+n suggested' on each cell's second row, 'AI: → <band>' on each person",
        "atb-sgrow" in jsx and "\"+\" + n + \" suggested\"" in jsx and "\"AI: → \"" in jsx)

# ======================================================================================================================
s.section("PAT Ref: a unit the BG CEO has locked is read only there")
r = SUP.get("/admin/performance/pbt?fbg=%s" % BG.replace(" ", "+"))
html = r.get_data(as_text=True)
rows_ = {co: re.search(r'<tr class="data-row pat-row" data-unit="%s".*?</tr>' % re.escape(co), html, re.S) for co in Q.values()}
s.check("a locked unit's figure has no input, says the BG CEO locked it, and links to Talent Box › Round 2 · Actual",
        r.status_code == 200 and all(rows_[c] for c in Q.values())
        and "pat-input" not in rows_[QN].group(0) and "The BG CEO locked it on the Talent Box" in rows_[QN].group(0)
        and "round=2" in rows_[QN].group(0) and "Round 2 &middot; Actual" in rows_[QN].group(0), rows_[QN] and rows_[QN].group(0)[:500])
s.check("...a unit with an actual says it is the actual PAT, entered on Round 2", "The actual PAT, entered on Round 2" in rows_[QW].group(0)
        and "pat-input" not in rows_[QW].group(0))
s.check("...and a unit nobody has locked (Hotel) still has its input (falsified: the guard is the BG CEO's lock, not the page)",
        "pat-input" in rows_[QU].group(0) and "round=2" not in rows_[QU].group(0))
rb = BGAC.get("/admin/performance/pbt?fbg=%s" % BG.replace(" ", "+")).get_data(as_text=True)
s.check("a BG admin sees the same read-only mark, with the link", "Round 2 &middot; Actual" in rb)

# ======================================================================================================================
s.section("put back what this suite changed")
exe("DELETE FROM late_passes WHERE user_id=?", (BOSS,))
with a.app.test_request_context("/"):   # the shared suite database as this suite found it
    db = a.get_db()
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZR2A-%'")]
    ph = ",".join("?" * len(ids))
    for tb in ("leader_releases", "result_releases", "talent_releases", "rating_records", "tb_insights", "talent_status_history",
               "talent_box_remarks"):
        try:
            db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (tb, ph), ids)
        except Exception:   # noqa: BLE001 -- a table this database lacks
            db.rollback()
    db.execute("DELETE FROM tb_round1_marks WHERE round_id IN (SELECT id FROM tb_rounds WHERE business_group=?)", (BG,))
    db.execute("DELETE FROM tb_rounds WHERE business_group=?", (BG,))
    db.execute("DELETE FROM talent_box_bu_locks WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_pat_lock_flags WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_pbt_achievement WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    for tb, mx in _ORIG["max"].items():
        db.execute("DELETE FROM %s WHERE id>?" % tb, (mx,))
    db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZR2A-%'")
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='tb_bgceo'", (CID,))
    for w_ in _ORIG["windows"]:
        db.execute("INSERT INTO cycle_windows(%s) VALUES (%s)" % (",".join(w_), ",".join("?" * len(w_))), list(w_.values()))
    db.execute("UPDATE cycles SET half=? WHERE id=?", (_ORIG["half"], CID))
    for k_, v in _ORIG["settings"].items():
        if v is None:
            db.execute("DELETE FROM app_settings WHERE key=?", (k_,))
        else:
            db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,?)", (k_, v))
    for k_, v in _ORIG["modules"].items():
        db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (v, CID, k_))
    db.commit()
s.check("nothing of this suite is left behind", one("SELECT COUNT(*) FROM users WHERE employee_id LIKE 'ZZR2A-%'") == 0
        and one("SELECT COUNT(*) FROM tb_rounds WHERE business_group=?", (BG,)) == 0
        and one("SELECT COUNT(*) FROM org_units WHERE business_group=?", (BG,)) == 0)
sys.exit(s.done())
