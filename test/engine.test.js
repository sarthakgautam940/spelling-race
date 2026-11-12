const test = require('node:test');
const assert = require('node:assert');
const E = require('../engine.js');

test('distance and similarity', () => {
  assert.strictEqual(E.distance('necessary', 'necessary'), 0);
  assert.strictEqual(E.distance('recieve', 'receive'), 1);
  assert.strictEqual(E.distance('definately', 'definitely'), 1);
  assert.strictEqual(E.similarity('cat', 'cat'), 1);
  assert.strictEqual(E.similarity('', ''), 1);
  assert.ok(E.similarity('abc', 'xyz') === 0);
});

test('align labels swap, miss, extra, sub', () => {
  const swap = E.align('recieve', 'receive');
  assert.ok(swap.some(o => o.k === 'swap' && o.a === 'ei'));
  assert.deepStrictEqual(E.describe(swap), ['Swapped ei']);
  const miss = E.align('neccesary', 'necessary');
  assert.deepStrictEqual(E.describe(miss).length > 0, true);
  const extra = E.align('seperrate', 'separate');
  assert.ok(extra.some(o => o.k === 'extra'));
  const sub = E.align('seperate', 'separate');
  assert.deepStrictEqual(E.describe(sub), ['Wrote e for a']);
  assert.deepStrictEqual(E.troubleLetters(sub), ['a']);
  assert.strictEqual(E.align('word', 'word').every(o => o.k === 'ok'), true);
});

test('ops cover the whole answer', () => {
  const pairs = [['accomodate', 'accommodate'], ['wierd', 'weird'], ['', 'abc'], ['abc', ''], ['occured', 'occurred']];
  for (const [t, a] of pairs) {
    const ops = E.align(t, a);
    const rebuilt = ops.map(o => (o.k === 'extra' ? '' : o.a || '')).join('');
    assert.strictEqual(rebuilt, a, t + ' vs ' + a);
  }
});

test('misspell always changes the word and avoids real words', () => {
  const words = ['necessary', 'because', 'receive', 'thought', 'beautiful', 'rhythm', 'school', 'friend', 'queue', 'sky'];
  const real = new Set(words);
  for (const w of words) {
    for (let i = 0; i < 200; i++) {
      const m = E.misspell(w, x => real.has(x));
      assert.notStrictEqual(m.shown, w);
      assert.ok(/^[a-z]+$/.test(m.shown));
    }
  }
});

test('level weights sum to one and shift toward hard', () => {
  for (const n of [1, 5, 12, 40]) {
    const w = E.levelWeights('ramp', n);
    assert.ok(Math.abs(w.easy + w.medium + w.hard - 1) < 1e-9);
  }
  assert.ok(E.levelWeights('ramp', 30).hard > E.levelWeights('ramp', 1).hard);
  assert.deepStrictEqual(E.levelWeights('hard', 3), { easy: 0, medium: 0, hard: 1 });
});

test('round points reward place and clean play', () => {
  assert.deepStrictEqual(E.roundPoints(0, true, 1), { place: 10, clean: 2, total: 12 });
  assert.deepStrictEqual(E.roundPoints(1, true, 0.8), { place: 7, clean: 0, total: 7 });
  assert.strictEqual(E.roundPoints(2, true, 1).total, 7);
  assert.strictEqual(E.roundPoints(9, true, 1).place, 1);
  assert.deepStrictEqual(E.roundPoints(0, false, 1), { place: 0, clean: 0, total: 0 });
});

test('rank orders by points, then wins, accuracy, average and best time', () => {
  const P = (name, points, wins, precSum, precN, msSum, correct, bestMs) => ({ name, points, wins, precSum, precN, msSum, correct, bestMs });
  const out = E.rank([
    P('slow', 50, 2, 3, 3, 9000, 3, 2500),
    P('top', 80, 4, 4, 5, 8000, 5, 1000),
    P('wins', 50, 3, 3, 3, 9000, 3, 2500),
    P('acc', 50, 2, 3, 3, 9000, 3, 2500),
    P('tidy', 50, 2, 2.5, 3, 4000, 3, 900),
    P('none', 0, 0, 0, 0, 0, 0, null)
  ]).map((p) => p.name);
  assert.deepStrictEqual(out, ['top', 'wins', 'acc', 'slow', 'tidy', 'none']);
});

test('average time breaks an otherwise equal tie', () => {
  const P = (name, ms) => ({ name, points: 40, wins: 2, precSum: 4, precN: 4, msSum: ms * 4, correct: 4, bestMs: 1000 });
  assert.deepStrictEqual(E.rank([P('b', 2000), P('a', 1500)]).map((p) => p.name), ['a', 'b']);
  assert.strictEqual(E.compare(P('x', 1000), P('y', 1000)), 0);
});
