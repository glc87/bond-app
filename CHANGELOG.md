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
