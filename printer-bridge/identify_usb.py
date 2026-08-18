#!/usr/bin/env python3
"""Identify a USB device on Android/Termux via the termux-usb granted fd.

Run it against each /dev/bus/usb/... path from `termux-usb -l`. The entry whose
Vendor ID is 0x0A5F is the Zebra ZD230; any other is the hub/controller:

    termux-usb -r -e "$PREFIX/bin/python identify_usb.py" /dev/bus/usb/001/005
    termux-usb -r -e "$PREFIX/bin/python identify_usb.py" /dev/bus/usb/001/007

termux-usb hands the granted fd to the -e command as its LAST command-line
argument (the same convention send_test.py resolves: argv[-1], then
TERMUX_USB_FD, then stdin), so do not pass the fd yourself - it is appended
automatically. For manual testing you can pass it as an argument:
    python identify_usb.py <fd>
"""

import os
import sys

import usb1

ZEBRA_USB_VID = 0x0A5F


def resolve_fd() -> int:
    """The granted USB fd - termux-usb appends it as argv[-1]."""
    for arg in reversed(sys.argv[1:]):
        if arg.isdigit():
            return int(arg)
    env = os.environ.get("TERMUX_USB_FD", "")
    if env.strip().isdigit():
        return int(env.strip())
    if not sys.stdin.isatty():
        return os.dup(0)
    raise SystemExit(
        "ERROR: no USB fd given - invoke via "
        "'termux-usb -r -e \"$PREFIX/bin/python identify_usb.py\" <device>' "
        "(the fd is appended automatically), or pass it as an argument"
    )


def main() -> None:
    fd = resolve_fd()
    print(f"[identify] fd: {fd}")
    with usb1.USBContext() as context:
        try:
            handle = context.wrapSysDevice(fd)
        except usb1.USBError as exc:
            print(f"ERROR: wrapSysDevice failed: {exc}")
            sys.exit(1)
        device = handle.getDevice()
        vid, pid = device.getVendorID(), device.getProductID()
        print(f"Vendor ID:   {hex(vid)}")
        print(f"Product ID:  {hex(pid)}")
        try:
            print(f"Manufacturer: {handle.getManufacturer()}")
            print(f"Product:      {handle.getProduct()}")
            print(f"Serial:       {handle.getSerialNumber()}")
        except Exception as exc:  # noqa: BLE001 - string descriptors are optional
            print(f"(couldn't read string descriptors: {exc})")
        print()
        if vid == ZEBRA_USB_VID:
            print("VERDICT: Zebra ZD230 (vendor 0x0A5F) - THIS is the printer")
        else:
            print(
                f"VERDICT: NOT a Zebra (expected 0x{ZEBRA_USB_VID:04X}) - "
                "this is a hub/controller or some other device"
            )
        print()
        print("interfaces:")
        for cfg in device.iterConfigurations():
            for intf in cfg.iterInterfaces():
                for setting in intf.iterSettings():
                    eps = ", ".join(
                        f"0x{ep.getAddress():02X}" + ("(IN)" if ep.getAddress() & 0x80 else "(OUT)")
                        for ep in setting.iterEndpoints()
                    )
                    print(
                        f"  cfg {cfg.getConfigurationValue()} intf {setting.getNumber()} "
                        f"class 0x{setting.getClass():02X}: {eps}"
                    )


if __name__ == "__main__":
    main()