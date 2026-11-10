"""Source model for the optional pooled route in the closed managed Next environment.

The pooled URL and the pooler ceiling are admitted names. Their values may only reach the same owned
app-role database through a loopback pooler, and arrive together or not at all. Fictional values only.
"""
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'deploy/admission'))
import next_profile as N  # noqa: E402

DIRECT = 'postgres://ai_hr_app:fictional@127.0.0.1:5433/ai_hr_test_w1'
POOLED = 'postgres://ai_hr_app:fictional@127.0.0.1:6432/ai_hr_test_w1'


def environment(**changes):
    value = {'DATABASE_URL': DIRECT, 'DATABASE_POOLED_URL': POOLED, 'AIHR_DB_POOLER_SERVER_CONNECTIONS': '12'}
    value.update(changes)
    return {key: item for key, item in value.items() if item is not None}


class PooledEnvironmentModels(unittest.TestCase):
    def test_both_names_are_admitted_private_runtime_names(self):
        for name in ('DATABASE_POOLED_URL', 'AIHR_DB_POOLER_SERVER_CONNECTIONS'):
            self.assertIn(name, N.APP_ENVIRONMENT)
            self.assertFalse(N.forbidden_environment(name))
            self.assertNotIn(name, N.manager_unset_environment((name,)))

    def test_direct_only_and_complete_pooled_route_are_accepted(self):
        self.assertTrue(N.pooled_database_environment({'DATABASE_URL': DIRECT}))
        self.assertTrue(N.pooled_database_environment(environment()))
        self.assertTrue(N.pooled_database_environment(environment(AIHR_DB_POOLER_SERVER_CONNECTIONS='1000')))

    def test_one_name_without_the_other_refuses(self):
        self.assertFalse(N.pooled_database_environment(environment(DATABASE_POOLED_URL=None)))
        self.assertFalse(N.pooled_database_environment(environment(AIHR_DB_POOLER_SERVER_CONNECTIONS=None)))

    def test_a_different_role_database_host_or_credential_refuses(self):
        for pooled in ('postgres://ai_hr_owner:fictional@127.0.0.1:6432/ai_hr_test_w1',
                       'postgres://ai_hr_app:fictional@127.0.0.1:6432/ai_hr_test_w2',
                       'postgres://ai_hr_app:fictional@10.0.0.5:6432/ai_hr_test_w1',
                       'postgres://ai_hr_app:other@127.0.0.1:6432/ai_hr_test_w1',
                       'postgresql://ai_hr_app:fictional@127.0.0.1:6432/ai_hr_test_w1'):
            self.assertFalse(N.pooled_database_environment(environment(DATABASE_POOLED_URL=pooled)), pooled)

    def test_the_database_itself_options_and_malformed_ports_refuse(self):
        for pooled in (DIRECT, POOLED + '?options=-csearch_path%3Dx', POOLED + '#x',
                       'postgres://ai_hr_app:fictional@127.0.0.1/ai_hr_test_w1',
                       'postgres://ai_hr_app:fictional@127.0.0.1:99999/ai_hr_test_w1'):
            self.assertFalse(N.pooled_database_environment(environment(DATABASE_POOLED_URL=pooled)), pooled)

    def test_the_ceiling_is_a_bounded_canonical_integer(self):
        for ceiling in ('0', '01', '1001', '-1', '12 ', '', 'twelve', '1e3'):
            self.assertFalse(N.pooled_database_environment(environment(AIHR_DB_POOLER_SERVER_CONNECTIONS=ceiling)), ceiling)


if __name__ == '__main__':
    unittest.main()
