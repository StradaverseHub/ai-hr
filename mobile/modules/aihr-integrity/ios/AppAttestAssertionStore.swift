import Foundation
import Security
import CryptoKit

protocol AppAttestAssertionPersistence {
  func read(_ account: String) throws -> Data?
  func write(_ data: Data, account: String) throws
  func remove(_ account: String) throws
  func removeAll() throws
}

enum AppAttestAssertionSnapshot: Equatable {
  case absent, requested(canRetry: Bool), retryable, completed(Data)
}

/** Separate from one-use enrollment records. Only unresolved assertion handoffs occupy these slots. */
struct AppAttestKeychainAssertionPersistence: AppAttestAssertionPersistence {
  private let service = "aihr.integrity.app-attest-assertion.v1"
  private func query(_ account: String? = nil) -> [String: Any] {
    var value: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
    if let account { value[kSecAttrAccount as String] = account }; return value
  }
  func read(_ account: String) throws -> Data? {
    var request = query(account); request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
    var value: CFTypeRef?; let status = SecItemCopyMatching(request as CFDictionary, &value)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = value as? Data, !data.isEmpty, data.count <= 16384 else { throw AppAttestProofError.storageUnavailable }
    return data
  }
  func write(_ data: Data, account: String) throws {
    guard !data.isEmpty, data.count <= 16384 else { throw AppAttestProofError.storageUnavailable }
    let request = query(account)
    let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly, kSecAttrSynchronizable as String: false]
    if try read(account) == nil {
      var count = query(); count[kSecReturnAttributes as String] = true; count[kSecMatchLimit as String] = kSecMatchLimitAll
      var value: CFTypeRef?; let status = SecItemCopyMatching(count as CFDictionary, &value)
      if status != errSecItemNotFound {
        guard status == errSecSuccess, let records = value as? [[String: Any]], records.count < 16 else { throw AppAttestProofError.storageUnavailable }
      }
      var item = request; attributes.forEach { item[$0.key] = $0.value }
      guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw AppAttestProofError.storageUnavailable }
    } else {
      guard SecItemUpdate(request as CFDictionary, attributes as CFDictionary) == errSecSuccess else { throw AppAttestProofError.storageUnavailable }
    }
  }
  func remove(_ account: String) throws {
    let status = SecItemDelete(query(account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw AppAttestProofError.storageUnavailable }
  }
  func removeAll() throws {
    let status = SecItemDelete(query() as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw AppAttestProofError.storageUnavailable }
  }
}

/** One active payload per key. Return an assertion only after its native handoff record is durable.
 * Unlike attestKey, generateAssertion may repeat the SAME payload after actual process loss. A newer
 * assertion counter is permitted by the server's strict-increase check. The caller must keep that
 * same immutable command and persist the proof before upload; it may never replace another payload.
 * The process marker stays private here. A live/unknown callback cannot authorize a duplicate call.
 */
