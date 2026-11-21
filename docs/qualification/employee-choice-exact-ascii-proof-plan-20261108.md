# Exact ASCII employee search: proof before query adoption

This is a development research and qualification plan, not an implemented search
path or a passing test receipt. No application, SQL, permission, migration,
resource or timeout changes are included. Production remains held.

The inspected candidate is `c5eaabdfbcdcdffff0dfb9b33b1a6d01b20e9966`.
Freshly fetched main and alpha were both
`b7c0393aa3c7606a33dd15103426e5c535324065`; the candidate is an explicitly
selected research base, not a release integration. Existing codec work and all
historical lookup candidates/evidence remain unchanged.

## Decision to qualify

For a nonempty ASCII **prepared** query, qualify a native expression that
preserves the ASCII substring observations of JavaScript lowercase, without
computing all of Unicode lowercase in PostgreSQL. Keep the existing JavaScript
cursor/matching path for every unsupported runtime or non-ASCII prepared query.
Do not use PostgreSQL `lower`, case folding, accent removal or normalization as
a substitute. Runtime qualification must precede any application/query rewrite.

The existing preparation remains `rawQuery.trim().toLowerCase()`, while returned
filter metadata retains the original raw query. The current implementation
conservatively sends every name/code containing a character outside printable
ASCII to JavaScript, then supplies all exact matched IDs to a second native
projection. That is correct but needlessly transfers the complete 50,000-row
fixture for an ordinary ASCII search. See
`core/employee-choice.ts:149` and
`test/performance/employee-choice-native-purpose-reader.ts:24`.

## Primary-source findings and their limits

