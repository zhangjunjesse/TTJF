// The approved Forest Bud Dragon tail, shared by the product companion factory.
// Y up, +Z front. The broad root is buried in the rump; the rest axis is -Z.
// All surfaces use one spline skeleton, including paint, leaf faces and veins.
import * as THREE from 'three';

const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const smooth = (value) => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

function interpolate(stops, t, field = 1) {
  if (t <= stops[0][0]) return stops[0][field];
  const last = stops.length - 1;
  if (t >= stops[last][0]) return stops[last][field];
  let i = 0;
  while (stops[i + 1][0] < t) i += 1;
  const a = stops[i], b = stops[i + 1];
  const before = stops[Math.max(0, i - 1)], after = stops[Math.min(last, i + 2)];
  const span = b[0] - a[0], u = (t - a[0]) / span;
  const m0 = (b[field] - before[field]) / (b[0] - before[0]);
  const m1 = (after[field] - a[field]) / (after[0] - a[0]);
  return (2*u*u*u - 3*u*u + 1)*a[field] + (u*u*u - 2*u*u + u)*m0*span
    + (-2*u*u*u + 3*u*u)*b[field] + (u*u*u - u*u)*m1*span;
}

function makeCurve(points) {
  const path = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5);
  path.arcLengthDivisions = 512;
  return path;
}

// The up vector is projected onto each section: no frame flip where the tail
// changes between descending and rising, and the cream underside stays below.
function makeSkin(path, material, skinColor, colors, low) {
  const radii = [[0,.218,.221],[.15,.200,.202],[.38,.152,.151],
    [.61,.107,.104],[.81,.066,.064],[1,.029,.030]];
  const frame = (t) => {
    const tangent = path.getTangentAt(t).normalize();
    const right = V(1,0,0).addScaledVector(tangent, -tangent.x).normalize();
    return { center: path.getPointAt(t), right, up: right.clone().cross(tangent).normalize() };
  };
  const sample = (t, angle, lift = 0) => {
    const at = clamp(t,0,1), { center, right, up } = frame(at);
    const ry = interpolate(radii,at,1), rx = interpolate(radii,at,2);
    const normal = up.clone().multiplyScalar(Math.cos(angle)/ry)
      .addScaledVector(right,Math.sin(angle)/rx).normalize();
    const point = center.addScaledVector(up,Math.cos(angle)*ry)
      .addScaledVector(right,Math.sin(angle)*rx).addScaledVector(normal,lift);
    return { point, normal };
  };
  const colorAt = (t, angle) => {
    const y = path.getPointAt(t).y + .65;
    const c = skinColor(y, angle);
    const underside = Math.atan2(Math.sin(angle-Math.PI),Math.cos(angle-Math.PI));
    const cream = Math.exp(-Math.pow(underside/.66,4));
    return c.lerp(colors.tailBelly,cream*.77*(1-smooth((t-.73)/.20)));
  };
  const positions = [], paint = [], indices = [], steps = low?56:100, sides = low?22:36;
  for (let i=0;i<=steps;i+=1) {
    const t=i/steps;
    for (let j=0;j<=sides;j+=1) {
      const a=j/sides*TAU, p=sample(t,a).point, c=colorAt(t,a);
      positions.push(p.x,p.y,p.z); paint.push(c.r,c.g,c.b);
      if (i<steps&&j<sides) {
        const n=i*(sides+1)+j;
        indices.push(n,n+1,n+sides+1,n+1,n+sides+2,n+sides+1);
      }
    }
  }
  for (const end of [0,1]) {
    const p=path.getPointAt(end), c=colorAt(end,0), center=positions.length/3;
    positions.push(p.x,p.y,p.z); paint.push(c.r,c.g,c.b);
    const row=end*steps*(sides+1);
    for(let j=0;j<sides;j+=1) {
      if(end)indices.push(center,row+j,row+j+1);
      else indices.push(center,row+j+1,row+j);
    }
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(paint,3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  const mesh=new THREE.Mesh(geometry,material);
  mesh.name='Continuous flexible round tail skin';
  mesh.castShadow=true; mesh.receiveShadow=true;
  return { mesh, sample };
}

// Cubic four-station weights share the same spatial map on every surface.
// Paint and vein vertices therefore stay attached through bends and shadow passes.
function skinGeometry(geometry, segments, stationCount) {
  const positions=geometry.getAttribute('position');
  const indices=new Uint16Array(positions.count*4), weights=new Float32Array(positions.count*4);
  const last=stationCount-1;
  for(let i=0;i<positions.count;i+=1) {
    const x=positions.getX(i),y=positions.getY(i),z=positions.getZ(i);
    let nearest=Infinity,at=0;
    for(let j=0;j<segments.length;j+=1) {
      const s=segments[j],dx=x-s.x,dy=y-s.y,dz=z-s.z;
      const t=clamp((dx*s.dx+dy*s.dy+dz*s.dz)/s.lengthSq,0,1);
      const ex=dx-t*s.dx,ey=dy-t*s.dy,ez=dz-t*s.dz,ds=ex*ex+ey*ey+ez*ez;
      if(ds<nearest) { nearest=ds; at=(j+t)/segments.length; }
    }
    const index=at*last,base=Math.floor(index),f=index-base,one=1-f,offset=i*4;
    indices[offset]=clamp(base-1,0,last); indices[offset+1]=clamp(base,0,last);
    indices[offset+2]=clamp(base+1,0,last); indices[offset+3]=clamp(base+2,0,last);
    weights[offset]=one*one*one/6;
    weights[offset+1]=(3*f*f*f-6*f*f+4)/6;
    weights[offset+2]=(-3*f*f*f+3*f*f+3*f+1)/6;
    weights[offset+3]=f*f*f/6;
  }
  geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(indices,4));
  geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weights,4));
}

