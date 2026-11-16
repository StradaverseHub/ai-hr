"""The OpenAI API as the AI's backup (Chris, 2026-10-21: after the load test, where Azure's 429s ended 65% of AI turns
in "Sorry, I lost the thread").

ai_draft._chat_complete_call routes every model call: Azure first; when Azure says busy (429), errors (5xx), can't be
reached or times out with time left, the SAME call goes to the OpenAI API, so the person gets their reply. What this pins,
against two local stand-in servers (no network beyond 127.0.0.1, no real key):
  * no key, no backup: one Azure request, the same error as before
  * Azure 429 / 5xx / unreachable -> the backup answers; the request shapes (Bearer + model to OpenAI, api-key to Azure,
    neither key sent to the other)
  * the rest: after a 429 (Retry-After clamped 5-60 s) or a 5xx / no connection (15 s) the next call goes straight to the
    backup, and back to Azure once it passes
  * Azure's 400 / 401 / 403 / 404 never fail over (the reasoning-effort retry still stays on Azure)
  * both failing raises Azure's error, review_agent raises as before, and Ask OneHR says "lost the thread"
  * the time budget: a failover after an Azure timeout only with 10 s left before the request's deadline, and in the
    time left; background calls have no request deadline
  * the backup refusing its key or balance switches it off for 10 minutes
  * the counts: written to ai_backend_usage only by _ai_usage_flush (never inside a request), adding to the hour's row;
    a failed write gives them back

Writes ai_backend_usage rows on the shared suite database (counts only) and puts back the activity rows it adds.
"""
import http.server
import json
import os
import socket
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The OpenAI API backup: failover, rest, budget, counts")
ai = a.ai_draft

AZ_KEY, OA_KEY = "az-test-key-0001", "sk-test-backup-0002"
TURN = {"say": "%s answered", "quick_replies": [], "action": None}


