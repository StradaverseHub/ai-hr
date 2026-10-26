// Host-compiled model checks. No DeviceCheck call or real Keychain access occurs in this harness.
import Foundation
import Dispatch
import Darwin

private enum Synthetic: Error { case outage, unknown, storage, failure(String) }
private final class MemoryPersistence: AppAttestProofPersistence {
  var records = [String: Data]()
  var failWrites = false
  var failAfterWrite = false
  var lastRead: String?
  func read(_ account: String) throws -> Data? { lastRead = account; return records[account] }
  func write(_ data: Data, account: String) throws {
    if failWrites { throw Synthetic.storage }
    records[account] = data
    if failAfterWrite { throw Synthetic.storage }
  }
}
private func require(_ condition: Bool, _ label: String) throws { if !condition { throw Synthetic.failure(label) } }
private func failure(_ result: Result<Data, Error>?) -> AppAttestProofError? {
  guard case .failure(let error)? = result else { return nil }; return error as? AppAttestProofError
}
private func success(_ result: Result<Data, Error>?) -> Data? { guard case .success(let bytes)? = result else { return nil }; return bytes }
private let hash = Data(repeating: 0, count: 32).base64EncodedString()
private let otherHash = Data(repeating: 1, count: 32).base64EncodedString()
private let proof = Data([1, 2, 3, 4])
private let retryable: (Error) -> Bool = { if case Synthetic.outage = $0 { return true }; return false }

