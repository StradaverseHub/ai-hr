"""AI+ Connect: OneHR's admin MCP server, phase 1 (read only). Chris approved the design 2026-10-28.

An admin runs OneHR's admin reads from Claude through ONE endpoint, `POST /mcp` (MCP Streamable HTTP, stateless, plain
JSON replies, no SSE). Each tool is a thin wrapper over the function an admin page already uses, so a number here is the
number on the page. Nothing is computed twice, no model runs, nothing here writes except the audit row and the token's
last-used time.

WHAT THE RULES ARE (each one has a test in tests/test_mcp.py)
  * Off unless ONEHR_MCP=1 (read at every request, like ONEHR_LMS): off, POST /mcp is a 404.
  * Auth is `Authorization: Bearer <token>` and nothing else. A cookie is never read or set on /mcp; the form CSRF check
    does not apply to it (app.py's _csrf_and_session_guards returns early for this one path).
  * A token is stored as a sha256 hash only (table mcp_tokens), expires in 30 days, can be revoked. The account must be
    active and a SYSTEM ADMIN (is_system: Chris, 2026-10-28, "hide AI+ Connect from super admin for now"). A super
    admin's token is a 403; there is no access item for it, so no role page can give it.
  * PRIVACY, the hard rule: IDs and counts only. Never a name, display name, email, rating, band, KPI figure, remark,
    360 rater, pay, or any text a person wrote. Employee IDs, counts, organisation names (a business group, a unit, a
    department) and admin-written labels (a role's name, a banner headline) are what leaves.
  * Every result is scoped by the token owner's admin scope (bg_scope), and a tool the admin pages give to the super
    admin alone (audit, roles, email, banner, system) is the super admin's here too.
  * 60 calls a minute per token. The window is kept in this process, so it is per gunicorn worker (5 on production).
  * Every tools/call writes one activity_log row, action `mcp_call`, detail "<tool> <compact args>".

`register(app, A)` is called at the bottom of app.py; A is the app module (this file never imports app, so the token
helpers and tools/mcp_token.py work without booting it).
"""
import hashlib
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from collections import deque
from datetime import datetime, timedelta
from urllib.parse import urlparse

PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26")
RATE_LIMIT = 60          # calls a minute per token (per worker process)
RATE_WINDOW_S = 60
TOKEN_PREFIX = "ohr_"
TOKEN_DAYS = 30
IDS_MAX = 100            # IDs a tool lists per group
A = None                 # the app module, set by register()


# ---------------------------------------------------------------------------
# Tokens (plain sqlite: the CLI and the later token page use these without the app)
# ---------------------------------------------------------------------------
def _utc_str(dt=None):
    return (dt or datetime.utcnow()).strftime("%Y-%m-%d %H:%M:%S")


def token_hash(plain):
    return hashlib.sha256((plain or "").encode("utf-8")).hexdigest()


def mcp_token_create(db, user_id, name, created_by, days=TOKEN_DAYS, create_key=None):
    """Make a token for an admin account and return its PLAINTEXT, which is never stored and never shown again.
    The caller commits nothing: this commits itself, once."""
    name = (name or "").strip()[:80]
    if not name:
        raise ValueError("A token needs a name.")
    plain = TOKEN_PREFIX + secrets.token_urlsafe(32)
    cur = db.execute(
        "INSERT INTO mcp_tokens(user_id, name, token_hash, token_last4, create_key, expires_at, created_by) "
        "VALUES (?,?,?,?,?,?,?)",
        (user_id, name, token_hash(plain), plain[-4:], create_key,
         _utc_str(datetime.utcnow() + timedelta(days=int(days))), created_by))
    db.execute("INSERT INTO activity_log(user_id, action, detail, target_user_id) VALUES (?,?,?,?)",
               (created_by, "mcp_token_create", "Token #%d \"%s\", %d days" % (cur.lastrowid, name, int(days)), user_id))
    db.commit()
    return plain


def mcp_token_revoke(db, token_id, by):
    """Revoke one token. True when it was live and is now revoked, False when there was nothing to revoke."""
    row = db.execute("SELECT id, user_id FROM mcp_tokens WHERE id=? AND revoked_at IS NULL", (token_id,)).fetchone()
    if not row:
        return False
    db.execute("UPDATE mcp_tokens SET revoked_at=? WHERE id=?", (_utc_str(), token_id))
    db.execute("INSERT INTO activity_log(user_id, action, detail, target_user_id) VALUES (?,?,?,?)",
               (by, "mcp_token_revoke", "Token #%d" % token_id, row[1]))
    db.commit()
    return True


# ---------------------------------------------------------------------------
# JSON-RPC plumbing
# ---------------------------------------------------------------------------
class ToolError(Exception):
    """A tool refusing in plain words: it comes back as a result with isError true, never a stack trace."""


_RATE = {}
_RATE_LOCK = threading.Lock()


def _rate_check(token_id, now=None):
    """(allowed, seconds to wait). A sliding window of RATE_LIMIT calls in RATE_WINDOW_S, per token, in this process."""
    now = time.monotonic() if now is None else now
    with _RATE_LOCK:
        dq = _RATE.setdefault(token_id, deque())
        while dq and now - dq[0] >= RATE_WINDOW_S:
            dq.popleft()
        if len(dq) >= RATE_LIMIT:
            return False, max(1, int(RATE_WINDOW_S - (now - dq[0])) + 1)
        dq.append(now)
        if len(_RATE) > 2000:   # tokens that went quiet
            for k in [k for k, v in _RATE.items() if not v or now - v[-1] >= RATE_WINDOW_S]:
                _RATE.pop(k, None)
        return True, 0


def _enabled():
    return os.environ.get("ONEHR_MCP") == "1"


_commit_cache = {}


