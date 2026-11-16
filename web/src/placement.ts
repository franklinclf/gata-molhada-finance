export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Placement {
  left: number;
  top: number;
  /** Room left on the chosen side; a panel taller than this scrolls. */
  maxHeight: number;
  side: 'below' | 'above';
}

/**
 * Where a floating panel goes (viewport coordinates): under its button, aligned to one edge of it, flipped above when there is
 * more room there, and pushed back inside the viewport so no edge is cut off.
 */
export function placePanel(anchor: Box, panel: { width: number; height: number }, viewport: { width: number; height: number }, align: 'left' | 'right', gap = 6, margin = 8): Placement {
  const wanted = align === 'right' ? anchor.right - panel.width : anchor.left;
  const left = Math.max(margin, Math.min(wanted, viewport.width - panel.width - margin));
  const roomBelow = viewport.height - margin - (anchor.bottom + gap);
  const roomAbove = anchor.top - gap - margin;
  const above = panel.height > roomBelow && roomAbove > roomBelow;
  const room = Math.max(above ? roomAbove : roomBelow, 0);
  const height = Math.min(panel.height, room);
  const top = above ? anchor.top - gap - height : anchor.bottom + gap;
  return { left, top, maxHeight: room, side: above ? 'above' : 'below' };
}
