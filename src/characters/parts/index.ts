/**
 * The parts library, in one import.
 *
 * Unit authors receive this whole namespace as `ctx.parts` and should not need
 * to import anything from `@characters/parts/*` directly. Everything is a pure
 * function of its arguments and returns geometry in **rig space** — feet at
 * y = 0, facing -Z, in rig units.
 *
 * See `src/characters/units/README.md` for the contract and a worked example.
 */

export * from './types.ts';
export * as prim from './prim.ts';
export * as body from './body.ts';
export * as helmet from './helmet.ts';
export * as lamellar from './lamellar.ts';
export * as cloth from './cloth.ts';
export * as weapons from './weapons.ts';
export * as standard from './standard.ts';
export * as mount from './mount.ts';
export * as vehicle from './vehicle.ts';
export * as rivets from './rivets.ts';
export * as trim from './trim.ts';
