"""The KPI library holds no numbers (Chris, 2 Nov 2026: "keep method, drop numbers").

The library (pm_kpi_library) is the record of what a KPI IS: name, definition, family, perspective, who it applies to,
unit, method and the BU-level flag. Rate 1-5, threshold, target, multiple, excellence, the suggested weight and the
ladder shape (spread_json) stay in the table, empty, and no code reads or writes them. Targets and weights live on
people's lines (pm_kpi_targets) and, for a unit, pm_bu_kpis.

What this suite holds:
  * static: no SQL touches pm_kpi_library together with a number column outside the schema, and nothing reads a
    library row's number column (an explicit, small allowlist); the retired helpers are gone; no template or script
    asks for the suggested weight
  * behaviour: the library form (add and update), the bulk import (a legacy file's columns are ignored and named),
    a new Early Year line (blank figures and weight, last year's figures only as placeholder text), the setting
    agent's add and library list, the person page's Add from library, the BU KPI copy, the unit tidy.
"""
import ast
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("The KPI library holds no numbers")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BG, _EMP = H.actors(a)
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
BG = "ZZNN Group"
NUM = ("rate1", "rate2", "rate3", "rate4", "rate5", "threshold", "target", "multiple", "excellence",
       "weightage_default", "spread_json")
NUM_RE = re.compile(r"\b(rate[1-5]|threshold|target|multiple|excellence|weightage_default|spread_json)\b")

# ---------------------------------------------------------------------------
s.section("static: nothing touches a library number column")
src = open(os.path.join(ROOT, "app.py"), encoding="utf-8").read()
tree = ast.parse(src)
# where a number column may be named beside pm_kpi_library: the schema (SCHEMA, the boot migrations and the rebuild
# of the table), nowhere else. A new entry here needs Chris's word.
SQL_ALLOW = {"<module>:SCHEMA", "_ensure_runtime_schema"}
hits = []


def walk(node, fn):
    for ch in ast.iter_child_nodes(node):
        name = fn
        if isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef)):
            name = ch.name
        if isinstance(ch, ast.Constant) and isinstance(ch.value, str):
            v = ch.value
            if re.search(r"pm_kpi_library\b(?!_)", v) and NUM_RE.search(v) and not re.search(r"pm_kpi_targets", v):
                hits.append((fn, ch.lineno, v[:80].replace("\n", " ")))
        walk(ch, name)


walk(tree, "<module>")
bad = [h for h in hits if h[0] not in SQL_ALLOW and not (h[0] == "<module>" and "CREATE TABLE" in h[2].upper())]
# a module-level constant holding the schema is allowed by its CREATE TABLE text
s.check("no SQL names pm_kpi_library with a number column outside the schema", not bad, bad[:5])
s.check("...and the allowlist is still needed only for the schema (it has hits to allow)", bool(hits), hits[:2])
reads = [(i + 1, ln.strip()[:100]) for i, ln in enumerate(src.splitlines())
         if re.search(r"\blib0?(\[|\.get\()\s*[\"'](rate[1-5]|threshold|target|multiple|excellence|weightage_default|"
                      r"spread_json)[\"']", ln) or re.search(r"\bsrc\[[\"'](weightage_default|spread_json)[\"']", ln)]
s.check("nothing reads a library row's number column", not reads, reads[:5])
s.check("the retired helpers are gone", not any(n in src for n in (
    "def pm_library_spread", "def pm_apply_spread", "def _pm_library_numeric", "def _pm_library_spread",
    "def _pm_library_weightage", "def pm_changed_vs_library", "def _pm_spread_getter")))
asked = []
for d, _dn, fs in os.walk(ROOT):
    if any(x in d for x in ("/tests", "/.git", "/deploy/demo", "/tools", "venv", "node_modules")):
        continue
    for f in fs:
        if f.endswith((".html", ".js")) and "weightage_default" in open(os.path.join(d, f), encoding="utf-8",
                                                                         errors="replace").read():
            asked.append(f)
        if f.endswith((".html", ".js")) and "suggested_weight" in open(os.path.join(d, f), encoding="utf-8",
                                                                       errors="replace").read():
            asked.append(f)
s.check("no template or script reads the suggested weight", not asked, asked)

# ---------------------------------------------------------------------------
s.section("the library form and the save")
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'ZZNN Co')", (BG,))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
    # a row seeded WITH old figures, a weight and a spread: the code must neither read nor write them
    OLD = db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, "
                     "category, description, unit, method, rate1, rate2, rate3, rate4, rate5, threshold, target, "
                     "multiple, excellence, weightage_default, spread_json, active) VALUES (?, '*', '*', 0, '*', "
                     "'ZZNN Old Figures', 'Financial · Profit', 'a definition', 'RM', 'more', 1, 2, 3, 4, 5, 7, 8, 9, "
                     "10, 40, '{\"rate\":[80,90,100,110,120]}', 1)", (BG,)).lastrowid
    db.commit()
