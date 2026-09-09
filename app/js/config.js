/* =====================================================================
   Configuração do Monitor dos 9 Municípios — o único arquivo a editar ao
   mudar de ambiente. Mesmo Portal e mesmo app OAuth da Calculadora, do
   monitor das UCs e do estadual; armazenamento e domínio próprios.
   ===================================================================== */
window.CFG = {

  portal: "https://geoprocessamento.bombeiros.mg.gov.br/portal",
  jsapi: "https://geoprocessamento.bombeiros.mg.gov.br/portal/jsapi/jsapi4",

  /* app OAuth registrado no Portal; o redirect deste domínio é
     acrescentado por infra/21_registrar_redirect.py */
  appId: "nRFBQ8adfZIqHm56",

  /* serviço próprio deste monitor — infra/20_criar_camadas_municipios.py
     Item: 3809b06eb45348ffb2ae10f1e3a14312 */
  camadaPoligonos:
    "https://geoprocessamento.bombeiros.mg.gov.br/server/rest/services/Hosted/Monitor_Queimadas_Municipios/FeatureServer/0",
  tabelaControle:
    "https://geoprocessamento.bombeiros.mg.gov.br/server/rest/services/Hosted/Monitor_Queimadas_Municipios/FeatureServer/1",
  tabelaAtribuicoes:
    "https://geoprocessamento.bombeiros.mg.gov.br/server/rest/services/Hosted/Monitor_Queimadas_Municipios/FeatureServer/2",
  tabelaConsolidado:
    "https://geoprocessamento.bombeiros.mg.gov.br/server/rest/services/Hosted/Monitor_Queimadas_Municipios/FeatureServer/3",
  tabelaParametros:
    "https://geoprocessamento.bombeiros.mg.gov.br/server/rest/services/Hosted/Monitor_Queimadas_Municipios/FeatureServer/4",
  tabelaQueimadaClasse:
    "https://geoprocessamento.bombeiros.mg.gov.br/server/rest/services/Hosted/Monitor_Queimadas_Municipios/FeatureServer/5",
  tabelaFatoresEmissao:
    "https://geoprocessamento.bombeiros.mg.gov.br/server/rest/services/Hosted/Monitor_Queimadas_Municipios/FeatureServer/6",
  tabelaLULC:
    "https://geoprocessamento.bombeiros.mg.gov.br/server/rest/services/Hosted/Monitor_Queimadas_Municipios/FeatureServer/7",

  /* ano do mapa de uso do solo usado pelo monitor VIVO (o backfill usa o
     ano do fogo). MapBiomas Col.9 e o desempate Esri terminam em 2023 —
     atualizar quando a Coleção 11 entrar nos tiles. */
  anoLULC: 2023,

  /* monitoramento */
  inicioMonitoramento: "2026-01-01",   // o vivo; o retroativo 2017–2025 é o backfill GEE
  resolucaoPadrao: 10,                 // m — decisão do projeto: municípios pequenos, recorte fino

  /* NUVEM — duas peneiras, em ordem de preço.

     1. nuvemCenaDescartar: o eo:cloud_cover do catálogo é da CENA inteira
        (110×110 km). Serve só para descartar o obviamente inútil.
     2. nuvemRecorteMax: a sonda do SCL mede a nuvem SOBRE A CÉLULA. É
        esta que decide se a passagem entra na cadeia de cálculo — e a
        mesma sonda vira máscara, tirando nuvem, cirrus e sombra do dNBR
        antes da vetorização. */
  nuvemCenaDescartar: 95,              // % da cena — acima disso nem sonda
  nuvemRecorteMax: 30,                 // % do recorte — acima disso, "nublada"
  divisorSonda: 4,                     // sonda do SCL a 1/4 da resolução do índice
  vaoMaximoDias: 30,                   // acima disto a passagem sai marcada para validar

  limiar: 0.10,                        // corte de "queimado" (USGS/UN-SPIDER)

  /* DOIS PISOS DE ÁREA — o desenho que permite mudar de ideia sem
     reprocessar 9 anos de GEE:

     areaMinM2       piso de GRAVAÇÃO. É o mais fino que se pretende ter
                     algum dia: 200 m² = 2 px de 10 m (pixel isolado é
                     descartado; 2 px conexos é o menor objeto aceito).
                     Mudar ESTE exige reprocessar.

     pisoRelatorioM2 piso de LEITURA — o que a consolidação e o painel
                     de fato contam. Como todo polígono guarda area_ha e
                     n_pixels, subir este piso é só um filtro de
                     consulta: reconsolidar o mês (segundos) em vez de
                     reprocessar (horas). Sempre >= areaMinM2.

     Referências para escolher o piso de relatório:
       200 m²  =  2 px · o mais fino gravado
       400 m²  =  4 px · UM pixel nativo de B12/SWIR — abaixo disso o
                  dNBR é reamostragem, não medição
      1000 m²  = 10 px · unidade mínima de mapeamento usual em BA
      2000 m²  = 20 px · o piso original do monitor estadual

     Medido em A2 c17/2017: a cobertura do MapBiomas Fogo fica em 88%
     em QUALQUER piso — descer o corte não recupera área da referência,
     só acrescenta fragmentos de ~310 m² (2 px = 37.901 polígonos contra
     3.583 a 20 px). Por isso vale gravar fino e relatar grosso. */
  areaMinM2: 200,
  pisoRelatorioM2: 200,

  /* teto de polígonos DESENHADOS no mapa por passagem. Não altera o que
     está gravado nem o que a consolidação conta — é só o que o navegador
     aguenta desenhar: uma passagem de quadrante a 10 m pode ter mais de
     100 mil feições. Mostra sempre as MAIORES primeiro, e o painel avisa
     quantas ficaram de fora. */
  maxPoligonosMapa: 4000,

  /* REGENERAÇÃO — a janela do anti-dupla-contagem geométrico: área que já
     queimou só volta a contar como incêndio novo depois deste prazo. Antes
     dele, o que reaparece é recortado (difference) como sobreposição do
     mesmo evento. 365 = um ciclo anual completo, comparável ao MapBiomas
     Fogo, que trata reincidência por ano. */
  regeneracaoDias: 365,
  cotaMensalPU: 10000,
  tetoTrabalhoPU: 9000,                // o motor para aqui e retoma na próxima visita

  fonte: "Sentinel-2 (Copernicus) — dNBR · Monitor de Queimadas — 9 Municípios"
};