export function makeTail({ root, tube, leaf, marking, skinPainted, colors, skinColor, low=false }) {
  const rig=new THREE.Group();
  rig.name='Living tail · continuous spline skeleton';
  rig.position.set(0,.65,-.43); root.add(rig);
  rig.userData.anchor=[0,.65,-.43];
  rig.userData.deformation='26 spline stations / cubic spatial weights / GPU skinning';

  const mainPoints=[V(0,0,0),V(0,-.024,-.20),V(.012,-.052,-.45),
    V(.032,-.047,-.74),V(.064,.012,-1.015),V(.088,.120,-1.235),V(.098,.240,-1.405)];
  const mainPath=makeCurve(mainPoints);
  const skin=makeSkin(mainPath,skinPainted,skinColor,colors,low); rig.add(skin.mesh);
  const surface=(a,t,lift=0)=>skin.sample(clamp(t,.035,.95),a,lift);
  const marks=[[.80,.23,.29,.047,-.22],[-.94,.28,.27,.045,.18],
    [1.02,.40,.29,.048,.25],[-1.00,.46,.30,.045,-.26],
    [.77,.58,.31,.047,-.18],[-.86,.65,.29,.043,.27],
    [.62,.76,.28,.039,.15],[-.68,.82,.25,.034,-.15]];
  marks.forEach(([a,t,w,h,r],index)=>{
    const spot=marking(rig,surface,[a,t],[w,h],r,colors.spot,
      (u,v)=>skinColor(.65+mainPath.getPointAt(clamp(v,0,1)).y,u));
    spot.name=`Tail skin marking ${index+1}`;
  });

  // The leaf's own sculpt stays in the helper's XY convention, then is oriented
  // along the terminal stalk before all its faces and veins enter the same rig.
  const leafRig=new THREE.Group(); rig.add(leafRig);
  leafRig.name='Soft terminal leaf rest frame';
  leafRig.position.copy(mainPath.getPointAt(1));
  const along=mainPath.getTangentAt(1).normalize();
  const across=V(1,0,0).addScaledVector(along,-along.x).normalize();
  const normal=across.clone().cross(along).normalize();
  leafRig.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(across,along,normal));
  const leafPoints=[[0,-.026,0],[.008,.095,.004],[.023,.245,.016],
    [.033,.387,.035],[.004,.490,.083]];
  leaf(leafRig,leafPoints,[[0,.013],[.18,.102],[.43,.177],[.68,.158],[.87,.090],[1,.0015]],
    {tone:new THREE.Color('#9bb652'),depth:.025,curl:.041,fold:.018,
      name:'Flexible three dimensional tail leaf',veinCount:4});
  leafRig.updateMatrix();
  const structuralPoints=mainPoints.concat(leafPoints.slice(1).map(p=>V(...p).applyMatrix4(leafRig.matrix)));
  const structuralPath=makeCurve(structuralPoints);
  const stationCount=26,rest=[];
  const bones=[];
  for(let i=0;i<stationCount;i+=1) {
    const point=structuralPath.getPointAt(i/(stationCount-1)); rest.push(point);
    const bone=new THREE.Bone(); bone.name=`Tail flexible station ${i}`;
    bone.position.copy(point); rig.add(bone); bones.push(bone);
  }
  bones[stationCount-1].name='Tail leaf tip · delayed flexible station';
  const segments=[],resolution=256;
  let before=structuralPath.getPointAt(0);
  for(let i=1;i<=resolution;i+=1) {
    const next=structuralPath.getPointAt(i/resolution),delta=next.clone().sub(before);
    segments.push({x:before.x,y:before.y,z:before.z,dx:delta.x,dy:delta.y,dz:delta.z,lengthSq:delta.lengthSq()});
    before=next;
  }
  rig.userData.restLength=structuralPath.getLength();

  // Broad fixed envelopes are intentional. Three's skinned raycast and frustum
  // tests otherwise retain a bind-pose sphere and can miss a wagging leaf/spot.
  const bounds=new THREE.Box3(V(-2.20,-.59,-2.35),V(2.20,1.42,.26));
  const sphere=bounds.getBoundingSphere(new THREE.Sphere());
  rig.userData.animatedBounds={min:bounds.min.toArray(),max:bounds.max.toArray()};
  root.updateMatrixWorld(true);
  const sources=[]; rig.traverse(object=>{if(object.isMesh)sources.push(object);});
  const inverseRig=rig.matrixWorld.clone().invert();
  const skeleton=new THREE.Skeleton(bones);
  for(const source of sources) {
    const geometry=source.geometry;
    geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverseRig,source.matrixWorld));
    skinGeometry(geometry,segments,stationCount);
    geometry.boundingBox=bounds.clone(); geometry.boundingSphere=sphere.clone();
    const mesh=new THREE.SkinnedMesh(geometry,source.material);
    mesh.name=source.name; mesh.castShadow=source.castShadow; mesh.receiveShadow=source.receiveShadow;
    mesh.boundingBox=bounds.clone(); mesh.boundingSphere=sphere.clone();
    source.parent.remove(source); rig.add(mesh);
    root.updateMatrixWorld(true); mesh.bind(skeleton);
  }
  rig.remove(leafRig);

  const euler=new THREE.Euler(0,0,0,'YXZ');
  const rotation=new THREE.Quaternion(),delta=V();
  const last=stationCount-1;
  // Absolute time, assigned from rest: refreshes and repeated calls never drift.
  // Centre positions integrate rotated rest segments with fixed arc length;
  // station orientations then provide a continuous, softly weighted skin field.
  function rotationAt(u,seconds,greeting,reduced,mood,out) {
    const gate=smooth((u-.085)/.29),distal=smooth((u-.53)/.42),blade=smooth((u-.755)/.235);
    let yaw,pitch,roll;
    if(reduced) {
      yaw=greeting*.31*gate*(.35+.65*u);
      pitch=greeting*.16*gate;
      roll=0;
    } else {
      const phase=.88*seconds+.20*Math.sin(.23*seconds)+.16*Math.sin(.61*seconds+.8);
      const lively=3.55*seconds+.14*Math.sin(.90*seconds);
      const curl=smooth((Math.sin(.21*seconds-1.2)-.54)/.46);
      const idleScale=(.62+.16*Math.sin(.19*seconds+.3))*(1-.96*mood.quiet);
      const idle=(.93+.13*Math.sin(.19*seconds+.3))*Math.sin(phase-2.25*u)
        +.20*Math.sin(1.75*phase-5.1*u+.3);
      const hello=1.10*Math.sin(lively-2.80*u+.35)+.17*Math.sin(1.80*lively-5.0*u+.6);
      yaw=gate*(.42+.58*u)*(idle*idleScale*(1-greeting)+hello*greeting)
        +.37*curl*distal*Math.sin(.13*seconds+1.1)*idleScale*(1-greeting)
        +blade*(.13*Math.sin(phase-3.6*u-.55)*idleScale*(1-greeting)
          +.20*Math.sin(lively-3.6*u-.6)*greeting);
      pitch=gate*((.062*Math.sin(.78*phase-3*u)+.042*Math.sin(1.3*phase-5*u))*idleScale*(1-greeting)
        +greeting*(.20+.14*Math.sin(lively-2.5*u+.6)))
        +.16*curl*distal*idleScale*(1-greeting)
        +blade*(.047*Math.sin(phase-3.9*u)*idleScale*(1-greeting)+.060*Math.sin(lively-4.1*u)*greeting);
      roll=distal*(.044*Math.sin(phase-3.6*u)*idleScale*(1-greeting)+.058*Math.sin(lively-4*u)*greeting);
      // The root stays fixed in the rump. A delayed distal response follows
      // attention and paw contact; a sleeping tail settles instead of wagging.
      const glance=mood.side*(1-2*smooth((mood.phase-.43)/.19));
      const touch=(Math.exp(-(((mood.phase-.39-u*.025)/.045)**2))
        -Math.exp(-(((mood.phase-.61-u*.025)/.045)**2)))*mood.groom;
      yaw+=gate*(.16*mood.doze*mood.side+.10*mood.rest*mood.side-.12*mood.look*glance
        +.13*touch*mood.side)*( .35+.65*u );
      pitch+=gate*(.21*mood.stretch-.10*mood.doze+.035*mood.sniff);
      roll+=distal*(.045*mood.stretch-.025*mood.doze*mood.side);
    }
    return out.setFromEuler(euler.set(pitch,yaw,roll,'YXZ'));
  }
  function update(t=0,wave=0,reduced=false,activity=null) {
    const seconds=Number.isFinite(t)?t:0,greeting=clamp(Number(wave)||0,0,1);
    const phase=clamp(Number(activity?.phase)||0,0,1),weight=clamp(Number(activity?.weight)||0,0,1)*(reduced?0:1);
    const held=smooth((phase-.08)/.16)*(1-smooth((phase-.77)/.23))*weight;
    const amount=kind=>activity?.kind===kind?held:0;
    const mood={phase,side:activity?.side<0?-1:1,doze:amount('doze'),sniff:amount('sniff'),
      groom:amount('groom'),stretch:amount('stretch'),look:amount('look'),rest:amount('rest')};
    mood.quiet=clamp(mood.doze+.32*mood.sniff+.34*mood.groom+.15*mood.rest,0,1);
    bones[0].position.copy(rest[0]);
    rotationAt(0,seconds,greeting,reduced,mood,bones[0].quaternion);
    for(let i=1;i<stationCount;i+=1) {
      rotationAt((i-.5)/last,seconds,greeting,reduced,mood,rotation);
      delta.copy(rest[i]).sub(rest[i-1]).applyQuaternion(rotation);
      bones[i].position.copy(bones[i-1].position).add(delta);
      rotationAt(i/last,seconds,greeting,reduced,mood,bones[i].quaternion);
    }
  }
  update(0,0,false);
  return {root:rig,update,skeleton};
}
