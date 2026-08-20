package expo.modules.kaiauthloopback

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val RECOVERY_KEY_ALIAS = "kai_auth_loopback_callback_v1"
private const val RECOVERY_FILE_NAME = "kai_auth_loopback_callback_v1.enc"
private const val RECOVERY_FORMAT_VERSION = 1
private val RECOVERY_AAD = "com.kaicloud.marketplace:kai-auth-loopback:v1".toByteArray(Charsets.UTF_8)

private class LoopbackRecoveryStoreException : Exception("KAI callback recovery storage is unavailable.")

internal class LoopbackCallbackRecoveryStore(context: Context) {
  private val file = AtomicFile(File(context.noBackupFilesDir, RECOVERY_FILE_NAME))

  fun persist(callback: PersistedLoopbackCallback) = synchronized(storageLock) {
    val previous = readRecordLocked()
    if (previous != null && previous.attemptId != callback.attemptId) {
      throw LoopbackRecoveryStoreException()
    }
    val plaintext = JSONObject().apply {
      put("attemptId", callback.attemptId)
      put("kind", callback.kind)
      put("state", callback.state)
      put("issuer", callback.issuer)
      put("value", callback.value)
      put("receivedAt", callback.receivedAtEpochMilliseconds)
    }.toString().toByteArray(Charsets.UTF_8)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, recoveryKey())
    cipher.updateAAD(RECOVERY_AAD)
    val encrypted = cipher.doFinal(plaintext)
    val encoded = ByteArrayOutputStream().use { output ->
      DataOutputStream(output).use { data ->
        data.writeByte(RECOVERY_FORMAT_VERSION)
        data.writeByte(cipher.iv.size)
        data.write(cipher.iv)
        data.writeInt(encrypted.size)
        data.write(encrypted)
      }
      output.toByteArray()
    }
    var destination: java.io.FileOutputStream? = null
    try {
      destination = file.startWrite()
      destination.write(encoded)
      file.finishWrite(destination)
    } catch (_: Throwable) {
      if (destination != null) file.failWrite(destination)
      throw LoopbackRecoveryStoreException()
    }
  }

  fun peek(attemptId: String): PersistedLoopbackCallback? = synchronized(storageLock) {
    val callback = readRecordLocked() ?: return@synchronized null
    if (!validPersistedLoopbackCallbackTime(callback.receivedAtEpochMilliseconds, System.currentTimeMillis())) {
      file.delete()
      return@synchronized null
    }
    callback.takeIf { it.attemptId == attemptId }
  }

  fun acknowledge(attemptId: String, state: String) = synchronized(storageLock) {
    val callback = readRecordLocked() ?: return@synchronized
    if (callback.attemptId != attemptId || callback.state != state) {
      throw LoopbackRecoveryStoreException()
    }
    file.delete()
  }

  fun clearExpired() = synchronized(storageLock) {
    val callback = readRecordLocked() ?: return@synchronized
    if (!validPersistedLoopbackCallbackTime(callback.receivedAtEpochMilliseconds, System.currentTimeMillis())) {
      file.delete()
    }
  }

  private fun readRecordLocked(): PersistedLoopbackCallback? {
    if (!file.baseFile.exists()) return null
    try {
      val encryptedFile = file.openRead().use { input ->
        DataInputStream(input).use { data ->
          if (data.readUnsignedByte() != RECOVERY_FORMAT_VERSION) throw LoopbackRecoveryStoreException()
          val ivLength = data.readUnsignedByte()
          if (ivLength !in 12..16) throw LoopbackRecoveryStoreException()
          val iv = ByteArray(ivLength).also(data::readFully)
          val encryptedLength = data.readInt()
          if (encryptedLength !in 17..8_192) throw LoopbackRecoveryStoreException()
          val encrypted = ByteArray(encryptedLength).also(data::readFully)
          if (data.read() != -1) throw LoopbackRecoveryStoreException()
          iv to encrypted
        }
      }
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, recoveryKey(), GCMParameterSpec(128, encryptedFile.first))
      cipher.updateAAD(RECOVERY_AAD)
      val value = JSONObject(cipher.doFinal(encryptedFile.second).toString(Charsets.UTF_8))
      val callback = PersistedLoopbackCallback(
        attemptId = value.getString("attemptId"),
        kind = value.getString("kind"),
        state = value.getString("state"),
        issuer = value.getString("issuer"),
        value = value.getString("value"),
        receivedAtEpochMilliseconds = value.getLong("receivedAt"),
      )
      if (!callback.attemptId.matches(Regex("^[0-9a-fA-F-]{36}$"))
        || callback.kind !in setOf("code", "error")
        || !callback.state.matches(Regex("^[A-Za-z0-9._~-]{32,256}$"))
        || callback.issuer != "https://auth.kai.com/api/auth"
        || callback.value.isEmpty() || callback.value.length > 2_048
        || callback.value.any { it.code < 0x20 || it.code == 0x7f }) {
        throw LoopbackRecoveryStoreException()
      }
      return callback
    } catch (error: LoopbackRecoveryStoreException) {
      throw error
    } catch (_: Throwable) {
      throw LoopbackRecoveryStoreException()
    }
  }

  private fun recoveryKey(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getKey(RECOVERY_KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(KeyGenParameterSpec.Builder(
      RECOVERY_KEY_ALIAS,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setRandomizedEncryptionRequired(true)
      .build())
    return generator.generateKey()
  }

  private companion object {
    val storageLock = Any()
  }
}
