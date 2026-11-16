"""Reporting lines follow through to every module (Chris, 2026-11-13: "when we make change to any of the setting of the user role in
the people list (e.g. change LM, HOD, CEO etc.), it should auto link to all our relevant modules, including our future LMS module.").

The trigger: Grade H Appraisal stored its own copy of the HOD and the appraiser (gradeh_people.hod_user_id / hod2_user_id / appraiser_id),
which wins over users.hod_id / users.manager_id, so a main HOD change on 10 Nov never reached it. Now ONE hook, `_line_changed`, is
called by every writer of a line after its UPDATE, in the same transaction; it runs the followers in LINE_FOLLOWERS, and
`_line_change_plan` is their dry run for every preview.

What this suite holds:
  * Grade H, HOD change (the person page's route, which the job kit drives): a hand-set Grade H HOD is CLEARED, so the effective Grade H
    HOD is the new main HOD ("latest change wins"), with an audit row that says it follows the main change, and the preview names it
    ("was set by hand on the Grade H page"); the second Grade H HOD stays; one that IS the new HOD takes the person back to one HOD, the
    ticks folded
  * Locked: the old Grade H HOD has signed off a stage, the unit is released, or the NEW HOD has signed off: the main HOD still changes,
    Grade H is pinned to who signed, and the preview says "Grade H Appraisal stays with ..." in the setter's own words
  * Grade H, line manager change: the appraiser override is cleared, or pinned (the appraisal submitted, the unit released) by
    gradeh_set_appraiser's own refusals; nothing is written for someone with no override whose appraiser does not change
  * a person not on the Grade H list, or Grade H not running: nothing follows, nothing is said
  * one decision function per follower: the preview and the write agree for every scenario above
  * the Leaders page's plan and a People import over several Grade H people each call the hook ONCE and read Grade H in a number of queries
    that does not grow with the people (batched); the import's Changes step carries a muted note, its done lines the notes; the import's HOD
    check (_roster_leader_error) refuses a row the person page would, in the person page's words
  * the rating record is rebuilt once for the moved person (hod_change / lm_change), and not at all for a change that did not move anyone
  * every seat writer (BU CEO, BG CEO, Group Chief, BU calibration group and panel) passes the seat to the hook
  * the lint: every column holding a user id whose name says a relationship is registered in LINE_COPY_COLUMNS (live, follower, record
    or as_filed), so a new module's column fails here until it says what it does when the line moves; every UPDATE of users.manager_id /
    hod_id / bgceo_bg and every INSERT / DELETE / UPDATE of a seat table is in a function that calls _line_changed
  * a module outside app.py registers itself: its own module-level LINE_COPY_COLUMNS / LINE_FOLLOWERS are merged into app's at import
    (a fake onehr_zz module here; CSF's on the combined build), a clash with an app row or follower, or another module's, raises
  * every seat writer appends a follower's note to its done message, as the HOD writer does
  * every guard is falsified: stubbed away (or the registry / source broken), the check that holds it fails

Synthetic (ZZLF-*) on a fresh scratch database; Suite.done() puts it back.
"""
import ast
import glob
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Reporting lines follow through to every module")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, EMP = H.actors(a)
ME = dict(SU)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = open(os.path.join(ROOT, "app.py"), encoding="utf-8").read()

# ======================================================================================================================
# THE LINT (no database): the schema and the writers, parsed from the source. Functions, so a falsification can run them on a broken input.
REL_WORDS = re.compile(r"manager|hod|approver|appraiser|reviewer|reviewed|moderator|calibrator|assessor|ceo|chief|owner|holder|coordinator|"
                       r"nominat|confirm|lead|delegate|decided|signed|acted|endors|sponsor|supervis|mentor|proxy|assignee|responsible", re.I)
ID_SHAPE = re.compile(r"(_by|_user_id|_user|(manager|hod|approver|appraiser|calibrator|reviewer|assessor|owner|moderator|coordinator|holder|"
                      r"delegate|chief|ceo|lead|sponsor|supervisor)_id)$", re.I)


def _strings(path):
    tree = ast.parse(open(path, encoding="utf-8").read())
    return [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)
            and ("CREATE TABLE" in n.value or "ALTER TABLE" in n.value)]


def _split_top(body):
    parts, cur, d = [], "", 0
    for c in body:
        d += (c == "(") - (c == ")")
        if c == "," and d == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += c
    parts.append(cur)
    return parts


