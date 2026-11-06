/* sim.js — v0.3.0 — Bond Netto: simulatore "se vendo prima" e costruttore di scala (ladder) */
(() => {
  "use strict";
  const A = window.BondApp, Y = window.Yields;
  const { $, fmtPct, fmtNum, fmtCur, fmtDate, esc } = A;
  const DAY = Y.DAY;

  // ---------------- "Se vendo prima" ----------------
  // Ipotesi: dopo h anni vendi al prezzo che il titolo avrebbe se il suo rendimento lordo fosse quello di oggi (+/- lo scenario scelto).
  // Flussi: esborso oggi (prezzo + rateo netto + commissione), cedole nette incassate nel frattempo, vendita = prezzo + rateo
  // (rateo tassato come reddito, come all'acquisto) - commissione di vendita - tassa sulla plusvalenza (prezzo vendita - prezzo acquisto, se > 0);
  // se < 0 e' una minusvalenza (credito fiscale, non conteggiata). Bollo pro rata sugli anni di detenzione.
  function simulate(b, nominal, holdYears, shiftPts) {
    const p = A.params(nominal);
    const trade = Y.parseISO(A.state.meta.trade_date);
    const c0 = Y.compute(b, { price: b._price, priceSource: b.price.source, tradeDate: trade, ...p });
    const settle0 = Y.parseISO(c0.settle_date);
    const maturity = Y.parseISO(b.maturity);
    let exit = Y.addMonths(settle0, Math.round(holdYears * 12));
    if (exit >= maturity) return { atMaturity: true, c0 };
    const tax = c0.tax_rate;
    const yExit = c0.ytm_gross + shiftPts / 100;
    const px = Y.priceAtYield(b, exit, yExit);
    const N = nominal;
    // cedole incassate tra regolamento e uscita (la prima puo' essere corta: fattore dal calcolo principale)
    const cpnDates = c0.coupon_dates.map(Y.parseISO).filter(d => d > settle0 && d <= exit);
    // importo della cedola pagata in d: tasso di quel periodo (step-up: dal piano MEF), netto, con fattore prima cedola
    const cpar = Y.couponParams(b);
    const cpnAmt = d => (Y.toISO(d) === c0.coupon_dates[0] ? c0.first_coupon_factor : 1) * ((cpar.rateFor && cpar.freq) ? cpar.rateFor(d) / cpar.freq : cpar.couponAnnual / (cpar.freq || 1)) * (1 - tax) / 100 * N;
    const couponsNet = cpnDates.reduce((s, d) => s + cpnAmt(d), 0);
    const saleClean = px.clean, saleAccNet = px.accrued * (1 - tax);
    const gain = saleClean - b._price;
    const cgTax = gain > 0 ? gain * tax : 0, minus = gain < 0 ? -gain / 100 * N : 0;
    let commSell = (px.dirty / 100 * N) * p.commissionPct; commSell = Math.max(commSell, p.commissionMin); if (p.commissionMax != null) commSell = Math.min(commSell, p.commissionMax);
    const bollo = (b._price + 100) / 2 / 100 * N * p.bolloRate * holdYears;
    const proceeds = (saleClean + saleAccNet - cgTax) / 100 * N - commSell;
    const netGain = couponsNet + proceeds - c0.cost_total_eur - bollo;
    const tf = d => (d - settle0) / DAY / 365;
    const flows = [[0, -c0.cost_total_eur], ...cpnDates.map(d => [tf(d), cpnAmt(d)]), [tf(exit), proceeds - bollo]];
    const irr = Y.irr(flows);
    return { atMaturity: false, c0, exit: Y.toISO(exit), yExit, saleClean, saleAccNet, couponsNet, cgTax: cgTax / 100 * N, minus, commSell, bollo, proceeds, netGain, irr, total: c0.cost_total_eur > 0 ? netGain / c0.cost_total_eur : null, nCoupons: cpnDates.length };
  }
  function simHTML(b, nominal, hold, shift) {
    const r = simulate(b, nominal, hold, shift);
    if (r.atMaturity) return `<p class="hint">Oltre la scadenza: vale il calcolo a scadenza qui sopra.</p>`;
    const sc = shift === 0 ? "rendimenti invariati" : shift > 0 ? `rendimenti +${shift} punto` : `rendimenti ${shift} punto`;
    return `<div class="kpis">
      <div class="kpi"><div class="l">Rendimento netto annuo se vendo dopo ${fmtNum(hold, 1)} anni (${sc})</div><div class="v ${r.irr != null && r.irr >= 0 ? "good" : "ko"}">${fmtPct(r.irr)}</div></div>
      <div class="kpi"><div class="l">Guadagno netto totale</div><div class="v ${r.netGain >= 0 ? "good" : "ko"}">${fmtCur(r.netGain, b.currency)} <span class="small">(${r.total != null ? (r.total >= 0 ? "+" : "") + fmtPct(r.total) : "–"})</span></div></div>
    </div>
    <table class="kv">
      <tr><td>Vendita il ${fmtDate(r.exit)} a prezzo</td><td>${fmtNum(r.saleClean, 2)} <span class="small">(rendimento lordo ${fmtPct(r.yExit)})</span></td></tr>
      <tr><td>Cedole nette incassate (${r.nCoupons})</td><td>${fmtCur(r.couponsNet, b.currency)}</td></tr>
      <tr><td>Rateo netto incassato alla vendita</td><td>${fmtCur(r.saleAccNet / 100 * nominal, b.currency)}</td></tr>
      <tr><td>Tassa sulla plusvalenza di prezzo</td><td>−${fmtCur(r.cgTax, b.currency)}</td></tr>
      <tr><td>Commissione di vendita</td><td>−${fmtCur(r.commSell, b.currency)}</td></tr>
      <tr><td>Bollo (${fmtNum(hold, 1)} anni)</td><td>−${fmtCur(r.bollo, b.currency)}</td></tr>
      ${r.minus > 0 ? `<tr><td>Minusvalenza generata (credito fiscale, non conteggiata)</td><td class="ko">${fmtCur(r.minus, b.currency)}</td></tr>` : ""}
    </table>
    <p class="hint">A scadenza il rendimento netto annuo sarebbe ${fmtPct(r.c0.ytm_net_all)}. Vendere prima costa una seconda commissione e, se compri sotto 100, rinuncia a parte del guadagno da prezzo; con un rialzo dei tassi il prezzo di vendita scende (duration ${fmtNum(r.c0.mod_duration, 1)}).${b.kind === "zero" ? " Zero coupon: la parte di guadagno maturata pro rata è tassata come interesse, l'eventuale eccedenza al 26%: qui è tutto all'aliquota del titolo (stima leggermente ottimista per i titoli di Stato)." : ""}${b.kind === "callable" ? " Titolo richiamabile: se viene rimborsato prima, lo scenario non si applica." : ""}</p>`;
  }

  function mountSim(b, nominal) {
    const host = $("#d-sim"); if (!host || !b._calc) return;
    const maxH = Math.floor(b._calc.years_to_maturity * 2) / 2 - 0.5;   // ultimo semestre intero prima della scadenza
    if (maxH < 0.5) { host.innerHTML = ""; return; }                       // sotto l'anno: niente simulatore
    const h0 = Math.min(maxH, Math.max(0.5, Math.round(b._calc.years_to_maturity) / 2));   // default: a metà vita
    host.innerHTML = `<h3>Se vendo prima della scadenza</h3>
      <div class="sim-ctl"><label>Dopo <output id="sim-h">${fmtNum(h0, 1)}</output> anni <input id="sim-hold" type="range" min="0.5" max="${maxH}" step="0.5" value="${h0}"></label>
      <label>Scenario tassi <select id="sim-shift"><option value="0">invariati</option><option value="1">+1 punto (prezzi giù)</option><option value="-1">−1 punto (prezzi su)</option><option value="2">+2 punti</option></select></label></div>
      <div id="sim-out"></div>`;
    const upd = () => { const h = parseFloat($("#sim-hold").value), sh = parseFloat($("#sim-shift").value); $("#sim-h").textContent = fmtNum(h, 1); $("#sim-out").innerHTML = simHTML(b, nominal(), h, sh); };
    $("#sim-hold").addEventListener("input", upd); $("#sim-shift").addEventListener("change", upd); upd();
  }

  // ---------------- Costruttore di scala ----------------
  // chiave emittente per la diversificazione: per gli Stati il paese (EuroTLX e MOT scrivono "ROMANIA" in modi diversi), altrimenti il nome
  const issuerKey = b => (b._cat === "gov_it" || b._cat === "gov_fx") ? "gov:" + b.country : (b.issuer || b.name).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10);
  function buildLadder(opts) {
    const { total, horizon, rungs, pool } = opts;
    const step = horizon / rungs; const out = []; let used = 0; const issuers = new Set();
    for (let k = 0; k < rungs; k++) {
      const lo = k * step, hi = (k + 1) * step;
      const score = opts.mode === "safe" ? (b => -(b._calc.spread_bund ?? 9)) : (b => b._calc.ytm_net_all);   // "safe": spread vs Bund più basso
      const cands = pool.filter(b => b._years >= lo && b._years < hi + (k === rungs - 1 ? 1e-9 : 0)).sort((a, b) => score(b) - score(a));
      const target = total / rungs;
      let pick = null, nominal = 0;
      // diversificazione: un emittente per gradino se possibile (altrimenti si ripete)
      for (const pass of [0, 1]) {
        // taglio: lotto minimo del titolo, ma almeno 1.000 (BI riporta "1" o "100" per 660 titoli: non si compra 600 € di Bund)
        for (const b of cands) { if (pass === 0 && issuers.has(issuerKey(b))) continue; const lot = Math.max(b.min_lot || 1000, 1000); const n = Math.floor(target / lot) * lot; if (n >= lot) { pick = b; nominal = n; break; } }
        if (pick) break;
      }
      if (pick) issuers.add(issuerKey(pick));
      if (!pick) { out.push({ lo, hi, bond: null }); continue; }
      const c = Y.compute(pick, { price: pick._price, priceSource: pick.price.source, tradeDate: Y.parseISO(A.state.meta.trade_date), ...A.params(nominal) });
      used += c.cost_total_eur;
      out.push({ lo, hi, bond: pick, nominal, c });
    }
    return { rungs: out, used };
  }

  function ladderHTML(res, opts) {
    const rows = res.rungs.map(r => r.bond ? `<tr><td>${fmtNum(r.lo, 1)}–${fmtNum(r.hi, 1)} anni</td><td><span class="lnk" data-isin="${r.bond.isin}">${esc(r.bond.name)}</span><br><span class="small">${r.bond.isin} · scad. ${fmtDate(r.bond.maturity)} · ${A.priceBadge(r.bond)} ${fmtNum(r.bond._price)}</span></td><td>${fmtCur(r.nominal, r.bond.currency)}<br><span class="small">esborso ${fmtCur(r.c.cost_total_eur, r.bond.currency)}</span></td><td><b>${fmtPct(r.c.ytm_net_all)}</b>${r.bond._calc.spread_bund != null ? `<br><span class="small" title="differenza di rendimento lordo rispetto a un Bund di pari scadenza: più è alta, più rischio stai comprando">vs Bund ${r.bond._calc.spread_bund >= 0 ? "+" : ""}${fmtPct(r.bond._calc.spread_bund)}</span>` : ""}<br><span class="small">cedole nette ${fmtCur((r.bond.kind === "zero" ? 0 : (r.bond.coupon_annual || 0)) * (1 - r.c.tax_rate) / 100 * r.nominal, r.bond.currency)}/anno</span></td></tr>`
      : `<tr><td>${fmtNum(r.lo, 1)}–${fmtNum(r.hi, 1)} anni</td><td colspan="3" class="hint">nessun titolo adatto tra quelli filtrati (o importo per gradino sotto il lotto minimo)</td></tr>`).join("");
    const ok = res.rungs.filter(r => r.bond);
    const wAvg = ok.length ? ok.reduce((s, r) => s + r.c.ytm_net_all * r.c.cost_total_eur, 0) / ok.reduce((s, r) => s + r.c.cost_total_eur, 0) : null;
    // flusso cedole nette per anno di calendario + rimborsi
    const flows = {}; const y0 = new Date(A.state.meta.trade_date).getUTCFullYear();
    for (const r of ok) {
      for (const d of r.c.coupon_dates) { const y = +d.slice(0, 4); (flows[y] = flows[y] || { c: 0, r: 0 }).c += r.c.coupon_net_per_period / 100 * r.nominal; }
      const ym = +r.bond.maturity.slice(0, 4); (flows[ym] = flows[ym] || { c: 0, r: 0 }).r += r.c.redemption_net_eur;
    }
    const years = Object.keys(flows).map(Number).sort((a, b) => a - b).filter(y => y >= y0);
    const cal = years.length ? `<h3>Flussi netti per anno</h3><table class="kv">${years.map(y => `<tr><td>${y}</td><td>cedole ${fmtCur(flows[y].c, ok[0].bond.currency)}${flows[y].r ? ` · rimborsi <b>${fmtCur(flows[y].r, ok[0].bond.currency)}</b>` : ""}</td></tr>`).join("")}</table>` : "";
    const spreads = ok.map(r => r.bond._calc.spread_bund).filter(x => x != null);
    const avgSpread = spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null;
    return `<table class="kv ladder"><tr><th>Gradino</th><th>Titolo</th><th>Nominale</th><th>Netto annuo</th></tr>${rows}</table>${opts.cur !== "EUR" && ok.length ? `<p class="hint">Importi in <b>${opts.cur}</b>: il rendimento non tiene conto del cambio con l'euro.</p>` : ""}
      <div class="kpis"><div class="kpi"><div class="l">Esborso totale</div><div class="v">${fmtCur(res.used, ok.length ? ok[0].bond.currency : "EUR")}</div></div><div class="kpi"><div class="l">Rendimento netto medio (pesato)</div><div class="v good">${fmtPct(wAvg)}</div></div>${avgSpread != null ? `<div class="kpi"><div class="l">Rischio emittente medio (spread vs Bund)</div><div class="v ${avgSpread < 0.01 ? "good" : avgSpread < 0.02 ? "" : "ko"}">${avgSpread >= 0 ? "+" : ""}${fmtPct(avgSpread)}</div></div>` : ""}</div>
      ${cal}
      <div class="row"><button class="btn" id="ld-fav" ${ok.length ? "" : "disabled"}>★ Salva nei preferiti</button><button class="btn ghost" id="ld-pf" ${ok.length ? "" : "disabled"}>+ Aggiungi al portafoglio</button></div>
      <p class="hint">Per ogni gradino sceglie ${opts.mode === "safe" ? "il titolo con lo spread vs Bund più basso" : "il miglior rendimento netto"} tra i titoli <b>della lista filtrata</b> (con prezzo affidabile, non incerti, non strip, non richiamabili, lotto sotto 100.000), con nominale arrotondato al lotto minimo e, quando possibile, un emittente diverso per gradino. Non è un consiglio: controlla emittente e rischio di ogni titolo nella scheda. Nessun reinvestimento ipotizzato: quando un gradino scade, decidi tu dove reinvestire.</p>`;
  }

  // Universo della scala = la lista principale con i filtri attuali (stessi filtri, stessi conteggi), più scorciatoie.
  // Valuta: quella dei filtri se è una sola, altrimenti EUR. Ammissibili: prezzo affidabile, non incerti, non strip,
  // lotto < 100.000, non richiamabili. "Più sicuro" sceglie per gradino lo spread vs Bund più basso invece del rendimento.
  const ld = { total: null, horizon: 10, rungs: 5, mode: "yield" };
  const eligibleIn = cur => b => b._calc && b._calc.ytm_net_all != null && b.currency === cur && A.reliable(b) && !b._uncertain && !b._strip && (b.min_lot || 0) < 100000 && b.kind !== "callable" && !/call(?![a-z])/i.test(b.name);
  function ladderCurrency() { const f = A.filters ? A.filters.currencies() : []; return f.length === 1 ? f[0] : "EUR"; }
  const PRESETS = [
    ["Tutto", { cat: "all", cur: ["EUR"], countries: [] }],
    ["Solo BTP", { cat: "gov_it", cur: ["EUR"], countries: [] }],
    ["Stati euro", { cat: "gov_fx", cur: ["EUR"], countries: ["DE", "FR", "ES", "AT", "BE", "NL", "FI", "IE", "PT", "SK", "SI", "LT", "LV", "EE", "GR", "HR", "CY", "MT", "LU"] }],
    ["Sovranazionali", { cat: "supra", cur: ["EUR"], countries: [] }],
  ];
  function universeHTML() {
    const cur = ladderCurrency(); const pool = A.state.filtered.filter(eligibleIn(cur));
    const chips = (A.state.activeFilters || []).map(a => `${a.label} ${a.value}`); const cat = A.state.cat !== "all" ? [A.CAT_LABEL[A.state.cat] || A.state.cat] : [];
    const desc = [...cat, ...chips].join(" · ") || "filtri di default";
    const multi = A.filters && A.filters.currencies().length > 1 ? ` <span class="hint">(più valute nei filtri: la scala usa l'euro)</span>` : "";
    return `<div class="ld-universe"><div><b>Titoli: quelli della lista con i filtri attuali</b> — ${esc(desc)}${multi}<br><span class="hint">${pool.length} ammissibili in ${cur} (prezzo affidabile, non incerti, non strip, non richiamabili, lotto sotto 100.000)</span></div>
      <div class="row"><button type="button" class="btn ghost" id="ld-filters">Cambia filtri…</button></div>
      <div class="chips ld-presets">${PRESETS.map(([n], k) => `<button type="button" class="chip" data-preset="${k}">${n}</button>`).join("")}</div><p class="hint">Scorciatoie: impostano i filtri della lista e ricostruiscono la scala. Per la massima prudenza combina "Sovranazionali" o "Stati euro" con "il più sicuro".</p></div>`;
  }
  function applyPreset(k) {
    const [, pr] = PRESETS[k];
    if (A.filters) A.filters.set({ cat: pr.cat, cur: pr.cur, countries: pr.countries, market: [] });
  }

  function openLadder() {
    const s = A.state.settings;
    $("#ladder-body").innerHTML = `<p class="hint">Una "scala" divide l'importo su scadenze scaglionate: ogni anno (o ogni gradino) rientra una parte del capitale, da spendere o reinvestire ai tassi di allora. Riduce il rischio di comprare tutto al momento sbagliato.</p>
      <div class="grid">
        <label>Importo totale <input id="ld-total" type="number" step="1000" min="1000" value="${ld.total || Math.max(s.nominal * 5, 10000)}"></label>
        <label>Orizzonte (anni) <input id="ld-horizon" type="number" step="1" min="1" max="30" value="${ld.horizon}"></label>
        <label>Numero di gradini <input id="ld-rungs" type="number" step="1" min="2" max="15" value="${ld.rungs}"></label>
        <label>Scegli per gradino <select id="ld-mode"><option value="yield" ${ld.mode === "yield" ? "selected" : ""}>il rendimento netto più alto</option><option value="safe" ${ld.mode === "safe" ? "selected" : ""}>il più sicuro (spread vs Bund più basso)</option></select></label>
      </div>
      <div id="ld-universe">${universeHTML()}</div>
      <div class="row"><button class="btn primary" id="ld-build">Costruisci la scala</button></div><div id="ld-out"></div>`;
    $("#ladder").classList.remove("hidden");
    const remember = () => { ld.total = parseFloat($("#ld-total").value); ld.horizon = parseFloat($("#ld-horizon").value); ld.rungs = parseInt($("#ld-rungs").value, 10); ld.mode = $("#ld-mode").value; };
    const run = () => {
      remember();
      if (!(ld.total > 0 && ld.horizon > 0 && ld.rungs >= 2)) return;
      const cur = ladderCurrency(); const pool = A.state.filtered.filter(eligibleIn(cur));
      const res = buildLadder({ total: ld.total, horizon: ld.horizon, rungs: ld.rungs, pool, mode: ld.mode });
      $("#ld-out").innerHTML = ladderHTML(res, { total: ld.total, cur, mode: ld.mode });
      const picks = res.rungs.filter(r => r.bond);
      $("#ld-fav").addEventListener("click", () => { picks.forEach(r => { if (!A.state.favs.has(r.bond.isin)) A.toggleFav(r.bond.isin); }); $("#ld-fav").textContent = "✓ salvati nei preferiti"; });
      $("#ld-pf").addEventListener("click", () => { if (window.BondPortfolio && BondPortfolio.addPositions) { BondPortfolio.addPositions(picks.map(r => ({ isin: r.bond.isin, nominal: r.nominal, price: r.bond._price, commission: r.c.commission_eur }))); $("#ladder").classList.add("hidden"); BondPortfolio.open(); } });
    };
    $("#ld-build").addEventListener("click", run);
    $("#ladder-body").addEventListener("click", e => {
      const pr = e.target.closest("[data-preset]"); if (pr) { applyPreset(+pr.dataset.preset); $("#ld-universe").innerHTML = universeHTML(); run(); return; }
      if (e.target.closest("#ld-filters")) { remember(); $("#ladder").classList.add("hidden"); const more = $("details.more"); more.setAttribute("open", ""); more.scrollIntoView({ behavior: "smooth", block: "start" }); $("#filter-close").dataset.returnTo = "ladder"; }
    });
  }
  $("#btn-ladder").addEventListener("click", openLadder);

  window.BondSim = { simulate, mountSim, buildLadder, openLadder, VERSION: "0.3.0" };
})();
