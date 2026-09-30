// Conversion between Markdown/plain text and Editor.js blocks.
// Everything that enters the editor from outside goes through sanitizeInline().
import { Marked } from 'marked';
import TurndownService from 'turndown';
import DOMPurify from 'dompurify';

export const MAX_HEADING = 4;

const INLINE_TAGS = ['b', 'i', 'u', 'a', 'code', 'mark', 'br'];

export function sanitizeInline(html) {
    return DOMPurify.sanitize(String(html ?? ''), {
        ALLOWED_TAGS: INLINE_TAGS,
        ALLOWED_ATTR: ['href'],
        ALLOW_DATA_ATTR: false,
    });
}

export function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------- import

const marked = new Marked({
    gfm: true,
    renderer: {
        // Editor.js stores bold/italic as <b>/<i>
        strong({ tokens }) { return `<b>${this.parser.parseInline(tokens)}</b>`; },
        em({ tokens }) { return `<i>${this.parser.parseInline(tokens)}</i>`; },
        image({ text }) { return escapeHtml(text || ''); },
        html({ text }) { return escapeHtml(text); },
    },
});

const inline = (text) => sanitizeInline(marked.parseInline(text).replace(/\n/g, ' ')).trim();

function listFromToken(token) {
    const isTask = token.items.some(i => i.task);
    const items = token.items.map(item => {
        const textTok = item.tokens.find(t => t.type === 'text' || t.type === 'paragraph');
        const nested = item.tokens.filter(t => t.type === 'list');
        return {
            content: inline(textTok ? textTok.text : item.text),
            meta: isTask ? { checked: !!item.checked } : {},
            items: nested.flatMap(n => listFromToken(n).data.items),
        };
    });
    return {
        type: 'list',
        data: { style: isTask ? 'checklist' : token.ordered ? 'ordered' : 'unordered', meta: {}, items },
    };
}

function quoteFromToken(token) {
    const texts = token.tokens
        .filter(t => t.type === 'paragraph' || t.type === 'text')
        .map(t => t.text.split('\n').map(l => l.trim()));
    let lines = texts.flat().filter(Boolean);
    let caption = '';
    if (lines.length > 1 && /^[—–-]{1,2}\s+\S/.test(lines[lines.length - 1])) {
        caption = inline(lines.pop().replace(/^[—–-]{1,2}\s+/, ''));
    }
    return { type: 'quote', data: { text: inline(lines.join(' ')), caption, alignment: 'left' } };
}

export function markdownToBlocks(markdown) {
    const blocks = [];
    for (const token of marked.lexer(markdown)) {
        switch (token.type) {
            case 'heading':
                blocks.push({ type: 'header', data: {
                    text: inline(token.text), level: Math.min(token.depth, MAX_HEADING) } });
                break;
            case 'paragraph':
                blocks.push({ type: 'paragraph', data: { text: inline(token.text) } });
                break;
            case 'list':
                blocks.push(listFromToken(token));
                break;
            case 'blockquote':
                blocks.push(quoteFromToken(token));
                break;
            case 'hr':
                blocks.push({ type: 'delimiter', data: {} });
                break;
            case 'code':
            case 'html':
            case 'table': {
                const raw = (token.type === 'code' ? token.text : token.raw).replace(/\s+$/, '');
                if (raw.trim()) {
                    const html = escapeHtml(raw).replace(/\n/g, '<br>');
                    blocks.push({ type: 'paragraph', data: {
                        text: token.type === 'code' ? `<code>${html}</code>` : html } });
                }
                break;
            }
            default: break; // space, def, etc.
        }
    }
    return blocks.length ? blocks : [{ type: 'paragraph', data: { text: '' } }];
}

// Plain text: paragraphs are blank-line separated; if the file has no blank
// lines at all, every line is treated as its own paragraph.
export function textToBlocks(text) {
    const norm = text.replace(/\r\n?/g, '\n').trim();
    if (!norm) return [{ type: 'paragraph', data: { text: '' } }];
    const chunks = /\n\s*\n/.test(norm) ? norm.split(/\n\s*\n/).map(c => c.replace(/\n/g, ' ')) : norm.split('\n');
    return chunks.map(c => c.trim()).filter(Boolean)
        .map(c => ({ type: 'paragraph', data: { text: escapeHtml(c) } }));
}

