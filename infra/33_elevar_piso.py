# -*- coding: utf-8 -*-
"""
Eleva o PISO DE GRAVAÇÃO depois do fato: apaga os polígonos menores que
N pixels e o detalhamento por classe deles.

Serve para quando o piso de 2 px se mostrar fino demais na prática — o
serviço pesado demais, a curadoria inviável, ruído de fogo de vegetação
seca demais. Não é preciso reprocessar nada: o dado já está gravado do
mais fino para o mais grosso, e subir é só descartar o que está abaixo
da linha.

O CAMINHO SÓ VAI NUM SENTIDO. Descer o piso de novo exige reprocessar o
período inteiro no GEE. Por isso o padrão é gravar a 2 px e só subir se
houver motivo medido — este script mostra o que perderia antes de
apagar.

Antes de apagar, vale lembrar que existe o PISO DE RELATÓRIO
(`pisoRelatorioM2` no config.js e o seletor "Área mínima" do painel):
ele filtra a leitura sem apagar nada, e é reversível. Use este script só
quando o problema for o VOLUME gravado, não a apresentação.

Uso:
  py.cmd infra\\33_elevar_piso.py 10            # o que 10 px descartaria
  py.cmd infra\\33_elevar_piso.py 10 --apagar   # apaga de verdade
"""
import io
import site
import sys

sys.path.append(site.getusersitepackages())
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8",
                              errors="replace")

CRED = (r"C:\Users\m1590850\OneDrive\Área de Trabalho\Projetos do Claude"
        r"\focos-calor-mg\credenciais_portal.txt")
ITEM = "3809b06eb45348ffb2ae10f1e3a14312"

APAGAR = "--apagar" in sys.argv
args = [a for a in sys.argv[1:] if not a.startswith("--")]
if not args:
    raise SystemExit("informe o piso em pixels, ex.: 33_elevar_piso.py 10")
PISO_PX = int(args[0])
if PISO_PX < 2:
    raise SystemExit("o piso de gravação já é 2 px — nada a elevar.")


def conectar():
    import urllib3
    urllib3.disable_warnings()
    from arcgis.gis import GIS
    cfg = {}
    for line in open(CRED, encoding="utf-8-sig"):
        if "=" in line:
            k, v = line.strip().split("=", 1)
            cfg[k.strip().lower()] = v.strip()
    gis = GIS(cfg["portal"], cfg["usuario"], cfg["senha"], verify_cert=False)
    item = gis.content.get(ITEM)
    tabs = {t.properties.name: t for t in item.tables}
    return item.layers[0], tabs["Queimada por classe"]


def soma(cam, where):
    f = cam.query(where=where, out_statistics=[{
        "statisticType": "sum", "onStatisticField": "area_ha",
        "outStatisticFieldName": "a"}], return_geometry=False).features
    return (f[0].attributes.get("a") or 0) if f else 0


def main():
    poli, classe = conectar()
    fora = "n_pixels < %d" % PISO_PX
    dentro = "n_pixels >= %d" % PISO_PX

    n_tot = poli.query(where="1=1", return_count_only=True)
    n_fora = poli.query(where=fora, return_count_only=True)
    a_tot, a_fora = soma(poli, "1=1"), soma(poli, fora)

    print("=" * 62)
    print("  ELEVAR O PISO DE GRAVACAO PARA %d PIXELS (%d m2 de grade)"
          % (PISO_PX, PISO_PX * 100))
    print("=" * 62)
    print("  hoje no banco:   %8d poligonos · %10.1f ha" % (n_tot, a_tot))
    print("  seriam apagados: %8d poligonos · %10.1f ha" % (n_fora, a_fora))
    print("  restariam:       %8d poligonos · %10.1f ha"
          % (n_tot - n_fora, a_tot - a_fora))
    if n_tot:
        print("  ou seja: -%.1f%% das linhas, -%.1f%% da area"
              % (100.0 * n_fora / n_tot, 100.0 * a_fora / a_tot if a_tot else 0))

    if not n_fora:
        print("\nNada abaixo desse piso — nada a fazer.")
        return
    if not APAGAR:
        print("\nEnsaio: nada foi apagado. Repita com --apagar")
        print("IRREVERSIVEL: descer o piso de novo exige reprocessar o GEE.")
        return

    print("\napagando o detalhamento por classe…")
    rc = classe.delete_features(where="n_pixels < %d" % PISO_PX)
    print("   classes apagadas:", len(rc.get("deleteResults", [])))
    print("apagando os poligonos…")
    rp = poli.delete_features(where=fora)
    print("   poligonos apagados:", len(rp.get("deleteResults", [])))

    print("\nagora: %d poligonos · %.1f ha"
          % (poli.query(where="1=1", return_count_only=True),
             soma(poli, "1=1")))
    print("\nAjuste tambem `areaMinM2` no app/js/config.js para %d,"
          % (PISO_PX * 100))
    print("senao o proximo backfill volta a gravar abaixo deste piso.")


main()
