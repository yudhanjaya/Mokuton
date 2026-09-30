import EditorJS from '@editorjs/editorjs';
import Header from '@editorjs/header';
import List from '@editorjs/list';
import Quote from '@editorjs/quote';
import Delimiter from '@editorjs/delimiter';
import Underline from '@editorjs/underline';
import './style.css';

import { createFs, isTextFile } from './files.js';
import {
    MAX_HEADING, parseDocument, normalizeBlocks, blocksToMarkdown, blocksToText, countWords,
} from './markdown.js';
import { applyWordCount, resetBaseline, freshState, streak } from './goals.js';

const $ = (id) => document.getElementById(id);
const fs = createFs();

// ------------------------------------------------------------------ storage
// localStorage can throw (private mode, quota) - never let that break writing.
const store = {
    get(key, fallback = null) {
        try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem(key, value); return true; } catch { return false; }
    },
    getJson(key, fallback = null) {
        try { return JSON.parse(store.get(key)) ?? fallback; } catch { return fallback; }
    },
};

// -------------------------------------------------------------------- state
const EMPTY = [{ type: 'paragraph', data: { text: '' } }];
let editor;
let fileName = store.get('mokuton-file', 'Untitled');
let fileRef = null;               // where "Save" writes back to (null = Save As)
let dirty = store.get('mokuton-dirty') === '1';
let goal = parseInt(store.get('wordCountGoal'), 10) || 1000;
let daily = store.getJson('mokuton-daily');
let lastSerialized = '';          // last document state we already handled
let wordTotal = 0;
let storageWarning = false;
let autosaveToFile = store.get('mokuton-autosave') === '1';
let diskTimer = null;

// ---------------------------------------------------------------- utilities
function debounce(fn, ms) {
    let t;
    const wrapped = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    wrapped.cancel = () => clearTimeout(t);
    return wrapped;
}

const serialize = (blocks) => JSON.stringify(blocks);

function exportContent(blocks) {
    return /\.txt$/i.test(fileName) ? blocksToText(blocks) : blocksToMarkdown(blocks);
}

// --------------------------------------------------------------- progress UI
const BOX_COUNT = 200;
function initProgressMeter() {
    const meter = $('progress-meter');
    const frag = document.createDocumentFragment();
    for (let i = 0; i < BOX_COUNT; i++) {
        const box = document.createElement('div');
        box.className = 'progress-box';
        frag.appendChild(box);
    }
    meter.replaceChildren(frag);
}

function renderGoalUi() {
    const written = daily ? daily.written : 0;
    const filled = Math.min(Math.floor((written / goal) * BOX_COUNT), BOX_COUNT);
    const boxes = $('progress-meter').children;
    for (let i = 0; i < boxes.length; i++) boxes[i].classList.toggle('filled', i < filled);
    $('progress-meter').setAttribute('aria-valuenow', String(Math.min(100, Math.round((written / goal) * 100))));
    $('word-count').textContent = `${written} today`;
    $('goal-count').textContent = `Goal: ${goal}`;
    const n = daily ? streak(daily.history) : 0;
    $('streak').textContent = n > 0 ? `🔥 ${n} day${n === 1 ? '' : 's'}` : '';
}

function renderFileInfo() {
    const pages = Math.ceil(wordTotal / 250);
    let text = `${fileName}${dirty ? ' •' : ''} | Words: ${wordTotal} | Pages: ${pages}`;
    if (storageWarning) text += ' | ⚠ Browser storage is full - save to a file!';
    $('file-info').textContent = text;
    document.title = `${dirty ? '• ' : ''}${fileName} - Mokuton`;
}

// --------------------------------------------------------------- persistence
function persistDraft(blocks) {
    const ok = store.set('editorjsData', JSON.stringify({ time: Date.now(), blocks }));
    storageWarning = !ok;
    store.set('mokuton-file', fileName);
    store.set('mokuton-dirty', dirty ? '1' : '0');
    store.set('mokuton-daily', JSON.stringify(daily));
}