// Anything the editor should ever be handed: known block types only, sanitized
// text, and the older string-list format migrated to List v2 items.
export function normalizeBlocks(blocks) {
    const normItems = (items) => (items || []).map(it => typeof it === 'string'
        ? { content: sanitizeInline(it), meta: {}, items: [] }
        : { content: sanitizeInline(it.content), meta: it.meta || {}, items: normItems(it.items) });

    const out = [];
    for (const b of Array.isArray(blocks) ? blocks : []) {
        const d = (b && b.data) || {};
        switch (b && b.type) {
            case 'header':
                out.push({ type: 'header', data: { text: sanitizeInline(d.text),
                    level: Math.min(Math.max(parseInt(d.level, 10) || 2, 1), MAX_HEADING) } });
                break;
            case 'paragraph':
                out.push({ type: 'paragraph', data: { text: sanitizeInline(d.text) } });
                break;
            case 'quote':
                out.push({ type: 'quote', data: { text: sanitizeInline(d.text),
                    caption: sanitizeInline(d.caption), alignment: d.alignment === 'center' ? 'center' : 'left' } });
                break;
            case 'list': {
                const style = ['ordered', 'checklist'].includes(d.style) ? d.style : 'unordered';
                out.push({ type: 'list', data: { style, meta: {}, items: normItems(d.items) } });
                break;
            }
            case 'delimiter':
                out.push({ type: 'delimiter', data: {} });
                break;
            default:
                if (d.text) out.push({ type: 'paragraph', data: { text: sanitizeInline(d.text) } });
        }
    }
    return out.length ? out : [{ type: 'paragraph', data: { text: '' } }];
}

export function parseDocument(content, fileName = '') {
    const trimmed = content.trim();
    if (trimmed.startsWith('{')) {
        try {
            const json = JSON.parse(trimmed);
            if (json && Array.isArray(json.blocks)) return normalizeBlocks(json.blocks);
        } catch { /* not JSON, fall through */ }
    }
    return /\.txt$/i.test(fileName) ? textToBlocks(content) : markdownToBlocks(content);
}

// ---------------------------------------------------------------- export

const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
    codeBlockStyle: 'fenced',
    br: '  \n',
});
turndown.keep(['u', 'mark']); // Markdown has no underline; inline HTML is valid Markdown

const md = (html) => turndown.turndown(html || '').replace(/ /g, ' ').trim();

function listToMarkdown(items, style, depth = 0) {
    const pad = '    '.repeat(depth);
    return items.map((item, i) => {
        let marker = style === 'ordered' ? `${i + 1}.` : '-';
        if (style === 'checklist') marker = `- [${item.meta && item.meta.checked ? 'x' : ' '}]`;
        const line = `${pad}${marker} ${md(item.content)}`;
        const nested = item.items && item.items.length ? '\n' + listToMarkdown(item.items, style, depth + 1) : '';
        return line + nested;
    }).join('\n');
}

export function blocksToMarkdown(blocks) {
    const parts = [];
    for (const block of blocks) {
        const d = block.data || {};
        switch (block.type) {
            case 'header':
                parts.push('#'.repeat(Math.min(Math.max(d.level || 2, 1), 6)) + ' ' + md(d.text));
                break;
            case 'paragraph':
                parts.push(md(d.text));
                break;
            case 'list':
                parts.push(listToMarkdown(d.items || [], d.style));
                break;
            case 'quote': {
                const lines = md(d.text).split('\n');
                if (d.caption) lines.push('— ' + md(d.caption));
                parts.push(lines.map(l => '> ' + l).join('\n'));
                break;
            }
            case 'delimiter':
                parts.push('---');
                break;
            default:
                if (d.text) parts.push(md(d.text));
        }
    }
    return parts.filter(p => p !== '').join('\n\n') + '\n';
}

export function htmlToText(html) {
    return String(html ?? '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function blocksToText(blocks) {
    const listText = (items, depth = 0) => items.map(i =>
        '  '.repeat(depth) + '- ' + htmlToText(i.content) + (i.items && i.items.length ? '\n' + listText(i.items, depth + 1) : '')
    ).join('\n');
    return blocks.map(b => {
        const d = b.data || {};
        if (b.type === 'list') return listText(d.items || []);
        if (b.type === 'delimiter') return '* * *';
        return htmlToText(d.text);
    }).filter(Boolean).join('\n\n') + '\n';
}

// ---------------------------------------------------------------- counting

export function countWords(blocks) {
    const words = (html) => htmlToText(html).split(/\s+/).filter(Boolean).length;
    const listWords = (items) => (items || []).reduce((n, i) =>
        n + words(typeof i === 'string' ? i : i.content) + (typeof i === 'string' ? 0 : listWords(i.items)), 0);
    return blocks.reduce((n, b) => {
        const d = b.data || {};
        if (b.type === 'list') return n + listWords(d.items);
        return n + words(d.text);
    }, 0);
}
