"""
borsa_italiana.py — v0.1.0
Download e parsing delle pagine obbligazioni di Borsa Italiana (MOT).

Tre tipi di pagina, tutte HTML server-side (nessun JavaScript richiesto):
  1. Liste:         /borsa/obbligazioni/mot/<segmento>/lista.html?lang=it&page=N
  2. Scheda:        /borsa/obbligazioni/mot/<segmento>/scheda/<ISIN>-MOTX.html?lang=it
  3. Dati completi: /borsa/obbligazioni/mot/<segmento>/dati-completi.html?isin=<ISIN>&mic=MOTX&lang=it

Il parsing è basato su coppie "etichetta -> valore" nelle tabelle, quindi è
robusto a piccoli cambiamenti di layout ma NON a cambi di etichetta.
"""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field, asdict
from datetime import date, datetime
from typing import Optional
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

VERSION = "0.1.0"
BASE = "https://www.borsaitaliana.it"

# Segmenti MOT: chiave = slug nell'URL, valore = descrizione
SEGMENTS = {
    "btp": "Titoli di Stato italiani - BTP (incl. strip)",
    "bot": "Titoli di Stato italiani - BOT",
    "cct": "Titoli di Stato italiani - CCT",
    "ctz": "Titoli di Stato italiani - CTZ",
    "obbligazioni-euro": "DomesticMOT - altri titoli di debito (corporate/bancari IT)",
    "euro-obbligazioni": "EuroMOT - titoli di Stato esteri, sovranazionali, eurobond",
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) bond-app/0.1 (uso personale, 1 req/s)",
    "Accept-Language": "it-IT,it;q=0.9",
}

log = logging.getLogger("borsa_italiana")


# ----------------------------------------------------------------------------
# Utility di parsing
# ----------------------------------------------------------------------------
def clean(s: Optional[str]) -> str:
    if s is None:
        return ""
    return re.sub(r"\s+", " ", s.replace("\xa0", " ")).strip()


def it_number(s: Optional[str]) -> Optional[float]:
    """'85,45995' -> 85.45995 ; '2.607.000' -> 2607000 ; '+0,39%' -> 0.39 ; '' -> None"""
    s = clean(s)
    if not s or s in {"-", "n.d.", "n/a"}:
        return None
    s = s.replace("%", "").replace("+", "").strip()
    # separatore migliaia '.' e decimale ','
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    else:
        # solo punti: se sembrano migliaia (gruppi di 3) li tolgo
        if re.fullmatch(r"-?\d{1,3}(\.\d{3})+", s):
            s = s.replace(".", "")
    try:
        return float(s)
    except ValueError:
        return None


def it_date(s: Optional[str]) -> Optional[date]:
    """'01/03/40' o '03/11/2026' -> date. Anni a 2 cifre: 00-69 -> 20xx, 70-99 -> 19xx."""
    s = clean(s)
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{2,4})", s)
    if not m:
        return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if y < 100:
        y += 2000 if y < 70 else 1900
    try:
        return date(y, mo, d)
    except ValueError:
        return None


def kv_tables(soup: BeautifulSoup) -> dict[str, str]:
    """Raccoglie tutte le coppie <td>etichetta</td><td>valore</td> delle tabelle a 2 colonne."""
    out: dict[str, str] = {}
    for tr in soup.select("table tr"):
        tds = tr.find_all("td", recursive=False)
        if len(tds) != 2:
            continue
        label = clean(tds[0].get_text(" "))
        value = clean(tds[1].get_text(" "))
        if label and label not in out:  # la prima occorrenza vince
            out[label] = value
    return out


# ----------------------------------------------------------------------------
# Strutture dati
# ----------------------------------------------------------------------------
@dataclass
class ListRow:
    isin: str
    name: str
    issuer_hint: str          # attributo title della colonna descrizione (es. "Kingdom Of Belgium")
    last: Optional[float]
    coupon_list: Optional[float]   # cedola come mostrata in lista (spesso PERIODALE, non annua)
    maturity: Optional[date]
    scheda_url: str
    segment: str              # slug del segmento di provenienza


@dataclass
class Scheda:
    isin: str
    name: str
    last_price: Optional[float]
    last_trade_time: str
    official_price: Optional[float]
    official_price_date: Optional[date]
    bi_yield_gross: Optional[float]      # "Rendimento effettivo a scadenza lordo" (Borsa Italiana)
    bi_yield_net: Optional[float]        # "Rendimento effettivo a scadenza netto"
    bi_accrued_gross: Optional[float]    # Rateo lordo (per 100)
    bi_accrued_net: Optional[float]      # Rateo netto (per 100)
    bi_mod_duration: Optional[float]
    ref_price: Optional[float]           # Prezzo di riferimento
    ref_date: Optional[date]
    issuer: str
    guarantor: str
    subordinated: str
    tipologia: str                       # es. "Titoli di stato italiani", "Titoli di stato esteri"
    structure: str                       # es. "Plain Vanilla"
    outstanding: Optional[float]
    min_lot: Optional[float]
    currency_trade: str
    currency_settle: str
    market: str
    first_trade_date: Optional[date]
    accrual_start: Optional[date]        # Data Godimento
    first_coupon_date: Optional[date]
    maturity: Optional[date]
    coupon_frequency: str                # "Semestrale", "Annuale", "Trimestrale", ""
    trading_mode: str                    # "Corso Secco" / "Tel Quel"
    day_count: str                       # es. "ACT/ACT (PERIODIC BASIS)"
    coupon_periodic: Optional[float]     # Tasso Cedola Periodale
    coupon_annual: Optional[float]       # Tasso Cedola su base Annua
    payout_desc: str
    raw: dict = field(default_factory=dict)


