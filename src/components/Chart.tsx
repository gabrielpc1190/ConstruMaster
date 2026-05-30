/**
 * Gráfico de líneas SVG puro para series temporales.
 *
 * No usamos `recharts` ni `chart.js`: este proyecto evita dependencias visuales
 * grandes. SVG inline es suficiente para tendencias simples (TC, KPIs).
 *
 * Escala X: lineal entre min/max de las fechas (timestamps).
 * Escala Y: lineal entre 0 (o min - padding) y max + padding.
 * Ejes: 4 ticks horizontales (Y) + ticks en extremos + medio (X).
 *
 * Tooltip on hover: trackeamos el punto más cercano al cursor y lo destacamos
 * con un círculo + label flotante.
 */

import { useMemo, useState } from 'react';

export interface ChartPoint {
  x: Date | string;
  y: number;
}

export interface ChartSeries {
  label: string;
  color: string;
  points: ChartPoint[];
}

interface Props {
  series: ChartSeries[];
  height?: number;
  yLabel?: string;
  formatY?: (n: number) => string;
}

const PAD = { top: 16, right: 16, bottom: 28, left: 56 };
const DEFAULT_HEIGHT = 240;

function toTimestamp(x: Date | string): number {
  return x instanceof Date ? x.getTime() : new Date(x).getTime();
}

function formatDateShort(ts: number): string {
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}

