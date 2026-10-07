/**
 * Load PaymentProvider credentials from plugin KV.
 *
 * Stripe keeps the existing key names (`settings:stripeSecretKey` /
 * `settings:stripeWebhookSecret`). Other providers use
 * `settings:<id>SecretKey` and `settings:<id>WebhookSecret`.
 */

import type { PaymentProviderCredentials } from "./types";

export interface KvLike {
	get<T>(key: string): Promise<T | null>;
}

export async function loadPaymentProviderCredentials(
	kv: KvLike,
	providerId: string,
): Promise<PaymentProviderCredentials | null> {
	if (providerId === "stripe") {
		const secretKey = await kv.get<string>("settings:stripeSecretKey");
		if (!secretKey) return null;
		const webhookSecret = (await kv.get<string>("settings:stripeWebhookSecret")) ?? undefined;
		return { secretKey, webhookSecret };
	}
	const secretKey = await kv.get<string>(`settings:${providerId}SecretKey`);
	if (!secretKey) return null;
	const webhookSecret = (await kv.get<string>(`settings:${providerId}WebhookSecret`)) ?? undefined;
	return { secretKey, webhookSecret };
}

export function webhookSignatureHeader(headers: Headers, providerId: string): string | null {
	if (providerId === "stripe") {
		return headers.get("stripe-signature");
	}
	return (
		headers.get(`x-${providerId}-signature`) ??
		headers.get("x-webhook-signature") ??
		headers.get("signature")
	);
}
