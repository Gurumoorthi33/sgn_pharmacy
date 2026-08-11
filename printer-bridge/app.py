"""
SGN Token System - Local print bridge for the Zebra ZD230.

Run this small FastAPI service on the same Windows PC that the ZD230 is
attached to. The dispensing screen POSTs the token data here and this service
prints it silently (no browser dialog), as many copies as requested.

Two print paths:

* ZPL (recommended - crisp, instant): POST JSON to /api/print/zpl/ with
  {"hospital": "...", "token_number": 4, "copies": 2} (or a raw
  {"zpl": "^XA^FO50,50^A0N,100,100^FDTOKEN 4^FS^XZ"} for full control).
  The bridge builds the ZPL label-format program and sends the raw bytes
  straight to the printer - either through the Windows ZPL driver queue via
  win32print, or directly over TCP to the printer's 9100 port. Because the
  ZD230 rasterizes ZPL itself at 203 dpi there is no browser scaling, so text
  is always sharp and each label is exactly one sticker.

* Image (legacy): POST a PNG to /api/print/ (multipart form "image" file +
  "copies" field). Kept for backwards compatibility.

Setup (Windows):
    uv venv --python 3.12
    uv pip install --python .venv\\Scripts\\python.exe -r requirements-windows.txt
    set PRINTER_NAME=ZDesigner ZD230-203dpi ZPL
    set UPLOAD_FOLDER=C:\\sgn-prints
    uv run app.py

Non-Windows (dev/testing only - the ZD230 needs Windows):
    uv venv --python 3.12
    uv pip install --python .venv/bin/python -r requirements.txt
    uv run app.py   # /health works; printing reports "not available"

Environment (ZPL path):
    PRINTER_NAME    Windows queue for the ZD230. For the best result install
                    Zebra's "ZDesigner ZD230-203dpi ZPL" driver and set this
                    to that queue name.
    PRINTER_HOST    Optional IP/hostname of a networked ZD230. When set, the
                    bridge sends raw ZPL to PRINTER_PORT (default 9100)
                    instead of using win32print.
    PRINTER_PORT    Raw socket port for PRINTER_HOST (default 9100).
    PRINTER_DPI     203 for the standard ZD230.
    ZPL_WIDTH_MM    Physical label width in mm (default 50 - standard 2" roll).
    ZPL_HEIGHT_MM   Physical label height in mm (default 25).
    UPLOAD_FOLDER   Scratch dir for the legacy image path.
    BRIDGE_HOST     Bind address (default 0.0.0.0). Use 127.0.0.1 for this PC only.
    BRIDGE_PORT     Port (default 5000).

Then launch Chrome pointing at the deployed app over HTTP on the kiosk, or set
NEXT_PUBLIC_PRINT_BRIDGE_URL to http://localhost:5000 in the web app.

The service binds to 0.0.0.0 by default so it is reachable from other devices
on the LAN too. If you access the web app from another device, set
NEXT_PUBLIC_PRINT_BRIDGE_URL to http://<THIS_PC_LAN_IP>:5000 instead of
localhost and allow port 5000 through the Windows firewall.
"""

import os
import re
import shutil
import socket
import subprocess

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# --- Windows printing capabilities -------------------------------------
# ZPL raw printing only needs pywin32's win32print.
try:
    import win32print

    ZPL_WINDOWS = True
except Exception:  # pragma: no cover - non-Windows dev machines
    ZPL_WINDOWS = False

# The legacy image path additionally needs win32ui/win32con/win32gui + PIL.
try:
    import win32ui
    import win32con
    import win32gui
    from PIL import Image, ImageWin

    IMAGE_WINDOWS = True
except Exception:  # pragma: no cover - non-Windows dev machines
    IMAGE_WINDOWS = False

app = FastAPI(title="SGN Token Print Bridge", version="1.1.0")
# Allow the browser (any origin, since this is a localhost-only helper) to call us.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Configuration -------------------------------------------------------
UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", os.path.join(os.getcwd(), "sgn-prints"))
PRINTER_NAME = os.environ.get("PRINTER_NAME", "")
PRINTER_HOST = os.environ.get("PRINTER_HOST", "")
PRINTER_PORT = int(os.environ.get("PRINTER_PORT", "9100"))
PRINTER_DPI = int(os.environ.get("PRINTER_DPI", "203"))
ZPL_WIDTH_MM = int(os.environ.get("ZPL_WIDTH_MM", "50"))
ZPL_HEIGHT_MM = int(os.environ.get("ZPL_HEIGHT_MM", "25"))

