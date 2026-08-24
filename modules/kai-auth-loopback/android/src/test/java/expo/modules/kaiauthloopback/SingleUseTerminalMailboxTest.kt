package expo.modules.kaiauthloopback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SingleUseTerminalMailboxTest {
  @Test fun callbackCompletedBeforeWaiterIsDeliveredExactlyOnce() {
    val mailbox = SingleUseTerminalMailbox<String>()
    mailbox.store("attempt-a", "authorization-code")

    assertEquals("authorization-code", mailbox.take("attempt-a"))
    assertNull(mailbox.take("attempt-a"))
  }

  @Test fun anotherAttemptCannotConsumeTheTerminalCallback() {
    val mailbox = SingleUseTerminalMailbox<String>()
    mailbox.store("attempt-a", "authorization-code")

    assertNull(mailbox.take("attempt-b"))
    assertEquals("authorization-code", mailbox.take("attempt-a"))
  }
}
