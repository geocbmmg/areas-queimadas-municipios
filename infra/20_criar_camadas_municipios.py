# -*- coding: utf-8 -*-
"""
Cria o serviço do MONITOR DOS 9 Municípios — fork do monitor estadual com
o recorte trocado para os municípios do estudo de área queimada:
BH, Betim, Conceição do Mato Dentro, Congonhas, Contagem, Ipatinga,
São José da Lapa e Timóteo.

Serviço próprio, separado do estadual — armazenamento novo, mesma malha
ancorada e MESMO esquema (o motor é o mesmo):

  · a chave é o par QUADRANTE + CÉLULA (as células daqui coincidem
    fisicamente com as do estadual; só as letras mudam);
  · o recorte é gravado em EPSG:3857, que é a malha do plano;
  · o controle guarda a BASE de cálculo (data_ref/cena_ref_id): o dNBR de
    cada passagem é medido contra a anterior VIÁVEL da mesma célula, e
    saber qual foi é o que permite auditar a área depois;
  · a consolidação mensal ganha o recorte por MUNICÍPIO (a repartição é
    geométrica, pelo limite do IBGE em app/dados/municipios.geojson).

Camada 0  Queimadas por passagem  (polígonos)
Tabela 1  Controle de passagens   (com anexos: falsa cor, SCL, cor verdadeira)
Tabela 2  Atribuicoes             (quem assumiu cada quadrante)
Tabela 3  Consolidado mensal      (competência × recorte: estado/quadrante/classe/uc/za)
Tabela 4  Parametros de biomassa  (classe MapBiomas → B e C; editável no Portal)
Tabela 5  Queimada por classe     (detalhamento A×B×C por polígono, 1:N)
Tabela 6  Fatores de emissao      (EF_i — esquema pronto, valores do usuário)

O script é idempotente: cria o que falta (serviço, camadas, tabelas, CAMPOS
novos em camadas existentes, domínio, sementes) e não toca no que existe.
"""
import sys, io, urllib3

urllib3.disable_warnings()
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

CRED = r"C:\Users\m1590850\OneDrive\Área de Trabalho\Projetos do Claude\focos-calor-mg\credenciais_portal.txt"
NOME = "Monitor_Queimadas_Municipios"
TITULO = "Monitor de Queimadas — 9 Municípios"

SR = {"wkid": 4326, "latestWkid": 4326}
EXTENT = {"xmin": -44.4, "ymin": -20.7, "xmax": -42.3, "ymax": -18.6,
          "spatialReference": SR}


def campo(nome, tipo, alias, **kw):
    c = {"name": nome, "type": "esriFieldType" + tipo, "alias": alias,
         "nullable": True, "editable": True, "domain": None, "defaultValue": None}
    c.update(kw)
    return c


OID = campo("objectid", "OID", "OBJECTID", nullable=False, editable=False)
GLOBALID = campo("globalid", "GlobalID", "GlobalID", nullable=False,
                 editable=False, length=38)

# ------------------------------------------------------------ comuns
def chave():
    return [
        campo("quad_id", "String", "Quadrante", length=16),
        campo("celula", "Integer", "Célula"),
        campo("res_m", "SmallInteger", "Resolução (m)"),
        campo("data_pass", "Date", "Data da passagem", length=8),
        campo("data_ref", "Date", "Data da base de cálculo", length=8),
    ]


