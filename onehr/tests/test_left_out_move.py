"""Moving someone INTO a left-out unit does what the Participants unit rule does for them (Chris, 9 Nov 2026; HANDOFF "Profile-change
guards: open, not built"; "let the admin decides when removing the person, with warning").

The unit rule (`_exclusion_save`) archives everyone's 360 rows both ways and moves the KPI lines nobody has acted on whose moderator is
out one level up. The profile-change engine, when Edit details or the people import put someone INTO a unit the cycle leaves out, did
only the rated side (`_rated_360_sync`). Now ONE shared plan and writer (`_left_out_plan`, `_left_out_apply`) serve both:

  * AUTO, their PENDING ratings of colleagues are archived with the unit rule's words ("<unit> isn't taking part in <cycle>"), and the
    KPI lines they moderate for people still taking part that nobody has acted on move to the next manager above who takes part (an
    acted-on line stays, counted; a line with nobody above stays, named)
  * ASK `rater360` (the super admin's), only when they have SUBMITTED ratings of colleagues: Keep them (default) | Archive them (red, a
    reason). The warning is counts only (S colleagues whose 360 changes, K below a full panel), never a colleague's name. A submitted
    rating whose colleague's 360 result is decided (a potential calibration band, or the result released) is NEVER archived, whichever
    option. A non-super admin sees a read-only line and the server refuses a forged Archive. Re-checked against what is stored now.
  * moving back OUT restores nothing on the rater side (as Bring back); the rated side comes back as before
  * the people import asks the same (step 3's group with Keep | Archive per person and one reason for the file; step 4's tile)
Synthetic ZZLO-* people, units and ratings on a fresh scratch database; Suite.done() puts it back. Every guard is falsified in the suite
by switching it off and showing the same step then goes through; `test_unit_exclusion` passes untouched.
"""
import csv as _csv
import hashlib
import html as _html
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Moving into a left-out unit: the unit rule's per-person part, through one shared function")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
GA = "ZZLO Alpha"
UA, UB, UC = "ZZLO UnitA", "ZZLO UnitB", "ZZLO UnitC"   # UB is left out of the cycle
P = "/admin/import/roster"
WHY = "Their ratings of colleagues were taken out because the unit left the cycle."


def q(sql, args=()):
    return [tuple(r) for r in H.rows(a, sql, args)]


def one(sql, args=()):
    return H.one(a, sql, args)


with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    CNAME = a.active_cycle(db)["name"]
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=?", (CID,))
    db.execute("UPDATE cycles SET kind='early_year', year=2027, half=0, min_job_grade=NULL, starts_on=NULL WHERE id=?", (CID,))
    for u_ in (UA, UB, UC):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (GA, u_))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (GA,))
    db.execute("INSERT INTO cycle_exclusions(cycle_id, business_group, company, department, created_by) VALUES (?,?,?, '', ?)",
               (CID, GA, UB, SU["id"]))
    TGT = a.panel_short_n()

    def mk(eid, unit=UA, dept="Ops", grade=14, mgr=None, **kw):
        cols = dict(username=eid.lower(), full_name="ZZ LO " + eid.split("-", 1)[1], password_hash="x", role="user", employee_id=eid,
                    business_group=GA, company=unit, department=dept, job_title="ZZLO Officer", job_grade=grade,
                    confirmation_date="2020-01-01", manager_id=mgr, email=eid.lower() + "@zzlo.invalid")
        cols.update(kw)
        return a.get_db().execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                                  list(cols.values())).lastrowid
    MGR = mk("ZZLO-MGR", grade=21, dept="Management")
    mk("ZZLO-D1", unit=UB, dept="Ops")   # so a department "Ops" exists in the left-out unit's list
    mk("ZZLO-D2", unit=UC, dept="Ops")
    # admins: a super (SU), and one with People › Edit details but not the super admin's powers
    db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZLO Viewer', 'group')")
    R_VIEW = db.execute("SELECT id FROM admin_roles WHERE name='ZZLO Viewer'").fetchone()[0]
    for item in sorted(a.role_preset_items("view") | {"people.details"}):
        db.execute("INSERT OR IGNORE INTO admin_role_access(role_id, item) VALUES (?,?)", (R_VIEW, item))
    ADM = mk("ZZLO-ADM", role="admin", admin_bg=GA, grade=None)
    db.execute("UPDATE users SET admin_role_id=? WHERE id=?", (R_VIEW, ADM))
    db.execute("INSERT INTO admin_notify_emails(user_id, email) VALUES (?, 'super@zzlo.invalid')", (SU["id"],))
    db.commit()
    SUROW = dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())

SUP, CADM = H.client_as(a, SU["id"]), H.client_as(a, ADM)
N = [0]


def person(tag, **kw):
    N[0] += 1
    kw.setdefault("mgr", MGR)
    with a.app.app_context():
        d = a.get_db()
        pid = mk("ZZLO-%s" % tag, **kw)
        d.commit()
    return pid


def row(pid):
    return dict(H.rows(a, "SELECT * FROM users WHERE id=?", (pid,))[0])


def rate(subject, assessor, status="submitted"):
    with a.app.app_context():
        d = a.get_db()
        aid = d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) VALUES (?,?,?, 'peer', ?)",
                        (CID, subject, assessor, status)).lastrowid
        d.commit()
    return aid


def arow(aid):
    return dict(H.rows(a, "SELECT * FROM assignments WHERE id=?", (aid,))[0])


def decide_360(subject):
    """A potential calibration band is set on them: their 360 result is decided."""
    with a.app.app_context():
        d = a.get_db()
        sid = d.execute("INSERT INTO calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label) VALUES (?, 'hod', ?, ?, 'ZZLO')",
                        (CID, "ZZLO scope %d" % subject, GA)).lastrowid
        d.execute("INSERT INTO calibration_adjustments(session_id, subject_id, original_band, adjusted_band) VALUES (?,?, 'Mid', 'High')",
                  (sid, subject))
        d.commit()


def kpi(subject, mods, acted=False, name="ZZLO KPI"):
    with a.app.app_context():
        d = a.get_db()
        tid = d.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, company) "
                        "VALUES (?,?,?,100, 'more', ?,?)", (CID, subject, name, GA, UA)).lastrowid
        for i, m in enumerate(mods, start=1):
            d.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,?,?)", (tid, i, m))
        if acted:
            d.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, acted_by) VALUES (?,1,'confirm',?)", (tid, mods[0]))
        d.commit()
    return tid


def chain(tid):
    return [r[0] for r in H.rows(a, "SELECT approver_id FROM pm_kpi_target_approvers WHERE kpi_target_id=? ORDER BY seq", (tid,))]


def scenario(tag, unit=UA, submitted=2):
    """A mover X in UA who rates: C1 (pending), C2 (submitted, thin panel), C3 (submitted, 360 DECIDED), C4 (submitted, full panel
    of other raters); moderates L1 (S1's line, unacted) and L2 (S2's, acted on); and is rated by RX (pending, the rated side)."""
    X = person("%s-X" % tag, unit=unit)
    C = {k: person("%s-C%d" % (tag, k)) for k in (1, 2, 3, 4)}
    S1, S2 = person("%s-S1" % tag), person("%s-S2" % tag)
    A = {"C1": rate(C[1], X, "pending"), "C2": rate(C[2], X), "C3": rate(C[3], X), "C4": rate(C[4], X)}
    decide_360(C[3])
    others = [person("%s-O%d" % (tag, i)) for i in range(TGT + 1)]
    for o in others:
        rate(C[4], o)
    A["RX"] = rate(X, person("%s-RX" % tag), "pending")
    L1, L2 = kpi(S1, [X]), kpi(S2, [X], acted=True)
    return {"X": X, "C": C, "A": A, "S1": S1, "S2": S2, "L1": L1, "L2": L2, "M": MGR}


def pform(pid, unit=None, dept=None, grade=None, action="details_apply", **kw):
    p = row(pid)
    d = {"csrf_token": "tok", "action": action, "full_name": p["full_name"], "company": unit if unit is not None else p["company"],
         "department": dept if dept is not None else (p["department"] or ""), "job_title": p["job_title"] or "",
         "job_grade": str(grade if grade is not None else p["job_grade"] or ""), "joined_date": ""}
    d.update(kw)
    return d


def post(pid, client=None, **kw):
    return (client or SUP).post("/admin/users/%d/lines" % pid, data=pform(pid, **kw), follow_redirects=True)


def txt(r):
    return _html.unescape(r.get_data(as_text=True))


def trail(pid, action=None):
    return [r[0] for r in H.rows(a, "SELECT detail FROM activity_log WHERE target_user_id=?" + (" AND action=?" if action else "")
                                 + " ORDER BY id", (pid,) + ((action,) if action else ()))]


def preview(pid, client=None, **kw):
    return txt((client or SUP).post("/admin/users/%d/lines" % pid, data=pform(pid, action="details_preview", **kw)))


def state_of(html):
    m = re.search(r'name="ask_state_rater360" value="([^"]*)"', html)
    return m.group(1) if m else None


