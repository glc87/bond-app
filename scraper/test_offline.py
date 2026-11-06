"""
test_offline.py — v0.1.4
Test offline su pagine campione reali (fixtures/ prelevate il 04/11/2026).
Esegui:  python scraper/test_offline.py
"""
from datetime import date
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))
import borsa_italiana as bi  # noqa: E402
import yields as y           # noqa: E402

FX = Path(__file__).parent / "fixtures"


def approx(a, b, tol):
    assert a is not None and abs(a - b) <= tol, f"{a} vs {b} (tol {tol})"


def test_list():
    rows = bi.parse_list((FX / "lista_euro_p3.html").read_text(encoding="utf-8"), "euro-obbligazioni")
    assert [r.isin for r in rows] == ["BE0000291972", "IT0001174611"]
    assert rows[0].issuer_hint == "Kingdom Of Belgium" and rows[0].maturity == date(2028, 3, 28)
    assert rows[1].last == 103.178 and rows[1].coupon_list == 3.25


def test_scheda_and_yields():
    s = bi.parse_scheda((FX / "scheda_IT0005377152.html").read_text(encoding="utf-8"))
    assert s.isin == "IT0005377152" and s.maturity == date(2040, 3, 1)
    assert s.coupon_frequency == "Semestrale" and s.coupon_periodic == 1.55 and s.coupon_annual is None
    assert s.last_price == 85.56 and s.ref_price == 85.25 and s.bi_yield_gross == 4.64
    freq = y.frequency_from_text(s.coupon_frequency)
    cpn = s.coupon_periodic * freq
    tax, _ = y.tax_rate_for(s.tipologia, s.issuer)
    r = y.compute(85.25, "ref", s.ref_date, s.maturity, cpn, freq, tax, "fixed", s.accrual_start, y.CostParams())
    assert r.settle_date == date(2026, 11, 5)
    approx(r.accrued_gross, s.bi_accrued_gross, 1e-5)        # rateo identico a Borsa Italiana
    approx(r.accrued_net, s.bi_accrued_net, 1e-5)
    approx(r.ytm_gross * 100, s.bi_yield_gross, 0.01)         # 4,642 vs 4,64
    approx(r.ytm_net_bi_convention * 100, s.bi_yield_net, 0.01)  # 4,207 vs 4,21 (BI non tassa la plusvalenza)
    approx(r.ytm_net_tax * 100, 4.088, 0.005)                 # il nostro netto (coincide con Money.it 4,09)
    assert r.next_coupon_date == date(2027, 3, 1)


def test_book():
    b = bi.parse_dati_completi((FX / "dati_AT0000A10683.html").read_text(encoding="utf-8"))
    assert b.ask == 93.0 and b.bid == 92.82 and b.ask_qty == 536000 and len(b.levels) == 2
    assert b.tipo_bond == "Titolo Con Cedole Tf" and b.ref_price == 92.93


