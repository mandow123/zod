package expo.modules.kaiauthloopback

import android.os.Bundle
import android.os.SystemClock
import androidx.core.os.bundleOf
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import java.io.ByteArrayOutputStream
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.util.Collections
import java.util.concurrent.atomic.AtomicBoolean

internal const val LISTENER_LIFETIME_MILLISECONDS = 120_000L
private const val ACCEPT_POLL_MILLISECONDS = 500
private const val CLIENT_READ_TIMEOUT_MILLISECONDS = 2_000
private val safeAttemptId = Regex("^[0-9a-fA-F-]{36}$")

private class LoopbackSessionException(code: String, message: String) : CodedException(code, message, null)

private data class ActiveSession(
  val attemptId: String,
  val state: String,
  val issuer: String,
  val port: Int,
  val server: ServerSocket,
  val lifetime: LoopbackLifetime,
  val closed: AtomicBoolean = AtomicBoolean(false),
  var promise: Promise? = null,
)

internal class LoopbackLifetime(
  private val elapsedRealtime: () -> Long,
) {
  private val deadlineElapsedRealtime = elapsedRealtime() + LISTENER_LIFETIME_MILLISECONDS

  fun remainingMilliseconds(): Long =
    (deadlineElapsedRealtime - elapsedRealtime()).coerceAtLeast(0L)

  fun expired(): Boolean = remainingMilliseconds() == 0L
}

private data class TerminalSession(
  val attemptId: String,
  val result: Bundle?,
  val errorCode: String?,
  val errorMessage: String?,
)

internal object LoopbackSessionManager {
  private val lock = Any()
  private var active: ActiveSession? = null
  private val terminalMailbox = SingleUseTerminalMailbox<TerminalSession>()

  fun start(attemptId: String, state: String, issuer: String): Bundle {
    if (!safeAttemptId.matches(attemptId) || !state.matches(Regex("^[A-Za-z0-9._~-]{32,256}$"))
      || issuer != "https://auth.kai.com/api/auth") {
      throw LoopbackSessionException("ERR_KAI_LOOPBACK_INPUT", "Invalid loopback authentication input.")
    }
    synchronized(lock) {
      if (active != null) {
        throw LoopbackSessionException("ERR_KAI_LOOPBACK_ACTIVE", "A loopback authentication session is already active.")
      }
      val shuffled = REGISTERED_LOOPBACK_PORTS.toMutableList()
      Collections.shuffle(shuffled, SecureRandom())
      val selected = bindLoopbackPortCandidates(shuffled)
      if (selected == null) {
        throw LoopbackSessionException("ERR_KAI_LOOPBACK_PORTS_BUSY", "No registered loopback port is available.")
      }
      selected.server.soTimeout = ACCEPT_POLL_MILLISECONDS
      val session = ActiveSession(
        attemptId = attemptId,
        state = state,
        issuer = issuer,
        port = selected.port,
        server = selected.server,
        lifetime = LoopbackLifetime(SystemClock::elapsedRealtime),
      )
      active = session
      Thread({ acceptLoop(session) }, "kai-auth-loopback").apply {
        isDaemon = true
        start()
      }
      return bundleOf("redirectUri" to "http://127.0.0.1:${selected.port}$LOOPBACK_PATH")
    }
  }

  fun waitForCallback(attemptId: String, promise: Promise) {
    synchronized(lock) {
      val session = active
      if (session == null || session.attemptId != attemptId) {
        val completed = terminalMailbox.take(attemptId)
        if (completed != null) {
          if (completed.result != null) promise.resolve(completed.result)
          else promise.reject(
            completed.errorCode ?: "ERR_KAI_LOOPBACK",
            completed.errorMessage ?: "KAI authentication stopped.",
            null,
          )
        } else {
          promise.reject("ERR_KAI_LOOPBACK_INACTIVE", "The loopback authentication session is not active.", null)
        }
        return
      }
      if (session.promise != null) {
        promise.reject("ERR_KAI_LOOPBACK_WAITER", "The loopback authentication session already has a waiter.", null)
        return
      }
      session.promise = promise
    }
  }

  fun isActive(attemptId: String): Boolean = synchronized(lock) {
    active?.let { it.attemptId == attemptId && !it.closed.get() } == true
  }

  fun cancel(attemptId: String, code: String, message: String) {
    val session = synchronized(lock) { active?.takeIf { it.attemptId == attemptId } } ?: return
    terminate(session, null, code, message)
  }

  fun cancelAll() {
    val session = synchronized(lock) { active } ?: return
    terminate(session, null, "ERR_KAI_LOOPBACK_DESTROYED", "The loopback authentication session was interrupted.")
  }

