import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCobertura } from './cobertura.js'

const FIXTURE = `<?xml version="1.0"?>
<coverage line-rate="0.8" branch-rate="0.5">
  <sources><source>/workspace/src</source></sources>
  <packages>
    <package name="pkg">
      <classes>
        <class filename="foo.py">
          <lines>
            <line number="1" hits="1"/>
            <line number="2" hits="0"/>
            <line number="3" hits="2" branch="true" condition-coverage="50% (1/2)"/>
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>`

test('parseCobertura resolves the file against <sources> and counts hits', () => {
  const files = parseCobertura(FIXTURE, '/workspace')
  assert.deepEqual(files, [
    { path: 'src/foo.py', format: 'cobertura', lines: { covered: 2, missed: 1 }, branches: { covered: 1, missed: 1 } }
  ])
})

test('parseCobertura yields nothing when there is no <coverage> root', () => {
  assert.deepEqual(parseCobertura('<not-coverage/>', '/workspace'), [])
})

test('parseCobertura skips a class with no filename', () => {
  const xml = `<coverage><packages><package><classes><class><lines/></class></classes></package></packages></coverage>`
  assert.deepEqual(parseCobertura(xml, '/workspace'), [])
})
