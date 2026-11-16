"""When a person's own words explain a KPI result (2026-10-24, the AI+ flow check): the line manager's "Are their results
justified?" floor read a KPI as explained only when the overall remark carried its FULL name, so "gross profit" in a
remark missed "Gross profit (GP)" and the manager read "below target with no context given". 1,663 of production's 7,700
Year-End lines carry a bracket and 5,515 run to four words or more.

What this suite holds (_pm_perf_explained):
  * a note on the line, or the full name, still count;
  * the short form in brackets counts as a word ("GP", "PAT"), case kept, so "pat" in a sentence doesn't;
  * the name in plain words counts: its own words without a code in front, its Focus or brackets, all of a short name or
    at least two of a longer one and half of them, a word matching by its first five letters ("collections");
  * a remark about one KPI doesn't explain another that only shares a word with it.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Their words explain a KPI: the remark in plain words, not only the KPI's full name")
f = a._pm_perf_explained
R = ("This year I grew gross profit to RM 12.4 mil by renegotiating two supplier contracts. Collections improved "
     "after weekly calls with the big dealers, and our GP held through the second quarter's price spike.")

s.section("as before")
s.check("a note on the line counts, whatever the remark", f({"kpi": "Overdue debt", "note": "One dealer paid late."}, ""))
s.check("no remark, no note: not explained", not f({"kpi": "Gross profit"}, ""))
s.check("the full name in the remark counts", f({"kpi": "gross profit"}, R))

s.section("the name in plain words")
s.check("'Gross profit (GP)' from 'gross profit'", f({"kpi": "Gross profit (GP)"}, R))
s.check("'Business unit gross profit (GP)' from its short form GP", f({"kpi": "Business unit gross profit (GP)"}, R))
s.check("a code in front is not part of the name ('ZZPMDEMO-Gross Profit')", f({"kpi": "ZZPMDEMO-Gross Profit"}, R))
s.check("a Focus after the dot is not part of the name ('Gross Profit · Plant 2')", f({"kpi": "Gross Profit · Plant 2"}, R))
s.check("a word matches by its first five letters ('Collection' from 'Collections')", f({"kpi": "Collection"}, R))

s.section("never claimed from a shared word")
s.check("'Collection efficiency' isn't explained by 'collections' alone (one of two words)",
        not f({"kpi": "Collection efficiency"}, R))
s.check("'Sales revenue' isn't explained by a remark that never names it", not f({"kpi": "Sales revenue"}, R))
s.check("'Direct Materials Cost' neither", not f({"kpi": "Direct Materials Cost"}, R))
s.check("a short form is matched as written: 'PAT' isn't found in 'a pat on the back'",
        not f({"kpi": "Group profit after tax (PAT)"}, "They gave me a pat on the back for the tax filing."))
s.check("'Business unit gross profit margin' isn't explained by 'gross profit' (two of five words)",
        not f({"kpi": "Business unit gross profit margin"}, R))

s.section("what the line manager reads")
facts = {"kpi": "Gross profit (GP)", "note": ""}
k = {"evidence": "none", "group": "short", "band": "BE"}
code, why = a._pm_perf_justify_kpi_own(k, facts, R)
s.check("below target, explained in the remark in plain words: 'they explain what got in the way'",
        code == "yes" and "explain" in why, (code, why))
code2, why2 = a._pm_perf_justify_kpi_own(k, facts, "A quiet year.")
s.check("...and with a remark that doesn't touch it, still 'no context given'",
        code2 == "partly" and "no context given" in why2, (code2, why2))

sys.exit(s.done())
