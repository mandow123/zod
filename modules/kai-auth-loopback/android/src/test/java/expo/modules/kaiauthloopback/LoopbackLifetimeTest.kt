package expo.modules.kaiauthloopback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LoopbackLifetimeTest {
  @Test fun hardTimeoutUsesOnlyTheInjectedMonotonicElapsedTime() {
    var elapsedRealtime = 50_000L
    val lifetime = LoopbackLifetime { elapsedRealtime }

    assertEquals(LISTENER_LIFETIME_MILLISECONDS, lifetime.remainingMilliseconds())
    elapsedRealtime += LISTENER_LIFETIME_MILLISECONDS - 1L
    assertEquals(1L, lifetime.remainingMilliseconds())
    assertFalse(lifetime.expired())
    elapsedRealtime += 1L
    assertEquals(0L, lifetime.remainingMilliseconds())
    assertTrue(lifetime.expired())
    elapsedRealtime += 60_000L
    assertEquals(0L, lifetime.remainingMilliseconds())
    assertTrue(lifetime.expired())
  }
}
