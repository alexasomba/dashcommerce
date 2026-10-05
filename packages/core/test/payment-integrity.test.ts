/**
 * Payment-integrity unit tests — variant ownership, coupon re-apply,
 * shipping requote, and PI amount reconcile.
 *
 * These cover the high-severity integrity fixes without live Stripe.
 */

import { describe, expect, it } from "bun:test";
import { recalculate } from "../src/cart/calculate";
import { reapplyCoupons } from "../src/coupons/refresh";
import { resolveDiscount, validateCoupon } from "../src/coupons/validate";
import { reconcilePaymentAmount } from "../src/orders/reconcile";
import { isVariantOfProduct } from "../src/products/variant-guard";
import { resolvePrice } from "../src/products/pricing";
import { requoteShippingMethod } from "../src/shipping/requote";
import { money, zero } from "../src/money";
import type {
	CartLineItem,
	CartState,
	Coupon,
	OrderItem,
	ProductFields,
	ProductVariant,
	ShippingMethod,
} from "../src/types";
import {
	orderItemFromStorage,
	orderItemToStorage,
} from "../src/orders/order-item-storage";

function line(
	productId: string,
	qty: number,
	unit: number,
	opts: { variantId?: string; weightGrams?: number } = {},
): CartLineItem {
	return {
		lineId: `l-${productId}-${opts.variantId ?? "base"}`,
		productId,
		...(opts.variantId ? { variantId: opts.variantId } : {}),
		quantity: qty,
		unitPrice: money("USD", unit),
		lineSubtotal: money("USD", unit * qty),
		title: productId,
		isDigital: false,
		...(opts.weightGrams !== undefined ? { weightGrams: opts.weightGrams } : {}),
	};
}

