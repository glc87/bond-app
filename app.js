/* app.js — v0.3.2 — Bond Netto (PWA) */
(() => {
  "use strict";
  const $ = s => document.querySelector(s);
  const DEFAULTS = { nominal: 10000, commissionPct: 0.19, commissionMin: 5, commissionMax: 19, bolloRate: 0.2 }; // Fineco min 2,95 / ING min 8: via di mezzo
  const PAGE = 60;
  const fmtPct = v => v == null || !isFinite(v) ? "n.d." : (v * 100).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%";
  const fmtNum = (v, d = 2) => v == null ? "–" : v.toLocaleString("it-IT", { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtEur = v => v == null ? "–" : v.toLocaleString("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  const fmtDate = s => s ? new Date(s).toLocaleDateString("it-IT") : "–";
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const state = { meta: null, bonds: [], settings: loadSettings(), cat: "all", shown: PAGE, filtered: [], compare: new Set() };

  function loadSettings() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("bond-settings") || "{}") }; } catch { return { ...DEFAULTS }; }
  }
  function saveSettings(s) { try { localStorage.setItem("bond-settings", JSON.stringify(s)); } catch {} }

  function params(nominal) {
    const s = state.settings;
    return { commissionPct: s.commissionPct / 100, commissionMin: s.commissionMin, commissionMax: (s.commissionMax === "" || s.commissionMax == null) ? null : s.commissionMax,
      bolloRate: s.bolloRate / 100, nominal: nominal ?? s.nominal };
  }

  function category(b) {
    const t = (b.tipologia || "").toLowerCase();
    if (t === "titoli di stato italiani") return "gov_it";
    if (t === "titoli di stato esteri") return "gov_fx";
    if ((b.tax_reason || "").includes("sovranazionale")) return "supra";
    return "other";
  }
  const CAT_LABEL = { gov_it: "Stato Italia", gov_fx: "Stato estero", supra: "Sovranazionale", other: "Corporate/altro" };
  const KIND_LABEL = { fixed: "tasso fisso", zero: "zero coupon", floating: "tasso variabile", inflation: "indicizzato inflazione", stepup: "step-up/strutturato", callable: "callable", unknown: "altro" };
  const FREQ_LABEL = { 1: "annuale", 2: "semestrale", 4: "trimestrale", 12: "mensile" };

  function recompute() {
    const trade = Yields.parseISO(state.meta.trade_date);
    for (const b of state.bonds) {
      b._cat = category(b);
      b._years = b.maturity ? (Yields.parseISO(b.maturity) - trade) / 86400000 / 365 : null;
      b._price = b.price && b.price.used;
      b._calc = (b.computable && b._price) ? Yields.compute(b, { price: b._price, priceSource: b.price.source, tradeDate: trade, ...params() }) : null;
    }
  }

  function applyFilters() {
    const q = $("#q").value.trim().toLowerCase();
    const cur = $("#f-cur").value, country = $("#f-country").value, kind = $("#f-kind").value;
    const ymin = parseFloat($("#f-ymin").value), ymax = parseFloat($("#f-ymax").value), nmin = parseFloat($("#f-nmin").value), lot = parseFloat($("#f-lot").value);
    const onlyAsk = $("#f-ask").checked, noMinus = $("#f-nominus").checked, onlyReliable = $("#f-reliable").checked;
    let n = 0;
    state.filtered = state.bonds.filter(b => {
      if (state.cat !== "all" && b._cat !== state.cat) return false;
      if (q && !(`${b.name} ${b.isin} ${b.issuer}`.toLowerCase().includes(q))) return false;
      if (cur && b.currency !== cur) return false;
      if (country && b.country !== country) return false;
      if (kind === "computable" && !b._calc) return false;
      if ((kind === "fixed" || kind === "zero") && !(b._calc && b.kind === kind)) return false;
      if (!isNaN(ymin) && b._years != null && b._years < ymin) return false;
      if (!isNaN(ymax) && b._years != null && b._years > ymax) return false;
      if (!isNaN(nmin) && !(b._calc && b._calc.ytm_net_all != null && b._calc.ytm_net_all * 100 >= nmin)) return false;
      if (!isNaN(lot) && b.min_lot != null && b.min_lot > lot) return false;
      if (onlyAsk && b.price.source !== "ask") return false;
      if (onlyReliable && quality(b) === "stale") return false;
      if (noMinus && b._price > 100) return false;
      return true;
    });
    [cur && cur !== "EUR" ? cur : "", country, kind !== "computable" ? kind : "", !isNaN(ymax) ? 1 : "", !isNaN(nmin) ? 1 : "", !isNaN(lot) ? 1 : "", onlyAsk ? 1 : "", noMinus ? 1 : "", onlyReliable ? "" : 1, (!isNaN(ymin) && ymin !== 1) ? 1 : ""].forEach(v => { if (v) n++; });
    $("#filter-count").textContent = n ? `(${n} attivi)` : "";
    sortList();
    state.shown = PAGE;
    render();
  }

  function sortList() {
    const [key, dir] = $("#sort").value.split(":");
    const sgn = dir === "asc" ? 1 : -1;
    const val = b => {
      switch (key) {
        case "years": return b._years;
        case "price": return b._price;
        case "coupon": return b.coupon_annual;
        case "name": return b.name;
        default: return b._calc ? b._calc[key] : null;
      }
    };
    state.filtered.sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1; if (vb == null) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * sgn;
    });
  }

  function quality(b) {
    const q = b.price.quality;
    if (q) return q;
    // dati senza il campo (run precedenti al 05/11/2026): ask -> affidabile; scambiato oggi -> ok; altrimenti fermo
    return b.price.source === "ask" ? "ask" : (b.price.last_time ? "traded" : "stale");
  }
  const QUALITY_LABEL = { ask: "ask", traded: "rif · scambiato oggi", quiet: "rif · non scambiato oggi", stale: "prezzo fermo" };
  function reliable(b) { const q = quality(b); return q === "ask" || q === "traded"; }
  function priceBadge(b) {
    const q = quality(b);
    const cls = q === "ask" ? "ask" : q === "stale" ? "stale" : "ref";
    return `<span class="badge ${cls}" title="${QUALITY_LABEL[q]}">${q === "ask" ? "ask" : q === "stale" ? "fermo" : "rif"}</span>`;
  }

  function cardHTML(b) {
    const c = b._calc;
    const cpn = b.kind === "zero" ? "zero coupon" : (b.coupon_annual != null ? `${fmtNum(b.coupon_annual)}% ${FREQ_LABEL[b.coupon_frequency] || ""}` : KIND_LABEL[b.kind]);
    const minus = b._price > 100 ? '<span class="badge warn">sopra 100</span>' : "";
    const sel = state.compare.has(b.isin);
    return `<div class="card ${sel ? "sel" : ""}" data-isin="${b.isin}">
      <label class="cmp" title="Aggiungi al confronto"><input type="checkbox" data-cmp="${b.isin}" ${sel ? "checked" : ""}></label>
      <div class="c-name"><div class="name">${esc(b.name)} ${minus}</div>
        <div class="meta"><span>${esc(b.isin)}</span><span>${CAT_LABEL[b._cat]}</span><span>${esc(b.country)}</span>${b.min_lot && b.min_lot > 1000 ? `<span>lotto ${fmtEur(b.min_lot)}</span>` : ""}</div></div>
      <div class="c-mat"><span class="lbl">Scad.</span>${fmtDate(b.maturity)} <span class="small">(${b._years != null ? fmtNum(b._years, 1) : "–"} a.)</span></div>
      <div class="c-cpn"><span class="lbl">Cedola</span>${cpn}</div>
      <div class="c-price"><span class="lbl">Prezzo</span>${fmtNum(b._price, 2)} ${priceBadge(b)} <span class="badge cur">${esc(b.currency)}</span></div>
      <div class="c-net">${c ? `<div class="main">${fmtPct(c.ytm_net_all)}</div><div class="small">netto all-in</div>` : `<div class="main na">n.d.</div><div class="small">${esc(b.not_computable_reason || KIND_LABEL[b.kind])}</div>`}</div>
      <div class="c-ytm">${c ? `<div><span class="lbl">Lordo</span>${fmtPct(c.ytm_gross)}</div><div><span class="lbl">Semplice</span>${fmtPct(c.simple_net_all)}</div>` : ""}</div>
    </div>`;
  }

  function render() {
    const list = $("#list");
    const slice = state.filtered.slice(0, state.shown);
    list.innerHTML = slice.map(cardHTML).join("") || '<p class="hint">Nessun titolo corrisponde ai filtri.</p>';
    $("#count").textContent = `${state.filtered.length} titoli`;
    $("#more-btn").classList.toggle("hidden", state.shown >= state.filtered.length);
    renderBest();
    renderCompareBar();
  }

  function renderCompareBar() {
    const n = state.compare.size;
    $("#cmp-bar").classList.toggle("hidden", n === 0);
    $("#cmp-count").textContent = n;
    $("#cmp-open").disabled = n < 2;
  }

  // ---------------- confronto ----------------
  function openCompare() {
    const bonds = [...state.compare].map(i => state.bonds.find(b => b.isin === i)).filter(Boolean);
    if (bonds.length < 2) return;
    const nominal = state.settings.nominal;
    const calcs = bonds.map(b => b._calc ? Yields.compute(b, { price: b._price, priceSource: b.price.source, tradeDate: Yields.parseISO(state.meta.trade_date), ...params(Math.max(nominal, b.min_lot || 0)) }) : null);
    const rows = [
      ["Scadenza", b => `${fmtDate(b.maturity)}<br><span class="small">${fmtNum(b._years, 1)} anni</span>`],
      ["Cedola", b => b.kind === "zero" ? "zero coupon" : `${fmtNum(b.coupon_annual)}% ${FREQ_LABEL[b.coupon_frequency] || ""}`],
      ["Prezzo", b => `${fmtNum(b._price)} ${priceBadge(b)} <span class="badge cur">${esc(b.currency)}</span>`],
      ["Aliquota", b => `${fmtNum(b.tax_rate * 100, 1)}%`],
      ["Netto annuo (all-in)", (b, c) => c ? `<b class="ok">${fmtPct(c.simple_net_all)}</b>` : "n.d."],
      ["YTM netto all-in", (b, c) => c ? fmtPct(c.ytm_net_all) : "n.d."],
      ["YTM netto (solo tasse)", (b, c) => c ? fmtPct(c.ytm_net_tax) : "n.d."],
      ["YTM lordo", (b, c) => c ? fmtPct(c.ytm_gross) : "n.d."],
      ["Rendimento immediato", (b, c) => c && b.kind !== "zero" ? fmtPct(c.current_yield_gross) : "–"],
      ["Esborso oggi", (b, c) => c ? `${fmtEur(c.cost_total_eur)}<br><span class="small">su ${fmtEur(c.nominal)} nominali</span>` : "–"],
      ["Cedole nette totali", (b, c) => c ? fmtEur(c.coupons_net_total_eur) : "–"],
      ["Guadagno netto a scadenza", (b, c) => c ? `<b>${fmtEur(c.net_gain_total_eur)}</b>` : "–"],
      ["Minusvalenza a scadenza", (b, c) => c && c.minus_eur > 0 ? `<span class="ko">${fmtEur(c.minus_eur)}</span>` : "–"],
      ["Duration modificata (BI)", b => fmtNum(b.bi.mod_duration)],
      ["Lotto minimo", b => fmtEur(b.min_lot)],
    ];
    $("#cmp-body").innerHTML = `<div class="cmp-scroll"><table class="cmp"><thead><tr><th></th>${bonds.map(b => `<th><div class="name">${esc(b.name)}</div><div class="small">${esc(b.isin)}</div><button class="link" data-isin="${b.isin}">scheda</button> · <button class="link" data-uncmp="${b.isin}">togli</button></th>`).join("")}</tr></thead>
      <tbody>${rows.map(([l, f]) => `<tr><td>${l}</td>${bonds.map((b, i) => `<td>${f(b, calcs[i])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      <p class="hint">Importi calcolati sul nominale di riferimento delle Impostazioni (o sul lotto minimo se maggiore).</p>`;
    $("#compare").classList.remove("hidden");
  }
  $("#cmp-open").addEventListener("click", openCompare);
  $("#cmp-clear").addEventListener("click", () => { state.compare.clear(); render(); });
  document.addEventListener("change", e => {
    const cb = e.target.closest("[data-cmp]"); if (!cb) return;
    if (cb.checked) { if (state.compare.size >= 4) { cb.checked = false; alert("Puoi confrontare al massimo 4 titoli."); return; } state.compare.add(cb.dataset.cmp); }
    else state.compare.delete(cb.dataset.cmp);
    cb.closest(".card").classList.toggle("sel", cb.checked); renderCompareBar();
  });
  document.addEventListener("click", e => {
    const u = e.target.closest("[data-uncmp]"); if (!u) return;
    state.compare.delete(u.dataset.uncmp); render();
    if (state.compare.size >= 2) openCompare(); else $("#compare").classList.add("hidden");
  });

  function renderBest() {
    const buckets = [["Fino a 2 anni", 0, 2], ["2–5 anni", 2, 5], ["5–10 anni", 5, 10], ["10–20 anni", 10, 20], ["Oltre 20 anni", 20, 1e9]];
    const pool = state.filtered.filter(b => b._calc && b._calc.ytm_net_all != null && reliable(b));
    $("#best").innerHTML = buckets.map(([label, lo, hi]) => {
      const top = pool.filter(b => b._years >= lo && b._years < hi).sort((a, b) => b._calc.ytm_net_all - a._calc.ytm_net_all).slice(0, 3);
      if (!top.length) return "";
      return `<div class="bucket"><h4>${label}</h4>${top.map(b => `<div class="b-row" data-isin="${b.isin}"><span title="${esc(b.name)}">${esc(b.name)}</span><b>${fmtPct(b._calc.ytm_net_all)}</b></div>`).join("")}</div>`;
    }).join("");
  }

  // ---------------- scheda titolo ----------------
  function openDetail(isin) {
    const b = state.bonds.find(x => x.isin === isin); if (!b) return;
    $("#d-name").textContent = b.name;
    $("#d-sub").textContent = `${b.isin} · ${b.issuer} · ${CAT_LABEL[b._cat]} · ${KIND_LABEL[b.kind]}`;
    const nominalDefault = Math.max(state.settings.nominal, b.min_lot || 0);
    $("#d-body").innerHTML = detailHTML(b, nominalDefault);
    $("#detail").classList.remove("hidden");
    loadChart(b);
    const inp = $("#d-amount");
    if (inp) inp.addEventListener("input", () => { const n = parseFloat(inp.value); if (n > 0) $("#d-calc").innerHTML = calcHTML(b, n); });
  }

  function detailHTML(b, nominal) {
    const p = b.price, bi = b.bi, ck = b.check || {};
    const rows = [
      ["Prezzo usato", `${fmtNum(b._price)} ${priceBadge(b)}`], ["Ask / Bid", `${fmtNum(p.ask)} (${fmtNum(p.ask_qty, 0)}) / ${fmtNum(p.bid)} (${fmtNum(p.bid_qty, 0)})`],
      ["Prezzo di riferimento", `${fmtNum(p.ref)} del ${fmtDate(p.ref_date)}`], ["Ultimo contratto", `${fmtNum(p.last)} ${esc(p.last_time || "")}`],
      ["Scambi oggi", p.n_trades_today != null ? `${fmtNum(p.n_trades_today, 0)} contratti, ${fmtEur(p.volume_today)} nominali` : "–"], ["Min / max anno", p.year_high != null ? `${fmtNum(p.year_low)} / ${fmtNum(p.year_high)}` : "nessuno scambio nell'anno"],
      ["Valuta", b.currency], ["Scadenza", `${fmtDate(b.maturity)} (${fmtNum(b._years, 2)} anni)`],
      ["Cedola", b.kind === "zero" ? "zero coupon" : `${fmtNum(b.coupon_annual)}% annuo, ${FREQ_LABEL[b.coupon_frequency] || b.coupon_frequency_label || "–"}`],
      ["Lotto minimo", fmtEur(b.min_lot)], ["Aliquota fiscale", `${fmtNum(b.tax_rate * 100, 1)}% (${esc(b.tax_reason)})`],
      ["Emesso", b.outstanding ? fmtEur(b.outstanding) : "–"], ["Subordinato", b.subordinated || "–"], ["Segmento", b.segment],
    ];
    const biRows = bi.yield_gross != null ? `<h3>Dati Borsa Italiana (prezzo di riferimento)</h3><table class="kv">
      <tr><td>YTM lordo BI / nostro sullo stesso prezzo</td><td>${fmtNum(bi.yield_gross)} / ${ck.ytm_gross_vs_bi != null ? fmtNum(bi.yield_gross + ck.ytm_gross_vs_bi) : "–"} <span class="${Math.abs(ck.ytm_gross_vs_bi || 0) < 0.05 ? "ok" : "ko"}">●</span></td></tr>
      <tr><td>YTM netto BI (non tassa la plusvalenza)</td><td>${fmtNum(bi.yield_net)}</td></tr>
      <tr><td>Rateo lordo BI</td><td>${fmtNum(bi.accrued_gross, 5)}</td></tr>
      <tr><td>Duration modificata</td><td>${fmtNum(bi.mod_duration)}</td></tr>
      <tr><td>Aliquota confermata dai dati BI</td><td class="${ck.tax_rate_confirmed === false ? "ko" : "ok"}">${ck.tax_rate_confirmed === false ? "NO, verificare" : ck.tax_rate_confirmed ? "sì" : "–"}</td></tr></table>` : "";
    const anomalies = (b.anomalies || []).length ? `<div class="note">⚠ ${b.anomalies.map(esc).join("<br>")}</div>` : "";
    const calc = b._calc ? `<div class="amount"><label>Importo nominale</label><input id="d-amount" type="number" step="${b.min_lot || 1000}" min="${b.min_lot || 1000}" value="${nominal}"> €</div>
      <div id="d-calc">${calcHTML(b, nominal)}</div>` : `<div class="note">Rendimento non calcolato: ${esc(b.not_computable_reason)}</div>`;
    return `${anomalies}${calc}<h3>Storico</h3><div id="d-chart" class="chart"><span class="hint">caricamento…</span></div><h3>Dati titolo</h3><table class="kv">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>${biRows}
      <p class="hint" style="margin-top:12px"><a href="${esc(b.scheda_url)}" target="_blank" rel="noopener">Scheda su Borsa Italiana ↗</a></p>`;
  }

  function calcHTML(b, nominal) {
    const c = Yields.compute(b, { price: b._price, priceSource: b.price.source, tradeDate: Yields.parseISO(state.meta.trade_date), ...params(nominal) });
    const minus = c.minus_eur > 0 ? `<div class="note">Prezzo sopra 100: a scadenza si genera una minusvalenza di ${fmtEur(c.minus_eur)} (credito fiscale compensabile con altre plusvalenze da "redditi diversi" entro i 4 anni successivi). Non è conteggiata nel rendimento.</div>` : "";
    const q = quality(b);
    const src = q === "stale" ? `<div class="note">⚠ <b>Prezzo fermo</b>: nessuna proposta in vendita e nessuno scambio nell'anno. Il prezzo di riferimento (${fmtNum(b.price.ref)}) è vecchio e il rendimento calcolato non è realistico: nessuno vende a questo prezzo.</div>`
      : q === "quiet" ? `<div class="note">Nessuna proposta in vendita nel book e nessuno scambio oggi: calcolo sul prezzo di riferimento, che potrebbe non essere aggiornato.</div>`
      : q === "traded" ? `<div class="note">Nessuna proposta in vendita nel book al momento della rilevazione: calcolo sul prezzo di riferimento (titolo scambiato oggi).</div>` : "";
    return `<div class="kpis">
      <div class="kpi"><div class="l">YTM netto all-in (tasse, commissioni, bollo)</div><div class="v good">${fmtPct(c.ytm_net_all)}</div></div>
      <div class="kpi"><div class="l">Netto annuo semplice (senza reinvestimento)</div><div class="v">${fmtPct(c.simple_net_all)}</div></div>
      <div class="kpi"><div class="l">YTM netto (solo tasse)</div><div class="v">${fmtPct(c.ytm_net_tax)}</div></div>
      <div class="kpi"><div class="l">YTM lordo</div><div class="v">${fmtPct(c.ytm_gross)}</div></div>
      <div class="kpi"><div class="l">Guadagno netto totale a scadenza</div><div class="v good">${fmtEur(c.net_gain_total_eur)}</div></div>
      ${b.kind !== "zero" ? `<div class="kpi"><div class="l">Rendimento immediato (cedola/prezzo)</div><div class="v">${fmtPct(c.current_yield_gross)}</div></div>` : ""}
    </div>${minus}${src}
    <h3>Flussi per ${fmtEur(nominal)} nominali</h3><table class="kv">
      <tr><td>Regolamento (T+2)</td><td>${fmtDate(c.settle_date)}</td></tr>
      <tr><td>Prezzo + rateo netto (${fmtNum(c.accrued_net, 3)})</td><td>${fmtEur(c.cost_total_eur - c.commission_eur)}</td></tr>
      <tr><td>Commissioni</td><td>${fmtEur(c.commission_eur)}</td></tr>
      <tr><td><b>Esborso oggi</b></td><td><b>${fmtEur(c.cost_total_eur)}</b></td></tr>
      <tr><td>Cedole nette (${c.n_coupons} × ${fmtEur(c.coupon_net_per_period / 100 * nominal)})${c.next_coupon_date ? `, prossima ${fmtDate(c.next_coupon_date)}` : ""}</td><td>${fmtEur(c.coupons_net_total_eur)}</td></tr>
      <tr><td>Rimborso netto (tassa su plusvalenza ${fmtEur(c.capital_gain_tax_eur)})</td><td>${fmtEur(c.redemption_net_eur)}</td></tr>
      <tr><td>Imposta di bollo stimata (totale)</td><td>−${fmtEur(c.bollo_total_eur)}</td></tr>
      <tr><td><b>Guadagno netto</b></td><td><b>${fmtEur(c.net_gain_total_eur)}</b></td></tr></table>`;
  }

  async function loadChart(b) {
    const el = $("#d-chart"); if (!el) return;
    let pts = [];
    try { const r = await fetch(`data/series/${b.isin}.json`, { cache: "no-cache" }); if (r.ok) pts = await r.json(); } catch {}
    if (!el.isConnected) return;
    pts = pts.filter(p => p[3] != null);
    if (pts.length < 2) { el.innerHTML = `<span class="hint">Lo storico si costruisce un punto al giorno dagli aggiornamenti: ${pts.length === 1 ? "oggi c'è il primo punto" : "disponibile dal prossimo aggiornamento"}.</span>`; return; }
    el.innerHTML = lineChart(pts);
  }

  function lineChart(pts) {
    const W = 640, H = 220, L = 44, R = 12, T = 12, B = 28;
    const series = [["YTM lordo", pts.map(p => p[2]), "var(--muted)"], ["YTM netto", pts.map(p => p[3]), "var(--accent)"], ["Netto annuo", pts.map(p => p[4]), "var(--good)"]];
    const all = series.flatMap(s => s[1]).filter(v => v != null);
    let lo = Math.min(...all), hi = Math.max(...all); const pad = Math.max((hi - lo) * 0.1, 0.0005); lo -= pad; hi += pad;
    const x = i => L + (W - L - R) * (pts.length === 1 ? 0.5 : i / (pts.length - 1));
    const y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    const ticks = 4; let grid = "";
    for (let k = 0; k <= ticks; k++) { const v = lo + (hi - lo) * k / ticks; grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${(v * 100).toFixed(2)}%</text>`; }
    const lines = series.map(([n, vals, col]) => `<polyline fill="none" stroke="${col}" stroke-width="2" points="${vals.map((v, i) => v == null ? null : `${x(i)},${y(v)}`).filter(Boolean).join(" ")}"/>`).join("");
    const first = pts[0][0], last = pts[pts.length - 1][0];
    const legend = series.map(([n, , col]) => `<span><i style="background:${col}"></i>${n}</span>`).join("");
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Storico rendimenti">${grid}${lines}
      <text x="${L}" y="${H - 8}" font-size="11" fill="var(--muted)">${fmtDate(first)}</text><text x="${W - R}" y="${H - 8}" text-anchor="end" font-size="11" fill="var(--muted)">${fmtDate(last)}</text></svg>
      <div class="legend">${legend}<span class="hint">${pts.length} rilevazioni</span></div>`;
  }

  // ---------------- impostazioni ----------------
  function openSettings() {
    const s = state.settings;
    $("#s-nominal").value = s.nominal; $("#s-pct").value = s.commissionPct; $("#s-min").value = s.commissionMin;
    $("#s-max").value = s.commissionMax ?? ""; $("#s-bollo").value = s.bolloRate;
    $("#settings").classList.remove("hidden");
  }
  $("#s-save").addEventListener("click", () => {
    const num = (id, d) => { const v = parseFloat($(id).value); return isNaN(v) ? d : v; };
    const maxv = $("#s-max").value.trim();
    state.settings = { nominal: num("#s-nominal", DEFAULTS.nominal), commissionPct: num("#s-pct", DEFAULTS.commissionPct), commissionMin: num("#s-min", DEFAULTS.commissionMin),
      commissionMax: maxv === "" ? null : parseFloat(maxv), bolloRate: num("#s-bollo", DEFAULTS.bolloRate) };
    saveSettings(state.settings); $("#settings").classList.add("hidden"); recompute(); applyFilters();
  });
  // Profili commissioni verificati il 04/11/2026 (fonti: finecobank.com, qualebanca.com, finanzadigitale.com)
  const PROFILES = {
    fineco: { commissionPct: 0.19, commissionMin: 2.95, commissionMax: 19 },
    ing: { commissionPct: 0.19, commissionMin: 8, commissionMax: 18 },
    directa: { commissionPct: 0, commissionMin: 5, commissionMax: 5 },
    mediolanum: { commissionPct: 0.19, commissionMin: 7, commissionMax: 29 },
    sella: { commissionPct: 0.185, commissionMin: 2.5, commissionMax: 12 },
  };
  $("#s-profile").addEventListener("change", e => {
    const pr = PROFILES[e.target.value]; if (!pr) return;
    $("#s-pct").value = pr.commissionPct; $("#s-min").value = pr.commissionMin; $("#s-max").value = pr.commissionMax;
  });
  ["#s-pct", "#s-min", "#s-max"].forEach(id => $(id).addEventListener("input", () => { $("#s-profile").value = ""; }));
  $("#s-reset").addEventListener("click", () => { state.settings = { ...DEFAULTS }; saveSettings(state.settings); openSettings(); });

  // ---------------- eventi ----------------
  $("#btn-settings").addEventListener("click", openSettings);
  document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", e => e.target.closest(".modal").classList.add("hidden")));
  document.querySelectorAll(".modal").forEach(m => m.addEventListener("click", e => { if (e.target === m) m.classList.add("hidden"); }));
  document.addEventListener("keydown", e => { if (e.key === "Escape") document.querySelectorAll(".modal").forEach(m => m.classList.add("hidden")); });
  document.addEventListener("click", e => { if (e.target.closest(".cmp")) return; const el = e.target.closest("[data-isin]"); if (el) openDetail(el.dataset.isin); });
  $("#cat-chips").addEventListener("click", e => { const c = e.target.closest(".chip"); if (!c) return;
    document.querySelectorAll(".chip").forEach(x => x.classList.toggle("on", x === c)); state.cat = c.dataset.cat; applyFilters(); });
  ["#q", "#f-cur", "#f-country", "#f-kind", "#f-ymin", "#f-ymax", "#f-nmin", "#f-lot", "#f-ask", "#f-nominus", "#f-reliable"].forEach(id => $(id).addEventListener("input", applyFilters));
  $("#sort").addEventListener("change", () => { sortList(); state.shown = PAGE; render(); });
  $("#more-btn").addEventListener("click", () => { state.shown += PAGE; render(); });

  // ---------------- avvio ----------------
  async function load() {
    try {
      const r = await fetch("data/bonds.json", { cache: "no-cache" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      state.meta = d.meta; state.bonds = d.bonds;
      recompute();
      const opts = (sel, vals) => { const s = $(sel); vals.forEach(v => { const o = document.createElement("option"); o.value = v; o.textContent = v; s.appendChild(o); }); };
      opts("#f-cur", [...new Set(state.bonds.map(b => b.currency).filter(Boolean))].sort());
      opts("#f-country", [...new Set(state.bonds.map(b => b.country).filter(Boolean))].sort());
      // default: solo EUR. I rendimenti in TRY/BRL/MXN sono "veri" nella loro valuta ma privi di senso in euro
      // (la valuta si svaluta quanto rende): finché manca la conversione in EUR, le altre valute vanno scelte apposta.
      if ([...$("#f-cur").options].some(o => o.value === "EUR")) $("#f-cur").value = "EUR";
      const runAt = new Date(d.meta.run_at);
      $("#meta").textContent = `${d.meta.n_total} titoli MOT · rilevazione ${runAt.toLocaleDateString("it-IT")} ${runAt.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })} · ${d.meta.n_computable} con rendimento`;
      applyFilters();
    } catch (e) {
      $("#meta").textContent = "Dati non disponibili: " + e.message;
    }
  }
  load();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
