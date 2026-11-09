/** The fixed initial sharing transport. The standalone readers own every other read. */
export const DEFAULT_HOME_SHARING_CARDS = ['team', 'celebrations'] as const;
export const HOME_SHARING_CARDS = [...DEFAULT_HOME_SHARING_CARDS, 'notices', 'timeOff', 'greeting', 'summary', 'tasks', 'today', 'calendar'] as const;
export type HomeSharingCard = typeof HOME_SHARING_CARDS[number];
export const isHomeSharingCard=(value:unknown):value is HomeSharingCard=>HOME_SHARING_CARDS.some(card=>card===value);
export const HOME_SHARING_STREAM = 'application/x-ndjson';
export const HOME_SHARING_MAX_FRAME_BYTES = 128 * 1024;

export type HomeSharingFrame =
  | { version: 1; card: HomeSharingCard; status: 200; value: unknown }
  | { version: 1; card: HomeSharingCard; status: 400 | 401 | 403 | 503 };
