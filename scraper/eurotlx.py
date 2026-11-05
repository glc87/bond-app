"""
eurotlx.py — v0.1.0
Download e parsing delle pagine EuroTLX di Borsa Italiana (secondo mercato retail, MIC ETLX).

Pagine (HTML server-side; la ricerca avanzata carica i risultati da un endpoint separato):
  1. Risultati:     /borsa/obbligazioni/eurotlx/ricerca-avanzata/risultati.html?category=<CAT>&lang=it&page=N
                    10 righe/pagina: ISIN, descrizione, ultimo, cedola, scadenza, ACQUISTO (bid), VENDITA (ask)
  2. Scheda:        /borsa/obbligazioni/eurotlx/scheda/<ISIN>-ETLX.html?lang=it
                    rendimenti BI lordo/netto, rateo, duration, prezzo di riferimento, cedola periodale/annua, lotto, valuta
  3. Dati completi: /borsa/obbligazioni/eurotlx/dati-completi.html?isin=<ISIN>&mic=ETLX&lang=it
                    emittente, tipologia, data di scadenza, frequenza di pagamento, book 5 livelli, min/max anno

Esplorato il 05/11/2026: ~2.000 titoli (corporate 580, finanziari 680, altri debito 225, Stati emergenti 215,
extra-UE 80, T-Bond/T-Note USA 140, covered/notes/sovranazionali 70). BTP, Bund, OAT ecc. NON sono su EuroTLX.
"""
from __future__ import annotations

import logging
import re
from typing import Optional

from bs4 import BeautifulSoup

import borsa_italiana as bi

VERSION = "0.1.0"
log = logging.getLogger("eurotlx")

# Categorie della ricerca avanzata (05/11/2026). Le vuote costano una richiesta ciascuna e vengono saltate subito.
CATEGORIES = [
    "CORPORATE_BONDS", "FINANCIAL_BONDS", "OTHER_DEBT_INSTRUMENTS", "EMERGING_MARKET_GOVIES", "EXTRA_EU_GOVIES",
    "T-BONDS", "T-NOTE", "TIPS", "COVERED_BONDS", "NOTES", "SUPRANATIONAL_AGENCY", "SOVEREIGN", "TERRITORIAL_BONDS",
    "OTHER_EU_GOVIES", "OTHER_ITALIAN_GOVIES", "BELGIAN_GOVERNMENT_BONDS", "DUTCH_GOVERNMENT_BONDS",
    "PORTUGUESE_GOVERNMENT_BONDS", "NORWEGIAN_GOVERNMENT_BONDS", "NORWEGIAN_GOVERNMENT_BILLS",
    "BTP", "BOT", "CCT", "CTZ", "BTP_ITALIA", "BTP_INFLATION", "BTP_FUTURA", "BUND", "BOBL", "SCHATZE", "BTAN", "BTF",
    "OAT", "OAT_INFLATION", "CONVERTIBLE_BONDS", "INFRASTRUCTURE_BONDS", "CREDITS", "COMMERCIAL_PAPERS",
    "BOND_TENDER_OFFER", "ABS", "ABS_STS", "SYNTHETIC_ABS", "SYNTHETIC_ABS_STS",
]

# Tipologie EuroTLX che corrispondono a titoli di Stato (poi l'emittente decide fra sovrano e agenzia)
GOV_TIPOLOGIE_TLX = ["titoli di stato", "t-bond", "t-note", "tips", "sovereign", "buoni", "certificati del tesoro",
                     "bund", "bobl", "schatz", "oat", "btan", "btf"]


def results_url(category: str, page: int) -> str:
    return f"{bi.BASE}/borsa/obbligazioni/eurotlx/ricerca-avanzata/risultati.html?category={category}&lang=it&page={page}"


def scheda_url(isin: str) -> str:
    return f"{bi.BASE}/borsa/obbligazioni/eurotlx/scheda/{isin}-ETLX.html?lang=it"


def dati_url(isin: str) -> str:
    return f"{bi.BASE}/borsa/obbligazioni/eurotlx/dati-completi.html?isin={isin}&mic=ETLX&lang=it"


