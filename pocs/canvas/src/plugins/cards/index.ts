import './cards.css';
import type { App, CanvasNode, Command, Plugin } from '../../core';
import { commands } from './commands';
import { cardField, cardsOf, isCard, isStack, type CardField } from './deck';
import { cardHtml, stackHtml } from './render';

const isCardish = (n: CanvasNode) => isCard(n) || isStack(n);
const selectedCards = (app: App) => app.selected().filter(isCardish);
const ids = (ns: CanvasNode[]) => ns.map((n) => n.id);

function gatherSelection(app: App) {
  const sel = selectedCards(app);
  if (sel.length > 1) app.dispatch('cards.gather', { ids: ids(sel) });
}
function drawFromSelection(app: App, faceUp: boolean) {
  const stack = selectedCards(app).filter(isStack).at(-1);
  if (!stack) return;
  app.dispatch('cards.draw', { id: stack.id, faceUp });
  // keep the deck selected so D can be pressed repeatedly to deal
  if (app.node(stack.id) && isStack(app.node(stack.id)!)) app.store.select([stack.id]);
}

export const cardsPlugin: Plugin = {
  id: 'cards',
  setup(app) {
    for (const [name, cmd] of Object.entries(commands)) app.registerCommand(`cards.${name}`, cmd as Command);

    app.registerType({
      id: 'card',
      match: isCard,
      render(node, el) {
        el.innerHTML = cardHtml(cardField(node) as CardField);
      },
      onDoubleClick: (node, app) => app.dispatch('cards.flip', { ids: [node.id] }),
      onDrop: (target, dropped, app) => {
        const cards = dropped.filter((id) => {
          const n = app.node(id);
          return n && isCardish(n);
        });
        if (cards.length) app.dispatch('cards.gather', { ids: [target.id, ...cards] });
      },
    });

    app.registerType({
      id: 'stack',
      match: isStack,
      render(node, el) {
        el.innerHTML = stackHtml(cardsOf(node));
      },
      onDoubleClick: (node, app) => app.dispatch('cards.flip', { ids: [node.id] }),
      // Alt/Option + drag pulls the top card off instead of moving the deck.
      onPointerDown(node, e, app) {
        if (!e.altKey) return;
        const res = app.dispatch('cards.draw', { id: node.id, x: node.x, y: node.y });
        return res.select?.[0];
      },
      onDrop: (target, dropped, app) => {
        const cards = dropped.filter((id) => {
          const n = app.node(id);
          return n && isCardish(n);
        });
        if (cards.length) app.dispatch('cards.gather', { ids: [target.id, ...cards] });
      },
    });

    const flipSel = (app: App) => app.dispatch('cards.flip', { ids: ids(selectedCards(app)) });
    const shuffleSel = (app: App) => app.dispatch('cards.shuffle', { ids: ids(selectedCards(app).filter(isStack)) });
    const spreadSel = (app: App) => {
      const s = selectedCards(app).filter(isStack).at(-1);
      if (s) app.dispatch('cards.spread', { id: s.id });
    };

    app.registerKey({ key: 'f', label: 'Flip', run: flipSel });
    app.registerKey({ key: 's', label: 'Shuffle', run: shuffleSel });
    app.registerKey({ key: 'd', label: 'Draw face up', run: (a) => drawFromSelection(a, true) });
    app.registerKey({ key: 'shift+d', label: 'Draw face down', run: (a) => drawFromSelection(a, false) });
    app.registerKey({ key: 'g', label: 'Gather into a stack', run: gatherSelection });
    app.registerKey({ key: 'e', label: 'Spread stack', run: spreadSel });

    const any = (_: App, sel: CanvasNode[]) => sel.some(isCardish);
    const hasStack = (_: App, sel: CanvasNode[]) => sel.some(isStack);
    app.registerMenuItem({ label: 'Flip', hint: 'F', when: any, run: flipSel });
    app.registerMenuItem({ label: 'Shuffle', hint: 'S', when: hasStack, run: shuffleSel });
    app.registerMenuItem({ label: 'Draw face up', hint: 'D', when: hasStack, run: (a) => drawFromSelection(a, true) });
    app.registerMenuItem({ label: 'Draw face down', hint: '⇧D', when: hasStack, run: (a) => drawFromSelection(a, false) });
    app.registerMenuItem({ label: 'Spread out', hint: 'E', when: hasStack, run: spreadSel });
    app.registerMenuItem({
      label: 'Gather into stack',
      hint: 'G',
      when: (_, sel) => sel.filter(isCardish).length > 1,
      run: gatherSelection,
    });
    app.registerMenuItem({
      label: 'Gather face down',
      when: (_, sel) => sel.filter(isCardish).length > 1,
      run: (a) => a.dispatch('cards.gather', { ids: ids(selectedCards(a)), faceUp: false }),
    });
  },
};

export { commands } from './commands';
