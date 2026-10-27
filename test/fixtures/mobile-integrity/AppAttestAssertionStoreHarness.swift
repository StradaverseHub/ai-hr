// Actual Swift model and bounded encoding. Synthetic vendor/storage, no device or OS Keychain acceptance.
import Foundation
import Darwin

private enum Synthetic: Error { case outage, unknown, storage, failure(String) }
private final class Memory: AppAttestAssertionPersistence {
  var records = [String: Data]()
  var failWrites = false, failAfterWrite = false, failRemove = false, failAfterRemove = false, failReset = false
  func read(_ account: String) throws -> Data? { records[account] }
  func write(_ data: Data, account: String) throws {
    if failWrites || records[account] == nil && records.count >= 16 { throw Synthetic.storage }
    records[account] = data; if failAfterWrite { throw Synthetic.storage }
  }
  func remove(_ account: String) throws { if failRemove { throw Synthetic.storage }; records.removeValue(forKey: account); if failAfterRemove { throw Synthetic.storage } }
  func removeAll() throws { if failReset { throw Synthetic.storage }; records.removeAll() }
}
private func require(_ condition: Bool, _ label: String) throws { if !condition { throw Synthetic.failure(label) } }
private func failure(_ result: Result<Data, Error>?) -> AppAttestProofError? { guard case .failure(let error)? = result else { return nil }; return error as? AppAttestProofError }
private func success(_ result: Result<Data, Error>?) -> Data? { guard case .success(let bytes)? = result else { return nil }; return bytes }
private let hash = Data(repeating: 0, count: 32).base64EncodedString(), otherHash = Data(repeating: 1, count: 32).base64EncodedString()
private let proof = Data([1, 2, 3, 4]), otherProof = Data([5, 6, 7])
private let retryable: (Error) -> Bool = { if case Synthetic.outage = $0 { return true }; return false }

