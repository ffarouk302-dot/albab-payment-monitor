import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// Storage used only by the standalone payment-monitor application.
class LocalStorage {
  LocalStorage(this._prefs);

  final SharedPreferences _prefs;

  static const String kPaymentMonitorDeviceId = 'payment_monitor_device_id';
  static const String kPaymentMonitorActivated =
      'payment_monitor_activated';
  static const String kPaymentMonitorHistory = 'payment_monitor_history';

  static Future<LocalStorage> create() async =>
      LocalStorage(await SharedPreferences.getInstance());

  bool getBool(String key, {bool fallback = false}) =>
      _prefs.getBool(key) ?? fallback;

  Future<void> setBool(String key, {required bool value}) =>
      _prefs.setBool(key, value);

  String? getString(String key) => _prefs.getString(key);

  Future<void> setString(String key, String value) =>
      _prefs.setString(key, value);

  List<Map<String, dynamic>> readJsonList(String key) {
    final String? raw = _prefs.getString(key);
    if (raw == null) return const <Map<String, dynamic>>[];
    final Object? decoded = jsonDecode(raw);
    if (decoded is! List) return const <Map<String, dynamic>>[];
    return decoded
        .whereType<Map<dynamic, dynamic>>()
        .map(
          (Map<dynamic, dynamic> item) => item.map(
            (dynamic key, dynamic value) => MapEntry(key.toString(), value),
          ),
        )
        .toList(growable: false);
  }

  Future<void> writeJsonList(
    String key,
    List<Map<String, dynamic>> value,
  ) =>
      _prefs.setString(key, jsonEncode(value));
}
