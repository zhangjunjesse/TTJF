'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
(async () => {
  const [{ Workshop }, { makeCompanion }] = await Promise.all(['primitives', 'companions'].map(name => import(pathToFileURL(path.join(ROOT, 'farm', name + '.js')).href)));
  const rows = [];
  for (let stage = 1; stage <= 5; stage++) {
    const workshop = new Workshop(), pet = makeCompanion(workshop, 'plant', stage, 0, { quality: 'low', webgl2: true });
    const points = pet.frameProfile.points, padding = pet.frameProfile.motionPadding;
    const width = 493, height = 402, aspect = width / height, tanFov = Math.tan(38 * Math.PI / 360);
    const tilt = .2 / Math.hypot(.22, .2, 1), level = Math.sqrt(1 - tilt * tilt), pad = 8;
    const horizontal = tanFov * aspect * (1 - 2 * pad / width), top = tanFov * (1 - 2 * (35 + pad) / height), bottom = tanFov * (1 - 2 * (64 + pad) / height);
    const topSlope = tilt + level / top, bottomSlope = tilt - level / bottom, sideRadius = Math.hypot(level, 1 / horizontal);
    const limits = { top: { value: -Infinity }, bottom: { value: -Infinity }, side: { value: -Infinity } };
    for (let i = 0; i < points.length; i += 3) for (const padY of [-padding, padding]) {
      const y = (points[i + 1] + padY) * .72, radius = (Math.hypot(points[i], points[i + 2]) + padding) * .72;
      const values = { top: y * topSlope + radius * Math.abs(level - tilt / top), bottom: y * bottomSlope + radius * Math.abs(level + tilt / bottom), side: y * tilt + radius * sideRadius };
      for (const key of Object.keys(values)) if (values[key] > limits[key].value) limits[key] = { value: values[key], vertex: Array.from(points.subarray(i, i + 3)), index: i / 3, state: Math.floor((i / points.length) * 10), padY };
    }
    const topLimit = limits.top.value, bottomLimit = limits.bottom.value, sideLimit = limits.side.value;
    const centerY = Math.max((topLimit - bottomLimit) / (topSlope - bottomSlope), (sideLimit - bottomLimit) / (tilt - bottomSlope));
    const distance = Math.max(topLimit - topSlope * centerY, bottomLimit - bottomSlope * centerY, sideLimit - tilt * centerY);
    pet.root.updateMatrixWorld(true);
    const current = pet.measurePoints(false), correctBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (let i = 0; i < current.length; i += 3) for (let axis = 0; axis < 3; axis++) {
      correctBounds.min[axis] = Math.min(correctBounds.min[axis], current[i + axis]);
      correctBounds.max[axis] = Math.max(correctBounds.max[axis], current[i + axis]);
    }
    rows.push({ stage, profilePoints: points.length / 3, padding, bodyBounds: { min: pet.bodyBounds.min.toArray(), max: pet.bodyBounds.max.toArray() }, profileBounds: { min: pet.frameProfile.bounds.min.toArray(), max: pet.frameProfile.bounds.max.toArray() }, currentAfterFullMatrixUpdate: correctBounds, centerY, viewHeight: distance * tanFov * 2, limits });
    pet.dispose(); workshop.dispose();
  }
  fs.writeFileSync(path.join(__dirname, 'profile-probe.json'), JSON.stringify(rows, null, 2) + '\n');
  console.log(JSON.stringify(rows, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
