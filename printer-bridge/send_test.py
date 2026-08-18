#!/usr/bin/env python3
"""Standalone ZD230 USB print worker for Android/Termux (Zebra ZD230, 0x0A5F).

Termux sandboxes direct access to /dev/bus/usb/*. Android hands the caller a
*file descriptor* for the granted device (termux-usb), and that fd is the only
working connection to the hardware - generic enumeration like pyusb's
usb.core.find() cannot see it. This worker therefore:

  1. takes the granted fd (from termux-usb, see below),
  2. wraps it with python-libusb1's USBContext.wrapSysDevice(fd),
  3. enumerates the real interfaces/endpoints (never assumes endpoint 1),
  4. ensures the correct configuration + detaches any kernel driver,
  5. claims the printer interface,
  6. bulk-writes the ZPL to the found OUT bulk endpoint (with retries).

Every failure names the exact step (device wrap / configuration / kernel
driver / interface claim / write) so the web bridge can surface it instead of a
generic 500. Before each write the exact endpoint address + interface are
logged, and each write is retried (WRITE_RETRIES attempts) because some Android
USB stacks report a transient LIBUSB_ERROR_IO on the first transfer.

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

Identify a device without printing (dumps VID/PID + every interface/endpoint so
you can tell the ZD230 from a hub/controller - run against each termux-usb -l
path):
    termux-usb -r -e "$PREFIX/bin/python send_test.py token4.zpl --dry-run" /dev/bus/usb/001/005

The bridge (app.py) shells out to exactly this script via
`termux-usb -r -e ...` when a print job arrives.
"""

import argparse
import os
import sys
import time

ZEBRA_USB_VID = 0x0A5F
CLASS_PRINTER = 7
USB_WRITE_TIMEOUT_MS = 5000
WRITE_RETRIES = 3
WRITE_RETRY_DELAY_S = 0.2


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


def _describe_endpoint(ep) -> str:
    addr = ep.getAddress()
    direction = "IN" if (addr & 0x80) else "OUT"
    return f"0x{addr:02X} {direction} type={ep.getAttributes() & 0x03}"


def _enumerate(dev, handle) -> None:
    """Dump active configuration + every interface/endpoint to stderr."""
    try:
        current = handle.getConfiguration()
    except Exception as exc:  # noqa: BLE001 - best-effort diagnostic
        current = f"<unreadable: {_usb_error(exc)}>"
    _dbg(f"active configuration: {current}")
    for cfg in dev.iterConfigurations():
        _dbg(
            f"  config {cfg.getConfigurationValue()} "
            f"({cfg.getNumInterfaces()} interfaces)"
        )
        for intf in cfg.iterInterfaces():
            for setting in intf.iterSettings():
                _dbg(
                    f"    interface {setting.getNumber()} "
                    f"class 0x{setting.getClass():02X} "
                    f"alt {setting.getAlternateSetting()} "
                    f"({setting.getNumEndpoints()} endpoints)"
                )
                for ep in setting.iterEndpoints():
                    _dbg(f"      endpoint {_describe_endpoint(ep)}")


def _find_out_bulk(dev):
    """First OUT bulk endpoint (preferring printer class 7) + its config.

    Returns (endpoint_address, interface_number, config_value). Never assumes
    the endpoint is 0x01 - it is read from the real descriptors.
    """
    candidates = []
    fallback = None
    for cfg in dev.iterConfigurations():
        cfg_val = cfg.getConfigurationValue()
        for intf in cfg.iterInterfaces():
            for setting in intf.iterSettings():
                for ep in setting.iterEndpoints():
                    addr = ep.getAddress()
                    if addr & 0x80:  # skip IN endpoints
                        continue
                    if (ep.getAttributes() & 0x03) != 2:  # only bulk transfers
                        continue
                    cand = (addr, setting.getNumber(), cfg_val)
                    if setting.getClass() == CLASS_PRINTER:
                        candidates.append(cand)
                    if fallback is None:
                        fallback = cand
    if candidates:
        return candidates[0]
    if fallback:
        return fallback
    raise RuntimeError("no OUT bulk endpoint found on the wrapped device")


def _dbg(msg: str) -> None:
    """Step log - to stderr so stdout stays clean for the OK marker."""
    print(f"[usb-worker] {msg}", file=sys.stderr)


