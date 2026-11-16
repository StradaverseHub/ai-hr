"""Grade H Appraisal: My Appraisal's shell (2026-10-28; canvases D1, D2, P1, P2, F, the five changes Chris approved).

What this suite holds:
  * announcements reach Grade H staff: My Appraisal counts as the Dashboard place (bar_place), so an announcement placed on the
    dashboard shows on the page and one placed only on "other" does not
  * the bar's deadline reminder for a Grade H person reads THEIR date (the KPI window's close, or the acknowledge deadline), in
    their language, within the rules' days, red on the last day, none once sent / closed / off, never an admin, and a person who
    is not on the list keeps the main cycle's reminder; the page's "Now . closes 15 Nov" and the bar read the same date
  * the Look around: Start still posts (so it completes with no script) and lands on ?tour=1; that GET writes nothing and carries
    the stops, in the person's language, only for the elements the step has; the old three-line list is gone
  * every new GRADEH_STAFF_T key has English and Bahasa Melayu (same placeholders; staff text never says JG H, Grade H, Reopen, HR)
  * the CSS: the bar pinned, the banner and --topbar-h mirrored for the 60px bar, the Ask OneHR column under both, and ONE outline
    on a wrapped field (the wrapper's focus ring; no ring on the input inside)
Synthetic (ZZ9GX-*) on a fresh scratch database; the suite puts back what it changes.
"""
import html as _html
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Grade H Appraisal: My Appraisal's shell (pinned bar, announcements, deadline reminder, one outline, the tour)")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SU, BGA, EMP = H.actors(a)
PFX, BG, CO = "ZZ9GX-", "ZZGX Group", "ZZGX Unit"
PAGE = "/my-appraisal"
U, P = {}, {}
_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
_ONB0 = a.app.config.get("ONEHR_ONBOARDING")
_real_items = a.reminder_items

db = sqlite3.connect(a.DB_PATH, timeout=5.0)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")


def one(sql, args=()):
    r = db.execute(sql, args).fetchone()
    return r[0] if r else None


def run(fn):
    with a.app.test_request_context("/"):
        d = a.get_db()
        r = fn(d)
        d.commit()
        return r


def csrf(**kw):
    d = {"csrf_token": "tok"}
    d.update(kw)
    return d


def mk(k, mgr=None):
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
        "job_grade, job_title, manager_id, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?, 'ZZGX Dept', 'H', 'Driver', ?, "
        "'2020-01-01')", ((PFX + k).lower(), "ZZ GX " + k, PFX + k, BG, CO, mgr)).lastrowid


def person(k, route, lang="bm"):
    return db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route, appraiser_id, language, language_set_at) "
                      "VALUES (?,?,?,?,?,?, datetime('now'))", (CID, PFX + k, U[k], route, U["M1"], lang)).lastrowid


def lines_for(pid, spec):
    for i, (name, w) in enumerate(spec, 1):
        db.execute("INSERT INTO gradeh_kpi_lines (cycle_id, person_id, kpi_name, weight, group_scale, sort_order) "
                   "VALUES (?,?,?,?, 'FIAMMA', ?)", (CID, pid, name, w, i))


def user_row(uid):
    return db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()


def set_window(cell, opens=None, closes=None):
    run(lambda d: d.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                            (CID, cell, opens, closes)))


def clear_windows():
    run(lambda d: d.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,)))


def kpi_window(days_to_close, opens_days=-1):
    """The KPI window open from `opens_days`, closing `days_to_close` days from today (MYT) at 23:59."""
    t = a._today_myt()
    set_window(a.GRADEH_CELL_KPI, (t + timedelta(days=opens_days)).isoformat() + " 00:00",
               (t + timedelta(days=days_to_close)).isoformat() + " 23:59")
    return datetime.combine(t + timedelta(days=days_to_close), datetime.min.time()).replace(hour=23, minute=59)


