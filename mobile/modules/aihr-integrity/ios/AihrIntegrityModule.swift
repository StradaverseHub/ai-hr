import ExpoModulesCore
import Foundation
import Darwin
import DeviceCheck
import Security

private final class KeyRequests: @unchecked Sendable {
  let lock = NSLock()
  var active = Set<String>()
  var uncommitted = [String: String]()
}
private enum KeyStorageError: Error { case unavailable, invalidKey }

// Platform primitives only. No result from this module is a server-verified trust verdict.
public class AihrIntegrityModule: Module {
  private static let requests = KeyRequests()
  private static let proofs = AppAttestProofStore(persistence: AppAttestKeychainProofPersistence())
  private static let assertions = AppAttestAssertionStore(persistence: AppAttestKeychainAssertionPersistence())
  private static let runtimeId = UUID().uuidString.lowercased()
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
        "elapsedAfterNs": String(after), "wallTimeMs": wall, "localOnly": true,
        "runtimeId": Self.runtimeId, "bootId": NSNull()]
    }

    AsyncFunction("appleKeyInfo") { (alias: String, promise: Promise) in
      guard self.validAlias(alias) else { self.invalid(promise); return }
      do { promise.resolve(try self.cachedKey(alias)) } catch { self.rejectStorage(error, promise) }
    }

    AsyncFunction("generateAppleKey") { (alias: String, promise: Promise) in
      guard DCAppAttestService.shared.isSupported else { self.unsupported(promise); return }
      guard self.validAlias(alias) else { self.invalid(promise); return }
      let state = Self.requests
      state.lock.lock()
      guard !state.active.contains(alias), state.active.count < 4, state.uncommitted.count < 4 || state.uncommitted[alias] != nil else {
        state.lock.unlock(); promise.reject("ERR_INTEGRITY_IN_PROGRESS", "Retain the pending enrollment"); return
      }
      state.active.insert(alias)
      let unfinished = state.uncommitted[alias]
      state.lock.unlock()
      do {
        if let cached = try self.cachedKey(alias) { self.finish(alias); promise.resolve(cached); return }
        if let unfinished { try self.saveKey(unfinished, alias); self.finish(alias); promise.resolve(unfinished); return }
      } catch { self.finish(alias, retain: true); self.rejectStorage(error, promise); return }
      DCAppAttestService.shared.generateKey { id, error in
        guard error == nil else { self.finish(alias); self.reject(error, promise); return }
        guard let id, self.validKeyId(id) else { self.finish(alias); self.unavailable(promise); return }
        state.lock.lock(); state.uncommitted[alias] = id; state.lock.unlock()
        // Commit the identifier before resolving JS, even if its caller's UI deadline has passed.
        do { try self.saveKey(id, alias); self.finish(alias); promise.resolve(id) }
        catch { self.finish(alias, retain: true); self.rejectStorage(error, promise) }
      }
    }

    AsyncFunction("appleAttestationInfo") { (id: String, hash: String, promise: Promise) in
      guard self.validKeyId(id), self.hashData(hash) != nil else { self.invalid(promise); return }
      do {
        switch try Self.proofs.snapshot(keyId: id, hash: hash) {
        case .absent: promise.resolve(["state": "absent"])
        case .requested: promise.resolve(["state": "requested"])
        case .retryable: promise.resolve(["state": "retryable"])
        case .completed(let data): promise.resolve(["state": "completed", "attestation": data.base64EncodedString()])
        case .released: promise.resolve(["state": "released"])
        }
      } catch { self.reject(error, promise) }
    }

    AsyncFunction("releaseAppleAttestation") { (id: String, hash: String, promise: Promise) in
      do { try Self.proofs.release(keyId: id, hash: hash); promise.resolve(nil) }
      catch { self.reject(error, promise) }
    }

    // The verified first-install owner calls this before restoring credentials or creating its marker.
    // Clearing metadata does not revoke a server key or pretend to delete an App Attest private key.
    AsyncFunction("resetAppleIntegrityInstallation") { (promise: Promise) in
      let state = Self.requests
      state.lock.lock(); defer { state.lock.unlock() }
      guard state.active.isEmpty && state.uncommitted.isEmpty else {
        promise.reject("ERR_INTEGRITY_IN_PROGRESS", "Retain the pending enrollment"); return
      }
      do {
        try Self.assertions.resetInstallation {
          try Self.proofs.resetInstallation {
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
              kSecAttrService as String: "aihr.integrity.app-attest.v1"]
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw AppAttestProofError.storageUnavailable }
          }
        }
        promise.resolve(nil)
      } catch { self.reject(error, promise) }
    }

    AsyncFunction("attestAppleKey") { (id: String, hash: String, promise: Promise) in
      guard DCAppAttestService.shared.isSupported else { self.unsupported(promise); return }
      guard self.validKeyId(id), let data = self.hashData(hash) else { self.invalid(promise); return }
      // Persist intent before DeviceCheck, then persist the artifact before resolving JavaScript.
      // Only a known serverUnavailable result permits an explicit same-key/same-hash retry.
      Self.proofs.request(keyId: id, hash: hash,
        retryable: { ($0 as? DCError)?.code == .serverUnavailable },
        vendor: { complete in
          DCAppAttestService.shared.attestKey(id, clientDataHash: data) { result, error in
            if let error { complete(.failure(error)) }
            else if let result { complete(.success(result)) }
            else { complete(.failure(AppAttestProofError.malformedProof)) }
          }
        }, completion: { result in
          switch result {
          case .success(let data): promise.resolve(data.base64EncodedString())
          case .failure(let error): self.reject(error, promise)
          }
        })
    }

    AsyncFunction("appleOfflineProofInfo") { (id: String, hash: String, promise: Promise) in
      do {
        switch try Self.assertions.snapshot(keyId: id, hash: hash) {
        case .absent: promise.resolve(["state": "absent"])
        case .requested(let canRetry): promise.resolve(["state": "requested", "canRetry": canRetry])
        case .retryable: promise.resolve(["state": "retryable"])
        case .completed(let proof): promise.resolve(["state": "completed", "assertion": proof.base64EncodedString()])
        }
      } catch { self.reject(error, promise) }
    }
    AsyncFunction("releaseAppleOfflineProof") { (id: String, hash: String, promise: Promise) in
      do { try Self.assertions.release(keyId: id, hash: hash); promise.resolve(nil) }
      catch { self.reject(error, promise) }
    }
    AsyncFunction("assertAppleOfflineKey") { (id: String, hash: String, promise: Promise) in
      guard DCAppAttestService.shared.isSupported else { self.unsupported(promise); return }
      guard self.validKeyId(id), let data = self.hashData(hash) else { self.invalid(promise); return }
      Self.assertions.request(keyId: id, hash: hash,
        retryable: { ($0 as? DCError)?.code == .serverUnavailable },
        vendor: { complete in
          DCAppAttestService.shared.generateAssertion(id, clientDataHash: data) { result, error in
            if let error { complete(.failure(error)) }
            else if let result { complete(.success(result)) }
            else { complete(.failure(AppAttestProofError.malformedProof)) }
          }
        }, completion: { result in
          switch result {
          case .success(let proof): promise.resolve(proof.base64EncodedString())
          case .failure(let error): self.reject(error, promise)
          }
        })
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
  private func validAlias(_ alias: String) -> Bool {
    return alias.utf8.count == 69 && alias.range(of: "^aihr_[0-9a-f]{64}$", options: .regularExpression) != nil
  }
  private func finish(_ alias: String, retain: Bool = false) {
    let state = Self.requests
    state.lock.lock(); state.active.remove(alias); if !retain { state.uncommitted.removeValue(forKey: alias) }; state.lock.unlock()
  }
  private func cachedKey(_ alias: String) throws -> String? {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "aihr.integrity.app-attest.v1", kSecAttrAccount as String: alias,
      kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw KeyStorageError.unavailable }
    guard let data = result as? Data, data.count <= 512, let id = String(data: data, encoding: .utf8), validKeyId(id) else { throw KeyStorageError.invalidKey }
    return id
  }
  private func saveKey(_ id: String, _ alias: String) throws {
    let item: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "aihr.integrity.app-attest.v1", kSecAttrAccount as String: alias,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly, kSecValueData as String: Data(id.utf8)]
    let status = SecItemAdd(item as CFDictionary, nil)
    if status == errSecDuplicateItem { guard try cachedKey(alias) == id else { throw KeyStorageError.invalidKey }; return }
    guard status == errSecSuccess else { throw KeyStorageError.unavailable }
  }
  private func rejectStorage(_ error: Error, _ promise: Promise) {
    if let storage = error as? KeyStorageError, case .invalidKey = storage { promise.reject("ERR_INTEGRITY_INVALID_KEY", "Device integrity key is unavailable") }
    else { unavailable(promise) }
  }
  private func hashData(_ value: String) -> Data? {
    guard value.utf8.count == 44, let data = Data(base64Encoded: value), data.count == 32,
      data.base64EncodedString() == value else { return nil }
    return data
  }
  private func invalid(_ promise: Promise) { promise.reject("ERR_INTEGRITY_INVALID_INPUT", "Invalid integrity input") }
  private func unsupported(_ promise: Promise) { promise.reject("ERR_INTEGRITY_UNSUPPORTED", "Device integrity capability is unsupported") }
  private func unavailable(_ promise: Promise) { promise.reject("ERR_INTEGRITY_UNAVAILABLE", "Device integrity operation unavailable") }
  private func reject(_ error: Error?, _ promise: Promise) {
    if let cached = error as? AppAttestProofError {
      switch cached {
      case .invalidInput: invalid(promise)
      case .bindingConflict: promise.reject("ERR_INTEGRITY_BINDING_CONFLICT", "Retain the original enrollment hash")
      case .recoveryRequired: promise.reject("ERR_INTEGRITY_RECOVERY_REQUIRED", "Reconcile the retained enrollment")
      case .busy: promise.reject("ERR_INTEGRITY_IN_PROGRESS", "Retain the pending enrollment")
      case .storageUnavailable, .malformedProof: unavailable(promise)
      }
      return
    }
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
