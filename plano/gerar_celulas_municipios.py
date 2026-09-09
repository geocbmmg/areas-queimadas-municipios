# -*- coding: utf-8 -*-
"""
Gera a malha do MONITOR DOS 9 Municípios — o fork do monitor estadual com
o recorte trocado: em vez do estado inteiro, só as células que tocam os
9 Municípios do estudo de área queimada (2015–2024).

  Belo Horizonte (3106200), Betim (3106705),
  Conceição do Mato Dentro (3117504), Congonhas (3118007),
  Contagem (3118601), Ipatinga (3131307),
  São José da Lapa (3162955), Timóteo (3168705)

A malha é a MESMA do estadual — EPSG:3857, ancorada em múltiplos do lado
do quadrante a partir da origem, então cada célula daqui coincide
FISICAMENTE com uma célula (ou quarto de célula, a 10 m) do monitor
estadual. Só as letras dos quadrantes mudam, porque o A1 é relativo ao
bbox do plano (documentado no DOCUMENTACAO.md).

A resolução de trabalho deste fork é 10 m (decisão do usuário): os
municípios são pequenos, o custo cabe folgado em um militar, e o recorte
urbano/periurbano pede cicatriz fina. O plano publica os custos de 10 e
20 m — o painel alterna.

Fontes dos limites municipais: malha municipal do IBGE (geobr/IBGE 2022),
já baixada pelo estudo (estudo-queimadas-mg/scripts/recorta_viirs.py) e
copiada para plano/dados/<codigo>.geojson.

Saídas em app/dados/:
  quadrantes.json     — premissas, quadrantes, células, custo
  quadrantes.geojson  — quadrantes para o mapa
  celulas.geojson     — células para o mapa
  municipios.geojson  — os 8 limites municipais (código + nome), para o
                        mapa e para a consolidação por município
"""
import io
import json
import math
import os

import numpy as np

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)
SAIDA = os.path.join(RAIZ, "app", "dados")
DADOS = os.path.join(AQUI, "dados")

MUNICIPIOS = {
    "3106200": "Belo Horizonte",
    "3106705": "Betim",
    "3117504": "Conceição do Mato Dentro",
    "3118007": "Congonhas",
    "3118601": "Contagem",
    "3131307": "Ipatinga",
    "3147006": "Paracatu",
    "3162955": "São José da Lapa",
    "3168705": "Timóteo",
}

# Paracatu entrou depois (09/2026) e muda a escala do projeto: sozinho
# tem 8.229 km² contra 3.269 km² dos outros oito somados, e fica ~200 km
# a oeste — o retângulo que envolve tudo cresce muito, mas só viram
# células os blocos que de fato tocam algum município, então o custo
# acompanha a área, não a distância.

# ------------------------------------------------------------------ premissas
LADO_MAX_PX = 2500        # teto da Process API por lado
RES_PADRAO = 20           # m/px da célula-mãe (a 10 m ela se parte em 2×2)
PASSAGENS_MES = 6         # Sentinel-2 A+B
ORCAMENTO_MILITAR = 7000  # PU/mês por militar (conservador; a conta free é 30k)
RESERVA_FALSACOR = 0.12
GRADE_QUADRANTE = int(os.environ.get("GRADE", 5))
RASTER_M = 100            # municípios pequenos pedem raster mais fino que o estadual

R = 6378137.0
LADO_CELULA = LADO_MAX_PX * RES_PADRAO
LADO_QUADRANTE = LADO_CELULA * GRADE_QUADRANTE

PU_PX_INDICE = 4 / 3 / 262144
PU_PX_FALSACOR = 1 / 262144


def para_mercator(lon, lat):
    x = R * math.radians(lon)
    y = R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, y


def para_lonlat(x, y):
    lon = math.degrees(x / R)
    lat = math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2)
    return lon, lat


def bbox4326(b):
    lon0, lat0 = para_lonlat(b[0], b[1])
    lon1, lat1 = para_lonlat(b[2], b[3])
    return [round(lon0, 6), round(lat0, 6), round(lon1, 6), round(lat1, 6)]


def anel(b):
    return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]


def anel4326(b):
    return [list(para_lonlat(p[0], p[1])) for p in anel(b)]


def carregar_municipio(codigo):
    """Anéis do município em 3857 + a geometria original 4326."""
    j = json.load(io.open(os.path.join(DADOS, codigo + ".geojson"),
                          encoding="utf-8"))
    g = j["features"][0]["geometry"]
    partes = g["coordinates"] if g["type"] == "Polygon" else \
        [a for p in g["coordinates"] for a in p]
    aneis = [[para_mercator(p[0], p[1]) for p in a] for a in partes]
    return aneis, g


