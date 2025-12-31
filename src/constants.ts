/**
 * Application-wide constants.
 * Centralizes magic numbers for better maintainability.
 */

// =============================================================================
// Display Constants
// =============================================================================

/** Width for separator lines and progress line clearing */
export const SEPARATOR_LENGTH = 60;

// =============================================================================
// Timing Constants
// =============================================================================

/** Interval for logging subcollection/progress updates during scanning (ms) */
export const PROGRESS_LOG_INTERVAL_MS = 2000;

/** Interval for updating speed display in progress bar (ms) */
export const SPEED_UPDATE_INTERVAL_MS = 500;

/** Interval for flushing batched progress bar increments (ms) */
export const PROGRESS_FLUSH_INTERVAL_MS = 50;

/** Default interval for auto-saving transfer state (ms) */
export const STATE_SAVE_INTERVAL_MS = 5000;

/** Default number of batches between state saves */
export const STATE_SAVE_BATCH_INTERVAL = 10;
