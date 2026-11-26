// Procedural textures + shared materials (no external assets: everything is drawn on canvases).
import * as THREE from "three";
import type { RoadMat } from "./buildTypes";

function canvas(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  return c;
}

function noise(g: CanvasRenderingContext2D, w: number, h: number, amount: number, count: number) {
  for (let i = 0; i < count; i++) {
    const v = Math.random() < 0.5 ? 0 : 255;
    g.fillStyle = `rgba(${v},${v},${v},${Math.random() * amount})`;
    g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
}

function tex(c: HTMLCanvasElement, aniso: number, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface Materials {
  walls: THREE.MeshStandardMaterial;
  stone: THREE.MeshStandardMaterial;
  roofs: THREE.MeshStandardMaterial;
  ground: THREE.MeshStandardMaterial;
  roads: Record<RoadMat, THREE.MeshStandardMaterial>;
  trunk: THREE.MeshStandardMaterial;
  leaves: THREE.MeshStandardMaterial;
  dispose: () => void;
}

export function createMaterials(aniso: number): Materials {
  // Facade: one cell = 3.6m x 3.3m with a framed window; tinted per building by vertex colour.
  const facade = canvas(256, 256, (g) => {
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, 256, 256);
    noise(g, 256, 256, 0.05, 2500);
    g.fillStyle = "#e9e3d9";
    g.fillRect(0, 248, 256, 8); // floor band
    g.fillStyle = "#f7f3ec";
    g.fillRect(66, 52, 124, 150); // frame
    const glass = g.createLinearGradient(0, 60, 0, 196);
    glass.addColorStop(0, "#5b6c7d");
    glass.addColorStop(0.5, "#34404d");
    glass.addColorStop(1, "#283039");
    g.fillStyle = glass;
    g.fillRect(74, 60, 108, 134);
    g.fillStyle = "#f7f3ec";
    g.fillRect(125, 60, 6, 134); // mullion
    g.fillRect(74, 112, 108, 5);
    g.fillStyle = "rgba(0,0,0,0.18)";
    g.fillRect(62, 202, 132, 7); // sill shadow
  });
  const plaster = canvas(128, 128, (g) => {
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, 128, 128);
    noise(g, 128, 128, 0.06, 1500);
  });
  const grass = canvas(256, 256, (g) => {
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, 256, 256);
    noise(g, 256, 256, 0.12, 9000);
  });
  const asphalt = (lines: boolean) =>
    canvas(128, 512, (g) => {
      g.fillStyle = "#5a5d62";
      g.fillRect(0, 0, 128, 512);
      noise(g, 128, 512, 0.18, 7000);
      if (lines) {
        g.fillStyle = "#e9e9e4";
        g.fillRect(5, 0, 3, 512);
        g.fillRect(120, 0, 3, 512);
        g.fillRect(62, 0, 4, 240);
      }
    });
  const gravel = canvas(128, 256, (g) => {
    g.fillStyle = "#b9a988";
    g.fillRect(0, 0, 128, 256);
    noise(g, 128, 256, 0.25, 5000);
  });
  const paving = canvas(128, 128, (g) => {
    g.fillStyle = "#c4bcad";
    g.fillRect(0, 0, 128, 128);
    noise(g, 128, 128, 0.15, 2500);
    g.strokeStyle = "rgba(90,80,70,0.35)";
    g.lineWidth = 2;
    for (let i = 0; i <= 128; i += 32) {
      g.beginPath(); g.moveTo(0, i); g.lineTo(128, i); g.stroke();
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.stroke();
    }
  });
  const rail = canvas(128, 256, (g) => {
    g.fillStyle = "#7a7067";
    g.fillRect(0, 0, 128, 256);
    noise(g, 128, 256, 0.3, 5000);
    g.fillStyle = "#5b4636";
    for (let y = 0; y < 256; y += 32) g.fillRect(14, y, 100, 12);
    g.fillStyle = "#c8ccd0";
    g.fillRect(34, 0, 6, 256);
    g.fillRect(88, 0, 6, 256);
  });

  const textures = [facade, plaster, grass, asphalt(true), asphalt(false), gravel, paving, rail].map((c) => tex(c, aniso));
  const [tFacade, tPlaster, tGrass, tMajor, tMinor, tGravel, tPaving, tRail] = textures;
  tGrass.colorSpace = THREE.SRGBColorSpace;
  const groundTex = tGrass.clone();
  groundTex.repeat.set(9000, 9000);
  textures.push(groundTex);

  const road = (map: THREE.Texture) =>
    new THREE.MeshStandardMaterial({ map, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });

  const m: Materials = {
    walls: new THREE.MeshStandardMaterial({ map: tFacade, vertexColors: true, roughness: 0.88 }),
    stone: new THREE.MeshStandardMaterial({ map: tPlaster, vertexColors: true, roughness: 0.9 }),
    roofs: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }),
    ground: new THREE.MeshStandardMaterial({ map: groundTex, color: "#97a771", roughness: 1 }),
    roads: { major: road(tMajor), minor: road(tMinor), gravel: road(tGravel), paving: road(tPaving), rail: road(tRail) },
    trunk: new THREE.MeshStandardMaterial({ color: "#5a4334", roughness: 1 }),
    leaves: new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.9, flatShading: true }),
    dispose: () => {
      textures.forEach((t) => t.dispose());
      Object.values(m.roads).forEach((r) => r.dispose());
      [m.walls, m.stone, m.roofs, m.ground, m.trunk, m.leaves].forEach((x) => x.dispose());
    },
  };
  m.roads.paving.polygonOffsetFactor = -1;
  return m;
}