def write_zpl(
    zpl: bytes, copies: int, fd: int, dry_run: bool = False, skip_vid_check: bool = False
) -> None:
    """Wrap the granted fd and write the label; raises on the failing step."""
    import usb1

    ver = usb1.getVersion()
    if (ver.major, ver.minor, ver.micro) < (1, 0, 22):
        raise RuntimeError(
            "device wrap requires libusb >= 1.0.22 (have %d.%d.%d) - run: "
            "pkg upgrade libusb" % (ver.major, ver.minor, ver.micro)
        )

    _dbg(f"fd obtained: {fd}")
    with usb1.USBContext() as ctx:
        handle = None
        detached: list[int] = []
        try:
            try:
                handle = ctx.wrapSysDevice(fd)
            except usb1.USBError as exc:
                raise RuntimeError(
                    f"device wrap failed (wrapSysDevice): {_usb_error(exc)}"
                ) from exc
            _dbg("device wrapped (wrapSysDevice)")

            try:
                dev = handle.getDevice()
            except usb1.USBError as exc:
                raise RuntimeError(
                    f"device query failed (getDevice): {_usb_error(exc)}"
                ) from exc

            vid, pid = dev.getVendorID(), dev.getProductID()
            _dbg(f"wrapped device: VID 0x{vid:04X} PID 0x{pid:04X}")
            _enumerate(dev, handle)  # dump before deciding, so --dry-run identifies any device

            if dry_run:
                _dbg("dry-run: enumerated only, no write performed")
                return

            if vid != ZEBRA_USB_VID and not skip_vid_check:
                raise RuntimeError(
                    "wrapped device is not a Zebra (VID 0x%04X PID 0x%04X) - "
                    "permission was granted to the wrong /dev/bus/usb/... path; "
                    "try the other one or set PRINTER_USB_PATH" % (vid, pid)
                )
            if skip_vid_check:
                _dbg(f"VID check skipped (diagnostic mode)")

            ep, intf, cfg_val = _find_out_bulk(dev)
            _dbg(f"chosen endpoint 0x{ep:02X} on interface {intf} (config {cfg_val})")

            # Explicit configuration - wrapSysDevice does not guarantee the
            # device is already in its numbered configuration.
            try:
                current = handle.getConfiguration()
            except usb1.USBError as exc:
                _dbg(f"configuration unreadable: {_usb_error(exc)}")
                current = None
            if current != cfg_val:
                _dbg(f"setting configuration {cfg_val} (current={current})")
                try:
                    handle.setConfiguration(cfg_val)
                except usb1.USBError as exc:
                    raise RuntimeError(
                        f"configuration set failed (setConfiguration({cfg_val})): "
                        f"{_usb_error(exc)}"
                    ) from exc
                _dbg(f"configuration {cfg_val} set")

            # Android sometimes auto-attaches a generic driver to printer-class
            # interfaces; a competing claim is a common cause of LIBUSB_ERROR_IO.
            try:
                active = handle.kernelDriverActive(intf)
            except usb1.USBError as exc:
                _dbg(f"kernelDriverActive({intf}) unreadable: {_usb_error(exc)}")
                active = False
            if active:
                _dbg(f"kernel driver active on interface {intf} - detaching")
                try:
                    handle.detachKernelDriver(intf)
                except usb1.USBError as exc:
                    raise RuntimeError(
                        f"kernel driver detach failed (detachKernelDriver({intf})): "
                        f"{_usb_error(exc)}"
                    ) from exc
                detached.append(intf)

            try:
                handle.setAutoDetachKernelDriver(True)
            except usb1.USBError:
                pass  # belt-and-braces; not fatal if unsupported

            try:
                handle.claimInterface(intf)
            except usb1.USBError as exc:
                raise RuntimeError(
                    f"interface claim failed (claimInterface({intf})): {_usb_error(exc)}"
                ) from exc
            _dbg(f"interface {intf} claimed")

            total = len(zpl) * max(1, copies)
            for i in range(1, max(1, copies) + 1):
                _dbg(
                    f"write attempted: copy {i}/{max(1, copies)}, {len(zpl)} bytes "
                    f"-> endpoint 0x{ep:02X} interface {intf} (config {cfg_val})"
                )
                last_exc = None
                n = None
                for attempt in range(1, WRITE_RETRIES + 1):
                    try:
                        n = handle.bulkWrite(ep, zpl, timeout=USB_WRITE_TIMEOUT_MS)
                        break
                    except usb1.USBError as exc:
                        last_exc = exc
                        _dbg(
                            f"  write attempt {attempt}/{WRITE_RETRIES} failed: "
                            f"{_usb_error(exc)}"
                        )
                        if attempt < WRITE_RETRIES and not isinstance(
                            exc, usb1.USBErrorNoDevice
                        ):
                            time.sleep(WRITE_RETRY_DELAY_S)
                if n is None:
                    raise RuntimeError(
                        f"write failed (bulkWrite 0x{ep:02X}, copy {i}/{copies}, "
                        f"{WRITE_RETRIES} attempts): {_usb_error(last_exc)}"
                    )
                if n != len(zpl):
                    raise RuntimeError(
                        f"write incomplete (bulkWrite sent {n} of {len(zpl)} bytes)"
                    )
                _dbg(f"bytes written: {n}/{len(zpl)} (copy {i}/{max(1, copies)})")
            print(f"OK ZEBRA-USB WROTE {max(1, copies)} COPIES, {total} BYTES")
        finally:
            if handle is not None:
                for intf_to_rebind in detached:
                    try:
                        handle.attachKernelDriver(intf_to_rebind)
                        _dbg(f"kernel driver re-attached on interface {intf_to_rebind}")
                    except Exception:  # noqa: BLE001 - best-effort cleanup
                        pass
                try:
                    handle.close()
                except Exception:  # noqa: BLE001 - usb1 may AssertError on
                    # double-close (device finalizer already owns the handle);
                    # cleanup must never mask a successful write
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
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="enumerate the device and stop - identify a device (printer vs hub) "
        "without printing",
    )
    ap.add_argument(
        "--skip-vid-check",
        action="store_true",
        help="diagnostic: attempt the write even when the device VID is not Zebra "
        "0x0A5F (e.g. to debug the write/retry path on a test device)",
    )
    args, extra = ap.parse_known_args()

    fd = resolve_fd(args, extra)
    with open(args.zpl_file, "rb") as fh:
        zpl = fh.read()
    write_zpl(zpl, args.copies, fd, dry_run=args.dry_run, skip_vid_check=args.skip_vid_check)


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