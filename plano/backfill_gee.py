# -*- coding: utf-8 -*-
"""
BACKFILL 2017–2025 pela rota Google Earth Engine — a série retroativa do
Monitor dos 9 Municípios, gravada no MESMO serviço do Portal que o motor
vivo usa, com as MESMAS regras (plano REFORMULACAO.md §6):

  · mesmas células de 10 m (partição 2×2 das células-mãe, quadrantes.json);
  · cadeia da base POR CÉLULA: primeira passagem viável = base (0 ha);
    cada viável seguinte é medida contra a última aceita ANTERIOR a ela
    (nunca uma linha do futuro — o serviço é compartilhado com o vivo);
  · viabilidade no RECORTE: fração de nuvem (sonda a 40 m) — corte em 30%;
  · máscara do índice: SCL 0/3/8/9/10/11 apagados dos DOIS lados do dNBR;
  · dNBR = NBR(base) − NBR(atual), NBR=(B8−B12)/(B8+B12); queimado ≥ 0,10;
    componentes 4-conexos; área mínima 2.000 m²; teto 5.000 componentes;
  · REGENERAÇÃO: difference vetorial contra tudo que já queimou na célula
    dentro de regeneracaoDias (o controle/polígonos do Portal são a
    memória — e o checkpoint: rodar de novo continua de onde parou);
  · competência = mês da detecção; vão > 30 dias sai marcado;
  · biomassa por classe via TILES LOCAIS (plano/tiles/<ano>/ — MapBiomas
    do ano do fogo + desempate Esri, a mesma grade do dNBR) × tabela de
    parâmetros B×C do Portal, com teste por CENTRO de pixel;
  · metodo = "dNBR (B08/B12) 10 m · base <dia> · regen <N>d · retroativo GEE".

FONTES DE IMAGEM (a diferença que o catálogo impõe):
  · COPERNICUS/S2_SR_HARMONIZED (L2A, com SCL) — só cobre o Brasil a
    partir de ~dez/2018 no GEE;
  · antes disso, COPERNICUS/S2_HARMONIZED (L1C, topo da atmosfera) com
    máscara GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED (cs < 0,60 = ruim).
    Passagem com lado em L1C sai MARCADA no motivo ("NBR em TOA") — o
    dNBR de diferença tolera TOA, mas fica registrado.

Parâmetros de cálculo lidos do app/js/config.js — nunca divergem do vivo.
Custo Copernicus: ZERO.

Uso:
  python backfill_gee.py                       # tudo (52 células, 2017-03-28..2025-12-31)
  python backfill_gee.py --quads A2 --celulas 17,18
  python backfill_gee.py --ate 2017-12-31      # piloto
  python backfill_gee.py --paralelo 4          # células em paralelo

Autenticação GEE (uma vez):  python -c "import ee; ee.Authenticate()"
Projeto GEE: incendioflorestalmg (login leandrogomesbh).
"""
import argparse
import bisect
import calendar
import io
import json
import math
import os
import re
import site
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed

# O Python do ArcGIS Pro NEM SEMPRE inclui o site-packages do usuário no
# sys.path: depende de como o terminal foi aberto. Resultado prático —
# `shapely`, `ee` e companhia carregam numa sessão e somem noutra, com
# ModuleNotFoundError um de cada vez. Acrescentar o caminho à mão resolve
# de uma vez, e não atrapalha quando ele já estava lá.
for _p in {site.getusersitepackages()} if isinstance(
        site.getusersitepackages(), str) else set(site.getusersitepackages()):
    if os.path.isdir(_p) and _p not in sys.path:
        sys.path.append(_p)

import numpy as np
from PIL import Image
from matplotlib.path import Path as MplPath

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8",
                              errors="replace", line_buffering=True)

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)
CRED = r"C:\Users\m1590850\OneDrive\Área de Trabalho\Projetos do Claude\focos-calor-mg\credenciais_portal.txt"
ITEM = "3809b06eb45348ffb2ae10f1e3a14312"
GEE_PROJECT = "incendioflorestalmg"
USUARIO = "backfill-gee"
RES = 10
PX = 2500
DIA_MS = 86400000
LIMIAR_CS = 0.60             # CloudScore+: cs < 0,60 = pixel ruim (sem SCL)
SR_DESDE = "2018-12-01"      # heurística p/ dias fora do catálogo listado
ANO_TILE_MAX = 2023          # último ano com tile (MapBiomas Col.9 + Esri)
MAX_POLIGONOS = 20000    # teto de segurança do vetorizador. Com o piso de
                         # 400 m² a passagem mais pesada do piloto pediu
                         # ~5.000 componentes; 5.000 truncava e fazia o TETO
                         # governar no lugar do piso (o corte por área
                         # deixava de valer justamente nos meses de fogo).
SCL_NUVEM = (8, 9, 10)
SCL_RUIM = (0, 3, 8, 9, 10, 11)


# ---------------------------------------------------------------- parâmetros
def parametros_do_config():
    """Lê os parâmetros de cálculo do config.js do app — paridade com o vivo."""
    txt = io.open(os.path.join(RAIZ, "app", "js", "config.js"),
                  encoding="utf-8").read()
    def par(nome):
        m = re.search(nome + r"\s*:\s*([0-9.]+)", txt)
        if not m:
            raise SystemExit("config.js sem " + nome)
        v = m.group(1)
        return float(v) if "." in v else int(v)
    return {
        "limiar": par("limiar"),
        "areaMinM2": par("areaMinM2"),        # piso de GRAVAÇÃO
        "pisoRelatorioM2": par("pisoRelatorioM2"),
        "nuvemRecorteMax": par("nuvemRecorteMax"),
        "divisorSonda": par("divisorSonda"),
        "vaoMaximoDias": par("vaoMaximoDias"),
        "regeneracaoDias": par("regeneracaoDias"),
    }

