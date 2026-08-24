package expo.modules.kaiauthloopback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetSocketAddress
import java.net.ServerSocket

class LoopbackPortBinderTest {
  private fun occupy(port: Int): ServerSocket = ServerSocket().apply {
    reuseAddress = false
    bind(InetSocketAddress(IPV4_LOOPBACK, port), 1)
  }

  @Test fun everyRegisteredPortBindsOnlyIpv4LoopbackWithoutReuse() {
    assertEquals(9, REGISTERED_LOOPBACK_PORTS.size)
    assertEquals(9, REGISTERED_LOOPBACK_PORTS.toSet().size)
    for (port in REGISTERED_LOOPBACK_PORTS) {
      val bound = bindLoopbackPortCandidates(listOf(port)) ?: error("port $port did not bind")
      try {
        assertEquals(port, bound.port)
        assertEquals("127.0.0.1", bound.server.inetAddress.hostAddress)
        assertTrue(bound.server.inetAddress.isLoopbackAddress)
        assertFalse(bound.server.reuseAddress)
      } finally {
        bound.server.close()
      }
    }
  }

  @Test fun occupiedPortsFallThroughInTheProvidedOrder() {
    val occupied = REGISTERED_LOOPBACK_PORTS.take(3).map(::occupy)
    try {
      val bound = bindLoopbackPortCandidates(REGISTERED_LOOPBACK_PORTS)
        ?: error("no fallback port bound")
      try { assertEquals(REGISTERED_LOOPBACK_PORTS[3], bound.port) }
      finally { bound.server.close() }
    } finally {
      occupied.forEach(ServerSocket::close)
    }
  }

  @Test fun allOccupiedPortsFailClosed() {
    val occupied = REGISTERED_LOOPBACK_PORTS.map(::occupy)
    try { assertNull(bindLoopbackPortCandidates(REGISTERED_LOOPBACK_PORTS)) }
    finally { occupied.forEach(ServerSocket::close) }
  }

  @Test fun unregisteredCandidatesAreNeverBound() {
    assertNull(bindLoopbackPortCandidates(listOf(47645, 52712)))
  }

}
