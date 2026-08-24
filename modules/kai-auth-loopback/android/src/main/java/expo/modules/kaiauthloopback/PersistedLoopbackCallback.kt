package expo.modules.kaiauthloopback

import android.os.Bundle
import androidx.core.os.bundleOf

internal const val RECOVERED_CALLBACK_MAX_AGE_MILLISECONDS = 5 * 60_000L

internal data class PersistedLoopbackCallback(
  val attemptId: String,
  val kind: String,
  val state: String,
  val issuer: String,
  val value: String,
  val receivedAtEpochMilliseconds: Long,
) {
  fun toBundle(): Bundle = bundleOf(
    "attemptId" to attemptId,
    "kind" to kind,
    "state" to state,
    "issuer" to issuer,
    (if (kind == "code") "code" else "error") to value,
    "receivedAt" to receivedAtEpochMilliseconds,
  )
}

internal fun validPersistedLoopbackCallbackTime(
  receivedAtEpochMilliseconds: Long,
  nowEpochMilliseconds: Long,
): Boolean = receivedAtEpochMilliseconds <= nowEpochMilliseconds &&
  nowEpochMilliseconds - receivedAtEpochMilliseconds <= RECOVERED_CALLBACK_MAX_AGE_MILLISECONDS
