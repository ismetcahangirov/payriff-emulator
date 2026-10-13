import { OUTCOME_TEXT, TEST_CARDS } from './cards.js';
import type { Order } from './state.js';

export function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const STYLE = `
:root { color-scheme: light dark; --bg: #f4f5f7; --panel: #ffffff; --text: #16181d; --muted: #5b6270; --line: #d9dce3; --accent: #1d4ed8; --accent-text: #ffffff; --danger: #b42318; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f1115; --panel: #181b21; --text: #eceff4; --muted: #a3aab8; --line: #2c313b; --accent: #6b93ff; --accent-text: #0f1115; --danger: #ff8a7a; } }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--text); }
main { max-width: 440px; margin: 32px auto; padding: 0 16px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
.badge { display: inline-block; font-size: 12px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; }
h1 { font-size: 28px; margin: 12px 0 4px; }
p { margin: 0 0 16px; color: var(--muted); }
label { display: block; font-size: 14px; margin: 12px 0 4px; }
input { width: 100%; padding: 10px 12px; font: inherit; color: var(--text); background: transparent; border: 1px solid var(--line); border-radius: 8px; }
input:focus-visible, button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
button { width: 100%; margin-top: 20px; padding: 12px; font: inherit; font-weight: 600; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-text); cursor: pointer; }
button.secondary { background: transparent; color: var(--text); border-color: var(--line); margin-top: 8px; }
.error { color: var(--danger); font-weight: 600; }
.warning { margin: 12px 0 0; padding: 8px 12px; border: 1px solid var(--danger); border-radius: 8px; color: var(--danger); font-weight: 600; }
table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
td { padding: 4px 0; border-top: 1px solid var(--line); }
td:first-child { font-family: ui-monospace, monospace; }
details { margin-top: 20px; color: var(--muted); }
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body><main><div class="panel">${body}</div></main></body>
</html>`;
}

function heading(order: Order, merchantName: string): string {
  return `<span class="badge">Unofficial Payriff emulator</span>
<p class="warning" role="note">Not Payriff. A local test tool: never enter a real card.</p>
<h1>${escape(order.amount.toFixed(2))} ${escape(order.currency)}</h1>
<p>${escape(merchantName)}${order.description ? ` · ${escape(order.description)}` : ''}</p>`;
}

export function cardPage(order: Order, merchantName: string, error: string | null = null): string {
  const cards = TEST_CARDS.map(
    (card) => `<tr><td>${card.pan}</td><td>${escape(OUTCOME_TEXT[card.behaviour])}</td></tr>`,
  ).join('');
  return layout(
    'Pay with card',
    `${heading(order, merchantName)}
${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}
<form method="post" action="/pay/${escape(order.orderId)}">
<label for="pan">Card number</label>
<input id="pan" name="pan" inputmode="numeric" autocomplete="off" required>
<label for="holder">Cardholder name</label>
<input id="holder" name="holder" autocomplete="off" required>
<div class="row">
<div><label for="expiry">Expiry (MM/YY)</label><input id="expiry" name="expiry" placeholder="12/30" autocomplete="off" required></div>
<div><label for="cvv">CVV</label><input id="cvv" name="cvv" inputmode="numeric" autocomplete="off" required></div>
</div>
<button type="submit">Pay</button>
</form>
<form method="post" action="/pay/${escape(order.orderId)}/cancel"><button class="secondary" type="submit">Cancel</button></form>
<details><summary>Test cards</summary><table>${cards}</table><p>Any other Luhn-valid number is approved. 3-D Secure code: see the next step.</p></details>`,
  );
}

export function otpPage(order: Order, merchantName: string, otp: string): string {
  return layout(
    '3-D Secure',
    `${heading(order, merchantName)}
<form method="post" action="/pay/${escape(order.orderId)}/otp">
<label for="otp">One-time code</label>
<input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" required>
<p>Emulator code: <strong>${escape(otp)}</strong>. Any other code fails authentication.</p>
<button type="submit">Confirm</button>
</form>`,
  );
}

export function resultPage(order: Order, merchantName: string): string {
  return layout(
    `Payment ${order.status.toLowerCase()}`,
    `${heading(order, merchantName)}<p>This payment is <strong>${escape(order.status)}</strong>.</p>`,
  );
}
