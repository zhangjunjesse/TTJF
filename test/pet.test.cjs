'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Pet = require('../pet.js');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'pet.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'pet.css'), 'utf8');
const kinds = ['plant', 'capybara'];
const reactions = ['idle', 'pet', 'feed', 'wash', 'train', 'celebrate', 'unlock'];
const scenes = { home: '起航基地', forest: '微光森林', cave: '晶石洞穴', cloud: '云海浮岛', camp: '流星营地', harbor: '星环港湾', aurora: '极光山巅' };
const stages = {
  plant: ['晶卵初醒', '晶叶幼龙', '踏星小龙', '星翼飞龙', '星辉守护龙'],
  capybara: ['初见团团', '好奇学员', '星岛探员', '银河领航员', '星光守护者']
};

// Strip labels, metadata and gradient namespaces before comparing geometry.
// These checks catch missing variants; they do not judge visual quality.
function drawing(svg) {
  return svg.replace(/<defs\b[^>]*>[\s\S]*?<\/defs>/g, '')
    .replace(/<(title|desc|text)\b[^>]*>[\s\S]*?<\/\1>/g, '')
    .replace(/\s(?:aria-label|class|id|data-[\w-]+)="[^"]*"/g, '')
    .replace(/url\(#[^)]+\)/g, 'url(#local-paint)');
}
function lexicalCode(text) {
  return text.replace(/'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, ' ');
}
function groupContent(svg, className) {
  const marker = '<g class="' + className + '">';
  assert.ok(svg.includes(marker), 'Expected ' + className);
  const start = svg.indexOf(marker) + marker.length;
  let depth = 1;
  const tags = /<g\b[^>]*>|<\/g>/g;
  tags.lastIndex = start;
  let token;
  while ((token = tags.exec(svg))) {
    depth += token[0] === '</g>' ? -1 : 1;
    if (depth === 0) { return svg.slice(start, token.index); }
  }
  throw new Error('Unclosed ' + className);
}
function assertLocalResources(svg) {
  assert.doesNotMatch(svg, /<(?:script|image|foreignObject|iframe|animate|filter|style|use)\b/i);
  // Inspect actual attribute names, not escaped words inside a title/aria-label.
  for (const tag of svg.matchAll(/<[^>]+>/g)) {
    for (const attr of tag[0].matchAll(/\s+([^\s=/>]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g)) {
      assert.doesNotMatch(attr[1], /^(?:href|xlink:href|src|on[a-z]+)$/i);
    }
  }
  const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'IDs are unique within this SVG');
  for (const id of ids) { assert.match(id, /^pet-v6-[a-z0-9-]+$/); }
  for (const match of svg.matchAll(/url\(([^)]+)\)/g)) {
    assert.ok(match[1].startsWith('#'), 'Only local gradient/clip references are allowed');
    assert.ok(ids.includes(match[1].slice(1)), 'Every local reference resolves within this SVG');
  }
  return ids;
}

test('UMD and item API work without DOM, timers or mutable module state', () => {
  assert.deepEqual(Object.keys(Pet), ['render', 'renderItem']);
  const sandbox = { self: {} };
  new vm.Script(source, { filename: 'pet.js' }).runInNewContext(sandbox, { timeout: 1000 });
  assert.equal(typeof sandbox.self.FamilyPet.render, 'function');
  assert.equal(typeof sandbox.self.FamilyPet.renderItem, 'function');
  const options = Object.freeze({ kind: 'plant', stage: 3, name: '芽芽', reaction: 'pet', sceneId: 'cave', reducedMotion: true, instanceId: 'main' });
  assert.equal(sandbox.self.FamilyPet.render(options), Pet.render(options));
  assert.equal(Pet.render(options), Pet.render(options), 'No random IDs, counters or time');
  assert.equal(sandbox.self.FamilyPet.renderItem('dew'), Pet.renderItem('dew'));
  assert.deepEqual(Object.keys(sandbox), ['self']);
});

test('renderer retains the ES5 syntax/API fence', () => {
  const code = lexicalCode(source);
  assert.doesNotMatch(code, /\b(?:const|let|class|extends|super|import|export|async|await)\b|=>|`|\.\.\.|\?\./);
  assert.doesNotMatch(code, /\b(?:Map|Set|WeakMap|Promise|Symbol|BigInt)\b/);
  assert.doesNotMatch(code, /\.(?:includes|startsWith|endsWith|from|assign|entries|values)\s*\(/);
  assert.doesNotMatch(code, /\b(?:document|localStorage|sessionStorage|fetch|XMLHttpRequest|setTimeout|setInterval|requestAnimationFrame)\b/);
});

test('all 1960 framing/kind/stage/scene/reaction/motion combinations are complete local SVGs', () => {
  let count = 0;
  for (const framing of ['scene', 'hero']) {
    for (const kind of kinds) {
      for (let stage = 1; stage <= 5; stage += 1) {
        for (const sceneId of Object.keys(scenes)) {
          for (const reaction of reactions) {
            for (const reducedMotion of [false, true]) {
              const svg = Pet.render({ kind, stage, sceneId, reaction, reducedMotion, framing });
              assert.match(svg, framing === 'hero' ? /^<svg\b[^>]*viewBox="0 0 460 400"/ : /^<svg\b[^>]*viewBox="0 0 600 340"/);
              assert.equal((svg.match(/<g class="pet-character">/g) || []).length, 1);
              assert.match(svg, /width="100%" height="100%" preserveAspectRatio="xMidYMid meet"/);
              assert.match(svg, /role="img" focusable="false" aria-label="[^"]+"/);
              assert.match(svg, /<title>[^<]+<\/title><desc>[^<]+<\/desc>/);
              assert.ok(svg.includes(stages[kind][stage - 1]));
              assert.ok(svg.includes(scenes[sceneId]));
              for (const [key, value] of Object.entries({ kind, stage, scene: sceneId, reaction, framing, 'reduced-motion': reducedMotion })) {
                assert.ok(svg.includes('data-pet-' + key + '="' + value + '"'));
              }
              assert.equal((svg.match(/<svg\b/g) || []).length, 1);
              assert.ok(svg.endsWith('</svg>'));
              assertLocalResources(svg);
              assert.ok(Buffer.byteLength(svg, 'utf8') < 40000, 'A fully drawn scene stays below 40 KB');
              for (const match of svg.matchAll(/\bclass="([^"]*)"/g)) {
                assert.ok(match[1].split(/\s+/).every(name => name.startsWith('pet-')));
              }
              count += 1;
            }
          }
        }
      }
    }
  }
  assert.equal(count, 1960);
});

test('stages, scenes and reactions change geometry beyond metadata and gradient IDs', () => {
  for (const kind of kinds) {
    const stageDrawings = new Set();
    for (let stage = 1; stage <= 5; stage += 1) {
      stageDrawings.add(drawing(Pet.render({ kind, stage })));
      assert.equal(new Set(reactions.map(reaction => drawing(Pet.render({ kind, stage, reaction })))).size, 7);
      assert.equal(new Set(Object.keys(scenes).map(sceneId => drawing(Pet.render({ kind, stage, sceneId })))).size, 7);
    }
    assert.equal(stageDrawings.size, 5, kind + ' has five actual variants');
    const earlyBodies = [1, 2, 3].map(stage => drawing(groupContent(Pet.render({ kind, stage }), 'pet-character')).replace(/\stransform="[^"]*"/g, ''));
    assert.equal(new Set(earlyBodies).size, 3, 'Young bodies are not scaled copies of stage 3');
  }
});

test('untrusted names and option strings cannot introduce markup or resource URLs', () => {
  const attack = '\u0000芽<&>"\' </title><script>alert(1)</script><svg onload="evil()">';
  const svg = Pet.render({ kind: 'plant', stage: 3, name: attack, instanceId: '\"><image href="https://bad.invalid/a"/>', sceneId: '__proto__', reaction: 'idle' });
  assert.ok(svg.includes('芽&lt;&amp;&gt;&quot;&#39; &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;svg onload=&quot;evil()&quot;&gt;'));
  assert.doesNotMatch(svg, /<script\b|<svg onload|\x00/);
  assert.equal((svg.match(/<svg\b/g) || []).length, 1);
  assert.equal((svg.match(/<title>/g) || []).length, 1);
  assertLocalResources(svg);
  const hostileOptions = { kind: 'capybara" onload="evil()', stage: '5"/><script>', sceneId: 'constructor', reaction: '__proto__', name: { toString() { throw new Error('Do not coerce arbitrary names'); } } };
  assert.equal(Pet.render(hostileOptions), Pet.render());
  assert.ok(Pet.render({ name: '小芽🌱 & 团团' }).includes('小芽🌱 &amp; 团团'));
});

test('option defaults and legacy reactions preserve the public rendering contract', () => {
  for (const options of [null, undefined, false, 42, 'plant']) { assert.equal(Pet.render(options), Pet.render()); }
  for (const input of [NaN, Infinity, -Infinity, {}, 'no', -10, 0]) {
    assert.ok(Pet.render({ stage: input }).includes('data-pet-stage="1"'));
  }
  assert.ok(Pet.render({ stage: '3' }).includes('data-pet-stage="3"'));
  assert.ok(Pet.render({ stage: 3.9 }).includes('data-pet-stage="3"'));
  assert.ok(Pet.render({ stage: 1000 }).includes('data-pet-stage="5"'));
  assert.ok(Pet.render({ kind: 'capybara', name: '  ' }).includes('<title>团团 · 初见团团</title>'));
  for (const reaction of ['constructor', 'toString', '<script>', null, {}]) {
    assert.ok(Pet.render({ reaction }).includes('data-pet-reaction="idle"'));
  }
  for (const sceneId of ['constructor', '__proto__', '<script>', null, {}]) { assert.equal(Pet.render({ sceneId }), Pet.render()); }
  for (const framing of [undefined, null, false, 'unknown', 'hero" onload="evil()', {}]) { assert.equal(Pet.render({ framing }), Pet.render()); }
  assert.equal(Pet.render({ reaction: 'water' }), Pet.render({ reaction: 'wash' }));
  assert.equal(Pet.render({ reaction: 'play' }), Pet.render({ reaction: 'train' }));
  assert.equal(Pet.render({ reaction: 'sun' }), Pet.render({ reaction: 'pet' }));
});

test('optional instance IDs provide deterministic, separate local paint namespaces', () => {
  const first = assertLocalResources(Pet.render({ stage: 5, instanceId: 'main' }));
  const second = assertLocalResources(Pet.render({ stage: 5, instanceId: 'gallery' }));
  assert.ok(first.length > 0 && second.length > 0);
  assert.ok(first.every(id => !second.includes(id)));
  assert.equal(Pet.render({ instanceId: 'main' }), Pet.render({ instanceId: 'main' }));
});

test('measured bodies exclude equipment, egg fragments, terrain and reaction props', () => {
  for (const kind of kinds) {
    for (let stage = 1; stage <= 5; stage += 1) {
      for (const reaction of reactions) {
        const svg = Pet.render({ kind, stage, reaction, framing: 'hero', reducedMotion: true });
        const body = groupContent(svg, 'pet-character');
        assert.match(body, /<path d="M[^"]+" fill="(?:#[a-f0-9]{6}|url\(#[^)]+\))"/);
        assert.match(body, /pet-head-motion/);
        assert.doesNotMatch(body, /pet-(?:equipment|faceplate|environment|snack|ball|affection|victory|wash|train-impact|star-map|reaction-art)/);
        assert.doesNotMatch(body, /<(?:rect|text|defs)\b|visibility="hidden"|opacity="0"/);
        assert.ok(svg.includes('<g class="pet-equipment pet-equipment-front">'));
        assert.equal(drawing(svg), drawing(Pet.render({ kind, stage, reaction, framing: 'hero', reducedMotion: false })));
      }
    }
  }
});

test('reduced motion retains the contact art and stops bodies, visors and all effect descendants', () => {
  for (const kind of kinds) {
    for (const reaction of reactions) {
      const reduced = Pet.render({ kind, stage: 3, reaction, reducedMotion: true });
      assert.ok(reduced.includes(' pet-reduced"'));
      if (reaction !== 'idle') { assert.ok(groupContent(reduced, 'pet-reaction-art').length > 0); }
    }
  }
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /\.pet-reduced[\s\S]*?animation:\s*none\s*!important/);
  for (const className of ['pet-actor', 'pet-head-motion', 'pet-eye', 'pet-arm-front', 'pet-arm-back', 'pet-wing', 'pet-tail', 'pet-faceplate']) {
    assert.ok(css.includes('.pet-reduced .' + className), className + ' has an explicit reduced-motion override');
  }
  assert.ok(css.includes('.pet-reduced .pet-reaction-art *'));
  assert.match(css, /\.pet-reduced\.pet-reaction-feed \.pet-faceplate\s*\{[^}]*transform:/);
  assert.match(css, /\.pet-reduced\.pet-reaction-train \.pet-arm-front\s*\{[^}]*transform:/);
});

test('inventory icons share safe local art for all three real items', () => {
  const labels = { snack: '能量果', dew: '星露瓶', ball: '训练球' };
  const drawings = new Set();
  for (const [itemId, label] of Object.entries(labels)) {
    const svg = Pet.renderItem(itemId, { instanceId: 'inventory-' + itemId });
    assert.match(svg, /^<svg\b[^>]*viewBox="0 0 96 96"/);
    assert.ok(svg.includes('<title>' + label + '</title>'));
    assert.ok(svg.includes('aria-label="' + label + '"'));
    assertLocalResources(svg);
    drawings.add(drawing(svg));
    assert.equal(svg, Pet.renderItem(itemId, { instanceId: 'inventory-' + itemId }));
  }
  assert.equal(drawings.size, 3);
  for (const itemId of ['unknown', 'constructor', '__proto__', '<script>', undefined, null, {}]) { assert.equal(Pet.renderItem(itemId), ''); }
});

test('CSS remains namespaced and has no imports, URLs or expensive filter effects', () => {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/\.([a-z][\w-]*)/gi)) { assert.ok(match[1].startsWith('pet-')); }
  for (const match of withoutComments.matchAll(/@(?:-webkit-)?keyframes\s+([\w-]+)/g)) { assert.ok(match[1].startsWith('pet-')); }
  assert.doesNotMatch(withoutComments, /@import|url\(|\bfilter\s*:|\bwill-change\s*:|#[a-z][\w-]*\s*\{/i);
});
