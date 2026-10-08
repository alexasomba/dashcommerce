/**
 * PaymentProvider seam — review blockers from PR #18 plus hosted Stripe parity.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import { money, zero } from "../src/money";
import { createOrderFromPaymentIntent } from "../src/orders/create";
import { refundOrder } from "../src/orders/refund";
import {
	type InitCheckoutInput,
	createMockPaymentProvider,
	registerPaymentProvider,
	requirePaymentProvider,
	resetPaymentProviders,
	resolveProvider,
	resolveWebhookProvider,
	stripePaymentProvider,
	toCreateCheckoutSessionInput,
	unsupportedHostedCheckoutFeatures,
	withBillingShippingFallback,
} from "../src/payment-provider";
import { webhookRoutes } from "../src/routes/webhook";
import { encodeStripeForm } from "../src/stripe/client";
import type { Address, CartState, Order } from "../src/types";

afterEach(() => {
	resetPaymentProviders();
});

function runtimeCtx(handler: (url: string, init?: RequestInit) => Record<string, unknown>) {
	return {
		http: {
			fetch: async (url: string, init?: RequestInit) => {
				const body = handler(url, init);
				return new Response(JSON.stringify(body), { status: 200 });
			},
		},
		log: { info() {}, warn() {}, error() {} },
	};
}

function parseForm(body: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!body) return out;
	for (const pair of body.split("&")) {
		const [k, v] = pair.split("=");
		if (!k) continue;
		out[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
	}
	return out;
}

function hostedInput(overrides: Partial<InitCheckoutInput> = {}): InitCheckoutInput {
	return {
		orderDraftId: "draft_1",
		amount: 2500,
		currency: "USD",
		customer: { email: "buyer@example.com" },
		lineItems: [
			{
				name: "Mug",
				amount: 2000,
				currency: "usd",
				quantity: 1,
				metadata: { productId: "prod_mug" },
			},
		],
		successUrl: "https://shop.example/thank-you/draft_1",
		cancelUrl: "https://shop.example/checkout?canceled=1",
		...overrides,
	};
}

describe("checkoutReference vs paymentReference", () => {
	it("initCheckout returns a Checkout Session id, not a PaymentIntent id", async () => {
		const ctx = runtimeCtx((url) => {
			expect(url).toContain("/checkout/sessions");
			return { id: "cs_test_123", url: "https://checkout.stripe.com/c/cs_test_123" };
		});
		const result = await stripePaymentProvider.initCheckout(ctx, hostedInput(), {
			secretKey: "sk_test_x",
		});
		expect(result.kind).toBe("redirect");
		if (result.kind !== "redirect") return;
		expect(result.checkoutReference).toBe("cs_test_123");
		expect(result.checkoutReference.startsWith("cs_")).toBe(true);
	});

	it("paid checkout.session.completed exposes session id and PaymentIntent separately", () => {
		const event = stripePaymentProvider.parseWebhookEvent(
			JSON.stringify({
				id: "evt_cs_1",
				type: "checkout.session.completed",
				data: {
					object: {
						id: "cs_test_abc",
						mode: "payment",
						payment_status: "paid",
						payment_intent: "pi_test_abc",
						amount_total: 2500,
						currency: "usd",
						metadata: { orderDraftId: "draft_1" },
						customer_details: {
							email: "buyer@example.com",
							name: "Ada Lovelace",
							address: {
								line1: "1 Street",
								city: "London",
								state: "LDN",
								postal_code: "EC1A 1BB",
								country: "GB",
							},
						},
					},
				},
			}),
		);
		expect(event.type).toBe("charge.succeeded");
		if (event.type !== "charge.succeeded") return;
		expect(event.checkoutReference).toBe("cs_test_abc");
		expect(event.paymentReference).toBe("pi_test_abc");
		expect(event.paymentReference.startsWith("pi_")).toBe(true);
	});

	it("does not treat a Checkout Session id as paymentReference when PI is missing", () => {
		const event = stripePaymentProvider.parseWebhookEvent(
			JSON.stringify({
				id: "evt_cs_2",
				type: "checkout.session.completed",
				data: {
					object: {
						id: "cs_test_nopi",
						mode: "payment",
						payment_status: "paid",
						metadata: { orderDraftId: "draft_1" },
					},
				},
			}),
		);
		expect(event.type).toBe("unhandled");
	});

	it("refund() refuses a Checkout Session id", async () => {
		const ctx = runtimeCtx(() => {
			throw new Error("Stripe refunds API must not be called with a session id");
		});
		await expect(
			stripePaymentProvider.refund(
				ctx,
				{
					paymentReference: "cs_test_abc",
					refundRequestId: "refund_req_1",
					currency: "USD",
					amount: 500,
				},
				{ secretKey: "sk_test_x" },
			),
		).rejects.toThrow(/PaymentIntent id/);
	});

	it("refund() posts the PaymentIntent id, not the session id", async () => {
		let form: Record<string, string> = {};
		let idempotency: string | null = null;
		const ctx = runtimeCtx((url, init) => {
			expect(url).toContain("/refunds");
			form = parseForm(typeof init?.body === "string" ? init.body : undefined);
			idempotency =
				(init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"] ?? null;
			return { id: "re_1", amount: 500, currency: "usd", status: "succeeded" };
		});
		const result = await stripePaymentProvider.refund(
			ctx,
			{
				paymentReference: "pi_test_abc",
				refundRequestId: "refund_req_1",
				currency: "USD",
				amount: 500,
			},
			{ secretKey: "sk_test_x" },
		);
		expect(form.payment_intent).toBe("pi_test_abc");
		expect(form.payment_intent?.startsWith("cs_")).toBe(false);
		expect(idempotency).toBe("refund_req_1");
		expect(form.reason).toBe("requested_by_customer");
		expect(result.providerRefundId).toBe("re_1");
	});

	it("posts refund metadata {orderId,orderNumber} and maps unknown reasons to requested_by_customer", async () => {
		let form: Record<string, string> = {};
		const ctx = runtimeCtx((_url, init) => {
			form = parseForm(typeof init?.body === "string" ? init.body : undefined);
			return { id: "re_meta", amount: 100, currency: "usd", status: "succeeded" };
		});
		await stripePaymentProvider.refund(
			ctx,
			{
				paymentReference: "pi_1",
				refundRequestId: "refund_req_meta",
				currency: "USD",
				amount: 100,
				reason: "customer asked",
				metadata: { orderId: "ord_1", orderNumber: "1001" },
			},
			{ secretKey: "sk_test_x" },
		);
		expect(form.reason).toBe("requested_by_customer");
		expect(form["metadata[orderId]"]).toBe("ord_1");
		expect(form["metadata[orderNumber]"]).toBe("1001");
	});
});

describe("providerEventId", () => {
	it("exposes Stripe event.id on charge.succeeded", () => {
		const event = stripePaymentProvider.parseWebhookEvent(
			JSON.stringify({
				id: "evt_1ABC",
				type: "payment_intent.succeeded",
				data: {
					object: {
						id: "pi_1",
						amount: 1000,
						amount_received: 1000,
						currency: "usd",
						metadata: { orderDraftId: "draft_1" },
					},
				},
			}),
		);
		expect(event.type).toBe("charge.succeeded");
		if (event.type !== "charge.succeeded") return;
		expect(event.providerEventId).toBe("evt_1ABC");
	});

	it("exposes Stripe event.id on unhandled types so webhook dedupe still works", () => {
		const event = stripePaymentProvider.parseWebhookEvent(
			JSON.stringify({
				id: "evt_invoice_1",
				type: "invoice.paid",
				data: { object: { id: "in_1" } },
			}),
		);
		expect(event.type).toBe("unhandled");
		if (event.type !== "unhandled") return;
		expect(event.providerEventId).toBe("evt_invoice_1");
		expect(event.providerEventType).toBe("invoice.paid");
	});
});

describe("InitCheckoutInput hosted Stripe capabilities", () => {
	it("does not hard-code mode=payment — subscriptions pass through", () => {
		const mapped = toCreateCheckoutSessionInput(
			hostedInput({
				mode: "subscription",
				lineItems: [
					{
						name: "Club",
						amount: 1200,
						currency: "usd",
						quantity: 1,
						recurring: { interval: "month", intervalCount: 1 },
					},
				],
				subscriptionTrialPeriodDays: 14,
				subscriptionMetadata: { dashcommerceProductId: "prod_sub" },
				transferData: { destination: "acct_vendor" },
				applicationFeeAmount: 200,
			}),
		);
		expect(mapped.mode).toBe("subscription");
		expect(mapped.subscriptionTrialPeriodDays).toBe(14);
		expect(mapped.subscriptionMetadata).toEqual({ dashcommerceProductId: "prod_sub" });
		expect(mapped.paymentIntentTransferData).toBeUndefined();
		expect(mapped.paymentIntentApplicationFeeAmount).toBeUndefined();
		expect(mapped.lineItems[0]?.recurring).toEqual({ interval: "month", intervalCount: 1 });
	});

	it("passes shipping, billing collection, Stripe Tax, Connect, and discounts in payment mode", () => {
		const mapped = toCreateCheckoutSessionInput(
			hostedInput({
				mode: "payment",
				billingAddressCollection: "required",
				automaticTax: true,
				shippingAddressCollection: { allowedCountries: ["US"] },
				shippingOptions: [
					{
						id: "flat",
						label: "Flat rate",
						amount: 500,
						currency: "usd",
						metadata: { shippingMethodId: "flat" },
					},
				],
				transferData: { destination: "acct_vendor" },
				applicationFeeAmount: 250,
				discounts: [{ coupon: "coupon_1" }],
				paymentIntentMetadata: { checkoutMode: "hosted", sessionId: "sess" },
				lineItems: [
					{
						name: "Mug",
						amount: 2000,
						currency: "usd",
						quantity: 1,
						taxBehavior: "exclusive",
					},
				],
			}),
		);
		expect(mapped.mode).toBe("payment");
		expect(mapped.billingAddressCollection).toBe("required");
		expect(mapped.automaticTax).toBe(true);
		expect(mapped.shippingAddressCollection).toEqual({ allowedCountries: ["US"] });
		expect(mapped.shippingOptions?.[0]?.displayName).toBe("Flat rate");
		expect(mapped.shippingOptions?.[0]?.amount).toBe(500);
		expect(mapped.paymentIntentTransferData).toEqual({ destination: "acct_vendor" });
		expect(mapped.paymentIntentApplicationFeeAmount).toBe(250);
		expect(mapped.discounts).toEqual([{ coupon: "coupon_1" }]);
		expect(mapped.paymentIntentMetadata?.checkoutMode).toBe("hosted");
		expect(mapped.lineItems[0]?.taxBehavior).toBe("exclusive");
	});

	it("sends those fields on the Stripe Checkout Session create call", async () => {
		let form: Record<string, string> = {};
		const ctx = runtimeCtx((_url, init) => {
			form = parseForm(typeof init?.body === "string" ? init.body : undefined);
			return { id: "cs_live", url: "https://checkout.stripe.com/c/cs_live" };
		});
		await stripePaymentProvider.initCheckout(
			ctx,
			hostedInput({
				mode: "payment",
				automaticTax: true,
				billingAddressCollection: "auto",
				shippingAddressCollection: { allowedCountries: ["GB"] },
				shippingOptions: [{ label: "Tracked", amount: 400, currency: "gbp" }],
				transferData: { destination: "acct_1" },
				applicationFeeAmount: 100,
			}),
			{ secretKey: "sk_test_x" },
		);
		expect(form.mode).toBe("payment");
		expect(form["automatic_tax[enabled]"]).toBe("true");
		expect(form.billing_address_collection).toBe("auto");
		expect(form["shipping_address_collection[allowed_countries][0]"]).toBe("GB");
		expect(form["shipping_options[0][shipping_rate_data][display_name]"]).toBe("Tracked");
		expect(form["payment_intent_data[transfer_data][destination]"]).toBe("acct_1");
		expect(form["payment_intent_data[application_fee_amount]"]).toBe("100");
	});
});

describe("billing / shipping address mapping", () => {
	it("maps customer_details.address to billingAddress and falls back for digital carts", () => {
		const event = stripePaymentProvider.parseWebhookEvent(
			JSON.stringify({
				id: "evt_addr",
				type: "checkout.session.completed",
				data: {
					object: {
						id: "cs_1",
						mode: "payment",
						payment_status: "paid",
						payment_intent: "pi_1",
						amount_total: 999,
						currency: "usd",
						metadata: { orderDraftId: "draft_d" },
						customer_details: {
							email: "digital@example.com",
							name: "Grace Hopper",
							phone: "555",
							address: {
								line1: "2 Code Ave",
								city: "NYC",
								state: "NY",
								postal_code: "10001",
								country: "US",
							},
						},
					},
				},
			}),
		);
		expect(event.type).toBe("charge.succeeded");
		if (event.type !== "charge.succeeded") return;
		expect(event.billingAddress?.line1).toBe("2 Code Ave");
		expect(event.billingAddress?.country).toBe("US");
		expect(event.billingAddress?.firstName).toBe("Grace");
		expect(event.billingAddress?.lastName).toBe("Hopper");
		expect(event.shippingAddress).toEqual(event.billingAddress);
	});

	it("withBillingShippingFallback copies the present address onto the empty slot", () => {
		const billing = { line1: "A", country: "US" };
		expect(withBillingShippingFallback(billing, undefined)).toEqual({
			billingAddress: billing,
			shippingAddress: billing,
		});
		const shipping = { line1: "B", country: "GB" };
		expect(withBillingShippingFallback(undefined, shipping)).toEqual({
			billingAddress: shipping,
			shippingAddress: shipping,
		});
	});
});

describe("refund idempotency", () => {
	it("requires an explicit refundRequestId", async () => {
		const ctx = runtimeCtx(() => ({ id: "re_x" }));
		await expect(
			stripePaymentProvider.refund(
				ctx,
				{
					paymentReference: "pi_1",
					refundRequestId: "  ",
					currency: "USD",
					amount: 100,
				},
				{ secretKey: "sk_test_x" },
			),
		).rejects.toThrow(/refundRequestId/);
	});

	it("two same-amount partials against one payment use distinct Stripe idempotency keys", async () => {
		const keys: string[] = [];
		const ctx = runtimeCtx((_url, init) => {
			keys.push((init?.headers as Record<string, string>)["Idempotency-Key"] ?? "");
			return { id: `re_${keys.length}`, amount: 500, currency: "usd", status: "succeeded" };
		});
		await stripePaymentProvider.refund(
			ctx,
			{
				paymentReference: "pi_shared",
				refundRequestId: "refund:order:attempt-a",
				amount: 500,
				currency: "USD",
			},
			{ secretKey: "sk_test_x" },
		);
		await stripePaymentProvider.refund(
			ctx,
			{
				paymentReference: "pi_shared",
				refundRequestId: "refund:order:attempt-b",
				amount: 500,
				currency: "USD",
			},
			{ secretKey: "sk_test_x" },
		);
		expect(keys).toEqual(["refund:order:attempt-a", "refund:order:attempt-b"]);
		expect(keys[0]).not.toBe("refund:pi_shared:500");
	});
});

describe("registerPaymentProvider", () => {
	it("throws on duplicate ids unless override is passed", () => {
		expect(() => registerPaymentProvider(stripePaymentProvider)).toThrow(/already registered/);
		const mock = createMockPaymentProvider({ id: "stripe" });
		expect(() => registerPaymentProvider(mock)).toThrow(/already registered/);
		registerPaymentProvider(mock, { override: true });
		expect(stripePaymentProvider.id).toBe("stripe");
	});

	it("resolveProvider defaults to stripe", async () => {
		const kv = { get: async () => null };
		const provider = await resolveProvider(kv);
		expect(provider.id).toBe("stripe");
	});
});

describe("supportsCurrency", () => {
	it("Stripe accepts ISO codes rather than returning ['*']", () => {
		expect(stripePaymentProvider.supportsCurrency("USD")).toBe(true);
		expect(stripePaymentProvider.supportsCurrency("kes")).toBe(true);
		expect(stripePaymentProvider.supportsCurrency("*")).toBe(false);
		expect(stripePaymentProvider.supportsCurrency("US")).toBe(false);
		expect(typeof stripePaymentProvider.supportsCurrency("USD")).toBe("boolean");
	});
});

describe("mock provider", () => {
	it("uses ?mock=1 when the success URL has no query string", async () => {
		const mock = createMockPaymentProvider();
		const result = await mock.initCheckout(
			runtimeCtx(() => ({})),
			hostedInput({ successUrl: "https://shop.example/thanks" }),
			{ secretKey: "test" },
		);
		expect(result.kind).toBe("redirect");
		if (result.kind !== "redirect") return;
		expect(result.redirectUrl).toBe("https://shop.example/thanks?mock=1");
	});

	it("uses & when the success URL already has a query string", async () => {
		const mock = createMockPaymentProvider();
		const result = await mock.initCheckout(
			runtimeCtx(() => ({})),
			hostedInput({ successUrl: "https://shop.example/thanks?order=1" }),
			{ secretKey: "test" },
		);
		expect(result.kind).toBe("redirect");
		if (result.kind !== "redirect") return;
		expect(result.redirectUrl).toContain("order=1");
		expect(result.redirectUrl).toContain("mock=1");
		expect(result.redirectUrl).not.toContain("thanks&mock=1");
	});

	it("returns unhandled on invalid JSON instead of throwing", () => {
		const mock = createMockPaymentProvider();
		const event = mock.parseWebhookEvent("{not json");
		expect(event.type).toBe("unhandled");
		if (event.type !== "unhandled") return;
		expect(event.providerEventType).toBe("unparseable");
	});
});

describe("parseWebhookEvent invalid JSON (Stripe)", () => {
	it("returns unhandled rather than throwing", () => {
		expect(() => stripePaymentProvider.parseWebhookEvent("<<<")).not.toThrow();
		const event = stripePaymentProvider.parseWebhookEvent("<<<");
		expect(event.type).toBe("unhandled");
		if (event.type !== "unhandled") return;
		expect(event.providerEventType).toBe("unparseable");
		expect(event.providerEventId).toBeUndefined();
	});

	it("does not map unpaid checkout.session.completed to charge.succeeded", () => {
		const event = stripePaymentProvider.parseWebhookEvent(
			JSON.stringify({
				id: "evt_unpaid",
				type: "checkout.session.completed",
				data: {
					object: {
						id: "cs_unpaid",
						mode: "payment",
						payment_status: "unpaid",
						payment_intent: "pi_later",
						metadata: { orderDraftId: "draft_1" },
					},
				},
			}),
		);
		expect(event.type).toBe("unhandled");
	});
});

describe("encodeStripeForm sanity (mapping helper still urlencodes objects)", () => {
	it("nests transfer_data like the existing Stripe client", () => {
		const encoded = encodeStripeForm({
			"payment_intent_data[transfer_data][destination]": "acct_1",
		});
		expect(encoded).toContain("acct_1");
	});
});

async function hmacHex(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
	const bytes = new Uint8Array(sig);
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}

function webhookCtx(opts?: { duplicateEvent?: boolean }) {
	const kv = new Map<string, unknown>([
		["settings:stripeWebhookSecret", "whsec_test"],
		["settings:stripeSecretKey", "sk_test_x"],
	]);
	const events = new Set<string>();
	return {
		kv: {
			get: async (k: string) => kv.get(k) ?? null,
			set: async () => {},
			delete: async () => {},
		},
		storage: {
			stripe_events: {
				put: async (_id: string, row: { stripeEventId: string }) => {
					if (events.has(row.stripeEventId) || opts?.duplicateEvent) {
						const err = Object.assign(new Error("unique"), { code: "UNIQUE" });
						throw err;
					}
					events.add(row.stripeEventId);
				},
			},
		},
		log: { info() {}, warn() {}, error() {}, debug() {} },
		site: { url: "https://shop.example", name: "Shop" },
		url: (p: string) => `https://shop.example${p}`,
	} as unknown as PluginContext;
}

describe("webhook route wiring", () => {
	it("still 400s on a missing Stripe-Signature for the default stripe provider", async () => {
		const res = await webhookRoutes["checkout/webhook"].handler(
			{
				input: {},
				request: new Request("http://test/checkout/webhook", {
					method: "POST",
					body: "{}",
				}),
			} as unknown as RouteContext,
			webhookCtx(),
		);
		expect(res).toBeInstanceOf(Response);
		if (!(res instanceof Response)) return;
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toMatch(/Stripe-Signature/);
	});

	it("dedupes on providerEventId (Stripe event.id) after verifyWebhook", async () => {
		const secret = "whsec_test";
		const payload = JSON.stringify({
			id: "evt_dup",
			type: "ping",
			data: { object: {} },
		});
		const now = Date.now();
		const timestamp = Math.floor(now / 1000);
		const sig = await hmacHex(secret, `${timestamp}.${payload}`);
		const makeReq = () =>
			({
				input: {},
				request: new Request("http://test/checkout/webhook", {
					method: "POST",
					headers: { "stripe-signature": `t=${timestamp},v1=${sig}` },
					body: payload,
				}),
			}) as unknown as RouteContext;

		const first = await webhookRoutes["checkout/webhook"].handler(makeReq(), webhookCtx());
		expect(first).toBeInstanceOf(Response);
		if (!(first instanceof Response)) return;
		expect(first.status).toBe(200);

		const second = await webhookRoutes["checkout/webhook"].handler(
			makeReq(),
			webhookCtx({ duplicateEvent: true }),
		);
		expect(second).toBeInstanceOf(Response);
		if (!(second instanceof Response)) return;
		expect(second.status).toBe(200);
		const body = (await second.json()) as { duplicate?: boolean };
		expect(body.duplicate).toBe(true);
	});

	it("still verifies Stripe events after settings:paymentProvider switches away (stripe-signature)", async () => {
		const secret = "whsec_test";
		const payload = JSON.stringify({
			id: "evt_inflight",
			type: "ping",
			data: { object: {} },
		});
		const timestamp = Math.floor(Date.now() / 1000);
		const sig = await hmacHex(secret, `${timestamp}.${payload}`);
		const ctx = webhookCtx();
		(ctx.kv as { get: (k: string) => Promise<unknown> }).get = async (k: string) => {
			if (k === "settings:paymentProvider") return "paystack";
			if (k === "settings:stripeWebhookSecret") return secret;
			if (k === "settings:stripeSecretKey") return "sk_test_x";
			return null;
		};
		const res = await webhookRoutes["checkout/webhook"].handler(
			{
				input: {},
				request: new Request("http://test/checkout/webhook", {
					method: "POST",
					headers: { "stripe-signature": `t=${timestamp},v1=${sig}` },
					body: payload,
				}),
			} as unknown as RouteContext,
			ctx,
		);
		expect(res).toBeInstanceOf(Response);
		if (!(res instanceof Response)) return;
		expect(res.status).toBe(200);
		const body = (await res.json()) as { received?: boolean; skipped?: boolean };
		expect(body.received).toBe(true);
	});
});

describe("requirePaymentProvider — no silent Stripe fallback", () => {
	it("throws when the id is not registered", () => {
		expect(() => requirePaymentProvider("paystack")).toThrow(/not registered/);
	});

	it("resolveProvider throws for an unregistered settings value", async () => {
		const kv = { get: async () => "paystack" };
		await expect(resolveProvider(kv)).rejects.toThrow(/not registered/);
	});
});

describe("resolveWebhookProvider", () => {
	it("routes stripe-signature to Stripe even when settings say otherwise", async () => {
		const kv = { get: async () => "paystack" };
		const headers = new Headers({ "stripe-signature": "t=1,v1=abc" });
		const { provider, signatureHeader } = await resolveWebhookProvider(kv, headers);
		expect(provider.id).toBe("stripe");
		expect(signatureHeader).toBe("t=1,v1=abc");
	});

	it("routes x-<id>-signature to a registered non-Stripe provider", async () => {
		registerPaymentProvider(createMockPaymentProvider({ id: "mock" }));
		const kv = { get: async () => "stripe" };
		const headers = new Headers({ "x-mock-signature": "sig-mock" });
		const { provider, signatureHeader } = await resolveWebhookProvider(kv, headers);
		expect(provider.id).toBe("mock");
		expect(signatureHeader).toBe("sig-mock");
	});

	it("honors ?provider= over settings", async () => {
		registerPaymentProvider(createMockPaymentProvider({ id: "mock" }));
		const kv = { get: async () => "stripe" };
		const headers = new Headers({ "x-mock-signature": "sig-q" });
		const { provider } = await resolveWebhookProvider(
			kv,
			headers,
			"http://test/checkout/webhook?provider=mock",
		);
		expect(provider.id).toBe("mock");
	});
});

describe("unsupportedHostedCheckoutFeatures", () => {
	it("Stripe declares coupons, Connect, and subscriptions", () => {
		expect(
			unsupportedHostedCheckoutFeatures(stripePaymentProvider, {
				coupons: true,
				connect: true,
				subscriptions: true,
			}),
		).toEqual([]);
	});

	it("rejects coupons/Connect/subs when the adapter does not declare them", () => {
		const mock = createMockPaymentProvider({ id: "mock" });
		expect(
			unsupportedHostedCheckoutFeatures(mock, {
				coupons: true,
				connect: true,
				subscriptions: true,
			}),
		).toEqual(["coupons", "connect", "subscriptions"]);
	});

	it("allows features the adapter opts into", () => {
		const mock = createMockPaymentProvider({
			id: "mock",
			capabilities: { coupons: true },
		});
		expect(unsupportedHostedCheckoutFeatures(mock, { coupons: true, connect: true })).toEqual([
			"connect",
		]);
	});
});

const testAddress: Address = {
	firstName: "Ada",
	lastName: "Lovelace",
	line1: "1 Street",
	city: "London",
	region: "LDN",
	postalCode: "EC1A 1BB",
	country: "GB",
};

function baseCart(currency: string, amount: number): CartState {
	return {
		sessionId: "sess_1",
		currency,
		items: [
			{
				lineId: "li_1",
				productId: "prod_1",
				title: "Mug",
				quantity: 1,
				unitPrice: money(currency, amount),
				lineSubtotal: money(currency, amount),
				isDigital: false,
			},
		],
		coupons: [],
		subtotal: money(currency, amount),
		discountTotal: zero(currency),
		shippingTotal: zero(currency),
		taxTotal: zero(currency),
		total: money(currency, amount),
		taxLines: [],
		customerEmail: "ada@example.com",
		billingAddress: testAddress,
		shippingAddress: testAddress,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

function commerceCtx(opts?: { kv?: Record<string, unknown>; orders?: Map<string, Order> }) {
	const kv = new Map<string, unknown>(Object.entries(opts?.kv ?? {}));
	const orders = opts?.orders ?? new Map<string, Order>();
	const customers = new Map<string, unknown>();
	const refunds = new Map<string, unknown>();
	return {
		kv: {
			get: async <T>(k: string) => (kv.get(k) as T | undefined) ?? null,
			set: async (k: string, v: unknown) => {
				kv.set(k, v);
			},
			delete: async (k: string) => {
				kv.delete(k);
			},
		},
		storage: {
			orders: {
				get: async (id: string) => orders.get(id) ?? null,
				put: async (id: string, data: Order) => {
					orders.set(id, { ...data, id });
				},
				query: async ({ where }: { where?: { stripePaymentIntentId?: string } }) => {
					if (where?.stripePaymentIntentId) {
						for (const [id, data] of orders) {
							if (data.stripePaymentIntentId === where.stripePaymentIntentId) {
								return { items: [{ id, data }], cursor: null, hasMore: false };
							}
						}
					}
					return { items: [], cursor: null, hasMore: false };
				},
			},
			order_items: {
				putMany: async () => {},
				query: async () => ({ items: [], cursor: null, hasMore: false }),
			},
			customers: {
				query: async () => ({ items: [], cursor: null, hasMore: false }),
				put: async (id: string, data: unknown) => {
					customers.set(id, data);
				},
			},
			coupons: {
				query: async () => ({ items: [], cursor: null, hasMore: false }),
			},
			coupon_usage: {
				put: async () => {},
				count: async () => 0,
			},
			refunds: {
				put: async (id: string, data: unknown) => {
					refunds.set(id, data);
				},
				query: async () => ({ items: [], cursor: null, hasMore: false }),
			},
			download_grants: {
				query: async () => ({ items: [], cursor: null, hasMore: false }),
			},
		},
		log: { info() {}, warn() {}, error() {}, debug() {} },
		site: { url: "https://shop.example", name: "Shop" },
		url: (p: string) => `https://shop.example${p}`,
		_orders: orders,
		_refunds: refunds,
	} as unknown as PluginContext & { _orders: Map<string, Order>; _refunds: Map<string, unknown> };
}

function paidOrder(overrides: Partial<Order> = {}): Order {
	const currency = overrides.currency ?? "USD";
	return {
		id: "ord_1",
		orderNumber: "1001",
		status: "processing",
		paymentStatus: "paid",
		customerId: "cus_1",
		customerEmail: "ada@example.com",
		currency,
		billingAddress: testAddress,
		shippingAddress: testAddress,
		subtotal: money(currency, 1000),
		discountTotal: zero(currency),
		shippingTotal: zero(currency),
		taxTotal: zero(currency),
		total: money(currency, 1000),
		paidTotal: money(currency, 1000),
		refundedTotal: zero(currency),
		taxLines: [],
		couponCodes: [],
		stripePaymentIntentId: "pi_1",
		providerId: "stripe",
		paymentReference: "pi_1",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		paidAt: new Date().toISOString(),
		...overrides,
	};
}

describe("refund credentials by order.providerId", () => {
	it("refunds a mock-provider order from KV creds and ignores a passed Stripe secret", async () => {
		registerPaymentProvider(createMockPaymentProvider({ id: "mock" }));
		const order = paidOrder({
			providerId: "mock",
			paymentReference: "mock_pay_1",
			stripePaymentIntentId: "mock_pay_1",
		});
		const ctx = commerceCtx({
			kv: { "settings:mockSecretKey": "mock_sk" },
			orders: new Map([[order.id, order]]),
		});
		const refund = await refundOrder(ctx, {
			orderId: order.id,
			amount: money("USD", 400),
			reason: "requested_by_customer",
			client: { secretKey: "sk_stripe_must_not_be_used" },
			idempotencyKey: "refund:ord_1:a",
		});
		expect(refund.stripeRefundId).toBe("mock_refund_refund:ord_1:a");
		expect(refund.status).toBe("succeeded");
	});

	it("throws when the order's provider is not registered (no Stripe fallback)", async () => {
		const order = paidOrder({ providerId: "paystack", paymentReference: "ref_1" });
		const ctx = commerceCtx({
			kv: { "settings:stripeSecretKey": "sk_test_x" },
			orders: new Map([[order.id, order]]),
		});
		await expect(
			refundOrder(ctx, {
				orderId: order.id,
				amount: money("USD", 400),
				client: { secretKey: "sk_test_x" },
				idempotencyKey: "refund:ord_1:b",
			}),
		).rejects.toThrow(/not registered/);
	});

	it("does not use input.client.secretKey — Stripe orders need KV Stripe creds", async () => {
		const order = paidOrder({ providerId: "stripe" });
		const ctx = commerceCtx({
			orders: new Map([[order.id, order]]),
		});
		await expect(
			refundOrder(ctx, {
				orderId: order.id,
				amount: money("USD", 400),
				client: { secretKey: "sk_from_admin" },
				idempotencyKey: "refund:ord_1:c",
			}),
		).rejects.toThrow(/not configured/);
	});
});

describe("currency mismatch hold", () => {
	it("places the order on-hold when 5000 KES is reported against a 5000 USD cart", async () => {
		const ctx = commerceCtx();
		const { order } = await createOrderFromPaymentIntent(ctx, {
			paymentIntent: {
				id: "pi_fx",
				amount: 5000,
				amount_received: 5000,
				currency: "kes",
				status: "succeeded",
				receipt_email: "ada@example.com",
				metadata: { orderDraftId: "draft_fx", checkoutReference: "cs_fx" },
			},
			cartSnapshot: baseCart("USD", 5000),
			orderDraftId: "draft_fx",
		});
		expect(order.status).toBe("on-hold");
		expect(order.metadata?.paymentCurrencyMismatch).toBe(true);
		expect(order.metadata?.paymentAmountMismatch).toBe(false);
		expect(order.checkoutReference).toBe("cs_fx");
	});
});