def test_classify():
    assert y.classify("Btpstripital Zc May27 Eur", "Titoli di stato italiani", "", "Zero Coupon", None, 0).kind == "zero"
    assert y.classify("Btp Italia Gn32 Eur", "Titoli di stato italiani", "", "", 1.85, 2).kind == "inflation"
    assert y.classify("Cct-Eu Tv Ot28 Eur", "Titoli di stato italiani", "", "", None, 2).kind == "floating"
    c = y.classify("Kme Group Tf 5% St27 Call Eur", "Obbligazioni", "", "", 5.0, 2); assert c.kind == "callable" and c.computable and c.reason
    assert y.classify("Btp Valore Gn27 Eur", "Titoli di stato italiani", "", "", 4.0, 4).kind == "stepup"
    assert y.classify("Austria Tf 2,4% Mg34 Eur", "Titoli di stato esteri", "Plain Vanilla", "", 2.4, 1).computable
    # strutturati / ammortizzanti / perpetui (run 05/11/2026 su EuroTLX)
    assert y.classify("Argentina 0.125% Call Sink 09lg30", "Titoli di Stato Emergenti", "", "", 0.125, 2).kind == "amortizing"
    assert y.classify("Uruguay Fx 4.375% Oct27 Amort Usd", "Titoli di Stato Emergenti", "", "", 4.375, 2).kind == "amortizing"
    assert y.classify("Ucg-Fix To Cms Call Sub 15ge32", "Obbligazioni Finanziarie", "", "", 6.0, 1).kind == "structured"
    assert y.classify("Barclaysbank Indlink Jul38 Autocall Eur", "Altri Titoli di Debito", "", "", None, 1).kind == "structured"
    assert y.classify("Db - Pimco Gis Income Fund 01mz28", "Obbligazioni Finanziarie", "", "", None, 1).kind == "structured"
    assert y.classify("Isp-Fix To Cms Sub Perpetual Call Eur", "Obbligazioni Finanziarie", "", "", 5.0, 1).kind == "structured"
    # ma non falsi positivi: "Cap" come emittente, "Funding", sukuk, "Sdg Linked"
    assert y.classify("Bmw Us Cap Fx 3% Nov27 Eur", "Obbligazioni Corporate", "", "", 3.0, 1).kind == "fixed"
    assert y.classify("Glencore Funding 3.875% Call 27ot27", "Obbligazioni Corporate", "", "", 3.875, 2).kind == "callable"
    assert y.classify("Eni Sdg Linked Tf 4,3% Fb28 Eur", "Obbligazioni Corporate", "", "", 4.3, 1).kind == "fixed"
    assert y.classify("Ebrd Zc Jun36 Call Zar", "Obbligazioni Sovranazionali", "", "", None, 1).kind == "callable"
    assert y.classify("Bnl Eur3m+0.4975% Jan29 Est Covered Eur", "Obbligazioni Finanziarie", "", "", 3.1355, 4).kind == "floating"
    assert y.classify("Mps Eur3m+0,53 Lg27 Est Covered Call Eur", "Obbligazioni", "", "", 3.148, 4).kind == "floating"
    assert y.classify("Italy 29eur Frn", "Titoli di Stato", "", "", 4.25, 2).kind == "floating"


def test_supranational_abbreviations():
    for issuer in ["BANCA EUROPEA PER LA RIC E LO SVIL", "EUROPEAN FINANC STABILITY FACILITY", "UE", "AIIB", "COUNCIL OF EUROPE SOCIAL DEVEL BANK"]:
        rate, reason = y.tax_rate_for("Titoli di stato esteri", issuer)
        assert rate == 0.125 and reason.startswith("sovranazionale"), (issuer, reason)
    rate, reason = y.tax_rate_for("Titoli di stato esteri", "REPUBLIC OF ROMANIA"); assert reason.startswith("titolo di Stato")


def test_zero_coupon_bi_convention():
    # Strip BTP Zc May29 (IT0001312807) al prezzo di riferimento 91,96 del 03/11/2026: BI lordo 3,42, netto 3,00
    r = y.compute(91.96, "ref", date(2026, 11, 3), date(2029, 5, 1), 0.0, 0, 0.125, "zero", None, y.CostParams())
    approx(r.ytm_gross * 100, 3.42, 0.015)
    approx(r.ytm_net_bi_convention * 100, 3.00, 0.015)
    assert r.ytm_net_bi_convention == r.ytm_net_tax


def test_calendar():
    assert y.easter(2027) == date(2027, 3, 28)
    assert y.settlement_date(date(2026, 11, 3)) == date(2026, 11, 5)
    assert y.settlement_date(date(2026, 12, 23)) == date(2026, 12, 28)   # salta 25 e 26 dicembre e il weekend
    assert y.it_number if False else True


def test_numbers():
    assert bi.it_number("2.607.000") == 2607000 and bi.it_number("85,45995") == 85.45995
    assert bi.it_number("+0,39%") == 0.39 and bi.it_number("") is None and bi.it_number("1.000") == 1000
    assert bi.it_date("01/03/40") == date(2040, 3, 1) and bi.it_date("03/11/2026") == date(2026, 11, 3)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn(); print("OK", name)
    print("Tutti i test offline superati.")
