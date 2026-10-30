import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/config/app_config.dart';
import '../../../core/storage/local_storage.dart';
import '../../../core/utils/formatters.dart';
import '../bloc/payment_monitor_cubit.dart';
import '../data/payment_monitor_api.dart';
import '../data/sms_monitor_platform.dart';

class PaymentMonitorApp extends StatelessWidget {
  const PaymentMonitorApp({required this.storage, super.key});

  final LocalStorage storage;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<PaymentMonitorCubit>(
      create: (_) => PaymentMonitorCubit(
        storage: storage,
        sms: SmsMonitorPlatform(),
        api: PaymentMonitorApi(),
      )..restoreSession(),
      child: MaterialApp(
        title: AppConfig.instance.appName,
        debugShowCheckedModeBanner: false,
        locale: const Locale('ar', 'EG'),
        theme: _monitorTheme,
        home: const PaymentMonitorGate(),
      ),
    );
  }

  static ThemeData get _monitorTheme {
    const Color navy = Color(0xFF102A43);
    const Color teal = Color(0xFF0F766E);
    return ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(
        seedColor: teal,
        brightness: Brightness.light,
        primary: teal,
        onPrimary: Colors.white,
        surface: const Color(0xFFF7FAFC),
      ),
      scaffoldBackgroundColor: const Color(0xFFF7FAFC),
      fontFamily: 'sans',
      appBarTheme: const AppBarTheme(
        backgroundColor: Color(0xFFF7FAFC),
        foregroundColor: navy,
        elevation: 0,
        centerTitle: false,
      ),
      inputDecorationTheme: const InputDecorationTheme(
        filled: true,
        fillColor: Colors.white,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.all(Radius.circular(16)),
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.all(Radius.circular(16)),
          borderSide: BorderSide(color: Color(0xFFE2E8F0)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.all(Radius.circular(16)),
          borderSide: BorderSide(color: teal, width: 1.5),
        ),
      ),
    );
  }
}

class PaymentMonitorGate extends StatelessWidget {
  const PaymentMonitorGate({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<PaymentMonitorCubit, PaymentMonitorState>(
      builder: (BuildContext context, PaymentMonitorState state) {
        return switch (state.authStatus) {
          PaymentMonitorAuthStatus.checking => const _MonitorSplash(),
          PaymentMonitorAuthStatus.signedOut ||
          PaymentMonitorAuthStatus.signingIn =>
            _MonitorLogin(
              isLoading: state.authStatus == PaymentMonitorAuthStatus.signingIn,
              errorMessage: state.errorMessage,
            ),
          PaymentMonitorAuthStatus.awaitingApproval =>
            _MonitorApprovalPending(state: state),
          PaymentMonitorAuthStatus.signedIn => const _MonitorDashboard(),
        };
      },
    );
  }
}

class _MonitorSplash extends StatelessWidget {
  const _MonitorSplash();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            _MonitorLogo(size: 82),
            SizedBox(height: 20),
            CircularProgressIndicator(),
            SizedBox(height: 16),
            Text('جارٍ تجهيز مراقبة الدفع...'),
          ],
        ),
      ),
    );
  }
}

class _MonitorApprovalPending extends StatelessWidget {
  const _MonitorApprovalPending({required this.state});

  final PaymentMonitorState state;

