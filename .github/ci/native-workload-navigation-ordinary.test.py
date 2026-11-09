"""Held ordinary source and independent raw-object evidence models."""
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest


def load_sibling(name, filename):
    source = Path(__file__).with_name(filename)
    module = types.ModuleType(name)
    module.__file__ = str(source)
    sys.modules[name] = module
    exec(compile(source.read_bytes(), str(source), 'exec', dont_inherit=True), module.__dict__)
    return module


N = load_sibling('navigation_ordinary_model_source', 'native-workload-navigation-source.py')
I = load_sibling('navigation_ordinary_model_tree', 'runtime_inventory.py')
SCENARIO = 'scripts/performance/navigation-scenarios.json'
CAPTURE = 'scripts/performance/navigation-browser-capture.ts'


def tick():
    pass


def git_object(path, content, mode='100644'):
    header = ('blob %d\0' % len(content)).encode('ascii')
    oid = hashlib.sha1(header + content, usedforsecurity=False).hexdigest()
    return N.NavigationOrdinaryGitObject(
        N.BoundedHarnessMember(path, mode, len(content), oid), hashlib.sha256(content).hexdigest())


def row(path, mode, size, oid):
    return f'{mode} blob {oid} {size:>7}\t{path}\0'.encode('ascii')


HISTORY = b''.join(row(pin.path, '100644', pin.size, pin.git_blob) for pin in N.HISTORY_PINS)


def inventory(objects):
    return HISTORY + b''.join(row(*obj.member) for obj in objects)


