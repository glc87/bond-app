# Bond App — rendimenti netti delle obbligazioni quotate sul MOT

Fotografia giornaliera di tutti i titoli quotati sul MOT di Borsa Italiana
(titoli di Stato italiani ed esteri, sovranazionali, corporate) con prezzo,
valuta e **rendimento netto** per un investitore privato italiano.

## Come funziona
- `scraper/` (Python): ogni giorno di borsa GitHub Actions scarica liste, schede e book
  da borsaitaliana.it (1 richiesta/secondo), calcola i rendimenti e scrive `data/bonds.json`.
- `docs/` (PWA): app web statica servita da GitHub Pages che legge `data/bonds.json`.
- `data/history/`: una riga per titolo al giorno, per i grafici storici.

## Calcolo del netto (vedi `scraper/yields.py`)
- Tasse 12,5% (Stato/sovranazionali) o 26% (altri) su cedole, rateo e plusvalenza a scadenza.
- Prezzo sopra 100: la minusvalenza viene segnalata, non conteggiata.
- Commissioni (default 0,19%, min 9 €, max 19 €) e bollo 0,2% annuo inclusi nei dati "all-in".
- Rendimento calcolato sul prezzo **ask** quando disponibile, altrimenti sul riferimento.
- Verifica incrociata automatica con i rendimenti pubblicati da Borsa Italiana
  (che, nota: nel "netto" non tassano la plusvalenza).

## Esecuzione manuale
Actions → "Aggiornamento giornaliero bond" → Run workflow (opzionale `limit`, `segments`).

## Disclaimer
Dati indicativi a solo scopo informativo, non costituiscono consulenza. Fonte prezzi: Borsa Italiana (ritardo 15').
