import 'package:equatable/equatable.dart';

/// The small, non-sensitive subset of a VF-Cash notification that is needed
/// for server-side matching. The original SMS body is intentionally not kept
/// in this object or uploaded by the monitor app.
class PaymentSmsEvent extends Equatable {
  const PaymentSmsEvent({
    required this.id,
    required this.sender,
    required this.receivedAt,
    this.amount,
    this.senderPhone,
    this.senderName,
    this.walletNumber,
    this.reference,
    this.transactionAt,
  });

  final String id;
  final String sender;
  final DateTime receivedAt;
  final double? amount;
  final String? senderPhone;
  final String? senderName;
  final String? walletNumber;
  final String? reference;
  final DateTime? transactionAt;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'sender': sender,
        'receivedAt': receivedAt.toUtc().toIso8601String(),
        'amount': amount,
        'senderPhone': senderPhone,
        'senderName': senderName,
        'walletNumber': walletNumber,
        'reference': reference,
        'transactionAt': transactionAt?.toUtc().toIso8601String(),
      };

  factory PaymentSmsEvent.fromJson(Map<String, dynamic> json) =>
      PaymentSmsEvent(
        id: json['id'] as String? ?? '',
        sender: json['sender'] as String? ?? '',
        receivedAt: DateTime.tryParse(json['receivedAt'] as String? ?? '') ??
            DateTime.fromMillisecondsSinceEpoch(0),
        amount: (json['amount'] as num?)?.toDouble(),
        senderPhone: json['senderPhone'] as String?,
        senderName: json['senderName'] as String?,
        walletNumber: json['walletNumber'] as String?,
        reference: json['reference'] as String?,
        transactionAt: DateTime.tryParse(
          json['transactionAt'] as String? ?? '',
        ),
      );

  @override
  List<Object?> get props => <Object?>[
        id,
        sender,
        receivedAt,
        amount,
        senderPhone,
        senderName,
        walletNumber,
        reference,
        transactionAt,
      ];
}

/// Parses the known Vodafone Cash receipt formats without depending on a
/// specific language for the sender's name or on optional links in the SMS.
abstract final class PaymentSmsParser {
  static final RegExp _amountPattern = RegExp(
    r'(?:مبلغ|بمبلغ)\s*([0-9٠-٩]+(?:[.,][0-9٠-٩]+)?)\s*(?:جنيه|ج\.م)?',
  );
  static final RegExp _senderPhonePattern = RegExp(
    r'(?:من(?:\s+رقم)?|from)\s*[:：-]?\s*(?:\+?20)?(01[0-9٠-٩]{9})',
    caseSensitive: false,
  );
  static final RegExp _walletPattern = RegExp(
    r'على\s+رقم\s+(?:محفظتك\s*)?(?:\+?20)?(01[0-9٠-٩]{9})',
  );
  static final RegExp _namePattern = RegExp(
    r'المسجل\s+ب[إا]?سم\s+(.+?)(?=\s+على\s+رقم|\s+بتاريخ|\s+تاريخ|\n|$)',
  );
  static final RegExp _referencePattern = RegExp(
    r'(?:رقم\s+العملية|رقم\s+العمليه)\s*[:：-]?\s*([0-9٠-٩]{8,})',
  );
  static final RegExp _datePattern = RegExp(
    r'(?:بتاريخ\s+العملية|تاريخ\s+العملية|تاريخ\s+العمليه|بتاريخ)'
    r'\s*[:：-]?\s*([0-9٠-٩]{1,2}):([0-9٠-٩]{2})\s+'
    r'([0-9٠-٩]{1,2})[-/]([0-9٠-٩]{1,2})[-/]([0-9٠-٩]{2,4})',
  );

