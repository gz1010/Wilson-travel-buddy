import React from 'react';
import { placeNameSize } from '../../core/look';
import type { Place } from '../../core/types';
import { GlassWord, glassWordVisible } from './GlassWord';

/** Share of a place name's capital height sunk below its card's edge: none, the whole word shows. */
export const NAME_CUT = 0;

/** The baseline sits this share of the size above the card's edge: room for the glass's extruded side. */
const LIFT = 0.08;
/** Letters that hang below the baseline (in SF Pro Heavy about 0.21 em, plus the extruded side). */
const DESCENDERS = /[gjpqy,;()[\]{}|çÇşŞţŢ]/;
const DESCENDER_LIFT = 0.27;

function liftShare(text: string): number {
  return DESCENDERS.test(text) ? DESCENDER_LIFT : LIFT;
}

/** px from the card's bottom edge up to a name's baseline at `size` (higher when it has descenders). */
export function nameBaseline(text: string, size: number): number {
  return Math.round(size * liftShare(text));
}

/** The largest size at which a name, baseline lift and tallest letters together, rises at most `room` px. */
export function nameSizeForRoom(text: string, room: number): number {
  return room / (liftShare(text) + glassWordVisible(1, 0));
}

/**
 * A place name in 3D frosted-glass letters (GlassWord), whole, standing just above the card's
 * bottom edge (AntNow cards). The native stand-in for LiquidGlass's WebGL letters, shown until
 * they have drawn. Absolutely fills its card; put it last inside the card.
 */
export function GlassText({ place, size, left = 10 }: { place: Place; size?: number; left?: number }) {
  const s = size ?? placeNameSize(place.name);
  return <GlassWord text={place.name} size={s} cut={NAME_CUT} lift={nameBaseline(place.name, s)} align="left" inset={left} label={place.name} />;
}
