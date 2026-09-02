// Audio subsystems. The integrator calls registerAudio(ctx) from main.js once ctx.audio exists;
// the engine starts them after the AudioContext is unlocked (api.start()).
import { ambience } from './ambience.js';
import { music } from './music.js';
import { sfx } from './sfx.js';

export { ambience, music, sfx };

// The samples the subsystems actually play. Only these are fetched and decoded (assets.js filters the
// manifest by this set); the rest of assets/audio stays on disk for future use.
export const AUDIO_USED = new Set([
  'wind_loop', 'water_loop_1',
  'pad_bioluminescence', 'pad_northern_swell', 'pad_northern_brilliant',
  'bowl_1', 'bowl_2', 'bowl_3', 'bowl_4', 'bowl_5', 'bowl_6', 'bowl_7',
  'ting_1', 'ting_2', 'ting_3', 'ting_4',
  'splash_soft_1', 'splash_soft_2', 'splash_soft_3', 'splash_soft_4',
  'plop_airy_1', 'whoosh_gentle', 'gong_1',
]);

export function registerAudio(ctx) {
  if (!ctx?.audio?.add) throw new Error('registerAudio: ctx.audio is not an audio engine');
  ctx.audio.add(ambience);
  ctx.audio.add(music);   // sets ctx.music on start()
  ctx.audio.add(sfx);     // bells, followers, transients; music's raindrops use its bell pool
  return { ambience, music, sfx };
}