def rasterizar(aneis, b, passo):
    """Scanline com paridade (mesma do estadual)."""
    nx = int(math.ceil((b[2] - b[0]) / passo))
    ny = int(math.ceil((b[3] - b[1]) / passo))
    grade = np.zeros((ny, nx), dtype=bool)

    arestas = []
    for a in aneis:
        for i in range(len(a) - 1):
            (x0, y0), (x1, y1) = a[i], a[i + 1]
            if y0 != y1:
                arestas.append((x0, y0, x1, y1))
    if not arestas:
        return grade
    arestas = np.array(arestas, dtype=float)
    ax0, ay0, ax1, ay1 = arestas[:, 0], arestas[:, 1], arestas[:, 2], arestas[:, 3]
    ymin = np.minimum(ay0, ay1)
    ymax = np.maximum(ay0, ay1)

    for j in range(ny):
        yc = b[1] + (j + 0.5) * passo
        m = (ymin <= yc) & (ymax > yc)
        if not m.any():
            continue
        t = (yc - ay0[m]) / (ay1[m] - ay0[m])
        xs = np.sort(ax0[m] + t * (ax1[m] - ax0[m]))
        for k in range(0, len(xs) - 1, 2):
            i0 = int(math.ceil((xs[k] - b[0]) / passo - 0.5))
            i1 = int(math.floor((xs[k + 1] - b[0]) / passo - 0.5))
            if i1 >= i0:
                grade[j, max(0, i0):min(nx, i1 + 1)] = True
    return grade


