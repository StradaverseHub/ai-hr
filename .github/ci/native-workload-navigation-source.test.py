"""Fixed history custody controls with tracked and synthetic file bytes only."""
import os
from pathlib import Path
import re
import sys
import tempfile
from types import ModuleType
import unittest
from unittest.mock import Mock

sys.dont_write_bytecode = True


def load_sibling(name, filename):
    source = Path(__file__).with_name(filename)
    module = ModuleType(name)
    module.__file__ = str(source)
    exec(compile(source.read_bytes(), str(source), 'exec', dont_inherit=True), module.__dict__)
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
                tree = Mock(spec_set=I.PinnedTree)
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
            with self.assertRaisesRegex(ValueError, 'inventory directory changed|history changed while reading') as refused, \
                 I.PinnedTree(root) as tree:
                def replace_after_first_chunk():
                    nonlocal checked_while_open
                    if FIRST.path in tree.files:
                        checked_while_open += 1
                    if checked_while_open == 2:
                        replacement.replace(leaf)

                H.capture_navigation_history(tree, INVENTORY, replace_after_first_chunk)
            self.assertIn('Inventory final identity proof refused: ValueError', refused.exception.__notes__)
            self.assertFalse(replacement.exists())


if __name__ == '__main__':
    unittest.main()
