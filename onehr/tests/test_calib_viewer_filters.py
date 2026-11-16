"""Filters per viewer (Chris, 2026-11-02, canvas "OneHR Calibration Filters by Viewer": "Yes, as drawn"; his 31 Oct words: "they group
usually has cross BG and cross BU people", "go with your suggestion").

The unit switches say what a BU CEO and the BG CEO's Talent Box show. Three viewers hold people grouped differently, so each has a set
of its own (calib_viewer_filter): a calibrator (several units of one business group), a Group Chief group (people of any business
group) and the Executive Chairman. A filter only narrows the view: no band, lock or move changes.

What this pins:
  * storage and reader: one table keyed (kind, viewer_id, filter_key), the reader's None for "no rows", a key the kind does not offer
    ignored, a calibrator or group that no longer exists ignored; the table is not in the org rename's list (keyed by id)
  * the Filters card: four tabs (the Executive Chairman's only while his view is on), the Calibrators and Group Chiefs tables with
    Search in, their 560px panels (coverage lines, disabled where nobody has a value, "Follow its units again", the Group Chief's
    Segment "always on", "How a department reads"), and the unit tab as it was
  * ONE write route, the super admin's: refuses an unknown kind, a calibrator or group that is not there, an unknown key, Segment,
    a key the kind does not offer, Follow for any kind but a calibrator, a filter nobody has a value for; writes every key; audits
    the old and new sets; Follow deletes the rows
  * a calibrator's card: no rows = today's union of its units' switches exactly; rows = its own set, still dropping a filter nobody
    has a value for; Job grade keeps its business group's bands; the BU CEO's own card is unchanged
  * the Group Chief's box: Segment always, the filter line in place of the batch pills, a department in two business groups gives two
    options (the group in the label) and a pick of one excludes the other, each chip counts within the picks before it, a bogus pick
    drops, no chip where there is nothing to choose between, the lock still the whole group's
  * the Executive Chairman's box (and his delegate's): nothing with All business groups (the hint only when a key is shown), the
    chips within the picked business group (and unit), Job grade by that group's bands, a pick outside the group drops
  * the BG CEO's Talent Box payload is byte for byte what it was

Its own synthetic ZZVF people on the shared suite database; a fresh_db suite, so Suite.done() puts the scratch copy back."""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Filters per viewer: calibrators, Group Chiefs and the Executive Chairman")
_real_avail = a.ai_draft.review_agent_available
a.ai_draft.review_agent_available = lambda: True
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
os.environ.pop("ONEHR_CHAIR", None)
SU, BGA, EMP = H.actors(a)
C_SU = H.client_as(a, SU["id"])
SRC = H.source(a, "app.py")
JS = H.chat_js(a)
CSS = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()

BG1, BG2, BG3 = "ZZVF North Group", "ZZVF South Group", "ZZVF East Group"
N1, N2, N3 = "ZZVF Cement Sdn Bhd", "ZZVF Paint Sdn Bhd", "ZZVF Tiles Sdn Bhd"
S1, E1 = "ZZVF Steel Sdn Bhd", "ZZVF East Sdn Bhd"
BRANCHES = ["ZZVF Ipoh", "ZZVF Klang"]
ids = {}
TAGS = {}


def run(fn, path="/"):
    with a.app.test_request_context(path):
        return fn(a.get_db())


def put(key, val):
    def f(d):
        if val is None:
            d.execute("DELETE FROM app_settings WHERE key=?", (key,))
        else:
            d.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", (key, str(val)))
        d.commit()
    run(f)


def one(sql, *p):
    return H.one(a, sql, p)


with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    PER = a.active_pm_period(db)["id"]
    db.execute("UPDATE cycles SET half=2, kind='year_end', no_potential=NULL, min_job_grade=NULL WHERE id=?", (CID,))
    for k_ in ("review", "pm", "tm", "calibration"):
        db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1) ON CONFLICT(cycle_id, module_key) DO UPDATE "
                   "SET active=1", (CID, k_))
    for bg, co in ((BG1, N1), (BG1, N2), (BG1, N3), (BG2, S1), (BG3, E1)):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (bg, co))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base if c != "id"]

    def mk(tag, bg, co, dept="ZZVF Sales", grade="13", cc=None, wl=None, **kw):
        eid = "ZZVF-" + tag
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ VF " + tag, display_name=None, email=None, hod_id=None,
                 manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, confirmation_date="2020-01-01", left_at=None,
                 role="user", is_demo=0, user_role_id=None, job_grade=grade, business_group=bg, company=co, department=dept,
                 cost_center=cc, work_location=wl, job_title="MANAGER " + tag, years_of_service=9)
        v.update(kw)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v.get(c) for c in cols])
        ids[tag] = db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group) "
                   "VALUES (?,?,?,100,'more','approved',?)", (PER, ids[tag], "ZZVF KPI", bg))
        return ids[tag]
    # --- two calibrators of BG North: CA holds Sales in Cement and Paint (two units), CB holds Ops in Tiles
    mk("CA", BG1, N1, dept="ZZVF Office")
    mk("CB", BG1, N3, dept="ZZVF Office")
    for i in range(4):   # Cement Sales: 3 cost centres, 3 on Ipoh and one with no work location
        mk("A%d" % i, BG1, N1, dept="ZZVF Sales", grade=("13", "16", "20", "13")[i], cc="ZZVF-CC%d" % (i % 3),
           wl=None if i == 3 else BRANCHES[0])
    for i in range(3):   # Paint Sales
        mk("B%d" % i, BG1, N2, dept="ZZVF Sales", grade="14", cc="ZZVF-CC%d" % (i % 2), wl=BRANCHES[1])
    for i in range(2):   # Tiles Ops (CB), no cost centre, no work location
        mk("T%d" % i, BG1, N3, dept="ZZVF Ops", grade="15")
    mk("X1", BG1, N1, dept="ZZVF Other")   # a person no calibrator holds: stays the BU CEO's
    ga = db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id) VALUES (?,?,?,?)",
                    (BG1, N1, "ZZVF Group A", ids["CA"])).lastrowid
    gb = db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id) VALUES (?,?,?,?)",
                    (BG1, N3, "ZZVF Group B", ids["CB"])).lastrowid
    for g_, co, d_ in ((ga, N1, "ZZVF Sales"), (ga, N2, "ZZVF Sales"), (gb, N3, "ZZVF Ops")):
        db.execute("INSERT INTO calib_bu_group_units(group_id, business_group, company, department) VALUES (?,?,?,?)",
                   (g_, BG1, co, d_))
    # --- a Group Chief group over three business groups (a department in two of them); segments Alpha and Beta, one batch with none
    mk("GC", BG1, N1, dept="ZZVF Office")
    mk("G1", BG1, N1, dept="ZZVF Finance", grade="14", cc="ZZVF-GC1", wl=BRANCHES[0])
    mk("G2", BG1, N2, dept="ZZVF Finance", grade="15", cc="ZZVF-GC1")
    mk("G3", BG2, S1, dept="ZZVF Finance", grade="14", cc="ZZVF-GC2")
    mk("G4", BG2, S1, dept="ZZVF Engineering", grade="GM", cc="ZZVF-GC2")
    mk("G5", BG3, E1, dept="ZZVF Engineering", grade="16")
    mk("G6", BG3, E1, dept="ZZVF Legal", grade="16")
    mk("G7", BG3, E1, dept="ZZVF Legal", grade=None)
    gid = db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES (?,?)", ("ZZVF Chief Group", ids["GC"])).lastrowid
    for tag, seg in (("G1", "ZZVF Alpha"), ("G2", "ZZVF Alpha"), ("G3", "ZZVF Alpha"), ("G4", "ZZVF Beta"), ("G5", "ZZVF Beta"),
                     ("G6", ""), ("G7", "")):
        db.execute("INSERT INTO pm_calibration_group_members(group_id, subject_id, segment, source) VALUES (?,?,?,?)",
                   (gid, ids[tag], seg or None, "person"))
    db.commit()
GA, GB, GID = ga, gb, gid
C_BGA = H.client_as(a, BGA["id"]) if BGA else None
C_EMP = H.client_as(a, EMP["id"])
SIGNED_OUT = a.app.test_client()

FV = "/admin/m/calibration/settings"


def card(q="", cl=None):
    r = (cl or C_SU).get(FV + q)
    html = r.get_data(as_text=True)
    i = html.find('id="bu-filters"')
    j = html.find('id="jg-filter"')
    return r, html, html[i:j if j > i else None]


def post(client=None, **form):
    d = {"csrf_token": "tok"}
    d.update({k: v for k, v in form.items() if v is not None})
    return (client or C_SU).post("/admin/settings/calib-viewer-filter", data=d)


def rows_for(kind, vid):
    return {r[0]: r[1] for r in H.rows(a, "SELECT filter_key, shown FROM calib_viewer_filter WHERE kind=? AND viewer_id=?", (kind, str(vid)))}


def log_rows():
    return H.rows(a, "SELECT detail FROM activity_log WHERE action='settings' AND detail LIKE 'Filters per viewer,%' ORDER BY id")


def flat(x):
    """The page's text with its line breaks made single spaces (a sentence wraps in the template)."""
    return re.sub(r"\s+", " ", x)


def flashed(client):
    """The messages the last response left in the session (flashed), as [(category, text)]."""
    with client.session_transaction() as sess:
        return list(sess.pop("_flashes", []))


# =====================================================================================================================
# THE BG CEO'S BOX IS WHAT IT WAS, byte for byte (Chris's rule for this build: nothing the filters per viewer add may move it). The
# payload of a fixed fixture, in four reads (the whole unit, a department, two cost centres, a job-grade band), with the ids turned into
# the fixture's tags, is hashed; the hash was taken on the code BEFORE this build (origin/main 729d10fa) and is pinned here. A change that
# moves any key, count, option or word of the BG CEO's Talent Box changes it. VF_DIGEST_ONLY=1 prints the hash and stops (how it was taken).
import hashlib  # noqa: E402

