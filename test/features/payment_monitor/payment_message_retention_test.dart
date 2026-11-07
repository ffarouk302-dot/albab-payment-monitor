import 'dart:convert';

import 'package:albab_payment_monitor/core/storage/local_storage.dart';
import 'package:albab_payment_monitor/features/payment_monitor/bloc/payment_monitor_cubit.dart';
import 'package:albab_payment_monitor/features/payment_monitor/data/payment_monitor_api.dart';
import 'package:albab_payment_monitor/features/payment_monitor/data/sms_monitor_platform.dart';
import 'package:albab_payment_monitor/features/payment_monitor/domain/payment_sms.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  test('terminal account cleanup removes monitor history and activation state',
      () async {
    final SharedPreferences preferences = await SharedPreferences.getInstance();
    final LocalStorage storage = LocalStorage(preferences);
    await storage.setString(
        LocalStorage.kPaymentMonitorDeviceId, 'rt-device-001');
    await storage.setBool(LocalStorage.kPaymentMonitorActivated, value: true);
    await storage.writeJsonList(
        LocalStorage.kPaymentMonitorHistory, <Map<String, dynamic>>[
      PaymentMonitorHistoryItem(
        event: PaymentSmsEvent(
          id: 'rt-event-001',
          sender: 'VF-Cash',
          receivedAt: DateTime.utc(2026, 11, 6),
          amount: 8,
          reference: 'rt-reference-001',
        ),
        decision: PaymentMonitorDecision.review,
        message: 'Synthetic manual review event',
        processedAt: DateTime.utc(2026, 11, 6),
      ).toJson(),
    ]);

    await storage.clearPaymentMonitorSensitiveData();

    expect(storage.readJsonList(LocalStorage.kPaymentMonitorHistory), isEmpty);
    expect(storage.getBool(LocalStorage.kPaymentMonitorActivated), isFalse);
    expect(storage.getString(LocalStorage.kPaymentMonitorDeviceId),
        'rt-device-001');
  });

  test(
      'persisted monitor history contains parsed metadata and no raw message body',
      () async {
    final SharedPreferences preferences = await SharedPreferences.getInstance();
    final LocalStorage storage = LocalStorage(preferences);
    await storage.writeJsonList(
        LocalStorage.kPaymentMonitorHistory, <Map<String, dynamic>>[
      PaymentMonitorHistoryItem(
        event: PaymentSmsEvent(
          id: 'rt-event-002',
          sender: 'VF-Cash',
          receivedAt: DateTime.utc(2026, 11, 6),
          amount: 8,
          reference: 'rt-reference-002',
        ),
        decision: PaymentMonitorDecision.review,
        message: 'تم إرسال العملية للمراجعة اليدوية.',
        processedAt: DateTime.utc(2026, 11, 6),
      ).toJson(),
    ]);

    final String persisted =
        preferences.getString(LocalStorage.kPaymentMonitorHistory)!;
    final Map<String, dynamic> history =
        (jsonDecode(persisted) as List<dynamic>).single as Map<String, dynamic>;
    final Map<String, dynamic> event = history['event'] as Map<String, dynamic>;
    expect(event.keys, isNot(contains('body')));
    expect(event.keys, isNot(contains('rawMessage')));
    expect(persisted, isNot(contains('SYNTHETIC RAW SMS')));
  });

  test('expired native SMS messages are acknowledged and removed before parsing', () async {
    const MethodChannel channel = MethodChannel('albab/payment_monitor_sms');
    final DateTime now = DateTime.utc(2026, 11, 6, 12);
    final List<String> acknowledged = <String>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (MethodCall call) async {
      if (call.method == 'pendingSms') {
        return <Map<String, Object>>[
          <String, Object>{
            'id': 'rt-expired-sms-001',
            'sender': 'VF-Cash',
            'body': 'SYNTHETIC RAW SMS: expired payment receipt',
            'receivedAt': now.subtract(const Duration(hours: 25)).millisecondsSinceEpoch,
          },
          <String, Object>{
            'id': 'rt-current-sms-001',
            'sender': 'VF-Cash',
            'body': 'تم استلام مبلغ 8 جنيه من رقم 01000000001 على رقم محفظتك 01017001654',
            'receivedAt': now.subtract(const Duration(minutes: 5)).millisecondsSinceEpoch,
          },
        ];
      }
      if (call.method == 'ackPendingSms') {
        final Map<dynamic, dynamic> arguments = call.arguments as Map<dynamic, dynamic>;
        acknowledged.addAll((arguments['ids'] as List<dynamic>).cast<String>());
      }
      return null;
    });

    try {
      final SmsMonitorPlatform platform = SmsMonitorPlatform(
        channel: channel,
        now: () => now,
      );
      final List<PaymentSmsEvent> events = await platform.pendingMessages();

      expect(events.map((PaymentSmsEvent event) => event.id), <String>['rt-current-sms-001']);
      expect(acknowledged, <String>['rt-expired-sms-001']);
      expect(events.single.toJson().containsKey('body'), isFalse);
    } finally {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    }
  });
}
