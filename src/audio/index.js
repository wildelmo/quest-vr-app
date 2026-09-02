// Audio subsystems. The integrator calls registerAudio(ctx) from main.js once ctx.audio exists;
// the engine starts them after the AudioContext is unlocked (api.start()).
import { ambience } from './ambience.js';
import { music } from './music.js';
import { sfx } from './sfx.js';

export { ambience, music, sfx };

export function registerAudio(ctx) {
  if (!ctx?.audio?.add) throw new Error('registerAudio: ctx.audio is not an audio engine');
  ctx.audio.add(ambience);
  ctx.audio.add(music);   // sets ctx.music on start()
  ctx.audio.add(sfx);     // bells, followers, transients; music's raindrops use its bell pool
  return { ambience, music, sfx };
}