CFG = parametros_do_config()
MIN_PX = max(1, int(np.ceil(CFG["areaMinM2"] / (RES * RES))))


# ---------------------------------------------------------------- geometria
R_MERC = 6378137.0

def lonlat_para_merc(lon, lat):
    return (R_MERC * math.radians(lon),
            R_MERC * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))


def bbox4326_de(b):
    def lon(x): return math.degrees(x / R_MERC)
    def lat(y): return math.degrees(2 * math.atan(math.exp(y / R_MERC)) -
                                    math.pi / 2)
    return [lon(b[0]), lat(b[1]), lon(b[2]), lat(b[3])]


def bbox_txt(b, casas=1):
    return ",".join(("%." + str(casas) + "f") % v for v in b)


def area_min_geod(cel):
    """O piso em m² NO CHÃO, equivalente a MIN_PX pixels da grade.

    A malha é Mercator: o pixel "de 10 m" mede 10·cos(lat) no terreno —
    ~9,45 m nesta latitude, ou seja 89% da área. Comparar a área
    GEODÉSICA de um componente contra um piso escrito em metros de
    Mercator derrubaria justamente os componentes de MIN_PX pixels (2 px
    = 200 m² de grade, mas só 179 m² de chão). O critério de detecção é
    em PIXELS; este valor é só a tradução dele para o terreno.
    """
    lat = math.radians(bbox4326_de(cel["bbox"])[1] / 2 +
                       bbox4326_de(cel["bbox"])[3] / 2)
    return MIN_PX * (RES * math.cos(lat)) ** 2


"""Área geodésica sem biblioteca externa.

Depender de `geographiclib` (ou de `pyproj`, que nem existe no Python do
ArcGIS Pro) quebrava o script em máquina onde o pacote não estivesse
instalado — justamente o que este projeto não pode ter, já que precisa
rodar em qualquer PC. As séries abaixo são as do WGS84 e dão o
comprimento de um grau em metros na latitude dada; com elas o polígono
vira metros locais e a área sai por shoelace.

O erro relativo é da ordem de (L/R)², ou seja ~1e-8 para um polígono de
1 km — e os daqui têm de 200 m² a poucos hectares. Conferido contra o
geographiclib: diferença abaixo de 0,01%.
"""


def _m_por_grau(lat_rad):
    c2, c4, c6 = (math.cos(2 * lat_rad), math.cos(4 * lat_rad),
                  math.cos(6 * lat_rad))
    m_lat = 111132.92 - 559.82 * c2 + 1.175 * c4 - 0.0023 * c6
    m_lon = (111412.84 * math.cos(lat_rad)
             - 93.5 * math.cos(3 * lat_rad)
             + 0.118 * math.cos(5 * lat_rad))
    return m_lat, m_lon


def _area_anel_geod(coords):
    pts = list(coords)
    if len(pts) < 4:
        return 0.0
    lat0 = sum(p[1] for p in pts) / len(pts)
    m_lat, m_lon = _m_por_grau(math.radians(lat0))
    s = 0.0
    for i in range(len(pts) - 1):
        x1 = pts[i][0] * m_lon
        y1 = pts[i][1] * m_lat
        x2 = pts[i + 1][0] * m_lon
        y2 = pts[i + 1][1] * m_lat
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def area_ha_geodesica(geom):
    """Área geodésica (WGS84) em ha — paridade com o geodesicArea do
    geometryEngine do vivo. Buracos descontados."""
    polys = list(geom.geoms) if hasattr(geom, "geoms") else [geom]
    total = 0.0
    for p in polys:
        if p.is_empty:
            continue
        total += _area_anel_geod(p.exterior.coords)
        for interior in p.interiors:
            total -= _area_anel_geod(interior.coords)
    return max(0.0, total) / 10000.0


try:
    from shapely.geometry import (shape, mapping, Polygon as ShPolygon,
                                  MultiPolygon)
    from shapely.ops import unary_union
    from shapely.geometry.polygon import orient
except ImportError:
    raise SystemExit(
        'Falta a biblioteca shapely. Instale com:\n  "%s" '
        "-m pip install --user shapely" % sys.executable)


def para_rings_esri(geom4326):
    """shapely (4326) -> rings Esri (exterior horário, buracos anti-h.)."""
    polys = list(geom4326.geoms) if isinstance(geom4326, MultiPolygon) \
        else [geom4326]
    rings = []
    for p in polys:
        if p.is_empty:
            continue
        p = orient(p, sign=-1.0)
        rings.append([list(c) for c in p.exterior.coords])
        for interior in p.interiors:
            rings.append([list(c) for c in interior.coords])
    return rings


def _area_anel(anel):
    s = 0.0
    for i in range(len(anel) - 1):
        x1, y1 = anel[i]
        x2, y2 = anel[i + 1]
        s += x1 * y2 - x2 * y1
    return s / 2.0


def esri_para_shapely(rings):
    """rings Esri -> shapely, POR ORIENTAÇÃO (Esri: exterior horário =
    área negativa; buraco anti-horário). '1º anel = exterior, resto =
    buraco' quebraria multipolígonos — que o próprio recorte de
    regeneração grava."""
    exteriores, buracos = [], []
    for anel in rings:
        if len(anel) < 4:
            continue
        (exteriores if _area_anel(anel) < 0 else buracos).append(anel)
    if not exteriores:            # defensivo: tudo veio invertido
        exteriores, buracos = buracos, []
    partes = [(ShPolygon(e), []) for e in exteriores]
    for h in buracos:
        pt = ShPolygon(h).representative_point()
        for p, hs in partes:
            if p.contains(pt):
                hs.append(h)
                break
    polys = [ShPolygon(list(p.exterior.coords), hs) for p, hs in partes]
    g = MultiPolygon(polys) if len(polys) > 1 else polys[0]
    return g.buffer(0)


