/**
 * Variant ownership checks.
 *
 * Cart and checkout must ensure a client-supplied `variantId` belongs to
 * the line's product and is active. Without this, a caller can attach a
 * cheaper variant from a different product and get priced at that amount.
 */

import type { ProductVariant } from "../types";

/**
 * True when `variant` belongs to `productId` and is currently sellable.
 */
export function isVariantOfProduct(
	variant: ProductVariant | null | undefined,
	productId: string,
): boolean {
	if (!variant) return false;
	if (!productId) return false;
	return variant.productId === productId && variant.isActive === true;
}