CAMPOS_POLI = [OID] + chave() + [
    campo("competencia", "String", "Competência (AAAA-MM)", length=7),
    campo("area_ha", "Double", "Área (ha)"),
    # nº de pixels do componente detectado (antes do recorte de
    # regeneração). É o que permite REFILTRAR a série por tamanho sem
    # reprocessar: o piso de relatório vira um WHERE, não uma rodada.
    campo("n_pixels", "Integer", "Pixels do componente"),
    # MUNICÍPIO atribuído na GRAVAÇÃO, não na leitura. A consolidação
    # vira um groupBy no servidor; cruzar geometria de milhões de
    # polígonos no navegador a cada fechamento de mês não escala.
    # `municipio` = onde caiu a maior parte da área; `mun_fracao` = que
    # fatia dela ficou nesse município (1 = o polígono inteiro).
    campo("municipio", "String", "Município (IBGE)", length=7),
    campo("mun_nome", "String", "Município", length=60),
    campo("mun_fracao", "Double", "Fração da área no município"),
    campo("dnbr_med", "Double", "dNBR médio"),
    campo("status", "String", "Situação", length=30),
    campo("classe_uso", "SmallInteger", "Classe de uso do solo (dominante)"),
    campo("biomassa_t", "Double", "Biomassa consumida (t)"),
    campo("cena_id", "String", "Cena Sentinel-2", length=120),
    campo("cena_ref_id", "String", "Cena da base", length=120),
    campo("metodo", "String", "Método", length=120),
    campo("processado_por", "String", "Processado por", length=100),
    GLOBALID,
]

CAMPOS_CTRL = [OID] + chave() + [
    campo("competencia", "String", "Competência (AAAA-MM)", length=7),
    campo("cena_id", "String", "Cena Sentinel-2", length=120),
    campo("cena_ref_id", "String", "Cena da base", length=120),
    campo("total_celulas", "Integer", "Células do quadrante"),
    campo("status_proc", "String", "Estado", length=20),
    campo("nuvem_pct", "Double", "Nuvem da cena (%)"),
    campo("nuvem_rec", "Double", "Nuvem no recorte (%)"),
    campo("nuvem_rec_det", "String", "Nuvem no recorte (detalhe)", length=120),
    campo("area_ha", "Double", "Área (ha)"),
    campo("n_poligonos", "Integer", "Polígonos"),
    campo("pu_gasto", "Double", "PU gastos"),
    campo("bbox_3857", "String", "Recorte (EPSG:3857)", length=120),
    campo("bbox_4326", "String", "Recorte (lon/lat)", length=120),
    campo("motivo", "String", "Motivo / observação", length=250),
    campo("processado_por", "String", "Processado por", length=100),
    GLOBALID,
]

CAMPOS_ATRIB = [OID,
                campo("quad_id", "String", "Quadrante", length=16),
                campo("usuario", "String", "Responsável (login)", length=100),
                GLOBALID]

# ------------------------------------------------------------ tabelas novas
CAMPOS_CONSOL = [OID,
    campo("competencia", "String", "Competência (AAAA-MM)", length=7),
    campo("tipo_recorte", "String", "Tipo de recorte", length=12),
    campo("recorte_id", "String", "Recorte (id)", length=24),
    campo("recorte_nome", "String", "Recorte (nome)", length=200),
    campo("area_ha", "Double", "Área (ha)"),
    campo("n_poligonos", "Integer", "Polígonos"),
    campo("biomassa_t", "Double", "Biomassa consumida (t)"),
    campo("massa_t", "Double", "Massa emitida (t) — linhas de emissão"),
    campo("celulas_fechadas", "Integer", "Células fechadas"),
    campo("celulas_total", "Integer", "Células no total"),
    # piso de área que produziu ESTA linha — o mesmo mês reconsolidado
    # com outro piso gera outro número, e sem isto seriam indistinguíveis
    campo("piso_m2", "Integer", "Piso de relatório (m²)"),
    campo("gerado_em", "Date", "Gerado em", length=8),
    campo("gerado_por", "String", "Gerado por", length=100),
    GLOBALID]

CAMPOS_PARAM = [OID,
    campo("classe_id", "SmallInteger", "Classe MapBiomas (código)"),
    campo("classe_nome", "String", "Classe", length=120),
    campo("b_t_ha", "Double", "B — biomassa disponível (t MS/ha)"),
    campo("c_fracao", "Double", "C — fração consumida (0–1)"),
    campo("fonte", "String", "Fonte", length=250),
    campo("obs", "String", "Observações", length=250),
    GLOBALID]

