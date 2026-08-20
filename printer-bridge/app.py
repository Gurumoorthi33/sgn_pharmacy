"""
SGN Token System - Local print bridge for the Zebra ZD230.

Run this small FastAPI service next to the ZD230 and it prints labels
silently (no browser dialog), as many copies as requested. The same app.py
runs unchanged on three kinds of host - the send path is picked automatically
from the detected platform, never from which env vars happen to be set:

* Windows PC (win32print queue, e.g. "ZDesigner ZD230-203dpi ZPL", or CUPS).
* Sunmi T2s Lite / Android - the native "SGN Print Bridge" Kotlin app
  (foreground service using Zebra's Link-OS SDK) exposes a local HTTP server
  on 127.0.0.1:6001; raw ZPL bytes are POSTed to it. TCP 9100 (PRINTER_IP)
  also works from Android.
* Generic Linux (dev/testing) - CUPS queue, e.g. "ZTC-ZD230-203dpi-ZPL".

PRINTER_IP always wins: when it is set, the TCP 9100 send path is used on ANY
platform - including Android/Termux - before any local transport is considered,
so a networked ZD230 never needs USB at all.

API:

* /api/print/zpl/   POST JSON {"hospital": "...", "token_number": 4, "copies": 2}
                    (or raw {"zpl": "^XA^FO50,50^A0N,100,100^FDTOKEN 4^FS^XZ"}).
                    Returns a real 4xx/5xx error whenever the printer did not
                    actually receive the bytes - never a false "success".
* /api/print/diagnostics  one-request readiness report: detected platform,
                    active send path, and a live check that the printer is
                    actually reachable right now. For the TCP 9100 path that is
                    a real socket connect test to port 9100 (not just "IP is
                    set") plus the last successful/failed print timestamps.
* /api/print/       legacy PNG path (Windows only, unchanged).
* /health           basic liveness + platform/backend summary.

Setup (Windows):
    uv venv --python 3.12
    uv pip install --python .venv\\Scripts\\python.exe -r requirements-windows.txt
    set PRINTER_NAME=ZDesigner ZD230-203dpi ZPL
    set UPLOAD_FOLDER=C:\\sgn-prints
    uv run app.py

Setup (Sunmi T2s Lite / Android - native SGN Print Bridge app):
    Install and start the "SGN Print Bridge" Kotlin app (foreground service).
    It listens on 127.0.0.1:6001 and prints the raw ZPL it receives over HTTP.
    Then run the bridge here:
    uv venv --python 3.12
    uv pip install --python .venv/bin/python -r requirements.txt
    uv run app.py          # no PRINTER_IP / PRINTER_NAME needed on this device

    # No pyusb/termux-usb is involved on Android anymore - Termux's USB sandbox
    # broke direct libusb access (LIBUSB_ERROR_IO), so the Kotlin app owns USB
    # via Zebra's Link-OS SDK and we just POST raw ZPL bytes to it.

Environment:
    PRINTER_NAME    Windows ZPL driver queue, or the CUPS queue name on
                    Linux (e.g. "ZTC-ZD230-203dpi-ZPL"). Never consulted on
                    Android/Termux - there is no CUPS/win32print there.
    PRINTER_IP      IP/hostname of a networked ZD230. When set, the TCP 9100
                    send path is used on ANY platform - including Android/
                    Termux, before any USB consideration. PRINTER_HOST is
                    accepted as a legacy alias.
    PRINTER_PORT    Raw socket port for PRINTER_IP (default 9100).
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
localhost and allow port 5000 through the firewall.
"""

import logging
import os
import platform
import re
import requests
import shutil
import socket
import subprocess
import time
from datetime import datetime

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# --- Printing capabilities -------------------------------------------
# ZPL raw printing only needs pywin32's win32print (Windows).
try:
    import win32print

    ZPL_WINDOWS = True
except Exception:  # pragma: no cover - non-Windows machines
    ZPL_WINDOWS = False

# The legacy image path additionally needs win32ui/win32con/win32gui + PIL.
try:
    import win32ui
    import win32con
    import win32gui
    from PIL import Image, ImageWin

    IMAGE_WINDOWS = True
except Exception:  # pragma: no cover - non-Windows machines
    IMAGE_WINDOWS = False

