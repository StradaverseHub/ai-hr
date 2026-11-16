# OneHR (AI+ OneHR by Chin Hin)

OneHR is Chin Hin Group's HR platform: a Flask and SQLite web app used by about 3,600 employees across seven business groups.
The main way people use it is the AI+ chat journey. The older classic pages are kept as redirects and a fallback.

**This folder is a reference copy of the production code.** It is the code at commit `209efb7f` of the production branch, taken
on 2026-11-16. It is for reading. It is not a deployable package and it holds no data.

## What the platform covers

- **Performance Management**: KPI setting and agreement, results, moderation, the performance band, and the Grade H appraisal.
- **Talent Management**: the Talent Box, calibration by business unit and business group, and talent history.
- **360 feedback**: leadership-principle ratings, assessor panels, anonymised results and the potential band.
- **Competencies**: job-based competency profiles and self and manager assessment.
- **IDP and Career Plan**: development plans, career aims and development goals.
- **AI+ Learning**: a learning management module (courses, sessions, requests and approvals, certificates).
- **AI+ agents**: Ask OneHR (a guide), the OneHR Agent, review and calibration agents for managers and leaders, and a ticket
  agent. Model calls go through `ai_draft.py` (Azure OpenAI, with an OpenAI backup), and every message is screened before a model sees it.
- **Admin**: roles and access, imports (roster, KPI targets), reminders and email, reports, audit log.

The CSF Scorecard module lives on a separate branch and is **not** part of this copy.

## What was removed

- Deploy and release tooling, server and web-server configuration, CI workflows, backup and release scripts.
- All seed and demo-data scripts, and the scripts that loaded real HR files (roster preparation, enrichment, one-off data imports).
- All databases and data files: no `.db`, `.csv`, `.xlsx`, uploads, or people data.
- User guides, the tutorial video and other office or video files, and internal planning documents. Only `docs/DESIGN_GUIDE.md` is kept.
- Operational tools that act on a server or the live database. Only the CSS helpers and the layout sweep tool remain in `tools/`.
- Suites that tested the removed tooling. The other suites stay as documentation of the rules, but several need the removed
  seeder to build their database and will not run here.
- Secrets, hostnames, addresses, server paths and real people's names and IDs. Where code needed a value, a placeholder
  (`example.com`, `X0001`) or an environment variable is used instead.

## Accounts and sign-in
This copy holds no password scheme. Accounts and sign-in follow the main ai-hr app; the login route here remains only so the
copy can be run locally. New accounts the app creates (Add a person, the roster import) get a random password that nobody
knows, and a password is set only by a reset link or by an admin typing one.

## Layout

| Path | What it is |
|---|---|
| `app.py` | The whole Flask application (routes, schema, business rules). Large: about 10 MB. |
| `templates/`, `static/` | Jinja templates, JavaScript, CSS and SVG assets. |
| `ai_draft.py` | AI helper: model calls, input screening, stored-text checks. |
| `mailer.py`, `send_reminders.py` | Email through Microsoft Graph, and the reminder job. |
| `blob_storage.py` | Optional Azure Blob storage for performance attachments. |
| `build_assignments.py`, `build_panels_db.py` | The 360 assessor-panel rules. `app.py` imports both. |
| `onehr_mcp.py` | The admin AI+ Connect (MCP) endpoint, off unless `ONEHR_MCP=1`. |
| `wsgi.py` | WSGI entry point. |
| `tests/` | Test suites and the harness (see `tests/README.md`). |
| `tools/` | CSS token and unit helpers, the layout sweep script. |

## Run it locally

Needs Python 3.11.

```bash
python3.11 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # optional: export the variables you want to set
```

`app.py` runs its schema migration when it is imported, and that migration needs the base tables to exist already.
On a brand-new database, lay the base schema down first (this reads `SCHEMA` out of `app.py` without importing it):

```bash
python - <<'EOF'
import ast, sqlite3
src = open("app.py", encoding="utf-8").read()
schema = next(n.value for n in ast.parse(src).body
              if isinstance(n, ast.Assign) and any(getattr(t, "id", None) == "SCHEMA" for t in n.targets))
con = sqlite3.connect("leadership360.db")
con.executescript(ast.literal_eval(schema))
con.close()
EOF
python app.py               # development server on http://127.0.0.1:5001
```

Without `SECRET_KEY` the app uses a development key, which is fine locally only. For a real server set `L360_PROD=1` and a
`SECRET_KEY` of 32 or more random characters, and serve `wsgi:app` with gunicorn behind HTTPS
(`gunicorn --workers 3 --bind 127.0.0.1:8000 wsgi:app`).

This copy ships no accounts and no seed users, so a new database has nobody who can sign in. For a local run only, add a first admin row to the `users`
table yourself (`role` = `admin`, `password_hash` from `werkzeug.security.generate_password_hash`). The environment variable names
are listed in `.env.example`; email, AI and blob storage are all optional and stay off when their variables are unset.