# ---------------------------------------------------------------- células
_MUNS = None


def municipios_shapely():
    """Os 8 limites do IBGE em shapely 4326, para atribuir o município de
    cada polígono NA GRAVAÇÃO (a consolidação vira um groupBy no servidor
    — cruzar milhões de geometrias no navegador não escala)."""
    global _MUNS
    if _MUNS is None:
        gj = json.load(io.open(os.path.join(RAIZ, "app", "dados",
                                            "municipios.geojson"),
                               encoding="utf-8"))
        _MUNS = []
        for f in gj["features"]:
            g = shape(f["geometry"]).buffer(0)
            _MUNS.append((f["properties"]["codigo"],
                          f["properties"]["nome"], g, g.bounds))
    return _MUNS


def partes_municipais(geom, area_total_ha):
    """Divide o polígono pelos limites municipais.

    Devolve [(codigo, nome, geometria_recortada, fracao)] — uma entrada
    por município tocado. Lista VAZIA quando o polígono está 100% fora
    dos 8: as células são retângulos que somam ~32.500 km² contra os
    3.269 km² dos municípios, então a maior parte do que o dNBR acha cai
    fora do recorte de interesse e é descartada na gravação.

    Recortar (em vez de só rotular pelo município dominante) é o que faz
    a área de cada município ser a área que está DENTRO dele — um
    incêndio na divisa de BH com Contagem vira duas linhas, cada uma com
    a sua parte, e a soma municipal fecha.
    """
    b = geom.bounds
    saida = []
    for cod, nome, g, gb in municipios_shapely():
        if gb[0] > b[2] or gb[2] < b[0] or gb[1] > b[3] or gb[3] < b[1]:
            continue
        if g.contains(geom):          # caso comum: cabe inteiro num só
            return [(cod, nome, geom, 1.0)]
        try:
            inter = geom.intersection(g)
        except Exception:
            try:
                inter = geom.buffer(0).intersection(g)
            except Exception:
                continue
        if inter.is_empty or inter.geom_type not in ("Polygon", "MultiPolygon"):
            continue
        a = area_ha_geodesica(inter)
        if a <= 0:
            continue
        fr = (a / area_total_ha) if area_total_ha else None
        saida.append((cod, nome, inter,
                      round(min(1.0, fr), 4) if fr else None))
    return saida


def celulas_filhas(quads=None, ns=None):
    plano = json.load(io.open(os.path.join(RAIZ, "app", "dados",
                                           "quadrantes.json"),
                              encoding="utf-8"))
    filhas = []
    for q in plano["quadrantes"]:
        if quads and q["id"] not in quads:
            continue
        for c in q["celulas"]:
            b = c["bbox3857"]
            mx, my = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
            quartos = [[b[0], b[1], mx, my], [mx, b[1], b[2], my],
                       [b[0], my, mx, b[3]], [mx, my, b[2], b[3]]]
            for i, bb in enumerate(quartos):
                n = (c["n"] - 1) * 4 + i + 1
                if ns and n not in ns:
                    continue
                filhas.append({"quad": q["id"], "n": n, "bbox": bb,
                               "total": len(q["celulas"]) * 4})
    return filhas


# ---------------------------------------------------------------- GEE
def iniciar_gee():
    try:
        import ee
    except ImportError:
        raise SystemExit(
            'Falta a biblioteca do Earth Engine. Instale com:\n  "%s" '
            "-m pip install --user earthengine-api" % sys.executable)
    try:
        ee.Initialize(project=GEE_PROJECT)
    except Exception as e:
        raise SystemExit(
            "GEE não autenticado (%s).\nRode uma vez:\n  "
            '"C:\\Program Files\\ArcGIS\\Pro\\bin\\Python\\envs\\'
            'arcgispro-py3\\python.exe" -c "import ee; ee.Authenticate()"\n'
            "e entre com a conta do projeto %s." % (e, GEE_PROJECT))
    return ee


def dias_da_celula(ee, cel, desde, ate):
    """Todos os dias com cena sobre a célula — pelo arquivo L1C COMPLETO
    (o SR só cobre o Brasil de ~dez/2018 em diante) — com id de produto,
    nuvem da cena e a flag de haver SR (SCL) no dia."""
    ret = ee.Geometry.Rectangle(bbox4326_de(cel["bbox"]), "EPSG:4326", False)

    def lista(colecao):
        col = (ee.ImageCollection(colecao)
               .filterBounds(ret)
               .filterDate(desde, ate + "T23:59:59"))
        return col.reduceColumns(
            ee.Reducer.toList(3),
            ["system:time_start", "PRODUCT_ID", "CLOUDY_PIXEL_PERCENTAGE"]
        ).get("list").getInfo()

    dias = {}
    for ts, pid, cc in lista("COPERNICUS/S2_HARMONIZED"):
        d = time.strftime("%Y-%m-%d", time.gmtime(ts / 1000))
        atual = dias.get(d)
        if atual is None or (cc is not None and cc < atual["cc"]):
            dias[d] = {"dia": d, "id": pid,
                       "cc": cc if cc is not None else 100, "sr": False}
    for ts, pid, cc in lista("COPERNICUS/S2_SR_HARMONIZED"):
        d = time.strftime("%Y-%m-%d", time.gmtime(ts / 1000))
        if d in dias:
            dias[d]["sr"] = True
        else:
            dias[d] = {"dia": d, "id": pid,
                       "cc": cc if cc is not None else 100, "sr": True}
    return [dias[d] for d in sorted(dias)]


