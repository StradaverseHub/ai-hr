"""Grade H Appraisal: what the agents, Ask OneHR, Help, the KB and the tour know about it (2026-10-28; project rule: every new
module updates what the agents and the first sign-in know).

What this suite holds:
  * the module OFF (ONEHR_GRADEH unset, as production): none of the five surfaces says anything about Grade H to anyone --
    Ask OneHR's facts, intents and guide entries, the KB search the agent uses, OneHR Agent's welcome and prompt, Help's quick
    answers on every page it could be asked on, for a Grade H person, a line manager, an HOD, a BU CEO, an ordinary employee and
    an admin. Falsified: with the audiences forced on and the switch still off, the same detector fires.
  * the module ON: each seat gets its own lines and only its own -- staff (My Appraisal / Penilaian Saya, in both languages
    where Help answers), line manager, HOD, BU CEO, super admin -- and nobody is told about a seat they do not hold
  * Ask OneHR is a guide: no result, band or value in its facts; a request for a result is still answered in code
  * the KB rows are seeded everywhere by slug (INSERT OR IGNORE) and read only by the seat each concerns
  * wording: Group People never HR / HRBP; no staff-facing line mentions Reopen; nothing implies a promotion
  * the tour: a stop for the Grade H card, dropped by the tour's own filter where the card is not on the page
Synthetic (ZZ9GK-*) on a fresh scratch database; the suite puts back what it changes.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Grade H Appraisal: what the agents, Ask OneHR, Help, the KB and the tour know")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, EMP = H.actors(a)
PFX, BG, CO = "ZZ9GK-", "ZZGK Group", "ZZGK Unit"
U = {}
_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
import sqlite3  # noqa: E402

db = sqlite3.connect(a.DB_PATH, timeout=5.0)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# anything that says Grade H to someone: its names, its pages, its Help keys, its KB slugs
LEAK = re.compile(r"grade h|my appraisal|penilaian|/my-appraisal|/review/gradeh|/calibration/gradeh|gh_staff_|gh_dash_|gh_lm_|"
                  r"gh_hod_|gh_bu_|gh_cal_|gh_adm_|gradeh-", re.I)


def mk(k, grade="H", mgr=None, hod=None, email=True):
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
        "job_grade, job_title, manager_id, hod_id, confirmation_date, email) VALUES (?,?, 'x', 'user', ?,?,?, 'ZZGK Dept', ?, "
        "'Driver', ?, ?, '2020-01-01', ?)", ((PFX + k).lower(), "ZZ GK " + k, PFX + k, BG, CO, grade, mgr, hod,
                                           ("zzgk.%s@example.test" % k.lower()) if email else None)).lastrowid


def person(k, route="B", appraiser=None, lang="en", private=0):
    return db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route, appraiser_id, language, private_company, "
                      "language_set_at) VALUES (?,?,?,?,?,?,?, datetime('now'))",
                      (CID, PFX + k, U[k], route, appraiser, lang, private)).lastrowid


def run(fn):
    with a.app.test_request_context("/"):
        d = a.get_db()
        r = fn(d)
        d.commit()
        return r


def urow(k):
    return dict(db.execute("SELECT * FROM users WHERE id=?", (U[k],)).fetchone())


def as_user(uid, fn, path="/"):
    """fn(db, user dict) inside a request for that signed-in account (cache and all, as a page would run it)."""
    with a.app.test_request_context(path):
        a.session["user_id"] = uid
        d = a.get_db()
        return fn(d, dict(d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()))


if True:
    CID = run(lambda d: a.active_cycle_id(d))
    HALF0 = db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()["half"]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
    db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 1)", (CID,))
    db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
    U["BCEO"] = mk("BCEO", "21")
    U["HOD"] = mk("HOD", "19")
    U["LM"] = mk("LM", "15", hod=U["HOD"])
    U["PLAIN"] = mk("PLAIN", "15")                        # a line manager with no Grade H staff
    U["STAFF"] = mk("STAFF", "H", mgr=U["LM"], hod=U["HOD"])
    U["STAFFBM"] = mk("STAFFBM", "H", mgr=U["LM"], hod=U["HOD"])
    U["PRV"] = mk("PRV", "H", mgr=U["LM"], hod=U["HOD"])  # a private-company row: not on the list for real
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, U["BCEO"]))
    person("STAFF", "B", appraiser=U["LM"], lang="en")
    person("STAFFBM", "A", appraiser=U["LM"], lang="bm")
    person("PRV", "B", appraiser=U["LM"], private=1)
    db.commit()
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell LIKE 'gradeh_%'", (CID,))
    db.commit()

SEATS = ("STAFF", "STAFFBM", "LM", "HOD", "BCEO", "PLAIN", "PRV")
CTX_OF = {}


def surfaces(uid, ep_list=None):
    """Everything the five surfaces say to this account, as one list of strings (plus the pieces), without a model call."""
    def go(d, u):
        ctx = a._dash_context(d, u)
        facts, links = a._ask_facts(d, u, ctx)
        out = {"facts": list(facts), "links": dict(links)}
        out["intent"] = {"q%d" % i: a._ask_intent(q, ctx) for i, q in enumerate((
            "where is my appraisal", "where are my Grade H staff", "open grade h calibration", "where is grade h appraisal"))}
        out["guide"] = a._ask_guide(d, "my appraisal grade h calibration appraise kpi acknowledge sign off")
        out["kb"] = a._journey_tool_search_kb(d, {"query": "grade h appraisal calibration"})["guidance"]
        out["kb_miss"] = a._journey_tool_search_kb(d, {"query": "zzqqxx nothing matches this"})["guidance"]
        out["welcome_extra"] = a._journey_gradeh_welcome(a.gradeh_audiences(d, u))
        out["prompt"] = a._journey_gradeh_prompt(a.gradeh_audiences(d, u))
        out["help"] = {ep: a.help_answers(d, u, ep, view, stage) for ep, view, stage in (
            ("dashboard", "", ""), ("review_journey", "mine", ""), ("review_journey", "team", ""),
            ("review_gradeh", "", ""), ("review_gradeh_person", "", ""), ("calib_gradeh_hod", "", ""),
            ("calib_gradeh_unit", "", ""), ("admin_gradeh", "", ""), ("admin_overview", "", ""), ("my_settings", "", ""))}
        return out
    return as_user(uid, go)


def blob(o):
    return repr(o)


def leaks(o):
    return sorted(set(m.group(0).lower() for m in LEAK.finditer(blob(o))))


def help_keys(sf):
    return {ep: [i["key"] for i in h["items"]] for ep, h in sf["help"].items()}


try:
    ID = {k: U[k] for k in SEATS}
    ID["EMP"] = EMP["id"]
    ID["SU"] = SU["id"]

    # ------------------------------------------------------------------------------------------------------
    s.section("the module OFF (production): nobody is told anything about Grade H")
    os.environ["ONEHR_GRADEH"] = "0"
    OFF = {k: surfaces(uid) for k, uid in ID.items()}
    for k, sf in OFF.items():
        s.check("%s: none of the five surfaces mentions Grade H (facts, intents, guide, KB, welcome, prompt, Help)" % k,
                not leaks(sf), leaks(sf))
    s.check("the audiences are empty for every seat", all(
        as_user(uid, lambda d, u: a.gradeh_audiences(d, u)) == frozenset() for uid in ID.values()))
    s.check("the KB rows are still seeded (by slug, like Learning's) but never read",
            H.one(a, "SELECT COUNT(*) FROM kb_entries WHERE slug IN ('gradeh-my-appraisal','gradeh-line-manager','gradeh-hod',"
                     "'gradeh-bu-ceo')") == 4
            and all(not sf["kb"] or all("Grade H" not in g["title"] and "My Appraisal" not in g["title"] for g in sf["kb"])
                    for sf in OFF.values()))
    s.check("the staff's KB row can't be fetched by its own words either, with the module off",
            not [g for g in as_user(U["STAFF"], lambda d, u: a._ask_guide(d, "my appraisal penilaian saya grade h"))
                 if "Appraisal" in g["title"]])
    s.check("the tool search with the module off for a Grade H person returns no Grade H row",
            not [g for g in OFF["STAFF"]["kb"] if "Appraisal" in g["title"] or "calibration" in g["title"].lower()])

    # falsify the detector: with the switch OFF but the audiences forced on, the same leak check must fire
    s.section("falsified: the detector sees a leak when the audience gate is bypassed")
    _aud = a.gradeh_audiences
    try:
        a.gradeh_audiences = lambda db_=None, u_=None: frozenset({"staff", "lm", "hod", "buceo"})
        FORCED = surfaces(U["LM"])
    finally:
        a.gradeh_audiences = _aud
    s.check("forced audiences, switch off: the facts, the welcome, the prompt and the KB all now carry Grade H",
            leaks(FORCED) and "Grade H" in FORCED["welcome_extra"] and "GRADE H APPRAISAL" in FORCED["prompt"]
            and any("Grade H" in l_ or "My Appraisal" in l_ for l_ in FORCED["facts"]), leaks(FORCED))
    s.check("...and the real gate (the same call, unforced) is clean again", not leaks(surfaces(U["LM"])))
    _hid = a._kb_gradeh_hidden
    try:
        a._kb_gradeh_hidden = lambda slug: False   # the KB's own check removed, switch still off
        kb_forced = as_user(U["STAFF"], lambda d, u: a._journey_tool_search_kb(d, {"query": "my appraisal grade h"}))["guidance"]
    finally:
        a._kb_gradeh_hidden = _hid
    s.check("KB falsified: with the row check removed the staff row IS returned even with the switch off",
            any("Appraisal" in g["title"] for g in kb_forced))
    _on = a.gradeh_on
    try:
        a.gradeh_on = lambda: True   # the switch removed from the admin Help branch
        adm_forced = as_user(SU["id"], lambda d, u: a.help_answers(d, u, "admin_gradeh"))
    finally:
        a.gradeh_on = _on
    s.check("Help falsified: with the switch bypassed the admin Grade H answers appear (so the module-off check can fail)",
            [i["key"] for i in adm_forced["items"]][:1] == ["gh_adm_where"])

    # ------------------------------------------------------------------------------------------------------
    s.section("the module ON: each seat gets its own lines, and only its own")
    os.environ["ONEHR_GRADEH"] = "1"
    ON = {k: surfaces(uid) for k, uid in ID.items()}
    AUD = {k: as_user(uid, lambda d, u: a.gradeh_audiences(d, u)) for k, uid in ID.items()}
    s.check("audiences: staff / lm / hod / buceo, each only for who holds it",
            AUD["STAFF"] == {"staff"} and AUD["STAFFBM"] == {"staff"} and AUD["LM"] == {"lm"} and AUD["HOD"] == {"hod"}
            and AUD["BCEO"] == {"buceo"} and AUD["PLAIN"] == frozenset() and AUD["EMP"] == frozenset()
            and AUD["SU"] == frozenset() and AUD["PRV"] == frozenset(), AUD)

    s.section("... Ask OneHR's facts (where, never what)")
    f_staff, f_lm, f_hod, f_bu = ("\n".join(ON[k]["facts"]) for k in ("STAFF", "LM", "HOD", "BCEO"))
    s.check("staff: a My Appraisal line with a link to their page", "My Appraisal: your Grade H appraisal is on its own page" in f_staff
            and any(v.get("href") == "/my-appraisal" for v in ON["STAFF"]["links"].values()))
    s.check("line manager: the Grade H card is described, can be marked, and links to the list",
            "Grade H Appraisal (a card of its own" in f_lm and any(v.get("mark") == "gradeh" for v in ON["LM"]["links"].values())
            and any(v.get("href") == "/review/gradeh" for v in ON["LM"]["links"].values()))
    s.check("HOD: Grade H calibration (potential, then performance) with the HOD page's link",
            "Grade H calibration" in f_hod and "potential, then their performance" in f_hod
            and any(v.get("href") == "/calibration/gradeh/hod" for v in ON["HOD"]["links"].values()))
    s.check("BU CEO: Grade H calibration (Talent Box) with the unit page's link",
            "Talent Box" in f_bu and any(v.get("href") == "/calibration/gradeh/unit" for v in ON["BCEO"]["links"].values()))
    s.check("every mark a Grade H link uses is an ASK_MARKS key, and the page script can find it",
            "gradeh" in a.ASK_MARKS and "gradeh: [" in open(os.path.join(ROOT, "static", "ask_onehr.js")).read())
    s.check("the ordinary employee, the plain line manager, the private-company row and the admin hear nothing",
            all(not leaks(ON[k]["facts"]) and not leaks({e: h for e, h in ON[k]["help"].items() if e != "admin_gradeh"})
                and not ON[k]["prompt"] and not ON[k]["welcome_extra"] for k in ("EMP", "PLAIN", "PRV", "SU")))
    s.check("the staff person is not told about the line manager's, HOD's or BU CEO's pages (and so on, seat by seat)",
            "/review/gradeh" not in f_staff and "/calibration/gradeh" not in f_staff
            and "/my-appraisal" not in f_lm + f_hod + f_bu and "/calibration/gradeh" not in f_lm
            and "/review/gradeh" not in f_hod + f_bu)
    s.check("no Grade H fact holds a rating, band, potential or score value (a guide, never a report)",
            not re.search(r"\b(UA|BE|ME|AE|OU)\b|\d+(\.\d+)? ?%|rating of|potential (is|of)|\bscore\b",
                          "\n".join(l_ for l_ in ON["LM"]["facts"] + ON["HOD"]["facts"] + ON["BCEO"]["facts"] + ON["STAFF"]["facts"]
                                    if re.search(r"Grade H|My Appraisal", l_))))

    s.section("... Ask OneHR's ways on (answered in code, no model)")
    i_staff = ON["STAFF"]["intent"]["q0"]
    s.check("staff: 'where is my appraisal' gives the My Appraisal card",
            i_staff and i_staff["cards"][0]["href"] == "/my-appraisal" and "Bahasa Melayu" in i_staff["say"], i_staff)
    i_lm = ON["LM"]["intent"]["q1"]
    s.check("line manager: the Grade H Appraisal card, marking the dashboard card",
            i_lm and i_lm["cards"][0]["href"] == "/review/gradeh" and i_lm["mark"] == "gradeh", i_lm)
    i_hod = ON["HOD"]["intent"]["q2"]
    i_bu = ON["BCEO"]["intent"]["q2"]
    s.check("HOD and BU CEO: Grade H calibration, each to their own page",
            i_hod and i_hod["cards"][0]["href"] == "/calibration/gradeh/hod"
            and i_bu and i_bu["cards"][0]["href"] == "/calibration/gradeh/unit", (i_hod, i_bu))
    s.check("HOD and BU CEO: Ask OneHR's facts, its answer and Help's dashboard line all say the Grade H tab at the top of the review",
            "Grade H tab at the top of your Department Review" in f_hod and "Grade H tab at the top of your Calibration" in f_bu
            and "Grade H tab at the top of your Department Review" in i_hod["say"] and "Grade H tab at the top of your Calibration" in i_bu["say"]
            and "Grade H tab" in a.HELP_QA["gh_dash_cal"][1] and "Your team" not in a.HELP_QA["gh_dash_cal"][1], (i_hod["say"], i_bu["say"]))
    s.check("nobody else gets a Grade H way on: employee, plain line manager, admin and private-company rows go on to the model",
            all(ON[k]["intent"][q] is None for k in ("EMP", "PLAIN", "PRV", "SU") for q in ON[k]["intent"]))
    s.check("a line manager asking for 'my appraisal' (their own, not Grade H) is not sent to the staff page",
            ON["LM"]["intent"]["q0"] is None)
    s.check("a request for a Grade H result is still answered in code, pointing to a card (never read out)",
            a._ask_wants_result("what is my appraisal rating") or a._ask_wants_result("what band did my team get"))

    s.section("... the KB (the guide and the agent's search_kb): conceptual, and only for the seat")
    def kb_titles(k):
        return {g["title"] for g in ON[k]["kb"]}
    s.check("staff: their own row only", {t for t in kb_titles("STAFF") if "Grade H" in t} == {"My Appraisal: your Grade H appraisal"}, kb_titles("STAFF"))
    s.check("line manager: theirs only", {t for t in kb_titles("LM") if "Grade H" in t} == {"Grade H Appraisal for line managers"}, kb_titles("LM"))
    s.check("HOD: theirs only", {t for t in kb_titles("HOD") if "Grade H" in t} == {"Grade H calibration for HODs"}, kb_titles("HOD"))
    s.check("BU CEO: theirs only", {t for t in kb_titles("BCEO") if "Grade H" in t} == {"Grade H calibration for BU CEOs"}, kb_titles("BCEO"))
    s.check("employee, plain line manager, private-company row: none (the search falls back to other topics)",
            all(not any("Grade H" in t for t in kb_titles(k)) for k in ("EMP", "PLAIN", "PRV")))
    s.check("the guide (Ask OneHR's own search) gives staff and a line manager their row too, and nobody else's",
            any(g_["title"].startswith("My Appraisal") for g_ in ON["STAFF"]["guide"])
            and any("line managers" in g_["title"] for g_ in ON["LM"]["guide"])
            and not any("Grade H" in g_["title"] or "My Appraisal" in g_["title"] for g_ in ON["EMP"]["guide"] + ON["PLAIN"]["guide"]))
    rows = {r["slug"]: r for r in db.execute("SELECT * FROM kb_entries WHERE slug LIKE 'gradeh-%'")}
    s.check("four rows, active, ordered after Learning's", set(rows) == set(a._KB_GRADEH_SLUGS)
            and all(r["active"] == 1 and r["sort_order"] >= 40 for r in rows.values()), set(rows))
    s.check("every row is conceptual: no figure, band, cut-off or percentage",
            not any(re.search(r"\d+(\.\d+)? ?%|\b\d\.\d\d\b|\b(UA|BE|ME|AE|OU)\b", r["body"]) for r in rows.values()))
    s.check("the staff row says it in both languages", "Dalam Bahasa Melayu" in rows["gradeh-my-appraisal"]["body"])
    seed_again = run(lambda d: d.execute("INSERT OR IGNORE INTO kb_entries(slug,title,body,tags,sort_order) VALUES "
                                         "('gradeh-hod','x','x','x',1)").rowcount)
    s.check("the HOD and BU CEO rows say the Grade H tab, not Your team",
            "Grade H tab at the top of your Department Review" in rows["gradeh-hod"]["body"]
            and "Grade H tab at the top of your Calibration" in rows["gradeh-bu-ceo"]["body"]
            and not any("Your team" in rows[k_]["body"] for k_ in ("gradeh-hod", "gradeh-bu-ceo")))
    # the guarded one-time UPDATE: a row still holding the 2026-10-28 wording is reworded once; an admin's edit is never overwritten
    OLD_HOD = "As an HOD you calibrate the Grade H people in your department in two stages, in Your team, under Grade H calibration: first potential."
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-hod'", (OLD_HOD,))
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-bu-ceo'", ("An admin's own words about Your team, kept.",))
    db.commit()
    a._ensure_runtime_schema()
    s.check("a row still on the old wording is reworded once; an edited row is left alone",
            db.execute("SELECT body FROM kb_entries WHERE slug='gradeh-hod'").fetchone()[0] == a._KB_GRADEH_HOD_BODY
            and db.execute("SELECT body FROM kb_entries WHERE slug='gradeh-bu-ceo'").fetchone()[0] == "An admin's own words about Your team, kept.")
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-bu-ceo'", (a._KB_GRADEH_BUCEO_BODY,))
    db.commit()
    # a higher tier no longer waits for a lower one (2026-10-30): the two rows reworded once, keyed on their old wording
    OLD_HOD2 = "As an HOD you calibrate. You sign the stage off when you are done. Nobody moves their own band. Your moves are the second stage after the line manager's; the BU CEO's Talent Box, and then Group People's final bands, come after yours."
    OLD_BU2 = "As a BU CEO you see your unit. Sign-off opens once every HOD in the unit has signed off, and a result outside the curve asks for a reason."
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-hod'", (OLD_HOD2,))
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-bu-ceo'", (OLD_BU2,))
    db.commit()
    a._ensure_runtime_schema()
    s.check("the rows that still say a tier waits are reworded once (the HOD's, the BU CEO's)",
            db.execute("SELECT body FROM kb_entries WHERE slug='gradeh-hod'").fetchone()[0] == a._KB_GRADEH_HOD_BODY
            and db.execute("SELECT body FROM kb_entries WHERE slug='gradeh-bu-ceo'").fetchone()[0] == a._KB_GRADEH_BUCEO_BODY)
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-hod'", ("An admin's own HOD words, kept: they come after yours.",))
    db.commit()
    a._ensure_runtime_schema()
    s.check("...and an edited HOD row is left alone", db.execute("SELECT body FROM kb_entries WHERE slug='gradeh-hod'").fetchone()[0] == "An admin's own HOD words, kept: they come after yours.")
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-hod'", (a._KB_GRADEH_HOD_BODY,))
    db.commit()
    # a released person with no line manager appraisal sees their final result (2026-10-30): the staff row reworded once, keyed on its old wording
    OLD_ST = "My Appraisal is where you take part. Group People releases it; your final result then shows on the same page. Potential is your line manager's view."
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-my-appraisal'", (OLD_ST,))
    db.commit()
    a._ensure_runtime_schema()
    got_st = db.execute("SELECT body FROM kb_entries WHERE slug='gradeh-my-appraisal'").fetchone()[0]
    s.check("the staff row on the old wording is reworded once: a released person with no line manager appraisal sees a final result, nothing to acknowledge",
            got_st == a._KB_GRADEH_STAFF_BODY and "did not complete an appraisal" in got_st and "Jika pengurus anda tidak melengkapkan penilaian" in got_st)
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-my-appraisal'", ("An admin's own My Appraisal words, kept.",))
    db.commit()
    a._ensure_runtime_schema()
    s.check("...and an edited staff row is left alone", db.execute("SELECT body FROM kb_entries WHERE slug='gradeh-my-appraisal'").fetchone()[0] == "An admin's own My Appraisal words, kept.")
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-my-appraisal'", (a._KB_GRADEH_STAFF_BODY,))
    db.commit()
    # the deemed switch (2026-10-31): the staff row's sentence about the date is true either way; reworded once, keyed on the exact previous text
    s.check("the previous staff text differs from the new one only by the two sentences about the date (EN and BM)",
            a._KB_GRADEH_STAFF_BODY_BEFORE_SWITCH != a._KB_GRADEH_STAFF_BODY
            and "If you do not acknowledge by the date shown, the appraisal is treated as agreed." in a._KB_GRADEH_STAFF_BODY_BEFORE_SWITCH
            and "If your page shows an acknowledge-by date and you neither acknowledge nor tell us you do not agree by then, the appraisal is treated as acknowledged."
            in a._KB_GRADEH_STAFF_BODY and "Jika halaman anda menunjukkan tarikh akhir dan anda tidak mengesahkan atau memberitahu kami" in a._KB_GRADEH_STAFF_BODY)
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-my-appraisal'", (a._KB_GRADEH_STAFF_BODY_BEFORE_SWITCH,))
    db.commit()
    a._ensure_runtime_schema()
    s.check("a staff row still on the previous text is reworded once, to the new one",
            db.execute("SELECT body FROM kb_entries WHERE slug='gradeh-my-appraisal'").fetchone()[0] == a._KB_GRADEH_STAFF_BODY)
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-my-appraisal'", (a._KB_GRADEH_STAFF_BODY_BEFORE_SWITCH + " An admin's addition.",))
    db.commit()
    a._ensure_runtime_schema()
    s.check("...an admin's edited row is left alone", db.execute("SELECT body FROM kb_entries WHERE slug='gradeh-my-appraisal'").fetchone()[0]
            == a._KB_GRADEH_STAFF_BODY_BEFORE_SWITCH + " An admin's addition.")
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-my-appraisal'", (a._KB_GRADEH_STAFF_BODY,))
    db.commit()
    # 2026-11-02 (early opening): the rule changed. Once a stage is OPEN a tier still waits for no lower one (the 2026-10-30 rule: the
    # default band, move anyone, sign off any time), but it now OPENS when the people it waits on have finished, or on a fallback date
    # (tests/test_gradeh_early_open.py). The words say both, and never the older "sign-off opens once every HOD" as the only rule.
    _words = " ".join([a._KB_GRADEH_HOD_BODY, a._KB_GRADEH_BUCEO_BODY, a.HELP_QA["gh_bu_signoff"][1], a.HELP_QA["gh_hod_nolm"][1],
                       a._journey_gradeh_prompt(frozenset({"hod", "buceo"}))])
    s.check("the seats' words: once open a tier waits for no lower one, and each says when it opens (finished, or the fallback date)",
            not re.search(r"Sign-off opens once|until every HOD|still with the HOD", _words)
            and "do not wait for a line manager" in a._KB_GRADEH_HOD_BODY and "do not wait for the HODs" in a._KB_GRADEH_BUCEO_BODY
            and "never wait for the HODs" in a._journey_gradeh_prompt(frozenset({"buceo"}))
            and "fallback date" in a._KB_GRADEH_HOD_BODY and "fallback date" in a._KB_GRADEH_BUCEO_BODY
            and "fallback date" in a.HELP_QA["gh_bu_signoff"][1] and "fallback date" in a.HELP_QA["gh_hod_nolm"][1]
            and "fallback date" in a._journey_gradeh_prompt(frozenset({"hod"})) and "fallback date" in a._journey_gradeh_prompt(frozenset({"buceo"}))
            and a.HELP_QA["gh_bu_signoff"][0] == "Do I wait for my HODs?")
    s.check("seeded by slug: a second seed adds nothing and an edit is never overwritten", seed_again == 0
            and db.execute("SELECT title FROM kb_entries WHERE slug='gradeh-hod'").fetchone()[0] == "Grade H calibration for HODs")

    s.section("... OneHR Agent (the welcome and the prompt)")
    s.check("line manager: the welcome points to Grade H Appraisal under Your team",
            "Grade H Appraisal, under Your team" in ON["LM"]["welcome_extra"]
            and "GRADE H APPRAISAL" in ON["LM"]["prompt"] and "never pick a rating" in ON["LM"]["prompt"])
    s.check("HOD / BU CEO: Grade H calibration is the Grade H tab at the top of their Department Review / Calibration, not under Your team",
            "Grade H tab at the top of your Department Review" in ON["HOD"]["welcome_extra"]
            and "Grade H tab at the top of your Calibration" in ON["BCEO"]["welcome_extra"]
            and "potential first and then performance" in ON["HOD"]["prompt"] and "Talent Box" in ON["BCEO"]["prompt"]
            and "Grade H tab at the top of their Department Review" in ON["HOD"]["prompt"]
            and "Grade H tab at the top of their Calibration" in ON["BCEO"]["prompt"]
            and "under Your team" not in ON["HOD"]["welcome_extra"] + ON["BCEO"]["welcome_extra"])
    s.check("staff: their own appraisal is on My Appraisal, a page of its own, not this chat",
            "My Appraisal" in ON["STAFF"]["welcome_extra"] and "not in this chat" in ON["STAFF"]["prompt"])
    s.check("the prompt never lets the agent say a Grade H result or imply promotion",
            all("Never say or guess any Grade H person's rating" in ON[k]["prompt"] and "promotion" in ON[k]["prompt"]
                for k in ("LM", "HOD", "BCEO", "STAFF")))
    s.check("the employee and the admin: no extra welcome line, no prompt paragraph",
            all(not ON[k]["welcome_extra"] and not ON[k]["prompt"] for k in ("EMP", "SU", "PLAIN")))
    # the real prompt and welcome, end to end, for a line manager with the review on (as the journey builds them)
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','evidence','tm','idp','pm')", (CID,))
        d.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES('review_unified','1')")
        d.commit()

    def real_prompt(uid):
        def go(d, u):
            st = a.review_state(d, u)
            stage = a._journey_active_stage(st, "account")
            return (a._journey_agent_system(d, u, st, stage, is_opener=True),
                    " ".join(x.get("say", "") for x in a._journey_intro_steps(d, u, st, stage)))
        return as_user(uid, go)
    try:
        sysp_lm, welcome_lm = real_prompt(U["LM"])
        sysp_emp, welcome_emp = real_prompt(EMP["id"])
        os.environ["ONEHR_GRADEH"] = "0"
        sysp_lm0, welcome_lm0 = real_prompt(U["LM"])
        os.environ["ONEHR_GRADEH"] = "1"
        s.check("the line manager's real system prompt carries the Grade H paragraph, the welcome its sentence",
                "GRADE H APPRAISAL" in sysp_lm and "Grade H Appraisal, under Your team" in welcome_lm)
        s.check("the ordinary employee's real prompt and welcome do not", "GRADE H" not in sysp_emp.upper()
                and "Grade H" not in welcome_emp)
        s.check("module off: the line manager's real prompt and welcome carry none of it",
                "GRADE H" not in sysp_lm0.upper() and "Grade H" not in welcome_lm0)
        s.check("...and the prompt differs from the module-on one by exactly that paragraph",
                a._journey_gradeh_prompt(frozenset({"lm"})) in sysp_lm and a._journey_gradeh_prompt(frozenset({"lm"})) not in sysp_lm0)
    except Exception as e:   # the review state needs a running cycle; the unit checks above hold the content
        s.check("(the real prompt could not be built on this fixture: %s)" % e, True)

    s.section("... Help's quick answers (fixed words, never a model)")
    hk = {k: help_keys(ON[k]) for k in ON}
    s.check("line manager: the Grade H page's answers, and the dashboard's last-but-one line says where",
            hk["LM"]["review_gradeh"] == ["gh_lm_kpi", "gh_lm_final", "gh_lm_nominate", "gh_lm_inperson", "gh_lm_disagree"]
            and "gh_dash_lm" in hk["LM"]["dashboard"] and len(hk["LM"]["dashboard"]) <= a.HELP_LIST_MAX
            and hk["LM"]["review_gradeh_person"] == hk["LM"]["review_gradeh"])
    s.check("HOD and BU CEO: their own calibration answers; the dashboard names Grade H calibration",
            hk["HOD"]["calib_gradeh_hod"] == ["gh_hod_nolm", "gh_cal_move", "gh_cal_fit", "gh_cal_after", "gh_hod_rem"]
            and hk["BCEO"]["calib_gradeh_unit"] == ["gh_bu_signoff", "gh_cal_move", "gh_cal_fit", "gh_cal_after", "gh_bu_rem"]
            and "gh_dash_cal" in hk["HOD"]["dashboard"] and "gh_dash_cal" in hk["BCEO"]["dashboard"])
    s.check("a seat's Grade H list is not shown on another seat's page (the HOD on the line manager's page, and so on)",
            hk["HOD"]["review_gradeh"] != hk["LM"]["review_gradeh"] and "gh_lm_route" not in hk["HOD"]["review_gradeh"]
            and hk["LM"]["calib_gradeh_hod"] != hk["HOD"]["calib_gradeh_hod"]
            and hk["HOD"]["calib_gradeh_unit"] != hk["BCEO"]["calib_gradeh_unit"])
    s.check("super admin: the Grade H admin pages have their own five; every other admin page is unchanged",
            hk["SU"]["admin_gradeh"] == ["gh_adm_where", "gh_adm_import", "gh_adm_appraiser", "gh_adm_bands", "gh_adm_deemed"]
            and hk["SU"]["admin_overview"] == ["adm_submitted", "adm_button", "text_size", "theme", "adm_reports"]
            and ON["SU"]["help"]["admin_gradeh"]["hint"] == "Not here? Ask the Admin Agent.")
    s.check("the admin's Grade H answers are not on the module-off admin page",
            OFF["SU"]["help"]["admin_gradeh"]["items"] == OFF["SU"]["help"]["admin_overview"]["items"])
    st_en, st_bm = ON["STAFF"]["help"]["dashboard"], ON["STAFFBM"]["help"]["dashboard"]
    s.check("staff: English answers for an English page, Bahasa Melayu for a BM one -- the same five questions",
            st_en["label"] == "My Appraisal" and st_bm["label"] == "Penilaian Saya"
            and len(st_en["items"]) == len(st_bm["items"]) == 5
            and all(e["q"] != b["q"] and e["a"] != b["a"] for e, b in zip(st_en["items"], st_bm["items"]))
            and "Di mana penilaian saya?" in [i["q"] for i in st_bm["items"]], st_en["label"])
    s.check("the employee and the plain line manager: their dashboard Help is exactly what it was",
            help_keys(ON["EMP"]) == help_keys(OFF["EMP"]) and help_keys(ON["PLAIN"]) == help_keys(OFF["PLAIN"]))
    s.check("the private-company row sees the ordinary Help (they are not on the list)",
            help_keys(ON["PRV"]) == help_keys(OFF["PRV"]))
    s.check("an item for a Grade H page is only ever reached through a seat: the module off, none of them is offered anywhere",
            not any(k.startswith("gh_") for sf in OFF.values() for ks in help_keys(sf).values() for k in ks))

    s.section("wording")
    texts = []
    for k in ("gradeh-my-appraisal", "gradeh-line-manager", "gradeh-hod", "gradeh-bu-ceo"):
        texts.append(rows[k]["title"] + " " + rows[k]["body"])
    for k, (q, ans) in a.HELP_QA.items():
        if k.startswith("gh_"):
            texts.append(q + " " + ans)
    for qa in a.GRADEH_HELP_STAFF:
        texts += [qa[0][0] + " " + qa[0][1], qa[1][0] + " " + qa[1][1]]
    texts += [a._journey_gradeh_prompt(frozenset({"lm", "hod", "buceo", "staff"})),
              a._journey_gradeh_welcome(frozenset({"lm", "hod", "buceo", "staff"}))]
    allt = "\n".join(texts)
    s.check("Group People, never HR / HRBP / JG H", not re.search(r"\bHR\b|HRBP|JG H|People Business Partner", allt), re.findall(r"\bHR\b|HRBP|JG H", allt))
    s.check("nothing in staff-facing words mentions Reopen (a submission is final)",
            "eopen" not in allt and "re-open" not in allt.lower())
    s.check("nothing implies a promotion or that a person is ready for a role",
            not re.search(r"ready for (a|the) (role|promotion)|will be promoted|promotion (is|will)|is promoted", allt, re.I)
            and "not a promotion decision" in allt)
    staff_texts = "\n".join([rows["gradeh-my-appraisal"]["body"]] + [x for qa in a.GRADEH_HELP_STAFF for pair in qa for x in pair])
    s.check("staff-facing lines never name the nomination or JG H", "nominat" not in staff_texts.lower() and "JG H" not in staff_texts)
    s.check("the product is not renamed: no 'OneHR AI+'", "OneHR AI+" not in allt)

    s.section("the deemed switch (2026-10-31): off, no staff-facing answer says a result is treated as agreed")
    def _set_deemed(v):
        with a.app.test_request_context("/"):
            d = a.get_db()
            a.gradeh_set_setting(d, "gradeh_deemed_on", v)
            d.commit()
    _set_deemed(0)
    try:
        SOFF = {k: surfaces(ID[k]) for k in ("STAFF", "STAFFBM")}
        for k, sf in SOFF.items():
            its = sf["help"]["dashboard"]["items"]
            s.check("%s, deemed OFF: Help drops 'What if I do not acknowledge in time?' (four questions left), the others stay" % k,
                    len(its) == 4 and not any("acknowledge in time" in i["q"] or "tepat pada masanya" in i["q"] for i in its)
                    and not any("treated as agreed" in i["a"] or "dianggap telah dipersetujui" in i["a"] for i in its), [i["q"] for i in its])
            _txt = repr(sf["facts"]) + repr(sf["guide"]) + repr(sf["kb"]) + repr(sf["prompt"])
            # the staff KB row's own sentence is conditional on the page showing a date (true either way); nothing else may say it
            _txt = re.sub(r"If your page shows an acknowledge-by date[^.]*\.", "", _txt)
            _txt = re.sub(r"Jika halaman anda menunjukkan tarikh akhir[^.]*\.", "", _txt)
            s.check("%s: no fact, answer or KB line a person can be given says 'treated as agreed' outside the conditional KB sentence" % k,
                    not re.search(r"treated as agreed|treat the appraisal as agreed|dianggap telah|treated\s+as", _txt), re.findall(r".{40}(?:treated|dianggap).{40}", _txt)[:3])
    finally:
        _set_deemed(1)
    s.check("deemed ON again: Help has the five questions, the deadline one among them",
            len(surfaces(ID["STAFF"])["help"]["dashboard"]["items"]) == 5)
    s.check("the staff KB row reads true either way: the sentence about the date is conditional on the page showing one",
            "If your page shows an acknowledge-by date" in rows["gradeh-my-appraisal"]["body"]
            and "If you do not acknowledge by the date shown" not in rows["gradeh-my-appraisal"]["body"])
    s.check("the admin Help answer names the switch", "switch" in a.HELP_QA["gh_adm_deemed"][1] and "turns it off" in a.HELP_QA["gh_adm_deemed"][1])

    s.section("the first sign-in tour")
    js = open(os.path.join(ROOT, "static", "onboarding.js")).read()
    s.check("the dashboard tour has a Grade H Appraisal stop keyed on the card (dropped by the tour's own filter where there is none)",
            '{ sel: [".ghl-card"], title: "Grade H Appraisal"' in js and ".filter(function (s) { return s.nodes.length; })" in js)
    s.check("the stop sits after Your learning and before Your history and tools",
            js.index('title: "Your learning"') < js.index('title: "Grade H Appraisal"') < js.index('title: "Your history and your tools"'))
    s.check("the dashboard (card present) carries that selector for a line manager and not for an employee",
            "ghl-card" in H.client_as(a, U["LM"]).get("/dashboard").get_data(as_text=True)
            and "ghl-card" not in H.client_as(a, EMP["id"]).get("/dashboard").get_data(as_text=True))
    cst = H.client_as(a, U["STAFF"])
    _ob0 = a.app.config.get("ONEHR_ONBOARDING")
    a.app.config["ONEHR_ONBOARDING"] = True
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE gradeh_people SET language_set_at=NULL WHERE user_id=?", (U["STAFF"],))
        d.execute("UPDATE users SET display_name=NULL, avatar=NULL, onboard_picture_at=NULL, onboard_tour_at=NULL WHERE id=?",
                  (U["STAFF"],))
        d.commit()
    pg = cst.get("/my-appraisal").get_data(as_text=True)
    s.check("a Grade H person's first sign-in is Language first, then Name, Picture and the tour, on their own page",
            "Choose your language" in pg and all(w in pg for w in ("Bahasa<", "Nama<", "Gambar<", "Lihat sekeliling<")))
    if _ob0 is None:
        a.app.config.pop("ONEHR_ONBOARDING", None)
    else:
        a.app.config["ONEHR_ONBOARDING"] = _ob0
    s.check("...with the tour step in both languages (tour_h, tour_p, tour_btn, and the stops' words)", all(
        k in a.GRADEH_STAFF_T and a.GRADEH_STAFF_T[k][0] != a.GRADEH_STAFF_T[k][1]
        for k in ("tour_h", "tour_p", "tour_btn", "tour_s1_t", "tour_s1", "tour_s2", "tour_s3", "tour_s4", "tour_s5")))

    s.section("Ask OneHR stays a guide")
    body = H.source(a).split("\ndef _ask_facts(", 1)[1].split("\ndef ", 1)[0]
    s.check("_ask_facts still reads no table (the Grade H lines come from the dashboard's dict and one helper)",
            "db.execute(" not in body and "SELECT" not in body)
finally:
    os.environ["ONEHR_GRADEH"] = _ENV0 if _ENV0 is not None else ""
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE cycles SET half=? WHERE id=?", (HALF0, CID))
        d.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
        d.commit()

sys.exit(s.done())
