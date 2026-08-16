import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.ts'
import { buildOpenApi, routeTable } from '../src/openapi.ts'

test('every route the server serves is described', () => {
  const { app, jobs } = createApp(':memory:')
  try {
    const undocumented = routeTable(app).filter((r) => !r.documented)
    // This is the assertion that keeps the document honest. A hand-kept spec
    // drifts the first time someone adds a route in a hurry, and a spec quietly
    // missing half the API is worse than none, because it is believed.
    assert.deepEqual(
      undocumented.map((r) => `${r.method} ${r.path}`), [],
      'add these to DOCS in openapi.ts',
    )
  } finally { jobs.stop() }
})

test('the document describes what is really mounted', () => {
  const { app, jobs } = createApp(':memory:')
  try {
    const spec = buildOpenApi(app) as any
    assert.equal(spec.openapi, '3.1.0')
    assert.deepEqual(spec.servers, [{ url: '/api/v1' }])

    // Path parameters are OpenAPI's braces, not Hono's colons.
    assert.ok(spec.paths['/tracks/{id}'], 'the colon form would be a different, wrong path')
    assert.ok(!Object.keys(spec.paths).some((p) => p.includes(':')))

    const get = spec.paths['/tracks/{id}'].get
    assert.equal(get.parameters.find((p: any) => p.in === 'path').name, 'id')

    // Both ways of presenting a token, because one of them looks like a mistake
    // until it is written down.
    assert.ok(spec.components.securitySchemes.bearer)
    assert.equal(spec.components.securitySchemes.query.name, 'token')

    // Declared query parameters survive.
    const tracks = spec.paths['/tracks'].get
    assert.ok(tracks.parameters.some((p: any) => p.name === 'notOnDevice'))
  } finally { jobs.stop() }
})

test('the spec is readable without an account, like a README', async () => {
  const { app, jobs } = createApp(':memory:')
  try {
    const setup = await app.fetch(new Request('http://x/api/v1/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'g', password: 'hunter2!' }),
    }))
    assert.equal(setup.status, 201, 'the server is now closed')

    // A third party deciding whether to write a client should not need an
    // account before they can read what the API offers.
    const res = await app.fetch(new Request('http://x/api/v1/openapi.json'))
    assert.equal(res.status, 200)
    const spec = await res.json() as any
    assert.ok(Object.keys(spec.paths).length > 50)
    assert.equal((await app.fetch(new Request('http://x/api/v1/stats'))).status, 401,
      'while everything else still needs a token')
  } finally { jobs.stop() }
})
