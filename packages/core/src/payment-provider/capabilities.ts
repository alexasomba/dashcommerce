/**
 * Hosted-checkout feature flags a PaymentProvider must opt into.
 *
 * Missing/false means `checkout/create-session` must 409 rather than
 * silently dropping coupons, Connect splits, or subscriptions.
 */

import type { PaymentProvider } from "./types";

export interface RequestedHostedCheckoutFeatures {
	coupons?: boolean;
	connect?: boolean;
	subscriptions?: boolean;
}

export function unsupportedHostedCheckoutFeatures(
	provider: PaymentProvider,
	requested: RequestedHostedCheckoutFeatures,
): string[] {
	const caps = provider.capabilities;
	const missing: string[] = [];
	if (requested.coupons && !caps?.coupons) missing.push("coupons");
	if (requested.connect && !caps?.connect) missing.push("connect");
	if (requested.subscriptions && !caps?.subscriptions) missing.push("subscriptions");
	return missing;
}
