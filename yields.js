/* yields.js — v0.1.0
   Porting fedele di scraper/yields.py (compute) in JavaScript, per ricalcolare i
   rendimenti all-in nel browser con i parametri scelti dall'utente.
   Deve dare gli stessi numeri di Python a parità di input: vedi tools/check_js_vs_py.mjs. */
(function (root) {
  "use strict";
  const DAY = 86400000;

  function easter(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4,
      f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30,
      i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
      month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return Date.UTC(y, month - 1, day);
  }
  function targetHolidays(y) {
    const e = easter(y);
    return new Set([Date.UTC(y, 0, 1), e - 2 * DAY, e + DAY, Date.UTC(y, 4, 1), Date.UTC(y, 11, 25), Date.UTC(y, 11, 26)]);
  }
  function isBusinessDay(t) {
    const d = new Date(t); const wd = d.getUTCDay();
    return wd !== 0 && wd !== 6 && !targetHolidays(d.getUTCFullYear()).has(t);
  }
  function addBusinessDays(t, n) { while (n > 0) { t += DAY; if (isBusinessDay(t)) n--; } return t; }
  function settlementDate(t) { return addBusinessDays(t, 2); }
  function addMonths(t, months) {
    const d = new Date(t); const y0 = d.getUTCFullYear(), m0 = d.getUTCMonth(), day = d.getUTCDate();
    const y = y0 + Math.floor((m0 + months) / 12); const m = ((m0 + months) % 12 + 12) % 12;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return Date.UTC(y, m, Math.min(day, last));
  }
  function parseISO(s) { if (!s) return null; const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); }
  function toISO(t) { return t == null ? null : new Date(t).toISOString().slice(0, 10); }

  function couponSchedule(maturity, freq, settle, accrualStart) {
    if (freq <= 0) return { future: [], prev: accrualStart };
    const step = 12 / freq; const dates = []; let prev = null; let k = 0; let d = maturity;
    for (;;) {
      if (d > settle) dates.push(d); else { prev = d; break; }
      k++; d = addMonths(maturity, -step * k);
      if (accrualStart != null && d < accrualStart) { prev = accrualStart; break; }
      if (k > 2000) break;
    }
    dates.sort((a, b) => a - b);
    return { future: dates, prev };
  }
  function accrued(couponAnnual, freq, settle, prev, next) {
    if (freq <= 0 || prev == null || next == null || next <= prev) return 0;
    return (couponAnnual / freq) * ((settle - prev) / DAY) / ((next - prev) / DAY);
  }
  function irr(flows, guess = 0.03) {
    const npv = r => flows.reduce((s, [t, cf]) => s + cf / Math.pow(1 + r, t), 0);
    let lo = -0.99, hi = 5.0, flo = npv(lo), fhi = npv(hi);
    if (flo * fhi > 0) return null;
    let r = guess;
    for (let i = 0; i < 50; i++) {
      const f = npv(r); const d = flows.reduce((s, [t, cf]) => s - t * cf / Math.pow(1 + r, t + 1), 0);
      if (d === 0) break;
      const nr = r - f / d;
      if (!(lo < nr && nr < hi)) break;
      if (Math.abs(nr - r) < 1e-12) return nr;
      r = nr;
    }
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2, fm = npv(mid);
      if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
      if (hi - lo < 1e-12) break;
    }
    return (lo + hi) / 2;
  }

  /** compute(bond, params) — bond: record di bonds.json; params: {price, priceSource, tradeDate(ms UTC),
      commissionPct, commissionMin, commissionMax|null, bolloRate, nominal} */
  function compute(bond, p) {
    const settle = settlementDate(p.tradeDate);
    const maturity = parseISO(bond.maturity);
    const accrualStart = parseISO(bond.accrual_start);
    const years = (maturity - settle) / DAY / 365.0;
    const tax = bond.tax_rate;
    let couponAnnual = bond.coupon_annual || 0, freq = bond.coupon_frequency || 0;
    if (bond.kind === "zero") { couponAnnual = 0; freq = 0; }
    const price = p.price;
    const { future, prev } = couponSchedule(maturity, freq, settle, accrualStart);
    const next = future.length ? future[0] : null;
    const accG = accrued(couponAnnual, freq, settle, prev, next);
    const accN = accG * (1 - tax);
    const per = freq ? couponAnnual / freq : 0, perNet = per * (1 - tax);
    const gain = Math.max(0, 100 - price), cgTax = tax * gain, minus = Math.max(0, price - 100);
    const redemptionNet = 100 - cgTax;
    const yf = d => (d - settle) / DAY / 365.0;

    const flowsG = [[0, -(price + accG)], ...future.map(d => [yf(d), per]), [yf(maturity), 100]];
    const flowsN = [[0, -(price + accN)], ...future.map(d => [yf(d), perNet]), [yf(maturity), redemptionNet]];
    const ytmG = irr(flowsG), ytmN = irr(flowsN);

    const N = Math.max(p.nominal, 0);
    const ctvGross = (price + accG) / 100 * N;
    let comm = ctvGross * p.commissionPct;
    comm = Math.max(comm, p.commissionMin);
    if (p.commissionMax != null) comm = Math.min(comm, p.commissionMax);
    const avgVal = (price + 100) / 2 / 100 * N;
    const bolloFlows = []; let t = 1.0;
    while (t < years) { bolloFlows.push([t, -avgVal * p.bolloRate]); t += 1.0; }
    const frac = years - (t - 1.0);
    if (frac > 0) bolloFlows.push([years, -avgVal * p.bolloRate * frac]);
    const bolloTotal = -bolloFlows.reduce((s, [, cf]) => s + cf, 0);
    const costTotal = (price + accN) / 100 * N + comm;
    const couponsNetTotal = perNet / 100 * N * future.length;
    const redemptionEur = redemptionNet / 100 * N;
    const netGain = couponsNetTotal + redemptionEur - costTotal - bolloTotal;
    const flowsAll = [[0, -costTotal], ...future.map(d => [yf(d), perNet / 100 * N]), [yf(maturity), redemptionEur], ...bolloFlows];
    const ytmAll = N > 0 ? irr(flowsAll) : null;
    const simpleAll = (costTotal > 0 && years > 0) ? netGain / costTotal / years : null;

    return {
      price_used: price, price_source: p.priceSource, settle_date: toISO(settle), years_to_maturity: years,
      tax_rate: tax, accrued_gross: accG, accrued_net: accN, next_coupon_date: toISO(next),
      coupon_net_per_period: perNet, n_coupons: future.length,
      ytm_gross: ytmG, ytm_net_tax: ytmN, ytm_net_all: ytmAll, simple_net_all: simpleAll,
      current_yield_gross: price ? couponAnnual / price : 0,
      nominal: N, cost_total_eur: costTotal, commission_eur: comm, bollo_total_eur: bolloTotal,
      coupons_net_total_eur: couponsNetTotal, redemption_net_eur: redemptionEur,
      capital_gain_tax_eur: cgTax / 100 * N, minus_eur: minus / 100 * N, net_gain_total_eur: netGain,
      coupon_dates: future.map(toISO),
    };
  }

  const api = { compute, settlementDate, parseISO, toISO, irr, VERSION: "0.1.0" };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Yields = api;
})(typeof window !== "undefined" ? window : globalThis);
