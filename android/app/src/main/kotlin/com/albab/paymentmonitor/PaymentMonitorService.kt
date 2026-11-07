package com.albab.paymentmonitor

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.google.android.gms.tasks.Tasks
import com.google.firebase.auth.FirebaseAuth
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Short-lived foreground worker started by the SMS receiver.
 *
 * It drains the private native queue while the Flutter activity is closed. The
 * server still owns all matching decisions; this service only parses the same
 * safe fields as the foreground Dart parser and sends no raw SMS body.
 */
class PaymentMonitorService : Service() {
    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    @Volatile
    private var processing = false

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_albab)
            .setContentTitle("مراقبة الدفع")
            .setContentText("جارٍ فحص إشعار التحويل")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        startForeground(NOTIFICATION_ID, notification)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!processing) {
            processing = true
            executor.execute {
                try {
                    drainQueue()
                } finally {
                    processing = false
                    stopSelf(startId)
                }
            }
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        executor.shutdownNow()
        super.onDestroy()
    }

    private fun drainQueue() {
        try {
            drainQueueSafely()
        } catch (_: Exception) {
            // Keep the queue intact. The next incoming SMS or foreground poll
            // will retry after the temporary auth/network failure is gone.
        }
    }

    private fun drainQueueSafely() {
        if (!PaymentMonitorSmsReceiver.isActive(this)) {
            PaymentMonitorSmsReceiver.clearPending(this)
            return
        }
        val currentUser = FirebaseAuth.getInstance().currentUser ?: run {
            PaymentMonitorSmsReceiver.clearPending(this)
            return
        }
        val preferences = getSharedPreferences(
            PaymentMonitorSmsReceiver.PREFERENCES,
            Context.MODE_PRIVATE,
        )
        val deviceId = preferences.getString(PaymentMonitorSmsReceiver.DEVICE_ID_KEY, null)
            ?: run {
                PaymentMonitorSmsReceiver.clearPending(this)
                return
            }
        val functionUrl = preferences.getString(
            PaymentMonitorSmsReceiver.FUNCTION_URL_KEY,
            null,
        ) ?: run {
            PaymentMonitorSmsReceiver.clearPending(this)
            return
        }
        val walletNumber = preferences.getString(
            PaymentMonitorSmsReceiver.WALLET_KEY,
            null,
        ) ?: run {
            PaymentMonitorSmsReceiver.clearPending(this)
            return
        }

        var token = Tasks.await(currentUser.getIdToken(false)).token ?: return
        val queue = PaymentMonitorSmsReceiver.pending(this)
        val acknowledged = mutableSetOf<String>()
        for (index in 0 until queue.length()) {
            val item = queue.optJSONObject(index) ?: continue
            val event = parseEvent(item)
            if (event == null) {
                acknowledged.add(item.optString("id"))
                continue
            }

            var response = postEvent(functionUrl, token, deviceId, walletNumber, event)
            if (response.statusCode == HttpURLConnection.HTTP_UNAUTHORIZED) {
                val refreshedToken = Tasks.await(currentUser.getIdToken(true)).token
                if (refreshedToken == null) {
                    PaymentMonitorSmsReceiver.clearPending(this)
                    break
                }
                token = refreshedToken
                response = postEvent(functionUrl, token, deviceId, walletNumber, event)
            }
            if (response.statusCode in 200..299) {
                response.body?.let { body ->
                    PaymentMonitorSmsReceiver.recordCompleted(this, event, body)
                }
                acknowledged.add(item.optString("id"))
            } else if (response.statusCode == HttpURLConnection.HTTP_FORBIDDEN ||
                response.statusCode == HttpURLConnection.HTTP_CONFLICT) {
                // Device denial, revocation, or deactivation is terminal for
                // the queued raw message. Do not retain it for a later retry.
                PaymentMonitorSmsReceiver.clearPending(this)
                break
            }
        }
        PaymentMonitorSmsReceiver.acknowledge(this, acknowledged)
    }

    private data class PostEventResult(
        val statusCode: Int,
        val body: JSONObject?,
    )

    private fun postEvent(
        functionUrl: String,
        token: String,
        deviceId: String,
        walletNumber: String,
        event: JSONObject,
    ): PostEventResult {
        val connection = URL(functionUrl).openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 15_000
            connection.readTimeout = 20_000
            connection.doOutput = true
            connection.setRequestProperty("Authorization", "Bearer $token")
            connection.setRequestProperty("Content-Type", "application/json")
            val payload = JSONObject()
                .put("action", "processSms")
                .put("deviceId", deviceId)
                .put("walletNumber", walletNumber)
                .put("event", event)
                .toString()
            connection.outputStream.use { stream ->
                stream.write(payload.toByteArray(Charsets.UTF_8))
            }
            val statusCode = connection.responseCode
            val responseStream = if (statusCode in 200..299) {
                connection.inputStream
            } else {
                connection.errorStream
            }
            val responseBody = responseStream?.bufferedReader()?.use { it.readText() }
            PostEventResult(
                statusCode = statusCode,
                body = responseBody
                    ?.takeIf { it.isNotBlank() }
                    ?.let { JSONObject(it) },
            )
        } finally {
            connection.disconnect()
        }
    }

    private fun parseEvent(item: JSONObject): JSONObject? {
        val id = item.optString("id")
        val sender = item.optString("sender")
        val body = item.optString("body")
        if (id.isEmpty() || !sender.equals("VF-Cash", ignoreCase = true)) return null
        if (!body.contains("استلام") || !body.contains("مبلغ")) return null

        val normalized = normalizeDigits(body)
        val amountText = Regex(
            "(?:مبلغ|بمبلغ)\\s*([0-9]+(?:[.,٫][0-9]+)?)\\s*(?:جنيه|ج\\.م)?",
        ).find(normalized)?.groupValues?.getOrNull(1)
        val senderPhone = Regex(
            "(?:من(?:\\s+رقم)?|from)\\s*[:：-]?\\s*(?:\\+?20)?(01[0-9]{9})",
            RegexOption.IGNORE_CASE,
        ).find(normalized)?.groupValues?.getOrNull(1)
        val walletNumber = Regex(
            "على\\s+رقم\\s+(?:محفظتك\\s*)?(?:\\+?20)?(01[0-9]{9})",
        ).find(normalized)?.groupValues?.getOrNull(1)
        val senderName = Regex(
            "المسجل\\s+ب[إا]?سم\\s+(.+?)(?=\\s+على\\s+رقم|\\s+بتاريخ|\\s+تاريخ|\\n|$)",
        ).find(normalized)?.groupValues?.getOrNull(1)?.trim()
        val reference = Regex(
            "(?:رقم\\s+العملية|رقم\\s+العمليه)\\s*[:：-]?\\s*([0-9]{8,})",
        ).find(normalized)?.groupValues?.getOrNull(1)

        return JSONObject()
            .put("id", id)
            .put("sender", sender)
            .put("receivedAt", isoUtc(item.optLong("receivedAt")))
            .put("amount", amountText?.replace(',', '.')?.replace('٫', '.')?.toDoubleOrNull()
                ?: JSONObject.NULL)
            .put("senderPhone", senderPhone ?: JSONObject.NULL)
            .put("senderName", senderName ?: JSONObject.NULL)
            .put("walletNumber", walletNumber ?: JSONObject.NULL)
            .put("reference", reference ?: JSONObject.NULL)
            .put("transactionAt", JSONObject.NULL)
    }

    private fun normalizeDigits(value: String): String = value
        .replace('٠', '0')
        .replace('١', '1')
        .replace('٢', '2')
        .replace('٣', '3')
        .replace('٤', '4')
        .replace('٥', '5')
        .replace('٦', '6')
        .replace('٧', '7')
        .replace('٨', '8')
        .replace('٩', '9')

    private fun isoUtc(millis: Long): String {
        val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        format.timeZone = TimeZone.getTimeZone("UTC")
        return format.format(Date(millis))
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "مراقبة الدفع",
            NotificationManager.IMPORTANCE_LOW,
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    companion object {
        private const val CHANNEL_ID = "payment_monitor"
        private const val NOTIFICATION_ID = 731
    }
}
