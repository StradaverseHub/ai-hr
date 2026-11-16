"""The "No KPI lines" / "No 360" tag on the leaders' views (Chris, 2026-11-02: "add a tag for those confirmed but with no
KPI / 360", so the HOD, BU CEO and BG CEO band them on purpose).

A person taking part in the cycle with no KPI lines (no pm_kpi_targets rows) has no performance figure; with no live 360
panel (no assignments row, archived=0, as the subject) no potential score. Their leaders' rows carry `nodata`: "kpi",
"360" or "both", absent for everyone else. no_data_ids reads it in TWO queries; Grade H is never "360" (they are on no
panel, and are no participant), nor is a newly confirmed person (joins with a Confirmation rating and no 360 by design).
The field reaches the HOD's Department Review (both axes), the BU CEO's view and the BG CEO's Talent Box, and the client
draws it beside Newly confirmed. Everything here is synthetic (ZZND-*) and removed at the end.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("No KPI lines / No 360 tag on the leaders' views")
assert "onehr-tests" in a.DB_PATH, a.DB_PATH
a._hod_review_holders = lambda db: set()   # as test_confirmation_add: the fixture's BU CEO is also the HOD
SU, BGA, _E = H.actors(a)
GA = "ZZND Agroup"
UN = GA + " Unit"


def cleanup(db):
    db.execute("DELETE FROM buceo_seats WHERE business_group=?", (GA,))
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZND-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM rating_records WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM pm_review_session WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (GA,))
    db.commit()


CYC0 = {}
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    cleanup(db)
    CYC = dict(a.active_cycle(db))
    CID = CYC["id"]
    CYC0 = {"min_job_grade": CYC.get("min_job_grade"), "half": CYC.get("half")}
    db.execute("UPDATE cycles SET min_job_grade=NULL, half=2 WHERE id=?", (CID,))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'A', NULL)", (GA,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, name, grade="13", hod=None, _db=None, **kw):
        db_ = _db or db
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=hod, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=GA, company=UN,
                 department="ZZND Dept", job_grade=grade, confirmation_date=None, years_of_service=0.4, left_at=None,
                 is_demo=0, role="user")
        v.update(kw)
        db_.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        return db_.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
    LM = mk("ZZND-LM", "ZZ ND Manager")
    P_OK = mk("ZZND-OK", "ZZ ND Okay", hod=LM)        # KPI lines and a live panel: no tag
    P_KPI = mk("ZZND-K", "ZZ ND Kilo", hod=LM)        # a panel, no KPI lines
    P_360 = mk("ZZND-T", "ZZ ND Tango", hod=LM)       # KPI lines, no panel
    P_BOTH = mk("ZZND-B", "ZZ ND Bravo", hod=LM)      # neither
    P_ARCH = mk("ZZND-X", "ZZ ND Xray", hod=LM)       # KPI lines; the only panel row is archived: no live panel
    P_NEW = mk("ZZND-N", "ZZ ND November", hod=LM)    # newly confirmed, with its Confirmation line: never "360"
    P_NEWK = mk("ZZND-M", "ZZ ND Mike", hod=LM)       # newly confirmed with NO line at all: "kpi" only, never "360"
    P_H = mk("ZZND-H", "ZZ ND Hotel", grade="H", hod=LM)   # Grade H: no panel by rule, never tagged
    for u_ in (P_OK, P_KPI, P_360, P_BOTH, P_ARCH, P_NEW, P_NEWK, P_H):
        db.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode, via) VALUES (?,?,'add',?)",
                   (CID, u_, "confirmation" if u_ in (P_NEW, P_NEWK) else None))

    def line(uid):
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, "
                   "rate4, rate5, business_group) VALUES (?,?,?,100,'more',1,2,3,4,5,?)", (CID, uid, "ZZND line", GA))

    def panel(uid, archived=0):
        db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, archived) VALUES "
                   "(?,?,?,'peer',?)", (CID, uid, LM, archived))
    for u_ in (P_OK, P_360, P_ARCH, P_NEW):
        line(u_)
    for u_ in (P_OK, P_KPI):
        panel(u_)
    panel(P_ARCH, archived=1)
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id, assigned_at) VALUES (?,?,?,datetime('now'))",
               (GA, UN, LM))
    db.commit()
ALL = [P_OK, P_KPI, P_360, P_BOTH, P_ARCH, P_NEW, P_NEWK, P_H]


class Counter:
    """Counts the SQL statements a block runs (the helper must stay a fixed number of reads, never one per person)."""
    def __init__(self, db):
        self.db, self.n = db, 0

    def __enter__(self):
        self.db.set_trace_callback(lambda _q: setattr(self, "n", self.n + 1))
        return self

    def __exit__(self, *e):
        self.db.set_trace_callback(None)


try:
    s.section("the helper: two reads, the right sets")
    with a.app.test_request_context("/"):
        d = a.get_db()
        with Counter(d) as cnt:
            no_kpi, no_360 = a.no_data_ids(d, CID)
        nm = a.nodata_map(d, CID, ALL)
        nm1 = a.nodata_map(d, CID, [P_OK])
        nm_none = a.nodata_map(d, None, ALL)
        n_small = None
        with Counter(d) as c2:
            a.no_data_ids(d, CID)
        n_small = c2.n
        # more people must not cost more reads
        extra = []
        for i in range(12):
            extra.append(mk("ZZND-E%d" % i, "ZZ ND Extra %d" % i, hod=LM, _db=d))
            d.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,'add')", (CID, extra[-1]))
        with Counter(d) as c3:
            a.no_data_ids(d, CID)
        d.commit()
    s.check("two statements, however many people (%d vs %d)" % (n_small, c3.n), cnt.n == 2 and c3.n == 2, (cnt.n, c3.n))
    s.check("no KPI lines: the ones with none (a newly confirmed person with no line included)",
            {P_KPI, P_BOTH, P_NEWK} <= no_kpi and not ({P_OK, P_360, P_ARCH, P_NEW, P_H} & no_kpi), no_kpi)
    s.check("no 360: no live panel (an archived row is no panel)", {P_360, P_BOTH, P_ARCH} <= no_360
            and not ({P_OK, P_KPI} & no_360), no_360)
    s.check("Grade H is never in no_360 (nor is any participant of theirs: they are on no panel by rule)",
            P_H not in no_360 and P_H not in no_kpi, (P_H in no_360, P_H in no_kpi))
    s.check("a newly confirmed person is never in no_360, with a line or without", P_NEW not in no_360
            and P_NEWK not in no_360, (P_NEW in no_360, P_NEWK in no_360))
    s.check("the field: someone with lines and a panel gets none; no lines -> kpi; no panel -> 360; both -> both",
            P_OK not in nm and nm.get(P_KPI) == "kpi" and nm.get(P_360) == "360" and nm.get(P_BOTH) == "both"
            and nm.get(P_ARCH) == "360", nm)
    s.check("newly confirmed: 'kpi' with no line, nothing with one; Grade H: nothing",
            nm.get(P_NEWK) == "kpi" and P_NEW not in nm and P_H not in nm, nm)
    s.check("only the view's own people (ids), and nothing for no cycle", set(nm1) == set() and nm_none == {},
            (nm1, nm_none))
    with a.app.test_request_context("/"):
        d = a.get_db()
        s.check("a left person is nobody's tag", (d.execute("UPDATE users SET left_at='2026-01-01' WHERE id=?", (P_BOTH,)),
                                                  P_BOTH not in a.nodata_map(d, CID, ALL))[1])
        d.execute("UPDATE users SET left_at=NULL WHERE id=?", (P_BOTH,))
        # falsify: give P_KPI a KPI line, P_360 a panel: the tags go
        d.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, rate4, "
                  "rate5, business_group) VALUES (?,?,?,100,'more',1,2,3,4,5,?)", (CID, P_KPI, "ZZND late line", GA))
        d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship) VALUES (?,?,?,'peer')",
                  (CID, P_360, LM))
        nm2 = a.nodata_map(d, CID, ALL)
        d.execute("DELETE FROM pm_kpi_targets WHERE kpi_name='ZZND late line'")
        d.execute("DELETE FROM assignments WHERE subject_id=? AND assessor_id=?", (P_360, LM))
        d.commit()
    s.check("falsified: add the line / the panel and the tag goes (KPI -> none, 360 -> none)",
            P_KPI not in nm2 and P_360 not in nm2 and nm2.get(P_BOTH) == "both", nm2)

    s.section("the leaders' rows carry it: HOD (both axes), BU CEO (both axes), BG CEO's Talent Box")
    EXP = {P_KPI: "kpi", P_360: "360", P_BOTH: "both", P_ARCH: "360", P_NEWK: "kpi"}
    with a.app.test_request_context("/"):
        d = a.get_db()
        lm = dict(d.execute("SELECT * FROM users WHERE id=?", (LM,)).fetchone())
        hctx = a._pm_calib_resolve(d, lm, "hod", hod_id=LM)
        hpm = {r["id"]: r for r in a._pm_calib_assist_overview(d, lm, hctx, "hod", {"hod_id": LM})["data"]["rows"]}
        hpot = {r["id"]: r for r in a._pot_calib_overview(d, lm, a._pot_calib_sc(d, CID, "hod", LM,
                                                                                  hctx["population"]))["rows"]}
        bkw = {"bg": GA, "company": UN}
        bctx = a._pm_calib_resolve(d, lm, "buceo", **bkw)
        bpm = {r["id"]: r for r in a._pm_calib_assist_overview(d, lm, bctx, "buceo", bkw)["data"]["rows"]}
        bpot = {r["id"]: r for r in a._pot_calib_overview(d, lm, a._pot_calib_sc(d, CID, "buceo", (GA, UN),
                                                                                  bctx["population"]))["rows"]}
        su = d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        gctx = a._talent_box_resolve(d, su, "bgceo", admin_view=True, bg=GA)
        tb = a._journey_talent_box_overview(d, su, ("bgceo", {"bg": GA}, gctx), company=UN, all_filters=True)
    tbp = {}
    for c in (tb or {}).get("cells") or []:
        for p in c["people"]:
            tbp[p["id"]] = p
    for label, rows in (("HOD, performance", hpm), ("HOD, potential", hpot), ("BU CEO, performance", bpm),
                        ("BU CEO, potential", bpot), ("BG CEO's Talent Box", tbp)):
        got = {k: v.get("nodata") for k, v in rows.items() if k in ALL}
        # the HOD's and BU CEO's tables list only people with KPI lines (today's rule), so "kpi" / "both" show on the Talent
        # Box; the "360" ones show everywhere
        need = (P_360, P_ARCH) if rows is not tbp else (P_KPI, P_360, P_BOTH, P_ARCH, P_NEWK)
        s.check("%s: the tag reaches the row (%d of the fixture's people on view)" % (label, len(got)),
                all(k in got for k in need) and all(got.get(k) == EXP[k] for k in need)
                and all(got.get(k) == v for k, v in EXP.items() if k in got), got)
        s.check("%s: someone with lines and a panel, a newly confirmed one with a line, Grade H: no tag" % label,
                all(not rows[k].get("nodata") for k in (P_OK, P_NEW, P_H) if k in rows), {k: rows[k].get("nodata") for k in rows if k in ALL})
        s.check("%s: 'nodata' is only ever kpi / 360 / both when present" % label,
                all(v.get("nodata") in (None, "kpi", "360", "both") for v in rows.values()))
    s.check("the Talent Box's people include the tagged ones (the box places them at the default band)",
            all(k in tbp for k in (P_KPI, P_360, P_BOTH)), sorted(tbp))

    s.section("the client and the words")
    jsd = open(os.path.join(H.REPO, "static", "journey_chat.js"), encoding="utf-8").read()
    atb = open(os.path.join(H.REPO, "static", "admin_talent_box.js"), encoding="utf-8").read()
    css = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
    for words in ("No KPI \\u00b7 No 360", "No KPI lines", "No 360"):
        s.check("the words %r are drawn in the journey and the classic page" % words, words in jsd and words in atb)
    s.check("the title sentences are in both",
            all(t in jsd and t in atb for t in (
                "Taking part this cycle with no KPI lines, so no performance figure: set their performance band yourself",
                "Taking part this cycle with no 360 panel, so no potential score: set their potential band yourself")))
    s.check("the journey draws it in the table's tag line, the Talent Box List view's name line and the classic page",
            "var ndTag = !!r.nodata" in jsd and "if (ndTag) ps.appendChild(nodataTag(r.nodata));" in jsd
            and "if (p.nodata && !tagBelow) ln.appendChild(nodataTag(p.nodata));" in jsd and "function nodataEl(kind)" in atb)
    s.check("the panel row (journey and classic): the tag takes the place of the default words, never also on the second line",
            "if (p.nodata) who.appendChild(nodataTag(p.nodata));\n    else if (dt) who.appendChild(rmkEl(\"span\", \"rv-tbox-ptag is-default\", dt));" in jsd
            and "if (p.nodata) sub.appendChild" not in jsd
            and "if (p.nodata) who.appendChild(nodataEl(p.nodata));" in atb and "else if (dt) who.appendChild(el(" in atb
            and "if (p.nodata) {" not in atb)
    s.check("the HOD's potential note: 'Not finalised \u00b7 ' then the tag in place of 'Low by default'; not also on the name line",
            "if (r.nodata) nfs.appendChild(nodataTag(r.nodata)); else nfs.appendChild(document.createTextNode(\"Low by default\"));" in jsd
            and "!(review && pot && r.pot_final === false && r.band_default)" in jsd)
    s.check("everyone else keeps the default words exactly (the word builders are untouched)",
            'a.push((p.perf || "UA") + " by default")' in jsd and 'return a.length ? a.join(", ") + " \u2014 no record yet" : "";' in jsd.replace("—", "\u2014"))
    s.check("after Newly confirmed / LM on their behalf and before Last viewed",
            jsd.index("if (obTag) ps.appendChild(behalfTag());") < jsd.index("if (ndTag) ps.appendChild")
            < jsd.index('if (lastTag) ps.appendChild(rmkEl("span", "rv-tbox-lasttag"'))
    m = re.search(r"\.rv-cal-notetag\.rv-nodata \{([^}]*)\}", css)
    s.check("amber, the pair behind .rv-calib-flag-disputed (tokens, never a hex, never the PIP tones)",
            m and "var(--d-bg-fdf0e2)" in m.group(1) and "var(--warn-ink)" in m.group(1) and "#" not in m.group(1)
            and "fcefe5" not in m.group(1).lower() and "7f370a" not in m.group(1).lower(), m and m.group(1))
    src = open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read()
    s.check("every view that tags Newly confirmed also hands over nodata (4 row builders, the person card, the slim row)",
            src.count("**_nd_kw(nodata, r[\"user\"][\"id\"])") == 3 and "_nd_kw(nodata_map(db, ctx[\"period\"][\"id\"], [subj[\"id\"]])" in src
            and '**({"nodata": p["nodata"]} if p.get("nodata") else {})' in src)
    s.check("the agents know: a KB row by slug and Help's answer",
            "no-kpi-no-360-tag" in src and "No KPI lines, No 360 or both" in a.HELP_QA["newly"][1]
            and "no-kpi-no-360-tag" in open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read())
    s.check("Help's lists still hold their cap", all(len(v[1]) <= a.HELP_LIST_MAX for v in a.HELP_LISTS.values()))
    words = " ".join((a.NODATA_WORDS[k] + a.NODATA_TITLES[k]) for k in a.NODATA_WORDS)
    s.check("the words name no one", "ZZ" not in words and "ZZND" not in words)
finally:
    with a.app.test_request_context("/"):
        db = a.get_db()
        cleanup(db)
        db.execute("UPDATE cycles SET min_job_grade=?, half=? WHERE id=?", (CYC0.get("min_job_grade"), CYC0.get("half"), CID))
        db.commit()
sys.exit(s.done())
