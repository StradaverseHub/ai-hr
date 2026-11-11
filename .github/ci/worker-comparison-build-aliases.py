"""Read-only same-checkout Next alias identity for the hosted worker comparison."""
import importlib.util
import json
from pathlib import Path
import sys


spec = importlib.util.spec_from_file_location('runtime_inventory', Path(__file__).with_name('runtime_inventory.py'))
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


def inspect(source, aliases):
    inventory.require(source.is_absolute() and source.resolve(strict=True) == source, 'Build checkout differs')
    inventory.require(type(aliases) is list and len(aliases) == len(inventory.EXTERNAL_PACKAGES), 'Build aliases differ')
    packages = set()
    results = []
    for row in aliases:
        inventory.require(type(row) is dict and set(row) == {'path', 'target'}
                          and all(type(row[key]) is str for key in row), 'Build alias shape differs')
        relative = '.next/' + row['path']
        match = inventory.BUILD_ALIAS.fullmatch(relative)
        inventory.require(match is not None and match[1] not in packages, 'Build alias differs')
        package = match[1]
        identity, expected = inventory.package_identity(source, package)
        actual = inventory.build_alias_target(source, relative, row['target'])
        inventory.require(actual == expected, 'Build alias target differs')
        packages.add(package)
        results.append({'path': row['path'], **identity})
    inventory.require(packages == inventory.EXTERNAL_PACKAGES, 'Build packages differ')
    return results


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(16385)
        inventory.require(len(sys.argv) == 1 and 0 < len(raw) <= 16384, 'Build alias request differs')
        request = json.loads(raw.decode('utf-8'))
        inventory.require(type(request) is dict and set(request) == {'source', 'aliases'}
                          and type(request['source']) is str, 'Build alias request differs')
        print(json.dumps(inspect(Path(request['source']), request['aliases']), separators=(',', ':')))
    except (OSError, RuntimeError, TypeError, ValueError):
        raise SystemExit('Worker comparison runtime aliases refused') from None