def nuvem_dos_dias(ee, cel, dias, tam_lote=40):
    """Fração de nuvem no RECORTE (sonda a 40 m): SCL nos dias com SR
    (paridade com o vivo: classes 8/9/10 sobre válidos), CloudScore+ nos
    dias só-L1C (fração de pixels com cs < 0,60)."""
    b = cel["bbox"]
    ret = ee.Geometry.Rectangle(b, "EPSG:3857", False)
    esc = RES * CFG["divisorSonda"]
    trans = [esc, 0, b[0], 0, -esc, b[3]]

    def feat(par):
        par = ee.List(par)
        dstr = ee.String(par.get(0))
        tem_sr = ee.Number(par.get(1))
        d0 = ee.Date(dstr)

        def hist_sr():
            img = (ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
                   .filterBounds(ret).filterDate(d0, d0.advance(1, "day"))
                   .sort("CLOUDY_PIXEL_PERCENTAGE", False).mosaic())
            return img.select("SCL").reduceRegion(
                reducer=ee.Reducer.frequencyHistogram(), geometry=ret,
                crs="EPSG:3857", crsTransform=trans,
                maxPixels=1e9).get("SCL")

        def hist_cs():
            cs = (ee.ImageCollection(
                      "GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED")
                  .filterBounds(ret).filterDate(d0, d0.advance(1, "day"))
                  .mosaic().select("cs"))
            return cs.lt(LIMIAR_CS).reduceRegion(
                reducer=ee.Reducer.frequencyHistogram(), geometry=ret,
                crs="EPSG:3857", crsTransform=trans,
                maxPixels=1e9).get("cs")

        h = ee.Algorithms.If(tem_sr, hist_sr(), hist_cs())
        return ee.Feature(None, {"d": dstr, "sr": tem_sr, "h": h})

    saida = {}
    for i in range(0, len(dias), tam_lote):
        lote = [[x["dia"], 1 if x["sr"] else 0] for x in dias[i:i + tam_lote]]
        fc = ee.FeatureCollection(ee.List(lote).map(feat))
        for f in fc.getInfo()["features"]:
            p = f["properties"]
            h = p.get("h") or {}
            conta = {int(float(k)): v for k, v in h.items()}
            if p.get("sr"):
                total = sum(conta.values())
                validos = total - conta.get(0, 0)
                nuvem = sum(conta.get(c, 0) for c in SCL_NUVEM)
                pct = round(100.0 * nuvem / validos, 1) if validos else 100.0
                det = ("alta %.1f · média %.1f · cirrus %.1f · sombra %.1f"
                       % tuple(
                           (100.0 * conta.get(c, 0) / validos if validos
                            else 0) for c in (9, 8, 10, 3)))
            else:
                validos = conta.get(0, 0) + conta.get(1, 0)
                pct = (round(100.0 * conta.get(1, 0) / validos, 1)
                       if validos else 100.0)
                det = "CloudScore+ (cs<%.2f): %.1f%%" % (LIMIAR_CS, pct)
            saida[p["d"]] = {"pct": pct, "detalhe": det}
    return saida


def poligonos_do_par(ee, cel, dia_base, sr_base, dia_atual, sr_atual,
                     divisao=1):
    """dNBR(base→atual) vetorizado no servidor. As geometrias saem em
    WGS84 (padrão do reduceToVectors) — cantos de pixel da grade 3857.
    Devolve (features, total_bruto, truncado).

    `divisao` > 1 vetoriza em divisao×divisao sub-blocos e junta: máscara
    muito fragmentada estoura o "User memory limit exceeded" do GEE numa
    célula inteira de 2.500². O preço é que um componente que atravessa a
    fronteira de dois sub-blocos vira dois polígonos — por isso só se
    recorre a isso quando a chamada cheia falha.
    """
    b = cel["bbox"]
    if divisao > 1:
        feats, bruto, trunc = [], 0, False
        passo_x = (b[2] - b[0]) / divisao
        passo_y = (b[3] - b[1]) / divisao
        for i in range(divisao):
            for j in range(divisao):
                sub = dict(cel)
                sub["bbox"] = [b[0] + i * passo_x, b[1] + j * passo_y,
                               b[0] + (i + 1) * passo_x,
                               b[1] + (j + 1) * passo_y]
                try:
                    f2, n2, t2 = poligonos_do_par(ee, sub, dia_base, sr_base,
                                                  dia_atual, sr_atual, 1)
                except Exception as e_sub:
                    # sub-bloco fora da faixa da cena naquela data: a
                    # coleção volta vazia e o mosaic() não tem banda
                    # nenhuma. Não é erro — é ausência de imagem ali.
                    if "No band named" in str(e_sub) or \
                       "Available band names: []" in str(e_sub):
                        continue
                    raise
                feats.extend(f2)
                bruto += n2
                trunc = trunc or t2
        return feats, bruto, trunc

    ret = ee.Geometry.Rectangle(b, "EPSG:3857", False)
    trans = [RES, 0, b[0], 0, -RES, b[3]]

    def nbr(dstr, tem_sr):
        d0 = ee.Date(dstr)
        if tem_sr:
            img = (ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
                   .filterBounds(ret).filterDate(d0, d0.advance(1, "day"))
                   .sort("CLOUDY_PIXEL_PERCENTAGE", False).mosaic())
            scl = img.select("SCL")
            ruim = ee.Image(0)
            for c in SCL_RUIM:
                ruim = ruim.Or(scl.eq(c))
            ruim = ruim.Or(scl.mask().Not())
            return img.normalizedDifference(["B8", "B12"]) \
                      .updateMask(ruim.Not())
        img = (ee.ImageCollection("COPERNICUS/S2_HARMONIZED")
               .filterBounds(ret).filterDate(d0, d0.advance(1, "day"))
               .sort("CLOUDY_PIXEL_PERCENTAGE", False).mosaic())
        cs = (ee.ImageCollection("GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED")
              .filterBounds(ret).filterDate(d0, d0.advance(1, "day"))
              .mosaic().select("cs"))
        return img.normalizedDifference(["B8", "B12"]) \
                  .updateMask(cs.gte(LIMIAR_CS))

    dnbr = nbr(dia_base, sr_base).subtract(nbr(dia_atual, sr_atual))
    queimado = dnbr.gte(CFG["limiar"]).selfMask()
    # maxSize = MIN_PX+1: só interessa saber se o componente ALCANÇA o
    # piso, não o tamanho real dele. Contar até 1.024 estourava a memória
    # do GEE numa célula de 2.500² com o piso baixo.
    cc = queimado.connectedPixelCount(min(MIN_PX + 1, 256), False)
    queimado = queimado.updateMask(cc.gte(MIN_PX))

    vet = queimado.reduceToVectors(
        geometry=ret, crs="EPSG:3857", crsTransform=trans,
        eightConnected=False, geometryType="polygon",
        labelProperty="lab", maxPixels=1e10)
    fc = dnbr.reduceRegions(
        collection=vet,
        reducer=ee.Reducer.mean().combine(ee.Reducer.count(), "", True),
        crs="EPSG:3857", crsTransform=trans)
    fc = fc.filter(ee.Filter.gte("count", MIN_PX))

    n = fc.size().getInfo()
    truncado = n > MAX_POLIGONOS
    if truncado:
        fc = fc.limit(MAX_POLIGONOS, "count", False)
    return (buscar_feicoes(fc) if n else []), n, truncado


