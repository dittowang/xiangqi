/**
 * The scene subsystem's public face.
 *
 * `createSceneRig()` is the one call the integration layer needs: it builds the
 * board, the distance, the lights and the camera director, wires the lighting to
 * the surfaces that need to know about it, and hands back a single `update(dt)`.
 * Everything underneath stays individually importable for the harness and for
 * anyone who needs a part on its own.
 */

import * as THREE from 'three';
import type { GongbiMaterials } from '@core/contracts.ts';
import type { MatchPhase } from '@core/bus.ts';
import { Board, type BoardOptions } from './board.ts';
import { Backdrop } from './backdrop.ts';
import { LightingRig, moodForPhase } from './lighting.ts';
import { Director, modeForPhase } from './camera.ts';
import type { SealOutline, SealProvider } from './bases.ts';

export * from './geometry.ts';
export * from './board.ts';
export * from './bases.ts';
export * from './backdrop.ts';
export * from './lighting.ts';
export * from './markers.ts';
export * from './camera.ts';
export * from './water.ts';
export { createFallbackMaterials } from './fallbackMaterials.ts';

export interface SceneRigOptions {
  /** Ramp materials from @render. Required — the scene never builds its own. */
  materials: GongbiMaterials;
  /** Seal-script glyphs for the piece bases; see `adaptGlyphPath`. */
  seal?: SealProvider;
  /** Outlines for 楚 河 漢 界, keyed by character. */
  riverText?: (ch: string) => SealOutline | null | undefined;
  detail?: BoardOptions['detail'];
  aspect?: number;
  /** Attach orbit input to this element. Usually `renderer.domElement`. */
  input?: HTMLElement;
  shadowMapSize?: number;
}

export interface SceneRig {
  /** Add this to the `THREE.Scene`. It contains the board, distance and lights. */
  readonly root: THREE.Group;
  readonly board: Board;
  readonly backdrop: Backdrop;
  readonly lighting: LightingRig;
  readonly director: Director;
  readonly camera: THREE.PerspectiveCamera;
  /** Bind this straight into `UnitAnimator.setGroundHeight`. */
  readonly heightAt: (x: number, z: number) => number;
  /** Lights, then board, then camera. Order matters; see the note below. */
  update(dt: number): void;
  /** Move camera framing and light mood together. */
  setPhase(phase: MatchPhase, seconds?: number): void;
  setSilhouetteMode(on: boolean): void;
  resize(width: number, height: number): void;
  stats(): { triangles: number; meshes: number; backdropTriangles: number };
  dispose(): void;
}

export function createSceneRig(opts: SceneRigOptions): SceneRig {
  const root = new THREE.Group();
  root.name = 'scene';

  const board = new Board({
    materials: opts.materials,
    seal: opts.seal,
    riverText: opts.riverText,
    detail: opts.detail,
  });
  const backdrop = new Backdrop({ materials: opts.materials, detail: opts.detail });

  // Both the water shader and the sky need the interpolated mood, so they
  // register as light consumers rather than being poked from the frame loop.
  const lighting = new LightingRig({
    materials: opts.materials,
    consumers: [board, backdrop],
    shadowMapSize: opts.shadowMapSize,
  });

  const director = new Director({ aspect: opts.aspect });
  if (opts.input) director.attachInput(opts.input);

  root.add(backdrop.group);
  root.add(board.group);
  root.add(lighting.group);

  const heightAt = (x: number, z: number) => board.heightAt(x, z);

  return {
    root,
    board,
    backdrop,
    lighting,
    director,
    camera: director.camera,
    heightAt,
    update(dt: number) {
      // Lighting first: a mood cross-fade this frame must reach the water and
      // sky shaders before they are drawn, not one frame later.
      lighting.update(dt);
      board.update(dt);
      // Camera last, so the frame is rendered from the pose that matches
      // everything else's state at the end of this step.
      director.update(dt);
    },
    setPhase(phase: MatchPhase, seconds?: number) {
      lighting.setMood(moodForPhase(phase), seconds ?? 2.4);
      director.setMode(modeForPhase(phase), seconds);
    },
    setSilhouetteMode(on: boolean) {
      board.setSilhouetteMode(on);
      backdrop.setSilhouetteMode(on);
    },
    resize(width: number, height: number) {
      director.resize(width / Math.max(height, 1));
    },
    stats() {
      const s = board.stats();
      return { ...s, backdropTriangles: backdrop.triangles };
    },
    dispose() {
      director.dispose();
      lighting.dispose();
      backdrop.dispose();
      board.dispose();
      root.clear();
    },
  };
}
