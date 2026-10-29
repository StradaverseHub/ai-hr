import Foundation
import Security
import CryptoKit

protocol AppAttestProofPersistence {
  func read(_ account: String) throws -> Data?
  func write(_ data: Data, account: String) throws
  func removeAll() throws
}

enum AppAttestProofError: Error { case invalidInput, bindingConflict, recoveryRequired, busy, storageUnavailable, malformedProof }
enum AppAttestProofSnapshot: Equatable { case absent, requested, retryable, completed(Data), released }

/** OS-encrypted, unlocked/device-only records. Never evict unresolved proofs to admit another key. */
struct AppAttestKeychainProofPersistence: AppAttestProofPersistence {
  private let service = "aihr.integrity.app-attest-proof.v1"
  func removeAll() throws {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw AppAttestProofError.storageUnavailable }
  }
  func read(_ account: String) throws -> Data? {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service, kSecAttrAccount as String: account,
      kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var value: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &value)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = value as? Data, data.count <= 92160 else { throw AppAttestProofError.storageUnavailable }
    return data
  }
  func write(_ data: Data, account: String) throws {
    guard !data.isEmpty, data.count <= 92160 else { throw AppAttestProofError.storageUnavailable }
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service, kSecAttrAccount as String: account]
    if try read(account) == nil {
      var values: CFTypeRef?
      let countQuery: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service, kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
      let status = SecItemCopyMatching(countQuery as CFDictionary, &values)
      if status != errSecItemNotFound {
        guard status == errSecSuccess, let records = values as? [[String: Any]], records.count < 16 else { throw AppAttestProofError.storageUnavailable }
      }
      var item = query
      item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      item[kSecAttrSynchronizable as String] = false
      item[kSecValueData as String] = data
      guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw AppAttestProofError.storageUnavailable }
    } else {
      let attributes: [String: Any] = [kSecValueData as String: data,
        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly, kSecAttrSynchronizable as String: false]
      guard SecItemUpdate(query as CFDictionary, attributes as CFDictionary) == errSecSuccess else { throw AppAttestProofError.storageUnavailable }
    }
  }
}

/** One-use vendor operation with durable intent and artifact. A UI timeout does not cancel its owner.
 * Only an explicitly classified serverUnavailable result permits the same-key/same-hash vendor retry.
 * Interrupted/unknown attempts remain requested, never silently replaced or sent with another hash.
 */
final class AppAttestProofStore: @unchecked Sendable {
  private enum Phase: String, Codable { case requested, retryable, completed, released }
  private struct Record: Codable {
    let version: Int
    let keyId: String
    let clientDataHash: String
    let phase: Phase
    let proof: Data?
  }
  private let lock = NSLock()
  private let persistence: AppAttestProofPersistence
  private var active = [String: UUID]()
  private var uncommitted = [String: Record]()
  init(persistence: AppAttestProofPersistence) { self.persistence = persistence }

