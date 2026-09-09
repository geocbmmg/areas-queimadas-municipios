# -*- coding: utf-8 -*-
"""
Completa a tabela "Fatores de emissao" com os gases de efeito estufa
não-CO2 (CH4 e N2O) e com o PM10 que faltava na maioria das classes.

POR QUE: o objetivo do trabalho é monitorar QUALIDADE DO AR **e**
EMISSÕES DE GASES DE EFEITO ESTUFA. A tabela cobria PM2.5, PM10, TPM,
CO e CO2, mas sem CH4 e N2O — que são justamente os gases de efeito
estufa não-CO2 que o IPCC contabiliza na queima de biomassa (o CO2 de
vegetação que rebrota é tratado como neutro). Sem eles, metade do
objetivo não era representável. O PM10 tinha fator para só 2 das 22
classes, e a classe dominante nas detecções (4, Formação Savânica)
ficava de fora — o total de PM10 saía subestimado sem aviso.

VALORES PROVISÓRIOS. São medianas por categoria de queima do Andreae
2019 (ACP 19:8523), a mesma fonte das linhas já existentes, aplicadas à
categoria de cada classe do MapBiomas. Ficam marcados como provisórios
no campo `obs`: substitua pelos fatores oficiais do projeto na tela de
Metodologia do painel — não é preciso reprocessar nada, porque a
emissão é derivada na leitura.

Uso:
  py.cmd infra\\23_semear_ef_gee.py            # mostra o que faria
  py.cmd infra\\23_semear_ef_gee.py --aplicar  # grava
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
APLICAR = "--aplicar" in sys.argv

FONTE = "Andreae 2019 (ACP 19:8523), mediana por categoria de queima"
OBS = ("PROVISORIO — mediana da categoria, nao medida local. "
       "Substituir pelos fatores oficiais do projeto na tela de Metodologia.")

# categoria de queima de cada classe do MapBiomas presente na tabela
CATEGORIA = {
    3:  "floresta",     # Formação Florestal
    4:  "savana",       # Formação Savânica
    9:  "floresta",     # Silvicultura (eucalipto)
    11: "savana",       # Campo Alagado e Área Pantanosa
    12: "savana",       # Formação Campestre
    15: "savana",       # Pastagem
    19: "residuo",      # Lavoura Temporária
    20: "residuo",      # Cana-de-açúcar
    21: "savana",       # Mosaico de Usos
    29: "savana",       # Afloramento Rochoso / campo rupestre
    36: "residuo",      # Lavoura Perene
    39: "residuo",      # Soja
    40: "residuo",      # Arroz
    41: "residuo",      # Outras Lavouras Temporárias
    46: "residuo",      # Café
    48: "residuo",      # Outras Lavouras Perenes
    62: "residuo",      # Algodão
}

# g de poluente por kg de matéria seca queimada
EF = {
    "savana":   {"CH4": 1.94, "N2O": 0.17, "PM10": 7.3},
    "floresta": {"CH4": 5.07, "N2O": 0.20, "PM10": 10.7},
    "residuo":  {"CH4": 5.70, "N2O": 0.09, "PM10": 7.3},
}


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
    return {t.properties.name: t for t in item.tables}["Fatores de emissao"]


def main():
    tab = conectar()
    existentes = set()
    for f in tab.query(where="1=1", out_fields="poluente,classe_id").features:
        a = f.attributes
        existentes.add((a.get("poluente"), a.get("classe_id")))
    print("linhas já na tabela:", len(existentes))

    adds = []
    for cid in sorted(CATEGORIA):
        cat = CATEGORIA[cid]
        for pol, valor in sorted(EF[cat].items()):
            if (pol, cid) in existentes:
                continue
            adds.append({"attributes": {
                "poluente": pol, "classe_id": cid, "ef_g_kg": valor,
                "fonte": "%s — categoria '%s'" % (FONTE, cat), "obs": OBS}})

    if not adds:
        print("nada a acrescentar — a tabela já está completa.")
        return

    print("a acrescentar:", len(adds))
    for a in adds:
        at = a["attributes"]
        print("   %-5s classe %-3d %6.2f g/kg   (%s)"
              % (at["poluente"], at["classe_id"], at["ef_g_kg"],
                 CATEGORIA[at["classe_id"]]))

    if not APLICAR:
        print("\nEnsaio: nada foi gravado. Repita com --aplicar")
        return

    r = tab.edit_features(adds=adds)
    res = r.get("addResults", [])
    falhas = [x for x in res if not x.get("success")]
    print("\ngravadas %d · falhas %d" % (len(res) - len(falhas), len(falhas)))
    if falhas:
        print("primeira falha:", falhas[0].get("error"))
        raise SystemExit(1)
    print("total na tabela agora:",
          tab.query(where="1=1", return_count_only=True))


main()
