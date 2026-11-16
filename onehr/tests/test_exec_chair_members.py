"""The Executive Chairman view: the leaders the super admin ADDS to his Talent Box (Chris, 2026-10-30, "Go"; canvas
[design canvas link removed]). Dark behind ONEHR_CHAIR=1.

His senior leaders on production mostly are neither a BG CEO nor a Group Chief he manages, and have been taken out of the cycle, so
Admin > Leaders > Executive Chairman gets a card where the super admin adds anyone else he places, as a Group Chief or a Senior
leader. What this suite holds:
  * flag off: the three member actions are 404 and the card is not there; flag on: the super admin alone (a BG admin, staff,
    signed out and a post with no CSRF token are refused)
  * every refusal says why in plain words, and every guard is FALSIFIED (take it away and the test sees the difference): no seat, a
    kind that isn't listed, someone the picker does not offer (typed, an admin, a demo login, a leaver), the chair himself, someone
    who comes in by themselves (his BG CEO / Group Chief report, any BU CEO), a duplicate, and any add / kind change / remove once
    his box is locked
  * add / change / remove each write one audit row naming who and what, a removal drops his working moves for that person only
  * his box: a member is under the "Group Chiefs" or the new "Senior leaders" pill with the right role; one who is not taking part
    reads "Not in the cycle" / "Place by hand" instead of "Awaits your rating"; a member who is already in by themselves, left, is an
    admin or a demo login, or holds a BU CEO seat is not there twice or at all; ONE batched participation read
  * place + lock work for a member who is not in the cycle, and what he locks goes through the super admin's result release: the
    release page lists them, step 1 then step 2 write the release rows, released_final_band hands the person the band
Synthetic ZZ9CM people only; a fresh_db suite, so Suite.done() puts the scratch copy back."""
import inspect
import json
import os
import re
import sys

from werkzeug.datastructures import MultiDict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Executive Chairman: the leaders added to his Talent Box")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
os.environ.pop("ONEHR_CHAIR", None)
SU, _BGA0, _E = H.actors(a)
SRC = open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read()
TPL = open(os.path.join(H.REPO, "templates", "admin_leaders_chair.html"), encoding="utf-8").read()


def run(fn, path="/"):
    with a.app.test_request_context(path):
        return fn(a.get_db())


def sql(q, args=()):
    def f(d):
        d.execute(q, args)
        d.commit()
    run(f)


def put(key, val):
    if val is None:
        sql("DELETE FROM app_settings WHERE key=?", (key,))
    else:
        sql("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", (key, str(val)))


BG1, BG2 = "ZZ9CM BG ONE", "ZZ9CM BG TWO"
CA, CC = "ZZ9CM ONE A", "ZZ9CM TWO C"
ids = {}
REASON = "ZZ9CM-reason-held-against-the-members-3k7p"
with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycles SET half=2, kind='year_end', no_potential=NULL, min_job_grade=NULL WHERE id=?", (CID,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base if c != "id"]

    def mk(tag, bg, co, mgr=None, **kw):
        eid = "ZZ9CM-" + tag
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ CM " + tag, display_name=None, email=None,
                 hod_id=None, manager_id=ids.get(mgr), buceo_bg=None, buceo_company=None, bgceo_bg=None,
                 confirmation_date="2020-01-01", left_at=None, role="user", is_demo=0, user_role_id=None, job_grade="22",
                 business_group=bg, company=co, department="ZZ Dept " + tag[:1], job_title="HEAD " + tag, years_of_service=9)
        v.update(kw)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v.get(c) for c in cols])
        ids[tag] = db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
    mk("CH", BG1, CA)                                     # the Executive Chairman
    mk("BC1", BG1, CA, "CH", bgceo_bg=BG1)                # his report, a BG CEO: comes in by themselves
    mk("GC", BG1, CA, "CH")                               # his report, a Group Chief: comes in by themselves
    mk("BU1", BG1, CA, "BC1", buceo_bg=BG1, buceo_company=CA)   # a BU CEO: comes in once their BG CEO locks their unit
    mk("M1", BG1, CA)                                     # candidate: taking part
    mk("M2", BG2, CC)                                     # candidate: taken out of the cycle
    mk("M3", BG2, CC)                                     # candidate: for the duplicate / kind / remove paths
    mk("LV", BG1, CA, left_at="2026-01-01")               # a leaver
    mk("DM", BG1, CA, is_demo=1)                          # a demo login
    mk("STF", BG1, CA)                                    # plain staff
    db.execute("INSERT OR REPLACE INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG1, CA, ids["BU1"]))
    db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES (?,?)", ("ZZ9CM GROUP", ids["GC"]))
    # M2 is taken out of the cycle (the case on production: his senior leaders are not required to do PM / TM / IDP)
    db.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode, set_by) VALUES (?,?,'remove',?)",
               (CID, ids["M2"], SU["id"]))
    # an admin account to be refused by the picker
    db.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id) VALUES (?,?,?,?,?)",
               ("zz9cm-adm", "ZZ CM ADM", "x", "admin", "ZZ9CM-ADM"))
    ids["ADM"] = db.execute("SELECT id FROM users WHERE employee_id='ZZ9CM-ADM'").fetchone()[0]
    # a BG admin to be refused the page
    db.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, admin_bg) "
               "VALUES (?,?,?,?,?,?,?)", ("zz9cm-bga", "ZZ CM BGA", "x", "admin", "ZZ9CM-BGA", BG1, BG1))
    ids["BGA"] = db.execute("SELECT id FROM users WHERE employee_id='ZZ9CM-BGA'").fetchone()[0]
    db.commit()
