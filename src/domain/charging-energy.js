/** Fixed share of charger electricity lost before reaching the battery.
 * The same loss supplies the garage's declared charging-heat assumption;
 * recorded grid energy and its electricity cost are never reduced by it. */
export const CHARGING_LOSS_FRACTION = 0.075;
export const CHARGING_EFFICIENCY = 1 - CHARGING_LOSS_FRACTION;