def _commit():
    """The running commit if the deploy left one (ONEHR_COMMIT, a COMMIT file) or a git checkout is there; else None."""
    if "v" in _commit_cache:
        return _commit_cache["v"]
    v = (os.environ.get("ONEHR_COMMIT") or "").strip() or None
    base = A.APP_DIR if A else os.path.dirname(os.path.abspath(__file__))
    if not v:
        try:
            v = open(os.path.join(base, "COMMIT"), encoding="utf-8").read().strip()[:40] or None
        except OSError:
            v = None
    if not v:
        try:
            head = open(os.path.join(base, ".git", "HEAD"), encoding="utf-8").read().strip()
            if head.startswith("ref:"):
                head = open(os.path.join(base, ".git", head[4:].strip()), encoding="utf-8").read().strip()
            v = head[:12] or None
        except OSError:
            v = None
    _commit_cache["v"] = v
    return v


def _compact(obj):
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False, default=str)


def _eid(eid, uid):
    """An Employee ID, or '#<account id>' for an account that has none (an admin made by hand)."""
    return eid if eid else "#%s" % uid


# ---------------------------------------------------------------------------
# Scope and filters
# ---------------------------------------------------------------------------
def _people(me, alias="u"):
    """(SQL, params): the real, active people in this admin's scope. The one boundary every tool starts from."""
    clause, params = A.bg_scope(me, alias + ".business_group")
    return ("%s.role!='admin' AND %s.left_at IS NULL AND COALESCE(%s.is_demo,0)=0" % (alias, alias, alias)) + clause, \
        list(params)


def _bg_name(bg):
    return A.display_bg(bg) if bg else ""


def _bg_code_map():
    return {raw: short for short, raw in getattr(A, "BG_FILTER_OPTIONS", [])}


def _filters(db, me, args, need_dept=True):
    """The bg / unit / department picked, resolved against what exists in this admin's scope (raw HRIS spelling, the
    display name or the short code for a group; case-insensitive). A pick that matches nothing is an error that lists
    the choices, so the model never guesses."""
    where, params = _people(me)
    rows = db.execute("SELECT DISTINCT u.business_group, u.company, TRIM(COALESCE(u.department,'')) FROM users u WHERE "
                      + where, params).fetchall()
    out = {"bg": "", "unit": "", "dept": ""}
    bgs = sorted({r[0] for r in rows if r[0]})
    short = {raw.lower(): raw for raw in bgs}
    for raw in bgs:
        short[_bg_name(raw).lower()] = raw
        code = _bg_code_map().get(raw)
        if code:
            short[code.lower()] = raw
    pick = (args.get("bg") or "").strip()
    if pick:
        raw = short.get(pick.lower())
        if not raw:
            raise ToolError("No business group matches '%s' in your scope. Choose one of: %s." % (
                pick, "; ".join("%s (%s)" % (_bg_code_map().get(b) or _bg_name(b), b) for b in bgs)))
        out["bg"] = raw
    pool = [r for r in rows if not out["bg"] or r[0] == out["bg"]]
    pick = (args.get("unit") or "").strip()
    if pick:
        units = {r[1].lower(): r[1] for r in pool if r[1]}
        if pick.lower() not in units:
            raise ToolError("No unit named '%s' in that scope." % pick)
        out["unit"] = units[pick.lower()]
        pool = [r for r in pool if r[1] == out["unit"]]
    pick = (args.get("department") or "").strip() if need_dept else ""
    if pick:
        depts = {r[2].lower(): r[2] for r in pool if r[2]}
        if pick.lower() not in depts:
            raise ToolError("No department named '%s' in that scope." % pick)
        out["dept"] = depts[pick.lower()]
    return out


def _need(me, module, what):
    if not A.admin_can(me, module, "read"):
        raise ToolError("Your admin role doesn't include %s." % what)


def _super_only(me, what):
    if not A.is_super(me):
        raise ToolError("%s is the super admin's alone, as on the admin pages." % what)


def _active_cycle(db):
    cyc = A.active_cycle(db)
    if not cyc:
        raise ToolError("No cycle is active.")
    return cyc


def _cycle_type(cyc):
    if A.cycle_row_is_early_year(cyc):
        return "Early Year"
    half = cyc["half"]
    return A.CYCLE_HALF_LABEL.get(int(half)) if half is not None else None


# ---------------------------------------------------------------------------
# The tools
# ---------------------------------------------------------------------------
TOOLS = []   # (name, description, inputSchema, function(db, me, args) -> dict)


def tool(name, description, props=None, required=()):
    def wrap(fn):
        schema = {"type": "object", "properties": props or {}, "additionalProperties": False}
        if required:
            schema["required"] = list(required)
        TOOLS.append((name, description, schema, fn))
        return fn
    return wrap


_BG = {"type": "string", "description": "Business group: its short code (e.g. CHBM), display name or HRIS name"}
_UNIT = {"type": "string", "description": "Business unit (company) name"}
_DEPT = {"type": "string", "description": "Department name"}


# 1 -------------------------------------------------------------------------------------------------------------
@tool("cycle_status", "The active cycle: its type and every part's window (MYT), whether it is open, closed or not yet, "
                      "and the days left.")
def t_cycle_status(db, me, args):
    _need(me, "cycle", "the Cycle pages")
    cyc = _active_cycle(db)
    now = A._now_myt()
    cells = []
    for cell, module, who, covers, _subject in A.WINDOW_CELLS:
        opens, closes = A.window_dates(db, cell, cyc["id"])
        state = A.window_state(db, cell, cyc["id"], now)
        due = A._parse_when(closes)
        left = None
        if due and state == "open":
            left = max(0, (due.date() - now.date()).days)
        cells.append({"cell": cell, "module": module, "who": who, "covers": covers,
                      "opens_myt": A._when_disp(opens) or None, "closes_myt": A._when_disp(closes) or None,
                      "state": {"not_open": "not yet", "open": "open", "closed": "closed"}[state],
                      "days_left": left})
    return {"cycle_id": cyc["id"], "name": cyc["name"], "type": _cycle_type(cyc),
            "starts_on": A._when_disp(cyc["starts_on"]) or None, "ends_on": A._when_disp(cyc["ends_on"]) or None,
            "open_by_date": A.cycle_opens_by_date(db, cyc["id"]), "min_job_grade": cyc["min_job_grade"],
            "today_myt": now.strftime("%Y-%m-%d"), "windows": cells}


# 2 -------------------------------------------------------------------------------------------------------------
@tool("participation", "Who takes part in the active cycle: counts taking part and out, by business group and unit, with "
                       "each reason someone is out (grade, confirmation or role, excluded unit, taken out by an admin).",
      {"bg": _BG, "unit": _UNIT})
