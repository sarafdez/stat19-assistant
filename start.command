#!/bin/bash
# Dobbeltklikk denne for å starte Stat19-assistenten.
# Lukk terminalvinduet (eller Ctrl+C) for å stoppe.
cd "$(dirname "$0")" || exit 1

if [ ! -d app/node_modules ]; then
  echo "Første gang: kjører oppsett…"
  node setup.mjs || exit 1
fi

(sleep 3 && open http://localhost:5178) &
echo "Starter… nettleseren åpnes på http://localhost:5178"
cd app && npm run dev
