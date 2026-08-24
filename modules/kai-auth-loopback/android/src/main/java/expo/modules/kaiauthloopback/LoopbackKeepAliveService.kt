package expo.modules.kaiauthloopback

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

private const val CHANNEL_ID = "kai_auth_loopback"
private const val NOTIFICATION_ID = 1947

/** Keeps the loopback reader runnable while the browser is foregrounded on Android 15+. */
class LoopbackKeepAliveService : Service() {
  companion object {
    private val lifecycleLock = Any()
    @Volatile private var current: LoopbackKeepAliveService? = null
    @Volatile private var stopRequested = false
    private var startup: CompletableFuture<Unit>? = null

    fun startAndAwait(context: Context) {
      val ready = synchronized(lifecycleLock) {
        if (current != null || startup != null) {
          throw IllegalStateException("A KAI login service is already active.")
        }
        stopRequested = false
        CompletableFuture<Unit>().also { startup = it }
      }
      val intent = Intent(context, LoopbackKeepAliveService::class.java)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
        else context.startService(intent)
        ready.get(5, TimeUnit.SECONDS)
      } catch (error: Throwable) {
        stop()
        throw IllegalStateException("KAI login service could not enter the foreground.", error)
      }
    }

    fun stop() {
      val service = synchronized(lifecycleLock) {
        stopRequested = true
        startup?.completeExceptionally(IllegalStateException("KAI login service stopped."))
        startup = null
        current
      }
      service?.shutdown()
    }

    private fun foregroundReady(service: LoopbackKeepAliveService) {
      synchronized(lifecycleLock) {
        current = service
        if (stopRequested) {
          startup?.completeExceptionally(IllegalStateException("KAI login service stopped."))
        } else {
          startup?.complete(Unit)
        }
        startup = null
      }
    }

    private fun foregroundFailed(error: Throwable) {
      synchronized(lifecycleLock) {
        startup?.completeExceptionally(error)
        startup = null
      }
    }
  }

  override fun onCreate() {
    super.onCreate()
    try {
      val manager = getSystemService(NotificationManager::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        manager.createNotificationChannel(NotificationChannel(
          CHANNEL_ID,
          "KAI 账号登录",
          NotificationManager.IMPORTANCE_LOW,
        ).apply {
          description = "在系统浏览器登录期间保持本机安全回调可用"
          setShowBadge(false)
          setSound(null, null)
          enableVibration(false)
        })
      }
      val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
      val contentIntent = launchIntent?.let {
        PendingIntent.getActivity(
          this,
          0,
          it,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
      }
      val notificationBuilder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(this, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION") Notification.Builder(this)
      }
      val notification = notificationBuilder
        .setSmallIcon(android.R.drawable.ic_lock_lock)
        .setContentTitle("正在完成 KAI 账号验证")
        .setContentText("请在浏览器中完成登录")
        .setCategory(Notification.CATEGORY_SERVICE)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(contentIntent)
        .build()
      if (Build.VERSION.SDK_INT >= 34) {
        startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE,
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      foregroundReady(this)
    } catch (error: Throwable) {
      foregroundFailed(error)
      stopSelf()
      return
    }
    if (stopRequested) shutdown()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (stopRequested) shutdown()
    return START_NOT_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    LoopbackSessionManager.cancelAll()
    shutdown()
    super.onTaskRemoved(rootIntent)
  }

  override fun onTimeout(startId: Int) {
    LoopbackSessionManager.cancelAll()
    shutdown()
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    LoopbackSessionManager.cancelAll()
    shutdown()
  }

  override fun onDestroy() {
    synchronized(lifecycleLock) {
      if (current === this) current = null
    }
    LoopbackSessionManager.cancelAll()
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  private fun shutdown() {
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
