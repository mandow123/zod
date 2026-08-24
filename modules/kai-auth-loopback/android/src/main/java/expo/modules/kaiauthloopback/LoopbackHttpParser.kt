package expo.modules.kaiauthloopback

import java.net.URLDecoder
import java.nio.charset.StandardCharsets

internal const val LOOPBACK_PATH = "/oauth2redirect/kai"
internal const val MAX_HTTP_HEAD_BYTES = 8 * 1024

internal data class ExpectedLoopbackRequest(
  val port: Int,
  val state: String,
  val issuer: String,
)

internal sealed interface ParsedLoopbackRequest {
  data class Code(val code: String, val state: String, val issuer: String) : ParsedLoopbackRequest
  data class Error(val error: String, val state: String, val issuer: String) : ParsedLoopbackRequest
  data object Ignored : ParsedLoopbackRequest
}

private val safeState = Regex("^[A-Za-z0-9._~-]{32,256}$")
private val safeError = Regex("^[a-z_]{3,80}$")
private val encodedControl = Regex("%(?:0[0-9A-Fa-f]|1[0-9A-Fa-f]|7[Ff])")

private fun decodeQueryComponent(value: String): String? = try {
  URLDecoder.decode(value, StandardCharsets.UTF_8.name())
    .takeIf { decoded -> decoded.none { it.code < 0x20 || it.code == 0x7f } }
} catch (_: IllegalArgumentException) {
  null
}

internal fun parseLoopbackHttpHead(
  head: ByteArray,
  expected: ExpectedLoopbackRequest,
): ParsedLoopbackRequest {
  if (head.isEmpty() || head.size > MAX_HTTP_HEAD_BYTES) return ParsedLoopbackRequest.Ignored
  val text = head.toString(StandardCharsets.US_ASCII)
  if (!text.endsWith("\r\n\r\n") || text.any { it == '\u0000' }) return ParsedLoopbackRequest.Ignored
  val lines = text.removeSuffix("\r\n\r\n").split("\r\n")
  val requestParts = lines.firstOrNull()?.split(' ') ?: return ParsedLoopbackRequest.Ignored
  if (requestParts.size != 3 || requestParts[0] != "GET" || requestParts[2] != "HTTP/1.1") {
    return ParsedLoopbackRequest.Ignored
  }
  val target = requestParts[1]
  if (!target.startsWith('/') || target.contains('#') || target.contains('\\')
    || target.any { it.code < 0x20 || it.code > 0x7e } || encodedControl.containsMatchIn(target)) {
    return ParsedLoopbackRequest.Ignored
  }
  val separator = target.indexOf('?')
  val rawPath = if (separator < 0) target else target.substring(0, separator)
  if (rawPath != LOOPBACK_PATH) return ParsedLoopbackRequest.Ignored
  val rawQuery = if (separator < 0) "" else target.substring(separator + 1)
  if (rawQuery.isEmpty()) return ParsedLoopbackRequest.Ignored

  val headers = linkedMapOf<String, MutableList<String>>()
  for (line in lines.drop(1)) {
    if (line.isEmpty() || line.first().isWhitespace()) return ParsedLoopbackRequest.Ignored
    val colon = line.indexOf(':')
    if (colon <= 0) return ParsedLoopbackRequest.Ignored
    val name = line.substring(0, colon).trim().lowercase()
    val value = line.substring(colon + 1).trim()
    if (!name.matches(Regex("^[a-z0-9!#$%&'*+.^_`|~-]+$"))
      || value.any { it.code < 0x20 && it != '\t' || it.code == 0x7f }) {
      return ParsedLoopbackRequest.Ignored
    }
    headers.getOrPut(name) { mutableListOf() }.add(value)
  }
  if (headers["host"] != listOf("127.0.0.1:${expected.port}")) return ParsedLoopbackRequest.Ignored
  if (headers.containsKey("transfer-encoding")) return ParsedLoopbackRequest.Ignored
  val contentLengths = headers["content-length"]
  if (contentLengths != null && contentLengths != listOf("0")) return ParsedLoopbackRequest.Ignored

  val parameters = linkedMapOf<String, MutableList<String>>()
  for (pair in rawQuery.split('&')) {
    if (pair.isEmpty()) continue
    val equals = pair.indexOf('=')
    val rawName = if (equals < 0) pair else pair.substring(0, equals)
    val rawValue = if (equals < 0) "" else pair.substring(equals + 1)
    val name = decodeQueryComponent(rawName) ?: return ParsedLoopbackRequest.Ignored
    val value = decodeQueryComponent(rawValue) ?: return ParsedLoopbackRequest.Ignored
    parameters.getOrPut(name) { mutableListOf() }.add(value)
  }
  for (name in listOf("state", "iss", "code", "error")) {
    if ((parameters[name]?.size ?: 0) > 1) return ParsedLoopbackRequest.Ignored
  }
  val state = parameters["state"]?.singleOrNull() ?: return ParsedLoopbackRequest.Ignored
  val issuer = parameters["iss"]?.singleOrNull() ?: return ParsedLoopbackRequest.Ignored
  if (!safeState.matches(state) || state != expected.state || issuer != expected.issuer) {
    return ParsedLoopbackRequest.Ignored
  }
  val code = parameters["code"]?.singleOrNull()
  val error = parameters["error"]?.singleOrNull()
  if ((code == null) == (error == null)) return ParsedLoopbackRequest.Ignored
  if (code != null) {
    if (code.length !in 20..2048 || code.any { it.code < 0x20 || it.code == 0x7f }) {
      return ParsedLoopbackRequest.Ignored
    }
    return ParsedLoopbackRequest.Code(code, state, issuer)
  }
  if (error == null || !safeError.matches(error)) return ParsedLoopbackRequest.Ignored
  return ParsedLoopbackRequest.Error(error, state, issuer)
}
