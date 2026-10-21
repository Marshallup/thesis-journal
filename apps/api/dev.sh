#!/bin/sh
# Горячая перезагрузка без Nest CLI: на TypeScript 7 он не работает вовсе —
# `nest build` и `nest start --watch` упираются в отсутствующий программный API
# компилятора (docs/unknowns.md, запись «Nest CLI и TypeScript 7»). Петля
# собрана из двух штатных вотчеров: tsc пересобирает dist, node перезапускает
# процесс, когда dist меняется.
set -e

# Первая сборка до вотчеров: `node --watch` на несуществующем файле стартует с
# ошибки, и первое, что видит человек, — стек вместо запущенного сервера.
tsc -p tsconfig.build.json

# --preserveWatchOutput обязателен: иначе tsc чистит экран на каждой пересборке
# и уносит с ним логи сервера, ради которых dev-режим и запускают.
tsc -p tsconfig.build.json --watch --preserveWatchOutput &
compiler=$!

# Без этого вотчер компилятора переживёт Ctrl-C и продолжит писать в dist уже
# после того, как человек закрыл сервер.
trap 'kill "$compiler" 2>/dev/null' EXIT INT TERM

node --watch dist/main.js