def t_participation(db, me, args):
    _need(me, "cycle", "the Cycle pages")
    cyc = _active_cycle(db)
    f = _filters(db, me, args, need_dept=False)
    where, params = _people(me)
    if f["bg"]:
        where += " AND u.business_group=?"
        params.append(f["bg"])
    if f["unit"]:
        where += " AND u.company=?"
        params.append(f["unit"])
    act = "(SELECT id FROM cycles WHERE is_active=1)"
    ov = ("EXISTS (SELECT 1 FROM cycle_participants cp WHERE cp.subject_id=u.id AND cp.cycle_id=%s AND cp.mode='%%s')"
          % act)
    # the same order participation() decides in: the grade floor, the left-out unit, an admin's add or take-out, the rule
    sql = ("SELECT u.business_group AS bg, u.company AS unit, CASE "
           "WHEN NOT %s THEN 'below_min_grade' WHEN %s THEN 'unit_out' WHEN %s THEN 'added' WHEN %s THEN 'removed' "
           "WHEN %s THEN 'rule_in' ELSE 'rule_out' END AS why, COUNT(*) AS n FROM users u WHERE %s "
           "GROUP BY 1, 2, 3" % (A.min_grade_sql("u"), A.unit_out_sql("u"), ov % "add", ov % "remove",
                                 A.participant_sql("u"), where))
    keys = ("taking_part", "below_min_grade", "unit_out", "removed_by_admin", "not_confirmed_or_role")
    rows = {}
    total = dict.fromkeys(keys, 0)
    for r in db.execute(sql, params):
        d = rows.setdefault((r["bg"] or "", r["unit"] or ""), dict.fromkeys(keys, 0))
        k = {"below_min_grade": "below_min_grade", "unit_out": "unit_out", "removed": "removed_by_admin",
             "rule_out": "not_confirmed_or_role"}.get(r["why"], "taking_part")
        d[k] += r["n"]
        total[k] += r["n"]
    by_group, by_unit = {}, []
    for (bg, unit), d in sorted(rows.items()):
        g_ = by_group.setdefault(bg, dict.fromkeys(keys, 0))
        for k in keys:
            g_[k] += d[k]
        by_unit.append(dict(d, bg=bg, bg_name=_bg_name(bg), unit=unit, people=sum(d.values())))
    return {"cycle_id": cyc["id"], "min_job_grade": cyc["min_job_grade"], "people": sum(total.values()), "totals": total,
            "by_business_group": [dict(v, bg=k, bg_name=_bg_name(k), people=sum(v.values()))
                                  for k, v in sorted(by_group.items())],
            "by_unit": by_unit,
            "note": "Real, active people in your scope. taking_part = added by an admin or in by the confirmation / role "
                    "rule; the other four are the reasons someone is out, counted in the order the Participants page "
                    "applies them."}


# progress parts ---------------------------------------------------------------------------------------------------
PARTS = {
    "kpi_checkin": {"label": "KPI check-in (Performance)", "module": "pm", "mod": "pm",
                    "roll": {"not_started": ("not_started", "targets"), "in_progress": ("results",),
                             "submitted": ("complete",)}},
    "self_assessment": {"label": "Competency self-assessment", "module": "competency", "mod": "competency",
                        "roll": {"not_started": ("not_assigned", "not_started"), "in_progress": ("started",),
                                 "submitted": ("submitted", "complete")}},
    "f360": {"label": "360 feedback: ratings each assessor owes", "module": "f360", "mod": None,
             "roll": {"not_started": ("not_started",), "in_progress": ("in_progress",), "submitted": ("submitted",)}},
    "career_plan": {"label": "Career Plan", "module": "idp", "mod": "idp",
                    "roll": {"not_started": ("not_started",), "in_progress": ("draft",),
                             "submitted": ("shared", "complete")}},
    "calibration": {"label": "Calibration: potential band decided", "module": "calibration", "mod": "calibration",
                    "roll": {"not_started": ("open",), "in_progress": ("draft",), "submitted": ("complete",)}},
}
_PART_ENUM = {"type": "string", "enum": list(PARTS),
              "description": "kpi_checkin, self_assessment, f360, career_plan or calibration"}


def _part_rows(db, me, part, f):
    """([{uid, eid, bg, unit, dept, stage}], {stage: label}, note): the SAME read the admin Progress pages use
    (_mod_collect for a module; the assessor query for the 360), so these counts are the page's."""
    spec = PARTS[part]
    _need(me, spec["module"], "%s progress" % spec["label"].split(" (")[0].split(":")[0])
    _active_cycle(db)
    if spec["mod"]:
        mod = A._module_view(spec["mod"])
        users, state, note = A._mod_collect(db, me, mod, f["bg"] if A.is_super(me) else "", f["unit"], f["dept"])
        rows = [{"uid": uid, "eid": _eid(users[uid].get("employee_id"), uid), "bg": users[uid].get("business_group") or "",
                 "unit": users[uid].get("company") or "", "dept": (users[uid].get("department") or "").strip(),
                 "stage": s["stage"]} for uid, s in state.items()]
        return rows, {st[0]: st[1] for st in mod["stages"]}, note
    cyc = A.active_cycle(db)
    sql, params = A._assessor_progress_query(me, "", "all", cyc["id"])
    wrap = "SELECT id, employee_id, business_group, company, department, assigned, done FROM (%s) WHERE 1=1" % sql
    wp = list(params)
    if f["bg"]:
        wrap += " AND business_group=?"
        wp.append(f["bg"])
    if f["unit"]:
        wrap += " AND company=?"
        wp.append(f["unit"])
    if f["dept"]:
        wrap += " AND TRIM(COALESCE(department,''))=?"
        wp.append(f["dept"])
    rows = []
    for r in db.execute(wrap, wp):
        stage = "submitted" if r["done"] >= r["assigned"] else ("not_started" if not r["done"] else "in_progress")
        rows.append({"uid": r["id"], "eid": _eid(r["employee_id"], r["id"]), "bg": r["business_group"] or "",
                     "unit": r["company"] or "", "dept": (r["department"] or "").strip(), "stage": stage})
    return rows, {"not_started": "Not started", "in_progress": "In progress", "submitted": "All submitted"}, \
        "People assigned to rate someone in the cycle's 360, and how many of those ratings they have submitted."


