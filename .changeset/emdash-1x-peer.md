---
"@dashcommerce/core": patch
---

Widen the `emdash` peer to `>=0.37.0 <0.38.0 || >=1.1.0 <2.0.0` so current EmDash 1.x installs pass peer checks without bricking 0.37.x. The runtime compatibility check matches that range (skipping untested 0.38–0.42 and the mistaken `emdash@1.0.0` publish). Dual-version patches keep Stripe webhook raw-body reads and raw `Response` passthrough working on both 0.37.0 and 1.1.0.