@dataclass
class Book:
    bid: Optional[float]
    bid_qty: Optional[float]
    ask: Optional[float]
    ask_qty: Optional[float]
    levels: list = field(default_factory=list)   # [(bid, bidq, ask, askq), ...]
    last_price: Optional[float] = None
    ref_price: Optional[float] = None
    tipo_bond: str = ""                           # "Titolo Con Cedole Tf", "Zero Coupon", ...
    market_phase: str = ""
    raw: dict = field(default_factory=dict)


# ----------------------------------------------------------------------------
# Parser (funzioni pure: HTML -> dati), testabili offline
# ----------------------------------------------------------------------------
def parse_list(html: str, segment: str) -> list[ListRow]:
    soup = BeautifulSoup(html, "html.parser")
    rows: list[ListRow] = []
    table = soup.find("table")
    if not table:
        return rows
    for tr in table.find_all("tr"):
        a = tr.select_one('a[href*="/scheda/"]')
        if not a:
            continue
        href = a.get("href", "")
        m = re.search(r"/scheda/([A-Z0-9]{12})-", href)
        if not m:
            continue
        isin = m.group(1)
        # colonne desktop: hanno class "u-hidden -xs"
        tds = tr.find_all("td", recursive=False)
        desc_td = tds[1] if len(tds) > 1 else None
        name = clean(desc_td.get_text(" ")) if desc_td else clean(a.get("title", ""))
        issuer_hint = clean(desc_td.get("title", "")) if desc_td else ""
        last = it_number(tds[2].get_text()) if len(tds) > 2 else None
        coupon = it_number(tds[3].get_text()) if len(tds) > 3 else None
        maturity = it_date(tds[4].get_text()) if len(tds) > 4 else None
        rows.append(ListRow(isin, name, issuer_hint, last, coupon, maturity, urljoin(BASE, href), segment))
    return rows


def parse_scheda(html: str) -> Scheda:
    soup = BeautifulSoup(html, "html.parser")
    kv = kv_tables(soup)

    h1 = soup.find("h1")
    name = clean(h1.get_text()) if h1 else ""

    last_price = None
    fp = soup.select_one(".summary-value .-formatPrice strong, .summary-value .-formatPrice")
    if fp:
        last_price = it_number(fp.get_text())

    last_trade_time = ""
    for span in soup.find_all("span"):
        txt = clean(span.get_text(" "))
        if txt.startswith("Ultimo Contratto"):
            st = span.find("strong")
            last_trade_time = clean(st.get_text()) if st else txt.replace("Ultimo Contratto:", "").strip()
            break

    cur = kv.get("Valuta di Negoziazione/ Liquidazione", "")
    cur_trade, cur_settle = (cur.split("/") + ["", ""])[:2] if cur else ("", "")

    return Scheda(
        isin=kv.get("Codice Isin", ""),
        name=name or kv.get("Denominazione", ""),
        last_price=last_price,
        last_trade_time=last_trade_time,
        official_price=it_number(kv.get("Prezzo ufficiale")),
        official_price_date=it_date(kv.get("Data Pr Ufficiale")),
        bi_yield_gross=it_number(kv.get("Rendimento effettivo a scadenza lordo")),
        bi_yield_net=it_number(kv.get("Rendimento effettivo a scadenza netto")),
        bi_accrued_gross=it_number(kv.get("Rateo Lordo")),
        bi_accrued_net=it_number(kv.get("Rateo Netto")),
        bi_mod_duration=it_number(kv.get("Duration modificata")),
        ref_price=it_number(kv.get("Prezzo di riferimento")),
        ref_date=it_date(kv.get("Data di riferimento")),
        issuer=kv.get("Emittente", ""),
        guarantor=kv.get("Garante", ""),
        subordinated=kv.get("Subordinazione", ""),
        tipologia=kv.get("Tipologia", ""),
        structure=kv.get("Struttura Bond", ""),
        outstanding=it_number(kv.get("Ammontare Emesso")),
        min_lot=it_number(kv.get("Lotto Minimo")),
        currency_trade=clean(cur_trade),
        currency_settle=clean(cur_settle),
        market=kv.get("Mercato", ""),
        first_trade_date=it_date(kv.get("Data Inizio Negoziazione")),
        accrual_start=it_date(kv.get("Data Godimento")),
        first_coupon_date=it_date(kv.get("Data Stacco prima Cedola")),
        maturity=it_date(kv.get("Scadenza")),
        coupon_frequency=kv.get("Periodicità cedola", ""),
        trading_mode=kv.get("Modalità di Negoziazione", ""),
        day_count=kv.get("Base di Calcolo", ""),
        coupon_periodic=it_number(kv.get("Tasso Cedola Periodale")),
        coupon_annual=it_number(kv.get("Tasso Cedola su base Annua")),
        payout_desc=kv.get("Descrizione Payout", ""),
        raw=kv,
    )


