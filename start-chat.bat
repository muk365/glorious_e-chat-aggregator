@echo off
title Glorious_E Multi-Chat Aggregator
echo =======================================================
echo  Starting Glorious_E Unified Multi-Chat Aggregator
echo =======================================================
echo.
start /B node "%~dp0bridge.js"
timeout /t 1 /nobreak >nul
start http://localhost/chat-aggregator-baba/
echo App opened at http://localhost/chat-aggregator-baba/
exit

