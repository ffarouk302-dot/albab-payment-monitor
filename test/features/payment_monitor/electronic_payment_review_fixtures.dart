class PaymentMonitorReviewFixtures {
  static Map<String, dynamic> evidence({
    String id = 'evidence-001',
    String decision = 'review',
    String? operationId,
  }) =>
      <String, dynamic>{
        'evidenceId': id,
        'evidenceDecision': decision,
        'reference': 'REF-001',
        'amountMinor': 10000,
        'linkedOperationId': operationId,
      };
}
