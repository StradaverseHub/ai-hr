Pod::Spec.new do |s|
  s.name = 'AihrDocuments'
  s.version = '1.0.0'
  s.summary = 'Private local document review for OneHR+'
  s.description = 'Renders only protected cached PDF files using platform PDF engines.'
  s.author = ''
  s.homepage = 'https://docs.expo.dev/modules/'
  s.platforms = { :ios => '16.4' }
  s.source = { git: '' }
  s.static_framework = true
  s.frameworks = 'PDFKit', 'UIKit'
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
