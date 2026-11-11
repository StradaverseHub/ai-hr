"""Admit only the self-source parallel worker harness smoke.

The smoke exercises the build, per-runner cell and aggregate orchestration with the
short functional shape. It reads no secret, names no preflight and grants no comparison,
staging or release authority, so any same-repository branch may run it on its own head.
"""
import json
import os
import re
import sys

REPOSITORY = 'StradaverseHub/ai-hr'
REPOSITORY_ID = 1333414856
WORKFLOW_PATH = '.github/workflows/alpha-focused-checks.yml'
BRANCH = re.compile(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,199}')


def refuse(reason):
    print('Parallel worker harness smoke refused: ' + reason, file=sys.stderr, flush=True)
    raise SystemExit(1)


def unique(pairs):
    value = dict(pairs)
    if len(value) != len(pairs):
        raise ValueError('duplicate JSON field')
    return value


def expected_inputs(branch, sha, course='parallel-smoke'):
    return {
        'candidate_ref': branch, 'expected_sha': sha, 'selected_tests': '[]',
        'architecture_browser_development_preflight': 'false', 'employee_ascii_qualification': 'off',
        'measured_browser_course': course, 'measured_browser_preflight_run': '',
        'qualify_restricted_port_prerequisites': 'false', 'profile_database': 'false', 'duration_order': 'false',
        'run_typecheck': 'false', 'run_native_typecheck': 'false', 'run_native_swift_models': 'false',
        'run_native_bundle': 'false', 'run_build': 'false', 'model_eval': '', 'eval_budget_usd': '20',
        'eval_allowed_providers': '',
    }


def admit(env, event):
    sha = env.get('GITHUB_WORKFLOW_SHA', '')
    branch = env.get('GITHUB_REF_NAME', '')
    ref = 'refs/heads/' + branch
    if not re.fullmatch(r'[a-f0-9]{40}', sha) or not BRANCH.fullmatch(branch) or '..' in branch:
        refuse('source or branch identity')
    required = {
        'GITHUB_ACTIONS': 'true', 'CI': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux',
        'RUNNER_ARCH': 'X64', 'GITHUB_REPOSITORY': REPOSITORY, 'GITHUB_REPOSITORY_ID': str(REPOSITORY_ID),
        'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_WORKFLOW': 'alpha-focused-checks', 'GITHUB_JOB': 'resolve',
        'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_REF': ref, 'GITHUB_REF_TYPE': 'branch',
        'GITHUB_WORKFLOW_REF': REPOSITORY + '/' + WORKFLOW_PATH + '@' + ref, 'GITHUB_SHA': sha,
        'AIHR_CI_CONTROL_HEAD': sha, 'STAGING_ENABLED': 'false', 'PRODUCTION_ENABLED': 'false',
    }
    if any(env.get(key) != value for key, value in required.items()):
        refuse('hosted event, runner or deployment policy')
    repo = event.get('repository') if type(event) is dict else None
    inputs = event.get('inputs') if type(event) is dict else None
    if type(repo) is not dict or type(inputs) is not dict:
        refuse('dispatch event shape')
    if (event.get('ref') not in (branch, ref) or repo.get('full_name') != REPOSITORY or repo.get('id') != REPOSITORY_ID
            or repo.get('private') is not False or repo.get('fork') is not False or repo.get('default_branch') != 'main'):
        refuse('repository identity')
    inputs = dict(inputs)
    # GitHub can omit explicitly supplied empty optional strings from the event.
    for key in ('model_eval', 'eval_allowed_providers', 'measured_browser_preflight_run'):
        inputs.setdefault(key, '')
    # The load-only control course has the same closed shape as the smoke: no secret, no preflight, no release authority.
    course = inputs.get('measured_browser_course') if inputs.get('measured_browser_course') in ('parallel-smoke', 'parallel-control', 'parallel-control-50', 'parallel-control-100') else 'parallel-smoke'
    if inputs != expected_inputs(branch, sha, course):
        refuse('dispatch inputs; the smoke runs only its own branch head with every other course off')
    return {'kind': 'PARALLEL_WORKER_HARNESS_SMOKE_ADMISSION_ONLY', 'releaseEligible': False, 'source': sha, 'branch': branch}


def main():
    path = os.environ.get('GITHUB_EVENT_PATH', '')
    try:
        with open(path, 'rb') as stream:
            raw = stream.read(65537)
        if not 0 < len(raw) <= 65536:
            refuse('event size')
        event = json.loads(raw, object_pairs_hook=unique)
    except (OSError, ValueError):
        refuse('event custody')
    print(json.dumps(admit(os.environ, event), separators=(',', ':')), flush=True)


if __name__ == '__main__':
    main()
