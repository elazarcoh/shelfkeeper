// Element ids the book page's parts share. Kept out of the component files: a .tsx that exports anything but
// components loses React Fast Refresh (a full reload on every edit).

/** The book's title (focusable): where focus lands after "Split into new book". */
export const WORK_TITLE_ID = 'work-title'

/** The Editions heading: where focus lands when the last edition goes. */
export const EDITIONS_HEADING_ID = 'editions-heading'