def schema_columns(texts):
    """{table: {column: its definition}} from CREATE TABLE IF NOT EXISTS bodies and ALTER TABLE ... ADD COLUMN (SCHEMA,
    _ensure_runtime_schema and every module's own ensure_schema: whatever string in the source makes a table)."""
    out = {}
    for text in texts:
        for m in re.finditer(r"CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(", text):
            i, depth, j = m.end(), 1, m.end()
            while depth and j < len(text):
                depth += (text[j] == "(") - (text[j] == ")")
                j += 1
            for p in _split_top(text[i:j - 1]):
                mm = re.match(r"(\w+)\s*(.*)", p.strip(), re.S)
                if mm and mm.group(1).upper() not in ("PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "CONSTRAINT"):
                    out.setdefault(m.group(1), {})[mm.group(1)] = mm.group(2)
        for m in re.finditer(r"ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)\s*([^;]*)", text):
            out.setdefault(m.group(1), {}).setdefault(m.group(2), m.group(3))
    return out


def relationship_columns(cols):
    """Every 'table.column' that holds a user id (REFERENCES users, or an INTEGER named like one) and whose name says a relationship."""
    hit = []
    for tn, cs in sorted(cols.items()):
        for cn, d in cs.items():
            holds_user = bool(re.search(r"REFERENCES\s+users", d, re.I)) or bool(re.match(r"INTEGER", d.strip(), re.I) and ID_SHAPE.search(cn))
            if holds_user and REL_WORDS.search(cn):
                hit.append("%s.%s" % (tn, cn))
    return hit


def lint_columns(cols, registry, followers):
    """(unregistered, bad modes, registered but gone): the lint's three failures."""
    names = relationship_columns(cols)
    unreg = [n for n in names if n not in registry]
    bad = []
    for k, (mode, why) in registry.items():
        m = mode.split(":")[0]
        if m not in ("live", "follower", "record", "as_filed") or not why or (
                m == "follower" and mode.split(":", 1)[1] not in followers and not hasattr(a, mode.split(":", 1)[1])):
            bad.append(k)
    gone = [k for k in registry if k.split(".")[0] not in cols or k.split(".")[1] not in cols.get(k.split(".")[0], {})]
    return unreg, bad, gone


LINE_USERS = re.compile(r"\b(manager_id|hod_id|bgceo_bg)\s*=")
SEAT_WRITES = [re.compile(p, re.I | re.S) for p in (
    r"(INSERT\s+(OR\s+\w+\s+)?INTO|DELETE\s+FROM|UPDATE)\s+buceo_seats\b",
    r"(INSERT\s+(OR\s+\w+\s+)?INTO|DELETE\s+FROM)\s+pm_calibration_groups\b", r"UPDATE\s+pm_calibration_groups\s+SET\s+[^W]*calibrator_id",
    r"(INSERT\s+(OR\s+\w+\s+)?INTO|DELETE\s+FROM)\s+calib_bu_groups\b", r"UPDATE\s+calib_bu_groups\s+SET\s+[^W]*(calibrator_id|active)")]


def line_writers(src_text):
    """{function name: (writes a line or a seat?, calls _line_changed?)} for every function in the source that writes one."""
    tree = ast.parse(src_text)
    out = {}
    for fn in [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
        strs = [n.value for n in ast.walk(fn) if isinstance(n, ast.Constant) and isinstance(n.value, str)]
        writes = []
        for t in strs:
            for m in re.finditer(r"UPDATE\s+users\s+SET\s+(.*?)(?:\bWHERE\b|$)", t, re.I | re.S):
                if LINE_USERS.search(m.group(1)):
                    writes.append("users")
            if any(r.search(t) for r in SEAT_WRITES):
                writes.append("seat")
        if writes:
            hooked = any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "_line_changed" for n in ast.walk(fn))
            out[fn.name] = (sorted(set(writes)), hooked)
    return out


def unhooked(src_text, exempt):
    return sorted(n for n, (_w, hooked) in line_writers(src_text).items() if not hooked and n not in exempt)


# ======================================================================================================================
s.section("The lint: every relationship column says what it does when the line moves")
texts = _strings(os.path.join(ROOT, "app.py"))
mods = sorted(glob.glob(os.path.join(ROOT, "onehr_*.py")))   # the combined build's own modules (CSF ...) make tables of their own
for f_ in mods:
    texts += _strings(f_)
COLS = schema_columns(texts)
MATCHED = relationship_columns(COLS)
s.note("%d tables, %d columns parsed (%s); %d relationship columns matched" % (
    len(COLS), sum(len(v) for v in COLS.values()), "app.py" + "".join(" + " + os.path.basename(m) for m in mods), len(MATCHED)))
s.note("matched: " + ", ".join(MATCHED))
FOLLOWER_NAMES = {n for n, _p, _f in a.LINE_FOLLOWERS}
unreg, bad_modes, gone = lint_columns(COLS, a.LINE_COPY_COLUMNS, FOLLOWER_NAMES)
s.check("the lint reads the schema: enough tables and the line columns it must find", len(COLS) > 150 and {
    "users.manager_id", "users.hod_id", "gradeh_people.hod_user_id", "gradeh_people.hod2_user_id", "gradeh_people.appraiser_id",
    "pm_kpi_target_approvers.approver_id", "calib_bu_groups.calibrator_id", "pm_calibration_groups.calibrator_id",
    "lms_ojt.manager_id", "assignments.assessor_id"} <= set(MATCHED), sorted(MATCHED)[:8])
s.check("every relationship column is in LINE_COPY_COLUMNS (a new module's column fails here until it is registered)", not unreg, unreg)
s.check("every registry row names a real mode (live / follower:<name> / record / as_filed), a reason, and a column that still exists",
        not bad_modes and not gone, (bad_modes, gone))
s.check("the followers the registry names exist in LINE_FOLLOWERS (the Grade H pair, the rating record)",
        {"grade_h_hod", "grade_h_lm", "rating_record"} <= FOLLOWER_NAMES and all(callable(p) and callable(f) for _n, p, f in a.LINE_FOLLOWERS))
s.check("the Grade H copies are the followers' columns, the 360 panel is as filed (Chris, 30 Oct), a moderator's draft is a record",
        a.LINE_COPY_COLUMNS["gradeh_people.hod_user_id"][0] == "follower:grade_h_hod"
        and a.LINE_COPY_COLUMNS["gradeh_people.hod2_user_id"][0] == "follower:grade_h_hod"
        and a.LINE_COPY_COLUMNS["gradeh_people.appraiser_id"][0] == "follower:grade_h_lm"
        and a.LINE_COPY_COLUMNS["assignments.assessor_id"][0] == "as_filed"
        and a.LINE_COPY_COLUMNS["pm_kpi_moderation_drafts.approver_id"][0] == "record")
# falsified: a column nobody registered, a registry row that points nowhere, a mode that is not one
ghost = dict(COLS, zz_new_module={"id": "INTEGER PRIMARY KEY", "sponsor_hod_id": "INTEGER REFERENCES users(id)"})
u2, _b2, _g2 = lint_columns(ghost, a.LINE_COPY_COLUMNS, FOLLOWER_NAMES)
s.check("   FALSIFY: a new module's column that names a relationship and holds a user id fails the lint", u2 == ["zz_new_module.sponsor_hod_id"], u2)
plain = dict(COLS, zz_new_module={"id": "INTEGER PRIMARY KEY", "created_by": "INTEGER REFERENCES users(id)", "hod_split": "INTEGER"})
s.check("   FALSIFY: ...and a column that does not (who created it, a share) does not", lint_columns(plain, a.LINE_COPY_COLUMNS, FOLLOWER_NAMES)[0] == [],
        lint_columns(plain, a.LINE_COPY_COLUMNS, FOLLOWER_NAMES)[0])
stale = dict(a.LINE_COPY_COLUMNS, **{"zz_gone.hod_id": ("live", "x"), "users.manager_id": ("sometimes", "x")})
_u3, b3, g3 = lint_columns(COLS, stale, FOLLOWER_NAMES)
s.check("   FALSIFY: a registry row for a column that is gone, and a made-up mode, both fail", "zz_gone.hod_id" in g3 and "users.manager_id" in b3, (b3, g3))
alt = dict(COLS)
alt["users"] = {k: v for k, v in COLS["users"].items() if k != "hod_id"}
s.check("   FALSIFY: the schema's own column is what the registry is held to (take users.hod_id out of the parse and its registry row is 'gone')",
        "users.hod_id" in lint_columns(alt, a.LINE_COPY_COLUMNS, FOLLOWER_NAMES)[2])

s.section("The lint: every writer of a line or a seat calls the hook")
WR = line_writers(SRC)
EXEMPT = dict(a.LINE_SEAT_EXEMPT)
s.note("writers found: " + ", ".join("%s%s" % (n, "" if h else " (NO HOOK)") for n, (_w, h) in sorted(WR.items())))
s.check("the lint finds the writers it must: the line manager's, the HOD's, the import, every seat writer",
        {"_apply_line_manager_change", "_hod_plan_apply", "_roster_apply", "_assign_buceo", "_clear_buceo_unit", "_assign_bgceo",
         "_clear_bgceo_unit", "_set_group_chief", "_bu_group_save", "_bu_group_remove", "_bu_panel_save", "_bu_panel_remove",
         "admin_pm_calibration_groups"} <= set(WR), sorted(WR))
miss = unhooked(SRC, EXEMPT)
s.check("every function that writes users.manager_id / hod_id / bgceo_bg or a seat table calls _line_changed (or is exempt, with why)", not miss, miss)
s.check("the exemptions are few, named and explained", set(EXEMPT) <= set(WR) and all(len(v) > 20 for v in EXEMPT.values()) and len(EXEMPT) <= 3, EXEMPT)
no_hook = SRC.replace("_fn = _line_changed(db, [_line_seat(r[\"id\"], \"buceo\", _seat_key(bg, company), None)], me[\"id\"])", "_fn = []")
s.check("   FALSIFY: take the hook out of _clear_buceo_unit and the lint names it", "_clear_buceo_unit" in unhooked(no_hook, EXEMPT)
        and no_hook != SRC, unhooked(no_hook, EXEMPT))
fake = SRC + "\n\ndef _zz_new_writer(db, uid, hid):\n    db.execute('UPDATE users SET hod_id=? WHERE id=?', (hid, uid))\n"
s.check("   FALSIFY: a new writer of users.hod_id with no hook is named", unhooked(fake, EXEMPT) == ["_zz_new_writer"], unhooked(fake, EXEMPT))
fake2 = SRC + "\n\ndef _zz_seat(db, uid):\n    db.execute('INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)', ('a', 'b', uid))\n"
s.check("   FALSIFY: ...and a new writer of a seat table", unhooked(fake2, EXEMPT) == ["_zz_seat"], unhooked(fake2, EXEMPT))
fake3 = SRC + "\n\ndef _zz_ok(db, uid, hid):\n    db.execute('UPDATE users SET hod_id=? WHERE id=?', (hid, uid))\n    _line_changed(db, [], None)\n"
s.check("   FALSIFY: ...and one that calls the hook is not named", unhooked(fake3, EXEMPT) == [], unhooked(fake3, EXEMPT))

# ======================================================================================================================
# THE WORLD: Grade H running, people, seats
PFX, BG, CO, COB = "ZZLF-", "ZZLF Group", "ZZLF Unit A", "ZZLF Unit B"
U, GP = {}, {}
_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
import sqlite3  # noqa: E402

db = sqlite3.connect(a.DB_PATH, timeout=5.0)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")
UTCF = "%Y-%m-%d %H:%M:%S"
_N = [0]


def one(sql, args=()):
    r = db.execute(sql, args).fetchone()
    return r[0] if r else None


def run(fn):
    with a.app.test_request_context("/"):
        d = a.get_db()
        r = fn(d)
        d.commit()
        return r


def mk(k, grade="15", hod=None, mgr=None, co=CO, bg=BG, dept="ZZLF Dept"):
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, job_grade, "
        "job_title, hod_id, manager_id, confirmation_date, email) VALUES (?,?, 'x', 'user', ?,?,?,?,?,'Driver',?,?, '2020-01-01', ?)",
        ((PFX + k).lower(), "ZZ LF " + k, PFX + k, bg, co, dept, grade, hod, mgr, "zzlf.%s@example.test" % k.lower())).lastrowid


def eid(k):
    return PFX + k


def gh_person(k, hod=None, mgr=None, gh_hod=None, hod2=None, appraiser=None, co=CO, submitted=False, split=None):
    """A Grade H person (on the list, one appraisal row): their OneHR HOD / line manager, and the list's own copies."""
    U[k] = mk(k, "H", hod=hod, mgr=mgr, co=co, dept="ZZLF GH " + k)
    pid = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route, hod_user_id, hod2_user_id, hod_split, appraiser_id) "
                     "VALUES (?,?,?,'B',?,?,?,?)", (CID, PFX + k, U[k], gh_hod, hod2, split if hod2 else None, appraiser)).lastrowid
    GP[k] = pid
    db.execute("INSERT INTO gradeh_appraisals (cycle_id, person_id, lm_submitted_at) VALUES (?,?,?)",
               (CID, pid, (NOW - timedelta(days=2)).strftime(UTCF) if submitted else None))
    db.commit()
    return pid


def gp(k):
    return db.execute("SELECT * FROM gradeh_people WHERE id=?", (GP[k],)).fetchone()


def eff_hod(k):
    """The effective Grade H HOD: the one function every Grade H reader uses."""
    return run(lambda d: a.gradeh_hod_of(d, d.execute("SELECT * FROM gradeh_people WHERE id=?", (GP[k],)).fetchone()))


def eff_appraiser(k):
    return run(lambda d: (a.gradeh_appraiser_user(d, d.execute("SELECT * FROM gradeh_people WHERE id=?", (GP[k],)).fetchone()) or {"id": None})["id"])


def main_hod(k):
    return one("SELECT hod_id FROM users WHERE id=?", (U[k],))


def main_lm(k):
    return one("SELECT manager_id FROM users WHERE id=?", (U[k],))


def sign(hod_key, stages=("pot", "perf")):
    for stg in stages:
        db.execute("INSERT OR IGNORE INTO gradeh_signoffs(cycle_id, tier, stage, scope_key, signed_by) VALUES (?,?,?,?,?)",
                   (CID, "hod", stg, str(U[hod_key]), U[hod_key]))
    db.commit()


def unsign(hod_key):
    db.execute("DELETE FROM gradeh_signoffs WHERE cycle_id=? AND tier='hod' AND scope_key=?", (CID, str(U[hod_key])))
    db.commit()


def audit(k, action):
    return [r[0] for r in db.execute("SELECT detail FROM activity_log WHERE action=? AND target_user_id=? ORDER BY id", (action, U[k]))]


