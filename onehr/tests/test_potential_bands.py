"""Per-cycle potential-band thresholds (2026-09-07). The Low/Mid/High cutoffs are
global today; the 1+1 Year-End framework rescales the max to 17.5, so its bands
(Low<=6.0, Mid<=12.5) must apply to THAT cycle without re-banding a completed
35-scale cycle. Thresholds become per-cycle (cycles.low_max/mid_max, NULL=global),
resolved inside the two band helpers -- so every consumer inherits it and Mid-Year
is byte-identical while its columns stay NULL.

Writes cycle threshold columns on a scratch copy, so a fresh copy.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Potential bands -- per-cycle thresholds")
SU, _BG, _EMP = H.actors(a)


def set_thr(cid, lo, mi):
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycles SET low_max=?, mid_max=? WHERE id=?", (lo, mi, cid))
        db.commit()


# ---------------------------------------------------------------------------
s.section("effective_thresholds -- per-cycle value wins, NULL falls back to global")
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    G_LOW, G_MID = a.get_thresholds()
    # Make sure the active cycle starts with no override.
    db.execute("UPDATE cycles SET low_max=NULL, mid_max=NULL WHERE id=?", (CID,))
    db.commit()
    row = db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()
    eff_null = a.effective_thresholds(row)
s.check("a NULL-override cycle returns the global default",
        eff_null == (G_LOW, G_MID), (eff_null, (G_LOW, G_MID)))
set_thr(CID, 6.0, 12.5)
with a.app.app_context():
    row = a.get_db().execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()
    eff_set = a.effective_thresholds(row)
s.check("a cycle with an override returns its own cutoffs", eff_set == (6.0, 12.5), eff_set)
with a.app.app_context():
    tfc = a.thresholds_for_cycle(a.get_db(), CID)
s.check("thresholds_for_cycle matches effective_thresholds", tfc == (6.0, 12.5), tfc)
# restore NULL for the regression section
set_thr(CID, None, None)
with a.app.app_context():
    tfc0 = a.thresholds_for_cycle(a.get_db(), CID)
s.check("...and NULL again resolves to the global", tfc0 == (G_LOW, G_MID), tfc0)

# ---------------------------------------------------------------------------
s.section("potential_band -- boundaries on the 17.5 scale vs the 35 scale")
b = a.potential_band
s.check("5.9 -> Low (17.5 scale)", b(5.9, (6.0, 12.5)) == "Low")
s.check("6.0 -> Low", b(6.0, (6.0, 12.5)) == "Low")
s.check("6.5 -> Mid", b(6.5, (6.0, 12.5)) == "Mid")
s.check("12.5 -> Mid", b(12.5, (6.0, 12.5)) == "Mid")
s.check("13.0 -> High", b(13.0, (6.0, 12.5)) == "High")
# the SAME raw score bands differently under the two scales -- the whole reason
# the thresholds must be per-cycle.
s.check("a score of 15 is High on 17.5 but Mid on 35",
        b(15.0, (6.0, 12.5)) == "High" and b(15.0, (14.0, 26.0)) == "Mid")

# ---------------------------------------------------------------------------
s.section("Mid-Year regression -- NULL override bands IDENTICALLY to explicit global")
# Pick subjects who actually score on the active cycle, so the vectors are non-trivial.
with a.app.app_context():
    db = a.get_db()
    subj_ids = [r["subject_id"] for r in db.execute(
        "SELECT DISTINCT subject_id FROM assignments WHERE cycle_id=? LIMIT 40", (CID,)).fetchall()]


def band_vec():
    out = {}
    # A request context (fresh g -> fresh threshold cache): subject_band ->
    # min_valid_submissions -> _config_cycle -> current_user reads the session.
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = SU["id"]
        db = a.get_db()
        for sid in subj_ids:
            subj = db.execute("SELECT * FROM users WHERE id=?", (sid,)).fetchone()
            if subj is None:
                continue
            out[sid] = a.subject_band(db, subj, CID).get("band")
    return out


set_thr(CID, None, None)
vec_null = band_vec()
set_thr(CID, G_LOW, G_MID)             # explicit, same values as the global
vec_explicit = band_vec()
s.check("NULL-override bands == explicit-global bands over %d subjects" % len(subj_ids),
        vec_null == vec_explicit, {"null": vec_null, "explicit": vec_explicit})
_scored = {k: v for k, v in vec_null.items() if v}
s.check("...and at least some subjects actually have a band (non-vacuous)",
        len(_scored) >= 1, len(_scored))
# Rescaling DOWN to 6.0/12.5 can only move a scored subject the same or UP a band.
set_thr(CID, 6.0, 12.5)
vec_low = band_vec()
_order = {"Low": 0, "Mid": 1, "High": 2}
_never_down = all(_order.get(vec_low.get(k), 0) >= _order.get(vec_null.get(k), 0)
                  for k in _scored)
s.check("lower cutoffs never move a subject DOWN a band", _never_down,
        {k: (vec_null[k], vec_low.get(k)) for k in _scored})
set_thr(CID, None, None)               # leave the fixture as we found it

# ---------------------------------------------------------------------------
s.section("carry-forward -- a new cycle inherits the SOURCE cycle's cutoffs")
# Give the active cycle a rescaled override, then create a new cycle FROM it; the
# create flow copies the source's effective thresholds so the definition
# propagates "from the applied cycle forward".
set_thr(CID, 6.0, 12.5)
C = H.client_as(a, SU["id"])
r = C.post("/admin/cycles", data={
    "action": "create", "csrf_token": "tok",
    "name": "ZZ Carryfwd Test", "code": "ZZ-CF-TEST", "confirm_freeze": "1",
    "source": "empty", "year": "2027", "half": "1"})
s.check("create-cycle succeeded (redirect)", r.status_code in (302, 303), r.status_code)
with a.app.app_context():
    db = a.get_db()
    newrow = db.execute("SELECT * FROM cycles WHERE code='ZZ-CF-TEST'").fetchone()
s.check("the new cycle exists", newrow is not None)
if newrow is not None:
    s.check("...and inherited the source's 6.0/12.5 cutoffs",
            (newrow["low_max"], newrow["mid_max"]) == (6.0, 12.5),
            (newrow["low_max"], newrow["mid_max"]))
    with a.app.app_context():
        tnew = a.thresholds_for_cycle(a.get_db(), newrow["id"])
    s.check("thresholds_for_cycle(new) == the source's", tnew == (6.0, 12.5), tnew)

sys.exit(s.done())