function baseCart(items: CartLineItem[] = []): CartState {
	return {
		sessionId: "sess",
		currency: "USD",
		items,
		coupons: [],
		taxLines: [],
		subtotal: zero("USD"),
		discountTotal: zero("USD"),
		shippingTotal: zero("USD"),
		taxTotal: zero("USD"),
		total: zero("USD"),
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

function product(id: string, amount: number): ProductFields {
	return {
		title: id,
		type: "simple",
		prices: { USD: { amount } },
		manageStock: false,
		stockStatus: "instock",
		stockQuantity: null,
		backorders: "no",
		isVirtual: false,
		isDownloadable: false,
		shippingClassSlug: null,
		weightGrams: null,
	} as ProductFields;
}

function variant(
	id: string,
	productId: string,
	amount: number,
	opts: { isActive?: boolean } = {},
): ProductVariant {
	return {
		id,
		productId,
		sku: `sku-${id}`,
		prices: { USD: { amount } },
		stockQuantity: null,
		weightGrams: null,
		attributes: {},
		isActive: opts.isActive ?? true,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

function coupon(overrides: Partial<Coupon> = {}): Coupon {
	return {
		id: "c1",
		code: "SAVE10",
		discountType: "percent_cart",
		discountValue: 10,
		status: "active",
		excludeSaleItems: false,
		usageCount: 0,
		individualUse: false,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("isVariantOfProduct", () => {
	it("accepts an active variant that belongs to the product", () => {
		const v = variant("v1", "prod-a", 500);
		expect(isVariantOfProduct(v, "prod-a")).toBe(true);
	});

	it("rejects a variant from a different product (cross-product spoof)", () => {
		const cheapOther = variant("v-cheap", "prod-b", 100);
		expect(isVariantOfProduct(cheapOther, "prod-a")).toBe(false);
	});

	it("rejects inactive variants even when productId matches", () => {
		const v = variant("v1", "prod-a", 500, { isActive: false });
		expect(isVariantOfProduct(v, "prod-a")).toBe(false);
	});

	it("rejects null/undefined variants", () => {
		expect(isVariantOfProduct(null, "prod-a")).toBe(false);
		expect(isVariantOfProduct(undefined, "prod-a")).toBe(false);
	});
});

describe("variant-aware pricing", () => {
	it("prices with the matching variant, not the product base price", () => {
		const p = product("prod-a", 10_000);
		const v = variant("v1", "prod-a", 7_500);
		const priced = resolvePrice({ product: p, variant: v, currency: "USD" });
		expect(priced?.unit.amount).toBe(7_500);
	});

	it("does not use a foreign variant when ownership fails (caller must guard)", () => {
		// Guard is separate; resolvePrice itself trusts the variant argument.
		// This documents the contract: always call isVariantOfProduct first.
		const foreign = variant("v-cheap", "prod-b", 100);
		expect(isVariantOfProduct(foreign, "prod-a")).toBe(false);
	});
});

describe("coupon re-apply (stale discount)", () => {
	it("recomputes percent discount after cart shrinks (blocks stale-discount→$0)", () => {
		// Applied when cart was $100 → $10 off stored on AppliedCoupon.
		const large = recalculate(baseCart([line("a", 1, 10_000)]));
		const applied = resolveDiscount(coupon(), large);
		expect(applied.discountAmount.amount).toBe(1_000);

		// Attacker / stale state: items removed but discountAmount left at $10
		// against a now-$5 cart → total would go to $0 without refresh.
		const shrunk: CartState = {
			...baseCart([line("a", 1, 5_000)]),
			coupons: [{ ...applied }], // stale $10 off
		};
		const staleTotals = recalculate(shrunk);
		expect(staleTotals.discountTotal.amount).toBe(1_000);
		expect(staleTotals.total.amount).toBe(4_000); // 5000 - 1000; still positive
		// Extreme stale: $10 off on $10 cart → $0
		const extreme: CartState = {
			...baseCart([line("a", 1, 1_000)]),
			coupons: [{ ...applied }],
		};
		const extremeTotals = recalculate(extreme);
		expect(extremeTotals.total.amount).toBe(0);

		// After re-apply, discount tracks the new subtotal (10% of $10 = $1).
		const refreshed = reapplyCoupons([coupon()], extreme);
		expect(refreshed).toHaveLength(1);
		expect(refreshed[0]!.discountAmount.amount).toBe(100);
		const fixed = recalculate({ ...extreme, coupons: refreshed });
		expect(fixed.total.amount).toBe(900);
		expect(fixed.total.amount).toBeGreaterThan(0);
	});

	it("drops coupons that no longer validate against the cart", () => {
		const c = coupon({ minAmount: money("USD", 5_000) });
		const small = baseCart([line("a", 1, 1_000)]);
		const validation = validateCoupon(c, {
			cart: { ...small, subtotal: money("USD", 1_000) },
		});
		expect(validation.ok).toBe(false);
		const refreshed = reapplyCoupons([c], small);
		expect(refreshed).toHaveLength(0);
	});

	it("re-resolves fixed_cart against the current subtotal cap", () => {
		const c = coupon({
			code: "FIVE",
			discountType: "fixed_cart",
			discountValue: 5_000,
			currency: "USD",
		});
		const cart = baseCart([line("a", 1, 3_000)]);
		const refreshed = reapplyCoupons([c], cart);
		expect(refreshed[0]!.discountAmount.amount).toBe(3_000); // capped
	});
});

describe("shipping requote", () => {
	it("updates a stale stored shipping amount from live method config", () => {
		const method: ShippingMethod = {
			id: "flat",
			zoneId: "z1",
			title: "Flat rate",
			order: 0,
			enabled: true,
			config: { type: "flat_rate", amount: money("USD", 800) },
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		};
		const cart: CartState = {
			...baseCart([line("a", 1, 5_000)]),
			shippingMethod: {
				id: "flat",
				label: "Flat rate",
				amount: money("USD", 100), // stale underpriced rate
			},
		};
		const requoted = requoteShippingMethod(cart, [method]);
		expect(requoted.shippingMethod?.amount.amount).toBe(800);
		const totals = recalculate(requoted);
		expect(totals.shippingTotal.amount).toBe(800);
		expect(totals.total.amount).toBe(5_800);
	});

	it("clears shippingMethod when the method is no longer offered", () => {
		const cart: CartState = {
			...baseCart([line("a", 1, 5_000)]),
			shippingMethod: {
				id: "gone",
				label: "Gone",
				amount: money("USD", 100),
			},
		};
		const requoted = requoteShippingMethod(cart, []);
		expect(requoted.shippingMethod).toBeUndefined();
	});
});

describe("reconcilePaymentAmount", () => {
	it("passes when amount_received matches expected total", () => {
		const r = reconcilePaymentAmount(12_500, 12_500);
		expect(r.ok).toBe(true);
		expect(r.delta).toBe(0);
	});

	it("fails when amount_received is less than expected (underpay)", () => {
		const r = reconcilePaymentAmount(12_500, 10_000);
		expect(r.ok).toBe(false);
		expect(r.delta).toBe(-2_500);
		expect(r.expected).toBe(12_500);
		expect(r.received).toBe(10_000);
	});

	it("fails when amount_received is greater than expected", () => {
		const r = reconcilePaymentAmount(12_500, 13_000);
		expect(r.ok).toBe(false);
		expect(r.delta).toBe(500);
	});

	it("treats missing amount_received as 0 (never silently passes)", () => {
		const r = reconcilePaymentAmount(12_500, undefined);
		expect(r.ok).toBe(false);
		expect(r.received).toBe(0);
	});
});

describe("checkout totals integrity composition", () => {
	it("after coupon refresh + shipping requote, recalculate reflects live amounts", () => {
		const method: ShippingMethod = {
			id: "flat",
			zoneId: "z1",
			title: "Flat",
			order: 0,
			enabled: true,
			config: { type: "flat_rate", amount: money("USD", 500) },
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		};
		const c = coupon({ discountType: "percent_cart", discountValue: 20 });

		// Stale: 10% of old $100 cart stored, shipping underquoted.
		const cart: CartState = {
			...baseCart([line("a", 1, 5_000)]),
			coupons: [
				{ code: "SAVE10", discountAmount: money("USD", 1_000), freeShipping: false },
			],
			shippingMethod: {
				id: "flat",
				label: "Flat",
				amount: money("USD", 100),
			},
		};

		const coupons = reapplyCoupons([{ ...c, code: "SAVE10" }], cart);
		const requoted = requoteShippingMethod({ ...cart, coupons }, [method]);
		const result = recalculate(requoted, { taxMode: "flat", flatTaxPercent: 0 });

		// 20% of 5000 = 1000 off; shipping 500; total = 5000 - 1000 + 500 = 4500
		expect(result.discountTotal.amount).toBe(1_000);
		expect(result.shippingTotal.amount).toBe(500);
		expect(result.total.amount).toBe(4_500);
	});
});


describe("order item storage sku mapping", () => {
	function sampleItem(sku: string): OrderItem {
		return {
			id: "oi_1",
			orderId: "ord_1",
			productId: "prod_1",
			sku,
			name: "Mug",
			quantity: 1,
			unitPrice: money("USD", 1000),
			lineSubtotal: money("USD", 1000),
			discountAmount: zero("USD"),
			taxAmount: zero("USD"),
			total: money("USD", 1000),
			isDigital: false,
		};
	}

	it("omits blank sku so EmDash unique $.sku index cannot collide across orders", () => {
		const stored = orderItemToStorage(sampleItem(""));
		expect("sku" in stored).toBe(false);
		expect("productSku" in stored).toBe(false);

		const storedBlank = orderItemToStorage(sampleItem("   "));
		expect("sku" in storedBlank).toBe(false);
		expect("productSku" in storedBlank).toBe(false);
	});

	it("persists catalog sku under productSku, not sku", () => {
		const stored = orderItemToStorage(sampleItem("MUG-001"));
		expect(stored.productSku).toBe("MUG-001");
		expect("sku" in stored).toBe(false);
	});

	it("two storage rows with blank catalog sku do not share a $.sku value", () => {
		const a = orderItemToStorage({ ...sampleItem(""), id: "oi_a", orderId: "ord_a" });
		const b = orderItemToStorage({ ...sampleItem(""), id: "oi_b", orderId: "ord_b" });
		// EmDash unique index keys on json_extract($.sku); both must be absent/undefined.
		expect((a as { sku?: string }).sku).toBeUndefined();
		expect((b as { sku?: string }).sku).toBeUndefined();
		expect(JSON.stringify(a)).not.toContain('"sku"');
		expect(JSON.stringify(b)).not.toContain('"sku"');
	});

	it("reads productSku (and legacy sku) back into OrderItem.sku", () => {
		expect(orderItemFromStorage("oi_1", { ...sampleItem("x"), productSku: "MUG-001", sku: undefined }).sku).toBe(
			"MUG-001",
		);
		expect(orderItemFromStorage("oi_2", { ...sampleItem(""), sku: "LEGACY" }).sku).toBe("LEGACY");
		const { sku: _s, ...rest } = sampleItem("");
		expect(orderItemFromStorage("oi_3", rest).sku).toBe("");
	});
});
