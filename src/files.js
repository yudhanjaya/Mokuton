// File access for the browser: the File System Access API where available
// (Chromium), falling back to <input>/download elsewhere.
//
// A "ref" is opaque to the app: {handle}, or null when there is nothing to save back into.

const TEXT_FILE = /\.(md|markdown|txt)$/i;
export const isTextFile = (name) => TEXT_FILE.test(name);

export const withExtension = (name) => (isTextFile(name) ? name : `${name || 'Untitled'}.md`);

function webFs() {
    const canPickDir = typeof window.showDirectoryPicker === 'function';
    const canOpen = typeof window.showOpenFilePicker === 'function';
    const canSave = typeof window.showSaveFilePicker === 'function';

    async function writable(handle, silent) {
        const opts = { mode: 'readwrite' };
        if (await handle.queryPermission(opts) !== 'granted') {
            if (silent || await handle.requestPermission(opts) !== 'granted') return null;
        }
        return handle.createWritable();
    }

    return {
        kind: 'web',
        canPickDirectory: canPickDir,
        async openFile() {
            if (canOpen) {
                try {
                    const [handle] = await window.showOpenFilePicker({
                        types: [{ description: 'Text files',
                            accept: { 'text/markdown': ['.md', '.markdown'], 'text/plain': ['.txt'] } }],
                    });
                    const file = await handle.getFile();
                    return { ref: { handle }, name: file.name, content: await file.text() };
                } catch (e) {
                    if (e.name === 'AbortError') return null;
                    throw e;
                }
            }
            return new Promise((resolve) => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.md,.markdown,.txt';
                input.onchange = async () => {
                    const file = input.files[0];
                    resolve(file ? { ref: null, name: file.name, content: await file.text() } : null);
                };
                input.oncancel = () => resolve(null);
                input.click();
            });
        },
        // ref === null means "Save As". silent = autosave: never prompt.
        async saveFile(ref, content, suggestedName, { silent = false } = {}) {
            if (ref && ref.handle) {
                const w = await writable(ref.handle, silent);
                if (w) {
                    await w.write(content);
                    await w.close();
                    return { ref, name: ref.handle.name };
                }
                if (silent) return null;
            }
            if (silent) return null;
            const name = withExtension(suggestedName);
            if (canSave) {
                try {
                    const handle = await window.showSaveFilePicker({
                        suggestedName: name,
                        types: [
                            { description: 'Markdown', accept: { 'text/markdown': ['.md'] } },
                            { description: 'Plain text', accept: { 'text/plain': ['.txt'] } },
                        ],
                    });
                    const w = await handle.createWritable();
                    await w.write(content);
                    await w.close();
                    return { ref: { handle }, name: handle.name };
                } catch (e) {
                    if (e.name === 'AbortError') return null;
                    throw e;
                }
            }
            const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = name;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            return { ref: null, name }; // downloaded: nothing to save back into
        },
        async pickDirectory() {
            try {
                const handle = await window.showDirectoryPicker();
                return { ref: { handle }, name: handle.name };
            } catch (e) {
                if (e.name === 'AbortError') return null;
                throw e;
            }
        },
        async listDir(dir) {
            const entries = [];
            for await (const entry of dir.ref.handle.values()) {
                entries.push({ name: entry.name, kind: entry.kind, ref: { handle: entry } });
            }
            return entries;
        },
        async readFile(ref) {
            const file = await ref.handle.getFile();
            return { name: file.name, content: await file.text() };
        },
    };
}

export const createFs = webFs;
