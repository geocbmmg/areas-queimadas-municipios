# Monitor de Queimadas — 8 Municípios

Área queimada, biomassa consumida e emissões (E = A × B × C × EF) nos
8 municípios do estudo de queimadas 2015–2024:

Belo Horizonte · Betim · Conceição do Mato Dentro · Congonhas ·
Contagem · Ipatinga · São José da Lapa · Timóteo

Fork do monitor estadual (`monitor-queimadas-mg`) com o recorte trocado:
só as células da malha que tocam os 8 municípios, resolução de trabalho
de **10 m**, consolidação mensal **por município** (interseção geométrica
com os limites do IBGE) e as tabelas de **B×C** (biomassa) e **EF**
(fatores de emissão — PM2.5, PM10, TPM, CO, CO₂) já semeadas com fontes.

Roda no navegador: pede os recortes ao Copernicus, calcula o dNBR,
vetoriza a cicatriz e grava TUDO no Portal ArcGIS do CBMMG — polígonos,
controle auditável, consolidado e parâmetros. Ninguém instala nada.

CBMMG — Centro de Estudos de Bombeiros.

## Documentação

**[DOCUMENTACAO.md](DOCUMENTACAO.md)** — fontes de dados com links,
forma de cálculo, scripts, armazenamento, parâmetros e limitações.
O desenho de fundo (invariantes anti-dupla-contagem, regeneração,
consolidação) está em `monitor-queimadas-mg/plano/REFORMULACAO.md`.

## Os números do plano

- **13 células-mãe** (= 52 células a 10 m) em **3 quadrantes**
- **9.918 PU/mês** a 10 m — cabe em 2 militares (cota conservadora de
  7.000) ou 1 conta (cota real de 30.000)
- Serviço no Portal: `Hosted/Monitor_Queimadas_Municipios`
  (item `3809b06eb45348ffb2ae10f1e3a14312`)

## Rodar local

```bash
python -m http.server 8011 --directory app
```

O login do Portal e o do Copernicus exigem que o domínio esteja
registrado nos redirect URIs (`infra/21_registrar_redirect.py`).
