export const WELCOME_TOUR_ID = 'welcome';
export const START_TOUR_EVENT = 'aihr:start-tour';

let pendingTourId: string | null = null;

/** Retain the latest launch if the overlay has yet to attach to the signed-in shell. */
export function requestTour(tourId = WELCOME_TOUR_ID) {
  pendingTourId = tourId;
  window.dispatchEvent(new CustomEvent(START_TOUR_EVENT, { detail: { tourId } }));
}

export function takePendingTour(): string | null {
  const tourId = pendingTourId;
  pendingTourId = null;
  return tourId;
}
