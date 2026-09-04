# Reformulação do Monitor Estadual

> Objetivo final: **área queimada de Minas Gerais inteiro, fechada por mês**, com
> **biomassa consumida por classe de uso do solo** (M = A × B × C, pronta para
> receber os fatores de emissão EF_i) e **unidades de conservação + zonas de
> amortecimento** no mapa e na contabilidade. Sem dupla contagem do mesmo
> incêndio; reincidência permitida depois do período de regeneração
> (configurável).

Decisões já tomadas com o usuário (24 e 31/08/2026):

- **Período de regeneração configurável** (`regeneracaoDias` no config).
- **O mês de um polígono é o mês da detecção** — o `data_pass` da passagem que
  o viu, pós-incêndio. Regra única, auditável; o vão longo continua marcado
  para validação na estação, mas não muda o mês.
- **Série retroativa até 2017** — backfill 2017→2025 pela rota GEE (§6);
  a coleção do GEE começa em 28/03/2017, então o primeiro mês consolidável
  é ~mai/2017.

---

## 1. O mês e a consolidação mensal

### 1.1 Competência na origem

Novo campo `competencia` (String 7, `"AAAA-MM"`) na **camada 0** e na **tabela
de controle**, preenchido pelo motor a partir de `pas.dia` no momento da
gravação (`processar`, montagem dos `adds`). Derivado, nunca editado — existe
para agrupar sem depender de função de data no `where` (o Portal rejeita
comparação numérica em campo Date; o padrão `janelaDia` já documenta isso).

### 1.2 Tabela 4 — "Consolidado mensal"

Nova tabela no serviço, uma linha por `competencia × recorte`, onde recorte é:

| `tipo_recorte` | `recorte_id` | exemplo |
|---|---|---|
| `estado` | `MG` | o número do mês para o estado inteiro |
| `quadrante` | `A2`.. | acompanhamento por responsável |
| `classe` | código MapBiomas | área e biomassa por uso do solo |
| `uc` | objectid da UC | dentro da UC |
| `za` | objectid da UC dona da ZA | no entorno |

Campos: `competencia`, `tipo_recorte`, `recorte_id`, `recorte_nome`,
`area_ha`, `n_poligonos`, `biomassa_t`, `celulas_fechadas`, `celulas_total`,
`gerado_em`, `gerado_por`.

**Como fecha:** botão "Consolidar mês" no painel. Recalcula por
`outStatistics`/`groupByFieldsForStatistics` sobre a camada 0 e a tabela de
detalhamento por classe (§3.4), **sempre com `res_m = 20`** (§2.3), apaga e
regrava as linhas daquela competência — idempotente, pode rodar quantas vezes
quiser. `celulas_fechadas/total` diz o quão completo o mês está (célula
"fechada" = todas as passagens do mês com status terminal que não `erro`).
A tabela é o insumo direto de um ArcGIS Dashboard depois.

---

## 2. Dupla contagem e regeneração

### 2.1 O que a cadeia já resolve — e as brechas confirmadas

A cadeia (dNBR contra a passagem anterior viável, por célula) já é um
anti-dupla-contagem temporal: a cicatriz detectada em T dá dNBR ≈ 0 em T+1.
As brechas reais, confirmadas no código:

1. **`erro` é beco sem saída com dupla contagem** — `pendencias` trata
   qualquer linha existente como feita (`passagem.js:191`), então `erro`
   nunca reprocessa; e `recuperarBase` só aceita
   `IN ('base','calculada','sem_area')` (`passagem.js:413`). Se os polígonos
   gravaram e o controle falhou depois, a próxima passagem usa a base
   **anterior** ao erro e conta o mesmo fogo de novo.
2. **Duplicidade entre resoluções** — as séries de 10 m e 20 m são cadeias
   independentes; nada impede as duas na mesma área. Somar sem filtrar
   `res_m` dobra a área.
3. **Sem cascata na curadoria** — reabrir/ignorar uma passagem do meio deixa
   as seguintes calculadas contra base que não existe mais, sem aviso.
