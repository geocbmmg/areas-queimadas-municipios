# Monitor de Queimadas — 9 Municípios
## Documentação técnica: fontes, forma de cálculo, scripts e armazenamento

> Fork do monitor estadual (`monitor-queimadas-mg`) com o recorte trocado
> para os 9 Municípios do estudo de área queimada 2015–2024, e com o
> objetivo final de **estimar as emissões atmosféricas** (particulados em
> primeiro lugar) dos incêndios detectados:
>
> **E_i = A × B × C × EF_i**
>
> área queimada → biomassa disponível → biomassa consumida → fator de
> emissão → massa de poluente emitida (IPCC 2006, Vol. 4, Cap. 2, Eq. 2.27).

Última revisão: 2026-09-02.

---

## 1. Os municípios

| Município | Código IBGE | Área (km²) |
|---|---|---|
| Belo Horizonte | 3106200 | 333 |
| Betim | 3106705 | 346 |
| Conceição do Mato Dentro | 3117504 | 1.729 |
| Congonhas | 3118007 | 306 |
| Contagem | 3118601 | 196 |
| Ipatinga | 3131307 | 166 |
| Paracatu | 3147006 | 8.229 |
| São José da Lapa | 3162955 | 48 |
| Timóteo | 3168705 | 145 |
| **Total** | | **≈ 11.498** |

Paracatu entrou depois dos oito primeiros e **mais que triplicou a área
monitorada** — sozinho é 2,5× a soma dos outros oito. Daí a malha ter
saltado de 52 para 92 células de 10 m.

Atenção histórica: três códigos têm homônimos traiçoeiros — Conceição do
Pará (3117603), Congonhas do Norte (3118106) e Teófilo Otoni (3168606)
já entraram errados numa exportação do estudo. Os códigos acima foram
conferidos na base de municípios do IBGE.

---

## 2. Forma de cálculo

### 2.1 Área queimada (A)

- **Índice:** dNBR = NBR(base) − NBR(passagem), com NBR = (B08 − B12) /
  (B08 + B12), bandas do Sentinel-2 L2A. Corte de "queimado" em
  dNBR ≥ 0,10 (USGS/UN-SPIDER).
- **Dois pisos de área — gravar fino, relatar no corte que se quiser.**
  É o desenho que permite mudar de critério **sem reprocessar** os 9 anos:

  | Parâmetro | Papel | Valor |
  |---|---|---|
  | `areaMinM2` | piso de **gravação** — o mais fino que existirá no banco | **200 m² = 2 px** (pixel isolado é descartado) |
  | `pisoRelatorioM2` | piso de **leitura** — o que a consolidação conta | **200 m²** (ajustável) |

  Todo polígono guarda `area_ha` **e `n_pixels`** (e a tabela de classes
  repete o `n_pixels` do polígono-pai), então subir o piso de relatório é
  um `WHERE n_pixels >= K` — **reconsolidar o mês leva segundos**, contra
  horas de reprocessamento no GEE. Cada linha do consolidado grava o
  `piso_m2` que a produziu, para dois cortes do mesmo mês nunca serem
  confundidos. O filtro é aplicado em **pixels** (inteiro exato) e não em
  área, porque na tabela de classes o `area_ha` é a fatia da classe
  dentro do polígono, não o tamanho do polígono.

  Referências para escolher o piso de relatório: **200 m²** (2 px, o mais
  fino gravado) · **400 m²** (4 px = *um pixel nativo de B12/SWIR* — o
  B08 é 10 m mas o B12, que enxerga a cicatriz, é 20 m; abaixo disso o
  dNBR é reamostragem, não medição) · **1.000 m²** (unidade mínima de
  mapeamento usual) · **2.000 m²** (piso do monitor estadual).

  Medido em A2 c17/2017: a cobertura do MapBiomas Fogo fica em **88% em
  qualquer piso** — descer o corte não recupera área da referência, só
  acrescenta fragmentos de ~310 m² (2 px = 37.901 polígonos contra 3.583
  a 20 px, +958% de polígonos para +28% de área).