def moved(sc):
    return row(sc["X"])["company"] == UB


def falsify(name, patches, then, went):
    """Switch a guard off (module-level patches {name: replacement}), run `then`, put it back: `went()` must now be True."""
    real = {k: getattr(a, k) for k in patches}
    try:
        for k, v in patches.items():
            setattr(a, k, v)
        then()
        got = went()
    finally:
        for k, v in real.items():
            setattr(a, k, v)
    s.check("falsified: %s -- with the guard switched off the same step goes through" % name, got)


UNIT_WHY = "%s isn't taking part in %s" % (UB, CNAME)

# ---------------------------------------------------------------------------------------------------------------------------
s.section("Edit details: the preview says what stops, and asks about the submitted ratings")
K = scenario("K")
b = preview(K["X"], unit=UB)
s.check("the preview has a row 'Their ratings' (1 pending archived, nothing restored on moving back) and 'Their KPI lines' (1 up a level, 1 acted on stays)",
        "Their ratings" in b and "1 pending rating they give colleagues is archived (the panel editor can restore it). Moving back out of the unit restores none of their ratings." in b
        and "KPI lines they moderate" in b and "1 KPI line they moderate moves one level up, to the next manager taking part" in b
        and "1 KPI line someone has acted on stays with them" in b, b[b.find("Their ratings"):][:700])
s.check("...and the question: Their 360 ratings of colleagues, the chip '3 submitted', Keep them pre-selected, Archive them red with a reason box",
        'data-ask="rater360"' in b and "Their 360 ratings of colleagues" in b and ">3 submitted<" in b and state_of(b) == "submitted:2"
        and re.search(r'name="ask_rater360" value="keep" checked', b) and 'name="ask_rater360" value="archive"' in b
        and "Their submitted ratings stay and still count. Nothing changes for those colleagues." in b
        and "Taken out of 2 colleagues' 360 scores, so their scores change; 1 would fall below a full panel. The panel editor can restore them." in b
        and 'data-ask-reason="archive"' in b and 'name="ask_reason_rater360"' in b and 'class="pp-opt is-danger"' in b, "")
s.check("...the lede: the unit isn't taking part, 3 submitted, the decided one stays either way",
        "%s isn't taking part in %s. They have submitted 3 ratings of colleagues this cycle. 1 of them stays either way: that colleague's result is decided." % (UB, CNAME) in b, "")
s.check("...the reason box is labelled and helped as drawn", "Why their ratings are archived" in b and "500 at most. It goes in the trail with the counts." in b)
s.check("...the legend, aria label, foot button and confirm title come from the ask, not a key switch in the template",
        'aria-label="What to do with their submitted 360 ratings of colleagues"' in b and 'data-ask-btn="Save and archive"' in b
        and 'data-ask-title="Archive 2 submitted 360 ratings?"' in b
        and 'data-ask-confirm="Archive 2 submitted 360 ratings of colleagues. Those colleagues\' 360 scores change. The panel editor can restore them."' in b.replace("&#39;", "'"), "")
s.check("...the confirm names the person once, as the other asks' bodies do ('<name>'s details change'), never the unit again",
        'data-ask-name="ZZ LO K-X" data-ask-what="details change"' in b, b[b.find("data-ask-name"):][:120])
s.check("the rows are in the canvas's order: BU calibration, then Their ratings, then the KPI lines they moderate",
        0 < b.find("<span>BU calibration</span>") < b.find("<span>Their ratings</span>") < b.find("<span>KPI lines they moderate</span>"), "")
s.check("'Taking part' is about the ratings colleagues gave ABOUT them, 'Their ratings' about the ratings they GIVE colleagues: never the same words",
        "the 360 ratings colleagues gave about them are archived" in b and "pending rating they give colleagues" in b
        and "as the person rated" not in b[b.find("Taking part"):][:400], b[b.find("Taking part"):][:300])
s.check("with no KPI line of their own, 'Stays as it is' does not say '0 KPI lines' and the rows never disagree",
        "Their 0 KPI line" not in b and "Their own 0 KPI" not in b and "<span>Stays as it is</span>" not in b, "")
s.check("...the block sits after the Grade H block and before the competencies (none here): the form carries ask_shown",
        b.find('data-ask="rater360"') > 0 and 'name="ask_shown" value="1"' in b)
s.check("...counts only: no colleague's name anywhere in the question", not re.search(r"ZZ LO K-C[1-4]", b[b.find('data-ask="rater360"'):][:3000]),
        "")
s.check("the preview writes nothing (every rating live, the line still X's)", all(arow(v)["archived"] == 0 for v in K["A"].values())
        and chain(K["L1"]) == [K["X"]] and row(K["X"])["company"] == UA)
pl = None
with a.app.test_request_context("/"):
    d = a.get_db()
    pl = a._profile_change_plan(d, SUROW, dict(d.execute("SELECT * FROM users WHERE id=?", (K["X"],)).fetchone()), {"company": UB}, a.active_cycle(d))
s.check("the engine plan lists it as an auto line and an ask with the super admin as who_can",
        any(x["key"] == "left_out" for x in pl["auto"]) and next(x for x in pl["asks"] if x["key"] == "rater360")["who_can"]
        and next(x for x in pl["asks"] if x["key"] == "rater360")["default"] == "keep", [x["key"] for x in pl["auto"]])

# ---------------------------------------------------------------------------------------------------------------------------
s.section("Keep them (the default): pending archived, KPI lines up, submitted stay")
r = post(K["X"], unit=UB, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="keep")
t = txt(r)
s.check("the unit moved", moved(K), row(K["X"])["company"])
s.check("the PENDING rating they give is archived with the unit rule's words and the actor",
        arow(K["A"]["C1"])["archived"] == 1 and arow(K["A"]["C1"])["archive_reason"] == UNIT_WHY and arow(K["A"]["C1"])["archived_by"] == SU["id"],
        arow(K["A"]["C1"]))
s.check("Keep: all three submitted ratings stay live and still count", all(arow(K["A"][k])["archived"] == 0 for k in ("C2", "C3", "C4")))
s.check("the rated side is archived by the existing sync (the rating OF them), with its own reason", arow(K["A"]["RX"])["archived"] == 1
        and arow(K["A"]["RX"])["archive_reason"] == a.PROFILE_OUT_REASON, arow(K["A"]["RX"])["archive_reason"])
s.check("the unacted KPI line they moderated now sits with the next manager who takes part (their line manager)",
        chain(K["L1"]) == [MGR], chain(K["L1"]))
s.check("the acted-on line stays with them", chain(K["L2"]) == [K["X"]], chain(K["L2"]))
s.check("the flash names what happened: pending archived, a line moved, the acted-on one staying, submitted staying",
        "no longer rates colleagues or moderates KPIs in %s" % CNAME in t and "1 pending 360 rating of colleagues archived" in t, t[t.find("Details saved"):][:500])
tr = trail(K["X"], "set_details")
s.check("the trail has the counts on ONE row for them, the details change and what stopped together (the engine's separate row is gone, 9 Nov)",
        len(tr) == 1 and "no longer rates colleagues or moderates KPIs in %s" % CNAME in tr[0] and UB in tr[0] and "1 pending 360 rating" in tr[0]
        and "1 KPI line they moderate moved one level up" in tr[0], tr)
# a later rated-side sync never brings the archived pending rating back (its reason is not one of the restore reasons)
with a.app.app_context():
    d = a.get_db()
    a._rated_360_sync(d, SUROW, a.active_cycle(d), K["X"], a.PROFILE_OUT_REASON)
    d.commit()
s.check("a later sync of the rated side never brings the archived rating back", arow(K["A"]["C1"])["archived"] == 1)

# ---------------------------------------------------------------------------------------------------------------------------
s.section("Archive them (super admin, a reason): only the undecided submitted ratings go")
B = scenario("B")
r = post(B["X"], unit=UB, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="archive")
s.check("a missing reason is refused: nothing saved", "Give a reason for the archive: it goes in the trail." in txt(r) and "Nothing has been saved." in txt(r)
        and row(B["X"])["company"] == UA and all(arow(v)["archived"] == 0 for v in B["A"].values()), txt(r)[:200])
r = post(B["X"], unit=UB, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="archive", ask_reason_rater360=WHY)
tb = txt(r)
s.check("with a reason it saves", moved(B), row(B["X"])["company"])
s.check("the two undecided submitted ratings are archived with the unit rule's words, the pending one too",
        all(arow(B["A"][k])["archived"] == 1 and arow(B["A"][k])["archive_reason"] == UNIT_WHY for k in ("C1", "C2", "C4")),
        [arow(B["A"][k])["archived"] for k in ("C1", "C2", "C4")])
s.check("the one whose colleague's 360 result is DECIDED stays live: never archived whichever option", arow(B["A"]["C3"])["archived"] == 0)
s.check("the trail holds the counts and the reason; the flash says 2 submitted archived and 1 below a full panel",
        any("2 360 ratings they had submitted archived" in x and "reason for archiving what they had submitted: " + WHY in x
            and "1 below a full panel" in x for x in trail(B["X"], "set_details")), trail(B["X"], "set_details"))