# ----------------------------------------------------------------------------
# Parser
# ----------------------------------------------------------------------------
def parse_results(html: str, category: str) -> list[dict]:
    """Righe della lista: isin, name, last, coupon_list, maturity, bid, ask."""
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for tr in soup.select("table tr"):
        a = tr.select_one('a[href*="/scheda/"]')
        if not a:
            continue
        m = re.search(r"/scheda/([A-Z0-9]{12})-ETLX", a.get("href", ""))
        if not m:
            continue
        tds = tr.find_all("td", recursive=False)
        txt = [bi.clean(td.get_text(" ")) for td in tds]
        # ISIN | Descrizione | Ultimo | Cedola | Scadenza | Acquisto | Vendita
        out.append({
            "isin": m.group(1),
            "name": re.sub(r"\s+", " ", txt[1]) if len(txt) > 1 else "",
            "last": bi.it_number(txt[2]) if len(txt) > 2 else None,
            "coupon_list": bi.it_number(txt[3]) if len(txt) > 3 else None,
            "maturity": bi.it_date(txt[4]) if len(txt) > 4 else None,
            "bid": bi.it_number(txt[5]) if len(txt) > 5 else None,
            "ask": bi.it_number(txt[6]) if len(txt) > 6 else None,
            "category": category,
        })
    return out


def frequency_from_tlx(s: str) -> int:
    """'12 Mesi' -> 1, '6 Mesi' -> 2, '3 Mesi' -> 4, '1 Mese' -> 12"""
    m = re.search(r"(\d+)\s*Mes", s or "", re.I)
    if not m:
        return 0
    months = int(m.group(1))
    return 12 // months if months in (1, 2, 3, 4, 6, 12) else 0