def _roll(part, stage):
    for k, stages in PARTS[part]["roll"].items():
        if stage in stages:
            return k
    return "not_started"


# 3 -------------------------------------------------------------------------------------------------------------
@tool("progress", "How far a part of the cycle has got: not started, in progress and submitted counts, with the admin "
                  "page's own stages, one level down (group, unit or department).",
      {"part": _PART_ENUM, "bg": _BG, "unit": _UNIT, "department": _DEPT}, required=("part",))
def t_progress(db, me, args):
    part = args["part"]
    f = _filters(db, me, args)
    rows, labels, note = _part_rows(db, me, part, f)
    stages = {k: 0 for k in labels}
    roll = {"not_started": 0, "in_progress": 0, "submitted": 0}
    for r in rows:
        stages[r["stage"]] = stages.get(r["stage"], 0) + 1
        roll[_roll(part, r["stage"])] += 1
    level = ("bg" if A.is_super(me) and not f["bg"] else "unit" if not f["unit"] else "department" if not f["dept"]
             else None)
    breakdown = []
    if level:
        by = {}
        for r in rows:
            key = {"bg": r["bg"], "unit": r["unit"], "department": r["dept"]}[level]
            b = by.setdefault(key, {"people": 0, "not_started": 0, "in_progress": 0, "submitted": 0})
            b["people"] += 1
            b[_roll(part, r["stage"])] += 1
        for key, b in sorted(by.items(), key=lambda kv: (not kv[0], -kv[1]["people"], kv[0])):
            breakdown.append(dict(b, name=(_bg_name(key) if level == "bg" else key) or "(none on file)",
                                  **({"bg": key} if level == "bg" else {})))
    return {"part": part, "label": PARTS[part]["label"], "people": len(rows), "not_started": roll["not_started"],
            "in_progress": roll["in_progress"], "submitted": roll["submitted"],
            "stages": [{"stage": k, "label": labels[k], "people": n} for k, n in stages.items() if k in labels],
            "rollup_rule": {k: list(v) for k, v in PARTS[part]["roll"].items()},
            "breakdown_by": level, "breakdown": breakdown, "note": note}


# 4 -------------------------------------------------------------------------------------------------------------
@tool("whos_missing", "Employee IDs who have not yet submitted a part (not started or in progress), with the total.",
      {"part": _PART_ENUM, "bg": _BG, "unit": _UNIT, "department": _DEPT,
       "limit": {"type": "integer", "minimum": 1, "maximum": 1000, "description": "IDs to list, default 200"}},
      required=("part",))
def t_whos_missing(db, me, args):
    part = args["part"]
    limit = int(args.get("limit") or 200)
    f = _filters(db, me, args)
    rows, _labels, note = _part_rows(db, me, part, f)
    miss = sorted(r["eid"] for r in rows if _roll(part, r["stage"]) != "submitted")
    return {"part": part, "people_counted": len(rows), "missing_total": len(miss), "listed": min(limit, len(miss)),
            "truncated": len(miss) > limit, "employee_ids": miss[:limit], "note": note}


# 5 -------------------------------------------------------------------------------------------------------------
@tool("person_status", "One person by Employee ID: active, group, unit, job grade, their line manager's and HOD's "
                       "Employee IDs, whether they take part in the cycle and why, and the state of each part. No names.",
      {"employee_id": {"type": "string", "description": "The Employee ID, e.g. 10234"}}, required=("employee_id",))
def t_person_status(db, me, args):
    _need(me, "people", "the People pages")
    eid = (args["employee_id"] or "").strip()
    u = db.execute("SELECT * FROM users WHERE employee_id=? AND role!='admin' AND COALESCE(is_demo,0)=0", (eid,)).fetchone()
    if not u or not A.can_access(me, u["business_group"], u["company"]):
        raise ToolError("No person with that Employee ID in your scope.")
    ids = {r["id"]: r["employee_id"] for r in db.execute(
        "SELECT id, employee_id FROM users WHERE id IN (?, ?)", (u["manager_id"] or 0, u["hod_id"] or 0))}
    out = {"employee_id": eid, "active": not u["left_at"], "left_on_myt": (A._myt(u["left_at"]) or "")[:10] or None,
           "business_group": u["business_group"], "business_group_name": _bg_name(u["business_group"]),
           "unit": u["company"], "department": (u["department"] or "").strip() or None, "job_grade": u["job_grade"],
           "line_manager_employee_id": ids.get(u["manager_id"]) if u["manager_id"] else None,
           "hod_employee_id": ids.get(u["hod_id"]) if u["hod_id"] else None,
           "hod_of_people": db.execute("SELECT COUNT(*) FROM users WHERE hod_id=? AND left_at IS NULL",
                                       (u["id"],)).fetchone()[0],
           "line_manager_of_people": db.execute("SELECT COUNT(*) FROM users WHERE manager_id=? AND left_at IS NULL",
                                                (u["id"],)).fetchone()[0],
           "bu_ceo_of": [{"bg": b, "unit": c} for b, c in A.buceo_seats(db, u["id"])],
           "bg_ceo_of": u["bgceo_bg"] or None}
    cyc = A.active_cycle(db)
    if not cyc or u["left_at"]:
        out.update(in_cycle=False, why="left" if u["left_at"] else "no active cycle", parts={})
        return out
    taking, why = A.participation(db, u, cyc)
    plan, plan_why = A.idp_participation(db, u, cyc)
    out.update(in_cycle=bool(taking), why=why, why_words=A._PARTICIPATION_WORDS.get(why, why),
               has_career_plan=bool(plan))
    me_row = dict(u)
    parts = {}
    for part, spec in PARTS.items():
        if part == "f360":
            r = db.execute("SELECT COUNT(*) AS n, SUM(status='submitted') AS d FROM assignments WHERE assessor_id=? "
                           "AND cycle_id=? AND archived=0 AND " + A.rater_task_sql("assignments"),
                           (u["id"],  cyc["id"])).fetchone()
            n, d = r["n"] or 0, r["d"] or 0
            parts[part] = {"stage": ("none to rate" if not n else "submitted" if d >= n else
                                     "not_started" if not d else "in_progress"), "assigned": n, "submitted": d}
            continue
        if part == "career_plan":
            if not plan:
                parts[part] = {"stage": "not applicable", "why": plan_why}
                continue
        elif not taking:
            parts[part] = {"stage": "not applicable", "why": why}
            continue
        mod = A._module_view(spec["mod"])
        state, _note = mod["state"](db, me, {u["id"]: me_row})
        s = state.get(u["id"])
        parts[part] = {"stage": s["stage"], "rolled_up": _roll(part, s["stage"])} if s else {"stage": "unknown"}
    out["parts"] = parts
    return out


