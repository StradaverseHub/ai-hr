"""Navigation source custody controls with tracked and synthetic file bytes only."""
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from time import monotonic_ns
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
            # Let the tree see the stream error so its final check can attach its refusal.
            with (self.assertRaisesRegex(ValueError, '^fixed navigation history changed while reading$') as refusal,
                  I.PinnedTree(root) as tree):
                def replace_after_first_chunk():
                    nonlocal checked_while_open
                    if FIRST.path in tree.files:
                        checked_while_open += 1
                    if checked_while_open == 2:
                        replacement.replace(leaf)

                H.capture_navigation_history(tree, INVENTORY, replace_after_first_chunk)
            self.assertFalse(replacement.exists())
            self.assertIn('Inventory final identity proof refused: ValueError', refusal.exception.__notes__)


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
                tree = Mock(spec_set=I.PinnedTree)
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
            with (patch.object(H, 'HISTORY_PINS', tuple(pins)),
                  self.assertRaisesRegex(ValueError, 'inventory file changed after reading') as refusal,
                  I.PinnedTree(root) as tree):
                def change_earlier_member():
                    nonlocal changed
                    if not changed and pins[-1].path in tree.files:
                        scenario_file = root / SCENARIO
                        before = scenario_file.stat()
                        scenario_file.write_bytes(b'changed!')
                        os.utime(scenario_file, ns=(before.st_atime_ns, before.st_mtime_ns + 1_000_000_000))
                        changed = True

                H.capture_navigation_handoff(tree, inventory, (scenario, collector), change_earlier_member)
            self.assertTrue(changed)
            self.assertIn('Inventory final identity proof refused: ValueError', refusal.exception.__notes__)


