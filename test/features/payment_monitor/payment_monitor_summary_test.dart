import 'package:flutter_test/flutter_test.dart';
import 'package:albab_payment_monitor/features/payment_monitor/bloc/payment_monitor_cubit.dart';
import 'package:albab_payment_monitor/features/payment_monitor/data/payment_monitor_api.dart';
import 'package:albab_payment_monitor/features/payment_monitor/domain/payment_sms.dart';

void main() {
  PaymentMonitorHistoryItem item({
    required String id,
    required PaymentMonitorDecision decision,
    required double amount,
    String? reference,
  }) =>
      PaymentMonitorHistoryItem(
        event: PaymentSmsEvent(
          id: id,
          sender: 'VF-Cash',
          receivedAt: DateTime(2026, 10, 25, 5),
          amount: amount,
          reference: reference,
        ),
        decision: decision,
        message: '',
        processedAt: DateTime(2026, 10, 25, 5),
      );

  test('monitor summaries deduplicate references for amounts', () {
    final PaymentMonitorState state = PaymentMonitorState(
      history: <PaymentMonitorHistoryItem>[
        item(
          id: 'matched-event',
          decision: PaymentMonitorDecision.matched,
          amount: 5,
          reference: 'ref-1',
        ),
        item(
          id: 'duplicate-event',
          decision: PaymentMonitorDecision.duplicate,
          amount: 5,
          reference: 'ref-1',
        ),
        item(
          id: 'duplicate-event-retry',
          decision: PaymentMonitorDecision.duplicate,
          amount: 5,
          reference: 'ref-1',
        ),
        item(
          id: 'review-event',
          decision: PaymentMonitorDecision.review,
          amount: 10,
          reference: 'ref-2',
        ),
        item(
          id: 'invalid-event',
          decision: PaymentMonitorDecision.ignored,
          amount: 2,
          reference: 'ref-3',
        ),
      ],
    );

    expect(state.successCount, 1);
    expect(state.reviewCount, 1);
    expect(state.invalidCount, 1);
    expect(state.successfulAmount, 5);
    expect(state.reviewAmount, 10);
    expect(state.invalidAmount, 2);
    expect(state.totalAmount, 17);
  });
}
