#!/bin/bash
# end-to-end test: mock printer -> bridge -> captured ZPL
set -e
cd "$(dirname "$0")"
MOCK_PORT=9101

# stop any leftover bridge / mock from earlier runs
pkill -f "mock_printer.py" 2>/dev/null || true
fuser -k 5000/tcp 2>/dev/null || true
sleep 0.5

.venv/bin/python -u mock_printer.py --host 127.0.0.1 --port "$MOCK_PORT" --labelary \
  > /tmp/opencode/mock.log 2>&1 &
MOCK_PID=$!

PRINTER_HOST=127.0.0.1 PRINTER_PORT="$MOCK_PORT" BRIDGE_PORT=5000 \
  .venv/bin/python app.py > /tmp/opencode/bridge.log 2>&1 &
BRIDGE_PID=$!

sleep 2.5

echo "--- bridge health ---"
curl -s http://127.0.0.1:5000/health; echo

echo "--- POST token 4 x2 ---"
curl -s -X POST http://127.0.0.1:5000/api/print/zpl/ \
  -H 'Content-Type: application/json' \
  -d '{"hospital":"SRM Medical College Hospital","token_number":4,"copies":2}'; echo

echo "--- waiting for Labelary preview (up to 25s) ---"
for i in $(seq 1 50); do
  ls sgn-prints/zpl_*.png >/dev/null 2>&1 && break
  [ "$i" -eq 50 ] && echo "(preview did not appear)"
  sleep 0.5
done

echo "--- bridge log tail ---"
tail -3 /tmp/opencode/bridge.log || true

echo "--- mock printer log ---"
cat /tmp/opencode/mock.log || true

echo "--- captured ZPL file ---"
CAPTURED=$(ls -t sgn-prints/zpl_*.txt 2>/dev/null | head -1 || true)
if [ -n "$CAPTURED" ]; then
  echo "file: $CAPTURED"
  cat "$CAPTURED"
else
  echo "(no capture)"
fi

echo "--- PNG preview ---"
PNG=$(ls -t sgn-prints/zpl_*.png 2>/dev/null | head -1 || true)
[ -n "$PNG" ] && echo "file: $PNG ($(stat -c%s "$PNG") bytes)" || echo "(no png - see mock log)"

kill $BRIDGE_PID $MOCK_PID 2>/dev/null || true