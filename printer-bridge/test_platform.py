#!/usr/bin/env python
"""
Platform-detection + send-path selection tests for the print bridge.

Run:  .venv/bin/python test_platform.py
Exit code is 0 only when every assertion passes.

The tests exercise the pure logic (detect_platform / select_backend) across the
three hosts, plus each send path's "unplugged printer" behaviour failing loudly
instead of pretending to succeed.
"""

import sys
import tempfile

import app

PASS = 0


def check(name, fn):
    global PASS
    try:
        fn()
        print(f"  PASS  {name}")
    except AssertionError as exc:
        PASS = 1
        print(f"  FAIL  {name}: {exc}")


def test_platform_detection():
    # Windows
    assert app.detect_platform(system="Windows") == "windows", "Windows"
    assert app.detect_platform(system="Windows", prefix="/data/data/com.termux/files/usr") == "windows"
    # Android via Termux PREFIX (the real signal - always set inside Termux)
    assert (
        app.detect_platform(system="Linux", prefix="/data/data/com.termux/files/usr") == "android"
    )
    # Android via the on-disk marker when PREFIX is somehow unset
    with tempfile.TemporaryDirectory() as td:
        assert app.detect_platform(system="Linux", prefix="", data_dir=td) == "android"
    assert app.detect_platform(system="Linux", prefix="", data_dir="/nonexistent") == "linux"
    assert app.detect_platform(system="Darwin") == "linux", "non-Termux non-Windows -> linux"


def test_backend_selection():
    # Android/Termux: always USB - PRINTER_NAME is ignored even when set
    saved = (app.PRINTER_IP, app.PLATFORM, app.ZPL_WINDOWS, app.PRINTER_NAME)
    try:
        app.PLATFORM = "android"
        app.PRINTER_IP = ""
        app.PRINTER_NAME = "ZTC-ZD230-203dpi-ZPL"  # the bug: copied Windows/CUPS convention
        assert app.select_backend() == "usb", "Android must ignore PRINTER_NAME -> usb"

        # Windows: win32print when the queue + pywin32 are present
        app.PLATFORM = "windows"
        app.ZPL_WINDOWS = True
        app.PRINTER_NAME = "ZDesigner ZD230-203dpi ZPL"
        assert app.select_backend() == "win32print", "Windows + queue + pywin32 -> win32print"

        # Windows without pywin32: falls back to CUPS only if lp exists + name set
        app.ZPL_WINDOWS = False
        app.PRINTER_NAME = "ZTC-ZD230-203dpi-ZPL"
        assert app.select_backend() == "cups", "Windows no-pywin32 + PRINTER_NAME -> cups"

        # Generic Linux dev box: CUPS when a queue is configured
        app.PLATFORM = "linux"
        assert app.select_backend() == "cups", "Linux + PRINTER_NAME -> cups"

        # No config -> 'none' (loud failure later, never a silent success)
        app.PRINTER_NAME = ""
        assert app.select_backend() == "none", "nothing configured -> none"

        # PRINTER_IP override forces TCP on ANY platform
        app.PLATFORM = "android"
        app.PRINTER_IP = "192.168.1.50"
        assert app.select_backend() == "socket", "PRINTER_IP overrides Android -> socket"
    finally:
        app.PRINTER_IP, app.PLATFORM, app.ZPL_WINDOWS, app.PRINTER_NAME = saved


def test_socket_path_fails_loudly():
    # Nothing listening on localhost:1 -> must raise, not succeed
    saved = app.PRINTER_IP
    try:
        app.PRINTER_IP = "127.0.0.1"
        try:
            app.print_zpl_socket(b"^XA^XZ")
        except RuntimeError as exc:
            assert "TCP send" in str(exc) and "failed" in str(exc), str(exc)
        else:
            raise AssertionError("socket print to a closed port must raise")
    finally:
        app.PRINTER_IP = saved


def test_socket_path_missing_config():
    saved = app.PRINTER_IP
    try:
        app.PRINTER_IP = ""
        try:
            app.print_zpl_socket(b"^XA^XZ")
        except RuntimeError as exc:
            assert "PRINTER_IP" in str(exc)
        else:
            raise AssertionError("socket print without PRINTER_IP must raise")
    finally:
        app.PRINTER_IP = saved


def test_usb_path_fails_loudly_without_device():
    # On this machine there is no termux-usb (not Termux), so both the readiness
    # probe and a print must report a real error, never a fake success.
    if not app.USB_LIBUSB1:
        raise AssertionError("expected libusb1 to be importable in this venv")
    ok, detail = app.usb_readiness()
    assert ok is False, f"no USB path on this host -> readiness must be False, got: {detail}"
    assert "termux-usb" in detail, detail
    try:
        app.print_zpl_usb(b"^XA^XZ")
    except RuntimeError as exc:
        assert "termux-usb" in str(exc), str(exc)
    else:
        raise AssertionError("USB print without termux-usb must raise")


