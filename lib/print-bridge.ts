// Optional local print bridge for silent ZD230 printing.
// Set NEXT_PUBLIC_PRINT_BRIDGE_URL (e.g. http://localhost:5000) to enable it.
// When unset, the app falls back to the browser print dialog.
export const PRINT_BRIDGE_URL = process.env.NEXT_PUBLIC_PRINT_BRIDGE_URL || ""
// Trimmed base URL, safe to interpolate into error messages / fetch calls.
export const PRINT_BRIDGE_BASE = PRINT_BRIDGE_URL.replace(/\/+$/, "")

// Physical label size the ZD230 is loaded with (standard Zebra 2" roll).
// Keep in sync with ZPL_WIDTH_MM / ZPL_HEIGHT_MM in printer-bridge/app.py.
export const LABEL_W_MM = 50
export const LABEL_H_MM = 25

// POST the token data to the local Flask bridge, which renders it as ZPL and
// sends raw bytes to the ZD230 (win32print raw queue, or TCP 9100). Crisp and
// instant - the printer rasterizes the label itself, no browser scaling.
export async function sendToPrintBridge(
  hospital: string,
  tokenNumber: number,
  copies = 2,
): Promise<void> {
  let res: Response
  try {
    res = await fetch(`${PRINT_BRIDGE_BASE}/api/print/zpl/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hospital, token_number: tokenNumber, copies }),
    })
  } catch (cause) {
    throw new Error(
      `could not reach print bridge at ${PRINT_BRIDGE_BASE} (${(cause as Error).message}). ` +
        `Start it on the PC attached to the ZD230: cd printer-bridge && python app.py`,
    )
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (body?.error) detail = body.error
      else if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail)
    } catch {
      // keep the status-only fallback
    }
    throw new Error(`print bridge at ${PRINT_BRIDGE_BASE} returned: ${detail}`)
  }
}

// Print `copies` identical labels via a fully isolated hidden iframe.
// This is the reliable browser path: the iframe document contains ONLY the
// labels and its own @page size set to the exact label roll dimensions, so the
// printer receives one page per label (no blank/extra pages from the app).
export function printLabelsViaIframe(hospital: string, tokenNumber: number, copies = 2): Promise<void> {
  return new Promise((resolve) => {
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

    const oneLabel = `
      <div class="label">
        <div class="hospital">${esc(hospital)}</div>
        <div class="caption">TOKEN</div>
        <div class="number">${tokenNumber}</div>
      </div>`

    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { size: ${LABEL_W_MM}mm ${LABEL_H_MM}mm; margin: 0; }
      @media print {
        html, body { width: ${LABEL_W_MM}mm; margin: 0; padding: 0; background: #fff; }
      }
      * { margin: 0; padding: 0; box-sizing: border-box;
          -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      html, body { width: ${LABEL_W_MM}mm; background: #fff; }
      .label {
        width: ${LABEL_W_MM}mm; height: ${LABEL_H_MM}mm; padding: 1.5mm 1.5mm;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 0.4mm; background: #fff; color: #000; overflow: hidden;
        font-family: Arial, Helvetica, sans-serif;
        page-break-after: always; break-after: page;
      }
      .label:last-child { page-break-after: auto; break-after: auto; }
      .hospital { font-size: 2mm; font-weight: 700; text-align: center; line-height: 1.05; }
      .caption { font-size: 2.4mm; font-weight: 600; letter-spacing: 1px; line-height: 1; }
      .number { font-size: 14mm; font-weight: 800; line-height: 1; font-family: "Courier New", monospace; }
    </style></head><body>${oneLabel.repeat(Math.max(1, copies))}</body></html>`

    const iframe = document.createElement("iframe")
    iframe.setAttribute("aria-hidden", "true")
    iframe.style.position = "fixed"
    iframe.style.right = "0"
    iframe.style.bottom = "0"
    iframe.style.width = "0"
    iframe.style.height = "0"
    iframe.style.border = "0"
    document.body.appendChild(iframe)

    const cleanup = () => {
      setTimeout(() => iframe.remove(), 1000)
      resolve()
    }

    iframe.onload = () => {
      const win = iframe.contentWindow
      if (!win) return cleanup()
      // Print after the label doc paints. afterprint removes the iframe.
      win.onafterprint = cleanup
      setTimeout(() => {
        win.focus()
        win.print()
        // Safety cleanup for browsers that never fire afterprint.
        setTimeout(cleanup, 3000)
      }, 150)
    }

    const doc = iframe.contentWindow?.document
    if (!doc) return cleanup()
    doc.open()
    doc.write(html)
    doc.close()
  })
}