class NativeNavigationOrdinaryModel(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.scenario_bytes = b'{"synthetic":true}\n'
        self.objects = (self.write(SCENARIO, self.scenario_bytes), self.write(CAPTURE, b'fixture'))

    def write(self, relative, content, permissions=0o644, git_mode='100644'):
        leaf = self.root / relative
        leaf.parent.mkdir(parents=True, exist_ok=True)
        leaf.write_bytes(content)
        leaf.chmod(permissions)
        return git_object(relative, content, git_mode)

    def capture(self, tree, objects=None, check_clock=tick):
        objects = self.objects if objects is None else objects
        return N.capture_navigation_ordinary(tree, inventory(objects), objects, check_clock)

    def refuse_before_read(self, rows, git_objects, message):
        with I.PinnedTree(self.root) as tree:
            with self.assertRaisesRegex(ValueError, message):
                N.capture_navigation_ordinary(tree, rows, git_objects, tick)
            self.assertEqual(tree.files, {})

    def test_real_checkout_yields_measured_scenario_and_complete_ordinary_rows(self):
        executable = self.write('scripts/performance/tool', b'fixture command', 0o500, '100755')
        empty = self.write('lib/navigation/empty', b'', 0o400)
        objects = self.objects + (executable, empty)
        self.assertFalse((self.root / 'deploy/admission').exists())
        with I.PinnedTree(self.root) as tree:
            result = N.capture_navigation_ordinary(tree, inventory(objects), objects[::-1], tick)
            self.assertEqual(set(tree.files), {obj.member.path for obj in objects})
        expected = tuple((*obj.member, obj.sha256) for obj in sorted(objects))
        self.assertEqual(result.ordinary, expected)
        self.assertIs(type(result.scenario), bytes)
        self.assertEqual(result.scenario, self.scenario_bytes)

    def test_same_size_checkout_bytes_do_not_match_independent_git_object(self):
        (self.root / SCENARIO).write_bytes(b'x' * len(self.scenario_bytes))
        with I.PinnedTree(self.root) as tree, self.assertRaisesRegex(ValueError, 'bytes differ from Git'):
            self.capture(tree)

    def test_git_raw_digest_and_git_blob_oid_are_independent_requirements(self):
        scenario, capture = self.objects
        wrong_raw = scenario._replace(sha256='a' * 64)
        wrong_oid = scenario._replace(member=scenario.member._replace(git_blob='b' * 40))
        for variant in (wrong_raw, wrong_oid):
            with self.subTest(variant=variant), I.PinnedTree(self.root) as tree:
                with self.assertRaisesRegex(ValueError, 'bytes differ from Git'):
                    self.capture(tree, (variant, capture))

    def test_missing_extra_duplicate_and_mismatched_git_object_facts_refuse_before_read(self):
        scenario, capture = self.objects
        variants = (
            ((scenario,), 'count differs'),
            ((scenario, capture, scenario), 'count differs'),
            ((scenario, scenario), 'duplicate'),
            ([scenario, capture], 'count differs'),
            ((scenario._replace(sha256='A' * 64), capture), 'invalid ordinary'),
            ((scenario._replace(sha256='a' * 64 + '\n'), capture), 'invalid ordinary'),
            ((scenario._replace(member=scenario.member._replace(size=True)), capture), 'invalid ordinary'),
        )
        for objects, message in variants:
            with self.subTest(message=message):
                self.refuse_before_read(inventory(self.objects), objects, message)
        for field, value in (('path', 'lib/navigation/missing'), ('mode', '100755'),
                             ('size', scenario.member.size - 1), ('git_blob', '0' * 40)):
            with self.subTest(field=field):
                changed = scenario._replace(member=scenario.member._replace(**{field: value}))
                self.refuse_before_read(inventory(self.objects), (changed, capture), 'metadata differs')

    def test_git_inventory_rejects_duplicate_missing_foreign_or_invalid_regular_rows(self):
        scenario, capture = self.objects
        rows = inventory(self.objects)
        variants = (
            (rows + row(*scenario.member), 'duplicate navigation inventory'),
            (inventory((capture,)), 'source inventory incomplete'),
            (rows + row('foreign/source.py', '100644', 1, 'a' * 40), 'outside fixed roots'),
            (rows + row('lib/navigation/x', '120000', 1, 'a' * 40), 'regular Git blob'),
            (rows[:-1], 'invalid bounded navigation Git inventory'),
        )
        for given, message in variants:
            with self.subTest(message=message):
                self.refuse_before_read(given, self.objects, message)

    def test_checkout_mode_must_match_git_and_refuse_privileged_or_foreign_write_bits(self):
        scenario, capture = self.objects
        leaf = self.root / SCENARIO
        for mode in (0o744, 0o601, 0o664, 0o646, 0o4644):
            with self.subTest(mode=mode):
                leaf.chmod(mode)
                with I.PinnedTree(self.root) as tree, self.assertRaisesRegex(ValueError, 'checkout metadata'):
                    self.capture(tree)
        leaf.chmod(0o644)
        executable = scenario._replace(member=scenario.member._replace(mode='100755'))
        with I.PinnedTree(self.root) as tree, self.assertRaisesRegex(ValueError, 'checkout metadata'):
            self.capture(tree, (executable, capture))

    def test_symlink_hardlink_and_fifo_refuse_without_consuming_target(self):
        leaf = self.root / SCENARIO
        target = self.root / 'external-to-inventory'
        target.write_bytes(self.scenario_bytes)
        leaf.unlink()
        for name, place in (('symlink', lambda: leaf.symlink_to(target)),
                            ('hardlink', lambda: os.link(target, leaf)),
                            ('fifo', lambda: os.mkfifo(leaf))):
            with self.subTest(kind=name):
                place()
                with I.PinnedTree(self.root) as tree, self.assertRaisesRegex(ValueError, 'oversized file|checkout metadata'):
                    self.capture(tree)
                leaf.unlink()
        self.assertEqual(target.read_bytes(), self.scenario_bytes)

    def test_named_inode_replacement_with_identical_bytes_refuses(self):
        content = b'n' * (N.READ_CHUNK + 1)
        scenario = self.write(SCENARIO, content)
        leaf, replacement = self.root / SCENARIO, self.root / 'replacement'
        replacement.write_bytes(content)
        checks = 0
        with self.assertRaisesRegex(ValueError, 'directory changed|source changed while reading'), I.PinnedTree(self.root) as tree:
            def replace_during_read():
                nonlocal checks
                if SCENARIO in tree.files:
                    checks += 1
                    if checks == 2:
                        replacement.replace(leaf)

            self.capture(tree, (scenario, self.objects[1]), replace_during_read)
        self.assertFalse(replacement.exists())

    def test_growth_and_truncation_after_first_real_chunk_refuse(self):
        content = b'n' * (N.READ_CHUNK + 1)
        leaf = self.root / SCENARIO
        for grow, message in ((True, 'source grew'), (False, 'length changed')):
            with self.subTest(grow=grow):
                scenario = self.write(SCENARIO, content)
                checks = 0
                with self.assertRaisesRegex(ValueError, message), I.PinnedTree(self.root) as tree:
                    def resize_during_read():
                        nonlocal checks
                        if SCENARIO in tree.files:
                            checks += 1
                            if checks == 2:
                                if grow:
                                    with leaf.open('ab') as stream:
                                        stream.write(b'!')
                                else:
                                    leaf.write_bytes(b'')

                    self.capture(tree, (scenario, self.objects[1]), resize_during_read)
                self.assertEqual(checks, 2 if not grow else 3)

    def test_exact_file_and_aggregate_bounds_pass_with_real_bytes(self):
        block = b'x' * N.MAX_FILE
        scenario = self.write(SCENARIO, block)
        empty_capture = self.write(CAPTURE, b'')
        extras = tuple(self.write(f'lib/navigation/block-{number:02}', block) for number in range(15))
        objects = (scenario, empty_capture, *extras)
        with I.PinnedTree(self.root) as tree:
            facts = self.capture(tree, objects)
        self.assertEqual(facts.scenario, block)
        self.assertEqual(max(item.size for item in facts.ordinary), 2 * 1024**2)
        self.assertEqual(sum(item.size for item in facts.ordinary), 32 * 1024**2)
        overflow = row('lib/navigation/overflow', '100644', 1, 'a' * 40)
        self.refuse_before_read(inventory(objects) + overflow, objects, 'source exceeds bounds')
        oversize = row('lib/navigation/oversize', '100644', N.MAX_FILE + 1, 'a' * 40)
        self.refuse_before_read(inventory(self.objects) + oversize, self.objects, 'source exceeds bounds')

    def test_exact_combined_member_limit_and_oversized_raw_inventory(self):
        extra = tuple(self.write(f'lib/navigation/item-{number:04}', b'') for number in range(2042))
        objects = self.objects + extra
        with I.PinnedTree(self.root) as tree:
            self.assertEqual(len(self.capture(tree, objects).ordinary), 2044)
        more = row('lib/navigation/extra', '100644', 0, 'a' * 40)
        self.refuse_before_read(inventory(objects) + more, objects, 'inventory member limit exceeded')
        self.refuse_before_read(b'x' * N.MAX_INVENTORY + b'\0', objects, 'invalid bounded navigation Git inventory')

    def test_owner_clock_closes_during_real_stream_without_facts(self):
        scenario = self.write(SCENARIO, b'x' * (N.READ_CHUNK + 1))
        checks = 0
        with I.PinnedTree(self.root) as tree:
            def deadline():
                nonlocal checks
                if SCENARIO in tree.files:
                    checks += 1
                    if checks == 2:
                        raise TimeoutError('clock closed after first ordinary chunk')

            with self.assertRaisesRegex(TimeoutError, 'after first ordinary chunk'):
                self.capture(tree, (scenario, self.objects[1]), deadline)
        self.assertEqual(checks, 2)

    def test_terminal_real_tree_recheck_catches_earlier_read_member_replaced(self):
        leaf = self.root / CAPTURE
        replacement = self.root / 'replacement'
        replacement.write_bytes(b'fixture')

        class Tree(I.PinnedTree):
            def assert_unchanged(self):
                if replacement.exists():
                    replacement.replace(leaf)
                super().assert_unchanged()

        with self.assertRaisesRegex(ValueError, 'directory changed|file changed'), Tree(self.root) as tree:
            self.capture(tree)
        self.assertFalse(replacement.exists())

    def test_owner_clock_rechecks_after_successful_terminal_tree_walk(self):
        class Tree(I.PinnedTree):
            verified = False

            def assert_unchanged(self):
                super().assert_unchanged()
                self.verified = True

        with Tree(self.root) as tree:
            def deadline():
                if tree.verified:
                    raise TimeoutError('clock closed after terminal tree walk')

            with self.assertRaisesRegex(TimeoutError, 'after terminal tree walk'):
                self.capture(tree, check_clock=deadline)


if __name__ == '__main__':
    unittest.main()