@main private struct AssertionHarness {
 static func main() { do { try run() } catch { print("AppAttestAssertionStore failed: \(error)"); exit(1) } }
 static func run() throws {
  var checks = 0
  do {
   let memory = Memory(), store = AppAttestAssertionStore(persistence: memory); var calls = 0, result: Result<Data, Error>?
   store.request(keyId: "key", hash: hash, retryable: retryable, vendor: { complete in
    calls += 1
    do { try require(try store.snapshot(keyId: "key", hash: hash) == .requested(canRetry: false), "intent precedes vendor") } catch { complete(.failure(error)); return }
    complete(.success(proof))
   }, completion: { result = $0 })
   try require(success(result) == proof, "proof returned after commit")
   let restarted = AppAttestAssertionStore(persistence: memory, process: UUID())
   try require(try restarted.snapshot(keyId: "key", hash: hash) == .completed(proof), "completed survives restart")
   restarted.request(keyId: "key", hash: hash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })
   try require(calls == 1 && success(result) == proof, "cached proof does not repeat SDK")
   restarted.request(keyId: "key", hash: otherHash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })
   if case .bindingConflict? = failure(result) {} else { throw Synthetic.failure("changed hash") }; checks += 1
  }
  do {
   let memory = Memory(), store = AppAttestAssertionStore(persistence: memory); var callback: ((Result<Data, Error>) -> Void)?, calls = 0, result: Result<Data, Error>?
   store.request(keyId: "key", hash: hash, retryable: retryable, vendor: { calls += 1; callback = $0 }, completion: { result = $0 })
   let sameProcess = AppAttestAssertionStore(persistence: memory)
   try require(try sameProcess.snapshot(keyId: "key", hash: hash) == .requested(canRetry: false), "a second instance is not process replacement")
   sameProcess.request(keyId: "key", hash: hash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })
   if case .recoveryRequired? = failure(result) {} else { throw Synthetic.failure("live unknown request blocked") }
   callback?(.success(proof)); try require(try sameProcess.snapshot(keyId: "key", hash: hash) == .completed(proof), "late callback recovers");try require(calls == 1, "no live duplicate");checks += 1
  }
  do {
   let memory = Memory(), original = AppAttestAssertionStore(persistence: memory, process: UUID()); var calls = 0, result: Result<Data, Error>?
   original.request(keyId: "key", hash: hash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })
   // The original process is considered gone; its callback must never be invoked in this scenario.
   let restarted = AppAttestAssertionStore(persistence: memory, process: UUID())
   try require(try restarted.snapshot(keyId: "key", hash: hash) == .requested(canRetry: true), "process replacement may retry same assertion payload")
   restarted.request(keyId: "key", hash: otherHash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })
   if case .bindingConflict? = failure(result) {} else { throw Synthetic.failure("restart cannot change payload") }
   restarted.request(keyId: "key", hash: hash, retryable: retryable, vendor: { complete in calls += 1; complete(.success(otherProof)) }, completion: { result = $0 })
   try require(calls == 2 && success(result) == otherProof, "same payload retry after actual process loss"); checks += 1
  }
  do {
   let memory = Memory(); memory.failWrites = true
   let store = AppAttestAssertionStore(persistence: memory); var calls = 0
   store.request(keyId: "key", hash: hash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { _ in })
   try require(calls == 0 && memory.records.isEmpty, "failed intent storage prevents SDK"); checks += 1
  }
  do {
   let memory = Memory(), store = AppAttestAssertionStore(persistence: memory); var result: Result<Data, Error>?, calls = 0
   memory.failAfterWrite = true
   store.request(keyId: "key", hash: hash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })
   memory.failAfterWrite = false
   try require(calls == 0 && !memory.records.isEmpty && result != nil && success(result) == nil, "lost intent reply never calls vendor or publishes a proof")
   try require(try store.snapshot(keyId: "key", hash: hash) == .requested(canRetry: false), "unknown same-process intent stays held"); checks += 1
  }
  do {
   let memory = Memory(), store = AppAttestAssertionStore(persistence: memory); var callback: ((Result<Data, Error>) -> Void)?, result: Result<Data, Error>?, calls = 0
   store.request(keyId: "key", hash: hash, retryable: retryable, vendor: { calls += 1; callback = $0 }, completion: { result = $0 })
   memory.failWrites = true; callback?(.success(proof))
   if case .storageUnavailable? = failure(result) {} else { throw Synthetic.failure("uncommitted proof not published") }
   memory.failWrites = false
   try require(try store.snapshot(keyId: "key", hash: hash) == .completed(proof), "native memory flushes original bytes")
   store.request(keyId: "key", hash: hash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })
   try require(calls == 1 && success(result) == proof, "flush never signs again"); checks += 1
  }
  do {
   let memory = Memory(), store = AppAttestAssertionStore(persistence: memory); var callback: ((Result<Data, Error>) -> Void)?, result: Result<Data, Error>?
   store.request(keyId: "key", hash: hash, retryable: retryable, vendor: { callback = $0 }, completion: { result = $0 })
   memory.failAfterWrite = true; callback?(.success(proof)); memory.failAfterWrite = false
   if case .storageUnavailable? = failure(result) {} else { throw Synthetic.failure("lost proof commit reply") }
   try require(try AppAttestAssertionStore(persistence: memory, process: UUID()).snapshot(keyId: "key", hash: hash) == .completed(proof), "committed artifact survives lost reply"); checks += 1
  }
  do {
   let memory = Memory(), store = AppAttestAssertionStore(persistence: memory); var first: ((Result<Data, Error>) -> Void)?, second: ((Result<Data, Error>) -> Void)?, result: Result<Data, Error>?
   store.request(keyId: "key", hash: hash, retryable: retryable, vendor: { first = $0 }, completion: { result = $0 }); first?(.failure(Synthetic.outage))
   try require(try store.snapshot(keyId: "key", hash: hash) == .retryable, "classified failure permits explicit retry")
   store.request(keyId: "key", hash: hash, retryable: retryable, vendor: { second = $0 }, completion: { result = $0 })
   first?(.success(proof)); try require(try store.snapshot(keyId: "key", hash: hash) == .requested(canRetry: false), "stale callback cannot win")
   second?(.success(otherProof)); first?(.failure(Synthetic.unknown))
   try require(try store.snapshot(keyId: "key", hash: hash) == .completed(otherProof), "current callback wins once");try require(success(result) == otherProof, "only current proof is published");checks += 1
  }
  do {
   let memory = Memory(), store = AppAttestAssertionStore(persistence: memory); var result: Result<Data, Error>?, calls = 0
   store.request(keyId: "key", hash: hash, retryable: retryable, vendor: { complete in calls += 1; complete(.failure(Synthetic.unknown)) }, completion: { result = $0 })
   store.request(keyId: "key", hash: hash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })
   if case .recoveryRequired? = failure(result) {} else { throw Synthetic.failure("unknown failure blocks same process") };try require(calls == 1, "no unknown retry");checks += 1
  }
  do {
   let memory = Memory(), store = AppAttestAssertionStore(persistence: memory); var callback: ((Result<Data, Error>) -> Void)?, cleared = false
   store.request(keyId: "key", hash: hash, retryable: retryable, vendor: { callback = $0 }, completion: { _ in })
   do { try store.release(keyId: "key", hash: hash); throw Synthetic.failure("released live operation") } catch AppAttestProofError.busy {}
   do { try store.resetInstallation { cleared = true }; throw Synthetic.failure("reset live operation") } catch AppAttestProofError.busy {}
   try require(!cleared, "reset does not run while vendor active")
   callback?(.success(proof));memory.failRemove = true
   do { try store.release(keyId: "key", hash: hash); throw Synthetic.failure("ignored cleanup storage failure") } catch Synthetic.storage {}
   try require(try store.snapshot(keyId: "key", hash: hash) == .completed(proof), "failed cleanup retains artifact")
   memory.failRemove = false;memory.failAfterRemove = true
   do { try store.release(keyId: "key", hash: hash); throw Synthetic.failure("lost cleanup reply") } catch Synthetic.storage {}
   memory.failAfterRemove = false;try store.release(keyId: "key", hash: hash)
   try require(try store.snapshot(keyId: "key", hash: hash) == .absent, "cleanup is idempotent after lost reply");checks += 1
  }
  do {
   let memory = Memory(), store = AppAttestAssertionStore(persistence: memory);var result: Result<Data, Error>?, calls = 0
   for index in 0..<80 {
    let next = Data(repeating: UInt8(index), count: 32).base64EncodedString()
    store.request(keyId: "key", hash: next, retryable: retryable, vendor: { complete in calls += 1;complete(.success(proof)) }, completion: { result = $0 })
    try require(success(result) == proof, "successive proof handoff")
    try store.release(keyId: "key", hash: next)
   }
   try require(memory.records.isEmpty && calls == 80, "released assertions do not consume a lifetime tombstone allowance");checks += 1
  }
  for size in [0,8193] {
   let memory = Memory(), store = AppAttestAssertionStore(persistence: memory);var result: Result<Data, Error>?
   store.request(keyId: "key", hash: hash, retryable: retryable, vendor: { $0(.success(Data(repeating: 0, count: size))) }, completion: { result = $0 })
   if case .malformedProof? = failure(result) {} else { throw Synthetic.failure("invalid artifact bound") };checks += 1
  }
  do {
   let memory = Memory(), store = AppAttestAssertionStore(persistence: memory), maximum = Data(repeating: 255, count: 8192);var result: Result<Data, Error>?
   store.request(keyId: "key", hash: hash, retryable: retryable, vendor: { $0(.success(maximum)) }, completion: { result = $0 })
   try require(success(result) == maximum && memory.records.values.allSatisfy { $0.count <= 16384 }, "maximum slash-heavy proof fits bounded JSON");checks += 1
  }
  do {
   let memory = Memory(), store = AppAttestAssertionStore(persistence: memory);var calls = 0,result: Result<Data, Error>?
   for index in 0..<5 {store.request(keyId: "key\(index)", hash: hash, retryable: retryable, vendor: { _ in calls += 1 }, completion: { result = $0 })}
   if case .busy? = failure(result) {} else { throw Synthetic.failure("active capacity") };try require(calls == 4 && memory.records.count == 4, "fifth vendor call refused");checks += 1
  }
  do {
   let memory = Memory(), store = AppAttestAssertionStore(persistence: memory);var calls = 0,result: Result<Data, Error>?
   for index in 0..<17 {store.request(keyId: "key\(index)", hash: hash, retryable: retryable, vendor: { complete in calls += 1;complete(.success(proof)) }, completion: { result = $0 })}
   try require(result != nil && success(result) == nil, "persistence refusal does not publish a proof");try require(calls == 16 && memory.records.count == 16, "unresolved keys are not evicted and a seventeenth vendor call is refused")
   try store.release(keyId: "key0", hash: hash)
   store.request(keyId: "key16", hash: hash, retryable: retryable, vendor: { complete in calls += 1;complete(.success(proof)) }, completion: { result = $0 })
   try require(calls == 17 && success(result) == proof, "durable handoff frees capacity");checks += 1
  }
  do {
   let memory = Memory(), store = AppAttestAssertionStore(persistence: memory);var calls = 0,result: Result<Data, Error>?
   for input in ["",hash+"\n",String(repeating:"A",count:44)] {store.request(keyId:"key",hash:input,retryable:retryable,vendor:{_ in calls += 1},completion:{result=$0})}
   if case .invalidInput? = failure(result) {} else { throw Synthetic.failure("canonical hash validation") };try require(calls == 0 && memory.records.isEmpty, "invalid input never reaches vendor");checks += 1
  }
  print("AppAttestAssertionStore: \(checks) host model scenarios passed; no vendor or OS Keychain acceptance claimed")
 }
}
