/**
 * Glob patterns that hide files from a review. '*' matches inside one folder, '**' matches across
 * folders, '?' matches one character and '{a,b}' matches either word. A pattern matches at any depth,
 * so "Plugins/*.dll" also matches "/MyGame/Plugins/a.dll". A pattern that starts with '/' matches
 * only from the repository root. A pattern that matches a folder also hides everything in the folder.
 * Case does not matter, because Plastic paths on Windows ignore case.
 */
export function globToRegExp(pattern: string): RegExp {
  const clean = pattern.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  const anchored = clean.startsWith('/')
  const body = clean.replace(/^\/+/, '')
  let source = ''
  let braces = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '*' && body[i + 1] === '*') {
      const slash = body[i + 2] === '/'
      source += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (c === '*') source += '[^/]*'
    else if (c === '?') source += '[^/]'
    else if (c === '{') {
      braces++
      source += '(?:'
    } else if (c === '}' && braces > 0) {
      braces--
      source += ')'
    } else if (c === ',' && braces > 0) source += '|'
    else source += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&')
  }
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${source}(?:/.*)?$`, 'i')
}

/** The patterns of a settings text: one per line. Empty lines and lines that start with '#' do not count. */
export function parsePatterns(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

/** Returns a test that is true for the paths that any of the patterns hides. */
export function excludeMatcher(patterns: string[]): (path: string) => boolean {
  const tests = patterns.filter((p) => p.trim()).map(globToRegExp)
  return (path) => {
    const relative = path.replace(/\\/g, '/').replace(/^\/+/, '')
    return tests.some((test) => test.test(relative))
  }
}
