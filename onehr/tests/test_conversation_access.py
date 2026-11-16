"""A person's AI+ conversation is the super admin's only, and it opens from the person page (Chris, 2026-10-20: "put it on
the person page itself, and only allow access by super admin, update this access control in our RBAC page").

  * /admin/users/<id>/conversation serves the super admin (page and panel fragment), one audit row per open;
  * every other admin is refused, even with every access tick, and so is an employee; nothing is logged for them;
  * the person page shows the AI+ conversation card and its panel to the super admin only (?panel=conversation too);
  * the old door is gone: /admin/subjects/<id>/transcript is no route, the 360 results page has no button;
  * the access grid (Admins) says it stays the super admin's;
  * the card counts what is on record for the page's cycle, and the transcript names each side and each card shown.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H

a = H.setup()
s = H.Suite("A person's AI+ conversation: the super admin's only, on the person page")
SU, BG, _EMP = H.actors(a)
s.check("the harness has a super admin and a business group admin", SU is not None and BG is not None)

with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    P = db.execute("SELECT * FROM users WHERE role='user' AND left_at IS NULL AND business_group=? "
                   "AND COALESCE(is_demo,0)=0 ORDER BY id LIMIT 1", (BG["admin_bg"],)).fetchone()
    OTHER = db.execute("SELECT id, name FROM cycles WHERE id!=? ORDER BY id LIMIT 1", (CID,)).fetchone()
    before_chat = db.execute("SELECT COALESCE(MAX(id),0) FROM pm_review_chat").fetchone()[0]
    db.execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, stage) VALUES (?,?,'user',?, 'account')",
               (P["id"], CID, "ZZ convo test: Gross Profit came in at RM 4.2 mil"))
    db.execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, card, stage) VALUES (?,?,'agent',?,?,"
               "'account')", (P["id"], CID, "ZZ convo test reply: saved, that is Meets Expectations",
                              '[{"type": "kpi_overview", "data": {}}]'))
    db.execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, stage) VALUES (?,?,'user',?,"
               "'competency')", (P["id"], CID, "ZZ convo test: I'd put myself at level 3"))
    # the BG admin's role (Roles & access, 2026-10-20): its items, to put back
    BG_ROLE = a.admin_role_of(BG, db)["id"]
    had_items = a.admin_role_items(db, BG_ROLE)
    before_log = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
    db.commit()
s.check("a person in the BG admin's own group to look at", P is not None)


def logs():
    with a.app.app_context():
        return a.get_db().execute("SELECT user_id, target_user_id, detail FROM activity_log WHERE id>? AND "
                                  "action='view_transcript'", (before_log,)).fetchall()


URL = "/admin/users/%d/conversation" % P["id"]
try:
    A = H.client_as(a, SU["id"])
    B = H.client_as(a, BG["id"])
    E = H.client_as(a, _EMP["id"])

    s.section("the super admin reads it, as a page and in the panel")
    r = A.get(URL + "?cycle=%d" % CID)
    body = r.get_data(as_text=True)
    s.check("the page opens", r.status_code == 200, r.status_code)
    s.check("...word for word, both sides", "Gross Profit came in at RM 4.2 mil" in body and "ZZ convo test reply" in body)
    s.check("...each side named, and the card it showed said in words",
            "rv-tx-who" in body and ">Employee<" in body and ">OneHR AI<" in body and "Showed the KPI table" in body)
    s.check("...with the parts it covers and the count (3 messages, 2 from them)",
            "3 messages, 2 from them" in body and "KPI check-in" in body and "Competency" in body)
    s.check("...on the person page's frame: People › their name › AI+ conversation",
            "/admin/users/%d\"" % P["id"] in body and "AI+ conversation" in body)
    f = A.get(URL + "?cycle=%d&fragment=1" % CID)
    fb = f.get_data(as_text=True)
    s.check("the panel's fragment is the conversation alone (no page around it)",
            f.status_code == 200 and "ZZ convo test reply" in fb and "<html" not in fb.lower())
    lg = logs()
    s.check("each open is one audit row: who read whose conversation (2 opens, 2 rows)",
            len(lg) == 2 and all(x["user_id"] == SU["id"] and x["target_user_id"] == P["id"] for x in lg)
            and "review conversation" in (lg[0]["detail"] or ""), [(x["user_id"], x["target_user_id"]) for x in lg])
    if OTHER:
        n0 = len(logs())
        r2 = A.get(URL + "?cycle=%d" % OTHER["id"]).get_data(as_text=True)
        s.check("a cycle with nothing on record says so, names that cycle, and offers the one that has it",
                "No AI+ conversation on record for them" in r2 and OTHER["name"] in r2 and "Also on record" in r2
                and "ZZ convo test reply" not in r2)
        s.check("...and logs nothing (nothing was read)", len(logs()) == n0)

    s.section("nobody else: not a BG admin, even with every tick, not an employee")
    n0 = len(logs())
    s.check("the BG admin is refused, for a person in their own group", B.get(URL).status_code == 403)
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM admin_role_access WHERE role_id=?", (BG_ROLE,))
        db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)",
                       [(BG_ROLE, k) for k in a.role_preset_items("full")])
        db.commit()
    rb = B.get(URL + "?fragment=1")
    s.check("...still refused with their role given Everything, the panel's fragment too",
            rb.status_code == 403 and "ZZ convo test" not in rb.get_data(as_text=True))
    s.check("an employee is refused", E.get(URL).status_code in (403, 302) and
            "ZZ convo test" not in E.get(URL).get_data(as_text=True))
    s.check("...and none of the refusals is logged as a read", len(logs()) == n0)

    s.section("the door is on the person page, the super admin's alone")
    pa = A.get("/admin/users/%d" % P["id"]).get_data(as_text=True)
    s.check("the super admin's person page has the AI+ conversation card, opening its panel",
            "pp-mod-convo" in pa and 'data-panel-open="conversation"' in pa and 'id="pnl-conversation"' in pa)
    s.check("...the panel loads the conversation for the page's own cycle",
            'data-panel-src="/admin/users/%d/conversation?cycle=%d"' % (P["id"], CID) in pa)
    s.check("...the card counts it: 3 messages in the cycle",
            "3 messages in" in pa)
    pq = A.get("/admin/users/%d?panel=conversation" % P["id"]).get_data(as_text=True)
    s.check("?panel=conversation opens it on load (the 'Also on record' links rely on it)",
            'id="pnl-conversation"' in pq and "data-panel-autoopen" in pq[pq.find('id="pnl-conversation"'):][:600])
    pb = B.get("/admin/users/%d?panel=conversation" % P["id"]).get_data(as_text=True)
    s.check("the BG admin's person page has neither the card, the panel nor the address",
            "pp-mod-convo" not in pb and "pnl-conversation" not in pb and "/conversation" not in pb)
    s.check("...nor, in What changed, that the super admin read it (a read is no change; the audit log keeps it)",
            "Read a review conversation" not in pb and "Read a review conversation" not in pa)
    s.check("the old address is gone (no route)", A.get("/admin/subjects/%d/transcript" % P["id"]).status_code == 404)
    sd = A.get("/admin/subjects/%d" % P["id"]).get_data(as_text=True)
    s.check("...and the 360 results page has no conversation button", "Review conversation" not in sd
            and "/conversation" not in sd)

    s.section("the access grid says it is the super admin's")
    s.check("the People row's 'stays the super admin's' names it",
            "reading a person's AI+ conversation" in dict((m[0], m[3]) for m in a.ACCESS_MODULES)["people"])
    ad = A.get("/admin/roles").get_data(as_text=True)
    s.check("...and Roles & access shows it locked: Super admin only (since 2026-10-20 the access page is that tab)",
            ("Read a person&#39;s AI+ conversation" in ad or "Read a person's AI+ conversation" in ad)
            and "Super admin only" in ad)

    s.section("the card's count")
    with a.app.app_context():
        sm = a._person_conversation_summary(a.get_db(), P["id"], CID)
        n_ind = a.get_db().execute("SELECT COUNT(*) FROM pm_review_chat WHERE subject_id=? AND cycle_id=?",
                                   (P["id"], CID)).fetchone()[0]
    s.check("it counts every row on record for the person and cycle (an independent count)", sm["n"] == n_ind, (sm, n_ind))
    s.check("...their own words apart, and the parts in the journey's order",
            sm["mine"] >= 2 and sm["parts"].index("KPI check-in") < sm["parts"].index("Competency"), sm)
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM pm_review_chat WHERE id>? AND subject_id=? AND content LIKE 'ZZ convo test%'",
                   (before_chat, P["id"]))
        db.execute("DELETE FROM activity_log WHERE id>? AND action='view_transcript'", (before_log,))
        db.execute("DELETE FROM admin_role_access WHERE role_id=?", (BG_ROLE,))
        db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(BG_ROLE, k) for k in had_items])
        db.commit()

sys.exit(s.done())
