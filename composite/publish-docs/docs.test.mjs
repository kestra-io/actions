import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {rewriteLinks, splitImages, toNotionMarkdown} from './markdown.mjs';
import {buildTree} from './tree.mjs';

test('splitImages cuts around local images only', () => {
    const segments = splitImages('a\n![x](./img/a.png)\nb ![r](https://e.io/r.png) c\n```\n![k](k.png)\n```');

    assert.deepEqual(segments.map((s) => s.type), ['text', 'image', 'text']);
    assert.equal(segments[1].src, './img/a.png');
    assert.match(segments[2].content, /!\[r\]\(https:\/\/e\.io\/r\.png\)/);
    assert.match(segments[2].content, /!\[k\]\(k\.png\)/);
});

test('rewriteLinks only touches relative links outside fences', () => {
    const out = rewriteLinks('[a](b.md) [c](https://x.io) [d](#e)\n```\n[f](g.md)\n```', (t) => `GH/${t}`);

    assert.equal(out, '[a](GH/b.md) [c](https://x.io) [d](#e)\n```\n[f](g.md)\n```');
});

test('buildTree uses index.md as the folder page', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docs-'));

    mkdirSync(join(dir, 'guide'));
    writeFileSync(join(dir, 'index.md'), '# Home\n');
    writeFileSync(join(dir, 'intro.md'), '---\ntitle: Intro\n---\nbody');
    writeFileSync(join(dir, 'guide', 'index.md'), '# Guide\n');
    writeFileSync(join(dir, 'guide', '02-setup.md'), 'no title');

    const tree = buildTree(dir, 'Repo');

    assert.equal(tree.title, 'Repo');
    assert.equal(tree.file.relative, 'index.md');
    assert.deepEqual(tree.children.map((c) => c.title), ['Guide', 'Intro']);
    assert.deepEqual(tree.children[0].children.map((c) => [c.title, c.file.relative]), [['Setup', 'guide/02-setup.md']]);
});

test('toNotionMarkdown joins wrapped lines but keeps hard breaks, fences and list structure', () => {
    const out = toNotionMarkdown([
        '- `a` (x) — computes,',
        '  group for "Values",',
        '  posts to Slack.',
        '- `b` reads  ',
        '  the doc.',
        '',
        'para one',
        'para two',
        '',
        '```',
        'keep',
        'this',
        '```',
    ].join('\n'));

    assert.equal(out, [
        '- `a` (x) — computes, group for "Values", posts to Slack.',
        '- `b` reads  ',
        '  the doc.',
        '',
        'para one para two',
        '',
        '```text',
        'keep',
        'this',
        '```',
    ].join('\n'));
});

test('toNotionMarkdown renders tables full width', () => {
    const out = toNotionMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');

    assert.match(out, /^<table fit-page-width="true" header-row="true">\n<colgroup>/);

    const widths = [...out.matchAll(/<col width="(\d+)"/g)].map((match) => Number(match[1]));

    assert.equal(widths.length, 2);
    assert.equal(widths[0] + widths[1], 700);
});
