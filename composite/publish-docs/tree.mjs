import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

export const humanize = (name) => name
    .replace(/\.md$/, '')
    .replace(/^\d+[-_.]/, '')
    .replace(/[-_]/g, ' ')
    .replace(/^./, (character) => character.toUpperCase());

export const frontmatter = (raw) => raw.match(/^---\n([\s\S]*?)\n---\n?/);

export const field = (front, name) => front?.[1]
    .match(new RegExp(`^${name}:[^\\S\\n]*(.+)$`, 'm'))?.[1]
    .trim()
    .replace(/^["']|["']$/g, '');

export const parse = (path) => {
    const raw = readFileSync(path, 'utf8');
    const front = frontmatter(raw);

    return {front, body: front ? raw.slice(front[0].length) : raw};
};

const titleOf = (name, front, body) => field(front, 'title')
    || body.match(/^#\s+(.+)$/m)?.[1].trim()
    || humanize(name);

const isIndex = (name) => name.toLowerCase() === 'index.md';

const entries = (directory) => readdirSync(directory, {withFileTypes: true})
    .filter((entry) => entry.isDirectory() || entry.name.endsWith('.md'))
    .sort((a, b) => a.isDirectory() === b.isDirectory()
        ? a.name.localeCompare(b.name, 'en', {numeric: true})
        : (a.isDirectory() ? -1 : 1));

// a folder is the page of its index.md, every other markdown file and subfolder is a subpage
export const buildTree = (directory, name = null, folder = '') => {
    const children = [];
    let index = null;

    for (const entry of entries(directory)) {
        const path = join(directory, entry.name);
        const relative = folder ? `${folder}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
            children.push(buildTree(path, null, relative));
        } else if (isIndex(entry.name)) {
            index = {path, relative};
        } else {
            const {front, body} = parse(path);

            children.push({title: titleOf(entry.name, front, body), file: {path, relative}, children: []});
        }
    }

    const container = {file: index, children};

    if (name) {
        return {...container, title: name};
    }

    if (index) {
        const {front, body} = parse(index.path);

        return {...container, title: titleOf(folder.split('/').pop() || 'index.md', front, body)};
    }

    return {...container, title: humanize(folder.split('/').pop())};
};