/** Ground-floor band (7.2 m x 3.6 m cell): shopfronts or doors/windows. */
export function createGroundFacade(
  s: { kind: string; wall: string; plinth: string; frame: string; sign: string },
  aniso: number,
): THREE.MeshStandardMaterial {
  const W = 512, H = 256;
  const c = canvas(W, H, (g) => {
    g.fillStyle = s.wall;
    g.fillRect(0, 0, W, H);
    noise(g, W, H, 0.08, 5000);
    const glass = (x: number, y: number, w: number, h: number) => {
      const gr = g.createLinearGradient(0, y, 0, y + h);
      gr.addColorStop(0, "#617284");
      gr.addColorStop(0.55, "#364250");
      gr.addColorStop(1, "#262d35");
      g.fillStyle = gr;
      g.fillRect(x, y, w, h);
    };
    if (s.kind === "vitrines") {
      g.fillStyle = s.sign;
      g.fillRect(0, 18, W, 46);
      g.fillStyle = "rgba(255,255,255,0.75)";
      for (let x = 40; x < 300; x += 22) g.fillRect(x, 34, 12, 14);
      g.fillStyle = s.frame;
      g.fillRect(14, 70, 334, 170);
      g.fillRect(366, 70, 132, 186);
      glass(24, 80, 314, 150);
      glass(378, 82, 108, 174);
      g.fillStyle = s.frame;
      g.fillRect(178, 80, 6, 150);
      g.fillStyle = s.plinth;
      g.fillRect(0, 240, 366, 16);
    } else {
      g.fillStyle = s.plinth;
      g.fillRect(0, 206, W, 50);
      noise(g, W, 50, 0.1, 600);
      g.fillStyle = s.frame;
      g.fillRect(62, 46, 112, 210);
      g.fillStyle = "#5b3a26";
      g.fillRect(72, 56, 92, 200);
      g.fillStyle = "rgba(0,0,0,0.25)";
      g.fillRect(84, 70, 30, 70); g.fillRect(122, 70, 30, 70); g.fillRect(84, 156, 30, 80); g.fillRect(122, 156, 30, 80);
      g.fillStyle = "#d9b35b"; g.fillRect(150, 150, 6, 10);
      g.fillStyle = s.frame;
      g.fillRect(318, 60, 128, 136);
      glass(326, 68, 112, 120);
      g.fillStyle = s.frame;
      g.fillRect(379, 68, 6, 120);
    }
  });
  return new THREE.MeshStandardMaterial({ map: tex(c, aniso), vertexColors: true, roughness: 0.85 });
}