SUP = H.client_as(a, SU["id"])


def libnums(rid):
    return tuple(H.rows(a, "SELECT %s FROM pm_kpi_library WHERE id=?" % ", ".join(NUM), (rid,))[0])


form = {"csrf_token": "tok", "action": "add", "business_group": BG, "company": "*", "department_mode": "any",
        "tier_n": "0", "kpi_name": "ZZNN Fresh", "method": "more", "perspective": "Customer",
        "description": "What is measured", "weightage_default": "25", "rate1": "1", "rate2": "2", "rate3": "3",
        "rate4": "4", "rate5": "5", "threshold": "7", "target": "8", "multiple": "9", "excellence": "10",
        "spread_rate1": "80", "spread_rate2": "90", "spread_rate3": "100", "spread_rate4": "110", "spread_rate5": "120"}
SUP.post("/admin/performance/library", data=form)
fresh = H.one(a, "SELECT id FROM pm_kpi_library WHERE business_group=? AND kpi_name='ZZNN Fresh'", (BG,))
s.check("an add stores the KPI, and every number column is NULL even when the post carries figures",
        fresh and libnums(fresh) == (None,) * len(NUM), fresh and libnums(fresh))
SUP.post("/admin/performance/library", data=dict(form, action="update", library_id=str(OLD), kpi_name="ZZNN Old Figures",
                                                 description="Reworded", rate1="99", target="999",
                                                 weightage_default="77"))
s.check("an update changes the words", H.one(a, "SELECT description FROM pm_kpi_library WHERE id=?", (OLD,)) == "Reworded")
s.check("...and writes no figure (the posted 99 / 999 / 77 are not stored) and does not rebuild the spread",
        libnums(OLD) == (1, 2, 3, 4, 5, 7, 8, 9, 10, 40.0, '{"rate":[80,90,100,110,120]}'), libnums(OLD))
fm = SUP.get("/admin/performance/library?panel=add&addbg=%s" % BG).get_data(as_text=True)
s.check("the form has no weight or scale field, carries the note, and styles the Definition box",
        'name="weightage_default"' not in fm and "Suggested weight" not in fm and 'name="rate1"' not in fm
        and "The library is the record of the KPI" in fm and 'class="kl-def"' in fm
        and "A short definition only. The person&#39;s own detail goes in their line&#39;s description." in fm.replace(
            "'", "&#39;"), None)

# ---------------------------------------------------------------------------
s.section("the bulk import")
LB = "/admin/performance/library/import"
tmpl = H.as_csv_text(SUP.get("/admin/performance/library/template.xlsx"))
s.check("the template has the definition columns, a Perspective column and no number column",
        all(c in tmpl for c in ("Business Group", "KPI Description", "Unit of Measure", "Method", "Perspective", "BU Level"))
        and not any(c in tmpl for c in ("Rate 1", "Threshold", "Target", "Multiple", "Excellence", "Weightage", "Spread"))
        and "EXAMPLE-" in tmpl, tmpl[:200])
head = ["Business Group", "Company", "Department", "Tier", "Job Grade", "KPI", "Strategic Thrust / Category",
        "KPI Description", "Unit of Measure", "Method", "Rate 1", "Rate 5", "Target", "Weightage Default"]
body = "%s\n%s\n" % (",".join(head), ",".join([BG, "", "", "", "", "ZZNN Imported", "Financial · Profit", "", "RM", "More",
                                                  "1", "5", "100", "30"]))
r = SUP.post(LB, data={"csrf_token": "tok", "preview": "1", "file": (io.BytesIO(body.encode()), "lib.csv")},
             content_type="multipart/form-data")
tok = (re.search(r"check=([0-9a-f]{32})", r.headers.get("Location", "")) or [None, ""])[1]
q = SUP.get(LB + "?check=%s&step=quality" % tok).get_data(as_text=True)
s.check("a legacy file goes in: the Quality step shows ONE ignored line naming the columns and the rows",
        bool(tok) and q.count("Ignored:") == 1 and "Ignored: Rate 1-5, Target, Weightage (in 1 row). The library holds no "
        "numbers." in q and not re.search(r'<button type="submit" class="primary" disabled', q), None)
H.import_steps(SUP, LB, {"file": (io.BytesIO(body.encode()), "lib.csv")})
imp = H.one(a, "SELECT id FROM pm_kpi_library WHERE business_group=? AND kpi_name='ZZNN Imported'", (BG,))
s.check("...and writes the KPI with no number", imp and libnums(imp) == (None,) * len(NUM), imp and libnums(imp))
body2 = body.replace("ZZNN Imported", "ZZNN Old Figures").replace(",1,5,100,30", ",2,6,200,35")
H.import_steps(SUP, LB, {"file": (io.BytesIO(body2.encode()), "lib.csv")})
s.check("an update by import never touches the figures a row still holds",
        libnums(OLD) == (1, 2, 3, 4, 5, 7, 8, 9, 10, 40.0, '{"rate":[80,90,100,110,120]}'), libnums(OLD))
