/** Closed pre-candidate privileged helper closure. No caller-selected source paths. */
export const NATIVE_HELPER_SOURCES=Object.freeze(Object.fromEntries([
 'test_next_native.py','next_source.py','next_native_package.py','next_profile.py','controller.py',
 'next_fixture_poststart.py','next_fixture_filesystem.py','next_dependency_probe.cjs','next_build_binding.py',
].map(name=>[name,'deploy/admission/'+name]).concat(['runtime_inventory.py','build-bundle.py'].map(name=>[name,'.github/ci/'+name]))));
