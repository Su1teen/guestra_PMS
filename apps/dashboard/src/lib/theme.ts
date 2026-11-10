/**
 * White-label support for the staff dashboard theme tokens (see src/index.css).
 * A hotel accent colour replaces the action colour only when white text on it stays readable,
 * so a pale brand colour can never make primary buttons illegible.
 */

/** "#rgb" / "#rrggbb" → [r, g, b], or null when the value is not a hex colour. */
export function parseHex(value: string | null | undefined): [number, number, number] | null {
  const hex = value?.trim().replace(/^#/, '') ?? '';
  const full = /^[0-9a-f]{3}$/i.test(hex) ? hex.split('').map((c) => c + c).join('') : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]) {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio of white text on the colour. */
export function contrastWithWhite(rgb: [number, number, number]) {
  return 1.05 / (luminance(rgb) + 0.05);
}

/** Minimum contrast for button labels (WCAG AA for 14px semibold UI text). */
export const MIN_ACTION_CONTRAST = 4.5;

/** CSS variable values ("r g b") for the action colour ramp, or null to keep the default theme. */
export function actionColorTokens(value: string | null | undefined): Record<string, string> | null {
  const rgb = parseHex(value);
  if (!rgb || contrastWithWhite(rgb) < MIN_ACTION_CONTRAST) return null;
  const mix = (target: number, weight: number) => rgb.map((c) => Math.round(c + (target - c) * weight)).join(' ');
  return {
    '--color-primary': rgb.join(' '),
    '--color-primary-strong': mix(0, 0.18),
    '--color-primary-soft': mix(255, 0.2),
    '--color-primary-50': mix(255, 0.92),
    '--color-primary-100': mix(255, 0.85),
    '--color-primary-200': mix(255, 0.7),
    '--color-primary-300': mix(255, 0.5),
  };
}

export const ACTION_TOKEN_NAMES = Object.keys(actionColorTokens('#000000') ?? {});