class Stub:
    """A stand-in chat-completions server. mode: ok | 429 | 500 | 503 | 400 | 401 | 403 | 404 | quota | hang |
    effort400 (refuses reasoning_effort 'none' with a 400 naming it)."""

    def __init__(self, name):
        self.name, self.mode, self.reqs, self.headers429 = name, "ok", [], {}
        self.hang_s = 2.5
        stub = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a_):
                pass

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode() or "{}")
                stub.reqs.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()},
                                  "body": body})
                mode = stub.mode
                if mode == "hang":
                    time.sleep(stub.hang_s)
                    mode = "ok"
                if mode == "effort400" and body.get("reasoning_effort") == "none":
                    return self._send(400, {"error": {"message": "Unsupported value: 'reasoning_effort' 'none'"}})
                if mode in ("ok", "effort400"):
                    say = dict(TURN, say=TURN["say"] % stub.name)
                    return self._send(200, {"choices": [{"message": {"content": json.dumps(say)},
                                                         "finish_reason": "stop"}],
                                            "usage": {"prompt_tokens": 100, "completion_tokens": 20,
                                                      "prompt_tokens_details": {"cached_tokens": 40}}})
                if mode == "quota":
                    return self._send(429, {"error": {"code": "insufficient_quota", "message": "quota"}})
                code = int(mode)
                return self._send(code, {"error": {"message": "stub %s" % code}},
                                  stub.headers429 if code == 429 else {})

            def _send(self, code, obj, extra=None):
                raw = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                for k, v in (extra or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                try:
                    self.wfile.write(raw)
                except OSError:
                    pass

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.srv.daemon_threads = True
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def hits(self):
        return len(self.reqs)


def closed_port():
    sk = socket.socket()
    sk.bind(("127.0.0.1", 0))
    p = sk.getsockname()[1]
    sk.close()
    return p


AZ, OA = Stub("azure"), Stub("openai")
NOW = [1000.0]
_orig = {"cfg": ai._cfg, "clock": ai._clock, "bc": ai._backend_call, "ra": ai.review_agent,
         "rcli": ai.review_cli_enabled, "env": {k: os.environ.get(k) for k in
                                                ("OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_BACKUP_MODEL",
                                                 "OPENAI_ORG_ID", "ONEHR_AI_DEADLINE_S", "REVIEW_AGENT_CLI")}}
ai._clock = lambda: NOW[0]
az_port = [AZ.port]
ai._cfg = lambda: ("http://127.0.0.1:%d" % az_port[0], AZ_KEY, "gpt-6-luna", "2024-10-21")
ai.review_cli_enabled = lambda: False


def backup_on(on=True):
    # the base URL always points at the stand-in, so even a broken "no key" check can never reach the real API
    os.environ["OPENAI_BASE_URL"] = "http://127.0.0.1:%d/v1" % OA.port
    if on:
        os.environ["OPENAI_API_KEY"] = OA_KEY
    else:
        os.environ.pop("OPENAI_API_KEY", None)


def fresh(az="ok", oa="ok"):
    """Every backend awake, the stubs' logs and modes reset, the counts emptied, no request clock."""
    ai._COOL.update(azure=0.0, openai=0.0, openai_off=0.0)
    AZ.mode, OA.mode, AZ.reqs[:], OA.reqs[:] = az, oa, [], []
    AZ.headers429, OA.headers429 = {}, {}
    az_port[0] = AZ.port
    ai.background_calls(False)
    ai.request_clock(False)
    ai.usage_take()


def call(timeout=5):
    try:
        return ("ok", ai._chat_complete("system", "user", 50, timeout))
    except ai.AIDraftError as e:
        return ("err", str(e))


def rest_left(backend):
    return round(ai._COOL[backend] - NOW[0], 2)


try:
    # -----------------------------------------------------------------------------------------------------------------
    s.section("no key, no backup: exactly today's one Azure call")
    backup_on(False)
    fresh()
    out = call()
    s.check("served by Azure, one request, nothing to OpenAI",
            out[0] == "ok" and "azure answered" in out[1] and AZ.hits() == 1 and OA.hits() == 0, (out, AZ.hits(), OA.hits()))
    s.check("the route is Azure only", ai._route() == ["azure"], ai._route())
    fresh(az="429")
    out = call()
    s.check("Azure 429 with no key -> the same error as before, no failover",
            out[0] == "err" and out[1].startswith("Azure OpenAI HTTP 429") and OA.hits() == 0, out)
    s.check("config_status says no backup", ai.config_status().get("backup") is False)

    # -----------------------------------------------------------------------------------------------------------------
    s.section("Azure busy (429) -> the backup answers the same call")
    backup_on(True)
    fresh(az="429")
    AZ.headers429 = {"Retry-After": "7"}
    out = call()
    s.check("the backup's reply comes back", out == ("ok", json.dumps(dict(TURN, say="openai answered"))), out)
    s.check("one call each: Azure refused, OpenAI served", AZ.hits() == 1 and OA.hits() == 1, (AZ.hits(), OA.hits()))
    oreq, areq = OA.reqs[0], AZ.reqs[0]
    s.check("OpenAI: /v1/chat/completions with the Bearer key and the model in the body",
            oreq["path"] == "/v1/chat/completions" and oreq["headers"].get("authorization") == "Bearer " + OA_KEY
            and oreq["body"].get("model") == "gpt-6-luna", (oreq["path"], oreq["body"].get("model")))
    s.check("OpenAI: max_completion_tokens and reasoning_effort 'none' (the same shape as Azure's gpt-6-luna)",
            oreq["body"].get("max_completion_tokens") == 50 and oreq["body"].get("reasoning_effort") == "none"
            and "max_tokens" not in oreq["body"], oreq["body"])
    s.check("neither key goes to the other: no api-key to OpenAI, no Bearer to Azure",
            "api-key" not in oreq["headers"] and AZ_KEY not in json.dumps(oreq)
            and "authorization" not in areq["headers"] and OA_KEY not in json.dumps(areq), (oreq["headers"], areq["headers"]))
    s.check("Azure keeps its own shape: deployment in the URL, api-key header, no model in the body",
            "/openai/deployments/gpt-6-luna/chat/completions?api-version=" in areq["path"]
            and areq["headers"].get("api-key") == AZ_KEY and "model" not in areq["body"], areq["path"])
    s.check("Azure rests for its Retry-After (7 s)", rest_left("azure") == 7.0, rest_left("azure"))
    rows = ai.usage_take()
    by = {b: r for (h, b), r in rows.items()}
    s.check("counted: OpenAI 1 reply, a failover, its tokens; Azure one 429",
            by.get("openai", {}).get("calls") == 1 and by["openai"]["failovers"] == 1 and by["openai"]["routed"] == 0
            and by["openai"]["prompt_tokens"] == 100 and by["openai"]["completion_tokens"] == 20
            and by["openai"]["cached_tokens"] == 40 and by.get("azure", {}).get("err_429") == 1
            and by["azure"]["calls"] == 0 and "none" not in by, rows)
    for code in ("500", "503"):
        fresh(az=code)
        out = call()
        s.check("Azure %s -> the backup answers, and Azure rests 15 s" % code,
                out[0] == "ok" and "openai answered" in out[1] and rest_left("azure") == 15.0, (out, rest_left("azure")))
    fresh()
    az_port[0] = closed_port()
    out = call()
    s.check("Azure unreachable -> the backup answers, Azure rests 15 s",
            out[0] == "ok" and "openai answered" in out[1] and rest_left("azure") == 15.0, (out, rest_left("azure")))
    s.check("...and the attempt counts as a network error",
            any(b == "azure" and r["err_net"] == 1 for (h, b), r in ai.usage_take().items()))

    # -----------------------------------------------------------------------------------------------------------------
    s.section("the rest: straight to the backup, then back to Azure")
    fresh(az="429")
    AZ.headers429 = {"Retry-After": "7"}
    call()
    AZ.mode = "ok"
    a0, o0 = AZ.hits(), OA.hits()
    out = call()
    s.check("while Azure rests, the next call goes straight to OpenAI (Azure not asked)",
            out[0] == "ok" and "openai answered" in out[1] and AZ.hits() == a0 and OA.hits() == o0 + 1,
            (out, AZ.hits() - a0, OA.hits() - o0))
    s.check("the route while Azure rests: the backup first, Azure as the last resort", ai._route() == ["openai", "azure"])
    s.check("counted as routed (not a failover)", any(b == "openai" and r["routed"] == 1 and r["failovers"] == 1
                                                      for (h, b), r in ai.usage_take().items()))
    NOW[0] += 7.5
    a0, o0 = AZ.hits(), OA.hits()
    out = call()
    s.check("once the rest has passed, Azure serves again", out[0] == "ok" and "azure answered" in out[1]
            and AZ.hits() == a0 + 1 and OA.hits() == o0, out)
    fresh(az="429", oa="503")
    call()
    a0 = AZ.hits()
    AZ.mode = "ok"
    out = call()
    s.check("while both rest, Azure (the primary) goes first", ai._route()[0] == "azure" and out[0] == "ok"
            and "azure answered" in out[1] and AZ.hits() == a0 + 1, (ai._route(), out))
    fresh(az="ok", oa="ok")
    ai._COOL["azure"] = NOW[0] + 30
    OA.mode = "503"
    out = call()
    s.check("while Azure rests and the backup fails, Azure is still asked as the last resort",
            out[0] == "ok" and "azure answered" in out[1] and AZ.hits() == 1 and OA.hits() == 1, out)
    for hdrs, want in (({"Retry-After": "300"}, 60.0), ({"Retry-After": "1"}, 5.0), ({}, 10.0),
                       ({"retry-after-ms": "20000"}, 20.0), ({"retry-after-ms": "2500", "Retry-After": "40"}, 5.0)):
        fresh(az="429")
        AZ.headers429 = hdrs
        call()
        s.check("Azure 429 %s -> rests %.0f s (clamped 5-60, 10 when unnamed)" % (hdrs or "with no Retry-After", want),
                rest_left("azure") == want, rest_left("azure"))

    # -----------------------------------------------------------------------------------------------------------------
    s.section("a request problem never fails over")
    for code in ("400", "401", "403", "404"):
        fresh(az=code)
        out = call()
        s.check("Azure %s -> its own error, the backup never asked, Azure not rested" % code,
                out[0] == "err" and out[1].startswith("Azure OpenAI HTTP %s" % code) and OA.hits() == 0
                and rest_left("azure") <= 0, (out, OA.hits()))
    fresh(az="effort400")
    out = call()
    s.check("a 400 naming reasoning_effort still retries on Azure with the next effort (no failover)",
            out[0] == "ok" and "azure answered" in out[1] and AZ.hits() == 2 and OA.hits() == 0
            and [r["body"].get("reasoning_effort") for r in AZ.reqs] == ["none", "minimal"],
            (out, [r["body"].get("reasoning_effort") for r in AZ.reqs]))

    # -----------------------------------------------------------------------------------------------------------------
    s.section("both fail: exactly today's behaviour")
    fresh(az="503", oa="429")
    out = call()
    s.check("Azure's error is raised (as today), after both were asked",
            out[0] == "err" and out[1].startswith("Azure OpenAI HTTP 503") and AZ.hits() == 1 and OA.hits() == 1, out)
    s.check("...and counted as a call nobody answered",
            any(b == "none" and r["calls"] == 1 for (h, b), r in ai.usage_take().items()))
    fresh(az="503", oa="503")
    try:
        ai.review_agent("sys", [{"role": "user", "content": "How do I start my check-in?"}])
        raised = False
    except ai.AIDraftError as e:
        raised = str(e).startswith("Azure OpenAI HTTP 503")
    s.check("review_agent raises as before when both fail (the caller says 'lost the thread')", raised)
    fresh(az="429")
    turn = ai.review_agent("sys", [{"role": "user", "content": "How do I start my check-in?"}])
    s.check("review_agent: Azure 429 -> the backup's turn, parsed (no 'lost the thread')",
            turn.get("say") == "openai answered" and turn.get("action") is None, turn)

    # through a real route: Ask OneHR, asked something only the model answers
    with a.app.app_context():
        db = a.get_db()
        EMP = db.execute("SELECT u.id FROM users u WHERE u.role!='admin' AND u.left_at IS NULL AND u.is_demo=0 "
                         "AND NOT EXISTS (SELECT 1 FROM users r WHERE r.manager_id=u.id) LIMIT 1").fetchone()[0]
        LOG0 = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
        USE0 = db.execute("SELECT COALESCE(SUM(calls),0) FROM ai_backend_usage").fetchone()[0]
    emp = H.client_as(a, EMP)
    q = "What happens after I submit?"
    fresh(az="429")
    j = emp.post("/ask", data={"csrf_token": "tok", "message": q}).get_json() or {}
    s.check("Ask OneHR with Azure busy: the backup's answer, not 'lost the thread'",
            j.get("say") == "openai answered" and "lost the thread" not in json.dumps(j) and OA.hits() >= 1,
            (j.get("say"), AZ.hits(), OA.hits()))
    with a.app.app_context():
        s.check("nothing was written to ai_backend_usage inside that request",
                a.get_db().execute("SELECT COALESCE(SUM(calls),0) FROM ai_backend_usage").fetchone()[0] == USE0)
    fresh(az="503", oa="503")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE activity_log SET created_at=datetime('now','-2 minutes') WHERE user_id=? AND id>?",
                   (EMP, LOG0))
        d_.commit()
    j = emp.post("/ask", data={"csrf_token": "tok", "message": q}).get_json() or {}
    s.check("Ask OneHR with both down: today's 'lost the thread' fallback", "lost the thread" in (j.get("say") or ""),
            j.get("say"))

    # -----------------------------------------------------------------------------------------------------------------
    s.section("the time budget (nginx gives up at 60 s)")
    fresh(az="hang")
    AZ.hang_s = 2.5
    t = time.time()
    out = call(timeout=1)
    s.check("Azure times out with time left -> the backup answers",
            out[0] == "ok" and "openai answered" in out[1] and OA.hits() == 1 and time.time() - t < 2.4, out)
    s.check("a timeout rests nothing, and counts as a timeout", rest_left("azure") <= 0
            and any(b == "azure" and r["err_timeout"] == 1 for (h, b), r in ai.usage_take().items()))
    fresh(az="hang")
    ai._TL.t0 = NOW[0] - 45      # this request started 45 s ago: 5 s left before the 50 s deadline
    out = call(timeout=1)
    s.check("with under 10 s left, no failover: Azure's timeout as today", out[0] == "err"
            and "timed out" in out[1].lower() and OA.hits() == 0, out)
    # the backup's timeout is the time left (a recorder in place of the HTTP call; the clock is the test's own)
    seen = []

    def _rec(backend, system, user, max_tokens, timeout, effort=None):
        seen.append((backend, round(timeout, 1)))
        if backend == "azure":
            raise ai.AIBackendError("Azure OpenAI call failed: TimeoutError: timed out", kind="timeout")
        return "fine", {}
    ai._backend_call = _rec
    try:
        fresh()
        ai._TL.t0 = NOW[0] - 30   # 20 s left
        out = call(timeout=25)
        s.check("the backup gets the time left (20 s), not its full 25 s", seen == [("azure", 25), ("openai", 20.0)],
                seen)
        seen[:] = []
        fresh()
        ai._TL.t0 = NOW[0] - 30
        ai.background_calls(True)   # a pre-run job: no request behind it, so no deadline
        s.check("background_calls clears this thread's request clock", ai._TL.t0 is None)
        ai._TL.t0 = NOW[0] - 30     # ...and even a stale one left on the thread doesn't bound it
        out = call(timeout=25)
        ai.background_calls(False)
        s.check("a background call has no request deadline: the backup gets its full timeout",
                seen == [("azure", 25), ("openai", 25)], seen)
        seen[:] = []
        fresh()
        out = call(timeout=25)
        s.check("a call outside any request counts its budget from itself (the backup gets 25 s)",
                seen == [("azure", 25), ("openai", 25)], seen)
    finally:
        ai._backend_call = _orig["bc"]
    clk = []
    _rc = ai.request_clock
    ai.request_clock = lambda on=True: (clk.append(on), _rc(on))
    try:
        a.app.test_client().get("/login")
    finally:
        ai.request_clock = _rc
    s.check("a request starts the clock and its end clears it", clk[:1] == [True] and clk[-1:] == [False], clk)

    # -----------------------------------------------------------------------------------------------------------------
    s.section("the backup refusing its key, model or balance switches it off for 10 minutes")
    for mode in ("401", "quota"):
        fresh(az="429", oa=mode)
        out = call()
        s.check("Azure 429 + backup %s -> Azure's error, and the backup off for 600 s" % mode,
                out[0] == "err" and out[1].startswith("Azure OpenAI HTTP 429") and rest_left("openai_off") == 600.0,
                (out, rest_left("openai_off")))
        o0 = OA.hits()
        s.check("...the next call doesn't ask it (route Azure only)", ai._route() == ["azure"])
        call()
        s.check("...and it isn't asked", OA.hits() == o0)
        NOW[0] += 601
        s.check("...back on after 10 minutes", "openai" in ai._route(), ai._route())
    fresh(az="429", oa="429")
    call()
    s.check("a rate-limited backup (429, not quota) rests, it is not switched off",
            rest_left("openai") == 10.0 and rest_left("openai_off") <= 0, (rest_left("openai"), rest_left("openai_off")))

    # -----------------------------------------------------------------------------------------------------------------
    s.section("the counts: ai_backend_usage, batched, adding to the hour")
    with a.app.app_context():
        cols = {r[1] for r in a.get_db().execute("PRAGMA table_info(ai_backend_usage)")}
    s.check("the table has every counted column (the runtime schema made it)",
            set(ai.USAGE_FIELDS) | {"hour", "backend"} <= cols, cols)
    s.check("SCHEMA describes it too", "CREATE TABLE IF NOT EXISTS ai_backend_usage (" in a.SCHEMA)

    def sums():
        with a.app.app_context():
            return {r[0]: (r[1], r[2], r[3]) for r in a.get_db().execute(
                "SELECT backend, SUM(calls), SUM(failovers), SUM(err_429) FROM ai_backend_usage GROUP BY backend")}
    fresh(az="429")
    call()
    call()                      # routed
    AZ.mode, OA.mode = "503", "503"
    ai._COOL.update(azure=0.0, openai=0.0)
    call()                      # nobody
    base = sums()
    pending = {b: dict(r) for (h, b), r in ai._USAGE["rows"].items()}
    wrote = a._ai_usage_flush(a.app)
    after = sums()

    def delta(b, i):
        return after.get(b, (0, 0, 0))[i] - base.get(b, (0, 0, 0))[i]
    s.check("one flush writes them: OpenAI +2 replies (one a failover, one routed), nobody +1, Azure +1 429",
            wrote >= 3 and delta("openai", 0) == 2 and delta("openai", 1) == 1 and delta("none", 0) == 1
            and delta("azure", 2) == 1, (wrote, base, after, pending))
    s.check("...and the counts start again", not ai.usage_pending())
    fresh(az="429")
    call()
    base = sums()
    a._ai_usage_flush(a.app)
    s.check("a second flush ADDS to the hour's row (UPSERT), it doesn't replace it", sums()["openai"][0] == base["openai"][0] + 1)
    fresh(az="429")
    call()
    held = {k: dict(v) for k, v in ai._USAGE["rows"].items()}
    _gdb = a.get_db

    def _broken():
        raise RuntimeError("disk on fire")
    a.get_db = _broken
    try:
        wrote = a._ai_usage_flush(a.app)
    finally:
        a.get_db = _gdb
    s.check("a failed write gives the counts back for the next one", wrote == 0 and ai._USAGE["rows"] == held,
            (wrote, ai._USAGE["rows"]))
    ai.usage_take()
    # the after-response write: its own thread, at most once a minute per process, only with counts waiting
    started = []

    class _T:
        def __init__(self, target=None, args=(), name=None, daemon=None):
            self.target, self.name = target, name

        def start(self):
            started.append((self.target, self.name))
    _thr, _watch = a.threading.Thread, a.AI_USAGE_WATCH

    def kick():
        # threading.Thread is swapped only around the kick: the stand-in servers start a thread per request
        a.threading.Thread = _T
        try:
            return a._ai_usage_kick(a.app)
        finally:
            a.threading.Thread = _thr
    a.AI_USAGE_WATCH = True
    a._AI_USAGE["at"], a._AI_USAGE["pid"] = float("-inf"), None
    try:
        ai.usage_take()
        none_kick = kick()
        fresh(az="429")
        call()
        first = kick()
        second = kick()
        a.AI_USAGE_WATCH = False
        a._AI_USAGE["at"] = float("-inf")
        off_kick = kick()
    finally:
        a.threading.Thread, a.AI_USAGE_WATCH = _thr, _watch
        a._AI_USAGE["at"], a._AI_USAGE["pid"] = float("-inf"), None
    s.check("nothing waiting -> no write started", none_kick is False)
    s.check("counts waiting -> the write starts on a thread of its own (onehr-ai-usage), once a minute at most",
            first is True and second is False and started == [(a._ai_usage_flush, "onehr-ai-usage")], started)
    s.check("with the after-response write switched off (the suites), none starts", off_kick is False)
    ai.usage_take()
finally:
    ai._cfg, ai._clock, ai._backend_call = _orig["cfg"], _orig["clock"], _orig["bc"]
    ai.review_agent, ai.review_cli_enabled = _orig["ra"], _orig["rcli"]
    for k, v in _orig["env"].items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    ai._COOL.update(azure=0.0, openai=0.0, openai_off=0.0)
    ai.request_clock(False)
    ai.usage_take()
    try:
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("DELETE FROM activity_log WHERE id>? AND user_id=?", (LOG0, EMP))
            d_.commit()
    except NameError:
        pass
    AZ.srv.shutdown()
    OA.srv.shutdown()

sys.exit(s.done())
