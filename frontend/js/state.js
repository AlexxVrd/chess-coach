import { api } from './api.js';

export const state = { settings: {}, status: null };

export async function loadSettings() {
  state.settings = await api.settings();
  return state.settings;
}
