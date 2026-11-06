"""
run_daily.py — v0.7.5
Job giornaliero: scarica tutti i titoli MOT da Borsa Italiana, calcola i rendimenti
netti e scrive:
  data/bonds.json              fotografia corrente (input + risultati con costi di default)
  data/meta.json               data run, statistiche, versioni, anomalie
  data/history/YYYY-MM-DD.json serie storica compatta (per i grafici futuri)

Uso:
  python run_daily.py                       # tutto il MOT
  python run_daily.py --segments btp bot    # solo alcuni segmenti
  python run_daily.py --limit 15            # primi N titoli (test)
  python run_daily.py --delay 1.0           # secondi tra richieste (default 1.0)
"""
from __future__ import annotations

import argparse
import functools
import json
import logging
import sys
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path

import borsa_italiana as bi
import eurotlx as tlx
import yields as y

VERSION = "0.7.5"
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

log = logging.getLogger("run_daily")


def _tlx_fetch(tlx_row: dict, client: "bi.Client", _row) -> tuple:
    return tlx.fetch_bond(client, tlx_row)


def country_from_isin(isin: str) -> str:
    return isin[:2] if isin and len(isin) >= 2 else ""


def build_record(row: bi.ListRow, s: bi.Scheda, b: bi.Book, trade_date: date, costs: y.CostParams) -> dict:
    anomalies: list[str] = []

    # --- cedola annua: preferisco il campo "su base annua", poi periodale*freq, poi il nome
    freq = y.frequency_from_text(s.coupon_frequency)
    cpn_name = y.coupon_from_name(s.name)
    if s.coupon_annual is not None:
        cpn = s.coupon_annual
    elif s.coupon_periodic is not None and freq > 0:
        cpn = round(s.coupon_periodic * freq, 6)
    elif s.coupon_periodic is not None and freq == 0 and cpn_name is not None:
        # periodale noto ma frequenza non letta: deduco la frequenza dal nome
        ratio = cpn_name / s.coupon_periodic if s.coupon_periodic else 0
        if abs(ratio - round(ratio)) < 1e-6 and round(ratio) in (1, 2, 4, 12):
            freq = int(round(ratio)); cpn = cpn_name
            anomalies.append(f"frequenza dedotta dal nome: {freq}")
        else:
            cpn = None
    else:
        cpn = cpn_name
        if cpn is not None:
            anomalies.append("cedola letta dal nome del titolo")
    if cpn is not None and cpn_name is not None and abs(cpn - cpn_name) > 0.011:
        anomalies.append(f"cedola scheda {cpn} ≠ cedola nel nome {cpn_name}")

    tax, tax_why = y.tax_rate_for(s.tipologia, s.issuer, s.guarantor)
    cls = y.classify(s.name, s.tipologia, s.structure, b.tipo_bond, cpn, freq)
    # Step-up con piano cedolare noto (BTP Valore/Futura/Più/Insieme, stepup.json): calcolabili, premio fedeltà escluso
    plan = STEPUP.get(s.isin)
    rate_for = None
    if plan and cls.kind == "stepup":
        if (freq or 0) != plan["freq"] or (s.maturity or row.maturity) != date.fromisoformat(plan["maturity"]):
            anomalies.append(f"piano step-up: frequenza/scadenza della tabella ({plan['freq']}, {plan['maturity']}) diverse dalla scheda ({freq}, {s.maturity})")
        else:
            rate_for = y.stepup_rate_for(plan)
            cur_rate = rate_for(y.add_months(date.fromisoformat(plan["godimento"]), 12 * ((trade_date - date.fromisoformat(plan["godimento"])).days // 365 + 1)))
            if plan.get("final_coupon") is None and cpn is not None and abs(cur_rate - cpn) > 0.011:
                anomalies.append(f"piano step-up: tasso di fase {cur_rate} ≠ cedola corrente della scheda {cpn}")
            if plan.get("accrual_rate") is not None:
                cpn = float(plan["accrual_rate"]); freq = plan["freq"]
            prem = plan.get("premium")
            cls = y.BondClass("stepup", True, "cedole crescenti da piano MEF" + (f"; premio fedeltà {prem}% solo per chi ha sottoscritto in collocamento: NON conteggiato" if prem else "") + ("; " + plan["put_note"] if plan.get("put_note") else ""))
    if "tel quel" in (s.trading_mode or "").lower() and cls.kind == "fixed" and (cpn or 0) > 0:
        cls = y.BondClass("fixed", False, "quotato tel quel (prezzo comprensivo di rateo): calcolo non supportato")

    # --- scadenza: BI scrive l'anno a 2 cifre ("Mz72" = 2072, "30/06/20" = 2120). Un titolo quotato
    #     scade per forza nel futuro: se la data letta è passata, è il secolo sbagliato (+100 anni).
    maturity = s.maturity or row.maturity
    while maturity and maturity <= trade_date:
        maturity = maturity.replace(year=maturity.year + 100)
        anomalies.append(f"scadenza letta come {s.maturity}, corretta in {maturity} (anno a 2 cifre)")

    # --- prezzo: ask del book se presente, altrimenti riferimento, altrimenti ultimo
    ref = s.ref_price or b.ref_price
    if b.ask:
        price, src = b.ask, "ask"
        if ref and abs(b.ask / ref - 1) > 0.03:
            anomalies.append(f"ask {b.ask} distante >3% dal riferimento {ref}")
    elif ref:
        price, src = ref, "ref"
    elif s.last_price or b.last_price:
        price, src = (s.last_price or b.last_price), "last"
    else:
        price, src = None, "none"

    # --- qualità del prezzo: un prezzo di riferimento su un titolo che non scambia è un prezzo fantasma
    #     (es. strip IT0005498727 a 91,80 = 8% di rendimento: nessun contratto nell'anno, nessun ask).
    traded_today = bool(b.n_trades_today) or bool(s.last_price and s.last_trade_time)
    if b.ask:
        price_quality = "ask"            # prezzo a cui si può comprare adesso
    elif traded_today:
        price_quality = "traded"         # riferimento di un titolo scambiato oggi: buono
    elif b.year_high is not None:
        price_quality = "quiet"          # non scambiato oggi, ma scambiato nell'anno: usare con cautela
    else:
        price_quality = "stale"          # nessun ask, nessuno scambio nell'anno: NON affidabile
        anomalies.append("prezzo fermo: nessuna proposta in vendita e nessuno scambio nell'anno")

    rec = {
        "isin": s.isin or row.isin,
        "name": s.name or row.name,
        "issuer": s.issuer or row.issuer_hint,
        "country": country_from_isin(s.isin or row.isin),
        "segment": row.segment,
        "market": s.market or "MOT",
        "tipologia": s.tipologia,
        "structure": s.structure,
        "tipo_bond": b.tipo_bond,
        "kind": cls.kind,
        "computable": cls.computable and price is not None and maturity is not None,
        "not_computable_reason": cls.reason if not cls.computable else ("prezzo o scadenza mancanti" if (price is None or maturity is None) else ""),
        "warning": cls.reason if cls.computable and cls.reason else "",
        "currency": s.currency_trade or "",
        "min_lot": s.min_lot,
        "outstanding": s.outstanding,
        "maturity": maturity.isoformat() if maturity else None,
        "accrual_start": s.accrual_start.isoformat() if s.accrual_start else None,
        "first_coupon_date": s.first_coupon_date.isoformat() if s.first_coupon_date else None,   # per la prima cedola lunga/corta (backlog)
        "coupon_annual": cpn,
        "coupon_frequency": freq,
        "coupon_frequency_label": s.coupon_frequency,
        "day_count": s.day_count,
        "subordinated": s.subordinated,
        "tax_rate": tax,
        "tax_reason": tax_why,
        "price": {
            "used": price, "source": src, "quality": price_quality,
            "traded_today": traded_today, "volume_today": b.volume_today, "n_trades_today": b.n_trades_today,
            "year_high": b.year_high, "year_low": b.year_low, "market_phase": b.market_phase,
            "ask": b.ask, "ask_qty": b.ask_qty, "bid": b.bid, "bid_qty": b.bid_qty,
            "ref": ref, "ref_date": s.ref_date.isoformat() if s.ref_date else None,
            "last": s.last_price or b.last_price, "last_time": s.last_trade_time,
            "official": s.official_price,
        },
        "bi": {   # dati pubblicati da Borsa Italiana, usati per verifica
            "yield_gross": s.bi_yield_gross, "yield_net": s.bi_yield_net,
            "accrued_gross": s.bi_accrued_gross, "accrued_net": s.bi_accrued_net,
            "mod_duration": s.bi_mod_duration,
        },
        "calc": None,
        "check": {},
        "anomalies": anomalies,
        "scheda_url": row.scheda_url,
    }

    if rec["computable"]:
        try:
            chk = {}
            # --- verifiche incrociate con Borsa Italiana (sul prezzo di riferimento, come fa BI)
            if ref and s.bi_yield_gross is not None:
                ref_date = s.ref_date or trade_date
                true_zc = y.is_true_zero_coupon(s.name, b.tipo_bond, s.tipologia)
                r_ref = y.compute(ref, "ref", ref_date, maturity, cpn or 0.0, freq, tax, cls.kind, s.accrual_start, costs, true_zc, s.first_coupon_date, rate_for)
                if r_ref.ytm_gross is not None:
                    chk["ytm_gross_vs_bi"] = round(r_ref.ytm_gross * 100 - s.bi_yield_gross, 3)
                    chk["ytm_gross_on_ref"] = round(r_ref.ytm_gross * 100, 3)
                if s.bi_accrued_gross is not None:
                    chk["accrued_vs_bi"] = round(r_ref.accrued_gross - s.bi_accrued_gross, 5)
                if r_ref.ytm_net_bi_convention is not None and s.bi_yield_net is not None:
                    chk["ytm_net_biconv_vs_bi"] = round(r_ref.ytm_net_bi_convention * 100 - s.bi_yield_net, 3)
                    # Deduzione dell'aliquota dal netto pubblicato da BI: confronto le due ipotesi (12,5% e 26%).
                    # Il segnale è utile solo se le due ipotesi distano abbastanza (titoli brevi a cedola bassa: no).
                    other = y.TAX_OTHER if tax == y.TAX_GOV else y.TAX_GOV
                    r_oth = y.compute(ref, "ref", ref_date, maturity, cpn or 0.0, freq, other, cls.kind, s.accrual_start, costs, true_zc, s.first_coupon_date, rate_for)
                    if r_oth.ytm_net_bi_convention is not None:
                        mine = r_ref.ytm_net_bi_convention * 100
                        oth = r_oth.ytm_net_bi_convention * 100
                        gap = abs(mine - oth)
                        d_mine, d_oth = abs(mine - s.bi_yield_net), abs(oth - s.bi_yield_net)
                        if gap < 0.15:
                            chk["tax_rate_confirmed"] = None     # non discriminante
                        elif d_mine <= d_oth:
                            chk["tax_rate_confirmed"] = True
                        else:
                            chk["tax_rate_confirmed"] = False
                            if d_oth < gap / 3:   # l'altra aliquota combacia chiaramente: la adotto
                                anomalies.append(f"aliquota {tax:.3f} ({tax_why}) contraddetta da BI: adottata {other:.3f}")
                                tax, tax_why = other, f"dedotta dai rendimenti netti di Borsa Italiana ({other*100:.1f}%)"
                                rec["tax_rate"], rec["tax_reason"] = tax, tax_why
                                chk["ytm_net_biconv_vs_bi"] = round(oth - s.bi_yield_net, 3)
                            else:
                                anomalies.append(f"aliquota {tax:.3f} non confermata da BI (nessuna delle due combacia bene)")
                if chk.get("ytm_gross_vs_bi") is not None and abs(chk["ytm_gross_vs_bi"]) > 0.05 and r_ref.years_to_maturity > 0.5:
                    anomalies.append(f"YTM lordo scostato da BI di {chk['ytm_gross_vs_bi']}")
            r = y.compute(price, src, trade_date, maturity, cpn or 0.0, freq, tax, cls.kind, s.accrual_start, costs, True, s.first_coupon_date, rate_for)
            rec["calc"] = y.result_to_dict(r)
            if rate_for is not None:
                rec["stepup"] = {k: plan[k] for k in ("name", "godimento", "maturity", "freq", "phases", "final_coupon", "accrual_rate", "premium", "put", "put_note") if k in plan}
            rec["check"] = chk
            # Zero coupon richiamabili quotati vicino alla pari con vita lunga (Citigroup/GS "Gm Zc ... Call", run 05/11/2026):
            # non sono veri zero coupon ma strutture con rimborso crescente (BI pubblica 4-6%, il prezzo implica <1%).
            # Un vero ZC a 20 anni a 95 renderebbe lo 0,25%: non plausibile -> non calcolabile.
            # (classify li marca "callable", non "zero": il controllo guarda il nome "Zc" — run 06/11: 10 Citigroup ancora calcolati)
            if cls.kind in ("zero", "callable") and " zc " in f" {s.name.lower()} " and " call" in f" {s.name.lower()} " and r.ytm_gross is not None and r.ytm_gross < 0.015 and r.years_to_maturity > 5:
                rec["computable"] = False; rec["kind"] = "structured"; rec["calc"] = None
                rec["not_computable_reason"] = "zero coupon richiamabile con rimborso crescente (struttura): rendimento non determinabile dal prezzo"
        except Exception as e:  # mai far cadere il run per un titolo
            rec["computable"] = False
            rec["not_computable_reason"] = f"errore di calcolo: {e}"
            log.exception("Errore calcolo %s", rec["isin"])
    return rec


SERIES_SHARDS = 64


def series_shard(isin: str) -> str:
    """Cassetto 00..63 scelto con un hash semplice dell'ISIN (stessa formula in app.js: seriesShard).
    Poche decine di file di dimensione uniforme invece di uno per titolo."""
    h = 0
    for ch in isin.upper():
        h = (h * 31 + ord(ch)) % 1_000_003
    return f"{h % SERIES_SHARDS:02d}"


def update_series(out: Path, trade_date: date, hist: list, max_points: int = 1500) -> None:
    """data/series/<shard>.json = {ISIN: [[data, prezzo, ytm_lordo, ytm_netto, netto_semplice, fonte], ...]}.
    Il punto di oggi sostituisce un eventuale punto con la stessa data (run ripetuti)."""
    sdir = out / "series"; sdir.mkdir(parents=True, exist_ok=True)
    today = trade_date.isoformat()
    r4 = lambda v: round(v, 5) if isinstance(v, (int, float)) else None
    by_shard: dict[str, list] = {}
    for h in hist:
        by_shard.setdefault(series_shard(h["isin"]), []).append(h)
    for shard, items in by_shard.items():
        f = sdir / f"{shard}.json"
        try:
            data = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
        except Exception:
            data = {}
        for h in items:
            pts = [pt for pt in data.get(h["isin"], []) if pt[0] != today]
            pts.append([today, h["p"], r4(h["yg"]), r4(h["yn"]), r4(h["sn"]), h["src"]])
            pts.sort(key=lambda pt: pt[0])
            data[h["isin"]] = pts[-max_points:]
        f.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")


ECB_FX_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"


def fetch_ecb_rates(client: "bi.Client") -> dict:
    """Tassi di cambio di riferimento BCE (1 EUR = x valuta), pubblicati ogni giorno lavorativo alle 16:00 CET."""
    try:
        xml = client.get(ECB_FX_URL)
        root = ET.fromstring(xml)
        ns = {"e": "http://www.ecb.int/vocabulary/2002-08-01/eurofxref"}
        day = root.find(".//e:Cube[@time]", ns)
        rates = {c.get("currency"): float(c.get("rate")) for c in day.findall("e:Cube", ns)}
        rates["EUR"] = 1.0
        return {"date": day.get("time"), "base": "EUR", "rates": rates, "source": ECB_FX_URL}
    except Exception as e:
        log.warning("Cambi BCE non disponibili: %s", e)
        return {"date": None, "base": "EUR", "rates": {"EUR": 1.0}, "source": ECB_FX_URL, "error": str(e)}


def liquidity_from_history(out: Path, trade_date: date, records: list, days: int = 20) -> None:
    """Per ogni titolo: su quante delle ultime `days` rilevazioni (compresa oggi) c'era un ask nel book.
    Scrive rec["liquidity"] = {"days": n, "ask_days": k, "score": k/n}. Fonte: data/history/*.json (campo src)."""
    files = sorted((out / "history").glob("*.json"))
    files = [f for f in files if f.stem < trade_date.isoformat()][-(days - 1):]
    ask_days: dict[str, int] = {}
    for f in files:
        try:
            for h in json.loads(f.read_text(encoding="utf-8")):
                if h.get("src") == "ask":
                    ask_days[h["isin"]] = ask_days.get(h["isin"], 0) + 1
        except Exception as e:
            log.warning("history %s illeggibile: %s", f.name, e)
    n = len(files) + 1
    for r in records:
        k = ask_days.get(r["isin"], 0) + (1 if r["price"]["source"] == "ask" else 0)
        r["liquidity"] = {"days": n, "ask_days": k, "score": round(k / n, 3)}


def bi_yield_lag_check(out: Path, trade_date: date, records: list) -> dict:
    """Ipotesi da verificare (run 05/11/2026): su EuroTLX il rendimento pubblicato da Borsa Italiana non combacia
    col prezzo di riferimento del giorno (mediana -0,04, solo 19% entro 0,02; su MOT 97%). Se BI pubblica il
    rendimento calcolato sul riferimento del giorno PRIMA, allora BI(oggi) ~= nostro YTM(rif di ieri).
    Scrive check["bi_vs_prev_ref"] = BI oggi - nostro YTM sul riferimento di ieri (dal file history di ieri)
    e ritorna il riepilogo per mercato."""
    files = sorted(f for f in (out / "history").glob("*.json") if f.stem < trade_date.isoformat())
    if not files:
        return {}
    try:
        prev = {h["isin"]: h for h in json.loads(files[-1].read_text(encoding="utf-8")) if h.get("yr") is not None}
    except Exception as e:
        log.warning("history %s illeggibile: %s", files[-1].name, e); return {}
    out_stats: dict[str, dict] = {}
    for r in records:
        bg = r["bi"].get("yield_gross"); p = prev.get(r["isin"])
        if bg is None or p is None or not r.get("computable"):
            continue
        d = round(bg - p["yr"], 3)
        r["check"]["bi_vs_prev_ref"] = d
        st = out_stats.setdefault(r["market"], {"n": 0, "within_0_02": 0, "deltas": []})
        st["n"] += 1; st["within_0_02"] += abs(d) <= 0.02; st["deltas"].append(d)
    for m, st in out_stats.items():
        ds = sorted(st.pop("deltas")); st["median"] = ds[len(ds) // 2] if ds else None; st["prev_file"] = files[-1].stem
    return out_stats


def bi_check_summary(records: list, bi_lag: dict) -> dict:
    """Riepilogo per mercato dell'accordo col rendimento lordo pubblicato da BI (titoli con vita residua > 6 mesi)."""
    res = {}
    for m in sorted({r["market"] for r in records}):
        ds = sorted(r["check"]["ytm_gross_vs_bi"] for r in records if r["market"] == m
                    and r["check"].get("ytm_gross_vs_bi") is not None and (r.get("calc") or {}).get("years_to_maturity", 0) > 0.5)
        if ds:
            res[m] = {"n": len(ds), "within_0_02": sum(abs(d) <= 0.02 for d in ds), "beyond_0_25": sum(abs(d) > 0.25 for d in ds),
                      "median": ds[len(ds) // 2], "vs_prev_ref": bi_lag.get(m)}
    return res


STEPUP: dict = {}
try:
    STEPUP = {k: v for k, v in json.loads((Path(__file__).parent / "stepup.json").read_text(encoding="utf-8")).items() if not k.startswith("_")}
except Exception as _e:   # senza tabella i titoli restano semplicemente non calcolabili
    log.warning("stepup.json non caricato: %s", _e)


def category_of(rec: dict) -> str:   # stessa logica di app.js category()
    t = (rec.get("tipologia") or "").lower(); r = rec.get("tax_reason") or ""
    if t == "titoli di stato italiani" or (r.startswith("titolo di Stato") and rec.get("country") == "IT"): return "gov_it"
    if t == "titoli di stato esteri" or r.startswith("titolo di Stato") or r.startswith("classificato titolo di Stato"): return "gov_fx"
    if "sovranazionale" in r: return "supra"
    return "other"


def is_uncertain(rec: dict) -> bool:   # stessa logica di app.js uncertainReason() (senza anni: fatto a parte)
    q = rec["price"].get("quality")
    if q in ("stale", "quiet"): return True
    ck = rec.get("check") or {}
    if ck.get("ytm_gross_vs_bi") is not None and abs(ck["ytm_gross_vs_bi"]) > 0.25 and (rec.get("calc") or {}).get("years_to_maturity", 0) > 0.5: return True
    if ck.get("tax_rate_confirmed") is False: return True
    return any(a.startswith("cedola scheda") for a in rec.get("anomalies", []))


def evaluate_alerts(rules: list, records: list) -> list:
    """Stessa semantica di alerts.js matches(): ritorna [(regola, [record...]), ...] per le regole scattate."""
    out = []
    for r in rules:
        hits = []
        for b in records:
            calc = b.get("calc") or {}
            if r.get("isin"):
                if b["isin"] != r["isin"].upper(): continue
            else:
                if not calc or is_uncertain(b) or "strip" in b["name"].lower(): continue
                if r.get("cat") and category_of(b) != r["cat"]: continue
                cur = r.get("currency") or "EUR"
                if cur != "*" and b["currency"] != cur: continue
                yrs = calc.get("years_to_maturity")
                if r.get("ymin") is not None and not (yrs is not None and yrs >= r["ymin"]): continue
                if r.get("ymax") is not None and not (yrs is not None and yrs <= r["ymax"]): continue
            m = r.get("metric", "ytm_net_all")
            v = b["price"]["used"] if m == "price" else calc.get(m)
            if v is None: continue
            x = v if m == "price" else v * 100
            if (x >= r["value"]) if r.get("op", ">=") == ">=" else (x <= r["value"]):
                hits.append(b)
        if hits:
            out.append((r, hits))
    return out


def rule_key(r: dict) -> str:
    """Identita' stabile di una regola (senza id): per confrontare gli scattati di oggi con quelli di ieri."""
    return json.dumps({k: r.get(k) for k in ("metric", "op", "value", "isin", "cat", "currency", "ymin", "ymax")}, sort_keys=True)


def alerts_report(fired: list, trade_date: date, previous: Optional[dict] = None) -> str:
    """Report per la Issue. Con `previous` (alerts_fired.json del giorno prima) evidenzia i titoli NUOVI (oggi si', ieri no)
    e ritorna "" se non c'e' nessuna novita': cosi' l'email arriva solo quando cambia qualcosa, non ogni giorno
    (06/11/2026: la prima regola scattava su 35 titoli, identici un giorno dopo l'altro)."""
    prev = {}
    for f in (previous or {}).get("fired", []):
        prev[rule_key(f["rule"])] = set(f.get("isins", []))
    has_prev = previous is not None
    new_total = 0
    lines = [f"Avvisi con i dati del {trade_date.isoformat()} (https://glc87.github.io/bond-app/)", ""]
    for r, hits in fired:
        before = prev.get(rule_key(r))
        new = [b for b in hits if before is None or b["isin"] not in before]
        gone = sorted(before - {b["isin"] for b in hits}) if before else []
        new_total += len(new) if has_prev else 0
        scope = f"ISIN {r['isin']}" if r.get("isin") else f"{r.get('cat') or 'tutte le categorie'}, {r.get('currency') or 'EUR'}, {r.get('ymin') or 0}-{r.get('ymax') or '∞'} anni"
        unit = "" if r.get("metric") == "price" else "%"
        lines.append(f"### {r.get('metric','ytm_net_all')} {r.get('op','>=')} {r['value']}{unit} · {scope}" + (f" · {r['label']}" if r.get("label") else ""))
        lines.append(f"{len(hits)} titoli" + (f", **{len(new)} nuovi** rispetto a ieri" if has_prev and before is not None else "") + (f", {len(gone)} usciti" if gone else ""))
        def line(b, tag=""):
            c = b.get("calc") or {}
            return f"- {tag}{b['name']} ({b['isin']}): prezzo {b['price']['used']} [{b['price']['source']}], YTM netto all-in {((c.get('ytm_net_all') or 0)*100):.2f}%, scad. {b['maturity']}"
        bykey = lambda b: -((b.get("calc") or {}).get("ytm_net_all") or 0)
        for b in sorted(new, key=bykey)[:25]:
            lines.append(line(b, "**NUOVO** " if has_prev and before is not None else ""))
        rest = [b for b in hits if b not in new]
        if rest:
            lines.append(f"<details><summary>già segnalati ({len(rest)})</summary>")
            lines.append("")
            for b in sorted(rest, key=bykey)[:40]:
                lines.append(line(b))
            if len(rest) > 40:
                lines.append(f"- … e altri {len(rest) - 40}")
            lines.append("")
            lines.append("</details>")
        lines.append("")
    if has_prev and new_total == 0:
        return ""
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--segments", nargs="*", default=None, choices=list(bi.SEGMENTS))
    ap.add_argument("--sources", nargs="*", default=["mot", "tlx"], choices=["mot", "tlx"], help="mercati: mot (MOT) e/o tlx (EuroTLX)")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--delay", type=float, default=1.0)
    ap.add_argument("--out", default=str(DATA))
    ap.add_argument("--workers", type=int, default=2, help="richieste in parallelo (il ritmo --delay resta globale)")
    ap.add_argument("--force", action="store_true", help="esegui anche nei giorni di chiusura di Borsa Italiana")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    out = Path(args.out); (out / "history").mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    trade_date = datetime.now(timezone.utc).astimezone().date()
    if not y.is_trading_day(trade_date) and not args.force:
        log.info("%s: Borsa Italiana chiusa, nessun aggiornamento (usa --force per eseguire comunque)", trade_date)
        return 0
    costs = y.CostParams()
    client = bi.Client(delay_s=args.delay)

    fx = fetch_ecb_rates(client)
    log.info("Cambi BCE del %s: %d valute", fx.get("date"), len(fx["rates"]))

    jobs = []   # (ListRow, fetch_fn)
    if "mot" in args.sources:
        rows = bi.fetch_all_lists(client, args.segments)
        log.info("Liste MOT: %d titoli unici", len(rows))
        jobs += [(r, bi.fetch_bond) for r in rows]
    if "tlx" in args.sources and not args.segments:
        trows = tlx.fetch_all_lists(client)
        log.info("Liste EuroTLX: %d titoli unici", len(trows))
        jobs += [(tlx.as_list_row(r), functools.partial(_tlx_fetch, r)) for r in trows]
    if args.limit:
        jobs = jobs[: args.limit]

    records, failed = [], []
    done = 0

    def work(row, fetch_fn):
        s, b = fetch_fn(client, row)
        return build_record(row, s, b, trade_date, costs)

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
        for row, fut in [(row, ex.submit(work, row, fn)) for row, fn in jobs]:
            try:
                records.append(fut.result())
            except Exception as e:
                failed.append({"isin": row.isin, "error": str(e)})
                log.warning("Fallito %s: %s", row.isin, e)
            done += 1
            if done % 50 == 0:
                log.info("%d/%d titoli elaborati (%d richieste)", done, len(jobs), client.n_requests)

    # --- stesso ISIN su MOT ed EuroTLX: tengo il record con l'ask più basso (dove compreresti), segno entrambi i mercati
    by_isin: dict[str, dict] = {}
    for r in records:
        prev = by_isin.get(r["isin"])
        if prev is None:
            r["markets"] = [r["market"]]; by_isin[r["isin"]] = r; continue
        a_new, a_old = r["price"].get("ask"), prev["price"].get("ask")
        keep_new = (a_new is not None and (a_old is None or a_new < a_old))
        chosen, other = (r, prev) if keep_new else (prev, r)
        chosen["markets"] = sorted(set(prev.get("markets", [prev["market"]]) + [r["market"]]))
        chosen["other_market"] = {"market": other["market"], "ask": other["price"].get("ask"), "bid": other["price"].get("bid"), "ref": other["price"].get("ref")}
        by_isin[r["isin"]] = chosen
    n_dup = len(records) - len(by_isin)
    records = sorted(by_isin.values(), key=lambda r: r["isin"])
    log.info("Titoli unici: %d (%d presenti su entrambi i mercati)", len(records), n_dup)

    liquidity_from_history(out, trade_date, records)
    bi_lag = bi_yield_lag_check(out, trade_date, records)
    computable = [r for r in records if r["computable"]]
    meta = {
        "run_at": datetime.now(timezone.utc).isoformat(),
        "trade_date": trade_date.isoformat(),
        "versions": {"run_daily": VERSION, "borsa_italiana": bi.VERSION, "yields": y.VERSION},
        "cost_params_default": y.asdict(costs),
        "fx": fx,
        "n_total": len(records), "n_computable": len(computable), "n_failed": len(failed),
        "by_kind": dict(Counter(r["kind"] for r in records)),
        "by_segment": dict(Counter(r["segment"] for r in records)),
        "by_market": dict(Counter(r["market"] for r in records)),
        "n_both_markets": n_dup,
        "versions_extra": {"eurotlx": tlx.VERSION},
        "by_currency": dict(Counter(r["currency"] for r in records)),
        "price_source": dict(Counter(r["price"]["source"] for r in records)),
        "price_quality": dict(Counter(r["price"]["quality"] for r in records)),
        "n_with_anomalies": sum(1 for r in records if r["anomalies"]),
        "n_tax_not_confirmed": sum(1 for r in records if r["check"].get("tax_rate_confirmed") is False),
        "bi_check": bi_check_summary(records, bi_lag),
        "failed": failed,
        "requests": client.n_requests,
        "duration_s": round(time.time() - t0, 1),
    }
    (out / "bonds.json").write_text(json.dumps({"meta": meta, "bonds": records}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    hist = [{"isin": r["isin"], "p": r["price"]["used"], "src": r["price"]["source"],
             "yg": (r["calc"] or {}).get("ytm_gross"), "yn": (r["calc"] or {}).get("ytm_net_tax"),
             "sn": (r["calc"] or {}).get("simple_net_all"),
             # per la verifica del giorno dopo (bi_yield_lag_check): prezzo di riferimento, nostro YTM su quel prezzo, YTM pubblicato da BI
             "rf": r["price"].get("ref"), "yr": r["check"].get("ytm_gross_on_ref"), "bg": r["bi"].get("yield_gross")} for r in records]
    (out / "history" / f"{trade_date.isoformat()}.json").write_text(json.dumps(hist, separators=(",", ":")), encoding="utf-8")
    update_series(out, trade_date, hist)
    # --- avvisi (alerts.json nella root del repository, esportato dall'app)
    alerts_file = ROOT / "alerts.json"
    if alerts_file.exists():
        try:
            rules = json.loads(alerts_file.read_text(encoding="utf-8"))
            fired = evaluate_alerts(rules, records)
            previous = None
            try:
                pf = out / "alerts_fired.json"
                if pf.exists():
                    previous = json.loads(pf.read_text(encoding="utf-8"))
                    if previous.get("trade_date") == trade_date.isoformat():   # secondo run dello stesso giorno: confronta col giorno prima
                        previous = previous.get("previous") or previous
            except Exception as e:
                log.warning("alerts_fired.json precedente illeggibile: %s", e); previous = None
            today_fired = {"trade_date": trade_date.isoformat(), "fired": [{"rule": r, "isins": [b["isin"] for b in h]} for r, h in fired]}
            if previous: today_fired["previous"] = {"trade_date": previous.get("trade_date"), "fired": previous.get("fired", [])}
            (out / "alerts_fired.json").write_text(json.dumps(today_fired, ensure_ascii=False), encoding="utf-8")
            report = alerts_report(fired, trade_date, previous) if fired else ""
            (out / "alerts_report.md").write_text(report, encoding="utf-8")
            log.info("Avvisi: %d regole, %d scattate, email: %s", len(rules), len(fired), "sì (novità)" if report else "no")
        except Exception as e:
            log.warning("alerts.json non valido: %s", e)
    log.info("Fatto: %d titoli, %d calcolabili, %d falliti, %d richieste in %.0fs",
             len(records), len(computable), len(failed), client.n_requests, meta["duration_s"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