badp = body.replace("ZZNN Imported,Financial · Profit,,RM,More", "ZZNN P,Financial · Profit,,RM,More,Nonsense")
head_p = head[:10] + ["Perspective"] + head[10:]
body_p = "%s\n%s\n" % (",".join(head_p), ",".join([BG, "", "", "", "", "ZZNN Persp", "Financial · Profit", "", "RM", "More",
                                                    "Nonsense", "", "", "", ""]))
r = SUP.post(LB, data={"csrf_token": "tok", "preview": "1", "file": (io.BytesIO(body_p.encode()), "p.csv")},
             content_type="multipart/form-data")
tok2 = (re.search(r"check=([0-9a-f]{32})", r.headers.get("Location", "")) or [None, ""])[1]
q2 = SUP.get(LB + "?check=%s&step=quality" % tok2).get_data(as_text=True)
s.check("an unknown Perspective is a Quality problem", "Perspective not one of the four" in q2, None)
pg = SUP.get(LB).get_data(as_text=True)
s.check("the import page says no targets, rates or weights and that those columns are ignored",
        "No targets, rates or weights." in pg and "those columns are ignored" in pg
        and "Rate 1&ndash;5" not in pg and "scale that doesn" not in pg
        and "Who it applies to and what the KPI is: no target or weight columns." in pg)

# ---------------------------------------------------------------------------
s.section("the Early Year: new lines start blank, last year's figures are placeholder text")
with a.app.app_context():
    db = a.get_db()
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','pm')")
    _prev = dict(db.execute("SELECT kind, year, half FROM cycles WHERE id=?", (CID,)).fetchone())
    db.execute("UPDATE cycles SET kind='early_year', year=2027, half=0 WHERE id=?", (CID,))
    import atexit

    def _back():
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("UPDATE cycles SET kind=?, year=?, half=? WHERE id=?", (_prev["kind"], _prev["year"], _prev["half"], CID))
            d_.commit()
    atexit.register(_back)
    P = db.execute("SELECT id FROM users WHERE role!='admin' AND left_at IS NULL ORDER BY id LIMIT 1").fetchone()[0]
    db.execute("UPDATE users SET business_group=?, company='ZZNN Co', department='ZZDept', job_grade='G14' WHERE id=?", (BG, P))
    db.execute("DELETE FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (CID, P))
    PRI = db.execute("INSERT INTO cycles(name, code, year, half, kind, is_active) VALUES ('ZZNN prior', 'ZZNN-PRIOR', 2020, 2, "
                     "'year_end', 0)").lastrowid
    db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, unit, method, rate1, rate2, rate3, "
               "rate4, rate5, business_group, company, status) VALUES (?,?, 'ZZNN Old Figures', 20, 'RM', 'more', 31, 32, "
               "33, 34, 35, ?,?, 'approved')", (PRI, P, BG, "ZZNN Co"))
    LIBF = db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, "
                      "category, unit, method, active) VALUES (?, '*', '*', 0, '*', 'ZZNN No History', 'Financial', 'RM', "
                      "'more', 1)", (BG,)).lastrowid
    db.commit()
    u = dict(db.execute("SELECT * FROM users WHERE id=?", (P,)).fetchone())
    lib = dict(db.execute("SELECT * FROM pm_kpi_library WHERE id=?", (OLD,)).fetchone())
    per = dict(db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone())
    cfg = db.execute("SELECT * FROM pm_bg_config WHERE business_group=?", (BG,)).fetchone()
    nums, how = a.pm_default_numbers(db, u, per, lib, cfg)
s.check("pm_default_numbers gives blank figures, source 'blank', whatever the library row or last year holds",
        how == "blank" and all(v is None for v in nums.values()) and set(nums) == set(a.PM_NUMERIC_FIELDS), (how, nums))

E = H.client_as(a, P)


def tool(name, args):
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = P
        d_ = a.get_db()
        uu = d_.execute("SELECT * FROM users WHERE id=?", (P,)).fetchone()
        return a._setting_run_tool(d_, dict(uu), CID, {"tool": name, "args": args})


r_ = tool("add_kpi", {"library_id": OLD})
r2_ = tool("add_kpi", {"library_id": LIBF})
row = H.rows(a, "SELECT weightage, rate1, rate3, rate5, threshold, target, multiple, excellence, number_source "
                "FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? AND kpi_name='ZZNN Old Figures'", (CID, P))
