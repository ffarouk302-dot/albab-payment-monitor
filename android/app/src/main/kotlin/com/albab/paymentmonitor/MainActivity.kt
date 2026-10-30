package com.albab.paymentmonitor

import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val channelName = "albab/payment_monitor_sms"
    private val permissionRequestCode = 2401

    override fun onStart() {
        super.onStart()
        PaymentMonitorSmsReceiver.setActivityVisible(this, true)
    }

    override fun onStop() {
        PaymentMonitorSmsReceiver.setActivityVisible(this, false)
        super.onStop()
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "hasSmsPermission" -> result.success(hasSmsPermission())
                    "requestSmsPermission" -> {
                        if (!hasSmsPermission()) {
                            requestPermissions(
                                arrayOf(Manifest.permission.RECEIVE_SMS),
                                permissionRequestCode,
                            )
                        }
                        result.success(null)
                    }
                    "pendingSms" -> result.success(readPendingMessages())
                    "completedSms" -> result.success(readCompletedMessages())
                    "clearPendingSms" -> {
                        PaymentMonitorSmsReceiver.clear(this)
                        result.success(null)
                    }
                    "ackPendingSms" -> {
                        val ids = (call.argument<List<String>>("ids") ?: emptyList()).toSet()
                        PaymentMonitorSmsReceiver.acknowledge(this, ids)
                        result.success(null)
                    }
                    "ackCompletedSms" -> {
                        val ids = (call.argument<List<String>>("ids") ?: emptyList()).toSet()
                        PaymentMonitorSmsReceiver.acknowledgeCompleted(this, ids)
                        result.success(null)
                    }
                    "activateMonitor" -> {
                        PaymentMonitorSmsReceiver.activate(
                            this,
                            call.argument<String>("deviceId") ?: "",
                            call.argument<String>("functionUrl") ?: "",
                            call.argument<String>("walletNumber") ?: "",
                        )
                        result.success(null)
                    }
                    "deactivateMonitor" -> {
                        PaymentMonitorSmsReceiver.deactivate(this)
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    private fun hasSmsPermission(): Boolean =
        ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.RECEIVE_SMS,
        ) == PackageManager.PERMISSION_GRANTED

    private fun readPendingMessages(): List<Map<String, Any>> {
        val queue = PaymentMonitorSmsReceiver.pending(this)
        return buildList {
            for (index in 0 until queue.length()) {
                val item = queue.optJSONObject(index) ?: continue
                add(
                    mapOf(
                        "id" to item.optString("id"),
                        "sender" to item.optString("sender"),
                        "body" to item.optString("body"),
                        "receivedAt" to item.optLong("receivedAt"),
                    ),
                )
            }
        }
    }

    private fun readCompletedMessages(): List<String> {
        val completed = PaymentMonitorSmsReceiver.completed(this)
        return buildList {
            for (index in 0 until completed.length()) {
                completed.optJSONObject(index)?.let { add(it.toString()) }
            }
        }
    }
}
