import 'dart:convert';

import 'package:albab_payment_monitor/features/payment_monitor/data/payment_monitor_api.dart';
import 'package:albab_payment_monitor/features/payment_monitor/domain/payment_sms.dart';
import 'package:firebase_auth/firebase_auth.dart' as firebase_auth;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class _SyntheticUser implements firebase_auth.User {
  @override
  Future<String?> getIdToken([bool forceRefresh = false]) async =>
      'synthetic-firebase-id-token';

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _SyntheticAuth implements firebase_auth.FirebaseAuth {
  _SyntheticAuth(this.currentUser);

  @override
  final firebase_auth.User? currentUser;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  test('submits only device-bound parsed evidence and returns server outcomes',
      () async {
    final List<http.Request> requests = <http.Request>[];
    final List<Map<String, dynamic>> responses = <Map<String, dynamic>>[
      <String, dynamic>{
        'decision': 'review',
        'message': 'تم إرسال التحويل للمراجعة اليدوية.',
        'reference': 'rt-reference-0001',
        'duplicate': false,
      },
      <String, dynamic>{
        'decision': 'duplicate',
        'message': 'الرقم المرجعي مسجل من قبل للمراجعة اليدوية.',
        'reference': 'rt-reference-0001',
        'duplicate': true,
      },
    ];
    final PaymentMonitorApi api = PaymentMonitorApi(
      auth: _SyntheticAuth(_SyntheticUser()),
      client: MockClient((http.Request request) async {
        requests.add(request);
        return http.Response.bytes(
          utf8.encode(jsonEncode(responses.removeAt(0))),
          200,
          headers: <String, String>{
            'content-type': 'application/json; charset=utf-8',
          },
        );
      }),
    );
    final PaymentSmsEvent event = PaymentSmsEvent(
      id: 'rt-event-0001',
      sender: 'VF-Cash',
      receivedAt: DateTime.utc(2026, 11, 6, 9),
      amount: 8,
      senderPhone: '01000000001',
      senderName: 'Synthetic Payer',
      walletNumber: '01017001654',
      reference: 'rt-reference-0001',
      transactionAt: DateTime.utc(2026, 11, 6, 8, 59),
    );

    final PaymentMonitorResponse first = await api.submitEvent(
      event: event,
      deviceId: 'rt-device-0001',
      walletNumber: '01017001654',
    );
    final PaymentMonitorResponse retry = await api.submitEvent(
      event: event,
      deviceId: 'rt-device-0001',
      walletNumber: '01017001654',
    );

    expect(first.decision, PaymentMonitorDecision.review);
    expect(retry.decision, PaymentMonitorDecision.duplicate);
    expect(requests, hasLength(2));
    for (final http.Request request in requests) {
      expect(request.headers['Authorization'],
          'Bearer synthetic-firebase-id-token');
      final Map<String, dynamic> body =
          jsonDecode(request.body) as Map<String, dynamic>;
      expect(body['deviceId'], 'rt-device-0001');
      expect(body['walletNumber'], '01017001654');
      final Map<String, dynamic> submittedEvent =
          body['event'] as Map<String, dynamic>;
      expect(submittedEvent['id'], 'rt-event-0001');
      expect(submittedEvent['reference'], 'rt-reference-0001');
      expect(submittedEvent.containsKey('body'), isFalse);
      expect(request.body, isNot(contains('rawMessage')));
    }
    expect(
      (jsonDecode(requests[0].body) as Map<String, dynamic>)['event'],
      (jsonDecode(requests[1].body) as Map<String, dynamic>)['event'],
      reason:
          'a retry must preserve the server idempotency event ID and evidence',
    );
  });

  test('does not convert a rejected device response into a review decision',
      () async {
    final PaymentMonitorApi api = PaymentMonitorApi(
      auth: _SyntheticAuth(_SyntheticUser()),
      client: MockClient((http.Request _) async => http.Response.bytes(
            utf8.encode(
                jsonEncode(<String, String>{'message': 'الجهاز غير معتمد.'})),
            403,
            headers: <String, String>{
              'content-type': 'application/json; charset=utf-8',
            },
          )),
    );

    await expectLater(
      api.submitEvent(
        event: PaymentSmsEvent(
          id: 'rt-event-rejected',
          sender: 'VF-Cash',
          receivedAt: DateTime.utc(2026),
        ),
        deviceId: 'rt-device-rejected',
        walletNumber: '01017001654',
      ),
      throwsA(isA<PaymentMonitorApiException>().having(
        (PaymentMonitorApiException error) => error.statusCode,
        'statusCode',
        403,
      )),
    );
  });
}