  static PaymentSmsEvent? parse({
    required String id,
    required String sender,
    required String body,
    required DateTime receivedAt,
  }) {
    if (!isAllowedSender(sender) || !_looksLikeReceipt(body)) return null;

    final String normalizedBody = _normalizeDigits(body);
    final RegExpMatch? amountMatch = _amountPattern.firstMatch(normalizedBody);
    final RegExpMatch? senderMatch =
        _senderPhonePattern.firstMatch(normalizedBody);
    final RegExpMatch? walletMatch = _walletPattern.firstMatch(normalizedBody);
    final RegExpMatch? nameMatch = _namePattern.firstMatch(normalizedBody);
    final RegExpMatch? referenceMatch =
        _referencePattern.firstMatch(normalizedBody);

    return PaymentSmsEvent(
      id: id,
      sender: sender,
      receivedAt: receivedAt,
      amount: amountMatch == null
          ? null
          : double.tryParse(amountMatch.group(1)!.replaceAll(',', '.')),
      senderPhone:
          senderMatch == null ? null : normalizePhone(senderMatch.group(1)!),
      senderName: nameMatch?.group(1)?.trim(),
      walletNumber:
          walletMatch == null ? null : normalizePhone(walletMatch.group(1)!),
      reference: referenceMatch == null
          ? null
          : _normalizeDigits(referenceMatch.group(1)!),
      transactionAt: _parseTransactionDate(normalizedBody, receivedAt),
    );
  }

  static bool isAllowedSender(String sender) =>
      sender.trim().toLowerCase().replaceAll(' ', '') == 'vf-cash';

  static String normalizePhone(String value) {
    String normalized = _normalizeDigits(value).replaceAll(RegExp(r'\D'), '');
    if (normalized.startsWith('0020')) normalized = normalized.substring(4);
    if (normalized.startsWith('20') && normalized.length == 12) {
      normalized = normalized.substring(2);
    }
    if (normalized.length == 10 && normalized.startsWith('1')) {
      normalized = '0$normalized';
    }
    return normalized;
  }

  static bool _looksLikeReceipt(String body) {
    final String normalized = body.toLowerCase();
    return normalized.contains('استلام') && normalized.contains('مبلغ');
  }

  static String _normalizeDigits(String value) => value
      .replaceAll('٠', '0')
      .replaceAll('١', '1')
      .replaceAll('٢', '2')
      .replaceAll('٣', '3')
      .replaceAll('٤', '4')
      .replaceAll('٥', '5')
      .replaceAll('٦', '6')
      .replaceAll('٧', '7')
      .replaceAll('٨', '8')
      .replaceAll('٩', '9');

  static DateTime? _parseTransactionDate(String body, DateTime receivedAt) {
    final RegExpMatch? match = _datePattern.firstMatch(body);
    if (match == null) return null;
    final int? hour = int.tryParse(match.group(1)!);
    final int? minute = int.tryParse(match.group(2)!);
    final int? firstDatePart = int.tryParse(match.group(3)!);
    final int? secondDatePart = int.tryParse(match.group(4)!);
    final int? thirdDatePart = int.tryParse(match.group(5)!);
    if (hour == null ||
        minute == null ||
        firstDatePart == null ||
        secondDatePart == null ||
        thirdDatePart == null) {
      return null;
    }

    // Vodafone Cash uses YY-MM-DD in the receipt text, for example
    // `26-10-25` means 25 October 2026. Four-digit dates are accepted in
    // either year-first or day-first form for older/localized messages.
    final int year;
    final int month;
    final int day;
    if (match.group(5)!.length == 4) {
      year = thirdDatePart;
      month = secondDatePart;
      day = firstDatePart;
    } else if (match.group(3)!.length == 4) {
      year = firstDatePart;
      month = secondDatePart;
      day = thirdDatePart;
    } else {
      year = 2000 + firstDatePart;
      month = secondDatePart;
      day = thirdDatePart;
    }

    try {
      final DateTime parsed = DateTime(year, month, day, hour, minute);
      // DateTime normalizes invalid dates instead of throwing. Do not let a
      // malformed SMS date become a false payment match.
      if (parsed.year != year ||
          parsed.month != month ||
          parsed.day != day ||
          parsed.hour != hour ||
          parsed.minute != minute) {
        return null;
      }
      return parsed;
    } on Object {
      return receivedAt;
    }
  }
}
