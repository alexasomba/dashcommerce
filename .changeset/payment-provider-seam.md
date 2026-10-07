---
"@dashcommerce/core": minor
---

Add a gateway-agnostic PaymentProvider seam (`@dashcommerce/core/payment-provider`) with a Stripe adapter and test mock, so additional processors can plug into hosted checkout, webhook verification, and refunds without forking core.

Hosted `checkout/create-session`, `checkout/webhook`, and admin refunds now go through `resolveProvider()` (default `"stripe"`). Checkout session ids and PaymentIntent ids are separate (`checkoutReference` / `paymentReference`); webhook dedupe uses `providerEventId` (Stripe `event.id`); refunds require an explicit `refundRequestId`; duplicate provider registration throws unless `override: true` is passed.

Thanks [@moset15](https://github.com/moset15) / FIKANOVA for the original PaymentProvider design in #18.
