/**
 * Compare the provider's reported capture to the cart/order expected
 * total. Amount is integer minor units. Currency is ISO-4217 and is
 * compared case-insensitively when supplied — 5000 KES must not match
 * a 5000 USD cart. Any mismatch holds the order for operator review
 * and withholds digital download grants until resolved.
 */

export interface ReconcileResult {
	ok: boolean;
	expected: number;
	received: number;
	delta: number;
	amountOk: boolean;
	currencyOk: boolean;
	expectedCurrency?: string;
	receivedCurrency?: string;
}

/**
 * Exact-match reconcile in minor units. `amountReceived` defaults to 0
 * when the provider omits the field so a missing value never silently
 * passes. When `expectedCurrency` is passed, a missing or different
 * `receivedCurrency` is a hold (currencyOk=false) even if amounts match.
 */
export function reconcilePaymentAmount(
	expectedMinor: number,
	amountReceived: number | undefined | null,
	expectedCurrency?: string,
	receivedCurrency?: string | null,
): ReconcileResult {
	const received = typeof amountReceived === "number" ? amountReceived : 0;
	const delta = received - expectedMinor;
	const amountOk = delta === 0;
	let currencyOk = true;
	let expectedNorm: string | undefined;
	let receivedNorm: string | undefined;
	if (expectedCurrency !== undefined) {
		expectedNorm = expectedCurrency.trim().toUpperCase();
		receivedNorm = (receivedCurrency ?? "").trim().toUpperCase();
		currencyOk = receivedNorm.length > 0 && expectedNorm === receivedNorm;
	}
	return {
		ok: amountOk && currencyOk,
		expected: expectedMinor,
		received,
		delta,
		amountOk,
		currencyOk,
		...(expectedNorm !== undefined ? { expectedCurrency: expectedNorm } : {}),
		...(receivedNorm !== undefined ? { receivedCurrency: receivedNorm } : {}),
	};
}
