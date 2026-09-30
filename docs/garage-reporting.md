# Garage reporting

Garage reports manually chosen Normal/Away mode, requested target, confirmed
heat-pump control and effective target. A protection or sensor-fallback increase
is visible without replacing the selected mode. Warm-up advisories describe
condensation risk and remain distinct from mode lifetime.

The independent protection panel compares parameters from `garage.protection`
with the protection sender's actual configuration, and shows front/rear air
and estimated pipe temperatures, validity and heating demand. Its settings are
read-only; ST-MQ applies only loaded configuration and requires matching fresh
readback for confirmation. Offline or missing protection is unavailable. With
the BLU H&T test source, temperature control works while pipe protection is
absent.

Charts retain original temperatures, doors, compressor activity, supported native
pump observations and qualified electrical history. Requests are not measurements.
Garage learned coefficients, automatic reduction episodes and model savings
projections are removed. Home learning and Home model assessments are unchanged.
A garage electricity timing comparison is based on recorded energy and prices;
it does not prove savings from automatic control.

The database inventory describes current writers. Older generic event/journal
rows remain original audit records without restoring a retired learning engine.
