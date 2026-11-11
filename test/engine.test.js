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

test('rank orders by wins, then accuracy, then speed', () => {
  const P = (name, wins, precSum, precN, msSum, correct) => ({ name, wins, precSum, precN, msSum, correct });
  const out = E.rank([
    P('c', 1, 1, 1, 900, 1),
    P('a', 3, 2, 3, 3000, 3),
    P('b', 1, 1, 1, 500, 1),
    P('d', 1, 0.5, 1, 100, 1),
    P('e', 0, 0, 0, 0, 0)
  ]).map((p) => p.name);
  assert.deepStrictEqual(out, ['a', 'b', 'c', 'd', 'e']);
});
