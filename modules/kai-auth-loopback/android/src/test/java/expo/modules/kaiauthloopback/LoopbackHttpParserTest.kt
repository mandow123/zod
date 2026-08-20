package expo.modules.kaiauthloopback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

class LoopbackHttpParserTest {
  private val state = "s".repeat(48)
  private val issuer = "https://auth.kai.com/api/auth"
  private val expected = ExpectedLoopbackRequest(52711, state, issuer)

  private fun request(target: String, headers: String = "Host: 127.0.0.1:52711\r\n") =
    "GET $target HTTP/1.1\r\n$headers\r\n".toByteArray(StandardCharsets.US_ASCII)

  private fun rawRequest(
    requestLine: String,
    headers: String = "Host: 127.0.0.1:52711\r\n",
  ) = "$requestLine\r\n$headers\r\n".toByteArray(StandardCharsets.US_ASCII)

  private fun validTarget(extra: String = "code=${"c".repeat(64)}") =
    "$LOOPBACK_PATH?state=$state&iss=${URLEncoder.encode(issuer, StandardCharsets.UTF_8.name())}&$extra"

  @Test fun acceptsOneExactCode() {
    val result = parseLoopbackHttpHead(request(validTarget()), expected)
    assertTrue(result is ParsedLoopbackRequest.Code)
  }

  @Test fun acceptsOneExactError() {
    val result = parseLoopbackHttpHead(request(validTarget("error=access_denied")), expected)
    assertEquals(ParsedLoopbackRequest.Error("access_denied", state, issuer), result)
  }

  @Test fun codeAndErrorUseDifferentNonReflectiveTerminalMessages() {
    val code = parseLoopbackHttpHead(request(validTarget()), expected)
    val error = parseLoopbackHttpHead(request(validTarget("error=access_denied")), expected)
    assertEquals("授权结果已返回 Zod，请回到 App 继续完成登录。", loopbackTerminalMessage(code))
    assertEquals("KAI 登录未完成，请回到 Zod 查看原因。", loopbackTerminalMessage(error))
  }

  @Test fun rejectsWrongMethodPathHostAndBody() {
    assertEquals(ParsedLoopbackRequest.Ignored,
      parseLoopbackHttpHead(rawRequest("POST ${validTarget()} HTTP/1.1"), expected))
    assertEquals(ParsedLoopbackRequest.Ignored,
      parseLoopbackHttpHead(rawRequest("GET ${validTarget()} HTTP/1.0"), expected))
    assertEquals(ParsedLoopbackRequest.Ignored,
      parseLoopbackHttpHead(request(validTarget(), "Host: localhost:52711\r\n"), expected))
    assertEquals(ParsedLoopbackRequest.Ignored,
      parseLoopbackHttpHead(request(validTarget(), "Host: 127.0.0.1:52711\r\nHost: 127.0.0.1:52711\r\n"), expected))
    assertEquals(ParsedLoopbackRequest.Ignored,
      parseLoopbackHttpHead(request("/favicon.ico"), expected))
    assertEquals(ParsedLoopbackRequest.Ignored,
      parseLoopbackHttpHead(request(validTarget(), "Host: 127.0.0.1:52711\r\nContent-Length: 1\r\n"), expected))
    assertEquals(ParsedLoopbackRequest.Ignored,
      parseLoopbackHttpHead(request(validTarget(), "Host: 127.0.0.1:52711\r\nTransfer-Encoding: chunked\r\n"), expected))
    val absolute = "GET http://127.0.0.1:52711${validTarget()} HTTP/1.1\r\nHost: 127.0.0.1:52711\r\n\r\n"
    assertEquals(ParsedLoopbackRequest.Ignored,
      parseLoopbackHttpHead(absolute.toByteArray(StandardCharsets.US_ASCII), expected))
  }

  @Test fun rejectsDuplicateOrConflictingSensitiveParameters() {
    assertEquals(ParsedLoopbackRequest.Ignored,
      parseLoopbackHttpHead(request(validTarget("code=${"c".repeat(64)}&code=${"d".repeat(64)}")), expected))
    assertEquals(ParsedLoopbackRequest.Ignored,
      parseLoopbackHttpHead(request(validTarget("code=${"c".repeat(64)}&error=access_denied")), expected))
    assertEquals(ParsedLoopbackRequest.Ignored,
      parseLoopbackHttpHead(request("$LOOPBACK_PATH?state=${"x".repeat(48)}&iss=${URLEncoder.encode(issuer, "UTF-8")}&code=${"c".repeat(64)}"), expected))
    assertEquals(ParsedLoopbackRequest.Ignored,
      parseLoopbackHttpHead(request("$LOOPBACK_PATH?state=$state&%73tate=$state&iss=${URLEncoder.encode(issuer, "UTF-8")}&code=${"c".repeat(64)}"), expected))
    assertEquals(ParsedLoopbackRequest.Ignored,
      parseLoopbackHttpHead(request("$LOOPBACK_PATH?state=$state&iss=${URLEncoder.encode("https://evil.example/", "UTF-8")}&code=${"c".repeat(64)}"), expected))
  }

  @Test fun rejectsFragmentsDangerousEncodingAndEncodedPath() {
    assertEquals(ParsedLoopbackRequest.Ignored,
      parseLoopbackHttpHead(request("${validTarget()}#fragment"), expected))
    assertEquals(ParsedLoopbackRequest.Ignored,
      parseLoopbackHttpHead(request("$LOOPBACK_PATH?state=$state&iss=${URLEncoder.encode(issuer, "UTF-8")}&code=${"c".repeat(20)}%0a"), expected))
    assertEquals(ParsedLoopbackRequest.Ignored,
      parseLoopbackHttpHead(request("/oauth2redirect/%6bai?state=$state&iss=${URLEncoder.encode(issuer, "UTF-8")}&code=${"c".repeat(64)}"), expected))
    assertEquals(ParsedLoopbackRequest.Ignored,
      parseLoopbackHttpHead(request("$LOOPBACK_PATH?state=$state&iss=%ZZ&code=${"c".repeat(64)}"), expected))
  }

  @Test fun rejectsPartialAndOversizeHeads() {
    assertEquals(ParsedLoopbackRequest.Ignored,
      parseLoopbackHttpHead("GET / HTTP/1.1\r\n".toByteArray(StandardCharsets.US_ASCII), expected))
    assertEquals(ParsedLoopbackRequest.Ignored,
      parseLoopbackHttpHead(ByteArray(MAX_HTTP_HEAD_BYTES + 1) { 'a'.code.toByte() }, expected))
  }
}
