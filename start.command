#!/bin/bash
# Dobbeltklikk denne for å starte Stat19-assistenten. Ctrl+C for å stoppe.
cd "$(dirname "$0")" || exit 1
exec node start.mjs
