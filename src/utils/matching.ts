import { minimatch } from 'minimatch';
import { toPosixPath } from './paths.js';

export interface MatcherSpec {
  pattern: string;
  /** Treat `pattern` as a regular expression instead of a glob. */
  regex?: boolean;
  ignoreCase?: boolean;
}

/**
 * Matches filesystem-ish strings (POSIX relative paths, tool names, command lines).
 *
 * Patterns are always normalized to POSIX separators so a single config works on
 * Windows, macOS and Linux. `**` crosses directories, `*` does not, `{a,b}` alternation
 * and `!pattern` negation are supported by the underlying matcher.
 */
export interface Matcher {
  readonly pattern: string;
  isMatch(value: string): boolean;
}

const cache = new Map<string, Matcher>();

export function createMatcher(spec: MatcherSpec): Matcher {
  const key = `${spec.regex ? 're' : 'glob'}:${spec.ignoreCase ? 'i' : ''}:${spec.pattern}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let matcher: Matcher;
  if (spec.regex) {
    let expression: RegExp;
    try {
      expression = new RegExp(spec.pattern, spec.ignoreCase ? 'i' : '');
    } catch (error) {
      throw new Error(
        `Invalid regular expression ${JSON.stringify(spec.pattern)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    matcher = {
      isMatch: (value: string) => {
        expression.lastIndex = 0;
        return expression.test(value);
      },
      pattern: spec.pattern,
    };
  } else {
    const glob = toPosixPath(spec.pattern);
    matcher = {
      isMatch: (value: string) =>
        minimatch(toPosixPath(value), glob, {
          dot: true,
          nocase: spec.ignoreCase === true,
        }),
      pattern: glob,
    };
  }

  cache.set(key, matcher);
  return matcher;
}

export function matchesAny(value: string, specs: readonly MatcherSpec[]): string[] {
  return specs.filter((spec) => createMatcher(spec).isMatch(value)).map((spec) => spec.pattern);
}

/** True when any matcher hits. Used to exclude paths while scanning a workspace. */
export function matchesAnyGlob(value: string, patterns: readonly MatcherSpec[]): boolean {
  return patterns.some((spec) => createMatcher(spec).isMatch(value));
}

/** Validates a glob/regex spec structurally. Returns human-readable problems. */
export function validateMatcherSpec(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== 'string') {
    problems.push('expected a pattern string.');
    return problems;
  }
  if (value.trim() === '') {
    problems.push('pattern must not be empty.');
    return problems;
  }
  if (value.includes('\0')) problems.push('pattern must not contain NUL bytes.');
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    problems.push('pattern must be relative to the project root (do not start with "/" or a drive letter).');
  }
  return problems;
}

/** Renders a matcher spec for report output. */
export function describeMatcher(spec: MatcherSpec): string {
  return spec.regex ? `~/${spec.pattern}/` : spec.pattern;
}