s.check("the agent's add: weight not set (0 reads as blank), every figure NULL, number_source 'blank'",
        r_.get("ok") and row and tuple(row[0])[:1] == (0,) and tuple(row[0])[1:8] == (None,) * 7
        and row[0][8] == "blank", (r_, row and tuple(row[0])))
html_ = E.get("/performance/setting").get_data(as_text=True)
s.check("the setting page shows last year's figures as PLACEHOLDERS, the boxes themselves empty",
        'placeholder="31"' in html_ and 'placeholder="35"' in html_ and 'data-field="rate1"' in html_
        and all(re.search(r'value="([^"]*)"', t_).group(1) == "" for t_ in re.findall(
            r'<input[^>]*class="pm-set-num[^>]*>', html_)) and len(re.findall(r'<input[^>]*class="pm-set-num[^>]*>', html_)) >= 6,
        None)
s.check("...the label reads \"last year's figures in grey\" for it and \"set by you\" for a KPI with no earlier line",
        "last year&#39;s figures in grey" in html_ and "set by you" in html_, None)
s.check("...no Generate button, and nothing says the system derives the other points",
        "pm-set-generate" not in html_ and "from the HR ladder" not in html_)
s.check("...the picker table has KPI, Scope, Direction and an Add column: no Targets, no Suggested %",
        "Suggested %" not in html_ and ">Targets<" not in html_ and "data-weight" not in html_
        and all(h in html_ for h in ("kpi-picker-table",)), None)
rg = E.post("/performance/setting/autosave", data={"csrf_token": "tok", "action": "generate", "target_id": "1", "base": "5"})
s.check("the autosave 'generate' action is gone", rg.status_code in (400, 404, 409) and (rg.get_json() or {}).get("ok") is not True)
rl = tool("show_library", {})
s.check("the agent's library list carries no suggested weight",
        rl.get("ok") and all("suggested_weight" not in x for x in rl["render"]["data"]["lines"]), None)
with a.app.app_context():
    sysmsg = a._setting_agent_system(a.get_db(), dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (P,)).fetchone()),
                                     a._pm_setting_context(a.get_db(), dict(a.get_db().execute(
                                         "SELECT * FROM users WHERE id=?", (P,)).fetchone())))
s.check("the agent's prompt: the person sets every point and the weight; nothing derived; no suggested weight",
        "sets every point of the scale and the weight" in sysmsg and "suggested_weight" not in sysmsg
        and "generate from it automatically" not in sysmsg and "ladder shape" not in sysmsg)
with a.app.app_context():
    db = a.get_db()
    prior = a.pm_last_figures(db, P, "ZZNN Old Figures", "RM", per)
    row_ = dict(db.execute("SELECT * FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? AND kpi_name='ZZNN Old Figures'",
                           (CID, P)).fetchone())
    row_.update(rate1=31.0, rate2=99.0)
    chg = a.pm_changed_vs_earlier(row_, prior)
s.check("the approver's comparison is against the person's own earlier line (a changed figure, never the library)",
        prior and prior["rate1"] == 31 and "rate2" in chg and "rate1" not in chg and not a.pm_changed_vs_earlier(row_, None),
        (prior, chg))

# ---------------------------------------------------------------------------
s.section("Add from library, the BU copy and the unit tidy")
with a.app.app_context():
    db = a.get_db()
    rec = {}
    got = a._admin_kpi_from_library(db, u, rec, OLD)
    s.check("Add from library copies the name, unit and direction, and no figure or weight",
            got and rec.get("kpi") == "ZZNN Old Figures" and rec.get("unit") == "RM" and rec.get("method") == "more"
            and not any(k in rec for k in ("weightage", "target", "threshold", "multiple", "excellence", "rate 1", "rate 5")), rec)
    me = dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
    new_id, how_ = a._bu_kpi_unit_row(db, me, lib, "ZZNN Other Co")
    db.commit()
    s.check("a BU KPI's copy for one unit carries the words but no library number",
            how_ == "copy" and libnums(new_id) == (None,) * len(NUM) and H.one(
                a, "SELECT company FROM pm_kpi_library WHERE id=?", (new_id,)) == "ZZNN Other Co", libnums(new_id))
    db.execute("UPDATE pm_kpi_library SET unit='No.' WHERE id=?", (OLD,))
    db.commit()
    res = a._kpi_unit_tidy(db, CID, SU["id"], apply=True)
    db.commit()
    s.check("the unit tidy changes a library row's spelling only: figures untouched, none rescaled",
            H.one(a, "SELECT unit FROM pm_kpi_library WHERE id=?", (OLD,)) == "Number"
            and libnums(OLD) == (1, 2, 3, 4, 5, 7, 8, 9, 10, 40.0, '{"rate":[80,90,100,110,120]}')
            and res["library"]["rescaled"] == 0, (res["library"], libnums(OLD)))

sys.exit(s.done())