os.makedirs(UPLOAD_FOLDER, exist_ok=True)


# --- ZPL helpers ---------------------------------------------------------
def zpl_escape(text: str) -> str:
    """Strip control/Unicode chars ZPL cannot render and neutralise reserved
    characters (^ and ~ are ZPL commands)."""
    ascii_only = re.sub(r"[^ -~]", " ", text)
    return ascii_only.replace("^", " ").replace("~", " ").strip()


def build_token_zpl(
    hospital: str,
    token_number: int,
    width_mm: int = ZPL_WIDTH_MM,
    height_mm: int = ZPL_HEIGHT_MM,
    dpi: int = PRINTER_DPI,
) -> str:
    """Build a centred 50x25mm (or custom) ZPL label.

    Layout is sized from the physical label dimensions so it holds for any
    label stock; all coordinates are in dots (203 dpi => 400x200 for 50x25mm).
    """
    pw = round((width_mm / 25.4) * dpi)  # print width in dots
    ph = round((height_mm / 25.4) * dpi)  # label height in dots
    margin = max(4, round((1.5 / 25.4) * dpi))  # ~1.5mm quiet margin
    usable = pw - (2 * margin)

    hospital_h = round(ph * 0.11)
    caption_h = round(ph * 0.10)
    number_h = round(ph * 0.44)
    gap = round(ph * 0.03)

    y1 = margin
    y2 = y1 + hospital_h + gap
    y3 = y2 + caption_h + gap

    hospital_s = zpl_escape(hospital)
    number_s = zpl_escape(str(int(token_number)))

    zpl = (
        "^XA"
        f"^PW{pw}"
        f"^LL{ph}"
        f"^LH0,0"
        # Hospital name (wraps up to 2 lines, centred)
        f"^FO{margin},{y1}^FB{usable},2,{gap},C^A0N,{hospital_h},{hospital_h}^FD{hospital_s}^FS"
        # "TOKEN" caption, centred
        f"^FO{margin},{y2}^FB{usable},1,{gap},C^A0N,{caption_h},{caption_h}^FDTOKEN^FS"
        # Big token number, centred
        f"^FO{margin},{y3}^FB{usable},1,0,C^A0N,{number_h},{number_h}^FD{number_s}^FS"
        "^XZ"
    )
    return zpl


# --- ZPL output backends -------------------------------------------------
def print_zpl_win32(zpl: bytes, copies: int = 1) -> None:
    """Send raw ZPL bytes to the Windows ZPL driver queue (no re-rendering)."""
    if not ZPL_WINDOWS:
        raise RuntimeError("win32print not available on this machine.")
    if not PRINTER_NAME:
        raise RuntimeError("PRINTER_NAME is not set.")

    hprinter = win32print.OpenPrinter(PRINTER_NAME)
    try:
        win32print.StartDocPrinter(hprinter, 1, ("SGN Token", None, "RAW"))
        try:
            for _ in range(max(1, copies)):
                win32print.WritePrinter(hprinter, zpl)
        finally:
            win32print.EndDocPrinter(hprinter)
    finally:
        win32print.ClosePrinter(hprinter)


def print_zpl_socket(zpl: bytes, copies: int = 1) -> None:
    """Send raw ZPL to a networked Zebra over its native port 9100."""
    if not PRINTER_HOST:
        raise RuntimeError("PRINTER_HOST is not set.")

    with socket.create_connection((PRINTER_HOST, PRINTER_PORT), timeout=5) as sock:
        for _ in range(max(1, copies)):
            sock.sendall(zpl)


def print_zpl_cups(zpl: bytes, copies: int = 1) -> None:
    """Send raw ZPL to a CUPS queue on Linux (USB-attached Zebra).

    Uses `lp -d <queue> -o raw` so the job passes straight through the spooler
    to the printer without any filtering - the ZD230 rasterizes the ZPL itself.
    The CUPS queue name is usually e.g. "ZTC-ZD230-203dpi-ZPL".
    """
    lp = shutil.which("lp")
    if not lp:
        raise RuntimeError("'lp' (CUPS) not found on this machine.")
    if not PRINTER_NAME:
        raise RuntimeError("PRINTER_NAME is not set.")

    for _ in range(max(1, copies)):
        proc = subprocess.run(
            [lp, "-d", PRINTER_NAME, "-o", "raw"],
            input=zpl,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            check=False,
        )
        if proc.returncode != 0:
            detail = proc.stderr.decode(errors="replace").strip()
            raise RuntimeError(detail or f"lp command failed (exit {proc.returncode})")


