import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({html: true});

const renderRows = (tokens, from, to) => {
    const rows = [];
    let cells = null;

    for (let i = from; i <= to; i++) {
        const token = tokens[i];

        if (token.type === 'tr_open') {
            cells = [];
        } else if (token.type === 'tr_close') {
            rows.push(`<tr>${cells.join('')}</tr>`);
            cells = null;
        } else if (token.type === 'inline' && cells) {
            cells.push(`<td>${md.renderer.renderInline(token.children, md.options, {})}</td>`);
        }
    }

    return rows;
};

// Notion's markdown flavor takes HTML tables, not GFM pipes
export const tablesToHtml = (markdown) => {
    const tokens = md.parse(markdown, {});
    const tables = [];

    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].type !== 'table_open') {
            continue;
        }

        const close = tokens.findIndex((token, index) => index > i && token.type === 'table_close');
        const header = tokens.slice(i, close).some((token) => token.type === 'thead_open');

        tables.push({
            from: tokens[i].map[0],
            to: tokens[i].map[1],
            html: [`<table header-row="${header}">`, ...renderRows(tokens, i, close), '</table>'].join('\n'),
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
