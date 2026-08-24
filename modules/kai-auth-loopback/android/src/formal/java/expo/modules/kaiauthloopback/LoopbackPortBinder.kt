package expo.modules.kaiauthloopback

import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket

internal val REGISTERED_LOOPBACK_PORTS = listOf(
  52711, 53419, 54127, 54833, 55603, 56311, 57119, 57901, 58687,
)
internal val IPV4_LOOPBACK: InetAddress = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))

internal data class BoundLoopbackPort(val port: Int, val server: ServerSocket)

internal fun bindLoopbackPortCandidates(candidates: List<Int>): BoundLoopbackPort? {
  for (port in candidates) {
    if (port !in REGISTERED_LOOPBACK_PORTS) continue
    val candidate = ServerSocket()
    try {
      candidate.reuseAddress = false
      candidate.bind(InetSocketAddress(IPV4_LOOPBACK, port), 4)
      return BoundLoopbackPort(port, candidate)
    } catch (_: Exception) {
      candidate.close()
    }
  }
  return null
}
