# Changelog

## 2026-11-04
- borsa_italiana.py v0.1.0: parser liste/scheda/dati completi, client con rate limit e retry.
- yields.py v0.1.1: motore rendimenti (T+2 TARGET, ACT/ACT, tasse, commissioni, bollo), più
  campo `ytm_net_bi_convention` per la verifica incrociata con Borsa Italiana.
- run_daily.py v0.1.0: orchestratore, output bonds.json / meta.json / history.
- Verifica su BTP 3,1% Mz40 (prezzo rif. 85,25 del 03/11/2026): rateo identico a BI (0,55663),
  YTM lordo 4,642 vs 4,64 BI; il "netto" BI (4,21) non tassa la plusvalenza, il nostro (4,09) sì.
- Primo run reale su GitHub Actions (15 BTP/strip): 15/15 calcolati, tutti con ask dal book.
- yields.py v0.1.2: la verifica "convenzione BI" per gli zero coupon usa il netto tassato
  (BI tassa lo scarto di emissione degli ZC, non la plusvalenza dei titoli con cedola).
- yields.py v0.1.3 / app.js v0.1.1: default commissioni 0,19% min 5 € max 19 € (verificati Fineco e ING); bollo 0,2% confermato anche sui BTP.
- Workflow: rebase su origin/main prima del push (il primo run completo, 1820 titoli / 1449 calcolabili / 0 falliti in 94', aveva perso i dati per push rifiutato); delay 0,6 s.
- Analisi del primo run completo (1820 titoli): correzioni v0.2.x
  * scadenze a 2 cifre oltre il 2069 e 2117/2120 lette come 19xx/20xx: ora, se la data letta è passata, +100 anni
  * titoli "Tf 0%" (61) trattati come zero coupon calcolabili
  * indicizzati esteri (Oatei, Obligacionesei, Bundei, Btpi-) esclusi dal calcolo
  * aliquota: agenzie (KfW, Rentenbank, CDP, AFD...) al 26% anche se BI le etichetta "stato esteri";
    sovrani per nome; deduzione dai netti BI solo con segnale forte (gap >0,15), altrimenti "non discriminante"
  * prima cedola corta: rateo ACT/ACT ICMA su periodo regolare e prima cedola ridotta (Schatz, Bund, UE nuove emissioni)
  * verifica BI: per i "Tf 0%" convenzione "con cedola", per strip/BOT/Zc convenzione "scarto tassato"
  * esito rielaborazione offline: 1486 calcolabili; 1342/1387 entro 0,02 dal YTM lordo BI
- v0.2.2 / app v0.2.0: qualità del prezzo (ask / scambiato oggi / non scambiato / fermo). I 'fermi' (nessun ask, nessuno scambio nell'anno, es. strip IT0005498727 a 91,80 = 8%) sono esclusi da classifiche e lista di default. Salvati contratti, volumi e min/max annuo.
- app v0.2.1: profili commissioni per banca nelle Impostazioni; run_daily v0.2.3: salvata 'Data stacco prima cedola' per la futura correzione prima cedola lunga/corta.
- app v0.3.x: confronto fianco a fianco (max 4), vista tabella su desktop, grafico storico nella scheda
  (serie per titolo in data/series/, generate da run_daily v0.3.0 dal 05/11), filtro valuta default EUR,
  dato principale = YTM netto all-in (il netto semplice gonfiava i titoli lunghi a forte sconto).
- app v0.3.3: titoli 'incerti' (prezzo fermo/non aggiornato, verifica BI non superata) e strip nascosti di default, riattivabili nei filtri avanzati; badge e nota in scheda.
- run_daily v0.4.0 / borsa_italiana v0.3.0: 2 richieste in parallelo con ritmo globale (--workers, --delay 0,5), salto nei
  giorni di chiusura Borsa Italiana (15/8, 24/12, 31/12 + TARGET), cambi BCE in meta.fx.
- app v0.4.0: pagina Diagnostica (ⓘ), equivalenti in euro per i titoli in valuta con avvertenza cambio, importi nella valuta del titolo.
- app v0.5.0 / portfolio.js v0.1.0: portafoglio sul dispositivo (posizioni con costo effettivo, cedole incassate, latente,
  YTM netto bloccato al carico), calendario cedole/rimborsi 12 mesi, zainetto fiscale (manuale + previsto), backup JSON.
  Verificato a mano su BTP 6,5% Nv27 comprato a 103,18 il 04/11/2024.
- Deploy Pages delle 19:41 fallito per timeout (rilanciato). run_daily v0.4.1: serie storiche in 64 file (hash ISIN, stessa
  formula in app.js) invece di uno per titolo. app v0.5.1: tasto copia ISIN nella scheda; sw.js v0.2.0 rete-prima
  (gli aggiornamenti arrivano al primo refresh, cache solo offline).
- portfolio.js v0.2.0: vendite parziali con plus/minus realizzate (minus -> zainetto automatico). app v0.6.0 / alerts.js v0.1.0:
  avvisi (regole su rendimento/prezzo per ISIN o filtro), valutati all'apertura; run_daily v0.5.0 valuta alerts.json nel
  repository e il workflow apre una Issue (email GitHub). Stessa semantica JS/Python verificata (25/25).
- app v0.5.2: i clic su pulsanti e campi non aprono più la scheda del titolo.
- app v0.6.1: un solo rendimento in evidenza (netto annuo all-in) con scomposizione "da cedola / da prezzo";
  ordinamenti ridotti a rendimento netto, cedola netta, guadagno da prezzo, scadenza, prezzo, nome; filtro cedola netta min.
  Le altre misure (YTM lordo, netto solo tasse, semplice) restano solo nella scheda per confronto con altri siti.
- 2026-11-05: run schedulato di ieri sera fallito (fetch_ecb_rates persa in un refactor): ripristinata; nuovo test_e2e.py
  (server finto, main() eseguita davvero) nel workflow prima dello scraping.
- yields v0.3.0 / yields.js v0.3.0 / run_daily v0.5.2: prima cedola irregolare con 'Data stacco prima cedola' (verifica contro BI in corso sui dati del 05/11).
- 2026-11-05 run 14:41 (2 worker): 1821 titoli in 34', 1487 calcolabili, 0 falliti. Verifica YTM lordo vs BI (>6 mesi):
  1306/1387 entro 0,01; EUR 98,9% entro 0,02. "Data stacco prima cedola" di BI coincide sempre col godimento (campo inutile):
  la gestione prima cedola irregolare resta nel codice ma è inattiva. Dove il rateo BI differisce (Bund 3,4% 2047, Romania USD,
  Svezia) lo YTM coincide entro 0,005: il campo rateo BI su quei titoli usa una convenzione diversa; non si insegue oltre.
- app v0.7.1: sezione 'Prossime aste del Tesoro' da data/aste.json (calendario MEF 2026, 57 aste; da rinnovare a gennaio 2027).
- run_daily v0.6.0 / app v0.8.x: regime fiscale personalizzabile; indicatore di liquidità su 20 rilevazioni (badge 'poco liquido' <50%, ordinamento).
- eurotlx.py v0.1.0 + run_daily v0.7.0: seconda fonte EuroTLX (~2.000 titoli: corporate, bancari, emergenti, Treasury USA...),
  stesse strutture dati del MOT, merge per ISIN (ask più basso vince, entrambi i mercati annotati), tipologie EuroTLX
  mappate per aliquota e categoria. app v0.9.0: badge e filtro mercato, altro mercato in scheda, diagnostica.
- 2026-11-05 run 19:00 (MOT + EuroTLX, ~70'): 3.672 titoli (MOT 1.814, ETLX 1.858, 116 su entrambi), 2.801 calcolabili, 0 falliti.
  Verifica YTM lordo vs BI (>6 mesi): MOT 1.420/1.469 entro 0,02; EuroTLX solo 219/1.156 (mediana -0,04). Analisi:
  * nessuna convenzione alternativa (settle T+0, compounding periodico, 30/360, prezzo bid/ask/mid/ultimo) spiega lo scarto
    EuroTLX: alcuni titoli coincidono al centesimo (Wienerberger 4,22), altri no (Daimler 3,776 vs 3,82) con lo stesso prezzo
    di riferimento. Ipotesi: BI pubblica su EuroTLX il rendimento calcolato sul riferimento del giorno prima.
  * yields v0.3.3: nuove classi 'structured' (CMS/CMT, Fix To, cap&floor, autocall, Ind/Eq Link, credit linked, fondi,
    'Rv', multi coupon, perpetui) e 'amortizing' (Sink/Amort: Argentina, Uruguay, Perù, Pemex, Ipi): non calcolabili.
    Prima erano calcolati come fissi/callable con scarti da BI fino a 7 punti (Argentina 0,125% Sink: 6,7% vs 13,6% BI).
  * run_daily v0.7.2: zero coupon richiamabili quotati vicino alla pari con vita >5 anni (Citigroup/GS 'Gm Zc Call', prezzo
    implica <1,5% vs 4-6% BI) -> strutturati, non calcolabili. I ZC callable EBRD/ADB in TRY/ZAR/MXN restano calcolati
    (coincidono con BI entro 0,03). Nuovo check 'bi_vs_prev_ref' e riepilogo meta.bi_check per mercato: dal run di domani
    si verifica l'ipotesi del riferimento di ieri (history ora salva rif, YTM su rif e YTM BI).
  * 22 'tipologia non riconosciuta' -> 21 ora strutturati; resta Eib-99/29 Multi Coupon (strutturato).
- app v0.9.3: lotti istituzionali (taglio minimo >= 100.000) nascosti di default, riattivabili con "Mostra lotti istituzionali"
  nei filtri avanzati; badge sul lotto. 919 titoli su 3.672 (749 EuroTLX, 170 MOT); in EUR coi filtri di default 120 su 922.
- app v0.9.4 / app.css v0.2.1: filtri più leggibili: conteggio live nel pannello ("N titoli corrispondono"), pulsanti
  "Azzera filtri" e "Mostra risultati", campi modificati evidenziati, chip dei filtri attivi (rimovibili con ×) sempre visibili
  sotto "Filtri avanzati · N attivi".
- app v0.9.5 / app.css v0.2.2: rendimento totale a scadenza (guadagno netto / esborso, non annualizzato) in piccolo sotto il
  netto annuo in lista ("+3,60% in 7 mesi") e nella scheda accanto al guadagno in valuta. Colonne desktop riallineate.
- yields v0.3.4: nomi abbreviati di Borsa Italiana per i sovranazionali (EBRD "Banca Europea per la Ric e lo Svil",
  EFSF "European Financ Stability", UE, AIIB, CEB "Council of Europe Social Devel"): ora categoria "Sovranazionale"
  invece di "Stato estero" (172 titoli; aliquota invariata 12,5%). Effetto sui dati dal prossimo run.
- app v0.9.6 / app.css v0.2.3: pulsanti del pannello filtri distinti dai chip: "Mostra risultati ↓" pieno blu a tutta
  larghezza, "↺ Azzera filtri" grigio con bordo; chip dei filtri attivi a bordo tratteggiato su fondo azzurro chiaro.
- 06/11/2026 — verifica EuroTLX chiusa: a parità di prezzo di riferimento, i rendimenti pubblicati da BI su EuroTLX cambiano
  il mattino dopo e coincidono col nostro motore (Daimler 3,82→3,78 = nostro 3,78; UniCredit 4,15→4,10 = 4,10; Italgas 4,14→4,05
  = 4,05; rateo identico al 5° decimale in entrambi i giorni). BI calcola il rendimento EuroTLX sul riferimento del giorno prima.
  Nessuna modifica al motore; meta.bi_check dal run del 06/11 lo misura su tutti i titoli.
- yields v0.3.5 / yields.js v0.3.2: duration modificata (Macaulay/(1+y) su flussi lordi, ACT/365): coincide con quella di BI
  entro 0,02 su 1.907 titoli su 2.043 (entro 0,05: 2.001). Esposto first_coupon_factor. Tasso variabile anche per
  "Eur3m+", Euribor, Frn, Sofr, Sonia (Bnl/Mps covered erano calcolati come fissi).
- app v0.10.0 (app.css 0.2.5, sw 0.2.1): spread vs BTP (curva BTP come quella Bund) in lista, scheda, confronto e ordinamento;
  rischio tasso in scheda ("se i tassi salgono di 1 punto, prezzo −X% ≈ −N €"); ★ Preferiti con sezione dedicata (nei
  preferiti si vede tutto, anche incerti/istituzionali); ⬇ CSV della lista filtrata (; e virgola decimale, BOM per Excel);
  🔗 link condivisibile con i filtri nell'URL (#country=DE&nmin=2…), riaperto ripristina filtri e ordinamento.
- sim.js v0.1.0: simulatore "Se vendo prima della scadenza" in scheda (anni di detenzione, scenario tassi 0/+1/−1/+2:
  prezzo di uscita dal rendimento, cedole e rateo netti, tassa sulla plusvalenza o minus, seconda commissione, bollo pro rata).
  Verifica: priceAtYield inverte compute su 2.800 titoli con scarto 3,6e-13; vendita 6 mesi prima della scadenza a tassi
  invariati dà 3,368% vs 3,375% a scadenza (la differenza è la seconda commissione). Costruttore di scala 🪜: importo,
  orizzonte, gradini, universo (lista filtrata / BTP / Stati e sovranazionali), miglior netto per gradino con emittenti diversi,
  nominali ai lotti minimi, flussi per anno, salvataggio nei preferiti o nel portafoglio (portfolio v0.2.3 addPositions).
- sync.js v0.1.0: sincronizzazione GitHub con token fine-grained (solo repo, Contents read/write), salvato sul dispositivo:
  "Salva alerts.json su GitHub" dagli Avvisi (il job apre la Issue → email), backup del portafoglio CIFRATO (AES-GCM 256,
  chiave PBKDF2-SHA256 200k iterazioni da passphrase) in user/portfolio.enc e ripristino da altro dispositivo. Testato con
  API simulata: token errato, sha/aggiornamento, "già aggiornato", round-trip cifra/decifra, passphrase errata.
- run_daily v0.7.3: avvisi "solo novità". alerts_fired.json conserva anche gli scattati del giorno prima; il report (e quindi
  la Issue → email) viene prodotto solo se almeno un titolo soddisfa una regola oggi e non ieri; i nuovi sono marcati NUOVO,
  gli altri stanno in un blocco richiudibile. Verificato sui dati del 05/11: nessun giorno precedente → email; stessi 35
  titoli → nessuna email; 2 nuovi → email con i 2 in testa. Primo run con alerts.json: 06/11 16:07 (prima email: tutti nuovi).
- Revisione a freddo del codice del 06/11 (app 0.10.1, sim 0.1.1, sync 0.1.1):
  * sync: base64 a blocchi (String.fromCharCode(...array) esplodeva lo stack oltre ~100k byte: testato con 200 posizioni,
    28 kB cifrati); il backup del portafoglio ora confronta il contenuto DECIFRATO con quello sul repo (salt/iv casuali
    rendevano ogni cifrato diverso → un commit a ogni tocco anche senza modifiche: ora "già aggiornato", 1 solo PUT);
    fetch con cache: no-store (l'API poteva restituire lo sha vecchio dalla cache del browser).
  * preferiti: si applica solo la ricerca, non i filtri (un preferito sotto l'anno o in valuta spariva per il filtro di default);
    il contatore del pannello lo dice.
  * simulatore: default a metà vita; nota per zero coupon (pro rata tassato come interesse, eccedenza al 26%: stima lieve-
    mente ottimista) e richiamabili; scala: cedole nette/anno = cedola annua netta sul nominale (prima era un rapporto
    approssimato sui titoli brevi); dichiarati i criteri di esclusione (richiamabili, lotti ≥100k).
- Secondo controllo (ricalcolo indipendente): simulatore "se vendo prima" riscritto da zero in Python (tools non committati)
  e confrontato col JS su 5 casi (BTP 2046 a 4 anni; Austria 2031 con prima cedola corta e +1 punto; zero coupon 2040 a
  2,5 anni; CDP 2036 semestrale 26% su 25.000 con −1 punto; Austria 2037 sopra 100 con +2 punti): scarto massimo 2e-11.
  Casi limite: link con valori non numerici (ora ignorati, resta il default), scala con importo sotto il lotto (0 titoli,
  pulsanti disabilitati), 15 gradini su 30 anni, CSV di lista vuota, scenario −3 punti. Corretti (app 0.10.2, sim 0.1.2):
  il simulatore compariva anche sotto l'anno (guardia mai attiva); la scala dimensionava su "lotto minimo 1" di BI
  (491 titoli MOT, es. Austria: comprabili a 1 €) → ora taglio minimo 1.000 per i gradini.
