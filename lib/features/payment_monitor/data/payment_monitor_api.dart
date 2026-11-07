import 'dart:convert';

import 'package:firebase_auth/firebase_auth.dart' as firebase_auth;
import 'package:http/http.dart' as http;

import '../../../core/config/app_config.dart';
import '../domain/payment_sms.dart';

enum PaymentMonitorDecision {
  /// Legacy local-history value. The server no longer grants approval.
  @Deprecated('Server evidence is review-only.')
  matched,

  /// Legacy local-history value. Refunds are recorded by the delivery admin.
  @Deprecated('Refund decisions belong to the delivery secure operation.')
  refunded,
  review,
  duplicate,
  ignored,
}

enum PaymentMonitorDeviceAccess {
  pending,
  approved,
  rejected,
  revoked;

  static PaymentMonitorDeviceAccess fromName(String? value) =>
      PaymentMonitorDeviceAccess.values.firstWhere(
        (PaymentMonitorDeviceAccess access) => access.name == value,
        orElse: () => PaymentMonitorDeviceAccess.pending,
      );
}

class PaymentMonitorDeviceAccessResponse {
  const PaymentMonitorDeviceAccessResponse({
    required this.access,
    required this.message,
  });

  final PaymentMonitorDeviceAccess access;
  final String message;

  bool get isApproved => access == PaymentMonitorDeviceAccess.approved;

  factory PaymentMonitorDeviceAccessResponse.fromJson(
    Map<String, dynamic> json,
  ) =>
      PaymentMonitorDeviceAccessResponse(
        access: PaymentMonitorDeviceAccess.fromName(json['access'] as String?),
        message: json['message'] as String? ?? 'تم استلام طلب الجهاز.',
      );
}

class PaymentMonitorResponse {
  const PaymentMonitorResponse({
    required this.decision,
    required this.message,
    this.orderId,
    this.reference,
    this.evidenceId,
    this.linkedOperationId,
    this.linkedAttemptId,
  });

  final PaymentMonitorDecision decision;
  final String message;
  final String? orderId;
  final String? reference;
  final String? evidenceId;
  final String? linkedOperationId;
  final String? linkedAttemptId;
}

class PaymentMonitorApiException implements Exception {
  const PaymentMonitorApiException(this.message, {this.statusCode});

  final String message;
  final int? statusCode;

  @override
  String toString() => message;
}

/// Authenticated gateway for the monitor's two server actions.
class PaymentMonitorApi {
  PaymentMonitorApi({
    firebase_auth.FirebaseAuth? auth,
    http.Client? client,
  })  : _auth = auth ?? firebase_auth.FirebaseAuth.instance,
        _client = client ?? http.Client();

  final firebase_auth.FirebaseAuth _auth;
  final http.Client _client;

  Future<PaymentMonitorDeviceAccessResponse> requestDevice({
    required String deviceId,
    required String walletNumber,
    String deviceName = '',
    String androidVersion = '',
    String appVersion = '',
  }) async {
    final Map<String, dynamic> body = await _call(<String, dynamic>{
      'action': 'requestDevice',
      'deviceId': deviceId,
      'walletNumber': walletNumber,
      'deviceName': deviceName,
      'androidVersion': androidVersion,
      'appVersion': appVersion,
    });
    return PaymentMonitorDeviceAccessResponse.fromJson(body);
  }

  Future<PaymentMonitorDeviceAccessResponse> checkDevice({
    required String deviceId,
    required String walletNumber,
  }) async {
    final Map<String, dynamic> body = await _call(<String, dynamic>{
      'action': 'checkDevice',
      'deviceId': deviceId,
      'walletNumber': walletNumber,
    });
    return PaymentMonitorDeviceAccessResponse.fromJson(body);
  }

  Future<void> activateDevice({
    required String deviceId,
    required String walletNumber,
  }) async {
    await _call(<String, dynamic>{
      'action': 'activateDevice',
      'deviceId': deviceId,
      'walletNumber': walletNumber,
    });
  }

  Future<PaymentMonitorResponse> submitEvent({
    required PaymentSmsEvent event,
    required String deviceId,
    required String walletNumber,
  }) async {
    final Map<String, dynamic> body = await _call(<String, dynamic>{
      'action': 'processSms',
      'deviceId': deviceId,
      'walletNumber': walletNumber,
      'event': event.toJson(),
    });
    final String decision = body['decision'] as String? ?? 'review';
    return PaymentMonitorResponse(
      decision: PaymentMonitorDecision.values.firstWhere(
        (PaymentMonitorDecision value) => value.name == decision,
        orElse: () => PaymentMonitorDecision.review,
      ),
      message: body['message'] as String? ?? 'تم إرسال التحويل للمراجعة.',
      orderId: body['orderId'] as String?,
      reference: body['reference'] as String?,
      evidenceId: body['evidenceId'] as String?,
      linkedOperationId: body['linkedOperationId'] as String?,
      linkedAttemptId: body['linkedAttemptId'] as String?,
    );
  }

  Future<List<Map<String, dynamic>>> getHistory({
    required String deviceId,
    required String walletNumber,
  }) async {
    final Map<String, dynamic> body = await _call(<String, dynamic>{
      'action': 'getHistory',
      'deviceId': deviceId,
      'walletNumber': walletNumber,
    });
    final List<dynamic> raw = body['history'] as List<dynamic>? ?? <dynamic>[];
    return raw
        .whereType<Map<dynamic, dynamic>>()
        .map(
          (Map<dynamic, dynamic> value) => value.map(
            (dynamic key, dynamic item) => MapEntry(key.toString(), item),
          ),
        )
        .toList(growable: false);
  }

  Future<Map<String, dynamic>> _call(Map<String, dynamic> body) async {
    final firebase_auth.User? user = _auth.currentUser;
    if (user == null) {
      throw const PaymentMonitorApiException('سجّل الدخول أولًا.');
    }
    final String? token = await user.getIdToken();
    if (token == null || token.isEmpty) {
      throw const PaymentMonitorApiException('انتهت جلسة الدخول.');
    }

    final http.Response response = await _client.post(
      Uri.parse(AppConfig.instance.paymentMonitorFunctionUrl),
      headers: <String, String>{
        'Authorization': 'Bearer $token',
        'apikey': AppConfig.instance.supabasePublishableKey,
        'Content-Type': 'application/json',
      },
      body: jsonEncode(body),
    );
    Map<String, dynamic> decoded = <String, dynamic>{};
    if (response.body.isNotEmpty) {
      try {
        decoded = jsonDecode(response.body) as Map<String, dynamic>;
      } on Object {
        decoded = <String, dynamic>{};
      }
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw PaymentMonitorApiException(
        decoded['message'] as String? ?? 'تعذر الاتصال بخدمة مراقبة الدفع.',
        statusCode: response.statusCode,
      );
    }
    return decoded;
  }
}
