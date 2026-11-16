"""
Assessor-assignment engine for the Leadership 360 review.

SINCE 2026-10-20 the in-app build (/admin/panels/build) and build_panels_db.py use build_panels_capped (below):
Chris's cap of 4 people a person, the line manager first, then direct reports, then peers in the same BG / BU /
department, the same BU's other departments last. The RULES section here describes build_panels, which only this
file's own Excel CLI still runs.

Reads the HR master Excel (default: the latest Employee List in Downloads), cleans
the population to "confirmed" employees, then builds an up-to-5-person assessor
panel for every confirmed employee per the agreed rules.

RULES
-----
Cleaning (who is assessed vs who may assess):
  SUBJECTS (people who get a panel) must be "confirmed" — Confirmation Date is
  present (when that column exists) OR Years of Service > 1.0.
  ASSESSORS may be ANY active staff member, confirmed or not: unconfirmed staff
  can sit on others' panels, they just don't get a panel of their own.

  Letter-grade people (currently JG 'H' — operators, drivers, promoters, etc.)
  are NEVER assigned as assessors in any role (line manager, direct report or
  peer). They used to be SUBJECTS whose panel held only their line manager.
  NOT ANY MORE (2026-10-28): Grade H is on Grade H Appraisal and takes no part
  in the 360, rated or rating, so load_people() drops every Grade H row before
  any panel is built (is_grade_h, the one rule app.py's gradeh_no360_refusal
  shares). The letter-grade branches below are only reached by another letter
  grade, if one is ever loaded; there is none today.

Panel of up to 5 (in order):
  1. Line manager (the person's Manager). Blank if none / unresolved / letter-grade.
  2-5. Target 2 direct reports + 2 peers, flexing when a pool is short:
       no DR -> 4 peers; no peers -> 4 DR; 1 DR -> 1 DR + 3 peers; etc.
       Whatever can't be filled is left blank (HR fills manually).
       No force-fill outside the rules below — short panels are OK.

Definitions:
  Direct report = any active employee whose Manager is this person.
  Peer (tier 1)  = staff under the SAME line manager AND in the SAME Department.
  Peer (tier 2)  = staff in the SAME Business Group AND SAME Company AND SAME
                   Department, whose Job Grade is NUMERIC and within ±2 of the
                   subject's numeric Job Grade.
  Peer ranking   = both tiers by Years of Service desc, then EID for stability
                   (tier 1 ahead of tier 2). If neither tier fills the peer
                   slots, the panel is left short for HR to complete by hand.
  Direct reports keep their own ranking: longest-staying report first.

Usage:
    python build_assignments.py            # compute + write review Excel + stats
    python build_assignments.py --load     # also load panels into leadership360.db
    python build_assignments.py --source PATH  # override the HR master path
"""
import argparse
import os
import sys
import sqlite3
from collections import defaultdict, deque

import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_HR_FILE = "/path/to/tool List_150626.xlsx"
HR_FILE = DEFAULT_HR_FILE  # may be replaced by --source at runtime
REVIEW_XLSX = os.path.join(HERE, "assessor_assignments_review.xlsx")
DB_PATH = os.path.join(HERE, "leadership360.db")

PANEL_SIZE = 5
TARGET_DR = 2
TARGET_PEER = 2
# Max number of panels one person may sit on AS A PEER. Line managers and
# direct reports are NOT capped (a manager assesses all their reports).
PEER_CAP = 10

# Org-structure corrections applied on top of the HR master (company -> the
# Business Group it should belong to). "PRIVATE Co." is dissolved: most of its
# companies fold into Chin Hin Group Berhad; PP Chin Hin Realty into Chin Hin
# Group Property Berhad.
_CHGB = "CHIN HIN GROUP BERHAD"
_CHGP = "CHIN HIN GROUP PROPERTY BERHAD"
BG_OVERRIDES = {
    "STRADAVERSE SDN BHD": _CHGB,
    "CHL LOGISTIC SDN BHD": _CHGB,
    "PP CHIN HIN GROUP SDN BHD": _CHGB,
    "C & H TRANSPORT SDN BHD": _CHGB,
    "PP CHIN HIN REALTY SDN BHD": _CHGP,
}


# ---------------------------------------------------------------------------
# Load + clean
# ---------------------------------------------------------------------------
def norm_name(s):
    return " ".join(str(s).strip().upper().split()) if s is not None else ""


def to_int_grade(v):
    try:
        return int(float(str(v).strip()))
    except (ValueError, TypeError):
        return -1


