// 4D math utilities: vectors, 4x4 rotation matrices, plane rotations

// Axis-pair index for a rotation plane
// Plane names: 'XY','XZ','XW','YZ','YW','ZW'
export const PLANE_AXES = {
  XY: [0, 1], XZ: [0, 2], XW: [0, 3],
  YZ: [1, 2], YW: [1, 3], ZW: [2, 3],
};

export function vec4(x = 0, y = 0, z = 0, w = 0) {
  return new Float64Array([x, y, z, w]);
}

export function vec4Clone(v) {
  return new Float64Array(v);
}

export function vec4Dot(a, b) {
  return a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3];
}

export function mat4Identity() {
  const m = new Float64Array(16);
  m[0]=m[5]=m[10]=m[15]=1;
  return m;
}

export function mat4Mul(a, b) {
  const r = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k*4+row] * b[col*4+k];
      r[col*4+row] = s;
    }
  }
  return r;
}

export function mat4MulVec4(m, v) {
  const r = new Float64Array(4);
  for (let row = 0; row < 4; row++) {
    r[row] = m[row]*v[0] + m[4+row]*v[1] + m[8+row]*v[2] + m[12+row]*v[3];
  }
  return r;
}

// Rotation matrix in the plane (a, b) by angle radians (right-hand rule: a→b positive)
export function mat4PlaneRotation(a, b, angle) {
  const m = mat4Identity();
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  m[a*4+a] = c;
  m[b*4+a] = -s;
  m[a*4+b] = s;
  m[b*4+b] = c;
  return m;
}

// Build a column-major 4×4 from four column vectors (each length-4).
export function mat4FromCols(c0, c1, c2, c3) {
  return new Float64Array([
    c0[0], c0[1], c0[2], c0[3],
    c1[0], c1[1], c1[2], c1[3],
    c2[0], c2[1], c2[2], c2[3],
    c3[0], c3[1], c3[2], c3[3],
  ]);
}

export function mat4Transpose(m) {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) r[row*4+c] = m[c*4+row];
  return r;
}

// Determinant of a column-major 4×4 (used to test frame handedness).
export function mat4Det(m) {
  const a = (i, j) => m[j*4 + i];          // (row i, col j)
  const det3 = (a00,a01,a02,a10,a11,a12,a20,a21,a22) =>
    a00*(a11*a22 - a12*a21) - a01*(a10*a22 - a12*a20) + a02*(a10*a21 - a11*a20);
  let det = 0;
  for (let j = 0; j < 4; j++) {
    // minor of (row 0, col j)
    const cols = [0,1,2,3].filter(c => c !== j);
    const mnr = det3(
      a(1,cols[0]), a(1,cols[1]), a(1,cols[2]),
      a(2,cols[0]), a(2,cols[1]), a(2,cols[2]),
      a(3,cols[0]), a(3,cols[1]), a(3,cols[2]));
    det += (j % 2 ? -1 : 1) * a(0, j) * mnr;
  }
  return det;
}

// Apply a 90° plane rotation to an integer-grid vec4, snapped to avoid drift
export function applyPlaneRotation90(v, a, b, sign) {
  const r = vec4Clone(v);
  const va = v[a], vb = v[b];
  // +90°: a → -b, b → a   i.e. new_a = -b, new_b = a
  // -90°: a → b, b → -a   i.e. new_a = b, new_b = -a
  if (sign > 0) { r[a] = -vb; r[b] = va; }
  else          { r[a] = vb;  r[b] = -va; }
  return r;
}

// 3x3 matrix (for 3D view rotation), stored as Float64Array[9], column-major
export function mat3Identity() {
  const m = new Float64Array(9);
  m[0]=m[4]=m[8]=1;
  return m;
}

export function mat3Mul(a, b) {
  const r = new Float64Array(9);
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[k*3+row] * b[col*3+k];
      r[col*3+row] = s;
    }
  }
  return r;
}

export function mat3MulVec3(m, v) {
  return [
    m[0]*v[0] + m[3]*v[1] + m[6]*v[2],
    m[1]*v[0] + m[4]*v[1] + m[7]*v[2],
    m[2]*v[0] + m[5]*v[1] + m[8]*v[2],
  ];
}

// 3D rotation around axis (0=X,1=Y,2=Z) by angle
export function mat3AxisRotation(axis, angle) {
  const m = mat3Identity();
  const c = Math.cos(angle), s = Math.sin(angle);
  const a = (axis + 1) % 3, b = (axis + 2) % 3;
  m[a*3+a]=c; m[b*3+a]=-s;
  m[a*3+b]=s; m[b*3+b]=c;
  return m;
}