  private fun acceptLoop(session: ActiveSession) {
    while (!session.closed.get()) {
      if (session.lifetime.expired()) {
        terminate(session, null, "ERR_KAI_LOOPBACK_TIMEOUT", "KAI authentication timed out.")
        return
      }
      session.server.soTimeout = minOf(
        ACCEPT_POLL_MILLISECONDS.toLong(),
        session.lifetime.remainingMilliseconds().coerceAtLeast(1L),
      ).toInt()
      try {
        session.server.accept().use { client -> handleClient(session, client) }
      } catch (_: SocketTimeoutException) {
        continue
      } catch (_: Exception) {
        if (!session.closed.get()) {
          terminate(session, null, "ERR_KAI_LOOPBACK_IO", "The loopback listener stopped unexpectedly.")
        }
        return
      }
    }
  }

  private fun handleClient(session: ActiveSession, client: Socket) {
    client.soTimeout = CLIENT_READ_TIMEOUT_MILLISECONDS
    if (!client.inetAddress.isLoopbackAddress || client.inetAddress.hostAddress != "127.0.0.1") {
      writeResponse(client, 403, "请求未被接受。")
      return
    }
    val head = try { readHttpHead(client) } catch (_: Exception) { null }
    if (head == null) {
      writeResponse(client, 400, "请求未被接受。")
      return
    }
    when (val parsed = parseLoopbackHttpHead(
      head,
      ExpectedLoopbackRequest(session.port, session.state, session.issuer),
    )) {
      ParsedLoopbackRequest.Ignored -> writeResponse(client, 400, "请求未被接受。")
      is ParsedLoopbackRequest.Code -> {
        val result = bundleOf(
          "kind" to "code", "code" to parsed.code, "state" to parsed.state, "issuer" to parsed.issuer,
        )
        writeResponse(client, 200, "KAI 验证已完成，请返回 Zod App。")
        terminate(session, result, null, null)
      }
      is ParsedLoopbackRequest.Error -> {
        val result = bundleOf(
          "kind" to "error", "error" to parsed.error, "state" to parsed.state, "issuer" to parsed.issuer,
        )
        writeResponse(client, 200, "KAI 验证已完成，请返回 Zod App。")
        terminate(session, result, null, null)
      }
    }
  }

  private fun readHttpHead(client: Socket): ByteArray? {
    val output = ByteArrayOutputStream()
    var matched = 0
    while (output.size() <= MAX_HTTP_HEAD_BYTES) {
      val next = client.getInputStream().read()
      if (next < 0) return null
      output.write(next)
      matched = when {
        matched == 0 && next == '\r'.code -> 1
        matched == 1 && next == '\n'.code -> 2
        matched == 2 && next == '\r'.code -> 3
        matched == 3 && next == '\n'.code -> return output.toByteArray()
        next == '\r'.code -> 1
        else -> 0
      }
    }
    return null
  }

  private fun writeResponse(client: Socket, status: Int, message: String) {
    val body = "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>Zod</title><body><p>$message</p></body></html>"
      .toByteArray(Charsets.UTF_8)
    val reason = if (status == 200) "OK" else if (status == 403) "Forbidden" else "Bad Request"
    val headers = buildString {
      append("HTTP/1.1 $status $reason\r\n")
      append("Content-Type: text/html; charset=utf-8\r\n")
      append("Content-Length: ${body.size}\r\n")
      append("Cache-Control: no-store\r\n")
      append("Pragma: no-cache\r\n")
      append("Referrer-Policy: no-referrer\r\n")
      append("X-Content-Type-Options: nosniff\r\n")
      append("Content-Security-Policy: default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox\r\n")
      append("Connection: close\r\n\r\n")
    }.toByteArray(StandardCharsets.US_ASCII)
    try {
      client.getOutputStream().write(headers)
      client.getOutputStream().write(body)
      client.getOutputStream().flush()
    } catch (_: Exception) {
      // The listener lifecycle must not depend on the browser reading the static response.
    }
  }

  private fun terminate(
    session: ActiveSession,
    result: Bundle?,
    errorCode: String?,
    errorMessage: String?,
  ) {
    if (!session.closed.compareAndSet(false, true)) return
    try { session.server.close() } catch (_: Exception) {}
    LoopbackKeepAliveService.stop()
    val waiter: Promise?
    synchronized(lock) {
      if (active === session) active = null
      waiter = session.promise
      session.promise = null
      if (waiter == null) {
        terminalMailbox.store(
          session.attemptId,
          TerminalSession(session.attemptId, result, errorCode, errorMessage),
        )
      }
    }
    if (result != null) waiter?.resolve(result)
    else waiter?.reject(errorCode ?: "ERR_KAI_LOOPBACK", errorMessage ?: "KAI authentication stopped.", null)
  }
}