def is_grade_h(v):
    """True for Grade H (job grade 'H'): on Grade H Appraisal, never on a 360 panel, rated or rating (Chris, 2026-10-28;
    BUILD-SPEC). THE one rule: app.py's gradeh_no360_refusal and the panel loaders below all ask this."""
    return str(v).strip().upper() == "H" if v is not None else False


def to_float(v):
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def is_empty(v):
    return v is None or (isinstance(v, str) and v.strip() == "")


def load_people():
    wb = openpyxl.load_workbook(HR_FILE, read_only=True, data_only=True)
    ws = wb["Sheet1"]
    rows = ws.iter_rows(values_only=True)
    hdr = list(next(rows))
    ix = {h: i for i, h in enumerate(hdr)}

    def g(r, name):
        i = ix.get(name)
        return r[i] if i is not None else None

    people = {}            # eid -> dict
    by_name = defaultdict(list)
    for r in rows:
        eid = g(r, "Employee ID")
        if is_empty(eid):
            continue
        eid = str(eid).strip()
        if is_grade_h(g(r, "Job Grade")):   # Grade H is on Grade H Appraisal, never on a 360 (2026-10-28)
            continue
        svc = to_float(g(r, "Year(s) of Service"))
        conf = g(r, "Confirmation Date")
        confirmed = (not is_empty(conf)) or (svc is not None and svc > 1.0)
        p = {
            "eid": eid,
            "name": str(g(r, "Employee Name")).strip() if not is_empty(g(r, "Employee Name")) else "",
            "business_group": str(g(r, "Business Group")).strip() if not is_empty(g(r, "Business Group")) else "",
            "company": str(g(r, "Company")).strip() if not is_empty(g(r, "Company")) else "",
            "department": str(g(r, "Department")).strip() if not is_empty(g(r, "Department")) else "",
            "grade": to_int_grade(g(r, "Job Grade")),
            "job_title": str(g(r, "Job Title")).strip() if not is_empty(g(r, "Job Title")) else "",
            "service": svc if svc is not None else 0.0,
            "joined": g(r, "Joined Date"),
            "conf_date": conf,
            "confirmed": confirmed,
            "conf_basis": "date" if not is_empty(conf) else ("service>1" if confirmed else "excluded"),
            "manager_name": str(g(r, "Manager")).strip() if not is_empty(g(r, "Manager")) else "",
            "hod_name": str(g(r, "HOD")).strip() if not is_empty(g(r, "HOD")) else "",
            "manager": None,   # resolved later
        }
        # Apply org-structure correction (company -> corrected Business Group).
        if p["company"] in BG_OVERRIDES:
            p["business_group"] = BG_OVERRIDES[p["company"]]
        people[eid] = p
        if p["name"]:
            by_name[norm_name(p["name"])].append(p)
    wb.close()
    return people, by_name


def resolve_managers(people, by_name):
    """Resolve each person's manager_name -> person, disambiguating duplicate
    names by same Company. Returns count of resolved."""
    resolved = 0
    for p in people.values():
        if not p["manager_name"]:
            continue
        cands = by_name.get(norm_name(p["manager_name"]), [])
        mgr = None
        if len(cands) == 1:
            mgr = cands[0]
        elif len(cands) > 1:
            same_co = [c for c in cands if c["company"] == p["company"]]
            if len(same_co) == 1:
                mgr = same_co[0]
            # else ambiguous -> leave None
        if mgr and mgr["eid"] != p["eid"]:
            p["manager"] = mgr
            resolved += 1
    return resolved


# ---------------------------------------------------------------------------
# Relationships + ranking
# ---------------------------------------------------------------------------
def rank_key(p):
    # longest service first, then higher grade, then stable by eid
    return (-p["service"], -p["grade"], p["eid"])


def dr_rank_key(p):
    # Direct-report ranking: the longest-STAYING report assesses first — they've
    # worked with the manager longest, so the relationship is strongest. Order by
    # years of service desc, then EARLIEST join date, then stable EID. Join date
    # is the key signal when years-of-service isn't recorded (it sorts ascending,
    # so the earliest joiner wins; blanks sort last).
    jd = p.get("joined")
    if hasattr(jd, "strftime"):
        jd = jd.strftime("%Y-%m-%d")
    jd = str(jd) if jd else "9999-99-99"
    return (-p["service"], jd, p["eid"])


