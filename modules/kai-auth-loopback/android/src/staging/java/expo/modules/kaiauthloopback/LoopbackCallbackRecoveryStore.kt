package expo.modules.kaiauthloopback

import android.content.Context

// Staging has no formal OAuth listener and cannot persist or consume formal callbacks.
internal class LoopbackCallbackRecoveryStore(@Suppress("UNUSED_PARAMETER") context: Context) {
  fun persist(@Suppress("UNUSED_PARAMETER") callback: PersistedLoopbackCallback): Unit = unavailable()
  fun peek(@Suppress("UNUSED_PARAMETER") attemptId: String): PersistedLoopbackCallback? = null
  fun acknowledge(@Suppress("UNUSED_PARAMETER") attemptId: String, @Suppress("UNUSED_PARAMETER") state: String) = Unit
  fun clearExpired() = Unit

  private fun unavailable(): Nothing = throw IllegalStateException("KAI callback recovery is unavailable.")
}