def parse_scheda_tlx(html: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    kv = bi.kv_tables(soup)
    h1 = soup.find("h1")
    fp = soup.select_one(".summary-value .-formatPrice")
    last_time = ""
    for span in soup.find_all("span"):
        t = bi.clean(span.get_text(" "))
        if t.startswith("Ultimo Contratto"):
            st = span.find("strong"); last_time = bi.clean(st.get_text()) if st else ""
            break
    return {"kv": kv, "name": bi.clean(h1.get_text()) if h1 else kv.get("Descrizione", ""),
            "last_price": bi.it_number(fp.get_text()) if fp else None, "last_trade_time": last_time}


def parse_dati_tlx(html: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    kv = bi.kv_tables(soup)
    levels = []
    for table in soup.find_all("table"):
        head = bi.clean(table.get_text(" "))
        if "Prezzo Acquisto" not in head or "Prezzo Vendita" not in head:
            continue
        for tr in table.find_all("tr"):
            tds = tr.find_all("td")
            if len(tds) < 4:
                continue
            v = [bi.clean(td.get_text()) for td in tds]
            # Volume Acquisto | Prezzo Acquisto | Prezzo Vendita | Volume Vendita
            levels.append((bi.it_number(v[1]), bi.it_number(v[0]), bi.it_number(v[2]), bi.it_number(v[3])))
        break
    return {"kv": kv, "levels": levels}


def to_scheda_book(row: dict, sch: dict, dat: dict) -> tuple[bi.Scheda, bi.Book]:
    """Converte le pagine EuroTLX nelle stesse strutture usate per il MOT (così build_record non cambia)."""
    k, d = sch["kv"], dat["kv"]
    freq_label = d.get("Frequenza di pagamento", "")
    cp, ca = bi.it_number(k.get("Tasso Cedola Periodale") or d.get("Tasso Cedola Periodale")), bi.it_number(k.get("Tasso Cedola su base Annua") or d.get("Tasso Cedola su base Annua"))
    freq = frequency_from_tlx(freq_label)
    if freq == 0 and cp and ca and cp > 0:
        r = ca / cp
        if abs(r - round(r)) < 1e-6 and round(r) in (1, 2, 4, 12):
            freq = int(round(r))
    # etichetta nelle parole che yields.frequency_from_text riconosce
    freq_label = {1: "Annuale", 2: "Semestrale", 4: "Trimestrale", 12: "Mensile"}.get(freq, freq_label)
    tipologia = d.get("Tipologia", "")
    s = bi.Scheda(
        isin=d.get("Codice ISIN") or k.get("ISIN") or row["isin"],
        name=sch["name"] or row["name"],
        last_price=sch["last_price"] or bi.it_number(k.get("Prezzo ultimo contratto")),
        last_trade_time=sch["last_trade_time"] or k.get("Data e ora", ""),
        official_price=None, official_price_date=None,
        bi_yield_gross=bi.it_number(k.get("Rendimento effettivo a scadenza lordo")),
        bi_yield_net=bi.it_number(k.get("Rendimento effettivo a scadenza netto")),
        bi_accrued_gross=bi.it_number(k.get("Rateo Lordo")), bi_accrued_net=bi.it_number(k.get("Rateo Netto")),
        bi_mod_duration=bi.it_number(k.get("Duration modificata")),
        ref_price=bi.it_number(k.get("Prezzo di riferimento") or d.get("Prezzo di riferimento")),
        ref_date=bi.it_date(k.get("Data di riferimento")),
        issuer=d.get("Emittente", ""), guarantor="", subordinated="",
        tipologia=tipologia, structure="", outstanding=None,
        min_lot=bi.it_number(k.get("Lotto minimo") or d.get("Lotto minimo")),
        currency_trade=k.get("Valuta di negoziazione") or d.get("Valuta di negoziazione", ""),
        currency_settle=k.get("Valuta di negoziazione") or d.get("Valuta di negoziazione", ""),
        market="ETLX", first_trade_date=None, accrual_start=None, first_coupon_date=None,
        maturity=bi.it_date(d.get("Data di scadenza")) or row.get("maturity"),
        coupon_frequency=freq_label, trading_mode=k.get("Modalità di Negoziazione") or d.get("Modalità di Negoziazione", ""),
        day_count="", coupon_periodic=cp, coupon_annual=ca, payout_desc=k.get("Descrizione Payout", ""),
        raw={**d, **{f"scheda:{kk}": vv for kk, vv in k.items()}},
    )
    lv = dat["levels"]
    bid = bid_q = ask = ask_q = None
    if lv:
        bid, bid_q, ask, ask_q = lv[0]
    if ask is None and row.get("ask"):
        ask, bid = row["ask"], row["bid"]
    b = bi.Book(bid=bid, bid_qty=bid_q, ask=ask, ask_qty=ask_q, levels=lv,
                last_price=bi.it_number(d.get("Prezzo ultimo contratto")), ref_price=s.ref_price,
                tipo_bond="Zero Coupon" if (" zc " in f" {s.name.lower()} " or " strip" in s.name.lower()) else "",
                market_phase="", volume_today=bi.it_number(d.get("Volume giornaliero")),
                n_trades_today=None, last_trade_time=d.get("Data e ora", ""),
                year_high=bi.it_number(d.get("Massimo dell'anno")), year_low=bi.it_number(d.get("Minimo dell'anno")), raw=d)
    return s, b


# ----------------------------------------------------------------------------
# Download
# ----------------------------------------------------------------------------
def fetch_category(client: bi.Client, category: str, max_pages: int = 300) -> list[dict]:
    seen: dict[str, dict] = {}
    for page in range(1, max_pages + 1):
        rows = parse_results(client.get(results_url(category, page)), category)
        new = [r for r in rows if r["isin"] not in seen]
        if not new:
            break
        for r in new:
            seen[r["isin"]] = r
        if page == 1 or page % 10 == 0:
            log.info("EuroTLX %s pagina %d (totale %d)", category, page, len(seen))
    return list(seen.values())


def fetch_all_lists(client: bi.Client, categories=None) -> list[dict]:
    out: dict[str, dict] = {}
    for c in categories or CATEGORIES:
        for r in fetch_category(client, c):
            out.setdefault(r["isin"], r)
    return list(out.values())


def fetch_bond(client: bi.Client, row: dict) -> tuple[bi.Scheda, bi.Book]:
    sch = parse_scheda_tlx(client.get(scheda_url(row["isin"])))
    dat = parse_dati_tlx(client.get(dati_url(row["isin"])))
    return to_scheda_book(row, sch, dat)


def as_list_row(row: dict) -> bi.ListRow:
    return bi.ListRow(row["isin"], row["name"], "", row.get("last"), row.get("coupon_list"), row.get("maturity"),
                      scheda_url(row["isin"]), f"eurotlx:{row['category']}")
