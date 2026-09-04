# Começar aqui — montar o ambiente em outra máquina

Este arquivo é o que falta para sair do zero num PC novo. O **o quê e o
porquê** estão em [DOCUMENTACAO.md](DOCUMENTACAO.md); aqui é o **como**.

## O caminho curto

```bash
git clone https://github.com/geocbmmg/areas-queimadas-municipios.git
cd areas-queimadas-municipios
"C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" infra\00_checar_ambiente.py
```

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
| **Tiles de uso do solo** (364 PNGs, ~50 MB) | anexos no Portal | rodar `plano/gerar_lulc_tiles.py` — §5 |
| **Dados de queimada** | no Portal (item `3809b06e…`) | nada a fazer: são do servidor |

Nada disso é segredo perdido: tudo se regenera com os scripts do repo.

---

## 2. Programas necessários

- **Python do ArcGIS Pro** — é o que tem `arcgis`, `numpy`, `gdal` e
  `shapely` já instalados:
  `C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe`
- **Node.js** (só para `npx vercel`, ao publicar)
- **git** e **gh** (GitHub CLI), autenticado como `geocbmmg`

Dois pacotes costumam faltar (o verificador confirma quais):

```
"C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -m pip install --user shapely earthengine-api
```

> **Armadilha que custou várias tentativas:** o Python do ArcGIS Pro
> **nem sempre inclui o `site-packages` do usuário no `sys.path`** — o
> mesmo executável carrega `shapely` numa sessão do PowerShell e falha
> com `ModuleNotFoundError` noutra, dependendo de como o terminal foi
> aberto. O sintoma é cruel: um módulo diferente falta a cada execução,
> parecendo que a instalação não funcionou.
>
> Os scripts do projeto já **acrescentam esse caminho sozinhos** no topo
> do arquivo. Se você rodar um comando avulso (`python -c "import ee"`)
> e ele falhar mesmo com o pacote instalado, é isso — e o
> `00_checar_ambiente.py` denuncia com um AVISO.

> **Área geodésica não depende de biblioteca.** `pyproj` não existe
> nesse ambiente e `geographiclib` some conforme o terminal — instalar
> com `--user` funciona numa sessão e não noutra. Por isso o cálculo é
> feito no próprio `backfill_gee.py`, com as séries do WGS84: conferido
> contra o geographiclib, a diferença fica em **0,002%** de 200 m² a
> 1 km². Não reintroduza a dependência.

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
"C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -c "import ee; ee.Authenticate()"
```

Entre com a conta **leandrogomesbh**, projeto **incendioflorestalmg**.
A credencial fica em `%USERPROFILE%\.config\earthengine\credentials` e
não expira.

> Se rodar isso em processo não-interativo, ele morre com `EOFError` na
> hora de colar o código. Tem de ser terminal de verdade.

---

## 5. Regenerar os tiles de uso do solo

Os 364 PNGs (52 células × 7 anos) são a base do **B×C** da fórmula. Já
estão como anexos no Portal — só refaça se precisar de um ano novo:

```
cd plano
python gerar_lulc_tiles.py 2023      # um ano
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
python backfill_gee.py --paralelo 3                    # tudo o que falta
python backfill_gee.py --quads A2 --celulas 17         # uma célula
python backfill_gee.py --ate 2017-12-31                # até uma data
```

Ver o progresso a qualquer momento:

```
python ..\infra\30_estado.py
```

---

## 8. Publicar uma mudança

```
git add -A && git commit -m "..." && git push
cd app && npx vercel --prod --yes
```

O endereço `areas-queimadas-municipios.vercel.app` é fixo entre deploys,
então **não** é preciso recadastrar nada no OAuth a cada publicação.

Domínio novo (se algum dia houver) precisa entrar nos dois lugares:

```
python infra\21_registrar_redirect.py https://NOVO-DOMINIO
```

e, no Copernicus, em *Allowed origins* do OAuth client.

---

## 9. Onde o processamento parou

Estado em **04/09/2026**, ao passar o trabalho para outra máquina:

- **Painel:** pronto e publicado, com as quatro vistas de validação
  (cor verdadeira e falsa cor, antes e depois) e o consolidado mensal.
- **Parâmetros no Portal:** completos — 22 classes de biomassa (B×C),
  66 fatores de emissão, 364 tiles de uso do solo (2017–2023).
- **Histórico:** **começado, longe do fim.** Rodaram algumas células de
  2017 (A1 e A2, parcial). Faltam a maioria das 52 células e os anos de
  2018 a 2025.
- **Consolidado mensal:** nenhum mês fechado ainda — só faz sentido
  depois que o histórico do mês estiver completo.

Ou seja: **o próximo passo é rodar o backfill até o fim** (§7), depois
consolidar os meses no painel e validar por amostragem.

`python infra/30_estado.py` dá esse retrato atualizado a qualquer
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
- **`site-packages` do usuário fora do `sys.path`** (§2) — o mesmo
  Python acha um pacote numa sessão e não noutra.
- **Área geodésica não usa biblioteca**, de propósito: `pyproj` não
  existe no ambiente do Pro e `geographiclib` sofre do problema acima.
  As séries do WGS84 no `backfill_gee.py` batem com o geographiclib em
  0,002% de 200 m² a 1 km².
- **Sub-bloco sem imagem não é erro.** Quando a memória do GEE obriga a
  refazer a célula em 4×4, alguns sub-blocos caem fora da faixa da cena
  e o `mosaic()` volta sem banda. É ausência de imagem, e o script pula.
