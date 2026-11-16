"""Phase D -- AI in the guided review, as decoration on a path that runs without it.

THE ONE CLAIM THIS SUITE EXISTS TO PROVE: the product is unchanged without the
model. So the AI-off path, the HR-toggle-off path, and the model-is-down path
must be provably the SAME deterministic fallback -- the item list, and nothing
pre-ticked. Everything else here is the "may never do" list, asserted rather
than trusted:

  * Phase D introduces NO new writer -- summary and suggest write nothing.
  * every prompt is built from ONE subject, and carries no assessor identity.
  * summaries are rendered and STORED NOWHERE.

The real model is never called. _chat_complete is stubbed, exactly as test_phase0
stubs ai_draft, because staging has no Azure key and a test must not need one.

This suite WRITES (it seeds evidence and KPI lines), so it takes a fresh copy.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
import ai_draft  # noqa: E402
s = H.Suite("Phase D -- AI in the review, decoration on a working path")
SU, _BG, _EMP = H.actors(a)
SRC = H.source(a)

# ---------------------------------------------------------------------------
# A stubbed model. Two shapes: a summary (prose) and a suggest (a JSON array).
# Counts its own calls, so a test can assert the model is NOT touched when off.
MODEL = {"calls": 0, "on": True}
_real_cfg, _real_chat = ai_draft._cfg, ai_draft._chat_complete


def stub_chat(system, user, max_tokens, timeout, effort=None):   # the summary jobs pass their reasoning effort
    MODEL["calls"] += 1
    if "Summarise" in user:
        return "[1] led the plant changeover; [2] cut overtime."
    return "[1]"


def ai_on_stub():
    ai_draft._cfg = lambda: ("https://x", "k", "dep", "2024-10-21")
    ai_draft._chat_complete = stub_chat


def ai_off_unconfigured():
    ai_draft._cfg = lambda: ("", "", "", "")          # is_configured() -> False
    ai_draft._chat_complete = stub_chat


def ai_down():
    ai_draft._cfg = lambda: ("https://x", "k", "dep", "2024-10-21")   # configured

    def boom(*_a, **_k):
        MODEL["calls"] += 1
        raise ai_draft.AIDraftError("Azure OpenAI is down")
    ai_draft._chat_complete = boom


# ---------------------------------------------------------------------------
s.section("the build")
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','evidence')")
    SUBJ = db.execute("SELECT u.* FROM users u WHERE u.role!='admin' AND u.left_at IS NULL "
                      "LIMIT 1").fetchone()
    OTHER = db.execute("SELECT u.* FROM users u WHERE u.role!='admin' AND u.id!=? LIMIT 1",
                       (SUBJ["id"],)).fetchone()
    db.execute("DELETE FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (CID, SUBJ["id"]))
    TID = db.execute(
        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, "
        "status, business_group) VALUES (?,?,?,?,?,'approved',?)",
        (CID, SUBJ["id"], "ZZ Plant Uptime", 100.0, "more",
         SUBJ["business_group"] or "")).lastrowid
    # one of the OTHER person's targets, to prove the ownership gate
    OTID = db.execute(
        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, "
        "status, business_group) VALUES (?,?,?,?,?,'approved',?)",
        (CID, OTHER["id"], "ZZ Someone Else", 100.0, "more",
         OTHER["business_group"] or "")).lastrowid
    EID = db.execute(
        "INSERT INTO pm_evidence(subject_id, author_id, author_role, occurred_on, kind, "
        "body, state, shared_at) VALUES (?,?, 'self','2026-03-14','delivery',"
        "'Ran the plant changeover single-handed.','shared',datetime('now'))",
        (SUBJ["id"], SUBJ["id"])).lastrowid
    db.commit()
s.check("ai_review is a toggle", any(k == "ai_review" for k, _l, _d in a.AI_MODULES))
E = H.client_as(a, SUBJ["id"])

# ---------------------------------------------------------------------------
s.section("with Azure unconfigured, the AI is simply off (staging today)")
ai_off_unconfigured()
with a.app.test_request_context("/"):
    from flask import session
    session["user_id"] = SUBJ["id"]
    s.check("ai_on('ai_review') is False when unconfigured",
            a.ai_on("ai_review") is False)

# ---------------------------------------------------------------------------
s.section("DEGRADATION IS IDENTICAL THREE WAYS -- the claim of the whole phase")
# The design: "with Azure OpenAI unconfigured or down, the conversation runs
# unchanged". Prove the fallback is the SAME whether the AI is off, the HR toggle
# is off, or the model raises mid-call.
def brief_body():
    return E.get("/review/brief").get_data(as_text=True)


def suggest_json():
    return E.get("/review/account/suggest?kpi=%d" % TID).get_json()


ai_off_unconfigured()
off_brief, off_suggest = brief_body(), suggest_json()
MODEL["calls"] = 0
with a.app.app_context():
    a.get_db().execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('ai_review','0')")
    a.get_db().commit()
ai_on_stub()                        # configured, but HR switched it off
toggle_brief, toggle_suggest = brief_body(), suggest_json()
s.check("HR-toggle-off makes no model call", MODEL["calls"] == 0, MODEL["calls"])
with a.app.app_context():
    a.get_db().execute("DELETE FROM app_settings WHERE key='ai_review'")
    a.get_db().commit()
ai_down()
down_brief, down_suggest = brief_body(), suggest_json()
s.check("the model was actually attempted on the down path", MODEL["calls"] > 0, MODEL["calls"])

# The three fallbacks must be the same deterministic answer.
def norm(html):
    return " ".join(re.sub(r'\bv=\d+\b', '', re.sub(r"<[^>]+>", " ", html)).split())


s.check("brief: unconfigured == toggle-off == model-down",
        norm(off_brief) == norm(toggle_brief) == norm(down_brief),
        [norm(off_brief)[:60], norm(toggle_brief)[:60], norm(down_brief)[:60]])
s.check("suggest: all three fall back to nothing pre-ticked",
        off_suggest["suggested"] == toggle_suggest["suggested"]
        == down_suggest["suggested"] == [],
        [off_suggest, toggle_suggest, down_suggest])
s.check("...and the fallback brief IS the item list, not an error",
        "Here is what you wrote" in off_brief and "changeover" in off_brief)

# ---------------------------------------------------------------------------
s.section("with the model ON (stubbed), it decorates -- nothing more")
ai_on_stub()
b = E.get("/review/brief").get_data(as_text=True)
s.check("the summary is prose over the person's own words", "cut overtime" in b, b[:0])
s.check("...cited to the item's [n] tag", "[1]" in b)
s.check("...and it still shows the raw items beneath -- ids are the contract",
        "changeover" in b)
sg = E.get("/review/account/suggest?kpi=%d" % TID).get_json()
s.check("suggest pre-ticks the relevant item by its evidence id",
        sg["suggested"] == [EID], (sg, EID))

# ---------------------------------------------------------------------------
s.section("PHASE D WRITES NOTHING -- the headline safety property")
# A connection trace over both AI endpoints. The only rows they may add are
# pm_ai_draft_usage (the rate-limit ledger) -- never a fact, never a citation,
# never a narrative field. Assert no write touches pm_evidence or its links.
WRITE = re.compile(r"^\s*(INSERT|UPDATE|DELETE|REPLACE)\s+(?:OR\s+\w+\s+)?INTO?\s+"
                   r"(pm_evidence\w*|pm_kpi\w*|pm_overall\w*|pm_checkins)", re.I)
seen = []
_rc = a.sqlite3.connect


def tracing(*args, **kw):
    con = _rc(*args, **kw)
    con.set_trace_callback(lambda q: seen.append(" ".join((q or "").split())[:80])
                           if WRITE.match(q or "") else None)
    return con


ai_on_stub()
a.sqlite3.connect = tracing
try:
    H.client_as(a, SUBJ["id"]).get("/review/brief")
    H.client_as(a, SUBJ["id"]).get("/review/account/suggest?kpi=%d" % TID)
finally:
    a.sqlite3.connect = _rc
s.check("neither AI endpoint writes a fact, a citation, or a narrative field",
        not seen, seen[:3])
# It is allowed to record ONE usage row per call for the rate limiter, and nothing more.
s.check("the only new rows are the rate-limit ledger",
        H.one(a, "SELECT COUNT(*) FROM pm_ai_draft_usage WHERE field_key LIKE 'review_%'") > 0)

# ---------------------------------------------------------------------------
s.section("ONE SUBJECT, NO ASSESSOR -- the agent's whole view is narrow")
# The builders must read only this subject's own rows and never an assessor.
_ai = H.code_without_docstrings(
    SRC[SRC.find("def _review_ai_items"):SRC.find("def review_partial_overall")])
s.check("the builders select only WHERE subject_id=?", "subject_id=?" in _ai)
for forbidden in ("assignments", "assessor", "responses", "pm_calibration"):
    s.check("...and never read %-16s" % forbidden, forbidden not in _ai, forbidden)
# And prove it dynamically: the items the model is handed are only SUBJ's.
with a.app.app_context():
    db = a.get_db()
    db.execute("INSERT INTO pm_evidence(subject_id,author_id,author_role,occurred_on,kind,"
               "body,state,shared_at) VALUES (?,?, 'self','2026-02-02','delivery',"
               "'OTHER PERSON SECRET ITEM','shared',datetime('now'))",
               (OTHER["id"], OTHER["id"]))
    db.commit()
    items = a._review_ai_items(db, SUBJ["id"])
s.check("the builder returns only the subject's own items",
        all("SECRET" not in t for _n, t, _e in items) and len(items) == 1,
        [t[:30] for _n, t, _e in items])

s.section("the ownership gate on suggest -- no enumeration oracle")
ai_on_stub()
s.check("a KPI the caller does not own -> 403",
        E.get("/review/account/suggest?kpi=%d" % OTID).status_code == 403)
s.check("a non-numeric kpi -> 400",
        E.get("/review/account/suggest?kpi=abc").status_code == 400)

# ---------------------------------------------------------------------------
s.section("turns still do not block on the model")
# The AI is on-demand only. A turn render must issue no model call.
MODEL["calls"] = 0
ai_on_stub()
E.get("/review/account")
E.get("/review/account/turn")
s.check("rendering the Account stage makes ZERO model calls", MODEL["calls"] == 0,
        MODEL["calls"])

s.section("gating: the AI reads die with the phase, the writer with the ledger")
s.check("review_brief classified under the review phase",
        a.MODULE_ENDPOINTS.get("review_brief") == "review")
s.check("review_account_suggest under pm (a KPI question)",
        a.MODULE_ENDPOINTS.get("review_account_suggest") == "pm")
with a.app.app_context():
    a.get_db().execute("UPDATE cycle_modules SET active=0 WHERE module_key='review'")
    a.get_db().commit()
s.check("phase off -> the brief 404s", E.get("/review/brief").status_code == 404)
with a.app.app_context():
    a.get_db().execute("UPDATE cycle_modules SET active=1 WHERE module_key='review'")
    a.get_db().commit()

ai_draft._cfg, ai_draft._chat_complete = _real_cfg, _real_chat

# ---------------------------------------------------------------------------
s.section("per-model request parameters (GPT-6 Luna test, Chris 2026-09-25)")
# A reasoning model rejects max_tokens + temperature; keyed off the deployment name, gpt-6 must get the gpt-5 shape.
_p5 = ai_draft._chat_payload("gpt-5-mini", "s", "u", 500, "minimal")
_p6 = ai_draft._chat_payload("gpt-6-luna", "s", "u", 500, "minimal")
_p4 = ai_draft._chat_payload("gpt-4o-mini", "s", "u", 500, "minimal")
s.check("gpt-5-mini: max_completion_tokens + reasoning_effort, no temperature (unchanged)",
        _p5.get("max_completion_tokens") == 500 and _p5.get("reasoning_effort") == "minimal"
        and "temperature" not in _p5 and "max_tokens" not in _p5, _p5)
s.check("gpt-6-luna gets the same reasoning-model shape", {k: v for k, v in _p6.items() if k != "messages"}
        == {k: v for k, v in _p5.items() if k != "messages"}, _p6)
s.check("gpt-4o-mini keeps max_tokens + temperature", _p4.get("max_tokens") == 500 and _p4.get("temperature") == 0.5
        and "reasoning_effort" not in _p4, _p4)
os.environ["AZURE_OPENAI_REASONING"] = "1"
s.check("AZURE_OPENAI_REASONING=1 forces the reasoning shape for a deployment named otherwise",
        "max_completion_tokens" in ai_draft._chat_payload("my-luna", "s", "u", 10))
os.environ.pop("AZURE_OPENAI_REASONING", None)
# The effort ladder: a model that rejects "minimal" is retried at "low" (then without it).
import io, json as _json, urllib.error as _ue
_sent = []
class _Resp(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *a): return False
def _fake_urlopen(req, timeout=None):
    body = _json.loads(req.data.decode())
    _sent.append(body.get("reasoning_effort"))
    if body.get("reasoning_effort") == "minimal":
        raise _ue.HTTPError(req.full_url, 400, "bad", {}, io.BytesIO(
            b'{"error":{"message":"Unsupported value: \'reasoning_effort\' does not support \'minimal\'"}}'))
    return _Resp(_json.dumps({"choices": [{"message": {"content": "ok from luna"}}]}).encode())
_real_open = ai_draft.urllib.request.urlopen
ai_draft.urllib.request.urlopen = _fake_urlopen
_real_cfg2 = ai_draft._cfg
ai_draft._cfg = lambda: ("https://x", "k", "gpt-5-mini", "2024-10-21")
try:
    _out = ai_draft._chat_complete("s", "u", 50, 5)
finally:
    ai_draft.urllib.request.urlopen, ai_draft._cfg = _real_open, _real_cfg2
s.check("a 400 on reasoning_effort=minimal retries at 'low' and succeeds",
        _out == "ok from luna" and _sent == ["minimal", "low"], (_out, _sent))
# GPT-6 Luna rejects "minimal" (probed on the staging resource, 2026-09-25): it gets "none" FIRST, no wasted call.
_sent[:] = []
ai_draft.urllib.request.urlopen = _fake_urlopen
ai_draft._cfg = lambda: ("https://x", "k", "gpt-6-luna", "2024-10-21")
try:
    _out6 = ai_draft._chat_complete("s", "u", 50, 5)
finally:
    ai_draft.urllib.request.urlopen, ai_draft._cfg = _real_open, _real_cfg2
s.check("gpt-6-luna is sent reasoning_effort='none' first -- one call, no rejected 'minimal'",
        _out6 == "ok from luna" and _sent == ["none"], (_out6, _sent))
os.environ["AZURE_OPENAI_REASONING_EFFORT"] = "low"
s.check("AZURE_OPENAI_REASONING_EFFORT overrides the default for any model",
        ai_draft._default_effort("gpt-6-luna") == "low" and ai_draft._default_effort("gpt-5-mini") == "low")
os.environ.pop("AZURE_OPENAI_REASONING_EFFORT", None)
s.check("...and without it gpt-5 keeps 'minimal', gpt-6 gets 'none'",
        ai_draft._default_effort("gpt-5-mini") == "minimal" and ai_draft._default_effort("gpt-6-luna") == "none")

# The reply shapes a reasoning model can return, and failures while READING the reply (GPT-6 audit, 2026-09-25):
# every one must surface as AIDraftError (callers fall back, review_agent retries), never a bare exception / 500.
def _chat_with(fake):
    _ro, _rc = ai_draft.urllib.request.urlopen, ai_draft._cfg
    ai_draft.urllib.request.urlopen = fake
    ai_draft._cfg = lambda: ("https://x", "k", "gpt-6-luna", "2024-10-21")
    try:
        return ("ok", ai_draft._chat_complete("s", "u", 50, 5))
    except ai_draft.AIDraftError as e:
        return ("aidrafterror", str(e))
    except Exception as e:
        return ("other", repr(e))
    finally:
        ai_draft.urllib.request.urlopen, ai_draft._cfg = _ro, _rc
def _reply(choice):
    return lambda req, timeout=None: _Resp(_json.dumps({"choices": [choice]}).encode())
def _raise(exc):
    def f(req, timeout=None):
        raise exc
    return f
_r1 = _chat_with(_reply({"message": {"content": None, "refusal": "no"}, "finish_reason": "stop"}))
s.check("content: null (a refusal / filter) -> AIDraftError, not an AttributeError", _r1[0] == "aidrafterror", _r1)
_r2 = _chat_with(_reply({"message": {"content": "half a transcr"}, "finish_reason": "length"}))
s.check("finish_reason=length -> AIDraftError (a truncated reply is never accepted as complete)",
        _r2[0] == "aidrafterror" and "token limit" in _r2[1], _r2)
_r3 = _chat_with(_reply({"message": {"content": [{"type": "text", "text": "Hello "}, {"type": "text", "text": "there"}]},
                         "finish_reason": "stop"}))
s.check("content as a list of parts is joined", _r3 == ("ok", "Hello there"), _r3)
import socket as _sock, http.client as _hc
for _exc in (TimeoutError("read timed out"), _sock.timeout("timed out"), ConnectionResetError("reset"),
             _hc.IncompleteRead(b"x")):
    _r4 = _chat_with(_raise(_exc))
    s.check("a %s while reading -> AIDraftError" % type(_exc).__name__, _r4[0] == "aidrafterror", _r4)
_r5 = _chat_with(lambda req, timeout=None: _Resp(b"<html>bad gateway</html>"))
s.check("a non-JSON body -> AIDraftError", _r5[0] == "aidrafterror", _r5)
# The turn parser: literal newlines inside a string, trailing prose with a brace, two objects.
_raw_nl = '{"say": "Line one' + "\n" + 'line two", "quick_replies": [], "action": null}'
_t2 = ai_draft._parse_turn(_raw_nl)
s.check("a literal newline inside 'say' parses (strict=False)", _t2["say"] == "Line one\nline two", _t2)
_t3 = ai_draft._parse_turn('{"say": "Hi", "quick_replies": [], "action": null} -- note: {see above}')
s.check("trailing prose with a brace -> the first object", _t3["say"] == "Hi", _t3)
_t4 = ai_draft._parse_turn('{"say": "First", "quick_replies": [], "action": null}\n{"say": "Second"}')
s.check("two objects -> the first one", _t4["say"] == "First", _t4)
# review_agent: a timeout is NOT retried (a second 25s try can't fit behind nginx's 60s); a 5xx still is, once.
_calls = []
def _cc_timeout(*a, **k):
    _calls.append(1); raise ai_draft.AIDraftError("Azure OpenAI call failed: TimeoutError: read timed out")
def _cc_503(*a, **k):
    _calls.append(1); raise ai_draft.AIDraftError("Azure OpenAI HTTP 503: busy")
_real_cc, _real_cfg3 = ai_draft._chat_complete, ai_draft._cfg
ai_draft._cfg = lambda: ("https://x", "k", "gpt-6-luna", "2024-10-21")
try:
    for _fn, _want, _lbl in ((_cc_timeout, 1, "a timeout: one call, no retry"), (_cc_503, 2, "a 503: retried once")):
        _calls[:] = []
        ai_draft._chat_complete = _fn
        try:
            ai_draft.review_agent("s", [{"role": "user", "content": "hi"}])
        except ai_draft.AIDraftError:
            pass
        s.check("review_agent, " + _lbl, len(_calls) == _want, len(_calls))
finally:
    ai_draft._chat_complete, ai_draft._cfg = _real_cc, _real_cfg3
sys.exit(s.done())
