/// Configuration for the standalone payment-monitor application.
class AppConfig {
  const AppConfig({
    this.appName = 'مراقب الدفع',
    this.currencySymbol = 'ج.م',
    this.currencyLocale = 'ar_EG',
    this.merchantWalletNumber = const String.fromEnvironment(
      'MERCHANT_WALLET_NUMBER',
      defaultValue: '01017001654',
    ),
    this.paymentMonitorAuthEmail = const String.fromEnvironment(
      'PAYMENT_MONITOR_AUTH_EMAIL',
      defaultValue: 'payment-monitor@albab.delivery',
    ),
    this.paymentMonitorFunctionUrl = const String.fromEnvironment(
      'PAYMENT_MONITOR_FUNCTION_URL',
      defaultValue:
          'https://qumqwpnemznwfollrhgy.supabase.co/functions/v1/payment-monitor',
    ),
    this.supabaseUrl = const String.fromEnvironment(
      'SUPABASE_URL',
      defaultValue: 'https://qumqwpnemznwfollrhgy.supabase.co',
    ),
    this.supabasePublishableKey = const String.fromEnvironment(
      'SUPABASE_PUBLISHABLE_KEY',
      defaultValue: 'sb_publishable_sGqVgJKWVSemFbWLCdOHuw_lvl4DDUT',
    ),
  });

  final String appName;
  final String currencySymbol;
  final String currencyLocale;
  final String merchantWalletNumber;
  final String paymentMonitorAuthEmail;
  final String paymentMonitorFunctionUrl;
  final String supabaseUrl;
  final String supabasePublishableKey;

  static const AppConfig instance = AppConfig();
}
