package expo.modules.kaiauthloopback

/**
 * Holds a terminal callback until JavaScript attaches its waiter. Access is serialized by the
 * session manager lock; keeping this tiny primitive Android-free makes the race executable in JVM
 * unit tests.
 */
internal class SingleUseTerminalMailbox<T> {
  private var entry: Pair<String, T>? = null

  fun store(attemptId: String, value: T) {
    entry = attemptId to value
  }

  fun take(attemptId: String): T? {
    val current = entry?.takeIf { it.first == attemptId } ?: return null
    entry = null
    return current.second
  }
}
