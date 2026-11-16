"""Phase B step 2 -- the manager's write surface: endorse, dispute, cite, record.

This is the FIRST surface in the product where one person writes a record about
another, so the suite is built around the two invariants a mistake here would
breach, not around the happy path:

  * FULL VISIBILITY -- everything a manager writes about a subject (a verdict, a
    citation, an item) is visible to that subject. There is no manager-private
    evidence. The manager's private scratch stays pm_kpi_moderation_drafts.
  * AUTHORISATION -- a stranger, and a DIFFERENT manager, cannot write about a
    subject. Only a manager who can act on one of the subject's KPI lines may.

Everything is BUILT, not hunted: the generated CI fixture has no approved PM
targets, so the manager->subject chain is constructed here. Writes, so fresh_db.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Phase B step 2 -- the manager's side")
SU, _BG, _EMP = H.actors(a)


def post(client, url, **form):
    form.setdefault("csrf_token", "tok")
    return client.post(url, data=form)


# ---------------------------------------------------------------------------
s.section("build: a subject, their manager, a DIFFERENT manager, a stranger")
with a.app.app_context():
    db = a.get_db()
    PID = a.active_pm_period(db)["id"]
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','evidence')")
    us = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL "
                    "ORDER BY id LIMIT 4").fetchall()
    SUBJ, MGR, OTHER_MGR, STRANGER = us[0], us[1], us[2], us[3]
    # One approved KPI line for the subject, with MGR in its approver chain --
    # the exact predicate _pm_can_review_subject reuses.
    TID = db.execute(
        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, "
        "status, business_group) VALUES (?,?,?,?,?,'approved',?)",
        (PID, SUBJ["id"], "ZZ Deliveries", 100.0, "more", SUBJ["business_group"] or "")).lastrowid
    db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) "
               "VALUES (?,1,?)", (TID, MGR["id"]))
    # OTHER_MGR manages somebody ELSE, so they are a real manager -- just not
    # this subject's. The gate must refuse them all the same.
    OTHER_SUBJ = us[3]
    OTID = db.execute(
        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, "
        "status, business_group) VALUES (?,?,?,?,?,'approved',?)",
        (PID, OTHER_MGR["id"], "ZZ Other", 100.0, "more", "")).lastrowid
    db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) "
               "VALUES (?,1,?)", (OTID, OTHER_MGR["id"]))

    def log(subj_id, author_id, body, cited_to=None, role="self", state="shared"):
        eid = db.execute(
            "INSERT INTO pm_evidence(subject_id, author_id, author_role, occurred_on, kind, "
            "body, state, shared_at) VALUES (?,?,?,?,'delivery',?,?,datetime('now'))",
            (subj_id, author_id, role, "2026-03-01", body, state)).lastrowid
        if cited_to is not None:
            db.execute("INSERT INTO pm_evidence_links(evidence_id, target_kind, target_ref) "
                       "VALUES (?,'kpi',?)", (eid, str(cited_to)))
        return eid

    ITEM = log(SUBJ["id"], SUBJ["id"], "Closed the Ipoh backlog single-handed.", TID)
    DRAFT = log(SUBJ["id"], SUBJ["id"], "not shared", TID, state="draft")
    # a different subject's item, to prove the pack does not leak
    OTHER_ITEM = log(OTHER_MGR["id"], OTHER_MGR["id"], "OTHER SUBJECT SECRET", None)
    db.commit()

with a.app.app_context():
    db = a.get_db()
    s.check("gate: the subject's own manager -> True",
            a._pm_can_review_subject(db, MGR, SUBJ["id"]) is True)
    s.check("gate: a DIFFERENT manager -> False",
            a._pm_can_review_subject(db, OTHER_MGR, SUBJ["id"]) is False)
    s.check("gate: a stranger -> False",
            a._pm_can_review_subject(db, STRANGER, SUBJ["id"]) is False)
    s.check("gate: the subject themselves -> False (not a reviewer of self)",
            a._pm_can_review_subject(db, SUBJ, SUBJ["id"]) is False)
    s.check("gate: an admin -> False", a._pm_can_review_subject(db, dict(SU), SUBJ["id"]) is False)

MGRC = H.client_as(a, MGR["id"])
OTHERC = H.client_as(a, OTHER_MGR["id"])
STRANGERC = H.client_as(a, STRANGER["id"])
SUBJC = H.client_as(a, SUBJ["id"])
SUC = H.client_as(a, SU["id"])

# ---------------------------------------------------------------------------
s.section("AUTHORISATION -- only the subject's manager may write (checks 3, 10)")
s.check("stranger endorse -> 403",
        post(STRANGERC, "/evidence/%d/review" % ITEM, verdict="endorse").status_code == 403)
s.check("a DIFFERENT manager endorse -> 403",
        post(OTHERC, "/evidence/%d/review" % ITEM, verdict="endorse").status_code == 403)
s.check("stranger cite -> 403",
        post(STRANGERC, "/evidence/%d/cite" % ITEM, stance="supports",
             decision_kind="moderation").status_code == 403)
s.check("stranger opens the subject's pack -> 404",
        STRANGERC.get("/review/team/%d" % SUBJ["id"]).status_code == 404)
s.check("a DIFFERENT manager opens the pack -> 404",
        OTHERC.get("/review/team/%d" % SUBJ["id"]).status_code == 404)
s.check("stranger records a note -> 404",
        post(STRANGERC, "/review/team/%d/note" % SUBJ["id"], body="x").status_code == 404)
s.check("admin endorse -> 404 (no manager surface for admins)",
        post(SUC, "/evidence/%d/review" % ITEM, verdict="endorse").status_code == 404)

# ---------------------------------------------------------------------------
s.section("endorse / dispute -- one standing verdict, updated not duplicated (check 4)")
s.check("the manager endorses -> ok",
        post(MGRC, "/evidence/%d/review" % ITEM, verdict="endorse").status_code == 200)
s.check("one review row exists",
        H.one(a, "SELECT COUNT(*) FROM pm_evidence_reviews WHERE evidence_id=?", (ITEM,)) == 1)
s.check("re-reviewing as dispute UPDATES, does not duplicate",
        post(MGRC, "/evidence/%d/review" % ITEM, verdict="dispute").status_code == 200
        and H.one(a, "SELECT COUNT(*) FROM pm_evidence_reviews WHERE evidence_id=?", (ITEM,)) == 1)
s.check("...and the standing verdict is now 'dispute'",
        H.one(a, "SELECT verdict FROM pm_evidence_reviews WHERE evidence_id=?", (ITEM,)) == "dispute")
s.check("a bogus verdict -> error, writes nothing new",
        post(MGRC, "/evidence/%d/review" % ITEM, verdict="maybe").status_code == 403)
s.check("a DRAFT item cannot be reviewed (nothing on the record yet)",
        post(MGRC, "/evidence/%d/review" % DRAFT, verdict="endorse").status_code == 403)

# put it back to endorse for the visibility checks
post(MGRC, "/evidence/%d/review" % ITEM, verdict="endorse", note="Saw this in January.")

# ---------------------------------------------------------------------------
s.section("FULL VISIBILITY -- the subject sees the manager's verdict (check 1)")
body = SUBJC.get("/evidence").get_data(as_text=True)
s.check("the subject's own ledger opens", "My record" in body)
s.check("...and shows the manager's endorsement on their item",
        "endorsed this" in body, body[body.find("ev-review"):][:120] if "ev-review" in body else "no review")
s.check("...naming the reviewer and their note", MGR["full_name"] in body and "Saw this in January." in body)
with a.app.app_context():
    rvs = a.pm_evidence_reviews_for(a.get_db(), ITEM)
s.check("reviews_for returns the standing verdict, visible by construction",
        len(rvs) == 1 and rvs[0]["verdict"] == "endorse")
# A manager citing the subject's own evidence AGAINST them must be visible too,
# or the ledger would hide a negative judgement -- the exact thing check 1 bans.
post(MGRC, "/evidence/%d/cite" % ITEM, stance="contradicts", decision_kind="band_change")
subj_led = SUBJC.get("/evidence").get_data(as_text=True)
s.check("the subject SEES a manager's citation on their own item",
        "cited this (contradicts)" in subj_led and MGR["full_name"] in subj_led,
        subj_led[subj_led.find("cited this"):][:80] if "cited this" in subj_led else "no citation shown")

# ---------------------------------------------------------------------------
s.section("STANCE -- contradicts is first-class; a move-DOWN can cite one (check 5)")
s.check("the manager cites the item as 'contradicts' toward a band change -> ok",
        post(MGRC, "/evidence/%d/cite" % ITEM, stance="contradicts",
             decision_kind="band_change").status_code == 200)
with a.app.app_context():
    c = a.get_db().execute("SELECT * FROM pm_evidence_citations WHERE evidence_id=? AND cited_by=?",
                           (ITEM, MGR["id"])).fetchone()
s.check("the citation is stored with its stance and the subject taken from the item",
        c and c["stance"] == "contradicts" and c["subject_id"] == SUBJ["id"])
s.check("re-citing the same (item, citer, decision) UPDATES the stance, no duplicate",
        post(MGRC, "/evidence/%d/cite" % ITEM, stance="qualifies",
             decision_kind="band_change").status_code == 200
        and H.one(a, "SELECT COUNT(*) FROM pm_evidence_citations WHERE evidence_id=? AND cited_by=? "
                  "AND decision_kind='band_change'", (ITEM, MGR["id"])) == 1)
s.check("a bogus stance -> error", post(MGRC, "/evidence/%d/cite" % ITEM, stance="hmm",
        decision_kind="moderation").status_code == 403)
s.check("the subject may cite their OWN item (supports)",
        post(SUBJC, "/evidence/%d/cite" % ITEM, stance="supports",
             decision_kind="kpi_result").status_code == 200)

# ---------------------------------------------------------------------------
s.section("MANAGER-AUTHORED ITEM -- shared, on the subject's ledger, flagged (check 6)")
r = post(MGRC, "/review/team/%d/note" % SUBJ["id"],
         body="Handled the client escalation calmly.", kind="behaviour",
         raised_with_subject="discussed")
s.check("the manager records a note -> ok", r.status_code == 200, r.status_code)
NOTE_ID = r.get_json().get("id")
with a.app.app_context():
    m = a.get_db().execute("SELECT * FROM pm_evidence WHERE id=?", (NOTE_ID,)).fetchone()
s.check("it is authored by the manager, about the subject",
        m["author_id"] == MGR["id"] and m["subject_id"] == SUBJ["id"])
s.check("...with author_role 'manager' (pm_evidence_write derived it)", m["author_role"] == "manager")
s.check("...it ships SHARED, not a private draft", m["state"] == "shared")
s.check("...raised_with_subject was recorded", m["raised_with_subject"] == "discussed")
subj_ledger = SUBJC.get("/evidence").get_data(as_text=True)
s.check("the subject SEES the manager's item on their own ledger",
        "Handled the client escalation calmly." in subj_ledger)
s.check("...flagged as manager-written", "from your manager" in subj_ledger)

# ---------------------------------------------------------------------------
s.section("BOTH ACCOUNTS -- subject item + manager item -> 'both' flag (check 7)")
with a.app.app_context():
    flags = a.pm_why_flags(a.get_db(), [SUBJ, OTHER_MGR])
s.check("the subject's Why flag reads 'both'", flags.get(SUBJ["id"]) == "both", flags)

# ---------------------------------------------------------------------------
s.section("THE PACK IS SUBJECT-SCOPED -- another subject's ledger never leaks (check 8)")
pack = MGRC.get("/review/team/%d" % SUBJ["id"]).get_data(as_text=True)
s.check("the manager's pack for the subject opens", "Ipoh backlog" in pack)
s.check("...and never shows another subject's item", "OTHER SUBJECT SECRET" not in pack)
team = MGRC.get("/review/team").get_data(as_text=True)
# The link to the subject's pack is the robust invariant -- names can carry
# characters Jinja escapes, so match the href, not the raw name.
s.check("the team list links to the subject's pack",
        ("/review/team/%d" % SUBJ["id"]) in team, team[team.find("rv-team-list"):][:200])

# ---------------------------------------------------------------------------
s.section("NO MANAGER-PRIVATE EVIDENCE -- a lint on the new tables (check 2)")
SRC = H.source(a)
for tbl in ("pm_evidence_reviews", "pm_evidence_citations"):
    seg = SRC[SRC.find("CREATE TABLE IF NOT EXISTS %s(" % tbl):]
    seg = seg[:seg.find("))") + 2]
    for banned in ("private", "hidden", "internal", "confidential"):
        s.check("%s has no '%s' column" % (tbl, banned), banned not in seg.lower())
# The only manager-private store is the moderation scratch, unchanged.
s.check("the moderation drafts table is still the ONE private store",
        "pm_kpi_moderation_drafts" in SRC)

# ---------------------------------------------------------------------------
s.section("classification -- reviews die with the ledger, the pack with the phase")
s.check("evidence_review under 'evidence'", a.MODULE_ENDPOINTS.get("evidence_review") == "evidence")
s.check("evidence_cite under 'evidence'", a.MODULE_ENDPOINTS.get("evidence_cite") == "evidence")
s.check("review_team under 'review'", a.MODULE_ENDPOINTS.get("review_team") == "review")
s.check("review_team_member under 'review'", a.MODULE_ENDPOINTS.get("review_team_member") == "review")
s.check("review_team_note under 'review'", a.MODULE_ENDPOINTS.get("review_team_note") == "review")
with a.app.app_context():
    a.get_db().execute("UPDATE cycle_modules SET active=0 WHERE module_key='review'")
    a.get_db().commit()
s.check("review phase off -> the pack 404s", MGRC.get("/review/team/%d" % SUBJ["id"]).status_code == 404)
with a.app.app_context():
    a.get_db().execute("UPDATE cycle_modules SET active=0 WHERE module_key='evidence'")
    a.get_db().execute("UPDATE cycle_modules SET active=1 WHERE module_key='review'")
    a.get_db().commit()
s.check("evidence off -> endorse 404s (dies with the ledger, not the phase)",
        post(MGRC, "/evidence/%d/review" % ITEM, verdict="endorse").status_code == 404)
with a.app.app_context():
    a.get_db().execute("UPDATE cycle_modules SET active=1 WHERE module_key='evidence'")
    a.get_db().commit()

# ---------------------------------------------------------------------------
s.section("FRESH INSTALL -- both tables migrate on a virgin DB (check 9)")
n = H.one(a, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND "
          "name IN ('pm_evidence_reviews','pm_evidence_citations')")
s.check("both new tables exist after a fresh migration", n == 2, n)

sys.exit(s.done())
