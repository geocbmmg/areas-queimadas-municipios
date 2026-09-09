# -*- coding: utf-8 -*-
"""
Confere se esta máquina está pronta — rode ANTES de qualquer outra coisa.

    python infra/00_checar_ambiente.py

Diz o que falta e o comando exato para resolver. Existe porque o Python
do ArcGIS Pro nem sempre inclui o site-packages do usuário no sys.path
(depende de como o terminal foi aberto), e o sintoma é um
ModuleNotFoundError diferente a cada execução.
"""
import importlib
import io
import os
import site
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8",
                              errors="replace")

CRED = r"C:\Users\m1590850\OneDrive\Área de Trabalho\Projetos do Claude\focos-calor-mg\credenciais_portal.txt"

# (módulo, para que serve, instalável por pip)
MODULOS = [
    ("numpy", "malha e tiles", False),
    ("arcgis", "falar com o Portal", False),
    ("osgeo.gdal", "ler os COGs de uso do solo", False),
    ("PIL", "gravar os tiles PNG", False),
    ("matplotlib", "contar classes por polígono", False),
    ("shapely", "geometria do backfill", True),
    ("ee", "Earth Engine (histórico)", True),
]

PIP = {"shapely": "shapely", "ee": "earthengine-api"}


def cabeca(t):
    print("\n" + t)
    print("-" * len(t))


print("=" * 62)
print("  AMBIENTE — Areas Queimadas 9 Municípios")
print("=" * 62)
print("python:", sys.executable)
print("versao:", sys.version.split()[0])

us = site.getusersitepackages()
us = us if isinstance(us, str) else (us[0] if us else "")
no_path = us in sys.path
print("site-packages do usuario:", us)
print("  existe:", os.path.isdir(us), "· no sys.path:", no_path)
if os.path.isdir(us) and not no_path:
    print("  AVISO: existe mas NAO esta no sys.path — os scripts do projeto")
    print("         acrescentam sozinhos; comandos avulsos podem falhar.")
    sys.path.append(us)

cabeca("BIBLIOTECAS")
faltando = []
for mod, para, pipavel in MODULOS:
    try:
        importlib.import_module(mod)
        print("  OK   %-14s %s" % (mod, para))
    except Exception as e:
        print("  FALTA %-13s %s  (%s)" % (mod, para, str(e)[:40]))
        faltando.append((mod, pipavel))

cabeca("CREDENCIAIS DO PORTAL")
if os.path.isfile(CRED):
    chaves = set()
    for line in open(CRED, encoding="utf-8-sig"):
        if "=" in line:
            chaves.add(line.split("=", 1)[0].strip().lower())
    ok = {"portal", "usuario", "senha"} <= chaves
    print("  arquivo encontrado ·", "completo" if ok
          else "FALTAM chaves: " + str({"portal", "usuario", "senha"} - chaves))
else:
    print("  NAO ENCONTRADO:", CRED)
    print("  crie com tres linhas: portal= / usuario= / senha=")

cabeca("EARTH ENGINE")
cred_ee = os.path.join(os.path.expanduser("~"), ".config", "earthengine",
                       "credentials")
if os.path.isfile(cred_ee):
    print("  credencial encontrada")
else:
    print("  NAO autenticado. Rode num terminal interativo:")
    print('    "%s" -c "import ee; ee.Authenticate()"' % sys.executable)

cabeca("O QUE FAZER")
pipaveis = [m for m, p in faltando if p]
if pipaveis:
    print('  "%s" -m pip install --user %s'
          % (sys.executable, " ".join(PIP.get(m, m) for m in pipaveis)))
nao_pip = [m for m, p in faltando if not p]
if nao_pip:
    print("  %s deveria vir com o ArcGIS Pro — confira se esta usando o"
          " python do Pro" % ", ".join(nao_pip))
if not faltando and os.path.isfile(CRED) and os.path.isfile(cred_ee):
    print("  Tudo pronto. Proximo passo:")
    print("    python infra/30_estado.py        (em que pe esta)")
    print("    python plano/backfill_gee.py --paralelo 3   (rodar o historico)")