4. **`vet.truncado` ignorado** — acima de 5.000 componentes o vetorizador
   descarta em silêncio (subcontagem invisível num mês de fogo intenso).

### 2.2 A rede de segurança geométrica + regeneração

No `processar`, entre a vetorização e o `applyEdits`:

1. consulta a camada 0 pelos polígonos da **mesma célula** com
   `data_pass ≥ pas.dia − regeneracaoDias` (qualquer `status` — queima
   prescrita também queimou);
2. `union` dos anteriores; `difference` de cada polígono novo
   (`geometryEngine` já está carregado — simplify e geodesicArea já são usados
   ali);
3. o que sobrar abaixo de `areaMinM2` não grava; a área geodésica é recalculada
   depois do recorte.

Com isso, **dentro da janela de regeneração a mesma área nunca conta duas
vezes** — nem por erro, nem por reprocessamento, nem por base errada. Vencido
o prazo, o `where` deixa os polígonos velhos de fora e a reincidência conta
normalmente. As células são partição exata da malha, então não há sobreposição
entre células — a consulta por célula basta.

Config novo (`config.js`):

```js
regeneracaoDias: 365,   // reincidência só conta após este prazo (configurável)
```

### 2.3 Resolução canônica

O consolidado mensal usa **só `res_m = 20`** (a malha do plano). A série de
10 m continua existindo como análise local de célula, fora da contabilidade —
o painel avisa quando houver 10 m na área para ninguém somar as duas.

### 2.4 Correções que entram junto

- `pendencias` volta a enfileirar `status_proc = 'erro'`; antes de recalcular,
  o motor apaga os polígonos órfãos daquela célula×dia (a rede do §2.2 já
  seguraria, mas limpar é mais barato que recortar).
- `reabrirPassagem`/`ignorarPassagem`: localizar as linhas com `data_ref` no
  dia mexido e reabri-las em cascata (com confirmação, mostrando o custo).
- `vet.truncado === true` → linha de controle marcada com motivo
  "vetorização truncada (N componentes)" para a estação ver.
- Backlog (não bloqueia): fogo sob nuvem parcial some para sempre (NaN na base
  propaga); mitigação futura é base composta por pixel (última observação
  válida). Registrado como limitação conhecida no relatório mensal.

---

## 3. Uso do solo e biomassa — M = A × B × C

### 3.1 A fonte de uso do solo (pesquisa 24/08/2026)

Não existe produto estadual Sentinel *com relatório técnico público e serviço
aberto* que cubra MG inteiro. O quadro real:

| Fonte | Sensor / res. | Cobertura MG | Acesso | Serve para biomassa? |
|---|---|---|---|---|
| **MapBiomas Col. 9 — recorte MG distribuído pela IDE-Sisema** | Landsat 30 m | total, 1985–2023 | GeoTIFF pronto + WMS GeoServer IDE + dicionário de dados PDF | **Sim** — legenda ecológica completa (florestal, savânica, campo, pastagem, silvicultura, cana, café…) |
| MapBiomas 10 m (beta, Col. 3) | Sentinel-2 10 m | total, 2017–2024 | asset GEE | Sim, mas é **beta** — frágil para relatório institucional |
| Esri/Impact Observatory (Living Atlas) | Sentinel-2 10 m | total, anual 2017–2025 | ImageServer REST plug-and-play no Portal | Não sozinho — "rangeland" mistura campo nativo e pastagem |
| Mappia/Selo Verde (SEMAD+IEF+CSR/UFMG 2023) | Sentinel-2 + Planet | total | **sem** WMS/download público, sem relatório técnico publicado | Citável como produto estadual Sentinel, inutilizável operacionalmente hoje |
| ZAP (IDE-Sisema) | Sentinel-2 10 m | só sub-bacias concluídas | WMS/WFS + metodologia oficial (5ª ed.) | Referência local onde existir |
| ESA WorldCover / Dynamic World | S1/S2 10 m | total | GEE/AWS | Legenda pobre (não separa pasto de campo) |

