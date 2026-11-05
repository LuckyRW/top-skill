/** Add-on entry point: oss!idle imports this module and calls `mount` / `unmount`. */
import { defineAddon } from '@oss-idle/addon-sdk';
import { TopSkillAddon } from './TopSkillAddon.js';

export const { mount, unmount } = defineAddon(() => new TopSkillAddon());
