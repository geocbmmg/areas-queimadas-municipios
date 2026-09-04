# -*- coding: utf-8 -*-
"""
Gera os TILES DE USO DO SOLO por célula (10 m) e sobe como anexos na
tabela "LULC por celula" do serviço — a fonte do B×C da fórmula
E = A × B × C × EF.

Para cada célula-filha de 10 m (25 km, 2.500 px, mesma grade do dNBR):

  1. lê a JANELA do MapBiomas Coleção 9 (30 m, GeoTIFF COG público no
     Google Cloud Storage — leitura por range request, nada de baixar o
     Brasil) e reamostra por vizinho-mais-próximo na grade da célula;
  2. lê a janela da classificação Esri/Impact Observatory Sentinel-2
     10 m (COG público no Azure, zona UTM 23K) na mesma grade;
  3. resolve as classes genéricas do MapBiomas — Mosaico de Usos (21),
     Outras Áreas não Vegetadas (25), Outras Lavouras Temporárias (41) —
     pela classe Esri do pixel:
        crops→19 (Lavoura Temporária)   rangeland→15 (Pastagem)
        trees→3 (Formação Florestal)    built→24 (Área Urbanizada)
        water→33                        flooded veg→11
        bare→25 (fica não vegetado)     clouds/nodata→mantém a original
  4. grava um PNG em TONS DE CINZA (valor do pixel = código MapBiomas)
     em plano/tiles/<ano>/ e ANEXA à linha da tabela (chave: bbox_3857
     formatado como o motor grava no controle + ano).

Fontes (documentadas em DOCUMENTACAO.md §3.3):
  MapBiomas: https://storage.googleapis.com/mapbiomas-public/initiatives/brasil/collection_9/lclu/coverage/brasil_coverage_<ANO>.tif
  Esri/IO:   https://lulctimeseries.blob.core.windows.net/lulctimeseriesv003/lc<ANO>/23K_<ANO>0101-<ANO+1>0101.tif
  (Esri disponível 2017–2023; para anos além, usa-se o último disponível)

Uso:
  python gerar_lulc_tiles.py            # ano padrão 2023, só gera+envia o que falta
  python gerar_lulc_tiles.py 2019       # outro ano (backfill)
  FORCAR=1 python gerar_lulc_tiles.py   # regera e reanexa tudo
"""
import io
import json
import math
import os
import sys
import time

import numpy as np
from osgeo import gdal
from PIL import Image

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
gdal.UseExceptions()
gdal.SetConfigOption("GDAL_HTTP_TIMEOUT", "120")
gdal.SetConfigOption("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
gdal.SetConfigOption("GDAL_HTTP_MAX_RETRY", "4")
gdal.SetConfigOption("GDAL_HTTP_RETRY_DELAY", "2")

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)
PLANO = json.load(io.open(os.path.join(RAIZ, "app", "dados", "quadrantes.json"),
                          encoding="utf-8"))
CRED = r"C:\Users\m1590850\OneDrive\Área de Trabalho\Projetos do Claude\focos-calor-mg\credenciais_portal.txt"
ITEM = "3809b06eb45348ffb2ae10f1e3a14312"

ANO = int(sys.argv[1]) if len(sys.argv) > 1 else 2023
ANO_ESRI = min(ANO, 2023)   # Esri v003 vai até 2023
FORCAR = os.environ.get("FORCAR") == "1"

URL_MB = ("/vsicurl/https://storage.googleapis.com/mapbiomas-public/"
          "initiatives/brasil/collection_9/lclu/coverage/"
          "brasil_coverage_%d.tif" % ANO)
URL_ESRI = ("/vsicurl/https://lulctimeseries.blob.core.windows.net/"
            "lulctimeseriesv003/lc%d/23K_%d0101-%d0101.tif"
            % (ANO_ESRI, ANO_ESRI, ANO_ESRI + 1))

FONTE = ("MapBiomas Col.9 %d (30 m) + desempate Esri/IO Sentinel-2 10 m %d "
         "nas classes 21/25/41" % (ANO, ANO_ESRI))

GENERICAS = (21, 25, 41)
ESRI_PARA_MB = {1: 33, 2: 3, 4: 11, 5: 19, 7: 24, 8: 25, 11: 15}

PX = 2500
RES = 10.0


def celulas_filhas():
    """As células de 10 m — a MESMA partição 2×2 do motor (celulasDe)."""
    filhas = []
    for q in PLANO["quadrantes"]:
        for c in q["celulas"]:
            b = c["bbox3857"]
            mx, my = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
            quartos = [[b[0], b[1], mx, my], [mx, b[1], b[2], my],
                       [b[0], my, mx, b[3]], [mx, my, b[2], b[3]]]
            for i, bb in enumerate(quartos):
                filhas.append({
                    "quad": q["id"],
                    "n": (c["n"] - 1) * 4 + i + 1,
                    "bbox": bb,
                })
    return filhas


