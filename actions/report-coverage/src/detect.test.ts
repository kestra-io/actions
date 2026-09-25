import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectFormat } from './detect.js'

test('detectFormat recognises LCOV by its SF: record', () => {
  assert.equal(detectFormat('TN:\nSF:src/foo.ts\nLF:10\nLH:8\nend_of_record\n'), 'lcov')
})

test('detectFormat recognises JaCoCo by its DTD', () => {
  assert.equal(
    detectFormat('<?xml version="1.0"?>\n<!DOCTYPE report SYSTEM "report.dtd">\n<report name="x"><package name="a"/></report>'),
    'jacoco'
  )
})

test('detectFormat recognises JaCoCo without the DTD line by its sourcefile children', () => {
  assert.equal(detectFormat('<report name="x"><package name="a"><sourcefile name="Foo.java"/></package></report>'), 'jacoco')
})

test('detectFormat recognises Cobertura by its line-rate attribute', () => {
  assert.equal(detectFormat('<?xml version="1.0"?>\n<coverage line-rate="0.5" branch-rate="0.3"><packages/></coverage>'), 'cobertura')
})

test('detectFormat gives up on unrecognised content', () => {
  assert.equal(detectFormat('{"not": "coverage"}'), undefined)
})
