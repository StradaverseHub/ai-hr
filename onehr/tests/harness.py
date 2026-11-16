"""Shared test harness for the OneHR suites.

WHY THIS EXISTS
---------------
Every suite used to carry its own thirty lines of setup, and all of them lived
in /private/tmp, which macOS cleans. It cleaned twice in two days and took the
venv, the scratch database and four of the five suites with it. A suite that
vanished is not a passing suite, so they live in the repo now and the setup
lives here once.

THE SAFETY RULE, WHICH IS THE POINT OF THE WHOLE FILE
-----------------------------------------------------
A test NEVER touches the live database. `setup()` copies `leadership360.db`
into a scratch directory, repoints the app at the copy, and every suite asserts
`SCRATCH_MARKER in app.DB_PATH` before it does anything. If that assertion ever
fails, stop -- do not "fix" it by relaxing the check.

THE LOGIN SHIM
--------------
Driving a page in a browser needs a session, and typing a password into the
login form to preview is not something we do. So a path-guarded shortcut is
injected into the SCRATCH COPY of app.py -- never the repo's. It refuses to
work unless it can see the scratch marker in its own APP_DIR, so even if the
copy were served somewhere it could not hand out sessions. Keeping the shim
here rather than pasting it into each suite means it is reviewable in one
place, and `grep -rn __scratch_login app.py` in the repo stays empty.

RUNNING
-------
    tests/run.sh              every suite
    tests/run.sh timezone     one suite, by name

`run.sh` rebuilds the virtualenv and the scratch copy if they are missing, so
the next /tmp cleanup costs a rebuild rather than a rewrite.
"""
import importlib.util
import os
import py_compile
import re
import shutil
import sqlite3
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRATCH_MARKER = "onehr-tests"
# /private/tmp on macOS, /tmp everywhere else. Linux has no /private, and the
# root is not writable by a CI runner, so a hardcoded path fails at mkdir before
# a single test runs. The MARKER is what the safety assertion keys on, not the
# base, so this changes nothing about that guarantee.
_TMP = "/private/tmp" if os.path.isdir("/private/tmp") else "/tmp"
SCRATCH = os.path.join(_TMP, SCRATCH_MARKER, os.path.basename(REPO))
HARNESS = os.path.join(SCRATCH, "harness")
VENV = os.path.join(SCRATCH, "venv")

# Symlinked rather than copied: a template edit must be visible to the next run
# without a refresh step, which is how a stale copy silently passed once.
# `seed` is here for build_fixture(): the seeder reads seed/framework.json and
# nothing else, which is what makes an offline, PII-free fixture possible at all.
# seed_staging.py is deliberately NOT here -- it is COPIED, see build_fixture().
LINKED = ("templates", "static", "ai_draft.py", "blob_storage.py", "mailer.py",
          "build_assignments.py", "build_panels_db.py", "seed", "onehr_mcp.py")

_SHIM = '''@app.route("/__scratch_login/<int:uid>")
def __scratch_login(uid):
    # Review-only. Refuses outside the test scratch directory, so this cannot
    # hand out a session even if the copy were served somewhere real.
    if "%s" not in APP_DIR:
        abort(404)
    # a fresh session, as the real sign-in starts one: since a session carries its password's mark (2026-10-24), the
    # last person's mark left behind read as a password change and signed the browser out when switching people
    session.clear()
    session["user_id"] = uid
    # Mint a CSRF token exactly as the real login does. Without it every form on
    # every page renders an EMPTY token field, so a browser-driven write answers
    # 400 with no body -- which looks like an application bug and is not one.
    session["csrf_token"] = secrets.token_hex(16)
    return redirect(url_for("hub"))


''' % SCRATCH_MARKER