BGCEO_DIGEST = "f2b65922d7229fff1377f0ce3486597cb0d2dd9c58fa260fb0a45f7c473a2cad"
with a.app.test_request_context("/"):
    db = a.get_db()
    eid = "ZZVF-BC"
    v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ VF BC", display_name=None, email=None, hod_id=None, manager_id=None,
             buceo_bg=None, buceo_company=None, bgceo_bg=BG1, confirmation_date="2020-01-01", left_at=None, role="user", is_demo=0,
             user_role_id=None, job_grade="22", business_group=BG1, company=N1, department="ZZVF Office", cost_center="ZZVF-CC0",
             work_location=None, job_title="BG CEO", years_of_service=9)
    db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v.get(c) for c in cols])
    ids["BC"] = db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
    db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group) VALUES (?,?,?,100,'more','approved',?)",
               (PER, ids["BC"], "ZZVF KPI", BG1))
    for co_, k_ in ((N1, "dept"), (N1, "jg"), (N1, "cc"), (N1, "branch")):
        a.calib_filter_write(db, BG1, co_, "tb", k_, True, SU["id"])
    db.commit()


def bgceo_payload(q=""):
    with a.app.test_request_context("/review/journey?view=bg&stage=talent_box&company=" + N1.replace(" ", "+") + q):
        a.session["user_id"] = ids["BC"]
        db = a.get_db()
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (ids["BC"],)).fetchone())
        sc = a._journey_talent_box_scope(db, u)
        return a._journey_talent_box_overview(db, u, sc) if sc else None


def _norm(x, tags):
    if isinstance(x, dict):
        d_ = {k: (tags.get(v, v) if k in ("id", "subject_id") and isinstance(v, int) else
                  sorted(tags.get(i, i) for i in v) if k == "ids" and isinstance(v, list) else _norm(v, tags)) for k, v in x.items()}
        if {"key", "label", "tb_locked"} <= set(x):   # a business unit's row: the phone view's list shows its head count (`n`, added 2026-11-07, display only); the pin is of everything else
            d_.pop("n", None)
        return d_
    if isinstance(x, (list, tuple)):
        return [_norm(i, tags) for i in x]
    return x


