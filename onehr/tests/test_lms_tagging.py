"""AI+ Learning: the L&D AI agent tags a programme added by hand (Chris, 2026-10-22: "when admin registered a new
program, our L&D AI agent will process and recommend the tagging competency and respective proficiency level"; canvas
board 6B; "ok, build all of it on staging").

What this suite holds:
  * the shortlist: words of 3 letters count ("HSE"), lightly stemmed; the title counts more than the description; each
    family's level wording is searched; each candidate carries the library's wording per level, and so does what the
    model reads; a change to the library rebuilds the index
  * a programme added by hand is saved as a draft, then tagged: only candidates, at a level the family has, at most 4,
    never confirmed; evidence kept only when it is the programme's own words; logged
  * the AI failing, or not set up, never loses the draft
  * Suggest again replaces only the proposals still waiting; a confirmed competency is never touched
  * L&D confirms at the level they pick; publishing still waits for a confirmed one
  * who: the super admin and L&D; a BG admin can't; the page shows the picker with the library's wording
Everything here is synthetic (ZZLT / ZZ9LT-) and removed at the end.
"""
import html
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning: the AI tags a programme added by hand")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG = "ZZLT Group"
_ENV0 = os.environ.get("ONEHR_LMS")
_AI0, _SUG0 = a.ai_draft.is_configured, a.ai_draft.lms_suggest_competencies
L2_SAFE = "Apply quarnex safety procedures, wear PPE and follow the permit to work in one's own area."
L3_DREV = "Lead drevan drills and glimmerstone reviews after incidents."


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LT-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLT %'")
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE detail LIKE '%ZZLT%'")
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZLT-%'")
    db.commit()


def person(db, eid, role="user", admin_bg=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, admin_bg) VALUES (?,?, 'x', ?, ?,?, 'ZZLT U1', 'ZZLT Ops', "
                      "'ZZLT Officer', '15', ?)", (eid.lower(), "ZZ LT " + eid.split("-")[1], role, eid, BG,
                                                   admin_bg)).lastrowid


def fam(db, code, title, levels, desc=None, cat="ZZLT Cat"):
    for lv in levels:
        db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category, proficiency_description, "
                   "active) VALUES (?,?,?,?,?,?,1)", ("ZZLT-%s-%d%s-1.0" % (code[:3], lv, code[3:]), title, lv, "tsc",
                                                      cat, (desc or {}).get(lv) or "%s, working at level %d." % (title, lv)))
    return "ZZLT-%s-%s" % (code[:3], code[3:])


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    F_SAFE = fam(db, "WSH001", "ZZLT Quarnex Safety", (1, 2, 3, 4), {2: L2_SAFE})
    F_HSE = fam(db, "HSE002", "ZZLT HSE Vortal", (2, 3))
    F_PRICE = fam(db, "PRC003", "ZZLT Plimbo Pricing", (3, 4, 5))
    F_DREV = fam(db, "DRV004", "ZZLT Drevan Response", (2, 3, 4), {3: L3_DREV})
    F_FLORB = fam(db, "FLB006", "ZZLT Florbing", (2, 3))
    LND = person(db, "ZZ9LT-LND", "admin", a.LMS_ADMIN_BG)
    BGA = person(db, "ZZ9LT-BGA", "admin", BG)
    STAFF = person(db, "ZZ9LT-E1")
    db.commit()


def one(sql, args=()):
    return H.one(a, sql, args)


def comps(pid):
    return [tuple(r) for r in H.rows(a, "SELECT comp_key, level, confirmed, strength, evidence FROM "
                                        "lms_programme_competencies WHERE programme_id=? ORDER BY comp_key", (pid,))]


def env(v):
    if v is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = v


CALLS = []


def stub(reply):
    def _f(text, cands, kind=""):
        CALLS.append({"text": text, "cands": cands, "kind": kind})
        if isinstance(reply, Exception):
            raise reply
        return reply
    a.ai_draft.lms_suggest_competencies = _f


def keys(cands):
    return [c["key"] for c in cands]


def post(client, data):
    return client.post("/admin/learning/programmes", data=dict({"csrf_token": "tok"}, **data))


