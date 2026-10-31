import 'dart:async';

import 'package:bloc/bloc.dart';
import 'package:equatable/equatable.dart';
import 'package:firebase_auth/firebase_auth.dart' as firebase_auth;
import 'package:uuid/uuid.dart';

import '../../../core/config/app_config.dart';
import '../../../core/storage/local_storage.dart';
import '../data/payment_monitor_api.dart';
import '../data/sms_monitor_platform.dart';
import '../domain/payment_sms.dart';

enum PaymentMonitorAuthStatus {
  checking,
  signedOut,
  signingIn,
  awaitingApproval,
  signedIn,
}

class PaymentMonitorHistoryItem extends Equatable {
  const PaymentMonitorHistoryItem({
    required this.event,
    required this.decision,
    required this.message,
    required this.processedAt,
    this.orderId,
  });

  final PaymentSmsEvent event;
  final PaymentMonitorDecision decision;
  final String message;
  final DateTime processedAt;
  final String? orderId;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'event': event.toJson(),
        'decision': decision.name,
        'message': message,
        'processedAt': processedAt.toUtc().toIso8601String(),
        'orderId': orderId,
      };

  factory PaymentMonitorHistoryItem.fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic> eventJson =
        (json['event'] as Map<dynamic, dynamic>?)?.map(
              (dynamic key, dynamic value) => MapEntry(key.toString(), value),
            ) ??
            <String, dynamic>{};
    return PaymentMonitorHistoryItem(
      event: PaymentSmsEvent.fromJson(eventJson),
      decision: PaymentMonitorDecision.values.firstWhere(
        (PaymentMonitorDecision value) =>
            value.name == (json['decision'] as String?),
        orElse: () => PaymentMonitorDecision.review,
      ),
      message: json['message'] as String? ?? '',
      processedAt: DateTime.tryParse(json['processedAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
      orderId: json['orderId'] as String?,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        event,
        decision,
        message,
        processedAt,
        orderId,
      ];
}

class PaymentMonitorState extends Equatable {
  const PaymentMonitorState({
    this.authStatus = PaymentMonitorAuthStatus.checking,
    this.permissionGranted = false,
    this.isMonitoring = false,
    this.isProcessing = false,
    this.deviceId,
    this.pendingCount = 0,
    this.history = const <PaymentMonitorHistoryItem>[],
    this.deviceAccess,
    this.approvalMessage,
    this.errorMessage,
  });

  final PaymentMonitorAuthStatus authStatus;
  final bool permissionGranted;
  final bool isMonitoring;
  final bool isProcessing;
  final String? deviceId;
  final int pendingCount;
  final List<PaymentMonitorHistoryItem> history;
  final PaymentMonitorDeviceAccess? deviceAccess;
  final String? approvalMessage;
  final String? errorMessage;

  bool get isSignedIn => authStatus == PaymentMonitorAuthStatus.signedIn;

  List<PaymentMonitorHistoryItem> get _uniqueTransactions {
    final Map<String, PaymentMonitorHistoryItem> byReference =
        <String, PaymentMonitorHistoryItem>{};
    for (final PaymentMonitorHistoryItem item in history) {
      final String reference = item.event.reference?.trim() ?? '';
      final String key =
          reference.isEmpty ? 'id:${item.event.id}' : 'reference:$reference';
      final PaymentMonitorHistoryItem? existing = byReference[key];
      if (existing == null ||
          _decisionPriority(item.decision) >
              _decisionPriority(existing.decision)) {
        byReference[key] = item;
      }
    }
    return byReference.values.toList(growable: false);
  }

  int get successCount => history
      .where((PaymentMonitorHistoryItem item) =>
          item.decision == PaymentMonitorDecision.matched)
      .length;

  int get reviewCount => history
      .where((PaymentMonitorHistoryItem item) =>
          item.decision == PaymentMonitorDecision.review ||
          item.decision == PaymentMonitorDecision.duplicate)
      .length;

  int get refundedCount => history
      .where((PaymentMonitorHistoryItem item) =>
          item.decision == PaymentMonitorDecision.refunded)
      .length;

  int get invalidCount => history
      .where((PaymentMonitorHistoryItem item) =>
          item.decision == PaymentMonitorDecision.ignored)
      .length;

  double get totalAmount => _sumAmount(_uniqueTransactions);

  double get successfulAmount => _sumAmount(
        _uniqueTransactions.where((PaymentMonitorHistoryItem item) =>
            item.decision == PaymentMonitorDecision.matched),
      );

  double get reviewAmount => _sumAmount(
        _uniqueTransactions.where((PaymentMonitorHistoryItem item) =>
            item.decision == PaymentMonitorDecision.review ||
            item.decision == PaymentMonitorDecision.duplicate),
      );

  double get refundedAmount => _sumAmount(
        _uniqueTransactions.where((PaymentMonitorHistoryItem item) =>
            item.decision == PaymentMonitorDecision.refunded),
      );

  double get invalidAmount => _sumAmount(
        _uniqueTransactions.where((PaymentMonitorHistoryItem item) =>
            item.decision == PaymentMonitorDecision.ignored),
      );

  static int _decisionPriority(PaymentMonitorDecision decision) =>
      switch (decision) {
        PaymentMonitorDecision.matched => 4,
        PaymentMonitorDecision.refunded => 3,
        PaymentMonitorDecision.review || PaymentMonitorDecision.duplicate => 2,
        PaymentMonitorDecision.ignored => 1,
      };

  static double _sumAmount(Iterable<PaymentMonitorHistoryItem> items) =>
      items.fold<double>(
        0,
        (double total, PaymentMonitorHistoryItem item) =>
            total + (item.event.amount ?? 0),
      );

  PaymentMonitorState copyWith({
    PaymentMonitorAuthStatus? authStatus,
    bool? permissionGranted,
    bool? isMonitoring,
    bool? isProcessing,
    String? deviceId,
    int? pendingCount,
    List<PaymentMonitorHistoryItem>? history,
    PaymentMonitorDeviceAccess? deviceAccess,
    String? approvalMessage,
    String? errorMessage,
    bool clearError = false,
  }) =>
      PaymentMonitorState(
        authStatus: authStatus ?? this.authStatus,
        permissionGranted: permissionGranted ?? this.permissionGranted,
        isMonitoring: isMonitoring ?? this.isMonitoring,
        isProcessing: isProcessing ?? this.isProcessing,
        deviceId: deviceId ?? this.deviceId,
        pendingCount: pendingCount ?? this.pendingCount,
        history: history ?? this.history,
        deviceAccess: deviceAccess ?? this.deviceAccess,
        approvalMessage: approvalMessage ?? this.approvalMessage,
        errorMessage: clearError ? null : (errorMessage ?? this.errorMessage),
      );

  @override
  List<Object?> get props => <Object?>[
        authStatus,
        permissionGranted,
        isMonitoring,
        isProcessing,
        deviceId,
        pendingCount,
        history,
        deviceAccess,
        approvalMessage,
        errorMessage,
      ];
}

class PaymentMonitorCubit extends Cubit<PaymentMonitorState> {
  PaymentMonitorCubit({
    required LocalStorage storage,
    required SmsMonitorPlatform sms,
    required PaymentMonitorApi api,
    firebase_auth.FirebaseAuth? auth,
  })  : _storage = storage,
        _sms = sms,
        _api = api,
        _auth = auth ?? firebase_auth.FirebaseAuth.instance,
        super(const PaymentMonitorState());

  final LocalStorage _storage;
  final SmsMonitorPlatform _sms;
  final PaymentMonitorApi _api;
  final firebase_auth.FirebaseAuth _auth;
  Timer? _pollTimer;
  Timer? _approvalTimer;
  bool _pollInFlight = false;
  bool _approvalCheckInFlight = false;
  final Set<String> _inFlightIds = <String>{};

  Future<void> restoreSession() async {
    emit(state.copyWith(authStatus: PaymentMonitorAuthStatus.checking));
    if (_auth.currentUser == null) {
      emit(state.copyWith(authStatus: PaymentMonitorAuthStatus.signedOut));
      return;
    }
    try {
      await _activate(clearQueue: false);
    } on Object catch (error) {
      await _deactivateMonitor();
      await _auth.signOut();
      emit(PaymentMonitorState(
        authStatus: PaymentMonitorAuthStatus.signedOut,
        errorMessage: _messageFor(error),
      ));
    }
  }

  Future<void> signIn(String password) async {
    final String trimmed = password.trim();
    if (trimmed.length < 6) {
      emit(state.copyWith(errorMessage: 'اكتب كلمة المرور كاملة.'));
      return;
    }
    emit(state.copyWith(
      authStatus: PaymentMonitorAuthStatus.signingIn,
      clearError: true,
    ));
    try {
      await _auth.signInWithEmailAndPassword(
        email: AppConfig.instance.paymentMonitorAuthEmail,
        password: trimmed,
      );
      await _activate(
        clearQueue: !_storage.getBool(LocalStorage.kPaymentMonitorActivated),
      );
    } on Object catch (error) {
      await _deactivateMonitor();
      await _auth.signOut();
      emit(state.copyWith(
        authStatus: PaymentMonitorAuthStatus.signedOut,
        errorMessage: _messageFor(error),
      ));
    }
  }

  Future<void> signOut() async {
    _stopPolling();
    _stopApprovalPolling();
    await _deactivateMonitor();
    await _auth.signOut();
    emit(const PaymentMonitorState(
      authStatus: PaymentMonitorAuthStatus.signedOut,
    ));
  }

  Future<void> requestSmsPermission() async {
    await _sms.requestReceiveSmsPermission();
    await refreshPermission();
  }

  Future<void> refreshPermission() async {
    final bool granted = await _sms.hasReceiveSmsPermission();
    emit(state.copyWith(permissionGranted: granted));
    if (granted && state.isSignedIn) _startPolling();
  }

  Future<void> processNow() async {
    await _processPending();
    await _refreshRemoteHistory();
  }

  Future<void> refreshDeviceAccess() => _checkApproval();

  Future<void> _activate({required bool clearQueue}) async {
    final String deviceId = await _deviceId();
    final Map<String, String> info = await _sms.deviceInfo();
    final PaymentMonitorDeviceAccessResponse access = await _api.requestDevice(
      deviceId: deviceId,
      walletNumber: AppConfig.instance.merchantWalletNumber,
      deviceName: '${info['manufacturer'] ?? ''} ${info['model'] ?? ''}'.trim(),
      androidVersion: info['androidVersion'] ?? '',
      appVersion: const String.fromEnvironment(
        'APP_VERSION',
        defaultValue: '1.0.8+9',
      ),
    );
    if (!access.isApproved) {
      final List<PaymentMonitorHistoryItem> history = _loadHistory();
      emit(PaymentMonitorState(
        authStatus: PaymentMonitorAuthStatus.awaitingApproval,
        deviceId: deviceId,
        deviceAccess: access.access,
        approvalMessage: access.message,
        history: history,
      ));
      _startApprovalPolling();
      return;
    }
    await _completeActivation(deviceId: deviceId, clearQueue: clearQueue);
  }

  Future<void> _completeActivation({
    required String deviceId,
    required bool clearQueue,
  }) async {
    _stopApprovalPolling();
    await _api.activateDevice(
      deviceId: deviceId,
      walletNumber: AppConfig.instance.merchantWalletNumber,
    );
    if (clearQueue) await _sms.clearPendingMessages();
    await _sms.activate(
      deviceId: deviceId,
      functionUrl: AppConfig.instance.paymentMonitorFunctionUrl,
      walletNumber: AppConfig.instance.merchantWalletNumber,
    );
    if (clearQueue) {
      await _storage.setBool(LocalStorage.kPaymentMonitorActivated,
          value: true);
    }
    List<PaymentMonitorHistoryItem> history = _loadHistory();
    try {
      final List<Map<String, dynamic>> remote = await _api.getHistory(
        deviceId: deviceId,
        walletNumber: AppConfig.instance.merchantWalletNumber,
      );
      history = _mergeHistory(<PaymentMonitorHistoryItem>[
        ...remote.map(PaymentMonitorHistoryItem.fromJson),
        ...history,
      ]);
      await _writeHistory(history);
    } on Object {
      // Older deployments may not expose getHistory yet. Local history remains
      // usable until the function is deployed.
    }
    final bool permissionGranted = await _sms.hasReceiveSmsPermission();
    emit(PaymentMonitorState(
      authStatus: PaymentMonitorAuthStatus.signedIn,
      permissionGranted: permissionGranted,
      isMonitoring: permissionGranted,
      deviceId: deviceId,
      deviceAccess: PaymentMonitorDeviceAccess.approved,
      history: history,
    ));
    if (permissionGranted) {
      _startPolling();
      await _processPending();
    }
  }

  void _startApprovalPolling() {
    _approvalTimer ??= Timer.periodic(
      const Duration(seconds: 5),
      (_) => _checkApproval(),
    );
  }

  void _stopApprovalPolling() {
    _approvalTimer?.cancel();
    _approvalTimer = null;
  }

  Future<void> _checkApproval() async {
    if (_approvalCheckInFlight ||
        state.authStatus != PaymentMonitorAuthStatus.awaitingApproval ||
        state.deviceId == null) {
      return;
    }
    _approvalCheckInFlight = true;
    try {
      final PaymentMonitorDeviceAccessResponse access = await _api.checkDevice(
        deviceId: state.deviceId!,
        walletNumber: AppConfig.instance.merchantWalletNumber,
      );
      if (access.isApproved) {
        await _completeActivation(deviceId: state.deviceId!, clearQueue: false);
        return;
      }
      emit(state.copyWith(
        deviceAccess: access.access,
        approvalMessage: access.message,
      ));
    } on Object catch (error) {
      emit(state.copyWith(errorMessage: _messageFor(error)));
      if (_isAccessError(error)) await _handleAccessRevoked(error);
    } finally {
      _approvalCheckInFlight = false;
    }
  }

  Future<void> _deactivateMonitor() async {
    try {
      await _sms.deactivate();
    } on Object {
      // Signing out must still complete if the native bridge is unavailable.
    }
  }

  void _startPolling() {
    _pollTimer ??= Timer.periodic(
      const Duration(seconds: 5),
      (_) => _processPending(),
    );
  }

  void _stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  Future<void> _processPending() async {
    if (_pollInFlight || !state.isSignedIn || !state.permissionGranted) return;
    _pollInFlight = true;
    try {
      await _processCompletedBackgroundResults();
      final List<PaymentSmsEvent> events = await _sms.pendingMessages();
      emit(state.copyWith(pendingCount: events.length, clearError: true));
      bool changed = false;
      for (final PaymentSmsEvent event in events) {
        if (_inFlightIds.contains(event.id)) continue;
        _inFlightIds.add(event.id);
        try {
          final PaymentMonitorResponse response = await _api.submitEvent(
            event: event,
            deviceId: state.deviceId ?? await _deviceId(),
            walletNumber: AppConfig.instance.merchantWalletNumber,
          );
          final PaymentMonitorHistoryItem item = PaymentMonitorHistoryItem(
            event: event,
            decision: response.decision,
            message: response.message,
            processedAt: DateTime.now(),
            orderId: response.orderId,
          );
          await _saveHistory(item);
          await _sms.acknowledge(<String>[event.id]);
          final List<PaymentMonitorHistoryItem> nextHistory =
              _mergeHistory(<PaymentMonitorHistoryItem>[
            item,
            ...state.history,
          ]);
          emit(state.copyWith(
            history: nextHistory,
            pendingCount: events.length - 1,
          ));
          changed = true;
        } on Object catch (error) {
          emit(state.copyWith(errorMessage: _messageFor(error)));
          if (_isAccessError(error)) {
            await _handleAccessRevoked(error);
            break;
          }
        } finally {
          _inFlightIds.remove(event.id);
        }
      }
      if (changed) await _refreshRemoteHistory();
    } finally {
      _pollInFlight = false;
    }
  }

  Future<void> _processCompletedBackgroundResults() async {
    final List<CompletedPaymentSms> completed = await _sms.completedMessages();
    if (completed.isEmpty) return;

    final List<PaymentMonitorHistoryItem> added = <PaymentMonitorHistoryItem>[];
    for (final CompletedPaymentSms item in completed) {
      final PaymentMonitorDecision decision =
          PaymentMonitorDecision.values.firstWhere(
        (PaymentMonitorDecision value) => value.name == item.decision,
        orElse: () => PaymentMonitorDecision.review,
      );
      final PaymentMonitorHistoryItem historyItem = PaymentMonitorHistoryItem(
        event: item.event,
        decision: decision,
        message: item.message,
        processedAt: item.processedAt,
        orderId: item.orderId,
      );
      await _saveHistory(historyItem);
      added.add(historyItem);
    }
    await _sms.acknowledgeCompleted(
      completed.map((CompletedPaymentSms item) => item.event.id).toList(),
    );

    final List<PaymentMonitorHistoryItem> nextHistory = _mergeHistory(
      <PaymentMonitorHistoryItem>[
        ...added.reversed,
        ...state.history,
      ],
    );
    emit(state.copyWith(
      history: nextHistory,
    ));
  }

  Future<String> _deviceId() async {
    final String? existing =
        _storage.getString(LocalStorage.kPaymentMonitorDeviceId);
    if (existing != null && existing.isNotEmpty) return existing;
    final String created = const Uuid().v4();
    await _storage.setString(LocalStorage.kPaymentMonitorDeviceId, created);
    return created;
  }

  List<PaymentMonitorHistoryItem> _loadHistory() => _mergeHistory(
        _storage
            .readJsonList(LocalStorage.kPaymentMonitorHistory)
            .map(PaymentMonitorHistoryItem.fromJson),
      );

  Future<void> _saveHistory(PaymentMonitorHistoryItem item) async {
    final List<PaymentMonitorHistoryItem> history = _mergeHistory(
      <PaymentMonitorHistoryItem>[item, ..._loadHistory()],
    );
    await _writeHistory(history);
  }

  Future<void> _refreshRemoteHistory() async {
    if (!state.isSignedIn || state.deviceId == null) return;
    try {
      final List<Map<String, dynamic>> remote = await _api.getHistory(
        deviceId: state.deviceId!,
        walletNumber: AppConfig.instance.merchantWalletNumber,
      );
      final List<PaymentMonitorHistoryItem> merged = _mergeHistory(
        <PaymentMonitorHistoryItem>[
          ...remote.map(PaymentMonitorHistoryItem.fromJson),
          ...state.history,
        ],
      );
      await _writeHistory(merged);
      emit(state.copyWith(history: merged));
    } on Object catch (error) {
      // Keep processing local events if the history action is unavailable or
      // temporarily offline.
      if (_isAccessError(error)) await _handleAccessRevoked(error);
    }
  }

  bool _isAccessError(Object error) =>
      error is PaymentMonitorApiException &&
      (error.statusCode == 403 || error.statusCode == 409);

  Future<void> _handleAccessRevoked(Object error) async {
    _stopPolling();
    await _deactivateMonitor();
    emit(PaymentMonitorState(
      authStatus: PaymentMonitorAuthStatus.awaitingApproval,
      deviceId: state.deviceId,
      deviceAccess: PaymentMonitorDeviceAccess.revoked,
      approvalMessage: _messageFor(error),
      history: state.history,
    ));
  }

  Future<void> _writeHistory(
    List<PaymentMonitorHistoryItem> history,
  ) async {
    await _storage.writeJsonList(
      LocalStorage.kPaymentMonitorHistory,
      history.map((PaymentMonitorHistoryItem item) => item.toJson()).toList(),
    );
  }

  List<PaymentMonitorHistoryItem> _mergeHistory(
    Iterable<PaymentMonitorHistoryItem> items,
  ) {
    final Set<String> seenIds = <String>{};
    final List<PaymentMonitorHistoryItem> merged =
        <PaymentMonitorHistoryItem>[];
    for (final PaymentMonitorHistoryItem item in items) {
      if (item.event.id.isEmpty || seenIds.add(item.event.id)) {
        merged.add(item);
      }
    }
    return merged;
  }

  String _messageFor(Object error) {
    if (error is PaymentMonitorApiException) return error.message;
    if (error is firebase_auth.FirebaseAuthException) {
      return switch (error.code) {
        'invalid-credential' ||
        'wrong-password' ||
        'user-not-found' =>
          'كلمة المرور غير صحيحة أو الحساب غير مفعّل.',
        'too-many-requests' => 'محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.',
        'network-request-failed' => 'لا يوجد اتصال بالإنترنت.',
        _ => 'تعذر تسجيل الدخول الآن.',
      };
    }
    return 'تعذر تشغيل مراقبة الدفع. تأكد من الإنترنت ثم حاول مرة أخرى.';
  }

  @override
  Future<void> close() {
    _stopPolling();
    _stopApprovalPolling();
    return super.close();
  }
}
