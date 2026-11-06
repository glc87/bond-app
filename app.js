/* app.js — v0.11.0 — Bond Netto (PWA) */
(() => {
  "use strict";
  const $ = s => document.querySelector(s), $$ = s => Array.from(document.querySelectorAll(s));
  const APP_VERSION = "0.11.0";
  const DEFAULTS = { nominal: 10000, commissionPct: 0.19, commissionMin: 5, commissionMax: 19, bolloRate: 0.2, taxGov: 12.5, taxOther: 26 }; // Fineco min 2,95 / ING min 8: via di mezzo
  const PAGE = 60;
  const fmtPct = (v, d = 2) => v == null || !isFinite(v) ? "n.d." : (v * 100).toLocaleString("it-IT", { minimumFractionDigits: d, maximumFractionDigits: d }) + "%";
  const fmtNum = (v, d = 2) => v == null ? "–" : v.toLocaleString("it-IT", { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtEur = v => v == null ? "–" : v.toLocaleString("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  const fmtCur = (v, cur) => { if (v == null) return "–"; try { return v.toLocaleString("it-IT", { style: "currency", currency: cur || "EUR", maximumFractionDigits: 0 }); } catch { return `${fmtNum(v, 0)} ${cur}`; } };
  const fmtDate = s => s ? new Date(s).toLocaleDateString("it-IT") : "–";
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const state = { meta: null, bonds: [], settings: loadSettings(), cat: "all", shown: PAGE, filtered: [], compare: new Set(), favs: loadFavs() };

  // ---------------- preferiti (stella, salvati su questo dispositivo) ----------------
  function loadFavs() { try { return new Set(JSON.parse(localStorage.getItem("bond-favs") || "[]")); } catch { return new Set(); } }
  function saveFavs() { try { localStorage.setItem("bond-favs", JSON.stringify([...state.favs])); } catch {} }
  function toggleFav(isin) {
    if (state.favs.has(isin)) state.favs.delete(isin); else state.favs.add(isin);
    saveFavs(); updateFavChip();
    $$(`[data-fav="${isin}"]`).forEach(el => { el.classList.toggle("on", state.favs.has(isin)); el.title = state.favs.has(isin) ? "Togli dai preferiti" : "Aggiungi ai preferiti"; });
    if (state.cat === "fav") applyFilters();
  }
  function updateFavChip() { const c = $('[data-cat="fav"]'); if (c) c.textContent = `★ Preferiti${state.favs.size ? ` (${state.favs.size})` : ""}`; }
  const favBtn = isin => `<button type="button" class="fav ${state.favs.has(isin) ? "on" : ""}" data-fav="${isin}" title="${state.favs.has(isin) ? "Togli dai preferiti" : "Aggiungi ai preferiti"}" aria-label="Preferito">★</button>`;

  function loadSettings() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("bond-settings") || "{}") }; } catch { return { ...DEFAULTS }; }
  }
  function saveSettings(s) { try { localStorage.setItem("bond-settings", JSON.stringify(s)); } catch {} }

  function params(nominal) {
    const s = state.settings;
    return { commissionPct: s.commissionPct / 100, commissionMin: s.commissionMin, commissionMax: (s.commissionMax === "" || s.commissionMax == null) ? null : s.commissionMax,
      bolloRate: s.bolloRate / 100, nominal: nominal ?? s.nominal, taxGov: (s.taxGov ?? 12.5) / 100, taxOther: (s.taxOther ?? 26) / 100 };
  }

  function fxRate(cur) {   // 1 EUR = x valuta (BCE); null se non disponibile
    const fx = state.meta && state.meta.fx; if (!fx || !fx.rates) return cur === "EUR" ? 1 : null;
    return fx.rates[cur] ?? null;
  }
  const toEur = (v, cur) => { const r = fxRate(cur); return r ? v / r : null; };

  function taxOf(b) { const s = state.settings; return (b.tax_rate <= 0.125001 ? (s.taxGov ?? 12.5) : (s.taxOther ?? 26)) / 100; }

  function category(b) {   // stessa logica di run_daily.category_of
    const t = (b.tipologia || "").toLowerCase(), r = b.tax_reason || "";
    if (t === "titoli di stato italiani" || (r.startsWith("titolo di Stato") && b.country === "IT")) return "gov_it";
    if (t === "titoli di stato esteri" || r.startsWith("titolo di Stato") || r.startsWith("classificato titolo di Stato")) return "gov_fx";
    if (r.includes("sovranazionale")) return "supra";
    return "other";
  }
  const CAT_LABEL = { gov_it: "Stato Italia", gov_fx: "Stato estero", supra: "Sovranazionale", other: "Corporate/altro" };
  // Rendimento totale a scadenza: guadagno netto complessivo / esborso, non annualizzato (cedole non reinvestite).
  // Sotto l'anno è il numero che conta: il 6% "annuo" di uno ZC a 7 mesi è +3,6% effettivi.
  const holdLabel = y => y == null ? "" : y < 1 ? `${Math.max(1, Math.round(y * 12))} mesi` : `${fmtNum(y, 1)} anni`;
  const totalReturn = c => (c && c.cost_total_eur > 0 && c.net_gain_total_eur != null) ? `${c.net_gain_total_eur >= 0 ? "+" : ""}${fmtPct(c.net_gain_total_eur / c.cost_total_eur, Math.abs(c.net_gain_total_eur / c.cost_total_eur) >= 0.1 ? 1 : 2)} in ${holdLabel(c.years_to_maturity)}` : "";
  const INST_LOT = 100000;   // taglio minimo da cui il titolo è considerato "istituzionale" (919 titoli su 3.672 il 05/11/2026, per lo più EuroTLX)
  const KIND_LABEL = { fixed: "tasso fisso", zero: "zero coupon", floating: "tasso variabile", inflation: "indicizzato inflazione", stepup: "step-up", callable: "callable", structured: "strutturato", amortizing: "ammortamento", unknown: "altro" };
  const FREQ_LABEL = { 1: "annuale", 2: "semestrale", 4: "trimestrale", 12: "mensile" };

  // Curve di riferimento: titoli di Stato a tasso fisso in EUR con prezzo affidabile -> (anni, YTM lordo), interpolazione lineare.
  // Bund = Germania (gov_fx, DE); BTP = Italia (gov_it, esclusi BTP Italia/€i e Valore/Futura perché non "fixed").
  function buildCurve(pred) {
    const pts = state.bonds.filter(b => pred(b) && b.kind === "fixed" && b.currency === "EUR" && b._calc && reliable(b) && !b._strip && b._years > 0.25)
      .map(b => [b._years, b._calc.ytm_gross]).sort((a, b) => a[0] - b[0]);
    // media per scadenze vicine (evita zig-zag da singoli titoli)
    const out = []; for (const [x, y] of pts) { const last = out[out.length - 1]; if (last && Math.abs(last[0] - x) < 0.25) { last[0] = (last[0] * last[2] + x) / (last[2] + 1); last[1] = (last[1] * last[2] + y) / (last[2] + 1); last[2]++; } else out.push([x, y, 1]); }
    return out;
  }
  function curveAt(curve, x) {
    if (curve.length < 2 || x < curve[0][0] - 0.5 || x > curve[curve.length - 1][0] + 2) return null;
    if (x <= curve[0][0]) return curve[0][1]; if (x >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];
    for (let i = 1; i < curve.length; i++) if (x <= curve[i][0]) { const [x0, y0] = curve[i - 1], [x1, y1] = curve[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
    return null;
  }

  function recompute() {
    const trade = Yields.parseISO(state.meta.trade_date);
    for (const b of state.bonds) {
      b._cat = category(b);
      b._years = b.maturity ? (Yields.parseISO(b.maturity) - trade) / 86400000 / 365 : null;
      b._price = b.price && b.price.used;
      b._calc = (b.computable && b._price) ? Yields.compute(b, { price: b._price, priceSource: b.price.source, tradeDate: trade, ...params() }) : null;
      if (b._calc) {
        const cpn = b.kind === "zero" ? 0 : (b.coupon_annual || 0);
        b._calc.coupon_net_yield = b._price ? cpn * (1 - taxOf(b)) / b._price : null;                     // flusso netto annuo in tasca
        b._calc.price_yield = (b._calc.ytm_net_all != null && b._calc.coupon_net_yield != null) ? b._calc.ytm_net_all - b._calc.coupon_net_yield : null;  // il resto: dal prezzo
      }
      b._liq = b.liquidity && b.liquidity.days >= 3 ? b.liquidity.score : null;   // significativo solo con qualche giorno di storico
      b._uncertain = uncertainReason(b);
      b._strip = isStrip(b);
    }
    state.bundCurve = buildCurve(b => b.country === "DE" && b._cat === "gov_fx");
    state.btpCurve = buildCurve(b => b.country === "IT" && b._cat === "gov_it");
    for (const b of state.bonds) {
      if (!b._calc) continue;
      const rb = curveAt(state.bundCurve, b._years), ri = curveAt(state.btpCurve, b._years);
      b._calc.spread_bund = rb != null ? b._calc.ytm_gross - rb : null;
      b._calc.spread_btp = ri != null ? b._calc.ytm_gross - ri : null;
    }
  }

  // ---------------- filtri a selezione multipla con conteggi (valuta, paese, mercato) ----------------
  // Ogni voce mostra quanti titoli resterebbero scegliendola, dati tutti gli ALTRI filtri attivi (conteggi "sfaccettati").
  const COUNTRY_NAME = { IT: "Italia", DE: "Germania", FR: "Francia", ES: "Spagna", AT: "Austria", BE: "Belgio", NL: "Paesi Bassi", PT: "Portogallo", IE: "Irlanda", FI: "Finlandia", GR: "Grecia", RO: "Romania", PL: "Polonia", HU: "Ungheria",
    US: "Stati Uniti", GB: "Regno Unito", XS: "internazionale", EU: "Unione Europea", LU: "Lussemburgo", BR: "Brasile", MX: "Messico", TR: "Turchia", ZA: "Sudafrica", AR: "Argentina", CL: "Cile", PE: "Perù", CO: "Colombia", EG: "Egitto",
    CH: "Svizzera", SE: "Svezia", DK: "Danimarca", NO: "Norvegia", CA: "Canada", AU: "Australia", JP: "Giappone", KR: "Corea del Sud", CN: "Cina", IN: "India", ID: "Indonesia", PH: "Filippine", SA: "Arabia Saudita", QA: "Qatar", AE: "Emirati",
    IL: "Israele", MA: "Marocco", NG: "Nigeria", UY: "Uruguay", PA: "Panama", DO: "Rep. Dominicana", CR: "Costa Rica", SK: "Slovacchia", SI: "Slovenia", HR: "Croazia", CZ: "Rep. Ceca", BG: "Bulgaria", LT: "Lituania", LV: "Lettonia",
    EE: "Estonia", CY: "Cipro", MT: "Malta", IS: "Islanda", KZ: "Kazakistan", RS: "Serbia", MK: "Macedonia del Nord", UA: "Ucraina", KY: "Cayman", BM: "Bermuda", JE: "Jersey", VG: "Isole Vergini", NZ: "Nuova Zelanda", HK: "Hong Kong", SG: "Singapore" };
  const FACETS = {
    cur: { el: "#f-cur", key: b => b.currency, label: v => v, def: new Set(["EUR"]) },
    country: { el: "#f-country", key: b => b.country, label: v => COUNTRY_NAME[v] ? `${v} · ${COUNTRY_NAME[v]}` : v, def: new Set() },
    market: { el: "#f-market", key: b => b.markets || [b.market], label: v => v === "ETLX" ? "EuroTLX" : v, def: new Set() },
  };
  const facetSel = { cur: new Set(["EUR"]), country: new Set(), market: new Set() };
  const facetMatch = (name, b) => { const sel = facetSel[name]; if (!sel.size) return true; const k = FACETS[name].key(b); return Array.isArray(k) ? k.some(x => sel.has(x)) : sel.has(k); };
  const facetText = name => { const f = FACETS[name], sel = [...facetSel[name]]; return sel.length ? sel.map(v => name === "market" ? f.label(v) : v).join(", ") : $(f.el).dataset.all; };
  function renderFacetButton(name) { const btn = $(FACETS[name].el + " .facet-btn"); btn.textContent = facetText(name); btn.classList.toggle("set", !setEq(facetSel[name], FACETS[name].def)); }
  const setEq = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
  function renderFacetPop(name) {
    const f = FACETS[name], pop = $(f.el + " .facet-pop"); if (pop.classList.contains("hidden")) return;
    // conteggi: titoli che passano tutti gli altri filtri, per ogni valore di questo
    const counts = {}; for (const b of state.bonds) { if (!passes(b, name)) continue; const k = f.key(b); for (const v of (Array.isArray(k) ? k : [k])) if (v) counts[v] = (counts[v] || 0) + 1; }
    const vals = [...new Set(state.bonds.flatMap(b => { const k = f.key(b); return Array.isArray(k) ? k : [k]; }).filter(Boolean))];
    vals.sort((a, b) => (counts[b] || 0) - (counts[a] || 0) || a.localeCompare(b));
    const total = state.bonds.filter(b => passes(b, name)).length;
    pop.innerHTML = `<div class="facet-head"><span class="hint">scelta multipla · numero di titoli con gli altri filtri</span><button type="button" class="facet-close">✓ Fatto</button></div>
      <label class="facet-row all"><input type="checkbox" ${facetSel[name].size ? "" : "checked"} data-fv=""> <span>${esc($(f.el).dataset.all)}</span><b>${total}</b></label>` +
      vals.map(v => `<label class="facet-row ${counts[v] ? "" : "zero"}"><input type="checkbox" ${facetSel[name].has(v) ? "checked" : ""} data-fv="${esc(v)}"> <span>${esc(f.label(v))}</span><b>${counts[v] || 0}</b></label>`).join("");
  }
  function closeFacets(except) { for (const name of Object.keys(FACETS)) if (name !== except) $(FACETS[name].el + " .facet-pop").classList.add("hidden"); }
  document.addEventListener("click", e => {
    const fb = e.target.closest(".facet-btn");
    if (fb) { const wrap = fb.closest(".facet"); const name = Object.keys(FACETS).find(n => $(FACETS[n].el) === wrap); const pop = wrap.querySelector(".facet-pop"); closeFacets(name); pop.classList.toggle("hidden"); renderFacetPop(name); e.preventDefault(); return; }
    if (e.target.closest(".facet-close")) { closeFacets(); e.preventDefault(); return; }
    const cb = e.target.closest(".facet-row input");
    if (cb) {
      const wrap = cb.closest(".facet"); const name = Object.keys(FACETS).find(n => $(FACETS[n].el) === wrap); const v = cb.dataset.fv;
      if (v === "") facetSel[name].clear(); else if (cb.checked) facetSel[name].add(v); else facetSel[name].delete(v);
      renderFacetButton(name); applyFilters(); renderFacetPop(name); e.stopPropagation(); return;
    }
    if (!e.target.closest(".facet")) closeFacets();
  });
  // "label" che avvolge il facet: evita che il click sulla label riapra/chiuda il popover
  document.addEventListener("click", e => { if (e.target.closest("label") && e.target.closest("label").querySelector(".facet") && !e.target.closest(".facet")) e.preventDefault(); }, true);

  // Predicato dei filtri; `skip` esclude un facet (per i suoi conteggi). Le variabili lette dai campi sono in `cur`.
  let cur = {};
  function readFilterInputs() {
    cur = { q: $("#q").value.trim().toLowerCase(), kind: $("#f-kind").value,
      ymin: parseFloat($("#f-ymin").value), ymax: parseFloat($("#f-ymax").value), nmin: parseFloat($("#f-nmin").value), lot: parseFloat($("#f-lot").value), cmin: parseFloat($("#f-cmin").value),
      onlyAsk: $("#f-ask").checked, noMinus: $("#f-nominus").checked, showUncertain: $("#f-uncertain").checked, showStrips: $("#f-strips").checked, showInst: $("#f-inst").checked };
  }
  function passes(b, skip) {
    const { q, kind, ymin, ymax, nmin, lot, cmin, onlyAsk, noMinus, showUncertain, showStrips, showInst } = cur;
    if (q && !(`${b.name} ${b.isin} ${b.issuer}`.toLowerCase().includes(q))) return false;
    if (state.cat === "fav") return state.favs.has(b.isin);   // nei preferiti vale solo la ricerca: vedi tutto ciò che hai scelto
    if (state.cat !== "all" && b._cat !== state.cat) return false;
    for (const name of Object.keys(FACETS)) if (name !== skip && !facetMatch(name, b)) return false;
    if (kind === "computable" && !b._calc) return false;
    if (kind === "nocall" && !(b._calc && b.kind !== "callable")) return false;
    if ((kind === "fixed" || kind === "zero") && !(b._calc && b.kind === kind)) return false;
    if (!isNaN(ymin) && b._years != null && b._years < ymin) return false;
    if (!isNaN(ymax) && b._years != null && b._years > ymax) return false;
    if (!isNaN(nmin) && !(b._calc && b._calc.ytm_net_all != null && b._calc.ytm_net_all * 100 >= nmin)) return false;
    if (!isNaN(cmin) && !(b._calc && b._calc.coupon_net_yield != null && b._calc.coupon_net_yield * 100 >= cmin)) return false;
    if (!isNaN(lot) && b.min_lot != null && b.min_lot > lot) return false;
    if (onlyAsk && b.price.source !== "ask") return false;
    if (noMinus && b._price > 100) return false;
    if (!showUncertain && b._uncertain) return false;
    if (!showInst && b.min_lot != null && b.min_lot >= INST_LOT) return false;   // lotti istituzionali nascosti di default
    if (!showStrips && b._strip) return false;
    return true;
  }

  function applyFilters() {
    readFilterInputs();
    const { q, kind, ymin, ymax, nmin, lot, cmin, onlyAsk, noMinus, showUncertain, showStrips, showInst } = cur;
    let n = 0;
    state.filtered = state.bonds.filter(b => passes(b, null));
    // Filtri attivi (diversi dal default): chip rimovibili sotto il pannello, campi evidenziati, conteggio live nel pannello.
    const kindLabel = { nocall: "senza richiamabili", fixed: "solo tasso fisso", zero: "solo zero coupon", all: "anche non calcolabili" };
    const active = [];
    const add = (id, label, value, reset) => { active.push({ id, label, value, reset }); };
    for (const name of Object.keys(FACETS)) if (!setEq(facetSel[name], FACETS[name].def)) add(FACETS[name].el.slice(1), { cur: "Valuta", country: "Paese", market: "Mercato" }[name], facetText(name), () => { facetSel[name] = new Set(FACETS[name].def); renderFacetButton(name); });
    if (kind !== "computable") add("f-kind", "Tipo", kindLabel[kind] || kind, () => { $("#f-kind").value = "computable"; });
    if (!isNaN(ymin) && ymin !== 0) add("f-ymin", "Scadenza min", `${fmtNum(ymin, 1)} anni`, () => { $("#f-ymin").value = "0"; });
    if (!isNaN(ymax)) add("f-ymax", "Scadenza max", `${fmtNum(ymax, 1)} anni`, () => { $("#f-ymax").value = ""; });
    if (!isNaN(nmin)) add("f-nmin", "Netto min", `${fmtNum(nmin)}%`, () => { $("#f-nmin").value = ""; });
    if (!isNaN(cmin)) add("f-cmin", "Cedola netta min", `${fmtNum(cmin)}%`, () => { $("#f-cmin").value = ""; });
    if (!isNaN(lot)) add("f-lot", "Lotto max", fmtNum(lot, 0), () => { $("#f-lot").value = ""; });
    if (showInst) add("f-inst", "Lotti istituzionali", "mostrati", () => { $("#f-inst").checked = false; });
    if (showUncertain) add("f-uncertain", "Incerti", "mostrati", () => { $("#f-uncertain").checked = false; });
    if (showStrips) add("f-strips", "Strip", "mostrati", () => { $("#f-strips").checked = false; });
    if (onlyAsk) add("f-ask", "Solo ask", "sì", () => { $("#f-ask").checked = false; });
    if (noMinus) add("f-nominus", "Sopra la pari", "esclusi", () => { $("#f-nominus").checked = false; });
    n = active.length;
    $("#filter-count").textContent = n ? `· ${n} ${n === 1 ? "attivo" : "attivi"}` : "";
    $("#filter-live").textContent = state.cat === "fav" ? `${state.filtered.length} preferiti (qui i filtri non si applicano, solo la ricerca)` : `${state.filtered.length} titoli corrispondono` + (n ? ` (${n} ${n === 1 ? "filtro attivo" : "filtri attivi"})` : " (filtri di default)");
    $$(".grid input, .grid select, .grid label.check").forEach(el => el.classList.remove("set"));
    active.forEach(a => { const el = $("#" + a.id); if (el.classList.contains("facet")) return; el.classList.add("set"); if (el.type === "checkbox") el.closest("label").classList.add("set"); });
    for (const name of Object.keys(FACETS)) renderFacetPop(name);   // conteggi aggiornati se un popover è aperto
    state.activeFilters = active;
    $("#active-filters").innerHTML = active.map((a, i) => `<button type="button" class="chip" data-af="${i}" title="togli questo filtro">${esc(a.label)}<b>${esc(a.value)}</b> ×</button>`).join("")
      + (active.length > 1 ? `<button type="button" class="chip" data-af="all" title="torna ai filtri di default">Azzera tutti ×</button>` : "");
    sortList();
    state.shown = PAGE;
    render();
    syncHash();
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
        case "coupon_net_yield": case "price_yield": case "ytm_net_all": case "spread_bund": case "spread_btp": return b._calc ? b._calc[key] : null;
        case "liq": return b._liq;
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
  function isStrip(b) { return /strip/i.test(b.name) || /strip/i.test(b.tipo_bond || ""); }
  // "incerto": prezzo non affidabile, oppure verifica incrociata con Borsa Italiana non superata
  function uncertainReason(b) {
    const q = quality(b);
    if (q === "stale") return "prezzo fermo: nessuna proposta in vendita e nessuno scambio nell'anno";
    if (q === "quiet") return "nessuna proposta in vendita e nessuno scambio oggi: prezzo di riferimento forse non aggiornato";
    const ck = b.check || {};
    if (ck.ytm_gross_vs_bi != null && Math.abs(ck.ytm_gross_vs_bi) > 0.25 && b._years > 0.5) return `rendimento lordo scostato di ${fmtNum(ck.ytm_gross_vs_bi)} punti da quello pubblicato dal mercato`;
    if (ck.tax_rate_confirmed === false) return "aliquota fiscale non confermata dai dati di mercato";
    if ((b.anomalies || []).some(a => a.startsWith("cedola scheda"))) return "cedola della scheda non coerente con il nome del titolo";
    return null;
  }
  function priceBadge(b) {
    const q = quality(b);
    const cls = q === "ask" ? "ask" : q === "stale" ? "stale" : "ref";
    return `<span class="badge ${cls}" title="${QUALITY_LABEL[q]}">${q === "ask" ? "ask" : q === "stale" ? "fermo" : "rif"}</span>`;
  }

  function cardHTML(b) {
    const c = b._calc;
    const cpn = b.kind === "zero" ? "zero coupon" : (b.coupon_annual != null ? `${fmtNum(b.coupon_annual)}% ${FREQ_LABEL[b.coupon_frequency] || ""}` : KIND_LABEL[b.kind]);
    const minus = (b._price > 100 ? '<span class="badge warn">sopra 100</span>' : "") + (b.kind === "callable" ? ' <span class="badge warn" title="' + esc(b.warning || "richiamabile") + '">call</span>' : "") + (b._liq != null && b._liq < 0.5 ? ` <span class="badge warn" title="venditore presente in ${Math.round(b._liq * 100)}% delle ultime ${b.liquidity.days} rilevazioni">poco liquido</span>` : "") + (b._uncertain ? ' <span class="badge stale" title="' + esc(b._uncertain) + '">incerto</span>' : "") + (b._strip ? ' <span class="badge cur">strip</span>' : "");
    const sel = state.compare.has(b.isin);
    return `<div class="card ${sel ? "sel" : ""}" data-isin="${b.isin}">
      <label class="cmp" title="Aggiungi al confronto"><input type="checkbox" data-cmp="${b.isin}" ${sel ? "checked" : ""}></label>
      <div class="c-name"><div class="name">${favBtn(b.isin)}${esc(b.name)} ${minus}</div>
        <div class="meta"><span>${esc(b.isin)}</span><span>${CAT_LABEL[b._cat]}</span><span>${esc(b.country)}</span>${b.market === "ETLX" ? '<span class="badge cur" title="quotato su EuroTLX">EuroTLX</span>' : ""}${(b.markets || []).length > 1 ? '<span class="badge cur" title="quotato sia sul MOT sia su EuroTLX">MOT+TLX</span>' : ""}${b.min_lot && b.min_lot > 1000 ? `<span class="${b.min_lot >= INST_LOT ? "badge warn" : ""}" title="${b.min_lot >= INST_LOT ? "taglio istituzionale" : "lotto minimo"}">lotto ${fmtCur(b.min_lot, b.currency)}</span>` : ""}</div></div>
      <div class="c-mat"><span class="lbl">Scad.</span>${fmtDate(b.maturity)} <span class="small">(${b._years != null ? fmtNum(b._years, 1) : "–"} a.)</span></div>
      <div class="c-cpn"><span class="lbl">Cedola</span>${cpn}</div>
      <div class="c-price"><span class="lbl">Prezzo</span>${fmtNum(b._price, 2)} ${priceBadge(b)} <span class="badge cur">${esc(b.currency)}</span>${c && c.accrued_net > 0 ? `<div class="small">tel quel ${fmtNum(b._price + c.accrued_net, 2)} <span title="prezzo + rateo netto: quello che paghi">(+${fmtNum(c.accrued_net, 3)} rateo)</span></div>` : ""}</div>
      <div class="c-net">${c ? `<div class="main">${fmtPct(c.ytm_net_all)}</div><div class="small">netto annuo</div><div class="small tot" title="guadagno netto totale (tasse, commissioni, bollo) sull'esborso, da oggi alla scadenza, senza reinvestire le cedole">${totalReturn(c)}</div>` : `<div class="main na">n.d.</div><div class="small">${esc(b.not_computable_reason || KIND_LABEL[b.kind])}</div>`}</div>
      <div class="c-ytm">${c ? `<div><span class="lbl">da cedola</span>${fmtPct(c.coupon_net_yield)}</div><div><span class="lbl">da prezzo</span>${fmtPct(c.price_yield)}</div>${c.spread_btp != null ? `<div title="differenza di rendimento lordo rispetto a un BTP di pari scadenza"><span class="lbl">vs BTP</span>${c.spread_btp >= 0 ? "+" : ""}${fmtPct(c.spread_btp)}</div>` : ""}${c.spread_bund != null ? `<div title="differenza di rendimento lordo rispetto a un Bund di pari scadenza"><span class="lbl">vs Bund</span>${c.spread_bund >= 0 ? "+" : ""}${fmtPct(c.spread_bund)}</div>` : ""}` : ""}</div>
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
      ["Esborso oggi", (b, c) => c ? `${fmtCur(c.cost_total_eur, b.currency)}<br><span class="small">su ${fmtCur(c.nominal, b.currency)} nominali</span>` : "–"],
      ["Cedole nette totali", (b, c) => c ? fmtCur(c.coupons_net_total_eur, b.currency) : "–"],
      ["Guadagno netto a scadenza", (b, c) => c ? `<b>${fmtCur(c.net_gain_total_eur, b.currency)}</b>` : "–"],
      ["Minusvalenza a scadenza", (b, c) => c && c.minus_eur > 0 ? `<span class="ko">${fmtCur(c.minus_eur, b.currency)}</span>` : "–"],
      ["Rischio tasso: −% prezzo per +1 punto", (b, c) => c && c.mod_duration != null ? `${fmtPct(c.mod_duration / 100, 1)} <span class="small">(duration ${fmtNum(c.mod_duration, 1)})</span>` : fmtNum(b.bi.mod_duration)],
      ["Spread vs BTP / vs Bund", b => b._calc ? `${b._calc.spread_btp != null ? (b._calc.spread_btp >= 0 ? "+" : "") + fmtPct(b._calc.spread_btp) : "–"} / ${b._calc.spread_bund != null ? (b._calc.spread_bund >= 0 ? "+" : "") + fmtPct(b._calc.spread_bund) : "–"}` : "–"],
      ["Lotto minimo", b => fmtCur(b.min_lot, b.currency)],
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

  async function renderAuctions() {
    const el = $("#auctions"); if (!el) return;
    try {
      const r = await fetch("data/aste.json", { cache: "no-cache" }); if (!r.ok) return;
      const a = await r.json();
      const today = new Date().toISOString().slice(0, 10);
      const next = a.auctions.filter(x => x.date >= today).slice(0, 6);
      if (!next.length) { el.innerHTML = `<p class="hint">Calendario aste ${a.year} esaurito: <a href="${a.mef_url}" target="_blank" rel="noopener">calendario MEF ↗</a></p>`; return; }
      const dayName = d => new Date(d).toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" });
      el.innerHTML = `<details><summary>Prossime aste del Tesoro <span class="small">(${dayName(next[0].date)}: ${esc(next[0].label)})</span></summary>
        <table class="kv">${next.map(x => `<tr><td>${dayName(x.date)}${x.settlement ? ` <span class="small">· regolamento ${dayName(x.settlement)}</span>` : ""}</td><td>${esc(x.label)}</td></tr>`).join("")}</table>
        <p class="hint">${esc(a.note)} <a href="${a.mef_url}" target="_blank" rel="noopener">Calendario e comunicati MEF ↗</a></p></details>`;
    } catch {}
  }

  function renderBest() {
    const buckets = [["Fino a 2 anni", 0, 2], ["2–5 anni", 2, 5], ["5–10 anni", 5, 10], ["10–20 anni", 10, 20], ["Oltre 20 anni", 20, 1e9]];
    const pool = state.filtered.filter(b => b._calc && b._calc.ytm_net_all != null && reliable(b) && !b._uncertain && !b._strip);
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
    $("#d-sub").innerHTML = `${favBtn(b.isin)} <span class="isin-row"><code>${esc(b.isin)}</code><button class="copy" data-copy="${esc(b.isin)}" title="Copia ISIN">⧉ copia</button></span> · ${esc(b.issuer)} · ${CAT_LABEL[b._cat]} · ${KIND_LABEL[b.kind]}`;
    const nominalDefault = Math.max(state.settings.nominal, b.min_lot || 0);
    $("#d-body").innerHTML = detailHTML(b, nominalDefault);
    $("#detail").classList.remove("hidden");
    loadChart(b);
    const inp = $("#d-amount");
    const nominalNow = () => { const n = inp ? parseFloat(inp.value) : NaN; return n > 0 ? n : nominalDefault; };
    if (inp) inp.addEventListener("input", () => { const n = parseFloat(inp.value); if (n > 0) { $("#d-calc").innerHTML = calcHTML(b, n); if (window.BondSim) BondSim.mountSim(b, nominalNow); } });
    if (window.BondSim) BondSim.mountSim(b, nominalNow);
  }

  function detailHTML(b, nominal) {
    const p = b.price, bi = b.bi, ck = b.check || {};
    const rows = [
      ["Prezzo usato", `${fmtNum(b._price)} ${priceBadge(b)}`], ["Ask / Bid", `${fmtNum(p.ask)} (${fmtNum(p.ask_qty, 0)}) / ${fmtNum(p.bid)} (${fmtNum(p.bid_qty, 0)})`],
      ["Prezzo di riferimento", `${fmtNum(p.ref)} del ${fmtDate(p.ref_date)}`], ["Ultimo contratto", `${fmtNum(p.last)} ${esc(p.last_time || "")}`],
      ["Liquidità (ultime rilevazioni)", b.liquidity ? `${b.liquidity.ask_days} su ${b.liquidity.days} giorni con un venditore nel book${b.liquidity.days < 3 ? " (storico ancora breve)" : ""}` : "–"],
      ["Scambi oggi", p.n_trades_today != null ? `${fmtNum(p.n_trades_today, 0)} contratti, ${fmtCur(p.volume_today, b.currency)} nominali` : "–"], ["Min / max anno", p.year_high != null ? `${fmtNum(p.year_low)} / ${fmtNum(p.year_high)}` : "nessuno scambio nell'anno"],
      ["Valuta", b.currency], ["Scadenza", `${fmtDate(b.maturity)} (${fmtNum(b._years, 2)} anni)`],
      ["Cedola", b.kind === "zero" ? "zero coupon" : `${fmtNum(b.coupon_annual)}% annuo, ${FREQ_LABEL[b.coupon_frequency] || b.coupon_frequency_label || "–"}`],
      ["Mercato", `${b.market === "ETLX" ? "EuroTLX" : "MOT"}${b.other_market ? ` (anche su ${b.other_market.market === "ETLX" ? "EuroTLX" : "MOT"}: ask ${fmtNum(b.other_market.ask)} / bid ${fmtNum(b.other_market.bid)}, rif ${fmtNum(b.other_market.ref)})` : ""}`],
      ["Lotto minimo", fmtCur(b.min_lot, b.currency)], ["Aliquota fiscale applicata", `${fmtNum(taxOf(b) * 100, 1)}% (${esc(b.tax_reason)}${Math.abs(taxOf(b) - b.tax_rate) > 1e-9 ? "; regime personalizzato nelle Impostazioni" : ""})`],
      ["Emesso", b.outstanding ? fmtCur(b.outstanding, b.currency) : "–"], ["Subordinato", b.subordinated || "–"], ["Segmento", b.segment],
    ];
    const biRows = bi.yield_gross != null ? `<h3>Dati pubblicati dal mercato (prezzo di riferimento)</h3><table class="kv">
      <tr><td>YTM lordo BI / nostro sullo stesso prezzo</td><td>${fmtNum(bi.yield_gross)} / ${ck.ytm_gross_vs_bi != null ? fmtNum(bi.yield_gross + ck.ytm_gross_vs_bi) : "–"} <span class="${Math.abs(ck.ytm_gross_vs_bi || 0) < 0.05 ? "ok" : "ko"}">●</span></td></tr>
      <tr><td>YTM netto BI (non tassa la plusvalenza)</td><td>${fmtNum(bi.yield_net)}</td></tr>
      <tr><td>Rateo lordo BI</td><td>${fmtNum(bi.accrued_gross, 5)}</td></tr>
      <tr><td>Duration modificata</td><td>${fmtNum(bi.mod_duration)}</td></tr>
      <tr><td>Aliquota confermata dai dati BI</td><td class="${ck.tax_rate_confirmed === false ? "ko" : "ok"}">${ck.tax_rate_confirmed === false ? "NO, verificare" : ck.tax_rate_confirmed ? "sì" : "–"}</td></tr></table>` : "";
    const warn = b.warning ? `<div class="note">⚠ ${esc(b.warning)}. Se viene richiamato a 100 prima della scadenza, il rendimento effettivo cambia: più basso se comprato sopra 100, più alto se sotto.</div>` : "";
    const anomalies = warn + (b._uncertain ? `<div class="note">⚠ <b>Titolo incerto</b>: ${esc(b._uncertain)}. Nascosto di default dalla lista.</div>` : "")
      + (b._strip ? `<div class="note">ℹ <b>Strip</b>: cedola o mantello di un titolo di Stato "smontato", negoziato come zero coupon. Legittimo ma poco liquido, spread larghi, pochi scambi: nascosto di default.</div>` : "")
      + ((b.anomalies || []).length ? `<div class="note">Note tecniche: ${b.anomalies.map(esc).join("<br>")}</div>` : "");
    const calc = b._calc ? `<div class="amount"><label>Importo nominale</label><input id="d-amount" type="number" step="${b.min_lot || 1000}" min="${b.min_lot || 1000}" value="${nominal}"> €</div>
      <div id="d-calc">${calcHTML(b, nominal)}</div>` : `<div class="note">Rendimento non calcolato: ${esc(b.not_computable_reason)}</div>`;
    const addBtn = b._calc ? `<div class="row"><button class="btn ghost" data-pf-add="${b.isin}">+ Aggiungi al portafoglio</button></div>` : "";
    return `${anomalies}${calc}${addBtn}<div id="d-sim"></div><h3>Storico</h3><div id="d-chart" class="chart"><span class="hint">caricamento…</span></div><h3>Dati titolo</h3><table class="kv">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>${biRows}
      <p class="hint" style="margin-top:12px"><a href="${esc(b.scheda_url)}" target="_blank" rel="noopener">Scheda ufficiale del titolo ↗</a></p>`;
  }

  function calcHTML(b, nominal) {
    const c = Yields.compute(b, { price: b._price, priceSource: b.price.source, tradeDate: Yields.parseISO(state.meta.trade_date), ...params(nominal) });
    const minus = c.minus_eur > 0 ? `<div class="note">Prezzo sopra 100: a scadenza si genera una minusvalenza di ${fmtCur(c.minus_eur, b.currency)} (credito fiscale compensabile con altre plusvalenze da "redditi diversi" entro i 4 anni successivi). Non è conteggiata nel rendimento.</div>` : "";
    const exc = (b.currency === "SEK" || b.currency === "DKK") && c.next_coupon_date ? `<div class="note">Mercati svedese e danese: esiste un periodo <b>ex-cedola</b> prima dello stacco (durata fissata dal depositario locale, non pubblicata dall'emittente). Comprando nei giorni immediatamente precedenti la cedola del ${fmtDate(c.next_coupon_date)}, la cedola resterebbe al venditore e il rateo non sarebbe dovuto: l'esborso reale sarebbe più basso di quello indicato. Verifica con la banca prima dell'ordine.</div>` : "";
    const q = quality(b);
    const src = q === "stale" ? `<div class="note">⚠ <b>Prezzo fermo</b>: nessuna proposta in vendita e nessuno scambio nell'anno. Il prezzo di riferimento (${fmtNum(b.price.ref)}) è vecchio e il rendimento calcolato non è realistico: nessuno vende a questo prezzo.</div>`
      : q === "quiet" ? `<div class="note">Nessuna proposta in vendita nel book e nessuno scambio oggi: calcolo sul prezzo di riferimento, che potrebbe non essere aggiornato.</div>`
      : q === "traded" ? `<div class="note">Nessuna proposta in vendita nel book al momento della rilevazione: calcolo sul prezzo di riferimento (titolo scambiato oggi).</div>` : "";
    return `<div class="kpis">
      <div class="kpi"><div class="l">Rendimento netto annuo (tasse, commissioni, bollo)</div><div class="v good">${fmtPct(c.ytm_net_all)}</div></div>
      <div class="kpi"><div class="l">di cui da cedola (flusso netto / prezzo)</div><div class="v">${fmtPct(b._price ? (b.kind === "zero" ? 0 : (b.coupon_annual || 0)) * (1 - taxOf(b)) / b._price : null)}</div></div>
      <div class="kpi"><div class="l">di cui da prezzo (a scadenza)</div><div class="v">${fmtPct(c.ytm_net_all != null && b._price ? c.ytm_net_all - (b.kind === "zero" ? 0 : (b.coupon_annual || 0)) * (1 - taxOf(b)) / b._price : null)}</div></div>
      <div class="kpi"><div class="l">Guadagno netto totale a scadenza (${holdLabel(c.years_to_maturity)})</div><div class="v good">${fmtCur(c.net_gain_total_eur, b.currency)} <span class="small">= ${totalReturn(c)} (non annualizzato)</span></div></div>

    </div>${minus}${src}${exc}
    ${rateRiskHTML(b, c, nominal)}
    ${b.currency !== "EUR" ? fxNote(b, c, nominal) : ""}
    <h3>Flussi per ${nominal.toLocaleString("it-IT")} ${esc(b.currency)} nominali</h3><table class="kv">
      <tr><td>Regolamento (T+2)</td><td>${fmtDate(c.settle_date)}</td></tr>
      <tr><td>Prezzo + rateo netto (${fmtNum(c.accrued_net, 3)})</td><td>${fmtCur(c.cost_total_eur - c.commission_eur, b.currency)}</td></tr>
      <tr><td>Commissioni</td><td>${fmtCur(c.commission_eur, b.currency)}</td></tr>
      <tr><td><b>Esborso oggi</b></td><td><b>${fmtCur(c.cost_total_eur, b.currency)}</b></td></tr>
      <tr><td>Cedole nette (${c.n_coupons} × ${fmtCur(c.coupon_net_per_period / 100 * nominal, b.currency)})${c.next_coupon_date ? `, prossima ${fmtDate(c.next_coupon_date)}` : ""}</td><td>${fmtCur(c.coupons_net_total_eur, b.currency)}</td></tr>
      <tr><td>Rimborso netto (tassa su plusvalenza ${fmtCur(c.capital_gain_tax_eur, b.currency)})</td><td>${fmtCur(c.redemption_net_eur, b.currency)}</td></tr>
      <tr><td>Imposta di bollo stimata (totale)</td><td>−${fmtCur(c.bollo_total_eur, b.currency)}</td></tr>
      <tr><td><b>Guadagno netto</b></td><td><b>${fmtCur(c.net_gain_total_eur, b.currency)}</b></td></tr></table>
    <h3>Altre misure (per confronto con altri siti)</h3><table class="kv">
      <tr><td>YTM lordo (come pubblicato dal mercato)</td><td>${fmtPct(c.ytm_gross)}</td></tr>
      <tr><td>Spread vs BTP di pari scadenza (lordo)${b.currency !== "EUR" ? " — in valuta, include il rischio cambio" : ""}</td><td>${b._calc && b._calc.spread_btp != null ? (b._calc.spread_btp >= 0 ? "+" : "") + fmtPct(b._calc.spread_btp) : "–"}</td></tr>
      <tr><td>Spread vs Bund di pari scadenza (lordo)${b.currency !== "EUR" ? " — in valuta, include il rischio cambio" : ""}</td><td>${b._calc && b._calc.spread_bund != null ? (b._calc.spread_bund >= 0 ? "+" : "") + fmtPct(b._calc.spread_bund) : "–"}</td></tr>
      <tr><td>YTM netto solo tasse (senza commissioni e bollo; tassa anche la plusvalenza, a differenza di BI)</td><td>${fmtPct(c.ytm_net_tax)}</td></tr>
      <tr><td>Netto annuo semplice (guadagno totale ÷ costo ÷ anni, senza reinvestimento)</td><td>${fmtPct(c.simple_net_all)}</td></tr></table>`;
  }

  // Rischio tasso: duration modificata = variazione % del prezzo tel quel per +1 punto di rendimento (stessa formula di BI, verificata entro 0,02 su 1.907 titoli su 2.043)
  function rateRiskHTML(b, c, nominal) {
    if (c.mod_duration == null) return "";
    const d = c.mod_duration, tq = (b._price + c.accrued_gross) / 100 * nominal;
    const lvl = d < 2 ? "basso" : d < 5 ? "medio" : d < 9 ? "alto" : "molto alto";
    return `<div class="note risk"><b>Rischio tasso ${lvl}</b> (duration modificata ${fmtNum(d, 1)}): se i rendimenti di mercato salgono di 1 punto, il prezzo scende di circa <b>${fmtPct(d / 100, 1)}</b>
      (≈ ${fmtCur(tq * d / 100, b.currency)} su ${fmtCur(nominal, b.currency)} nominali); se scendono di 1 punto, sale altrettanto. Conta solo se vendi prima della scadenza: a scadenza rimborsa 100.</div>`;
  }

  function seriesShard(isin) {   // identica a run_daily.series_shard
    let h = 0; for (const ch of isin.toUpperCase()) h = (h * 31 + ch.charCodeAt(0)) % 1000003;
    return String(h % 64).padStart(2, "0");
  }

  async function loadChart(b) {
    const el = $("#d-chart"); if (!el) return;
    let pts = [];
    try { const r = await fetch(`data/series/${seriesShard(b.isin)}.json`, { cache: "no-cache" }); if (r.ok) pts = (await r.json())[b.isin] || []; } catch {}
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

  function fxNote(b, c, nominal) {
    const r = fxRate(b.currency);
    const fxd = state.meta.fx && state.meta.fx.date ? ` (BCE del ${fmtDate(state.meta.fx.date)})` : "";
    if (!r) return `<div class="note">Titolo in ${esc(b.currency)}: cambio non disponibile. Il rendimento è nella valuta del titolo e NON tiene conto del cambio.</div>`;
    return `<div class="note">Titolo in <b>${esc(b.currency)}</b>, 1 EUR = ${fmtNum(r, 4)} ${esc(b.currency)}${fxd}. Al cambio di oggi: esborso ${fmtEur(c.cost_total_eur / r)},
      cedole nette totali ${fmtEur(c.coupons_net_total_eur / r)}, rimborso netto ${fmtEur(c.redemption_net_eur / r)}.
      Il rendimento mostrato è <b>in ${esc(b.currency)}</b>: in euro sarà più alto se la valuta si rafforza, più basso se si svaluta. Nessuno conosce il cambio futuro: un rendimento alto in valuta riflette di solito un'inflazione alta e una svalutazione attesa.</div>`;
  }

  // ---------------- diagnostica ----------------
  function openDiag() {
    const m = state.meta; const B = state.bonds;
    const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
    const pct = (n, d) => d ? `${n} (${(n / d * 100).toFixed(0)}%)` : n;
    const dev = B.filter(b => b.check && b.check.ytm_gross_vs_bi != null && b._years > 0.5);
    const within = t => dev.filter(b => Math.abs(b.check.ytm_gross_vs_bi) <= t).length;
    const tax = B.filter(b => b.check && "tax_rate_confirmed" in b.check);
    const taxc = v => tax.filter(b => b.check.tax_rate_confirmed === v).length;
    const q = m.price_quality || {};
    const anomalies = B.filter(b => (b.anomalies || []).length);
    const runAt = new Date(m.run_at);
    $("#diag-body").innerHTML = `
      <h3>Ultimo aggiornamento</h3><table class="kv">
      ${row("Rilevazione", `${runAt.toLocaleDateString("it-IT")} ${runAt.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`)}
      ${row("Durata / richieste", `${Math.round((m.duration_s || 0) / 60)} min / ${m.requests || "–"}`)}
      ${row("Versioni", Object.entries(m.versions || {}).map(([k, v]) => `${k} ${v}`).join(", ") + `, app ${APP_VERSION}`)}
      ${row("Cambi BCE", m.fx && m.fx.date ? `${fmtDate(m.fx.date)}, ${Object.keys(m.fx.rates).length} valute` : "non disponibili")}
      ${row("Titoli letti / falliti", `${m.n_total} / ${m.n_failed}`)}
      ${m.by_market ? row("Per mercato", Object.entries(m.by_market).map(([k, v]) => `${k === "ETLX" ? "EuroTLX" : k} ${v}`).join(", ") + (m.n_both_markets ? ` (${m.n_both_markets} su entrambi)` : "")) : ""}
      ${row("Con rendimento calcolato", pct(m.n_computable, m.n_total))}
      </table>
      <h3>Tipi di titolo</h3><table class="kv">${Object.entries(m.by_kind || {}).map(([k, v]) => row(KIND_LABEL[k] || k, v)).join("")}</table>
      <h3>Qualità dei prezzi</h3><table class="kv">
      ${row("Con ask (prezzo di vendita reale)", pct(q.ask || (m.price_source || {}).ask || 0, m.n_total))}
      ${row("Riferimento, scambiato oggi", q.traded ?? "–")}${row("Riferimento, non scambiato oggi", q.quiet ?? "–")}${row("Fermo (mai scambiato nell'anno)", q.stale ?? "–")}
      </table>
      <h3>Verifica incrociata con i dati di mercato</h3><table class="kv">
      ${row("Titoli confrontabili (scadenza > 6 mesi)", dev.length)}
      ${row("YTM lordo entro 0,02 punti", pct(within(0.02), dev.length))}${row("entro 0,05", pct(within(0.05), dev.length))}${row("oltre 0,25 (esclusi come incerti)", dev.length - within(0.25))}
      ${row("Aliquota confermata / non discriminante / contraddetta", `${taxc(true)} / ${taxc(null)} / ${taxc(false)}`)}
      ${row("Titoli con note tecniche", anomalies.length)}
      </table>
      ${m.failed && m.failed.length ? `<h3>Falliti</h3><table class="kv">${m.failed.map(f => row(f.isin, esc(f.error))).join("")}</table>` : ""}
      <h3>Note tecniche (prime 100)</h3><table class="kv">${anomalies.slice(0, 100).map(b => row(`<span data-isin="${b.isin}" class="lnk">${esc(b.name)}</span><br><span class="small">${b.isin}</span>`, b.anomalies.map(esc).join("<br>"))).join("")}</table>`;
    $("#diag").classList.remove("hidden");
  }
  $("#btn-diag").addEventListener("click", openDiag);

  // ---------------- impostazioni ----------------
  function openSettings() {
    const s = state.settings;
    $("#s-nominal").value = s.nominal; $("#s-pct").value = s.commissionPct; $("#s-min").value = s.commissionMin;
    $("#s-max").value = s.commissionMax ?? ""; $("#s-bollo").value = s.bolloRate;
    $("#s-taxgov").value = s.taxGov ?? 12.5; $("#s-taxother").value = s.taxOther ?? 26;
    $("#settings").classList.remove("hidden");
  }
  $("#s-save").addEventListener("click", () => {
    const num = (id, d) => { const v = parseFloat($(id).value); return isNaN(v) ? d : v; };
    const maxv = $("#s-max").value.trim();
    state.settings = { nominal: num("#s-nominal", DEFAULTS.nominal), commissionPct: num("#s-pct", DEFAULTS.commissionPct), commissionMin: num("#s-min", DEFAULTS.commissionMin),
      commissionMax: maxv === "" ? null : parseFloat(maxv), bolloRate: num("#s-bollo", DEFAULTS.bolloRate),
      taxGov: num("#s-taxgov", DEFAULTS.taxGov), taxOther: num("#s-taxother", DEFAULTS.taxOther) };
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
  $("#s-taxpreset").addEventListener("change", e => {
    if (e.target.value === "it") { $("#s-taxgov").value = 12.5; $("#s-taxother").value = 26; $("#s-bollo").value = 0.2; }
    if (e.target.value === "none") { $("#s-taxgov").value = 0; $("#s-taxother").value = 0; $("#s-bollo").value = 0; }
  });
  ["#s-taxgov", "#s-taxother", "#s-bollo"].forEach(id => $(id).addEventListener("input", () => { $("#s-taxpreset").value = ""; }));
  $("#s-reset").addEventListener("click", () => { state.settings = { ...DEFAULTS }; saveSettings(state.settings); openSettings(); });

  // ---------------- eventi ----------------
  $("#btn-settings").addEventListener("click", openSettings);
  document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", e => e.target.closest(".modal").classList.add("hidden")));
  document.querySelectorAll(".modal").forEach(m => m.addEventListener("click", e => { if (e.target === m) m.classList.add("hidden"); }));
  document.addEventListener("keydown", e => { if (e.key === "Escape") document.querySelectorAll(".modal").forEach(m => m.classList.add("hidden")); });
  document.addEventListener("click", async e => {
    const lk = e.target.closest("button.link[data-isin], .lnk[data-isin]"); if (lk) { openDetail(lk.dataset.isin); return; }
    const fv = e.target.closest("[data-fav]"); if (fv) { toggleFav(fv.dataset.fav); return; }
    const cp = e.target.closest("[data-copy]");
    if (cp) {
      const txt = cp.dataset.copy; let ok = false;
      try { await navigator.clipboard.writeText(txt); ok = true; } catch {}
      if (!ok) { const ta = document.createElement("textarea"); ta.value = txt; document.body.appendChild(ta); ta.select(); try { ok = document.execCommand("copy"); } catch {} ta.remove(); }
      const old = cp.textContent; cp.textContent = ok ? "✓ copiato" : "non riuscito"; setTimeout(() => { cp.textContent = old; }, 1500);
      return;
    }
    if (e.target.closest(".cmp, button, a, input, label, form")) return;   // pulsanti e campi non aprono la scheda
    const el = e.target.closest("[data-isin]"); if (el) openDetail(el.dataset.isin);
  });
  $("#cat-chips").addEventListener("click", e => { const c = e.target.closest(".chip"); if (!c) return;
    $$("#cat-chips .chip").forEach(x => x.classList.toggle("on", x === c)); state.cat = c.dataset.cat; applyFilters(); });
  ["#q", "#f-kind", "#f-ymin", "#f-ymax", "#f-nmin", "#f-lot", "#f-cmin", "#f-ask", "#f-nominus", "#f-uncertain", "#f-strips", "#f-inst"].forEach(id => $(id).addEventListener("input", applyFilters));
  function resetFilters() { (state.activeFilters || []).forEach(a => a.reset()); applyFilters(); }
  $("#filter-reset").addEventListener("click", resetFilters);
  $("#filter-close").addEventListener("click", () => { $("details.more").removeAttribute("open"); window.scrollTo({ top: 0, behavior: "smooth" }); });
  $("#active-filters").addEventListener("click", e => {
    const btn = e.target.closest("[data-af]"); if (!btn) return;
    if (btn.dataset.af === "all") return resetFilters();
    const a = (state.activeFilters || [])[+btn.dataset.af]; if (a) { a.reset(); applyFilters(); }
  });
  $("#sort").addEventListener("change", () => { sortList(); state.shown = PAGE; render(); syncHash(); });

  // ---------------- esporta CSV della lista filtrata ----------------
  function exportCSV() {
    const cols = [["ISIN", b => b.isin], ["Nome", b => b.name], ["Emittente", b => b.issuer], ["Categoria", b => CAT_LABEL[b._cat]], ["Paese", b => b.country], ["Mercato", b => (b.markets || [b.market]).join("+")],
      ["Valuta", b => b.currency], ["Scadenza", b => b.maturity], ["Anni", b => num(b._years, 2)], ["Tipo", b => KIND_LABEL[b.kind]], ["Cedola %", b => num(b.coupon_annual, 3)], ["Frequenza", b => FREQ_LABEL[b.coupon_frequency] || ""],
      ["Prezzo", b => num(b._price, 3)], ["Fonte prezzo", b => quality(b)], ["Rateo netto", b => b._calc ? num(b._calc.accrued_net, 3) : ""], ["Lotto minimo", b => b.min_lot],
      ["Netto annuo %", b => pct(b._calc && b._calc.ytm_net_all)], ["Di cui da cedola %", b => pct(b._calc && b._calc.coupon_net_yield)], ["Di cui da prezzo %", b => pct(b._calc && b._calc.price_yield)],
      ["Totale a scadenza %", b => b._calc && b._calc.cost_total_eur > 0 ? pct(b._calc.net_gain_total_eur / b._calc.cost_total_eur) : ""], ["YTM lordo %", b => pct(b._calc && b._calc.ytm_gross)],
      ["YTM netto solo tasse %", b => pct(b._calc && b._calc.ytm_net_tax)], ["Spread vs BTP", b => pct(b._calc && b._calc.spread_btp)], ["Spread vs Bund", b => pct(b._calc && b._calc.spread_bund)],
      ["Duration mod.", b => b._calc ? num(b._calc.mod_duration, 2) : ""], ["Aliquota %", b => num(taxOf(b) * 100, 1)], ["Incerto", b => b._uncertain || ""], ["Preferito", b => state.favs.has(b.isin) ? "sì" : ""]];
    const num = (v, d) => v == null ? "" : v.toFixed(d).replace(".", ",");
    const pct = v => v == null ? "" : (v * 100).toFixed(3).replace(".", ",");
    const cell = v => { const t = String(v ?? ""); return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const lines = [cols.map(c => cell(c[0])).join(";"), ...state.filtered.map(b => cols.map(c => cell(c[1](b))).join(";"))];
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });   // BOM: Excel italiano apre con ; e virgola decimale
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `bond-netto-${state.meta.trade_date}.csv`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  $("#btn-csv").addEventListener("click", exportCSV);

  // ---------------- filtri nell'URL (link condivisibile) ----------------
  const HASH_FIELDS = { q: "#q", kind: "#f-kind", ymin: "#f-ymin", ymax: "#f-ymax", nmin: "#f-nmin", cmin: "#f-cmin", lot: "#f-lot",
    inst: "#f-inst", unc: "#f-uncertain", strips: "#f-strips", ask: "#f-ask", nominus: "#f-nominus", sort: "#sort" };
  const HASH_DEFAULT = { kind: "computable", ymin: "0", sort: "ytm_net_all:desc" };
  function syncHash() {
    const u = new URLSearchParams();
    for (const [k, sel] of Object.entries(HASH_FIELDS)) { const el = $(sel); const v = el.type === "checkbox" ? (el.checked ? "1" : "") : el.value; if (v && v !== (HASH_DEFAULT[k] ?? "")) u.set(k, v); }
    if (state.cat !== "all") u.set("cat", state.cat);
    for (const name of Object.keys(FACETS)) if (!setEq(facetSel[name], FACETS[name].def)) u.set(name, [...facetSel[name]].join(","));
    const h = u.toString(); history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
  }
  function applyHash() {
    const h = location.hash.replace(/^#/, ""); if (!h) return false;
    const u = new URLSearchParams(h); let any = false;
    for (const [k, sel] of Object.entries(HASH_FIELDS)) {
      const el = $(sel); const v = u.get(k); if (v == null) continue; any = true;
      if (el.type === "checkbox") el.checked = v === "1"; else if (el.tagName === "SELECT") { if ([...el.options].some(o => o.value === v)) el.value = v; }
      else if (el.type === "number") { if (v !== "" && isFinite(parseFloat(v))) el.value = v; } else el.value = v;   // numeri non validi nel link: resta il default
    }
    for (const name of Object.keys(FACETS)) { const v = u.get(name); if (v == null) continue; any = true; facetSel[name] = new Set(v.split(",").filter(Boolean)); renderFacetButton(name); }
    const cat = u.get("cat"); if (cat && $(`[data-cat="${cat}"]`)) { state.cat = cat; $$("#cat-chips .chip").forEach(x => x.classList.toggle("on", x.dataset.cat === cat)); any = true; }
    return any;
  }
  $("#btn-share").addEventListener("click", async () => {
    syncHash(); const url = location.href; let ok = false;
    try { if (navigator.share) { await navigator.share({ title: "Bond Netto: selezione", url }); ok = true; } } catch {}
    if (!ok) { try { await navigator.clipboard.writeText(url); ok = true; } catch {} }
    const b = $("#btn-share"); const old = b.textContent; b.textContent = ok ? "✓ link copiato" : "non riuscito"; setTimeout(() => { b.textContent = old; }, 1800);
  });
  $("#more-btn").addEventListener("click", () => { state.shown += PAGE; render(); });

  // ---------------- avvio ----------------
  async function load() {
    try {
      const r = await fetch("data/bonds.json", { cache: "no-cache" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      state.meta = d.meta; state.bonds = d.bonds;
      recompute();
      // default: solo EUR. I rendimenti in TRY/BRL/MXN sono "veri" nella loro valuta ma privi di senso in euro
      // (la valuta si svaluta quanto rende): finché manca la conversione in EUR, le altre valute vanno scelte apposta.
      for (const name of Object.keys(FACETS)) renderFacetButton(name);
      applyHash();   // filtri da link condiviso (sovrascrivono i default)
      updateFavChip();
      const runAt = new Date(d.meta.run_at);
      const mk = d.meta.by_market || {}; const mkTxt = Object.keys(mk).length > 1 ? "MOT+EuroTLX" : (Object.keys(mk)[0] || "MOT");
      $("#meta").textContent = `${d.meta.n_total} titoli · ${runAt.toLocaleDateString("it-IT")} ${runAt.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })} · ${d.meta.n_computable} calcolati`;
      $("#meta").title = `${mkTxt}: prezzi rilevati il ${runAt.toLocaleDateString("it-IT")} alle ${runAt.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}; ${d.meta.n_computable} titoli con rendimento calcolato su ${d.meta.n_total}`;
      applyFilters();
      renderAuctions();
      if (window.BondAlerts) BondAlerts.evaluateAll();
    } catch (e) {
      $("#meta").textContent = "Dati non disponibili: " + e.message;
    }
  }
  window.BondApp = { $, state, params, fmtPct, fmtNum, fmtEur, fmtCur, fmtDate, esc, priceBadge, openDetail, toggleFav, reliable, quality };
  load();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
