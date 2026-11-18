import * as THREE from 'three';

// A small brimstone butterfly gives the dragon a visible reason to look up.
export function makeButterfly() {
  const root=new THREE.Group(), hinges=[];
  root.name='Butterfly watched by the dragon';
  root.visible=false;
  const shape=new THREE.Shape();
  shape.moveTo(0,.014);
  shape.bezierCurveTo(.05,.065,.115,.114,.173,.108);
  shape.quadraticCurveTo(.177,.035,.115,-.011);
  shape.bezierCurveTo(.14,-.07,.069,-.102,.034,-.061);
  shape.quadraticCurveTo(.012,-.046,0,-.014);
  shape.closePath();
  const geometry=new THREE.ShapeGeometry(shape,8);
  const pos=geometry.getAttribute('position'), colors=[];
  const warm=new THREE.Color('#daa44a'), cream=new THREE.Color('#fff1a3');
  const amber=new THREE.Color('#ab8547');
  for(let i=0;i<pos.count;i++){
    const x=pos.getX(i), y=pos.getY(i);
    const color=warm.clone().lerp(cream,THREE.MathUtils.clamp(x/.11,0,1));
    color.lerp(amber,THREE.MathUtils.smoothstep(x+y,.18,.26)*.75);
    colors.push(color.r,color.g,color.b);
    pos.setZ(i,Math.sin(x*15)*.016-y*.09);
  }
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  geometry.computeVertexNormals();
  const wing=new THREE.MeshStandardMaterial({vertexColors:true,side:THREE.DoubleSide,roughness:.85});
  for(const side of [-1,1]){
    const hinge=new THREE.Group();
    const blade=new THREE.Mesh(geometry,wing);
    blade.scale.x=side;
    hinge.add(blade);root.add(hinge);hinges.push(hinge);
  }
  const thorax=new THREE.Mesh(new THREE.SphereGeometry(1,9,7),new THREE.MeshStandardMaterial({color:0x6c5834,roughness:.8}));
  thorax.scale.set(.013,.055,.014);root.add(thorax);
  const antenna = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0,.045,0),new THREE.Vector3(-.023,.083,.01),
    new THREE.Vector3(0,.045,0),new THREE.Vector3(.023,.083,.01)
  ]);
  root.add(new THREE.LineSegments(antenna,new THREE.LineBasicMaterial({color:0x685632})));
  function update(t,activity){
    const show=activity.kind==='look' && activity.weight>.002;
    root.visible=show;if(!show)return;
    const p=activity.phase, side=activity.side;
    const arrive=THREE.MathUtils.smoothstep(p,0,.36), depart=THREE.MathUtils.smoothstep(p,.68,1);
    root.position.set(side*(1.49-.49*arrive+.36*depart+.065*Math.sin(9*p)),2.53+.27*arrive+.35*depart+.074*Math.sin(14*p),.99+.095*Math.cos(7*p));
    root.rotation.set(-.24+.13*Math.sin(12*p), side*(-.1+.22*Math.sin(8*p)),side*(.23+.20*Math.cos(8*p)));
    root.scale.setScalar(Math.sqrt(activity.weight));
    const flap=.20+.84*(.5+.5*Math.sin(t*28));
    hinges[0].rotation.y=-flap;hinges[1].rotation.y=flap;
  }
  return {root,update};
}
