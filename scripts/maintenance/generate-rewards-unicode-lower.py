#!/usr/bin/env python3
"""Emit the frozen SQL casing owner from explicitly supplied official Unicode 17 files.

No network, database or app execution. Download the three inputs from
https://www.unicode.org/Public/17.0.0/ucd/ and supply their directory. Their exact
published bytes are verified before any SQL is emitted. Unicode data copyright
and license notice: scripts/maintenance/rewards-unicode-LICENSE.txt
"""
import hashlib
import json
from pathlib import Path
import sys

HASHES = {
    "UnicodeData.txt": "2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c",
    "SpecialCasing.txt": "efc25faf19de21b92c1194c111c932e03d2a5eaf18194e33f1156e96de4c9588",
    "DerivedCoreProperties.txt": "24c7fed1195c482faaefd5c1e7eb821c5ee1fb6de07ecdbaa64b56a99da22c08",
}


def generate(directory: Path) -> str:
    files = {}
    for name, expected in HASHES.items():
        data = (directory / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError("Unexpected normative Unicode source: " + name)
        files[name] = data.decode("utf-8").splitlines()
    mapping = {}
    for line in files["UnicodeData.txt"]:
        fields = line.split(";")
        if fields[13]:
            mapping[int(fields[0], 16)] = chr(int(fields[13], 16))
    contexts = []
    for line in files["SpecialCasing.txt"]:
        fields = line.split("#", 1)[0].strip().split(";")
        if len(fields) < 4:
            continue
        point = int(fields[0].strip(), 16)
        lower = "".join(chr(int(part, 16)) for part in fields[1].split())
        condition = fields[4].strip() if len(fields) > 4 else ""
        if not condition:
            mapping[point] = lower
        elif not set(condition.split()) & {"tr", "az", "lt"}:
            contexts.append((point, lower, condition))
    if contexts != [(0x03A3, "\u03c2", "Final_Sigma")]:
        raise ValueError("Unhandled language-neutral contextual lowercase mapping")
    mapping = {str(point): lower for point, lower in mapping.items() if chr(point) != lower}
    properties = {"Cased": [], "Case_Ignorable": []}
    for line in files["DerivedCoreProperties.txt"]:
        fields = line.split("#", 1)[0].strip().split(";")
        if len(fields) < 2 or fields[1].strip() not in properties:
            continue
        ends = fields[0].strip().split("..")
        properties[fields[1].strip()].append((int(ends[0], 16), int(ends[-1], 16)))
    if len(mapping) != 1488 or any(len(value) > 1 and key != "304" for key, value in mapping.items()):
        raise ValueError("Unexpected complete lowercase mapping structure")
    def ranges(name: str) -> str:
        return "{" + ",".join(f"[{first},{last + 1})" for first, last in properties[name]) + "}"
    hashes = "\n".join(f"-- {name} SHA256 {digest}" for name, digest in HASHES.items())
    return f'''-- BEGIN GENERATED REWARDS UNICODE17
-- Full Unicode 17.0.0 default lowercase, independent of the server's ICU/libc version.
-- Source: UnicodeData.txt + SpecialCasing.txt + DerivedCoreProperties.txt, Unicode 17.
-- Copyright © 1991-2026 Unicode, Inc. Unicode License V3; full notice:
-- scripts/maintenance/rewards-unicode-LICENSE.txt
-- Regenerate: python3 scripts/maintenance/generate-rewards-unicode-lower.py <official-input-directory>
{hashes}
-- Final_Sigma follows ORIGINAL-string context (core specification 3.13, Table 3-17).
-- Its Case_Ignorable scan is possessive, including Cased/Case_Ignorable overlap.
CREATE FUNCTION app.reward_calc_lower(value text)RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
 WITH characters AS MATERIALIZED(
  SELECT scalar,ordinal,ascii(scalar)AS point FROM regexp_split_to_table(value,'')WITH ORDINALITY input(scalar,ordinal)WHERE scalar<>''
 ),classified AS MATERIALIZED(
  SELECT *,point <@ '{ranges("Cased")}'::int4multirange AS cased,
   point <@ '{ranges("Case_Ignorable")}'::int4multirange AS ignorable FROM characters
 ),neighbors AS(
  SELECT *,max(ordinal)FILTER(WHERE NOT ignorable)OVER(ORDER BY ordinal ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)AS prior_ordinal,
   min(ordinal)FILTER(WHERE NOT ignorable)OVER(ORDER BY ordinal DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)AS next_ordinal FROM classified
 )
 SELECT coalesce(string_agg(CASE WHEN original.point=931 AND coalesce(prior_letter.cased,false)AND NOT coalesce(next_letter.cased,false)THEN chr(962)
  ELSE coalesce(($rewards_unicode17_map${json.dumps(mapping, ensure_ascii=True, sort_keys=True, separators=(',', ':'))}$rewards_unicode17_map$::jsonb)->>original.point::text,original.scalar)END,''ORDER BY original.ordinal),'')COLLATE "C"
 FROM neighbors original LEFT JOIN classified prior_letter ON prior_letter.ordinal=original.prior_ordinal LEFT JOIN classified next_letter ON next_letter.ordinal=original.next_ordinal;
$$;
-- END GENERATED REWARDS UNICODE17
'''


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Supply the directory containing the three official Unicode 17.0.0 files")
    print(generate(Path(sys.argv[1])), end="")
