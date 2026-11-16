"""The 360 Feedback settings cards redrawn from the canvas (2026-10-27): Panel rules, Assessor correction, Weighting and
Potential bands. What it holds: the Panel rules card carries the ACTIVE cycle's own-rules fold, which posts to the All
cycles page's set_rules / clear_rules handler and comes back to the settings page (`next`); with no active cycle the fold
and the status line are gone; the card's "also" link is gone; the weighting card reads the LIVE common split (never a
hardcoded 40 : 60) and starts "Same split for every grade" on it; the Assessor correction inputs stay enabled (a disabled
input isn't posted); the potential bar renders its bands. Settings it changes are put back."""
import html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("360 settings cards: rules fold, weighting split, assessor correction, potential bar")
SU, BGA, EMP = H.actors(a)
sup = H.client_as(a, SU["id"])
NEXT = "/admin/m/f360/settings#rules"


def page():
    return html.unescape(sup.get("/admin/m/f360/settings").get_data(as_text=True))


def post(url, **f):
    d = {"csrf_token": "tok"}
    d.update(f)
    return sup.post(url, data=d)


with a.app.test_request_context("/"):
    db = a.get_db()
    CYC = dict(a.active_cycle(db))
    CID = CYC["id"]
    RULES0 = (CYC["panel_size"], CYC["assessor_cap"], CYC["min_valid"], CYC["tiers_json"])
    BW0 = [tuple(r) for r in db.execute("SELECT job_grade, w_360, w_tech FROM tc_band_weights")]
    TIERS = a.default_tiers()
