"""Text size and Theme (Chris, 2026-11-01: "small (-12.5%), standard, larger, XL" and dark mode; canvas
[design canvas link removed] boards A1 and A2; Phases 1 and 2 of OneHR/Dark mode and text size plan 2026-11-01.md).

A person's own settings, kept on their account (users.ui_text_size: s | m | l | xl, default m; users.ui_theme: light | dark | auto,
default light), written on every page as <html data-text data-theme>, changed from the Account menu through POST /me/display, one
writer (_display_pref_set). Either field may come alone.

What this suite holds (the suite database's own people; their old sizes are put back at the end):
  * the columns exist in the live schema AND in SCHEMA (a fresh install), NOT NULL, default 'm' and 'light'
  * the route: no token is refused (400), a bad value is refused (400, nothing stored), each good value is stored and answered
    in JSON, a signed-out request is refused (403), a persona's choice goes to the signed-in ACCOUNT
  * the page: each stored size renders on <html data-text>, a sign-in page and a signed-out page render m whatever is stored,
    a stored value that is not one of the four renders m, a super admin and a BG admin can set it too and see it
  * the control: the Account menu carries the Text size radiogroup (four buttons, the stored one checked) and, under it in the same
    block, the Theme radiogroup (Light / Dark / Device with their icons, the stored one checked), for staff and for admins
  * the theme: only light, dark, auto; either field alone; a bad value stores nothing (not even the good field beside it); each
    stored theme renders on <html data-theme>; the sign-in pages, signed-out pages and a stored value that is not one of the three
    render light; a super admin and a BG admin can set it; a persona's choice goes to the signed-in account
  * classification: core, never module-gated; no UROLE or admin-access row is needed (the setting is for everyone)
  * what the agents and Help know: the HELP_QA answers and the lists that carry them, the KB rows (seeded by slug), Ask OneHR's
    intents answer "text size", "bigger text", "font" and "dark mode", "night mode", "theme", "black background" in code and leave a
    remark question alone
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Text size: the setting, the route, the page and the menu control")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SRC = open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read()
HTML_RE = re.compile(r'<html lang="en" data-text="([^"]*)"')


def stored(uid):
    return H.one(a, "SELECT ui_text_size FROM users WHERE id=?", (uid,))


def stored_theme(uid):
    return H.one(a, "SELECT ui_theme FROM users WHERE id=?", (uid,))


def stored_theme_at(uid):
    return H.one(a, "SELECT ui_theme_set_at FROM users WHERE id=?", (uid,))


def put_theme_at(uid, value):
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET ui_theme_set_at=? WHERE id=?", (value, uid))
        db.commit()


def put(uid, value):
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET ui_text_size=? WHERE id=?", (value, uid))
        db.commit()


def put_theme(uid, value):
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET ui_theme=? WHERE id=?", (value, uid))
        db.commit()


def post(client, value, token="tok", **extra):
    data = dict(extra)
    if value is not None:
        data["text"] = value
    if token is not None:
        data["csrf_token"] = token
    return client.post("/me/display", data=data)


def post_theme(client, value, token="tok", **extra):
    data = dict(extra)
    if value is not None:
        data["theme"] = value
    if token is not None:
        data["csrf_token"] = token
    return client.post("/me/display", data=data)


def page_size(client, path):
    r = client.get(path)
    m = HTML_RE.search(r.get_data(as_text=True))
    return r.status_code, (m.group(1) if m else None)


THEME_RE = re.compile(r'<html lang="en" data-text="[^"]*" data-theme="([^"]*)"')


def page_theme(client, path):
    r = client.get(path)
    m = THEME_RE.search(r.get_data(as_text=True))
    return r.status_code, (m.group(1) if m else None)


su, bg, emp = H.actors(a)
s.check("(the suite database has a super admin, a BG admin and an employee)", bool(su and bg and emp))
SU, BG, EMP = su["id"], bg["id"], emp["id"]
OLD = {u: stored(u) for u in (SU, BG, EMP)}
OLD_T = {u: stored_theme(u) for u in (SU, BG, EMP)}
OLD_TA = {u: stored_theme_at(u) for u in (SU, BG, EMP)}

try:
    # ------------------------------------------------------------------ the column
    s.section("the column")
    with a.app.app_context():
        cols = {r["name"]: r for r in a.get_db().execute("PRAGMA table_info(users)")}
    c = cols.get("ui_text_size")
    s.check("users.ui_text_size exists in the live schema", c is not None)
    s.check("...NOT NULL, default 'm'", bool(c) and c["notnull"] == 1 and (c["dflt_value"] or "").strip("'\"") == "m", c and dict(c))
    schema_users = H.extract_schema().split("CREATE TABLE IF NOT EXISTS users (", 1)[1].split("idx_users_manager", 1)[0]
    s.check("...and in SCHEMA (a fresh install builds it)", re.search(r"ui_text_size TEXT NOT NULL DEFAULT 'm'", schema_users) is not None)
    s.check("...with its ALTER guard in _ensure_runtime_schema",
            'ALTER TABLE users ADD COLUMN ui_text_size TEXT NOT NULL DEFAULT \'m\'' in SRC)
    s.check("the sizes are the four, in order", a.TEXT_SIZES == ("s", "m", "l", "xl") and a.TEXT_SIZE_DEFAULT == "m")
    ct = cols.get("ui_theme")
    s.check("users.ui_theme exists in the live schema", ct is not None)
    s.check("...NOT NULL, default 'light'", bool(ct) and ct["notnull"] == 1 and (ct["dflt_value"] or "").strip("'\"") == "light", ct and dict(ct))
    s.check("...and in SCHEMA (a fresh install builds it)", re.search(r"ui_theme TEXT NOT NULL DEFAULT 'light'", schema_users) is not None)
    s.check("...with its ALTER guard in _ensure_runtime_schema", "ALTER TABLE users ADD COLUMN ui_theme TEXT NOT NULL DEFAULT 'light'" in SRC)
    s.check("the themes are the three, in order", a.THEMES == ("light", "dark", "auto") and a.THEME_DEFAULT == "light")
    cta = cols.get("ui_theme_set_at")
    s.check("users.ui_theme_set_at exists in the live schema, nullable TEXT with no default",
            cta is not None and cta["notnull"] == 0 and cta["dflt_value"] is None and (cta["type"] or "").upper() == "TEXT", cta and dict(cta))
    s.check("...and in SCHEMA (a fresh install builds it)", re.search(r"ui_theme_set_at TEXT\s*\n", schema_users) is not None)
    s.check("...with its ALTER guard in _ensure_runtime_schema", "ALTER TABLE users ADD COLUMN ui_theme_set_at TEXT" in SRC)

    # ------------------------------------------------------------------ the writer
    s.section("the writer")
    with a.app.app_context():
        db = a.get_db()
        put(EMP, "m")
        s.check("a bad value changes nothing and returns None",
                all(a._display_pref_set(db, EMP, v) is None for v in ("", "xxl", "XL", " l", "L", "100", None, "m;--")) and stored(EMP) == "m")
        s.check("each of the four is stored and returned",
                all(a._display_pref_set(db, EMP, v) == {"text": v} and stored(EMP) == v for v in ("s", "l", "xl", "m")))
        put_theme(EMP, "light")
        s.check("a bad theme changes nothing and returns None",
                all(a._display_pref_set(db, EMP, theme=v) is None for v in ("", "night", "Dark", " dark", "DARK", "1", "dark;--", "device")) and stored_theme(EMP) == "light")
        s.check("each of the three themes is stored alone and returned, and the text size is left as it was",
                all(a._display_pref_set(db, EMP, theme=v) == {"theme": v} and stored_theme(EMP) == v and stored(EMP) == "m" for v in ("dark", "auto", "light")))
        s.check("a size alone leaves the theme as it was",
                a._display_pref_set(db, EMP, "xl") == {"text": "xl"} and stored(EMP) == "xl" and stored_theme(EMP) == "light" and a._display_pref_set(db, EMP, "m") == {"text": "m"})
        s.check("both together are stored, and returned together",
                a._display_pref_set(db, EMP, "l", "dark") == {"text": "l", "theme": "dark"} and stored(EMP) == "l" and stored_theme(EMP) == "dark")
        s.check("a bad value beside a good one stores nothing at all (neither field)",
                a._display_pref_set(db, EMP, "xl", "night") is None and a._display_pref_set(db, EMP, "huge", "auto") is None
                and stored(EMP) == "l" and stored_theme(EMP) == "dark")
        s.check("neither field returns None", a._display_pref_set(db, EMP) is None)
        put(EMP, "m")
        put_theme(EMP, "light")

        # ui_theme_set_at: NULL = never picked (December moves those rows to 'auto')
        put_theme_at(EMP, None)
        s.check("a size-only call leaves ui_theme_set_at NULL",
                a._display_pref_set(db, EMP, "xl") == {"text": "xl"} and stored_theme_at(EMP) is None
                and a._display_pref_set(db, EMP, "m") == {"text": "m"} and stored_theme_at(EMP) is None)
        s.check("a bad theme (alone, or beside a good size) leaves ui_theme_set_at NULL",
                all(a._display_pref_set(db, EMP, theme=v) is None for v in ("", "night", "Dark", "device"))
                and a._display_pref_set(db, EMP, "xl", "night") is None and stored_theme_at(EMP) is None and stored(EMP) == "m")
        s.check("picking Light stamps it (Light is a pick too, not 'never picked')",
                a._display_pref_set(db, EMP, theme="light") == {"theme": "light"} and stored_theme(EMP) == "light"
                and re.fullmatch(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d", stored_theme_at(EMP) or "") is not None, stored_theme_at(EMP))
        for v in ("dark", "auto"):
            put_theme_at(EMP, None)
            s.check("picking %s stamps it" % v, a._display_pref_set(db, EMP, theme=v) == {"theme": v} and stored_theme_at(EMP) is not None, stored_theme_at(EMP))
        put_theme_at(EMP, None)
        s.check("a size and a theme together stamp it", a._display_pref_set(db, EMP, "l", "dark") == {"text": "l", "theme": "dark"} and stored_theme_at(EMP) is not None)
        put(EMP, "m")
        put_theme_at(EMP, "2000-01-01 00:00:00")
        s.check("a second pick updates it (the old time is replaced)",
                a._display_pref_set(db, EMP, theme="dark") == {"theme": "dark"}
                and stored_theme_at(EMP) is not None and stored_theme_at(EMP) > "2000-01-01 00:00:00", stored_theme_at(EMP))
        put_theme_at(EMP, "2000-01-01 00:00:00")
        s.check("...and a size-only call after it leaves the old time as it was",
                a._display_pref_set(db, EMP, "s") == {"text": "s"} and stored_theme_at(EMP) == "2000-01-01 00:00:00")
        put(EMP, "m")
        put_theme(EMP, "light")
        put_theme_at(EMP, None)

    # ------------------------------------------------------------------ the route
    s.section("POST /me/display")
    cl = H.client_as(a, EMP)
    put(EMP, "m")
    r = post(cl, "xl", token=None)
    s.check("no csrf_token is refused (400) and nothing is stored", r.status_code == 400 and stored(EMP) == "m", r.status_code)
    r = post(cl, "xl", token="not-the-token")
    s.check("a wrong token is refused (400)", r.status_code == 400 and stored(EMP) == "m", r.status_code)
    for bad in ("xxl", "", "XL", " l", "huge", "125", "l\n"):
        r = post(cl, bad)
        if not (r.status_code == 400 and stored(EMP) == "m" and (r.get_json(silent=True) or {}).get("ok") is False):
            s.check("a bad value is refused: %r" % bad, False, (r.status_code, stored(EMP)))
            break
    else:
        s.check("a bad value is refused (400, JSON ok:false, nothing stored): xxl, empty, XL, ' l', huge, 125, newline", True)
    r = post(cl, None)
    s.check("a missing value is refused (400)", r.status_code == 400 and stored(EMP) == "m", r.status_code)
    for v in ("s", "l", "xl", "m"):
        r = post(cl, v)
        j = r.get_json(silent=True) or {}
        if not (r.status_code == 200 and j.get("ok") is True and j.get("text") == v and stored(EMP) == v):
            s.check("a good value is stored and answered in JSON: %s" % v, False, (r.status_code, j, stored(EMP)))
            break
    else:
        s.check("each good value (s, l, xl, m) is stored and answered in JSON {ok, text}", True)
    s.check("a GET is not allowed on it", cl.get("/me/display").status_code == 405)
    anon = a.app.test_client()
    with anon.session_transaction() as ss:
        ss["csrf_token"] = "tok"
    put(EMP, "m")
    r = post(anon, "xl")
    s.check("signed out is refused with a valid token (403, JSON) and stores nothing",
            r.status_code == 403 and (r.get_json(silent=True) or {}).get("ok") is False and stored(EMP) == "m", r.status_code)
    s.check("...and without a session at all (the token fails first: 400)", a.app.test_client().post("/me/display", data={"text": "xl"}).status_code in (400, 403))

    s.section("POST /me/display: the theme")
    put_theme(EMP, "light")
    put(EMP, "m")
    r = post_theme(cl, "dark", token=None)
    s.check("no csrf_token is refused (400) and nothing is stored", r.status_code == 400 and stored_theme(EMP) == "light", r.status_code)
    r = post_theme(cl, "dark", token="not-the-token")
    s.check("a wrong token is refused (400)", r.status_code == 400 and stored_theme(EMP) == "light", r.status_code)
    for bad in ("night", "", "Dark", " dark", "device", "black", "dark\n", "light;x"):
        r = post_theme(cl, bad)
        if not (r.status_code == 400 and stored_theme(EMP) == "light" and (r.get_json(silent=True) or {}).get("ok") is False):
            s.check("a bad theme is refused: %r" % bad, False, (r.status_code, stored_theme(EMP)))
            break
    else:
        s.check("a bad theme is refused (400, JSON ok:false, nothing stored): night, empty, Dark, ' dark', device, black, newline, light;x", True)
    for v in ("dark", "auto", "light"):
        r = post_theme(cl, v)
        j = r.get_json(silent=True) or {}
        if not (r.status_code == 200 and j.get("ok") is True and j.get("theme") == v and "text" not in j and stored_theme(EMP) == v and stored(EMP) == "m"):
            s.check("a good theme is stored and answered in JSON: %s" % v, False, (r.status_code, j, stored_theme(EMP), stored(EMP)))
            break
    else:
        s.check("each good theme (dark, auto, light) is stored alone, answered {ok, theme}, and leaves the text size alone", True)
    r = cl.post("/me/display", data={"csrf_token": "tok", "text": "xl", "theme": "dark"})
    j = r.get_json(silent=True) or {}
    s.check("both fields in one post are both stored", r.status_code == 200 and j.get("text") == "xl" and j.get("theme") == "dark" and stored(EMP) == "xl" and stored_theme(EMP) == "dark", (r.status_code, j))
    r = cl.post("/me/display", data={"csrf_token": "tok", "text": "l", "theme": "night"})
    s.check("a bad theme beside a good size stores neither (400)", r.status_code == 400 and stored(EMP) == "xl" and stored_theme(EMP) == "dark", (r.status_code, stored(EMP), stored_theme(EMP)))
    r = cl.post("/me/display", data={"csrf_token": "tok"})
    s.check("a post with neither field is refused (400)", r.status_code == 400, r.status_code)
    put(EMP, "m")
    put_theme(EMP, "light")
    anon2 = a.app.test_client()
    with anon2.session_transaction() as ss:
        ss["csrf_token"] = "tok"
    r = post_theme(anon2, "dark")
    s.check("signed out is refused with a valid token (403, JSON) and stores nothing",
            r.status_code == 403 and (r.get_json(silent=True) or {}).get("ok") is False and stored_theme(EMP) == "light", r.status_code)

    # a demo persona's choice belongs to the signed-in account (a switcher and a persona made here, put back after)
    with a.app.app_context():
        db = a.get_db()
        actor = db.execute("SELECT id, business_group, demo_switcher, demo_persona FROM users WHERE id=?", (EMP,)).fetchone()
        pers = db.execute("SELECT id, demo_persona FROM users WHERE role!='admin' AND left_at IS NULL AND id!=? AND business_group=? "
                          "AND COALESCE(demo_persona,'')='' LIMIT 1", (EMP, actor["business_group"])).fetchone()
        db.execute("UPDATE users SET demo_switcher=1 WHERE id=?", (EMP,))
        if pers:
            db.execute("UPDATE users SET demo_persona='employee' WHERE id=?", (pers["id"],))
        db.commit()
    try:
        s.check("(a switcher and a persona in the same business group exist)", pers is not None)
        if pers is not None:
            PERSONA = pers["id"]
            old2 = {u: stored(u) for u in (EMP, PERSONA)}
            put(EMP, "m")
            put(PERSONA, "m")
            pc = H.client_as(a, EMP)
            with pc.session_transaction() as ss:
                ss["demo_as"] = PERSONA
            with a.app.test_request_context("/dashboard"):
                from flask import session as _fs
                _fs["user_id"] = EMP
                _fs["demo_as"] = PERSONA
                s.check("(the persona is a persona of the signed-in account)", PERSONA in [p["id"] for p in a.demo_personas()])
            r = post(pc, "xl")
            s.check("a persona's choice is saved on the signed-in account, never the persona's row",
                    r.status_code == 200 and stored(EMP) == "xl" and stored(PERSONA) == "m", (stored(EMP), stored(PERSONA)))
            code, size = page_size(pc, "/dashboard")
            s.check("...and the page, while the persona is active, shows the account's size", size == "xl", (code, size))
            put(PERSONA, "l")
            put(EMP, "s")
            code, size = page_size(pc, "/dashboard")
            s.check("...never the persona's own stored size", size == "s", (code, size))
            for u, v in old2.items():
                put(u, v)
            put_theme(EMP, "light")
            put_theme(PERSONA, "light")
            r = post_theme(pc, "dark")
            s.check("a persona's theme is saved on the signed-in account, never the persona's row",
                    r.status_code == 200 and stored_theme(EMP) == "dark" and stored_theme(PERSONA) == "light", (stored_theme(EMP), stored_theme(PERSONA)))
            code, th = page_theme(pc, "/dashboard")
            s.check("...and the page, while the persona is active, shows the account's theme", th == "dark", (code, th))
            put_theme(PERSONA, "auto")
            put_theme(EMP, "light")
            code, th = page_theme(pc, "/dashboard")
            s.check("...never the persona's own stored theme", th == "light", (code, th))
            put_theme(EMP, "light")
            put_theme(PERSONA, "light")
    finally:
        with a.app.app_context():
            db = a.get_db()
            db.execute("UPDATE users SET demo_switcher=? WHERE id=?", (actor["demo_switcher"] or 0, EMP))
            if pers:
                db.execute("UPDATE users SET demo_persona=NULL WHERE id=?", (pers["id"],))
            db.commit()

    # ------------------------------------------------------------------ the page
    s.section("<html data-text> on every page")
    for v in ("s", "m", "l", "xl"):
        put(EMP, v)
        code, size = page_size(H.client_as(a, EMP), "/dashboard")
        if not (code == 200 and size == v):
            s.check("the dashboard renders data-text=%s" % v, False, (code, size))
            break
    else:
        s.check("each stored size renders on the dashboard's <html data-text> (s, m, l, xl)", True)
    put(EMP, "xl")
    code, size = page_size(H.client_as(a, EMP), "/dashboard")
    s.check("(an employee's xl is xl)", size == "xl", size)
    code, size = page_size(a.app.test_client(), "/login")
    s.check("the sign-in page, signed out, renders m", code == 200 and size == "m", (code, size))
    code, size = page_size(a.app.test_client(), "/forgot")
    s.check("the forgot-password page, signed out, renders m", code == 200 and size == "m", (code, size))
    code, size = page_size(H.client_as(a, EMP), "/forgot")
    s.check("an auth page renders m even for someone whose setting is xl",
            size == "m" or code in (301, 302, 303), (code, size))
    code, size = page_size(a.app.test_client(), "/no-such-page-at-all")
    s.check("a signed-out error page renders m", size in (None, "m"), (code, size))
    put(EMP, "zz")
    code, size = page_size(H.client_as(a, EMP), "/dashboard")
    s.check("a stored value that is not one of the four renders m", code == 200 and size == "m", (code, size))
    put(EMP, "m")

    s.section("<html data-theme> on every page")
    for v in ("light", "dark", "auto"):
        put_theme(EMP, v)
        code, th = page_theme(H.client_as(a, EMP), "/dashboard")
        if not (code == 200 and th == v):
            s.check("the dashboard renders data-theme=%s" % v, False, (code, th))
            break
    else:
        s.check("each stored theme renders on the dashboard's <html data-theme> (light, dark, auto)", True)
    put_theme(EMP, "dark")
    code, th = page_theme(a.app.test_client(), "/login")
    s.check("the sign-in page, signed out, renders light", code == 200 and th == "light", (code, th))
    code, th = page_theme(a.app.test_client(), "/forgot")
    s.check("the forgot-password page, signed out, renders light", code == 200 and th == "light", (code, th))
    code, th = page_theme(H.client_as(a, EMP), "/forgot")
    s.check("an auth page renders light even for someone whose theme is dark", th == "light" or code in (301, 302, 303), (code, th))
    code, th = page_theme(a.app.test_client(), "/no-such-page-at-all")
    s.check("a signed-out error page renders light", th in (None, "light"), (code, th))
    code, th = page_theme(H.client_as(a, EMP), "/dashboard")
    s.check("(an employee's dark is dark: it is the sign-in page that is light, not the account)", th == "dark", th)
    put_theme(EMP, "zz")
    code, th = page_theme(H.client_as(a, EMP), "/dashboard")
    s.check("a stored value that is not one of the three renders light", code == 200 and th == "light", (code, th))
    put_theme(EMP, "light")

    s.section("an admin can set it too")
    for who, uid in (("super admin", SU), ("BG admin", BG)):
        cla = H.client_as(a, uid)
        put(uid, "m")
        r = post(cla, "l")
        s.check("the %s saves Larger" % who, r.status_code == 200 and stored(uid) == "l", (r.status_code, stored(uid)))
        code, size = page_size(cla, "/admin")
        s.check("...and the admin home renders it", code == 200 and size == "l", (code, size))
        r = post(cla, "nope")
        s.check("...and a bad value is refused for them too", r.status_code == 400 and stored(uid) == "l", r.status_code)
        put_theme(uid, "light")
        r = post_theme(cla, "dark")
        s.check("the %s saves Dark" % who, r.status_code == 200 and stored_theme(uid) == "dark", (r.status_code, stored_theme(uid)))
        code, th = page_theme(cla, "/admin")
        s.check("...and the admin home renders it", code == 200 and th == "dark", (code, th))
        r = post_theme(cla, "night")
        s.check("...and a bad theme is refused for them too", r.status_code == 400 and stored_theme(uid) == "dark", r.status_code)

    # ------------------------------------------------------------------ the control
    s.section("the Account menu control")
    put(EMP, "xl")
    html = H.client_as(a, EMP).get("/dashboard").get_data(as_text=True)
    grp = re.search(r'<div class="acct-seg" role="radiogroup"[^>]*data-display-text>(.*?)</div>', html, re.S)
    btns = re.findall(r'<button type="button" class="acct-seg-b( on)?" role="radio" aria-checked="(true|false)" data-text-size="(\w+)"[^>]*title="([^"]+)"', grp.group(1)) if grp else []
    s.check("a staff member's menu has the Text size radiogroup with four buttons: s, m, l, xl", [b[2] for b in btns] == ["s", "m", "l", "xl"], btns)
    s.check("...only the stored one is checked and carries .on", [b[2] for b in btns if b[1] == "true"] == ["xl"] and [b[2] for b in btns if b[0]] == ["xl"], btns)
    s.check("...each title gives the percentage", [b[3] for b in btns] == ["Small: 87.5%", "Standard: 100%", "Larger: 112.5%", "XL: 125%"], [b[3] for b in btns])
    s.check("...the label and the line under it", 'id="acct-disp-l">Text size<' in html and "Saved to your account, on any computer." in html)
    s.check("...between My record and Get Help",
            html.index(">My record<") < html.index('class="acct-disp"') < html.index("Get Help"))
    s.check("...the Theme row sits under Text size in the same block, before the line under them",
            html.index('id="acct-disp-l">Text size<') < html.index('id="acct-theme-l">Theme<') < html.index("Saved to your account, on any computer.")
            and html.count("Saved to your account, on any computer.") == 1)
    s.check("...and display.js is on the page", "display.js" in html)
    s.check("...with the failure message's place in the menu (hidden, a status, the app's own flash-error look), so a failed save can say so",
            re.search(r'<div class="acct-disp-err flash flash-error" id="acct-disp-err" role="status" aria-live="polite" hidden>', html) is not None)
    put_theme(EMP, "auto")
    html2 = H.client_as(a, EMP).get("/dashboard").get_data(as_text=True)
    tgrp = re.search(r'<div class="acct-seg" role="radiogroup" aria-labelledby="acct-theme-l" data-display-theme>(.*?)\n          </div>', html2, re.S)
    tb = re.findall(r'<button type="button" class="acct-seg-b acct-seg-t( on)?" role="radio" aria-checked="(true|false)" data-theme-pick="(\w+)" data-label="(\w+)" title="([^"]+)"[^>]*>\s*<svg viewBox="0 0 24 24" aria-hidden="true">(.*?)</svg>(\w+)</button>',
                    tgrp.group(1), re.S) if tgrp else []
    s.check("the Theme radiogroup has three buttons: light, dark, auto, labelled Light, Dark, Device",
            [(b[2], b[3], b[6]) for b in tb] == [("light", "Light", "Light"), ("dark", "Dark", "Dark"), ("auto", "Device", "Device")], tb)
    s.check("...only the stored one is checked and carries .on", [b[2] for b in tb if b[1] == "true"] == ["auto"] and [b[2] for b in tb if b[0]] == ["auto"], tb)
    s.check("...Device's title is \"Follows your computer's light or dark setting\"", [__import__("html").unescape(b[4]) for b in tb if b[2] == "auto"] == ["Follows your computer's light or dark setting"], tb)
    s.check("...each has its icon: a sun, a moon, a monitor", len(tb) == 3 and "circle" in tb[0][5] and "<path" in tb[1][5] and "<rect" in tb[2][5] and "circle" not in tb[1][5], tb and [b[5][:40] for b in tb])
    put_theme(EMP, "light")
    ahtml = H.client_as(a, SU).get("/admin").get_data(as_text=True)
    s.check("the admin's menu is the same control (Text size and Theme)", 'data-display-text' in ahtml and ahtml.count('data-text-size="') == 4
            and 'data-display-theme' in ahtml and ahtml.count('data-theme-pick="') == 3 and "Saved to your account, on any computer." in ahtml)
    s.check("the sign-in page has no control and no display.js",
            "data-display-text" not in a.app.test_client().get("/login").get_data(as_text=True)
            and "display.js" not in a.app.test_client().get("/login").get_data(as_text=True))
    js = open(os.path.join(H.REPO, "static", "display.js"), encoding="utf-8").read()
    s.check("display.js posts csrf_token and the one field to /me/display, sets the attribute first, puts the old choice back on failure, no alert()",
            'fd.append("csrf_token"' in js and "fd.append(spec.field" in js and '"/me/display"' in js and "paint(v)" in js
            and "paint(confirmed)" in js and "alert(" not in js and "confirm(" not in js)
    s.check("...it drives both groups: text (data-text, field text) and theme (data-theme, field theme)",
            'field: "text"' in js and 'attr: "data-text"' in js and 'field: "theme"' in js and 'attr: "data-theme"' in js and "[data-display-theme]" in js)
    s.check("...arrow keys move within the group", all(k in js for k in ("ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp")))

    # ------------------------------------------------------------------ classification
    s.section("classification")
    s.check("display_pref is core: never owned by a cycle module",
            a.module_of_request(endpoint="display_pref", path="/me/display") is None and "display_pref" in a.MODULE_UNGATED_ENDPOINTS)
    s.check("...no user-role module row and no admin item: the setting is for everyone",
            "display_pref" not in a.UROLE_ENDPOINTS and "display_pref" not in getattr(a, "ADMIN_ACCESS_MAP", {}))
    rule = [r for r in a.app.url_map.iter_rules() if r.endpoint == "display_pref"]
    s.check("...one route, POST only", len(rule) == 1 and rule[0].rule == "/me/display" and "GET" not in (rule[0].methods - {"HEAD", "OPTIONS"}))

    # ------------------------------------------------------------------ what Help and the agents know
    s.section("Help, the KB and Ask OneHR")
    q, ans = a.HELP_QA["text_size"]
    s.check("Help answers 'How do I make the text bigger or smaller?': Account menu, Text size, four sizes, saved to the account",
            q == "How do I make the text bigger or smaller?" and "Account menu" in ans and "Text size" in ans
            and all(w in ans for w in ("Small", "Standard", "Larger", "XL")) and "saved to your account" in ans, ans)
    s.check("...in the lists staff and admins open (dash, basic, other, admin) and no list is over its limit",
            all("text_size" in a.HELP_LISTS[k][1] for k in ("dash", "basic", "other", "admin"))
            and all(len(v[1]) <= a.HELP_LIST_MAX for v in a.HELP_LISTS.values()))
    s.check("...and every key in every list is an answer", all(k in a.HELP_QA for v in a.HELP_LISTS.values() for k in v[1]))
    q2, ans2 = a.HELP_QA["theme"]
    s.check("Help answers 'Can I use dark mode?': Account menu, Theme, Light, Dark or Device, saved to the account",
            q2 == "Can I use dark mode?" and "Account menu" in ans2 and "Theme" in ans2 and all(w in ans2 for w in ("Light", "Dark", "Device"))
            and "saved to your account" in ans2, ans2)
    s.check("...in the Basic dashboard's list and the Admin list, beside the text size (the Dashboard and general lists are full, and other suites pin "
            "their answers: Can I give feedback on AI+?, Why was I signed out?)",
            all("theme" in a.HELP_LISTS[k][1] and "text_size" in a.HELP_LISTS[k][1] for k in ("basic", "admin"))
            and "fb_card" in a.HELP_LISTS["dash"][1] and "signed_out" in a.HELP_LISTS["other"][1])
    with a.app.app_context():
        kb = a.get_db().execute("SELECT title, body, tags, active FROM kb_entries WHERE slug='display-text-size'").fetchone()
    s.check("the KB has the 'display-text-size' row, seeded by slug",
            kb is not None and kb["active"] == 1 and "Text size" in kb["body"] and "text size" in kb["tags"], kb and kb["title"])
    s.check("...seeded with INSERT OR IGNORE (an admin's edit is never overwritten)",
            re.search(r'\("display-text-size"', SRC) is not None and "INSERT OR IGNORE INTO kb_entries" in SRC)
    with a.app.app_context():
        kb2 = a.get_db().execute("SELECT title, body, tags, active FROM kb_entries WHERE slug='display-theme'").fetchone()
    s.check("the KB has the 'display-theme' row, seeded by slug",
            kb2 is not None and kb2["active"] == 1 and "Theme" in kb2["body"] and "dark mode" in kb2["tags"] and "night mode" in kb2["tags"], kb2 and kb2["title"])
    s.check("...seeded with INSERT OR IGNORE (an admin's edit is never overwritten)", re.search(r'\("display-theme"', SRC) is not None)
    s.check("Help's lists name no 'tour stop' for it (the tour does not visit the Account menu)",
            "text size" not in open(os.path.join(H.REPO, "static", "onboarding.js"), encoding="utf-8").read().lower()
            and "dark mode" not in open(os.path.join(H.REPO, "static", "onboarding.js"), encoding="utf-8").read().lower())
    asks = ("text size", "bigger text", "font", "make the text bigger", "change the text size", "the words are too small", "zoom in on the text", "I can't read the screen")
    hits = [m for m in asks if next((k for k, rx in a._ASK_INTENTS if rx.search(m)), None) == "textsize"]
    s.check("Ask OneHR sends each of those to the text-size answer", hits == list(asks), set(asks) - set(hits))
    misses = ("make the text of my remark shorter", "change my name", "where is my 360 report", "what is pending for me", "how do I write a remark")
    s.check("...and no other question to it", all(next((k for k, rx in a._ASK_INTENTS if rx.search(m)), None) != "textsize" for m in misses))
    with a.app.test_request_context("/dashboard"):
        out = a._ask_intent("how do I make the text bigger", {})
    s.check("...the answer is in code (no model): the Account menu, Text size, the four sizes",
            bool(out) and "Account menu" in out["say"] and "Text size" in out["say"] and "XL" in out["say"] and out["cards"] == [], out)
    with a.app.test_request_context("/dashboard"):
        out2 = a._ask_intent("make the text of my remark shorter", {})
    s.check("...a remark question is left to the model", not out2)
    tasks = ("dark mode", "night mode", "theme", "black background", "can I use dark mode", "switch to dark mode", "the screen is too bright", "make the screen darker")
    thits = [m for m in tasks if next((k for k, rx in a._ASK_INTENTS if rx.search(m)), None) == "theme"]
    s.check("Ask OneHR sends each of those to the theme answer (dark mode, night mode, theme, black background ...)", thits == list(tasks), set(tasks) - set(thits))
    tmiss = ("what themes are in my 360 comments", "make the text of my remark shorter", "change my name", "where is my 360 report", "what is pending for me", "how do I write a remark", "my dark horse remark", "text size")
    s.check("...and no other question to it", all(next((k for k, rx in a._ASK_INTENTS if rx.search(m)), None) != "theme" for m in tmiss))
    with a.app.test_request_context("/dashboard"):
        out3 = a._ask_intent("can I use dark mode", {})
    s.check("...the answer is in code (no model): the Account menu, Theme, Light, Dark or Device; downloads and print stay light",
            bool(out3) and "Account menu" in out3["say"] and "Theme" in out3["say"] and "Device" in out3["say"] and "stay light" in out3["say"] and out3["cards"] == [], out3)
finally:
    for u, v in OLD.items():
        put(u, v or "m")
    for u, v in OLD_T.items():
        put_theme(u, v or "light")
    for u, v in OLD_TA.items():
        put_theme_at(u, v)

# An open header menu is placed by ONE place() (on open, on a ResizeObserver of each menu and trigger, on window resize)
# and capped to the window; its own scroll must not close it (Chris, 2026-11-01).
_base = open(os.path.join(H.REPO, "templates", "base.html"), encoding="utf-8").read()
_dd = _base[_base.index("// Dropdown menus (Account, Manage)"):]
_dd = _dd[:_dd.index("</script>")]
s.check("header menus: one place() run on open, on a ResizeObserver of menu and trigger, and on window resize",
        _dd.count("place(p)") >= 4 and "new ResizeObserver(" in _dd and "ro.observe(p.m); ro.observe(p.t)" in _dd
        and "window.addEventListener('resize'" in _dd)
s.check("...capped to the window's height with its own scroll",
        "p.m.style.maxHeight" in _dd and "innerHeight" in _dd and "overflowY = 'auto'" in _dd)
s.check("...a menu's own scroll does not close it (Log out stays reachable in a short window)",
        "p.m.contains(t)" in _dd and "window.addEventListener('scroll'" in _dd and _dd.index("p.m.contains(t)") < _dd.index("closeAll(null);\n  }, true)"))
sys.exit(s.done())
