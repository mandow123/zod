package expo.modules.kaiauthloopback

import android.content.Context
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val FORMAL_APPLICATION_ID = "com.kaicloud.marketplace"

private class LoopbackUnavailableException(message: String) : CodedException(message)

class KaiAuthLoopbackModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("KaiAuthLoopback")

    AsyncFunction("startAsync") { attemptId: String, state: String, issuer: String ->
      if (context.packageName != FORMAL_APPLICATION_ID) {
        throw LoopbackUnavailableException("KAI loopback authentication is unavailable in this build.")
      }
      val activity = appContext.currentActivity
      if (activity == null || activity.isFinishing || activity.isDestroyed
        || activity !is LifecycleOwner
        || !activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
        throw LoopbackUnavailableException("KAI login must be started while the app is visible.")
      }
      LoopbackKeepAliveService.startAndAwait(context)
      try {
        LoopbackSessionManager.start(attemptId, state, issuer)
      } catch (error: Throwable) {
        LoopbackKeepAliveService.stop()
        throw error
      }
    }

    AsyncFunction("waitForCallbackAsync") { attemptId: String, promise: Promise ->
      LoopbackSessionManager.waitForCallback(attemptId, promise)
    }

    AsyncFunction("cancelAsync") { attemptId: String ->
      LoopbackSessionManager.cancel(attemptId, "ERR_KAI_LOOPBACK_CANCELED", "KAI authentication was canceled.")
    }

    AsyncFunction("isActiveAsync") { attemptId: String ->
      LoopbackSessionManager.isActive(attemptId)
    }

    OnDestroy {
      LoopbackSessionManager.cancelAll()
    }
  }
}