def build_panels(people, panel_size=None, target_dr=None, target_peer=None,
                 peer_cap=None, peer_load=None):
    """Build a panel for every confirmed person.

    The keyword arguments all default to this module's constants, so the CLI
    behaves exactly as it always has. They exist for the in-app bulk build,
    which has two needs the CLI does not:

    - the app's panel target is CONFIGURABLE PER CYCLE (panel_target()), and can
      disagree with PANEL_SIZE. Mutating the module global to match would race:
      gunicorn runs --workers 5 --threads 2, so two admins previewing at once
      would corrupt each other's run. Passing it in is the only safe form.
    - `peer_load` can be SEEDED with the panels that already exist, so a top-up
      does not push somebody already sitting on peer_cap panels past it. Left
      unseeded (the CLI) it starts empty, exactly as before.
    """
    panel_size = PANEL_SIZE if panel_size is None else panel_size
    target_dr = TARGET_DR if target_dr is None else target_dr
    target_peer = TARGET_PEER if target_peer is None else target_peer
    peer_cap = PEER_CAP if peer_cap is None else peer_cap
    # SUBJECTS = confirmed only (these get a panel).
    confirmed = {eid: p for eid, p in people.items() if p["confirmed"]}
    # ASSESSOR POOLS draw from ALL active staff (confirmed or not) — unconfirmed
    # staff may assess; they simply don't get a panel of their own.
    reports_of = defaultdict(list)      # manager eid -> their direct reports
    peers_by_mgr = defaultdict(list)    # manager eid -> colleagues (same-manager)
    for p in people.values():
        m = p["manager"]
        if m is not None:
            reports_of[m["eid"]].append(p)
            peers_by_mgr[m["eid"]].append(p)

    # everyone grouped by company (tier-2 peer pool)
    by_company = defaultdict(list)
    for p in people.values():
        by_company[p["company"]].append(p)

    # eid -> how many panels they sit on as a peer. Seeded by the caller for a
    # top-up run; empty for a fresh build.
    peer_load = defaultdict(int, peer_load or {})

    panels = {}
    for eid, s in confirmed.items():
        used = {eid}  # never assign self

        # 1) line manager — may be unconfirmed, but must have a numeric Job Grade
        #    (letter-grade people, e.g. JG 'H', never serve as an assessor).
        lm = s["manager"]
        lm_assessor = None
        if lm is not None and lm["grade"] >= 0:
            lm_assessor = lm
            used.add(lm["eid"])

        # Letter-grade subjects only get rated by their line manager — no
        # direct reports and no peers are assigned to them. Grade H ('H') is
        # no longer one of them: load_people() drops it, since Grade H takes
        # no part in the 360 (2026-10-28), so this branch is not reached for
        # Grade H. Combined with the "grade >= 0" filters in the LM / DR / peer
        # pools below, letter-grade people never appear as an assessor anywhere.
        if s["grade"] < 0:
            chosen = [("line_manager", lm_assessor)] if lm_assessor else []
            if lm_assessor:
                lm_status = "ok"
            elif lm is None:
                lm_status = "no_manager"
            else:
                lm_status = "ineligible_lm_grade"
            panels[eid] = {
                "subject": s, "assessors": chosen,
                "n_dr_avail": 0, "n_peer_avail": 0,
                "lm_status": lm_status,
            }
            continue

        # direct reports of s — letter-grade reports never assess upward.
        drs = [p for p in reports_of.get(eid, [])
               if p["eid"] not in used and p["grade"] >= 0]
        drs.sort(key=dr_rank_key)   # longest-staying report first (service, then join date)

        # peers:
        #   tier 1 = SAME line manager AND SAME Department.
        #   tier 2 = SAME Business Group + SAME Company + SAME Department, with a
        #            numeric Job Grade within ±2 of the subject's grade.
        # Both tiers exclude letter-grade staff. Department is matched on the exact
        # name; if the subject has no department, no peers are auto-assigned. When
        # neither tier fills the peer slots, the panel is left short for HR.
        s_dept = s["department"]
        def same_dept(p):
            return bool(s_dept) and p["department"] == s_dept

        peer_pool = []
        seen = set(used)
        # Tier 1: same line manager + same department.
        if lm is not None:
            for p in peers_by_mgr.get(lm["eid"], []):
                if (p["eid"] not in seen and p["eid"] != eid
                        and p["grade"] >= 0 and same_dept(p)):
                    peer_pool.append(p); seen.add(p["eid"])
        tier1_count = len(peer_pool)
        # Tier 2: same BG + Company + Department + |JG diff| <= 2. Skipped if the
        # subject's own grade is non-numeric.
        s_grade = s["grade"] if s["grade"] >= 0 else None
        if s_grade is not None:
            for p in by_company.get(s["company"], []):
                if p["eid"] in seen:
                    continue
                if not (p["business_group"] == s["business_group"]
                        and p["company"] == s["company"] and same_dept(p)):
                    continue
                if p["grade"] < 0 or abs(p["grade"] - s_grade) > 2:
                    continue
                peer_pool.append(p); seen.add(p["eid"])
        # Rank both tiers by Years of Service desc, EID for stability (tier 1 first).
        t1 = sorted(peer_pool[:tier1_count], key=lambda p: (-p["service"], p["eid"]))
        t2 = sorted(peer_pool[tier1_count:], key=lambda p: (-p["service"], p["eid"]))
        peers = t1 + t2

        # also exclude direct reports from peer list (a DR is not a peer)
        dr_eids = {d["eid"] for d in drs}
        peers = [p for p in peers if p["eid"] not in dr_eids]
        # enforce the per-person peer cap: drop anyone already sitting on
        # PEER_CAP panels as a peer (keeps ranking order otherwise)
        avail_peers = [p for p in peers if peer_load[p["eid"]] < peer_cap]

        # 2-5) allocate 4 slots: target 2 DR + 2 peers, flex
        need = panel_size - 1
        dr_take = min(target_dr, len(drs))
        peer_take = min(target_peer, len(avail_peers))
        remaining = need - (dr_take + peer_take)
        # top up from whichever pool still has surplus (peers first, then DR)
        if remaining > 0:
            extra_peer = min(remaining, len(avail_peers) - peer_take)
            peer_take += extra_peer
            remaining -= extra_peer
        if remaining > 0:
            extra_dr = min(remaining, len(drs) - dr_take)
            dr_take += extra_dr
            remaining -= extra_dr

        chosen = []
        if lm_assessor:
            chosen.append(("line_manager", lm_assessor))
        for d in drs[:dr_take]:
            chosen.append(("direct_report", d))
        for pr in avail_peers[:peer_take]:
            chosen.append(("peer", pr))
            peer_load[pr["eid"]] += 1   # count toward their cap

        panels[eid] = {
            "subject": s,
            "assessors": chosen,
            "n_dr_avail": len(drs),
            "n_peer_avail": len(avail_peers),
            "lm_status": ("ok" if lm_assessor else
                          ("no_manager" if lm is None else "ineligible_lm_grade")),
        }
    return confirmed, panels


