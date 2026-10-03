/**
 * Minimal ANSI styling.
 *
 * Deliberately dependency-free and accessibility-aware:
 *   - `NO_COLOR` (https://no-color.org) disables color unconditionally.
 *   - `FORCE_COLOR` / `FORCE_NO_COLOR` override TTY detection.
 *   - Color is never the only signal: every status also carries a symbol and a word.
 */

export type Style =
  | 'bold'
  | 'dim'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'gray';

const CODES: Record<Style, [number, number]> = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  gray: [90, 39],
};

const STYLES = Object.keys(CODES) as Style[];

export interface Colorizer {
  enabled: boolean;
  bold: (text: string) => string;
  cyan: (text: string) => string;
  dim: (text: string) => string;
  gray: (text: string) => string;
  green: (text: string) => string;
  magenta: (text: string) => string;
  nest: (text: string, ...styles: Style[]) => string;
  red: (text: string) => string;
  style: (name: Style) => (text: string) => string;
  yellow: (text: string) => string;
}

/** Builds a colorizer that is a no-op when `enabled` is false. */
export function createColorizer(enabled: boolean): Colorizer {
  const make = (name: Style) => (text: string): string => {
    if (!enabled) return text;
    const [open, close] = CODES[name];
    return `\u001B[${open}m${text}\u001B[${close}m`;
  };

  const colorizer: Colorizer = {
    enabled,
    bold: make('bold'),
    cyan: make('cyan'),
    dim: make('dim'),
    gray: make('gray'),
    green: make('green'),
    magenta: make('magenta'),
    nest: (text: string, ...styles: Style[]): string =>
      styles.reduceRight((acc, style) => make(style)(acc), text),
    red: make('red'),
    style: make,
    yellow: make('yellow'),
  };
  return colorizer;
}

/**
 * Decides whether ANSI color should be used.
 *
 * Precedence: explicit `--no-color` / `--color`, then `NO_COLOR`/`FORCE_*`, then TTY.
 */
export function shouldUseColor(options: {
  colorFlag?: boolean;
  isTTY: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = options.env ?? process.env;
  if (options.colorFlag !== undefined) return options.colorFlag;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.AGENTSNAP_NO_COLOR !== '0' && env.AGENTSNAP_COLOR === '0') return false;
  if (env.AGENTSNAP_COLOR === '1') return true;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  if (env.FORCE_NO_COLOR !== undefined) return false;
  return options.isTTY;
}

/** Accessibility-safe status glyphs. Always paired with a text label in reports. */
export const GLYPH = {
  arrow: '\u2192',
  fail: '\u2717',
  info: '\u2022',
  pass: '\u2713',
  skip: '\u2212',
  warn: '\u26A0',
} as const;

/** Single-width box drawing used for failure blocks. */
export const RULE = '\u2501'.repeat(64);

export const STYLE_NAMES = STYLES;
