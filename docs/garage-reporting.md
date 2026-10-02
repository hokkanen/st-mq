# Garage reporting

Garage reports manually chosen Normal/Away mode, requested target, confirmed
heat-pump control and effective target. A protection or sensor-fallback increase
is visible without replacing the selected mode. Warm-up advisories describe
condensation risk and remain distinct from mode lifetime.

**Garage → Freeze protection**, directly below **Normal temperature**, shows
front/rear air measurements, estimated pipe temperatures and reserves, validity
and heating demand. During normal room regulation, the effective target is the
higher of the saved target and protection minimum, separate from HEAT/ON rescue. For example, rescue
with a 5°C minimum leaves an 8°C saved target at 8°C; it does not force continuous
compressor operation. Startup uncertainty is a conservative assumption, not a
measurement of frozen pipes. Recovery requires ten safe minutes at both locations;
release preserves the saved target and leaves power ON. Invalid or stale
configured protection selects the separate native 16°C HEAT/ON fault fallback.
Room-input loss or an out-of-range input/calculated external temperature can also
select native 16°C in HEAT, preserving power unless protection requests rescue.
Show actual controller readback independently from the sender's requested minimum.

The live fold includes **Pipe model & settings**, comparing configured and reported
parameters from `garage.protection`. Its model details explain the pipe estimate,
reserve and fixed safety factor of 2, separately from the sender's parameter
readback. A link opens **Connections & configuration → Garage freeze protection**,
below **Floor preheating**, for installation and setup; that section links back
to Garage. Settings are read-only; ST-MQ applies only loaded configuration and
requires matching fresh readback for confirmation. Offline or missing protection
is unavailable. With the BLU H&T test source, temperature control works while
pipe protection is absent.

Charts retain original temperatures, doors, compressor activity, supported native
pump observations and qualified electrical history. Requests are not measurements.
Garage learned coefficients, automatic reduction episodes and model savings
projections are removed. Home learning and Home model assessments are unchanged.
A garage electricity timing comparison is based on recorded energy and prices;
it does not prove savings from automatic control.

The database inventory describes current writers. Older generic event/journal
rows remain original audit records without restoring a retired learning engine.