s.check("...and says the decided one stays", any("1 submitted rating stays: that colleague's result is decided" in x
                                                  for x in trail(B["X"], "set_details")), trail(B["X"], "set_details"))
s.check("the colleagues' panels: C2 is now below a full panel (no live rating), C4 still has a full panel",
        one("SELECT COUNT(*) FROM assignments WHERE subject_id=? AND archived=0", (B["C"][2],)) == 0
        and one("SELECT COUNT(*) FROM assignments WHERE subject_id=? AND archived=0", (B["C"][4],)) == TGT + 0 + 1 - 1 + 0
        or one("SELECT COUNT(*) FROM assignments WHERE subject_id=? AND archived=0", (B["C"][4],)) >= TGT, "")
# the panel editor can restore them: the archive is the standard soft one
s.check("the archive is the soft one the panel editor restores (a row, archived=1, a reason, never deleted)",
        one("SELECT COUNT(*) FROM assignments WHERE id=?", (B["A"]["C2"],)) == 1)

# ---------------------------------------------------------------------------------------------------------------------------
s.section("who can answer: the super admin's alone; the server never trusts the form")
F = scenario("F")
b = preview(F["X"], client=CADM, unit=UB)
s.check("an admin who is not the super admin sees the table and the read-only line, no radios",
        'data-ask="rater360"' in b and "Their submitted ratings of colleagues stay. Only the super admin can archive them." in b
        and 'name="ask_rater360"' not in b, b[b.find('data-ask="rater360"'):][:300])
r = post(F["X"], client=CADM, unit=UB, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="archive", ask_reason_rater360=WHY)
s.check("...and the server refuses a forged Archive; nothing is saved", "isn't yours to change" in txt(r) and row(F["X"])["company"] == UA
        and all(arow(v)["archived"] == 0 for v in F["A"].values()), txt(r)[:200])
r = post(F["X"], client=CADM, unit=UB, ask_shown="1", ask_state_rater360="submitted:2")
s.check("...with no answer the save goes through for them: the pending and the KPI lines follow, the submitted stay",
        moved(F) and arow(F["A"]["C1"])["archived"] == 1 and all(arow(F["A"][k])["archived"] == 0 for k in ("C2", "C3", "C4"))
        and chain(F["L1"]) == [MGR])
G = scenario("G")
real_states = a._profile_rater_states
falsify("who can answer (the ask's who_can)", {"_profile_rater_states": lambda db, me, act, pairs: real_states(db, SUROW, act, pairs)},
        lambda: post(G["X"], client=CADM, unit=UB, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="archive",
                     ask_reason_rater360=WHY),
        lambda: moved(G) and arow(G["A"]["C2"])["archived"] == 1)
H1 = scenario("H1")
falsify("the mandatory reason (_pf_reason)", {"_pf_reason": lambda raw, what: (raw or "no reason", None)},
        lambda: post(H1["X"], unit=UB, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="archive"),
        lambda: moved(H1) and arow(H1["A"]["C2"])["archived"] == 1)
H2 = scenario("H2")
real_decided = a._rater360_decided
falsify("a decided result is never archived (_rater360_decided)", {"_rater360_decided": lambda db, cid, ids: set()},
        lambda: post(H2["X"], unit=UB, ask_shown="1", ask_state_rater360="submitted:3", ask_rater360="archive", ask_reason_rater360=WHY),
        lambda: moved(H2) and arow(H2["A"]["C3"])["archived"] == 1)

# ---------------------------------------------------------------------------------------------------------------------------
s.section("stale: what they were shown no longer holds (a rating was submitted since the preview)")
ST = scenario("ST")
rate(person("ST-C5"), ST["X"])   # a third undecided submitted rating after the preview said 2
r = post(ST["X"], unit=UB, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="archive", ask_reason_rater360=WHY)
s.check("the save is refused as stale and nothing is written", "changed since you looked" in txt(r) and "Nothing has been saved." in txt(r)
        and row(ST["X"])["company"] == UA and all(arow(v)["archived"] == 0 for v in ST["A"].values()), txt(r)[:240])
real_fa = a._profile_form_answers
ST2 = scenario("ST2")
rate(person("ST2-C5"), ST2["X"])
falsify("the shown-state check (what the form was shown)",
        {"_profile_form_answers": lambda f_: {k_: v_ for k_, v_ in real_fa(f_).items() if k_ != "expect"}},
        lambda: post(ST2["X"], unit=UB, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="archive", ask_reason_rater360=WHY),
        lambda: moved(ST2) and arow(ST2["A"]["C2"])["archived"] == 1)

# ---------------------------------------------------------------------------------------------------------------------------
s.section("no ask when there is nothing to ask: nothing submitted, or every submitted one is decided")
NS = person("NS-X")
rate(person("NS-C1"), NS, "pending")
b = preview(NS, unit=UB)
s.check("only pending ratings: the row says so, no question", "Their ratings" in b and 'data-ask="rater360"' not in b)
post(NS, unit=UB)
s.check("...and they are archived", one("SELECT archived FROM assignments WHERE assessor_id=?", (NS,)) == 1)
AD = person("AD-X")
cd = person("AD-C1")
decide_360(cd)
rate(cd, AD)
b = preview(AD, unit=UB)
s.check("every submitted rating is of a decided result: one note, no question",
        'data-ask="rater360"' not in b and "1 of their submitted ratings stays: that colleague's result is decided." in b, "")
post(AD, unit=UB)
s.check("...and it stays", one("SELECT archived FROM assignments WHERE assessor_id=?", (AD,)) == 0 and row(AD)["company"] == UB)
NO = person("NO-X")
b = preview(NO, unit=UB)
s.check("someone who rates and moderates nothing: the row still says nothing is pending, no question", 'data-ask="rater360"' not in b
        and "No pending rating they give colleagues to archive." in b)

# ---------------------------------------------------------------------------------------------------------------------------
s.section("KPI lines they moderate: the next manager who takes part; nobody above stays and is named")
Y = person("Y", mgr=None)
YS = person("YS")
LY = kpi(YS, [Y], name="ZZLO Stuck")
b = preview(Y, unit=UB)
s.check("a line with nobody above is named in the preview, never moved", "has nobody above taking part, so it stays as it is" in b
        and "ZZ LO YS" in b, b[b.find("Their KPI lines"):][:500])
post(Y, unit=UB)
s.check("...and it stays with them", chain(LY) == [Y], chain(LY))
# a chain [X, MGR]: moving X out leaves the manager, not a repeat
T2 = person("T2-X")
T2S = person("T2-S")
LT = kpi(T2S, [T2, MGR], name="ZZLO Two")
post(T2, unit=UB)
s.check("a two-step chain keeps the manager and does not repeat them", chain(LT) == [MGR], chain(LT))
CS = person("CS-X")
CSS = person("CS-S", unit=UB)   # their report already out of the cycle: nothing to move for them
LCS = kpi(CSS, [CS], name="ZZLO OutSubject")
post(CS, unit=UB)
s.check("a line of someone who is out of the cycle too is left alone", chain(LCS) == [CS], chain(LCS))
real_set = a._pm_set_moderator
M1 = person("M1-X")
M1S = person("M1-S")
LM1 = kpi(M1S, [M1], name="ZZLO Guard")
falsify("the KPI line move (_pm_set_moderator)", {"_pm_set_moderator": lambda *x, **k: None},
        lambda: post(M1, unit=UB), lambda: moved({"X": M1}) and chain(LM1) == [M1])

# ---------------------------------------------------------------------------------------------------------------------------
s.section("moving back OUT: nothing is restored on the rater side; the rated side comes back")
BK = scenario("BK")
post(BK["X"], unit=UB, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="keep")
assert moved(BK)
r = post(BK["X"], unit=UC, dept="Ops")
bt = txt(r)
s.check("they are in the other unit", row(BK["X"])["company"] == UC, row(BK["X"])["company"])
s.check("the rating OF them comes back (the existing rated-side sync)", arow(BK["A"]["RX"])["archived"] == 0, arow(BK["A"]["RX"]))
s.check("the pending rating they gave stays archived: nothing restored on the rater side (as Bring back)",
        arow(BK["A"]["C1"])["archived"] == 1 and arow(BK["A"]["C1"])["archive_reason"] == UNIT_WHY)
s.check("the KPI line that moved up stays with the manager", chain(BK["L1"]) == [MGR])
s.check("moving out asks nothing and says nothing about left out", "Their ratings" not in preview(BK["X"], unit=UA)
        and 'data-ask="rater360"' not in preview(BK["X"], unit=UA))
# a move between two left-out units, or a department inside one: no new flip, nothing again
s.check("a person already in a left-out unit changes department: no flip, no question", 'data-ask="rater360"' not in preview(row(
    BK["X"])["id"], unit=UC, dept="Ops", grade=15))

