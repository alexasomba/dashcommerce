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
	const provider = registry.get(configured);
	if (!provider) {
		throw new Error(
			`dashcommerce: settings:paymentProvider is "${configured}" but no PaymentProvider with that id is registered. ` +
				`Registered: ${Array.from(registry.keys()).join(", ") || "(none)"}.`,
		);
	}
	return provider;
}