# --- Legacy image path (unchanged behaviour) -----------------------------
def print_image(image_path: str, printer_name: str, copies: int = 1) -> None:
    if not IMAGE_WINDOWS:
        raise RuntimeError("Windows printing libraries not available on this machine.")

    # Physical label size in millimetres (matches ZPL_WIDTH_MM/ZPL_HEIGHT_MM).
    LABEL_MM = (ZPL_WIDTH_MM, ZPL_HEIGHT_MM)

    hprinter = win32print.OpenPrinter(printer_name)
    try:
        img = Image.open(image_path)
        if img.mode != "RGB":
            img = img.convert("RGB")

        for _ in range(max(1, copies)):
            pdc = win32ui.CreateDC()
            pdc.CreatePrinterDC(printer_name)
            hdc = pdc.GetHandleOutput()
            dpi_x = win32gui.GetDeviceCaps(hdc, win32con.LOGPIXELSX)
            dpi_y = win32gui.GetDeviceCaps(hdc, win32con.LOGPIXELSY)

            w = round((LABEL_MM[0] / 25.4) * dpi_x)
            h = round((LABEL_MM[1] / 25.4) * dpi_y)
            scaled = img.resize((w, h), Image.LANCZOS)

            pdc.StartDoc("SGN Token")
            pdc.StartPage()
            dib = ImageWin.Dib(scaled)
            dib.draw(hdc, (0, 0, w, h))
            pdc.EndPage()
            pdc.EndDoc()
            pdc.DeleteDC()
    finally:
        win32print.ClosePrinter(hprinter)


# --- Routes ---------------------------------------------------------------
@app.get("/health")
def health():
    return {
        "ok": True,
        "printer": PRINTER_NAME,
        "printer_host": PRINTER_HOST or None,
        "backend": (
            "socket"
            if PRINTER_HOST
            else "win32print"
            if (PRINTER_NAME and ZPL_WINDOWS)
            else "cups-lp"
            if (PRINTER_NAME and shutil.which("lp"))
            else "none"
        ),
        "zpl_windows": ZPL_WINDOWS,
        "image_windows": IMAGE_WINDOWS,
        "lp_available": bool(shutil.which("lp")),
        "label_mm": [ZPL_WIDTH_MM, ZPL_HEIGHT_MM],
        "dpi": PRINTER_DPI,
    }


class ZplRequest(BaseModel):
    zpl: str | None = None
    token_number: int | None = None
    hospital: str = ""
    copies: int = 2


@app.post("/api/print/zpl/")
def print_zpl_api(payload: ZplRequest):
    copies = max(1, payload.copies)

    if payload.zpl:
        # Raw ZPL passthrough for full control / testing.
        zpl = payload.zpl.encode("ascii", errors="replace")
    else:
        if payload.token_number is None:
            raise HTTPException(status_code=400, detail="Provide either 'zpl' or 'token_number'.")
        zpl = build_token_zpl(payload.hospital, payload.token_number).encode("ascii", errors="replace")

    try:
        if PRINTER_HOST:
            print_zpl_socket(zpl, copies=copies)
            backend = "socket"
        elif PRINTER_NAME and ZPL_WINDOWS:
            print_zpl_win32(zpl, copies=copies)
            backend = "win32print"
        elif PRINTER_NAME:
            print_zpl_cups(zpl, copies=copies)
            backend = "cups-lp"
        else:
            raise HTTPException(
                status_code=500,
                detail="Set PRINTER_NAME (CUPS queue name on Linux, e.g. ZTC-ZD230-203dpi-ZPL, "
                "or the Windows ZPL driver queue) - or PRINTER_HOST for a networked ZD230.",
            )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {"ok": True, "copies": copies, "backend": backend}


@app.post("/api/print/")
async def print_api(
    image: UploadFile = File(...),
    copies: int = Form(2),
):
    if image.filename == "":
        raise HTTPException(status_code=400, detail="No selected file")

    file_path = os.path.join(UPLOAD_FOLDER, "print.png")
    with open(file_path, "wb") as out:
        shutil.copyfileobj(image.file, out)

    try:
        print_image(file_path, PRINTER_NAME, copies=copies)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {"ok": True, "copies": copies}


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("BRIDGE_HOST", "0.0.0.0")
    port = int(os.environ.get("BRIDGE_PORT", "5000"))
    uvicorn.run(app, host=host, port=port)
