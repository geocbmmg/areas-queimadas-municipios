@echo off
REM Interpretador correto do projeto: o Python do ArcGIS Pro, que ja tem
REM gdal, numpy, PIL, shapely, requests, ee e arcgis instalados.
REM O "python" do PATH desta maquina e a venv do Hermes Agent e NAO serve.
set PYEXE=C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe
if not exist "%PYEXE%" (
  echo [ERRO] Python do ArcGIS Pro nao encontrado em: %PYEXE%
  exit /b 1
)
"%PYEXE%" %*
