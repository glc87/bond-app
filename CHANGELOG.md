# Changelog

## 2026-11-04
- borsa_italiana.py v0.1.0: parser liste/scheda/dati completi, client con rate limit e retry.
- yields.py v0.1.1: motore rendimenti (T+2 TARGET, ACT/ACT, tasse, commissioni, bollo), più
  campo `ytm_net_bi_convention` per la verifica incrociata con Borsa Italiana.
- run_daily.py v0.1.0: orchestratore, output bonds.json / meta.json / history.
- Verifica su BTP 3,1% Mz40 (prezzo rif. 85,25 del 03/11/2026): rateo identico a BI (0,55663),
  YTM lordo 4,642 vs 4,64 BI; il "netto" BI (4,21) non tassa la plusvalenza, il nostro (4,09) sì.