@main private struct ProofStoreHarness {
  static func main() {
    do { try run() }
    catch { print("AppAttestProofStore harness failed: \(error)"); exit(1) }
  }
  static func run() throws {
    var checks = 0
    do {
      let memory = MemoryPersistence(), store = AppAttestProofStore(persistence: memory)
      var calls = 0, result: Result<Data, Error>?
      store.request(keyId: "sdk-A", hash: hash, retryable: retryable, vendor: { complete in
        calls += 1
        do { try require(try store.snapshot(keyId: "sdk-A", hash: hash) == .requested, "intent before vendor") }
        catch { complete(.failure(error)); return }
        complete(.success(proof))
      }, completion: { result = $0 })
      try require(success(result) == proof, "complete after durable proof")
      let restarted = AppAttestProofStore(persistence: memory)
      try require(try restarted.snapshot(keyId: "sdk-A", hash: hash) == .completed(proof), "restart proof recovery")
      restarted.request(keyId: "sdk-A", hash: hash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })
      try require(calls == 1 && success(result) == proof, "cached request never calls vendor")
      restarted.request(keyId: "sdk-A", hash: otherHash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })
      if case .bindingConflict? = failure(result) {} else { throw Synthetic.failure("same key cannot change hash") }
      try require(calls == 1, "changed hash has no vendor call"); checks += 1
    }
    do {
      let memory = MemoryPersistence(); memory.failWrites = true
      let store = AppAttestProofStore(persistence: memory); var calls = 0, result: Result<Data, Error>?
      store.request(keyId: "sdk-A", hash: hash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })
      try require(calls == 0 && result != nil && memory.records.isEmpty, "storage failure prevents vendor call"); checks += 1
    }
    do {
      let memory = MemoryPersistence(), store = AppAttestProofStore(persistence: memory)
      var callback: ((Result<Data, Error>) -> Void)?, calls = 0, result: Result<Data, Error>?
      store.request(keyId: "sdk-A", hash: hash, retryable: retryable, vendor: { calls += 1; callback = $0 }, completion: { result = $0 })
      let restarted = AppAttestProofStore(persistence: memory)
      restarted.request(keyId: "sdk-A", hash: hash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })
      if case .recoveryRequired? = failure(result) {} else { throw Synthetic.failure("interrupted operation requires recovery") }
      try require(calls == 1, "interrupted call not repeated")
      callback?(.success(proof))
      try require(try restarted.snapshot(keyId: "sdk-A", hash: hash) == .completed(proof), "late native callback survives JS timeout"); checks += 1
    }
    do {
      let memory = MemoryPersistence(), store = AppAttestProofStore(persistence: memory)
      var calls = 0, result: Result<Data, Error>?
      store.request(keyId: "sdk-A", hash: hash, retryable: retryable, vendor: { complete in calls += 1; complete(.failure(Synthetic.outage)) }, completion: { result = $0 })
      try require(try store.snapshot(keyId: "sdk-A", hash: hash) == .retryable, "known outage stored")
      let restarted = AppAttestProofStore(persistence: memory)
      restarted.request(keyId: "sdk-A", hash: otherHash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })
      if case .bindingConflict? = failure(result) {} else { throw Synthetic.failure("outage still binds original hash") }
      restarted.request(keyId: "sdk-A", hash: hash, retryable: retryable, vendor: { complete in calls += 1; complete(.success(proof)) }, completion: { result = $0 })
      try require(calls == 2 && success(result) == proof, "explicit same-key/hash outage retry"); checks += 1
    }
    do {
      let memory = MemoryPersistence(), store = AppAttestProofStore(persistence: memory)
      var calls = 0, result: Result<Data, Error>?
      store.request(keyId: "sdk-A", hash: hash, retryable: retryable, vendor: { complete in calls += 1; complete(.failure(Synthetic.unknown)) }, completion: { result = $0 })
      try require(try store.snapshot(keyId: "sdk-A", hash: hash) == .requested, "unknown failure remains uncertain")
      AppAttestProofStore(persistence: memory).request(keyId: "sdk-A", hash: hash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })
      if case .recoveryRequired? = failure(result) {} else { throw Synthetic.failure("unknown failure cannot auto retry") }
      try require(calls == 1, "unknown failure has one vendor call"); checks += 1
    }
    do {
      let memory = MemoryPersistence(), store = AppAttestProofStore(persistence: memory)
      var result: Result<Data, Error>?
      store.request(keyId: "sdk-A", hash: hash, retryable: retryable, vendor: { complete in memory.failWrites = true; complete(.success(proof)) }, completion: { result = $0 })
      if case .storageUnavailable? = failure(result) {} else { throw Synthetic.failure("no proof reply before persistence") }
      try require(try AppAttestProofStore(persistence: memory).snapshot(keyId: "sdk-A", hash: hash) == .requested, "lost process remains uncertain")
      memory.failWrites = false
      try require(try store.snapshot(keyId: "sdk-A", hash: hash) == .completed(proof), "live native owner flushes retained artifact")
      try require(try AppAttestProofStore(persistence: memory).snapshot(keyId: "sdk-A", hash: hash) == .completed(proof), "flushed artifact survives restart"); checks += 1
    }
    do {
      let memory = MemoryPersistence(), store = AppAttestProofStore(persistence: memory)
      var result: Result<Data, Error>?
      store.request(keyId: "sdk-A", hash: hash, retryable: retryable, vendor: { complete in memory.failAfterWrite = true; complete(.success(proof)) }, completion: { result = $0 })
      try require(success(result) == nil, "ambiguous persistence reply never claims success")
      memory.failAfterWrite = false
      try require(try AppAttestProofStore(persistence: memory).snapshot(keyId: "sdk-A", hash: hash) == .completed(proof), "committed proof recovers after lost storage reply"); checks += 1
    }
    do {
      for bytes in [Data(), Data(repeating: 7, count: 65537)] {
        let memory = MemoryPersistence(), store = AppAttestProofStore(persistence: memory)
        var result: Result<Data, Error>?
        store.request(keyId: "sdk-A", hash: hash, retryable: retryable, vendor: { $0(.success(bytes)) }, completion: { result = $0 })
        if case .malformedProof? = failure(result) {} else { throw Synthetic.failure("bounded native proof") }
        try require(try store.snapshot(keyId: "sdk-A", hash: hash) == .requested, "malformed artifact grants no retry")
      }
      for byte: UInt8 in [8, 255] {
        let memory = MemoryPersistence(), store = AppAttestProofStore(persistence: memory), maximum = Data(repeating: byte, count: 65536)
        let keyId = String(repeating: "\u{1}", count: 512)
        store.request(keyId: keyId, hash: hash, retryable: retryable, vendor: { $0(.success(maximum)) }, completion: { _ in })
        try require(try store.snapshot(keyId: keyId, hash: hash) == .completed(maximum), "maximum proof fits bounded record with worst-case JSON bytes")
      }
      checks += 1
    }
    do {
      let memory = MemoryPersistence(), store = AppAttestProofStore(persistence: memory)
      var old: ((Result<Data, Error>) -> Void)?, current: ((Result<Data, Error>) -> Void)?, completions = 0
      store.request(keyId: "sdk-A", hash: hash, retryable: retryable, vendor: { old = $0 }, completion: { _ in completions += 1 })
      old?(.failure(Synthetic.outage))
      store.request(keyId: "sdk-A", hash: hash, retryable: retryable, vendor: { current = $0 }, completion: { _ in completions += 1 })
      old?(.success(Data([9])))
      try require(completions == 1 && (try store.snapshot(keyId: "sdk-A", hash: hash)) == .requested, "old callback cannot overwrite new operation")
      current?(.success(proof)); current?(.success(Data([9])))
      try require(completions == 2 && (try store.snapshot(keyId: "sdk-A", hash: hash)) == .completed(proof), "each generation completes once"); checks += 1
    }
    do {
      let memory = MemoryPersistence(), store = AppAttestProofStore(persistence: memory)
      var callbacks = [(Result<Data, Error>) -> Void](), calls = 0, result: Result<Data, Error>?
      for i in 0..<4 { store.request(keyId: "sdk-\(i)", hash: hash, retryable: retryable, vendor: { calls += 1; callbacks.append($0) }, completion: { _ in }) }
      store.request(keyId: "sdk-fifth", hash: hash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })
      if case .busy? = failure(result) {} else { throw Synthetic.failure("bounded active ownership") }
      try require(calls == 4 && memory.records.count == 4, "fifth call creates no intent")
      memory.failWrites = true; callbacks[0](.success(proof)); memory.failWrites = false
      store.request(keyId: "sdk-fifth", hash: hash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })
      if case .busy? = failure(result) {} else { throw Synthetic.failure("uncommitted artifacts reserve capacity") }
      try require(try store.snapshot(keyId: "sdk-0", hash: hash) == .completed(proof), "recovery frees uncommitted capacity")
      store.request(keyId: "sdk-fifth", hash: hash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })
      try require(calls == 5, "capacity recovers without evicting evidence"); checks += 1
    }
    do {
      let memory = MemoryPersistence(), store = AppAttestProofStore(persistence: memory)
      store.request(keyId: "sdk-A", hash: hash, retryable: retryable, vendor: { $0(.success(proof)) }, completion: { _ in })
      let account = memory.lastRead!, original = memory.records[account]!
      memory.records[account] = Data("{\"version\":99}".utf8)
      var result: Result<Data, Error>?, calls = 0
      store.request(keyId: "sdk-A", hash: hash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })
      if case .storageUnavailable? = failure(result) {} else { throw Synthetic.failure("corrupt state cannot become an unused key") }
      memory.records[account] = original
      store.request(keyId: "sdk-B", hash: hash, retryable: retryable, vendor: { $0(.success(proof)) }, completion: { _ in })
      let otherAccount = memory.lastRead!; memory.records[otherAccount] = original
      store.request(keyId: "sdk-B", hash: hash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })
      if case .storageUnavailable? = failure(result) {} else { throw Synthetic.failure("cross-key record transplant refused") }
      try require(calls == 0, "corruption and transplant never reach vendor"); checks += 1
    }
    do {
      let memory = MemoryPersistence(); memory.failAfterWrite = true
      let store = AppAttestProofStore(persistence: memory); var calls = 0, result: Result<Data, Error>?
      store.request(keyId: "sdk-A", hash: hash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })
      memory.failAfterWrite = false
      try require(calls == 0 && result != nil, "ambiguous initial write prevents vendor call")
      AppAttestProofStore(persistence: memory).request(keyId: "sdk-A", hash: hash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })
      if case .recoveryRequired? = failure(result) {} else { throw Synthetic.failure("ambiguous durable intent is not silently restarted") }
      try require(calls == 0, "restart does not guess whether SDK was called"); checks += 1
    }
    do {
      final class Parallel: @unchecked Sendable {
        let lock = NSLock()
        var calls = 0, replies = 0
        var callback: ((Result<Data, Error>) -> Void)?
      }
      let memory = MemoryPersistence(), store = AppAttestProofStore(persistence: memory), state = Parallel(), group = DispatchGroup()
      for _ in 0..<8 {
        group.enter(); DispatchQueue.global().async {
          store.request(keyId: "sdk-A", hash: hash, retryable: retryable, vendor: { complete in
            state.lock.lock(); state.calls += 1; state.callback = complete; state.lock.unlock()
          }, completion: { _ in state.lock.lock(); state.replies += 1; state.lock.unlock() })
          group.leave()
        }
      }
      try require(group.wait(timeout: .now() + 5) == .success, "parallel requests return")
      try require(state.calls == 1 && state.replies == 7, "one active vendor call among concurrent callers")
      state.callback?(.success(proof))
      try require(state.replies == 8 && (try store.snapshot(keyId: "sdk-A", hash: hash)) == .completed(proof), "one durable concurrent outcome"); checks += 1
    }
    print("AppAttestProofStore: \(checks) host model scenarios passed; no vendor or OS Keychain acceptance claimed")
  }
}