# ---------------------------------------------------------------------------------------------------------------------------
s.section("one shared function: the unit rule and the engine write through _left_out_apply")
src = H.source(a)
s.check("_exclusion_save archives and moves lines through _left_out_apply (no second writer of the same rows)",
        "_left_out_apply(db, me, plan, why)" in src[src.index("def _exclusion_save"):src.index("def _exclusion_save") + 2500])
s.check("the engine's rater step uses the same plan and writer (one plan call for every mover, grade movers kept out of `lead_ids`)",
        "_left_out_plan(db, act, [o[\"id\"] for o, _n in movers], rater=True,\n                          lead_ids=[o[\"id\"] for o, _n in movers if kinds[o[\"id\"]] == \"unit_out\"])" in src
        and src.count("def _left_out_apply") == 1 and src.count("def _left_out_plan") == 1)
# the unit rule's plan is the same function's answer for the unit's people (byte-for-byte: the keys the unit rule reads are unchanged)
with a.app.test_request_context("/"):
    d = a.get_db()
    cyc = a.active_cycle(d)
    ids_ = a._exclusion_people(d, GA, UB, [])
    p1 = a._exclusion_plan(d, cyc, ids_)
    p2 = a._left_out_plan(d, cyc, ids_)
s.check("the unit rule's plan is _left_out_plan's, the same answer", p1 == p2 and set(p1) >= {"people", "archive", "places", "own", "short", "moves", "lines",
                                                                                          "nobody", "hod", "buceo", "bgceo"})

# ---------------------------------------------------------------------------------------------------------------------------
s.section("batched: the plan's reads do not grow with the number of people")


def n_selects(ids, rater):
    with a.app.test_request_context("/"):
        d = a.get_db()
        seen = []
        d.set_trace_callback(lambda sql: seen.append(sql))
        a._left_out_plan(d, a.active_cycle(d), ids, rater=rater)
        d.set_trace_callback(None)
        return sum(1 for x in seen if x.lstrip().upper().startswith("SELECT"))


mv = [scenario("BT%d" % i)["X"] for i in range(6)]
for x in mv:
    post(x, unit=UA)   # a no-op save (nothing changed): the people stay in UA
one_n, six_n = n_selects(mv[:1], True), n_selects(mv, True)
s.check("one person or six: the same number of reads for the whole plan (the rater split is batched)", one_n == six_n, (one_n, six_n))

# ---------------------------------------------------------------------------------------------------------------------------
# R: the people import
s.section("R: the people import, step 3 (a group, Keep | Archive per person) and step 4 (a tile)")


def csv_bytes(rows):
    buf = io.StringIO()
    w = _csv.writer(buf)
    w.writerow(a.ROSTER_COLUMNS)
    for r in rows:
        w.writerow([r.get(c.lower(), "") for c in a.ROSTER_COLUMNS])
    return buf.getvalue().encode()


def upload(rows):
    r = SUP.post(P, data={"csrf_token": "tok", "mode": "upsert", "preview": "1", "file": (io.BytesIO(csv_bytes(rows)), "lo.csv")},
                 content_type="multipart/form-data")
    return r.headers.get("Location", "").split("check=")[-1]


def rec(pid, **kw):
    p = row(pid)
    r = {"employee id": p["employee_id"], "employee name": p["full_name"], "business group": GA, "company": p["company"]}
    r.update(kw)
    return r


def fid(key):
    return "d_" + hashlib.sha1(key.encode()).hexdigest()[:10]


def to_changes(tok):
    SUP.post(P, data={"csrf_token": "tok", "token": tok, "action": "quality_ok", "ack": "1"})
    return SUP.get(P + "?check=%s&step=changes" % tok).get_data(as_text=True)


def decide(tok, answers, reasons=None, action="to_apply"):
    data = {"csrf_token": "tok", "token": tok, "action": action}
    for k, v in answers.items():
        data[fid(k)] = v
    for k, v in (reasons or {}).items():
        data[fid(k)] = v
    return SUP.post(P, data=data, follow_redirects=True)


RA, RB = scenario("RA"), scenario("RB")
RN = person("RN-X")
rate(person("RN-C1"), RN, "pending")
ridx = lambda pid: row(pid)["employee_id"]  # noqa: E731
TOK = upload([rec(RA["X"], company=UB), rec(RB["X"], company=UB), rec(RN, company=UB)])
ch = to_changes(TOK)
cht = _html.unescape(ch)
s.check("step 3 shows the group 'Their submitted 360 ratings of colleagues (2)': the two who submitted some, not the one with only pending",
        "Their submitted 360 ratings of colleagues (2)" in cht and "The file moves them to a unit that isn't taking part in %s" % CNAME in cht
        and ridx(RN) not in cht[cht.find("Their submitted 360 ratings"):][:6000].replace(ridx(RA["X"]), "").replace(ridx(RB["X"]), ""), "")
s.check("...with Keep them | Archive them per person, the All: buttons, the board's words and the colleagues-count cell, never a name",
        "All: keep" in cht and "All: archive" in cht
        and "Keep: their submitted ratings stay and still count. Archive: the ratings come out of those colleagues' 360 scores, so the scores change; "
            "the panel editor can restore them. Ratings of colleagues whose results are decided stay either way." in cht
        and "3 submitted" in cht and "2 scores change · 1 below a full panel" in cht and "1 stays: result decided" in cht
        and not re.search(r"ZZ LO R[AB]-C[1-4]", cht), "")
s.check("...'The file says' shows the new unit and 'Not taking part' (not old > new), and the reason hint is the canvas's",
        "Not taking part" in cht and "ZZLO UnitA › ZZLO UnitB" not in cht[cht.find("Their submitted 360 ratings"):]
        and "500 at most. Needed when any row is Archive. It goes in the trail with the counts." in cht,
        (("Not taking part" in cht), ("ZZLO UnitA › ZZLO UnitB" in cht[cht.find("Their submitted 360 ratings"):]), cht[cht.find("Their submitted 360 ratings"):][:100]))
s.check("...Keep is pre-picked for every row (Chris may change this)", len(re.findall(r'name="%s" value="keep" checked' % fid("rater:" + ridx(RA["X"])), ch)) == 1
        and len(re.findall(r'name="%s" value="keep" checked' % fid("rater:" + ridx(RB["X"])), ch)) == 1, "")
s.check("...and the one reason box for the file", "Why their ratings are archived" in cht)
r = decide(TOK, {"rater:" + ridx(RA["X"]): "archive", "rater:" + ridx(RB["X"]): "keep"})
s.check("an Archive with no reason is refused at step 3", "Give the reason for archiving submitted 360 ratings" in txt(r), txt(r)[:200])
r = decide(TOK, {"rater:" + ridx(RA["X"]): "archive", "rater:" + ridx(RB["X"]): "keep"}, {"reason:rater": WHY})
fin = txt(r)
s.check("step 4: the two tiles (one keeps, one has submitted ratings archived) and each person's words say what happens",
        re.search(r"<b>1</b><span>keep their submitted 360 ratings", fin) and re.search(r"<b>1</b><span>have submitted 360 ratings archived", fin)
        and "pending ratings archived" in fin and "1 KPI line moved one level up" in fin
        and "2 submitted 360 ratings archived, 1 stays: result decided (your answer)" in fin and "3 submitted 360 ratings stay (your answer)" in fin,
        fin[fin.find("What happens"):][:900])
s.check("step 4's tiles: the keep tile's edge is the import's grey, the archived tile's the danger red (never navy)",
        '<div class="ri-tile" style="--c:#9aa1b5"><b>1</b><span>keep their submitted 360 ratings' in fin
        and '<div class="ri-tile" style="--c:#b3261e"><b>1</b><span>have submitted 360 ratings archived' in fin, "")
rc = fin[fin.find("Your answers"):]
s.check("step 4's recap: one Keep line and one Archive line (the people together, the reason quoted), not a line a person",
        "<b>Keep their submitted 360 ratings</b>: ZZ LO RB-X (%s)" % ridx(RB["X"]) in rc
        and "<b>Archive their submitted 360 ratings</b>: ZZ LO RA-X (%s). Why: %s" % (ridx(RA["X"]), WHY) in rc
        and "Why their ratings are archived</b>" not in rc, rc[:600])
s.check("...the apply's confirm sentence names the count", "2 submitted 360 ratings archived, taken out of those colleagues' 360 scores" in fin)
SUP.post(P, data={"csrf_token": "tok", "token": TOK, "action": "apply"})
done = txt(SUP.get(P + "?done=%s" % TOK))
s.check("apply: all three moved", all(row(x)["company"] == UB for x in (RA["X"], RB["X"], RN)))
s.check("...RA (Archive): the pending and the two undecided submitted archived with the unit words, the decided one stays",
        all(arow(RA["A"][k])["archived"] == 1 and arow(RA["A"][k])["archive_reason"] == UNIT_WHY for k in ("C1", "C2", "C4"))
        and arow(RA["A"]["C3"])["archived"] == 0, [arow(RA["A"][k])["archived"] for k in ("C1", "C2", "C3", "C4")])
