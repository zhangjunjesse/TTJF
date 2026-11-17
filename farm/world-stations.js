import { group, TAU } from './primitives.js';
import { addWindowGlow } from './world-lighting.js';

// These objects are scenery and navigation markers. No balance, task state or
// other family data is inferred from a decorative coin, paper, book or gift.
const C = { wood: 0xa58157, dark: 0x75583e, edge: 0xc6a776, cream: 0xf1dfb5,
  paper: 0xf5e9cd, green: 0x789868, leaf: 0x97b676, teal: 0x76a6a3,
  blue: 0x96b8bd, gold: 0xe8bd62, coral: 0xcf8f76, stone: 0xafa88d };
export const WORLD_STATIONS = Object.freeze({
  welcome: '欢迎回到小小向前', points: '星星工坊', reminders: '林间告示板', rewards: '心愿集市',
  history: '成长档案馆', companion: '伙伴营地', settings: '小院管理屋', family: '家庭小屋',
  voice: '风车传话站', authorization: '家长守护屋'
});
export const normalizePresentation = value => Object.prototype.hasOwnProperty.call(WORLD_STATIONS, value) ? value : 'farm';

function part(station, id, label, position, build) {
  const root = group(station.root, position); root.name = 'station-' + id;
  root.userData.landmark = { id, label }; build(root); station.workshop.bake(root);
  station.landmarks.push({ id, label, root }); return root;
}
function model(station, parent, key, name, size, position, rotation = 0, height = false) {
  const root = station.models.clone(key, name, size, height);
  root.position.set(...position); root.rotation.y = rotation; parent.add(root); return root;
}
function plank(w, root, position, size, color = C.wood) {
  w.box(root, color, position, size);
  for (const side of [-1, 1]) w.orb(root, C.dark, [position[0] + side * (size[0] / 2 - .10), position[1], position[2] + size[2] / 2 + .008], [.023, .023, .012], 0);
}
function fence(w, root, x, z, length) {
  for (const side of [-1, 1]) {
    w.box(root, C.wood, [x + side * length / 2, .52, z], [.16, 1.04, .18]);
    w.cone(root, C.edge, [x + side * length / 2, 1.12, z], [.13, .18, .13]);
  }
  for (const y of [.38, .76]) w.box(root, C.edge, [x, y, z], [length, .12, .12]);
}
function leafVine(w, root, x, y, z, height, bend = 1) {
  w.beam(root, C.green, [x, y, z], [x + bend * .3, y + height, z], .035);
  for (let i = 0; i < 7; i++) {
    const side = i % 2 ? 1 : -1, yy = y + .12 + i * height / 7;
    const leaf = w.orb(root, i % 3 ? C.leaf : C.green, [x + bend * i * .04 + side * .14, yy, z + .02], [.22, .09, .10], 1);
    leaf.rotation.z = side * .4;
    if (i % 3 === 1) w.orb(root, C.coral, [x + bend * i * .04, yy + .06, z + .13], [.08, .08, .05], 1);
  }
}
function pot(w, root, x, z, scale = 1) {
  const p = group(root, [x, 0, z]); p.scale.setScalar(scale);
  w.cylinder(p, C.coral, [0, .28, 0], .24, .52, .35);
  w.cylinder(p, C.edge, [0, .54, 0], .36, .10);
  w.cylinder(p, C.dark, [0, .60, 0], .30, .02);
  for (let i = 0; i < 5; i++) {
    const a = i * TAU / 5;
    w.beam(p, C.green, [0, .58, 0], [Math.cos(a) * .22, 1.02 + i % 2 * .15, Math.sin(a) * .22], .025);
    w.orb(p, i % 2 ? C.leaf : C.green, [Math.cos(a) * .24, .83, Math.sin(a) * .24], [.22, .13, .12], 1);
    w.orb(p, i % 2 ? C.cream : C.coral, [Math.cos(a) * .22, 1.06 + i % 2 * .15, Math.sin(a) * .22], [.12, .10, .12], 1);
  }
}
function book(w, root, position, size, color, lean = 0) {
  const b = group(root, position); b.rotation.z = lean;
  w.box(b, C.paper, [0, 0, .02], [size[0] * .78, size[1] * .90, size[2] * .94]);
  for (const x of [-size[0] / 2, size[0] / 2]) w.box(b, color, [x, 0, 0], [.045, size[1], size[2]]);
  w.box(b, color, [0, 0, size[2] / 2], [size[0], size[1], .07]);
  for (const y of [-size[1] * .30, size[1] * .30]) w.box(b, C.gold, [0, y, size[2] / 2 + .041], [size[0] * .75, .035, .012]);
}
function gift(w, root, position, size, color, ribbon) {
  const p = group(root, position), [x, y, z] = size;
  w.box(p, color, [0, y / 2, 0], size);
  w.box(p, color, [0, y + .035, 0], [x + .10, .13, z + .10]);
  w.box(p, ribbon, [0, y / 2, z / 2 + .008], [x * .15, y, .025]);
  w.box(p, ribbon, [0, y + .11, 0], [x * .16, .025, z + .12]);
  w.box(p, ribbon, [0, y + .113, 0], [x + .12, .025, z * .15]);
  for (const side of [-1, 1]) w.ring(p, ribbon, [side * x * .13, y + .22, 0], x * .15, .035, [.15, side * .35, side * .55]);
}
function gear(w, root, radius, color) {
  w.ring(root, color, [0, 0, 0], radius * .70, radius * .20);
  w.cylinder(root, C.dark, [0, 0, 0], radius * .19, .14, radius * .19, [Math.PI / 2, 0, 0]);
  for (let i = 0; i < 10; i++) {
    const a = i * TAU / 10;
    w.box(root, color, [Math.sin(a) * radius, Math.cos(a) * radius, 0], [radius * .26, radius * .38, .19], [0, 0, -a]);
  }
}
function treasury(s) {
  const w = s.workshop;
  part(s, 'treasury-chest', '盛放星星的木宝箱', [.35, 0, -.35], root => {
    for (let i = 0; i < 5; i++) plank(w, root, [0, .24 + i * .27, 0], [2.65, .25, 1.6], i % 2 ? C.wood : C.edge);
    w.box(root, C.dark, [0, 1.43, -.72], [2.70, .12, .16]);
    const lid = group(root, [0, 1.38, -.72]); lid.rotation.x = -.52;
    for (let i = 0; i < 4; i++) plank(w, lid, [0, .10 + i * .24, 0], [2.72, .23, .17], C.wood);
    for (const x of [-.92, .92]) {
      w.box(root, C.gold, [x, .72, .817], [.15, 1.35, .06]);
      w.box(lid, C.gold, [x, .51, .11], [.15, 1.13, .04]);
    }
    w.box(root, C.gold, [0, .88, .85], [.34, .40, .08]);
    w.orb(root, C.dark, [0, .88, .905], [.045, .08, .018], 0);
    for (let i = 0; i < 11; i++) w.cylinder(root, i % 2 ? C.gold : C.cream, [(i % 4 - 1.5) * .46, 1.44 + Math.floor(i / 4) * .10, -.42 + i % 3 * .32], .23, .09);
  });
  const star = part(s, 'gold-star', '积分站的金色大星星', [.45, 2.95, -.65], root => {
    w.star(root, C.gold, [0, 0, 0], .91); w.star(root, C.cream, [0, 0, .05], .51);
    w.beam(root, C.edge, [0, -.9, -.08], [0, -1.35, -.08], .05);
  });
  s.motions.push({ root: star, axis: 'y', base: 2.95, amplitude: .055, speed: 1.25 });
  part(s, 'coin-baskets', '木桶与积分星章', [2.5, 0, .8], root => {
    model(s, root, 'props', 'prop-barrel', 1.03, [0, 0, 0], -.25, true);
    for (let i = 0; i < 4; i++) w.cylinder(root, C.gold, [.38 + i % 2 * .38, .10 + Math.floor(i / 2) * .12, .6], .29, .11);
    w.star(root, C.gold, [0, 1.48, .12], .35);
  });
}
function tasks(s) {
  const w = s.workshop;
  part(s, 'task-board', '贴有任务与完成勾选的木板', [.3, 0, -.6], root => {
    for (const x of [-1.35, 1.35]) w.box(root, C.dark, [x, 1.45, 0], [.20, 2.9, .25]);
    for (let i = 0; i < 6; i++) plank(w, root, [0, 1.17 + i * .35, .06], [3.25, .33, .24], i % 2 ? C.wood : C.edge);
    w.box(root, C.dark, [0, 3.12, .12], [3.55, .16, .36]);
    for (let i = 0; i < 3; i++) {
      const note = group(root, [-.98 + i * .98, 2.0, .25]); note.rotation.z = (i - 1) * -.06;
      w.box(note, i % 2 ? C.cream : C.paper, [0, 0, 0], [.79, 1.30, .035]);
      w.orb(note, C.coral, [0, .50, .035], [.045, .045, .025], 1);
      for (let j = 0; j < 3; j++) w.box(note, C.edge, [.08, .25 - j * .22, .026], [.35, .035, .012]);
      w.box(note, C.green, [-.20, .24, .04], [.07, .16, .035], [0, 0, .55]);
      w.box(note, C.green, [-.12, .29, .04], [.07, .28, .035], [0, 0, -.55]);
    }
    fence(w, root, -2.35, .55, .85);
  });
  part(s, 'daily-clock', '挂在任务板上的小钟', [.3, 3.55, -.38], root => {
    w.cylinder(root, C.edge, [0, 0, 0], .43, .14, .43, [Math.PI / 2, 0, 0]);
    w.cylinder(root, C.paper, [0, 0, .08], .35, .03, .35, [Math.PI / 2, 0, 0]);
    for (let i = 0; i < 12; i++) { const a = i * TAU / 12; w.orb(root, C.dark, [Math.sin(a) * .29, Math.cos(a) * .29, .11], [.017, .017, .01], 0); }
    w.beam(root, C.dark, [0, 0, .13], [-.15, .10, .13], .018); w.beam(root, C.dark, [0, 0, .14], [.02, .25, .14], .014);
  });
  part(s, 'mailbox', '收到新计划的农场信箱', [2.4, 0, .65], root => {
    w.box(root, C.wood, [0, .65, 0], [.16, 1.3, .16]);
    w.box(root, C.teal, [0, 1.43, 0], [.90, .61, .65]);
    w.ball(root, C.blue, [0, 1.72, 0], [.45, .20, .33]);
    w.box(root, C.paper, [0, 1.46, .34], [.60, .38, .02]);
    w.beam(root, C.coral, [.48, 1.4, 0], [.48, 2.0, 0], .035); w.box(root, C.coral, [.65, 1.94, 0], [.34, .20, .06]);
  });
}
function market(s) {
  const w = s.workshop;
  part(s, 'gift-market', '布篷与木柜台组成的礼品小摊', [.45, 0, -.5], root => {
    for (const x of [-1.65, 1.65]) for (const z of [-.75, .80]) w.box(root, C.wood, [x, 1.65, z], [.14, 3.3, .14]);
    for (let i = 0; i < 9; i++) w.box(root, i % 2 ? C.cream : C.teal, [-1.6 + i * .40, 3.20, .10], [.40, .12, 2.20], [-.12, 0, 0]);
    for (let i = 0; i < 9; i++) { w.box(root, i % 2 ? C.cream : C.teal, [-1.6 + i * .40, 2.99, 1.18], [.40, .38, .08]); w.ball(root, i % 2 ? C.cream : C.teal, [-1.6 + i * .40, 2.79, 1.18], [.20, .13, .055]); }
    for (let i = 0; i < 7; i++) plank(w, root, [-1.50 + i * .50, .65, .60], [.48, 1.25, .16], i % 2 ? C.wood : C.edge);
    w.box(root, C.dark, [0, 1.33, .40], [3.6, .18, 1.20]);
    gift(w, root, [-.95, 1.43, .28], [.70, .65, .64], C.coral, C.cream);
    gift(w, root, [.12, 1.43, .25], [.80, .87, .66], C.cream, C.coral);
    gift(w, root, [1.1, 1.43, .22], [.67, .55, .60], C.blue, C.gold);
    w.star(root, C.gold, [0, 3.54, .20], .33);
  });
  part(s, 'gift-wagon', '装着心愿礼物的小推车', [2.8, 0, 1.0], root => {
    w.box(root, C.wood, [0, .43, 0], [.95, .38, 1.12]);
    for (const x of [-.54, .54]) w.cylinder(root, C.dark, [x, .26, 0], .25, .10, .25, [0, 0, Math.PI / 2]);
    gift(w, root, [0, .64, 0], [.75, .61, .77], C.coral, C.gold);
    w.beam(root, C.dark, [0, .42, .5], [0, .62, 1.15], .04);
  });
}
function archive(s) {
  const w = s.workshop;
  part(s, 'records-cabinet', '收藏成长记录的开放木书柜', [.4, 0, -.5], root => {
    for (const x of [-1.6, 1.6]) w.box(root, C.dark, [x, 1.75, 0], [.19, 3.5, 1.05]);
    w.box(root, C.wood, [0, 1.75, -.5], [3.2, 3.5, .12]);
    for (let i = 0; i < 4; i++) {
      w.box(root, C.edge, [0, .20 + i * 1.02, .05], [3.5, .14, 1.22]);
      if (i === 3) continue;
      for (let j = 0; j < 7; j++) book(w, root, [-1.32 + j * .40, .70 + i * 1.02, .10], [.29, .76 - j % 3 * .08, .72], [C.teal, C.coral, C.green, C.edge][(i + j) % 4], j === 6 ? -.13 : 0);
    }
    w.box(root, C.dark, [0, 3.45, .03], [3.65, .16, 1.20]);
  });
  part(s, 'open-journal', '摊开的日记和一支羽毛笔', [.5, 0, 1.45], root => {
    for (const x of [-.92, .92]) w.box(root, C.wood, [x, .60, 0], [.12, 1.2, .12]);
    w.box(root, C.dark, [0, 1.24, 0], [2.35, .15, 1.28]);
    for (const side of [-1, 1]) {
      const page = group(root, [side * .46, 1.38, 0]); page.rotation.z = side * .10;
      w.box(page, C.coral, [0, 0, 0], [.92, .11, .93]); w.box(page, C.paper, [0, .07, 0], [.85, .07, .87]);
      for (let i = 0; i < 4; i++) w.box(page, C.edge, [0, .112, -.23 + i * .15], [.58, .008, .022]);
    }
    w.cylinder(root, C.teal, [.88, 1.45, -.25], .12, .29);
    w.beam(root, C.dark, [.88, 1.54, -.25], [1.08, 2.0, -.27], .015);
    w.orb(root, C.cream, [1.08, 1.98, -.27], [.07, .25, .025], 1).rotation.z = -.35;
  });
}
function sanctuary(s) {
  const w = s.workshop;
  s.companionPosition = [2.4, .08, 1.25]; s.companionScale = 1.05;
  part(s, 'garden-pergola', '伙伴休息的藤蔓花架', [.35, 0, -.9], root => {
    for (const x of [-1.85, 1.85]) { w.box(root, C.dark, [x, 1.65, 0], [.22, 3.3, .22]); leafVine(w, root, x, .30, .15, 2.8, x > 0 ? -1 : 1); }
    for (let i = 0; i < 5; i++) w.box(root, C.edge, [-2 + i, 3.30, .0], [.18, .16, 1.50]);
    w.box(root, C.wood, [0, 3.16, .55], [4.25, .22, .17]);
    for (let i = 0; i < 5; i++) w.orb(root, i % 2 ? C.leaf : C.green, [-1.5 + i * .75, 3.36, .55], [.54, .20, .23], 1);
    w.star(root, C.gold, [0, 2.90, .70], .31);
  });
  part(s, 'resting-bench', '伙伴花园的木长椅', [-1.8, 0, 1.15], root => model(s, root, 'bench', 'decor-sunset_bench', 2.25, [0, 0, 0], .08));
  part(s, 'garden-tree', '果树与浇水壶', [3.20, 0, -.25], root => {
    model(s, root, 'apple', 'tree-apple_tree-ready', 3.25, [0, 0, 0], .4, true);
    model(s, root, 'props', 'prop-milk_can', .63, [-.65, .01, 1.0], .5, true);
    pot(w, root, .55, 1.05, .85);
  });
}
function workshop(s) {
  const w = s.workshop;
  part(s, 'workbench', '摆着园艺工具的木工台', [.35, 0, -.1], root => {
    for (const x of [-1.6, 1.6]) for (const z of [-.55, .55]) w.box(root, C.dark, [x, .68, z], [.20, 1.36, .20]);
    for (let i = 0; i < 5; i++) plank(w, root, [0, 1.43, -.60 + i * .30], [3.65, .16, .29], i % 2 ? C.edge : C.wood);
    for (const x of [-1.6, 1.6]) w.box(root, C.wood, [x, 2.15, -.65], [.13, 1.5, .13]);
    for (let i = 0; i < 3; i++) plank(w, root, [0, 1.95 + i * .35, -.67], [3.4, .25, .14], C.wood);
    w.beam(root, C.teal, [-1, 2.08, -.5], [-.55, 2.55, -.5], .06); w.ring(root, C.teal, [-.55, 2.55, -.5], .14, .055);
    w.beam(root, C.edge, [.85, 2.1, -.5], [.85, 2.65, -.5], .065); w.box(root, C.stone, [.85, 2.65, -.5], [.52, .17, .18]);
    w.box(root, C.coral, [.75, 1.75, 0], [1.00, .48, .65]); w.ring(root, C.dark, [.75, 2.08, 0], .22, .04);
    pot(w, root, -1.05, .0, .75);
  });
  const cog = part(s, 'workshop-gear', '工坊的转动木齿轮', [.25, 3.08, -.75], root => gear(w, root, .53, C.gold));
  s.motions.push({ root: cog, rotation: 'z', speed: -.16 });
  part(s, 'tool-crates', '整齐收纳的农场工具箱', [2.9, 0, .65], root => {
    model(s, root, 'props', 'prop-crate_stack', 1.1, [0, 0, 0], -.18);
    model(s, root, 'wheelbarrow', 'decor-wheelbarrow', 1.35, [.05, 0, 1.08], -.65);
  });
}
function cottage(s) {
  const w = s.workshop;
  const house = part(s, 'family-cottage', '家庭成员共同生活的农场小屋', [.35, 0, -.85], root => {
    model(s, root, 'house2', 'building-farmhouse-2', 4.25, [0, 0, 0], .05);
    for (let i = 0; i < 3; i++) w.cylinder(root, C.stone, [-.25 + i * .08, .035, 1.8 + i * .48], .30, .05).scale.z = .64;
  });
  addWindowGlow(w, house, s.nightUniform);
  part(s, 'family-table', '三把小凳围着的家庭圆桌', [2.65, 0, 1.0], root => {
    w.cylinder(root, C.dark, [0, .58, 0], .15, 1.16); w.cylinder(root, C.edge, [0, 1.18, 0], .78, .14);
    for (let i = 0; i < 3; i++) {
      const a = i * TAU / 3 + .4, x = Math.cos(a) * 1.05, z = Math.sin(a) * 1.05;
      w.cylinder(root, C.wood, [x, .31, z], .20, .62); w.cylinder(root, i === 2 ? C.coral : C.teal, [x, .66, z], .33, .12);
      w.cylinder(root, C.paper, [Math.cos(a) * .38, 1.35, Math.sin(a) * .38], .10, .20);
    }
    w.cylinder(root, C.teal, [0, 1.40, 0], .14, .32); leafVine(w, root, 0, 1.57, 0, .38);
  });
  part(s, 'family-pennants', '小屋门前的三角彩旗', [-2.3, 0, .8], root => {
    for (const x of [-.55, .55]) w.box(root, C.wood, [x, 1.13, 0], [.10, 2.26, .10]);
    w.beam(root, C.cream, [-.55, 2.16, 0], [.55, 2.16, 0], .015);
    for (let i = 0; i < 3; i++) w.polygon(root, [C.teal, C.coral, C.gold][i], [[-.13, 0], [.13, 0], [0, -.33]], .015, [-.36 + i * .36, 2.14, .02]);
  });
}
function soundGarden(s) {
  const w = s.workshop;
  part(s, 'voice-platform', '声音花园的木舞台', [.35, 0, -.15], root => {
    for (let i = 0; i < 8; i++) plank(w, root, [-1.75 + i * .5, .12, 0], [.48, .20, 2.6], i % 2 ? C.edge : C.wood);
    for (const x of [-1.75, 1.75]) w.box(root, C.dark, [x, .08, 0], [.20, .16, 2.8]);
  });
  part(s, 'garden-microphone', '有铜色网罩的复古麦克风', [.35, .24, 0], root => {
    w.cylinder(root, C.dark, [0, .10, 0], .48, .16);
    w.cylinder(root, C.wood, [0, .85, 0], .075, 1.5);
    w.ring(root, C.gold, [0, 2.1, 0], .67, .06);
    w.box(root, C.teal, [0, 2.17, 0], [.69, 1.04, .42]);
    w.ball(root, C.gold, [0, 2.70, 0], [.35, .28, .22]);
    w.ball(root, C.teal, [0, 1.66, 0], [.35, .22, .22]);
    for (let i = 0; i < 7; i++) w.box(root, C.gold, [0, 1.86 + i * .12, .23], [.58, .035, .04]);
    w.beam(root, C.gold, [-.6, 2.0, 0], [-.6, 1.6, 0], .055); w.beam(root, C.gold, [.6, 2.0, 0], [.6, 1.6, 0], .055);
    w.beam(root, C.gold, [-.6, 1.6, 0], [.6, 1.6, 0], .055);
  });
  for (let i = 0; i < 5; i++) {
    const h = [1.25, 1.9, 2.35, 1.65, 1.05][i];
    const tube = part(s, 'sound-pipe-' + i, '声音花园的第' + (i + 1) + '根音柱', [-1.7 + i * .87, 0, -1.65], root => {
      w.cylinder(root, i % 2 ? C.teal : C.gold, [0, h / 2, 0], .13, h);
      w.ball(root, C.cream, [0, h, 0], [.14, .09, .14]);
    });
    s.motions.push({ root: tube, scale: 'y', base: 1, amplitude: .025, speed: 1.7 + i * .16, phase: i });
  }
  part(s, 'listening-bench', '听故事时休息的木椅', [2.9, 0, 1.1], root => model(s, root, 'bench', 'decor-sunset_bench', 1.75, [0, 0, 0], -.3));
}
function guardian(s) {
  const w = s.workshop;
  part(s, 'guardian-gate', '家长守护的木栅门与拱梁', [.45, 0, -.4], root => {
    for (const x of [-1.6, 1.6]) {
      w.box(root, C.dark, [x, 1.65, 0], [.30, 3.3, .35]);
      w.cone(root, C.edge, [x, 3.4, 0], [.25, .30, .25]);
      leafVine(w, root, x, .22, .21, 2.5, x > 0 ? -1 : 1);
    }
    w.box(root, C.wood, [0, 3.18, 0], [3.45, .25, .30]);
    for (let i = 0; i < 9; i++) { const x = -1.28 + i * .32; w.box(root, C.edge, [x, 1.0, .04], [.22, 1.9, .15]); w.cone(root, C.edge, [x, 2.02, .04], [.15, .22, .12]); }
    for (const y of [.45, 1.4]) w.box(root, C.wood, [0, y, .16], [2.9, .13, .13]);
    fence(w, root, -2.5, .1, 1.4); fence(w, root, 2.5, .1, 1.4);
    w.star(root, C.gold, [0, 3.25, .19], .27);
  });
  part(s, 'guardian-padlock', '守护门上的大铜锁', [.45, 1.05, .0], root => {
    w.ring(root, C.gold, [0, .91, 0], .45, .10);
    w.box(root, C.gold, [0, .32, .02], [1.02, .94, .34]);
    w.box(root, C.cream, [0, .32, .20], [.79, .71, .025]);
    w.cylinder(root, C.dark, [0, .45, .225], .095, .025, .095, [Math.PI / 2, 0, 0]);
    w.polygon(root, C.dark, [[-.04, .03], [.04, .03], [.08, -.23], [-.08, -.23]], .02, [0, .40, .23]);
  });
  part(s, 'guardian-lantern', '守护门旁的温暖灯笼', [2.75, 0, .9], root => model(s, root, 'lantern', 'decor-lantern', 1.75, [0, 0, 0], 0, true));
}
function welcome(s) {
  const w = s.workshop;
  part(s, 'welcome-arch', '挂着彩旗与星星的农场迎宾门', [.6, 0, -.25], root => {
    for (const x of [-1.85, 1.85]) {
      w.box(root, C.wood, [x, 1.7, 0], [.26, 3.4, .26]);
      leafVine(w, root, x, .20, .20, 2.9, x > 0 ? -1 : 1);
    }
    w.box(root, C.dark, [0, 3.35, 0], [4.25, .25, .32]);
    plank(w, root, [0, 2.98, .08], [2.4, .47, .20], C.edge);
    for (let i = 0; i < 3; i++) w.star(root, i === 1 ? C.gold : C.cream, [-.72 + i * .72, 3.0, .20], i === 1 ? .19 : .13);
    for (let i = 0; i < 7; i++) w.polygon(root, [C.teal, C.cream, C.coral][i % 3], [[-.18, 0], [.18, 0], [0, -.43]], .018, [-1.55 + i * .52, 2.56 - Math.sin(i / 6 * Math.PI) * .19, .05]);
    fence(w, root, -2.7, .2, 1.3); fence(w, root, 2.7, .2, 1.3);
  });
  const house = part(s, 'welcome-cottage', '门后的小农舍', [-1.05, 0, -2.65], root => model(s, root, 'house1', 'building-farmhouse-1', 2.8, [0, 0, 0], .08));
  addWindowGlow(w, house, s.nightUniform);
  part(s, 'welcome-tree', '迎宾果树和一篮苹果', [3.05, 0, -1.75], root => {
    model(s, root, 'apple', 'tree-apple_tree-ready', 3.4, [0, 0, 0], .2, true);
    w.cylinder(root, C.wood, [-.4, .22, 1.35], .35, .44, .42);
    for (let i = 0; i < 5; i++) w.orb(root, i % 2 ? C.coral : C.gold, [-.6 + i % 3 * .18, .5 + Math.floor(i / 3) * .12, 1.25 + i % 2 * .15], [.13, .13, .13], 1);
  });
}

