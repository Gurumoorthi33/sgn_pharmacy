#!/bin/bash
# print a side-by-side token batch (1, 9, 10, 11, 99) through the bridge so you
# can verify every token number prints at the identical size and stroke weight.
#   * With PRINTER_HOST set (mock) it captures the ZPL under sgn-prints/.
#   * On the printer PC against the real ZD230 it prints 2 copies of each label.
set -e
cd "$(dirname "$0")"
BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:5000}"
HOSPITAL="${HOSPITAL:-SRM Medical College Hospital}"

for n in 1 9 10 11 99; do
  echo "--- token $n ---"
  curl -s -X POST "$BRIDGE_URL/api/print/zpl/" \
    -H 'Content-Type: application/json' \
    -d "{\"hospital\":\"$HOSPITAL\",\"token_number\":$n,\"copies\":2}"; echo
done