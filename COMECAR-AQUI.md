# Começar aqui — montar o ambiente em outra máquina

Este arquivo é o que falta para sair do zero num PC novo. O **o quê e o
porquê** estão em [DOCUMENTACAO.md](DOCUMENTACAO.md); aqui é o **como**.

## O caminho curto

```bash
git clone https://github.com/geocbmmg/areas-queimadas-municipios.git
cd areas-queimadas-municipios
py.cmd infra\00_checar_ambiente.py
```

**Sempre `py.cmd`, nunca `python`.** O `py.cmd` na raiz do repositório
chama o Python do ArcGIS Pro, que é o único desta máquina com as
bibliotecas do projeto. Veja §2.

O verificador diz **exatamente o que falta e o comando para resolver**:
bibliotecas, credenciais do Portal, autenticação do Earth Engine. Quando
ele disser "Tudo pronto", siga para `infra/30_estado.py`, que mostra em
que pé o processamento está e qual é o próximo passo.

O resto deste arquivo é o detalhe de cada item.

---

## 1. O que NÃO está no repositório (e por quê)

| O que | Onde está | Como obter |
|---|---|---|
| **Credenciais do Portal** | arquivo local fora do repo | criar à mão — §3 |
| **Credencial do Copernicus** | no navegador de quem usa | colada no painel — §6 |
| **Autenticação do Earth Engine** | perfil do usuário do Windows | `ee.Authenticate()` — §4 |
| **Tiles de uso do solo** (644 PNGs, ~50 MB) | anexos no Portal | rodar `plano/gerar_lulc_tiles.py` — §5 |
| **Dados de queimada** | no Portal (item `3809b06e…`) | nada a fazer: são do servidor |

Nada disso é segredo perdido: tudo se regenera com os scripts do repo.

---

## 2. Programas necessários

- **Python do ArcGIS Pro** — é o que tem `arcgis`, `numpy`, `gdal`,
  `shapely`, `requests` e `ee` já instalados:
  `C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe`
  (conferido: Python 3.13.13, GDAL 3.12.2). O `py.cmd` da raiz do
  repositório é só um atalho para ele.
- **Node.js** (só para `npx vercel`, ao publicar)
- **git** e **gh** (GitHub CLI), autenticado como `geocbmmg`

> **A armadilha que custou horas — e não era o que parecia.** Uma
> sequência de `ModuleNotFoundError` (`geographiclib`, `shapely`, `ee`,
> `osgeo`) fez concluir que o Python do ArcGIS Pro estava ignorando o
> `site-packages` do usuário. **Não estava.** O que acontecia é que
> `python`, no `PATH` desta máquina, resolve para
> `…\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe` — a
> venv do Hermes Agent, que não tem nenhuma dessas bibliotecas. Cada
> script "faltando um módulo diferente" era só o interpretador errado.
>
> Por isso **`py.cmd`, nunca `python`**. Se um dia o erro voltar,
> confirme primeiro com `python -c "import sys; print(sys.executable)"`
> antes de instalar coisa alguma.

> **Área geodésica não depende de biblioteca.** O cálculo é feito no
> próprio `backfill_gee.py`, com as séries do WGS84: conferido contra o
> `geographiclib`, a diferença fica em **0,002%** de 200 m² a 1 km².
> A dependência foi removida quando ainda se atribuía o problema ao
> `sys.path`; como a implementação própria já está verificada e não
> custa nada, não vale a pena reintroduzi-la.

---

## 3. Credenciais do Portal

Criar o arquivo (fora do repositório, caminho fixo nos scripts):

```
C:\Users\<você>\OneDrive\Área de Trabalho\Projetos do Claude\focos-calor-mg\credenciais_portal.txt
```

com três linhas:

```
portal=https://geoprocessamento.bombeiros.mg.gov.br/portal
usuario=<seu usuário do Portal>
senha=<sua senha>
```

Se o caminho da sua máquina for outro, ajuste a constante `CRED` no topo
de `infra/*.py` e `plano/backfill_gee.py`.

---

## 4. Earth Engine (só para o histórico)

Rode uma vez, **num terminal interativo** (ele pede para colar um código):

```
py.cmd -c "import ee; ee.Authenticate()"
```

Entre com a conta **leandrogomesbh**, projeto **incendioflorestalmg**.
A credencial fica em `%USERPROFILE%\.config\earthengine\credentials` e
não expira.

> Se rodar isso em processo não-interativo, ele morre com `EOFError` na
> hora de colar o código. Tem de ser terminal de verdade.

---

## 5. Regenerar os tiles de uso do solo

Os 644 PNGs (92 células × 7 anos) são a base do **B×C** da fórmula. Já
estão como anexos no Portal — só refaça se precisar de um ano novo:

```
cd plano
py.cmd gerar_lulc_tiles.py 2023      # um ano
```

O script é idempotente: pula o que já está lá. Para forçar, `FORCAR=1`.

---

## 6. Rodar o painel

**Em produção:** https://areas-queimadas-municipios.vercel.app — é o
endereço oficial, já registrado no OAuth do Portal e do Copernicus.

**Local** (para desenvolver):

```
python -m http.server 8124 --directory app
```

Tem de ser a **porta 8124**: é a que está nos redirect URIs do Portal.
Outra porta = login não volta.

Depois, no painel: **Entrar** (Portal) e clique na pílula **Copernicus**
para colar client ID e secret (criados em dataspace.copernicus.eu →
perfil → Sentinel Hub → User settings → OAuth clients). A credencial
fica no navegador daquela máquina — cada PC precisa colar a sua.

---

## 7. Continuar o histórico

O backfill é **retomável**: o controle no Portal é o checkpoint, então
rodar de novo continua de onde parou.

