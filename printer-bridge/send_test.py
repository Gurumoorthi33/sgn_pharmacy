#!/usr/bin/env python3
"""Standalone ZD230 USB print worker for Android/Termux (Zebra ZD230, 0x0A5F).

Termux sandboxes direct access to /dev/bus/usb/*. Android hands the caller a
*file descriptor* for the granted device (termux-usb), and that fd is the only
working connection to the hardware - generic enumeration like pyusb's
usb.core.find() cannot see it. This worker therefore:

  1. takes the granted fd (from termux-usb, see below),
  2. wraps it with python-libusb1's USBContext.wrapSysDevice(fd),
  3. claims the printer interface,
  4. bulk-writes the ZPL to the OUT bulk endpoint,
  5. exits 0 only when every byte reached the printer.

Every failure names the exact step (device wrap / interface claim / write) so
the web bridge can surface it instead of a generic 500.

How termux-usb hands over the fd (differs between Termux versions - confirm
with `termux-usb --help` on the device):
  * classic: appended as the LAST command-line argument of the -e command, or
  * TERMUX_USB_FD environment variable, or
  * passed on stdin (fd 0) of the child.
This worker accepts all three and an explicit --fd for manual testing.

Standalone use (isolate the USB path from the web app):
    termux-usb -r -e "$PREFIX/bin/python send_test.py token4.zpl" /dev/bus/usb/001/005
    # after permission is already granted, or for debugging:
    python send_test.py token4.zpl --fd <N>

The bridge (app.py) shells out to exactly this script via
`termux-usb -r -e ...` when a print job arrives.
"""

import argparse
import os
import sys

ZEBRA_USB_VID = 0x0A5F
CLASS_PRINTER = 7
USB_WRITE_TIMEOUT_MS = 5000


def _usb_error(exc: Exception) -> str:
    return f"{type(exc).__name__}: {exc}"


def resolve_fd(args, extra) -> int:
    """The granted USB fd, from --fd, TERMUX_USB_FD, argv[-1] or stdin."""
    if args.fd is not None:
        return args.fd
    env = os.environ.get("TERMUX_USB_FD", "")
    if env.strip().isdigit():
        return int(env.strip())
    if extra and str(extra[-1]).isdigit():
        return int(extra[-1])
    if not sys.stdin.isatty():
        return os.dup(0)
    raise RuntimeError(
        "cannot determine the granted USB fd - run 'termux-usb --help' to see how "
        "this Termux version passes it (appended argv / TERMUX_USB_FD / stdin), "
        "then rerun with --fd <N>"
    )


def _find_out_bulk(dev):
    """First OUT bulk endpoint, preferring a printer-class (7) interface."""
    candidates = []
    fallback = None
    for cfg in dev.iterConfigurations():
        for intf in cfg.iterInterfaces():
            for setting in intf.iterSettings():
                for ep in setting.iterEndpoints():
                    addr = ep.getAddress()
                    if addr & 0x80:  # skip IN endpoints
                        continue
                    if (ep.getAttributes() & 0x03) != 2:  # only bulk transfers
                        continue
                    cand = (addr, setting.getNumber())
                    if setting.getClass() == CLASS_PRINTER:
                        candidates.append(cand)
                    if fallback is None:
                        fallback = cand
    if candidates:
        return candidates[0]
    if fallback:
        return fallback
    raise RuntimeError("no OUT bulk endpoint found on the wrapped device")


def write_zpl(zpl: bytes, copies: int, fd: int) -> None:
    """Wrap the granted fd and write the label; raises on the failing step."""
    import usb1

    ver = usb1.getVersion()
    if (ver.major, ver.minor, ver.micro) < (1, 0, 22):
        raise RuntimeError(
            "device wrap requires libusb >= 1.0.22 (have %d.%d.%d) - run: "
            "pkg upgrade libusb" % (ver.major, ver.minor, ver.micro)
        )

    with usb1.USBContext() as ctx:
        handle = None
        try:
            try:
                handle = ctx.wrapSysDevice(fd)
            except usb1.USBError as exc:
                raise RuntimeError(
                    f"device wrap failed (wrapSysDevice): {_usb_error(exc)}"
                ) from exc

            try:
                dev = handle.getDevice()
            except usb1.USBError as exc:
                raise RuntimeError(
                    f"device query failed (getDevice): {_usb_error(exc)}"
                ) from exc

            vid, pid = dev.getVendorID(), dev.getProductID()
            if vid != ZEBRA_USB_VID:
                raise RuntimeError(
                    "wrapped device is not a Zebra (VID 0x%04X PID 0x%04X) - "
                    "permission was granted to the wrong /dev/bus/usb/... path; "
                    "try the other one or set PRINTER_USB_PATH" % (vid, pid)
                )

            ep, intf = _find_out_bulk(dev)
            try:
                handle.setAutoDetachKernelDriver(True)
            except usb1.USBError:
                pass  # non-fatal; Android/Termux usually has no kernel claim

            try:
                handle.claimInterface(intf)
            except usb1.USBError as exc:
                raise RuntimeError(
                    f"interface claim failed (claimInterface({intf})): {_usb_error(exc)}"
                ) from exc

            total = len(zpl) * max(1, copies)
            for i in range(1, max(1, copies) + 1):
                try:
                    n = handle.bulkWrite(ep, zpl, timeout=USB_WRITE_TIMEOUT_MS)
                except usb1.USBError as exc:
                    raise RuntimeError(
                        f"write failed (bulkWrite 0x{ep:02X}, copy {i}/{copies}): "
                        f"{_usb_error(exc)}"
                    ) from exc
                if n != len(zpl):
                    raise RuntimeError(
                        f"write incomplete (bulkWrite sent {n} of {len(zpl)} bytes)"
                    )
            print(f"OK ZEBRA-USB WROTE {max(1, copies)} COPIES, {total} BYTES")
        finally:
            if handle is not None:
                try:
                    handle.close()
                except usb1.USBError:
                    pass


def _run() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("zpl_file", help="path to the raw ZPL to send")
    ap.add_argument("--copies", type=int, default=1, help="how many labels (default 1)")
    ap.add_argument(
        "--fd",
        type=int,
        default=None,
        help="explicit USB fd (manual/standalone testing; termux-usb appends it otherwise)",
    )
    args, extra = ap.parse_known_args()

    fd = resolve_fd(args, extra)
    with open(args.zpl_file, "rb") as fh:
        zpl = fh.read()
    write_zpl(zpl, args.copies, fd)


def main() -> None:
    try:
        _run()
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:  # unexpected - still fail loudly, never silently
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()