# Android/Termux (Sunmi T2s Lite): the native "SGN Print Bridge" Kotlin app.
# Termux's USB sandbox breaks direct libusb access (LIBUSB_ERROR_IO), so labels
# go over HTTP to the local foreground service on 127.0.0.1:6001, which prints
# them with Zebra's Link-OS SDK. Raw ZPL bytes are the POST body.
ANDROID_BRIDGE_URL = "http://127.0.0.1:6001"
ANDROID_BRIDGE_RETRIES = 5  # the app may still be booting after a device restart
ANDROID_BRIDGE_RETRY_DELAY_S = 2
ANDROID_BRIDGE_TIMEOUT_S = 10

USB_METHOD = "Android SGN Print Bridge (HTTP 127.0.0.1:6001)"

LOG = logging.getLogger("sgn-print-bridge")
_log_handler = logging.StreamHandler()
_log_handler.setFormatter(
    logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s")
)
LOG.addHandler(_log_handler)
LOG.setLevel(logging.INFO)
# Own handler + propagate=False so uvicorn's root-logger config (default root
# level is WARNING) can never swallow our INFO step logs or hide tracebacks -
# every print backend failure is always visible in the server log.
LOG.propagate = False

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
PRINTER_IP = os.environ.get("PRINTER_IP") or os.environ.get("PRINTER_HOST") or ""
PRINTER_PORT = int(os.environ.get("PRINTER_PORT", "9100"))
PRINTER_DPI = int(os.environ.get("PRINTER_DPI", "203"))
ZPL_WIDTH_MM = int(os.environ.get("ZPL_WIDTH_MM", "50"))
ZPL_HEIGHT_MM = int(os.environ.get("ZPL_HEIGHT_MM", "25"))

os.makedirs(UPLOAD_FOLDER, exist_ok=True)


# --- Platform detection & send-path selection ---------------------------
# The bridge runs on three kinds of host (Windows PC, Sunmi T2s Lite/Termux,
# generic Linux) and each has its own printer transport. The transport is
# picked from real platform signals (OS + Termux markers), never from which
# env vars happen to be set - PRINTER_NAME is only consulted on platforms
# where win32print/CUPS actually exist, so a PRINTER_NAME value copied to the
# Sunmi cannot route it to a nonexistent CUPS queue. PRINTER_IP is honoured
# everywhere so the TCP 9100 network path overrides on any host.


def detect_platform(system=None, prefix=None, data_dir="/data/data/com.termux") -> str:
    """Classify the host: 'windows', 'android' (Termux) or 'linux'.

    Termux always exports PREFIX (e.g. /data/data/com.termux/files/usr) and
    creates /data/data/com.termux on disk - either signal alone is conclusive.
    """
    if system is None:
        system = platform.system()
    if prefix is None:
        prefix = os.environ.get("PREFIX", "")
    if system == "Windows":
        return "windows"
    if "com.termux" in prefix:
        return "android"
    if system == "Linux" and os.path.isdir(data_dir):
        return "android"
    return "linux"


PLATFORM = detect_platform()
PLATFORM_LABEL = {
    "windows": "Windows",
    "android": "Android/Termux",
    "linux": "Linux",
}[PLATFORM]

BACKEND_LABEL = {
    "socket": "TCP 9100",
    "win32print": "Windows win32print",
    "cups": "CUPS (lp)",
    "usb": "Android SGN Print Bridge (HTTP 127.0.0.1:6001)",
    "none": "none",
}


def select_backend(platform_: str | None = None) -> str:
    """Choose the active send path for `platform_` (defaults to PLATFORM)."""
    platform_ = platform_ or PLATFORM
    # PRINTER_IP is checked FIRST, on every platform: a networked ZD230 never
    # waits behind a local-transport decision, so Android/Termux reaches the
    # TCP 9100 path before USB is even considered.
    if PRINTER_IP:
        return "socket"
    if platform_ == "android":
        # Termux has no CUPS/win32print - PRINTER_NAME is never relevant here,
        # even if it happens to be set. The native SGN Print Bridge app (HTTP
        # 127.0.0.1:6001) is the Android send path.
        return "usb"
    if platform_ == "windows":
        if ZPL_WINDOWS and PRINTER_NAME:
            return "win32print"
        if PRINTER_NAME and shutil.which("lp"):
            return "cups"
        return "none"
    # Generic Linux (incl. the dev box): CUPS when a queue is configured.
    if PRINTER_NAME and shutil.which("lp"):
        return "cups"
    return "none"


BACKEND = select_backend()