final class AppAttestAssertionStore: @unchecked Sendable {
  private enum Phase: String, Codable { case requested, retryable, completed }
  private struct Record: Codable {
    let version: Int; let keyId: String; let hash: String; let process: UUID; let phase: Phase; let proof: Data?
  }
  private static let processMarker = UUID()
  private let process: UUID
  private let persistence: AppAttestAssertionPersistence
  private let lock = NSLock()
  private var active = [String: UUID]()
  private var uncommitted = [String: Record]()
  init(persistence: AppAttestAssertionPersistence, process: UUID? = nil) {
    self.persistence = persistence; self.process = process ?? Self.processMarker
  }
  private func account(_ keyId: String, _ hash: String) throws -> String {
    guard !keyId.isEmpty, keyId.utf8.count <= 512, !keyId.contains("\0"), hash.utf8.count == 44,
      let bytes = Data(base64Encoded: hash), bytes.count == 32, bytes.base64EncodedString() == hash else { throw AppAttestProofError.invalidInput }
    return SHA256.hash(data: Data(("aihr-app-attest-assertion-v1:" + keyId).utf8)).map { String(format: "%02x", $0) }.joined()
  }
  private func save(_ record: Record, _ account: String) throws {
    let encoder = JSONEncoder(); encoder.outputFormatting = [.withoutEscapingSlashes]
    let data = try encoder.encode(record)
    guard data.count <= 16384 else { throw AppAttestProofError.storageUnavailable }
    try persistence.write(data, account: account)
  }
  private func load(_ account: String, _ keyId: String, _ hash: String) throws -> Record? {
    if let value = uncommitted[account] { try save(value, account); uncommitted.removeValue(forKey: account) }
    guard let bytes = try persistence.read(account) else {
      guard active[account] == nil else { throw AppAttestProofError.storageUnavailable }; return nil
    }
    guard !bytes.isEmpty, bytes.count <= 16384, let value = try? JSONDecoder().decode(Record.self, from: bytes), value.version == 1, value.keyId == keyId,
      value.phase == .completed ? (value.proof?.isEmpty == false && (value.proof?.count ?? 8193) <= 8192) : value.proof == nil else { throw AppAttestProofError.storageUnavailable }
    guard value.hash == hash else { throw AppAttestProofError.bindingConflict }; return value
  }
  func snapshot(keyId: String, hash: String) throws -> AppAttestAssertionSnapshot {
    let name = try account(keyId, hash); lock.lock(); defer { lock.unlock() }
    guard let value = try load(name, keyId, hash) else { return .absent }
    switch value.phase {
    case .completed: return .completed(value.proof!)
    case .retryable: return .retryable
    case .requested: return .requested(canRetry: value.process != process && active[name] == nil)
    }
  }
  /** Only after the JS journal durably owns the same assertion. Missing means cleanup already won.
   * Another hash always refuses; stale cleanup cannot erase a newer unresolved payload. */
  func release(keyId: String, hash: String) throws {
    let name = try account(keyId, hash); lock.lock(); defer { lock.unlock() }
    guard active[name] == nil else { throw AppAttestProofError.busy }
    guard let value = try load(name, keyId, hash) else { return }
    guard value.phase == .completed else { throw AppAttestProofError.recoveryRequired }
    try persistence.remove(name)
  }
  func resetInstallation(clearOtherState: () throws -> Void) throws {
    lock.lock(); defer { lock.unlock() }
    guard active.isEmpty && uncommitted.isEmpty else { throw AppAttestProofError.busy }
    try clearOtherState(); try persistence.removeAll()
  }
  func request(keyId: String, hash: String, retryable: @escaping (Error) -> Bool,
    vendor: @escaping (@escaping (Result<Data, Error>) -> Void) -> Void, completion: @escaping (Result<Data, Error>) -> Void) {
    let name: String
    do { name = try account(keyId, hash) } catch { completion(.failure(error)); return }
    let token = UUID(); lock.lock()
    do {
      guard active[name] == nil else { throw AppAttestProofError.busy }
      if let value = try load(name, keyId, hash) {
        if value.phase == .completed { lock.unlock(); completion(.success(value.proof!)); return }
        if value.phase == .requested && value.process == process { throw AppAttestProofError.recoveryRequired }
      }
      guard active.count + uncommitted.count < 4 else { throw AppAttestProofError.busy }
      try save(Record(version: 1, keyId: keyId, hash: hash, process: process, phase: .requested, proof: nil), name)
      active[name] = token; lock.unlock()
    } catch { lock.unlock(); completion(.failure(error)); return }
    vendor { result in
      self.lock.lock()
      guard self.active[name] == token else { self.lock.unlock(); return }
      self.active.removeValue(forKey: name)
      var outcome = result
      switch result {
      case .success(let bytes):
        if bytes.isEmpty || bytes.count > 8192 { outcome = .failure(AppAttestProofError.malformedProof) }
        else {
          let value = Record(version: 1, keyId: keyId, hash: hash, process: self.process, phase: .completed, proof: bytes)
          do { try self.save(value, name) } catch { self.uncommitted[name] = value; outcome = .failure(AppAttestProofError.storageUnavailable) }
        }
      case .failure(let error):
        if retryable(error) {
          let value = Record(version: 1, keyId: keyId, hash: hash, process: self.process, phase: .retryable, proof: nil)
          do { try self.save(value, name) } catch { self.uncommitted[name] = value; outcome = .failure(AppAttestProofError.storageUnavailable) }
        }
      }
      self.lock.unlock(); completion(outcome)
    }
  }
}
