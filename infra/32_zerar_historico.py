# -*- coding: utf-8 -*-
"""
APAGA todo o histórico processado — polígonos, detalhamento por classe e
controle de passagens. NÃO toca em parâmetros (B/C, fatores de emissão)
nem nos tiles de uso do solo, que custam caro para refazer.

Use quando o que está gravado deixou de ser válido e reprocessar é mais
barato que consertar linha a linha. Já foi necessário duas vezes:

  1. quando os IDs de quadrante viraram absolutos (a entrada de Paracatu
     renomeava A1 para C1 e o controle é indexado pelo quad_id);
  2. quando os PNGs de uso do solo ficaram com os nomes antigos e o
     backfill gravou 824 polígonos sem uma única linha de classe.

Uso:
  py.cmd infra\\32_zerar_historico.py            # só mostra o que apagaria
  py.cmd infra\\32_zerar_historico.py --apagar   # apaga de verdade
"""
import io
import os
import site
import sys

sys.path.append(site.getusersitepackages())
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8",
                              errors="replace")

CRED = (r"C:\Users\m1590850\OneDrive\Área de Trabalho\Projetos do Claude"
        r"\focos-calor-mg\credenciais_portal.txt")
ITEM = "3809b06eb45348ffb2ae10f1e3a14312"

APAGAR = "--apagar" in sys.argv


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
    return {
        "Áreas queimadas": item.layers[0],
        "Queimada por classe": tabs["Queimada por classe"],
        "Controle de passagens": tabs["Controle de passagens"],
    }


def main():
    alvos = conectar()
    print("=" * 66)
    print("  ZERAR HISTORICO — item %s" % ITEM)
    print("=" * 66)

    contagens = {}
    for nome, cam in alvos.items():
        n = cam.query(where="1=1", return_count_only=True)
        contagens[nome] = n
        print("  %-24s %8d linhas" % (nome, n))

    if not any(contagens.values()):
        print("\nJá está vazio — nada a fazer.")
        return

    if not APAGAR:
        print("\nEnsaio: nada foi apagado.")
        print("Para apagar de verdade, repita com --apagar")
        print("\nPreservados (não são tocados por este script):")
        print("  Parametros de biomassa · Fatores de emissao · LULC por celula")
        return

    print("\napagando…")
    for nome, cam in alvos.items():
        if not contagens[nome]:
            continue
        r = cam.delete_features(where="1=1")
        falhas = [x for x in r.get("deleteResults", []) if not x.get("success")]
        print("  %-24s apagadas %d · falhas %d"
              % (nome, len(r.get("deleteResults", [])), len(falhas)))
        if falhas:
            print("    primeira falha:", falhas[0].get("error"))

    print("\nconferindo…")
    for nome, cam in alvos.items():
        print("  %-24s %8d linhas" % (nome, cam.query(where="1=1",
                                                      return_count_only=True)))
    print("\nPróximo passo: py.cmd plano\\backfill_gee.py --paralelo 3")


main()