**O problema do Mosaico de Usos — verificado (24/08/2026):** a classe 21 é
área demais para ficar sem referência na tabela de biomassa (12% nos 8
municípios do estudo em 2024; 2,95 Mha em MG na coleção 30 m). E a coleção
10 m (Sentinel) NÃO reduz o mosaico — **aumenta**: MG 2024 = 5,08 Mha no 10 m
contra 2,95 Mha no 30 m (**+72%**, API oficial da plataforma MapBiomas). É
metódico, não acidental: o ATBD 10 m declara agricultura sem diferenciação de
cultivo (legenda para no nível 3, sem classe 41) e, no Cerrado, o
pós-processamento funde agricultura+pastagem em Mosaico de Usos de propósito.
A classe 25 também cresce (+51% em MG). Portanto o 10 m beta está descartado
como primário; a solução do mosaico é o **desempate híbrido** abaixo.

**Desempate do mosaico (híbrido):** na geração dos tiles (offline), todo pixel
de Mosaico de Usos (21) — e das classes genéricas 25/41 — é resolvido pela
classificação **Esri/Impact Observatory Sentinel-2 10 m** do mesmo ano:
`crops` → agricultura temporária, `rangeland` → pastagem, `trees` → formação
florestal (demais classes → análogo direto). A tabela de parâmetros fica sem
nenhuma linha genérica: cada hectare referencia uma classe com B, C e fonte.
Uma frase documenta o método no relatório. A tabela ganha a linha
"Agricultura temporária (resíduo)" com default IPCC para receber o que o
desempate mandar para agricultura.

**Recomendação:** MapBiomas Coleção 9 ano 2023 (o GeoTIFF estadual
`ide_1402_mg_uso_terra_mapbiomas_col9_2023.tif` da IDE-Sisema) como base da
atribuição de biomassa — única fonte com estado inteiro + legenda que separa
as classes que têm B e C distintos + distribuição oficial pelo órgão ambiental
do estado + método citável (ATBD, Souza et al. 2020). A diferença 30 m × 20 m é
irrelevante para estatística zonal de cicatriz. No relatório institucional,
citar MapBiomas/IDE-Sisema; mencionar Mappia 2023 como produto estadual
Sentinel em consolidação (sem serviço aberto) e o ZAP onde houver sub-bacia.

### 3.2 A mecânica do cruzamento — por pixel, na grade que já existe

O motor já tem, em memória, a máscara de queimado pixel a pixel na grade
3857 da célula. O cruzamento não precisa de interseção vetorial:

1. **Tiles de uso do solo por célula** — um PNG paletado 2.500×2.500 por
   célula (o MapBiomas 30 m reamostrado por vizinho-mais-próximo na grade de
   20 m da célula), gerado uma vez por `plano/gerar_lulc_celulas.py` a partir
   do GeoTIFF estadual. ~300 KB–1 MB por célula, 314 células.
2. No `processar`, o motor baixa o tile da célula (uma vez, com cache),
   e para cada polígono conta pixels por classe dentro do componente →
   `A_classe = area_ha × (pixels_classe / pixels_total)` — o rateio herda a
   área geodésica total, sem reintroduzir a distorção do Mercator.
3. `M_classe = A_classe × B_classe × C_classe`; `biomassa_t = Σ M_classe`.

Custo Copernicus: **zero** (o tile é nosso).

**Onde os tiles moram** — duas opções, decidir antes da F3:
- **(a) anexos numa tabela do Portal** ("LULC por célula", uma linha por
  célula, PNG anexado; o mecanismo `anexar` já existe e o app já autentica no
  Portal). Sem dependência de terceiro em tempo de execução, sem inchar o
  repositório. *Recomendada.*
- (b) estáticos no deploy da Vercel (`app/dados/lulc/`) — mais simples, mas
  ~150–300 MB de repo/deploy.

### 3.3 A tabela de parâmetros B e C (pesquisa 24/08/2026)

