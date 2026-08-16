// Writes docs/api-reference.md, with the frontmatter the docs site needs.
//
// The generator itself emits plain Markdown and takes no view on where it
// lands; the site's content collection requires a title and a description. So
// this wraps rather than forks it — regenerating stays one command, and the
// front matter cannot drift from the file it heads.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const body = execFileSync('npm', ['run', '--silent', 'api-reference'], { encoding: 'utf8' })

const front = `---
title: API reference
description: Every route the server serves, generated from the router itself.
---

`

// The layout prints the title from the front matter, so the document's own H1
// would appear twice on the page and nowhere else.
const withoutTitle = body.trimStart().replace(/^#\s+API reference\n+/m, '')

writeFileSync(new URL('../docs/api-reference.md', import.meta.url), front + withoutTitle)
console.log('✓ docs/api-reference.md')