try:
    tiers = {}
    for t in TIERS:
        tiers["tier%d_min" % t["n"]] = str(t["min"])
        tiers["tier%d_max" % t["n"]] = str(t["max"])
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE cycles SET panel_size=NULL, assessor_cap=NULL, min_valid=NULL, tiers_json=NULL WHERE id=?", (CID,))
        d.commit()

    s.section("Panel rules: the active cycle's fold")
    p = page()
    s.check("the fold is on the card", 'id="rules-own"' in p and 'value="set_rules"' in p and "Save for this cycle" in p)
    s.check("a cycle on the defaults: the status line says so and the fold starts shut",
            CYC["name"] in p and "follows these default rules." in p and not re.search(r'<details class="rl-own" id="rules-own" open', p))
    s.check("the default form reads Save default rules", "Save default rules" in p)
    s.check("no Back to the default rules while it has none", "Back to the default rules" not in p)
    s.check("the card's 'set a different rule for one cycle' link is gone", "Set a different rule for one cycle" not in p)
    s.check("all four bands are in the default form", all(('name="tier%d_min"' % n) in p for n in (1, 2, 3, 4)))

    s.section("the override posts from the settings page and returns to it")
    r = post("/admin/cycles", action="set_rules", cycle_id=str(CID), panel_size="none", assessor_cap="none",
             min_valid="3", next=NEXT, **tiers)
    s.check("redirected back to the card", r.status_code in (301, 302) and r.headers["Location"].endswith(NEXT), r.headers.get("Location"))
    stored = H.one(a, "SELECT panel_size || ',' || assessor_cap || ',' || min_valid FROM cycles WHERE id=?", (CID,))
    s.check("stored on the cycle", stored == "0,0,3", stored)
    p = page()
    s.check("the status line says it has its own rules", "has its own rules." in p)
    s.check("the fold is open and offers Back to the default rules",
            re.search(r'<details class="rl-own" id="rules-own" open', p) and "Back to the default rules" in p)
    s.check("the fold shows the cycle's own number", re.search(r'id="rl-omv"[^>]*value="3"', p) is not None)
    bad = dict(tiers)
    bad["tier2_min"] = bad["tier1_min"]
    r = post("/admin/cycles", action="set_rules", cycle_id=str(CID), panel_size="none", assessor_cap="none",
             min_valid="3", next=NEXT, **bad)
    s.check("a refused save also comes back to the card",
            r.status_code in (301, 302) and r.headers["Location"].endswith(NEXT), r.headers.get("Location"))
    r = post("/admin/cycles", action="clear_rules", cycle_id=str(CID), next=NEXT)
    s.check("Back to the default rules returns to the card", r.headers["Location"].endswith(NEXT))
    s.check("...and the cycle follows the defaults again",
            H.one(a, "SELECT COUNT(*) FROM cycles WHERE id=? AND panel_size IS NULL AND min_valid IS NULL AND tiers_json IS NULL",
                  (CID,)) == 1)
    r = post("/admin/cycles", action="set_rules", cycle_id=str(CID), panel_size="none", assessor_cap="none", min_valid="3", **tiers)
    s.check("without a next the old page is still where it goes", r.headers["Location"].endswith("/admin/cycles"))
    post("/admin/cycles", action="clear_rules", cycle_id=str(CID))

    s.section("no active cycle: no fold, no status line (falsifies the guard)")
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE cycles SET is_active=0 WHERE id=?", (CID,))
        d.commit()
    try:
        p = page()
        s.check("the fold is hidden", 'id="rules-own"' not in p and "rl-status" not in p)
        s.check("the default form is still there", "Save default rules" in p)
    finally:
        with a.app.app_context():
            d = a.get_db()
            d.execute("UPDATE cycles SET is_active=1 WHERE id=?", (CID,))
            d.commit()

    s.section("Weighting reads the live split")
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE tc_band_weights SET w_360=50, w_tech=50")
        d.commit()
    p = page()
    s.check("one split for every grade: said as it is", "Now <b>50 : 50 for every grade</b>" in p)
    s.check("...never the hardcoded 40 / 60", "<b>40&nbsp;%</b>" not in p and "40 : 60" not in p and "40&nbsp;:&nbsp;60" not in p)
    s.check("the same-split input starts on it", re.search(r'id="bw-all-in"[^>]*value="50"', p) is not None)
    s.check("grade tiles, one input per grade, names kept",
            p.count('class="bw-tile"') == len(BW0) and p.count('class="bw-input"') == len(BW0) and 'name="w360_%s"' % BW0[0][0] in p)
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE tc_band_weights SET w_360=30, w_tech=70 WHERE job_grade=?", (BW0[0][0],))
        d.commit()
    p = page()
    s.check("a split that differs by grade is said so", "The split differs by grade." in p and "for every grade</b>" not in p)
    s.check("...and the same-split input starts at 50", re.search(r'id="bw-all-in"[^>]*value="50"', p) is not None)

    s.section("Assessor correction and Potential bands")
    p = page()
    s.check("both points inputs stay enabled so they are posted",
            re.search(r'name="extremes_bonus_points"[^>]*disabled', p) is None and
            re.search(r'name="extremes_penalty_points"[^>]*disabled', p) is None)
    s.check("the switch has its On / Off tag and the two boxes",
            'id="ex-tag"' in p and "Always said No: bonus points" in p and "Always said Yes: penalty points" in p)
    s.check("the potential bar has its three bands and two cutoffs",
            'data-seg="low"' in p and 'data-seg="high"' in p and 'data-pc-in="low"' in p and "Save for this cycle" in p
            and "Mid ends at, High above" in p)
finally:
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE cycles SET panel_size=?, assessor_cap=?, min_valid=?, tiers_json=?, is_active=1 WHERE id=?", RULES0 + (CID,))
        for jg, w3, wt in BW0:
            d.execute("UPDATE tc_band_weights SET w_360=?, w_tech=? WHERE job_grade=?", (w3, wt, jg))
        d.execute("DELETE FROM activity_log WHERE action='cycle' AND (detail LIKE 'Set rule override for%' "
                  "OR detail LIKE 'Cleared rule override for%') AND created_at >= datetime('now', '-1 hour')")
        d.commit()

sys.exit(s.done())
