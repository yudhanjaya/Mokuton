import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.Node = dom.window.Node;

const md = await import('../src/markdown.js');

test('imports headings, paragraphs, inline formatting', () => {
    const blocks = md.markdownToBlocks('# Title\n\nSome **bold** and *italic* text.\n');
    assert.deepEqual(blocks[0], { type: 'header', data: { text: 'Title', level: 1 } });
    assert.equal(blocks[1].data.text, 'Some <b>bold</b> and <i>italic</i> text.');
});

test('hard-wrapped lines join into one paragraph', () => {
    const blocks = md.markdownToBlocks('one line\nsecond line\n\nnext para');
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].data.text, 'one line second line');
});

test('snake_case is not italicised', () => {
    assert.equal(md.markdownToBlocks('use snake_case_names here')[0].data.text, 'use snake_case_names here');
});

test('imports nested and ordered lists, checklists, quotes and rules', () => {
    const blocks = md.markdownToBlocks('- a\n    - b\n- c\n\n1. x\n2. y\n\n- [x] done\n- [ ] todo\n\n> wise words\n> — someone\n\n---\n');
    assert.equal(blocks[0].data.items[0].items[0].content, 'b');
    assert.equal(blocks[1].data.style, 'ordered');
    assert.equal(blocks[2].data.style, 'checklist');
    assert.equal(blocks[2].data.items[0].meta.checked, true);
    assert.equal(blocks[3].type, 'quote');
    assert.equal(blocks[3].data.caption, 'someone');
    assert.equal(blocks[4].type, 'delimiter');
});

test('scripts and event handlers in imported files are neutralised', () => {
    const live = (html) => {
        const el = document.createElement('div');
        el.innerHTML = html;
        return el;
    };
    const evil = 'hi <img src=x onerror="alert(1)"> [x](javascript:alert(1)) <script>alert(2)</script>';
    const el = live(md.markdownToBlocks(evil).map(b => b.data.text).join(''));
    assert.equal(el.querySelectorAll('img,script').length, 0);
    assert.equal(el.querySelectorAll('[onerror],[href^="javascript"]').length, 0);
    const cleaned = md.normalizeBlocks([{ type: 'paragraph', data: { text: '<svg onload=alert(1)><b onclick=x>b</b> <span onmouseover=y>c</span>' } }]);
    const el2 = live(cleaned[0].data.text);
    assert.equal(el2.querySelectorAll('svg,[onload],[onclick]').length, 0);
    assert.equal(el2.textContent, 'b c');
});

test('old string-item lists are migrated to List v2 items', () => {
    const out = md.normalizeBlocks([{ type: 'list', data: { style: 'unordered', items: ['a', 'b'] } }]);
    assert.deepEqual(out[0].data.items[0], { content: 'a', meta: {}, items: [] });
});

test('unknown blocks (e.g. old image blocks) do not crash normalisation', () => {
    const out = md.normalizeBlocks([{ type: 'image', data: { url: 'x' } }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'paragraph');
});

test('markdown round-trips', () => {
    const src = '# Title\n\nSome **bold** and *italic* text.\n\n- one\n    - nested\n- two\n\n1. first\n2. second\n\n> quote\n> — author\n\n---\n\nEnd.\n';
    const out = md.blocksToMarkdown(md.markdownToBlocks(src));
    assert.equal(out, src);
});

test('export keeps underline, links and ordinal numbering', () => {
    const out = md.blocksToMarkdown([
        { type: 'paragraph', data: { text: 'a <u>under</u> <a href="https://x.y">link</a> &amp; 1&nbsp;2' } },
        { type: 'list', data: { style: 'ordered', items: [
            { content: 'a', meta: {}, items: [] }, { content: 'b', meta: {}, items: [] }] } },
    ]);
    assert.match(out, /<u>under<\/u> \[link\]\(https:\/\/x\.y\) & 1 2/);
    assert.match(out, /1\. a\n2\. b/);
});

test('plain text import/export', () => {
    assert.equal(md.textToBlocks('a\nb\nc').length, 3);
    assert.equal(md.textToBlocks('a\nb\n\nc').length, 2);
    assert.equal(md.textToBlocks('1 < 2 & 3')[0].data.text, '1 &lt; 2 &amp; 3');
    assert.equal(md.blocksToText(md.textToBlocks('1 < 2')), '1 < 2\n');
});

test('word counting ignores markup and includes lists', () => {
    const blocks = [
        { type: 'paragraph', data: { text: 'one <b>two</b>&nbsp;three' } },
        { type: 'list', data: { items: [{ content: 'four five', items: [{ content: 'six', items: [] }] }] } },
    ];
    assert.equal(md.countWords(blocks), 6);
});
