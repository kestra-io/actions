import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {Client} from '@notionhq/client';
import {tablesToHtml} from './tables.mjs';

const {NOTION_TOKEN, NOTION_PARENT_PAGE_ID, DOCS_DIR, DOCS_NAME} = process.env;

const ASYNC_THRESHOLD = 100 * 1024;

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

const titleOf = (name, body) => {
    const frontmatter = body.match(/^---\n([\s\S]*?)\n---/);
    const declared = frontmatter?.[1].match(/^title:\s*(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, '');

    return declared || body.match(/^#\s+(.+)$/m)?.[1].trim() || humanize(name);
};

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

const publish = async (parent, directory) => {
    for (const entry of entries(directory)) {
        if (entry.directory) {
            const container = await createPage(parent, humanize(entry.name));

            await publish(container.id, entry.path);

            continue;
        }

        const body = readFileSync(entry.path, 'utf8');
        const large = statSync(entry.path).size > ASYNC_THRESHOLD;
        const response = await createPage(parent, titleOf(entry.name, body), tablesToHtml(body), large);

        if (response.truncated) {
            console.log(`::warning file=${entry.path}::content truncated by Notion`);
        }
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