- **Teto do vetorizador: 20.000 componentes por passagem.** Com o piso de
  2 px as passagens de pico passam de 5.000 (o teto antigo), e um teto
  baixo faria o LIMITE governar no lugar do piso justamente nos meses de
  fogo. Truncamento, quando ocorre, sai marcado no `motivo` do controle.
- **Resolução:** 10 m (decisão do projeto — municípios pequenos, recorte
  urbano/periurbano). Células de 25 × 25 km (2.500 px, o teto da Process
  API), malha em EPSG:3857 ancorada em múltiplos do lado do quadrante a
  partir da origem — cada célula daqui coincide fisicamente com ¼ de
  célula do monitor estadual.
- **A cadeia da base:** a primeira passagem viável de cada célula NÃO
  produz área — ela é a base; da segunda em diante, cada passagem é
  medida contra a ANTERIOR VIÁVEL da mesma célula. Viabilidade decidida
  por sonda do SCL sobre o recorte (corte em 30% de nuvem no recorte,
  nunca pelo eo:cloud_cover da cena); a mesma sonda vira máscara e apaga
  nuvem, cirrus e sombra do dNBR antes da vetorização.
- **Anti-dupla-contagem (2 camadas):** (i) a cadeia temporal acima;
  (ii) a REDE GEOMÉTRICA — cada polígono novo é recortado (difference)
  contra tudo que já queimou na mesma célula dentro da janela de
  regeneração (`regeneracaoDias`, padrão 365). Vencido o prazo, a
  reincidência volta a contar. O motor ainda re-ancora a base no controle
  antes de cada dNBR e reabre em cascata passagens que dependiam de dias
  reprocessados — as invariantes estão documentadas em
  `monitor-queimadas-mg/plano/REFORMULACAO.md` (fases F1–F2).
- **Área:** geodésica (geometryEngine, lon/lat) — não herda a distorção
  do Mercator (~6% nesta latitude).
- **Mês (competência):** o mês da DETECÇÃO — o `data_pass` da passagem
  que viu a cicatriz. Regra única e auditável; vão longo (> 30 dias até
  a base) sai marcado para validação na estação.
- **Repartição municipal:** interseção geométrica dos polígonos com os
  limites do IBGE — incêndio na divisa é repartido pela divisa, com área
  geodésica por parte. O que o motor calcula nas células mas cai fora
  dos 8 limites vira a linha "FORA" do consolidado (transparência).

### 2.2 Biomassa consumida (M = A × B × C)

- O uso do solo de cada pixel queimado vem do **tile LULC da célula**
  (MapBiomas 30 m do ano do fogo, reamostrado por vizinho-mais-próximo
  na grade da célula), com **desempate do Mosaico de Usos** pela
  classificação Esri/Impact Observatory Sentinel-2 10 m do mesmo ano
  (`crops` → lavoura temporária, `rangeland` → pastagem, `trees` →
  formação florestal). Resultado: nenhuma classe genérica na
  contabilidade (~0,3% residual).
- A_classe = area_ha do polígono × fração de pixels da classe.

> **O banco guarda o dado bruto, não o resultado.** A tabela "Queimada
> por classe" grava apenas `(cid, a_c, npx_c)` — classe, área em hectares
> e contagem de pixels. **B**, **C** e os fatores de emissão **não** são
> gravados em lugar nenhum junto do polígono: são aplicados na leitura,
> a partir das tabelas de parâmetros. Trocar um valor de B, C ou EF muda
> todo o histórico na hora, sem reprocessar imagem alguma.
>
> Foi por isso que `biomassa_t` no polígono virou **campo legado**: ele
> congelava uma parametrização dentro do dado. Continua na tabela por
> compatibilidade, mas não é escrito nem lido pelo painel.

- M_classe = A_classe × B_classe × C_classe, com **B** (t MS/ha) e **C**
  (fração consumida, 0–1) da tabela "Parametros de biomassa" do serviço
  (22 classes semeadas com fontes — ver §3.5), **derivado na leitura**
  por `consolida.js:biomassaDe()`.
- A coluna **B×C** da tela de metodologia é o que interessa na prática:
  quantas toneladas de matéria seca saem de cada hectare queimado
  daquela classe.

