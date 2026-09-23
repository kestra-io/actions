import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {basename, extname, join} from 'node:path';
import {Client} from '@notionhq/client';
import {toNotionMarkdown} from './markdown.mjs';

const {NOTION_TOKEN, NOTION_PARENT_PAGE_ID, DOCS_DIR, DOCS_NAME} = process.env;

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

            await wait(retryAfter || 2 ** attempt * 1000 + Math.random() * 500);
        }
    }
};

const humanize = (name) => name
    .replace(/\.md$/, '')
    .replace(/^\d+[-_.]/, '')
    .replace(/[-_]/g, ' ')
    .replace(/^./, (character) => character.toUpperCase());

const frontmatter = (raw) => raw.match(/^---\n([\s\S]*?)\n---\n?/);

const field = (front, name) => front?.[1]
    .match(new RegExp(`^${name}:[^\\S\\n]*(.+)$`, 'm'))?.[1]
    .trim()
    .replace(/^["']|["']$/g, '');

const titleOf = (name, front, body) => field(front, 'title')
    || body.match(/^#\s+(.+)$/m)?.[1].trim()
    || humanize(name);

const entries = (directory) => readdirSync(directory, {withFileTypes: true})
    .filter((entry) => entry.isDirectory() || entry.name.endsWith('.md'))
    .map((entry) => ({name: entry.name, directory: entry.isDirectory(), path: join(directory, entry.name)}))
    .sort((a, b) => a.directory === b.directory
        ? a.name.localeCompare(b.name, 'en', {numeric: true})
        : (a.directory ? -1 : 1));

const createPage = (parent, title, markdown, async = false) => call(() => notion.pages.create({
    parent: {page_id: parent},
    properties: {title: {title: [{text: {content: title}}]}},
    ...(markdown === undefined ? {} : {markdown, allow_async: async}),
}));

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

// markdown and children are mutually exclusive on page creation, so the image can only be appended
const attachImage = async (page, directory, front, source) => {
    const declared = field(front, 'image');

    if (!declared) {
        if (/^image:[^\S\n]*$/m.test(front?.[1] ?? '')) {
            console.log(`::warning file=${source}::declare a single image, not a list`);
        }

        return;
    }

    const path = join(directory, declared);
    const type = IMAGE_TYPES[extname(path).toLowerCase()];

    if (!existsSync(path)) {
        console.log(`::warning file=${source}::image not found: ${declared}`);

        return;
    }

    if (!type) {
        console.log(`::warning file=${source}::unsupported image format: ${declared}`);

        return;
    }

    const filename = basename(path);
    const upload = await call(() => notion.fileUploads.create({mode: 'single_part', filename, content_type: type}));

    await call(() => notion.fileUploads.send({
        file_upload_id: upload.id,
        file: {filename, data: new Blob([readFileSync(path)], {type})},
    }));

    await call(() => notion.blocks.children.append({
        block_id: page,
        children: [{type: 'image', image: {type: 'file_upload', file_upload: {id: upload.id}}}],
    }));
};

const publish = async (parent, directory) => {
    for (const entry of entries(directory)) {
        if (entry.directory) {
            const container = await createPage(parent, humanize(entry.name));

            await publish(container.id, entry.path);

            continue;
        }

        const raw = readFileSync(entry.path, 'utf8');
        const front = frontmatter(raw);
        const body = front ? raw.slice(front[0].length) : raw;
        const large = statSync(entry.path).size > ASYNC_THRESHOLD;
        const response = await createPage(parent, titleOf(entry.name, front, body), toNotionMarkdown(body), large);

        if (response.truncated) {
            console.log(`::warning file=${entry.path}::content truncated by Notion`);
        }

        await attachImage(response.id, directory, front, entry.path);
    }
};

const root = await listChildren(NOTION_PARENT_PAGE_ID);
const existing = root.find((block) => block.type === 'child_page' && block.child_page.title === DOCS_NAME);

// the repo page outlives every run so the parent page keeps its ordering
const repo = existing ?? await createPage(NOTION_PARENT_PAGE_ID, DOCS_NAME);

for (const block of await listChildren(repo.id)) {
    await call(() => block.type === 'child_page'
        ? notion.pages.update({page_id: block.id, in_trash: true})
        : notion.blocks.delete({block_id: block.id}));
}

await publish(repo.id, DOCS_DIR);
