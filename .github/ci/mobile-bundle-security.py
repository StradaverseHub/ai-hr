"""Inspect production source-map module names only; never emit contents or maps."""
import datetime, hashlib, json, os, pathlib, re, sys
root, lockpath, output = map(pathlib.Path, sys.argv[1:])
assert os.environ.get('GITHUB_ACTIONS') == 'true'
lock = json.loads(lockpath.read_text())
assert lock['packages']['node_modules/zod']['version'] == '4.6.7'
assert lock['packages']['node_modules/expo/node_modules/zod']['version'] == '3.25.76'
def sources(mapping):
    result = list(mapping.get('sources', []))
    for section in mapping.get('sections', []):
        result.extend(sources(section['map']))
    return result
maps = sorted(root.rglob('*.map'))
assert maps, 'No source maps generated'
platforms = {}
for platform in ('ios', 'android'):
    selected = [p for p in maps if platform in p.parts or platform in p.name]
    assert selected, f'No {platform} maps'
    names = sorted({s.replace(chr(92), '/') for p in selected for s in sources(json.loads(p.read_text()))})
    assert len(names) > 100, f'Incomplete module list: {platform}'
    assert any(re.search(r'(?:^|/)lib/session\.tsx$', s) for s in names), 'Missing app session sentinel'
    assert any('/zod/' in s and '/v4/' in s for s in names), 'Missing app validator sentinel'
    findings = {}
    patterns = {
        'expoCli': r'(?:^|/)@expo/cli/',
        'expoNestedZod': r'(?:^|/)expo/node_modules/zod/',
        'zodV3': r'(?:^|/)zod/v3/',
        'glob': r'(?:^|/)node_modules/glob/',
        'minimatch': r'(?:^|/)node_modules/minimatch/',
        'deepmerge': r'(?:^|/)node_modules/deepmerge/',
    }
    for name, pattern in patterns.items():
        findings[name] = [s for s in names if re.search(pattern, s)]
    platforms[platform] = {
        'mapCount': len(selected), 'sourceModuleCount': len(names),
        'moduleListSha256': hashlib.sha256('\n'.join(names).encode()).hexdigest(),
        'flaggedModulePaths': findings,
        'appValidatorPaths': [s for s in names if '/zod/' in s and '/v4/' in s],
        'flaggedModulesAbsent': not any(findings.values()),
    }
report = {
    'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'source': 'c194c593c1aa51fc34d247403e56b73a2b14f34f',
    'controller': os.environ['GITHUB_SHA'], 'run': os.environ['GITHUB_RUN_ID'],
    'lockSha256': hashlib.sha256(lockpath.read_bytes()).hexdigest(),
    'platforms': platforms,
    'scope': 'Fresh production exports of exact source and lock; not independent installed APK/IPA source-map provenance.',
    'limitations': 'Absence from app JS does not remove build-toolchain advisories, assess native code, prove absence of breach or grant release clearance.',
    'securityClearance': False,
}
output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'platforms': {k: {'sourceModuleCount': v['sourceModuleCount'], 'flaggedModulesAbsent': v['flaggedModulesAbsent']} for k, v in platforms.items()}}))
