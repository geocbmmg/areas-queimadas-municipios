# -*- coding: utf-8 -*-
"""
Onde o projeto está — leia o Portal e diga o que já foi feito e o que
falta. É o primeiro comando a rodar numa máquina nova, ou depois de
semanas sem mexer.

    python infra/30_estado.py
"""
import collections
import io
import json
import os
import sys
import time
import urllib3

urllib3.disable_warnings()
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8",
                              errors="replace")

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)
CRED = r"C:\Users\m1590850\OneDrive\Área de Trabalho\Projetos do Claude\focos-calor-mg\credenciais_portal.txt"
ITEM = "3809b06eb45348ffb2ae10f1e3a14312"
ANO0, ANO1 = 2017, 2025


def n(v):
    return f"{v:,.0f}".replace(",", ".")


def main():
    plano = json.load(io.open(os.path.join(RAIZ, "app", "dados",
                                           "quadrantes.json"),
                              encoding="utf-8"))
    total_celulas = sum(q["res"]["10"]["celulas"] for q in plano["quadrantes"])

    cfg = {}
    for line in open(CRED, encoding="utf-8-sig"):
        if "=" in line:
            k, v = line.strip().split("=", 1)
            cfg[k.strip().lower()] = v.strip()
    from arcgis.gis import GIS
    gis = GIS(cfg["portal"], cfg["usuario"], cfg["senha"], verify_cert=False)
    item = gis.content.get(ITEM)
    poli = item.layers[0]
    tabs = {t.properties.name: t for t in item.tables}

    print("=" * 66)
    print("  MONITOR DE AREAS QUEIMADAS — 8 MUNICIPIOS")
    print("  servico:", ITEM, "· portal:", gis.users.me.username)
    print("=" * 66)

    print("\nPARAMETROS (nao mexer sem motivo)")
    for nome in ("Parametros de biomassa", "Fatores de emissao",
                 "LULC por celula"):
        print("  %-24s %6d linhas" % (nome,
              tabs[nome].query(where="1=1", return_count_only=True)))

    print("\nHISTORICO PROCESSADO")
    fs = tabs["Controle de passagens"].query(
        where="1=1", out_fields="quad_id,celula,competencia,status_proc",
        return_geometry=False).features
    cels = set((f.attributes["quad_id"], f.attributes["celula"]) for f in fs)
    por_ano = collections.Counter(
        (f.attributes["competencia"] or "????")[:4] for f in fs)
    erros = sum(1 for f in fs if f.attributes["status_proc"] == "erro")
    print("  celulas tocadas: %d de %d (%.0f%%)"
          % (len(cels), total_celulas, 100 * len(cels) / total_celulas))
    print("  passagens no controle: %s · erros: %d" % (n(len(fs)), erros))
    print("  por ano:")
    for ano in range(ANO0, ANO1 + 1):
        c = por_ano.get(str(ano), 0)
        marca = "" if c else "   <- nao comecou"
        print("     %d: %6s passagens%s" % (ano, n(c), marca))

    print("\nAREAS QUEIMADAS GRAVADAS")
    st = poli.query(where="1=1", out_statistics=[
        {"statisticType": "count", "onStatisticField": "objectid",
         "outStatisticFieldName": "n"},
        {"statisticType": "sum", "onStatisticField": "area_ha",
         "outStatisticFieldName": "a"},
        {"statisticType": "sum", "onStatisticField": "biomassa_t",
         "outStatisticFieldName": "b"}]).features[0].attributes
    print("  poligonos: %s · area: %s ha · biomassa: %s t"
          % (n(st["n"]), n(st["a"] or 0), n(st["b"] or 0)))
    print("  detalhamento por classe: %s linhas"
          % n(tabs["Queimada por classe"].query(where="1=1",
                                                return_count_only=True)))

    r = poli.query(where="1=1", out_fields="mun_nome",
                   group_by_fields_for_statistics="mun_nome",
                   out_statistics=[
                       {"statisticType": "count",
                        "onStatisticField": "objectid",
                        "outStatisticFieldName": "n"},
                       {"statisticType": "sum",
                        "onStatisticField": "area_ha",
                        "outStatisticFieldName": "a"}]).features
    if r:
        print("  por municipio:")
        for f in sorted(r, key=lambda x: -(x.attributes["a"] or 0)):
            a = f.attributes
            print("     %-28s %8s ha (%s poligonos)"
                  % (a["mun_nome"] or "(sem municipio)",
                     n(a["a"] or 0), n(a["n"])))

    # INTEGRIDADE: o controle registra a área de cada passagem; os
    # polígonos são gravados ANTES dele. Processo morto no meio (Ctrl+C,
    # queda) deixa polígonos sem controle — e o painel, que soma os
    # polígonos, mostra área fantasma. Comparar as duas somas custa duas
    # consultas e denuncia o problema na hora.
    area_ctrl = tabs["Controle de passagens"].query(
        where="1=1", out_statistics=[
            {"statisticType": "sum", "onStatisticField": "area_ha",
             "outStatisticFieldName": "a"}]).features[0].attributes["a"] or 0
    dif = (st["a"] or 0) - area_ctrl
    print("\nINTEGRIDADE")
    print("  area no controle: %s ha · nos poligonos: %s ha"
          % (n(area_ctrl), n(st["a"] or 0)))
    if abs(dif) > max(1.0, 0.01 * area_ctrl):
        print("  ATENCAO: diferenca de %s ha — ha poligonos ORFAOS" % n(dif))
        print("           veja com:  python infra/31_orfaos.py")
    else:
        print("  ok — polígonos e controle batem")

    print("\nCONSOLIDADO MENSAL")
    cons = tabs["Consolidado mensal"].query(
        where="1=1", out_fields="competencia", return_geometry=False).features
    meses = sorted(set(f.attributes["competencia"] for f in cons))
    print("  meses fechados: %d %s"
          % (len(meses), ("(" + meses[0] + " a " + meses[-1] + ")")
             if meses else "— nenhum ainda"))

    print("\nPROXIMO PASSO")
    if len(cels) < total_celulas:
        print("  rodar o historico:  python plano/backfill_gee.py --paralelo 3")
        print("  (e retomavel: o controle no Portal e o checkpoint)")
    elif not meses:
        print("  consolidar os meses no painel (botao 'Consolidar mes')")
    else:
        print("  historico completo e meses fechados — validar no painel")
    if erros:
        print("  ATENCAO: %d passagem(ns) com erro; rodar o backfill de novo"
              " reprocessa" % erros)


main()