# 6 -------------------------------------------------------------------------------------------------------------
@tool("leader_coverage", "Leader seats: BU CEO seats filled or empty by unit, BG CEOs by group, departments with no HOD, "
                         "and the Employee IDs of active people with no line manager or no HOD.")
def t_leader_coverage(db, me, args):
    _need(me, "leaders", "the Leaders pages")
    where, params = _people(me)
    units = db.execute("SELECT u.business_group AS bg, u.company AS unit, COUNT(*) AS n FROM users u WHERE " + where
                       + " AND COALESCE(u.company,'')!='' GROUP BY 1, 2 ORDER BY 1, 2", params).fetchall()
    sc, sp = A.bg_scope(me, "s.business_group")
    seats = {(r["business_group"], r["company"]): r["employee_id"] for r in db.execute(
        "SELECT s.business_group, s.company, h.employee_id FROM buceo_seats s JOIN users h ON h.id=s.user_id "
        "WHERE h.left_at IS NULL" + sc, sp)}
    bu = [{"bg": r["bg"], "bg_name": _bg_name(r["bg"]), "unit": r["unit"], "people": r["n"],
           "seat_filled": (r["bg"], r["unit"]) in seats, "holder_employee_id": seats.get((r["bg"], r["unit"]))}
          for r in units]
    mybg = A.admin_bg_of(me)
    bgceo = {}
    for r in db.execute("SELECT id, employee_id, bgceo_bg FROM users WHERE COALESCE(bgceo_bg,'')!='' AND left_at IS NULL"):
        if mybg and r["bgceo_bg"] != mybg:
            continue
        bgceo.setdefault(r["bgceo_bg"], []).append(_eid(r["employee_id"], r["id"]))
    group_rows = sorted({r["bg"] for r in units if r["bg"]} | set(bgceo))
    depts = db.execute(
        "SELECT u.business_group AS bg, u.company AS unit, TRIM(COALESCE(u.department,'')) AS dept, COUNT(*) AS n, "
        "SUM(h.id IS NOT NULL AND h.left_at IS NULL) AS with_hod FROM users u LEFT JOIN users h ON h.id=u.hod_id "
        "WHERE " + where + " GROUP BY 1, 2, 3", params).fetchall()
    no_hod_depts = [{"bg": r["bg"], "unit": r["unit"], "department": r["dept"], "people": r["n"]}
                    for r in depts if r["dept"] and not r["with_hod"]]
    lm_ids = [(r["employee_id"], r["id"]) for r in db.execute(
        "SELECT u.id, u.employee_id FROM users u WHERE " + where + " AND u.manager_id IS NULL ORDER BY u.employee_id",
        params)]
    hod_ids = [(r["employee_id"], r["id"]) for r in db.execute(
        "SELECT u.id, u.employee_id FROM users u LEFT JOIN users h ON h.id=u.hod_id WHERE " + where
        + " AND (h.id IS NULL OR h.left_at IS NOT NULL) ORDER BY u.employee_id", params)]
    return {"bu_ceo_seats": {"filled": sum(1 for x in bu if x["seat_filled"]),
                             "empty": sum(1 for x in bu if not x["seat_filled"]), "units": bu},
            "bg_ceo": [{"bg": b, "bg_name": _bg_name(b), "employee_ids": bgceo.get(b, []), "seat_filled": bool(bgceo.get(b))}
                       for b in group_rows],
            "departments": {"total": sum(1 for r in depts if r["dept"]), "without_hod": len(no_hod_depts),
                            "without_hod_list": no_hod_depts[:IDS_MAX]},
            "people_without_line_manager": {"count": len(lm_ids),
                                            "employee_ids": [_eid(e, i) for e, i in lm_ids[:IDS_MAX]]},
            "people_without_hod": {"count": len(hod_ids), "employee_ids": [_eid(e, i) for e, i in hod_ids[:IDS_MAX]],
                                   "note": "No HOD on file, or the HOD has left."}}


# 7 -------------------------------------------------------------------------------------------------------------
@tool("data_quality", "Gaps in the people data, as counts with up to 100 Employee IDs each: no email, an email shared by "
                      "two or more accounts, no line manager, no job grade, no unit.")
def t_data_quality(db, me, args):
    _need(me, "people", "the People pages")
    where, params = _people(me)
    rows = db.execute(
        "SELECT u.id, u.employee_id, "
        "(u.email IS NULL OR TRIM(u.email)='') AS no_email, "
        "(TRIM(COALESCE(u.email,''))!='' AND lower(TRIM(u.email)) IN (SELECT lower(TRIM(x.email)) FROM users x "
        " WHERE x.role!='admin' AND x.left_at IS NULL AND COALESCE(x.is_demo,0)=0 AND TRIM(COALESCE(x.email,''))!='' "
        " GROUP BY 1 HAVING COUNT(*)>1)) AS shared_email, "
        "(u.manager_id IS NULL) AS no_lm, (u.job_grade IS NULL OR TRIM(CAST(u.job_grade AS TEXT))='') AS no_grade, "
        "(u.company IS NULL OR TRIM(u.company)='') AS no_unit FROM users u WHERE " + where + " ORDER BY u.employee_id",
        params).fetchall()
    out = {"people": len(rows)}
    for key, col in (("no_email", "no_email"), ("shared_email", "shared_email"), ("no_line_manager", "no_lm"),
                     ("no_job_grade", "no_grade"), ("no_unit", "no_unit")):
        hit = [_eid(r["employee_id"], r["id"]) for r in rows if r[col]]
        out[key] = {"count": len(hit), "employee_ids": hit[:IDS_MAX], "truncated": len(hit) > IDS_MAX}
    out["shared_email"]["note"] = "Accounts whose email another active account also uses; the addresses are not returned."
    return out