Vira a **Tabela 5 — "Parâmetros de biomassa"** no serviço (editável no Portal,
não hardcoded no JS): `classe_id` (código MapBiomas), `classe_nome`,
`b_t_ha` (carga disponível, t MS/ha), `c_fracao` (fração consumida 0–1),
`fonte`, `obs`. Semeada pelo script de infra com estes valores centrais:

| Classe MapBiomas | B (t MS/ha) | C | B×C | Fonte principal |
|---|---|---|---|---|
| Formação Campestre (12) | 7 *(4,9–12,9)* | 0,90 | 6,3 | Kauffman et al. 1994; Castro & Kauffman 1998 (campo limpo/sujo, medições no Brasil) |
| Formação Savânica (4) | 10 *(8–13)* | 0,75 | 7,5 | Kauffman 1994 (cerrado s.s. 10,03 t/ha, C 0,72–0,84); IPCC Tab. 2.6 confirma (0,74) |
| Formação Florestal (3) — fogo de sub-bosque | 8 *(5–12)* | 0,45 | 3,6 | literatura de sub-bosque tropical; **nunca** usar os ~120 t/ha de corte-e-queima do IPCC (superestima ~10×) |
| Pastagem (15) | 5 *(3–10)* | 0,95 | 4,75 | Kauffman 1998 / IPCC grassland; **armadilha**: a linha "tropical pasture" do IPCC (23,7 t/ha) é pasto amazônico com madeira residual — superestima 4–5× em MG |
| Cana (20) | 13 *(6,5–25)* | 0,85 | 11,0 | van Leeuwen 2014 (Brasil FC ~20 t/ha); IPCC default 6,5 é baixo para a produtividade brasileira |
| Silvicultura (9) | 15 *(4–25)* | 0,60 | 9,0 | IPCC Tab. 2.4/2.6 (eucalipto australiano, SD ≥ 100% — maior incerteza da tabela) |
| Mosaico de Usos (21) | 5 | 0,95 | 4,75 | tratado como pastagem (dominância) |
| Afloramento/campo rupestre (29) | 6 *(4–10)* | 0,90 | 5,4 | analogia campo limpo; solos rasos do Espinhaço → metade inferior da faixa em fogo frequente |
| Urbana (24), Mineração (30), Água (33), Solo exposto… | 0 | — | 0 | não vegetado |

Notas metodológicas que vão no relatório:

- **Numeração correta do IPCC 2006 (Vol. 4, Cap. 2):** Eq. 2.27
  `L_fire = A × M_B × C_f × G_ef × 10⁻³`; a **Tab. 2.4** traz o produto
  M_B×C_f **já combinado** (não multiplicar por C de novo); a **Tab. 2.6**
  traz C_f; a **Tab. 2.5** traz os G_ef (= os EF_i que o usuário fornecerá).
- Hierarquia de dados: (1) medições brasileiras no Cerrado (Kauffman 1994;
  Castro & Kauffman 1998; Ward 1992; Ottmar 2001) → (2) van Leeuwen et al.
  2014 → (3) defaults IPCC como âncora institucional. Inventário Nacional
  MCTI/SIRENE como referência de Tier 2 nacional.
- Sazonalidade muda B×C por fator ~2 (início × meio/fim da seca — o IPCC
  separa as linhas). Fica registrado como refinamento futuro (coluna
  `epoca` na tabela de parâmetros); a v1 usa o valor central de meio/fim.
- Para campo, pastagem e cana o IPCC considera o CO₂ **neutro** (rebrota
  anual compensa) — só gases não-CO₂ são reportados. Relevante quando os
  EF_i chegarem.
- B é o parâmetro mais incerto (SD 30–100% nas tabelas); reportar sempre a
  faixa junto do central.

### 3.4 Onde os números ficam

- **Camada 0** ganha `classe_uso` (SmallInteger — classe dominante) e
  `biomassa_t` (Double — Σ M_classe do polígono).
