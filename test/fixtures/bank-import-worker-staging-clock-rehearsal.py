"""Drive the prepared activation graph with measured and deadline-edge staging timings."""
import importlib.util
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

fixture_path = Path(__file__).with_name('bank-import-worker-prepared-tests.py')
spec = importlib.util.spec_from_file_location('prepared_fixture', fixture_path)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
ci = fixture.ci
fences = fixture.core.fences

# From the read-only staging scans and native web/ledger samples for build pDe2JKsQG-bY3fuGOGSVx.
SLOWEST_OBSERVED_SCAN = 13.238
SLOWEST_OBSERVED_PROBE = 1.4
# Stress inputs are synthetic. They bracket the failures seen at the live slot boundaries.
STRESS_PRE_START_PROBE = 7.25
STRESS_STABILITY_PROBE = 8.0
MUTATING_COMMANDS = {'start', 'stop', 'disable', 'enable', 'daemon-reload'}


def rehearse(case, *, delayed_slot=None, delayed_probe=None, additional_budget=0):
    with tempfile.TemporaryDirectory(prefix='staging-clock-rehearsal-') as directory:
        f = fixture.Fixture(Path(directory))
        preparation = f.prepare_record(recovery=True)
        proof = f.invoke_preparation(preparation)
        record = f.live_record(preparation, proof)
        metadata_calls = {}
        slot_check = ci.RuntimeObservation.slot
        capture = fences.capture_tree
        native = f.native
        sleep = f.sleep_port
        budgets = {}

        def slot(observer, name, seconds):
            budget = seconds + additional_budget if name.startswith(('F', 'W/F')) else seconds
            budgets[name] = budget
            return slot_check(observer, name, budget)

        def observation():
            return getattr(ci.ACTIVE_OPERATION_GUARD, 'observer', None)

        def timed_capture(*args, **kwargs):
            observer = observation()
            if observer is not None:
                name = observer.slot_name
                metadata_calls[name] = metadata_calls.get(name, 0) + 1
                if metadata_calls[name] == 1:
                    f.monotonic_offset += SLOWEST_OBSERVED_SCAN
            return capture(*args, **kwargs)

        def timed_native(argv, *args, **kwargs):
            observer = observation()
            if observer is not None and '-e' in argv:
                expression = argv[argv.index('-e') + 1]
                if expression.startswith(ci.FAST_PROBE.split('validateInstallGrant(grant);')[0]):
                    f.monotonic_offset += (delayed_probe if observer.slot_name == delayed_slot
                                           else SLOWEST_OBSERVED_PROBE)
            return native(argv, *args, **kwargs)

        def timed_sleep(seconds):
            if seconds == 4:
                f.monotonic_offset += seconds
            return sleep(seconds)

        f.native, f.sleep_port = timed_native, timed_sleep
        receipt, failure = None, None
        start_index = len(f.events)
        with patch.object(ci.RuntimeObservation, 'slot', slot), patch.object(fences, 'capture_tree', timed_capture):
            try:
                receipt = f.invoke_live(record)
            except (ValueError, RuntimeError) as error:
                failure = str(error)
        mutations = [event[1] for event in f.events[start_index:]
                     if isinstance(event, (list, tuple)) and len(event) > 1
                     and event[0] == '/usr/bin/systemctl' and event[1] in MUTATING_COMMANDS]
        outcome = {
            'kind': 'PREPARED_ACTIVATION_GRAPH_CLOCK_REHEARSAL_NOT_RELEASE',
            'case': case,
            'observedScanSeconds': SLOWEST_OBSERVED_SCAN,
            'observedProbeSeconds': SLOWEST_OBSERVED_PROBE,
            'syntheticSlowProbeSlot': delayed_slot,
            'syntheticSlowProbeSeconds': delayed_probe,
            'additionalPerFenceBudgetSeconds': additional_budget,
            'modeledMonotonicSeconds': round(f.monotonic_offset, 3),
            'fenceCaptures': metadata_calls,
            'fenceBudgets': budgets,
            'simulatedUnitActions': mutations,
            'receipt': bool(receipt),
            'diagnostic': failure,
            'releaseAuthorized': False,
        }
        if receipt:
            assert receipt['completeMetadataFences'] == 10 and receipt['fullNativeAudits'] == 2
            assert receipt['serviceStable'] is True and receipt['journeyVerified'] is False
            outcome.update(completeFences=10, fullAudits=2)
        print(json.dumps(outcome), flush=True)
        return receipt, failure, mutations, f.report


def main():
    nominal, failure, _, _ = rehearse('measured_worst_scan_and_probe')
    assert nominal and failure is None
    refused, failure, mutations, _ = rehearse(
        'pre_start_timeout', delayed_slot='F0', delayed_probe=STRESS_PRE_START_PROBE)
    assert not refused and any(word in failure for word in ('deadline', 'slot expired')) and not mutations
    refused, failure, mutations, report = rehearse(
        'stability_timeout', delayed_slot='F5', delayed_probe=STRESS_STABILITY_PROBE)
    assert not refused and 'activation failed' in failure and 'start' in mutations
    assert report['MainPID'] == '0' and report['UnitFileState'] == 'disabled'
    # Collect a separate planning-only counterfactual while preserving original controls.
    success, failure, _, _ = rehearse('counterfactual_stability_margin',
        delayed_slot='F5', delayed_probe=STRESS_STABILITY_PROBE, additional_budget=8)
    assert success and failure is None


if __name__ == '__main__':
    main()