def buscar_feicoes(fc):
    """Busca a coleção INTEIRA, paginando.

    `getInfo()` aborta em 5.000 elementos ("Collection query aborted after
    accumulating over 5000 elements") — com o piso de 2 px uma passagem de
    pico passa disso com folga.

    Dois detalhes verificados na marra: o servidor LIMITA a página a 1.000
    (pedir mais é ignorado em silêncio) e a chave do token é
    `nextPageToken` em camelCase — o docstring da própria biblioteca diz
    `next_page_token`, e quem confia nele pagina uma vez só e perde o
    resto sem erro nenhum.
    """
    import ee
    saida, token = [], None
    while True:
        params = {"expression": fc, "pageSize": 1000}
        if token:
            params["pageToken"] = token
        resp = ee.data.computeFeatures(params)
        saida.extend(resp.get("features") or [])
        token = resp.get("nextPageToken") or resp.get("next_page_token")
        if not token:
            return saida


# ---------------------------------------------------------------- tiles LULC
_TILES = {}

def tile_da_celula(cel, ano):
    ano_t = min(int(ano), ANO_TILE_MAX)
    k = (cel["quad"], cel["n"], ano_t)
    if k in _TILES:
        return _TILES[k]
    caminho = os.path.join(AQUI, "tiles", str(ano_t),
                           "lulc_%d_%s_c%d.png"
                           % (ano_t, cel["quad"], cel["n"]))
    arr = np.array(Image.open(caminho)) if os.path.exists(caminho) else None
    _TILES[k] = arr
    return arr


def classes_da_feicao(geom4326, cel, tile):
    """Conta as classes do tile sob o componente por teste de CENTRO de
    pixel (matplotlib Path, winding — buracos e multipartes corretos).
    O ImageDraw preencheria 1 fileira/coluna a mais (cantos inclusivos)."""
    b = cel["bbox"]
    grupos = geom4326["coordinates"] if geom4326["type"] == "MultiPolygon" \
        else [geom4326["coordinates"]]
    verts, codes = [], []
    xs, ys = [], []
    for grupo in grupos:
        for anel in grupo:
            pts = []
            for lon, lat in anel:
                x, y = lonlat_para_merc(lon, lat)
                px, py = (x - b[0]) / RES, (b[3] - y) / RES
                pts.append((px, py))
                xs.append(px)
                ys.append(py)
            if len(pts) < 4:
                continue
            verts.extend(pts)
            codes.extend([MplPath.MOVETO] +
                         [MplPath.LINETO] * (len(pts) - 2) +
                         [MplPath.CLOSEPOLY])
    if not verts:
        return {}
    i0 = max(0, int(math.floor(min(xs))))
    i1 = min(PX, int(math.ceil(max(xs))))
    j0 = max(0, int(math.floor(min(ys))))
    j1 = min(PX, int(math.ceil(max(ys))))
    if i1 <= i0 or j1 <= j0:
        return {}
    gx, gy = np.meshgrid(np.arange(i0, i1) + 0.5, np.arange(j0, j1) + 0.5)
    dentro = MplPath(verts, codes).contains_points(
        np.column_stack([gx.ravel(), gy.ravel()]))
    if not dentro.any():
        return {}
    sub = tile[j0:j1, i0:i1].ravel()[dentro]
    vals, cts = np.unique(sub, return_counts=True)
    return dict(zip(vals.tolist(), cts.tolist()))


# ---------------------------------------------------------------- Portal
def conectar_portal():
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
        "gis": gis,
        "poligonos": item.layers[0],
        "controle": tabs["Controle de passagens"],
        "classe": tabs["Queimada por classe"],
        "parametros": tabs["Parametros de biomassa"],
    }


def consultar_tudo(camada, where, campos, geometria=False):
    """Paginação com ORDER BY objectid — sem isso este Portal repete e
    pula linhas acima de maxRecordCount (lição antiga da casa)."""
    saida, offset = [], 0
    while True:
        kw = dict(where=where, out_fields=campos,
                  return_geometry=geometria,
                  order_by_fields="objectid",
                  result_offset=offset, result_record_count=2000)
        if geometria:
            kw["out_sr"] = 4326
        r = camada.query(**kw)
        fs = r.features
        saida.extend(fs)
        if len(fs) < 2000:
            break
        offset += len(fs)
    return saida


