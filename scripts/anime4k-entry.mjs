import { ImageUpscaler } from 'anime4k.js/upscaler';
import {
  Anime4K_Clamp_Highlights, Anime4K_Restore_CNN_S, Anime4K_Restore_CNN_M, Anime4K_Restore_CNN_VL,
  Anime4K_Restore_CNN_Soft_S, Anime4K_Restore_CNN_Soft_M, Anime4K_Upscale_CNN_x2_S, Anime4K_Upscale_CNN_x2_M,
  Anime4K_Upscale_CNN_x2_VL, Anime4K_Upscale_Denoise_CNN_x2_M
} from 'anime4k.js/shaders';

// A/B/C restoration choices, with one 2x upscale pass instead of the desktop 4x chains. A+A, B+B and C+A restore a
// second time after the upscale (where the desktop chains restore before their second upscale); HQ is mode A with
// the VL networks.
const profiles = {
  light: [Anime4K_Clamp_Highlights, Anime4K_Restore_CNN_S, Anime4K_Upscale_CNN_x2_S],
  a: [Anime4K_Clamp_Highlights, Anime4K_Restore_CNN_M, Anime4K_Upscale_CNN_x2_M],
  b: [Anime4K_Clamp_Highlights, Anime4K_Restore_CNN_Soft_M, Anime4K_Upscale_CNN_x2_M],
  c: [Anime4K_Clamp_Highlights, Anime4K_Upscale_Denoise_CNN_x2_M],
  aa: [Anime4K_Clamp_Highlights, Anime4K_Restore_CNN_M, Anime4K_Upscale_CNN_x2_M, Anime4K_Restore_CNN_Soft_S],
  bb: [Anime4K_Clamp_Highlights, Anime4K_Restore_CNN_Soft_M, Anime4K_Upscale_CNN_x2_M, Anime4K_Restore_CNN_Soft_S],
  ca: [Anime4K_Clamp_Highlights, Anime4K_Upscale_Denoise_CNN_x2_M, Anime4K_Restore_CNN_S],
  hq: [Anime4K_Clamp_Highlights, Anime4K_Restore_CNN_VL, Anime4K_Upscale_CNN_x2_VL]
};
export { ImageUpscaler, profiles };