  @override
  Widget build(BuildContext context) {
    final PaymentMonitorCubit cubit = context.read<PaymentMonitorCubit>();
    final bool rejected =
        state.deviceAccess == PaymentMonitorDeviceAccess.rejected;
    final bool revoked =
        state.deviceAccess == PaymentMonitorDeviceAccess.revoked;
    final Color color =
        rejected || revoked ? const Color(0xFFB42318) : const Color(0xFF0F766E);
    final String title = rejected
        ? 'تم رفض الجهاز'
        : revoked
            ? 'تم إلغاء ربط الجهاز'
            : 'الجهاز في انتظار موافقة الأدمن';
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  const _MonitorLogo(size: 92),
                  const SizedBox(height: 24),
                  Icon(
                    rejected || revoked
                        ? Icons.gpp_bad_outlined
                        : Icons.hourglass_top_rounded,
                    size: 54,
                    color: color,
                  ),
                  const SizedBox(height: 14),
                  Text(
                    title,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                          fontWeight: FontWeight.w800,
                          color: const Color(0xFF102A43),
                        ),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    state.approvalMessage ??
                        'تم إرسال طلب ربط الجهاز إلى حساب الأدمن.',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodyLarge,
                  ),
                  const SizedBox(height: 22),
                  FilledButton.icon(
                    onPressed: cubit.refreshDeviceAccess,
                    icon: const Icon(Icons.refresh_rounded),
                    label: const Text('تحديث حالة الموافقة'),
                  ),
                  const SizedBox(height: 8),
                  TextButton.icon(
                    onPressed: cubit.signOut,
                    icon: const Icon(Icons.logout_rounded),
                    label: const Text('تسجيل الخروج'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _MonitorLogin extends StatefulWidget {
  const _MonitorLogin({required this.isLoading, this.errorMessage});

  final bool isLoading;
  final String? errorMessage;

  @override
  State<_MonitorLogin> createState() => _MonitorLoginState();
}

class _MonitorLoginState extends State<_MonitorLogin> {
  final TextEditingController _password = TextEditingController();
  final FocusNode _focus = FocusNode();
  bool _obscure = true;

  @override
  void dispose() {
    _password.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _submit() {
    if (widget.isLoading) return;
    context.read<PaymentMonitorCubit>().signIn(_password.text);
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  const _MonitorLogo(size: 92),
                  const SizedBox(height: 24),
                  Text(
                    'مراقب الدفع',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.headlineMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                      color: const Color(0xFF102A43),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'تطبيق خاص بمتابعة تحويلات محفظة Vodafone Cash',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: const Color(0xFF627D98),
                    ),
                  ),
                  const SizedBox(height: 34),
                  TextField(
                    controller: _password,
                    focusNode: _focus,
                    obscureText: _obscure,
                    textInputAction: TextInputAction.done,
                    onSubmitted: (_) => _submit(),
                    decoration: InputDecoration(
                      labelText: 'كلمة مرور المراقبة',
                      hintText: 'اكتب كلمة المرور',
                      prefixIcon: const Icon(Icons.lock_outline),
                      suffixIcon: IconButton(
                        tooltip: _obscure ? 'إظهار' : 'إخفاء',
                        onPressed: () => setState(() => _obscure = !_obscure),
                        icon: Icon(
                          _obscure
                              ? Icons.visibility_outlined
                              : Icons.visibility_off_outlined,
                        ),
                      ),
                    ),
                  ),
                  if (widget.errorMessage != null) ...<Widget>[
                    const SizedBox(height: 12),
                    _Notice(
                      icon: Icons.error_outline,
                      color: const Color(0xFFB42318),
                      background: const Color(0xFFFFF1F0),
                      text: widget.errorMessage!,
                    ),
                  ],
                  const SizedBox(height: 20),
                  FilledButton.icon(
                    onPressed: widget.isLoading ? null : _submit,
                    icon: widget.isLoading
                        ? const SizedBox(
                            height: 18,
                            width: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.login_rounded),
                    label: Text(widget.isLoading ? 'جارٍ الدخول...' : 'دخول'),
                    style: FilledButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(16),
                      ),
                    ),
                  ),
                  const SizedBox(height: 22),
                  const _SecurityNote(),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

enum _HistoryFilter { all, successful, manual, invalid }

class _MonitorDashboard extends StatefulWidget {
  const _MonitorDashboard();

  @override
  State<_MonitorDashboard> createState() => _MonitorDashboardState();
}

class _MonitorDashboardState extends State<_MonitorDashboard> {
  final TextEditingController _search = TextEditingController();
  _HistoryFilter _filter = _HistoryFilter.all;

  @override
  void initState() {
    super.initState();
    _search.addListener(_onSearchChanged);
  }

  @override
  void dispose() {
    _search
      ..removeListener(_onSearchChanged)
      ..dispose();
    super.dispose();
  }

  void _onSearchChanged() => setState(() {});

  bool _matches(PaymentMonitorHistoryItem item) {
    final String query = _search.text.trim().toLowerCase();
    if (query.isEmpty) return true;
    final String haystack = <String?>[
      item.event.reference,
      item.event.senderPhone,
      item.event.senderName,
      item.event.walletNumber,
      item.event.amount?.toStringAsFixed(2),
      item.orderId,
      item.message,
    ].whereType<String>().join(' ').toLowerCase();
    return haystack.contains(query);
  }

  List<PaymentMonitorHistoryItem> _items(
    PaymentMonitorState state, {
    _HistoryFilter? filter,
  }) {
    final _HistoryFilter selected = filter ?? _filter;
    return state.history.where((PaymentMonitorHistoryItem item) {
      final bool filterMatches = switch (selected) {
        _HistoryFilter.all => true,
        _HistoryFilter.successful =>
          item.decision == PaymentMonitorDecision.matched,
        _HistoryFilter.manual =>
          item.decision == PaymentMonitorDecision.review ||
              item.decision == PaymentMonitorDecision.duplicate,
        _HistoryFilter.invalid =>
          item.decision == PaymentMonitorDecision.ignored,
      };
      return filterMatches && _matches(item);
    }).toList(growable: false);
  }

  Widget _filterChip(String label, _HistoryFilter filter) {
    return Padding(
      padding: const EdgeInsetsDirectional.only(end: 8),
      child: FilterChip(
        selected: _filter == filter,
        label: Text(label),
        onSelected: (_) => setState(() => _filter = filter),
      ),
    );
  }

  Widget _section({
    required String title,
    required String amount,
    required List<PaymentMonitorHistoryItem> items,
    required Color color,
  }) {
    if (items.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Row(
          children: <Widget>[
            Expanded(
              child: Text(
                title,
                style: const TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w800,
                  color: Color(0xFF102A43),
                ),
              ),
            ),
            Text(
              '$amount • ${items.length}',
              style: TextStyle(color: color, fontWeight: FontWeight.w700),
            ),
          ],
        ),
        const SizedBox(height: 10),
        ...items
            .map((PaymentMonitorHistoryItem item) => _HistoryTile(item: item)),
        const SizedBox(height: 10),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<PaymentMonitorCubit, PaymentMonitorState>(
      builder: (BuildContext context, PaymentMonitorState state) {
        final PaymentMonitorCubit cubit = context.read<PaymentMonitorCubit>();
        final List<PaymentMonitorHistoryItem> filteredItems = _items(state);
        return Scaffold(
          appBar: AppBar(
            title: const Text(
              'مراقبة الدفع',
              style: TextStyle(fontWeight: FontWeight.w800),
            ),
            actions: <Widget>[
              IconButton(
                tooltip: 'تحديث الآن',
                onPressed: cubit.processNow,
                icon: const Icon(Icons.refresh_rounded),
              ),
              IconButton(
                tooltip: 'تسجيل الخروج',
                onPressed: cubit.signOut,
                icon: const Icon(Icons.logout_rounded),
              ),
            ],
          ),
          body: RefreshIndicator(
            onRefresh: cubit.processNow,
            child: ListView(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
              children: <Widget>[
                _StatusHero(state: state),
                const SizedBox(height: 14),
                if (!state.permissionGranted)
                  _PermissionCard(onRequest: cubit.requestSmsPermission),
                if (state.errorMessage != null) ...<Widget>[
                  const SizedBox(height: 12),
                  _Notice(
                    icon: Icons.cloud_off_outlined,
                    color: const Color(0xFF9C2C77),
                    background: const Color(0xFFFFF0F8),
                    text: state.errorMessage!,
                  ),
                ],
                const SizedBox(height: 18),
                GridView.count(
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  crossAxisCount: 2,
                  crossAxisSpacing: 12,
                  mainAxisSpacing: 12,
                  childAspectRatio: 1.45,
                  children: <Widget>[
                    _MetricCard(
                      label: 'إجمالي المبالغ (${state.history.length})',
                      value: Formatters.currency(state.totalAmount),
                      icon: Icons.account_balance_wallet_outlined,
                      color: const Color(0xFF102A43),
                    ),
                    _MetricCard(
                      label: 'ناجحة (${state.successCount})',
                      value: Formatters.currency(state.successfulAmount),
                      icon: Icons.verified_rounded,
                      color: const Color(0xFF087443),
                    ),
                    _MetricCard(
                      label: 'مراجعة يدوية (${state.reviewCount})',
                      value: Formatters.currency(state.reviewAmount),
                      icon: Icons.fact_check_outlined,
                      color: const Color(0xFFB54708),
                    ),
                    _MetricCard(
                      label: 'غير صالحة (${state.invalidCount})',
                      value: Formatters.currency(state.invalidAmount),
                      icon: Icons.block_outlined,
                      color: const Color(0xFF627D98),
                    ),
                  ],
                ),
                const SizedBox(height: 18),
                TextField(
                  controller: _search,
                  textInputAction: TextInputAction.search,
                  decoration: const InputDecoration(
                    labelText: 'بحث في كل التحويلات',
                    hintText: 'مرجع، رقم محفظة، اسم، مبلغ أو رقم طلب',
                    prefixIcon: Icon(Icons.search_rounded),
                  ),
                ),
                const SizedBox(height: 8),
                SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: <Widget>[
                      _filterChip('الكل', _HistoryFilter.all),
                      _filterChip('الناجحة', _HistoryFilter.successful),
                      _filterChip('مراجعة يدوية', _HistoryFilter.manual),
                      _filterChip('غير صالحة', _HistoryFilter.invalid),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: <Widget>[
                    Text(
                      _search.text.trim().isEmpty &&
                              _filter == _HistoryFilter.all
                          ? 'التحويلات حسب الحالة'
                          : 'نتائج البحث',
                      style: const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w800,
                        color: Color(0xFF102A43),
                      ),
                    ),
                    if (state.isProcessing)
                      const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                  ],
                ),
                const SizedBox(height: 10),
                if (state.history.isEmpty)
                  const _EmptyHistory()
                else if (filteredItems.isEmpty)
                  const _EmptyHistory()
                else if (_search.text.trim().isNotEmpty ||
                    _filter != _HistoryFilter.all)
                  ...filteredItems.map(
                    (PaymentMonitorHistoryItem item) =>
                        _HistoryTile(item: item),
                  )
                else ...<Widget>[
                  _section(
                    title: 'تحويلات ناجحة',
                    amount: Formatters.currency(state.successfulAmount),
                    items: _items(state, filter: _HistoryFilter.successful),
                    color: const Color(0xFF087443),
                  ),
                  _section(
                    title: 'تحتاج تدخل يدوي',
                    amount: Formatters.currency(state.reviewAmount),
                    items: _items(state, filter: _HistoryFilter.manual),
                    color: const Color(0xFFB54708),
                  ),
                  _section(
                    title: 'رسائل غير صالحة أو مرفوضة',
                    amount: Formatters.currency(state.invalidAmount),
                    items: _items(state, filter: _HistoryFilter.invalid),
                    color: const Color(0xFF627D98),
                  ),
                ],
              ],
            ),
          ),
        );
      },
    );
  }
}

class _StatusHero extends StatelessWidget {
  const _StatusHero({required this.state});

  final PaymentMonitorState state;

  @override
  Widget build(BuildContext context) {
    final bool active = state.permissionGranted && state.isMonitoring;
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: <Color>[Color(0xFF102A43), Color(0xFF0F766E)],
          begin: Alignment.topRight,
          end: Alignment.bottomLeft,
        ),
        borderRadius: BorderRadius.circular(24),
        boxShadow: const <BoxShadow>[
          BoxShadow(
            color: Color(0x2210273E),
            blurRadius: 18,
            offset: Offset(0, 8),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: 0.16),
                  shape: BoxShape.circle,
                ),
                child: const Icon(
                  Icons.account_balance_wallet_rounded,
                  color: Colors.white,
                ),
              ),
              const SizedBox(width: 12),
              const Expanded(
                child: Text(
                  'Vodafone Cash',
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 18,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              _ActiveBadge(active: active),
            ],
          ),
          const SizedBox(height: 20),
          Text(
            'المحفظة المستقبلة',
            style: TextStyle(color: Colors.white.withValues(alpha: 0.72)),
          ),
          const SizedBox(height: 4),
          Text(
            _maskWallet(AppConfig.instance.merchantWalletNumber),
            textDirection: TextDirection.ltr,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 22,
              fontWeight: FontWeight.w800,
              letterSpacing: 1,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            active
                ? 'يتم فحص الرسائل الجديدة من VF-Cash تلقائيًا.'
                : 'اسمح بقراءة رسائل SMS لتشغيل المراقبة.',
            style: TextStyle(color: Colors.white.withValues(alpha: 0.82)),
          ),
        ],
      ),
    );
  }

  static String _maskWallet(String value) {
    if (value.length < 6) return value;
    return '${value.substring(0, 3)} •••• ${value.substring(value.length - 3)}';
  }
}