# Last-print tracking so diagnostics can prove the path actually works: a
# single curl shows when bytes last reached (or failed to reach) the printer.
LAST_PRINT_OK_AT: str | None = None
LAST_PRINT_FAILED_AT: str | None = None
LAST_PRINT_FAILED_DETAIL: str | None = None


def _record_print_success() -> None:
    global LAST_PRINT_OK_AT, LAST_PRINT_FAILED_AT, LAST_PRINT_FAILED_DETAIL
    LAST_PRINT_OK_AT = datetime.now().isoformat(timespec="seconds")
    LAST_PRINT_FAILED_AT = None
    LAST_PRINT_FAILED_DETAIL = None


def _record_print_failure(detail: str) -> None:
    global LAST_PRINT_FAILED_AT, LAST_PRINT_FAILED_DETAIL
    LAST_PRINT_FAILED_AT = datetime.now().isoformat(timespec="seconds")
    LAST_PRINT_FAILED_DETAIL = detail


if PRINTER_IP:
    BANNER = (
        f"Detected platform: {PLATFORM_LABEL} - PRINTER_IP set - "
        f"using TCP 9100 send path ({PRINTER_IP}:{PRINTER_PORT})"
    )
else:
    BANNER = (
        f"Detected platform: {PLATFORM_LABEL} (os={platform.system()}, "
        f"PREFIX={os.environ.get('PREFIX', '') or '(unset)'}) - "
        f"send path: {BACKEND_LABEL[BACKEND]}"
    )
LOG.info(BANNER)


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
        raise RuntimeError("Windows printer queue name not set (PRINTER_NAME).")

    ensure_win32_printer_ready(PRINTER_NAME)

    try:
        hprinter = win32print.OpenPrinter(PRINTER_NAME)
    except Exception as exc:  # noqa: BLE001 - queue missing / not reachable
        raise RuntimeError(
            f"Windows printer queue '{PRINTER_NAME}' not found or inaccessible: {exc}"
        ) from exc
    try:
        win32print.StartDocPrinter(hprinter, 1, ("SGN Token", None, "RAW"))
        try:
            for _ in range(max(1, copies)):
                written = win32print.WritePrinter(hprinter, zpl)
                if written != len(zpl):
                    raise RuntimeError(
                        f"Windows printer write incomplete: sent {written} of {len(zpl)} bytes"
                    )
        finally:
            win32print.EndDocPrinter(hprinter)
    finally:
        win32print.ClosePrinter(hprinter)


def print_zpl_socket(zpl: bytes, copies: int = 1) -> None:
    """Send raw ZPL to a networked Zebra over its native port 9100."""
    if not PRINTER_IP:
        raise RuntimeError("PRINTER_IP is not set.")

    try:
        with socket.create_connection((PRINTER_IP, PRINTER_PORT), timeout=5) as sock:
            for _ in range(max(1, copies)):
                sock.sendall(zpl)
    except OSError as exc:
        raise RuntimeError(
            f"TCP send to printer {PRINTER_IP}:{PRINTER_PORT} failed: {exc} - "
            "is the ZD230 powered on and reachable on the network?"
        ) from exc


def socket_readiness() -> tuple[bool, str]:
    """(ok, detail) for the TCP 9100 path - is the printer reachable right now?"""
    if not PRINTER_IP:
        return False, "PRINTER_IP not set"
    try:
        with socket.create_connection((PRINTER_IP, PRINTER_PORT), timeout=2):
            pass
    except OSError as exc:
        return False, f"TCP {PRINTER_IP}:{PRINTER_PORT} unreachable: {exc}"
    return True, f"TCP {PRINTER_IP}:{PRINTER_PORT} reachable"


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
        raise RuntimeError("CUPS did not accept the job (no request id reported by lp)")
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
        raise RuntimeError("CUPS 'lp' is not installed on this machine.")
    if not PRINTER_NAME:
        raise RuntimeError("CUPS queue name not set (PRINTER_NAME).")

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


def cups_readiness() -> tuple[bool, str]:
    """(ok, detail) for the CUPS path - does the queue exist and reach the printer?"""
    if not shutil.which("lp"):
        return False, "CUPS 'lp' is not installed on this machine"
    if not PRINTER_NAME:
        return False, "CUPS queue name not set (PRINTER_NAME)"
    ok, why = cups_printer_ready(PRINTER_NAME)
    if ok:
        return True, f"CUPS queue '{PRINTER_NAME}' ready ({why})"
    return False, f"CUPS queue '{PRINTER_NAME}' not ready: {why}"


