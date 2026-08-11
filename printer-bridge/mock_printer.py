"""
Mock Zebra ZD230 for testing on Linux without physical hardware.

Listens on the standard Zebra raw port (9100) and captures every raw ZPL
payload the bridge sends, saving it under sgn-prints/ so you can inspect the
command string, then optionally render it to a PNG via the Labelary ZPL
viewer (--labelary) to check the label design visually.

Usage (terminal 1 - mock printer):
    python mock_printer.py [--host 127.0.0.1] [--port 9100] [--labelary]

Then start the bridge with the socket backend (terminal 2):
    PRINTER_HOST=127.0.0.1 .venv/bin/python app.py

Then open the web app and hit "Generate & Print Token". Every job is saved to
printer-bridge/sgn-prints/zpl_<n>.txt (and zpl_<n>.png when --labelary works).
"""

import argparse
import datetime as dt
import os
import socketserver

UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", os.path.join(os.getcwd(), "sgn-prints"))
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# ZPL commands start at "^XA" and end at "^XZ" - split on those boundaries so
# one received payload (which may contain several copies) is split per label.
FORMAT_START = "^XA"
FORMAT_END = "^XZ"


def split_zpl_formats(payload: bytes) -> list[str]:
    text = payload.decode("ascii", errors="replace")
    formats: list[str] = []
    start = 0
    while True:
        begin = text.find(FORMAT_START, start)
        if begin == -1:
            break
        end = text.find(FORMAT_END, begin) + len(FORMAT_END)
        if end < 0:
            break
        formats.append(text[begin:end])
        start = end
    return formats


def render_to_png(zpl: str, out_path: str, width_mm: int = 50, height_mm: int = 25) -> bool:
    """Render ZPL to PNG via the free Labelary viewer (needs internet + requests)."""
    try:
        import requests
    except ImportError:
        print("  [labelary] 'requests' not installed - pip install requests"
              " is needed for PNG preview, skipping.")
        return False

    dpmm = 8  # == 203 dpi, the ZD230's native resolution
    url = (
        f"https://api.labelary.com/v1/printers/{dpmm}dpmm/labels/"
        f"{(width_mm / 25.4):.6f}x{(height_mm / 25.4):.6f}/0/"
    )
    try:
        resp = requests.post(
            url,
            files={"file": ("label.zpl", zpl.encode("ascii"))},
            headers={"Accept": "image/png"},
            timeout=20,
        )
    except Exception as exc:  # noqa: BLE001 - offline / blocked
        print(f"  [labelary] render failed: {exc}")
        return False
    if resp.status_code != 200:
        print(f"  [labelary] render failed: HTTP {resp.status_code}")
        return False
    with open(out_path, "wb") as f:
        f.write(resp.content)
    return True


class ZplHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        chunks = bytearray()
        while chunk := self.request.recv(4096):
            chunks.extend(chunk)
            # Raw Zebra connections often linger open; treat a short pause
            # followed by silence as end-of-job.
            self.request.settimeout(0.5)
            try:
                while self.request.recv(4096):
                    pass
            except OSError:
                pass
            break

        payload = bytes(chunks)
        now = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        idx = dt.datetime.now().microsecond
        base = f"zpl_{now}_{idx:06d}"
        fmt_path = os.path.join(UPLOAD_FOLDER, f"{base}.txt")

        formats = split_zpl_formats(payload)
        with open(fmt_path, "w", encoding="ascii", errors="replace") as f:
            f.write(payload.decode("ascii", errors="replace"))

        print(
            f"\n=== ZPL job captured from {self.client_address[0]}:{self.client_address[1]} "
            f"=>> {fmt_path}"
        )
        print(f"    {len(payload)} bytes, {len(formats)} label format(s)")
        if not formats:
            print("    (payload did not look like ZPL - raw bytes saved anyway)")

        if args.labelary and formats:
            png_path = os.path.join(UPLOAD_FOLDER, f"{base}.png")
            if render_to_png(formats[-1], png_path):
                print(f"    preview: {png_path}")
        print("    waiting for next job...\n")


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Mock Zebra ZD230 raw socket (9100).")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9100)
    parser.add_argument(
        "--labelary",
        action="store_true",
        help="render captured ZPL to PNG via the Labelary viewer (needs internet + requests)",
    )
    args = parser.parse_args()

    with Server((args.host, args.port), ZplHandler) as server:
        print(f"Mock ZD230 listening on {args.host}:{args.port} (raw ZPL).")
        print(f"Start the bridge with: PRINTER_HOST={args.host} .venv/bin/python app.py")
        print(f"Captures go to: {UPLOAD_FOLDER}")
        print("Ctrl+C to stop.\n")
        server.serve_forever()