# O DADO BRUTO do projeto mora aqui: quantos hectares de cada classe de
# uso do solo queimaram, em cada polígono, em cada passagem.
#
# Biomassa e emissões NÃO são gravadas: são derivadas na leitura, a
# partir desta área e das tabelas de parâmetros (B, C e EF), que o
# usuário edita. Assim, trocar a metodologia — outra carga de
# combustível, outra fração consumida, outro fator de emissão — é
# reconsolidar o mês em segundos, não reprocessar anos de Earth Engine.
CAMPOS_QXC = [OID,
    campo("poligono_gid", "String", "GlobalID do polígono", length=38),
    campo("competencia", "String", "Competência (AAAA-MM)", length=7),
    campo("quad_id", "String", "Quadrante", length=16),
    campo("celula", "Integer", "Célula"),
    campo("res_m", "SmallInteger", "Resolução (m)"),
    campo("data_pass", "Date", "Data da passagem", length=8),
    campo("classe_id", "SmallInteger", "Classe MapBiomas (código)"),
    campo("area_ha", "Double", "Área (ha) desta classe — DADO BRUTO"),
    campo("n_pixels_classe", "Integer", "Pixels desta classe — DADO BRUTO"),
    campo("municipio", "String", "Município (IBGE)", length=7),
    # pixels do polígono PAI — repetido aqui para o piso de relatório
    # filtrar as duas tabelas pelo mesmo critério (o area_ha desta tabela
    # é a fatia da classe, não o tamanho do polígono)
    campo("n_pixels", "Integer", "Pixels do polígono"),
    # LEGADO: mantido para não quebrar linhas antigas. O motor não grava
    # mais — biomassa é sempre derivada dos parâmetros na leitura.
    campo("biomassa_t", "Double", "(legado — biomassa é derivada)"),
    GLOBALID]

CAMPOS_EF = [OID,
    campo("poluente", "String", "Poluente", length=40),
    campo("classe_id", "SmallInteger", "Classe MapBiomas (nulo = todas)"),
    campo("ef_g_kg", "Double", "EF (g/kg de biomassa seca)"),
    campo("fonte", "String", "Fonte", length=250),
    campo("obs", "String", "Observações", length=250),
    GLOBALID]

# Tiles de uso do solo por célula (10 m), com o PNG em tons de cinza
# (valor do pixel = código MapBiomas, mosaico já resolvido pelo desempate
# Esri) como ANEXO da linha. A chave é o bbox 3857 da célula-filha — o
# mesmo formato gravado no controle — mais o ano do mapa.
CAMPOS_LULC = [OID,
    campo("bbox_3857", "String", "Recorte (EPSG:3857)", length=120),
    campo("res_m", "SmallInteger", "Resolução (m)"),
    campo("ano", "SmallInteger", "Ano do mapa"),
    campo("fonte", "String", "Fonte", length=250),
    campo("pixels_desempate", "Integer", "Pixels resolvidos p/ desempate"),
    campo("gerado_em", "Date", "Gerado em", length=8),
    GLOBALID]

# Estados possíveis do controle — vira domínio no serviço para ninguém
# inventar um sétimo estado por engano (o motor JS usa as mesmas strings).
DOMINIO_STATUS = {
    "type": "codedValue", "name": "status_proc_dom",
    "codedValues": [{"name": v, "code": v} for v in
                    ["base", "calculada", "sem_area", "nublada",
                     "erro", "ignorada"]]
}

# Sementes da tabela de FATORES DE EMISSÃO — valores VERIFICADOS nas
# fontes primárias (Andreae 2019, ACP 19:8523-8564, Tabela 1 via XLSX
# oficial; Akagi et al. 2011, ACP 11:4039-4072, Tabela 1 p.4045-4046).
# g de poluente por kg de matéria seca queimada. PROVISÓRIOS até o
# usuário fornecer os EF oficiais do projeto. Só há linha onde a fonte
# publica valor para a categoria — nada estimado.
#   classes savânicas/campestres (4,11,12,21,29) -> savanna/grassland
#   formação florestal (3)                       -> tropical forest
#   pastagem (15) -> pasture maintenance (Akagi; o mais representativo
#                    para queima de pasto no Brasil tropical)
#   lavouras/resíduos (19,20,36,39,40,41,46,48,62) -> agricultural
#                    residues open (Andreae); cana pode refinar com
#                    França et al. 2012
#   silvicultura (9) -> tropical forest como análogo (sem EF publicado
#                    para eucalipto; alternativa temperate 18,5)
_SAV = [4, 11, 12, 21, 29]
_AGR = [19, 20, 36, 39, 40, 41, 46, 48, 62]
_A19 = "Andreae 2019 (ACP 19:8523-8564, Tab. 1)"
_AK11 = "Akagi et al. 2011 (ACP 11:4039-4072, Tab. 1)"
_PROV = "PROVISÓRIO — substituir pelos EF oficiais do projeto"

