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
