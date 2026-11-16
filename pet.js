/* FamilyPet v0.6: original star-island explorers. ES5; pure SVG, no DOM/storage/network. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FamilyPet = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var STAGES = {
    plant: ['晶卵初醒', '晶叶幼龙', '踏星小龙', '星翼飞龙', '星辉守护龙'],
    capybara: ['初见团团', '好奇学员', '星岛探员', '银河领航员', '星光守护者']
  };
  var SCENES = { home: '起航基地', forest: '微光森林', cave: '晶石洞穴', cloud: '云海浮岛', camp: '流星营地', harbor: '星环港湾', aurora: '极光山巅' };
  var REACTIONS = ['idle', 'pet', 'feed', 'wash', 'train', 'celebrate', 'unlock'];
  var WORDS = { idle: '星岛探险队，准备出发。', pet: '靠近你，轻轻点头回应。', feed: '接住能量果，补充探险能量。', wash: '星露扫过护具，水珠闪出清亮的光。', train: '跃起接住训练球，留下明亮的轨迹。', celebrate: '开启能量光环，庆祝新的成长。', unlock: '展开星图，发现新的航线。' };
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function p(d, fill, stroke, width, extra) { return '<path d="' + d + '" fill="' + (fill || 'none') + '"' + (stroke ? ' stroke="' + stroke + '" stroke-width="' + (width || 1.5) + '"' : '') + (extra ? ' ' + extra : '') + '/>'; }
  function e(x, y, rx, ry, fill, extra) { return '<ellipse cx="' + x + '" cy="' + y + '" rx="' + rx + '" ry="' + ry + '" fill="' + fill + '"' + (extra ? ' ' + extra : '') + '/>'; }
  function c(x, y, r, fill, extra) { return e(x, y, r, r, fill, extra); }
  function g(body, cls, transform) { return '<g' + (cls ? ' class="' + cls + '"' : '') + (transform ? ' transform="' + transform + '"' : '') + '>' + body + '</g>'; }
  function poly(points, fill, stroke, width, extra) { return '<polygon points="' + points + '" fill="' + fill + '"' + (stroke ? ' stroke="' + stroke + '" stroke-width="' + (width || 1.5) + '"' : '') + (extra ? ' ' + extra : '') + '/>'; }
  function line(x1, y1, x2, y2, color, width, extra) { return p('M' + x1 + ' ' + y1 + 'L' + x2 + ' ' + y2, 'none', color, width, extra); }
  function paint(id, key) { return 'url(#' + id + '-' + key + ')'; }
  function defs(id, stage, sceneId) {
    var out = '', palettes = {
      jade: ['#b6f9c5', '#3ccdb2', '#176b78', '#0a344b'],
      leaf: ['#dcfdb2', '#81dcad', '#2a9b94', '#155a74'],
      crystal: ['#f1fff7', '#a2fbff', '#59adcf', '#2b557f'],
      belly: ['#fff4cc', '#cbd9a3', '#8fa879', '#4a716b'],
      ivory: ['#fffef3', '#e0edf0', '#8fabbc', '#415d77'],
      metal: ['#9aadb9', '#466177', '#1e354d', '#0d2135'],
      gold: ['#fff4c2', '#f9ce72', '#ce8b36', '#8d532a'],
      muzzle: ['#f8ddb3', '#dcb27c', '#b17c49', '#704729'],
      sky: ['#142a44', '#204360', '#34667c', '#7facae']
    }, key, arr;
    var skies = {
      forest: ['#102a38', '#20534f', '#397d69', '#9bb58b'],
      cave: ['#1a2148', '#373565', '#655487', '#a193b0'],
      cloud: ['#284e7c', '#5085a8', '#8abac8', '#e3e5ca'],
      camp: ['#202747', '#354669', '#776d8d', '#c99584'],
      harbor: ['#102f4d', '#295376', '#45929b', '#acd8ce'],
      aurora: ['#122d4b', '#28516b', '#5c9ba3', '#c9e2d8']
    };
    if (skies[sceneId]) { palettes.sky = skies[sceneId]; }
    if (stage === 4) { palettes.jade = ['#d2ffe8', '#51dacc', '#267aa3', '#132c55']; palettes.leaf = ['#e5ffce', '#91f6d3', '#42bdc8', '#23567d']; }
    if (stage === 5) { palettes.jade = ['#e3ffed', '#87edd4', '#2596aa', '#173461']; palettes.leaf = ['#efffe7', '#b5ffda', '#50cfc9', '#2c6990']; }
    for (key in palettes) {
      if (Object.prototype.hasOwnProperty.call(palettes, key)) {
        arr = palettes[key];
        out += '<linearGradient id="' + id + '-' + key + '" x1="0" y1="0" x2=".82" y2="1"><stop offset="0" stop-color="' + arr[0] + '"/><stop offset=".32" stop-color="' + arr[1] + '"/><stop offset=".76" stop-color="' + arr[2] + '"/><stop offset="1" stop-color="' + arr[3] + '"/></linearGradient>';
      }
    }
    out += '<radialGradient id="' + id + '-fur" cx=".3" cy=".22" r=".92"><stop offset="0" stop-color="#f1cc92"/><stop offset=".44" stop-color="#c69359"/><stop offset=".77" stop-color="#916036"/><stop offset="1" stop-color="#48372c"/></radialGradient>';
    out += '<radialGradient id="' + id + '-energy" cx=".35" cy=".3" r=".7"><stop offset="0" stop-color="#f1ffec"/><stop offset=".22" stop-color="#b6ffdc"/><stop offset=".66" stop-color="#49dbc4"/><stop offset="1" stop-color="#207e9b"/></radialGradient>';
    out += '<linearGradient id="' + id + '-glass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e5ffff" stop-opacity=".46"/><stop offset=".34" stop-color="#9de8ff" stop-opacity=".1"/><stop offset=".76" stop-color="#b6f9ff" stop-opacity=".025"/><stop offset="1" stop-color="#87d6eb" stop-opacity=".26"/></linearGradient>';
    out += '<clipPath id="' + id + '-scene-clip"><rect width="460" height="400" rx="24"/></clipPath>';
    return '<defs>' + out + '</defs>';
  }
  function diamond(x, y, size, id, color) {
    return g(poly('0,-18 13,-3 8,13 -8,13 -13,-3', paint(id, color || 'crystal'), '#295b70', 1.4) + poly('0,-18 0,9 -13,-3', '#e7ffff', '', 0, 'opacity=".62"') + line(0, -18, 8, 13, '#c3fbff', 1), '', 'translate(' + x + ' ' + y + ') scale(' + size + ')');
  }
  function rivet(x, y) { return c(x, y, 2.6, '#162c41') + c(x - .5, y - .6, 1.1, '#bfd6df'); }
  function eye(x, y, rx, ry, reaction, amber) {
    var out;
    if (reaction === 'pet' || reaction === 'wash' || reaction === 'feed') {
      out = p('M' + (x - rx) + ' ' + (y + 1) + 'Q' + x + ' ' + (y - ry * .85) + ' ' + (x + rx) + ' ' + (y + 1), 'none', '#122d35', 4.1);
    } else {
      out = e(x, y, rx + 2.5, ry + 2.1, '#15313b') + e(x, y, rx, ry, amber ? '#e8bc61' : '#eaf7db') + e(x + 2, y + 1, rx * .53, ry * .82, '#112b39') + e(x - rx * .33, y - ry * .35, rx * .29, ry * .28, '#ffffff');
      out += p('M' + (x - rx - 4) + ' ' + (y - ry - 1) + 'Q' + x + ' ' + (y - ry - 6) + ' ' + (x + rx + 3) + ' ' + (y - ry + 1), 'none', '#15313b', 3.1);
    }
    return g(out, 'pet-eye');
  }
  function youngDragon(id, reaction, stage) {
    var baby = stage === 1, body = '', head = '', back = '', gear = '';
    body += g(baby ? p('M184 303 Q136 271 118 295 C99 321 144 344 178 331 L201 319Z', paint(id, 'jade'), '#1b5a65', 2.2) + p('M122 300 Q123 320 160 323', 'none', '#baedc3', 4) : p('M191 278 C141 293 105 251 93 235 C76 214 51 231 65 253 C91 287 131 321 182 315Z', paint(id, 'jade'), '#174e61', 2.2), 'pet-tail');
    body += g(baby ? p('M183 230 Q148 221 139 187 Q169 184 194 215Z', paint(id, 'leaf'), '#286f6e', 2) + p('M277 220 Q292 187 318 185 Q317 214 288 237Z', paint(id, 'leaf'), '#286f6e', 2) : p('M190 216 C150 199 122 165 119 119 C158 127 185 164 203 201Z', paint(id, 'leaf'), '#215f6d', 2) + p('M122 124 L186 205 M149 143 L154 170 M168 163 L168 187', 'none', '#e1f6c6', 2) + p('M283 212 Q305 158 340 155 Q335 194 297 234Z', paint(id, 'leaf'), '#215f6d', 2), 'pet-wing');
    if (baby) {
      body += p('M192 276 Q159 292 151 328 L126 350 Q117 367 140 372 L186 373 Q208 370 210 350 L221 304Z', paint(id, 'jade'), '#175365', 2.2) + p('M251 280 Q288 285 299 322 L323 350 Q337 367 315 373 L275 374 Q250 372 249 349 L239 310Z', paint(id, 'jade'), '#175365', 2.2);
      body += p('M178 225 Q163 257 180 297 Q201 331 239 333 Q280 325 290 282 Q293 246 272 222Z', paint(id, 'jade'), '#175365', 2.3);
      body += p('M203 226 Q187 260 207 299 Q226 319 253 302 Q276 274 260 233Z', paint(id, 'belly'));
    } else {
      body += p('M193 273 Q163 287 164 324 L145 352 Q139 369 155 373 L197 371 Q213 367 205 347 L209 311 L227 286Z', paint(id, 'jade'), '#175365', 2.2) + p('M255 273 Q283 286 289 316 L297 347 Q319 351 319 366 Q315 375 275 373 Q258 371 257 350 L243 310Z', paint(id, 'jade'), '#175365', 2.2);
      body += p('M203 175 Q176 197 179 245 C179 286 200 324 237 324 C278 324 289 281 285 240 Q282 199 259 178Z', paint(id, 'jade'), '#17485d', 2.3) + p('M215 183 Q199 217 203 260 Q210 299 239 300 Q264 290 266 252 Q270 213 253 183Z', paint(id, 'belly'));
    }
    body += p(baby ? 'M135 358 L132 368 L144 370 L150 359 M159 360 L157 371 L170 370 L174 359 M288 360 L290 372 L303 372 L301 359 M311 356 L315 367 L326 364 L320 355' : 'M151 360 L149 369 L160 370 L165 359 M177 359 L174 371 L186 371 L191 358 M280 360 L283 372 L295 371 L292 358 M301 357 L306 369 L315 366 L309 356', '#e4f4ce', '#497c77', 1.2);
    head += poly(baby ? '222,83 222,40 244,60 246,87' : '213,76 197,43 221,53 230,77', paint(id, 'crystal'), '#2b6a7b', 1.8);
    if (!baby) { head += poly('248,72 247,39 269,56 273,80', paint(id, 'crystal'), '#2b6a7b', 1.8); }
    head += p(baby ? 'M184 131 Q147 122 151 92 Q181 94 199 118Z' : 'M202 108 Q169 105 167 77 Q194 77 211 100Z', paint(id, 'leaf'), '#2a696d', 2);
    head += p(baby ? 'M173 113 C160 80 182 57 219 59 C250 55 278 77 285 105 L321 118 C350 124 360 145 346 168 Q328 189 294 183 Q275 211 231 212 C186 209 165 169 173 113Z' : 'M193 109 C184 81 207 59 238 61 C267 54 294 75 298 96 L329 109 C352 117 359 135 345 151 Q323 168 281 161 L256 180 Q216 176 199 148Z', paint(id, 'jade'), '#17485d', 2.5);
    head += p(baby ? 'M181 106 Q180 76 212 69 Q231 66 250 78 L211 88 L197 118Z' : 'M202 98 Q206 73 237 69 L260 76 L225 89 L216 108Z', '#c5f5cf', '', 0, 'opacity=".65"');
    head += p(baby ? 'M278 130 Q305 114 332 133 Q354 151 333 168 Q306 181 280 168 Q267 153 278 130Z' : 'M272 125 Q298 109 330 124 Q352 140 334 154 Q310 166 279 153Z', paint(id, 'belly'), '#5d8d78', 1.2);
    head += eye(baby ? 217 : 234, baby ? 131 : 116, baby ? 11 : 10, baby ? 15 : 13.5, reaction, true) + eye(baby ? 282 : 288, baby ? 137 : 121, 5.4, 7.4, reaction === 'train' ? 'pet' : reaction, true);
    head += e(327, baby ? 149 : 138, 4.1, 2.7, '#436859') + e(339, baby ? 154 : 143, 2.5, 1.8, '#436859');
    head += g(p(baby ? 'M296 164 Q316 175 335 160 Q324 181 310 176Z' : 'M293 147 Q315 159 336 146 Q324 165 309 158Z', '#1d4a51') + poly(baby ? '315,169 321,169 320,175' : '317,153 323,151 322,158', '#f7ffe3'), 'pet-jaw');
    head += p(baby ? 'M192 159 L198 161 M189 169 L195 171' : 'M211 139 L217 142 M209 147 L215 150', 'none', '#2d7780', 2);
    body += g(head, 'pet-head-motion');
    body += g(p('M187 215 Q161 220 155 247 L149 274 Q149 291 164 293 Q181 290 184 273 L201 239Z', paint(id, 'jade'), '#17485d', 2.1) + p('M153 275 L158 286 M162 273 L167 289 M172 271 L177 282', 'none', '#b7eac8', 2), 'pet-arm-back');
    body += g(p('M272 215 Q292 215 302 236 L320 247 Q339 249 334 264 Q329 276 315 269 L288 250 Q270 240 266 224Z', paint(id, 'jade'), '#17485d', 2.1) + p('M322 252 L329 259 M314 257 L322 268', 'none', '#c9f2cf', 2), 'pet-arm-front');
    if (baby) {
      back += poly('113,321 132,331 138,319 156,339 150,361 125,355 107,339', paint(id, 'ivory'), '#7dabb1', 1.6) + poly('320,332 334,319 347,336 337,356 317,357', paint(id, 'ivory'), '#7dabb1', 1.6);
      gear += p('M201 221 Q231 240 265 219', 'none', '#dcb15c', 3.1) + diamond(234, 238, .48, id, 'gold');
    } else {
      back += p('M158 209 L181 191 L198 208 L192 259 L169 270 L151 251Z', paint(id, 'metal'), '#24485c', 2) + poly('158,225 176,216 178,248 158,255', paint(id, 'gold'), '#4b6971', 1.1);
      gear += p('M199 185 L214 179 L268 258 L258 269Z', paint(id, 'metal'), '#25495b', 1.7) + p('M257 185 L270 191 L209 263 L196 257Z', paint(id, 'metal'), '#25495b', 1.7) + diamond(232, 226, .65, id, 'gold');
      gear += p('M187 281 Q229 297 283 278 L285 290 Q231 311 190 295Z', '#31566c', '#25465b', 1.4) + poly('222,294 241,292 243,304 224,307', paint(id, 'gold'), '#486477', 1.1);
    }
    return { body: body, back: back, gear: gear };
  }
  function youngCapybara(id, reaction, stage) {
    var baby = stage === 1, body = '', head = '', back = '', gear = '';
    if (baby) {
      body += p('M194 281 Q159 296 151 331 L134 349 Q128 368 149 374 L194 372 Q211 366 213 346 L228 307Z', paint(id, 'fur'), '#5c432d', 2.2) + p('M252 279 Q290 286 301 321 L326 349 Q335 367 313 374 L273 373 Q250 367 248 345 L238 307Z', paint(id, 'fur'), '#5c432d', 2.2);
      body += p('M184 209 Q167 238 175 281 C180 312 204 334 240 331 C275 329 296 303 293 271 Q294 234 271 212Z', paint(id, 'fur'), '#5c432d', 2.4) + p('M204 218 Q188 253 206 290 Q225 314 252 295 Q272 268 260 230Z', paint(id, 'muzzle'));
    } else {
      body += p('M192 275 Q171 295 172 323 L156 350 Q150 367 167 374 L205 371 Q216 367 212 349 L216 312 L234 289Z', paint(id, 'fur'), '#5b432d', 2.2) + p('M252 274 Q280 287 286 318 L294 349 Q314 353 312 367 Q304 375 275 373 Q258 371 256 349 L240 308Z', paint(id, 'fur'), '#5b432d', 2.2);
      body += p('M194 178 Q171 200 175 246 C175 287 198 321 234 323 C270 322 288 288 289 253 Q291 207 265 181Z', paint(id, 'fur'), '#5b432d', 2.3) + p('M208 189 Q196 226 203 269 Q215 302 243 298 Q269 277 269 236 L256 195Z', paint(id, 'muzzle'));
    }
    body += p(baby ? 'M146 355 L150 369 M158 355 L164 370 M174 355 L179 368 M285 355 L288 369 M298 354 L302 369 M310 353 L317 365' : 'M167 358 L171 370 M180 357 L184 370 M193 357 L198 367 M275 358 L279 371 M287 356 L291 370 M301 356 L305 366', 'none', '#7c5537', 2);
    head += e(baby ? 184 : 191, 65, baby ? 23 : 19, 25, paint(id, 'fur'), 'stroke="#755232" stroke-width="2.1"') + e(baby ? 289 : 284, 64, baby ? 21 : 18, 24, paint(id, 'fur'), 'stroke="#755232" stroke-width="2.1"');
    head += e(baby ? 184 : 191, 65, 11, 14, '#b88658') + e(baby ? 289 : 284, 64, 9.5, 12.5, '#b88658');
    head += p(baby ? 'M162 115 C157 78 183 60 222 59 C260 54 295 74 300 105 L323 119 C351 127 359 147 346 167 Q324 189 291 185 Q271 209 230 210 C183 209 158 174 162 115Z' : 'M175 107 C167 77 190 57 225 58 C258 51 287 70 296 94 L315 111 C343 117 358 135 348 155 Q330 179 291 172 Q263 189 224 181 C188 174 171 144 175 107Z', paint(id, 'fur'), '#5a412e', 2.5);
    head += p(baby ? 'M173 109 Q175 76 212 69 Q235 63 254 78 L211 88 L192 119Z' : 'M184 100 Q186 72 219 67 L244 71 L211 85 L199 111Z', '#f3d5a3', '', 0, 'opacity=".7"');
    head += p(baby ? 'M276 132 Q304 116 332 133 Q353 149 338 168 Q315 186 284 171 Q266 156 276 132Z' : 'M269 126 Q292 109 323 122 Q350 136 338 155 Q317 177 282 162 Q259 148 269 126Z', paint(id, 'muzzle'), '#aa8052', 1.1);
    head += eye(baby ? 209 : 215, baby ? 132 : 118, baby ? 9 : 8, baby ? 11.5 : 10.5, reaction, false) + eye(baby ? 280 : 276, baby ? 137 : 123, 5.3, 7.3, reaction === 'train' ? 'pet' : reaction, false);
    head += e(327, baby ? 150 : 143, 5.3, 3.8, '#755034') + e(340, baby ? 155 : 147, 3.3, 2.5, '#755034');
    head += g(p(baby ? 'M300 168 Q316 179 332 164' : 'M297 158 Q313 170 333 155', 'none', '#755034', 2.9), 'pet-jaw');
    head += p(baby ? 'M182 163 L188 166 M182 173 L187 175' : 'M190 145 L196 148 M190 153 L195 155', 'none', '#ae7e4d', 1.6);
    body += g(head, 'pet-head-motion');
    body += g(p('M185 215 Q160 221 154 246 L147 272 Q146 288 162 293 Q177 290 182 272 L201 234Z', paint(id, 'fur'), '#5a412e', 2.2) + p('M151 273 L156 285 M161 272 L166 288 M171 271 L176 281', 'none', '#e1bd89', 1.8), 'pet-arm-back');
    body += g(p('M271 215 Q292 217 303 238 L320 247 Q338 251 332 265 Q326 277 314 270 L288 250 Q272 238 266 224Z', paint(id, 'fur'), '#5a412e', 2.2) + p('M321 252 L327 260 M313 257 L321 268', 'none', '#dfbc8c', 1.8), 'pet-arm-front');
    if (baby) {
      gear += p('M198 221 Q229 238 269 220 L263 268 Q231 286 203 267Z', paint(id, 'metal'), '#284b60', 1.8) + poly('220,243 238,237 254,250 245,264 228,264', paint(id, 'gold'), '#577182', 1.1) + line(226, 250, 242, 251, '#fff5c2', 2);
      back += p('M157 266 L169 254 L183 269 L182 298 L162 307 L148 293Z', paint(id, 'gold'), '#86623e', 1.4);
    } else {
      back += p('M156 197 L178 184 L199 206 L195 264 L165 274 L149 254Z', paint(id, 'metal'), '#29485b', 2) + poly('155,217 174,207 179,249 158,257', paint(id, 'gold'), '#567486', 1.2);
      gear += p('M192 183 L212 182 L231 212 L257 183 L274 190 L274 256 L251 279 L207 276 L185 251Z', paint(id, 'ivory'), '#3d5b6e', 1.8) + p('M213 186 L231 213 L258 188 L254 227 L237 235 L217 223Z', paint(id, 'metal'), '#3d5b6e', 1.3) + diamond(234, 221, .51, id, 'gold');
      gear += p('M192 178 Q226 195 274 177 L281 191 Q235 213 190 192Z', '#326b8b', '#244d68', 1.8) + p('M195 189 L177 218 L180 240 L207 211Z', paint(id, 'metal'), '#244d68', 1.4);
      gear += p('M181 282 Q233 300 284 281 L285 293 Q231 313 183 295Z', paint(id, 'metal'), '#24475d', 1.4) + poly('224,295 242,292 244,306 226,309', paint(id, 'gold'), '#38556b', 1.2);
      gear += g(p('M181 92 Q223 71 291 89', 'none', '#36586e', 6) + p('M204 77 L228 76 L233 91 L208 97Z', paint(id, 'glass'), '#a4d4df', 2.4) + p('M246 76 L272 81 L271 97 L248 94Z', paint(id, 'glass'), '#a4d4df', 2.4) + line(232, 84, 245, 85, '#94bac8', 4), 'pet-head-motion');
    }
    return { body: body, back: back, gear: gear };
  }
  function flightWings(id, stage) {
    var out;
    if (stage === 4) {
      out = p('M207 206 C164 185 104 146 78 81 Q69 149 102 195 Q136 229 193 233Z', paint(id, 'leaf'), '#2b687a', 2.2) + poly('78,81 139,136 167,207 108,177', '#ceffdb', '', 0, 'opacity=".48"') + p('M86 94 L195 219 M115 124 L118 172 M141 151 L149 196', 'none', '#ddfff0', 2.6);
      out += p('M282 203 C310 149 353 98 395 74 Q397 131 366 175 Q341 211 298 232Z', paint(id, 'crystal'), '#2b687a', 2.2) + poly('395,74 360,142 310,204 345,128', '#e0fff0', '', 0, 'opacity=".48"') + p('M387 87 L301 219 M367 123 L366 159 M343 150 L340 184', 'none', '#cbfff3', 2.5);
    } else {
      out = p('M208 209 Q154 177 120 112 L69 56 Q53 105 80 163 L50 151 Q61 201 111 224 Q155 242 194 232Z', paint(id, 'leaf'), '#245a73', 2.2) + poly('69,56 125,134 164,213 94,170', '#ecffd1', '', 0, 'opacity=".49"') + p('M72 71 L194 221 M95 102 L102 163 M121 140 L138 198 M64 170 L140 213', 'none', '#e7fff2', 2.6);
      out += p('M278 204 Q317 125 371 104 L414 60 Q427 109 393 162 L421 145 Q414 195 369 219 Q330 241 296 231Z', paint(id, 'crystal'), '#245a73', 2.2) + poly('414,60 374,143 306,217 354,129', '#efffec', '', 0, 'opacity=".55"') + p('M409 75 L300 221 M382 110 L380 164 M351 145 L344 198 M406 168 L337 218', 'none', '#d6fff4', 2.6);
    }
    return g(out, 'pet-wing');
  }
  function raisedArm(id, kind) {
    return p('M275 203 Q294 200 304 215 L323 202 Q340 188 349 201 Q354 216 339 224 L310 239 Q292 244 279 230Z', paint(id, kind === 'plant' ? 'jade' : 'fur'), kind === 'plant' ? '#16465c' : '#60482f', 2.2) + p('M331 202 L340 207 M328 210 L338 217 M320 216 L328 223', 'none', kind === 'plant' ? '#c6f4d5' : '#e5c797', 2);
  }
  function raisedBracer(id) {
    return g(p('M297 214 L310 210 L329 217 L323 236 L304 245 L290 233Z', paint(id, 'metal'), '#193c54', 1.9) + poly('301,217 311,214 321,220 317,232 306,238 297,230', paint(id, 'ivory'), '#69899c', 1.2) + line(306, 220, 316, 223, '#a9ffe4', 2.5), 'pet-arm-front');
  }
  function advancementGear(id, kind, stage) {
    var back = '', front = '', color = stage === 5 ? 'gold' : 'ivory';
    back += p('M144 174 L164 159 L178 175 L180 251 L164 274 L142 257Z', paint(id, 'metal'), '#15364e', 2.1) + poly('146,185 158,176 162,242 148,250', paint(id, color), '#476b7d', 1.3) + e(161, 269, 13, 7, '#193d53', 'stroke="#9dcbd1" stroke-width="1.7"') + e(161, 268, 8, 4, paint(id, 'energy'));
    back += p('M298 174 L317 165 L332 180 L330 251 L315 273 L297 256Z', paint(id, 'metal'), '#15364e', 2.1) + poly('311,180 324,186 323,244 309,250', paint(id, color), '#476b7d', 1.3) + e(315, 269, 13, 7, '#193d53', 'stroke="#9dcbd1" stroke-width="1.7"') + e(315, 268, 8, 4, paint(id, 'energy'));
    if (kind === 'capybara') {
      back += poly('145,179 116,125 107,157 120,225 144,240', paint(id, 'ivory'), '#365d73', 1.8) + poly('332,180 365,123 377,158 359,225 333,239', paint(id, 'ivory'), '#365d73', 1.8) + poly('115,147 129,166 139,211 126,199', paint(id, 'energy')) + poly('368,147 351,169 341,211 355,199', paint(id, 'energy'));
      back += p('M121 146 L124 116 M362 144 L361 114', 'none', '#a9d4dc', 2.4) + c(124, 113, 4, paint(id, 'gold')) + c(361, 111, 4, paint(id, 'gold'));
    }
    front += p('M177 193 L190 178 L212 184 L213 202 L183 215Z', paint(id, color), '#31566d', 1.8) + p('M262 183 L281 177 L295 190 L290 212 L268 203Z', paint(id, color), '#31566d', 1.8) + line(185, 192, 202, 187, '#f0ffe4', 2.4) + line(273, 186, 283, 190, '#f0ffe4', 2.4);
    front += poly('206,256 216,250 220,269 211,277 202,270', paint(id, 'metal'), '#426779', 1.3) + poly('252,253 264,249 272,268 263,276 255,270', paint(id, 'metal'), '#426779', 1.3) + line(209, 258, 213, 267, '#85ecd6', 2.1) + line(261, 257, 265, 267, '#85ecd6', 2.1);
    if (stage === 5) {
      back += p('M132 147 Q126 108 171 93 M303 89 Q352 106 353 146 M128 260 Q146 299 172 303 M309 302 Q349 284 353 256', 'none', '#adc5c6', 4) + p('M134 148 Q129 112 171 97 M303 93 Q348 108 349 146', 'none', '#b8ffe9', 1.8);
      front += p('M211 207 L233 193 L260 208 L261 239 L235 256 L208 240Z', 'none', '#dfb96b', 3.2) + poly('219,246 235,255 250,246 248,259 235,268 222,258', paint(id, 'gold'), '#4b6376', 1.5);
      front += p('M163 313 L182 309 L185 320 L168 324 M273 309 L290 313 L294 325 L277 321', 'none', '#e9c97f', 3.5);
      if (kind === 'capybara') { front += g(p('M165 94 Q158 54 196 38 M278 39 Q312 52 318 88', 'none', '#eccb80', 3.5), 'pet-head-motion'); }
    }
    return { back: back, gear: front };
  }
  function dragon(id, reaction, stage) {
    var body = '', head = '', back = '', gear = '', arm = '';
    /* Tail and leaf-wings are anatomy; all metal lives outside pet-character. */
    body += g(p('M186 278 C134 278 114 249 94 229 C77 212 55 218 60 234 C70 260 119 305 168 316 L200 301Z', paint(id, 'jade'), '#0c3d50', 2.2) + p('M62 227 C80 237 105 267 145 284 L177 293 L168 307 C123 292 81 266 62 241Z', '#83d0b3', '', 0, 'opacity=".7"') + poly('86,239 74,219 100,228 116,251', paint(id, 'crystal'), '#28768b', 1.5), 'pet-tail');
    body += stage >= 4 ? flightWings(id, stage) : g(p('M204 199 C164 168 124 133 111 79 C149 81 185 108 212 159 L220 186Z', paint(id, 'leaf'), '#1b6472', 2) + poly('111,79 165,115 176,166 147,140', '#d7f4b6', '', 0, 'opacity=".48"') + p('M117 87 L202 182 M146 107 L154 135 M172 122 L179 157', 'none', '#f1f8cf', 2.4) + p('M285 191 Q312 126 351 111 Q357 160 322 211Z', paint(id, 'jade'), '#17566c', 2) + poly('351,111 334,165 311,181', '#82e1b6', '', 0, 'opacity=".5"'), 'pet-wing');
    body += p('M192 264 Q159 283 157 326 L142 349 Q134 367 152 370 L197 369 Q212 364 206 350 L203 318 L220 290Z', paint(id, 'jade'), '#103e50', 2.2);
    body += p('M253 266 Q286 272 294 308 L301 345 Q320 350 318 365 Q311 375 272 370 Q258 367 256 350 L244 310Z', paint(id, 'jade'), '#103e50', 2.2);
    body += p('M149 355 L146 366 L156 367 L162 356 M175 357 L172 368 L183 368 L188 357 M282 358 L284 369 L294 369 L293 358 M300 357 L305 367 L314 365 L310 356', '#e9f4d1', '#436c6d', 1.2);
    body += p('M201 169 C178 187 175 225 182 267 C187 300 205 326 235 326 C272 324 287 297 288 262 C289 220 280 184 254 169Z', paint(id, 'jade'), '#123c50', 2.5);
    body += p('M214 176 C197 212 200 253 215 286 Q229 305 250 294 C267 269 269 220 253 180Z', paint(id, 'belly'));
    body += p('M187 211 Q190 184 206 177 L200 226 Q196 247 203 265 L190 257Z', '#78e4bc', '', 0, 'opacity=".52"');
    head += poly(stage === 5 ? '216,77 193,36 221,47 237,78' : '216,77 197,44 222,51 237,78', paint(id, 'crystal'), '#285d76', 1.6) + poly(stage >= 4 ? '248,71 243,26 267,46 276,81' : '248,71 246,37 267,52 276,81', paint(id, 'crystal'), '#285d76', 1.6);
    if (stage === 5) { head += poly('270,77 280,48 291,67 283,90', paint(id, 'gold'), '#315a6d', 1.5); }
    head += p('M204 111 Q172 105 171 75 Q199 77 216 101Z', paint(id, 'leaf'), '#215f6d', 2) + line(180, 83, 207, 104, '#dbf8bf', 2.5);
    head += p('M197 111 C184 85 202 58 235 57 C267 49 296 67 301 88 L331 100 C351 104 362 123 350 142 C338 158 302 164 273 157 L249 179 C224 174 204 157 199 135Z', paint(id, 'jade'), '#103b50', 2.6);
    head += p('M203 93 Q211 63 241 65 Q264 62 279 76 L245 80 L219 109Z', '#b8f2ca', '', 0, 'opacity=".7"');
    head += p('M271 112 C294 100 330 103 344 117 C357 129 342 146 322 152 L281 155 L263 143Z', paint(id, 'belly'), '#416e6c', 1.2);
    head += p('M279 117 Q310 107 335 120', 'none', '#f0f8ce', 4.5);
    head += p('M209 145 Q225 162 248 166 L269 151 L285 155 L251 179 Q225 174 209 153Z', '#0e5263', '', 0, 'opacity=".8"');
    head += eye(238, 111, 10, 13, reaction, true) + eye(291, 111, 5.2, 7.2, reaction === 'train' ? 'pet' : reaction, true);
    head += e(329, 122, 4.6, 2.8, '#335a58', 'transform="rotate(14 329 122)"') + e(342, 126, 2.9, 2.1, '#335a58');
    head += g(p('M291 138 Q314 147 336 136 Q324 154 308 150 Q299 147 291 138Z', '#143e4b') + poly('319,143 326,142 324,149', '#f7ffe8'), 'pet-jaw');
    head += p('M214 127 L219 129 M209 134 L214 136 M254 70 L260 76', 'none', '#18586a', 1.6);
    body += g(head, 'pet-head-motion');
    body += g(p('M194 205 Q173 210 162 239 L150 265 Q143 279 157 287 Q173 292 182 276 L199 251 L213 229Z', paint(id, 'jade'), '#133f50', 2.2) + p('M150 269 Q150 282 161 285 M160 266 L166 283 M171 263 L177 276', 'none', '#b1ead0', 2), 'pet-arm-back');
    arm += p('M275 201 Q296 202 305 223 L322 237 Q338 239 337 252 Q334 267 317 263 L289 245 Q272 238 266 220Z', paint(id, 'jade'), '#103b50', 2.2);
    arm += p('M324 241 L330 249 M317 248 L326 258 M311 253 L317 261', 'none', '#c8f4d3', 2);
    body += g(stage >= 4 ? raisedArm(id, 'plant') : arm, 'pet-arm-front');
    back += p('M171 175 L195 167 L211 211 L183 250 L161 233 L159 193Z', paint(id, 'metal'), '#102437', 2) + poly('165,191 176,178 185,181 174,225 163,230', paint(id, 'gold'), '#2d4252', 1.3);
    back += c(178, 206, 10, '#132e46') + c(178, 206, 6, paint(id, 'energy'));
    gear += p('M199 183 L221 174 L231 202 L256 181 L274 191 L269 228 L232 248 L197 224Z', paint(id, 'metal'), '#0e263b', 2.2);
    gear += poly('204,188 217,183 228,210 232,235 209,220', paint(id, 'ivory'), '#39556c', 1.2) + poly('253,190 264,194 259,219 236,234 237,211', paint(id, 'ivory'), '#39556c', 1.2);
    gear += diamond(232, 217, .74, id, 'energy') + rivet(209, 200) + rivet(259, 204);
    gear += p('M191 264 Q231 282 279 261 L280 278 Q230 299 193 281Z', paint(id, 'metal'), '#10283b', 2) + poly('223,275 244,274 245,290 225,292', paint(id, 'gold'), '#253c4c', 1.4) + line(228, 281, 239, 280, '#fff4bb', 2);
    gear += p('M166 313 L193 310 L201 333 L193 348 L164 342 L159 328Z', paint(id, 'metal'), '#102b40', 1.8) + poly('166,317 187,315 191,333 168,333', paint(id, 'ivory'), '#567488', 1.1) + line(171, 320, 186, 319, '#c7ffea', 2);
    gear += p('M270 313 L289 316 L298 338 L278 345 L264 332Z', paint(id, 'metal'), '#102b40', 1.8) + line(274, 321, 288, 324, '#7fe6d6', 2.7);
    gear += stage >= 4 ? raisedBracer(id) : g(p('M287 219 L306 226 L320 242 L305 254 L286 239Z', paint(id, 'metal'), '#102b40', 1.8) + poly('294,224 304,230 311,240 303,246 291,237', paint(id, 'ivory'), '#557386', 1.1) + line(297, 230, 306, 237, '#7bedd1', 2.5), 'pet-arm-front');
    return { body: body, back: back, gear: gear };
  }
  function capybara(id, reaction, stage) {
    var body = '', head = '', back = '', gear = '';
    body += p('M188 273 Q168 293 169 326 L162 350 Q154 367 170 371 L206 370 Q217 366 214 351 L211 310 L231 288Z', paint(id, 'fur'), '#523e2d', 2.1);
    body += p('M254 274 Q284 285 286 317 L291 349 Q309 354 307 366 Q304 374 268 371 Q254 366 252 350 L239 309Z', paint(id, 'fur'), '#523e2d', 2.1);
    body += p('M182 190 C161 222 168 270 182 293 Q205 328 241 321 C273 316 292 284 292 248 C291 212 275 187 251 177Z', paint(id, 'fur'), '#513c2c', 2.6);
    body += p('M201 204 Q184 237 201 279 Q216 303 245 292 Q269 264 258 214Z', paint(id, 'muzzle'));
    head += e(189, 63, 20, 23, paint(id, 'fur'), 'stroke="#62452d" stroke-width="2.3" transform="rotate(-20 189 63)"') + e(287, 65, 19, 22, paint(id, 'fur'), 'stroke="#62452d" stroke-width="2.3" transform="rotate(18 287 65)"');
    head += e(189, 63, 10, 13, '#b2835d', 'transform="rotate(-20 189 63)"') + e(287, 65, 9, 12, '#b2835d');
    head += p('M170 99 C168 69 192 56 222 57 C253 50 287 62 299 84 L311 110 C341 113 359 131 351 153 C341 176 313 184 280 177 Q248 194 208 177 C180 165 165 135 170 99Z', paint(id, 'fur'), '#5b422e', 2.6);
    head += p('M179 100 Q180 69 213 66 Q226 64 236 67 L211 79 L198 105Z', '#f2d49c', '', 0, 'opacity=".72"');
    head += p('M263 119 C281 105 321 110 341 124 C361 141 346 163 325 171 Q294 180 268 163 C250 153 250 131 263 119Z', paint(id, 'muzzle'), '#996f45', 1.2);
    head += p('M270 123 Q297 111 328 127', 'none', '#ffe6bd', 4.6);
    head += p('M179 140 Q191 166 217 169 L251 173 L270 165 Q251 184 217 178 Q192 173 181 157Z', '#795234', '', 0, 'opacity=".75"');
    head += eye(213, 115, 7.1, 9.5, reaction, false) + eye(272, 116, 5.3, 7.2, reaction === 'train' ? 'pet' : reaction, false);
    head += e(325, 138, 6.1, 4.1, '#69472d', 'transform="rotate(10 325 138)"') + e(341, 143, 3.9, 3, '#69472d');
    head += g(p('M299 156 Q312 166 330 154', 'none', '#6f4b2e', 3.1) + (reaction === 'train' || reaction === 'celebrate' ? p('M301 157 Q315 169 328 156 Q322 177 310 170Z', '#61422f') : ''), 'pet-jaw');
    head += p('M188 139 L194 142 M185 146 L192 149 M230 71 L233 77 M238 70 L240 76', 'none', '#90663f', 1.6);
    body += g(head, 'pet-head-motion');
    body += g(p('M180 205 Q160 211 152 239 L146 268 Q143 284 158 291 Q171 292 178 278 L190 248 L199 225Z', paint(id, 'fur'), '#553f2c', 2.2) + p('M149 270 L153 283 M157 269 L162 286 M166 267 L171 279', 'none', '#d6b382', 2), 'pet-arm-back');
    body += g(stage >= 4 ? raisedArm(id, 'capybara') : p('M279 204 Q299 207 305 226 L319 243 Q335 248 331 263 Q327 275 314 270 L290 251 Q278 240 268 223Z', paint(id, 'fur'), '#553f2c', 2.2) + p('M322 247 L327 255 M316 253 L324 264 M309 256 L317 267', 'none', '#dfbd8e', 2), 'pet-arm-front');
    back += p('M155 180 L182 165 L204 181 L201 258 L168 274 L145 254Z', paint(id, 'metal'), '#142d43', 2.5);
    back += p('M151 196 L171 190 L173 248 L155 254Z', paint(id, 'ivory'), '#3b5c72', 1.7) + poly('149,214 171,207 171,230 148,236', paint(id, 'gold'), '#3e5260', 1.4);
    back += e(161, 266, 13, 7, '#102942', 'stroke="#7897a7" stroke-width="2"') + e(161, 265, 8, 4, paint(id, 'energy'));
    back += p('M171 174 L169 132', 'none', '#7996a9', 4) + c(169, 128, 4.5, paint(id, 'energy'));
    gear += p('M181 188 L204 179 L238 188 L269 179 L288 196 L286 244 L276 281 Q231 304 184 277 L170 237Z', paint(id, 'ivory'), '#29475d', 2.3);
    gear += p('M177 211 L189 208 L194 255 L210 277 L187 275 L177 244Z', '#6d8fa1') + p('M263 193 L277 196 L275 259 L257 279 L250 264Z', '#f3f5e9');
    gear += p('M190 191 L213 188 L237 202 L263 190 L275 196 L269 220 L241 232 L204 222Z', paint(id, 'metal'), '#1a354c', 1.8);
    gear += poly('215,211 237,200 259,213 255,235 235,246 215,233', paint(id, 'metal'), '#9db3bd', 1.6) + c(236, 223, 12.3, '#103449', 'stroke="#b0e8e4" stroke-width="2"') + c(236, 223, 8.2, paint(id, 'energy'));
    gear += p('M214 252 L251 253 L256 275 L211 275Z', '#9bb2b8', '#647f90', 1.4) + line(219, 260, 246, 260, '#e9f7ed', 2.4) + line(222, 267, 244, 267, '#4b7188', 2);
    gear += p('M177 273 Q228 298 284 274 L287 291 Q237 313 181 294Z', paint(id, 'metal'), '#1a354c', 2) + poly('224,291 246,290 247,306 226,308', paint(id, 'gold'), '#263d4c', 1.3);
    gear += g(p('M151 238 L176 241 L184 267 L173 280 L149 272Z', paint(id, 'metal'), '#1b354a', 1.8) + poly('153,243 171,246 176,263 154,263', paint(id, 'ivory'), '#6d899b', 1.2) + line(158, 249, 170, 251, '#9be8db', 2.5), 'pet-arm-back');
    gear += stage >= 4 ? raisedBracer(id) : g(p('M289 224 L306 228 L322 245 L309 261 L288 245Z', paint(id, 'metal'), '#1b354a', 1.9) + poly('294,229 304,233 314,245 306,251 291,239', paint(id, 'ivory'), '#688597', 1.1) + line(297, 234, 307, 241, '#b1ffe4', 2.7), 'pet-arm-front');
    gear += p('M171 311 L209 315 L213 346 L226 358 L218 376 L157 376 L152 363 L163 346Z', paint(id, 'ivory'), '#29475d', 2.2) + p('M160 357 L203 356 L217 364 L214 373 L158 373Z', paint(id, 'metal'), '#29475d', 1.2) + line(170, 325, 203, 328, '#7b9baa', 3);
    gear += p('M256 314 L284 309 L291 345 L313 355 L313 372 L261 377 L251 366 L253 345Z', paint(id, 'ivory'), '#29475d', 2.2) + p('M259 356 L290 349 L309 358 L309 370 L264 373Z', paint(id, 'metal'), '#29475d', 1.2) + line(260, 326, 282, 323, '#7b9baa', 3);
    gear += line(165, 361, 201, 361, '#99f2db', 2.1) + line(268, 361, 295, 357, '#99f2db', 2.1);
    /* Transparent pressure dome: the organic head remains measurable beneath it. */
    gear += g(g(p('M157 99 C154 51 185 30 232 29 C277 25 317 48 324 91 L345 113 Q365 124 361 151 L345 179 Q300 204 237 193 Q184 194 162 160Z', paint(id, 'glass'), '#a1d1de', 2.5) + p('M171 85 Q180 46 222 43 M230 42 L245 42', 'none', '#eaffff', 5.4, 'opacity=".78"'), 'pet-faceplate') + p('M166 157 Q185 185 239 187 Q304 197 345 174 L350 188 Q310 211 239 203 Q184 202 159 173Z', paint(id, 'metal'), '#233e54', 2) + p('M169 170 Q191 192 239 192 Q296 201 335 185', 'none', '#b0d5da', 2.2) + poly('169,158 184,164 189,179 175,180 163,171', paint(id, 'gold'), '#294657', 1.5) + c(174, 169, 3, '#f6e2a6'), 'pet-head-motion');
    gear += rivet(189, 233) + rivet(274, 232) + rivet(180, 319) + rivet(272, 317);
    return { body: body, back: back, gear: gear };
  }
  function explorationEnvironment(id, sceneId) {
    var out = '<rect width="460" height="400" rx="24" fill="' + paint(id, 'sky') + '"/>', i;
    if (sceneId === 'forest') {
      out += p('M18 0 L70 0 L61 210 L83 335 L35 350 L42 204Z M392 0 L439 0 L423 219 L450 350 L405 346 L390 227Z', '#143c41');
      out += p('M0 31 Q53 40 88 0 L175 0 Q132 66 65 79 L0 77Z M339 0 Q387 44 460 18 L460 74 Q391 96 337 53Z', '#1c5b4c');
      out += p('M47 156 L100 105 L124 61 M405 146 L359 103 L337 65', 'none', '#2b6856', 11) + p('M51 162 L95 118 M409 151 L367 115', 'none', '#86c4a1', 2.5);
      out += p('M0 321 Q80 276 159 310 Q269 275 351 305 Q411 284 460 320 L460 400 L0 400Z', '#225047') + p('M0 351 Q123 327 226 348 Q335 322 460 347 L460 400 L0 400Z', '#376a54');
      out += p('M52 345 L55 321 M77 354 L81 336 M393 351 L397 321', 'none', '#b9d7a0', 4) + p('M32 322 Q54 292 76 322Z', '#e7c870', '#a5d5a6', 1.2) + p('M66 338 Q82 317 98 338Z', '#8fdfb2', '#c4f5c6', 1.2) + p('M376 323 Q396 295 419 323Z', '#a1e8ce', '#cbf3cf', 1.2);
      out += e(230, 368, 163, 19, '#568a67') + p('M104 372 Q137 354 170 365 M302 371 Q336 354 366 368', 'none', '#99c990', 2.2);
      for (i = 0; i < 9; i += 1) { out += c(40 + i * 47, 99 + (i % 3) * 77, 2.1, '#dbffd1') + c(40 + i * 47, 99 + (i % 3) * 77, 5.5, '#d7ffbb', 'opacity=".10"'); }
    } else if (sceneId === 'cave') {
      out += poly('0,0 460,0 460,155 421,109 379,81 360,32 301,48 260,19 204,56 150,28 116,76 62,86 0,166', '#202d4f') + poly('0,101 62,78 81,229 40,348 0,354', '#313f60') + poly('460,91 408,86 389,248 423,349 460,358', '#354367');
      out += poly('67,72 94,54 102,133 83,165', '#6a789b') + poly('370,36 395,64 381,146 363,104', '#63839e') + p('M0 342 L87 300 L161 331 L236 309 L332 330 L408 294 L460 338 L460 400 L0 400Z', '#3c4c66');
      out += poly('31,342 37,248 59,217 78,264 72,350', paint(id, 'crystal'), '#5ba4c4', 1.5) + poly('37,248 56,272 59,217', '#dbfbfa') + poly('54,349 83,286 101,272 109,321 86,355', paint(id, 'crystal'), '#5ba4c4', 1.4);
      out += poly('366,350 377,252 397,208 421,259 423,350', paint(id, 'crystal'), '#759ab7', 1.6) + poly('397,208 400,348 377,252', '#d2edec', '', 0, 'opacity=".4"') + poly('413,352 426,291 440,282 453,315 447,356', paint(id, 'crystal'), '#7a9bad', 1.5);
      out += e(230, 369, 163, 19, '#526780') + p('M98 369 L154 354 L207 369 L264 353 L326 370 L369 362', 'none', '#8fa8b0', 1.6) + diamond(104, 126, .4, id, 'crystal') + diamond(366, 176, .35, id, 'crystal');
    } else if (sceneId === 'cloud') {
      out += c(88, 73, 33, '#f5edc6', 'opacity=".7"') + p('M0 176 Q24 146 51 163 Q70 138 95 161 Q122 145 150 180Z M320 192 Q342 161 369 180 Q387 152 414 176 Q443 162 460 182 L460 210 L320 210Z', '#d3e6dc', '', 0, 'opacity=".75"');
      out += p('M0 253 Q55 229 117 246 Q196 225 270 249 Q370 222 460 248 L460 328 L0 328Z', '#a1c9cb') + p('M0 303 Q80 276 170 297 Q276 274 356 300 Q427 275 460 296 L460 400 L0 400Z', '#d6e5d4');
      out += poly('24,249 107,247 83,293 52,308', '#5c938b') + e(64, 247, 45, 12, '#9bc9a6') + poly('364,237 440,239 416,282 387,292', '#698f91') + e(401, 237, 43, 12, '#b6d6b2');
      out += p('M61 246 L63 215 L76 207 M394 236 L396 207 L409 202', 'none', '#537e7c', 4) + p('M47 222 Q63 192 83 217 M382 212 Q398 189 418 207', '#8bb49a', '#6b9c83', 1.3);
      out += poly('72,369 388,369 354,400 108,400', '#527c83') + e(230, 367, 169, 21, '#91b8a3', 'stroke="#d2e7c4" stroke-width="2"') + e(230, 363, 148, 14, '#bad3b4');
      out += p('M22 90 Q51 75 73 86 M351 55 Q382 45 412 57', 'none', '#e9f3e5', 3, 'opacity=".6"');
    } else if (sceneId === 'camp') {
      out += p('M0 277 L71 238 L129 273 L200 249 L260 278 L330 234 L401 263 L460 241 L460 400 L0 400Z', '#34445f') + p('M0 332 L88 309 L167 329 L246 308 L320 334 L410 306 L460 326 L460 400 L0 400Z', '#665f70');
      out += p('M272 25 L222 65 M373 48 L340 75 M112 34 L85 55', 'none', '#c3dedc', 2.3) + c(220, 67, 3.5, '#ffedbc') + c(338, 77, 2.6, '#c9ffec');
      out += poly('24,343 67,282 117,341', '#cba472', '#6b6266', 1.7) + poly('67,282 70,341 117,341', '#9b775d') + poly('52,343 69,308 82,342', '#35475a') + line(30, 344, 109, 344, '#ead0a0', 2.1);
      out += p('M388 274 L426 256 L447 281 L431 311 L396 313 L380 294Z', '#858390', '#bec6c4', 1.7) + poly('393,274 421,262 411,288 384,294', '#a4adb1') + p('M420 271 L412 285 L424 296', 'none', '#b9f3de', 2.6);
      out += e(230, 369, 165, 19, '#8c8280') + e(61, 350, 17, 7, '#eac185', 'opacity=".42"') + p('M54 347 L54 328 Q62 319 69 328 L69 347Z', '#e7c384', '#6d6970', 1.7) + p('M57 332 L65 332 L65 342 L57 342Z', '#fff4c6');
      out += p('M367 334 L384 327 L400 340 L387 351Z', '#9d999d', '#bbb9ad', 1.3);
    } else if (sceneId === 'harbor') {
      out += c(373, 92, 47, '#74b4c4', 'opacity=".55"') + e(373, 93, 77, 16, 'none', 'stroke="#cbe4cf" stroke-width="4" transform="rotate(-23 373 93)" opacity=".72"') + e(373, 93, 84, 20, 'none', 'stroke="#8bbcc1" stroke-width="1.2" transform="rotate(-23 373 93)"');
      out += p('M0 289 Q112 264 229 281 Q352 259 460 283 L460 400 L0 400Z', '#245474') + p('M0 323 L77 323 M9 349 L104 349 M362 318 L453 318 M369 347 L460 347 M37 382 L102 382 M363 382 L429 382', 'none', '#79b4b6', 2, 'opacity=".6"');
      out += p('M32 303 L30 179 L47 149 L78 149 L92 178 L89 299 M375 293 L373 174 L390 142 L422 142 L437 174 L434 304', 'none', '#6f9cae', 6) + line(31, 185, 90, 185, '#b9d7d0', 2.5) + line(375, 181, 435, 181, '#b9d7d0', 2.5);
      out += poly('61,351 164,306 297,306 402,351 381,391 82,391', '#3b6879', '#95bebc', 2) + e(231, 366, 152, 18, '#234d64', 'stroke="#a2d7d2" stroke-width="2"') + p('M92 370 L115 366 M347 366 L370 370 M215 386 L247 386', 'none', '#afffe0', 3);
      out += c(60, 174, 6, paint(id, 'energy')) + c(406, 167, 6, paint(id, 'energy')) + p('M64 141 L65 113 M403 134 L403 107', 'none', '#a1c7cd', 2);
    } else {
      out += p('M-20 109 C75-16 154 125 234 61 C315-2 364 56 483 3 L480 59 C367 112 307 44 240 110 C156 169 68 46-12 164Z', '#7fe1c4', '', 0, 'opacity=".32"') + p('M-15 132 C78 24 158 147 243 95 C313 49 390 96 478 34', 'none', '#c2ffe3', 4, 'opacity=".42"');
      out += p('M0 293 L93 198 L179 303 L250 224 L307 299 L382 202 L460 286 L460 400 L0 400Z', '#456e85') + poly('93,198 60,235 87,230 100,244 113,229', '#dfefdf') + poly('250,224 218,258 245,252 264,268 273,252', '#d5e6db') + poly('382,202 348,245 374,235 390,249 408,234', '#e3f1e2');
      out += p('M0 341 Q94 299 182 328 Q266 304 352 331 Q419 305 460 330 L460 400 L0 400Z', '#91b8ba') + e(231, 371, 178, 24, '#bddbd0') + e(231, 366, 155, 17, '#e0edda');
      out += p('M33 354 L51 327 L59 352 M391 353 L410 320 L422 350', '#abcfd2', '#d6e9de', 1.8) + diamond(66, 104, .31, id, 'crystal') + diamond(394, 139, .28, id, 'crystal');
    }
    if (sceneId !== 'forest' && sceneId !== 'cloud') { for (i = 0; i < 9; i += 1) { out += c(34 + i * 48, 47 + (i % 3) * 40, i % 2 ? 1.3 : 2, '#ddf8ed', 'opacity=".72"'); } }
    return '<g class="pet-environment" clip-path="url(#' + id + '-scene-clip)">' + out + '</g>';
  }
  function environment(id, sceneId) {
    if (sceneId !== 'home') { return explorationEnvironment(id, sceneId); }
    var out = '<rect width="460" height="400" rx="24" fill="' + paint(id, 'sky') + '"/>';
    out += c(394, 74, 51, '#8cb8c5', 'opacity=".23"') + p('M358 43 Q405 50 434 84 M352 60 Q397 71 436 100', 'none', '#bee8df', 7, 'opacity=".23"');
    out += p('M29 55 L411 37 L432 248 L28 253Z', 'none', '#99c3ca', 1.2, 'opacity=".34"');
    out += poly('40,53 75,51 197,334 108,352', '#e6f5d7', '', 0, 'opacity=".045"');
    out += p('M0 303 L78 278 L152 308 L203 284 L311 301 L410 266 L460 291 L460 400 L0 400Z', '#17394f');
    out += p('M0 341 L88 310 L174 334 L300 326 L409 300 L460 324 L460 400 L0 400Z', '#274b5c');
    out += e(231, 371, 188, 22, '#102c42') + e(231, 367, 170, 18, '#426b77', 'stroke="#8fbcbf" stroke-width="1.5"') + e(231, 366, 150, 13, '#315666');
    out += p('M70 363 L88 360 M355 360 L374 363 M213 383 L242 383', 'none', '#87f4d3', 3);
    out += p('M42 321 L42 289 L58 279 L61 316 M394 307 L395 277 L411 269 L414 299', 'none', '#82b2b5', 2, 'opacity=".6"');
    out += c(71, 101, 2, '#d8f7e9') + c(108, 43, 1.5, '#b3dedf') + c(341, 45, 1.4, '#d9f3e6') + c(397, 198, 1.9, '#bde5dc') + c(51, 215, 1.4, '#dff2da') + c(379, 247, 1.1, '#dbedda');
    return '<g class="pet-environment" clip-path="url(#' + id + '-scene-clip)">' + out + '</g>';
  }
  function energyFruit(id) {
    return p('M-6-14 Q-13-26-4-30 L2-16 Q6-28 15-25 Q16-15 5-11Z', paint(id, 'leaf'), '#2b6661', 1.5) + p('M-17-6 Q-12-20 2-14 Q15-18 23-5 C29 12 15 29 0 28 C-16 26-24 9-17-6Z', paint(id, 'gold'), '#9b642e', 1.5) + poly('-5,-9 8,-10 17,1 8,19 -7,17 -14,4', '#fff0a9', '', 0, 'opacity=".35"') + p('M-10-3 Q-13 4-8 11', 'none', '#fff7cf', 3.5);
  }
  function trainingBall(id) {
    return c(0, 0, 23, paint(id, 'gold'), 'stroke="#385a6d" stroke-width="2"') + p('M-22-6 Q-5-25 16-16 L22-6 Q2-18-18 9Z', paint(id, 'energy')) + p('M-19 12 Q0 2 22 5 L18 15 Q0 10-10 21Z', paint(id, 'ivory')) + p('M-6-22 Q12-9 7 3 Q2 15 5 22 M-23 0 Q-4-10 20-11 M-17 17 Q-2 5 22 8', 'none', '#45697a', 1.4) + p('M-13-12 Q-8-17-2-17', 'none', '#fff9d6', 3.7);
  }
  function dewBottle(id) {
    return p('M-8-20 L-8-29 L8-29 L8-20 L17-11 L17 17 Q0 32-17 17 L-17-11Z', paint(id, 'ivory'), '#4a7187', 1.7) + poly('-13,-5 0,-12 13,-5 13,15 0,23 -13,15', paint(id, 'energy'), '#4e9aa9', 1.3) + poly('-11,-29 11,-29 13,-22 -13,-22', paint(id, 'gold'), '#567685', 1.4) + p('M-7 0 L-7 12', 'none', '#eafff4', 3) + c(4, 4, 3, '#d9fff2') + c(7, 13, 2, '#bdffe8');
  }
  function effects(id, reaction) {
    var out = '', i;
    if (reaction === 'feed') {
      out += g(energyFruit(id), 'pet-snack-motion');
      out += g(p('M332 168 Q363 171 381 143 M340 187 Q368 193 391 177', 'none', '#ffe6a2', 3.4, 'stroke-dasharray="6 8"') + diamond(342, 157, .3, id, 'gold') + diamond(371, 181, .28, id, 'gold') + c(355, 194, 3, '#fff3c6'), 'pet-feed-burst');
      out += g(e(235, 223, 29, 26, 'none', 'stroke="#f4df9a" stroke-width="2.5"') + e(235, 223, 37, 32, 'none', 'stroke="#fff2b0" stroke-width="1.1" opacity=".6"'), 'pet-energy-pulse');
    } else if (reaction === 'wash') {
      out += g(g(dewBottle(id), '', 'translate(355 69) rotate(23) scale(.72)') + p('M341 82 Q299 87 281 111', 'none', '#b9ffff', 3, 'stroke-dasharray="7 6"'), 'pet-wash-drone');
      for (i = 0; i < 6; i += 1) { out += g(e(153 + i * 32, 134 + (i % 3) * 42, 7 + i % 3, 11, 'none', 'stroke="#b5f5ff" stroke-width="2"') + p('M' + (148 + i * 32) + ' ' + (129 + (i % 3) * 42) + 'l3-3', 'none', '#f2ffff', 2.4), 'pet-wash-drop pet-drop-' + i); }
      out += g(e(235, 236, 105, 25, 'none', 'stroke="#affaff" stroke-width="3"') + e(235, 239, 109, 26, 'none', 'stroke="#62bccb" stroke-width="1.2"'), 'pet-wash-sweep');
    } else if (reaction === 'train') {
      out += g(p('M386 321 Q356 230 322 190 Q245 248 94 332', 'none', '#6eeed7', 4, 'stroke-dasharray="10 9"') + p('M393 329 Q359 224 325 183', 'none', '#d2fff0', 1.7), 'pet-train-trail');
      out += g(poly('305,176 311,156 320,176 336,166 334,182 349,190 330,201 315,208 316,190 300,188', '#ddffe0', '', 0, 'opacity=".8"') + line(300, 162, 308, 172, '#b4ffe2', 2.5) + line(347, 172, 339, 180, '#8cdec9', 2.5), 'pet-train-impact');
      out += g(trainingBall(id), 'pet-ball-motion');
    } else if (reaction === 'pet') {
      out += g(p('M338 98 Q352 78 365 96 Q379 79 389 96 Q397 112 365 134 Q333 112 338 98Z', paint(id, 'energy'), '#a2f6e6', 1.2) + diamond(108, 149, .42, id, 'crystal') + diamond(356, 231, .34, id, 'gold'), 'pet-affection');
    } else if (reaction === 'celebrate' || reaction === 'unlock') {
      out += g(e(235, 202, 154, 149, 'none', 'stroke="#aaf3ed" stroke-width="2" opacity=".7"') + e(235, 202, 144, 139, 'none', 'stroke="#e5f5b2" stroke-width="4" stroke-dasharray="18 12"') + p('M73 204 L97 204 M373 204 L397 204 M235 44 L235 65 M235 339 L235 360', 'none', '#e5ffe5', 3), 'pet-victory-ring');
      for (i = 0; i < 7; i += 1) { out += g(diamond(83 + i * 47, i % 2 ? 87 : 286, .35 + (i % 3) * .13, id, i % 2 ? 'gold' : 'crystal'), 'pet-victory-shard pet-shard-' + i); }
      if (reaction === 'unlock') {
        out += g(poly('102,125 163,83 256,98 355,66 378,162 302,195 206,171 125,209', '#315e7b', '#acece7', 1.4, 'opacity=".9"') + p('M125 184 L176 108 L254 126 L340 94 L352 150 L294 171', 'none', '#d7f9cf', 2.6, 'stroke-dasharray="5 5"') + c(176, 108, 7, paint(id, 'energy')) + c(254, 126, 8, paint(id, 'gold')) + c(340, 94, 7, paint(id, 'energy')) + diamond(294, 171, .58, id, 'crystal'), 'pet-star-map');
      }
    }
    return g(out, 'pet-reaction-art');
  }
  function render(options) {
    var o = options && typeof options === 'object' ? options : {};
    var kind = o.kind === 'capybara' ? 'capybara' : 'plant';
    var stage = Number(o.stage);
    stage = isFinite(stage) ? Math.max(1, Math.min(5, Math.floor(stage))) : 1;
    var legacy = { water: 'wash', play: 'train', sun: 'pet' };
    var reaction = REACTIONS.indexOf(o.reaction) !== -1 ? o.reaction : (typeof o.reaction === 'string' && Object.prototype.hasOwnProperty.call(legacy, o.reaction) ? legacy[o.reaction] : 'idle');
    var name = typeof o.name === 'string' ? o.name.replace(/[\x00-\x1f\x7f]/g, '').replace(/^\s+|\s+$/g, '') : '';
    var framing = o.framing === 'hero' ? 'hero' : 'scene';
    var sceneId = typeof o.sceneId === 'string' && Object.prototype.hasOwnProperty.call(SCENES, o.sceneId) ? o.sceneId : 'home';
    var reduced = o.reducedMotion === true;
    var id = 'pet-v6-' + kind + '-' + stage + '-' + sceneId + '-' + reaction + '-' + framing;
    if (typeof o.instanceId === 'string') { id += '-' + o.instanceId.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24); }
    name = name || (kind === 'plant' ? '芽芽' : '团团');
    var title = name + ' · ' + STAGES[kind][stage - 1];
    var description = (kind === 'plant' ? '晶叶幼龙' : '太空探险水豚') + '，第' + stage + '阶段，身处' + SCENES[sceneId] + '。' + WORDS[reaction];
    var parts = kind === 'plant' ? (stage < 3 ? youngDragon(id, reaction, stage) : dragon(id, reaction, stage)) : (stage < 3 ? youngCapybara(id, reaction, stage) : capybara(id, reaction, stage));
    var advanced;
    if (stage >= 4) { advanced = advancementGear(id, kind, stage); parts.back += advanced.back; parts.gear += advanced.gear; }
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + (framing === 'hero' ? '0 0 460 400' : '0 0 600 340') + '" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" role="img" focusable="false" aria-label="' + esc(title + '。' + description) + '" class="pet-scene pet-v6 pet-stage-' + stage + ' pet-kind-' + kind + ' pet-framing-' + framing + ' pet-reaction-' + reaction + (reduced ? ' pet-reduced' : '') + '" data-pet-kind="' + kind + '" data-pet-stage="' + stage + '" data-pet-reaction="' + reaction + '" data-pet-framing="' + framing + '" data-pet-scene="' + sceneId + '" data-pet-reduced-motion="' + reduced + '" data-pet-reaction-duration="2700" stroke-linecap="round" stroke-linejoin="round">';
    svg += '<title>' + esc(title) + '</title><desc>' + esc(description) + '</desc>' + defs(id, stage, sceneId);
    if (framing === 'scene') { svg += '<rect width="600" height="340" rx="24" fill="' + paint(id, 'sky') + '"/>'; }
    svg += '<g' + (framing === 'scene' ? ' transform="translate(105 4) scale(.82)"' : '') + '>';
    svg += environment(id, sceneId) + e(234, 365, kind === 'plant' ? 90 : 83, 9, '#0a253b', 'opacity=".5"');
    svg += g(g(parts.back, 'pet-equipment pet-equipment-back') + g(parts.body, 'pet-character') + g(parts.gear, 'pet-equipment pet-equipment-front'), 'pet-actor');
    svg += effects(id, reaction) + '</g></svg>';
    return svg;
  }
  function renderItem(itemId, options) {
    var labels = { snack: '能量果', dew: '星露瓶', ball: '训练球' };
    if (typeof itemId !== 'string' || !Object.prototype.hasOwnProperty.call(labels, itemId)) { return ''; }
    var id = 'pet-v6-item-' + itemId, o = options && typeof options === 'object' ? options : {};
    if (typeof o.instanceId === 'string') { id += '-' + o.instanceId.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24); }
    var art = itemId === 'snack' ? energyFruit(id) : itemId === 'dew' ? dewBottle(id) : trainingBall(id);
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="100%" height="100%" role="img" focusable="false" aria-label="' + labels[itemId] + '" class="pet-item pet-item-' + itemId + '" stroke-linecap="round" stroke-linejoin="round"><title>' + labels[itemId] + '</title>' + defs(id, 3, 'home') + e(48, 82, 27, 5, '#264e63', 'opacity=".14"') + g(art, 'pet-item-art', 'translate(48 47) scale(1.2)') + '</svg>';
  }
  return { render: render, renderItem: renderItem };
}));
