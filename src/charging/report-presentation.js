// Shared presentation of current diagnostic facts. This module does not change
// recording, finding lifetimes, control thresholds or device authority.
const FINDINGS = {
  'sys-pause-interruption': ['SYS pause interruption', 'A system permission transition interrupted an owned pause. The controller invalidated continuous-pause proof and retained the original identification bounds.'],
  'sys-permission-interruption': ['SYS permission interruption', 'The charger reported a system permission Stop. This records native provenance, not who caused it.'],
  'sys-startup-recovery': ['SYS startup recovery', 'Bounded recovery followed a system permission Stop after an acknowledged Start. The events retain each attempt and its observed outcome.'],
  'shared-priority-mismatch': ['Shared priority mismatch', 'A joint model did not reflect the selected shared priority. The shared charging event retains the proposed and adopted assessments.'],
  'shared-allocation-inconsistent': ['Shared allocation evidence inconsistent', 'A joint allocation or reported cost bound did not agree with its recorded inputs. This checks the model, not physical delivery.'],
  'shared-current-mismatch': ['Shared current limit not respected', 'Fresh Charger 2 current readback exceeded its active current ceiling after settling. Review the recorded shared context and charger evidence.'],
  'charging-during-hold': ['Charging during a planned pause', 'The charger continued drawing power after the pause settling period. Check the recorded plan and charger confirmation.'],
  'control-unconfirmed': ['Control remained unconfirmed', 'A command, readback or charger error remained unresolved beyond the settling period. An acknowledgement alone does not prove a physical response.'],
  'telemetry-unavailable': ['Physical evidence unavailable', 'Fresh charger readings were missing. Charging and stopping could not be assessed during this interval.'],
  'permitted-without-draw': ['Charging allowed, no draw observed', 'Charging permission was confirmed but the vehicle did not draw power for ten minutes. A vehicle timer, limit or another restriction is possible; its cause is unconfirmed.'],
  'vehicle-timer': ['Known vehicle start time', 'The reported vehicle start was still in the future while charger permission was open.'],
  'supply-unavailable': ['No reported supply allowance', 'The charger reported zero available current. This is separate from an economic pause.'],
  'manual-priority': ['Manual instruction has priority', 'The automatic plan was suspended while a manual charger instruction had priority.'],
  'target-conflict': ['Vehicle target readings disagree', 'The production target filter retained a stable target while conflicting vehicle readings were observed.'],
  'identification-inconclusive': ['Identification inconclusive', 'The identification attempt ended without a confirmed vehicle. Ordinary charging continued with the available inputs.'],
  'identity-unavailable': ['Vehicle identity no longer confirmed', 'The current connection lost its confirmed assignment. Previous readings do not establish a new match.'],
  'deadline-unverified': ['Ready-by outcome unconfirmed', 'The deadline passed without an applicable vehicle reading proving whether the requested target had been reached.'],
  'deadline-missed': ['Target missed at ready-by', 'An applicable vehicle reading after ready-by was below the requested target. Reaching the target later does not remove this event.'] };
export const chargingFinding = code => typeof code === 'string' && Object.hasOwn(FINDINGS, code) ? FINDINGS[code] : undefined;

export function chargingFindingLabel(row) {
  const name = chargingFinding(row.code)?.[0] ?? 'Finding';
  if (row.kind === 'finding-update') return `${name} · Evidence changed`;
  if (row.kind === 'finding') return chargingFinding(row.code)?.[0] ?? 'Finding recorded';
  if (row.kind === 'recovery') return `${name} · ${row.resolution === 'request-changed' ? 'request changed'
    : row.resolution === 'evidence-reconciled' ? 'evidence reconciled' : 'finding ended'}`;
  return null;
}

export function chargingPhysicalLabel(row) {
  if (row.kind !== 'physical' || !['charging-started', 'charging-observed', 'charging-stopped', 'not-charging-observed'].includes(row.code)) return null;
  if (!Number.isFinite(row.powerKw) || row.powerKw < 0) return 'Measured draw unavailable';
  const drawing = row.powerKw > .1, claimsDraw = ['charging-started', 'charging-observed'].includes(row.code);
  if (drawing !== claimsDraw) return 'Recorded charging label disagrees with measured draw';
  return drawing ? row.code === 'charging-started' ? 'Draw rose above 0.1 kW' : 'Draw above 0.1 kW observed'
    : row.powerKw === 0 ? 'No draw measured' : 'Draw at 0.1 kW or below observed';
}
