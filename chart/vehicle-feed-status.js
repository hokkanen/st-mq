const admissionStates = Object.freeze({
  'vehicle-observation-storage-pending': Object.freeze({
    label: 'Saving vehicle report', state: 'pending', cause: 'waiting to save a vehicle report',
    detail: 'A vehicle report is waiting to be saved. Vehicle readings are unavailable; last known values keep their original times.',
  }),
  'vehicle-observation-admission-failed': Object.freeze({
    label: 'Vehicle report not accepted', state: 'attention', cause: 'the vehicle report could not be accepted',
    detail: 'The vehicle report could not be accepted. Vehicle readings are unavailable; last known values keep their original times.',
  }),
});

export const vehicleObservationAdmissionStatus = reason => Object.hasOwn(admissionStates, reason) ? admissionStates[reason] : null;
