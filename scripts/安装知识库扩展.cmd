@echo off
setlocal
if not exist "%~dp0runtime\python.exe" (
  echo Runtime folder is missing. Extract the complete release ZIP first.
  pause
  exit /b 1
)
echo Close tebb before installing. This downloads the CPU retrieval dependencies.
"%~dp0runtime\python.exe" -m pip install --no-build-isolation torch --index-url https://download.pytorch.org/whl/cpu
if errorlevel 1 goto failed
"%~dp0runtime\python.exe" -m pip install --no-build-isolation sentence-transformers
if errorlevel 1 goto failed
echo Installation complete. Restart tebb, then download models in the Knowledge page.
pause
exit /b 0
:failed
echo Installation failed. Check the messages above and your internet connection, then retry.
pause
exit /b 1
