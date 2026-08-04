/**
 * A bring-up shim for `GongbiMaterials`.
 *
 * The scene takes its materials by injection from @render, exactly as the
 * architecture requires. This file exists for the two cases where @render is
 * not in the room:
 *
 *   1. the headless verification script, which builds the whole board in node
 *      with no WebGL context at all, and
 *   2. bootstrapping `main.ts` before the render subsystem has landed.
 *
 * It is NOT a substitute for the real ramp materials — it does not quantise,
 * it does not draw outlines, it does not wash the shadows with silk weave. It
 * only picks the right pigment band so the geometry can be looked at and
 * measured. Anything that reads as "the gongbi look" comes from @render.
 */

import * as THREE from 'three';
import type { GongbiMaterials, MaterialRequest } from '@core/contracts.ts';
import { PIGMENTS, RAMPS, shiftHex } from '@core/palette.ts';

function colourOf(req: MaterialRequest): THREE.Color {
  const ramp = RAMPS[req.cls];
  // Body colour is band 2 for a 4-step class, band 1 for a 3-step one: the band
  // a painter would call the 本色 before the lifted plane goes on.
  const idx = ramp.steps === 4 ? 2 : 1;
  const hex = req.variation ? shiftHex(PIGMENTS[req.pigment].bands[idx], req.variation * 0.12) : PIGMENTS[req.pigment].bands[idx];
  return new THREE.Color().setStyle(hex, THREE.SRGBColorSpace);
}

function keyOf(req: MaterialRequest): string {
  return [
    req.cls,
    req.pigment,
    req.variation ?? 0,
    req.outline ?? '',
    req.skinned ? 1 : 0,
    req.noSilk ? 1 : 0,
    req.glow ?? 0,
  ].join('|');
}

export function createFallbackMaterials(): GongbiMaterials {
  const cache = new Map<string, THREE.Material>();
  let silhouette = false;
  const black = new THREE.Color(0, 0, 0);
  const originals = new Map<THREE.Material, THREE.Color>();

  const get = (req: MaterialRequest): THREE.Material => {
    const k = keyOf(req);
    const hit = cache.get(k);
    if (hit) return hit;
    const colour = colourOf(req);
    const m = new THREE.MeshLambertMaterial({
      name: `fallback/${req.cls}/${req.pigment}`,
      color: colour,
      side: THREE.FrontSide,
    });
    if (req.glow) {
      m.emissive = colour.clone().multiplyScalar(req.glow);
    }
    m.userData.request = req;
    originals.set(m, colour.clone());
    if (silhouette) m.color.copy(black);
    cache.set(k, m);
    return m;
  };

  return {
    get,
    outline: () => null,
    setSilhouetteMode(on: boolean) {
      silhouette = on;
      for (const m of cache.values()) {
        const lm = m as THREE.MeshLambertMaterial;
        const orig = originals.get(m);
        if (!orig) continue;
        lm.color.copy(on ? black : orig);
        if (lm.emissive) lm.emissive.setRGB(0, 0, 0);
      }
    },
    update() {
      /* the shim has no per-frame uniforms */
    },
    setMood() {
      /* the shim has no grade */
    },
    dispose() {
      for (const m of cache.values()) m.dispose();
      cache.clear();
      originals.clear();
    },
  };
}
