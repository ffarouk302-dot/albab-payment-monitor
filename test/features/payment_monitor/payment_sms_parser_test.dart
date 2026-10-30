import 'package:flutter_test/flutter_test.dart';

import 'package:albab_payment_monitor/features/payment_monitor/domain/payment_sms.dart';

void main() {
  group('PaymentSmsParser', () {
    test('parses the standard Vodafone Cash Arabic receipt', () {
      final PaymentSmsEvent? event = PaymentSmsParser.parse(
        id: 'sms-1',
        sender: 'VF-Cash',
        receivedAt: DateTime(2026, 10, 26, 5, 29),
        body:
            '''تم استلام مبلغ 11 جنيه من رقم 01011898120 المسجل بإسم Ahmed A ALWRAQY على رقم محفظتك 01017001654.
رصيدك الحالي: 22.96 جنيه
تاريخ العملية: 05:29 26-10-24
رقم العملية: 025038367230
تابع كل مصروفاتك من تاريخ المعاملات على أنا فودافون''',
      );

      expect(event, isNotNull);
      expect(event!.amount, 11);
      expect(event.senderPhone, '01011898120');
      expect(event.senderName, 'Ahmed A ALWRAQY');
      expect(event.walletNumber, '01017001654');
      expect(event.reference, '025038367230');
      expect(event.transactionAt, DateTime(2026, 10, 24, 5, 29));
    });

    test('reads Vodafone YY-MM-DD dates as the current century date', () {
      final PaymentSmsEvent? event = PaymentSmsParser.parse(
        id: 'sms-date',
        sender: 'VF-Cash',
        receivedAt: DateTime(2026, 10, 25, 0, 39),
        body:
            'تم استلام مبلغ 5 جنيه من رقم 01012600838 المسجل بإسم Moustafa A على رقم محفظتك 01017001654. تاريخ العملية: 00:39 26-10-25 رقم العملية: 025064018667',
      );

      expect(event, isNotNull);
      expect(event!.transactionAt, DateTime(2026, 10, 25, 0, 39));
    });

    test('parses decimal amounts and Arabic digits', () {
      final PaymentSmsEvent? event = PaymentSmsParser.parse(
        id: 'sms-2',
        sender: 'VF-Cash',
        receivedAt: DateTime(2026, 10, 26, 4, 42),
        body:
            'تم استلام مبلغ ٥٫٠٠ جنيه من ٠١٠١٧٠٠١٦٥٤ المسجل بإسم محمود ابراهيم على رقم محفظتك ٠١٠١٧٠٠١٦٥٤. رقم العملية: ٠٢٥٠٣٨١٢٠٣٤٩',
      );

      expect(event, isNotNull);
      expect(event!.amount, 5);
      expect(event.senderPhone, '01017001654');
      expect(event.senderName, 'محمود ابراهيم');
      expect(event.walletNumber, '01017001654');
      expect(event.reference, '025038120349');
    });

    test('keeps incomplete receipts for server review', () {
      final PaymentSmsEvent? event = PaymentSmsParser.parse(
        id: 'sms-3',
        sender: 'VF-Cash',
        receivedAt: DateTime(2026, 10, 26, 5, 17),
        body:
            'تم استلام مبلغ 5 جنيه من رقم 01012665778 المسجل بإسم Nayera A MTWLY على رقم محفظتك 01017001654.',
      );

      expect(event, isNotNull);
      expect(event!.amount, 5);
      expect(event.reference, isNull);
    });

    test('ignores other senders and non-receipt messages', () {
      expect(
        PaymentSmsParser.parse(
          id: 'sms-4',
          sender: 'CashMisr',
          receivedAt: DateTime.now(),
          body: 'تم استلام مبلغ 10 جنيه',
        ),
        isNull,
      );
      expect(
        PaymentSmsParser.parse(
          id: 'sms-5',
          sender: 'VF-Cash',
          receivedAt: DateTime.now(),
          body: 'تم تحويل مبلغ 10 جنيه',
        ),
        isNull,
      );
    });
  });
}