  private func account(_ keyId: String, _ hash: String) throws -> String {
    guard !keyId.isEmpty, keyId.utf8.count <= 512, !keyId.contains("\0"), hash.utf8.count == 44,
      let bytes = Data(base64Encoded: hash), bytes.count == 32, bytes.base64EncodedString() == hash else { throw AppAttestProofError.invalidInput }
    // One record per key, not per hash: a new hash cannot masquerade as an unused operation.
    return SHA256.hash(data: Data(("aihr-app-attest-proof-v1:" + keyId).utf8)).map { String(format: "%02x", $0) }.joined()
  }
  private func save(_ record: Record, _ account: String) throws {
    let encoder = JSONEncoder()
    // Base64 may consist almost entirely of '/'. Escaping every slash would nearly double a valid
    // 64 KiB artifact and strand it above the bounded record size after the one-use vendor call.
    encoder.outputFormatting = [.withoutEscapingSlashes]
    let data = try encoder.encode(record)
    guard data.count <= 92160 else { throw AppAttestProofError.storageUnavailable }
    try persistence.write(data, account: account)
  }
  private func load(_ account: String, _ keyId: String, _ hash: String) throws -> Record? {
    if let unfinished = uncommitted[account] {
      try save(unfinished, account); uncommitted.removeValue(forKey: account)
    }
    guard let data = try persistence.read(account) else { return nil }
    guard !data.isEmpty, data.count <= 92160, let record = try? JSONDecoder().decode(Record.self, from: data),
      record.version == 1, record.keyId == keyId,
      record.phase == .completed ? (record.proof?.isEmpty == false && (record.proof?.count ?? 65537) <= 65536) : record.proof == nil
      else { throw AppAttestProofError.storageUnavailable }
    guard record.clientDataHash == hash else { throw AppAttestProofError.bindingConflict }
    return record
  }
  func snapshot(keyId: String, hash: String) throws -> AppAttestProofSnapshot {
    let name = try account(keyId, hash)
    lock.lock(); defer { lock.unlock() }
    guard let record = try load(name, keyId, hash) else { return .absent }
    switch record.phase {
    case .requested: return .requested
    case .retryable: return .retryable
    case .completed: return .completed(record.proof!)
    case .released: return .released
    }
  }
  /** Called only after JS has durably committed its matching server receipt. Retain the immutable
   * binding tombstone so cleanup never makes a one-use key appear unused or attestable again. */
  func release(keyId: String, hash: String) throws {
    let name = try account(keyId, hash)
    lock.lock(); defer { lock.unlock() }
    guard active[name] == nil else { throw AppAttestProofError.busy }
    guard let record = try load(name, keyId, hash) else { throw AppAttestProofError.recoveryRequired }
    if record.phase == .released { return }
    guard record.phase == .completed else { throw AppAttestProofError.recoveryRequired }
    try save(Record(version: 1, keyId: keyId, clientDataHash: hash, phase: .released, proof: nil), name)
  }
  /** Bootstrap-only reinstall reset. Never erase an active/uncertain live callback's artifact. */
  func resetInstallation(clearAliases: () throws -> Void) throws {
    lock.lock(); defer { lock.unlock() }
    guard active.isEmpty && uncommitted.isEmpty else { throw AppAttestProofError.busy }
    try clearAliases()
    try persistence.removeAll()
  }
  func request(keyId: String, hash: String,
    retryable: @escaping (Error) -> Bool,
    vendor: @escaping (@escaping (Result<Data, Error>) -> Void) -> Void,
    completion: @escaping (Result<Data, Error>) -> Void) {
    let name: String
    do { name = try account(keyId, hash) } catch { completion(.failure(error)); return }
    let token = UUID()
    lock.lock()
    do {
      guard active[name] == nil else { throw AppAttestProofError.busy }
      if let record = try load(name, keyId, hash) {
        if record.phase == .completed { lock.unlock(); completion(.success(record.proof!)); return }
        if record.phase == .requested || record.phase == .released { throw AppAttestProofError.recoveryRequired }
      }
      guard active.count + uncommitted.count < 4 else { throw AppAttestProofError.busy }
      try save(Record(version: 1, keyId: keyId, clientDataHash: hash, phase: .requested, proof: nil), name)
      active[name] = token
      lock.unlock()
    } catch { lock.unlock(); completion(.failure(error)); return }
    vendor { result in
      self.lock.lock()
      guard self.active[name] == token else { self.lock.unlock(); return }
      self.active.removeValue(forKey: name)
      var outcome = result
      switch result {
      case .success(let bytes):
        if bytes.isEmpty || bytes.count > 65536 { outcome = .failure(AppAttestProofError.malformedProof) }
        else {
          let record = Record(version: 1, keyId: keyId, clientDataHash: hash, phase: .completed, proof: bytes)
          do { try self.save(record, name) }
          catch { self.uncommitted[name] = record; outcome = .failure(AppAttestProofError.storageUnavailable) }
        }
      case .failure(let error):
        if retryable(error) {
          let record = Record(version: 1, keyId: keyId, clientDataHash: hash, phase: .retryable, proof: nil)
          do { try self.save(record, name) }
          catch { self.uncommitted[name] = record; outcome = .failure(AppAttestProofError.storageUnavailable) }
        }
      }
      self.lock.unlock()
      completion(outcome)
    }
  }
}