def _write_scratch_app():
    """Copy app.py into the scratch dir with the login shim spliced in."""
    src = open(os.path.join(REPO, "app.py"), encoding="utf-8").read()
    anchor = '@app.route("/admin/data-integrity")'
    if anchor not in src:                      # the anchor moved; fail loudly
        raise SystemExit("harness: anchor route not found in app.py -- "
                         "pick a new one rather than skipping the shim")
    src = src.replace(anchor, _SHIM + anchor, 1)
    # Templates are symlinked, so let Jinja notice edits between runs.
    src = src.rstrip() + (
        "\n\n# test harness only\n"
        "app.config['TEMPLATES_AUTO_RELOAD'] = True\n"
        "app.jinja_env.auto_reload = True\n")
    dest = os.path.join(HARNESS, "app.py")
    # Write only when the content changed: an identical rewrite would only move the mtime.
    try:
        same = open(dest, encoding="utf-8").read() == src
    except OSError:
        same = False
    if not same:
        open(dest, "w", encoding="utf-8").write(src)
    _cache_bytecode(dest)
    for name in LINKED:
        if name.endswith(".py") and os.path.exists(os.path.join(HARNESS, name)):
            _cache_bytecode(os.path.join(HARNESS, name))


def _cache_bytecode(path):
    """Keep a CHECKED-HASH .pyc for `path` in harness/__pycache__ (never in a repo).

    Why (measured 6 Nov 2026, Chris's go on Suite speed plan 2026-11-06.md): every suite is its own process that
    imports the 8.5 MB scratch app.py; compiling it costs ~0.61 s, a cached .pyc loads in ~0.02 s. No cache was ever
    kept because (1) the Claude Code app sets PYTHONDONTWRITEBYTECODE=1 for every command, and (2) the scratch app.py
    is rewritten on every setup(), so a timestamp-based pyc would always be stale. Checked-hash means Python hashes the
    source on every import and ignores the cache if it differs, so this can never run stale code. Reading a pyc is
    allowed with dont_write_bytecode set, so that setting is left alone. Recompile only when the pyc is missing or its
    embedded hash differs from the source's. A syntax error is not hidden: skip the cache and let the import report it."""
    cfile = importlib.util.cache_from_source(path)
    try:
        with open(path, "rb") as f:
            want = importlib.util.source_hash(f.read())
        try:
            with open(cfile, "rb") as f:
                head = f.read(16)
            if len(head) == 16 and head[4:8] == b"\x03\x00\x00\x00" and head[8:16] == want:
                return
        except OSError:
            pass
        py_compile.compile(path, cfile=cfile, doraise=True,
                           invalidation_mode=py_compile.PycInvalidationMode.CHECKED_HASH)
    except (py_compile.PyCompileError, OSError):
        pass


# The first sign-in steps (2026-10-15) would send every suite's people to the dashboard first: off for every suite and
# the subprocesses they start (some start the app before setup() runs); test_onboarding switches them on.
os.environ.setdefault("ONEHR_ONBOARDING", "0")

def _impact_template_hook(app_module):
    """Only under tests/impact_map.sh (ONEHR_IMPACT_DIR set): write the templates this suite uses to
    $ONEHR_IMPACT_DIR/tpl/<suite>.txt, one name a line, for the impact map (template -> suites).

    Two sources: Flask's template_rendered signal (the template a view rendered) and a wrapper on the Jinja loader, which
    also sees every {% extends %} / {% include %} / {% import %} (the signal does not fire for those, and a change to
    base.html or a partial matters to every page that pulls it in). Each name is written once per process.
    """
    d = os.path.join(os.environ["ONEHR_IMPACT_DIR"], "tpl")
    os.makedirs(d, exist_ok=True)
    suite = os.path.basename(sys.argv[0] or "suite")
    suite = re.sub(r"^test_|\.py$", "", suite)
    path = os.path.join(d, suite + ".txt")
    seen = set()

    def note(name):
        if name and name not in seen:
            seen.add(name)
            with open(path, "a", encoding="utf-8") as f:
                f.write(name + "\n")

    from flask import template_rendered  # noqa: PLC0415
    template_rendered.connect(lambda sender, template, context, **extra: note(template.name), app_module.app)
    loader = app_module.app.jinja_env.loader
    inner = loader.get_source

    def get_source(environment, template):
        note(template)
        return inner(environment, template)
    loader.get_source = get_source