SEMENTES_EF = (
    [("PM2.5", c, 6.7, _A19 + " — savanna/grassland, SD 3,3 (N=20)", _PROV)
     for c in _SAV] +
    [("PM2.5", 3, 8.3, _A19 + " — tropical forest, SD 3,3 (N=9)", _PROV),
     ("PM2.5", 9, 8.3, _A19 + " — tropical forest (análogo p/ silvicultura)",
      _PROV + "; sem EF publicado p/ eucalipto (temperate seria 18,5)"),
     ("PM2.5", 15, 14.8, _AK11 + " — pasture maintenance, var. nat. 6,7",
      _PROV)] +
    [("PM2.5", c, 8.2, _A19 + " — agricultural residues open, SD 4,4 (N=18)",
      _PROV + ("; cana: refinar com França et al. 2012" if c == 20 else ""))
     for c in _AGR] +
    [("PM10", 3, 18.5, _AK11 + " — tropical forest, var. nat. 4,1", _PROV),
     ("PM10", 15, 28.9, _AK11 + " — pasture maintenance, var. nat. 13,0",
      _PROV + "; únicas categorias com PM10 publicado nas duas fontes")] +
    [("TPM", c, 8.7, _A19 + " — savanna/grassland, SD 3,1 (N=11)", _PROV)
     for c in _SAV] +
    [("TPM", 3, 10.9, _A19 + " — tropical forest, SD 5,3 (N=4)", _PROV)] +
    [("TPM", c, 12.9, _A19 + " — agricultural residues open, SD 7,2 (N=7)",
      _PROV) for c in _AGR] +
    [("CO", c, 69.0, _A19 + " — savanna/grassland, SD 20 (N=50)", _PROV)
     for c in _SAV] +
    [("CO", 3, 104.0, _A19 + " — tropical forest, SD 39 (N=16)", _PROV),
     ("CO", 15, 135.0, _AK11 + " — pasture maintenance, var. nat. 38", _PROV),
     ("CO2", 15, 1548.0, _AK11 + " — pasture maintenance, var. nat. 142",
      _PROV + "; IPCC trata CO2 de pastagem como neutro (rebrota)")] +
    [("CO", c, 76.0, _A19 + " — agricultural residues open, SD 55 (N=39)",
      _PROV) for c in _AGR] +
    [("CO2", c, 1660.0, _A19 + " — savanna/grassland, SD 90 (N=31)",
      _PROV + "; IPCC trata CO2 de campo/pasto/lavoura como neutro (rebrota)")
     for c in _SAV] +
    [("CO2", 3, 1620.0, _A19 + " — tropical forest, SD 70 (N=9)", _PROV)] +
    [("CO2", c, 1430.0, _A19 + " — agricultural residues open, SD 230 (N=29)",
      _PROV) for c in _AGR]
)

