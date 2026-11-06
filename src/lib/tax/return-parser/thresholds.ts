/**
 * The only tax-law figures the automatic summary states that are not printed
 * on the return itself. Everything else shown to the client is read from the
 * uploaded return PDF.
 *
 * NEEDS TABITHA'S CONFIRMATION before this feature is turned on:
 * - Federal: medical and dental expenses count only above 7.5% of adjusted
 *   gross income (Schedule A, line 3 prints "Multiply line 2 by 7.5% (0.075)").
 * - Alabama: medical and dental expenses count only above 4% of Alabama
 *   adjusted gross income (Alabama Schedule A).
 *
 * Stored as basis points (750 = 7.5%) so the arithmetic stays in whole cents.
 */
export const FEDERAL_MEDICAL_FLOOR_BP = 750;
export const ALABAMA_MEDICAL_FLOOR_BP = 400;

/** "7.5%" / "4%" for the plain-language text. */
export const pct = (bp: number) => `${(bp / 100).toString()}%`;

/** threshold = AGI × floor, rounded to the nearest cent. Inputs are extracted values only. */
export const medicalFloorCents = (agiCents: number, bp: number) => Math.round((Math.max(0, agiCents) * bp) / 10000);