# 8 -------------------------------------------------------------------------------------------------------------
@tool("ticket_queue", "Open tickets (Get Help and sign-in help) by type and age (0-1, 2-3, 4-7, over 7 days), with the "
                      "ticket ids. Never the text of a ticket.")
def t_ticket_queue(db, me, args):
    if not (A.is_super(me) or A.admin_can_item(me, "ticketing.read")):
        raise ToolError("Your admin role doesn't include Ticketing.")
    now = A._utc_now()
    buckets = ("0-1 days", "2-3 days", "4-7 days", "over 7 days")
    by_type, listing = {}, []
    open_n = 0
    for t in A._tickets(db, me):
        if t["status"] == "closed" or t.get("topic_key") in A._TK_SUPER_ONLY:   # a Grade H "I do not agree" ticket is never listed to an AI client
            continue
        open_n += 1
        ts = A._tk_ts(t["created_at"])
        days = max(0, (now - ts).days) if ts else 0
        b = buckets[0 if days <= 1 else 1 if days <= 3 else 2 if days <= 7 else 3]
        d = by_type.setdefault(t["type_label"], {k: 0 for k in buckets})
        d[b] += 1
        listing.append({"ticket": t["ref"], "kind": t["kind"], "id": t["id"], "status": t["status"], "age_days": days,
                        "topic": t["topic"]})
    listing.sort(key=lambda x: -x["age_days"])
    return {"open": open_n, "by_type": [dict(v, type=k, total=sum(v.values())) for k, v in sorted(by_type.items())],
            "tickets": listing[:IDS_MAX], "truncated": len(listing) > IDS_MAX,
            "note": "Open means not closed (new or in progress). The oldest are listed first."}


# 9 -------------------------------------------------------------------------------------------------------------
@tool("email_outbox", "Queued, sent and failed email counts by kind and batch, and the next wave's time (MYT). Never an "
                      "address or a body.")
def t_email_outbox(db, me, args):
    _super_only(me, "Email")
    st = A.outbox_status(db)
    rows = db.execute("SELECT kind, batch, status, COUNT(*) AS n, MIN(send_after) AS nxt, MAX(sent_at) AS last_sent "
                      "FROM email_outbox WHERE created_at > datetime('now','-30 days') GROUP BY kind, batch, status "
                      "ORDER BY MAX(id) DESC LIMIT 200").fetchall()
    batches = {}
    for r in rows:
        b = batches.setdefault((r["kind"], r["batch"] or ""), {"kind": r["kind"], "batch": r["batch"] or None,
                                                              "queued": 0, "sending": 0, "sent": 0, "failed": 0,
                                                              "cancelled": 0, "next_wave_myt": None,
                                                              "last_sent_myt": None})
        b[r["status"]] = b.get(r["status"], 0) + r["n"]
        if r["status"] == "queued" and r["nxt"]:
            b["next_wave_myt"] = min(filter(None, (b["next_wave_myt"], A._myt(r["nxt"]))))
        if r["last_sent"]:
            b["last_sent_myt"] = max(filter(None, (b["last_sent_myt"], A._myt(r["last_sent"]))))
    nxt = db.execute("SELECT MIN(send_after) FROM email_outbox WHERE status='queued' AND send_after > datetime('now')"
                     ).fetchone()[0]
    return {"queued": st["queued"], "due_now": st["due"], "waiting_for_a_wave": st["later"],
            "failed_last_day": st["failed_today"], "next_wave_myt": A._myt(nxt) if nxt else None,
            "batches_last_30_days": list(batches.values())[:50]}


# 10 ------------------------------------------------------------------------------------------------------------
@tool("audit_search", "Search the admin audit log: when (MYT), the actor's Employee ID, the action and the person it was "
                      "done to. The detail text is not returned.",
      {"actor_employee_id": {"type": "string"}, "action": {"type": "string", "description": "An action code or its label"},
       "date_from": {"type": "string", "description": "YYYY-MM-DD (MYT)"},
       "date_to": {"type": "string", "description": "YYYY-MM-DD (MYT)"},
       "limit": {"type": "integer", "minimum": 1, "maximum": 200, "description": "Rows, default 50"}})
def t_audit_search(db, me, args):
    _super_only(me, "The audit log")
    limit = int(args.get("limit") or 50)
    for k in ("date_from", "date_to"):
        if args.get(k) and not A._valid_iso_date(args[k]):
            raise ToolError("%s must be a date as YYYY-MM-DD." % k)
    codes = A._audit_action_codes(db, [args["action"].strip()]) if (args.get("action") or "").strip() else []
    where, params = A._audit_log_where("", args.get("date_from") or "", args.get("date_to") or "", codes, [])()
    if (args.get("actor_employee_id") or "").strip():
        where += " AND ua.employee_id = ?"
        params.append(args["actor_employee_id"].strip())
    total = db.execute("SELECT COUNT(*) %s %s" % (A._AUDIT_LOG_FROM, where), params).fetchone()[0]
    rows = db.execute("SELECT al.id, al.created_at, al.action, al.user_id, ua.employee_id AS actor_eid, "
                      "al.target_user_id, ut.employee_id AS target_eid %s %s ORDER BY al.id DESC LIMIT ?"
                      % (A._AUDIT_LOG_FROM, where), params + [limit]).fetchall()
    return {"total_matching": total, "returned": len(rows),
            "rows": [{"id": r["id"], "when_myt": A._myt(r["created_at"]),
                      "actor_employee_id": _eid(r["actor_eid"], r["user_id"]) if r["user_id"] else None,
                      "action": r["action"], "action_label": A.action_label(r["action"]),
                      "target_employee_id": _eid(r["target_eid"], r["target_user_id"]) if r["target_user_id"] else None}
                     for r in rows]}