class _ActiveBadge extends StatelessWidget {
  const _ActiveBadge({required this.active});

  final bool active;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(30),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              color: active ? const Color(0xFF6EE7B7) : const Color(0xFFFDBA74),
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 6),
          Text(
            active ? 'تعمل' : 'متوقفة',
            style: const TextStyle(
              color: Colors.white,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}

class _PermissionCard extends StatelessWidget {
  const _PermissionCard({required this.onRequest});

  final VoidCallback onRequest;

  @override
  Widget build(BuildContext context) {
    return Card(
      elevation: 0,
      color: const Color(0xFFFFF7ED),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            const Row(
              children: <Widget>[
                Icon(Icons.sms_outlined, color: Color(0xFFB54708)),
                SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'السماح بقراءة رسائل التحويل مطلوب',
                    style: TextStyle(fontWeight: FontWeight.w800),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            const Text(
              'لن يقرأ التطبيق إلا الرسائل الجديدة من VF-Cash، ولن يرسل نص الرسالة كاملًا.',
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: onRequest,
              icon: const Icon(Icons.admin_panel_settings_outlined),
              label: const Text('السماح الآن'),
            ),
          ],
        ),
      ),
    );
  }
}

class _MetricCard extends StatelessWidget {
  const _MetricCard({
    required this.label,
    required this.value,
    required this.icon,
    required this.color,
  });