# Sementes da tabela de parâmetros B×C (plano/REFORMULACAO.md §3.3).
# Valores centrais de meio/fim da estação seca; a tabela é EDITÁVEL no
# Portal — linhas marcadas PROVISÓRIO pedem revisão antes do relatório.
SEMENTES_BC = [
    (3,  "Formação Florestal", 8, 0.45,
     "Fogo de sub-bosque — literatura tropical; IPCC 2006 Vol.4 Cap.2",
     "faixa B 5-12 t/ha; NUNCA usar corte-e-queima (~120 t/ha, superestima ~10x)"),
    (4,  "Formação Savânica", 10, 0.75,
     "Kauffman et al. 1994 (cerrado s.s. 10,03 t/ha; C 0,72-0,84); IPCC Tab. 2.6",
     "faixa B 8-13 t/ha"),
    (9,  "Silvicultura", 15, 0.60,
     "IPCC 2006 Tabs. 2.4/2.6 (eucalipto, base australiana)",
     "maior incerteza da tabela (SD >= 100%); faixa B 4-25 t/ha"),
    (11, "Campo Alagado e Área Pantanosa", 7, 0.90,
     "Analogia com formação campestre — PROVISÓRIO",
     "sem medição publicada para o caso"),
    (12, "Formação Campestre", 7, 0.90,
     "Kauffman et al. 1994; Castro & Kauffman 1998 (medições no Brasil)",
     "faixa B 4,9-12,9 t/ha (campo limpo/campo sujo)"),
    (15, "Pastagem", 5, 0.95,
     "Kauffman et al. 1998; IPCC 2006 grassland tropical",
     "NÃO usar 'tropical pasture' do IPCC (23,7 t/ha — pasto amazônico com madeira residual)"),
    (19, "Lavoura Temporária (resíduo)", 8, 0.80,
     "IPCC 2006 Tab. 2.4, resíduos agrícolas (5,5-10 t/ha) — PROVISÓRIO",
     "recebe o desempate 'crops' do Esri 10 m; revisar por cultura"),
    (20, "Cana-de-açúcar", 13, 0.85,
     "van Leeuwen et al. 2014 (FC Brasil ~20 t/ha); IPCC 2006; França et al. 2012",
     "default IPCC de 6,5 t/ha é baixo para a produtividade brasileira"),
    (21, "Mosaico de Usos", 5, 0.95,
     "Análogo de pastagem (dominância) — PROVISÓRIO",
     "só usado se o desempate Esri 10 m estiver indisponível no tile"),
    (23, "Praia, Duna e Areal", 0, 0, "não vegetado", ""),
    (24, "Área Urbanizada", 0, 0, "não vegetado", ""),
    (25, "Outras Áreas não Vegetadas", 0, 0, "não vegetado", ""),
    (29, "Afloramento Rochoso / campo rupestre", 6, 0.90,
     "Analogia campo limpo (Kauffman 1994); Fidelis et al. (campos brasileiros)",
     "Espinhaço: solos rasos — usar metade inferior da faixa em fogo frequente"),
    (30, "Mineração", 0, 0, "não vegetado", ""),
    (33, "Rio, Lago e Oceano", 0, 0, "não vegetado", ""),
    (36, "Lavoura Perene (café/citrus/outras)", 5, 0.50,
     "Sem medição publicada — PROVISÓRIO",
     "fogo de serapilheira/sub-copa"),
    (39, "Soja (resíduo)", 8, 0.80,
     "IPCC 2006 Tab. 2.4, resíduos agrícolas — PROVISÓRIO", ""),
    (40, "Arroz (resíduo)", 8, 0.80,
     "IPCC 2006 Tab. 2.4, resíduos agrícolas — PROVISÓRIO", ""),
    (41, "Outras Lavouras Temporárias (resíduo)", 8, 0.80,
     "IPCC 2006 Tab. 2.4, resíduos agrícolas — PROVISÓRIO", ""),
    (46, "Café", 5, 0.50,
     "Sem medição publicada — PROVISÓRIO", "fogo de serapilheira/sub-copa"),
    (48, "Outras Lavouras Perenes", 5, 0.50,
     "Sem medição publicada — PROVISÓRIO", ""),
    (62, "Algodão (resíduo)", 8, 0.80,
     "IPCC 2006 Tab. 2.4, resíduos agrícolas — PROVISÓRIO", ""),
]

EDITOR = {
    "enabled": True, "allowOthersToUpdate": True, "allowOthersToDelete": True,
    "allowOthersToQuery": True, "allowAnonymousToUpdate": False,
    "allowAnonymousToDelete": False
}