CH, BC1, GC, BU1, M1, M2, M3, LV, DM, STF, ADM, BGA = (ids[k] for k in (
    "CH", "BC1", "GC", "BU1", "M1", "M2", "M3", "LV", "DM", "STF", "ADM", "BGA"))
EID = {k: "ZZ9CM-" + k for k in ids}
SUP, BGAC, STC, CHC = (H.client_as(a, x) for x in (SU["id"], BGA, STF, CH))
SIGNED_OUT = a.app.test_client()
PAGE = "/admin/leaders/chair"
MOVE, LOCK = "/review/chair/leaders/move", "/review/chair/leaders/lock"
_real_window, _real_open = a.window_closed, a.cycle_is_open
a.window_closed = lambda *x, **k: None
a.cycle_is_open = lambda *x, **k: True


def user(uid):
    return run(lambda d: d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def members():
    return {r[0]: r[1] for r in H.rows(a, "SELECT user_id, kind FROM chair_box_members")}


def n_log(action):
    return H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action=?", (action,))


def post(client, action, who=None, kind=None, extra=None, follow=True):
    data = {"csrf_token": "tok", "action": action}
    if who:
        data["leader"] = EID[who] if who in EID else who
    if kind is not None:
        data["kind"] = kind
    data.update(extra or {})
    return client.post(PAGE, data=data, follow_redirects=follow)


def say(r):
    """The flashed sentence on the page the post came back to."""
    html = r.get_data(as_text=True)
    m = re.search(r'class="flash[^"]*"[^>]*>(.*?)</', html, re.S)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else ""


def write(form, me=None, fn=None):
    """(ok, message) straight from the writer, in a request of its own."""
    f = fn or a._chair_member_write
    return run(lambda d: f(d, me or d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone(), MultiDict(form)))


def mutated(old, new):
    """The writer with one guard cut out (a falsification): its source with `old` replaced by `new`, compiled into the module."""
    src = inspect.getsource(a._chair_member_write)
    assert src.count(old) == 1, (src.count(old), old)
    keep = a._chair_member_write
    exec(compile(src.replace(old, new), "<falsified>", "exec"), a.__dict__)
    fn = a._chair_member_write
    a._chair_member_write = keep
    return fn


def state():
    return run(lambda d: a._chairlead_state(d, d.execute("SELECT * FROM users WHERE id=?", (CH,)).fetchone()))


def people():
    S = state()
    return {t: S["by_id"][ids[t]] for t in ids if S and ids[t] in S["by_id"]}


def reset_members():
    sql("DELETE FROM chair_box_members")
    sql("DELETE FROM chair_calls")
    sql("DELETE FROM chair_locks")


try:
    put("exec_chair_id", CH)
    put("exec_chair_delegate_id", None)
    put("exec_chair_team", None)

    # --------------------------------------------------------------------------------------------------- flag off
    s.section("flag off: the member actions are dark, the card is not there")
    for act in ("member_add", "member_kind", "member_remove"):
        r = post(SUP, act, "M1", "senior", follow=False)
        s.check("flag off: %s is 404 (the chair endpoint gate)" % act, r.status_code == 404, r.status_code)
    s.check("flag off: nothing was written", members() == {})
    s.check("the table exists with its columns, written in SCHEMA and in _ensure_runtime_schema", run(lambda d: [
        (r["name"], r["pk"]) for r in d.execute("PRAGMA table_info(chair_box_members)")]) == [
        ("user_id", 1), ("kind", 0), ("added_by", 0), ("added_at", 0)] and SRC.count("CREATE TABLE IF NOT EXISTS chair_box_members") == 2)

    def bad_kind(d):
        try:
            d.execute("INSERT INTO chair_box_members(user_id, kind) VALUES (?, 'ceo')", (M1,))
            return True
        except Exception:
            return False
    s.check("the table refuses a kind that isn't listed (the CHECK)", run(bad_kind) is False)

    # --------------------------------------------------------------------------------------------------- the page
    os.environ["ONEHR_CHAIR"] = "1"
    s.section("flag on: the card on Admin > Leaders > Executive Chairman")
    pg = SUP.get(PAGE).get_data(as_text=True)
    s.check("the card's title, lede and the two blocks are the board's words", all(x in pg for x in (
        "His leaders&#39; Talent Box", "Who he places at Year-End. His reports who are a BG CEO or lead a Group Chief group come in "
        "by themselves, and each BU CEO once their BG CEO locks their unit. Add anyone else he places here.",
        "Come in by themselves &middot; 2", "Added by you &middot; 0", "Add a leader", "Add to his box")) or all(x in pg for x in (
        "His leaders' Talent Box", "Come in by themselves &middot; 2", "Added by you &middot; 0", "Add a leader", "Add to his box")))
    s.check("...who comes in by themselves, with the role in brackets, and the BU CEOs line", all(x in pg for x in (
        "ZZ CM BC1 (BG CEO)", "ZZ CM GC (Group Chief)", "BU CEOs once their unit is locked")))
    s.check("...nobody added yet", "Nobody added yet." in pg)
    s.check("the grey lines: what 'In his box as' sets, and what the picker offers (the 'leaver' typo is fixed)",
            "sets the pill he finds them under: Group Chiefs or Senior leaders" in pg and "never an admin or a leaver" in pg
            and "never an admin or a leader" not in pg)
    s.check("the add form is its own post with ONE strict picker (a hidden Employee ID, never a typed box), double-confirmed",
            pg.count('class="pick-val"') == 2 and 'data-ec-addf' in pg and 'name="action" value="member_add"' in pg
            and 'data-confirm-ok="Add to his box"' in pg and re.search(r'<input[^>]*name="leader"[^>]*type="text"', pg) is None)
    s.check("a BG admin, staff and a signed-out visitor are refused the page", BGAC.get(PAGE).status_code == 403
            and STC.get(PAGE).status_code == 403 and SIGNED_OUT.get(PAGE).status_code in (302, 401))
    for who, c in (("a BG admin", BGAC), ("staff", STC), ("the chair himself", CHC)):
        n0 = len(members())
        r = post(c, "member_add", "M1", "senior", follow=False)
        s.check("%s cannot add (403)" % who, r.status_code == 403 and len(members()) == n0, r.status_code)
    r = SIGNED_OUT.post(PAGE, data={"csrf_token": "tok", "action": "member_add", "leader": EID["M1"], "kind": "senior"})
    s.check("signed out cannot add either", r.status_code in (302, 400, 401) and members() == {}, r.status_code)
    r = SUP.post(PAGE, data={"action": "member_add", "leader": EID["M1"], "kind": "senior"})
    s.check("the super admin's post without the CSRF token is refused and writes nothing", r.status_code == 400 and members() == {})

    # --------------------------------------------------------------------------------------------------- refusals
    s.section("refusals: each says why in plain words, and each guard is falsified")
    put("exec_chair_id", None)
    ok, msg = write({"action": "member_add", "leader": EID["M1"], "kind": "senior"})
    s.check("no seat: 'Pick the Executive Chairman first'", not ok and "Pick the Executive Chairman first" in msg and members() == {}, msg)
    put("exec_chair_id", CH)
    ok, msg = write({"action": "member_add", "leader": EID["M1"], "kind": "boss"})
    s.check("a kind that isn't listed is refused", not ok and msg == "Choose Group Chief or Senior leader." and members() == {}, msg)
    ok, msg = write({"action": "member_add", "leader": EID["M1"]})
    s.check("...so is no kind at all", not ok and msg == "Choose Group Chief or Senior leader.")
    ok, msg = write({"action": "member_kind", "leader": EID["M1"], "kind": ""})
    s.check("...and a kind change to nothing", not ok and msg == "Choose Group Chief or Senior leader.")
    ok, msg = write({"action": "nonsense", "leader": EID["M1"], "kind": "gc"})
    s.check("an unknown action does nothing", not ok and members() == {}, msg)
    for label, leader in (("typed text", "not-an-id"), ("nothing picked", ""), ("an admin account", EID["ADM"]),
                          ("a demo login", EID["DM"])):
        ok, msg = write({"action": "member_add", "leader": leader, "kind": "senior"})
        s.check("the picker's rule: %s is refused" % label, not ok and msg == "Pick the leader from the list." and members() == {}, msg)
    ok, msg = write({"action": "member_add", "leader": EID["LV"], "kind": "senior"})
    s.check("...a leaver is refused, named", not ok and "ZZ CM LV has left" in msg and members() == {}, msg)
    ok, msg = write({"action": "member_add", "leader": EID["CH"], "kind": "senior"})
    s.check("the chair himself: 'he places his leaders, not himself'", not ok and "he places his leaders, not himself" in msg
            and members() == {}, msg)
    ok, msg = write({"action": "member_add", "leader": EID["BC1"], "kind": "senior"})
    s.check("his BG CEO report comes in by themselves: refused, naming how", not ok and "already in his box" in msg
            and "a BG CEO" in msg and members() == {}, msg)
    ok, msg = write({"action": "member_add", "leader": EID["GC"], "kind": "gc"})
    s.check("his Group Chief report likewise", not ok and "already in his box" in msg and "a Group Chief" in msg and members() == {}, msg)
    ok, msg = write({"action": "member_add", "leader": EID["BU1"], "kind": "senior"})
    s.check("a BU CEO comes in once their BG CEO locks their unit: refused", not ok and "BU CEO" in msg
            and "once their BG CEO locks their unit" in msg and members() == {}, msg)
    sql("UPDATE users SET business_group='ZZ9CM BG ONE' WHERE id=?", (STF,))
    ok, msg = write({"action": "member_add", "leader": EID["M1"], "kind": "gc"})
    s.check("a valid add goes in (the control for every refusal above)", ok and members() == {M1: "gc"}, (ok, msg))
    ok, msg = write({"action": "member_add", "leader": EID["M1"], "kind": "senior"})
    s.check("a duplicate is refused, naming where they sit", not ok and "already in his box as a Group Chief" in msg
            and members() == {M1: "gc"}, msg)
    ok, msg = write({"action": "member_kind", "leader": EID["M2"], "kind": "gc"})
    s.check("changing someone who isn't in his box is refused", not ok and "isn't in his box" in msg, msg)
    ok, msg = write({"action": "member_remove", "leader": EID["M2"]})
    s.check("...so is taking them out", not ok and "isn't in his box" in msg, msg)
    ok, msg = write({"action": "member_kind", "leader": "not-an-id", "kind": "gc"})
    s.check("a kind change or removal also needs a real Employee ID", not ok and msg == "Pick the leader from the list.")
    sql("DELETE FROM chair_box_members")

    # falsified: each guard cut out lets the bad write through
    fn = mutated('if act != "member_remove" and kind not in CHAIR_BOX_KIND_LABEL:', "if False:")
    reset_members()
    try:
        ok, msg = write({"action": "member_add", "leader": EID["M1"], "kind": "boss"}, fn=fn)
    except Exception as e:   # the table's own CHECK is the second line: it refuses a kind that isn't listed
        ok, msg = False, "CHECK: %s" % e
    s.check("falsified: without the kind guard only the table's CHECK is left to refuse a made-up kind", not ok and members() == {}, (ok, msg))
    reset_members()
    fn = mutated('if not chair:\n        return False, "Pick the Executive Chairman first: this is his Talent Box."', "if False:\n        pass")
    put("exec_chair_id", None)
    ok, msg = write({"action": "member_add", "leader": EID["M1"], "kind": "senior"}, fn=fn)
    s.check("falsified: without the seat guard the add goes through on a box nobody holds", ok and M1 in members(), (ok, msg))
    put("exec_chair_id", CH)
    reset_members()
    real_pick = a._chair_pick
    a._chair_pick = lambda db_, eid_, what_: (db_.execute("SELECT * FROM users WHERE employee_id=?", (eid_,)).fetchone(), None)
    try:
        ok, msg = write({"action": "member_add", "leader": EID["ADM"], "kind": "senior"})
        s.check("falsified: without the picker's rule an admin account goes in", ok and ADM in members(), (ok, msg))
        sql("DELETE FROM chair_box_members")
    finally:
        a._chair_pick = real_pick
    fn = mutated('if row["id"] == chair:', "if False:")
    ok, msg = write({"action": "member_add", "leader": EID["CH"], "kind": "senior"}, fn=fn)
    s.check("falsified: without the chair-himself guard he goes into his own box", ok and CH in members(), (ok, msg))
    sql("DELETE FROM chair_box_members")
    fn = mutated("if row[\"id\"] in direct:", "if False:")
    ok, msg = write({"action": "member_add", "leader": EID["BC1"], "kind": "senior"}, fn=fn)
    s.check("falsified: without the 'comes in by themselves' guard his BG CEO is added twice over", ok and BC1 in members(), (ok, msg))
    sql("DELETE FROM chair_box_members")
    fn = mutated('if db.execute("SELECT 1 FROM buceo_seats', 'if False and db.execute("SELECT 1 FROM buceo_seats')
    ok, msg = write({"action": "member_add", "leader": EID["BU1"], "kind": "senior"}, fn=fn)
    s.check("falsified: without the BU CEO guard a BU CEO goes in before their BG CEO locks", ok and BU1 in members(), (ok, msg))
    sql("DELETE FROM chair_box_members")
    write({"action": "member_add", "leader": EID["M1"], "kind": "gc"})
    fn = mutated("if have:\n            return False,", "if False:\n            return False,")
    try:
        ok, msg = write({"action": "member_add", "leader": EID["M1"], "kind": "senior"}, fn=fn)
    except Exception as e:   # the table's own key is the second line: it refuses a second row for the same person
        ok, msg = None, "KEY: %s" % e
    s.check("falsified: without the duplicate guard the sentence is gone, only the table's key is left to stop a second row",
            ok is None and members() == {M1: "gc"}, (ok, msg, members()))
    sql("DELETE FROM chair_box_members")

    # --------------------------------------------------------------------------------------------------- add / kind / remove
    s.section("add, change, remove: through the page, double-confirmed, one audit row each")
    n_add, n_kind, n_rem = n_log("exec_chair_member_add"), n_log("exec_chair_member_kind"), n_log("exec_chair_member_remove")
    r = post(SUP, "member_add", "M1", "senior")
    s.check("the super admin adds M1 as a Senior leader", members() == {M1: "senior"} and "Senior leader" in say(r), (members(), say(r)))
    row = H.rows(a, "SELECT user_id, action, detail, target_user_id FROM activity_log WHERE action='exec_chair_member_add' "
                    "ORDER BY id DESC LIMIT 1")[0]
    s.check("...one audit row, naming who and as what, with the person as its target", n_log("exec_chair_member_add") == n_add + 1
            and row[0] == SU["id"] and "ZZ CM M1 (ZZ9CM-M1)" in row[2] and "Senior leader" in row[2] and row[3] == M1, tuple(row))
    r = post(SUP, "member_add", "M2", "gc")
    r = post(SUP, "member_add", "M3", "senior")
    s.check("three added; the page counts them and lists each with the select, the pill and Remove", members() == {
        M1: "senior", M2: "gc", M3: "senior"})
    pg = SUP.get(PAGE).get_data(as_text=True)
    s.check("...'Added by you · 3', the table headings are the board's, one line each", "Added by you &middot; 3" in pg and all(
        h in pg for h in ('scope="col">Name<', "Employee ID &middot; Job", "In his box as")) and "white-space: nowrap" in re.search(
        r"\.ec-tbl th \{[^}]*\}", open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()).group(0))
    s.check("...each row is two forms of its own (kind, remove), each double-confirmed, the remove one red", all(
        x in pg for x in ('id="ec-kf-%d"' % M1, 'id="ec-rf-%d"' % M1, 'data-confirm-ok="Remove from his box"',
                          'data-confirm-tone="danger"', "out of his Talent Box? A move he made for them is dropped.")))
    s.check("...M1 is taking part, M2 is not (the participation rule)", "Taking part" in pg and "Not taking part" in pg)
    s.check("...the group chief option is selected for M2", re.search(
        r'form="ec-kf-%d"[^>]*>\s*<option value="gc" selected' % M2, pg) is not None)
    r = post(SUP, "member_kind", "M1", "gc")
    s.check("a kind change takes effect", members()[M1] == "gc" and n_log("exec_chair_member_kind") == n_kind + 1, say(r))
    row = H.rows(a, "SELECT detail FROM activity_log WHERE action='exec_chair_member_kind' ORDER BY id DESC LIMIT 1")[0][0]
    s.check("...and its audit row says from what to what", "Senior leader -> Group Chief" in row and "ZZ9CM-M1" in row, row)
    r = post(SUP, "member_kind", "M1", "gc")
    s.check("the same kind again changes nothing and logs nothing", say(r) == "Nothing changed."
            and n_log("exec_chair_member_kind") == n_kind + 1)
    post(SUP, "member_kind", "M1", "senior")
    # a removal drops his working moves for that person only
    sql("INSERT INTO chair_calls(cycle_id, subject_id, axis, band, reason, called_by) VALUES (?,?,?,?,?,?)", (CID, M3, "pm", "ME", "x", CH))
    sql("INSERT INTO chair_calls(cycle_id, subject_id, axis, band, reason, called_by) VALUES (?,?,?,?,?,?)", (CID, M3, "pot", "Mid", "x", CH))
    sql("INSERT INTO chair_calls(cycle_id, subject_id, axis, band, reason, called_by) VALUES (?,?,?,?,?,?)", (CID, M1, "pm", "ME", "x", CH))
    r = post(SUP, "member_remove", "M3")
    s.check("a removal takes them out", M3 not in members() and members() == {M1: "senior", M2: "gc"}, say(r))
    s.check("...drops his working moves for them, and only theirs", H.one(a, "SELECT COUNT(*) FROM chair_calls WHERE subject_id=?", (M3,)) == 0
            and H.one(a, "SELECT COUNT(*) FROM chair_calls WHERE subject_id=?", (M1,)) == 1)
    row = H.rows(a, "SELECT detail, target_user_id FROM activity_log WHERE action='exec_chair_member_remove' ORDER BY id DESC LIMIT 1")[0]
    s.check("...one audit row, naming who, and that his moves were dropped", n_log("exec_chair_member_remove") == n_rem + 1
            and "ZZ9CM-M3" in row[0] and "dropped" in row[0] and row[1] == M3, tuple(row))
    sql("DELETE FROM chair_calls")
    # a member who has since left can still be taken out
    sql("UPDATE users SET left_at='2026-02-01' WHERE id=?", (M2,))
    pg = SUP.get(PAGE).get_data(as_text=True)
    s.check("a member who has left shows 'Has left' and can still be removed", "Has left" in pg)
    post(SUP, "member_remove", "M2")
    s.check("...removed", M2 not in members())
    sql("UPDATE users SET left_at=NULL WHERE id=?", (M2,))
    r = post(SUP, "member_add", "M2", "gc")
    s.check("(put back: M2 added again as a Group Chief)", members() == {M1: "senior", M2: "gc"})

    # --------------------------------------------------------------------------------------------------- his box
    s.section("his box: the pills, the roles, 'Not in the cycle' and 'Place by hand'")
    sql("INSERT OR REPLACE INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG1, CA, BU1))
    P = people()
    s.check("his box holds his BG CEO, his Group Chief and the two members; no BU CEO yet (unit not locked), no staff, nobody twice",
            set(P) == {"BC1", "GC", "M1", "M2"}, sorted(P))
    s.check("a 'senior' member: the Senior leaders pill, role 'Senior leader'", P["M1"]["pill"] == "senior" and P["M1"]["role"] == "Senior leader"
            and P["M1"]["member"] is True and P["M1"]["kind"] == "senior")
    s.check("a 'gc' member: the Group Chiefs pill (with his Group Chief report), role 'Group Chief'",
            P["M2"]["pill"] == "gc" and P["M2"]["role"] == "Group Chief" and P["GC"]["pill"] == "gc")
    s.check("...under their own business group's name for the unit/where line", P["M1"]["unit"] == run(lambda d: a.display_bg(BG1)) and
            P["M2"]["unit"] == run(lambda d: a.display_bg(BG2)))
    s.check("participation is read once: M1 is in the cycle, M2 is not; the others are in by the rule",
            P["M1"]["in_cycle"] is True and P["M2"]["in_cycle"] is False and P["BC1"]["in_cycle"] is True)
    pay = json.loads(CHC.get("/review/chat/history?journey=1&view=chairlead&stage=chair_leaders&mode=summary")
                     .get_data(as_text=True))["overview"]["data"]
    un = {x["name"][6:]: x for x in pay["unplaced"]}
    s.check("the pills: business groups first, then Group Chiefs, then Senior leaders", [b["label"] for b in pay["bgs"]][-2:] == [
        "Group Chiefs", "Senior leaders"], [b["label"] for b in pay["bgs"]])
    s.check("a member in the cycle with no result: 'Awaits your rating' / 'No KPI · no 360' (as for anyone)",
            un["M1"]["need"] == "Awaits your rating" and un["M1"]["why"] == "No KPI · no 360", (un["M1"]["need"], un["M1"]["why"]))
    s.check("a member NOT in the cycle: 'Not in the cycle' / 'Place by hand', with Place (not locked)",
            un["M2"]["need"] == "Not in the cycle" and un["M2"]["why"] == "Place by hand" and un["M2"]["locked"] is False)
    s.check("...and the box counts them as waiting on him", pay["lock"]["can"] is False and pay["lock"]["n_wait"] == 4, pay["lock"])
    pay_s = json.loads(CHC.get("/review/chat/history?journey=1&view=chairlead&stage=chair_leaders&mode=summary&bg=senior").get_data(as_text=True))["overview"]["data"]
    s.check("the Senior leaders pill narrows the box to them", [x["name"][6:] for x in pay_s["unplaced"]] == ["M1"], pay_s["bg"])
    # an invalid member row never reaches the box: a leaver, an admin, a demo login, the chair, an automatic leader, a BU CEO
    for tag in ("LV", "DM", "STF", "CH", "BC1", "BU1", "ADM"):
        sql("INSERT OR IGNORE INTO chair_box_members(user_id, kind) VALUES (?, 'senior')", (ids[tag],))
    P2 = people()
    s.check("a stored row for a leaver, a demo login, an admin, the chair, an automatic leader or a BU CEO adds nobody to the box "
            "(and nobody twice)", set(P2) == {"BC1", "GC", "M1", "M2", "STF"} and P2["BC1"]["role"] == "BG CEO"
            and P2["BC1"]["pill"] == BG1 and "BU1" not in P2 and "LV" not in P2 and "DM" not in P2 and "CH" not in P2
            and "ADM" not in P2, sorted(P2))
    sql("DELETE FROM chair_box_members WHERE user_id IN (?,?,?,?,?,?,?)", (ids["LV"], ids["DM"], ids["STF"], CH, BC1, BU1, ADM))
    s.check("(put back)", set(people()) == {"BC1", "GC", "M1", "M2"})
    # ONE batched read of participation, however many members
    reads = []
    real_tp = a._chair_taking_part
    a._chair_taking_part = lambda db_, ids_: (reads.append(len(list(ids_))), real_tp(db_, ids_))[1]
    try:
        state()
    finally:
        a._chair_taking_part = real_tp
    s.check("participation is ONE batched read for all the members (not one per person)", reads == [2], reads)

    # --------------------------------------------------------------------------------------------------- place + lock
    s.section("place and lock work for a member who is not in the cycle")

    def move(tag, perf, pot):
        return CHC.post(MOVE, data={"csrf_token": "tok", "subject_id": str(ids[tag]), "performance_band": perf,
                                    "potential_band": pot, "justification": REASON})
    r = CHC.post(LOCK, data={"csrf_token": "tok"})
    s.check("the lock still waits on everyone: the member not in the cycle is not placed", r.status_code == 400
            and "not placed yet" in json.loads(r.get_data(as_text=True))["error"])
    r = move("M2", "AE", "High")
    s.check("he places the member who is not in the cycle by hand (a reason is kept)", r.status_code == 200, r.get_data(as_text=True)[:200])
    s.check("...they are placed, with the band he chose and their working call kept", people()["M2"]["placed"] is True
            and (people()["M2"]["perf"], people()["M2"]["pot"]) == ("AE", "High"))
    s.check("...and 'Not in the cycle' goes with the Not placed list once placed", "M2" not in [
        x["name"][6:] for x in json.loads(CHC.get("/review/chat/history?journey=1&view=chairlead&stage=chair_leaders&mode=summary")
                                          .get_data(as_text=True))["overview"]["data"]["unplaced"]])
    for tag, pf, pt in (("M1", "ME", "Mid"), ("BC1", "ME", "Mid"), ("GC", "BE", "Low")):
        move(tag, pf, pt)
    s.check("everyone is placed", all(p["placed"] for p in people().values()), {k: v["placed"] for k, v in people().items()})
    # a removal / add / change is allowed until the lock, then refused
    r = CHC.post(LOCK, data={"csrf_token": "tok"})
    s.check("Lock Talent Box works with a member who is not in the cycle", r.status_code == 200 and json.loads(r.get_data(as_text=True))["n"] == 4,
            r.get_data(as_text=True)[:200])
    s.check("...a chair_locks row per axis for them, with the band he placed", {(r_[0], r_[1]) for r_ in H.rows(
        a, "SELECT axis, band FROM chair_locks WHERE subject_id=?", (M2,))} == {("pm", "AE"), ("pot", "High")})

    s.section("a locked box: no add, no change, no removal; each says why")
    pg = SUP.get(PAGE).get_data(as_text=True)
    s.check("the card says it is locked and disables its controls", "is locked for" in pg and "his decision is final" in pg
            and len(re.findall(r"<select[^>]*ec-kind[^>]*disabled", pg)) == 2 and "ec-remove\" disabled" in pg.replace('class="ec-remove" disabled', 'ec-remove" disabled'))
    before = members()
    for act, who, kind in (("member_add", "M3", "senior"), ("member_kind", "M1", "gc"), ("member_remove", "M1", None)):
        ok, msg = write({"action": act, "leader": EID[who], "kind": kind or ""})
        s.check("locked: %s is refused with the reason" % act, not ok and "locked for" in msg and "his decision is final" in msg
                and members() == before, msg)
    r = post(SUP, "member_add", "M3", "senior")
    s.check("...and through the page too", "locked" in say(r) and members() == before, say(r))
    fn = mutated("if locked:\n        return False,", "if False:\n        return False,")
    ok, msg = write({"action": "member_add", "leader": EID["M3"], "kind": "senior"}, fn=fn)
    s.check("falsified: without the lock guard a leader is added to a locked box", ok and M3 in members(), (ok, msg))
    sql("DELETE FROM chair_box_members WHERE user_id=?", (M3,))
    real_lk = a._chair_box_locked
    a._chair_box_locked = lambda db_: (real_lk(db_)[0], False)
    try:
        ok, msg = write({"action": "member_remove", "leader": EID["M1"]})
        s.check("falsified: with the lock read as open, a removal goes through (so the check above sees the guard)", ok and M1 not in members())
        sql("INSERT OR REPLACE INTO chair_box_members(user_id, kind) VALUES (?, 'senior')", (M1,))
    finally:
        a._chair_box_locked = real_lk

    # --------------------------------------------------------------------------------------------------- the release path
    s.section("what he locks goes through the super admin's result release like everyone's (Chris, 2026-10-30)")
    M2U = user(M2)
    fin_pm = run(lambda d: a.final_result(d, user(M2), CID, "pm"))
    fin_pot = run(lambda d: a.final_result(d, user(M2), CID, "pot"))
    s.check("his locked bands are the member's FINAL result on both axes, stage Final, though they are not in the cycle",
            fin_pm and fin_pot and (fin_pm["band"], fin_pm["final"]) == ("AE", True) and (fin_pot["band"], fin_pot["final"]) == ("High", True)
            and fin_pm["stage"] == "Final", (fin_pm, fin_pot))
    rr = H.rows(a, "SELECT pm_final_band, pm_final_source, pot_final_band, pot_final_source FROM rating_records WHERE cycle_id=? AND subject_id=?",
                (CID, M2))
    s.check("the rating record was written at his lock with his bands (source 'top', never his name)",
            rr and tuple(rr[0]) == ("AE", "top", "High", "top"), rr and tuple(rr[0]))
    s.check("nothing is released yet: the person sees no final band", run(lambda d: a.released_final_band(d, user(M2), CID, "pm")) is None
            and run(lambda d: a.released_final_band(d, user(M2), CID, "pot")) is None)
    rel = SUP.get("/admin/talent-release")
    html = rel.get_data(as_text=True)
    s.check("the Release results page lists the member who is not in the cycle (they hold a final band of his)", rel.status_code == 200
            and "ZZ CM M2" in html, rel.status_code)
    s.check("the page lists no one else who is not in the cycle: only people he locked", "ZZ CM STF" not in html and "ZZ CM LV" not in html)
    sql("DELETE FROM chair_locks WHERE subject_id=?", (M2,))
    s.check("falsified: without his lock row the same person is not on the release page (the list follows his lock)",
            "ZZ CM M2" not in SUP.get("/admin/talent-release").get_data(as_text=True))
    sql("INSERT INTO chair_locks(cycle_id, subject_id, axis, band, moved, locked_by) VALUES (?,?,'pm','AE',1,?)", (CID, M2, CH))
    sql("INSERT INTO chair_locks(cycle_id, subject_id, axis, band, moved, locked_by) VALUES (?,?,'pot','High',1,?)", (CID, M2, CH))
    r = SUP.post("/admin/talent-release", data={"csrf_token": "tok", "action": "release", "result": "three", "to": "leaders",
                                                  "ids": [str(M2), str(M1)]})
    lead = {(r_[0], r_[1]) for r_ in H.rows(a, "SELECT subject_id, kind FROM leader_releases WHERE cycle_id=?", (CID,))}
    s.check("release step 1 (to leaders) writes the rows for them: performance and potential", {(M2, "pm"), (M2, "pot")} <= lead, sorted(lead))
    s.note("talent status: not released for them (an existing rule: a potential band counts for the talent status only with a valid 360, "
           "which a leader not in the cycle has not) -- reported, not changed here")
    s.check("...step 1 alone does not show the person their band", run(lambda d: a.released_final_band(d, user(M2), CID, "pm")) is None)
    r = SUP.post("/admin/talent-release", data={"csrf_token": "tok", "action": "release", "result": "three", "to": "employees",
                                                  "ids": [str(M2)]})
    s.check("release step 2 (to the person) follows: a result release row for each axis", H.one(
        a, "SELECT COUNT(*) FROM result_releases WHERE cycle_id=? AND subject_id=?", (CID, M2)) == 2)
    s.check("...and released_final_band now hands the person his locked bands, performance and potential",
            run(lambda d: a.released_final_band(d, user(M2), CID, "pm")) == "AE"
            and run(lambda d: a.released_final_band(d, user(M2), CID, "pot")) == "High")
finally:
    a.window_closed, a.cycle_is_open = _real_window, _real_open
    os.environ.pop("ONEHR_CHAIR", None)

sys.exit(s.done())
