package expo.modules.kaiauthloopback

import java.net.InetAddress
import java.net.ServerSocket

// The test application contains no registered formal OAuth port and can never open a listener.
internal val REGISTERED_LOOPBACK_PORTS = emptyList<Int>()
internal val IPV4_LOOPBACK: InetAddress = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))

internal data class BoundLoopbackPort(val port: Int, val server: ServerSocket)

internal fun bindLoopbackPortCandidates(@Suppress("UNUSED_PARAMETER") candidates: List<Int>): BoundLoopbackPort? = null