// Fold the editor's current content into counts, the draft and the UI.
// Returns false when nothing changed.
async function handleChange() {
    const { blocks } = await editor.save();
    const ser = serialize(blocks);
    if (ser === lastSerialized) return false;
    lastSerialized = ser;
    wordTotal = countWords(blocks);
    daily = applyWordCount(daily, wordTotal, goal);
    dirty = true;
    persistDraft(blocks);
    renderGoalUi();
    renderFileInfo();
    scheduleDiskSave();
    return true;
}
const onEditorChange = debounce(() => { handleChange().catch(console.error); }, 300);

function scheduleDiskSave() {
    if (!autosaveToFile || !fileRef) return;
    clearTimeout(diskTimer);
    diskTimer = setTimeout(async () => {
        try {
            const { blocks } = await editor.save();
            const r = await fs.saveFile(fileRef, exportContent(blocks), fileName, { silent: true });
            if (r) { dirty = false; store.set('mokuton-dirty', '0'); renderFileInfo(); }
        } catch (e) { console.error('Autosave to file failed', e); }
    }, 2000);
}

// Replace the document without counting it as writing.
async function loadBlocks(blocks, name, ref) {
    onEditorChange.cancel();
    clearTimeout(diskTimer);
    await editor.render({ blocks });
    const saved = await editor.save();
    fileName = name;
    fileRef = ref;
    lastSerialized = serialize(saved.blocks);
    wordTotal = countWords(saved.blocks);
    daily = resetBaseline(daily, wordTotal);
    dirty = false;
    persistDraft(saved.blocks);
    renderGoalUi();
    renderFileInfo();
    highlightActiveFile();
}

function confirmDiscard() {
    return !dirty || window.confirm(`"${fileName}" has changes that aren't saved to a file. Discard them?`);
}

// ------------------------------------------------------------- file actions
async function openFile() {
    if (!confirmDiscard()) return;
    try {
        const r = await fs.openFile();
        if (r) await loadBlocks(parseDocument(r.content, r.name), r.name, r.ref);
    } catch (e) { reportError('open', e); }
}

async function saveFile({ saveAs = false } = {}) {
    try {
        onEditorChange.cancel();
        await handleChange();
        const { blocks } = await editor.save();
        const r = await fs.saveFile(saveAs ? null : fileRef, exportContent(blocks), fileName);
        if (!r) return;
        fileName = r.name;
        fileRef = r.ref;
        dirty = false;
        persistDraft(blocks);
        renderFileInfo();
        if (dirStack.length) refreshExplorer();
    } catch (e) { reportError('save', e); }
}

async function newDocument() {
    if (!confirmDiscard()) return;
    await loadBlocks(EMPTY, 'Untitled', null);
}

function reportError(action, e) {
    console.error(`Could not ${action} file`, e);
    window.alert(`Could not ${action} the file: ${e && e.message ? e.message : e}`);
}

// ------------------------------------------------------------ file explorer
let dirStack = []; // [{ref, name}], last = currently shown
const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

async function pickDirectory() {
    if (!fs.canPickDirectory) {
        window.alert("Your browser can't open folders (try Chrome/Edge, or the desktop app). Use the Open button for single files.");
        return;
    }
    try {
        const dir = await fs.pickDirectory();
        if (!dir) return;
        dirStack = [dir];
        await refreshExplorer();
    } catch (e) { console.error(e); }
}

