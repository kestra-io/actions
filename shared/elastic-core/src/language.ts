const LANGUAGES: Record<string, string> = {
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', groovy: 'groovy', gradle: 'gradle',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', vue: 'vue',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', php: 'php', cs: 'csharp',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  yml: 'yaml', yaml: 'yaml', json: 'json', xml: 'xml', toml: 'toml',
  tf: 'terraform', hcl: 'terraform', sql: 'sql', md: 'markdown', html: 'html', css: 'css',
  jar: 'jar', war: 'jar', lock: 'lockfile'
}

/**
 * The language of a file. Named after the kind of file rather than just its extension, so a
 * Dockerfile or a pom.xml reads as what it is.
 */
export function languageOf(file: string | undefined): string | undefined {
  if (!file) return undefined
  const name = file.split('/').pop() ?? file
  if (/^Dockerfile/i.test(name)) return 'dockerfile'
  if (/^Makefile$/i.test(name)) return 'make'
  if (name === 'pom.xml') return 'maven'
  if (name === 'go.mod' || name === 'go.sum') return 'go'
  if (name === 'package.json' || name === 'package-lock.json') return 'npm'
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined
  return extension ? (LANGUAGES[extension] ?? extension) : undefined
}