def text(resp):
    h = resp.get_data(as_text=True)
    h = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", h)
    m = re.search(r'<main id="main"[\s\S]*', h)
    h = m.group(0) if m else h
    h = re.sub(r"<[^>]+>", " ", h)
    return " ".join(h.replace("&#39;", "'").replace("&amp;", "&").replace("&quot;", '"').split())


def follows(html):
    """The preview's 'Follows' rows (what also moves in the other modules), as the page words them, joined."""
    rows = re.findall(r'<div><span>Follows</span><span>(.*?)</span></div>', html, re.S)
    return " | ".join(" ".join(re.sub(r"<[^>]+>", " ", r).replace("&#39;", "'").replace("&amp;", "&").split()) for r in rows)


def flashes(client):
    with client.session_transaction() as sess:
        return " ".join(str(m[1]) for m in sess.pop("_flashes", []) or [])


C_SU = H.client_as(a, SU["id"])
LINES = "/admin/users/%d/lines"


def hod_change(k, new_k, via_page=True):
    """The person page's HOD change, preview then apply, as the job kit drives it. (preview text, flash text)."""
    pv = C_SU.post(LINES % U[k], data={"csrf_token": "tok", "action": "hod_preview", "hod_eid": eid(new_k)})
    html = pv.get_data(as_text=True)
    fp = (re.search(r'name="fingerprint" value="([0-9a-f]+)"', html) or [None, ""])[1]
    flashes(C_SU)
    r = C_SU.post(LINES % U[k], data={"csrf_token": "tok", "action": "hod_apply", "hod_eid": eid(new_k), "uid": str(U[k]),
                                       "fingerprint": fp, "ack": "1"})
    return follows(html), flashes(C_SU)


def lm_change(k, new_k):
    pv = C_SU.post(LINES % U[k], data={"csrf_token": "tok", "action": "lm_preview", "lm_eid": eid(new_k)})
    flashes(C_SU)
    C_SU.post(LINES % U[k], data={"csrf_token": "tok", "action": "lm_apply", "lm_eid": eid(new_k)})
    return follows(pv.get_data(as_text=True)), flashes(C_SU)


if True:
    CID = run(lambda d: a.active_cycle_id(d))
    HALF0 = db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()["half"]
    OBD0 = one("SELECT open_by_date FROM cycles WHERE id=?", (CID,))
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
    db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 1)", (CID,))
    for bg_, c_ in ((BG, CO), (BG, COB)):
        db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (bg_, c_))
    NOW = a._now_myt()
    U["BCA"] = mk("BCA", "21", dept="ZZLF Division")
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, U["BCA"]))
    U["BCB"] = mk("BCB", "21", co=COB, dept="ZZLF Division")
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, COB, U["BCB"]))
    for k_ in ("OLDH", "NEWH", "HANDH", "H2", "SIGNED", "NEWSIGNED", "OLDLM", "NEWLM", "HANDA", "PEER"):
        U[k_] = mk(k_, "15", hod=U["BCA"], dept="ZZLF " + k_)
    for k_ in ("OLDHB", "NEWHB", "OLDLMB", "NEWLMB"):
        U[k_] = mk(k_, "15", hod=U["BCB"], co=COB, dept="ZZLF " + k_)
    for k_ in ("ai_calib", "review_unified"):
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,'1')", (k_,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','calibration','pm','tm')")
    db.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%'")
    db.commit()

