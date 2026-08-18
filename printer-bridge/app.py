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
import time

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


# Font A (Swiss 721 Bold Condensed) per-character advance widths in dots,
# measured at 203 dpi on the ZPL engine itself at the reference size W=H=100
# (render each char individually via api.labelary.com and subtract the single-
# char bounding box from the double-char one). Advances scale linearly with the
# ^A0N,h,h font height, so a width at any size is advance * h / 100.
FONT_A_ADVANCE = {
    " ": 30, "!": 29, '"': 48, "#": 48, "$": 48, "%": 90, "&": 61, "'": 29,
    "(": 29, ")": 29, "*": 48, "+": 90, ",": 29, "-": 90, ".": 29, "/": 29,
    "0": 48, "1": 48, "2": 48, "3": 48, "4": 48, "5": 48, "6": 48, "7": 48,
    "8": 48, "9": 48, ":": 29, ";": 29, "<": 100, "=": 90, ">": 100, "?": 44,
    "@": 90, "A": 55, "B": 55, "C": 53, "D": 59, "E": 50, "F": 50, "G": 59,
    "H": 61, "I": 28, "J": 44, "K": 55, "L": 48, "M": 76, "N": 61, "O": 57,
    "P": 55, "Q": 57, "R": 59, "S": 53, "T": 50, "U": 61, "V": 53, "W": 81,
    "X": 55, "Y": 55, "Z": 50, "[": 29, "\\": 48, "]": 29, "^": 0, "_": 50,
    "`": 29, "a": 46, "b": 50, "c": 44, "d": 50, "e": 48, "f": 28, "g": 50,
    "h": 50, "i": 26, "j": 26, "k": 44, "l": 26, "m": 76, "n": 50, "o": 48,
    "p": 50, "q": 50, "r": 33, "s": 42, "t": 28, "u": 50, "v": 44, "w": 66,
    "x": 44, "y": 44, "z": 39, "{": 50, "|": 50, "}": 50, "~": 0,
}
# Fallback advance (upper-mid "0"/"n") for any char outside the table.
FONT_A_DEFAULT_ADVANCE = 48

# Token-number font: a SINGLE fixed size for every token number. This is the
# height/weight that prints the approved "10" look, and a single-digit "1" must
# render at exactly the same size and stroke weight - never a smaller, thinner
# version. The token number is only ever scaled down when it has at least this
# many digits AND would overflow the label width at full size; a hospital's
# daily token count (1-3 digits) never reaches it, so 1-3 digit numbers always
# keep the standard size. A 50x25mm label at 203 dpi fits ~8 digits at the
# standard height, so this guard is effectively unreachable in practice.
TOKEN_NUMBER_MIN_SHRINK_DIGITS = 4


def font_a_width(text: str, height: int) -> int:
    """Rendered width in dots of `text` at font-A `height` (W=H)."""
    return sum(
        round(FONT_A_ADVANCE.get(c, FONT_A_DEFAULT_ADVANCE) * height / 100.0)
        for c in text
    )


