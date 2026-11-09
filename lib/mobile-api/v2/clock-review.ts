import { z } from 'zod';
import { ClockCommand } from '../contract';

/** Native advisory punches can carry a complete fix or no fix at all. */
export const ClockReviewCommand = ClockCommand.pick({ action: true, requestId: true, deviceToken: true }).extend({
  location: ClockCommand.pick({ lat: true, lng: true, accuracy: true, sampledAt: true }).nullable(),
}).strict();
