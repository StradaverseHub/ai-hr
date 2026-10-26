import ExpoModulesCore
import Foundation
import Darwin
import DeviceCheck

// Platform primitives only. No result from this module is a server-verified trust verdict.
public class AihrIntegrityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AihrIntegrity")

    Function("capabilities") { () -> [String: Any] in
      return [
        "version": 1, "platform": "ios",
        "appId": Bundle.main.bundleIdentifier ?? "",
        "appVersion": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
        "buildVersion": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
        "keyMechanism": DCAppAttestService.shared.isSupported ? "apple_app_attest" : "unsupported"
      ]
    }

    Function("clockSnapshot") { () -> [String: Any] in
      let before = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)
      let wall = Date().timeIntervalSince1970 * 1000
      let after = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)
      return ["source": "ios_continuous", "elapsedBeforeNs": String(before),
        "elapsedAfterNs": String(after), "wallTimeMs": wall,
        "bootId": self.bootSessionId().map { $0 as Any } ?? NSNull()]
    }

    AsyncFunction("generateAppleKey") { (promise: Promise) in
      guard DCAppAttestService.shared.isSupported else { self.unsupported(promise); return }
      DCAppAttestService.shared.generateKey { id, error in
        guard error == nil else { self.reject(error, promise); return }
        guard let id, !id.isEmpty, id.utf8.count <= 512 else { self.unavailable(promise); return }
        promise.resolve(id)
      }
    }

    AsyncFunction("attestAppleKey") { (id: String, hash: String, promise: Promise) in
      guard DCAppAttestService.shared.isSupported else { self.unsupported(promise); return }
      guard self.validKeyId(id), let data = self.hashData(hash) else { self.invalid(promise); return }
      // On serverUnavailable the owner must retry with this same key AND this same hash.
      DCAppAttestService.shared.attestKey(id, clientDataHash: data) { result, error in
        guard error == nil else { self.reject(error, promise); return }
        guard let result, !result.isEmpty, result.count <= 65536 else { self.unavailable(promise); return }
        promise.resolve(result.base64EncodedString())
      }
    }

    AsyncFunction("assertAppleKey") { (id: String, hash: String, promise: Promise) in
      guard DCAppAttestService.shared.isSupported else { self.unsupported(promise); return }
      guard self.validKeyId(id), let data = self.hashData(hash) else { self.invalid(promise); return }
      DCAppAttestService.shared.generateAssertion(id, clientDataHash: data) { result, error in
        guard error == nil else { self.reject(error, promise); return }
        guard let result, !result.isEmpty, result.count <= 8192 else { self.unavailable(promise); return }
        promise.resolve(result.base64EncodedString())
      }
    }

    // Cross-platform calls fail explicitly; no extractable JS key is substituted.
    AsyncFunction("createAndroidKey") { (_: String, _: String, _: Bool, promise: Promise) in self.unsupported(promise) }
    AsyncFunction("androidKeyInfo") { (_: String, promise: Promise) in self.unsupported(promise) }
    AsyncFunction("signAndroidCommand") { (_: String, _: String, promise: Promise) in self.unsupported(promise) }
    AsyncFunction("preparePlayIntegrity") { (_: String, promise: Promise) in self.unsupported(promise) }
    AsyncFunction("requestPlayIntegrity") { (_: String, promise: Promise) in self.unsupported(promise) }
  }

  private func validKeyId(_ id: String) -> Bool {
    return !id.isEmpty && id.utf8.count <= 512 && !id.contains("\0")
  }
  private func hashData(_ value: String) -> Data? {
    guard value.utf8.count == 44, let data = Data(base64Encoded: value), data.count == 32,
      data.base64EncodedString() == value else { return nil }
    return data
  }
  private func bootSessionId() -> String? {
    // May be unavailable on a device. Never invent a boot identity from wall time.
    var size: size_t = 0
    guard sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0, size > 1, size <= 128 else { return nil }
    var bytes = [CChar](repeating: 0, count: Int(size))
    let capacity = bytes.count
    let code = bytes.withUnsafeMutableBytes { raw in sysctlbyname("kern.bootsessionuuid", raw.baseAddress, &size, nil, 0) }
    guard code == 0, size > 1, size <= size_t(capacity), bytes[Int(size) - 1] == 0 else { return nil }
    return UUID(uuidString: String(cString: bytes))?.uuidString.lowercased()
  }
  private func invalid(_ promise: Promise) { promise.reject("ERR_INTEGRITY_INVALID_INPUT", "Invalid integrity input") }
  private func unsupported(_ promise: Promise) { promise.reject("ERR_INTEGRITY_UNSUPPORTED", "Device integrity capability is unsupported") }
  private func unavailable(_ promise: Promise) { promise.reject("ERR_INTEGRITY_UNAVAILABLE", "Device integrity operation unavailable") }
  private func reject(_ error: Error?, _ promise: Promise) {
    guard let dc = error as? DCError else { unavailable(promise); return }
    switch dc.code {
    case .featureUnsupported: unsupported(promise)
    case .invalidInput: invalid(promise)
    case .invalidKey: promise.reject("ERR_INTEGRITY_INVALID_KEY", "Device integrity key is unavailable")
    case .serverUnavailable: promise.reject("ERR_INTEGRITY_SERVER_UNAVAILABLE", "Attestation service unavailable; retain the same enrollment")
    default: unavailable(promise)
    }
  }
}