# --- Android/Termux (SGN Print Bridge HTTP) --------------------------------
# Termux's USB sandbox breaks direct libusb access (LIBUSB_ERROR_IO), so the
# Sunmi prints through the native "SGN Print Bridge" Kotlin app instead: a
# foreground service that talks to the ZD230 with Zebra's Link-OS SDK and
# exposes a local HTTP server on 127.0.0.1:6001. We POST the raw ZPL bytes
# (the request body, NOT wrapped in JSON) and the app prints them.

def android_bridge_readiness() -> tuple[bool, str]:
    """(ok, detail) for the Android path - is the local Kotlin service on
    127.0.0.1:6001 listening right now?"""
    host, port = "127.0.0.1", 6001
    try:
        with socket.create_connection((host, port), timeout=2):
            pass
    except OSError as exc:
        return False, f"SGN Print Bridge unreachable on {host}:{port}: {exc}"
    return True, f"SGN Print Bridge reachable on {host}:{port}"


def usb_readiness() -> tuple[bool, str]:
    """(ok, detail) for the Android/Termux send path (name kept for the backend
    dispatch): the SGN Print Bridge on 127.0.0.1:6001 must be reachable."""
    return android_bridge_readiness()


def _post_zpl_android(zpl: bytes) -> None:
    """POST one raw-ZPL body to the SGN Print Bridge, retrying while the Kotlin
    app is still booting after a device restart.

    A connection refusal on an early attempt is not a hard failure - the retry
    loop only raises the specific "unreachable" error once every attempt is
    refused, so a booting service never surfaces as a silent success or a false
    "print failed". A non-200 response is propagated verbatim (status + body)
    so the dispensing station shows the real reason - e.g. "USB permission not
    granted", "Printer not found", or a Zebra SDK exception - not a generic
    failure.
    """
    for attempt in range(1, ANDROID_BRIDGE_RETRIES + 1):
        try:
            resp = requests.post(
                ANDROID_BRIDGE_URL, data=zpl, timeout=ANDROID_BRIDGE_TIMEOUT_S
            )
        except requests.exceptions.ConnectionError as exc:
            if attempt < ANDROID_BRIDGE_RETRIES:
                LOG.warning(
                    "android: attempt %d/%d - bridge not reachable (%s); retrying in %ds",
                    attempt, ANDROID_BRIDGE_RETRIES, exc, ANDROID_BRIDGE_RETRY_DELAY_S,
                )
                time.sleep(ANDROID_BRIDGE_RETRY_DELAY_S)
            continue
        if resp.status_code != 200:
            raise RuntimeError(
                f"Android print service returned HTTP {resp.status_code}: "
                f"{resp.text.strip() or '(no response body)'}"
            )
        LOG.info("android: printed via SGN Print Bridge (HTTP %d)", resp.status_code)
        return
    raise RuntimeError(
        "Android print service unreachable on port 6001 — is the SGN Print Bridge app running?"
    )


def print_zpl_usb(zpl: bytes, copies: int = 1) -> None:
    """Send raw ZPL to the ZD230 on Android/Termux via the SGN Print Bridge app.

    The Kotlin service prints one label per POST, so each copy is its own
    request; any failure surfaces as a step-specific RuntimeError that carries
    the service's exact status and body (see _post_zpl_android).
    """
    for _ in range(max(1, copies)):
        _post_zpl_android(zpl)


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
def win32print_readiness() -> tuple[bool, str]:
    """(ok, detail) for the Windows win32print path - queue exists and is ready."""
    if not ZPL_WINDOWS:
        return False, "pywin32 is not available on this platform"
    if not PRINTER_NAME:
        return False, "Windows printer queue name not set (PRINTER_NAME)"
    try:
        ensure_win32_printer_ready(PRINTER_NAME)
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)
    return True, f"Windows queue '{PRINTER_NAME}' ready"


def readiness_for_backend(backend: str) -> tuple[bool, str]:
    """Live readiness probe for the currently active send path."""
    if backend == "socket":
        return socket_readiness()
    if backend == "win32print":
        return win32print_readiness()
    if backend == "cups":
        return cups_readiness()
    if backend == "usb":
        return usb_readiness()
    return False, "no send path configured for this platform"