const BUILDERS = { welcome, points: treasury, reminders: tasks, rewards: market, history: archive,
  companion: sanctuary, settings: workshop, family: cottage, voice: soundGarden, authorization: guardian };

export function makeWorldStation(workshop, models, presentation, nightUniform) {
  const id = normalizePresentation(presentation);
  if (id === 'farm') return null;
  const station = { id, label: WORLD_STATIONS[id], root: group(), landmarks: [], motions: [], workshop, models, nightUniform,
    companionPosition: [-.35, .045, 2.15], companionScale: .82 };
  station.root.name = 'world-station-' + id; station.root.position.set(2.15, .025, .45);
  part(station, 'garden-approach', '通往地点的石子小路与花盆', [0, 0, 0], root => {
    for (let i = 0; i < 7; i++) {
      const stone = workshop.cylinder(root, i % 2 ? C.stone : C.edge, [1.2 + Math.sin(i * 1.3) * .16, .028, 1.0 + i * .44], .30 + i % 2 * .04, .055);
      stone.scale.set(1.25, 1, .68); stone.rotation.y = i * .65;
    }
    pot(workshop, root, -2.85, .40, .85); pot(workshop, root, 3.25, .65, .75);
    model(station, root, 'flowers', 'decor-flower_bed', 1.25, [-2.5, 0, -1.45], .25);
  });
  BUILDERS[id](station);
  // Keep returned frame geometry independent of decorative metadata/resources.
  // The renderer owns Workshop disposal and the shared model registry lifecycle.
  station.root.updateMatrixWorld(true);
  return station;
}

export function animateWorldStation(station, seconds, reducedMotion) {
  for (const motion of station?.motions || []) {
    if (motion.rotation) motion.root.rotation[motion.rotation] = reducedMotion ? 0 : seconds * motion.speed;
    else {
      const value = motion.base + (reducedMotion ? 0 : Math.sin(seconds * motion.speed + (motion.phase || 0)) * motion.amplitude);
      if (motion.scale) motion.root.scale[motion.scale] = value;
      else motion.root.position[motion.axis] = value;
    }
  }
}
