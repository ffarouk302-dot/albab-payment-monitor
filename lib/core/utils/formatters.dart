import 'package:intl/intl.dart';

import '../config/app_config.dart';

abstract final class Formatters {
  static String currency(double amount) => NumberFormat.currency(
        locale: AppConfig.instance.currencyLocale,
        symbol: '${AppConfig.instance.currencySymbol} ',
        decimalDigits: 2,
      ).format(amount);

  static String dateTime(DateTime value) =>
      DateFormat('d MMM, h:mm a', 'ar').format(value);

  static String relative(DateTime value) {
    final Duration diff = DateTime.now().difference(value);
    if (diff.inMinutes < 1) return 'الآن';
    if (diff.inMinutes < 60) return 'قبل ${diff.inMinutes} دقيقة';
    if (diff.inHours < 24) return 'قبل ${diff.inHours} ساعة';
    if (diff.inDays < 7) return 'قبل ${diff.inDays} يوم';
    return DateFormat('d MMM yyyy', 'ar').format(value);
  }
}