_FRESH_SUITE = False   # this process's suite asked for a fresh copy: Suite.done() puts it back


def setup(fresh_db=False):
    """Build (or refresh) the scratch copy and return the imported app module.

    `fresh_db=True` re-copies the database, discarding anything a previous run
    wrote. Suites that write -- the panel build is the only one -- ask for it,
    so a re-run starts from the same place and its deltas stay meaningful.
    """
    global _FRESH_SUITE
    os.makedirs(HARNESS, exist_ok=True)
    for name in LINKED:
        link, target = os.path.join(HARNESS, name), os.path.join(REPO, name)
        if os.path.islink(link) or os.path.exists(link):
            os.remove(link) if os.path.islink(link) else shutil.rmtree(
                link, ignore_errors=True)
        os.symlink(target, link)
    db = os.path.join(HARNESS, "leadership360.db")
    if fresh_db:
        _FRESH_SUITE = True
    if fresh_db or not os.path.exists(db):
        _copy_source_db(db)
    _write_scratch_app()

    sys.path.insert(0, HARNESS)
    os.chdir(HARNESS)
    # the AI pre-run (2026-10-09) never starts its background worker in a suite: suites that stub the model would
    # otherwise queue jobs on every sign-off and work them on a thread. test_ai_prerun turns it on by hand.
    os.environ.setdefault("ONEHR_PRERUN", "0")
    # the OpenAI API backup (2026-10-21) is reached only where its key is set: never from a suite, whose prompts carry
    # the scratch copy's names. test_ai_backup points it at a local stand-in by hand.
    for _k in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_BACKUP_MODEL"):
        os.environ.pop(_k, None)
    # the synthetic demo accounts (ZZ + a letter) exist only where L360_DEMO_ACCOUNTS=1 (2026-10-15): staging and the
    # suites, never production. test_demo_gate switches it off by hand to prove production's side.
    os.environ.setdefault("L360_DEMO_ACCOUNTS", "1")
    import app  # noqa: PLC0415  -- must happen after the copy exists
    assert SCRATCH_MARKER in app.DB_PATH, (
        "REFUSING TO RUN: the app is not pointed at the scratch copy (%s). "
        "Do not relax this assertion." % app.DB_PATH)
    app.app.config["TESTING"] = True
    if os.environ.get("ONEHR_IMPACT_DIR"):
        _impact_template_hook(app)
    # the outbox (2026-10-21): no 2 seconds between emails in a suite, and no after-response look for due emails on a
    # thread of its own, which would send a suite's queued rows behind its back. test_email_waves turns both on by hand.
    app.OUTBOX_PACE = False
    app.OUTBOX_WATCH = False
    # the AI usage counts (2026-10-21) are written by hand in a suite (test_ai_backup), never by a thread of their own
    app.AI_USAGE_WATCH = False
    # the chat limit (2026-10-31, 20 a minute a person) would stop a suite that walks one person through dozens of turns in
    # seconds: lifted for every suite; test_chat_limit puts the real number back (read from the source) and tests it
    app.CHAT_PER_MINUTE = 10 ** 9
    # the first sign-in steps (2026-10-15) would send every suite's people to the dashboard first: off here, as the
    # pre-run is; test_onboarding switches them on
    app.app.config["ONEHR_ONBOARDING"] = False
    # Since the roles rollout (2026-10-20) only a confirmation date makes someone confirmed: the rollout gave today's
    # date to everyone with over a year's service and none, then switched years of service off. The suites still make
    # their people by years of service, so in a suite the super admin's "years of service still count" switch is on;
    # test_user_roles and test_participants test the rule with it off.
    import sqlite3  # noqa: PLC0415
    with sqlite3.connect(app.DB_PATH) as _c:
        _c.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, '1')", (app.UROLE_SERVICE_KEY,))
    _c.close()
    return app