- **Tabela 6 — "Queimada por classe"** (detalhamento 1:N): `poligono_gid`
  (GlobalID do polígono), `competencia`, `quad_id`, `celula`, `classe_id`,
  `area_ha`, `biomassa_t`. É desta tabela que o consolidado mensal por classe
  sai por `outStatistics`.
- **Tabela 7 — "Fatores de emissão"** (esquema pronto, valores do usuário):
  `poluente`, `classe_id` (nulo = todas), `ef_g_kg`, `fonte`. Quando semeada,
  o consolidado passa a publicar `E_i = biomassa_t × EF_i` por poluente —
  nenhuma mudança de motor, só uma multiplicação na consolidação.
- A estação (`modal-passagem.js`, tabela por célula) mostra o M por classe da
  passagem.

---

## 4. Unidades de conservação e zonas de amortecimento

As camadas **já existem no Portal**, prontas (criadas para a Calculadora,
compartilhadas com a organização, mesmo app OAuth `nRFBQ8adfZIqHm56`):

| Camada | Item | URL REST |
|---|---|---|
| UCs estaduais (95, base IEF) | `c830834b84604e0582174f2adb23e376` | `…/Hosted/UCs_Estaduais_MG/FeatureServer/0` |
| ZAs reais (77: 51 plano de manejo + 26 faixa 3 km do IEF) | `7c6e4f70a1534d4da68bf1db9b9bb344` | `…/Hosted/ZA_UCs_Estaduais_MG/FeatureServer/0` |

Regras herdadas do ecossistema (não reinventar):

- **Usar a ZA real, não buffer de 3 km** — no P.E. do Rio Doce a ZA de plano
  de manejo chega a 13,65 km; o buffer erraria feio. Prioridade
  `origem = 'plano_manejo'` sobre `'raio_3km'` quando as duas alcançam a mesma
  UC. APA e RPPN não têm ZA **por lei** (SNUC art. 25), não é falha de dado.
- Sobreposição UC×UC: proteção integral prevalece; uso sustentável só conta
  onde não coincide (regra PI×US do monitor das UCs).
- Camadas são estáticas e de leitura — nunca editar.

O que entra no monitor estadual:

1. **Config**: `camadaUCs` e `camadaZA` no `config.js`.
2. **Mapa** (painel e estação): dois FeatureLayers com o token do Portal
   (renderers já vêm do serviço: UC ciano, ZA tracejado laranja), checkbox
   para ligar/desligar. No modal, o `V.lUC` atual (que é o contorno do
   quadrante com nome herdado) é renomeado e as camadas reais entram ao lado.
3. **Cruzamento**: na gravação (ou na consolidação), query espacial
   `esriSpatialRelIntersects` das manchas contra UC e ZA (95+77 feições,
   filtráveis por bbox da célula, cacheáveis por sessão);
   `geometryEngine.intersect` + área geodésica → linhas `uc`/`za` no
   consolidado mensal e campo `ucs_atingidas` (String) no polígono para
   consulta rápida.

---

## 5. Delta de esquema do serviço (infra/20, idempotente)

O `main()` do `20_criar_camadas_mg.py` já só adiciona o que falta
(`add_to_definition`) — o serviço e os dados existentes não são tocados.

| Onde | Novidade |
|---|---|
| Camada 0 | `competencia` (String 7), `classe_uso` (SmallInteger), `biomassa_t` (Double) |
| Tabela 1 (controle) | `competencia` (String 7) |
| **Tabela 4** | Consolidado mensal (§1.2) |
| **Tabela 5** | Parâmetros de biomassa (§3.3) — semeada pelo script |
| **Tabela 6** | Queimada por classe (§3.4) |
| **Tabela 7** | Fatores de emissão (§3.4) — vazia até o usuário fornecer EF_i |
| Domínio | `status_proc` vira domain no serviço (base/calculada/sem_area/nublada/erro/ignorada) + constante única no JS |

Retrofit: script único de infra que preenche `competencia` nas linhas já
gravadas (derivado de `data_pass`) — roda uma vez, é auditável.

---

## 6. Retroativo — backfill 2017 → 2025 (rota GEE)