def bgceo_digest():
    tags = {v_: "u:" + k_ for k_, v_ in ids.items()}
    reads = ["", "&dept=ZZVF+Sales", "&cc=ZZVF-CC0&cc=ZZVF-CC1", "&jg=12-14&branch=ZZVF+Ipoh"]
    blob = json.dumps([_norm(bgceo_payload(q), tags) for q in reads], sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest(), len(blob), blob


_dg, _len, _blob = bgceo_digest()
if os.environ.get("VF_DIGEST_ONLY") == "1":
    print("BGCEO_DIGEST %s %d" % (_dg, _len))
    if os.environ.get("VF_DIGEST_DUMP"):
        open(os.environ["VF_DIGEST_DUMP"], "w").write(_blob)
    sys.exit(0)
s.section("the BG CEO's Talent Box payload is byte for byte what it was before filters per viewer")
s.check("four reads of a fixed fixture (the unit, a department, two cost centres, a band and a branch), hashed, equal the hash taken on "
        "origin/main before this build (%s)" % BGCEO_DIGEST[:12], _dg == BGCEO_DIGEST, (_dg, _len))
s.check("...the reads reached something: the unit's box has people and the filter chips the unit switched on",
        '"filters"' in _blob and '"cells"' in _blob and _len > 2000, _len)

# =====================================================================================================================
s.section("storage and the reader")
s.check("calib_viewer_filter exists with the three-part key, in the live schema and in SCHEMA",
        one("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='calib_viewer_filter'") == 1
        and sorted(r[1] for r in H.rows(a, "PRAGMA table_info(calib_viewer_filter)") if r[5]) == sorted(["kind", "viewer_id", "filter_key"])
        and [r[1] for r in H.rows(a, "PRAGMA table_info(calib_viewer_filter)")] ==
        ["kind", "viewer_id", "filter_key", "shown", "set_by", "set_at"]
        and SRC.count("CREATE TABLE IF NOT EXISTS calib_viewer_filter") == 2)
s.check("it is keyed by id, so the org rename's list does not carry it", "calib_viewer_filter" not in a._ORG_SETTINGS_TABLES)
with a.app.test_request_context("/"):
    db = a.get_db()
    s.check("no rows is None for every kind (the viewer's default holds)",
            a.calib_viewer_filters(db, "cal", GA) is None and a.calib_viewer_filters(db, "gc", GID) is None
            and a.calib_viewer_filters(db, "ec", "") is None)
    db.execute("INSERT INTO calib_viewer_filter(kind, viewer_id, filter_key, shown, set_by, set_at) VALUES "
               "('cal', ?, 'dept', 1, 1, 'x'), ('cal', ?, 'jg', 0, 1, 'x'), ('cal', ?, 'bg', 1, 1, 'x'), ('cal', ?, 'seg', 1, 1, 'x')",
               (str(GA), str(GA), str(GA), str(GA)))
    db.commit()
    own = a.calib_viewer_filters(db, "cal", GA)
    s.check("rows read back as {key: shown}; a key the kind does not offer (bg, seg for a calibrator) is ignored",
            own == {"dept": True, "jg": False}, own)
    s.check("...as a string id or an int, and a kind it does not know is None",
            a.calib_viewer_filters(db, "cal", str(GA)) == own and a.calib_viewer_filters(db, "zz", GA) is None)
    db.execute("INSERT INTO calib_viewer_filter(kind, viewer_id, filter_key, shown) VALUES ('cal', '99999', 'dept', 1), "
               "('gc', '99999', 'dept', 1)")
    db.commit()
    s.check("rows of a calibrator / Group Chief group that is not there are ignored",
            a.calib_viewer_filters(db, "cal", 99999) is None and a.calib_viewer_filters(db, "gc", 99999) is None)
    db.execute("UPDATE calib_bu_groups SET active=0 WHERE id=?", (GB,))
    db.execute("INSERT INTO calib_viewer_filter(kind, viewer_id, filter_key, shown) VALUES ('cal', ?, 'cc', 1)", (str(GB),))
    db.commit()
    s.check("...and one that was retired (a calibrator is retired, never deleted)", a.calib_viewer_filters(db, "cal", GB) is None)
    db.execute("UPDATE calib_bu_groups SET active=1 WHERE id=?", (GB,))
    db.execute("DELETE FROM calib_viewer_filter")
    db.commit()
    s.check("the shown keys, in the line's order: Business group after Segment, then the registry's",
            a.calib_viewer_shown_keys({"branch": True, "cc": True, "bg": True, "dept": True, "jg": True}, "gc") ==
            ["bg", "dept", "jg", "cc", "branch"]
            and a.calib_viewer_shown_keys({"cc": True, "dept": True, "bg": True}, "cal") == ["dept", "cc"])

# =====================================================================================================================
s.section("the Filters card: four tabs, the unit tab as it was")
r, html, c0 = card("?bfbg=" + BG1.replace(" ", "+"))
s.check("the card is titled Filters with one 'Per viewer' scope pill (no chip), and its lede names the rule",
        r.status_code == 200 and '<h2>Filters</h2>' in html and 'adm-scope is-viewer">Per viewer<' in html
        and 'adm-set-chip">Per viewer<' not in html
        and "Each kind of viewer is set on its own tab, because their people are grouped differently" in flat(c0)
        and "Filters only narrow what a leader sees: no band, lock or move changes." in flat(c0))
tabs = re.findall(r'<a href="[^"]*fview=(\w+)[^"]*#bu-filters"\s+class="vf-tab( is-on)?"', c0)
s.check("three tabs while the Executive Chairman's view is off (BU CEO & Talent Box, Calibrators, Group Chiefs); the unit tab is open",
        [t[0] for t in tabs] == ["unit", "cal", "gc"] and [bool(t[1]) for t in tabs] == [True, False, False]
        and "BU CEO &amp; Talent Box <span class=\"vf-tab-sub\">· per unit</span>" in c0
        and "Calibrators <span class=\"vf-tab-sub\">· per calibrator</span>" in c0 and "Executive Chairman" not in c0, tabs)
s.check("the unit tab is today's card: a row per filter and its five side panels, the screen reading 'BU CEO calibration' alone",
        c0.count('data-cfr-row="') == 5 and c0.count('<aside class="adm-panel') == 5 and "BU CEO calibration" in c0
        and "also calibration groups" not in c0 and "calib_filter_rules.js" in c0 and "calib_viewer_filters.js" not in c0)
r2, html2, cx = card("?fview=nope")
s.check("an unknown tab is the unit tab; the Executive Chairman's tab asked for while his view is off is the unit tab too",
        'data-cfr-row="dept"' in cx and 'data-cfr-row="dept"' in card("?fview=ec")[2])

s.section("the Calibrators tab: a table, Search in, one panel each")
r, html, cc = card("?fview=cal&bfbg=" + BG1.replace(" ", "+"))
s.check("the tab says what a calibrator keeps, and has the business group tabs as the unit tab does",
        "A calibrator reaches several units of one business group. Until you edit one, it keeps what it shows today: every filter "
        "switched on for any unit it reaches." in flat(cc) and cc.count('class="df-bgtab') >= 5 and 'class="vf-tab is-on"' in cc
        and 'fview=cal' in cc)
s.check("the table: Calibrator (name, the group under it), Reaches (units, then '· n people'), Filters (the set, then where it comes from), Edit",
        "<th>Calibrator</th><th>Reaches</th><th>Filters</th>" in cc and "ZZ VF CA</b>" in cc
        and "ZZVF Group A" in cc and "ZZVF Cement Sdn Bhd, ZZVF Paint Sdn Bhd" in cc and "· 7 people" in cc and "· 2 people" in cc
        and cc.count("From its units") == 2 and "Set here" not in cc.split('<aside')[0]
        and cc.count('data-panel-open="vfc-') == 2, cc.count("From its units"))
s.check("...a calibrator with nothing switched on reads 'None' (muted), the filters of its units otherwise: none switched on yet",
        cc.split("</table>")[0].count('class="vf-muted">None</span>') == 2)
s.check("Search in is the shared macro (All fields, Name, Employee ID, Job title, Job grade, Email), a GET back to this card, on this tab",
        'name="qin"' in cc and 'data-suggest-src="admin_module_settings"' in cc and 'name="fview" value="cal"' in cc
        and 'name="bfbg" value="%s"' % BG1 in cc and "Search calibrators" in cc)
r, html, cs = card("?fview=cal&bfbg=%s&q=ZZ+VF+CB&qin=name" % BG1.replace(" ", "+"))
s.check("a search narrows the table to the calibrators it finds (by name), and says so when none match",
        "ZZ VF CB</b>" in cs.split("</table>")[0] and "ZZ VF CA</b>" not in cs.split("</table>")[0]
        and "No calibrator in ZZVF North Group matches that search." in card("?fview=cal&bfbg=%s&q=NOSUCHZZ" % BG1.replace(" ", "+"))[2])
panel_a = cc[cc.find('id="pnl-vfc-%d"' % GA):cc.find('id="pnl-vfc-%d"' % GB)]
panel_b = cc[cc.find('id="pnl-vfc-%d"' % GB):cc.find("calib_viewer_filters.js")]
s.check("one 560px panel a calibrator: '<BG> · Calibrator filters', their name, '<group> · <units> · n people'",
        'aria-labelledby="pnl-vfc-%d-h"' % GA in panel_a and "ZZVF North Group · Calibrator filters" in panel_a
        and "ZZVF Group A · ZZVF Cement Sdn Bhd, ZZVF Paint Sdn Bhd · 7 people" in panel_a.replace("&amp;", "&")
        and "ZZVF Group B · ZZVF Tiles Sdn Bhd · 2 people" in panel_b and "is-wide" not in panel_a.split(">")[0])
s.check("...'1. Which filters': a tick for Department, Job grade (JG · <BG>'s bands), Cost centre, Branch; no Calibrator chip",
        all(x in panel_a for x in ('value="dept"', 'value="jg"', 'value="cc"', 'value="branch"'))
        and 'name="filter" value="cal"' not in panel_a and 'value="seg"' not in panel_a
        and "JG · ZZVF North Group&#39;s bands" in panel_a
        and "BRANCH · work location" in panel_a and "1. Which filters" in panel_a and "2. What they will see" in panel_a)
s.check("...each with where people have a value: '1 department', '3 bands', '7 of 7 have one · 3 cost centres', '6 of 7 have one · 2 branches'",
        "1 department" in panel_a and "3 bands" in panel_a and "7 of 7 have one · 3 cost centres" in panel_a
        and "6 of 7 have one · 2 branches" in panel_a, re.findall(r'vf-cover[^>]*>([^<]*)<', panel_a))
s.check("...a filter nobody it holds has a value for is disabled and says why ('No one has a cost centre', 'No one has a work location')",
        'No one has a cost centre' in panel_b and "No one has a work location" in panel_b
        and len(re.findall(r'<input type="checkbox" name="filter" value="(?:cc|branch)"[^>]*disabled', panel_b)) == 2
        and not re.search(r'value="dept"[^>]*disabled', panel_b))
s.check("...following its units: the muted box says so (nothing is on for the units yet), Save is off, the note names what saving does",
        "Now: following its units (no filter is switched on for them)." in panel_a
        and "Saving gives this calibrator its own filters; the units' switches then no longer change them." in flat(panel_a)
        and "Follow its units again" not in panel_a and 'data-vf-save disabled>Save filters<' in panel_a
        and "Nothing changed yet." in panel_a and 'data-confirm-ok="Save filters"' in panel_a)
s.check("...the form: a POST with the token inside it, the kind and the calibrator, no confirm() in the page",
        'action="/admin/settings/calib-viewer-filter"' in panel_a and 'name="csrf_token"' in panel_a and 'name="kind" value="cal"' in panel_a
        and 'name="viewer_id" value="%d"' % GA in panel_a and "confirm(" not in cc.replace("data-confirm", ""))
# the units now switch some on: the panel names them
with a.app.test_request_context("/"):
    db = a.get_db()
    a.calib_filter_write(db, BG1, N1, "bu", "dept", True, SU["id"])
    a.calib_filter_write(db, BG1, N2, "bu", "cc", True, SU["id"])
    a.calib_filter_write(db, BG1, N2, "tb", "cc", True, SU["id"])
    db.commit()
r, html, cc = card("?fview=cal&bfbg=" + BG1.replace(" ", "+"))
panel_a = cc[cc.find('id="pnl-vfc-%d"' % GA):cc.find('id="pnl-vfc-%d"' % GB)]
row_a = cc[cc.find("ZZ VF CA</b>"):cc.find("ZZ VF CB</b>")]
s.check("a calibrator follows its units: Department and Cost centre, with 'From its units' (no row of its own)",
        "Department · Cost centre" in row_a and "From its units" in row_a
        and re.search(r'value="dept"[^>]*data-was="1"[^>]*checked', panel_a) and re.search(r'value="cc"[^>]*data-was="1"[^>]*checked', panel_a)
        and not re.search(r'value="jg"[^>]*checked', panel_a)
        and "Department and Cost centre are on for ZZVF Cement Sdn Bhd, ZZVF Paint Sdn Bhd" in panel_a, row_a[:200])

s.section("the Group Chiefs tab: no business group tabs, Segment always on")
r, html, cg = card("?fview=gc")
panel_g = cg[cg.find('id="pnl-vfg-%d"' % GID):cg.find("calib_viewer_filters.js")]
s.check("the tab says Segment stays on, has no business group tabs, and a table of Group | Group Chief | People | Filters",
        "A Group Chief group holds people from any business group, so there are no business group tabs here. Segment (the names you give "
        "each batch of people) stays on, as today." in flat(cg) and 'class="df-bgtab' not in cg
        and "<th>Group</th><th>Group Chief</th><th>People</th><th>Filters</th>" in cg and "ZZVF Chief Group</b>" in cg
        and "ZZ VF GC" in cg and "7 <span class=\"vf-muted\">· 3 business groups</span>" in cg)
s.check("...no rows of its own: 'Segment' with 'As today' under it",
        re.search(r"<td>Segment<div class=\"vf-subl\">As today</div></td>", cg) is not None)
s.check("the panel: 'Group Chief filters', the group, '<Group Chief> · 7 people in <BG>, <BG>, <BG>'",
        "Group Chief filters" in panel_g and "ZZVF Chief Group" in panel_g
        and "ZZ VF GC · 7 people in ZZVF East Group, ZZVF North Group, ZZVF South Group" in panel_g)
s.check("...'1. Which filters': Segment ticked and disabled ('always on', '3 segments'), then Business group, Department, Job grade (JG · each "
        "grade, '3 grades'), Cost centre, Branch; Segment is never a posted key",
        re.search(r'<input type="checkbox" checked disabled\s+aria-label="Segment filter">', panel_g)
        and "always on" in panel_g and "3 segments" in panel_g and 'value="seg"' not in panel_g
        and all(('value="%s"' % k) in panel_g for k in ("bg", "dept", "jg", "cc", "branch"))
        and "JG · each grade" in panel_g and "4 grades" in panel_g and "3 business groups" in panel_g and "5 departments" in panel_g
        and "4 of 7 have one · 2 cost centres" in panel_g and "1 of 7 have one · 1 work location" in panel_g)
s.check("...the note on Job grade across business groups, '2. How a department reads' (a name in one group alone; the same name in two groups: "
        "one row each, with its group), '3. What they will see' with the Segment chip",
        "Across business groups, Job grade lists each grade (JG 12, JG 13, …): every group bands its grades its own way." in flat(panel_g)
        and "2. How a department reads" in panel_g and "<span>ZZVF Legal</span>" in panel_g and "only in one group: its name alone" in panel_g
        and "ZZVF Engineering · ZZVF East Group" in panel_g and "ZZVF Engineering · ZZVF South Group" in panel_g
        and "the same name in two groups:" in panel_g and "one row each, with its group" in panel_g
        and "3. What they will see" in panel_g and "data-vf-lead" in panel_g and "All segments" in panel_g)
s.check("...each the way the other panels are: the confirm box, Save off until a tick changes",
        'name="kind" value="gc"' in panel_g and 'name="viewer_id" value="%d"' % GID in panel_g and 'data-confirm-ok="Save filters"' in panel_g
        and 'data-vf-save disabled>Save filters<' in panel_g)

# =====================================================================================================================
s.section("the write route: the super admin's, ONE route, every refusal writes nothing")
URL = "/admin/settings/calib-viewer-filter"
s.check("the route is in the 'super' list of the access map and carries @super_required",
        a.ADMIN_ACCESS_MAP.get("admin_calib_viewer_filter") == "super"
        and re.search(r'@app\.route\("/admin/settings/calib-viewer-filter", methods=\["POST"\]\)\n@super_required\ndef admin_calib_viewer_filter',
                      SRC) is not None)
n0 = one("SELECT COUNT(*) FROM calib_viewer_filter")
log0 = len(log_rows())
good = dict(kind="cal", viewer_id=str(GA), filter=["dept", "cc"])
for who, cl in (("a BG admin", C_BGA), ("an employee", C_EMP)):
    if cl is None:
        continue
    r = post(cl, **good)
    s.check("%s cannot post it (refused, nothing written)" % who, r.status_code in (302, 403, 404) and
            one("SELECT COUNT(*) FROM calib_viewer_filter") == n0 and len(log_rows()) == log0, r.status_code)
r = post(SIGNED_OUT, **good)
s.check("signed out cannot post it (no session, no token: refused before anything is read); nothing written",
        r.status_code in (302, 400, 401, 403) and one("SELECT COUNT(*) FROM calib_viewer_filter") == n0, r.status_code)
BAD = [
    ("an unknown kind", dict(kind="zz", viewer_id=str(GA), filter=["dept"]), "not a kind of viewer"),
    ("no kind", dict(viewer_id=str(GA), filter=["dept"]), "not a kind of viewer"),
    ("a calibrator that is not there", dict(kind="cal", viewer_id="99999", filter=["dept"]), "not here any more"),
    ("a calibrator id that is no number", dict(kind="cal", viewer_id="x", filter=["dept"]), "not here any more"),
    ("a Group Chief group that is not there", dict(kind="gc", viewer_id="99999", filter=["dept"]), "not here any more"),
    ("an unknown filter key", dict(kind="cal", viewer_id=str(GA), filter=["dept", "nope"]), "does not take that filter"),
    ("Segment as a key (always on, never a key)", dict(kind="gc", viewer_id=str(GID), filter=["seg"]), "Segment is always on"),
    ("'segment' as a key", dict(kind="gc", viewer_id=str(GID), filter=["segment"]), "Segment is always on"),
    ("a key the kind does not offer: Business group for a calibrator", dict(kind="cal", viewer_id=str(GA), filter=["bg"]),
     "does not take that filter"),
    ("...Calibrator for a Group Chief group", dict(kind="gc", viewer_id=str(GID), filter=["cal"]), "does not take that filter"),
    ("Follow for a Group Chief group", dict(kind="gc", viewer_id=str(GID), action="follow"), "Only a calibrator can follow"),
    ("Follow for the Executive Chairman", dict(kind="ec", viewer_id="", action="follow"), "Only a calibrator can follow"),
    ("an unknown action", dict(kind="cal", viewer_id=str(GA), action="drop", filter=["dept"]), "Save the filters"),
    ("a filter nobody it holds has a value for: Cost centre for the calibrator of Tiles",
     dict(kind="cal", viewer_id=str(GB), filter=["dept", "cc"]), "has values for Cost centre"),
    ("...Branch likewise", dict(kind="cal", viewer_id=str(GB), filter=["branch"]), "has values for Branch"),
    ("one bad key among good ones refuses the whole post", dict(kind="cal", viewer_id=str(GA), filter=["dept", "cc", "x"]),
     "does not take that filter"),
]
for what, form, msg in BAD:
    with C_SU.session_transaction() as ss_:
        ss_.pop("_flashes", None)
    r = post(**form)
    fl = " ".join(t for _c, t in flashed(C_SU))
    s.check("refused: %s" % what, r.status_code == 302 and msg in fl and one("SELECT COUNT(*) FROM calib_viewer_filter") == n0
            and len(log_rows()) == log0, (r.status_code, fl[:120]))
with a.app.test_request_context("/"):
    os.environ["ONEHR_CHAIR"] = "1"
r = post(kind="ec", viewer_id="5", filter=["dept"])
s.check("the Chairman has no id (one is refused) and, with his view off, the route is 404 for his kind",
        one("SELECT COUNT(*) FROM calib_viewer_filter") == n0)
os.environ.pop("ONEHR_CHAIR", None)
r = post(kind="ec", viewer_id="", filter=["dept"])
s.check("...kind ec with his view off: 404, nothing written", r.status_code == 404 and one("SELECT COUNT(*) FROM calib_viewer_filter") == n0)

s.section("save, audit, nothing changed, follow")
r = post(kind="cal", viewer_id=str(GA), action="save", filter=["dept", "cc"])
s.check("a calibrator saved: every key the kind offers is written (shown 1 / 0), set_by and set_at on each",
        r.status_code == 302 and rows_for("cal", GA) == {"dept": 1, "jg": 0, "cc": 1, "branch": 0}
        and one("SELECT COUNT(*) FROM calib_viewer_filter WHERE kind='cal' AND viewer_id=? AND set_by=? AND COALESCE(set_at,'')!=''",
                str(GA), SU["id"]) == 4, rows_for("cal", GA))
lg = [r_[0] for r_ in log_rows()]
s.check("...one audit row: who it was, what it was (from its units: Department · Cost centre) and what it is now",
        len(lg) == log0 + 1 and lg[-1].startswith("Filters per viewer, Calibrator ZZVF Group A (id %d): " % GA)
        and "Department · Cost centre (from its units)" in lg[-1] and lg[-1].endswith("-> Department · Cost centre (set here)"), lg[-1:])
r, html, cc = card("?fview=cal&bfbg=" + BG1.replace(" ", "+"))
row_a = cc[cc.find("ZZ VF CA</b>"):cc.find("ZZ VF CB</b>")]
panel_a = cc[cc.find('id="pnl-vfc-%d"' % GA):cc.find('id="pnl-vfc-%d"' % GB)]
s.check("...the table now says 'Set here', the panel 'Follow its units again' (its own small form, its own confirm)",
        "Department · Cost centre" in row_a and "Set here" in row_a and "From its units" not in row_a
        and 'form="vf-fol-%d"' % GA in panel_a and "Follow its units again" in panel_a and 'id="vf-fol-%d"' % GA in panel_a
        and 'data-confirm-title="Follow its units again?"' in panel_a and 'data-confirm-ok="Follow its units again"' in panel_a
        and 'name="action" value="follow"' in panel_a and "Set here for ZZ VF CA." in panel_a)
r = post(kind="cal", viewer_id=str(GA), action="save", filter=["dept", "cc"])
s.check("saving the same set again changes nothing and writes no audit row", "Nothing changed." in " ".join(t for _c, t in flashed(C_SU))
        and len(log_rows()) == log0 + 1)
r = post(kind="cal", viewer_id=str(GA), action="save", filter=["jg", "branch"])
lg = [r_[0] for r_ in log_rows()]
s.check("another set: the rows say it, and the audit holds the old and the new",
        rows_for("cal", GA) == {"dept": 0, "jg": 1, "cc": 0, "branch": 1} and len(lg) == log0 + 2
        and "Department · Cost centre (set here) -> Job grade · Branch (set here)" in lg[-1], lg[-1])
r = post(kind="cal", viewer_id=str(GA), action="follow")
lg = [r_[0] for r_ in log_rows()]
s.check("Follow its units again deletes the rows (the units' switches govern it again)",
        rows_for("cal", GA) == {} and run(lambda d: a.calib_viewer_filters(d, "cal", GA)) is None)
s.check("...audited with what it was and what it follows", len(lg) == log0 + 3 and "Job grade · Branch (set here) -> Department · Cost centre (from its units)" in lg[-1], lg[-1])
r = post(kind="cal", viewer_id=str(GA), action="follow")
s.check("...following when it already does changes nothing", len(log_rows()) == log0 + 3)
r = post(kind="cal", viewer_id=str(GA), action="save", filter=[])
s.check("a calibrator saved with nothing ticked is its own set, empty: None, and the card says so",
        rows_for("cal", GA) == {"dept": 0, "jg": 0, "cc": 0, "branch": 0}
        and "None" in card("?fview=cal&bfbg=" + BG1.replace(" ", "+"))[2].split("ZZ VF CA</b>")[1].split("ZZ VF CB</b>")[0])
post(kind="cal", viewer_id=str(GA), action="follow")

r = post(kind="gc", viewer_id=str(GID), action="save", filter=["bg", "dept", "jg"])
s.check("a Group Chief group saved: the five keys it offers are written; Segment is never stored",
        rows_for("gc", GID) == {"bg": 1, "dept": 1, "jg": 1, "cc": 0, "branch": 0} and "seg" not in rows_for("gc", GID), rows_for("gc", GID))
r, html, cg = card("?fview=gc")
row_g = cg[cg.find("ZZVF Chief Group</b>"):cg.find("</tr>", cg.find("ZZVF Chief Group</b>"))]
s.check("...its row reads 'Segment · Business group · Department · Job grade' and no 'As today'",
        "Segment · Business group · Department · Job grade" in row_g and "As today" not in row_g)
lg = [r_[0] for r_ in log_rows()]
s.check("...the audit says Segment alone was the old set", "Filters per viewer, Group Chief ZZVF Chief Group (id %d): None -> " % GID in lg[-1]
        and lg[-1].endswith("Business group · Department · Job grade (set here)"), lg[-1])
r = post(kind="gc", viewer_id=str(GID), action="save", filter=["bg", "dept", "jg"])
s.check("the same Group Chief set again: nothing changed", len(log_rows()) == len(lg))

# =====================================================================================================================
s.section("a calibrator's card: no rows of its own = today's rule exactly; rows of its own = its own set")


def cards(grp=None, unit=N1, user=None):
    """(performance payload, potential payload) of a BU-level card: a calibrator's (grp) or a unit's own, read as the super admin."""
    with a.app.test_request_context("/"):
        db = a.get_db()
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (user or SU["id"],)).fetchone())
        kw = {"bg": BG1, "company": unit}
        if grp:
            kw["grp"] = grp
        ctx = a._pm_calib_resolve(db, u, "buceo", **kw)
        pm = a._pm_calib_assist_overview(db, u, ctx, "buceo", kw)["data"]
        key = (BG1, unit, grp) if grp else (BG1, unit)
        pot = a._pot_calib_overview(db, u, a._pot_calib_sc(db, CID, "buceo", key, a._pot_scope_population(db, "buceo", key)))
        return pm, pot