def _copy_source_db(db):
    for suffix in ("", "-wal", "-shm"):
        stale = db + suffix
        if os.path.exists(stale):
            os.remove(stale)
    src, what = source_db()
    print("[harness] running against %s" % what)
    shutil.copy(src, db)


def restore_db():
    """Put the scratch copy back as a fresh_db suite found it. Suite.done() calls it for every fresh_db suite, so what
    such a suite writes (a cycle it started, a Year-End it switched to, an assessment it submitted) never reaches the
    next one. One at a time, a later fresh_db suite used to wipe it before anyone noticed; the parallel runner's batches
    (2026-10-21) run other neighbours, and four suites failed on another's leftovers. ONEHR_TEST_KEEP_DB=1 keeps the
    suite's end state, to inspect a failure."""
    _copy_source_db(os.path.join(HARNESS, "leadership360.db"))


def extract_schema():
    """app.SCHEMA, read WITHOUT importing app.

    The import is what fails on a virgin database -- _ensure_runtime_schema()
    runs at module level and needs the base tables to already exist -- so the
    base schema has to be laid down before the first import. Parsed out of the
    source with ast rather than exec'd, so nothing in app.py runs.
    """
    import ast
    src = open(os.path.join(REPO, "app.py"), encoding="utf-8").read()
    for node in ast.parse(src).body:
        if isinstance(node, ast.Assign) and any(
                getattr(t, "id", None) == "SCHEMA" for t in node.targets):
            return ast.literal_eval(node.value)
    raise SystemExit("harness: SCHEMA not found in app.py")


FIXTURE = os.path.join(SCRATCH, "fixture.db")