def camada(nome, tipo, campos, geometria=None, anexos=False):
    d = {
        "name": nome, "type": tipo,
        "objectIdField": "objectid", "globalIdField": "globalid",
        "fields": campos, "hasAttachments": anexos,
        "capabilities": "Create,Delete,Query,Update,Editing,Sync",
        "editorTrackingInfo": EDITOR,
        "supportsApplyEditsWithGlobalIds": False,
        "allowGeometryUpdates": True,
    }
    if geometria:
        d.update({"geometryType": geometria, "extent": EXTENT,
                  "hasZ": False, "hasM": False,
                  "drawingInfo": {"renderer": {
                      "type": "uniqueValue", "field1": "status",
                      "defaultSymbol": {"type": "esriSFS", "style": "esriSFSSolid",
                                        "color": [217, 60, 35, 110],
                                        "outline": {"type": "esriSLS", "style": "esriSLSSolid",
                                                    "color": [255, 210, 40, 255], "width": 1}},
                      "defaultLabel": "Queimada",
                      "uniqueValueInfos": [{
                          "value": "Queima prescrita", "label": "Queima prescrita",
                          "symbol": {"type": "esriSFS", "style": "esriSFSSolid",
                                     "color": [60, 120, 216, 110],
                                     "outline": {"type": "esriSLS", "style": "esriSLSSolid",
                                                 "color": [20, 60, 130, 255], "width": 1}}}]}}})
    return d