  final String label;
  final String value;
  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Card(
      elevation: 0,
      color: Colors.white,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Icon(icon, color: color),
            const SizedBox(height: 10),
            Text(
              value,
              style: TextStyle(
                color: color,
                fontSize: 25,
                fontWeight: FontWeight.w900,
              ),
            ),
            Text(label, style: const TextStyle(color: Color(0xFF627D98))),
          ],
        ),
      ),
    );
  }
}

class _HistoryTile extends StatelessWidget {
  const _HistoryTile({required this.item});

  final PaymentMonitorHistoryItem item;

  @override
  Widget build(BuildContext context) {
    final DateTime eventTime =
        (item.event.transactionAt ?? item.event.receivedAt).toLocal();
    final String eventTimeLabel =
        item.event.transactionAt == null ? 'وقت استلام الرسالة' : 'وقت التحويل';
    final ({Color color, IconData icon, String label}) style =
        switch (item.decision) {
      PaymentMonitorDecision.matched => (
          color: const Color(0xFF087443),
          icon: Icons.check_circle_rounded,
          label: 'تم الاعتماد',
        ),
      PaymentMonitorDecision.review => (
          color: const Color(0xFFB54708),
          icon: Icons.fact_check_outlined,
          label: 'مراجعة الأدمن',
        ),
      PaymentMonitorDecision.duplicate => (
          color: const Color(0xFF9C2C77),
          icon: Icons.copy_all_outlined,
          label: 'تحويل مكرر',
        ),
      PaymentMonitorDecision.ignored => (
          color: const Color(0xFF627D98),
          icon: Icons.remove_circle_outline,
          label: 'تم تجاهله',
        ),
    };
    return Card(
      elevation: 0,
      color: Colors.white,
      margin: const EdgeInsets.only(bottom: 10),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        leading: Icon(style.icon, color: style.color, size: 30),
        title: Text(
          item.event.amount == null
              ? 'مبلغ غير واضح'
              : '${item.event.amount!.toStringAsFixed(2)} ج.م',
          style: const TextStyle(fontWeight: FontWeight.w800),
        ),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              [
                style.label,
                if (item.event.senderPhone != null) item.event.senderPhone!,
                if (item.event.reference != null)
                  'مرجع ${item.event.reference}',
              ].join(' • '),
            ),
            Text(
              '$eventTimeLabel: ${_safeMonitorDateTime(eventTime)}',
              style: const TextStyle(fontSize: 12, color: Color(0xFF627D98)),
            ),
            if (item.decision != PaymentMonitorDecision.matched &&
                item.message.isNotEmpty)
              Text(
                item.message,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: style.color, fontSize: 12),
              ),
          ],
        ),
        trailing: item.orderId == null
            ? null
            : const Icon(Icons.receipt_long_outlined, size: 20),
      ),
    );
  }
}

