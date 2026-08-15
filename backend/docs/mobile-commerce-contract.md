# KAI Cloud App commerce contract

All mutation endpoints require `Authorization: Bearer …` and an `Idempotency-Key` header matching
`[A-Za-z0-9:_-]{16,120}`. Credit and CNY values returned to the App are rounded to two decimals;
the database ledger uses integer micro-units.

## Shipping addresses

- `GET /mobile/v1/shipping-addresses`
- `POST /mobile/v1/shipping-addresses` — `{ "recipientName": "张三", "phone": "13800138000",
  "province": "上海市", "city": "上海市", "district": "浦东新区", "detail": "…",
  "isDefault": true }`
- `DELETE /mobile/v1/shipping-addresses/:addressId`

The response contains both `id` and opaque `reference`. Device order creation sends the address
`reference` as `shippingAddressReference`; the order never stores plaintext PII. Address payloads
are AES-256-GCM encrypted at rest and isolated by the selected trading subject. Deleting the default
address promotes the newest remaining address. Deleted references remain on historical orders but
are rejected for every new order.

## Supplier payout

- `GET /mobile/v1/credits/payout-profile`
- `POST /mobile/v1/credits/payouts` — `{ "creditAmount": "100.00" }`
- `GET /mobile/v1/credits/payouts`
- `GET /mobile/v1/credits/payouts/:payoutId`
- `POST /mobile/v1/credits/payouts/:payoutId/cancel`
- `GET /mobile/v1/operator/credit-payouts`
- `PUT /mobile/v1/operator/credit-payout-profiles/:subjectId/activate` —
  `{ "legalEntityDigest": "…", "recipientReference": "…" }`
- `POST /mobile/v1/operator/credit-payouts/:payoutId/review`
- `POST /mobile/v1/operator/credit-payouts/:payoutId/pay`
- `POST /mobile/v1/operator/credit-payouts/:payoutId/succeed` —
  `{ "companyPaymentReference": "…", "companyPaymentFlowDigest": "…", "companyPaymentAmountCents": 10020 }`
- `POST /mobile/v1/operator/credit-payouts/:payoutId/fail` — `{ "failureCode": "…", "reason": "…" }`
- `POST /mobile/v1/operator/credit-payouts/:payoutId/reject` — `{ "reason": "…" }`

States: `submitted → reviewing → paying → succeeded|failed`; review may become `rejected`, and a
submitted request may become `cancelled`. Creation atomically moves available credit into
`payoutFrozen`; `failed`, `rejected`, and `cancelled` return it; `succeeded` requires an exact company
payment amount, a unique payment reference, and a unique flow digest.

Important errors: `PAYOUT_PROFILE_PENDING_ACTIVATION`, `PAYOUT_CREDITS_INSUFFICIENT`,
`PAYOUT_STATE_INVALID`, `IDEMPOTENCY_KEY_CONFLICT`.

## Physical NVIDIA DGX Spark

Authoritative product ID: `02672000-0000-4000-8000-000000000200`.

- `GET /mobile/v1/device-products` — public catalog read; authentication is optional
- `GET /mobile/v1/device-products/:productId` — public product read; authentication is optional
- `POST /mobile/v1/device-orders` —
  `{ "productId": "…", "quantity": 1, "shippingAddressReference": "address-vault-token" }`
- `GET /mobile/v1/device-orders`
- `GET /mobile/v1/device-orders/:orderId`
- `POST /mobile/v1/device-orders/:orderId/cancel`
- `POST /mobile/v1/provider/device-orders/:orderId/confirm`
- `POST /mobile/v1/provider/device-orders/:orderId/ship` —
  `{ "logisticsProvider": "顺丰", "trackingDigest": "sha256:…" }`
- `POST /mobile/v1/device-orders/:orderId/receive`
- `POST /mobile/v1/provider/device-orders/:orderId/settle`
- `GET /mobile/v1/device-assets`
- `PUT /mobile/v1/operator/device-products/:productId/activate` — `{ "supplierSubjectId": "…" }`

The catalog source is one database row: 200 units, 20% discount (`¥40,750.00 → ¥32,600.00`),
`32,534.93` displayed KAI credits per unit, supplier display name `白鸽在线`, and 90-day expected
delivery. It remains visible but `purchasable: false` while `pending_activation`. Activation requires
an active legal trading subject and an active payout profile.

Order states: `reserved → confirmed → shipping → received`; `reserved|confirmed → cancelled`.
Creation locks inventory and buyer credit in one transaction. Cancellation returns both. Receipt
captures exact gross credit, applies the 1.00%→0.20% cumulative volume fee tiers, creates the buyer's
device asset, and places the net amount in supplier receivable. Seven days later `settle` moves the
net amount to supplier available credit, where the payout workflow can redeem it.

Important errors: `DEVICE_PRODUCT_PENDING_ACTIVATION`, `DEVICE_STOCK_INSUFFICIENT`,
`KAI_CREDITS_INSUFFICIENT`, `DEVICE_ORDER_STATE_INVALID`, `DEVICE_SETTLEMENT_NOT_DUE`.
