import { useState } from 'preact/hooks';
import { brl, brlShort, dayMonth } from './format.ts';

export const PALETTE = ['#c6f432', '#8b7cff', '#ffb547', '#ff6b6b', '#4dd6c4', '#5aa9ff', '#f78fd0', '#9aa4b2'];

interface Segment {
  value: number;
  color: string;
  /** Text shown on hover, for example the category name and amount. */
  tip?: string;
  key?: string;
}

/** Donut chart. Segments highlight on hover and can be clicked; the centre shows what is under the pointer. */
export function Ring({ segments, size = 140, children, onSelect, selected }: { segments: Segment[]; size?: number; children?: preact.ComponentChildren; onSelect?: (key: string) => void; selected?: string | null }) {
  const [hover, setHover] = useState<number | null>(null);
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
            const active = hover === i || (segment.key !== undefined && segment.key === selected);
            const circle = (
              <circle
                key={i}
                class={onSelect && segment.key !== undefined ? 'seg-ring clickable' : 'seg-ring'}
                data-tip={segment.tip}
                cx="60"
                cy="60"
                r={radius}
                fill="none"
                stroke={segment.color}
                stroke-width={active ? 16 : 12}
                opacity={hover !== null && !active ? 0.45 : 1}
                stroke-dasharray={`${Math.max(length - 1.5, 0)} ${circumference}`}
                stroke-dashoffset={-offset}
                transform="rotate(-90 60 60)"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onClick={() => segment.key !== undefined && onSelect?.(segment.key)}
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
export function StackBar({ parts }: { parts: Array<{ value: number; color: string; label: string; tip?: string }> }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div class="stackbar" role="img" aria-label="Divisão por instituição">
      {parts.map((p, i) => (
        <span key={i} data-tip={p.tip ?? p.label} style={{ width: `${total > 0 ? (p.value / total) * 100 : 0}%`, background: p.color }} />
      ))}
    </div>
  );
}

export function Meter({ fraction, color = 'var(--accent)', tip }: { fraction: number; color?: string; tip?: string }) {
  const clamped = Math.min(1, Math.max(0, fraction));
  return (
    <div class="meter" data-tip={tip}>
      <span style={{ width: `${clamped * 100}%`, background: clamped > 0.85 ? 'var(--bad)' : color }} />
    </div>
  );
}

export interface BarDatum {
  key: string;
  /** Bars with the same group are selected together (for example the in and out bars of one month). */
  group?: string;
  label: string;
  value: number;
  color?: string;
  /** Text under the cursor. */
  tip?: string;
}

/**
 * Vertical bars. Hover shows the exact figure; when onSelect is given a bar can be clicked to choose that period,
 * and the selected bar stays highlighted while the others dim.
 */
export function Bars({ data, hidden, selected, onSelect, height = 130 }: { data: BarDatum[]; hidden: boolean; selected?: string | null; onSelect?: (key: string) => void; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const Tag = onSelect ? 'button' : 'div';
  return (
    <div class="bars" style={{ height: `${height}px` }} role="group">
      {data.map((d) => {
        const id = d.group ?? d.key;
        const on = selected === undefined || selected === null || selected === id;
        return (
          <Tag
            key={d.key}
            class={onSelect ? (on ? 'bar clickable on' : 'bar clickable') : 'bar'}
            data-tip={hidden ? d.label : (d.tip ?? `${d.label}: ${brl(d.value)}`)}
            onClick={() => onSelect?.(id)}
            aria-pressed={onSelect ? selected === id : undefined}
          >
            <span class="bar-value">{brlShort(d.value, hidden)}</span>
            <span class="bar-track">
              <span class="bar-fill" style={{ height: `${(d.value / max) * 100}%`, background: d.color ?? 'var(--accent)', opacity: on ? 1 : 0.35 }} />
            </span>
            <span class="bar-label">{d.label}</span>
          </Tag>
        );
      })}
    </div>
  );
}

/** Running total as a line with a soft fill and a pointer that reads the value of the day under it. */
export function LineChart({ points, hidden, days }: { points: number[]; hidden: boolean; days?: string[] }) {
  const [at, setAt] = useState<number | null>(null);
  if (points.length < 2) return <div class="empty">Sem dados no período</div>;
  const width = 300;
  const height = 90;
  const max = Math.max(1, ...points);
  const x = (i: number) => (i / (points.length - 1)) * width;
  const y = (v: number) => height - (v / max) * (height - 6) - 3;
  const path = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const shown = at ?? points.length - 1;
  const label = `${days?.[shown] ? `${dayMonth(days[shown]!)}: ` : ''}${hidden ? '••••' : brl(points[shown] ?? 0)}`;
  return (
    <div
      class="line-wrap"
      data-tip={at === null ? undefined : label}
      onMouseMove={(e) => {
        const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setAt(Math.min(points.length - 1, Math.max(0, Math.round(((e.clientX - box.left) / box.width) * (points.length - 1)))));
      }}
      onMouseLeave={() => setAt(null)}
    >
      <svg class="line" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={hidden ? 'Gastos acumulados' : `Gastos acumulados, total ${brl(points[points.length - 1] ?? 0)}`}>
        <path d={`${path} L${width} ${height} L0 ${height} Z`} fill="var(--accent)" opacity="0.12" />
        <path d={path} fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" />
        {at !== null && <line x1={x(at)} x2={x(at)} y1="0" y2={height} stroke="var(--muted)" stroke-width="1" vector-effect="non-scaling-stroke" stroke-dasharray="3 3" />}
        {at !== null && <circle cx={x(at)} cy={y(points[at] ?? 0)} r="3.5" fill="var(--accent)" vector-effect="non-scaling-stroke" />}
      </svg>
    </div>
  );
}

/** One dot per day: green when more came in than went out, red otherwise, grey when nothing happened. */
export function DayDots({ days, from, to, hidden = false, onSelect }: { days: Array<{ day: string; inflow: number; outflow: number }>; from: string; to: string; hidden?: boolean; onSelect?: (day: string) => void }) {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const cells: Array<{ day: string; inflow: number; outflow: number; has: boolean }> = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`) && cells.length < 400; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    const entry = byDay.get(day);
    cells.push({ day, inflow: entry?.inflow ?? 0, outflow: entry?.outflow ?? 0, has: entry !== undefined });
  }
  return (
    <div class="dots">
      {cells.map((c) => {
        const net = c.inflow - c.outflow;
        const tone = !c.has ? 'dot' : net >= 0 ? 'dot good' : 'dot bad';
        const tip = c.has ? `${dayMonth(c.day)}\nEntrou ${hidden ? '••••' : brl(c.inflow)}\nSaiu ${hidden ? '••••' : brl(c.outflow)}` : `${dayMonth(c.day)}: sem movimento`;
        const Tag = onSelect ? 'button' : 'span';
        return <Tag key={c.day} class={onSelect ? `${tone} clickable` : tone} data-tip={tip} onClick={() => onSelect?.(c.day)} aria-label={tip} />;
      })}
    </div>
  );
}