def main():
    cfg = {}
    for line in open(CRED, encoding="utf-8-sig"):
        if "=" in line:
            k, v = line.strip().split("=", 1)
            cfg[k.strip().lower()] = v.strip()

    from arcgis.gis import GIS
    from arcgis.features import FeatureLayerCollection

    gis = GIS(cfg["portal"], cfg["usuario"], cfg["senha"], verify_cert=False)
    print("conectado:", gis.users.me.username)

    achados = gis.content.search('title:"%s"' % TITULO, item_type="Feature Layer")
    achados = [a for a in achados if a.title == TITULO]
    if achados:
        item = achados[0]
        print("[JA EXISTE]", item.id)
    else:
        item = gis.content.create_service(
            name=NOME, has_static_data=False, create_params={
                "name": NOME,
                "serviceDescription": (
                    "Área queimada por passagem do Sentinel-2 nos 8 "
                    "municípios do estudo (BH, Betim, CMD, Congonhas, "
                    "Contagem, Ipatinga, S.J. da Lapa, Timóteo), com "
                    "biomassa consumida e emissões. CBMMG — CEB."),
                "hasStaticData": False, "maxRecordCount": 4000,
                "supportedQueryFormats": "JSON",
                "capabilities": "Create,Delete,Query,Update,Editing,Sync",
                "spatialReference": SR, "initialExtent": EXTENT,
                "allowGeometryUpdates": True, "units": "esriDecimalDegrees",
                "xssPreventionInfo": {"xssPreventionEnabled": True,
                                      "xssPreventionRule": "InputOnly",
                                      "xssInputRule": "rejectInvalid"},
            })
        item.update(item_properties={
            "title": TITULO,
            "snippet": "Queimadas, biomassa e emissões — 9 Municípios do estudo (CBMMG/CEB)",
            "tags": "CBMMG,queimadas,Sentinel-2,dNBR,emissões,municípios,MG",
        })
        print("[CRIADO]", item.id)

    flc = FeatureLayerCollection.fromitem(item)
    tem_cam = [l.properties.name for l in item.layers]
    tem_tab = [t.properties.name for t in item.tables]
    print("camadas:", tem_cam, "tabelas:", tem_tab)

    add = {"layers": [], "tables": []}
    if "Queimadas por passagem" not in tem_cam:
        add["layers"].append(camada("Queimadas por passagem", "Feature Layer",
                                    CAMPOS_POLI, "esriGeometryPolygon"))
    if "Controle de passagens" not in tem_tab:
        add["tables"].append(camada("Controle de passagens", "Table",
                                    CAMPOS_CTRL, anexos=True))
    if "Atribuicoes" not in tem_tab:
        add["tables"].append(camada("Atribuicoes", "Table", CAMPOS_ATRIB))
    if "Consolidado mensal" not in tem_tab:
        add["tables"].append(camada("Consolidado mensal", "Table", CAMPOS_CONSOL))
    if "Parametros de biomassa" not in tem_tab:
        add["tables"].append(camada("Parametros de biomassa", "Table", CAMPOS_PARAM))
    if "Queimada por classe" not in tem_tab:
        add["tables"].append(camada("Queimada por classe", "Table", CAMPOS_QXC))
    if "Fatores de emissao" not in tem_tab:
        add["tables"].append(camada("Fatores de emissao", "Table", CAMPOS_EF))
    if "LULC por celula" not in tem_tab:
        add["tables"].append(camada("LULC por celula", "Table", CAMPOS_LULC,
                                    anexos=True))

    if add["layers"] or add["tables"]:
        print("add_to_definition:", flc.manager.add_to_definition(add))
    else:
        print("nada a acrescentar (camadas/tabelas)")

    # ---------------- campos novos em camadas que já existiam ----------------
    item = gis.content.get(item.id)
    por_nome = {}
    for l in item.layers:
        por_nome[l.properties.name] = l
    for t in item.tables:
        por_nome[t.properties.name] = t

    def garantir_campos(nome, desejados):
        alvo = por_nome[nome]
        atuais = set(f["name"].lower() for f in alvo.properties.fields)
        faltam = [c for c in desejados
                  if c["name"].lower() not in atuais
                  and c["type"] not in ("esriFieldTypeOID",
                                        "esriFieldTypeGlobalID")]
        if faltam:
            r = alvo.manager.add_to_definition({"fields": faltam})
            print(" ", nome, "+", [c["name"] for c in faltam], r)
        else:
            print(" ", nome, "— campos ok")

    print("\ncampos:")
    garantir_campos("Queimadas por passagem", CAMPOS_POLI)
    garantir_campos("Controle de passagens", CAMPOS_CTRL)
    garantir_campos("Consolidado mensal", CAMPOS_CONSOL)
    garantir_campos("Queimada por classe", CAMPOS_QXC)

    # ---------------- domínio de status_proc ----------------
    ctrl = por_nome["Controle de passagens"]
    campo_st = [f for f in ctrl.properties.fields if f["name"] == "status_proc"]
    if campo_st and not campo_st[0].get("domain"):
        try:
            r = ctrl.manager.update_definition({"fields": [{
                "name": "status_proc", "type": "esriFieldTypeString",
                "alias": "Estado", "length": 20, "nullable": True,
                "editable": True, "domain": DOMINIO_STATUS}]})
            print("dominio status_proc:", r)
        except Exception as e:
            print("[AVISO] dominio nao aplicado (nao bloqueia):", e)
    else:
        print("dominio status_proc: ok")

    # ---------------- sementes da tabela de parâmetros ----------------
    par = por_nome["Parametros de biomassa"]
    n = par.query(where="1=1", return_count_only=True)
    if n:
        print("parametros B x C: ja semeados (%d linhas — nao mexo)" % n)
    else:
        adds2 = [{"attributes": {
            "classe_id": c, "classe_nome": nome, "b_t_ha": b, "c_fracao": cc,
            "fonte": fonte, "obs": obs}}
            for c, nome, b, cc, fonte, obs in SEMENTES_BC]
        r = par.edit_features(adds=adds2)
        ok = sum(1 for x in r["addResults"] if x.get("success"))
        print("parametros B x C: semeadas %d/%d linhas" % (ok, len(adds2)))

    # ---------------- sementes dos fatores de emissão ----------------
    ef = por_nome["Fatores de emissao"]
    nef = ef.query(where="1=1", return_count_only=True)
    if nef:
        print("fatores de emissao: ja semeados (%d linhas — nao mexo)" % nef)
    else:
        adds3 = [{"attributes": {
            "poluente": pol, "classe_id": cid, "ef_g_kg": v,
            "fonte": fonte, "obs": obs}}
            for pol, cid, v, fonte, obs in SEMENTES_EF]
        r = ef.edit_features(adds=adds3)
        ok = sum(1 for x in r["addResults"] if x.get("success"))
        print("fatores de emissao: semeadas %d/%d linhas" % (ok, len(adds3)))

    item = gis.content.get(item.id)
    print("\nitem:", item.id)
    for l in item.layers:
        print("  camada", l.properties.id, l.properties.name, "\n   ", l.url)
    for t in item.tables:
        print("  tabela", t.properties.id, t.properties.name, "\n   ", t.url)


main()