class NativeNavigationGitModel(unittest.TestCase):
    def deadline(self):
        return monotonic_ns() + 5_000_000_000

    def test_fixed_commands_capture_committed_navigation_inventory_and_raw_blobs(self):
        revision = subprocess.run(('/usr/bin/git', 'rev-parse', 'HEAD'), cwd=ROOT,
                                  env=H._GIT_ENV, check=True, capture_output=True,
                                  timeout=1).stdout.decode('ascii').strip()
        with I.PinnedTree(ROOT) as tree:
            facts = H._acquire_navigation_git_sources(tree, revision, self.deadline())
        expected = H._read_inventory(facts.inventory, tick)
        self.assertEqual(tuple(obj.member for obj in facts.ordinary), H._ordinary_members(expected))
        self.assertEqual(sum(row.path in {pin.path for pin in H.HISTORY_PINS} for row in expected), 4)
        actual = {obj.member.path: obj for obj in facts.ordinary}
        for path in H.REQUIRED_ORDINARY:
            raw = (ROOT / path).read_bytes()
            self.assertEqual(actual[path].member.size, len(raw))
            self.assertEqual(actual[path].member.git_blob,
                             hashlib.sha1(f'blob {len(raw)}\0'.encode() + raw, usedforsecurity=False).hexdigest())
            self.assertEqual(actual[path].sha256, hashlib.sha256(raw).hexdigest())

    def test_alternate_worktree_and_promisor_inputs_refuse_before_git(self):
        core = b'[core]\n\tsparseCheckout = false\n'
        for path, marker, contents, shape in (
            ('.git/commondir', 'common-directory', None, 'nonregular'),
            ('.git/gitdir', 'git-directory', None, 'nonregular'),
            ('.git/config.worktree', 'worktree-config', None, 'nonregular'),
            ('.git/config.worktree', 'worktree-config', b'', 'regular-empty'),
            ('.git/config.worktree', 'worktree-config', core.replace(b'false', b'true'), 'regular-nonempty'),
            ('.git/config.worktree', 'worktree-config', core + b'\tsparseCheckoutCone = true\n', 'regular-nonempty'),
            ('.git/config.worktree', 'worktree-config', core + b'[index]\n\tsparse = true\n', 'regular-nonempty'),
            ('.git/config.worktree', 'worktree-config', core + b'[include]\n\tpath = outside\n', 'regular-nonempty'),
            ('.git/config.worktree', 'worktree-config', core + b'\tsparseCheckout = false\n', 'regular-nonempty'),
            ('.git/config.worktree', 'worktree-config', core + b'\tworktree = outside\n', 'regular-nonempty'),
            ('.git/config.worktree', 'worktree-config', b'x' * 129, 'regular-nonempty'),
            ('.git/objects/info/alternates', 'object-alternates', None, 'nonregular'),
            ('.git/objects/info/http-alternates', 'object-http-alternates', None, 'nonregular'),
            ('.git/objects/pack/pack-model.promisor', None, b'', None),
        ):
            with self.subTest(path=path, shape=shape), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                for directory in ('.git/objects/info', '.git/objects/pack'):
                    (root / directory).mkdir(parents=True)
                if contents is not None:
                    (root / path).write_bytes(contents)
                    self.assertTrue((root / path).is_file())
                else:
                    (root / path).symlink_to('/unused-external-store')
                with I.PinnedTree(root) as tree, patch.object(H, '_git_navigation_pipe') as start:
                    reason = 'alternate store or worktree refused' if marker else 'object pack catalogue refused'
                    with self.assertRaisesRegex(ValueError, reason) as refused:
                        H._check_git_store(tree, self.deadline())
                    notes = [f'Navigation Git alias marker {marker} {shape}'] if marker else []
                    self.assertEqual(getattr(refused.exception, '__notes__', []), notes)
                    start.assert_not_called()

    def test_disabled_sparse_worktree_file_is_inert_only_without_extension(self):
        core = b'[core]\n\tsparseCheckout = false\n'
        stock = core + b'\tsparseCheckoutCone = false\n[index]\n\tsparse = false\n'
        baseline = (b'[core]\nrepositoryformatversion=0\nbare=false\n'
                    b'[remote "origin"]\nurl=https://github.com/StradaverseHub/ai-hr\n')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            for directory in ('.git/objects/info', '.git/objects/pack'):
                (root / directory).mkdir(parents=True)
            config, worktree = root / '.git/config', root / '.git/config.worktree'
            config.write_bytes(baseline)
            for raw in (core, stock):
                worktree.write_bytes(raw)
                with I.PinnedTree(root) as tree:
                    H._check_git_store(tree, self.deadline())
                    tree.assert_unchanged()

            alias = root / '.git/worktree-fixture-link'
            os.link(worktree, alias)
            with I.PinnedTree(root) as tree, patch.object(H, '_git_navigation_pipe') as start:
                with self.assertRaisesRegex(ValueError, 'alternate store or worktree refused'):
                    H._check_git_store(tree, self.deadline())
                start.assert_not_called()
            alias.unlink()

            config.write_bytes(baseline + b'[extensions]\nworktreeConfig = true\n')
            with I.PinnedTree(root) as tree, self.assertRaisesRegex(ValueError, 'unsupported setting'):
                H._check_git_store(tree, self.deadline())
            config.write_bytes(baseline)

            with self.assertRaisesRegex(ValueError, '^inventory file changed after reading$'), I.PinnedTree(root) as tree:
                H._check_git_store(tree, self.deadline())
                worktree.write_bytes(stock + b'\n')

    def test_local_configuration_refuses_external_helpers_includes_and_duplicates(self):
        baseline = (b'[core]\nrepositoryformatversion=0\nbare=false\n'
                    b'[remote "origin"]\nurl=https://github.com/StradaverseHub/ai-hr\n')
        bad = (b'[include]\npath=/unused-external-config\n', b'[extensions]\npartialClone=origin\n',
               b'[filter "outside"]\nprocess=outside-command\n', b'url=https://github.com/StradaverseHub/ai-hr\n')
        for tail in (b'', *bad):
            with self.subTest(tail=tail), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                (root / '.git').mkdir()
                (root / '.git/config').write_bytes(baseline + tail)
                with I.PinnedTree(root) as tree:
                    if tail:
                        with self.assertRaisesRegex(ValueError, 'unsupported setting'):
                            H._check_git_config(tree, self.deadline())
                    else:
                        H._check_git_config(tree, self.deadline())
                        with self.assertRaisesRegex(ValueError, 'trailing bytes'):
                            with H._git_navigation_pipe(('config', '--null', '--no-includes',
                                                         '--file', str(root / '.git/config'), '--list'),
                                                        self.deadline()):
                                pass

    def test_batch_raw_oid_and_member_framing_fail_closed(self):
        class Pipe(io.BytesIO):
            def request(self, oid):
                requests.append(oid)

        payload = b'known'
        oid = hashlib.sha1(b'blob 5\0' + payload, usedforsecurity=False).hexdigest()
        member = H.BoundedHarnessMember('scripts/performance/navigation-scenarios.json', '100644', 5, oid)
        header = f'{oid} blob 5\n'.encode('ascii')
        requests = []
        valid = header + payload + b'\n'
        self.assertEqual(H._read_git_objects(Pipe(valid * 2), (member, member)),
                         (H.NavigationOrdinaryGitObject(member, hashlib.sha256(payload).hexdigest()),) * 2)
        self.assertEqual(requests, [oid, oid])
        for raw, reason in (
            (b'', 'truncated'), (header[:-1], 'truncated'), (header + payload[:-1], 'truncated'),
            (header + b'other\n', 'framing or bytes'), (valid[:-1] + b'!', 'framing or bytes'),
            (b'0' + valid[1:], 'header differs'), (valid + b'\n' + valid, 'header differs'),
        ):
            with self.subTest(reason=reason), self.assertRaisesRegex(ValueError, reason):
                H._read_git_objects(Pipe(raw), (member, member))

    def test_deadline_and_unprotected_view_refuse_without_a_child(self):
        with I.PinnedTree(ROOT) as tree, patch.object(H.subprocess, 'Popen') as start:
            with self.assertRaisesRegex(ValueError, 'protected nonroot'):
                H.acquire_navigation_git_sources(tree, OID, self.deadline())
            with self.assertRaisesRegex(ValueError, 'deadline closed'):
                with H._git_navigation_pipe((), monotonic_ns()):
                    pass
            start.assert_not_called()

    def test_silent_unclosed_stderr_uses_work_cutoff_and_reserved_reap(self):
        stdout_read, stdout_write = os.pipe()
        stderr_read, stderr_write = os.pipe()
        os.close(stdout_write)
        native_select = H.select.select
        deadline = 5_000_000_000
        now = deadline - 2 * H._GIT_REAP_RESERVE_NS
        selected_timeouts = []

        def select_until(readers, writers, errors, timeout):
            nonlocal now
            selected_timeouts.append(timeout)
            ready = native_select(readers, writers, errors, 0)
            if not ready[0]:
                now = deadline - H._GIT_REAP_RESERVE_NS
            return ready

        try:
            with os.fdopen(stdout_read, 'rb', buffering=0) as stdout, os.fdopen(stderr_read, 'rb', buffering=0) as stderr:
                child = Mock(stdin=None, stdout=stdout, stderr=stderr)
                child.poll.return_value = None
                child.wait.return_value = -9
                with patch.object(H.subprocess, 'Popen', return_value=child), patch.object(
                    H, 'monotonic_ns', side_effect=lambda: now,
                ), patch.object(H.select, 'select', side_effect=select_until):
                    with self.assertRaisesRegex(ValueError, 'deadline closed') as refused:
                        with H._git_navigation_pipe((), deadline):
                            pass
                self.assertIsNone(getattr(refused.exception, '__notes__', None))
                self.assertEqual(selected_timeouts, [1, 1])
                child.kill.assert_called_once_with()
                child.wait.assert_called_once_with(timeout=1)
                self.assertTrue(stdout.closed and stderr.closed)
        finally:
            os.close(stderr_write)

    def test_unproved_git_reap_keeps_first_error_and_original_deadline(self):
        deadline = 5_000_000_000
        note = 'Navigation Git child settlement unproved within original deadline'
        for outcome in ('reaped', 'timeout', 'late', 'no-reserve'):
            with self.subTest(outcome=outcome):
                now = deadline - 2 * H._GIT_REAP_RESERVE_NS
                child = Mock(stdin=None, stdout=Mock(), stderr=Mock())
                child.poll.return_value = None
                child.stdout.fileno.return_value = 7
                child.stderr.fileno.return_value = 8
                first = ValueError('primary Git model refusal')

                def wait_for_child(timeout):
                    nonlocal now
                    self.assertEqual(timeout, 1)
                    if outcome == 'timeout':
                        raise subprocess.TimeoutExpired('model', timeout)
                    if outcome == 'late':
                        now = deadline
                    return -9

                child.wait.side_effect = wait_for_child
                with patch.object(H.subprocess, 'Popen', return_value=child), patch.object(
                    H.os, 'set_blocking',
                ), patch.object(H, 'monotonic_ns', side_effect=lambda: now):
                    with self.assertRaises(ValueError) as refused:
                        with H._git_navigation_pipe((), deadline):
                            now = deadline if outcome == 'no-reserve' else deadline - H._GIT_REAP_RESERVE_NS
                            raise first
                self.assertIs(refused.exception, first)
                self.assertEqual(getattr(first, '__notes__', []), [] if outcome == 'reaped' else [note])
                if outcome == 'no-reserve':
                    child.poll.assert_not_called()
                    child.kill.assert_not_called()
                    child.wait.assert_not_called()
                else:
                    child.kill.assert_called_once_with()
                    child.wait.assert_called_once_with(timeout=1)
                child.stdout.close.assert_called_once_with()
                child.stderr.close.assert_called_once_with()

    def test_reap_returned_after_work_cutoff_cannot_admit_git_result(self):
        stdout_read, stdout_write = os.pipe()
        stderr_read, stderr_write = os.pipe()
        os.close(stdout_write)
        os.close(stderr_write)
        deadline = 5_000_000_000
        now = deadline - 2 * H._GIT_REAP_RESERVE_NS
        with os.fdopen(stdout_read, 'rb', buffering=0) as stdout, os.fdopen(stderr_read, 'rb', buffering=0) as stderr:
            child = Mock(stdin=None, stdout=stdout, stderr=stderr)
            child.poll.return_value = 0

            def reap_late(timeout):
                nonlocal now
                self.assertEqual(timeout, 1)
                now = deadline - H._GIT_REAP_RESERVE_NS
                return 0

            child.wait.side_effect = reap_late
            with patch.object(H.subprocess, 'Popen', return_value=child), patch.object(
                H, 'monotonic_ns', side_effect=lambda: now,
            ):
                with self.assertRaisesRegex(ValueError, 'deadline closed') as refused:
                    with H._git_navigation_pipe((), deadline):
                        pass
            self.assertIsNone(getattr(refused.exception, '__notes__', None))
            child.wait.assert_called_once_with(timeout=1)
            child.poll.assert_called_once_with()
            child.kill.assert_not_called()
            self.assertTrue(stdout.closed and stderr.closed)


if __name__ == '__main__':
    unittest.main()
