// Constructed geometry exercises state transitions; it is not a recorded user or an accuracy benchmark.
export function hand(pose = 'move', {x = 0, y = 0, scale = 1, rotate = 0, mirrored = false, aspect = 1} = {}) {
  const points = Array.from({length:21}, () => ({x:0.5,y:0.6,z:0}));
  points[0] = {x:0.5,y:0.8,z:0};
  [[1,.40,.73],[2,.35,.65],[3,.31,.58],[4,.27,.5]].forEach(([i,px,py]) => {points[i] = {x:px,y:py,z:0};});
  for (const [base,px,py] of [[5,.43,.60],[9,.50,.57],[13,.56,.60],[17,.62,.65]]) {
    const extension = ['open','move','left','right','scroll','both'].includes(pose) ||
      (base === 5 && ['index','index-left','index-right','index-both','trigger','trigger-left','trigger-right','trigger-both','trigger-scroll'].includes(pose));
    points[base] = {x:px,y:py,z:0};
    points[base + 1] = {x:px,y:py - .09,z:0};
    points[base + 2] = {x:px,y:py - (extension ? .15 : .02),z:0};
    points[base + 3] = {x:px,y:py - (extension ? .22 : -.06),z:0};
  }
  if (['left','both'].includes(pose)) {
    points[8] = {x:.39,y:.43,z:0};
    points[4] = {x:.41,y:.43,z:0};
  }
  if (pose === 'right') {
    points[12] = {x:.48,y:.48,z:0};
    points[4] = {x:.50,y:.48,z:0};
  }
  if (pose === 'index-left') {
    points[12] = {x:.43,y:.50,z:0};
    points[4] = {x:.45,y:.50,z:0};
  }
  if (pose === 'index-right') {
    points[16] = {x:.43,y:.50,z:0};
    points[4] = {x:.45,y:.50,z:0};
  }
  if (pose === 'index-both') {
    points[12] = {x:.43,y:.50,z:0};
    points[16] = {x:.43,y:.50,z:0};
    points[4] = {x:.45,y:.50,z:0};
  }
  if (pose === 'scroll') {
    points[16] = {x:.55,y:.43,z:0};
    points[4] = {x:.57,y:.43,z:0};
  }
  if (pose === 'both') points[12] = {x:.42,y:.44,z:0};
  if (['fist','trigger','trigger-right','trigger-freeze','trigger-scroll'].includes(pose)) {
    points[4] = {x:.42,y:.58,z:0}; // thumb tucked against fist
  }
  if (['trigger-left','trigger-both','trigger-freeze-click'].includes(pose)) {
    points[4] = {x:.20,y:.50,z:0}; // thumb extended outward
  }
  if (['trigger-right','trigger-both'].includes(pose)) {
    points[18] = {x:.64,y:.44,z:0};
    points[19] = {x:.65,y:.36,z:0};
    points[20] = {x:.66,y:.28,z:0}; // pinky extended
  }
  if (pose === 'trigger-freeze') {
    points[8] = {x:.43,y:.60,z:0}; // index curled/folded
  }
  if (pose === 'trigger-freeze-click') {
    points[8] = {x:.43,y:.60,z:0}; // index curled/folded
    points[4] = {x:.20,y:.50,z:0}; // thumb extended
  }
  if (pose === 'trigger-scroll') {
    points[10] = {x:.50,y:.42,z:0};
    points[11] = {x:.50,y:.34,z:0};
    points[12] = {x:.50,y:.26,z:0}; // middle extended for V-sign
    points[4] = {x:.42,y:.58,z:0};  // thumb tucked
  }
  return points.map(p => {
    const px = (p.x - .5) * scale * (mirrored ? -1 : 1), py = (p.y - .6) * scale;
    return {x:.5 + px * Math.cos(rotate) - py * Math.sin(rotate) + x,
      y:(.5 + px * Math.sin(rotate) + py * Math.cos(rotate) + y) * aspect,z:p.z};
  });
}