def wrap_lines(text: str, usable: int, height: int) -> list[str]:
    """Greedy word-wrap matching the ZPL ^FB field-block engine, so the line
    count we compute is the line count the printer actually renders.

    A word fits on the current line if the current width + a space + the word
    stays within the field-block width; otherwise it starts a new line.
    """
    words = text.split()
    if not words:
        return [""]
    space_w = font_a_width(" ", height)
    lines: list[str] = []
    cur = ""
    cur_w = 0
    for word in words:
        word_w = font_a_width(word, height)
        sep = space_w if cur else 0
        if cur and cur_w + sep + word_w > usable:
            lines.append(cur)
            cur = word
            cur_w = word_w
        else:
            cur = cur + " " + word if cur else word
            cur_w += sep + word_w
    if cur:
        lines.append(cur)
    return lines


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

    Every block's Y is computed from the actual rendered height of the block
    above it: the hospital name is wrapped with the printer's own font-A
    metrics (see FONT_A_ADVANCE), so when it wraps to two lines the "TOKEN"
    caption and the number shift down by exactly that wrapped height instead of
    overlapping the second hospital line. The first block starts a couple of mm
    below the physical top edge (top_offset) so the origin drift some printers
    have does not clip the top line.
    """
    pw = round((width_mm / 25.4) * dpi)  # print width in dots
    ph = round((height_mm / 25.4) * dpi)  # label height in dots
    margin = max(4, round((1.5 / 25.4) * dpi))  # ~1.5mm quiet margin
    usable = pw - (2 * margin)
    gap = max(4, round((0.6 / 25.4) * dpi))  # ~0.6mm between blocks / FB lines
    # Extra top padding for the first (hospital) block only. On some printers the
    # sensor-calibrated origin sits slightly above the physical top edge, so a
    # ~2.5mm (20-dot) cushion keeps the top line clear of clipping.
    top_offset = round((2.5 / 25.4) * dpi)

    hospital_h = round(ph * 0.09)
    caption_h = round(ph * 0.10)

    hospital_s = zpl_escape(hospital)
    number_s = zpl_escape(str(int(token_number)))

    # Token number: one fixed size for EVERY token number - this is what prints
    # the approved "10" look. No digit-count-dependent auto-fit: a single-digit
    # "1" must render at the identical size and bold stroke as "10" (Font A is
    # proportional, so the ^A0N width slot is a no-op, but h == w mirrors the
    # approved label). We only deviate when the number is BOTH at least
    # TOKEN_NUMBER_MIN_SHRINK_DIGITS digits long AND overflows the label width
    # at full size - then the height is scaled proportionally so the widest
    # digit still fits without truncation. 1-3 digit tokens always keep the
    # standard size; they are never shrunk.
    number_h = round(ph * 0.44)
    number_w = number_h
    if len(number_s) >= TOKEN_NUMBER_MIN_SHRINK_DIGITS:
        full_width = font_a_width(number_s, number_h)
        if full_width > usable:
            number_h = max(round(number_h * usable / full_width), 1)
            number_w = number_h

    # How many lines the hospital name really occupies on the label width.
    n_lines = len(wrap_lines(hospital_s, usable, hospital_h))
    if n_lines > 2:
        # A 50x25mm label cannot hold 3 hospital lines plus the big number;
        # the ^FB field truncates the tail (unchanged behaviour) but the blocks
        # below never overlap because they are positioned after 2 full lines.
        n_lines = 2
    # Rendered height of the hospital ^FB block: one font-height cell per line
    # plus the inter-line gap (this is how the FB block advances its lines).
    hospital_block_h = n_lines * hospital_h + (n_lines - 1) * gap

    y1 = margin + top_offset
    y2 = y1 + hospital_block_h + gap
    y3 = y2 + caption_h + gap

    zpl = (
        "^XA"
        f"^PW{pw}"
        f"^LL{ph}"
        f"^LH0,0"
        # Hospital name (wraps across n_lines, centred, auto-wrapped with the
        # printer's own font-A metrics)
        f"^FO{margin},{y1}^FB{usable},{n_lines},{gap},C^A0N,{hospital_h},{hospital_h}^FD{hospital_s}^FS"
        # "TOKEN" caption, centred, below the hospital block's rendered height
        f"^FO{margin},{y2}^FB{usable},1,{gap},C^A0N,{caption_h},{caption_h}^FDTOKEN^FS"
        # Big token number, centred, fixed size for every token number
        f"^FO{margin},{y3}^FB{usable},1,0,C^A0N,{number_h},{number_w}^FD{number_s}^FS"
        "^XZ"
    )
    return zpl


# --- ZPL output backends -------------------------------------------------
def ensure_win32_printer_ready(printer: str) -> None:
    """Fail loudly if the Windows queue cannot physically print right now.

    OpenPrinter/WritePrinter succeed even when the queue is offline or paused -
    the job just sits in the spooler - so the bridge would otherwise report
    success while nothing prints. Check the spooler status flags first.
    """
    if not ZPL_WINDOWS:
        raise RuntimeError("win32print not available on this machine.")
    hprinter = win32print.OpenPrinter(printer)
    try:
        info = win32print.GetPrinter(hprinter, 2)
    finally:
        win32print.ClosePrinter(hprinter)
    status = info.get("Status", 0)
    if status & getattr(win32print, "PRINTER_STATUS_OFFLINE", 0):
        raise RuntimeError(f"printer '{printer}' is offline - check its power and connection")
    if status & getattr(win32print, "PRINTER_STATUS_PAUSED", 0):
        raise RuntimeError(f"printer '{printer}' is paused in the Windows spooler")
    if status & getattr(win32print, "PRINTER_STATUS_OUT_OF_PAPER", 0):
        raise RuntimeError(f"printer '{printer}' is out of label media")
    if status & getattr(win32print, "PRINTER_STATUS_ERROR", 0):
        raise RuntimeError(f"printer '{printer}' is in an error state")


def print_zpl_win32(zpl: bytes, copies: int = 1) -> None:
    """Send raw ZPL bytes to the Windows ZPL driver queue (no re-rendering)."""
    if not ZPL_WINDOWS:
        raise RuntimeError("win32print not available on this machine.")
    if not PRINTER_NAME:
        raise RuntimeError("PRINTER_NAME is not set.")

    ensure_win32_printer_ready(PRINTER_NAME)

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


def cups_printer_status(printer: str) -> str:
    """Raw `lpstat -p <printer>` status text ("" when unknown).

    Example healthy output:
        printer ZTC-ZD230-203dpi-ZPL is idle.  enabled since ...
    When the physical device is missing the queue shows:
        printer ZTC-ZD230-203dpi-ZPL now printing ZTC-ZD230-203dpi-ZPL-177.
                Waiting for printer to become available.
    """
    lpstat = shutil.which("lpstat")
    if not lpstat:
        return ""
    proc = subprocess.run([lpstat, "-p", printer], capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        return ""
    return proc.stdout.strip()


def cups_printer_ready(printer: str) -> tuple[bool, str]:
    """True only when CUPS can actually reach the physical printer.

    CUPS accepts jobs into the spool even when the device is unplugged/off,
    silently holding them ("Waiting for printer to become available") and the
    bridge would otherwise report success. Detect that state up front so the
    print fails loudly instead of looking like it worked.
    """
    status = cups_printer_status(printer)
    if not status:
        return False, (
            f"printer '{printer}' was not found in CUPS - check 'lpstat -p {printer}'"
        )
    if "disabled" in status:
        return False, f"printer '{printer}' is disabled in CUPS (run: cupsenable {printer})"
    if "Waiting for printer to become available" in status or "not connected" in status:
        return False, (
            f"printer '{printer}' is not reachable - power on the ZD230 and "
            "check its USB cable is connected"
        )
    return True, status


def verify_cups_job(lp_output: str, timeout: float = 15.0) -> None:
    """Wait for a submitted CUPS job to leave the spooler.

    `lp` returns exit 0 as soon as the job is spooled, not when it prints. If
    the device is offline the job just sits in the queue forever and the caller
    would otherwise report success while nothing prints. Poll until the job is
    gone or raise with the real reason.
    """
    match = re.search(r"request id is (\S+)", lp_output)
    if not match:
        return
    job_id = match.group(1)
    lpstat = shutil.which("lpstat") or "lpstat"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        proc = subprocess.run(
            [lpstat, "-o", job_id], capture_output=True, text=True, check=False
        )
        if job_id not in proc.stdout:
            return
        time.sleep(0.5)
    raise RuntimeError(
        f"CUPS job {job_id} is still queued and never printed - power on the ZD230, "
        "check its USB connection, and make sure label media is loaded."
    )


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

    ok, why = cups_printer_ready(PRINTER_NAME)
    if not ok:
        raise RuntimeError(f"CUPS printer check failed: {why}")

    for _ in range(max(1, copies)):
        proc = subprocess.run(
            [lp, "-d", PRINTER_NAME, "-o", "raw"],
            input=zpl,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if proc.returncode != 0:
            detail = proc.stderr.decode(errors="replace").strip()
            raise RuntimeError(detail or f"lp command failed (exit {proc.returncode})")
        verify_cups_job(proc.stdout.decode(errors="replace"))


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
    lp_available = bool(shutil.which("lp"))
    cups_status = cups_printer_status(PRINTER_NAME) if (PRINTER_NAME and lp_available) else ""
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
            if (PRINTER_NAME and lp_available)
            else "none"
        ),
        "zpl_windows": ZPL_WINDOWS,
        "image_windows": IMAGE_WINDOWS,
        "lp_available": lp_available,
        "cups_status": cups_status,
        "cups_printer_ready": not (
            cups_status and ("disabled" in cups_status or "Waiting for printer to become available" in cups_status)
        ),
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
