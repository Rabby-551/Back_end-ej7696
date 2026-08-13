# RevenueCat backend setup

## Deployed endpoints

- Webhook: `POST https://api.inspectorspath.com/api/v1/payments/revenuecat/webhook`
- Authenticated client sync: `POST https://api.inspectorspath.com/api/v1/payments/revenuecat/sync`
- Authenticated refund callback: `POST https://api.inspectorspath.com/api/v1/payments/revenuecat/refund-request`

The client sync endpoint uses the signed-in backend user's MongoDB ID as the
RevenueCat App User ID. It does not accept a user ID from the request body.

## RevenueCat webhook form

- **Webhook name:** `Inspectors Path Backend`
- **Webhook URL:** `https://api.inspectorspath.com/api/v1/payments/revenuecat/webhook`
- **Authorization header value:** `Bearer <REVENUECAT_WEBHOOK_AUTH_TOKEN>`
- **Environment:** Both Production and Sandbox while testing
- **App:** the Inspector's Path apps, or All apps
- **Event type:** All Events
- **Paywall events:** optional; they are safely ignored by this backend

Use **Send test webhook** after the updated backend is deployed. A valid test
must receive HTTP 200. Requests with a missing/wrong Authorization value receive
HTTP 401.

## Required server configuration

Copy the RevenueCat variables from `.env.example` into the production server.
The RevenueCat v2 secret key needs these permissions:

- `customer_information:customers:read`
- `customer_information:subscriptions:read_write` (required for Google Play refunds)
- `customer_information:purchases:read`
- `project_configuration:products:read` (required to translate RevenueCat v2
  `prod...` resource IDs into App Store / Play Store product identifiers)

The webhook token is independent of the RevenueCat API key. Generate a random
token and keep it secret. The handler accepts the recommended `Bearer <token>`
format and also accepts the raw token for compatibility.

For stronger validation, enable HMAC webhook signing in RevenueCat and set
`REVENUECAT_WEBHOOK_SIGNING_SECRET`. The server verifies the signature against
the original raw JSON bytes and rejects signatures older than five minutes.

## Six-month exam products

Create one non-renewing/prepaid six-month product per exam using the identifiers
listed in `.env.example`. The current Google/Apple USD store tier is $149.99
(the closest available tier to the $150 business price). The initial
`six_month_subscriptions` product is USD 199.99 and must be purchased only after
the user selects an exam. Keep the legacy `.unlock` products attached to
RevenueCat for restore/migration reads, but remove them from current offerings.
Set `EXAM_SUBSCRIPTION_MIGRATION_AT` once to the production migration timestamp
and never change it, so later legacy restores receive the same fixed six-month
window instead of extending access on every restore.

Place products in separate subscription groups/base-plan-compatible groups so a
customer can hold multiple exam entitlements concurrently. Use manual renewal;
do not configure an automatic renewal offer.

## Lifecycle behavior

- Initial purchases, renewals, uncancellations, extensions, transfers, and
  temporary grants synchronize current RevenueCat access.
- Cancellation does not change the account back to Starter. Each exam stays
  active until its own `expiresAt`, then only that exam locks.
- A successful Customer Center refund submission revokes only the exam linked
  to that purchase. Failed or abandoned submissions do not change access.
- Expiration locks only the matching exam. A confirmed refund revokes only the
  exam attached to that transaction.
- Webhook event IDs are stored uniquely, so retries cannot apply the same event
  twice.
- Unknown future event types are recorded and acknowledged without changing
  access.
- Flutter also calls the authenticated sync endpoint after purchase/restore to
  avoid waiting for webhook delivery.

## Unlock the selected exam after subscribing

After RevenueCat reports a successful Professional subscription, Flutter must
call the authenticated sync endpoint with the exam selected before checkout:

```http
POST /api/v1/payments/revenuecat/sync
Authorization: Bearer <backend-access-token>
Content-Type: application/json

{
  "examId": "<selected-exam-mongodb-id>",
  "productId": "<revenuecat-subscription-product-id>"
}
```

`selectedExamId` is also accepted as an alias for `examId`. The backend verifies
the signed-in user's current RevenueCat access before writing the `ExamAccess`
record. A successful response includes:

```json
{
  "success": true,
  "message": "RevenueCat subscription confirmed and selected exam unlocked",
  "data": {
    "subscriptionTier": "professional",
    "hasProfessionalAccess": true,
    "selectedExam": {
      "examId": "<selected-exam-mongodb-id>",
      "unlocked": true,
      "purchaseType": "plan",
      "paymentStatus": "completed",
      "accessDuration": "subscription",
      "expiresAt": "<subscription-expiration>"
    }
  }
}
```

The client should continue only when `data.subscriptionTier` is `professional`
and `data.selectedExam.unlocked` is `true`. If RevenueCat has not confirmed the
subscription, the selected exam is not unlocked and the endpoint returns HTTP
`402 Payment Required`.

## Refund behavior

The existing admin refund endpoint remains:

`POST /api/v1/payments/admin/transactions/:transactionId/refund`

- Stripe: full and partial refunds are issued through Stripe.
- PayPal: full and partial refunds are issued against the captured payment.
- RevenueCat Google Play/Galaxy: full transaction refunds are issued through
  RevenueCat API v2 and access is revoked.
- Apple: Apple does not expose this refund operation through RevenueCat. Issue
  the refund in App Store Connect; the RevenueCat webhook will then record the
  refund and revoke access.
- Manual records: local refund bookkeeping is supported.

Neither partial nor full refunds downgrade the account to Starter. A full
refund revokes only the exam linked to that transaction, voids linked add-ons,
and rebuilds resource access from the user's remaining completed purchases.

## Deployment order

1. Set the fixed `EXAM_SUBSCRIPTION_MIGRATION_AT` timestamp and run
   `npm run migrate:exam-subscriptions` once before releasing the new app.
2. Deploy the compatible backend and install production dependencies.
3. Confirm `GET https://api.inspectorspath.com/` returns HTTP 200.
4. Configure the webhook and products in RevenueCat using the values above.
5. Send a RevenueCat test webhook and confirm HTTP 200.
6. Make a sandbox purchase and confirm the user's backend profile becomes
   `professional` with a RevenueCat expiration date.
7. Test unsubscribe (access remains through expiry), expiration, refund, restore,
   duplicate webhook delivery, and account transfer.
