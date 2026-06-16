# Malaysian statutory change cadence — research note (2026-06)

Compiled to answer "how often do the MY statutory figures actually change?" and to ground the
maintenance/update architecture (ADR-0019 / ADR-0020). Sourced via web research; **confidence medium**
on exact dates where official `.gov.my` PDFs were not directly readable (figures cross-checked against
reputable MY payroll/tax/law-firm sources). Re-verify against primary sources before relying on any exact
figure or gazette date.

## Headline

Statutory figures **do not change frequently** in the day-to-day sense. The cadence is an **annual federal
Budget pulse** (tabled ~October), with changes legislated in the year's Finance Act / agency circular and
taking effect at clean boundaries — **1 January** (tax / Year-of-Assessment) or **1 October** (contribution
cycle) — with **1–12 months of lead time** between announcement and effect. What *is* true, and what drives
the architecture: when a change lands it is **often a bulk whole-table replacement**, and the **employer
(tenant), not the vendor, carries the statutory liability** for under-deduction.

## Per-component cadence

### EPF / KWSP
- **Cadence:** event-driven, rare. The standard employee rate (11%, <60) moved only a handful of times in
  ~15 years, all COVID-driven; the employer 13%/12% (≤/>RM5,000) structure has been static for years.
- **Recent:** 11%→7% (Apr 2020, ~1mo notice) → 9% (2021) → extended (Budget 2022) → restored 11% (Jul 2022);
  **new foreign-worker EPF 2%+2%** (Budget 2025 announced Oct 2024 → effective Oct 2025 wages, ~12mo lead;
  explicitly phased/temporary, may step up).
- **Shape:** the **Third Schedule** (banded amounts for wages ≤RM20,000, by age/citizenship) is re-gazetted
  in full whenever any rate changes → **bulk table replacement**; only >RM20,000 is exact-percentage.
- **Caveat:** no statutory **8%** rate exists (COVID cuts were 7% then 9%). Low-wage RM20 banding is
  approximated in code, not exact (task #95, KWSP PDF blocked).

### SOCSO (Act 4) / EIS (Act 800)
- **Cadence:** infrequent, ~every 2–8 years; driven by **wage-ceiling** moves. Rates are sticky.
- **Recent ceiling:** RM3,000→4,000 (1 Jun 2016, + universal coverage) → 5,000 (1 Sep 2022, ~0 notice) →
  **6,000 (1 Oct 2024**, bills passed Jun 2024, ~3mo; 6-month penalty grace through 31 Mar 2025). No further
  raise gazetted as of Jun 2026.
- **Rates (unchanged across all those moves):** SOCSO Cat 1 1.75%/0.5%, Cat 2 1.25% employer-only, EIS
  0.2%/0.2%. Max at RM6,000: SOCSO Cat 1 ≈ RM104.65+RM29.90; EIS RM11.90+RM11.90.
- **Shape:** a ceiling move **appends** top-end bands + re-anchors the cap, but PERKESO **republishes the
  whole schedule** → treat as **bulk replacement**. **Row count is ceiling-dependent — NOT a fixed 64.**

### LHDN PCB / income tax
- **Cadence:** **annual Budget** (~Oct), effective next YA (1 Jan), ~2–3mo lead. LHDN reissues the MTD
  computerised-method spec yearly.
- **Bands/rates (Table 1 P,M,R,B):** full restructure is **rare** — last was Budget 2023 (re-tabled 24 Feb
  2023 after the Nov-2022 GE); Budget 2024 tweaked two mid-bands (13%→11%, 21%→19%). → bulk swap when it happens.
- **Reliefs / rebate:** the **yearly movers**, edited **one-by-one** as scalars (individual RM9,000 static
  since YA2010 but under pressure; spouse RM4,000; child RM2,000/8,000; EPF+life RM4,000+RM3,000; lifestyle,
  medical, disabled, sports, childcare, EV, vaccination, tourism...). Budget 2025/2026 = relief tweaks, no
  band change.

### Operational
- **Rhythm:** October Budget → agency effective dates clustering 1 Oct / 1 Jan; annual LHDN PCB-spec refresh
  (sometimes a no-op on the engine but still updates TP1/TP3 forms).
- **Liability if a vendor ships late:** the **employer** owes the shortfall — EPF s.49(1) late charge +
  dividend; SOCSO/EIS ILPC 6% p.a.; short PCB must be made good; all due by the **15th of the next month**.
  Regulators sometimes grant grace windows (e.g. the Oct-2024 ceiling's 6-month no-penalty period). Long
  announce-to-effect lead times usually give a well-run vendor ample runway; the acute risk is short-fuse
  subsidiary-regulation changes and the year-boundary PCB refresh.

## Architectural implications (→ ADR-0019 / ADR-0020)

1. **Effective-dating is the right primary lever** and largely neutralizes "frequency": stage the next
   period's ruleset ahead of time with the correct `effective_from`; the loader auto-switches per pay
   period; closed payslips keep their immutable snapshot. Long lead times make this comfortable.
2. **Never hand-edit bulk schedules** — import/replace the whole table (validated, diffed, versioned). The
   ADR-0019 read-only SOCSO/EIS decision was correct.
3. **Model both shapes:** versioned **scalars** (reliefs, rates, ceilings) *and* whole **tables/schedules**
   as effective-dated rules-as-data. Treating everything as one push, or everything as scalars, both fail.
4. **Vendor-owned distribution (ADR-0020):** statutory data is national; maintain it once (verified vs the
   gazette) and **push signed packs** to all deployments without a code redeploy. Per-tenant override stays
   break-glass.
5. **Out of scope (flagged):** retroactive recompute of already-closed batches for a late-landing fix; the
   distribution-speed win only matters at multi-tenant-shared-infra scale.

## Sources (representative; medium confidence — verify primaries before coding figures)
KWSP (Third Schedule, mandatory contribution, foreign-worker press release — `.gov.my`, often 403 on fetch);
PERKESO rate-of-contribution + Act 4 / Act 800 circulars; LHDN MTD 2026 spec + reliefs/rebates pages
(`hasil.gov.my`); plus Lockton, Skrine, Crowe, KPMG, Mercer, PwC, ASEAN Briefing, The Edge, FMT, Malay Mail,
BERNAMA, and MY payroll vendors (PayrollPanda, ajobthing, RinggitCalc, Talenox) for cross-checking dates and
band structure. Full URL list is in the originating research workflow transcript.