String _safeMonitorDateTime(DateTime value) {
  try {
    return Formatters.dateTime(value);
  } on Object {
    final String month = value.month.toString().padLeft(2, '0');
    final String day = value.day.toString().padLeft(2, '0');
    final String hour = value.hour.toString().padLeft(2, '0');
    final String minute = value.minute.toString().padLeft(2, '0');
    return '${value.year}-$month-$day $hour:$minute';
  }
}

class _EmptyHistory extends StatelessWidget {
  const _EmptyHistory();

  @override
  Widget build(BuildContext context) {
    return Card(
      elevation: 0,
      color: Colors.white,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      child: const Padding(
        padding: EdgeInsets.symmetric(vertical: 30, horizontal: 18),
        child: Column(
          children: <Widget>[
            Icon(Icons.mark_email_read_outlined,
                size: 42, color: Color(0xFF9FB3C8)),
            SizedBox(height: 10),
            Text(
              'لا توجد تحويلات معالجة حتى الآن.',
              textAlign: TextAlign.center,
              style: TextStyle(color: Color(0xFF627D98)),
            ),
          ],
        ),
      ),
    );
  }
}

class _SecurityNote extends StatelessWidget {
  const _SecurityNote();

  @override
  Widget build(BuildContext context) {
    return const _Notice(
      icon: Icons.shield_outlined,
      color: Color(0xFF0F766E),
      background: Color(0xFFE6FFFA),
      text:
          'هذا التطبيق لا يطلب PIN المحفظة، ولا يحتوي على صلاحيات لوحة الأدمن.',
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({
    required this.icon,
    required this.color,
    required this.background,
    required this.text,
  });

  final IconData icon;
  final Color color;
  final Color background;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(13),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(icon, color: color, size: 21),
          const SizedBox(width: 9),
          Expanded(child: Text(text, style: TextStyle(color: color))),
        ],
      ),
    );
  }
}

class _MonitorLogo extends StatelessWidget {
  const _MonitorLogo({required this.size});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: const BoxDecoration(
        shape: BoxShape.circle,
        gradient: LinearGradient(
          colors: <Color>[Color(0xFF102A43), Color(0xFF0F766E)],
          begin: Alignment.topRight,
          end: Alignment.bottomLeft,
        ),
      ),
      child: Icon(
        Icons.account_balance_wallet_rounded,
        color: Colors.white,
        size: size * 0.48,
      ),
    );
  }
}