ECMAScript lowercase uses locale-insensitive Unicode default case conversion,
including the special-casing data; mappings may expand and depend on context.
Its substring test ultimately compares UTF-16 code units. These are different
contracts from locale-sensitive lowercase and case folding. This research uses
the stable 2024 language specification, rather than a current draft.
[ECMAScript lowercase](https://tc39.es/ecma262/2024/multipage/text-processing.html#sec-string.prototype.tolowercase),
[includes](https://tc39.es/ecma262/2024/multipage/text-processing.html#sec-string.prototype.includes).

The retained lookup artifacts report Node `22.23.3`, but do not establish its
actual ICU/Unicode data versions or binary identity. Official Node tag sources
identify ICU 78.3 and a default Unicode version of 17.0; the latter header
explicitly says loaded data can have a different version. Therefore these source
headers are a research lead, not an actual-runtime receipt. Capture the hosted
binary identity and complete relevant `process.versions` before using this
profile. [Node ICU version](https://raw.githubusercontent.com/nodejs/node/v22.23.3/deps/icu-small/source/common/unicode/uvernum.h),
[Unicode-data version caveat](https://raw.githubusercontent.com/nodejs/node/v22.23.3/deps/icu-small/source/common/unicode/uchar.h),
[Node versions API](https://nodejs.org/download/release/v22.23.3/docs/api/process.html#processversions).

A complete **static** scan of the official Unicode 17.0.0 data, combining simple
lowercase mappings with unconditional full lowercase overrides, found:

| Domain | Complete static finding |
| --- | --- |
| ASCII default changes | A–Z map to a–z; other ASCII code points retain identity. |
| Non-ASCII mappings containing ASCII | U+0130 maps to U+0069 U+0307; U+212A maps to U+006B. |
| Empty default lowercase mappings | None. |
| Locale-insensitive conditional mappings | Only U+03A3 under Final_Sigma; either result is nonempty and entirely non-ASCII. |

This set was derived from the complete files, not assumed from those two familiar
characters. Language-tagged Turkish, Azeri and Lithuanian rules were separately
enumerated and excluded from the locale-insensitive algorithm, not silently
treated as unconditional. Unlisted code points have identity mappings.
[UnicodeData 17.0.0](https://www.unicode.org/Public/17.0.0/ucd/UnicodeData.txt),
[SpecialCasing 17.0.0](https://www.unicode.org/Public/17.0.0/ucd/SpecialCasing.txt).

The downloaded static inputs have SHA-256:

- UnicodeData, 2,198,209 bytes:
  `2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c`.
- SpecialCasing, 17,049 bytes:
  `efc25faf19de21b92c1194c111c932e03d2a5eaf18194e33f1156e96de4c9588`.

Private research copies and the machine-readable static derivation are retained
at `/private/tmp/aihr-ascii-search-research-20261108`. No Node, PostgreSQL or
application behavior was executed to obtain these findings.

## Why this can be exact for ASCII queries

Define the observation of a string as its maximal ASCII runs, with each maximal
non-ASCII run replaced by one non-ASCII sentinel. Preserve every barrier; never
delete non-ASCII text. Two strings with identical observations contain exactly
the same nonempty ASCII substrings.

For the reviewed Unicode data, ASCII lowercase plus the two derived exceptions
preserves that observation for every scalar. Every other default mapping leaves
a nonempty non-ASCII barrier. The only locale-insensitive context rule changes
one non-ASCII sigma to another, which cannot alter an ASCII run or join two
runs. Contexts are evaluated in the original string; ignoring that fact would
not be a valid general casing implementation. This is an ASCII-observation
argument only, not equality of complete lowercase strings.
[Unicode default case algorithms and context definitions](https://www.unicode.org/versions/Unicode17.0.0/core-spec/chapter-3/#G33992).

Valid UTF-8 non-ASCII characters contain no ASCII bytes. Consequently, a nonempty
ASCII byte needle cannot match inside a non-ASCII character, just as ASCII
UTF-16 code units cannot match inside its non-ASCII encoding. This equivalence
is restricted to PostgreSQL UTF-8 text: PostgreSQL text excludes NUL, while
Unicode scalar values exclude surrogate code points. Keep the existing NUL
query's impossible-result path and the existing fallback for non-ASCII or lone
surrogate query input. [Unicode encoding definitions](https://www.unicode.org/versions/Unicode17.0.0/core-spec/chapter-3/),
[PostgreSQL character types](https://www.postgresql.org/docs/16/datatype-character.html).

The proposed expression, shown as a design sketch only, is:

```sql
position(
  convert_to(prepared_ascii_query, 'UTF8') in
  convert_to(
    translate(
      replace(source_text, U&'\0130', U&'i\0307'),
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ' || U&'\212A',
      'abcdefghijklmnopqrstuvwxyzk'
    ),
    'UTF8'
  )
) > 0
```

Apply it independently to name and coalesced employee code. `translate` replaces
characters by position; the equal-length source/target alphabets avoid deletion.
Binary substring position avoids LIKE wildcard escaping and collation-sensitive
matching. Thus percent, underscore and backslash stay literal characters.
[PostgreSQL translate/replace](https://www.postgresql.org/docs/16/functions-string.html),
[binary substring position](https://www.postgresql.org/docs/16/functions-binarystring.html).

Important adversarial examples: U+0130 followed by A must match `i` but must
**not** match `ia`, because its combining dot remains a barrier. Kelvin sign
followed by A must match `ka`. Long s, sharp s and ligatures must not acquire
case-folded ASCII spellings. These examples supplement, not replace, exhaustive
derivation and context proof.

## Hosted qualification before any query change

Prepare a separate test-only child and freeze it for root and independent
review. Use the existing standard hosted runner, normal database role and
read-only transaction. Do not install a function, alter a migration, enable an
extension, change GUC authority, grant privileges or modify the current lookup.
No local runtime checks are authorized by this plan.

1. **Bind the environment.** Record candidate/controller/test/source hashes,
   Node binary SHA, Node/V8/ICU/Unicode versions, UTF-8 server encoding and native
   PostgreSQL version. Pin both complete Unicode files above; refuse unknown
   schemas, conditions or duplicate/contradictory table records. Derive the
   exception set independently from the complete tables and assert the reviewed
   exact set. Unsupported versions fail this qualification; future application
   admission must select the old fallback, never guess compatibility.
2. **Check every database-valid scalar independently.** Enumerate 1 through
   U+10FFFF, excluding U+D800–U+DFFF: exactly 1,112,063 values. Node computes the
   observation of actual `String.fromCodePoint(cp).toLowerCase()` for each, with
   an independently implemented observer. A native SELECT computes the proposed
   expression's transformed text and its observation for the same values. The
   native observer may replace maximal non-ASCII runs with U+E000 under explicit
   C collation; the Node observer must not copy that SQL regex implementation.
   Compare ordered, fully retained records, not only exception samples.
3. **Use a bounded exact protocol.** Each scalar record is native big-endian
   int32 code point, int32 UTF-8 observation length, then the observation bytes.
   The reviewed mapping implies a complete corpus below 16 MiB (one non-ASCII
   sentinel is three UTF-8 bytes), but assert actual lengths/count/order and
   refuse overflow. Compare complete independent buffers with `Buffer.equals`,
   also retaining SHA-256/count/bounds and a bounded first-mismatch diagnostic.
   Changed-byte, missing/repeated/reordered-record and omitted-exception controls
   must fail. Never use deep object enumeration of multi-megabyte buffers.
4. **Prove contextual coverage separately.** Check the complete conditional
   table, not isolated scalars alone. Exercise native/Node whole-string parity
   around Final_Sigma with cased, uncased and case-ignorable neighbors, their
   overlap (including U+0345), long ignorable chains and supplementary neighbors.
   Cover every reviewed context predicate and ensure no default rule deletes a
   barrier or creates additional ASCII. Include deliberate removal of the
   U+0130 dot and omission of Kelvin mapping as refusals. Do not claim arbitrary
   strings are exhaustively tested; their coverage follows from the scalar
   partition plus the complete contextual argument.
5. **Check the actual search interface.** Exercise query preparation separately
   from name transformation: raw/trimmed whitespace, empty query, internal ASCII
   controls and DEL, NUL, `%`, `_`, backslash, uppercase ASCII, raw Kelvin,
   U+0130, combining sequences, supplementary characters and lone surrogates.
   Assert original raw filter metadata, no forbidden NUL/non-ASCII parameter in
   the exact mode, and real old-path selection for unsupported profiles. Runtime
   metadata alone is not a deployment trust proof; admission must bind a reviewed
   runtime build/profile through existing release ownership, not a caller GUC.

Keep the existing 20-second SQL limit, 300 ms lock timeout, 2-second connection
startup, 30-second ordinary test limit and standard runner resources. A native
corpus query exceeding those bounds is a genuine qualification failure, not
permission to extend them or sample fewer scalars. Keep original failures and
all planned chunks terminal before repair. Publish only bounded fictional
proof data, exact corpus hashes and honest source/controller receipts.

## Integration experiment only after proof passes

Root must review the actual runtime evidence before an implementation child.
For a supported runtime and ASCII prepared query, use the exact native predicate
before count and native pagination. Return a bounded page directly, with no
JavaScript workforce stream or second all-matched-ID projection. Full company,
department and unit facets remain derived from their original population;
selected identity remains independently admitted. Preserve all RLS, fresh
principal, tenant/company scope, current Employment company, effective-date,
NULL-ended/unsuperseded, current-assignment, label and public/server page-limit
rules. Complete-ID consumers must return the complete exact ordered identity
set; no page-sized clipping or result cap may enter that path.

Validate all existing independent fixture IDs/counts/options/selected/context
and historical/foreign/revoked authority cases, then the actual 50,000-row
initial/deep/broad/missing/Unicode/organization/All2000 workload under unchanged
one-second targets and original resource budgets. Add broad ASCII and mixed
Unicode/ASCII ties plus matching employee-code cases. Capture every actual
native call/plan; explicitly distinguish eliminated candidate/project calls
from prior historical 44-phase/27-pair evidence. Native order and pagination
remain PostgreSQL's original name/employment-ID tuple order. This optimization
does not justify JavaScript locale sorting, a new index, higher work_mem, JIT
changes or skipping any population/authority check.

No speed improvement, zero Busy guarantee, all-module acceptance or deployment
authorization follows from this plan. The current c5 single-pass hydration
experiment and its actual retained successes/failures remain a separate gate.