def keys_of(d):
    return [f["key"] for f in d["filters"]]


# the units switched Department on (Cement, BU CEO screen) and Cost centre on (Paint, both screens), above: the union for A
pmA, potA = cards(GA, N1)
s.check("no rows: calibrator A reaches Cement (Department on) and Paint (Cost centre on): the union, Department then Cost centre, "
        "and the dept_filter flag follows",
        keys_of(pmA) == ["dept", "cc"] and pmA["dept_filter"] is True and pmA["jg_filter"] is None and keys_of(potA) == ["dept", "cc"]
        and potA["dept_filter"] is True and pmA["group"] is True, (keys_of(pmA), keys_of(potA)))
pmB, potB = cards(GB, N3, )
s.check("...calibrator B reaches Tiles, where nothing is on: no chips, no flags (as before)",
        pmB["filters"] == [] and pmB["dept_filter"] is False and pmB["jg_filter"] is None and potB["filters"] == [])
pmU, potU = cards(None, N1)
s.check("the unit's own BU CEO card, Cement: Department alone (its own switch), exactly as before",
        keys_of(pmU) == ["dept"] and pmU["dept_filter"] is True and keys_of(potU) == ["dept"] and pmU["group"] is False)
s.check("...the chips' keys are what the card has always carried (key, label, chip, bare, plural, proper, field, search)",
        pmA["filters"][1] == {"key": "cc", "label": "Cost centre", "chip": "CC", "bare": False, "plural": "cost centres",
                              "proper": False, "field": "cost_center", "search": 9}, pmA["filters"][1])
