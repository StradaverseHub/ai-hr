"""AI+ Connect: the admin MCP server, phase 1 (read only; Chris approved the design 2026-10-28).

POST /mcp, MCP Streamable HTTP, stateless JSON, in onehr_mcp.py. What this suite holds:
  * off unless ONEHR_MCP=1 (404), GET is 405
  * a bearer token and nothing else: none / bad / revoked / expired -> 401; a token whose account is no admin, or whose
    role lacks `mcp.use` -> 403; a signed-in session cookie with no bearer -> 401; no CSRF token needed, no cookie set
  * the protocol: initialize (version negotiated), notifications -> 202, ping, tools/list is exactly the 13 tools,
    an unknown method -> -32601, a batch -> -32600, tool errors come back as isError results
  * every tool answers on the suite database, IDs and counts only: no person's name and no email address in any output
  * scope: a BG admin's token sees only their group; the super admin's tools stay the super admin's
  * the counts agree with the admin pages' own functions (participation, progress)
  * every tools/call is an audit row (and shows in the audit log), the token's last use is kept, 60 calls a minute
  * the token helpers store a hash only; the access item mcp.use is in no preset

Guards falsified by hand while writing it (break, see this suite fail, put back): the revoked check, the mcp.use check,
the scope clause (bg_scope), the rate limit, and the CSRF exemption in app.py.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("AI+ Connect: the admin MCP server (phase 1, read only)")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
import onehr_mcp as M  # noqa: E402

os.environ.pop("ONEHR_MCP", None)
SUPER, BGA, EMP = H.actors(a)
s.check("(the suite database has a super admin, a BG admin and an employee)", bool(SUPER and BGA and EMP))
# AI+ Connect is for SYSTEM admins only (Chris, 2026-10-28): one is made in the scratch copy (restored at the end)
with a.app.app_context():
    _db = a.get_db()
    _sid = _db.execute("INSERT INTO users(username, full_name, password_hash, role, admin_bg, is_system_admin) VALUES "
                       "('zz-mcp-sysadmin', 'ZZ MCP System admin', 'x', 'admin', NULL, 1)").lastrowid
    _db.commit()
    SU = _db.execute("SELECT * FROM users WHERE id=?", (_sid,)).fetchone()
EXPECTED = ["admin_roles", "audit_search", "cycle_status", "data_quality", "email_outbox", "leader_coverage", "notices",
            "participation", "person_status", "progress", "system_health", "ticket_queue", "whos_missing"]
SUPER_ONLY = ["admin_roles", "audit_search", "email_outbox", "notices", "system_health"]
H_JSON = {"Content-Type": "application/json"}


def mk(uid, name="suite", days=30):
    with a.app.app_context():
        return M.mcp_token_create(a.get_db(), uid, name, None, days)


def post(c, body, token=None, extra=None):
    h = dict(H_JSON, **(extra or {}))
    if token:
        h["Authorization"] = "Bearer " + token
    return c.post("/mcp", data=json.dumps(body), headers=h)


def rpc(c, token, method, params=None, rid=1):
    return post(c, {"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}, token)


def call(c, token, name, args=None):
    r = rpc(c, token, "tools/call", {"name": name, "arguments": args or {}})
    j = r.get_json(silent=True) or {}
    return r, j.get("result")


def data(res):
    return json.loads(res["content"][0]["text"])


def reset_rate():
    with M._RATE_LOCK:
        M._RATE.clear()


def one(sql, args=()):
    return H.one(a, sql, args)


c = a.app.test_client()
TOK = mk(SU["id"])
TOK_SUPER = mk(SUPER["id"], "a super admin's")

# ---------------------------------------------------------------------------------------------------------------------
s.section("Off unless ONEHR_MCP=1")
r_off = post(c, {"jsonrpc": "2.0", "id": 1, "method": "ping"}, TOK)
s.check("POST /mcp is a 404 while the switch is off, even with a good token", r_off.status_code == 404, r_off.status_code)
s.check("...and with no token at all (it does not say the endpoint exists)", post(c, {}).status_code == 404)
os.environ["ONEHR_MCP"] = "1"
try:
    # -----------------------------------------------------------------------------------------------------------------
    s.section("The route")
    rules = [r for r in a.app.url_map.iter_rules() if r.rule == "/mcp"]
    s.check("one rule, POST only", len(rules) == 1 and rules[0].methods - {"OPTIONS"} == {"POST"}, [r.methods for r in rules])
    s.check("GET /mcp is 405", c.get("/mcp").status_code == 405)
    s.check("its endpoint is named in the module gate's ungated list", "mcp_endpoint" in a.MODULE_UNGATED_ENDPOINTS)

    # -----------------------------------------------------------------------------------------------------------------
    s.section("Authentication: a bearer token and nothing else")
    reset_rate()
    ping = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
    r = post(c, ping)
    s.check("no token -> 401 with WWW-Authenticate: Bearer", r.status_code == 401
            and r.headers.get("WWW-Authenticate", "").startswith("Bearer"), (r.status_code, dict(r.headers)))
    s.check("a made-up token -> 401", post(c, ping, "ohr_notatoken").status_code == 401)
    s.check("a header that is not Bearer -> 401", c.post("/mcp", data=json.dumps(ping), headers=dict(
        H_JSON, Authorization="Basic abc")).status_code == 401)
    t_rev = mk(SU["id"], "to revoke")
    s.check("(a live token works first)", post(c, ping, t_rev).status_code == 200)
    with a.app.app_context():
        tid = a.get_db().execute("SELECT id FROM mcp_tokens WHERE token_hash=?", (M.token_hash(t_rev),)).fetchone()[0]
        s.check("revoking it says so once, then there is nothing to revoke",
                M.mcp_token_revoke(a.get_db(), tid, SU["id"]) is True and M.mcp_token_revoke(a.get_db(), tid, SU["id"]) is False)
    s.check("a revoked token -> 401", post(c, ping, t_rev).status_code == 401)
    t_exp = mk(SU["id"], "expired")
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE mcp_tokens SET expires_at=datetime('now','-1 minute') WHERE token_hash=?", (M.token_hash(t_exp),))
        db.commit()
    s.check("an expired token -> 401", post(c, ping, t_exp).status_code == 401)
    r = post(c, ping, TOK)
    s.check("the live super admin token -> 200 and no cookie is set", r.status_code == 200 and not r.headers.get("Set-Cookie"),
            (r.status_code, r.headers.get("Set-Cookie")))
    # a signed-in browser (session cookie) with no bearer
    cs = H.client_as(a, SU["id"], csrf="tok")
    r = post(cs, ping)
    s.check("a signed-in session cookie without a bearer -> 401", r.status_code == 401, r.status_code)
    s.check("...and the cookie does not stand in for the bearer's account either (a bad bearer is still 401)",
            post(cs, ping, "ohr_wrong").status_code == 401)
    s.check("a bearer POST needs no CSRF token (none was sent, and the session has none)", post(c, ping, TOK).status_code == 200)
    # accounts
    s.check("a SUPER admin's token -> 403: AI+ Connect is hidden from super admins", post(c, ping, TOK_SUPER).status_code == 403,
            post(c, ping, TOK_SUPER).status_code)
    s.check("...and a system admin's token -> 200", post(c, ping, TOK).status_code == 200)
    tok_emp = mk(EMP["id"], "employee")
    s.check("a token whose account is not an admin -> 403", post(c, ping, tok_emp).status_code == 403)
    tok_bga = mk(BGA["id"], "bg admin")
    s.check("a BG admin's token -> 403", post(c, ping, tok_bga).status_code == 403)
    tok_left = mk(SU["id"], "left")
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET left_at=datetime('now') WHERE id=?", (SU["id"],))
        db.commit()
    s.check("an account that has left -> 401", post(c, ping, tok_left).status_code == 401)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET left_at=NULL WHERE id=?", (SU["id"],))
        db.commit()
    s.check("(back: the super admin works again)", post(c, ping, TOK).status_code == 200)
    # last used
    lu = H.rows(a, "SELECT last_used_at, last_used_ip FROM mcp_tokens WHERE token_hash=?", (M.token_hash(TOK),))[0]
    s.check("the token's last use and address are kept", bool(lu[0]) and bool(lu[1]), tuple(lu))
    # the item
    s.check("there is no mcp.use access item or AI+ Connect module on Roles & access (no role can give it)",
            "mcp.use" not in a.ADMIN_ITEM_KEYS and "mcp" not in a.ACCESS_MODULE_KEYS and "mcp.use" not in a.ADMIN_ITEMS_EXPLICIT)
    pg = H.client_as(a, SUPER["id"]).get("/admin/roles")
    s.check("the Roles & access page renders and does not mention AI+ Connect", pg.status_code == 200
            and "AI+ Connect" not in pg.get_data(as_text=True) and "mcp.use" not in pg.get_data(as_text=True), pg.status_code)

    # -----------------------------------------------------------------------------------------------------------------
    s.section("The protocol")
    reset_rate()
    r = rpc(c, TOK, "initialize", {"protocolVersion": "2025-03-26"})
    res = r.get_json()["result"]
    s.check("initialize echoes a version it knows", res["protocolVersion"] == "2025-03-26", res.get("protocolVersion"))
    res = rpc(c, TOK, "initialize", {"protocolVersion": "1999-01-01"}).get_json()["result"]
    s.check("...and offers 2025-06-18 for one it does not", res["protocolVersion"] == "2025-06-18")
    s.check("capabilities are tools only; serverInfo named", res["capabilities"] == {"tools": {}}
            and res["serverInfo"]["name"] == "onehr-admin" and bool(res["serverInfo"]["version"]), res)
    s.check("the instructions say IDs and counts, never names", "never names" in res["instructions"])
    r = post(c, {"jsonrpc": "2.0", "method": "notifications/initialized"}, TOK)
    s.check("a notification -> 202 with no body", r.status_code == 202 and r.get_data() == b"", r.status_code)
    s.check("ping -> an empty result", rpc(c, TOK, "ping").get_json()["result"] == {})
    j = rpc(c, TOK, "no/such/method").get_json()
    s.check("an unknown method -> JSON-RPC -32601", j["error"]["code"] == -32601, j)
    r = post(c, [ping, ping], TOK)
    s.check("a batch -> -32600", r.get_json()["error"]["code"] == -32600, r.get_json())
    r = c.post("/mcp", data="not json", headers=dict(H_JSON, Authorization="Bearer " + TOK))
    s.check("a body that is not JSON -> -32700", r.get_json()["error"]["code"] == -32700, r.status_code)
    tl = rpc(c, TOK, "tools/list").get_json()["result"]["tools"]
    s.check("tools/list is exactly the 13 tools", sorted(t["name"] for t in tl) == EXPECTED, [t["name"] for t in tl])
    s.check("each has a one-line description, an object inputSchema and readOnlyHint",
            all(t["description"] and "\n" not in t["description"] and t["inputSchema"]["type"] == "object"
                and t["annotations"] == {"readOnlyHint": True} for t in tl))
    j = rpc(c, TOK, "tools/call", {"name": "delete_everything", "arguments": {}}).get_json()
    s.check("an unknown tool -> -32602", j["error"]["code"] == -32602, j)
    r, res = call(c, TOK, "progress", {"part": "not_a_part"})
    s.check("a bad argument is an isError result in plain words", res["isError"] is True and "one of" in res["content"][0]["text"], res)
    r, res = call(c, TOK, "cycle_status", {"surprise": 1})
    s.check("an unknown argument is refused", res["isError"] is True and "Unknown argument" in res["content"][0]["text"])
    r = post(c, {"jsonrpc": "2.0", "id": 5, "method": "ping"}, TOK, {"Origin": "https://evil.example"})
    s.check("a browser Origin that is not this host -> 403", r.status_code == 403, r.status_code)

    # -----------------------------------------------------------------------------------------------------------------
    s.section("Every tool answers on the suite database, and says no names")
    reset_rate()
    with a.app.app_context():
        db = a.get_db()
        part_emp = db.execute("SELECT employee_id FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0 "
                              "AND manager_id IS NOT NULL AND hod_id IS NOT NULL AND employee_id IS NOT NULL "
                              "ORDER BY id LIMIT 1").fetchone()[0]
        names = sorted({(r[0] or "").strip().lower() for r in db.execute("SELECT full_name FROM users")
                        if len((r[0] or "").strip()) >= 8})
        for r in db.execute("SELECT display_name FROM users WHERE COALESCE(display_name,'')!=''"):
            if len(r[0].strip()) >= 8:
                names.append(r[0].strip().lower())
        emails = [(r[0] or "").strip().lower() for r in db.execute("SELECT email FROM users WHERE TRIM(COALESCE(email,''))!=''")]
    s.check("(a person to look up, and %d names, %d email addresses to look for)" % (len(names), len(emails)),
            bool(part_emp) and len(names) > 100 and len(emails) > 100)
    ARGS = {"progress": {"part": "kpi_checkin"}, "whos_missing": {"part": "self_assessment", "limit": 50},
            "person_status": {"employee_id": part_emp}, "audit_search": {"limit": 20}}
    outs = {}
    for name in EXPECTED:
        r, res = call(c, TOK, name, ARGS.get(name, {}))
        ok = r.status_code == 200 and res is not None and not res.get("isError")
        s.check("%s answers without error" % name, ok, (res or {}).get("content", [{}])[0].get("text", "")[:160] if not ok else "")
        if ok:
            outs[name] = res
            s.check("   ...its structuredContent is the text's JSON", res["structuredContent"] == data(res))
    for p in ("kpi_checkin", "self_assessment", "f360", "career_plan", "calibration"):
        for tname in ("progress", "whos_missing"):
            r, res = call(c, TOK, tname, {"part": p})
            s.check("%s answers for part %s" % (tname, p), r.status_code == 200 and not res.get("isError"),
                    res["content"][0]["text"][:160])
            outs["%s:%s" % (tname, p)] = res
    r, res = call(c, TOK, "participation", {"bg": "CHBM"})
    outs["participation:bg"] = res
    s.check("a business group by its short code resolves (or says what exists)", "isError" not in res or res["isError"] is False
            or "Choose one of" in res["content"][0]["text"], res["content"][0]["text"][:120])
    email_re = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}")
    leaks = []
    for key, res in outs.items():
        text = res["content"][0]["text"].lower()
        hit = [n for n in names if n in text]
        if hit:
            leaks.append((key, "name", len(hit)))
        if email_re.search(text) or any(e in text for e in emails[:2000]):
            leaks.append((key, "email"))
    s.check("no person's full name or email address appears in any tool's output (%d outputs)" % len(outs), not leaks, leaks)
    big = [(k, len(r["content"][0]["text"])) for k, r in outs.items() if len(r["content"][0]["text"]) > 60000]
    s.check("no output is huge (IDs are capped per group)", not big, big)
    ps = data(outs["person_status"])
    s.check("person_status gives IDs for the manager and HOD, group, unit, grade, parts",
            ps["employee_id"] == part_emp and ps["line_manager_employee_id"] and ps["hod_employee_id"]
            and "business_group" in ps and "job_grade" in ps and "parts" in ps and "in_cycle" in ps, sorted(ps))
    r, res = call(c, TOK, "person_status", {"employee_id": "NO-SUCH-ID"})
    s.check("an unknown Employee ID is a plain refusal", res["isError"] is True)
    dq = data(outs["data_quality"])
    s.check("data_quality caps each list at 100 IDs and counts the rest", all(
        len(dq[k]["employee_ids"]) <= 100 and dq[k]["count"] >= len(dq[k]["employee_ids"])
        for k in ("no_email", "shared_email", "no_line_manager", "no_job_grade", "no_unit")))
    s.check("the audit rows come back without the detail text", all("detail" not in row for row in data(outs["audit_search"])["rows"]))

    # -----------------------------------------------------------------------------------------------------------------
    s.section("The counts are the admin pages' own")
    with a.app.test_request_context("/"):
        db = a.get_db()
        me = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        cyc = a.active_cycle(db)
        pop = db.execute("SELECT * FROM users WHERE role != 'admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0").fetchall()
        want = {"in": 0, "out": 0, "below": 0, "unit": 0}
        for u in pop:
            taking, why = a.participation(db, u, cyc)
            want["below" if why == "below_min_grade" else "unit" if why == "unit_out" else "in" if taking else "out"] += 1
        pr = data(call(c, TOK, "participation")[1])["totals"]
        got = {"in": pr["taking_part"], "out": pr["removed_by_admin"] + pr["not_confirmed_or_role"],
               "below": pr["below_min_grade"], "unit": pr["unit_out"]}
        s.check("participation == the Participants page's loop of participation() %s" % want, got == want, (got, want))
        s.check("...and it counted every real active person (%d)" % len(pop), data(call(c, TOK, "participation")[1])["people"] == len(pop))
        s.check("(the suite database has people in more than one state, so the equality means something)",
                sum(1 for v in want.values() if v) >= 2, want)
        # every reason someone is out, made to happen in the scratch copy (put back below): a grade floor, a left-out unit,
        # an admin's take-out and an admin's add
        old_mg = cyc["min_job_grade"]
        units = db.execute("SELECT business_group, company, COUNT(*) FROM users WHERE role!='admin' AND left_at IS NULL "
                           "AND COALESCE(is_demo,0)=0 AND COALESCE(company,'')!='' GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 1").fetchone()
        outs_ = db.execute("SELECT id FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0 AND "
                           "business_group!=? AND typeof(job_grade)='integer' AND job_grade>=15 ORDER BY id LIMIT 4", (units[0],)).fetchall()
        try:
            db.execute("UPDATE cycles SET min_job_grade=15 WHERE id=?", (cyc["id"],))
            db.execute("INSERT INTO cycle_exclusions(cycle_id, business_group, company, department) VALUES (?,?,?, '')",
                       (cyc["id"], units[0], units[1]))
            db.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?, 'remove')", (cyc["id"], outs_[0][0]))
            db.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?, 'add')", (cyc["id"], outs_[1][0]))
            db.commit()
            a.g.pop("_active_cycle", None)
            a.g.pop("_cycle_exclusions", None)
            cyc2 = db.execute("SELECT * FROM cycles WHERE id=?", (cyc["id"],)).fetchone()
            want2 = {"in": 0, "out": 0, "below": 0, "unit": 0}
            for u in pop:
                taking, why = a.participation(db, u, cyc2)
                want2["below" if why == "below_min_grade" else "unit" if why == "unit_out" else "in" if taking else "out"] += 1
            pr2 = data(call(c, TOK, "participation")[1])["totals"]
            got2 = {"in": pr2["taking_part"], "out": pr2["removed_by_admin"] + pr2["not_confirmed_or_role"],
                    "below": pr2["below_min_grade"], "unit": pr2["unit_out"]}
            s.check("with a grade floor, a left-out unit, a take-out and an add made, participation still == the page's loop",
                    got2 == want2 and want2["below"] and want2["unit"] and pr2["removed_by_admin"], (got2, want2, pr2))
        finally:
            db.execute("DELETE FROM cycle_participants WHERE cycle_id=? AND subject_id IN (?,?)", (cyc["id"], outs_[0][0], outs_[1][0]))
            db.execute("DELETE FROM cycle_exclusions WHERE cycle_id=?", (cyc["id"],))
            db.execute("UPDATE cycles SET min_job_grade=? WHERE id=?", (old_mg, cyc["id"]))
            db.commit()
            a.g.pop("_active_cycle", None)
            a.g.pop("_cycle_exclusions", None)
        for part, spec in M.PARTS.items():
            res = data(call(c, TOK, "progress", {"part": part})[1])
            if spec["mod"]:
                mod = a._module_view(spec["mod"])
                _users, state, _note = a._mod_collect(db, me, mod, "", "", "")
                counts = a._mod_stage_counts(mod, state)
                mine = {x["stage"]: x["people"] for x in res["stages"]}
                s.check("progress %s == the module page's stage counts (%d people)" % (part, len(state)),
                        all(mine.get(k, 0) == counts.get(k, 0) for k in counts) and res["people"] == len(state),
                        (mine, counts))
            else:
                sql, params = a._assessor_progress_query(me, "", "all", cyc["id"])
                rows = db.execute("SELECT assigned, done FROM (%s)" % sql, params).fetchall()
                exp = {"submitted": sum(1 for r_ in rows if r_[1] >= r_[0]), "not_started": sum(1 for r_ in rows if not r_[1])}
                exp["in_progress"] = len(rows) - exp["submitted"] - exp["not_started"]
                s.check("progress f360 == the assessor page's query (%d assessors)" % len(rows),
                        (res["submitted"], res["not_started"], res["in_progress"]) == (exp["submitted"], exp["not_started"], exp["in_progress"])
                        and res["people"] == len(rows), (res["submitted"], res["not_started"], res["in_progress"], exp))
            miss = data(call(c, TOK, "whos_missing", {"part": part, "limit": 1000})[1])
            s.check("whos_missing %s: total = not started + in progress, IDs match the total up to the limit" % part,
                    miss["missing_total"] == res["not_started"] + res["in_progress"]
                    and len(miss["employee_ids"]) == min(1000, miss["missing_total"]), (miss["missing_total"], res["not_started"], res["in_progress"]))

    # -----------------------------------------------------------------------------------------------------------------
    s.section("Scope: the tools scope by the owner's admin scope (a BG admin can have no token, so the tools are called as one)")
    reset_rate()
    bg_name = BGA["admin_bg"]
    n_bg = one("SELECT COUNT(*) FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0 AND business_group=?", (bg_name,))
    n_all = one("SELECT COUNT(*) FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0")
    s.check("(the suite database has more than one group, so scope shows)", n_all > n_bg > 0, (n_all, n_bg))

    def as_bg(name, args=None):
        """The tool's own function, called as the BG admin inside a request: its data, or the ToolError's words."""
        with a.app.test_request_context("/"):
            db = a.get_db()
            me = db.execute("SELECT * FROM users WHERE id=?", (BGA["id"],)).fetchone()
            try:
                return M.TOOL_BY_NAME[name][3](db, me, M._check_args(M.TOOL_BY_NAME[name][2], args or {})), None
            except M.ToolError as e:
                return None, str(e)
    bp, _e = as_bg("participation")
    s.check("participation counts only their group", bp and bp["people"] == n_bg and {x["bg"] for x in bp["by_business_group"]} == {bg_name},
            (bp and bp["people"], n_bg, _e))
    bd, _e = as_bg("data_quality")
    s.check("data_quality counts only their group", bd and bd["people"] == n_bg, _e)
    _x, err = as_bg("participation", {"bg": "ZZ-NO-SUCH-GROUP"})
    s.check("asking for another group's name is a refusal listing only their own", err and bg_name in err and "CHIN HIN GROUP" not in err.replace(bg_name, ""), err)
    for part in ("kpi_checkin", "self_assessment", "career_plan"):
        miss, _e = as_bg("whos_missing", {"part": part, "limit": 1000})
        if miss and miss["employee_ids"]:
            bgs = {r_[0] for r_ in H.rows(a, "SELECT business_group FROM users WHERE employee_id IN (%s)"
                                          % ",".join("?" * len(miss["employee_ids"])), tuple(miss["employee_ids"]))}
            s.check("whos_missing %s lists only their group's people" % part, bgs <= {bg_name}, bgs)
    other = H.rows(a, "SELECT employee_id FROM users WHERE role!='admin' AND left_at IS NULL AND business_group!=? "
                      "AND employee_id IS NOT NULL LIMIT 1", (bg_name,))[0][0]
    _x, err = as_bg("person_status", {"employee_id": other})
    s.check("person_status for someone in another group is refused as not found", err is not None, err)
    lc, _e = as_bg("leader_coverage")
    s.check("leader_coverage lists only their group's units", lc and {x["bg"] for x in lc["bu_ceo_seats"]["units"]} <= {bg_name}, _e)
    for name in SUPER_ONLY:
        _x, err = as_bg(name)
        s.check("%s is the super admin's alone: refused to a BG admin" % name, err and "super admin" in err, err)
    _x, err = as_bg("ticket_queue")
    s.check("ticket_queue needs Ticketing (a BG admin without it is refused)", err and "Ticketing" in err, err)
    with a.app.app_context():   # the module read a tool needs follows the role too
        db = a.get_db()
        role = a.admin_role_of(db.execute("SELECT * FROM users WHERE id=?", (BGA["id"],)).fetchone(), db)
        db.execute("DELETE FROM admin_role_access WHERE role_id=? AND item='cycle.read'", (role["id"],))
        db.commit()
    _x, err = as_bg("participation")
    s.check("a role without Cycle's pages is refused participation", err and "Cycle" in err, err)
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT OR IGNORE INTO admin_role_access(role_id, item) VALUES (?, 'cycle.read')", (role["id"],))
        db.commit()
    s.check("(its Cycle read put back)", as_bg("participation")[0] is not None)

    # -----------------------------------------------------------------------------------------------------------------
    s.section("Audit: every tools/call is a row, and shows in the audit log")
    reset_rate()
    before = one("SELECT COUNT(*) FROM activity_log WHERE action='mcp_call'")
    call(c, TOK, "cycle_status")
    call(c, TOK, "progress", {"part": "f360", "unit": "x"})   # an error still leaves its row
    rpc(c, TOK, "tools/list")
    after = one("SELECT COUNT(*) FROM activity_log WHERE action='mcp_call'")
    s.check("two tool calls are two rows; tools/list and ping are none", after - before == 2, after - before)
    row = H.rows(a, "SELECT user_id, detail FROM activity_log WHERE action='mcp_call' ORDER BY id DESC LIMIT 2")
    s.check("the row is the token owner's, naming the tool and its arguments",
            all(r_["user_id"] == SU["id"] for r_ in row) and row[0]["detail"].startswith("progress {")
            and row[1]["detail"].startswith("cycle_status"), [tuple(r_) for r_ in row])
    sa = H.client_as(a, SU["id"])
    pg = sa.get("/admin/audit-log?faction=AI%2B+Connect%3A+read").get_data(as_text=True)
    s.check("the admin audit log lists it as 'AI+ Connect: read', and the Action filter offers the label",
            "AI+ Connect: read" in pg and pg.count("AI+ Connect: read") >= 3, pg.count("AI+ Connect: read"))
    srch = data(call(c, TOK, "audit_search", {"action": "mcp_call", "limit": 5})[1])
    s.check("audit_search finds them by action code, with the actor's ID and no detail",
            srch["returned"] == 5 and all(x["action"] == "mcp_call" for x in srch["rows"]) and all("detail" not in x for x in srch["rows"]))
    s.check("a token's creation is audited too", one("SELECT COUNT(*) FROM activity_log WHERE action='mcp_token_create'") >= 4)

    # -----------------------------------------------------------------------------------------------------------------
    s.section("The rate limit: 60 calls a minute per token")
    reset_rate()
    tok_rate = mk(SU["id"], "rate")
    codes = [post(c, ping, tok_rate).status_code for _ in range(M.RATE_LIMIT)]
    s.check("the first 60 calls are answered", codes == [200] * 60, sorted(set(codes)))
    r = post(c, ping, tok_rate)
    s.check("the 61st in the minute is a 429 with Retry-After", r.status_code == 429 and int(r.headers.get("Retry-After", 0)) >= 1,
            (r.status_code, r.headers.get("Retry-After")))
    s.check("another token has its own window", post(c, ping, TOK).status_code == 200)
    ok, _w = M._rate_check("window-test", now=1000.0)
    M._RATE["window-test"].extend([1000.0] * 59)
    ok61, _ = M._rate_check("window-test", now=1000.0)
    ok_later, _ = M._rate_check("window-test", now=1061.0)
    s.check("the window slides: full at 60, free again a minute later", ok and not ok61 and ok_later)
    reset_rate()

    # -----------------------------------------------------------------------------------------------------------------
    s.section("Tokens: a hash is all that is kept")
    with a.app.app_context():
        db = a.get_db()
        plain = M.mcp_token_create(db, SU["id"], "hash check", SU["id"])
        row = db.execute("SELECT * FROM mcp_tokens WHERE token_hash=?", (M.token_hash(plain),)).fetchone()
        blob = " ".join(str(v) for v in dict(row).values())
        s.check("the plaintext is nowhere in the row; the stored value is its sha256", plain.startswith("ohr_") and plain not in blob
                and row["token_hash"] == M.token_hash(plain) and len(row["token_hash"]) == 64)
        s.check("it expires in 30 days by default", abs((a._parse_when(row["expires_at"]) - a._utc_now()).days - 29) <= 1, row["expires_at"])
        s.check("two tokens are never equal", plain != M.mcp_token_create(db, SU["id"], "another", SU["id"]))
        try:
            M.mcp_token_create(db, SU["id"], "  ", SU["id"])
            s.check("a token needs a name", False)
        except ValueError:
            s.check("a token needs a name", True)
    import subprocess
    cli = os.path.join(H.REPO, "tools", "mcp_token.py")
    dbp = a.DB_PATH
    p = subprocess.run([sys.executable, cli, "--db", dbp, "list"], capture_output=True, text=True)
    s.check("tools/mcp_token.py list shows ids and names, never a hash", p.returncode == 0 and "hash check" in p.stdout
            and not re.search(r"[0-9a-f]{64}", p.stdout), p.stderr[-200:])
    p = subprocess.run([sys.executable, cli, "--db", dbp, "create", "--username", SUPER["username"], "--name", "cli"],
                       capture_output=True, text=True)
    s.check("tools/mcp_token.py create refuses an account that is not a system admin", p.returncode != 0 and "system admins only" in (p.stdout + p.stderr),
            (p.stdout + p.stderr)[-200:])
    if True:
        p = subprocess.run([sys.executable, cli, "--db", dbp, "create", "--username", SU["username"], "--name", "cli"],
                           capture_output=True, text=True)
        cli_tok = p.stdout.strip().splitlines()[-1] if p.returncode == 0 else ""
        s.check("tools/mcp_token.py create prints a working token once", cli_tok.startswith("ohr_") and post(c, ping, cli_tok).status_code == 200,
                p.stderr[-200:])
        tid = one("SELECT id FROM mcp_tokens WHERE token_hash=?", (M.token_hash(cli_tok),))
        p = subprocess.run([sys.executable, cli, "--db", dbp, "revoke", "--id", str(tid)], capture_output=True, text=True)
        s.check("...and revoke ends it", "Revoked" in p.stdout and post(c, ping, cli_tok).status_code == 401)
finally:
    os.environ.pop("ONEHR_MCP", None)
    reset_rate()

s.check("(switched off again at the end: POST /mcp is a 404)", post(c, {"jsonrpc": "2.0", "id": 1, "method": "ping"}, TOK).status_code == 404)
sys.exit(s.done())
