# Áreas Queimadas e Emissões — 8 Municípios

Belo Horizonte · Betim · Conceição do Mato Dentro · Congonhas ·
Contagem · Ipatinga · São José da Lapa · Timóteo

Estima as **emissões atmosféricas dos incêndios** a partir da área
queimada medida por sensoriamento remoto:

> **E<sub>i</sub> = A × B × C × EF<sub>i</sub>**
>
> área queimada → biomassa disponível → biomassa consumida →
> fator de emissão → massa de poluente emitida

| termo | de onde vem |
|---|---|
| **A** | dNBR do Sentinel-2 a 10 m, contra a passagem anterior viável da mesma célula |
| **B, C** | classe de uso do solo do **ano do fogo** × tabela de parâmetros por classe |
| **EF** | fatores por poluente (PM2.5, PM10, TPM, CO, CO₂) — Andreae 2019 e Akagi 2011 |

Roda no navegador e grava tudo no Portal ArcGIS do CBMMG. O histórico
(2017–2025) é processado pelo Google Earth Engine, com as mesmas regras.

**CBMMG — Centro de Estudos de Bombeiros**

---

## Onde está tudo

| | |
|---|---|
| **Painel** | https://areas-queimadas-municipios.vercel.app |
| **Dados** | Portal ArcGIS, item `3809b06eb45348ffb2ae10f1e3a14312` |
| **Como montar noutra máquina** | [COMECAR-AQUI.md](COMECAR-AQUI.md) |
| **Método, fontes e decisões** | [DOCUMENTACAO.md](DOCUMENTACAO.md) |

### Numa máquina nova

```
python infra/00_checar_ambiente.py     # o que falta instalar/configurar
python infra/30_estado.py              # em que pé está o processamento
```

O primeiro diz o que falta e o comando exato para resolver. O segundo lê
o Portal e mostra o próximo passo.

Lê o Portal e responde: quantas células foram processadas, quantos
polígonos existem, quanto deu por município, quais meses estão fechados
e **qual é o próximo passo**.

---

## O painel

Uma lista de áreas queimadas — filtrável por município, período e área
mínima. Cada área traz a conta fechada: hectares, uso do solo, biomassa
consumida e emissões por poluente.

E a pergunta que importa, **queimou mesmo?**, se responde olhando: para
cada polígono o painel pede um recorte pequeno em volta dele e monta
quatro imagens — cor verdadeira e falsa cor, **antes e depois** — com o
contorno desenhado por cima, por cerca de 1 PU. Clicar numa delas joga a
imagem sobre o mapa, georreferenciada, com controle de opacidade. Se a
mancha só aparece no depois, queimou; se já estava lá, é estiagem, e se
exclui ali mesmo.

---

## Os números do plano

- **52 células** de 25 km (10 m/px) cobrindo os 8 municípios, em 3
  blocos da malha estadual
- **3.269 km²** de área municipal
- **9.918 PU/mês** se rodar tudo ao vivo a 10 m — cabe numa conta
  gratuita do Copernicus (30.000 PU/mês)
- Histórico pelo **GEE**: custo zero de PU

---

## Estrutura

```
app/            o painel (roda no navegador, sem build)
  js/motor/     copernicus, raster, vetor, nuvem, passagem, biomassa, consolida
  js/           painel, vistas-poligono (as imagens de validação)
  dados/        malha das células e limites municipais do IBGE
infra/          criação do serviço no Portal, OAuth, estado
plano/          malha, tiles de uso do solo, backfill do histórico
```

## Limitação registrada

O critério de detecção é **dNBR ≥ 0,10 puro**, que superdetecta a cura
do capim na estiagem — no cerrado, entre julho e outubro, vegetação seca
pode ser lida como cicatriz. A validação visual do painel existe
exatamente para isso, e o piso de relatório permite subir o corte sem
reprocessar. Ver DOCUMENTACAO.md §6.