# 11 ------------------------------------------------------------------------------------------------------------
@tool("notices", "The Banner: notices scheduled or live (kind, start and end in MYT), live announcements (their headline) "
                 "and the release window's state.")
def t_notices(db, me, args):
    _super_only(me, "The Banner")
    now = A._now_myt()
    rules = A.release_rules()
    live = A.notice_current(db, now)
    notices = []
    for n in db.execute("SELECT * FROM site_notices WHERE status='scheduled' ORDER BY starts_at, id"):
        t = A.notice_times(n, rules)
        if t["end"] <= now and not n["reopened_at"]:
            continue
        notices.append({"id": n["id"], "kind": n["kind"], "source": n["source"], "closes_the_site": bool(n["closes"]),
                        "downtime_minutes": n["downtime_min"], "bar_from_myt": t["show_from"].strftime("%Y-%m-%d %H:%M"),
                        "starts_myt": t["start"].strftime("%Y-%m-%d %H:%M"), "ends_myt": t["end"].strftime("%Y-%m-%d %H:%M"),
                        "reopened_early": bool(n["reopened_at"]), "showing_now": bool(live and live["id"] == n["id"])})
    anns = [{"id": r["id"], "headline": r["headline"], "audience": r["audience"], "starts_myt": r["starts_at"],
             "ends_myt": r["ends_at"]} for r in db.execute(
                 "SELECT id, headline, audience, starts_at, ends_at FROM site_announcements WHERE status='live' "
                 "ORDER BY starts_at, id")]
    return {"now_myt": now.strftime("%Y-%m-%d %H:%M"), "notices": notices, "announcements": anns,
            "release_window": {"on": bool(rules["on"]), "mode": rules["mode"], "evening_applies_today": A.release_window_open(db),
                               "start": rules["start"]}}


# 12 ------------------------------------------------------------------------------------------------------------
@tool("admin_roles", "Admin roles, the access items each one ticks, and the Employee IDs of the admins holding each.")
def t_admin_roles(db, me, args):
    _super_only(me, "Roles and access")
    roles = {r["id"]: r for r in A.admin_roles_all(db, with_retired=True)}
    items = {}
    for r in db.execute("SELECT role_id, item FROM admin_role_access ORDER BY item"):
        if r["item"] in A.ADMIN_ITEM_BY_KEY:
            items.setdefault(r["role_id"], []).append(r["item"])
    builtin_id = {r["builtin"]: r["id"] for r in roles.values() if r["builtin"]}
    unit_admins = {r[0] for r in db.execute("SELECT DISTINCT admin_id FROM admin_companies")}
    holders = {}
    supers = []
    for a in db.execute("SELECT id, employee_id, admin_bg, admin_role_id FROM users WHERE role='admin' AND left_at IS NULL"):
        if not a["admin_bg"]:
            supers.append(_eid(a["employee_id"], a["id"]))
            continue
        rid = a["admin_role_id"] if a["admin_role_id"] in roles else builtin_id.get(
            "lnd" if a["admin_bg"] == A.LMS_ADMIN_BG else "bu" if a["id"] in unit_admins else "bg")
        holders.setdefault(rid, []).append(_eid(a["employee_id"], a["id"]))
    out = [{"role_id": r["id"], "name": r["name"], "scope_kind": r["scope_kind"], "built_in": r["builtin"],
            "retired": bool(r["retired_at"]), "items": items.get(r["id"], []),
            "holder_employee_ids": sorted(holders.get(r["id"], []))} for r in roles.values()]
    return {"super_admin_employee_ids": sorted(supers), "roles": out,
            "note": "The super admin is outside the roles and holds every item."}


# 13 ------------------------------------------------------------------------------------------------------------
@tool("system_health", "The running commit if known, the database size, the latest backup time (MYT) if readable, and the "
                       "reminders and platform switches.")
def t_system_health(db, me, args):
    _super_only(me, "System health")
    size = wal = None
    try:
        size = os.path.getsize(A.DB_PATH)
        wal = os.path.getsize(A.DB_PATH + "-wal") if os.path.exists(A.DB_PATH + "-wal") else 0
    except OSError:
        pass
    latest = None
    try:
        d = A._imp_backup_dir()
        times = [os.path.getmtime(os.path.join(d, f)) for f in os.listdir(d)
                 if os.path.isfile(os.path.join(d, f)) and ".db" in f]
        if times:
            latest = (datetime.utcfromtimestamp(max(times)) + timedelta(hours=8)).strftime("%Y-%m-%d %H:%M")
    except OSError:
        pass
    try:
        app_bytes = os.path.getsize(os.path.join(A.APP_DIR, "app.py"))
    except OSError:
        app_bytes = None
    return {"commit": _commit(), "app_bytes": app_bytes, "asset_version": A.ASSET_V, "production": bool(A._PROD),
            "database_bytes": size, "database_wal_bytes": wal, "latest_backup_myt": latest,
            "reminders_auto_enabled": A._setting("reminder_auto_enabled", "0") == "1",
            "ai_learning_on": bool(A.lms_on()), "now_myt": A._now_myt().strftime("%Y-%m-%d %H:%M"),
            "note": "latest_backup_myt is the newest database copy in the backups folder this process can read; null when "
                    "it cannot read one (staging, a local run)."}


TOOL_BY_NAME = {t[0]: t for t in TOOLS}
assert len(TOOLS) == 13 and len(TOOL_BY_NAME) == 13


# ---------------------------------------------------------------------------
# Argument checking (a small JSON Schema subset: what the tools above use)
# ---------------------------------------------------------------------------
def _check_args(schema, args):
    if not isinstance(args, dict):
        raise ToolError("Arguments must be an object.")
    props = schema["properties"]
    extra = sorted(set(args) - set(props))
    if extra:
        raise ToolError("Unknown argument(s): %s." % ", ".join(extra))
    for k in schema.get("required", ()):
        if args.get(k) in (None, ""):
            raise ToolError("'%s' is required." % k)
    for k, v in args.items():
        p = props[k]
        if v is None:
            continue
        if p["type"] == "string":
            if not isinstance(v, str):
                raise ToolError("'%s' must be a string." % k)
            if len(v) > 200:
                raise ToolError("'%s' is too long." % k)
            if "enum" in p and v not in p["enum"]:
                raise ToolError("'%s' must be one of: %s." % (k, ", ".join(p["enum"])))
        elif p["type"] == "integer":
            if isinstance(v, bool) or not isinstance(v, int):
                raise ToolError("'%s' must be a whole number." % k)
            if v < p.get("minimum", v) or v > p.get("maximum", v):
                raise ToolError("'%s' must be between %d and %d." % (k, p["minimum"], p["maximum"]))
    return {k: v for k, v in args.items() if v is not None}


