/**
 * Re-quote the cart's selected shipping method against live zone/method
 * config. `recalculate` trusts `shippingMethod.amount` as stored; after
 * cart or rate-table changes that amount can be stale. Call at checkout
 * (and any time rates may have drifted) before finalizing totals.
 */

import type { PluginContext } from "emdash";
import type { CartState, ShippingMethod, ShippingZone } from "../types";
import { calculateRates, pickZone } from "./calculate";

/**
 * Pure helper: re-quote given methods already loaded (for unit tests).
 */
export function requoteShippingMethod(
	cart: CartState,
	methods: ShippingMethod[],
): CartState {
	if (!cart.shippingMethod) return cart;
	const options = calculateRates({
		items: cart.items,
		currency: cart.currency,
		methods,
		couponsGiveFreeShipping: cart.coupons.some((c) => c.freeShipping),
	});
	const chosen = options.find((o) => o.methodId === cart.shippingMethod!.id);
	if (!chosen) {
		return { ...cart, shippingMethod: undefined };
	}
	return {
		...cart,
		shippingMethod: {
			id: chosen.methodId,
			label: chosen.label,
			amount: chosen.amount,
		},
	};
}

/**
 * Load zones/methods from storage and re-quote the selected method.
 * Clears `shippingMethod` when the address no longer matches a zone or
 * the method is no longer offered.
 */
export async function requoteShipping(
	ctx: PluginContext,
	cart: CartState,
): Promise<CartState> {
	if (!cart.shippingMethod) return cart;
	if (!cart.shippingAddress) {
		return { ...cart, shippingMethod: undefined };
	}

	const zonesStore = (
		ctx.storage as unknown as {
			shipping_zones: {
				query(opts: { limit: number }): Promise<{
					items: Array<{ id: string; data: ShippingZone }>;
				}>;
			};
		}
	).shipping_zones;
	const methodsStore = (
		ctx.storage as unknown as {
			shipping_methods: {
				query(opts: { limit: number }): Promise<{
					items: Array<{ id: string; data: ShippingMethod }>;
				}>;
			};
		}
	).shipping_methods;

	const zones = (await zonesStore.query({ limit: 200 })).items.map((r) => ({
		...r.data,
		id: r.id,
	}));
	const zone = pickZone(cart.shippingAddress, zones);
	if (!zone) {
		return { ...cart, shippingMethod: undefined };
	}

	const methods = (await methodsStore.query({ limit: 200 })).items
		.map((r) => ({ ...r.data, id: r.id }))
		.filter(
			(m) =>
				m.zoneId === zone.id &&
				(m.enabled === true || (m.enabled as unknown) === 1),
		);

	return requoteShippingMethod(cart, methods);
}
