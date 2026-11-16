"""The sign-in, forgot-password and reset pages (redesigned 2026-10-15, the canvas "OneHR AI+ Sign-in").

- The sign-in page carries Forgot password as a pop-out; it posts to /forgot with fetch and takes the SAME one answer
  as JSON, so a match and a non-match still read alike (the rule test_login_security holds for the page).
- A server with no email offers no form, in the pop-out or on /forgot.
- After a wrong password the Employee ID typed is put back; a lockout says so with a way to reset now; an empty field
  never counts as a failed attempt.
- /login?forgot=1 opens the pop-out (an expired reset link sends people there).
- None of the three pages has the top bar or the floating Back button, even for someone signed in.
- The wording says "Group People", never "HR" or "HRBP" (Chris, 2026-10-20: "replace with Group People"; it was
  "People Business Partner").

Synthetic (ZZAP-*) on the shared suite database; everything is put back at the end.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402
from werkzeug.security import generate_password_hash  # noqa: E402

a = H.setup()
s = H.Suite("Sign-in pages -- the redesign, Forgot password as a pop-out with the same one answer")

PW = "Right-pass-1"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZAP-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM password_resets WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM login_attempts WHERE username LIKE 'ZZAP-%'")
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    _cleanup(db)
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]
    pwh = generate_password_hash(PW, method="pbkdf2:sha256:1000")

    def mk(eid, **over):
        v = dict(base, username=eid, employee_id=eid, full_name=eid, email=None, manager_id=None, hod_id=None,
                 left_at=None, role="user", admin_bg=None, password_hash=pwh)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    ME = mk("ZZAP-MATCH", email="zzap-match@example.invalid")
    mk("ZZAP-LOCK", email="zzap-lock@example.invalid")
    db.commit()


def anon():
    c = a.app.test_client()
    with c.session_transaction() as ss_:
        ss_["csrf_token"] = "tok"
    return c


def attempts(user):
    return H.one(a, "SELECT COUNT(*) FROM login_attempts WHERE username=?", (user,))


_prod, _cfg, _send, _async = a._PROD, a.mailer.is_configured, a.mailer.send_mail, a.RESET_MAIL_ASYNC
try:
    # =============================================================================================================
    s.section("The sign-in page")
    c = anon()
    r = c.get("/login")
    page = r.get_data(as_text=True)
    s.check("GET /login answers 200", r.status_code == 200, r.status_code)
    s.check("it says Welcome back / Sign in to AI+ OneHR", "Welcome back" in page and "Sign in to AI+ OneHR" in page)
    s.check("the brand panel with the assistant animation and its pause button",
            'class="ax-brand"' in page and 'id="ax-demo"' in page and 'id="ax-demo-pause"' in page)
    s.check("...the assistant named 'OneHR AI Agent at your service' (Chris, 2026-10-16)",
            re.search(r'<span class="ax-demo-name"[^>]*>OneHR AI Agent at your service</span>', page) is not None
            and "OneHR assistant" not in page)
    # three parts (Chris, 2026-10-16: "part one is PMTMIDP, part 2 is calibration, part 3 is LMS"), told in the lede too
    _scenes = re.findall(r'<div class="ax-scene ax-scene-(\d)">', page)
    _parts = re.findall(r'<li class="ax-part ax-part-\d">([^<]+)</li>', page)
    s.check("...in three parts: PM · TM · IDP, Calibration, LMS, each a scene of its own",
            _scenes == ["1", "2", "3"] and _parts == ["PM · TM · IDP", "Calibration", "LMS"], (_scenes, _parts))
    s.check("...the lede names calibration and learning beside the check-in",
            re.search(r'<p class="ax-lede"[^>]*>[^<]*check-in[^<]*calibration[^<]*learning[^<]*</p>', page) is not None)
    _acss = H.source(a, "static/style.css")
    s.check("...the scenes take turns on one 36-second loop, three times the 12-second steps, and stand still on the "
            "first part for anyone asking for reduced motion",
            ".ax-scene-1 { animation: axScene1 36s infinite step-end; }" in _acss
            and ".ax-a1 { animation: axIn1 12s infinite; }" in _acss
            and ".ax-scenes > .ax-scene-1 { visibility: visible; }" in (re.search(
                r"@media \(prefers-reduced-motion: reduce\) \{\n  \.ax-demo \* \{ animation: none !important; \}(.*?)\n\}",
                _acss, re.S) or re.match("", "")).group(0))
    # the easter egg (Chris, 2026-10-16: "go with A and B, after the spark, transition to the background change, but
    # don't change the wording"): five quick taps on AI+, a spark burst, then the sail stripes; no words change
    s.check("the egg: the AI+ pill on the sign-in page carries its hook, and nothing else does",
            re.findall(r'<span class="ax-aiplus" data-egg>', page) == [re.search(r"<span class=\"ax-aiplus\"[^>]*>", page).group(0)]
            and page.count("data-egg") == 1)
    _ajs = H.source(a, "static/auth.js")
    _egg = (re.search(r"// ---- the easter egg.*?(?=// ---- forgot password)", _ajs, re.S) or re.match("", "")).group(0)
    s.check("...its script: five taps, each within 2 seconds of the last, set off the burst, then the stripes",
            'var egg = $(".ax-aiplus[data-egg]")' in _egg and "taps >= 5" in _egg and "now - lastTap > 2000" in _egg
            and "burst()" in _egg and 'stripes.classList.add("is-in")' in _egg, len(_egg))
    # the one line the assistant card says (Chris, 2026-10-16: "change the chat too to like you have found me, let's
    # move to sign in"); no other words change
    # (since 2026-10-19 the phone bubble of the mascot says that same line, so both sets are `= LINE`, and the mascot's
    # static markup is set the way the spark's is)
    _sets = re.findall(r"\.(?:textContent|innerText|value)\s*=\s*[^;]+;", _egg)
    s.check("...the assistant card says one line of its own, and no other words change: no other text, no field's value, "
            "the stripes behind the words",
            _sets == [".textContent = LINE;", ".textContent = LINE;"]
            and 'var LINE = "You found me! Now let\'s get you signed in.";' in _egg
            and not re.search(r"\.innerHTML\s*=(?!\s*(?:SPARK|MASCOT);)", _egg) and "brand.insertBefore(s, " in _egg
            and 'scenes.appendChild(scene)' in _egg, _sets)
    s.check("...in the scenes' own place, the loop hidden meanwhile so the card keeps its size, and back after",
            ".ax-demo.is-egg .ax-scenes > .ax-scene:not(.ax-egg-scene), .ax-demo.is-egg .ax-parts { visibility: hidden "
            "!important; }" in _acss and "if (unsay) unsay();" in _egg)
    s.check("...the pill invites the tap: the hand cursor, it grows on hover and gives on the press",
            "cursor: pointer;" in (re.search(r"\.ax-aiplus\[data-egg\] \{[^}]*\}", _acss) or re.match("", "")).group(0)
            and ".ax-aiplus[data-egg]:hover { transform: scale(1.1);" in _acss
            and ".ax-aiplus[data-egg]:active { transform: scale(.96); }" in _acss)
    _rm = re.findall(r"@media \(prefers-reduced-motion: reduce\) \{\n  \.ax-aiplus\[data-egg\], \.ax-aiplus\[data-egg\] > svg.*?\n\}", _acss, re.S)
    s.check("...for anyone asking for reduced motion: no sparks, no sweep",
            len(_rm) == 1 and ".ax-egg-burst { display: none; }" in _rm[0]
            and ".ax-egg-sea.is-in .ax-egg-band, .ax-egg-sea.is-out .ax-egg-band { animation: none; }" in _rm[0])
    # the OneHR mascot in the egg (Chris, 2026-10-19: "out of the pill then rides the stripes"; on a phone, the same line
    # in a bubble; canvas "OneHR Easter Egg Mascot")
    _m = (re.search(r"function mascot\(\) \{.*?\n    \}\n", _egg, re.S) or re.match("", "")).group(0)
    _mcss = (re.search(r"\.ax-egg-mascot \{[^}]*\}", _acss) or re.match("", "")).group(0)
    _bcss = (re.search(r"\.ax-egg-bubble \{[^}]*\}", _acss) or re.match("", "")).group(0)
    s.check("the egg's mascot: the fifth tap brings it out, and the 7.4 s cleanup takes it away",
            _m != "" and "unmascot = mascot();" in _egg and "unmascot();" in _egg
            and "el.remove(); if (bub) bub.remove();" in _m, len(_m))
    s.check("...it is decoration only: hidden from screen readers, never takes a click or a tab stop, never touches the form",
            _m.count('setAttribute("aria-hidden", "true")') == 2 and "tabindex" not in _m.lower() and ".focus(" not in _m
            and not re.search(r"\b(?:form|input|button)\b", _m)
            and "pointer-events: none;" in _mcss and "pointer-events: none;" in _bcss)
    s.check("...it follows the real layout: the pill, the agent card and the red stripe measured as it fires; on a phone "
            "(no agent card) it says the card's line in a bubble",
            "egg.getBoundingClientRect()" in _m and "demo.getBoundingClientRect()" in _m and "Math.tan(32" in _m
            and 'matchMedia("(max-width: 900px)")' in _m and "bub.textContent = LINE;" in _m)
    s.check("...for anyone asking for reduced motion: no movement, it simply appears at its spot",
            'matchMedia("(prefers-reduced-motion: reduce)")' in _m
            and "if (still) { el.style.transform = at(rest.x, rest.y); }" in _m
            and len(_rm) == 1 and ".ax-egg-arm, .ax-egg-eyes, .ax-egg-bubble { animation: none; }" in _rm[0])
    s.check("no top bar and no floating Back button", 'class="topbar"' not in page and 'id="floating-back"' not in page)
    s.check("Forgot password opens the pop-out, and still links to /forgot with no script",
            'id="ax-forgot"' in page and re.search(r'href="/forgot"[^>]*data-forgot-open', page) is not None)
    s.check("the pop-out carries the reset form on a server that can email (here: a laptop, the link on screen)",
            'id="ax-forgot-form"' in page and 'name="email"' in page)
    s.check("...and its script", "auth.js" in page)
    s.check("the pop-out stays closed on a plain visit", "data-open-on-load" not in page)
    s.check("the first-time note is there, behind its toggle, and describes no password scheme",
            'id="ax-first-panel" hidden' in page and "Sign-in follows the main AI-HR app" in page
            and "last four digits" not in page)
    s.check("it names Group People, never HR, HRBP or a People Business Partner",
            "Group People" in page and "People Business Partner" not in page and "HRBP" not in page and not re.search(r"\bHR\b", page))
    s.check("/login?forgot=1 opens the pop-out on load", "data-open-on-load" in c.get("/login?forgot=1").get_data(as_text=True))

    # =============================================================================================================
    s.section("After a failed sign-in")
    b0 = attempts("ZZAP-MATCH")
    r = c.post("/login", data={"username": "ZZAP-MATCH", "password": "wrong-one", "csrf_token": "tok"})
    body = r.get_data(as_text=True)
    s.check("a wrong password: the page says they don't match", r.status_code == 200 and "don&#39;t match" in body)
    s.check("...the Employee ID typed is put back", 'value="ZZAP-MATCH"' in body)
    s.check("...and the attempt is counted", attempts("ZZAP-MATCH") == b0 + 1)

    b1 = attempts("ZZAP-MATCH")
    body = c.post("/login", data={"username": "ZZAP-MATCH", "password": "", "csrf_token": "tok"}).get_data(as_text=True)
    s.check("an empty password: asked for both", "Enter your Employee ID and password." in body)
    s.check("...and it never counts as a failed attempt", attempts("ZZAP-MATCH") == b1)
    body = c.post("/login", data={"username": "<b>x</b>", "password": "", "csrf_token": "tok"}).get_data(as_text=True)
    s.check("what was typed is escaped when it's put back", "<b>x</b>" not in body and "&lt;b&gt;x&lt;/b&gt;" in body)

    with a.app.test_request_context("/"):
        d = a.get_db()
        for _ in range(a.LOGIN_MAX_FAILS):
            d.execute("INSERT INTO login_attempts(username, ip, device) VALUES ('ZZAP-LOCK', '', NULL)")
        d.commit()
    body = anon().post("/login", data={"username": "ZZAP-LOCK", "password": PW, "csrf_token": "tok"}).get_data(as_text=True)
    s.check("locked out: 'Too many failed attempts', even with the right password", "Too many failed attempts" in body)
    s.check("...with a way to reset now (the pop-out)",
            "Reset my password" in body and re.search(r'class="ax-alert-link" data-forgot-open', body) is not None)
    s.check("...and how long to wait", ("Wait %d minutes" % a.LOGIN_WINDOW_MIN) in body)

    # =============================================================================================================
    s.section("Forgot password from the pop-out: the same one answer, as JSON")
    a._PROD, a.RESET_MAIL_ASYNC = True, False
    a.mailer.is_configured = lambda: True
    sent = []
    a.mailer.send_mail = lambda to, *a_, **k_: sent.append(to)

    def ask_json(eid, email):
        return anon().post("/forgot", data={"username": eid, "email": email, "csrf_token": "tok"},
                           headers={"X-Requested-With": "fetch"})

    m = ask_json("ZZAP-MATCH", "zzap-match@example.invalid")
    s.check("a match: JSON, outcome 'requested', no link on screen",
            m.is_json and m.get_json() == {"outcome": "requested", "dev_link": None}, m.get_data(as_text=True)[:200])
    s.check("...and the email went", sent == ["zzap-match@example.invalid"], sent)
    del sent[:]
    for what, (eid, em) in {"a wrong email": ("ZZAP-MATCH", "someone@example.invalid"),
                             "an unknown Employee ID": ("ZZAP-NOBODY", "zzap-match@example.invalid")}.items():
        o = ask_json(eid, em)
        s.check("%s answers exactly as a match does" % what, o.get_data() == m.get_data())
    s.check("...and sent nothing", sent == [], sent)
    plain = anon().post("/forgot", data={"username": "ZZAP-MATCH", "email": "x@example.invalid", "csrf_token": "tok"})
    s.check("without the fetch header /forgot still answers its page", not plain.is_json and "we'll email" in plain.get_data(as_text=True))

    a.mailer.is_configured = lambda: False
    n = ask_json("ZZAP-MATCH", "zzap-match@example.invalid")
    s.check("no email on the server: JSON says nomail, match or not",
            n.get_json() == {"outcome": "nomail", "dev_link": None}
            and ask_json("ZZAP-NOBODY", "x@example.invalid").get_data() == n.get_data())
    lp = anon().get("/login").get_data(as_text=True)
    _modal = lp[lp.find('id="ax-forgot"'):]   # the pop-out (the help desk's request card keeps its own email field)
    s.check("...and the sign-in page's pop-out has no form, only Group People",
            'id="ax-forgot-form"' not in lp and 'name="email"' not in _modal and 'id="axh-forgot-tpl"' not in lp
            and "isn't available on OneHR just now" in lp and 'aria-labelledby="axf-title-nomail"' in lp)

    # =============================================================================================================
    s.section("The reset page")
    a._PROD = False      # a laptop: the link comes back on screen
    j = ask_json("ZZAP-MATCH", "zzap-match@example.invalid").get_json()
    link = (j or {}).get("dev_link") or ""
    s.check("on a laptop the pop-out gets the link to show", "/reset/" in link, j)
    tok = link.rsplit("/reset/", 1)[-1]
    rc = anon()
    rp = rc.get("/reset/" + tok).get_data(as_text=True)
    s.check("a good link: 'Set a new password' with the two rules",
            "Set a new password" in rp and 'id="rp-rule-len"' in rp and 'id="rp-rule-match"' in rp)
    s.check("...no top bar", 'class="topbar"' not in rp)
    bad = rc.post("/reset/" + tok, data={"new": "Longenough1", "confirm": "Different1", "csrf_token": "tok"})
    s.check("passwords that differ: said on the page, nothing changed",
            bad.status_code == 200 and "don&#39;t match" in bad.get_data(as_text=True))
    ok = rc.post("/reset/" + tok, data={"new": "Longenough1", "confirm": "Longenough1", "csrf_token": "tok"})
    s.check("a good new password: back to sign in", ok.status_code == 302 and "/login" in (ok.headers.get("Location") or ""))
    after = rc.get("/login").get_data(as_text=True)
    s.check("...where a status note says it's reset", 'class="ax-note" role="status"' in after and "password is reset" in after)
    ex = anon().get("/reset/" + tok).get_data(as_text=True)
    s.check("the used link now says it has expired, and offers a new one through the pop-out",
            "This link has expired" in ex and 'href="/login?forgot=1"' in ex)

    # =============================================================================================================
    s.section("Someone signed in")
    me = H.client_as(a, ME)
    fp = me.get("/forgot").get_data(as_text=True)
    s.check("/forgot shows no top bar or Back button to someone signed in",
            'class="topbar"' not in fp and 'id="floating-back"' not in fp)

    # =============================================================================================================
    s.section("The Chin Hin logo")
    for path in ("/login", "/forgot", "/reset/not-a-token"):
        pg = anon().get(path).get_data(as_text=True)
        foot = re.search(r'<div class="ax-brand-foot">(.*?)</div>', pg, re.S)
        s.check("%s: the official logo, with its brand line under it" % path,
                foot is not None and 'class="ax-chlogo"' in foot.group(1) and 'alt="Chin Hin"' in foot.group(1)
                and "chin-hin-logo-white.svg" in foot.group(1) and "One People · One Culture · One Chin Hin" in foot.group(1)
                and "One Brand" not in pg)
    lr = anon().get("/static/chin-hin-logo-white.svg")
    svg = lr.get_data(as_text=True)
    s.check("the logo file is served as an SVG", lr.status_code == 200 and lr.mimetype == "image/svg+xml", (lr.status_code, lr.mimetype))
    s.check("...pure vector in the brand's colours: white, and Chin Hin Red for the stripe",
            svg.startswith("<svg") and "<image" not in svg and "<script" not in svg.lower() and " on" not in svg.lower()
            and set(re.findall(r'fill="([^"]+)"', svg)) == {"#FFFFFF", "#DF1E26"})

    # =============================================================================================================
    s.section("Wording")
    src = H.source(a, "app.py")
    s.check("the reset email is OneHR's", 'mailer.send_mail(email, "Reset your OneHR password"' in src
            and "Leadership 360</strong>" not in src)
    s.check("a closed account is pointed to Group People",
            src.count("This account is no longer active. Please contact Group People.") == 2
            and "no longer active. Please contact HR." not in src)
    _live = [os.path.join(os.path.dirname(a.__file__), "app.py")] + [
        os.path.join(dp, fn) for dp, _d, fs in os.walk(os.path.join(os.path.dirname(a.__file__), "templates"))
        for fn in fs if fn.endswith(".html")] + [
        os.path.join(dp, fn) for dp, _d, fs in os.walk(os.path.join(os.path.dirname(a.__file__), "static"))
        for fn in fs if fn.endswith(".js")]
    _pbp = [p for p in _live if "People Business Partner" in open(p, encoding="utf-8", errors="replace").read()]
    s.check("no page, email or agent reply names a People Business Partner: people go to Group People (Chris, 2026-10-20)",
            _live and not _pbp, _pbp)
    for t in ("login.html", "forgot_password.html", "reset_password.html", "_auth_brand.html"):
        txt = open(os.path.join(os.path.dirname(a.__file__), "templates", t)).read()
        s.check("%s never says HR or HRBP" % t, "HRBP" not in txt and not re.search(r"\bHR\b", txt))
finally:
    a._PROD, a.mailer.is_configured, a.mailer.send_mail, a.RESET_MAIL_ASYNC = _prod, _cfg, _send, _async
    with a.app.test_request_context("/"):
        _cleanup(a.get_db())

sys.exit(s.done())