class _FakeProc:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_usb_target_selection():
    saved = (app.shutil.which, app.subprocess.run, app.PRINTER_USB_PATH)
    try:
        app.shutil.which = lambda name: "/data/data/com.termux/files/usr/bin/termux-usb"
        app.PRINTER_USB_PATH = ""

        # Two listed devices, one with Zebra VID -> pick the Zebra.
        app.subprocess.run = lambda cmd, **kw: _FakeProc(
            0, stdout="/dev/bus/usb/001/005\n/dev/bus/usb/001/007 0a5f:0071\n"
        )
        assert app.resolve_usb_target() == "/dev/bus/usb/001/007"

        # No VID info in the listing and two devices -> fail loudly asking for
        # PRINTER_USB_PATH instead of guessing.
        app.subprocess.run = lambda cmd, **kw: _FakeProc(
            0, stdout="/dev/bus/usb/001/005\n/dev/bus/usb/001/007\n"
        )
        try:
            app.resolve_usb_target()
        except RuntimeError as exc:
            assert "PRINTER_USB_PATH" in str(exc) and "001/005" in str(exc), str(exc)
        else:
            raise AssertionError("two anonymous devices must require PRINTER_USB_PATH")

        # PRINTER_USB_PATH pins the device regardless of the listing.
        app.PRINTER_USB_PATH = "/dev/bus/usb/001/005"
        assert app.resolve_usb_target() == "/dev/bus/usb/001/005"

        # Empty listing -> loud "no USB devices" error.
        app.PRINTER_USB_PATH = ""
        app.subprocess.run = lambda cmd, **kw: _FakeProc(0, stdout="[]\n")
        try:
            app.resolve_usb_target()
        except RuntimeError as exc:
            assert "no USB devices" in str(exc), str(exc)
        else:
            raise AssertionError("empty listing must fail loudly")
    finally:
        app.shutil.which, app.subprocess.run, app.PRINTER_USB_PATH = saved


def test_usb_worker_invocation():
    # The bridge must run termux-usb -r -e with the send_test.py worker and
    # surface a worker failure as a step-specific RuntimeError - never a
    # silent success (the "OK ZEBRA-USB" marker must be absent).
    calls = []

    def fake_run(cmd, **kw):
        calls.append(cmd)
        return _FakeProc(
            returncode=1,
            stderr="ERROR: device wrap failed (wrapSysDevice): USBErrorIO: LIBUSB_ERROR_IO [-1]",
        )

    saved = (app.shutil.which, app.subprocess.run, app.PRINTER_USB_PATH)
    try:
        app.PRINTER_USB_PATH = "/dev/bus/usb/001/007"
        app.shutil.which = lambda name: "/data/data/com.termux/files/usr/bin/termux-usb"
        app.subprocess.run = fake_run
        try:
            app.print_zpl_usb(b"^XA^XZ")
        except RuntimeError as exc:
            assert "USB write failed" in str(exc) and "device wrap failed" in str(exc), str(exc)
        else:
            raise AssertionError("worker failure must raise RuntimeError")

        assert calls, "termux-usb must be invoked"
        termux_usb, dash_r, dash_e, command, device = calls[0]
        assert termux_usb.endswith("termux-usb") and dash_r == "-r" and dash_e == "-e", calls[0]
        assert device == "/dev/bus/usb/001/007"
        assert "send_test.py" in command and "--copies" in command, command
    finally:
        app.shutil.which, app.subprocess.run, app.PRINTER_USB_PATH = saved


def test_cups_path_fails_loudly_for_unknown_queue():
    if not app.shutil.which("lp"):
        print("  SKIP  cups (lp not installed on this box)")
        return
    saved = app.PRINTER_NAME
    try:
        app.PRINTER_NAME = "sgn-nonexistent-queue-xyz"
        ok, detail = app.cups_readiness()
        assert ok is False, f"nonexistent queue must not be ready: {detail}"
        try:
            app.print_zpl_cups(b"^XA^XZ")
        except RuntimeError as exc:
            assert "not found" in str(exc) or "not ready" in str(exc), str(exc)
        else:
            raise AssertionError("CUPS print to unknown queue must raise")
    finally:
        app.PRINTER_NAME = saved


def test_readiness_dispatch():
    assert app.readiness_for_backend("bogus") == (False, "no send path configured for this platform")
    saved = app.PRINTER_IP
    try:
        app.PRINTER_IP = "127.0.0.1"
        ok, _ = app.readiness_for_backend("socket")
        assert ok is False  # 9100 not listening locally
    finally:
        app.PRINTER_IP = saved


if __name__ == "__main__":
    print("platform detection + backend selection tests")
    check("platform detection across Windows/Termux/Linux", test_platform_detection)
    check("backend selection per platform (Android ignores PRINTER_NAME)", test_backend_selection)
    check("socket path fails loudly on unreachable printer", test_socket_path_fails_loudly)
    check("socket path fails loudly when unconfigured", test_socket_path_missing_config)
    check("USB path fails loudly with no device attached", test_usb_path_fails_loudly_without_device)
    check("USB target resolution (Zebra / PRINTER_USB_PATH / multi-device)", test_usb_target_selection)
    check("USB worker invocation + step-specific failure", test_usb_worker_invocation)
    check("CUPS path fails loudly for unknown queue", test_cups_path_fails_loudly_for_unknown_queue)
    check("readiness dispatch for unknown backend", test_readiness_dispatch)
    sys.exit(PASS)
