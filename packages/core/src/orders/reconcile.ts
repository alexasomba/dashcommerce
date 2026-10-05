/**
 * Compare Stripe's reported amount_received to the cart/order expected
 * total (minor units). Any mismatch holds the order for operator review
 * and withholds digital download grants until resolved.
 */

export interface ReconcileResult {
	ok: boolean;
	expected: number;
	received: number;
	delta: number;
}

/**
 * Exact-match reconcile in minor units. `amountReceived` defaults to 0
 * when Stripe omits the field so a missing value never silently passes.
 */
export function reconcilePaymentAmount(
	expectedMinor: number,
	amountReceived: number | undefined | null,
): ReconcileResult {
	const received = typeof amountReceived === "number" ? amountReceived : 0;
	const delta = received - expectedMinor;
	return {
		ok: delta === 0,
		expected: expectedMinor,
		received,
		delta,
	};
}