def rules(**kw):
    r = {"on": True, "days": 3, "places": ["dashboard"]}
    r.update(kw)
    run(lambda d: d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('deadline_reminder', ?)", (json.dumps(r),)))


def dl(uid, place=None):
    def go(d):
        return a.deadline_item(d, user_row(uid), a._now_myt(), place)
    return run(go)


def items(uid, place="dashboard"):
    return run(lambda d: a.bar_items(d, user_row(uid), now=a._now_myt(), place=place))


def post_ann(headline, places):
    now = a._now_myt()
    return run(lambda d: d.execute(
        "INSERT INTO site_announcements(headline, message, audience, on_signin, button, starts_at, ends_at, created_by, places) "
        "VALUES (?,?, 'everyone', 0, 'none', ?,?,?,?)",
        (headline, "Message for " + headline, (now - timedelta(hours=1)).strftime("%Y-%m-%d %H:%M"),
         (now + timedelta(days=5)).strftime("%Y-%m-%d %H:%M"), SU["id"], places)).lastrowid)


def clear_ann():
    run(lambda d: d.execute("DELETE FROM site_announcements"))


def tour_data(resp):
    m = re.search(r"data-tour='([^']*)'", resp.get_data(as_text=True))
    return json.loads(_html.unescape(m.group(1))) if m else None


def date_words(dt, lang):
    return a.gh_when(dt, lang, time=False, year=False)


def tables_count():
    names = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    return {n: db.execute('SELECT COUNT(*) FROM "%s"' % n).fetchone()[0] for n in names}


css = open(os.path.join(ROOT, "static", "gradeh_staff.css"), encoding="utf-8").read()
calib_css = open(os.path.join(ROOT, "static", "gradeh_calib.css"), encoding="utf-8").read()
base_css = open(os.path.join(ROOT, "static", "style.css"), encoding="utf-8").read()
js = open(os.path.join(ROOT, "static", "gradeh_staff.js"), encoding="utf-8").read()

if True:
    CID = run(lambda d: a.active_cycle_id(d))
    HALF0 = db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()["half"]
    db.execute("UPDATE cycles SET half=2, open_by_date=1 WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
    db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 1)", (CID,))
    db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    db.execute("DELETE FROM site_announcements")
    db.execute("DELETE FROM app_settings WHERE key='deadline_reminder'")
    U["M1"] = mk("M1")
    for k in ("A1", "A2", "B1", "T1", "T2", "T3"):
        U[k] = mk(k, U["M1"])
    P["A1"] = person("A1", "A", "en")
    P["A2"] = person("A2", "A", "bm")
    P["B1"] = person("B1", "B", "en")
    P["T1"] = person("T1", "A", "en")
    P["T2"] = person("T2", "B", "bm")
    P["T3"] = person("T3", "A", "en")
    for k in ("A1", "A2", "T1", "T3"):
        lines_for(P[k], [("ZZ Alpha", 60), ("ZZ Beta", 40)])
    db.commit()
    run(lambda d: (a.gradeh_set_setting(d, "gradeh_deemed_mode", "days"), a.gradeh_set_setting(d, "gradeh_deemed_days", 7)))
    # a first sign-in is not in the way of the page: their name, picture and look-around are done (T1..T3 redo them below)
    db.execute("UPDATE users SET display_name='ZZ Done', onboard_picture_at=datetime('now'), onboard_tour_at=datetime('now') "
               "WHERE id IN (%s)" % ",".join(str(v) for v in U.values()))
    db.commit()
C = {k: H.client_as(a, U[k]) for k in U}
CSU = H.client_as(a, SU["id"])

try:
    # ---------------------------------------------------------------- 2. announcements
    s.section("announcements reach Grade H staff: My Appraisal is the Dashboard place")
    with a.app.test_request_context("/"):
        got = {p: a.bar_place(endpoint=e, path=p) for p, e in (
            (PAGE, "my_appraisal"), ("/dashboard", "dashboard"), ("/review/journey", "review_journey"), ("/profile", "my_settings"),
            ("/admin/notices", "admin_notices"), (PAGE + "/language", "my_appraisal_language"), ("/review/gradeh", "review_gradeh"))}
    s.check("bar_place: My Appraisal is 'dashboard'; the dashboard still is; a profile page is still 'other'; /review/... is 'checkin'",
            got[PAGE] == "dashboard" and got["/dashboard"] == "dashboard" and got["/profile"] == "other"
            and got["/review/journey"] == "checkin" and got["/review/gradeh"] == "checkin" and got["/admin/notices"] == "admin", got)
    s.check("...and only the page itself: its POST endpoints are not a place that shows the bar",
            got[PAGE + "/language"] == "other", got)
    dash_row = [p for p in a.BAR_PLACES if p[0] == "dashboard"][0]
    s.check("the Dashboard row's description says My Appraisal counts as it", "My Appraisal" in dash_row[2], dash_row)
    clear_ann()
    s.check("with nothing posted, no banner on the page", 'id="site-ann"' not in C["A1"].get(PAGE).get_data(as_text=True))
    post_ann("ZZGX dash words", "dashboard")
    post_ann("ZZGX other words", "other")
    h = C["A1"].get(PAGE).get_data(as_text=True)
    s.check("an announcement placed on the dashboard renders on a Grade H person's My Appraisal (id=site-ann, its words)",
            'id="site-ann"' in h and "ZZGX dash words" in h)
    s.check("...and one placed only on 'other' does not", "ZZGX other words" not in h)
    s.check("the page's banner slot knows it is the dashboard place (data-place), so notice.js asks for the same",
            'data-place="dashboard"' in h)
    s.check("the Bahasa Melayu page gets it too", "ZZGX dash words" in C["A2"].get(PAGE).get_data(as_text=True))
    s.check("the line manager's own page (review/gradeh) is not the dashboard place: the 'other' one is not there either",
            "ZZGX dash words" not in H.client_as(a, U["M1"]).get("/review/gradeh").get_data(as_text=True))
    clear_ann()
    s.check("taken down: the banner goes", 'id="site-ann"' not in C["A1"].get(PAGE).get_data(as_text=True))

    # ---------------------------------------------------------------- 3. the deadline reminder
    s.section("the bar's deadline reminder for a Grade H person reads their own date")
    rules()
    clear_windows()
    s.check("no KPI window dates set: no reminder (nothing to count to)", dl(U["A1"]) is None)
    close2 = kpi_window(2)
    d2 = date_words(close2, "en")
    it = dl(U["A1"], "dashboard")
    s.check("KPI window closes in 2 days (rules: 3): the reminder, in English, with the date the page shows",
            it and it["lead"] == "Your KPI achievement closes %s, 23:59" % a.gh_day_words(close2, "en")
            and it["body"] == "3 days left. Enter each KPI, then send it to your line manager." and it["kind"] == "deadline"
            and it["icon"] == "cal" and not it["red"], it)
    s.check("...key keeps the dl.<role>.<date>.<today> shape",
            it and it["key"] == "dl.gradeh_kpi.%s.%s" % (close2.date().isoformat(), a._today_myt().isoformat()), it)
    s.check("...no button on My Appraisal itself (the dashboard place); on another page it opens My Appraisal",
            it["button"] is None and dl(U["A1"], "other")["button"] == {"label": "My Appraisal", "url": PAGE})
    bm = dl(U["A2"], "dashboard")
    s.check("the same date in Bahasa Melayu for a BM person (board E3's words: the weekday, the day, 11:59 malam)",
            bm and bm["lead"] == "Pencapaian KPI anda ditutup %s" % a.gh_day_words(close2, "bm", time=True)
            and bm["body"] == "3 hari lagi. Masukkan setiap KPI, kemudian hantar kepada pengurus anda.", bm)
    h = C["A1"].get(PAGE).get_data(as_text=True)
    s.check("the page's own step line and the banner read ONE date (Now . closes <d>; the banner: by <d>)",
            ("Now · closes %s" % d2) in _html.unescape(h) and 'id="site-ann"' in h and ("Your KPI achievement closes %s, 23:59" % a.gh_day_words(close2, "en")) in h
            and "3 days left. Enter each KPI" in h and 'class="sn-act"' not in h)
    s.check("a Grade H person sees only their own reminder: the main cycle's is not in the bar",
            "Your check-in closes" not in h)
    kpi_window(1)
    s.check("one day out: today counts (2 days left, as the main bar reads it)", dl(U["A1"])["body"].startswith("2 days left. Enter each KPI"))
    close0 = kpi_window(0)
    last = dl(U["A1"])
    s.check("last day: red, 'Last day: ... closes tonight at 23:59', and what to do", last and last["red"]
            and last["lead"] == "Last day: your KPI achievement closes tonight at 23:59"
            and last["body"] == "Send it to your line manager.", last)
    kpi_window(5)
    s.check("5 days out (rules: 3): none", dl(U["A1"]) is None)
    rules(days=7)
    s.check("...rules at 7 days: there (the guard is the rules' days, not a fixed number)", dl(U["A1"]) and dl(U["A1"])["body"].startswith("6 days left."))
    rules()
    kpi_window(2, opens_days=1)
    s.check("window not open yet: none", dl(U["A1"]) is None)
    t = a._today_myt()
    set_window(a.GRADEH_CELL_KPI, (t - timedelta(days=5)).isoformat() + " 00:00", (t - timedelta(days=1)).isoformat() + " 23:59")
    s.check("window closed: none", dl(U["A1"]) is None)
    kpi_window(2)
    run(lambda d: d.execute("INSERT OR IGNORE INTO gradeh_appraisals (cycle_id, person_id) VALUES (?,?)", (CID, P["A1"])))
    db.execute("UPDATE gradeh_appraisals SET staff_submitted_at=datetime('now') WHERE person_id=?", (P["A1"],))
    db.commit()
    s.check("KPI already sent: none (nothing for them to do in the window)", dl(U["A1"]) is None)
    db.execute("UPDATE gradeh_appraisals SET staff_submitted_at=NULL WHERE person_id=?", (P["A1"],))
    db.commit()
    s.check("...unsent again: back", dl(U["A1"]) is not None)
    s.check("Route B (no KPI step): none", dl(U["B1"]) is None)
    # the acknowledge step: the deadline is lm_submitted + the deemed days, shown in MYT
    lm_at = datetime.utcnow() - timedelta(days=5)
    run(lambda d: d.execute("INSERT OR IGNORE INTO gradeh_appraisals (cycle_id, person_id) VALUES (?,?)", (CID, P["B1"])))
    db.execute("UPDATE gradeh_appraisals SET lm_submitted_at=? WHERE person_id=?", (lm_at.strftime("%Y-%m-%d %H:%M:%S"), P["B1"]))
    db.commit()
    ack_dt = lm_at + timedelta(days=7, hours=8)
    ak = dl(U["B1"])
    left = (ack_dt.date() - a._today_myt()).days
    s.check("the acknowledge step: the deemed deadline, in the acknowledge words (the deemed line only because a deadline exists)",
            ak and ak["lead"] == ("Acknowledge your appraisal before %s" % a._gh_dl_when(ack_dt, "en") if left > 0 else
                                  "Last day: acknowledge your appraisal tonight, before %s" % ack_dt.strftime("%H:%M"))
            and ak["body"] == "If you do not acknowledge or tell us you do not agree, we will treat it as acknowledged."
            and ak["key"].startswith("dl.gradeh_ack.%s." % ack_dt.date().isoformat()), (ak, left))
    got = run(lambda d: a.gradeh_staff_deadline(d, d.execute("SELECT * FROM gradeh_people WHERE id=?", (P["B1"],)).fetchone()))
    s.check("...read through the one shared reader the page's acknowledge step uses (gradeh_staff_deadline), as a MYT time",
            got and got[0] == "ack" and abs((got[1] - ack_dt).total_seconds()) < 2, got)
    db.execute("UPDATE gradeh_appraisals SET acknowledged_at=datetime('now') WHERE person_id=?", (P["B1"],))
    db.commit()
    s.check("acknowledged: none", dl(U["B1"]) is None)
    db.execute("UPDATE gradeh_appraisals SET acknowledged_at=NULL, lm_submitted_at=NULL WHERE person_id=?", (P["B1"],))
    db.commit()
    rules(on=False)
    s.check("the reminder switched off in Banner: none", dl(U["A1"]) is None)
    rules()
    s.check("an admin (even one on the list): none", dl(SU["id"]) is None)
    pl = items(U["A1"], "other")
    s.check("the rules' places are respected: ticked for the dashboard only, so none on 'other' pages",
            not [x for x in pl if x["kind"] == "deadline"] and [x for x in items(U["A1"], "dashboard") if x["kind"] == "deadline"])
    rules(places=["dashboard", "other"])
    s.check("...ticked for 'other' too: it shows there, with its button",
            [x for x in items(U["A1"], "other") if x["kind"] == "deadline" and x["button"]])
    rules()
    # a person who is not on the list keeps the main cycle's reminder, unchanged
    t = a._today_myt()
    run(lambda d: d.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                            (CID, "pm_results", (t - timedelta(days=1)).isoformat() + " 00:00", (t + timedelta(days=1)).isoformat() + " 23:59")))
    close = t + timedelta(days=1)
    a.reminder_items = lambda d, u: [{"role": "own", "closes_on": close, "url": "/review/journey"}]
    a._DL_CACHE.clear()
    main = dl(EMP["id"])
    gh = dl(U["A1"])
    s.check("a person not on the Grade H list: the main cycle's reminder, its own words",
            main and main["lead"].startswith("Your check-in closes") and main["key"].startswith("dl.own."), main)
    s.check("...while a Grade H person with the same main-cycle part open gets only their Grade H one",
            gh and gh["key"].startswith("dl.gradeh_kpi.") and "check-in" not in gh["lead"] + gh["body"], gh)
    a.reminder_items = _real_items
    a._DL_CACHE.clear()
    os.environ["ONEHR_GRADEH"] = "0"
    s.check("the module off: a Grade H person is no longer on the list, so no Grade H reminder",
            not (dl(U["A1"]) or {"key": ""})["key"].startswith("dl.gradeh_"))
    os.environ["ONEHR_GRADEH"] = "1"
    kpi_window(30)   # the KPI part is dated and open: the cycle opens its parts by date, and an undated Grade H part is not open (2026-10-31)
    run(lambda d: d.execute("DELETE FROM app_settings WHERE key='deadline_reminder'"))

    # ---------------------------------------------------------------- 5. the tour
    s.section("Look around: Start posts, the page opens with ?tour=1, the tour runs over the real page")
    a.app.config["ONEHR_ONBOARDING"] = True
    db.execute("UPDATE users SET display_name='Sam', onboard_picture_at=datetime('now'), onboard_tour_at=NULL WHERE id IN (?,?,?)",
               (U["T1"], U["T2"], U["T3"]))
    db.commit()
    h = C["T1"].get(PAGE).get_data(as_text=True)
    s.check("the last first-sign-in step: the heading, ONE intro line, a Start button that posts step=tour",
            "A quick look around" in h and "We&#39;ll show you your page, one part at a time." in h and 'value="tour"' in h
            and ">Start<" in h and "gh-tour" not in h.replace("gh-tour-", "").replace("gh-touring", "") and "data-tour" not in h)
    s.check("...the three-line list is gone", "Ask OneHR answers questions about this page" not in h and "gh-tour" not in re.sub(r"gh-tour[-\w]*", "", h))
    s.check("...in Bahasa Melayu too", "Kami akan tunjukkan halaman anda" in C["T2"].get(PAGE).get_data(as_text=True))
    s.check("GET with ?tour=1 on that step writes nothing and runs no tour (the person has not pressed Start)",
            one("SELECT onboard_tour_at FROM users WHERE id=?", (U["T1"],)) is None
            and tour_data(C["T1"].get(PAGE + "?tour=1")) is None and one("SELECT onboard_tour_at FROM users WHERE id=?", (U["T1"],)) is None)
    r = C["T1"].post("/my-appraisal/setup", data=csrf(step="tour"))
    s.check("Start (the POST) sets onboard_tour_at, and redirects to the page with the flag",
            r.status_code == 303 and r.headers["Location"].endswith(PAGE + "?tour=1")
            and one("SELECT onboard_tour_at FROM users WHERE id=?", (U["T1"],)) is not None, r.headers.get("Location"))
    s.check("...and with no script the redirect still lands on their page (the step is complete)",
            "gh-steps-card" in C["T1"].post("/my-appraisal/setup", data=csrf(step="tour"), follow_redirects=True).get_data(as_text=True))
    # the tour GET writes nothing
    C["T1"].get(PAGE)   # any lazy step has run
    before_tables, before_user = tables_count(), tuple(user_row(U["T1"]))
    r = C["T1"].get(PAGE + "?tour=1")
    s.check("GET /my-appraisal?tour=1 writes nothing (every table's row count, and the user row, unchanged)",
            r.status_code == 200 and tables_count() == before_tables and tuple(user_row(U["T1"])) == before_user,
            {k: (before_tables[k], v) for k, v in tables_count().items() if before_tables.get(k) != v})
    td = tour_data(r)
    en = {k: a.GRADEH_STAFF_T[k][0] for k in a.GRADEH_STAFF_T}
    bmw = {k: a.GRADEH_STAFF_T[k][1] for k in a.GRADEH_STAFF_T}
    s.check("the KPI step carries all five stops, in order, in English",
            td and [x["id"] for x in td["stops"]] == ["steps", "kpis", "send", "ask", "acct"]
            and [x["t"] for x in td["stops"]] == ["Your steps", "Your KPIs", "Send", "Ask OneHR", "Language and log out"]
            and td["stops"][0]["x"] == "Your page shows what to do next, one step at a time. The step marked Now is yours."
            and td["stops"][1]["x"] == "Type your achievement for each KPI here. It saves as you type."
            and td["stops"][2]["x"] == "When every KPI is filled in, send them to your line manager. Once sent, they cannot be changed."
            and td["stops"][3]["x"] == "Ask anything about this page here."
            and td["stops"][4]["x"] == "The button at the top right changes the language and logs you out.", td)
    s.check("...the card's words come with it (Next, Done, Skip, 'n of N', the column's sub-title)",
            td and td["ui"]["next"] == "Next" and td["ui"]["done"] == "Done" and td["ui"]["skip"] == "Skip"
            and td["ui"]["k"] == "Look around · {n} of {m}" and "{list}" in td["ui"]["rest"] and td["ui"]["sub"], td and td["ui"])
    s.check("the Ask OneHR stop picks the column at 1024px and up and the card under it",
            td and [x for x in td["stops"] if x["id"] == "ask"][0]["sel"] == ".gh-ask"
            and [x for x in td["stops"] if x["id"] == "ask"][0]["sel_phone"] == ".gh-askcard")
    s.check("a plain GET (no flag) carries no tour, and neither does any other value",
            tour_data(C["T1"].get(PAGE)) is None and tour_data(C["T1"].get(PAGE + "?tour=0")) is None
            and tour_data(C["T1"].get(PAGE + "?tour=yes")) is None)
    C["T1"].post("/my-appraisal/language", data=csrf(lang="bm"))
    tb = tour_data(C["T1"].get(PAGE + "?tour=1"))
    s.check("in Bahasa Melayu the same stops speak it", tb and [x["t"] for x in tb["stops"]] ==
            ["Langkah anda", "KPI anda", "Hantar", "Tanya OneHR", "Bahasa dan keluar"] and tb["ui"]["skip"] == "Langkau"
            and tb["ui"]["done"] == "Selesai" and tb["stops"][0]["x"] != td["stops"][0]["x"], tb)
    C["T1"].post("/my-appraisal/language", data=csrf(lang="en"))
    for k in ("T2", "T3"):   # their first sign-in is over (the tour step done), so the page is theirs
        db.execute("UPDATE users SET onboard_tour_at=datetime('now') WHERE id=?", (U[k],))
    db.commit()
    tw = tour_data(C["T2"].get(PAGE + "?tour=1"))
    s.check("Route B (waiting, no KPI cards): no KPI stops, the rest stay", tw and [x["id"] for x in tw["stops"]] == ["steps", "ask", "acct"], tw)
    set_window(a.GRADEH_CELL_KPI, "2020-01-01 00:00", "2020-01-02 23:59")
    tc = tour_data(C["T3"].get(PAGE + "?tour=1"))
    s.check("a KPI window that is closed: the KPI cards stay, the Send button is not on the page, so no Send stop",
            tc and [x["id"] for x in tc["stops"]] == ["steps", "kpis", "ask", "acct"], tc)
    kpi_window(30)   # the KPI part is dated and open: the cycle opens its parts by date, and an undated Grade H part is not open (2026-10-31)
    # every stop's selector is on the page it comes with
    h = C["T1"].get(PAGE + "?tour=1").get_data(as_text=True)
    on_page = {".gh-steps-card": "gh-steps-card", ".gh-kpi": 'gh-card gh-kpi"', "#gh-kpi > .gh-btn": 'id="gh-kpi"',
               ".gh-ask": 'class="gh-ask"', ".gh-askcard": 'class="gh-askcard"', ".gh-acct-btn": 'class="gh-acct-btn"'}
    s.check("every stop's selector names something the page draws", all(
        on_page[x["sel"]] in h and (not x["sel_phone"] or on_page[x["sel_phone"]] in h) for x in td["stops"]), td["stops"])
    s.check("the page loads the script that runs it", "gradeh_staff.js" in h)
    s.check("the script: runs from data-tour, Esc skips, the page goes inert, real buttons, no confirm()/alert()",
            all(x in js for x in ("data-tour", '"Escape"', "inert", 'el("button"', "gh-tour-dim", "matchMedia(\"(min-width: 1024px)\")",
                                  "scrollBy", "aria-modal")) and "confirm(" not in js and "alert(" not in js)
    s.check("the script writes nothing: no fetch or form post inside the tour",
            "fetch(" not in js.split("/* ---- Look around")[1])
    a.app.config["ONEHR_ONBOARDING"] = bool(_ONB0)

    # ---------------------------------------------------------------- strings
    s.section("every new string is in English and Bahasa Melayu")
    new = [k for k in a.GRADEH_STAFF_T if k.startswith(("tour_", "dl_"))]
    s.check("the tour and reminder keys are there", {"tour_p", "tour_k", "tour_next", "tour_done", "tour_skip", "tour_rest", "tour_s1_t",
                                                   "tour_s5", "dl_kpi_lead", "dl_kpi_body", "dl_kpi_body_1", "dl_kpi_last", "dl_kpi_last_body",
                                                   "dl_ack_lead", "dl_ack_body", "dl_ack_last", "dl_ack_last_body"} <= set(new), new)
    s.check("the old three-line list's keys are gone (nothing reads them)", not {"tour_1", "tour_2", "tour_3"} & set(a.GRADEH_STAFF_T))
    s.check("each one has English and Bahasa Melayu, never empty, never the same words", all(
        isinstance(a.GRADEH_STAFF_T[k], tuple) and len(a.GRADEH_STAFF_T[k]) == 2 and all(x.strip() for x in a.GRADEH_STAFF_T[k])
        and a.GRADEH_STAFF_T[k][0] != a.GRADEH_STAFF_T[k][1] for k in new if k != "tour_btn"), [k for k in new if a.GRADEH_STAFF_T[k][0] == a.GRADEH_STAFF_T[k][1]])
    ph = lambda t: sorted(re.findall(r"\{(\w+)\}", t))   # noqa: E731
    s.check("...with the same {fields} in both", all(ph(a.GRADEH_STAFF_T[k][0]) == ph(a.GRADEH_STAFF_T[k][1]) for k in a.GRADEH_STAFF_T))
    bad = [k for k in new for t in a.GRADEH_STAFF_T[k] if re.search(r"\b(JG H|Grade H|Gred H|Reopen|HR|HRBP)\b", t)]
    s.check("staff text never says JG H, Grade H, Reopen or HR", not bad, bad)
    s.check("the reminder words are real sentences with the date, time and days-left fields", "{d}" in a.GRADEH_STAFF_T["dl_kpi_lead"][0]
            and "{d}" in a.GRADEH_STAFF_T["dl_ack_lead"][1] and "{t}" in a.GRADEH_STAFF_T["dl_kpi_last"][1] and "{n}" in a.GRADEH_STAFF_T["dl_kpi_body"][1])

    # ---------------------------------------------------------------- CSS
    s.section("the CSS: the bar and banner pinned, the Ask column under both, one outline on a field")

    def rule(src, selector):
        m = re.search(r"(?:^|\})\s*" + re.escape(selector) + r"\s*\{([^}]*)\}", re.sub(r"/\*.*?\*/", "", src, flags=re.S))
        return m.group(1) if m else ""

    def pinned(src):
        r = rule(src, ".gh-bar")
        return "position: sticky" in r and "top: 0" in r and "z-index: 890" in r and "position: relative" not in r

    s.check("the bar is sticky at top 0 with .topbar's z-index (890)", pinned(css))
    s.check("...falsified: the old rule (relative, z-index 30) fails the same check",
            not pinned(css.replace("position: sticky; top: 0; z-index: 890", "position: relative; z-index: 30")))
    stripped = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    mirrored = all(x in stripped for x in (
        "html:has(#gh-page), html:has(#ghl-page.is-bar) { --topbar-h: 60px; }",
        "html:has(#gh-page):has(#site-notice:not([hidden]):not(.is-auth))", "html:has(#gh-page):has(#site-ann:not([hidden]):not(.is-auth))",
        "html:has(#ghl-page.is-bar):has(#site-notice:not([hidden]):not(.is-auth))", "{ --topbar-h: calc(60px + var(--sn-h, 49px)); }",
        "html:has(#gh-page) #site-notice-slot:has(> .sn-bar:not(.is-auth):not([hidden])),", "{ top: 60px; }",
        "html:has(#gh-page) .sn-bar:not(.is-auth), html:has(#ghl-page.is-bar) .sn-bar:not(.is-auth) { top: 60px; }",
        "html:has(#gh-page) .sn-saved, html:has(#ghl-page.is-bar) .sn-saved { top: calc(60px + var(--sn-h, 49px)); }"))
    s.check("the banner rules are mirrored for the 60px bar (slot sticky at 60px, --topbar-h = 60px + the banner, .sn-saved under both), on both pages", mirrored)
    s.check("...every one of them keyed on a page's own id, never a bare class (test_page_layout_keys)",
            not re.search(r"body:has\(\.[\w-]+", stripped) and not re.search(r"html:has\(\.[\w-]+", stripped))
    s.check("...and the originals they mirror are still style.css's (56px bar; the slot, the bar and the saved row)",
            all(x in base_css for x in ("#site-notice-slot:has(> .sn-bar:not(.is-auth):not([hidden])) { position: sticky; top: 56px; z-index: 889; }",
                                         "html:has(#site-notice:not([hidden]):not(.is-auth))", ".sn-saved { position: sticky; top: calc(56px + var(--sn-h, 49px))")))
    ask = rule(css.split("@media (min-width: 1024px)")[1], ".gh-ask") if "@media (min-width: 1024px)" in css else ""
    s.check("the Ask OneHR column starts under bar + banner: top and height read --topbar-h",
            "top: var(--topbar-h, 60px)" in ask and "height: calc(100vh - var(--topbar-h, 60px))" in ask, ask)
    s.check("...nothing on the page still counts the bar as a fixed 60px (the layout and setup min-heights read it too)",
            "calc(100vh - 60px)" not in stripped)
    s.check("the account panel opens inside the bar: the bar's stacking context (890) is over the banner's slot (889), so it opens on top",
            "z-index: 890" in rule(css, ".gh-bar") and "top: 60px; z-index: 889" in base_css.replace("{ position: sticky; top: 56px; z-index: 889; }", "top: 60px; z-index: 889;")
            and ".gh-acct-panel { position: absolute;" in css)
    # one outline
    inp_focus = rule(css, ".gh-inp:focus-within")
    s.check("a wrapped KPI / name box shows focus on the wrapper: navy 1.5px border (padding keeps its size) and one 3px ring",
            "border: 1.5px solid var(--accent-line)" in inp_focus and "padding: 0 13.5px" in inp_focus and "box-shadow: 0 0 0 3px var(--d-sh-252a59-a16)" in inp_focus, inp_focus)
    ring_off = lambda src, sel: "box-shadow: none" in rule(src, sel) and "outline: none" in rule(src, sel)   # noqa: E731
    sel_in = ".gh-inp input:focus, .gh-inp input:focus-visible, .gh-ask-box input:focus, .gh-ask-box input:focus-visible"
    s.check("the input inside a wrapped field gets no ring or outline (the global input:focus-visible ring is cancelled)", ring_off(css, sel_in))
    s.check("...falsified: without the cancelling rule the check fails",
            not ring_off(css.replace(sel_in + " { outline: none; box-shadow: none; border: 0; }", ""), sel_in))
    s.check("...the cancelling rule is more specific than style.css's `input:focus-visible` (0,1,1): class + class + element",
            ".gh-inp input:focus-visible" in css and "\ninput:focus-visible, select:focus-visible, textarea:focus-visible {" in base_css)
    ask_focus = rule(css, ".gh-ask-box:focus-within")
    s.check("Ask OneHR's box: the same single navy outline (AI red stays on the send square)",
            "border: 1.5px solid var(--accent-line)" in ask_focus and "0 0 0 3px var(--d-sh-252a59-a16)" in ask_focus and "var(--ai)" in rule(css, ".gh-ask-send"), ask_focus)
    s.check("a plain textarea keeps the global single ring (no wrapper rule, no cancelling rule)",
            ".gh-note textarea:focus" in css and "box-shadow: none" not in rule(css, ".gh-note textarea:focus-visible"))
    s.check("the calibration page's list search has the same single outline", "box-shadow: none" in rule(
        calib_css, ".ghc-listsearch input:focus, .ghc-listsearch input:focus-visible"))
    tpl = open(os.path.join(ROOT, "templates", "my_appraisal.html"), encoding="utf-8").read()
    texts = [m for m in re.finditer(r"<input\b[^>]*>", tpl) if not re.search(r'type="(hidden|radio|checkbox)"', m.group(0))]
    s.check("every text input on the staff page sits inside a .gh-inp or .gh-ask-box wrapper that the rules above cover (%d found)" % len(texts),
            texts and all(re.search(r'class="(gh-inp|gh-ask-box)"', tpl[max(0, m.start() - 160):m.start()]) for m in texts),
            [m.group(0)[:60] for m in texts])
    lm_src = open(os.path.join(ROOT, "templates", "gradeh_lm.html"), encoding="utf-8").read()
    s.check("the Grade H supervisor's page (gradeh_lm.html with gh_bar) loads this CSS and carries the id the mirrored rules key on",
            "gradeh_staff.css" in lm_src and 'id="ghl-page"' in lm_src and "is-bar" in lm_src)
finally:
    a.reminder_items = _real_items
    a._DL_CACHE.clear()
    os.environ["ONEHR_GRADEH"] = _ENV0 if _ENV0 is not None else ""
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    a.app.config["ONEHR_ONBOARDING"] = bool(_ONB0)
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE cycles SET half=? WHERE id=?", (HALF0, CID))
        d.execute("DELETE FROM site_announcements")
        d.execute("DELETE FROM app_settings WHERE key='deadline_reminder'")
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        d.commit()

sys.exit(s.done())
