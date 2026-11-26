// Height lookup that matches the terrain mesh triangulation exactly (cell split along the 10-01 diagonal),
// so roads, buildings and the camera sit precisely on the rendered ground.
export function sampleGrid(h: ArrayLike<number>, size: number, fx: number, fy: number): number {
  const n = size - 1;
  const gx = Math.min(n - 1e-6, Math.max(0, fx * n));
  const gy = Math.min(n - 1e-6, Math.max(0, fy * n));
  const i = Math.floor(gx), j = Math.floor(gy);
  const u = gx - i, v = gy - j;
  const h00 = h[j * size + i], h10 = h[j * size + i + 1], h01 = h[(j + 1) * size + i], h11 = h[(j + 1) * size + i + 1];
  if (u + v <= 1) return h00 + u * (h10 - h00) + v * (h01 - h00);
  return h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
}