# ---------------------------------------------------------------------------
# The endpoint
# ---------------------------------------------------------------------------
def register(app, app_module):
    """Add POST /mcp to the Flask app. `app_module` is app.py's module (its helpers are read as A.<name>)."""
    global A
    from flask import Response, abort, request

    A = app_module

    def reply(obj, status=200, headers=None):
        r = Response(_compact(obj), status=status, mimetype="application/json")
        for k, v in (headers or {}).items():
            r.headers[k] = v
        return r

    def rpc_error(rid, code, msg, status=200):
        return reply({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": msg}}, status)

    def refuse(status, msg, headers=None):
        return reply({"error": msg}, status, headers)

    def authenticate(db):
        """(me, token row, None) or (None, None, a response). 401: no or unknown / revoked / expired token, or an
        account that has left. 403: a live token whose account is not a system admin."""
        auth = request.headers.get("Authorization", "")
        m = re.match(r"^Bearer\s+(\S+)\s*$", auth, re.I)
        bad = refuse(401, "A valid bearer token is required.", {"WWW-Authenticate": 'Bearer realm="onehr-mcp"'})
        if not m:
            return None, None, bad
        tok = db.execute("SELECT * FROM mcp_tokens WHERE token_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR "
                         "expires_at > datetime('now'))", (token_hash(m.group(1)),)).fetchone()
        if not tok:
            return None, None, bad
        me = db.execute("SELECT * FROM users WHERE id=?", (tok["user_id"],)).fetchone()
        if not me or me["left_at"]:
            return None, None, bad
        if not A.is_system(me):
            return None, None, refuse(403, "AI+ Connect is for system admins only.")
        return me, tok, None

    def touch(db, tok):
        """The token's last use, at most once a minute: one short write, committed at once."""
        ip = (request.headers.get("X-Real-IP") or request.remote_addr or "")[:64]
        db.execute("UPDATE mcp_tokens SET last_used_at=datetime('now'), last_used_ip=? WHERE id=? AND "
                   "(last_used_at IS NULL OR last_used_at < datetime('now','-60 seconds') OR last_used_ip IS NOT ?)",
                   (ip, tok["id"], ip))
        db.commit()

    def tools_list():
        return {"tools": [{"name": n, "description": d, "inputSchema": s, "annotations": {"readOnlyHint": True}}
                          for n, d, s, _f in TOOLS]}

    def tools_call(db, me, params):
        name = (params or {}).get("name")
        entry = TOOL_BY_NAME.get(name) if isinstance(name, str) else None
        if not entry:
            return None
        _n, _d, schema, fn = entry
        raw = params.get("arguments") or {}
        A.log_activity(db, me["id"], "mcp_call", ("%s %s" % (name, _compact(raw)))[:600])
        try:
            data = fn(db, me, _check_args(schema, raw))
        except ToolError as e:
            return {"content": [{"type": "text", "text": str(e)}], "isError": True}
        except Exception as e:   # noqa: BLE001 -- the model never sees a stack trace; the log does
            A.app.logger.exception("mcp tool %s failed", name)
            return {"content": [{"type": "text", "text": "That tool failed (%s). Nothing was changed." % type(e).__name__}],
                    "isError": True}
        return {"content": [{"type": "text", "text": _compact(data)}], "structuredContent": data}

    def mcp_endpoint():
        if not _enabled():
            abort(404)
        # DNS-rebinding guard (the spec's rule): a browser page on another origin never reaches a token
        origin = request.headers.get("Origin")
        if origin and urlparse(origin).netloc != request.host:
            return refuse(403, "Origin not allowed.")
        db = A.get_db()
        me, tok, resp = authenticate(db)
        if resp is not None:
            return resp
        ok, wait = _rate_check(tok["id"])
        if not ok:
            return refuse(429, "Rate limit: %d calls a minute per token." % RATE_LIMIT, {"Retry-After": str(wait)})
        touch(db, tok)
        body = request.get_json(silent=True, force=True)
        if body is None:
            return rpc_error(None, -32700, "Parse error: the body is not JSON.", 400)
        if isinstance(body, list):
            return rpc_error(None, -32600, "Batch requests are not supported.", 400)
        if not isinstance(body, dict) or body.get("jsonrpc") != "2.0":
            return rpc_error(None, -32600, "Invalid request.", 400)
        method = body.get("method")
        if "id" not in body or method is None:   # a notification, or a response from the client: accepted, no body
            return Response(status=202)
        rid = body["id"]
        params = body.get("params") if isinstance(body.get("params"), dict) else {}
        if method == "initialize":
            asked = params.get("protocolVersion")
            return reply({"jsonrpc": "2.0", "id": rid, "result": {
                "protocolVersion": asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "onehr-admin", "version": _commit() or "1"},
                "instructions": "Read-only admin data from OneHR, scoped to the signed-in admin. Tools return Employee IDs "
                                "and counts, never names, ratings, remarks or email addresses."}})
        if method == "ping":
            return reply({"jsonrpc": "2.0", "id": rid, "result": {}})
        if method == "tools/list":
            return reply({"jsonrpc": "2.0", "id": rid, "result": tools_list()})
        if method == "tools/call":
            result = tools_call(db, me, params)
            if result is None:
                return rpc_error(rid, -32602, "Unknown tool: %s" % str(params.get("name"))[:60])
            return reply({"jsonrpc": "2.0", "id": rid, "result": result})
        return rpc_error(rid, -32601, "Method not found: %s" % str(method)[:60])

    app.add_url_rule("/mcp", "mcp_endpoint", mcp_endpoint, methods=["POST"])