# ---------------------------------------------------------------------------
# The capped build (Chris, 2026-10-20): what the in-app build and build_panels_db use
# ---------------------------------------------------------------------------
# The Mid-Year's panels piled up on line managers (one rated 31 people) because a manager rated every report with no
# cap, and peers were picked longest-serving first, so the same seniors filled up first. Chris's rule: "a cap of 4 per
# person: line manager first, then direct reports, then peers in the same BG/BU/department, with the same BU's other
# departments as a last resort". Simulated on production's Year-End roster before he picked it: the most anyone rates
# falls from 24 to 4, panels below the scoring minimum from 169 to 14 (12 of them in a unit with fewer than 3 people
# to ask), and 1,776 of 1,805 panels get 4 or 5 raters.
ASSESSOR_CAP = 4
NO_CAP = 10 ** 9   # cap=None: no maximum, the super admin's choice on 360 Settings › Rules (Chris, 2026-10-23)

# closeness, closest first: LM line manager, DR direct report, PM a peer under the same manager in the same BG / BU /
# department, PD a peer in the same BG / BU / department, PU the same BG / BU in another department (the last resort)
CAPPED_TIERS = ("LM", "MY", "DR", "PM", "PD", "PU")
CAPPED_REL = {"LM": "line_manager", "DR": "direct_report", "PM": "peer", "PD": "peer", "PU": "peer"}
# MY: a rater on their panel in the reference cycle (the year's Mid-Year, which admins had fixed by hand), straight
# after the line manager (Chris, 2026-10-21: "can we prioritize on the mid year panel"); their relationship is today's
# where they're still close, else the one they had (prior_rel)


# what each tier is to the person rated, in an admin's words
CAPPED_TIER_WORDS = {"LM": "Line manager", "MY": "On their Mid-Year panel", "DR": "Direct report", "PM": "Same manager, same department",
                     "PD": "Same department", "PU": "Same unit, another department"}


