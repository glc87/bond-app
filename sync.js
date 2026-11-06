/* sync.js — v0.1.1 — Bond Netto: sincronizzazione con il repository GitHub (avvisi e portafoglio) senza copia-incolla.
   - Token "fine-grained" personale, limitato al solo repository, permesso Contents: lettura e scrittura. Resta su questo dispositivo.
   - alerts.json va in chiaro (il job giornaliero deve leggerlo). Il portafoglio e' cifrato (AES-GCM, chiave da passphrase con
     PBKDF2) perche' il repository e' pubblico: senza passphrase il file user/portfolio.enc non dice nulla. */
(() => {
  "use strict";
  const A = window.BondApp; const { $, esc } = A;
  const KEY = "bond-gh";
  const DEFAULT_REPO = "glc87/bond-app";
  function cfg() { try { return { repo: DEFAULT_REPO, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return { repo: DEFAULT_REPO }; } }
  function saveCfg(c) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch {} }
  const ready = () => { const c = cfg(); return !!(c.token && c.repo); };

  // ---------- API GitHub (contents) ----------
  async function gh(path, opts = {}) {
    const c = cfg();
    const r = await fetch(`https://api.github.com/repos/${c.repo}/contents/${path}`, {
      cache: "no-store", ...opts, headers: { Authorization: `Bearer ${c.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) } });
    if (r.status === 404) return null;
    if (!r.ok) { let msg = `HTTP ${r.status}`; try { msg += ": " + (await r.json()).message; } catch {} throw new Error(msg); }
    return r.json();
  }
  // base64 a blocchi: String.fromCharCode(...array) esplode lo stack oltre ~100k byte
  const bytesToB64 = u8 => { let s = ""; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s); };
  const b64enc = s => bytesToB64(new TextEncoder().encode(s));
  const b64dec = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), ch => ch.charCodeAt(0)));
  async function getFile(path) { const j = await gh(path + "?ref=main"); return j ? { sha: j.sha, text: b64dec(j.content) } : null; }
  async function putFile(path, text, message) {
    const cur = await getFile(path);
    if (cur && cur.text === text) return { unchanged: true };
    const body = { message, content: b64enc(text), branch: "main" }; if (cur) body.sha = cur.sha;
    return gh(path, { method: "PUT", body: JSON.stringify(body) });
  }

  // ---------- cifratura portafoglio ----------
  const te = new TextEncoder(), td = new TextDecoder();
  async function deriveKey(pass, salt) {
    const base = await crypto.subtle.importKey("raw", te.encode(pass), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  const hex = u8 => [...u8].map(b => b.toString(16).padStart(2, "0")).join("");
  const unhex = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));
  async function encrypt(text, pass) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pass, salt);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(text)));
    return JSON.stringify({ v: 1, kdf: "PBKDF2-SHA256-200000", salt: hex(salt), iv: hex(iv), data: bytesToB64(ct) });
  }
  async function decrypt(blob, pass) {
    const j = JSON.parse(blob); const key = await deriveKey(pass, unhex(j.salt));
    const ct = Uint8Array.from(atob(j.data), ch => ch.charCodeAt(0));
    return td.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unhex(j.iv) }, key, ct));
  }

  // ---------- operazioni ----------
  async function saveAlerts(rules) {
    const text = JSON.stringify(rules, null, 1) + "\n";
    return putFile("alerts.json", text, "Avvisi aggiornati dall'app");
  }
  const canon = d => JSON.stringify({ positions: d.positions || [], minus: d.minus || [], sales: d.sales || [] });   // senza data di esportazione
  async function savePortfolio(data) {
    const c = cfg(); if (!c.pass) throw new Error("Imposta una passphrase nelle Impostazioni (serve per cifrare il portafoglio).");
    // il cifrato cambia a ogni chiamata (salt e iv casuali): per evitare commit inutili confronto il contenuto decifrato
    const cur = await getFile("user/portfolio.enc");
    if (cur) { try { if (canon(JSON.parse(await decrypt(cur.text.trim(), c.pass))) === canon(data)) return { unchanged: true }; } catch {} }
    return putFile("user/portfolio.enc", await encrypt(JSON.stringify(data), c.pass) + "\n", "Backup portafoglio (cifrato) dall'app");
  }
  async function loadPortfolio() {
    const c = cfg(); if (!c.pass) throw new Error("Imposta la passphrase nelle Impostazioni.");
    const f = await getFile("user/portfolio.enc"); if (!f) throw new Error("Nessun backup sul repository.");
    try { return JSON.parse(await decrypt(f.text.trim(), c.pass)); } catch { throw new Error("Passphrase errata o file danneggiato."); }
  }
  async function test() {
    const c = cfg(); const r = await fetch(`https://api.github.com/repos/${c.repo}`, { headers: { Authorization: `Bearer ${c.token}`, Accept: "application/vnd.github+json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}: token o repository non validi`);
    const j = await r.json(); const perm = j.permissions || {};
    if (!perm.push) throw new Error("Il token non ha il permesso di scrittura (Contents: Read and write).");
    return `ok: ${j.full_name}${j.private ? " (privato)" : " (pubblico: il portafoglio viene cifrato)"}`;
  }

  // ---------- UI nelle impostazioni ----------
  function settingsHTML() {
    const c = cfg();
    return `<h3>Sincronizzazione GitHub (avvisi via email, backup portafoglio)</h3>
      <p class="hint">Con un token personale l'app scrive da sola <code>alerts.json</code> nel repository (il job giornaliero apre una Issue e GitHub ti manda l'email) e salva un backup <b>cifrato</b> del portafoglio, recuperabile da un altro telefono con la passphrase.
      Crea il token su GitHub → Settings → Developer settings → Personal access tokens → <b>Fine-grained</b>: Repository access = <i>Only select repositories</i> → bond-app; Permissions → Repository → <b>Contents: Read and write</b>. Scadenza a tua scelta (max 1 anno). Il token resta solo su questo dispositivo.</p>
      <div class="grid">
        <label>Repository <input id="gh-repo" value="${esc(c.repo)}" autocomplete="off"></label>
        <label>Token (github_pat_…) <input id="gh-token" type="password" value="${esc(c.token || "")}" autocomplete="off"></label>
        <label>Passphrase per cifrare il portafoglio <input id="gh-pass" type="password" value="${esc(c.pass || "")}" autocomplete="off"></label>
      </div>
      <div class="row"><button type="button" class="btn ghost" id="gh-save">Salva</button><button type="button" class="btn ghost" id="gh-test">Prova collegamento</button><span id="gh-msg" class="hint"></span></div>`;
  }
  function mountSettings() {
    const host = $("#gh-settings"); if (!host) return;
    host.innerHTML = settingsHTML();
    $("#gh-save").addEventListener("click", () => { saveCfg({ repo: $("#gh-repo").value.trim() || DEFAULT_REPO, token: $("#gh-token").value.trim(), pass: $("#gh-pass").value }); $("#gh-msg").textContent = "salvato su questo dispositivo"; });
    $("#gh-test").addEventListener("click", async () => { saveCfg({ repo: $("#gh-repo").value.trim() || DEFAULT_REPO, token: $("#gh-token").value.trim(), pass: $("#gh-pass").value }); $("#gh-msg").textContent = "…"; try { $("#gh-msg").textContent = await test(); } catch (e) { $("#gh-msg").textContent = "errore: " + e.message; } });
  }
  $("#btn-settings").addEventListener("click", mountSettings);

  // pulsanti nelle finestre Avvisi e Portafoglio (inseriti da alerts.js / portfolio.js tramite BondSync.buttons)
  function alertsButton() { return ready() ? `<button type="button" class="btn primary" id="gh-alerts">☁ Salva alerts.json su GitHub</button>` : `<span class="hint">Per salvarlo da qui senza copia-incolla: configura il token GitHub nelle Impostazioni ⚙.</span>`; }
  function portfolioButtons() { return ready() ? `<button type="button" class="btn ghost" id="gh-pf-save">☁ Backup cifrato su GitHub</button><button type="button" class="btn ghost" id="gh-pf-load">☁ Ripristina da GitHub</button>` : `<span class="hint">Backup automatico su GitHub: configura token e passphrase nelle Impostazioni ⚙.</span>`; }
  const flash = (btn, msg, ok) => { const old = btn.textContent; btn.textContent = msg; btn.disabled = true; setTimeout(() => { btn.textContent = old; btn.disabled = false; }, ok ? 2500 : 5000); };
  document.addEventListener("click", async e => {
    const a = e.target.closest("#gh-alerts");
    if (a) { a.textContent = "…"; try { const r = await saveAlerts(BondAlerts.rules()); flash(a, r.unchanged ? "✓ già aggiornato" : "✓ salvato: il job di oggi lo userà", true); } catch (err) { flash(a, "errore: " + err.message, false); } return; }
    const s = e.target.closest("#gh-pf-save");
    if (s) { s.textContent = "…"; try { const r = await savePortfolio(BondPortfolio.exportData()); flash(s, r.unchanged ? "✓ già aggiornato" : "✓ backup salvato", true); } catch (err) { flash(s, "errore: " + err.message, false); } return; }
    const l = e.target.closest("#gh-pf-load");
    if (l) { if (!confirm("Sostituire il portafoglio su questo dispositivo con il backup su GitHub?")) return; l.textContent = "…"; try { BondPortfolio.importData(await loadPortfolio()); } catch (err) { flash(l, "errore: " + err.message, false); } return; }
  });

  window.BondSync = { ready, cfg, saveAlerts, savePortfolio, loadPortfolio, encrypt, decrypt, alertsButton, portfolioButtons, test, VERSION: "0.1.0" };
})();
