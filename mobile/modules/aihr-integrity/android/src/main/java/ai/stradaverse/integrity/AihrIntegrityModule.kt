package ai.stradaverse.integrity

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityException
import com.google.android.play.core.integrity.StandardIntegrityManager
import com.google.android.play.core.integrity.model.StandardIntegrityErrorCode
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

// Platform outputs are evidence for server verification, never a local "verified" verdict.
class AihrIntegrityModule : Module() {
  companion object {
    private val keyCreationLock = Any()
    private val runtimeId = java.util.UUID.randomUUID().toString()
  }
  @Volatile private var provider: StandardIntegrityManager.StandardIntegrityTokenProvider? = null
  private var providerGeneration = 0L
  private val providerLock = Any()

  override fun definition() = ModuleDefinition {
    Name("AihrIntegrity")

    Function("capabilities") {
      val context = context()
      @Suppress("DEPRECATION") val info = context.packageManager.getPackageInfo(context.packageName, 0)
      mapOf("version" to 1, "platform" to "android", "appId" to context.packageName,
        "appVersion" to (info.versionName ?: ""), "buildVersion" to (if (Build.VERSION.SDK_INT >= 28) info.longVersionCode.toString() else info.versionCode.toString()),
        "keyMechanism" to if (Build.VERSION.SDK_INT >= 24) "android_keystore" else "unsupported")
    }

    Function("clockSnapshot") {
      val before = SystemClock.elapsedRealtimeNanos()
      val wall = System.currentTimeMillis()
      val after = SystemClock.elapsedRealtimeNanos()
      val boot = try { Settings.Global.getInt(context().contentResolver, Settings.Global.BOOT_COUNT).takeIf { it >= 0 }?.toString() } catch (_: Exception) { null }
      mapOf("source" to "android_elapsed_realtime", "elapsedBeforeNs" to before.toString(),
        "elapsedAfterNs" to after.toString(), "wallTimeMs" to wall.toDouble(), "bootId" to boot,
        "localOnly" to true, "runtimeId" to runtimeId)
    }

    AsyncFunction("createAndroidKey") { alias: String, challenge: String, strongBox: Boolean ->
      safely { synchronized(keyCreationLock) {
        validAlias(alias)
        val nonce = decode(challenge, 32, 32)
        val store = store()
        if (store.containsAlias(alias)) fail("ERR_INTEGRITY_KEY_EXISTS") // Never replace an enrolled/pending key.
        if (Build.VERSION.SDK_INT < 24) fail("ERR_INTEGRITY_UNSUPPORTED")
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
          .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
          .setDigests(KeyProperties.DIGEST_SHA256)
          .setAttestationChallenge(nonce)
        if (strongBox) {
          if (Build.VERSION.SDK_INT < 28 || !context().packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)) fail("ERR_INTEGRITY_UNSUPPORTED")
          spec.setIsStrongBoxBacked(true)
        }
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply { initialize(spec.build()); generateKeyPair() }
        keyInfo(alias)
      } }
    }

    AsyncFunction("androidKeyInfo") { alias: String -> safely { validAlias(alias); keyInfo(alias) } }

    AsyncFunction("signAndroidCommand") { alias: String, encoded: String ->
      safely {
        validAlias(alias)
        val message = decode(encoded, 1, 16384)
        val key = store().getKey(alias, null) as? PrivateKey ?: fail("ERR_INTEGRITY_INVALID_KEY")
        if (key.encoded != null) fail("ERR_INTEGRITY_INVALID_KEY")
        val signer = Signature.getInstance("SHA256withECDSA")
        signer.initSign(key); signer.update(message)
        Base64.encodeToString(signer.sign(), Base64.NO_WRAP)
      }
    }

    AsyncFunction("preparePlayIntegrity") { project: String, promise: Promise ->
      val projectNumber = if (project.matches(Regex("^[1-9][0-9]{0,18}$"))) project.toLongOrNull() else null
      if (projectNumber == null || projectNumber <= 0) { reject(promise, "ERR_INTEGRITY_INVALID_INPUT"); return@AsyncFunction }
      val generation = synchronized(providerLock) { provider = null; ++providerGeneration }
      try {
        IntegrityManagerFactory.createStandard(context()).prepareIntegrityToken(
          StandardIntegrityManager.PrepareIntegrityTokenRequest.builder().setCloudProjectNumber(projectNumber).build()
        ).addOnSuccessListener { prepared ->
          val current = synchronized(providerLock) { if (providerGeneration == generation) { provider = prepared; true } else false }
          if (current) promise.resolve(null) else reject(promise, "ERR_INTEGRITY_OBSOLETE")
        }.addOnFailureListener { reject(promise, "ERR_INTEGRITY_UNAVAILABLE") }
      } catch (_: Exception) { reject(promise, "ERR_INTEGRITY_UNAVAILABLE") }
    }

