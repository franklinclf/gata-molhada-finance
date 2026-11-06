import type { ComponentChildren, JSX } from 'preact';

/**
 * The few building blocks every screen uses, so a button or a label looks the same everywhere.
 * Styles live in styles.css under "design system e cores"; colors come from the palette variables.
 *
 * Which control to use:
 * - Button variant="primary": the one main action of a form or card. Same look as the older `.primary` class.
 * - Button variant="secondary" (default): any other action. `size="sm"` matches the older `.small` class.
 * - Button variant="ghost" or "link": a quiet text action inside a row or a sentence. "link" matches the older `.link` class.
 * - Button variant="danger": delete or discard.
 * - Chip: a toggle that filters or selects, like a period or "Selecionar". Replaces the older `.chip` buttons.
 * - `.icon` and `.icon-btn` stay for the top bar, where the button holds only a symbol.
 * The older classes (`.primary`, `.small`, `.link`, `.chip`, `.icon`) share the same radius, padding and hover as these in styles.css,
 * so a screen that still uses them looks the same; new code should use the components.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md';

const buttonClass = (variant: ButtonVariant, size: ButtonSize, extra?: string) => `btn btn-${variant}${size === 'sm' ? ' btn-sm' : ''}${extra ? ` ${extra}` : ''}`;

type ButtonProps = Omit<JSX.IntrinsicElements['button'], 'size'> & { variant?: ButtonVariant; size?: ButtonSize };

export function Button({ variant = 'secondary', size = 'md', class: extra, type = 'button', ...rest }: ButtonProps & { type?: 'button' | 'submit' }) {
  return <button {...rest} type={type} class={buttonClass(variant, size, extra as string | undefined)} />;
}

/** A link that looks like a button, for things that open another page or tab. */
export function ButtonLink({ variant = 'secondary', size = 'md', class: extra, href, target, rel, title, children }: { variant?: ButtonVariant; size?: ButtonSize; class?: string; href: string; target?: string; rel?: string; title?: string; children: ComponentChildren }) {
  return (
    <a class={buttonClass(variant, size, extra)} href={href} target={target} rel={rel} title={title}>
      {children}
    </a>
  );
}

/** A toggle that filters or selects, like "Selecionar" or a period. */
export function Chip({ on = false, class: extra, type = 'button', ...rest }: JSX.IntrinsicElements['button'] & { on?: boolean; type?: 'button' | 'submit' }) {
  return <button {...rest} type={type} aria-pressed={on} class={`chip${on ? ' on' : ''}${extra ? ` ${extra}` : ''}`} />;
}

export function Badge({ tone = 'muted', children, tip }: { tone?: 'muted' | 'good' | 'warn' | 'bad' | 'info'; children: ComponentChildren; tip?: string }) {
  return <span class={`badge ${tone}`} data-tip={tip}>{children}</span>;
}

/** A labeled control. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <label class="field">
      <span class="muted">{label}</span>
      {children}
      {hint && <span class="hint">{hint}</span>}
    </label>
  );
}

export function Panel({ title, actions, children, class: extra }: { title?: string; actions?: ComponentChildren; children: ComponentChildren; class?: string }) {
  return (
    <section class={`panel${extra ? ` ${extra}` : ''}`}>
      {(title || actions) && (
        <div class="panel-head">
          {title && <h2>{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