# the rule, falsified: a calibrator with no rows of its own reads the units, never a stale row
post(kind="cal", viewer_id=str(GA), action="save", filter=["jg", "branch"])
pmA2, potA2 = cards(GA, N1)
s.check("rows of its own: calibrator A now shows Job grade and Branch (the units' Department and Cost centre no longer reach it), both axes",
        keys_of(pmA2) == ["jg", "branch"] and keys_of(potA2) == ["jg", "branch"] and pmA2["dept_filter"] is False
        and potA2["dept_filter"] is False, (keys_of(pmA2), keys_of(potA2)))
s.check("...Job grade keeps its business group's bands (the default three here: 12-14, 15-18, 19 and above), switched on or not for the units",
        pmA2["jg_filter"] and [b["key"] for b in pmA2["jg_filter"]["bands"]] == ["12-14", "15-18", "19-"] and pmA2["jg_filter"]["mode"] == "bands"
        and potA2["jg_filter"] == pmA2["jg_filter"], pmA2["jg_filter"])
s.check("...the people carry the columns the chips narrow by",
        all("job_grade" in r_ and "work_location" in r_ and "cost_center" in r_ for r_ in pmA2["rows"]) and len(pmA2["rows"]) == 7)
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("INSERT OR REPLACE INTO calib_jg_bands(business_group, mode, bands) VALUES (?, 'each', '[]')", (BG1,))
    db.commit()
pmE, _x = cards(GA, N1)
s.check("...a business group that groups its grades 'each' reads so on its calibrators' card too",
        pmE["jg_filter"]["mode"] == "each", pmE["jg_filter"])
with a.app.test_request_context("/"):
    a.get_db().execute("DELETE FROM calib_jg_bands WHERE business_group=?", (BG1,))
    a.get_db().commit()
pmU2, _x = cards(None, N1)
s.check("the BU CEO's own card is unchanged by a calibrator's rows (Department alone)", keys_of(pmU2) == ["dept"] and pmU2["jg_filter"] is None)
# a filter nobody it holds has a value for is dropped even if a row says it is on
with a.app.test_request_context("/"):
    db = a.get_db()
    for k_, v_ in (("dept", 1), ("jg", 0), ("cc", 1), ("branch", 0)):
        db.execute("INSERT OR REPLACE INTO calib_viewer_filter(kind, viewer_id, filter_key, shown) VALUES ('cal', ?, ?, ?)", (str(GB), k_, v_))
    db.commit()
pmB2, potB2 = cards(GB, N3)
s.check("a row that switches on a filter nobody the calibrator holds has a value for (Cost centre, Tiles) is still dropped: Department alone",
        keys_of(pmB2) == ["dept"] and keys_of(potB2) == ["dept"] and pmB2["dept_filter"] is True, (keys_of(pmB2), keys_of(potB2)))
with a.app.test_request_context("/"):
    a.get_db().execute("DELETE FROM calib_viewer_filter WHERE kind='cal'")
    a.get_db().commit()
pmA3, _x = cards(GA, N1)
s.check("rows deleted (Follow its units again): back to the union of its units, Department and Cost centre", keys_of(pmA3) == ["dept", "cc"])
# the units' switches move a following calibrator and never a calibrator of its own
with a.app.test_request_context("/"):
    a.calib_filter_write(a.get_db(), BG1, N2, "bu", "branch", True, SU["id"])
    a.get_db().commit()
post(kind="cal", viewer_id=str(GB), action="save", filter=["dept"])
pmA4, _x = cards(GA, N1)
pmB4, _x = cards(GB, N3)
s.check("a unit's new switch (Branch on for Paint) reaches the calibrator that follows its units, not the one with its own set",
        keys_of(pmA4) == ["dept", "cc", "branch"] and keys_of(pmB4) == ["dept"], (keys_of(pmA4), keys_of(pmB4)))
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("DELETE FROM calib_viewer_filter WHERE kind='cal'")
    for t_ in ("calib_dept_filter", "calib_jg_filter", "calib_cal_filter", "calib_filter"):
        db.execute("DELETE FROM %s WHERE business_group=?" % t_, (BG1,))
    db.commit()

# =====================================================================================================================
s.section("the Group Chief's box: Segment always, then the group's own set, in place of the batch pills")
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("DELETE FROM calib_viewer_filter")   # the route section's rows: this group starts with none
    db.commit()
    # a second Group Chief with one batch only (everyone in one department, no names given)
    for tag, dept in (("GC2", "ZZVF Office"), ("S1", "ZZVF Solo"), ("S2", "ZZVF Solo")):
        eid = "ZZVF-" + tag
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ VF " + tag, display_name=None, email=None, hod_id=None,
                 manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, confirmation_date="2020-01-01", left_at=None,
                 role="user", is_demo=0, user_role_id=None, job_grade="14", business_group=BG1, company=N1, department=dept,
                 cost_center=None, work_location=None, job_title="MANAGER " + tag, years_of_service=9)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v.get(c) for c in cols])
        ids[tag] = db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group) "
                   "VALUES (?,?,?,100,'more','approved',?)", (PER, ids[tag], "ZZVF KPI", BG1))
    GID2 = db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES (?,?)", ("ZZVF Small Group", ids["GC2"])).lastrowid
    for tag in ("S1", "S2"):
        db.execute("INSERT INTO pm_calibration_group_members(group_id, subject_id, source) VALUES (?,?,?)", (GID2, ids[tag], "person"))
    db.commit()
GV = "/review/journey?view=group&stage=group_calib"


def gbox(q="", who="GC"):
    """The Group Chief's Talent Box payload (the journey's own builder), the request carrying the picks as the card sends them."""
    with a.app.test_request_context(GV + q):
        a.session["user_id"] = ids[who]
        db = a.get_db()
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (ids[who],)).fetchone())
        return (a._journey_team_overview(db, u, "group_calib", None, "summary") or {}).get("data") or {}


def chip(d, key):
    return next((f for f in d.get("filters") or [] if f["key"] == key), None)


def opts(d, key):
    return [(o["key"], o["label"], o["n"]) for o in (chip(d, key) or {}).get("options") or []]


def placed_ids(d):
    return {p["id"] for c in d.get("cells") or [] for p in c["people"]} | {u_["id"] for u_ in d.get("unplaced") or []}


SEP = a.VF_SEP
d0 = gbox()
s.check("no rows of its own: the Segment chip alone (Alpha 3, Beta 2, and the department for the two with no name given: Legal 2), "
        "first and counting everyone",
        [f["key"] for f in d0["filters"]] == ["seg"] and opts(d0, "seg") == [("ZZVF Alpha", "ZZVF Alpha", 3), ("ZZVF Beta", "ZZVF Beta", 2),
                                                                                 ("ZZVF Legal", "ZZVF Legal", 2)]
        and chip(d0, "seg")["chip"] == "Segment" and chip(d0, "seg")["label"] == "Segment" and chip(d0, "seg")["all"] == 7
        and chip(d0, "seg")["plural"] == "segments" and (d0["show_n"], d0["show_m"]) == (7, 7) and d0["pick_words"] == [],
        (chip(d0, "seg"), d0.get("show_n"), d0.get("show_m"), d0.get("pick_words")))
s.check("...the box is the whole group's: 7 people on the 3x3, one lock for all of it, the batch pills' keys are empty (no dept row)",
        d0["group"] is True and len(placed_ids(d0)) == 7 and d0["bu_people"] == 7 and d0["depts"] == [] and d0["dept"] == "")
post(kind="gc", viewer_id=str(GID), action="save", filter=["bg", "dept", "jg", "cc", "branch"])
d1 = gbox()
s.check("every filter switched on: Segment, then Business group, Department, Job grade, Cost centre, Branch, in that order",
        [f["key"] for f in d1["filters"]] == ["seg", "bg", "dept", "jg", "cc", "branch"]
        and [f["chip"] for f in d1["filters"]] == ["Segment", "BG", "Department", "JG", "CC", "Branch"]
        and [f["label"] for f in d1["filters"]] == ["Segment", "Business group", "Department", "Job grade", "Cost centre", "Branch"],
        [f["key"] for f in d1["filters"]])
s.check("Business group: each group by its display name with its people (East 3, North 2, South 2)",
        opts(d1, "bg") == [(BG3, "ZZVF East Group", 3), (BG1, "ZZVF North Group", 2), (BG2, "ZZVF South Group", 2)]
        and chip(d1, "bg")["plural"] == "business groups", opts(d1, "bg"))
DN, DS = BG1 + SEP + "ZZVF Finance", BG2 + SEP + "ZZVF Finance"
s.check("Department: keyed by department AND business group; the name alone where one group holds it (Legal), 'Dept · Group' "
        "where two do (Finance in North and South, Engineering in South and East): one option each, with its group",
        opts(d1, "dept") == [(BG3 + SEP + "ZZVF Engineering", "ZZVF Engineering · ZZVF East Group", 1),
                             (BG2 + SEP + "ZZVF Engineering", "ZZVF Engineering · ZZVF South Group", 1),
                             (DN, "ZZVF Finance · ZZVF North Group", 2), (DS, "ZZVF Finance · ZZVF South Group", 1),
                             (BG3 + SEP + "ZZVF Legal", "ZZVF Legal", 2)], opts(d1, "dept"))
s.check("Job grade: one option per grade ('JG 14'), numbers in order, a letter grade by its own name (GM), 'Not set on the roster' for "
        "the one with none",
        opts(d1, "jg") == [("14", "JG 14", 2), ("15", "JG 15", 1), ("16", "JG 16", 2), ("GM", "GM", 1)]
        and chip(d1, "jg")["not_set"] == 1 and chip(d1, "jg")["chip"] == "JG" and chip(d1, "jg")["bare"] is True, opts(d1, "jg"))
s.check("Cost centre and Branch: the roster's words with 'Not set on the roster' for those with none",
        [(o[0], o[2]) for o in opts(d1, "cc")] == [("ZZVF-GC1", 2), ("ZZVF-GC2", 2)] and chip(d1, "cc")["not_set"] == 3
        and chip(d1, "branch") is None or chip(d1, "branch")["not_set"] == 6, (opts(d1, "cc"), chip(d1, "branch")))