def main():
    municipios = {}
    todos_aneis = []
    for cod in sorted(MUNICIPIOS):
        aneis, geo4326 = carregar_municipio(cod)
        municipios[cod] = {"aneis": aneis, "geo": geo4326}
        todos_aneis.extend(aneis)

    xs = [p[0] for a in todos_aneis for p in a]
    ys = [p[1] for a in todos_aneis for p in a]
    bm = [min(xs), min(ys), max(xs), max(ys)]

    # âncora em múltiplos do lado do quadrante a partir da ORIGEM (0,0):
    # as células daqui coincidem fisicamente com as do monitor estadual
    x0 = math.floor(bm[0] / LADO_QUADRANTE) * LADO_QUADRANTE
    y0 = math.floor(bm[1] / LADO_QUADRANTE) * LADO_QUADRANTE
    x1 = math.ceil(bm[2] / LADO_QUADRANTE) * LADO_QUADRANTE
    y1 = math.ceil(bm[3] / LADO_QUADRANTE) * LADO_QUADRANTE

    caixa = [x0, y0, x1, y1]
    grades = {}
    uniao = None
    for cod in sorted(municipios):
        g = rasterizar(municipios[cod]["aneis"], caixa, RASTER_M)
        grades[cod] = g
        uniao = g.copy() if uniao is None else (uniao | g)
    ny, nx = uniao.shape
    print("raster: %d x %d px de %d m" % (nx, ny, RASTER_M))

    lat = np.array([para_lonlat(0, y0 + (j + 0.5) * RASTER_M)[1]
                    for j in range(ny)])
    peso = (np.cos(np.radians(lat)) ** 2) * (RASTER_M ** 2) / 1e6  # km²/px

    print("\náreas municipais conferidas (raster × IBGE aproximado):")
    area_total = 0.0
    for cod in sorted(municipios):
        a = float((grades[cod].sum(axis=1) * peso).sum())
        area_total += a
        print("  %s %-26s %8.1f km²" % (cod, MUNICIPIOS[cod], a))
    print("  total: %.1f km²" % area_total)

    nc_x = int((x1 - x0) / LADO_CELULA)
    nc_y = int((y1 - y0) / LADO_CELULA)
    por_cel = int(LADO_CELULA / RASTER_M)

    pu_indice_celula = LADO_MAX_PX * LADO_MAX_PX * PU_PX_INDICE
    pu_fc_celula = LADO_MAX_PX * LADO_MAX_PX * PU_PX_FALSACOR
    pu_mes_celula = pu_indice_celula * PASSAGENS_MES

    quadrantes = {}
    total_celulas = 0

    for cy in range(nc_y):
        for cx in range(nc_x):
            j0, j1 = cy * por_cel, (cy + 1) * por_cel
            i0, i1 = cx * por_cel, (cx + 1) * por_cel
            recorte = uniao[j0:j1, i0:i1]
            if not recorte.any():
                continue
            area = float((recorte.sum(axis=1) * peso[j0:j1]).sum())
            na_celula = [cod for cod in sorted(municipios)
                         if grades[cod][j0:j1, i0:i1].any()]

            b = [x0 + cx * LADO_CELULA, y0 + cy * LADO_CELULA,
                 x0 + (cx + 1) * LADO_CELULA, y0 + (cy + 1) * LADO_CELULA]

            # Identificador ESTÁVEL: derivado da posição ABSOLUTA na malha
            # do Mercator, não da posição relativa ao conjunto atual de
            # municípios. Antes a letra vinha de `cx // GRADE`, contado a
            # partir do canto do retângulo que envolvia os municípios —
            # então incluir Paracatu (200 km a oeste) renomeou A1 para C1
            # e todo o histórico já gravado passou a apontar para
            # quadrante que não existe mais, sem erro nenhum.
            # Com a âncora absoluta, acrescentar município no futuro não
            # mexe em nada do que já foi processado.
            qax = int(math.floor((x0 + cx * LADO_CELULA) / LADO_QUADRANTE))
            qay = int(math.floor((y0 + cy * LADO_CELULA) / LADO_QUADRANTE))
            qid = "%d_%d" % (qax, qay)
            # o bbox do quadrante também sai da âncora absoluta, para
            # casar com o id e não depender do recorte atual
            q = quadrantes.setdefault(qid, {
                "id": qid, "col": qax, "lin": qay,
                "bbox3857": [qax * LADO_QUADRANTE, qay * LADO_QUADRANTE,
                             (qax + 1) * LADO_QUADRANTE,
                             (qay + 1) * LADO_QUADRANTE],
                "celulas": [], "area_mg_km2": 0.0
            })
            q["celulas"].append({
                # o número da célula também tem de ser POSICIONAL, não a
                # ordem de inserção: senão uma célula nova no meio do
                # quadrante empurraria a numeração das demais e a chave
                # do controle passaria a apontar para outro pedaço do chão
                "n": (cy % GRADE_QUADRANTE) * GRADE_QUADRANTE
                     + (cx % GRADE_QUADRANTE) + 1,
                "cx": cx, "cy": cy,
                "bbox3857": [round(v, 1) for v in b],
                "bbox4326": bbox4326(b),
                "largura": LADO_MAX_PX, "altura": LADO_MAX_PX,
                "area_mg_km2": round(area, 1),
                "municipios": na_celula,
                "borda": True   # toda célula daqui é borda: municípios < célula
            })
            q["area_mg_km2"] += area
            total_celulas += 1

    lista = []
    for qid in sorted(quadrantes):
        q = quadrantes[qid]
        n = len(q["celulas"])
        q["n_celulas"] = n
        q["area_mg_km2"] = round(q["area_mg_km2"], 1)
        q["bbox4326"] = bbox4326(q["bbox3857"])
        q["municipios"] = sorted(set(
            m for c in q["celulas"] for m in c["municipios"]))
        q["res"] = {}
        for res in (10, 20):
            fator = (RES_PADRAO / res) ** 2
            q["res"][str(res)] = {
                "celulas": int(round(n * fator)),
                "km_celula": round(LADO_MAX_PX * res / 1000, 1),
                "pu_passagem": round(pu_indice_celula * n * fator, 1),
                "pu_mes": round(pu_mes_celula * n * fator, 1),
                "pu_falsacor_celula": round(pu_fc_celula, 1),
            }
        lista.append(q)

    orc_util = ORCAMENTO_MILITAR * (1 - RESERVA_FALSACOR)
    pu_total_20 = sum(q["res"]["20"]["pu_mes"] for q in lista)
    pu_total_10 = sum(q["res"]["10"]["pu_mes"] for q in lista)

    plano = {
        "premissas": {
            "crs": "EPSG:3857",
            "celula_px": LADO_MAX_PX,
            "celula_km_20m": LADO_CELULA / 1000,
            "celula_km_10m": LADO_CELULA / 2000,
            "quadrante_km": LADO_QUADRANTE / 1000,
            "grade_quadrante": [GRADE_QUADRANTE, GRADE_QUADRANTE],
            "passagens_mes": PASSAGENS_MES,
            "orcamento_militar_pu_mes": ORCAMENTO_MILITAR,
            "orcamento_util_pu_mes": round(orc_util, 1),
            "reserva_falsacor": RESERVA_FALSACOR,
            "pu_indice_celula": round(pu_indice_celula, 2),
            "pu_falsacor_celula": round(pu_fc_celula, 2),
            "pu_mes_celula": round(pu_mes_celula, 1),
            "celulas_por_militar": int(orc_util // pu_mes_celula),
            "area_mg_km2": round(area_total, 1),
            "municipios": [
                {"codigo": cod, "nome": MUNICIPIOS[cod],
                 "area_km2": round(float(
                     (grades[cod].sum(axis=1) * peso).sum()), 1)}
                for cod in sorted(municipios)],
            "nota_resolucao": (
                "Mercator: o pedido de 10 m cai no chão como ~9,4-9,5 m "
                "nesta latitude — erra sempre para mais resolução; a área "
                "dos polígonos é geodésica e não herda a distorção."),
        },
        "totais": {
            "quadrantes": len(lista),
            "celulas_20m": total_celulas,
            "celulas_10m": total_celulas * 4,
            "pu_mes_20m": round(pu_total_20, 1),
            "pu_mes_10m": round(pu_total_10, 1),
            "militares_20m": int(math.ceil(pu_total_20 / orc_util)),
            "militares_10m": int(math.ceil(pu_total_10 / orc_util)),
        },
        "quadrantes": lista,
    }

    os.makedirs(SAIDA, exist_ok=True)
    io.open(os.path.join(SAIDA, "quadrantes.json"), "w", encoding="utf-8").write(
        json.dumps(plano, ensure_ascii=False))

    gj_q = {"type": "FeatureCollection", "features": [{
        "type": "Feature",
        "properties": {"id": q["id"], "n_celulas": q["n_celulas"],
                       "area_mg_km2": q["area_mg_km2"],
                       "municipios": ", ".join(
                           MUNICIPIOS[m] for m in q["municipios"]),
                       "pu_mes": q["res"]["10"]["pu_mes"]},
        "geometry": {"type": "Polygon", "coordinates": [anel4326(q["bbox3857"])]}
    } for q in lista]}
    io.open(os.path.join(SAIDA, "quadrantes.geojson"), "w", encoding="utf-8").write(
        json.dumps(gj_q, ensure_ascii=False))

    gj_c = {"type": "FeatureCollection", "features": [{
        "type": "Feature",
        "properties": {"quadrante": q["id"], "n": c["n"],
                       "cx": c["cx"], "cy": c["cy"],
                       "area_mg_km2": c["area_mg_km2"],
                       "municipios": ", ".join(
                           MUNICIPIOS[m] for m in c["municipios"])},
        "geometry": {"type": "Polygon", "coordinates": [anel4326(c["bbox3857"])]}
    } for q in lista for c in q["celulas"]]}
    io.open(os.path.join(SAIDA, "celulas.geojson"), "w", encoding="utf-8").write(
        json.dumps(gj_c, ensure_ascii=False))

    gj_m = {"type": "FeatureCollection", "features": [{
        "type": "Feature",
        "properties": {"codigo": cod, "nome": MUNICIPIOS[cod]},
        "geometry": municipios[cod]["geo"]
    } for cod in sorted(municipios)]}
    io.open(os.path.join(SAIDA, "municipios.geojson"), "w", encoding="utf-8").write(
        json.dumps(gj_m, ensure_ascii=False))

    print()
    print("quadrantes: %d   células (20 m): %d   células (10 m): %d"
          % (len(lista), total_celulas, total_celulas * 4))
    print("PU/mês dos 9 Municípios — 10 m: %s   20 m: %s"
          % (f"{pu_total_10:,.0f}".replace(",", "."),
             f"{pu_total_20:,.0f}".replace(",", ".")))
    print("militares (%d PU/mês úteis) — 10 m: %d" %
          (orc_util, plano["totais"]["militares_10m"]))
    print()
    print("%-5s %6s %12s %11s %8s  municípios" %
          ("quad", "céls", "área mun km²", "PU/mês 10m", "% orç."))
    for q in lista:
        pu = q["res"]["10"]["pu_mes"]
        print("%-5s %6d %12s %11s %7.0f%%  %s"
              % (q["id"], q["n_celulas"],
                 f"{q['area_mg_km2']:,.0f}".replace(",", "."),
                 f"{pu:,.0f}".replace(",", "."),
                 100 * pu / ORCAMENTO_MILITAR,
                 ", ".join(MUNICIPIOS[m] for m in q["municipios"])))


main()
