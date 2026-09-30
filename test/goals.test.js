import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyWordCount, resetBaseline, streak, freshState } from '../src/goals.js';

test('counts net words written today', () => {
    let s = freshState(100, '2026-01-01');
    s = applyWordCount(s, 160, 500, '2026-01-01');
    assert.equal(s.written, 60);
    s = applyWordCount(s, 150, 500, '2026-01-01');
    assert.equal(s.written, 50);
});

test('deleting more than was written never goes negative', () => {
    let s = freshState(100, '2026-01-01');
    s = applyWordCount(s, 20, 500, '2026-01-01');
    assert.equal(s.written, 0);
});

test('opening a file moves the baseline without counting as writing', () => {
    let s = applyWordCount(freshState(0, '2026-01-01'), 40, 500, '2026-01-01');
    s = resetBaseline(s, 50000, '2026-01-01');
    assert.equal(s.written, 40);
    s = applyWordCount(s, 50010, 500, '2026-01-01');
    assert.equal(s.written, 50);
});

test('a new day starts from zero and keeps yesterday in history', () => {
    let s = applyWordCount(freshState(0, '2026-01-01'), 600, 500, '2026-01-01');
    s = applyWordCount(s, 700, 500, '2026-01-02');
    assert.equal(s.written, 100);
    assert.deepEqual(s.history['2026-01-01'], { w: 600, g: 500 });
});

test('streak counts consecutive goal-meeting days', () => {
    const h = {
        '2026-01-01': { w: 500, g: 500 }, '2026-01-02': { w: 900, g: 500 },
        '2026-01-03': { w: 100, g: 500 }, '2026-01-04': { w: 500, g: 500 }, '2026-01-05': { w: 501, g: 500 },
    };
    assert.equal(streak(h, '2026-01-05'), 2);
    assert.equal(streak(h, '2026-01-06'), 2); // today not started yet: streak survives
    assert.equal(streak(h, '2026-01-08'), 0);
});