Decisão (31/08/2026): a série mensal recua até **2017**. Verificado no
catálogo do Copernicus (STAC, 31/08): o arquivo L2A reprocessado
(Collection-1, baseline `N0500`, com SCL) cobre MG desde dez/2015 — as bandas
do dNBR (B08, B12) e a máscara existem no arquivo inteiro. Mas 2015–2016 só
têm S2A (revisita ~10 dias: 9 passagens em jul–set/2016 contra 19 em 2017) —
por isso o corte em 2017, quando o S2B fecha a revisita de 5 dias e a série
fica igual à atual.

Pela rota Copernicus o backfill não fecha: ~60 mil PU/mês do estado ⇒
~720 mil PU por ano ⇒ ~6,5 milhões de PU pelos 9 anos — ~10 meses da frota
inteira (21 contas × 30 mil PU/mês) só de passado. Daí a rota GEE, de custo
zero:

- **Fonte:** `COPERNICUS/S2_SR_HARMONIZED` — as mesmas cenas L2A com SCL,
  disponíveis de **28/03/2017** em diante. A primeira passagem viável de cada
  célula é a base (não produz área), então o primeiro mês consolidável é
  ~mai/2017.
- **Paridade de regra:** mesma malha de células (bbox 3857 do
  `quadrantes.json`), mesma cadeia (dNBR contra a anterior viável da célula),
  mesma sonda SCL no recorte (corte 30%), mesmo limiar 0,10, mesma área mínima
  2.000 m², mesma janela `regeneracaoDias` — os parâmetros são lidos do
  `config.js` para nunca divergirem do motor vivo.
- **Script `plano/backfill_gee.py`** (projeto GEE `incendioflorestalmg`): por
  célula, monta a lista de dias, mede a nuvem no recorte (histograma do SCL),
  decide a cadeia, calcula o dNBR a 20 m na grade 3857, vetoriza
  (`reduceToVectors`), aplica a rede de regeneração e grava no **mesmo
  serviço do Portal** via API Python do ArcGIS: polígonos + linhas de
  controle com `metodo = "retroativo GEE"`. Painel, estação e consolidação
  não distinguem origem — a auditabilidade (base, cena, vão) se mantém linha
  a linha.
- **Fatiado por quadrante × ano com checkpoint** (retomável — a lição da
  extração do DATASUS): ~314 células × ~70 passagens/ano × 9 anos ≈ 200 mil
  célula-passagens, longe de caber numa execução só.
- **LULC do ano do fogo** (MapBiomas anual 30 m; o desempate Esri 10 m cobre
  2017–2025 — exatamente a janela do backfill).
- **Emenda com o monitor vivo:** o vivo começa em 2026 com base própria; a
  rede geométrica (§2.2) consulta a camada 0 — que já conterá o backfill —
  então a fronteira dez/2025 → 2026 não duplica nada.
- **Curadoria retroativa por amostragem:** os polígonos nascem
  `status="Queimada"` como os demais; a falsa cor é gerada sob demanda na
  estação (paga PU só quando alguém abrir — não se anexa 9 anos de PNG à toa).

---

## 7. Ordem de implementação

| Fase | Entrega | Toca em |
|---|---|---|
| **F1 — Fundações** | campos/tabelas novos + retrofit de `competencia`; correção do `erro` (reprocessável + limpeza de órfãos); cascata em reabrir/ignorar; aviso de `truncado`; `regeneracaoDias` no config | `infra/20`, `passagem.js`, `config.js` |
| **F2 — Rede geométrica + mês** | difference contra queimadas na janela de regeneração; botão "Consolidar mês" + Tabela 4 + vista mensal no painel (estado/quadrante) | `passagem.js`, novo `motor/consolida.js`, `painel.js` |
| **F3 — Uso do solo e biomassa** | `gerar_lulc_celulas.py` + hospedagem dos tiles; contagem por classe no motor; Tabelas 5 e 6 semeadas; M por classe na estação e no consolidado | `plano/`, `passagem.js`, `raster.js`, `modal-passagem.js` |
| **F4 — UCs e ZA** | camadas no mapa; cruzamento; linhas `uc`/`za` no consolidado | `config.js`, `painel.js`, `modal-passagem.js`, `consolida.js` |
| **F5 — Retroativo 2017+** | `backfill_gee.py` por quadrante × ano (mar/2017 → dez/2025), gravando no mesmo serviço com `metodo="retroativo GEE"`; consolidação re-rodada mês a mês | novo `plano/backfill_gee.py` |
| **F6 — Emissões** | Tabela 7 semeada com os EF_i do usuário; E_i por poluente no consolidado; relatório mensal exportável | `consolida.js`, painel |

