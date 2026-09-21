import test from 'node:test';
import { learningCatchup, energyCatchup } from '../helpers/recovery-fixture.js';

test('a missing week feeds chronological learning, catches up live records, and retains the original journal',
  t => learningCatchup(t, 7 * 96));

test('a week of phase energy is imported in bounded batches while the master continues recording',
  t => energyCatchup(t, 7 * 24 * 12));
