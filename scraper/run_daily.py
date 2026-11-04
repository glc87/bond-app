"""
run_daily.py — v0.1.0
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
import json
import logging
import sys
import time
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path

import borsa_italiana as bi
import yields as y

VERSION = "0.1.0"
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

log = logging.getLogger("run_daily")


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

    rec = {
        "isin": s.isin or row.isin,
        "name": s.name or row.name,
        "issuer": s.issuer or row.issuer_hint,
        "country": country_from_isin(s.isin or row.isin),
        "segment": row.segment,
        "tipologia": s.tipologia,
        "structure": s.structure,
        "tipo_bond": b.tipo_bond,
        "kind": cls.kind,
        "computable": cls.computable and price is not None and s.maturity is not None,
        "not_computable_reason": cls.reason if not cls.computable else ("prezzo o scadenza mancanti" if (price is None or s.maturity is None) else ""),
        "currency": s.currency_trade or "",
        "min_lot": s.min_lot,
        "outstanding": s.outstanding,
        "maturity": s.maturity.isoformat() if s.maturity else None,
        "accrual_start": s.accrual_start.isoformat() if s.accrual_start else None,
        "coupon_annual": cpn,
        "coupon_frequency": freq,
        "coupon_frequency_label": s.coupon_frequency,
        "day_count": s.day_count,
        "subordinated": s.subordinated,
        "tax_rate": tax,
        "tax_reason": tax_why,
        "price": {
            "used": price, "source": src,
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
            r = y.compute(price, src, trade_date, s.maturity, cpn or 0.0, freq, tax, cls.kind, s.accrual_start, costs)
            rec["calc"] = y.result_to_dict(r)
            # --- verifiche incrociate con Borsa Italiana (sul prezzo di riferimento, come fa BI)
            chk = {}
            if ref and s.bi_yield_gross is not None:
                r_ref = y.compute(ref, "ref", s.ref_date or trade_date, s.maturity, cpn or 0.0, freq, tax, cls.kind, s.accrual_start, costs)
                if r_ref.ytm_gross is not None:
                    chk["ytm_gross_vs_bi"] = round(r_ref.ytm_gross * 100 - s.bi_yield_gross, 3)
                if r_ref.ytm_net_bi_convention is not None and s.bi_yield_net is not None:
                    chk["ytm_net_biconv_vs_bi"] = round(r_ref.ytm_net_bi_convention * 100 - s.bi_yield_net, 3)
                    # aliquota dedotta: provo l'altra aliquota e vedo quale combacia meglio
                    other = y.TAX_OTHER if tax == y.TAX_GOV else y.TAX_GOV
                    r_oth = y.compute(ref, "ref", s.ref_date or trade_date, s.maturity, cpn or 0.0, freq, other, cls.kind, s.accrual_start, costs)
                    if r_oth.ytm_net_bi_convention is not None:
                        d_mine = abs(r_ref.ytm_net_bi_convention * 100 - s.bi_yield_net)
                        d_oth = abs(r_oth.ytm_net_bi_convention * 100 - s.bi_yield_net)
                        chk["tax_rate_confirmed"] = d_mine <= d_oth
                        if d_oth < d_mine:
                            anomalies.append(f"aliquota {tax:.3f} NON confermata da BI: il {other:.3f} combacia meglio")
                if s.bi_accrued_gross is not None:
                    chk["accrued_vs_bi"] = round(r_ref.accrued_gross - s.bi_accrued_gross, 5)
                if chk.get("ytm_gross_vs_bi") is not None and abs(chk["ytm_gross_vs_bi"]) > 0.05:
                    anomalies.append(f"YTM lordo scostato da BI di {chk['ytm_gross_vs_bi']}")
            rec["check"] = chk
        except Exception as e:  # mai far cadere il run per un titolo
            rec["computable"] = False
            rec["not_computable_reason"] = f"errore di calcolo: {e}"
            log.exception("Errore calcolo %s", rec["isin"])
    return rec


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--segments", nargs="*", default=None, choices=list(bi.SEGMENTS))
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--delay", type=float, default=1.0)
    ap.add_argument("--out", default=str(DATA))
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    out = Path(args.out); (out / "history").mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    trade_date = datetime.now(timezone.utc).astimezone().date()
    costs = y.CostParams()
    client = bi.Client(delay_s=args.delay)

    rows = bi.fetch_all_lists(client, args.segments)
    log.info("Liste: %d titoli unici", len(rows))
    if args.limit:
        rows = rows[: args.limit]

    records, failed = [], []
    for i, row in enumerate(rows, 1):
        try:
            s, b = bi.fetch_bond(client, row)
            records.append(build_record(row, s, b, trade_date, costs))
        except Exception as e:
            failed.append({"isin": row.isin, "error": str(e)})
            log.warning("Fallito %s: %s", row.isin, e)
        if i % 50 == 0:
            log.info("%d/%d titoli elaborati (%d richieste)", i, len(rows), client.n_requests)

    computable = [r for r in records if r["computable"]]
    meta = {
        "run_at": datetime.now(timezone.utc).isoformat(),
        "trade_date": trade_date.isoformat(),
        "versions": {"run_daily": VERSION, "borsa_italiana": bi.VERSION, "yields": y.VERSION},
        "cost_params_default": y.asdict(costs),
        "n_total": len(records), "n_computable": len(computable), "n_failed": len(failed),
        "by_kind": dict(Counter(r["kind"] for r in records)),
        "by_segment": dict(Counter(r["segment"] for r in records)),
        "by_currency": dict(Counter(r["currency"] for r in records)),
        "price_source": dict(Counter(r["price"]["source"] for r in records)),
        "n_with_anomalies": sum(1 for r in records if r["anomalies"]),
        "n_tax_not_confirmed": sum(1 for r in records if r["check"].get("tax_rate_confirmed") is False),
        "failed": failed,
        "requests": client.n_requests,
        "duration_s": round(time.time() - t0, 1),
    }
    (out / "bonds.json").write_text(json.dumps({"meta": meta, "bonds": records}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    hist = [{"isin": r["isin"], "p": r["price"]["used"], "src": r["price"]["source"],
             "yg": (r["calc"] or {}).get("ytm_gross"), "yn": (r["calc"] or {}).get("ytm_net_tax"),
             "sn": (r["calc"] or {}).get("simple_net_all")} for r in records]
    (out / "history" / f"{trade_date.isoformat()}.json").write_text(json.dumps(hist, separators=(",", ":")), encoding="utf-8")
    log.info("Fatto: %d titoli, %d calcolabili, %d falliti, %d richieste in %.0fs",
             len(records), len(computable), len(failed), client.n_requests, meta["duration_s"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
