/**
 * Provider registry + runtime selection.
 *
 * Selection is `settings:paymentProvider` (plugin KV), defaulting to
 * `"stripe"` so existing installs are unchanged.
 */

import { stripePaymentProvider } from "./stripe-provider";
import type { PaymentProvider } from "./types";

const registry = new Map<string, PaymentProvider>();
registry.set("stripe", stripePaymentProvider);

export const DEFAULT_PAYMENT_PROVIDER_ID = "stripe";

export interface RegisterProviderOptions {
	/** Replace an existing provider with the same id. Off by default. */
	override?: boolean;
}

/**
 * Sibling packages (e.g. a Paystack adapter) register at import time.
 * Duplicate ids throw unless `{ override: true }` is passed — silent
 * overwrite of `stripe` is a payment-path footgun.
 */
export function registerPaymentProvider(
	provider: PaymentProvider,
	options: RegisterProviderOptions = {},
): void {
	if (!provider?.id || provider.id.trim() === "") {
		throw new Error("Cannot register a payment provider with an empty ID");
	}
	if (registry.has(provider.id) && !options.override) {
		throw new Error(
			`Payment provider "${provider.id}" is already registered. Pass { override: true } to replace it.`,
		);
	}
	registry.set(provider.id, provider);
}

export function getPaymentProvider(id: string): PaymentProvider | undefined {
	return registry.get(id);
}

/** Resolve a provider by id. Throws if it was never registered — never silently fall back to Stripe. */
export function requirePaymentProvider(id: string): PaymentProvider {
	const provider = registry.get(id);
	if (!provider) {
		throw new Error(
			`Payment provider "${id}" is not registered. ` +
				`Registered: ${Array.from(registry.keys()).join(", ") || "(none)"}.`,
		);
	}
	return provider;
}

export function listPaymentProviders(): PaymentProvider[] {
	return Array.from(registry.values());
}

/** Test helper: restore the built-in Stripe-only registry. */
export function resetPaymentProviders(): void {
	registry.clear();
	registry.set("stripe", stripePaymentProvider);
}

interface KVLike {
	get<T>(key: string): Promise<T | null>;
}

export async function resolveProvider(kv: KVLike): Promise<PaymentProvider> {
	const configured =
		(await kv.get<string>("settings:paymentProvider")) ?? DEFAULT_PAYMENT_PROVIDER_ID;
	return requirePaymentProvider(configured);
}

function specificSignatureHeader(headers: Headers, providerId: string): string | null {
	if (providerId === "stripe") return headers.get("stripe-signature");
	return headers.get(`x-${providerId}-signature`);
}

/**
 * Pick the webhook adapter from the request, not only from the current
 * `settings:paymentProvider`. In-flight Stripe Checkout / PaymentIntent /
 * subscription / Connect events must still verify after a merchant switches
 * the active provider.
 *
 * Precedence: `?provider=` → unambiguous signature header (`stripe-signature`,
 * `x-<id>-signature`) → configured setting.
 */
export async function resolveWebhookProvider(
	kv: KVLike,
	headers: Headers,
	requestUrl?: string,
): Promise<{ provider: PaymentProvider; signatureHeader: string | null }> {
	if (requestUrl) {
		try {
			const fromQuery = new URL(requestUrl).searchParams.get("provider");
			if (fromQuery) {
				const provider = requirePaymentProvider(fromQuery);
				return {
					provider,
					signatureHeader: specificSignatureHeader(headers, provider.id),
				};
			}
		} catch {
			// ignore invalid URLs; fall through
		}
	}

	const stripeSig = headers.get("stripe-signature");
	if (stripeSig) {
		return { provider: requirePaymentProvider("stripe"), signatureHeader: stripeSig };
	}

	for (const provider of registry.values()) {
		if (provider.id === "stripe") continue;
		const header = headers.get(`x-${provider.id}-signature`);
		if (header) {
			return { provider, signatureHeader: header };
		}
	}

	const provider = await resolveProvider(kv);
	return {
		provider,
		signatureHeader:
			specificSignatureHeader(headers, provider.id) ??
			headers.get("x-webhook-signature") ??
			headers.get("signature"),
	};
}
