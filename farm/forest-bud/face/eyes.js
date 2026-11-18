import * as THREE from 'three';

// Every eye has its own tangent frame, a solid inset globe,
// and lids that meet that globe before fading back into the head surface.
const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;
const mix = THREE.MathUtils.lerp;
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const smooth = (a, b, value) => {
  const t = clamp((value - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function amberTexture() {
  const side = 256, data = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const dx = (x + .5) / side * 2 - 1;
      const dy = (y + .5) / side * 2 - 1;
      const r = Math.hypot(dx, dy), angle = Math.atan2(dy, dx);
      // Quiet, irregular radial fibres sit inside a continuous chestnut/amber
      // gradient. There are no concentric target rings around the pupil.
      const fibres = Math.sin(angle * 111 + Math.sin(angle * 13) * 1.7 + r * 17) * .030
        + Math.sin(angle * 193 - r * 29 + Math.sin(angle * 29)) * .016
        + Math.sin(angle * 67 + r * 9) * .013;
      const honey = Math.exp(-(((r - .68) / .26) ** 2));
      const lower = clamp(.46 - .48 * dy, 0, 1);
      const rim = smooth(.85, .995, r);
      const upperShade = 1 - .35 * smooth(-.20, .92, dy);
      const shade = upperShade * (1 + fibres) * (1 - .68 * rim);
      const offset = (y * side + x) * 4;
      data[offset] = clamp((130 + 49 * honey + 20 * lower) * shade, 0, 255);
      data[offset + 1] = clamp((70 + 34 * honey + 16 * lower) * shade, 0, 255);
      data[offset + 2] = clamp((31 + 10 * honey + 4 * lower) * shade, 0, 255);
      data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, side, side, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function mesh(name, geometry, material, shadow = true) {
  geometry.computeBoundingSphere();
  const object = new THREE.Mesh(geometry, material);
  object.name = name;
  object.castShadow = shadow;
  object.receiveShadow = true;
  return object;
}

function roundSweep(name, sample, radiusAt, material, segments = 48, sides = 8, colorAt, density=1) {
  segments=Math.max(12,Math.round(segments*density));sides=Math.max(5,Math.round(sides*density));
  const count = (segments + 1) * (sides + 1);
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = colorAt ? new Float32Array(count * 3) : null;
  const indices = [];
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < sides; j++) {
      const a = i * (sides + 1) + j, b = a + sides + 1;
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  if (colors) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  let colored = false;
  function refresh() {
    for (let i = 0; i <= segments; i++) {
      const t = i / segments, p = sample(t);
      const tangent = sample(Math.min(1, t + .001)).sub(sample(Math.max(0, t - .001))).normalize();
      const sideways = v3(-tangent.y, tangent.x, 0).normalize();
      if (sideways.lengthSq() < .01) sideways.set(1, 0, 0);
      const outward = tangent.clone().cross(sideways).normalize();
      const radius = radiusAt(t), color = colorAt && !colored ? colorAt(p) : null;
      for (let j = 0; j <= sides; j++) {
        const angle = j / sides * TAU;
        const normal = sideways.clone().multiplyScalar(Math.cos(angle)).addScaledVector(outward, Math.sin(angle));
        const index = (i * (sides + 1) + j) * 3;
        positions[index] = p.x + normal.x * radius;
        positions[index + 1] = p.y + normal.y * radius;
        positions[index + 2] = p.z + normal.z * radius;
        normals[index] = normal.x; normals[index + 1] = normal.y; normals[index + 2] = normal.z;
        if (color) { colors[index] = color.r; colors[index + 1] = color.g; colors[index + 2] = color.b; }
      }
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.normal.needsUpdate = true;
    if (colors && !colored) geometry.attributes.color.needsUpdate = true;
    colored = true;
    geometry.computeBoundingSphere();
  }
  refresh();
  return { mesh: mesh(name, geometry, material), refresh };
}

function curvedDisc(name, pointAt, material, rows = 16, columns = 80, density=1) {
  rows=Math.max(4,Math.round(rows*density));columns=Math.max(24,Math.round(columns*density));
  const positions = [], uv = [], indices = [];
  for (let i = 0; i <= rows; i++) {
    const radius = i / rows;
    for (let j = 0; j <= columns; j++) {
      const angle = j / columns * TAU;
      const x = radius * Math.cos(angle), y = radius * Math.sin(angle);
      const p = pointAt(x, y);
      positions.push(p.x, p.y, p.z);
      uv.push(x * .5 + .5, y * .5 + .5);
      if (i < rows && j < columns) {
        const a = i * (columns + 1) + j, b = a + columns + 1;
        indices.push(a, b, b + 1, a, b + 1, a + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return mesh(name, geometry, material, false);
}

export function makeEye(sign, materials, { skinZ, skinColor, low=false }) {
  const detailSweep=(name,sample,radiusAt,material,segments,sides,colorAt)=>
    roundSweep(name,sample,radiusAt,material,segments,sides,colorAt,low?.65:1);
  const disc=(name,pointAt,material,rows,columns)=>curvedDisc(name,pointAt,material,rows,columns,low?.6:1);
  const root = new THREE.Group();
  root.name = sign > 0 ? 'right inset amber almond eye' : 'left inset amber almond eye';
  const cx = sign * .320, cy = .641 + sign * .006;
  const center = v3(cx, cy, skinZ(cx, cy));
  const delta = .004;
  const slopeX = (skinZ(cx + delta, cy) - skinZ(cx - delta, cy)) / (2 * delta);
  const slopeY = (skinZ(cx, cy + delta) - skinZ(cx, cy - delta)) / (2 * delta);
  const normal = v3(-slopeX, -slopeY, 1).normalize();
  const horizontal = v3(1, 0, slopeX).normalize();
  const vertical = normal.clone().cross(horizontal).normalize();
  const tilt = sign * .090, cosine = Math.cos(tilt), sine = Math.sin(tilt);
  const axisX = horizontal.clone().multiplyScalar(cosine).addScaledVector(vertical, sine);
  const axisY = vertical.clone().multiplyScalar(cosine).addScaledVector(horizontal, -sine);
  root.position.copy(center);
  root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(axisX, axisY, normal));

  const headPoint = (x, y, depth = 0) => center.clone().addScaledVector(axisX, x).addScaledVector(axisY, y).addScaledVector(normal, depth);
  // Find the actual skin intersection along the eye normal. Using a tangent
  // frame rather than bending the globe over skinZ keeps the side view round.
  const skinDepth = (x, y) => {
    const base = headPoint(x, y);
    let depth = 0;
    for (let i = 0; i < 4; i++) {
      const point = base.clone().addScaledVector(normal, depth);
      const error = point.z - skinZ(point.x, point.y);
      if (Math.abs(error) < .000025) break;
      const ahead = point.clone().addScaledVector(normal, .001);
      const derivative = (ahead.z - skinZ(ahead.x, ahead.y) - error) / .001;
      depth = clamp(depth - error / Math.max(.24, derivative), -.22, .14);
    }
    return depth;
  };
  const colorAt = p => {
    const point = headPoint(p.x, p.y, p.z);
    return skinColor(point.x, point.y, 1);
  };

  const a = .195;
  const globeX = .266, globeY = .300, globeZ = .222, globeDepth = .161, globeCenterY = -.020;
  const globeFront = (x, y) => globeZ * Math.sqrt(Math.max(.008, 1 - (x / globeX) ** 2 - ((y - globeCenterY) / globeY) ** 2)) - globeDepth;
  const aperture = (x, upper, openness) => {
    const h = Math.pow(Math.max(0, 1 - (x / a) ** 2), .68);
    const closed = -.110 * h;
    const outerLift = upper ? .010 * openness * h * smooth(-.20, .90, sign * x / a) : 0;
    return closed + (upper ? .290 : -.052) * openness * h + outerLift;
  };
  let opening = .82;
  const openingUniform = { value: opening };
  const gazeUniform = { value: new THREE.Vector2() };
  const irisRoot = new THREE.Group();
  irisRoot.name = 'curved iris pupil and corneal reflections';
  root.add(irisRoot);
  const clipped = (source, movesWithGaze = false, lidShade = false) => {
    const material = source.clone();
    material.customProgramCacheKey = () => `bud-tangent-almond-v2-${sign}-${movesWithGaze ? 1 : 0}-${lidShade ? 1 : 0}`;
    material.onBeforeCompile = shader => {
      shader.uniforms.uBudEyeOpening = openingUniform;
      shader.uniforms.uBudEyeGaze = gazeUniform;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vBudEyePoint;\nuniform vec2 uBudEyeGaze;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>\nvBudEyePoint = position.xy${movesWithGaze ? ' + uBudEyeGaze' : ''};`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vBudEyePoint;\nuniform float uBudEyeOpening;')
        .replace('#include <color_fragment>', `
          float budX = vBudEyePoint.x / .195;
          float budRim = pow(max(0.0, 1.0 - budX * budX), .68);
          float budClosed = -.110 * budRim;
          float budTail = .010 * uBudEyeOpening * budRim * smoothstep(-.20, .90, budX * ${sign.toFixed(1)});
          float budUpper = budClosed + .290 * uBudEyeOpening * budRim + budTail;
          float budLower = budClosed - .052 * uBudEyeOpening * budRim;
          if (abs(budX) > 1.0 || uBudEyeOpening < .001 || vBudEyePoint.y > budUpper || vBudEyePoint.y < budLower) discard;
          #include <color_fragment>
          ${lidShade ? 'diffuseColor.rgb *= .68 + .32 * smoothstep(.004, .105, budUpper - vBudEyePoint.y);' : ''}`);
    };
    return material;
  };

  const scleraMaterial = clipped(materials.sclera);
  scleraMaterial.color.set('#f4ecdc');
  scleraMaterial.roughness = .52;
  scleraMaterial.clearcoat = .06;
  scleraMaterial.specularIntensity = .12;
  const globeGeometry = new THREE.SphereGeometry(1, low?40:80, low?28:56);
  globeGeometry.scale(globeX, globeY, globeZ);
  globeGeometry.translate(0, globeCenterY, -globeDepth);
  root.add(mesh('solid warm ivory eyeball recessed into skull', globeGeometry, scleraMaterial, false));

  const irisMaterial = clipped(materials.iris, true, true);
  irisMaterial.map = amberTexture();
  irisMaterial.color.set('#ffffff');
  irisMaterial.roughness = .69;
  irisMaterial.clearcoat = 0;
  irisMaterial.specularIntensity = .035;
  const pupilMaterial = clipped(materials.pupil, true, true);
  pupilMaterial.color.set('#160f0a');
  pupilMaterial.roughness = .78;
  pupilMaterial.clearcoat = 0;
  pupilMaterial.specularIntensity = .020;
  const irisX = -sign * .017, irisY = .027, irisRadius = .146;
  const onGlobe = (x, y, offset) => v3(x, y, globeFront(x, y) + offset);
  irisRoot.add(disc('large softly graduated chestnut amber iris', (x, y) => onGlobe(irisX + x * irisRadius, irisY + y * irisRadius, .0015), irisMaterial, 22, 96));
  irisRoot.add(disc('large rounded deep brown pupil', (x, y) => onGlobe(irisX + x * .074, irisY + y * .077, .0031), pupilMaterial, 12, 64));
  irisRoot.add(disc('single large corner catchlight', (x, y) => onGlobe(irisX - .046 + x * .013, irisY + .046 + y * .017, .0052), clipped(materials.glint, true), 8, 48));
  irisRoot.add(disc('single small corner catchlight', (x, y) => onGlobe(irisX + .041 + x * .0045, irisY - .038 + y * .0055, .0045), clipped(materials.glintSoft, true), 6, 32));
  irisRoot.children.forEach(object => {
    object.onBeforeRender = () => gazeUniform.value.set(irisRoot.position.x, irisRoot.position.y);
  });

  const lidMaterial = materials.lid.clone();
  lidMaterial.vertexColors = true;
  lidMaterial.side = THREE.DoubleSide;
  lidMaterial.roughness = .57;
  const rimMaterial = materials.skinRim.clone();
  rimMaterial.color.set('#ffffff');
  rimMaterial.vertexColors = true;
  const lashMaterial = materials.lash.clone();
  lashMaterial.color.set('#3b271d');
  lashMaterial.roughness = .77;
  const browMaterial = materials.brow.clone();
  browMaterial.color.set('#5b502d');
  browMaterial.roughness = .84;

  const columns = low?40:64, rows = low?6:8;
  // The lower edge follows the cheek instead of spanning a raised eye bag.
  // Project three blink poses once; animation only interpolates these depths.
  const marginSkin = [false, true].map(upper => [0, .82, 1].map(value => {
    const depths = [];
    for (let j = 0; j <= columns; j++) {
      const x = -Math.cos(j / columns * Math.PI) * a;
      depths.push(skinDepth(x, aperture(x, upper, value)));
    }
    return depths;
  }));
  const marginDepth = (t, upper) => {
    const sample = t * columns, j = Math.min(columns - 1, Math.floor(sample));
    const pose = opening <= .82 ? 0 : 1;
    const blend = pose === 0 ? opening / .82 : (opening - .82) / .18;
    const depths = marginSkin[upper ? 1 : 0];
    const low = mix(depths[pose][j], depths[pose + 1][j], blend);
    const high = mix(depths[pose][j + 1], depths[pose + 1][j + 1], blend);
    const skin = mix(low, high, sample - j);
    const x = -Math.cos(t * Math.PI) * a, y = aperture(x, upper, opening);
    return Math.max(globeFront(x, y) + .0035, skin + .0010);
  };
  const makeLid = upper => {
    const positions = new Float32Array((rows + 1) * (columns + 1) * 3);
    const colors = new Float32Array(positions.length), indices = [];
    const outer = [];
    for (let j = 0; j <= columns; j++) {
      const t = j / columns, angle = Math.PI * t;
      const x = -Math.cos(angle) * (a + (upper ? .027 : .016));
      const y = (upper ? .216 : -.178) * Math.sin(angle);
      outer.push(v3(x, y, skinDepth(x, y) + .0010));
    }
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < columns; j++) {
        const p = i * (columns + 1) + j, q = p + columns + 1;
        if (upper) indices.push(p, p + 1, q, q, p + 1, q + 1);
        else indices.push(p, q, p + 1, q, q + 1, p + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    const object = mesh(upper ? 'upper skin eyelid wrapping the eyeball' : 'lower skin eyelid blending into cheek', geometry, lidMaterial);
    root.add(object);
    let colored = false;
    return () => {
      for (let i = 0; i <= rows; i++) {
        const blend = i / rows;
        for (let j = 0; j <= columns; j++) {
          const angle = j / columns * Math.PI;
          const innerX = -Math.cos(angle) * a;
          const innerY = aperture(innerX, upper, opening);
          const innerZ = marginDepth(j / columns, upper);
          const outside = outer[j];
          const x = mix(innerX, outside.x, blend), y = mix(innerY, outside.y, blend);
          // A tiny fleshy fold rounds the margin. Its far edge is flush with
          // the real skin, so the eye has depth without a detached plate rim.
          const z = mix(innerZ, outside.z, upper ? smooth(0, 1, blend) : blend)
            + (upper ? .0035 : .0006) * Math.sin(blend * Math.PI) * Math.sin(angle) ** .55;
          const index = (i * (columns + 1) + j) * 3;
          positions[index] = x; positions[index + 1] = y; positions[index + 2] = z;
          if (!colored) {
            const color = colorAt(v3(x, y, z));
            color.multiplyScalar(upper ? .99 : 1.003);
            colors[index] = color.r; colors[index + 1] = color.g; colors[index + 2] = color.b;
          }
        }
      }
      geometry.attributes.position.needsUpdate = true;
      if (!colored) geometry.attributes.color.needsUpdate = true;
      colored = true;
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
    };
  };
  const refreshUpper = makeLid(true), refreshLower = makeLid(false);
  const margin = (t, upper, offset = 0) => {
    const x = -Math.cos(t * Math.PI) * a;
    const y = aperture(x, upper, opening);
    return v3(x, y, marginDepth(t, upper) + offset);
  };
  const upperRim = detailSweep('soft upper eyelid margin', t => margin(t, true, -.001), t => .0018 + .0048 * Math.sin(Math.PI * t) ** .7, rimMaterial, 64, 10, colorAt);
  const upperLine = detailSweep('soft chocolate upper eyelid line', t => margin(t, true, .0045), t => .0013 + .0068 * Math.sin(Math.PI * t) ** .65, lashMaterial, 64, 8);
  const lowerRim = detailSweep('thin flush lower eyelid margin', t => margin(t, false, .0003), t => .00065 + .00145 * Math.sin(Math.PI * t) ** .65, rimMaterial, 64, 8, colorAt);
  root.add(upperRim.mesh, upperLine.mesh, lowerRim.mesh);

  const lashSamples = Array.from({ length: 65 }, (_, i) => {
    const t = i / 64;
    const edgeX = sign * a * .94;
    const x = edgeX + sign * (.014 * t + .013 * t * t);
    return [0, 1].map(value => {
      const y = aperture(edgeX, true, value) + .011 * t + .020 * t * t;
      return skinDepth(x, y) + .007;
    });
  });
  const lashPoint = t => {
    const edgeX = sign * a * .94;
    const edgeY = aperture(edgeX, true, opening);
    const x = edgeX + sign * (.014 * t + .013 * t * t);
    const y = edgeY + .011 * t + .020 * t * t;
    const sampleIndex = t * 64, lower = Math.min(63, Math.floor(sampleIndex));
    const lowDepth = mix(lashSamples[lower][0], lashSamples[lower][1], opening);
    const highDepth = mix(lashSamples[lower + 1][0], lashSamples[lower + 1][1], opening);
    const surface = mix(lowDepth, highDepth, sampleIndex - lower);
    const edgeT = sign > 0 ? Math.acos(-.94) / Math.PI : Math.acos(.94) / Math.PI;
    const z = mix(marginDepth(edgeT, true) + .005, surface, t);
    return v3(x, y, z);
  };
  const lashTip = detailSweep('one short outer upper eyelash', lashPoint, t => .0061 * (1 - t) ** .8 + .00035, lashMaterial, 24, 8);
  root.add(lashTip.mesh);

  const browCurve = new THREE.CatmullRomCurve3([
    [-.153, .219], [-.076, .246], [.040, .247], [.173, .211],
  ].map(([x, y]) => {
    const px = x * sign;
    return v3(px, y, skinDepth(px, y) + .006);
  }));
  root.add(detailSweep('close gentle tapered eyebrow', t => browCurve.getPoint(t), t => .0015 + .0190 * Math.sin(Math.PI * t) ** .65 * (1 - .35 * t), browMaterial, 48, 10).mesh);

  const refresh = () => {
    refreshUpper(); refreshLower();
    upperRim.refresh(); upperLine.refresh(); lowerRim.refresh(); lashTip.refresh();
  };
  function blink(value = .82) {
    const next = Number.isFinite(value) ? clamp(value, 0, 1) : .82;
    if (root.userData.ready && Math.abs(next - opening) < .00001) return;
    opening = next;
    openingUniform.value = opening;
    refresh();
    root.userData.ready = true;
    root.userData.openness = opening;
  }
  root.userData.eyeFrame = { center: center.toArray(), normal: normal.toArray(), globeRadii: [globeX, globeY, globeZ], globeDepth, globeCenterY, irisRadius, pupilRadius: .074, apertureHalfWidth: a };
  blink(.82);
  return { root, blink, irisRoot };
}