```
cd plano
py.cmd backfill_gee.py --paralelo 3                    # tudo o que falta
py.cmd backfill_gee.py "--quads=-20_-9" --celulas 17   # uma celula
py.cmd backfill_gee.py --ate 2017-12-31                # ate uma data
```

> Repare nas **aspas e no `=`** em `"--quads=-20_-9"`. Os IDs de
> quadrante começam com `-` (são absolutos na grade), e sem isso o
> argparse os lê como se fossem outra opção: *"argument --quads:
> expected one argument"*.

Ver o progresso a qualquer momento:

```
py.cmd ..\infra\30_estado.py
```

---

## 8. Publicar uma mudança

```
git add -A && git commit -m "..." && git push
```

Só isso: a Vercel está ligada ao GitHub e **publica sozinha a cada
push**. O endereço `areas-queimadas-municipios.vercel.app` é fixo entre
deploys, então **não** é preciso recadastrar nada no OAuth.

Para forçar uma publicação sem commit, **da raiz do repositório**:

```
npx vercel --prod --yes
```

> **Duas armadilhas que já derrubaram o site com 404:**
>
> 1. O site mora em `app/`, mas a Vercel publica a partir da **raiz**.
>    Quem resolve é o `outputDirectory: "app"` no `vercel.json` da raiz.
>    Sem ele, o deploy automático serve uma pasta sem `index.html`.
> 2. Rodar `vercel` de dentro de `app/` cria um **projeto diferente**,
>    batizado com o nome da pasta — e o endereço bom continua apontando
>    para o deploy antigo. Rode sempre da raiz, onde está o `.vercel`.
>
> O `vercel.json` também **não aceita chaves extras** (nem `//` como
> comentário): o deploy falha com *"should NOT have additional
> property"*.

Domínio novo (se algum dia houver) precisa entrar nos dois lugares:

```
py.cmd infra\21_registrar_redirect.py https://NOVO-DOMINIO
```

e, no Copernicus, em *Allowed origins* do OAuth client.

---

## 9. Onde o processamento parou

Estado em **09/09/2026**:

- **Painel:** pronto e publicado, com as quatro vistas de validação
  (cor verdadeira e falsa cor, antes e depois), o consolidado mensal e
  a **tela de Metodologia** (B/C e EF editáveis).
- **Parâmetros no Portal:** completos — 22 classes de biomassa (B×C),
  66 fatores de emissão, 644 tiles de uso do solo (92 células ×
  2017–2023).
- **Histórico: zerado de propósito, para recomeçar do zero.** A entrada
  de Paracatu trocou os IDs de quadrante (agora absolutos) e a mudança
  para dado bruto trocou o que se grava em cada polígono. Os ~9.300
  polígonos antigos ficaram inválidos nas duas frentes e foram
  apagados; parâmetros e tiles foram preservados.
- **Consolidado mensal:** nenhum mês fechado — depende do histórico.

O backfill 2017–2025 é a tarefa em curso.

Ou seja: **o próximo passo é rodar o backfill até o fim** (§7), depois
consolidar os meses no painel e validar por amostragem.

`py.cmd infra/30_estado.py` dá esse retrato atualizado a qualquer
momento — não confie nesta seção, que envelhece.

## 10. Armadilhas que já custaram caro

Estão detalhadas na DOCUMENTACAO.md, mas as que mais mordem:

- **`getInfo()` do GEE aborta em 5.000 feições.** Use a paginação de
  `ee.data.computeFeatures` — e o token vem em `nextPageToken`
  (camelCase), não em `next_page_token` como diz o docstring da própria
  biblioteca. Confiar no docstring faz perder 89% dos dados **em
  silêncio**.
- **Pixel do Mercator ≠ pixel do chão.** A 19 °S o pixel "de 10 m" tem
  9,45 m no terreno. Piso de área em metros de Mercator derruba
  justamente os componentes do tamanho mínimo.
- **Paginação do ArcGIS sem `ORDER BY`** repete e pula linhas acima de
  4.000 registros.
- **`applyEdits` falha POR LINHA** devolvendo HTTP 200 sem erro no topo.
  Sempre conferir `addResults`/`updateResults`/`deleteResults`.
- **Duas rodadas do backfill na mesma célula** duplicam linhas de
  controle. Rode uma de cada vez, ou use `--quads`/`--celulas` disjuntos.
- **Matar o backfill deixa polígonos órfãos.** Os polígonos são gravados
  antes da linha de controle; se o processo morrer entre os dois passos
  (Ctrl+C, `Stop-Process`, queda), os polígonos ficam sem controle e o
  painel soma **área fantasma** — num caso real, 9.932 polígonos e
  4.755 ha, que faziam Congonhas parecer 4,8× a referência do MapBiomas
  quando na verdade estava em 1,16×. O `30_estado.py` compara as duas
  somas e denuncia; `31_orfaos.py --apagar` limpa. Rodar o backfill de
  novo também conserta (a passagem volta à fila e a higiene apaga os
  órfãos antes de recalcular).
- **`python` no `PATH` é o interpretador errado** (§2) — é a venv do
  Hermes Agent, sem nenhuma das bibliotecas do projeto. Use `py.cmd`.
  Esta é a causa real da série de `ModuleNotFoundError`, que por muito
  tempo foi atribuída ao `sys.path` do ArcGIS Pro.
- **Área geodésica não usa biblioteca**: as séries do WGS84 no
  `backfill_gee.py` batem com o `geographiclib` em 0,002% de 200 m² a
  1 km², então não há motivo para trazer a dependência de volta.
- **Sub-bloco sem imagem não é erro.** Quando a memória do GEE obriga a
  refazer a célula em 4×4, alguns sub-blocos caem fora da faixa da cena
  e o `mosaic()` volta sem banda. É ausência de imagem, e o script pula.
