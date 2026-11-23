import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({html: true});

// Notion ignores fit-page-width, only explicit column widths stretch a table to the page
const PAGE_WIDTH = 700;

const columnWidths = (lengths) => {
    const weights = lengths.map((length) => Math.min(Math.max(length, 8), 80));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const widths = weights.map((weight) => Math.round(PAGE_WIDTH * weight / total));

    widths[widths.length - 1] += PAGE_WIDTH - widths.reduce((sum, width) => sum + width, 0);

    return widths;
};

const renderRows = (tokens, from, to) => {
    const rows = [];
    const lengths = [];
    let cells = null;

    for (let i = from; i <= to; i++) {
        const token = tokens[i];

        if (token.type === 'tr_open') {
            cells = [];
        } else if (token.type === 'tr_close') {
            rows.push(`<tr>${cells.join('')}</tr>`);
            cells = null;
        } else if (token.type === 'inline' && cells) {
            lengths[cells.length] = Math.max(lengths[cells.length] ?? 0, token.content.length);
            cells.push(`<td>${token.content}</td>`);
        }
    }

    return {rows, widths: columnWidths(lengths)};
};

// Notion's markdown flavor takes HTML tables, not GFM pipes
const tablesToHtml = (markdown) => {
    const tokens = md.parse(markdown, {});
    const tables = [];

    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].type !== 'table_open') {
            continue;
        }

        const close = tokens.findIndex((token, index) => index > i && token.type === 'table_close');
        const header = tokens.slice(i, close).some((token) => token.type === 'thead_open');

        const {rows, widths} = renderRows(tokens, i, close);
        const colgroup = ['<colgroup>', ...widths.map((width) => `<col width="${width}" />`), '</colgroup>'].join('\n');

        tables.push({
            from: tokens[i].map[0],
            to: tokens[i].map[1],
            html: [`<table fit-page-width="true" header-row="${header}">`, colgroup, ...rows, '</table>'].join('\n'),
        });

        i = close;
    }

    if (tables.length === 0) {
        return markdown;
    }

    const lines = markdown.split('\n');
    const out = [];
    let cursor = 0;

    for (const table of tables) {
        out.push(...lines.slice(cursor, table.from), table.html);
        cursor = table.to;
    }

    out.push(...lines.slice(cursor));

    return out.join('\n');
};

// Notion guesses javascript on an unlabelled fence, which mangles ASCII diagrams
const defaultFenceLanguage = (markdown) => {
    const bare = md.parse(markdown, {}).filter((token) => token.type === 'fence' && token.info.trim() === '');

    if (bare.length === 0) {
        return markdown;
    }

    const lines = markdown.split('\n');

    for (const token of bare) {
        lines[token.map[0]] = `${lines[token.map[0]].trimEnd()}text`;
    }

    return lines.join('\n');
};

// Notion turns every single newline into a new block, so a paragraph wrapped in the source gets cut into pieces
const unwrapParagraphs = (markdown) => {
    const tokens = md.parse(markdown, {});
    const lines = markdown.split('\n');
    const ranges = [];

    tokens.forEach((token, index) => {
        if (token.type === 'inline' && tokens[index - 1]?.type === 'paragraph_open' && token.map[1] - token.map[0] > 1) {
            ranges.push(token.map);
        }
    });

    for (const [from, to] of ranges.reverse()) {
        const joined = [];

        for (let i = from; i < to; i++) {
            const line = i === from ? lines[i] : lines[i].replace(/^[\s>]+/, '');
            const hardBreak = / {2,}$|\\$/.test(lines[i]);

            if (joined.length > 0 && !joined[joined.length - 1].hardBreak) {
                joined[joined.length - 1].text += ` ${line.trimEnd()}`;
                joined[joined.length - 1].hardBreak = hardBreak;
            } else {
                joined.push({text: i === from ? line : lines[i], hardBreak});
            }
        }

        lines.splice(from, to - from, ...joined.map((entry) => entry.text));
    }

    return lines.join('\n');
};

export const toNotionMarkdown = (markdown) => tablesToHtml(defaultFenceLanguage(unwrapParagraphs(markdown)));

const FENCE = /^\s*(```|~~~)/;
const IMAGE = /(?<!\[)!\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g;
const LINK = /(?<!!)(\[[^\]]*\])\(<?([^)\s>]+)>?((?:\s+"[^"]*")?)\)/g;

const external = (target) => /^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target);

// outside code fences only, where a markdown example must stay untouched
const mapOutsideFences = (markdown, transform) => {
    let fenced = false;

    return markdown.split('\n').map((line) => {
        if (FENCE.test(line)) {
            fenced = !fenced;

            return line;
        }

        return fenced ? line : transform(line);
    }).join('\n');
};

// relative links would 404 on Notion, so they point to the file on GitHub instead
export const rewriteLinks = (markdown, resolve) => mapOutsideFences(markdown, (line) => line.replace(
    LINK,
    (match, label, target, title) => external(target) ? match : `${label}(${resolve(target)}${title})`,
));

// Notion can only attach an uploaded file as a block, so the text is cut around each local image
export const splitImages = (markdown) => {
    const segments = [];
    let text = [];
    let fenced = false;

    const flush = () => {
        const content = text.join('\n').trim();

        if (content) {
            segments.push({type: 'text', content});
        }

        text = [];
    };

    for (const line of markdown.split('\n')) {
        if (FENCE.test(line)) {
            fenced = !fenced;
        }

        if (fenced || FENCE.test(line)) {
            text.push(line);

            continue;
        }

        let cursor = 0;

        for (const match of line.matchAll(IMAGE)) {
            if (external(match[2])) {
                continue;
            }

            text.push(line.slice(cursor, match.index));
            flush();
            segments.push({type: 'image', alt: match[1], src: match[2]});
            cursor = match.index + match[0].length;
        }

        text.push(line.slice(cursor));
    }

    flush();

    return segments;
};