try:
    s.check("the world: Grade H runs on the active cycle", run(lambda d: a.gradeh_calib_cycle_id(d)) == CID, run(lambda d: a.gradeh_calib_cycle_id(d)))

    # ==================================================================================================================
    s.section("Grade H, HOD change: a hand-set Grade H HOD follows the main HOD (latest change wins)")
    gh_person("A1", hod=U["OLDH"], gh_hod=U["HANDH"], hod2=U["H2"], split=60)
    s.check("before: the effective Grade H HOD is the one set by hand, not the main HOD", eff_hod("A1") == U["HANDH"] and main_hod("A1") == U["OLDH"])
    pv, fl = hod_change("A1", "NEWH")
    s.check("users.hod_id is the new HOD (the main change goes)", main_hod("A1") == U["NEWH"], main_hod("A1"))
    s.check("the Grade H override is cleared, so the effective Grade H HOD is the new main HOD", gp("A1")["hod_user_id"] is None
            and eff_hod("A1") == U["NEWH"], (gp("A1")["hod_user_id"], eff_hod("A1")))
    s.check("the second Grade H HOD and the split stay", gp("A1")["hod2_user_id"] == U["H2"] and gp("A1")["hod_split"] == 60, dict(gp("A1")))
    au = audit("A1", "gradeh_set_hod")
    s.check("an audit row says Grade H's HOD was cleared and that it follows the main HOD change", au and "follows the main HOD change" in au[-1]
            and "cleared" in au[-1], au)
    s.check("the preview, before anything was written, names it: 'Grade H Appraisal: HOD also moves from A to B', set by hand",
            "Grade H Appraisal: HOD also moves from ZZ LF HANDH to ZZ LF NEWH" in pv and "was set by hand on the Grade H page" in pv, pv[-600:])
    s.check("the done message says what followed", "Grade H Appraisal: HOD also moved from ZZ LF HANDH to ZZ LF NEWH" in fl, fl)
    s.check("nothing of users.hod_id was written by Grade H: another person's HOD is untouched", main_hod("A1") == U["NEWH"]
            and one("SELECT COUNT(*) FROM users WHERE hod_id=?", (U["HANDH"],)) == 0)

    s.section("Grade H, HOD change: no hand-set HOD, the people just follow (nothing to clear, nothing said as a change of the list)")
    gh_person("A2", hod=U["OLDH"])
    pv, fl = hod_change("A2", "NEWH")
    s.check("effective HOD is the new one and no override was written", eff_hod("A2") == U["NEWH"] and gp("A2")["hod_user_id"] is None)
    s.check("the preview still says Grade H's HOD moves (it reads the main HOD), without 'by hand'",
            "Grade H Appraisal: HOD also moves from ZZ LF OLDH to ZZ LF NEWH" in pv and "set by hand" not in pv.split("Grade H Appraisal: HOD also moves")[1][:140], pv[-400:])
    s.check("no gradeh_set_hod audit row (nothing of Grade H's own was changed)", audit("A2", "gradeh_set_hod") == [])

    # ==================================================================================================================
    s.section("Grade H, HOD change: locked, so the main change goes and Grade H keeps who signed")
    gh_person("B1", hod=U["SIGNED"])
    sign("SIGNED")
    pv, fl = hod_change("B1", "NEWH")
    s.check("B1: the main HOD changed", main_hod("B1") == U["NEWH"], main_hod("B1"))
    s.check("B1: the old Grade H HOD signed a stage: the override is PINNED to them, so Grade H still reads the one who signed",
            gp("B1")["hod_user_id"] == U["SIGNED"] and eff_hod("B1") == U["SIGNED"], (gp("B1")["hod_user_id"], eff_hod("B1")))
    s.check("B1: the preview says 'stays with' in Set HOD's own words",
            "Grade H Appraisal stays with ZZ LF SIGNED" in pv and "has already signed off a Grade H stage, so the HOD cannot change now" in pv, pv[-500:])
    au = audit("B1", "gradeh_set_hod")
    s.check("B1: an audit row says it stays and why", au and "stays with ZZ LF SIGNED" in au[-1] and "follows the main HOD change" in au[-1], au)
    unsign("SIGNED")

    gh_person("B2", hod=U["OLDH"], gh_hod=U["SIGNED"])
    sign("SIGNED")
    pv, fl = hod_change("B2", "NEWH")
    s.check("B2: a hand-set Grade H HOD who has signed is not moved either, and the main HOD changed",
            gp("B2")["hod_user_id"] == U["SIGNED"] and eff_hod("B2") == U["SIGNED"] and main_hod("B2") == U["NEWH"])
    s.check("B2: and the preview says so", "Grade H Appraisal stays with ZZ LF SIGNED" in pv, pv[-300:])
    unsign("SIGNED")

    gh_person("B3", hod=U["OLDHB"], co=COB)
    db.execute("INSERT INTO gradeh_releases(cycle_id, unit, released_by) VALUES (?,?,?)", (CID, COB, SU["id"]))
    db.commit()
    pv, fl = hod_change("B3", "NEWHB")
    s.check("B3: the unit is released: the main HOD changed, Grade H pinned to the old HOD",
            main_hod("B3") == U["NEWHB"] and gp("B3")["hod_user_id"] == U["OLDHB"] and eff_hod("B3") == U["OLDHB"],
            (main_hod("B3"), gp("B3")["hod_user_id"]))
    s.check("B3: the preview carries the release's own words", "Grade H Appraisal stays with ZZ LF OLDHB" in pv
            and "This unit's results have been released, so nothing changes now" in pv, pv[-500:])
    db.execute("DELETE FROM gradeh_releases WHERE cycle_id=? AND unit=?", (CID, COB))
    db.commit()

    gh_person("B4", hod=U["OLDH"])
    sign("NEWSIGNED")
    pv, fl = hod_change("B4", "NEWSIGNED")
    s.check("B4: the NEW HOD has signed: the main HOD changed, Grade H pinned to the old HOD, it says why",
            main_hod("B4") == U["NEWSIGNED"] and gp("B4")["hod_user_id"] == U["OLDH"] and eff_hod("B4") == U["OLDH"]
            and "cannot take on another person now" in pv, (main_hod("B4"), gp("B4")["hod_user_id"], pv[-300:]))
    unsign("NEWSIGNED")

    gh_person("B5", hod=U["OLDHB"], co=COB)
    db.execute("INSERT INTO gradeh_signoffs(cycle_id, tier, stage, scope_key, signed_by) VALUES (?,?,?,?,?)", (CID, "buceo", "all", COB, U["BCB"]))
    db.commit()
    pv, fl = hod_change("B5", "NEWHB")
    s.check("B5: the BU CEO has signed the unit off: pinned to the old HOD, in the sign-off's own words",
            gp("B5")["hod_user_id"] == U["OLDHB"] and main_hod("B5") == U["NEWHB"] and "The BU CEO has signed off this unit" in pv, pv[-300:])
    db.execute("DELETE FROM gradeh_signoffs WHERE cycle_id=? AND tier='buceo'", (CID,))
    db.commit()

    # ==================================================================================================================
    s.section("Grade H, HOD change: the second Grade H HOD")
    gh_person("C1", hod=U["OLDH"], hod2=U["NEWH"], split=70)
    db.execute("INSERT INTO gradeh_hod_reviews(cycle_id, person_id, axis, by_user_id, band) VALUES (?,?,?,?,?)", (CID, GP["C1"], "perf", U["NEWH"], "ME"))
    db.execute("INSERT INTO gradeh_hod_reviews(cycle_id, person_id, axis, by_user_id, band) VALUES (?,?,?,?,?)", (CID, GP["C1"], "perf", U["OLDH"], "HE"))
    db.commit()
    pv, fl = hod_change("C1", "NEWH")
    g = gp("C1")
    s.check("C1: the second HOD IS the new main HOD: the person goes back to one HOD (second cleared, split dropped)",
            g["hod2_user_id"] is None and g["hod_split"] is None and eff_hod("C1") == U["NEWH"], dict(g))
    tick = db.execute("SELECT by_user_id, band FROM gradeh_reviews WHERE cycle_id=? AND person_id=? AND axis='perf' AND tier='hod'", (CID, GP["C1"])).fetchone()
    s.check("C1: the new HOD's Agree tick is folded into the one-HOD place and the two-HOD rows are gone",
            tick and tick["by_user_id"] == U["NEWH"] and tick["band"] == "ME"
            and one("SELECT COUNT(*) FROM gradeh_hod_reviews WHERE person_id=?", (GP["C1"],)) == 0, (dict(tick) if tick else None))
    s.check("C1: the preview says so", "is also their second HOD, so they go back to one HOD" in pv, pv[-400:])
    s.check("C1: an audit row on gradeh_set_hods says it follows the main HOD change",
            any("follows the main HOD change" in x for x in audit("C1", "gradeh_set_hods")), audit("C1", "gradeh_set_hods"))

    s.section("Grade H, HOD change: not on the list, module off, no change")
    U["N1"] = mk("N1", "H", hod=U["OLDH"])   # a Grade H person who is NOT on the Grade H list
    db.commit()
    pv, fl = hod_change("N1", "NEWH")
    s.check("a person not on the Grade H list: the main HOD changes, no Grade H line is shown or written",
            main_hod("N1") == U["NEWH"] and "Grade H Appraisal" not in pv and "Grade H Appraisal" not in fl
            and one("SELECT COUNT(*) FROM gradeh_people WHERE user_id=?", (U["N1"],)) == 0, (main_hod("N1"), pv, fl))
    U["N2"] = mk("N2", "15", hod=U["OLDH"])
    db.commit()
    pv, fl = hod_change("N2", "NEWH")
    s.check("an ordinary person: nothing about Grade H anywhere", main_hod("N2") == U["NEWH"] and "Grade H" not in pv and "Grade H" not in fl,
            (main_hod("N2"), pv, fl))
    gh_person("N3", hod=U["OLDH"], gh_hod=U["HANDH"])
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
    db.commit()
    pv, fl = hod_change("N3", "NEWH")
    s.check("Grade H not running on the cycle: the main change goes, the list's copy is left exactly as it is, nothing is said",
            main_hod("N3") == U["NEWH"] and gp("N3")["hod_user_id"] == U["HANDH"] and "Grade H Appraisal" not in pv and "Grade H Appraisal" not in fl)
    db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 1)", (CID,))
    db.commit()

    # ==================================================================================================================
    s.section("Grade H, line manager change: the appraiser override")
    gh_person("L1", mgr=U["OLDLM"], appraiser=U["HANDA"])
    pv, fl = lm_change("L1", "NEWLM")
    s.check("L1: the main line manager changed; the hand-set appraiser is cleared, so the appraiser is the new line manager",
            main_lm("L1") == U["NEWLM"] and gp("L1")["appraiser_id"] is None and eff_appraiser("L1") == U["NEWLM"],
            (main_lm("L1"), gp("L1")["appraiser_id"], eff_appraiser("L1")))
    s.check("L1: the preview names it, and an audit row says it follows the main line manager change",
            "Grade H Appraisal: appraiser also moves from ZZ LF HANDA to ZZ LF NEWLM" in pv
            and any("follows the main line manager change" in x for x in audit("L1", "gradeh_set_appraiser")), pv[-400:])
    s.check("L1: the done message says what followed", "Grade H Appraisal: appraiser also moved from ZZ LF HANDA to ZZ LF NEWLM" in fl, fl)

    gh_person("L2", mgr=U["OLDLM"], submitted=True)
    pv, fl = lm_change("L2", "NEWLM")
    s.check("L2: the appraisal is submitted: the main line manager changed, the appraiser is pinned to the old one (who appraised)",
            main_lm("L2") == U["NEWLM"] and gp("L2")["appraiser_id"] == U["OLDLM"] and eff_appraiser("L2") == U["OLDLM"],
            (gp("L2")["appraiser_id"], eff_appraiser("L2")))
    s.check("L2: the preview says 'stays with ... as appraiser' in Set appraiser's own words",
            "Grade H Appraisal stays with ZZ LF OLDLM as appraiser" in pv and "appraisal has been submitted: reopen it before changing the appraiser" in pv, pv[-400:])

    gh_person("L3", mgr=U["OLDLMB"], co=COB)
    db.execute("INSERT INTO gradeh_releases(cycle_id, unit, released_by) VALUES (?,?,?)", (CID, COB, SU["id"]))
    db.commit()
    pv, fl = lm_change("L3", "NEWLMB")
    s.check("L3: the unit is released: pinned to the old line manager", gp("L3")["appraiser_id"] == U["OLDLMB"] and main_lm("L3") == U["NEWLMB"]
            and "This unit's results have been released" in pv, (gp("L3")["appraiser_id"], pv[-300:]))
    db.execute("DELETE FROM gradeh_releases WHERE cycle_id=? AND unit=?", (CID, COB))
    db.commit()

    gh_person("L4", mgr=U["OLDLM"])
    pv, fl = lm_change("L4", "NEWLM")
    s.check("L4: no override, not locked: nothing is written to Grade H (it reads the main line manager), the effective appraiser moves",
            gp("L4")["appraiser_id"] is None and eff_appraiser("L4") == U["NEWLM"] and audit("L4", "gradeh_set_appraiser") == [])

    gh_person("L5", mgr=U["OLDLM"], appraiser=U["HANDA"], submitted=True)
    pv, fl = lm_change("L5", "NEWLM")
    s.check("L5: a hand-set appraiser on a submitted appraisal stays, and the preview says Grade H keeps them",
            gp("L5")["appraiser_id"] == U["HANDA"] and "Grade H Appraisal stays with ZZ LF HANDA as appraiser" in pv, pv[-300:])

    # ==================================================================================================================
    s.section("One decision function: the preview's lines are what the write did (every scenario above, plan against fact)")
    gh_person("P1", hod=U["OLDH"], gh_hod=U["HANDH"])
    gh_person("P2", hod=U["SIGNED"])
    sign("SIGNED")
    gh_person("P3", hod=U["OLDHB"], co=COB)
    db.execute("INSERT INTO gradeh_releases(cycle_id, unit, released_by) VALUES (?,?,?)", (CID, COB, SU["id"]))
    db.commit()
    chs = [{"uid": U[k_], "kind": "hod", "old": main_hod(k_), "new": U["NEWH"] if k_ != "P3" else U["NEWHB"]} for k_ in ("P1", "P2", "P3")]
    before = {k_: (eff_hod(k_), gp(k_)["hod_user_id"]) for k_ in ("P1", "P2", "P3")}
    pl = run(lambda d: a._line_change_plan(d, chs))
    s.check("the dry run writes nothing", {k_: (eff_hod(k_), gp(k_)["hod_user_id"]) for k_ in ("P1", "P2", "P3")} == before)
    s.check("it counts what moves and what stays (1 follows, 2 stay: the signed-off HOD, the released unit)", pl["tally"].get("hod") == (1, 2), pl["tally"])
    s.check("a batch speaks generally: 'for 1 person', one line a reason", any("for 1 person" in x for x in pl["lines"] + pl["stays"]), pl)

    def apply_plan(chs_):
        # the writer's own order: UPDATE users, then the hook
        for c_ in chs_:
            db.execute("UPDATE users SET hod_id=? WHERE id=?", (c_["new"], c_["uid"]))
        db.commit()
        return run(lambda d: a._line_changed(d, chs_, SU["id"]))
    notes = apply_plan(chs)
    after = {k_: eff_hod(k_) for k_ in ("P1", "P2", "P3")}
    s.check("the hook did what the plan said: the one that follows now reads the new HOD, the two that stay read who signed / the old one",
            after == {"P1": U["NEWH"], "P2": U["SIGNED"], "P3": U["OLDHB"]}, after)
    s.check("the hook returns notes in the same words as the plan, in the past tense",
            any("also moved from ZZ LF HANDH to ZZ LF NEWH for 1 person" in n for n in notes) and any("stays with" in n for n in notes), notes)
    unsign("SIGNED")
    db.execute("DELETE FROM gradeh_releases WHERE cycle_id=? AND unit=?", (CID, COB))
    db.commit()
    gh_person("P4", hod=U["OLDH"], gh_hod=U["HANDH"])
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        d_.execute("UPDATE users SET hod_id=? WHERE id=?", (U["NEWH"], U["P4"]))
        a._line_changed(d_, [{"uid": U["P4"], "kind": "hod", "old": U["OLDH"], "new": U["NEWH"]}], SU["id"])
        cleared_inside = d_.execute("SELECT hod_user_id FROM gradeh_people WHERE id=?", (GP["P4"],)).fetchone()[0] is None
        d_.rollback()
    s.check("the hook never commits: inside the caller's transaction the override is cleared, and after the caller's rollback it is back",
            cleared_inside and gp("P4")["hod_user_id"] == U["HANDH"] and main_hod("P4") == U["OLDH"], (cleared_inside, gp("P4")["hod_user_id"]))

    # ==================================================================================================================
    s.section("The writers reach the hook: person page (the job kit's routes), Leaders page, panel paths, seats")
    spy = []
    _orig_lc = a._line_changed
    _orig_rr = a._rating_record_refresh

    def _spy(db_, changes, actor=None, bulk=False):
        spy.append(([dict(c) for c in changes], bulk))
        return _orig_lc(db_, changes, actor, bulk)
    a._line_changed = _spy
    rr = []

    def _rr_spy(db_, cid_, ids, event, actor_id=None, commit=False):
        rr.append((sorted(ids), event))
        return _orig_rr(db_, cid_, ids, event, actor_id, commit)
    a._rating_record_refresh = _rr_spy
    try:
        gh_person("W1", hod=U["OLDH"], mgr=U["OLDLM"])
        spy.clear()
        rr.clear()
        hod_change("W1", "NEWH")
        s.check("the person page's hod_apply (the job kit's hod_set) calls the hook once, with the HOD change",
                len(spy) == 1 and spy[0][0] == [{"uid": U["W1"], "kind": "hod", "old": U["OLDH"], "new": U["NEWH"]}], spy)
        s.check("the rating record is rebuilt ONCE for them, as hod_change (the hook's follower, not also the writer)",
                [x for x in rr if U["W1"] in x[0]] == [([U["W1"]], "hod_change")], rr)
        spy.clear()
        rr.clear()
        lm_change("W1", "NEWLM")
        s.check("the person page's lm_apply (the job kit's lm_change) calls the hook once, with the line manager change",
                len(spy) == 1 and spy[0][0] == [{"uid": U["W1"], "kind": "lm", "old": U["OLDLM"], "new": U["NEWLM"]}], spy)
        s.check("...and the rating record is rebuilt once, as lm_change", [x for x in rr if U["W1"] in x[0]] == [([U["W1"]], "lm_change")], rr)
        spy.clear()
        rr.clear()
        C_SU.post(LINES % U["W1"], data={"csrf_token": "tok", "action": "hod_apply", "hod_eid": eid("NEWH"), "uid": str(U["W1"]),
                                          "fingerprint": "x", "ack": "1"})
        s.check("a change that does not happen (the HOD is already theirs) calls nothing and rebuilds nothing", not spy and not rr, (spy, rr))
        flashes(C_SU)
        # the Leaders page: one plan over several Grade H people, one hook call
        for k_ in ("W2", "W3", "W4"):
            gh_person(k_, hod=U["OLDH"], gh_hod=U["HANDH"] if k_ != "W4" else None)
        for k_ in ("W2", "W3", "W4"):
            db.execute("UPDATE users SET department=? WHERE id=?", ("ZZLF Leaders Dept", U[k_]))
        db.commit()
        spy.clear()
        rr.clear()

        def leaders_apply(d):
            me = dict(d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
            hod = d.execute("SELECT * FROM users WHERE id=?", (U["NEWH"],)).fetchone()
            plan = a._hod_assign_plan(d, me, BG, hod, [(CO, a._dept_key("ZZLF Leaders Dept"))])
            from werkzeug.datastructures import MultiDict
            form = MultiDict([("uid", str(r_["id"])) for r_ in plan["rows"]] + [("fingerprint", plan["fingerprint"]), ("ack", "1")])
            fol = a._line_follow_words(a._hod_plan_follows(d, plan, hod))
            return plan, fol, a._hod_plan_apply(d, me, BG, hod, plan, form)
        plan, fol, (ok, msg) = run(leaders_apply)
        s.check("Leaders page: the plan holds the three people", sorted(r_["id"] for r_ in plan["rows"]) == sorted(U[k_] for k_ in ("W2", "W3", "W4")), plan["rows"])
        s.check("Leaders page: the preview names Grade H once for the group ('for 2 people', set by hand), and the write is the same",
                ok and any("also moves from ZZ LF HANDH to ZZ LF NEWH for 2 people" in x for x in fol)
                and any("also moves from ZZ LF OLDH to ZZ LF NEWH for 1 person" in x for x in fol), (ok, fol, msg))
        s.check("Leaders page: ONE hook call for all three; every Grade H HOD now reads the new HOD; the done message carries the notes",
                len(spy) == 1 and len(spy[0][0]) == 3 and all(eff_hod(k_) == U["NEWH"] for k_ in ("W2", "W3", "W4"))
                and "Grade H Appraisal: HOD also moved" in msg, (len(spy), msg))
        s.check("Leaders page: the rating record of the three is rebuilt once, together",
                [x for x in rr if U["W2"] in x[0]] == [(sorted(U[k_] for k_ in ("W2", "W3", "W4")), "hod_change")], rr)

        # removing an HOD (Leaders > HODs > Remove): the hand-set Grade H HOD goes with it, the BU CEO covers them
        gh_person("W5", hod=U["OLDH"], gh_hod=U["HANDH"])
        db.execute("UPDATE users SET department=? WHERE id=?", ("ZZLF Remove Dept", U["W5"]))
        db.commit()
        spy.clear()

        def leaders_remove(d):
            me = dict(d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
            plan = a._hod_clear_plan(d, me, BG, [(CO, a._dept_key("ZZLF Remove Dept"))], U["OLDH"])
            from werkzeug.datastructures import MultiDict
            fol = a._line_follow_words(a._hod_plan_follows(d, plan, None))
            form = MultiDict([("uid", str(r_["id"])) for r_ in plan["rows"]] + [("fingerprint", plan["fingerprint"]), ("ack", "1")])
            return fol, a._hod_plan_apply(d, me, BG, None, plan, form)
        fol_rm, (ok_rm, msg_rm) = run(leaders_remove)
        s.check("Leaders remove: the preview says Grade H's HOD goes with it ('to no HOD'), the main HOD is none, Grade H reads nobody",
                ok_rm and any("also moves from ZZ LF HANDH to no HOD (the BU CEO covers them)" in x for x in fol_rm)
                and main_hod("W5") is None and eff_hod("W5") is None and gp("W5")["hod_user_id"] is None, (ok_rm, fol_rm, msg_rm))
        s.check("Leaders remove: one hook call, with new = None", len(spy) == 1 and spy[0][0] == [{"uid": U["W5"], "kind": "hod", "old": U["OLDH"], "new": None}], spy)

        # the panel import (a file of line managers) and Data integrity (ticked people): ONE call each, not one a person
        for k_ in ("Q1", "Q2", "Q3"):
            U[k_] = mk(k_, "15", mgr=U["OLDLM"], hod=U["OLDH"])
        db.commit()
        spy.clear()
        rr.clear()
        fol_ = []
        run(lambda d: a._panel_import_apply(d, ME, CID, [dict(sid=U[k_], aid=U["NEWLM"], rel="line_manager") for k_ in ("Q1", "Q2", "Q3")], False, (), fol_))
        s.check("the panel import sets three line managers and calls the hook ONCE, as a bulk, with the three changes",
                len(spy) == 1 and spy[0][1] is True and sorted(c_["uid"] for c_ in spy[0][0]) == sorted(U[k_] for k_ in ("Q1", "Q2", "Q3"))
                and all(c_["kind"] == "lm" and c_["old"] == U["OLDLM"] and c_["new"] == U["NEWLM"] for c_ in spy[0][0])
                and all(main_lm(k_) == U["NEWLM"] for k_ in ("Q1", "Q2", "Q3")), spy)
        spy.clear()
        rr.clear()
        for k_ in ("Q1", "Q2", "Q3"):
            db.execute("UPDATE users SET manager_id=? WHERE id=?", (U["OLDLM"], U[k_]))
            db.execute("INSERT OR IGNORE INTO rating_records(cycle_id, subject_id, employee_id) VALUES (?,?,?)", (CID, U[k_], eid(k_)))   # they have a record: it is rebuilt
        db.commit()
        C_SU.post("/admin/data-integrity/fix", data={"csrf_token": "tok", "check": "no_manager", "lm_eid": eid("NEWLM"),
                                                       "uid": [str(U[k_]) for k_ in ("Q1", "Q2", "Q3")]})
        s.check("Data integrity's ticked people: ONE hook call for the three (a bulk), the line manager set for each, their records rebuilt in ONE call (a bulk event, no insight queued)",
                len(spy) == 1 and spy[0][1] is True and len(spy[0][0]) == 3 and all(main_lm(k_) == U["NEWLM"] for k_ in ("Q1", "Q2", "Q3"))
                and [x for x in rr if U["Q1"] in x[0]] == [(sorted(U[k_] for k_ in ("Q1", "Q2", "Q3")), "roster_line_change")], (spy, rr, flashes(C_SU)))
        single_ = []
        r_ = run(lambda d: a._apply_line_manager_change(d, U["Q1"], U["OLDLM"], CID, actor_id=SU["id"], panel=False, batch=single_))
        s.check("a writer handed a `batch` only adds its change to it (the caller calls the hook once): nothing followed inside it",
                r_["follow"] == [] and single_ == [{"uid": U["Q1"], "kind": "lm", "old": U["NEWLM"], "new": U["OLDLM"]}], (r_, single_))

        # a seat change reaches the hook with the seat; the followers do nothing with it today
        rr.clear()
        U["S1"] = mk("S1", "21", dept="ZZLF Seat")
        U["S2"] = mk("S2", "21", dept="ZZLF Seat")
        db.commit()

        def seats(d):
            me = dict(d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
            out = {}
            out["buceo"] = a._assign_buceo(d, me, U["S1"], BG, CO)
            out["buceo2"] = a._assign_buceo(d, me, U["S2"], BG, CO)
            out["clear"] = a._clear_buceo_unit(d, me, BG, CO)
            out["bg"] = a._assign_bgceo(d, me, U["S1"], BG)
            out["bg2"] = a._assign_bgceo(d, me, U["S2"], BG)
            out["bgclear"] = a._clear_bgceo_unit(d, me, BG)
            gid = d.execute("INSERT INTO pm_calibration_groups(name, calibrator_id, created_by) VALUES (?,?,?)", ("ZZLF group", U["S1"], SU["id"])).lastrowid
            out["gc"] = a._set_group_chief(d, me, gid, U["S2"])
            return out
        spy.clear()
        res_ = run(seats)
        kinds = [(c_["kind"], c_["uid"], c_["old"], c_["new"]) for ch_, _b in spy for c_ in ch_]
        sk = lambda b, c: a._seat_key(b, c)  # noqa: E731
        s.check("seat writers all succeeded", all(v[0] for v in res_.values()), res_)
        want = [("buceo", U["S1"], None, sk(BG, CO)),                                             # S1 takes the seat the unit's BU CEO held
                ("buceo", U["BCA"], sk(BG, CO), None),
                ("buceo", U["S2"], None, sk(BG, CO)), ("buceo", U["S1"], sk(BG, CO), None),         # S2 takes it from S1
                ("buceo", U["S2"], sk(BG, CO), None),                                              # cleared
                ("bgceo", U["S1"], None, BG), ("bgceo", U["S1"], BG, None), ("bgceo", U["S2"], None, BG),
                ("bgceo", U["S2"], BG, None),
                ("gc", U["S1"], one("SELECT id FROM pm_calibration_groups WHERE name='ZZLF group'"), None),
                ("gc", U["S2"], None, one("SELECT id FROM pm_calibration_groups WHERE name='ZZLF group'"))]
        s.check("each seat writer passes the seat (BU CEO given / taken / cleared, BG CEO given / handed on / cleared, Group Chief)",
                all(w in kinds for w in want), [w for w in want if w not in kinds])
        s.check("the Grade H and rating-record followers do nothing with a seat: no record rebuilt, no Grade H audit row written for it",
                not [x for x in rr if x[1] in ("hod_change", "lm_change")] and
                one("SELECT COUNT(*) FROM activity_log WHERE action IN ('gradeh_set_hod','gradeh_set_appraiser') AND target_user_id IN (?,?)",
                    (U["S1"], U["S2"])) == 0, rr)

        # a follower's note for a seat change reaches the admin: every seat writer appends it to its message, as _hod_plan_apply does
        a._line_changed = _orig_lc
        U["S3"] = mk("S3", "21", dept="ZZLF Seat")
        U["S4"] = mk("S4", "21", dept="ZZLF Seat")
        db.commit()
        _seat_fol = ("zz_seat_note", lambda db_, ch_: {},
                     lambda db_, ch_, actor: ["ZZNOTE %s." % [c_["kind"] for c_ in ch_ if c_["kind"] in a.LINE_SEAT_KINDS][0]])

        def me_(d):
            return dict(d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())

        def seats2(d):
            out = {}
            out["buceo"] = a._assign_buceo(d, me_(d), U["S3"], BG, CO)
            out["buceo2"] = a._assign_buceo(d, me_(d), U["S4"], BG, CO)
            out["clear"] = a._clear_buceo_unit(d, me_(d), BG, CO)
            out["bg"] = a._assign_bgceo(d, me_(d), U["S3"], BG)
            out["bg2"] = a._assign_bgceo(d, me_(d), U["S4"], BG)
            out["bgclear"] = a._clear_bgceo_unit(d, me_(d), BG)
            gid = d.execute("INSERT INTO pm_calibration_groups(name, calibrator_id, created_by) VALUES (?,?,?)", ("ZZLF group 2", U["S3"], SU["id"])).lastrowid
            out["gc"] = a._set_group_chief(d, me_(d), gid, U["S4"])
            return out
        a.LINE_FOLLOWERS.append(_seat_fol)
        try:
            res2 = run(seats2)
        finally:
            a.LINE_FOLLOWERS.remove(_seat_fol)
        s.check("every seat writer's message (BU CEO given / handed on / cleared, BG CEO given / handed on / cleared, Group Chief) ends with a follower's note",
                all(v[0] for v in res2.values()) and all(v[1].endswith(" ZZNOTE %s." % k_) for k_, v in
                [("buceo", res2["buceo"]), ("buceo", res2["buceo2"]), ("buceo", res2["clear"]), ("bgceo", res2["bg"]), ("bgceo", res2["bg2"]),
                 ("bgceo", res2["bgclear"]), ("gc", res2["gc"])]), res2)
        res_plain = run(lambda d: {"a": a._assign_buceo(d, me_(d), U["S3"], BG, CO), "c": a._clear_buceo_unit(d, me_(d), BG, CO)})
        s.check("...and with no follower note the message is the writer's own words (nothing added, no trailing space)",
                all(v[0] and "ZZNOTE" not in v[1] and not v[1].endswith(" ") for v in res_plain.values()), res_plain)
        a.LINE_FOLLOWERS.append(_seat_fol)
        _tail0 = a._line_tail
        a._line_tail = lambda notes: ""
        try:
            res3 = run(lambda d: {"c": a._assign_buceo(d, me_(d), U["S4"], BG, CO)})
        finally:
            a._line_tail = _tail0
            a.LINE_FOLLOWERS.remove(_seat_fol)
        run(lambda d: a._clear_buceo_unit(d, me_(d), BG, CO))
        s.check("   FALSIFY: with the writers' tail helper stubbed away, the follower's note does not reach the message (the check above would fail)",
                res3["c"][0] and "ZZNOTE" not in res3["c"][1], res3)
    finally:
        a._line_changed = _orig_lc
        a._rating_record_refresh = _orig_rr

    # ==================================================================================================================
    s.section("People import: a file with line managers and HODs for several Grade H people")
    IMP = []
    for i in range(6):
        k_ = "I%d" % i
        gh_person(k_, hod=U["OLDH"], mgr=U["OLDLM"], gh_hod=U["HANDH"] if i % 2 == 0 else None, appraiser=U["HANDA"] if i % 3 == 0 else None)
        IMP.append(k_)
    def rec(k_, mgr=None, hod=None):
        r = {"employee id": eid(k_), "employee name": "ZZ LF " + k_, "business group": BG, "company": CO, "job grade": "H", "joined date": "2013-11-18", "work email": "zzlf.%s@example.test" % k_.lower()}
        if mgr:
            r["manager"] = eid(mgr)
        if hod:
            r["hod"] = eid(hod)
        return r

    def rcheck(recs):
        return run(lambda d: a._roster_check(d, ME, recs, False))

    chk2 = rcheck([rec(k_, "NEWLM", "NEWH") for k_ in IMP[:2]])
    chk6 = rcheck([rec(k_, "NEWLM", "NEWH") for k_ in IMP])
    s.check("the file is accepted by the check (no errors)", not chk2["errors"] and not chk6["errors"], (chk2["errors"][:2], chk6["errors"][:2]))
    note = run(lambda d: a._rimp_line_follow(d, chk6))
    s.check("the Changes step carries one muted phrase a kind, never a line a person: HOD follows for 6 people, appraiser follows for 6",
            note["hod"] == "Grade H Appraisal's HOD follows for 6 people" and note["lm"] == "Grade H Appraisal's appraiser follows for 6 people", note)
    sec = run(lambda d: a._rimp_changes(d, ME, chk6, {}))
    s.note("_rimp_changes returns: %s" % (list(sec) if isinstance(sec, dict) else type(sec)))
    chips = {c_[0]: c_[2] for s_ in sec["sections"] for c_ in (s_.get("chips") or [])} if isinstance(sec, dict) and "sections" in sec else {}
    s.check("...and the chip under HOD and under Line manager shows it, after the existing words",
            "their department review moves; Grade H Appraisal's HOD follows for 6 people" in chips.get("HOD", "")
            and "unmoderated KPI lines move; Grade H Appraisal's appraiser follows for 6 people" in chips.get("Line manager", ""), chips)

    def gh_sql_reads(chk_, n_people):
        seen = []

        def _go(d):
            d.set_trace_callback(lambda q: seen.append(q))
            try:
                a._rimp_line_follow(d, chk_)
            finally:
                d.set_trace_callback(None)
        run(_go)
        return len([q for q in seen if "gradeh_" in q and q.lstrip().upper().startswith("SELECT")]), len(seen)
    # the plan's reads of Grade H do not grow with the people (the follower reads the whole batch)
    r2 = gh_sql_reads(chk2, 2)
    r6 = gh_sql_reads(chk6, 6)
    s.check("the preview reads Grade H in the same number of queries for 2 people as for 6 (batched, no query a person)",
            r2[0] == r6[0] and r2[0] > 0 and r6[1] <= r2[1] + 4, (r2, r6))

    calls = []

    def _spy2(db_, changes, actor=None, bulk=False):
        calls.append((len(list(changes)), bulk))
        return _orig_lc(db_, changes, actor, bulk)
    a._line_changed = _spy2
    seen_sql = []

    def _apply6(d):
        d.set_trace_callback(lambda q: seen_sql.append(q))
        try:
            return a._roster_apply(d, ME, chk6)
        finally:
            d.set_trace_callback(None)
    try:
        res = run(_apply6)
    finally:
        a._line_changed = _orig_lc
    s.check("the import calls the hook ONCE for the whole file (12 changes: 6 line managers, 6 HODs), as a bulk", calls == [(12, True)], calls)
    gh_reads = [q for q in seen_sql if "gradeh_" in q and q.lstrip().upper().startswith("SELECT")]
    s.check("...and Grade H is read in a few queries, not one a person", len(gh_reads) <= 12, len(gh_reads))
    s.check("every Grade H person's HOD and appraiser now read the new ones (cleared overrides, none pinned: nothing is locked)",
            all(eff_hod(k_) == U["NEWH"] and eff_appraiser(k_) == U["NEWLM"] and gp(k_)["hod_user_id"] is None and gp(k_)["appraiser_id"] is None
                for k_ in IMP) and all(main_hod(k_) == U["NEWH"] and main_lm(k_) == U["NEWLM"] for k_ in IMP),
            [(eff_hod(k_), eff_appraiser(k_)) for k_ in IMP])
    s.check("the audit has a row for each person whose override was cleared, and none for who had none",
            len([1 for k_ in IMP if audit(k_, "gradeh_set_hod")]) == 3 and len([1 for k_ in IMP if audit(k_, "gradeh_set_appraiser")]) == 2,
            ([len(audit(k_, "gradeh_set_hod")) for k_ in IMP], [len(audit(k_, "gradeh_set_appraiser")) for k_ in IMP]))
    # the four-step import's done lines (_rimp_apply): the notes of a fresh set of people, said once for the file
    DN = []
    for i in range(4):
        k_ = "D%d" % i
        gh_person(k_, hod=U["OLDH"], mgr=U["OLDLM"], gh_hod=U["HANDH"] if i < 2 else None, appraiser=U["HANDA"] if i == 0 else None)
        DN.append(k_)
    chkd = rcheck([rec(k_, "NEWLM", "NEWH") for k_ in DN])
    done = run(lambda d: a._rimp_apply(d, ME, chkd, {}))
    lines_ = done["lines"]
    s.check("the done lines carry what followed, once for the file: HOD 'for 2 people' set by hand and 'for 2 people' who just follow, the appraiser 'for 1 person'",
            any("Grade H Appraisal: HOD also moved from ZZ LF HANDH to ZZ LF NEWH for 2 people (was set by hand" in x for x in lines_)
            and any("HOD also moved from ZZ LF OLDH to ZZ LF NEWH for 2 people" in x for x in lines_)
            and any("appraiser also moved from ZZ LF HANDA to ZZ LF NEWLM for 1 person" in x for x in lines_), lines_)
    s.check("...and every one of the four now reads the new HOD and the new line manager",
            all(eff_hod(k_) == U["NEWH"] and eff_appraiser(k_) == U["NEWLM"] for k_ in DN))

    # the same file but a locked unit: the main change still goes, the stays are one line
    gh_person("J1", hod=U["OLDHB"], mgr=U["OLDLMB"], co=COB)
    gh_person("J2", hod=U["OLDHB"], mgr=U["OLDLMB"], co=COB)
    db.execute("INSERT INTO gradeh_releases(cycle_id, unit, released_by) VALUES (?,?,?)", (CID, COB, SU["id"]))
    db.commit()

    def recb(k_, mgr, hod):
        r = rec(k_, mgr, hod)
        r["company"] = COB
        return r
    chkb = rcheck([recb("J1", "NEWLMB", "NEWHB"), recb("J2", "NEWLMB", "NEWHB")])
    nb = run(lambda d: a._rimp_line_follow(d, chkb))
    s.check("a locked unit: the Changes step says Grade H stays for 2, 'locked', and lists one reason line",
            "stays for 2 people (locked)" in nb["hod"] and "stays for 2 people (locked)" in nb["lm"] and nb["stays"]
            and any("for 2 people" in x for x in nb["stays"]), nb)
    run(lambda d: a._roster_apply(d, ME, chkb))
    s.check("...and the apply: both main changes went; Grade H pinned to the old HOD and old line manager",
            main_hod("J1") == U["NEWHB"] and eff_hod("J1") == U["OLDHB"] and eff_hod("J2") == U["OLDHB"]
            and main_lm("J1") == U["NEWLMB"] and eff_appraiser("J1") == U["OLDLMB"], (eff_hod("J1"), eff_appraiser("J1")))
    db.execute("DELETE FROM gradeh_releases WHERE cycle_id=? AND unit=?", (CID, COB))
    db.commit()

    s.section("People import: an HOD row the calibration checks block is refused, in the person page's words")
    gh_person("K1", hod=U["OLDH"], mgr=U["OLDLM"])
    # a LOCKED department review of the person's current HOD: the person page blocks the change, so does the import's check
    db.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, locked_at, locked_by) "
               "VALUES (?,?,?,?,?,datetime('now'),?)", (CID, "hod", str(U["OLDH"]), BG, "ZZLF OLDH", SU["id"]))
    db.commit()
    k1 = db.execute("SELECT * FROM users WHERE id=?", (U["K1"],)).fetchone()
    nh = db.execute("SELECT * FROM users WHERE id=?", (U["NEWH"],)).fetchone()
    pp = run(lambda d: a._hod_person_plan(d, ME, nh, d.execute("SELECT * FROM users WHERE id=?", (U["K1"],)).fetchone()))
    chkk = rcheck([rec("K1", None, "NEWH")])
    s.check("the person page blocks it (a submitted department review)", pp["blockers"] and "department review is submitted" in pp["blockers"][0], pp["blockers"])
    s.check("the import's check refuses that row with the person page's words: 'HOD: ' + the blockers",
            chkk["errors"] and chkk["errors"][0]["why"] == "HOD: " + "; ".join(pp["blockers"]), (chkk["errors"], pp["blockers"]))
    db.execute("DELETE FROM pm_calibration_sessions WHERE cycle_id=? AND tier='hod' AND scope_key=?", (CID, str(U["OLDH"])))
    db.commit()
    chkk2 = rcheck([rec("K1", None, "NEWH")])
    s.check("   FALSIFY: with the lock gone, the same row is accepted (so the refusal above is the lock's)", not chkk2["errors"], chkk2["errors"])

    # ==================================================================================================================
    s.section("Falsified: each guard of the followers fails the check that holds it when it is taken away")

    def fresh_hod_world(tag):
        gh_person(tag, hod=U["OLDH"], gh_hod=U["HANDH"])
        return tag

    def stubbed(name, fn, scenario):
        orig = getattr(a, name)
        setattr(a, name, fn)
        try:
            return scenario()
        finally:
            setattr(a, name, orig)

    def stub_follower(name, apply_fn, scenario):
        """The followers are held in the registry list (a patched module attribute would not reach them): swap the apply function."""
        i = [n for n, _p, _f in a.LINE_FOLLOWERS].index(name)
        orig = a.LINE_FOLLOWERS[i]
        a.LINE_FOLLOWERS[i] = (orig[0], orig[1], apply_fn)
        try:
            return scenario()
        finally:
            a.LINE_FOLLOWERS[i] = orig

    # 1. the lock guard (Set HOD's own refusal of a signed-off HOD)
    def sc_lock():
        k_ = "F1"
        gh_person(k_, hod=U["SIGNED"])
        sign("SIGNED")
        hod_change(k_, "NEWH")
        r_ = (gp(k_)["hod_user_id"], eff_hod(k_))
        unsign("SIGNED")
        return r_
    r1 = stubbed("_gh_hod_leave_refusal", lambda *x, **k: None, sc_lock)
    s.check("   FALSIFY: with Set HOD's lock guard stubbed away, a signed-off HOD's person is moved on (B1 would fail)",
            r1[1] == U["NEWH"] and r1[0] is None, r1)
    # 2. the new HOD's sign-off guard
    def sc_take():
        gh_person("F2", hod=U["OLDH"])
        sign("NEWSIGNED")
        hod_change("F2", "NEWSIGNED")
        r_ = eff_hod("F2")
        unsign("NEWSIGNED")
        return r_
    r2_ = stubbed("_gh_hod_take_refusal", lambda *x, **k: None, sc_take)
    s.check("   FALSIFY: with the new HOD's sign-off guard stubbed away, Grade H moves to an HOD who already signed (B4 would fail)", r2_ == U["NEWSIGNED"], r2_)
    # 3. the follower itself: no follower, no follow
    def sc_nofollow():
        k_ = fresh_hod_world("F3")
        hod_change(k_, "NEWH")
        return eff_hod(k_)
    r3 = stub_follower("grade_h_hod", lambda db_, ch_, actor: [], sc_nofollow)
    s.check("   FALSIFY: with the Grade H HOD follower out, the hand-set HOD is left behind (A1 would fail)", r3 == U["HANDH"], r3)
    # 4. the hook itself
    def sc_nohook():
        k_ = fresh_hod_world("F4")
        hod_change(k_, "NEWH")
        return eff_hod(k_), main_hod(k_)
    r4 = stubbed("_line_changed", lambda *x, **k: [], sc_nohook)
    s.check("   FALSIFY: with the hook a no-op, the main HOD changes and Grade H does not follow (the original bug)", r4 == (U["HANDH"], U["NEWH"]), r4)
    # 5. the appraiser's own guard
    def sc_appr():
        gh_person("F5", mgr=U["OLDLM"], submitted=True)
        lm_change("F5", "NEWLM")
        return gp("F5")["appraiser_id"], eff_appraiser("F5")
    real_block = a.gradeh_appraiser_block
    r5 = stubbed("gradeh_appraiser_block", lambda db_, cid_, pid_, au=None, ctx=None: (None, None, None), sc_appr)
    s.check("   FALSIFY: with Set appraiser's refusal stubbed away, a submitted appraisal's appraiser is moved on (L2 would fail)", r5[1] == U["NEWLM"], r5)
    # 6. the second-HOD fold
    def sc_drop2():
        gh_person("F6", hod=U["OLDH"], hod2=U["NEWH"], split=50)
        hod_change("F6", "NEWH")
        return gp("F6")["hod2_user_id"]
    r6_ = stubbed("_gh_set_hods_core", lambda *x, **k: (True, "stub"), sc_drop2)
    s.check("   FALSIFY: with the one-HOD fold stubbed away, the second HOD stays equal to the first (C1 would fail)", r6_ == U["NEWH"], r6_)
    # 7. the rating record follower
    def sc_rr():
        gh_person("F7", hod=U["OLDH"])
        rr.clear()
        hod_change("F7", "NEWH")
        return [x for x in rr if U["F7"] in x[0]]
    a._rating_record_refresh = _rr_spy
    try:
        r7 = stub_follower("rating_record", lambda db_, ch_, actor: [], sc_rr)
    finally:
        a._rating_record_refresh = _orig_rr
    s.check("   FALSIFY: with the rating record follower out, nobody's record is rebuilt (the once-check would fail)", r7 == [], r7)

    # the registry is read by the lint, the plan and the hook alike: a follower registered twice would run twice
    s.section("The registry")
    _names = [n for n, _p, _f in a.LINE_FOLLOWERS]
    s.check("LINE_FOLLOWERS is (name, plan, apply) a follower, names unique, app.py's first in the order Grade H, Grade H, rating record "
            "(a loaded module's own followers, CSF's on the combined build, come after)",
            _names[:3] == ["grade_h_hod", "grade_h_lm", "rating_record"] and len(set(_names)) == len(_names), _names)
    s.check("AI+ Learning is registered as reading the line live (no follower code), with why", "AI+ Learning" in a.LINE_LIVE_MODULES
            and "live" in a.LINE_LIVE_MODULES["AI+ Learning"] or "resolved live" in a.LINE_LIVE_MODULES["AI+ Learning"])
    # a module outside app.py registers itself: its own module-level LINE_COPY_COLUMNS / LINE_FOLLOWERS are folded in at import
    import types
    zz = types.ModuleType("onehr_zz")
    zz.LINE_COPY_COLUMNS = {"zz_items.owner_id": ("record", "a named pick: listed in the change preview, never moved")}
    zz.LINE_FOLLOWERS = [("zz_follow", lambda db_, ch_: {"stays": ["ZZ stays."]}, lambda db_, ch_, actor: ["ZZ done."])]
    _cols0, _fols0, _from0 = dict(a.LINE_COPY_COLUMNS), list(a.LINE_FOLLOWERS), dict(a._LINE_FROM_MODULE)
    BUCAL = [{"uid": U["W2"], "kind": "bucal", "old": 1, "new": None}]

    def _restore_registry():
        a.LINE_COPY_COLUMNS.clear()
        a.LINE_COPY_COLUMNS.update(_cols0)
        a.LINE_FOLLOWERS[:] = _fols0
        a._LINE_FROM_MODULE.clear()
        a._LINE_FROM_MODULE.update(_from0)

    def clash(mod_cols=None, mod_fols=None, mods=None):
        m_ = types.ModuleType("onehr_zz2")
        m_.LINE_COPY_COLUMNS = mod_cols or {}
        m_.LINE_FOLLOWERS = mod_fols or []
        try:
            a._line_merge_modules(mods or {"onehr_zz2": m_})
            return None
        except ValueError as e_:
            return str(e_)
    noop = (lambda d, c: {}, lambda d, c, ac: [])
    try:
        added = a._line_merge_modules({"onehr_zz": zz})
        s.check("a loaded onehr_ module's own registry rows and follower are merged into app's",
                a.LINE_COPY_COLUMNS.get("zz_items.owner_id") == zz.LINE_COPY_COLUMNS["zz_items.owner_id"]
                and a.LINE_FOLLOWERS[-1][0] == "zz_follow" and added == [("onehr_zz", ["zz_items.owner_id", "zz_follow"])], (added, a.LINE_FOLLOWERS[-1][0]))
        got_notes = run(lambda d: a._line_changed(d, BUCAL, SU["id"]))
        got_plan = run(lambda d: a._line_change_plan(d, BUCAL))["stays"]
        s.check("...the merged follower runs in the hook and the preview, after app's own", got_notes == ["ZZ done."] and got_plan == ["ZZ stays."], (got_notes, got_plan))
        n_before = (len(a.LINE_COPY_COLUMNS), len(a.LINE_FOLLOWERS))
        again = a._line_merge_modules({"onehr_zz": zz})
        s.check("merging the same module again (a reload, a test) adds nothing and does not call its own rows a clash",
                again == [] and n_before == (len(a.LINE_COPY_COLUMNS), len(a.LINE_FOLLOWERS)), again)
        real = [m_ for m_ in list(sys.modules.values()) if getattr(m_, "__name__", "").startswith("onehr_") and m_ is not zz]
        s.note("real modules carrying a registry: %s" % (", ".join(m_.__name__ for m_ in real if getattr(m_, "LINE_COPY_COLUMNS", None) or getattr(m_, "LINE_FOLLOWERS", None)) or "none (the combined build has CSF's)"))
        s.check("every real onehr_ module that carries a registry is merged at import: its rows are all in app's, its followers all run",
                all(a.LINE_COPY_COLUMNS.get(k_) == v_ for m_ in real for k_, v_ in (getattr(m_, "LINE_COPY_COLUMNS", None) or {}).items())
                and all(f_[0] in {x[0] for x in a.LINE_FOLLOWERS} for m_ in real for f_ in (getattr(m_, "LINE_FOLLOWERS", None) or [])))
        c1 = clash({"users.manager_id": ("record", "x")})
        c2 = clash(mod_fols=[("rating_record",) + noop])
        c3 = clash({"zz_items.owner_id": ("live", "x")})            # another module's row
        c4 = clash(mod_fols=[("zz_follow",) + noop])                # another module's follower
        c5 = clash({"zz_x.hod_id": "live"})                         # malformed
        c6 = clash(mod_fols=[("zz_a",) + noop, ("zz_a",) + noop])   # listed twice
        s.check("a clash with an app row or an app follower raises at import, never a silent overwrite (and names app.py)",
                bool(c1) and "app.py" in c1 and bool(c2) and "app.py" in c2 and a.LINE_COPY_COLUMNS["users.manager_id"][0] == "live", (c1, c2))
        s.check("...as does a clash with another module's row or follower, a malformed row, and a follower listed twice",
                bool(c3) and "onehr_zz" in c3 and bool(c4) and "onehr_zz" in c4 and bool(c5) and bool(c6), (c3, c4, c5, c6))
        s.check("...and a refused module adds nothing of its own (all or nothing)",
                "zz_x.hod_id" not in a.LINE_COPY_COLUMNS and "zz_a" not in {x[0] for x in a.LINE_FOLLOWERS})
        # falsified: without the record of who registered what, the same module's second merge reads as a clash (so the 'again' check holds the
        # tracking); without the app's row, the same module row merges (so the raise above is the clash guard and nothing else)
        saved_from = dict(a._LINE_FROM_MODULE)
        a._LINE_FROM_MODULE.clear()
        f1 = clash(mods={"onehr_zz": zz})
        a._LINE_FROM_MODULE.update(saved_from)
        s.check("   FALSIFY: with the record of who registered what gone, a module's own second merge reads as a clash (the tracking is what makes a reload safe)",
                bool(f1), f1)
        _um = a.LINE_COPY_COLUMNS.pop("users.manager_id")
        try:
            f2 = clash({"users.manager_id": ("record", "x")})
        finally:
            a.LINE_COPY_COLUMNS["users.manager_id"] = _um
        s.check("   FALSIFY: with the app's row not there, the same module row merges without a raise (it was the clash guard that raised)", f2 is None, f2)
    finally:
        _restore_registry()
    s.check("the fake module's rows are put back out of the registry", "zz_items.owner_id" not in a.LINE_COPY_COLUMNS
            and "zz_follow" not in {x[0] for x in a.LINE_FOLLOWERS} and a.LINE_COPY_COLUMNS["users.manager_id"][0] == "live")

    s.check("an unknown kind and an unchanged line are ignored by the hook (nothing runs, no query)",
            run(lambda d: a._line_changed(d, [{"uid": U["W2"], "kind": "zz", "old": 1, "new": 2},
                                              {"uid": U["W2"], "kind": "hod", "old": 5, "new": 5}], SU["id"])) == [])
    s.check("a repeated change for one person keeps the first old and the last new (one step, not two)",
            [(c_["old"], c_["new"]) for c_ in a._line_norm([{"uid": 9, "kind": "hod", "old": 1, "new": 2}, {"uid": 9, "kind": "hod", "old": 2, "new": 3}])] == [(1, 3)]
            and a._line_norm([{"uid": 9, "kind": "hod", "old": 1, "new": 2}, {"uid": 9, "kind": "hod", "old": 2, "new": 1}]) == [])

finally:
    os.environ["ONEHR_GRADEH"] = _ENV0 if _ENV0 is not None else ""
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE cycles SET half=?, open_by_date=? WHERE id=?", (HALF0, OBD0, CID))
        d.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%'")
        d.commit()

sys.exit(s.done())
