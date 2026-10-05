/**
 * Re-validate and re-resolve applied coupons against the live cart.
 *
 * `recalculate` trusts `AppliedCoupon.discountAmount` as written. After line
 * changes (or at checkout) those amounts can be stale — e.g. a percent
 * coupon applied to a larger cart, then items removed, leaving an
 * oversized discount. Call `refreshAppliedCoupons` before recalculating.
 */

import type { PluginContext } from "emdash";
import { computeSubtotal } from "../cart/calculate";
import { zero } from "../money";
import type { AppliedCoupon, CartState, Coupon } from "../types";
import { resolveDiscount, validateCoupon } from "./validate";

type CouponsStore = {
	query(opts: {
		where: Record<string, string>;
		limit: number;
	}): Promise<{ items: Array<{ id: string; data: Coupon }> }>;
};

function couponsStore(ctx: PluginContext): CouponsStore {
	return (ctx.storage as unknown as { coupons: CouponsStore }).coupons;
}

/**
 * Pure helper: re-apply coupon definitions already in hand.
 * Used by unit tests and by the async storage-backed refresher.
 */
export function reapplyCoupons(
	coupons: Coupon[],
	cart: CartState,
	productCategories?: Record<string, string[]>,
): AppliedCoupon[] {
	const subtotal = computeSubtotal(cart.items, cart.currency);
	const refreshed: AppliedCoupon[] = [];
	let working: CartState = {
		...cart,
		subtotal,
		coupons: [],
		discountTotal: zero(cart.currency),
	};

	for (const coupon of coupons) {
		const validation = validateCoupon(coupon, {
			cart: working,
			productCategories,
		});
		if (!validation.ok) continue;
		try {
			const next = resolveDiscount(coupon, working, productCategories);
			refreshed.push(next);
			working = { ...working, coupons: [...working.coupons, next] };
		} catch {
			continue;
		}
	}
	return refreshed;
}

/**
 * Load each applied coupon from storage, re-validate, and re-resolve
 * discount amounts. Invalid / expired / no-longer-applicable coupons
 * are dropped.
 */
export async function refreshAppliedCoupons(
	ctx: PluginContext,
	cart: CartState,
	productCategories?: Record<string, string[]>,
): Promise<CartState> {
	if (cart.coupons.length === 0) return cart;

	const definitions: Coupon[] = [];
	for (const applied of cart.coupons) {
		const result = await couponsStore(ctx).query({
			where: { code: applied.code.toUpperCase() },
			limit: 1,
		});
		const row = result.items[0];
		if (!row) continue;
		definitions.push({ ...row.data, id: row.id });
	}

	return {
		...cart,
		coupons: reapplyCoupons(definitions, cart, productCategories),
	};
}
