---
"@dashcommerce/core": patch
---

Harden checkout and Stripe webhook payment integrity: verify variant ownership, re-resolve coupon/shipping amounts at checkout, require paid payment status (incl. async success), and reconcile PaymentIntent amounts; fix hosted Checkout Session tax/discount line items.