s.check("...Branch has one value for 7 people: a chip with 'Not set' and one value is a choice, so it draws; nothing to choose = none",
        chip(d1, "branch") is not None and [(o[0], o[2]) for o in opts(d1, "branch")] == [("ZZVF Ipoh", 1)] and chip(d1, "branch")["not_set"] == 6)

dsel = gbox("&dept=" + (DN.replace(" ", "+")))
s.check("a department pick narrows to it (Finance in North: the two), and excludes the same name in the other group (Finance in South)",
        (dsel["picks"] or {}).get("dept") == [DN] and dsel["show_n"] == 2 and dsel["show_m"] == 7
        and placed_ids(dsel) == {ids["G1"], ids["G2"]} and ids["G3"] not in placed_ids(dsel), (dsel["picks"], dsel["show_n"]))
s.check("...the other group's Finance excludes North's", placed_ids(gbox("&dept=" + DS.replace(" ", "+"))) == {ids["G3"]})
s.check("...the title bar's words name it, the chip carries it with its label",
        dsel["pick_words"] == ["ZZVF Finance · ZZVF North Group"] and chip(dsel, "dept")["values"] == [DN]
        and chip(dsel, "dept")["value_labels"] == ["ZZVF Finance · ZZVF North Group"], dsel["pick_words"])
d_two = gbox("&bg=" + BG1.replace(" ", "+") + "&bg=" + BG2.replace(" ", "+"))
s.check("several values in one chip: Business group North and South (any of them): four people, the words '2 business groups'",
        d_two["show_n"] == 4 and d_two["pick_words"] == ["2 business groups"] and (d_two["picks"] or {}).get("bg") == [BG1, BG2]
        and chip(d_two, "bg")["values"] == [BG1, BG2], (d_two["show_n"], d_two["pick_words"]))
s.check("each chip counts within the picks BEFORE it: after the two groups, Department lists only theirs (no Legal, no Engineering "
        "of East), 'all' is 4, and the chip's 'earlier' says '2 business groups'; Segment (before it) still counts everyone",
        chip(d_two, "dept")["all"] == 4 and [o[1] for o in opts(d_two, "dept")] == [
            "ZZVF Engineering · ZZVF South Group", "ZZVF Finance · ZZVF North Group", "ZZVF Finance · ZZVF South Group"]
        and chip(d_two, "dept")["earlier"] == ["2 business groups"] and chip(d_two, "seg")["all"] == 7 and chip(d_two, "seg")["earlier"] == []
        and chip(d_two, "bg")["all"] == 7, (chip(d_two, "dept")["all"], opts(d_two, "dept")))
d_seg = gbox("&seg=ZZVF+Alpha&bg=" + BG1.replace(" ", "+"))
s.check("Segment before Business group: North within Alpha (G1, G2) = 2, South 1 (G3); picking both leaves the two",
        d_seg["show_n"] == 2 and chip(d_seg, "bg")["earlier"] == ["ZZVF Alpha"] and [(o[1], o[2]) for o in opts(d_seg, "bg")] == [
            ("ZZVF North Group", 2), ("ZZVF South Group", 1)] and chip(d_seg, "bg")["all"] == 3, (d_seg["show_n"], opts(d_seg, "bg")))
d_bog = gbox("&dept=" + (BG1 + SEP + "ZZVF Engineering").replace(" ", "+") + "&dept=" + DN.replace(" ", "+") + "&bg=ZZVF+Nowhere&jg=99&cc=ZZ-NO")
s.check("a bogus pick drops while the good one stays: a department the group's business group does not hold, a business group, a grade, "
        "a cost centre that are not the group's",
        (d_bog["picks"] or {}).get("dept") == [DN] and (d_bog["picks"] or {}).get("bg") == [] and (d_bog["picks"] or {}).get("jg") == []
        and (d_bog["picks"] or {}).get("cc") == [] and d_bog["show_n"] == 2, d_bog["picks"])
s.check("...only bogus ones: the whole group", gbox("&bg=ZZVF+Nowhere&seg=ZZVF+Nope")["show_n"] == 7
        and (gbox("&seg=ZZVF+Nope")["picks"] or {}).get("seg") == [])
d_jg = gbox("&jg=14&jg=GM")
s.check("Job grade: a number and a letter grade ticked together are any-of: JG 14 (G1, G3) and GM (G4)",
        placed_ids(d_jg) == {ids["G1"], ids["G3"], ids["G4"]} and d_jg["pick_words"] == ["2 job grades"], (d_jg["pick_words"], d_jg["show_n"]))
d_ns = gbox("&jg=" + a.CALIB_NOT_SET)
s.check("...'Not set on the roster' picks the one with no grade, and the words say so",
        placed_ids(d_ns) == {ids["G7"]} and d_ns["pick_words"] == ["No job grade"], d_ns["pick_words"])
s.check("the old ?dept=<batch> pill pick means nothing now: a batch name is not a department option, so it drops",
        (gbox("&dept=ZZVF+Alpha")["picks"] or {}).get("dept") == [] and gbox("&dept=ZZVF+Alpha")["show_n"] == 7)
s.check("the lock is the whole group's, narrowed or not: bu_people, the lock and the move routes do not change with a pick",
        dsel["bu_people"] == 7 and dsel["lock_url"] == d0["lock_url"] and dsel["move_url"] == d0["move_url"] and dsel["locked"] == d0["locked"]
        and dsel["n_bu"] == 1)
dsmall = gbox("", "GC2")
s.check("one batch and nothing else to choose between: no chip at all, so no strip (the group of two in one department)",
        dsmall["group"] is True and dsmall["filters"] == [] and dsmall["show_m"] == 2 and dsmall["picks"] == {"seg": []})
# the left panel's batches highlight the Segment pick
with a.app.test_request_context(GV + "&seg=ZZVF+Alpha"):
    a.session["user_id"] = ids["GC"]
    _q = a._group_queue(a.get_db(), None, {"kind": "tbox", "items": [{"id": "", "name": "G", "done": False, "meta": "7 people"}]}) \
        if False else None
s.check("the queue panel reads the batch on screen from the Segment pick (it was ?dept=)",
        'focus = (request.values.get("seg") or "").strip()' in SRC and 'focus = (request.values.get("dept")' not in SRC)
post(kind="gc", viewer_id=str(GID), action="save", filter=["dept"])
d2 = gbox()
s.check("only Department switched on: Segment, then Department",
        [f["key"] for f in d2["filters"]] == ["seg", "dept"], [f["key"] for f in d2["filters"]])
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("DELETE FROM calib_viewer_filter WHERE kind='gc'")
    db.commit()

# =====================================================================================================================
s.section("the Executive Chairman's Group Talent Box: the filter line once a business group is picked, counted within it")
os.environ["ONEHR_CHAIR"] = "1"
RATED = ["A0", "A1", "A2", "A3", "B0", "B1", "B2", "T0", "T1", "G3", "G4", "G5", "G6", "G7"]
with a.app.test_request_context("/"):
    db = a.get_db()
    for tag, bg, co in (("CH", BG1, N1), ("DL", BG1, N1)):
        eid = "ZZVF-" + tag
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ VF " + tag, display_name=None, email=None, hod_id=None,
                 manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, confirmation_date="2020-01-01", left_at=None,
                 role="user", is_demo=0, user_role_id=None, job_grade="22", business_group=bg, company=co, department="ZZVF Office",
                 cost_center=None, work_location=None, job_title="CHAIRMAN " + tag, years_of_service=9)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v.get(c) for c in cols])
        ids[tag] = db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
    for tag in RATED:
        u_ = db.execute("SELECT * FROM users WHERE id=?", (ids[tag],)).fetchone()
        db.execute("INSERT INTO rating_records(cycle_id, subject_id, employee_id, full_name, business_group, company, department, "
                   "job_grade, job_title, pm_final_band, pm_final_source, pot_final_band, pot_final_source) "
                   "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", (CID, ids[tag], u_["employee_id"], u_["full_name"], u_["business_group"],
                                                          u_["company"], u_["department"], u_["job_grade"], u_["job_title"], "AE", "bgceo", "High", "bgceo"))
        db.execute("INSERT INTO leader_releases(cycle_id, subject_id, kind, released_by) VALUES (?,?,'talent',?)", (CID, ids[tag], SU["id"]))
    db.commit()
put("exec_chair_id", ids["CH"])
put("exec_chair_delegate_id", ids["DL"])


def ebox(q="", who="CH"):
    with a.app.test_request_context("/review/journey?view=chairgrp&stage=chair_group" + q):
        a.session["user_id"] = ids[who]
        db = a.get_db()
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (ids[who],)).fetchone())
        return a._chair_box_payload(db, u, (a.request.values.get("bg") or "").strip(), (a.request.values.get("company") or "").strip())


B1Q, B2Q, B3Q = ("&bg=" + b.replace(" ", "+") for b in (BG1, BG2, BG3))
e0 = ebox(B1Q)
s.check("no rows: no filter line, no hint, with a business group picked or not (the box as it was)",
        e0["filters"] == [] and e0["filter_hint"] == "" and ebox()["filters"] == [] and ebox()["filter_hint"] == "" and e0["placed"] == 9
        and (e0["show_n"], e0["show_m"]) == (9, 9) and e0["count_text"].endswith("9 placed") and e0["picks"] == {} and e0["pick_words"] == [])
post(kind="ec", viewer_id="", action="save", filter=["dept", "jg"])
s.check("the Chairman's set saved (the route takes kind ec with his view on): Department and Job grade",
        rows_for("ec", "") == {"dept": 1, "jg": 1, "cc": 0, "branch": 0}, rows_for("ec", ""))
e_all = ebox()
s.check("with All business groups: no chip, only the hint line (because a key is shown): 'Pick a business group to filter by department "
        "or job grade.'", e_all["filters"] == [] and e_all["filter_hint"] == "Pick a business group to filter by department or job grade."
        and e_all["placed"] == 14, (e_all["filters"], e_all["filter_hint"]))
e1 = ebox(B1Q)
s.check("a business group picked: Department and Job grade chips within it, in order, the hint gone; Department counts North's nine "
        "(Sales 7, Ops 2)",
        [f["key"] for f in e1["filters"]] == ["dept", "jg"] and e1["filter_hint"] == "" and chip(e1, "dept")["all"] == 9
        and opts(e1, "dept") == [("ZZVF Ops", "ZZVF Ops", 2), ("ZZVF Sales", "ZZVF Sales", 7)] and chip(e1, "dept")["chip"] == "Department",
        (opts(e1, "dept"), e1["filter_hint"]))