try:
    env("1")
    CL, CB, CS, CE = H.client_as(a, LND), H.client_as(a, BGA), H.client_as(a, SU["id"]), H.client_as(a, STAFF)

    s.section("the shortlist")
    with a.app.app_context():
        db = a.get_db()
        c1 = a.lms_candidates(db, "", title="HSE")
        s.check("a word of 3 letters counts: HSE finds its family (the old rule needed 4)", F_HSE in keys(c1), keys(c1)[:5])
        c2 = a.lms_candidates(db, "plimbo", title="quarnex")
        s.check("the title counts more than the description", F_SAFE in keys(c2) and F_PRICE in keys(c2) and
                keys(c2).index(F_SAFE) < keys(c2).index(F_PRICE), keys(c2)[:5])
        c3 = a.lms_candidates(db, "a course on glimmerstone", title="")
        s.check("each family's level wording is searched", F_DREV in keys(c3), keys(c3)[:5])
        c4 = a.lms_candidates(db, "florbs", title="")
        s.check("words are lightly stemmed (florbs finds Florbing)", F_FLORB in keys(c4), keys(c4)[:5])
        safe = next((c for c in c2 if c["key"] == F_SAFE), {})
        s.check("each candidate carries its levels and the library's wording per level",
                safe.get("levels") == [1, 2, 3, 4] and safe.get("desc", {}).get(2) == L2_SAFE, safe)
        listing = a.ai_draft.lms_cand_listing([safe])
        s.check("...and the model reads that wording, level by level", F_SAFE in listing and "L2: " + L2_SAFE in listing
                and "L4: " in listing, listing[:200])
        nk = fam(db, "NEW005", "ZZLT Zentrafoil Basics", (2, 3))
        db.commit()
        c5 = a.lms_candidates(db, "", title="zentrafoil")
        s.check("a change to the library rebuilds the index (a new family is found at once)", nk in keys(c5), keys(c5))

    s.section("a programme added by hand is tagged")
    a.ai_draft.is_configured = lambda: True
    stub([{"key": F_SAFE, "level": 2, "strength": "strong", "evidence": "PPE, permit to work"},
          {"key": "INVENTED-XXX-001", "level": 2, "strength": "strong"},
          {"key": F_DREV, "level": 9},
          {"key": F_DREV, "level": 3, "strength": "medium", "evidence": "words the programme never says"},
          {"key": F_HSE, "level": 2, "strength": "loud"},
          {"key": F_FLORB, "level": "high"},
          {"key": F_PRICE, "level": "L4"},
          {"key": F_SAFE, "level": 3},
          {"key": F_FLORB, "level": 2, "strength": "strong"}])
    del CALLS[:]
    r = post(CL, {"action": "save", "title": "ZZLT HSE Site Induction", "kind": "briefing",
                  "description": "Site safety rules, PPE, permit to work, emergency response for new site staff."})
    P = one("SELECT id FROM lms_programmes WHERE title='ZZLT HSE Site Induction'")
    s.check("saved as a draft, then the AI asked once", P and r.status_code == 302 and len(CALLS) == 1 and
            one("SELECT status FROM lms_programmes WHERE id=?", (P,)) == "draft", (r.status_code, len(CALLS)))
    s.check("...with the programme's title and details", CALLS and "ZZLT HSE Site Induction" in CALLS[0]["text"]
            and "permit to work" in CALLS[0]["text"] and CALLS[0]["kind"] == "Internal briefing", CALLS[0]["kind"] if CALLS else "")
    s.check("...and candidates from the library with their level wording", CALLS and F_HSE in keys(CALLS[0]["cands"])
            and all("desc" in c for c in CALLS[0]["cands"]))
    got = comps(P)
    s.check("kept: only candidates, at a level the family has, never confirmed",
            {(k, lv, cf) for k, lv, cf, _s, _e in got} == {(F_SAFE, 2, 0), (F_DREV, 3, 0), (F_HSE, 2, 0),
                                                           (F_PRICE, 4, 0)}, got)
    s.check("...at most 4 (a fifth valid one dropped), a key once", len(got) == 4 and F_FLORB not in [g[0] for g in got])
    s.check("...evidence only when it is the programme's own words",
            dict((k, e) for k, _l, _c, _s, e in got).get(F_SAFE) == "PPE, permit to work"
            and dict((k, e) for k, _l, _c, _s, e in got).get(F_DREV) is None, got)
    s.check("...a level named as the listing names it ('L4') is read; a word isn't",
            (F_PRICE, 4) in [g[:2] for g in got], got)
    s.check("...a strength the library doesn't use reads medium",
            dict((k, st) for k, _l, _c, st, _e in got).get(F_HSE) == "medium", got)
    s.check("logged as 'Suggested competencies with AI'", one(
        "SELECT COUNT(*) FROM activity_log WHERE action='lms_programme_suggest' AND user_id=? AND detail LIKE "
        "'%ZZLT HSE Site Induction (4 proposed)%'", (LND,)) == 1
        and a.ACTION_LABELS.get("lms_programme_suggest") == "Suggested competencies with AI")
    post(CL, {"action": "publish", "programme_id": P})
    s.check("publishing waits for a confirmed competency", one("SELECT status FROM lms_programmes WHERE id=?", (P,))
            == "draft")

    s.section("the page: a level picker in the library's own words")
    page = html.unescape(CL.get("/admin/learning/programmes?programme=%d&panel=prog" % P).get_data(as_text=True))
    s.check("each proposal has its levels to pick, the proposed one picked",
            'name="level" value="2" data-desc="%s" checked' % L2_SAFE in page and 'value="4" data-desc=' in page, "")
    s.check("...the picked level's wording, why, Confirm at the level, Not this one",
            "L2:</b> " + L2_SAFE in page and "Why: “PPE, permit to work”" in page and "Confirm at L2" in page
            and "Not this one" in page)
    s.check("...and Suggest again, an AI control", "comp_suggest" in page and 'class="btn-ai"' in page)
    a.ai_draft.is_configured = lambda: False
    page = html.unescape(CL.get("/admin/learning/programmes?programme=%d&panel=prog" % P).get_data(as_text=True))
    s.check("no AI on the server: no Suggest button", "comp_suggest" not in page)
    a.ai_draft.is_configured = lambda: True
    page = html.unescape(CB.get("/admin/learning/programmes?programme=%d&panel=prog" % P).get_data(as_text=True))
    s.check("a BG admin reads it: no picker, no Suggest", 'name="level"' not in page and "comp_suggest" not in page)

    s.section("L&D confirms at the level they pick; Suggest again")
    post(CL, {"action": "comp_confirm", "programme_id": P, "comp_key": F_SAFE, "level": "3"})
    s.check("confirmed at the picked level (L3, the AI said L2)", (F_SAFE, 3, 1) in [g[:3] for g in comps(P)], comps(P))
    post(CL, {"action": "comp_remove", "programme_id": P, "comp_key": F_HSE})
    s.check("Not this one drops a proposal", F_HSE not in [g[0] for g in comps(P)])
    stub([{"key": F_SAFE, "level": 1, "strength": "strong"}, {"key": F_HSE, "level": 3, "strength": "medium"}])
    del CALLS[:]
    post(CL, {"action": "comp_suggest", "programme_id": P})
    got = comps(P)
    s.check("Suggest again asks the AI", len(CALLS) == 1)
    s.check("...replaces the proposals still waiting", {g[0] for g in got if not g[2]} == {F_HSE}, got)
    s.check("...never a confirmed one (still L3, still confirmed)", (F_SAFE, 3, 1) in [g[:3] for g in got], got)
    stub(a.ai_draft.AIDraftError("throttled"))
    post(CL, {"action": "comp_suggest", "programme_id": P})
    s.check("an AI failure on Suggest again changes nothing", comps(P) == got, comps(P))
    del CALLS[:]
    r = post(CB, {"action": "comp_suggest", "programme_id": P})
    s.check("a BG admin can't ask for it", r.status_code in (302, 403) and not CALLS and comps(P) == got, r.status_code)
    r = post(CE, {"action": "comp_suggest", "programme_id": P})
    s.check("...nor staff", r.status_code in (302, 403, 404) and not CALLS and comps(P) == got, r.status_code)
    post(CL, {"action": "publish", "programme_id": P})
    s.check("with one confirmed, it publishes", one("SELECT status FROM lms_programmes WHERE id=?", (P,)) == "published")

    s.section("the draft is never lost to the AI")
    stub(a.ai_draft.AIDraftError("throttled"))
    r = post(CL, {"action": "save", "title": "ZZLT Fail Course", "kind": "inhouse", "description": "quarnex"})
    PF = one("SELECT id FROM lms_programmes WHERE title='ZZLT Fail Course'")
    s.check("the AI failing: the draft is kept, with nothing proposed", PF and r.status_code == 302 and not comps(PF))
    stub(RuntimeError("boom"))
    r = post(CL, {"action": "save", "title": "ZZLT Boom Course", "kind": "inhouse", "description": "quarnex"})
    s.check("...even an unexpected error", one("SELECT COUNT(*) FROM lms_programmes WHERE title='ZZLT Boom Course'") == 1
            and r.status_code == 302, r.status_code)
    a.ai_draft.is_configured = lambda: False
    stub([{"key": F_SAFE, "level": 2}])
    del CALLS[:]
    post(CL, {"action": "save", "title": "ZZLT No AI Course", "kind": "inhouse", "description": "quarnex"})
    PN = one("SELECT id FROM lms_programmes WHERE title='ZZLT No AI Course'")
    s.check("no AI on the server: saved, the AI never asked", PN and not CALLS and not comps(PN))
    a.ai_draft.is_configured = lambda: True
    del CALLS[:]
    post(CL, {"action": "save", "programme_id": PN, "title": "ZZLT No AI Course", "kind": "inhouse",
              "description": "quarnex again"})
    s.check("an edit doesn't re-tag (only a new programme, or Suggest again)", not CALLS)
finally:
    a.ai_draft.is_configured, a.ai_draft.lms_suggest_competencies = _AI0, _SUG0
    env(_ENV0)
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
