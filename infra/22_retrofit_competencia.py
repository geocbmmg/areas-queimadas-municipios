# -*- coding: utf-8 -*-
"""
Preenche o campo `competencia` (AAAA-MM) nas linhas que já existiam antes
da reformulação — camada 0 (polígonos) e tabela 1 (controle).

A competência é DERIVADA de data_pass (o mês da detecção, regra do plano);
este script só faz o retrofit do que o motor antigo gravou sem o campo.
Idempotente: filtra `competencia IS NULL`, então rodar de novo não toca no
que já foi preenchido. data_pass é gravado ao meio-dia UTC — o mês sai do
próprio instante UTC, sem risco de fuso.
"""
import sys, io, urllib3
from datetime import datetime, timezone

urllib3.disable_warnings()
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

CRED = r"C:\Users\m1590850\OneDrive\Área de Trabalho\Projetos do Claude\focos-calor-mg\credenciais_portal.txt"
ITEM_ID = "29744c8a0d05462b9a34ad0741ea7612"


def competencia_de(epoch_ms):
    d = datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc)
    return d.strftime("%Y-%m")


FILTRO = "competencia IS NULL AND data_pass IS NOT NULL"


def retrofit(alvo, rotulo):
    total = alvo.query(where=FILTRO, return_count_only=True)
    print(rotulo, "— linhas sem competência:", total)
    feitos = 0
    while True:
        fs = alvo.query(
            where=FILTRO,
            out_fields="objectid,data_pass", return_geometry=False,
            order_by_fields="objectid", result_record_count=500).features
        if not fs:
            break
        updates = [{"attributes": {
            "objectid": f.attributes["objectid"],
            "competencia": competencia_de(f.attributes["data_pass"])}}
            for f in fs]
        r = alvo.edit_features(updates=updates)
        ok = sum(1 for x in r["updateResults"] if x.get("success"))
        feitos += ok
        print("  lote: %d atualizadas (%d no total)" % (ok, feitos))
        if ok == 0:
            print("  [AVISO] lote sem sucesso — parando para não repetir")
            break
    resto = alvo.query(where=FILTRO, return_count_only=True)
    print(rotulo, "— concluído: %d preenchidas, %d restantes" % (feitos, resto))


def main():
    cfg = {}
    for line in open(CRED, encoding="utf-8-sig"):
        if "=" in line:
            k, v = line.strip().split("=", 1)
            cfg[k.strip().lower()] = v.strip()

    from arcgis.gis import GIS
    gis = GIS(cfg["portal"], cfg["usuario"], cfg["senha"], verify_cert=False)
    print("conectado:", gis.users.me.username)

    item = gis.content.get(ITEM_ID)
    if not item:
        raise SystemExit("item %s não encontrado — rode 20_criar_camadas_mg.py" % ITEM_ID)

    por_nome = {}
    for l in item.layers:
        por_nome[l.properties.name] = l
    for t in item.tables:
        por_nome[t.properties.name] = t

    retrofit(por_nome["Queimadas por passagem"], "polígonos")
    retrofit(por_nome["Controle de passagens"], "controle")


main()
