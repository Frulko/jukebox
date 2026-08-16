import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate, open } from '../src/db.ts'

const versionOf = (db: any) =>
  (db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version

test('a fresh database lands on the current version', () => {
  const db = open(':memory:')
  assert.ok(versionOf(db) > 0, 'a database at version 0 would re-run every migration on next boot')
})

test('migrating twice is a no-op', () => {
  const db = open(':memory:')
  const first = versionOf(db)
  migrate(db)
  assert.equal(versionOf(db), first)
})

test('a database from before migrations existed is brought up without losing data', () => {
  // What an install from an earlier build actually looks like: every table
  // present, because `open` runs the schema first, and `user_version` still 0
  // because nothing ever set it. Migrations alter those tables, so a stripped
  // stand-in would test a database that has never existed.
  const old = open(':memory:')
  old.exec(`PRAGMA user_version = 0`)
  old.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('revision', '42')`)

  migrate(old)
  assert.ok(versionOf(old) > 0)
  const row = old.prepare(`SELECT value FROM meta WHERE key = 'revision'`).get() as { value: string }
  assert.equal(row.value, '42', 'existing rows survive the upgrade')
  // Re-running an ALTER that already applied must not throw.
  assert.doesNotThrow(() => migrate(old))
})

test('a failing migration rolls back and leaves the version where it was', () => {
  const db = new DatabaseSync(':memory:')
  const broken = [
    `CREATE TABLE good (id TEXT)`,
    `CREATE TABLE half (id TEXT); THIS IS NOT SQL;`,
  ]
  assert.throws(() => migrate(db, broken), /migration 2 failed/)

  // Migration 1 committed on its own and stays applied; 2 left nothing behind.
  assert.equal(versionOf(db), 1, 'a version bumped past a failed step could never be retried')
  assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'good'`).get())
  assert.equal(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'half'`).get(), undefined,
    'the failed migration left no half-built table')

  // Fixing the migration and re-running picks up exactly where it stopped.
  migrate(db, [broken[0], `CREATE TABLE half (id TEXT)`])
  assert.equal(versionOf(db), 2)
  assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'half'`).get())
})

test('a database already past the last migration is left alone', () => {
  const db = open(':memory:')
  const before = versionOf(db)
  migrate(db)
  assert.equal(versionOf(db), before)
})
