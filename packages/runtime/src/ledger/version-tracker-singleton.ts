/**
 * Entity Version Tracker Singleton
 * 
 * Provides a shared instance of EntityVersionTracker for use throughout the app.
 * This ensures consistent version tracking between sync, rebuild, and handlers.
 */

import { db } from '../db/index.js';
import { EntityVersionTracker } from './version-tracker.js';

/** Shared version tracker instance */
export const versionTracker = new EntityVersionTracker(db);
