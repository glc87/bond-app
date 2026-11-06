"""
yields.py — v0.3.6
Motore di calcolo rendimenti per obbligazioni a tasso fisso e zero coupon,
dal punto di vista di un investitore privato residente in Italia.

Convenzioni (documentate perché incidono sui numeri):
  - Prezzi "corso secco" per 100 di nominale (come sul MOT).
  - Regolamento T+2 giorni lavorativi TARGET (weekend + festività TARGET).
  - Rateo con convenzione ACT/ACT (ICMA): cedola_periodale * (settle - prev) / (next - prev).
  - Rendimento effettivo (YTM): tasso annuo composto che azzera il valore attuale
    dei flussi, con frazioni d'anno ACT/365. Il "rendimento effettivo a scadenza"
    pubblicato da Borsa Italiana usa una convenzione simile: usiamo il loro
    valore come verifica incrociata, non come fonte.
  - Fiscale (Italia): aliquota su cedole, rateo e plusvalenza a scadenza.
      * 12,5%: titoli di Stato italiani, Stati esteri white list, organismi
        sovranazionali (BEI, BIRS, UE, ESM, ...).
      * 26%: tutto il resto (corporate, bancari, agenzie).
    Il rateo pagato al venditore è "netto" (si recupera l'imposta sulla cedola):
    costo = prezzo + rateo_netto.  Plusvalenza tassata = max(0, 100 - prezzo).
    Se prezzo > 100 si genera una MINUSVALENZA (credito compensabile 4 anni),
    che NON viene conteggiata nel rendimento (prudenziale) ma viene riportata.
  - Commissioni: percentuale sul controvalore, vincolata tra un minimo e un massimo
    (es. Fineco 0,19% min 2,95 max 19 €; ING 0,19% min 8 max 18 €), pagate all'acquisto.
    Alla scadenza il rimborso non ha commissioni.
  - Imposta di bollo: 0,2% annuo sul valore di mercato. Approssimata come
    0,2% * media(prezzo, 100) per ogni anno (o frazione) di detenzione.
  - "Rendimento netto semplice": (incassi netti totali - costo totale) / costo / anni.
    Nessuna ipotesi di reinvestimento delle cedole: è il dato "certo".
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, asdict
from datetime import date, timedelta
from typing import Optional, Callable

VERSION = "0.3.6"

TAX_GOV = 0.125
TAX_OTHER = 0.26
BOLLO_RATE = 0.002  # 0,2% annuo

# Emittenti sovranazionali / equiparati tassati al 12,5% (match su sottostringhe maiuscole)
SUPRANATIONAL_KEYS = [
    "EUROPEAN INVESTMENT BANK", "BANCA EUROPEA PER GLI INVESTIMENTI", "BEI", "EIB",
    "INTERNATIONAL BANK FOR RECONSTRUCTION", "WORLD BANK", "BIRS", "IBRD",
    "EUROPEAN UNION", "UNIONE EUROPEA", "EUROPEAN STABILITY MECHANISM", "ESM",
    "EUROPEAN FINANCIAL STABILITY", "EFSF", "COUNCIL OF EUROPE DEVELOPMENT BANK", "CEB",
    "EUROPEAN BANK FOR RECONSTRUCTION", "EBRD", "BERS", "INTERNATIONAL FINANCE CORPORATION", "IFC",
    "ASIAN DEVELOPMENT BANK", "INTER-AMERICAN DEVELOPMENT BANK", "AFRICAN DEVELOPMENT BANK",
    "NORDIC INVESTMENT BANK", "EUROFIMA", "INTERNATIONAL DEVELOPMENT ASSOCIATION",
    # forme abbreviate usate da Borsa Italiana (run 05/11/2026): EBRD, EFSF, UE, AIIB, CEB
    "BANCA EUROPEA PER LA RIC", "EUROPEAN FINANC STABILITY", "UE", "AIIB", "ASIAN INFRASTRUCTURE INVESTMENT BANK",
    "COUNCIL OF EUROPE SOCIAL DEVEL", "COUNCIL OF EUROPE",
]
GOV_TIPOLOGIE = {"titoli di stato italiani", "titoli di stato esteri"}


@dataclass
class CostParams:
    # Verificato 04/11/2026: Fineco 0,19% min 2,95 max 19; ING 0,19% min 8 max 18 (fino a 15 ordini/anno).
    # La percentuale è vincolata tra minimo e massimo: NON si sommano.
    commission_pct: float = 0.0019   # 0,19 %
    commission_min: float = 5.0      # €
    commission_max: float = 19.0     # € (None = nessun massimo)
    bollo_rate: float = BOLLO_RATE
    nominal: float = 10_000.0        # nominale di riferimento per i valori in €


# ----------------------------------------------------------------------------
# Calendario
# ----------------------------------------------------------------------------
def easter(year: int) -> date:
    a = year % 19; b = year // 100; c = year % 100
    d = b // 4; e = b % 4; f = (b + 8) // 25; g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4; k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def target_holidays(year: int) -> set[date]:
    e = easter(year)
    return {date(year, 1, 1), e - timedelta(days=2), e + timedelta(days=1),
            date(year, 5, 1), date(year, 12, 25), date(year, 12, 26)}


def borsa_italiana_holidays(year: int) -> set[date]:
    """Giorni di chiusura del MOT (Borsa Italiana): TARGET + 15 agosto, 24 e 31 dicembre.
    Il regolamento (T+2) segue invece il calendario TARGET: le due cose restano distinte."""
    return target_holidays(year) | {date(year, 8, 15), date(year, 12, 24), date(year, 12, 31)}


def is_trading_day(d: date) -> bool:
    return d.weekday() < 5 and d not in borsa_italiana_holidays(d.year)


def is_business_day(d: date) -> bool:
    return d.weekday() < 5 and d not in target_holidays(d.year)


def add_business_days(d: date, n: int) -> date:
    while n > 0:
        d += timedelta(days=1)
        if is_business_day(d):
            n -= 1
    return d


def settlement_date(trade_date: date, days: int = 2) -> date:
    return add_business_days(trade_date, days)


def add_months(d: date, months: int) -> date:
    y = d.year + (d.month - 1 + months) // 12
    m = (d.month - 1 + months) % 12 + 1
    # clamp al fine mese
    last = (date(y + (m // 12), (m % 12) + 1, 1) - timedelta(days=1)).day
    return date(y, m, min(d.day, last))


# ----------------------------------------------------------------------------
# Classificazione del titolo
# ----------------------------------------------------------------------------
@dataclass
class BondClass:
    kind: str          # "fixed" | "zero" | "floating" | "inflation" | "stepup" | "callable" | "structured" | "amortizing" | "unknown"
    computable: bool
    reason: str


def classify(name: str, tipologia: str, structure: str, tipo_bond: str,
             coupon_annual: Optional[float], freq: int) -> BondClass:
    n = f" {name.lower()} "
    tb = (tipo_bond or "").lower()
    st = (structure or "").lower()
    # indicizzati all'inflazione: BTP Italia, BTP€i/Btpi, OAT€i/Oatei, Bundei, Obligacionesei, ... (verificato su run 04/11/2026)
    if (any(k in n for k in [" btp italia", " btp€i", " btpi ", " btpi-", " btp i ", " oat€i", " oatei", " oati ", " bundei", " bobl i", " obligacionesei", " bonosei", "infl", " index", " ei "])
            or re.search(r"\b(btp|oat|bund|obligaciones|bonos|gilt|treasury)\s?(€i|ei|il|i)\b", n) or "inflation" in st or "linker" in n):
        return BondClass("inflation", False, "indicizzato all'inflazione: rendimento dipende dall'inflazione futura")
    # strutturati / indicizzati a fondi, indici, tassi swap (CMS/CMT), credit linked, autocallable, zero coupon
    # richiamabili (accreting): il rendimento a scadenza non è determinabile dal solo prezzo (run 05/11/2026,
    # EuroTLX: scarti fino a 6-7 punti vs Borsa Italiana, che usa formule a sua discrezione)
    # (" cap" solo con fix/float/euribor: "Bmw Us Cap", "Tim Cap" sono emittenti; "fund" non deve prendere "Funding")
    if (any(k in n for k in [" cms", " cmt", "cap&floor", "autocall", "ind link", "indlink", "eq link", "credit linked",
                             "asset future", " istx", " rv ", " multi coupon", " fix to ", " fix float", "reverse", "equity"])
            or re.search(r"\b(fix|float|euribor)\b.*\bcap\b", n) or re.search(r"\bfund\b", n)
            or "multi coupon" in st or "strutturat" in tb or "structured" in st):
        return BondClass("structured", False, "strutturato (indice/fondo/CMS/autocall): rendimento non determinabile dal prezzo")
    if " perp" in n or "perpetu" in st:
        return BondClass("structured", False, "perpetuo: senza scadenza, il rendimento a scadenza non è definito")
    # ammortizzanti / sinkable: rimborso del capitale a rate, il piano non è nelle pagine BI
    if " sink" in n or " amort" in n or "amortiz" in st or "ammort" in tb:
        return BondClass("amortizing", False, "rimborso a rate (ammortamento/sinkable): piano di rimborso non disponibile")
    if (any(k in n for k in [" cct", " mc ", " fr ", " tv ", " float", " tm "]) or "floating" in tb or "variabile" in tb or "tv" in tb.split()
            or re.search(r"eur\s?\d+\s?m|euribor|sofr|estr|libor|sonia|\bfrn\b", n)):   # "Bnl Eur3m+0.4975%", "Italy 29eur Frn" (06/11/2026)
        return BondClass("floating", False, "tasso variabile: cedole future non note")
    if any(k in n for k in [" valore", " futura", " più", " piu ", " step", " sc ", " oc ", " su "]) or "step" in st or "step" in tb:
        return BondClass("stepup", False, "cedola step-up/strutturata: calcolo non supportato in questa fase")
    if " call" in n or "callable" in st or "callable" in tb:
        # Richiamabile: il rendimento a scadenza si calcola (è il caso base), ma l'emittente può rimborsare prima.
        # Nei corporate la call è quasi la norma (spesso solo nei 3 mesi prima della scadenza): escluderli
        # toglierebbe metà di EuroTLX (39 su 60 nel test del 05/11/2026). computable=True con avviso.
        return BondClass("callable", True, "richiamabile (call): rendimento calcolato a scadenza, l'emittente può rimborsare prima")
    if " zc " in n or "zero" in tb or "zero" in st or " strip" in n or tipologia.lower().startswith("bot") or " bot " in n or " bot-" in n:
        return BondClass("zero", True, "")
    if coupon_annual == 0 or " tf 0% " in n or " fx 0% " in n:
        # cedola 0%: BI li classifica "con cedole" ma sono zero coupon di fatto (61 titoli nel run 04/11/2026)
        return BondClass("zero", True, "")
    if coupon_annual is None or coupon_annual < 0:
        if " tf " in n or "cedole tf" in tb:
            return BondClass("fixed", False, "tasso fisso ma cedola non leggibile dalla pagina")
        return BondClass("unknown", False, "tipologia non riconosciuta")
    if freq <= 0:
        return BondClass("fixed", False, "periodicità cedola non leggibile")
    return BondClass("fixed", True, "")


def is_true_zero_coupon(name: str, tipo_bond: str, tipologia: str) -> bool:
    """Strip, BOT, 'Zc' nel nome: emessi sotto la pari (scarto di emissione = reddito di capitale, BI lo tassa).
    I 'Tf 0%' (Bund, Austria, KfW 0%) sono titoli con cedola zero: BI non tassa nulla nel suo netto."""
    n = f" {name.lower()} "
    return " zc " in n or " strip" in n or " bot " in n or " bot-" in n or tipologia.lower().startswith("bot") or "zero" in (tipo_bond or "").lower()


def frequency_from_text(s: str) -> int:
    s = (s or "").lower()
    if "semestr" in s: return 2
    if "trimestr" in s: return 4
    if "annual" in s or "annuale" in s: return 1
    if "mensil" in s: return 12
    return 0


def coupon_from_name(name: str) -> Optional[float]:
    """'Btp Tf 3,1% Mz40 Eur' -> 3.1 ; 'Belgium Tf 5,50% Mz28 Eur' -> 5.5 ; 'Btp-1nv27 6,5%' -> 6.5"""
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*%", name)
    return float(m.group(1).replace(",", ".")) if m else None


# Agenzie e banche di sviluppo nazionali: NON equiparate ai titoli di Stato -> 26%
# (verificato con i rendimenti netti di Borsa Italiana il 04/11/2026: KfW, Rentenbank, CDP, AFD al 26%)
AGENCY_KEYS = ["KFW", "KREDITANSTALT", "RENTENBANK", "CASSA DEPOSITI", "CDP ", "AGENCE FSE", "AGENCE FRANCAISE", "AFD ", "CADES", "BNG ", "NWB ",
               "UNEDIC", "BPIFRANCE", "ICO ", "INSTITUTO DE CREDITO", "OEKB", "KOMMUNALBANKEN", "KOMMUNEKREDIT", "MUNIFIN"]
SOVEREIGN_KEYS = ["REPUBLIC", "REPUBBLICA", "KINGDOM", "BUNDESREPUBLIK", "FEDERAL REPUBLIC", "GOVERNMENT", "TREASURY",
                  "MINISTERO", "MINISTRY", "STATE OF", "ESTADO", "ROYAUME", "REINO", "KONINKRIJK", "REPUBLIQUE", "HELLENIC",
                  "IRELAND", "PORTUGAL", "FINLAND", "AUSTRIA", "BELGIUM", "FRANCE", "SPAIN", "ITALY", "NETHERLANDS", "SLOVAK", "SLOVENIA",
                  "HUNGARY", "POLAND", "ROMANIA", "LITHUANIA", "LATVIA", "ESTONIA", "CYPRUS", "MALTA", "CROATIA", "BULGARIA",
                  "CZECH", "DENMARK", "SWEDEN", "NORWAY", "SWITZERLAND", "UNITED KINGDOM", "CANADA", "AUSTRALIA", "NEW ZEALAND",
                  "JAPAN", "UNITED STATES", "MEXICO", "BRAZIL", "TURKEY", "SOUTH AFRICA", "INDONESIA", "PHILIPPINES", "CHILE", "PERU", "COLOMBIA"]


def tax_rate_for(tipologia: str, issuer: str, guarantor: str = "") -> tuple[float, str]:
    t = (tipologia or "").strip().lower()
    up = f"{issuer} {guarantor}".upper()
    for k in AGENCY_KEYS:
        if k in up + " ":
            return TAX_OTHER, f"agenzia non equiparata ({k.strip()}, 26%)"
    is_gov_tipologia = t in GOV_TIPOLOGIE or t == "eurobonds republic of italy" or any(
        kk in t for kk in ["titoli di stato", "t-bond", "t-note", "tips", "sovereign", "buoni ordinari", "buoni poliennali",
                           "certificati del tesoro", "certificati di credito"])
    if is_gov_tipologia:
        if any(k in up for k in SOVEREIGN_KEYS):
            return TAX_GOV, "titolo di Stato (12,5%)"
        for k in SUPRANATIONAL_KEYS:
            if re.search(rf"\b{re.escape(k)}\b", up):
                return TAX_GOV, f"sovranazionale ({k}, 12,5%)"
        return TAX_GOV, "classificato titolo di Stato estero da Borsa Italiana (12,5%, da confermare con i dati BI)"
    for k in SUPRANATIONAL_KEYS:
        if re.search(rf"\b{re.escape(k)}\b", up):
            return TAX_GOV, f"sovranazionale/equiparato ({k}, 12,5%)"
    return TAX_OTHER, "altro emittente (26%)"


# ----------------------------------------------------------------------------
# Flussi di cassa
# ----------------------------------------------------------------------------
def coupon_schedule(maturity: date, freq: int, settle: date, accrual_start: Optional[date],
                    first_coupon: Optional[date] = None) -> tuple[list[date], Optional[date]]:
    """Ritorna (date cedola future > settle, in ordine) e la data cedola precedente (<= settle).
    Le date regolari si ricavano a ritroso dalla scadenza. Se è nota la data della PRIMA cedola
    (scheda BI "Data Stacco prima Cedola"), le date regolari precedenti vengono scartate e il primo
    periodo va dal godimento alla prima cedola (corto o lungo)."""
    if freq <= 0:
        return [], accrual_start
    step = 12 // freq
    if first_coupon is not None and accrual_start is not None and first_coupon <= accrual_start:
        first_coupon = None   # dato incoerente: ignoro
    dates = []
    d = maturity
    k = 0
    prev = None
    while True:
        if first_coupon is not None and d < first_coupon:
            prev = accrual_start if accrual_start is not None else d
            break
        if d > settle:
            dates.append(d)
        else:
            prev = d
            break
        k += 1
        d = add_months(maturity, -step * k)
        if accrual_start and d < accrual_start:
            prev = accrual_start
            break
        if k > 2000:
            break
    if first_coupon is not None and first_coupon > settle and first_coupon not in dates:
        dates.append(first_coupon)       # prima cedola irregolare non allineata alle date regolari
        dates = [x for x in dates if x >= first_coupon]
    dates.sort()
    return dates, prev


def notional_period_days(next_: date, freq: int) -> int:
    """Lunghezza del periodo cedolare regolare che termina in next_ (ACT/ACT ICMA)."""
    return (next_ - add_months(next_, -(12 // freq))).days


def first_coupon_factor(prev: Optional[date], next_: Optional[date], freq: int, accrual_start: Optional[date]) -> float:
    """Se il periodo in corso parte dal godimento (prima cedola corta/lunga), la prima cedola vale
    (next - godimento) / periodo regolare. Altrimenti 1. (Schatz 3% Dec28: rateo BI 0,  nostro 1,04 prima del fix.)"""
    if freq <= 0 or prev is None or next_ is None or accrual_start is None or prev != accrual_start:
        return 1.0
    return (next_ - prev).days / notional_period_days(next_, freq)


def accrued_interest(coupon_annual: float, freq: int, settle: date, prev: Optional[date], next_: Optional[date]) -> float:
    """ACT/ACT (ICMA): rateo = cedola periodale * giorni maturati / giorni del periodo REGOLARE.
    Con prima cedola corta (prev = godimento) il denominatore resta il periodo regolare."""
    if freq <= 0 or prev is None or next_ is None or next_ <= prev:
        return 0.0
    per = coupon_annual / freq
    return per * (settle - prev).days / notional_period_days(next_, freq)


def stepup_rate_for(plan: dict):
    """Da una voce di stepup.json ritorna rate_for(d): tasso annuo della cedola pagata in d.
    L'anno k (1..n) va dal k-1-esimo al k-esimo anniversario del godimento; la cedola pagata in d appartiene all'anno
    in cui cade d (d coincide con la fine del periodo). final_coupon: unica cedola a scadenza (BTP Valore Insieme)."""
    g = date.fromisoformat(plan["godimento"]); m = date.fromisoformat(plan["maturity"])
    bounds = []; y = 0
    for n_years, rate in plan["phases"]:
        y += n_years; bounds.append((y, float(rate)))
    def months_between(a: date, b: date) -> int:
        return (b.year - a.year) * 12 + (b.month - a.month) - (1 if b.day < a.day - 3 else 0)
    def rate_for(d: date) -> float:
        if plan.get("final_coupon") is not None:
            return float(plan["final_coupon"]) if d >= m else 0.0
        k = max(1, -(-months_between(g, d) // 12))   # ceil
        for yb, rate in bounds:
            if k <= yb:
                return rate
        return bounds[-1][1]
    return rate_for


def modified_duration(flows: list[tuple[float, float]], y: Optional[float]) -> Optional[float]:
    """Duration modificata = Macaulay / (1+y), sui flussi positivi (cedole e rimborso) scontati al rendimento y
    (capitalizzazione annua, tempi ACT/365 come l'IRR). Approssima la variazione % del prezzo tel quel per +1 punto di tasso.
    Borsa Italiana pubblica la stessa grandezza: verificata entro 0,02 su BTP e corporate (06/11/2026)."""
    if y is None or y <= -1:
        return None
    pv = sum(cf / (1 + y) ** t for t, cf in flows if t > 0)
    if pv <= 0:
        return None
    mac = sum(t * cf / (1 + y) ** t for t, cf in flows if t > 0) / pv
    return mac / (1 + y)


def irr(flows: list[tuple[float, float]], guess: float = 0.03) -> Optional[float]:
    """flows = [(t_anni, importo)], tasso annuo composto. Newton con fallback bisezione."""
    def npv(r):
        return sum(cf / (1 + r) ** t for t, cf in flows)
    lo, hi = -0.99, 5.0
    f_lo, f_hi = npv(lo), npv(hi)
    if f_lo * f_hi > 0:
        return None
    r = guess
    for _ in range(50):
        f = npv(r)
        d = sum(-t * cf / (1 + r) ** (t + 1) for t, cf in flows)
        if d == 0:
            break
        nr = r - f / d
        if not (lo < nr < hi):
            break
        if abs(nr - r) < 1e-12:
            return nr
        r = nr
    for _ in range(200):  # bisezione
        mid = (lo + hi) / 2
        fm = npv(mid)
        if f_lo * fm <= 0:
            hi, f_hi = mid, fm
        else:
            lo, f_lo = mid, fm
        if hi - lo < 1e-12:
            break
    return (lo + hi) / 2


# ----------------------------------------------------------------------------
# Risultato
# ----------------------------------------------------------------------------
@dataclass
class YieldResult:
    price_used: float
    price_source: str            # "ask" | "ref" | "last"
    trade_date: date
    settle_date: date
    years_to_maturity: float
    tax_rate: float
    accrued_gross: float         # per 100
    accrued_net: float           # per 100
    next_coupon_date: Optional[date]
    coupon_net_per_period: float  # per 100
    # rendimenti lordi / netti senza costi (confrontabili con Borsa Italiana)
    ytm_gross: Optional[float]
    ytm_net_tax: Optional[float]
    ytm_net_bi_convention: Optional[float]   # solo per verifica incrociata con Borsa Italiana
    # all-in: tasse + commissioni + bollo
    ytm_net_all: Optional[float]
    simple_net_all: Optional[float]      # netto annuo semplice, senza reinvestimento
    current_yield_gross: float           # cedola annua / prezzo
    mod_duration: Optional[float]        # duration modificata (flussi lordi, capitalizzazione annua): -dP/P per +1 punto di tasso
    first_coupon_factor: float           # frazione della prima cedola (1 = regolare; <1 prima cedola corta)
    # importi in € sul nominale di riferimento
    nominal: float
    cost_total_eur: float                # prezzo + rateo netto + commissioni
    commission_eur: float
    bollo_total_eur: float
    coupons_net_total_eur: float
    redemption_net_eur: float
    capital_gain_tax_eur: float
    minus_eur: float                      # minusvalenza generata se prezzo > 100
    net_gain_total_eur: float
    notes: list


def compute(price: float, price_source: str, trade_date: date, maturity: date,
            coupon_annual: float, freq: int, tax_rate: float, kind: str,
            accrual_start: Optional[date], costs: CostParams, bi_taxes_discount: bool = True,
            first_coupon: Optional[date] = None, rate_for: Optional[Callable[[date], float]] = None) -> YieldResult:
    """bi_taxes_discount: True per strip/BOT/Zc (BI tassa lo scarto nel suo netto), False per i "Tf 0%"
    (BI li tratta come titoli con cedola: netto = lordo). Influenza SOLO ytm_net_bi_convention.
    rate_for(d): tasso annuo % della cedola pagata alla data d (step-up: BTP Valore/Futura/Più, tabella stepup.json);
    coupon_annual resta il tasso del periodo in corso e serve per il rateo."""
    settle = settlement_date(trade_date)
    years = (maturity - settle).days / 365.0
    notes: list[str] = []
    if kind == "zero":
        coupon_annual, freq = 0.0, 0

    future, prev = coupon_schedule(maturity, freq, settle, accrual_start, first_coupon)
    next_ = future[0] if future else None
    acc_g = accrued_interest(coupon_annual, freq, settle, prev, next_)
    acc_n = acc_g * (1 - tax_rate)
    per = coupon_annual / freq if freq else 0.0
    per_net = per * (1 - tax_rate)
    f1 = first_coupon_factor(prev, next_, freq, accrual_start)   # prima cedola corta/lunga
    def cpn_g(i: int) -> float:
        p_i = (rate_for(future[i]) / freq) if (rate_for and freq) else per
        return p_i * (f1 if i == 0 else 1.0)
    def cpn_n(i: int) -> float: return cpn_g(i) * (1 - tax_rate)

    gain = max(0.0, 100.0 - price)
    cg_tax = tax_rate * gain
    minus = max(0.0, price - 100.0)
    redemption_net = 100.0 - cg_tax

    def yf(d: date) -> float:
        return (d - settle).days / 365.0

    # --- YTM lordo (nessun costo, nessuna tassa): confrontabile con BI "lordo"
    flows_g = [(0.0, -(price + acc_g))] + [(yf(d), cpn_g(i)) for i, d in enumerate(future)] + [(yf(maturity), 100.0)]
    ytm_g = irr(flows_g)
    mod_dur = modified_duration(flows_g, ytm_g)

    # --- YTM netto solo tasse (cedole, rateo E plusvalenza): il nostro dato
    flows_n = [(0.0, -(price + acc_n))] + [(yf(d), cpn_n(i)) for i, d in enumerate(future)] + [(yf(maturity), redemption_net)]
    ytm_n = irr(flows_n)

    # --- YTM netto "convenzione Borsa Italiana": tassa cedole e rateo ma NON la plusvalenza.
    #     Verificato il 04/11/2026 sul BTP 3,1% Mz40: BI 4,21 vs questo calcolo 4,207 (il nostro 4,088).
    #     Serve SOLO come verifica incrociata del parser e dell'aliquota, non viene mostrato come dato.
    #     ECCEZIONE zero coupon (verificata su 11 strip BTP il 04/11/2026, netto/lordo BI = 0,875):
    #     lo scarto di emissione è "reddito di capitale" e BI lo tassa -> coincide con il nostro netto.
    if kind == "zero" and bi_taxes_discount:
        ytm_bi_conv = ytm_n
    else:
        flows_bi = [(0.0, -(price + acc_n))] + [(yf(d), cpn_n(i)) for i, d in enumerate(future)] + [(yf(maturity), 100.0)]
        ytm_bi_conv = irr(flows_bi)

    # --- all-in sul nominale di riferimento
    N = max(costs.nominal, 0.0)
    ctv_gross = (price + acc_g) / 100.0 * N
    comm = ctv_gross * costs.commission_pct
    comm = max(comm, costs.commission_min)
    if costs.commission_max is not None:
        comm = min(comm, costs.commission_max)
    # bollo: 0,2% annuo su valore medio approssimato media(prezzo,100), per anno o frazione
    avg_val = (price + 100.0) / 2.0 / 100.0 * N
    bollo_flows = []
    t = 1.0
    while t < years:
        bollo_flows.append((t, -avg_val * costs.bollo_rate))
        t += 1.0
    frac = years - (t - 1.0)
    if frac > 0:
        bollo_flows.append((years, -avg_val * costs.bollo_rate * frac))
    bollo_total = -sum(cf for _, cf in bollo_flows)

    cost_total = (price + acc_n) / 100.0 * N + comm
    coupons_net_total = sum(cpn_n(i) for i in range(len(future))) / 100.0 * N
    redemption_eur = redemption_net / 100.0 * N
    net_gain = coupons_net_total + redemption_eur - cost_total - bollo_total

    flows_all = ([(0.0, -cost_total)] + [(yf(d), cpn_n(i) / 100.0 * N) for i, d in enumerate(future)]
                 + [(yf(maturity), redemption_eur)] + bollo_flows)
    ytm_all = irr(flows_all) if N > 0 else None
    simple_all = (net_gain / cost_total / years) if (cost_total > 0 and years > 0) else None

    if minus > 0:
        notes.append(f"Prezzo sopra la pari: a scadenza si genera una minusvalenza di {minus:.2f} per 100 "
                     f"(credito fiscale compensabile entro 4 anni, non conteggiato nel rendimento).")
    if price_source != "ask":
        notes.append("Rendimento calcolato sul prezzo di riferimento/ultimo: nessuna proposta in vendita (ask) disponibile.")

    return YieldResult(
        price_used=price, price_source=price_source, trade_date=trade_date, settle_date=settle,
        years_to_maturity=years, tax_rate=tax_rate, accrued_gross=acc_g, accrued_net=acc_n,
        next_coupon_date=next_, coupon_net_per_period=per_net,
        ytm_gross=ytm_g, ytm_net_tax=ytm_n, ytm_net_bi_convention=ytm_bi_conv, ytm_net_all=ytm_all, simple_net_all=simple_all,
        current_yield_gross=(coupon_annual / price if price else 0.0), mod_duration=mod_dur, first_coupon_factor=f1,
        nominal=N, cost_total_eur=cost_total, commission_eur=comm, bollo_total_eur=bollo_total,
        coupons_net_total_eur=coupons_net_total, redemption_net_eur=redemption_eur,
        capital_gain_tax_eur=cg_tax / 100.0 * N, minus_eur=minus / 100.0 * N,
        net_gain_total_eur=net_gain, notes=notes,
    )


def result_to_dict(r: YieldResult) -> dict:
    d = asdict(r)
    for k, v in d.items():
        if isinstance(v, date):
            d[k] = v.isoformat()
        elif isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            d[k] = None
    return d