    AsyncFunction("requestPlayIntegrity") { hash: String, promise: Promise ->
      if (!hash.matches(Regex("^[A-Za-z0-9_-]{43}$"))) { reject(promise, "ERR_INTEGRITY_INVALID_INPUT"); return@AsyncFunction }
      val (current, generation) = synchronized(providerLock) { Pair(provider, providerGeneration) }
      if (current == null) { reject(promise, "ERR_INTEGRITY_PROVIDER_EXPIRED"); return@AsyncFunction }
      try {
        current.request(StandardIntegrityManager.StandardIntegrityTokenRequest.builder().setRequestHash(hash).build())
          .addOnSuccessListener { result ->
            val active = synchronized(providerLock) { providerGeneration == generation && provider === current }
            if (!active) reject(promise, "ERR_INTEGRITY_OBSOLETE")
            else { val token = result.token(); if (token.isNotEmpty() && token.length <= 32768) promise.resolve(token) else reject(promise, "ERR_INTEGRITY_UNAVAILABLE") }
          }.addOnFailureListener { error ->
            if (error is StandardIntegrityException && error.errorCode == StandardIntegrityErrorCode.INTEGRITY_TOKEN_PROVIDER_INVALID) {
              synchronized(providerLock) { if (providerGeneration == generation && provider === current) provider = null }
              reject(promise, "ERR_INTEGRITY_PROVIDER_EXPIRED")
            } else reject(promise, "ERR_INTEGRITY_UNAVAILABLE")
          }
      } catch (_: Exception) { reject(promise, "ERR_INTEGRITY_UNAVAILABLE") }
    }

    AsyncFunction("appleKeyInfo") { _: String, promise: Promise -> reject(promise, "ERR_INTEGRITY_UNSUPPORTED") }
    AsyncFunction("appleAttestationInfo") { _: String, _: String, promise: Promise -> reject(promise, "ERR_INTEGRITY_UNSUPPORTED") }
    AsyncFunction("releaseAppleAttestation") { _: String, _: String, promise: Promise -> reject(promise, "ERR_INTEGRITY_UNSUPPORTED") }
    AsyncFunction("resetAppleIntegrityInstallation") { promise: Promise -> reject(promise, "ERR_INTEGRITY_UNSUPPORTED") }
    AsyncFunction("generateAppleKey") { _: String, promise: Promise -> reject(promise, "ERR_INTEGRITY_UNSUPPORTED") }
    AsyncFunction("attestAppleKey") { _: String, _: String, promise: Promise -> reject(promise, "ERR_INTEGRITY_UNSUPPORTED") }
    AsyncFunction("appleOfflineProofInfo") { _: String, _: String, promise: Promise -> reject(promise, "ERR_INTEGRITY_UNSUPPORTED") }
    AsyncFunction("assertAppleOfflineKey") { _: String, _: String, promise: Promise -> reject(promise, "ERR_INTEGRITY_UNSUPPORTED") }
    AsyncFunction("releaseAppleOfflineProof") { _: String, _: String, promise: Promise -> reject(promise, "ERR_INTEGRITY_UNSUPPORTED") }
    AsyncFunction("assertAppleKey") { _: String, _: String, promise: Promise -> reject(promise, "ERR_INTEGRITY_UNSUPPORTED") }
  }

  private fun context(): Context = appContext.reactContext ?: fail("ERR_INTEGRITY_UNAVAILABLE")
  private fun store(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
  private fun validAlias(alias: String) { if (!alias.matches(Regex("^aihr_[0-9a-f]{64}$"))) fail("ERR_INTEGRITY_INVALID_INPUT") }
  private fun decode(value: String, minimum: Int, maximum: Int): ByteArray {
    if (value.length > ((maximum + 2) / 3) * 4) fail("ERR_INTEGRITY_INVALID_INPUT")
    val bytes = try { Base64.decode(value, Base64.NO_WRAP) } catch (_: Exception) { fail("ERR_INTEGRITY_INVALID_INPUT") }
    if (bytes.size !in minimum..maximum || Base64.encodeToString(bytes, Base64.NO_WRAP) != value) fail("ERR_INTEGRITY_INVALID_INPUT")
    return bytes
  }
  private fun keyInfo(alias: String): Map<String, Any> {
    val store = store()
    val key = store.getKey(alias, null) as? PrivateKey ?: fail("ERR_INTEGRITY_INVALID_KEY")
    if (key.encoded != null) fail("ERR_INTEGRITY_INVALID_KEY")
    val chain = store.getCertificateChain(alias) ?: fail("ERR_INTEGRITY_INVALID_KEY")
    if (chain.isEmpty() || chain.size > 8 || chain.any { it.encoded.size > 16384 }) fail("ERR_INTEGRITY_INVALID_KEY")
    val info = KeyFactory.getInstance(key.algorithm, "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java)
    val reported = if (Build.VERSION.SDK_INT >= 31) when (info.securityLevel) {
      KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
      KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "tee"
      KeyProperties.SECURITY_LEVEL_SOFTWARE -> "software"
      else -> "unknown"
    } else { @Suppress("DEPRECATION") if (info.isInsideSecureHardware) "hardware_unspecified" else "software" }
    return mapOf("publicKeySpki" to Base64.encodeToString(chain[0].publicKey.encoded, Base64.NO_WRAP),
      "certificateChain" to chain.map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) }, "reportedSecurityLevel" to reported)
  }
  private fun fail(code: String): Nothing = throw CodedException(code, "Device integrity operation unavailable", null)
  private fun reject(promise: Promise, code: String) { promise.reject(code, "Device integrity operation unavailable", null) }
  private fun <T> safely(block: () -> T): T = try { block() } catch (error: Exception) {
    val code = (error as? CodedException)?.code
    fail(if (code in setOf("ERR_INTEGRITY_INVALID_INPUT", "ERR_INTEGRITY_INVALID_KEY", "ERR_INTEGRITY_KEY_EXISTS", "ERR_INTEGRITY_UNSUPPORTED")) code!! else "ERR_INTEGRITY_UNAVAILABLE")
  }
}