async function refreshExplorer() {
    const dir = dirStack[dirStack.length - 1];
    const list = $('file-explorer');
    if (!dir) { list.replaceChildren(); return; }
    $('left-sidebar').querySelector('h2').textContent = dir.name;
    $('back-button').disabled = dirStack.length <= 1;

    let entries;
    try { entries = await fs.listDir(dir); } catch (e) { console.error(e); return; }
    entries = entries
        .filter(e => !e.name.startsWith('.') && (e.kind === 'directory' || isTextFile(e.name)))
        .sort((a, b) => (a.kind === b.kind ? naturalCompare(a.name, b.name) : a.kind === 'directory' ? -1 : 1));

    const frag = document.createDocumentFragment();
    for (const entry of entries) {
        const li = document.createElement('li');
        li.tabIndex = 0;
        li.setAttribute('role', 'button');
        li.dataset.name = entry.name;
        li.textContent = entry.kind === 'directory' ? `📁 ${entry.name}` : entry.name;
        const activate = entry.kind === 'directory'
            ? async () => { dirStack.push({ ref: entry.ref, name: entry.name }); await refreshExplorer(); }
            : async () => {
                if (!confirmDiscard()) return;
                try {
                    const r = await fs.readFile(entry.ref);
                    await loadBlocks(parseDocument(r.content, r.name), r.name, entry.ref);
                } catch (e) { reportError('open', e); }
            };
        li.addEventListener('click', activate);
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
        frag.appendChild(li);
    }
    list.replaceChildren(frag);
    highlightActiveFile();
}

function highlightActiveFile() {
    for (const li of $('file-explorer').children) li.classList.toggle('active', li.dataset.name === fileName);
}

async function navigateBack() {
    if (dirStack.length > 1) { dirStack.pop(); await refreshExplorer(); }
}

// ------------------------------------------------------------------ toolbar
function currentBlock() {
    const i = editor.blocks.getCurrentBlockIndex();
    return i < 0 ? null : editor.blocks.getBlockByIndex(i);
}

async function setBlockStyle({ type, level, style }) {
    const block = currentBlock();
    if (!block) { editor.blocks.insert(type, defaultData(type, level, style)); return; }
    try {
        if (block.name === type && (type === 'header' || type === 'list')) {
            const { data } = await block.save();
            editor.blocks.update(block.id, { ...data, ...(type === 'header' ? { level } : { style }) });
        } else if (block.name !== type) {
            await editor.blocks.convert(block.id, type, defaultData(type, level, style));
        }
    } catch (e) { console.warn('Could not change block style', e); }
    setTimeout(refreshStyleLabel, 80); // wait for Editor.js to swap the block's DOM
}

function defaultData(type, level, style) {
    if (type === 'header') return { level: level || 2 };
    if (type === 'list') return { style: style || 'unordered' };
    return {};
}

async function toggleBullets() {
    const block = currentBlock();
    if (block && block.name === 'list') {
        await setBlockStyle({ type: 'paragraph' });
    } else {
        await setBlockStyle({ type: 'list', style: 'unordered' });
    }
}

const STYLE_LABELS = { paragraph: 'Paragraph', quote: 'Quote', list: 'List', delimiter: 'Divider' };
function refreshStyleLabel() {
    if (!editor || !editor.blocks) return;
    const block = currentBlock();
    let label = 'Paragraph';
    if (block) {
        label = STYLE_LABELS[block.name] || 'Paragraph';
        if (block.name === 'header') {
            const h = block.holder.querySelector('h1,h2,h3,h4,h5,h6');
            label = h ? `Heading ${h.tagName[1]}` : 'Heading';
        }
    }
    $('style-button').firstChild.textContent = `${label} `;
}

