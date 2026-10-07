/**
 * Shared address mapping for PaymentProvider adapters and webhook fallback.
 */

import type { PaymentProviderAddress } from "./types";

export function splitPersonName(name: string | undefined): {
	firstName: string;
	lastName: string;
} {
	const s = (name ?? "").trim();
	if (!s) return { firstName: "", lastName: "" };
	const idx = s.indexOf(" ");
	if (idx === -1) return { firstName: s, lastName: "" };
	return { firstName: s.slice(0, idx), lastName: s.slice(idx + 1).trim() };
}

export interface ProviderSessionAddress {
	line1?: string | null;
	line2?: string | null;
	city?: string | null;
	state?: string | null;
	postal_code?: string | null;
	country?: string | null;
}

export function addressFromProviderSession(
	name: string | undefined,
	addr: ProviderSessionAddress | undefined,
	phone?: string,
): PaymentProviderAddress | undefined {
	if (!addr || !addr.country) return undefined;
	const { firstName, lastName } = splitPersonName(name);
	return {
		firstName,
		lastName,
		line1: addr.line1 ?? "",
		...(addr.line2 ? { line2: addr.line2 } : {}),
		city: addr.city ?? "",
		region: addr.state ?? "",
		postalCode: addr.postal_code ?? "",
		country: addr.country.toUpperCase(),
		...(phone ? { phone } : {}),
	};
}

/**
 * Digital-only carts often have billing but no shipping (or the reverse).
 * Mirror the hosted webhook route: if exactly one is present, copy it onto
 * the empty slot so order creation's address precondition holds.
 */
export function withBillingShippingFallback(
	billingAddress: PaymentProviderAddress | undefined,
	shippingAddress: PaymentProviderAddress | undefined,
): {
	billingAddress?: PaymentProviderAddress;
	shippingAddress?: PaymentProviderAddress;
} {
	if (billingAddress && shippingAddress) {
		return { billingAddress, shippingAddress };
	}
	if (billingAddress && !shippingAddress) {
		return { billingAddress, shippingAddress: billingAddress };
	}
	if (shippingAddress && !billingAddress) {
		return { billingAddress: shippingAddress, shippingAddress };
	}
	return {};
}
