// A QR code drawn as one SVG path (uqr encodes it: nothing fetched, no innerHTML). Dark modules on a white quiet zone
// in every theme, because phone cameras read dark on light.
import { useMemo } from 'react';
import { encode } from 'uqr';

/** The quiet zone, in modules (the QR spec's minimum is 4). */
export const QR_BORDER = 4;

export function QrCode({ text, label, size = 176 }: { text: string; label: string; size?: number }) {
  const { d, n } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: QR_BORDER });
    let path = '';
    qr.data.forEach((row, y) => row.forEach((dark, x) => dark && (path += `M${x} ${y}h1v1h-1z`)));
    return { d: path, n: qr.size };
  }, [text]);
  return (
    <svg className="qr" role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
