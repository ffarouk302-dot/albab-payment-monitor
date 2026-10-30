package com.albab.paymentmonitor

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * Stores only future VF-Cash notifications in a bounded local queue.
 *
 * Parsing and server submission stay in Dart so the business rules remain
 * testable. The queue survives a closed Flutter activity and is acknowledged
 * only after the Edge Function accepts the event.
 */
class PaymentMonitorSmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        if (messages.isEmpty()) return

        val sender = messages.firstOrNull()?.displayOriginatingAddress ?: return
        if (!sender.equals(ALLOWED_SENDER, ignoreCase = true)) return

        val body = messages.joinToString(separator = "") { it.messageBody ?: "" }
        if (!body.contains("استلام") || !body.contains("مبلغ")) return

        val receivedAt = messages.minOfOrNull { it.timestampMillis }
            ?: System.currentTimeMillis()
        val id = "$receivedAt-${sender.hashCode()}-${body.hashCode()}"
        synchronized(QUEUE_LOCK) {
            val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            val current = JSONArray(
                preferences.getString(QUEUE_KEY, "[]") ?: "[]",
            )
            for (index in 0 until current.length()) {
                if (current.optJSONObject(index)?.optString("id") == id) return
            }

            current.put(
                JSONObject()
                    .put("id", id)
                    .put("sender", sender)
                    .put("body", body)
                    .put("receivedAt", receivedAt),
            )
            while (current.length() > MAX_QUEUE_SIZE) current.remove(0)
            preferences.edit().putString(QUEUE_KEY, current.toString()).apply()
        }

        // When the monitor activity is visible, Dart owns the queue. The
        // foreground service is only needed after the UI is backgrounded;
        // this prevents both processors from submitting the same SMS.
        if (isActive(context) && !isActivityVisible(context)) {
            val serviceIntent = Intent(context, PaymentMonitorService::class.java)
            ContextCompat.startForegroundService(context, serviceIntent)
        }
    }

    companion object {
        const val PREFERENCES = "albab_payment_monitor_sms"
        const val QUEUE_KEY = "pending_sms"
        const val COMPLETED_KEY = "completed_sms"
        const val ACTIVE_KEY = "monitor_active"
        const val ACTIVITY_VISIBLE_KEY = "monitor_activity_visible"
        const val DEVICE_ID_KEY = "monitor_device_id"
        const val FUNCTION_URL_KEY = "monitor_function_url"
        const val WALLET_KEY = "monitor_wallet_number"
        val QUEUE_LOCK = Any()
        private const val ALLOWED_SENDER = "VF-Cash"
        private const val MAX_QUEUE_SIZE = 100

        fun isActive(context: Context): Boolean = context.getSharedPreferences(
            PREFERENCES,
            Context.MODE_PRIVATE,
        ).getBoolean(ACTIVE_KEY, false)

        fun isActivityVisible(context: Context): Boolean = context.getSharedPreferences(
            PREFERENCES,
            Context.MODE_PRIVATE,
        ).getBoolean(ACTIVITY_VISIBLE_KEY, false)

        fun setActivityVisible(context: Context, visible: Boolean) {
            context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(ACTIVITY_VISIBLE_KEY, visible)
                .apply()
        }

        fun activate(
            context: Context,
            deviceId: String,
            functionUrl: String,
            walletNumber: String,
        ) {
            context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(ACTIVE_KEY, true)
                .putString(DEVICE_ID_KEY, deviceId)
                .putString(FUNCTION_URL_KEY, functionUrl)
                .putString(WALLET_KEY, walletNumber)
                .apply()
        }

        fun deactivate(context: Context) {
            context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(ACTIVE_KEY, false)
                .apply()
        }

        fun pending(context: Context): JSONArray = synchronized(QUEUE_LOCK) {
            val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            JSONArray(preferences.getString(QUEUE_KEY, "[]") ?: "[]")
        }

        fun acknowledge(context: Context, ids: Set<String>) {
            if (ids.isEmpty()) return
            synchronized(QUEUE_LOCK) {
                val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
                val current = JSONArray(preferences.getString(QUEUE_KEY, "[]") ?: "[]")
                val remaining = JSONArray()
                for (index in 0 until current.length()) {
                    val item = current.optJSONObject(index) ?: continue
                    if (!ids.contains(item.optString("id"))) remaining.put(item)
                }
                preferences.edit().putString(QUEUE_KEY, remaining.toString()).apply()
            }
        }

        fun recordCompleted(
            context: Context,
            event: JSONObject,
            response: JSONObject,
        ) = synchronized(QUEUE_LOCK) {
            val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            val current = JSONArray(
                preferences.getString(COMPLETED_KEY, "[]") ?: "[]",
            )
            val eventId = event.optString("id")
            for (index in 0 until current.length()) {
                val existing = current.optJSONObject(index) ?: continue
                if (existing.optJSONObject("event")?.optString("id") == eventId) return
            }

            val record = JSONObject()
                .put("event", event)
                .put("decision", response.optString("decision", "review"))
                .put("message", response.optString("message", ""))
                .put("orderId", response.optString("orderId").ifEmpty { JSONObject.NULL })
                .put("processedAt", System.currentTimeMillis())
            current.put(record)
            while (current.length() > MAX_QUEUE_SIZE) current.remove(0)
            preferences.edit().putString(COMPLETED_KEY, current.toString()).apply()
        }

        fun completed(context: Context): JSONArray = synchronized(QUEUE_LOCK) {
            val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            JSONArray(preferences.getString(COMPLETED_KEY, "[]") ?: "[]")
        }

        fun acknowledgeCompleted(context: Context, eventIds: Set<String>) {
            if (eventIds.isEmpty()) return
            synchronized(QUEUE_LOCK) {
                val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
                val current = JSONArray(
                    preferences.getString(COMPLETED_KEY, "[]") ?: "[]",
                )
                val remaining = JSONArray()
                for (index in 0 until current.length()) {
                    val item = current.optJSONObject(index) ?: continue
                    val id = item.optJSONObject("event")?.optString("id")
                    if (id !in eventIds) remaining.put(item)
                }
                preferences.edit().putString(COMPLETED_KEY, remaining.toString()).apply()
            }
        }

        fun clear(context: Context) = synchronized(QUEUE_LOCK) {
            context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
                .edit()
                .remove(QUEUE_KEY)
                .remove(COMPLETED_KEY)
                .apply()
        }
    }
}