def index_people(people):
    """The roster grouped the way close_to() looks people up: (reports by manager, by BG + unit + department, by BG +
    unit). Letter grades are left out: they never assess."""
    reports_of, by_dept, by_unit = defaultdict(list), defaultdict(list), defaultdict(list)
    for p in people.values():
        if p["grade"] < 0:
            continue
        if p["manager"] is not None:
            reports_of[p["manager"]["eid"]].append(p)
        by_dept[(p["business_group"], p["company"], p["department"])].append(p)
        by_unit[(p["business_group"], p["company"])].append(p)
    return reports_of, by_dept, by_unit


def close_to(s, idx, skip=()):
    """Everyone close enough to rate `s`, as (tier, person), closest tier first (CAPPED_TIERS). `skip`: employee IDs
    never to offer (on their panel already, or taken off it). The one order the bulk build and a person's own
    suggestions share."""
    reports_of, by_dept, by_unit = idx
    e, lm = s["eid"], s["manager"]
    out, seen = [], {e} | set(skip)
    if lm is not None and lm["grade"] >= 0 and lm["eid"] not in seen:
        out.append(("LM", lm))
    seen.add(lm["eid"] if lm is not None else e)
    if s["grade"] < 0:
        return out                        # another letter-grade subject: their line manager only (Grade H is dropped by the loaders, 2026-10-28)
    for d in reports_of.get(e, ()):
        if d["eid"] not in seen:
            out.append(("DR", d)); seen.add(d["eid"])
    if s["department"]:
        for p in by_dept.get((s["business_group"], s["company"], s["department"]), ()):
            if p["eid"] not in seen:
                out.append(("PM" if lm is not None and p["manager"] is lm else "PD", p)); seen.add(p["eid"])
    for p in by_unit.get((s["business_group"], s["company"]), ()):
        if p["eid"] not in seen:
            out.append(("PU", p)); seen.add(p["eid"])
    return out


def with_prior(s, cand, people, mine, skip=()):
    """`cand` (close_to's list for subject `s`) with their reference-cycle raters `mine` ({assessor eid: relationship})
    moved straight after the line manager as tier MY (Chris, 2026-10-21: "can we prioritize on the mid year panel").
    Only someone still in the roster with a numeric grade, not `s`, not in `skip`, and not their line manager today (the
    LM tier has them). Returns (the new list, {assessor eid: the relationship to write}): today's relationship where they
    are still close, else matrix manager if they were one, else peer. The one place the bulk build and a person's own
    suggestions take it from."""
    if not mine or s["grade"] < 0:
        return cand, {}
    today = {a["eid"]: t for t, a in cand}
    skip = set(skip) | {s["eid"]}
    my, rels = [], {}
    for x in sorted(mine):
        p = people.get(x)
        if p is None or p["grade"] < 0 or x in skip or today.get(x) == "LM":
            continue
        t = today.get(x)
        rels[x] = CAPPED_REL[t] if t else ("matrix_manager" if mine[x] == "matrix_manager" else "peer")
        my.append(("MY", p))
    if not my:
        return cand, {}
    return ([c for c in cand if c[0] == "LM"] + my + [c for c in cand if c[0] != "LM" and c[1]["eid"] not in rels],
            rels)


def grade_gap(a, b):
    """How far apart two people's grades are (9 when either isn't a number): the engine's tie-break."""
    return abs(a["grade"] - b["grade"]) if a["grade"] >= 0 and b["grade"] >= 0 else 9