def carregar_bc(alvos):
    linhas = consultar_tudo(alvos["parametros"], "1=1",
                            "classe_id,b_t_ha,c_fracao")
    return {f.attributes["classe_id"]:
            ((f.attributes["b_t_ha"] or 0) * (f.attributes["c_fracao"] or 0))
            for f in linhas if f.attributes["classe_id"] is not None}


def epoch_meio_dia(dia):
    return (calendar.timegm(time.strptime(dia, "%Y-%m-%d")) + 12 * 3600) * 1000


def janela_dia_sql(dia):
    seg = time.strftime("%Y-%m-%d",
                        time.gmtime(epoch_meio_dia(dia) / 1000 + 86400))
    return ("data_pass >= TIMESTAMP '%s 00:00:00' AND "
            "data_pass < TIMESTAMP '%s 00:00:00'" % (dia, seg))


def conferir(res, rotulo):
    for k in ("addResults", "updateResults", "deleteResults"):
        for r in (res.get(k) or []):
            if not r.get("success"):
                raise RuntimeError("%s: applyEdits recusou linha: %s"
                                   % (rotulo, r))
    return res


# ---------------------------------------------------------------- por célula
def processar_celula(ee, alvos, bc, cel, desde, ate):
    quad, n = cel["quad"], cel["n"]
    rot = "%s c%d" % (quad, n)
    where_cel = ("quad_id = '%s' AND celula = %d AND res_m = %d"
                 % (quad, n, RES))

    # 1. o controle É o checkpoint: dias feitos + cadeia de aceitas
    feitas = consultar_tudo(alvos["controle"], where_cel,
                            "data_pass,status_proc,cena_id")
    prontos, cena_de = {}, {}
    for f in feitas:
        d = time.strftime("%Y-%m-%d",
                          time.gmtime(f.attributes["data_pass"] / 1000))
        prontos[d] = f.attributes["status_proc"]
        if f.attributes["status_proc"] in ("base", "calculada", "sem_area"):
            cena_de[d] = f.attributes.get("cena_id")
    aceitos = sorted(cena_de)   # ordenado — a base é SEMPRE a última < dia

    def base_antes(dia):
        i = bisect.bisect_left(aceitos, dia)
        return aceitos[i - 1] if i else None

    # 2. memória da regeneração: o que já queimou na célula (por
    #    orientação de anel — multipolígonos do recorte voltam inteiros)
    regen_ms = int(CFG["regeneracaoDias"]) * DIA_MS
    desde_regen = time.strftime("%Y-%m-%d", time.gmtime(
        (epoch_meio_dia(desde) - regen_ms) / 1000))
    ja = consultar_tudo(
        alvos["poligonos"],
        where_cel + (" AND data_pass >= TIMESTAMP '%s 00:00:00'"
                     % desde_regen),
        "data_pass", geometria=True)
    anteriores = []
    for f in ja:
        d = time.strftime("%Y-%m-%d",
                          time.gmtime(f.attributes["data_pass"] / 1000))
        try:
            anteriores.append((d, esri_para_shapely(f.geometry["rings"])))
        except Exception as e:
            print("  [%s] aviso: polígono antigo ilegível (%s)"
                  % (rot, str(e)[:60]))

    # 3. catálogo + nuvem no recorte
    dias = dias_da_celula(ee, cel, desde, ate)
    dias_map = {d["dia"]: d for d in dias}
    novos = [d for d in dias if d["dia"] not in prontos
             or prontos[d["dia"]] == "erro"]
    so_l1c = sum(1 for d in dias if not d["sr"])
    print("[%s] %d dias no catálogo (%d só L1C/TOA), %d a processar"
          % (rot, len(dias), so_l1c, len(novos)))
    if not novos:
        return {"celula": rot, "processadas": 0}
    nuvens = nuvem_dos_dias(ee, cel, novos)

    def sr_de(dia):
        if dia in dias_map:
            return dias_map[dia]["sr"]
        return dia >= SR_DESDE

    feitas_n = 0
    for pas in novos:
        dia = pas["dia"]
        nv = nuvens.get(dia, {"pct": 100.0, "detalhe": "sem medida"})
        attrs_base = {
            "quad_id": quad, "celula": n, "res_m": RES,
            "total_celulas": cel["total"],
            "data_pass": epoch_meio_dia(dia),
            "competencia": dia[:7],
            "cena_id": pas["id"], "nuvem_pct": pas["cc"],
            "nuvem_rec": nv["pct"], "nuvem_rec_det": nv["detalhe"][:120],
            "bbox_3857": bbox_txt(cel["bbox"]),
            "bbox_4326": bbox_txt(bbox4326_de(cel["bbox"]), 5),
            "pu_gasto": 0, "processado_por": USUARIO,
        }
        try:
            # higiene: sobras de tentativa anterior desta célula×dia.
            # O controle é apagado SEMPRE (não só no reprocesso de erro):
            # a linha é reescrita logo abaixo, e se outra rodada tiver
            # gravado a mesma célula×dia no meio-tempo, sem isto ficariam
            # duas linhas para a mesma passagem — área contada em dobro
            # em qualquer soma feita sobre o controle.
            wh_dia = where_cel + " AND " + janela_dia_sql(dia)
            alvos["poligonos"].delete_features(where=wh_dia)
            alvos["classe"].delete_features(where=wh_dia)
            alvos["controle"].delete_features(where=wh_dia)

            if nv["pct"] > CFG["nuvemRecorteMax"]:
                a = dict(attrs_base)
                a.update({"status_proc": "nublada", "area_ha": 0,
                          "n_poligonos": 0,
                          "motivo": "nuvem no recorte: %.1f%%" % nv["pct"]})
                conferir(alvos["controle"].edit_features(
                    adds=[{"attributes": a}]), rot)
                feitas_n += 1
                continue

            # a base é a última aceita ANTERIOR a este dia — nunca uma
            # linha do futuro (o serviço é compartilhado com o vivo)
            base_dia = base_antes(dia)

            if base_dia is None:
                a = dict(attrs_base)
                a.update({"status_proc": "base", "area_ha": 0,
                          "n_poligonos": 0,
                          "motivo": "primeira passagem viável — base de cálculo"})
                conferir(alvos["controle"].edit_features(
                    adds=[{"attributes": a}]), rot)
                bisect.insort(aceitos, dia)
                cena_de[dia] = pas["id"]
                feitas_n += 1
                continue

            vao = int((epoch_meio_dia(dia) - epoch_meio_dia(base_dia))
                      / DIA_MS)
            sr_b, sr_a = sr_de(base_dia), sr_de(dia)
            # máscara fragmentada demais estoura a memória do GEE na
            # célula inteira; sobe a divisão até caber (2×2, depois 4×4)
            dividido = 1
            for tentativa in (1, 2, 4):
                try:
                    feats, total_bruto, truncado = poligonos_do_par(
                        ee, cel, base_dia, sr_b, dia, sr_a, tentativa)
                    dividido = tentativa
                    break
                except Exception as eg:
                    if "memory" not in str(eg).lower() or tentativa == 4:
                        raise
                    print("  [%s] %s: memória do GEE — refazendo em %dx%d"
                          % (rot, dia, tentativa * 2, tentativa * 2))

            tile = tile_da_celula(cel, int(dia[:4]))
            regen_corte = epoch_meio_dia(dia) - regen_ms
            janela_regen = [g for d0, g in anteriores
                            if epoch_meio_dia(d0) >= regen_corte
                            and d0 < dia]
            uniao = unary_union(janela_regen) if janela_regen else None

            adds_poli, adds_classe, novas_geoms = [], [], []
            area_total = 0.0
            fora_descartados = 0
            piso_chao = area_min_geod(cel)   # MIN_PX px traduzidos p/ o chão
            for f in feats:
                g4326 = shape(f["geometry"]).buffer(0)
                if g4326.is_empty:
                    continue
                # o critério de detecção já foi aplicado em PIXELS no GEE
                # (count >= MIN_PX); aqui só se descarta geometria
                # degenerada, com o piso convertido para metros de chão
                ha_cheio = area_ha_geodesica(g4326)
                if ha_cheio * 10000 < piso_chao * 0.5:
                    continue

                # fração por classe do componente INTEIRO (paridade c/ vivo)
                classes = classes_da_feicao(
                    f["geometry"], cel, tile) if tile is not None else {}

                # rede de regeneração (vetorial, como o motor)
                recortada = g4326
                if uniao is not None:
                    try:
                        recortada = g4326.difference(uniao)
                    except Exception:
                        recortada = g4326.buffer(0).difference(
                            uniao.buffer(0))
                    if recortada.is_empty:
                        continue
                ha = ha_cheio if recortada is g4326 \
                    else area_ha_geodesica(recortada)
                if ha * 10000 < piso_chao:
                    continue

                dnbr_med = f["properties"].get("mean")
                n_px = f["properties"].get("count")
                if ha < ha_cheio * 0.99:
                    dnbr_med = None   # média não descreve mais a geometria

                # RECORTE MUNICIPAL: o que está 100% fora dos 8 é
                # descartado aqui (as células são retângulos e ~90% da
                # área delas não interessa); o que cruza a divisa vira
                # uma linha POR MUNICÍPIO, cada uma com a sua parte
                partes = partes_municipais(recortada, ha)
                if not partes:
                    fora_descartados += 1
                    continue

                for mun_cod, mun_nome, geom_mun, mun_fr in partes:
                    ha_m = (ha if len(partes) == 1 and mun_fr == 1.0
                            else area_ha_geodesica(geom_mun))
                    if ha_m * 10000 < piso_chao:
                        continue

                    classes_m = (classes if len(partes) == 1
                                 else (classes_da_feicao(
                                     mapping(geom_mun), cel, tile)
                                     if tile is not None else {}))
                    # DADO BRUTO: área e pixels por classe. Biomassa e
                    # emissões NÃO são calculadas aqui — saem na leitura,
                    # dos parâmetros que o usuário edita. Gravar o
                    # produto já multiplicado obrigaria a reprocessar
                    # anos de GEE a cada revisão de metodologia.
                    total_px = sum(classes_m.values()) or 0
                    classe_uso, maxpx = None, 0
                    itens = []
                    for cid, npx in classes_m.items():
                        cid = int(cid)
                        a_c = ha_m * npx / total_px if total_px else 0
                        if npx > maxpx:
                            maxpx, classe_uso = npx, cid
                        itens.append((cid, a_c, int(npx)))

                    adds_poli.append({
                        "geometry": {"rings": para_rings_esri(geom_mun),
                                     "spatialReference": {"wkid": 4326}},
                        "attributes": {
                            "quad_id": quad, "celula": n, "res_m": RES,
                            "data_pass": epoch_meio_dia(dia),
                            "data_ref": epoch_meio_dia(base_dia),
                            "competencia": dia[:7],
                            "area_ha": round(ha_m, 4),
                            "n_pixels": int(n_px) if n_px is not None else None,
                            "municipio": mun_cod, "mun_nome": mun_nome,
                            "mun_fracao": mun_fr,
                            "dnbr_med": round(dnbr_med, 4)
                            if dnbr_med is not None else None,
                            "status": "Queimada",
                            "classe_uso": classe_uso,
                            # biomassa é DERIVADA na leitura, não gravada
                            "cena_id": pas["id"],
                            "cena_ref_id": cena_de.get(base_dia),
                            "metodo": ("dNBR (B08/B12) %d m · base %s · "
                                       "regen %dd · retroativo GEE"
                                       % (RES, base_dia,
                                          int(CFG["regeneracaoDias"]))),
                            "processado_por": USUARIO,
                        },
                        "_itens": itens,
                    })
                    novas_geoms.append((dia, geom_mun))
                    area_total += ha_m

            # grava polígonos (lotes) + detalhamento por classe + controle
            for i in range(0, len(adds_poli), 200):
                lote = adds_poli[i:i + 200]
                res = conferir(alvos["poligonos"].edit_features(
                    adds=[{k: v for k, v in p.items() if k != "_itens"}
                          for p in lote]), rot)
                for p, r in zip(lote, res["addResults"]):
                    gid = r.get("globalId")
                    for cid, a_c, npx_c in p["_itens"]:
                        adds_classe.append({"attributes": {
                            "poligono_gid": gid,
                            "competencia": dia[:7],
                            "quad_id": quad, "celula": n, "res_m": RES,
                            "data_pass": epoch_meio_dia(dia),
                            "classe_id": cid,
                            "area_ha": round(a_c, 4),
                            "n_pixels_classe": npx_c,
                            "n_pixels": p["attributes"].get("n_pixels"),
                            "municipio": p["attributes"].get("municipio")}})
            for i in range(0, len(adds_classe), 500):
                conferir(alvos["classe"].edit_features(
                    adds=adds_classe[i:i + 500]), rot)

            motivos = []
            if truncado:
                motivos.append("vetorização truncada: %d componentes"
                               % total_bruto)
            if vao > CFG["vaoMaximoDias"]:
                motivos.append("vão de %d dias até a base (%s) — validar"
                               % (vao, base_dia))
            if not sr_b or not sr_a:
                lados = []
                if not sr_b:
                    lados.append("base")
                if not sr_a:
                    lados.append("passagem")
                motivos.append("NBR em TOA (L1C+CloudScore+) na "
                               + " e ".join(lados))
            if tile is None:
                motivos.append("sem tile LULC — biomassa nula")
            if dividido > 1:
                motivos.append("vetorizado em %dx%d sub-blocos (memória do "
                               "GEE) — componentes na fronteira ficam "
                               "partidos" % (dividido, dividido))
            a = dict(attrs_base)
            a.update({
                "status_proc": "calculada" if adds_poli else "sem_area",
                "data_ref": epoch_meio_dia(base_dia),
                "cena_ref_id": cena_de.get(base_dia),
                "area_ha": round(area_total, 2),
                "n_poligonos": len(adds_poli),
                "motivo": (" · ".join(motivos))[:240] or None,
            })
            conferir(alvos["controle"].edit_features(
                adds=[{"attributes": a}]), rot)

            anteriores.extend(novas_geoms)
            bisect.insort(aceitos, dia)
            cena_de[dia] = pas["id"]
            feitas_n += 1
            if adds_poli or fora_descartados:
                print("  [%s] %s: %d polígono(s) nos municípios, %.1f ha"
                      % (rot, dia, len(adds_poli), area_total) +
                      (" · %d descartados fora dos 8" % fora_descartados
                       if fora_descartados else ""))
        except Exception as e:
            print("  [%s] %s ERRO: %s" % (rot, dia, str(e)[:160]))
            try:
                wh_dia = where_cel + " AND " + janela_dia_sql(dia)
                alvos["poligonos"].delete_features(where=wh_dia)
                alvos["classe"].delete_features(where=wh_dia)
                a = dict(attrs_base)
                a.update({"status_proc": "erro", "area_ha": 0,
                          "n_poligonos": 0, "motivo": str(e)[:240]})
                alvos["controle"].edit_features(adds=[{"attributes": a}])
            except Exception as e2:
                print("  [%s] %s: nem o erro gravou (%s) — a higiene limpa"
                      % (rot, dia, str(e2)[:80]))
    return {"celula": rot, "processadas": feitas_n}


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quads", help="ex.: A2 ou A1,B2")
    ap.add_argument("--celulas", help="números das células de 10 m, ex.: 17,18")
    ap.add_argument("--desde", default="2017-03-28")
    ap.add_argument("--ate", default="2025-12-31")
    ap.add_argument("--paralelo", type=int, default=3)
    args = ap.parse_args()

    quads = set(args.quads.split(",")) if args.quads else None
    ns = set(int(x) for x in args.celulas.split(",")) if args.celulas else None

    print("parâmetros (config.js):", CFG)
    ee = iniciar_gee()
    print("GEE ok · projeto", GEE_PROJECT)
    alvos = conectar_portal()
    print("Portal ok ·", alvos["gis"].users.me.username)
    bc = carregar_bc(alvos)
    print("parâmetros B×C:", len(bc), "classes")

    filhas = celulas_filhas(quads, ns)
    print("células:", len(filhas), "· período:", args.desde, "→", args.ate)

    total = 0
    if args.paralelo <= 1 or len(filhas) == 1:
        for cel in filhas:
            r = processar_celula(ee, alvos, bc, cel, args.desde, args.ate)
            total += r["processadas"]
    else:
        with ThreadPoolExecutor(max_workers=args.paralelo) as ex:
            futs = {ex.submit(processar_celula, ee, alvos, bc, cel,
                              args.desde, args.ate): cel for cel in filhas}
            for fu in as_completed(futs):
                try:
                    r = fu.result()
                    total += r["processadas"]
                    print("== %s concluída (%d passagens) =="
                          % (r["celula"], r["processadas"]))
                except Exception:
                    cel = futs[fu]
                    print("== %s c%d FALHOU ==" % (cel["quad"], cel["n"]))
                    traceback.print_exc()

    print("\nbackfill: %d célula-passagens processadas nesta rodada" % total)
    print("rodar de novo retoma do controle (checkpoint natural).")


main()
