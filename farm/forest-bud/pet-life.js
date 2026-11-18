// One quiet interval separates gestures. Direct attention interrupts the current
// pose at its current weight; the model then blends back into its greeting.
const awakeActions = ['look', 'sniff', 'groom', 'stretch'];
const durations = { look:[3.5,4.5], sniff:[3.6,4.5], groom:[4.5,5.4], stretch:[4.3,5.2], doze:[7.5,10.5] };
const smooth = t => t * t * (3 - 2 * t);
const clamp = t => Math.max(0, Math.min(1, t));

export function createPetLife(random = Math.random) {
  const between = (low, high) => low + (high-low) * random();
  const pose = {kind:'rest', phase:0, weight:0, side:1};
  let remaining=[], last='', needsStretch=false, paused=false;
  let readyAt=between(1.25,1.9), napAt=between(28,36), awakeCount=0;
  let started=0, duration=1, fadeAt=null, fadeWeight=0;
  function rest() {
    pose.kind='rest';pose.phase=0;pose.weight=0;fadeAt=null;
  }
  function nextAction(now) {
    if(awakeCount>=4 && now>=napAt && !needsStretch) return 'doze';
    if(!remaining.length) remaining=awakeActions.slice();
    let options=remaining.filter(kind=>kind!==last);
    if(!options.length) options=remaining;
    let kind;
    if(needsStretch) {
      kind='stretch';needsStretch=false;
    } else if(!last) {
      kind=random()<.5?'look':'sniff';
    } else {
      kind=options[Math.floor(random()*options.length)];
    }
    const index=remaining.indexOf(kind);
    if(index>=0) remaining.splice(index,1);
    return kind;
  }
  function update(now, reduced, attending=false) {
    if(reduced){paused=true;rest();return pose;}
    if(paused){paused=false;readyAt=now+between(1.25,1.9);napAt=now+between(28,36);}
    if(fadeAt!==null) {
      const progress=clamp((now-fadeAt)/.25);
      pose.weight=fadeWeight*(1-smooth(progress));
      if(progress>=1)rest();
      return pose;
    }
    if(pose.kind!=='rest' && now>=started+duration) {
      const woke=pose.kind==='doze';
      if(woke){needsStretch=true;awakeCount=0;napAt=now+between(60,96);}
      readyAt=now+(woke?between(.55,1.15):between(2,4.1));
      rest();
    }
    if(pose.kind==='rest' && now>=readyAt && !attending) {
      const kind=nextAction(now);
      last=kind;pose.kind=kind;pose.side=random()<.5?-1:1;
      if(kind!=='doze')awakeCount++;
      started=now;duration=between(...durations[kind]);
    }
    if(pose.kind!=='rest'){
      const p=clamp((now-started)/duration);
      pose.phase=p;
      pose.weight=smooth(clamp(p/.17))*smooth(clamp((1-p)/.19));
    }
    return pose;
  }
  function attend(now) {
    if(pose.kind!=='rest') {
      if(pose.kind==='doze'){awakeCount=0;needsStretch=true;}
      fadeAt=now;fadeWeight=pose.weight;
    }
    readyAt=now+3.3+between(1.7,3.3);
    napAt=Math.max(napAt,now+between(24,34));
  }
  return {update, attend};
}