def build_panels_capped(people, subjects, panel_size, min_valid, cap=ASSESSOR_CAP, existing=None, barred=None,
                        dr_senior_first=True, prior=None):
    """Panels for `subjects` (employee IDs) under Chris's cap: nobody rates more than `cap` people in the cycle.

    people   -- employee ID -> person dict (build_panels_db.load_people's shape). Only a numeric grade assesses.
    existing -- employee ID -> {assessor employee ID: relationship}, every ACTIVE row in the cycle (every subject's,
                not just these): each counts toward its assessor's cap, and a subject's own stay on their panel.
    barred   -- employee ID -> assessor employee IDs never to give them (every row, archived ones included: HR took
                that pairing off on purpose, and the table's UNIQUE would drop a re-add anyway).
    prior    -- employee ID -> {assessor employee ID: relationship}: their panel in the reference cycle. Those raters
                come straight after the line manager (tier MY), whether or not they're still close today.

    How (simulated, then picked by Chris):
    1. The line manager first. A manager rates up to the cap of their reports, those with the fewest other people
       to ask first; never a second line manager.
    2. Round by round, everyone gets ONE more rater a round, those with the fewest options first, until each has
       `min_valid`: the closest tier first (direct reports, then the peer tiers above), and inside a tier whoever
       has the least to do, then the nearest grade; direct reports go highest job grade first (`dr_senior_first`).
    3. A panel still short of `min_valid` looks for a chain of swaps that frees someone for it (an assessor moves to
       another panel where they're just as close). Rows that already exist and line managers never move.
    4. Spare capacity tops panels up to `panel_size` the same way: cover for a form that never comes back.

    Returns {eid: {"subject", "assessors": [(relationship, person)] -- the NEW ones only, "had": rows it already had,
    "n_close": people close enough to ask, "lm_status"}}. Pure: reads its arguments, writes nothing. `cap=None` is no
    maximum: the same order, nobody turned away for their load."""
    cap = NO_CAP if cap is None else cap
    existing = existing or {}
    barred = barred or {}
    load = defaultdict(int)
    for rows in existing.values():
        for aeid in rows:
            load[aeid] += 1

    idx = index_people(people)
    subs = [e for e in subjects if e in people]
    fixed = {e: set(existing.get(e, {})) for e in subs}     # never moved: what exists, and a new line manager
    new = {e: {} for e in subs}                              # movable new picks: assessor eid -> tier
    lm_new = {}

    cand = {e: close_to(people[e], idx, set(barred.get(e, ())) | fixed[e]) for e in subs}
    # who picks first is set by today's closeness alone, so the Mid-Year raters never change which reports a full
    # line manager rates
    order = sorted(subs, key=lambda e: (len(cand[e]), e))   # the fewest options pick first
    prior = prior or {}
    prior_rel = {}                       # (subject, assessor) -> the relationship a MY pick is written with
    for e in subs:
        cand[e], rels = with_prior(people[e], cand[e], people, prior.get(e),
                                   set(barred.get(e, ())) | fixed[e])
        for x, r in rels.items():
            prior_rel[(e, x)] = r
    tier_of = {e: {a["eid"]: t for t, a in cand[e]} for e in subs}

    def size(e):
        return len(fixed[e]) + len(new[e])

    # 1. the line manager first
    wants = defaultdict(list)
    for e in order:
        has_lm = "line_manager" in existing.get(e, {}).values()
        lm = next((a for t, a in cand[e] if t == "LM"), None)
        if lm is not None and not has_lm and size(e) < panel_size:
            wants[lm["eid"]].append(e)
    for m, es in wants.items():
        for e in es[:max(0, cap - load[m])]:
            fixed[e].add(m); lm_new[e] = people[m]; load[m] += 1

    rank = {t: i for i, t in enumerate(CAPPED_TIERS)}

    def best_for(e):
        best = None
        for t, a in cand[e]:
            x = a["eid"]
            if t == "LM" or x in fixed[e] or x in new[e] or load[x] >= cap:
                continue
            # a manager's direct reports in job grade order, highest first, before who has the least to do (Chris,
            # 2026-10-20: "pick from the highest JG to lowest order"; tested on production's roster first: the same
            # 1,774 full panels, the most senior picked for 127 of 197 managers with more reports than slots, was 66)
            senior = -people[x]["grade"] if dr_senior_first and t == "DR" else 0
            k = (rank[t], senior, load[x], grade_gap(people[e], people[x]), x)
            if best is None or k < best[0]:
                best = (k, t, x)
        return best

    users_of = defaultdict(set)           # assessor eid -> subjects they're a movable new pick for

    def fill(target):
        while True:
            moved = False
            for e in order:
                if size(e) >= min(target, panel_size):
                    continue
                b = best_for(e)
                if b:
                    new[e][b[2]] = b[1]; load[b[2]] += 1; users_of[b[2]].add(e); moved = True
            if not moved:
                return

    # 2. everyone to the scoring minimum
    fill(min_valid)

    # 3. chains of swaps for the panels still short
    def augment(s0):
        prev = {}
        q = deque([("s", s0)])
        seen_s, seen_a = {s0}, set()
        while q:
            kind, node = q.popleft()
            if kind == "s":
                for t, a in cand[node]:
                    x = a["eid"]
                    if t == "LM" or x in fixed[node] or x in new[node] or x in seen_a:
                        continue
                    seen_a.add(x)
                    prev[("a", x)] = ("s", node)
                    if load[x] < cap:     # free: walk the chain back to s0, each subject handing its pick down
                        cur = ("a", x)
                        while True:
                            ps = prev[cur]
                            subj, ass = ps[1], cur[1]
                            new[subj][ass] = tier_of[subj][ass]; users_of[ass].add(subj)
                            if subj == s0:
                                load[x] += 1
                                return True
                            pa = prev[ps]
                            old = pa[1]
                            del new[subj][old]; users_of[old].discard(subj)
                            cur = pa
                    q.append(("a", x))
            else:
                for s2 in sorted(users_of[node]):
                    if s2 not in seen_s:
                        seen_s.add(s2)
                        prev[("s", s2)] = ("a", node)
                        q.append(("s", s2))
        return False

    for e in order:
        while size(e) < min(min_valid, panel_size) and augment(e):
            pass

    # 4. spare capacity: up to the full panel
    fill(panel_size)

    panels = {}
    for e in subs:
        s = people[e]
        lm = s["manager"]
        has_lm = e in lm_new or "line_manager" in existing.get(e, {}).values()
        added = ([("line_manager", lm_new[e])] if e in lm_new else []) + [
            (prior_rel[(e, x)] if t == "MY" else CAPPED_REL[t], people[x])
            for x, t in sorted(new[e].items(), key=lambda kv: (rank[kv[1]], kv[0]))]
        panels[e] = {
            "subject": s, "assessors": added, "had": len(existing.get(e, {})),
            "n_close": len(cand[e]) + len(existing.get(e, {})),
            "lm_status": ("ok" if has_lm else "no_manager" if lm is None else
                          "ineligible_lm_grade" if lm["grade"] < 0 or lm["eid"] not in people else
                          "barred" if lm["eid"] in barred.get(e, ()) else "manager_full"),
        }
    return panels