### 2.3 Emissões (E_i = M × EF_i)

- EF_i em g de poluente por kg de matéria seca queimada, da tabela
  "Fatores de emissao" do serviço (66 linhas semeadas — ver §3.6;
  valores PROVISÓRIOS até os fatores oficiais do projeto serem
  fornecidos).
- A tabela cobre os dois objetivos do trabalho: **qualidade do ar**
  (PM2.5, PM10, TPM, CO) e **gases de efeito estufa** (CO₂, CH₄, N₂O).
  Uma linha **sem classe** vale como padrão para as classes que não
  tiverem valor próprio.
- E_i por município/mês = Σ (M_classe × EF_i), também derivado na
  leitura — nunca gravado.

### 2.3.1 Tela de metodologia

O botão **Metodologia** no topo do painel abre as duas tabelas
editáveis (B/C e EF). Salvar **não reprocessa nada**: os valores passam
a valer imediatamente no painel e na próxima consolidação. É o ponto
único onde a metodologia se adapta à fonte que for adotada.

Ao clicar num polígono, o detalhe mostra a **conta aberta** por classe —
área → B×C → biomassa → emissões — para que o número possa ser
conferido à mão.
- Nota IPCC: para campo, pastagem e lavoura o CO₂ é tratado como neutro
  (a rebrota anual compensa) — reportam-se os gases e particulados
  não-CO₂; o CO₂ fica como referência.

### 2.4 Consolidação mensal

Botão "Consolidar mês" no painel → apaga e regrava as linhas da
competência na tabela "Consolidado mensal" (idempotente — sempre reflete
o estado atual, inclusive após curadoria). Recortes: `municipios` (soma
dos 8), `municipio` (um por município), `fora`, `quadrante`.
Completude verificada CONTRA O CATÁLOGO (célula fechada = nenhum dia do
mês pendente); sem Copernicus conectado a completude sai como "não
verificada".

---

## 3. Fontes de dados (com links de acesso)

### 3.1 Imagens de satélite — Sentinel-2 (Copernicus)

- **Produto:** Sentinel-2 L2A (reflectância de superfície + banda SCL de
  classificação de cena). Bandas usadas: B08 (NIR, 10 m), B12 (SWIR2,
  20 m), SCL (20 m). Arquivo reprocessado (Collection-1, baseline N0500)
  disponível sobre MG desde dez/2015; série homogênea de 5 dias a partir
  de mar/2017 (S2A+S2B).
- **Acesso (monitor vivo):** Copernicus Data Space Ecosystem —
  catálogo STAC `https://catalogue.dataspace.copernicus.eu/stac`
  (consulta grátis) e Process API
  `https://sh.dataspace.copernicus.eu/api/v1/process` (custo em
  Processing Units; conta grátis = 30.000 PU/mês).
- **Acesso (retroativo 2017–2025):** Google Earth Engine, coleção
  `COPERNICUS/S2_SR_HARMONIZED` (mesmas cenas L2A com SCL, de
  28/03/2017 em diante; custo zero).

**Como o painel se autentica no Copernicus** — três caminhos, na tela
que abre pela pílula "Copernicus":

1. **Client ID + secret** (OAuth client credentials). É o caminho
   documentado pelo Sentinel Hub e o que não expira a cada sessão.
2. **Colar um access token.** Necessário quando o OAuth não passa: se a
   origem do painel não estiver em *Allowed origins* do client, o
   navegador barra a chamada e o erro chega como **falha de CORS, sem
   mensagem útil** — parece credencial errada, mas não é. O token se
   gera no terminal:

   ```
   curl -X POST https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token \
     -d "grant_type=client_credentials" -d "client_id=SEU_ID" -d "client_secret=SEU_SEGREDO"
   ```

   O painel (`copernicus.js:entrarComToken`) tira um `Bearer ` da frente
   se vier junto, **valida o token contra o catálogo antes de aceitar**
   (401/403 viram erro claro) e lê a validade real do campo `exp` de
   dentro do JWT, em vez de supor uma hora.
