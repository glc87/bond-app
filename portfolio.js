/* portfolio.js — v0.2.1 — Portafoglio, zainetto fiscale, calendario cedole (dati salvati sul dispositivo) */
(() => {
  "use strict";
  const A = window.BondApp;             // helper esposti da app.js
  const { $, fmtPct, fmtNum, fmtCur, fmtDate, esc, params } = A;
  const KEY = "bond-portfolio-v1";
  const DAY = 86400000;
  const uid = () => Math.random().toString(36).slice(2, 10);

  let pf = load();
  function load() {
    try { const d = JSON.parse(localStorage.getItem(KEY) || "{}"); return { positions: d.positions || [], minus: d.minus || [], sales: d.sales || [] }; }
    catch { return { positions: [], minus: [], sales: [] }; }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(pf)); } catch {} }

  const bond = isin => A.state.bonds.find(b => b.isin === isin);
  const todayISO = () => A.state.meta ? A.state.meta.trade_date : new Date().toISOString().slice(0, 10);

  // ---------- valutazione di una posizione ----------
  function evalPosition(p) {
    const b = bond(p.isin);
    if (!b) return { p, b: null, error: "titolo non presente nei dati" };
    if (!b.computable) return { p, b, error: b.not_computable_reason || "rendimento non calcolabile per questo tipo di titolo" };
    const N = p.nominal, cur = b.currency;
    const cp = { ...params(N), commissionPct: 0, commissionMin: p.commission || 0, commissionMax: p.commission || 0 };   // commissioni = quelle pagate davvero
    const atBuy = Yields.compute(b, { price: p.price, priceSource: "user", tradeDate: Yields.parseISO(p.date), ...cp });
    const now = Yields.compute(b, { price: b._price, priceSource: b.price.source, tradeDate: Yields.parseISO(todayISO()), ...cp });
    const today = Yields.parseISO(todayISO());
    const received = (atBuy.coupon_dates || []).filter(d => Yields.parseISO(d) <= today);
    const couponsReceived = received.length * atBuy.coupon_net_per_period / 100 * N;
    const cost = atBuy.cost_total_eur;                       // prezzo + rateo netto + commissioni
    const valueNow = (b._price + now.accrued_net) / 100 * N;  // tel quel netto, al prezzo usato oggi
    const unrealized = (b._price - p.price) / 100 * N;        // plus/minus latente sul corso secco
    const tax = atBuy.tax_rate;
    const gainAtMaturity = (100 - p.price) / 100 * N;         // >0 plus (tassata), <0 minus (zainetto)
    const minusAtMaturity = Math.max(0, -gainAtMaturity);
    const matYear = parseInt(b.maturity.slice(0, 4), 10);
    return { p, b, cur, atBuy, now, cost, valueNow, unrealized, couponsReceived, nReceived: received.length,
      remainingCoupons: (atBuy.coupon_dates || []).length - received.length, tax, minusAtMaturity, matYear,
      totalNetIfHeld: atBuy.net_gain_total_eur, pnlNow: valueNow + couponsReceived - cost };
  }

  // ---------- zainetto ----------
  function minusEntries() {
    const y0 = new Date().getFullYear();
    const manual = pf.minus.map(m => ({ ...m, kind: "manual", expiry: m.year + 4, active: m.year + 4 >= y0 }));
    const projected = pf.positions.map(evalPosition).filter(e => !e.error && e.minusAtMaturity > 0)
      .map(e => ({ id: "proj-" + e.p.id, amount: e.minusAtMaturity, year: e.matYear, kind: "projected", expiry: e.matYear + 4, active: true, label: e.b.name, cur: e.cur }));
    return { manual, projected };
  }

  // ---------- UI ----------
  function open() {
    const evals = pf.positions.map(evalPosition);
    const ok = evals.filter(e => !e.error);
    const byCur = {};
    for (const e of ok) { const c = byCur[e.cur] || (byCur[e.cur] = { cost: 0, value: 0, coupons: 0, pnl: 0, n: 0, wy: 0 }); c.cost += e.cost; c.value += e.valueNow; c.coupons += e.couponsReceived; c.pnl += e.pnlNow; c.n++; c.wy += (e.atBuy.ytm_net_all || 0) * e.cost; }
    const kpis = Object.entries(byCur).map(([cur, c]) => `
      <div class="kpi"><div class="l">Investito (${cur})</div><div class="v">${fmtCur(c.cost, cur)}</div></div>
      <div class="kpi"><div class="l">Valore oggi + cedole incassate</div><div class="v">${fmtCur(c.value + c.coupons, cur)}</div></div>
      <div class="kpi"><div class="l">Risultato netto a oggi</div><div class="v ${c.pnl >= 0 ? "good" : ""}">${fmtCur(c.pnl, cur)}</div></div>
      <div class="kpi"><div class="l">YTM netto all-in medio (bloccato all'acquisto)</div><div class="v good">${fmtPct(c.cost ? c.wy / c.cost : null)}</div></div>`).join("");

    const rows = evals.map(e => e.error
      ? `<div class="card pos"><div class="c-name"><div class="name">${esc(e.p.isin)}</div><div class="meta"><span class="ko">${esc(e.error)}</span></div></div><div class="pos-actions"><button class="link" data-pf-del="${e.p.id}">elimina</button></div></div>`
      : `<div class="card pos" data-isin="${e.b.isin}">
          <div class="c-name"><div class="name">${esc(e.b.name)}</div>
            <div class="meta"><span>${fmtCur(e.p.nominal, e.cur)} nominali</span><span>carico ${fmtNum(e.p.price)} il ${fmtDate(e.p.date)}</span><span>oggi ${fmtNum(e.b._price)} ${A.priceBadge(e.b)}</span></div>
            <div class="meta"><span>costo ${fmtCur(e.cost, e.cur)}</span><span>cedole incassate ${e.nReceived} (${fmtCur(e.couponsReceived, e.cur)})</span><span>latente ${e.unrealized >= 0 ? "+" : ""}${fmtCur(e.unrealized, e.cur)}</span>
              ${e.minusAtMaturity > 0 ? `<span class="ko">minus a scadenza ${fmtCur(e.minusAtMaturity, e.cur)}</span>` : `<span>guadagno netto a scadenza ${fmtCur(e.totalNetIfHeld, e.cur)}</span>`}</div></div>
          <div class="c-net"><div class="main">${fmtPct(e.atBuy.ytm_net_all)}</div><div class="small">netto all-in dal carico</div>
            <div class="pos-actions"><button class="link" data-pf-sell="${e.p.id}">vendi</button> · <button class="link" data-pf-edit="${e.p.id}">modifica</button> · <button class="link" data-pf-del="${e.p.id}">elimina</button></div></div>
        </div>`).join("") || `<p class="hint">Nessuna posizione. Aggiungi un titolo con il modulo qui sotto, oppure dal pulsante "Aggiungi al portafoglio" nella scheda di un titolo.</p>`;

    // calendario cedole 12 mesi
    const today = Yields.parseISO(todayISO()), horizon = today + 365 * DAY;
    const events = [];
    for (const e of ok) {
      for (const d of e.atBuy.coupon_dates || []) { const t = Yields.parseISO(d); if (t > today && t <= horizon) events.push({ d, name: e.b.name, amt: e.atBuy.coupon_net_per_period / 100 * e.p.nominal, cur: e.cur, kind: "cedola" }); }
      const m = Yields.parseISO(e.b.maturity); if (m > today && m <= horizon) events.push({ d: e.b.maturity, name: e.b.name, amt: e.atBuy.redemption_net_eur, cur: e.cur, kind: "rimborso" });
    }
    events.sort((a, b) => a.d.localeCompare(b.d));
    const cal = events.length ? `<table class="kv">${events.map(ev => `<tr><td>${fmtDate(ev.d)} · ${esc(ev.name)} <span class="small">(${ev.kind})</span></td><td>${fmtCur(ev.amt, ev.cur)}</td></tr>`).join("")}
      <tr><td><b>Totale 12 mesi</b></td><td><b>${Object.entries(events.reduce((a, ev) => (a[ev.cur] = (a[ev.cur] || 0) + ev.amt, a), {})).map(([c, v]) => fmtCur(v, c)).join(" + ")}</b></td></tr></table>` : `<p class="hint">Nessuna cedola o rimborso nei prossimi 12 mesi.</p>`;

    // zainetto
    const { manual, projected } = minusEntries();
    const y0 = new Date().getFullYear();
    const activeTotal = manual.filter(m => m.active).reduce((s, m) => s + m.amount, 0);
    const expiring = manual.filter(m => m.active && m.expiry === y0);
    const zain = `
      <div class="kpis"><div class="kpi"><div class="l">Minusvalenze attive (inserite da te)</div><div class="v">${fmtCur(activeTotal, "EUR")}</div></div>
        <div class="kpi"><div class="l">In scadenza entro il 31/12/${y0}</div><div class="v ${expiring.length ? "ko" : ""}">${fmtCur(expiring.reduce((s, m) => s + m.amount, 0), "EUR")}</div></div></div>
      ${manual.length ? `<table class="kv">${manual.sort((a, b) => a.year - b.year).map(m => `<tr><td>${esc(m.label || "minusvalenza")} · realizzata nel ${m.year} · utilizzabile fino al 31/12/${m.expiry} ${m.active ? "" : '<span class="ko">(scaduta)</span>'}</td><td>${fmtCur(m.amount, "EUR")} <button class="link" data-minus-del="${m.id}">✕</button></td></tr>`).join("")}</table>` : ""}
      ${projected.length ? `<h4 class="sub">Previste a scadenza dai titoli in portafoglio comprati sopra 100</h4><table class="kv">${projected.map(m => `<tr><td>${esc(m.label)} · ${m.year}, utilizzabile fino al ${m.expiry}</td><td>${fmtCur(m.amount, m.cur)}</td></tr>`).join("")}</table>` : ""}
      <form id="minus-form" class="inline-form">
        <input name="label" placeholder="descrizione (es. vendita ETF)" style="flex:2"><input name="amount" type="number" step="any" min="0" placeholder="importo €" required><input name="year" type="number" min="2015" max="2100" value="${y0}" required>
        <button class="btn" type="submit">Aggiungi minus</button></form>
      <p class="hint">Le minusvalenze (redditi diversi) si compensano con plusvalenze su azioni, obbligazioni, certificati, non con cedole né con ETF/fondi; valgono nell'anno di realizzo e nei 4 successivi. Inserisci qui quelle del tuo estratto conto fiscale.</p>`;

    $("#pf-body").innerHTML = `
      <div class="kpis">${kpis || `<div class="kpi"><div class="l">Portafoglio vuoto</div><div class="v">–</div></div>`}</div>
      <h3>Posizioni</h3><div class="list">${rows}</div>
      <h3>Aggiungi posizione</h3>
      <form id="pos-form" class="inline-form">
        <input type="hidden" name="posid">
        <input name="isin" list="isin-list" placeholder="ISIN o nome" required style="flex:2" autocomplete="off"><datalist id="isin-list"></datalist>
        <input name="nominal" type="number" step="any" min="1" placeholder="nominale" required>
        <input name="price" type="number" step="any" min="0.01" placeholder="prezzo di carico" required>
        <input name="date" type="date" required max="${todayISO()}">
        <input name="commission" type="number" step="any" min="0" placeholder="commissioni pagate">
        <button class="btn" type="submit">Salva</button></form>
      <div id="sell-box" class="hidden"><h3>Vendita</h3>
        <form id="sell-form" class="inline-form"><input type="hidden" name="posid"><span id="sell-title" class="hint" style="flex-basis:100%"></span>
          <input name="nominal" type="number" step="any" min="1" placeholder="nominale venduto" required>
          <input name="price" type="number" step="any" min="0.01" placeholder="prezzo di vendita" required>
          <input name="date" type="date" required max="${todayISO()}">
          <input name="commission" type="number" step="any" min="0" placeholder="commissioni">
          <button class="btn" type="submit">Registra vendita</button> <button class="btn ghost" type="button" id="sell-cancel">Annulla</button></form></div>
      ${salesHTML()}
      <h3>Cedole e rimborsi nei prossimi 12 mesi (netti)</h3>${cal}
      <h3>Zainetto fiscale</h3>${zain}
      <h3>Backup</h3><div class="row"><button class="btn ghost" id="pf-export">Esporta</button><label class="btn ghost">Importa <input type="file" id="pf-import" accept="application/json" hidden></label></div>
      <p class="hint">I dati del portafoglio restano solo su questo dispositivo. Esporta un backup prima di cambiare telefono o cancellare i dati del browser.</p>`;

    // datalist titoli
    const dl = $("#isin-list"); const frag = document.createDocumentFragment();
    for (const b of A.state.bonds) { const o = document.createElement("option"); o.value = b.isin; o.label = b.name; frag.appendChild(o); }
    dl.appendChild(frag);
    $("#portfolio").classList.remove("hidden");
  }

  function salesHTML() {
    if (!pf.sales.length) return "";
    const rows = pf.sales.slice().sort((a, b) => b.date.localeCompare(a.date)).map(sl => {
      const b = bond(sl.isin); const cur = b ? b.currency : "EUR";
      return `<tr><td>${fmtDate(sl.date)} · ${esc(b ? b.name : sl.isin)} · ${fmtCur(sl.nominal, cur)} a ${fmtNum(sl.price)} (carico ${fmtNum(sl.buyPrice)})</td>
        <td class="${sl.realized >= 0 ? "ok" : "ko"}">${sl.realized >= 0 ? "+" : ""}${fmtCur(sl.realized, cur)}${sl.realized >= 0 ? ` <span class="small">tassa ${fmtCur(sl.tax, cur)}</span>` : " <span class=\"small\">→ zainetto</span>"} <button class="link" data-sale-del="${sl.id}">✕</button></td></tr>`; }).join("");
    return `<h3>Vendite realizzate</h3><table class="kv">${rows}</table><p class="hint">Plus/minus sul corso secco, al netto delle commissioni. Le plusvalenze sono tassate (o compensate con lo zainetto, se capiente); le minusvalenze vengono aggiunte automaticamente allo zainetto.</p>`;
  }

  function registerSale(f) {
    const p = pf.positions.find(x => x.id === f.elements.posid.value); if (!p) return;
    const b = bond(p.isin); const nom = parseFloat(f.nominal.value), price = parseFloat(f.price.value), comm = parseFloat(f.commission.value) || 0;
    if (nom > p.nominal + 1e-9) { alert(`Puoi vendere al massimo ${p.nominal}.`); return; }
    const share = nom / p.nominal;
    const realized = (price - p.price) / 100 * nom - comm - (p.commission || 0) * share;   // redditi diversi: prezzo - carico, al netto costi
    const taxRate = b ? ((b.tax_rate <= 0.125001 ? (A.state.settings.taxGov ?? 12.5) : (A.state.settings.taxOther ?? 26)) / 100) : 0.26;
    const tax = realized > 0 ? realized * taxRate : 0;
    const sale = { id: uid(), posId: p.id, isin: p.isin, nominal: nom, price, date: f.date.value, commission: comm, buyPrice: p.price, realized, tax };
    pf.sales.push(sale);
    if (realized < 0) pf.minus.push({ id: "sale-" + sale.id, label: `vendita ${b ? b.name : p.isin}`, amount: -realized, year: parseInt(sale.date.slice(0, 4), 10) });
    p.nominal -= nom; p.commission = (p.commission || 0) * (1 - share);
    if (p.nominal <= 1e-9) pf.positions = pf.positions.filter(x => x.id !== p.id);
    save(); open();
  }

  function prefill(p) {
    const f = $("#pos-form"); if (!f) return;
    f.elements.posid.value = p.id || ""; f.isin.value = p.isin || ""; f.nominal.value = p.nominal || ""; f.price.value = p.price || ""; f.date.value = p.date || todayISO(); f.commission.value = p.commission ?? "";
    f.scrollIntoView({ behavior: "smooth", block: "center" }); f.nominal.focus();
  }

  // ---------- eventi ----------
  document.addEventListener("submit", e => {
    if (e.target.getAttribute("id") === "pos-form") {
      e.preventDefault(); const f = e.target;
      let isin = f.isin.value.trim().toUpperCase();
      if (!bond(isin)) { const m = A.state.bonds.find(b => b.name.toUpperCase().includes(isin)); if (m) isin = m.isin; }
      if (!bond(isin)) { alert("Titolo non trovato nei dati di oggi."); return; }
      const bb = bond(isin); const nom = parseFloat(f.nominal.value);
      if (bb.min_lot && (nom < bb.min_lot || Math.abs(nom / bb.min_lot - Math.round(nom / bb.min_lot)) > 1e-9) && !confirm(`Il lotto minimo di questo titolo è ${fmtCur(bb.min_lot, bb.currency)} e multipli. Salvare comunque ${nom}?`)) return;
      const pos = { id: f.elements.posid.value || uid(), isin, nominal: parseFloat(f.nominal.value), price: parseFloat(f.price.value), date: f.date.value, commission: parseFloat(f.commission.value) || 0 };
      const i = pf.positions.findIndex(p => p.id === pos.id); if (i >= 0) pf.positions[i] = pos; else pf.positions.push(pos);
      save(); open();
    }
    if (e.target.getAttribute("id") === "sell-form") { e.preventDefault(); registerSale(e.target); }
    if (e.target.getAttribute("id") === "minus-form") {
      e.preventDefault(); const f = e.target;
      pf.minus.push({ id: uid(), label: f.label.value.trim(), amount: parseFloat(f.amount.value), year: parseInt(f.year.value, 10) }); save(); open();
    }
  });
  document.addEventListener("click", e => {
    const del = e.target.closest("[data-pf-del]"); if (del) { if (confirm("Eliminare la posizione?")) { pf.positions = pf.positions.filter(p => p.id !== del.dataset.pfDel); save(); open(); } return; }
    const ed = e.target.closest("[data-pf-edit]"); if (ed) { prefill(pf.positions.find(p => p.id === ed.dataset.pfEdit) || {}); return; }
    const sl = e.target.closest("[data-pf-sell]"); if (sl) { const p = pf.positions.find(x => x.id === sl.dataset.pfSell); const b = bond(p.isin);
      $("#sell-box").classList.remove("hidden"); const f = $("#sell-form"); f.elements.posid.value = p.id; f.nominal.value = p.nominal; f.price.value = b ? b._price : ""; f.date.value = todayISO(); f.commission.value = "";
      $("#sell-title").textContent = `${b ? b.name : p.isin} — in portafoglio ${p.nominal} nominali a ${fmtNum(p.price)}`; f.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    if (e.target.id === "sell-cancel") { $("#sell-box").classList.add("hidden"); return; }
    const sd = e.target.closest("[data-sale-del]"); if (sd) { if (confirm("Eliminare la vendita? La posizione NON viene ripristinata e l'eventuale minus resta nello zainetto (eliminala a parte).")) { pf.sales = pf.sales.filter(x => x.id !== sd.dataset.saleDel); save(); open(); } return; }
    const md = e.target.closest("[data-minus-del]"); if (md) { pf.minus = pf.minus.filter(m => m.id !== md.dataset.minusDel); save(); open(); return; }
    const add = e.target.closest("[data-pf-add]"); if (add) { const b = bond(add.dataset.pfAdd); $("#detail").classList.add("hidden"); open(); prefill({ isin: b.isin, price: b._price, nominal: Math.max(A.state.settings.nominal, b.min_lot || 0) }); return; }
    if (e.target.id === "pf-export") {
      const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), ...pf }, null, 1)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `bond-portafoglio-${todayISO()}.json`; a.click(); URL.revokeObjectURL(a.href);
    }
  });
  document.addEventListener("change", e => {
    if (e.target.id === "pf-import" && e.target.files[0]) {
      const r = new FileReader(); r.onload = () => { try { const d = JSON.parse(r.result); if (!Array.isArray(d.positions)) throw 0; pf = { positions: d.positions, minus: d.minus || [], sales: d.sales || [] }; save(); open(); } catch { alert("File non valido."); } }; r.readAsText(e.target.files[0]);
    }
  });
  $("#btn-pf").addEventListener("click", open);
  window.BondPortfolio = { open, count: () => pf.positions.length };
})();
