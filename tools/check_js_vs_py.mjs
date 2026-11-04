// check_js_vs_py.mjs — v0.1.0
// Confronta yields.js con i risultati Python salvati in data/bonds.json (parametri di default).
// Uso: node tools/check_js_vs_py.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const Y = require("../yields.js");
const d = JSON.parse(readFileSync(new URL("../data/bonds.json", import.meta.url)));
const cp = d.meta.cost_params_default;
const fields = ["accrued_gross","accrued_net","ytm_gross","ytm_net_tax","ytm_net_all","simple_net_all","cost_total_eur","commission_eur","bollo_total_eur","coupons_net_total_eur","redemption_net_eur","net_gain_total_eur","minus_eur","years_to_maturity"];
let worst = 0, n = 0, bad = [];
for (const b of d.bonds) {
  if (!b.calc) continue;
  const r = Y.compute(b, { price: b.price.used, priceSource: b.price.source, tradeDate: Y.parseISO(b.calc.trade_date),
    commissionPct: cp.commission_pct, commissionMin: cp.commission_min, commissionMax: cp.commission_max, bolloRate: cp.bollo_rate, nominal: cp.nominal });
  n++;
  if (r.settle_date !== b.calc.settle_date || r.next_coupon_date !== b.calc.next_coupon_date) bad.push([b.isin, "date", r.settle_date, b.calc.settle_date, r.next_coupon_date, b.calc.next_coupon_date]);
  for (const f of fields) {
    const a = r[f], p = b.calc[f];
    if (a == null && p == null) continue;
    const diff = Math.abs(a - p); worst = Math.max(worst, diff);
    if (diff > 1e-7) bad.push([b.isin, f, a, p]);
  }
}
console.log(`titoli confrontati: ${n}, scostamento massimo: ${worst.toExponential(2)}`);
if (bad.length) { console.log("DIFFERENZE:", bad); process.exit(1); } else console.log("JS e Python coincidono.");
