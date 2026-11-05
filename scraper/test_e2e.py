"""
test_e2e.py — v0.1.0
Test di fine-a-fine: un server HTTP locale serve pagine campione (lista, scheda, dati completi, cambi BCE)
e run_daily.main() viene eseguita per davvero contro di esso. Verifica che la pipeline produca
bonds.json / meta.json / history / series / alerts senza errori.
Esegui:  python scraper/test_e2e.py
"""
import json, sys, threading, tempfile
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from datetime import date

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import borsa_italiana as bi  # noqa: E402
import run_daily as rd       # noqa: E402

FX = HERE / "fixtures"
ECB_XML = """<?xml version="1.0" encoding="UTF-8"?><gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
<Cube><Cube time='2026-11-04'><Cube currency='USD' rate='1.1523'/><Cube currency='GBP' rate='0.8712'/></Cube></Cube></gesmes:Envelope>"""


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        p = self.path
        if "eurofxref" in p: body = ECB_XML
        elif "/lista.html" in p and ("page=1" in p or "page=" not in p) and "/btp/" in p: body = (FX / "lista_euro_p3.html").read_text(encoding="utf-8")
        elif "/lista.html" in p: body = "<html><body><table></table></body></html>"   # altre pagine/segmenti vuoti
        elif "/scheda/" in p: body = (FX / "scheda_IT0005377152.html").read_text(encoding="utf-8")
        elif "dati-completi" in p: body = (FX / "dati_AT0000A10683.html").read_text(encoding="utf-8")
        else: self.send_response(404); self.end_headers(); return
        self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.end_headers(); self.wfile.write(body.encode("utf-8"))
    def log_message(self, *a): pass


def main():
    srv = HTTPServer(("127.0.0.1", 0), H); port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    bi.BASE = base; rd.ECB_FX_URL = base + "/eurofxref-daily.xml"
    bi.Client.__init__.__defaults__ = (0.0, 30, 3)        # nessuna pausa
    out = Path(tempfile.mkdtemp())
    rd.ROOT = out  # alerts.json cercato qui
    (out / "alerts.json").write_text(json.dumps([{"metric": "price", "op": "<=", "value": 200, "isin": "IT0005377152"}]), encoding="utf-8")
    rc = rd.main(["--out", str(out), "--delay", "0", "--workers", "2", "--force"])
    assert rc == 0
    d = json.loads((out / "bonds.json").read_text(encoding="utf-8"))
    m = d["meta"]
    assert m["n_total"] == 2 and m["n_failed"] == 0, m
    assert m["fx"]["rates"]["USD"] == 1.1523 and m["fx"]["date"] == "2026-11-04"
    assert "price_quality" in m and m["requests"] >= 1 + 1 + 2 * 2
    b = {x["isin"]: x for x in d["bonds"]}
    assert "IT0005377152" in b or "BE0000291972" in b
    rec = d["bonds"][0]
    assert rec["computable"] and rec["calc"]["ytm_gross"] is not None and rec["price"]["quality"] == "ask"
    assert "first_coupon_date" in rec
    assert rec["liquidity"]["days"] == 1 and rec["liquidity"]["ask_days"] == 1 and rec["liquidity"]["score"] == 1.0
    assert (out / "meta.json").exists() and list((out / "history").glob("*.json")) and list((out / "series").glob("*.json"))
    fired = json.loads((out / "alerts_fired.json").read_text(encoding="utf-8"))
    assert fired["fired"] and (out / "alerts_report.md").read_text(encoding="utf-8").startswith("Avvisi")
    print(f"OK e2e: {m['n_total']} titoli, {m['requests']} richieste, fx {m['fx']['date']}, serie {len(list((out / 'series').glob('*.json')))} file, avvisi {len(fired['fired'])}")


if __name__ == "__main__":
    main()