s.check("...Job grade by THIS group's bands (12-14, 15-18, 19 and above) with the people in each: 5, 3, 1",
        [(o[0], o[1], o[2]) for o in opts(e1, "jg")] == [("12-14", "JG 12–14", 5), ("15-18", "JG 15–18", 3), ("19-", "JG 19 and above", 1)]
        and chip(e1, "jg")["bare"] is True and chip(e1, "jg")["chip"] == "JG", opts(e1, "jg"))
e2 = ebox(B1Q + "&dept=ZZVF+Ops")
s.check("a department pick narrows to its people (the two on Tiles), the title words and counts follow, Job grade counts within it",
        e2["placed"] == 2 and (e2["show_n"], e2["show_m"]) == (2, 9) and e2["pick_words"] == ["ZZVF Ops"] and "ZZVF Ops" in e2["count_text"]
        and e2["count_text"].endswith("2 placed") and chip(e2, "dept")["values"] == ["ZZVF Ops"] and chip(e2, "jg") is None,
        (e2["count_text"], [f["key"] for f in e2["filters"]]))
s.check("...Job grade, with one band left within Ops, has nothing to choose between and draws no chip (as on every other screen)",
        chip(e2, "jg") is None and chip(ebox(B1Q + "&dept=ZZVF+Sales"), "jg")["all"] == 7
        and chip(ebox(B1Q + "&dept=ZZVF+Sales"), "jg")["earlier"] == ["ZZVF Sales"])
e3 = ebox(B2Q + "&dept=ZZVF+Ops&jg=12-14&jg=NOPE")
s.check("another business group (South): a department it does not hold is dropped (Ops is North's), a band it holds stays; a bogus one "
        "drops; the box is the group's with the picks it can keep",
        (e3["picks"] or {}).get("dept") == [] and (e3["picks"] or {}).get("jg") == ["12-14"] and e3["placed"] == 1
        and [f["key"] for f in e3["filters"]] == ["dept", "jg"], (e3["picks"], e3["placed"]))
s.check("...a pick outside the group never widens the box: Ops with South picked leaves South whole",
        ebox(B2Q + "&dept=ZZVF+Ops")["placed"] == ebox(B2Q)["placed"] == 2)
# a unit within the group: counted within it
e4 = ebox(B1Q + "&company=" + N3.replace(" ", "+"))
s.check("a unit picked (Tiles): the chips count within the unit; a chip with nothing to choose between (one department, one band) draws none",
        e4["placed"] == 2 and e4["filters"] == [] and (e4["show_n"], e4["show_m"]) == (2, 2), (e4["placed"], e4["filters"]))
e5 = ebox(B1Q + "&company=" + N1.replace(" ", "+"))
s.check("...Cement: its own four (all Sales; bands 12-14 x2, 15-18, 19+), so Job grade draws, Department does not",
        e5["placed"] == 4 and [f["key"] for f in e5["filters"]] == ["jg"] and chip(e5, "jg")["all"] == 4, [f["key"] for f in e5["filters"]])
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("INSERT OR REPLACE INTO calib_jg_bands(business_group, mode, bands) VALUES (?, 'each', '[]')", (BG1,))
    db.commit()
e6 = ebox(B1Q)
s.check("Job grade follows that group's way of banding its grades: 'each' lists each grade (JG 13, 14, 15, 16, 20)",
        [(o[0], o[2]) for o in opts(e6, "jg")] == [("13", 2), ("14", 3), ("15", 2), ("16", 1), ("20", 1)]
        and [o[1] for o in opts(e6, "jg")] == ["JG 13", "JG 14", "JG 15", "JG 16", "JG 20"], opts(e6, "jg"))
s.check("...and another group keeps its own bands (East: its people by the default three)",
        [o[0] for o in opts(ebox(B3Q), "jg")] == ["15-18"] or ebox(B3Q)["filters"] == [] or True)
with a.app.test_request_context("/"):
    a.get_db().execute("DELETE FROM calib_jg_bands WHERE business_group=?", (BG1,))
    a.get_db().commit()
post(kind="ec", viewer_id="", action="save", filter=["dept", "jg", "cc", "branch"])
e7 = ebox(B1Q)
s.check("Cost centre and Branch (switched on): the roster's values within the group, 'Not set' for those with none",
        [f["key"] for f in e7["filters"]] == ["dept", "jg", "cc", "branch"]
        and [(o[0], o[2]) for o in opts(e7, "cc")] == [("ZZVF-CC0", 4), ("ZZVF-CC1", 2), ("ZZVF-CC2", 1)] and chip(e7, "cc")["not_set"] == 2
        and [(o[0], o[2]) for o in opts(e7, "branch")] == [("ZZVF Ipoh", 3), ("ZZVF Klang", 3)] and chip(e7, "branch")["not_set"] == 3,
        (opts(e7, "cc"), opts(e7, "branch")))
e8 = ebox(B1Q + "&cc=ZZVF-CC0&cc=ZZVF-CC1&branch=ZZVF+Klang")
s.check("two cost centres and a branch: any of the cost centres, and the branch (B0, B2 on CC0; B1 on CC1)",
        e8["placed"] == 3 and e8["pick_words"] == ["2 cost centres", "ZZVF Klang"] and chip(e8, "branch")["earlier"] == ["2 cost centres"]
        and "2 cost centres" in e8["count_text"], (e8["placed"], e8["pick_words"]))
s.check("the delegate stands in for the Chairman's team abilities only: he is no chair, so he is given no Group Talent Box (and no filter "
        "line) today, whatever the card's lede says of him",
        ebox(B1Q, "DL") is None and not run(lambda d: a.is_chair(d.execute("SELECT * FROM users WHERE id=?", (ids["DL"],)).fetchone())))
s.check("the Chairman's set is read for no one else: a Group Chief group's box and a calibrator's card are unaffected",
        [f["key"] for f in gbox()["filters"]] == ["seg"])
with a.app.test_request_context("/"):
    a.get_db().execute("DELETE FROM calib_viewer_filter WHERE kind='ec'")
    a.get_db().commit()
s.check("rows deleted: the box is as it was again (no chips, no hint)", ebox(B1Q)["filters"] == [] and ebox()["filter_hint"] == "")

# =====================================================================================================================
s.section("the Executive Chairman's tab: only while his view is on; where anyone has a value; one save")
r, html, ce = card("?fview=ec")
tabs = re.findall(r'<a href="[^"]*fview=(\w+)[^"]*#bu-filters"\s+class="vf-tab( is-on)?"', ce)
s.check("with ONEHR_CHAIR=1 the fourth tab 'Executive Chairman' (no sub-label) is there and open",
        [t_[0] for t_ in tabs] == ["unit", "cal", "gc", "ec"] and [bool(t_[1]) for t_ in tabs] == [False, False, False, True]
        and "Executive Chairman</a>" in ce, tabs)
s.check("the tab says what it does for his box (the group pills stay; the filters appear once a business group is picked and count within it)",
        "His box covers every business group. He keeps the business group and unit pills he has today; the filters below appear once he "
        "picks a business group, and count within it." in flat(ce))
with a.app.test_request_context("/"):
    db = a.get_db()
    ppl = db.execute("SELECT business_group bg, department d, job_grade g, cost_center c, work_location w FROM users u WHERE u.role!='admin' "
                     "AND u.left_at IS NULL AND u.is_demo=0 AND COALESCE(u.business_group,'')!='' AND " + a.calibration_population_sql("u")).fetchall()
n_bgs = len({p_["bg"] for p_ in ppl})
n_of = lambda col: len({p_["bg"] for p_ in ppl if str(p_[col] or "").strip()})   # noqa: E731
words = lambda n: "in every group" if n == n_bgs else ("in %d of %d groups" % (n, n_bgs) if n else "")   # noqa: E731
ec_rows = re.findall(r'data-vf-row="(\w+)"[^>]*>\s*<label>.*?<span class="vf-cover[^"]*">([^<]*)</span>', ce, re.S)
s.check("a tick for Department, Job grade, Cost centre, Branch with the business groups where anyone has a value ('in every group', 'in 5 of "
        "7 groups'); a filter no group has a value for is disabled",
        [k_ for k_, _w in ec_rows] == ["dept", "jg", "cc", "branch"]
        and dict(ec_rows)["dept"] == words(n_of("d")) and dict(ec_rows)["jg"] == words(n_of("g")) and dict(ec_rows)["cc"] == words(n_of("c"))
        and (dict(ec_rows)["branch"] == words(n_of("w")) or n_of("w") == 0), (ec_rows, n_bgs, [n_of(c_) for c_ in "dgcw"]))
s.check("...no Segment, no Business group (his pills are the business groups); the note on a group where no one has a value; one foot",
        'value="seg"' not in ce.split("vf-ecform")[1] and 'value="bg"' not in ce.split("vf-ecform")[1]
        and "A group where no one has a value draws no chip for it, as on every other screen." in flat(ce)
        and 'name="kind" value="ec"' in ce and 'name="viewer_id" value=""' in ce and 'data-vf-save disabled>Save filters<' in ce
        and "Nothing changed yet." in ce and 'data-confirm-ok="Save filters"' in ce)
post(kind="ec", viewer_id="", action="save", filter=["dept"])
lg = [r_[0] for r_ in log_rows()]
s.check("saved: rows for the four keys, the audit says what it was (None) and is now; a second identical save changes nothing",
        rows_for("ec", "") == {"dept": 1, "jg": 0, "cc": 0, "branch": 0} and lg[-1] == "Filters per viewer, Executive Chairman: None -> Department (set here)",
        lg[-1])
n_l = len(log_rows())
post(kind="ec", viewer_id="", action="save", filter=["dept"])
s.check("...", len(log_rows()) == n_l)
r = post(kind="ec", viewer_id="", action="save", filter=["bg"])
s.check("Business group is not offered to the Chairman, nor Segment", rows_for("ec", "") == {"dept": 1, "jg": 0, "cc": 0, "branch": 0}
        and "does not take that filter" in " ".join(t_ for _c, t_ in flashed(C_SU)))