def build_fixture():
    """A synthetic database built from committed inputs only. Returns its path.

    THE POINT: leadership360.db and seed/*.db are gitignored because they hold
    real employee PII, so CI has no database and the suites cannot run. Rather
    than commit a fixture -- which would be a second dataset to keep in step, and
    a PII surface every time somebody refreshed it -- this GENERATES one.

    seed_staging.py already does exactly this job and is committed: entirely
    synthetic by design, offline (it reads only seed/framework.json, also
    committed), idempotent, and built with deliberate edge cases -- letter grades
    beside numeric, engineered band spreads, and no-panel / partial-panel /
    untouched-panel subjects. Measured: 298 users, 1,374 assignments, 38,472
    responses, 228 releases, and 7 of the 17 data-integrity checks firing.

    Cached: nine suites must not pay for nine builds. Delete SCRATCH to rebuild.
    """
    if os.path.exists(FIXTURE):
        return FIXTURE
    print("no leadership360.db in the repo -- building the synthetic fixture...")
    where, db = bootstrap_fresh_db(os.path.join(SCRATCH, "fixture-build"))
    # COPIED, never symlinked, for the same reason app.py is. Python sets
    # sys.path[0] from the script's RESOLVED path, so a symlinked seed_staging.py
    # puts the REPO on sys.path, imports the repo's app.py, and seeds into the
    # developer's own leadership360.db instead of the fixture. Measured, once.
    shutil.copy(os.path.join(REPO, "seed_staging.py"),
                os.path.join(where, "seed_staging.py"))
    # A subprocess, because the migration runs at import and seed_staging.py
    # needs an app whose DB_PATH is the fixture, not whatever we already imported.
    p = subprocess.run([sys.executable, "seed_staging.py"], cwd=where,
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit("harness: seed_staging.py failed\n" + (p.stdout + p.stderr)[-1200:])
    shutil.copy(db, FIXTURE)
    con = sqlite3.connect(FIXTURE)
    n = con.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    con.close()
    if n < 100:
        raise SystemExit("harness: the fixture built only %d users -- refusing to "
                         "run suites against it" % n)
    print("fixture built: %d users -> %s" % (n, FIXTURE))
    return FIXTURE


def css_tokens(dark=False, css=None):
    """The colour tokens in static/style.css (the block tools/css_tokens.py writes), as {name: value}: the light :root block, or with
    dark=True the html[data-theme=dark] block. For a suite that asserts what a colour IS: it reads the token, not a literal that
    no longer stands in the rules (Chris, 2026-11-01: every colour is a token)."""
    import re as _re
    if css is None:
        css = open(os.path.join(REPO, "static", "style.css"), encoding="utf-8").read()
    region = css[css.index("/* css_tokens:begin"):css.index("/* css_tokens:end */")]
    m = _re.search((r"html\[data-theme=dark\] \{(.*?)\n\}" if dark else r":root \{(.*?)\n\}"), region, _re.S)
    return dict(_re.findall(r"--([\w-]+):\s*([^;]+);", m.group(1)))


def tok(name, dark=False, css=None):
    """A token's colour, aliases followed ('navy' -> its hex), lower case."""
    import re as _re
    tk = css_tokens(dark, css)
    v = tk.get(name) or css_tokens(False, css).get(name)
    seen = 0
    while v and v.startswith("var(--") and seen < 5:
        v = tk.get(_re.match(r"var\(--([\w-]+)\)", v).group(1)) or css_tokens(False, css).get(_re.match(r"var\(--([\w-]+)\)", v).group(1))
        seen += 1
    return v.lower() if v else None


def cv(snippet):
    """A CSS snippet as the stylesheet now holds it. A suite that asserts a rule's colour writes the literal it always did
    ('color: #1f2433') and this maps it the way tools/css_tokens.py mapped the real CSS (by exact value and property, to
    var(--token)), so the assertion still names the colour and still fails if the rule's colour changes (Chris, 2026-11-01:
    every colour is a token). A snippet with no braces is a declaration list."""
    import importlib.util as _iu
    spec = _iu.spec_from_file_location("css_tokens", os.path.join(REPO, "tools", "css_tokens.py"))
    ct = _iu.module_from_spec(spec)
    spec.loader.exec_module(ct)
    wrapped = "{" not in snippet
    out = ct.convert_css("x{" + snippet + "}" if wrapped else snippet)
    return out[2:-1] if wrapped else out


def cvp(prefix):
    """cv() for the START of a rule, the way a suite quotes it ('.a { color: #fff;'): closed, mapped, reopened."""
    if prefix.count("{") > prefix.count("}"):
        return cv(prefix + " }")[:-2]
    return cv(prefix)


def source_db():
    """Which database the suites run against, and it is never ambiguous.

    The repo's own leadership360.db wins when it exists, so a developer's run is
    unchanged and today's numbers stay stable. CI has none, and gets the fixture.
    """
    real = os.path.join(REPO, "leadership360.db")
    if os.path.exists(real):
        return real, "the repo's leadership360.db"
    return build_fixture(), "the generated synthetic fixture"


def bootstrap_fresh_db(where=None):
    """Build a database from NOTHING and return the imported app module.

    This is the path a brand-new environment takes: build_db.py lays down
    app.SCHEMA, then the first import runs _ensure_runtime_schema() over it.
    No real database is copied and no seed is applied, so this works where
    leadership360.db does not exist -- which is everywhere except a developer's
    own machine, since the database is gitignored for holding real PII.

    Returns (directory, db_path) -- it deliberately does NOT import the app.
    A migration only runs on the FIRST import, so a caller that wants to boot
    twice has to do it in two processes; returning a module here would hand back
    whichever one happened to be imported first and prove nothing.

    The REPO's app.py is copied, not the harness's shimmed one: this is the
    fresh-install path, and it should exercise the file that actually ships.
    The caller owns the directory.
    """
    where = where or os.path.join(SCRATCH, "fresh")
    shutil.rmtree(where, ignore_errors=True)
    os.makedirs(where)
    for name in LINKED:
        os.symlink(os.path.join(REPO, name), os.path.join(where, name))
    shutil.copy(os.path.join(REPO, "app.py"), os.path.join(where, "app.py"))
    db = os.path.join(where, "leadership360.db")
    con = sqlite3.connect(db)
    con.executescript(extract_schema())
    con.commit()
    con.close()
    return where, db


# ---------------------------------------------------------------------------
# The reporting shape every suite shares
# ---------------------------------------------------------------------------
class Suite:
    def __init__(self, title):
        self.title = title
        self.ok = []
        self.fail = []
        print("\n=== %s ===" % title)

    def section(self, name):
        print("\n[%s]" % name)

    def check(self, name, cond, detail=""):
        (self.ok if cond else self.fail).append(name)
        print(("  PASS  " if cond else "  FAIL  ") + name
              + (("   -> " + str(detail)) if detail else ""))
        return bool(cond)

    def note(self, msg):
        print("        %s" % msg)

    def done(self):
        print("\n%s: %d passed, %d failed" % (self.title, len(self.ok), len(self.fail)))
        if _FRESH_SUITE and os.environ.get("ONEHR_TEST_KEEP_DB") != "1":
            restore_db()
        if self.fail:
            print("FAILED: %s" % self.fail)
            # exit here too: a suite ending in a bare s.done() reported green while failing (three did, found
            # 2026-10-15); sys.exit(s.done()) still works the same
            sys.exit(1)
        return 0


def client_as(app, uid, csrf="tok"):
    """A test client already carrying a session for `uid`.

    The csrf token has to be in the session AND posted with every write --
    without it the app answers 400 with an empty body long before any gate the
    test meant to exercise, and the test 'passes' having proven nothing.
    """
    c = app.app.test_client()
    with c.session_transaction() as s:
        s["user_id"] = uid
        s["csrf_token"] = csrf
    return c


def import_steps(client, url, data, choose=("keep", "leave", "no", "out")):
    """A file posted the way the import's own page does, through all four steps, for a suite that only needs the import
    to run. The one-shot post (no preview, no token) that used to apply at once is gone (finding 1a-01, 2026-10-31):
    `data` is what that post carried (the file as a (BytesIO, name) tuple, and any form fields such as mode).

    Step 1 keeps the file, 2 acknowledges what is worth a look, 3 answers each question the super admin is asked (the
    first of `choose` that the question offers, else its first option), 4 applies. Returns the last response, followed:
    the done page after Apply, or the page of the step that stopped it (a file that can't be read, rows that can't be
    imported, an unanswered question) with its flash, so a suite reads what the person would have read. Nothing is
    applied unless every step went on."""
    data = dict(data)
    data.pop("csrf_token", None)
    r = client.post(url, data=dict(data, csrf_token="tok", preview="1"), content_type="multipart/form-data")
    m = re.search(r"check=([0-9a-f]{32})", r.headers.get("Location", ""))
    if not m:
        return client.get(r.headers.get("Location", url))
    tok = m.group(1)
    step = lambda action, **f: client.post(url, data=dict({"csrf_token": "tok", "token": tok, "action": action}, **f))  # noqa: E731
    r = step("quality_ok", ack="1")
    if "step=changes" not in r.headers.get("Location", ""):
        return client.get(r.headers.get("Location", url))
    page = client.get(r.headers["Location"]).get_data(as_text=True)
    groups = {}
    for name, val in re.findall(r'<input type="radio" name="(d_[0-9a-f]+)" value="([^"]*)"', page):
        groups.setdefault(name, []).append(val)
    picks = {n: next((c for c in choose if c in vals), vals[0]) for n, vals in groups.items()}
    r = step("to_apply", **picks)
    if "step=apply" not in r.headers.get("Location", ""):
        return client.get(r.headers.get("Location", url))
    r = step("apply")
    return client.get(r.headers.get("Location", url))


def actors(app):
    """(super admin, BG-scoped admin or None, an active employee)."""
    with app.app.app_context():
        db = app.get_db()
        su = db.execute("SELECT * FROM users WHERE role='admin' "
                        "AND COALESCE(admin_bg,'')='' LIMIT 1").fetchone()
        bg = db.execute("SELECT * FROM users WHERE role='admin' "
                        "AND COALESCE(admin_bg,'')!='' LIMIT 1").fetchone()
        emp = db.execute("SELECT * FROM users WHERE role!='admin' "
                         "AND left_at IS NULL LIMIT 1").fetchone()
    return su, bg, emp


def one(app, sql, args=()):
    with app.app.app_context():
        return app.get_db().execute(sql, args).fetchone()[0]


def stash_email_templates(db):
    """Every email template (Cycle > Emails, 2026-10-24), then none: a suite that reads or saves an email's words starts
    from its older settings and OneHR's own words. Give the rows back with restore_email_templates."""
    kept = [dict(r) for r in db.execute("SELECT * FROM email_templates")]
    db.execute("DELETE FROM email_templates")
    db.commit()
    return kept


def restore_email_templates(db, kept):
    db.execute("DELETE FROM email_templates")
    for r in kept:
        db.execute("INSERT INTO email_templates(%s) VALUES (%s)" % (",".join(r), ",".join("?" * len(r))), list(r.values()))
    db.commit()


def rows(app, sql, args=()):
    with app.app.app_context():
        return app.get_db().execute(sql, args).fetchall()


def source(app_module, name="app.py"):
    """The scratch copy's source, for the lint-style checks."""
    return open(os.path.join(HARNESS, name), encoding="utf-8").read()


def chat_js(app_module=None):
    """The review journey's client as the lint-style checks read it: journey_chat.js, then static/calib_shared.js -- the filter
    line, the curve box and the curve dialog the calibration screens share with the admin's Talent Box (2026-10-30)."""
    return source(app_module, "static/journey_chat.js") + "\n" + source(app_module, "static/calib_shared.js")


def code_without_docstrings(src):
    """Source with comments and docstrings removed.

    Several rules in this codebase are enforced by grepping for a call that
    must NOT appear -- and the comment warning people off that call names it,
    so a naive search finds its own documentation and fails. Strip both.
    """
    import ast
    drop = set()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef,
                             ast.AsyncFunctionDef)):
            if ast.get_docstring(node, clean=False) is not None:
                first = node.body[0]
                drop.update(range(first.lineno, first.end_lineno + 1))
    return "\n".join("" if i + 1 in drop else line
                     for i, line in enumerate(src.splitlines())
                     if not line.lstrip().startswith("#"))