3. **Login interativo na conta** — a senha é digitada na página oficial
   do Copernicus, não no painel. A sessão expira com frequência.

> Credencial e token ficam **só no `localStorage` do navegador** de quem
> usa, naquela máquina. Nada disso é enviado a servidor nosso nem
> embutido no código publicado — cada PC cola o seu.

### 3.2 Limites municipais

- **Malha Municipal do IBGE** — `https://www.ibge.gov.br/geociencias/organizacao-do-territorio/malhas-territoriais/15774-malhas.html`
  (obtida via `estudo-queimadas-mg/scripts/recorta_viirs.py`; cópias em
  `plano/dados/<codigo>.geojson` e `app/dados/municipios.geojson`).

### 3.3 Uso e cobertura do solo (LULC)

- **Primário:** MapBiomas Coleção 9, Landsat 30 m, anual — recorte
  estadual de MG distribuído pela IDE-Sisema:
  metadado `https://idesisema.meioambiente.mg.gov.br/geonetwork/srv/api/records/bb27f72b-2a30-45c0-9b04-2d3a8a32f0ca`
  (GeoTIFF + dicionário de dados + WMS
  `https://geoserver.meioambiente.mg.gov.br/IDE/ows`). Método: ATBD em
  `https://brasil.mapbiomas.org/atbd-entenda-cada-etapa/` (Souza et al.
  2020, Remote Sensing). Coleções mais novas (10/11) via GEE
  `projects/mapbiomas-public/assets/brazil/lulc/v1`.
- **Desempate do Mosaico de Usos:** Esri/Impact Observatory Sentinel-2
  10 m Land Cover (anual 2017–2025), ImageServer
  `https://ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer`
  (item Living Atlas `cfcb7609de5f478eb7666240902d4d3d`; CC-BY 4.0).
- **Por que não MapBiomas 10 m beta:** verificado (API oficial da
  plataforma, 2026-08): a coleção 10 m AUMENTA o Mosaico de Usos em MG
  em +72% (5,08 vs 2,95 Mha em 2024) e não separa cultivos — o ATBD
  declara agricultura sem nível 4 e fusão agro+pasto em Mosaico no
  Cerrado.

### 3.4 Terminologia complementar

- **Focos de calor** (validação/sazonalidade, não é área queimada):
  NASA FIRMS VIIRS S-NPP 375 m —
  `https://firms.modaps.eosdis.nasa.gov/` e INPE BDQueimadas —
  `https://terrabrasilis.dpi.inpe.br/queimadas/bdqueimadas/`.

### 3.5 Biomassa (B) e fração consumida (C) — tabela 4 do serviço

Hierarquia: medições brasileiras no Cerrado > síntese global > default
IPCC. Fontes semeadas:

- Kauffman, Cummings & Ward 1994, *J. Ecology* 82:519–531 (cerrado, DF)
- Castro & Kauffman 1998, *J. Trop. Ecology* 14:263–283 (gradiente
  campo → cerrado denso)
- Kauffman et al. 1998, *Oecologia* 113:415–427 (pastagens)
- van Leeuwen et al. 2014, *Biogeosciences* 11:7305–7329 (síntese) —
  `https://bg.copernicus.org/articles/11/7305/2014/`
- IPCC 2006 GL, Vol. 4, Cap. 2, Tabs. 2.4/2.6 —
  `https://www.ipcc-nggip.iges.or.jp/public/2006gl/pdf/4_Volume4/V4_02_Ch2_Generic.pdf`
- Armadilhas documentadas nas próprias linhas (ex.: "tropical pasture"
  do IPCC superestima pastagem de MG em 4–5×; corte-e-queima ~120 t/ha
  NÃO se aplica a fogo de sub-bosque).

### 3.6 Fatores de emissão (EF) — tabela 6 do serviço

Valores VERIFICADOS nas fontes primárias (2026-09):

- **Andreae 2019**, *Atmos. Chem. Phys.* 19:8523–8564, Tabela 1 (XLSX
  oficial) — `https://acp.copernicus.org/articles/19/8523/2019/` —
  PM2.5, TPM, CO, CO₂ para savanna/grassland (6,7 · 8,7 · 69 · 1660),
  tropical forest (8,3 · 10,9 · 104 · 1620) e agricultural residues
  (8,2 · 12,9 · 76 · 1430) g/kg.
