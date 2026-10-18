import './render';
import type { Command, LayoutRule, Placement, Store } from '../../core';
import { cardsIn, registerCapacityRule } from '../cards/deck';
import type { PluginLogic } from '../logic';
import { commands, formationCapacity } from './commands';
import { repairImport, shapeExport } from './io';
import { ENV_CARD, ENV_H, ENV_PAD, ENV_STEP, ENV_W, isPart } from './model';

// a formation has 3 slots, 4 while Mud lies on its flag (global, like the packs)
registerCapacityRule(formationCapacity);

/** Cards on a flag's environment spot lie sideways, smaller, across the flag's pole. */
export const envLayout: LayoutRule = (doc) => {
  const out = new Map<string, Placement>();
  for (const e of doc.nodes) {
    if (!isPart(e, 'environment')) continue;
    out.set(e.id, { width: ENV_W, height: ENV_H });
    cardsIn(doc, e.id).forEach((c, k) => {
      const cx = e.x + ENV_PAD + k * ENV_STEP.x + ENV_CARD.h / 2;
      const cy = e.y + ENV_PAD + k * ENV_STEP.y + ENV_CARD.w / 2;
      // boxes turn around their bottom middle (core.css): a quarter turn puts the box's center at
      // (w/2 + h/2, h) from its top-left
      out.set(c.id, { x: Math.round(cx - ENV_CARD.w / 2 - ENV_CARD.h / 2), y: Math.round(cy - ENV_CARD.h), width: ENV_CARD.w, height: ENV_CARD.h, angle: 90, z: (e.z ?? 0) + (k + 1) / 1000 });
    });
  }
  return out;
};

/** The data side of the plugin (commands, reset, import/export). No DOM; used by tests too. */
export function registerBattleLineLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`battleline.${name}`, cmd as Command);
  store.resets.push(commands.resetAll as Command);
  store.importFilters.push(repairImport);
  store.exportFilters.push(shapeExport);
  store.migrations.push(commands.migrate as Command);
  store.addLayout(envLayout);
}

export const logic: PluginLogic = { id: 'battleline', register: registerBattleLineLogic };
