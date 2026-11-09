"""Navigation source custody controls with tracked and synthetic file bytes only."""
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True


def load_sibling(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


H = load_sibling('native_navigation_source_model', 'native-workload-navigation-source.py')
I = load_sibling('native_navigation_pinned_tree', 'runtime_inventory.py')
ROOT = Path(__file__).resolve().parents[2]
OID = 'a' * 40


def row(path, size, oid=OID, mode='100644', kind='blob'):
    return f'{mode} {kind} {oid} {size:>7}\t{path}\0'.encode('ascii')


ANCHORS = b''.join(row(path, 1) for path in sorted(H.REQUIRED_ORDINARY))
HISTORY = tuple(row(pin.path, pin.size, pin.git_blob) for pin in H.HISTORY_PINS)
INVENTORY = ANCHORS + b''.join(HISTORY)
FIRST = H.HISTORY_PINS[0]


def tick():
    pass


class NativeNavigationHistoryModel(unittest.TestCase):
    def test_exact_current_roots_and_four_whole_tracked_checkout_objects(self):
        old_protocol = (ROOT / 'scripts/performance/navigation-protocol.ts').read_bytes()
        declared = re.search(rb'NAVIGATION_HARNESS_ROOTS=\[(.*?)\]', old_protocol).group(1)
        self.assertEqual(tuple(x.decode('ascii') for x in re.findall(rb"'([^']+)'", declared)), H.HARNESS_ROOTS)
        self.assertEqual(len(H.HISTORY_PINS), 4)
        self.assertEqual(sum(pin.size for pin in H.HISTORY_PINS), 73681717)
        self.assertEqual(len({pin.path for pin in H.HISTORY_PINS}), 4)
        with I.PinnedTree(ROOT) as tree:
            facts = H.capture_navigation_history(tree, INVENTORY, tick)
        self.assertEqual(tuple(member.path for member in facts.ordinary), tuple(sorted(H.REQUIRED_ORDINARY)))
        self.assertEqual(tuple(facts.history), tuple(
            (pin.path, '100644', pin.size, pin.git_blob, pin.sha256) for pin in H.HISTORY_PINS))

    def test_missing_duplicate_renamed_foreign_and_invalid_roles_refuse_before_read(self):
        incomplete = ANCHORS + b''.join(HISTORY[1:])
        variants = (
            (incomplete, 'history inventory incomplete'),
            (INVENTORY + HISTORY[0], 'duplicate'),
            (incomplete + row(FIRST.path + '.bak', FIRST.size, FIRST.git_blob), 'source exceeds bounds'),
            (INVENTORY + row('foreign/test.py', 1), 'outside fixed roots'),
            (INVENTORY + row('deploy/admission/../history.json', 1), 'outside fixed roots'),
            (INVENTORY + row('deploy/admission', 1), 'outside fixed roots'),
            (INVENTORY + row('components/sidebar.tsx/injected', 1), 'outside fixed roots'),
            (incomplete + row(FIRST.path, FIRST.size, OID), 'history Git metadata differs'),
            (incomplete + row(FIRST.path, FIRST.size - 1, FIRST.git_blob), 'history Git metadata differs'),
            (incomplete + row(FIRST.path, FIRST.size, FIRST.git_blob, '100755'), 'history Git metadata differs'),
            (incomplete + row(FIRST.path, FIRST.size, FIRST.git_blob, '120000'), 'regular Git blob'),
            (INVENTORY[:-1], 'invalid bounded navigation Git inventory'),
        )
        for inventory, message in variants:
            with self.subTest(message=message):
                tree = Mock()
                with self.assertRaisesRegex(ValueError, message):
                    H.capture_navigation_history(tree, inventory, tick)
                tree.open_regular.assert_not_called()
                tree.assert_unchanged.assert_not_called()

    def test_live_caps_and_original_member_limit_hold_with_history(self):
        self.assertEqual((H.MAX_FILE, H.MAX_TOTAL, H.MAX_INVENTORY, H.MAX_MEMBERS, H.READ_CHUNK),
                         (2 * 1024**2, 32 * 1024**2, 32 * 1024**2, 2048, 256 * 1024))
        exact = INVENTORY + b''.join(row(f'deploy/admission/bounded-{n}', H.MAX_FILE) for n in range(15))
        exact += row('deploy/admission/bounded-final', H.MAX_FILE - 2)
        self.assertEqual(sum(item.size for item in H._partition(exact, tick)), H.MAX_TOTAL)
        paths = INVENTORY + b''.join(row(f'deploy/admission/member-{n}', 0) for n in range(2042))
        self.assertEqual(len(H._partition(paths, tick)), 2044)
        for inventory, message in (
            (INVENTORY + row('deploy/admission/other_inverse.json', H.MAX_FILE + 1), 'source exceeds bounds'),
            (exact + row('deploy/admission/one-more-byte', 1), 'source exceeds bounds'),
            (paths + row('deploy/admission/one-more-member', 0), 'member limit exceeded'),
            (b'x' * H.MAX_INVENTORY + b'\0', 'invalid bounded navigation Git inventory'),
        ):
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                H._partition(inventory, tick)

    def with_first_history(self, temporary):
        root = Path(temporary).resolve()
        leaf = root / FIRST.path
        leaf.parent.mkdir(parents=True)
        return root, leaf

    def test_exact_length_incorrect_real_file_is_not_a_history_fact(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, leaf = self.with_first_history(temporary)
            with leaf.open('wb') as stream:
                stream.truncate(FIRST.size)
            with I.PinnedTree(root) as tree, self.assertRaisesRegex(ValueError, 'history bytes differ'):
                H.capture_navigation_history(tree, INVENTORY, tick)

    def test_symlink_hardlink_and_nonregular_refuse_through_pinned_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, leaf = self.with_first_history(temporary)
            target = root / 'target'
            with target.open('wb') as stream:
                stream.truncate(FIRST.size)
            for kind, place in (('symlink', lambda: leaf.symlink_to(target)),
                                ('hardlink', lambda: os.link(target, leaf)),
                                ('fifo', lambda: os.mkfifo(leaf))):
                with self.subTest(kind=kind):
                    place()
                    with I.PinnedTree(root) as tree, self.assertRaisesRegex(ValueError, 'oversized file|checkout metadata'):
                        H.capture_navigation_history(tree, INVENTORY, tick)
                    leaf.unlink()

    def test_first_real_stream_has_no_result_after_clock_closes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, leaf = self.with_first_history(temporary)
            with leaf.open('wb') as stream:
                stream.truncate(FIRST.size)
            checked_while_open = 0
            with I.PinnedTree(root) as tree:
                def check_clock():
                    nonlocal checked_while_open
                    if FIRST.path in tree.files:
                        checked_while_open += 1
                    if checked_while_open == 2:
                        raise TimeoutError('existing owner clock closed after first chunk')

                with self.assertRaisesRegex(TimeoutError, 'after first chunk'):
                    H.capture_navigation_history(tree, INVENTORY, check_clock)
            self.assertEqual(checked_while_open, 2)

    def test_named_file_replacement_during_read_does_not_validate_held_inode(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, leaf = self.with_first_history(temporary)
            replacement = root / 'replacement'
            for path in (leaf, replacement):
                with path.open('wb') as stream:
                    stream.truncate(FIRST.size)
            checked_while_open = 0
            with I.PinnedTree(root) as tree:
                def replace_after_first_chunk():
                    nonlocal checked_while_open
                    if FIRST.path in tree.files:
                        checked_while_open += 1
                    if checked_while_open == 2:
                        replacement.replace(leaf)

                with self.assertRaisesRegex(ValueError, 'inventory directory changed|history changed while reading'):
                    H.capture_navigation_history(tree, INVENTORY, replace_after_first_chunk)
            self.assertFalse(replacement.exists())


SCENARIO = 'scripts/performance/navigation-scenarios.json'
COLLECTOR = 'scripts/performance/navigation-browser-capture.ts'


def ordinary_object(path, content):
    git_blob = hashlib.sha1(f'blob {len(content)}\0'.encode() + content, usedforsecurity=False).hexdigest()
    return H.NavigationOrdinaryGitObject(
        H.BoundedHarnessMember(path, '100644', len(content), git_blob),
        hashlib.sha256(content).hexdigest(),
    )


def ordinary_row(value):
    member = value.member
    return row(member.path, member.size, member.git_blob, member.mode)


class NativeNavigationHandoffModel(unittest.TestCase):
    def test_handoff_binds_the_raw_scenario_and_four_real_histories_in_inventory_order(self):
        scenario_bytes = (ROOT / SCENARIO).read_bytes()
        scenario = ordinary_object(SCENARIO, scenario_bytes)
        collector = ordinary_object(COLLECTOR, (ROOT / COLLECTOR).read_bytes())
        inventory = HISTORY[0] + ordinary_row(scenario) + b''.join(HISTORY[1:]) + ordinary_row(collector)
        with I.PinnedTree(ROOT) as tree:
            result = H.capture_navigation_handoff(tree, inventory, (collector, scenario), tick)

        self.assertEqual(result.inventory_sha256, hashlib.sha256(inventory).hexdigest())
        self.assertEqual(result.scenario, scenario_bytes)
        expected = (
            (FIRST.path, '100644', FIRST.size, FIRST.git_blob, FIRST.sha256, 'startup-history'),
            (*scenario.member, scenario.sha256, 'ordinary'),
            *((pin.path, '100644', pin.size, pin.git_blob, pin.sha256, 'startup-history')
              for pin in H.HISTORY_PINS[1:]),
            (*collector.member, collector.sha256, 'ordinary'),
        )
        self.assertEqual(result.members, tuple((index, *member) for index, member in enumerate(expected)))

    def test_handoff_refuses_incomplete_or_duplicate_object_evidence_before_opening_any_file(self):
        scenario = ordinary_object(SCENARIO, b'{}')
        collector = ordinary_object(COLLECTOR, b'source')
        inventory = b''.join(HISTORY) + ordinary_row(collector) + ordinary_row(scenario)
        for objects, reason in (
            ((scenario,), 'evidence count differs'),
            ((scenario, scenario), 'duplicate ordinary navigation Git object evidence'),
            ((scenario, collector._replace(member=collector.member._replace(size=7))), 'metadata differs'),
        ):
            with self.subTest(reason=reason):
                tree = Mock()
                with self.assertRaisesRegex(ValueError, reason):
                    H.capture_navigation_handoff(tree, inventory, objects, tick)
                tree.open_regular.assert_not_called()
                tree.assert_unchanged.assert_not_called()

    def test_handoff_refuses_same_size_ordinary_bytes_and_earlier_member_change_at_final_walk(self):
        scenario = ordinary_object(SCENARIO, b'original')
        collector = ordinary_object(COLLECTOR, b'source')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            for path, data in ((SCENARIO, b'changed!'), (COLLECTOR, b'source')):
                leaf = root / path
                leaf.parent.mkdir(parents=True, exist_ok=True)
                leaf.write_bytes(data)
            ordinary = ordinary_row(scenario) + ordinary_row(collector)
            with I.PinnedTree(root) as tree, self.assertRaisesRegex(ValueError, 'checkout bytes differ'):
                H.capture_navigation_handoff(tree, ordinary + b''.join(HISTORY), (scenario, collector), tick)

            # Small synthetic inverse files let the real terminal walk observe a
            # change to the already read scenario during the last history read.
            (root / SCENARIO).write_bytes(b'original')
            pins = []
            for index, original in enumerate(H.HISTORY_PINS):
                data = f'synthetic {index}'.encode()
                leaf = root / original.path
                leaf.parent.mkdir(parents=True, exist_ok=True)
                leaf.write_bytes(data)
                evidence = ordinary_object(original.path, data)
                pins.append(H.HistoryPin(original.path, len(data), evidence.member.git_blob, evidence.sha256))
            inventory = ordinary + b''.join(row(pin.path, pin.size, pin.git_blob) for pin in pins)
            changed = False
            with patch.object(H, 'HISTORY_PINS', tuple(pins)), I.PinnedTree(root) as tree:
                def change_earlier_member():
                    nonlocal changed
                    if not changed and pins[-1].path in tree.files:
                        scenario_file = root / SCENARIO
                        before = scenario_file.stat()
                        scenario_file.write_bytes(b'changed!')
                        os.utime(scenario_file, ns=(before.st_atime_ns, before.st_mtime_ns + 1_000_000_000))
                        changed = True

                with self.assertRaisesRegex(ValueError, 'inventory file changed after reading'):
                    H.capture_navigation_handoff(tree, inventory, (scenario, collector), change_earlier_member)
            self.assertTrue(changed)


if __name__ == '__main__':
    unittest.main()