def note_capped(panel, panel_size, min_valid, cap=ASSESSOR_CAP):
    """Why a capped panel ended short, in HR's words."""
    notes = []
    st = panel["lm_status"]
    if st == "no_manager":
        notes.append("no line manager on file")
    elif st == "ineligible_lm_grade":
        notes.append("their line manager isn't in this cycle (grade or left)")
    elif st == "barred":
        notes.append("their line manager was taken off this panel")
    elif st == "manager_full":
        notes.append("their line manager already rates %d people" % cap if cap is not None else
                     "their panel was full before their line manager could join it")
    n = panel["had"] + len(panel["assessors"])
    if n < panel_size:
        close = panel["n_close"]
        if close < min_valid or cap is None:   # with no maximum, only a lack of people leaves a panel short
            notes.append("only %d %s close enough to ask in their unit" % (close, "person" if close == 1 else "people"))
        else:
            notes.append("the people close to them already rate %d each" % cap)
    return "; ".join(notes)


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
def note_for(panel, panel_size=None):
    panel_size = PANEL_SIZE if panel_size is None else panel_size
    s = panel["subject"]
    notes = []
    if panel["lm_status"] == "no_manager":
        notes.append("no manager on file")
    elif panel["lm_status"] == "unresolved":
        notes.append("manager name unresolved: " + s["manager_name"])
    elif panel["lm_status"] == "unconfirmed":
        notes.append("manager not confirmed")
    elif panel["lm_status"] == "ineligible_lm_grade":
        notes.append("manager has non-numeric grade (not an assessor)")
    filled = len(panel["assessors"])
    if filled < panel_size:
        notes.append("filled %d/%d (DR avail %d, peers avail %d)"
                     % (filled, panel_size, panel["n_dr_avail"], panel["n_peer_avail"]))
    return "; ".join(notes)