export function Chart({ series, height = DEFAULT_HEIGHT, yLabel, formatY }: Props) {
  const [hover, setHover] = useState<{ ts: number; left: number; top: number } | null>(null);

  // Aplanar todos los puntos para computar escalas globales.
  const flat = useMemo(
    () => series.flatMap((s) => s.points.map((p) => ({ ts: toTimestamp(p.x), y: p.y, label: s.label, color: s.color }))),
    [series],
  );

  const hasData = flat.length > 0;
  const xMin = hasData ? Math.min(...flat.map((p) => p.ts)) : 0;
  const xMax = hasData ? Math.max(...flat.map((p) => p.ts)) : 1;
  const yMinRaw = hasData ? Math.min(...flat.map((p) => p.y)) : 0;
  const yMaxRaw = hasData ? Math.max(...flat.map((p) => p.y)) : 1;
  const yPad = Math.max((yMaxRaw - yMinRaw) * 0.1, 1);
  const yMin = Math.max(0, yMinRaw - yPad);
  const yMax = yMaxRaw + yPad;

  // Dimensiones internas (responsive vía viewBox).
  const W = 800;
  const H = height;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  function xToPx(ts: number): number {
    if (xMax === xMin) return PAD.left + innerW / 2;
    return PAD.left + ((ts - xMin) / (xMax - xMin)) * innerW;
  }
  function yToPx(y: number): number {
    if (yMax === yMin) return PAD.top + innerH / 2;
    return PAD.top + innerH - ((y - yMin) / (yMax - yMin)) * innerH;
  }

  // Ticks Y: 4 valores equiespaciados.
  const yTicks = useMemo(() => {
    const ticks: number[] = [];
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      ticks.push(yMin + ((yMax - yMin) * i) / steps);
    }
    return ticks;
  }, [yMin, yMax]);

  // Ticks X: extremos + medio.
  const xTicks = useMemo(() => {
    if (!hasData) return [];
    if (xMin === xMax) return [xMin];
    return [xMin, (xMin + xMax) / 2, xMax];
  }, [xMin, xMax, hasData]);

  const fmtY = formatY ?? ((n) => n.toFixed(2));

  // Hover handler: mapeamos el cursor a TS y agarramos el punto más cercano de la primera serie.
  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!hasData) return;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const mouseXRatio = (e.clientX - rect.left) / rect.width;
    const xPxInViewBox = mouseXRatio * W;
    if (xPxInViewBox < PAD.left || xPxInViewBox > W - PAD.right) {
      setHover(null);
      return;
    }
    const ratio = (xPxInViewBox - PAD.left) / innerW;
    const targetTs = xMin + ratio * (xMax - xMin);
    // Punto más cercano (cualquier serie).
    let bestTs = flat[0].ts;
    let bestDiff = Math.abs(flat[0].ts - targetTs);
    for (const p of flat) {
      const diff = Math.abs(p.ts - targetTs);
      if (diff < bestDiff) { bestDiff = diff; bestTs = p.ts; }
    }
    setHover({
      ts: bestTs,
      left: e.clientX - rect.left,
      top: e.clientY - rect.top,
    });
  }

  // Puntos destacados en el hover (uno por serie en la fecha bestTs).
  const hoverPoints = useMemo(() => {
    if (!hover) return [];
    return series.map((s) => {
      const p = s.points.find((pt) => toTimestamp(pt.x) === hover.ts);
      return p ? { label: s.label, color: s.color, x: toTimestamp(p.x), y: p.y } : null;
    }).filter(Boolean) as Array<{ label: string; color: string; x: number; y: number }>;
  }, [hover, series]);

  if (!hasData) {
    return (
      <div className="flex items-center justify-center text-sm text-slate-400 italic" style={{ height }}>
        Sin datos para graficar.
      </div>
    );
  }

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={yLabel ?? 'Gráfico de líneas'}
      >
        {/* Grid horizontal + ejes */}
        {yTicks.map((y) => (
          <g key={y}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={yToPx(y)}
              y2={yToPx(y)}
              stroke="#e2e8f0"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={yToPx(y) + 4}
              fontSize={11}
              textAnchor="end"
              fill="#64748b"
            >
              {fmtY(y)}
            </text>
          </g>
        ))}

        {/* Eje X: línea base + labels en ticks */}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={H - PAD.bottom}
          y2={H - PAD.bottom}
          stroke="#cbd5e1"
          strokeWidth={1}
        />
        {xTicks.map((ts) => (
          <text
            key={ts}
            x={xToPx(ts)}
            y={H - PAD.bottom + 16}
            fontSize={11}
            textAnchor="middle"
            fill="#64748b"
          >
            {formatDateShort(ts)}
          </text>
        ))}

        {/* yLabel rotado */}
        {yLabel && (
          <text
            x={14}
            y={PAD.top + innerH / 2}
            fontSize={11}
            textAnchor="middle"
            fill="#475569"
            transform={`rotate(-90 14 ${PAD.top + innerH / 2})`}
          >
            {yLabel}
          </text>
        )}

        {/* Series */}
        {series.map((s) => {
          const pts = s.points
            .slice()
            .sort((a, b) => toTimestamp(a.x) - toTimestamp(b.x))
            .map((p) => `${xToPx(toTimestamp(p.x))},${yToPx(p.y)}`)
            .join(' ');
          return (
            <polyline
              key={s.label}
              points={pts}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          );
        })}

        {/* Hover highlights */}
        {hoverPoints.map((hp) => (
          <circle
            key={hp.label}
            cx={xToPx(hp.x)}
            cy={yToPx(hp.y)}
            r={4}
            fill="white"
            stroke={hp.color}
            strokeWidth={2}
          />
        ))}

        {/* Línea vertical de cursor */}
        {hover && (
          <line
            x1={xToPx(hover.ts)}
            x2={xToPx(hover.ts)}
            y1={PAD.top}
            y2={H - PAD.bottom}
            stroke="#94a3b8"
            strokeWidth={1}
            strokeDasharray="4 2"
          />
        )}
      </svg>

      {/* Tooltip */}
      {hover && hoverPoints.length > 0 && (
        <div
          className="pointer-events-none absolute z-10 rounded-md bg-slate-900 px-2.5 py-1.5 text-xs text-white shadow-lg"
          style={{
            left: Math.min(hover.left + 12, 600),
            top: Math.max(hover.top - 8, 4),
          }}
        >
          <div className="font-medium opacity-80">{formatDateShort(hover.ts)}</div>
          {hoverPoints.map((hp) => (
            <div key={hp.label} className="flex items-center gap-1.5">
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ background: hp.color }}
              />
              <span>{hp.label}:</span>
              <span className="font-medium">{fmtY(hp.y)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Leyenda */}
      <div className="flex items-center justify-end gap-3 mt-1 text-xs text-slate-600">
        {series.map((s) => (
          <div key={s.label} className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-0.5" style={{ background: s.color }} />
            <span>{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default Chart;
