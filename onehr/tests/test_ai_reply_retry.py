"""A reasoning model that uses its whole token budget before it writes (Azure, HTTP 200, finish_reason=length) is tried ONCE
more on Azure with a bigger budget (5 Nov 2026: 43 such calls ended as "lost the thread" in a day, and nothing logged them).

ai_draft._chat_complete_call routes every model call. What this pins, against two local stand-in servers (no network beyond
127.0.0.1, no real key, no real model):
  * cut off once, then a good reply -> the text; two Azure requests; the second asks for min(2x, +4000) tokens; the backup
    never asked; ONE log line, retry=ok
  * cut off twice -> AIDraftError; two Azure requests, the backup never asked (the prompt stays off OpenAI's US servers);
    one log line, retry=failed
  * an empty reply that ended on its own ("stop"), a refusal / content filter, a body of the wrong shape -> no retry
  * the request's time: with under FAILOVER_MIN_S left, no retry; the retry's timeout is the time left
  * the log line carries counts and names only: never the prompt, the reply or a name
  * the usage counts stay per attempt (a failed attempt = err_other; a good retry = a normal Azure call)
  * a 429 / 5xx still fails over to the backup exactly as before; a cut-off reply from the backup itself is not retried
  * Azure only (the Chairman's chat) retries too and still never reaches the backup
  * review_agent and lms_coach_turn (which retry the whole call once themselves) do NOT re-run a cut-off turn: two Azure
    requests in all, not three or four -- a third would not fit behind nginx's 60 s; a bad-JSON reply is still retried
"""
import http.server
import json
import logging
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Azure reply cut off: one bigger-budget retry, one log line")
ai = a.ai_draft

AZ_KEY, OA_KEY = "az-test-key-0001", "sk-test-backup-0002"
SECRET_PROMPT, SECRET_REPLY = "SECRETPROMPTWORDS-Aisha-binti-Rahman", "SECRETPARTIALREPLY-Tan-Wei-Ming"