def parse_dati_completi(html: str) -> Book:
    soup = BeautifulSoup(html, "html.parser")
    kv = kv_tables(soup)
    levels = []
    for table in soup.find_all("table"):
        head = clean(table.get_text(" "))
        if "Prezzo Acquisto" not in head or "Prezzo Vendita" not in head:
            continue
        for tr in table.find_all("tr"):
            tds = tr.find_all("td")
            if len(tds) < 7:
                continue
            vals = [clean(td.get_text()) for td in tds]
            # N, NumProposte, VolAcq, PrzAcq, PrzVend, VolVend, NumProposte
            levels.append((it_number(vals[3]), it_number(vals[2]), it_number(vals[4]), it_number(vals[5])))
        break
    bid = bid_q = ask = ask_q = None
    if levels:
        bid, bid_q, ask, ask_q = levels[0]
    return Book(
        bid=bid, bid_qty=bid_q, ask=ask, ask_qty=ask_q, levels=levels,
        last_price=it_number(kv.get("Prezzo Ultimo Contratto")),
        ref_price=it_number(kv.get("Prezzo di riferimento")),
        tipo_bond=kv.get("Tipo Bond", ""),
        market_phase=kv.get("Fase di Mercato", ""),
        raw=kv,
    )


# ----------------------------------------------------------------------------
# Download (con ritmo educato e retry)
# ----------------------------------------------------------------------------
class Client:
    def __init__(self, delay_s: float = 1.0, timeout: int = 30, max_retries: int = 3):
        self.s = requests.Session()
        self.s.headers.update(HEADERS)
        self.delay_s = delay_s
        self.timeout = timeout
        self.max_retries = max_retries
        self._last = 0.0
        self.n_requests = 0

    def get(self, url: str) -> str:
        for attempt in range(1, self.max_retries + 1):
            wait = self.delay_s - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            try:
                r = self.s.get(url, timeout=self.timeout)
                self._last = time.monotonic()
                self.n_requests += 1
                if r.status_code == 200:
                    return r.text
                log.warning("HTTP %s su %s (tentativo %d)", r.status_code, url, attempt)
                if r.status_code in (403, 429):
                    time.sleep(30 * attempt)   # rallenta se ci stanno limitando
            except requests.RequestException as e:
                log.warning("Errore rete %s su %s (tentativo %d)", e, url, attempt)
                self._last = time.monotonic()
            time.sleep(2 * attempt)
        raise RuntimeError(f"Download fallito: {url}")


def list_url(segment: str, page: int) -> str:
    return f"{BASE}/borsa/obbligazioni/mot/{segment}/lista.html?lang=it&page={page}"


def dati_completi_url(scheda_url: str, isin: str) -> str:
    # .../mot/<seg>/scheda/<ISIN>-MOTX.html?lang=it -> .../mot/<seg>/dati-completi.html?isin=<ISIN>&mic=MOTX&lang=it
    base = scheda_url.split("/scheda/")[0]
    return f"{base}/dati-completi.html?isin={isin}&mic=MOTX&lang=it"


def fetch_segment_list(client: Client, segment: str, max_pages: int = 200) -> list[ListRow]:
    """Scorre le pagine finché non compaiono più ISIN nuovi."""
    seen: dict[str, ListRow] = {}
    for page in range(1, max_pages + 1):
        html = client.get(list_url(segment, page))
        rows = parse_list(html, segment)
        new = [r for r in rows if r.isin not in seen]
        if not new:
            break
        for r in new:
            seen[r.isin] = r
        log.info("%s pagina %d: %d titoli (totale %d)", segment, page, len(rows), len(seen))
    return list(seen.values())


def fetch_all_lists(client: Client, segments=None) -> list[ListRow]:
    segments = segments or list(SEGMENTS)
    out: dict[str, ListRow] = {}
    for seg in segments:
        for r in fetch_segment_list(client, seg):
            out.setdefault(r.isin, r)   # un ISIN può comparire in più liste (es. green bond)
    return list(out.values())


def fetch_bond(client: Client, row: ListRow) -> tuple[Scheda, Book]:
    scheda = parse_scheda(client.get(row.scheda_url))
    book = parse_dati_completi(client.get(dati_completi_url(row.scheda_url, row.isin)))
    return scheda, book


def to_dict(obj) -> dict:
    d = asdict(obj)
    for k, v in d.items():
        if isinstance(v, (date, datetime)):
            d[k] = v.isoformat()
    return d
