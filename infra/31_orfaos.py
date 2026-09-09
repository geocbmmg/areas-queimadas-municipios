# -*- coding: utf-8 -*-
"""
Encontra (e opcionalmente apaga) polígonos ÓRFÃOS: gravados sem a linha
de controle correspondente.

Como aparecem: o motor grava os polígonos e só depois a linha de
controle. Se o processo for MORTO no meio (Ctrl+C, Stop-Process, queda),
os polígonos ficam e o controle não — e o `catch` que desfaria isso não
chega a rodar, porque o processo simplesmente deixou de existir.

Por que importa: o painel soma os polígonos, então a área aparece
inflada. Num caso real foram 9.932 polígonos e 4.755 ha fantasmas em
uma única célula — 76% do total do município.

O backfill conserta sozinho ao reprocessar (a passagem volta como
pendente e a higiene apaga os órfãos antes de recalcular). Este script
serve para VER o estrago agora e, se quiser, limpar sem esperar.

    python infra/31_orfaos.py            # só relata
    python infra/31_orfaos.py --apagar   # relata e apaga
"""
import collections
import io
import os
import site
import sys
import time
import urllib3

for _p in ([site.getusersitepackages()]
           if isinstance(site.getusersitepackages(), str)
           else list(site.getusersitepackages())):
    if os.path.isdir(_p) and _p not in sys.path:
        sys.path.append(_p)

urllib3.disable_warnings()
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8",
                              errors="replace")

CRED = r"C:\Users\m1590850\OneDrive\Área de Trabalho\Projetos do Claude\focos-calor-mg\credenciais_portal.txt"
ITEM = "3809b06eb45348ffb2ae10f1e3a14312"
APAGAR = "--apagar" in sys.argv


def dia(ms):
    return time.strftime("%Y-%m-%d", time.gmtime(ms / 1000))


def tudo(camada, campos, where="1=1"):
    saida, off = [], 0
    while True:
        r = camada.query(where=where, out_fields=campos,
                         return_geometry=False, order_by_fields="objectid",
                         result_offset=off, result_record_count=2000)
        saida.extend(f.attributes for f in r.features)
        if len(r.features) < 2000:
            return saida
        off += len(r.features)


def main():
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
    ctrl = tabs["Controle de passagens"]

    print("lendo controle e polígonos…")
    c = tudo(ctrl, "quad_id,celula,res_m,data_pass")
    p = tudo(poli, "objectid,quad_id,celula,res_m,data_pass,area_ha")
    print("  controle: %d linhas · polígonos: %d" % (len(c), len(p)))

    def chave(a):
        return "%s|%s|%s|%s" % (a["quad_id"], a["celula"], a["res_m"],
                                dia(a["data_pass"]))

    tem_ctrl = set(chave(a) for a in c)
    orfaos = collections.defaultdict(lambda: {"area": 0.0, "oids": []})
    for a in p:
        k = chave(a)
        if k in tem_ctrl:
            continue
        orfaos[k]["area"] += a["area_ha"] or 0
        orfaos[k]["oids"].append(a["objectid"])

    if not orfaos:
        print("\nNenhum órfão — polígonos e controle batem.")
        return

    n = sum(len(v["oids"]) for v in orfaos.values())
    a = sum(v["area"] for v in orfaos.values())
    print("\nORFAOS: %d polígonos · %.1f ha em %d célula-dia(s)"
          % (n, a, len(orfaos)))
    for k, v in sorted(orfaos.items(), key=lambda x: -x[1]["area"]):
        print("   %-30s %9.1f ha em %6d polígonos"
              % (k, v["area"], len(v["oids"])))

    if not APAGAR:
        print("\nSó relatório. Para apagar:  python infra/31_orfaos.py --apagar")
        print("(ou apenas rode o backfill de novo — ele limpa ao reprocessar)")
        return

    print("\napagando…")
    todos = [o for v in orfaos.values() for o in v["oids"]]
    apagados = 0
    for i in range(0, len(todos), 500):
        lote = todos[i:i + 500]
        r = poli.edit_features(deletes=lote)
        ok = sum(1 for x in r["deleteResults"] if x.get("success"))
        apagados += ok
        print("  lote: %d apagados (%d/%d)" % (ok, apagados, len(todos)))

    # o detalhamento por classe é filho do polígono: sem o pai, sobra lixo
    qxc = tabs["Queimada por classe"]
    for k in orfaos:
        quad, cel, res, d = k.split("|")
        seg = time.strftime("%Y-%m-%d", time.gmtime(
            time.mktime(time.strptime(d, "%Y-%m-%d")) + 86400))
        qxc.delete_features(
            where="quad_id = '%s' AND celula = %s AND res_m = %s AND "
                  "data_pass >= TIMESTAMP '%s 00:00:00' AND "
                  "data_pass < TIMESTAMP '%s 00:00:00'"
                  % (quad, cel, res, d, seg))
    print("\npronto: %d polígonos e o detalhamento por classe removidos"
          % apagados)
    print("as passagens voltam à fila e serão recalculadas no próximo backfill")


main()