def chave_bbox(b):
    """O formato EXATO que o motor grava no controle (toFixed(1))."""
    return ",".join("%.1f" % v for v in b)


def janela(url, bbox):
    """Reamostra a janela do COG na grade 3857 da célula (NN)."""
    ds = gdal.Warp("", url, format="MEM",
                   dstSRS="EPSG:3857",
                   outputBounds=bbox, width=PX, height=PX,
                   resampleAlg="near", outputType=gdal.GDT_Byte)
    arr = ds.GetRasterBand(1).ReadAsArray()
    ds = None
    return arr


def gerar(cel, pasta):
    arrM = janela(URL_MB, cel["bbox"])
    arrE = janela(URL_ESRI, cel["bbox"])

    resolvidos = 0
    mask = np.isin(arrM, GENERICAS)
    if mask.any():
        destino = np.zeros_like(arrM)
        for e, mb in ESRI_PARA_MB.items():
            destino[arrE == e] = mb
        aplicavel = mask & (destino > 0)
        arrM[aplicavel] = destino[aplicavel]
        resolvidos = int(aplicavel.sum())

    nome = "lulc_%d_%s_c%d.png" % (ANO, cel["quad"], cel["n"])
    caminho = os.path.join(pasta, nome)
    Image.fromarray(arrM, mode="L").save(caminho, optimize=True)
    return caminho, nome, resolvidos, arrM


def main():
    pasta = os.path.join(AQUI, "tiles", str(ANO))
    os.makedirs(pasta, exist_ok=True)

    cfg = {}
    for line in open(CRED, encoding="utf-8-sig"):
        if "=" in line:
            k, v = line.strip().split("=", 1)
            cfg[k.strip().lower()] = v.strip()
    import urllib3
    urllib3.disable_warnings()
    from arcgis.gis import GIS
    gis = GIS(cfg["portal"], cfg["usuario"], cfg["senha"], verify_cert=False)
    item = gis.content.get(ITEM)
    tab = [t for t in item.tables if t.properties.name == "LULC por celula"][0]
    print("conectado:", gis.users.me.username, "· tabela:", tab.url)
    print("ano do mapa:", ANO, "· desempate Esri:", ANO_ESRI)

    filhas = celulas_filhas()
    print("células de 10 m:", len(filhas))

    agora = int(time.time() * 1000)
    feitos = pulados = 0
    tot_resolvidos = 0

    for i, cel in enumerate(filhas):
        chave = chave_bbox(cel["bbox"])
        existentes = tab.query(
            where="bbox_3857 = '%s' AND ano = %d AND res_m = 10" % (chave, ANO),
            out_fields="objectid", return_geometry=False).features
        if existentes and not FORCAR:
            pulados += 1
            continue

        # leituras de range no Azure/GCS falham de vez em quando; o warp
        # aborta com "IReadBlock failed" — vale repetir antes de desistir
        for tentativa in range(4):
            try:
                caminho, nome, resolvidos, arr = gerar(cel, pasta)
                break
            except Exception as e:
                if tentativa == 3:
                    raise
                print("   [retry %d] %s c%d: %s"
                      % (tentativa + 1, cel["quad"], cel["n"], str(e)[:120]))
                time.sleep(5 * (tentativa + 1))
        tot_resolvidos += resolvidos

        if existentes:   # FORCAR: apaga a linha (e os anexos vão junto)
            tab.edit_features(deletes=[f.attributes["objectid"]
                                       for f in existentes])
        r = tab.edit_features(adds=[{"attributes": {
            "bbox_3857": chave, "res_m": 10, "ano": ANO,
            "fonte": FONTE, "pixels_desempate": resolvidos,
            "gerado_em": agora}}])
        ar = r["addResults"][0]
        if not ar.get("success"):
            raise SystemExit("linha não gravada para %s c%d: %s"
                             % (cel["quad"], cel["n"], ar))
        tab.attachments.add(ar["objectId"], caminho)

        vals, cts = np.unique(arr, return_counts=True)
        top = sorted(zip(vals.tolist(), cts.tolist()),
                     key=lambda x: -x[1])[:4]
        print("[%2d/%d] %s c%-2d  desempate:%6d px  topo: %s"
              % (i + 1, len(filhas), cel["quad"], cel["n"], resolvidos,
                 ", ".join("%d(%d%%)" % (v, round(100 * c / arr.size))
                           for v, c in top)))
        feitos += 1

    print()
    print("gerados/enviados: %d · já existiam: %d · pixels resolvidos "
          "pelo desempate: %s" % (feitos, pulados,
                                  f"{tot_resolvidos:,}".replace(",", ".")))


main()
