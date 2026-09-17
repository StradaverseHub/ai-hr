-- 0473 — r303 (05db6aa7) "Custom Rounding Table Configuration": every stored rounding table is rewritten
-- into the new meaning of its columns, with IDENTICAL RESULTS for every figure the engine can see.
--
-- ⚠️ THIS SHIPS WITH A CODE CHANGE AND MUST NOT SHIP WITHOUT IT, OR BEFORE IT. Read this before touching a
-- character of either.
--
-- ── WHAT CHANGED IN THE CODE ────────────────────────────────────────────────────────────────────────
-- Until r303 a row {from, to, result} matched a decimal portion f when  from <= f < to  (a row ending at
-- exactly 1.000 was inclusive), compared at three decimals, and the screen labelled the columns From /
-- Round To / Rounded Result — so the column called "Round To" was really where the range ENDED. The
-- reporter approved the table the way they think about it: From / To / Round To, BOTH ENDS INCLUDED,
-- two decimals, typed as written. The engine (core/leave-compute.ts `applyRoundingBands`) now works the
-- figure out to 2dp and matches  from <= f <= to  in integer hundredths.
--
-- ── THE TRAP THIS MIGRATION EXISTS FOR ──────────────────────────────────────────────────────────────
-- Switching to inclusive bounds WITHOUT converting the data makes every stored table whose rows touch
-- (production's 0.00–0.40, 0.40–0.70, 0.70–1.00) OVERLAP at 0.40 and 0.70 under the new rules. An
-- overlapping table is malformed, `applyRoundingBands` passes a malformed table straight through, and
-- rounding would silently STOP on every leave type that has it. Nothing would error.
--
-- ── WHAT IS STORED TODAY ────────────────────────────────────────────────────────────────────────────
-- Measured on production 2026-08-07 (the 0414 header) and NOT re-measured for this round — production reads
-- were not available to the builder. Three leave types, ANNUAL, CGL and CPL, each holding (after 0414):
--
--     before  [{from 0,    to 0.4,  result 0}, {from 0.4,  to 0.7,  result 0.5}, {from 0.7,  to 1,    result 1}]
--     after   [{from 0.00, to 0.39, result 0}, {from 0.40, to 0.69, result 0.5}, {from 0.70, to 0.99, result 1}]
--
-- Because that snapshot is old, the rule below is written to be EXACT FOR ANY STORED SHAPE, and the
-- RAISE NOTICE lines put what it actually found on production into the deploy log: every table converted
-- (before -> after), every table left alone, and a one-line summary with the counts.
--
-- ── THE RULE, AND WHY IT IS EXACT ───────────────────────────────────────────────────────────────────
-- Every figure reaching the engine is at 2dp, so its decimal portion f is one of 0.00 … 0.99 (0.00 is a
-- whole figure and is never looked up). The old engine snapped each stored bound to thousandths first
-- (`Math.round(x * 1000) / 1000`), so with F and U the stored from/to in THOUSANDTHS the set of 2dp
-- decimals an old row covers is exactly
--
--     { f : F <= 1000·f < U }  =  { f : ceil(F / 10) <= 100·f <= ceil(U / 10) − 1 }        (f in hundredths)
--
-- so the new row is  from := ceil(F/10)/100,  to := (ceil(U/10) − 1)/100,  result unchanged. A row ending
-- at 1.00 becomes 0.99, which loses nothing: no 2dp decimal portion is larger than 0.99. A row whose new
-- from is above its new to covered NO 2dp decimal under the old rule either and is DROPPED; a table whose
-- every row is dropped becomes [] (not NULL — a NULL would change hasAnyLeaveTypeRule's answer for the
-- type, and [] resolves to no rounding exactly as the old table did for 2dp figures). Rows keep their
-- order and any extra keys they carried. Everything is computed in numeric, never float, except one
-- place stated below.
--
-- Old tables did not overlap (the old validator refused a half-open overlap), so the new rows' 2dp sets
-- are disjoint and the converted table is well-formed under the new inclusive rules.
--
-- ── THE TWO CORNERS WHERE "EXACT" NEEDED MORE THAN ARITHMETIC ───────────────────────────────────────
-- 1. A STORED BOUND ON AN EXACT HALF-THOUSANDTH (0.4005). The old engine rounded it with IEEE-754
--    `Math.round(x * 1000)`, where x * 1000 lands a hair either side of .5 depending on the binary
--    expansion of x. Numeric arithmetic cannot know which side, so for that case ONLY the thousandths are
--    computed the way V8 does it: y = x::float8 * 1000, r = ceil(y), minus one when r − 0.5 > y. Any other
--    value is ≥ 1e-12 away from the tie, where the double's error (≤ 3.3e-13 for |x| ≤ 2) cannot flip it,
--    and plain numeric floor(x * 1000 + 0.5) is identical. A bound with |x| > 2 is out of range under both
--    rules whatever JavaScript made of it, so the table is malformed and nothing is cast.
-- 2. A RESULT WITH A THIRD DECIMAL. The new rules refuse one, so it must become 2dp. A result whose
--    thousandths end in 1-4 or 6-9 rounds to the same 2dp figure the old engine credited for every whole
--    part. One ending in exactly 5 (0.505) was credited as round2dp(whole + 0.505) in binary float, which
--    goes up or down DEPENDING ON THE WHOLE PART — no 2dp result can reproduce that, so it is rounded
--    half-up and every such table is counted and named in the summary. None is known to exist: 0414
--    already rounded every result to 2dp and the writer has refused a third decimal since 4a1abc4a's editor.
--
-- ── WHAT IS LEFT ALONE ──────────────────────────────────────────────────────────────────────────────
-- A table that was MALFORMED under the old rules (not a list, empty, a row that is not three numbers, a
-- figure outside 0.000–1.000, a row whose from is not below its to, overlapping or repeated rows) never
-- rounded anything: `applyRoundingBands` passed every figure through. It is NOT rewritten — inventing
-- figures for a table nobody could read would turn a rule that did nothing into one that moves days — and
-- each one is listed by leave type in the log.
--
-- ONE CLASS OF THOSE IS NOT BEHAVIOUR-PRESERVING, and it is raised as a WARNING rather than hidden: a table
-- whose only fault under the old rules was a single-point row (from = to), with every figure at 2dp, is
-- LEGAL under the new rules (the reporter asked for From not above To, so From = To is allowed) and would
-- START rounding. The old writer refused such a table, so only a hand-written row can hold one.
--
-- ── NOT IDEMPOTENT, AND THAT IS UNAVOIDABLE ─────────────────────────────────────────────────────────
-- A converted table ([0.00, 0.39] …) is also a well-formed OLD table, and nothing in the data says which
-- meaning a row was written in. Re-running this by hand would shave another hundredth off every To. The
-- journal applies it exactly once; never replay it outside the journal.
--
-- NO LEDGER ROW IS TOUCHED and nothing is recalculated: this is configuration, and because every 2dp
-- figure rounds exactly as before, there is nothing to recalculate. Data-only on an existing, already-granted
-- table (`leave_type`); no DDL, so no GRANT.
--
-- Guarded by test/leave-rounding-bands-0473.test.ts, which runs THIS FILE against stored tables and
-- compares a verbatim copy of the pre-r303 engine on the old table with the new engine on the converted
-- one, for every 2dp decimal 0.00-0.99 and whole parts 0, 1 and 7.
DO $$
DECLARE
  t record;
  n_tables integer := 0;
  n_converted integer := 0;
  n_rows_in integer := 0;
  n_rows_out integer := 0;
  n_fine integer := 0;
  fine_types text[] := '{}';
  n_half integer := 0;
  half_types text[] := '{}';
  n_malformed integer := 0;
  malformed_types text[] := '{}';
  accepted_types text[] := '{}';
BEGIN
  FOR t IN
    WITH src AS (
      SELECT lt.id, lt.code, lt.rounding_bands AS bands,
             jsonb_typeof(lt.rounding_bands) = 'array' AS is_array,
             CASE WHEN jsonb_typeof(lt.rounding_bands) = 'array' THEN jsonb_array_length(lt.rounding_bands) ELSE 0 END AS n_rows
      FROM leave_type lt
      WHERE lt.rounding_bands IS NOT NULL
    ),
    el AS (
      SELECT s.id, e.ord, e.v
      FROM src s
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN s.is_array THEN s.bands ELSE '[]'::jsonb END)
        WITH ORDINALITY AS e(v, ord)
      WHERE jsonb_typeof(e.v) = 'object'
        AND jsonb_typeof(e.v -> 'from') = 'number'
        AND jsonb_typeof(e.v -> 'to') = 'number'
        AND jsonb_typeof(e.v -> 'result') = 'number'
    ),
    cells AS (
      SELECT el.id, el.ord, el.v,
             (el.v ->> 'from')::numeric AS xf,
             (el.v ->> 'to')::numeric AS xu,
             (el.v ->> 'result')::numeric AS xr
      FROM el
    ),
    thous AS (
      -- Each figure in whole THOUSANDTHS, exactly as the old engine's bandRound saw it (see corner 1).
      SELECT c.*, k.tf, k.tu, k.tr, k.n_fine, k.new_cells_ok
      FROM cells c
      CROSS JOIN LATERAL (
        SELECT max(z.th) FILTER (WHERE q.col = 1) AS tf,
               max(z.th) FILTER (WHERE q.col = 2) AS tu,
               max(z.th) FILTER (WHERE q.col = 3) AS tr,
               count(*) FILTER (WHERE q.x * 100 <> floor(q.x * 100)) AS n_fine,
               -- the NEW rules' per-figure test, for the warning only: 2dp and 0.00–1.00
               bool_and(abs(q.x * 100 - round(q.x * 100)) < 0.000001 AND q.x >= 0 AND q.x <= 1) AS new_cells_ok
        FROM (VALUES (1, c.xf), (2, c.xu), (3, c.xr)) AS q(col, x)
        CROSS JOIN LATERAL (
          SELECT CASE
                   WHEN abs(q.x) > 2 THEN NULL
                   WHEN abs(q.x * 1000 - floor(q.x * 1000) - 0.5) < 0.000000000001 THEN
                     (CASE
                        WHEN ceil(q.x::float8 * 1000::float8) - 0.5::float8 > q.x::float8 * 1000::float8
                          THEN ceil(q.x::float8 * 1000::float8) - 1::float8
                        ELSE ceil(q.x::float8 * 1000::float8)
                      END)::numeric
                   ELSE floor(q.x * 1000 + 0.5)
                 END AS th
        ) z
      ) k
    ),
    rowv AS (
      SELECT th.*,
             (th.tf IS NOT NULL AND th.tu IS NOT NULL AND th.tr IS NOT NULL
               AND th.tf BETWEEN 0 AND 1000 AND th.tu BETWEEN 0 AND 1000 AND th.tr BETWEEN 0 AND 1000
               AND th.tf < th.tu) AS old_valid,
             ceil(th.tf / 10.0) AS from_h,
             ceil(th.tu / 10.0) - 1 AS to_h,
             floor((th.tr + 5) / 10.0) AS result_h,
             round(th.xf * 100) AS new_from_h,
             round(th.xu * 100) AS new_to_h
      FROM thous th
    ),
    agg AS (
      SELECT r.id,
             count(*) AS n_numeric,
             bool_and(r.old_valid) AS all_old_valid,
             bool_and(r.new_cells_ok AND r.new_from_h <= r.new_to_h) AS all_new_valid,
             sum(r.n_fine) AS n_fine,
             coalesce(
               jsonb_agg(
                 r.v || jsonb_build_object(
                   'from', round(r.from_h / 100.0, 2),
                   'to', round(r.to_h / 100.0, 2),
                   'result', round(r.result_h / 100.0, 2)
                 )
                 ORDER BY r.ord
               ) FILTER (WHERE r.old_valid AND r.from_h <= r.to_h),
               '[]'::jsonb
             ) AS bands_new,
             count(*) FILTER (WHERE r.old_valid AND r.from_h <= r.to_h) AS n_out,
             count(*) FILTER (WHERE r.old_valid AND r.from_h <= r.to_h AND r.tr % 10 = 5) AS n_half
      FROM rowv r
      GROUP BY r.id
    )
    SELECT s.id, s.code, s.bands, s.n_rows,
           (s.is_array AND s.n_rows > 0
             AND coalesce(a.n_numeric, 0) = s.n_rows
             AND coalesce(a.all_old_valid, false)
             AND NOT EXISTS (
               SELECT 1 FROM rowv x JOIN rowv y ON x.id = y.id AND x.ord < y.ord
               WHERE x.id = s.id AND x.tf < y.tu AND y.tf < x.tu
             )) AS old_ok,
           (s.is_array AND s.n_rows > 0
             AND coalesce(a.n_numeric, 0) = s.n_rows
             AND coalesce(a.all_new_valid, false)
             AND NOT EXISTS (
               SELECT 1 FROM rowv x JOIN rowv y ON x.id = y.id AND x.ord < y.ord
               WHERE x.id = s.id AND x.new_from_h <= y.new_to_h AND y.new_from_h <= x.new_to_h
             )) AS new_ok,
           coalesce(a.n_fine, 0) AS n_fine,
           a.bands_new,
           coalesce(a.n_out, 0) AS n_out,
           coalesce(a.n_half, 0) AS n_half
    FROM src s
    LEFT JOIN agg a ON a.id = s.id
    ORDER BY s.code, s.id
  LOOP
    n_tables := n_tables + 1;
    IF t.n_fine > 0 THEN
      n_fine := n_fine + t.n_fine;
      fine_types := fine_types || format('%s (%s)', t.code, t.id);
    END IF;
    IF t.old_ok THEN
      UPDATE leave_type SET rounding_bands = t.bands_new WHERE id = t.id;
      n_converted := n_converted + 1;
      n_rows_in := n_rows_in + t.n_rows;
      n_rows_out := n_rows_out + t.n_out;
      IF t.n_half > 0 THEN
        n_half := n_half + t.n_half;
        half_types := half_types || format('%s (%s)', t.code, t.id);
      END IF;
      RAISE NOTICE '0473 converted leave_type % (%): % -> %', t.code, t.id, t.bands, t.bands_new;
    ELSE
      n_malformed := n_malformed + 1;
      malformed_types := malformed_types || format('%s (%s)', t.code, t.id);
      RAISE NOTICE '0473 left untouched, malformed under the pre-0473 rules (it never rounded anything): leave_type % (%): %',
        t.code, t.id, t.bands;
      IF t.new_ok THEN
        accepted_types := accepted_types || format('%s (%s)', t.code, t.id);
        RAISE WARNING '0473 leave_type % (%) holds a table the OLD rules refused and the NEW rules ACCEPT (a single-point row): it was left untouched and WILL START ROUNDING if its rounding method is custom: %',
          t.code, t.id, t.bands;
      END IF;
    END IF;
  END LOOP;

  RAISE NOTICE '0473 summary: % leave type(s) carry a rounding table; % converted (% rows in, % rows out, % dropped as covering no 2dp decimal); % figure(s) with more than two decimals [%]; % converted result(s) on an exact half-hundredth, rounded half-up [%]; % malformed table(s) left untouched [%]; % of those accepted by the new rules [%].',
    n_tables, n_converted, n_rows_in, n_rows_out, n_rows_in - n_rows_out,
    n_fine, array_to_string(fine_types, ', '),
    n_half, array_to_string(half_types, ', '),
    n_malformed, array_to_string(malformed_types, ', '),
    coalesce(array_length(accepted_types, 1), 0), array_to_string(accepted_types, ', ');
END $$;