def every_template_compiles(app):
    """(count, [broken]).

    The primary structural check in this codebase. Jinja resolves FILTER NAMES
    at compile time, so this reaches pages the stale local database and the
    tier gates cannot -- succession, the BUCEO/BGCEO calibration views, the
    talent decision head. Page loads are supplementary to it, not the reverse.
    """
    import glob
    files = sorted(glob.glob(os.path.join(HARNESS, "templates", "*.html")))
    broken = []
    for path in files:
        try:
            app.app.jinja_env.get_template(os.path.basename(path))
        except Exception as exc:  # noqa: BLE001
            broken.append((os.path.basename(path), str(exc)[:70]))
    return len(files), broken


def as_csv_text(resp):
    """A download's first sheet as CSV text. Every table download and template is Excel since 2026-10-19 (Chris: "for
    consistency, make all import template download and export file to excel format"); the suites written against CSV
    read it through this, so their checks keep their meaning. A float reads as %g (3.5, 100)."""
    import csv as _csv
    import io as _io
    data = resp.get_data() if hasattr(resp, "get_data") else resp
    if data[:2] != b"PK":
        return data.decode("utf-8", "replace")
    from openpyxl import load_workbook
    ws = load_workbook(_io.BytesIO(data), read_only=True).worksheets[0]
    buf = _io.StringIO()
    w = _csv.writer(buf, lineterminator="\n")
    for row in ws.iter_rows(values_only=True):
        w.writerow(["" if v is None else (("%g" % v) if isinstance(v, float) else str(v)) for v in row])
    return buf.getvalue()
