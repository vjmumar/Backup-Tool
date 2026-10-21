/**
 * api/auth.js — Auth API
 *
 * All functions talk to BASE_URL/api/auth.
 * Called by the auth-* message handlers in background.js.
 *
 * Every function resolves (never rejects) with:
 *   { ok: true,  ...payload }  — HTTP 2xx
 *   { ok: false, error: "" }   — HTTP error or network failure
 */

import { BASE_URL, apiFetch } from "./config.js";

const AUTH = `${BASE_URL}/api/auth`;
const PLATFORM = "kajabi";

// ─── FORGOT PASSWORD ──────────────────────────────────────────────────────────

export const forgotPassword = ({ email }) =>
   apiFetch(`${AUTH}/forgot-password`, {
      method: "POST",
      body: { email, platform: PLATFORM },
   });

// ─── SIGN IN ──────────────────────────────────────────────────────────────────

export const signIn = ({ email, password }) =>
   apiFetch(`${AUTH}/sign-in`, {
      method: "POST",
      body: { email, password, platform: PLATFORM },
   });

// ─── CHANGE PASSWORD ──────────────────────────────────────────────────────────

/**
 * Changes the current user's password and clears the freshSignIn flag.
 * Requires a valid JWT in storage.
 *
 * @param {string} currentPassword
 * @param {string} newPassword
 * @returns {{ ok: boolean, error?: string }}
 */
export const changePassword = ({ currentPassword, newPassword }) =>
   apiFetch(`${AUTH}/change-password`, {
      method: "POST",
      auth: true,
      body: { currentPassword, newPassword },
   });

// ─── GET ME ───────────────────────────────────────────────────────────────────

/**
 * Returns the current user's profile.
 * Called on every popup open to get the latest freshSignIn state.
 *
 * @returns {{ ok: boolean, id?: string, email?: string, freshSignIn?: boolean, error?: string }}
 */
export const getMe = () =>
   apiFetch(`${AUTH}/me`, {
      method: "GET",
      auth: true,
   });

// ─── UPDATE EMAIL ─────────────────────────────────────────────────────────────

/**
 * Updates the current user's email address.
 *
 * @param {string} email
 * @returns {{ ok: boolean, error?: string }}
 */
export const updateEmail = ({ email }) =>
   apiFetch(`${AUTH}/me`, {
      method: "PATCH",
      auth: true,
      body: { email },
   });

// ─── DELETE ACCOUNT ───────────────────────────────────────────────────────────

/**
 * Permanently deletes the current user's account.
 * The background handler clears the stored token on success.
 *
 * @returns {{ ok: boolean, error?: string }}
 */
export const deleteAccount = () =>
   apiFetch(`${AUTH}/me`, {
      method: "DELETE",
      auth: true,
   });
