// Daily word-goal bookkeeping. Pure functions so they can be unit-tested.
// "written" is net words added today: loading or clearing a document moves the
// baseline (`last`) without counting as writing.

export function localDate(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function freshState(count, today = localDate()) {
    return { date: today, written: 0, last: count };
}

// Fold a new document word count into today's tally.
export function applyWordCount(state, count, goal, today = localDate()) {
    const history = { ...(state.history || {}) };
    let { written } = state;
    if (state.date !== today) written = 0; // new day, fresh tally (yesterday already in history)
    written = Math.max(0, written + (count - state.last));
    history[today] = { w: written, g: goal };
    const keys = Object.keys(history).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 400))) delete history[k];
    return { date: today, written, last: count, history };
}

// Move the baseline without counting the change as writing (open / new file).
export function resetBaseline(state, count, today = localDate()) {
    const s = state.date === today ? state : { ...state, date: today, written: 0 };
    return { ...s, last: count };
}

// Consecutive days meeting their goal, ending today (or yesterday if today isn't met yet).
export function streak(history = {}, today = localDate()) {
    const day = (offset) => {
        const d = new Date(`${today}T12:00:00`);
        d.setDate(d.getDate() + offset);
        return localDate(d);
    };
    const met = (k) => history[k] && history[k].w >= history[k].g;
    let offset = met(today) ? 0 : -1;
    let n = 0;
    while (met(day(offset))) { n++; offset--; }
    return n;
}
