"""The evidence ledger -- Phase A.

The ledger's whole value rests on two promises: what somebody wrote cannot be
quietly rewritten, and nobody can write in another person's name. Both are
enforced in one function, `pm_evidence_write()`, so most of this suite attacks
that function rather than the pages around it.

It also asserts the REVERSIBILITY guarantee directly: drop every pm_evidence*
table and the scoring functions must return byte-identical results. A later
change that caches a band or a score in the ledger breaks that test.

This suite WRITES, so it takes a fresh database copy.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Evidence ledger (Phase A)")
SU, _BG, EMP = H.actors(a)
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    OTHER = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL "
                       "AND id!=? LIMIT 1", (EMP["id"],)).fetchone()


def module(on):
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycle_modules SET active=? WHERE module_key='evidence'",
                   (1 if on else 0,))
        db.commit()


def create(client, **over):
    form = {"csrf_token": "tok", "body": "Recovered the Ipoh line after the compressor "
                                         "failed, and rebuilt the delivery schedule.",
            "occurred_on": "2026-03-14", "kind": "delivery",
            "title": "Ipoh compressor recovery", "impact": "Zero missed deliveries",
            "metric_value": "11", "metric_unit": "days", "who": "Encik Rahim"}
    form.update(over)
    return client.post("/evidence/new", data=form)


def latest():
    rows = H.rows(a, "SELECT * FROM pm_evidence ORDER BY id DESC LIMIT 1")
    return rows[0] if rows else None


s.section("the migration")
tables = [r[0] for r in H.rows(a, "SELECT name FROM sqlite_master WHERE type='table' "
                                  "AND name LIKE 'pm_evidence%' ORDER BY name")]
# Phase A shipped the three-table substrate; Phase B step 2 (2026-08-29) added
# pm_evidence_reviews (endorse/dispute) and pm_evidence_citations (cite with a
# stance) -- the two the Phase A record deliberately deferred until there was a
# manager surface for them. So the ledger now owns five.
s.check("the three Phase A substrate tables exist",
        set(["pm_evidence", "pm_evidence_attachments", "pm_evidence_links"]).issubset(tables), tables)
s.check("...plus the two Phase B step 2 tables",
        set(["pm_evidence_reviews", "pm_evidence_citations"]).issubset(tables), tables)
s.check("indexed on (subject, occurred_on)",
        any("idx_ev_subject" == r[0] for r in
            H.rows(a, "SELECT name FROM sqlite_master WHERE type='index'")))

s.section("it ships SWITCHED OFF")
# cycle_module_on() reads a MISSING row as ON, so shipping off means seeding an
# EXPLICIT row -- not leaving the table alone. The seed writes active=0; a live
# deployment may since have switched it ON (staging, and this dev DB, have), so
# assert the explicit-row invariant, then drive the off-behaviour deterministically.
n_cycles = H.one(a, "SELECT COUNT(*) FROM cycles")
rows_ev = H.one(a, "SELECT COUNT(*) FROM cycle_modules WHERE module_key='evidence'")
s.check("an explicit evidence row exists for every cycle", rows_ev == n_cycles, (rows_ev, n_cycles))
E = H.client_as(a, EMP["id"])
module(False)
s.check("/evidence 404s while off", E.get("/evidence").status_code == 404)
s.check("...and so does a write", E.post("/evidence/new",
        data={"csrf_token": "tok", "body": "x"}).status_code == 404)
module(True)

s.section("seeding is idempotent -- it must never re-disable a live module")
module(True)
a._ensure_runtime_schema()                       # simulate the next boot
still_on = H.one(a, "SELECT active FROM cycle_modules WHERE module_key='evidence' "
                    "AND cycle_id=?", (CID,))
s.check("a module an admin switched on stays on across a migration", still_on == 1, still_on)

s.section("capture")
E = H.client_as(a, EMP["id"])
s.check("/evidence 200 while on", E.get("/evidence").status_code == 200)
s.check("create -> redirect", create(E).status_code == 302)
item = latest()
s.check("the item exists", item is not None)
s.check("it starts as a draft", item["state"] == "draft", item["state"])
s.check("author_role derived as 'self'", item["author_role"] == "self")
s.check("body stored verbatim", "compressor" in (item["body"] or ""))
s.check("the measure is split from the claim",
        item["metric_value"] == 11.0 and item["metric_unit"] == "days")
s.check("a body-less entry is refused",
        create(E, body="").status_code == 302 and latest()["id"] == item["id"])

s.section("occurred_on is a CALENDAR DATE, never a UTC timestamp")
# The next timezone bug in this codebase would be putting |myt on this column.
s.check("stored exactly as stated, unshifted", item["occurred_on"] == "2026-03-14",
        item["occurred_on"])
s.check("created_at is a stored UTC timestamp", len(item["created_at"]) >= 19)
tmpl = H.source(a, os.path.join("templates", "_evidence_card.html"))
s.check("the card renders occurred_on RAW", "{{ e['occurred_on'] }}" in tmpl)
s.check("...and created_at through |myt_date", "e['created_at'] | myt_date" in tmpl)
s.check("no |myt on occurred_on anywhere",
        "occurred_on'] | myt" not in tmpl and "occurred_on | myt" not in tmpl)
# The gap between the two is the whole late-record signal.
gap = H.one(a, "SELECT CAST(julianday(substr(created_at,1,10)) - "
               "julianday(occurred_on) AS INTEGER) FROM pm_evidence WHERE id=?", (item["id"],))
s.check("the gap between happening and recording is readable", gap is not None and gap > 100,
        gap)

s.section("the card's own forms carry a usable CSRF token")
# A Jinja macro imported WITHOUT `with context` sees none of the caller's
# context, so {{ csrf_token }} inside the card rendered empty and Share silently
# did nothing -- and base.html's auto-token script does not rescue it, because
# that only fills forms with NO token field, not ones with an empty value.
page = E.get("/evidence").get_data(as_text=True)
import re as _re  # noqa: E402
toks = _re.findall(r'name="csrf_token" value="([^"]*)"', page)
s.check("every csrf field on the page has a value",
        toks and all(t for t in toks), "%d fields, %d empty"
        % (len(toks), len([t for t in toks if not t])))
s.check("the card macro is imported WITH CONTEXT",
        "import evidence_card with context" in
        H.source(a, os.path.join("templates", "evidence.html")))

s.section("APPEND-ONLY after share")
r = E.post("/evidence/%d/share" % item["id"], data={"csrf_token": "tok"})
s.check("share -> redirect", r.status_code == 302)
shared = H.rows(a, "SELECT * FROM pm_evidence WHERE id=?", (item["id"],))[0]
s.check("state is shared", shared["state"] == "shared")
s.check("shared_at is stamped", bool(shared["shared_at"]))
r = E.post("/evidence/%d/autosave" % item["id"],
           data={"csrf_token": "tok", "body": "COMPLETELY DIFFERENT STORY",
                 "occurred_on": "2026-01-01"})
s.check("editing a shared item is REFUSED", r.status_code == 409, r.status_code)
after = H.rows(a, "SELECT * FROM pm_evidence WHERE id=?", (item["id"],))[0]
s.check("...and the words are untouched", after["body"] == shared["body"])
s.check("...and so is the date", after["occurred_on"] == "2026-03-14")

s.section("a correction is a NEW ROW; the original survives")
create(E, body="Correcting myself: it was the Nilai line, not Ipoh.",
       correction_of=str(item["id"]))
corr = latest()
s.check("the correction points at what it replaces",
        corr["supersedes_id"] == item["id"], corr["supersedes_id"])
s.check("the original is still there",
        H.one(a, "SELECT COUNT(*) FROM pm_evidence WHERE id=?", (item["id"],)) == 1)
s.check("the original is still readable",
        H.rows(a, "SELECT body FROM pm_evidence WHERE id=?", (item["id"],))[0]["body"]
        == shared["body"])
s.check("the ledger shows both",
        len([e for e in H.rows(a, "SELECT id FROM pm_evidence WHERE subject_id=?",
                               (EMP["id"],))]) >= 2)

s.section("authorship comes from the session, never the form")
O = H.client_as(a, OTHER["id"])
# A forged author_id in the form must be ignored entirely.
create(O, author_id=str(EMP["id"]), subject_id=str(EMP["id"]),
       body="Forged: written by somebody else about somebody else.")
forged = latest()
s.check("author_id is the logged-in user", forged["author_id"] == OTHER["id"],
        (forged["author_id"], OTHER["id"]))
s.check("subject_id is the logged-in user too", forged["subject_id"] == OTHER["id"])
r = O.post("/evidence/%d/autosave" % corr["id"],
           data={"csrf_token": "tok", "body": "hijacked", "occurred_on": "2026-03-14"})
s.check("nobody can edit another person's item", r.status_code == 409, r.status_code)
r = O.post("/evidence/%d/share" % corr["id"], data={"csrf_token": "tok"})
s.check("...or share it", r.status_code == 404, r.status_code)
r = H.client_as(a, SU["id"]).get("/evidence")
s.check("an admin has no ledger page of their own", r.status_code == 404, r.status_code)

s.section("attachments")
draft_id = latest()["id"]
import io as _io  # noqa: E402
import upload_samples as _US  # noqa: E402   # an upload must be what its name says (2026-11-11)
def upload(client, eid, name, data=None):
    if data is None:
        data = _US.sample(name.rsplit(".", 1)[-1]) if name.endswith(".png") else b"x" * 32
    return client.post("/evidence/%d/attach" % eid, data={
        "csrf_token": "tok", "file": (_io.BytesIO(data), name)},
        content_type="multipart/form-data")
upload(O, draft_id, "proof.exe")
s.check("an executable is refused",
        H.one(a, "SELECT COUNT(*) FROM pm_evidence_attachments WHERE evidence_id=?",
              (draft_id,)) == 0)
upload(O, draft_id, "proof.png")
s.check("an image is accepted",
        H.one(a, "SELECT COUNT(*) FROM pm_evidence_attachments WHERE evidence_id=?",
              (draft_id,)) == 1)
upload(O, draft_id, "big.png", b"x" * (a.EVIDENCE_ATTACH_MAX_BYTES + 1))
s.check("an oversized file is refused",
        H.one(a, "SELECT COUNT(*) FROM pm_evidence_attachments WHERE evidence_id=?",
              (draft_id,)) == 1)
for i in range(a.EVIDENCE_MAX_ATTACH_PER_ITEM + 2):
    upload(O, draft_id, "f%d.png" % i)
s.check("the per-item count cap holds",
        H.one(a, "SELECT COUNT(*) FROM pm_evidence_attachments WHERE evidence_id=?",
              (draft_id,)) == a.EVIDENCE_MAX_ATTACH_PER_ITEM,
        H.one(a, "SELECT COUNT(*) FROM pm_evidence_attachments WHERE evidence_id=?",
              (draft_id,)))
aid = H.rows(a, "SELECT id FROM pm_evidence_attachments WHERE evidence_id=? LIMIT 1",
             (draft_id,))[0]["id"]
s.check("the owner can download it",
        O.get("/evidence/attachment/%d" % aid).status_code == 200)
# 404 rather than 403: somebody else's file should not be confirmed to exist.
s.check("somebody else cannot -- and is not told it exists",
        E.get("/evidence/attachment/%d" % aid).status_code == 404)
s.check("uploads live outside static/", "static" not in a.EVIDENCE_UPLOAD_DIR)

s.section("nothing here caches a verdict")
# The reversibility guarantee. A band, score or actual_value cached in the
# ledger would make dropping it change what people are paid.
BANNED = ("band", "score", "actual_value", "rating", "weightage")
offenders = []
for table in tables:
    for col in H.rows(a, "PRAGMA table_info(%s)" % table):
        if any(b in col["name"].lower() for b in BANNED):
            offenders.append("%s.%s" % (table, col["name"]))
s.check("no band / score / actual_value column anywhere", not offenders, offenders)

s.section("the module gate classifies /evidence for free")
unclassified = [r.rule for r in a.app.url_map.iter_rules()
                if r.rule.startswith("/evidence")
                and not a.module_of_request(r.endpoint, r.rule)]
s.check("every /evidence route resolves to the evidence module",
        not unclassified, unclassified)
s.check("with ZERO additions to MODULE_UNGATED_ENDPOINTS",
        not [e for e in a.MODULE_UNGATED_ENDPOINTS if "evidence" in e],
        [e for e in a.MODULE_UNGATED_ENDPOINTS if "evidence" in e])

s.section("REVERSIBILITY -- dropping the ledger changes no score")
with a.app.test_request_context("/"):
    from flask import session
    session["user_id"] = SU["id"]
    db = a.get_db()
    subs = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL "
                      "LIMIT 60").fetchall()
    before = [a.pm_effective_band(db, x, CID, "ME")["band"] for x in subs]
with a.app.app_context():
    db = a.get_db()
    for t in ("pm_evidence_attachments", "pm_evidence_links", "pm_evidence"):
        db.execute("DROP TABLE %s" % t)
    db.commit()
with a.app.test_request_context("/"):
    from flask import session as _s
    _s["user_id"] = SU["id"]
    db = a.get_db()
    after = [a.pm_effective_band(db, x, CID, "ME")["band"] for x in subs]
s.check("every band identical with the ledger dropped", before == after,
        [(i, b, c) for i, (b, c) in enumerate(zip(before, after)) if b != c][:3])

s.section("templates")
n, broken = H.every_template_compiles(a)
s.check("all %d templates compile" % n, not broken, broken[:3])

sys.exit(s.done())
