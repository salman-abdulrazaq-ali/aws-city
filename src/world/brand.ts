// Real brand names behind one switch (shared/brand.json). The player chose the Amazon Air hub with its real name and
// livery; a store build (WXT_STORE_BUILD=true) turns the names off, and every branded thing shows its generic name
// instead (a business's `nameUnbranded`). The jets' livery and the hangar's sign are baked into the art by `npm run art`
// from shared/brand.json itself. Nothing else reads the brand.
import brandJson from '../../shared/brand.json' with { type: 'json' };

/** The brand is on when shared/brand.json says so, except in a store build (`storeBuild` is WXT_STORE_BUILD). */
export const brandOn = (json: { amazon?: boolean }, storeBuild: string | undefined) => json.amazon === true && storeBuild !== 'true';

/** Amazon's own names and liveries (Amazon Air) are on. */
export const BRAND_AMAZON = brandOn(brandJson as { amazon: boolean }, import.meta.env.WXT_STORE_BUILD);

/** A name with a brand: the branded one when the brand is on, else the generic one. */
export const branded = (x: { name: string; nameUnbranded?: string; brand?: string }, on = BRAND_AMAZON) => (x.brand && !on ? (x.nameUnbranded ?? x.name) : x.name);
