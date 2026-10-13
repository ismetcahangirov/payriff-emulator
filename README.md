# Payriff emulator

> **Unofficial.** This project is not affiliated with, endorsed by or sponsored
> by Payriff. "Payriff" is a trademark of its owner and is used here only to
> say which API is emulated. For the real service and its sandbox, see
> [payriff.com](https://payriff.com).

A local emulator of the Payriff Gateway API v3, for integration tests and
development. The real sandbox cannot age a payment past the 30-day refund
window, fail a callback on demand, or answer a 503 when you need one. This
emulator can.

**Run it only on your machine, in CI or on a private network.** Its payment
page asks for a card number, and its control API has no authentication. Never
deploy it where the public can reach it, and never enter a real card.

It speaks the same wire format as Payriff: the `{code, message, route,
responseId, responseDetails, payload}` envelope, amounts as exact JSON decimals,
the secret key in `Authorization`, `X-REQUEST-RRN` as a UUID, and unsigned order
callbacks.

## Quick start

```bash
pnpm install
pnpm dev                      # http://localhost:4010
```

or

```bash
docker build -t payriff-emulator .
docker run --rm -p 4010:4010 payriff-emulator
```

Point the client at `http://localhost:4010/api/v3` with the secret key
`emulator-secret-key`:

```bash
curl -s http://localhost:4010/api/v3/orders \
  -H 'Authorization: emulator-secret-key' \
  -H 'Content-Type: application/json' \
  -H "X-REQUEST-RRN: $(uuidgen)" \
  -d '{"amount":20.50,"currency":"AZN","language":"EN","operation":"PURCHASE","callbackUrl":"https://merchant.test/payriff"}'
```

Open the `paymentUrl` from the answer, pay with a test card, and enter the
3-D Secure code `123456`.

## Where each behaviour comes from

Every behaviour is labelled with its source, so you know how far to trust it.

| Behaviour | Source |
|---|---|
| A refund more than 30 days after the payment answers **HTTP 400**, `code` `01000`, `message` `Refund time expired.\n Support ticket: <n>`, `route` `dashboard/main`, `responseDetails` `null`, no `payload` | Confirmed by Payriff support (2026-10) |
| Refunds are allowed for 30 days at most. The commission is not returned | Confirmed by Payriff (2026-10) |
| A failed callback is retried 3 times, about 2 min 45 s after the first attempt and then every 5 minutes | Confirmed by Payriff, timing observed in the real sandbox (2026-10) |
| Callbacks are unsigned | Observed in the real sandbox |
| After 3-D Secure, the browser is sent to `callbackUrl` with a **GET**. `redirectUrl` is ignored | Observed in the real sandbox |
| `X-REQUEST-RRN` must be a UUID. Anything else answers `15000 Internal Error` | Observed in the real sandbox |
| The 3-D Secure code is `123456` | Observed in the real sandbox |
| A card number that fails the Luhn check is refused | Observed in the real sandbox |
| Commission is 3 % (configurable) | A merchant contract. Yours may differ |
| Endpoints, request and response fields, payment statuses, transfer states | Official Java SDK, [`PayRiff/payriff-java`](https://github.com/PayRiff/payriff-java) |
| `00000` success, `01000` business refusal, `01200` insufficient balance, `01300`/`01400`/`01500` payout limits, `14010`/`14013`/`14014`/`14015` authentication, `15400` validation | Official Java SDK, `ResultCodes` |
| Payouts carry the full `cardPan`, `fullName` and `finCode` inside a `{merchant, body}` envelope | Official Java SDK, and confirmed by Payriff (2026-10) |

The rest are **emulator choices**, made where Payriff documents nothing. Do not
rely on them in production code:

- The same `X-REQUEST-RRN` returns the same order. The same payout `requestRrn`
  returns the same payout.
- An unknown order answers HTTP 404 with `01000 Order not found`.
- Wording of refusals other than the refund window (`Refund amount exceeds the
  payment`, `Order is CREATED and cannot be refunded`, and so on).
- An unpaid order expires after `ORDER_TTL_MINUTES`, without a callback.
- A refund sends a callback to the refund's `callbackUrl`, or else to the
  order's.
- A card save is a zero-amount order. The test cards, the bank name and the
  cardholder check are the emulator's own.

## Test cards

Any expiry in the future and any 3- or 4-digit CVV work.

| Card number | Outcome |
|---|---|
| `4111111111111111` | Approved (Visa) |
| `5555555555554444` | Approved (Mastercard) |
| `4000000000000002` | Declined by the issuer |
| `4000000000009995` | Insufficient funds |
| `4000000000000069` | Expired card |
| any other Luhn-valid number | Approved |

A wrong 3-D Secure code, or an expiry date in the past, declines the payment.
Payouts use the same table: an approving card succeeds, any other card ends in
`FAIL`.

## API

Everything under `/api/v3` requires `Authorization: <secret key>`.

| Method and path | What it does |
|---|---|
| `POST /orders` | Create an order (`PURCHASE` or `PRE_AUTH`, `cardSave`, `metadata`). Answers `paymentUrl` |
| `GET /orders/{orderId}` | The order, with transactions and card details |
| `GET /orders/{orderId}/status` | The same |
| `GET /orders/{requestRrn}/rrn` | The order created with that RRN |
| `PATCH /expire-status?orderId=` | Expire an unpaid order |
| `POST /refund` | Refund in full or in part: `{orderId, amount?, refundReason?, callbackUrl?}` |
| `POST /complete` | Complete a pre-authorisation: `{orderId, amount?}` |
| `POST /autoPay` | Charge a saved card: `{cardUuid, amount, description?, callbackUrl?}` |
| `POST /cards/save` | Start a card registration (`X-Idempotency-Key`). Answers `paymentUrl` |
| `GET /cards/save/{cardSaveId}` | The registration's status and card |
| `GET /cards/save?customerRef=` | A customer's saved cards |
| `DELETE /cards/{cardUuid}` | Delete a saved card |
| `POST /payout` | Pay out to a card: `{merchant, body: {transferAmount, description, fullName, finCode, cardPan, requestRrn}}` |
| `GET /payout/info/{requestRrn}` | A payout's status |
| `POST /payout/check-cardholder` | The masked cardholder name for `{cardPan}` |
| `GET /payouts?status=&page=&size=` | Payouts, newest first |
| `GET /transactions?orderId=&status=&page=&offset=` | Decided orders, newest first |

The browser pages live at `/pay/{orderId}`.

## Control API

`/_emulator` has no authentication. Do not expose it to the internet.

| Method and path | What it does |
|---|---|
| `GET /_emulator` | Clock, counts, deposit balance, test cards |
| `POST /_emulator/reset` | Forget everything and reset the clock |
| `POST /_emulator/clock` | Move the clock forward: `{"advance":"P31D"}` or `{"advanceMs":1000}` |
| `DELETE /_emulator/clock` | Reset the clock |
| `GET /_emulator/orders` | Every order, newest first |
| `GET /_emulator/orders/{orderId}` | One order, with its RRN, callback URL and every callback attempt |
| `POST /_emulator/orders/{orderId}/pay` | Pay without the browser: `{pan?, holder?, otp?}` |
| `POST /_emulator/orders/{orderId}/cancel` | Cancel as the backer would |
| `POST /_emulator/orders/{orderId}/age` | Move one order into the past: `{"days":31}` |
| `POST /_emulator/orders/{orderId}/callback` | Send the callback again, optionally to `{url}` |
| `GET /_emulator/callbacks` | Every callback and its attempts |
| `PATCH /_emulator/cards/{cardUuid}` | Change how a saved card behaves: `{"behaviour":"insufficient_funds"}` |
| `POST /_emulator/faults` | Make an API path fail: `{method?, path, status, code?, message?, raw?, delayMs?, times?}` |
| `GET /_emulator/faults`, `DELETE /_emulator/faults` | List or clear faults |

For example, to test the refund window without waiting a month:

```bash
curl -s -X POST localhost:4010/_emulator/orders/$ORDER/pay
curl -s -X POST localhost:4010/_emulator/orders/$ORDER/age -H 'Content-Type: application/json' -d '{"days":31}'
curl -s localhost:4010/api/v3/refund -H 'Authorization: emulator-secret-key' \
  -H 'Content-Type: application/json' -d "{\"orderId\":\"$ORDER\"}"
# HTTP 400 {"code":"01000","message":"Refund time expired.\n Support ticket: 840003",...}
```

To test an outage: `{"path":"/api/v3/orders","status":502,"raw":"<html>Bad Gateway</html>","times":2}`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Listen address |
| `PORT` | `4010` | Listen port |
| `PUBLIC_URL` | `http://localhost:$PORT` | Base of every `paymentUrl` |
| `PAYRIFF_SECRET_KEYS` | `emulator-secret-key` | Accepted secret keys, comma-separated |
| `PAYRIFF_MERCHANT_ID` | `ES0000000` | The `merchant` a payout must name |
| `PAYRIFF_MERCHANT_NAME` | `Emulator Merchant` | Shown on the payment page and in `merchantName` |
| `COMMISSION_RATE` | `3` | Commission, in percent |
| `REFUND_WINDOW_DAYS` | `30` | Days after payment during which a refund is allowed |
| `ORDER_TTL_MINUTES` | `30` | Minutes before an unpaid order expires |
| `OTP_CODE` | `123456` | The 3-D Secure code that authenticates |
| `ALLOW_HTTP_CALLBACKS` | `false` | Accept `http://` callbacks on any host. Loopback hosts are always accepted |
| `CALLBACK_RETRIES` | `3` | Retries after a failed callback |
| `CALLBACK_FIRST_RETRY_MS` | `165000` | Delay before the first retry |
| `CALLBACK_RETRY_MS` | `300000` | Delay between later retries |
| `CALLBACK_TIMEOUT_MS` | `10000` | How long a callback may take |
| `PAYOUT_BALANCE` | `1000.00` | The merchant's deposit for payouts |
| `PAYOUT_DAILY_LIMIT` | `5000.00` | Payout total per UTC day before `01300` |
| `PAYOUT_FEE_RATE` | `0` | Payout fee, in percent |

State is in memory and is lost on restart.

## Not emulated

Invoices (`/api/v2`), receipts (PDF), `directPay` (which carries encrypted card
data), installments, and real 3-D Secure redirects. The real `paymentUrl` is on
Payriff's domain. Here it is on `PUBLIC_URL`.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build && pnpm start
```

Money is `decimal.js` throughout. Incoming JSON is parsed losslessly, so
`20.50` stays `20.50`. Never convert an amount to a JavaScript number.

## License

[MIT](LICENSE)
