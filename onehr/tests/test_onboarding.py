"""The first sign-in: what to call them, a picture, a look around; and Settings (Chris, 2026-10-15: "For existing and
new user, add a step after user logs in, agent to ask for their display name/what to call them, and saved for the user,
make it a mandatory prestep before user can click/move around the interface (dim the other and only show the chat as
active). Also, allow user to go to setting to change their profile photo"; then 12 avatars, then a 13th, a picture step
after the name, and a look around the dashboard; canvas "OneHR Display Name and Avatar").

His calls: only the person sees their display name and picture; avatars only, no uploads.

What this suite holds:
  * a name is checked by rule: "call me sam" is Sam; a sentence, digits, a command or 31 characters are not names
  * until they're done, every page they open goes to the dashboard (page loads only), where the guide asks and the
    rest is dimmed and inert; an admin never sees it
  * name (checked back, then saved) -> picture (initials or 1..38, under three headings) -> tour (finished or
    skipped) -> the dashboard
  * their name and picture show to them (greeting, top bar); the display name is read only where the person themselves
    is greeted -- a structural check over app.py
  * Settings changes both, refusing what isn't a name; "show me around again" starts the tour over

Synthetic people (ZZOB-*) on the shared suite database, removed at the end; the gate is switched on for this suite.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("First sign-in -- a name, a picture, a look around; Settings")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BG, _EMP = H.actors(a)


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZOB-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.commit()


def me(uid, stamp=True):
    """The users row. `stamp=False` leaves out last_seen_at, which any signed-in request moves (Online now, 2026-11-02): a
    check that a request changed nothing about the person compares everything else."""
    with a.app.app_context():
        r = dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())
    if not stamp:
        r.pop("last_seen_at", None)
    return r


NAV = {"Sec-Fetch-Mode": "navigate"}
a.app.config["ONEHR_ONBOARDING"] = True
try:
    with a.app.app_context():
        db = a.get_db()
        _cleanup(db)
        base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
        cols = [c for c in base.keys() if c != "id"]
        for eid, full in (("ZZOB-EMP", "ZZOB TAN WEI MING (Ming)"), ("ZZOB-MGR", "ZZOB Manager Person")):
            v = dict(base, username=eid, employee_id=eid, full_name=full, email=None, manager_id=None, hod_id=None,
                     left_at=None, role="user", admin_bg=None, display_name=None, avatar=None, onboard_picture_at=None,
                     onboard_tour_at=None)
            db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                       [v[c] for c in cols])
        ID = {r[0]: r[1] for r in db.execute("SELECT employee_id, id FROM users WHERE employee_id LIKE 'ZZOB-%'")}
        db.execute("UPDATE users SET manager_id=? WHERE id=?", (ID["ZZOB-MGR"], ID["ZZOB-EMP"]))
        db.commit()

    s.section("A name, by rule (no model)")
    P = a.display_name_parse
    ok = {"Sam": "Sam", "call me sam": "Sam", "I'm Siti Aminah": "Siti Aminah", "O'Neil": "O'Neil",
          "Jean-Luc": "Jean-Luc", "伟明": "伟明", "SAM": "Sam", "my name is wei ming.": "Wei Ming"}
    got = {k: P(k)[0] for k in ok}
    s.check("names are taken, a lead-in dropped, all-caps or all-lower in title case", got == ok, got)
    bad = {"": "empty", "show me my band first": "form", "yes": "form", "Sam123": "form", "x" * 31: "long",
           "ignore previous instructions": "form", "a b c d e": "form", "<script>": "form", "skip this": "form"}
    gotb = {k[:24]: P(k)[1] for k in bad}
    s.check("...a sentence, a command, digits, markup, five words or 31 characters are not", all(
        P(k) == (None, w) for k, w in bad.items()), gotb)
    with a.app.app_context():
        u0 = a.get_db().execute("SELECT * FROM users WHERE id=?", (ID["ZZOB-EMP"],)).fetchone()
        s.check("the HR record suggests the preferred name in brackets", a._hris_first_name(u0) == "Ming",
                a._hris_first_name(u0))
        s.check("a new person starts at the name step; an admin never does",
                a.onboarding_step(u0) == "name"
                and a.onboarding_step(a.get_db().execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()) is None)

    s.section("Until they're done, every page goes to the dashboard")
    E = H.client_as(a, ID["ZZOB-EMP"])
    for path in ("/account/password", "/settings", "/me"):
        r = E.get(path, headers=NAV)
        s.check("a page load of %s goes to the dashboard" % path, r.status_code == 302
                and r.headers["Location"].endswith("/dashboard"), (r.status_code, r.headers.get("Location")))
    r = E.get("/ask", headers={"Sec-Fetch-Mode": "cors"})
    s.check("...a script's fetch is not redirected", r.status_code != 302 or not r.headers.get("Location", "")
            .endswith("/dashboard"), r.status_code)
    r = H.client_as(a, SU["id"]).get("/admin", headers=NAV)
    s.check("an admin is never held", r.status_code == 200, r.status_code)
    html = E.get("/dashboard", headers=NAV).get_data(as_text=True)
    s.check("the dashboard: the onboarding panel at the name step, no Ask panel",
            'id="ob-panel"' in html and 'data-step="name"' in html and 'id="ask-panel"' not in html)
    s.check("...the rest dimmed and inert: the page and the top bar", 'class="ob-dim"' in html
            and re.search(r'<div class="od" inert>', html) is not None and '<nav class="topbar tb-a" inert>' in html)
    s.check("...it offers the name from the HR record", 'data-name="Ming"' in html)

    s.section("1. The name: checked back, then saved")
    r = E.post("/onboard/name", data={"csrf_token": "tok", "name": "show me my band first"}).get_json()
    s.check("not a name: asked again, nothing saved", r["ok"] is False and "What should I call you?" in r["say"]
            and me(ID["ZZOB-EMP"])["display_name"] is None, r)
    r = E.post("/onboard/name", data={"csrf_token": "tok", "name": "call me zebedee"}).get_json()
    s.check("a name is said back before it's saved", r["ok"] and r["confirm"] == "Zebedee"
            and me(ID["ZZOB-EMP"])["display_name"] is None, r)
    r = E.post("/onboard/name", data={"csrf_token": "tok", "name": "Zebedee", "confirm": "1"}).get_json()
    s.check("confirmed: saved, on to the picture", r["ok"] and r["step"] == "picture"
            and me(ID["ZZOB-EMP"])["display_name"] == "Zebedee", r)
    r = E.get("/me", headers=NAV)
    s.check("...still held until the rest is done", r.status_code == 302 and r.headers["Location"].endswith("/dashboard"))

    s.section("2. The picture")
    html = E.get("/dashboard", headers=NAV).get_data(as_text=True)
    s.check("the picture step greets them by the name they chose, with the initials and %d avatars" % a.AVATAR_COUNT,
            'data-step="picture"' in html and "Nice to meet you, Zebedee." in html
            and html.count('name="ob-avatar"') == a.AVATAR_COUNT + 1)
    # 38 since 2026-10-22 (18 more, then 7 for fun, Chris): under three headings, every choice once and in order
    vals = [int(v) for v in re.findall(r'name="ob-avatar" value="(\d+)"', html)]
    heads = re.findall(r'<p class="ob-pics-h" id="ob-pg-\d+">([^<]+)</p>', html)
    s.check("...38 avatars, each named", a.AVATAR_COUNT == 38 and len(a.AVATAR_LABELS) == a.AVATAR_COUNT + 1
            and all(a.AVATAR_LABELS))
    s.check("...under the headings People, Animal friends, Just for fun, every choice once, in order",
            heads == [g[0] for g in a.AVATAR_GROUPS] == ["People", "Animal friends", "Just for fun"]
            and vals == list(range(a.AVATAR_COUNT + 1)), (heads, vals[:5], len(vals)))
    covered = [n for _g, lo, hi in a.AVATAR_GROUPS for n in range(lo, hi + 1)]
    s.check("...the headings cover 0..AVATAR_COUNT with no gap or overlap", covered == list(range(a.AVATAR_COUNT + 1)),
            covered)
    r = E.post("/onboard/picture", data={"csrf_token": "tok", "avatar": "99"})
    s.check("a picture that isn't one is refused", r.status_code == 400 and me(ID["ZZOB-EMP"])["onboard_picture_at"] is None)
    r = E.post("/onboard/picture", data={"csrf_token": "tok", "avatar": str(a.AVATAR_COUNT + 1)})
    s.check("...one past the last, too", r.status_code == 400 and me(ID["ZZOB-EMP"])["onboard_picture_at"] is None)
    r = E.post("/onboard/picture", data={"csrf_token": "tok", "avatar": "13"}).get_json()
    m_ = me(ID["ZZOB-EMP"])
    s.check("avatar 13: saved, on to the tour", r["ok"] and r["step"] == "tour" and m_["avatar"] == 13
            and m_["onboard_picture_at"], (r, m_["avatar"]))
    s.check("every avatar file exists", all(os.path.isfile(os.path.join(H.REPO, "static", "avatars", "a%d.svg" % n))
                                            for n in range(1, a.AVATAR_COUNT + 1)))

    s.section("3. The look around")
    html = E.get("/dashboard", headers=NAV).get_data(as_text=True)
    s.check("the tour step, with their picture and name in the top bar already", 'data-step="tour"' in html
            and 'src="/static/avatars/a13.svg"' in html and '<b>Zebedee</b>' in html)
    r = E.post("/onboard/tour", data={"csrf_token": "tok"}).get_json()
    s.check("finished (or skipped): done", r["ok"] and r["step"] is None and me(ID["ZZOB-EMP"])["onboard_tour_at"])
    r = E.get("/account/password", headers=NAV)
    s.check("pages open again", r.status_code == 200, (r.status_code, r.headers.get("Location")))
    html = E.get("/dashboard", headers=NAV).get_data(as_text=True)
    s.check("the dashboard is theirs: the Ask panel, nothing dimmed or inert", 'id="ask-panel"' in html
            and 'id="ob-panel"' not in html and 'class="ob-dim"' not in html and '<div class="od">' in html)
    s.check("...the guide greets them by their name", "Hi Zebedee." in html)
    s.check("...the Account menu keeps the official name on top, and offers their Profile (was Settings)",
            "ZZOB TAN WEI MING (Ming)" in html and "Your name on your records" in html
            and '<a href="/profile" role="menuitem">Profile</a>' in html)
    with a.app.app_context():
        wi = a.welcome_identity(a.get_db().execute("SELECT * FROM users WHERE id=?", (ID["ZZOB-EMP"],)).fetchone())
    s.check("the greeting every page and their own AI use is the chosen name", wi["first_name"] == "Zebedee"
            and wi["initials"] == "ZE", wi)
    r = E.post("/onboard/tour", data={"csrf_token": "tok", "again": "1"}).get_json()
    s.check("'show me around again' starts the tour over", r["step"] == "tour")
    E.post("/onboard/tour", data={"csrf_token": "tok"})

    s.section("Only they see it")
    src = H.source(a)
    allowed = {"inject_user", "welcome_identity", "onboarding_step", "_save_display_name", "onboard_name", "onboard_tour",
               "my_settings", "dashboard", "_ensure_runtime_schema",
               "demo_onboarding_reset",   # clears it, for a staging demo account's restart (2026-10-16)
               # Grade H's own page greets the person by it and runs the same first sign-in steps (2026-10-28)
               "my_appraisal", "_my_appraisal_render", "my_appraisal_setup", "gradeh_staff_view", "_gh_lm_page_ctx",
               # every OneHR email greets them by it (Chris, 2026-10-17), and only through this one gate, which gives
               # an address several people share the full name instead
               "email_names"}
    readers = set()
    for m in re.finditer(r'display_name', src):
        head = src[:m.start()]
        fn = re.findall(r"\ndef (\w+)\(", head)
        line = src[src.rfind("\n", 0, m.start()) + 1:src.find("\n", m.start())]
        if (line.lstrip().startswith(("#", "def ")) or "display_name_parse" in line or "DISPLAY_NAME" in line
                or '"display_name", "avatar"' in line or '"display_name": "Chose' in line
                or 'log_activity(db, u["id"], "display_name")' in line
                # an email's greeting goes through email_names(); {display_name} is the reminder template's placeholder
                or "email_names(" in line or "{display_name}" in line or "REMINDER_PLACEHOLDERS" in line
                # ...and the leader progress email's (2026-10-19), greeting through email_names() too
                or "LP_PLACEHOLDERS" in line
                # ...and the two release emails' (templates, 2026-10-24), greeting through email_names() too
                or "RELEASE_LEAD_PLACEHOLDERS" in line or "RELEASE_PERSON_PLACEHOLDERS" in line
                # ...and the release window's two emails' (2026-10-26), greeting through email_names() too
                or "NOTICE_BEFORE_PLACEHOLDERS" in line or "NOTICE_AFTER_PLACEHOLDERS" in line
                # ...and Grade H's "your appraisal is ready" email's (2026-10-28), greeting through email_names() too
                or "GRADEH_READY_PLACEHOLDERS" in line
                # ...and its "your result is released" email's (piece 6), the same: the greeting goes through email_names()
                or "GRADEH_RESULT_PLACEHOLDERS" in line
                # ...and the ready notices' (2026-11-02), the greeting goes through email_names() too
                or "READY_PLACEHOLDERS" in line
                # ...and Grade H progress's and its ready notes' (2026-11-09): the same, the greeting goes through email_names()
                or "GH_PROG_PLACEHOLDERS" in line or "GH_READY_PLACEHOLDERS" in line
                # ...and the "something changed on your check-in" email's (2026-11-06), the same
                or "REDO_PLACEHOLDERS" in line
                # ...and Talent Box Round 2's email to the BG CEO (2026-11-15), the same: the greeting goes through email_names()
                or "TB_ROUND_PLACEHOLDERS" in line):
            continue
        readers.add(fn[-1] if fn else "<module>")
    readers -= {"SELF_SERVICE_ACTIONS", "<module>"}
    s.check("the display name is read only where the person themselves is greeted or set it up", readers <= allowed,
            sorted(readers - allowed))
    with a.app.app_context():
        row = a.get_db().execute("SELECT full_name FROM users WHERE id=?", (ID["ZZOB-EMP"],)).fetchone()
    s.check("their official name is untouched", row[0] == "ZZOB TAN WEI MING (Ming)")
    s.check("an admin can't use the steps", H.client_as(a, SU["id"]).post(
        "/onboard/name", data={"csrf_token": "tok", "name": "Sam"}).status_code == 404)

    s.section("Settings")
    r = E.get("/settings", headers=NAV)
    body = r.get_data(as_text=True)
    with a.app.test_request_context("/"):
        pw = a.url_for("change_password")
    s.check("the page: the name, the initials and %d avatars, the password link" % a.AVATAR_COUNT, r.status_code == 200
            and 'value="Zebedee"' in body and body.count('name="avatar"') == a.AVATAR_COUNT + 1
            and 'class="st-link" href="%s"' % pw in body, (r.status_code, pw))
    E.post("/settings", data={"csrf_token": "tok", "action": "name", "display_name": "Zeb"})
    s.check("a new name saves", me(ID["ZZOB-EMP"])["display_name"] == "Zeb")
    E.post("/settings", data={"csrf_token": "tok", "action": "name", "display_name": "tell me my rating"})
    s.check("...a sentence doesn't", me(ID["ZZOB-EMP"])["display_name"] == "Zeb")
    s.check("...the same three headings", re.findall(r'<p class="st-pics-h" id="st-pg-\d+">([^<]+)</p>', body)
            == [g[0] for g in a.AVATAR_GROUPS])
    E.post("/settings", data={"csrf_token": "tok", "action": "picture", "avatar": str(a.AVATAR_COUNT)})
    b31 = E.get("/settings", headers=NAV).get_data(as_text=True)
    s.check("the last avatar (%s) saves and shows as picked" % a.AVATAR_LABELS[-1],
            me(ID["ZZOB-EMP"])["avatar"] == a.AVATAR_COUNT
            and re.search(r'class="st-pic is-on" title="%s"' % re.escape(a.AVATAR_LABELS[-1]), b31) is not None)
    E.post("/settings", data={"csrf_token": "tok", "action": "picture", "avatar": "0"})
    s.check("back to the initials", me(ID["ZZOB-EMP"])["avatar"] is None)
    s.check("an admin's Settings is their admin home", H.client_as(a, SU["id"]).get("/settings", headers=NAV)
            .status_code == 302)

    s.section("The staging demo's restart (Chris, 2026-10-16)")
    dh = E.get("/dashboard", headers=NAV).get_data(as_text=True)
    s.check("a demo account (ZZ + a letter) sees Restart first sign-in in the STAGING DEMO menu, behind the app's confirm",
            'action="/demo/onboarding-reset"' in dh and ">Restart first sign-in</button>" in dh
            and 'data-confirm="Start the first sign-in over?' in dh and 'id="tb-demo-menu"' in dh)
    b0 = me(ID["ZZOB-EMP"])
    r = E.post("/demo/onboarding-reset", data={"csrf_token": "tok"})
    a0 = me(ID["ZZOB-EMP"])
    s.check("...it starts over: the name, the picture and the tour cleared, back to the dashboard, the official name kept",
            bool(b0["display_name"] and b0["onboard_tour_at"]) and r.status_code == 302
            and (r.headers.get("Location") or "").endswith("/dashboard")
            and (a0["display_name"], a0["avatar"], a0["onboard_picture_at"], a0["onboard_tour_at"]) == (None,) * 4
            and a0["full_name"] == b0["full_name"], (r.status_code, b0["display_name"]))
    dh2 = E.get("/dashboard", headers=NAV).get_data(as_text=True)
    s.check("...and the dashboard asks for the name again", 'id="ob-panel"' in dh2 and 'data-step="name"' in dh2)
    real = _EMP["id"]
    rb = me(real, stamp=False)
    rr = H.client_as(a, real).post("/demo/onboarding-reset", data={"csrf_token": "tok"})
    s.check("anyone else gets a 404 and nothing changes: an account that isn't a demo one",
            not a.is_demo_account(rb) and rr.status_code == 404 and me(real, stamp=False) == rb, rr.status_code)
    s.check("...and sees no button", "Restart first sign-in" not in H.client_as(a, real).get("/dashboard")
            .get_data(as_text=True))
    s.check("...an admin", H.client_as(a, SU["id"]).post("/demo/onboarding-reset", data={"csrf_token": "tok"})
            .status_code == 404)
    _demo_env = os.environ.get("L360_DEMO_ACCOUNTS")
    os.environ["L360_DEMO_ACCOUNTS"] = "0"
    try:
        E.post("/onboard/name", data={"csrf_token": "tok", "name": "Zeb", "confirm": "1"})
        z0 = me(ID["ZZOB-EMP"])
        rz = E.post("/demo/onboarding-reset", data={"csrf_token": "tok"})
        s.check("...and a server without demo accounts (production): a 404 even for a ZZ account, nothing changes",
                rz.status_code == 404 and me(ID["ZZOB-EMP"]) == z0 and z0["display_name"] == "Zeb", rz.status_code)
    finally:
        if _demo_env is None:
            os.environ.pop("L360_DEMO_ACCOUNTS", None)
        else:
            os.environ["L360_DEMO_ACCOUNTS"] = _demo_env

    s.section("Switched off (the suites' default)")
    a.app.config["ONEHR_ONBOARDING"] = False
    r = H.client_as(a, ID["ZZOB-MGR"]).get("/account/password", headers=NAV)
    s.check("no one is held (the manager never got started, and opens a page)", r.status_code == 200, r.status_code)
finally:
    a.app.config["ONEHR_ONBOARDING"] = False
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