function toggleCase() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const text = sel.getRangeAt(0).toString();
    if (!text) return;
    let out;
    if (text === text.toUpperCase() && text !== text.toLowerCase()) out = text.toLowerCase();
    else if (text === text.toLowerCase()) out = text.replace(/(^|[\s"'(\[—–-])(\p{L})/gu, (_, p, c) => p + c.toUpperCase());
    else out = text.toUpperCase();
    document.execCommand('insertText', false, out);
}

function toggleStyleMenu(force) {
    const open = force ?? !$('style-dropdown').classList.contains('open');
    $('style-dropdown').classList.toggle('open', open);
    $('style-button').setAttribute('aria-expanded', String(open));
}

// ------------------------------------------------------------- theme & view
const themeIcon = $('theme-toggle').querySelector('i');
function setTheme(theme) {
    document.body.classList.toggle('dark-mode', theme === 'dark');
    themeIcon.classList.toggle('fa-sun', theme === 'dark');
    themeIcon.classList.toggle('fa-moon', theme !== 'dark');
    store.set('mokuton-theme', theme);
}

function setPanel(side, collapsed) {
    document.body.classList.toggle(`${side}-collapsed`, collapsed);
    store.set('mokuton-ui', JSON.stringify({
        left: document.body.classList.contains('left-collapsed'),
        right: document.body.classList.contains('right-collapsed'),
    }));
}

function toggleFocusMode(force) {
    const on = force ?? !document.body.classList.contains('focus-mode');
    document.body.classList.toggle('focus-mode', on);
    $('focus-button').querySelector('i').classList.toggle('fa-expand', !on);
    $('focus-button').querySelector('i').classList.toggle('fa-compress', on);
}

function toggleHelp(force) {
    const help = $('help-menu');
    help.hidden = force === undefined ? !help.hidden : !force;
    if (!help.hidden) $('close-help').focus();
}

function setAutosave(on) {
    autosaveToFile = on;
    store.set('mokuton-autosave', on ? '1' : '0');
    const btn = $('autosave-button');
    btn.setAttribute('aria-pressed', String(on));
    btn.style.opacity = on ? '1' : '0.5';
    btn.title = `Autosave to file: ${on ? 'on' : 'off'}`;
    if (on) scheduleDiskSave();
}

// --------------------------------------------------------------------- init
function initialBlocks() {
    const saved = store.getJson('editorjsData');
    if (saved && Array.isArray(saved.blocks) && saved.blocks.length) return normalizeBlocks(saved.blocks);
    return [{ type: 'paragraph', data: { text: 'Start writing here...' } }];
}

async function init() {
    initProgressMeter();

    const savedTheme = store.get('mokuton-theme')
        || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    setTheme(savedTheme);

    const ui = store.getJson('mokuton-ui', {});
    if (ui.left) document.body.classList.add('left-collapsed');
    if (ui.right) document.body.classList.add('right-collapsed');

    $('goal-input').value = goal;

    setAutosave(autosaveToFile);

    const blocks = initialBlocks();
    editor = new EditorJS({
        holder: 'editorjs',
        autofocus: true,
        placeholder: 'Tell your story...',
        tools: {
            header: { class: Header, inlineToolbar: true, config: {
                levels: Array.from({ length: MAX_HEADING }, (_, i) => i + 1), defaultLevel: 2 } },
            list: { class: List, inlineToolbar: true },
            quote: { class: Quote, inlineToolbar: true },
            delimiter: Delimiter,
            underline: Underline,
        },
        inlineToolbar: ['bold', 'italic', 'underline', 'link'],
        data: { blocks },
        onChange: onEditorChange,
    });
    await editor.isReady;

    const saved = await editor.save();
    lastSerialized = serialize(saved.blocks);
    wordTotal = countWords(saved.blocks);
    daily = daily && daily.date ? daily : freshState(wordTotal);
    daily = applyWordCount(daily, wordTotal, goal); // also rolls over to a new day
    persistDraft(saved.blocks);
    renderGoalUi();
    renderFileInfo();
    refreshStyleLabel();
}

// ------------------------------------------------------------------ wiring
// Keep the editor selection when toolbar buttons are pressed.
$('toolbar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });

$('bold-button').addEventListener('click', () => document.execCommand('bold'));
$('italic-button').addEventListener('click', () => document.execCommand('italic'));
$('underline-button').addEventListener('click', () => document.execCommand('underline'));
$('case-button').addEventListener('click', toggleCase);
$('bullet-button').addEventListener('click', toggleBullets);
$('new-button').addEventListener('click', newDocument);
$('load-button').addEventListener('click', openFile);
$('save-button').addEventListener('click', () => saveFile());
$('focus-button').addEventListener('click', () => toggleFocusMode());
$('help-button').addEventListener('click', () => toggleHelp());
$('close-help').addEventListener('click', () => toggleHelp(false));
$('select-directory').addEventListener('click', pickDirectory);
$('back-button').addEventListener('click', navigateBack);
$('left-toggle').addEventListener('click', () => setPanel('left', !document.body.classList.contains('left-collapsed')));
$('right-toggle').addEventListener('click', () => setPanel('right', !document.body.classList.contains('right-collapsed')));
$('theme-toggle').addEventListener('click', () => setTheme(document.body.classList.contains('dark-mode') ? 'light' : 'dark'));
document.addEventListener('click', (e) => { if (!e.target.closest('.style-select-wrapper')) toggleStyleMenu(false); });
$('autosave-button').addEventListener('click', () => setAutosave(!autosaveToFile));

$('clear-button').addEventListener('click', async () => {
    if (!window.confirm('Clear the entire page? This cannot be undone.')) return;
    editor.clear();
    await handleChange();
});

$('style-button').addEventListener('click', () => toggleStyleMenu());
$('style-dropdown').addEventListener('click', (e) => {
    const item = e.target.closest('button[data-type]');
    if (!item) return;
    toggleStyleMenu(false);
    setBlockStyle({ type: item.dataset.type, level: parseInt(item.dataset.level, 10) || undefined, style: item.dataset.style });
});

$('goal-input').addEventListener('change', () => {
    const v = parseInt($('goal-input').value, 10);
    if (v >= 1) { goal = v; store.set('wordCountGoal', String(v)); }
    $('goal-input').value = goal;
    if (daily) daily = applyWordCount(daily, daily.last, goal); // refresh today's stored goal
    persistDraftFromState();
    renderGoalUi();
});

async function persistDraftFromState() {
    if (editor) persistDraft((await editor.save()).blocks);
}

document.addEventListener('selectionchange', () => { if (editor && editor.blocks) refreshStyleLabel(); });

// Bold/italic/underline shortcuts are handled by Editor.js itself.
document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
        if (!$('help-menu').hidden) toggleHelp(false);
        else if ($('style-dropdown').classList.contains('open')) toggleStyleMenu(false);
        else if (document.body.classList.contains('focus-mode')) toggleFocusMode(false);
        return;
    }
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (e.altKey && !e.shiftKey) {
        const map = { Digit0: { type: 'paragraph' }, Digit1: { type: 'header', level: 1 }, Digit2: { type: 'header', level: 2 }, Digit3: { type: 'header', level: 3 } };
        if (map[e.code]) { e.preventDefault(); setBlockStyle(map[e.code]); }
    } else if (e.shiftKey && !e.altKey) {
        if (key === 'x') { e.preventDefault(); toggleCase(); }
        else if (key === 'l') { e.preventDefault(); toggleBullets(); }
        else if (key === 'f') { e.preventDefault(); toggleFocusMode(); }
        else if (key === 's') { e.preventDefault(); saveFile({ saveAs: true }); }
    } else if (!e.altKey && !e.shiftKey) {
        if (key === 'o') { e.preventDefault(); openFile(); }
        else if (key === 's') { e.preventDefault(); saveFile(); }
        else if (key === 'n') { e.preventDefault(); newDocument(); }
        else if (key === 'm') { e.preventDefault(); $('theme-toggle').click(); }
        else if (key === '/') { e.preventDefault(); toggleHelp(); }
    }
});

window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

init().catch((err) => {
    console.error('Mokuton failed to start', err);
    $('editorjs').textContent = `The editor failed to start: ${err.message}`;
});