class Stub:
    """A stand-in chat-completions server. seq: modes used one per request (then `mode`). Modes: ok | cut | cut_text |
    empty_stop | refusal | filter | shape | 429 | 503."""

    def __init__(self, name):
        self.name, self.mode, self.seq, self.reqs = name, "ok", [], []
        stub = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a_):
                pass

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode() or "{}")
                stub.reqs.append({"headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
                mode = stub.seq.pop(0) if stub.seq else stub.mode
                cut_usage = {"prompt_tokens": 100, "completion_tokens": body.get("max_completion_tokens") or 0,
                             "completion_tokens_details": {"reasoning_tokens": body.get("max_completion_tokens") or 0}}
                if mode == "ok":
                    return self._send(200, {"choices": [{"message": {"content": "%s answered" % stub.name},
                                                         "finish_reason": "stop"}],
                                            "usage": {"prompt_tokens": 100, "completion_tokens": 20}})
                if mode == "turn":
                    return self._send(200, {"choices": [{"message": {"content": json.dumps(
                        {"say": "%s turn" % stub.name, "quick_replies": [], "action": None})},
                        "finish_reason": "stop"}], "usage": {"prompt_tokens": 100, "completion_tokens": 20}})
                if mode == "prose":
                    return self._send(200, {"choices": [{"message": {"content": "not json at all"},
                                                         "finish_reason": "stop"}]})
                if mode == "cut":
                    return self._send(200, {"choices": [{"message": {"content": None}, "finish_reason": "length"}],
                                            "usage": cut_usage})
                if mode == "cut_text":
                    return self._send(200, {"choices": [{"message": {"content": SECRET_REPLY},
                                                         "finish_reason": "length"}], "usage": cut_usage})
                if mode == "empty_stop":
                    return self._send(200, {"choices": [{"message": {"content": ""}, "finish_reason": "stop"}],
                                            "usage": {"prompt_tokens": 100, "completion_tokens": 3,
                                                      "completion_tokens_details": {"reasoning_tokens": 3}}})
                if mode == "refusal":
                    return self._send(200, {"choices": [{"message": {"content": None, "refusal": "no"},
                                                         "finish_reason": "stop"}]})
                if mode == "filter":
                    return self._send(200, {"choices": [{"message": {"content": None},
                                                         "finish_reason": "content_filter"}]})
                if mode == "shape":
                    return self._send(200, {"unexpected": SECRET_REPLY})
                if mode.startswith("http:"):   # http:<status>:<error.code>:<innererror.code> ("-" leaves one out, "int" an integer code)
                    _, st_, c_, i_ = mode.split(":")
                    err = {"message": SECRET_PROMPT + " " + SECRET_REPLY}
                    if c_ != "-":
                        err["code"] = 429 if c_ == "int" else c_
                    if i_ != "-":
                        err["innererror"] = {"code": i_, "content_filter_result": SECRET_REPLY}
                    return self._send(int(st_), {"error": err})
                if mode.startswith("nonjson:"):
                    raw = ("<html>%s</html>" % SECRET_REPLY).encode()
                    self.send_response(int(mode.split(":")[1]))
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                    return
                code = int(mode)
                return self._send(code, {"error": {"message": "stub %s" % code}})

            def _send(self, code, obj):
                raw = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
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

    def asked(self):
        return [r["body"].get("max_completion_tokens") for r in self.reqs]


class Lines(logging.Handler):
    def __init__(self):
        super().__init__(logging.WARNING)
        self.rec = []

    def emit(self, record):
        self.rec.append(record.getMessage())


AZ, OA = Stub("azure"), Stub("openai")
NOW = [1000.0]
LOG = Lines()
_lg = logging.getLogger("onehr.ai")
_lg.addHandler(LOG)
_orig = {"cfg": ai._cfg, "clock": ai._clock, "bc": ai._backend_call,
         "rcli": ai.review_cli_enabled, "env": {k: os.environ.get(k) for k in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_BACKUP_MODEL",
                                                "OPENAI_ORG_ID", "ONEHR_AI_DEADLINE_S")}, "level": _lg.level}
_lg.setLevel(logging.WARNING)
ai._clock = lambda: NOW[0]
ai.review_cli_enabled = lambda: False
ai._cfg = lambda: ("http://127.0.0.1:%d" % AZ.port, AZ_KEY, "gpt-6-luna", "2024-10-21")
os.environ["OPENAI_BASE_URL"] = "http://127.0.0.1:%d/v1" % OA.port   # always the stand-in, never the real API
os.environ["OPENAI_API_KEY"] = OA_KEY


def fresh(seq=(), az="ok", oa="ok"):
    ai._COOL.update(azure=0.0, openai=0.0, openai_off=0.0)
    AZ.mode, OA.mode, AZ.seq, OA.seq, AZ.reqs[:], OA.reqs[:] = az, oa, list(seq), [], [], []
    LOG.rec[:] = []
    ai.background_calls(False)
    ai.request_clock(False)
    ai.usage_take()


def call(max_tokens=1500, timeout=5, **kw):
    try:
        return ("ok", ai._chat_complete(SECRET_PROMPT, SECRET_PROMPT, max_tokens, timeout, **kw))
    except ai.AIDraftError as e:
        return ("err", str(e))


def reply_lines():
    return [m for m in LOG.rec if m.startswith("OneHR AI reply")]


def failed_lines():
    return [m for m in LOG.rec if m.startswith("OneHR AI call failed")]


def usage():
    return {b: r for (h, b), r in ai.usage_take().items()}


try:
    # -----------------------------------------------------------------------------------------------------------------
    s.section("cut off once, then a good reply: one bigger-budget retry on Azure")
    fresh(["cut"])
    out = call(1500)
    s.check("the second reply comes back", out == ("ok", "azure answered"), out)
    s.check("two Azure requests, the backup never asked", AZ.hits() == 2 and OA.hits() == 0, (AZ.hits(), OA.hits()))
    s.check("the first asks for the budget, the retry for min(2x, +4000) = 3000", AZ.asked() == [1500, 3000], AZ.asked())
    ln = reply_lines()
    s.check("ONE log line, a cut-off reply, retry=ok, the new budget", len(ln) == 1 and "reply cut" in ln[0]
            and "retry=ok" in ln[0] and "new_max=3000" in ln[0] and "max_tokens=1500" in ln[0], ln)
    s.check("...with the finish reason and the token counts the reply reported",
            "finish=length" in ln[0] and "completion=1500" in ln[0] and "reasoning=1500" in ln[0], ln)
    s.check("...and the calling function's name (this test's call())", "feature=call " in ln[0], ln)
    s.check("...and no prompt text or reply text anywhere in the log",
            not any(w in m for m in LOG.rec for w in (SECRET_PROMPT, "Aisha", "answered", AZ_KEY, OA_KEY)), LOG.rec)
    u = usage()
    s.check("counted per attempt: Azure one failed attempt (err_other) and one reply; nothing unanswered, no failover",
            u.get("azure", {}).get("err_other") == 1 and u["azure"]["calls"] == 1 and u["azure"]["failovers"] == 0
            and "none" not in u and "openai" not in u, u)
    for mx, want in ((1500, 3000), (4000, 8000), (6000, 10000), (300, 600)):
        fresh(["cut"])
        call(mx)
        s.check("budget %d -> retry with %d (min of twice, +4000)" % (mx, want), AZ.asked() == [mx, want], AZ.asked())
    fresh(["cut_text"])
    out = call(1500)
    s.check("cut off WITH partial text is retried too, and the partial text is not logged",
            out == ("ok", "azure answered") and AZ.hits() == 2 and not any(SECRET_REPLY in m for m in LOG.rec), (out, LOG.rec))

    # -----------------------------------------------------------------------------------------------------------------
    s.section("cut off twice: Azure's error, the backup never asked")
    fresh(az="cut")
    out = call(1500)
    s.check("an AIDraftError that says it was cut off", out[0] == "err" and "cut off" in out[1], out)
    s.check("exactly two Azure requests and none to OpenAI", AZ.hits() == 2 and OA.hits() == 0, (AZ.hits(), OA.hits()))
    ln = reply_lines()
    s.check("ONE log line, retry=failed", len(ln) == 1 and "reply cut" in ln[0] and "retry=failed" in ln[0]
            and "new_max=3000" in ln[0], ln)
    u = usage()
    s.check("counted: two failed Azure attempts, and the call nobody answered",
            u.get("azure", {}).get("err_other") == 2 and u.get("none", {}).get("calls") == 1 and "openai" not in u, u)

    # -----------------------------------------------------------------------------------------------------------------
    s.section("no retry for a reply that did not run out of budget")
    for mode, kind, fin in (("empty_stop", "empty", "stop"), ("refusal", "empty", "stop"),
                            ("filter", "empty", "content_filter"), ("shape", "shape", None)):
        fresh(az=mode)
        out = call(1500)
        ln = reply_lines()
        s.check("%s: one Azure request, the error as before, no backup" % mode,
                out[0] == "err" and AZ.hits() == 1 and OA.hits() == 0, (out, AZ.hits(), OA.hits()))
        s.check("%s: ONE log line, reply %s, retry=none%s" % (mode, kind, ", finish=" + fin if fin else ""),
                len(ln) == 1 and ("reply %s:" % kind) in ln[0] and "retry=none" in ln[0] and "new_max=-" in ln[0]
                and (("finish=%s" % fin) in ln[0] if fin else True), ln)
        s.check("%s: no reply text in the log" % mode, not any(SECRET_REPLY in m for m in LOG.rec), LOG.rec)
    fresh(az="empty_stop")
    call(1500)
    s.check("an empty reply that stopped on its own reports its tokens", "completion=3 reasoning=3" in reply_lines()[0],
            reply_lines())

    # -----------------------------------------------------------------------------------------------------------------
    s.section("the request's time")
    fresh(["cut"])
    ai._TL.t0 = NOW[0] - 45      # 5 s left before the 50 s deadline
    out = call(1500)
    s.check("under 10 s left: no retry, one request, the cut-off error as before",
            out[0] == "err" and "cut off" in out[1] and AZ.hits() == 1 and OA.hits() == 0, (out, AZ.hits()))
    s.check("...and the log says retry=none", len(reply_lines()) == 1 and "retry=none" in reply_lines()[0], reply_lines())
    fresh(["cut"])
    ai._TL.t0 = NOW[0] - 39.9    # 10.1 s left: just enough
    out = call(1500)
    s.check("10.1 s left: the retry runs", out == ("ok", "azure answered") and AZ.hits() == 2, (out, AZ.hits()))
    seen = []

    def _rec(backend, system, user, max_tokens, timeout, effort=None):
        seen.append((backend, max_tokens, round(timeout, 1)))
        if len(seen) == 1:
            raise ai.AIBackendError("Azure OpenAI reply was cut off at the token limit (finish_reason=length).",
                                    kind="reply", sub="cut", finish_reason="length")
        return "fine", {}
    ai._backend_call = _rec
    try:
        fresh()
        ai._TL.t0 = NOW[0] - 30   # 20 s left
        out = call(1500, timeout=25)
        s.check("the retry's timeout is the time left (20 s), not its full 25 s", seen == [("azure", 1500, 25), ("azure", 3000, 20.0)], seen)
        seen[:] = []
        fresh()
        out = call(1500, timeout=25)
        s.check("outside any request the retry gets the full timeout", seen == [("azure", 1500, 25), ("azure", 3000, 25)], seen)
        seen[:] = []
        fresh()
        ai.background_calls(True)
        ai._TL.t0 = NOW[0] - 49   # a stale clock on a background thread bounds nothing
        out = call(1500, timeout=25)
        ai.background_calls(False)
        s.check("a background call has no request deadline: the retry runs with the full timeout",
                seen == [("azure", 1500, 25), ("azure", 3000, 25)], seen)
    finally:
        ai._backend_call = _orig["bc"]

    # -----------------------------------------------------------------------------------------------------------------
    s.section("failover is untouched")
    fresh(["429"])
    out = call(1500)
    s.check("Azure 429 -> the backup answers the same call, no bigger-budget retry",
            out == ("ok", "openai answered") and AZ.hits() == 1 and OA.hits() == 1 and AZ.asked() == [1500]
            and OA.asked() == [1500], (out, AZ.hits(), OA.hits()))
    s.check("...no reply line (the call was answered)", not reply_lines(), LOG.rec)
    fresh(az="503")
    out = call(1500)
    s.check("Azure 503 -> the backup answers", out == ("ok", "openai answered") and AZ.hits() == 1 and OA.hits() == 1, out)
    fresh(["cut", "429"])
    out = call(1500)
    s.check("a 429 on the RETRY fails over to the backup, as any 429 does",
            out == ("ok", "openai answered") and AZ.hits() == 2 and OA.hits() == 1, (out, AZ.hits(), OA.hits()))
    ln = reply_lines()
    s.check("...one log line, retry=failed", len(ln) == 1 and "retry=failed" in ln[0], ln)
    u = usage()
    s.check("...counted: Azure err_other + err_429, the backup one failover reply",
            u["azure"]["err_other"] == 1 and u["azure"]["err_429"] == 1 and u["openai"]["calls"] == 1
            and u["openai"]["failovers"] == 1 and "none" not in u, u)
    fresh(oa="cut")
    ai._COOL["azure"] = NOW[0] + 30     # Azure resting: the backup goes first
    out = call(1500)
    s.check("the backup's own cut-off reply is not retried (Azure is asked as the last resort)",
            out == ("ok", "azure answered") and OA.hits() == 1 and AZ.hits() == 1 and OA.asked() == [1500], (out, OA.hits(), AZ.hits()))
    ln = reply_lines()
    s.check("...logged once, from the backup, retry=none", len(ln) == 1 and "backend=openai" in ln[0] and "retry=none" in ln[0], ln)

    # -----------------------------------------------------------------------------------------------------------------
    s.section("Azure only (the Executive Chairman's chat)")
    fresh(["cut"])
    out = call(1500, deployment="chair-dep", azure_only=True)
    s.check("a cut-off reply is retried on his own deployment, never the backup",
            out == ("ok", "azure answered") and AZ.hits() == 2 and OA.hits() == 0, (out, AZ.hits(), OA.hits()))
    fresh(az="cut")
    out = call(1500, deployment="chair-dep", azure_only=True)
    s.check("cut twice -> his error, the backup never asked", out[0] == "err" and AZ.hits() == 2 and OA.hits() == 0, out)
    s.check("...one log line, retry=failed", len(reply_lines()) == 1 and "retry=failed" in reply_lines()[0], reply_lines())

    # -----------------------------------------------------------------------------------------------------------------
    s.section("review_agent / lms_coach_turn: a cut-off turn is not run a third and fourth time")
    hist = [{"role": "user", "content": "How do I start my check-in?"}]
    for name, fn in (("review_agent", lambda: ai.review_agent("sys", hist)),
                     ("lms_coach_turn", lambda: ai.lms_coach_turn("sys", hist))):
        fresh(az="cut")
        try:
            fn()
            raised = None
        except ai.AIDraftError as e:
            raised = e
        s.check("%s: Azure cut off twice -> AIDraftError, exactly 2 Azure requests in all (not 3 or 4), no backup" % name,
                raised is not None and "cut off" in str(raised) and AZ.hits() == 2 and OA.hits() == 0,
                (raised, AZ.hits(), OA.hits()))
        s.check("%s: ...one log line" % name, len(reply_lines()) == 1 and "retry=failed" in reply_lines()[0], reply_lines())
        fresh(["cut", "turn"], az="turn")
        turn = fn()
        s.check("%s: cut once, then a good turn (inner retry) -> the turn, 2 requests" % name,
                turn.get("say") == "azure turn" and AZ.hits() == 2, (turn, AZ.hits()))
        fresh(["prose"], az="turn")
        turn = fn()
        s.check("%s: a reply that is not JSON IS still retried by the agent itself -> the turn, 2 requests" % name,
                turn.get("say") == "azure turn" and AZ.hits() == 2 and not reply_lines(), (turn, AZ.hits(), LOG.rec))
        fresh(["503", "turn"], az="turn", oa="503")
        turn = fn()
        s.check("%s: a 5xx with nobody else to answer is still retried by the agent (2 Azure requests)" % name,
                turn.get("say") == "azure turn" and AZ.hits() == 2, (turn, AZ.hits(), OA.hits()))

    # -----------------------------------------------------------------------------------------------------------------
    s.section("a call that finally fails with an HTTP status: ONE counts-only line (7 Nov 2026: nothing logged a 4xx / 5xx)")
    fresh(az="http:400:content_filter:ResponsibleAIPolicyViolation")
    out = call(1500)
    ln = failed_lines()
    s.check("Azure 400: the error as before, one request, never the backup", out[0] == "err" and "HTTP 400" in out[1]
            and AZ.hits() == 1 and OA.hits() == 0, (out, AZ.hits(), OA.hits()))
    s.check("...ONE line: feature, backend, status, error.code and innererror.code",
            len(ln) == 1 and ln[0] == "OneHR AI call failed: feature=call backend=azure status=400 code=content_filter "
            "inner=ResponsibleAIPolicyViolation", ln)
    s.check("...no prompt, no reply, no message text, no key anywhere in the log",
            not any(w in m for m in LOG.rec for w in (SECRET_PROMPT, SECRET_REPLY, "Aisha", "Tan-Wei", AZ_KEY, OA_KEY)), LOG.rec)
    s.check("...and no reply line for a refusal that is not a reply", not reply_lines(), LOG.rec)
    fresh(az="http:401:-:-")
    out = call(1500)
    s.check("no code in the body: code=- inner=-", failed_lines() == [
        "OneHR AI call failed: feature=call backend=azure status=401 code=- inner=-"], failed_lines())
    fresh(az="http:429:rate_limit_exceeded:-")
    out = call(1500)
    s.check("Azure 429 answered by the backup: no failure line (the call was answered; usage counts the 429)",
            out == ("ok", "openai answered") and not failed_lines(), (out, LOG.rec))
    fresh(az="http:429:Throttled:-", oa="http:503:server_error:-")
    out = call(1500)
    ln = failed_lines()
    s.check("both backends refuse: Azure's error as before, one line for each backend",
            out[0] == "err" and "HTTP 429" in out[1] and AZ.hits() == 1 and OA.hits() == 1 and len(ln) == 2
            and "backend=azure status=429 code=Throttled inner=-" in ln[0]
            and "backend=openai status=503 code=server_error inner=-" in ln[1], (out, ln))
    fresh(az="503", oa="nonjson:502")
    out = call(1500)
    ln = failed_lines()
    s.check("a body that is not JSON: the status is logged, the code is -", len(ln) == 2
            and "backend=azure status=503 code=- inner=-" in ln[0] and "backend=openai status=502 code=- inner=-" in ln[1], ln)
    s.check("...and none of that body is logged", not any(SECRET_REPLY in m for m in LOG.rec), LOG.rec)
    for label, code in (("a code with a hyphen", "bad-code"), ("a code with digits", "E429"), ("a 41-letter code", "a" * 41),
                        ("an integer code", "int")):
        fresh(az="http:400:%s:%s" % (code, "X1"))
        call(1500)
        s.check("%s is not kept (code=-), and an inner code with a digit neither" % label, failed_lines() == [
            "OneHR AI call failed: feature=call backend=azure status=400 code=- inner=-"], failed_lines())
    fresh(az="http:400:%s:%s" % ("a" * 40, "Abc_def"))
    call(1500)
    s.check("a 40-letter code and a word with an underscore ARE kept", failed_lines() == [
        "OneHR AI call failed: feature=call backend=azure status=400 code=%s inner=Abc_def" % ("a" * 40)], failed_lines())
    fresh(az="http:403:Forbidden:-")
    out = call(1500, deployment="chair-dep", azure_only=True)
    s.check("Azure only (the Chairman's chat): a refusal is logged too, and the backup is never asked",
            out[0] == "err" and OA.hits() == 0 and failed_lines() == [
                "OneHR AI call failed: feature=call backend=azure status=403 code=Forbidden inner=-"], (out, LOG.rec))
    fresh(az="cut")
    call(1500)
    s.check("a reply cut off twice (no HTTP status) has its reply line and NO failure line", reply_lines() and not failed_lines(), LOG.rec)
    fresh(az="empty_stop")
    call(1500)
    s.check("an empty reply has no failure line either", not failed_lines(), LOG.rec)
    fresh(["429"])
    ai._TL.t0 = NOW[0] - 45      # 5 s left: no failover to the backup
    out = call(1500)
    s.check("a 429 with no time left to fail over fails the call: one line for it (the backup was not tried)",
            out[0] == "err" and OA.hits() == 0 and failed_lines() == [
                "OneHR AI call failed: feature=call backend=azure status=429 code=- inner=-"], (out, LOG.rec))
    s.check("...usage is counted exactly as before (err_429 + the unanswered call)", usage().get("azure", {}).get("err_429") == 1)
    ai._TL.t0 = None
    fresh(az="http:400:content_filter:-")
    s.check("routing is unchanged: _fails_over still never sends a 400 to the backup", ai._fails_over(
        "azure", ai.AIBackendError("x", status=400)) is False and ai._fails_over("azure", ai.AIBackendError("x", status=429)) is True)

    # -----------------------------------------------------------------------------------------------------------------
    s.section("AIBackendError keeps its old shape")
    e = ai.AIBackendError("x")
    s.check("the new fields default to None (nothing else changes)",
            (e.kind, e.status, e.sub, e.finish_reason, e.completion_tokens, e.reasoning_tokens, e.api_code, e.inner_code)
            == ("http", None, None, None, None, None, None, None))
finally:
    ai._cfg, ai._clock, ai._backend_call = _orig["cfg"], _orig["clock"], _orig["bc"]
    ai.review_cli_enabled = _orig["rcli"]
    _lg.removeHandler(LOG)
    _lg.setLevel(_orig["level"])
    for k, v in _orig["env"].items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    ai._COOL.update(azure=0.0, openai=0.0, openai_off=0.0)
    ai.background_calls(False)
    ai.request_clock(False)
    ai.usage_take()
    AZ.srv.shutdown()
    OA.srv.shutdown()

sys.exit(s.done())
