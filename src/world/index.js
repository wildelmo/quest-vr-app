// Module registry. Order matters: the wave simulation runs first (everything reads its texture),
// water and sky next, then the things that live in the world, then hints and audio glue.
import { wavesim } from './wavesim.js';
import { water } from './water.js';
import { sky } from './sky.js';
import { aurora } from './aurora.js';
import { plankton } from './plankton.js';
import { drips } from './drips.js';
import { hints } from './hints.js';
import { shore } from './shore.js';
import { mist } from './mist.js';
import { lotus } from './lotus.js';
import { lanterns } from './lanterns.js';
import { fireflies } from './fireflies.js';
import { leave } from './leave.js';

export const WORLD_MODULES = [wavesim, water, sky, aurora, plankton, drips, shore, mist, lotus, lanterns, fireflies, leave, hints];