@app.get("/health")
def health():
    lp_available = bool(shutil.which("lp"))
    # CUPS does not exist on Termux - never report PRINTER_NAME/queue state there.
    cups_status = (
        cups_printer_status(PRINTER_NAME)
        if (PLATFORM != "android" and PRINTER_NAME and lp_available)
        else ""
    )
    return {
        "ok": True,
        "platform": PLATFORM,
        "platform_detail": PLATFORM_LABEL,
        "printer": None if PLATFORM == "android" else (PRINTER_NAME or None),
        "printer_ip": PRINTER_IP or None,
        "printer_port": PRINTER_PORT,
        "backend": BACKEND,
        "backend_label": BACKEND_LABEL[BACKEND],
        "zpl_windows": ZPL_WINDOWS,
        "image_windows": IMAGE_WINDOWS,
        "usb_method": USB_METHOD,
        "lp_available": lp_available if PLATFORM != "android" else False,
        "cups_status": cups_status,
        "cups_printer_ready": not (
            cups_status and ("disabled" in cups_status or "Waiting for printer to become available" in cups_status)
        ),
        "label_mm": [ZPL_WIDTH_MM, ZPL_HEIGHT_MM],
        "dpi": PRINTER_DPI,
    }


@app.get("/api/print/diagnostics")
def print_diagnostics():
    """One-request report: platform, active send path, and a live readiness
    probe so "will this bridge actually print right now" is a single call."""
    checks = {}
    if PLATFORM == "android":
        ok, detail = usb_readiness()
        checks["usb"] = {"ready": ok, "detail": detail}
    if ZPL_WINDOWS:
        ok, detail = win32print_readiness()
        checks["win32print"] = {"ready": ok, "detail": detail}
    if PLATFORM != "android" and shutil.which("lp"):
        # CUPS does not exist on Termux - never surface it for Android.
        ok, detail = cups_readiness()
        checks["cups"] = {"ready": ok, "detail": detail}
    if PRINTER_IP:
        ok, detail = socket_readiness()
        checks["socket"] = {
            "ready": ok,
            "detail": detail,
            "ip": PRINTER_IP,
            "port": PRINTER_PORT,
            "reachable": ok,
            "last_success": LAST_PRINT_OK_AT,
            "last_failure": LAST_PRINT_FAILED_AT,
            "last_failure_detail": LAST_PRINT_FAILED_DETAIL,
        }

    active_ok, active_detail = readiness_for_backend(BACKEND)
    return {
        "ok": True,
        "platform": PLATFORM,
        "platform_detail": PLATFORM_LABEL,
        "backend": BACKEND,
        "backend_label": BACKEND_LABEL[BACKEND],
        "backend_ready": active_ok,
        "backend_detail": active_detail,
        "usb_method": USB_METHOD,
        "printer_name": None if PLATFORM == "android" else (PRINTER_NAME or None),
        "printer_ip": PRINTER_IP or None,
        "printer_port": PRINTER_PORT,
        "last_print_success": LAST_PRINT_OK_AT,
        "last_print_failure": LAST_PRINT_FAILED_AT,
        "last_print_failure_detail": LAST_PRINT_FAILED_DETAIL,
        "checks": checks,
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
        if BACKEND == "socket":
            print_zpl_socket(zpl, copies=copies)
        elif BACKEND == "win32print":
            print_zpl_win32(zpl, copies=copies)
        elif BACKEND == "cups":
            print_zpl_cups(zpl, copies=copies)
        elif BACKEND == "usb":
            print_zpl_usb(zpl, copies=copies)
        else:
            raise HTTPException(
                status_code=500,
                detail=(
                    f"No print backend is configured for platform {PLATFORM_LABEL}. "
                    "On Windows set PRINTER_NAME to the ZD230 queue; on Android/Termux "
                    "start the SGN Print Bridge app (HTTP 127.0.0.1:6001) or set "
                    "PRINTER_IP to reach the ZD230 over TCP 9100; PRINTER_IP forces "
                    "the TCP 9100 path on any machine."
                ),
            )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - always surface, never silently swallow
        LOG.exception(
            "print backend '%s' failed for token_number=%s copies=%s (zpl=%d bytes)",
            BACKEND,
            payload.token_number,
            payload.copies,
            len(zpl),
        )
        _record_print_failure(str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    _record_print_success()
    return {"ok": True, "copies": copies, "backend": BACKEND}


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
