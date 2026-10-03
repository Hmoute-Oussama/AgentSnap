import type { TestCase } from '../config/types.js';

export interface TestFilter {
  /** Test names are matched as POSIX globs. */
  name?: string;
  /** A test runs when it carries any of these tags. */
  tags?: string[];
  /** Excludes matching names/tags. Applied after the include filters. */
  exclude?: string;
  matches(test: TestCase): boolean;
  /** Human-readable description of the active filters, for diagnostics and warnings. */
  describe(): Record<string, unknown>;
}

const NO_FILTER: TestFilter = {
  describe: () => ({}),
  matches: () => true,
};

export const ALL_TESTS: TestFilter = NO_FILTER;

/** Builds a filter from CLI flags. Unset flags are not applied. */
export function createTestFilter(options: {
  name?: string | undefined;
  tags?: string[] | undefined;
  exclude?: string | undefined;
}): TestFilter {
  const { name, tags, exclude } = options;
  if (!name && (!tags || tags.length === 0) && !exclude) return NO_FILTER;

  const excludeMatcher = exclude ? compileGlob(exclude) : null;

  return {
    describe: () => ({ exclude, name, tags }),
    matches: (test) => {
      if (name && !compileGlob(name)(test.name)) return false;
      if (tags && tags.length > 0 && !tags.some((tag) => test.tags.includes(tag))) return false;
      if (excludeMatcher && (excludeMatcher(test.name) || test.tags.some(excludeMatcher))) return false;
      return true;
    },
  };
}

/**
 * Minimal POSIX glob matcher for test-name selection.
 *
 * Implemented locally instead of pulling `minimatch` semantics into the filter so that
 * `agentsnap run "web/*"` behaves predictably on Windows, where paths use backslashes but
 * user-written patterns never do.
 */
function compileGlob(pattern: string): (value: string) => boolean {
  const source = `^${pattern
    .split('')
    .map((char) => {
      if (char === '*') return '[^/]*';
      if (char === '?') return '[^/]';
      return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
    })
    .join('')
    // A `**` segment was already expanded to `[^/]*`; collapse the doubled star.
    .replace(/\[\^\/\]\*\[\^\/\]\*/g, '.*')
    .replace(/\[\^\/\]\*\\\//g, '(?:.*/)?')
    .replace(/\\\//g, '/')}$`;
  const expression = new RegExp(source);
  return (value) => expression.test(value);
}