import { brl, brlShort, dayMonth } from './format.ts';

export const PALETTE = ['#c6f432', '#8b7cff', '#ffb547', '#ff6b6b', '#4dd6c4', '#5aa9ff', '#f78fd0', '#9aa4b2'];

export function Ring({ segments, size = 140, children }: { segments: Array<{ value: number; color: string }>; size?: number; children?: preact.ComponentChildren }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div class="ring" style={{ width: `${size}px`, height: `${size}px` }}>
      <svg viewBox="0 0 120 120" width={size} height={size} role="img" aria-hidden="true">
        <circle cx="60" cy="60" r={radius} fill="none" stroke="var(--track)" stroke-width="12" />
        {total > 0 &&
          segments.map((segment, i) => {
            const length = (segment.value / total) * circumference;
            const circle = (
              <circle
                key={i}
                cx="60"
                cy="60"
                r={radius}
                fill="none"
                stroke={segment.color}
                stroke-width="12"
                stroke-dasharray={`${Math.max(length - 1.5, 0)} ${circumference}`}
                stroke-dashoffset={-offset}
                transform="rotate(-90 60 60)"
              />
            );
            offset += length;
            return circle;
          })}
      </svg>
      <div class="ring-center">{children}</div>
    </div>
  );
}

/** One horizontal bar split into parts, like the balance-by-institution bar. */
export function StackBar({ parts }: { parts: Array<{ value: number; color: string; label: string }> }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div class="stackbar" role="img" aria-label="Divisão por instituição">
      {parts.map((p, i) => (
        <span key={i} title={p.label} style={{ width: `${total > 0 ? (p.value / total) * 100 : 0}%`, background: p.color }} />
      ))}
    </div>
  );
}

export function Meter({ fraction, color = 'var(--accent)' }: { fraction: number; color?: string }) {
  const clamped = Math.min(1, Math.max(0, fraction));
  return (
    <div class="meter">
      <span style={{ width: `${clamped * 100}%`, background: clamped > 0.85 ? 'var(--bad)' : color }} />
    </div>
  );
}

export function Bars({ data, hidden }: { data: Array<{ label: string; value: number; color?: string }>; hidden: boolean }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div class="bars">
      {data.map((d, i) => (
        <div class="bar" key={i}>
          <span class="bar-value">{brlShort(d.value, hidden)}</span>
          <span class="bar-fill" style={{ height: `${(d.value / max) * 100}%`, background: d.color ?? 'var(--accent)' }} />
          <span class="bar-label">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Running total as a line with a soft fill. */
export function LineChart({ points, hidden }: { points: number[]; hidden: boolean }) {
  if (points.length < 2) return <div class="empty">Sem dados no período</div>;
  const width = 300;
  const height = 90;
  const max = Math.max(1, ...points);
  const x = (i: number) => (i / (points.length - 1)) * width;
  const y = (v: number) => height - (v / max) * (height - 6) - 3;
  const path = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  return (
    <svg class="line" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={hidden ? 'Gastos acumulados' : `Gastos acumulados, total ${brl(points[points.length - 1] ?? 0)}`}>
      <path d={`${path} L${width} ${height} L0 ${height} Z`} fill="var(--accent)" opacity="0.12" />
      <path d={path} fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" />
    </svg>
  );
}

/** One dot per day: green when more came in than went out, red otherwise, grey when nothing happened. */
export function DayDots({ days, from, to }: { days: Array<{ day: string; inflow: number; outflow: number }>; from: string; to: string }) {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const cells: Array<{ day: string; net: number | null }> = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`) && cells.length < 400; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    const entry = byDay.get(day);
    cells.push({ day, net: entry ? entry.inflow - entry.outflow : null });
  }
  return (
    <div class="dots">
      {cells.map((c) => (
        <span key={c.day} title={dayMonth(c.day)} class={c.net === null ? 'dot' : c.net >= 0 ? 'dot good' : 'dot bad'} />
      ))}
    </div>
  );
}
