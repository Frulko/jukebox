// Derives OpenAPI schemas from `@jukebox/api-types`.
//
// The paths in the spec come from the router and cannot be wrong. The *shapes*
// were prose — `returns: '{ added, alreadyWanted, unknown }'` — which is the
// same hand-kept description this project already decided not to trust. A
// client generated from that spec knows every URL and nothing about what comes
// back.
//
// So the shapes are read from the types themselves, with the TypeScript
// compiler that is already a devDependency here. Not a parser written for the
// occasion, and not a second copy of every type maintained by hand.
//
//   node scripts/api-schemas.mjs           → writes apps/server/src/schemas.generated.ts
//   node scripts/api-schemas.mjs --check   → exits non-zero if that file is stale
//
// The generated file is committed, so the server never loads the compiler at
// runtime; `--check` in the test suite is what stops it drifting.

import ts from 'typescript'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(root, 'packages/api-types/src/index.ts')
const TARGET = join(root, 'apps/server/src/schemas.generated.ts')

const text = readFileSync(SOURCE, 'utf8')
const file = ts.createSourceFile(SOURCE, text, ts.ScriptTarget.Latest, true)

/** Every exported alias, so a reference to one becomes a `$ref` rather than `{}`. */
const known = new Set()
for (const node of file.statements) {
  if (ts.isTypeAliasDeclaration(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
    known.add(node.name.text)
  }
}

/** Names that could not be expressed, reported rather than silently emitted as `{}`. */
const gaps = []

const K = ts.SyntaxKind
const PRIMITIVES = {
  [K.StringKeyword]: { type: 'string' },
  [K.NumberKeyword]: { type: 'number' },
  [K.BooleanKeyword]: { type: 'boolean' },
  [K.NullKeyword]: { type: 'null' },
  [K.AnyKeyword]: {},
  [K.UnknownKeyword]: {},
}

function schemaOf(node, owner) {
  if (!node) return {}
  if (PRIMITIVES[node.kind]) return { ...PRIMITIVES[node.kind] }

  if (ts.isLiteralTypeNode(node)) {
    const l = node.literal
    if (ts.isStringLiteral(l)) return { type: 'string', const: l.text }
    if (ts.isNumericLiteral(l)) return { type: 'number', const: Number(l.text) }
    if (l.kind === K.NullKeyword) return { type: 'null' }
    if (l.kind === K.TrueKeyword || l.kind === K.FalseKeyword) {
      return { type: 'boolean', const: l.kind === K.TrueKeyword }
    }
  }

  if (ts.isArrayTypeNode(node)) return { type: 'array', items: schemaOf(node.elementType, owner) }
  if (ts.isParenthesizedTypeNode(node)) return schemaOf(node.type, owner)
  if (ts.isTypeLiteralNode(node)) return objectOf(node.members, owner)

  if (ts.isUnionTypeNode(node)) {
    const parts = node.types.filter((t) => t.kind !== K.UndefinedKeyword)
    // A union of string literals is an enum, which is what a generator wants —
    // `oneOf: [{const:'queued'}, …]` is the same thing spelled unreadably.
    const consts = parts.map((t) => schemaOf(t, owner))
    if (consts.length > 1 && consts.every((s) => s.const !== undefined && s.type === consts[0].type)) {
      return { type: consts[0].type, enum: consts.map((s) => s.const) }
    }
    // `T | null` is a nullable T, not a choice between two things.
    const nulls = consts.filter((s) => s.type === 'null')
    const rest = consts.filter((s) => s.type !== 'null')
    if (rest.length === 1) return nulls.length ? { ...rest[0], nullable: true } : rest[0]
    return nulls.length ? { oneOf: rest, nullable: true } : { oneOf: rest }
  }

  if (ts.isIntersectionTypeNode(node)) return { allOf: node.types.map((t) => schemaOf(t, owner)) }

  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText(file)
    const args = node.typeArguments ?? []

    if (name === 'Array' && args.length === 1) return { type: 'array', items: schemaOf(args[0], owner) }
    if (name === 'Record' && args.length === 2) {
      return { type: 'object', additionalProperties: schemaOf(args[1], owner) }
    }
    // Partial and Pick are used together in TrackPatch; both reduce to "some of
    // that shape", which for a request body is what the reader needs to know.
    if ((name === 'Partial' || name === 'Required' || name === 'Readonly') && args.length === 1) {
      const inner = schemaOf(args[0], owner)
      return name === 'Partial' ? { ...inner, required: undefined } : inner
    }
    if (name === 'Pick' && args.length === 2) {
      const from = expand(schemaOf(args[0], owner), owner)
      const keys = keysOf(args[1])
      if (from.properties && keys) {
        const properties = Object.fromEntries(keys.filter((k) => from.properties[k]).map((k) => [k, from.properties[k]]))
        return { type: 'object', properties }
      }
    }
    if (name === 'Omit' && args.length === 2) {
      const from = expand(schemaOf(args[0], owner), owner)
      const keys = new Set(keysOf(args[1]) ?? [])
      if (from.properties) {
        return { type: 'object', properties: Object.fromEntries(
          Object.entries(from.properties).filter(([k]) => !keys.has(k))) }
      }
    }
    if (known.has(name)) {
      // A generic alias referenced with arguments — `Page<Track>` — cannot be a
      // plain `$ref`, because the ref would lose the argument. Inlined instead.
      if (args.length) return inlineGeneric(name, args, owner)
      return { $ref: `#/components/schemas/${name}` }
    }
  }

  gaps.push(`${owner}: ${node.getText(file).slice(0, 60)}`)
  return {}
}

