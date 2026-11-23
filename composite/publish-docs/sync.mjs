import {createHash} from 'node:crypto';
import {existsSync, readFileSync, statSync} from 'node:fs';
import {basename, dirname, extname, join, posix} from 'node:path';
import {Client} from '@notionhq/client';
import {rewriteLinks, splitImages, toNotionMarkdown} from './markdown.mjs';
import {buildTree, field, parse} from './tree.mjs';

const {NOTION_TOKEN, NOTION_PARENT_PAGE_ID, DOCS_DIR, DOCS_PATH, DOCS_NAME, DOCS_REF, GITHUB_SERVER_URL, GITHUB_REPOSITORY} = process.env;

const SOURCE = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/blob/${DOCS_REF}`;

// a change in how pages are rendered must rewrite them, even when their source did not move
const VERSION = ['markdown.mjs', 'tree.mjs', 'sync.mjs']
    .map((name) => readFileSync(new URL(name, import.meta.url)))
    .reduce((hash, content) => hash.update(content), createHash('sha1'))
    .digest('hex');
const MARKER = 'notion-sync';

const ASYNC_THRESHOLD = 100 * 1024;

const IMAGE_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
};

const notion = new Client({auth: NOTION_TOKEN, notionVersion: '2026-03-11'});

const stats = {created: 0, updated: 0, trashed: 0, skipped: 0, images: 0};
const started = Date.now();

const log = (depth, icon, message) => console.log(`${'  '.repeat(depth)}${icon} ${message}`);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 180 requests per minute on the standard plan
const interval = 60_000 / 180;
let slot = 0;

const call = async (request) => {
    for (let attempt = 0; ; attempt++) {
        await wait(Math.max(0, slot - Date.now()));
        slot = Date.now() + interval;

        try {
            return await request();
        } catch (error) {
            if (![429, 529].includes(error.status) || attempt === 4) {
                throw error;
            }

            const retryAfter = Number(error.headers?.['retry-after']) * 1000;

            console.log(`::notice::rate limited by Notion (${error.status}), retry ${attempt + 1}/4`);

            await wait(retryAfter || 2 ** attempt * 1000 + Math.random() * 500);
        }
    }
};

const listChildren = async (block) => {
    const blocks = [];
    let cursor;

    do {
        const page = await call(() => notion.blocks.children.list({block_id: block, start_cursor: cursor, page_size: 100}));

        blocks.push(...page.results);
        cursor = page.next_cursor;
    } while (cursor);

    return blocks;
};

const trash = async (id, title, depth) => {
    await call(() => notion.pages.update({page_id: id, is_locked: false, in_trash: true}));

    stats.trashed++;
    log(depth, '🗑️ ', `${title} (no longer in the repository)`);
};

const upload = async (path, source) => {
    const type = IMAGE_TYPES[extname(path).toLowerCase()];

    if (!existsSync(path)) {
        console.log(`::warning file=${source}::image not found: ${path}`);

        return null;
    }

    if (!type) {
        console.log(`::warning file=${source}::unsupported image format: ${path}`);

        return null;
    }

    const filename = basename(path);
    const created = await call(() => notion.fileUploads.create({mode: 'single_part', filename, content_type: type}));

    await call(() => notion.fileUploads.send({
        file_upload_id: created.id,
        file: {filename, data: new Blob([readFileSync(path)], {type})},
    }));

    stats.images++;
    console.log(`     🖼️  ${filename}`);

    return created.id;
};

const callout = (text) => `<callout icon="🔒" color="gray_bg">${text}</callout>`;

// the hash rides in the backlink url, so a page whose source did not change can be skipped
const prepare = (file) => {
    const repoPath = (relative) => posix.join(DOCS_PATH, relative);

    if (!file) {
        const stamp = createHash('sha1').update(`${VERSION}${SOURCE}${DOCS_PATH}`).digest('hex').slice(0, 12);

        return {
            stamp,
            parts: [{markdown: callout(`Read only, synced from [GitHub](${SOURCE}/${DOCS_PATH}?${MARKER}=${stamp}). Edit it on GitHub.`)}],
        };
    }

    const {front, body} = parse(file.path);
    const folder = posix.dirname(file.relative);

    const linked = rewriteLinks(body, (target) => target.startsWith('/')
        ? `${SOURCE}${target}`
        : `${SOURCE}/${repoPath(posix.join(folder, target))}`);

    const hash = createHash('sha1').update(`${VERSION}${SOURCE}${DOCS_PATH}${readFileSync(file.path)}`);
    const parts = [];

    for (const segment of splitImages(linked)) {
        if (segment.type === 'text') {
            parts.push({markdown: toNotionMarkdown(segment.content)});

            continue;
        }

        const source = segment.src.replace(/[?#].*$/, '');
        const path = source.startsWith('/') ? null : join(dirname(file.path), decodeURI(source));

        if (path && existsSync(path)) {
            hash.update(readFileSync(path));
        }

        parts.push(path ? {path, alt: segment.alt, src: segment.src} : {markdown: `![${segment.alt}](${segment.src})`});
    }

    const declared = field(front, 'image');

    if (declared) {
        const path = join(dirname(file.path), declared);

        if (existsSync(path)) {
            hash.update(readFileSync(path));
        }

        parts.push({path, alt: '', src: declared});
    } else if (/^image:[^\S\n]*$/m.test(front?.[1] ?? '')) {
        console.log(`::warning file=${file.path}::declare a single image, not a list`);
    }

    const stamp = hash.digest('hex').slice(0, 12);
    const label = repoPath(file.relative);

    parts.unshift({
        markdown: callout(`Read only, synced from [${label}](${SOURCE}/${label}?${MARKER}=${stamp}). Edit it on GitHub.`),
    });

    return {stamp, parts};
};

const blocksOf = async (page) => {
    for (const block of await listChildren(page)) {
        if (block.type !== 'child_page') {
            await call(() => notion.blocks.delete({block_id: block.id}));
        }
    }
};

// images are blocks, so the text is inserted around them, each part at the top and last first, below nothing but the subpages
const insertParts = async (page, parts, file, large) => {
    for (const part of parts.reverse()) {
        if (part.path) {
            const id = await upload(part.path, file?.path);

            if (!id) {
                continue;
            }

            await call(() => notion.blocks.children.append({
                block_id: page,
                position: {type: 'start'},
                children: [{type: 'image', image: {type: 'file_upload', file_upload: {id}}}],
            }));

            continue;
        }

        const response = await call(() => notion.pages.updateMarkdown({
            page_id: page,
            type: 'insert_content',
            insert_content: {content: part.markdown, position: {type: 'start'}},
            allow_async: large,
        }));

        if (response.truncated) {
            console.log(`::warning file=${file?.path}::content truncated by Notion`);
        }
    }
};

// one call swaps the whole text, the subpage links are sent back untouched so Notion keeps them
const replaceText = async (page, parts, current) => {
    const children = current.markdown.match(/<page [^>]*>[\s\S]*?<\/page>/g) ?? [];

    await call(() => notion.pages.updateMarkdown({
        page_id: page,
        type: 'replace_content',
        replace_content: {new_str: [...parts.map((part) => part.markdown), ...children].join('\n\n')},
    }));
};

const write = async (page, node, prepared, current) => {
    const {parts} = prepared;
    const large = Boolean(node.file) && statSync(node.file.path).size > ASYNC_THRESHOLD;

    if (current && !current.truncated && !large && parts.every((part) => part.markdown !== undefined)) {
        try {
            await replaceText(page, parts, current);

            return;
        } catch (error) {
            console.log(`::notice::falling back to block by block update: ${error.message}`);
        }
    }

    if (current) {
        await blocksOf(page);
    }

    await insertParts(page, parts, node.file, large);
};

const sync = async (id, node, created, depth = 0) => {
    const label = node.file?.relative ?? `${node.title}/`;
    const prepared = prepare(node.file);
    const current = created ? null : await call(() => notion.pages.retrieveMarkdown({page_id: id}));
    const unchanged = current?.markdown.includes(`${MARKER}=${prepared.stamp}`);

    if (unchanged) {
        stats.skipped++;
        log(depth, '⏭️ ', `${node.title} (${label}) unchanged`);
    } else {
        log(depth, created ? '✨' : '🔄', `${node.title} (${label})`);
        stats[created ? 'created' : 'updated']++;

        if (!created) {
            await call(() => notion.pages.update({page_id: id, is_locked: false}));
        }

        await write(id, node, prepared, current);
    }

    const existing = (await listChildren(id)).filter((block) => block.type === 'child_page');
    const wanted = new Set(node.children.map((child) => child.title));
    const used = new Set();

    for (const block of existing) {
        // a removed or renamed doc is a stale page, and so is a duplicated title
        if (!wanted.has(block.child_page.title) || used.has(block.child_page.title)) {
            await trash(block.id, block.child_page.title, depth + 1);
        } else {
            used.add(block.child_page.title);
        }
    }

    for (const child of node.children) {
        const match = existing.find((block) => block.child_page.title === child.title);
        const page = match?.id ?? (await createPage(id, child.title)).id;

        await sync(page, child, !match, depth + 1);
    }

    if (unchanged) {
        return;
    }

    try {
        await call(() => notion.pages.update({page_id: id, is_locked: true}));
    } catch (error) {
        console.log(`::warning::could not lock the page '${node.title}': ${error.message}`);
    }
};

const createPage = (parent, title) => call(() => notion.pages.create({
    parent: {page_id: parent},
    properties: {title: {title: [{text: {content: title}}]}},
}));

const tree = buildTree(DOCS_DIR, DOCS_NAME);

console.log(`📚 ${DOCS_PATH} -> '${tree.title}' under ${NOTION_PARENT_PAGE_ID}`);
const root = (await listChildren(NOTION_PARENT_PAGE_ID))
    .find((block) => block.type === 'child_page' && block.child_page.title === tree.title);

// the repo page outlives every run so the parent page keeps its ordering and its links stay valid
const page = root?.id ?? (await createPage(NOTION_PARENT_PAGE_ID, tree.title)).id;

await sync(page, tree, !root);

console.log(`\n✅ ${stats.created} created, ${stats.updated} updated, ${stats.skipped} unchanged, ${stats.trashed} trashed, ${stats.images} images in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`🔗 https://www.notion.so/${page.replaceAll('-', '')}`);
