/* alerts.js — v0.1.0 — Avvisi: regole su rendimento/prezzo valutate a ogni apertura dell'app.
   Le stesse regole, esportate in alerts.json nel repository, vengono valutate anche dal job giornaliero
   (scraper/run_daily.py: evaluate_alerts) che apre una Issue su GitHub -> email di notifica. */
(() => {
  "use strict";
  const A = window.BondApp;
  const { $, fmtPct, fmtNum, fmtDate, esc } = A;
  const KEY = "bond-alerts-v1";
  const uid = () => Math.random().toString(36).slice(2, 10);
  const METRICS = { ytm_net_all: "YTM netto all-in", ytm_net_tax: "YTM netto (solo tasse)", ytm_gross: "YTM lordo", price: "Prezzo" };
  const CATS = { "": "qualsiasi categoria", gov_it: "Stato Italia", gov_fx: "Stati esteri", supra: "Sovranazionali", other: "Corporate e altri" };

  let rules = load();
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(rules)); } catch {} }

  function metricOf(b, m) { if (m === "price") return b._price; return b._calc ? b._calc[m] : null; }

  /** Valuta una regola: ritorna i titoli che la soddisfano (stessa semantica di evaluate_alerts in Python). */
  function matches(rule) {
    return A.state.bonds.filter(b => {
      if (rule.isin) { if (b.isin !== rule.isin.toUpperCase()) return false; }
      else {
        if (!b._calc || b._uncertain || b._strip) return false;           // solo titoli calcolabili e affidabili
        if (rule.cat && b._cat !== rule.cat) return false;
        if ((rule.currency || "EUR") !== "*" && b.currency !== (rule.currency || "EUR")) return false;
        if (rule.ymin != null && !(b._years >= rule.ymin)) return false;
        if (rule.ymax != null && !(b._years <= rule.ymax)) return false;
      }
      const v = metricOf(b, rule.metric); if (v == null) return false;
      const x = rule.metric === "price" ? v : v * 100;
      return rule.op === ">=" ? x >= rule.value : x <= rule.value;
    });
  }

  function describe(r) {
    const scope = r.isin ? `ISIN ${r.isin}` : `${CATS[r.cat || ""]}, ${r.currency === "*" ? "tutte le valute" : (r.currency || "EUR")}${r.ymin != null || r.ymax != null ? `, ${r.ymin ?? 0}–${r.ymax ?? "∞"} anni` : ""}`;
    return `${METRICS[r.metric]} ${r.op} ${r.metric === "price" ? fmtNum(r.value) : fmtNum(r.value) + "%"} · ${scope}`;
  }

  function evaluateAll() {
    const out = rules.map(r => ({ rule: r, hits: matches(r) })).filter(x => x.hits.length);
    const n = out.reduce((s, x) => s + x.hits.length, 0);
    const btn = $("#btn-alerts"); btn.classList.toggle("has", n > 0); btn.title = n ? `${n} avvisi scattati` : "Avvisi";
    return out;
  }

  function open() {
    const fired = evaluateAll();
    const list = rules.length ? rules.map(r => `<tr><td>${esc(describe(r))}${r.label ? `<br><span class="small">${esc(r.label)}</span>` : ""}</td><td>${matches(r).length} titoli <button class="link" data-alert-del="${r.id}">✕</button></td></tr>`).join("") : "";
    const firedHTML = fired.length ? fired.map(x => `<h4 class="sub">${esc(describe(x.rule))}</h4><div class="list">${x.hits.slice(0, 20).map(b => `<div class="card" data-isin="${b.isin}"><div class="c-name"><div class="name">${esc(b.name)}</div><div class="meta"><span>${b.isin}</span><span>scad. ${fmtDate(b.maturity)}</span><span>${fmtNum(b._price)} ${A.priceBadge(b)}</span></div></div><div class="c-net"><div class="main">${b._calc ? fmtPct(b._calc.ytm_net_all) : "–"}</div></div></div>`).join("")}${x.hits.length > 20 ? `<p class="hint">… e altri ${x.hits.length - 20}</p>` : ""}</div>`).join("")
      : `<p class="hint">Nessun avviso scattato con i dati di oggi.</p>`;
    $("#alerts-body").innerHTML = `
      <h3>Avvisi scattati oggi</h3>${firedHTML}
      <h3>Regole</h3>${list ? `<table class="kv">${list}</table>` : `<p class="hint">Nessuna regola. Esempi: "YTM netto all-in ≥ 3,5% tra gli Stati esteri in EUR a 5–10 anni", oppure "prezzo ≤ 95 per ISIN IT0005377152".</p>`}
      <form id="alert-form" class="inline-form">
        <select name="metric">${Object.entries(METRICS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
        <select name="op"><option value=">=">≥</option><option value="<=">≤</option></select>
        <input name="value" type="number" step="any" placeholder="valore (% o prezzo)" required>
        <input name="isin" placeholder="ISIN (vuoto = filtro)" autocomplete="off">
        <select name="cat">${Object.entries(CATS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
        <select name="currency"><option value="EUR">EUR</option><option value="*">tutte le valute</option>${[...new Set(A.state.bonds.map(b => b.currency))].filter(c => c && c !== "EUR").sort().map(c => `<option value="${c}">${c}</option>`).join("")}</select>
        <input name="ymin" type="number" step="any" min="0" placeholder="anni min"><input name="ymax" type="number" step="any" min="0" placeholder="anni max">
        <input name="label" placeholder="nota (facoltativa)">
        <button class="btn" type="submit">Aggiungi regola</button></form>
      <h3>Notifica via email</h3>
      <p class="hint">L'app controlla le regole quando la apri. Per ricevere un'email quando il job giornaliero le trova scattate:
        copia il testo qui sotto nel file <code>alerts.json</code> del repository (GitHub → bond-app → Add file / modifica → Commit). Il job apre una "Issue" e GitHub ti manda l'email.</p>
      <div class="row"><button class="btn ghost" id="alerts-copy" data-copy="${esc(JSON.stringify(rules.map(({ id, ...r }) => r)))}">⧉ Copia alerts.json</button>
        <a class="btn ghost" href="https://github.com/glc87/bond-app/edit/main/alerts.json" target="_blank" rel="noopener">Apri alerts.json su GitHub ↗</a></div>`;
    $("#alerts").classList.remove("hidden");
  }

  document.addEventListener("submit", e => {
    if (e.target.getAttribute("id") !== "alert-form") return;
    e.preventDefault(); const f = e.target;
    const num = v => v === "" ? null : parseFloat(v);
    rules.push({ id: uid(), metric: f.metric.value, op: f.op.value, value: parseFloat(f.value.value), isin: f.isin.value.trim().toUpperCase() || null,
      cat: f.cat.value || null, currency: f.currency.value, ymin: num(f.ymin.value), ymax: num(f.ymax.value), label: f.label.value.trim() || null });
    save(); open();
  });
  document.addEventListener("click", e => {
    const d = e.target.closest("[data-alert-del]"); if (d) { rules = rules.filter(r => r.id !== d.dataset.alertDel); save(); open(); }
  });
  $("#btn-alerts").addEventListener("click", open);
  window.BondAlerts = { evaluateAll, open };
})();