Cada fase fecha funcionando; a F5 pode rodar assim que a F3 existir (as
linhas de UC/ZA dos meses retroativos entram re-rodando a consolidação depois
da F4); a F6 só depende dos EF_i.

---

## 8. Fontes

**Uso do solo**
- MapBiomas Col. 9 recorte MG (IDE-Sisema): metadado `bb27f72b-2a30-45c0-9b04-2d3a8a32f0ca` em `idesisema.meioambiente.mg.gov.br/geonetwork` — GeoTIFF `ide_1402_mg_uso_terra_mapbiomas_col9_2023.tif` + dicionário de dados PDF; WMS `IDE:ide_1402_…` em `geoserver.meioambiente.mg.gov.br/IDE/ows`
- MapBiomas ATBD: `brasil.mapbiomas.org/atbd-entenda-cada-etapa/` (Souza et al. 2020, *Remote Sensing*)
- MapBiomas 10 m beta (GEE): `projects/mapbiomas-public/assets/brazil/lulc_10m/collection3/mapbiomas_10m_collection3_integration_v1`
- Esri/IO Sentinel-2 10 m LULC: `ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer`
- Mappia/Selo Verde MG (SEMAD+IEF+CSR/UFMG, 2023): `csr.ufmg.br/mappia/minas-gerais/`
- ZAP: `meioambiente.mg.gov.br/w/zoneamento-ambiental-produtivo-zap-` (metodologia 5ª ed.)

**Biomassa e combustão**
- IPCC 2006 GL Vol. 4 Cap. 2 (Eq. 2.27, Tabs. 2.4/2.5/2.6): `ipcc-nggip.iges.or.jp/public/2006gl/pdf/4_Volume4/V4_02_Ch2_Generic.pdf`
- Kauffman, Cummings & Ward 1994, *J. Ecology* 82:519–531 (cerrado, medições DF)
- Castro & Kauffman 1998, *J. Trop. Ecology* 14:263–283 (gradiente campo→cerrado denso)
- Kauffman, Cummings & Ward 1998, *Oecologia* 113:415–427 (pastagens)
- van Leeuwen et al. 2014, *Biogeosciences* 11:7305–7329 (síntese global de consumo)
- Ward et al. 1992, *JGR* 97:14601 (BASE-B, fogos experimentais no cerrado)
- Ottmar et al. 2001, USDA PNW-GTR-519 (séries fotográficas de combustível no cerrado)
- França et al. 2012, *Atmosphere* 3:164–180 (EFs de cana brasileira — para a F5)
- Inventário Nacional MCTI/SIRENE 1990–2022 (âncora Tier 2 nacional)

**Retroativo**
- GEE `COPERNICUS/S2_SR_HARMONIZED` (Sentinel-2 L2A + SCL, 28/03/2017 em diante) — rota do backfill
- Catálogo CDSE STAC (`catalogue.dataspace.copernicus.eu/stac`) — confirma L2A Collection-1 (`N0500`) sobre MG desde dez/2015; densidade jul–set: 9 dias (2016, só S2A) → 19 dias (2017, com S2B)

**Camadas do Portal**
- UCs: item `c830834b84604e0582174f2adb23e376`; ZA: item `7c6e4f70a1534d4da68bf1db9b9bb344` (origem WFS IDE-Sisema/IEF, `esfera=estadual`, 24/08/2026)