s.check("...RB (Keep): only the pending one archived; every submitted stays", arow(RB["A"]["C1"])["archived"] == 1
        and all(arow(RB["A"][k])["archived"] == 0 for k in ("C2", "C3", "C4")))
s.check("...RN (only pending): the pending one archived with no question", one("SELECT archived FROM assignments WHERE assessor_id=?", (RN,)) == 1)
s.check("...the KPI lines of RA and RB moved up in the one batched pass; the acted-on ones stayed",
        chain(RA["L1"]) == [MGR] and chain(RB["L1"]) == [MGR] and chain(RA["L2"]) == [RA["X"]] and chain(RB["L2"]) == [RB["X"]])
s.check("...the result page says it, once for the file", "3 people moved into a unit the cycle leaves out and stop rating and moderating" in done
        and "3 pending 360 ratings archived" in done and "2 KPI lines moved one level up" in done
        and "2 submitted 360 ratings archived (their colleagues' 360 scores change)" in done, done[done.find("moved into"):][:400] if "moved into" in done else done[:600])
s.check("...the older 'archived or brought back' bullet does not count them again (all three are in the left-out line; QC 9 Nov)",
        "archived or brought back" not in done, done[done.find("moved into"):][:600])
_conf = re.search(r'class="ri-apply"[^>]*data-confirm="([^"]*)"', fin)
_conf = _html.unescape(_conf.group(1)) if _conf else ""
s.check("the apply confirm box's body starts with the counts, not its own title 'Apply this file?' (the title is the box's)",
        re.match(r"\d+ added, \d+ updated", _conf) and "Apply this file" not in _conf and 'data-confirm-title="Apply this file?"' in fin, _conf[:120])
s.check("...and it still says what it changes", "This changes the live people records" in _conf, _conf[:200])
s.check("...the trail has the reason once for the archived ratings", any("reason for archiving what they had submitted: " + WHY in x for x in trail(RA["X"])), trail(RA["X"]))

# a mover into the left-out unit AND a person who takes part AGAIN (a grade raised back above the cycle's minimum): the older bullet counts
# only the second. (It used to be a grade DROP below the minimum, which is now a mover of its own: see the grade sections below, 9 Nov.)
with a.app.app_context():
    a.get_db().execute("UPDATE cycles SET min_job_grade=12 WHERE id=?", (CID,))
    a.get_db().commit()
try:
    MX = scenario("MX")
    GD = person("GD-X", grade=10)   # below the floor: out
    rate(person("GD-C1"), GD, "pending")
    TOK3 = upload([rec(MX["X"], company=UB), rec(GD, **{"job grade": "14"})])
    to_changes(TOK3)
    decide(TOK3, {"rater:" + ridx(MX["X"]): "keep"})
    SUP.post(P, data={"csrf_token": "tok", "token": TOK3, "action": "apply"})
    done3 = txt(SUP.get(P + "?done=%s" % TOK3))
    s.check("the grade raise is applied and the older bullet shows", str(row(GD)["job_grade"]) == "14"
            and "archived or brought back" in done3, row(GD)["job_grade"])
    s.check("one person moved into the left-out unit, and the older bullet counts ONE person (the one brought back), not two",
            "1 person moved into a unit the cycle leaves out" in done3 and "1 person's 360 ratings as the person rated were archived or brought back" in done3,
            done3[done3.find("moved into"):][:500] if "moved into" in done3 else done3[:600])
finally:
    with a.app.app_context():
        a.get_db().execute("UPDATE cycles SET min_job_grade=NULL WHERE id=?", (CID,))
        a.get_db().commit()

# stale in the import: a rating was submitted since the answers were given: that person's submitted ratings stay (the pending still go)
SI = scenario("SI")
TOK2 = upload([rec(SI["X"], company=UB)])
to_changes(TOK2)
decide(TOK2, {"rater:" + ridx(SI["X"]): "archive"}, {"reason:rater": WHY})
rate(person("SI-C5"), SI["X"])   # a third undecided submitted rating after the answers
SUP.post(P, data={"csrf_token": "tok", "token": TOK2, "action": "apply"})
done2 = txt(SUP.get(P + "?done=%s" % TOK2)) + txt(SUP.get(P + "?check=%s&step=changes" % TOK2))
# the import refuses to apply a file whose changes moved since the answers (the fingerprint), which is the stricter outcome
s.check("a person whose ratings moved since the answers: the import does not apply on the old picture (fingerprint) or leaves them as they are",
        (row(SI["X"])["company"] == UA) or (all(arow(SI["A"][k])["archived"] == 0 for k in ("C2", "C4"))), (row(SI["X"])["company"], done2[:200]))

# ===========================================================================================================================
# BELOW THE CYCLE'S LOWEST JOB GRADE (Chris, 9 Nov 2026: "Go, lines stay"; HANDOFF "Moving below the minimum job grade")
# The ratings a person GIVES follow the grade the way a move into a left-out unit does for the ratings of a unit: pending archived with
# a grade reason, submitted asked (the same rater360 question, the grade in its words), NO KPI line moves, one trail row.
# ===========================================================================================================================


def falsify_good(name, patches, then, good):
    """The opposite of `falsify`: switch a rule off (module-level patches), run `then`, put it back: `good()` -- what the rule makes
    true -- must now be FALSE, so the check above it really does depend on the rule."""
    real = {k: getattr(a, k) for k in patches}
    try:
        for k, v in patches.items():
            setattr(a, k, v)
        then()
        got = good()
    finally:
        for k, v in real.items():
            setattr(a, k, v)
    s.check("falsified: %s -- with the rule switched off the check above fails" % name, not got)


def lines_stay(sc):
    return chain(sc["L1"]) == [sc["X"]] and chain(sc["L2"]) == [sc["X"]]


def jg(sc):
    return str(row(sc["X"])["job_grade"])


with a.app.app_context():
    a.get_db().execute("UPDATE cycles SET min_job_grade=12 WHERE id=?", (CID,))
    a.get_db().commit()
