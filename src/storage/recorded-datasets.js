import { recordingPolicy } from '../domain/recording-policy.js';

export const isRecordedDataset = observation => recordingPolicy(observation).recorded;