- **Akagi et al. 2011**, *Atmos. Chem. Phys.* 11:4039–4072, Tabela 1 —
  `https://acp.copernicus.org/articles/11/4039/2011/` — pasture
  maintenance (o mais representativo para queima de pasto tropical):
  PM2.5 = 14,8 · PM10 = 28,9 · CO = 135 · CO₂ = 1548 g/kg; PM10 de
  floresta tropical = 18,5.
- Andreae 2019 NÃO publica PM10 (só PM2.5 e TPM) — as únicas linhas de
  PM10 semeadas vêm do Akagi 2011. Todos os EF estão marcados
  PROVISÓRIO até os fatores oficiais do projeto serem definidos.

### 3.7 Armazenamento no Portal ArcGIS do CBMMG

Portal `https://geoprocessamento.bombeiros.mg.gov.br/portal` — serviço
`Hosted/Monitor_Queimadas_Municipios/FeatureServer`, item
**3809b06eb45348ffb2ae10f1e3a14312**. TUDO que o monitor produz fica
armazenado aqui:

| Id | Camada/Tabela | O que guarda |
|---|---|---|
| 0 | Queimadas por passagem | os polígonos de cicatriz (shape), com competência, base, cena, dNBR, classe dominante e biomassa |
| 1 | Controle de passagens | uma linha por célula×dia processado (status, nuvem, PU, motivo) + anexos PNG (falsa cor, SCL, cor verdadeira) |
| 2 | Atribuicoes | quem assumiu cada quadrante |
| 3 | Consolidado mensal | competência × recorte (8MUN/município/fora/quadrante) |
| 4 | Parametros de biomassa | classe → B e C, com fonte (22 linhas) |
| 5 | Queimada por classe | detalhamento A×B×C por polígono |
| 6 | Fatores de emissao | poluente × classe → EF, com fonte (66 linhas) |
| 7 | LULC por celula | tiles de uso do solo (PNG cinza anexado; pixel = classe MapBiomas com mosaico resolvido), 1 linha por célula×ano |

Camadas reutilizadas de outros itens do mesmo Portal (leitura): UCs
estaduais `c830834b84604e0582174f2adb23e376` e Zonas de Amortecimento
reais `7c6e4f70a1534d4da68bf1db9b9bb344` (fase F4).

---

## 4. Scripts (na ordem de uso)

| Script | Papel |
|---|---|
| `plano/gerar_celulas_municipios.py` | gera a malha (23 células-mãe = 92 a 10 m, 5 quadrantes) a partir dos limites IBGE; escreve `app/dados/{quadrantes.json, quadrantes.geojson, celulas.geojson, municipios.geojson}` |
| `plano/gerar_lulc_tiles.py` | gera os 644 tiles de uso do solo (janela dos COGs públicos MapBiomas + Esri via range request, desempate do mosaico, PNG cinza) e anexa na tabela 7; retomável; `gerar_lulc_tiles.py <ano>` para o backfill |
| `infra/20_criar_camadas_municipios.py` | cria/estende o serviço no Portal (idempotente) e semeia as tabelas 4 (B×C) e 6 (EF) |
| `infra/21_registrar_redirect.py` | registra o redirect URI de um domínio novo no app OAuth (`nRFBQ8adfZIqHm56`) |
| `infra/22_retrofit_competencia.py` | preenche `competencia` em linhas antigas (não usado — serviço nasceu com o campo) |
| `app/js/motor/copernicus.js` | catálogo STAC + Process API (recortes NBR/SCL/falsa cor) |
| `app/js/motor/raster.js` / `vetor.js` / `nuvem.js` / `geo.js` | leitura GeoTIFF, dNBR, máscara, vetorização, sonda SCL, projeções |
| `app/js/motor/passagem.js` | o motor: pendências × catálogo, cadeia da base, rede de regeneração, gravação auditável no Portal |
| `app/js/motor/consolida.js` | fecha o mês: agrega, reparte por município, grava o consolidado |
| `app/js/painel.js` + `modal-passagem.js` | o painel e a estação de curadoria |
| (fase M4) `plano/backfill_gee.py` | retroativo 2017–2025 pela rota GEE, gravando no mesmo serviço com `metodo="retroativo GEE"` |

