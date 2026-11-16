"""The person page's Competency tab and the catalogue (Chris, 2026-10-27, canvas "Person competency tab" and
"Competency catalogue search").

What this suite holds:
  * a competency's name on the tab carries its detail (the current level and its next, with description, abilities and
    knowledge) for the side panel; the panel itself is on the page, and inside a panel the tab opens it inline
  * the library box: results show the skill code, match a title OR a code, hold up to 50, say how many match, and the
    panel's Add presses the row's own buttons (same confirm texts, no new write route)
  * search as you type: admin_person_competency_find answers job profiles (JSON, up to 8) and library rows (a
    fragment), only from 2 letters, only to an admin who may open that person, and writes nothing
  * the catalogue's search: a name or a code, combined with the pills; the bar, Clear, and the no-match line
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Competency detail panel, search as you type, catalogue search")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA_ADMIN, EMP = H.actors(a)
BG = "ZZCD Group"
SPEC = "ZQD-SAL-01"
N_MANY = 55


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9CD-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM tc_assignments WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM tc_job_profiles WHERE job_code LIKE 'ZQD-%'")
    db.execute("DELETE FROM tc_skills WHERE title LIKE 'ZZCD %'")
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'UD')", (BG,))
    for lvl, code in ((3, "ZQD-CRM-3001-1.1"), (4, "ZQD-CRM-4001-1.1")):
        db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category, proficiency_description, "
                   "ability_items, knowledge_items, active) VALUES (?, 'ZZCD Customer Relations', ?, 'TSC', 'ZZCD Selling', ?, "
                   "?, ?, 1)", (code, lvl, "Description at L%d" % lvl, "Ability A%d\nAbility B%d" % (lvl, lvl),
                                "Knowledge K%d" % lvl))
    # a same-named, same-level entry from another code family: only its code tells it apart
    db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category, proficiency_description, "
               "ability_items, knowledge_items, active) VALUES ('ZQE-CRM-3001-1.1', 'ZZCD Customer Relations', 3, 'TSC', "
               "'ZZCD Selling', 'Other family L3', 'Ability Z', 'Knowledge Z', 1)")
    for i in range(N_MANY):
        db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category, active) VALUES (?, ?, 3, "
                   "'TSC', 'ZZCD Bulk', 1)", ("ZQF-BLK-3%03d-1.1" % i, "ZZCD Bulkware %02d" % i))
    db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, review_status, plan_mode, source, "
               "active) VALUES ('ZZCD Sales', 'ZZCD Manager, Sales', '16', 'ZQD-SAL-01-16', 'draft', 'explicit', 'arch', 1)")
    UID = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                     "job_grade, confirmation_date) VALUES ('zz9cd-1', 'ZZ CD One', 'x', 'user', 'ZZ9CD-1', ?, 'UD', '16', "
                     "'2020-01-01')", (BG,)).lastrowid
    cur = db.execute("SELECT id FROM tc_skills WHERE skill_code='ZQD-CRM-3001-1.1'").fetchone()[0]
    nxt = db.execute("SELECT id FROM tc_skills WHERE skill_code='ZQD-CRM-4001-1.1'").fetchone()[0]
    db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, seq, source) VALUES (?,?,?,0,1,'profile')",
               (CID, UID, cur))
    db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, seq, source) VALUES (?,?,?,1,1,'profile')",
               (CID, UID, nxt))
    db.commit()
SUP = H.client_as(a, SU["id"])
PERSON = "/admin/users/%d?tab=competency" % UID
FIND = "/admin/users/%d/competency/find" % UID
CAT = "/admin/competency/library/catalogue"

try:
    s.section("the detail behind a competency's name")
    pg = SUP.get(PERSON).get_data(as_text=True)
    m = re.search(r"data-cd-json='([^']*)'", pg)
    d = json.loads(m.group(1).replace("&#34;", '"')) if m else {}
    s.check("the name is a button carrying its detail", 'data-cd-open' in pg and bool(d))
    s.check("one line, two levels: now and the next, each with description, abilities and knowledge",
            [l["lv"] for l in d.get("levels", [])] == ["L3", "L4"] and [l["tag"] for l in d["levels"]] == ["Now", "Next level"]
            and d["levels"][0]["desc"] == "Description at L3" and d["levels"][1]["abil"] == ["Ability A4", "Ability B4"]
            and d["levels"][0]["know"] == ["Knowledge K3"] and d["cat"] == "ZZCD Selling")
    s.check("the sub line reads levels, who wrote it and where it came from",
            d.get("sub") == "L3 now → L4 next · SkillsFuture · from their job profile")
    s.check("the panel is on the page, peeking, and the library link keys the competency",
            'data-panel="cdetail"' in pg and 'data-panel-peek' in pg and d.get("lib") == "ZQD-CRM-001")
    fr = SUP.get(PERSON + "&fragment=1").get_data(as_text=True)
    s.check("inside a panel the tab opens the detail inline: no second panel, and the flag is set",
            'data-panel="cdetail"' not in fr and "data-cd-inline" in fr)

    s.section("the library box")
    box = SUP.get(PERSON + "&sq=Customer+Rel").get_data(as_text=True)
    s.check("a result shows its code under the name, so same-named entries differ",
            "ZQD-CRM-3001-1.1" in box and "ZQE-CRM-3001-1.1" in box and box.count('class="pp-lr"') == 3)
    s.check("the row keeps its Add and For their future role, same confirm text",
            "Add ZZCD Customer Relations L3 to ZZ CD One&#39;s competencies? They see it at once and it goes in the trail." in box
            or "Add ZZCD Customer Relations L3 to ZZ CD One's competencies? They see it at once and it goes in the trail." in box)
    s.check("a code alone finds it", 'ZQE-CRM-3001' in SUP.get(PERSON + "&sq=ZQE-CRM").get_data(as_text=True))
    big = SUP.get(PERSON + "&sq=Bulkware").get_data(as_text=True)
    s.check("up to 50 are listed, and the count says how many match in all",
            big.count('class="pp-lr"') == 50 and "<b>%d</b> matches" % N_MANY in big and "first 50 shown" in big)
    s.check("one letter finds nothing and says to type 2", "Type 2 letters" in SUP.get(PERSON + "&sq=B").get_data(as_text=True)
            and 'class="pp-lr"' not in SUP.get(PERSON + "&sq=B").get_data(as_text=True))

    s.section("search as you type: the find endpoint")
    j = SUP.get(FIND + "?kind=profiles&q=ZZCD+Man")
    jj = j.get_json() or {}
    s.check("job profiles come back as JSON with the typed letters split out and the meta line",
            j.status_code == 200 and len(jj.get("items", [])) == 1 and jj["items"][0]["hit"].lower() == "zzcd man"
            and "JG 16" in jj["items"][0]["meta"] and "profile=%d" % jj["items"][0]["id"] in jj["items"][0]["href"])
    s.check("profiles: nothing under 2 letters", (SUP.get(FIND + "?kind=profiles&q=Z").get_json() or {}).get("items") == [])
    sk = SUP.get(FIND + "?kind=skills&q=ZQE-CRM").get_data(as_text=True)
    s.check("library rows by code come back as a fragment (no page chrome)",
            "ZQE-CRM-3001-1.1" in sk and "<html" not in sk and 'name="csrf_token"' in sk)
    s.check("library rows by title", sk != "" and "ZZCD Customer Relations" in SUP.get(FIND + "?kind=skills&q=Customer+Rel").get_data(as_text=True))
    s.check("library: nothing under 2 letters", 'class="pp-lr"' not in SUP.get(FIND + "?kind=skills&q=Z").get_data(as_text=True))
    s.check("a bad kind is refused", SUP.get(FIND + "?kind=x&q=ab").status_code == 400)
    EMPC = H.client_as(a, EMP["id"])
    r = EMPC.get(FIND + "?kind=profiles&q=ZZCD+Man")
    s.check("a non-admin gets nothing (falsified: the same call as the super admin answers)",
            r.status_code in (302, 401, 403) and (r.get_json(silent=True) or {}).get("items") is None
            and len((SUP.get(FIND + "?kind=profiles&q=ZZCD+Man").get_json() or {}).get("items", [])) == 1)
    if BGA_ADMIN:
        BA = H.client_as(a, BGA_ADMIN["id"])
        s.check("an admin outside the person's group is refused", BA.get(FIND + "?kind=profiles&q=ZZCD+Man").status_code == 403)
    with a.app.app_context():
        _n = a.get_db().execute("SELECT COUNT(*) FROM tc_assignments WHERE subject_id=?", (UID,)).fetchone()[0]
    s.check("searching writes nothing", _n == 2)
    s.check("no new write route: the endpoint is GET only",
            SUP.post(FIND, data={"csrf_token": "tok", "kind": "skills", "q": "ab"}).status_code == 405)

    s.section("the catalogue's search")
    sr = SUP.get(CAT + "?q=Bulkware").get_data(as_text=True)
    s.check("a name filters, the bar counts matches and categories, every match shows (no fold)",
            "<b>%d</b> matches for" % N_MANY in sr and "in <b>1</b> category" in sr and "more in this category" not in sr
            and sr.count("ZZCD Bulkware") >= N_MANY and "ZZCD Customer Relations" not in sr)
    s.check("a code finds it and shows the code", "ZQE-CRM-3001-1.1" in SUP.get(CAT + "?q=zqe-crm").get_data(as_text=True))
    s.check("the pills keep the search, Clear keeps the pill",
            "show=one&amp;q=Bulkware" in SUP.get(CAT + "?q=Bulkware&show=all").get_data(as_text=True)
            and re.search(r'href="[^"]*catalogue(\?show=one)?"[^>]*>Clear the search', SUP.get(CAT + "?q=Bulkware&show=one").get_data(as_text=True)) is not None)
    nm = SUP.get(CAT + "?q=qqqzzz").get_data(as_text=True)
    s.check("no match says so and offers a code", "No competency matches" in nm and "HRS-HRM-010" in nm)
    s.check("without a search the page is as before (no bar)", "Clear the search" not in SUP.get(CAT).get_data(as_text=True))
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
