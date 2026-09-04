# -*- coding: utf-8 -*-
"""
Registra os redirect URIs deste monitor no app OAuth do Portal.

Sem isto o "Entrar" devolve `invalid_request: redirect_uri` — o Portal só
aceita voltar para endereços que ele conhece. O app é o mesmo da
Calculadora e do monitor das UCs (appId nRFBQ8adfZIqHm56); aqui só
ACRESCENTAMOS os endereços novos, nunca substituímos a lista.

Uso:
    python 21_registrar_redirect.py https://monitor-queimadas-mg.vercel.app
"""
import sys, io, json, urllib3

urllib3.disable_warnings()
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

CRED = r"C:\Users\m1590850\OneDrive\Área de Trabalho\Projetos do Claude\focos-calor-mg\credenciais_portal.txt"
APP_ID = "nRFBQ8adfZIqHm56"


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    novos = []
    for base in sys.argv[1:]:
        base = base.rstrip("/")
        novos += [base, base + "/", base + "/index.html"]
    novos += ["http://localhost:8000", "http://localhost:8000/",
              "http://127.0.0.1:8000", "http://127.0.0.1:8000/"]

    cfg = {}
    for line in open(CRED, encoding="utf-8-sig"):
        if "=" in line:
            k, v = line.strip().split("=", 1)
            cfg[k.strip().lower()] = v.strip()

    from arcgis.gis import GIS
    gis = GIS(cfg["portal"], cfg["usuario"], cfg["senha"], verify_cert=False)
    print("conectado:", gis.users.me.username)

    portal = gis._portal
    info = portal.con.post(
        "oauth2/apps/%s" % APP_ID, {"f": "json"}, ssl=True)
    atuais = info.get("redirect_uris", []) or []
    print("redirect URIs hoje:", len(atuais))

    final = list(atuais)
    for u in novos:
        if u not in final:
            final.append(u)
            print("  + ", u)
    if len(final) == len(atuais):
        print("[NADA A FAZER] todos já registrados")
        return

    r = portal.con.post(
        "content/users/%s/items/%s/registeredAppInfo/update"
        % (info.get("owner", gis.users.me.username), info.get("itemId", APP_ID)),
        {"f": "json", "redirect_uris": json.dumps(final)}, ssl=True)
    print("resposta:", r)


main()