/**
 * A `$ref` back into the shape it points at.
 *
 * `Partial<Pick<Track, 'name' | …>>` needs Track's *fields*, and a reference is
 * exactly what a reference is for everywhere else. Only Pick and Omit have to
 * look through one.
 */
function expand(schema, owner) {
  const name = schema?.$ref?.split('/').pop()
  if (!name) return schema
  const decl = file.statements.find((s) => ts.isTypeAliasDeclaration(s) && s.name.text === name)
  return decl ? schemaOf(decl.type, owner) : schema
}

/** The string literals in `'a' | 'b'`, which is how Pick and Omit name fields. */
function keysOf(node) {
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return [node.literal.text]
  if (ts.isUnionTypeNode(node)) {
    const out = []
    for (const t of node.types) {
      if (!ts.isLiteralTypeNode(t) || !ts.isStringLiteral(t.literal)) return null
      out.push(t.literal.text)
    }
    return out
  }
  return null
}

/** `Page<Track>` — the alias body with its type parameter substituted. */
function inlineGeneric(name, args, owner) {
  const decl = file.statements.find((s) => ts.isTypeAliasDeclaration(s) && s.name.text === name)
  if (!decl?.typeParameters?.length) return { $ref: `#/components/schemas/${name}` }

  const bound = new Map(decl.typeParameters.map((p, i) => [p.name.text, args[i]]))
  const substitute = (schema) => JSON.parse(JSON.stringify(schema))

  // The parameter is looked up while walking, which is why the map is set
  // around the call rather than passed down: the walk is otherwise identical.
  const previous = generics
  generics = bound
  try {
    return substitute(schemaOf(decl.type, `${owner} → ${name}`))
  } finally {
    generics = previous
  }
}

let generics = new Map()

function objectOf(members, owner) {
  const properties = {}
  const required = []

  for (const m of members) {
    if (!ts.isPropertySignature(m) || !m.name) continue
    const key = ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) ? m.name.text : m.name.getText(file)

    // A bare type parameter — the `T` of `Page<T>` — resolves to whatever it
    // was called with.
    let type = m.type
    if (type && ts.isTypeReferenceNode(type) && generics.has(type.typeName.getText(file))) {
      type = generics.get(type.typeName.getText(file))
    } else if (type && ts.isArrayTypeNode(type) && ts.isTypeReferenceNode(type.elementType)
      && generics.has(type.elementType.typeName.getText(file))) {
      properties[key] = { type: 'array', items: schemaOf(generics.get(type.elementType.typeName.getText(file)), owner) }
      if (!m.questionToken) required.push(key)
      continue
    }

    const schema = schemaOf(type, `${owner}.${key}`)
    // The doc comment above a field is the best documentation this project has;
    // dropping it here would mean writing it a second time in the spec.
    const doc = commentOf(m)
    properties[key] = doc ? { ...schema, description: doc } : schema
    if (!m.questionToken) required.push(key)
  }

  const out = { type: 'object', properties }
  if (required.length) out.required = required
  return out
}

/** The JSDoc text, flattened to one line. */
function commentOf(node) {
  const doc = node.jsDoc?.[0]?.comment
  if (typeof doc === 'string') return doc.replace(/\s+/g, ' ').trim()
  if (Array.isArray(doc)) return doc.map((d) => d.text ?? '').join('').replace(/\s+/g, ' ').trim()
  return null
}

const schemas = {}
for (const node of file.statements) {
  if (!ts.isTypeAliasDeclaration(node)) continue
  if (!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue
  // A generic alias has no schema of its own — only its uses do.
  if (node.typeParameters?.length) continue

  const schema = schemaOf(node.type, node.name.text)
  const doc = commentOf(node)
  schemas[node.name.text] = doc ? { description: doc, ...schema } : schema
}

const out = `// Generated by scripts/api-schemas.mjs from packages/api-types/src/index.ts.
// Do not edit: run \`npm run api-schemas\`. A test fails when this is stale.
//
// Committed rather than generated at boot so the server never loads the
// TypeScript compiler to answer a request for its own documentation.

export const SCHEMAS: Record<string, any> = ${JSON.stringify(schemas, null, 2)}
`

if (process.argv.includes('--check')) {
  const current = (() => { try { return readFileSync(TARGET, 'utf8') } catch { return '' } })()
  if (current !== out) {
    console.error('api schemas · stale — run `npm run api-schemas`')
    process.exit(1)
  }
  console.error(`api schemas · ${Object.keys(schemas).length} up to date`)
} else {
  writeFileSync(TARGET, out)
  console.error(`api schemas · ${Object.keys(schemas).length} types → ${TARGET}`)
  if (gaps.length) console.error(`api schemas · not expressible, left open:\n  ${gaps.join('\n  ')}`)
}
