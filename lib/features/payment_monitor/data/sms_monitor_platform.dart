import 'dart:convert';

import 'package:flutter/services.dart';

import '../domain/payment_sms.dart';

class CompletedPaymentSms {
  const CompletedPaymentSms({
    required this.event,
    required this.decision,
    required this.message,
    required this.processedAt,
    this.orderId,
  });

  final PaymentSmsEvent event;
  final String decision;
  final String message;
  final DateTime processedAt;
  final String? orderId;

  factory CompletedPaymentSms.fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic> eventJson =
        (json['event'] as Map<dynamic, dynamic>?)?.map(
              (dynamic key, dynamic value) => MapEntry(key.toString(), value),
            ) ??
            <String, dynamic>{};
    return CompletedPaymentSms(
      event: PaymentSmsEvent.fromJson(eventJson),
      decision: json['decision'] as String? ?? 'review',
      message: json['message'] as String? ?? '',
      processedAt: DateTime.fromMillisecondsSinceEpoch(
        (json['processedAt'] as num?)?.toInt() ?? 0,
      ),
      orderId: json['orderId'] as String?,
    );
  }
}

/// Android bridge for the manifest SMS receiver.
///
/// The receiver persists only new VF-Cash notifications in a private native
/// queue. Dart consumes and acknowledges items after the server responds, so a
/// temporary network failure does not lose a payment notification.
class SmsMonitorPlatform {
  SmsMonitorPlatform({MethodChannel? channel, DateTime Function()? now})
      : _channel = channel ?? const MethodChannel(_channelName),
        _now = now ?? DateTime.now;

  static const String _channelName = 'albab/payment_monitor_sms';
  static const Duration pendingMessageRetention = Duration(hours: 24);
  static const Duration maximumFutureClockSkew = Duration(minutes: 5);
  final MethodChannel _channel;
  final DateTime Function() _now;

  Future<bool> hasReceiveSmsPermission() async {
    final bool? granted = await _channel.invokeMethod<bool>('hasSmsPermission');
    return granted ?? false;
  }

  Future<void> requestReceiveSmsPermission() =>
      _channel.invokeMethod<void>('requestSmsPermission');

  Future<Map<String, String>> deviceInfo() async {
    final Map<dynamic, dynamic> raw =
        await _channel.invokeMethod<Map<dynamic, dynamic>>('deviceInfo') ??
            const <dynamic, dynamic>{};
    return raw.map(
      (dynamic key, dynamic value) =>
          MapEntry(key.toString(), value.toString()),
    );
  }

  Future<void> clearPendingMessages() =>
      _channel.invokeMethod<void>('clearPendingSms');

  Future<void> activate({
    required String deviceId,
    required String functionUrl,
    required String walletNumber,
  }) =>
      _channel.invokeMethod<void>('activateMonitor', <String, dynamic>{
        'deviceId': deviceId,
        'functionUrl': functionUrl,
        'walletNumber': walletNumber,
      });

  Future<void> deactivate() => _channel.invokeMethod<void>('deactivateMonitor');

  Future<List<PaymentSmsEvent>> pendingMessages() async {
    final List<dynamic> raw =
        await _channel.invokeMethod<List<dynamic>>('pendingSms') ??
            const <dynamic>[];
    final List<PaymentSmsEvent> events = <PaymentSmsEvent>[];
    final List<String> discardedIds = <String>[];
    final DateTime now = _now();
    for (final dynamic value in raw) {
      if (value is! Map<dynamic, dynamic>) continue;
      final Map<String, dynamic> json = value.map(
        (dynamic key, dynamic item) => MapEntry(key.toString(), item),
      );
      final String id = json['id'] as String? ?? '';
      final DateTime receivedAt = DateTime.fromMillisecondsSinceEpoch(
        (json['receivedAt'] as num?)?.toInt() ?? 0,
      );
      final Duration age = now.difference(receivedAt);
      if (id.isEmpty ||
          receivedAt.millisecondsSinceEpoch <= 0 ||
          age > pendingMessageRetention ||
          age < -maximumFutureClockSkew) {
        if (id.isNotEmpty) discardedIds.add(id);
        continue;
      }
      final PaymentSmsEvent? event = PaymentSmsParser.parse(
        id: id,
        sender: json['sender'] as String? ?? '',
        body: json['body'] as String? ?? '',
        receivedAt: receivedAt,
      );
      if (event == null) {
        discardedIds.add(id);
      } else {
        events.add(event);
      }
    }
    if (discardedIds.isNotEmpty) await acknowledge(discardedIds);
    return events;
  }

  Future<List<CompletedPaymentSms>> completedMessages() async {
    final List<dynamic> raw =
        await _channel.invokeMethod<List<dynamic>>('completedSms') ??
            const <dynamic>[];
    return raw
        .whereType<String>()
        .map((String value) {
          try {
            final dynamic decoded = jsonDecode(value);
            if (decoded is! Map<dynamic, dynamic>) return null;
            return CompletedPaymentSms.fromJson(
              decoded.map(
                (dynamic key, dynamic item) => MapEntry(key.toString(), item),
              ),
            );
          } on Object {
            return null;
          }
        })
        .whereType<CompletedPaymentSms>()
        .toList(growable: false);
  }

  Future<void> acknowledge(List<String> ids) => _channel.invokeMethod<void>(
        'ackPendingSms',
        <String, dynamic>{'ids': ids},
      );

  Future<void> acknowledgeCompleted(List<String> ids) =>
      _channel.invokeMethod<void>(
        'ackCompletedSms',
        <String, dynamic>{'ids': ids},
      );
}
