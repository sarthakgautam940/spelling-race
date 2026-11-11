/* Spelling engine: alignment, scoring, misspelling generator. Pure functions, no DOM. */
(function (root) {
  'use strict';

  /* Optimal string alignment distance matrix (Levenshtein plus adjacent swaps). */
  function matrix(a, b) {
    const n = a.length, m = b.length;
    const d = [];
    for (let i = 0; i <= n; i++) { d.push(new Array(m + 1).fill(0)); d[i][0] = i; }
    for (let j = 0; j <= m; j++) d[0][j] = j;
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
        d[i][j] = v;
      }
    }
    return d;
  }

  function distance(a, b) { return matrix(a, b)[a.length][b.length]; }

  /* 1 for identical, 0 for nothing in common. */
  function similarity(typed, answer) {
    const L = Math.max(typed.length, answer.length);
    if (!L) return 1;
    return Math.max(0, 1 - distance(typed, answer) / L);
  }

  /* Walk the matrix back into per-letter operations on what was typed.
     ok: right letter. sub: wrong letter. swap: two letters in the wrong order.
     extra: letter that should not be there. miss: letter that was left out. */
  function align(typed, answer) {
    const d = matrix(typed, answer);
    const ops = [];
    let i = typed.length, j = answer.length;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && typed[i - 1] === answer[j - 1] && d[i][j] === d[i - 1][j - 1]) {
        ops.push({ k: 'ok', t: typed[i - 1], a: answer[j - 1] }); i--; j--; continue;
      }
      if (i > 1 && j > 1 && typed[i - 1] === answer[j - 2] && typed[i - 2] === answer[j - 1] && d[i][j] === d[i - 2][j - 2] + 1) {
        ops.push({ k: 'swap', t: typed[i - 2] + typed[i - 1], a: answer[j - 2] + answer[j - 1] }); i -= 2; j -= 2; continue;
      }
      if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) {
        ops.push({ k: 'sub', t: typed[i - 1], a: answer[j - 1] }); i--; j--; continue;
      }
      if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
        ops.push({ k: 'extra', t: typed[i - 1] }); i--; continue;
      }
      ops.push({ k: 'miss', a: answer[j - 1] }); j--;
    }
    return ops.reverse();
  }

  /* Short plain-English notes about what went wrong. */
  function describe(ops) {
    const out = [];
    for (const o of ops) {
      if (o.k === 'swap') out.push('Swapped ' + o.a);
      else if (o.k === 'miss') out.push('Missing ' + o.a);
      else if (o.k === 'extra') out.push('Extra ' + o.t);
      else if (o.k === 'sub') out.push('Wrote ' + o.t + ' for ' + o.a);
    }
    return out.filter((x, i) => out.indexOf(x) === i).slice(0, 3);
  }

  /* Letters the player needed but got wrong, for the "trips on" profile. */
  function troubleLetters(ops) {
    const out = [];
    for (const o of ops) {
      if (o.k === 'miss' || o.k === 'sub') out.push(o.a);
      else if (o.k === 'swap') out.push(o.a[0], o.a[1]);
    }
    return out;
  }

  function opCounts(ops) {
    const c = { swap: 0, miss: 0, extra: 0, sub: 0 };
    for (const o of ops) if (c[o.k] !== undefined) c[o.k]++;
    return c;
  }

  /* Phonetic and mechanical slips people really make. */
  const RULES = [
    ['ie', 'ei'], ['ei', 'ie'], ['ph', 'f'], ['f', 'ph'], ['tion', 'sion'], ['sion', 'tion'],
    ['ance', 'ence'], ['ence', 'ance'], ['ant', 'ent'], ['ent', 'ant'], ['able', 'ible'], ['ible', 'able'],
    ['ary', 'ery'], ['ery', 'ary'], ['ous', 'us'], ['ck', 'k'], ['c', 'k'], ['k', 'c'], ['ce', 'se'], ['se', 'ce'],
    ['ee', 'ea'], ['ea', 'ee'], ['ai', 'ay'], ['ou', 'ow'], ['gh', 'f'], ['kn', 'n'], ['wr', 'r'], ['mb', 'm'],
    ['sc', 's'], ['ch', 'sh'], ['sh', 'ch'], ['dge', 'ge'], ['ght', 't'], ['er', 'or'], ['or', 'er'], ['ar', 'er'],
    ['y', 'i'], ['i', 'y'], ['j', 'g'], ['g', 'j'], ['z', 's'], ['s', 'z'], ['x', 'ks'], ['qu', 'kw'], ['al', 'le'], ['le', 'el']
  ];
  const DOUBLES = ['bb', 'cc', 'dd', 'ff', 'gg', 'll', 'mm', 'nn', 'pp', 'rr', 'ss', 'tt', 'zz', 'ee', 'oo'];
  const VOWELS = 'aeiou';

  /* Returns { shown, kind } where shown is a believable misspelling of word. */
  function misspell(word, isWord, rnd) {
    rnd = rnd || Math.random;
    const cands = [];
    const add = (s, kind, w) => { if (s !== word && s.length >= 3 && !(isWord && isWord(s))) cands.push({ shown: s, kind, w }); };
    // phonetic rules
    for (const [a, b] of RULES) {
      let from = 0, idx;
      while ((idx = word.indexOf(a, from)) !== -1) {
        if (!(idx === 0 && a.length === 1)) add(word.slice(0, idx) + b + word.slice(idx + a.length), 'sound', 3);
        from = idx + 1;
      }
    }
    // undouble
    for (const dd of DOUBLES) {
      const idx = word.indexOf(dd);
      if (idx !== -1) add(word.slice(0, idx) + dd[0] + word.slice(idx + 2), 'double', 4);
    }
    // double a single letter
    for (let i = 1; i < word.length - 1; i++) {
      if (word[i] !== word[i - 1] && word[i] !== word[i + 1] && /[bcdfglmnprst]/.test(word[i])) {
        add(word.slice(0, i + 1) + word[i] + word.slice(i + 1), 'double', 2);
      }
    }
    // swap adjacent letters
    for (let i = 1; i < word.length - 1; i++) {
      if (word[i] !== word[i + 1]) add(word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2), 'swap', 2);
    }
    // drop a letter
    for (let i = 1; i < word.length; i++) add(word.slice(0, i) + word.slice(i + 1), 'drop', 1);
    // wrong vowel
    for (let i = 1; i < word.length; i++) {
      if (VOWELS.includes(word[i])) {
        for (const v of VOWELS) if (v !== word[i]) add(word.slice(0, i) + v + word.slice(i + 1), 'vowel', 1);
      }
    }
    if (!cands.length) {
      const i = Math.max(1, Math.floor(word.length / 2));
      return { shown: word.slice(0, i) + word[i - 1] + word.slice(i), kind: 'double' };
    }
    let total = 0;
    for (const c of cands) total += c.w;
    let r = rnd() * total;
    for (const c of cands) { r -= c.w; if (r <= 0) return { shown: c.shown, kind: c.kind }; }
    return cands[0];
  }

  /* Share of a word bank by difficulty as the match goes on. */
  function levelWeights(level, n) {
    if (level !== 'ramp') { const o = { easy: 0, medium: 0, hard: 0 }; o[level] = 1; return o; }
    const easy = Math.max(0.12, 0.85 - 0.07 * (n - 1));
    const hard = Math.min(0.4, 0.05 * (n - 1));
    return { easy, medium: Math.max(0, 1 - easy - hard), hard };
  }

  /* Words that sound alike are unfair when you can only hear them. */
  const HOMOPHONES = new Set(('their there theyre write right rite weather whether peace piece plain plane brake break steel steal ' +
    'board bored which witch principal principle stationary stationery course coarse would wood whole hole flower flour knight night ' +
    'bear bare beat beet blew blue boar bore cell sell cent scent sent cheap chief close clothes council counsel dear deer dessert desert ' +
    'die dye fair fare flea flee forth fourth gate gait grate great groan grown hair hare heal heel hear here heard herd hire higher ' +
    'hour our idle idol knew new know no knot not lead led main mane meat meet medal meddle metal mettle mind mined moor more morning mourning ' +
    'none nun oar ore one won pair pear pare patience patients pause paws poor pour pore pray prey rain reign rein raise rays real reel ' +
    'role roll root route sail sale scene seen sea see seam seem sight site cite slay sleigh soar sore sole soul some sum son sun stair stare ' +
    'stake steak suite sweet tail tale taught taut tea tee team teem tear tier throne thrown tide tied toe tow vain vane vein waist waste ' +
    'wait weight war wore ware wear way weigh weak week wheel weal wood would yoke yolk yore your youre').split(' '));

  const api = { distance, similarity, align, describe, troubleLetters, opCounts, misspell, levelWeights, HOMOPHONES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Engine = api;
})(typeof window !== 'undefined' ? window : globalThis);
