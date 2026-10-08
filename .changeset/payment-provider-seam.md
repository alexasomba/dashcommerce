---
"@dashcommerce/core": minor
---

Add a gateway-agnostic PaymentProvider seam (`@dashcommerce/core/payment-provider`) with a Stripe adapter and test mock, so additional processors can plug into hosted checkout, webhook verification, and refunds without forking core.

Hosted `checkout/create-session`, `checkout/webhook`, and admin refunds now go through `resolveProvider()` (default `"stripe"`). Checkout session ids and PaymentIntent ids are separate (`checkoutReference` / `paymentReference`); webhook dedupe uses `providerEventId` (Stripe `event.id`); refunds require an explicit `refundRequestId`; duplicate provider registration throws unless `override: true` is passed.

Refunds load credentials by `order.providerId` (no silent Stripe fallback, admin no longer requires a Stripe key). Webhooks route by signature header so in-flight Stripe events still verify after a provider switch. Captured amount **and** currency are reconciled (hold/withhold on mismatch); non-Stripe hosted checkout 409s coupons/Connect/subs unless the adapter declares support.

Thanks [@moset15](https://github.com/moset15) / FIKANOVA for the original PaymentProvider design in #18.