def write_review(confirmed, panels, excluded_count):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Panels"
    hdr = ["Subject ID", "Subject Name", "Business Group", "Company", "Department",
           "Job Grade", "Years of Service", "Confirmed Basis"]
    for k in range(1, PANEL_SIZE + 1):
        hdr += [f"#{k} Relationship", f"#{k} Emp ID", f"#{k} Name"]
    hdr += ["Filled (n/5)", "Notes"]
    ws.append(hdr)

    for eid in sorted(panels):
        panel = panels[eid]
        s = panel["subject"]
        row = [s["eid"], s["name"], s["business_group"], s["company"], s["department"],
               s["grade"], round(s["service"], 2), s["conf_basis"]]
        slots = panel["assessors"] + [None] * (PANEL_SIZE - len(panel["assessors"]))
        for slot in slots:
            if slot:
                rel, a = slot
                row += [rel, a["eid"], a["name"]]
            else:
                row += ["", "", ""]
        row += [len(panel["assessors"]), note_for(panel)]
        ws.append(row)

    # Summary sheet
    ws2 = wb.create_sheet("Summary")
    full = sum(1 for p in panels.values() if len(p["assessors"]) == 5)
    lm_blank = sum(1 for p in panels.values() if p["lm_status"] != "ok")
    by_fill = defaultdict(int)
    for p in panels.values():
        by_fill[len(p["assessors"])] += 1
    mix = defaultdict(int)
    for p in panels.values():
        nd = sum(1 for rel, _ in p["assessors"] if rel == "direct_report")
        npr = sum(1 for rel, _ in p["assessors"] if rel == "peer")
        mix[(nd, npr)] += 1
    ws2.append(["Metric", "Value"])
    ws2.append(["Confirmed subjects", len(confirmed)])
    ws2.append(["Excluded (not confirmed)", excluded_count])
    ws2.append(["Panels fully filled (5/5)", full])
    ws2.append(["Panels with blank line manager", lm_blank])
    ws2.append([])
    ws2.append(["Filled count", "Panels"])
    for k in sorted(by_fill, reverse=True):
        ws2.append([f"{k}/5", by_fill[k]])
    ws2.append([])
    ws2.append(["DR + Peer mix (excl. LM)", "Panels"])
    for (nd, npr) in sorted(mix, reverse=True):
        ws2.append([f"{nd} DR + {npr} peer", mix[(nd, npr)]])

    wb.save(REVIEW_XLSX)


def print_summary(confirmed, panels, excluded_count, resolved_mgr):
    full = sum(1 for p in panels.values() if len(p["assessors"]) == 5)
    lm_ok = sum(1 for p in panels.values() if p["lm_status"] == "ok")
    by_fill = defaultdict(int)
    for p in panels.values():
        by_fill[len(p["assessors"])] += 1
    print("\n================ ASSIGNMENT SUMMARY ================")
    print(f"Confirmed subjects (each needs 5): {len(confirmed)}")
    print(f"Excluded (not confirmed):          {excluded_count}")
    print(f"Managers resolved by name:         {resolved_mgr}")
    print(f"Panels with a line manager filled: {lm_ok}")
    print(f"Panels fully filled (5/5):         {full}")
    print("\nFill distribution:")
    for k in sorted(by_fill, reverse=True):
        print(f"   {k}/5 : {by_fill[k]}")
    total_slots = len(confirmed) * 5
    filled_slots = sum(len(p["assessors"]) for p in panels.values())
    print(f"\nTotal assessor slots: {total_slots}  filled: {filled_slots}  "
          f"blank: {total_slots - filled_slots}")
    print("===================================================")


def load_into_db(panels):
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    # map employee_id -> users.id
    uid = {r["employee_id"]: r["id"] for r in
           db.execute("SELECT id, employee_id FROM users WHERE employee_id IS NOT NULL")}
    missing = set()
    # clear all existing assignments (fresh real load)
    db.execute("DELETE FROM responses")
    db.execute("DELETE FROM assignments")
    n = 0
    for eid, panel in panels.items():
        if eid not in uid:
            missing.add(eid); continue
        sid = uid[eid]
        for rel, a in panel["assessors"]:
            if a["eid"] not in uid:
                missing.add(a["eid"]); continue
            db.execute(
                "INSERT OR IGNORE INTO assignments(subject_id, assessor_id, relationship) "
                "VALUES (?,?,?)", (sid, uid[a["eid"]], rel))
            n += 1
    db.commit()
    db.close()
    print(f"\nLoaded {n} assignments into {os.path.basename(DB_PATH)}. "
          f"Unmatched employee IDs: {len(missing)}")
    return missing


def main():
    global HR_FILE
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=HR_FILE,
                    help="HR master Excel path (overrides the default).")
    ap.add_argument("--load", action="store_true",
                    help="Also load the computed panels into leadership360.db "
                         "(wipes existing assignments + responses).")
    args = ap.parse_args()
    HR_FILE = args.source
    if not os.path.exists(HR_FILE):
        sys.exit(f"HR file not found: {HR_FILE}")
    people, by_name = load_people()
    resolved = resolve_managers(people, by_name)
    excluded = sum(1 for p in people.values() if not p["confirmed"])
    confirmed, panels = build_panels(people)
    write_review(confirmed, panels, excluded)
    print(f"Wrote review file: {os.path.basename(REVIEW_XLSX)}")
    print_summary(confirmed, panels, excluded, resolved)
    if args.load:
        load_into_db(panels)


if __name__ == "__main__":
    main()
