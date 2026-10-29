Pod::Spec.new do |s|
  s.name           = 'AihrIntegrity'
  s.version        = '1.0.0'
  s.summary        = 'Device integrity primitives for AI HR'
  s.description    = 'Platform attestation key operations and a sleep-inclusive clock. Server verification remains authoritative.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true
  s.frameworks = 'DeviceCheck', 'Security'
  s.resource_bundles = {'AihrIntegrity_privacy' => ['PrivacyInfo.xcprivacy']}

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