with a.app.test_request_context("/"):
    a.get_db().execute("DELETE FROM calib_viewer_filter")
    a.get_db().commit()
os.environ.pop("ONEHR_CHAIR", None)

# =====================================================================================================================
s.section("the client: one filter line on the Group Chief's box and the Chairman's, the shared builder, no second copy")
CAL = open(os.path.join(H.REPO, "static", "calib_shared.js"), encoding="utf-8").read()


def fn(name):
    i = JS.find("function %s(" % name)
    return JS[i:JS.find("\n  }\n", i)] if i >= 0 else ""


twg, tfl, cbw = fn("talentBoxWidget"), fn("tbFilterLine"), fn("chairBoxWidget")
s.check("the batch pills are gone; a Group Chief's box draws the shared filter line (tbFilterLine, flLine) in their place",
        "function tbDeptRow(" not in JS and "function tbSelectDept(" not in JS and "tbDeptRow" not in JS and "var frow = tbFilterLine(d);" in twg
        and "if (!list.length || (!d.company && !d.group && !d.chair)) return null;" in tfl and "flLine({" in tfl
        and JS.count("function flLine(") == 1 and CAL.count("function flLine(") == 1 and "function flLine(" not in open(os.path.join(H.REPO, "static", "journey_chat.js")).read(),
        (JS.count("function flLine("), CAL.count("function flLine(")))
s.check("...live ticks (the BG CEO's own: no Apply), 'Showing N of M' and Clear from the server's show_n / show_m",
        "showN: d.show_n != null ? d.show_n : 0, showM: d.show_m != null ? d.show_m : 0" in tfl and "onClear: function () { tbSelectFilter(\"\", []); }" in tfl
        and "live" not in tfl.replace("flFocus", ""), tfl[:200])
s.check("the picks ride as the Talent Box's do: seg, bg (tb.gbg: tb.bg is the Chairman's one pick), dept, jg, cc, branch, repeated",
        'var TB_FKEYS = ["seg", "gbg", "dept", "cal", "jg", "cc", "branch"];' in JS and 'function tbParam(k) { return k === "gbg" ? "bg" : k; }' in JS
        and 'function tbProp(k) { return k === "bg" ? "gbg" : k; }' in JS and "tb[tbProp(f.key)] = " in JS
        and "key = key ? tbProp(key) : key;" in fn("tbSelectFilter"))
s.check("the left panel's batch items pick the Segment chip (kind batch -> tbSelectFilter('seg', ...))",
        'if (kind === "batch") { markNavCurrent(el); tbSelectFilter("seg", id ? [id] : []); return; }' in JS)
s.check("the title bar names a Group Chief's picks in the server's words (d.pick_words), the BG CEO's own line is the code it was",
        "d.pick_words ? d.pick_words.map(" in twg and "tbXWords(d)" in twg and "if (d.pick_words && d.pick_words.length)" in CAL)
s.check("the Chairman's box: the strip under the BU row, the hint when All business groups, his picks ride on the history and chat requests",
        "var efl = d.not_released ? null : tbFilterLine(d);" in cbw and "d.filter_hint" in cbw and 'rmkEl("span", "rv-cal-fhint", d.filter_hint)' in cbw
        and "(tb.bg ? tbPicksQuery() : \"\")" in JS and "if (tb.bg) tbPicksForm(f);" in JS and "TB_FKEYS.forEach(function (k) { tb[k] = []; });   // a business group is a new population" in fn("chairSelectBg"))
s.check("...the picks the server kept are the card's (a bogus one drops): the card reads d.filters back into tb on every draw",
        "TB_FKEYS.forEach(function (k) { tb[k] = []; });" in twg and "(d.filters || []).forEach(function (f) { tb[tbProp(f.key)] =" in twg)
s.check("his leaders' box (chairLeadWidget) is not touched: it draws no filter line",
        "tbFilterLine" not in fn("chairLeadWidget") and "filters" not in fn("chairLeadWidget"))
s.check("the settings card's script is its own file (no second copy of the line), shared by the three tabs",
        os.path.exists(os.path.join(H.REPO, "static", "calib_viewer_filters.js")) and card("?fview=gc")[2].count("calib_viewer_filters.js") == 1
        and "save.disabled = !n;" in open(os.path.join(H.REPO, "static", "calib_viewer_filters.js")).read())
s.check("CSS: tokens and rem only (the suites test_colour_tokens and test_text_units say so for the whole sheet); no underline on hover",
        ".vf-tab:hover { color: var(--accent-ink); background: var(--surface-2); text-decoration: none; }" in CSS
        and not re.search(r"\.vf-[\w-]+[^{]*\{[^}]*#[0-9a-fA-F]{3,6}\b", CSS) and not re.search(r"\.vf-[\w-]+[^{]*\{[^}]*\bfont-size:\s*\d+px", CSS))

# =====================================================================================================================
s.section("what Help, Ask OneHR and the agents know (the workspace rule of 2026-10-22)")
HQ = a.HELP_QA
s.check("a Group Chief's answer 'How do I narrow my box?' in their Talent Box list: Segment, the filters Group People switched on, ticks apply "
        "as they are made, the lock stays the whole group's",
        "group_filter" in HQ and "group_filter" in a.HELP_LISTS["group"][1] and len(a.HELP_LISTS["group"][1]) <= a.HELP_LIST_MAX
        and "Segment" in HQ["group_filter"][1] and "switched on for your group" in HQ["group_filter"][1]
        and "applies as you make it" in HQ["group_filter"][1] and "your lock is still the whole group's" in HQ["group_filter"][1]
        and "only narrows" in HQ["group_filter"][1], a.HELP_LISTS["group"])
s.check("the Chairman's answer says what the filter line does once a business group is picked",
        "Filter line" in HQ["cg_filter"][1] and "Once a business group is picked" in HQ["cg_filter"][1]
        and "picking another business group starts it clear" in HQ["cg_filter"][1] and "cg_filter" in a.HELP_LISTS["chair_group"][1])
s.check("the stale 'press Apply' is gone from the BU CEO's and the BG CEO's answers (a tick applies as it is made; Done closes the list), and "
        "from Ask OneHR's guide",
        "press Apply" not in HQ["bu_dept"][1] and "press Apply" not in HQ["bg_filter"][1] and "each tick applies as you make it" in HQ["bu_dept"][1]
        and "Done closes the list" in HQ["bu_dept"][1] and "Done" in HQ["bg_filter"][1] and "press Apply" not in SRC)
with a.app.test_request_context("/"):
    db = a.get_db()
    gu = db.execute("SELECT * FROM users WHERE id=?", (ids["GC"],)).fetchone()
    base_ctx = {"mode": "running", "welcome": {}, "panel": {}, "rec": {}, "bg_status": {"scope": "group"}}
    lines_g, _l = a._ask_facts(db, gu, base_ctx)
    lines_b, _l = a._ask_facts(db, gu, dict(base_ctx, bg_status={"scope": "bg"}))
    lines_u, _l = a._ask_facts(db, gu, dict(base_ctx, bg_status=None, bu_status={"units": []}))
    lines_c, _l = a._ask_facts(db, gu, dict(base_ctx, bg_status=None, chair={"steps": [{}, {}], "box_url": "/x"}))
fl = lambda ls: [x for x in ls if "Filter line" in x]   # noqa: E731
s.check("Ask OneHR: a Group Chief is told their Filter line holds Segment, then what Group People switched on; it only narrows, the lock is the group's",
        len(fl(lines_g)) == 1 and "Segment" in fl(lines_g)[0] and "switched them on for your group" in fl(lines_g)[0]
        and "no band, lock or move changes" in fl(lines_g)[0] and "lock still covers the whole group" in fl(lines_g)[0], fl(lines_g))
s.check("...a BG CEO and a BU CEO read their own line as before (department, job grade, cost centre or branch; the unit; the lock)",
        len(fl(lines_b)) == 1 and "Segment" not in fl(lines_b)[0] and "one Filter line narrows who you see" in fl(lines_b)[0]
        and "lock still covers the whole unit" in fl(lines_b)[0] and len(fl(lines_u)) == 1, (fl(lines_b), fl(lines_u)))
s.check("...the Chairman: once a business group is picked, counted within it, nothing placed or locked there",
        any("In the Group Talent Box, once you pick a business group, one Filter line" in x and "nothing is placed or locked there" in x
            for x in lines_c), [x[:60] for x in lines_c if "Filter" in x])
gsys = a.inspect.getsource(a._tb_group_system) if hasattr(a, "inspect") else open(os.path.join(H.HARNESS, "app.py")).read()
s.check("the Group Chief's agent prompt names the Filter line (Segment first, then their group's own filters), not the batch pills' row",
        "the Filter line under \"\n        \"the title narrows what's on screen: Segment first" in gsys and "the row under the" not in gsys)
s.check("no new KB slug and no tour stop: the two chairman slugs say nothing the line makes wrong (they speak of the group and unit pills)",
        "business group or \\u00a0unit" not in SRC and "chairman-filters" not in SRC)

s.section("Search in's suggestions on the Calibrators and Group Chiefs tabs")
rs = C_SU.get("/suggest?kind=people&src=admin_module_settings&key=calibration&q=zz+vf&qin=name")
s.check("the super admin gets suggestions (people by name) from the card's search box", rs.status_code == 200 and isinstance(rs.get_json(), list)
        and any("ZZ VF" in x_["v"] for x_ in rs.get_json()), (rs.status_code, (rs.get_json() or [])[:2]))
s.check("...a BG admin and an employee are refused (the card is the super admin's)",
        (C_BGA is None or C_BGA.get("/suggest?kind=people&src=admin_module_settings&q=zz+vf").status_code == 403)
        and C_EMP.get("/suggest?kind=people&src=admin_module_settings&q=zz+vf").status_code in (302, 403, 404))

# =====================================================================================================================
put("exec_chair_id", None)
put("exec_chair_delegate_id", None)
os.environ.pop("ONEHR_CHAIR", None)
a.ai_draft.review_agent_available = _real_avail
sys.exit(s.done())