Execução dos scripts Python de infra/plano:
`"C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" <script>`
(precisa dos pacotes `arcgis` e `numpy`, presentes no ambiente do ArcGIS
Pro). Credenciais do Portal em
`focos-calor-mg/credenciais_portal.txt` (fora deste repositório).

Rodar local: `python -m http.server 8011 --directory app` e abrir
`http://localhost:8011` (o domínio precisa estar nos redirect URIs do
OAuth — `infra/21`).

---

## 5. Parâmetros (config.js)

| Parâmetro | Valor | Significado |
|---|---|---|
| `resolucaoPadrao` | 10 m | resolução de trabalho deste fork |
| `limiar` | 0,10 | corte de dNBR "queimado" (USGS/UN-SPIDER) |
| `areaMinM2` | 2.000 | área mínima de polígono |
| `nuvemCenaDescartar` | 95% | descarte barato pelo catálogo |
| `nuvemRecorteMax` | 30% | corte de viabilidade pela sonda SCL |
| `vaoMaximoDias` | 30 | acima disto a passagem sai marcada (estiagem × cicatriz) |
| `regeneracaoDias` | 365 | janela do anti-dupla-contagem geométrico |
| `inicioMonitoramento` | 2026-01-01 | início do monitor vivo (o retroativo é o backfill GEE) |
| `cotaMensalPU` / `tetoTrabalhoPU` | 10.000 / 9.000 | orçamento Copernicus por operador |

Custo do plano a 10 m: **17.548 PU/mês** para as 92 células dos 9
municípios — cabe em 1 conta na cota real de 30.000 PU/mês, ou 3
militares na cota conservadora de 7.000.

> **Os IDs de quadrante são absolutos, e isso é de propósito.** Eles
> vêm da posição da célula na grade EPSG:3857 ancorada na origem
> (`-19_-9`, `-20_-9`, `-20_-10`, `-21_-8`, `-22_-8`) — não de A1, A2,
> B2 como na primeira versão, que numerava a partir do canto do bbox
> que envolvia os municípios. Com IDs relativos, **incluir Paracatu
> renomeou A1 para C1** e invalidou em silêncio todo o histórico já
> processado, porque o controle no Portal é indexado pelo `quad_id`.
> Com IDs absolutos, acrescentar município nenhum move as células
> existentes.

---

## 6. Limitações conhecidas (herdadas do desenho)

- Fogo debaixo de nuvem parcial na passagem-base pode nunca ser contado
  (NaN propaga pela cadeia) — mitigação futura: base composta por pixel.
- A atribuição mensal carrega defasagem de até uma revisita (~5 dias):
  o que queimou no fim do mês e só foi visto no início do seguinte entra
  no mês da detecção.
- `dnbr_med` fica nulo quando a rede de regeneração recorta mais de 1%
  do polígono (a média do componente inteiro não descreveria a geometria
  gravada).
- B e C variam com a estação (fator ~2 entre início e fim da seca — o
  IPCC separa as linhas); a v1 usa o valor central de meio/fim de seca.
- Completude do consolidado exige Copernicus conectado; sem ele o mês é
  gravado como "completude não verificada".
- Quando a rede de regeneração recorta parte de um polígono, a fração
  por classe (calculada sobre o componente inteiro) é aplicada à área
  que sobrou — aproximação razoável porque reincidência tende a queimar
  a mesma vegetação.
- ~~Emissões por município rateadas pela biomassa municipal~~ —
  **resolvido.** A consolidação agora agrupa a tabela de classes por
  `municipio, classe_id` no servidor e deriva biomassa e emissões por
  classe dentro de cada município. Não há mais rateio.
- O monitor vivo usa o mapa de uso do solo de `anoLULC` (2023, o último
  com MapBiomas Col.9 + desempate Esri); o backfill usa o ano do fogo.