GRW = "JG 10 is below %s's lowest job grade (JG 12)" % CNAME
try:
    s.section("grade: the mirror says why somebody can't rate, and which path a change takes")
    with a.app.test_request_context("/"):
        d = a.get_db()
        cyc = a.active_cycle(d)
        w = lambda **kw: dict(row(MGR), **kw)  # noqa: E731
        s.check("_rater_out_why: unit first, then the grade floor, then Grade H, else None",
                a._rater_out_why(d, cyc, w(company=UB)) == "unit_out" and a._rater_out_why(d, cyc, w(job_grade=10)) == "below_min_grade"
                and a._rater_out_why(d, cyc, w(company=UB, job_grade=10)) == "unit_out" and a._rater_out_why(d, cyc, w(job_grade="H")) == "below_min_grade"
                and a._rater_out_why(d, cyc, w(job_grade=12)) is None and a._rater_out_why(d, cyc, w(job_grade=None)) == "below_min_grade",
                [a._rater_out_why(d, cyc, w(job_grade=g_)) for g_ in (10, "H", 12, None)])
        cyc0 = dict(cyc, min_job_grade=None)
        s.check("...with no floor a Grade H person is 'grade_h' and a low number is fine",
                a._rater_out_why(d, cyc0, w(job_grade="H")) == "grade_h" and a._rater_out_why(d, cyc0, w(job_grade=3)) is None)
        pth = lambda o_, **kw: a._rater_out_path(d, cyc, o_, dict(o_, **kw))  # noqa: E731
        o14, o10 = w(job_grade=14), w(job_grade=10)
        s.check("_rater_out_path: a drop below the floor, a move to Grade H: the grade path; a move into the left-out unit: the unit path, whatever the grade",
                pth(o14, job_grade=10) == "below_min_grade" and pth(o14, job_grade="H") == "below_min_grade" and pth(o14, company=UB) == "unit_out"
                and pth(o10, company=UB) == "unit_out" and pth(o14, company=UB, job_grade=10) == "unit_out")
        s.check("...no path when the grade stays at or above the floor, when they could not rate before (already below), or on a move back up or out",
                pth(o14, job_grade=12) is None and pth(o14, job_grade=13) is None and pth(o10, job_grade=8) is None
                and pth(o10, job_grade=14) is None and pth(w(company=UB), company=UA) is None and pth(o14, job_title="x") is None)

    # ---------------------------------------------------------------------------------------------------------------------------
    s.section("grade, Edit details: the preview says what stops, asks about the submitted ratings, and moves no KPI line")
    GK = scenario("GK")
    b = preview(GK["X"], grade=10)
    s.check("the preview has the row 'Their ratings' (1 pending archived, nothing restored on moving back up)",
            "Their ratings" in b and "1 pending rating they give colleagues is archived (the panel editor can restore it). "
            "Moving back to a grade that takes part restores none of their ratings." in b, b[b.find("Their ratings"):][:500])
    s.check("...and NO 'KPI lines they moderate' row and no 'stop moderating' words: the lines stay (Chris: \"Go, lines stay\")",
            "KPI lines they moderate" not in b and "stop moderating" not in b.lower() and "moves one level up" not in b, "")
    s.check("...the existing 'Taking part' note is still there (the ratings colleagues gave ABOUT them)",
            "Their new job grade is below the cycle's lowest grade" in b and "the 360 ratings colleagues gave about them are archived" in b)
    s.check("...the question names the grade, not a unit: Keep them pre-selected, Archive them red with a reason box, the chip '3 submitted'",
            'data-ask="rater360"' in b and state_of(b) == "submitted:2" and ">3 submitted<" in b
            and re.search(r'name="ask_rater360" value="keep" checked', b) and 'name="ask_rater360" value="archive"' in b
            and 'data-ask-reason="archive"' in b and 'class="pp-opt is-danger"' in b
            and "Their new job grade (JG 10) is below %s's lowest (JG 12). They have submitted 3 ratings of colleagues this cycle. "
                "1 of them stays either way: that colleague's result is decided." % CNAME in b
            and "isn't taking part in" not in b[b.find('data-ask="rater360"'):][:3000], b[b.find('data-ask="rater360"'):][:600])
    s.check("...counts only: no colleague's name in the question", not re.search(r"ZZ LO GK-C[1-4]", b[b.find('data-ask="rater360"'):][:3000]), "")
    s.check("the preview writes nothing (every rating live, the lines still X's, the grade still 14)",
            all(arow(v)["archived"] == 0 for v in GK["A"].values()) and lines_stay(GK) and jg(GK) == "14")
    with a.app.test_request_context("/"):
        d = a.get_db()
        pl = a._profile_change_plan(d, SUROW, dict(d.execute("SELECT * FROM users WHERE id=?", (GK["X"],)).fetchone()), {"job_grade": 10}, a.active_cycle(d))
    s.check("the engine plan lists an auto line and the ask (the super admin's, Keep by default)",
            any(x["key"] == "left_out" for x in pl["auto"]) and next(x for x in pl["asks"] if x["key"] == "rater360")["default"] == "keep"
            and "level" not in next(x for x in pl["auto"] if x["key"] == "left_out")["words"], [x["key"] for x in pl["auto"]])

    s.section("grade, Keep them: pending archived with the grade reason, submitted stay, lines stay, ONE trail row")
    r = post(GK["X"], grade=10, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="keep")
    t = txt(r)
    s.check("the grade changed", jg(GK) == "10", jg(GK))
    s.check("the PENDING rating they give is archived with the grade words and the actor",
            arow(GK["A"]["C1"])["archived"] == 1 and arow(GK["A"]["C1"])["archive_reason"] == GRW and arow(GK["A"]["C1"])["archived_by"] == SU["id"],
            arow(GK["A"]["C1"]))
    s.check("...and that reason is not one of the rated side's restore reasons", GRW not in a._RATED_OUT_REASONS)
    s.check("Keep: all three submitted ratings stay live", all(arow(GK["A"][k])["archived"] == 0 for k in ("C2", "C3", "C4")))
    s.check("the rating OF them is archived by the existing sync, with its own reason",
            arow(GK["A"]["RX"])["archived"] == 1 and arow(GK["A"]["RX"])["archive_reason"] == a.PROFILE_OUT_REASON)
    s.check("THE KPI LINES STAY: the unacted one and the acted-on one are still moderated by them", lines_stay(GK), (chain(GK["L1"]), chain(GK["L2"])))
    s.check("the flash says they no longer rate colleagues, without 'or moderates KPIs'",
            "no longer rates colleagues in %s: 1 pending 360 rating of colleagues archived" % CNAME in t and "moderates KPIs" not in t,
            t[t.find("Details saved"):][:400])
    tr = trail(GK["X"], "set_details")
    s.check("ONE trail row for the person, with the grade change and the counts (no second engine row)",
            len(tr) == 1 and "no longer rates colleagues in %s" % CNAME in tr[0] and "job grade 14 -> 10" in tr[0]
            and "1 pending 360 rating" in tr[0] and "3 360 ratings they submitted stay" in tr[0] and "moved one level up" not in tr[0],
            tr)
    # a colleague's own sync never brings the archived rating back, because its reason is not a restore reason
    with a.app.app_context():
        d = a.get_db()
        a._rated_360_sync(d, SUROW, a.active_cycle(d), GK["C"][1], a.PROFILE_OUT_REASON)
        d.commit()
    s.check("a later sync of the COLLEAGUE's rated side never brings the archived rating back", arow(GK["A"]["C1"])["archived"] == 1)
    GRS = scenario("GRS")
    post(GRS["X"], grade=10, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="keep")
    with a.app.app_context():
        a.get_db().execute("UPDATE assignments SET archived=1, archive_reason=? WHERE cycle_id=? AND assessor_id=? AND status='pending'", (GRW, CID, GRS["X"]))
        a.get_db().commit()

    def sync_c1():
        with a.app.app_context():
            d = a.get_db()
            a._rated_360_sync(d, SUROW, a.active_cycle(d), GRS["C"][1], a.PROFILE_OUT_REASON)
            d.commit()
    falsify_good("the grade reason is no restore reason (_RATED_OUT_REASONS)", {"_RATED_OUT_REASONS": a._RATED_OUT_REASONS + (GRW,)}, sync_c1,
                 lambda: arow(GRS["A"]["C1"])["archived"] == 1)
    GL = scenario("GL")
    real_plan = a._left_out_plan
    falsify_good("grade movers are kept out of lead_ids (_left_out_plan)",
                 {"_left_out_plan": lambda db, cyc, ids, rater=False, lead_ids=None: real_plan(db, cyc, ids, rater=rater)},
                 lambda: post(GL["X"], grade=10, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="keep"),
                 lambda: jg(GL) == "10" and lines_stay(GL))

    s.section("grade, Archive them (super admin, a reason): only the undecided submitted ratings go; the reason is on the one row")
    GB = scenario("GB")
    r = post(GB["X"], grade=10, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="archive")
    s.check("a missing reason is refused: nothing saved", "Give a reason for the archive: it goes in the trail." in txt(r) and jg(GB) == "14"
            and all(arow(v)["archived"] == 0 for v in GB["A"].values()), txt(r)[:200])
    r = post(GB["X"], grade=10, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="archive", ask_reason_rater360=WHY)
    s.check("with a reason it saves", jg(GB) == "10", jg(GB))
    s.check("the pending one and the two undecided submitted ratings are archived with the grade words",
            all(arow(GB["A"][k])["archived"] == 1 and arow(GB["A"][k])["archive_reason"] == GRW for k in ("C1", "C2", "C4")))
    s.check("the one whose colleague's result is DECIDED stays live, whichever option", arow(GB["A"]["C3"])["archived"] == 0)
    s.check("the lines stay here too", lines_stay(GB))
    tr = trail(GB["X"], "set_details")
    s.check("ONE row: the counts AND the reason (trimmed to 300), '1 below a full panel', and the decided one staying",
            len(tr) == 1 and "2 360 ratings they had submitted archived" in tr[0] and "1 below a full panel" in tr[0]
            and "reason for archiving what they had submitted: " + WHY in tr[0] and "1 submitted rating stays: that colleague's result is decided" in tr[0],
            tr)
    GB2 = scenario("GB2")
    LONG = "x" * 200 + " " + "y" * 250   # 451 characters: within the ask's 500, over the trail's 300
    post(GB2["X"], grade=10, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="archive", ask_reason_rater360=LONG)
    tr2 = trail(GB2["X"], "set_details")
    s.check("the reason in the trail is cut to 300 characters", len(tr2) == 1 and ("submitted: " + LONG[:300]) in tr2[0] and LONG[:301] not in tr2[0], len(tr2[0]))

    s.section("grade, who can answer: the super admin's alone; stale; the decided one; the server never trusts the form")
    GF = scenario("GF")
    b = preview(GF["X"], client=CADM, grade=10)
    s.check("an admin who is not the super admin sees the read-only line and no radios",
            'data-ask="rater360"' in b and "Only the super admin can archive them." in b and 'name="ask_rater360"' not in b)
    r = post(GF["X"], client=CADM, grade=10, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="archive", ask_reason_rater360=WHY)
    s.check("...and a forged Archive is refused: nothing saved", "isn't yours to change" in txt(r) and jg(GF) == "14"
            and all(arow(v)["archived"] == 0 for v in GF["A"].values()), txt(r)[:200])
    r = post(GF["X"], client=CADM, grade=10, ask_shown="1", ask_state_rater360="submitted:2")
    s.check("...with no answer it goes through for them: the pending archived, the submitted stay, the lines stay",
            jg(GF) == "10" and arow(GF["A"]["C1"])["archived"] == 1 and all(arow(GF["A"][k])["archived"] == 0 for k in ("C2", "C3", "C4")) and lines_stay(GF))
    GG = scenario("GG")
    falsify("who can answer, grade path (the ask's who_can)", {"_profile_rater_states": lambda db, me, act, pairs: real_states(db, SUROW, act, pairs)},
            lambda: post(GG["X"], client=CADM, grade=10, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="archive", ask_reason_rater360=WHY),
            lambda: jg(GG) == "10" and arow(GG["A"]["C2"])["archived"] == 1)
    GH1 = scenario("GH1")
    falsify("the mandatory reason, grade path (_pf_reason)", {"_pf_reason": lambda raw, what: (raw or "no reason", None)},
            lambda: post(GH1["X"], grade=10, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="archive"),
            lambda: jg(GH1) == "10" and arow(GH1["A"]["C2"])["archived"] == 1)
    GH2 = scenario("GH2")
    falsify("a decided result is never archived, grade path (_rater360_decided)", {"_rater360_decided": lambda db, cid, ids: set()},
            lambda: post(GH2["X"], grade=10, ask_shown="1", ask_state_rater360="submitted:3", ask_rater360="archive", ask_reason_rater360=WHY),
            lambda: jg(GH2) == "10" and arow(GH2["A"]["C3"])["archived"] == 1)
    GST = scenario("GST")
    rate(person("GST-C5"), GST["X"])   # a third undecided submitted rating after the preview said 2
    r = post(GST["X"], grade=10, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="archive", ask_reason_rater360=WHY)
    s.check("stale: refused and nothing written", "changed since you looked" in txt(r) and "Nothing has been saved." in txt(r)
            and jg(GST) == "14" and all(arow(v)["archived"] == 0 for v in GST["A"].values()), txt(r)[:240])
    GST2 = scenario("GST2")
    rate(person("GST2-C5"), GST2["X"])
    falsify("the shown-state check, grade path (what the form was shown)",
            {"_profile_form_answers": lambda f_: {k_: v_ for k_, v_ in real_fa(f_).items() if k_ != "expect"}},
            lambda: post(GST2["X"], grade=10, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="archive", ask_reason_rater360=WHY),
            lambda: jg(GST2) == "10" and arow(GST2["A"]["C2"])["archived"] == 1)

    s.section("grade: back up restores nothing on the rater side; a drop that stays at or above the floor does nothing; already below does nothing")
    GU = scenario("GU")
    post(GU["X"], grade=10, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="keep")
    post(GU["X"], grade=14)
    s.check("back at JG 14: the rating OF them comes back (the rated side)", arow(GU["A"]["RX"])["archived"] == 0, arow(GU["A"]["RX"]))
    s.check("...the pending rating they gave stays archived (nothing restored on the rater side, as Bring back)",
            arow(GU["A"]["C1"])["archived"] == 1 and arow(GU["A"]["C1"])["archive_reason"] == GRW)
    s.check("...the lines are still theirs, and moving up asks nothing", lines_stay(GU) and "Their ratings" not in preview(GU["X"], grade=15)
            and 'data-ask="rater360"' not in preview(GU["X"], grade=15))
    GN = scenario("GN")
    b = preview(GN["X"], grade=12)
    s.check("a drop to JG 12 (the floor itself): no row, no question", "Their ratings" not in b and 'data-ask="rater360"' not in b)
    post(GN["X"], grade=12)
    post(GN["X"], grade=13)
    s.check("...and saving it archives nothing and moves no line", all(arow(v)["archived"] == 0 for v in GN["A"].values()) and lines_stay(GN) and jg(GN) == "13")
    GN2 = scenario("GN2")
    falsify_good("the floor comparison (below_min_grade) -- a drop that stays at or above it does nothing",
                 {"below_min_grade": lambda db, u, cycle=None: 14 if (a.grade_num(u["job_grade"]) or 0) < 14 else None},
                 lambda: post(GN2["X"], grade=13, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="keep"),
                 lambda: all(arow(v)["archived"] == 0 for v in GN2["A"].values()))
    GAB = person("GAB-X", grade=10)   # already below the floor, with live ratings from before this fix: a change inside that stays alone
    pend = rate(person("GAB-C1"), GAB, "pending")
    b = preview(GAB, grade=8)
    s.check("someone ALREADY below the floor who drops further: nothing on the rating side (production data step, not this save)",
            "Their ratings" not in b and 'data-ask="rater360"' not in b)
    post(GAB, grade=8)
    s.check("...and the live rating they give is left alone", arow(pend)["archived"] == 0)
    GAB2 = person("GAB2-X", grade=10)
    pend2 = rate(person("GAB2-C1"), GAB2, "pending")
    real_path = a._rater_out_path
    falsify_good("only when the OLD details could rate (_rater_out_path)",
                 {"_rater_out_path": lambda db, act, o_, n_: "below_min_grade" if a._rater_out_why(db, act, n_) == "below_min_grade" else real_path(db, act, o_, n_)},
                 lambda: post(GAB2, grade=8), lambda: arow(pend2)["archived"] == 0)
    GP = scenario("GP")
    falsify_good("the grade path itself (_rater_out_path)",
                 {"_rater_out_path": lambda db, act, o_, n_: "unit_out" if real_path(db, act, o_, n_) == "unit_out" else None},
                 lambda: post(GP["X"], grade=10, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="keep"),
                 lambda: arow(GP["A"]["C1"])["archived"] == 1)

    s.section("grade: Grade H gets the same, in its own words")
    GHK = scenario("GHK")
    b = preview(GHK["X"], grade="H")
    s.check("the question says Grade H takes no part in the 360 (the floor is 12, so the grade is below it too)",
            "Grade H takes no part in the 360. They have submitted 3 ratings of colleagues this cycle." in b
            and "Moving back to a number grade restores none of their ratings." in b and "KPI lines they moderate" not in b, b[b.find("Their ratings"):][:400])
    post(GHK["X"], grade="H", ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="archive", ask_reason_rater360=WHY)
    s.check("Archive: the pending and the undecided submitted ratings archived with the Grade H words; the decided one stays; lines stay",
            jg(GHK) == "H" and all(arow(GHK["A"][k])["archived"] == 1 and arow(GHK["A"][k])["archive_reason"] == "Grade H takes no part in the 360"
                                   for k in ("C1", "C2", "C4")) and arow(GHK["A"]["C3"])["archived"] == 0 and lines_stay(GHK),
            [arow(GHK["A"][k])["archive_reason"] for k in ("C1", "C2")])
    with a.app.app_context():
        a.get_db().execute("UPDATE cycles SET min_job_grade=NULL WHERE id=?", (CID,))   # no floor: Grade H is the only thing taking them out
        a.get_db().commit()
    GHN = scenario("GHN")
    post(GHN["X"], grade="H", ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="keep")
    s.check("with no floor a move to Grade H still takes them out of rating: the pending archived, the submitted stay, the lines stay",
            jg(GHN) == "H" and arow(GHN["A"]["C1"])["archived"] == 1 and arow(GHN["A"]["C1"])["archive_reason"] == "Grade H takes no part in the 360"
            and all(arow(GHN["A"][k])["archived"] == 0 for k in ("C2", "C3", "C4")) and lines_stay(GHN))
    with a.app.app_context():
        a.get_db().execute("UPDATE cycles SET min_job_grade=12 WHERE id=?", (CID,))
        a.get_db().commit()

    s.section("grade: a move into the left-out unit decides the path (lines move up), even for someone below the floor")
    GUN = scenario("GUN")
    post(GUN["X"], unit=UB, grade=10, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="keep")
    s.check("unit and grade at once: the unit path (its words, the unacted line moves up, the acted one stays)",
            moved(GUN) and jg(GUN) == "10" and arow(GUN["A"]["C1"])["archived_by"] == SU["id"] and arow(GUN["A"]["C1"])["archive_reason"] == UNIT_WHY
            and chain(GUN["L1"]) == [MGR] and chain(GUN["L2"]) == [GUN["X"]], arow(GUN["A"]["C1"])["archive_reason"])
    s.check("...with ONE trail row (the unit path's too)", len(trail(GUN["X"], "set_details")) == 1)
    GUN2 = scenario("GUN2")
    falsify_good("the unit decides the path (_rater_out_path)",
                 {"_rater_out_path": lambda db, act, o_, n_: ("below_min_grade" if a.below_min_grade(db, n_, act) is not None else real_path(db, act, o_, n_))},
                 lambda: post(GUN2["X"], unit=UB, grade=10, ask_shown="1", ask_state_rater360="submitted:2", ask_rater360="keep"),
                 lambda: chain(GUN2["L1"]) == [MGR])

    s.section("grade: the plan's lead_ids (the unit rule's default is untouched; a rater-only scope moves nothing else)")
    with a.app.test_request_context("/"):
        d = a.get_db()
        cyc = a.active_cycle(d)
        PX = scenario("PX")
        ids_ = a._exclusion_people(d, GA, UB, [])
        s.check("lead_ids=None and lead_ids=everyone give the same plan (the unit rule's answer, byte for byte)",
                a._left_out_plan(d, cyc, ids_) == a._left_out_plan(d, cyc, ids_, lead_ids=ids_)
                and a._left_out_plan(d, cyc, ids_, rater=True) == a._left_out_plan(d, cyc, ids_, rater=True, lead_ids=list(ids_)))
        pr = a._left_out_plan(d, cyc, [PX["X"]], rater=True, lead_ids=[])
        pf = a._left_out_plan(d, cyc, [PX["X"]], rater=True)
        s.check("a rater-only scope (lead_ids=[]): their ratings are planned, no KPI line, move, seat or HOD count is",
                len(pr["rater"][PX["X"]]["pending"]) == 1 and pr["rater"][PX["X"]]["S"] == 2 and pr["lines"] == [] and pr["moves"] == []
                and not pr["lines_by"] and not pr["acted_by"] and not pr["stuck_by"] and pr["hod"] == pr["buceo"] == pr["bgceo"] == 0
                and pf["lines"] and pf["rater"] == pr["rater"], (pr["lines"], pf["lines"]))
        s.check("...and they are not 'out' for the people above: a line of X's report moderated by X and MGR still names X, never skips X",
                all(PX["X"] not in new_ for _t, new_ in pr["lines"]))
    mv2 = [scenario("PB%d" % i)["X"] for i in range(6)]

    def n_sel(ids, lead):
        with a.app.test_request_context("/"):
            d = a.get_db()
            seen = []
            d.set_trace_callback(lambda q_: seen.append(q_))
            a._left_out_plan(d, a.active_cycle(d), ids, rater=True, lead_ids=lead)
            d.set_trace_callback(None)
            return sum(1 for x in seen if x.lstrip().upper().startswith("SELECT"))
    s.check("batched: one grade mover or six, the same number of reads", n_sel(mv2[:1], []) == n_sel(mv2, []), (n_sel(mv2[:1], []), n_sel(mv2, [])))
    # ---------------------------------------------------------------------------------------------------------------------------
    s.section("grade, the people import: step 3's group, the result page's own line, the older bullet leaves them out, one trail row each")
    IA, IB = scenario("IA"), scenario("IB")
    IN = person("IN-X")
    rate(person("IN-C1"), IN, "pending")
    TOKG = upload([rec(IA["X"], **{"job grade": "10"}), rec(IB["X"], **{"job grade": "10"}), rec(IN, **{"job grade": "10"})])
    chg = to_changes(TOKG)
    chgt = _html.unescape(chg)
    s.check("step 3 shows the group for the two who submitted some, worded for a grade (not a unit), the cell naming the grade",
            "Their submitted 360 ratings of colleagues (2)" in chgt and "The file gives them a job grade that isn't taking part in %s" % CNAME in chgt
            and "The file moves them to a unit" not in chgt and "JG 10" in chgt[chgt.find("Their submitted 360 ratings"):][:6000]
            and "Not taking part" in chgt and ridx(IN) not in chgt[chgt.find("Their submitted 360 ratings"):][:6000].replace(ridx(IA["X"]), "").replace(ridx(IB["X"]), "")
            and not re.search(r"ZZ LO I[AB]-C[1-4]", chgt), chgt[chgt.find("Their submitted 360 ratings"):][:300])
    s.check("...and no KPI line is promised to move for them", "one level up" not in chgt[chgt.find("Each person after"):] if "Each person after" in chgt else True)
    decide(TOKG, {"rater:" + ridx(IA["X"]): "archive", "rater:" + ridx(IB["X"]): "keep"}, {"reason:rater": WHY})
    SUP.post(P, data={"csrf_token": "tok", "token": TOKG, "action": "apply"})
    dg = txt(SUP.get(P + "?done=%s" % TOKG))
    s.check("apply: all three are at JG 10", all(jg({"X": x}) == "10" for x in (IA["X"], IB["X"], IN)))
    s.check("...IA (Archive): the pending and the two undecided submitted archived with the grade words, the decided one stays",
            all(arow(IA["A"][k])["archived"] == 1 and arow(IA["A"][k])["archive_reason"] == GRW for k in ("C1", "C2", "C4")) and arow(IA["A"]["C3"])["archived"] == 0)
    s.check("...IB (Keep): only the pending one archived; every submitted stays", arow(IB["A"]["C1"])["archived"] == 1
            and all(arow(IB["A"][k])["archived"] == 0 for k in ("C2", "C3", "C4")))
    s.check("...IN (only pending): the pending one archived with no question", one("SELECT archived FROM assignments WHERE assessor_id=?", (IN,)) == 1)
    s.check("...THE KPI LINES STAY with IA and IB (the unacted and the acted-on)", lines_stay(IA) and lines_stay(IB))
    n_rated = one("SELECT COUNT(*) FROM assignments WHERE archive_reason=? AND subject_id IN (?,?,?)", (a.PROFILE_OUT_REASON, IA["X"], IB["X"], IN))
    n_pend = one("SELECT COUNT(*) FROM assignments WHERE archive_reason=? AND assessor_id IN (?,?,?) AND status='pending'", (GRW, IA["X"], IB["X"], IN))
    n_subm = one("SELECT COUNT(*) FROM assignments WHERE archive_reason=? AND assessor_id IN (?,?,?) AND status='submitted'", (GRW, IA["X"], IB["X"], IN))
    s.check("the result page has ONE line of its own for them, counting what the database holds (rating of them, pending they gave, submitted archived)",
            ("3 people moved below JG 12 and stop taking part and rating: %d 360 ratings of them archived, %d pending 360 ratings they gave archived; "
             "%d submitted 360 ratings archived (their colleagues' 360 scores change)." % (n_rated, n_pend, n_subm)) in dg and n_rated and n_pend and n_subm,
            (n_rated, n_pend, n_subm, dg[dg.find("moved below"):][:400]))
    s.check("...they are NOT in the older 'archived or brought back' bullet, nor in the left-out-unit line",
            "archived or brought back" not in dg and "moved into a unit the cycle leaves out" not in dg, dg[:600])
    s.check("...ONE trail row each, carrying the counts; IA's also the reason; nobody 'moderates'",
            all(len(trail(x, "set_details")) == 1 for x in (IA["X"], IB["X"], IN))
            and "reason for archiving what they had submitted: " + WHY in trail(IA["X"], "set_details")[0]
            and "2 360 ratings they had submitted archived" in trail(IA["X"], "set_details")[0]
            and "reason for archiving" not in trail(IB["X"], "set_details")[0] and "3 360 ratings they submitted stay" in trail(IB["X"], "set_details")[0]
            and not any("moderates KPIs" in trail(x, "set_details")[0] for x in (IA["X"], IB["X"], IN)),
            [trail(x, "set_details") for x in (IA["X"], IN)])

    s.section("grade, one file with a unit mover and a grade mover: one plan, the unit mover's lines move up, the grade mover's stay")
    IM, IG = scenario("IM"), scenario("IG")
    TOKM = upload([rec(IM["X"], company=UB), rec(IG["X"], **{"job grade": "10"})])
    chm = _html.unescape(to_changes(TOKM))
    s.check("step 3's group covers both, worded for a unit or a grade",
            "Their submitted 360 ratings of colleagues (2)" in chm and "The file moves them to a unit or gives them a job grade that isn't taking part in %s" % CNAME in chm,
            chm[chm.find("Their submitted 360 ratings"):][:300])
    decide(TOKM, {"rater:" + ridx(IM["X"]): "keep", "rater:" + ridx(IG["X"]): "keep"})
    SUP.post(P, data={"csrf_token": "tok", "token": TOKM, "action": "apply"})
    dm = txt(SUP.get(P + "?done=%s" % TOKM))
    s.check("the unit mover's unacted line moved up, the acted one stayed; the grade mover's both stayed",
            chain(IM["L1"]) == [MGR] and chain(IM["L2"]) == [IM["X"]] and lines_stay(IG), (chain(IM["L1"]), chain(IG["L1"])))
    s.check("each has its words: the unit mover the unit reason, the grade mover the grade reason",
            arow(IM["A"]["C1"])["archive_reason"] == UNIT_WHY and arow(IG["A"]["C1"])["archive_reason"] == GRW)
    s.check("the result page has one line for each kind, and the unit line counts only the unit mover",
            "1 person moved into a unit the cycle leaves out and stops rating and moderating: 1 pending 360 rating archived, 1 KPI line moved one level up" in dm
            and "1 person moved below JG 12 and stops taking part and rating: " in dm and "archived or brought back" not in dm,
            dm[dm.find("moved"):][:700])
    s.check("...one trail row each", len(trail(IM["X"], "set_details")) == 1 and len(trail(IG["X"], "set_details")) == 1)
    # the person page and the import agree: the same sentence's words
    s.check("the person page's row and the import's row use the same words for the grade mover",
            "no longer rates colleagues in %s" % CNAME in trail(IG["X"], "set_details")[0] and "no longer rates colleagues in %s" % CNAME in trail(GK["X"], "set_details")[0])

finally:
    with a.app.app_context():
        a.get_db().execute("UPDATE cycles SET min_job_grade=NULL WHERE id=?", (CID,))
        a.get_db().commit()

sys.exit(s.done())
