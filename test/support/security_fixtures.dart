import 'package:albab_payment_monitor/features/payment_monitor/domain/payment_sms.dart';

/// Synthetic monitor fixtures. Never populate these from production records.
abstract final class SecurityFixtures {
  static const String projectId = 'albab-red-team-local';
  static const String approvedUid = 'rt-monitor-approved-001';
  static const String pendingUid = 'rt-monitor-pending-001';
  static const String revokedUid = 'rt-monitor-revoked-001';
  static const String approvedDeviceId = 'rt-monitor-device-001';
  static const String pendingDeviceId = 'rt-monitor-device-pending-001';
  static const String revokedDeviceId = 'rt-monitor-device-revoked-001';
  static const String syntheticReference = 'rt-reference-0001';
  static const String syntheticPhone = '01000000001';
  static const String syntheticWallet = '01000000002';

  static PaymentSmsEvent smsEvent({
    String id = 'rt-sms-event-001',
    String reference = syntheticReference,
    double amount = 8,
  }) => PaymentSmsEvent(
        id: id,
        sender: 'VF-Cash',
        receivedAt: DateTime.utc(2026, 1, 1, 10),
        amount: amount,
        senderPhone: syntheticPhone,
        senderName: 'Synthetic Payer',
        walletNumber: syntheticWallet,
        reference: reference,
        transactionAt: DateTime.utc(2026, 1, 1, 9, 59),
      );

  static const Map<String, Object?> approvedDevice = <String, Object?>{
    'uid': approvedUid,
    'deviceId': approvedDeviceId,
    'status': 'approved',
    'enabled': true,
  };

  static const Map<String, Object?> pendingDevice = <String, Object?>{
    'uid': pendingUid,
    'deviceId': pendingDeviceId,
    'status': 'pending',
    'enabled': false,
  };

  static const Map<String, Object?> revokedDevice = <String, Object?>{
    'uid': revokedUid,
    'deviceId': revokedDeviceId,
    'status': 'revoked',
    'enabled': false,
  };

  static const Map<String, Object?> pendingQueueEntry = <String, Object?>{
    'eventId': 'rt-sms-event-queued-001',
    'rawMessage': 'SYNTHETIC ONLY: no real payment receipt',
    'expiresAt': '2026-01-01T10:10:00.000Z',
    'deviceId': approvedDeviceId,
    'terminal': false,
  };
}
