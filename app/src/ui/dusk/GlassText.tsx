import React from 'react';
import { placeNameSize } from '../../core/look';
import type { Place } from '../../core/types';
import { GlassWord } from './GlassWord';

/** Share of a place name's capital height sunk below its card's edge: three quarters show. */
export const NAME_CUT = 0.25;

/**
 * A place name in 3D frosted-glass letters (GlassWord), a quarter of their height sunk below the
 * card's bottom edge (AntNow cards). The native stand-in for LiquidGlass's WebGL letters, shown
 * until they have drawn. Absolutely fills its card; put it last inside the card.
 */
export function GlassText({ place, size, left = 10 }: { place: Place; size?: number; left?: number }) {
  return <GlassWord text={place.name} size={size ?? placeNameSize(place.name)} cut={NAME_CUT} align="left" inset={left} label={place.name} />;
}
